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
import { readFileSync, existsSync } from 'node:fs';
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
 * 再把 `<!-- -->` 也剥掉。
 *
 * `markupOnly` 不管注释,而「这段文案里不许出现某个词」这类断言里,**解释那个词为什么
 * 不能用的注释就写在它旁边** —— 不剥的话断言被注释喂饱,把代码删了它照样绿。
 * 这是这个仓库反复踩的同一个坑(tray.test.js 的 maybeAutoSync、Dashboard 的
 * loadDashboard(),见 CLAUDE.md「Strip comments before any source assertion」)。
 */
const markupNoComments = (html) => markupOnly(html).replace(/<!--[\s\S]*?-->/g, '');

/** 某一步的那段标记。按 data-step 切,别按字节数切 —— 切窗口会随内容长短悄悄挪 */
const stepBlock = (html, n) => {
  const m = markupNoComments(html).match(
    new RegExp(`data-step="${n}"[\\s\\S]*?(?=data-step="${n + 1}"|</form>)`)
  );
  assert.ok(m, `Setup.html 里找不到 data-step="${n}" 这一段`);
  return m[0];
};

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

  /**
   * 用户实报(2026-08-17):照着设置页第 3 步去 Notion,页面上找不到「Internal Integration」。
   * 因为 Notion 上根本没这几个字 —— 按钮叫 `New integration`,`Internal` 是里面 Type 那栏的值。
   *
   * 钉的是**规则**不是措辞:说明步骤里出现的英文必须是控件上的原字。概念名读起来对,
   * 照着找的人却找不到,而这种错不会报任何东西 —— 它只是让人卡在那儿。
   */
  test('Notion 那一步引的是界面原字,不是「Internal Integration」这种概念名', () => {
    const step = stepBlock(read('Setup.html'), 3);
    assert.match(step, /New integration/,
      '要给出 Notion 上那个按钮的原字。用户是照着这段话在屏幕上找东西的');
    assert.doesNotMatch(step, /Internal\s+Integration/i,
      'Notion 界面上没有「Internal Integration」这个东西:New integration 是按钮,'
      + 'Internal 是 Type 那一栏的选项。合成一个词组就等于让人去找一个不存在的标签');
  });

  test('设置页要有走查入口,而且它指的那份文档还在', () => {
    const step = stepBlock(read('Setup.html'), 3);
    assert.match(step, /docs\/notion-setup\.md/,
      '「让我打开说明跟着走」是用户提的第二个诉求。走查页面一直都在,缺的只是这个入口');
    assert.ok(existsSync(join(ROOT, 'docs/notion-setup.md')),
      '设置页指着 docs/notion-setup.md。文档改名不会让任何东西报错,'
      + '只会让那个链接变成 404 —— 而点它的人正是已经卡住的那个');
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

/**
 * `hidden` 属性必须真的隐藏 —— 两页都要有那条全局规则
 * ------------------------------------------------
 * 浏览器自带的 `[hidden] { display: none }` 来自 **user-agent 样式表**,而作者样式表里
 * 任何一条 `display:` 都比它优先。于是一条无关的布局规则就能悄悄让某个元素的 `hidden`
 * 变成装饰:JS 照常 `.hidden = true`,元素照常显示,**没有任何东西报错**。
 *
 * 这不是假想。2026-08-14 一次扫描在两页里查出三处已经中招:
 *   · `.gallery { display: grid }`  → Dashboard 切回表格视图后,网格内容留在表格下面
 *     (`render` 在表格模式下 early return,压根不重绘 #gallery,所以旧内容原样挂着)
 *   · `.steps { display: flex }`         → 设置页的步骤条
 *   · `.step-actions { display: flex }`  → 设置页的按钮行,三个按钮一起露出来
 *
 * 当时页面里**已经**有一条 `.step[hidden] { display: none }` —— 说明这个坑是知道的,
 * 只是逐个补是打地鼠:下一条带 `display` 的规则又开一个新洞,而且照样不出声。
 * 所以改成一条全局规则,让这一类从构造上不成立。`!important` 是必须的,它要压住的
 * 正是「后来某个人写的某条 display」。
 *
 * 这里钉的是**那条规则本身**,不是某几个元素 —— 元素会来会走,规则在,这一类就不会回来。
 */
describe('hidden 属性不能被 display 规则架空', () => {
  for (const page of PAGES) {
    test(`${page} 有全局 [hidden] { display: none !important }`, () => {
      const css = styleBlocks(read(page)).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
      const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
      const guard = rules.find(
        (m) =>
          m[1].split(',').some((s) => s.trim() === '[hidden]') &&
          /display\s*:\s*none\s*!important/.test(m[2])
      );
      assert.ok(
        guard,
        `${page} 缺少全局 [hidden] 规则 —— 任何一条 display: 都会让某个元素的 hidden 静默失效`
      );
    });

    test(`${page} 里带 hidden 的元素没有被别的 display 规则单独架空`, () => {
      // 全局规则在的话这条恒过;它的价值是在**全局规则被删掉时**把具体是哪几个元素中招报出来,
      // 这样修的人知道自己在保护什么,而不是只看到一条抽象的规则不见了
      const html = read(page);
      const css = styleBlocks(html).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
      const rules = [...css.matchAll(/([^{}]+)\{([^{}]*display\s*:[^{}]*)\}/g)].map((m) => ({
        sels: m[1].split(',').map((s) => s.trim()),
        decl: m[2],
      }));
      if (rules.some((r) => r.sels.includes('[hidden]') && /none\s*!important/.test(r.decl))) return;

      const hiddenTags = [...html.matchAll(/<(\w+)([^>]*\shidden(?=[\s/>])[^>]*)>/g)].map((m) => ({
        id: m[2].match(/\sid="([^"]+)"/)?.[1] ?? '',
        cls: (m[2].match(/\sclass="([^"]+)"/)?.[1] ?? '').split(/\s+/).filter(Boolean),
      }));
      const broken = hiddenTags.filter((t) =>
        rules.some(
          (r) =>
            !r.sels.some((s) => s.includes('[hidden]')) &&
            r.sels.some((s) => t.cls.some((c) => s === '.' + c) || (t.id && s === '#' + t.id))
        )
      );
      assert.deepEqual(broken.map((t) => t.id || t.cls.join('.')), [], '这些元素的 hidden 是装饰');
    });
  }
});

/**
 * 两页的设计令牌必须是同一份
 * ------------------------------------------------
 * 配色、间距、字号、圆角全部收敛到 `:root` 的一块变量里,而**零依赖不允许有共享
 * 样式表**(CLAUDE.md 的 Stack constraints:没有构建步骤,页面就是一大团字符串),
 * 所以这一块在 Dashboard.html 和 Setup.html 里各存了一份。
 *
 * 两份手抄的东西一定会分叉,而分叉的表现是**没有任何东西报错**:设置页的蓝和主界面
 * 的蓝差一点点,或者改主界面时新加的 `--danger` 在设置页是未定义的 —— 未定义的
 * CSS 变量不会报错,它让那条声明整个失效,颜色悄悄掉回继承值。
 *
 * 所以这里逐条比对。**比的是声明,不是字节** —— 两页缩进不同(4 格 / 2 格),
 * 注释也各自解释各自的上下文,拿原文比会天天误报。
 */
describe('两页的 :root 设计令牌是同一份', () => {
  /** 取出 :root 里的声明,规范化成 `名字:值` 的有序数组 */
  const rootDecls = (html) => {
    const css = styleBlocks(html).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
    const m = css.match(/:root\s*\{([^{}]*)\}/);
    assert.ok(m, '找不到 :root —— 这条检查失去了目标,不是通过了');
    return m[1]
      .split(';')
      .map((d) => d.trim().replace(/\s+/g, ' '))
      .filter(Boolean);
  };

  test('Dashboard.html 和 Setup.html 的令牌逐条相同', () => {
    const a = rootDecls(read('Dashboard.html'));
    const b = rootDecls(read('Setup.html'));
    assert.ok(a.length > 30, `只抓到 ${a.length} 条声明,提取逻辑可能坏了`);

    const only = (x, y) => x.filter((d) => !y.includes(d));
    assert.deepEqual(
      { 只在Dashboard: only(a, b), 只在Setup: only(b, a) },
      { 只在Dashboard: [], 只在Setup: [] },
      '两页的设计令牌分叉了 —— 改了一页忘了另一页。未定义的变量不会报错,'
      + '它只会让那条声明失效,颜色/间距悄悄掉回继承值'
    );
  });

  /**
   * 运行时测量值不属于令牌块。
   *
   * `--topbar-h` 是 Dashboard 用 ResizeObserver 量出来的顶栏高度(表头靠它吸附),
   * 不是设计系统的一部分。把它写进 :root 的话,上面那条 parity 断言就永远红着,
   * 而"修"它的最省事办法是往 Setup 里也塞一个用不上的 --topbar-h —— 于是令牌块里
   * 开始混进和设计无关的东西,这条纪律就烂了。所以单独钉住。
   */
  test('--topbar-h 不在 :root 里,它是运行时测量值不是令牌', () => {
    const css = styleBlocks(read('Dashboard.html')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
    const root = css.match(/:root\s*\{([^{}]*)\}/)[1];
    assert.ok(!/--topbar-h/.test(root), '--topbar-h 不该出现在 :root 里');
    assert.match(css, /--topbar-h\s*:/, '但它得在别处有个默认值 —— JS 还没跑到的那一帧要用');
  });
});

describe('设置页:服务器还没起来时也要把界面装起来', () => {
  test('getSettings 的调用包在 try/catch 里', () => {
    // `call` 在服务器没起来时是**抛出**,不是返回 {error} —— 下面那条 `if (s.error)` 兜底
    // 根本轮不到。漏了 catch 的后果是 initSteps() 不跑:步骤条不出现、四节只剩第一节、
    // 按钮一个都没收起来(「下一步」和「保存并验证」并排摆着)。打包版里 Electron
    // 先开窗口再等子进程,正好撞这个窗口期。
    const js = inlineScripts(read('Setup.html')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
    const i = js.indexOf("call('getSettings'");
    assert.ok(i > 0, '找不到 getSettings 的调用');
    const around = js.slice(Math.max(0, i - 300), i + 200);
    assert.match(around, /try\s*\{/, 'getSettings 的调用没有包在 try 里');
    assert.match(around, /catch/, '没有 catch —— fetch 失败会让整个 load() 中断');
  });
});

/**
 * `aiReady` 落地之后只能重绘,不能重取
 * ------------------------------------------------
 * `aiReady` / `notionReady` 只影响**怎么画**,不影响**画什么**。写成 `loadDashboard()`
 * 就是为了翻一个布尔值把整个库重新拉一遍 —— 而那恰好让一个已经存在的竞态变得看得见:
 *
 * `aiReady` 初值 false,页面加载那次 `loadDashboard()` 立刻就跑了,所以「✨ 生成」在不在,
 * 取决于 `getSettings`(内存里读个对象)和 `getDashboardData`(读整个库)谁先回来。
 * 平时前者稳赢,所以平时看不出问题。**第一次设置完的那一下服务器正忙** —— startupJobs
 * 的全量同步、攻略发现、勾选都在跑,Node 单线程,顺序会翻:先画出一张没有按钮的表,
 * 然后要等第二次完整拉取排到队才补上。真实用户报过:刚连完 Notion 打开没有生成按钮,
 * 刷新一下就有了。改回 `loadDashboard()` 会把这条恢复路径重新变成最贵的那一条,
 * 而且贵在服务器最忙的时候。
 *
 * 源码断言:这段逻辑住在一个 IIFE 的异步回调里,零依赖没有 DOM,单测够不着 ——
 * 和 `onSyncState` 那条同源。
 */
describe('loadAiState 落地后只重绘', () => {
  test('那次补画调的是 render(),不是 loadDashboard()', () => {
    // **两种注释都要去。** 只去 `/* */` 的话,下面那条 `doesNotMatch` 会被这段逻辑
    // 自己的 `//` 解释性注释满足 —— 那段注释里正写着 `loadDashboard()`。
    // 和 tray.test.js 里那条同源;区别是这次它当场红了,不是空跑
    const js = inlineScripts(read('Dashboard.html'))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
    const i = js.indexOf('notionReady = Boolean(');
    assert.ok(i > 0, '找不到 loadAiState 里设 notionReady 的那一行');
    // 切到这一块再匹配,别让文件别处的 loadDashboard() 把断言喂饱
    const block = js.slice(i, js.indexOf('})();', i));
    assert.match(block, /\brender\(\)/, '补画必须调 render()');
    assert.doesNotMatch(
      block,
      /\bloadDashboard\(\)/,
      '这里调 loadDashboard() 等于为了一个布尔值重拉整个库,而且正好在服务器最忙时'
    );
  });

  test('补画前要确认 allGames 已经有数据', () => {
    // 反过来的顺序也要对:getSettings 先回来时 allGames 还是空的,
    // 这时 render() 会画出一张空表,然后被 loadDashboard 的结果覆盖 —— 闪一下"没有游戏"
    // **两种注释都要去。** 只去 `/* */` 的话,下面那条 `doesNotMatch` 会被这段逻辑
    // 自己的 `//` 解释性注释满足 —— 那段注释里正写着 `loadDashboard()`。
    // 和 tray.test.js 里那条同源;区别是这次它当场红了,不是空跑
    const js = inlineScripts(read('Dashboard.html'))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
    const i = js.indexOf('notionReady = Boolean(');
    const block = js.slice(i, js.indexOf('})();', i));
    assert.match(block, /allGames\.length/, '没有 allGames.length 守卫,先到的 getSettings 会画出一张空表');
  });
});

/**
 * 自托管字体
 * ------------------------------------------------
 * 这一组守的是**静默降级**:字体链接写错、文件没跟着走、打包过滤器漏了 assets ——
 * 四种情况没有一种会报错。页面照常渲染,只是悄悄退回系统字体,而那正是自带字体
 * 要解决的问题本身(换台机器就变样,且 600/650/700 在中文里塌成一档)。
 *
 * 打包那一条尤其值得钉:它**只在打包版失效**,`npm start` 永远看着是好的 ——
 * 和 CLAUDE.md 里 `icon.ico`、`updater.js` 踩过的是同一个坑。
 */
describe('搜索框一个人干两件事', () => {
  /** 去掉两种注释的内联脚本 —— 注释里正好也写着这些词,不去会把断言喂饱 */
  const js = () => inlineScripts(read('Dashboard.html'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');

  test('有搜索词时,四个勾选框一律让路', () => {
    // **这一条是「库里没有就去 Steam 加」那套的地基。** 不让路的话,「搜不到」有
    // 一半以上的概率意思是「被自己的筛选挡住了」—— 实测三个默认勾选框挡着 316 款
    // 里的 171 款 —— 于是搜一款已经打满的游戏,界面会建议你**再添加一次**。
    // 破坏方式很隐蔽:把 return 改成继续往下走,表格看起来只是「少了几行」
    const src = js();
    const i = src.indexOf('function hidingFilter');
    assert.ok(i > 0, '找不到 hidingFilter —— 这条检查失去了目标,不是通过了');
    const block = src.slice(i, src.indexOf('\n    }', i));
    const searchAt = block.indexOf('f.search');
    const firstCheckbox = block.indexOf('f.hideComplete');
    assert.ok(searchAt > 0 && firstCheckbox > searchAt, '搜索必须在勾选框之前判');
    // 搜索那一段必须自己 return 掉,不能落到下面的勾选框判断上
    const searchBranch = block.slice(searchAt, firstCheckbox);
    assert.match(searchBranch, /return/, '有搜索词时必须当场返回,不能继续过勾选框');
  });

  test('库里有没有,不能决定要不要去 Steam 搜', () => {
    // **这一条钉的正好是上一版的反面,而上一版是个 bug。**
    // 原来写的是「库里有就到此为止,不去 Steam 找」,那条规则把两件事混成一件:
    // 「找到了东西」不等于「找到了你要的那个东西」。想加 Silksong 的人打 silk、
    // 库里刚好有个 Silkroad —— 添加这条路就凭空消失,而且**看不出它消失了**。
    // 判断保留,但它只决定怎么显示(摊开还是折成一行)
    const src = js();
    const i = src.indexOf('function onSearchInput');
    assert.ok(i > 0, '找不到 onSearchInput');
    const block = src.slice(i, src.indexOf('\n    }', i));
    assert.match(block, /allGames\.some/, '要拿整个库判「有没有」,不是拿筛选后的行');
    assert.match(block, /setTimeout/, '搜索必须照发');
    // 「库里有」和「发请求」之间不能有 return —— 有的话就又变回那条挡路的规则了
    const hitAt = block.indexOf('libHit =');
    const timerAt = block.indexOf('setTimeout');
    assert.ok(hitAt > 0 && timerAt > hitAt, '判断在前、请求在后');
    // **从赋值那一行的行尾切起,不是从行首。** `libHit = allGames.some(function(g){ return … })`
    // 自己就带着一个 return,从行首切会被那个回调喂饱 —— 第一版就是这么假红的。
    // 要看的是「那一行之后到发请求之间」有没有控制流的 return
    const afterAssign = block.indexOf('\n', hitAt);
    assert.ok(afterAssign > 0 && afterAssign < timerAt, 'libHit 那行的行尾没找到');
    assert.doesNotMatch(
      block.slice(afterAssign, timerAt),
      /\breturn\b/,
      '判完库里有没有就 return,等于把添加这条路重新藏起来'
    );
  });

  test('库里已经有结果时,Steam 那份折成一行', () => {
    // 展开十行约 370px,而这一块住在冻结区里 —— 每次筛自己的库都顶掉十行表格,
    // 换来一份用户多半没在找的补充结果。折起来那一行的作用是**让「还能加」看得见**
    const src = js();
    const i = src.indexOf('function renderSearchResults');
    assert.ok(i > 0, '找不到 renderSearchResults');
    const block = src.slice(i, src.indexOf('\n    function ', i + 10));
    assert.match(block, /libHit && !steamExpanded/, '折叠的条件是「库里有」且「还没点开」');
    assert.match(block, /steam-more/, '要有那个可点的一行');
    // 展开时**不能再发一次请求** —— 结果已经在手上了
    assert.match(block, /renderSearchResults\(steamItems\)/, '展开是重画缓存,不是重新搜');
    assert.doesNotMatch(block, /searchSteamGames/, '展开那一步不该碰 rpc');
  });

  test('Steam 结果是 button,不是挂了 click 的 div', () => {
    // 它是「添加一个游戏」唯一的入口。做成 div 的话鼠标能用、键盘完全够不着 ——
    // tab 走不到、回车没反应,而这一点不会有任何东西报错
    const src = js();
    const i = src.indexOf('function renderSearchResults');
    assert.ok(i > 0, '找不到 renderSearchResults');
    const block = src.slice(i, src.indexOf('\n    }', i));
    assert.match(block, /<button type="button" class="game-search-result"/,
      '结果项必须是 button,而且要显式 type —— 默认的 submit 将来进了 form 会提交页面');
  });
});

describe('自托管字体', () => {
  const FONT_CSS = 'assets/fonts/noto-sans-sc.css';

  for (const page of ['Dashboard.html', 'Setup.html']) {
    test(`${page} 链接了字体样式表`, () => {
      assert.match(
        read(page),
        /<link[^>]+href="\/fonts\/noto-sans-sc\.css"/,
        `${page} 没有链接 /fonts/noto-sans-sc.css —— 页面会静默退回系统字体`
      );
    });

    test(`${page} 的 --font-ui 排在自带字体第一位`, () => {
      // 兜底栈留着是对的,但自带的那个必须在最前面,否则装了 Segoe UI 的机器
      // 依旧走系统字体,自托管等于白做
      const m = read(page).match(/--font-ui:\s*([^;]+);/);
      assert.ok(m, `${page} 的 :root 里没有 --font-ui`);
      assert.match(m[1].trim(), /^"Noto Sans SC Variable"/,
        `${page} 的 --font-ui 没把自带字体排在第一位:${m[1].trim()}`);
    });
  }

  test('字体样式表存在,且每个 woff2 分片都在', () => {
    const css = read(FONT_CSS);
    const urls = [...css.matchAll(/url\(\.\/([^)]+\.woff2)\)/g)].map((m) => m[1]);
    assert.ok(urls.length > 50, `分片数看着不对(${urls.length}),Noto Sans SC 应该有 100 上下`);
    const missing = urls.filter((u) => !existsSync(join(ROOT, 'assets', 'fonts', u)));
    assert.deepEqual(missing, [],
      `这些 @font-face 指向的文件不存在,对应字符会静默掉回系统字体:${missing.slice(0, 5).join(', ')}`);
  });

  test('OFL 要求随附协议文件', () => {
    assert.ok(existsSync(join(ROOT, 'assets', 'fonts', 'LICENSE')),
      'Noto Sans SC 是 OFL-1.1,协议要求分发时随附 LICENSE,而这个仓库是公开的');
  });

  test('打包过滤器带上了 assets/(漏了只有打包版会出问题)', () => {
    const pkg = JSON.parse(read('launcher/package.json'));
    const filter = pkg.build.extraResources[0].filter;
    assert.ok(filter.includes('assets/**/*'),
      'launcher/package.json 的 extraResources 过滤器没有 assets/**/*,'
      + '打包版会没有字体 —— 而 npm start 一切正常,所以这个漏掉不会被发现');
  });
});


/**
 * 推理强度那一格。**默认必须是高** —— 低档实测把 16 条里的 9 条写成套模板的句子
 * (「第 III 章全体查证正确即解锁」),而那是攻略一半以上的条目。默认漂到低档不会
 * 报任何错,只会让所有新攻略悄悄变薄。
 */
describe('确认框里的推理强度', () => {
  const dash = read('Dashboard.html');
  const markup = markupNoComments(dash);
  const js = inlineScripts(dash).join('\n').replace(/\/\/[^\n]*/g, '');

  // **把函数取出来真跑一遍,不要用正则查 `value: 'high'`。**
  // 第一版就是那么写的,而它永远不会失败 —— 选项列表里本来就有一条
  // `{ value: 'high', label: '高' }`,正则匹配到的是那一条,把默认值改成 low 照样绿。
  // 变异测试抓到的。这个函数没有依赖,取出来执行是唯一说得准的办法
  const effortChoice = (() => {
    const at = js.indexOf('function effortChoice');
    const end = js.indexOf('\n    }', at) + '\n    }'.length;
    return new Function(js.slice(at, end) + '; return effortChoice;')();
  })();

  test('默认是高,而且三档齐全', () => {
    assert.equal(effortChoice().value, 'high',
      '低档会把一半以上的条目写成模板句 —— 默认漂过去不会报错,只会让攻略悄悄变薄');
    assert.deepEqual(effortChoice().options.map((o) => o.value), ['low', 'medium', 'high'],
      '顺序也是内容:从左到右是从省到深,反过来会让人按位置选错');
    assert.equal(effortChoice().label, '推理强度');
  });

  test('选中态要报出来,而且两处都要写', () => {
    // ui-ux-pro-max 把这条列为 Critical:紧凑控件要暴露 pressed/selected 状态。
    // **只查"出现过"不行** —— 初次渲染和点击换选各写一处,删掉其中一处照样绿,
    // 而那正好是「报了但从此不更新」的样子。变异测试抓到的
    const at = js.indexOf('function askConfirm');
    const body = js.slice(at, js.indexOf('\n    }', at));
    const writes = (body.match(/aria-pressed/g) ?? []).length;
    assert.ok(writes >= 2,
      `askConfirm 里只写了 ${writes} 处 aria-pressed。初次渲染和点击换选都要写,`
      + '少一处就是"报了但不更新",比不报更误导');
  });

  test('视图切换的每一个按钮都报选中态', () => {
    // **逐个查,不是"有一个带就算过"** —— 漏掉的那个就是永远不报状态的那个
    const btns = markup.match(/<button[^>]*data-view[^>]*>/g) ?? [];
    assert.ok(btns.length >= 2, '视图切换的按钮找不到了');
    for (const b of btns) {
      assert.match(b, /aria-pressed/,
        `这个按钮不报选中态:${b} —— 同一页两个分段控件,一个报一个不报比都不报更糟`);
    }
  });

  test('选的那一档要真的跟着请求走', () => {
    // 控件做出来、值没传下去 —— 界面上一切正常,而每次跑的还是默认档
    assert.match(js, /startGuideGen\(appid, false, choice\.value\)/, '生成那一路');
    assert.match(js, /startGuideGen\(appid, true, rewriteChoice\.value, scope\)/, '重写那一路');
  });

  test('局部重写的范围要真的跟着请求走,而且和整篇互斥', () => {
    // 范围选了、值没传下去,表现是每次都整篇重写 —— 而那正好是这个功能要避免的
    // 那件事,还带着「已改 N 条」的成功提示。界面上一切正常
    assert.match(js, /scopeChoice\.value === 'all'\s*\n?\s*\?\s*null/,
      '选「整篇」必须传 null,而不是传一个 selector 为 all 的 scope —— '
      + '服务端按 scope 是否为空分流,两个都给会让"跑了哪条"取决于判断顺序');
    assert.match(js, /selector: scopeChoice\.value/, '范围要进 scope.selector');
    assert.match(js, /note: noteInput\.value/, '那句要求也要传下去,不然输入框是个摆设');
  });

  test('Enter 不能绕过这个框里的三道闸', () => {
    // 这个框现在有两个输入框(「怎么改」、挑选列表的筛选),而界面是中文的:
    // 打字时每选一次候选词都会按 Enter。不挡的话,写「把互斥关系写清楚」的过程中
    // 会当场把这次要花钱、且不可逆的操作确认掉。
    //
    // **断言钉意图,不钉写法** —— 上一版查的是字面的 `askInput`,而把
    // `document.getElementById('askInput')` 换成一个局部变量就让它红了,
    // 尽管那条规矩一个字没变
    const fn = js.slice(js.indexOf('function onKey'));
    const body = fn.slice(0, fn.indexOf('\n        }')).replace(/\/\/[^\n]*/g, '');
    assert.match(body, /isComposing/, '组词中的 Enter 要挡掉');
    assert.match(body, /e\.target ===/, '要按焦点在哪儿区分:人还在输入框里打字,不是在决定');
    assert.match(body, /okBtn\.disabled/,
      '确定按钮被闸住的时候 Enter 也要挡 —— 否则「挑几条却一条没勾」能靠回车绕过去');
  });

  test('挑几条却一条没勾时,确定按钮是闸住的', () => {
    // 空选择发出去 = 一个选不中任何成就的请求,而它会在服务端才被拒。
    // 闸门要放在按钮上:让人**看见**为什么点不了,而不是点下去再收一条错误
    assert.match(js, /pickerShown\(\)\s*&&\s*o\.picker\.selected\.size === 0/,
      '空选择必须让确定按钮不可点');
    // 这个弹窗是复用的同一个 DOM,不无条件复位的话,下一个不带 picker 的框
    // 会开出来就点不动,而且没有任何理由解释自己为什么点不动
    const sync = js.slice(js.indexOf('function syncPicker'));
    assert.match(sync.slice(0, sync.indexOf('\n        }')), /refreshOk\(\)/,
      'refreshOk 要无条件跑,负责把上一次留下的 disabled 复位');
  });

  test('挑几条发出去的是 api_name 列表,不是成就名', () => {
    // 同名成就按名字点不动(库里真有 12 组同名),用名字会让请求在服务端被判成
    // unresolved —— 而界面上刚刚明明勾中了它
    assert.match(js, /\[\.\.\.picker\.selected\]\.join\(','\)/,
      '选中的是 api_name,直接逗号拼成显式列表交给 resolveScope');
  });

  test('确认框不再写死时长', () => {
    // 同样输入实测 76/174/337 秒,而且推理强度可调之后低档快八倍 —— 任何写死的
    // 区间都是在承诺一个给不出的东西。时长看进度条
    const noBlockComments = js.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(markup + noBlockComments, /约 \d[–-]\d 分钟/, '这句话在低档上会当场变错');
  });
});
