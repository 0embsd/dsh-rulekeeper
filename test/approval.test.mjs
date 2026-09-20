// dsh-rulekeeper · 锚定式人签字用例（2026-09-19）
//
// 判据（读死再下结论）：
//   绿 = ①问句/应答的解析**从标签判结论**（不从选项顺序推断）
//        ②落盘只在"真人应答 = 批准"时发生；**拒绝 / 问不通 / 应答不可解析 ⇒ 一个字节都不写**
//        ③凭证写进账本 evidence，且**逐字区分**"anchored"与"declared"（不假装字符串是签名）
//        ④落点配 `requireAnchoredApproval: true` ⇒ 没有锚定凭证的写入（含 CLI --by human）一律拒
//   红 = 拿不到应答却降级成"声明"继续写；或拒绝之后 rules.json 被改了；或伪造的凭证被当好凭证

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ANCHOR_SOURCE, APPROVAL_APPROVE_LABEL, APPROVAL_REJECT_LABEL,
  buildApprovalQuestion, describeApproval, makeAnchoredApproval, parseApprovalAnswer, validateAnchoredApproval,
} from '../src/approval.mjs';
import { applyActivation } from '../src/effect.mjs';
import { makeAnchoredApplyHandler } from '../src/handlers.mjs';
import { cleanupAll, PKG_ROOT, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const TS = new Date('2026-09-19T00:00:00.000Z');

/** 一个能落盘的最小落点：文件类绑定（carrier = AGENTS.md）+ 提案 */
function fixture(label, { requireAnchored = null } = {}) {
  const root = tempDir(label);
  const repo = join(root, 'repo');
  const landing = join(repo, '.dsh-ai', 'rulekeeper');
  mkdirSync(join(landing, 'proposals'), { recursive: true });
  writeFileSync(join(repo, 'AGENTS.md'), 'v1\n', 'utf8');
  const cfg = { schema: 1, mode: 'observe', ...(requireAnchored === null ? {} : { requireAnchoredApproval: requireAnchored }) };
  writeFileSync(join(landing, 'config.json'), `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  writeFileSync(join(landing, 'rules.json'), `${JSON.stringify({
    schema: 1, project: 't', protected_paths: ['AGENTS.md'], gates: [], checks: [], inject: [],
  }, null, 2)}\n`, 'utf8');
  writeFileSync(join(landing, 'ledger.jsonl'), '', 'utf8');
  const proposal = {
    schema: 1, id: 'P-anchor-1', rule: 'CAT-PROC', source: 'human', createdAt: '2026-09-19T00:00:00.000Z',
    redCriteria: '改 AGENTS.md 未留证时判红',
    counterExample: 'path:AGENTS.md',
    falsePositiveSurface: 'path:README.md',
    activationCheck: 'rk-gate precommit --repo . --landing .dsh-ai/rulekeeper',
    status: 'proposed',
    patterns: [],
  };
  writeFileSync(join(landing, 'proposals', 'P-anchor-1.json'), `${JSON.stringify(proposal, null, 2)}\n`, 'utf8');
  return { repo, landing };
}

const checksOf = (landing) => JSON.parse(readFileSync(join(landing, 'rules.json'), 'utf8')).checks;

// ── ① 解析 ──────────────────────────────────────────────────────────────────
test('判据: 结论从**标签**判定，不从选项顺序推断', () => {
  const q = buildApprovalQuestion({ rule: 'CAT-PROC', proposalId: 'P1', summary: 's', landing: 'L' });
  assert.equal(q.id, 'rk-apply-P1');
  assert.deepEqual(q.options.map((o) => o.label), [APPROVAL_APPROVE_LABEL, APPROVAL_REJECT_LABEL]);
  assert.equal(parseApprovalAnswer({ answers: [{ id: q.id, selected: [APPROVAL_APPROVE_LABEL] }] }, q.id).decision, 'approve');
  assert.equal(parseApprovalAnswer({ answers: [{ id: q.id, selected: [APPROVAL_REJECT_LABEL] }] }, q.id).decision, 'reject');
  assert.equal(parseApprovalAnswer({ answers: [{ id: q.id, selected: ['随便一个字'] }] }, q.id).decision, 'unknown');
  assert.equal(parseApprovalAnswer({ answers: [{ id: 'other', selected: [APPROVAL_APPROVE_LABEL] }] }, q.id).decision, 'unknown', '问与答必须一一对应');
  assert.equal(parseApprovalAnswer(null, q.id).decision, 'unknown');
  // 自定义文本不算批准（fail-closed）
  assert.equal(parseApprovalAnswer({ answers: [{ id: q.id, selected: [], custom: '可以' }] }, q.id).decision, 'unknown');
});

test('判据: 凭证校验只认"锚定"四要素，其余一律按声明处理', () => {
  const good = makeAnchoredApproval({ questionId: 'q1', decision: 'approve', question: 'Q', answer: { a: 1 }, at: TS });
  assert.deepEqual(validateAnchoredApproval(good), []);
  assert.match(validateAnchoredApproval({ ...good, source: 'typed-by-ai' }).join('；'), /source/);
  assert.match(validateAnchoredApproval({ ...good, questionId: '' }).join('；'), /questionId/);
  assert.match(validateAnchoredApproval({ ...good, decision: 'maybe' }).join('；'), /decision/);
  assert.match(validateAnchoredApproval({ ...good, digest: 'x' }).join('；'), /digest/);
  assert.match(validateAnchoredApproval({ ...good, at: 'not-a-time' }).join('；'), /at/);
  assert.equal(describeApproval(null), 'approval=declared(--by human 字符串；非锚定)');
  assert.match(describeApproval(good), /^approval=anchored\(q1\) decision=approve digest=[0-9a-f]{12}$/);
  assert.match(describeApproval({ source: 'typed-by-ai' }), /^approval=invalid\(/);
  assert.equal(good.source, ANCHOR_SOURCE);
});

// ── ②③ 写通路：批准才写、拒绝不写、凭证进账本 ───────────────────────────────
test('判据: 带锚定凭证 → 落盘；凭证**逐字**写进账本 evidence', () => {
  const f = fixture('anchor-apply-ok');
  const approval = makeAnchoredApproval({ questionId: 'rk-apply-P-anchor-1', decision: 'approve', question: 'Q', answer: { answers: [] }, at: TS });
  const out = applyActivation({ landingDir: f.landing, projectRoot: f.repo, proposalId: 'P-anchor-1', by: 'human', apply: true, now: TS, approval });
  assert.equal(out.ok, true, `${out.code}: ${out.message}`);
  assert.equal(checksOf(f.landing).length, 1, '批准后应落盘');
  const ledger = readFileSync(join(f.landing, 'ledger.jsonl'), 'utf8');
  assert.match(ledger, /approval=anchored\(rk-apply-P-anchor-1\) decision=approve/, '账本必须记下锚定凭证（可核对）');
  // 不带凭证时如实标"声明"，不许假装是签名
  const f2 = fixture('anchor-apply-declared');
  const out2 = applyActivation({ landingDir: f2.landing, projectRoot: f2.repo, proposalId: 'P-anchor-1', by: 'human', apply: true, now: TS });
  assert.equal(out2.ok, true);
  assert.match(readFileSync(join(f2.landing, 'ledger.jsonl'), 'utf8'), /approval=declared\(--by human 字符串；非锚定\)/);
});

test('判据: 真人应答为"拒绝" ⇒ 拒绝写（rules.json 一个字节不动）', () => {
  const f = fixture('anchor-reject');
  const before = readFileSync(join(f.landing, 'rules.json'), 'utf8');
  const approval = makeAnchoredApproval({ questionId: 'q', decision: 'reject', question: 'Q', answer: { answers: [] }, at: TS });
  const out = applyActivation({ landingDir: f.landing, projectRoot: f.repo, proposalId: 'P-anchor-1', by: 'human', apply: true, now: TS, approval });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'EFFECT_APPROVAL_REJECTED');
  assert.equal(readFileSync(join(f.landing, 'rules.json'), 'utf8'), before, '拒绝后不得改动 rules.json');
});

test('判据: 伪造/不合法凭证 ⇒ 拒绝写（不许把编的凭证当好凭证）', () => {
  const f = fixture('anchor-forged');
  const before = readFileSync(join(f.landing, 'rules.json'), 'utf8');
  for (const bad of [
    { source: 'typed-by-ai', questionId: 'q', decision: 'approve', digest: 'f'.repeat(64), at: TS.toISOString() },
    { source: ANCHOR_SOURCE, questionId: '', decision: 'approve', digest: 'f'.repeat(64), at: TS.toISOString() },
    { source: ANCHOR_SOURCE, questionId: 'q', decision: 'approve', digest: 'short', at: TS.toISOString() },
  ]) {
    const out = applyActivation({ landingDir: f.landing, projectRoot: f.repo, proposalId: 'P-anchor-1', by: 'human', apply: true, now: TS, approval: bad });
    assert.equal(out.ok, false, `伪造凭证必须被拒：${JSON.stringify(bad)}`);
    assert.equal(out.code, 'EFFECT_APPROVAL_INVALID');
  }
  assert.equal(readFileSync(join(f.landing, 'rules.json'), 'utf8'), before);
});

test('判据: 落点配 requireAnchoredApproval=true ⇒ 只有声明的**真写**一律拒（CLI 也拦）；dry-run 不受限', () => {
  const f = fixture('anchor-required', { requireAnchored: true });
  // dry-run（不看写）= 允许：操作者必须先能看到"准备写什么"，才谈得上签不签
  const dry = applyActivation({ landingDir: f.landing, projectRoot: f.repo, proposalId: 'P-anchor-1', by: 'human', apply: false, now: TS });
  assert.equal(dry.ok, true, `dry-run 不该被锚定开关拦住：${dry.code} ${dry.message}`);
  assert.equal(dry.applied, false);
  assert.equal(checksOf(f.landing).length, 0, 'dry-run 不落盘');

  const out = applyActivation({ landingDir: f.landing, projectRoot: f.repo, proposalId: 'P-anchor-1', by: 'human', apply: true, now: TS });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'EFFECT_APPROVAL_NOT_ANCHORED');
  // CLI 同一条路（同一份 config 开关）
  const cli = spawnSync(process.execPath, [join(PKG_ROOT, 'bin', 'rk-effect.mjs'), 'apply', '--landing', f.landing, '--project', f.repo, '--proposal', 'P-anchor-1', '--by', 'human', '--apply'], { cwd: PKG_ROOT, encoding: 'utf8' });
  assert.equal(cli.status, 1);
  // 具体原因码必须出现在输出里（applyActivation 直接 fail 时是 CODE，plan 阶段失败时是 REASON_CODE）
  assert.match(cli.stdout, /EFFECT_APPROVAL_NOT_ANCHORED/);
  assert.equal(checksOf(f.landing).length, 0, '两种入口都不得写入');
});

// ── ④ 插件工具：唯一会问真人的地方 ──────────────────────────────────────────
test('判据（安全核心）: 拿不到真人应答 ⇒ **fail-closed 不写**，绝不退回 --by human 声明', async () => {
  const f = fixture('anchor-tool-noanswer');
  // ① 宿主没有 userQuestions 服务
  const h1 = makeAnchoredApplyHandler({ ctx: { agents: { roots: () => [{ id: 'root' }] } }, cwd: f.repo });
  const r1 = await h1({ proposal: 'P-anchor-1', apply: true });
  assert.equal(r1.ok, false);
  assert.equal(r1.decision, 'no-answerer');
  assert.equal(checksOf(f.landing).length, 0);
  // ② 有服务但注册表里没有活着的根 agent
  const h2 = makeAnchoredApplyHandler({ ctx: { userQuestions: { ask: async () => ({ answers: [] }) }, agents: { roots: () => [] } }, cwd: f.repo });
  assert.equal((await h2({ proposal: 'P-anchor-1', apply: true })).decision, 'no-answerer');
  // ③ 子代理被宿主拒（DELEGATED_CALLER）⇒ 同样不写
  const delegated = Object.assign(new Error('delegated caller cannot ask'), { code: 'DELEGATED_CALLER' });
  const h3 = makeAnchoredApplyHandler({ ctx: { userQuestions: { ask: async () => { throw delegated; } }, agents: { roots: () => [{ id: 'root' }] } }, cwd: f.repo });
  const r3 = await h3({ proposal: 'P-anchor-1', apply: true });
  assert.equal(r3.decision, 'ask-failed');
  assert.match(r3.reason, /DELEGATED_CALLER/);
  assert.equal(checksOf(f.landing).length, 0, '拿不到应答时 rules.json 必须原封不动');
});

test('判据: 真人批准 ⇒ 落盘并回报凭证；真人拒绝 ⇒ 不写且回报拒绝', async () => {
  const approve = fixture('anchor-tool-approve');
  const askOk = async ({ questions }) => ({ answers: [{ id: questions[0].id, selected: [APPROVAL_APPROVE_LABEL] }] });
  const h = makeAnchoredApplyHandler({ ctx: { userQuestions: { ask: askOk }, agents: { roots: () => [{ id: 'root-1' }] } }, cwd: approve.repo, now: () => TS });
  const ok = await h({ proposal: 'P-anchor-1', apply: true });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.decision, 'applied');
  assert.match(ok.approval, /^anchored\(rk-apply-P-anchor-1\) digest=[0-9a-f]{12}$/);
  assert.equal(checksOf(approve.landing).length, 1);
  assert.match(readFileSync(join(approve.landing, 'ledger.jsonl'), 'utf8'), /approval=anchored\(/);

  const reject = fixture('anchor-tool-reject');
  const askNo = async ({ questions }) => ({ answers: [{ id: questions[0].id, selected: [APPROVAL_REJECT_LABEL] }] });
  const h2 = makeAnchoredApplyHandler({ ctx: { userQuestions: { ask: askNo }, agents: { roots: () => [{ id: 'root-1' }] } }, cwd: reject.repo, now: () => TS });
  const no = await h2({ proposal: 'P-anchor-1', apply: true });
  assert.equal(no.ok, false);
  assert.equal(no.decision, 'rejected');
  assert.equal(checksOf(reject.landing).length, 0, '拒绝后不得写入');
});

test('判据: 只走到"问真人 + dry-run"（apply 缺省）时不落盘', async () => {
  const f = fixture('anchor-tool-dryrun');
  const askOk = async ({ questions }) => ({ answers: [{ id: questions[0].id, selected: [APPROVAL_APPROVE_LABEL] }] });
  const h = makeAnchoredApplyHandler({ ctx: { userQuestions: { ask: askOk }, agents: { roots: () => [{ id: 'root-1' }] } }, cwd: f.repo, now: () => TS });
  const r = await h({ proposal: 'P-anchor-1' });
  assert.equal(r.ok, true);
  assert.equal(r.decision, 'dry-run');
  assert.equal(existsSync(join(f.landing, 'rules.json')) && checksOf(f.landing).length, 0, 'dry-run 不落盘');
});

test('判据: 工具名与参数已登记进 PLUGIN_TOOLS（装载即用，不是写了没人调）', async () => {
  const { PLUGIN_TOOLS, TOOL_PARAMETERS } = await import('../src/plugin.mjs');
  const names = PLUGIN_TOOLS.map((t) => t.name);
  assert.ok(names.includes('rulekeeper_apply'), `工具必须登记：${names.join(',')}`);
  assert.deepEqual(TOOL_PARAMETERS['rulekeeper_apply'].required, ['proposal']);
  const { HANDLER_TOOL_NAMES, defaultHandlers } = await import('../src/handlers.mjs');
  assert.ok(HANDLER_TOOL_NAMES.includes('rulekeeper_apply'), 'handler 名单要与工具同名（同一命名空间）');
  // 纯函数表里给的是**fail-closed 兜底**（不是空壳、也不是能落盘的实现）：拿不到 ctx 就明确拒绝
  const stub = defaultHandlers().rulekeeper_apply;
  assert.equal(typeof stub, 'function', '纯表必须有兜底 handler（否则"未注入 handler"的模糊态又会回来）');
  const stubOut = stub({ proposal: 'P-anchor-1' });
  assert.equal(stubOut.ok, false);
  assert.equal(stubOut.decision, 'no-answerer');
  assert.match(stubOut.reason, /拒绝落盘/);
});
