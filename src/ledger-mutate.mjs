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

/** 归档行的类目标记（写在 `category` 里）—— **这是"我是改写行"的身份** */
export const MUTATE_CATEGORY = '教训改写';
/**
 * 归档行的 `mechanism` 里保留的**迁移标记**（与 `category` 双保险，便于人读）。
 *
 * **重要教训（写这行时实测踩到两次）**：`mechanism` 字段承担两个角色会打架 ——
 * ①它是"这条教训的机制面"（要被 fold 到目标 id 上）；②我曾用它当"我是迁移记录"的身份标记。
 * 结果：`mutate --set mechanism=question` 的**改后值**被身份标记 `mutate` 覆盖
 * ⇒ fold 出来还是旧值（P2 的修法当场失效）。故身份标记改用 `category`，`mechanism` 只存改后值。
 */
export const MUTATE_MECHANISM = 'mutate';
/** 归档行的标记前缀（写在 `evidence[0]`） */
export const MUTATE_MARK = 'MUTATES';
/**
 * 归档行**会覆盖**目标 id 的字段（读侧 fold 用的字段表）。
 *
 * 与 `MUTABLE_FIELDS` 不同：不含 `evidence`（证据是**追加**语义，不是覆盖），也不含身份字段（本来禁改）。
 * 读侧把这些字段从归档行搬到目标 id 上 —— 这样"改了 mechanism 但检查器读旧值"的**静默降级**才不存在。
 */
export const MUTATE_FOLD_FIELDS = Object.freeze(['problem', 'root_cause', 'solution', 'mechanism', 'guardRef', 'guard_ref']);
/**
 * 归档行**不会**搬给目标 id 的字段（读侧 fold 的排除表）。
 *
 * 为什么单独写出来：这些字段是**身份**（"这条是我改的、我是哪条纪律"），不是被改的**内容**。
 * 搬了会出事：`category` 一搬，fold 出来的那条就变成 `教训改写` ⇒ 消费方"排除迁移记录"的判据
 * 又会把它排除（**改了等于没改**，实测踩到）。`id`/`ts` 同族：读侧另有安排（保留目标 id）。
 */
export const MUTATE_FOLD_EXCLUDED = Object.freeze(['id', 'ts', 'category', 'rule', 'evidence', 'recurrence', 'first_seen', 'last_seen', 'status']);
/**
 * 归档行里记"**改写前的 mechanism**"的旧标记 —— **已废弃**（保留常量只为让旧数据可被识别）。
 *
 * 它存在的理由是"归档行的 mechanism 被当身份标记"这个设计错误（见 `MUTATE_MECHANISM` 的注释）。
 * 身份改用 `category` 之后不再需要：归档行的 `mechanism` 直接就是**改后值**。
 * @deprecated 新写的归档行不带它；读侧也不需要它。
 */
export const MUTATE_PRIOR_MARK = 'PRIOR';

/**
 * **读侧 fold**：把归档行的字段值应用回它取代的那条 id（2026-09-21，被治理项目侧 P2）。
 *
 * 为什么必须有：写侧能改字段，但读侧各消费方（检查器、体检、adopt）各自读原始行 ⇒
 * `mutate --set mechanism=question` 之后检查器**仍读到旧值**，把 `question` 静默降级成 `text`。
 * 被治理项目因此直接**禁用**了这个方法（宁可留一笔"方法违规"，也不做"看起来洗白了、实际降级"的操作）。
 *
 * 语义与 `supersededIds()` 配套：被取代的旧行**不再出现在结果里**，取而代之的是**应用过归档行字段**的新行
 * （保留目标 id —— 消费方按 id 认这条教训）。归档行自己**不出现**在结果里（它是迁移记录）。
 *
 * @param {object[]} rows 账本全部行
 * @returns {object[]} fold 之后的行（顺序按"取代后的位置"，即旧行的位置）
 */
export function foldMutates(rows = []) {
  const list = rows.filter((r) => r !== null && typeof r === 'object');
  const byId = new Map();
  for (const r of list) if (typeof r.id === 'string' && r.id !== '') byId.set(r.id, r);

  // 1) 收集归档行 → 目标 id → 覆盖字段
  const overrides = new Map();
  const archiveIds = new Set();
  for (const r of list) {
    if (String(r.category ?? '') !== MUTATE_CATEGORY) continue;    // 身份看**类目**（不看 mechanism）
    const ev0 = Array.isArray(r.evidence) ? r.evidence.map(String) : [];
    const mark = ev0.find((e) => e.startsWith(`${MUTATE_MARK} `));
    if (mark === undefined) continue;                              // 没有标记 ⇒ 不是归档行
    const targetIds = mark.slice(MUTATE_MARK.length + 1).split(',').map((s) => s.trim()).filter((s) => s !== '');
    archiveIds.add(String(r.id ?? ''));
    for (const tid of targetIds) {
      const patch = {};
      for (const f of MUTATE_FOLD_FIELDS) if (Object.hasOwn(r, f)) patch[f] = r[f];
      overrides.set(tid, { ...(overrides.get(tid) ?? {}), ...patch });
    }
  }
  // 注意：**不要**在这里提前 `return list`（"没有覆盖就原样返回"）—— 那样"迁移记录不进结果"这条
  // 就只在"有字段覆盖时"才生效，实测会把状态事件行留在结果里（消费方当它是一条教训）。
  // 无论如何都走下面的过滤，保证"fold 的产物 = 纯教训行"。

  // 2) 被取代的 id（含归档行点名的目标）与归档行本身都从结果里去掉；目标 id 换成"应用过字段"的行
  const superseded = new Set();
  for (const r of list) {
    if (r.category !== '状态事件') continue;
    const m = /STATUS_SUPERSEDE\s+([A-Za-z0-9._,-]+)/.exec(String(r.problem ?? ''));
    if (m === null) continue;
    for (const id of m[1].split(',')) if (id.trim() !== '') superseded.add(id.trim());
  }
  const out = [];
  for (const r of list) {
    const id = String(r.id ?? '');
    // **迁移记录一律不进结果**：归档行（有 `MUTATES` 标记）与状态事件行（`STATUS_SUPERSEDE`）都是
    // "这次改写"的记账，不是教训。留一条在结果里，消费方就会把它当教训（实测：机制面统计多出一条
    // `mechanism=mutate`）。**判据按标记/类目，不按 mechanism** —— 两类都是 `mechanism=mutate`。
    if (archiveIds.has(id)) continue;
    // **顺序要紧**：这一条必须在 `superseded.has(id)` **之前**判。写反过一次：真实账本里状态行的 id
    // 是 `<归档行id>-status`，而它 `problem` 里写着 `STATUS_SUPERSEDE L-A`；若先走取代分支，
    // 状态行会以 **id=`L-A`** 落进结果、把真正的教训行**覆盖**掉（实测输出 `L-A/mutate/STATUS_SUPERSEDE L-A`）。
    if (r.category === '状态事件' || /^STATUS_SUPERSEDE\b/.test(String(r.problem ?? ''))) continue;
    if (superseded.has(id)) {
      const patch = overrides.get(id);
      if (patch === undefined) continue;                            // 被取代但无字段覆盖 ⇒ 就是删掉
      const base = byId.get(id) ?? {};
      out.push({ ...base, ...patch, id, evidence: base.evidence ?? r.evidence ?? [] });
      continue;
    }
    out.push(r);
  }
  return out;
}

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
  const already = alive.some((r) => String(r.category ?? '') === MUTATE_CATEGORY
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
    // **身份用类目**（不是 mechanism）：`mechanism` 留给**改后值**，否则 P2 的 fold 白做（见常量注释）。
    category: MUTATE_CATEGORY,
    evidence: [
      `${MUTATE_MARK} ${targetId}`,
      ...(Array.isArray(next.evidence) ? next.evidence : []),
    ],
    recurrence: 1,
    first_seen: now.toISOString(),
    last_seen: now.toISOString(),
    status: 'active',
  };
  // 归档行**不进**"这条纪律又踩了一次"的计数（它是同一条教训的改写），读侧按 `category` 跳过
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
