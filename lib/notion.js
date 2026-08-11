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
      ...(icon ? { icon: { type: 'external', external: { url: icon } } } : {}),
    });
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
