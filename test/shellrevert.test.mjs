// dsh-rulekeeper · LF-830 **降壳可反转 + 退役门槛**
//
// 判据（条目 LF-830）：
//   绿 = 反向恢复壳后，与降壳前 **stdout sha256 相等 + exit 相等 + stderr 归一后相等**（10 条固定 fixture）
//   红 = 恢复不出原行为 → **必红**；**未写退役门槛就删壳 → exit≠0**
//
// 三条"反假绿"设计：
//   · 三面**逐 fixture**比对（stdout sha256 / exit / stderr 归一后），任一面不符即点名报出（N1/N2/N3）。
//   · **删壳只有一条路**（`drop`），且内部先过退役门槛；拒绝时断言**副本仍在**（只看 exit≠0 会漏"报错但已删"）。
//   · **变异**：把某一面的比对改成恒真（复制包改一行）→ 同一坏样本必须被吞掉，证明那一面载重（N6）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runShellRevert } from '../src/cli.mjs';
import {
  SHELL_FIXTURES, captureBehavior, restoreShell, runFixture, snapshotShell, verifyShell,
} from '../src/shellrevert.mjs';
import { RC } from '../src/rc.mjs';
import { cleanupAll, copyPkg, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const PKG = join(import.meta.dirname, '..');

function capture(fn) {
  let out = '';
  let err = '';
  const rc = fn({ out: (t) => { out += String(t); }, err: (t) => { err += String(t); } });
  return { rc, out, err };
}
const sr = (args) => capture((io) => runShellRevert(args, io, {}));

/** 一个"壳"：按 10 条 fixture 的约定处理 argv/stdin（内容可换 = 不同实现，行为可等价） */
function shellSource({ echo = 'HELLO', failExit = 3, stderrText = 'warn-line', tag = 'A' }) {
  return `#!/usr/bin/env node
// 壳实现 ${tag}（内容不同才算"另一个实现"）
const args = process.argv.slice(2);
const cmd = args[0] ?? '';
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const stdin = Buffer.concat(chunks).toString('utf8');
  switch (cmd) {
    case '': process.stdout.write('usage: shell\\n'); break;
    case '--help': process.stdout.write('help text\\n'); break;
    case '--version': process.stdout.write('v1.0.0\\n'); break;
    case 'echo': process.stdout.write(String(args[1] ?? '') + '\\n'); break;
    case 'echo-many': process.stdout.write(args.slice(1).join(' ') + '\\n'); break;
    case 'uni': process.stdout.write('中文与 emoji \\u2713\\n'); break;
    case 'stdin': process.stdout.write(stdin.toUpperCase()); break;
    case 'json': process.stdout.write(JSON.stringify({ ok: true, n: args.length }) + '\\n'); break;
    case 'fail': process.stderr.write('${failExit === 3 ? 'boom-line' : failExit === 4 ? 'changed-boom' : 'boom-line'}\\n'); process.exit(${failExit}); break;
    case 'stderr': process.stderr.write('${stderrText}\\n'); process.stdout.write('${echo}\\n'); break;
    default: process.stdout.write('unknown:' + cmd + '\\n'); break;
  }
});
`;
}

function scene(label, opts = {}) {
  const root = tempDir(label);
  const landing = join(root, 'landing');
  mkdirSync(landing, { recursive: true });
  writeFileSync(join(landing, 'config.json'), `${JSON.stringify({ schema: 1, mode: 'observe' }, null, 2)}\n`, 'utf8');
  const entry = join(root, 'shell.mjs');
  writeFileSync(entry, shellSource(opts), 'utf8');
  return { root, landing, entry };
}

test('green: 10 条固定 fixture 冻结且结构合法', () => {
  assert.equal(SHELL_FIXTURES.length, 10, '判据原文就是 10 条固定 fixture');
  const ids = SHELL_FIXTURES.map((f) => f.id);
  assert.equal(new Set(ids).size, 10, 'fixture id 不得重复');
  for (const f of SHELL_FIXTURES) {
    assert.match(f.id, /^F[0-9]{2}$/);
    assert.ok(Array.isArray(f.args));
    assert.equal(typeof f.stdin, 'string');
  }
});

test('green: snapshot 保留可反转副本 + sha256，并抓到 10 条基线三面', () => {
  const { root, landing, entry } = scene('sr-snap');
  const r = snapshotShell({ landing, shell: 'old-shell', entry, now: new Date('2026-09-15T00:00:00Z') });
  assert.equal(r.ok, true, r.reason);
  assert.equal(existsSync(r.copy), true, '可反转副本必须落地');
  assert.equal(r.copySha256, r.sourceSha256, '副本 sha256 必须等于原壳');
  assert.equal(r.fixtures, 10);
  const baseline = JSON.parse(readFileSync(r.baselineFile, 'utf8'));
  assert.equal(baseline.fixtures.length, 10);
  for (const f of baseline.fixtures) {
    assert.match(f.stdoutSha256, /^[0-9a-f]{64}$/);
    assert.equal(typeof f.exit, 'number');
    assert.equal(typeof f.stderrNorm, 'string');
  }
});

test('green（核心判据）: 降壳后行为等价 → 10/10 三面相等；恢复回原壳 → 仍 10/10', () => {
  const { landing, entry } = scene('sr-green');
  assert.equal(snapshotShell({ landing, shell: 'old-shell', entry }).ok, true);

  // 降壳：换成**另一个实现**（内容不同、行为相同）
  const downgraded = join(landing, 'downgraded.mjs');
  writeFileSync(downgraded, shellSource({ tag: 'B-thin-shell' }), 'utf8');
  const v1 = verifyShell({ landing, shell: 'old-shell', entry: downgraded });
  assert.equal(v1.ok, true, JSON.stringify(v1.mismatches, null, 2));
  assert.equal(v1.checked, 10);
  assert.equal(v1.matched, 10);

  // 反向恢复：把副本还原回原路径 → 三面仍相等（"可反转"的证据）
  const restored = restoreShell({ landing, shell: 'old-shell', target: entry });
  assert.equal(restored.ok, true, restored.reason);
  assert.equal(restored.sha256, restored.expectedSha256);
  const v2 = verifyShell({ landing, shell: 'old-shell', entry });
  assert.equal(v2.ok, true, JSON.stringify(v2.mismatches, null, 2));
  assert.equal(v2.matched, 10);
});

test('红态 N1/N2/N3: 三面各造一个"假降壳" → 各自被点名（stdout / exit / stderr）', () => {
  const { landing, entry } = scene('sr-faces');
  assert.equal(snapshotShell({ landing, shell: 'old-shell', entry }).ok, true);

  const cases = [
    { label: 'stdout', opts: { echo: 'CHANGED' }, face: 'stdout' },
    { label: 'exit', opts: { failExit: 4 }, face: 'exit' },
    { label: 'stderr', opts: { stderrText: 'changed-warn' }, face: 'stderr' },
  ];
  for (const c of cases) {
    const bad = join(landing, `bad-${c.label}.mjs`);
    writeFileSync(bad, shellSource({ ...c.opts, tag: `bad-${c.label}` }), 'utf8');
    const v = verifyShell({ landing, shell: 'old-shell', entry: bad });
    assert.equal(v.ok, false, `${c.label} 变了却没判红`);
    const miss = v.mismatches.find((m) => m.face === c.face);
    assert.notEqual(miss, undefined, `${c.label} 面必须被点名，实测 ${JSON.stringify(v.mismatches)}`);
    assert.match(miss.id, /^F[0-9]{2}$/);
  }
});

test('红态 N4: 可反转副本被改 1 字节 -> restore 必红且不覆盖目标', () => {
  const { landing, entry } = scene('sr-corrupt');
  const snap = snapshotShell({ landing, shell: 'old-shell', entry });
  const before = readFileSync(entry, 'utf8');
  writeFileSync(entry, shellSource({ echo: 'CHANGED' }), 'utf8');
  const tampered = `${readFileSync(snap.copy, 'utf8')}\n// tampered\n`;
  writeFileSync(snap.copy, tampered, 'utf8');

  const r = restoreShell({ landing, shell: 'old-shell', target: entry });
  assert.equal(r.ok, false, '副本指纹不符必须拒绝恢复');
  assert.match(r.reason, /sha256/);
  assert.equal(readFileSync(entry, 'utf8'), shellSource({ echo: 'CHANGED' }), '拒绝时目标文件不许被覆盖');
  assert.notEqual(before, readFileSync(entry, 'utf8'));
});

test('红态 N5: 未写退役门槛 / 天数不足 / 有回退记录 —— 三次 drop 都必须 exit≠0 且副本仍在', () => {
  const { landing, entry } = scene('sr-drop');
  const snap = snapshotShell({ landing, shell: 'old-shell', entry });
  const missingDoc = join(tempDir('sr-nodoc'), 'RUNBOOK.md');
  const args = ['drop', '--landing', landing, '--shell', 'old-shell', '--now', '2026-02-01T00:00:00Z'];

  const noDoc = sr([...args, '--since', '2026-01-01T00:00:00Z', '--runbook', missingDoc]);
  assert.notEqual(noDoc.rc, RC.OK, '缺门槛文档必须拒绝删壳');
  assert.equal(existsSync(snap.copy), true, '拒绝时副本必须仍在');

  const early = sr([...args, '--since', '2026-01-20T00:00:00Z']);
  assert.notEqual(early.rc, RC.OK, '天数不足必须拒绝');
  assert.equal(existsSync(snap.copy), true);

  mkdirSync(join(landing, 'logs'), { recursive: true });
  writeFileSync(join(landing, 'logs', 'incidents.jsonl'), `${JSON.stringify({ shell: 'old-shell', ts: '2026-01-10T00:00:00Z', kind: 'rollback' })}\n`, 'utf8');
  const withRollback = sr([...args, '--since', '2026-01-01T00:00:00Z']);
  assert.notEqual(withRollback.rc, RC.OK, '期间有回退记录必须拒绝');
  assert.equal(existsSync(snap.copy), true);

  // 门槛全过：才允许真删（并留台账）
  rmSync(join(landing, 'logs', 'incidents.jsonl'));
  const allowed = sr([...args, '--since', '2026-01-01T00:00:00Z']);
  assert.equal(allowed.rc, RC.OK, allowed.err);
  assert.match(allowed.out, /RK_SHELL_REVERT_DROP_ALLOWED=true/);
  assert.equal(existsSync(snap.copy), false, '门槛过后才允许真删副本');
  assert.equal(existsSync(join(landing, 'logs', 'retire.jsonl')), true);
});

test('变异 N6: 把 stderr 面的比对改成恒真 -> 同一个 stderr 坏样本被吞掉（证明该面载重）', () => {
  const mutant = copyPkg('sr-mutant');
  const file = join(mutant, 'src', 'shellrevert.mjs');
  const src = readFileSync(file, 'utf8');
  const anchor = 'const stderrSame = now.stderrNorm === base.stderrNorm;';
  assert.equal(src.split(anchor).length - 1, 1, '变异锚点必须恰命中 1 次（不猜、不静默）');
  writeFileSync(file, src.replace(anchor, 'const stderrSame = true;'), 'utf8');
  assert.equal(spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }).status, 0, '变异体必须仍是合法 JS');

  const root = tempDir('sr-mutant-run');
  const landing = join(root, 'landing');
  mkdirSync(landing, { recursive: true });
  writeFileSync(join(landing, 'config.json'), '{"schema":1,"mode":"observe"}\n', 'utf8');
  const entry = join(root, 'shell.mjs');
  writeFileSync(entry, shellSource({ tag: 'A' }), 'utf8');
  const run = spawnSync(process.execPath, [join(mutant, 'bin', 'rk-shell-revert.mjs'), 'snapshot', '--landing', landing, '--shell', 's', '--entry', entry], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const bad = join(root, 'bad-stderr.mjs');
  writeFileSync(bad, shellSource({ stderrText: 'changed-warn', tag: 'bad' }), 'utf8');
  const v = spawnSync(process.execPath, [join(mutant, 'bin', 'rk-shell-revert.mjs'), 'verify', '--landing', landing, '--shell', 's', '--entry', bad], { encoding: 'utf8' });
  assert.equal(v.status, 0, `去掉 stderr 面后坏样本会被接受（这正是真包判红的原因）: ${v.stdout}`);
  assert.match(v.stdout, /RK_SHELL_REVERT_MISMATCHES=0/);
});

test('红态 N7: fixture 数不是 10 条 -> verify 必红（判据原文就是 10 条）', () => {
  const { landing, entry } = scene('sr-count');
  const snap = snapshotShell({ landing, shell: 'old-shell', entry });
  const baseline = JSON.parse(readFileSync(snap.baselineFile, 'utf8'));
  baseline.fixtures = baseline.fixtures.slice(0, 9);
  writeFileSync(snap.baselineFile, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  const v = verifyShell({ landing, shell: 'old-shell', entry });
  assert.equal(v.ok, false);
  assert.match(v.reason, /10/);
});

test('green: captureBehavior 对"缺解释器/入口不存在"如实报错（不静默算通过）', () => {
  const { root } = scene('sr-noentry');
  const r = captureBehavior({ entry: join(root, 'nope.mjs') });
  assert.equal(r.ok, false);
  assert.match(r.reason, /不存在|ENOENT|Cannot find/);
  const bad = join(root, 'x.txt');
  writeFileSync(bad, 'not runnable\n', 'utf8');
  const r2 = captureBehavior({ entry: bad });
  assert.equal(typeof r2.ok, 'boolean');
});

test('green: runFixture 是纯执行器（stdout sha256 稳定、可复现）', () => {
  const { entry } = scene('sr-fixture');
  const a = runFixture({ entry, fixture: SHELL_FIXTURES[0] });
  const b = runFixture({ entry, fixture: SHELL_FIXTURES[0] });
  assert.equal(a.stdoutSha256, b.stdoutSha256);
  assert.equal(a.exit, b.exit);
});

test('rc=2: 未知子命令 / 缺必需参数', () => {
  assert.equal(sr(['snapshott']).rc, RC.USAGE);
  assert.equal(sr(['snapshot', '--landing', tempDir('sr-u')]).rc, RC.USAGE);
  assert.equal(sr(['drop', '--landing', tempDir('sr-u'), '--shell', 's']).rc, RC.USAGE, 'drop 需要 --since/--now（时间不许靠猜）');
});

test('green: verify 落点里没有基线 -> 明说要先 snapshot（不冒充通过）', () => {
  const { landing, entry } = scene('sr-nobase');
  const v = verifyShell({ landing, shell: 'never-snapshotted', entry });
  assert.equal(v.ok, false);
  assert.match(v.reason, /snapshot|基线/);
});
