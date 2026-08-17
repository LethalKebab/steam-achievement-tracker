/**
 * 在系统文件管理器里定位一个文件
 * ------------------------------------------------
 * 只给一件事用:本地攻略生成完之后,让人一键打开它所在的文件夹。
 *
 * **为什么值得单独一个文件:** 它是这个项目里唯一一处**拉起外部进程**的地方,
 * 而那意味着注入面。挑命令和拼参数的逻辑抽成纯函数(`revealCommand`),
 * 就能在不真的启动任何东西的前提下测它 —— 这类代码最危险的失败是"参数拼错了,
 * 于是执行了别的东西",而那恰恰是跑一次看窗口开没开根本发现不了的。
 */
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';

/**
 * 这个平台该执行什么。返回 `{ cmd, args }`,不认识的平台返回 null。
 *
 * **绝不拼一整条命令字符串,永远返回参数数组。** 配合 `shell: false`(spawn 的默认值),
 * 参数原样交给系统,不经过任何 shell 解析 —— 于是路径里的空格、`&`、引号都只是字符,
 * 不可能变成第二条命令。攻略文件名是从游戏名削出来的,而游戏名是 Steam 给的、
 * 可以长成任何样子。
 *
 * Windows 的 `/select,<路径>` **是一个参数**,不是两个:逗号是这个开关语法的一部分。
 * 拆成两个参数的话资源管理器会打开「我的文档」,而且不报错。
 */
export function revealCommand(filePath, platform = process.platform) {
  if (platform === 'win32') return { cmd: 'explorer.exe', args: [`/select,${filePath}`] };
  if (platform === 'darwin') return { cmd: 'open', args: ['-R', filePath] };
  if (platform === 'linux') return { cmd: 'xdg-open', args: [dirname(filePath)] };
  return null;
}

/**
 * 真的拉起来。成功返回 `{ ok: true }`,平台不认识返回 `{ error }`。
 *
 * **不等它退出,也不看退出码。** 资源管理器这类程序的退出码没有约定俗成的含义
 * (Windows 上 `explorer.exe /select` 常常返回 1 却正常打开了窗口),拿它判断成败
 * 只会把"打开了"报成"失败"。真正的失败是**拉不起来**,那会走 error 事件。
 */
export function revealInFileManager(filePath, { platform = process.platform, spawnImpl = spawn } = {}) {
  const c = revealCommand(filePath, platform);
  if (!c) return { error: `不知道在 ${platform} 上怎么打开文件夹` };
  try {
    const child = spawnImpl(c.cmd, c.args, { detached: true, stdio: 'ignore' });
    // 拉不起来(比如 PATH 里没有)是异步报的。不挂这个监听会变成一个
    // 没人接的 error 事件,而未捕获的 error 事件会把整个进程带崩
    child.on('error', () => {});
    child.unref();
    return { ok: true };
  } catch (err) {
    return { error: String(err.message ?? err) };
  }
}
