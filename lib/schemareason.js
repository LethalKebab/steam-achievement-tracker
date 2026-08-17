/**
 * 「为什么这一款没有成就详情」
 * ------------------------------------------------
 * `checkbox-sync` 和 `guide-lint` 碰到 achievements 表里没有记录的游戏时都要跳过它,
 * 而两处原来给的理由是同一句写死的话:**「还没同步成就详情(先跑 sync --schema)」**。
 *
 * 那句话在多数情况下**是错的**,而且错得刚好和它上面那行注释自相矛盾:注释写着
 * "100% 通关的游戏 syncAchievementSchema 故意不同步成就详情",而 `sync --schema`
 * 走的正是那个会跳过它们的筛选(`rate === 1` 直接 return false)—— 于是它让人去跑
 * 一条**保证不会解决问题**的命令。库里符合这个描述的有 143 款。
 *
 * 所以理由要按行的真实状态给,而不是给一句放之四海的建议。
 */
import { getGame } from './db.js';

/**
 * @returns {string} 人话的跳过原因
 */
export function schemaMissingReason(db, appid) {
  const g = getGame(db, appid);
  if (!g) return '这个 appid 不在库里';
  if (g.has_achievements === 0) return '这个游戏没有成就系统';
  // 这才是最常见的一类。**别在这里建议跑 sync --schema** —— 那条路会跳过它
  if (g.rate === 1) {
    return '已经打满了,批量同步刻意不取它的成就详情(生成攻略时会自己去取)';
  }
  return '还没同步成就详情,下次同步会带上它';
}
