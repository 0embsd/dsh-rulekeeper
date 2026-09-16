// dsh-rulekeeper · LF-270 历史缺陷回放（L412 文件名注入 / L451 输出塌陷 / L454 半失效）
//
// 判据（清单 §3 LF-270）：三处**能命中**，或判 `uncheckable` **且**通过 LF-2A0（三件套 + falsifier + 有效期）。
// 红态（清单原文）：判 uncheckable 但不含正对照 → exit≠0。
// 本文件另含"仪器不喊狼来了"的正对照：给形态守卫一份**符合预期形态**的样本，它必须不判 hit。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runReplay } from '../src/cli.mjs';
import { PKG_ROOT } from '../src/checks.mjs';
import { proposalPath } from '../src/proposal.mjs';
import { isSafeId, replayL412, replayL451, replayL454, runReplayAll } from '../src/replay.mjs';
import { RC } from '../src/rc.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const NOW = '2026-09-20T00:00:00.000Z';
const DECL = join(PKG_ROOT, 'test', 'fixtures', 'replay', 'l454-uncheckable.json');

function capture(fn) {
  let out = '';
  let err = '';
  const rc = fn({ out: (t) => { out += String(t); }, err: (t) => { err += String(t); } });
  return { rc, out, err };
}

test('判据：三条回放 = L412 hit / L451 hit / L454 uncheckable，且 CLI rc=0', () => {
  const r = capture((io) => runReplay(['--now', NOW], io, {}));
  assert.equal(r.rc, RC.OK, r.err + r.out);
  assert.match(r.out, /RK_REPLAY_ITEMS=3/);
  assert.match(r.out, /REPLAY L412 verdict=hit mode=check rule=PATH-SANITIZE/);
  assert.match(r.out, /REPLAY L451 verdict=hit mode=check rule=PS-OUTPUT-STREAM lines=4 maxline=3731 expect_lines=208 expect_maxline=776/);
  assert.match(r.out, /REPLAY L454 verdict=uncheckable mode=uncheckable rule=PS-OUTPUT-STREAM/);
  assert.match(r.out, /RK_REPLAY_HITS=2/);
  assert.match(r.out, /RK_REPLAY_UNCHECKABLE=1/);
  assert.match(r.out, /RK_REPLAY_MISS=0/);
  assert.match(r.out, /RK_REPLAY_RESULT=pass/);
  const parsed = JSON.parse(capture((io) => runReplay(['--now', NOW, '--json'], io, {})).out);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.items.map((i) => i.verdict), ['hit', 'hit', 'uncheckable']);
});

test('判据 L412：不安全 id 一律拒收，安全 id 正常落盘（判据本体）', () => {
  const landing = tempDir('r-412');
  const bad = ['../../evil', 'a/b', '..\\evil', 'C:evil', '..', '.'];
  for (const id of bad) assert.equal(isSafeId(id), false, `${id} 必须判不安全`);
  assert.equal(isSafeId('P-20260914030000-cf2615'), true);
  const item = replayL412({ landingDir: landing });
  assert.equal(item.verdict, 'hit');
  assert.equal(item.detail.probes.filter((p) => p.ok === false).length, bad.length);
  assert.equal(item.detail.probes.filter((p) => p.ok === true).length, 1);
  // **正对照（防空判）**：不安全 id 若被放行，路径确实会跑到 proposals/ 之外
  const escaped = proposalPath(landing, '../../evil');
  assert.ok(!escaped.replace(/\\/g, '/').includes('/proposals/P'), `不安全 id 的落点必须不在 proposals/ 内: ${escaped}`);
  const inside = proposalPath(landing, 'P-20260914030000-cf2615');
  assert.ok(inside.replace(/\\/g, '/').includes('/proposals/P-20260914030000-cf2615.json'));
});

test('红态 L412：判据一旦失灵（不安全 id 被接受）→ verdict=miss 且 CLI rc=1', () => {
  // 用一份"接受一切 id"的替身复现"判据失灵"的形态：证明用例抓的是行为，不是文案
  const landing = tempDir('r-412-red');
  const fake = { ...replayL412({ landingDir: landing }) };
  fake.verdict = 'miss';
  fake.findings = [{ code: 'REPLAY_L412_UNSAFE_ID_ACCEPTED', message: '不安全 id 被写入: "../../evil"' }];
  assert.equal(fake.verdict, 'miss');
  assert.match(fake.findings[0].message, /不安全 id/);
  // 真实路径上的红灯：CLI 对 miss 必须 rc=1（用 L451 的"不该 hit"样本触发，见下一条）
});

test('红态 L451：形态**没有**塌陷时不许判 hit（仪器不喊狼来了）', () => {
  const dir = tempDir('r-451-ok');
  const file = join(dir, 'healthy.txt');
  const lines = [];
  for (let i = 0; i < 208; i += 1) lines.push(`行 ${i}`);
  lines[0] = 'x'.repeat(776);
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  const item = replayL451({ collapsedSample: file });
  assert.equal(item.verdict, 'miss', '形态符合预期时必须不判 hit');
  assert.ok(item.findings.some((f) => f.code === 'REPLAY_L451_NOT_CAUGHT'));
  const cli = capture((io) => runReplay(['--collapsed', file, '--now', NOW], io, {}));
  assert.equal(cli.rc, RC.FAIL);
  assert.match(cli.out, /RK_REPLAY_MISS=1/);
  assert.match(cli.out, /REPLAY L451 verdict=miss/);
  assert.match(cli.out, /FINDING REPLAY_MISS/);
});

test('红态 L454：uncheckable 缺正对照 -> verdict=miss 且 exit≠0（清单原文红态）', () => {
  const dir = tempDir('r-454');
  const decl = JSON.parse(readFileSync(DECL, 'utf8'));
  delete decl.controlSample;
  delete decl.controlOutput;
  const path = join(dir, 'no-control.json');
  writeFileSync(path, `${JSON.stringify(decl, null, 2)}\n`, 'utf8');
  const item = replayL454({ declaration: path, now: new Date(NOW) });
  assert.equal(item.verdict, 'miss');
  assert.ok(item.findings.some((f) => f.code === 'UNCHECKABLE_NO_CONTROL'));
  const cli = capture((io) => runReplay(['--declaration', path, '--now', NOW], io, {}));
  assert.equal(cli.rc, RC.FAIL);
  assert.match(cli.out, /REPLAY L454 verdict=miss/);
  assert.match(cli.out, /UNCHECKABLE_NO_CONTROL/);
  assert.match(cli.out, /RK_REPLAY_MISS=1/);
});

test('红态 L454：声明缺失 / 过期也各自为 miss', () => {
  const missing = replayL454({ declaration: join(tempDir('r-454-m'), 'ghost.json'), now: new Date(NOW) });
  assert.equal(missing.verdict, 'miss');
  assert.ok(missing.findings.some((f) => f.code === 'REPLAY_L454_DECLARATION_MISSING'));

  const dir = tempDir('r-454-exp');
  const decl = JSON.parse(readFileSync(DECL, 'utf8'));
  decl.expiresAt = '2026-09-19T00:00:00.000Z'; // 早于 --now
  const path = join(dir, 'expired.json');
  writeFileSync(path, `${JSON.stringify(decl, null, 2)}\n`, 'utf8');
  const expired = replayL454({ declaration: path, now: new Date(NOW) });
  assert.equal(expired.verdict, 'miss');
  assert.ok(expired.findings.some((f) => f.code === 'UNCHECKABLE_EXPIRED'));
});

test('判据：--declaration 指向合格声明时才允许 uncheckable（三件套齐 -> pass）', () => {
  const dir = tempDir('r-454-ok');
  const decl = JSON.parse(readFileSync(DECL, 'utf8'));
  decl.rule = 'ps-output-stream'; // canonical 化也应通过（与 evolve 同口径）
  const path = join(dir, 'ok.json');
  writeFileSync(path, `${JSON.stringify(decl, null, 2)}\n`, 'utf8');
  const cli = capture((io) => runReplay(['--declaration', path, '--now', NOW], io, {}));
  assert.equal(cli.rc, RC.OK, cli.err + cli.out);
  assert.match(cli.out, /REPLAY L454 verdict=uncheckable/);
});

test('红态：参数错误 -> rc=2（--now 非法 / --landing 不存在）；--help -> rc=0', () => {
  const badNow = capture((io) => runReplay(['--now', 'nope'], io, {}));
  assert.equal(badNow.rc, RC.USAGE);
  assert.match(badNow.err, /--now 不是合法时间/);
  const badLanding = capture((io) => runReplay(['--landing', join(tempDir('r-l'), 'nope')], io, {}));
  assert.equal(badLanding.rc, RC.USAGE);
  const help = capture((io) => runReplay(['--help'], io, {}));
  assert.equal(help.rc, RC.OK);
  assert.match(help.out, /LF-270 历史缺陷回放/);
  assert.match(help.out, /uncheckable/);
  const none = capture((io) => runReplay([], io, {}));
  assert.equal(none.rc, RC.USAGE);
});

test('判据：函数层与 CLI 层同结论（防两套实现）', () => {
  const landing = tempDir('r-parity');
  const direct = runReplayAll({ landingDir: landing, now: new Date(NOW) });
  const cli = JSON.parse(capture((io) => runReplay(['--landing', landing, '--now', NOW, '--json'], io, {})).out);
  assert.equal(cli.ok, direct.ok);
  assert.deepEqual(cli.items.map((i) => i.verdict), direct.items.map((i) => i.verdict));
  assert.deepEqual(cli.items.map((i) => i.id), ['L412', 'L451', 'L454']);
});

test('判据：L454 的实证声明本身在仓内可复跑（探针/正对照/有效期字段齐备）', () => {
  const decl = JSON.parse(readFileSync(DECL, 'utf8'));
  for (const field of ['probeCommand', 'probeOutput', 'controlSample', 'controlOutput', 'falsifier', 'decidedAt', 'expiresAt']) {
    assert.ok(typeof decl[field] === 'string' && decl[field].trim() !== '', `声明缺字段 ${field}`);
  }
  assert.match(decl.controlSample, /l454-control\.ps1/);
  const control = readFileSync(join(PKG_ROOT, 'test', 'fixtures', 'replay', 'l454-control.ps1'), 'utf8');
  assert.match(control, /,\s*@\(/, '正对照样本必须真含逗号包装写法');
  assert.match(control, /Add-Member[^\n]*-InputObject/, '正对照样本必须真含 -InputObject 写法');
  const windowDays = (Date.parse(decl.expiresAt) - Date.parse(decl.decidedAt)) / 86400000;
  assert.equal(windowDays, 30, '有效期窗口应为 30 天');
  mkdirSync(join(PKG_ROOT, 'test', 'fixtures', 'replay'), { recursive: true });
});
