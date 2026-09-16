// dsh-rulekeeper · LF-170 跨进程锁（缩到最小面）
//
// 设计要点（每条都有来历）：
//   ① 用 `open(path, 'wx')` **原子创建**当锁——EEXIST 即"已被持有"，无需额外协议
//   ② 锁文件里写 pid / ts / host，便于人读与事后判责
//   ③ **过期自愈**：mtime 超过 staleMs 视为陈旧锁，可抢占（防"持锁进程被杀 → 永久死锁"）
//   ④ **同进程重复取锁直接拒绝**（HELD 集合）——来历 L452：教训工具 曾因同进程内自己锁自己
//      且忘了释放句柄，导致连续 mark 全失败
//   ⑤ 句柄**显式 close**（写完即关；锁的存在性由文件承载，不由打开的句柄承载）
//   ⑥ Windows 特有：占用文件的 `unlink` 抛 **EPERM**（不是 EACCES）——删除失败**必须视为
//      "锁仍在"**，禁静默吞（吞掉就等于两把锁同时存在）
//
// 归属：core 模块。零依赖：只用 node:*。

import { closeSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';

export const DEFAULT_STALE_MS = 60_000;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_RETRY_MS = 25;

/** 同进程已持有的锁（键 = 折叠大小写的路径） */
const HELD = new Set();
const keyOf = (lockPath) => String(lockPath).toLowerCase();

/**
 * 哪些 errno 属于"竞争态"（应继续重试），而不是硬失败。
 *
 * 【2026-09-14 实测，LF-170 凭证 §4】Windows 上 `open(path,'wx')` 在**并发创建/删除同一路径**
 * 的竞争窗口里会返回 **EPERM**（不是 EEXIST）——本机 8 进程 x 100 次探针实测抓到：
 *   LOCK_FAIL i=23 stolen=0 reason=EPERM: operation not permitted, open '...\counter.lock'
 * 当时该 worker 被误判为硬失败而退出，导致 723/800（丢 77）。
 * 故 EPERM/EACCES/EBUSY 一律按"竞争态"处理（继续 stale 检查 + 重试），只有其它 errno 才算硬失败。
 */
const CONTENDED_CODES = Object.freeze(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

export function isContendedCode(code) {
  return CONTENDED_CODES.includes(code);
}

/** 同步睡眠（不引入依赖；Atomics.wait 是 Node 下标准的同步等待） */
function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function isHeldInProcess(lockPath) {
  return HELD.has(keyOf(lockPath));
}

/** 锁文件年龄（ms）；不存在返回 null */
export function lockAgeMs(lockPath, nowMs = Date.now()) {
  try {
    return Math.max(0, nowMs - statSync(lockPath).mtimeMs);
  } catch {
    return null;
  }
}

/**
 * 取锁（同步、可重试、可抢占陈旧锁）。
 * @returns {{ok: boolean, lockPath: string, stolen: number, reason: string|null}}
 */
export function acquireLock(lockPath, opts = {}) {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
  const nowMs = opts.nowMs ?? (() => Date.now());
  const start = nowMs();
  let stolen = 0;
  let lastContended = 'EEXIST';

  if (HELD.has(keyOf(lockPath))) {
    return { ok: false, lockPath, stolen: 0, reason: '同进程重复取锁（禁止：会造成自己锁自己）' };
  }

  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), ts: new Date(nowMs()).toISOString() }));
      } catch (writeErr) {
        // 写入失败会留下"空锁文件"（孤儿）——必须清掉，否则会毒化到 staleMs
        try {
          closeSync(fd);
        } catch {
          /* 见 LF-170 凭证 §5：句柄问题另行约束 */
        }
        try {
          unlinkSync(lockPath);
        } catch {
          /* 删不掉就只能等 stale（如实记录在 reason 里） */
        }
        return { ok: false, lockPath, stolen, reason: `锁文件写入失败（已尝试清理）: ${writeErr.code ?? 'ERR'}: ${writeErr.message}` };
      }
      closeSync(fd);
      HELD.add(keyOf(lockPath));
      return { ok: true, lockPath, stolen, reason: null };
    } catch (err) {
      if (!isContendedCode(err.code)) {
        return { ok: false, lockPath, stolen, reason: `${err.code ?? 'ERR'}: ${err.message}` };
      }
      lastContended = err.code ?? 'EEXIST';
    }

    const age = lockAgeMs(lockPath, nowMs());
    if (age !== null && age > staleMs) {
      try {
        unlinkSync(lockPath);
        stolen += 1;
        continue; // 立刻重试抢占
      } catch {
        // Windows：占用文件 unlink -> EPERM。**视为锁仍在**（禁静默吞）
      }
    }

    if (nowMs() - start >= timeoutMs) {
      return { ok: false, lockPath, stolen, reason: `超时 ${timeoutMs}ms 未获得锁（末次竞争码 ${lastContended}；持有者可能仍在运行）` };
    }
    sleepSync(retryMs);
  }
}

/**
 * 释放锁。**先摘同进程登记，再删文件**（顺序反了会让"同进程重复取锁"判断失真）。
 * Windows 上 unlink 可能**瞬时**失败（EPERM/EBUSY），故做**有界重试**；
 * 重试仍失败则返回 ok:false（**锁仍视为存在**，绝不静默吞）。
 * @returns {{ok: boolean, reason: string|null, code: string|null, attempts: number}}
 */
export function releaseLock(handle, opts = {}) {
  const retries = opts.retries ?? 3;
  const retryMs = opts.retryMs ?? 2;
  const lockPath = handle?.lockPath;
  if (typeof lockPath !== 'string') return { ok: false, reason: 'handle 非法', code: null, attempts: 0 };
  HELD.delete(keyOf(lockPath));
  let last = { code: null, message: '' };
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      unlinkSync(lockPath);
      return { ok: true, reason: null, code: null, attempts: attempt };
    } catch (err) {
      if (err.code === 'ENOENT') return { ok: true, reason: null, code: null, attempts: attempt }; // 已释放
      last = { code: err.code ?? null, message: err.message };
      if (attempt < retries) sleepSync(retryMs);
    }
  }
  return { ok: false, reason: `${last.code}: 删除锁文件失败（锁仍视为存在）`, code: last.code, attempts: retries };
}

/** 便捷封装：取锁 -> 执行 -> 必释放（含异常路径） */
export function withLock(lockPath, fn, opts = {}) {
  const handle = acquireLock(lockPath, opts);
  if (!handle.ok) return { ok: false, value: undefined, reason: handle.reason };
  try {
    return { ok: true, value: fn(), reason: null };
  } catch (err) {
    return { ok: false, value: undefined, reason: `${err.code ?? 'ERR'}: ${err.message}` };
  } finally {
    releaseLock(handle);
  }
}
