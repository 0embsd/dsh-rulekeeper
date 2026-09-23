// dsh-rulekeeper · P23 用例：快照↔备份对账的**分级**（只在真有备份被删时判红）
//
// 现场（治理项目独立复核 + 本仓实测，2026-09-23）：
//   ① `reconSnapshots` 用 `resolve(projectRoot, row.backup)` 找备份，而备份实际在**落点**的 `backups/`
//      （`backupDir(landingDir)`），索引里写的是落点相对路径 ⇒ 落点一搬家（迁移），索引仍指旧位置
//      ⇒ 报 `MISSING_BACKUP`（对方 12 条），而备份**一条没丢**。
//   ② `UNRECORDED_BACKUP` 拿"盘上文件的项目根相对路径"与索引值比 ⇒ 同一文件两串不同 ⇒ 误报；
//      而且落点 `backups/` 是**共用目录**（绑定写通路也往里放 `rules.json.*.bak`、索引自身也有历史备份）
//      ⇒ 拿"快照对账"去数别的机制的备份。旧口径 `ok = 两者都为 0` ⇒ 只要 >0 就 exit≠0。
//
// 本文件的判据（成对，缺一不算）：
//   ① **迁移形态**：备份在落点 `backups/` 里同名存在（索引里是旧路径）⇒ **不得**判红（计 `relocated`）
//   ② **真丢失**：删掉一个**被记录**的备份 ⇒ **必须**判红且点名（这是这条判据存在的理由）
//   ③ **共用目录**：绑定写通路的 `rules.json.*.bak` 在 `backups/` 里 ⇒ 计 `nonSnapshot`、**不计入 ok**
//   ④ 计数可核：`records`/`backups`/三类分级的数字与盘上事实一致（不是"看着像"）
//
// 反向红：把解析退回 `resolve(projectRoot, …)`（修复前）⇒ ① 必红。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { reconSnapshots } from '../src/snap.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const INDEX_REL = 'snapshots/index.jsonl';

/**
 * 造一个落点：`backups/` 下一个备份文件 + 索引里一行记录。
 * `backupPathInIndex` 可用来模拟"索引里写的是**旧**（项目根相对）路径"这种迁移形态。
 */
function landingWith({ label, backupName, indexBackupPath = null, withIndexFile = true }) {
  const projectRoot = tempDir(label);
  const landing = join(projectRoot, '.dsh-ai', 'rulekeeper');
  const backups = join(landing, 'backups');
  mkdirSync(backups, { recursive: true });
  if (withIndexFile) writeFileSync(join(backups, backupName), 'backup content\n', 'utf8');
  const row = {
    schema: 1, ts: '2026-09-23T10:00:00.000Z', path: 'src/x.mjs',
    sha256_before: 'a'.repeat(64), sha256_after: 'a'.repeat(64),
    backup: indexBackupPath ?? `.dsh-ai/rulekeeper/backups/${backupName}`, why: 'test',
  };
  mkdirSync(join(landing, 'snapshots'), { recursive: true });
  writeFileSync(join(landing, INDEX_REL), `${JSON.stringify(row)}\n`, 'utf8');
  return { projectRoot, landing, backups, row };
}

test('P23①: 迁移形态 —— 索引指旧位置、备份已在落点 backups/ 同名存在 ⇒ 不得判红', () => {
  // ⚠ 夹具要真的是"指不到"：索引写**迁移前的落点**布局（`.dsh-ai/backups/…`），而文件现在在
  // `.dsh-ai/rulekeeper/backups/…`（新落点）⇒ 两个候选解析都指不到 ⇒ 靠"落点 backups/ 里同名"承认为 relocated。
  // （第一版夹具写成 `backups/x.mjs…bak` ⇒ 从项目根**指得到** ⇒ 根本不需要回退，用例测的是别的东西。）
  const { projectRoot, landing } = landingWith({
    label: 'p23-relocated',
    backupName: 'x.mjs.20260923-100000.bak',
    indexBackupPath: '.dsh-ai/backups/x.mjs.20260923-100000.bak',   // 旧落点布局
  });
  const r = reconSnapshots({ projectRoot, landingDir: landing });
  assert.equal(r.missingBackups.length, 0, `迁移后不得报'有记录无备份'；missing=${JSON.stringify(r.missingBackups)}`);
  assert.equal(r.relocatedBackups.length, 1, `应如实记为 relocated（供审计）；relocated=${JSON.stringify(r.relocatedBackups)}`);
  assert.equal(r.ok, true, `迁移形态必须绿；unrecorded=${JSON.stringify(r.unrecordedBackups)}`);
});

test('P23②: 真丢失 —— 删掉一个**被记录**的备份 ⇒ 必须判红且点名（这条判据存在的理由）', () => {
  const { projectRoot, landing } = landingWith({
    label: 'p23-deleted',
    backupName: 'x.mjs.20260923-100000.bak',
    withIndexFile: false,                                   // 备份**不存在**
  });
  const r = reconSnapshots({ projectRoot, landingDir: landing });
  assert.equal(r.ok, false, '真的没有同名备份 ⇒ 必须判红');
  assert.equal(r.missingBackups.length, 1, `必须点名'有记录无备份'；missing=${JSON.stringify(r.missingBackups)}`);
  assert.match(String(r.missingBackups[0].backup), /x\.mjs\.20260923-100000\.bak/);
  assert.equal(r.relocatedBackups.length, 0);
});

test('P23③: 共用目录 —— 绑定写通路的 rules.json.*.bak ⇒ 计 nonSnapshot、不计入 ok', () => {
  const { projectRoot, landing, backups } = landingWith({
    label: 'p23-shared-dir',
    backupName: 'x.mjs.20260923-100000.bak',
  });
  // 同目录里放一个"绑定写通路"的备份（快照从不备份管理文件）
  writeFileSync(join(backups, 'rules.json.20260923-100000.bak'), 'rules pre-image\n', 'utf8');
  const r = reconSnapshots({ projectRoot, landingDir: landing });
  assert.equal(r.ok, true, `别的机制的备份不得让快照对账判红；unrecorded=${JSON.stringify(r.unrecordedBackups)}`);
  assert.equal(r.nonSnapshotBackups.length, 1, '必须如实计入 nonSnapshot（看得见，但不判红）');
  assert.match(r.nonSnapshotBackups[0].reason, /快照不备份|管理文件/);
  assert.equal(r.backups, 2, '盘上备份总数要如实（2 个）');
});

test('P23④: 计数可核 —— records/backups/三类分级的数字与盘上事实一致', () => {
  const { projectRoot, landing, backups } = landingWith({
    label: 'p23-counts',
    backupName: 'x.mjs.20260923-100000.bak',
  });
  writeFileSync(join(backups, 'rules.json.20260923-100000.bak'), 'a\n', 'utf8');
  writeFileSync(join(backups, 'y.mjs.20260923-100001.bak'), 'b\n', 'utf8');   // 有备份、索引从未记录 ⇒ 真 unrecorded
  const r = reconSnapshots({ projectRoot, landingDir: landing });
  assert.equal(r.records, 1, '索引 1 行');
  assert.equal(r.backups, 3, '盘上 3 个 .bak');
  assert.equal(r.nonSnapshotBackups.length, 1, 'rules.json 那条属非快照');
  assert.equal(r.unrecordedBackups.length, 1, 'y.mjs 那条是真未记录（值得看一眼）');
  assert.equal(r.ok, false, '有真未记录 ⇒ 判红（这才是该红的那一类）');
});
