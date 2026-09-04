/**
 * Reading and writing the configuration
 * ------------------------------------------------
 * Secrets live in config.json at the project root (already in .gitignore), never in source.
 * Environment variables take precedence, which makes a temporary override easy:
 * STEAM_API_KEY / STEAM_ID / NOTION_TOKEN.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { msg } from './messages.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ROOT is "where the code is" and always follows the copy currently running (the source directory,
// or resources/tracker in a packaged build) — Dashboard.html / Setup.html / lib/rpc.js must keep
// being read from here, and reading them elsewhere would mean running one copy of the code while
// displaying another. DATA_ROOT is "where the data is", equal to ROOT by default but separately
// redirectable with TRACKER_DATA_DIR — the launcher uses it to point a packaged build at an
// existing CLI installation, rather than letting the packaged folder grow its own data.
// Only a machine-specific config that never enters the repository (launcher/local.config.json) sets
// that variable; a build distributed to anyone else never does, and behaves exactly as it would
// without it.
export const DATA_ROOT = process.env.TRACKER_DATA_DIR ? resolve(process.env.TRACKER_DATA_DIR) : ROOT;
export const CONFIG_PATH = join(DATA_ROOT, 'config.json');

const DEFAULTS = {
  steamApiKey: '',
  steamId: '',
  // Language: affects the game and achievement names Steam returns
  language: 'schinese',
  // The language the **interface** is in — 'zh' or 'en'. A different question from `language`
  // above, and deliberately a different key: that one decides what gets fetched and stored, so
  // changing it makes the data on disk the wrong language and needs a full re-sync to undo. This
  // one only chooses between two things already stored, and needs no network at all.
  // Set from /setup; see lib/lang.js
  uiLanguage: 'zh',
  port: 8777,
  // On serve startup, sync in the background once if the data is older than this many hours (0 means never sync automatically)
  syncStaleHours: 12,
  // On serve startup, also discover new guide pages once (Notion plus local guides/). Set false to disable
  syncGuidesOnServe: true,
  // After serve startup and after 「立即同步」 completes, tick checkboxes for the games this run
  // changed. This is the only place that **writes to Notion without a --dry-run in front of it**,
  // hence the switch: set false if the ticking looks wrong, returning to "only a manual
  // checkbox-sync writes".
  checkboxSyncOnServe: true,
  // Whether automatic ticking cascades into nested sub-steps. Off by default, deliberately unlike
  // the CLI's default of on: the cascade is the one place in the project that prefers over-ticking,
  // it ticks wrongly for any-of achievements, and the automatic path has no --dry-run as a human
  // gate. Run checkbox-sync by hand when sub-steps are wanted.
  checkboxSyncOnServeCascade: false,
  // After serve startup and after 「立即同步」 completes, mark completed games' Notion guide pages
  // Done. It converges on **current state** rather than catching the instant a game happens to
  // complete — that instant exists once, and missing it cannot be made up. Set false to disable.
  guideStatusOnServe: true,
  // The interval between calls to the official Web API (api.steampowered.com), which carries the
  // vast majority of a sync's requests. Measured once: GetPlayerAchievements, 400 consecutive
  // requests at 0 ms, 11/s sustained for 36 seconds, with not a single 429 — so 100 ms already
  // carries a factor-of-two margin. Raise it if 429s become frequent
  requestDelayMs: 100,
  // The interval for the store endpoints (store.steampowered.com: appdetails, store page HTML,
  // search).
  // **Separate from the above, because that route is far stricter and answers abuse with an
  // IP-level block rather than a key-level limit.**
  // There is no measurement for this one — hammering the store to establish a number is
  // disproportionate in risk to what it would buy.
  // It is only reached by name lookup, cover art and search, far less often than the Web API, so
  // being slower here does not affect sync duration
  storeRequestDelayMs: 300,
  // --- Sampling for the automatic sync when the Dashboard opens (the CLI's `sync` is unaffected and always full) ---
  // How many "not played but worth confirming" games each automatic sync re-checks. 0 disables the
  // rotating sweep (with it off, a developer adding achievements is only noticed the next time you play that game)
  sweepBudget: 120,
  // The longest a game may go without being reconciled against Steam. Past that it joins the sweep queue
  maxStatsAgeDays: 7,
  // A shorter deadline for completed games (100%): more achievements drops them below 100%, and that is the event most worth hearing about promptly
  perfectGameMaxAgeDays: 3,
  dbPath: 'data/steam.db',
  guidesDir: 'guides',
  notion: {
    token: '',
    // The ID of the Notion database holding the guide pages (open that database; it is the 32 hex characters in the URL)
    overviewDbId: '',
  },
  // --- AI guide generation (see docs/ai-guide-writing.md). Leave all of it blank if unused ---
  ai: {
    // 'anthropic' | 'deepseek' | 'deepseek-openai'
    //   anthropic — has server-side web search and can write researched guides
    //   deepseek — DeepSeek's Anthropic-compatible endpoint; **also has server-side web search**
    //   deepseek-openai — the same vendor on its OpenAI-compatible endpoint, **no web access**;
    //     suitable only for exercising the pipeline itself, and guide-gen refuses it by default
    provider: 'anthropic',
    // **Each vendor gets its own apiKey / model / baseUrl.**
    //
    //   "providers": {
    //     "anthropic": { "apiKey": "sk-ant-…", "model": "claude-opus-5" },
    //     "deepseek":  { "apiKey": "sk-…",     "model": "", "baseUrl": "" }
    //   }
    //
    // These three fields originally had one slot each, so "try a
    // different vendor" had no safe spelling: the settings page required re-pasting the key every
    // time, and the CLI's `--provider` did not even refuse — it flipped the provider, kept the
    // previous vendor's key and sent it, in exchange for "check ANTHROPIC_API_KEY" about a variable
    // that was perfectly correct. **An error pointing the wrong way costs more time than no error.**
    //
    // **What belongs here is measured, not asserted: read by more than one vendor, with a different
    // correct value for each.** Only these three qualify. `maxTokens` / `effort` / `chunkSize` and
    // the like are cross-vendor budgets (the same value is right everywhere) and stay at the outer
    // level; `webFetch` / `searchTool` / `anthropicExtras` are read by exactly one
    // vendor, so a leftover value is ignored rather than misapplied, and they stay outer too.
    //
    // One alias collapses: deepseek-openai → deepseek (the same vendor's other endpoint, the same
    // configuration). The resolution order is in resolveAiKey
    providers: {},
    // **The legacy flat slots, belonging only to the `provider` above.** In an older config they
    // necessarily hold that vendor's values, so falling back to them for that vendor is correct;
    // for any other vendor there is **no fallback** — that is the bug described above.
    // A new config only needs `providers`; these two fields remain so that an old config needs no edits
    //
    // The environment variables ANTHROPIC_API_KEY / DEEPSEEK_API_KEY work too,
    // **looked up by the vendor being asked for**, and they override both places in the file
    apiKey: '',
    // **Left empty by default so each vendor uses its own default model.** No concrete name can go
    // here: model names are vendor-specific (claude-* / deepseek-*), and putting an
    // Anthropic name here guarantees that anyone switching provider without also editing model hits
    // "the provider and the model disagree".
    // Fill it to pin a version; run `node tracker.js ai-check --models` to see what is available
    model: '',
    // **The depth control, and the only genuinely effective speed lever on this path.**
    // 'low' | 'medium' | 'high' | 'off'
    //
    // **It must be sent separately from `thinking`.** Bundled onto `anthropicExtras` it is a dead
    // control: that switch is always false when baseUrl is set, and the `provider: "deepseek"`
    // preset always sets baseUrl.
    //
    // Measured (DeepSeek /anthropic, the same 10-achievement shard, with web tools):
    //
    //   nothing sent  337 s  8 searches  255 chars/achievement   ← what ran while it could not be sent
    //   high          (not measured separately; the previous default on the official endpoint)
    //   medium        219 s  6 searches  275 chars/achievement
    //   low            43 s  2 searches  211 chars/achievement
    //
    // **Thinking volume, search count and characters per achievement all move together** — this is
    // one control, not three.
    // The research depth given up by lowering it is visible: `searchQueries` is printed on both the
    // CLI and the Dashboard on every generation ("can search ≠ did search"). So this is not a silent
    // degradation but a trade-off with numbers the user can read.
    //
    // **Do not trust the absolute figures.** The same 10 achievements with nothing sent took
    // 76 / 174 / 337 seconds across three runs — more variance than there is between the tiers. What
    // is trustworthy is a **ratio** measured back to back within one batch.
    //
    // Whether it is sent depends on whether the endpoint accepts it, per the measured table in
    // ai-anthropic.js; anything not in that table is sent nothing.
    effort: 'high',
    // The thinking field: 'adaptive' | 'disabled' | 'off' (send nothing). adaptive is sent by
    // default only on the official endpoint.
    //
    // **'disabled' is absurdly fast (6 s against 337 s) and turns off web search along with it** —
    // measured twice at 0 searches, i.e. the model writes the guide from memory, which is exactly
    // what the canSearch admission design guards against.
    // It stays here so it can be configured, not as "a faster high". For speed, adjust effort.
    //
    // And **never rely on budget_tokens**: DeepSeek's /anthropic accepts it, returns 200, and then
    // moves in the opposite direction (asking for 2000 produced 49,653 characters of thinking and
    // asking for 8000 produced 62,107, both more than sending nothing).
    // So buildBody never sends it
    thinking: null,
    // The **combined** ceiling for thinking plus prose, not a prose ceiling. Too low and the writing
    // is truncated partway, and a truncated guide is worse than a failed generation (the validator
    // cannot detect that the second half was never written)
    maxTokens: 32000,
    // Refuse to generate above this many achievements. **This ceiling governs how long it runs and
    // how much it costs, not what is technically writable** — anything over one shard's worth is
    // written in shards automatically (chunkDefs in guidegen.js).
    // The largest game in the library has 408 achievements, so 500 leaves some headroom
    maxAchievements: 500,
    // The **maximum** number of achievements per shard. The reason for sharding is not that the list
    // does not fit (the list is small) but that **the prose does not**: an achievement's three-part
    // entry is around 150 characters, so 400 of them is 60,000 characters, past every vendor's
    // single-response ceiling. And exceeding it raises no error — the validator merely reports that
    // every achievement in the second half is missing a checkbox
    //
    // A ceiling, not a fixed length: the program computes the shard count from this number and then
    // **spreads** the achievements evenly across them (55 achievements at 50 is 28+27, not 50+5). So
    // lowering it lowers the ceiling on one shard's prose, and the shard count only rises as needed.
    // See chunkDefs in guidegen.js
    chunkSize: 50,
    // How many feedback rewrite rounds at most when validation fails. Still failing, it is kept as a
    // draft with a report of which entries failed — discarding burns the money and the time and
    // leaves nothing, while "which entry failed" carries information
    maxRounds: 3,
    // **How many shards the first round writes concurrently.** The shards' contents are disjoint
    // with no ordering dependency — they could only queue because the whole guide shared one session
    // (one session is one chain). With a chain per shard, a four-shard game's first round goes from
    // "the sum of the shards" to "the slowest shard".
    //
    // First round only. Later rounds are targeted re-asks, usually of one or two shards, and a shard
    // that was split shares its parent's session — concurrency would have two requests writing one
    // messages array. Small gain, dirty failure mode, so those rounds stay sequential (see the
    // comment in guidegen.js).
    //
    // 3 is conservative. Raising it mainly consumes the vendor's rate-limit allowance, and hitting a
    // 429 takes the maxRetries backoff path rather than losing a shard. Setting 1 returns entirely to
    // the old sequential behaviour, which is useful when diagnosing
    concurrency: 3,
    // **How many searches at most within one request.** This is the primary constraint on guide
    // depth: measured, 6 searches across 51 achievements (one search per 8.5 achievements) produced
    // notes of a few dozen characters each, with the hard achievements not covered at all.
    // Guide generation is a case where more searching is worth more than less — one search is far
    // cheaper than a paragraph of invention
    //
    // **Do not add a monetary ceiling here.** Vendor rates change, we cannot verify them, and how
    // the search tool bills has never been measured — any "ceiling" would rest on an amount we do
    // not believe ourselves, handing the user controls they have no basis for setting and merely
    // transferring the uncertainty. To genuinely control spend, maxSearches / maxTokens / maxRounds
    // already work, and they measure something real.
    maxSearches: 30,
    maxFetches: 10,
    // The maximum tokens fetched back from one page. A large wiki page of the kind SKILL.md 8.3
    // describes needs this raised, though the actual ceiling has never been measured (one of the
    // spike's three unverified items)
    maxFetchTokens: 50000,
    // Non-empty = **hard-restrict** search to these domains. Empty by default: how well Chinese
    // guide sites are actually covered in the search index has never been measured, and locking it
    // down first trades quality for an unverified assumption. To bias toward Chinese sites, say so
    // in the prompt
    allowedDomains: [],
    // The pause_turn continuation ceiling (reached when the server-side tool loop hits its iteration cap)
    maxContinuations: 5,
    maxRetries: 3,
    // With high effort and web research, a single request taking minutes is normal; do not set this like an ordinary HTTP timeout
    requestTimeoutMs: 600000,
    // When the safety classifier refuses, have the server retry the same request with a different
    // model. This requires an extra beta header, and an account that does not recognise it 400s the
    // whole request — the error message says to turn this off
    fallbacks: true,
    // Stream the thinking summary as well. Useful when diagnosing "the model went quiet for four minutes"; normally off
    showThinking: false,

  },
};

/** Deep merge: merge plain objects only; arrays and scalars overwrite */
// ---------------------------------------------------------------------------
// AI keys: one slot per vendor
// ---------------------------------------------------------------------------

/** Each vendor's environment variable name. **This table is looked up by the vendor being asked for**, not by the one named in the config */
export const AI_KEY_ENV = {
  anthropic: 'ANTHROPIC_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

/**
 * Collapse provider aliases to one vendor.
 *
 * `deepseek-openai` is DeepSeek's other endpoint — **a different endpoint with the same key**, so
 * two slots would only mean pasting it twice.
 *
 * **An unrecognised name is returned unchanged rather than guessed at.** Self-hosted endpoints and
 * proxy services can be called anything, and the cost of a wrong guess is reading a non-existent
 * environment variable, which is far harder to diagnose than "I do not recognise this vendor".
 */
export function canonicalAiProvider(provider) {
  const p = String(provider ?? '').toLowerCase();
  if (p === 'deepseek-openai') return 'deepseek';
  return p;
}

/**
 * The three fields that hold one value per vendor. **This list is measured**: read by more than one
 * vendor, with a different correct value for each. `baseUrl` is on it because both anthropic and
 * deepseek read it, and giving anthropic the address of a DeepSeek-compatible endpoint means
 * sending requests to somebody else's address.
 */
export const VENDOR_SCOPED_AI_FIELDS = ['apiKey', 'model', 'baseUrl'];

/**
 * Take one field from a vendor's own slot, falling back to the legacy flat field.
 *
 * The fallback has a hard condition: **it only applies when the vendor being asked for is the one
 * `ai.provider` names.** An older config's flat slot necessarily holds that provider's values, so
 * falling back for it is correct; using it for another vendor is the "DeepSeek's key is sent to
 * api.anthropic.com" bug — whose 401 reads "check ANTHROPIC_API_KEY", pointing at a variable that
 * was already set correctly. **Returning empty is preferable**: empty reaches HINTS.ai, which can
 * state which vendor is unconfigured.
 */
function vendorField(ai, want, field) {
  const pick = (v) => String(v ?? '').trim();
  const slot = pick(ai?.providers?.[want]?.[field]);
  if (slot) return slot;
  if (want && canonicalAiProvider(ai?.provider) === want) return pick(ai?.[field]);
  return '';
}

/**
 * Get one vendor's key. In order: **environment variable → `ai.providers[vendor].apiKey` → legacy `ai.apiKey`**.
 *
 * All three sources are `trim()`ed: a copy-paste carrying a newline is the commonest cause of a 401,
 * and missing any one source would make this protection hold only for some spellings.
 */
export function resolveAiKey(ai, provider, env = process.env) {
  const want = canonicalAiProvider(provider);
  const envName = AI_KEY_ENV[want];
  const fromEnv = String(env?.[envName] ?? '').trim();
  if (envName && fromEnv) return fromEnv;
  return vendorField(ai, want, 'apiKey');
}

/**
 * Switch vendor: **the provider and its whole set move together**, returning a new object without
 * modifying the original.
 *
 * `applyAiFlags` previously moved only two thirds of it — flipping the provider and clearing the
 * model while leaving the key in place. And what `model` needs is not to be cleared but to be
 * replaced with that vendor's own: carrying the previous vendor's model name (claude-* /
 * deepseek-*) across trips `assertModelMatchesProvider`, while **clearing it unconditionally has its
 * own cost** — a version pinned for Anthropic disappears after switching away and back, without
 * an error, quietly reverting to the default. Storing one per vendor removes both problems at once.
 *
 * Cross-vendor budget controls (maxTokens / effort / chunkSize …) are carried across unchanged — the
 * same value is correct for every vendor.
 */
export function switchAiProvider(ai, provider, env = process.env, { model } = {}) {
  const want = canonicalAiProvider(provider);
  return {
    ...ai,
    provider,
    apiKey: resolveAiKey(ai, provider, env),
    model: model ?? vendorField(ai, want, 'model'),
    baseUrl: vendorField(ai, want, 'baseUrl'),
  };
}

/**
 * Attribute the legacy flat fields to their real owner.
 *
 * **This must run before any provider override (AI_PROVIDER / `--provider`) takes effect.** The flat
 * slots' owner is **the provider written in the file**, and overriding before attributing means
 * treating the previous vendor's key as the new vendor's — the very bug this change set exists to
 * fix, merely growing back in a different place.
 */
function adoptLegacyAiFields(ai) {
  const own = canonicalAiProvider(ai?.provider);
  if (!own) return ai;
  const slot = { ...(ai?.providers?.[own] ?? {}) };
  const out = { ...ai };
  for (const f of VENDOR_SCOPED_AI_FIELDS) {
    if (!String(slot[f] ?? '').trim() && String(ai?.[f] ?? '').trim()) slot[f] = String(ai[f]).trim();
    // **After attribution the flat field must be cleared.** Left in place it becomes an ownerless
    // value: the moment `AI_PROVIDER` on the next line changes `provider`, `vendorField`'s legacy
    // fallback would consider it to belong to the **new** vendor — which is exactly how DeepSeek's
    // key gets taken for Anthropic's, the bug being fixed growing back elsewhere. Cleared, there is
    // exactly one owner: the slot just written
    out[f] = '';
  }
  return { ...out, providers: { ...(ai?.providers ?? {}), [own]: slot } };
}

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(base[k] ?? {}, v) : v;
  }
  return out;
}

export function loadConfig({ required = [] } = {}) {
  let onDisk = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      onDisk = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      throw new Error(msg('config.badJson', { reason: err.message }));
    }
  }

  const cfg = merge(DEFAULTS, onDisk);
  if (process.env.STEAM_API_KEY) cfg.steamApiKey = process.env.STEAM_API_KEY;
  if (process.env.STEAM_ID) cfg.steamId = process.env.STEAM_ID;
  if (process.env.NOTION_TOKEN) cfg.notion.token = process.env.NOTION_TOKEN;
  // provider and model can be overridden by environment variables too. **This must come before the
  // key is read** — which key to read is decided by the provider, and the wrong order produces
  // "AI_PROVIDER=deepseek is set and it is still looking for ANTHROPIC_API_KEY".
  // These two are what make it possible to try a new vendor without touching config.json at all:
  //   AI_PROVIDER=deepseek DEEPSEEK_API_KEY=... node tracker.js ai-check --models
  // **Attribution comes before the override** — see the note atop adoptLegacyAiFields; the wrong
  // order grows the bug back
  cfg.ai = adoptLegacyAiFields(cfg.ai);
  if (process.env.AI_PROVIDER) cfg.ai.provider = process.env.AI_PROVIDER;

  // **Flatten the current vendor's apiKey / model / baseUrl onto `cfg.ai` so nothing downstream has
  // to change.** Several vendors can be configured at once without interfering; `ai.providers` is
  // left intact, as the settings page needs it to know which vendors are configured
  cfg.ai = switchAiProvider(cfg.ai, cfg.ai.provider);
  // AI_MODEL is applied last: it is a per-run override of which model to use, and should beat the stored one
  if (process.env.AI_MODEL) cfg.ai.model = process.env.AI_MODEL;
  if (process.env.PORT) cfg.port = Number(process.env.PORT);

  cfg.dbPath = join(DATA_ROOT, cfg.dbPath);
  cfg.guidesDir = join(DATA_ROOT, cfg.guidesDir);

  // Every secret is trimmed. A copy-paste carrying a newline or a space is the commonest cause of a
  // 401, and the resulting error ("invalid key") points nowhere near it — nor is a trailing space
  // inside a JSON string visible to the eye
  cfg.steamApiKey = String(cfg.steamApiKey ?? '').trim();
  cfg.steamId = String(cfg.steamId ?? '').trim();
  cfg.notion.token = String(cfg.notion.token ?? '').trim();
  cfg.ai.apiKey = String(cfg.ai.apiKey ?? '').trim();

  for (const field of required) {
    const missing =
      (field === 'steam' && (!cfg.steamApiKey || !cfg.steamId)) ||
      (field === 'notion' && !cfg.notion.token) ||
      (field === 'ai' && !cfg.ai.apiKey);
    if (missing) throw new Error(HINTS[field]);
  }
  return cfg;
}

const HINTS = {
  steam:
    'Steam 凭据没配置。跑一次 `node tracker.js init` 填进去,或者临时用环境变量:\n' +
    '  STEAM_API_KEY=<https://steamcommunity.com/dev/apikey 拿到的 key>\n' +
    '  STEAM_ID=<https://steamid.io 查到的 SteamID64>',
  notion:
    // "Internal Integration secret" is a conceptual name that appears nowhere in Notion's interface.
    // Quote the controls' actual wording: the button is New connection, and the secret is called
    // Access token, on its Configuration tab.
    // Notion has renamed these more than once (previously New integration / Internal Integration
    // Secret, with the page at notion.so/my-integrations), so what is quoted is the current version.
    // The walkthrough is in docs/notion-setup.md
    'NOTION_TOKEN 没配置。去 app.notion.com/developers/connections 点 New connection,\n' +
    '在它的 Configuration 标签页里复制 Access token,\n' +
    '填进 config.json 的 notion.token(或者用环境变量 NOTION_TOKEN=...),\n' +
    '并且把攻略页面/它们的父页面授权给它(页面 ••• → Add connections)。完整步骤见 docs/notion-setup.md。',
  ai:
    'AI 的 API key 没配置。在 config.json 的 ai.providers 里按供应商填 —— 几家可以同时\n' +
    '存着,各自记住自己的 key 和 model,换 provider 不用再动配置:\n' +
    '  "ai": {\n' +
    '    "provider": "anthropic",\n' +
    '    "providers": {\n' +
    '      "anthropic": { "apiKey": "sk-ant-...", "model": "" },\n' +
    '      "deepseek":  { "apiKey": "sk-...",     "model": "" }\n' +
    '    }\n' +
    '  }\n' +
    '或者用环境变量(按当前 provider 取对应那个,压过文件):\n' +
    '  ANTHROPIC_API_KEY=...  (provider 为 anthropic)\n' +
    '  DEEPSEEK_API_KEY=...   (provider 为 deepseek)\n' +
    'anthropic 和 deepseek 都有服务端联网搜索。deepseek-openai 没有,只适合验证流水线。\n' +
    '先跑 `node tracker.js ai-check --dry` 看清楚会发出去什么再说。',
};

export function saveConfig(patch) {
  const onDisk = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {};
  const next = merge(onDisk, patch);
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}
