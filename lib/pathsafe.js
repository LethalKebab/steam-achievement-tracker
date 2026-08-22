/**
 * 路径包含性:这个绝对路径在不在那个根目录里面
 * ------------------------------------------------
 * 项目里有**四处**要回答同一个问题,而且四处的输入都来自外面:
 *
 * | 谁 | 拼进路径的东西从哪来 | 拦不住会怎样 |
 * |---|---|---|
 * | `markdown.resolveGuidePath` | `guides.url`(数据库里的一列) | 读到、并且**写到** guides/ 外面 |
 * | `backup.safeGuidePath` | zip 条目名(别人给的备份文件) | zip-slip:任意位置写文件 |
 * | `guidearchive.parseArchiveId` | 浏览器传上来的存档编号 | 任意位置读 / 删 |
 * | `server.js` 的 `/fonts/` | URL 路径 | 任意文件读 |
 *
 * 四处各写一遍的结果是可预料的:**其中两处漏掉了同一位**。
 * `startsWith(root)` 不带分隔符时,`…/guides-evil/x.md` 也算"在 `…/guides` 里面",
 * 因为前者确实以后者开头 —— 前缀相同的**兄弟目录**是这类检查最经典的漏法。
 *
 * 所以判据只写一次,放在这里。这不是为了少打几个字,是为了让"漏掉分隔符"
 * 这件事只有一个地方能发生。各调用方自己决定漏了之后怎么说话(抛异常、
 * 返回 null、回 403),那部分本来就该不一样。
 */
import { join, resolve, sep } from 'node:path';

/**
 * `full` 在 `root` **里面**吗。两边都当绝对路径处理。
 *
 * **`root` 自己不算在里面。** 调用方要的都是"根底下的某个文件",而根本身是目录;
 * 真需要放行根的地方自己多写一个 `=== root`,那是它的语义,不是这里的。
 */
export function isInside(root, full) {
  const r = resolve(String(root ?? ''));
  const f = resolve(String(full ?? ''));
  return f.startsWith(r + sep);
}

/**
 * `root` + 若干段 → 绝对路径,**不合规就返回 null**。
 *
 * 两道,顺序不能反:
 *
 * 1. **每一段必须是一个文件名** —— 不带分隔符、不是 `.` / `..`、不是空串。
 *    调用方给出"若干段"时说的就是这个意思,而 `join` 不这么想:`sub\x.md`
 *    在 Windows 上会被它当成两段规范化掉,于是一段悄悄变成了两段。落点可能
 *    仍在根里面,所以 `isInside` 看不见这件事 —— 它只知道最后落在哪,不知道
 *    路上有没有人改过结构。
 * 2. 然后才是包含性。
 *
 * 第 1 条对今天的两个调用方是冗余的(它们各自先验过一遍),留着是因为
 * 这个函数的契约要能独立成立:把一段没洗过的字符串交给它,应该是安全的。
 */
export function containedPath(root, ...parts) {
  const r = resolve(String(root ?? ''));
  const segs = parts.map((p) => String(p ?? ''));
  if (segs.some((s) => !s || s === '.' || s === '..' || /[/\\]/.test(s))) return null;
  const full = resolve(join(r, ...segs));
  return isInside(r, full) ? full : null;
}
