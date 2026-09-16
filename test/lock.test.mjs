// dsh-rulekeeper · LF-170 用例：跨进程锁（原子创建 / 同进程拒绝 / 陈旧自愈 / 异常必释放）
//
// 判据（清单 LF-170）：8 进程 x 100 次受锁 RMW -> 800/800 正确（真进程部分见 scripts/lock-probe.mjs）
// 红态：①持锁进程被杀后 >T 秒仍不可获取 -> exit!=0 ②同进程重复取锁 -> exit!=0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { acquireLock, isContendedCode, isHeldInProcess, lockAgeMs, releaseLock, withLock } from '../src/lock.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const lockIn = (label) => {
  const dir = tempDir(label);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'x.lock');
};

test('取锁成功：锁文件含 pid/host/ts；释放后文件消失且可再取', () => {
  const lockPath = lockIn('lock-basic');
  const h = acquireLock(lockPath);
  assert.equal(h.ok, true);
  assert.equal(existsSync(lockPath), true);
  const body = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert.equal(body.pid, process.pid);
  assert.equal(typeof body.host, 'string');
  assert.equal(isHeldInProcess(lockPath), true);
  assert.equal(releaseLock(h).ok, true);
  assert.equal(existsSync(lockPath), false);
  assert.equal(isHeldInProcess(lockPath), false);
  const again = acquireLock(lockPath);
  assert.equal(again.ok, true);
  releaseLock(again);
});

test('red: 同进程重复取锁必须被拒（来历 L452：自己锁自己）', () => {
  const lockPath = lockIn('lock-reentrant');
  const h = acquireLock(lockPath);
  assert.equal(h.ok, true);
  const second = acquireLock(lockPath, { timeoutMs: 50, retryMs: 5 });
  assert.equal(second.ok, false);
  assert.match(second.reason, /同进程重复取锁/);
  releaseLock(h);
});

test('red: 锁被他人持有（mtime 新鲜）-> 超时失败（证明锁真的会挡）', () => {
  const lockPath = lockIn('lock-held');
  writeFileSync(lockPath, JSON.stringify({ pid: 999999, host: 'other', ts: new Date().toISOString() }), 'utf8');
  const r = acquireLock(lockPath, { timeoutMs: 80, retryMs: 5, staleMs: 60000 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /超时/);
  assert.equal(existsSync(lockPath), true, '不得误删他人锁');
});

test('陈旧自愈：mtime 超 staleMs 的锁可被抢占（防"持锁进程被杀 -> 永久死锁"）', () => {
  const lockPath = lockIn('lock-stale');
  writeFileSync(lockPath, JSON.stringify({ pid: 999999, host: 'dead', ts: new Date().toISOString() }), 'utf8');
  const old = new Date(Date.now() - 10_000);
  utimesSync(lockPath, old, old);
  assert.ok(lockAgeMs(lockPath) >= 9_000);
  const r = acquireLock(lockPath, { staleMs: 1_000, timeoutMs: 2_000, retryMs: 5 });
  assert.equal(r.ok, true);
  assert.ok(r.stolen >= 1, `应记录抢占次数，实测 ${r.stolen}`);
  releaseLock(r);
});

test('withLock：无论正常还是抛异常都必释放（异常路径不留死锁）', () => {
  const lockPath = lockIn('lock-withlock');
  const okRun = withLock(lockPath, () => 42);
  assert.equal(okRun.ok, true);
  assert.equal(okRun.value, 42);
  assert.equal(existsSync(lockPath), false);

  const bad = withLock(lockPath, () => {
    throw new Error('boom');
  });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /boom/);
  assert.equal(existsSync(lockPath), false, '异常路径也必须释放锁');
  const reusable = acquireLock(lockPath, { timeoutMs: 100 });
  assert.equal(reusable.ok, true);
  releaseLock(reusable);
});

test('releaseLock：文件已被并发清掉时等价于已释放（ENOENT 不算失败）', () => {
  const lockPath = lockIn('lock-enoent');
  const h = acquireLock(lockPath);
  assert.equal(h.ok, true);
  unlinkSync(lockPath); // 模拟"别的清理者先删掉了"
  const r = releaseLock(h);
  assert.equal(r.ok, true);
  assert.equal(r.code, null);
});

test('lockAgeMs：不存在返回 null（不得抛）', () => {
  assert.equal(lockAgeMs(join(tempDir('lock-absent'), 'nope.lock')), null);
});

test('竞争码分类：Windows 的 EPERM/EACCES/EBUSY 算竞争态（不可当硬失败）', () => {
  // 来历：8 进程探针实测 open(...,'wx') 在并发创建/删除窗口返回 EPERM -> 曾被误判硬失败（723/800）
  for (const code of ['EEXIST', 'EPERM', 'EACCES', 'EBUSY']) {
    assert.equal(isContendedCode(code), true, `${code} 应算竞争态`);
  }
  for (const code of ['ENOENT', 'ENOSPC', 'EROFS', 'EINVAL', undefined]) {
    assert.equal(isContendedCode(code), false, `${code} 不应算竞争态`);
  }
});
