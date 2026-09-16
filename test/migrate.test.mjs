// dsh-rulekeeper · **R2 落点迁移**：`rk-migrate`（复制 + 五项核对 + 默认保留旧落点 + fail-closed）
//
// 为什么这几条是硬判据：
//   · 落点里是**用户数据**（账本/门禁台账/快照/备份）⇒ 迁移必须**可核对**，核对不过**一个字节都不删**；
//   · 默认 dry-run（不替用户动数据）；`--remove-old` 必须与 `--apply` 同用（禁"只删不迁"）；
//   · 目标已存在且非空 ⇒ 拒绝覆盖（否则可能把两份数据合成一份看不懂的）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runRulekeeper, runMigrate } from '../src/cli.mjs';
import { landingFingerprint, migrateLanding } from '../src/migrate.mjs';
import { RC } from '../src/rc.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

function capture(fn) {
  let out = '';
  let err = '';
  const rc = fn({ out: (t) => { out += String(t); }, err: (t) => { err += String(t); } });
  return { rc, out, err };
}
const cli = (argv) => capture((io) => runMigrate(argv, io, {}));

/** 预置一个"有数据的老落点"项目：账本 3 行 + 门禁台账 2 行 + 一个快照索引 */
function legacyProject(label) {
  const root = tempDir(label);
  const legacy = join(root, '.dsh-ai', 'lessonflow');
  mkdirSync(join(legacy, 'logs'), { recursive: true });
  mkdirSync(join(legacy, 'snapshots'), { recursive: true });
  writeFileSync(join(legacy, 'config.json'), '{\n  "schema": 1,\n  "mode": "observe"\n}\n', 'utf8');
  writeFileSync(join(legacy, 'ledger.jsonl'), '{"id":"L1"}\n{"id":"L2"}\n{"id":"L3"}\n', 'utf8');
  writeFileSync(join(legacy, 'logs', 'gate.jsonl'), '{"gate":"pre-commit"}\n{"gate":"post-commit"}\n', 'utf8');
  writeFileSync(join(legacy, 'snapshots', 'index.jsonl'), '{"path":"a.txt"}\n', 'utf8');
  return { root, legacy, next: join(root, '.dsh-ai', 'rulekeeper') };
}

test('dry-run（默认）：只报告、不动盘 —— 不建新落点、源落点零变化', () => {
  const p = legacyProject('mig-dry');
  const before = landingFingerprint(p.legacy);
  const r = migrateLanding({ projectRoot: p.root });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'dry-run');
  assert.equal(r.plan.needed, true);
  assert.equal(r.verified, false, 'dry-run 不算"已验证"');
  assert.equal(existsSync(p.next), false, 'dry-run 不得创建目标');
  assert.deepEqual(landingFingerprint(p.legacy), before, 'dry-run 不得改源');
  const c = cli(['--project', p.root]);
  assert.equal(c.rc, RC.OK, c.out);
  assert.match(c.out, /^RK_MIGRATE_MODE=dry-run$/m);
  assert.match(c.out, /^RK_MIGRATE_FROM=\.dsh-ai\/lessonflow$/m);
  assert.match(c.out, /^RK_MIGRATE_TO=\.dsh-ai\/rulekeeper$/m);
  assert.match(c.out, /^RK_MIGRATE_NEEDED=true$/m);
  assert.match(c.out, /^RK_MIGRATE_FILES=4$/m);
  assert.match(c.out, /^RK_MIGRATE_LEDGER_LINES=3$/m);
  assert.match(c.out, /^RK_MIGRATE_GATE_LINES=2$/m);
  assert.equal(/[A-Za-z]:[\\/]/.test(c.out), false, '判决输出不得含盘符绝对路径');
});

test('--apply：树逐字一致（文件数/字节/树 sha256/账本行/台账行）且**默认保留**旧落点', () => {
  const p = legacyProject('mig-apply');
  const before = landingFingerprint(p.legacy);
  const r = migrateLanding({ projectRoot: p.root, apply: true });
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.verified, true);
  assert.equal(r.removedOld, false);
  const after = landingFingerprint(p.next);
  assert.equal(after.files, before.files + 1, '目标 = 源 4 文件 + 迁移记录 1 条');
  assert.equal(after.bytes > before.bytes, true);
  assert.equal(r.after.fp, before.fp, '树指纹（写迁移记录**之前**）必须逐字一致');
  assert.equal(r.after.files, before.files);
  assert.equal(after.ledgerLines, 3);
  assert.equal(after.gateLines, 2);
  assert.deepEqual(landingFingerprint(p.legacy), before, '默认保留旧落点且旧落点零改动');
  assert.equal(existsSync(join(p.next, 'logs', 'migrate.jsonl')), true, '必须留迁移记录');
  const rec = JSON.parse(readFileSync(join(p.next, 'logs', 'migrate.jsonl'), 'utf8').trim().split('\n').pop());
  assert.equal(rec.removed_old, false);
  assert.equal(rec.files, before.files);
  assert.equal(rec.tree_sha256, before.fp);
});

test('--remove-old（须与 --apply 同用）：核对通过才删旧；单独用是用法错误', () => {
  const p = legacyProject('mig-remove');
  const onlyRemove = cli(['--project', p.root, '--remove-old']);
  assert.equal(onlyRemove.rc, RC.USAGE, onlyRemove.err);
  assert.match(onlyRemove.err, /必须与 --apply 同时使用/);
  assert.equal(existsSync(p.legacy), true, '被拒时不得动源');

  const r = migrateLanding({ projectRoot: p.root, apply: true, removeOld: true });
  assert.equal(r.ok, true);
  assert.equal(r.removedOld, true);
  assert.equal(existsSync(p.legacy), false, '核对通过后才删旧');
  assert.equal(existsSync(join(p.next, 'ledger.jsonl')), true);
});

test('red：目标落点已存在且非空 -> 拒绝覆盖（fail-closed），源落点零改动', () => {
  const p = legacyProject('mig-conflict');
  // 两处并存时"默认解析"会优先新落点（= 无需迁移），所以这里用 **显式 --landing** 把源钉在老落点上
  mkdirSync(p.next, { recursive: true });
  writeFileSync(join(p.next, 'config.json'), '{"schema":1,"mode":"armed"}\n', 'utf8');
  const before = landingFingerprint(p.legacy);
  const c = cli(['--project', p.root, '--landing', p.legacy, '--apply']);
  assert.equal(c.rc, RC.FAIL, c.out);
  assert.equal(c.out.includes('拒绝覆盖'), true);
  assert.equal(readFileSync(join(p.next, 'config.json'), 'utf8'), '{"schema":1,"mode":"armed"}\n', '不得覆盖既有目标');
  assert.deepEqual(landingFingerprint(p.legacy), before);
});

test('无需迁移（已在目标落点）：exit=0 且 NEEDED=false（不冒充"迁移过"）', () => {
  const root = tempDir('mig-none');
  mkdirSync(join(root, '.dsh-ai', 'rulekeeper'), { recursive: true });
  writeFileSync(join(root, '.dsh-ai', 'rulekeeper', 'config.json'), '{}\n', 'utf8');
  const c = cli(['--project', root, '--apply']);
  assert.equal(c.rc, RC.OK, c.out);
  assert.match(c.out, /^RK_MIGRATE_NEEDED=false$/m);
  assert.match(c.out, /无需迁移/);
});

test('两个入口同源：`rk-migrate` 与 `dsh-rulekeeper migrate` 输出逐字相同', () => {
  const p = legacyProject('mig-same');
  const a = cli(['--project', p.root, '--now', '2026-09-16T00:00:00Z']);
  const b = capture((io) => runRulekeeper(['migrate', '--project', p.root, '--now', '2026-09-16T00:00:00Z'], io, {}));
  assert.equal(a.rc, b.rc);
  assert.equal(a.out, b.out);
});

test('usage：--scope 非法 / --project 不存在 / --now 非法 -> rc=2', () => {
  const root = tempDir('mig-usage');
  assert.equal(cli(['--project', root, '--scope', 'galaxy']).rc, RC.USAGE);
  assert.equal(cli(['--project', join(root, 'nope')]).rc, RC.USAGE);
  assert.equal(cli(['--project', root, '--now', 'not-a-time']).rc, RC.USAGE);
});
