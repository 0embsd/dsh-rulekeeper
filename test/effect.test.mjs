// dsh-rulekeeper · LF-A* **生效闭环**（入账 ≠ 生效）
//
// 判据（设计单 §2 + 消号清单）：
//   LF-A20 `effectPlan`：状态机五态 + 空转闸（EFFECT_BINDING_UNENFORCED）+ TEXT_ONLY
//   LF-A30 `planActivation`/`parseCarrier`：载体一一对应（缺载体 = 凭证不足，禁声称能验证）
//   LF-A40 `verifyBinding`：①命中红 ②**反事实唯一性** ③误报面绿 ④载体检查
//   LF-A50 `applyActivation`：**只有人签字能写 rules.json**；写后回读；失败**逐字节回滚**
//   LF-A60 生效后复发 -> evolve 产**升级提案**（不再被幂等静默跳过）
//   LF-A70 插件工具 `rulekeeper_effect` + `effectInjectPlan`（零落点写入）
//   LF-A80 `rk-selfcheck` S9：写了模块没人用 -> 必红
//
// 红态（先红后绿）：见各 `红态：` 注释；本文件每条"必红"断言都对应一个真实可构造的形态。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_EFFECT_GATE, EFFECT_EVENT_CATEGORY, EFFECT_FAILED_MARK, EFFECT_VERIFIED_MARK,
  applyActivation, effectInjectPlan, effectPlan, normalizeBinding, parseCarrier, planActivation,
  ruleBindings, verifyBinding,
} from '../src/effect.mjs';
import { runRulekeeper } from '../src/cli.mjs';
import { RC } from '../src/rc.mjs';
import { runSelfcheck } from '../src/cli.mjs';
import { listProposals, writeProposal } from '../src/proposal.mjs';
import { CLOSE_KNOWN_GATES } from '../src/gate.mjs';
import { cleanupAll, freshLanding, ledgerEntry, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const QUALITY = Object.freeze({
  redCriteria: '改了 docs/x.md 却没留证 -> gate write 判红',
  counterExample: 'path:docs/x.md（改过没留证的样本）',
  falsePositiveSurface: 'path:README.md（不受保护，必须判绿）',
  activationCheck: 'rk-effect verify --proposal <id>',
});

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** 落点指纹：相对路径 -> sha256（用于断言"零写入"） */
function fingerprint(dir) {
  const out = {};
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel), { withFileTypes: true }).map((d) => d.name).sort()) {
      const relPath = rel === '' ? name : `${rel}/${name}`;
      const abs = join(dir, relPath);
      if (statSync(abs).isDirectory()) walk(relPath);
      else out[relPath] = sha256File(abs);
    }
  };
  walk('');
  return out;
}

/**
 * 造一个"能验证"的现场：项目根 + 落点。
 *  · `docs/x.md` 受保护但**没有留证** ⇒ 门禁必判红（命中红用例的现场）
 *  · `README.md` 不受保护 ⇒ 误报面绿用例的现场
 */
function scene(label, { withRules = true, patterns = ['docs/x.md'] } = {}) {
  const projectRoot = tempDir(`${label}-proj`);
  const landing = join(projectRoot, '.dsh-ai', 'rulekeeper');
  mkdirSync(join(projectRoot, 'docs'), { recursive: true });
  mkdirSync(landing, { recursive: true });
  writeFileSync(join(projectRoot, 'docs', 'x.md'), '# x\n', 'utf8');
  writeFileSync(join(projectRoot, 'README.md'), '# r\n', 'utf8');
  writeFileSync(join(landing, 'config.json'), `${JSON.stringify({ schema: 1, mode: 'observe' }, null, 2)}\n`, 'utf8');
  if (withRules) {
    writeFileSync(join(landing, 'rules.json'), `${JSON.stringify({
      schema: 1, project: 'demo', protected_paths: patterns, gates: [], checks: [], inject: [],
    }, null, 2)}\n`, 'utf8');
  }
  return { projectRoot, landing };
}

function binding(rule, carrier, extra = {}) {
  // `patterns` = 这条绑定**声明的封闭面**（反事实只摘这些；缺了就 fail-closed —— 见 verifyBinding）
  return { kind: 'file_untracked_change', rule, carrier, gate: DEFAULT_EFFECT_GATE, patterns: [carrier], ...extra };
}

/** 给落点补一份"该载体已留证且未改"的快照记录（稳态现场，CR major #5 的复现条件） */
function snapshotCarrier(landing, projectRoot, rel) {
  const abs = join(projectRoot, rel);
  const sha = sha256File(abs);
  mkdirSync(join(landing, 'snapshots'), { recursive: true });
  const row = { schema: 1, ts: '2026-09-19T00:00:00.000Z', path: rel, sha256_before: sha, sha256_after: sha, backup: `backups/${rel.replace(/\//g, '_')}.bak`, why: 'test' };
  writeFileSync(join(landing, 'snapshots', 'index.jsonl'), `${JSON.stringify(row)}\n`, 'utf8');
}

/** 往落点写一条提案（四要件齐备） */
function seedProposal(landing, rule, { status = 'proposed', quality = QUALITY, id = 'P-20260919-000000-aaaaaa' } = {}) {
  const proposal = {
    schema: 1, id, rule, source: 'human', createdAt: '2026-09-19T00:00:00.000Z',
    redCriteria: quality.redCriteria, counterExample: quality.counterExample,
    falsePositiveSurface: quality.falsePositiveSurface, activationCheck: quality.activationCheck,
    status,
  };
  const written = writeProposal(landing, proposal);
  assert.equal(written.ok, true, written.reason ?? '提案应写入成功');
  return proposal;
}

function capture(fn) {
  let out = '';
  let err = '';
  const rc = fn({ out: (t) => { out += String(t); }, err: (t) => { err += String(t); } });
  return { rc, out, err };
}

function rk(argv) {
  return capture((io) => runRulekeeper(argv, io, {}));
}

// ── LF-A30 载体解析：没有载体 = 凭证不足（对齐 SKILL §9.6 R1）────────────────────────

test('LF-A30 parseCarrier：path: 载体必须能解析出来，纯描述必须判"无载体"', () => {
  assert.equal(parseCarrier('path:docs/x.md').value, 'docs/x.md');
  assert.equal(parseCarrier('反例样本 path:docs/x.md（改过没留证）').kind, 'path');
  assert.equal(parseCarrier('只对受保护路径生效；纯文本仓库不触发').kind, null, '红态：自由描述不得被当成载体');
  assert.equal(parseCarrier('inline:some text').kind, 'inline', 'inline 不被支持，必须如实分类');
  assert.equal(parseCarrier('').kind, null);
});

// ── LF-A20 状态机 + 空转闸 ────────────────────────────────────────────────────────

test('LF-A20 effectPlan：只写了账本的纪律判 text-only（EFFECT_TEXT_ONLY，error）', () => {
  const { landing } = scene('a20-none');
  writeFileSync(join(landing, 'ledger.jsonl'), `${JSON.stringify(ledgerEntry({ id: 'LF-1', ts: '2026-09-01T00:00:00.000Z', rule: 'FACT-WRITING' }))}\n`, 'utf8');
  const plan = effectPlan({ landingDir: landing, now: new Date('2026-09-19T00:00:00.000Z') });
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].state, 'none');
  assert.equal(plan.ok, false, '有 error 级 finding 时 ok 必须为 false');
  assert.ok(plan.findings.some((f) => f.code === 'EFFECT_TEXT_ONLY' && f.severity === 'error'));
});

test('LF-A20 effectPlan：只有 inject 绑定 => injected；再加 checks 绑定 => mechanized（红态：不得一步跳到 mechanized）', () => {
  const { landing } = scene('a20-states');
  writeFileSync(join(landing, 'ledger.jsonl'), `${JSON.stringify(ledgerEntry({ id: 'LF-1', ts: '2026-09-01T00:00:00.000Z', rule: 'FACT-WRITING' }))}\n`, 'utf8');
  const rules = JSON.parse(readFileSync(join(landing, 'rules.json'), 'utf8'));
  writeFileSync(join(landing, 'rules.json'), `${JSON.stringify({ ...rules, inject: [{ rule: 'FACT-WRITING', fields: { target: 'rules.json' } }] }, null, 2)}\n`, 'utf8');
  let plan = effectPlan({ landingDir: landing });
  assert.equal(plan.items[0].state, 'injected');
  assert.equal(plan.items[0].checks, 0);
  // 红态：把 checks 绑定加上后必须是 mechanized（而不是继续 injected）
  writeFileSync(join(landing, 'rules.json'), `${JSON.stringify({
    ...rules, inject: [{ rule: 'FACT-WRITING', fields: {} }], checks: [binding('FACT-WRITING', 'docs/x.md')],
  }, null, 2)}\n`, 'utf8');
  plan = effectPlan({ landingDir: landing });
  assert.equal(plan.items[0].state, 'mechanized', '有 checks 绑定但没验证 => mechanized');
  assert.ok(plan.findings.some((f) => f.code === 'EFFECT_NOT_VERIFIED' && f.severity === 'warn'));
});

test('LF-A20 effectPlan：绑定的载体没被保护面覆盖 => 空转闸（EFFECT_BINDING_UNENFORCED，error）', () => {
  const { landing } = scene('a20-vacuous', { patterns: ['other/**'] });
  writeFileSync(join(landing, 'ledger.jsonl'), `${JSON.stringify(ledgerEntry({ id: 'LF-1', ts: '2026-09-01T00:00:00.000Z', rule: 'FACT-WRITING' }))}\n`, 'utf8');
  const rules = JSON.parse(readFileSync(join(landing, 'rules.json'), 'utf8'));
  writeFileSync(join(landing, 'rules.json'), `${JSON.stringify({ ...rules, checks: [binding('FACT-WRITING', 'docs/x.md')] }, null, 2)}\n`, 'utf8');
  const plan = effectPlan({ landingDir: landing });
  assert.equal(plan.ok, false);
  assert.ok(plan.findings.some((f) => f.code === 'EFFECT_BINDING_UNENFORCED'), '挂名生效必须被抓出');
});

test('LF-A20 normalizeBinding/ruleBindings：裸字符串（旧形态）不算绑定，对象条目才算', () => {
  assert.equal(normalizeBinding('file_untracked_change'), null);
  assert.equal(normalizeBinding({ kind: 'file_untracked_change' }), null, '缺 rule 不算绑定');
  const rules = { checks: ['file_untracked_change', binding('r-1', 'a.md')], gates: [], inject: [] };
  const map = ruleBindings(rules);
  assert.equal(map.size, 1);
  assert.equal(map.get('R-1').checks.length, 1, 'rule 必须 canonical 化');
});

// ── LF-A30 生效草案 ──────────────────────────────────────────────────────────────

test('LF-A30 planActivation：缺载体的提案必须判"凭证不足"（不得产出草案）', () => {
  const { landing } = scene('a30-uncarried');
  const proposal = seedProposal(landing, 'FACT-WRITING', { quality: { ...QUALITY, counterExample: '语义化描述，没有载体' } });
  const planned = planActivation({ landingDir: landing, proposal });
  assert.equal(planned.ok, false);
  assert.ok(planned.findings.some((f) => f.code === 'EFFECT_VERIFY_UNCARRIED'));
  assert.equal(planned.candidate, null);
});

test('LF-A30 planActivation：草案必须自带 rule 绑定 + 保护面模式，且能过 validateRules', () => {
  const { landing } = scene('a30-plan', { patterns: [] });
  const proposal = seedProposal(landing, 'FACT-WRITING');
  const planned = planActivation({ landingDir: landing, proposal });
  assert.equal(planned.ok, true, JSON.stringify(planned.findings));
  assert.deepEqual(planned.additions.patterns, ['docs/x.md']);
  assert.equal(planned.additions.binding.carrier, 'docs/x.md');
  assert.equal(planned.additions.binding.gate, DEFAULT_EFFECT_GATE);
  assert.ok(CLOSE_KNOWN_GATES.includes(planned.additions.binding.gate));
  // 草案形状：顶层 6 字段不变
  assert.deepEqual(Object.keys(planned.candidate).sort(), ['checks', 'gates', 'inject', 'project', 'protected_paths', 'schema']);
});

// ── LF-A40 生效验证三项 ─────────────────────────────────────────────────────────

test('LF-A40 verifyBinding：三项全过（命中红 + 反事实唯一性 + 误报面绿）', () => {
  const { projectRoot, landing } = scene('a40-pass');
  const report = verifyBinding({
    landingDir: landing, projectRoot, binding: binding('FACT-WRITING', 'docs/x.md'), falsePositive: 'path:README.md',
  });
  assert.equal(report.ok, true, JSON.stringify(report.findings));
  assert.deepEqual(report.cases.map((c) => c.name), ['命中红', '反事实唯一性', '误报面绿']);
  assert.ok(report.cases.every((c) => c.ok === true), JSON.stringify(report.cases));
});

test('LF-A40 verifyBinding 红态：缺 carrier => EFFECT_VERIFY_UNCARRIED（凭证不足，禁标生效）', () => {
  const { projectRoot, landing } = scene('a40-uncarried');
  const report = verifyBinding({ landingDir: landing, projectRoot, binding: { kind: 'file_untracked_change', rule: 'R', gate: 'pre-commit' } });
  assert.equal(report.ok, false);
  assert.equal(report.findings[0].code, 'EFFECT_VERIFY_UNCARRIED');
});

test('LF-A40 verifyBinding 红态：摘掉绑定声明的模式后仍判红 => EFFECT_CHECK_NOT_THE_STOPPER（挂名生效）', () => {
  // 现场：载体**本来就被别的宽 glob** 拦着（docs/**），本条绑定只声明了 docs/x.md ⇒ 摘掉它照样红
  const { projectRoot, landing } = scene('a40-stopper', { patterns: ['docs/**', 'docs/x.md'] });
  const report = verifyBinding({ landingDir: landing, projectRoot, binding: binding('FACT-WRITING', 'docs/x.md') });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((f) => f.code === 'EFFECT_CHECK_NOT_THE_STOPPER'), JSON.stringify(report.findings));
});

test('LF-A40 verifyBinding 红态：落点证据基座坏（坏索引）=> EFFECT_VERIFY_LANDING_DIRTY（不冒充判据问题）', () => {
  const { projectRoot, landing } = scene('a40-dirty');
  mkdirSync(join(landing, 'snapshots'), { recursive: true });
  writeFileSync(join(landing, 'snapshots', 'index.jsonl'), '{not json at all\n', 'utf8');
  const report = verifyBinding({ landingDir: landing, projectRoot, binding: binding('FACT-WRITING', 'docs/x.md') });
  assert.equal(report.ok, false);
  assert.equal(report.findings[0].code, 'EFFECT_VERIFY_LANDING_DIRTY', JSON.stringify(report.findings));
});

test('LF-A40 verifyBinding 红态：落点 config 不可读 => EFFECT_VERIFY_LANDING_DIRTY（fail-closed，禁假绿）', () => {
  const { projectRoot, landing } = scene('a40-dirtycfg');
  writeFileSync(join(landing, 'config.json'), '{"schema": 1, "mode": "obs', 'utf8');
  const report = verifyBinding({ landingDir: landing, projectRoot, binding: binding('FACT-WRITING', 'docs/x.md') });
  assert.equal(report.ok, false);
  assert.equal(report.findings[0].code, 'EFFECT_VERIFY_LANDING_DIRTY', JSON.stringify(report.findings));
});

test('LF-A40 verifyBinding 红态：kind 不是 file_untracked_change => EFFECT_KIND_UNSUPPORTED（禁拿文件门禁糊过去）', () => {
  const { projectRoot, landing } = scene('a40-kind');
  const report = verifyBinding({ landingDir: landing, projectRoot, binding: { ...binding('FACT-WRITING', 'docs/x.md'), kind: 'output_shape' } });
  assert.equal(report.ok, false);
  assert.equal(report.findings[0].code, 'EFFECT_KIND_UNSUPPORTED');
});

test('LF-A40 verifyBinding：绑定没声明 patterns => EFFECT_COUNTERFACTUAL_UNDECLARED（不可隔离即 fail-closed）', () => {
  const { projectRoot, landing } = scene('a40-nopat');
  const b = binding('FACT-WRITING', 'docs/x.md');
  delete b.patterns;
  const report = verifyBinding({ landingDir: landing, projectRoot, binding: b });
  assert.equal(report.ok, false);
  assert.equal(report.findings[0].code, 'EFFECT_COUNTERFACTUAL_UNDECLARED');
});

test('LF-A40 verifyBinding：**稳态现场**（载体已留证且未改）也必须可复现通过（违规样本是构造出来的）', () => {
  // 来历（独立 CR major #5）：旧实现拿真实落点当样本 ⇒ 已留证未改时门禁判 pass ⇒ 命中红永远不可能过，
  // verified 变成一次性状态、README/RUNBOOK 承诺的"重跑 verify 得 exit=0"做不到。
  const { projectRoot, landing } = scene('a40-steady');
  snapshotCarrier(landing, projectRoot, 'docs/x.md');
  const report = verifyBinding({ landingDir: landing, projectRoot, binding: binding('FACT-WRITING', 'docs/x.md'), falsePositive: 'path:README.md' });
  assert.equal(report.ok, true, JSON.stringify(report.findings));
  assert.ok(report.cases.every((c) => c.ok === true), JSON.stringify(report.cases));
  // 第二次跑仍然通过（可重复，而不是"消费掉现场"）
  const again = verifyBinding({ landingDir: landing, projectRoot, binding: binding('FACT-WRITING', 'docs/x.md'), falsePositive: 'path:README.md' });
  assert.equal(again.ok, true, JSON.stringify(again.findings));
});

test('LF-A40 verifyBinding 红态：误报面样本被判红 => EFFECT_FALSE_POSITIVE', () => {
  const { projectRoot, landing } = scene('a40-fp', { patterns: ['docs/x.md', 'README.md'] });
  const report = verifyBinding({
    landingDir: landing, projectRoot, binding: binding('FACT-WRITING', 'docs/x.md'), falsePositive: 'path:README.md',
  });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((f) => f.code === 'EFFECT_FALSE_POSITIVE'), JSON.stringify(report.findings));
});

test('LF-A40 verifyBinding 口径回归：绑定的 falsePositive 存**已解析路径**时也必须真跑误报面绿', () => {
  // 来历（2026-09-19 凭据生成时实测抓到）：绑定字段存的是 `README.md`（已解析），
  // 而 verifyBinding 一开始只认 `path:README.md`（带标记原文）⇒ CLI 路径上绿态用例被**静默跳过**，
  // 报成 EFFECT_FALSE_POSITIVE_UNCARRIED。两处口径必须一致或兼容 —— 这里钉死兼容性。
  const { projectRoot, landing } = scene('a40-fp-bare');
  const report = verifyBinding({
    landingDir: landing, projectRoot, binding: binding('FACT-WRITING', 'docs/x.md', { falsePositive: 'README.md' }),
  });
  assert.equal(report.ok, true, JSON.stringify(report.findings));
  assert.ok(report.cases.some((c) => c.name === '误报面绿'), `必须真的跑绿态用例（而不是静默跳过）: ${JSON.stringify(report.cases)}`);
});

// ── LF-A50 唯一写通路（人签字 + 回读 + 回滚）────────────────────────────────────
test('LF-A50 applyActivation 红线：by=auto 一律拒绝，且 rules.json 逐字节不变', () => {
  const { landing } = scene('a50-auto');
  seedProposal(landing, 'FACT-WRITING');
  const before = sha256File(join(landing, 'rules.json'));
  const out = applyActivation({ landingDir: landing, proposalId: 'P-20260919-000000-aaaaaa', by: 'auto', apply: true });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'EFFECT_HUMAN_SIGNATURE_REQUIRED');
  assert.equal(sha256File(join(landing, 'rules.json')), before, '红态：被拒时一个字节都不许变');
});

test('LF-A50 applyActivation：默认 dry-run（不落盘），--apply 才写且写后回读 + 提案 approved + 账本生效登记', () => {
  const { landing } = scene('a50-apply');
  seedProposal(landing, 'FACT-WRITING');
  const before = sha256File(join(landing, 'rules.json'));
  const dry = applyActivation({ landingDir: landing, proposalId: 'P-20260919-000000-aaaaaa', by: 'human' });
  assert.equal(dry.ok, true);
  assert.equal(dry.applied, false);
  assert.equal(sha256File(join(landing, 'rules.json')), before, 'dry-run 不得改文件');

  const real = applyActivation({ landingDir: landing, proposalId: 'P-20260919-000000-aaaaaa', by: 'human', apply: true });
  assert.equal(real.ok, true, real.message ?? '');
  assert.equal(real.applied, true);
  assert.notEqual(real.afterSha, before);
  assert.ok(readdirSync(join(landing, 'backups')).length >= 1, '必须先备份');
  const rules = JSON.parse(readFileSync(join(landing, 'rules.json'), 'utf8'));
  assert.deepEqual(rules.protected_paths, ['docs/x.md']);
  assert.equal(rules.checks.length, 1);
  assert.equal(rules.checks[0].rule, 'FACT-WRITING');
  assert.equal(JSON.parse(readFileSync(join(landing, 'proposals', 'P-20260919-000000-aaaaaa.json'), 'utf8')).status, 'approved');
  const ledger = readFileSync(join(landing, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const act = ledger.filter((r) => r.category === EFFECT_EVENT_CATEGORY);
  assert.equal(act.length, 1);
  assert.match(act[0].problem, /EFFECT_ACTIVATE/);
  assert.match(act[0].problem, /proposal=P-20260919-000000-aaaaaa/);
});

test('LF-A50 applyActivation 回滚：写后回读不一致 => 从备份逐字节还原（不留半成品）', () => {
  const { landing } = scene('a50-rollback');
  seedProposal(landing, 'FACT-WRITING');
  const before = sha256File(join(landing, 'rules.json'));
  const out = applyActivation({
    landingDir: landing, proposalId: 'P-20260919-000000-aaaaaa', by: 'human', apply: true,
    _inject: { failAfterReplace: true },
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'EFFECT_VERIFY_AFTER_WRITE');
  assert.equal(out.rolledBack, true);
  assert.equal(sha256File(join(landing, 'rules.json')), before, '回滚后必须与写前逐字节相同');
  assert.equal(JSON.parse(readFileSync(join(landing, 'proposals', 'P-20260919-000000-aaaaaa.json'), 'utf8')).status, 'proposed', '回滚时提案状态不得被改成 approved');
});

test('LF-A50 applyActivation：已批准/不存在的提案一律拒绝（幂等与防错）', () => {
  const { landing } = scene('a50-missing');
  const missing = applyActivation({ landingDir: landing, proposalId: 'P-nope', by: 'human', apply: true });
  assert.equal(missing.code, 'EFFECT_PROPOSAL_MISSING');
  seedProposal(landing, 'FACT-WRITING', { status: 'approved' });
  const already = applyActivation({ landingDir: landing, proposalId: 'P-20260919-000000-aaaaaa', by: 'human', apply: true });
  assert.equal(already.code, 'EFFECT_PLAN_UNQUALIFIED');
});

test('LF-A50 applyActivation 路径穿越防线：含 ../ 或分隔符的提案 id 一律拒绝（LF-270 同族）', () => {
  const { landing } = scene('a50-traversal');
  seedProposal(landing, 'FACT-WRITING');
  for (const bad of ['../evil', 'a/b', '..', '.', 'x\\y']) {
    const out = applyActivation({ landingDir: landing, proposalId: bad, by: 'human', apply: true });
    assert.equal(out.ok, false, `${bad} 应被拒绝`);
    assert.equal(out.code, 'EFFECT_PROPOSAL_ID_UNSAFE', `${bad} 应报 id 不安全`);
  }
  assert.ok(!existsSync(join(landing, '..', 'evil.json')), '不得在落点之外写出任何文件');
  const cli = rk(['effect', 'apply', '--landing', landing, '--proposal', '../../evil', '--by', 'human', '--apply']);
  assert.equal(cli.rc, RC.USAGE, 'CLI 侧按用法错误处置（exit=2）');
});

test('LF-A50 applyActivation：落点没有 rules.json 时报错，不得发明 project:"unknown" 的规则包（CR nit #15）', () => {
  const { landing } = scene('a50-norules', { withRules: false });
  seedProposal(landing, 'FACT-WRITING');
  const out = applyActivation({ landingDir: landing, proposalId: 'P-20260919-000000-aaaaaa', by: 'human', apply: true });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'EFFECT_RULES_MISSING');
  assert.equal(existsSync(join(landing, 'rules.json')), false, '不得凭空造出哨兵值的规则包');
});

test('LF-A50 applyActivation 第二条回滚路径：提案状态写回失败 => rules.json 逐字节还原（CR major #9）', () => {
  const { landing } = scene('a50-rollback2');
  seedProposal(landing, 'FACT-WRITING');
  const before = sha256File(join(landing, 'rules.json'));
  // 让提案文件"写入即失败"：把 proposals 目录里的文件锁成只读（Windows 上 renameSync 会 EPERM）
  const pf = join(landing, 'proposals', 'P-20260919-000000-aaaaaa.json');
  chmodSync(pf, 0o444);
  try {
    const out = applyActivation({ landingDir: landing, proposalId: 'P-20260919-000000-aaaaaa', by: 'human', apply: true });
    if (out.ok === true) return; // 平台/权限位不生效时如实跳过（不假装测过）
    assert.equal(out.code, 'EFFECT_PROPOSAL_STATUS_FAILED', JSON.stringify(out));
    assert.equal(sha256File(join(landing, 'rules.json')), before, '提案状态写失败必须回滚 rules.json');
    assert.equal(JSON.parse(readFileSync(pf, 'utf8')).status, 'proposed');
  } finally {
    chmodSync(pf, 0o644);
  }
});

// ── LF-A60 生效后自动进化 ───────────────────────────────────────────────────────

test('LF-A60 生效后复发 => evolve 必须产**升级提案**（不得被幂等静默跳过）', () => {
  const { landing } = scene('a60-recur', { patterns: ['docs/x.md'] });
  const now = new Date('2026-09-19T12:00:00.000Z');
  seedProposal(landing, 'FACT-WRITING');
  const applied = applyActivation({ landingDir: landing, proposalId: 'P-20260919-000000-aaaaaa', by: 'human', apply: true, now });
  assert.equal(applied.ok, true, applied.message ?? '');
  // 生效之后又踩了两次（同 rule）——**追加**到账本（不得覆盖生效登记事件行）
  const rows = [
    ledgerEntry({ id: 'LF-2', ts: '2026-09-20T00:00:00.000Z', rule: 'FACT-WRITING' }),
    ledgerEntry({ id: 'LF-3', ts: '2026-09-21T00:00:00.000Z', rule: 'fact_writing' }), // 同族不同写法
  ];
  writeFileSync(join(landing, 'ledger.jsonl'), `${readFileSync(join(landing, 'ledger.jsonl'), 'utf8').trimEnd()}\n${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  const plan = effectPlan({ landingDir: landing, now: new Date('2026-09-22T00:00:00.000Z') });
  assert.equal(plan.items[0].state, 'recurred');
  assert.equal(plan.items[0].recurredAfterActivation, true);
  assert.ok(plan.findings.some((f) => f.code === 'EFFECT_RECURRED_AFTER_ACTIVATION' && f.severity === 'error'));

  const { rc, out } = rk(['evolve', '--landing', landing, '--now', '2026-09-22T00:00:00.000Z',
    '--rule', 'FACT-WRITING', '--quality', qualityFileFor(landing)]);
  assert.equal(rc, RC.OK, out);
  const proposals = listProposals(landing).items;
  assert.equal(proposals.length, 2, `生效后复发必须再产一条升级提案（实得 ${proposals.length}）: ${out}`);
});

test('LF-A60 生效后零信号且超期 => effectPlan 报 EFFECT_STALE_NO_SIGNAL（建议退役）', () => {
  const { landing } = scene('a60-stale', { patterns: ['docs/x.md'] });
  const now = new Date('2026-01-01T00:00:00.000Z');
  seedProposal(landing, 'FACT-WRITING');
  const applied = applyActivation({ landingDir: landing, proposalId: 'P-20260919-000000-aaaaaa', by: 'human', apply: true, now });
  assert.equal(applied.ok, true, applied.message ?? '');
  // 生效后一次都没复发（账本里没有该 rule 的新条目）
  const plan = effectPlan({ landingDir: landing, now: new Date('2026-06-01T00:00:00.000Z'), staleDays: 30 });
  assert.ok(plan.findings.some((f) => f.code === 'EFFECT_STALE_NO_SIGNAL'), JSON.stringify(plan.findings));
});

function qualityFileFor(landing) {
  const p = join(landing, 'quality.json');
  writeFileSync(p, `${JSON.stringify({ 'FACT-WRITING': QUALITY }, null, 2)}\n`, 'utf8');
  return p;
}

test('LF-A60 生效登记行**不算复发**（effect 与 evolve 必须同一口径，CR major #8）', () => {
  const { landing } = scene('a60-notrecur', { patterns: ['docs/x.md'] });
  const now = new Date('2026-09-19T12:00:00.000Z');
  seedProposal(landing, 'FACT-WRITING');
  const applied = applyActivation({ landingDir: landing, proposalId: 'P-20260919-000000-aaaaaa', by: 'human', apply: true, now });
  assert.equal(applied.ok, true, applied.message ?? '');
  // 账本此刻只有那条生效登记行（没有教训行）：effect 与 evolve 都必须看到"零复发"
  const plan = effectPlan({ landingDir: landing, now: new Date('2026-09-19T13:00:00.000Z') });
  assert.equal(plan.items[0].recurredAfterActivation, false);
  rk(['evolve', '--landing', landing, '--rule', 'FACT-WRITING', '--quality', qualityFileFor(landing)]);
  assert.equal(listProposals(landing).items.length, 1, '生效登记行被当成复发 => 会多出一条提案（口径不一致）');
});

// ── LF-A70 注入接线 + 插件工具 ───────────────────────────────────────────────────

test('LF-A70 effectInjectPlan：产出注入计划（唯一 id + <untrusted>），且**零落点写入**', () => {
  const { landing } = scene('a70-inject');
  writeFileSync(join(landing, 'ledger.jsonl'), `${JSON.stringify(ledgerEntry({ id: 'LF-1', ts: '2026-09-01T00:00:00.000Z', rule: 'FACT-WRITING' }))}\n`, 'utf8');
  const before = fingerprint(landing);
  const plan = effectInjectPlan({ landingDir: landing, now: new Date('2026-09-19T00:00:00.000Z') });
  assert.equal(plan.appended.length, 1);
  assert.match(plan.appended[0].id, /^rk-inject-/);
  assert.equal(plan.appended[0].mode, 'append');
  assert.match(plan.appended[0].text, /<untrusted>/);
  assert.deepEqual(fingerprint(landing), before, '注入计划必须是纯计算的（零落点写入）');
});

test('LF-A70 插件面：PLUGIN_TOOLS 必须有 rulekeeper_effect，且默认 handler 真能跑（不是空壳）', async () => {
  const plugin = await import('../src/plugin.mjs');
  const handlers = await import('../src/handlers.mjs');
  assert.ok(plugin.PLUGIN_TOOLS.some((t) => t.name === 'rulekeeper_effect'), 'LF-A70 红态：缺工具名必红');
  assert.ok(plugin.TOOL_PARAMETERS.rulekeeper_effect !== undefined, '缺参数表');
  const { landing } = scene('a70-handler');
  const handlers2 = handlers.defaultHandlers({ cwd: landing });
  assert.equal(typeof handlers2.rulekeeper_effect, 'function', '默认 handlers 必须真接上（不是空壳）');
  const def = plugin.toolDefinition({ name: 'rulekeeper_effect', summary: '生效体检' }, handlers2);
  assert.equal(typeof def.output.render, 'function');
  assert.equal(typeof def.output.schema, 'object');
  const out = handlers2.rulekeeper_effect({ project: landing });
  assert.equal(typeof out.ok, 'boolean');
  assert.ok(Array.isArray(out.findings));
  assert.equal(typeof out.reason, 'string');
});

// ── LF-A80 S9 模块接线检查 ──────────────────────────────────────────────────────

test('LF-A80 S9：写了模块没人用 -> 必红；真实包 -> 绿', async () => {
  const sandbox = await import('./helpers/sandbox.mjs');
  const root = sandbox.PKG_ROOT;
  const ok = capture((io) => runSelfcheck(['--root', root], io, {}));
  assert.equal(ok.rc, RC.OK, `真实包 selfcheck 必须绿：${ok.out}${ok.err}`);
  // 红态（**最小现场**，不复制整包）：一个 src 模块没人 import -> S9 必红；接上 import -> 必绿
  const fake = tempDir('a80-red');
  mkdirSync(join(fake, 'src'), { recursive: true });
  writeFileSync(join(fake, 'package.json'), `${JSON.stringify({ name: 'fake', type: 'module', engines: { node: '>=22' } })}\n`, 'utf8');
  writeFileSync(join(fake, 'index.js'), "import './src/user.mjs';\n", 'utf8');
  writeFileSync(join(fake, 'src', 'wanted.mjs'), 'export const x = 1;\n', 'utf8');
  writeFileSync(join(fake, 'src', 'user.mjs'), "import { x } from './wanted.mjs';\nexport const y = x;\n", 'utf8');
  const wired = capture((io) => runSelfcheck(['--root', fake], io, {}));
  assert.equal(/S9_UNWIRED_MODULE/.test(wired.out), false, `接了 import 就不得报 S9: ${wired.out}`);
  writeFileSync(join(fake, 'src', 'user.mjs'), 'export const y = 2;\n', 'utf8');
  const red = capture((io) => runSelfcheck(['--root', fake], io, {}));
  assert.equal(red.rc, RC.FAIL, `红态：摘掉 import 后必须 exit=1: ${red.out}`);
  assert.match(red.out, /S9_UNWIRED_MODULE src\/wanted\.mjs/, `红态：必须点名 wanted.mjs: ${red.out}`);
});

// ── CLI 面（rc 契约：0 通过 / 1 判定不合格 / 2 用法错误）────────────────────────

test('LF-A30/A50 CLI：effect plan/apply 的 rc 契约与用法错误', () => {
  const { landing } = scene('cli-effect');
  writeFileSync(join(landing, 'ledger.jsonl'), `${JSON.stringify(ledgerEntry({ id: 'LF-1', ts: '2026-09-01T00:00:00.000Z', rule: 'FACT-WRITING' }))}\n`, 'utf8');
  // TEXT_ONLY => 判定不合格 => rc 1
  const plan = rk(['effect', 'plan', '--landing', landing, '--now', '2026-09-19T00:00:00.000Z']);
  assert.equal(plan.rc, RC.FAIL, plan.out);
  assert.match(plan.out, /RK_EFFECT_TEXT_ONLY=1/);
  assert.match(plan.out, /RK_EFFECT_RESULT=fail/);
  // 用法错误：缺 --by
  seedProposal(landing, 'FACT-WRITING');
  const noBy = rk(['effect', 'apply', '--landing', landing, '--proposal', 'P-20260919-000000-aaaaaa', '--apply']);
  assert.equal(noBy.rc, RC.USAGE, noBy.err);
  // auto 签字 => 拒绝 => rc 1
  const auto = rk(['effect', 'apply', '--landing', landing, '--proposal', 'P-20260919-000000-aaaaaa', '--by', 'auto', '--apply']);
  assert.equal(auto.rc, RC.FAIL, auto.out);
  // 人签字 dry-run => rc 0
  const dry = rk(['effect', 'apply', '--landing', landing, '--proposal', 'P-20260919-000000-aaaaaa', '--by', 'human']);
  assert.equal(dry.rc, RC.OK, dry.err + dry.out);
  // --help 只打用法，不落盘
  const help = rk(['effect', '--help']);
  assert.equal(help.rc, RC.OK);
  assert.match(help.out, /rk-effect/);
});

test('LF-A40 CLI：effect verify --all 通过 => rc 0，且写入 findings.jsonl 作为验证凭证', () => {
  const { projectRoot, landing } = scene('cli-verify');
  seedProposal(landing, 'FACT-WRITING');
  const applied = rk(['effect', 'apply', '--landing', landing, '--proposal', 'P-20260919-000000-aaaaaa', '--by', 'human', '--apply', '--project', projectRoot]);
  assert.equal(applied.rc, RC.OK, applied.err + applied.out);
  const verified = rk(['effect', 'verify', '--landing', landing, '--project', projectRoot, '--all']);
  assert.equal(verified.rc, RC.OK, verified.err + verified.out);
  const rows = readFileSync(join(landing, 'findings.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.ok(rows[0].evidence.includes(EFFECT_VERIFIED_MARK));
  // 验证记录被 effect plan 消费 => 状态升级为 verified
  const after = effectPlan({ landingDir: landing, projectRoot });
  assert.equal(after.items[0].state, 'verified');
});

test('LF-A40 CLI：effect verify 在坏索引现场判红（rc 1）并写 EFFECT_VERIFY_FAILED', () => {
  const { projectRoot, landing } = scene('cli-verify-red');
  seedProposal(landing, 'FACT-WRITING');
  rk(['effect', 'apply', '--landing', landing, '--proposal', 'P-20260919-000000-aaaaaa', '--by', 'human', '--apply', '--project', projectRoot]);
  mkdirSync(join(landing, 'snapshots'), { recursive: true });
  writeFileSync(join(landing, 'snapshots', 'index.jsonl'), '{bad\n', 'utf8');
  const verified = rk(['effect', 'verify', '--landing', landing, '--project', projectRoot, '--all']);
  assert.equal(verified.rc, RC.FAIL, verified.out);
  const rows = readFileSync(join(landing, 'findings.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(rows.some((r) => r.evidence.includes(EFFECT_FAILED_MARK)));
});

test('LF-A50 CLI：effect inject 输出注入计划且零落点写入（rc 0）', () => {
  const { landing } = scene('cli-inject');
  writeFileSync(join(landing, 'ledger.jsonl'), `${JSON.stringify(ledgerEntry({ id: 'LF-1', ts: '2026-09-01T00:00:00.000Z', rule: 'FACT-WRITING' }))}\n`, 'utf8');
  const before = fingerprint(landing);
  const out = rk(['effect', 'inject', '--landing', landing, '--json', '--now', '2026-09-19T00:00:00.000Z']);
  assert.equal(out.rc, RC.OK, out.err + out.out);
  assert.match(out.out, /rk-inject-/);
  assert.deepEqual(fingerprint(landing), before);
});

test('LF-A50 CLI：effect apply 真实写入后重跑 plan 必须从 fail 转 pass（闭环）', () => {
  const { projectRoot, landing } = scene('cli-closed-loop');
  writeFileSync(join(landing, 'ledger.jsonl'), `${JSON.stringify(ledgerEntry({ id: 'LF-1', ts: '2026-09-01T00:00:00.000Z', rule: 'FACT-WRITING' }))}\n`, 'utf8');
  seedProposal(landing, 'FACT-WRITING');
  assert.equal(rk(['effect', 'plan', '--landing', landing]).rc, RC.FAIL);
  assert.equal(rk(['effect', 'apply', '--landing', landing, '--proposal', 'P-20260919-000000-aaaaaa', '--by', 'human', '--apply', '--project', projectRoot]).rc, RC.OK);
  assert.equal(rk(['effect', 'verify', '--landing', landing, '--project', projectRoot, '--all']).rc, RC.OK);
  const plan = rk(['effect', 'plan', '--landing', landing, '--project', projectRoot, '--now', '2026-09-19T00:00:00.000Z']);
  assert.equal(plan.rc, RC.OK, plan.out);
  assert.match(plan.out, /RK_EFFECT_RESULT=pass/);
  assert.match(plan.out, /RK_EFFECT_VERIFIED=1/);
});

test('LF-A80 rc 契约：effect 面沿用 cli/1（判定不合格）与 cli/2（用法错误），无新码', async () => {
  const sandbox = await import('./helpers/sandbox.mjs');
  const table = readFileSync(join(sandbox.PKG_ROOT, 'src', 'rc.mjs'), 'utf8');
  assert.match(table, /EFFECT|effect/i, 'rc 契约表必须提到 effect 面（语义同步）');
});
