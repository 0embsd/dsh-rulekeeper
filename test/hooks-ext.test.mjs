// dsh-rulekeeper · P25 用例：项目扩展点（Q91 迁移的载体）
//
// 现场（2026-10-18，某被治理项目报）：Q91 事前规划门被**手加进生成物** `.dsh-ai/rulekeeper/hook.mjs`，
//   而该文件由 `rk-gate hooks install` 无条件覆盖（src/hooks.mjs 的 install 写入 runner），
//   且 `hooks verify` 不在提交链上 ⇒ 这扇门随时会静默消失。
// 本文件的判据（红 = 任一性质被破坏）：
//   ① 模板**确定性**且**零机器路径**（P14：跨机同 sha；生成物里不得出现盘符路径或 /Users/ 形态）
//   ② install 写入的 runner 与模板逐字节一致
//   ③ 本机态 `hooksExt` 在重装时被保留（否则 required=true 被抹掉 ⇒ 静默降级）
//   ④ 扩展文件存在 ⇒ 执行它并**逐字透传退出码**（stderr 有 `[rk-ext] loaded`）
//   ⑤ 缺扩展 + required=true ⇒ exit 1（fail-closed）；required=false ⇒ exit 0 且**大声说明**（不静默）
//
// 反向红：把模板里的扩展分发段删掉 ⇒ ④⑤ 红；把 localState 的 `hooksExt` 透传删掉 ⇒ ③ 红。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { hookRunnerContent, installHooks, localStatePathOf, verifyHooks } from '../src/hooks.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const TEMPLATE = hookRunnerContent();

function gitRepo(label) {
  const root = join(tempDir(label), 'repo');
  mkdirSync(root, { recursive: true });
  const r = spawnSync('git', ['init', '-q', '-b', 'main', root], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git init 失败: ${r.stderr}`);
  return root;
}

function stubGate(root) {
  const p = join(root, 'stub-gate.mjs');
  writeFileSync(p, '// 用例替身：基础 steps 一律放行\nprocess.exit(0);\n', 'utf8');
  return p;
}

function install(root) {
  const r = installHooks({ repoRoot: root, gateBin: stubGate(root), setConfig: false });
  assert.equal(r.ok, true, `install 失败: ${JSON.stringify(r)}`);
  return r;
}

function writeExt(root, name, body) {
  const dir = join(root, '.dsh-ai', 'rulekeeper', 'hooks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.mjs`), body, 'utf8');
}

function patchLocal(root, hooksExt) {
  const file = localStatePathOf(root);
  const state = JSON.parse(readFileSync(file, 'utf8'));
  state.hooksExt = hooksExt;
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function patchLocalRaw(root, extra) {
  const file = localStatePathOf(root);
  const state = { ...JSON.parse(readFileSync(file, 'utf8')), ...extra };
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function runHook(root, hookName = 'pre-commit', input) {
  return spawnSync(process.execPath, [join(root, '.dsh-ai', 'rulekeeper', 'hook.mjs'), hookName], {
    cwd: root, encoding: 'utf8', ...(input === undefined ? {} : { input }),
  });
}

test('P25①: 模板确定性 + 零机器路径', () => {
  assert.equal(hookRunnerContent(), TEMPLATE, '模板必须逐次相同（跨机同 sha）');
  assert.doesNotMatch(TEMPLATE, /[A-Za-z]:[\\/]/, '模板不得含盘符绝对路径');
  assert.doesNotMatch(TEMPLATE, /\/Users\//, '模板不得含 /Users/ 本机路径');
  assert.match(TEMPLATE, /\[rk-ext\] loaded/, '模板必须真含扩展分发段（否则本用例是假绿）');
});

test('P25②: install 写出的 runner 与模板逐字节一致', () => {
  const root = gitRepo('p25-runner');
  install(root);
  const onDisk = readFileSync(join(root, '.dsh-ai', 'rulekeeper', 'hook.mjs'), 'utf8');
  assert.equal(onDisk, TEMPLATE);
});

test('P25③: 重装保留本机态 hooksExt（required=true 不被抹掉）', () => {
  const root = gitRepo('p25-keep');
  install(root);
  patchLocal(root, { required: true });
  install(root);
  const state = JSON.parse(readFileSync(localStatePathOf(root), 'utf8'));
  assert.deepEqual(state.hooksExt, { required: true }, 'install 后 hooksExt 必须原样保留');
});

test('P25③b: 本机态的人设键（不在 install 管理面）重装后仍在', () => {
  const root = gitRepo('p25-keep-extra');
  install(root);
  patchLocalRaw(root, { q91Checker: 'tools/checker.mjs' });
  install(root);
  const state = JSON.parse(readFileSync(localStatePathOf(root), 'utf8'));
  assert.equal(state.q91Checker, 'tools/checker.mjs', 'install 不许抹掉模板/扩展仍在读的人设键');
});

test('P25④: 扩展文件存在 ⇒ 执行并逐字透传退出码', () => {
  const root = gitRepo('p25-run');
  install(root);
  writeExt(root, 'pre-commit', "process.stderr.write('ext-ran\\n');\nprocess.exit(7);\n");
  const r = runHook(root);
  assert.equal(r.status, 7, `退出码必须透传；stderr=${r.stderr}`);
  assert.match(r.stderr, /\[rk-ext\] loaded pre-commit/);
  assert.match(r.stderr, /ext-ran/);
});

test('P25⑤: 缺扩展时 required 档位', () => {
  const root = gitRepo('p25-required');
  install(root);
  patchLocal(root, { required: true });
  const blocked = runHook(root);
  assert.equal(blocked.status, 1, 'required=true 缺扩展必须 fail-closed');
  assert.match(blocked.stderr, /required=true 但找不到/);

  patchLocal(root, { required: false });
  const skipped = runHook(root);
  assert.equal(skipped.status, 0, 'required=false 缺扩展必须放行');
  assert.match(skipped.stderr, /未配置项目扩展/);
});

test('P25⑥: 未声明 hooksExt 的仓不输出降级噪音（放行且无横幅）', () => {
  const root = gitRepo('p25-undeclared');
  install(root);
  const r = runHook(root);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stderr, /未配置项目扩展/, '没声明 hooksExt 的仓不该被降级横幅长期刷屏');
});

test('P25⑦（可达性）: commit-msg / pre-push 的成功出口也必须执行扩展', () => {
  const root = gitRepo('p25-reach');
  install(root);
  writeExt(root, 'commit-msg', "process.exit(7);\n");
  const cm = runHook(root, 'commit-msg', '');
  assert.equal(cm.status, 7, `commit-msg 扩展必须可达；stderr=${cm.stderr}`);
  assert.match(cm.stderr, /\[rk-ext\] loaded commit-msg/);

  writeExt(root, 'pre-push', "process.exit(5);\n");
  const pp = runHook(root, 'pre-push', 'refs/heads/main 0000000000000000000000000000000000000000 refs/heads/main 0000000000000000000000000000000000000000\n');
  assert.equal(pp.status, 5, `pre-push 扩展必须可达（无基点成功出口）；stderr=${pp.stderr}`);
  assert.match(pp.stderr, /\[rk-ext\] loaded pre-push/);
});

test('P25⑧: required=true 的扩展未入库 ⇒ verify 判 HOOK_EXT_REQUIRED_UNTRACKED（入库后转绿）', () => {
  const root = gitRepo('p25-track');
  install(root);
  spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root });
  patchLocal(root, { required: true });
  writeExt(root, 'pre-commit', 'process.exit(0);\n');

  const before = verifyHooks({ repoRoot: root });
  assert.equal(before.ok, false, '未入库的 required 扩展必须判红');
  assert.ok(before.findings.some((f) => f.code === 'HOOK_EXT_REQUIRED_UNTRACKED'), JSON.stringify(before.findings));

  const add = spawnSync('git', ['add', '.dsh-ai/rulekeeper/hooks/pre-commit.mjs'], { cwd: root });
  assert.equal(add.status, 0);
  const after = verifyHooks({ repoRoot: root });
  assert.equal(after.ok, true, JSON.stringify(after.findings));
});

test('P25⑨: required=true 但一份扩展都没有 ⇒ verify 判 HOOK_EXT_REQUIRED_MISSING', () => {
  const root = gitRepo('p25-noext');
  install(root);
  spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root });
  patchLocal(root, { required: true });
  const r = verifyHooks({ repoRoot: root });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.code === 'HOOK_EXT_REQUIRED_MISSING'), JSON.stringify(r.findings));
});

test('P25⑩: required 的作用域只覆盖 hooks 列出的 hook（免得被自身缺扩展拒掉）', () => {
  const root = gitRepo('p25-scope');
  install(root);
  patchLocalRaw(root, { hooksExt: { required: true, hooks: ['pre-commit'] } });
  const cm = runHook(root, 'commit-msg', '');
  assert.equal(cm.status, 0, `commit-msg 不在作用域内 ⇒ 放行；stderr=${cm.stderr}`);
  assert.match(cm.stderr, /hooksExt 未覆盖本 hook/);
  const pc = runHook(root, 'pre-commit');
  assert.equal(pc.status, 1, 'pre-commit 在作用域内且缺扩展 ⇒ fail-closed');
});

test('P25⑪: hooks 作用域内缺文件 ⇒ verify 点名缺的是哪一条', () => {
  const root = gitRepo('p25-scope-verify');
  install(root);
  spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root });
  patchLocalRaw(root, { hooksExt: { required: true, hooks: ['pre-commit', 'pre-push'] } });
  writeExt(root, 'pre-commit', 'process.exit(0);\n');
  const add = spawnSync('git', ['add', '.dsh-ai/rulekeeper/hooks/pre-commit.mjs'], { cwd: root });
  assert.equal(add.status, 0);
  const r = verifyHooks({ repoRoot: root });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.code === 'HOOK_EXT_REQUIRED_MISSING' && /pre-push/.test(f.message)), JSON.stringify(r.findings));
});
