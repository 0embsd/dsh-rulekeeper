// dsh-rulekeeper · LF-160 用例：单行写入原子性契约（编码/追加/容错读取）
//
// 判据（清单 LF-160）：一行 = 一次 writeSync；行长上限；≥8 进程 x ≥250 行 -> 行数精确 + 每行可 parse + 无撕裂
//   （真进程部分由 scripts/atomicity-probe.mjs 提供，本文件覆盖契约与判定逻辑）
// 红态：分段写导致行撕裂 / 整文件覆写导致丢失（见 probe 与凭证）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { appendLine, encodeLine, readLines } from '../src/append.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const fileIn = (label) => join(tempDir(label), 'data.jsonl');

test('encodeLine：合法一行编成单个 Buffer（末尾 LF，无嵌换行）', () => {
  const r = encodeLine({ a: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.text, '{"a":1}');
  assert.equal(r.buf.toString('utf8'), '{"a":1}\n');
});

test('encodeLine：嵌换行 / 回车 / 超长 一律拒绝', () => {
  assert.equal(encodeLine('a\nb').ok, false);
  assert.equal(encodeLine('a\rb').ok, false);
  const long = encodeLine('x'.repeat(100), { maxLineBytes: 32 });
  assert.equal(long.ok, false);
  assert.match(long.reason, /超过上限/);
});

test('appendLine：两次追加 -> 2 行，返回字节数 = 行字节数（含 LF）', () => {
  const file = fileIn('append-basic');
  const r1 = appendLine(file, { i: 1 });
  const r2 = appendLine(file, { i: 2 });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r1.bytes, Buffer.byteLength('{"i":1}\n', 'utf8'));
  const read = readLines(file);
  assert.equal(read.values.length, 2);
  assert.equal(read.badLines, 0);
  assert.equal(read.truncatedTail, false);
});

test('appendLine：超长一行被拒且不落盘（契约不是建议）', () => {
  const file = fileIn('append-oversize');
  appendLine(file, { ok: true });
  const before = readFileSync(file, 'utf8');
  const r = appendLine(file, 'y'.repeat(200), { maxLineBytes: 32 });
  assert.equal(r.ok, false);
  assert.equal(readFileSync(file, 'utf8'), before, '被拒的行不得留下任何字节');
});

test('readLines：3 条合法 -> values=3 / badLines=0 / 无截断尾', () => {
  const file = fileIn('read-ok');
  for (const i of [1, 2, 3]) appendFileSync(file, `${JSON.stringify({ i })}\n`, 'utf8');
  const read = readLines(file);
  assert.equal(read.values.length, 3);
  assert.equal(read.badLines, 0);
  assert.equal(read.oversized, 0);
  assert.equal(read.truncatedTail, false);
});

test('red: 一行被撕裂（分两段写、中间无换行）-> 必须报坏行且不抛', () => {
  const file = fileIn('read-torn');
  appendFileSync(file, '{"a":1', 'utf8');
  appendFileSync(file, ':2}\n', 'utf8'); // 撕裂拼接 -> 非法 JSON
  let threw = false;
  let read = null;
  try {
    read = readLines(file);
  } catch {
    threw = true;
  }
  assert.equal(threw, false, '坏行不得导致整体读取失败');
  assert.equal(read.badLines, 1);
  assert.equal(read.values.length, 0);
});

test('red: 尾部半行（崩溃残留）-> truncatedTail=true 且 badLines+1，不抛', () => {
  const file = fileIn('read-half');
  appendFileSync(file, '{"i":1}\n{"i":2}\n{"i":3', 'utf8'); // 末行没写完
  const read = readLines(file);
  assert.equal(read.truncatedTail, true);
  assert.equal(read.badLines, 1);
  assert.equal(read.values.length, 2);
});

test('readLines：行长超上限计入 oversized（守契约、不当成正常行）', () => {
  const file = fileIn('read-oversize');
  appendFileSync(file, `${'z'.repeat(80)}\n`, 'utf8');
  const read = readLines(file, { maxLineBytes: 16 });
  assert.equal(read.oversized, 1);
});

test('readLines：文件不存在 -> missing=true 且不抛（首次运行场景）', () => {
  const file = join(tempDir('read-missing'), 'nope.jsonl');
  assert.equal(existsSync(file), false);
  const read = readLines(file);
  assert.equal(read.missing, true);
  assert.equal(read.badLines, 0);
});
