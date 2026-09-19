// dsh-rulekeeper · LF-200 ledger 核心（append-only + **派生**聚合）
//
// 设计要点（每条都有实测来历）：
//   ① **只追加**：一行写入走 LF-160 的 appendLine（单次 writeSync），永不"整文件读-改-写"
//   ② **聚合一律派生**：recurrence / first_seen / last_seen / status 由**扫描行**得出，
//      行内 `recurrence` 恒为 1（写入时的单行事实），系统读数一律走 deriveCounts()。
//      来历：实测整文件 RMW 计数在并发下丢失（LF-120 的 demo-rmw-loss：期望 900 实得 150；
//      LF-200 的 ledger-probe 再以 8 进程复现）
//   ③ 字段按 LF-120 冻结表；必填字段缺失即拒收（不落盘）
//   ④ 容错读复用 LF-160 的 readLines（坏行/半行不让整文件失败）
//
// 归属：core 模块。零依赖：只用 node:*。

import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { appendLine, readLines } from './append.mjs';
import { redactValue } from './redact.mjs';
import { offGuard } from './mode.mjs';
import { SCHEMA_VERSION } from './schema.mjs';

export const LEDGER_FILE = 'ledger.jsonl';
/** LF-2C0：冷分片目录与命名（`shards/ledger-YYYYMMDD.jsonl`） */
export const SHARD_DIR = 'shards';
export const SHARD_PREFIX = 'ledger-';

/** 写入时必须由调用方提供的字段（其余可自动填充） */
export const REQUIRED_STRING_FIELDS = Object.freeze([
  'rule', 'category', 'problem', 'root_cause', 'solution', 'mechanism',
]);

export function ledgerPath(landingDir) {
  return join(landingDir, LEDGER_FILE);
}

/** 自动 id：LF-<UTC 时间戳>-<6 hex>（不依赖扫描，故并发下也不会撞） */
export function makeId(now = new Date(), random = () => randomBytes(3).toString('hex')) {
  const pad = (n) => String(n).padStart(2, '0');
  const ts = [
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`,
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`,
  ].join('');
  return `LF-${ts}-${random()}`;
}

/**
 * 规范化为一条合法账本行（不写盘）。
 * @returns {{ok: true, entry: object} | {ok: false, problems: string[]}}
 */
export function normalizeEntry(input, opts = {}) {
  const now = opts.now ?? new Date();
  const problems = [];
  if (input === null || typeof input !== 'object') return { ok: false, problems: ['entry 必须是对象'] };
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof input[field] !== 'string' || input[field].trim() === '') problems.push(`缺字段或为空: ${field}`);
  }
  if (problems.length > 0) return { ok: false, problems };
  const ts = typeof input.ts === 'string' && input.ts.trim() !== '' ? input.ts : now.toISOString();
  return {
    ok: true,
    entry: {
      schema: SCHEMA_VERSION,
      id: typeof input.id === 'string' && input.id.trim() !== '' ? input.id : (opts.id ?? makeId(now)),
      ts,
      rule: input.rule,
      category: input.category,
      problem: input.problem,
      root_cause: input.root_cause,
      solution: input.solution,
      evidence: Array.isArray(input.evidence) ? input.evidence : [],
      mechanism: input.mechanism,
      // ↓ 以下四个是**派生字段**：行内只记录"写入时的事实"，聚合读数一律用 derive* 重算
      recurrence: 1,
      first_seen: ts,
      last_seen: ts,
      status: typeof input.status === 'string' && input.status.trim() !== '' ? input.status : 'active',
      // P0-2（2026-09-19）：**可判激活条件**（可选字段，语义见 effect.mjs 的 activationOf()）。
      // 为什么单独在这里展开：本函数用**显式字段表**造行 ⇒ 调用方传的 `activation` 原本会被
      // **静默丢弃**（与 `buildInjection` 丢 `rule`、测试 helper 丢 `activation` 同源——一天内第三次
      // 撞到"字段被白名单吃掉"，已记入教训）。空值不入库，保持既有行形状不变（append-only 兼容）。
      ...(typeof input.activation === 'string' && input.activation.trim() !== ''
        ? { activation: input.activation.trim() }
        : {}),
    },
  };
}

/**
 * 追加一条记录（**只追加，不改写**）。
 * @returns {{ok: boolean, entry: object|null, bytes: number, reason: string|null}}
 */
export function record(input, opts = {}) {
  const landingDir = opts.landingDir;
  if (typeof landingDir !== 'string' || landingDir.trim() === '') {
    return { ok: false, entry: null, bytes: 0, reason: 'record 需要 landingDir' };
  }
  // LF-800 写入闸：off 档**零副作用**（不建目录、不写文件）
  const gate = offGuard(landingDir, 'ledger.jsonl');
  if (gate.off) return { ok: true, entry: null, bytes: 0, reason: gate.finding.message, skipped: true, findings: [gate.finding] };
  const normalized = normalizeEntry(input, { now: opts.now ?? new Date() });
  if (!normalized.ok) {
    return { ok: false, entry: null, bytes: 0, reason: `字段不合法: ${normalized.problems.join('；')}` };
  }
  // LF-340 **写入侧单点**：台账是隐私/凭据最可能的落点（教训正文是自由文本）。
  // 只脱敏**字符串值**，不动字段名与 id/rule 等标识（否则破坏契约与检索）。
  const scrubbed = redactValue(normalized.entry, { identity: opts.identity === true });
  const entry = scrubbed.value;
  const appended = appendLine(ledgerPath(landingDir), entry, { maxLineBytes: opts.maxLineBytes });
  if (!appended.ok) return { ok: false, entry, bytes: appended.bytes, reason: appended.reason, redacted: scrubbed.hits };
  return { ok: true, entry, bytes: appended.bytes, reason: null, redacted: scrubbed.hits };
}

/** 容错读取**热尾**（只有 `ledger.jsonl`，不含分片） */
export function readHotLedger(landingDir) {
  return readLines(ledgerPath(landingDir));
}

/** 分片目录 / 分片清单（LF-2C0：读账本必须把冷分片也算进来，否则聚合会漏） */
export function shardDirOf(landingDir) {
  return join(landingDir, SHARD_DIR);
}

export function listShards(landingDir) {
  const dir = shardDirOf(landingDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.startsWith(SHARD_PREFIX) && n.endsWith('.jsonl')).sort();
}

/**
 * 容错读取**整个账本** = 热尾 + 全部分片（按文件名序，即按天序）。
 * 来历（LF-2C0）：分片之后若只读热尾，聚合（deriveCounts/recurrence/report/evolve）会**静默漏数**——
 * 那正是本项目最忌讳的"假绿"。故把并集读取放在唯一的读入口，所有消费方无需改动。
 */
export function readLedger(landingDir) {
  const hot = readHotLedger(landingDir);
  const files = listShards(landingDir);
  if (files.length === 0) return hot;
  const values = [...hot.values];
  const lines = [...hot.lines];
  let badLines = hot.badLines;
  let oversized = hot.oversized;
  let truncatedTail = hot.truncatedTail;
  let bytes = hot.bytes;
  for (const name of files) {
    const read = readLines(join(shardDirOf(landingDir), name));
    values.push(...read.values);
    lines.push(...read.lines);
    badLines += read.badLines;
    oversized += read.oversized;
    if (read.truncatedTail === true) truncatedTail = true;
    bytes += read.bytes;
  }
  return { ...hot, values, lines, badLines, oversized, truncatedTail, bytes, shards: files };
}

/**
 * **派生**聚合：按 rule 扫行计数 + 首末时间。绝不回写文件。
 * @returns {Map<string, {rule: string, count: number, firstSeen: string|null, lastSeen: string|null}>}
 */
export function deriveCounts(entries) {
  const out = new Map();
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;
    if (typeof entry.rule !== 'string' || entry.rule === '') continue;
    const current = out.get(entry.rule) ?? { rule: entry.rule, count: 0, firstSeen: null, lastSeen: null };
    current.count += 1;
    if (typeof entry.ts === 'string') {
      if (current.firstSeen === null || entry.ts < current.firstSeen) current.firstSeen = entry.ts;
      if (current.lastSeen === null || entry.ts > current.lastSeen) current.lastSeen = entry.ts;
    }
    out.set(entry.rule, current);
  }
  return out;
}

/** 某条纪律的复发次数（**派生**，不是读行里的 recurrence 字段） */
export function recurrenceOf(entries, rule) {
  const found = deriveCounts(entries).get(rule);
  return found === undefined ? 0 : found.count;
}

/** 状态一律派生：同 rule 取 ts 最新一行的 status（不做原地改写历史行） */
export function deriveStatus(entries) {
  const out = new Map();
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;
    if (typeof entry.rule !== 'string' || entry.rule === '') continue;
    const prev = out.get(entry.rule);
    const ts = typeof entry.ts === 'string' ? entry.ts : '';
    if (prev === undefined || ts >= prev.ts) {
      out.set(entry.rule, { rule: entry.rule, ts, status: typeof entry.status === 'string' ? entry.status : 'active' });
    }
  }
  return out;
}

/** 简单查询（按 id / rule） */
export function query(entries, filter = {}) {
  return entries.filter((entry) => {
    if (entry === null || typeof entry !== 'object') return false;
    if (filter.id !== undefined && entry.id !== filter.id) return false;
    if (filter.rule !== undefined && entry.rule !== filter.rule) return false;
    return true;
  });
}

/** 汇总（供 CLI/doctor 使用）：条目数 + 读健康 + 每条纪律的派生计数 */
export function summary(landingDir) {
  const read = readLedger(landingDir);
  const counts = [...deriveCounts(read.values).values()].sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
  return {
    entries: read.values.length,
    badLines: read.badLines,
    truncatedTail: read.truncatedTail,
    oversized: read.oversized,
    missing: read.missing,
    rules: counts,
    totalRecurrence: counts.reduce((sum, r) => sum + r.count, 0),
  };
}
