// dsh-rulekeeper · LF-160 单行写入原子性契约
//
// 契约（一句话）：**一行 = 一次 `fs.writeSync(fd, buf)`**，且**先序列化成单个 Buffer**。
//
// 为什么：并发追加时，只有"单次 write"才是原子的（本机实测：8 进程 x 250 行 x 170B 的
// appendFileSync -> 2000/2000 且 0 解析失败）；一旦把一行拆成多段 write，别的进程的写会
// 插进中间 —— 行被撕裂（`scripts/atomicity-probe.mjs --impl segmented` 可复现）。
// 反方向也不行：整文件读-改-写会丢更新（见 LF-120 的 demo-rmw-loss）。
//
// 边界（诚实）：本契约只保证**本机本地盘**上的单次写入不撕裂。SMB/NFS/网络盘、AV/EDR
// 过滤驱动、以及单行超过 filesystem 原子写上限的情况**未验证**，故加行长上限断言。
//
// 归属：core 模块。零依赖：只用 node:*。

import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';

/** 行长上限：超过即拒绝写入（不是一个"性能建议"，而是契约的一部分） */
export const DEFAULT_MAX_LINE_BYTES = 256 * 1024;

/**
 * 把值编码成"一行"（含结尾 LF）的单个 Buffer。
 * @returns {{ok: true, buf: Buffer, text: string} | {ok: false, reason: string}}
 */
export function encodeLine(value, opts = {}) {
  const maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof text !== 'string') return { ok: false, reason: 'value 无法序列化为字符串' };
  if (text.includes('\n') || text.includes('\r')) {
    return { ok: false, reason: '一行内不得含换行/回车（多行内容必须先转义）' };
  }
  const buf = Buffer.from(`${text}\n`, 'utf8');
  if (buf.length > maxLineBytes) {
    return { ok: false, reason: `行长 ${buf.length} 超过上限 ${maxLineBytes}` };
  }
  return { ok: true, buf, text };
}

/**
 * 追加一行：**单次 writeSync**。
 * 短写（writeSync 返回 < 长度）**不得分段续写**——那会破坏"一行 = 一次写"，只回报失败。
 * @returns {{ok: boolean, bytes: number, reason: string|null, file: string}}
 */
export function appendLine(file, value, opts = {}) {
  const encoded = encodeLine(value, opts);
  if (!encoded.ok) return { ok: false, bytes: 0, reason: encoded.reason, file };
  let fd;
  try {
    fd = openSync(file, 'a');
    const written = writeSync(fd, encoded.buf, 0, encoded.buf.length, null);
    if (written !== encoded.buf.length) {
      return { ok: false, bytes: written, reason: `短写：期望 ${encoded.buf.length} 实际 ${written}（禁分段续写）`, file };
    }
    return { ok: true, bytes: written, reason: null, file };
  } catch (err) {
    return { ok: false, bytes: 0, reason: `${err.code ?? 'ERR'}: ${err.message}`, file };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* 关闭失败不影响已写入事实；句柄泄漏由 LF-170 的锁路径另行约束 */
      }
    }
  }
}

/**
 * 容错读取 JSONL：逐行 parse，**坏行不导致整体失败**（供 LF-180 doctor 使用）。
 * 区分三种"不干净"：
 *   badLines      该行不是合法 JSON（撕裂行、被截断的历史行）
 *   oversized     行长超过上限（可能是撕裂拼接的结果）
 *   truncatedTail 文件末尾没有换行 = 最后一行没写完（崩溃时的半行）
 */
export function readLines(file, opts = {}) {
  const maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const out = { lines: [], values: [], badLines: 0, oversized: 0, truncatedTail: false, bytes: 0, missing: false, error: null };
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    out.missing = err.code === 'ENOENT';
    out.error = out.missing ? null : `${err.code ?? 'ERR'}: ${err.message}`;
    return out;
  }
  out.bytes = Buffer.byteLength(text, 'utf8');
  if (text === '') return out;
  const parts = text.split('\n');
  const endsWithNewline = text.endsWith('\n');
  for (let i = 0; i < parts.length; i += 1) {
    const line = parts[i];
    const isLast = i === parts.length - 1;
    if (isLast && line === '') continue; // 正常结尾
    if (isLast && !endsWithNewline) {
      out.truncatedTail = true;
      out.badLines += 1;
      continue;
    }
    if (Buffer.byteLength(line, 'utf8') > maxLineBytes) out.oversized += 1;
    out.lines.push(line);
    try {
      out.values.push(JSON.parse(line));
    } catch {
      out.badLines += 1;
    }
  }
  return out;
}
