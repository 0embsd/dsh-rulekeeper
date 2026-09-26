// dsh-rulekeeper · 测试入口壳 `bin/rk-test.mjs` 的用例（2026-09-19，教训 L636 的机械面）
//
// 判据：带参数的"部分运行"必须在输出里**明确自曝不是交付凭证**（首尾各一次）；
//   `--help` 要在用法里写清同一件事，且**不得**触发"部分运行"提示（否则提示退化成噪声）。
// 红态：把提示去掉（或只在全量时打印）⇒ 本用例必红 —— 即"分文件跑绿又被当成交付判据"这一复发形态。
//
// **2026-09-26 追加（从 GitHub 装包实测发现）**：发布包**不含** `*.test.mjs`（`files` 只放
//   `test/fixtures/checker/`）⇒ 在装出来的包里跑 `rk-test` 曾回落到 node 的默认发现，抓到 3 个
//   "碰巧长得像测试"的文件（含一个**故意违规的夹具**）并报 2 条**假红**。
//   判据：**发现 0 条用例时必须以 rc=1 明确失败并说清原因**，且**不得**回落去跑别的文件。
//
// 为什么不测"全量运行"：本文件就在全量集合里，spawn 一次全量 = 递归调用自己。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { cleanupAll, PKG_ROOT, tempDir } from './helpers/sandbox.mjs';

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

test('判据（装包面）: 包内**没有**用例时，rk-test 必须 rc=1 明确失败，且**不回落**到 node 默认发现', () => {
  // 造一个"像发布包"的包根：拷源码，但按 `files` 清单的语义**去掉用例面**（只留 fixtures）
  const root = join(tempDir('rk-test-nopkg'), 'pkg');
  cpSync(PKG_ROOT, root, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(PKG_ROOT.length + 1).replace(/\\/g, '/');
      if (rel.startsWith('test/') && !rel.startsWith('test/fixtures')) return false;   // 用例面不在发布面上
      if (rel.startsWith('.git/') || rel.startsWith('.dsh-ai')) return false;
      return true;
    },
  });
  assert.equal(readdirSync(join(root, 'test')).some((n) => n.endsWith('.test.mjs')), false, '前置：拷出来的副本必须没有用例');
  assert.equal(existsSync(join(root, 'test', 'fixtures')), true, '前置：判据运行时要用的夹具面仍在');

  const res = spawnSync(process.execPath, [join(root, 'bin', 'rk-test.mjs')], { cwd: root, encoding: 'utf8' });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  assert.equal(res.status, 1, `没有用例面 ⇒ 必须 rc=1（不许回落去跑夹具/检查器）；实得 ${res.status}\n${out}`);
  assert.match(out, /没发现任何/, '要说清"没发现用例"');
  assert.match(out, /files/, '要点名根因（发布面 `files` 不含用例）');
  assert.match(out, /不回落/, '要写明**不回落**到 node 默认发现（否则读者会以为只是提示）');
  assert.equal(/ℹ tests /.test(out), false, `**一条用例都不该跑**（实得跑了几条）:\n${out}`);
  // 反向红：旧行为（回落）会跑 `scripts/checkers/test-isolation.mjs` 之类，输出里会出现 tests 统计。
  // 清理交给 sandbox 的 cleanupAll（tempDir 已登记），此处不重复删。
});
