// dsh-rulekeeper · P13 用例：`rk-gate hooks install --names` 透传 + **手写 hook 字节不变**
//
// 现场（2026-09-23，被治理项目报）：库层早就支持 `opts.names`（`src/hooks.mjs`），但 CLI 的用法行里
// 没有 `--names` ⇒ 命令行上做不到"只装/只校验我要的那几件"。而他们的实际场景是：仓里**已经有手写的
// pre-push**，只想让工具装上另外几件、并且**如实告诉我它跳过了哪一个**。
//
// 本文件的判据（红 = 任一性质被破坏）：
//   ① `--names pre-commit,post-commit` ⇒ 只装这两件（manifest/磁盘都只有这两件）
//   ② 位置上已有**手写** hook 且内容不同 ⇒ **字节逐字不变**（不覆盖），并被如实计入 `skipped`
//   ③ 未知名字 / 空名单 ⇒ 用法错误（rc=2），且**一个字节都不写**
//   ④ 不给 `--names` ⇒ 默认四件（老形态不破）
//   ⑤ 跳过后 `verify` 不得把"我没装的那件"报成"被改坏"（跳过 ≠ 安装过）
//
// 反向红：把 CLI 的 `--names` 透传删掉 ⇒ ①③ 红（库层支持不等于 CLI 可达）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runRulekeeper } from '../src/cli.mjs';
import { DEFAULT_HOOKS_PATH, installHooks, verifyHooks } from '../src/hooks.mjs';
import { RC } from '../src/rc.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const PKG = join(import.meta.dirname, '..');
const GATE_BIN = join(PKG, 'bin', 'rk-gate.mjs');

function gitRepo(label) {
  const root = join(tempDir(label), 'repo');
  mkdirSync(root, { recursive: true });
  const r = spawnSync('git', ['init', '-q', '-b', 'main', root], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git init 失败: ${r.stderr}`);
  return root;
}

function capture(fn) {
  let out = '';
  let err = '';
  const rc = fn({ out: (t) => { out += String(t); }, err: (t) => { err += String(t); } });
  return { rc, out, err };
}

test('P13①: `--names` 只装指定那几件（CLI 透传到库层）', () => {
  const root = gitRepo('p13-names');
  const r = capture((io) => runRulekeeper(['gate', 'hooks', 'install', '--repo', root, '--no-config',
    '--names', 'pre-commit,post-commit'], io, {}));
  assert.equal(r.rc, RC.OK, `应成功；out=${r.out} err=${r.err}`);
  assert.match(r.out, /RK_GATE_HOOKS_NAMES=pre-commit,post-commit/);
  assert.match(r.out, /RK_GATE_HOOKS_INSTALLED=2/);
  assert.match(r.out, /HOOK installed pre-commit/);
  assert.match(r.out, /HOOK installed post-commit/);
  assert.doesNotMatch(r.out, /HOOK installed commit-msg/);
  assert.equal(existsSync(join(root, DEFAULT_HOOKS_PATH, 'pre-commit')), true);
  assert.equal(existsSync(join(root, DEFAULT_HOOKS_PATH, 'post-commit')), true);
  assert.equal(existsSync(join(root, DEFAULT_HOOKS_PATH, 'commit-msg')), false, '没点名的件不许写');
  assert.equal(existsSync(join(root, DEFAULT_HOOKS_PATH, 'pre-push')), false);
  // 清单里也只该有这两件（否则 verify 会拿清单去核一个根本不存在的东西）
  const manifest = JSON.parse(readFileSync(join(root, '.dsh-ai', 'rulekeeper', 'hooks.json'), 'utf8'));
  assert.deepEqual(manifest.hooks.map((h) => h.name), ['pre-commit', 'post-commit']);
});

test('P13②: 位置上已有手写 hook ⇒ 字节逐字不变、被如实计入 skipped，其余几件照装', () => {
  const root = gitRepo('p13-handwritten');
  mkdirSync(join(root, DEFAULT_HOOKS_PATH), { recursive: true });
  const handWritten = '#!/bin/sh\n# 项目自有 pre-push 门禁\necho hand-written\n';
  writeFileSync(join(root, DEFAULT_HOOKS_PATH, 'pre-push'), handWritten, 'utf8');

  const r = capture((io) => runRulekeeper(['gate', 'hooks', 'install', '--repo', root, '--no-config',
    '--names', 'pre-commit,pre-push'], io, {}));
  assert.equal(r.rc, RC.OK, `跳过不是失败；out=${r.out}`);
  assert.match(r.out, /RK_GATE_HOOKS_SKIPPED=1/);
  assert.match(r.out, /HOOK skipped pre-push/);
  assert.match(r.out, /--force/);
  // **字节级**核对：手写文件必须逐字不变（"没覆盖"这件事不能只靠回执自证）
  assert.equal(readFileSync(join(root, DEFAULT_HOOKS_PATH, 'pre-push'), 'utf8'), handWritten);
  assert.equal(existsSync(join(root, DEFAULT_HOOKS_PATH, 'pre-commit')), true, '没被占用的那件要装成功');
  // 跳过的那件不得进清单（进了就会被 verify 当成"被改坏"）
  const manifest = JSON.parse(readFileSync(join(root, '.dsh-ai', 'rulekeeper', 'hooks.json'), 'utf8'));
  assert.deepEqual(manifest.hooks.map((h) => h.name), ['pre-commit']);
});

test('P13③: 未知名字 / 空名单 ⇒ 用法错误（rc=2），且零写入', () => {
  const root = gitRepo('p13-usage');
  const unknown = capture((io) => runRulekeeper(['gate', 'hooks', 'install', '--repo', root, '--no-config',
    '--names', 'pre-commit,nope'], io, {}));
  assert.equal(unknown.rc, RC.USAGE, `未知名字必须按用法错误处置；out=${unknown.out}`);
  assert.match(unknown.err, /未知 hook 名 nope/);
  assert.equal(existsSync(join(root, DEFAULT_HOOKS_PATH, 'pre-commit')), false, '用法错误时一个字节都不许写');

  const empty = capture((io) => runRulekeeper(['gate', 'hooks', 'install', '--repo', root, '--no-config',
    '--names', '  ,  '], io, {}));
  assert.equal(empty.rc, RC.USAGE, '空名单不许静默当成"全装"');
  assert.match(empty.err, /--names 为空/);
});

test('P13④: 不给 `--names` ⇒ 默认四件（老形态不破）', () => {
  const root = gitRepo('p13-default');
  const r = capture((io) => runRulekeeper(['gate', 'hooks', 'install', '--repo', root, '--no-config'], io, {}));
  assert.equal(r.rc, RC.OK, `out=${r.out} err=${r.err}`);
  assert.match(r.out, /RK_GATE_HOOKS_NAMES=pre-commit,commit-msg,post-commit,pre-push/);
  assert.match(r.out, /RK_GATE_HOOKS_INSTALLED=4/);
});

test('P13⑤: 跳过之后 verify 不把"我没装的那件"报成被改坏，但漏登记仍要如实指出', () => {
  const root = gitRepo('p13-verify');
  mkdirSync(join(root, DEFAULT_HOOKS_PATH), { recursive: true });
  writeFileSync(join(root, DEFAULT_HOOKS_PATH, 'pre-push'), '#!/bin/sh\nexit 0\n', 'utf8');
  installHooks({ repoRoot: root, gateBin: GATE_BIN, names: ['pre-commit', 'pre-push'] });
  const v = verifyHooks({ repoRoot: root });
  const codes = v.findings.map((f) => f.code);
  assert.equal(codes.includes('HOOK_MODIFIED'), false, `不许把"我跳过没装的手写件"报成被改坏；findings=${JSON.stringify(v.findings)}`);
  // 清单没登记、磁盘上却存在的 hook 必须被**如实指出**（`HOOK_MANIFEST_INCOMPLETE`）：
  // 本仓自己在 `verifyHooks` 里把这条口径定成"这些钩子不会被 verify 核 ⇒ 被改坏也看不见"，
  // 比笼统报"缺失"更准确 —— 用例按**它自己的事实**断言（规则 41），不按我原先的猜测。
  assert.equal(codes.includes('HOOK_MANIFEST_INCOMPLETE'), true,
    `清单漏登记的手写 hook 必须被指出；findings=${JSON.stringify(v.findings)}`);
  assert.match(v.findings.find((f) => f.code === 'HOOK_MANIFEST_INCOMPLETE').message, /pre-push/);
});
