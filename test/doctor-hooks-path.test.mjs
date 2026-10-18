// dsh-rulekeeper · doctor 的 core.hooksPath 运行时接线判据（2026-10-18）
//
// 缺口现场（真 clone 实测）：钩子文件随仓到达，但 core.hooksPath **不随仓**（git 固有行为）；
// 新克隆未 install 时 commit 不执行门禁，且输出里一条 RK_GATE_* 都没有 —— 静默不生效 ≠ 通过。
// 判据只认运行时配置（git config --get core.hooksPath），不看文件在不在。
//
// 两态样本（规则 42/53）：未设 ⇒ 报 UNSET；设对 ⇒ 不报；设错 ⇒ 报 DRIFT；非 git 工作树 ⇒ info 不适用。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { doctor, doctorExitCode } from '../src/doctor.mjs';

function scene(label) {
  const dir = mkdtempSync(join(tmpdir(), `rk-doctor-hooks-${label}-`));
  const repo = join(dir, 'repo');
  const landing = join(repo, '.dsh-ai', 'rulekeeper');
  mkdirSync(landing, { recursive: true });
  writeFileSync(join(landing, 'hooks.json'), `${JSON.stringify({ schema: 1, hooksPath: '.githooks' }, null, 2)}\n`, 'utf8');
  const git = (args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  return { dir, repo, landing, git, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const codesOf = (report) => report.findings.map((f) => f.code);

test('非 git 工作树 ⇒ info NOT_APPLICABLE（不适用 ≠ 通过，也不误报）', () => {
  const { dir, repo, landing, done } = scene('nogit');
  try {
    mkdirSync(repo, { recursive: true });
    const r = doctor({ landingDir: landing, projectRoot: repo });
    assert.ok(codesOf(r).includes('DOCTOR_HOOKS_PATH_NOT_APPLICABLE'));
    assert.equal(r.findings.some((f) => f.code === 'DOCTOR_HOOKS_PATH_UNSET'), false);
  } finally { done(); }
});

test('两态：git 仓未设 core.hooksPath ⇒ UNSET(warn)；设对后不再报', () => {
  const { dir, repo, landing, git, done } = scene('two-state');
  try {
    assert.equal(git(['init', '-q']).status, 0);
    const before = doctor({ landingDir: landing, projectRoot: repo });
    assert.ok(codesOf(before).includes('DOCTOR_HOOKS_PATH_UNSET'), codesOf(before).join(','));
    assert.equal(doctorExitCode(before, false), 0, 'warn 默认不进 exit');
    assert.equal(doctorExitCode(before, true), 1, '--strict 下 warn 算 error');

    assert.equal(git(['config', 'core.hooksPath', '.githooks']).status, 0);
    const after = doctor({ landingDir: landing, projectRoot: repo });
    assert.equal(codesOf(after).includes('DOCTOR_HOOKS_PATH_UNSET'), false);
    assert.equal(codesOf(after).includes('DOCTOR_HOOKS_PATH_DRIFT'), false);
  } finally { done(); }
});

test('设错（指向别的目录）⇒ DRIFT(warn)，且点名期望目录', () => {
  const { dir, repo, landing, git, done } = scene('drift');
  try {
    assert.equal(git(['init', '-q']).status, 0);
    assert.equal(git(['config', 'core.hooksPath', '.githooks-typo']).status, 0);
    const r = doctor({ landingDir: landing, projectRoot: repo });
    const f = r.findings.find((x) => x.code === 'DOCTOR_HOOKS_PATH_DRIFT');
    assert.ok(f, codesOf(r).join(','));
    assert.match(f.msg, /\.githooks/);
  } finally { done(); }
});
