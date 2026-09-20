// annotations.mjs —— **给既有 append-only 行补 activation 的协议层**（2026-09-19，objective ②）
//
// 协议问题（本轮必须解决的那个）：账本 `ledger.jsonl` 是 **append-only**（LF-120 冻结单：行不可原地改写，
//   可变字段一律派生）。而 `activation` 是**行内字段** ⇒ 想给 385 条既有教训补"什么时候该想起它"，
//   直接改行就是**违宪**；另起一行复制正文补字段更糟：E2 实验已证明"重复条目会把正确教训挤出 top-1"。
//
// 解法：**注解层**（sidecar），不碰账本一个字节：
//   · 新文件 `<落点>/activations.jsonl`（append-only，一行一条注解）
//   · 形状：`{schema, ts, id, activation, by, confidence, evidence}` —— `id` 指向账本行的 `id`
//   · 读侧**合并视图**：`activationOf(mergeActivation(row, byId))`，故体检覆盖率、注入正文都能看到条件
//   · 账本行**逐字节不变**（有用例钉住这条：写完注解后 ledger 的 sha256 与写前一致）
//
// 为什么要新文件而不是塞进 `findings.jsonl`：那个文件的语义是"一次判定一条"（severity/action 枚举），
//   注解不是判定。契约里对"新增文件"的规定是走 §9.8 式契约变更并同步全部消费方 —— 本模块 + `schema.mjs`
//   的冻结单（6 → 7）+ `doctor` 的健康检查 + `baseline` 的自产物清单就是那次同步。
//
// 归属：core 模块。零依赖：只用 node:*。

import { join } from 'node:path';

import { appendLine, readLines } from './append.mjs';

export const ACTIVATIONS_FILE = 'activations.jsonl';
/** 注解作者（**声明**，不是签名 —— 与 `--by human` 同族，见规则 43 的自曝要求） */
export const ANNOTATION_AUTHORS = Object.freeze(['machine', 'human']);
export const ANNOTATION_MAX_CHARS = 300;

/** 占位符黑名单（与 effect.mjs 的 ACTIVATION_PLACEHOLDERS 同源语义；此处避免循环依赖而重复字面量） */
const PLACEHOLDERS = Object.freeze(['todo', 'tbd', 'n/a', 'na', '待补', '待定', '待写', '无', '-']);

/** 泛指词：只有这些词的"条件"不可机械判定 ⇒ 不合格 */
const VAGUE = Object.freeze(['注意', '小心', '谨慎', '相关时', '必要时', '视情况', '尽量', '适当']);

const RE_EXT = /[\w-]+\.(?:mjs|cjs|js|ts|md|json|jsonl|ps1|psm1|go|py|sh|bash|yml|yaml|toml|txt|cfg|ini)\b/i;
const RE_PATHISH = /(?:^|[\s（(“"'])(?:\.{0,2}[\/\\])?[\w.@-]+[\/\\][\w./\\@-]+/;
const RE_GLOB = /[*?]/;
const RE_COMMAND = /\b(?:rk-[a-z][a-z-]*|dsh-[a-z][a-z-]*|git|node|npm|pnpm|python|pwsh|powershell|go|cargo|docker|make)\b/;
const RE_ERRORISH = /\b(?:exit|stderr|stdout|ERR-|error|deny|throw|panic|失败|报错|拒绝|超时|不一致|漂移|回归)\b/i;

/**
 * 这条 activation **是否可机械判定**（"可观测锚点"≥1）。
 *
 * 为什么必须机检而不是靠人读：E1 实验里 10/10 条"机器起草"的四要件都不合规，根因不是措辞差，
 *   而是**根本没有可观测锚点**。所以"可判"必须是一个能判的函数，否则覆盖率涨了而质量没涨。
 * @returns {{ok: boolean, reasons: string[]}}
 */
export function validateActivation(text) {
  const reasons = [];
  const s = typeof text === 'string' ? text.trim() : '';
  if (s === '') return { ok: false, reasons: ['为空'] };
  if (s.length < 8) reasons.push(`太短（${s.length} < 8 字符，通常不足以说清条件）`);
  if (s.length > ANNOTATION_MAX_CHARS) reasons.push(`太长（${s.length} > ${ANNOTATION_MAX_CHARS}）`);
  if (PLACEHOLDERS.includes(s.toLowerCase())) reasons.push('是占位符');
  const anchors = [];
  if (RE_EXT.test(s)) anchors.push('文件扩展名');
  if (RE_PATHISH.test(s)) anchors.push('路径/目录');
  if (RE_GLOB.test(s)) anchors.push('通配符');
  if (RE_COMMAND.test(s)) anchors.push('命令/工具名');
  if (RE_ERRORISH.test(s)) anchors.push('错误/退出码/失败形态');
  if (anchors.length === 0) {
    const vague = VAGUE.filter((v) => s.includes(v));
    reasons.push(vague.length > 0
      ? `只有泛指词（${vague.join('、')}），没有可观测锚点（路径/通配符/命令/错误串）`
      : '没有可观测锚点（路径/通配符/命令/错误串）');
  }
  return { ok: reasons.length === 0, reasons, anchors };
}

/** 读注解流（容错：坏行计数，不抛） */
export function readAnnotations(landingDir) {
  const read = readLines(join(landingDir, ACTIVATIONS_FILE));
  const values = read.values.filter((r) => r !== null && typeof r === 'object');
  return { values, badLines: read.badLines, missing: read.missing === true, truncatedTail: read.truncatedTail === true };
}

/**
 * `id → 注解` 合并视图。**后写的覆盖先写的**（同一 id 多次注解 = 改判，历史仍在文件里）。
 * @returns {Map<string, {activation: string, by: string, ts: string|null, confidence: string|null, evidence: string[]}>}
 */
export function activationsById(landingDir) {
  const map = new Map();
  for (const row of readAnnotations(landingDir).values) {
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    const activation = typeof row.activation === 'string' ? row.activation.trim() : '';
    if (id === '' || activation === '') continue;
    map.set(id, {
      activation,
      by: typeof row.by === 'string' ? row.by : 'unknown',
      ts: typeof row.ts === 'string' ? row.ts : null,
      confidence: typeof row.confidence === 'string' ? row.confidence : null,
      evidence: Array.isArray(row.evidence) ? row.evidence.map(String) : [],
    });
  }
  return map;
}

/**
 * 合并视图（**只在行内为空时**用注解补）：行内已有的 activation 优先 —— 它是最接近事实的写入时声明。
 * @returns {object} 新的行对象（不改原对象）
 */
export function mergeActivation(row, byId) {
  if (row === null || typeof row !== 'object') return row;
  const has = typeof row.activation === 'string' && row.activation.trim() !== '';
  if (has) return row;
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  const ann = byId instanceof Map ? byId.get(id) : undefined;
  if (ann === undefined) return row;
  return { ...row, activation: ann.activation, activationSource: ann.by };
}

/**
 * 写一条注解（append-only；**不碰账本**）。
 * @param {{id:string, activation:string, by?:string, confidence?:string, evidence?:string[]}} input
 * @returns {{ok: boolean, reason: string|null, bytes: number}}
 */
export function appendAnnotation(landingDir, input = {}, opts = {}) {
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  const activation = typeof input.activation === 'string' ? input.activation.trim() : '';
  const by = input.by ?? 'machine';
  const now = opts.now instanceof Date ? opts.now : new Date();
  if (id === '') return { ok: false, reason: '注解缺 id（指向账本行）', bytes: 0 };
  if (!ANNOTATION_AUTHORS.includes(by)) return { ok: false, reason: `by 只能是 ${ANNOTATION_AUTHORS.join('|')}`, bytes: 0 };
  const verdict = validateActivation(activation);
  if (!verdict.ok) return { ok: false, reason: `activation 不合格: ${verdict.reasons.join('；')}`, bytes: 0 };
  const row = {
    schema: 1,
    ts: now.toISOString(),
    id,
    activation,
    by,
    ...(typeof input.confidence === 'string' && input.confidence !== '' ? { confidence: input.confidence } : {}),
    evidence: Array.isArray(input.evidence) ? input.evidence.map(String) : [],
  };
  const appended = appendLine(join(landingDir, ACTIVATIONS_FILE), row, { maxLineBytes: opts.maxLineBytes });
  return { ok: appended.ok === true, reason: appended.reason ?? null, bytes: appended.bytes ?? 0, row };
}
