// dsh-rulekeeper · LF-2C0 分片 + gc + **引用完整性**
//
// 三件事（对齐清单 LF-2C0 行）：
//   ① **分片**：账本按天冷热分离——老日期进 `shards/ledger-YYYYMMDD.jsonl`，`ledger.jsonl` 只留热尾。
//      顺序铁律：**写新片 → 回读校验 → 才动旧片**（校验不过就绝不删，宁可整步失败）。
//   ② **gc**：把"已被取代/作废"且**没有被任何东西引用**的行清掉；`--dry-run` 只报告不动盘。
//   ③ **引用完整性**：被 `proposals/*.json` 的四个质量要件或其它账本行的 `evidence[]` 引用的行**永不删**；
//      删除计划生成后**再做一次后置断言**——只要发现"计划里含被引用行"就立刻中止（`GC_WOULD_DELETE_REFERENCED`）。
//      红态判据就是这一条：gc 删掉被引用行 → exit≠0。
//
// 归属：core 模块。零依赖：只用 node:*。

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { appendLine, readLines } from './append.mjs';
import { SHARD_DIR, SHARD_PREFIX, ledgerPath, listShards, readLedger } from './ledger.mjs';
import { listProposals } from './proposal.mjs';
import { toPosix } from './platform/paths.mjs';

export { SHARD_DIR, SHARD_PREFIX, listShards };
/** 允许被 gc 的状态（其余一律保留） */
export const GC_STATUSES = Object.freeze(['superseded', 'obsolete']);
/** 引用扫描用的 id 形态：账本 id（LF-<ts>-<hex>）与教训号（L1 / L412 这类） */
const RE_REF_TOKEN = /\b(?:LF-\d{8}-\d{6}-[0-9a-f]{6}|L\d{1,4})\b/g;

export function shardDir(landingDir) {
  return join(landingDir, SHARD_DIR);
}

/** `2026-09-14T00:00:00.000Z` -> `ledger-20260914.jsonl` */
export function shardName(ts) {
  const day = typeof ts === 'string' ? ts.slice(0, 10).replace(/-/g, '') : '';
  return `${SHARD_PREFIX}${day}.jsonl`;
}

export function shardPath(landingDir, name) {
  return join(shardDir(landingDir), name);
}

/**
 * 按天分片：把 `ledger.jsonl` 里**早于 `keepDays` 天**的行搬到分片文件。
 * 顺序：写新片 -> 回读校验（行数 + 逐行字节相等）-> 才重写热尾。
 * @returns {{ok, moved, shards: object[], kept, reasons: string[], sourceRemoved: boolean}}
 */
export function shardLedger({ landingDir, now = new Date(), keepDays = 1, dryRun = false }) {
  const read = readLines(ledgerPath(landingDir));
  const rows = read.lines.filter((l) => l.trim() !== '');
  if (rows.length === 0) return { ok: true, moved: 0, shards: [], kept: 0, reasons: [], sourceRemoved: false };
  const cutoff = new Date(now.getTime() - keepDays * 86400000).toISOString();
  const cold = new Map();
  const hot = [];
  let unparsable = 0;
  for (const line of rows) {
    let ts = '';
    try { ts = String(JSON.parse(line).ts ?? ''); } catch { unparsable += 1; }
    // 解析不了的行一律留在热尾（绝不因为"读不懂"就搬走或丢弃）
    if (ts !== '' && ts < cutoff) {
      const name = shardName(ts);
      if (!cold.has(name)) cold.set(name, []);
      cold.get(name).push(line);
    } else hot.push(line);
  }
  const reasons = [];
  if (unparsable > 0) reasons.push(`有 ${unparsable} 行无法解析 ts，已一律留在热尾（不搬不丢）`);
  const shards = [];
  for (const [name, lines] of [...cold.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const path = shardPath(landingDir, name);
    if (!dryRun) {
      try {
        mkdirSync(shardDir(landingDir), { recursive: true });
        // 分片是 append-only：同一天可能分多次搬（同日多次运行时追加而不是覆盖）
        for (const line of lines) {
          const appended = appendLine(path, JSON.parse(line));
          if (!appended.ok) return { ok: false, moved: 0, shards, kept: hot.length, reasons: [...reasons, `写分片失败: ${appended.reason}`], sourceRemoved: false };
        }
        // 回读校验：分片里必须真有这些行（按行内容比对，不比整文件哈希——同日追加时哈希不稳）
        const back = readLines(path);
        const backLines = back.lines.filter((l) => l.trim() !== '');
        const missing = lines.filter((l) => !backLines.includes(l));
        if (missing.length > 0) {
          return { ok: false, moved: 0, shards, kept: hot.length, reasons: [...reasons, `回读校验失败：分片 ${name} 少了 ${missing.length} 行 -> 不删旧片`], sourceRemoved: false };
        }
      } catch (err) {
        // 不裸抛：目录建不出来/写不进去一律转成"整步失败 + 原文件不动"（实测：shards 被占成文件时 mkdir 会抛）
        return { ok: false, moved: 0, shards, kept: hot.length, reasons: [...reasons, `写分片失败（${err?.code ?? 'ERR'}: ${err?.message ?? ''}）-> 原文件未动`], sourceRemoved: false };
      }
      shards.push({ name, lines: lines.length, bytes: 0 });
    } else {
      shards.push({ name, lines: lines.length, bytes: null });
    }
  }
  if (dryRun) return { ok: true, moved: cold.size === 0 ? 0 : [...cold.values()].reduce((a, b) => a + b.length, 0), shards, kept: hot.length, reasons, sourceRemoved: false };
  // 全部片回读通过之后，才重写热尾（原子替换：写 .new -> 校验 -> rename）
  mkdirSync(join(landingDir), { recursive: true });
  const tmp = `${ledgerPath(landingDir)}.new`;
  writeFileSync(tmp, hot.length === 0 ? '' : `${hot.join('\n')}\n`, 'utf8');
  const check = readLines(tmp);
  const checkLines = check.lines.filter((l) => l.trim() !== '');
  if (checkLines.length !== hot.length) {
    rmSync(tmp, { force: true });
    return { ok: false, moved: 0, shards, kept: hot.length, reasons: [...reasons, `热尾回读校验失败（${checkLines.length} != ${hot.length}）-> 保持原文件`], sourceRemoved: false };
  }
  renameSync(tmp, ledgerPath(landingDir));
  const moved = shards.reduce((a, s) => a + s.lines, 0);
  return { ok: reasons.length === 0, moved, shards, kept: hot.length, reasons, sourceRemoved: true };
}

/** 收集"被引用"的 id 集合：proposals 的四要件 + 其它账本行的 evidence[] */
export function collectReferencedIds(landingDir) {
  const referenced = new Set();
  const addTokens = (text) => {
    if (typeof text !== 'string') return;
    for (const m of text.match(RE_REF_TOKEN) ?? []) referenced.add(m);
  };
  for (const proposal of listProposals(landingDir).items) {
    for (const field of ['redCriteria', 'counterExample', 'falsePositiveSurface', 'activationCheck']) addTokens(proposal[field]);
  }
  const all = readLedger(landingDir);
  const entries = all.values.filter((v) => v !== null && typeof v === 'object' && !Array.isArray(v));
  for (const entry of entries) {
    if (Array.isArray(entry.evidence)) for (const e of entry.evidence) addTokens(e);
  }
  return referenced;
}

/**
 * 生成 gc 计划（**不落盘**）。
 * @param {{landingDir: string, forceDeletable?: string[]}} opts forceDeletable 只给测试/取证用：
 *   强制把某些 id 塞进"可删"集合——**后置断言**会因此发现"计划里含被引用行"并中止（这正是红态判据）。
 */
export function planGc({ landingDir, forceDeletable = [] } = {}) {
  const all = readLedger(landingDir);
  const entries = all.values.filter((v) => v !== null && typeof v === 'object' && !Array.isArray(v));
  const referenced = collectReferencedIds(landingDir);
  const byId = new Map();
  for (const entry of entries) {
    if (typeof entry.id !== 'string') continue;
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }
  const forced = new Set(forceDeletable);
  const deletable = [];
  const kept = { active: 0, referenced: 0, other: 0 };
  for (const entry of entries) {
    const id = typeof entry.id === 'string' ? entry.id : '(no-id)';
    const status = typeof entry.status === 'string' ? entry.status : 'active';
    if (forced.has(id)) { deletable.push({ id, status, reason: 'forced(仅测试/取证)' }); continue; }
    if (!GC_STATUSES.includes(status)) { kept.active += 1; continue; }
    if (referenced.has(id)) { kept.referenced += 1; continue; }
    deletable.push({ id, status, reason: `status=${status} 且未被引用` });
  }
  const deletableIds = new Set(deletable.map((d) => d.id));
  // **后置断言**：计划里绝不允许出现"被引用"的 id（红态判据：gc 删掉被引用行 → exit≠0）
  const wouldDeleteReferenced = [...deletableIds].filter((id) => referenced.has(id));
  const postConditionOk = wouldDeleteReferenced.length === 0;
  return {
    ok: postConditionOk,
    entries: entries.length,
    shardFiles: listShards(landingDir).length,
    referenced: referenced.size,
    referencedIds: [...referenced].sort(),
    deletable,
    deletableIds: [...deletableIds].sort(),
    kept,
    badLines: all.badLines,
    truncatedTail: all.truncatedTail === true,
    postConditionOk,
    wouldDeleteReferenced: wouldDeleteReferenced.sort(),
  };
}

/**
 * 执行 gc：把可删行从（热尾 + 分片）里剔除。
 * 铁律：先写新内容 -> 回读校验 -> 才替换原文件；任一环节不过就整步失败且**不动原文件**。
 */
export function applyGc({ landingDir, plan }) {
  if (plan === undefined) throw new Error('applyGc 需要 plan');
  if (!plan.postConditionOk) {
    return { ok: false, deleted: 0, files: [], reasons: [`拒绝执行：计划里含被引用行 ${plan.wouldDeleteReferenced.join(',')}`] };
  }
  const deletable = new Set(plan.deletableIds);
  const targets = [ledgerPath(landingDir), ...listShards(landingDir).map((n) => shardPath(landingDir, n))];
  const done = [];
  let deleted = 0;
  for (const path of targets) {
    if (!existsSync(path)) continue;
    const read = readLines(path);
    const lines = read.lines.filter((l) => l.trim() !== '');
    const kept = [];
    for (const line of lines) {
      let id = null;
      try { id = JSON.parse(line).id ?? null; } catch { id = null; }
      if (id !== null && deletable.has(id)) { deleted += 1; continue; }
      kept.push(line);
    }
    if (kept.length === lines.length) continue;
    const tmp = `${path}.new`;
    writeFileSync(tmp, kept.length === 0 ? '' : `${kept.join('\n')}\n`, 'utf8');
    const back = readLines(tmp);
    const backLines = back.lines.filter((l) => l.trim() !== '');
    if (backLines.length !== kept.length) {
      rmSync(tmp, { force: true });
      return { ok: false, deleted: 0, files: done, reasons: [`回读校验失败（${toPosix(path)}：${backLines.length} != ${kept.length}）-> 原文件未动`] };
    }
    renameSync(tmp, path);
    done.push({ file: toPosix(path), kept: kept.length, removed: lines.length - kept.length });
  }
  return { ok: true, deleted, files: done, reasons: [] };
}
