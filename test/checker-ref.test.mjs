// dsh-rulekeeper · `checkerRef`（P3 反哺）用例
//
// 判据（读死再下结论）：
//   ① 规格写 `checkerRef: @self/<包内路径>` ⇒ 绑定落成**绝对路径**的 command（免项目内副本）
//   ② 引用不存在的包/路径 ⇒ `EFFECT_CHECKER_REF_MISSING`（fail-closed，绝不写"指向不存在对象"的判据）
//   ③ 形态不合法（缺包名/含 `..`）⇒ `EFFECT_CHECKER_REF_INVALID`
//   ④ 写了 checkerRef 但 command 不是 `["node","<占位>",…]` ⇒ `EFFECT_CHECKER_REF_COMMAND_SHAPE`（两者必须能核对同源）
//
// 为什么必须有这几条：`checkerRef` 的全部价值是"判据只有一份、不随项目漂移"；若引用解析失败还能落盘，
// 就等于把一个跑不起来的判据签进 rules.json —— 那正是本模块要治的"已实现未生效"。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { planActivation } from '../src/effect.mjs';
import { cleanupAll, PKG_ROOT, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

/** 造一个最小落点（rules.json 空） */
function landing(label) {
  const dir = tempDir(label);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'rules.json'), `${JSON.stringify({ schema: 1, project: 't', protected_paths: [], gates: [], checks: [], inject: [] }, null, 2)}\n`, 'utf8');
  return dir;
}

function proposalFor(rule, specRel) {
  return {
    schema: 1, id: 'P-test-checkerref', rule, source: 'human', status: 'proposed',
    createdAt: '2026-01-01T00:00:00.000Z',
    redCriteria: '红态判据（用例占位）',
    counterExample: `checker:${specRel}`,
    falsePositiveSurface: 'tree:.',
    activationCheck: 'rk-effect verify --allow-exec --proposal P-test-checkerref',
  };
}

/** 写一份规格；`overrides` 覆盖 checkerRef/command 等字段 */
function writeSpec(project, rel, overrides = {}) {
  const spec = {
    schema: 1,
    rule: 'CAT-PROC',
    command: ['node', 'scripts/checkers/does-not-matter.mjs'],
    expectRed: { exitCode: 1 },
    expectGreen: { exitCode: 0 },
    redSample: { kind: 'tree', source: 'test-fixtures/red' },
    checkerVersion: 'unit@1',
    ...overrides,
  };
  const abs = join(project, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
  return rel;
}

test('判据①: checkerRef=@self/<包内路径> ⇒ 落成绝对路径 command（免项目内副本）', () => {
  const project = tempDir('ref-ok');
  // 样本目录要真的存在（plan 会核样本），故指向包内已入库的红样本
  const specRel = writeSpec(project, 'specs/ok.spec.json', {
    checkerRef: '@self/scripts/checkers/gate-finality.mjs',
    redSample: { kind: 'tree', source: 'test-fixtures/red' },
  });
  mkdirSync(join(project, 'test-fixtures', 'red'), { recursive: true });
  const out = planActivation({
    landingDir: landing('ref-ok-landing'),
    projectRoot: project,
    proposal: proposalFor('CAT-PROC', specRel),
    now: new Date('2026-01-01T00:00:00.000Z'),
  });
  assert.equal(out.ok, true, `应当落成绑定；findings=${JSON.stringify(out.findings)}`);
  assert.equal(out.kind, 'activate-checker');
  const cmd = out.additions.binding.command;
  assert.equal(cmd[0], 'node');
  assert.equal(cmd[1], join(PKG_ROOT, 'scripts', 'checkers', 'gate-finality.mjs'), '必须解析成包内检查器的绝对路径');
  assert.equal(out.additions.binding.checkerRef, '@self/scripts/checkers/gate-finality.mjs');
});

test('判据②: 引用不存在的包/路径 ⇒ EFFECT_CHECKER_REF_MISSING（fail-closed，不落盘）', () => {
  const project = tempDir('ref-missing');
  const specRel = writeSpec(project, 'specs/missing.spec.json', { checkerRef: 'no-such-package/checkers/x.mjs' });
  const out = planActivation({
    landingDir: landing('ref-missing-landing'),
    projectRoot: project,
    proposal: proposalFor('CAT-PROC', specRel),
    now: new Date('2026-01-01T00:00:00.000Z'),
  });
  assert.equal(out.ok, false);
  assert.equal(out.findings[0].code, 'EFFECT_CHECKER_REF_MISSING');
  assert.equal(out.candidate, null, '解析失败时不得产出候选 rules.json');
});

test('判据③: checkerRef 形态不合法（缺包名段）⇒ EFFECT_CHECKER_REF_INVALID', () => {
  const project = tempDir('ref-invalid');
  const specRel = writeSpec(project, 'specs/invalid.spec.json', { checkerRef: '../escape/x.mjs' });
  const out = planActivation({
    landingDir: landing('ref-invalid-landing'),
    projectRoot: project,
    proposal: proposalFor('CAT-PROC', specRel),
    now: new Date('2026-01-01T00:00:00.000Z'),
  });
  assert.equal(out.ok, false);
  assert.equal(out.findings[0].code, 'EFFECT_CHECKER_REF_INVALID');
});

test('判据④: 写了 checkerRef 但 command 不是 ["node",…] ⇒ EFFECT_CHECKER_REF_COMMAND_SHAPE', () => {
  const project = tempDir('ref-shape');
  const specRel = writeSpec(project, 'specs/shape.spec.json', {
    checkerRef: '@self/scripts/checkers/gate-finality.mjs',
    command: ['python', 'x.py'],
  });
  const out = planActivation({
    landingDir: landing('ref-shape-landing'),
    projectRoot: project,
    proposal: proposalFor('CAT-PROC', specRel),
    now: new Date('2026-01-01T00:00:00.000Z'),
  });
  assert.equal(out.ok, false);
  assert.equal(out.findings[0].code, 'EFFECT_CHECKER_REF_COMMAND_SHAPE');
});

test('判据⑤（本仓自举）: 本仓 5 份规格都走 checkerRef，且命令都指向包内检查器', () => {
  const specs = ['test-isolation', 'gate-finality', 'adoption-contract', 'ledger-live-verdict', 'no-test-exception'];
  for (const name of specs) {
    const spec = JSON.parse(readFileSync(join(PKG_ROOT, 'scripts', 'checkers', `${name}.spec.json`), 'utf8'));
    assert.equal(spec.checkerRef, `@self/scripts/checkers/${name}.mjs`, `${name}.spec.json 必须用 checkerRef 引用包内检查器`);
    assert.deepEqual(spec.command, ['node', `scripts/checkers/${name}.mjs`], `${name}.spec.json 的 command 占位必须与 checkerRef 同源`);
  }
});
