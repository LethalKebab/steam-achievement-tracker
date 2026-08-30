/**
 * Which of two stored languages to show
 * ------------------------------------------------
 * The data has been bilingual at rest for a long time — `achievements.name_cn` / `name_en` since
 * the table was written, `description` / `description_en` and `games.name` / `name_en` since. What
 * has never existed is anything that **chooses** between them. The choice was instead hardcoded as
 * a Chinese-first fallback and written out by hand at every call site:
 *
 * ```js
 * d.name_cn || d.name_en || d.api_name
 * ```
 *
 * Read as English that is "prefer Chinese, fall back to English, fall back to the API name" — a
 * preference, spelled as a literal in more than twenty places. This module is that preference,
 * written once, so it can be answered differently.
 *
 * **`uiLanguage` is not `config.language`, and must never be merged with it.** `config.language` is
 * the language everything is *fetched and stored* in; changing it means the data on disk is now in
 * the wrong language, and `insertGame` is `ON CONFLICT DO NOTHING`, so existing rows would not even
 * update. A toggle pointed at that key either appears to do nothing or forces a full re-sync.
 * `uiLanguage` needs no network at all: everything it chooses between is already on disk.
 *
 * **What does not belong here.** Several call sites read *both* names on purpose — they are matching
 * a model's output, or a user's own guide text, back to an achievement, and have to keep seeing
 * every spelling regardless of what is being displayed. Those index `[d.name_cn, d.name_en]`
 * directly and must stay that way; routing them through a preference would make the match depend on
 * a display setting, which is how a guide silently stops resolving after a toggle.
 */

/** The two the interface can be in. Not Steam's language codes — those are `config.language`'s business */
export const UI_LANGUAGES = ['zh', 'en'];

export const DEFAULT_UI_LANGUAGE = 'zh';

/** Anything unrecognised reads as the default rather than throwing: a hand-edited config should not stop the app opening */
export function normalizeUiLanguage(value) {
  return UI_LANGUAGES.includes(value) ? value : DEFAULT_UI_LANGUAGE;
}

/**
 * The preferred one of a pair, falling back to the other **silently** — no marker, no badge, no
 * asterisk. A row in the other language is shown as it is, on the same principle as the rest of
 * this interface: show a state, do not narrate it.
 *
 * The fallback is not decoration. One game in a 317-game library has no English title at all
 * (`4327530 ギルド探求団へようこそ！`, which answers `l=english` with the same Japanese name), and a
 * game synced before `description_en` existed has Chinese descriptions and no English ones until
 * the next sync reaches it. Both have to render.
 */
function pick(zh, en, lang) {
  const [first, second] = lang === 'en' ? [en, zh] : [zh, en];
  return (first ?? '') || (second ?? '') || '';
}

/**
 * An achievement's display name. `api_name` is the last resort and is not a language at all — it is
 * Steam's internal identifier, shown only when a row has no name in either language.
 * Takes a row as the achievements table stores it.
 */
export function achievementName(row, lang) {
  return pick(row?.name_cn, row?.name_en, lang) || row?.api_name || '';
}

/**
 * An achievement's description. **Empty is a real answer here** and must stay distinguishable: a
 * hidden achievement stores '' in both languages deliberately, because the description is the
 * spoiler. Callers decide what to show in its place; this one does not invent text.
 */
export function achievementDescription(row, lang) {
  return pick(row?.description, row?.description_en, lang);
}

/**
 * A game's display name. Note the asymmetry with achievements: the column is `name`, not `name_cn`,
 * because it holds whatever `fetchAppName` found — usually Chinese, but English for the many games
 * that have no Chinese title, and Japanese for at least one. So this is "the stored name" versus
 * "the English name", not "Chinese" versus "English".
 */
export function gameName(row, lang) {
  return pick(row?.name, row?.name_en, lang);
}

/**
 * What a game row shows, and the stored name it is **not** showing.
 *
 * One definition because two call sites need it to agree: the Dashboard's table is built from
 * `getDashboardData`, and a game added by hand is pushed straight into that same array from
 * `addGame`'s return value without a reload. Spelled twice, a freshly added game would search
 * differently from every other row until the page was refreshed.
 *
 * `alt` is empty when there is no distinct second name, and is deliberately not "the English one":
 * both of the Dashboard's search tests match either field, so a field named by language stops
 * matching the Chinese name as soon as the interface is in English.
 */
export function gameNamePair(row, lang) {
  const shown = gameName(row, lang);
  const other = (lang === 'en' ? row?.name : row?.name_en) || '';
  return { shown, alt: other === shown ? '' : other };
}
