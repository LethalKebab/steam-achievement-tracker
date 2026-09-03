/**
 * "Why does this game have no achievement detail"
 * ------------------------------------------------
 * Both `checkbox-sync` and `guide-lint` skip a game with no rows in the achievements
 * table, and both used to give the same hardcoded reason:
 * **「还没同步成就详情(先跑 sync --schema)」**.
 *
 * That sentence is **wrong** most of the time, and wrong in a way that contradicts the
 * comment directly above it: the comment says syncAchievementSchema deliberately skips
 * games at 100%, and `sync --schema` runs exactly that filter (`rate === 1` returns
 * false immediately) — so it sent people to run a command **guaranteed not to fix it**.
 * 143 games in the library match that description.
 *
 * So the reason is given from the row's actual state, rather than as one piece of
 * universal advice.
 */
import { getGame } from './db.js';
import { msg } from './messages.js';

/**
 * @returns {string} the skip reason, in plain language
 */
export function schemaMissingReason(db, appid) {
  const g = getGame(db, appid);
  if (!g) return msg('schema.notInLibrary');
  if (g.has_achievements === 0) return msg('schema.noAchSystem');
  // This is the common case. **Do not suggest sync --schema here** — that path skips it
  if (g.rate === 1) {
    return msg('schema.perfectSkipped');
  }
  return msg('schema.notSyncedYet');
}
