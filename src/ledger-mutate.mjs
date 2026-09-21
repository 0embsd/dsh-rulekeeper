// ledger-mutate.mjs —— **改一条已有教训行**的纯函数层（2026-09-21，交接第 3 步）
//
// 为什么需要它（现场症状）：账本是 append-only，"这条机械面登记错了 / 证据写错了 / 决策被推翻了"
//   目前只有一条路 —— **手工改 ledger.jsonl**。而手工改绕过了所有机制：没有备份、没有回读校验、
//   没有"谁在什么时候改的"记录，正则一不小心还把别的行改坏。
//
// 设计（与既有机制对齐，不新造概念）：
//   · **不改历史行**：把改后的整行作为**归档行**（`mechanism: 'mutate'`，`evidence` 首项带
//     `MUTATES <id>` 标记）追加，再写一条 `状态事件` 行把旧行 `STATUS_SUPERSEDE` 掉。
//     ⇒ 效果上"这条教训的样子变了"，物理上历史逐字节不变（读侧 fold 已有：`supersededIds()`）。
//   · **纯函数**：本模块只算"要追加哪两行"，不碰文件；写盘由 src/authier.mjs 负责（备份 + 回读 + 原子替换）。
//   · **幂等**：同一 id 已有未被取代的归档行 ⇒ 不再重复追加（返回 `already`）。
//
// 归属：core 模块。零依赖：只用 node:*。

import { STATUS_EVENT_CATEGORY } from './ledger.mjs';
import { canonicalRule } from './ruleid.mjs';

/** 归档行的类目标记（写在 `mechanism` 里；不改冻结契约的字段集合） */
export const MUTATE_MECHANISM = 'mutate';
/** 归档行的标记前缀（写在 `evidence[0]`） */
export const MUTATE_MARK = 'MUTATES';

/** 允许改的字段（**白名单**：id/ts/rule 身份字段不许改 —— 改了就不是"同一条教训"了） */
export const MUTABLE_FIELDS = Object.freeze(['problem', 'root_cause', 'solution', 'mechanism', 'guard_ref', 'category', 'evidence']);
/** 记账字段（归档行里保留：谁改的、为什么改） */
export const MUTATE_META_FIELDS = Object.freeze(['by', 'reason']);

/**
 * 解析 `--set` 形态：`<字段>=<值>` 或 `证据加=<文本>`（可重复）。
 * @returns {{ok: boolean, sets: object, addEvidence: string[], problems: string[]}}
 */
export function parseSets(list = []) {
  const sets = {};
  const addEvidence = [];
  const problems = [];
  for (const raw of list) {
    const s = String(raw ?? '');
    const i = s.indexOf('=');
    if (i <= 0) {
      problems.push(`--set 必须是 <字段>=<值>（实得 ${JSON.stringify(s)}）`);
      continue;
    }
    const key = s.slice(0, i).trim();
    const value = s.slice(i + 1);
    if (key === '证据加') {
      if (value.trim() === '') problems.push('证据加= 的值不得为空');
      else addEvidence.push(value.trim());
      continue;
    }
    if (!MUTABLE_FIELDS.includes(key)) {
      problems.push(`字段 ${JSON.stringify(key)} 不可改（可改：${MUTABLE_FIELDS.join('/')}；身份字段 id/ts/rule 一律禁改）`);
      continue;
    }
    if (value.trim() === '' && key !== 'evidence') problems.push(`字段 ${key} 不得改成空值`);
    else sets[key] = value;
  }
  return { ok: problems.length === 0, sets, addEvidence, problems };
}

/**
 * 算"要把这条教训改成什么样"（纯函数，不写盘）。
 *
 * @param {object[]} rows 账本全部行（原始顺序）
 * @param {{targetId: string, sets?: object, addEvidence?: string[], by: string, reason: string, now?: Date, newId?: string}} opts
 * @returns {{ok: boolean, problems?: string[], oldRow?: object, newRow?: object, statusRow?: object, changed?: string[], already?: boolean}}
 */
export function planMutation(rows = [], opts = {}) {
  const problems = [];
  const targetId = typeof opts.targetId === 'string' ? opts.targetId.trim() : '';
  if (targetId === '') problems.push('缺 targetId（要改哪一条）');
  const by = typeof opts.by === 'string' ? opts.by.trim() : '';
  if (by === '') problems.push('缺 --by（谁改的；这是**声明**，不是签名 —— 与 `--by human` 同族）');
  const reason = typeof opts.reason === 'string' ? opts.reason.trim() : '';
  if (reason === '') problems.push('缺原因（为什么改；空原因 = 事后无从审计）');
  const sets = opts.sets ?? {};
  const addEvidence = Array.isArray(opts.addEvidence) ? opts.addEvidence.map(String) : [];
  if (Object.keys(sets).length === 0 && addEvidence.length === 0) problems.push('没有任何要改的内容（--set 或 证据加=）');
  if (problems.length > 0) return { ok: false, problems };

  const alive = rows.filter((r) => r !== null && typeof r === 'object');
  const oldRow = alive.find((r) => String(r.id ?? '') === targetId) ?? null;
  if (oldRow === null) return { ok: false, problems: [`账本里没有 id=${targetId} 的条目`] };

  // 幂等：已经有一条**未被取代**的归档行指向同一个 id ⇒ 不再重复追加（重复条目会把正确教训挤出 top-1）
  const superseded = new Set();
  for (const row of alive) {
    if (row.category !== STATUS_EVENT_CATEGORY) continue;
    const m = /STATUS_SUPERSEDE\s+([A-Za-z0-9._,-]+)/.exec(String(row.problem ?? ''));
    if (m === null) continue;
    for (const id of m[1].split(',')) if (id.trim() !== '') superseded.add(id.trim());
  }
  const already = alive.some((r) => String(r.mechanism ?? '') === MUTATE_MECHANISM
    && Array.isArray(r.evidence) && r.evidence.some((e) => String(e).includes(`${MUTATE_MARK} ${targetId}`))
    && !superseded.has(String(r.id ?? '')));
  if (already) return { ok: true, already: true, oldRow, changed: [] };

  const now = opts.now instanceof Date ? opts.now : new Date();
  const changed = [];
  const next = { ...oldRow };
  for (const [key, value] of Object.entries(sets)) {
    if (key === 'evidence') continue;   // evidence 只走 `证据加=`（整表替换太容易误删）
    const current = next[key] ?? '';
    if (String(current) === String(value)) continue;
    next[key] = value;
    changed.push(key);
  }
  if (addEvidence.length > 0) {
    next.evidence = [...(Array.isArray(next.evidence) ? next.evidence : []), ...addEvidence];
    changed.push(`evidence+${addEvidence.length}`);
  }
  if (changed.length === 0) return { ok: false, problems: ['所有 --set 与现值相同 ⇒ 没有可改的内容'] };

  // 归档行：新 id（新行必须有自己的身份），其余字段沿用
  const newId = typeof opts.newId === 'string' && opts.newId !== '' ? opts.newId : null;
  if (newId === null) problems.push('内部错误：缺 newId');
  if (problems.length > 0) return { ok: false, problems };

  const newRow = {
    ...next,
    id: newId,
    ts: now.toISOString(),
    mechanism: MUTATE_MECHANISM,
    evidence: [`${MUTATE_MARK} ${targetId}`, ...(Array.isArray(next.evidence) ? next.evidence : [])],
    recurrence: 1,
    first_seen: now.toISOString(),
    last_seen: now.toISOString(),
    status: 'active',
  };
  // 归档行**不进**"这条纪律又踩了一次"的计数（它是同一条教训的改写），读侧按 mechanism 跳过
  const statusRow = {
    schema: oldRow.schema ?? 1,
    id: `${newId}-status`,
    ts: now.toISOString(),
    rule: canonicalRule(String(oldRow.rule ?? '')),
    category: STATUS_EVENT_CATEGORY,
    problem: `STATUS_SUPERSEDE ${targetId}`,
    root_cause: `按 ${by} 的要求改写该条（原因：${reason}）`,
    solution: `归档行 ${newId} 取代 ${targetId}；历史行逐字节不变（append-only），读侧由 src/ledger.mjs 的 supersededIds() fold`,
    evidence: [`${MUTATE_MARK} ${targetId}`, `by=${by}`],
    mechanism: MUTATE_MECHANISM,
    recurrence: 1,
    first_seen: now.toISOString(),
    last_seen: now.toISOString(),
    status: 'active',
  };
  return { ok: true, oldRow, newRow, statusRow, changed };
}
