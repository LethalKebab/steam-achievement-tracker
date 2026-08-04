/**
 * Notion API 客户端(原 steam_daily_checkbox_sync.gs / steam_guides_sync.gs 里的 Notion 部分)
 * ------------------------------------------------
 * token 从 config.json 的 notion.token(或环境变量 NOTION_TOKEN)读,不写进源码。
 * 相关页面(或它们共同的父页面)需要加到这个 integration 的 connections 里,
 * 否则 API 会返回 404/无权限:Notion 页面右上角 ••• → Connections → Add connection。
 */
import { sleep } from './steam.js';

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
  async fetchAllToDoBlocks(blockId, results = []) {
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
          });
          continue;
        }
        if (block.type === 'child_page') {
          if (/成就|achievement/i.test(block.child_page.title ?? '')) {
            await this.fetchAllToDoBlocks(block.id, results);
          }
          continue;
        }
        if (block.has_children && !['child_database', 'link_to_page'].includes(block.type)) {
          await this.fetchAllToDoBlocks(block.id, results);
        }
      }
      cursor = data.has_more ? data.next_cursor : null;
    } while (cursor);
    return results;
  }

  async checkTodo(blockId) {
    return this.request('patch', `/blocks/${blockId}`, { to_do: { checked: true } });
  }

  /** 查攻略数据库拿全部页面 [{id, title, url}],自动翻页 */
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
        const titleProp = Object.values(page.properties ?? {}).find((p) => p?.type === 'title');
        results.push({
          id: page.id,
          title: richTextToPlain(titleProp?.title),
          url: page.url,
        });
      }
      cursor = data.has_more ? data.next_cursor : null;
    } while (cursor);
    return results;
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
 * (原版就是因为按 URL 原文比对,把已存在的页面误判成新页面、覆盖了整理好的名字。)
 * 正则限定 UUID 的分组长度,避免 slug 里的十六进制字符(比如 "Palworld" 的 a/d)污染结果。
 */
export function normalizeNotionId(value) {
  const m = String(value).match(
    /([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})(?:[/?#]|$)/i
  );
  return m ? m[1].replace(/-/g, '').toLowerCase() : null;
}
