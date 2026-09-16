// dsh-rulekeeper · LF-1A0 诊断日志载体（fail-open 留痕）
//
// 铁律 3 要求「异常放行**并记日志**」；本模块定义那个日志的载体：
//   · 单文件 JSONL：<dir>/dsh-rulekeeper.log（每行一条，一行 = 一次写入）
//   · 字段：ts / level / where / err / stack / ctx（ctx 键按码位排序、值转义控制字符）
//   · 轮转：单文件超 capBytes 即向 .1/.2… 迁移，最多保留 maxFiles 个文件
//   · **fail-safe**：日志自身失败（目录不可写、盘满）绝不抛、绝不影响主流程，只返回 ok:false
//
// 归属：core 模块。零依赖：只用 node:*。

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

import { escapeControl } from './platform/out.mjs';

export const LOG_BASENAME = 'dsh-rulekeeper.log';
export const LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);
export const DEFAULT_CAP_BYTES = 256 * 1024;
export const DEFAULT_MAX_FILES = 4;

export function logFilePath(dir, index = 0) {
  return index === 0 ? join(dir, LOG_BASENAME) : join(dir, `${LOG_BASENAME}.${index}`);
}

/** 日志文件清单（.0 = 当前文件，索引越大越旧） */
export function listLogFiles(dir) {
  if (typeof dir !== 'string' || !existsSync(dir)) return [];
  const files = [];
  for (const name of readdirSync(dir)) {
    if (name === LOG_BASENAME) files.push({ file: join(dir, name), index: 0 });
    else if (name.startsWith(`${LOG_BASENAME}.`)) {
      const index = Number(name.slice(LOG_BASENAME.length + 1));
      if (Number.isInteger(index) && index > 0) files.push({ file: join(dir, name), index });
    }
  }
  return files.sort((a, b) => a.index - b.index);
}

export function totalBytes(dir) {
  let sum = 0;
  for (const { file } of listLogFiles(dir)) {
    try {
      sum += statSync(file).size;
    } catch {
      /* 已被并发删除：忽略 */
    }
  }
  return sum;
}

/** 组装一条日志（ts 由注入的 now 决定 → 可复现） */
export function makeEntry({ level = 'info', where = 'unknown', err, ctx = {}, now = new Date() } = {}) {
  const entry = {
    ts: now.toISOString(),
    level: LEVELS.includes(level) ? level : 'info',
    where: escapeControl(String(where)),
  };
  if (err !== undefined && err !== null) {
    entry.err = escapeControl(err && err.message ? err.message : String(err));
    entry.stack = escapeControl(err && err.stack ? err.stack : '');
  }
  const clean = {};
  for (const key of Object.keys(ctx).sort()) {
    const value = ctx[key];
    clean[key] = typeof value === 'string' ? escapeControl(value) : value;
  }
  entry.ctx = clean;
  return entry;
}

/**
 * 轮转：把"超 capBytes 的旧文件"往后挪一位，超过 maxFiles 的直接丢弃。
 * 处理顺序**从大索引到小索引**，避免相互覆盖。**不抛异常**，错误落在返回值里。
 */
export function rotateIfNeeded({ dir, capBytes = DEFAULT_CAP_BYTES, maxFiles = DEFAULT_MAX_FILES } = {}) {
  const result = { rotated: [], dropped: [], error: null };
  try {
    const files = listLogFiles(dir);
    for (let i = files.length - 1; i >= 0; i -= 1) {
      const { file, index } = files[i];
      if (!existsSync(file)) continue;
      if (statSync(file).size <= capBytes) continue;
      const nextIndex = index + 1;
      if (nextIndex >= maxFiles) {
        unlinkSync(file);
        result.dropped.push(file);
        continue;
      }
      const target = logFilePath(dir, nextIndex);
      if (existsSync(target)) unlinkSync(target);
      renameSync(file, target);
      result.rotated.push(`${file} -> ${target}`);
    }
  } catch (err) {
    result.error = err && err.message ? err.message : String(err);
  }
  return result;
}

/**
 * 记一条日志。**永不抛异常**（fail-safe）。
 * @returns {{ok: boolean, path: string|null, rotated: string[], dropped: string[], reason: string|null}}
 */
export function logEvent(entryInput = {}, opts = {}) {
  const { dir, capBytes = DEFAULT_CAP_BYTES, maxFiles = DEFAULT_MAX_FILES, now = new Date() } = opts;
  const result = { ok: false, path: null, rotated: [], dropped: [], reason: null };
  try {
    if (typeof dir !== 'string' || dir.trim() === '') throw new Error('logEvent 缺少 dir');
    mkdirSync(dir, { recursive: true });
    rotateIfNeeded({ dir, capBytes, maxFiles });
    const entry = makeEntry({ ...entryInput, now });
    const target = logFilePath(dir, 0);
    appendFileSync(target, `${JSON.stringify(entry)}\n`, 'utf8');
    result.ok = true;
    result.path = target;
    if (statSync(target).size > capBytes) {
      const r = rotateIfNeeded({ dir, capBytes, maxFiles });
      result.rotated = r.rotated;
      result.dropped = r.dropped;
    }
    return result;
  } catch (err) {
    result.reason = err && err.message ? err.message : String(err);
    return result;
  }
}

/** 读回全部条目（容忍尾部坏行/半行，不因一行坏而整体失败） */
export function readEntries(dir) {
  const out = { entries: [], badLines: 0, files: [] };
  try {
    for (const { file } of listLogFiles(dir)) {
      out.files.push(file);
      const text = readFileSync(file, 'utf8');
      for (const raw of text.split('\n')) {
        if (raw.trim() === '') continue;
        try {
          out.entries.push(JSON.parse(raw));
        } catch {
          out.badLines += 1;
        }
      }
    }
  } catch (err) {
    out.error = err && err.message ? err.message : String(err);
  }
  return out;
}
