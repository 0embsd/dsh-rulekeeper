// dsh-rulekeeper · LF-1A0 用例：诊断日志载体（含 stack / 轮转受控 / fail-safe / 坏行容忍）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { listLogFiles, logEvent, readEntries, totalBytes } from '../src/log.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

test('日志：注入 Error → 出现含 stack 的一行（可 JSON 解析、字段齐全）', () => {
  const dir = join(tempDir('log-basic'), 'logs');
  const now = new Date('2026-09-14T00:00:00Z');
  const r = logEvent({ level: 'error', where: 'unit', err: new Error('boom'), ctx: { rule: 'L461' } }, { dir, now });
  assert.equal(r.ok, true);
  assert.equal(r.path, join(dir, 'dsh-rulekeeper.log'));
  const read = readEntries(dir);
  assert.equal(read.badLines, 0);
  assert.equal(read.entries.length, 1);
  const entry = read.entries[0];
  assert.equal(entry.ts, '2026-09-14T00:00:00.000Z');
  assert.equal(entry.level, 'error');
  assert.equal(entry.err, 'boom');
  assert.match(entry.stack, /Error: boom/);
  assert.equal(entry.ctx.rule, 'L461');
});

test('日志：轮转受控 —— 文件数 ≤ maxFiles 且总量 ≤ maxFiles*(cap+单条上限)', () => {
  const dir = join(tempDir('log-rotate'), 'logs');
  const capBytes = 256;
  const maxFiles = 3;
  const now = new Date('2026-09-14T00:00:00Z');
  const sample = `${JSON.stringify({ ts: now.toISOString(), level: 'info', where: 'loop', ctx: { i: 999 } })}\n`;
  for (let i = 0; i < 100; i += 1) {
    const r = logEvent({ level: 'info', where: 'loop', ctx: { i } }, { dir, capBytes, maxFiles, now });
    assert.equal(r.ok, true);
  }
  const files = listLogFiles(dir);
  const bound = maxFiles * (capBytes + sample.length);
  assert.ok(files.length <= maxFiles, `文件数 ${files.length} 应 ≤ ${maxFiles}`);
  assert.ok(totalBytes(dir) <= bound, `总量 ${totalBytes(dir)} 应 ≤ ${bound}`);
  const read = readEntries(dir);
  assert.equal(read.badLines, 0);
  assert.ok(read.entries.length > 0);
});

test('日志 fail-safe：目录不可创建时不抛、返回 ok=false 且带 reason', () => {
  const base = tempDir('log-fail');
  const fileAsParent = join(base, 'afile');
  writeFileSync(fileAsParent, 'x', 'utf8');
  const dir = join(fileAsParent, 'sub'); // 祖先为文件 → mkdir 必失败
  let threw = false;
  let result = null;
  try {
    result = logEvent({ level: 'warn', where: 'unit', err: new Error('x') }, { dir });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, '日志失败绝不能抛（铁律 3 fail-safe）');
  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
});

test('日志：坏行容忍（尾部半行不导致整体读取失败）', () => {
  const dir = join(tempDir('log-badline'), 'logs');
  assert.equal(logEvent({ level: 'info', where: 'a' }, { dir }).ok, true);
  appendFileSync(join(dir, 'dsh-rulekeeper.log'), '{"ts":"2026-09-14T00:00:00.000Z","level":"inf', 'utf8');
  const read = readEntries(dir);
  assert.equal(read.entries.length, 1);
  assert.equal(read.badLines, 1);
});
