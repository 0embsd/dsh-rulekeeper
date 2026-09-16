// dsh-rulekeeper · LF-810 第二半：**数据可导出 + 可重建**（`rk-backup export|rebuild`）
//
// 判据（清单 LF-810 行）：导出后**删光目录**再用导出件重建 → **条数/字段一致**。
// 红：**无法重建 → 必红**（含导出件被改 1 字节、落点非空被覆盖）。
//
// 判据载体纪律（§9.6 R1）：一致性的载体是**解析后的对象 deep-equal**（账本条目 + 台账行），
// 不是导出件里自报的 counts（那是自证循环），也不是整目录哈希（落点里还可能有并发写者）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runBackup } from '../src/cli.mjs';
import { RC } from '../src/rc.mjs';
import { readLedger } from '../src/ledger.mjs';
import { readGateLedger } from '../src/gate.mjs';
import { cleanupAll, copyPkg, freshLanding, ledgerEntry, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

function capture(fn) {
  let out = '';
  let err = '';
  const rc = fn({ out: (t) => { out += String(t); }, err: (t) => { err += String(t); } });
  return { rc, out, err };
}
const backup = (args) => capture((io) => runBackup(args, io, {}));

const ENTRIES = [
  ledgerEntry({ id: 'e-1', ts: '2026-09-15T00:00:00.000Z', rule: 'R-1', evidence: ['a', 'b'] }),
  ledgerEntry({ id: 'e-2', ts: '2026-09-15T00:01:00.000Z', rule: 'R-2', solution: '复用同一入口' }),
  ledgerEntry({ id: 'e-3', ts: '2026-09-15T00:02:00.000Z', rule: 'R-1' }),
];

/** 造一个"有账本 + 有台账 + 有分片 + 有快照/备份"的落点 */
function fullLanding(label) {
  const { root, landing } = freshLanding(label, { entries: ENTRIES });
  mkdirSync(join(landing, 'logs'), { recursive: true });
  mkdirSync(join(landing, 'snapshots'), { recursive: true });
  mkdirSync(join(landing, 'backups'), { recursive: true });
  writeFileSync(
    join(landing, 'logs', 'gate.jsonl'),
    `${JSON.stringify({ schema: 1, ts: '2026-09-15T00:03:00.000Z', gate: 'precommit', ok: true })}\n`
    + `${JSON.stringify({ schema: 1, ts: '2026-09-15T00:04:00.000Z', gate: 'postcommit', ok: false })}\n`,
    'utf8',
  );
  writeFileSync(join(landing, 'snapshots', 'index.jsonl'), `${JSON.stringify({ schema: 1, path: 'a.txt', sha256: 'x' })}\n`, 'utf8');
  writeFileSync(join(landing, 'backups', 'a.txt.20260915-000000.bak'), 'old content\n', 'utf8');
  return { root, landing };
}
const snapshotOf = (landing) => ({
  ledger: readLedger(landing).values,
  gates: readGateLedger(landing).values,
});

test('green: export 产出单文件，自报条数与实际解析一致', () => {
  const { root, landing } = fullLanding('lf810x-export');
  const out = join(root, 'landing-export.json');
  const r = backup(['export', '--landing', landing, '--out', out]);
  assert.equal(r.rc, RC.OK, r.err);
  assert.equal(existsSync(out), true);
  assert.match(r.out, /RK_EXPORT_LEDGER_ENTRIES=3/);
  assert.match(r.out, /RK_EXPORT_GATE_ROWS=2/);
  assert.match(r.out, /RK_EXPORT_RESULT=pass/);
  const bundle = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(bundle.schema, 1);
  assert.equal(bundle.counts.ledgerEntries, 3);
  assert.equal(bundle.counts.gateRows, 2);
  // 夹具里恰好 6 个文件：config.json / rules.json / ledger.jsonl / logs/gate.jsonl / snapshots/index.jsonl / backups/*.bak
  assert.equal(bundle.files.length, 6, `导出件应含落点全部文件: ${bundle.files.map((f) => f.path).join(',')}`);
  for (const f of bundle.files) assert.match(f.sha256, /^[0-9a-f]{64}$/);
});

test('green: 导出 → **删光落点** → 重建 → 条数一致 + 字段逐条一致', () => {
  const { root, landing } = fullLanding('lf810x-rebuild');
  const out = join(root, 'export.json');
  const before = snapshotOf(landing);
  assert.equal(before.ledger.length, 3);
  assert.equal(before.gates.length, 2);

  assert.equal(backup(['export', '--landing', landing, '--out', out]).rc, RC.OK);
  rmSync(landing, { recursive: true, force: true });
  assert.equal(existsSync(landing), false, '判据要求真的"删光"');

  const r = backup(['rebuild', '--file', out, '--landing', landing]);
  assert.equal(r.rc, RC.OK, r.err);
  assert.match(r.out, /RK_REBUILD_COUNTS_MATCH=true/);
  assert.match(r.out, /RK_REBUILD_RESULT=pass/);
  const after = snapshotOf(landing);
  assert.equal(after.ledger.length, 3, '条数一致');
  assert.deepEqual(after.ledger, before.ledger, '字段逐条一致（deep-equal，禁自报）');
  assert.deepEqual(after.gates, before.gates);
  // 非 jsonl 资产也要回来（快照/备份）
  assert.equal(readFileSync(join(landing, 'backups', 'a.txt.20260915-000000.bak'), 'utf8'), 'old content\n');
});

test('green: 空落点导出 → 0 条也能重建（不把"空"当失败）', () => {
  const { root } = fullLanding('lf810x-empty');
  const landing = join(root, 'empty-landing');
  mkdirSync(landing, { recursive: true });
  writeFileSync(join(landing, 'config.json'), '{"schema":1,"mode":"off"}\n', 'utf8');
  const out = join(root, 'empty.json');
  assert.equal(backup(['export', '--landing', landing, '--out', out]).rc, RC.OK);
  const target = join(root, 'empty-restored');
  const r = backup(['rebuild', '--file', out, '--landing', target]);
  assert.equal(r.rc, RC.OK, r.err);
  assert.match(r.out, /RK_REBUILD_FILES=1/);
  assert.match(r.out, /RK_REBUILD_COUNTS_MATCH=true/);
});

test('红态①（N4）: 导出件被改 1 字节 -> rebuild 必红，且不静默产出半套', () => {
  const { root, landing } = fullLanding('lf810x-tamper');
  const out = join(root, 'export.json');
  assert.equal(backup(['export', '--landing', landing, '--out', out]).rc, RC.OK);
  const bundle = JSON.parse(readFileSync(out, 'utf8'));
  // 改**载荷**（内容），不动自报的 sha256 -> 正是"被篡改"的形态
  const victim = bundle.files.find((f) => f.path === 'ledger.jsonl');
  assert.ok(victim, '导出件里应有 ledger.jsonl');
  const decoded = victim.encoding === 'base64' ? Buffer.from(victim.data, 'base64').toString('utf8') : victim.data;
  const patched = decoded.replace('"R-2"', '"R-9"');
  assert.notEqual(patched, decoded, '夹具必须真的改到内容');
  victim.data = victim.encoding === 'base64' ? Buffer.from(patched, 'utf8').toString('base64') : patched;
  writeFileSync(out, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');

  const target = join(root, 'tampered-target');
  const r = backup(['rebuild', '--file', out, '--landing', target]);
  assert.notEqual(r.rc, RC.OK, `校验不符必须 exit≠0（实测 rc=${r.rc}）`);
  assert.match(r.err, /sha256 不符|VERIFY_FAILED/);
  assert.equal(existsSync(join(target, 'ledger.jsonl')), false, '坏件不得写出数据（禁半套落盘）');
});

test('红态②（N5）: 落点非空时 rebuild 不加 --force -> 拒绝且原文件逐字不变', () => {
  const { root, landing } = fullLanding('lf810x-nonempty');
  const out = join(root, 'export.json');
  assert.equal(backup(['export', '--landing', landing, '--out', out]).rc, RC.OK);
  const ledgerFile = join(landing, 'ledger.jsonl');
  const kept = readFileSync(ledgerFile);
  const r = backup(['rebuild', '--file', out, '--landing', landing]);
  assert.notEqual(r.rc, RC.OK);
  assert.match(r.err, /非空|--force/);
  assert.deepEqual(readFileSync(ledgerFile), kept, '拒绝时不许动原文件');
});

test('红态③: 导出件不存在 / 坏 JSON -> rebuild 必红', () => {
  const { root } = fullLanding('lf810x-badfile');
  const missing = backup(['rebuild', '--file', join(root, 'nope.json'), '--landing', join(root, 't1')]);
  assert.notEqual(missing.rc, RC.OK);
  const badFile = join(root, 'bad.json');
  writeFileSync(badFile, '{ not json\n', 'utf8');
  const bad = backup(['rebuild', '--file', badFile, '--landing', join(root, 't2')]);
  assert.notEqual(bad.rc, RC.OK);
  assert.equal(existsSync(join(root, 't2')), false);
});

test('红态（CR-B1）: 路径穿越（**中段** `..` / 反斜杠变体）必须拒绝且不写到落点外', () => {
  // 独立审查 B1 实测的洞：`pathKey(rel).startsWith('..')` 只挡首段，`a/../../pwned.txt` 会漏过去，
  // 再经 join 归一化写进落点外（Windows 反斜杠变体同样逃逸）。
  const { root, landing } = fullLanding('lf810x-trav');
  const out = join(root, 'export.json');
  assert.equal(backup(['export', '--landing', landing, '--out', out]).rc, RC.OK);
  for (const evil of ['a/../../pwned.txt', 'sub/dir/../../../pwned2.txt', 'a\\..\\..\\pwned3.txt']) {
    const bundle = JSON.parse(readFileSync(out, 'utf8'));
    bundle.files.push({ path: evil, bytes: 4, sha256: createHash('sha256').update('evil').digest('hex'), encoding: 'utf8', data: 'evil' });
    bundle.counts.files = bundle.files.length;
    const file = join(root, `evil-${evil.replace(/[^a-z0-9]/gi, '_')}.json`);
    writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
    const target = join(root, `trav-${evil.replace(/[^a-z0-9]/gi, '_')}`);
    const r = backup(['rebuild', '--file', file, '--landing', target]);
    assert.notEqual(r.rc, RC.OK, `穿越路径必须拒绝（${evil} 实测 rc=${r.rc}）`);
    assert.match(r.err, /BAD_PATH/, r.err);
    for (const escaped of ['pwned.txt', 'pwned2.txt', 'pwned3.txt']) {
      assert.equal(existsSync(join(root, escaped)), false, `落点外文件不得被写出: ${escaped}`);
    }
    assert.equal(existsSync(join(target, 'ledger.jsonl')), false, '拒绝时一个字节都不许写（B1 的"半套"）');
  }
});

test('green: 合法名 `..foo` 不能被误拒（守卫两面都要对）', () => {
  const { root, landing } = fullLanding('lf810x-dotfoo');
  const out = join(root, 'export.json');
  assert.equal(backup(['export', '--landing', landing, '--out', out]).rc, RC.OK);
  const bundle = JSON.parse(readFileSync(out, 'utf8'));
  bundle.files.push({ path: '..foo', bytes: 2, sha256: createHash('sha256').update('a\n').digest('hex'), encoding: 'utf8', data: 'a\n' });
  bundle.counts.files = bundle.files.length;
  writeFileSync(out, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  const target = join(root, 'dotfoo-target');
  const r = backup(['rebuild', '--file', out, '--landing', target]);
  assert.equal(r.rc, RC.OK, r.err);
  assert.equal(readFileSync(join(target, '..foo'), 'utf8'), 'a\n');
});

test('红态（CR-M1）: 坏件失败后**零残渣**，且好件可直接重试（不需要 --force）', () => {
  const { root, landing } = fullLanding('lf810x-residue');
  const out = join(root, 'export.json');
  assert.equal(backup(['export', '--landing', landing, '--out', out]).rc, RC.OK);
  const tampered = join(root, 't.json');
  const bundle = JSON.parse(readFileSync(out, 'utf8'));
  const victim = bundle.files.find((f) => f.path === 'ledger.jsonl');
  const text = victim.encoding === 'base64' ? Buffer.from(victim.data, 'base64').toString('utf8') : victim.data;
  victim.data = victim.encoding === 'base64' ? Buffer.from(text.replace('"R-2"', '"R-9"'), 'utf8').toString('base64') : text.replace('"R-2"', '"R-9"');
  writeFileSync(tampered, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');

  const target = join(root, 'residue-target');
  const bad = backup(['rebuild', '--file', tampered, '--landing', target]);
  assert.notEqual(bad.rc, RC.OK);
  const left = existsSync(target) ? readdirSync(target) : [];
  assert.deepEqual(left, [], `坏件失败后落点必须零残渣，实测 ${left.join(',')}`);

  const good = backup(['rebuild', '--file', out, '--landing', target]);
  assert.equal(good.rc, RC.OK, `好件重试不得被自己的残渣挡住: ${good.err}`);
  assert.equal(readFileSync(join(target, 'ledger.jsonl'), 'utf8'), readFileSync(join(landing, 'ledger.jsonl'), 'utf8'));
});

test('红态（CR-M2）: 落点只有 snapshots/backups（真实数据）时，rebuild 必须拒绝覆盖', () => {
  const { root } = fullLanding('lf810x-nonempty2');
  const landing = join(root, 'data-only');
  mkdirSync(join(landing, 'snapshots'), { recursive: true });
  mkdirSync(join(landing, 'backups'), { recursive: true });
  writeFileSync(join(landing, 'snapshots', 'index.jsonl'), '{"schema":1,"path":"a.txt"}\n', 'utf8');
  writeFileSync(join(landing, 'backups', 'a.txt.bak'), 'OLD-PRECIOUS\n', 'utf8');

  const src = fullLanding('lf810x-nonempty2-src');
  const out = join(root, 'export.json');
  assert.equal(backup(['export', '--landing', src.landing, '--out', out]).rc, RC.OK);
  const r = backup(['rebuild', '--file', out, '--landing', landing]);
  assert.notEqual(r.rc, RC.OK, '只有 snapshots/backups 也算"已有数据"，必须拒绝（旧实现只看 4 个固定文件名）');
  assert.match(r.err, /非空|--force|拒绝/);
  assert.equal(readFileSync(join(landing, 'backups', 'a.txt.bak'), 'utf8'), 'OLD-PRECIOUS\n', '原数据一个字节都不许动');
});

test('红态（CR-m2）: 导出件自报 files 与条目数不符 -> 必红（自报值必须交叉核对）', () => {
  const { root, landing } = fullLanding('lf810x-selffiles');
  const out = join(root, 'export.json');
  assert.equal(backup(['export', '--landing', landing, '--out', out]).rc, RC.OK);
  const bundle = JSON.parse(readFileSync(out, 'utf8'));
  bundle.counts.files = bundle.files.length + 3;
  writeFileSync(out, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  const r = backup(['rebuild', '--file', out, '--landing', join(root, 'selffiles-target')]);
  assert.notEqual(r.rc, RC.OK);
  assert.match(r.err, /files=/, r.err);
});

test('变异（N4）: 去掉 rebuild 的 sha256 校验 -> 同一个被改过的导出件会被**静默接受**（证明该检查才是红的原因）', () => {
  const { root, landing } = fullLanding('lf810x-mutate');
  const out = join(root, 'export.json');
  assert.equal(backup(['export', '--landing', landing, '--out', out]).rc, RC.OK);
  const bundle = JSON.parse(readFileSync(out, 'utf8'));
  const victim = bundle.files.find((f) => f.path === 'ledger.jsonl');
  const decoded = victim.encoding === 'base64' ? Buffer.from(victim.data, 'base64').toString('utf8') : victim.data;
  const patched = decoded.replace('"R-2"', '"R-9"');
  assert.notEqual(patched, decoded);
  victim.data = victim.encoding === 'base64' ? Buffer.from(patched, 'utf8').toString('base64') : patched;
  writeFileSync(out, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');

  const mutant = copyPkg('lf810x-mutant');
  const file = join(mutant, 'src', 'portable.mjs');
  const src = readFileSync(file, 'utf8');
  const anchor = "    if (typeof entry.sha256 !== 'string' || actual !== entry.sha256) {";
  assert.equal(src.split(anchor).length - 1, 1, '变异锚点必须**恰**命中 1 次（不猜、不静默）');
  writeFileSync(file, src.replace(anchor, '    if (false) {'), 'utf8');

  const run = spawnSync(process.execPath, [join(mutant, 'bin', 'rk-backup.mjs'), 'rebuild', '--file', out, '--landing', join(root, 'mutant-target')], { encoding: 'utf8' });
  assert.equal(run.status, 0, `去掉校验后坏件会被接受（这正是真包判红的原因）: status=${run.status} ${run.stderr}`);
});

test('rc=2（N6）: --out 落在落点内部 -> 拒绝（防自我包含）', () => {
  const { landing } = fullLanding('lf810x-selfinclude');
  const r = backup(['export', '--landing', landing, '--out', join(landing, 'export.json')]);
  assert.equal(r.rc, RC.USAGE, r.err);
  assert.match(r.err, /落点内部/);
  assert.equal(existsSync(join(landing, 'export.json')), false);
});

test('rc=2: 缺 --out / --file / --landing 的用法错误', () => {
  const { landing } = fullLanding('lf810x-usage');
  assert.equal(backup(['export', '--landing', landing]).rc, RC.USAGE);
  assert.equal(backup(['export', '--out', join(tempDir('lf810x-u'), 'x.json')]).rc, RC.USAGE);
  assert.equal(backup(['rebuild', '--landing', landing]).rc, RC.USAGE);
  assert.equal(backup(['exportt']).rc, RC.USAGE);
});

test('green: 已知字段集契约 —— 重建件里账本行字段集合与原件一致（防"少字段也能过"）', () => {
  const { root, landing } = fullLanding('lf810x-fields');
  const out = join(root, 'export.json');
  assert.equal(backup(['export', '--landing', landing, '--out', out]).rc, RC.OK);
  const keys = readLedger(landing).values.map((e) => Object.keys(e).sort().join(','));
  const target = join(root, 'restored');
  assert.equal(backup(['rebuild', '--file', out, '--landing', target]).rc, RC.OK);
  const keysAfter = readLedger(target).values.map((e) => Object.keys(e).sort().join(','));
  assert.deepEqual(keysAfter, keys, '字段集合必须逐条一致（不是"条数对了就算过"）');
});
