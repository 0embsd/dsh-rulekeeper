// dsh-rulekeeper · LF-300 pre-image 快照 / LF-310 restore / LF-320 快照↔账本对账
//
// 三条判据（清单 §3）：
//   LF-300  `SNAP_OK` == 真实 sha256；**回读一致**；`snapshots/index.jsonl` **登记 +1 行**。
//           红态：回读不一致 → 必须非 0 exit 并报警（且**不得**登记）。
//   LF-310  `restore <path>`：真回滚后 sha256 == 改前（凭证要贴两个 hash 原文）。
//           红态：无快照时**不得静默成功**（确定 exit，按 LF-140 契约 = NO_SNAPSHOT(3)）。
//   LF-320  快照↔账本对账：**有记录无备份**与**有备份无记录**两类都要能报出；漏报任一类 → exit≠0。
//
// 复用而不重写：备份与恢复的"回读校验/SHA_MISMATCH/拒绝坏备份覆盖"已在 LF-190 的 backup.mjs 里做过，
// 这里只在它上面加"索引登记 + 快照查找 + 对账"，避免第二套实现（L474 的老坑）。
//
// 归属：core 模块。零依赖：只用 node:*。

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { appendLine, readLines } from './append.mjs';
import { sha256LfOfBuffer } from './lineend.mjs';
import { offGuard } from './mode.mjs';
import { backupDir, backupFile, restoreFile, sha256File } from './backup.mjs';
import { pathKey, relativeToRoot, toPosix } from './platform/paths.mjs';
import { normalizeTarget } from './rules.mjs';
import { SCHEMA_VERSION } from './schema.mjs';

export const SNAP_INDEX = 'snapshots/index.jsonl';

export function snapIndexPath(landingDir) {
  return join(landingDir, 'snapshots', 'index.jsonl');
}

/** 读快照索引（容错）：只保留对象行 */
export function readIndex(landingDir) {
  const read = readLines(snapIndexPath(landingDir));
  return {
    values: read.values.filter((v) => v !== null && typeof v === 'object' && !Array.isArray(v)),
    badLines: read.badLines,
    truncatedTail: read.truncatedTail === true,
    missing: read.missing === true,
    lines: read.lines.filter((l) => l.trim() !== '').length,
  };
}

/** 某路径（pathKey 形式）的**最新**快照记录 */
export function latestRecordFor(landingDir, key) {
  const want = pathKey(key);
  let best = null;
  for (const row of readIndex(landingDir).values) {
    if (typeof row.path !== 'string' || pathKey(row.path) !== want) continue;
    const ts = typeof row.ts === 'string' ? row.ts : '';
    if (best === null || ts >= best.ts) best = { ts, row };
  }
  return best === null ? null : best.row;
}

/**
 * LF-300：拍一张 pre-image 快照（备份 + 回读校验 + 索引登记）。
 * @param {{projectRoot: string, landingDir: string, file: string, now?: Date, why?: string,
 *          _inject?: {corruptBackupAfterCopy?: boolean}}} opts
 *   `_inject` 只给测试/取证用：拷完立刻把备份改一个字节，用来验证"回读不一致必须报错且不登记"。
 */
export function takeSnapshot(opts = {}) {
  const { projectRoot, landingDir, file } = opts;
  // LF-800 写入闸：off 档零副作用（不建 backups/ 与 snapshots/，连索引也不登记）
  const gate = offGuard(landingDir, 'snapshots/index.jsonl + backups/');
  if (gate.off) return { ok: true, skipped: true, path: null, reasons: [gate.finding.message], indexLines: 0, findings: [gate.finding] };
  const now = opts.now ?? new Date();
  const why = opts.why ?? 'pre-image 快照（LF-300）';
  const reasons = [];
  const normalized = normalizeTarget(file, projectRoot);
  if (normalized === null) return { ok: false, path: null, reasons: ['路径非法或不在项目根下（无法归一）'], indexLines: 0 };
  const key = pathKey(normalized);
  const abs = existsSync(file) ? file : join(projectRoot, normalized);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    return { ok: false, path: key, reasons: [`目标不是已存在文件: ${normalized}`], indexLines: 0 };
  }
  const shaBefore = sha256File(abs);
  const backup = backupFile(abs, { landingDir, now });
  if (backup.ok !== true) {
    return { ok: false, path: key, reasons: [`备份失败: ${backup.reason}`], indexLines: 0 };
  }
  if (opts._inject?.corruptBackupAfterCopy === true) {
    // 仅测试注入：把备份文件改坏一个字节（追加），用于验证回读校验真的会拦
    appendLine(backup.path, { corrupted: true });
  }
  let readBackSha;
  try {
    readBackSha = sha256File(backup.path);
  } catch (err) {
    return { ok: false, path: key, code: 'SNAP_READBACK_FAILED', reasons: [`回读备份失败: ${err?.message ?? ''}`], indexLines: 0 };
  }
  if (readBackSha !== shaBefore) {
    // 红态（LF-300）：回读不一致 -> 非 0 exit + 报警 + **不登记**
    return {
      ok: false, path: key, code: 'SNAP_READBACK_MISMATCH', sha256: shaBefore, readBackSha,
      backup: toPosix(backup.path), reasons: [`回读 sha256 与源不一致（${readBackSha} != ${shaBefore}）-> 不登记，快照作废`],
      indexLines: readIndex(landingDir).lines,
    };
  }
  const indexBefore = readIndex(landingDir).lines;
  mkdirSync(join(landingDir, 'snapshots'), { recursive: true });
  const relBackup = relativeToRoot(backup.path, projectRoot);
  // G3：额外记一个**行尾归一形态**的 sha256（仅文本；二进制为 null），供 autocrlf=true 时跨形态比对
  const sha256Lf = sha256LfOfBuffer(readFileSync(abs));
  const row = {
    schema: SCHEMA_VERSION,
    ts: now.toISOString(),
    path: key,
    sha256_before: shaBefore,
    sha256_after: shaBefore,
    sha256_lf: sha256Lf,
    backup: relBackup ?? toPosix(backup.path),
    why,
    job: 'snap',
  };
  const appended = appendLine(snapIndexPath(landingDir), row);
  if (appended.ok !== true) {
    return { ok: false, path: key, code: 'SNAP_INDEX_WRITE_FAILED', reasons: [`索引写入失败: ${appended.reason}`], indexLines: indexBefore };
  }
  const after = readIndex(landingDir);
  if (after.lines !== indexBefore + 1) {
    return { ok: false, path: key, code: 'SNAP_INDEX_NOT_REGISTERED', reasons: [`登记校验失败：索引行数 ${after.lines} != ${indexBefore + 1}`], indexLines: after.lines };
  }
  return {
    ok: true, path: key, relPath: normalized, sha256: shaBefore, readBackSha, backup: row.backup,
    bytes: backup.bytes, indexLines: after.lines, snapOk: `SNAP_OK=${shaBefore}`, reasons,
  };
}

/**
 * LF-310：按快照回滚某个路径。
 * @returns {{ok, code, sha256BeforeRestore, sha256AfterRestore, restoredTo, match, reasons}}
 *   code: NO_SNAPSHOT（无快照，禁静默成功）/ NO_BACKUP / SHA_MISMATCH / VERIFY_FAILED / IO
 */
export function restoreSnapshot(opts = {}) {
  const { projectRoot, landingDir, file } = opts;
  const normalized = normalizeTarget(file, projectRoot);
  if (normalized === null) return { ok: false, code: 'IO', reasons: ['路径非法或不在项目根下（无法归一）'] };
  const key = pathKey(normalized);
  const record = latestRecordFor(landingDir, key);
  if (record === null) {
    return { ok: false, code: 'NO_SNAPSHOT', path: key, reasons: [`该路径没有快照记录（禁静默成功）: ${key}`] };
  }
  const abs = existsSync(file) ? file : join(projectRoot, normalized);
  const before = existsSync(abs) ? sha256File(abs) : null;
  const backupPath = (() => {
    if (typeof record.backup !== 'string' || record.backup.trim() === '') return null;
    // 索引里的 backup 是**相对项目根**的路径；resolve 同时兼容绝对路径（实测踩到：直接当相对路径用会 ENOENT）
    return resolve(projectRoot, record.backup);
  })();
  if (backupPath === null || !existsSync(backupPath)) {
    return { ok: false, code: 'NO_BACKUP', path: key, sha256BeforeRestore: before, reasons: [`快照记录指向的备份不存在: ${record.backup ?? '(空)'}`] };
  }
  const restored = restoreFile({ src: abs, backup: backupPath, expectSha: record.sha256_before ?? null });
  if (restored.ok !== true) {
    return { ok: false, code: restored.code ?? 'IO', path: key, sha256BeforeRestore: before, reasons: [restored.reason ?? '恢复失败'] };
  }
  return {
    ok: true, code: null, path: key, sha256BeforeRestore: before, sha256AfterRestore: restored.sha256,
    restoredTo: record.sha256_before, match: restored.sha256 === record.sha256_before, reasons: [],
  };
}

/**
 * LF-320：快照↔账本对账（两类都要报）。
 * @returns {{ok, records, backups, missingBackups: object[], unrecordedBackups: object[]}}
 */
export function reconSnapshots(opts = {}) {
  const { projectRoot, landingDir } = opts;
  const index = readIndex(landingDir);
  const records = index.values;
  const referenced = new Set();
  const missingBackups = [];
  for (const row of records) {
    if (typeof row.backup !== 'string' || row.backup.trim() === '') continue;
    const abs = resolve(projectRoot, row.backup);
    referenced.add(pathKey(row.backup));
    if (!existsSync(abs)) missingBackups.push({ path: row.path ?? '(no-path)', backup: toPosix(row.backup), ts: row.ts ?? null });
  }
  const dir = backupDir(landingDir);
  const onDisk = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.bak')).sort() : [];
  const unrecordedBackups = [];
  for (const name of onDisk) {
    const rel = relativeToRoot(join(dir, name), projectRoot);
    const display = rel ?? toPosix(join(dir, name));
    if (!referenced.has(pathKey(display))) unrecordedBackups.push({ backup: toPosix(display) });
  }
  return {
    ok: missingBackups.length === 0 && unrecordedBackups.length === 0,
    indexLines: index.lines,
    indexBadLines: index.badLines,
    indexMissing: index.missing,
    indexTruncatedTail: index.truncatedTail,
    records: records.length,
    backups: onDisk.length,
    missingBackups,
    unrecordedBackups,
  };
}
