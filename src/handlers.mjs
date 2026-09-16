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
import { record as ledgerRecord } from './ledger.mjs';
import { resolveProjectLanding } from './platform/paths.mjs';
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
  const out = takeSnapshot({ projectRoot: root, landingDir, file: path, why: why ?? 'rulekeeper_snap（插件工具）' });
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
  };
}

/** 宿主侧固定使用的工具名（与 `PLUGIN_TOOLS` 同一命名空间） */
export const HANDLER_TOOL_NAMES = Object.freeze(['rulekeeper_gate', 'rulekeeper_record', 'rulekeeper_snap']);
