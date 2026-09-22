#!/usr/bin/env node
// byte-discipline.mjs —— 检查器：**行尾纪律**必须是"显式钉住"的，不能靠机器默认配置（纪律 CAT-TECH，L648/L653）
//
// 来历（两次真实事故，都是"行尾"）：①`.gitattributes` 只按**扩展名**钉 LF，而 git hook 脚本**没有扩展名**
//   ⇒ autocrlf=true 的机器一 checkout 就转成 CRLF ⇒ 与 sha256 清单不符、POSIX 上 shebang 直接坏掉
//   （L648）；②`test/fixtures/**` 是逐字基准，被转换后逐字比对全红而肉眼看不出来（LF-250）。
//   两次的共同形态：**判据依赖机器的默认配置，而不是仓库里的显式声明**。
//
// 判据（五条，任一命中 ⇒ exit 1）：
//   A. `BYTE_EOL_INCONSISTENT`：同一文件里既有 CRLF 又有裸 LF（**按字节计数**判，不靠肉眼）
//      —— 混行尾是最常见的"肉眼看不见"事故形态。
//   B. `BYTE_NOT_DECLARED`：有 `.gitattributes`，但里面**没有**任何"显式钉住"的行
//      （`text` / `-text` / `eol=lf` 三者任一）⇒ 行尾完全交给机器默认配置。
//   C. `BYTE_EXT_PIN_MISSING`：`.githooks/**` 存在，但没被显式钉 —— L648 的原形（无扩展名文件
//      落进"按扩展名钉"的盲区，autocrlf=true 一 checkout 就坏）。
//   D. `BYTE_BOM_PRESENT`：文本文件以 **UTF-8 BOM** 开头（`EF BB BF`）。BOM 会让"逐字比对"与
//      某些工具（shebang 解析、JSON 严格解析）出问题，且肉眼看不见。
//   E. `BYTE_NO_TRAILING_NEWLINE`：文本文件**结尾没有换行**（POSIX 文本文件约定；也是 diff 噪音来源）。
//
// **D/E 可限定范围**（`RULEKEEPER_BYTE_STRICT_DIRS`，冒号分隔的相对目录前缀）：
//   实测 D/E 在真实仓里噪声很大——某仓 6647 个文本文件里有 **17 个 BOM + 460 个无结尾换行**，
//   其中绝大多数是**生成态**（`.eval/`、状态目录、机器写出的 JSON）。按规则 53（先量误报面、
//   假阳 ≥30% 即止损），D/E 默认**只扫"仓库自己手写的面"**：`src/` `scripts/` `bin/` `test/` `docs/`；
//   要全量扫（或换成别的面），设这个环境变量。
//
// **扫描面**（`RULEKEEPER_BYTE_SCAN`，`tracked`（默认）/ `filesystem`）：
//   默认**只扫 git 已跟踪的文件**。理由（P10 第二段实测）：被判据报出来的清单会被当成"要修的全集"，
//   而**未跟踪/被 `.gitignore` 忽略**的本地文件（某仓的 `docs/archive/**` 里程碑草稿）根本不在仓库承诺面内；
//   把它们混进清单，会让"按清单迭代收敛"永远收敛不到零（改了也不进库，下轮照报）。
//   `filesystem` 模式保留全盘扫（需要看本地私有文件的字节形态时用），两种模式都在首行打印 `MODE=` 与 `UNTRACKED_FILES=`。
//
// 通用性：不假定任何具体项目结构——"必须钉什么"由**仓库自己声明**（`.gitattributes`），
//   而"有没有声明、混没混行尾、有没有 BOM/丢没丢结尾换行"都是可机械判定的。只读、零网络、零写入。
//
// 约定（见 src/checker.mjs 顶部）：被检根 = `RULEKEEPER_SAMPLE_DIR ?? cwd`；
//   命中 ⇒ exit 1；干净 ⇒ exit 0；**没有 .gitattributes 且没有 .githooks ⇒ exit 2**（没有被测对象）。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.env.RULEKEEPER_SAMPLE_DIR ?? process.cwd();
// `test-fixtures/` 是**夹具面**：那里放的是"故意违规的样本"（红态证据），不是被检对象。
// 与 `rk-selfcheck` 的 S8 对夹具的豁免同一口径；被检对象是仓库自己的文件。
const SKIP_DIRS = new Set(['.git', 'node_modules', '.dsh-ai', 'test-fixtures', '.eval', '.codewhale', 'dist', 'build', 'coverage']);
const TEXT_EXT = /\.(?:mjs|cjs|js|ts|md|json|jsonl|ps1|psm1|txt|yml|yaml|sh|go|py)$/i;
/** D/E（BOM / 结尾换行）的默认扫描面 —— 只扫"仓库自己手写的面"，生成态不在内（见文件头 D/E 说明） */
const DEFAULT_STRICT_DIRS = Object.freeze(['src', 'scripts', 'bin', 'test', 'docs']);
const strictDirs = (() => {
  const raw = process.env.RULEKEEPER_BYTE_STRICT_DIRS;
  if (typeof raw === 'string' && raw.trim() !== '') {
    return raw.split(/[:;,]/).map((s) => s.trim().replace(/^\.\//, '').replace(/\/$/, '')).filter((s) => s !== '');
  }
  return [...DEFAULT_STRICT_DIRS];
})();
const inStrictScope = (rel) => strictDirs.some((d) => rel === d || rel.startsWith(`${d}/`));


const gaPath = join(root, '.gitattributes');
const hooksDir = join(root, '.githooks');
if (!existsSync(gaPath) && !existsSync(hooksDir)) {
  console.log('BYTE_DISCIPLINE_SUBJECT=absent（既无 .gitattributes 也无 .githooks ⇒ 本条不适用）');
  process.exit(2);
}

const hits = [];
const gaText = existsSync(gaPath) ? readFileSync(gaPath, 'utf8') : '';
const lines = gaText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));

/** 这一份 .gitattributes 有没有"显式钉住行尾形态"的行 */
const pins = lines.filter((l) => {
  const attrs = l.split(/\s+/).slice(1);
  return attrs.includes('text') || attrs.includes('-text') || attrs.some((a) => /^eol=(lf|crlf)$/.test(a));
});

// ── A/D/E. 遍历文本文件（混行尾全扫；BOM/结尾换行只在手写面上判）─────────────────
// **P10 修正（2026-09-22，被治理项目侧实测）**：原实现把每类违规 `slice(0, 5/8)` 打印，且清单顺序
// 来自遍历顺序 ⇒ ①"看到的 ≠ 全部"不可见（他们据此写迭代收敛循环，四轮改了 57 个文件才发现）；
// ②同输入不同顺序（他们实测四轮的文件集合几乎不重叠）。现在：**全量收集 → 按 (rel, code) 确定化排序
// → 全量打印**，并显式给 `PRINTED` / `TOTAL`；扫描根与"是否含未跟踪文件"也打在首行。
const mixed = [];
const boms = [];
const noEol = [];
let scanned = 0;
let skippedBinary = 0;
let skippedUntracked = 0;
// **扫描面**（2026-09-22，P10 第二段：他们实测检查器会扫到被 `.gitignore` 忽略的本地文件，
// 于是"用它报的 list 当全集去迭代"一直在**比预期更大**的群体上打转）。
// 默认 `tracked`（**只扫 git 跟踪的文件**）：字节纪律判的是"**入库内容**在各种检出上是否一致"，
// 未跟踪/被忽略的文件属本地状态、天然不在承诺面内。要全盘扫（含未跟踪）设 `RULEKEEPER_BYTE_SCAN=filesystem`。
const SCAN_MODE = process.env.RULEKEEPER_BYTE_SCAN === 'filesystem' ? 'filesystem' : 'tracked';
const isGitRepo = existsSync(join(root, '.git'));
/** 已跟踪文件的相对路径集合（posix）；非 git 仓或 git 失败 ⇒ `null`（如实降级为"文件系统扫"，并打标） */
const trackedSet = (() => {
  if (SCAN_MODE !== 'tracked' || !isGitRepo) return null;
  const r = spawnSync('git', ['-c', 'core.quotePath=false', '-C', root, 'ls-files', '-z'], { encoding: 'buffer' });
  if (r.status !== 0 || r.stdout === null) return null;
  const set = new Set();
  for (const p of String(r.stdout).split('\0')) if (p.trim() !== '') set.add(p.split('\\').join('/'));
  return set;
})();
const scanModeEffective = trackedSet === null ? 'filesystem' : 'tracked';

const walk = (dir) => {
  let names;
  try {
    names = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    // 嵌套仓/子模块不是本仓内容（`git ls-files` 也不会列它）
    if (existsSync(join(full, '.git'))) continue;
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full);
      continue;
    }
    const rel = full.slice(root.length).replace(/^[\\/]/, '').split('\\').join('/');
    // **未跟踪面**（见上方 SCAN_MODE 说明）：`tracked` 模式下，`git ls-files` 里没有的文件
    //（未跟踪、被 `.gitignore` 忽略、或已被删除但仍留在工作区）**不计入判据**，只计数。
    // 这样"检查器报的清单"就等于"仓库承诺面"，不再包含本地私有文件。
    // ⚠ 计数在**扩展名过滤之前**：`UNTRACKED_FILES` 才是"我到底少看了多少"的如实读数。
    if (trackedSet !== null && !trackedSet.has(rel)) { skippedUntracked += 1; continue; }
    if (!TEXT_EXT.test(name)) continue;
    // 二进制判定（P10 实测的真实风险：`git ls-files` 没跟踪的 `.7z` 备份被当"文本"数行尾，
    // 若按文本"归一"会**损坏压缩包**）。判定 = NUL 字节或 UTF-8 解码出现替换字符。
    const buf = readFileSync(full);
    if (buf.includes(0) || buf.toString('utf8').includes('\uFFFD')) { skippedBinary += 1; continue; }
    scanned += 1;
    // 判"混行尾"必须**按字节**：数出 `\r\n` 的个数与 `\n` 的总数，不等就是混
    //（写第一版时用"把 \r\n 换成 \n 再看还有没有 \n" ⇒ 恒真、连纯 CRLF 都误报，用例当场抓到）。
    // ⚠ **不要在这里提前 `continue`**：加过一版 `if (!crlf) continue;`（想省两次计数），
    // 结果把下面的 D/E 一起跳过了 ⇒ LF 文件**从不参与**"结尾换行"检查（实测：本仓 `src/gate.mjs`
    // 缺结尾换行、判据却报 0）。这个 bug 活过了 `byte-discipline@1` 那一版与一次误报面检查。
    let crlfCount = 0;
    for (let i = 1; i < buf.length; i += 1) if (buf[i] === 0x0a && buf[i - 1] === 0x0d) crlfCount += 1;
    let lfCount = 0;
    for (let i = 0; i < buf.length; i += 1) if (buf[i] === 0x0a) lfCount += 1;
    // A（混行尾）：既有 CRLF 又有裸 LF
    if (crlfCount > 0 && lfCount > crlfCount) mixed.push(rel);
    // D/E 只在"仓库自己手写的面"上判（生成态噪声大，见文件头说明）
    if (!inStrictScope(rel)) continue;
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) boms.push(rel);
    if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) noEol.push(rel);
  }
};
if (existsSync(root)) walk(root);

// **确定化排序**（P10）：同一仓库连跑两次，打印的文件集合与顺序必须逐字相同。
const byPathThenCode = (code) => (a, b) => (a < b ? -1 : a > b ? 1 : 0) || (code < code ? -1 : 1);
mixed.sort(byPathThenCode('BYTE_EOL_INCONSISTENT'));
boms.sort(byPathThenCode('BYTE_BOM_PRESENT'));
noEol.sort(byPathThenCode('BYTE_NO_TRAILING_NEWLINE'));
// **全量收集**（不再 slice）：逐条推入 hits；截断交给末行的 PRINTED/TOTAL 显式交代。
for (const rel of mixed) {
  hits.push(`BYTE_EOL_INCONSISTENT: ${rel} 同一文件里既有 CRLF 又有裸 LF（混行尾：肉眼看不见，逐字比对会假红）。`
    + '修法优先 `git restore -- <路径>`（从 blob 刷新工作区：blob 本就是 LF，混行尾只是**工作区**现象 ⇒ 零内容改动、无需提交）；'
    + '确实要改内容时才动字节，**别对二进制做行尾手术**。');
}
for (const rel of boms) {
  hits.push(`BYTE_BOM_PRESENT: ${rel} 以 UTF-8 BOM 开头（肉眼看不见；会让逐字比对与严格解析出问题）`);
}
for (const rel of noEol) {
  hits.push(`BYTE_NO_TRAILING_NEWLINE: ${rel} 结尾没有换行（POSIX 文本文件约定；也是 diff 噪音来源）`);
}

// ── B. 有 .gitattributes 却一行钉规则都没有 ─────────────────────────────────────
if (existsSync(gaPath) && pins.length === 0) {
  hits.push('BYTE_NOT_DECLARED: .gitattributes 存在但**没有任何**钉行尾形态的行（text / -text / eol=lf）⇒ 行尾完全交给机器默认配置');
}

// ── C. .githooks 存在但没显式钉（L648 的原形：无扩展名文件落进按扩展名钉的盲区）──
if (existsSync(hooksDir)) {
  const pinned = lines.some((l) => {
    const [pattern, ...attrs] = l.split(/\s+/);
    if (!/^\.githooks\/(?:\*|\*\*)$/.test(pattern)) return false;
    return attrs.some((a) => a === 'eol=lf') && !attrs.includes('-text');
  });
  if (!pinned) {
    hits.push('BYTE_EXT_PIN_MISSING: .githooks/ 存在，但 .gitattributes 没有显式钉 `.githooks/* text eol=lf`（hook 脚本无扩展名，按扩展名的规则管不到；autocrlf=true 一 checkout 就坏）');
  }
}

// 首行把**扫描根 / 是否含未跟踪文件 / 跳过面**全部交代清楚（P10：他们的迭代失控有一半来自
// "不知道这一份清单覆盖到哪"）：扫的是**文件系统**，因此包含被 `.gitignore` 忽略的本地文件；
// 二进制按 NUL/替换字符跳过并计数（不让行尾手术伤到压缩包）。
console.log(`BYTE_DISCIPLINE_ROOT=${root.split('\\').join('/')} GITATTRIBUTES=${existsSync(gaPath) ? 'present' : 'absent'} PINS=${pins.length} HOOKS=${existsSync(hooksDir) ? 'present' : 'absent'} STRICT_DIRS=${strictDirs.join(',') || '(all)'}`);
console.log(`BYTE_DISCIPLINE_SCOPE MODE=${scanModeEffective} INCLUDES_UNTRACKED=${scanModeEffective === 'tracked' ? 'no' : 'yes'} INCLUDES_GITIGNORED=${scanModeEffective === 'tracked' ? 'no' : 'yes'} UNTRACKED_FILES=${skippedUntracked} SKIPPED_BINARY=${skippedBinary} SCANNED=${scanned}`);
console.log(`BYTE_DISCIPLINE_COUNTS mixed=${mixed.length} bom=${boms.length} noeol=${noEol.length}`);
if (hits.length > 0) {
  console.log(`BYTE_DISCIPLINE_VIOLATIONS=${hits.length}`);
  // **全量打印**（P10：原先 slice 截断且顺序不稳 ⇒ "看到的 ≠ 全部"不可见，他们据此迭代改错 57 个文件）
  for (const h of hits) console.log(`  ${h}`);
  console.log(`BYTE_DISCIPLINE_PRINTED=${hits.length} TOTAL=${hits.length} TRUNCATED=no`);
  process.exit(1);
}
console.log('BYTE_DISCIPLINE_VIOLATIONS=0');
console.log('BYTE_DISCIPLINE_PRINTED=0 TOTAL=0 TRUNCATED=no');
process.exit(0);
