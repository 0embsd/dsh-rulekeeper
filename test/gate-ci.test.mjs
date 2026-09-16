// dsh-rulekeeper · LF-540 **远端防线**（服务端 CI / 受保护分支；**新 clone 没有 hook** 时的兜底）
//
// 判据（清单 §3 LF-540）：**删掉本机 hook 之后 CI 仍拦得住** → 通过；**CI 也放行** → 必红。
//
// 本文件把"服务端门不依赖本机 hook"这件事**实测钉住**（不是引用别人的结论）：
//   ① `git clone` **不复制 hook** —— 在 clone 里 `assert` 到 hook 文件不存在（这是本条的立足点）；
//   ② 同一份"动过受保护路径但台账无取证"的提交，在**没有 hook 的 clone** 里照样被 `rk-gate ci` 判红；
//   ③ 空保护面 → **空转闸**判红（"装了 CI" ≠ "CI 能拦"）；
//   ④ 自曝边界：`CI_CARRIER_DONE=false`，`--claim-remote` 判红（本机模拟不冒充远端已执行）。
//
// fixture 沿用 gate-bypass.test.mjs 的纪律：**初始提交里不能有"未留证的受保护文件"**
//   （否则装了 hook 之后连无关提交都会被 `write` 拦下）；受保护文件由用例自己"先建 + 先留证"。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runGate, runRulekeeper } from '../src/cli.mjs';
import { CI_WORKFLOW_REL, ciWorkflowYaml, listCommits, sha256OfFile, verifyCiWorkflow, writeCiWorkflow } from '../src/gate.mjs';
import { installHooks } from '../src/hooks.mjs';
import { takeSnapshot } from '../src/snap.mjs';
import { RC } from '../src/rc.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const PKG = join(import.meta.dirname, '..');
const GATE_BIN = join(PKG, 'bin', 'rk-gate.mjs');
/** 工作流里默认引用的入口（上游仓布局）；fixture 里放一个占位文件让它"指向真实存在的东西" */
const CI_BIN_SUB = join('dsh-rulekeeper', 'bin', 'rk-gate.mjs');

function capture(fn) {
  let out = '';
  let err = '';
  const rc = fn({ out: (t) => { out += String(t); }, err: (t) => { err += String(t); } });
  return { rc, out, err };
}
const gate = (args) => capture((io) => runGate(args, io, {}));
const ci = (args) => gate(['ci', ...args]);
const git = (root, ...args) => {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  return { status: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim(), all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const head = (repo) => git(repo, 'rev-parse', 'HEAD').out;
const rootCommit = (repo) => git(repo, 'rev-list', '--max-parents=0', 'HEAD').out;

function fixture(label, { protectedPaths = ['AGENTS.md'], withHooks = false, ciBinPath = null } = {}) {
  const dir = tempDir(label);
  const repo = join(dir, 'repo');
  const landing = join(repo, '.dsh-ai', 'rulekeeper');
  mkdirSync(repo, { recursive: true });
  mkdirSync(landing, { recursive: true });
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', repo], { encoding: 'utf8' }).status, 0);
  writeFileSync(join(repo, 'src-a.txt'), 'a1\n', 'utf8');
  writeFileSync(join(landing, 'config.json'), `${JSON.stringify({ schema: 1, mode: 'observe' }, null, 2)}\n`, 'utf8');
  writeFileSync(join(landing, 'rules.json'), `${JSON.stringify({ schema: 1, project: 't', protected_paths: protectedPaths, gates: [], checks: [], inject: [] }, null, 2)}\n`, 'utf8');
  // bin 不再是"占位文件"（评审：绿态曾经只验 existsSync）：写一个**真能跑**的薄壳，
  // 前转到本包真实实现 src/cli.mjs —— 这样"执行生成物里的 run: 行"就是真的在跑这道门。
  if (ciBinPath === null) {
    const binAbs = join(repo, CI_BIN_SUB);
    mkdirSync(join(binAbs, '..'), { recursive: true });
    writeFileSync(binAbs, `#!/usr/bin/env node\nimport { runGate } from ${JSON.stringify(pathToFileURL(join(PKG, 'src', 'cli.mjs')).href)};\nprocess.exitCode = runGate(process.argv.slice(2));\n`, 'utf8');
  }
  const w = writeCiWorkflow({ projectRoot: repo, binPath: ciBinPath ?? undefined });
  assert.equal(w.ok, true, w.reason);
  git(repo, 'config', 'user.email', 't@example.test');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'add', '-A');
  assert.equal(git(repo, 'commit', '-q', '-m', 'init').status, 0);
  if (withHooks) {
    const ins = installHooks({ repoRoot: repo, gateBin: GATE_BIN });
    assert.equal(ins.ok, true, JSON.stringify(ins.reasons));
  }
  return { dir, repo, landing, binPath: ciBinPath ?? CI_BIN_SUB };
}
/** 受保护文件"先建 + 先留证"（基线 = 传入内容） */
function protect(f, content = 'v1\n') {
  writeFileSync(join(f.repo, 'AGENTS.md'), content, 'utf8');
  const r = takeSnapshot({ projectRoot: f.repo, landingDir: f.landing, file: join(f.repo, 'AGENTS.md'), now: new Date('2026-09-14T00:00:00Z'), why: 'LF-540 用例' });
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  return r;
}
const snap = (f, now = new Date('2026-09-14T01:00:00Z')) => takeSnapshot({
  projectRoot: f.repo, landingDir: f.landing, file: join(f.repo, 'AGENTS.md'), now, why: 'LF-540 用例（改动后确认）',
});

// ── 前提实测 ────────────────────────────────────────────────────────────────
test('前提实测：`git clone` **不复制 hook** —— 新 clone 上本机门整体缺席（本条的立足点）', () => {
  const f = fixture('ci-premise', { withHooks: true });
  assert.equal(existsSync(join(f.repo, '.githooks', 'pre-commit')), true, 'fixture 里 hook 应当装好了');
  const clone = join(f.dir, 'clone');
  assert.equal(spawnSync('git', ['clone', '-q', f.repo, clone], { encoding: 'utf8' }).status, 0);
  assert.equal(existsSync(join(clone, '.githooks', 'pre-commit')), false, 'clone **不带** hook（.githooks 不是 git 元数据）');
  assert.equal(existsSync(join(clone, '.git', 'hooks', 'pre-commit')), false, 'clone **不带** hook（.git/hooks 只给示例）');
  assert.equal(git(clone, 'config', '--get', 'core.hooksPath').out, '', 'clone 也不会继承 core.hooksPath');
});

// ── 清单原文红态：删 hook 后 CI 仍拦得住 ─────────────────────────────────────
test('red（清单原文）: **没有 hook 的全新 clone** 里，"动过受保护路径但台账无取证"的提交被 ci 判红并列出 sha', () => {
  const f = fixture('ci-clone-red', { withHooks: false });
  protect(f, 'v1\n');
  writeFileSync(join(f.repo, 'AGENTS.md'), 'v2-没人看过的改动\n', 'utf8');
  git(f.repo, 'add', '-A');
  assert.equal(git(f.repo, 'commit', '-q', '--no-verify', '-m', 'bypass').status, 0);
  const sha = head(f.repo);
  const init = rootCommit(f.repo);

  const clone = join(f.dir, 'clone');
  assert.equal(spawnSync('git', ['clone', '-q', f.repo, clone], { encoding: 'utf8' }).status, 0);
  assert.equal(existsSync(join(clone, '.git', 'hooks', 'pre-commit')), false, 'clone 上必须没有本机门（否则这个红态构造不成立）');

  const r = ci(['--repo', clone, '--base', init, '--head', 'HEAD']);
  assert.equal(r.rc, RC.FAIL, r.out);
  assert.match(r.out, new RegExp(`^BYPASSED ${sha.slice(0, 12)} state=no-evidence paths=AGENTS\\.md$`, 'm'));
  assert.match(r.out, /^FINDING CI_GATE_BYPASS_NO_EVIDENCE /m);
  assert.match(r.out, /^RK_GATE_CI_RESULT=fail$/m);
});

test('red: 同一条提交，**本机没装 hook** 时 ci 判红（服务端门不依赖本机 hook）', () => {
  const f = fixture('ci-nohook-red', { withHooks: false });
  protect(f, 'v1\n');
  writeFileSync(join(f.repo, 'AGENTS.md'), 'v2\n', 'utf8');
  git(f.repo, 'add', 'AGENTS.md');
  assert.equal(git(f.repo, 'commit', '-q', '-m', 'no hooks here').status, 0);
  const r = ci(['--repo', f.repo, '--base', rootCommit(f.repo), '--head', 'HEAD']);
  assert.equal(r.rc, RC.FAIL, r.out);
  assert.match(r.out, /^RK_GATE_CI_HOOKS_INSTALLED=false/m);
  assert.match(r.out, /^FINDING CI_GATE_BYPASS_NO_EVIDENCE /m);
});

// ── 绿态（正对照：不能只会红） ───────────────────────────────────────────────
test('green: 有取证的提交（hook 正常留痕）-> ci exit=0，BYPASSED=0', () => {
  const f = fixture('ci-green', { withHooks: true });
  protect(f, 'v1\n');
  writeFileSync(join(f.repo, 'AGENTS.md'), 'v2\n', 'utf8');
  assert.equal(snap(f).ok, true); // 改动后确认（基线 = v2）
  git(f.repo, 'add', 'AGENTS.md');
  const c = git(f.repo, 'commit', '-m', 'legit');
  assert.equal(c.status, 0, c.all);
  assert.match(c.all, /RK_GATE_POSTCOMMIT_RESULT=pass/);
  const r = ci(['--repo', f.repo, '--base', rootCommit(f.repo), '--head', 'HEAD']);
  assert.equal(r.rc, RC.OK, r.out);
  assert.match(r.out, /^RK_GATE_CI_RELEVANT=1$/m);
  assert.match(r.out, /^RK_GATE_CI_BYPASSED=0$/m);
  assert.match(r.out, /^RK_GATE_CI_RESULT=pass$/m);
});

test('green: 事后补齐取证后，同一条提交从红转绿（取证位置不依赖 hook 是否装了）', () => {
  const f = fixture('ci-backfill', { withHooks: false });
  protect(f, 'v1\n');
  writeFileSync(join(f.repo, 'AGENTS.md'), 'v2\n', 'utf8');
  git(f.repo, 'add', 'AGENTS.md');
  assert.equal(git(f.repo, 'commit', '-q', '--no-verify', '-m', 'x').status, 0);
  const sha = head(f.repo);
  const use = ['--repo', f.repo, '--base', rootCommit(f.repo), '--head', 'HEAD'];
  assert.equal(ci(use).rc, RC.FAIL, '无取证时必红');
  assert.equal(snap(f).ok, true); // 补齐"改动后确认"（基线 = 已提交内容）
  const pc = gate(['postcommit', '--repo', f.repo, '--sha', sha, '--now', '2026-09-14T02:00:00Z']);
  assert.equal(pc.rc, RC.OK, pc.out);
  assert.match(pc.out, /^RK_GATE_POSTCOMMIT_RESULT=pass$/m);
  assert.equal(ci(use).rc, RC.OK, '补齐取证后应当转绿');
});

// ── 空转闸（vacuous gate）────────────────────────────────────────────────────
test('red: **保护面为空** -> 空转闸判红（装了 CI ≠ CI 能拦；这道 CI 对任何提交都放行）', () => {
  const f = fixture('ci-vacuous', { protectedPaths: [] });
  const r = ci(['--repo', f.repo, '--all']);
  assert.equal(r.rc, RC.FAIL, r.out);
  assert.match(r.out, /^RK_GATE_CI_PROTECTION_PRESENT=false$/m);
  assert.match(r.out, /^FINDING CI_VACUOUS_NO_PROTECTION /m);
});

// ── 配置完整性（缺文件 / 被放宽 / 指向不存在的入口 = 假 CI）────────────────────
test('red: 工作流缺失 / 被追加上 `|| true` 放宽 -> 两种都判红（能关掉的检查就是装饰品）', () => {
  const f = fixture('ci-tamper', { withHooks: false });
  const wf = join(f.repo, CI_WORKFLOW_REL);
  assert.equal(verifyCiWorkflow({ projectRoot: f.repo }).ok, true);
  const good = readFileSync(wf, 'utf8');
  writeFileSync(wf, `${good}        # || true\n`, 'utf8');
  const tampered = ci(['--repo', f.repo, '--all']);
  assert.equal(tampered.rc, RC.FAIL, tampered.out);
  assert.match(tampered.out, /^FINDING CI_WORKFLOW_TAMPERED /m);
  writeFileSync(wf, good, 'utf8');
  assert.equal(verifyCiWorkflow({ projectRoot: f.repo }).ok, true, '改回去应当重新一致');
  rmSync(wf);
  const missing = ci(['--repo', f.repo, '--all']);
  assert.equal(missing.rc, RC.FAIL, missing.out);
  assert.match(missing.out, /^FINDING CI_WORKFLOW_MISSING /m);
});

test('red: 工作流指向的入口不存在 -> 假 CI 判红（与 LF-520"假安装"同族）', () => {
  const f = fixture('ci-fakebin', { withHooks: false, ciBinPath: 'dsh-rulekeeper/bin/does-not-exist.mjs' });
  const r = ci(['--repo', f.repo, '--all']);
  assert.equal(r.rc, RC.FAIL, r.out);
  assert.match(r.out, /^RK_GATE_CI_BIN=.*present=false/m);
  assert.match(r.out, /^FINDING CI_BIN_MISSING /m);
});

test('red: 入口内容与 `--bin-sha` 不符 -> 判红（可选的内容固定；不符即说明入口被换过）', () => {
  const f = fixture('ci-binsha', { withHooks: false });
  const wrong = ci(['--repo', f.repo, '--all', '--bin-sha', 'f'.repeat(64)]);
  assert.equal(wrong.rc, RC.FAIL, wrong.out);
  assert.match(wrong.out, /^FINDING CI_BIN_SHA_MISMATCH /m);
  const real = sha256OfFile(join(f.repo, CI_BIN_SUB));
  const r = ci(['--repo', f.repo, '--all', '--bin-sha', real]);
  assert.equal(r.out.includes('FINDING CI_BIN_SHA_MISMATCH'), false, 'sha 相符时不该报');
});

// ── 阻断①（独立评审）：**只删除受保护文件**也必须拦得住 ────────────────────────
test('red（独立评审 阻断①）: **只删掉受保护文件**的提交必须判红（--diff-filter=ACMR 看不见 D）', () => {
  const f = fixture('ci-delete', { withHooks: false });
  protect(f, 'v1\n');                                    // 先建 + 先留证（快照索引里有基线）
  assert.equal(git(f.repo, 'add', '-A').status, 0);
  assert.equal(git(f.repo, 'commit', '-q', '-m', 'snap baseline').status, 0);
  const baseline = head(f.repo);
  // 先让"上一次提交"是合法的（有取证），确保下面那次红**只**由"删除"引起
  assert.equal(snap(f).ok, true);
  assert.equal(gate(['postcommit', '--repo', f.repo, '--sha', baseline, '--now', '2026-09-14T02:00:00Z']).rc, RC.OK);
  assert.equal(ci(['--repo', f.repo, '--base', baseline, '--head', 'HEAD']).rc, RC.OK, '基线本身应当是绿的（正对照）');
  // 只做删除
  assert.equal(git(f.repo, 'rm', '-q', 'AGENTS.md').status, 0);
  assert.equal(git(f.repo, 'commit', '-q', '--no-verify', '-m', 'delete protected').status, 0);
  const sha = head(f.repo);
  const r = ci(['--repo', f.repo, '--base', baseline, '--head', 'HEAD']);
  assert.equal(r.rc, RC.FAIL, r.out);
  assert.match(r.out, /^FINDING CI_GATE_BYPASS_PROTECTED_DELETED /m);
  assert.match(r.out, new RegExp(`^BYPASSED ${sha.slice(0, 12)} state=protected-deleted paths=AGENTS\\.md$`, 'm'));
});

test('red（独立评审 阻断①，工作区侧）: 受保护文件被删（索引里有基线、磁盘上没了）-> write 对账判红', () => {
  const f = fixture('ci-delete-write', { withHooks: false });
  protect(f, 'v1\n');
  rmSync(join(f.repo, 'AGENTS.md'));
  const r = gate(['write', '--project', f.repo, '--phase', 'close']);
  assert.equal(r.rc, RC.FAIL, r.out);
  assert.match(r.out, /^FINDING GATE_WRITE_PROTECTED_MISSING /m);
});

// ── 阻断②（独立评审）：**台账不再自证** ──────────────────────────────────────
test('red（独立评审 阻断②）: 往台账追一行最小 JSON 洗白 -> 仍然判红（pass 必须带可对账物证）', () => {
  const f = fixture('ci-forge', { withHooks: false });
  protect(f, 'v1\n');
  writeFileSync(join(f.repo, 'AGENTS.md'), 'v2-TROJAN\n', 'utf8');
  git(f.repo, 'add', 'AGENTS.md');
  assert.equal(git(f.repo, 'commit', '-q', '--no-verify', '-m', 'rogue').status, 0);
  const sha = head(f.repo);
  const use = ['--repo', f.repo, '--base', rootCommit(f.repo), '--head', 'HEAD'];
  assert.equal(ci(use).rc, RC.FAIL, '未伪造时必红');
  const ledgerFile = join(f.landing, 'logs', 'gate.jsonl');
  mkdirSync(join(f.landing, 'logs'), { recursive: true });
  const before = existsSync(ledgerFile) ? readFileSync(ledgerFile, 'utf8') : '';
  writeFileSync(ledgerFile, `${before}${JSON.stringify({ gate: 'post-commit', sha, verdict: 'pass' })}\n`, 'utf8');
  const forged = ci(use);
  assert.equal(forged.rc, RC.FAIL, `伪造最小行**不得**洗白:\n${forged.out}`);
  assert.match(forged.out, /^FINDING CI_GATE_BYPASS_LEDGER_UNVERIFIED /m);
  assert.match(forged.out, /^RK_GATE_CI_LEDGER_AUTHENTICATED=false/m);
});

// ── 生成物**真的被执行**（评审 建议③-1：此前只断言"生成==生成器"）──────────────
test('判据: 把生成物里的 run: 行**真的执行**（替换 GitHub 上下文）→ 有违规时 exit≠0、补证后 exit=0', () => {
  const f = fixture('ci-exec-artifact', { withHooks: false });
  protect(f, 'v1\n');
  writeFileSync(join(f.repo, 'AGENTS.md'), 'v2\n', 'utf8');
  git(f.repo, 'add', 'AGENTS.md');
  assert.equal(git(f.repo, 'commit', '-q', '--no-verify', '-m', 'rogue').status, 0);
  const init = rootCommit(f.repo);
  const bad = head(f.repo);
  const clone = join(f.dir, 'clone');
  assert.equal(spawnSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', f.repo, clone], { encoding: 'utf8' }).status, 0);

  const yml = readFileSync(join(clone, CI_WORKFLOW_REL), 'utf8');
  const runLine = /^ {8}run: (.+)$/m.exec(yml);
  assert.notEqual(runLine, null, '生成物里必须有 run: 行');
  const argv = runLine[1]
    .replaceAll('"${{ github.event.before }}"', init)   // 模拟 push 事件的 GitHub 上下文
    .replaceAll('"${{ github.sha }}"', bad)
    .replaceAll('"', '')
    .split(' ')
    .filter((s) => s !== '');
  assert.equal(argv[0], 'node');
  assert.equal(argv.includes('--base'), true, `run: 行必须带真实范围（不是恒 --all）: ${runLine[1]}`);

  // ① 无 hook 的 clone 里，按生成物的命令跑 → 必须拦
  const first = spawnSync(argv[0], argv.slice(1), { cwd: clone, encoding: 'utf8' });
  assert.equal(first.status, 1, `生成物里的 run: 行必须拦住未留证改动:\n${first.stdout}${first.stderr}`);
  assert.match(`${first.stdout}${first.stderr}`, /FINDING CI_GATE_BYPASS_NO_EVIDENCE/);
  // ② 补齐取证后，同一条命令必须放行
  assert.equal(spawnSync('node', [join(PKG, 'bin', 'rk-snap.mjs'), 'take', '--landing', join(clone, '.dsh-ai', 'rulekeeper'), '--path', 'AGENTS.md', '--project', '.', '--now', '2026-09-15T00:00:00Z'], { cwd: clone, encoding: 'utf8' }).status, 0);
  assert.equal(gate(['postcommit', '--repo', clone, '--sha', bad, '--now', '2026-09-15T00:10:00Z']).rc, RC.OK);
  const second = spawnSync(argv[0], argv.slice(1), { cwd: clone, encoding: 'utf8' });
  assert.equal(second.status, 0, `补证后必须放行:\n${second.stdout}${second.stderr}`);
});

test('red: **保护面写窄**（匹配不到任何真实文件）-> 判红（空转闸的第二种形态）', () => {
  const f = fixture('ci-narrow', { withHooks: false, protectedPaths: ['docs/never-touched.md'] });
  const r = ci(['--repo', f.repo, '--all']);
  assert.equal(r.rc, RC.FAIL, r.out);
  assert.match(r.out, /^RK_GATE_CI_PROTECTION_MATCHED_FILES=0$/m);
  assert.match(r.out, /^FINDING CI_PROTECTION_MATCHES_NOTHING /m);
});

test('判据: `core.hooksPath` 配成仓库外绝对路径时，`--json` 判决里仍**不得出现盘符**（㉒；评审 建议①）', () => {
  const f = fixture('ci-abspath', { withHooks: false });
  const outside = join(f.dir, 'abs-hooks');
  mkdirSync(outside, { recursive: true });
  git(f.repo, 'config', 'core.hooksPath', outside);
  const f2 = { repo: f.repo };
  const r = ci(['--repo', f2.repo, '--all', '--json']);
  assert.equal(/[A-Za-z]:[\\/]/.test(r.out), false, `判决里不得出现盘符绝对路径: ${r.out}`);
  assert.equal(r.out.includes(f.dir), false);
  const parsed = JSON.parse(r.out);
  assert.match(parsed.hooksPath, /^<outside>\//, `hooksPath 必须相对化（实际 ${parsed.hooksPath}）`);
});

// ── 自曝边界：不冒充远端 ─────────────────────────────────────────────────────
test('判据: 恒报 CI_CARRIER_DONE=false；显式 `--claim-remote` 判红（本机模拟不冒充远端已执行）', () => {
  const f = fixture('ci-carrier', { withHooks: true });
  protect(f, 'v1\n');
  writeFileSync(join(f.repo, 'AGENTS.md'), 'v2\n', 'utf8');
  assert.equal(snap(f).ok, true);
  git(f.repo, 'add', 'AGENTS.md');
  assert.equal(git(f.repo, 'commit', '-q', '-m', 'legit').status, 0);
  const base = ['--repo', f.repo, '--base', rootCommit(f.repo), '--head', 'HEAD'];
  const ok = ci(base);
  assert.equal(ok.rc, RC.OK, ok.out);
  assert.match(ok.out, /^RK_GATE_CI_CARRIER_DONE=false/m);
  const claimed = ci([...base, '--claim-remote']);
  assert.equal(claimed.rc, RC.FAIL, claimed.out);
  assert.match(claimed.out, /^FINDING CI_REMOTE_CLAIM_UNSUPPORTED /m);
});

// ── 生成器 / 校验器同源 + 显式生成 ───────────────────────────────────────────
test('判据: 工作流内容**单一来源**（生成 == 校验基准），且 `--write-workflow` 是显式动作', () => {
  const f = fixture('ci-gen', { withHooks: false });
  const onDisk = readFileSync(join(f.repo, CI_WORKFLOW_REL), 'utf8');
  assert.equal(onDisk, ciWorkflowYaml(), '写盘内容必须等于生成函数的内容（防两套实现）');
  assert.equal(onDisk.includes('github.event.before'), true, '默认生成物必须用**事件感知**范围（评审 中危①：此前恒为 --all）');
  assert.equal(onDisk.includes('--all-if-no-base'), false, '不引入装饰性开关：base 缺失时自动退回全历史是内建行为');
  assert.equal(onDisk.endsWith('\n'), true);
  assert.equal(/\r\n/.test(onDisk), false, '生成物必须 LF 结尾（跨平台字节一致）');
  const again = ci(['--repo', f.repo, '--write-workflow']);
  assert.equal(again.rc, RC.OK, again.out);
  assert.match(again.out, /^RK_GATE_CI_WROTE=/m);
  assert.equal(readFileSync(join(f.repo, CI_WORKFLOW_REL), 'utf8'), ciWorkflowYaml(), '重复生成必须幂等');
  // `range` 不再是死参数：显式范围能生成出固定范围的 run: 行
  const scoped = ci(['--repo', f.repo, '--write-workflow', '--workflow-range', '--all']);
  assert.equal(scoped.rc, RC.OK, scoped.out);
  const scopedText = readFileSync(join(f.repo, CI_WORKFLOW_REL), 'utf8');
  assert.equal(/^ {8}run: node .+ ci --all$/m.test(scopedText), true, `--workflow-range 必须真的写进生成物:\n${scopedText}`);
  assert.equal(ci(['--repo', f.repo, '--all']).rc, RC.FAIL, '按 --all 生成后再用默认参数校验 → 判 TAMPERED（生成与校验必须同一套参数）');
});

// ── 范围优先于条数（本轮新教训 L512）────────────────────────────────────────
test('判据: `--base..--head` **优先于** `-n`（CI 要的是"这次 push 推上来的那些"，不是"最近 N 条"）', () => {
  const f = fixture('ci-range', { withHooks: false });
  for (const [i, msg] of [['2', 'c2'], ['3', 'c3'], ['4', 'c4']]) {
    writeFileSync(join(f.repo, 'src-a.txt'), `a${i}\n`, 'utf8');
    git(f.repo, 'add', 'src-a.txt');
    assert.equal(git(f.repo, 'commit', '-q', '-m', msg).status, 0);
  }
  const ranged = listCommits(f.repo, { range: 'HEAD~1..HEAD', limit: 1 });
  assert.equal(ranged.ok, true, ranged.reason);
  assert.equal(ranged.commits.length, 1, '范围里有 1 条就是 1 条（limit 不得把它截短）');
  assert.equal(ranged.commits[0].sha, head(f.repo));
  const wide = listCommits(f.repo, { range: 'HEAD~3..HEAD', limit: 1 });
  assert.equal(wide.commits.length, 3, '范围优先于条数：limit=1 不能把范围截成 1 条');
  const limited = listCommits(f.repo, { limit: 1 });
  assert.equal(limited.commits.length, 1, '不给范围时仍按 -n 取最近 N 条');
});

// ── 入口同源 / rc / ㉒ 无绝对路径 ────────────────────────────────────────────
test('判据: 两个入口同源（`rk-gate ci` 与 `dsh-rulekeeper gate ci` 逐字同输出）', () => {
  const f = fixture('ci-same', { withHooks: true });
  protect(f, 'v1\n');
  writeFileSync(join(f.repo, 'AGENTS.md'), 'v2\n', 'utf8');
  assert.equal(snap(f).ok, true);
  git(f.repo, 'add', 'AGENTS.md');
  assert.equal(git(f.repo, 'commit', '-q', '-m', 'legit').status, 0);
  const args = ['--repo', f.repo, '--base', rootCommit(f.repo), '--head', 'HEAD', '--json'];
  const a = gate(['ci', ...args]);
  const b = capture((io) => runRulekeeper(['gate', 'ci', ...args], io, {}));
  assert.equal(a.out, b.out, '同一实现的第二个入口必须逐字相同');
  assert.equal(a.rc, b.rc);
});

test('判据: `--json` 判决里**没有绝对路径/盘符**（㉒），且键可复现', () => {
  const f = fixture('ci-json', { withHooks: false });
  protect(f, 'v1\n'); // 制造一条"动过受保护路径但无取证"的提交，让判决落在红态上
  writeFileSync(join(f.repo, 'AGENTS.md'), 'v2\n', 'utf8');
  git(f.repo, 'add', 'AGENTS.md');
  assert.equal(git(f.repo, 'commit', '-q', '-m', 'x').status, 0);
  const a = ci(['--repo', f.repo, '--all', '--json']);
  const b = ci(['--repo', f.repo, '--all', '--json']);
  assert.equal(a.out, b.out, '同机两次运行逐字相同');
  assert.equal(/[A-Za-z]:[\\/]/.test(a.out), false, `判决里不得出现盘符绝对路径: ${a.out}`);
  assert.equal(a.out.includes(f.repo), false, '判决里不得出现 fixture 绝对路径');
  const parsed = JSON.parse(a.out);
  assert.equal(parsed.carrier.done, false);
  assert.equal(parsed.ok, false, '无取证必须体现在 ok=false');
  assert.equal(parsed.bypassed.length, 1);
});

test('rc: `--help`=0；未知参数/非 git 目录/非法 --limit = 2（用法错误不与判红混用）', () => {
  const f = fixture('ci-rc', { withHooks: false });
  assert.equal(ci(['--help']).rc, RC.OK);
  assert.equal(ci(['--repo', f.repo, '--nope']).rc, RC.USAGE);
  assert.equal(ci(['--repo', f.repo, '--limit', '0']).rc, RC.USAGE);
  assert.equal(ci(['--repo', join(f.dir, 'nope')]).rc, RC.USAGE);
  const notGit = join(f.dir, 'notgit');
  mkdirSync(notGit, { recursive: true });
  assert.equal(ci(['--repo', notGit]).rc, RC.USAGE);
  assert.equal(ci(['--repo', f.repo, '--base', 'deadbeef']).rc, RC.USAGE, '不存在的 ref 属用法错误，不冒充"判红"');
});
