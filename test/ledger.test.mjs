// dsh-rulekeeper · LF-200 用例：ledger 核心（append-only + 派生聚合）
//
// 判据（清单 LF-200）：二次入账同 rule → **派生计数** 1→2；两进程各写 1 行 → 共 2 行
//   （"非恒真"由本文件最后一条用例保证：行内 recurrence 恒为 1，只有**派生**才得 2 —— 若实现改成
//    读行内字段，计数会错）
// 红态：用整文件 RMW → 8 进程计数必红（由 scripts/ledger-probe.mjs 的真进程对照实验给出）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  LEDGER_FILE, REQUIRED_STRING_FIELDS, deriveCounts, deriveStatus, ledgerPath, makeId,
  normalizeEntry, query, readLedger, record, recurrenceOf, summary,
} from '../src/ledger.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const base = {
  rule: 'L900', category: '技术', problem: 'p', root_cause: 'r', solution: 's', mechanism: 'text',
};

function landing(label) {
  const dir = join(tempDir(label), 'landing');
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('makeId：格式 LF-<时间戳>-<6hex>，且 100 次不撞（并发下不靠扫描）', () => {
  const now = new Date('2026-09-14T00:00:00Z');
  const ids = new Set();
  for (let i = 0; i < 100; i += 1) ids.add(makeId(now));
  assert.equal(ids.size, 100);
  for (const id of ids) assert.match(id, /^LF-\d{14}-[0-9a-f]{6}$/);
});

test('normalizeEntry：合法输入补齐 LF-120 冻结字段；缺必填 -> 报问题清单', () => {
  const okResult = normalizeEntry(base, { now: new Date('2026-09-14T00:00:00Z') });
  assert.equal(okResult.ok, true);
  const keys = Object.keys(okResult.entry).sort();
  assert.deepEqual(keys, [
    'category', 'evidence', 'first_seen', 'id', 'last_seen', 'mechanism', 'problem',
    'recurrence', 'root_cause', 'rule', 'schema', 'solution', 'status', 'ts',
  ]);
  assert.equal(okResult.entry.ts, '2026-09-14T00:00:00.000Z');
  assert.equal(okResult.entry.recurrence, 1);
  assert.equal(okResult.entry.status, 'active');
  assert.equal(okResult.entry.schema, 1);

  for (const field of REQUIRED_STRING_FIELDS) {
    const broken = normalizeEntry({ ...base, [field]: '' });
    assert.equal(broken.ok, false, `${field} 为空时应拒收`);
  }
  assert.equal(normalizeEntry(null).ok, false);
});

test('record：二次入账同 rule -> 派生计数 1 -> 2（LF-200 主判据）', () => {
  const dir = landing('l-count');
  assert.equal(record(base, { landingDir: dir }).ok, true);
  assert.equal(recurrenceOf(readLedger(dir).values, 'L900'), 1);
  assert.equal(record({ ...base, problem: 'p2' }, { landingDir: dir }).ok, true);
  assert.equal(recurrenceOf(readLedger(dir).values, 'L900'), 2);
  assert.equal(readLedger(dir).values.length, 2, '两行都在（append-only）');
});

test('record：两进程各写 1 行 -> 共 2 行（顺序等价形态；真并发见 ledger-probe）', () => {
  const dir = landing('l-two');
  record({ ...base, id: 'A1' }, { landingDir: dir });
  record({ ...base, id: 'A2' }, { landingDir: dir });
  const read = readLedger(dir);
  assert.equal(read.values.length, 2);
  assert.equal(read.badLines, 0);
  assert.deepEqual(query(read.values, { rule: 'L900' }).map((e) => e.id).sort(), ['A1', 'A2']);
});

test('非恒真：行内 recurrence 恒为 1，只有派生才能得 2', () => {
  const dir = landing('l-nonTautology');
  record(base, { landingDir: dir });
  record({ ...base, problem: 'p2' }, { landingDir: dir });
  const entries = readLedger(dir).values;
  assert.deepEqual(entries.map((e) => e.recurrence), [1, 1], '行内字段是"写入时事实"，不是聚合');
  assert.equal(deriveCounts(entries).get('L900').count, 2, '聚合必须派生');
});

test('record：缺必填字段 -> ok=false 且不落盘', () => {
  const dir = landing('l-reject');
  const r = record({ ...base, solution: '' }, { landingDir: dir });
  assert.equal(r.ok, false);
  assert.match(r.reason, /字段不合法/);
  assert.equal(existsSync(ledgerPath(dir)), false, '被拒的记录不得留下任何字节');
});

test('record：超长一行 -> ok=false（遵守 LF-160 行长上限）', () => {
  const dir = landing('l-oversize');
  const r = record({ ...base, problem: 'x'.repeat(500) }, { landingDir: dir, maxLineBytes: 64 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /超过上限/);
});

test('deriveCounts / deriveStatus：首末时间与最新状态都来自派生', () => {
  const dir = landing('l-derive');
  record({ ...base, id: 'A', ts: '2026-09-14T00:00:05.000Z', status: 'active' }, { landingDir: dir });
  record({ ...base, id: 'B', ts: '2026-09-14T00:00:01.000Z', status: 'superseded' }, { landingDir: dir });
  record({ ...base, id: 'C', ts: '2026-09-14T00:00:09.000Z', status: 'archived' }, { landingDir: dir });
  const entries = readLedger(dir).values;
  const counts = deriveCounts(entries).get('L900');
  assert.equal(counts.count, 3);
  assert.equal(counts.firstSeen, '2026-09-14T00:00:01.000Z');
  assert.equal(counts.lastSeen, '2026-09-14T00:00:09.000Z');
  assert.equal(deriveStatus(entries).get('L900').status, 'archived', '状态取 ts 最新一行');
});

test('readLedger：坏行/半行不让整体失败（复用 LF-160 的 readLines）', () => {
  const dir = landing('l-tolerance');
  record(base, { landingDir: dir });
  // 注意：**不要**在尾部补换行，否则那是"中间坏行"而不是"截断的半行"
  writeFileSync(ledgerPath(dir), `${readFileSync(ledgerPath(dir), 'utf8')}{"broken":`, 'utf8');
  let read = null;
  assert.doesNotThrow(() => { read = readLedger(dir); });
  assert.equal(read.values.length, 1);
  assert.equal(read.badLines, 1);
  assert.equal(read.truncatedTail, true, '末尾没有换行 = 半行（崩溃残留）');
});

test('summary：条目数 + 读健康 + 每条纪律的派生计数', () => {
  const dir = landing('l-summary');
  record(base, { landingDir: dir });
  record({ ...base, rule: 'L901' }, { landingDir: dir });
  const s = summary(dir);
  assert.equal(s.entries, 2);
  assert.equal(s.badLines, 0);
  assert.equal(s.totalRecurrence, 2);
  assert.deepEqual(s.rules.map((r) => [r.rule, r.count]), [['L900', 1], ['L901', 1]]);
  assert.equal(LEDGER_FILE, 'ledger.jsonl');
});
