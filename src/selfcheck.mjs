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
import { join, relative, sep } from 'node:path';
import { CONFIG_FILE, landingDirs, validateConfig } from './config.mjs';

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
  const FORBIDDEN = [
    { re: /\bmyxV2\b/i, why: '内部项目名' },
    { re: /\bmyx-[a-z]/i, why: '内部工具名' },
    { re: /\bMYX_[A-Z]/i, why: '内部结果行前缀' },
    { re: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/i, why: '本机用户绝对路径' },
    { re: /[A-Za-z]:\\opt\\/i, why: '本机盘符路径' },
    { re: /\bpresets\b/i, why: '内部容器仓名' },
    { re: /\b101\b/, why: '内部主机编号' },
    // 「检测器自身必须写出模式」的例外（**只对检测模块生效**，且私钥头还要求文件里没有真密钥正文）：
    //   src/redact.mjs 与 src/selfcheck.mjs 是**脱敏/门禁的实现**，它们必须包含模式字面量 —— 属元数据，不是凭据。
    //   防滥用：私钥头例外额外要求"该文件里没有 60+ 字符的 base64 正文"（真密钥被粘进来仍会被抓）。
    {
      re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      why: '私钥头（凭据）',
      allow: (rel, _s, text) => (rel === 'src/redact.mjs' || rel === 'src/selfcheck.mjs') && !/[A-Za-z0-9+/]{60,}/.test(text),
    },
    {
      re: /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/,
      why: '真实 IPv4（基础设施标识）',
      allow: (rel, s) => s === '127.0.0.1' || s === '0.0.0.0',   // 回环/未指定不算基础设施标识
    },
    { re: /\b(?:ali[_-]?key|ali[_-]?secret|cf[_-]?token|aws_secret_access_key|api[_-]?key|password|passwd)\b\s*[:=]\s*['"][^'"]{8,}/i, why: '云凭据/口令真值' },
    {
      re: /\b(?:id_rsa|id_ed25519)\b|\.pem\b/i,
      why: '私钥文件名（基础设施标识）',
      allow: (rel) => rel === 'src/selfcheck.mjs',   // 仅本模式表自身
    },
  ];
  for (const file of listPublicFace(root)) {
    const rel = relative(root, file).split(sep).join('/');
    // 夹具/派生品里的历史文本允许保留（它们是被测输入，不是对外文档）；但 src/ 与顶层文档必须干净
    if (rel.startsWith('test/fixtures/')) continue;
    const text = readFileSync(file, 'utf8');
    for (const { re, why, allow } of FORBIDDEN) {
      // 逐次全局匹配（原实现用 re.exec 只看第一处，且带 allow 白名单时无法跳过）：
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
      for (const m of text.matchAll(g)) {
        if (typeof allow === 'function' && allow(rel, m[0], text)) continue;
        add('S8_INTERNAL_LEAK', `${rel}: 出现${why}「${m[0]}」（公开仓不得暴露内部标识/本地路径/基础设施信息）`);
        break;   // 每个文件每类只报一次，避免刷屏
      }
    }
  }

  return { ok: findings.length === 0, findings, dirs };
}
