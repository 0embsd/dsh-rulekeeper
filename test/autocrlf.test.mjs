// dsh-rulekeeper · **G3：`core.autocrlf=true` 的跨形态比对口径**
//
// 事实链（源码取证 + 实测复现，2026-09-15）：
//   · 快照基线（`snap.mjs`）哈希的是**工作区字节**；
//   · pre-commit / post-commit / bypass 比的是**索引 / 提交里的 blob 字节**（`git show`）；
//   · `core.autocrlf=true` 时 git 在 `add` 时把 CRLF 归一为 LF 入库 ⇒ 两侧形态不同却互比
//     ⇒ **内容没改却报"未留证"**。实测原文（修复前）：
//       `FINDING GATE_POSTCOMMIT_UNRECORDED … committed=2751a3a2f303 baseline=4ad3ef64dfb8`
//
// 口径（开发部自决）：**内容真的变了必须判红；只有行尾形态不同不算改**。
// 本文件钉三件事：① 跨形态命中（绿）② 真改内容仍必红（负对照）③ 二进制不做归一。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runGate, runSnap } from '../src/cli.mjs';
import { blobMatchesBaseline, isBinaryBuffer, sha256LfOfBuffer } from '../src/lineend.mjs';
import { RC } from '../src/rc.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

function capture(fn) {
  let out = '';
  let err = '';
  const rc = fn({ out: (t) => { out += String(t); }, err: (t) => { err += String(t); } });
  return { rc, out, err };
}
const gate = (args) => capture((io) => runGate(args, io, {}));
const git = (root, ...args) => {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  return { status: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
};
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const findingCodes = (out) => out.split('\n').filter((l) => l.startsWith('FINDING ')).map((l) => l.split(' ')[1]);

/**
 * autocrlf=true 的仓 + 落点 + 受保护文本文件（工作区 CRLF，已提交）。
 * 提交里的 blob 是 **LF**，工作区是 **CRLF** —— 这正是 G3 的形态差来源。
 */
function scene(label) {
  const root = tempDir(label);
  const repo = join(root, 'repo');
  const landing = join(repo, '.dsh-ai', 'rulekeeper');
  mkdirSync(landing, { recursive: true });
  assert.equal(git(repo, 'init', '-q', '-b', 'main').status, 0, 'git 不可用则整个 G3 面无法取证');
  git(repo, 'config', 'core.autocrlf', 'true');
  git(repo, 'config', 'user.email', 'g3@example.test');
  git(repo, 'config', 'user.name', 'g3');
  writeFileSync(join(landing, 'config.json'), `${JSON.stringify({ schema: 1, mode: 'observe' }, null, 2)}\n`, 'utf8');
  writeFileSync(join(landing, 'rules.json'), `${JSON.stringify({ schema: 1, project: 'g3', protected_paths: ['target.txt'], gates: [], checks: [], inject: [] }, null, 2)}\n`, 'utf8');
  writeFileSync(join(repo, 'target.txt'), 'line1\r\nline2\r\n', 'utf8');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return { root, repo, landing, target: join(repo, 'target.txt') };
}
const snapTaken = (landing, repo, why) => capture((io) => runSnap(['take', '--landing', landing, '--project', repo, '--path', 'target.txt', '--why', why], io, {}));
const lastIndexRow = (landing) => {
  const lines = readFileSync(join(landing, 'snapshots', 'index.jsonl'), 'utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
};

test('单元：blobMatchesBaseline 的四种命中形态 + differ + no-baseline', () => {
  const rawCrlf = 'a\r\nb\r\n';
  const rawLf = 'a\nb\n';
  const record = { sha256_after: sha256(rawCrlf), sha256_lf: sha256(rawLf) };
  assert.equal(blobMatchesBaseline(record, Buffer.from(rawCrlf, 'utf8')).reason, 'raw==baseline');
  // G3 主场景：基线取自 CRLF 工作区，blob 是归一后的 LF
  assert.equal(blobMatchesBaseline(record, Buffer.from(rawLf, 'utf8')).reason, 'raw==baseline.lf');
  assert.equal(blobMatchesBaseline(record, Buffer.from(rawLf, 'utf8')).match, true);
  // 内容真变了：不得命中
  assert.equal(blobMatchesBaseline(record, Buffer.from('a\nb\nc\n', 'utf8')).match, false);
  assert.equal(blobMatchesBaseline(record, Buffer.from('a\nb\nc\n', 'utf8')).reason, 'differ');
  // 老记录（没有 sha256_lf）也要能单向跨形态命中（基线 CRLF，blob LF：算不出 base.lf，退回 lf(blob)==baseline）
  const legacy = { sha256_after: sha256(rawLf) };
  assert.equal(blobMatchesBaseline(legacy, Buffer.from(rawCrlf, 'utf8')).reason, 'lf(blob)==baseline');
  assert.equal(blobMatchesBaseline(legacy, Buffer.from(rawCrlf, 'utf8')).match, true);
  // 无基线 -> 不通过（fail-closed）
  assert.equal(blobMatchesBaseline(null, Buffer.from(rawLf, 'utf8')).match, false);
  assert.equal(blobMatchesBaseline({}, Buffer.from(rawLf, 'utf8')).reason, 'no-baseline');
});

test('单元：二进制不做行尾归一（sha256_lf = null）', () => {
  const bin = Buffer.from([0x41, 0x00, 0x0d, 0x0a, 0x42]);
  assert.equal(isBinaryBuffer(bin), true);
  assert.equal(sha256LfOfBuffer(bin), null, '含 NUL 的二进制不给归一形态');
  const text = Buffer.from('x\r\ny\r\n', 'utf8');
  assert.equal(isBinaryBuffer(text), false);
  assert.equal(sha256LfOfBuffer(text), sha256('x\ny\n'));
  // 二进制的"跨形态"不会因为归一而误判相等
  const rec = { sha256_after: createHash('sha256').update(bin).digest('hex'), sha256_lf: null };
  assert.equal(blobMatchesBaseline(rec, Buffer.from([0x41, 0x00, 0x0b, 0x0a, 0x42])).match, false);
});

test('绿：autocrlf=true 下"留证后内容不变、只差行尾形态"→ precommit / postcommit 都不得报未留证（G3 修复面）', () => {
  const { repo, landing, target } = scene('g3-green');
  // 改内容（工作区 CRLF）-> 留证：基线 = CRLF 形态
  writeFileSync(target, 'line1\r\nline2\r\nline3\r\n', 'utf8');
  const s = snapTaken(landing, repo, 'G3 用例');
  assert.equal(s.rc, RC.OK, s.err);
  const row = lastIndexRow(landing);
  assert.match(row.sha256_after, /^[0-9a-f]{64}$/);
  assert.match(row.sha256_lf, /^[0-9a-f]{64}$/, '快照必须记下行尾归一形态（G3 的载体）');
  assert.notEqual(row.sha256_lf, row.sha256_after, 'CRLF 文件的归一形态必须与原形态不同，否则本用例是空判');
  assert.equal(row.sha256_lf, sha256('line1\nline2\nline3\n'));

  // 真实动作：git add（autocrlf=true 会把 CRLF 归一为 LF 入库）
  git(repo, 'add', 'target.txt');
  const pre = gate(['precommit', '--repo', repo, '--landing', landing]);
  assert.equal(pre.rc, RC.OK, `precommit 不应假红:\n${pre.out}`);
  assert.match(pre.out, /^RK_GATE_PRECOMMIT_PROTECTED=1$/m, '本用例必须真的走到受保护路径上（空判护栏）');
  assert.match(pre.out, /^RK_GATE_PRECOMMIT_OK=1$/m);
  assert.deepEqual(findingCodes(pre.out), []);

  git(repo, 'commit', '-q', '-m', 'G3 内容变更（已留证）');
  const post = gate(['postcommit', '--repo', repo, '--landing', landing]);
  assert.equal(post.rc, RC.OK, `postcommit 不应假红:\n${post.out}`);
  assert.match(post.out, /^RK_GATE_POSTCOMMIT_PROTECTED=1$/m);
  assert.equal(/\bverdict=snapshotted\b/.test(post.out), true, `应判为已留证:\n${post.out}`);
  assert.deepEqual(findingCodes(post.out), []);
});

test('红（负对照）：留证之后内容又改了 → precommit / postcommit 都必须判红（放宽不得变成一律通过）', () => {
  const { repo, landing, target } = scene('g3-red');
  writeFileSync(target, 'line1\r\nline2\r\nline3\r\n', 'utf8');
  assert.equal(snapTaken(landing, repo, '先留证').rc, RC.OK);
  writeFileSync(target, 'line1\r\nline2\r\nline3CHANGED\r\n', 'utf8'); // 真改内容（仍 CRLF：形态没变，内容变了）
  git(repo, 'add', 'target.txt');
  const pre = gate(['precommit', '--repo', repo, '--landing', landing]);
  assert.equal(pre.rc, RC.FAIL, `内容真变了必须拒:\n${pre.out}`);
  assert.match(pre.out, /^RK_GATE_PRECOMMIT_UNRECORDED=1$/m);
  assert.ok(findingCodes(pre.out).includes('GATE_PRECOMMIT_UNRECORDED'));

  git(repo, 'commit', '-q', '-m', 'G3 未留证改动（负对照）');
  const post = gate(['postcommit', '--repo', repo, '--landing', landing]);
  assert.equal(post.rc, RC.FAIL, `内容真变了必须拒:\n${post.out}`);
  assert.ok(findingCodes(post.out).includes('GATE_POSTCOMMIT_UNRECORDED'));
});

test('红（负对照）：从未留证 → NO_SNAPSHOT 仍必红（跨形态比对没绕过"没有基线"这条）', () => {
  const { repo, landing, target } = scene('g3-nosnap');
  writeFileSync(target, 'line1\r\nline2\r\nline3\r\n', 'utf8');
  git(repo, 'add', 'target.txt');
  const pre = gate(['precommit', '--repo', repo, '--landing', landing]);
  assert.equal(pre.rc, RC.FAIL, pre.out);
  assert.ok(findingCodes(pre.out).includes('GATE_PRECOMMIT_NO_SNAPSHOT'));
});
