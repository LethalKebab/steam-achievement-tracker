/**
 * Notion API client
 * ------------------------------------------------
 * The token is read from `notion.token` in config.json (or the NOTION_TOKEN env var); it is
 * never written into source. The relevant pages (or their shared parent page) must be added to
 * this integration's connections, or the API answers 404/no-permission: open the page in Notion,
 * ••• in the top right → Connections → Add connection.
 */
import { sleep } from './steam.js';
import { chunkBlocks, splitDeepChildren, toRichText, richTextToPlain } from './notionblocks.js';
import { msg } from './messages.js';

const NOTION_VERSION = '2022-06-28';

/**
 * The status options handed to an auto-created guide database. **These four are exactly the
 * complete set of values the program ever writes** — `newGuideStatus` writes the first three
 * (`Not started` / `In progress` / `Done`), `syncGuideStatuses` writes `Done` / `Staged`.
 * `planNotionTarget` validates "the value actually about to be written", so having all four
 * present proves the program can never write something outside the option set.
 *
 * The order follows Notion's own workflow (not started → in progress → regressed → done), because
 * **`Not started` / `In progress` / `Done` are Notion's own defaults for a status property**
 * (create a status property without specifying options and those three come back — measured).
 * So somebody building the database by hand only has to add `Staged`.
 *
 * Extra options are harmless: validation only asks "is the value being written in there", never
 * what else is. Add `Paused` / `Differed` or anything else in Notion; the program never
 * overwrites them.
 */
export const GUIDE_STATUS_OPTIONS = ['Not started', 'In progress', 'Staged', 'Done'];

/**
 * How each option looks. **Presentation only** — nothing reads this to decide anything, and
 * `GUIDE_STATUS_OPTIONS` stays a plain list of names because six other places use it as one.
 *
 * Three of the colours are Notion's own defaults for a status property, so a database built by
 * hand and one built here look alike. `Staged` is ours rather than Notion's and is `purple`,
 * matching the guide database this was developed against — one state, one colour, wherever you
 * are looking. Yellow was the first choice and was dropped: hand-added options like `Paused`
 * commonly take it, and two states sharing a colour is the thing this table exists to prevent.
 *
 * `group` is what puts an option in a board column. **It goes on the option, not in a top-level
 * `groups` array** — see `createGuideDatabase`.
 */
export { COLOUR_ZH };

export const GUIDE_STATUS_STYLE = {
  'Not started': { color: 'default', group: 'To-do' },
  'In progress': { color: 'blue', group: 'In progress' },
  Staged: { color: 'purple', group: 'In progress' },
  Done: { color: 'green', group: 'Complete' },
};

/**
 * The views API is served on `2026-03-11` and the endpoint accepts no other version.
 * **Sent per request rather than by moving `NOTION_VERSION`**: that version is the data-source
 * era, where databases split into databases-plus-data-sources, and moving the whole client onto it
 * is a migration of every call in this file plus three test suites. Measured 2026-08-30: a database
 * created on `2022-06-28` is readable on `2026-03-11`, exposes a data source, and accepts a view —
 * so the two versions coexist in one client with no conversion step.
 */
const VIEWS_NOTION_VERSION = '2026-03-11';

/**
 * The colour names as a person sees them. **For the reader, not for the API** — the hint has to
 * name the swatch they will click in Notion, and in a Chinese workspace that picker says 「蓝」 and
 * 「紫」 rather than `blue` and `purple`.
 */
const COLOUR_ZH = { default: '默认', blue: '蓝', purple: '紫', green: '绿' };

export class NotionClient {
  constructor(cfg) {
    this.token = cfg.notion?.token ?? '';
    this.overviewDbId = cfg.notion?.overviewDbId ?? '';
  }

  get configured() {
    return Boolean(this.token);
  }

  async request(method, path, payload, { retriedOn429 = false, version = NOTION_VERSION } = {}) {
    if (!this.token) {
      // **Mentions neither config.json nor the env var.** This sentence renders verbatim in the
      // Dashboard's floating bar, and a packaged-build user has no terminal and will not go
      // digging through config files — the setup page is the entry point for this. Someone on the
      // CLI reading "go to the setup page" can find it just as well (that page is served by the
      // `serve` already running)
      throw new Error(msg('notion.noConnection'));
    }
    const res = await fetch('https://api.notion.com/v1' + path, {
      method: method.toUpperCase(),
      headers: {
        Authorization: 'Bearer ' + this.token,
        'Notion-Version': version,
        'Content-Type': 'application/json',
      },
      body: payload ? JSON.stringify(payload) : undefined,
      // With a timeout: one dry run reads dozens of pages over hundreds of requests, and a single
      // stalled call must not make the whole flow wait forever
      signal: AbortSignal.timeout(30_000),
    });

    if (res.status === 429 && !retriedOn429) {
      await sleep(1000);
      return this.request(method, path, payload, { retriedOn429: true, version });
    }

    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(msg('notion.notJson', { status: res.status, body: text.slice(0, 200) }));
    }
    if (res.status >= 400) {
      throw new Error(msg('notion.apiError', { status: res.status, message: body.message || text }));
    }
    return body;
  }

  /**
   * Recursively pulls every to_do block under one block (including ones nested inside containers
   * such as toggle/column).
   * Child pages are only descended into when the title looks like an achievement list (some games
   * keep their checklist on an "achievements" sub-page); child_database / link_to_page are skipped
   * outright — those would mean editing database properties rather than blocks, which is an
   * entirely different sync path.
   */
  async fetchAllToDoBlocks(blockId, results = [], parent = null, container = false) {
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
            // **Checkboxes sitting inside a toggle / column have to be marked.** `parent` cannot
            // express this: an entry inside a top-level toggle (rule five's long list) carries
            // `parent` straight through as `null`, which looks exactly like an orphaned sub-step
            // written at top level when it should have been indented. The validator has to tell
            // those two apart.
            container,
          });
          // **Descending into a to_do is mandatory** — no `continue` here, or every sub-step
          // checkbox nested under an achievement becomes invisible, while the local markdown
          // backend's regex is /^\s*[-*]\s*\[/, which reads indented lines in as a matter of
          // course. The same guide behaving differently per backend is a bug, not a design.
          if (block.has_children) await this.fetchAllToDoBlocks(block.id, results, block.id, false);
          continue;
        }
        if (block.type === 'child_page') {
          if (/成就|achievement/i.test(block.child_page.title ?? '')) {
            await this.fetchAllToDoBlocks(block.id, results, parent, container);
          }
          continue;
        }
        if (block.has_children && !['child_database', 'link_to_page'].includes(block.type)) {
          // A container (toggle / column etc.) does not change ownership: a toggle wrapped inside
          // an achievement's to_do still holds that achievement's sub-steps, so `parent` passes
          // straight through. But **record that it is inside a container** — see the `container`
          // comment above
          await this.fetchAllToDoBlocks(block.id, results, parent, true);
        }
      }
      cursor = data.has_more ? data.next_cursor : null;
    } while (cursor);
    return results;
  }

  /**
   * **Every** block under a page, as raw JSON, with child blocks inlined under `children`.
   *
   * A different job from `fetchAllToDoBlocks`, and they must not be merged: that one picks out
   * only checkboxes and flattens each block into a small `{key,text,checked,parent}` shape — good
   * enough for syncing, **but unflattenable afterwards**. This one backs a page up before it is
   * overwritten, which demands the opposite: not one field may be dropped, because it is the only
   * thing that can give the original back after the overwrite.
   */
  async fetchAllBlocks(blockId) {
    const out = [];
    let cursor = null;
    do {
      const qs = '?page_size=100' + (cursor ? `&start_cursor=${cursor}` : '');
      const data = await this.request('get', `/blocks/${blockId}/children${qs}`);
      for (const block of data.results ?? []) {
        // The "children" of a child_database / link_to_page are not this page's content, they are
        // another entity — descending into them can neither back them up nor delete them
        const recurse = block.has_children && !['child_database', 'link_to_page'].includes(block.type);
        out.push(recurse ? { ...block, children: await this.fetchAllBlocks(block.id) } : block);
      }
      cursor = data.has_more ? data.next_cursor : null;
    } while (cursor);
    return out;
  }

  /**
   * Deletes a block. This Notion endpoint **archives** (`archived: true`) rather than physically
   * deleting — it disappears from the page but stays recoverable from Notion's trash for 30 days.
   * That is the overwrite flow's second net besides the local backup, and worth knowing
   */
  async deleteBlock(blockId) {
    return this.request('delete', `/blocks/${blockId}`);
  }

  async checkTodo(blockId) {
    return this.setTodoChecked(blockId, true);
  }

  /**
   * The routine sync only ever **ticks** (checked: true) and never unticks — so it cannot repair a
   * box that was wrongly ticked in the past. Unticking is a manual correction, going through the
   * same endpoint but passing false explicitly, so that "tick" and "untick" do not each grow their
   * own patch logic.
   */
  async setTodoChecked(blockId, checked) {
    return this.request('patch', `/blocks/${blockId}`, { to_do: { checked: Boolean(checked) } });
  }

  /**
   * Replaces a to_do block's **text** while leaving the block itself alone — this is how partial
   * rewrites reach Notion.
   *
   * **Why not "delete the page and rewrite it"**: that destroys everything the converter cannot
   * represent (images, embeds, sub-pages, hand-made tables), and the very existence of the
   * `unconverted` field is this codebase admitting there is a batch of those. A "partial rewrite"
   * that rewrote the whole page would be the exact bug this feature exists to fix.
   *
   * Keeping the block id has a second, less visible benefit: **block links the user saved and
   * in-page references pointing at this entry all keep working**. A deleted-and-recreated block
   * gets a new id, and those links would point at an archived one.
   *
   * **It takes a rich_text array, not a string, and that is required.**
   *
   * It originally took a string and called `toRichText` itself, while the caller (guidepatch)
   * pushed blocks from `markdownToBlocks` back through `richTextToPlain` into a string first. That
   * is a **lossy round trip**: `**bold**` becomes `annotations.bold` on the first conversion, and
   * squashing back to plain text loses the pair of asterisks, so the second conversion produces
   * unstyled prose — which means every achievement name in the guide loses its bold in Notion.
   *
   * And **nothing would catch it**: `richTextToPlain` yields the same plain text either way, so
   * the read-back check still passes. `<br>` (a line break inside a block) is lost on the same
   * round trip. Convert once; whoever converts, passes.
   *
   * `checked` defaults to not being sent: changing text and changing tick state are two different
   * things, and folding them into one write would let a "rewrite" overwrite the tick state in
   * passing. Pass it explicitly to change both — which is exactly what a partial rewrite does
   * (newly written entries are always unticked and have to be restored from the database).
   */
  async setTodoRichText(blockId, richText, { checked = null } = {}) {
    const to_do = { rich_text: Array.isArray(richText) ? richText : toRichText(String(richText ?? '')) };
    if (checked !== null) to_do.checked = Boolean(checked);
    return this.request('patch', `/blocks/${blockId}`, { to_do });
  }

  /**
   * Replaces a to_do block's child blocks **as a batch**: delete the old ones, then append the new.
   *
   * A batch replacement rather than an entry-by-entry alignment, because Notion's append can only
   * add to the end — there is no insert and no reorder — so "clear it and write in order" is the
   * only way to make the sub-steps end up in the newly written order.
   *
   * The order is **delete first, write second**, the same as `landToNotion` overwriting a whole
   * page, and for the same reason: the other way round, a mid-flight failure leaves a page holding
   * both the old and the new sub-steps, and nobody can tell which lines are stale. Failing midway
   * through delete-then-write leaves "the sub-steps are gone", which is visible, and the original
   * is in the backup.
   *
   * `sleep(200)` is the same number as deleting a whole page: deleting dozens of blocks without
   * pausing hits the rate limit, and on this path every 429 retry happens in a state where half
   * the old content is already gone.
   */
  async replaceTodoChildren(blockId, blocks) {
    for (const k of await this.childBlockStubs(blockId)) {
      // **Only body blocks are deleted.** `to_do` is a sub-step, `toggle` is a group label
      // (prerequisites/steps/notes, see guidegen's `groupLabelRule`) — both are things the model
      // hands back in full on every rewrite. Images, tables and paragraphs are **not** deleted:
      // for a collect-the-things game, the only way to pin down a location is the user pasting a
      // screenshot themselves (rule two states outright that the model cannot supply reliable
      // in-game screenshots), so deleting those in passing is unacceptable — and the deletion
      // raises no error, so the user only finds out next time they open the page, with no way to
      // tell which step caused it.
      if (k.type !== 'to_do' && k.type !== 'toggle') continue;
      await this.deleteBlock(k.id);
      await sleep(200);
    }
    if (blocks?.length) await this.appendBlocks(blockId, blocks);
  }

  /**
   * A block's **direct** children, as `{id, type}` only.
   *
   * Not `fetchAllBlocks`: that pulls the whole subtree, while all this needs is what type each
   * first-level block is. Deleting a parent makes Notion archive the entire subtree with it, so
   * the deeper levels never need enumerating.
   */
  async childBlockStubs(blockId) {
    const out = [];
    let cursor = null;
    do {
      const qs = '?page_size=100' + (cursor ? `&start_cursor=${cursor}` : '');
      const data = await this.request('get', `/blocks/${blockId}/children${qs}`);
      for (const b of data.results ?? []) out.push({ id: b.id, type: b.type });
      cursor = data.has_more ? data.next_cursor : null;
    } while (cursor);
    return out;
  }

  /**
   * The definition of the guide database's "progress" property. **The type is read, never
   * guessed**: Notion's `status` and `select` are two different property types whose write
   * payloads have different shapes (`{status:{name}}` vs `{select:{name}}`), and the wrong one is
   * rejected by the API outright.
   * Prefers the status type, falls back to select; returns null when there is neither, leaving the
   * caller to raise the error.
   */
  /** Reads every property name page creation needs in one request. Do not split it into two reads of the same schema */
  async fetchGuideDbSchema(dbId = this.overviewDbId) {
    const db = await this.request('get', `/databases/${dbId}`);
    return pickGuideDbProperties(db.properties);
  }

  async fetchGuideStatusSchema(dbId = this.overviewDbId) {
    return (await this.fetchGuideDbSchema(dbId)).status;
  }

  /** Updates a page's status property. property/type come from fetchGuideStatusSchema — never hardcode them */
  async setPageStatus(pageId, { property, type, value }) {
    return this.request('patch', `/pages/${pageId}`, {
      properties: { [property]: { [type]: { name: value } } },
    });
  }

  /** Sets the icon on an existing page. Icons at creation time go through createGuidePage; both use the same payload shape */
  async setPageIcon(pageId, url) {
    return this.request('patch', `/pages/${pageId}`, { icon: externalIcon(url) });
  }

  /**
   * A page's **current** icon (null when it has none).
   *
   * `fillMissingIcon`'s rule is "only fill the slot that is empty", so the caller has to know
   * whether anything is in that slot right now. Getting it out of a database query is free, but
   * the overwrite path takes the "I already know which page" route and has no such query — and
   * rather than guessing an `icon: null` to pass in (which would mean overwriting the user's
   * chosen icon every time), it is honest to spend one read
   */
  async fetchPageIcon(pageId) {
    const page = await this.request('get', `/pages/${pageId}`);
    return page.icon ?? null;
  }

  /** Queries the guide database for every page as [{id, title, url, status}], paging automatically */
  async queryGuideDatabase(dbId = this.overviewDbId) {
    if (!dbId) {
      // As above: the setup page can create a database and can take an existing one, so pointing
      // the user there is enough
      throw new Error(msg('notion.noDb'));
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
        // Read the status property out while we are here. Throwing `properties` away means "what
        // status is this page in" has to be asked page by page later; keeping it makes the
        // convergent status sync cost zero extra requests
        const statusProp = props.find((p) => p?.type === 'status' || p?.type === 'select');
        results.push({
          id: page.id,
          title: richTextToPlain(titleProp?.title),
          url: page.url,
          status: statusProp ? (statusProp[statusProp.type]?.name ?? null) : null,
          // Read the icon out while we are here too. The query response carries it anyway, so not
          // reading it costs the same — and "does this page have an icon" is fillMissingIcon's
          // only input, making a second read purely a way to fetch a field already in hand
          icon: page.icon ?? null,
        });
      }
      cursor = data.has_more ? data.next_cursor : null;
    } while (cursor);
    return results;
  }

  /**
   * Creates a guide page. **An empty page only; the body is appended separately in batches** —
   * Notion's create-page carries at most 100 children in one call, while a guide routinely runs to
   * hundreds of blocks. Separating "create the page" from "fill the body" keeps the batching logic
   * in one place (`appendBlocks`) instead of writing the limit check out twice.
   *
   * `icon` is the Steam game icon URL and may be empty — an icon is decoration, not function, and
   * failing to get one must not block page creation.
   */
  async createGuidePage({
    dbId = this.overviewDbId,
    titleProperty = 'Name',
    title,
    icon = null,
    status = null,
  }) {
    const properties = { [titleProperty]: { title: [{ text: { content: title } }] } };
    // status takes the same {property, type, value} shape setPageStatus does — do not invent
    // another one here
    if (status) properties[status.property] = { [status.type]: { name: status.value } };
    return this.request('post', '/pages', {
      parent: { database_id: dbId },
      properties,
      ...(icon ? { icon: externalIcon(icon) } : {}),
    });
  }

  /**
   * The pages this integration can see that are **usable as a parent page**.
   *
   * The vast majority of the "pages" `/search` returns are database rows (every guide in the guide
   * database is a page with `parent.type === 'database_id'`). On a real account 99 out of 100 are
   * that kind — listing them all would drown the parent-page dropdown in the user's own guides. So
   * this keeps only the ones whose `parent.type` is not `database_id`, i.e. pages in the real
   * sense.
   *
   * `truncated` has to be handed out honestly: a large workspace cannot be paged through, and "not
   * in the list" versus "the list was cut off" are two completely different situations for the
   * user.
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
   * Creates a guide database this project recognises under some page.
   *
   * ## Reading back after creating is mandatory
   *
   * "The call succeeded ≠ the content is right" is not a slogan on this path, it was measured: a
   * top-level `groups` array is ignored whether passed at creation or PATCHed afterwards — HTTP
   * 200 every time, nothing changed, all three payload shapes silently ineffective. So whether the
   * four options actually landed can only be answered by reading it back and asking
   * `pickGuideDbProperties` — and asking *it*, not parsing the response here, because it is the
   * real downstream consumer.
   *
   * **Grouping is per option, not a top-level array**, and that corrects the paragraph above rather
   * than contradicting it: the array really is ignored, and `group` on each option really does
   * work. Measured 2026-08-30 on `2022-06-28` — the version this client already pins — by creating
   * a database, reading it back and comparing: all four colours and all four group assignments
   * matched what was sent. If "everything is grey and all in To-do" is ever reported again, the
   * payload has lost its per-option fields; it is not a Notion limitation.
   *
   * ## The board view is a separate call, and is allowed to fail
   *
   * A view is a second call on a second API version, and the database is perfectly usable without
   * one. So it is attempted only after the property is known good, and a failure is **reported in
   * the return value, never thrown** — turning a working setup into a failed one over a view would
   * be a worse bug than the grey table this fixes.
   */
  async createGuideDatabase({ parentPageId, title = 'Steam 攻略' }) {
    if (!parentPageId) throw new Error(msg('notion.needParent'));
    const created = await this.request('post', '/databases', {
      parent: { type: 'page_id', page_id: parentPageId },
      title: [{ type: 'text', text: { content: title } }],
      properties: {
        Name: { title: {} },
        Status: {
          status: { options: GUIDE_STATUS_OPTIONS.map((name) => ({ name, ...GUIDE_STATUS_STYLE[name] })) },
        },
      },
    });

    // Read back, verified through the real picking logic rather than parsed here
    const fresh = await this.request('get', `/databases/${created.id}`);
    const picked = pickGuideDbProperties(fresh.properties);
    // Two failures reported separately: **the fixes differ**. A property that was never created
    // means adding a property; a few missing options means adding options to a property that
    // exists. A merged single message would also render "there is no property at all" as
    // "all four options are missing", which sounds like the options were written wrong
    if (!picked.status) {
      throw new Error(msg('notion.createdNoStatus', {
        url: created.url,
        options: GUIDE_STATUS_OPTIONS.join(' / '),
      }));
    }
    const got = picked.status.options;
    const missing = GUIDE_STATUS_OPTIONS.filter((o) => !got.includes(o));
    if (missing.length) {
      throw new Error(msg('notion.createdMissingOptions', {
        url: created.url,
        missing: missing.join(' / '),
        existing: got.join(' / ') || msg('notion.noOptions'),
      }));
    }
    const boardView = await this.createGuideBoardView(created.id).then(
      () => ({ ok: true }),
      (err) => ({ ok: false, error: String(err.message ?? err) })
    );

    return {
      boardView,
      // Stored with the hyphens removed. Notion accepts both spellings, but someone filling it in
      // by hand copies the 32 hex characters out of the URL as the docs describe — keeping
      // config.json to a single shape is what makes eyeballing and searching independent of case
      // and hyphens
      id: normalizeNotionId(created.id) ?? created.id,
      url: created.url,
      title,
      titleProperty: picked.titleProperty,
      statusProperty: picked.status.property,
      options: got,
    };
  }

  /**
   * Adds a board view to a freshly created guide database and makes it the tab that opens.
   *
   * Three calls, all on `VIEWS_NOTION_VERSION`, because the views API is served on no other:
   *
   * 1. read the database back for its **data source** — `createViewRequest` requires a
   *    `data_source_id`, and a database created on the old version has exactly one;
   * 2. read that data source's schema for the status property's **id** — `group_by` takes the id,
   *    not the name, and the name belongs to the user;
   * 3. create the view.
   *
   * `position: {type: 'start'}` is what makes this the first tab, which is what "the default view"
   * means in Notion — without it the board is appended and the table still opens. `group_by: 'group'`
   * groups by To-do / In progress / Complete rather than by individual option, which is why
   * `GUIDE_STATUS_STYLE` gives every option a group.
   *
   * **This throws.** Its caller is what decides a missing view is not a failed setup.
   */
  async createGuideBoardView(databaseId) {
    const v = { version: VIEWS_NOTION_VERSION };
    const db = await this.request('get', `/databases/${databaseId}`, null, v);
    const dataSourceId = db.data_sources?.[0]?.id;
    if (!dataSourceId) throw new Error(msg('notion.noDataSource'));

    const schema = await this.request('get', `/data_sources/${dataSourceId}`, null, v);
    const status = Object.entries(schema.properties ?? {}).find(([, p]) => p?.type === 'status');
    if (!status) throw new Error(msg('notion.noStatusForBoard'));

    return this.request(
      'post',
      '/views',
      {
        data_source_id: dataSourceId,
        database_id: databaseId,
        name: '看板',
        type: 'board',
        position: { type: 'start' },
        configuration: {
          type: 'board',
          group_by: {
            type: 'status',
            property_id: status[1].id,
            group_by: 'group',
            sort: { type: 'ascending' },
          },
        },
      },
      v
    );
  }

  /**
   * Adds the board view to a database that already exists, and does nothing if it already has one.
   *
   * Listing views returns **partial objects carrying only an id**, so each one has to be retrieved
   * to learn its type. That is one extra call per existing tab; a guide database has one or two.
   *
   * Existing databases are why this is separate from `createGuideBoardView`: a freshly created
   * database provably has no board, while a user's own database may have one they made themselves,
   * and adding a second is worse than adding none.
   */
  async ensureGuideBoardView(databaseId) {
    const v = { version: VIEWS_NOTION_VERSION };
    const list = await this.request('get', `/views?database_id=${databaseId}`, null, v);
    for (const row of list.results ?? []) {
      const full = await this.request('get', `/views/${row.id}`, null, v);
      if (full.type === 'board') return { ok: true, created: false };
    }
    await this.createGuideBoardView(databaseId);
    return { ok: true, created: true };
  }

  /**
   * Appends blocks to the end of a page, batching automatically against Notion's limit of 100.
   *
   * **On failure it throws how many blocks were already written.** A page cut off midway is half a
   * guide, and "there is something on the page" makes people think the write succeeded — this
   * project has already been bitten by "the call succeeded ≠ the content is right", so a
   * half-finished result has to be said out loud.
   */
  async appendBlocks(pageId, blocks, { after = null, atStart = false } = {}) {
    let written = 0;
    /**
     * **Positional insertion is for the first batch only; every later batch has to attach after
     * the previous batch's last block.** Without that, batch 2 drops to the end of the whole page
     * and a guide is torn in half — and nothing raises an error.
     * (`after` was measured working on 2022-06-28; the newer name is `position.after_block`, which
     * is the same thing.)
     */
    let cursorAfter = after;
    for (const chunk of chunkBlocks(blocks)) {
      // **One request only gets two levels of nesting in.** Anything deeper (a table wrapped in a
      // toggle) has its children lifted out first and filled in on a second pass once the parent
      // block exists and has an id — by calling ourselves recursively, so any depth is just a few
      // more passes
      const { shallow, deferred } = splitDeepChildren(chunk);
      try {
        const res = await this.request('patch', `/blocks/${pageId}/children`, {
          children: shallow,
          // The first batch may need inserting at the top of the page (there is no retained block
          // in front of it to anchor to); after that everything attaches behind the previous
          // batch's last block. Both forms of positioning are measured working on 2022-06-28
          ...(cursorAfter ? { after: cursorAfter } : {}),
          ...(!cursorAfter && atStart && written === 0 ? { position: { type: 'start' } } : {}),
        });
        const landed = res?.results ?? [];
        if (landed.length) cursorAfter = landed[landed.length - 1].id;
        for (const d of deferred) {
          const parent = res?.results?.[d.index];
          if (!parent?.id) {
            // No parent block id means the fill-in cannot happen — say so, rather than letting a
            // toggle sit quietly empty
            throw new Error(msg('notion.noAppendIds'));
          }
          await sleep(350);
          await this.appendBlocks(parent.id, d.children);
        }
      } catch (err) {
        const e = new Error(msg('notion.partialWrite', {
          written, total: blocks.length, reason: err.message,
        }));
        e.written = written;
        throw e;
      }
      written += chunk.length;
      if (written < blocks.length) await sleep(350);
    }
    return { written, lastId: cursorAfter };
  }

  /** How many first-level blocks a page has. Used before creating to confirm "this page is empty", so nothing somebody else wrote gets overwritten */
  async countChildren(pageId) {
    const data = await this.request('get', `/blocks/${pageId}/children?page_size=100`);
    return (data.results ?? []).length + (data.has_more ? 100 : 0);
  }

  /**
   * Reads a page's first 10 blocks looking for an "appid: NNNNNN" line.
   * (Notion's search API searches titles only, never body text, so reading blocks is the only
   * option.)
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
 * Picks the two properties we use out of a database schema.
 *
 * **A property's type is read, never guessed.** Notion's `status` and `select` are two different
 * property types whose write payloads differ (`{status:{name}}` vs `{select:{name}}`), and the
 * wrong one is an outright 400. The names cannot be hardcoded either: this is the user's own
 * database, so `Name` / `名称` / `Status` / `状态` are all possible.
 *
 * Having exactly one decision point is deliberate — if creating a page and updating a status each
 * decided "which property is the status" for themselves, they would eventually disagree on some
 * database.
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

/**
 * The definition moved to `notionblocks.js` (next to its inverse, `toRichText`); this re-exports it.
 *
 * It moved because `blocksToOutline` needs it and that function lives in notionblocks.js — having
 * notionblocks import notion.js back would be a cycle (notion.js has imported it all along). The
 * re-export exists so the six call sites keep their imports: there is still exactly one definition.
 *
 * **It must be imported once and then exported, never written as `export { x } from '...'`.** That
 * form is pure forwarding and **creates no binding in this module** — while four places in this
 * file use it, so at runtime they would get `richTextToPlain is not defined`. The syntax is
 * perfectly legal and `node --check` passes; it only blows up when those lines actually run
 * (stepped on once, and a test is what caught it).
 */
export { richTextToPlain };

/** The payload for an external icon. Page creation and icon backfill share the shape, so do not write it out in two places */
const externalIcon = (url) => ({ type: 'external', external: { url } });

/**
 * Adds an icon to a page that **already exists** — only when it has no icon at all.
 *
 * The rule "when adopting an empty page the user created, do not touch its title, icon or status"
 * stands: those are things they set by hand, and we came to write the body. But **empty is not a
 * choice** — a page with no icon is not "the user picked no icon", it is a slot nobody has filled.
 * Filling a blank is not overwriting, so this only fills nulls and never touches an existing icon
 * (not even an emoji).
 *
 * @returns {Promise<boolean>} true only when something was actually filled, so the caller can
 *          report honestly
 */
export async function fillMissingIcon(notion, page, iconUrl) {
  if (!iconUrl || !page?.id || page.icon) return false;
  try {
    await notion.setPageIcon(page.id, iconUrl);
    return true;
  } catch {
    // Swallowing is **deliberate, and only here**: the icon is a garnish and the body is the
    // substance, so a failed icon backfill must not turn a landing/migration whose body was
    // already written into a reported failure. It lives in the function rather than every caller
    // writing its own `.catch()`, so that "why it is swallowed" has one statement and one place to
    // change
    return false;
  }
}

/** Extracts a Notion page ID from a URL and converts it to the hyphenated UUID form the API wants */
export function extractNotionPageId(url) {
  const clean = String(url).split('?')[0];
  const m = clean.match(
    /([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/?$/i
  );
  if (!m) throw new Error(msg('notion.badUrl', { url }));
  const id = m[1].replace(/-/g, '');
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/**
 * Deciding "are these two links the same Notion page" must compare this normalized ID and never
 * the raw URL text — Notion sometimes prefixes a URL with a title slug, so the same page's URL
 * text differs between two queries.
 * (Stepped on: comparing raw URLs misjudged an existing page as new and overwrote the curated
 * name.)
 * The regex pins the UUID's group lengths so hexadecimal characters inside a slug (the a/d in
 * "Palworld", say) cannot contaminate the result.
 */
export function normalizeNotionId(value) {
  const m = String(value).match(
    /([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})(?:[/?#]|$)/i
  );
  return m ? m[1].replace(/-/g, '').toLowerCase() : null;
}

/**
 * What status a newly created guide page gets — **computed from this game's real unlock
 * progress**, not a fixed value.
 *
 *   all achievements     → `Done`
 *   some unlocked        → `In progress`
 *   none unlocked / no data → `Not started`
 *
 * ## Why not a fixed value (stepped on)
 *
 * The first version hardcoded `Staged`, justified as "`guide-status` corrects itself: if it really
 * is at 100% the next pass promotes it to `Done` automatically". **That justification is only half
 * right.** Convergence is one-directional: promotion overwrites everything except `Done`, while
 * demotion only touches `Done` (see "Guide page status" in CLAUDE.md). So an unfinished page is
 * **never revisited**, and the hardcoded value is its status for life.
 *
 * And `Staged` has a specific meaning in this database: **was at 100%, then knocked below it by a
 * patch adding achievements** (Supermarket Together at 28/51 is one). Filing a freshly migrated
 * guide under that label tags it as "regressed from complete" when it was never complete.
 *
 * No conflict with `syncGuideStatuses`: that only handles the two directions of `Done` and never
 * touches an `In progress` / `Not started` page, which is exactly the treatment the statuses the
 * user picked by hand deserve.
 *
 * ## Why `In progress` rather than `Paused`
 *
 * It used to write `Paused`. Two reasons for the change, the second one hard:
 *
 * 1. `Paused` declares an intent on the user's behalf — "some unlocked" only says the game has
 *    been started, not whether it was set aside or is being played. `In progress` is the sentence
 *    this data actually supports.
 * 2. **These four values are exactly the four options `createGuideDatabase` gives a new
 *    database**, and `Not started` / `In progress` / `Done` happen to be Notion's own defaults for
 *    a status property (measured), so a new user only has to add `Staged` by hand. Keeping
 *    `Paused` would mean adding two — and missing either one makes the first `guide-gen` on a
 *    half-played game get stopped dead by `planNotionTarget`'s option check, which is exactly the
 *    wall auto-creating the database exists to remove.
 *
 * **`Paused` remains a perfectly legal value**, the program simply no longer writes it. Existing
 * `Paused` pages in an older database are untouched: demotion only touches `Done`, and promotion
 * only happens at 100%. Setting a page to `Paused` by hand is still respected — the rule that "a
 * status below 100% is one you chose" has not changed.
 */
export function newGuideStatus(game) {
  const total = Number(game?.total ?? 0);
  const achieved = Number(game?.achieved ?? 0);
  if (total > 0 && achieved >= total) return 'Done';
  // A total that has not synced yet (null) or a game with no achievement system (0) lands here
  // too: nothing is unlocked, and "Not started" is the value that reads correctly in both cases
  return achieved > 0 ? 'In progress' : 'Not started';
}

/**
 * Everything worth asking before writing to Notion is asked here: property names and types, status
 * options, whether a same-titled page exists.
 *
 * **A same-titled page is not an error, it is most likely the page we mean to write.** The Notion
 * guide database holds a few "page created, guide not written yet" placeholders (Xenoblade
 * Chronicles X, 三相奇谈 and others), and a user running generation for that game wants the content
 * filled into that page rather than a second same-titled one created beside it.
 *
 * But **a page with anything on it is never touched** — that is the user's hand-written notes, and
 * appending would only assemble a hybrid nobody can untangle, irreversibly. In that case say so
 * clearly and let them decide.
 */
export async function planNotionTarget(notion, game, { statusValue = null } = {}) {
  const schema = await notion.fetchGuideDbSchema();
  // What gets validated is **the value actually about to be written**, not some constant —
  // validating a hardcoded one produces "validation passed, and then a value that was not in the
  // option set got written"
  // The messages below **only say what to change on the Notion side** (the shared next step for
  // both surfaces) and no longer append "or write it locally with --local" — that is a
  // terminal-only escape hatch, and printing it here is advice a Dashboard user cannot act on.
  // Options can also be added from the setup page, see repairGuideDb
  if (schema.status && statusValue && !schema.status.options.includes(statusValue)) {
    throw new Error(msg('notion.missingStatusOption', {
      property: schema.status.property,
      value: statusValue,
      options: schema.status.options.join(' / '),
    }));
  }

  const pages = await notion.queryGuideDatabase();
  const same = pages.filter((p) => p.title.trim() === game.trim());
  if (same.length > 1) {
    throw new Error(msg('notion.duplicatePages', { n: same.length, game }));
  }

  let existingPage = null;
  if (same.length === 1) {
    const count = await notion.countChildren(same[0].id);
    if (count > 0) {
      throw new Error(msg('notion.pageHasContent', { game, count, url: same[0].url }));
    }
    existingPage = same[0];
  }

  return {
    titleProperty: schema.titleProperty,
    status: schema.status && statusValue ? { ...schema.status, value: statusValue } : null,
    existingPage,
  };
}

// ---------------------------------------------------------------------------
// Health check + repair at connection time
// ---------------------------------------------------------------------------

/**
 * The faults the health check can report. **Constants rather than strings scattered around** — the
 * UI branches on them and the tests assert on them, and a one-letter typo is silent on both sides.
 */
export const DB_PROBLEM = {
  BAD_TOKEN: 'bad-token',
  NO_DB_ID: 'no-db-id',
  DB_UNREADABLE: 'db-unreadable',
  NO_TITLE_PROP: 'no-title-prop',
  NO_STATUS_PROP: 'no-status-prop',
  MISSING_OPTIONS: 'missing-options',
  OUTDATED_FORMAT: 'outdated-format',
  NO_WRITE: 'no-write',
  STRANDED_PROBE_PAGE: 'stranded-probe-page',
};

/**
 * Asks "can this database actually be used" all in one go.
 *
 * ## Why it has to be asked at connection time
 *
 * Before this, `saveNotionConfig` checked only two things: does the token work, and can this ID be
 * queried for rows. **It read not one word of the schema** — property names, property types and
 * status options were all deferred until the first real write. So the user saw 「配好了」 on the
 * setup page and, days later, hit 「没有「XX」这个选项」 on their first `guide-gen`, by which point
 * they no longer connected the problem to that setup.
 *
 * Meanwhile `notion-check` checked nearly all of it — but it is a CLI command the user has to know
 * to type, and the setup page never called it. **Two paths checking different things is the shape
 * of that whole class of bug**; which option was missing is only the symptom. So this function
 * exists first of all so there is exactly one verdict; anyone writing a second one will drift.
 *
 * ## Returns a structured verdict, not formatted prose
 *
 * The CLI can be verbose (the user typed a command and is waiting for a report); the setup page
 * has to be short. Forcing one wording to serve both makes both awkward — the same rule as
 * `previewGuideRewrite` returning numbers rather than sentences. What is shared is the
 * **computation**, not the **wording**.
 *
 * `probeWrite` is `probeGuideDbWrite`: a read-only health check cannot detect "this integration
 * only has read permission", which happens to be a fault that goes green all the way through and
 * 403s at page creation.
 */
export async function inspectGuideDb(notion, dbId, { probeWrite = false } = {}) {
  const problems = [];
  const add = (code, severity, message, extra = {}) =>
    problems.push({ code, severity, message, ...extra });

  let workspace = null;
  try {
    const me = await notion.request('get', '/users/me');
    workspace = me.name || me.bot?.workspace_name || '未命名';
  } catch (err) {
    add(DB_PROBLEM.BAD_TOKEN, 'error', `token 不可用:${err.message}`);
    return { ok: false, fixable: false, workspace, database: null, schema: null, problems };
  }

  if (!dbId) {
    add(DB_PROBLEM.NO_DB_ID, 'error', '还没填攻略数据库 ID(也可以让程序帮你建一个)');
    return { ok: false, fixable: false, workspace, database: null, schema: null, problems };
  }

  let raw;
  try {
    raw = await notion.request('get', `/databases/${dbId}`);
  } catch (err) {
    // Two entirely different faults with different fixes — merging them into one sentence sends
    // somebody who typed the wrong ID off to check Connections over and over
    add(DB_PROBLEM.DB_UNREADABLE, 'error', `这个 ID 读不出数据库:${err.message}`, {
      causes: [
        '它不是数据库 —— 要把库整页打开,取 URL 里 ?v= 前面那 32 位十六进制;页面 ID、视图 ID、整条链接都不行',
        '还没共享给 integration —— 在 Notion 里打开它(或父页面)→ ••• → Connections → 加上这个 integration',
      ],
    });
    return { ok: false, fixable: false, workspace, database: null, schema: null, problems };
  }

  const database = {
    id: normalizeNotionId(raw.id) ?? raw.id,
    title: (raw.title ?? []).map((t) => t.plain_text).join('') || '(无标题)',
    url: raw.url ?? null,
  };
  const schema = pickGuideDbProperties(raw.properties);

  // When `pickGuideDbProperties` finds no title property it **silently falls back to 'Name'**, and
  // that name most likely does not exist in the user's database — so page creation gets a 400 from
  // Notion saying there is no such property. In practice every Notion database has exactly one
  // title property, so this branch will essentially never fire; it stays because when it does, the
  // 400 at write time gives no hint of the root cause
  const hasTitle = Object.values(raw.properties ?? {}).some((p) => p?.type === 'title');
  if (!hasTitle) {
    add(DB_PROBLEM.NO_TITLE_PROP, 'error', '这个库没有标题属性,建攻略页时会被 Notion 拒绝');
  }

  if (!schema.status) {
    // Legal, not an error: guides can still be created and checkboxes still ticked without a
    // status property. But it has to be **said** — quietly switching guide-status off leaves the
    // user watching guide statuses never update, with no explanation
    add(DB_PROBLEM.NO_STATUS_PROP, 'warn', '这个库没有状态属性,guide-status 那套没东西可写', {
      wanted: [...GUIDE_STATUS_OPTIONS],
    });
  } else {
    const missing = GUIDE_STATUS_OPTIONS.filter((o) => !schema.status.options.includes(o));
    if (missing.length) {
      add(DB_PROBLEM.MISSING_OPTIONS, 'error', `状态属性缺这些选项:${missing.join(' / ')}`, {
        property: schema.status.property,
        type: schema.status.type,
        missing,
        have: [...schema.status.options],
      });
    } else {
      /*
       * **A database can be complete and still out of date.** Everything built before colours and
       * the board view existed has all four options, so gating the repair on a missing option — as
       * `fixable` did — left exactly the users who need the migration with no button at all. That is
       * why this is its own problem code rather than an extension of MISSING_OPTIONS: the two have
       * different messages, and one of them is not a fault.
       *
       * **Severity is `warn`, and that is load-bearing.** `ok` counts errors, and the setup page
       * returns to the Dashboard when `ok` — a grey database works perfectly, generates guides and
       * ticks checkboxes, and blocking setup over how it looks would be the worse bug.
       *
       * Read from the property payload already in hand: no extra request runs on a page that is
       * merely being validated. The board view is not checked here for that reason — it costs a
       * call on the other API version, and the repair adds it regardless once pressed.
       */
      const rawStatus = Object.values(raw.properties ?? {}).find((p) => p?.type === schema.status.type);
      const opts = rawStatus?.[schema.status.type]?.options ?? [];
      const groupOf = Object.fromEntries(
        (schema.status.type === 'status' ? (rawStatus?.status?.groups ?? []) : []).flatMap((g) =>
          (g.option_ids ?? []).map((id) => [id, g.name])
        )
      );
      const wrongGroup =
        schema.status.type === 'status'
          ? opts
              .filter((o) => GUIDE_STATUS_STYLE[o.name] && groupOf[o.id] !== GUIDE_STATUS_STYLE[o.name].group)
              .map((o) => o.name)
          : [];
      const wrongColour = opts
        .filter((o) => GUIDE_STATUS_STYLE[o.name] && o.color !== GUIDE_STATUS_STYLE[o.name].color)
        .map((o) => o.name);

      /*
       * **One problem, because all of it is now repairable.** Colours were briefly reported
       * separately, on the finding that Notion refuses to change one — true of an *update*, and
       * `migrateGuideStatusColours` gets there by removing the option and creating it again. So
       * groups, colours and the board view are one thing again: 「这个库是早先建的」, with a button.
       *
       * Severity stays `warn`. `ok` counts errors and the setup page returns to the Dashboard when
       * `ok` — a grey database generates guides and ticks checkboxes perfectly, and blocking setup
       * over how it looks would be the worse bug.
       */
      if (wrongGroup.length || wrongColour.length) {
        // **Ask one question rather than reading out the checklist.** 「四个状态一个颜色、堆在一
        // 栏里,也没有看板视图」 is three of the program's own check items in a row, and the person
        // reading has to translate all three into the one thing they have to decide. There is only
        // one decision here, so ask only that.
        add(DB_PROBLEM.OUTDATED_FORMAT, 'warn', '这个库还是旧模版,要套用新的吗?', {
          property: schema.status.property,
          outdated: wrongGroup,
          colours: wrongColour,
        });
      }
    }
  }

  if (probeWrite && !problems.some((p) => p.severity === 'error')) {
    const probe = await probeGuideDbWrite(notion, database.id, schema);
    if (!probe.ok) {
      add(DB_PROBLEM.NO_WRITE, 'error', `建页试写没通过:${probe.error}`, {
        hint: '多半是这个 integration 只有读权限 —— 在 Notion 的 integration 设置里把 Insert content / Update content 打开',
      });
    }
    if (probe.strandedUrl) {
      add(DB_PROBLEM.STRANDED_PROBE_PAGE, 'warn', '试写的页面建出来了但没能归档,请手动删掉', {
        url: probe.strandedUrl,
      });
    }
  }

  return {
    ok: !problems.some((p) => p.severity === 'error'),
    // The two things `repairGuideDb` can act on. The rest are either a few clicks in Notion or a
    // different ID — marking those fixable too would produce a button that does nothing when
    // pressed. **OUTDATED_FORMAT belongs here even though it is only a warning**: it is the one
    // every pre-existing database raises, and it is the whole reason that button needs to appear
    fixable: problems.some(
      (p) => p.code === DB_PROBLEM.MISSING_OPTIONS || p.code === DB_PROBLEM.OUTDATED_FORMAT
    ),
    workspace,
    database,
    schema,
    problems,
  };
}

/**
 * Creates a page and immediately archives it, to prove that **writing** works.
 *
 * A read-only health check cannot detect "this integration only has read permission": every read
 * passes, the schema is entirely correct, and the 403 arrives at the first `guide-gen` page
 * creation — exactly the "only shows up at upload time" class this was meant to eliminate.
 *
 * It uses the real `createGuidePage` rather than a slimmed-down copy. The probe has to prove **the
 * downstream path** works (is the title property name right, is the status payload shape right),
 * not that "some page can be created".
 *
 * A status is written only when every option is present. Missing options are already reported
 * separately by the health check, and letting the probe fail for the same reason again would fuse
 * "no write permission" and "missing option" into a single error — elsewhere this project earns
 * its clear setup diagnostics precisely by pulling merged errors like that apart.
 *
 * Archiving sits in a `finally`: whatever throws along the way, the page is already created. And a
 * failure to delete has to be **said** — leaving a page in the user's database without a word is
 * worse than leaving one.
 */
export async function probeGuideDbWrite(notion, dbId, schema) {
  const status =
    schema?.status && GUIDE_STATUS_OPTIONS.every((o) => schema.status.options.includes(o))
      ? { ...schema.status, value: newGuideStatus(undefined) }
      : null;

  let page = null;
  try {
    page = await notion.createGuidePage({
      dbId,
      titleProperty: schema?.titleProperty ?? 'Name',
      title: `⚙️ 连接测试 ${new Date().toISOString()}(可删)`,
      status,
    });
  } catch (err) {
    return { ok: false, error: err.message, strandedUrl: null };
  }

  try {
    await notion.request('patch', `/pages/${page.id}`, { archived: true });
    return { ok: true, error: null, strandedUrl: null };
  } catch (err) {
    return { ok: true, error: null, strandedUrl: page.url ?? page.id, archiveError: err.message };
  }
}

/**
 * Recolours the four options this program owns, on a database that already has them.
 *
 * ## Why this is delete-and-recreate, and why that is the only way
 *
 * Measured against the live API on 2026-08-30, all with read-back:
 *
 * | Attempt | Result |
 * |---|---|
 * | PATCH an existing option's `color`, by id | `400 Cannot update color of select with id` |
 * | …by name instead | `400 Cannot update color of select with name` |
 * | **Rename** the option and add a fresh one | **200, and the rename silently did nothing** |
 * | Remove the option, then add it again with a colour | **200, and it works** |
 *
 * The third row is the trap: renaming answers 200 and changes nothing, so a migration built on it
 * would report success on a database it never touched — the exact failure this file keeps guarding
 * against. It is only visible by reading back.
 *
 * ## The window, and the snapshot that closes it
 *
 * Removing an option and re-adding it is **two requests, and they are not atomic**. In between,
 * every page that held one of those options displays `Not started`. Notion keeps the underlying
 * value — measured: all five pages returned to exactly their original status the moment the options
 * came back, including a hand-added `Paused` that was never touched — but a process that dies in
 * the middle leaves somebody looking at a guide database where every status appears wrong.
 *
 * So the statuses are **snapshotted before the first request**, and after the second every page is
 * compared against that snapshot; anything that did not come back is written back explicitly. With
 * the snapshot in hand the worst case is repairable rather than guessed at, which is the whole
 * precondition for doing this at all.
 *
 * **This is the one place in this file that is not strictly additive**, and the rule it departs
 * from is stated on `repairGuideDb` for a reason: Notion has no undo. It is here because the
 * alternative was telling every existing user to go and click four colours by hand.
 */
export async function migrateGuideStatusColours(notion, dbId, names) {
  if (!names.length) return { ok: true, recoloured: [], stillWrong: [], restored: [] };

  // Snapshot first. Everything below depends on this having succeeded
  const before = await notion.queryGuideDatabase(dbId);
  const wanted = new Set(names);

  const read = async () => {
    const props = (await notion.request('get', `/databases/${dbId}`)).properties ?? {};
    const entry = Object.entries(props).find(([, p]) => p?.type === 'status');
    return entry ? { property: entry[0], options: entry[1].status.options ?? [] } : null;
  };
  const write = (property, options) =>
    notion.request('patch', `/databases/${dbId}`, {
      properties: { [property]: { status: { options } } },
    });

  const start = await read();
  if (!start) return { ok: false, recoloured: [], stillWrong: [...names], restored: [], reason: 'no-status-prop' };

  // **Carry the survivors as {id, name}.** Their colour must not appear in the payload or the same
  // 400 comes back for them, and their group must not either, or they move
  const survivors = start.options.filter((o) => !wanted.has(o.name)).map((o) => ({ id: o.id, name: o.name }));
  await write(start.property, survivors);
  await write(
    start.property,
    survivors.concat([...wanted].map((name) => ({ name, ...GUIDE_STATUS_STYLE[name] })))
  );

  const after = await read();
  const nowColour = Object.fromEntries((after?.options ?? []).map((o) => [o.name, o.color]));
  const recoloured = [...wanted].filter((n) => nowColour[n] === GUIDE_STATUS_STYLE[n].color);
  const stillWrong = [...wanted].filter((n) => !recoloured.includes(n));

  // Every page back where it was, or put back by hand
  const now = await notion.queryGuideDatabase(dbId);
  const nowStatus = Object.fromEntries(now.map((p) => [p.id, p.status]));
  const restored = [];
  for (const page of before) {
    if (!page.status || nowStatus[page.id] === page.status) continue;
    await notion.setPageStatus(page.id, { property: start.property, type: 'status', value: page.status });
    restored.push(page.title || page.id);
  }

  return { ok: stillWrong.length === 0, recoloured, stillWrong, restored };
}

/**
 * Adds the missing status options to the user's existing database.
 *
 * ## Why "try it and read it back" rather than deciding up front whether it can be changed
 *
 * Notion **has a precedent for silently ignoring** writes to a status property: `groups` is HTTP
 * 200 and unchanged whether passed at creation or PATCHed afterwards (all three payload shapes
 * tried, see the block above `createGuideDatabase`). So the most dangerous failure here is not
 * "cannot be changed" but **"reported success, changed nothing"** — the user presses the button,
 * sees success, and is stopped by the same check on their next `guide-gen`.
 *
 * So this does not predict whether Notion will allow the change: it sends it, **reads it back**,
 * compares what actually landed and reports the facts — the same rule as `createGuideDatabase`
 * verifying by read-back instead of trusting a 200.
 *
 * **Measured: `options` can be added.** A status property was created against the real API without
 * specifying options (what came back was exactly Notion's own three: `Not started` / `In progress`
 * / `Done`), `Staged` was PATCHed in, the read-back had all four, and the existing three kept
 * their ids and colours. So the most common situation — somebody who built the database by hand
 * and is only missing `Staged` — really is repairable by 「帮我补上」.
 *
 * **But the read-back cannot be deleted because of that.** `groups` on the same property is still
 * silently ignored, which means "does a write to a status property take effect" holds per field
 * rather than as one blanket conclusion; and the most expensive failure here (reported repaired,
 * actually untouched) is precisely the one only the read-back can block. The `silently-ignored`
 * branch is now unreachable; keeping it costs a few lines, and deleting it would turn a known
 * failure mode back into a silent one.
 *
 * ## Additive only
 *
 * Existing options are carried across with their ids and colours untouched, and new ones only
 * appended. That is the precondition for letting this write to the user's database at all: adding
 * an option is additive, renaming or deleting someone else's option is not — and Notion has no
 * undo.
 *
 * ## Bringing an older database up to the current format
 *
 * A database created before colours and the board view existed is **not** repaired by adding
 * options — it already has all four. Three things can be out of date, and they are not equally
 * fixable. All three were measured against the real API on 2026-08-30:
 *
 * | | Fixable on an existing database | Why |
 * |---|---|---|
 * | Group assignment | **Yes** | `group` per option in a PATCH: HTTP 200, read-back correct |
 * | Board view | **Yes** | The views API works on any database, not only a new one |
 * | Option colour | **No** | `400 Cannot update color of select with id: …` |
 *
 * **The colour is a hard limit, not a missing feature.** Both routes were tried: options carrying
 * their `id`, and options keyed by `name` alone. Both are refused with the same 400. The only ways
 * to recolour are deleting and recreating the option — which would drop that status from every page
 * that holds it — or two clicks per option in the Notion UI. So this function **reports the colours
 * it cannot change and names them**, rather than skipping them quietly or pretending the repair was
 * complete. New options it adds do get their colour, because a new option is not an update.
 *
 * Options the user added themselves keep their colour *and* their group: they are carried across as
 * `{id, name}` with no `group` field, and Notion's documented behaviour for an omitted `group` on
 * update is to leave the existing one alone — confirmed by read-back, a hand-added `Paused` stayed
 * where it was while the four owned options moved.
 */
export async function repairGuideDb(notion, dbId) {
  const raw = await notion.request('get', `/databases/${dbId}`);
  const entries = Object.entries(raw.properties ?? {});
  const found =
    entries.find(([, p]) => p?.type === 'status') ?? entries.find(([, p]) => p?.type === 'select');
  if (!found) {
    return { ok: false, type: null, property: null, added: [], stillMissing: [...GUIDE_STATUS_OPTIONS],
      reason: 'no-status-prop' };
  }

  const [property, prop] = found;
  const type = prop.type;
  const existing = prop[type]?.options ?? [];
  const have = existing.map((o) => o.name);
  const missing = GUIDE_STATUS_OPTIONS.filter((o) => !have.includes(o));

  // Which of the four we own are the wrong colour. Reported, never written — see the table above
  const wrongColour = existing
    .filter((o) => GUIDE_STATUS_STYLE[o.name] && o.color !== GUIDE_STATUS_STYLE[o.name].color)
    .map((o) => o.name);

  // Which are in the wrong board column. Only a status property has groups; a select has none, and
  // asking about them there would invent a fault that cannot exist
  const groupOfOption = Object.fromEntries(
    (type === 'status' ? (prop.status.groups ?? []) : []).flatMap((g) =>
      (g.option_ids ?? []).map((id) => [id, g.name])
    )
  );
  const wrongGroup =
    type === 'status'
      ? existing
          .filter((o) => GUIDE_STATUS_STYLE[o.name] && groupOfOption[o.id] !== GUIDE_STATUS_STYLE[o.name].group)
          .map((o) => o.name)
      : [];

  // The board is worth adding even when the options are already perfect, which is exactly the
  // older-database case — so it is attempted before any early return, and like everywhere else a
  // failed view never fails the repair
  const boardView = await notion.ensureGuideBoardView(dbId).catch((err) => ({
    ok: false,
    created: false,
    error: String(err.message ?? err),
  }));

  // Colours are their own operation because they are the only part that is not additive — see
  // migrateGuideStatusColours. Like the board, a failure is reported and never thrown: a database
  // whose groups were just put right must not come back as a failed repair over a colour
  const colour =
    type === 'status' && wrongColour.length
      ? await migrateGuideStatusColours(notion, dbId, wrongColour).catch((err) => ({
          ok: false,
          recoloured: [],
          stillWrong: [...wrongColour],
          restored: [],
          error: String(err.message ?? err),
        }))
      : { ok: true, recoloured: [], stillWrong: [], restored: [] };

  if (!missing.length && !wrongGroup.length) {
    // The colours were already dealt with above, so this early return is only skipping the option
    // PATCH — it is not skipping the work
    return {
      ok: true, type, property, added: [], stillMissing: [], clobbered: [],
      regrouped: [], wrongColour, colour, boardView, reason: 'nothing-to-do',
    };
  }

  await notion.request('patch', `/databases/${dbId}`, {
    properties: {
      [property]: {
        [type]: {
          options: [
            // **`{id, name}` and never the whole option object.** Carrying `color` across is what
            // earns the 400 above, even when the value is identical to what is already there
            ...existing.map((o) =>
              type === 'status' && GUIDE_STATUS_STYLE[o.name]
                ? { id: o.id, name: o.name, group: GUIDE_STATUS_STYLE[o.name].group }
                : { id: o.id, name: o.name }
            ),
            // New options are not updates, so these may carry colour — and a status property takes
            // the group here too, which saves a second pass
            ...missing.map((name) =>
              type === 'status'
                ? { name, ...GUIDE_STATUS_STYLE[name] }
                : { name, color: GUIDE_STATUS_STYLE[name].color }
            ),
          ],
        },
      },
    },
  });

  // Read back. **This step is the whole point of the function** — the PATCH above returning 200
  // means nothing
  const afterRaw = (await notion.request('get', `/databases/${dbId}`)).properties;
  const after = pickGuideDbProperties(afterRaw);
  const now = after.status?.options ?? [];

  // Same read-back rule for the groups: the PATCH returning 200 says nothing about whether the
  // reassignment landed, and this is the field with the longest history of being ignored
  const afterProp = Object.values(afterRaw ?? {}).find((p) => p?.type === type);
  const afterGroupOf = Object.fromEntries(
    (type === 'status' ? (afterProp?.status?.groups ?? []) : []).flatMap((g) =>
      (g.option_ids ?? []).map((id) => [id, g.name])
    )
  );
  const afterIdOf = Object.fromEntries(
    (afterProp?.[type]?.options ?? []).map((o) => [o.name, o.id])
  );
  const regrouped = wrongGroup.filter(
    (name) => afterGroupOf[afterIdOf[name]] === GUIDE_STATUS_STYLE[name].group
  );
  const stillWrongGroup = wrongGroup.filter((name) => !regrouped.includes(name));
  const added = missing.filter((o) => now.includes(o));
  const stillMissing = missing.filter((o) => !now.includes(o));

  // Not one of the existing options may go missing. A missing one means we overwrote somebody
  // else's options, which is far worse than failing to repair
  const clobbered = have.filter((o) => !now.includes(o));

  return {
    // **A colour that cannot be changed is not a failed repair.** Notion refuses it outright; the
    // honest report is "repaired, and here is what only you can do in the UI", not a red result for
    // something the program was never able to do
    ok: stillMissing.length === 0 && clobbered.length === 0,
    type,
    property,
    added,
    stillMissing,
    clobbered,
    regrouped,
    stillWrongGroup,
    wrongColour,
    colour,
    boardView,
    reason: clobbered.length
      ? 'clobbered'
      : stillMissing.length
        ? 'silently-ignored'
        : 'repaired',
  };
}
