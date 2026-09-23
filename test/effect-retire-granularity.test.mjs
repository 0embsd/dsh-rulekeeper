// dsh-rulekeeper · P11 用例：`retire` 必须支持**判据粒度**（不能按 rule 一把全摘）
//
// 现场（2026-09-23，被治理项目报）：原实现 `rule === rule` 把该 rule 的**全部** checks 绑定一起摘掉，
// 输出只报一个总数 ⇒ 他们两次"退役一条判据"却连带摘掉了同 rule 的其它绑定与 `protected_paths` 条目，
// 且**没有任何告警**（退役变拆台）。
//
// 本文件的判据（红 = 任一性质被破坏）：
//   ① 指定 `--carrier` 退役一条 ⇒ **该 rule 的其它绑定仍在**（字节级核对 rules.json）
//   ② 只摘**被选中那条**独占的 protected_paths；别的绑定/别条纪律声明过的模式不许动
//   ③ 多条绑定又没指定摘哪条 ⇒ fail-closed **拒绝**，并把候选**逐条列出**（不猜、不静默全摘）
//   ④ 指定的载体不存在 ⇒ 拒绝，并列出该 rule 现有绑定（不静默改成"全摘"）
//   ⑤ 单条绑定（老形态）不传 `--carrier` 仍照旧可退役；`--apply` 通路端到端可用
//   ⑥ 退役行的台账如实带上 removedCarrier / remainingBindings（事后查得到"摘的是哪一条"）
//
// 反向红：把 `planActivation` 的退役分支退回"按 rule 过滤" ⇒ ①②③④⑥ 全红。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { applyActivation, effectPlan, planActivation } from '../src/effect.mjs';
import { runRulekeeper } from '../src/cli.mjs';
import { writeProposal } from '../src/proposal.mjs';
import { cleanupAll, ledgerEntry, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const RULE = 'CAT-PROC';
const OTHER = 'CAT-TECH';
const RETIRE = 'EFFECT_RETIRE_CANDIDATE';

const QUALITY = {
  redCriteria: `${RETIRE}：零信号窗口内退役（本条纪律已无人踩）`,
  counterExample: 'path:docs/a.md（曾用于验证的载体）',
  falsePositiveSurface: 'path:README.md（不受保护，必须判绿）',
  activationCheck: 'rk-effect plan --landing <落点> --rule CAT-PROC 必须显示 retired',
};

/** 一条 file 载体绑定的最小形状（判据只看 rule/carrier/patterns/gate） */
const binding = (rule, carrier, patterns) => ({
  kind: 'file_untracked_change', rule, carrier, gate: 'close', patterns,
});

/**
 * 现场：同一条纪律**两条**绑定（不同载体），另有别条纪律一条绑定。
 * protected_paths 也故意含三个条目（两条本 rule + 一条别条纪律），外加一个 `path:` 标记形态。
 */
function scene(label) {
  const landing = join(tempDir(label), '.dsh-ai', 'rulekeeper');
  mkdirSync(landing, { recursive: true });
  const rules = {
    schema: 1,
    project: 'demo',
    protected_paths: ['docs/a.md', 'path:docs/b.md', 'docs/c.md'],
    gates: [],
    checks: [
      binding(RULE, 'docs/a.md', ['docs/a.md']),
      binding(RULE, 'docs/b.md', ['docs/b.md']),
      binding(OTHER, 'docs/c.md', ['docs/c.md']),
    ],
    inject: [],
  };
  writeFileSync(join(landing, 'rules.json'), `${JSON.stringify(rules, null, 2)}\n`, 'utf8');
  return { landing };
}

function seedRetireProposal(landing, id = 'P-20260923-000000-p11aaa') {
  const proposal = {
    schema: 1, id, rule: RULE, source: 'human',
    createdAt: '2026-09-23T00:00:00.000Z',
    redCriteria: QUALITY.redCriteria, counterExample: QUALITY.counterExample,
    falsePositiveSurface: QUALITY.falsePositiveSurface, activationCheck: QUALITY.activationCheck,
    status: 'proposed',
  };
  const w = writeProposal(landing, proposal);
  assert.equal(w.ok, true, w.reason ?? '提案应写入成功');
  return proposal;
}

const readRules = (landing) => JSON.parse(readFileSync(join(landing, 'rules.json'), 'utf8'));
const carriersOf = (rules, rule) => rules.checks.filter((c) => c.rule === rule).map((c) => c.carrier);

test('P11①②: 指定 --carrier 退役一条 ⇒ 同 rule 的另一条绑定与别条纪律都不动，只摘独占模式', () => {
  const { landing } = scene('p11-one');
  const proposal = seedRetireProposal(landing);
  const plan = planActivation({ landingDir: landing, proposal, carrier: 'docs/a.md' });
  assert.equal(plan.ok, true, JSON.stringify(plan.findings));
  assert.equal(plan.kind, 'retire');
  assert.deepEqual(plan.additions.retirement.removedPatterns, ['docs/a.md'], '只该摘被选中那条独占的模式');
  assert.equal(plan.additions.retirement.removedBindings, 1);
  assert.equal(plan.additions.retirement.removedCarrier, 'docs/a.md');
  assert.equal(plan.additions.retirement.remainingBindings, 1, '同 rule 应还剩 1 条');

  const after = plan.candidate;
  assert.deepEqual(carriersOf(after, RULE), ['docs/b.md'], '同 rule 的其它绑定必须原样留着');
  assert.deepEqual(carriersOf(after, OTHER), ['docs/c.md'], '别条纪律的绑定不许动');
  assert.deepEqual(after.protected_paths, ['path:docs/b.md', 'docs/c.md'],
    'protected_paths 只该少 docs/a.md；docs/b.md（另一个绑定声明）与 docs/c.md 必须留着');
});

test('P11③: 多条绑定 + 没指定摘哪条 ⇒ fail-closed 拒绝，候选**逐条列出**', () => {
  const { landing } = scene('p11-ambiguous');
  const proposal = seedRetireProposal(landing);
  const plan = planActivation({ landingDir: landing, proposal });
  assert.equal(plan.ok, false, '多条绑定不许猜');
  assert.equal(plan.findings[0].code, 'EFFECT_RETIRE_AMBIGUOUS');
  const msg = plan.findings[0].message;
  assert.match(msg, /有 2 条 checks 绑定/);
  // "逐条列出"是本条验收判据的一部分：每一条都要看得见载体与种类
  assert.match(msg, /\[1\] carrier=docs\/a\.md/);
  assert.match(msg, /\[2\] carrier=docs\/b\.md/);
  assert.match(msg, /--carrier/);
  // 拒绝时不得产出草案（"没动"必须是真没动）
  assert.equal(plan.candidate, null);
  assert.equal(plan.additions, null);
});

test('P11④: 指定的载体不存在 ⇒ 拒绝并列出该 rule 现有绑定（不静默改成全摘）', () => {
  const { landing } = scene('p11-unknown');
  const proposal = seedRetireProposal(landing);
  const plan = planActivation({ landingDir: landing, proposal, carrier: 'docs/nope.md' });
  assert.equal(plan.ok, false);
  assert.equal(plan.findings[0].code, 'EFFECT_RETIRE_UNKNOWN_CARRIER');
  assert.match(plan.findings[0].message, /docs\/nope\.md/);
  assert.match(plan.findings[0].message, /carrier=docs\/a\.md/);
  assert.equal(plan.candidate, null);
});

test('P11⑤: 单条绑定 + `--carrier` 端到端走 CLI 真落盘；台账如实记下摘的是哪一条', () => {
  const { landing } = scene('p11-cli');
  seedRetireProposal(landing);
  // 先用 CLI 只摘 docs/a.md（dry-run），确认读数
  let out = '';
  const dry = runRulekeeper(['effect', 'apply', '--landing', landing, '--proposal', 'P-20260923-000000-p11aaa',
    '--by', 'human', '--carrier', 'docs/a.md'], { out: (t) => { out += String(t); }, err: () => {} }, {});
  assert.equal(dry, 0, `dry-run 应成功；out=${out}`);
  assert.match(out, /RK_EFFECT_APPLY_RULE=CAT-PROC/);
  assert.deepEqual(carriersOf(readRules(landing), RULE), ['docs/a.md', 'docs/b.md'], 'dry-run 不许写盘');

  // 再真落盘
  out = '';
  const applied = runRulekeeper(['effect', 'apply', '--landing', landing, '--proposal', 'P-20260923-000000-p11aaa',
    '--by', 'human', '--carrier', 'docs/a.md', '--apply'], { out: (t) => { out += String(t); }, err: () => {} }, {});
  assert.equal(applied, 0, `--apply 应成功；out=${out}`);
  const rules = readRules(landing);
  assert.deepEqual(carriersOf(rules, RULE), ['docs/b.md'], '只该摘掉 docs/a.md 那条');
  assert.deepEqual(rules.protected_paths, ['path:docs/b.md', 'docs/c.md']);

  // 台账：退役行必须带上"摘的是哪一条/还剩几条"（否则事后查不到）
  const ledger = readFileSync(join(landing, 'ledger.jsonl'), 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l)).filter((e) => String(e.problem ?? '').startsWith('EFFECT_RETIRE'));
  assert.equal(ledger.length, 1, `必须恰好一条退役行；实得 ${ledger.length}`);
  assert.match(ledger[0].problem, /removedCarrier=docs\/a\.md/);
  assert.match(ledger[0].problem, /remainingBindings=1/);
});

test('P11⑤b: **单条**绑定不传 --carrier 仍照旧可退役（老形态不被这次改动打破）', () => {
  const landing = join(tempDir('p11-single'), '.dsh-ai', 'rulekeeper');
  mkdirSync(landing, { recursive: true });
  writeFileSync(join(landing, 'rules.json'), `${JSON.stringify({
    schema: 1, project: 'demo', protected_paths: ['docs/a.md'], gates: [],
    checks: [binding(RULE, 'docs/a.md', ['docs/a.md'])], inject: [],
  }, null, 2)}\n`, 'utf8');
  const proposal = seedRetireProposal(landing);
  const plan = planActivation({ landingDir: landing, proposal });
  assert.equal(plan.ok, true, JSON.stringify(plan.findings));
  assert.deepEqual(plan.candidate.checks, [], '单条绑定退役后 checks 应空');
  assert.deepEqual(plan.candidate.protected_paths, []);
  assert.equal(plan.additions.retirement.remainingBindings, 0);
});

test('P11⑥: 退役一条后该纪律仍有绑定 ⇒ 状态不得变 retired；再摘最后一条才 retired', () => {
  const { landing } = scene('p11-not-retired');
  // 生效登记（让 plan 有"曾经生效"这个事实可读）
  writeFileSync(join(landing, 'ledger.jsonl'), `${JSON.stringify(ledgerEntry({
    id: 'LF-1', ts: '2026-09-01T00:00:00.000Z', rule: RULE, category: '生效登记',
    problem: `EFFECT_ACTIVATE rule=${RULE} proposal=P-1 patterns=2 gate=close`,
    activation: '改了 docs/a.md 或 docs/b.md 却没留证 -> gate write 判红',
  }))}\n`, 'utf8');

  const p1 = seedRetireProposal(landing);
  const first = applyActivation({ landingDir: landing, proposalId: p1.id, by: 'human', apply: true, carrier: 'docs/a.md' });
  assert.equal(first.ok, true, first.message ?? '');
  assert.deepEqual(carriersOf(readRules(landing), RULE), ['docs/b.md'], '第一次只摘 docs/a.md');

  // **本条的判别点**：还有一条绑定在守 ⇒ 不得被读成 retired（旧实现在这里已经把两条都摘了）
  const plan1 = effectPlan({ landingDir: landing });
  const item1 = plan1.items.find((i) => i.rule === RULE);
  assert.equal(item1.state === 'retired', false, `还剩一条绑定，不许读成 retired（state=${item1.state}）`);

  // 再退役最后一条 ⇒ 这时才 retired
  const p2 = seedRetireProposal(landing, 'P-20260923-000000-p11bbb');
  const second = applyActivation({ landingDir: landing, proposalId: p2.id, by: 'human', apply: true, carrier: 'docs/b.md' });
  assert.equal(second.ok, true, `最后一条也必须能被退役（旧实现在这里会报"没有可退役的绑定"）：${second.message ?? ''}`);
  assert.deepEqual(carriersOf(readRules(landing), RULE), []);
  const plan2 = effectPlan({ landingDir: landing });
  assert.equal(plan2.items.find((i) => i.rule === RULE).state, 'retired', '两条都摘完才是 retired');
});
