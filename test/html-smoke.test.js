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

/** 拼接多段内联脚本用的分隔符 */
const SEP = String.fromCharCode(10);

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
      // **第三种写法:`document.createElement('tag')`。** 少了这条,一个只由 DOM API
      // 造出来的标签会被报成"规则静默失效",而它在页面上明明存在 —— 存档面板的
      // `.arc-main b` 就是这么撞上的。以前没暴露纯属巧合:createElement 造的
      // div/span/button/li 恰好在别处也以 `<tag` 出现过,`b` 是第一个没有的
      const created = new Set(
        [...src.matchAll(/createElement\(\s*['"]([a-zA-Z][a-zA-Z0-9-]*)['"]/g)].map((m) => m[1].toLowerCase())
      );
      const orphans = [...cssTypeSelectors(styleBlocks(html).join('\n'))]
        .filter((tag) => !TAG_WHITELIST.has(tag)
          && !created.has(tag)
          && !new RegExp(`<${tag}[\\s>]`).test(src));
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
   * 用户实报两次,同一条规则:**说明步骤里出现的英文必须是控件上此刻的原字。**
   *
   * 2026-08-17 —— 照着第 3 步去 Notion,屏幕上找不到「Internal Integration」,因为那是
   * 概念名,Notion 上一处都没有。2026-08-29 —— 同一段话又对不上了,这次是 Notion 自己
   * 改的:按钮从 `New integration` 变成 `New connection`,密钥从 `Integration Secret`
   * 变成 `Access token`,开发者页面也从 `notion.so/my-integrations` 挪走了。
   *
   * 两次的症状一样:照着找的人卡在那儿,而**这种错什么都不会报**。
   *
   * 断言切的是那份 `<ol>`,不是整个 step。**步骤里出现旧名字才算错,step 里出现不算** ——
   * 这一步随时可能长出别的句子,而只要那句话里带着旧词,对整个 step 的匹配就会被喂饱,
   * 指引改错了也照样绿。这不是假想:第一版正是对整个 step 匹配的,改成 `New connection`
   * 之后测试一声没吭,因为当时步骤下面挂着一行写有旧名字的对照。
   */
  const notionSteps = (html) => {
    const step = stepBlock(html, 3);
    const a = step.indexOf('<ol>');
    const b = step.indexOf('</ol>', a);
    assert.ok(a > 0 && b > a, '切不到第 3 步的步骤列表');
    return step.slice(a, b);
  };

  test('Notion 那一步引的是界面此刻的原字', () => {
    const ol = notionSteps(read('Setup.html'));
    assert.match(ol, /New connection/, '按钮的原字。用户是照着这段话在屏幕上找东西的');
    assert.match(ol, /Access token/, '密钥那一栏的原字');
    assert.doesNotMatch(ol, /Internal\s+Integration/i,
      '「Internal Integration」是概念名,Notion 上一处都没有 —— 等于让人去找一个不存在的标签');
    assert.doesNotMatch(ol, /my-integrations/,
      '开发者页面已经不在这个地址了');
  });

  // 这一步上不放旧名字的对照 —— 步骤统共两条,旁边挂一行同义词,读的人得先分辨
  // 哪一组是给自己看的。旧名字留在 docs/notion-setup.md 里
  test('这一步不并排摆新旧两套叫法', () => {
    const step = stepBlock(read('Setup.html'), 3);
    assert.doesNotMatch(step, /New integration|Integration Secret/,
      '旧叫法属于走查文档,不属于这两行步骤');
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

  test('有搜索词时,五个筛选芯片一律让路', () => {
    // **这一条是「库里没有就去 Steam 加」那套的地基。** 不让路的话,「搜不到」有
    // 一半以上的概率意思是「被自己的筛选挡住了」—— 实测三个开局在排除态的芯片挡着
    // 316 款里的 171 款 —— 于是搜一款已经打满的游戏,界面会建议你**再添加一次**。
    // 破坏方式很隐蔽:把 return 改成继续往下走,表格看起来只是「少了几行」
    const src = js();
    const i = src.indexOf('function hidingFilter');
    assert.ok(i > 0, '找不到 hidingFilter —— 这条检查失去了目标,不是通过了');
    const block = src.slice(i, src.indexOf('\n    }', i));
    const searchAt = block.indexOf('f.search');
    const chipLoop = block.indexOf('FILTERS.length');
    assert.ok(searchAt > 0, 'hidingFilter 里找不到 f.search');
    assert.ok(chipLoop > searchAt, '搜索必须在芯片循环之前判');
    // 搜索那一段必须自己 return 掉,不能落到下面的芯片循环上
    const searchBranch = block.slice(searchAt, chipLoop);
    assert.match(searchBranch, /return/, '有搜索词时必须当场返回,不能继续过芯片');
  });

  test('芯片和 FILTERS 表两边的 key 必须一一对上,顺序也要一致', () => {
    // **漏一边不会报错,只会「点了没反应」。** 事件是委托给容器的,所以 markup 里多
    // 一个芯片照样会循环换色 —— 只是 hidingFilter 那个循环里没有它,表格一行不动。
    // 反过来 FILTERS 里多一行,则是一个永远读不到状态的属性:currentFilters 只收
    // markup 里存在的芯片,f[key] 是 undefined,既不是 'only' 也不是 'not',
    // 于是被静默 continue 掉。**两个方向都是沉默的**,所以只能在这里钉。
    //
    // 顺序也一起钉:屏幕上的顺序是按常用度排的(两个想「只看」的在前,三个开局
    // 挡掉的在后),而 FILTERS 的顺序决定「被谁挡住了」报的是哪一个 —— 两边错开
    // 之后那句话会指着一个不相干的芯片说「点这里」
    const src = js();
    const table = src.slice(src.indexOf('const FILTERS = ['), src.indexOf('const NEXT_STATE'));
    const inTable = [...table.matchAll(/key:\s*'([a-z]+)'/g)].map((m) => m[1]);
    const page = read('Dashboard.html');
    const chipsAt = page.indexOf('id="filterChips"');
    const inMarkup = [...page.slice(chipsAt, chipsAt + 3000).matchAll(/data-filter="([a-z]+)"/g)]
      .map((m) => m[1]);
    assert.ok(inTable.length >= 5, 'FILTERS 表读空了 —— 这条检查失去了目标,不是通过了');
    assert.deepEqual(inMarkup, inTable, '芯片和 FILTERS 必须同名同序');
  });

  test('三态的循环方向是 中立 → 只看 → 排除', () => {
    // **方向不是随手定的,反过来会让两件最常做的事各多一次点击。**
    // 三个状态排成一个环,中立只有一个前驱,所以只有一条路是一次点击。开局时
    // 喜爱/家庭在中立、另外三个在排除 —— 前者的下一步通常是「只看」,后者是
    // 「回中立」(取消隐藏去找一款游戏),这个方向正好让两者各一次点击。
    // 反过来排的话双双变成两次,而**表格照样能用**,不会有任何东西报错,
    // 只是每天多点几十下 —— 正是那种改了没人发现的退步
    const src = js();
    const m = src.match(/const NEXT_STATE = \{([^}]+)\}/);
    assert.ok(m, '找不到 NEXT_STATE');
    assert.match(m[1], /off:\s*'only'/, '中立的下一格必须是只看');
    assert.match(m[1], /only:\s*'not'/, '只看的下一格必须是排除');
    assert.match(m[1], /not:\s*'off'/, '排除的下一格必须是中立');
  });

  test('开局状态:喜爱和家庭中立,其余三个排除', () => {
    // 默认视图必须和勾选框那一版**逐行相同** —— 三个「隐藏」勾选框默认勾上,
    // 对应的就是排除态。改这里等于改所有人打开页面看到的第一屏,而它不报错
    const page = read('Dashboard.html');
    const chipsAt = page.indexOf('id="filterChips"');
    const states = [...page.slice(chipsAt, chipsAt + 3000)
      .matchAll(/data-filter="([a-z]+)" data-state="([a-z]+)"/g)].map((m) => m[1] + ':' + m[2]);
    assert.deepEqual(states, ['fav:off', 'family:off', 'complete:not', 'unvetted:not', 'noach:not']);
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

/**
 * 搜索框里的清除叉
 * ------------------------------------------------
 * 这一组守的是**按下去什么都不发生**:叉画出来了、点得到、value 也清了,而屏幕上
 * 一个字没变。页面不报错,叉看起来是好的。
 *
 * 两条各守一头,都是静默的:
 *
 * - **露不露面这一头是纯 CSS 的。** `:placeholder-shown` 是「框里没字」唯一的判据,
 *   它要求框一直有 placeholder —— 谁把 placeholder 换成一个可见 label(这个页面
 *   别处正是这么做的),叉就永远挂在空框上,按了没反应。
 * - **清空那一头是 JS 的。** 搜索框上挂着两条 input 监听,弹框里那个筛选框挂的是
 *   它自己的 oninput,只把 value 抹掉一条都不会跑:表格还是搜索结果、Steam 那块
 *   还开着,而输入框已经空了。
 */
describe('搜索框里的清除叉', () => {
  const page = () => read('Dashboard.html');
  /** 去掉两种注释的内联脚本 —— 注释里正好写着这些词,不去会把断言喂饱 */
  const js = () => inlineScripts(page())
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');

  test('.search-field 里的输入框都留着 placeholder,叉也都在', () => {
    const fields = [...markupNoComments(page()).matchAll(/<div class="search-field">([\s\S]*?)<\/div>/g)];
    assert.ok(fields.length >= 2, '找不到 .search-field —— 这条检查失去了目标,不是通过了');
    for (const [, inner] of fields) {
      const input = inner.match(/<input[^>]*>/);
      assert.ok(input, '.search-field 里必须有一个 input');
      assert.match(input[0], /\splaceholder="[^"]+"/,
        '叉的显隐靠 :placeholder-shown,没有 placeholder 它会一直挂在空框上');
      assert.match(inner, /class="field-clear"/, '.search-field 里必须有那个叉');
    }
  });

  test('叉是压在框里的,不是排在框后面', () => {
    // 排在后面的话它一出现一消失就把右边推一下,而搜索框在冻结区里、每敲一个字符
    // 都要重算一次高度。**内缩也必须是常留的**:只在有字时才留位置,打下第一个
    // 字符的瞬间已经打出来的字会自己往左跳一格
    const css = styleBlocks(page()).join(SEP).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(css, /\.search-field\s*\{[^}]*position:\s*relative/, '.search-field 要当定位参照');
    assert.match(css, /\.field-clear\s*\{[^}]*position:\s*absolute/, '叉要绝对定位');
    const pad = css.match(/\.search-field input\s*\{([^}]*)\}/);
    assert.ok(pad, '找不到给叉腾位置那条规则 —— 这条检查失去了目标,不是通过了');
    assert.match(pad[1], /padding-right:/, '输入框右侧要常留出叉的位置');
  });

  /** 那一处绑定的整段:从 forEach 开头切到它自己的收尾,两头都是真锚点 */
  const bindBlock = () => {
    const src = js();
    const from = src.indexOf("document.querySelectorAll('.search-field').forEach");
    assert.ok(from > 0, '找不到清除叉那段绑定 —— 这条检查失去了目标,不是通过了');
    const to = src.indexOf('\n    });', from);
    assert.ok(to > from, '切不到那一段的收尾');
    return src.slice(from, to);
  };

  test('清完要派 input 事件,不能只把 value 抹掉', () => {
    assert.match(bindBlock(), /dispatchEvent\(\s*new Event\('input'/,
      '清完必须派 input 事件 —— 点名调用那几个处理函数,漏一条就是「清空了但结果还在」');
  });

  test('Esc 只在框里有字时才拦,没字要放给弹框去关', () => {
    // 弹框里那个筛选框上,Esc 的另一层意思是关掉整个弹框。无条件 stopPropagation
    // 的话,空着的筛选框会把弹框的出口吃掉 —— 按 Esc 没反应,而且看不出为什么
    const block = bindBlock();
    const guard = block.indexOf("input.value === ''");
    const stop = block.indexOf('stopPropagation');
    assert.ok(guard > 0, 'Esc 那条守卫必须同时判键名和「框里有没有字」');
    assert.ok(stop > guard, '先判有没有字,有字才拦下这次 Esc');
  });
});

describe('最近在玩:徽章和置顶共用一个窗口', () => {
  // **两者各写各的天数,是一种不会报错的坏。** 表现是某一行排到最上面,而行上
  // 没有任何东西说明为什么 —— 用户只会觉得排序坏了。CLAUDE.md 把这条写成规矩,
  // 但在这条测试之前没有任何东西拦着它。
  const js = () => inlineScripts(read('Dashboard.html'))
    .join(SEP)
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1')   // **先行注释再块注释**,见 CLAUDE.md
    .replace(/\/\*[\s\S]*?\*\//g, '');
  /** 某个函数的函数体 */
  const bodyOf = (src, name) => {
    const i = src.indexOf('const ' + name + ' = ');
    assert.ok(i > 0, `找不到 ${name} —— 这条检查失去了目标,不是通过了`);
    return src.slice(i, src.indexOf('};', i));
  };

  test('窗口只有一个数,写在一个具名常量里', () => {
    // 散在两处的字面量没法共用,而"共用"正是这一组要保的东西
    assert.match(js(), /const RECENT_PLAY_DAYS = \d+;/, '窗口必须是一个具名常量');
  });

  test('徽章读的是那个常量,不是自己写的数字', () => {
    assert.match(bodyOf(js(), 'isRecentlyPlayed'), /RECENT_PLAY_DAYS/);
  });

  test('置顶建立在徽章之上,不自己再算一遍天数', () => {
    // **置顶可以多加条件,但不能另起一个窗口。** 多的那个条件(有成就可追)是
    // 有意的不对称:有徽章没置顶讲得通,有置顶没徽章讲不通
    const pin = bodyOf(js(), 'pinsToTop');
    assert.match(pin, /isRecentlyPlayed\(/, '置顶必须走 isRecentlyPlayed');
    assert.doesNotMatch(pin, /playedDaysAgo|RECENT_PLAY_DAYS/,
      '置顶里不该再出现天数比较 —— 那就是第二个窗口');
  });

  test('置顶还要求真的有成就可追', () => {
    // 只挡 'N/A' 等于没挡:"没进度可看"有三种长相(N/A、null、0),而 null
    // 最常见 —— 刚加进库的游戏正好既是最近在玩、又还没同步到成就数
    assert.match(bodyOf(js(), 'pinsToTop'), /typeof g\.total === 'number' && g\.total > 0/);
  });
});

describe('筛选芯片的状态记号', () => {
  // 三个状态的差别全靠这一个 9x9 的记号,而**改坏它不会有任何东西报错** ——
  // 页面照常渲染,筛选照常工作,只是每天扫几十遍的那一行开始读错意思。
  const css = () => styleBlocks(read('Dashboard.html')).join(SEP).replace(/\/\*[\s\S]*?\*\//g, '');
  /** 记号那一段:从 .chip-dot 开始,到下一个不相干的规则为止 */
  const markBlock = () => {
    const s = css();
    const from = s.indexOf('.chip-dot {');
    const to = s.indexOf('input[type="text"] {', from);
    assert.ok(from > 0 && to > from, '找不到记号那一段 —— 这条检查失去了目标,不是通过了');
    return s.slice(from, to);
  };

  test('排除态是两笔反向的对角线,不是一条横杠', () => {
    // **一条横杠是「部分选中」,不是「排除」。** HTML 的 indeterminate、各家系统的
    // 半选框,画的都是一条杠;图标库里 minus 的语义也是 subtract/decrease ——
    // 「减掉一部分」。而这一格要说的是「整个去掉」。同一个字形背两个相反的意思,
    // 读的人得先猜是哪一个,于是改成叉。
    // **退回横杠的方式很安静**:删掉 ::after 那半边规则就行,剩下的一笔正好是杠。
    const b = markBlock();
    const not = b.slice(b.indexOf('[data-state="not"]'));
    assert.match(not, /rotate\(45deg\)/, '排除态要有一笔转 +45°');
    assert.match(not, /rotate\(-45deg\)/, '排除态要有另一笔转 -45° —— 只有一笔就退回横杠了');
    assert.match(not, /\.chip-dot::before/, '第一笔');
    assert.match(not, /\.chip-dot::after/, '第二笔');
  });

  test('第二笔平时宽度为 0,否则中立态会多出一小块', () => {
    // ::after 在中立和只看两态都不该看得见。0 宽的盒子什么都不画,是这里唯一
    // 不用额外规则就能做到「不存在」的写法
    const b = markBlock();
    const base = b.slice(0, b.indexOf('[data-state='));
    assert.match(base, /\.chip-dot::after\s*\{[^}]*width:\s*0\b/,
      '::after 的初始宽度必须是 0');
  });

  test('点亮态的光晕只能挂在第一笔上', () => {
    // **box-shadow 的 spread 不看盒子有没有宽度。** 挂到宽度为 0 的 ::after 上,
    // 会在圆点边上凭空画出一块 6x8 的圆角方块 —— 只在「只看」这一态出现,
    // 而且看起来像渲染 bug,不像写错的规则
    const b = markBlock();
    const rules = [...b.matchAll(/([^{}]+)\{([^}]*box-shadow:\s*0 0 0[^}]*)\}/g)];
    assert.ok(rules.length >= 1, '找不到光晕那条规则 —— 这条检查失去了目标,不是通过了');
    for (const [, sel] of rules) {
      assert.doesNotMatch(sel, /::after/, '光晕不能挂到 ::after 上:' + sel.trim());
    }
  });

  test('关掉动效时,记号不能还在转', () => {
    // 记号现在会转 45°,这正是 prefers-reduced-motion 要关掉的那种动作。
    // **上一版这条规则选的是 .filter-chips** —— 容器身上根本没有 transition,
    // 那条规则从写下那天起就没生效过,而且它看起来完全正常
    const s = css();
    const rm = s.slice(s.indexOf('@media (prefers-reduced-motion'));
    assert.ok(rm.length > 0, '找不到 reduced-motion 那一段');
    assert.match(rm, /\.chip-dot::before/, '要关掉的是伪元素身上的过渡');
    assert.match(rm, /\.chip-dot::after/, '两笔都要关');
    // 反过来钉住:过渡确实挂在伪元素上,不在容器上 —— 否则上面两条又变成空转
    assert.match(markBlock(), /\.chip-dot::before,\s*\n?\s*\.chip-dot::after\s*\{[^}]*transition:/,
      '过渡必须挂在两个伪元素上');
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
 * 写法那一格。**默认必须是「深度模式」** —— 极速档实测把 16 条里的 9 条写成套模板的句子
 * (「第 III 章全体查证正确即解锁」),而那是攻略一半以上的条目。默认漂到极速不会
 * 报任何错,只会让所有新攻略悄悄变薄。
 */
describe('确认框里的写法', () => {
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

  test('默认是深度模式,而且只有两档', () => {
    assert.equal(effortChoice().value, 'high',
      '极速档会把一半以上的条目写成模板句 —— 默认漂过去不会报错,只会让攻略悄悄变薄');
    // **medium 不能回到屏幕上。** 同一次测量里它和 high 分不开(都是 0 条模板句,
    // 时间差在噪声里),摆出来就是让人在一个量不出区别的选择上停下来权衡,
    // 而唯一诚实的说明是「这两个一样」。config.json 里照样收,这里只管屏幕
    assert.deepEqual(effortChoice().options.map((o) => o.value), ['low', 'high'],
      '顺序也是内容:从左到右是从省到深,反过来会让人按位置选错');
    assert.equal(effortChoice().label, '写法');
  });

  test('每一档都说清楚选它会失去什么', () => {
    // 「极速模式/深度模式」这两个名字本身不解释任何东西 —— 没有这一句,想省钱的人不知道
    // 省掉的是什么,而那正是这一格唯一要回答的问题
    for (const o of effortChoice().options) {
      assert.ok(o.hint && o.hint.length > 8, `${o.label} 没有说明`);
    }
    // 极速那句必须点到**模板句**。这是整次 A/B 里唯一测出来的代价(16 条里 9 条),
    // 也是他选之前唯一需要知道的事;换成"内容差一点"之类的软话就等于没说
    const low = effortChoice().options.find((o) => o.value === 'low');
    assert.match(low.hint, /模板/,
      '省下来的代价具体是"变成模板句" —— 说软了就帮不了人做决定');
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
      '确定按钮被闸住的时候 Enter 也要挡 —— 否则「自选却一条没勾」能靠回车绕过去');
  });

  test('自选却一条没勾时,确定按钮是闸住的', () => {
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

  test('planPatch 的"只要 plan"捷径判的是 null,不是假值', () => {
    // 这条钉在源码上,因为触发它要 Steam 和 Notion。`if (!selector)` 会把用户敲的
    // `--only ""` 也走进内部捷径,交回 scope: null,调用方紧接着读 .apiNames 崩掉 ——
    // 一个有专属错误码和终端建议的用户错误,变成一句看不懂的 TypeError
    const src = readFileSync(new URL('../lib/guidepatch.js', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    assert.match(src, /if \(selector === null \|\| selector === undefined\)/,
      '内部捷径必须只认 null/undefined —— 空字符串是用户错误,该照常抛 empty-scope');
  });

  test('自选发出去的是 api_name 列表,不是成就名', () => {
    // 同名成就按名字点不动(库里真有 12 组同名),用名字会让请求在服务端被判成
    // unresolved —— 而界面上刚刚明明勾中了它
    assert.match(js, /selector: \[\.\.\.picker\.selected\]\.join\(','\)/,
      '选中的是 api_name,直接逗号拼成显式列表交给 resolveScope');
  });

  test('筛选片只改显示,一个字都不碰选择', () => {
    /**
     * **这是这一格的核心不变式,也是它前两版各自的死因。**
     *
     * 一版是"批量选中"开关:亮起来表示"这一批已经全在选择里" —— 一个推导出来的
     * 事实,用户却读成"我按过这个键"。属性之间相交(那唯一一条未解锁的成就恰好也
     * 稀有),于是点「稀有」会让「未解锁」跟着亮,再点它又把「稀有」弄暗。
     *
     * 二版改成"一次性加进选择、不带状态":连锁没了,但只会做并集 ——「既稀有又
     * 没打的」表达不出来,只能选完 22 条再一条条取消。
     *
     * 现在是筛选。**只要它不碰 selected,按下态就重新是诚实的**(它表示"我按下了
     * 这个筛选"),交集也白捡:两片都按下就是且。所以这里钉的不是某个写法,是
     * 那条边界 —— 处理函数里一旦出现 sel,一版的连锁就有路回来了。
     */
    const fn = js.slice(js.indexOf('function paintFilters'));
    const body = fn.slice(0, fn.indexOf('\n        }')).replace(/\/\/[^\n]*/g, '');
    assert.match(body, /active\.(add|delete)/, '点一下切换的是筛选状态');
    // `sel` 和 `selected` 都要挡。第一版只写了 `\bsel\b`,而变异验证里最自然的那种
    // 破坏方式(`o.picker.selected.add(...)`)从它底下走过去了 —— `\b` 在 "selected"
    // 的 sel 后面不成立。**只钉住局部变量名等于只钉住一种写法**
    assert.doesNotMatch(body, /\bsel(ected)?\b/, '筛选不许碰选择 —— 碰了就又变回"批量选中"');
    assert.match(body, /aria-pressed/, '它现在真的是开关(筛选的开关),要报按下状态');

    // 收下这批是另一个按钮的事,而它收的必须是**显示出来的**那批
    assert.match(js, /pickAll\.onclick/, '要有「全选」');
    assert.match(js, /shownItems\(\)\.forEach/, '全选收的是显示出来的那批');
    assert.match(js, /pickClear\.onclick/, '要有「清空」');
    assert.match(js, /o\.picker\.selected\.clear\(\)/, '清空要真的清');
  });

  test('列表画谁和全选收谁,判据只有一处', () => {
    // 两处各写一遍筛选条件,「全选」就会悄悄收下屏幕上没有的东西 —— 而下一步
    // 是花钱且不可逆的。所以 shownFilter() 是唯一的判据,列表和 shownItems 都用它
    assert.equal((js.match(/function shownFilter\(\)/g) ?? []).length, 1);
    assert.match(js, /const ok = shownFilter\(\);/, '列表用它');
    assert.match(js, /return pickerItems\(\)\.filter\(shownFilter\(\)\);/, '全选那批也用它');
    assert.match(js, /g\.items\.filter\(ok\)/, '每个小节按同一个判据过滤');
  });

  test('勾一个条目要更新「已选 N 条」', () => {
    /**
     * 这条钉一个**真出现过**的 bug:计数原来只写在 `paintPicker` 末尾,而勾单个条目
     * 故意不重绘整列表(重绘会把滚动位置弹回顶上),于是那一行卡在上一次整体重绘的值上。
     *
     * 抓到它靠的是拿 DOM 里真实勾上的框数去比显示的数 —— 光看界面看不出来,
     * 那一行自己长得一点问题都没有。现在这行数字是屏幕上唯一说"选了多少"的地方
     * (确认框的正文已经删光),更没有第二处能对出来
     */
    assert.match(js, /function paintCount\(\)/,
      '计数要单拎成一个函数,才可能被单条勾选那条路调用');
    const handler = js.slice(js.indexOf("cb.addEventListener('change'"));
    const body = handler.slice(0, handler.indexOf('\n              });')).replace(/\/\/[^\n]*/g, '');
    assert.match(body, /paintCount\(\)/, '勾单条时必须刷新计数');

    // 范围只剩一个真正的二选一
    const scope = js.slice(js.indexOf('const scopeChoice = {'));
    const opts = scope.slice(0, scope.indexOf('\n      };'));
    assert.match(opts, /value: 'all'/);
    assert.match(opts, /value: 'pick'/);
    assert.doesNotMatch(opts, /'rare'|'locked'|'failing'/,
      '算出来的那几批不再是范围档位 —— 它们是列表里的快捷选择');
  });

  test('重写确认框不写正文', () => {
    /**
     * 四轮删下来一句不剩,每一句都是在复述屏幕上已有的东西:时长(实测同样的输入
     * 跑出 76/174/337 秒,写死就是错的)、「现有 51 个 checkbox 会被整份替换」
     * (「整篇」两个字已经说了)、「只改选中的 27 条」(旁边就是「已选 27 条」)、
     * 「原文先备份」(我们这边的保底措施,不是他要决定的事),最后是
     * 「N 个手动勾的子步骤会变回未勾选」——「重写」本身就含这个意思,何况备份还在。
     *
     * **损失不是没人说,是换了个地方说:** CLI 的 `formatPreflight` 照旧把要丢的
     * 手动勾选逐条印出来(guideoverwrite.test.js 钉着那一条)。命令行是给敲了 flag
     * 的人看的,可以详细;界面上要短 —— 一份措辞硬凑给两边用,两边都不合适。
     */
    const call = js.slice(js.indexOf("title: '重写《'"));
    const args = call.slice(0, call.indexOf('\n      });')).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(args, /picker: picker/, '(先确认切到的确实是重写那个框)');
    assert.doesNotMatch(args, /body:/, '范围、条数、要求都写在控件上,正文只会是复述');
  });

  test('稀有的阈值由服务端下发,前端不自己写一个 15', () => {
    // 界面上标成"稀有"的那批,必须和提示词判断"哪几条要写深"是同一条线。
    // 两处各写一个数,漂了也没人会发现 —— 表现只是"界面说它稀有、程序不这么认为"
    assert.match(js, /sc && sc\.rarePct/, '阈值从 previewGuidePatch 的返回值里取');
    assert.match(js, /o\.picker\.rarePct/, '条目上色也用同一个值');
  });

  test('没有正文的框要把那一格收起来,不是留一块空白', () => {
    // 重写那个框现在一句正文都不写,而 #askBody 是常驻 markup —— 只清空 textContent
    // 的话会留下一块带 margin 的空div,框看着像是渲染坏了。
    //
    // 顺带钉住另一半:有正文的框(删除、迁移)要照常显示出来。askConfirm 有六个调用点,
    // 这两支各有人走
    assert.match(js, /bodyEl\.textContent = o\.body \|\| ''/);
    assert.match(js, /bodyEl\.style\.display = o\.body \? '' : 'none'/);
  });

  test('确认框不再写死时长', () => {
    // 同样输入实测 76/174/337 秒,而且写法可选之后极速档快八倍 —— 任何写死的
    // 区间都是在承诺一个给不出的东西。时长看进度条
    const noBlockComments = js.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(markup + noBlockComments, /约 \d[–-]\d 分钟/, '这句话在低档上会当场变错');
  });
});

/**
 * 供应商切换:每家记自己的 key 和模型。
 *
 * 源码断言,理由和 `loadAiState` 那两条同源 —— 这段逻辑住在页面脚本里,零依赖没有
 * DOM,单测够不着。两条都对着**静默**的失败:出错不报,只是把事情做成了另一件事。
 */
describe('AI 供应商切换', () => {
  /** 只留代码:两种注释都剥,否则解释这条规则的注释就把断言喂饱了 */
  const setupJs = () =>
    inlineScripts(read('Setup.html'))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');

  /** 切到 paintAiProvider 那个函数体。**用真锚点,不用字节数** —— 窗口会随内容长短悄悄挪 */
  const paintBlock = () => {
    const js = setupJs();
    const i = js.indexOf('function paintAiProvider');
    assert.ok(i > 0, '找不到 paintAiProvider');
    const j = js.indexOf("$('ai-provider').addEventListener('change'", i);
    assert.ok(j > i, '找不到 paintAiProvider 后面的 change 监听 —— 切块的下界没了');
    return js.slice(i, j);
  };

  test('选项文案从 dataset.label 重画,不从当前 textContent', () => {
    // 直接 `opt.textContent += ' · 已配置'` 第一次是对的,**第二次重画就叠上去**:
    // 「DeepSeek · 已配置 · 已配置」。而重画每次切供应商都会发生,所以这是个
    // 用两下就出现、却不报任何错的失败
    const block = paintBlock();
    assert.match(block, /opt\.dataset\.label/, '基础文案必须存在 dataset 里');
    assert.match(block, /opt\.textContent = /, '重画是整个赋值,不是追加');
    assert.doesNotMatch(block, /textContent\s*\+=/, '追加会让标记一次次叠上去');
  });

  test('每家自己的 model 画回输入框', () => {
    // model 和 key 一样是一家一个值(见 lib/config.js 的 ai.providers)。不画的话
    // 切回来时框里还是上一家的模型名,提交就写进了这一家的槽位 —— 而 claude-* 送去
    // Gemini 会被 assertModelMatchesProvider 拦下,报的却是"模型和供应商对不上",
    // 指不到"这个值是切换时留下的"
    assert.match(paintBlock(), /\$\('ai-model'\)\.value = cur\?\.model/);
  });

  test('换一家先清掉已经打进去的 key', () => {
    // **这条是这里唯一会写坏数据的。** 打了一半 Gemini 的 key 又切回 Anthropic,
    // 不清的话那串字符会作为 Anthropic 的 key 存进去。它一定是错的,而报出来的是
    // 一次验证失败,指不到"你刚才换了供应商"这个真因上
    const js = setupJs();
    const i = js.indexOf("$('ai-provider').addEventListener('change'");
    assert.ok(i > 0, '找不到供应商下拉的 change 监听');
    const block = js.slice(i, js.indexOf('});', i));
    assert.match(block, /\$\('ai-key'\)\.value = ''/, '换一家必须清掉输入框里的 key');
    assert.match(block, /paintAiProvider\(\)/, '清完还要重画,否则状态停在上一家');
  });

  test('步骤标题上的「已配置」问的是这一步办完没有,不是当前这家配了没', () => {
    // 配好了 Anthropic 却停在 Gemini 上,这一步显然是办过的。写成
    // `!cur?.hasKey` 的话,切到一家没配的就把整步标成没配 —— 看着像配置丢了
    assert.match(paintBlock(), /\$\('ai-set'\)\.hidden = !Object\.values\(aiProviders\)/);
  });
});

/**
 * API Key 的占位符按供应商换。
 *
 * 三家共用一个输入框之后,「把 Anthropic 的 key 粘进 Gemini 那一栏」是这次改版**新造
 * 出来**的失误,而一个写死的 `sk-...` 对其中两家都是错的 —— 它非但拦不住,还在替
 * 那个错误背书。用户报的。
 */
describe('AI Key 占位符', () => {
  const html = read('Setup.html');

  test('静态标记里不写死任何一家的形状', () => {
    // JS 起来之前那一瞬间宁可是空的,也不要是错的。写死一个就有两家在说谎
    const step = stepBlock(html, 2);
    const m = step.match(/<input[^>]*id="ai-key"[^>]*>/);
    assert.ok(m, '找不到 ai-key 输入框');
    assert.doesNotMatch(m[0], /placeholder=/, 'ai-key 的占位符由 paintAiProvider 按供应商填');
  });

  test('三家各有各的形状,而且互不相同', () => {
    const js = inlineScripts(html)
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
    const i = js.indexOf('const AI_KEY_HINT');
    assert.ok(i > 0, '找不到 AI_KEY_HINT');
    const block = js.slice(i, js.indexOf('}', i));

    const hints = [...block.matchAll(/(\w+):\s*'([^']+)'/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(hints.map((h) => h[0]).sort(), ['anthropic', 'deepseek', 'gemini']);
    assert.equal(
      new Set(hints.map((h) => h[1])).size, hints.length,
      '两家共用一个形状 —— 那正是这条测试要防的东西'
    );
    // Anthropic 的 key 是 sk-ant- 开头,DeepSeek 的只是 sk-。两者互为前缀,
    // 所以「都以 sk- 开头」不算区分,必须是完整字符串不同
    assert.equal(Object.fromEntries(hints).anthropic, 'sk-ant-...');
    assert.equal(Object.fromEntries(hints).gemini, 'AIza...');
  });

  test('形状只是提示,任何地方都不拿它校验', () => {
    // 认前缀 = 供应商下次改格式时把一把好 key 拒掉,而错误会说「key 无效」,
    // 指向一个完全正确的东西。Notion 那一栏当年就是这么定的规矩
    const all = read('Setup.html') + readFileSync(join(ROOT, 'lib', 'api.js'), 'utf8');
    const noComments = all.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
    assert.doesNotMatch(
      noComments,
      /startsWith\(\s*'(sk-|AIza)/,
      '按前缀校验 API Key —— 厂商改格式那天会把好 key 拒掉'
    );
  });
});

describe('攻略备份:同一个数只有一条重画路径', () => {
  // 「备份 N」这个数在两处渲染:行尾那个按钮(`render()` 拼的 HTML 串)和弹框里
  // 的摘要行(`paintArchive()`)。删掉一份之后只重画其中一处,两个数就在同一屏上
  // 互相矛盾,而且不刷新页面永远不会自己对上 —— 实测撞到过,弹框写「1 份」,
  // 行上还写着「备份 2」。
  //
  // 这是这个项目栽过的老毛病(见 CLAUDE.md 里 `paintCount` 那条:「已选 N 条」
  // 曾经静默停在上一次全量重画的值)。所以两个动作都必须走同一个 refreshArchives。
  //
  // **注释要先剥掉** —— 上面那段注释里 `render()`、`paintArchive` 一个不少,
  // 不剥的话把代码删光了断言照样过,这个文件本身就吃过这个亏
  const src = read('Dashboard.html')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  test('refreshArchives 三处都重画:索引、弹框、表格', () => {
    const fn = src.slice(
      src.indexOf('async function refreshArchives'),
      src.indexOf('async function loadArchiveIndex')
    );
    assert.ok(fn.length > 0 && fn.length < 600, '切到的应该就是 refreshArchives 那一段');
    assert.match(fn, /loadArchiveIndex\(\)/, '不重新拉索引,行上那个数还是旧的');
    assert.match(fn, /paintArchive\(\)/, '不重画弹框,列表还是旧的');
    assert.match(fn, /render\(\)/, '不重画表格,行尾那个「备份 N」还是旧的');
  });

  test('编辑中不重画 —— render() 会把正在输入的数字框连焦点一起换掉', () => {
    const fn = src.slice(
      src.indexOf('async function refreshArchives'),
      src.indexOf('async function loadArchiveIndex')
    );
    assert.match(fn, /editingAppid === null/);
  });

  test('删和覆盖两个动作都走 refreshArchives,没有一个绕过去', () => {
    const block = src.slice(src.indexOf('function arcRow'), src.indexOf('function paintArchive'));
    assert.ok(block.length > 0, '切到的应该是 arcRow');
    assert.equal(
      (block.match(/refreshArchives\(\)/g) || []).length, 2,
      '覆盖和删除各一次 —— 少一个,那条路上的两个数就会分家'
    );
    assert.doesNotMatch(block, /await loadArchiveIndex\(\);\s*paintArchive\(\)/,
      '手写这两句就是绕开了 refreshArchives,表格不会跟着重画');
  });

  test('setGuideBusy 也重画 —— 置灰是渲染出来的,不改完就得重画', () => {
    const fn = src.slice(
      src.indexOf('function setGuideBusy'),
      src.indexOf('async function refreshArchives')
    );
    assert.ok(fn.length > 0 && fn.length < 600);
    assert.match(fn, /render\(\)/);
    assert.match(fn, /editingAppid === null/);
  });
});

describe('置灰和备份数:每一条出口都要收拾干净', () => {
  // `guideBusy` 决定行上「重写」「Notion」灰不灰,而置灰是**渲染出来的**。
  // 以前是 `btn.disabled = true` 挂在 DOM 节点上,`loadDashboard()` 重画一次就
  // 顺手清掉了 —— 那条"自动清扫"的路随着改成渲染而消失了,于是任何一条不显式
  // 解除的出口都会把那一行永久卡在灰色,直到刷新页面。成功那条路正是原来
  // 没有解除的(它不需要),所以这个 bug 恰好长在最常走的那条路上。
  //
  // 同一批出口还各自刚生成了一份存档(重写存原文进 .backups/,搬运把原件放进
  // .migrated/),所以行尾那个「备份 N」也要跟着重拉 —— 「重写完想反悔」正是
  // 最需要它出现的时刻。
  //
  // **注释必须先剥掉**:上面这段和代码旁边那几段注释里,setGuideBusy /
  // refreshArchives 一个不少,不剥的话代码删光了断言照样过
  const src = read('Dashboard.html')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const fetchGen = () => {
    const a = src.indexOf('function fetchGen()');
    const b = src.indexOf('fetchGen();', a + 20);
    assert.ok(a > 0 && b > a, '切不到 fetchGen');
    return src.slice(a, b);
  };

  test('生成/重写跑完:解除置灰 + 重拉备份数', () => {
    const fn = fetchGen();
    assert.match(fn, /setGuideBusy\(f\.appid, false\)/,
      '不解除的话那一行的重写按钮会一直灰到刷新页面');
    assert.match(fn, /refreshArchives\(\)/,
      '这次重写刚存了一份原文,行尾的「备份 N」要跟着出来');
    assert.match(fn, /loadDashboard\(\)/,
      '攻略已登记,「📖 攻略」链接要出来');
  });

  // 成功、失败、校验没过 —— 三条出口现在**收在同一处**:服务端把三种都堆进
  // `finished`,页面照单收。原来是成功一处、失败一处各写一遍,而那正是这个
  // describe 开头说的那种形状(两处迟早只改一处,漏的那条把行永久卡在灰色)
  test('失败也解除置灰,而且收尾只能有一处', () => {
    const fn = fetchGen();
    assert.equal((fn.match(/setGuideBusy\(/g) || []).length, 1,
      '收尾分成两处写,迟早只改一处');
    assert.match(fn, /fresh\.forEach\([\s\S]{0,80}setGuideBusy\(f\.appid, false\)/,
      'appid 取自服务端快照里那一条 —— 失败时根本没有 result 可取');
  });

  // **这条是那个 bug 本身。** 排队生成时,一个跑完到下一个开跑之间只隔着一个微任务,
  // 页面三秒才轮一次 —— 于是每次轮询看到的 running 都是 true。收尾写在
  // `if (s.running)` 的 return 后面,就永远执行不到:表格不刷新、攻略链接不出现、
  // 那一行一直灰着,看起来就是"第一个生成好了但界面没反应"
  test('先收跑完的,再看现在在跑什么', () => {
    const fn = fetchGen();
    const drain = fn.indexOf('s.finished');
    const running = fn.indexOf('if (s.running)');
    assert.ok(drain > 0, '要从服务端快照里收 finished');
    assert.ok(running > 0, '切到的应该是 fetchGen');
    assert.ok(drain < running,
      '排队时 running 一直是 true,收尾放在它后面就永远轮不到');
  });

  test('搬去 Notion 成功:解除置灰 + 重拉备份数', () => {
    // **切到 successHandler 里面,而且数个数。** 第一版切的是整个 rpc 链,
    // 于是 failureHandler 里那句一模一样的 `setGuideBusy(appid, false)` 就把
    // 断言喂饱了 —— 把成功路径那句删掉,测试照样绿。变异测试当场抓到,
    // 这个文件反复产出的正是这种形状(见文件头那几条)
    // migrate 是**两层嵌套的 rpc**(先 previewGuideToNotion,再 migrateGuideToNotion),
    // 所以从里层那个调用往回找它自己的 successHandler,别从外层往后找
    const call = src.indexOf('.migrateGuideToNotion(appid)');
    const a = src.lastIndexOf('.withSuccessHandler(function (r)', call);
    const fn = src.slice(a, src.indexOf('.withFailureHandler', a));
    assert.ok(fn.length > 0 && fn.length < 3000, '切到的应该是 migrate 的成功处理');
    assert.equal(
      (fn.match(/setGuideBusy\(appid, false\)/g) || []).length, 2,
      '两处:r.error 那条提前返回,和真正成功那条 —— 少一个就有一条路会把按钮卡在灰色'
    );
    assert.match(fn, /refreshArchives\(\)/, '搬运刚把原件放进 .migrated/,备份数变了');
  });

  test('弹框没开就不画它 —— refreshArchives 会被跑完的任务调用', () => {
    const fn = src.slice(
      src.indexOf('async function refreshArchives'),
      src.indexOf('async function loadArchiveIndex')
    );
    assert.match(fn, /arcModal\.classList\.contains\('show'\)/,
      '不判断的话,重写跑完会把弹框画成上一次看过的那个游戏的列表');
  });
});

describe('生成成功那一屏的两个备份动作', () => {
  // 「读一遍确认没问题」之后只有两种结论,所以这里必须有两个动作:这版可以 →
  // 删掉旧的;这版不如旧的 → 用回旧的。**只留删除的话,最可能想反悔的那一刻,
  // 屏幕上唯一的按钮是「把反悔的本钱销毁」。** 要用它们的那一刻就是刚点开攻略的
  // 那一刻,所以它们摆在「打开攻略」旁边——摆到别处就等于「等会儿再收拾」,
  // 而等会儿多半不会来。
  //
  // 注释先剥掉:下面这几段代码旁边的注释里 backup / deleteGuideArchive 一个不少
  const src = read('Dashboard.html')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  test('没有备份就两个动作都不出现 —— 整篇新生成没有旧的可存', () => {
    assert.equal((src.match(/r\.backup && r\.backup\.id/g) || []).length, 2,
      '两个动作各要判一次;不判的话新生成那一屏会摆点了必然失败的按钮');
  });

  test('两个都跟着「打开攻略」进标题行,恢复在删除前面', () => {
    // **两个分支都要拼上**:标题行有「局部重写」和「整篇生成」两种写法,
    // 只断言出现过一次的话,删掉其中一个分支的拼接测试照样绿 —— 变异测试抓到过。
    // 顺序也钉住:能挽回的排前面,不可逆的排最后
    assert.equal(
      (src.match(/where \+ restoreBackup \+ dropBackup/g) || []).length, 2,
      '局部重写和整篇生成两条标题都要带上这两个,且恢复在删除之前'
    );
    const i = src.indexOf('const dropBackup');
    const j = src.indexOf('where + restoreBackup + dropBackup');
    assert.ok(i > 0 && j > i, '先算后用');
    assert.ok(src.indexOf('const restoreBackup') < i, '恢复要先于删除算出来');
  });

  test('恢复也是两下点,第二下说的是后端相关的后果', () => {
    const fn = src.slice(
      src.indexOf("querySelectorAll('[data-restore-backup]')"),
      src.indexOf("querySelectorAll('[data-drop-backup]')")
    );
    assert.ok(fn.length > 0 && fn.length < 3000, '切到的应该是那个处理器');
    assert.match(fn, /if \(!armed\)/, '第一下只武装,不覆盖');
    assert.match(fn, /data-restore-label/,
      '第二下的标签要说后果,而且是渲染时按后端算好的 —— 处理器里再判一次早晚只改一处');
    assert.match(fn, /restoreGuideArchive\(/);
  });

  test('后果那句话按后端分,Notion 要说「整页重写」', () => {
    // Notion 那边是**先删掉整页的块再写回去**,和覆盖一个本地文件不是一回事,
    // 说成一样的话用户按下去之前不知道自己批准的是什么
    const i = src.indexOf('const restoreBackup');
    const seg = src.slice(i, src.indexOf('const dropBackup'));
    assert.match(seg, /整页重写/, 'Notion 分支');
    assert.match(seg, /覆盖本地文件/, '本地分支');
    assert.match(seg, /r\.target === 'notion'/, '按后端选,不是写死一句');
  });

  test('恢复完要撤掉「删除备份」—— 它指着的已经不是想删的那份了', () => {
    // 恢复之后旧版成了线上内容的来源,而想删的多半是刚被顶掉的新版。
    // 留着那个按钮只会删错一份
    const fn = src.slice(
      src.indexOf("querySelectorAll('[data-restore-backup]')"),
      src.indexOf("querySelectorAll('[data-drop-backup]')")
    );
    assert.match(fn, /\[data-drop-backup\][\s\S]*?remove\(\)/);
    assert.match(fn, /refreshArchives\(\)/, '行尾那个「备份 N」变了');
    assert.match(fn, /loadDashboard\(\)/, '登记可能从 notion 翻回 local,链接要跟着换');
  });

  test('两下点:第一下换成后果那句话,第二下才真删', () => {
    const fn = src.slice(
      src.indexOf("querySelectorAll('[data-drop-backup]')"),
      src.indexOf("querySelectorAll('[data-reveal]')")
    );
    assert.ok(fn.length > 0 && fn.length < 2500, '切到的应该是那个处理器');
    assert.match(fn, /if \(!armed\)/, '第一下只武装,不删');
    assert.match(fn, /'永久删除'/, '第二下的标签要说后果,不是「确定」');
    assert.match(fn, /deleteGuideArchive\(/);
  });

  test('删完要重画 —— 行尾那个「备份 N」得跟着少一个', () => {
    const fn = src.slice(
      src.indexOf("querySelectorAll('[data-drop-backup]')"),
      src.indexOf("querySelectorAll('[data-reveal]')")
    );
    assert.match(fn, /refreshArchives\(\)/,
      '不重画的话,备份已经没了而行上还写着有');
  });

  test('删完不留一个还能点的按钮', () => {
    const fn = src.slice(
      src.indexOf("querySelectorAll('[data-drop-backup]')"),
      src.indexOf("querySelectorAll('[data-reveal]')")
    );
    assert.match(fn, /'备份已删'/, '删完了它就没有对象了');
  });
});

describe('设置页的攻略备份是折叠的', () => {
  const html = read('Setup.html');
  const css = styleBlocks(html).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');

  test('整节是 <details>,默认收起', () => {
    assert.match(html, /<details id="guide-archive" hidden>/,
      '摊开来占掉整屏,把下面真正常用的东西挤没了');
    assert.doesNotMatch(html, /<details id="guide-archive"[^>]*\sopen/, '默认不该是展开的');
  });

  // `<summary>` 的展开三角是靠 `display: list-item` 画的,换成 flex / block / grid
  // 都会让它当场消失 —— 而这一页没有图标精灵可以顶上,三角没了就没有任何东西
  // 表示"展没展开"。实测撞过一次:computed display 是 flex,marker 一起没了
  test('.arc-head 不许改 display —— 那个三角就是状态标记', () => {
    const block = css.slice(css.indexOf('.arc-head {'), css.indexOf('.arc-count'));
    assert.ok(block.length > 0 && block.length < 900, '切到的应该是 .arc-head 那一段');
    assert.doesNotMatch(block, /display\s*:/, 'summary 默认 list-item,动它三角就没了');
  });

  test('收起来也看得见有几份多大 —— 这一节就是回答"占多少地方"的', () => {
    assert.match(html, /<span class="arc-count" id="arc-count">/);
    assert.match(html, /\$\('arc-count'\)\.textContent/,
      '数字要真的写进去,不然收起态是个空标题');
  });

  test('叫「攻略备份」,不叫「攻略存档」 —— 和行尾那个按钮同一个词', () => {
    assert.match(html, /攻略备份/);
    assert.doesNotMatch(html, /攻略存档/);
    assert.doesNotMatch(read('Dashboard.html'), /攻略存档/);
  });
});

describe('攻略备份那一节不解释自己', () => {
  const html = read('Setup.html');
  const js = html.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // 删掉的那句是两半解释拼起来的:前半讲机制(备份会进 zip),后半讲另一个功能
  // 在哪(去 Dashboard 行尾)。两样都是 docs 的活。列表本身已经说清了有什么、多大
  test('不写「会跟着备份 zip 一起走」这类机制说明', () => {
    assert.doesNotMatch(js, /备份 zip 一起走/);
    assert.doesNotMatch(js, /去 Dashboard 上那个游戏行尾/);
  });

  test('孤儿那一句留着 —— 它是死路 + 出路,不是解释', () => {
    assert.match(js, /行上够不着/);
    assert.match(js, /先把游戏加回来/, '说了够不着就得说怎么办');
  });

  test('没有孤儿时那一行是空的,而且空了不占位', () => {
    assert.match(js, /\$\('arc-sum'\)\.textContent = orphans\.length/,
      '要是无条件写一句话,这一格就永远占着一条边距');
    assert.match(styleBlocks(html).join('\n'), /#arc-sum:empty\s*\{\s*display:\s*none/);
  });
});

/**
 * 列表尾巴那个「全部删除」。
 *
 * 这一组全是源码断言 —— 零依赖、没 DOM,点击验不了(见文件头)。它们盯的三件事
 * 都是**错了不报错**的:按钮位置不对、自己把自己拆了、删的范围比屏幕上大。
 */
describe('攻略备份的一键删', () => {
  const html = read('Setup.html');
  const js = inlineScripts(html)
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');

  test('按钮在列表**下面**,不在标题那一行', () => {
    const wipe = html.indexOf('id="arc-wipe"');
    const list = html.indexOf('id="arc-list"');
    const summaryEnd = html.indexOf('</summary>');
    assert.ok(wipe > 0, '找不到全部删除按钮');
    assert.ok(wipe > list, '得先看见删的是哪几份,才轮到那个按钮');
    // 在 `<summary>` 里的话:收起态就能删,而那一行只有一个总数;
    // 而且点它会连带整节折叠一起翻
    assert.ok(wipe > summaryEnd, '不能放进 <summary>');
    assert.ok(html.indexOf('</details>') > wipe, '得在攻略备份这一节里');
  });

  test('第二下的按钮写后果 —— 删几份、多大,不是「确定」', () => {
    const i = js.indexOf('arm(wipe,');
    assert.ok(i > 0, '找不到 arm(wipe, ...)');
    const call = js.slice(i, js.indexOf('\n', i));
    assert.match(call, /永久删除/);
    assert.match(call, /\$\{list\.length\} 份/, '要说删的是几份');
    assert.match(call, /\$\{kb\(bytes\)\}/, '要说腾出多少');
    assert.doesNotMatch(call, /确定/, '第二下写后果,不写「确定」');
  });

  /**
   * 实打过的坑的同类:`#arc-wipe` 不在 `.arc-acts` 里(它是整个列表的尾巴)。
   * 漏在那个选择器外面的话,第一下点完先跑 onclick 上好膛,冒泡到 document 上
   * 立刻拆掉 —— 表现是**按钮看上去没反应、永远点不出第二下**,一行错都不会报
   */
  test('点它自己不算"点到外面",否则一上好膛就被拆了', () => {
    const i = js.indexOf("document.addEventListener('click'");
    assert.ok(i > 0);
    const guard = js.slice(i, i + 200);
    // 逐个断言,不钉整串:将来再多一个例外时这条检查不该拦路,少一个时必须响
    for (const sel of ['.arc-acts', '#arc-wipe', '#back-btn']) {
      assert.ok(guard.includes(sel),
        `撤销判断漏了 ${sel} —— 那个按钮第一下上好膛就被冒泡拆掉,永远点不出第二下`);
    }
  });

  /**
   * **删的是屏幕上那一批。** 传编号表而不是让服务端"把目录清了":两者之间
   * 隔着一次后台重写就能多出一份从没上过屏的备份。同一类错在这个项目里
   * 反复出现过:一个值两个渲染器、一条重画路径。
   */
  test('传的是刚画出来那一批的编号', () => {
    assert.match(js, /const ids = sorted\.map\(\(e\) => e\.id\)/,
      '编号要在重画时定死');
    assert.match(js, /call\('deleteGuideArchives', \[ids\]\)/);
  });

  test('重画后按钮要复位 —— 它跨重画活着,不像行那样重建', () => {
    const i = js.indexOf("const wipe = $('arc-wipe')");
    assert.ok(i > 0, '找不到 wipe 的定义');
    const block = js.slice(i, js.indexOf('arm(wipe,', i));
    assert.match(block, /wipe\.textContent = '全部删除'/, '不复位会停在"永久删除 N 份"上');
    assert.match(block, /wipe\.classList\.remove\('armed'\)/);
  });

  test('服务端真有这个方法', () => {
    const api = readFileSync(join(ROOT, 'lib', 'api.js'), 'utf8');
    assert.match(api, /deleteGuideArchives\(ids\)/, '页面调的名字得真存在');
  });
});

/**
 * 恢复预览:正在被审查的那个文件,不能在预览它的时候执行
 * ------------------------------------------------------------------
 * `manifest.json` 是**上传上来那个 zip 里的文件**,`inspectBackup` 原样
 * `JSON.parse` 之后交回页面。所以 `counts.games` 想写什么就是什么 ——
 * 拼进 `innerHTML` 的话,一个 `<img src=x onerror=…>` 就在设置页里跑起来了,
 * 而设置页调得动全部 38 个 `/api/*`(删游戏、改配置、发起要花钱的生成)。
 *
 * 这一屏存在的全部意义是「在覆盖数据之前先看看里面是什么」。看一眼就执行,
 * 关卡是反着的。
 */
describe('恢复预览不执行备份文件里的内容', () => {
  const js = inlineScripts(read('Setup.html')).join(SEP);

  /**
   * **注释要先剥掉,而且行注释要排在块注释前面。**
   *
   * 前半句是这个仓库的老规矩:这一段代码旁边就写着「拼进 innerHTML 就等于…」,
   * 而下面那条断言恰恰在找 `innerHTML` 这个词 —— 不剥的话,解释这条规则的那句话
   * 自己就让断言永远失败(反过来同样常见:注释让断言永远通过)。
   *
   * 后半句是**实测踩出来的**:同一段行注释里写着 `/api` 后面跟一个星号,而剥块注释的
   * 正则会把那个「斜杠星号」当成块注释的开头,一路吃到几十行之后的第一个闭合标记 ——
   * 中间的**代码**跟着一起没了。于是把 `appendChild` 改成 `innerHTML +=`,
   * 断言照样通过。先按行剥掉 `//`,那个假开头就不存在了。
   *
   * (这条注释本身也不敢写出闭合标记 —— 写了就会把自己提前结束掉。)
   */
  const codeOnly = (s) => s
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\*.*$/gm, '');

  test('**预览那几行不走 innerHTML**', () => {
    const i = js.indexOf('async function previewFile');
    assert.ok(i > 0, '找不到 previewFile —— 这条检查失去了目标');
    const end = js.indexOf('function ', i + 30);
    assert.ok(end > i, '找不到函数结尾,该重写而不是放宽');
    const body = codeOnly(js.slice(i, end));
    // **整块里连 `innerHTML` 这个词都不许出现。** 写成 `/\.innerHTML\s*=/` 漏掉
    // `innerHTML +=` —— 而那正是"我只是往后拼一点"最容易长出来的形状
    assert.doesNotMatch(body, /innerHTML/,
      '预览又碰 innerHTML 了 —— manifest 来自还没被信任的那个文件');
    assert.match(body, /bk-info/, '这条检查该看的是 bk-info 那一块');
  });

  test('数字过一遍数值检查,不是字符串直接摆上去', () => {
    const i = js.indexOf('async function previewFile');
    const body = js.slice(i, js.indexOf('function ', i + 30));
    assert.match(body, /Number\.isFinite/,
      'manifest 里的 counts 没验就显示 —— 里面可以是任何东西');
    assert.match(body, /num\(c\.games\)/, 'games 没过 num()');
    assert.match(body, /num\(c\.achievements\)/, 'achievements 没过 num()');
  });

  test('强调用真的 <b> 元素,不是拼标签', () => {
    const i = js.indexOf('async function previewFile');
    const body = js.slice(i, js.indexOf('function ', i + 30));
    assert.match(body, /createElement\('b'\)/, '<b> 是拼出来的字符串就等于又开了一个口子');
    assert.match(body, /textContent = text/, '文字要走 textContent');
  });
});

/**
 * 两下点的按钮:第二下抛异常之后必须还能再点
 * ------------------------------------------------------------------
 * `run()` 里的 `call()` / `rpc` 两个 await 都会抛(连接断了、回应不是 JSON),
 * 而 `#arc-wipe` **跨重画活着** —— 顺着往下写 `btn.disabled = false` 的话,
 * 抛一次就永远停在 disabled 上,只能刷新整页。偏偏最容易抛的时候
 * 正是刚失败一次、想重试的时候。
 */
describe('两下点的按钮不会卡在置灰上', () => {
  for (const [page, fn] of [['Setup.html', 'function arm('], ['Dashboard.html', 'function arcArm(']]) {
    test(`${page}:置灰的复位在 finally 里`, () => {
      const js = inlineScripts(read(page)).join(SEP);
      const i = js.indexOf(fn);
      assert.ok(i > 0, `找不到 ${fn} —— 这条检查失去了目标`);
      const end = js.indexOf('\n    }', js.indexOf('btn.onclick', i));
      assert.ok(end > i, '找不到 onclick 的结尾,该重写而不是放宽');
      const body = js.slice(i, end);

      assert.match(body, /btn\.disabled = true/, '第二下应该先把按钮置灰');
      // finally 必须在 await run() 之后、并且里面就是那句复位
      assert.match(
        body, /try\s*\{\s*await run\(\);\s*\}\s*finally\s*\{\s*btn\.disabled = false;\s*\}/,
        'run() 抛出来的话按钮就永远置灰了 —— 复位要放在 finally 里'
      );
    });
  }
});


/**
 * 设置页的出口
 * ------------------------------------------------------------------
 * 打包版没有地址栏、没有后退键,托盘的「打开面板」只 show/focus
 * (launcher/main.js 的 showWindow 不 loadURL)。所以 `#back-btn` 是进了 /setup
 * 之后**唯一**一条不用保存也能回 Dashboard 的路 —— 没有它,改到一半想反悔的人
 * 只能退出程序重开。
 *
 * 这一节钉的都是删掉不会报错的东西:按钮类型、出现的条件、撤销例外、以及它的
 * 两句文案。撤销例外那一条在上面「攻略备份的一键删」里,和 `#arc-wipe` 一起验。
 */
/**
 * 岔路的回头路
 * ------------------------------------------------------------------
 * 首次设置第一屏是 全新设置 / 从备份恢复 的岔路,而这个岔路**曾经是单向门**:
 * 点进「从备份恢复」之后页面上没有任何控件能退回来,而打包版没有地址栏、没有
 * 后退键,托盘的「打开面板」也只 show/focus —— 手上没有备份文件的人只能把整个
 * 程序退掉。用户报上来的就是这个。
 *
 * 回头路和 `#back-btn` **不是一个东西**,这一节的每一条都在守住那个区分:
 * 那个去 Dashboard、只在设置模式下上膛(首次设置是关卡,不该有出口);
 * 这个只在首次设置里出现,回的是上面那两个选择,人始终还在闸里。
 */
describe('岔路的回头路', () => {
  const html = read('Setup.html');
  const js = inlineScripts(html).join(SEP);
  /** 先行注释再块注释 —— 下面几条断言找的词在解释它们的注释里都出现过 */
  const codeOnly = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const code = codeOnly(js);
  const tag = html.match(/<button[^>]*id="gate-back"[^>]*>([^<]*)<\/button>/);

  test('存在、是 type="button"、默认收起', () => {
    assert.ok(tag, '找不到 #gate-back —— 少了它，「从备份恢复」就又是一扇单向门');
    assert.match(tag[0], /type="button"/, '它在 <form> 里，默认 type 会把表单提交掉');
    assert.match(tag[0], /\shidden\b/, '岔路本身不该有回头路');
  });

  test('两条分支都把它露出来', () => {
    for (const fn of ['startWizard', 'startRestore']) {
      const i = code.indexOf('function ' + fn + '(');
      assert.ok(i > 0, '找不到 ' + fn);
      assert.match(code.slice(i, code.indexOf('\n    }', i)), /gate-back'\)\.hidden = false/,
        fn + ' 没把回头路露出来 —— 那条分支就回不来了');
    }
  });

  /**
   * `startRestore` 藏了三个元素、改了标题和副标题。`showGate` 漏还原任何一个,
   * 第二次走到那一节就缺半截 —— 而它不会报错。
   */
  test('showGate 把 startRestore 藏起来的都还原了', () => {
    const g = code.indexOf('function showGate(');
    assert.ok(g > 0, '找不到 showGate');
    const body = code.slice(g, code.indexOf('\n    }', g));
    for (const id of ['backup-make', 'backup-title', 'restore-title']) {
      assert.ok(body.includes(id), 'showGate 没还原 ' + id + ' —— startRestore 把它藏了');
    }
    assert.match(body, /gate'\)\.hidden = false/, 'showGate 要把岔路放回来');
    assert.match(body, /gate-back'\)\.hidden = true/, '岔路上不该再有回头路');
  });

  /**
   * **回头路把 `showWizard` 变成了可以跑第二次的函数。** 里面那几个
   * `addEventListener` 于是会一路叠加:实测拿掉守卫、来回三趟之后,
   * 「跳过」一下从第 1 步跳到第 4 步。重复绑定不报错,只是行为翻倍。
   */
  test('向导的一次性接线只能跑一次', () => {
    const i = code.indexOf('function wireWizard(');
    assert.ok(i > 0, '找不到 wireWizard —— 一次性接线得单独关起来');
    const body = code.slice(i, code.indexOf('\n    }', i));
    assert.match(body, /if \(wizardWired\) return;/, '少了这道守卫，监听会叠加');
    for (const ev of ['step-skip', 'step-next']) {
      assert.ok(body.includes(ev), ev + ' 的监听要在守卫后面绑');
    }
    const sw = code.indexOf('function showWizard(');
    assert.doesNotMatch(code.slice(sw, code.indexOf('\n    }', sw)), /addEventListener/,
      'showWizard 里不能再有裸的 addEventListener —— 它现在会跑好几次');
  });

  test('回头路不是去 Dashboard 的那个出口', () => {
    const i = code.indexOf("addEventListener('click', showGate)");
    assert.ok(i > 0, '回头路要接到 showGate 上');
    assert.doesNotMatch(tag[1], /Dashboard/,
      '首次设置是关卡，这个按钮回的是岔路、不是 Dashboard');
  });
});

describe('设置页的出口', () => {
  const html = read('Setup.html');
  const js = inlineScripts(html).join(SEP);
  /** 先行注释再块注释 —— 下面几条断言找的词在解释它们的注释里都出现过 */
  const codeOnly = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const code = codeOnly(js);
  const tag = html.match(/<button[^>]*id="back-btn"[^>]*>([^<]*)<\/button>/);

  test('是 type="button" —— 它就在 <form> 里,默认类型会把表单提交掉', () => {
    assert.ok(tag, '找不到 #back-btn');
    assert.match(tag[0], /type="button"/,
      '默认 type 是 submit:点「返回」会触发一次保存,而那正是它要避开的事');
  });

  test('默认 hidden —— 首次设置时这一页是关卡,不该有出口', () => {
    assert.match(tag[0], /\shidden\b/, '标记里就得是收起的');
    const i = code.indexOf('if (isEditMode) {');
    assert.ok(i > 0, '找不到设置模式那一支');
    assert.match(code.slice(i, i + 400), /armBack\(\)/, '出口要挂在 isEditMode 里');
    assert.equal([...code.matchAll(/back\.hidden = false/g)].length, 1,
      '只该有一处把出口挂出来 —— 多一处就多一条绕过 isEditMode 的路');
  });

  test('文字说的是去哪,不是撤销什么', () => {
    assert.match(tag[1], /Dashboard/, '按钮上要说明去哪儿');
    assert.doesNotMatch(tag[1], /取消/,
      '这一页有六个控件不等保存就生效(建 Notion 库当场存盘、立即备份、恢复、删存档),'
      + '「取消」承诺的是整页回滚,而它收得回的只有几个输入框');
  });

  test('第二下写后果,不写「确定」', () => {
    const i = code.indexOf('arm(back,');
    assert.ok(i > 0, '找不到 arm(back, ...)');
    const line = code.slice(i, code.indexOf('\n', i));
    assert.match(line, /放弃未保存的修改/, '要说清楚丢的是什么');
    assert.doesNotMatch(line, /确定/, '和存档那几个按钮同一条规矩');
  });

  test('没改过就直接走 —— 每次都拦会把确认训练成下意识点掉的东西', () => {
    const i = code.indexOf('back.onclick = (e) =>');
    assert.ok(i > 0, '找不到套在 arm() 外面那一层');
    const body = code.slice(i, i + 220);
    assert.match(body, /if \(isDirty\(\)\) return confirmClick\(e\)/, '脏了才走两下点');
    assert.match(body, /location\.href = '\/'/, '干净就直接回 Dashboard');
  });

  test('建完 Notion 库只对那一栏 —— 整体重置会抹掉别处真的未保存修改', () => {
    const i = code.indexOf('loadedNotionDb = r.id');
    assert.ok(i > 0, '找不到建库之后的回填');
    const after = code.slice(i, i + 200);
    assert.match(after, /markSaved\('notion-db'\)/, '建库当场存盘,那一栏就不该再算脏');
    assert.doesNotMatch(after, /markSaved\(\)/,
      '整体重置会把同一时刻真的未保存修改(比如刚改一半的 SteamID)一并抹掉');
  });

  /**
   * **提交时读的每一栏都必须在脏值检查里。** 漏一栏的表现是:改了它、点返回,
   * 页面一声不响地走人,改动丢掉 —— 而这正是这个按钮存在的意义反过来咬一口。
   * 照着 submit 那一段推,而不是手抄一份清单:新增一个设置项时这条会自己失败。
   */
  test('提交时读的每一栏都在脏值检查里,而且在标记里真的存在', () => {
    const i = code.indexOf("form.addEventListener('submit'");
    assert.ok(i > 0, '找不到提交处理');
    const sub = code.slice(i, code.indexOf('btn.disabled = true', i));
    const ids = [...new Set([...sub.matchAll(/\$\('([^']+)'\)\.value/g)].map((m) => m[1]))];
    assert.ok(ids.length >= 7, `提交里只读到 ${ids.length} 栏,这条检查失去了目标`);

    const m = code.match(/const DIRTY_FIELDS =\s*\[([^\]]*)\]/);
    assert.ok(m, '找不到 DIRTY_FIELDS');
    for (const id of ids) {
      assert.ok(m[1].includes(`'${id}'`),
        `${id} 会被保存却不在脏值检查里 —— 改了它点返回不会拦,改动静静丢掉`);
      assert.ok(html.includes(`id="${id}"`), `${id} 在标记里不存在,$() 会拿到 null`);
    }
  });
});


/**
 * 两下点的红色不能被悬停色盖掉
 * ------------------------------------------------------------------
 * `.armed` 是**两个类**(0,2,0),而各家的 `:hover:not(:disabled)` 是
 * 一类加两个伪类(0,3,0)—— 悬停那条赢。而第一下点完,光标就正停在按钮上:
 * 红色恰好在最该被看见的那一瞬被悬停色顶掉。
 *
 * 症状只有颜色不对,**没有任何东西会报错**,而且只在鼠标压着按钮时出现 ——
 * 截图和肉眼扫一遍都容易漏。所以每条 armed 规则都必须自带 `:hover` 变体。
 */
describe('两下点的红色不能被悬停色盖掉', () => {
  /** CSS 注释要先剥 —— 解释这条规则的话里就写着这几个选择器 */
  const cssOf = (page) =>
    styleBlocks(read(page)).join(SEP).replace(/\/\*[\s\S]*?\*\//g, '');

  for (const [page, sels] of [
    ['Setup.html', ['.back.armed', '.arc-acts .armed', '.arc-foot .armed']],
    ['Dashboard.html', ['.arc-acts button.armed']],
  ]) {
    test(`${page}:每条 armed 规则都带 :hover 变体`, () => {
      const css = cssOf(page);
      for (const sel of sels) {
        assert.ok(css.includes(sel),
          `${sel} 不见了 —— 这条检查失去了目标,该跟着改而不是删掉`);
        assert.ok(css.includes(`${sel}:hover:not(:disabled)`),
          `${sel} 没有 :hover 变体 —— 光标停在按钮上时红色会被悬停色盖掉,`
          + `而那正是第一下点完的状态`);
      }
    });
  }
});
