// dsh-rulekeeper · LF-800 **`off` 档零副作用**用例
//
// 判据：绿 = off 下跑一轮动作（记账 / 门禁台账 / 快照）→ 落点 **mtime 集合不变**（零写入）；
//   红 = 有任何写入 → 必红。正对照：observe 档同样动作**必须**写（否则"零副作用"可能是"什么都没实现"）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_MODE, MODES, isOff, landingFingerprint, offGuard, readMode } from '../src/mode.mjs';
import { record } from '../src/ledger.mjs';
import { appendGateRow } from '../src/gate.mjs';
import { takeSnapshot } from '../src/snap.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

function landingWith(label, mode) {
  const dir = tempDir(label);
  const landing = join(dir, '.dsh-ai', 'rulekeeper');
  mkdirSync(join(landing, 'logs'), { recursive: true }); // 门禁台账写入假定调用方已建目录（与 gate 自身一致）
  if (mode !== null) writeFileSync(join(landing, 'config.json'), `${JSON.stringify({ schema: 1, mode })}\n`, 'utf8');
  writeFileSync(join(dir, 'a.txt'), 'x\n', 'utf8');
  return { dir, landing };
}
const fp = (landing) => landingFingerprint(landing, { readdirSync, statSync });
const act = (dir, landing) => {
  const r1 = record({ problem: 'p', root_cause: 'c', solution: 's', verification: 'v', rule: 'R', mechanism: 'm', category: '代码', source: 's' }, { landingDir: landing });
  const r2 = appendGateRow(landing, { schema: 1, ts: 't', gate: 'close', verdict: 'pass' });
  const r3 = takeSnapshot({ projectRoot: dir, landingDir: landing, file: join(dir, 'a.txt'), now: new Date('2026-09-15T00:00:00Z'), why: 'off-test' });
  return { r1, r2, r3 };
};

test('判据: 模式读取（缺 config / 坏 JSON / 非法值 → 默认 observe，不做"静默 off"）', () => {
  const a = landingWith('mode-none', null);
  assert.equal(readMode(a.landing), DEFAULT_MODE);
  assert.equal(isOff(a.landing), false);
  const b = landingWith('mode-bad', 'whatever');
  assert.equal(readMode(b.landing), DEFAULT_MODE);
  writeFileSync(join(b.landing, 'config.json'), '{ not json', 'utf8');
  assert.equal(readMode(b.landing), DEFAULT_MODE);
  const c = landingWith('mode-off', 'off');
  assert.equal(readMode(c.landing), 'off');
  assert.equal(isOff(c.landing), true);
  assert.deepEqual([...MODES], ['observe', 'armed', 'off']);
});

test('绿（清单原文）: **off 档零副作用** —— 记账/门禁台账/快照三处都不写，mtime 集合不变', () => {
  const { dir, landing } = landingWith('off-nowrite', 'off');
  const before = fp(landing);
  const { r1, r2, r3 } = act(dir, landing);
  const after = fp(landing);
  assert.deepEqual(after, before, `off 档不许有任何写入（before=${JSON.stringify(before)} after=${JSON.stringify(after)}）`);
  assert.equal(readdirSync(landing).includes('ledger.jsonl'), false, '不许创建 ledger.jsonl');
  assert.equal(readdirSync(landing).includes('backups'), false, '不许创建 backups/');
  assert.equal(readdirSync(landing).includes('snapshots'), false, '不许创建 snapshots/');
  // 三处都"成功但跳过"（不报错：off 是合法档位，不是故障）
  assert.equal(r1.skipped, true, JSON.stringify(r1));
  assert.equal(r2.skipped, true, JSON.stringify(r2));
  assert.equal(r3.skipped, true, JSON.stringify(r3));
});

test('正对照: **observe 档同样动作必须写**（否则"零副作用"可能只是"没实现"）', () => {
  const { dir, landing } = landingWith('observe-write', 'observe');
  const before = fp(landing);
  const { r1, r2, r3 } = act(dir, landing);
  const after = fp(landing);
  assert.notDeepEqual(after, before, 'observe 档必须产生写入');
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r3.ok, true);
  assert.ok(readdirSync(landing).includes('ledger.jsonl'));
  assert.ok(readdirSync(landing).includes('snapshots'));
});

test('判据: 写入闸点名对象（供上层如实写进诊断，而不是静默 return）', () => {
  const { landing } = landingWith('mode-guard', 'off');
  const g = offGuard(landing, 'logs/gate.jsonl');
  assert.equal(g.off, true);
  assert.equal(g.allowed, false);
  assert.equal(g.finding.code, 'MODE_OFF_NO_WRITE');
  assert.match(g.finding.message, /logs\/gate\.jsonl/);
  assert.match(g.finding.message, /零副作用/);
  const ok = landingWith('mode-guard2', 'armed');
  assert.equal(offGuard(ok.landing, 'x').allowed, true);
});
