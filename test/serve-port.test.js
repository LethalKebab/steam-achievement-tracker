/**
 * 端口被占用时的启动失败
 * ------------------------------------------------
 * 保的是一件**坏掉不出声**的事:`listen` 失败是异步的 error 事件,不是抛异常。
 * 没人接就是一条 uncaught EADDRINUSE 堆栈 —— CLI 里印十几行看不懂的东西,
 * 打包版里更糟:那条堆栈落在一个根本不存在的控制台上,启动器手里只剩一个退出码,
 * 于是用户看到的是「后台服务意外退出(代码 1)」,一句原因都没有。
 *
 * 单实例锁(`launcher/main.js`)挡掉了最常见的那个占用者 —— 程序自己的第二份。
 * 这条测试管的是剩下的:CLI 里还开着一个 `serve`,或者别的程序占了 8777。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { serve } from '../lib/server.js';

test('端口被占用:reject 一句说得清的话,而不是一条堆栈', async (t) => {
  // 占位的服务器用 0 号端口让系统分配 —— 写死 8777 会在本机真的开着 serve 时
  // 变成一条时灵时不灵的测试,而它恰好就是为这个场景写的
  const squatter = createServer(() => {});
  await new Promise((resolve) => squatter.listen(0, '127.0.0.1', resolve));
  t.after(() => squatter.close());
  const { port } = squatter.address();

  await assert.rejects(
    () => serve({ db: null, steam: null, config: { port }, log: () => {} }),
    (err) => {
      assert.doesNotMatch(err.message, /EADDRINUSE/,
        '原样把 EADDRINUSE 抛出来了 —— 这句话要出现在错误框里给人看,不是给日志看');
      assert.match(err.message, new RegExp(String(port)), '没说是哪个端口被占了');
      assert.match(err.message, /占用/, '没说清"被占用"这件事本身');
      return true;
    }
  );
});
