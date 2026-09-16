// dsh-rulekeeper · LF-180 用例：崩溃恢复 + doctor 自检
//
// 判据（清单 LF-180）：造尾部半行 → 读取不失败、坏行计数 +1
// 红态：尾部半行导致整文件失败 → exit≠0（本文件用「doctor 不抛 + 只报 warn」证明，凭证里再跑 CLI 层）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runDoctor } from '../src/cli.mjs';
import { doctor, doctorExitCode, looksLikePath } from '../src/doctor.mjs';
import { RC } from '../src/rc.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

function landingFixture(label) {
  const landing = join(tempDir(label), 'landing');
  mkdirSync(join(landing, 'snapshots'), { recursive: true });
  return landing;
}

function ledgerEntry(id, ts = '2026-09-14T00:00:00.000Z', extra = {}) {
  return {
    schema: 1, id, ts, rule: 'L900', category: '技术', problem: 'p', root_cause: 'r',
    solution: 's', evidence: [], mechanism: 'text', recurrence: 1,
    first_seen: ts, last_seen: ts, status: 'active', ...extra,
  };
}

function writeJsonl(file, rows) {
  const body = rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n');
  writeFileSync(file, rows.length === 0 ? '' : `${body}\n`, 'utf8');
}

function codes(report) {
  return report.findings.map((f) => f.code);
}

test('green: 干净落点 -> 无 error（LF-180 绿态）', () => {
  const landing = landingFixture('d-clean');
  writeJsonl(join(landing, 'ledger.jsonl'), [ledgerEntry('L001'), ledgerEntry('L002', '2026-09-14T00:00:01.000Z')]);
  const report = doctor({ landingDir: landing });
  assert.deepEqual(report.findings.filter((f) => f.level === 'error'), []);
  assert.equal(report.ok, true);
  assert.equal(report.summary.entries, 2);
});

test('green: 空落点（文件都未创建）-> 仅 info，不判 error', () => {
  const landing = landingFixture('d-empty');
  const report = doctor({ landingDir: landing });
  assert.equal(report.ok, true);
  assert.ok(codes(report).includes('DOCTOR_FILE_MISSING'));
  assert.deepEqual(report.findings.filter((f) => f.level === 'error'), []);
});

test('red: 尾部半行 -> 报 DOCTOR_TRUNCATED_TAIL(warn) 且 doctor 不抛（读取不失败）', () => {
  const landing = landingFixture('d-half');
  writeJsonl(join(landing, 'ledger.jsonl'), [ledgerEntry('L001')]);
  appendFileSync(join(landing, 'ledger.jsonl'), '{"schema":1,"id":"L002","ts":"2026-09-14T00:00:01.000Z"', 'utf8');
  let threw = false;
  let report = null;
  try {
    report = doctor({ landingDir: landing });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, '尾部半行不得让 doctor 抛异常');
  assert.ok(codes(report).includes('DOCTOR_TRUNCATED_TAIL'));
  assert.equal(report.summary.truncatedTails, 1);
  assert.equal(report.summary.entries, 1, '半行不计入有效条目');
  assert.equal(report.ok, true, '半行属 warn（可截断修复），默认不判失败');
  assert.equal(doctorExitCode(report, true), 1, '--strict 时应判失败');
});

test('red: 中间撕裂行 -> DOCTOR_BAD_LINES(error) 且 exitCode=1', () => {
  const landing = landingFixture('d-bad');
  writeJsonl(join(landing, 'ledger.jsonl'), [JSON.stringify(ledgerEntry('L001')), '{"broken":', JSON.stringify(ledgerEntry('L003'))]);
  const report = doctor({ landingDir: landing });
  assert.ok(codes(report).includes('DOCTOR_BAD_LINES'));
  assert.equal(report.ok, false);
  assert.equal(doctorExitCode(report), 1);
});

test('red: 重复 id -> DOCTOR_DUP_ID', () => {
  const landing = landingFixture('d-dup');
  writeJsonl(join(landing, 'ledger.jsonl'), [ledgerEntry('L001'), ledgerEntry('L001', '2026-09-14T00:00:01.000Z')]);
  const report = doctor({ landingDir: landing });
  assert.ok(codes(report).includes('DOCTOR_DUP_ID'));
  assert.equal(report.ok, false);
});

test('red: evidence 路径不存在 -> DOCTOR_EVIDENCE_MISSING(warn)', () => {
  const landing = landingFixture('d-evidence');
  writeJsonl(join(landing, 'ledger.jsonl'), [ledgerEntry('L001', '2026-09-14T00:00:00.000Z', { evidence: ['definitely/not/here.txt'] })]);
  const report = doctor({ landingDir: landing });
  const finding = report.findings.find((f) => f.code === 'DOCTOR_EVIDENCE_MISSING');
  assert.ok(finding);
  assert.equal(finding.level, 'warn');
});

test('red: ts 非单调 -> DOCTOR_TS_NOT_MONOTONIC(warn)', () => {
  const landing = landingFixture('d-ts');
  writeJsonl(join(landing, 'ledger.jsonl'), [
    ledgerEntry('L001', '2026-09-14T00:00:05.000Z'),
    ledgerEntry('L002', '2026-09-14T00:00:01.000Z'),
  ]);
  const report = doctor({ landingDir: landing });
  assert.ok(codes(report).includes('DOCTOR_TS_NOT_MONOTONIC'));
});

test('red: 有记录无备份 -> DOCTOR_BACKUP_ORPHAN(error)', () => {
  const landing = landingFixture('d-orphan');
  writeJsonl(join(landing, 'snapshots', 'index.jsonl'), [{
    schema: 1, ts: '2026-09-14T00:00:00.000Z', path: 'a.txt',
    sha256_before: 'x'.repeat(64), backup: 'backups/ghost.bak', why: 'test',
  }]);
  const report = doctor({ landingDir: landing });
  assert.ok(codes(report).includes('DOCTOR_BACKUP_ORPHAN'));
  assert.equal(report.ok, false);
});

test('green: 有备份无记录 -> 仅 info（不判 error）', () => {
  const landing = landingFixture('d-unref');
  mkdirSync(join(landing, 'backups'), { recursive: true });
  writeFileSync(join(landing, 'backups', 'lessons.json.20260914-000000.bak'), '{}\n', 'utf8');
  const report = doctor({ landingDir: landing });
  const finding = report.findings.find((f) => f.code === 'DOCTOR_BACKUP_UNREFERENCED');
  assert.ok(finding);
  assert.equal(finding.level, 'info');
  assert.equal(report.ok, true);
});

test('red: 超龄锁 -> DOCTOR_LOCK_STALE(warn)', () => {
  const landing = landingFixture('d-lock');
  const lockPath = join(landing, 'ledger.lock');
  writeFileSync(lockPath, '{"pid":999999}', 'utf8');
  const old = new Date(Date.now() - 10_000);
  utimesSync(lockPath, old, old);
  const report = doctor({ landingDir: landing, lockStaleMs: 1_000 });
  const finding = report.findings.find((f) => f.code === 'DOCTOR_LOCK_STALE');
  assert.ok(finding, '孤儿/超龄锁必须被报出（LF-170 凭证 §5 的承诺）');
  assert.equal(finding.level, 'warn');
});

test('red: 自由文本 evidence 不做存在性检查（只计数，避免类别错误）', () => {
  const landing = landingFixture('d-nonpath');
  writeJsonl(join(landing, 'ledger.jsonl'), [ledgerEntry('L001', '2026-09-14T00:00:00.000Z', {
    evidence: ['AGENTS.md Q5 已机制化', 'definitely/missing/path.md'],
  })]);
  const report = doctor({ landingDir: landing });
  const missing = report.findings.filter((f) => f.code === 'DOCTOR_EVIDENCE_MISSING');
  assert.equal(missing.length, 1, '只有形如路径的那一项才该被查存在性');
  assert.match(missing[0].msg, /definitely\/missing\/path\.md/);
  assert.equal(report.summary.nonPathEvidence, 1);
  assert.ok(codes(report).includes('DOCTOR_NON_PATH_EVIDENCE'));
});

test('looksLikePath：精度优先（假警告比漏检更贵）', () => {
  for (const yes of ['a/b.md', 'a\\b.txt', 'x.jsonl', 'https://e.com/x', 'AGENTS.md', '.dsh-ai/verify/x-20260913.txt', 'file.md:74-112']) {
    assert.equal(looksLikePath(yes), true, `${yes} 应判为路径类`);
  }
  for (const no of [
    'AGENTS.md Q5 已机制化', 'Q5', '', '实证输出', null, 'Q1/Q4',
    'HK 空机真机：INSTALL_EXIT=0 / 容器 ActiveState=active', 'a/b', 'x = y.md',
    'docs/90-全局/会话里程碑-P1 地基（x）.md',
  ]) {
    assert.equal(looksLikePath(no), false, `${JSON.stringify(no)} 应判为非路径（避免假警告）`);
  }
});

test('cli: 干净落点 rc=0；坏落点 rc=1；目录不存在 rc=2', () => {
  const clean = landingFixture('d-cli-clean');
  writeJsonl(join(clean, 'ledger.jsonl'), [ledgerEntry('L001')]);
  const broken = landingFixture('d-cli-broken');
  writeJsonl(join(broken, 'ledger.jsonl'), ['{broken', JSON.stringify(ledgerEntry('L002'))]);

  const capture = (fn) => {
    let out = '';
    let err = '';
    const rc = fn({ out: (t) => { out += String(t); }, err: (t) => { err += String(t); } });
    return { rc, out, err };
  };

  const okRun = capture((io) => runDoctor(['--landing', clean, '--project', clean], io, {}));
  assert.equal(okRun.rc, RC.OK);
  assert.match(okRun.out, /RK_DOCTOR_RESULT=pass/);

  const badRun = capture((io) => runDoctor(['--landing', broken], io, {}));
  assert.equal(badRun.rc, RC.FAIL);
  assert.match(badRun.out, /FINDING ERROR DOCTOR_BAD_LINES/);
  assert.match(badRun.out, /RK_DOCTOR_RESULT=fail/);

  const missingRun = capture((io) => runDoctor(['--landing', join(tempDir('d-cli-missing'), 'nope')], io, {}));
  assert.equal(missingRun.rc, RC.USAGE);
  assert.match(missingRun.err, /不是已存在目录/);
});
