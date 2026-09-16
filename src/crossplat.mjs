// dsh-rulekeeper · LF-2D0 跨平台验证（**三层判据**，且如实声明哪层不做）
//
//   L1 **结构**：源码行尾/BOM、零依赖、**import 大小写与磁盘一致**（Windows 大小写不敏感 → Linux 敏感，
//                这是最经典的"本机绿、Linux 红"假绿来源）
//   L2 **归一文本**：两次输出删 CR + `\`→`/` + 绝对前缀替换 + 固定 --now 后 **diff 必须 0 行**
//   L3 **同平台逐字**：Windows 上同一命令两次运行**逐字**相同（LF-130 的口径）
//      **L3 跨平台：不做**（该主机无 node；本机无 WSL 发行版 / 无 docker·podman；Git Bash 的 node 是 Windows node
//      ⇒ 没有 Linux 载体）。这一层在输出里显式标 `RK_CROSSPLAT_L3_CROSS=false` + 原因，
//      并对"声称 Linux 验证通过"的调用**判红**（防假绿）。
//
// 归属：core 模块。零依赖：只用 node:*。

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { measureFile, readTextFile, PKG_ROOT } from './checks.mjs';
import { pathKey, relativeToRoot, toPosix } from './platform/paths.mjs';
import { normalizeTarget } from './rules.mjs';
import { readLines } from './append.mjs';

/** L3 跨平台判据**不做**（如实声明）——任何"Linux 已验证"的宣称都要先推翻这句 */
export const L3_CROSS_DONE = false;
export const L3_CROSS_REASON = 'LF-650 实测：一台 Linux 主机（Ubuntu 26.04）无 node；本机无 WSL 发行版、无 docker/podman；'
  + 'Git Bash 的 node 即 Windows node ⇒ 无 Linux 载体，L3 跨平台判据不成立（只保留同平台逐字 L3-Windows）';
/** 相对 import 说明符（只认**以 import 开头的行**，避免把测试夹具里的示例代码当导入） */
const RE_RELATIVE_IMPORT = /from\s+['"](\.[^'"]+)['"]/g;

/**
 * L1 结构检查（四项，每项都对应一类真实的"本机绿、别处红"）：
 *   ① 所有 `.mjs` **LF 无 BOM**（跨平台 diff 的前提）
 *   ② **零依赖**（`dependencies` 为空 = 没有平台相关原生模块）+ `type: module` + `engines.node` 声明
 *   ③ `src/`+`bin/` 的**相对 import 大小写与磁盘逐段一致**（Windows 不区分、Linux 区分 → 最经典的假绿）
 *   ④ `src/`+`bin/` 的顶层 `import` 目标必须**真实存在**
 * 来历（自曝）：初版还加了"禁 `\r\n` 字面量"，结果把**正当处理行尾**的模块（out.mjs）与自己都判红——
 * 属"检查器打自己的脸"；且它并非跨平台真缺陷，故删除规则而不是加白名单。
 */
export function structuralChecks({ pkgRoot = PKG_ROOT } = {}) {
  const findings = [];
  const files = [];
  for (const dir of ['src', 'bin', 'test', 'scripts']) {
    const abs = join(pkgRoot, dir);
    if (!existsSync(abs)) continue;
    const walk = (d) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith('.mjs')) files.push(p);
      }
    };
    walk(abs);
  }
  const crlfFiles = [];
  const bomFiles = [];
  for (const file of files) {
    const bytes = readFileSync(file);
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bomFiles.push(file);
    if (bytes.includes(0x0d)) crlfFiles.push(file);
  }
  // import 大小写：只扫 src/ + bin/（部署面），且只看以 import 开头的行
  const caseMismatches = [];
  const missingImports = [];
  for (const file of files) {
    const rel = toPosix(relativeToRoot(file, pkgRoot) ?? file);
    if (!(rel.startsWith('src/') || rel.startsWith('bin/'))) continue;
    const text = readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      if (!/^\s*import\b/.test(line)) continue;
      for (const m of line.matchAll(RE_RELATIVE_IMPORT)) {
        const spec = m[1];
        const segments = spec.replace(/^\.\//, '').split('/');
        let cursor = resolve(file, '..');
        for (const seg of segments) {
          if (seg === '.' || seg === '') continue;
          if (seg === '..') { cursor = resolve(cursor, '..'); continue; }
          let entries;
          try { entries = readdirSync(cursor); } catch { entries = []; }
          if (entries.includes(seg)) { cursor = join(cursor, seg); continue; }
          // 大小写不敏感回查（LF-565）：Linux 上精确路径不存在时，若存在"只差大小写"的同名项，
          // 必须报 **CASE** 而不是 MISSING —— 否则"Windows 不敏感 / Linux 敏感"这个经典假绿在 Linux 上被降级成"文件不存在"
          const ci = entries.find((e) => e.toLowerCase() === seg.toLowerCase());
          if (ci !== undefined) caseMismatches.push({ file, spec, segment: seg, onDisk: ci });
          else missingImports.push({ file, spec });
          cursor = null;
          break;
        }
        if (cursor !== null && !existsSync(cursor)) missingImports.push({ file, spec });
      }
    }
  }
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  const dependencies = Object.keys(pkg.dependencies ?? {});
  if (dependencies.length > 0) findings.push({ code: 'CROSSPLAT_DEPS_NOT_EMPTY', message: `零依赖被破坏: ${dependencies.join(',')}` });
  if (pkg.type !== 'module') findings.push({ code: 'CROSSPLAT_TYPE_NOT_MODULE', message: `package.json type 必须是 module（收到 ${String(pkg.type)}）` });
  if (typeof pkg.engines?.node !== 'string' || pkg.engines.node === '') findings.push({ code: 'CROSSPLAT_ENGINES_MISSING', message: 'package.json 缺 engines.node（跨机器可预期性）' });
  for (const f of crlfFiles) findings.push({ code: 'CROSSPLAT_CRLF_FILE', message: `${toPosix(f)} 含 CR（跨平台 diff 噪音源）` });
  for (const f of bomFiles) findings.push({ code: 'CROSSPLAT_BOM_FILE', message: `${toPosix(f)} 带 UTF-8 BOM` });
  for (const mm of missingImports) findings.push({ code: 'CROSSPLAT_IMPORT_MISSING', message: `import 目标不存在: ${toPosix(mm.file)} -> ${mm.spec}` });
  for (const mm of caseMismatches) findings.push({ code: 'CROSSPLAT_IMPORT_CASE', message: `import 大小写不符: ${toPosix(mm.file)} -> ${mm.spec}（段 "${mm.segment}"，磁盘上是 ${mm.onDisk}）` });
  return {
    ok: findings.length === 0,
    files: files.length,
    crlfFiles, bomFiles, caseMismatches, missingImports, dependencies,
    type: pkg.type ?? null,
    engines: pkg.engines ?? null,
    findings,
  };
}

/**
 * 一个"绝对根"在文本里可能出现的**全部写法**（L488 的教训：只试一种写法必漏）。
 * `toPosix` 会把盘符折成小写（`C:\p` → `c:/p`），而正文里通常是原样大小写 —— 两种都要吸。
 */
export function rootVariants(root) {
  if (typeof root !== 'string' || root === '') return [];
  return [...new Set([
    root.replace(/\\/g, '/'),
    toPosix(root),
    toPosix(root).toLowerCase(),
  ])].filter((v) => v !== '');
}

/**
 * L2 归一：删 CR + `\`→`/` + 去掉绝对前缀 + 去行尾空白。
 * **不做**时间戳替换：去掉 `--now` 就必须红（红态判据就靠这个）。
 */
export function normalizeOutput(text, { roots = [] } = {}) {
  let out = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  out = out.split('\n').map((line) => line.replace(/\\/g, '/').replace(/[ \t]+$/, '')).join('\n');
  for (const root of roots) {
    for (const v of rootVariants(root)) out = out.split(v).join('<ABS>');
  }
  return out;
}

/** 归一后逐行 diff（返回不一致的行，便于凭证引用） */
export function compareNormalized(a, b, opts = {}) {
  const na = normalizeOutput(a, opts);
  const nb = normalizeOutput(b, opts);
  const la = na.split('\n');
  const lb = nb.split('\n');
  const diff = [];
  const max = Math.max(la.length, lb.length);
  for (let i = 0; i < max; i += 1) {
    if (la[i] !== lb[i]) diff.push({ line: i + 1, a: la[i] ?? null, b: lb[i] ?? null });
  }
  return { identical: diff.length === 0, diff, normalizedA: na, normalizedB: nb };
}

/**
 * 比对仪器自检（**正对照**）：证明"改 1 字节会被发现"，而"只差 CR / 只差斜杠 / 只差绝对前缀"不算差异。
 * 红态判据之一就是"夹具改 1 字节而比对脚本仍报一致 → 必红"。
 */
export function verifyComparator() {
  const root = 'C:\\proj';
  const cases = [
    { name: '差 1 字节必须被发现', a: 'RK_X=1\n', b: 'RK_X=2\n', expectIdentical: false },
    { name: '只差 CRLF vs LF 必须视为相同', a: 'a\r\nb\r\n', b: 'a\nb\n', expectIdentical: true },
    { name: '只差反斜杠 vs 正斜杠必须视为相同', a: 'path=C:\\proj\\a.txt\n', b: 'path=C:/proj/a.txt\n', expectIdentical: true },
    { name: '只差绝对前缀必须视为相同', a: `LF=P=${root}\\src\\a.mjs\n`, b: 'LF=P=<OTHER>/src/a.mjs\n', expectIdentical: true },
    { name: '不同时间戳必须被视为不同（去掉 --now 就得红）', a: 'RK_NOW=2026-09-14T00:00:00.000Z\n', b: 'RK_NOW=2026-09-14T01:00:00.000Z\n', expectIdentical: false },
  ].map((c) => {
    const cmp = compareNormalized(c.a, c.b, { roots: [root, '<OTHER>'] });
    return { ...c, actualIdentical: cmp.identical, ok: cmp.identical === c.expectIdentical, diffLines: cmp.diff.length };
  });
  return { ok: cases.every((c) => c.ok), cases };
}

/**
 * 注入式"双平台纯函数层"：同一批纯函数在 **win32 写法**与 **posix 写法**下必须得到同一结论。
 * 这是 LF-650 裁定的主判据（没有 Linux 载体时，用"同机双写法"覆盖路径类风险）。
 */
export function injectedPureFunctionCases() {
  const pairs = [
    { name: 'pathKey：C:\\a\\B == c:/a/b', a: pathKey('C:\\a\\B'), b: pathKey('c:/a/b') },
    { name: 'pathKey：\\\\?\\C:\\x == c:/x', a: pathKey('\\\\?\\C:\\x'), b: pathKey('c:/x') },
    { name: 'toPosix：尾斜杠与重复斜杠归一', a: toPosix('c:\\a\\\\b\\'), b: toPosix('c:/a/b') },
    { name: 'toPosix：UNC 保留双斜杠', a: toPosix('\\\\srv\\share\\a'), b: '//srv/share/a' },
    { name: 'normalizeTarget：win 与 posix 写法同值', a: normalizeTarget('C:\\proj\\src\\a.txt', 'C:\\proj'), b: normalizeTarget('c:/proj/src/a.txt', 'c:/proj') },
    { name: 'relativeToRoot：大小写不敏感', a: relativeToRoot('C:\\proj\\src\\a.txt', 'c:/proj'), b: 'src/a.txt' },
  ].map((c) => ({ ...c, ok: c.a === c.b }));
  return { cases: pairs, allEqual: pairs.every((c) => c.ok) };
}

/**
 * 注入式 EOL 检查：同一份内容分别以 LF / CRLF 落盘，读出来的**语义值**必须一致。
 * 记录口径（实证）：`readLines` 的行数一致；`measureFile().maxLineLength` 在 CRLF 下**多 1**（含 CR，见 LF-260 §8）——
 * 这里把这个已知口径**显式断言**成 +1 关系，而不是假装两边完全相等。
 */
export function injectedEolCases() {
  const dir = mkdtempSync(join(tmpdir(), 'lf-eol-'));
  try {
    const lf = join(dir, 'lf.txt');
    const crlf = join(dir, 'crlf.txt');
    const body = '{"a":1}\n{"a":2}\n';
    writeFileSync(lf, body, 'utf8');
    writeFileSync(crlf, body.replace(/\n/g, '\r\n'), 'utf8');
    const rowsLf = readLines(lf);
    const rowsCrlf = readLines(crlf);
    const mLf = measureFile(lf);
    const mCrlf = measureFile(crlf);
    const cases = [
      { name: 'readLines 行数一致（LF vs CRLF）', ok: rowsLf.values.length === rowsCrlf.values.length && rowsLf.badLines === 0 && rowsCrlf.badLines === 0, detail: `${rowsLf.values.length} vs ${rowsCrlf.values.length}` },
      { name: 'measureFile 行数一致', ok: mLf.lines === mCrlf.lines, detail: `${mLf.lines} vs ${mCrlf.lines}` },
      { name: '已知口径：CRLF 的 maxLineLength == LF + 1（含 CR）', ok: mCrlf.maxLineLength === mLf.maxLineLength + 1, detail: `${mLf.maxLineLength} vs ${mCrlf.maxLineLength}` },
      { name: 'sha256 不同（行尾属于内容，快照必须能区分）', ok: mLf.sha256 !== mCrlf.sha256, detail: 'hash differ' },
    ];
    // 夹具用后即焚：把临时目录留在盘上等于每次运行都漏一个目录（L491：不当产物不留在盘上）
    return { cases, allOk: cases.every((c) => c.ok), dir };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 同平台逐字（L3-Windows）：同一命令两次运行必须逐字相同 */
export function windowsByteIdentical({ run, times = 2 } = {}) {
  const outputs = [];
  for (let i = 0; i < times; i += 1) outputs.push(run());
  const identical = outputs.every((o) => o === outputs[0]);
  const shas = outputs.map((o) => createHash('sha256').update(o, 'utf8').digest('hex'));
  return { identical, outputs, shas };
}

/**
 * 防假绿：声称在别的平台验证过、而当前进程平台不符 → 判红。
 * （"Git Bash 的 node 是 Windows node"就属这一类：它在 Windows 上跑，不能算 Linux 验证。）
 */
export function fakePlatformGuard({ claim, platform = process.platform }) {
  if (claim === undefined || claim === null || claim === '') return { ok: true, finding: null };
  if (claim === platform) return { ok: true, finding: null };
  return {
    ok: false,
    finding: {
      code: 'CROSSPLAT_FAKE_PLATFORM_CLAIM',
      message: `声称在 ${claim} 上验证过，但当前进程平台是 ${platform}（Git Bash/Windows node ≠ Linux 载体）-> 该宣称不成立`,
    },
  };
}

/**
 * **模拟"另一平台侧"的文本**（诚实声明：这不是真的在 Linux 上跑，而是把本机输出按 Linux 形态改写）：
 *   · 行尾换成 CRLF（另一侧常见的不同）· 路径分隔符 `\`→`/` · 项目根换成 `<LINUX_ROOT>`
 * 用途：让 L2 的"归一前后"两个数字都非零——否则"归一"这一步在判据里就是摆设（自证式判据）。
 */
export function simulateOtherSide(text, { root = '', eol = '\r\n' } = {}) {
  let out = String(text).replace(/\r\n/g, '\n').split('\n').join(eol);
  out = out.replace(/\\/g, '/');
  // 与 normalizeOutput 用**同一套**写法枚举（否则会出现"这里替换得掉、那里替换不掉"的分裂）
  for (const v of rootVariants(root)) out = out.split(v).join('<LINUX_ROOT>');
  return out;
}

/** 供 CLI 复用的"读一份文件并按相对根归一"的小工具（判据里路径一律相对化） */
export function readNormalized(file, roots) {
  const read = readTextFile(file);
  if (read.ok !== true) return { ok: false, text: null, reason: read.reason };
  return { ok: true, text: normalizeOutput(read.text, { roots }), reason: null };
}

// ── LF-560 **门禁跨平台**（hook 的 shebang / EOL / 可执行位 + Git Bash 语义 + 防假绿）──────
//
// 判据（清单 §5 LF-560）：
//   ① 本机 **Git Bash（POSIX shell 语义）** 验证 shebang / CRLF / 可执行位
//   ② Linux 侧 `tar`+`sha256sum` **文件级**校验通过（本模块不连网；②由取证脚本 + 工具调用完成）
//   红态：把"Git Bash 里 node 能跑"写成**Linux 验证通过** → 必红（其 node 仍是 Windows node）。

/** Linux node 载体**是否存在**（LF-565：平台自适应 —— POSIX 上本机就是 Linux 载体；Windows 上不是） */
export const LINUX_CARRIER_DONE = process.platform === 'linux';
export const LINUX_CARRIER_REASON = process.platform === 'linux'
  ? '本机就是 Linux（真 node 运行时）⇒ 运行级判据在本地成立；文件级/远端校验由 Linux 侧补齐'
  : 'LF-650/LF-560 实测：Linux 主机（Ubuntu 26.04）无 node；本机无 WSL 发行版、无 docker·podman；'
    + 'Git Bash 里的 node = /c/Program Files/nodejs/node（process.platform 仍是 win32）⇒ **本机没有 Linux node 载体**；'
    + '（2026-09-15 补充：Linux 主机已装 Node v22.23.2，**远端**运行级验证已可做，见 LF-565）';
/**
 * 默认 POSIX shell（**平台自适应**，LF-565）：
 *   · Windows：Git Bash 标准安装位置（POSIX shell 语义的合法来源）；
 *   · POSIX（Linux/macOS）：PATH 里的 `bash`（退而求其次 `sh`）。
 * 此前写死 Windows 路径 ⇒ Linux 上探针 spawn 直接 ENOENT、L4 全线失败（"Windows 硬编码"实测）。
 */
export const GIT_BASH_DEFAULT = process.platform === 'win32'
  ? 'C:\\Program Files\\Git\\bin\\bash.exe'
  : 'bash';

/**
 * Git Bash 探针：把"Git Bash 里的 node 是 Windows node"变成**实测事实**（防假绿的事实基础）。
 * @param {{bashPath?: string, run?: (args: string[], opts?: object) => {ok: boolean, stdout: string, status: number|null}}} opts
 */
export function gitBashProbe({ bashPath = GIT_BASH_DEFAULT, run } = {}) {
  const exec = run ?? defaultBashRun(bashPath);
  const unameResult = exec(['-c', 'uname -s 2>/dev/null || echo "(n/a)"']);
  const nodePath = exec(['-lc', 'command -v node 2>/dev/null || echo "(none)"']);
  const nodePlatform = exec(['-lc', 'node -p "process.platform" 2>/dev/null || echo "(none)"']);
  const bashVersion = exec(['-c', 'echo "$BASH_VERSION"']);
  const available = unameResult.ok && unameResult.stdout !== '' && unameResult.stdout !== '(n/a)';
  return {
    available,
    bashPath,
    bashVersion: bashVersion.stdout,
    uname: unameResult.stdout,
    nodePath: nodePath.stdout,
    nodePlatform: nodePlatform.stdout,
    // 判定"是 Windows node"用的是 node 自己报的 process.platform（不是路径猜的）
    isWindowsNode: nodePlatform.stdout === 'win32',
  };
}

/** Git Bash 调用（可注入替身；只此一处 spawn bash —— 与 hooks/gate 的 git 调用同样"单点"） */
export function defaultBashRun(bashPath = GIT_BASH_DEFAULT) {
  return (args) => {
    const r = spawnSync(bashPath, args, { encoding: 'utf8' });
    return {
      ok: r.status === 0,
      status: r.status,
      stdout: typeof r.stdout === 'string' ? r.stdout.trim() : '',
      stderr: typeof r.stderr === 'string' ? r.stderr.trim() : '',
      error: r.error ? String(r.error.message) : null,
    };
  };
}

/**
 * 门禁生成物的跨平台形态检查（LF-560 ①）：
 *   shebang 存在 / 纯 LF（无 CR）/ 无 BOM / Git Bash 语法 `bash -n` 通过 / 可执行位（索引 mode=100755 或 POSIX 权限位）
 * @param {{files: {relPath: string, absPath: string, role?: string}[], bashPath?: string, runBash?: Function, indexMode?: (rel: string) => string|null, platform?: string}} opts
 */
export function hookArtifactChecks({ files = [], bashPath = GIT_BASH_DEFAULT, runBash, indexMode, platform = process.platform } = {}) {
  const exec = runBash ?? defaultBashRun(bashPath);
  const cases = [];
  for (const f of files) {
    const label = f.relPath;
    if (!existsSync(f.absPath)) {
      cases.push({ name: `${label} 存在`, ok: false, detail: '文件不存在' });
      continue;
    }
    const bytes = readFileSync(f.absPath);
    const text = bytes.toString('utf8');
    const hasShebang = text.startsWith('#!');
    cases.push({ name: `${label} 有 shebang`, ok: hasShebang, detail: hasShebang ? text.split('\n')[0] : '(无)' });
    const hasCr = bytes.includes(0x0d);
    cases.push({ name: `${label} 纯 LF（无 CR）`, ok: !hasCr, detail: hasCr ? `含 CR：${bytes.filter((b) => b === 0x0d).length} 个` : 'no CR' });
    const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    cases.push({ name: `${label} 无 BOM`, ok: !hasBom, detail: hasBom ? '带 UTF-8 BOM' : 'no BOM' });
    // Git Bash 语法（POSIX shell 语义）：只对 sh 脚本做；.mjs 由 node --check 负责
    if (f.relPath.endsWith('.sh') || hasShebang && text.startsWith('#!/bin/sh')) {
      const r = exec(['-n', toPosix(f.absPath)]);
      cases.push({ name: `${label} bash -n 通过`, ok: r.ok, detail: r.ok ? 'syntax ok' : (r.stderr || r.error || `exit=${r.status}`) });
    }
    // 可执行位：索引 mode 优先（跨平台一致，见 LF-520）；未入索引时按平台如实记
    if (typeof indexMode === 'function') {
      const mode = indexMode(f.relPath);
      if (mode !== null && mode !== undefined) {
        cases.push({ name: `${label} 可执行位（索引 mode）`, ok: mode === '100755', detail: `index:${mode}` });
      } else if (platform === 'win32') {
        cases.push({ name: `${label} 可执行位（索引 mode）`, ok: true, detail: 'index:(未入索引；win32 无 exec 位 -> 不作违规，但已如实标注)' });
      } else {
        const modeBits = statSync(f.absPath).mode & 0o111;
        cases.push({ name: `${label} 可执行位（on-disk）`, ok: modeBits !== 0, detail: `mode&0111=${modeBits.toString(8)}` });
      }
    }
  }
  return { ok: cases.every((c) => c.ok), cases, bashPath };
}

/**
 * 防假绿（LF-560 红态）：断言"在别的平台验证过"而**没有**该平台载体 → 判红。
 * 与 LF-2D0 的 `fakePlatformGuard` 同源思路，但这里针对最常见的糊法：
 * **"Git Bash 里 node 能跑" ⇒ "Linux 验证通过"**（其 node 仍是 Windows node）。
 */
export function fakeLinuxClaimGuard({ claim, probe = null, carrierDone = LINUX_CARRIER_DONE } = {}) {
  if (claim === undefined || claim === null || claim === '') return { ok: true, finding: null };
  const normalized = String(claim).trim().toLowerCase();
  if (normalized !== 'linux' && normalized !== 'linux-node') return { ok: true, finding: null };
  if (carrierDone === true) return { ok: true, finding: null };
  const detail = probe === null || probe.available !== true
    ? '本机没有 Git Bash 探针结果，无法证明任何 Linux 语义'
    : `Git Bash 实测：uname=${probe.uname}、node=${probe.nodePath}、process.platform=${probe.nodePlatform}`;
  return {
    ok: false,
    finding: {
      code: 'CROSSPLAT_FAKE_LINUX_CLAIM',
      message: `声称"Linux 验证通过"，但没有 Linux node 载体（${detail}）-> 该宣称不成立；`
        + 'Git Bash 提供的是 **POSIX shell 语义**，不等于 Linux node 运行时',
    },
  };
}

/** 文件级清单（LF-560 ② 的本地侧）：`relPath  sha256` 逐行，供 tar 到 Linux 主机 后 `sha256sum` 对比 */
export function fileHashManifest(root, relPaths = []) {
  const rows = [];
  for (const rel of relPaths) {
    const abs = join(root, rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    rows.push({ relPath: toPosix(rel), sha256: createHash('sha256').update(readFileSync(abs)).digest('hex') });
  }
  rows.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return rows;
}

/** 比较本地清单与远端 `sha256sum` 输出：任一文件缺失/不一致即不通过（文件级，不做目录级哈希） */
export function compareFileHashes(localRows = [], remoteText = '', { remotePrefix = '' } = {}) {
  const remote = new Map();
  for (const line of String(remoteText).split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(trimmed);
    if (m === null) continue;
    let rel = m[2].trim();
    if (remotePrefix !== '' && rel.startsWith(remotePrefix)) rel = rel.slice(remotePrefix.length);
    rel = rel.replace(/^\.\//, '');
    remote.set(rel, m[1]);
  }
  const missing = [];
  const mismatched = [];
  for (const row of localRows) {
    const got = remote.get(row.relPath);
    if (got === undefined) missing.push(row.relPath);
    else if (got !== row.sha256) mismatched.push({ relPath: row.relPath, expected: row.sha256, actual: got });
  }
  const extra = [...remote.keys()].filter((k) => !localRows.some((r) => r.relPath === k));
  return {
    ok: missing.length === 0 && mismatched.length === 0 && extra.length === 0,
    localCount: localRows.length,
    remoteCount: remote.size,
    missing,
    mismatched,
    extra,
  };
}
