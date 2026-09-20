// similarity.mjs —— **近似重复检测**（2026-09-19，实验 E2 的直接落地）
//
// 为什么需要它（不是"锦上添花"）：仓里早就有 `ruleid.dedupe()`，但它是**精确键去重**
//   （`rule × target × sha256(problem+solution)`，见 `schema.mjs` 的 `dedupeKey`）
//   ⇒ 只差一个标点/proposal 号的"同一次事故的第二次记录"**完全躲过它**。
//   E2 实验（报告：本仓外部的设计文档 `E2-volume-vs-recall`，脚本在本项目 TODO 目录；结论已入库为
//   量增/重复对照实验）用数字给出了代价：
//   · 注入 300 条**无关**条目：top-1 命中率 **Δ=0.0000**（量增本身不伤）
//   · 注入 300 条**近义重复**：top-1 **1.0000 → 0.4800**（伤在第一名，不是前三名）
//   · 精确键去重对近义重复的拦截率 ≈ 0；文本门（≥0.6）能拦 **95%**
//   ⇒ 结论：**门要前置到入库那一刻**（副本一进索引就抢槽位，事后按用量淘汰救不回那次查询）。
//
// 度量口径（写死在这里，避免与实验口径漂移）：
//   · 文本 = 由 `fields` 拼成（默认只看 `problem`——它就是"这次事故是哪件事"的指纹）
//   · 分词 = **与生产匹配器同一份实现**（`prestep.tokens`，2-gram + 3-gram，`\p{L}\p{N}` 之外全部丢弃）
//   · 相似度 = **Jaccard**（|A∩B| / |A∪B|），不是 Dice（E2 报告标题写 Jaccard，其脚本模型名写 dice；
//     本模块只说自己的口径，并在真实账本上给出**自己算出来的**对数）
//   · 候选配对用 2-gram 倒排做**分块**（Jaccard ≥ 阈值 > 0 必有公共 2-gram ⇒ 分块不丢对），
//     故 10^4 量级也不会退化成全量两两比较
//
// 归属：core 模块。零依赖：只用 node:*。

import { tokens } from './prestep.mjs';

/** 默认阈值：E2 实验里 0.6 档在真实语料上零误伤且拦 95% 近义重复 */
export const DEFAULT_NEAR_DUP_THRESHOLD = 0.6;
/** 单次比较上限（防御性：账本被灌到 10^5 行时不至于把 CLI 拖死） */
export const DEFAULT_MAX_ENTRIES = 20000;

/** Jaccard 相似度：0（无交集）~ 1（完全相同） */
export function jaccard(a, b) {
  if (!(a instanceof Set) || !(b instanceof Set)) return 0;
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const t of small) if (large.has(t)) inter += 1;
  if (inter === 0) return 0;
  return inter / (a.size + b.size - inter);
}

/** 两条文本的相似度（同一份分词口径） */
export function similarityText(a, b) {
  return jaccard(tokens(a), tokens(b));
}

/** 只取"2-gram"子集（分块键；与 `tokens(sizes=[2])` 同口径） */
function bigrams(text) {
  return tokens(text, [2]);
}

/**
 * 找近似重复对。
 * @param {object[]} entries 账本行（`id` / `rule` / `problem` …）
 * @param {{threshold?: number, fields?: string[], maxEntries?: number, maxPairs?: number}} [opts]
 * @returns {{threshold:number, fields:string[], entries:number, compared:number, truncated:boolean, pairs:{aId:string,bId:string,aRule:string|null,bRule:string|null,sameRule:boolean,score:number}[]}}
 */
export function findNearDuplicates(entries = [], {
  threshold = DEFAULT_NEAR_DUP_THRESHOLD,
  fields = ['problem'],
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxPairs = 500,
} = {}) {
  const usable = [];
  for (const e of entries) {
    if (e === null || typeof e !== 'object') continue;
    const text = fields.map((f) => (typeof e[f] === 'string' ? e[f] : '')).join('\n').trim();
    if (text === '') continue;
    usable.push({
      id: typeof e.id === 'string' ? e.id : '',
      rule: typeof e.rule === 'string' && e.rule.trim() !== '' ? e.rule.trim() : null,
      full: tokens(text),
      bi: bigrams(text),
    });
  }
  const truncated = usable.length > maxEntries;
  const items = truncated ? usable.slice(0, maxEntries) : usable;

  // 分块：2-gram → 行号。Jaccard ≥ 阈值(>0) 必有公共 2-gram，故分块不会漏掉任何达标对。
  const buckets = new Map();
  for (let i = 0; i < items.length; i += 1) {
    for (const g of items[i].bi) {
      const list = buckets.get(g);
      if (list === undefined) buckets.set(g, [i]);
      else list.push(i);
    }
  }
  const seen = new Set();
  const pairs = [];
  let compared = 0;
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    for (let x = 0; x < list.length; x += 1) {
      for (let y = x + 1; y < list.length; y += 1) {
        const i = list[x];
        const j = list[y];
        const key = `${i}:${j}`;
        if (seen.has(key)) continue;
        seen.add(key);
        compared += 1;
        const score = jaccard(items[i].full, items[j].full);
        if (score < threshold) continue;
        pairs.push({
          aId: items[i].id, bId: items[j].id,
          aRule: items[i].rule, bRule: items[j].rule,
          sameRule: items[i].rule !== null && items[i].rule === items[j].rule,
          score: Math.round(score * 10000) / 10000,
        });
      }
    }
  }
  pairs.sort((a, b) => b.score - a.score || (a.aId < b.aId ? -1 : 1));
  return { threshold, fields, entries: items.length, compared, truncated, pairs: pairs.slice(0, maxPairs) };
}
