// dsh-rulekeeper · LF-190 账本/规则包**自身**的备份与恢复
//
// 为什么单独做这件事：LF-300 的 pre-image 快照保护的是"被保护文件"；而本系统**唯一的真实资产**
// 是账本与规则包（`.dsh-ai/lessons.json`、`rules.json`、落点 config）。既有惯例痕迹：
// `.dsh-ai/lessons.json.bak-selfevolve` —— 改账本前先备份。
//
// 三条硬要求：
//   ① 备份后**回读校验 sha256**（不信"写盘调用成功"这一事实，§9.9 第 5 步）
//   ② restore 时备份缺失 → **绝不静默成功**（返回 code=NO_BACKUP，CLI 映射 rc=4）
//   ③ 恢复前后都比 sha256：坏备份不得覆盖好文件
//
// 归属：core 模块。零依赖：只用 node:*。

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';

import { stamp } from './platform/clock.mjs';

export const BACKUP_DIR = 'backups';

export function backupDir(landingDir) {
  return join(landingDir, BACKUP_DIR);
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** 备份文件名：<原名>.<YYYYMMDD-HHMMSS>.bak（UTC，可复现） */
export function backupName(file, date) {
  return `${basename(file)}.${stamp(date)}.bak`;
}

/**
 * 备份一个文件到 <landingDir>/backups/，并**回读校验**。
 * @returns {{ok: boolean, path: string|null, sha256: string|null, bytes: number, reason: string|null}}
 */
export function backupFile(src, opts = {}) {
  const landingDir = opts.landingDir;
  const now = opts.now ?? new Date();
  try {
    if (typeof landingDir !== 'string' || landingDir.trim() === '') {
      return { ok: false, path: null, sha256: null, bytes: 0, reason: '缺少 landingDir' };
    }
    if (!existsSync(src)) {
      return { ok: false, path: null, sha256: null, bytes: 0, reason: `源文件不存在: ${src}` };
    }
    const dir = backupDir(landingDir);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, backupName(src, now));
    copyFileSync(src, target);
    const sha256 = sha256File(target);
    const bytes = statSync(target).size;
    const sourceSha = sha256File(src);
    if (sha256 !== sourceSha) {
      return { ok: false, path: target, sha256, bytes, reason: `备份回读 sha256 与源不一致（${sha256} != ${sourceSha}）` };
    }
    return { ok: true, path: target, sha256, bytes, reason: null };
  } catch (err) {
    return { ok: false, path: null, sha256: null, bytes: 0, reason: `${err.code ?? 'ERR'}: ${err.message}` };
  }
}

/**
 * 从备份恢复。
 * @returns {{ok: boolean, code: string|null, sha256: string|null, reason: string|null}}
 *   code：NO_BACKUP（备份缺失，**禁静默成功**）/ SHA_MISMATCH / VERIFY_FAILED / IO
 */
export function restoreFile(opts = {}) {
  const { src, backup } = opts;
  const expectSha = opts.expectSha ?? null;
  if (typeof src !== 'string' || typeof backup !== 'string') {
    return { ok: false, code: 'IO', sha256: null, reason: 'restoreFile 需要 src 与 backup' };
  }
  if (!existsSync(backup)) {
    return { ok: false, code: 'NO_BACKUP', sha256: null, reason: `备份文件不存在（禁静默成功）: ${backup}` };
  }
  let backupSha;
  try {
    backupSha = sha256File(backup);
  } catch (err) {
    return { ok: false, code: 'IO', sha256: null, reason: `${err.code ?? 'ERR'}: ${err.message}` };
  }
  if (expectSha !== null && backupSha !== expectSha) {
    return { ok: false, code: 'SHA_MISMATCH', sha256: backupSha, reason: `备份 sha256 不符：期望 ${expectSha} 实际 ${backupSha}（拒绝用坏备份覆盖）` };
  }
  try {
    copyFileSync(backup, src);
    const after = sha256File(src);
    if (after !== backupSha) {
      return { ok: false, code: 'VERIFY_FAILED', sha256: after, reason: `恢复后 sha256 与备份不符：${after} != ${backupSha}` };
    }
    return { ok: true, code: null, sha256: after, reason: null };
  } catch (err) {
    return { ok: false, code: 'IO', sha256: null, reason: `${err.code ?? 'ERR'}: ${err.message}` };
  }
}

/** 列出备份（可按原文件名前缀过滤），带 sha256 便于人工核对 */
export function listBackups(landingDir, fileBase = null) {
  const dir = backupDir(landingDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.bak') && (fileBase === null || name.startsWith(`${fileBase}.`)))
    .sort()
    .map((name) => {
      const path = join(dir, name);
      return { name, path, bytes: statSync(path).size, sha256: sha256File(path) };
    });
}
