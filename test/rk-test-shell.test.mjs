// dsh-rulekeeper · 测试入口壳 `bin/rk-test.mjs` 的用例（2026-09-19，教训 L636 的机械面）
//
// 判据：带参数的"部分运行"必须在输出里**明确自曝不是交付凭证**（首尾各一次）；
//   `--help` 要在用法里写清同一件事，且**不得**触发"部分运行"提示（否则提示退化成噪声）。
// 红态：把提示去掉（或只在全量时打印）⇒ 本用例必红 —— 即"分文件跑绿又被当成交付判据"这一复发形态。
//
// 为什么不测"全量运行"：本文件就在全量集合里，spawn 一次全量 = 递归调用自己。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { cleanupAll, PKG_ROOT } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const SHELL = join(PKG_ROOT, 'bin', 'rk-test.mjs');

test('判据: 部分运行首尾各打一次"不是交付凭证"提示（rc 仍透传）', () => {
  const res = spawnSync(process.execPath, [SHELL, 'test/rc.test.mjs'], { cwd: PKG_ROOT, encoding: 'utf8' });
  assert.equal(res.status, 0, `被选中的用例应当通过（stderr=${res.stderr}）`);
  const hits = res.stderr.split('\n').filter((l) => l.includes('交付凭证'));
  assert.ok(hits.length >= 2, `首尾各一次提示（实得 ${hits.length} 行）：\n${res.stderr}`);
  assert.match(res.stderr, /rk-selfcheck/, '要指名交付判据（全量 + 包级自检）');
});

test('判据: --help 写清"带参数 ≠ 交付凭证"，且不触发部分运行提示', () => {
  const res = spawnSync(process.execPath, [SHELL, '--help'], { cwd: PKG_ROOT, encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /用法: rk-test/);
  assert.match(res.stdout, /不构成交付凭证/, '用法里要写清"带参数 ≠ 交付凭证"');
  assert.equal(res.stderr.includes('部分**运行'), false, '--help 不该触发部分运行提示');
});
