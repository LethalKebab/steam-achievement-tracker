/**
 * HowLongToBeat — how many hours a game takes to finish at 100%.
 *
 * The tracker knows how many achievements are left but nothing about what they cost, and
 * "4 left" is not a smaller job than "40 left" if the 4 are a multi-playthrough grind. This
 * module supplies the missing denominator: HLTB's **Completionist** figure, which is exactly
 * "played to 100%, achievements included".
 *
 * Three things about the endpoint decide the shape of everything below.
 *
 * 1. **It is unofficial and fingerprinted.** A search must be preceded by
 *    `GET /api/search/site/init`, which answers `{token, hpKey, hpVal}`. The token is a base64
 *    `timestamp::ip|user-agent|hpKey|hpVal.signature` — the server binds it to the calling IP
 *    **and to the exact User-Agent string**, so both requests must send the same UA, and
 *    UA_STRING below is therefore a constant rather than anything derived at call time.
 *    `hpVal` has to appear **twice**: as the `x-hp-val` header and as a body field keyed by
 *    `hpKey`. Sending it in only one place is a 403, indistinguishable from an expired token.
 *
 * 2. **Names cannot identify a game.** Searching "Cities: Skylines" returns *Cities: Skylines II*
 *    ahead of it, and "Slay the Spire" returns the sequel too. A wrong match is worse than no
 *    match — it silently reports the wrong number of hours. So the search is used **only to
 *    produce candidates**, and the answer is decided by `profile_steam` on the candidate's own
 *    page, which is the Steam appid and joins exactly. Anything unverified is reported as
 *    unverified rather than quietly used.
 *
 * 3. **A Chinese title is often a game's real store title in every language.** `name_en` for
 *    风信楼 is "风信楼", so there is no English string to search with. Stripping CJK and trying
 *    the remainder rescues the mixed titles (鬼谷八荒 Tale of Immortal → "Tale of Immortal"), and
 *    the rest have to be pointed at an id by hand — see `manual` in the hltb table.
 */

const UA_STRING =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const HLTB_ORIGIN = 'https://howlongtobeat.com';
/** Same reasoning as steam.js: an unanswered socket presents as a sync that never finishes */
const HLTB_TIMEOUT_MS = 15000;

/**
 * Consecutive unreachable-service failures before this phase gives up for the run.
 *
 * **Three, and it does not persist.** The failure this guards is the endpoint changing its
 * anti-bot scheme again — which it demonstrably iterates on — and the shape of that is every
 * request failing, not one. Without a limit the phase would spend minutes per sync sending
 * requests that cannot succeed, for a reason nothing on screen would name.
 *
 * **A breaker that survived the run would need a way to be reset**, and would then be free to be
 * wrong for a month. In memory, per run, it costs one wasted trio of requests next sync and heals
 * itself the moment the service comes back.
 */
const HLTB_FAILURE_LIMIT = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The largest page this will read. A game page is around 30 KB; 4 MB is two orders of magnitude of
 * headroom and still a ceiling.
 *
 * It exists because this is the one place in the program that reads a body from a host nobody here
 * controls. `res.text()` has no limit of its own, so a hostile or simply broken response is read
 * until memory runs out — and, exactly as with `readBody` in server.js, **rejecting after the fact
 * is not a limit**: the bytes have already arrived. The read has to stop pulling.
 */
const MAX_PAGE_BYTES = 4 * 1024 * 1024;

/** The body as text, or null if it exceeded the cap. Stops reading rather than reading then judging */
async function readCapped(res) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_PAGE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Every request carries these. `Origin` and `Referer` are not decoration: the endpoint is meant
 * to be called from its own page, and the init handshake reads the UA out of this very header
 * to build the token it hands back.
 */
const baseHeaders = () => ({
  'User-Agent': UA_STRING,
  Origin: HLTB_ORIGIN,
  Referer: `${HLTB_ORIGIN}/`,
});

/**
 * Drop CJK, fullwidth punctuation and the trademark furniture, then collapse whitespace.
 * Used to turn a bilingual store title into something HLTB's English index can match.
 */
export const stripCJK = (s) =>
  String(s || '')
    .replace(/[　-鿿＀-￯⺀-⻿]/g, ' ')
    .replace(/[®™©]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The search strings to try for one game, best first.
 *
 * A Steam title routinely packs two languages, or an English name and a subtitle either side of
 * a slash, and HLTB indexes only one of them. Each half is worth a separate query — but the list
 * is capped, because every entry costs a search plus up to three page fetches, and a title that
 * has not matched after four tries is not going to.
 */
export function searchQueries(nameEn, name) {
  const out = [];
  for (const raw of [nameEn, name]) {
    if (!raw) continue;
    for (const part of [raw, ...String(raw).split('/')]) {
      const s = stripCJK(part);
      // One- and two-character remnants match everything and identify nothing
      if (s.length >= 3 && !out.includes(s)) out.push(s);
    }
  }
  return out.slice(0, 4);
}

/** The body parsed as JSON, or null for anything that was too large or did not parse */
async function readCappedJson(res) {
  const text = await readCapped(res);
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export class HltbClient {
  /**
   * `requestDelayMs` is deliberately **its own** option rather than a reuse of the Steam one.
   * The two hosts have nothing to do with each other: the Steam Web API is measured to take
   * 11 requests/second, while this is an unofficial endpoint on someone's site that is being
   * asked a favour. Sharing one knob would mean speeding this up as a side effect of tuning
   * Steam, with the consequence invisible until the address is blocked.
   */
  constructor(cfg = {}, { log = () => {} } = {}) {
    this.delay = cfg.hltbRequestDelayMs ?? 800;
    this.log = log;
    /** {token, hpKey, hpVal}, or null before the first handshake */
    this.session = null;
    /**
     * Consecutive failures that say **the service** is unreachable, rather than that one game is
     * not on it. Reset by any success. See `#hardFailure`
     */
    this.failures = 0;
    /** Why the breaker tripped, or null. Set once, read by the caller, never cleared within a run */
    this.stopped = null;
    this.lastRequestAt = 0;
  }

  /** Every request goes through here, so nothing downstream can be written unpaced or unguarded */
  async #get(url, init = {}) {
    // **Paced by the gap between request *starts*, not by a sleep after each one.** A blind sleep
    // at each call site is what the resolve path had and the refresh path did not, which left a
    // monthly pass free to fire a request per game back to back. Measuring the gap also means a
    // slow response does not have the delay added on top of its own latency
    const wait = this.delay - (Date.now() - this.lastRequestAt);
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(HLTB_TIMEOUT_MS), headers: baseHeaders(), ...init });
      // 5xx and 429 are the service saying it cannot answer anyone; 404 is it answering about one
      // page, which is a fact about that game and must not count towards the breaker
      if (res.status === 429 || res.status >= 500) this.#hardFailure(`HTTP ${res.status}`);
      else this.failures = 0;
      return res;
    } catch (err) {
      // **A throw here is the defect this wraps.** A timeout, a DNS failure or a reset used to
      // travel out of resolve, out of syncHltb and out of fullSync, so the Dashboard reported
      // 「同步失败」 for a run whose Steam data had already landed perfectly. Same rule the Notion
      // tick pass follows: a third party being down is not this program's sync failing
      this.#hardFailure(err?.name === 'TimeoutError' ? '请求超时' : (err?.message ?? '网络错误'));
      return null;
    }
  }

  /**
   * Count one failure of the kind that means "the service is not answering".
   *
   * **A game HowLongToBeat has never heard of is not one of these.** That is an answer, and a run
   * of obscure titles would otherwise trip the breaker on a perfectly healthy endpoint.
   */
  #hardFailure(reason) {
    this.failures++;
    if (this.failures >= HLTB_FAILURE_LIMIT && !this.stopped) {
      this.stopped = reason;
      this.log(`HLTB 连续 ${this.failures} 次失败(${reason}),本轮跳过`);
    }
  }

  /** Fetch a fresh `{token, hpKey, hpVal}`. Called lazily, and again whenever a search 403s */
  async openSession() {
    const res = await this.#get(`${HLTB_ORIGIN}/api/search/site/init?t=${Date.now()}`);
    if (!res || !res.ok) {
      // `res` is null when the request never completed — #get has already counted that and said
      // why, so there is no status to name and reaching for one throws
      if (res) this.log(`HLTB init -> HTTP ${res.status}`);
      this.session = null;
      return null;
    }
    const j = await readCappedJson(res);
    if (!j?.token || !j?.hpKey) {
      this.log('HLTB init -> 应答缺少 token');
      this.session = null;
      return null;
    }
    this.session = { token: j.token, hpKey: j.hpKey, hpVal: j.hpVal };
    return this.session;
  }

  /**
   * One search. Returns the `data` array, or [] for anything that is not a usable answer.
   *
   * A 403 means the token has expired or was never valid, and the only cure is a new handshake —
   * so it retries **once** with a fresh session. Retrying further would loop against a genuine
   * block, which is the case a 403 cannot be distinguished from.
   */
  async search(query, { retry = true } = {}) {
    if (!this.session && !(await this.openSession())) return [];
    const { token, hpKey, hpVal } = this.session;
    const body = {
      searchType: 'games',
      searchTerms: String(query).trim().split(/\s+/),
      searchPage: 1,
      size: 20,
      searchOptions: {
        games: {
          userId: 0,
          platform: '',
          sortCategory: 'popular',
          rangeCategory: 'main',
          rangeTime: { min: null, max: null },
          gameplay: { perspective: '', flow: '', genre: '', difficulty: '' },
          year: '',
          modifier: '',
        },
        users: { sortCategory: 'postcount' },
        lists: { sortCategory: 'follows' },
        filter: '',
        sort: 0,
        randomizer: 0,
      },
      useCache: true,
      // The second half of the honeypot pair. The header alone is refused
      [hpKey]: hpVal,
    };
    const res = await this.#get(`${HLTB_ORIGIN}/api/search/site`, {
      method: 'POST',
      headers: {
        ...baseHeaders(),
        'Content-Type': 'application/json',
        'x-auth-token': token,
        'x-hp-key': hpKey,
        'x-hp-val': hpVal,
      },
      body: JSON.stringify(body),
    });
    if (!res) return [];
    if (res.status === 403 && retry) {
      this.log('HLTB 搜索 -> HTTP 403,重新握手后重试');
      await this.openSession();
      // No sleep here: the handshake and the retry both go through #get, which paces itself
      return this.search(query, { retry: false });
    }
    if (!res.ok) {
      this.log(`HLTB 搜索 "${query}" -> HTTP ${res.status}`);
      // A 403 that survived a fresh handshake is the service refusing this address, not an
      // expired token — the one case the single retry above cannot cure
      if (res.status === 403) this.#hardFailure('HTTP 403');
      return [];
    }
    const j = await readCappedJson(res);
    // Only base games. A DLC carries its own completionist figure, which is not the parent's
    return (j?.data ?? []).filter((d) => d?.game_type === 'game');
  }

  /**
   * The numbers on one game's page.
   *
   * Read out of the JSON the page embeds rather than from any `/api/game/` route, because there
   * is no such public route; the page is the only place `profile_steam` and the Completionist
   * spread are published together.
   *
   * Returns null for anything that did not parse. **A page that loads but carries no
   * `profile_steam` counts as a failure**, not as "steam id absent": the two look identical
   * from here, and treating a throttled or error page as a real answer would cache a wrong
   * "not found" against the game forever.
   */
  async detail(hltbId) {
    const res = await this.#get(`${HLTB_ORIGIN}/game/${hltbId}`);
    if (!res || !res.ok) {
      if (res) this.log(`HLTB 详情 ${hltbId} -> HTTP ${res.status}`);
      return null;
    }
    const html = await readCapped(res);
    if (html === null) {
      this.log(`HLTB 详情 ${hltbId} -> 应答过大,已放弃`);
      return null;
    }
    // No \d — this string is built at runtime, and a lone backslash in a source literal is
    // one editing accident away from matching the letter d instead of a digit
    const num = (k) => {
      const m = html.match(new RegExp(`"${k}":(-?[0-9]+)`));
      return m ? Number(m[1]) : null;
    };
    const steam = num('profile_steam');
    if (steam === null) return null;
    return {
      hltbId: Number(hltbId),
      steam,
      // Some entries record a second appid (a re-release, or a bundled edition)
      steamAlt: num('profile_steam_alt'),
      // The site's own headline figure, which is neither the mean nor the median
      comp100: num('comp_100'),
      comp100Med: num('comp_100_med'),
      comp100Lo: num('comp_100_l'),
      comp100Hi: num('comp_100_h'),
      comp100Count: num('comp_100_count'),
    };
  }

  /**
   * Find the HLTB entry for one Steam game.
   *
   * Returns `{verified: true, ...detail}` only when a candidate's own page names this appid.
   * When nothing verifies it returns `{verified: false}` and **no hours at all** — a plausible
   * near-match is precisely the failure this function exists to prevent, so it is not passed on
   * as a consolation. The caller records the miss and stops asking.
   */
  async resolve({ appid, nameEn, name }) {
    const want = String(appid);
    for (const q of searchQueries(nameEn, name)) {
      if (this.stopped) return { verified: false, stopped: this.stopped };
      const candidates = await this.search(q);
      // Three is enough: the right game is at the top or is not in this query's answer
      for (const c of candidates.slice(0, 3)) {
        const d = await this.detail(c.game_id);
        if (!d) continue;
        if (String(d.steam) === want || String(d.steamAlt) === want) {
          return { verified: true, name: c.game_name, ...d };
        }
      }
    }
    return { verified: false };
  }

  /** Refresh the hours for an entry whose id is already known. No search, so one request */
  async refresh(hltbId) {
    const d = await this.detail(hltbId);
    return d ? { verified: true, ...d } : null;
  }
}
