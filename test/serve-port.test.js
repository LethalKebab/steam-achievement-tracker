/**
 * Startup failure when the port is taken
 * ------------------------------------------------
 * What this protects is something that **breaks silently**: a `listen` failure is an
 * asynchronous error event, not a throw.
 * With nobody catching it, it is an uncaught EADDRINUSE stack — a dozen incomprehensible
 * lines in the CLI, and worse in the packaged build: that stack lands on a console that
 * does not exist, leaving the launcher holding nothing but an exit code, so what the user
 * sees is 「后台服务意外退出(代码 1)」 with not one word of the cause.
 *
 * The single-instance lock (`launcher/main.js`) blocks the most common squatter — the
 * program's own second copy. This test covers the rest: a `serve` still open in a CLI, or
 * another program holding 8777.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { serve } from '../lib/server.js';

test('port taken: rejects with a sentence that explains itself, not a stack', async (t) => {
  // The squatting server takes port 0 so the system assigns one — hardcoding 8777 would
  // make this an intermittent test on a machine that really has serve running, which is
  // the very scenario it was written for
  const squatter = createServer(() => {});
  await new Promise((resolve) => squatter.listen(0, '127.0.0.1', resolve));
  t.after(() => squatter.close());
  const { port } = squatter.address();

  await assert.rejects(
    () => serve({ db: null, steam: null, config: { port }, log: () => {} }),
    (err) => {
      assert.doesNotMatch(err.message, /EADDRINUSE/,
        'EADDRINUSE was thrown through verbatim — this sentence has to appear in an error box for a person, not in a log');
      assert.match(err.message, new RegExp(String(port)), 'it does not say which port is taken');
      assert.match(err.message, /占用/, 'it does not state that the port is taken at all');
      return true;
    }
  );
});
