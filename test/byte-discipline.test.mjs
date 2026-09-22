// dsh-rulekeeper · 行尾纪律检查器用例（L648/L653 的通用化）
//
// 判据（读死再下结论）：
//   ① 红样本三处违规都必须报：混行尾 / `.gitattributes` 零钉规则 / `.githooks` 未被显式钉
//   ② 绿样本零违规；真仓零违规（含"夹具面必须豁免"这一条：`test-fixtures/` 里放着故意违规的样本）
//   ③ 没有被测对象（既无 .gitattributes 也无 .githooks）⇒ rc=2（不是"通过"）
//
// 红 = 上面任一条被放宽（例如混行尾被忽略、或夹具面没豁免 ⇒ 真仓永远红）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanupAll, PKG_ROOT, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const CHECKER = join(PKG_ROOT, 'scripts', 'checkers', 'byte-discipline.mjs');

function run(sampleDir) {
  const res = spawnSync(process.execPath, [CHECKER], {
    cwd: PKG_ROOT, encoding: 'utf8', env: { ...process.env, RULEKEEPER_SAMPLE_DIR: sampleDir },
  });
  return { rc: res.status, out: res.stdout ?? '', err: res.stderr ?? '' };
}

test('判据②: 真仓零违规（夹具面必须豁免，否则永远红）', () => {
  const res = run(PKG_ROOT);
  assert.equal(res.rc, 0, `真仓应零违规；out=${res.out}`);
  assert.match(res.out, /BYTE_DISCIPLINE_VIOLATIONS=0/);
  // 反向钉住豁免面：真仓里的红样本是**故意**的，不该算违规
  assert.match(res.out, /PINS=\d+/);
});

test('判据①: 混行尾 / 零钉规则 / .githooks 未钉 —— 三类都要报', () => {
  const dir = tempDir('byte-3');
  mkdirSync(join(dir, '.githooks'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.gitattributes'), '# 只有注释，没有任何钉规则\n', 'utf8');
  writeFileSync(join(dir, 'src', 'mixed.txt'), 'a\r\nb\nc\r\n', 'utf8');       // CRLF 与裸 LF 混在一起
  writeFileSync(join(dir, '.githooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', 'utf8');
  const res = run(dir);
  assert.equal(res.rc, 1);
  assert.match(res.out, /BYTE_EOL_INCONSISTENT/);
  assert.match(res.out, /BYTE_NOT_DECLARED/);
  assert.match(res.out, /BYTE_EXT_PIN_MISSING/);
});

test('判据②b: 显式钉住 + 纯 LF ⇒ 绿', () => {
  const dir = tempDir('byte-green');
  mkdirSync(join(dir, '.githooks'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.gitattributes'), '*.txt text eol=lf\n.githooks/*  text eol=lf\n', 'utf8');
  writeFileSync(join(dir, 'src', 'clean.txt'), 'a\nb\n', 'utf8');
  writeFileSync(join(dir, '.githooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', 'utf8');
  const res = run(dir);
  assert.equal(res.rc, 0, `应当绿；out=${res.out}`);
});

test('判据②c: 纯 CRLF（**不混**）不算违规 —— 判的是"混"与"没声明"，不是"必须 LF"', () => {
  const dir = tempDir('byte-crlf');
  writeFileSync(join(dir, '.gitattributes'), '*.txt text eol=crlf\n', 'utf8');
  writeFileSync(join(dir, 'all.txt'), 'a\r\nb\r\nc\r\n', 'utf8');
  const res = run(dir);
  assert.equal(res.rc, 0, `统一 CRLF 也有显式声明 ⇒ 不违规；out=${res.out}`);
});

test('判据③: 没有被测对象 ⇒ rc=2', () => {
  const empty = tempDir('byte-empty');
  const res = run(empty);
  assert.equal(res.rc, 2);
  assert.match(res.out, /SUBJECT=absent/);
});
