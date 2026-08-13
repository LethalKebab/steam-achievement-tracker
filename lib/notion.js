/**
 * Notion API 客户端
 * ------------------------------------------------
 * token 从 config.json 的 notion.token(或环境变量 NOTION_TOKEN)读,不写进源码。
 * 相关页面(或它们共同的父页面)需要加到这个 integration 的 connections 里,
 * 否则 API 会返回 404/无权限:Notion 页面右上角 ••• → Connections → Add connection。
 */
import { sleep } from './steam.js';
import { chunkBlocks } from './notionblocks.js';

const NOTION_VERSION = '2022-06-28';

/**
 * 自动建攻略库时给的状态选项。**这四个正好是程序会写的全部值** ——
 * `newGuideStatus` 写前三档(`Not started` / `In progress` / `Done`),
 * `syncGuideStatuses` 写 `Done` / `Staged`。`planNotionTarget` 校验的是
 * "这次真要写的那个值",所以四个齐了就证明程序永远不会写出选项之外的东西。
 *
 * 顺序照 Notion 自己的工作流排(未开始 → 进行中 → 回退 → 完成),因为
 * **`Not started` / `In progress` / `Done` 就是 Notion status 属性的自带默认**
 * (建一个不指定 options 的 status 属性,回来的就是这三个 —— 实测确认)。
 * 于是手工建库的人只需要补一个 `Staged`。
 *
 * 多出来的选项无害:校验只问"要写的这个在不在里面",不管里面还有什么。
 * 想要 `Paused` / `Differed` 之类的自己在 Notion 里加,程序永远不会覆盖它们。
 */
export const GUIDE_STATUS_OPTIONS = ['Not started', 'In progress', 'Staged', 'Done'];

export class NotionClient {
  constructor(cfg) {
    this.token = cfg.notion?.token ?? '';
    this.overviewDbId = cfg.notion?.overviewDbId ?? '';
  }

  get configured() {
    return Boolean(this.token);
  }

  async request(method, path, payload, { retriedOn429 = false } = {}) {
    if (!this.token) {
      throw new Error('NOTION_TOKEN 未设置(config.json 的 notion.token 或环境变量 NOTION_TOKEN)');
    }
    const res = await fetch('https://api.notion.com/v1' + path, {
      method: method.toUpperCase(),
      headers: {
        Authorization: 'Bearer ' + this.token,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: payload ? JSON.stringify(payload) : undefined,
      // 带超时:一次 dry-run 要读几十个页面上百次请求,某一次卡住不能让整个流程无限等
      signal: AbortSignal.timeout(30_000),
    });

    if (res.status === 429 && !retriedOn429) {
      await sleep(1000);
      return this.request(method, path, payload, { retriedOn429: true });
    }

    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Notion API 返回内容不是 JSON(HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    if (res.status >= 400) {
      throw new Error(`Notion API 错误 ${res.status}: ${body.message || text}`);
    }
    return body;
  }

  /**
   * 递归拉一个 block 下所有 to_do 子 block(含嵌在 toggle/column 等容器里的)。
   * 子页面只在标题像成就清单时才递归进去(有些游戏把 checklist 放在"成就"子页面里);
   * child_database / link_to_page 直接跳过——那种要改数据库属性,不是改 block,
   * 是完全不同的同步逻辑。
   */
  async fetchAllToDoBlocks(blockId, results = [], parent = null) {
    let cursor = null;
    do {
      const qs = '?page_size=100' + (cursor ? `&start_cursor=${cursor}` : '');
      const data = await this.request('get', `/blocks/${blockId}/children${qs}`);
      for (const block of data.results ?? []) {
        if (block.type === 'to_do') {
          results.push({
            key: block.id,
            text: richTextToPlain(block.to_do.rich_text),
            checked: Boolean(block.to_do.checked),
            parent,
          });
          // 必须继续往 to_do 里面钻。以前这里直接 continue,嵌在成就下面的子步骤
          // checkbox 全都看不见——而本地 markdown 后端的正则是 /^\s*[-*]\s*\[/,
          // 缩进行本来就会被读进来。同一份攻略换个后端行为就不一样,是 bug 不是设计。
          if (block.has_children) await this.fetchAllToDoBlocks(block.id, results, block.id);
          continue;
        }
        if (block.type === 'child_page') {
          if (/成就|achievement/i.test(block.child_page.title ?? '')) {
            await this.fetchAllToDoBlocks(block.id, results, parent);
          }
          continue;
        }
        if (block.has_children && !['child_database', 'link_to_page'].includes(block.type)) {
          // 容器(toggle / column 等)不改变归属:套在成就 to_do 里的 toggle,
          // 里面的 checkbox 仍然是那个成就的子步骤,所以 parent 原样往下传
          await this.fetchAllToDoBlocks(block.id, results, parent);
        }
      }
      cursor = data.has_more ? data.next_cursor : null;
    } while (cursor);
    return results;
  }

  /**
   * 一个页面下的**全部** block,原样的 JSON,子块内联在 `children` 里。
   *
   * 和 `fetchAllToDoBlocks` 是两件事,别合并:那个只挑 checkbox、而且把每个块压成
   * `{key,text,checked,parent}` 的小形状,同步够用了,**但压扁之后就还原不回去**。
   * 这里是给覆盖前的备份用的,要求正好相反 —— 一个字段都不能丢,因为它是覆盖之后
   * 唯一能拿回原文的东西。
   */
  async fetchAllBlocks(blockId) {
    const out = [];
    let cursor = null;
    do {
      const qs = '?page_size=100' + (cursor ? `&start_cursor=${cursor}` : '');
      const data = await this.request('get', `/blocks/${blockId}/children${qs}`);
      for (const block of data.results ?? []) {
        // child_database / link_to_page 的"子块"不是这一页的内容,是另一个实体,
        // 钻进去既备份不了也删不掉
        const recurse = block.has_children && !['child_database', 'link_to_page'].includes(block.type);
        out.push(recurse ? { ...block, children: await this.fetchAllBlocks(block.id) } : block);
      }
      cursor = data.has_more ? data.next_cursor : null;
    } while (cursor);
    return out;
  }

  /**
   * 删一个 block。Notion 这个接口是**归档**(`archived: true`),不是物理删除 ——
   * 页面上看不见了,但 30 天内还能在 Notion 的回收站里找回来。这是覆盖流程
   * 除本地备份之外的第二张网,值得知道
   */
  async deleteBlock(blockId) {
    return this.request('delete', `/blocks/${blockId}`);
  }

  async checkTodo(blockId) {
    return this.setTodoChecked(blockId, true);
  }

  /**
   * 日常同步只会**勾上**(checked: true),从不取消勾选——所以它没法自我修复
   * 历史上勾错的框。取消勾选是人工修正的动作,走同一个接口但要显式传 false,
   * 免得"勾"和"取消勾"各写一份 patch 逻辑。
   */
  async setTodoChecked(blockId, checked) {
    return this.request('patch', `/blocks/${blockId}`, { to_do: { checked: Boolean(checked) } });
  }

  /**
   * 攻略数据库里那个"进度"属性的定义。**类型必须读出来,不能猜**:
   * Notion 的 `status` 和 `select` 是两种属性,写入时的 payload 形状不一样
   * (`{status:{name}}` vs `{select:{name}}`),写错的那个会被 API 直接拒掉。
   * 优先取 status 类型,没有再退而取 select;两种都没有就返回 null,由调用方报错。
   */
  /** 一次请求把建页要用的属性名都读出来。别拆成两次读同一个 schema */
  async fetchGuideDbSchema(dbId = this.overviewDbId) {
    const db = await this.request('get', `/databases/${dbId}`);
    return pickGuideDbProperties(db.properties);
  }

  async fetchGuideStatusSchema(dbId = this.overviewDbId) {
    return (await this.fetchGuideDbSchema(dbId)).status;
  }

  /** 改一个页面的状态属性。property/type 来自 fetchGuideStatusSchema,别写死 */
  async setPageStatus(pageId, { property, type, value }) {
    return this.request('patch', `/pages/${pageId}`, {
      properties: { [property]: { [type]: { name: value } } },
    });
  }

  /** 给已经存在的页面设图标。建页时的图标走 createGuidePage,两边用同一个载荷形状 */
  async setPageIcon(pageId, url) {
    return this.request('patch', `/pages/${pageId}`, { icon: externalIcon(url) });
  }

  /**
   * 一个页面**当前**的图标(没有就是 null)。
   *
   * `fillMissingIcon` 的规矩是"只补空着的那一格",所以调用方必须知道那一格现在有没有东西。
   * 从数据库查询里顺出来是免费的,但覆盖走的是"我已经知道是哪一页"的路,没有那次查询 ——
   * 与其猜一个 `icon: null` 传进去(那等于每次都覆盖用户挑的图标),不如老实读一次
   */
  async fetchPageIcon(pageId) {
    const page = await this.request('get', `/pages/${pageId}`);
    return page.icon ?? null;
  }

  /** 查攻略数据库拿全部页面 [{id, title, url, status}],自动翻页 */
  async queryGuideDatabase(dbId = this.overviewDbId) {
    if (!dbId) {
      throw new Error(
        '没有配置攻略数据库 ID。在 config.json 里填 notion.overviewDbId ' +
          '(打开那个数据库,URL 里 32 位十六进制那段就是)'
      );
    }
    const results = [];
    let cursor = null;
    do {
      const payload = { page_size: 100 };
      if (cursor) payload.start_cursor = cursor;
      const data = await this.request('post', `/databases/${dbId}/query`, payload);
      for (const page of data.results ?? []) {
        const props = Object.values(page.properties ?? {});
        const titleProp = props.find((p) => p?.type === 'title');
        // 状态属性顺带读出来。以前这里把 properties 整个丢掉了,导致"这一页现在是什么状态"
        // 得另外一页一页去查;留着它,收敛式的状态同步就是零额外请求
        const statusProp = props.find((p) => p?.type === 'status' || p?.type === 'select');
        results.push({
          id: page.id,
          title: richTextToPlain(titleProp?.title),
          url: page.url,
          status: statusProp ? (statusProp[statusProp.type]?.name ?? null) : null,
          // 图标顺带读出来。查询响应里本来就带着它,不读白不读 —— 而"这一页有没有图标"
          // 是 fillMissingIcon 唯一的判断依据,另开一次读只是为了拿一个已经在手里的字段
          icon: page.icon ?? null,
        });
      }
      cursor = data.has_more ? data.next_cursor : null;
    } while (cursor);
    return results;
  }

  /**
   * 建一个攻略页。**只建空页,正文另外分批追加** —— Notion 的 create page 一次最多
   * 带 100 个 children,而攻略动辄上百个块;把"建页"和"填正文"分开,分批逻辑就只有
   * 一份(`appendBlocks`),不用在两个地方各写一遍上限判断。
   *
   * `icon` 是 Steam 的游戏图标 URL,可空 —— 图标是好看,不是功能,拿不到不该挡住建页。
   */
  async createGuidePage({
    dbId = this.overviewDbId,
    titleProperty = 'Name',
    title,
    icon = null,
    status = null,
  }) {
    const properties = { [titleProperty]: { title: [{ text: { content: title } }] } };
    // status 和 setPageStatus 收的是同一个形状 {property, type, value},别在这里另发明一个
    if (status) properties[status.property] = { [status.type]: { name: status.value } };
    return this.request('post', '/pages', {
      parent: { database_id: dbId },
      properties,
      ...(icon ? { icon: externalIcon(icon) } : {}),
    });
  }

  /**
   * 这个 integration 能看到的、**能当父页面用的**页面。
   *
   * `/search` 返回的"页面"里绝大多数是数据库的行(攻略库里每篇攻略都是一个 page,
   * `parent.type === 'database_id'`)。真机上 100 条里 99 条是这种 —— 全列出来的话
   * 选父页面的下拉框会被自己的攻略淹掉。所以这里只留 `parent.type` 不是
   * `database_id` 的,也就是真正意义上的页面。
   *
   * `truncated` 要如实交出去:一个大 workspace 翻不完,而"列表里没有"和
   * "列表被截断了"对用户来说是两个完全不同的处境。
   */
  async searchPages({ maxPages = 5 } = {}) {
    const results = [];
    let cursor = null;
    let truncated = false;
    for (let i = 0; i < maxPages; i++) {
      const payload = { filter: { value: 'page', property: 'object' }, page_size: 100 };
      if (cursor) payload.start_cursor = cursor;
      const data = await this.request('post', '/search', payload);
      for (const page of data.results ?? []) {
        if (page.parent?.type === 'database_id') continue;
        const titleProp = Object.values(page.properties ?? {}).find((p) => p?.type === 'title');
        results.push({
          id: page.id,
          title: richTextToPlain(titleProp?.title) || '(无标题)',
          url: page.url,
          parentType: page.parent?.type ?? 'unknown',
        });
      }
      cursor = data.has_more ? data.next_cursor : null;
      if (!cursor) break;
      if (i === maxPages - 1) truncated = true;
    }
    return { pages: results, truncated };
  }

  /**
   * 在某个页面下建一个这个项目认得的攻略库。
   *
   * ## 建完必须回读
   *
   * 这条路上"调用成功 ≠ 内容正确"不是空话,是实测出来的:**status 属性的分组
   * (`groups`)无论建的时候传还是事后 PATCH,Notion 一律 HTTP 200 然后原样不动。**
   * 三种 payload 形状全试过,全是静默无效。所以四个选项到底有没有落地,只能读回来问
   * `pickGuideDbProperties` —— 而且要问它,不是自己解析,因为它才是下游真正的消费者。
   *
   * 分组这件事的结论是:建出来的库四个选项全落在 `To-do` 组里,功能零影响
   * (代码只读 `options`,从不看 `groups`),只有 board 视图看着怪,想整理得手动拖。
   */
  async createGuideDatabase({ parentPageId, title = 'Steam 攻略' }) {
    if (!parentPageId) throw new Error('建攻略库要指定父页面');
    const created = await this.request('post', '/databases', {
      parent: { type: 'page_id', page_id: parentPageId },
      title: [{ type: 'text', text: { content: title } }],
      properties: {
        Name: { title: {} },
        Status: { status: { options: GUIDE_STATUS_OPTIONS.map((name) => ({ name })) } },
      },
    });

    // 回读,用真正的挑选逻辑验,不自己解析
    const fresh = await this.request('get', `/databases/${created.id}`);
    const picked = pickGuideDbProperties(fresh.properties);
    // 两种失败分开报:**修法不一样**。整个属性没建出来要去加一个属性,
    // 选项少几个只要在已有属性上补选项。合成一句话的版本还会让"属性都没有"
    // 显示成"缺了全部四个选项",听起来像是选项写错了
    if (!picked.status) {
      throw new Error(
        `库建出来了(${created.url})但里面没有状态属性 —— Notion 把传过去的 Status 吞了。` +
          `去那个库上手动加一个 Status 属性(选项:${GUIDE_STATUS_OPTIONS.join(' / ')}),或者删掉这个库重来。`
      );
    }
    const got = picked.status.options;
    const missing = GUIDE_STATUS_OPTIONS.filter((o) => !got.includes(o));
    if (missing.length) {
      throw new Error(
        `库建出来了(${created.url})但状态选项没落全,缺:${missing.join(' / ')}。` +
          `现有:${got.join(' / ') || '无'}。去 Notion 里把缺的补上,或者删掉这个库重来。`
      );
    }
    return {
      // 去掉连字符再存。Notion 两种写法都收,但手工填的人照文档抄的是 URL 里那 32 位,
      // 让 config.json 里只有一种形状,肉眼比对和搜索才不用管大小写和连字符
      id: normalizeNotionId(created.id) ?? created.id,
      url: created.url,
      title,
      titleProperty: picked.titleProperty,
      statusProperty: picked.status.property,
      options: got,
    };
  }

  /**
   * 往页面尾部追加 block,自动按 Notion 的 100 个上限分批。
   *
   * **失败时把已经写进去多少块一起抛出来**。中途断了页面就是半篇攻略,而"页面上有东西"
   * 会让人以为写成功了 —— 这个项目栽过"调用成功≠内容正确"的跟头,半成品必须说出口。
   */
  async appendBlocks(pageId, blocks) {
    let written = 0;
    for (const chunk of chunkBlocks(blocks)) {
      try {
        await this.request('patch', `/blocks/${pageId}/children`, { children: chunk });
      } catch (err) {
        const e = new Error(
          `正文只写进去 ${written}/${blocks.length} 块就失败了,页面现在是半篇攻略:${err.message}`
        );
        e.written = written;
        throw e;
      }
      written += chunk.length;
      if (written < blocks.length) await sleep(350);
    }
    return written;
  }

  /** 页面下有几个一级 block。建页前用来确认"这页是空的",不会覆盖别人写的东西 */
  async countChildren(pageId) {
    const data = await this.request('get', `/blocks/${pageId}/children?page_size=100`);
    return (data.results ?? []).length + (data.has_more ? 100 : 0);
  }

  /**
   * 读一个页面的前 10 个 block,找 "appid: NNNNNN" 行。
   * (Notion 的 search API 只搜标题不搜正文,所以只能这样读 block。)
   */
  async extractAppIdFromPageContent(pageId) {
    const data = await this.request('get', `/blocks/${pageId}/children?page_size=10`);
    for (const block of data.results ?? []) {
      if (block.type !== 'paragraph') continue;
      const text = richTextToPlain(block.paragraph.rich_text);
      const m = text.match(/^appid:\s*(\d+)/i);
      if (m) return m[1];
    }
    return null;
  }
}

/**
 * 从数据库 schema 里挑出我们要用的两个属性。
 *
 * **属性的类型是读出来的,不是猜的。** Notion 的 `status` 和 `select` 是两种属性,
 * 写入载荷不一样(`{status:{name}}` vs `{select:{name}}`),写错直接 400。
 * 名字也不能写死:这个数据库是用户自己的,`Name` / `名称` / `Status` / `状态` 都可能。
 *
 * 只有一个决策点是故意的 —— 建页和改状态如果各自判断"哪个属性是状态",
 * 迟早会在某个数据库上得出不同答案。
 */
export function pickGuideDbProperties(properties) {
  const entries = Object.entries(properties ?? {});
  const found =
    entries.find(([, p]) => p?.type === 'status') ?? entries.find(([, p]) => p?.type === 'select');
  const [titleProperty] = entries.find(([, p]) => p?.type === 'title') ?? ['Name'];
  if (!found) return { titleProperty, status: null };
  const [property, prop] = found;
  return {
    titleProperty,
    status: {
      property,
      type: prop.type,
      options: (prop[prop.type]?.options ?? []).map((o) => o.name),
    },
  };
}

export const richTextToPlain = (rt) => (rt ?? []).map((t) => t.plain_text).join('');

/** 外链图标的载荷。建页和补图标是同一个形状,别在两处各写一遍 */
const externalIcon = (url) => ({ type: 'external', external: { url } });

/**
 * 给一个**已经存在**的页面补图标 —— 只在它本来一个图标都没有的时候补。
 *
 * 「接管用户建好的空页时不动它的标题、图标和状态」这条规矩要留着:那几样是他手设的,
 * 我们是来写正文的。但**空着不算一个选择**——没有图标的页面不是"用户挑了没有图标",
 * 是那一格还没人填。填空不是覆盖,所以这里只补 null,有图标的一律不碰(哪怕是个 emoji)。
 *
 * @returns {Promise<boolean>} 真补了才返回 true,方便调用方如实汇报
 */
export async function fillMissingIcon(notion, page, iconUrl) {
  if (!iconUrl || !page?.id || page.icon) return false;
  try {
    await notion.setPageIcon(page.id, iconUrl);
    return true;
  } catch {
    // 吞掉是**故意的,而且只在这一处**:图标是锦上添花,正文才是本体,不该因为补图标
    // 失败就把一次已经写好正文的落地/搬家报成失败。放在函数里而不是让每个调用方各写一个
    // `.catch()`,是为了让"为什么吞"只有一个说法、也只有一处要改
    return false;
  }
}

/** 从 URL 里提取 Notion 页面 ID,转成 API 要的带横线 UUID 格式 */
export function extractNotionPageId(url) {
  const clean = String(url).split('?')[0];
  const m = clean.match(
    /([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/?$/i
  );
  if (!m) throw new Error('无法从URL中提取Notion页面ID: ' + url);
  const id = m[1].replace(/-/g, '');
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/**
 * 判断"两个链接是不是同一个 Notion 页面"必须用这个规范化后的 ID 比较,不能比 URL 原文——
 * Notion 有时会在 URL 里加标题 slug 前缀,同一页面两次查询拿到的 URL 文本会不一样。
 * (踩过:按 URL 原文比对,把已存在的页面误判成新页面、覆盖了整理好的名字。)
 * 正则限定 UUID 的分组长度,避免 slug 里的十六进制字符(比如 "Palworld" 的 a/d)污染结果。
 */
export function normalizeNotionId(value) {
  const m = String(value).match(
    /([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})(?:[/?#]|$)/i
  );
  return m ? m[1].replace(/-/g, '').toLowerCase() : null;
}

/**
 * 新建的攻略页给什么状态 —— **按这个游戏的真实解锁进度算出来**,不是一个固定值。
 *
 *   满成就            → `Done`
 *   解锁了一部分      → `In progress`
 *   一个都没解锁 / 没数据 → `Not started`
 *
 * ## 为什么不是固定值(踩过)
 *
 * 第一版写死成 `Staged`,理由是"`guide-status` 会自我修正:真满成就的话下一轮
 * 自动提成 `Done`"。**这个理由只对了一半。** 收敛是单向的:提升会覆盖除 `Done`
 * 以外的一切,降级却只动 `Done`(见 CLAUDE.md「Guide page status」)。所以一个
 * 没打完的页面**永远不会被回头修**,写死的那个值就是它的终身状态。
 *
 * 而且 `Staged` 在这个库里有特定含义:**曾经满成就、被更新补成就顶下来的**
 * (Supermarket Together 28/51 就是)。把一份新搬来的攻略塞进那一档,等于给它
 * 贴了一个"从完成状态退回来"的标签,而它从来没完成过。
 *
 * 和 `syncGuideStatuses` 不冲突:那边只做 `Done` 的两个方向,`In progress` /
 * `Not started` 的页面它不碰,正是用户手动挑的那些状态该有的待遇。
 *
 * ## 为什么是 `In progress` 而不是 `Paused`(2026-08-13 改)
 *
 * 原来写的是 `Paused`。换掉有两个理由,第二个是硬的:
 *
 * 1. `Paused` 是在替用户声明意图 —— "解锁了一部分"只说明这个游戏开过头,
 *    说不出他是搁置了还是正在打。`In progress` 是这份数据真正支持的那句话。
 * 2. **这四个值就是 `createGuideDatabase` 给新库建的那四个选项**,而
 *    `Not started` / `In progress` / `Done` 正好是 Notion status 属性的自带默认
 *    (实测确认),于是新用户只需要手动补一个 `Staged`。留着 `Paused` 就要补两个,
 *    而且少补任何一个,第一次对"玩了一半的游戏"跑 `guide-gen` 就会被
 *    `planNotionTarget` 的选项校验当场拦下 —— 正是自动建库要消灭的那堵墙。
 *
 * **`Paused` 依然是完全合法的值**,只是程序不再写它。老库里已有的 `Paused` 页面
 * 不会被动:降级只碰 `Done`,升级只在满成就时发生。手动把页面排成 `Paused` 也照样
 * 被尊重 —— 那条"不到 100% 的状态是你自己挑的"的规矩没有变。
 */
export function newGuideStatus(game) {
  const total = Number(game?.total ?? 0);
  const achieved = Number(game?.achieved ?? 0);
  if (total > 0 && achieved >= total) return 'Done';
  // total 还没同步(null)或这游戏没有成就系统(0)也走这里:一个都没解锁,
  // "Not started" 是这两种情况下都说得通的那个
  return achieved > 0 ? 'In progress' : 'Not started';
}

/**
 * 写 Notion 之前该问的都在这里问完:属性名和类型、状态选项、有没有同名页面。
 *
 * **同名页面不是错误,多半正是要写的那一页。** Notion 攻略库里躺着几个"页建好了、
 * 攻略还没写"的空页(Xenoblade Chronicles X、三相奇谈 等),用户对这个游戏跑生成,
 * 想要的就是把内容填进那一页,而不是并排再建一个同名的。
 *
 * 但**页面上已经有东西就一律不碰** —— 那是用户手写的笔记,追加只会拼成一份四不像,
 * 而且不可逆。这时候明确报出来让人自己决定。
 */
export async function planNotionTarget(notion, game, { statusValue = null } = {}) {
  const schema = await notion.fetchGuideDbSchema();
  // 校验的是**这次真要写的那个值**,不是某个固定值 —— 写死一个去校验,
  // 就会出现"校验通过了、写下去的却是另一个没在选项里的值"
  if (schema.status && statusValue && !schema.status.options.includes(statusValue)) {
    throw new Error(
      `Notion 攻略库的「${schema.status.property}」属性里没有「${statusValue}」这个选项。` +
        `现有选项:${schema.status.options.join(' / ')}。先去 Notion 里加上,或者用 --local 写本地。`
    );
  }

  const pages = await notion.queryGuideDatabase();
  const same = pages.filter((p) => p.title.trim() === game.trim());
  if (same.length > 1) {
    throw new Error(
      `Notion 攻略库里有 ${same.length} 个都叫《${game}》的页面,分不清该写哪个。` +
        '先在 Notion 里把重复的处理掉,或者用 --local 写本地。'
    );
  }

  let existingPage = null;
  if (same.length === 1) {
    const count = await notion.countChildren(same[0].id);
    if (count > 0) {
      throw new Error(
        `Notion 里已经有《${game}》这一页而且**里面有内容**(${count} 个块):${same[0].url}\n` +
          '往里面追加会把你手写的笔记和生成的内容拼成一份四不像,而且撤不回来。' +
          '要重写就先把那一页清空(或者删掉),要写本地就加 --local。'
      );
    }
    existingPage = same[0];
  }

  return {
    titleProperty: schema.titleProperty,
    status: schema.status && statusValue ? { ...schema.status, value: statusValue } : null,
    existingPage,
  };
}
