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
import { basename, join, relative, resolve } from 'node:path';

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
  // 2026-09-23：允许调用方**直接给已算好的相对段**（`relPath`），此时不再依赖 `normalizeTarget` 的推断。
  //   为什么：CI 的 Ubuntu/macOS 作业上 `normalizeTarget` 在"落点在别处、cwd 不是项目根"的形态下
  //   返回了**绝对路径** ⇒ 索引里存绝对路径 ⇒ 闸门与保护面 glob（按项目相对比）判"从未留证"
  //   （GATE_WRITE_NO_SNAPSHOT）、提交被拒。修法取"构造"而非"推断"：项目根 = 落点上溯两级（结构事实），
  //   故相对段可以**算出来**而不是猜出来。`relPath` 传入时仍做合法性检查（不得绝对、不得含 `..`）。
  const explicitRel = typeof opts.relPath === 'string' && opts.relPath.trim() !== ''
    ? toPosix(opts.relPath.trim()).replace(/^\.\//, '')
    : null;
  if (explicitRel !== null && (explicitRel.startsWith('/') || /^[A-Za-z]:/.test(explicitRel) || explicitRel.split('/').includes('..'))) {
    return { ok: false, path: null, reasons: [`relPath 非法（不得为绝对路径或含 ..）: ${opts.relPath}`], indexLines: 0 };
  }
  const key = pathKey(explicitRel ?? normalized);
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
 * LF-320：快照↔账本对账（**P23 起分级**，2026-09-23）。
 *
 * 现场（治理项目独立复核 + 本仓实测）：旧实现用 `resolve(projectRoot, row.backup)` 找备份，而备份实际在
 * **落点**的 `backups/`（`backupDir(landingDir)`），索引里写的是**落点相对**路径。落点一搬家（迁移），
 * 索引仍指旧位置 ⇒ 报 `MISSING_BACKUP`（对方 12 条），而备份**一条没丢**。同族的第二处：未记录备份的
 * 比对口径（盘上文件按项目根相对 vs 索引值）不同源 ⇒ 同一文件两串不同 ⇒ `UNRECORDED_BACKUP`（我们 10 条），
 * 而旧口径 `ok = 两者都为 0` ⇒ "迁移遗留"与"真删了备份"被**同一个红**表达。
 *
 * 现口径（**只在真有备份被删时判红**）：
 *   · `missingBackups`：按落点相对 → 项目根相对**依次**解析；都指不到时，再看落点 `backups/` 里有没有**同名**文件
 *     —— 有 ⇒ 计 `relocatedBackups`（迁移形态，**不算丢失**，只审计）；确实没有同名 ⇒ 才进 `missingBackups`（真丢失）。
 *   · `unrecordedBackups`：盘上有、索引没引用。**按 basename 集合**与索引里出现过的 basename 比对：
 *     命中 ⇒ 归 `supersededUnrecordedBackups`（同一个源文件的历史备份，**不计入 ok**，只计数）；
 *     否则才是 `unrecordedBackups`（计入 ok —— 这可能是"快照失败留下的孤儿"，值得人看一眼）。
 *   · `ok` 只用真丢失 + 真未记录判定；两类"遗留"进独立字段供审计。
 * @returns {{ok, records, backups, missingBackups: object[], unrecordedBackups: object[], relocatedBackups: object[], supersededUnrecordedBackups: object[]}}
 */
/**
 * **快照从不备份的落点管理文件**（源文件名）：`backups/` 是共用目录，绑定写通路也往里放备份；
 * 拿"快照对账"去数它们 = 对象错位（规则 41 同族）。
 */
const SNAPSHOT_NEVER_BACKED_UP = Object.freeze(new Set(['rules.json', 'config.json', 'hooks.json', 'index.jsonl']));

export function reconSnapshots(opts = {}) {  const { projectRoot, landingDir } = opts;
  const index = readIndex(landingDir);
  const records = index.values;
  const dir = backupDir(landingDir);
  const onDisk = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.bak')).sort() : [];
  const onDiskSet = new Set(onDisk);

  // 索引里出现过的备份：① 原样值（供"盘上路径 ↔ 索引值"同源比对）② basename 集合（供迁移/换名后的归属判定）
  const referenced = new Set();
  const recordedBasenames = new Set();
  for (const row of records) {
    if (typeof row.backup !== 'string' || row.backup.trim() === '') continue;
    referenced.add(pathKey(row.backup));
    recordedBasenames.add(pathKey(basename(toPosix(row.backup))));
  }

  const missingBackups = [];
  const relocatedBackups = [];
  for (const row of records) {
    if (typeof row.backup !== 'string' || row.backup.trim() === '') continue;
    const rel = toPosix(row.backup);
    const candidates = [resolve(landingDir, rel), resolve(projectRoot, rel)];
    if (candidates.some((p) => existsSync(p))) continue;                 // 指得到 ⇒ 没丢
    const name = basename(rel);
    if (onDiskSet.has(name)) {
      // **迁移形态**：备份被搬到落点的 backups/ 且仍用原名 ⇒ 不是丢失
      relocatedBackups.push({ path: row.path ?? '(no-path)', backup: rel, ts: row.ts ?? null });
      continue;
    }
    missingBackups.push({ path: row.path ?? '(no-path)', backup: rel, ts: row.ts ?? null });
  }

  const unrecordedBackups = [];
  const supersededUnrecordedBackups = [];
  const nonSnapshotBackups = [];
  for (const name of onDisk) {
    // **同源比对**：用"落点相对的备份名"与索引值比（旧实现用项目根相对路径，同一文件两串不同 ⇒ 恒不等）
    const display = toPosix(join(relative(projectRoot, dir) ?? '', name)).replace(/^\.\//, '');
    const byPath = referenced.has(pathKey(display)) || referenced.has(pathKey(join(toPosix(relative(projectRoot, dir) ?? ''), name)));
    if (byPath) continue;
    // 索引里引用过**同名**文件（同一个源文件在别的时刻的快照备份）⇒ 归"遗留"，不计入 ok
    if (recordedBasenames.has(pathKey(name))) {
      supersededUnrecordedBackups.push({ backup: display, reason: '同一源文件的历史快照备份（索引里引用过同名文件）⇒ 遗留，不计入判定' });
      continue;
    }
    // **另一类"不是快照的备份"**（实测口径，2026-09-23）：落点 `backups/` 是**共用目录** —— 除了快照的前像，
    // 里面还有**绑定写通路自己的备份**（`rules.json.<ts>.bak`）与**快照索引自身**的历史（`index.jsonl.<ts>.bak`）。
    // 它们与快照索引**本来就无关**（快照从不备份管理文件）⇒ 旧口径把这 9 个报成"有备份无记录"并让整条 recon 判红，
    // 等于拿"快照对账"去数"别的机制的备份"。判据落在**该文件自己的事实**上（两条，任一命中即归类）：
    //   ① 命名不是快照形态（快照备份名 = `<源文件>.<YYYYMMDD-HHMMSS>.bak`，见 backup.mjs 的命名）；
    //   ② 源文件是**落点管理文件**（`rules.json` / `config.json` / `hooks.json` / `index.jsonl`）—— 快照不备份它们。
    const sourceName = name.replace(/\.\d{8}-?\d{6}\.bak$/, '');
    const isSnapshotNaming = /\.\d{8}-\d{6}\.bak$/.test(name);
    if (!isSnapshotNaming || SNAPSHOT_NEVER_BACKED_UP.has(sourceName)) {
      nonSnapshotBackups.push({ backup: display, reason: `不是快照前像（${!isSnapshotNaming ? '命名不是快照形态' : `源文件 ${sourceName} 属落点管理文件，快照不备份它`}）⇒ 来自绑定写通路/索引自身，与快照索引无关，不计入判定` });
      continue;
    }
    unrecordedBackups.push({ backup: display, reason: '盘上有、索引从未引用过 ⇒ 可能是快照失败留下的孤儿（值得看一眼）' });
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
    relocatedBackups,
    supersededUnrecordedBackups,
    nonSnapshotBackups,
  };
}
