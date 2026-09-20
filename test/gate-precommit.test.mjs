// dsh-rulekeeper · LF-500 **pre-commit 真阻断**（暂存区视角：改受保护路径未 snap -> 拒）
//
// 判据（清单 §5 LF-500）：`pre-commit`：改受保护路径未 snap → **拒**；留证后提交通过。
//   红态：**不留证提交 → exit≠0**；**且拒绝时必须清空暂存区或记"未清空"台账**
//        （实测依据：被拒的改动留在暂存区，会被下一次 `git commit --no-verify` **夹带**带走）。
//
// 与 LF-530 的关系：**同一判据的两个视角**（暂存区 / 工作区），共用 `baselineOf()` + `effectiveConfig()` + `latestRecordFor()`；
// 本地用例刻意把两个视角的差别钉住：LF-530 看磁盘、LF-500 看 `git show :<path>`。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runGate, runRulekeeper } from '../src/cli.mjs';
import { gateLedgerPath, precommitGate, readGateLedger, stagedBlobSha, stagedPaths } from '../src/gate.mjs';
import { takeSnapshot } from '../src/snap.mjs';
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

/** 造"真 git 仓库 + 落点 + 保护面"，并做一次初始提交（`--clear-index` 需要 HEAD） */
function fixture(label, { protectedPaths = ['AGENTS.md'], rules = true } = {}) {
  const dir = tempDir(label);
  const repo = join(dir, 'repo');
  const landing = join(repo, '.dsh-ai', 'rulekeeper');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(landing, { recursive: true });
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', repo], { encoding: 'utf8' }).status, 0);
  writeFileSync(join(repo, 'AGENTS.md'), 'v1\n', 'utf8');
  writeFileSync(join(repo, 'src', 'a.txt'), 'a1\n', 'utf8');
  writeFileSync(join(landing, 'config.json'), `${JSON.stringify({ schema: 1, mode: 'observe' }, null, 2)}\n`, 'utf8');
  if (rules) {
    writeFileSync(join(landing, 'rules.json'), `${JSON.stringify({ schema: 1, project: 't', protected_paths: protectedPaths, gates: [], checks: [], inject: [] }, null, 2)}\n`, 'utf8');
  }
  git(repo, 'config', 'user.email', 't@example.test');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return { dir, repo, landing };
}

const snap = (f, file, why = 'LF-500 用例') => takeSnapshot({
  projectRoot: f.repo, landingDir: f.landing, file: join(f.repo, file), now: new Date('2026-09-14T00:00:00Z'), why,
});
const pre = (args) => gate(['precommit', ...args]);

// ── 公开面脱敏的提交时机械面（2026-09-19，同一形态第三次复发后补）──────────────────
// 复发史（实测，不是假想）：脚本探针注释 → src/landing.mjs 注释 → src/similarity.mjs 注释，
//   三次都是"新写文件的注释里带了内部项目名/本机路径"，而此前只有跑 selfcheck 才发现。
// 本条判据：**暂存**一份带内部标识的文件 ⇒ 提交当场被拒（且原因点名是脱敏，不是受保护路径）。
test('red: 暂存文件带内部标识 ⇒ 提交被拒（GATE_PRECOMMIT_INTERNAL_LEAK）', () => {
  const f = fixture('gate-leak-red', { protectedPaths: [] });   // 不设保护面 ⇒ 拒的唯一原因只能是脱敏
  const leaky = join(f.repo, 'src', 'note.md');
  writeFileSync(leaky, '参考：D:\\opt\\somewhere 的配置（本机路径）\n', 'utf8');
  assert.equal(git(f.repo, 'add', 'src/note.md').status, 0);

  const r = pre(['--repo', f.repo, '--landing', f.landing]);
  assert.equal(r.rc, RC.FAIL, `应当被拒；out=${r.out} err=${r.err}`);
  assert.match(r.out, /GATE_PRECOMMIT_INTERNAL_LEAK/, '拒的理由必须是脱敏，而不是别的');
  assert.match(r.out, /src\/note\.md/, '要点名是哪个文件');
  assert.match(r.out, /本机盘符路径/, '要点名是哪一类标识');
});

test('green（反事实）: 把标识改掉后同一门禁放行 —— 证明判据不是恒真的', () => {
  const f = fixture('gate-leak-green', { protectedPaths: [] });
  const clean = join(f.repo, 'src', 'note.md');
  writeFileSync(clean, '参考：项目根下的配置文件（不含任何本机路径）\n', 'utf8');
  assert.equal(git(f.repo, 'add', 'src/note.md').status, 0);

  const r = pre(['--repo', f.repo, '--landing', f.landing]);
  assert.equal(r.rc, RC.OK, `干净文件不得被拒；out=${r.out} err=${r.err}`);
  assert.ok(!/GATE_PRECOMMIT_INTERNAL_LEAK/.test(r.out), '干净文件不得出现脱敏 finding');
});

test('green: 留证（基线 == 暂存内容）后提交通过 -> exit=0，且不写台账', () => {
  const f = fixture('pc-green');
  writeFileSync(join(f.repo, 'AGENTS.md'), 'v2\n', 'utf8');
  assert.equal(snap(f, 'AGENTS.md', '改动后确认（新基线）').ok, true);
  git(f.repo, 'add', 'AGENTS.md');
  const r = precommitGate({ repoRoot: f.repo, now: new Date('2026-09-14T01:00:00Z') });
  assert.deepEqual(r.findings, []);
  assert.equal(r.ok, true);
  assert.equal(r.present, true);
  assert.deepEqual(r.staged, ['AGENTS.md']);
  assert.equal(r.protectedStaged.length, 1);
  assert.equal(r.protectedStaged[0].verdict, 'snapshotted');
  assert.equal(r.ledger, null, '通过时不写台账');
  const c = pre(['--repo', f.repo]);
  assert.equal(c.rc, RC.OK, c.out);
  assert.match(c.out, /^RK_GATE_PRECOMMIT_STAGED=1$/m);
  assert.match(c.out, /^RK_GATE_PRECOMMIT_PROTECTED=1$/m);
  assert.match(c.out, /^RK_GATE_PRECOMMIT_OK=1$/m);
  assert.match(c.out, /^RK_GATE_PRECOMMIT_UNRECORDED=0$/m);
  assert.match(c.out, /^RK_GATE_PRECOMMIT_RESULT=pass$/m);
  assert.equal(existsSync(gateLedgerPath(f.landing)), false);
});

test('red（清单原文）: 不留证提交 -> exit=1 + FINDING + 台账记"未清空"', () => {
  const f = fixture('pc-red');
  assert.equal(snap(f, 'AGENTS.md', '改前留证').ok, true);   // 基线 = v1
  writeFileSync(join(f.repo, 'AGENTS.md'), 'v2-未留证\n', 'utf8');
  git(f.repo, 'add', 'AGENTS.md');
  const stagedSha = stagedBlobSha(f.repo, 'AGENTS.md');
  assert.equal(stagedSha.ok, true);
  const r = precommitGate({ repoRoot: f.repo, now: new Date('2026-09-14T02:00:00Z') });
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].path, 'AGENTS.md');
  assert.equal(r.violations[0].verdict, 'unrecorded');
  assert.equal(r.violations[0].stagedSha256, stagedSha.sha256);
  assert.notEqual(r.violations[0].stagedSha256, r.violations[0].baseline, '暂存内容 != 基线（这就是"没留证"）');
  assert.ok(r.findings.some((x) => x.code === 'GATE_PRECOMMIT_UNRECORDED'));
  const c = pre(['--repo', f.repo, '--now', '2026-09-14T02:00:00Z']);
  assert.equal(c.rc, RC.FAIL, c.out);
  assert.match(c.out, /^RK_GATE_PRECOMMIT_UNRECORDED=1$/m);
  assert.match(c.out, /^RK_GATE_PRECOMMIT_INDEX_CLEARED=false$/m);
  assert.match(c.out, /^STAGED AGENTS\.md verdict=unrecorded staged=[0-9a-f]{12} baseline=[0-9a-f]{12} record_ts=2026-09-14T00:00:00\.000Z$/m);
  assert.match(c.out, /^FINDING GATE_PRECOMMIT_UNRECORDED /m);
  assert.match(c.out, /^RK_GATE_PRECOMMIT_RESULT=fail$/m);
  // 台账：这一条就是"被拒改动留在暂存区（会被下次 --no-verify 夹带）"的凭据
  // （本用例跑了两次拒绝 —— 纯函数一次 + CLI 一次 —— 台账是 append-only，故 2 行）
  const led = readGateLedger(f.landing);
  assert.equal(led.lines, 2);
  assert.equal(led.badLines, 0);
  for (const row of led.values) assert.equal(row.unrecordedStagedLeftBehind, true, '未清空 = 风险，必须显式记账');
  const row = led.values[0];
  assert.equal(row.schema, 1);
  assert.equal(row.gate, 'precommit');
  assert.equal(row.ts, '2026-09-14T02:00:00.000Z');
  assert.deepEqual(row.violations.map((v) => v.path), ['AGENTS.md']);
  assert.equal(row.violations[0].code, 'GATE_PRECOMMIT_UNRECORDED');
  assert.equal(row.indexCleared, false);
  assert.equal(row.bypass, 'git commit --no-verify');
  assert.equal(typeof row.repo, 'string');
  const bytes = readFileSync(gateLedgerPath(f.landing));
  assert.equal(bytes.includes(0x0d), false, '台账必须 LF');
  // 暂存区确实**没**被自动清掉（默认不搞破坏性动作）
  assert.deepEqual(stagedPaths(f.repo).paths, ['AGENTS.md']);
});

test('red: 受保护文件要提交但**从未留证** -> NOSNAPSHOT + exit=1', () => {
  const f = fixture('pc-nosnap', { protectedPaths: ['AGENTS.md', 'src/a.txt'] });
  writeFileSync(join(f.repo, 'src', 'a.txt'), 'a2\n', 'utf8');
  git(f.repo, 'add', 'src/a.txt');
  const r = precommitGate({ repoRoot: f.repo, now: new Date('2026-09-14T03:00:00Z') });
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].verdict, 'nosnapshot');
  assert.ok(r.findings.some((x) => x.code === 'GATE_PRECOMMIT_NO_SNAPSHOT'));
  const c = pre(['--repo', f.repo]);
  assert.equal(c.rc, RC.FAIL);
  assert.match(c.out, /^RK_GATE_PRECOMMIT_NOSNAPSHOT=1$/m);
  assert.match(c.out, /^FINDING GATE_PRECOMMIT_NO_SNAPSHOT /m);
});

test('--clear-index: 只有显式要求才清暂存区；清了也仍然拒（exit=1）且台账记"已清空"', () => {
  const f = fixture('pc-clear');
  assert.equal(snap(f, 'AGENTS.md', '改前留证').ok, true);
  writeFileSync(join(f.repo, 'AGENTS.md'), 'v2\n', 'utf8');
  git(f.repo, 'add', 'AGENTS.md');
  assert.deepEqual(stagedPaths(f.repo).paths, ['AGENTS.md']);
  const c = pre(['--repo', f.repo, '--clear-index', '--now', '2026-09-14T04:00:00Z']);
  assert.equal(c.rc, RC.FAIL, '清空暂存区不等于放行');
  assert.match(c.out, /^RK_GATE_PRECOMMIT_CLEAR_REQUESTED=true$/m);
  assert.match(c.out, /^RK_GATE_PRECOMMIT_INDEX_CLEARED=true$/m);
  assert.deepEqual(stagedPaths(f.repo).paths, [], '暂存区已被清空');
  const row = readGateLedger(f.landing).values[0];
  assert.equal(row.indexCleared, true);
  assert.deepEqual(row.clearedPaths, ['AGENTS.md']);
  assert.equal(row.unrecordedStagedLeftBehind, false);
  // 工作区文件**没被动**（我们只动索引，不碰用户内容）
  assert.equal(readFileSync(join(f.repo, 'AGENTS.md'), 'utf8'), 'v2\n');
});

test('green: 非保护文件在暂存区 -> 直接放行（PROTECTED=0 / 不写台账）', () => {
  const f = fixture('pc-unprotected');
  writeFileSync(join(f.repo, 'src', 'a.txt'), 'a2\n', 'utf8');
  git(f.repo, 'add', 'src/a.txt');
  const r = precommitGate({ repoRoot: f.repo });
  assert.equal(r.ok, true);
  assert.deepEqual(r.staged, ['src/a.txt']);
  assert.equal(r.protectedStaged.length, 0);
  assert.equal(r.ledger, null);
  assert.equal(pre(['--repo', f.repo]).rc, RC.OK);
});

test('green: 没有保护面 -> RULES_PRESENT=false + 放行（不冒充"已保护"）', () => {
  const f = fixture('pc-norules', { protectedPaths: [] });
  writeFileSync(join(f.repo, 'AGENTS.md'), 'v9\n', 'utf8');
  git(f.repo, 'add', 'AGENTS.md');
  const c = pre(['--repo', f.repo]);
  assert.equal(c.rc, RC.OK, c.out);
  assert.match(c.out, /^RK_GATE_PRECOMMIT_RULES_PRESENT=false$/m);
  assert.match(c.out, /^RK_GATE_PRECOMMIT_SOURCE=\(none\)$/m);
  assert.match(c.out, /^RK_GATE_PRECOMMIT_PROTECTED=0$/m);
});

test('判据: 删除类改动不进本门禁（D 被过滤）—— 删除属"消失"，由 LF-530 的 MISSING 面覆盖', () => {
  const f = fixture('pc-delete');
  assert.equal(snap(f, 'AGENTS.md', '删前留证').ok, true);
  git(f.repo, 'rm', '-q', 'AGENTS.md');
  const staged = stagedPaths(f.repo);
  assert.deepEqual(staged.paths, [], 'git diff --cached --diff-filter=ACMR 不该给出删除');
  const r = precommitGate({ repoRoot: f.repo });
  assert.equal(r.ok, true);
  assert.equal(r.protectedStaged.length, 0);
});

test('判据: 台账 append-only 且**门禁判断先于幂等**（同一条命令跑两次 = 2 条记录、两次都拒）', () => {
  const f = fixture('pc-twice');
  assert.equal(snap(f, 'AGENTS.md', '改前留证').ok, true);
  writeFileSync(join(f.repo, 'AGENTS.md'), 'v2\n', 'utf8');
  git(f.repo, 'add', 'AGENTS.md');
  assert.equal(pre(['--repo', f.repo, '--now', '2026-09-14T05:00:00Z']).rc, RC.FAIL);
  assert.equal(pre(['--repo', f.repo, '--now', '2026-09-14T05:00:01Z']).rc, RC.FAIL, '第二次仍必须拒（不许因"已记录过"而放行）');
  const led = readGateLedger(f.landing);
  assert.equal(led.lines, 2);
  assert.deepEqual(led.values.map((v) => v.ts), ['2026-09-14T05:00:00.000Z', '2026-09-14T05:00:01.000Z']);
});

test('判据: 两入口同源 —— `rk-gate precommit` 与 `dsh-rulekeeper gate precommit` 逐字相同', () => {
  const f = fixture('pc-entries');
  assert.equal(snap(f, 'AGENTS.md', '改前留证').ok, true);
  writeFileSync(join(f.repo, 'AGENTS.md'), 'v2\n', 'utf8');
  git(f.repo, 'add', 'AGENTS.md');
  const a = pre(['--repo', f.repo, '--now', '2026-09-14T06:00:00Z']);
  const b = capture((io) => runRulekeeper(['gate', 'precommit', '--repo', f.repo, '--now', '2026-09-14T06:00:00Z'], io, {}));
  assert.equal(a.out, b.out);
  assert.equal(a.rc, b.rc);
  assert.equal(a.rc, RC.FAIL);
});

test('--json: 计数与违规可机读，且判决类输出不含盘符绝对路径', () => {
  const f = fixture('pc-json');
  assert.equal(snap(f, 'AGENTS.md', '改前留证').ok, true);
  writeFileSync(join(f.repo, 'AGENTS.md'), 'v2\n', 'utf8');
  git(f.repo, 'add', 'AGENTS.md');
  const c = pre(['--repo', f.repo, '--json', '--now', '2026-09-14T07:00:00Z']);
  assert.equal(c.rc, RC.FAIL);
  const parsed = JSON.parse(c.out);
  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.staged, ['AGENTS.md']);
  assert.deepEqual(parsed.violations, ['AGENTS.md']);
  assert.equal(parsed.indexCleared, false);
  assert.equal(parsed.ledger.ok, true);
  assert.equal(/(^|[^A-Za-z])[A-Za-z]:[\\/]/.test(c.out), false, '判决类输出不得含盘符绝对路径（清单 ㉒）');
});

test('usage: --repo 不存在 / --now 非法 / 未知 flag -> rc=2；不是 git 仓库 -> rc=2 且有说明', () => {
  assert.equal(pre(['--repo', join(tempDir('pc-usage'), 'nope')]).rc, RC.USAGE);
  const f = fixture('pc-usage2');
  assert.equal(pre(['--repo', f.repo, '--now', '不是时间']).rc, RC.USAGE);
  assert.equal(pre(['--repo', f.repo, '--bogus']).rc, RC.USAGE);
  assert.equal(pre(['--help']).rc, RC.OK);
  const plain = tempDir('pc-notgit');
  const c = pre(['--repo', plain]);
  assert.equal(c.rc, RC.USAGE, c.err || c.out);
  assert.match(c.err, /读暂存区失败/);
});

test('green: --clear-index 但没有违规 -> 不动暂存区、exit=0', () => {
  const f = fixture('pc-clearnothing');
  writeFileSync(join(f.repo, 'src', 'a.txt'), 'a2\n', 'utf8');
  git(f.repo, 'add', 'src/a.txt');
  const c = pre(['--repo', f.repo, '--clear-index']);
  assert.equal(c.rc, RC.OK, c.out);
  assert.match(c.out, /^RK_GATE_PRECOMMIT_INDEX_CLEARED=false$/m);
  assert.deepEqual(stagedPaths(f.repo).paths, ['src/a.txt']);
  assert.equal(existsSync(gateLedgerPath(f.landing)), false);
});

test('判据: 台账写在落点 logs/ 下（工具自产物），且目录不存在时会被建出来', () => {
  const f = fixture('pc-ledgerdir');
  mkdirSync(join(f.landing, 'logs'), { recursive: true });   // 先建再删，验证"不存在时会建"
  assert.equal(statSync(join(f.landing, 'logs')).isDirectory(), true);
  assert.equal(snap(f, 'AGENTS.md', '改前留证').ok, true);
  writeFileSync(join(f.repo, 'AGENTS.md'), 'v2\n', 'utf8');
  git(f.repo, 'add', 'AGENTS.md');
  assert.equal(pre(['--repo', f.repo]).rc, RC.FAIL);
  assert.equal(gateLedgerPath(f.landing).endsWith(join('logs', 'gate.jsonl')), true);
  assert.equal(existsSync(gateLedgerPath(f.landing)), true);
  assert.equal(readGateLedger(f.landing).lines, 1);
});
