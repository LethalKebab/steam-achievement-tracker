/**
 * The lines printed to a terminal
 * ------------------------------------------------
 * Separate from `lib/messages.js` **because the audience is different, and one of the project's
 * rules turns on exactly that difference**: CLAUDE.md forbids a message that can reach the
 * Dashboard from carrying a command line, because the packaged app's user has no terminal to run it
 * in. `cli-hints.test.js` enforces that across `lib/`, with `TERMINAL_ONLY` naming the files whose
 * strings only ever reach a terminal.
 *
 * `serve`'s own log and the CLI's output are exactly that audience: whoever reads them typed a
 * command to get here, so 「跑 `node tracker.js log` 看原因」 is the most useful thing to say. Put in
 * `messages.js` those same sentences would be one Dashboard code path away from telling somebody
 * with no terminal to open one — so they live here, and this file is on the exemption list.
 *
 * The language is not separate. There is one interface language per process, and it is
 * `messages.js` that holds it; this file reads it rather than keeping a second copy that could
 * disagree.
 */
import { messageLanguage } from './messages.js';

export const CLI_MESSAGES = {
  // ---- serve's own log --------------------------------------------------------
  'srv.apiError':         ['[api] {method} 出错: {reason}', '[api] {method} failed: {reason}'],
  'srv.httpError':        ['[http] {method} {url} 出错: {reason}', '[http] {method} {url} failed: {reason}'],
  'srv.guidesLocal':      ['攻略(本地):登记 {n} 条 —— {names}', 'Guides (local): registered {n} — {names}'],
  'srv.guidesNotion':     ['攻略(Notion):新登记 {n} 条 —— {names}', 'Guides (Notion): registered {n} new — {names}'],
  'srv.guidesNotionNone': ['攻略(Notion):数据库里 {n} 个页面,没有新的要登记。', 'Guides (Notion): {n} pages in the database, nothing new to register.'],
  'srv.guidesUnreadable': ['⚠️  {n} 个攻略页面读不出来:{titles}', '⚠️  {n} guide pages could not be read: {titles}'],
  'srv.guidesFailed':     ['⚠️  攻略发现失败(不影响 Dashboard 和成就同步):{reason}', '⚠️  Guide discovery failed. The Dashboard and achievement syncing are unaffected: {reason}'],
  'srv.subStep':          ['子步骤', 'sub-step'],
  'srv.autoTicked':       ['✅ 自动勾选 {n} 个 checkbox:{names}', '✅ Ticked {n} checkboxes automatically: {names}'],
  'srv.autoTickNone':     ['自动勾选:查了 {n} 款有变化的游戏,没有要勾的框。', 'Automatic ticking: checked {n} changed games, nothing to tick.'],
  'srv.autoTickFailed':   ['⚠️  {n} 个框没勾上,跑 `node tracker.js log` 看原因。', '⚠️  {n} boxes were not ticked. Run `node tracker.js log` to see why.'],
  'srv.autoTickError':    ['⚠️  自动勾选失败(成就数据已同步完成,不受影响):{reason}', '⚠️  Automatic ticking failed. The achievement data synced fine and is unaffected: {reason}'],
  'srv.statusDone':       ['✅ 攻略状态标为 Done:{names}', '✅ Guide status set to Done: {names}'],
  'srv.statusStaged':     ['↩️  掉出 100%,攻略状态退回 Staged:{names}', '↩️  Dropped below 100%, guide status back to Staged: {names}'],
  'srv.statusFailed':     ['⚠️  {n} 个攻略页状态没改成,跑 `node tracker.js log` 看原因。', '⚠️  {n} guide pages did not change status. Run `node tracker.js log` to see why.'],
  'srv.statusError':      ['⚠️  攻略状态同步失败(不影响成就数据和勾选):{reason}', '⚠️  Guide-status syncing failed. Achievement data and ticking are unaffected: {reason}'],
  'srv.queued':           ['🕒 排队等生成:{game}({appid}),队列第 {n} 个', '🕒 Queued for generation: {game} ({appid}), position {n}'],
  'srv.queueDropped':     ['⚠️ 供应商不可用,取消了排队中的 {n} 个:{names}', '⚠️ The provider is unavailable; {n} queued jobs were cancelled: {names}'],
  'srv.startPatch':       ['🤖 开始局部重写:{game}({appid})· {selector}', '🤖 Rewriting part of {game} ({appid}) · {selector}'],
  'srv.startGen':         ['🤖 开始生成攻略:{game}({appid})', '🤖 Generating a guide for {game} ({appid})'],
  'srv.chunkFailed':      ['⚠️ 第 {chunk}/{of} 段({count} 个成就)未生成:{reason}', '⚠️ Part {chunk} of {of} ({count} achievements) was not generated: {reason}'],
  'srv.patchDone':        ['✅ 局部重写完成:改了 {n} 条 → {url}', '✅ Partial rewrite finished: {n} changed → {url}'],
  'srv.patchFailed':      ['⚠️ 局部重写没过校验,原攻略未改动:{url}', '⚠️ The partial rewrite did not pass the checks; the guide is untouched: {url}'],
  'srv.genDone':          ['✅ 攻略写完:{url}', '✅ Guide written: {url}'],
  'srv.genDraft':         ['⚠️ 攻略没过校验,草稿留在 {path}', '⚠️ The guide did not pass the checks. The draft is at {path}'],
  'srv.patchError':       ['❌ 局部重写失败:{reason}', '❌ The partial rewrite failed: {reason}'],
  'srv.genError':         ['❌ 攻略生成失败:{reason}', '❌ Guide generation failed: {reason}'],
  'srv.sectionsFailed':   ['⚠️ 读小节结构失败({game}),挑选列表退回平铺:{reason}', '⚠️ Could not read the section structure for {game}; the picker falls back to a flat list: {reason}'],
  'srv.syncDone':         ['✅ 后台同步完成:新增 {added} 款,刷新成就 {updated} 款,成就详情 {schema} 款', '✅ Background sync finished: {added} added, {updated} achievement counts refreshed, {schema} achievement details'],
  'srv.syncSample':       ['   查了 {total} 款(玩过 {played} / 不在 owned {unowned} / 轮换复查 {swept}){pending}', '   Checked {total} ({played} played / {unowned} not owned / {swept} on rotation){pending}'],
  'srv.syncPending':      [',还有 {n} 款排队等下次', ', {n} more queued for next time'],
  'srv.syncBumped':       ['   🆕 成就总数变多了(游戏更新):{names}', '   🆕 The achievement total rose — a game update: {names}'],
  'srv.syncError':        ['❌ 后台同步失败:{reason}', '❌ Background sync failed: {reason}'],
  'srv.startupError':     ['⚠️  启动任务出错:{reason}', '⚠️  A startup job failed: {reason}'],
  'srv.freshEnough':      ['数据是 {hours} 小时前同步的(阈值 {threshold}h),这次不自动同步。', 'The data was synced {hours} hours ago (threshold {threshold}h), so nothing is synced automatically this time.'],
  'srv.skipAutoSync':     ['⚠️  {reason},跳过自动同步。', '⚠️  {reason}. Skipping the automatic sync.'],
  'srv.staleStartSync':   ['数据已经 {hours} 小时没更新,开始后台同步…', 'The data is {hours} hours old; starting a background sync…'],
  'srv.firstSync':        ['还没有同步记录,开始首次同步…', 'There is no sync on record; starting the first one…'],
  'srv.listening':        ['\n  Dashboard → http://127.0.0.1:{port}\n  停止:Ctrl+C\n', '\n  Dashboard → http://127.0.0.1:{port}\n  Stop: Ctrl+C\n'],
};

/** One terminal line. Same shape as `msg`, reading the same language it holds */
export function clog(key, values) {
  const pair = CLI_MESSAGES[key];
  if (!pair) return key;
  let s = pair[messageLanguage() === 'en' ? 1 : 0] || pair[0];
  if (values) for (const k in values) s = s.split('{' + k + '}').join(values[k]);
  return s;
}
