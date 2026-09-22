// dsh-rulekeeper · **换绑**（supersede）用例 —— 判据演进不该只有"手改 rules.json"一条路
//
// 现场（2026-09-22，被治理项目当场撞到）：本仓把 `byte-discipline` 从 @1 改到 @2（扫描面从
// "文件系统"收敛为 `git ls-files`），要重新落绑定 ⇒ 撞上 `EFFECT_CHECKER_ALREADY_BOUND`。
// 而**退役通路只支持"整条纪律摘空"**（RETIRE_MARK 会把该 rule 的 checks 全摘）⇒ 要么永远绑着旧判据、
// 要么留一段"这条纪律没人守"的空窗。唯一出路是手改 `rules.json` —— 正是"闸门不可被 AI 直接改"
// 这条声明存在的理由。故补一条**换绑**通路：同一条纪律、不中断保护、逐条留证。
//
// 判据（读死再下结论）：
//   ① 声明齐备且点名换掉哪一个 ⇒ 草案里旧绑定被摘、新绑定加入，`additions.superseded` 指认旧身份
//   ② **没声明** ⇒ 仍然拒绝（不许因为"实现换绑"就把原来的护栏拆了）
//   ③ 声明不完整（缺理由/没点名）⇒ 拒绝，且**不落盘**
//   ④ 点名对不上现有绑定 ⇒ `EFFECT_SUPERSEDE_TARGET_MISSING`（换错对象是静默的，必须 fail-closed）
//   ⑤ 端到端：apply 后 `rules.json` 该 rule **恰有一条**绑定（新 spec）；
//      账本多出 `生效登记`（带 superseded=）+ `生效退役` 两行；同 rule 的**文件载体绑定不受影响**
//   ⑥ plan 语义：换绑之后该纪律**不得**被读成 retired（旧绑定退场 ≠ 整条纪律退场）
//
// 红态：把 ②③④ 任一条放宽（缺声明也放行 / 点名对不上也照换）⇒ 对应用例必红。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  EFFECT_RETIRE_CATEGORY, SUPERSEDE_MARK, applyActivation, effectPlan, planActivation, ruleBindings,
  supersedeDeclarationOf,
} from '../src/effect.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';
import { assertProposalShape, validateProposalValues } from '../src/proposal.mjs';

test.after(cleanupAll);

const RULE = 'CAT-CODE';
const OLD_SPEC = 'scripts/checkers/byte-discipline.spec.json';

/** 造现场：落点（已有一条 checker 绑定）+ 项目根（规格与红样本齐备） */
function scene(label, { withExisting = true } = {}) {
  const project = tempDir(`${label}-proj`);
  const landing = join(project, '.dsh-ai', 'rulekeeper');
  mkdirSync(landing, { recursive: true });
  mkdirSync(join(project, 'scripts', 'checkers'), { recursive: true });
  mkdirSync(join(project, 'test-fixtures', 'byte-red'), { recursive: true });
  writeFileSync(join(project, 'test-fixtures', 'byte-red', 'mixed.txt'), 'a\r\nb\n', 'utf8');
  writeFileSync(join(project, OLD_SPEC), `${JSON.stringify({
    schema: 1, rule: RULE, command: ['node', 'scripts/checkers/byte-discipline.mjs'],
    expectRed: { exitCode: 1 }, expectGreen: { exitCode: 0 },
    redSample: { kind: 'tree', source: 'test-fixtures/byte-red' },
    checkerVersion: 'byte-discipline@2',
  }, null, 2)}\n`, 'utf8');
  const checks = withExisting
    ? [{
      kind: 'checker', rule: RULE, spec: OLD_SPEC,
      command: ['node', 'scripts/checkers/byte-discipline.mjs'],
      expectRed: { exitCode: 1 }, expectGreen: { exitCode: 0 },
      redSample: { kind: 'tree', source: 'test-fixtures/byte-red' },
      checkerVersion: 'byte-discipline@1', proposal: 'P-old', activatedAt: '2026-01-01T00:00:00.000Z',
    }, {
      // 同一条纪律的**文件载体**绑定：换绑 checker 时**不许**被顺手摘掉（那是"换绑"变"拆台"）
      kind: 'file_untracked_change', rule: RULE, carrier: 'src/a.mjs', gate: 'pre-commit', patterns: ['src/a.mjs'],
    }]
    : [];
  writeFileSync(join(landing, 'rules.json'), `${JSON.stringify({
    schema: 1, project: 'demo', protected_paths: ['src/a.mjs'], gates: [], checks, inject: [],
  }, null, 2)}\n`, 'utf8');
  writeFileSync(join(landing, 'config.json'), `${JSON.stringify({ schema: 1, mode: 'observe' }, null, 2)}\n`, 'utf8');
  writeFileSync(join(landing, 'ledger.jsonl'), '', 'utf8');
  mkdirSync(join(landing, 'proposals'), { recursive: true });
  return { project, landing };
}

function proposalFor(rule, { id = 'P-20260922-sup-1', redCriteria = '红态判据（用例占位，够长以避免质量门误判）', supersedes, status = 'proposed' } = {}) {
  return {
    schema: 1, id, rule, source: 'human', status, createdAt: '2026-09-22T00:00:00.000Z',
    redCriteria,
    counterExample: `checker:${OLD_SPEC}`,
    falsePositiveSurface: 'tree:.',
    activationCheck: `rk-effect verify --allow-exec --proposal ${id}`,
    ...(supersedes === undefined ? {} : { supersedes }),
  };
}

const DECL = { spec: OLD_SPEC, reason: '扫描面从文件系统收敛为 git ls-files（下游迭代失控）' };

test('判据①: 声明齐备 + 点名旧绑定 ⇒ 草案摘旧加新，并指认 superseded 身份', () => {
  const { project, landing } = scene('sup-ok');
  const out = planActivation({
    landingDir: landing, projectRoot: project,
    proposal: proposalFor(RULE, { redCriteria: `${SUPERSEDE_MARK} 换绑：判据演进`, supersedes: DECL }),
    now: new Date('2026-09-22T00:00:00.000Z'),
  });
  assert.equal(out.ok, true, `应当允许换绑；findings=${JSON.stringify(out.findings)}`);
  assert.equal(out.kind, 'activate-checker');
  assert.equal(out.additions.superseded.identity, OLD_SPEC, '必须指认被换掉的旧绑定');
  assert.equal(out.additions.superseded.proposal, 'P-old', '旧绑定的来源提案也要留证（审计"谁签的"）');
  assert.equal(out.additions.superseded.supersededReason, DECL.reason);
  const checks = out.candidate.checks;
  const checkers = checks.filter((c) => c.kind === 'checker');
  assert.equal(checkers.length, 1, '同一纪律的 checker 绑定必须恰好一条（摘旧 + 加新）');
  assert.equal(checkers[0].checkerVersion, 'byte-discipline@2', '留下的必须是新版本');
  assert.equal(checks.filter((c) => c.kind === 'file_untracked_change').length, 1, '同 rule 的文件载体绑定不许被顺手摘掉');
});

test('判据②（护栏不许被拆）: 没写换绑声明 ⇒ 仍然拒绝，且给出两条合法路径', () => {
  const { project, landing } = scene('sup-nodecl');
  const out = planActivation({ landingDir: landing, projectRoot: project, proposal: proposalFor(RULE) });
  assert.equal(out.ok, false);
  const codes = out.findings.map((f) => f.code);
  assert.ok(codes.includes('EFFECT_CHECKER_ALREADY_BOUND'), JSON.stringify(out.findings));
  const msg = out.findings.find((f) => f.code === 'EFFECT_CHECKER_ALREADY_BOUND').message;
  assert.match(msg, /EFFECT_SUPERSEDE/, '必须告诉人换绑的标记怎么写');
  assert.match(msg, /EFFECT_RETIRE_CANDIDATE/, '另一条合法路径（整条退役）也要说清');
});

test('判据③: 声明不完整（缺理由 / 没点名）⇒ 拒绝（fail-closed）', () => {
  const { project, landing } = scene('sup-bad-decl');
  const noReason = planActivation({
    landingDir: landing, projectRoot: project,
    proposal: proposalFor(RULE, { redCriteria: `${SUPERSEDE_MARK} 换绑`, supersedes: { spec: OLD_SPEC, reason: '换' } }),
  });
  assert.equal(noReason.ok, false);
  assert.ok(noReason.findings.some((f) => f.code === 'EFFECT_SUPERSEDE_DECLARATION_INVALID'), JSON.stringify(noReason.findings));

  const noTarget = planActivation({
    landingDir: landing, projectRoot: project,
    proposal: proposalFor(RULE, { redCriteria: `${SUPERSEDE_MARK} 换绑`, supersedes: { reason: '扫描面收敛，需要换一版判据' } }),
  });
  assert.equal(noTarget.ok, false);
  assert.ok(noTarget.findings.some((f) => f.code === 'EFFECT_SUPERSEDE_DECLARATION_INVALID'), JSON.stringify(noTarget.findings));
});

test('判据④: 点名对不上现有绑定 ⇒ EFFECT_SUPERSEDE_TARGET_MISSING（换错对象是静默的）', () => {
  const { project, landing } = scene('sup-wrong-target');
  const out = planActivation({
    landingDir: landing, projectRoot: project,
    proposal: proposalFor(RULE, {
      redCriteria: `${SUPERSEDE_MARK} 换绑`,
      supersedes: { spec: 'scripts/checkers/another.spec.json', reason: '换一个其实不存在的绑定' },
    }),
  });
  assert.equal(out.ok, false);
  const f = out.findings.find((x) => x.code === 'EFFECT_SUPERSEDE_TARGET_MISSING');
  assert.ok(f !== undefined, JSON.stringify(out.findings));
  assert.match(f.message, /byte-discipline\.spec\.json/, '必须把"现有的是什么"如实告诉人');
});

test('判据⑤（端到端）: apply 后 rules.json 恰一条 checker 绑定，账本有生效登记 + 生效退役两行', () => {
  const { project, landing } = scene('sup-e2e');
  const proposal = proposalFor(RULE, { redCriteria: `${SUPERSEDE_MARK} 换绑：扫描面收敛`, supersedes: DECL });
  writeFileSync(join(landing, 'proposals', 'P-20260922-sup-1.json'), `${JSON.stringify(proposal, null, 2)}\n`, 'utf8');
  const done = applyActivation({
    landingDir: landing, projectRoot: project, proposalId: proposal.id, by: 'human', apply: true,
    now: new Date('2026-09-22T00:00:00.000Z'),
  });
  assert.equal(done.ok, true, done.message ?? JSON.stringify(done.findings ?? []));

  const rules = JSON.parse(readFileSync(join(landing, 'rules.json'), 'utf8'));
  const checkers = rules.checks.filter((c) => c.kind === 'checker' && c.rule === RULE);
  assert.equal(checkers.length, 1);
  assert.equal(checkers[0].checkerVersion, 'byte-discipline@2');
  assert.equal(rules.checks.filter((c) => c.kind === 'file_untracked_change').length, 1, '换绑不许碰别的绑定');

  const rows = readFileSync(join(landing, 'ledger.jsonl'), 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
  const activates = rows.filter((r) => r.category === '生效登记');
  const retires = rows.filter((r) => r.category === EFFECT_RETIRE_CATEGORY);
  assert.equal(activates.length, 1, '新绑定必须有一条生效登记');
  assert.match(`${activates[0].solution}\n${activates[0].root_cause}`, /superseded=/, '生效登记行必须指认被换掉的旧绑定（`problem` 是事件摘要、指认在 solution/root_cause 里）');
  assert.equal(retires.length, 1, '旧绑定的退场必须单独留一条退役行（否则"它什么时候不再拦"查不到）');
  assert.match(retires[0].problem, /EFFECT_RETIRE/);
  assert.match(retires[0].problem, /byte-discipline\.spec\.json/);
});

test('判据⑥: 换绑之后该纪律**不得**被读成 retired（旧绑定退场 ≠ 整条纪律退场）', () => {
  const { project, landing } = scene('sup-plan-state');
  const proposal = proposalFor(RULE, { redCriteria: `${SUPERSEDE_MARK} 换绑：扫描面收敛`, supersedes: DECL });
  writeFileSync(join(landing, 'proposals', 'P-20260922-sup-1.json'), `${JSON.stringify(proposal, null, 2)}\n`, 'utf8');
  assert.equal(applyActivation({
    landingDir: landing, projectRoot: project, proposalId: proposal.id, by: 'human', apply: true,
    now: new Date('2026-09-22T00:00:00.000Z'),
  }).ok, true);
  const plan = effectPlan({ landingDir: landing, projectRoot: project, now: new Date('2026-09-22T01:00:00.000Z') });
  const item = plan.items.find((i) => i.rule === RULE);
  assert.ok(item !== undefined, JSON.stringify(plan.items.map((i) => i.rule)));
  assert.notEqual(item.state, 'retired', '判据明明还在守；把换绑读成退役会让它从体检里消失');
  // 载体口径：新绑定的载体是 redSample（`carrierOfBinding` 的单一权威源）⇒ 必须能被读出来
  const carriers = ruleBindings(JSON.parse(readFileSync(join(landing, 'rules.json'), 'utf8'))).get(RULE).checks
    .map((c) => c.spec ?? c.carrier).filter((x) => x !== null);
  assert.ok(carriers.includes(OLD_SPEC), `绑定身份必须仍可读: ${JSON.stringify(carriers)}`);
});

test('判据⑦: 声明解析器本身——非对象 / 缺 sup 键 / 空理由都要被点名', () => {
  assert.deepEqual(supersedeDeclarationOf({ redCriteria: '普通提案' }).declared, false);
  assert.ok(supersedeDeclarationOf({ redCriteria: SUPERSEDE_MARK, supersedes: 'path:x' }).problems.length > 0, '字符串声明必须被拒');
  assert.ok(supersedeDeclarationOf({ redCriteria: SUPERSEDE_MARK }).problems.length > 0, '声明标记在但缺 supersedes 必须被拒');
  const ok = supersedeDeclarationOf({ redCriteria: `前缀 ${SUPERSEDE_MARK} 后缀`, supersedes: DECL });
  assert.equal(ok.declared, true);
  assert.equal(ok.spec, OLD_SPEC);
  assert.deepEqual(ok.problems, []);
});

// ── 判据⑧：可选字段一旦登记进冻结表，形状守卫**不许**把"没写它"判成漂移 ──────────────
// 现场：给 schema 加 `supersedes`（required:false）之后，**36 条用例当场变红** ——
// `assertProposalShape` 当时比的是"键集合逐一相同"，于是所有正常提案都成了"漂移"。
// 这条用例把新口径钉住：必填键全在 + 没有表外的键 = 合法；其余照旧 fail-closed。
test('判据⑧: 提案形状守卫按 required 区分（可选字段可以不写；未知键仍拒）', () => {
  const base = {
    schema: 1, id: 'P-1', rule: 'CAT-CODE', source: 'human', createdAt: '2026-01-01T00:00:00.000Z',
    redCriteria: '红', counterExample: 'checker:x.spec.json', falsePositiveSurface: 'tree:.',
    activationCheck: 'rk-effect verify', status: 'proposed',
  };
  assert.equal(assertProposalShape(base).ok, true, '不写可选字段的提案必须合法');
  assert.equal(assertProposalShape({ ...base, supersedes: DECL }).ok, true, '写了可选字段也合法');
  assert.equal(assertProposalShape({ ...base, bogus: 1 }).ok, false, '表外的键必须拒（防手写字段漂移）');
  const { activationCheck, ...missing } = base;
  assert.equal(assertProposalShape(missing).ok, false, '缺必填键必须拒');
  assert.equal(validateProposalValues({ ...base, supersedes: undefined }).ok, true, '可选字段为空 = 合法缺省，不是"字段为空"');
});
