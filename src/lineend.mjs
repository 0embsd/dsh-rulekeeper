// dsh-rulekeeper · **行尾形态与跨形态比对**（G3 口径，唯一权威实现）
//
// 问题（2026-09-15 源码取证 + 实测复现）：
//   · 快照基线（`snap.mjs`）哈希的是**工作区字节**；
//   · pre-commit / post-commit / bypass 三个面比对的是**索引或提交里的 blob 字节**（`git show`）；
//   · `core.autocrlf=true` 时 git 在 `add` 时把 CRLF 归一成 LF 入库 ⇒ 两侧形态不同却互比
//     ⇒ **内容没改却报"未留证"**（实测：`GATE_POSTCOMMIT_UNRECORDED`，committed(LF)≠baseline(CRLF)）。
//
// 口径（部门自决）：
//   **内容真的变了必须判红；只有行尾形态不同不算改。**
//   实现方式 = 在"原始字节 sha256"之外，再算一个"**行尾归一（CRLF→LF）形态**的 sha256"，
//   跨形态比对时允许"原形 ↔ 归一形"命中；**两侧都在同一形态**时仍按原形比（不放宽）。
//   二进制（前 8192 字节含 NUL）**不做归一**（否则改一个字节也可能被"归一"吃掉）。
//
// 归属：core 模块（`snap` 与 `gate` 共用；放中立模块以免 `snap↔gate` 循环导入）。零依赖：只用 node:*。

import { createHash } from 'node:crypto';

/** 归一形态上限：只看前 8 KB 判"是不是文本"（与 git 的二进制启发式同精神，够用且便宜） */
export const TEXT_SNIFF_BYTES = 8192;

/** 是不是二进制（前 8 KB 含 NUL 即视为二进制） */
export function isBinaryBuffer(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '');
  return buf.subarray(0, Math.min(TEXT_SNIFF_BYTES, buf.length)).includes(0);
}

/** **行尾归一形态**的 sha256（CRLF→LF）；二进制 → `null`（不做归一） */
export function sha256LfOfBuffer(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '');
  if (isBinaryBuffer(buf)) return null;
  const normalized = buf.toString('utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/** 原始字节的 sha256 */
export function sha256OfBuffer(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '');
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * **跨形态比对**（唯一实现）：blob（索引/提交）字节 ↔ 快照基线记录。
 *
 * @param {object|null} record 快照索引行（`sha256_after ?? sha256_before` 作基线；可选 `sha256_lf` = 基线的归一形态）
 * @param {Buffer} buffer blob 原始字节
 * @returns {{match: boolean, raw: string, lf: string|null, reason: string}}
 *   reason ∈ raw==baseline / lf(blob)==baseline / raw==baseline.lf / lf==lf / differ / no-baseline
 */
export function blobMatchesBaseline(record, buffer) {
  const raw = sha256OfBuffer(buffer);
  const lf = sha256LfOfBuffer(buffer);
  const after = record !== null && typeof record === 'object' && typeof record.sha256_after === 'string' && record.sha256_after !== '' ? record.sha256_after : null;
  const before = record !== null && typeof record === 'object' && typeof record.sha256_before === 'string' && record.sha256_before !== '' ? record.sha256_before : null;
  const base = after ?? before;
  const baseLf = record !== null && typeof record === 'object' && typeof record.sha256_lf === 'string' && record.sha256_lf !== '' ? record.sha256_lf : null;
  if (base === null) return { match: false, raw, lf, reason: 'no-baseline' };
  if (raw === base) return { match: true, raw, lf, reason: 'raw==baseline' };
  if (lf !== null && lf === base) return { match: true, raw, lf, reason: 'lf(blob)==baseline' };
  if (baseLf !== null && raw === baseLf) return { match: true, raw, lf, reason: 'raw==baseline.lf' };
  if (lf !== null && baseLf !== null && lf === baseLf) return { match: true, raw, lf, reason: 'lf==lf' };
  return { match: false, raw, lf, reason: 'differ' };
}
