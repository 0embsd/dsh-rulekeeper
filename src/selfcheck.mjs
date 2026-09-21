// dsh-rulekeeper · 骨架自检（LF-100 的机械判据实现）
//
// 为什么需要它：清单 §6 规则 3「判据三要件 = 确定 exit + 关键输出行 + 固定 fixture」。
// 本模块把 LF-100 的绿/红判据变成可执行函数，红态靠"注入违规的临时副本"证明（见 test/skeleton.test.mjs）。
//
// 检查项：
//   S1 package.json 存在 / 可解析 / 无 dependencies·devDependencies·optionalDependencies / type=module
//   S2 骨架目录 src bin test 齐备
//   S3 两处落点存在 + config.json 存在 / 可解析 / schema+mode 合法
//   S4 零依赖：src|bin 下所有 .mjs 的导入说明符只允许 node: / 相对 / file:，且不得出现 require('…')
//   S5 跨平台排序：src|bin 下不得出现 localeCompare(（依赖 ICU/LANG，跨机不稳定）
//
// 零依赖：只用 node:* 内置模块。
//
// 【仪器教训，2026-09-14 自曝】S4 初版直接对**原始文本**跑正则，结果被本文件自身的注释与
// 正则字面量命中 → 真实树上误报 S4_CJS_REQUIRE（绿态自检 exit=1）。根因不是"模式太宽"，
// 而是"扫原始文本"这一做法本身错：必须先剥掉**注释 / 字符串 / 模板 / 正则字面量**再扫。
// 修复后扫描器自带正反回归用例（test/skeleton.test.mjs 的"仪器回归"用例，含正对照）。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { CONFIG_FILE, landingDirs, validateConfig } from './config.mjs';
// **按仓库性质分档的黑名单**（2026-09-21，交接第 1 步）：原来这份表不分公开/私有 ⇒ 私有仓里
// "本仓自己的名字"被当泄漏，pre-commit/commit-msg/pre-push 三道门一起拒提交。分档口径与解析顺序
// 见 src/repo-patterns.mjs。此处 re-export 保持既有调用方（gate.mjs / 用例）不改名。
import {
  IDENTITY_PATTERNS, INFRA_PATTERNS, PUBLIC_FACE_FORBIDDEN, patternsForKind, resolveRepoPatterns,
} from './repo-patterns.mjs';

export { IDENTITY_PATTERNS, INFRA_PATTERNS, PUBLIC_FACE_FORBIDDEN, patternsForKind, resolveRepoPatterns };

const ALLOWED_PREFIXES = ['node:', './', '../', 'file:'];
const REQUIRED_DIRS = ['src', 'bin', 'test'];

// 导入说明符提取：必须是**真导入语法**，不能靠"行首 import/export + 后面随便一个引号"——
// （2026-09-14 第二处仪器缺陷）裸写法 /^[ \t]*(?:import|export)\b[^'"]*?['"]…/ 的 [^'"] 可跨行，
// 于是 `export const MODES = Object.freeze(['observe',…])` 被当成裸导入 "observe"（真实树误报 9 条）。
// 现改为：import 'x' ／ import … from 'x' ／ export *|{…} from 'x' 三种真语法 + 动态 import('x')。
const RE_IMPORT_SIDE = /^[ \t]*import\s*['"]([^'"]+)['"]/gm;
const RE_IMPORT_FROM = /^[ \t]*import\s+[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/gm;
const RE_EXPORT_FROM = /^[ \t]*export\s+(?:\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/gm;
const RE_IMPORT_DYN = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const RE_REQUIRE = /\brequire\s*\(\s*['"]/;
// S5：跨平台排序禁令（localeCompare/Intl.Collator 依赖 ICU 与 LANG/LC_ALL，跨机不稳定）
const RE_LOCALE_COMPARE = /\blocaleCompare\s*\(/;
// S7：落点路径**拆开的字面量**（`'.dsh-ai', '<名字>'`）—— 正是改名时被误替换的那种写法。
// 注：这条正则本身以 `/` 起、前面是 `=`（在 REGEX_PRECEDERS 里），故 toCode 会把它当正则字面量抹掉，不会自match。
const RE_LANDING_HARDCODED = /['"]\.dsh-ai['"]\s*,\s*['"]/;

// 除法/正则消歧：这些"前一个有效字符"之后出现的 `/` 视为正则字面量起始。
// 注：这是**字符级**启发式（不识别关键字），`return /re/` 这类会被当成除法（字面量落进"代码"里）；
// 对本检查项无害（require 判定还要求后跟字符串实参），但**不是通用 JS 词法器**，勿复用于别处。
const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

/**
 * 把源码里**非代码**的部分剥掉：注释（// 与块注释）、正则字面量、字符串/模板。
 * @param {string} src
 * @param {{blankStrings?: boolean}} [opts] blankStrings=true 时把字符串内容也抹成 ""（用于查 require 调用）
 */
export function toCode(src, opts = {}) {
  const blankStrings = opts.blankStrings === true;
  let out = '';
  let i = 0;
  const n = src.length;
  let prev = '';
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    // 行注释
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    // 块注释
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    // 字符串 / 模板
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      const start = i;
      i += 1;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i += 1; break; }
        i += 1;
      }
      out += blankStrings ? '""' : src.slice(start, i);
      prev = '"';
      continue;
    }
    // 正则字面量
    if (c === '/' && (prev === '' || REGEX_PRECEDERS.has(prev))) {
      i += 1;
      let inClass = false;
      while (i < n) {
        const ch = src[i];
        if (ch === '\\') { i += 2; continue; }
        if (ch === '\n') break;
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { i += 1; break; }
        i += 1;
      }
      out += '/RE/';
      prev = '/';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return out;
}

/**
 * S9 例外表：属"消费者注入面"的模块（默认面刻意不接线，见 `index.js` 的行为边界说明）。
 * 反向约束：表里每一项都必须是真实存在的文件，否则 `S9_STALE_ALLOWLIST` 判红。
 */
export const S9_CONSUMER_API = Object.freeze({
  'src/guard.mjs': 'LF-410 软拦/硬拦选型：真正的 deny 由消费者用 ctx.tools.guard() 注入（默认零拦截是刻意的）',
  'src/observer.mjs': 'LF-440 观察者清点：由消费者按需注册观察者，默认面不订阅',
  'src/autorecord.mjs': 'LF-420 自动记录：由消费者按需接 tools/result，默认面不写',
});

/**
 * 把**模板字面量**的内容抹成空格（保留 `'`/`"` 字符串，因为 import 说明符是它们）。
 *
 * 为什么要这一步（2026-09-19 对抗性 QA 9 号发现）：`toCode()` 默认**保留**字符串/模板内容，
 * 于是"在模板字面量里写一行 `import './zz-tpl.mjs'`"就能**凭空造出一条假的接线边**，
 * 让 S9 判它"已接线"。这里先按反引号扫一遍把模板内容抹掉，再交给 `toCode`。
 * 说明：这是**字符级启发式**（不处理 `${}` 嵌套反引号），与 `REGEX_PRECEDERS` 同族的诚实边界；
 * 本仓无嵌套模板反引号用法，够用即止——**勿复用于别处**。
 */
export function blankTemplateLiterals(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '`') {
      out += '`';
      i += 1;
      while (i < n && text[i] !== '`') {
        if (text[i] === '\\') { out += '  '; i += 2; continue; }
        out += text[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < n) { out += '`'; i += 1; }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 抹掉**动态** `import('…')` 调用（"写了但从没被调用"的动态导入不算接线，QA 9 号 P2） */
export function blankDynamicImports(text) {
  return text.replace(/\bimport\s*\(\s*(['"])[^'"]*\1\s*\)/g, (m) => ' '.repeat(m.length));
}

function listModules(root) {
  const out = [];
  // 覆盖面：src|bin|test|scripts —— **2026-09-14 扩**（原来只扫 src|bin，结果 test/ 与 scripts/ 里的
  // 重复导入/裸导入漏检；而我自己就在 test 文件里犯过两次）。这几个目录都会被 `node --test`/直接
  // 执行加载，语法与依赖错误同样致命。
  for (const dir of ['src', 'bin', 'test', 'scripts']) {
    const abs = join(root, dir);
    if (!existsSync(abs)) continue;
    for (const rel of readdirSync(abs, { recursive: true })) {
      const name = String(rel);
      if (name.endsWith('.mjs')) out.push(join(abs, name));
    }
  }
  return out;
}

/**
 * **公开面全量文件**（S8 专用）：模块 + 顶层文档/清单。
 *
 * 为什么单独一个函数（2026-09-16 修）：S8 的注释一直写着"发布面 src/bin/test/scripts **+ 顶层文档**"，
 * 但实现只用了 `listModules`（只收 `.mjs`）⇒ **README/RUNBOOK 这些最可能对外泄漏的文件根本没被扫**，
 * 而 S8 这条规则本身就是"我在 README 里写了内部关联"那次事故立的 —— 判据与事故面不重合（属"判据错位"）。
 */
function listPublicFace(root) {
  const out = [...listModules(root)];
  for (const name of ['README.md', 'RUNBOOK.md', 'NOTICE.md', 'SCHEMA.md', 'package.json', 'index.js', 'dsh-rulekeeper.patch.yml']) {
    const abs = join(root, name);
    if (existsSync(abs)) out.push(abs);
  }
  return out;
}

/** 从已剥注释/正则的代码里收集静态与动态导入说明符 */
export function collectSpecifiers(code) {
  const found = [];
  for (const re of [RE_IMPORT_SIDE, RE_IMPORT_FROM, RE_EXPORT_FROM, RE_IMPORT_DYN]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) found.push(m[1]);
  }
  return found;
}

const RE_IMPORT_BINDINGS = /^[ \t]*import\s+([^;'"]*?)\s+from\b/gm;

/**
 * 找出**重复的导入绑定**（同一文件里同名标识符被导入两次 → `SyntaxError: Identifier 'x' has already been declared`）。
 *
 * 两个关键约束（都是实测换来的）：
 *   ① 必须只看**代码位置**的 import —— 调用方应传 `toCode(text,{blankStrings:true})`。
 *      2026-09-14 实测：探针脚本把 worker 代码写在**模板字面量**里，直接扫原文会把这 3 处
 *      "字符串里的 import" 当成真导入 -> 3 条假阳性。
 *   ② 正则**不能要求说明符带引号**（因为 ① 已把字符串抹成 `""`）——故用
 *      `import <clause> from` 形态匹配，只取绑定子句。
 *
 * 纯文本扫描，不启动子进程。
 */
export function duplicateImportBindings(code) {
  const seen = new Map();
  const dups = new Set();
  RE_IMPORT_BINDINGS.lastIndex = 0;
  let m;
  while ((m = RE_IMPORT_BINDINGS.exec(code)) !== null) {
    const clause = m[1];
    for (const rawPart of clause.split(',')) {
      let name = rawPart.trim();
      if (name === '' || name.startsWith('*')) continue;
      if (name.startsWith('{') || name.endsWith('}')) name = name.replace(/[{}]/g, '');
      name = name.trim(); // 【2026-09-14 修 bug】去括号后必须再 trim：`{ line }` 曾解析成空串被跳过 -> 漏报
      if (name === '') continue;
      const asMatch = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(name);
      if (asMatch !== null) name = asMatch[1];
      else name = name.split(/\s+/).pop();
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      if (seen.has(name)) dups.add(name);
      else seen.set(name, true);
    }
  }
  return [...dups].sort();
}

/** S8 模式表（**模块级导出**：既供 selfcheck 全量扫，也供 pre-commit 对暂存文件扫 —— 同一份口径，不许两套） */
// （模式表已挪到 `src/repo-patterns.mjs` 并**按仓库性质分档**；此处不再重复定义，
//   只在文件头 re-export 以保持既有调用方与用例改名零成本 —— 单一事实源见那个模块。）

/**
 * 对**单份文本**做公开面脱敏扫描（纯函数：selfcheck 与 pre-commit 复用同一份口径）。
 * @param {string} rel posix 相对路径（供 `allow` 例外判定）
 * @param {string} text 文件文本
 * @param {Array} [forbidden] 省略 ⇒ 用**公开仓完整表**（保守默认；要分档请显式传 `patternsForKind`）
 * @returns {{why:string, match:string}[]} 每类模式最多报一次（避免刷屏）
 */
export function findPublicFaceLeaks(rel, text, forbidden = PUBLIC_FACE_FORBIDDEN) {
  const found = [];
  for (const { re, why, allow } of forbidden) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of text.matchAll(g)) {
      if (typeof allow === 'function' && allow(rel, m[0], text)) continue;
      found.push({ why, match: m[0] });
      break;
    }
  }
  return found;
}

/**
 * 对一组**相对路径**做公开面脱敏扫描（pre-commit 用：暂存文件逐一过一遍）。
 * 文件不存在（删除/改名）⇒ 跳过，不算违规。
 * @param {string} root 仓库根
 * @param {string[]} relPaths 相对路径
 * @param {{forbidden?: Array}} [opts] `forbidden` 省略 ⇒ **公开仓完整表**（保守默认：不确定就更严）
 * @returns {{rel:string, why:string, match:string}[]}
 */
export function scanPublicFacePaths(root, relPaths = [], opts = {}) {
  const forbidden = Array.isArray(opts.forbidden) ? opts.forbidden : PUBLIC_FACE_FORBIDDEN;
  const out = [];
  for (const rel of relPaths) {
    const posix = String(rel).split(sep).join('/');
    if (posix.startsWith('test/fixtures/')) continue;   // 夹具里的历史文本是被测输入，不算对外文档
    const file = join(root, posix);
    if (!existsSync(file)) continue;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;   // 二进制/读不了 ⇒ 跳过（S8 只管文本公开面）
    }
    for (const leak of findPublicFaceLeaks(posix, text, forbidden)) out.push({ rel: posix, ...leak });
  }
  return out;
}

/**
 * @param {string} root dsh-rulekeeper 包根目录（含 package.json）
 * @param {{projectRoot?: string, env?: object}} [opts]
 * @returns {{ok: boolean, findings: {code: string, msg: string}[], dirs: object}}
 */
export function checkSkeleton(root, opts = {}) {
  const findings = [];
  const add = (code, msg) => findings.push({ code, msg });

  // ── S1 package.json ────────────────────────────────────────────────
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) {
    add('S1_PACKAGE_MISSING', `缺少 ${pkgPath}`);
  } else {
    let pkg = null;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch (err) {
      add('S1_PACKAGE_UNPARSABLE', `package.json 不是合法 JSON: ${err.message}`);
    }
    if (pkg) {
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        const value = pkg[field];
        if (value && typeof value === 'object' && Object.keys(value).length > 0) {
          add(
            field === 'dependencies' ? 'S1_DEPENDENCIES' : 'S1_DEV_DEPENDENCIES',
            `package.json 含 ${field}: ${Object.keys(value).join(',')}（本项目必须零依赖）`,
          );
        }
      }
      if (pkg.type !== 'module') add('S1_TYPE', 'package.json 缺 "type": "module"');
    }
  }

  // ── S2 骨架目录 ────────────────────────────────────────────────────
  for (const dir of REQUIRED_DIRS) {
    if (!existsSync(join(root, dir))) add('S2_DIR_MISSING', `缺少目录 ${dir}/`);
  }

  // ── S3 两处落点 + config.json ──────────────────────────────────────
  const dirs = landingDirs({
    projectRoot: opts.projectRoot ?? process.cwd(),
    env: opts.env ?? process.env,
  });
  for (const [scope, dir] of Object.entries(dirs)) {
    if (!existsSync(dir)) {
      add('S3_LANDING_MISSING', `${scope} 落点不存在: ${dir}`);
      continue;
    }
    const cfg = join(dir, CONFIG_FILE);
    if (!existsSync(cfg)) {
      add('S3_CONFIG_MISSING', `${scope} 落点缺 ${CONFIG_FILE}: ${cfg}`);
      continue;
    }
    let obj = null;
    try {
      obj = JSON.parse(readFileSync(cfg, 'utf8'));
    } catch (err) {
      add('S3_CONFIG_UNPARSABLE', `${cfg}: ${err.message}`);
      continue;
    }
    for (const problem of validateConfig(obj)) add('S3_CONFIG_INVALID', `${cfg}: ${problem}`);
  }

  // ── S4 零依赖（导入说明符 + require 调用；均先剥非代码） ──────────
  for (const file of listModules(root)) {
    const text = readFileSync(file, 'utf8');
    for (const spec of collectSpecifiers(toCode(text))) {
      if (!ALLOWED_PREFIXES.some((p) => spec.startsWith(p))) {
        add('S4_BARE_IMPORT', `${file}: 裸导入 "${spec}"（只允许 node:/相对路径）`);
      }
    }
    if (RE_REQUIRE.test(toCode(text, { blankStrings: true }))) {
      add('S4_CJS_REQUIRE', `${file}: 出现 require('<模块>')（本项目为纯 ESM）`);
    }
    // S5：禁 localeCompare（跨平台排序必须用码位比较，见 platform/out.mjs sortCodePoints）
    // 用 blankStrings:true —— 否则本文件里 FINDING 消息**字符串**中的 "localeCompare(" 会被自己命中
    // （2026-09-14 实测：S5 初版即因此自match，真实树 6 个用例连带报红）
    if (RE_LOCALE_COMPARE.test(toCode(text, { blankStrings: true }))) {
      add('S5_LOCALE_COMPARE', `${file}: 出现 localeCompare(（跨平台排序禁用，改用码位比较）`);
    }
    // S6：重复导入绑定（同一文件里两个 import 语句绑定同名标识符 -> node 直接 SyntaxError）
    // 来历：LF-240 统一三个 bin 时，我在 cli.mjs 里把 RC/checkSchema 各导入了两次，
    //       靠 `node --check` 才发现；这条检查把它变成提交前的机械门禁。
    // 约束：①只扫**代码位置**（blankStrings:true）——否则模板字面量里的 worker 代码会被误判（3 条假阳性实测）
    //       ②故正则不要求说明符带引号（见 duplicateImportBindings 的注释）
    for (const dup of duplicateImportBindings(toCode(text, { blankStrings: true }))) {
      add('S6_DUPLICATE_IMPORT', `${file}: 重复导入绑定 "${dup}"（node 会直接 SyntaxError）`);
    }
  }

  // ── S7 落点：**唯一权威源 + 兼容窗口**（R2，2026-09-16）
  // 来历①（2026-09-15 事故）：改名 `lessonflow` → `dsh-rulekeeper` 时一次性文本替换把
  //   `join(root, '.dsh-ai', 'lessonflow')` 里的落点名字面量也换掉 → CLI 默认落点漂移、真项目数据看不见。
  // 来历②（2026-09-16 老板批 R2=D）：落点**正式改名 `rulekeeper`**，但必须给老落点留兼容窗口
  //   （解析顺序：显式 > 已存在的新 > 已存在的旧 > 新），且**新建只能用新名**。
  // 四条机械检查：
  //   ① `LANDING_DIRNAME === 'rulekeeper'`；② `LEGACY_LANDING_DIRNAME === 'lessonflow'`（兼容常量必须存在且值固定）；
  //   ③ paths.mjs 必须导出 `resolveProjectLanding` / `resolveUserLanding`（解析唯一入口）；
  //   ④ 除 paths.mjs 外，发布面（src/）不得出现 `'.dsh-ai', '<名字>'` 这种**拆开的字面量**。
  const pathsFile = join(root, 'src', 'platform', 'paths.mjs');
  if (!existsSync(pathsFile)) {
    add('S7_PATHS_MISSING', `缺少 ${relative(root, pathsFile)}`);
  } else {
    const pt = readFileSync(pathsFile, 'utf8');
    const m = /export\s+const\s+LANDING_DIRNAME\s*=\s*'([^']*)'/.exec(pt);
    if (m === null) add('S7_LANDING_CONST_MISSING', 'src/platform/paths.mjs 必须导出 LANDING_DIRNAME（落点名的唯一权威源）');
    else if (m[1] !== 'rulekeeper') add('S7_LANDING_CONST_DRIFT', `LANDING_DIRNAME 必须是 'rulekeeper'（R2 新默认），实际 '${m[1]}'`);
    const lm = /export\s+const\s+LEGACY_LANDING_DIRNAME\s*=\s*'([^']*)'/.exec(pt);
    if (lm === null) add('S7_LEGACY_CONST_MISSING', "必须导出 LEGACY_LANDING_DIRNAME（R2 兼容窗口：老落点名，禁用于新建）");
    else if (lm[1] !== 'lessonflow') add('S7_LEGACY_CONST_DRIFT', `LEGACY_LANDING_DIRNAME 必须是 'lessonflow'，实际 '${lm[1]}'`);
    for (const fn of ['resolveProjectLanding', 'resolveUserLanding']) {
      if (!new RegExp(`export\\s+function\\s+${fn}\\b`).test(pt)) {
        add('S7_RESOLVER_MISSING', `src/platform/paths.mjs 必须导出 ${fn}()（落点解析唯一入口）`);
      }
    }
  }
  for (const file of listModules(root)) {
    if (file === pathsFile) continue;
    // 只管**发布面**（src/）：测试/脚本里的 `join(x, '.dsh-ai', 'lessonflow')` 是**夹具**，
    // 刻意写成字面量（黑盒），不套用本条；`toCode()` 会抹掉注释与正则字面量 ⇒ 本规则不会自 match。
    if (!file.startsWith(join(root, 'src') + sep)) continue;
    const text = readFileSync(file, 'utf8');
    if (RE_LANDING_HARDCODED.test(toCode(text))) {
      add('S7_LANDING_HARDCODED', `${file}: 落点路径不得写拆开的字面量（改用 platform/paths.mjs 的 LANDING_DIRNAME / LANDING_REL）`);
    }
  }

  // ── S8 公开面去内部关联（**防复发**：本条来自一次真实事故）
  // 事故（2026-09-15）：本仓是 **public**，我却在 README 里写了"与某内部项目的关系"，
  //   还带出内部机器名、内部台账路径、内部工具名 —— 等于把私密项目的存在与结构公开了出去。
  // 判据：包内（发布面 src/bin/test/scripts + 顶层文档）**不得**出现内部标识、本地绝对路径、
  //   **基础设施标识**（真实 IPv4 / 私钥头 / 云凭据真值 / 私钥文件名）。
  //   列表刻意写死为"具体标识"（不写宽），避免误伤正常英文单词。
  //   2026-09-16 扩（要求"独立多平台通用 + 公开面不得出现个人的主机/服务器信息"）：后四条是**通用**模式，
  //   不针对任何具体主机 ⇒ 谁的基础设施信息漏进来都拦得住；本包实测 0 命中（不误伤自身）。
  //
  // **2026-09-19 第三次复发后提到模块级**：S8 以前只能靠"跑一次 selfcheck"发现，而它已经因为
  //   "新写文件的注释里带内部路径"复发了三次（脚本探针 → src/landing.mjs → src/similarity.mjs）。
  //   现在模式表与扫描函数**导出**，由 `gate.precommitGate` 在**提交那一刻**对暂存文件跑一遍
  //   ⇒ 复发的代价从"下次跑自检才发现"降到"当场提交被拒"。

  // **按仓库性质分档**：公开仓跑完整表（identity + infra），私有仓只跑 infra。
  // 检测器自身（src/redact.mjs、src/selfcheck.mjs）的元数据例外由模式表里的 `allow` 负责。
  const repoPatterns = resolveRepoPatterns({ root, landingDir: dirs.project });
  const FORBIDDEN = repoPatterns.forbidden;
  for (const file of listPublicFace(root)) {
    const rel = relative(root, file).split(sep).join('/');
    // 夹具/派生品里的历史文本允许保留（它们是被测输入，不是对外文档）；但 src/ 与顶层文档必须干净
    if (rel.startsWith('test/fixtures/')) continue;
    const text = readFileSync(file, 'utf8');
    for (const leak of findPublicFaceLeaks(rel, text, FORBIDDEN)) {
      add('S8_INTERNAL_LEAK', `${rel}: 出现${leak.why}「${leak.match}」（${repoPatterns.kind === 'public' ? '公开仓' : '私有仓'}不得暴露内部标识/本地路径/基础设施信息）`);
    }
  }

  // ── S9 **模块接线检查**（"已实现未生效"的机械门禁，LF-A80；2026-09-19）
  //
  // 来历（老板当场指出）：`src/inject.mjs` 是 LF-430 的完整实现（追加语义 / 唯一 id / 预算 / 白名单模板，
  //   自带整套用例且全绿），**却没有任何代码路径会调用它** —— 写完了、测过了、装上了，就是没用。
  //   同族形态还有：`rules.json` 的 `checks`/`gates`/`inject` 三个数组**没有任何消费者**、
  //   `findings.jsonl` **没有任何生产者**（数据契约冻结了，实现却没接上）。
  //   **用例全绿抓不出这类问题**（用例只证明函数本身对），必须以**调用图**为判据。
  // 判据：`src/**/*.mjs` 必须**从真实入口可达**（`index.js` / `bin/*.mjs` 起，沿静态 import 传递闭包）。
  //
  // **S9 v2（2026-09-19 对抗性 QA 9 号发现后加固）**：v1 只问"有没有哪个文件 import 它"，
  //   被三条路绕过：①模板字面量里写一行假 import ②从没被调用的 `() => import('./x.mjs')`
  //   ③把孤儿模块 A 挂在另一个孤儿 B 上（B 被报、A 逃掉）。v2 三条一起堵：
  //   入口 = index.js + bin/*.mjs；边只认**静态** import 且**先抹掉模板内容与动态 import**；判据变为**可达性**。
  {
    const srcPrefix = join(root, 'src') + sep;
    // 例外表是**本包专属**（独立 CR nit #12）：对别的 root 求值只会恒报 3 条噪声 ⇒ 先认包名。
    let isThisPkg = false;
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      isThisPkg = pkg !== null && typeof pkg === 'object' && pkg.name === 'dsh-rulekeeper';
    } catch { isThisPkg = false; }
    if (isThisPkg) {
      for (const rel of Object.keys(S9_CONSUMER_API)) {
        if (!existsSync(join(root, rel))) {
          add('S9_STALE_ALLOWLIST', `S9 例外表里的 ${rel} 已不存在（例外必须随文件一起回收，否则表会腐烂）`);
        }
      }
    }
    const entries = [];
    const indexPath = join(root, 'index.js');
    if (existsSync(indexPath)) entries.push(indexPath);
    const binDir = join(root, 'bin');
    if (existsSync(binDir)) {
      for (const name of readdirSync(binDir)) if (String(name).endsWith('.mjs')) entries.push(join(binDir, String(name)));
    }
    const edgesOf = (file) => {
      const raw = blankDynamicImports(blankTemplateLiterals(readFileSync(file, 'utf8')));
      const out = [];
      for (const spec of collectSpecifiers(toCode(raw))) {
        if (!spec.startsWith('.')) continue;
        const target = resolve(dirname(file), spec);
        out.push(existsSync(target) ? target : `${target}.mjs`, join(target, 'index.mjs'));
      }
      return out;
    };
    const reachable = new Set();
    const queue = [...entries];
    const norm = (p) => resolve(p).toLowerCase();   // 大小写不敏感文件系统（CR nit #11：字符串比对会假红）
    while (queue.length > 0) {
      const file = queue.pop();
      const key = resolve(file);
      if (reachable.has(norm(key))) continue;
      reachable.add(norm(key));
      if (!existsSync(key)) continue;
      for (const next of edgesOf(key)) if (!reachable.has(norm(next))) queue.push(next);
    }
    for (const file of listModules(root)) {
      if (!file.startsWith(srcPrefix)) continue;
      const rel = relative(root, file).split(sep).join('/');
      if (reachable.has(norm(file))) continue;
      // 例外**一律生效**（按相对路径匹配）：包被改名/被复制成夹具时豁免语义不变；
      // 只有"例外表是否腐烂"（S9_STALE_ALLOWLIST）才限定在本包内求值（CR nit #12）。
      if (Object.hasOwn(S9_CONSUMER_API, rel)) continue;
      add('S9_UNWIRED_MODULE', `${rel}: 从入口（index.js / bin/*.mjs）沿静态 import **不可达**（"已实现未生效"——写了模块没人用，等于没写）`);
    }
  }

  // ── S10 **判据自证检查**（规则 41/42/43 在本包的机械面；2026-09-19）
  //
  // 来历：老板把 SKILL §9.17 的四条纪律升格进用户级规则后要求"真拦"，而不是只写在文档里。
  // 规则 44 已由 S9 机械判定；41/42/43 是**关于"判据怎么写"**的纪律 —— 其可机械化部分不是"风格"，
  // 而是**本包验证代码里必须存在的结构性事实**：
  //   S10a（规则 41）命中判定必须落在**载体自身**（`carrierVerdictOf(`），且**不得**退回聚合布尔
  //        （`hit.ok === false`）—— 那正是独立 CR 抓到的 blocker（L614）。
  //   S10b（规则 42）违规样本必须**构造**（`buildSampleLanding(`），不得依赖"现场恰好处于违规态"（L615）。
  //   S10c（规则 43）发布面带**自称型签字** flag ⇒ README 必须同时有**自曝**（"不是签名/声明"）（L616）。
  //
  // 只在本包（存在 `src/effect.mjs`）时求值 S10a/b：对别的 root 求值只会产生噪声。
  const effectFile = join(root, 'src', 'effect.mjs');
  if (existsSync(effectFile)) {
    const src = readFileSync(effectFile, 'utf8');
    if (/hit\.ok\s*===?\s*false/.test(src)) {
      add('S10_AGGREGATE_AS_HIT', 'src/effect.mjs: 命中判定不得用聚合布尔（`hit.ok === false`）——必须取载体自己的 verdict（规则 41 · L614 的 blocker 回归门）');
    }
    if (!/carrierVerdictOf\(/.test(src)) {
      add('S10_OBJECT_VERDICT_MISSING', 'src/effect.mjs: 找不到 `carrierVerdictOf(`（对象级判定缺失）——规则 41 要求判据落在被测对象自身');
    }
    if (!/buildSampleLanding\(/.test(src)) {
      add('S10_SAMPLE_NOT_CONSTRUCTED', 'src/effect.mjs: 找不到 `buildSampleLanding(`——规则 42 要求违规样本**构造**出来，不得依赖现场状态');
    }
  }
  // S10c 配对检查：自称型签字 flag ⇔ 自曝（跨文件、可机械判定）
  {
    const flagRe = /--by\s+human|by\s*===?\s*'human'|--attested-by|--approved-by/;
    const disclosureRe = /不是[\s"'“”‘’]{0,2}签名|声明[，,、]?\s*不是|自称/;   // 容忍 README 里的引号（第一版写死"不是签名"⇒ 对自己的 README 假红）
    const testPrefix = join(root, 'test') + sep;
    const flagged = [];
    for (const file of listModules(root)) {
      if (file.startsWith(testPrefix)) continue;
      if (flagRe.test(readFileSync(file, 'utf8'))) flagged.push(relative(root, file).split(sep).join('/'));
    }
    if (flagged.length > 0) {
      const readmePath = join(root, 'README.md');
      const readme = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : '';
      if (!disclosureRe.test(readme)) {
        add('S10_SELF_ATTEST_NO_DISCLOSURE', `发布面带自称型签字（${flagged.join(', ')}），但 README 缺少自曝（应写明"这是声明、不是签名"）——规则 43 · L616`);
      }
    }
  }

  return { ok: findings.length === 0, findings, dirs };
}
