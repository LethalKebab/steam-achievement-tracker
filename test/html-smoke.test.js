/**
 * Dashboard.html / Setup.html 的结构冒烟测试
 * ------------------------------------------------
 * ## 它是什么,不是什么
 *
 * **这不是行为测试。** 项目零依赖(见 CLAUDE.md),没有 jsdom 也没有 Playwright,
 * 所以这里跑不了真 DOM —— 点击、焦点、CSS 层叠这些一概验不到,那部分仍然只能靠
 * 人在浏览器里看。**别把这个文件的绿灯读成「界面是好的」。**
 *
 * 它验的是**引用完整性**:JS 指着的元素在不在、选择器指着的东西在不在、脚本能不能
 * 解析。听起来很浅,但这一类正是这两个文件真实的失败模式 —— 页面是一大团字符串,
 * 改名和删元素**不会有任何东西报错**,只会在运行时静默变成 null,或者一条 CSS 规则
 * 悄悄不再匹配任何东西。
 *
 * 这些检查是照着**实际踩过的坑**写的,不是凭空列的清单:
 *
 * - `<details>` 换成 `<section>` 之后,`details ol code` 和 `.hint a` 两条规则
 *   匹配不上了 —— 行内 code 掉回默认等宽字、说明里的链接变成深蓝,在深色底上几乎
 *   看不见,而且**没有任何东西报错**。(检查:CSS 里的类型选择器必须还有对应的标签)
 * - 删掉 `#newAchSection` 那一整块之后,残留的 `getElementById` 会拿到 null。
 *   (检查:JS 引用的每个 id 都要存在)
 * - 隐藏的 `required` 控件会让浏览器**静默拒绝提交**,控制台报 not focusable,
 *   界面上表现为「按了保存没反应」。(检查:分步表单里不许有 required)
 * - `classList.toggle(name, undefined)` **会翻转而不是关闭**,状态对象缺字段时
 *   顶栏那条同步线每 3 秒亮灭一次、永远停不下来。(检查:第二个参数要布尔化)
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = ['Dashboard.html', 'Setup.html'];
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

// ---------------------------------------------------------------------------
// 提取
// ---------------------------------------------------------------------------

/** 内联 <script>(带 src 的不算 —— 那是 /_rpc.js,不在这个文件里) */
const inlineScripts = (html) =>
  [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

const styleBlocks = (html) => [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);

/** 去掉 <style> 和 <script>,剩下的才是静态标记 —— 否则 CSS 里的 `button {` 会被当成标签 */
const markupOnly = (html) =>
  html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '');

/**
 * 「页面可能产出的东西」的全部来源:静态标记 **加上** JS 里拼 HTML 的那些字符串。
 *
 * Dashboard 的表格几乎整个是 JS 拼出来的 —— `class="manual-input"`、
 * `data-fav-appid="`、`<img` 全都只存在于脚本里的字符串。只看静态标记会把它们
 * 全判成「不存在」,那是第一版的假阳性来源。
 *
 * 只剥块注释:`//` 行注释不能剥,`'https://…'` 里的双斜杠会被误伤。
 */
const emittingSource = (html) => html.replace(/\/\*[\s\S]*?\*\//g, '');

const definedIds = (html) => new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

/** JS 里按 id 取元素的两种写法。Setup.html 用 $ 包了一层 getElementById */
const referencedIds = (js) => [
  ...[...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]),
  ...[...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]),
];

const querySelectors = (js) =>
  [...js.matchAll(/querySelectorAll?\('([^']+)'\)/g)].map((m) => m[1]);

/**
 * CSS 里用到的类型选择器(`details`、`summary`、`button`…)。
 *
 * 先整块剥掉 @keyframes —— 里面的 `from` / `to` / `50%` 不是标签。其余 at-rule
 * (@media)只去掉那一行前缀,块内的规则要照常看。
 */
function cssTypeSelectors(css) {
  // **先剥注释。** 不剥的话注释正文会被当成选择器 —— 这个文件的 CSS 注释里满是
  // `emoji`、`img`、`svg` 这种词,第一版跑出来全是它们
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const withoutKeyframes = withoutComments.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  const out = new Set();
  for (const m of withoutKeyframes.matchAll(/(^|\}|\{)\s*([^{}@]+?)\s*\{/g)) {
    for (const sel of m[2].split(',')) {
      for (const simple of sel.trim().split(/[\s>+~]+/)) {
        // 去掉 .class / #id / [attr] / :pseudo,剩下的才是类型选择器
        const tag = simple.replace(/[.#[:][^\s]*$/, '').replace(/[.#[:].*/, '').trim();
        if (/^[a-z][a-z0-9]*$/.test(tag)) out.add(tag);
      }
    }
  }
  return out;
}

/** 选择器里出现的、可以在标记里查证的记号 */
function selectorTokens(sel) {
  const tokens = [];
  for (const m of sel.matchAll(/#([\w-]+)/g)) tokens.push({ kind: 'id', name: m[1] });
  for (const m of sel.matchAll(/\.([\w-]+)/g)) tokens.push({ kind: 'class', name: m[1] });
  for (const m of sel.matchAll(/\[([\w-]+)/g)) tokens.push({ kind: 'attr', name: m[1] });
  return tokens;
}

// 这些标签不需要在标记里逐个找到:要么是根元素,要么由 JS 动态建出来
const TAG_WHITELIST = new Set(['html', 'body', 'option']);

// ---------------------------------------------------------------------------

describe('内联脚本能解析', () => {
  for (const page of PAGES) {
    test(page, () => {
      const scripts = inlineScripts(read(page));
      assert.ok(scripts.length > 0, `${page} 里没找到内联脚本 —— 提取逻辑坏了,不是页面空了`);
      scripts.forEach((src, i) => {
        // 语法错误在浏览器里表现为「整个页面的 JS 都不跑」,而 HTML 照常渲染 ——
        // 看起来像界面失灵,不像语法错
        assert.doesNotThrow(() => new Script(src), `${page} 第 ${i + 1} 块脚本语法错误`);
      });
    });
  }
});

describe('JS 指着的元素 id 都存在', () => {
  for (const page of PAGES) {
    test(page, () => {
      const html = read(page);
      const defined = definedIds(html);
      const referenced = [...new Set(inlineScripts(html).flatMap(referencedIds))];
      assert.ok(referenced.length > 5, `${page} 只抓到 ${referenced.length} 个引用,提取逻辑可能坏了`);
      const missing = referenced.filter((id) => !defined.has(id));
      assert.deepEqual(missing, [],
        `${page} 里这些 id 被 JS 引用但标记里没有(运行时会拿到 null,不报错):${missing.join(', ')}`);
    });
  }
});

describe('querySelector 用的选择器在标记里有对应', () => {
  for (const page of PAGES) {
    test(page, () => {
      const html = read(page);
      const src = emittingSource(html);
      const srcNoCss = src.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
      // 所有 class="…" 里出现过的类名 token(静态标记和 JS 模板串都算)。
      // **不要求属性闭合** —— JS 里常写成 `'<div class="g-card' + (x ? ' y' : '') + '"'`,
      // 属性的收尾引号在另一个字符串里。所以在 `"` 或 `'` 处截断,两种写法都能取到
      const classTokens = new Set(
        [...srcNoCss.matchAll(/class="([^"']*)/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean)
      );
      const defined = definedIds(html);
      const bad = [];
      for (const sel of new Set(inlineScripts(html).flatMap(querySelectors))) {
        for (const t of selectorTokens(sel)) {
          let ok;
          if (t.kind === 'id') {
            ok = defined.has(t.name);
          } else if (t.kind === 'attr') {
            // 属性一律是带 `="` 写出去的,这条能精确查证
            ok = new RegExp(`\\b${t.name}=`).test(src);
          } else {
            // 类名要在**真正被写出去的上下文**里出现过,两种形式:
            //   1. `class="… name …"` —— 静态标记和 JS 模板串里都算
            //   2. 独立的引号串 `'name'` / `' name'` —— 拼 className 或 classList 用的
            //      (`'game-row' + (canExpand ? ' expandable' : '')`)
            //
            // 早先用的是「全文出现 ≥2 次」,变异测试证明那条不可靠:短名字满地都是
            // (`step` 会被 `step-nav`、`showStep`、`data-step` 全部命中),把产出侧
            // 删光了计数照样够。**必须排除 <style>** —— 类名在 CSS 里几乎总有一条规则。
            // **按空格切出真正的类名 token,不能用 \b。** `\b` 把 `-` 也算成边界,
            // 于是找 `step` 会被 `class="step-title"` 满足 —— 变异测试抓到过这条假阳性
            ok = classTokens.has(t.name)
              || new RegExp(`'\\s*${t.name}\\s*'`).test(srcNoCss);
          }
          if (!ok) bad.push(`${sel} → ${t.kind} "${t.name}"`);
        }
      }
      assert.deepEqual(bad, [], `${page} 里这些选择器匹配不到任何东西:\n  ${bad.join('\n  ')}`);
    });
  }
});

describe('CSS 里的类型选择器还有对应的标签', () => {
  for (const page of PAGES) {
    test(page, () => {
      const html = read(page);
      // 在**静态标记 + JS 拼的字符串**里找 `<tag` —— Dashboard 的 img/svg 只存在于脚本里
      const src = emittingSource(html).replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
      const orphans = [...cssTypeSelectors(styleBlocks(html).join('\n'))]
        .filter((tag) => !TAG_WHITELIST.has(tag) && !new RegExp(`<${tag}[\\s>]`).test(src));
      // 这一条是照着真事写的:<details> 换成 <section> 之后,details ol code 那条规则
      // 静默失效,页面上的行内 code 掉回浏览器默认样式,没有任何东西报错
      assert.deepEqual(orphans, [],
        `${page} 的 CSS 里这些类型选择器已经匹配不到任何标签了(规则静默失效):${orphans.join(', ')}`);
    });
  }
});

describe('踩过的坑,钉住', () => {
  test('Setup 的分步表单里不许有 required —— 隐藏的必填控件会让提交静默失败', () => {
    const markup = markupOnly(read('Setup.html'));
    const offenders = [...markup.matchAll(/<input[^>]*\brequired\b[^>]*>/g)].map((m) => m[0]);
    assert.deepEqual(offenders, [],
      '浏览器拒绝校验 display:none 的必填控件,只在控制台报 not focusable —— '
      + '界面上就是「按了保存没反应」。校验要走 stepOneOk 那条人工路径');
  });

  test('classList.toggle 的第二个参数必须布尔化,否则 undefined 会翻转', () => {
    for (const page of PAGES) {
      const js = inlineScripts(read(page)).join('\n');
      for (const m of js.matchAll(/classList\.toggle\(([^)]*)\)/g)) {
        const args = m[1].split(',');
        if (args.length < 2) continue;       // 单参是有意的"翻转"
        const second = args[1].trim();
        const safe = /^(true|false)$/.test(second)
          || second.startsWith('Boolean(')
          || second.startsWith('!')
          || /[=<>]=?/.test(second);          // 比较表达式本来就是布尔
        assert.ok(safe,
          `${page}:classList.toggle(${m[1]}) 的第二个参数不保证是布尔。`
          + 'undefined 会让它**翻转**而不是关闭 —— 状态对象缺字段时,这个类会每次轮询亮灭一次');
      }
    }
  });

  test('同步按钮是图标,onSyncState 不许写它的 textContent', () => {
    const js = inlineScripts(read('Dashboard.html')).join('\n');
    const start = js.indexOf('window.onSyncState');
    assert.ok(start > 0, '找不到 onSyncState —— 这条检查失去了目标,不是通过了');
    const body = js.slice(start, start + 1200);
    assert.ok(!/syncBtn\.(textContent|innerHTML)\s*=/.test(body),
      '写 textContent 会把 🔄 换成文字,并连带删掉里面那个 .icon-glyph —— '
      + '转圈/状态样式从此挂不上去。状态改走 class 和 title');
  });
});
