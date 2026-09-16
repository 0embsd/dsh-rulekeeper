// dsh-rulekeeper · LF-190 用例：账本/规则包自身的备份与恢复
//
// 判据（清单 LF-190）：备份后篡改 → restore 回原 sha256
// 红态：备份缺失时 restore 静默成功 → exit≠0（CLI 层必须 rc=4 = NO_BACKUP，且目标文件不变）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { backupDir, backupFile, listBackups, restoreFile, sha256File } from '../src/backup.mjs';
import { runBackup } from '../src/cli.mjs';
import { RC } from '../src/rc.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

function fixture(label, content = '{"entries":[]}\n') {
  const root = tempDir(label);
  const landing = join(root, 'landing');
  mkdirSync(landing, { recursive: true });
  const src = join(root, 'lessons.json');
  writeFileSync(src, content, 'utf8');
  return { root, landing, src };
}

function capture(fn) {
  let out = '';
  let err = '';
  const rc = fn({ out: (t) => { out += String(t); }, err: (t) => { err += String(t); } });
  return { rc, out, err };
}

test('green: backupFile 落盘 + 回读 sha256 与源一致', () => {
  const { landing, src } = fixture('b-basic', '{"a":1}\n');
  const r = backupFile(src, { landingDir: landing, now: new Date('2026-09-14T00:00:00Z') });
  assert.equal(r.ok, true);
  assert.equal(r.sha256, sha256File(src));
  assert.ok(r.path.endsWith('lessons.json.20260914-000000.bak'), r.path);
  assert.equal(existsSync(r.path), true);
  assert.equal(listBackups(landing).length, 1);
});

test('green: 篡改源文件后 restore -> 回到备份时的 sha256（LF-190 主判据）', () => {
  const { landing, src } = fixture('b-restore', '{"entries":[1]}\n');
  const original = sha256File(src);
  const backup = backupFile(src, { landingDir: landing, now: new Date('2026-09-14T00:00:00Z') });
  assert.equal(backup.ok, true);

  writeFileSync(src, '{"entries":[1,2,3]}\n', 'utf8'); // 篡改
  assert.notEqual(sha256File(src), original);

  const restored = restoreFile({ src, backup: backup.path, expectSha: original });
  assert.equal(restored.ok, true);
  assert.equal(restored.sha256, original);
  assert.equal(sha256File(src), original);
});

test('red: 备份缺失 -> restore 不得静默成功（code=NO_BACKUP）', () => {
  const { landing, src } = fixture('b-nobackup');
  const missing = join(backupDir(landing), 'lessons.json.20990101-000000.bak');
  const before = sha256File(src);
  const r = restoreFile({ src, backup: missing });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_BACKUP');
  assert.equal(sha256File(src), before, '失败时目标文件不得被改动');
});

test('cli rc=4：restore 时备份缺失 -> NO_BACKUP，且目标文件不变', () => {
  const { landing, src } = fixture('b-cli-nobackup');
  const before = sha256File(src);
  const missing = join(backupDir(landing), 'nope.bak');
  const r = capture((io) => runBackup(['restore', '--file', src, '--backup', missing], io, {}));
  assert.equal(r.rc, RC.NO_BACKUP);
  assert.equal(r.rc, 4);
  assert.match(r.err, /NO_BACKUP/);
  assert.equal(r.out, '', '失败路径不得打印成功标记');
  assert.equal(sha256File(src), before);
});

test('cli rc=0：create 备份成功（含 sha256 与字节数）', () => {
  const { landing, src } = fixture('b-cli-create', '{"x":1}\n');
  const r = capture((io) => runBackup(['create', '--file', src, '--landing', landing, '--now', '2026-09-14T00:00:00Z'], io, {}));
  assert.equal(r.rc, RC.OK);
  assert.match(r.out, /RK_BACKUP_RESULT=pass/);
  assert.match(r.out, /RK_BACKUP_SHA256=[0-9a-f]{64}/);
});

test('cli rc=1：expectSha 不符 -> 拒绝用坏备份覆盖', () => {
  const { landing, src } = fixture('b-cli-badsha', '{"keep":"me"}\n');
  const backup = backupFile(src, { landingDir: landing, now: new Date('2026-09-14T00:00:00Z') });
  assert.equal(backup.ok, true);
  writeFileSync(src, '{"keep":"changed"}\n', 'utf8');
  const changed = sha256File(src);
  const r = capture((io) => runBackup(['restore', '--file', src, '--backup', backup.path, '--expect-sha', 'deadbeef'], io, {}));
  assert.equal(r.rc, RC.FAIL);
  assert.match(r.err, /SHA_MISMATCH|恢复失败/);
  assert.equal(sha256File(src), changed, '拒绝覆盖：目标文件保持原样');
});

test('red: 源文件不存在 -> 备份失败并说明原因（不得假装成功）', () => {
  const { landing, root } = fixture('b-nosrc');
  const r = backupFile(join(root, 'nope.json'), { landingDir: landing });
  assert.equal(r.ok, false);
  assert.match(r.reason, /源文件不存在/);
});
