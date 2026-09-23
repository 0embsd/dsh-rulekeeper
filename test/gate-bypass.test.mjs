// dsh-rulekeeper · LF-510 **绕过对账**（`--no-verify` / hook 未装 的检出）
//
// 判据（清单 §5 LF-510）：`post-commit`（`--no-verify` **不跳过它**）+ `git log` 与账本**差集** + 远端防线。
//   红态：构造 `--no-verify` 提交 → 对账 **exit≠0 且列出该 sha**。
//
// 本文件把关键前提**实测钉住**（不是引用别人的结论）：
//   ① `git commit` 正常时 pre-commit + post-commit **都会跑**；
//   ② `git commit --no-verify` 时 **pre-commit 不跑、post-commit 照跑** ⇒ post-commit 是"被绕过"的取证位置；
//   ③ 对账的判定依据是**差集**：动过受保护路径的提交 ∖ 台账里有 post-commit 记录的 sha。
//
// fixture 的关键设计（第一版实测踩到的坑）：**初始提交里不能有"未留证的受保护文件"** ——
//   否则装了 hook 之后，连无关提交都会被 `write`（LF-530）拦下（受保护文件从未留证 = 违规）。
//   所以：初始提交只含非保护文件；受保护文件由各用例自己"先建 + 先留证"。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runGate, runRulekeeper } from '../src/cli.mjs';
import { bypassRecon, gateLedgerPath, listCommits, postCommitRecon, readGateLedger } from '../src/gate.mjs';
import { installHooks } from '../src/hooks.mjs';
import { takeSnapshot } from '../src/snap.mjs';
import { RC } from '../src/rc.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const PKG = join(import.meta.dirname, '..');
const GATE_BIN = join(PKG, 'bin', 'rk-gate.mjs');
// P14（2026-09-23）：生成的 `hook.mjs` **不再写死本机路径**，改为运行时解析 rk-gate 入口
//   （解析链：`RK_GATE_BIN` → 项目 `node_modules/dsh-rulekeeper` → 落点 `config.json.gateBin`）。
// 本文件的临时仓里这三路都不天然成立 ⇒ 显式把入口指到本包，让"钩子真的跑起来"这件事照旧可测。
// 用**环境变量**而不是把本机路径写进生成物：生成物必须跨机同 sha（P14 验收判据①）。
process.env.RK_GATE_BIN = GATE_BIN;

function capture(fn) {
  let out = '';
  let err = '';
  const rc = fn({ out: (t) => { out += String(t); }, err: (t) => { err += String(t); } });
  return { rc, out, err };
}
const gate = (args) => capture((io) => runGate(args, io, {}));
const git = (root, ...args) => {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  return { status: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim(), all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

/** 真 git 仓库 + 落点 + 保护面；初始提交**只含非保护文件**（见文件头"fixture 关键设计"） */
function fixture(label, { protectedPaths = ['AGENTS.md'], withHooks = false } = {}) {
  const dir = tempDir(label);
  const repo = join(dir, 'repo');
  const landing = join(repo, '.dsh-ai', 'rulekeeper');
  mkdirSync(repo, { recursive: true });
  mkdirSync(landing, { recursive: true });
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', repo], { encoding: 'utf8' }).status, 0);
  writeFileSync(join(repo, 'src-a.txt'), 'a1\n', 'utf8');
  writeFileSync(join(landing, 'config.json'), `${JSON.stringify({ schema: 1, mode: 'observe' }, null, 2)}\n`, 'utf8');
  writeFileSync(join(landing, 'rules.json'), `${JSON.stringify({ schema: 1, project: 't', protected_paths: protectedPaths, gates: [], checks: [], inject: [] }, null, 2)}\n`, 'utf8');
  git(repo, 'config', 'user.email', 't@example.test');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'add', '-A');
  assert.equal(git(repo, 'commit', '-q', '-m', 'init').status, 0);
  if (withHooks) {
    const ins = installHooks({ repoRoot: repo, gateBin: GATE_BIN });
    assert.equal(ins.ok, true, JSON.stringify(ins.reasons));
  }
  return { dir, repo, landing };
}
/** 受保护文件"先建 + 先留证"（基线 = 传入内容） */
function protect(f, content = 'v1\n') {
  writeFileSync(join(f.repo, 'AGENTS.md'), content, 'utf8');
  const r = takeSnapshot({ projectRoot: f.repo, landingDir: f.landing, file: join(f.repo, 'AGENTS.md'), now: new Date('2026-09-14T00:00:00Z'), why: 'LF-510 用例' });
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  return r;
}
const snap = (f, now = new Date('2026-09-14T01:00:00Z')) => takeSnapshot({
  projectRoot: f.repo, landingDir: f.landing, file: join(f.repo, 'AGENTS.md'), now, why: 'LF-510 用例（改动后确认）',
});
const bypass = (args) => gate(['bypass', ...args]);
const head = (repo) => git(repo, 'rev-parse', 'HEAD').out;

test('前提实测：正常提交两个 hook 都跑；`--no-verify` 只跳过 pre-commit、post-commit 照跑', () => {
  const f = fixture('bp-premise', { withHooks: true });
  // 非保护文件：pre-commit（暂存区+工作区两道门）都该过
  writeFileSync(join(f.repo, 'src-a.txt'), 'a2\n', 'utf8');
  git(f.repo, 'add', 'src-a.txt');
  const normal = git(f.repo, 'commit', '-m', 'normal');
  assert.equal(normal.status, 0, normal.all);
  assert.match(normal.all, /RK_GATE_PRECOMMIT_RESULT=pass/, '正常提交时 pre-commit 应当跑');
  assert.match(normal.all, /RK_GATE_POSTCOMMIT_RESULT=pass/, '正常提交时 post-commit 应当跑');
  // --no-verify 提交
  writeFileSync(join(f.repo, 'src-a.txt'), 'a3\n', 'utf8');
  git(f.repo, 'add', 'src-a.txt');
  const noVerify = git(f.repo, 'commit', '--no-verify', '-m', 'bypass');
  assert.equal(noVerify.status, 0, noVerify.all);
  assert.equal(/RK_GATE_PRECOMMIT_RESULT/.test(noVerify.all), false, '--no-verify 必须跳过 pre-commit');
  assert.match(noVerify.all, /RK_GATE_POSTCOMMIT_RESULT=pass/, '--no-verify **不跳过** post-commit（这是本条的取证位置）');
});

test('green: 正常提交（含 hook 留痕）-> 对账 exit=0（GATED=1 / BYPASSED=0）', () => {
  const f = fixture('bp-green', { withHooks: true });
  protect(f, 'v1\n');                                  // 先建 + 先留证
  writeFileSync(join(f.repo, 'AGENTS.md'), 'v2\n', 'utf8');
  assert.equal(snap(f).ok, true);                      // 改动后确认（基线 = v2）
  git(f.repo, 'add', 'AGENTS.md');
  const c = git(f.repo, 'commit', '-m', 'legit');
  assert.equal(c.status, 0, c.all);
  assert.match(c.all, /RK_GATE_PRECOMMIT_RESULT=pass/);
  assert.match(c.all, /RK_GATE_POSTCOMMIT_RESULT=pass/);
  const r = bypassRecon({ repoRoot: f.repo });
  assert.deepEqual(r.findings, []);
  assert.equal(r.ok, true);
  assert.equal(r.bypassed.length, 0);
  assert.equal(r.gated.length, 1, '那一次动过受保护路径的提交有 post-commit 取证');
  assert.equal(r.gated[0].sha, head(f.repo));
  const cli = bypass(['--repo', f.repo]);
  assert.equal(cli.rc, RC.OK, cli.out);
  assert.match(cli.out, /^RK_GATE_BYPASS_GATED=1$/m);
  assert.match(cli.out, /^RK_GATE_BYPASS_BYPASSED=0$/m);
  assert.match(cli.out, /^RK_GATE_BYPASS_RESULT=pass$/m);
});

test('red（清单原文）: 构造 `--no-verify` 提交 -> 对账 exit≠0 **且列出该 sha**', () => {
  const f = fixture('bp-red', { withHooks: true });
  protect(f, 'v1\n');
  writeFileSync(join(f.repo, 'AGENTS.md'), 'v2-被绕过的改动\n', 'utf8');
  git(f.repo, 'add', 'AGENTS.md');
  const c = git(f.repo, 'commit', '--no-verify', '-m', 'bypass me');
  assert.equal(c.status, 0, c.all);
  assert.equal(/RK_GATE_PRECOMMIT_RESULT/.test(c.all), false, 'pre-commit 被 --no-verify 跳过（否则这个红态构造不成立）');
  const sha = head(f.repo);
  const rows = readGateLedger(f.landing).values.filter((x) => x.gate === 'post-commit' && x.sha === sha);
  assert.equal(rows.length, 1, 'post-commit 必须为这次提交留下记录');
  assert.equal(rows[0].verdict, 'unrecorded');
  assert.equal(rows[0].bypassSuspected, true);
  assert.deepEqual(rows[0].violations, ['AGENTS.md']);
  const cli = bypass(['--repo', f.repo]);
  assert.equal(cli.rc, RC.FAIL, cli.out);
  assert.match(cli.out, /^RK_GATE_BYPASS_BYPASSED=1$/m);
  assert.match(cli.out, new RegExp(`^BYPASSED ${sha} state=gated-with-violation paths=AGENTS\\.md$`, 'm'));
  assert.match(cli.out, /^FINDING GATE_BYPASS_UNRECORDED /m);
  assert.match(cli.out, /^RK_GATE_BYPASS_RESULT=fail$/m);
});

test('red: 仓库**根本没装 hook**（hooksPath 未设）-> 动过受保护路径的提交 = 无取证 -> 列出该 sha', () => {
  const f = fixture('bp-nohook', { withHooks: false });
  protect(f, 'v1\n');
  writeFileSync(join(f.repo, 'AGENTS.md'), 'v2\n', 'utf8');
  git(f.repo, 'add', 'AGENTS.md');
  assert.equal(git(f.repo, 'commit', '-q', '-m', 'no hooks here').status, 0);
  const sha = head(f.repo);
  const r = bypassRecon({ repoRoot: f.repo, limit: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.bypassed.length, 1);
  assert.equal(r.bypassed[0].sha, sha);
  assert.equal(r.bypassed[0].state, 'no-evidence');
  assert.ok(r.findings.some((x) => x.code === 'GATE_BYPASS_NO_EVIDENCE'));
  const cli = bypass(['--repo', f.repo, '--limit', '1']);
  assert.equal(cli.rc, RC.FAIL);
  assert.match(cli.out, new RegExp(`^BYPASSED ${sha} state=no-evidence paths=AGENTS\\.md$`, 'm'));
  assert.match(cli.out, /^FINDING GATE_BYPASS_NO_EVIDENCE /m);
});

test('postcommit（取证端）：手动对某次提交取证 -> 台账 +1；违规/通过两种结论都可读到', () => {
  const f = fixture('bp-postcommit', { withHooks: false });
  protect(f, 'v1\n');
  writeFileSync(join(f.repo, 'AGENTS.md'), 'v2\n', 'utf8');
  git(f.repo, 'add', 'AGENTS.md');
  git(f.repo, 'commit', '-q', '-m', 'direct');
  const sha = head(f.repo);
  const before = readGateLedger(f.landing).lines;
  const r = postCommitRecon({ repoRoot: f.repo, now: new Date('2026-09-14T03:00:00Z') });
  assert.equal(r.sha, sha);
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 1);
  const rows = readGateLedger(f.landing).values;
  assert.equal(rows.length, before + 1);
  const row = rows[rows.length - 1];
  assert.equal(row.gate, 'post-commit');
  assert.equal(row.sha, sha);
  assert.equal(row.verdict, 'unrecorded');
  assert.deepEqual(row.protectedPaths.map((p) => p.path), ['AGENTS.md']);
  const cli = gate(['postcommit', '--repo', f.repo, '--sha', sha, '--now', '2026-09-14T04:00:00Z']);
  assert.equal(cli.rc, RC.FAIL, cli.out);
  assert.match(cli.out, /^RK_GATE_POSTCOMMIT_VIOLATIONS=1$/m);
  assert.match(cli.out, /^COMMIT AGENTS\.md verdict=unrecorded committed=[0-9a-f]{12} baseline=[0-9a-f]{12} /m);
  assert.match(cli.out, /^FINDING GATE_POSTCOMMIT_UNRECORDED /m);
  // 补证（基线推进到 v2 = 提交内容）后再取证一次 -> 转绿
  assert.equal(snap(f).ok, true);
  const r2 = postCommitRecon({ repoRoot: f.repo, sha, now: new Date('2026-09-14T05:00:00Z') });
  assert.equal(r2.ok, true, JSON.stringify(r2.findings));
  const r3 = bypassRecon({ repoRoot: f.repo, limit: 1 });
  assert.equal(r3.ok, true, JSON.stringify(r3.findings));
  assert.equal(r3.gated.length, 1);
});

test('green: 没有保护面 -> postcommit 不写台账、对账无可判项（不冒充"已保护"）', () => {
  const f = fixture('bp-norules', { protectedPaths: [] });
  assert.equal(git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'empty').status, 0);
  const before = readGateLedger(f.landing).lines;
  const r = postCommitRecon({ repoRoot: f.repo });
  assert.equal(r.ok, true);
  assert.equal(r.ledger, null, '没有保护面就不该写台账');
  assert.equal(readGateLedger(f.landing).lines, before);
  const cli = bypass(['--repo', f.repo]);
  assert.equal(cli.rc, RC.OK, cli.out);
  assert.match(cli.out, /^RK_GATE_BYPASS_RULES_PRESENT=false$/m);
  assert.match(cli.out, /^RK_GATE_BYPASS_RELEVANT=0$/m);
});

test('判据: 对账只算"动过受保护路径"的提交（非保护路径的提交不进分母）', () => {
  const f = fixture('bp-scope', { withHooks: false });
  writeFileSync(join(f.repo, 'src-a.txt'), 'a2\n', 'utf8');
  git(f.repo, 'add', 'src-a.txt');
  assert.equal(git(f.repo, 'commit', '-q', '-m', 'unprotected').status, 0);
  const r = bypassRecon({ repoRoot: f.repo });
  assert.equal(r.checked >= 1, true);
  assert.equal(r.relevantCommits, 0, 'AGENTS.md 没被动过 -> 不进分母');
  assert.equal(r.ok, true);
});

test('判据: --limit / --all 决定扫多少提交；读取幂等（两次同结论）', () => {
  const f = fixture('bp-limit', { withHooks: false });
  protect(f, 'v1\n');
  for (const v of ['v2', 'v3']) {
    writeFileSync(join(f.repo, 'AGENTS.md'), `${v}\n`, 'utf8');
    git(f.repo, 'add', 'AGENTS.md');
    git(f.repo, 'commit', '-q', '-m', `to ${v}`);
  }
  const all = bypassRecon({ repoRoot: f.repo, all: true });
  assert.equal(all.scope, 'all');
  assert.equal(all.relevantCommits, 2);
  assert.equal(all.bypassed.length, 2);
  const one = bypassRecon({ repoRoot: f.repo, limit: 1 });
  assert.equal(one.scope, 'last 1');
  assert.equal(one.relevantCommits, 1);
  assert.equal(one.ok, false, '--limit 缩小范围不改变"该拒就拒"');
  const c1 = gate(['bypass', '--repo', f.repo, '--limit', '1']);
  const c2 = gate(['bypass', '--repo', f.repo, '--limit', '1']);
  assert.equal(c1.rc, RC.FAIL);
  assert.equal(c1.out, c2.out, '同一条件下两次对账逐字相同');
  const cliAll = gate(['bypass', '--repo', f.repo, '--all']);
  assert.match(cliAll.out, /^RK_GATE_BYPASS_SCOPE=all$/m);
  assert.match(cliAll.out, /^RK_GATE_BYPASS_BYPASSED=2$/m);
});

test('判据: 台账坏行不让对账"静默通过"（读不出来就不算有取证）', () => {
  const f = fixture('bp-badledger', { withHooks: false });
  protect(f, 'v1\n');
  writeFileSync(join(f.repo, 'AGENTS.md'), 'v2\n', 'utf8');
  git(f.repo, 'add', 'AGENTS.md');
  git(f.repo, 'commit', '-q', '-m', 'x');
  mkdirSync(join(f.landing, 'logs'), { recursive: true });
  writeFileSync(gateLedgerPath(f.landing), '{坏行\n', 'utf8');
  const led = readGateLedger(f.landing);
  assert.equal(led.badLines, 1);
  const r = bypassRecon({ repoRoot: f.repo, limit: 1 });
  assert.equal(r.ok, false, '坏行 = 没有可用取证 -> 必须判红');
  assert.equal(r.bypassed.length, 1);
});

test('listCommits: 解析 `--name-only` 输出（每个提交一次、路径归位）', () => {
  const f = fixture('bp-list', { withHooks: false });
  writeFileSync(join(f.repo, 'AGENTS.md'), 'v2\n', 'utf8');
  writeFileSync(join(f.repo, 'src-a.txt'), 'a2\n', 'utf8');
  git(f.repo, 'add', '-A');
  git(f.repo, 'commit', '-q', '-m', 'two files');
  const listed = listCommits(f.repo, { limit: 1 });
  assert.equal(listed.ok, true);
  assert.equal(listed.commits.length, 1);
  assert.equal(listed.commits[0].sha, head(f.repo));
  assert.deepEqual(listed.commits[0].paths.slice().sort(), ['AGENTS.md', 'src-a.txt']);
});

test('判据: 两入口同源（bypass ∥ dsh-rulekeeper gate bypass）逐字相同', () => {
  const f = fixture('bp-entries', { withHooks: false });
  const a = bypass(['--repo', f.repo]);
  const b = capture((io) => runRulekeeper(['gate', 'bypass', '--repo', f.repo], io, {}));
  assert.equal(a.out, b.out);
  assert.equal(a.rc, b.rc);
  assert.equal(a.rc, RC.OK);
});

test('--json: 可机读，且判决类输出不含盘符绝对路径', () => {
  const f = fixture('bp-json', { withHooks: false });
  protect(f, 'v1\n');
  writeFileSync(join(f.repo, 'AGENTS.md'), 'v2\n', 'utf8');
  git(f.repo, 'add', 'AGENTS.md');
  git(f.repo, 'commit', '-q', '-m', 'x');
  const c = bypass(['--repo', f.repo, '--limit', '1', '--json']);
  assert.equal(c.rc, RC.FAIL);
  const parsed = JSON.parse(c.out);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.bypassed.length, 1);
  assert.equal(parsed.bypassed[0].state, 'no-evidence');
  assert.equal(/(^|[^A-Za-z])[A-Za-z]:[\\/]/.test(c.out), false, '判决类输出不得含盘符绝对路径（清单 ㉒）');
  const pc = gate(['postcommit', '--repo', f.repo, '--json']);
  assert.equal(pc.rc, RC.FAIL);
  const pcParsed = JSON.parse(pc.out);
  assert.equal(pcParsed.violations.length, 1);
  assert.equal(/(^|[^A-Za-z])[A-Za-z]:[\\/]/.test(pc.out), false);
});

test('usage: --limit 非正整数 / --repo 不存在 / 不是 git 仓库 / 未知 sha -> rc=2', () => {
  const f = fixture('bp-usage', { withHooks: false });
  assert.equal(bypass(['--repo', f.repo, '--limit', 'abc']).rc, RC.USAGE);
  assert.equal(bypass(['--repo', f.repo, '--limit', '0']).rc, RC.USAGE);
  assert.equal(bypass(['--repo', join(tempDir('bp-u'), 'nope')]).rc, RC.USAGE);
  assert.equal(bypass(['--repo', f.repo, '--bogus']).rc, RC.USAGE);
  assert.equal(bypass(['--help']).rc, RC.OK);
  assert.equal(gate(['postcommit', '--help']).rc, RC.OK);
  const plain = tempDir('bp-notgit');
  const c = bypass(['--repo', plain]);
  assert.equal(c.rc, RC.USAGE, c.err || c.out);
  assert.match(c.err, /读 git log 失败/);
  const bad = gate(['postcommit', '--repo', f.repo, '--sha', 'deadbeef']);
  assert.equal(bad.rc, RC.USAGE);
  assert.match(bad.err, /读提交内容失败|不是 git 仓库/);
});

test('判据: 对账看"当时记账"，不看现在的基线（历史提交不因后续改动而改判）', () => {
  const f = fixture('bp-history', { withHooks: true });
  protect(f, 'v1\n');
  writeFileSync(join(f.repo, 'AGENTS.md'), 'v2\n', 'utf8');
  assert.equal(snap(f).ok, true);
  git(f.repo, 'add', 'AGENTS.md');
  const c = git(f.repo, 'commit', '-m', 'gated ok');
  assert.equal(c.status, 0, c.all);
  // 之后再改一次、再留证（基线推进到 v3）—— 历史那次提交仍应算"有取证"
  writeFileSync(join(f.repo, 'AGENTS.md'), 'v3\n', 'utf8');
  assert.equal(snap(f).ok, true, JSON.stringify(snap(f)));
  git(f.repo, 'add', 'AGENTS.md');
  const c2 = git(f.repo, 'commit', '-m', 'second');
  assert.equal(c2.status, 0, c2.all);
  const r = bypassRecon({ repoRoot: f.repo });
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  assert.equal(r.gated.length, 2);
  assert.equal(r.bypassed.length, 0);
  const raw = readFileSync(gateLedgerPath(f.landing), 'utf8');
  assert.equal(raw.includes('\r'), false, '台账必须 LF');
});
