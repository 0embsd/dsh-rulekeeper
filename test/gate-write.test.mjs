// dsh-rulekeeper · LF-530 **写入侧对账**（受保护文件「当前内容」== 「最新留证基线」；不依赖 git）
//
// 判据（清单 §5 LF-530）：受保护文件 mtime/sha256 vs `snapshots/index.jsonl`；收尾与开场各跑一次。
// 红态（清单原文）：**直接改文件、不留证、不提交** → 收尾 check **exit≠0 并列出该文件**
//   —— 这是覆盖"未提交直写"的**唯一位置**（git 侧看不见没进暂存区的改动）。
//
// 本文件里的"正对照"设计（防恒真，§0.1 ㉛ 家族）：
//   · 绿态（有快照 + 未改）必须 exit 0；**同一条用例里**把文件改掉就必须 exit≠0（红态由**同一条路径**产出）
//   · mtime 只作辅助：改 mtime 不改内容 → 仍必须 exit 0（证明判定**只看 sha256**，不拿 mtime 判红/判绿）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runGate, runRulekeeper } from '../src/cli.mjs';
import { baselineOf, effectiveProtection, reconWrite } from '../src/gate.mjs';
import { takeSnapshot } from '../src/snap.mjs';
import { RC } from '../src/rc.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

function capture(fn) {
  let out = '';
  let err = '';
  const rc = fn({ out: (t) => { out += String(t); }, err: (t) => { err += String(t); } });
  return { rc, out, err };
}

const gate = (args) => capture((io) => runGate(args, io, {}));

/** 造一个"项目 + 落点"（受保护路径可配；source=config 时用 config.json 覆盖） */
function fixture(label, { protectedPaths = ['AGENTS.md'], configProtected = null, mode = 'observe', rules = true } = {}) {
  const root = tempDir(label);
  const projectRoot = join(root, 'proj');
  const landingDir = join(projectRoot, '.dsh-ai', 'rulekeeper');
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  mkdirSync(landingDir, { recursive: true });
  writeFileSync(join(projectRoot, 'AGENTS.md'), 'v1\n', 'utf8');
  writeFileSync(join(projectRoot, 'src', 'a.txt'), 'a1\n', 'utf8');
  writeFileSync(join(projectRoot, 'src', 'b_test.go'), 'package p\n', 'utf8');
  const cfg = { schema: 1, mode };
  if (configProtected !== null) cfg.protected_paths = configProtected;
  writeFileSync(join(landingDir, 'config.json'), `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  if (rules) {
    writeFileSync(join(landingDir, 'rules.json'), `${JSON.stringify({ schema: 1, project: 't', protected_paths: protectedPaths, gates: [], checks: [], inject: [] }, null, 2)}\n`, 'utf8');
  }
  return { root, projectRoot, landingDir };
}

const snap = (f, file, why = 'LF-530 用例') => takeSnapshot({ projectRoot: f.projectRoot, landingDir: f.landingDir, file: join(f.projectRoot, file), now: new Date('2026-09-14T00:00:00Z'), why });

test('green: 受保护文件已留证且未改 -> exit 0，且"遍历"确实只看保护面', () => {
  const f = fixture('gw-green');
  assert.equal(snap(f, 'AGENTS.md').ok, true);
  const r = reconWrite({ projectRoot: f.projectRoot, landingDir: f.landingDir });
  assert.deepEqual(r.findings, []);
  assert.equal(r.ok, true);
  assert.equal(r.explicit, false);
  assert.ok(r.scanned >= 3, `应扫到 3 个文件，实得 ${r.scanned}`);
  assert.equal(r.checked.length, 1, '只有 AGENTS.md 受保护');
  assert.equal(r.snapshotted.length, 1);
  assert.equal(r.unrecorded.length, 0);
  assert.equal(r.nosnapshot.length, 0);
  assert.equal(r.skipped, 2, 'src/a.txt 与 src/b_test.go 不在保护面内');
  const c = gate(['write', '--project', f.projectRoot, '--phase', 'close']);
  assert.equal(c.rc, RC.OK, c.out);
  assert.match(c.out, /^RK_GATE_WRITE_CHECKED=1$/m);
  assert.match(c.out, /^RK_GATE_WRITE_SNAPSHOTTED=1$/m);
  assert.match(c.out, /^RK_GATE_WRITE_RESULT=pass$/m);
});

test('red（清单原文）: 直接改文件、不留证、不提交 -> exit=1 并列出该文件', () => {
  const f = fixture('gw-red-direct');
  assert.equal(snap(f, 'AGENTS.md').ok, true);
  // 正对照：改之前必须先绿
  assert.equal(reconWrite({ projectRoot: f.projectRoot, landingDir: f.landingDir }).ok, true);
  writeFileSync(join(f.projectRoot, 'AGENTS.md'), 'v2-未留证的直写\n', 'utf8');
  const r = reconWrite({ projectRoot: f.projectRoot, landingDir: f.landingDir });
  assert.equal(r.ok, false);
  assert.equal(r.unrecorded.length, 1);
  assert.equal(r.unrecorded[0].path, 'AGENTS.md');
  assert.equal(r.unrecorded[0].verdict, 'unrecorded');
  assert.ok(r.findings.some((x) => x.code === 'GATE_WRITE_UNRECORDED_CHANGE'));
  const c = gate(['write', '--project', f.projectRoot]);
  assert.equal(c.rc, RC.FAIL, c.out);
  assert.match(c.out, /^RK_GATE_WRITE_UNRECORDED=1$/m);
  assert.match(c.out, /^UNRECORDED AGENTS\.md current=[0-9a-f]{12} baseline=[0-9a-f]{12} record_ts=2026-09-14T00:00:00\.000Z$/m);
  assert.match(c.out, /^FINDING GATE_WRITE_UNRECORDED_CHANGE /m);
  assert.match(c.out, /^RK_GATE_WRITE_RESULT=fail$/m);
});

test('red: 受保护文件从未留证 -> NOSNAPSHOT + exit=1（"没留证"不得静默放过）', () => {
  const f = fixture('gw-red-nosnap', { protectedPaths: ['AGENTS.md', 'src/a.txt'] });
  assert.equal(snap(f, 'AGENTS.md').ok, true);
  const r = reconWrite({ projectRoot: f.projectRoot, landingDir: f.landingDir });
  assert.equal(r.ok, false);
  assert.equal(r.nosnapshot.length, 1);
  assert.equal(r.nosnapshot[0].path, 'src/a.txt');
  assert.ok(r.findings.some((x) => x.code === 'GATE_WRITE_NO_SNAPSHOT'));
  const c = gate(['write', '--project', f.projectRoot]);
  assert.equal(c.rc, RC.FAIL);
  assert.match(c.out, /^NOSNAPSHOT src\/a\.txt current=[0-9a-f]{12} matched=src\/a\.txt$/m);
});

test('green: 合规流程「改前留证 -> 改 -> 改后再留证」-> exit 0', () => {
  const f = fixture('gw-legit-flow');
  assert.equal(snap(f, 'AGENTS.md', '改动前 pre-image').ok, true);
  writeFileSync(join(f.projectRoot, 'AGENTS.md'), 'v2\n', 'utf8');
  // 改后立刻再留一次证（把新内容作为新基线）；此时"未留证的直写"已不存在
  const second = takeSnapshot({ projectRoot: f.projectRoot, landingDir: f.landingDir, file: join(f.projectRoot, 'AGENTS.md'), now: new Date('2026-09-14T01:00:00Z'), why: '改动后确认' });
  assert.equal(second.ok, true);
  const r = reconWrite({ projectRoot: f.projectRoot, landingDir: f.landingDir });
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  assert.equal(r.snapshotted.length, 1);
  assert.equal(r.indexLines, 2);
  // 基线取的是**最新**记录（sha256_after ?? sha256_before），不是第一条
  assert.equal(r.snapshotted[0].baseline, second.sha256);
});

test('green: 没有保护面（rules.json 无 protected_paths）-> 如实打 PRESENT=false，不冒充通过也不乱报', () => {
  const f = fixture('gw-no-protection', { protectedPaths: [] });
  const r = reconWrite({ projectRoot: f.projectRoot, landingDir: f.landingDir });
  assert.deepEqual(r.findings, []);
  assert.equal(r.ok, true);
  assert.equal(r.present, false);
  assert.equal(r.source, '(none)');
  assert.equal(r.checked.length, 0, '没有保护面就不该有候选');
  const c = gate(['write', '--project', f.projectRoot]);
  assert.equal(c.rc, RC.OK);
  assert.match(c.out, /^RK_GATE_WRITE_RULES_PRESENT=false$/m);
  assert.match(c.out, /^RK_GATE_WRITE_SOURCE=\(none\)$/m);
});

test('green: config.json 覆盖 rules.json（保护面走 effectiveConfig 单点，不自己合并）', () => {
  const f = fixture('gw-override', { protectedPaths: ['AGENTS.md'], configProtected: ['src/a.txt'] });
  const r = reconWrite({ projectRoot: f.projectRoot, landingDir: f.landingDir });
  assert.equal(r.source, 'config.json');
  assert.deepEqual(r.patterns, ['src/a.txt']);
  assert.equal(r.checked.length, 1);
  assert.equal(r.checked[0].path, 'src/a.txt');
  assert.equal(r.nosnapshot.length, 1, 'src/a.txt 从未留证');
  assert.equal(effectiveProtection(f.landingDir).source, 'config.json');
});

test('green: 遍历跳过自产物目录（.git / node_modules / .dsh-ai）并**计数上报**', () => {
  const f = fixture('gw-self', { protectedPaths: ['**/*.txt'] });
  mkdirSync(join(f.projectRoot, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(f.projectRoot, 'node_modules', 'pkg', 'x.txt'), 'x\n', 'utf8');
  mkdirSync(join(f.projectRoot, '.git'), { recursive: true });
  writeFileSync(join(f.projectRoot, '.git', 'y.txt'), 'y\n', 'utf8');
  writeFileSync(join(f.landingDir, 'ledger.jsonl'), '{}\n', 'utf8');
  const r = reconWrite({ projectRoot: f.projectRoot, landingDir: f.landingDir });
  const paths = r.checked.map((c) => c.path);
  assert.deepEqual(paths, ['src/a.txt'], '只有项目里的 src/a.txt 该被查');
  assert.ok(r.selfExcluded >= 3, `应排除 .git/node_modules/.dsh-ai 三个目录，实得 ${r.selfExcluded}`);
  assert.equal(r.unrecorded.length, 0);
  assert.equal(r.nosnapshot.length, 1);
  for (const p of paths) assert.equal(p.startsWith('.dsh-ai/'), false);
});

test('green: 判定只看 sha256 —— 只改 mtime（内容不变）仍必须 exit 0，且 mtime 差异被辅助上报', () => {
  const f = fixture('gw-mtime');
  assert.equal(snap(f, 'AGENTS.md').ok, true);
  const abs = join(f.projectRoot, 'AGENTS.md');
  const future = new Date('2027-01-01T00:00:00Z');
  utimesSync(abs, future, future);
  const r = reconWrite({ projectRoot: f.projectRoot, landingDir: f.landingDir });
  assert.equal(r.ok, true, `mtime 变而内容未变不得判红：${JSON.stringify(r.findings)}`);
  assert.equal(r.mtimeAux, 1, 'mtime 比记录新这件事要被上报（但不参与判定）');
  assert.equal(r.snapshotted[0].mtimeNewer, true);
});

test('green: --file 显式范围（scanned=0）；非保护文件被跳过；受保护但盘上没有 -> MISSING_ON_DISK 不算违规', () => {
  const f = fixture('gw-explicit', { protectedPaths: ['AGENTS.md', 'gone.txt'] });
  assert.equal(snap(f, 'AGENTS.md').ok, true);
  const r = reconWrite({ projectRoot: f.projectRoot, landingDir: f.landingDir, files: ['AGENTS.md', 'src/a.txt'] });
  assert.equal(r.explicit, true);
  assert.equal(r.scanned, 0);
  assert.equal(r.checked.length, 1);
  assert.equal(r.skipped, 1, 'src/a.txt 不受保护');
  const r2 = reconWrite({ projectRoot: f.projectRoot, landingDir: f.landingDir, files: ['gone.txt'] });
  assert.equal(r2.missingOnDisk.length, 1);
  assert.equal(r2.missingOnDisk[0].verdict, 'missing-on-disk');
  assert.equal(r2.ok, true, '盘上没有的受保护路径不是"直写"');
  const c = gate(['write', '--project', f.projectRoot, '--file', 'gone.txt']);
  assert.equal(c.rc, RC.OK);
  assert.match(c.out, /^MISSING_ON_DISK gone\.txt matched=gone\.txt$/m);
});

test('red: 快照索引有坏行 -> 对账结论不可信（不得静默当作没问题）', () => {
  const f = fixture('gw-badindex');
  assert.equal(snap(f, 'AGENTS.md').ok, true);
  appendFileSync(join(f.landingDir, 'snapshots', 'index.jsonl'), '{坏行\n', 'utf8');
  const r = reconWrite({ projectRoot: f.projectRoot, landingDir: f.landingDir });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((x) => x.code === 'GATE_WRITE_INDEX_BAD_LINES'));
  assert.equal(gate(['write', '--project', f.projectRoot]).rc, RC.FAIL);
});

test('判据: baselineOf 单点取 `sha256_after ?? sha256_before`（两种都在 / 只有 before / 都没有）', () => {
  assert.equal(baselineOf({ sha256_before: 'a', sha256_after: 'b' }), 'b');
  assert.equal(baselineOf({ sha256_before: 'a', sha256_after: null }), 'a');
  assert.equal(baselineOf({ sha256_before: 'a' }), 'a');
  assert.equal(baselineOf({}), null);
  assert.equal(baselineOf(null), null);
  assert.equal(baselineOf({ sha256_before: '', sha256_after: '' }), null);
});

test('判据: 两入口同源 —— `rk-gate write` 与 `dsh-rulekeeper gate write` 输出逐字相同', () => {
  const f = fixture('gw-two-entries');
  assert.equal(snap(f, 'AGENTS.md').ok, true);
  writeFileSync(join(f.projectRoot, 'AGENTS.md'), 'v2\n', 'utf8');
  const a = gate(['write', '--project', f.projectRoot, '--phase', 'close']);
  const b = capture((io) => runRulekeeper(['gate', 'write', '--project', f.projectRoot, '--phase', 'close'], io, {}));
  assert.equal(a.out, b.out, '两个入口必须逐字同输出');
  assert.equal(a.rc, b.rc);
  assert.equal(a.rc, RC.FAIL);
});

test('--json: 计数与违规明细可机读', () => {
  const f = fixture('gw-json');
  assert.equal(snap(f, 'AGENTS.md').ok, true);
  writeFileSync(join(f.projectRoot, 'AGENTS.md'), 'v2\n', 'utf8');
  const c = gate(['write', '--project', f.projectRoot, '--json']);
  assert.equal(c.rc, RC.FAIL);
  const parsed = JSON.parse(c.out);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.counts.checked, 1);
  assert.equal(parsed.counts.unrecorded, 1);
  assert.equal(parsed.violations.length, 1);
  assert.equal(parsed.violations[0].path, 'AGENTS.md');
  assert.equal(parsed.violations[0].verdict, 'unrecorded');
  assert.match(c.out, /AGENTS\.md/);
  assert.equal(/(^|[^A-Za-z])[A-Za-z]:[\\/]/.test(c.out), false, '判决类输出不得含盘符绝对路径（清单 ㉒）');
});

test('usage: 缺子命令 / 未知子命令 / --phase 非法 / --project 不存在 / 未知 flag -> rc=2', () => {
  assert.equal(gate([]).rc, RC.USAGE);
  assert.equal(gate(['bogus']).rc, RC.USAGE);
  assert.equal(gate(['write', '--phase', 'midway']).rc, RC.USAGE);
  assert.equal(gate(['write', '--project', join(tempDir('gw-missing'), 'nope')]).rc, RC.USAGE);
  assert.equal(gate(['write', '--bogus']).rc, RC.USAGE);
  assert.equal(gate(['--help']).rc, RC.OK);
  assert.equal(gate(['write', '--help']).rc, RC.OK);
});

test('green: **无保护面**时也必须 exit 0 且不误报（用临时夹具，不依赖真实仓的可变配置）', () => {
  // 来历（2026-09-15）：本用例原来指向"包根真实落点"，断言 present=false；
  // 但当天给本仓**配上了保护面**（rules.json，保护 src/schema.mjs + test/fixtures/**）→ 用例立刻变红。
  // 教训：判据的夹具不能绑在"会被合法修改的真实配置"上；无保护面这件事必须在临时仓里造。
  const dir = tempDir('write-no-protection');
  mkdirSync(join(dir, '.dsh-ai', 'rulekeeper'), { recursive: true });
  writeFileSync(join(dir, 'a.txt'), 'x\n', 'utf8');
  const r = reconWrite({ projectRoot: dir, files: ['a.txt'] });
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  assert.equal(r.present, false);
  assert.equal(r.findings.length, 0);
});
