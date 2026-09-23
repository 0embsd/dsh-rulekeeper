// dsh-rulekeeper · `rk-effect adopt`（P2 自动管线三段）用例
//
// 判据（读死再下结论）：
//   ① **机制面必填**：账本里出现四选一之外的 `mechanism` ⇒ 报 `ADOPT_MECHANISM_UNREGISTERED`
//      （且 rc≠0）—— "我写了机械判据"这种自称不许悄悄进账本
//   ② **可机械化类目自动出绑定草稿**：规格文件在、该 rule 没绑定、没有未决提案 ⇒ 产草稿，
//      且草稿的 `counterExample` 恰是那个规格文件（人只做签字，不重编四要件）
//   ③ **幂等**：已有未决/已批准提案 ⇒ 不重复产（E2：重复条目会把正确教训挤出 top-1）
//   ④ **事件行对象错位**：`apply` 写的 `生效登记/生效退役` 行不参与"机制面必填"判定
//      （那是工具自己的事件，`mechanism: 'rules.json'` 指"写在哪个文件"，不是机制面声明）
//   ⑤ **不写 rules.json**：runAdopt 之后 rules.json 逐字节不变（唯一写通路仍是 `rk-effect apply`）
//
// 红 = 上面任一条被放宽（例如把"未登记机制面"当 info 而不是 error、或草稿替人把四要件编出来）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { adoptionReport, scanSpecs, mechanismStats, writeDrafts } from '../src/adopt.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

/** 造一个落点：账本 + rules.json + 可选规格 */
function fixture(label, { rows = [], checks = [], specs = {} } = {}) {
  const root = tempDir(label);
  const landing = join(root, '.dsh-ai', 'rulekeeper');
  mkdirSync(landing, { recursive: true });
  writeFileSync(join(landing, 'ledger.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : ''), 'utf8');
  writeFileSync(join(landing, 'rules.json'), `${JSON.stringify({ schema: 1, project: 'adopt-t', protected_paths: [], gates: [], checks, inject: [] }, null, 2)}\n`, 'utf8');
  for (const [rel, spec] of Object.entries(specs)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
  }
  return { root, landing };
}

const baseRow = (over = {}) => ({
  schema: 1, id: over.id ?? 'L-T1', ts: '2026-01-01T00:00:00.000Z', rule: over.rule ?? 'CAT-X',
  category: over.category ?? '技术', problem: 'p', root_cause: 'r', solution: 's',
  mechanism: over.mechanism ?? 'text', evidence: [], recurrence: 1,
  first_seen: '2026-01-01T00:00:00.000Z', last_seen: '2026-01-01T00:00:00.000Z', status: 'active',
});

const specFor = (rule, redSample = 'test-fixtures/red') => ({
  schema: 1, rule, command: ['node', 'scripts/checkers/x.mjs'],
  expectRed: { exitCode: 1 }, expectGreen: { exitCode: 0 },
  redSample: { kind: 'tree', source: redSample }, checkerVersion: 'x@1',
});

test('判据①: 机制面四选一之外的取值 ⇒ ADOPT_MECHANISM_UNREGISTERED（error 级）', () => {
  const { root, landing } = fixture('adopt-face', {
    rows: [baseRow({ mechanism: 'text-only' }), baseRow({ id: 'L-T2', mechanism: 'mechanized' })],
  });
  const rep = adoptionReport({ landingDir: landing, projectRoot: root });
  assert.equal(rep.ok, true);
  const bad = rep.findings.filter((f) => f.code === 'ADOPT_MECHANISM_UNREGISTERED');
  assert.equal(bad.length, 1, `应当恰报 1 条未登记；实得 ${JSON.stringify(rep.findings)}`);
  assert.equal(bad[0].rule, 'CAT-X');
  assert.equal(rep.stats.faceCount.unregistered, 1);
  assert.equal(rep.stats.faceCount.mechanized, 1);
});

test('判据②: 规格在、未绑定、无未决提案 ⇒ 自动出草稿，counterExample 恰是该规格', () => {
  const { root, landing } = fixture('adopt-draft', {
    rows: [baseRow({ mechanism: 'text' })],
    specs: { 'scripts/checkers/catx.spec.json': specFor('CAT-X') },
  });
  const rep = adoptionReport({ landingDir: landing, projectRoot: root });
  assert.equal(rep.stats.drafts, 1, `应当出 1 份草稿；plans=${JSON.stringify(rep.plans)}`);
  const d = rep.drafts[0];
  assert.equal(d.rule, 'CAT-X');
  assert.equal(d.proposal.counterExample, 'checker:scripts/checkers/catx.spec.json');
  // 四要件**从规格派生**：命令与退出码必须真的出现在 redCriteria 里（不是空话）
  assert.match(d.proposal.redCriteria, /scripts\/checkers\/x\.mjs/);
  assert.match(d.proposal.redCriteria, /退出码必须为 1/);
  assert.equal(d.proposal.status, 'proposed', '草稿只能是 proposed（不许自动 approved）');
  assert.equal(d.proposal.source, 'auto');
});

test('判据③（幂等）: 已有未决提案 ⇒ 不重复产草稿', () => {
  const { root, landing } = fixture('adopt-idem', {
    rows: [baseRow({ mechanism: 'text' })],
    specs: { 'scripts/checkers/catx.spec.json': specFor('CAT-X') },
  });
  const first = writeDrafts(landing, adoptionReport({ landingDir: landing, projectRoot: root }).drafts);
  assert.equal(first.written.length, 1);
  const rep2 = adoptionReport({ landingDir: landing, projectRoot: root });
  assert.equal(rep2.stats.drafts, 0, '第二次不应再产草稿');
  assert.equal(rep2.plans.find((p) => p.rule === 'CAT-X').decision, 'open-proposal');
  const second = writeDrafts(landing, rep2.drafts);
  assert.equal(second.written.length, 0);
});

test('判据④（对象错位）: 生效登记/生效退役事件行不参与机制面必填判定', () => {
  const { root, landing } = fixture('adopt-event', {
    rows: [
      baseRow({ mechanism: 'text' }),
      baseRow({ id: 'LF-EV-1', category: '生效登记', mechanism: 'rules.json' }),
      baseRow({ id: 'LF-EV-2', category: '生效退役', mechanism: 'rules.json' }),
    ],
  });
  const rep = adoptionReport({ landingDir: landing, projectRoot: root });
  assert.deepEqual(rep.findings.filter((f) => f.code === 'ADOPT_MECHANISM_UNREGISTERED'), [], '事件行不该被报未登记机制面');
  assert.equal(rep.stats.eventRows, 2, '事件行要**计数并打印**（不是静默丢弃）');
  assert.equal(rep.stats.entries, 1, '教训条目数不含事件行');
});

test('判据⑤: adopt 不写 rules.json（逐字节不变）', () => {
  const { root, landing } = fixture('adopt-nowrite', {
    rows: [baseRow({ mechanism: 'text' })],
    specs: { 'scripts/checkers/catx.spec.json': specFor('CAT-X') },
  });
  const rulesPath = join(landing, 'rules.json');
  const before = readFileSync(rulesPath);
  writeDrafts(landing, adoptionReport({ landingDir: landing, projectRoot: root }).drafts);
  assert.deepEqual(readFileSync(rulesPath), before, 'rules.json 不得被 adopt 改动一个字节');
});

test('判据⑥: scanSpecs 只认规格自己的 rule 字段（非规格形状的 JSON 如实记账，不静默跳过）', () => {
  const { root } = fixture('adopt-specs', {
    specs: {
      'scripts/checkers/ok.spec.json': specFor('CAT-OK'),
      'scripts/checkers/norule.spec.json': { schema: 1, command: ['node', 'x.mjs'] },
    },
  });
  const { specs, findings, skipped } = scanSpecs(root);
  assert.equal(specs.length, 1);
  assert.equal(specs[0].rule, 'CAT-OK');
  // P21 起：缺 rule 的文件从"报 finding"改为"进 skipped 读数并写明理由"
  // （它确实不是规格，不是坏规格；两种处置都必须**看得见**，不许静默 0 条）
  assert.equal(findings.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /不是规格形状/);
});

// ── P21：认对方命名（`tools/rulekeeper/checkers/*.json`）+ "账本自称 vs 实际已绑"两个数分开 ──────
// 现场（2026-09-23，被治理项目实测）：他们落点 `adopt` 报 `mechanized=0 ALREADY_BOUND=0`，
// 同日 `plan` 报 `VERIFIED=4` ⇒ 两个读数被读成"互相矛盾"。根因：`scanSpecs` 只认 `*.spec.json`，
// 而他们的规格叫 `tools/rulekeeper/checkers/gate-discipline-hooks.json` ⇒ 一个都扫不到。

test('P21①: `tools/rulekeeper/checkers/*.json`（无 `.spec.json` 后缀）必须被当规格扫到', () => {
  const { root } = fixture('p21-naming', {
    specs: {
      'tools/rulekeeper/checkers/gate-discipline-hooks.json': specFor('GATE-DISCIPLINE', 'tools/rulekeeper/red'),
      'tools/rulekeeper/checkers/catproc-adoption.json': specFor('CAT-PROC', 'tools/rulekeeper/red'),
    },
  });
  const { specs, skipped } = scanSpecs(root);
  assert.equal(specs.length, 2, `两种命名都必须认；实得 ${JSON.stringify(specs.map((s) => s.rel))}`);
  assert.deepEqual(specs.map((s) => s.rule).sort(), ['CAT-PROC', 'GATE-DISCIPLINE']);
  assert.equal(skipped.length, 0);
});

test('P21②: 同目录里的**非规格** JSON（数据/清单）必须进 skipped 且写明理由，不当规格也不静默', () => {
  const { root } = fixture('p21-nonspec', {
    specs: {
      'tools/rulekeeper/checkers/ok.json': specFor('CAT-PROC'),
      'tools/rulekeeper/mechanism-face-registry.json': { schema: 1, faces: ['text', 'mechanized'] },
    },
  });
  const { specs, skipped } = scanSpecs(root);
  assert.equal(specs.length, 1);
  assert.equal(skipped.length, 0, 'registry 不在 checkers/ 目录里 ⇒ 不属于本扫描面（目录边界即口径）');
  const { skipped: skipped2 } = scanSpecs(root, { dirs: ['tools/rulekeeper'] });
  assert.equal(skipped2.length >= 1, true, '把目录放宽到 tools/rulekeeper 时，registry 必须被如实记为"不是规格形状"');
});

test('P21③: 报告必须**分开**给出"账本自称"与"实际已绑"，且后者来自 rules.json', () => {
  const { root, landing } = fixture('p21-two-numbers', {
    rows: [baseRow({ rule: 'CAT-PROC', mechanism: 'mechanized' })],
    checks: [{ kind: 'checker', rule: 'CAT-PROC', carrier: 'checker:tools/rulekeeper/checkers/ok.json', gate: 'close', patterns: [] }],
    specs: { 'tools/rulekeeper/checkers/ok.json': specFor('CAT-PROC') },
  });
  const rep = adoptionReport({ landingDir: landing, projectRoot: root });
  // 账本自称：1 条 mechanized；实际已绑：rules.json 里 1 条 checker 绑定 —— 两个数**分别**可读
  assert.equal(rep.stats.faceCount.mechanized, 1, '账本自称');
  assert.equal(rep.stats.boundCheckerRules, 1, '实际已绑（checker 类）');
  assert.equal(rep.stats.boundChecks, 1, '实际已绑（checks 条数）');
  assert.equal(rep.stats.boundRules, 1);
  assert.equal(rep.plans[0].decision, 'already-bound', '已有绑定 ⇒ 不再出草稿（也不该被读成"没绑"）');
});


test('判据⑦: mechanismStats 把空 mechanism 记成「(空)」而不是当合法档', () => {
  const byRule = mechanismStats([baseRow({ mechanism: '' })]);
  const info = byRule.get('CAT-X');
  assert.equal(info.entries, 1);
  assert.deepEqual([...info.faces.keys()], ['(空)']);
});
