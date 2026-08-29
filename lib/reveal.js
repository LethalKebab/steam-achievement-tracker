/**
 * Locate a file in the system file manager
 * ------------------------------------------------
 * Used for exactly one thing: opening the containing folder in one click after a local
 * guide has been generated.
 *
 * **Why it deserves its own file:** it is the only place in this project that **launches
 * an external process**, and that means an injection surface. Extracting the command
 * choice and argument assembly into a pure function (`revealCommand`) makes it testable
 * without launching anything — and the dangerous failure for this kind of code is
 * "the arguments were assembled wrong, so something else executed", which running it
 * once and seeing a window open cannot detect at all.
 */
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';

/**
 * What to execute on this platform. Returns `{ cmd, args }`, or null for an unknown platform.
 *
 * **Never assemble a whole command string; always return an argument array.** Together
 * with `shell: false` (spawn's default), the arguments are handed to the OS verbatim and
 * never go through a shell — so a space, an `&` or a quote in a path is only ever a
 * character and cannot become a second command. Guide filenames are derived from game
 * names, and game names come from Steam and can look like anything.
 *
 * Windows' `/select,<path>` **is one argument**, not two: the comma is part of the switch
 * syntax. Split into two, Explorer opens Documents instead — and does not error.
 */
export function revealCommand(filePath, platform = process.platform) {
  if (platform === 'win32') return { cmd: 'explorer.exe', args: [`/select,${filePath}`] };
  if (platform === 'darwin') return { cmd: 'open', args: ['-R', filePath] };
  if (platform === 'linux') return { cmd: 'xdg-open', args: [dirname(filePath)] };
  return null;
}

/**
 * Actually launch it. Returns `{ ok: true }` on success, or `{ error }` for an unknown platform.
 *
 * **It does not wait for exit and does not read the exit code.** Programs like Explorer have
 * no agreed convention for exit codes (on Windows `explorer.exe /select` frequently returns 1
 * while opening the window perfectly well), so judging success by it only reports "it opened"
 * as "it failed". The real failure is **not being able to launch at all**, which arrives as an
 * error event.
 */
export function revealInFileManager(filePath, { platform = process.platform, spawnImpl = spawn } = {}) {
  const c = revealCommand(filePath, platform);
  if (!c) return { error: `不知道在 ${platform} 上怎么打开文件夹` };
  try {
    const child = spawnImpl(c.cmd, c.args, { detached: true, stdio: 'ignore' });
    // A launch failure (not on PATH, say) is reported asynchronously. Without this listener
    // it becomes an unhandled error event, and an uncaught error event takes the whole
    // process down
    child.on('error', () => {});
    child.unref();
    return { ok: true };
  } catch (err) {
    return { error: String(err.message ?? err) };
  }
}
