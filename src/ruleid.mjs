// dsh-rulekeeper · LF-220 rule 命名规范 / 唯一性冲突检测 / 去重键
//
// 三件事：
//   ① **命名规范**：rule 一律 ASCII 大写下划线转连字符（`FACT-WRITING` / `CAT-TECH`），
//      canonicalRule() 给出唯一规范形，禁"同一条纪律两种写法"
//   ② **冲突检测**：同 canonical 但原文不同（`fact-writing` vs `FACT-WRITING`）→ RULE_NAME_AMBIGUOUS
//   ③ **去重键 `rule × target × sha256`**：同键合并为 count（**不是** N 行）；不同 target 必须各算一次
//
// 【诚实边界 · schema 缺口】`target` / `sha256` **不在 LF-120 冻结的 ledger 字段表里**（14 字段无此项）。
// 故本模块只提供**纯函数**去重键，取值由调用方投影（见 projectTarget/projectSha256）；
// 若将来要一等公民字段，须走 §9.8 的 schema 变更（同步 LF-120 冻结单 + 迁移 + 反红）。
//
// 归属：core 模块。零依赖：只用 node:*。

import { createHash } from 'node:crypto';

/** 规范形：`^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*$` */
export const RULE_ID_PATTERN = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/;

/** 归一：去空白、下划线/连续空白转连字符、折叠连字符、两端去连字符、转大写 */
export function canonicalRule(name) {
  if (typeof name !== 'string') return '';
  return name
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .toUpperCase();
}

export function validateRuleId(name) {
  const canonical = canonicalRule(name);
  if (canonical === '') return { ok: false, canonical, reason: 'rule 为空' };
  if (!RULE_ID_PATTERN.test(canonical)) {
    return { ok: false, canonical, reason: `rule 不符合命名规范（应形如 FACT-WRITING / CAT-TECH）: ${JSON.stringify(name)}` };
  }
  return { ok: true, canonical, reason: null };
}

/** 去重键的**纯**投影：三段各自的空值都显式占位，避免"空 = 任意"的隐式合并 */
export function dedupeKey({ rule, target, sha256 } = {}) {
  const r = canonicalRule(rule) || 'UNSPECIFIED';
  const t = typeof target === 'string' && target.trim() !== '' ? target.trim().toLowerCase() : 'NO-TARGET';
  const h = typeof sha256 === 'string' && sha256.trim() !== '' ? sha256.trim().toLowerCase() : 'NO-SHA';
  return `${r}|${t}|${h}`;
}

/**
 * target 投影（文档化规则）：显式字段 → 第一条 evidence（凭证路径本身就是"受影响物"）→ (none)
 */
export function projectTarget(entry) {
  if (entry !== null && typeof entry === 'object') {
    if (typeof entry.target === 'string' && entry.target.trim() !== '') return entry.target.trim();
    const first = Array.isArray(entry.evidence) ? entry.evidence.find((e) => typeof e === 'string' && e.trim() !== '') : undefined;
    if (first !== undefined) return first.trim();
  }
  return '(none)';
}

/**
 * sha256 投影：显式字段优先；否则用**规范化后的 problem+solution 内容哈希**
 * （于是"同 rule 同问题"会合并、"同 rule 不同问题"不会 —— 这正是判据②要的）
 */
export function projectSha256(entry) {
  if (entry !== null && typeof entry === 'object' && typeof entry.sha256 === 'string' && entry.sha256.trim() !== '') {
    return entry.sha256.trim().toLowerCase();
  }
  const text = `${String(entry?.problem ?? '').trim()}\n${String(entry?.solution ?? '').trim()}`;
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 同 canonical 但原文有两种以上写法 = 命名的"分叉"。
 * @returns {{canonical: string, variants: string[], ids: string[]}[]}
 */
export function detectRuleDivergence(entries = []) {
  const byCanonical = new Map();
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;
    const raw = typeof entry.rule === 'string' ? entry.rule.trim() : '';
    if (raw === '') continue;
    const canonical = canonicalRule(raw);
    const current = byCanonical.get(canonical) ?? { canonical, variants: new Set(), ids: [] };
    current.variants.add(raw);
    if (typeof entry.id === 'string') current.ids.push(entry.id);
    byCanonical.set(canonical, current);
  }
  return [...byCanonical.values()]
    .filter((x) => x.variants.size > 1)
    .map((x) => ({ canonical: x.canonical, variants: [...x.variants].sort(), ids: x.ids }));
}

/**
 * 按去重键合并（**同键合并为 count，而不是 N 行**）。
 * @param {object[]} entries
 * @param {{byRuleOnly?: boolean}} [opts] byRuleOnly=true 是**反面形态**（只按 rule 合并，会吞真复发）
 * @returns {{groups: object[], findings: object[], collapsed: number}}
 */
export function dedupe(entries = [], opts = {}) {
  const byRuleOnly = opts.byRuleOnly === true;
  const groups = new Map();
  const findings = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;
    const rule = canonicalRule(entry.rule);
    const target = projectTarget(entry);
    const sha256 = projectSha256(entry);
    const key = byRuleOnly ? (rule || 'UNSPECIFIED') : dedupeKey({ rule, target, sha256 });
    const current = groups.get(key) ?? { key, rule, count: 0, targets: new Set(), ids: [], sha256: new Set() };
    current.count += 1;
    current.targets.add(target);
    if (typeof entry.id === 'string') current.ids.push(entry.id);
    if (!byRuleOnly) current.sha256.add(sha256);
    groups.set(key, current);
  }
  const list = [...groups.values()]
    .map((g) => ({
      key: g.key,
      rule: g.rule,
      count: g.count,
      targets: [...g.targets].sort(),
      ids: g.ids,
      sha256Count: g.sha256.size,
    }))
    .sort((a, b) => (b.count - a.count) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const collapsed = entries.length - list.length;
  return { groups: list, findings, collapsed };
}

/** 同一 rule 下是否被拆成多个键（拆得太碎 = 去重键过严的信号） */
export function ruleFragmentation(entries = []) {
  const { groups } = dedupe(entries);
  const byRule = new Map();
  for (const g of groups) {
    const list = byRule.get(g.rule) ?? [];
    list.push(g.key);
    byRule.set(g.rule, list);
  }
  return [...byRule.entries()]
    .map(([rule, keys]) => ({ rule, keyCount: keys.length }))
    .filter((x) => x.keyCount > 1)
    .sort((a, b) => b.keyCount - a.keyCount);
}
