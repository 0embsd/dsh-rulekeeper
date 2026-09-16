// dsh-rulekeeper · LF-2C0 分片 + gc + 引用完整性
//
// 判据（清单 §3 LF-2C0）：`gc --dry-run` 报告；被 evidence/proposals 引用的行**不删**；写新片→回读→删旧片。
// 红态（清单原文）：gc 删掉被引用行 → **exit≠0**。
// 另覆盖：并集读（分片后聚合不能漏数）、dry-run 不动盘、分片内也能 gc、幂等、参数错误。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runShard } from '../src/cli.mjs';
import { deriveCounts, readLedger } from '../src/ledger.mjs';
import { applyGc, collectReferencedIds, planGc, shardName, shardLedger } from '../src/shard.mjs';
import { RC } from '../src/rc.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

function capture(fn) {
  let out = '';
  let err = '';
  const rc = fn({ out: (t) => { out += String(t); }, err: (t) => { err += String(t); } });
  return { rc, out, err };
}

const shard = (args) => capture((io) => runShard(args, io, {}));

function entry({ id, ts, rule = 'RULE-A', status = 'active', evidence = [], problem = 'p' }) {
  return { schema: 1, id, ts, rule, category: '纪律', problem, root_cause: 'r', solution: 's', evidence, mechanism: 'm', recurrence: 1, first_seen: ts, last_seen: ts, status };
}

/** 造落点：config + ledger（+ 可选 proposals） */
function landing(label, entries, proposals = {}) {
  const dir = tempDir(label);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify({ schema: 1, mode: 'observe' }, null, 2)}\n`, 'utf8');
  writeFileSync(join(dir, 'ledger.jsonl'), entries.length === 0 ? '' : `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
  const pdir = join(dir, 'proposals');
  mkdirSync(pdir, { recursive: true });
  for (const [id, proposal] of Object.entries(proposals)) {
    writeFileSync(join(pdir, `${id}.json`), `${JSON.stringify({
      schema: 1, id, rule: 'RULE-A', source: 'auto', createdAt: '2026-09-14T00:00:00.000Z',
      redCriteria: 'rc', counterExample: 'ce', falsePositiveSurface: 'fp', activationCheck: 'ac', status: 'proposed',
      ...proposal,
    }, null, 2)}\n`, 'utf8');
  }
  return dir;
}

test('判据：分片"写新片 -> 回读 -> 删旧片"，且并集读不漏数', () => {
  const dir = landing('s-split', [
    entry({ id: 'L1', ts: '2026-09-10T00:00:00.000Z' }),
    entry({ id: 'L2', ts: '2026-09-10T01:00:00.000Z' }),
    entry({ id: 'L3', ts: '2026-09-11T00:00:00.000Z' }),
    entry({ id: 'L4', ts: '2026-09-14T00:00:00.000Z' }),
  ]);
  const r = shard(['split', '--landing', dir, '--now', '2026-09-14T12:00:00Z', '--keep-days', '1', '--apply']);
  assert.equal(r.rc, RC.OK, r.err + r.out);
  assert.match(r.out, /RK_SHARD_MOVED=3/);
  assert.match(r.out, /RK_SHARD_KEPT=1/);
  assert.match(r.out, /SHARD ledger-20260910\.jsonl lines=2/);
  assert.match(r.out, /SHARD ledger-20260911\.jsonl lines=1/);
  assert.match(r.out, /RK_SHARD_SOURCE_REMOVED=true/);
  assert.equal(existsSync(join(dir, 'shards', shardName('2026-09-10T00:00:00.000Z'))), true);
  // 热尾只剩 1 行；并集读仍是 4 条（**分片后聚合不能漏数**）
  const hot = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n');
  assert.equal(hot.length, 1);
  const all = readLedger(dir);
  assert.equal(all.values.length, 4);
  assert.equal(deriveCounts(all.values).get('RULE-A').count, 4);
});

test('红态：不带 --apply 时只报告不动盘（分片）', () => {
  const dir = landing('s-dry', [entry({ id: 'L1', ts: '2026-09-10T00:00:00.000Z' }), entry({ id: 'L2', ts: '2026-09-14T00:00:00.000Z' })]);
  const before = readFileSync(join(dir, 'ledger.jsonl'), 'utf8');
  const r = shard(['split', '--landing', dir, '--now', '2026-09-14T12:00:00Z', '--keep-days', '1']);
  assert.equal(r.rc, RC.OK);
  assert.match(r.out, /RK_SHARD_COLD_ONLY=true/);
  assert.match(r.out, /RK_SHARD_SOURCE_REMOVED=false/);
  assert.equal(readFileSync(join(dir, 'ledger.jsonl'), 'utf8'), before, 'dry-run 不得动原文件');
  assert.equal(existsSync(join(dir, 'shards')), false);
});

test('判据：`gc --dry-run` 报告且不动盘（逐字数字）', () => {
  const dir = landing('g-dry', [
    entry({ id: 'L1', ts: '2026-09-10T00:00:00.000Z', status: 'obsolete' }),
    entry({ id: 'L2', ts: '2026-09-10T01:00:00.000Z', status: 'superseded' }),
    entry({ id: 'L3', ts: '2026-09-11T00:00:00.000Z', status: 'active' }),
  ]);
  const before = readFileSync(join(dir, 'ledger.jsonl'), 'utf8');
  const r = shard(['gc', '--landing', dir, '--dry-run']);
  assert.equal(r.rc, RC.OK, r.out);
  assert.match(r.out, /RK_GC_MODE=dry-run/);
  assert.match(r.out, /RK_GC_LEDGER_ENTRIES=3/);
  assert.match(r.out, /RK_GC_REFERENCED=0/);
  assert.match(r.out, /RK_GC_DELETABLE=2/);
  assert.match(r.out, /RK_GC_KEPT_ACTIVE=1/);
  assert.match(r.out, /GC_DELETABLE L1 status=obsolete/);
  assert.match(r.out, /RK_GC_POST_CONDITION=pass/);
  assert.match(r.out, /RK_GC_DELETED=0/);
  assert.equal(readFileSync(join(dir, 'ledger.jsonl'), 'utf8'), before, 'dry-run 一个字节都不许动');
});

test('判据：被 proposals 四要件 / 其它行 evidence[] 引用的行**不删**', () => {
  const dir = landing('g-ref', [
    entry({ id: 'L1', ts: '2026-09-10T00:00:00.000Z', status: 'obsolete', evidence: ['.dsh-ai/verify/lf-1.txt'] }),
    entry({ id: 'L2', ts: '2026-09-10T01:00:00.000Z', status: 'obsolete' }),
    entry({ id: 'L3', ts: '2026-09-11T00:00:00.000Z', status: 'obsolete', evidence: ['见 L2 的复现步骤'] }),
    entry({ id: 'L4', ts: '2026-09-12T00:00:00.000Z', status: 'active' }),
  ], { 'P-20260914000000-aaaaaa': { counterExample: '复现见 L1（obsolete 但仍被提案引用）' } });
  const referenced = collectReferencedIds(dir);
  assert.equal(referenced.has('L1'), true, 'proposal 的四要件里提到 L1 -> L1 被引用');
  assert.equal(referenced.has('L2'), true, 'L3 的 evidence 提到 L2 -> L2 被引用');
  const plan = planGc({ landingDir: dir });
  assert.deepEqual(plan.deletableIds, ['L3'], '只有 L3 既 obsolete 又没被引用');
  assert.equal(plan.kept.referenced, 2);
  assert.match(shard(['gc', '--landing', dir, '--json']).out, /"postCondition": "pass"/);

  const applied = shard(['gc', '--landing', dir, '--apply']);
  assert.equal(applied.rc, RC.OK, applied.out);
  assert.match(applied.out, /RK_GC_DELETED=1/);
  const ids = readLedger(dir).values.map((v) => v.id);
  assert.deepEqual(ids.sort(), ['L1', 'L2', 'L4'], '被引用的 L1/L2 必须还在');
  assert.equal(ids.includes('L3'), false);
});

test('红态（清单原文）：gc 计划里含被引用行 -> exit≠0 且**什么都不删**', () => {
  const dir = landing('g-force', [
    entry({ id: 'L1', ts: '2026-09-10T00:00:00.000Z', status: 'obsolete' }),
    entry({ id: 'L2', ts: '2026-09-10T01:00:00.000Z', status: 'active' }),
  ], { 'P-20260914000000-bbbbbb': { counterExample: 'L1 是被提案引用的行' } });
  const before = readFileSync(join(dir, 'ledger.jsonl'), 'utf8');
  // 纯函数层：强制把被引用的 L1 塞进"可删"集合 -> 后置断言必须拦下
  const forced = planGc({ landingDir: dir, forceDeletable: ['L1'] });
  assert.equal(forced.postConditionOk, false);
  assert.deepEqual(forced.wouldDeleteReferenced, ['L1']);
  const refused = applyGc({ landingDir: dir, plan: forced });
  assert.equal(refused.ok, false);
  assert.equal(refused.deleted, 0);
  assert.match(refused.reasons.join(' '), /拒绝执行：计划里含被引用行 L1/);
  // CLI 层：同一路径必须 exit≠0（--force-deletable 是取证专用入口）
  const cli = shard(['gc', '--landing', dir, '--apply', '--force-deletable', 'L1']);
  assert.equal(cli.rc, RC.FAIL);
  assert.match(cli.out, /RK_GC_POST_CONDITION=fail/);
  assert.match(cli.out, /FINDING GC_WOULD_DELETE_REFERENCED/);
  assert.equal(readFileSync(join(dir, 'ledger.jsonl'), 'utf8'), before, '被拦下时不得动盘');
});

test('判据：分片里的行同样能被 gc（且分片仍是合法 JSONL）', () => {
  const dir = landing('g-shard', [
    entry({ id: 'L1', ts: '2026-09-10T00:00:00.000Z', status: 'obsolete' }),
    entry({ id: 'L2', ts: '2026-09-10T01:00:00.000Z', status: 'active' }),
    entry({ id: 'L9', ts: '2026-09-14T00:00:00.000Z', status: 'active' }),
  ]);
  assert.equal(shard(['split', '--landing', dir, '--now', '2026-09-14T12:00:00Z', '--keep-days', '1', '--apply']).rc, RC.OK);
  const shardFile = join(dir, 'shards', shardName('2026-09-10T00:00:00.000Z'));
  assert.equal(existsSync(shardFile), true);
  const r = shard(['gc', '--landing', dir, '--apply']);
  assert.equal(r.rc, RC.OK, r.out);
  assert.match(r.out, /RK_GC_DELETED=1/);
  assert.match(r.out, /GC_FILE .*ledger-20260910\.jsonl kept=1 removed=1/);
  const lines = readFileSync(shardFile, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).id, 'L2');
});

test('判据：gc 幂等（第二次无可删、不再改文件）', () => {
  const dir = landing('g-idem', [
    entry({ id: 'L1', ts: '2026-09-10T00:00:00.000Z', status: 'obsolete' }),
    entry({ id: 'L2', ts: '2026-09-11T00:00:00.000Z', status: 'active' }),
  ]);
  assert.equal(shard(['gc', '--landing', dir, '--apply']).rc, RC.OK);
  const after = readFileSync(join(dir, 'ledger.jsonl'), 'utf8');
  const again = shard(['gc', '--landing', dir, '--apply']);
  assert.equal(again.rc, RC.OK);
  assert.match(again.out, /RK_GC_DELETABLE=0/);
  assert.match(again.out, /RK_GC_DELETED=0/);
  assert.equal(readFileSync(join(dir, 'ledger.jsonl'), 'utf8'), after);
});

test('红态：回读校验失败时绝不删旧片（纯函数层用假分片目录触发）', () => {
  const dir = landing('s-verifyfail', [entry({ id: 'L1', ts: '2026-09-10T00:00:00.000Z' }), entry({ id: 'L2', ts: '2026-09-14T00:00:00.000Z' })]);
  // 把 shards 目录建成**文件**，写入必然失败 -> 必须报错且热尾不动
  writeFileSync(join(dir, 'shards'), 'not-a-dir', 'utf8');
  const before = readFileSync(join(dir, 'ledger.jsonl'), 'utf8');
  const r = shardLedger({ landingDir: dir, now: new Date('2026-09-14T12:00:00Z'), keepDays: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.sourceRemoved, false);
  assert.match(r.reasons.join(' '), /写分片失败|回读校验失败/);
  assert.equal(readFileSync(join(dir, 'ledger.jsonl'), 'utf8'), before, '失败时热尾必须保持原样');
});

test('红态：参数错误 -> rc=2（缺 --landing / 未知子命令 / --keep-days 非整数 / 非法 --now）', () => {
  const dir = landing('s-usage', []);
  assert.equal(shard(['gc', '--landing', dir, '--keep-days', 'abc']).rc, RC.OK, 'gc 不接受 --keep-days 但仍应正常跑');
  assert.equal(shard(['split', '--landing', dir, '--keep-days', 'abc']).rc, RC.USAGE);
  assert.equal(shard(['gc']).rc, RC.USAGE);
  assert.equal(shard(['bogus', '--landing', dir]).rc, RC.USAGE);
  assert.equal(shard(['gc', '--landing', join(dir, 'nope')]).rc, RC.USAGE);
  assert.equal(shard(['gc', '--landing', dir, '--now', 'nope']).rc, RC.USAGE);
  assert.equal(shard(['--help']).rc, RC.OK);
  assert.equal(shard([]).rc, RC.USAGE);
});
