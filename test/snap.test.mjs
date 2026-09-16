// dsh-rulekeeper · LF-300 + LF-310 + LF-320
//
// 判据（清单 §3）：
//   LF-300  `SNAP_OK` == 真实 sha256；回读一致；索引登记 **+1 行**。红态：回读不一致 → 非 0 exit 并报警（且不登记）。
//   LF-310  `restore <path>`：真回滚后 sha256 == 改前（凭证贴两个 hash）。红态：无快照 → **不得静默成功**（NO_SNAPSHOT(3)）。
//   LF-320  快照↔账本对账："有记录无备份"与"有备份无记录"两类都要报出。红态：漏报任一类 → exit≠0。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runRulekeeper, runSnap } from '../src/cli.mjs';
import { RC } from '../src/rc.mjs';
import { latestRecordFor, reconSnapshots, readIndex, restoreSnapshot, takeSnapshot } from '../src/snap.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const NOW = '2026-09-14T00:00:00Z';

function capture(fn) {
  let out = '';
  let err = '';
  const rc = fn({ out: (t) => { out += String(t); }, err: (t) => { err += String(t); } });
  return { rc, out, err };
}

const snap = (args) => capture((io) => runSnap(args, io, {}));

/** 项目 + 落点 + 一个受保护文件 */
function scene(label, content = 'v1\n') {
  const root = tempDir(label);
  const landing = join(root, '.dsh-ai', 'rulekeeper');
  mkdirSync(landing, { recursive: true });
  writeFileSync(join(landing, 'config.json'), `${JSON.stringify({ schema: 1, mode: 'observe' }, null, 2)}\n`, 'utf8');
  mkdirSync(join(root, 'src'), { recursive: true });
  const file = join(root, 'src', 'target.txt');
  writeFileSync(file, content, 'utf8');
  return { root, landing, file };
}

test('判据 LF-300：SNAP_OK == 真实 sha256、回读一致、索引 +1 行', () => {
  const { root, landing, file } = scene('snap-take');
  const realSha = createHash('sha256').update(readFileSync(file)).digest('hex');
  const r = snap(['take', '--landing', landing, '--project', root, '--path', file, '--now', NOW]);
  assert.equal(r.rc, RC.OK, r.err + r.out);
  assert.match(r.out, new RegExp(`SNAP_OK=${realSha}`), 'SNAP_OK 必须等于文件真实 sha256');
  assert.match(r.out, new RegExp(`RK_SNAP_SHA256_BEFORE=${realSha}`));
  assert.match(r.out, new RegExp(`RK_SNAP_READBACK_SHA256=${realSha}`), '回读 sha 必须与源一致');
  assert.match(r.out, /RK_SNAP_PATH=src\/target\.txt/);
  assert.match(r.out, /RK_SNAP_INDEX_LINES=1/);
  assert.match(r.out, /RK_SNAP_BACKUP=\.dsh-ai\/rulekeeper\/backups\/target\.txt\./);
  assert.match(r.out, /RK_SNAP_RESULT=pass/);
  // 备份真实存在且内容等于源
  const backupRel = /RK_SNAP_BACKUP=(.+)/.exec(r.out)[1].trim();
  assert.deepEqual(readFileSync(join(root, backupRel)), readFileSync(file));
  // 索引登记 +1 行（且字段合冻结表）
  const index = readIndex(landing);
  assert.equal(index.lines, 1);
  assert.equal(index.values[0].path, 'src/target.txt');
  assert.equal(index.values[0].sha256_before, realSha);
  assert.equal(index.values[0].job, 'snap');
  // 第二次 take -> 索引 +1（2 行）
  assert.equal(snap(['take', '--landing', landing, '--project', root, '--path', file, '--now', '2026-09-14T01:00:00Z']).out.includes('RK_SNAP_INDEX_LINES=2'), true);
});

test('红态 LF-300：回读不一致 -> 非 0 exit + 报警 + **不登记**', () => {
  const { root, landing, file } = scene('snap-readback');
  // 仅测试注入：拷完立刻把备份改坏一个字节
  const direct = takeSnapshot({ projectRoot: root, landingDir: landing, file, now: new Date(NOW), _inject: { corruptBackupAfterCopy: true } });
  assert.equal(direct.ok, false);
  assert.equal(direct.code, 'SNAP_READBACK_MISMATCH');
  assert.equal(readIndex(landing).lines, 0, '回读不一致时不得登记');
  // CLI 同源（用同一注入入口 --corrupt-backup-after-copy，取证专用）
  const r = snap(['take', '--landing', landing, '--project', root, '--path', file, '--now', NOW, '--corrupt-backup-after-copy']);
  assert.equal(r.rc, RC.FAIL);
  assert.match(r.out, /RK_SNAP_CODE=SNAP_READBACK_MISMATCH/);
  assert.match(r.out, /FINDING SNAP_READBACK_MISMATCH 回读 sha256 与源不一致/);
  assert.equal(readIndex(landing).lines, 0);
});

test('判据 LF-310：真回滚后 sha256 == 改前（贴两个 hash）', () => {
  const { root, landing, file } = scene('snap-restore');
  const before = readFileSync(file, 'utf8');
  assert.equal(snap(['take', '--landing', landing, '--project', root, '--path', file, '--now', NOW]).rc, RC.OK);
  const shaBefore = latestRecordFor(landing, 'src/target.txt').sha256_before;
  writeFileSync(file, 'CHANGED\n', 'utf8');
  const changedSha = createHash('sha256').update(readFileSync(file)).digest('hex');
  assert.notEqual(changedSha, shaBefore);
  const r = snap(['restore', '--landing', landing, '--project', root, '--path', file]);
  assert.equal(r.rc, RC.OK, r.err + r.out);
  assert.match(r.out, new RegExp(`SHA256_BEFORE_RESTORE=${changedSha}`), '必须贴出改后的 hash');
  assert.match(r.out, new RegExp(`SHA256_AFTER_RESTORE=${shaBefore}`), '必须贴出回滚后的 hash');
  assert.match(r.out, new RegExp(`RESTORED_TO=${shaBefore}`));
  assert.match(r.out, /RK_RESTORE_MATCH=true/);
  assert.equal(readFileSync(file, 'utf8'), before, '内容逐字回到改前');
  assert.equal(r.out.includes('RK_RESTORE_RESULT=pass'), true);
});

test('cli rc=3：restore 时该路径没有快照 -> NO_SNAPSHOT，且目标文件不变', () => {
  const { root, landing, file } = scene('snap-nosnap', 'untouched\n');
  const before = readFileSync(file, 'utf8');
  const r = snap(['restore', '--landing', landing, '--project', root, '--path', file]);
  assert.equal(r.rc, RC.NO_SNAPSHOT);
  assert.equal(r.rc, 3);
  assert.match(r.out, /RK_RESTORE_CODE=NO_SNAPSHOT/);
  assert.match(r.out, /FINDING RESTORE_NO_SNAPSHOT 该路径没有快照记录（禁静默成功）/);
  assert.equal(readFileSync(file, 'utf8'), before, '无快照时不得动目标文件');
  // 纯函数层同源
  const direct = restoreSnapshot({ projectRoot: root, landingDir: landing, file });
  assert.equal(direct.ok, false);
  assert.equal(direct.code, 'NO_SNAPSHOT');
});

test('红态 LF-310：有记录但备份被删 -> NO_BACKUP(4)（且目标文件不变）', () => {
  const { root, landing, file } = scene('snap-nobak');
  assert.equal(snap(['take', '--landing', landing, '--project', root, '--path', file, '--now', NOW]).rc, RC.OK);
  const rec = latestRecordFor(landing, 'src/target.txt');
  rmSync(join(root, rec.backup), { force: true });
  writeFileSync(file, 'changed\n', 'utf8');
  const r = snap(['restore', '--landing', landing, '--project', root, '--path', file]);
  assert.equal(r.rc, RC.NO_BACKUP);
  assert.equal(r.rc, 4);
  assert.match(r.out, /RK_RESTORE_CODE=NO_BACKUP/);
  assert.equal(readFileSync(file, 'utf8'), 'changed\n', '备份缺失时不得动目标文件');
});

test('判据 LF-320：两类对账都能报出（有记录无备份 / 有备份无记录）', () => {
  const { root, landing, file } = scene('snap-recon');
  assert.equal(snap(['take', '--landing', landing, '--project', root, '--path', file, '--now', NOW]).rc, RC.OK);
  const rec = latestRecordFor(landing, 'src/target.txt');
  // 类 A：有记录无备份
  rmSync(join(root, rec.backup), { force: true });
  // 类 B：有备份无记录（手工放一个没被索引引用的备份）
  writeFileSync(join(landing, 'backups', 'orphan.txt.20260914-000000.bak'), 'orphan\n', 'utf8');
  const r = snap(['recon', '--landing', landing, '--project', root]);
  assert.equal(r.rc, RC.FAIL, '两类非空必须 exit≠0');
  assert.match(r.out, /RK_RECON_MISSING_BACKUPS=1/);
  assert.match(r.out, /RK_RECON_UNRECORDED_BACKUPS=1/);
  assert.match(r.out, /MISSING_BACKUP src\/target\.txt backup=\.dsh-ai\/rulekeeper\/backups\//);
  assert.match(r.out, /UNRECORDED_BACKUP .*orphan\.txt\./);
  assert.match(r.out, /FINDING SNAP_RECON_MISSING_BACKUP 有记录无备份 1 条/);
  assert.match(r.out, /FINDING SNAP_RECON_UNRECORDED_BACKUP 有备份无记录 1 条/);
  const direct = reconSnapshots({ projectRoot: root, landingDir: landing });
  assert.equal(direct.ok, false);
  assert.equal(direct.missingBackups.length, 1);
  assert.equal(direct.unrecordedBackups.length, 1);
});

test('判据 LF-320：对账通过时 exit 0（正常快照 + 无孤儿）', () => {
  const { root, landing, file } = scene('snap-recon-ok');
  assert.equal(snap(['take', '--landing', landing, '--project', root, '--path', file, '--now', NOW]).rc, RC.OK);
  const r = snap(['recon', '--landing', landing, '--project', root]);
  assert.equal(r.rc, RC.OK, r.out);
  assert.match(r.out, /RK_RECON_MISSING_BACKUPS=0/);
  assert.match(r.out, /RK_RECON_UNRECORDED_BACKUPS=0/);
  assert.match(r.out, /RK_RECON_RESULT=pass/);
});

test('判据：`dsh-rulekeeper snap` 与 `rk-snap take` 是同一实现（同一套 token）', () => {
  const a = scene('snap-entry');
  const b = scene('snap-entry2');
  const viaBin = snap(['take', '--landing', a.landing, '--project', a.root, '--path', a.file, '--now', NOW]);
  const viaCli = capture((io) => runRulekeeper(['snap', '--landing', b.landing, '--project', b.root, '--path', b.file, '--now', NOW], io, {}));
  // 两个落点的绝对路径不同 -> 归一化后 token 必须逐字相同（路径已在输出中相对化/固定）
  const stripLanding = (s) => s.replace(/RK_SNAP_LANDING=.*/g, 'RK_SNAP_LANDING=<x>');
  assert.equal(stripLanding(viaCli.out), stripLanding(viaBin.out), '两个入口必须逐字同输出（禁止两套口径）');
  assert.equal(viaCli.rc, viaBin.rc);
  const jsonA = snap(['take', '--landing', a.landing, '--project', a.root, '--path', a.file, '--now', '2026-09-14T02:00:00Z', '--json']);
  const jsonB = capture((io) => runRulekeeper(['snap', '--landing', a.landing, '--project', a.root, '--path', a.file, '--now', '2026-09-14T02:00:00Z', '--json'], io, {}));
  assert.equal(JSON.parse(jsonB.out).snapOk, JSON.parse(jsonA.out).snapOk);
});

test('红态：参数错误 -> rc=2（缺 --landing / 缺 --path / 未知子命令 / 非法 --now）', () => {
  const { root, landing, file } = scene('snap-usage');
  assert.equal(snap(['take', '--project', root, '--path', file]).rc, RC.USAGE);
  assert.equal(snap(['take', '--landing', landing, '--project', root]).rc, RC.USAGE);
  assert.equal(snap(['bogus', '--landing', landing]).rc, RC.USAGE);
  assert.equal(snap(['take', '--landing', landing, '--project', root, '--path', file, '--now', 'nope']).rc, RC.USAGE);
  assert.equal(snap(['take', '--landing', join(root, 'nope'), '--path', file]).rc, RC.USAGE);
  assert.equal(snap(['--help']).rc, RC.OK);
  assert.equal(snap([]).rc, RC.USAGE);
});

test('判据：快照后把文件改回"改前内容"，restore 仍应成功（幂等回滚）', () => {
  const { root, landing, file } = scene('snap-idem');
  assert.equal(snap(['take', '--landing', landing, '--project', root, '--path', file, '--now', NOW]).rc, RC.OK);
  const rec = latestRecordFor(landing, 'src/target.txt');
  writeFileSync(file, 'dirty\n', 'utf8');
  assert.equal(snap(['restore', '--landing', landing, '--project', root, '--path', file]).rc, RC.OK);
  const sizeAfterFirst = statSync(file).size;
  const again = snap(['restore', '--landing', landing, '--project', root, '--path', file]);
  assert.equal(again.rc, RC.OK);
  assert.equal(statSync(file).size, sizeAfterFirst);
  assert.equal(readFileSync(file, 'utf8'), 'v1\n');
  assert.equal(rec.sha256_before.length, 64);
  assert.equal(existsSync(join(landing, 'snapshots', 'index.jsonl')), true);
});

// 【LF-820 止损 Runbook 实测抓到的真缺陷，2026-09-15】SL-4 的命令是
//   `rk-snap take --landing <落点> --path <文件> --project <项目根>`（Runbook 里的**一句可复制命令**），
//   而 `--path` 当时按 **CWD** 解析（`resolve(flags.path)`）→ 它去给"当前工作目录"的同名文件拍快照，
//   受保护文件依旧"未留证" ⇒ Runbook 的复位动作**做不到**（正是 LF-820 判据的红）。
// 判据：给了 `--project` 时，**相对** `--path` 必须相对 `--project` 解析（与 rk-gate/rk-check 既有口径一致）；
//       **绝对**路径照给（显式绝对路径就是要那个文件）。
test('判据（LF-820 抓到）: 相对 --path 按 --project 解析（不是 CWD）；绝对路径不受影响', () => {
  const { root, landing, file } = scene('snap-relpath');
  const rel = snap(['take', '--landing', landing, '--project', root, '--path', 'src/target.txt', '--now', NOW]);
  assert.equal(rel.rc, RC.OK, rel.err);
  assert.match(rel.out, /RK_SNAP_PATH=src\/target\.txt/, `实测输出: ${rel.out}`);
  const rec = latestRecordFor(landing, 'src/target.txt');
  assert.notEqual(rec, null, '相对路径必须落进项目根的索引项（按 CWD 解析会落到别的文件）');
  assert.equal(rec.sha256_before, createHash('sha256').update(readFileSync(file)).digest('hex'));

  const abs = snap(['take', '--landing', landing, '--project', root, '--path', file, '--now', NOW]);
  assert.equal(abs.rc, RC.OK, abs.err);
  assert.match(abs.out, /RK_SNAP_PATH=src\/target\.txt/);
});
