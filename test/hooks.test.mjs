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
  assert.deepEqual(names, ['pre-commit', 'post-commit'], '默认装两个 hook：真阻断 + 绕过可检测');
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
  assert.equal(v.hooks.length, 2, 'pre-commit + post-commit');
  assert.deepEqual(v.hooks.map((h) => h.name), ['pre-commit', 'post-commit']);
  for (const h of v.hooks) {
    assert.equal(h.present, true);
    assert.equal(h.match, true);
    assert.equal(h.execSource, 'index:100755');
    assert.equal(h.execOk, true);
    assert.equal(h.inert, false);
  }
  const c = gate(['hooks', 'verify', '--repo', root]);
  assert.equal(c.rc, RC.OK, c.out);
  assert.match(c.out, /^RK_GATE_HOOKS_CHECKED=2$/m);
  assert.match(c.out, /^RK_GATE_HOOKS_OK=2$/m);
  assert.match(c.out, /^RK_GATE_HOOKS_RESULT=pass$/m);
  assert.match(c.out, /^HOOK pre-commit path=\.githooks\/pre-commit present=true sha256=[0-9a-f]{12} match=true exec=index:100755 exec_ok=true inert=false$/m);
  assert.match(c.out, /^HOOK post-commit path=\.githooks\/post-commit present=true sha256=[0-9a-f]{12} match=true exec=index:100755 exec_ok=true inert=false$/m);
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
  for (const n of ['pre-commit', 'post-commit']) git(root, 'update-index', '--chmod=+x', `${DEFAULT_HOOKS_PATH}/${n}`);
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
  assert.equal(parsed.hooks.length, 2);
  assert.equal(parsed.hooks[0].execSource, 'index:100755');
  assert.deepEqual(parsed.findings, []);
  assert.equal(/(^|[^A-Za-z])[A-Za-z]:[\\/]/.test(c.out), false, '判决类输出不得含盘符绝对路径（清单 ㉒）');
  const bad = gate(['hooks', 'verify', '--repo', root, '--hooks-path', '.githooks']);
  assert.equal(bad.rc, RC.OK);
});

test('usage: hooks 缺动作 / 未知动作 / --repo 不存在 / 未知 flag -> rc=2', () => {
  assert.equal(gate(['hooks']).rc, RC.USAGE);
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
