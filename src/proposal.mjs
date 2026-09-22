// dsh-rulekeeper · LF-280/290/295 自进化提案（**闸先于写者**：只产提案，绝不写 rules.json）
//
// 设计边界（对齐方案 §2 的"进化边界（诚实）"）：
//   系统**不发明新规则**，它做的是"把已经踩过 ≥2 次的坑，自动提案升级为机械判据"。
//   因此本模块的产物只有一种：`<落点>/proposals/<id>.json`（LF-120 冻结的 6 文件之一）。
//   **闸门本身不可被 AI 直接改**：`rules.json` 只读不写（LF-280 判据 = 跑完 evolve 后 rules.json sha256 不变）；
//   升门禁（gate escalation）必须由人触发（`source=human`），`source=auto` 单独触发一律拒绝（LF-295 红态）。
//
// 提案质量门（LF-295）：四要件缺一不可 —— redCriteria / counterExample / falsePositiveSurface / activationCheck。
//   它们**只能显式提供**（`--quality <file.json>` 或 CLI 逐个给），不从账本条目"推定"——
//   账本里的 mechanism 不是红态判据，推定等于把"提案质量"降级成"复制粘贴"，门就白设了。
//
// 归属：core 模块。零依赖：只用 node:*。

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { redactValue } from './redact.mjs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { FILES, SCHEMA_VERSION } from './schema.mjs';
import { canonicalRule } from './ruleid.mjs';

export const PROPOSALS_DIR = 'proposals';
/** 复发几次才够格提案（方案 §2："同一 rule 复发 +1 … recurrence ≥ 2 → 自动提案"） */
export const RECURRENCE_THRESHOLD = 2;
/** LF-295 四要件（字段名取 LF-120 冻结表，不改契约） */
export const PROPOSAL_QUALITY_FIELDS = Object.freeze([
  'redCriteria', 'counterExample', 'falsePositiveSurface', 'activationCheck',
]);
export const PROPOSAL_SOURCES = Object.freeze(['auto', 'human']);
export const PROPOSAL_STATUSES = Object.freeze(['proposed', 'approved', 'rejected']);

/** 提案 id：P-<UTC 时间戳>-<6 hex>（与账本同方案：不依赖扫描，故并发下也不撞） */
export function makeProposalId(now = new Date(), random = () => randomBytes(3).toString('hex')) {
  const pad = (n) => String(n).padStart(2, '0');
  const ts = [
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`,
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`,
  ].join('');
  return `P-${ts}-${random()}`;
}

export function proposalsDir(landingDir) {
  return join(landingDir, PROPOSALS_DIR);
}

export function proposalPath(landingDir, id) {
  return join(proposalsDir(landingDir), `${id}.json`);
}

/** 冻结契约的字段定义（**从 LF-120 定义读**，不手抄字面量——防两处漂移） */
export function proposalFieldDefs() {
  const file = FILES.find((f) => f.name === 'proposals/<id>.json');
  if (file === undefined) throw new Error('schema 里没有 proposals/<id>.json 定义');
  return file.fields;
}

/** 冻结契约的字段名集合 */
export function proposalFieldNames() {
  return proposalFieldDefs().map((f) => f.name);
}

/**
 * 值域校验（LF-295 复核 B/S5 换来的）：`assertProposalShape` 只管"字段集合对不对"，
 * 不管"值合不合法"——实测 `status:'bogus'` / `schema:99` / `createdAt:'not-a-time'` 全都能落盘。
 * 这里直接按 LF-120 冻结表里的 type/enum 校验，不另写一套字面量。
 */
export function validateProposalValues(proposal) {
  const problems = [];
  for (const def of proposalFieldDefs()) {
    const value = proposal[def.name];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      // 可选字段缺省 = 合法缺省（不是"字段为空"）。写在冻结表里 != 每份提案都必须写。
      if (def.required !== true) continue;
      problems.push(`字段为空: ${def.name}`);
      continue;
    }
    if (def.type === 'string' && typeof value !== 'string') problems.push(`${def.name} 应为 string`);
    if (def.type === 'number' && (typeof value !== 'number' || Number.isNaN(value))) problems.push(`${def.name} 应为 number`);
    if (def.type === 'enum' && !(def.values ?? []).includes(value)) {
      problems.push(`${def.name} 取值非法: ${String(value)}（可选 ${(def.values ?? []).join('|')}）`);
    }
    if (def.type === 'iso8601' && (typeof value !== 'string' || Number.isNaN(Date.parse(value)))) {
      problems.push(`${def.name} 应为 iso8601 时间`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * 形状守卫：**必填键全在 + 没有表外的键**。
 *
 * ⚠ 口径修正（2026-09-22，加 `supersedes` 时当场被 36 条用例抓到）：此前要求"键集合与冻结表
 * **逐一相同**"，于是**任何可选字段**（`supersedes`）一登记进冻结表，所有没写该字段的历史提案
 * 和正常提案就全被判成"漂移"。可选字段的意义就是"可以没有"——所以判据必须按 `required` 区分，
 * 而不是拿长度比对。
 */
export function assertProposalShape(proposal) {
  const defs = proposalFieldDefs();
  const known = new Set(defs.map((d) => d.name));
  const unknown = Object.keys(proposal).filter((k) => !known.has(k)).sort();
  if (unknown.length > 0) {
    return { ok: false, reason: `提案出现冻结表以外的键（漂移）：[${unknown.join(',')}]；已知键 [${[...known].sort().join(',')}]` };
  }
  const missing = defs.filter((d) => d.required === true && !Object.hasOwn(proposal, d.name)).map((d) => d.name).sort();
  if (missing.length > 0) {
    return { ok: false, reason: `提案缺必填键：[${missing.join(',')}]` };
  }
  return { ok: true, reason: null };
}

/**
 * 质量门（LF-295）：四要件必须都是**非空字符串**。
 * @returns {{ok: boolean, missing: string[], reason: string|null}}
 */
export function validateProposalQuality(proposal) {
  const missing = PROPOSAL_QUALITY_FIELDS.filter((f) => typeof proposal[f] !== 'string' || proposal[f].trim() === '');
  if (missing.length > 0) {
    return { ok: false, missing, reason: `提案缺质量要件（LF-295 四要件）：${missing.join('、')}` };
  }
  return { ok: true, missing: [], reason: null };
}

/**
 * 提案 id 的安全校验（LF-270 回放 L412 换来的硬化）。
 * 来历：L412 = `日志工具 close` 把用户可读的 Session/Phase 直接当文件名片段，`/` 造出**嵌套伪目录**、
 * 里程碑被埋在伪目录里。同族风险在 dsh-rulekeeper 就长这样：id 若含 `../` 或 `/`，`proposalPath()` 会把提案
 * **写到落点之外**。故凡是拼进文件名的标识符，一律只允许 `[A-Za-z0-9._-]`、禁 `..`。
 */
export function isSafeId(id) {
  return typeof id === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)
    && !id.includes('..')
    && id !== '.'
    && id !== '..';
}

/** 组装一条提案（不写盘）。字段名一律取自冻结表。 */
export function buildProposal({ rule, quality = {}, source = 'auto', now = new Date(), id }) {
  const proposal = {
    schema: SCHEMA_VERSION,
    id: id ?? makeProposalId(now),
    rule: canonicalRule(rule),
    source,
    createdAt: now.toISOString(),
    redCriteria: quality.redCriteria ?? '',
    counterExample: quality.counterExample ?? '',
    falsePositiveSurface: quality.falsePositiveSurface ?? '',
    activationCheck: quality.activationCheck ?? '',
    status: 'proposed',
  };
  return proposal;
}

/** 写一条提案（**只写 proposals/<id>.json**）。LF：Node writeFileSync + 显式 \n，禁 BOM。
 *  排他创建（`flag:'wx'`）：id 撞了宁可失败也不静默覆盖别人已落盘的提案（复核 S5）。 */
export function writeProposal(landingDir, proposal) {
  // LF-340：**入参先脱敏**（单一位置，覆盖后续所有序列化路径）
  const safeProposal = redactValue(proposal).value;
  proposal = safeProposal;
  const shape = assertProposalShape(proposal);
  if (!shape.ok) return { ok: false, path: null, bytes: 0, reason: shape.reason };
  const quality = validateProposalQuality(proposal);
  if (!quality.ok) return { ok: false, path: null, bytes: 0, reason: quality.reason };
  const values = validateProposalValues(proposal);
  if (!values.ok) return { ok: false, path: null, bytes: 0, reason: `值域不合法: ${values.problems.join('；')}` };
  if (!isSafeId(proposal.id)) {
    return { ok: false, path: null, bytes: 0, reason: `提案 id 不安全（只允许 [A-Za-z0-9._-] 且禁 ".."）: ${JSON.stringify(proposal.id)}` };
  }
  const dir = proposalsDir(landingDir);
  mkdirSync(dir, { recursive: true });
  const path = proposalPath(landingDir, proposal.id);
  const text = `${JSON.stringify(proposal, null, 2)}\n`;
  try {
    // LF-340：提案正文会被人读、也可能被注入给模型 ⇒ 写入前过同一个脱敏单点
  const scrubbed = redactValue(text);
  writeFileSync(path, scrubbed.value, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    return { ok: false, path, bytes: 0, reason: err?.code === 'EEXIST' ? `提案 id 已存在（排他创建失败）: ${proposal.id}` : `${err?.code ?? 'ERR'}: ${err?.message ?? ''}` };
  }
  return { ok: true, path, bytes: Buffer.byteLength(text, 'utf8'), reason: null };
}

/**
 * 列出已有提案（容错：坏 JSON 记为 unreadable，不抛）。
 * @returns {{items: object[], unreadable: string[]}}
 */
export function listProposals(landingDir) {
  const dir = proposalsDir(landingDir);
  if (!existsSync(dir)) return { items: [], unreadable: [] };
  const items = [];
  const unreadable = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (parsed !== null && typeof parsed === 'object') items.push(parsed);
      else unreadable.push(name);
    } catch {
      unreadable.push(name);
    }
  }
  return { items, unreadable };
}

/** 已有提案覆盖的纪律（canonical）：用于幂等——同一条纪律不重复产提案 */
export function proposedRules(landingDir) {
  const out = new Set();
  for (const item of listProposals(landingDir).items) {
    if (typeof item.rule === 'string' && (item.status === 'proposed' || item.status === 'approved')) {
      out.add(canonicalRule(item.rule));
    }
  }
  return out;
}
