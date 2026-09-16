// dsh-rulekeeper · LF-810 第二半：**数据导出 + 可重建**（`rk-backup export|rebuild`）
//
// 判据（清单 LF-810 行）：**导出后删光目录，再用导出件重建 → 条数/字段一致**。
//   红 = **无法重建**（导出件被改 1 字节 / 落点非空被静默覆盖 / 坏 JSON）⇒ 必红
//
// 为什么不是"再写一遍落盘逻辑"：重建走的是**导出件里逐文件的原字节**（`data` + `sha256`），
//   重建时**回读校验 sha256**。这样"可重建"这件事不依赖任何解析器对字段的理解——
//   字段一致是"字节一致"的推论，不是另一次序列化碰巧对上了。
//
// 判据载体纪律（§9.6 R1）：自报的 `counts` 只用于**交叉核对**（重建后按真实文件重算一遍再比），
//   一致性判定的载体是**重建后解析出的对象**（由调用方 deep-equal）。
//
// 归属：core 模块。零依赖：只用 node:*。

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, dirname, join, resolve } from 'node:path';

import { readLedger } from './ledger.mjs';
import { readGateLedger } from './gate.mjs';
import { pathKey, toPosix } from './platform/paths.mjs';

export const PORTABLE_SCHEMA = 1;
/** 单文件上限（防把 GB 级备份目录塞进一个 JSON 里 OOM）——超限**明说**，不静默截断 */
export const PORTABLE_MAX_BYTES = 32 * 1024 * 1024;

const EOL = '\n';

export function sha256Of(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** 目录走查（posix 相对路径、码位排序——禁 localeCompare，见 selfcheck S5） */
export function listLandingFiles(landingDir) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(abs, r);
      else out.push({ path: r, abs, bytes: statSync(abs).size });
    }
  };
  if (existsSync(String(landingDir))) walk(String(landingDir), '');
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** 落点条数（判据口径：**解析后的条数**，不是字节数） */
export function landingCounts(landingDir) {
  return {
    ledgerEntries: readLedger(String(landingDir)).values.length,
    gateRows: readGateLedger(String(landingDir)).values.length,
  };
}

/** utf8 可逆 → 用文本存（人能读、diff 友好）；否则 base64 */
function encodePayload(buffer) {
  const text = buffer.toString('utf8');
  if (Buffer.from(text, 'utf8').equals(buffer)) return { encoding: 'utf8', data: text };
  return { encoding: 'base64', data: buffer.toString('base64') };
}
function decodePayload(entry) {
  return entry.encoding === 'base64' ? Buffer.from(String(entry.data), 'base64') : Buffer.from(String(entry.data), 'utf8');
}

/**
 * 导出落点全部文件为**一个** bundle 对象。
 * @returns {{ok: boolean, reason: string|null, bundle: object|null}}
 */
export function exportLanding({ landingDir, now = new Date() } = {}) {
  const root = resolve(String(landingDir));
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return { ok: false, reason: `落点不是已存在目录: ${root}`, bundle: null };
  }
  const listed = listLandingFiles(root);
  const total = listed.reduce((sum, f) => sum + f.bytes, 0);
  if (total > PORTABLE_MAX_BYTES) {
    return { ok: false, reason: `落点合计 ${total} 字节 > 上限 ${PORTABLE_MAX_BYTES}（不静默截断：请先归档 backups/ 再导出）`, bundle: null };
  }
  const files = [];
  for (const f of listed) {
    const buffer = readFileSync(f.abs);
    files.push({ path: f.path, bytes: buffer.length, sha256: sha256Of(buffer), ...encodePayload(buffer) });
  }
  const counts = landingCounts(root);
  return {
    ok: true,
    reason: null,
    bundle: {
      schema: PORTABLE_SCHEMA,
      exportedAt: now.toISOString(),
      landing: root,
      counts: { ...counts, files: files.length },
      files,
    },
  };
}

/** 落盘 bundle（LF 无 BOM；回读校验，不信"写盘调用成功"） */
export function writeBundle(file, bundle) {
  const text = `${JSON.stringify(bundle, null, 2)}${EOL}`;
  writeFileSync(file, text, { encoding: 'utf8' });
  const back = readFileSync(file, 'utf8');
  if (back !== text) return { ok: false, reason: '导出件回读与写出内容不一致（写盘失败）', sha256: null, bytes: 0 };
  return { ok: true, reason: null, sha256: sha256Of(Buffer.from(text, 'utf8')), bytes: Buffer.byteLength(text, 'utf8') };
}

/** 读 bundle + 结构校验（坏件一律**明说**，不猜；超大件直接拒，防整块读爆内存） */
export function readBundle(file) {
  if (!existsSync(file)) return { ok: false, reason: `导出件不存在: ${file}`, bundle: null };
  let parsed;
  const raw = readFileSync(file);
  if (raw.length > PORTABLE_MAX_BYTES) {
    return { ok: false, reason: `导出件 ${raw.length} 字节 > 上限 ${PORTABLE_MAX_BYTES}（拒绝整块读入内存）`, bundle: null };
  }
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    return { ok: false, reason: `导出件不是合法 JSON: ${err.message}`, bundle: null };
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.files)) {
    return { ok: false, reason: '导出件结构不合法（缺 files 数组）', bundle: null };
  }
  if (parsed.schema !== PORTABLE_SCHEMA) {
    return { ok: false, reason: `导出件 schema=${JSON.stringify(parsed.schema)} 不是本版支持的 ${PORTABLE_SCHEMA}`, bundle: null };
  }
  return { ok: true, reason: null, bundle: parsed, fileSha256: sha256Of(raw) };
}

/** 目标落点里是否已有数据（**任何**文件都算非空：只看几个固定名会漏掉 snapshots/backups 等真实数据） */
export function landingHasData(landingDir) {
  return listLandingFiles(resolve(String(landingDir))).length > 0;
}

/**
 * 路径安全（**唯一入口**，独立审查 B1 抓到的洞）：
 *   `pathKey(rel).startsWith('..')` 只挡首段 —— `a/../../pwned.txt` 这种**中段** `..` 会漏过，
 *   再经 `join(root, ...)` 归一化就写到落点外了（Windows 上反斜杠变体 `a\..\..\x` 同样逃逸）。
 * 判据：逐段拒绝 `..`、拒绝空段、拒绝绝对路径，最后再用 `isInside` 复核归一化后的真实目标。
 */
function pathTrap(rel) {
  if (typeof rel !== 'string' || rel === '') return '空路径';
  if (isAbsolute(rel)) return '绝对路径';
  const segs = rel.split(/[\\/]/);
  if (segs.includes('..')) return '含 `..` 段（路径穿越）';
  if (segs.some((s) => s === '')) return '含空路径段';
  return null;
}

/**
 * 用导出件重建落点：**两阶段**（独立审查 M1 整改）——
 *   ① **全量校验**（路径安全 + 载荷 sha256 + 自报 counts 交叉核对），任一不过 → 一个字节都不写；
 *   ② 全部通过才逐文件落盘并**回读校验**。
 * 为什么必须两阶段：边校验边写时，"第 k 个文件坏"会留下前 k-1 个残渣，而残渣又让"拿好件重试"被判
 * `LANDING_NOT_EMPTY`（用户被迫 `--force`）—— 工具自己的残渣把用户逼进危险操作。
 * 落点已有数据且未给 force ⇒ 直接拒绝（不覆盖）。
 */
export function rebuildLanding({ file, landingDir, force = false } = {}) {
  const root = resolve(String(landingDir));
  const read = readBundle(resolve(String(file)));
  if (!read.ok) return { ok: false, code: 'BAD_BUNDLE', reason: read.reason, files: 0, verified: 0, counts: null, expected: null };
  const bundle = read.bundle;
  const expected = bundle.counts ?? null;
  if (landingHasData(root) && force !== true) {
    return { ok: false, code: 'LANDING_NOT_EMPTY', reason: `落点已有数据（拒绝静默覆盖，需 --force）: ${root}`, files: 0, verified: 0, counts: null, expected };
  }
  if (expected !== null && typeof expected.files === 'number' && expected.files !== bundle.files.length) {
    return {
      ok: false, code: 'COUNT_MISMATCH',
      reason: `导出件自报 files=${expected.files} 与实际 ${bundle.files.length} 条不符（自报值必须交叉核对）`,
      files: 0, verified: 0, counts: null, expected,
    };
  }

  // ── ① 全量校验（不落盘）──
  const plan = [];
  for (const entry of bundle.files) {
    const rel = String(entry.path ?? '');
    const trap = pathTrap(rel);
    if (trap !== null) {
      return { ok: false, code: 'BAD_PATH', reason: `导出件路径不安全（${trap}，拒绝写到落点外）: ${JSON.stringify(entry.path)}`, files: 0, verified: 0, counts: null, expected };
    }
    const target = resolve(root, rel);
    if (isInside(root, target) !== true) {
      return { ok: false, code: 'BAD_PATH', reason: `归一化后跑到落点外（拒绝）: ${JSON.stringify(entry.path)} -> ${toPosix(target)}`, files: 0, verified: 0, counts: null, expected };
    }
    const buffer = decodePayload(entry);
    const actual = sha256Of(buffer);
    if (typeof entry.sha256 !== 'string' || actual !== entry.sha256) {
      return {
        ok: false, code: 'SHA_MISMATCH',
        reason: `导出件载荷 sha256 不符（拒绝写出坏数据）: ${rel} expected=${entry.sha256 ?? '(none)'} actual=${actual}`,
        files: 0, verified: 0, counts: null, expected,
      };
    }
    plan.push({ rel, target, buffer });
  }

  // ── ② 落盘 + 回读 ──
  if (plan.length > 0) mkdirSync(root, { recursive: true });
  let verified = 0;
  for (const item of plan) {
    mkdirSync(dirname(item.target), { recursive: true });
    writeFileSync(item.target, item.buffer);
    const back = readFileSync(item.target);
    if (!back.equals(item.buffer)) {
      return { ok: false, code: 'VERIFY_FAILED', reason: `重建后回读不一致: ${item.rel}`, files: plan.length, verified, counts: null, expected };
    }
    verified += 1;
  }

  // 交叉核对：按**真实重建结果**重算条数，与导出件自报值比对（自报值不参与"通过"的判定，只做一致性校验）
  const counts = landingCounts(root);
  const countsMatch = expected === null
    ? false
    : counts.ledgerEntries === expected.ledgerEntries && counts.gateRows === expected.gateRows;
  if (!countsMatch) {
    return {
      ok: false,
      code: 'COUNT_MISMATCH',
      reason: `重建后条数与导出件不符：账本 ${counts.ledgerEntries} vs ${expected?.ledgerEntries} / 台账 ${counts.gateRows} vs ${expected?.gateRows}`,
      files: plan.length,
      verified,
      counts,
      expected,
    };
  }
  return { ok: true, code: null, reason: null, files: plan.length, verified, counts, expected, fileSha256: read.fileSha256 ?? null };
}

/** `--out` 是否落在落点内部（防"导出件把自己也导进去"的自我包含） */
export function isInside(dir, file) {
  const d = pathKey(resolve(String(dir)));
  const f = pathKey(resolve(String(file)));
  if (f === d) return true;
  return f.startsWith(`${d}/`);
}
