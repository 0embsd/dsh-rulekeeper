// dsh-rulekeeper · P0-2 **条目级可判激活条件**用例（LF-A91，2026-09-19）
//
// 判据：
//   绿 = ①`activationOf()`：合法字符串 ⇒ 原样（trim）；空白/占位符/非字符串/非对象 ⇒ `''`
//        ②`ledgerGroups()` 按 canonical rule 统计 `withActivation`（占位符不算）
//        ③`effectPlan()` 给出 `entryStats`（entries/withActivation/withoutActivation/coverage）
//          与条目级 `entriesWithActivation`/`activationCoverage`
//        ④全条目都有条件 ⇒ **不产生** EFFECT_ENTRY_NO_ACTIVATION；有人缺 ⇒ 产生（severity=info）
//        ⑤该 finding 是 `info` ⇒ **不得改变** `plan.ok`（口径补充不是新增阻断）
//        ⑥CLI `rk-effect plan` 真的打印 `RK_EFFECT_ENTRY_ACTIVATION=M/N` 与 COVERAGE（端到端）
//   红 = 占位符被当成有效条件；或 info finding 把 plan.ok 拉红；或 CLI 不输出新口径
//
// 来历：06 Hermes 深读指出"生效语义挂类目层是结构性错误"，E1 实验指出"缺的是原料"——
// 本用例把"有没有一条可判条件"钉成可机械统计的事实。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACTIVATION_PLACEHOLDERS, activationOf, effectPlan, ledgerGroups } from '../src/effect.mjs';
import { record } from '../src/ledger.mjs';
import { cleanupAll, freshLanding, ledgerEntry } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const TS = '2026-09-19T00:00:00.000Z';
const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('判据: activationOf 语义（合法/空白/占位符/非字符串/非对象）', () => {
  assert.equal(activationOf({ activation: '改动 internal/**/*.go 时必须留 pre-image' }), '改动 internal/**/*.go 时必须留 pre-image');
  assert.equal(activationOf({ activation: '  前后空白  ' }), '前后空白', '应 trim');
  assert.equal(activationOf({ activation: '   ' }), '', '纯空白 = 没有条件');
  assert.equal(activationOf({ activation: '' }), '');
  assert.equal(activationOf({}), '', '缺字段 = 没有条件');
  assert.equal(activationOf({ activation: 123 }), '', '非字符串 = 没有条件');
  assert.equal(activationOf(null), '');
  assert.equal(activationOf([]), '');
  for (const p of ACTIVATION_PLACEHOLDERS) {
    assert.equal(activationOf({ activation: p }), '', `占位符 ${p} 不得算有效条件`);
    assert.equal(activationOf({ activation: p.toUpperCase() }), '', `占位符大小写不敏感：${p}`);
  }
});

test('判据: ledgerGroups 统计 withActivation（占位符不计）', () => {
  const { landing } = freshLanding('p02-groups', {
    entries: [
      ledgerEntry({ id: 'A1', ts: TS, rule: 'CAT-CODE', activation: '改动 *.go 时必须留证' }),
      ledgerEntry({ id: 'A2', ts: TS, rule: 'CAT-CODE' }),
      ledgerEntry({ id: 'A3', ts: TS, rule: 'CAT-CODE', activation: '待补' }),
      ledgerEntry({ id: 'B1', ts: TS, rule: 'CAT-DOC', activation: '改动 docs/** 时须留证' }),
    ],
  });
  const g = ledgerGroups(landing);
  assert.equal(g.get('CAT-CODE').count, 3);
  assert.equal(g.get('CAT-CODE').withActivation, 1, '只有 1 条是真条件（另 1 条缺、1 条占位）');
  assert.equal(g.get('CAT-DOC').withActivation, 1);
});

test('判据: effectPlan 给出条目级口径（entryStats + items 字段），且 info finding 不改 ok', () => {
  const { landing } = freshLanding('p02-plan', {
    entries: [
      ledgerEntry({ id: 'A1', ts: TS, rule: 'CAT-CODE', activation: '改动 *.go 时必须留证' }),
      ledgerEntry({ id: 'A2', ts: TS, rule: 'CAT-CODE' }),
      ledgerEntry({ id: 'B1', ts: TS, rule: 'CAT-DOC', activation: '改动 docs/** 时须留证' }),
    ],
  });
  const plan = effectPlan({ landingDir: landing, now: new Date(TS) });
  assert.equal(plan.entryStats.entries, 3);
  assert.equal(plan.entryStats.withActivation, 2);
  assert.equal(plan.entryStats.withoutActivation, 1);
  assert.ok(Math.abs(plan.entryStats.coverage - 0.6667) < 0.001, `coverage≈0.6667（实得 ${plan.entryStats.coverage}）`);
  const item = plan.items.find((i) => i.rule === 'CAT-CODE');
  assert.equal(item.entries, 2);
  assert.equal(item.entriesWithActivation, 1);
  assert.equal(item.activationCoverage, 0.5);
  const f = plan.findings.find((x) => x.code === 'EFFECT_ENTRY_NO_ACTIVATION');
  assert.ok(f, '有条目缺条件 ⇒ 必须产生 EFFECT_ENTRY_NO_ACTIVATION');
  assert.equal(f.severity, 'info', '口径补充取 info：不得改 ok / exit code');
  // "不改 ok" 的正确表达：新 finding **不在 error 集**里。
  // （本落点未绑定 ⇒ 既有 EFFECT_TEXT_ONLY(error) 本来就让 ok=false，与本改动无关。）
  const errorCodes = plan.findings.filter((x) => x.severity === 'error').map((x) => x.code);
  assert.ok(errorCodes.includes('EFFECT_TEXT_ONLY'), '未绑定纪律应产生既有的 TEXT_ONLY(error)');
  assert.ok(!errorCodes.includes('EFFECT_ENTRY_NO_ACTIVATION'), '新 finding 不得进入 error 集 ⇒ 不影响 ok');
});

test('判据: 全条目都有可判条件 ⇒ 不产生该 finding（不刷提示）', () => {
  const { landing } = freshLanding('p02-all', {
    entries: [
      ledgerEntry({ id: 'A1', ts: TS, rule: 'CAT-CODE', activation: '改动 *.go 时必须留证' }),
      ledgerEntry({ id: 'B1', ts: TS, rule: 'CAT-DOC', activation: '改动 docs/** 时须留证' }),
    ],
  });
  const plan = effectPlan({ landingDir: landing, now: new Date(TS) });
  assert.equal(plan.entryStats.coverage, 1);
  assert.ok(!plan.findings.some((x) => x.code === 'EFFECT_ENTRY_NO_ACTIVATION'), '全有条件时不得提示');
});

test('判据: 空落点不炸（entryStats 全 0，不产生该 finding）', () => {
  const { landing } = freshLanding('p02-empty', { entries: [] });
  const plan = effectPlan({ landingDir: landing, now: new Date(TS) });
  assert.deepEqual(plan.entryStats, { entries: 0, withActivation: 0, withoutActivation: 0, coverage: 0 });
  assert.ok(!plan.findings.some((x) => x.code === 'EFFECT_ENTRY_NO_ACTIVATION'));
});

test('判据（写入→统计闭环）: record() 带 activation 的行必须被 entryStats 数到（写入面不得丢字段）', () => {
  const { landing } = freshLanding('p02-writeread', { entries: [] });
  const base = { category: '纪律', problem: 'p', root_cause: 'r', solution: 's', mechanism: 'm', evidence: [] };
  // ① 带可判激活条件
  const a = record({ ...base, rule: 'CAT-CODE', activation: '  改动 *.go 时必须留 pre-image  ' }, { landingDir: landing });
  assert.equal(a.ok, true, `record 应成功：${JSON.stringify(a)}`);
  assert.equal(a.entry.activation, '改动 *.go 时必须留 pre-image', 'normalizeEntry 不得丢 activation，且应 trim');
  // ② 不带条件（旧形态）
  const b = record({ ...base, rule: 'CAT-CODE', problem: 'p2' }, { landingDir: landing });
  assert.equal(b.ok, true);
  assert.ok(!('activation' in b.entry), '未给条件时不得凭空造字段（保持旧行形状）');
  // ③ 空白值也不入库
  const c = record({ ...base, rule: 'CAT-CODE', problem: 'p3', activation: '   ' }, { landingDir: landing });
  assert.equal(c.ok, true);
  assert.ok(!('activation' in c.entry), '纯空白不得入库');

  const plan = effectPlan({ landingDir: landing, now: new Date(TS) });
  assert.equal(plan.entryStats.entries, 3, '三条都应进账本');
  assert.equal(plan.entryStats.withActivation, 1, '只有 1 条真条件 ⇒ 闭环：写入面不丢字段');
  assert.equal(plan.entryStats.coverage, 0.3333);
});

test('判据（端到端）: CLI `rk-effect plan` 打印新口径行', () => {
  const { landing } = freshLanding('p02-cli', {
    entries: [
      ledgerEntry({ id: 'A1', ts: TS, rule: 'CAT-CODE', activation: '改动 *.go 时必须留证' }),
      ledgerEntry({ id: 'A2', ts: TS, rule: 'CAT-CODE' }),
    ],
  });
  const res = spawnSync(process.execPath, [join(PKG_ROOT, 'bin', 'rk-effect.mjs'), 'plan', '--landing', landing], {
    cwd: PKG_ROOT, encoding: 'utf8',
  });
  assert.equal(res.error, undefined, `spawn 失败：${res.error?.message}`);
  const out = res.stdout ?? '';
  // rc 说明：该落点的纪律**没有绑定** ⇒ 既有的 `EFFECT_TEXT_ONLY`（severity=error）本就让它 rc=1。
  // 本用例要证明的是**新 finding 没有把 rc 拉红**——所以同时断言 rc=1 的原因是 TEXT_ONLY、
  // 而不是我们新加的 EFFECT_ENTRY_NO_ACTIVATION（它必须是 info）。
  assert.equal(res.status, 1, `该落点因未绑定纪律应 rc=1。stderr=${res.stderr}`);
  assert.match(out, /FINDING EFFECT_TEXT_ONLY error/, 'rc=1 的原因应是既有的 TEXT_ONLY（error）');
  assert.match(out, /FINDING EFFECT_ENTRY_NO_ACTIVATION info/, '新 finding 必须是 info（不得成为阻断原因）');
  assert.ok(!/FINDING EFFECT_ENTRY_NO_ACTIVATION error/.test(out), '新 finding 绝不允许是 error');
  assert.match(out, /RK_EFFECT_ENTRY_ACTIVATION=1\/2/, `应打印 1/2；实际输出：\n${out}`);
  assert.match(out, /RK_EFFECT_ENTRY_COVERAGE=50\.00/, '应打印覆盖率 50.00');
});
