// approval.mjs —— **锚定式人签字**（2026-09-19，把"自称 human"升级为"宿主问出来的真人应答"）
//
// 问题（本仓自己自曝过，规则 43）：`rk-effect apply --by human` 里的 `--by human` **只是一个字符串**，
//   AI 同样能敲 `--by human` ⇒ 那是"声明"，不是签名。而 `rules.json` 是**生效面本身**
//   （改它 = 改哪条纪律真的会被拦），所以"人签字"这一步必须真锚住。
//
// 锚在哪：宿主的**人机问答通道** `ctx.userQuestions.ask()`（`@deepseek-ai/dsh-user-questions`）。
//   它的边界是**运行时归属**，不是会话血缘（源码 `lib/types/index.d.ts` 的 ask() 文档逐字）：
//     · 传入的 agent 必须是注册表里**恰好那个活着的**实例，否则 `CALLER_NOT_LIVE`
//     · 该 agent 若**被别的 agent 拥有**（子代理）⇒ `DELEGATED_CALLER`
//   ⇒ **AI 在结构上造不出应答**：子代理调不通，普通 agent 也拿不到"另一个活着的根实例"的应答。
//
// 本模块只做三件事（把"能不能锚"与"锚了之后怎么记账"分开，便于单测）：
//   ① 造问句（选项标签写死：批准落盘 / 拒绝；**不从选项顺序推断结论**）
//   ② 解析应答（把 selected 归一成 approve / reject / unknown）
//   ③ 造/验锚定凭证（写进账本与 findings 的 evidence：谁问的、问的什么哈希、答了什么、什么时候）
//
// 诚实边界（照本仓惯例自曝）：本模块的凭证是**可核对**（问答内容进宿主会话记录、可人工比对），
//   **不是密码学签名** —— 能改落点文件的人仍能把凭证字段抄进去。防伪造在**流程层**：
//   ① 提供者（`rulekeeper_apply` 工具）是唯一会去问真人的地方，且**问不通就 fail-closed 不落盘**；
//   ② 落点可配 `requireAnchoredApproval: true` ⇒ 没有锚定凭证一律拒绝写（CLI 也拦）。
//
// 归属：core 模块。零依赖：只用 node:*。

import { createHash } from 'node:crypto';

/** 选项标签（写死：**结论从标签来，不从顺序来** —— 顺序推断是脆的） */
export const APPROVAL_APPROVE_LABEL = '批准落盘';
export const APPROVAL_REJECT_LABEL = '拒绝';
export const APPROVAL_DECISIONS = Object.freeze(['approve', 'reject', 'unknown']);
/** 凭证来源标记：只有本值算"锚定"（其余一律按"声明"处理，并且如实标注） */
export const ANCHOR_SOURCE = 'user-questions';

/**
 * **审批通道不可用**的判定（2026-09-21，交接 A1）。
 *
 * 现场问题：审批提示被禁用的会话里，`rulekeeper_apply` 每次都回"应答无法判定为批准" ——
 * 那句话让人**分不清**"我拒绝了""我没看到问题""这条路根本不通"。三者对处置完全不同：
 *   · rejected   ⇒ 人要改主意才能继续；
 *   · unknown    ⇒ 应答形状对不上（可能是宿主版本/协议漂移）；
 *   · 不可用     ⇒ 这条路在当前会话**走不通**，要么换会话、要么走 CLI 的等价命令。
 * 形状上，后者 = 拿不到**本问题**的应答项，或应答项里一个选项都没选中（空应答）。
 */
export function answererUnavailable(parsed) {
  if (parsed === null || typeof parsed !== 'object') return true;
  if (parsed.decision !== 'unknown') return false;
  const selected = Array.isArray(parsed.selected) ? parsed.selected : [];
  if (selected.length > 0) return false;                          // 选了别的 → 真的是"未批准"
  const reason = String(parsed.reason ?? '');
  if (reason.includes('形状不合法') || reason.includes('没有 questionId')) return false;  // 协议问题，不是"人没答"
  return true;                                                     // 空应答 / 没有本题的答案
}

/** 造一条审批问句（交给 `ctx.userQuestions.ask()`） */
export function buildApprovalQuestion({ rule, proposalId, summary, landing } = {}) {
  const id = `rk-apply-${String(proposalId ?? 'unknown')}`;
  return {
    id,
    header: '纪律落盘审批',
    question: `是否批准把提案 ${proposalId ?? '?'} 落盘为纪律 ${rule ?? '?'} 的生效绑定？`,
    detail: [
      summary ?? '(无变更摘要)',
      '',
      `落点：${landing ?? '(未知)'}`,
      '批准后：备份 → 写入 rules.json → 回读校验 → 失败回滚 → 记台账。',
      '拒绝后：什么都不写。',
    ].join('\n'),
    options: [
      { label: APPROVAL_APPROVE_LABEL, description: '按摘要落盘，并记录本次问答作为凭证' },
      { label: APPROVAL_REJECT_LABEL, description: '保持现状，不做任何写入' },
    ],
  };
}

/**
 * 解析宿主应答。
 * @param {{answers?: {id: string, selected?: string[], custom?: string}[]}|null} answer
 * @param {string} questionId
 * @returns {{decision: 'approve'|'reject'|'unknown', selected: string[], custom: string|null, reason: string|null}}
 */
export function parseApprovalAnswer(answer, questionId) {
  const list = answer !== null && typeof answer === 'object' && Array.isArray(answer.answers) ? answer.answers : null;
  if (list === null) return { decision: 'unknown', selected: [], custom: null, reason: '应答形状不合法（缺 answers 数组）' };
  const item = list.find((a) => a !== null && typeof a === 'object' && a.id === questionId);
  if (item === undefined) return { decision: 'unknown', selected: [], custom: null, reason: `应答里没有 questionId=${questionId}（问与答必须一一对应）` };
  const selected = Array.isArray(item.selected) ? item.selected.map(String) : [];
  const custom = typeof item.custom === 'string' && item.custom.trim() !== '' ? item.custom.trim() : null;
  if (selected.includes(APPROVAL_APPROVE_LABEL)) return { decision: 'approve', selected, custom, reason: null };
  if (selected.includes(APPROVAL_REJECT_LABEL)) return { decision: 'reject', selected, custom, reason: null };
  return { decision: 'unknown', selected, custom, reason: `未选中"${APPROVAL_APPROVE_LABEL}"或"${APPROVAL_REJECT_LABEL}"（如走自定义文本，一律按未批准处理，fail-closed）` };
}

/** 问句/应答的**内容指纹**（写进凭证：便于人工比对"我问的是不是这个"） */
export function approvalDigest({ question, answer }) {
  return createHash('sha256')
    .update(`${String(question ?? '')}\u0000${JSON.stringify(answer ?? null)}`, 'utf8')
    .digest('hex');
}

/**
 * 造锚定凭证（**只有拿到真人应答的提供者才应该调用它**）。
 * @returns {{source: string, questionId: string, decision: string, digest: string, at: string, askedVia: string, agentLabel: string|null}}
 */
export function makeAnchoredApproval({ questionId, decision, question, answer, at = new Date(), agentLabel = null, askedVia = ANCHOR_SOURCE } = {}) {
  return {
    source: askedVia,
    questionId: String(questionId ?? ''),
    decision,
    digest: approvalDigest({ question, answer }),
    at: (at instanceof Date ? at : new Date(at)).toISOString(),
    askedVia,
    agentLabel: agentLabel === null ? null : String(agentLabel),
  };
}

/**
 * 校验锚定凭证。**只有四种情况算"锚定"**：来源正确、有 questionId、decision 合法、digest 是 64 hex、at 是合法时间。
 * @returns {string[]} 问题列表（空 = 合法）
 */
export function validateAnchoredApproval(ev) {
  const problems = [];
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) return ['凭证不是对象'];
  if (ev.source !== ANCHOR_SOURCE) problems.push(`source 必须是 ${ANCHOR_SOURCE}（实得 ${JSON.stringify(ev.source)}）—— 其它来源一律按"声明"处理`);
  if (typeof ev.questionId !== 'string' || ev.questionId.trim() === '') problems.push('缺 questionId（问与答必须一一对应）');
  if (!APPROVAL_DECISIONS.includes(ev.decision)) problems.push(`decision 必须是 ${APPROVAL_DECISIONS.join('/')}（实得 ${JSON.stringify(ev.decision)}）`);
  if (typeof ev.digest !== 'string' || !/^[0-9a-f]{64}$/i.test(ev.digest)) problems.push('digest 必须是 64 位十六进制 sha256');
  if (typeof ev.at !== 'string' || Number.isNaN(Date.parse(ev.at))) problems.push('at 必须是合法 ISO 时间');
  return problems;
}

/** 一句话描述写进账本用（**不假装是签名**，逐字区分"锚定"与"声明"） */
export function describeApproval(approval) {
  if (approval === null || approval === undefined) return 'approval=declared(--by human 字符串；非锚定)';
  const problems = validateAnchoredApproval(approval);
  if (problems.length > 0) return `approval=invalid(${problems[0]})`;
  return `approval=anchored(${approval.questionId}) decision=${approval.decision} digest=${approval.digest.slice(0, 12)}`;
}
