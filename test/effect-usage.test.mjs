// dsh-rulekeeper · 用量遥测的**读者面**用例（2026-09-19，教训 L635 同族：写得出 ≠ 有人读）
//
// 判据：
//   绿 = ①`rk-effect usage` 在真投递过的落点上报出 RK_EFFECT_USAGE_* 与逐行明细（rc=0）
//        ②`rk-effect plan` 也带这三行读数（体检里直接可见，不用人肉翻文件）
//   红 = 空账落点也报"有命中"（造假读数）；或读数只写不读（本文件的存在就是这条的机械面）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { bumpUsage } from '../src/usage.mjs';
import { cleanupAll, freshLanding, ledgerEntry, PKG_ROOT } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const TS = '2026-09-19T00:00:00.000Z';
const EFFECT = join(PKG_ROOT, 'bin', 'rk-effect.mjs');

function run(args) {
  const res = spawnSync(process.execPath, [EFFECT, ...args], { cwd: PKG_ROOT, encoding: 'utf8' });
  assert.equal(res.error, undefined, `spawn 失败：${res.error?.message}`);
  return res;
}

test('判据: `rk-effect usage` 报出真实投递明细；没投递过的纪律不进表（不造假命中）', () => {
  const { landing } = freshLanding('usage-cli', {
    entries: [
      ledgerEntry({ id: 'A1', ts: TS, rule: 'CAT-CODE' }),
      ledgerEntry({ id: 'A2', ts: TS, rule: 'CAT-DOC' }),
    ],
  });
  bumpUsage(landing, { rule: 'CAT-CODE', event: 'emitted', now: new Date(TS) });
  bumpUsage(landing, { rule: 'CAT-CODE', event: 'emitted', now: new Date(TS) });
  bumpUsage(landing, { rule: 'CAT-DOC', event: 'evaluated', now: new Date(TS) });

  const res = run(['usage', '--landing', landing]);
  assert.equal(res.status, 0, `只读命令应 rc=0；stderr=${res.stderr}`);
  const out = res.stdout;
  assert.match(out, /RK_EFFECT_USAGE_RULES=2/);
  assert.match(out, /RK_EFFECT_USAGE_EMITTED=2/);
  assert.match(out, /RK_EFFECT_USAGE_EVALUATED=1/);
  assert.match(out, /RK_EFFECT_USAGE_ROW CAT-CODE emitted=2 evaluated=0/);
  assert.match(out, /RK_EFFECT_USAGE_ROW CAT-DOC emitted=0 evaluated=1/);
  assert.match(out, /RK_EFFECT_USAGE_RESULT=pass/);
  // 顺序：emitted 降序（CAT-CODE 在前）
  assert.ok(out.indexOf('CAT-CODE') < out.indexOf('CAT-DOC'), '应按 emitted 降序');

  // 反事实：空账落点必须报 0 行（否则"读数"就是恒真的装饰）
  const empty = freshLanding('usage-cli-empty', { entries: [ledgerEntry({ id: 'B1', ts: TS, rule: 'CAT-CODE' })] });
  const res2 = run(['usage', '--landing', empty.landing]);
  assert.equal(res2.status, 0);
  assert.match(res2.stdout, /RK_EFFECT_USAGE_RULES=0/);
  assert.match(res2.stdout, /RK_EFFECT_USAGE_EMITTED=0/);
  assert.match(res2.stdout, /空账/);
  assert.ok(!/RK_EFFECT_USAGE_ROW/.test(res2.stdout), '空账不得有明细行');
});

test('判据: `rk-effect plan` 也带用量读数（体检里可见，不必另跑命令）', () => {
  const { landing } = freshLanding('usage-plan', { entries: [ledgerEntry({ id: 'A1', ts: TS, rule: 'CAT-CODE' })] });
  bumpUsage(landing, { rule: 'CAT-CODE', event: 'emitted', now: new Date(TS) });
  const res = run(['plan', '--landing', landing]);
  const out = res.stdout;
  assert.match(out, /RK_EFFECT_USAGE_RULES=1/);
  assert.match(out, /RK_EFFECT_USAGE_EMITTED=1/);
  assert.match(out, /RK_EFFECT_USAGE_TOP CAT-CODE emitted=1/);
  // 用量读数不得改变体检结论（该落点未绑定 ⇒ 仍是既有 TEXT_ONLY 导致的 rc=1）
  assert.equal(res.status, 1);
  assert.match(out, /FINDING EFFECT_TEXT_ONLY error/);
});

test('判据: usage 子命令的 --json 与文本同源（同一份 usageSummary）', () => {
  const { landing } = freshLanding('usage-json', { entries: [ledgerEntry({ id: 'A1', ts: TS, rule: 'CAT-CODE' })] });
  bumpUsage(landing, { rule: 'CAT-CODE', event: 'emitted', now: new Date(TS) });
  const res = run(['usage', '--landing', landing, '--json']);
  assert.equal(res.status, 0);
  const body = res.stdout.slice(res.stdout.indexOf('{'));
  const parsed = JSON.parse(body.slice(0, body.lastIndexOf('}') + 1));
  assert.equal(parsed.totalEmitted, 1);
  assert.equal(parsed.totalEvaluated, 0);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].rule, 'CAT-CODE');
});
