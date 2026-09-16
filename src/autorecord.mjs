// dsh-rulekeeper · LF-420 **自动记录走 `tools/result`**
//
// 判据（清单 LF-420）：
//   绿 = **不写任何东西**做一次违规动作 → 账本**自动**出现该条（`rule`/`target`/`tool`/`evidence` 路径**逐字**）；合规动作 → **0 新增行**
//   红 = 合规动作也入账 → exit≠0；字段缺失 → exit≠0
//
// 为什么选 `tools/result`（宿主契约实测，见 dsh-tools/lib/types/index.d.ts）：
//   `'tools/result'(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined`
//   宿主文档写明它是"Observe the frozen, lossless-JSON final outcome. **Listener failures are contained**"
//   —— 即：① 拿到的是**冻结的无损 JSON 结果**（可安全落盘）② **监听器抛错不会影响主流程**（"含住"）。
//   而 `pre-execute` 没有这两条保证（见 LF-460），所以"自动记账"挂在 result 侧，不挂 pre 侧。
//
// 字段来源（真实契约，不是猜的）：`ToolExecution.name: string` / `ToolExecution.arguments: unknown`（无损 JSON 可序列化）。
// 零依赖：只用 node:*。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { appendGateRow } from './gate.mjs';

/** 自动记录的台账门名（gate 字段值） */
export const AUTO_GATE = 'auto-record';
/** 台账行**必须**有的字段（红态判据：字段缺失 → exit≠0） */
export const REQUIRED_FIELDS = Object.freeze(['schema', 'ts', 'gate', 'tool', 'target', 'rule', 'evidence', 'outcome']);

/** 从 arguments 里挑"形如路径"的目标（宿主给的是无损 JSON，字段名不固定，故按候选名 + 形状判断） */
export function pickTarget(args) {
  if (args === null || typeof args !== 'object') return null;
  const keys = ['file', 'path', 'target', 'file_path', 'filePath', 'files', 'paths'];
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'string' && v !== '') return v;
    if (Array.isArray(v) && typeof v[0] === 'string' && v[0] !== '') return v[0];
  }
  return null;
}

/** 抽取执行事实（缺字段即报，不做静默垫片） */
export function extractExecution(exec) {
  const findings = [];
  if (exec === null || typeof exec !== 'object') {
    return { ok: false, tool: null, target: null, findings: [{ code: 'AUTOREC_EXEC_MISSING', message: 'tools/result 的 exec 缺失或非法（宿主契约不符）' }] };
  }
  const tool = typeof exec.name === 'string' && exec.name !== '' ? exec.name : null;
  if (tool === null) findings.push({ code: 'AUTOREC_TOOL_MISSING', message: 'exec.name 缺失：无法记录"是哪个工具"' });
  const target = pickTarget(exec.arguments);
  return { ok: findings.length === 0, tool, target, arguments: exec.arguments ?? null, findings };
}

/** 结果成功与否（冻结的无损 JSON；按常见三态判，避免猜死一种形状） */
export function classifyResult(result) {
  if (result === null || result === undefined) return { ok: false, detail: 'result 缺失' };
  if (typeof result !== 'object') return { ok: true, detail: '非对象结果（按成功处理）' };
  if (result.ok === false || result.isError === true) return { ok: false, detail: 'result 显式标失败' };
  if (result.error !== undefined && result.error !== null) return { ok: false, detail: 'result.error 存在' };
  return { ok: true, detail: 'result 正常' };
}

/**
 * 是否应当自动入账。
 * 规则（**只记违规，不记合规**——合规也入账即判红）：
 *   ① 执行**失败** → 记（`rule='EXEC_FAILED'`）
 *   ② 动了**受保护路径且本次无留证** → 记（`rule='PROTECTED_WRITE'`）
 *   其余 → 不入账
 */
export function shouldRecord({ exec, result, protection = { patterns: [] }, isProtected, hasEvidence = false } = {}) {
  const ex = extractExecution(exec);
  const res = classifyResult(result);
  const findings = [...ex.findings];
  const protectedHit = ex.target !== null && typeof isProtected === 'function'
    ? isProtected(ex.target) === true
    : false;
  if (res.ok !== true) {
    return { record: true, rule: 'EXEC_FAILED', reason: `执行失败（${res.detail}）`, tool: ex.tool, target: ex.target, findings };
  }
  if (protectedHit && hasEvidence !== true) {
    return { record: true, rule: 'PROTECTED_WRITE', reason: `动了受保护路径且本次无留证: ${ex.target}`, tool: ex.tool, target: ex.target, findings };
  }
  return { record: false, rule: null, reason: protectedHit ? '受保护路径但已有留证 → 不记' : '合规动作 → 不记', tool: ex.tool, target: ex.target, findings };
}

/** 字段级断言（红态：字段缺失 → ok=false + finding） */
export function assertRowFields(row, required = REQUIRED_FIELDS) {
  const findings = [];
  if (row === null || typeof row !== 'object') return { ok: false, findings: [{ code: 'AUTOREC_ROW_INVALID', message: '台账行不是对象' }] };
  for (const f of required) {
    const v = row[f];
    if (v === undefined || v === null || v === '') {
      findings.push({ code: 'AUTOREC_FIELD_MISSING', message: `台账行缺字段「${f}」（字段级断言：rule/target/tool/evidence 必须逐字可读）` });
    }
  }
  return { ok: findings.length === 0, findings };
}

/** 组装台账行（字段名前缀固定，便于逐字断言与后续核对） */
export function buildRow({ tool, target, rule, evidence, outcome, reason, now = new Date() }) {
  return {
    schema: 1,
    ts: now.toISOString(),
    gate: AUTO_GATE,
    tool: tool ?? '(unknown)',
    target: target ?? '(none)',
    rule: rule ?? '(none)',
    evidence: evidence ?? '(none)',
    outcome: outcome ?? 'fail',
    reason: reason ?? '',
    bypassSuspected: rule === 'PROTECTED_WRITE',
  };
}

/**
 * 自动记录（**唯一入口**）：不合规才写；写前过脱敏（与 `appendGateRow` 同源：`redactValue`）。
 * @returns {{recorded: boolean, row: object|null, findings: object[], ledgerPath: string, lines: number}}
 */
export function autoRecord({ landingDir, exec, result, isProtected, hasEvidence = false, evidence, now = new Date() } = {}) {
  const decisions = shouldRecord({ exec, result, isProtected, hasEvidence });
  const findings = [...decisions.findings];
  const ledgerPath = join(landingDir, 'logs', 'gate.jsonl');
  const before = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8').split('\n').filter((l) => l.trim() !== '').length : 0;
  if (decisions.record !== true) {
    // **合规动作 → 0 新增行**（红态判据）：这里必须什么都不写
    return { recorded: false, row: null, findings, ledgerPath, lines: before };
  }
  const row = buildRow({ tool: decisions.tool, target: decisions.target, rule: decisions.rule, evidence, outcome: 'fail', reason: decisions.reason, now });
  const check = assertRowFields(row);
  if (check.ok !== true) {
    return { recorded: false, row, findings: [...findings, ...check.findings], ledgerPath, lines: before };
  }
  // 落盘**复用门禁台账的写入单点**（`appendGateRow`：写前过 `redactValue` 脱敏，LF-340）——不另起一套。
  const appended = appendGateRow(landingDir, row);
  if (appended.ok !== true) findings.push({ code: 'AUTOREC_LEDGER_FAILED', message: `自动记账写入失败: ${appended.reason}` });
  const after = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8').split('\n').filter((l) => l.trim() !== '').length : before;
  return { recorded: appended.ok === true, row, findings, ledgerPath, lines: after, delta: after - before };
}
