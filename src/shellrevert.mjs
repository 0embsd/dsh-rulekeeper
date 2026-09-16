// dsh-rulekeeper · LF-830 **降壳可反转 + 退役门槛**
//
// 判据（条目 LF-830）：
//   绿 = 反向恢复壳后，与降壳前 **stdout sha256 相等 + exit 相等 + stderr 归一后相等**（10 条固定 fixture）
//   红 = 恢复不出原行为 → **必红**；**未写退役门槛就删壳 → exit≠0**
//
// 术语：**壳** = 保留下来转调本体的旧包装脚本（本项目里是 pwsh 壳）。**降壳** = 把壳的功能交给本体；
// **删壳** = 退役那个脚本。本模块管"删前留可反转副本 + 删前必须过门槛"。
//
// 三条纪律（理由见设计单）：
//   ① 基线 = 10 条**冻结** fixture 的三面快照；fixture 可被外部替换 = 自证（D2）
//   ② 三面**逐 fixture**比对，任一面不符点名报出（N1/N2/N3）
//   ③ **删壳只有一条路**（`drop`），内部先过退役门槛；拒绝时**副本原封不动**（D3/D4）
//
// 归属：core 模块。零依赖：只用 node:*。

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, extname, join } from 'node:path';

import { STOP_LOSS_LIMITS, retireGate, runbookPathOf } from './stoploss.mjs';

export const SHELL_DIR = 'shells';
export const SHELL_BASELINE = 'baseline.json';
export const SHELL_MANIFEST = 'manifest.jsonl';

/** 10 条**冻结** fixture（判据原文就是 10 条；改这张表 = 改判据，必须同时改凭证口径） */
export const SHELL_FIXTURES = Object.freeze([
  { id: 'F01', args: [], stdin: '', what: '无参调用（用法输出）' },
  { id: 'F02', args: ['--help'], stdin: '', what: '帮助' },
  { id: 'F03', args: ['--version'], stdin: '', what: '版本' },
  { id: 'F04', args: ['echo', 'HELLO'], stdin: '', what: '普通输出' },
  { id: 'F05', args: ['echo-many', 'a', 'b', 'c'], stdin: '', what: '多参拼接' },
  { id: 'F06', args: ['uni'], stdin: '', what: '非 ASCII 输出' },
  { id: 'F07', args: ['stdin'], stdin: 'line1\nline2\n', what: 'stdin 透传' },
  { id: 'F08', args: ['fail'], stdin: '', what: '**非 0 退出码**（exit 面）' },
  { id: 'F09', args: ['stderr'], stdin: '', what: '**stderr 输出**（stderr 面）' },
  { id: 'F10', args: ['json'], stdin: '', what: '结构化输出' },
]);

export function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}
export function sha256File(file) {
  return sha256Buffer(readFileSync(file));
}

/**
 * 解释器按**扩展名**选（D1）。缺解释器 / 入口不存在 → 如实报错，**不静默算通过**。
 * @returns {{ok: boolean, argv: string[]|null, reason: string|null}}
 */
export function interpreterFor(entry, { nodePath = process.execPath, pwsh = 'pwsh', sh = 'sh' } = {}) {
  if (typeof entry !== 'string' || entry === '' || existsSync(entry) !== true) {
    return { ok: false, argv: null, reason: `入口不存在: ${String(entry)}` };
  }
  const ext = extname(entry).toLowerCase();
  if (ext === '.mjs' || ext === '.js') return { ok: true, argv: [nodePath, entry], reason: null };
  if (ext === '.ps1') return { ok: true, argv: [pwsh, '-NoProfile', '-File', entry], reason: null };
  if (ext === '.sh') return { ok: true, argv: [sh, entry], reason: null };
  return { ok: true, argv: [entry], reason: null };
}

/**
 * stderr 归一（D5，四项且仅四项）：去 CR、逐行去尾空白、去首尾空行、把 entry 绝对路径替换成 `<entry>`。
 * 归一太多会掩盖真差异（假绿）；太少会被行尾/路径污染（假红）。
 */
export function normalizeStderr(text, entry) {
  let s = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  s = s.split('\n').map((line) => line.replace(/[ \t]+$/, '')).join('\n');
  s = s.replace(/^\n+/, '').replace(/\n+$/, '');
  if (typeof entry === 'string' && entry !== '') s = s.split(entry).join('<entry>');
  return s;
}

/** 跑一条 fixture（纯执行器：同输入两次必须同结果） */
export function runFixture({ entry, fixture, timeoutMs = 20000, interpreter = interpreterFor }) {
  const interp = interpreter(entry);
  if (interp.ok !== true) return { id: fixture.id, ok: false, reason: interp.reason, stdoutSha256: null, exit: null, stderrNorm: null };
  const r = spawnSync(interp.argv[0], interp.argv.slice(1).concat(fixture.args), {
    // `encoding: null` = 拿**原始 Buffer**（stderr/stdout 都要逐字节比对；`'buffer'` 不是合法 encoding 值）
    input: Buffer.from(fixture.stdin, 'utf8'), encoding: null, timeout: timeoutMs,
  });
  const stdout = Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.alloc(0);
  const stderr = Buffer.isBuffer(r.stderr) ? r.stderr : Buffer.alloc(0);
  return {
    id: fixture.id,
    ok: true,
    reason: null,
    stdoutSha256: sha256Buffer(stdout),
    stdoutBytes: stdout.length,
    exit: typeof r.status === 'number' ? r.status : (r.error === undefined ? 1 : 1),
    stderrNorm: normalizeStderr(stderr.toString('utf8'), entry),
  };
}

/** 抓整批 fixture 的行为快照（基线用） */
export function captureBehavior({ entry, fixtures = SHELL_FIXTURES, interpreter } = {}) {
  const rows = [];
  for (const f of fixtures) {
    const r = runFixture(interpreter === undefined ? { entry, fixture: f } : { entry, fixture: f, interpreter });
    if (r.ok !== true) return { ok: false, reason: `${f.id}: ${r.reason}`, fixtures: rows };
    rows.push({ id: r.id, stdoutSha256: r.stdoutSha256, stdoutBytes: r.stdoutBytes, exit: r.exit, stderrNorm: r.stderrNorm });
  }
  return { ok: true, reason: null, fixtures: rows };
}

export function shellDirOf(landingDir, shell) {
  return join(String(landingDir), SHELL_DIR, String(shell));
}
export function baselinePathOf(landingDir, shell) {
  return join(shellDirOf(landingDir, shell), SHELL_BASELINE);
}
export function manifestPathOfShell(landingDir, shell) {
  return join(shellDirOf(landingDir, shell), SHELL_MANIFEST);
}

/** 副本文件名：`<原文件名>.<stamp>.bak`（同一次 snapshot 可重复跑：同名副本按内容覆盖，sha 一致即幂等） */
export function copyNameOf(entry, now) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, 'Z');
  return `${basename(entry)}.${stamp}.bak`;
}

/**
 * **降壳前**：保留可反转副本（回读校验 sha256）+ 抓 10 条基线三面。
 * @returns {{ok: boolean, reason: string|null, copy: string|null, copySha256: string|null, sourceSha256: string|null, fixtures: number, baselineFile: string, manifestFile: string}}
 */
export function snapshotShell({ landing, shell, entry, now = new Date() } = {}) {
  const dir = shellDirOf(landing, shell);
  const baselineFile = baselinePathOf(landing, shell);
  const manifestFile = manifestPathOfShell(landing, shell);
  mkdirSync(dir, { recursive: true });
  const base = { copy: null, copySha256: null, sourceSha256: null, fixtures: 0, baselineFile, manifestFile };
  if (existsSync(entry) !== true) return { ok: false, reason: `入口不存在: ${String(entry)}`, ...base };

  const behavior = captureBehavior({ entry });
  if (behavior.ok !== true) return { ok: false, reason: `抓基线失败 —— ${behavior.reason}`, ...base };

  const sourceSha256 = sha256File(entry);
  const copy = join(dir, copyNameOf(entry, now));
  copyFileSync(entry, copy);
  const copySha256 = sha256File(copy);
  if (copySha256 !== sourceSha256) return { ok: false, reason: `副本回读 sha256 与源不一致（${copySha256} != ${sourceSha256}）`, ...base };

  const baseline = {
    schema: 1,
    shell: String(shell),
    entry: String(entry),
    capturedAt: now.toISOString(),
    copySha256,
    fixtures: behavior.fixtures,
  };
  writeFileSync(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  const back = JSON.parse(readFileSync(baselineFile, 'utf8'));
  if (back.fixtures.length !== behavior.fixtures.length) return { ok: false, reason: '基线回读条数不符', ...base };
  const row = {
    schema: 1, ts: now.toISOString(), shell: String(shell), entry: String(entry),
    copy: basename(copy), copySha256, sourceSha256, fixtures: behavior.fixtures.length, bytes: statSync(copy).size,
  };
  writeFileSync(manifestFile, `${JSON.stringify(row)}\n`, 'utf8');

  return { ok: true, reason: null, copy, copySha256, sourceSha256, fixtures: behavior.fixtures.length, baselineFile, manifestFile };
}

/** 取最近一次 snapshot 的记录 + 基线 */
export function readShellState(landing, shell) {
  const baselineFile = baselinePathOf(landing, shell);
  const manifestFile = manifestPathOfShell(landing, shell);
  if (existsSync(baselineFile) !== true || existsSync(manifestFile) !== true) {
    return { ok: false, reason: `没有 ${String(shell)} 的基线（先跑 rk-shell-revert snapshot）`, baseline: null, row: null, copy: null };
  }
  const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
  const lines = readFileSync(manifestFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const row = JSON.parse(lines[lines.length - 1]);
  const copy = join(shellDirOf(landing, shell), String(row.copy));
  return { ok: true, reason: null, baseline, row, copy };
}

/**
 * **降壳后**（或恢复后）验行为等价：三面逐 fixture 比对。
 * @returns {{ok: boolean, reason: string|null, checked: number, matched: number, mismatches: object[], rows: object[]}}
 */
export function verifyShell({ landing, shell, entry } = {}) {
  const state = readShellState(landing, shell);
  if (state.ok !== true) return { ok: false, reason: state.reason, checked: 0, matched: 0, mismatches: [], rows: [] };
  const expected = state.baseline.fixtures ?? [];
  if (expected.length !== SHELL_FIXTURES.length) {
    return { ok: false, reason: `基线 fixture 数 ${expected.length} != 判据要求的 ${SHELL_FIXTURES.length} 条（判据原文就是 10 条）`, checked: expected.length, matched: 0, mismatches: [], rows: [] };
  }
  const actual = captureBehavior({ entry });
  if (actual.ok !== true) return { ok: false, reason: actual.reason, checked: 0, matched: 0, mismatches: [], rows: [] };

  const mismatches = [];
  const rows = [];
  for (let i = 0; i < expected.length; i += 1) {
    const base = expected[i];
    const now = actual.fixtures[i];
    const stdoutSame = now.stdoutSha256 === base.stdoutSha256;
    const exitSame = now.exit === base.exit;
    const stderrSame = now.stderrNorm === base.stderrNorm;
    rows.push({ id: base.id, stdoutSame, exitSame, stderrSame });
    if (stdoutSame !== true) mismatches.push({ id: base.id, face: 'stdout', expected: base.stdoutSha256, actual: now.stdoutSha256 });
    if (exitSame !== true) mismatches.push({ id: base.id, face: 'exit', expected: base.exit, actual: now.exit });
    if (stderrSame !== true) mismatches.push({ id: base.id, face: 'stderr', expected: base.stderrNorm, actual: now.stderrNorm });
  }
  return { ok: mismatches.length === 0, reason: null, checked: expected.length, matched: expected.length - new Set(mismatches.map((m) => m.id)).size, mismatches, rows };
}

/** 反向恢复：把可反转副本还原到 `target`（**先校验副本指纹**，不符一律拒绝，且不覆盖目标） */
export function restoreShell({ landing, shell, target } = {}) {
  const state = readShellState(landing, shell);
  if (state.ok !== true) return { ok: false, reason: state.reason, sha256: null, expectedSha256: null };
  if (existsSync(state.copy) !== true) return { ok: false, reason: `可反转副本不存在: ${state.copy}`, sha256: null, expectedSha256: state.row.copySha256 };
  const actual = sha256File(state.copy);
  if (actual !== state.row.copySha256) {
    return { ok: false, reason: `可反转副本 sha256 不符（副本被动过）：期望 ${state.row.copySha256} 实际 ${actual}`, sha256: actual, expectedSha256: state.row.copySha256 };
  }
  copyFileSync(state.copy, target);
  const after = sha256File(target);
  if (after !== state.row.copySha256) {
    return { ok: false, reason: `恢复后回读 sha256 与副本不符：${after} != ${state.row.copySha256}`, sha256: after, expectedSha256: state.row.copySha256 };
  }
  return { ok: true, reason: null, sha256: after, expectedSha256: state.row.copySha256, restored: String(target) };
}

/** 退役门槛：连续 N 天零回退/零事故（门槛文本与记录口径复用 LF-820 的 retireGate） */
export function shellRetireGate({ landing, shell, since, now, minDays = STOP_LOSS_LIMITS.retireMinDays, runbookFile = runbookPathOf() } = {}) {
  return retireGate({ landing, shell, since, now, minDays, runbookFile });
}

/**
 * **删壳（唯一的一条路）**：先过退役门槛；不过 → 拒绝且**副本原封不动**。
 * @returns {{ok: boolean, code: string|null, reasons: string[], removed: boolean, copy: string|null}}
 */
export function dropShell({ landing, shell, since, now, minDays, runbookFile } = {}) {
  const state = readShellState(landing, shell);
  const gate = shellRetireGate({ landing, shell, since, now, ...(minDays === undefined ? {} : { minDays }), ...(runbookFile === undefined ? {} : { runbookFile }) });
  if (gate.ok !== true) {
    return { ok: false, code: 'RETIRE_REFUSED', reasons: gate.reasons, removed: false, copy: state.ok ? state.copy : null };
  }
  let removed = false;
  if (state.ok === true && existsSync(state.copy) === true) {
    rmSync(state.copy);
    removed = true;
  }
  // 删壳后基线/清单一并清掉（它们是这个壳的安装态；删了壳还留着基线会让人以为壳还在）
  for (const f of [baselinePathOf(landing, shell), manifestPathOfShell(landing, shell)]) {
    if (existsSync(f)) rmSync(f);
  }
  const dir = shellDirOf(landing, shell);
  if (existsSync(dir) && readdirSync(dir).length > 0) mkdirSync(dir, { recursive: true });
  if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
  return { ok: true, code: null, reasons: [], removed, copy: state.ok ? state.copy : null, days: gate.days, rollbacks: gate.rollbacks };
}
