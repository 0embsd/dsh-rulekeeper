// dsh-rulekeeper · **默认 handlers（装上即用）**
//
// 为什么有这一层（2026-09-16 实测缺陷）：此前 `index.js` 装载时不注入 handlers ⇒ 装进 DSH 后
//   `rulekeeper_gate` / `rulekeeper_record` / `rulekeeper_snap` 三个工具**调用即回**
//   `{ok:false, configured:false, reason:'本工具未注入 handler（默认零副作用）'}` ——
//   用户"装上了却什么都不能用"，等于没装。本模块把包内**已有实现**接上，让"装上即用"成立
//   （消费者仍可用自己的 handlers 覆盖，契约不变）。
//
// 行为口径（诚实，逐条可预期）：
//   · `rulekeeper_gate`   = **只读判定**：读保护面 + 最新留证基线，给出 allow/deny，**不写文件、不阻断**。
//                           要"真的拦下来"必须由消费者改用 `ctx.tools.guard(name, handler)`（部署决策，不在默认面）。
//   · `rulekeeper_record` = 往**落点**追加一条取证台账行（append-only；字段契约见 `src/ledger.mjs`）。
//   · `rulekeeper_snap`   = 拍 pre-image 快照（备份 + 回读校验 + 索引登记；`src/snap.mjs`）。
//   · 落点默认 `<项目>/.dsh-ai/rulekeeper`（老 `.dsh-ai/lessonflow` 兼容窗口由 `resolveProjectLanding` 决定）。
//   · `mode=off` ⇒ **零副作用**（LF-800）：record/snap 不建目录不写文件，gate 照常只读判定。
//
// 零依赖：只用 node:*。

import { resolve } from 'node:path';

import { reconWrite } from './gate.mjs';
import { applyActivation, effectPlan } from './effect.mjs';
import { buildApprovalQuestion, makeAnchoredApproval, parseApprovalAnswer } from './approval.mjs';
import { record as ledgerRecord } from './ledger.mjs';
import { isSafeId } from './proposal.mjs';
import { readOptionalService } from './landing.mjs';
import { resolveProjectLanding, toPosix } from './platform/paths.mjs';
import { canonicalRule } from './ruleid.mjs';
import { takeSnapshot } from './snap.mjs';

/** 从工具入参解析项目根（缺省 = 进程工作目录；调用方给相对路径也按它归一） */
function projectRootOf(args, fallback) {
  const p = args !== null && typeof args === 'object' && typeof args.project === 'string' && args.project.trim() !== ''
    ? args.project
    : fallback;
  return resolve(p);
}

/** 项目落点（唯一权威源：`resolveProjectLanding`，含老落点兼容窗口） */
export function landingOf(projectRoot) {
  return resolve(resolveProjectLanding(projectRoot));
}

/**
 * **只读**门禁判定：给定「项目 + 相对路径」，回答 allow / deny。
 * @returns {{decision: 'allow'|'deny', ok: boolean, reason: string, path: string, verdict: string,
 *            findings: string[], patterns: number, landingPresent: boolean, mode: string}}
 */
export function gateOnce({ projectRoot, path, phase = 'close' }) {
  const root = resolve(projectRoot);
  const landingDir = landingOf(root);
  const rel = typeof path === 'string' ? path.trim() : '';
  if (rel === '') {
    return { decision: 'allow', ok: false, reason: 'gate 需要 path（相对项目根的路径）', path: '', verdict: 'no-path', findings: [], patterns: 0, landingPresent: false, mode: 'unknown' };
  }
  const r = reconWrite({ projectRoot: root, landingDir, files: [rel], phase });
  const checked = Array.isArray(r.checked) ? r.checked[0] ?? null : null;
  const verdict = checked !== null
    ? String(checked.verdict)
    : (r.findings.length > 0 ? 'error' : (r.patterns ?? []).length === 0 ? 'no-protection' : 'not-protected');
  const findings = (r.findings ?? []).map((f) => String(f.code ?? ''));
  const decision = r.ok === true ? 'allow' : 'deny';
  const detail = decision === 'allow'
    ? `通过（${verdict}）`
    : String(r.findings?.[0]?.message ?? '判定不通过');
  return {
    decision,
    ok: r.ok === true,
    reason: `${detail}｜path=${rel}｜保护面 ${(r.patterns ?? []).length} 条｜落点${r.landingPresent ? '在位' : '缺失'}｜mode=${r.mode ?? 'unknown'}${findings.length > 0 ? `｜${findings.join(',')}` : ''}`,
    path: rel,
    verdict,
    findings,
    patterns: (r.patterns ?? []).length,
    landingPresent: r.landingPresent === true,
    mode: String(r.mode ?? 'unknown'),
  };
}

/**
 * 追加一条取证台账行。
 * @returns {{ok: boolean, id: string|null, reason: string, skipped: boolean}}
 */
export function recordOnce({ projectRoot, input }) {
  const root = resolve(projectRoot);
  const landingDir = landingOf(root);
  const out = ledgerRecord(input, { landingDir });
  if (out.skipped === true) return { ok: true, id: null, skipped: true, reason: String(out.reason ?? 'mode=off：零副作用，未写台账') };
  if (out.ok !== true) return { ok: false, id: null, skipped: false, reason: String(out.reason ?? '记账失败') };
  return { ok: true, id: String(out.entry?.id ?? ''), skipped: false, reason: `已追加台账行 ${out.entry?.id ?? ''}（${out.bytes} 字节）-> ${landingDir}` };
}

/**
 * 拍 pre-image 快照（备份 + 回读校验 + 索引登记）。
 * @returns {{ok: boolean, skipped: boolean, path: string|null, sha256: string|null, reason: string}}
 */
export function snapOnce({ projectRoot, path, why }) {
  const root = resolve(projectRoot);
  const landingDir = landingOf(root);
  const rel = typeof path === 'string' ? path.trim() : '';
  if (rel === '') {
    return { ok: false, skipped: false, path: null, sha256: null, reason: 'snap 需要 path（相对项目根的路径）' };
  }
  // **必须按项目根解析**（2026-09-16 实测缺陷）：直接把入参交给 `takeSnapshot` 时，它内部先判
  //   `existsSync(file)` —— 相对路径会命中**宿主进程工作目录**里的同名文件。
  //   实测后果：演练项目的 `AGENTS.md`(2B) 变成把主仓 `AGENTS.md`(167KB) 拍成快照，索引里的 sha256
  //   与项目里那个文件不符（gate 随即判 deny，暴露出"两个工具看的不是同一个文件"）。
  const abs = resolve(root, rel);
  const out = takeSnapshot({ projectRoot: root, landingDir, file: abs, why: why ?? 'rulekeeper_snap（插件工具）' });
  if (out.skipped === true) {
    return { ok: true, skipped: true, path: null, sha256: null, reason: String(out.reasons?.[0] ?? 'mode=off：零副作用，未拍快照') };
  }
  if (out.ok !== true) {
    return { ok: false, skipped: false, path: out.path ?? null, sha256: out.sha256 ?? null, reason: String(out.reasons?.[0] ?? out.code ?? '拍快照失败') };
  }
  return { ok: true, skipped: false, path: out.path ?? null, sha256: out.sha256 ?? null, reason: `已留证 ${out.path ?? ''}（sha256=${String(out.sha256 ?? '').slice(0, 12)}…，索引 ${out.indexLines ?? 0} 行）` };
}

/** 账本契约必填但工具入参没给的字段 —— 一律**如实拒绝**，不写占位文本污染台账 */
const RECORD_FILL_DEFAULTS = Object.freeze({
  category: '纪律',
  mechanism: 'dsh-rulekeeper 插件工具 rulekeeper_record',
});

/**
 * 默认 handlers（键 = 工具名；与 `PLUGIN_TOOLS` 一一对应）。
 * @param {{cwd?: string}} [opts]
 */
export function defaultHandlers(opts = {}) {
  const cwd = resolve(opts.cwd ?? process.cwd());
  return {
    rulekeeper_gate: (args = {}) => gateOnce({
      projectRoot: projectRootOf(args, cwd),
      path: args.path,
      phase: args.phase === 'open' ? 'open' : 'close',
    }),
    rulekeeper_record: (args = {}) => {
      const input = {
        rule: args.rule,
        category: typeof args.category === 'string' && args.category.trim() !== '' ? args.category : RECORD_FILL_DEFAULTS.category,
        problem: args.problem,
        root_cause: args.rootCause,
        solution: args.solution,
        mechanism: typeof args.mechanism === 'string' && args.mechanism.trim() !== '' ? args.mechanism : RECORD_FILL_DEFAULTS.mechanism,
        evidence: args.evidence,
      };
      const missing = ['rule', 'problem', 'root_cause', 'solution'].filter((f) => typeof input[f] !== 'string' || input[f].trim() === '');
      if (missing.length > 0) {
        return { ok: false, id: null, skipped: false, reason: `记账需要这些字段（账本契约要求，不接受占位文本）: ${missing.join(', ')}` };
      }
      return recordOnce({ projectRoot: projectRootOf(args, cwd), input });
    },
    rulekeeper_snap: (args = {}) => snapOnce({
      projectRoot: projectRootOf(args, cwd),
      path: args.path,
      why: args.why,
    }),
    // LF-A70（2026-09-19）：**生效体检**（只读）。为什么默认面必须有它：`record` 之后此前无路可走
    //   （入账 ≠ 生效），用户记完教训无从知道它是否真的拦得住。本 handler 只做**读**判定，
    //   绝不写 rules.json（写权归人，见 `src/effect.mjs` 的红线）。
    rulekeeper_effect: (args = {}) => effectOnce({ projectRoot: projectRootOf(args, cwd), rule: args.rule, full: args.json === true }),
    // 2026-09-19：**锚定式人签字**的纯表兜底。真正的实现需要 `ctx`（`ctx.userQuestions` / `ctx.agents`），
    // 由插件装载时注入（`plugin.mjs` 覆盖同一个键）。这里**不装空壳**：明确 fail-closed 并给理由，
    // 这样"拿不到真人应答 ⇒ 不落盘"这条在**任何**调用路径上都成立（也便于用例直接验证）。
    rulekeeper_apply: () => ({
      ok: false,
      decision: 'no-answerer',
      reason: '锚定式人签字需要宿主 ctx（userQuestions/agents）——纯 handler 表拿不到真人应答 ⇒ 拒绝落盘（请经插件装载路径调用；绝不退回 --by human 声明）',
    }),
  };
}

/**
 * **只读**生效体检（LF-A70）。
 * @returns {{ok: boolean, reason: string, counts: object, items: object[], findings: string[]}}
 */
export function effectOnce({ projectRoot, rule = null, full = false }) {
  const root = resolve(projectRoot);
  const landingDir = landingOf(root);
  const plan = effectPlan({ landingDir, projectRoot: root });
  const want = typeof rule === 'string' && rule.trim() !== '' ? canonicalRule(rule) : null;
  const items = want === null ? plan.items : plan.items.filter((i) => i.rule === want);
  const findings = plan.findings
    .filter((f) => want === null || f.rule === undefined || f.rule === want)
    .map((f) => `${f.code}(${f.severity ?? 'warn'}): ${f.message}`);
  const errors = plan.findings.filter((f) => f.severity === 'error').length;
  const textOnly = plan.findings.filter((f) => f.code === 'EFFECT_TEXT_ONLY').length;
  const summary = items.map((i) => `${i.rule}=${i.state}${i.recurredAfterActivation ? '(复发!)' : ''}`).join(' ');
  return {
    ok: plan.ok === true,
    reason: `生效体检：${items.length} 条纪律｜error 级 ${errors} 条｜只写下来了 ${textOnly} 条｜${summary || '(无)'}`,
    counts: plan.counts,
    items: full ? items : items.slice(0, 20),
    findings,
    landing: landingDir,
  };
}

/**
 * **锚定式人签字**的落盘 handler（2026-09-19）：唯一会去问真人的地方。
 *
 * 为什么必须独立成工厂而不是塞进 `defaultHandlers`：它需要 `ctx`（`ctx.userQuestions` / `ctx.agents`），
 *   而 `defaultHandlers` 是纯函数表。插件装载时把它覆盖进 handler 表即可。
 *
 * 流程（**每一步失败都不许降级**）：
 *   ① 先 dry-run 算清要写什么（算不出来 ⇒ 不问人、直接报错）
 *   ② 经 `ctx.userQuestions.ask()` 问真人（源码逐字：只有**注册表里活着的那个实例**能问，
 *      子代理被拥有 ⇒ 宿主判 `DELEGATED_CALLER`）⇒ AI 在结构上造不出应答
 *   ③ 应答 = 拒绝 / 拿不到 / 不可解析 ⇒ **一律不写**（fail-closed，**绝不退回** `--by human` 声明）
 *   ④ 应答 = 批准 ⇒ 带锚定凭证走 `applyActivation`（备份 → 写入 → 回读 → 失败回滚 → 台账）
 *
 * @param {{ctx: object, cwd?: string, now?: () => Date, applyActivationFn?: Function, askFn?: Function}} opts
 */
export function makeAnchoredApplyHandler({ ctx, cwd = process.cwd(), now = () => new Date(), applyActivationFn = applyActivation, askFn = null } = {}) {
  return async function rulekeeperApply(args = {}) {
    const projectRoot = projectRootOf(args, cwd);
    const landing = landingOf(projectRoot);
    const proposalId = typeof args.proposal === 'string' ? args.proposal.trim() : '';
    if (proposalId === '') return { ok: false, decision: 'usage', reason: '需要 proposal（提案 id）' };
    if (!isSafeId(proposalId)) return { ok: false, decision: 'usage', reason: `提案 id 不安全（只允许 [A-Za-z0-9._-] 且禁 ".."）: ${JSON.stringify(proposalId)}` };
    const apply = args.apply === true;

    // ① dry-run：先算清"要写什么"；连这一步都过不了，就不该去打扰人
    const planned = applyActivationFn({ landingDir: landing, projectRoot, proposalId, by: 'human', apply: false, now: now() });
    if (planned.ok !== true) {
      return { ok: false, decision: 'plan-failed', reason: `${planned.code}: ${planned.message}`, proposalId };
    }
    const binding = planned.additions?.binding ?? {};
    const summary = binding.kind === 'checker'
      ? `kind=checker command=${(binding.command ?? []).join(' ')} sample=${binding.redSample?.source ?? '-'}`
      : `kind=${binding.kind} carrier=${binding.carrier ?? '-'} patterns=${(planned.additions?.patterns ?? []).join(',') || '(none)'}`;

    // ② 问真人（唯一入口）。服务缺失 / 无根 agent / 抛错（含 DELEGATED_CALLER）⇒ 一律不写
    // 读法：**无 inject 要求**（`readOptionalService` 优先走 `ctx.reflect.get`）—— `userQuestions` 是可选的，
    // 不该写进 inject（写进去 = 缺服务就不装载）；但直接读未声明服务会抛，故必须走这条安全读。
    const svc = readOptionalService(ctx, 'userQuestions');
    const ask = typeof askFn === 'function' ? askFn : (svc !== null && typeof svc === 'object' && typeof svc.ask === 'function' ? svc.ask.bind(svc) : null);
    if (ask === null) {
      return { ok: false, decision: 'no-answerer', reason: '宿主没有 userQuestions 服务 ⇒ 拿不到真人应答，拒绝落盘（绝不退回 --by human 声明）', proposalId };
    }
    const agent = firstRootAgent(ctx);
    if (agent === null) {
      return { ok: false, decision: 'no-answerer', reason: '宿主注册表里没有活着的根 agent ⇒ 无法取得真人应答，拒绝落盘', proposalId };
    }
    const question = buildApprovalQuestion({ rule: planned.rule, proposalId, summary, landing: toPosix(landing) });
    let answer;
    try {
      answer = await ask({ agent, questions: [question] });
    } catch (err) {
      const code = err !== null && typeof err === 'object' && typeof err.code === 'string' ? err.code : 'ASK_FAILED';
      return { ok: false, decision: 'ask-failed', reason: `无法取得真人应答（${code}）：${String(err?.message ?? err)} ⇒ 拒绝落盘`, proposalId };
    }
    const parsed = parseApprovalAnswer(answer, question.id);
    if (parsed.decision !== 'approve') {
      return {
        ok: false,
        decision: parsed.decision === 'reject' ? 'rejected' : 'unresolved',
        reason: parsed.decision === 'reject'
          ? `真人应答为"拒绝"（${question.id}）⇒ 未做任何写入`
          : `应答无法判定为批准（${parsed.reason ?? '未选中批准项'}）⇒ 未做任何写入（fail-closed）`,
        proposalId,
      };
    }
    const approval = makeAnchoredApproval({
      questionId: question.id, decision: 'approve', question: question.question, answer,
      at: now(), agentLabel: typeof agent.id === 'string' ? agent.id : null,
    });

    // ④ 带锚定凭证落盘
    const out = applyActivationFn({ landingDir: landing, projectRoot, proposalId, by: 'human', apply, now: now(), approval });
    return {
      ok: out.ok === true,
      decision: out.ok === true ? (apply ? 'applied' : 'dry-run') : 'apply-failed',
      proposalId,
      rule: planned.rule,
      approval: `anchored(${approval.questionId}) digest=${approval.digest.slice(0, 12)}`,
      reason: out.ok === true ? String(out.code ?? 'OK') : `${out.code}: ${out.message}`,
      applied: out.applied === true,
    };
  };
}

/** 取注册表里第一个活着的根 agent（`ask()` 要求"恰好那个活着的实例"，故必须从注册表取，不能自造）
 *  读法同样走"无 inject 要求"的安全读（`agents` 是可选能力，不写进 inject）。 */
function firstRootAgent(ctx) {
  try {
    const agents = readOptionalService(ctx, 'agents');
    if (agents === null) return null;
    const list = typeof agents.roots === 'function' ? agents.roots() : null;
    if (!Array.isArray(list) || list.length === 0) return null;
    const first = list[0];
    return first !== null && typeof first === 'object' ? first : null;
  } catch {
    return null;
  }
}

/** 宿主侧固定使用的工具名（与 `PLUGIN_TOOLS` 同一命名空间） */
export const HANDLER_TOOL_NAMES = Object.freeze(['rulekeeper_gate', 'rulekeeper_record', 'rulekeeper_snap', 'rulekeeper_effect', 'rulekeeper_apply']);
