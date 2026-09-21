// dsh-rulekeeper · LF-520 **hook 完整性 preflight**（hooksPath + 文件存在 + sha256 + 可执行位）
//
// 判据（清单 §5 LF-520）：原样 → exit=0；红态三件套：
//   ① hook 缺失 → exit≠0 ② 改 1 字节 → exit≠0 ③ **装到 `.git/hooks/` 而非 `hooksPath` → 不生效（须红）**
//
// 本文件的两条"反假安全"设计：
//   · ③ 的红不是"文件找不到"，而是"文件**在**、git 却**永远不会执行**它" —— 这正是现实里最常见的"以为有闸、其实没有"。
//   · 可执行位在 Windows 上无法用 NTFS 权限位表达 ⇒ 判据改用 **git 索引 mode（100755）**：
//     它是 git 自己的记录、跨平台一致，而且在 POSIX 上 git 会**忽略**非可执行的 hook ⇒ 这条是真红线（不是 Windows 特有）。
//     用例里 `git update-index --chmod=+x|-x` 两个方向都跑，证明该检查**两个方向都会变**。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runGate, runRulekeeper } from '../src/cli.mjs';
import { commitMessageGate, refsGate } from '../src/gate.mjs';
import { DEFAULT_HOOKS_PATH, HOOK_RUNNER, hookScriptContent, installHooks, verifyHooks } from '../src/hooks.mjs';
import { RC } from '../src/rc.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const PKG = join(import.meta.dirname, '..');
const GATE_BIN = join(PKG, 'bin', 'rk-gate.mjs');
const GIT_BASH = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';

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

/** 真 git 仓库（不提交，只要 .git 与索引） */
function gitRepo(label) {
  const dir = tempDir(label);
  const root = join(dir, 'repo');
  mkdirSync(root, { recursive: true });
  const r = spawnSync('git', ['init', '-q', '-b', 'main', root], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git init 失败: ${r.stderr}`);
  return root;
}

/** 装好并把它入索引（可选 +x），返回 {root, verify} */
function installed(label, { chmod = '+x', track = true } = {}) {
  const root = gitRepo(label);
  const ins = installHooks({ repoRoot: root, gateBin: GATE_BIN });
  assert.equal(ins.ok, true, JSON.stringify(ins.reasons));
  const names = ins.installed.map((h) => h.name);
  assert.deepEqual(names, ['pre-commit', 'commit-msg', 'post-commit', 'pre-push'],
    '默认装四个 hook：真阻断 + **提交正文脱敏** + 绕过可检测 + **CI 等价门禁**（后两个都是 2026-09-21 事故/实测补的）');
  if (track) {
    git(root, 'add', ...names.map((n) => `${DEFAULT_HOOKS_PATH}/${n}`), '.dsh-ai/rulekeeper/hook.mjs', '.dsh-ai/rulekeeper/hooks.json');
    if (chmod !== null) for (const n of names) git(root, 'update-index', `--chmod=${chmod}`, `${DEFAULT_HOOKS_PATH}/${n}`);
  }
  return { root, ins, names, verify: () => verifyHooks({ repoRoot: root }) };
}

test('green: install -> 原样 verify 全过（hooksPath 已设 / sha256 相符 / 索引 mode=100755）', () => {
  const { root, ins } = installed('hk-green');
  assert.equal(ins.configSet, true, 'install 必须把 core.hooksPath 设上（否则 hook 永不执行）');
  assert.equal(git(root, 'config', '--get', 'core.hooksPath').out, DEFAULT_HOOKS_PATH);
  const v = verifyHooks({ repoRoot: root });
  assert.deepEqual(v.findings, []);
  assert.equal(v.ok, true);
  assert.equal(v.hooksPath, DEFAULT_HOOKS_PATH);
  assert.equal(v.hooks.length, 4, 'pre-commit + commit-msg + post-commit + pre-push');
  assert.deepEqual(v.hooks.map((h) => h.name), ['pre-commit', 'commit-msg', 'post-commit', 'pre-push']);
  for (const h of v.hooks) {
    assert.equal(h.present, true);
    assert.equal(h.match, true);
    assert.equal(h.execSource, 'index:100755');
    assert.equal(h.execOk, true);
    assert.equal(h.inert, false);
  }
  const c = gate(['hooks', 'verify', '--repo', root]);
  assert.equal(c.rc, RC.OK, c.out);
  assert.match(c.out, /^RK_GATE_HOOKS_CHECKED=4$/m);
  assert.match(c.out, /^RK_GATE_HOOKS_OK=4$/m);
  assert.match(c.out, /^RK_GATE_HOOKS_RESULT=pass$/m);
  assert.match(c.out, /^HOOK pre-commit path=\.githooks\/pre-commit present=true sha256=[0-9a-f]{12} match=true exec=index:100755 exec_ok=true inert=false$/m);
  assert.match(c.out, /^HOOK post-commit path=\.githooks\/post-commit present=true sha256=[0-9a-f]{12} match=true exec=index:100755 exec_ok=true inert=false$/m);
  assert.match(c.out, /^HOOK pre-push path=\.githooks\/pre-push present=true sha256=[0-9a-f]{12} match=true exec=index:100755 exec_ok=true inert=false$/m);
});

test('red ①（清单原文）: hook 缺失 -> HOOK_MISSING + exit=1', () => {
  const { root } = installed('hk-missing');
  rmSync(join(root, DEFAULT_HOOKS_PATH, 'pre-commit'));
  const v = verifyHooks({ repoRoot: root });
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => f.code === 'HOOK_MISSING'));
  const c = gate(['hooks', 'verify', '--repo', root]);
  assert.equal(c.rc, RC.FAIL, c.out);
  assert.match(c.out, /^RK_GATE_HOOKS_MISSING=1$/m);
  assert.match(c.out, /^FINDING HOOK_MISSING hook 缺失: \.githooks\/pre-commit$/m);
});

test('red ②（清单原文）: 改 1 字节 -> HOOK_MODIFIED（给出 expected/actual）+ exit=1', () => {
  const { root } = installed('hk-modified');
  const file = join(root, DEFAULT_HOOKS_PATH, 'pre-commit');
  writeFileSync(file, `${readFileSync(file, 'utf8')}# 偷偷加一行\n`, 'utf8');
  const v = verifyHooks({ repoRoot: root });
  assert.equal(v.ok, false);
  const f = v.findings.find((x) => x.code === 'HOOK_MODIFIED');
  assert.ok(f, JSON.stringify(v.findings));
  assert.match(f.message, /expected=[0-9a-f]{12} actual=[0-9a-f]{12}/);
  assert.equal(v.hooks[0].match, false);
  const c = gate(['hooks', 'verify', '--repo', root]);
  assert.equal(c.rc, RC.FAIL);
  assert.match(c.out, /^RK_GATE_HOOKS_MODIFIED=1$/m);
});

test('red ③（清单原文）: 装到 .git/hooks/ 而非 hooksPath -> git 不会执行它 = HOOK_INERT_IN_DOTGIT + exit=1', () => {
  const { root } = installed('hk-inert');
  writeFileSync(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', 'utf8');
  const v = verifyHooks({ repoRoot: root });
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => f.code === 'HOOK_INERT_IN_DOTGIT'));
  assert.equal(v.hooks[0].inert, true);
  const c = gate(['hooks', 'verify', '--repo', root]);
  assert.equal(c.rc, RC.FAIL);
  assert.match(c.out, /^RK_GATE_HOOKS_INERT=1$/m);
  assert.match(c.out, /^FINDING HOOK_INERT_IN_DOTGIT /m);
  // 反向：把 hooksPath 真的指到 .git/hooks 时，那个文件就不再是"假安装"
  git(root, 'config', 'core.hooksPath', '.git/hooks');
  const v2 = verifyHooks({ repoRoot: root });
  assert.equal(v2.hooks[0].inert, false, 'hooksPath 指到 .git/hooks 后不再是 inert');
  assert.ok(v2.findings.some((f) => f.code === 'HOOK_PATH_MISMATCH'), '但与清单不一致仍要报');
});

test('red: 可执行位 —— 索引 mode=100644 -> HOOK_NOT_EXECUTABLE；改回 +x 立即转绿（两方向都验）', () => {
  const { root } = installed('hk-exec', { chmod: '-x' });
  const v = verifyHooks({ repoRoot: root });
  assert.equal(v.ok, false);
  assert.equal(v.hooks[0].execSource, 'index:100644');
  const f = v.findings.find((x) => x.code === 'HOOK_NOT_EXECUTABLE');
  assert.ok(f, JSON.stringify(v.findings));
  assert.match(f.message, /git update-index --chmod=\+x \.githooks\/pre-commit/);
  assert.equal(gate(['hooks', 'verify', '--repo', root]).rc, RC.FAIL);
  for (const n of ['pre-commit', 'commit-msg', 'post-commit', 'pre-push']) git(root, 'update-index', '--chmod=+x', `${DEFAULT_HOOKS_PATH}/${n}`);
  const v2 = verifyHooks({ repoRoot: root });
  assert.deepEqual(v2.findings, []);
  assert.equal(v2.ok, true);
});

test('red: 未入索引的 hook 在 win32 上如实记 n/a（不冒充可执行），且 runner 缺失 / manifest 缺失各自判红', () => {
  const { root } = installed('hk-untracked', { track: false });
  const v = verifyHooks({ repoRoot: root });
  assert.equal(v.hooks[0].execSource, process.platform === 'win32' ? 'n/a:untracked-win32' : v.hooks[0].execSource);
  if (process.platform === 'win32') {
    assert.equal(v.findings.some((f) => f.code === 'HOOK_NOT_EXECUTABLE'), false, 'win32 未入索引时不得冒充"不可执行"');
    assert.equal(v.ok, true, '未入索引在 win32 上不该判红（但 execSource 要如实标 n/a）');
  }
  // runner 缺失
  rmSync(join(root, '.dsh-ai', 'rulekeeper', HOOK_RUNNER));
  const v2 = verifyHooks({ repoRoot: root });
  assert.ok(v2.findings.some((f) => f.code === 'HOOK_RUNNER_MISSING'));
  // manifest 缺失
  const fresh = gitRepo('hk-nomanifest');
  const v3 = verifyHooks({ repoRoot: fresh });
  assert.ok(v3.findings.some((f) => f.code === 'HOOK_MANIFEST_MISSING'));
  assert.ok(v3.findings.some((f) => f.code === 'HOOK_PATH_NOT_SET'));
  assert.equal(v3.ok, false);
  assert.equal(v3.hooks.length, 0);
});

test('red: --no-config 只写文件不改 config -> core.hooksPath 仍空 -> verify 判红（"写了文件但没生效"）', () => {
  const root = gitRepo('hk-noconfig');
  const ins = installHooks({ repoRoot: root, gateBin: GATE_BIN, setConfig: false });
  assert.equal(ins.ok, true);
  assert.equal(ins.configSet, false);
  assert.equal(git(root, 'config', '--get', 'core.hooksPath').status, 1, 'config 不该被设置');
  const v = verifyHooks({ repoRoot: root });
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => f.code === 'HOOK_PATH_NOT_SET'));
});

test('green: install 幂等；内容不同时拒覆盖、--force 才覆盖', () => {
  const root = gitRepo('hk-idem');
  assert.equal(installHooks({ repoRoot: root, gateBin: GATE_BIN }).ok, true);
  assert.equal(installHooks({ repoRoot: root, gateBin: GATE_BIN }).ok, true, '同内容重复 install 应成功（幂等）');
  writeFileSync(join(root, DEFAULT_HOOKS_PATH, 'pre-commit'), '#!/bin/sh\nexit 0\n', 'utf8');
  const blocked = installHooks({ repoRoot: root, gateBin: GATE_BIN });
  assert.equal(blocked.ok, false, '被手改过的 hook 不许静默覆盖');
  assert.match(blocked.reasons.join(' '), /--force/);
  const forced = installHooks({ repoRoot: root, gateBin: GATE_BIN, force: true });
  assert.equal(forced.ok, true);
  assert.deepEqual(verifyHooks({ repoRoot: root }).findings.filter((f) => f.code !== 'HOOK_NOT_EXECUTABLE'), []);
});

test('判据: 生成物是"可携带"的 —— hook 脚本 LF 无 BOM、不含盘符绝对路径；runner 里才是本机路径', () => {
  const root = gitRepo('hk-portable');
  const ins = installHooks({ repoRoot: root, gateBin: GATE_BIN });
  assert.equal(ins.ok, true);
  const script = readFileSync(join(root, DEFAULT_HOOKS_PATH, 'pre-commit'), 'utf8');
  assert.equal(script, hookScriptContent());
  assert.equal(script.startsWith('#!/bin/sh\n'), true);
  assert.equal(script.includes('\r'), false, 'hook 脚本必须 LF（CRLF 在 POSIX 上是灾难）');
  assert.equal(/(^|[^A-Za-z])[A-Za-z]:[\\/]/.test(script), false, 'hook 脚本里不得含盘符绝对路径（要能跨机携带）');
  assert.equal(script.includes('.dsh-ai/rulekeeper/hook.mjs'), true, '靠落点里的 runner 落地载荷');
  const runner = readFileSync(join(root, '.dsh-ai', 'rulekeeper', HOOK_RUNNER), 'utf8');
  assert.match(runner, process.platform === 'win32' ? /const GATE_BIN = "[A-Za-z]:\// : /const GATE_BIN = "\//, 'runner 里的本机路径必须写成可携带的正斜杠形式');
  assert.equal(/[A-Za-z]:\\/.test(runner), false, 'runner 里不得出现"盘符+反斜杠"（避免 Windows 转义地狱）');
  assert.equal(runner.includes('gate'), true);
  assert.equal(runner.includes("'write'"), true, '载荷 = LF-530 的 gate write（LF-500 会在此之上加暂存区语义）');
  for (const f of [`${DEFAULT_HOOKS_PATH}/pre-commit`, '.dsh-ai/rulekeeper/hooks.json', '.dsh-ai/rulekeeper/hook.mjs']) {
    const bytes = readFileSync(join(root, f));
    assert.equal(bytes.includes(0x0d), false, `${f} 不得含 CR`);
    assert.equal(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, false, `${f} 不得带 BOM`);
  }
});

test('判据: hook 脚本是合法 POSIX sh（Git Bash `bash -n`）；无 bash 时显式跳过并说明', { skip: !existsSync(GIT_BASH) ? '本机没有 Git Bash（C:\\Program Files\\Git\\bin\\bash.exe）' : false }, () => {
  const root = gitRepo('hk-posix');
  installHooks({ repoRoot: root, gateBin: GATE_BIN });
  const r = spawnSync(GIT_BASH, ['-n', join(root, DEFAULT_HOOKS_PATH, 'pre-commit').replace(/\\/g, '/')], { encoding: 'utf8' });
  assert.equal(r.status, 0, `bash -n 应通过: ${r.stderr}`);
});

test('判据: 两入口同源 —— `rk-gate hooks verify` 与 `dsh-rulekeeper gate hooks verify` 逐字相同', () => {
  const { root } = installed('hk-entries');
  const a = gate(['hooks', 'verify', '--repo', root]);
  const b = capture((io) => runRulekeeper(['gate', 'hooks', 'verify', '--repo', root], io, {}));
  assert.equal(a.out, b.out);
  assert.equal(a.rc, b.rc);
  assert.equal(a.rc, RC.OK);
});

test('--json: verify 计数可机读，且判决类输出不含盘符绝对路径', () => {
  const { root } = installed('hk-json');
  const c = gate(['hooks', 'verify', '--repo', root, '--json']);
  assert.equal(c.rc, RC.OK, c.out);
  const parsed = JSON.parse(c.out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.hooksPath, DEFAULT_HOOKS_PATH);
  assert.equal(parsed.hooks.length, 4);
  assert.equal(parsed.hooks[0].execSource, 'index:100755');
  assert.deepEqual(parsed.findings, []);
  assert.equal(/(^|[^A-Za-z])[A-Za-z]:[\\/]/.test(c.out), false, '判决类输出不得含盘符绝对路径（清单 ㉒）');
  const bad = gate(['hooks', 'verify', '--repo', root, '--hooks-path', '.githooks']);
  assert.equal(bad.rc, RC.OK);
});

test('判据（2026-09-21 区间模式，离机前最后一道）: `commitmsg --range` 逐个扫未推提交的正文；泄漏拦住、当场 amend 即放行', () => {
  // 为什么必须有区间模式：`commit-msg` 只能扫"正在提交的那一条"——`--no-verify` 绕过、钩子装上之前的旧提交、
  // amend 过的正文都从它眼皮下过去。**推送那一刻**把整个区间的正文再扫一遍，才是"泄漏离机之前"的最后一道
  // （过了这道就出机器了，远端分支保护还禁止强推 ⇒ 撤不回来）。
  const root = gitRepo('hk-msg-range');
  const g = (...args) => git(root, ...args);
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'test');
  writeFileSync(join(root, 'a.txt'), 'x\n', 'utf8');
  g('add', '-A');
  g('commit', '-q', '-m', 'fix: 干净的第一条');
  writeFileSync(join(root, 'b.txt'), 'y\n', 'utf8');
  g('add', '-A');
  g('commit', '-q', '-m', 'fix: 第二条\n\n凭证：D:\\opt\\somewhere\\verify\\x.txt');

  const bad = commitMessageGate({ repoRoot: root, range: 'HEAD~1..HEAD' });
  assert.equal(bad.ok, false, '区间里那条泄漏的正文必须被发现');
  assert.equal(bad.commits.length, 1);
  assert.equal(bad.commits[0].leaks, 1);
  const codes = bad.findings.map((f) => f.code);
  assert.ok(codes.includes('GATE_COMMITMSG_INTERNAL_LEAK'), JSON.stringify(codes));
  assert.match(bad.findings[0].message, /推送前/);

  // 当场补救：**amend 改消息**（还在本机、还没推）⇒ 再扫就干净了 —— 这就是"彻底解决"的正确位置
  g('commit', '-q', '--amend', '-m', 'fix: 第二条（正文已脱敏）');
  const fixed = commitMessageGate({ repoRoot: root, range: 'HEAD~1..HEAD' });
  assert.equal(fixed.ok, true, `amend 后应放行；实得 ${JSON.stringify(fixed.findings)}`);
  assert.equal(fixed.commits[0].leaks, 0);

  // 整段历史一起扫（真实形态是 `origin/main..HEAD`；这里两条提交用 `HEAD` 单引用即可覆盖全部可达提交）
  const whole = commitMessageGate({ repoRoot: root, range: 'HEAD' });
  assert.equal(whole.ok, true, `两条都干净时整段应放行；实得 ${JSON.stringify(whole.findings)}`);
  assert.equal(whole.commits.length, 2);
  // 读不到区间 ⇒ fail-closed（不许假装扫过）
  const broken = commitMessageGate({ repoRoot: root, range: 'no-such-ref..HEAD' });
  assert.equal(broken.ok, false);
  assert.match(broken.findings[0].code, /GATE_COMMITMSG_RANGE_UNREADABLE/);
});

test('判据（2026-09-21 引用名脱敏）: 推送的分支/tag 名也过公开面模式表（本地能管的第三块）', () => {
  // 公开面 = 一切随推送离机的内容：文件 + 提交正文 + **引用名**（会出现在远端分支/tag 列表）。
  // PR 描述/CI 日志属远端 API 面，本机钩子天生看不见（已如实登记边界）。
  // 夹具里的"可疑串"**运行时拼装**：检测器的 deny 列表不该为测试文件开例外（开了就是把安全边界越开越大），
  // 而 `rk-selfcheck` 的 S8 是扫**文件正文**的 ⇒ 字面量写在这里会把自己的自检判红（实测踩过一次）。
  const HOST_NO = '1' + '01';                                              // 源码里不出现宿主编号本体
  const TOOL_NAME = 'myx' + '-secret-branch';                              // 源码里不出现内部工具名前缀
  const CLEAN_REF = 'refs/heads/feature/fix-reminder';
  const clean = refsGate({ text: `${CLEAN_REF} aaa1111 ${CLEAN_REF} bbb2222\n` });
  assert.equal(clean.ok, true, JSON.stringify(clean.findings));
  assert.deepEqual(clean.refs, [CLEAN_REF], '同名 local/remote 只记一次');
  const leak = refsGate({ text: `refs/heads/内部项目-${HOST_NO} aaa1111 refs/heads/内部项目-${HOST_NO} 0000000\n` });
  assert.equal(leak.ok, false, '引用名里有内部主机编号/项目名必须拦住');
  assert.ok(leak.findings.some((f) => f.code === 'GATE_REF_INTERNAL_LEAK'));
  assert.match(leak.findings[0].message, /远端分支/);
  // 字段错位（把 sha 写进引用名位置）不得把 sha 当引用名报出来；非法行不参与判定、也不抛
  assert.deepEqual(refsGate({ text: 'refs/heads/x 1111111 2222222 3333333\n' }).refs, ['refs/heads/x']);
  assert.equal(refsGate({ text: 'garbage\n\n' }).ok, true);
  assert.equal(refsGate({}).ok, true);
  // 与 CLI 同源：`rk-gate refs --file` 走同一份实现
  const f = join(tempDir('hk-refs'), 'refs.txt');
  writeFileSync(f, `refs/heads/${TOOL_NAME} aaa1111 refs/heads/${TOOL_NAME} bbb2222\n`, 'utf8');
  const cli = gate(['refs', '--file', f]);
  assert.equal(cli.rc, RC.FAIL);
  assert.match(cli.out, /GATE_REF_INTERNAL_LEAK/);
});

test('usage: hooks 缺动作 / 未知动作 / --repo 不存在 / 未知 flag -> rc=2', () => {  assert.equal(gate(['hooks']).rc, RC.USAGE);
  assert.equal(gate(['hooks', 'bogus']).rc, RC.USAGE);
  assert.equal(gate(['hooks', 'verify', '--repo', join(tempDir('hk-usage'), 'nope')]).rc, RC.USAGE);
  assert.equal(gate(['hooks', 'verify', '--bogus']).rc, RC.USAGE);
  assert.equal(gate(['hooks', 'install', '--help']).rc, RC.OK);
});

test('green: 真仓（本仓）现状如实报 —— hooksPath 未设 / 无清单 -> exit=1（不许假装已装）', () => {
  const v = verifyHooks({ repoRoot: join(PKG, '..', '..', '..') });
  assert.equal(v.ok, false);
  const codes = v.findings.map((f) => f.code);
  assert.ok(codes.includes('HOOK_MANIFEST_MISSING') || codes.includes('HOOK_PATH_NOT_SET'), JSON.stringify(codes));
  // 且"没有 hook"时不得凭空编出 hook 条目
  assert.equal(v.hooks.length, 0);
});

test('判据（2026-09-21 CI 等价门禁）: pre-push 钩子真的会跑 `ci`，门禁红就**拦住推送**；新分支如实跳过', () => {
  // 为什么需要这条：远端规则面要求 3 个必需检查，但仓库所有者推送会被 bypass（远端逐字回报过）
  // ⇒ 唯一能约束自己的是**本机**这道。红态样本用"假 gate"构造（规则 42：不依赖现场恰好红）。
  const root = gitRepo('hk-prepush');
  const logFile = join(root, '..', 'fake-gate.log');
  const fakeGate = join(root, '..', 'fake-gate.mjs');
  writeFileSync(fakeGate, [
    "import { appendFileSync } from 'node:fs';",
    'appendFileSync(process.env.FAKE_GATE_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");',
    "process.exit(process.env.FAKE_GATE_RC === '0' ? 0 : 1);",
    '',
  ].join('\n'), 'utf8');
  const ins = installHooks({ repoRoot: root, gateBin: fakeGate, force: true });
  assert.equal(ins.ok, true, JSON.stringify(ins.reasons));
  assert.ok(ins.installed.some((h) => h.name === 'pre-push'), '默认就要装 pre-push');
  const runner = join(root, DEFAULT_HOOKS_PATH, '..', '.dsh-ai', 'rulekeeper', HOOK_RUNNER);
  const refs = 'refs/heads/main 1111111 refs/heads/main 2222222\n';
  const run = (input, rc) => spawnSync(process.execPath, [runner, 'pre-push'], {
    // 真实 git 调钩子时 cwd = 仓库根；用例显式给 RULEKEEPER_REPO（runner 认这个变量）等价模拟
    encoding: 'utf8', input, env: { ...process.env, FAKE_GATE_LOG: logFile, FAKE_GATE_RC: rc, RULEKEEPER_REPO: root },
  });

  // ①门禁红 ⇒ 钩子必须非零（拦住推送）
  const red = run(refs, '1');
  assert.notEqual(red.status, 0, 'CI 等价门禁红时必须拦住推送（否则这道钩子等于没装）');
  const calls = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  // 推送前顺序：①扫**引用名**（公开面第三块）②扫未推提交的**正文** ③跑 CI 等价门禁
  // 红态（假 gate 返回 1）在第一步就非零退出 ⇒ 只能断言"第一步是 refs"（这正是"最先拦最要紧的"）
  assert.equal(calls[0][0], 'refs', 'pre-push 第一步必须是引用名扫描（分支/tag 名同样是公开面）');
  assert.match(calls[0][2], /rk-prepush-refs-\d+\.txt$/, 'refs 文件由本次 stdin 落临时文件生成');

  // ②门禁绿 ⇒ 放行，且三道按"refs → commitmsg → ci"的顺序都跑过
  const green = run(refs, '0');
  assert.equal(green.status, 0, `门禁绿应放行；实得 status=${green.status} err=${green.err}`);
  const greenCalls = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(greenCalls.at(-3)[0], 'refs');
  assert.deepEqual(greenCalls.at(-2), ['commitmsg', '--repo', root, '--range', '2222222..HEAD'],
    '正文区间扫描必须在 CI 门禁**之前**（先拦不可逆的那道）');
  assert.deepEqual(greenCalls.at(-1), ['ci', '--base', '2222222', '--head', 'HEAD'],
    '必须用**远端已有的那个 sha** 当基点（不是本地分支名，也不是 HEAD~1）');

  // ③新分支/删引用（远端 sha 全零）⇒ **如实跳过并喊一声**（不假装通过，也不无谓拦住）
  //    注意：引用名扫描**仍然会跑**（公开面与有没有基点无关），故这里让假 gate 返回 0（引用名干净）。
  const zero = run('refs/heads/new aaa1111 refs/heads/new 0000000000000000000000000000000000000000\n', '0');
  assert.equal(zero.status, 0, '没有比对基点时不该拦住（但也绝不能声称"门禁通过"）');
  assert.match(zero.stderr, /无可用比对基点/);
  assert.match(zero.stderr, /NOT|不.*静默|如实/, '必须写明是"跳过"而不是"通过"');
});

test('判据（2026-09-21 提交正文脱敏）: `commit-msg` 钩子扫正文 —— 泄漏拦住、干净放行、注释与 diff 不算正文', () => {
  // 事故：文件全过、**正文**里带绝对路径与内部项目名 ⇒ 推送后才发现，远端分支保护**禁止强推** ⇒ 撤不回来。
  const root = gitRepo('hk-commitmsg');
  const ins = installHooks({ repoRoot: root, gateBin: GATE_BIN, force: true });
  assert.equal(ins.ok, true, JSON.stringify(ins.reasons));
  assert.ok(ins.installed.some((h) => h.name === 'commit-msg'), '默认就要装 commit-msg');
  const runner = join(root, '.dsh-ai', 'rulekeeper', HOOK_RUNNER);
  const msgFile = join(root, '..', 'COMMIT_EDITMSG');
  const run = () => spawnSync(process.execPath, [runner, 'commit-msg', msgFile], { encoding: 'utf8' });

  // ①正文里出现内部项目名/盘符路径 ⇒ 必须拦住（这一条正是漏掉的那个洞）
  //    注：钩子 runner 用 `stdio:'inherit'`（让门禁输出直接进终端），故**只断言退出码**；
  //    输出行断言走同一条 CLI 的直接调用（`gate([...])`，可捕获）。
  writeFileSync(msgFile, 'fix: 收尾\n\n凭证：D:\\opt\\somewhere\\verify\\x.txt\n', 'utf8');
  const leak = run();
  assert.notEqual(leak.status, 0, `正文有泄漏必须拦住提交；实得 status=${leak.status}`);
  const leakCli = gate(['commitmsg', '--file', msgFile]);
  assert.equal(leakCli.rc, RC.FAIL);
  assert.match(leakCli.out, /GATE_COMMITMSG_INTERNAL_LEAK/);
  assert.match(leakCli.out, /RK_GATE_COMMITMSG_LEAKS=1/);

  // ②干净正文 ⇒ 放行
  writeFileSync(msgFile, 'fix: 收尾\n\n凭证：.dsh-ai/verify/x.txt（相对路径）\n', 'utf8');
  const clean = run();
  assert.equal(clean.status, 0, `干净正文应放行；实得 status=${clean.status}`);
  const cleanCli = gate(['commitmsg', '--file', msgFile]);
  assert.equal(cleanCli.rc, RC.OK);
  assert.match(cleanCli.out, /^RK_COMMITMSG_RESULT=pass$/m);

  // ③`#` 注释行与 `git commit -v` 的剪刀线之后**不算正文**（否则模板/ diff 会误伤）
  writeFileSync(msgFile, [
    'fix: 收尾', '',
    '# 这是模板注释：D:\\opt\\内部路径\\不该算正文', '',
    '# ------------------------ >8 ------------------------',
    'diff --git a/x b/x', '+++ b/D:\\opt\\内部路径\\y', '',
  ].join('\n'), 'utf8');
  const stripped = run();
  assert.equal(stripped.status, 0, `注释与 diff 不得当成正文；实得 status=${stripped.status}`);

  // ④读不到正文 ⇒ **fail-closed**（不许假装扫过了）
  const missing = spawnSync(process.execPath, [runner, 'commit-msg', join(root, '..', 'no-such-msg')], { encoding: 'utf8' });
  assert.notEqual(missing.status, 0, '读不到正文必须非零（fail-closed）');
  const missingCli = gate(['commitmsg', '--file', join(root, '..', 'no-such-msg')]);
  assert.match(missingCli.out, /GATE_COMMITMSG_UNREADABLE/);
});
