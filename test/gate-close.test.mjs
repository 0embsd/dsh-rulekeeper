// dsh-rulekeeper · LF-550 **收尾闸**（close 必答"本批碰到哪几条纪律、靠什么拦住"）
//
// 判据（清单 §5 LF-550）：**答全 → exit=0**；**缺答 → exit≠0**。
// 设计单 L106 的硬要求：把"不可机检"当免责的**必须附实证**（三件套 + falsifier + 有效期），否则收尾不通过。
//
// 三道机检都在用例里钉住（每道都有"能糊过去"的反例）：
//   ① **沉默不算答**（既无 --hit 也无 --none -> 红）
//   ② 纪律必须**在账本里真实存在**（canonical 口径）——编个名字 -> 红
//   ③ "拦住它的机制"必须是**已知门**；`uncheckable` 必须配**合格的实证 JSON** —— 写个漂亮词 -> 红

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runGate, runRulekeeper } from '../src/cli.mjs';
import { CLOSE_KNOWN_GATES, closeGate, gateLedgerPath, parseHit, readGateLedger } from '../src/gate.mjs';
import { record } from '../src/ledger.mjs';
import { RC } from '../src/rc.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const PKG = join(import.meta.dirname, '..');
const OK_DECL = join(PKG, 'test', 'fixtures', 'checks', 'uncheckable-ok.json');
const SENTENCE_ONLY_DECL = join(PKG, 'test', 'fixtures', 'checks', 'uncheckable-sentence-only.json');
const NOW = '2026-09-14T12:00:00Z';   // 落在 uncheckable-ok.json 的有效窗口（2026-09-01 ~ 2026-09-20）内

function capture(fn) {
  let out = '';
  let err = '';
  const rc = fn({ out: (t) => { out += String(t); }, err: (t) => { err += String(t); } });
  return { rc, out, err };
}
const gate = (args) => capture((io) => runGate(args, io, {}));

/** 落点 + 若干条真账本记录（收尾闸要求纪律"在账本里真实存在"） */
function landing(label, rules = ['PS-OUTPUT-STREAM']) {
  const dir = tempDir(label);
  const landingDir = join(dir, '.dsh-ai', 'rulekeeper');
  mkdirSync(landingDir, { recursive: true });
  for (const rule of rules) {
    const r = record(
      { rule, category: '纪律', problem: `p-${rule}`, root_cause: 'r', solution: 's', mechanism: 'm', evidence: [] },
      { landingDir, now: new Date('2026-09-14T00:00:00Z') },
    );
    assert.equal(r.ok, true, JSON.stringify(r.reason ?? r));
  }
  return { dir, projectRoot: dir, landingDir };
}
const close = (l, args) => gate(['close', '--project', l.projectRoot, '--landing', l.landingDir, ...args]);
const rows = (l) => readGateLedger(l.landingDir).values.filter((r) => r.gate === 'close');

test('green: 答全（纪律在账本里 + 已知门）-> exit=0，且台账记 pass + 逐字 hits', () => {
  const l = landing('cl-green');
  const r = closeGate({ projectRoot: l.projectRoot, landingDir: l.landingDir, hits: [{ rule: 'PS-OUTPUT-STREAM', stoppedBy: 'pre-commit' }], batch: 'B-1', now: new Date(NOW) });
  assert.deepEqual(r.findings, []);
  assert.equal(r.ok, true);
  assert.equal(r.answered, true);
  assert.equal(r.knownRules, 1);
  assert.equal(r.ledger.ok, true);
  const c = close(l, ['--hit', 'PS-OUTPUT-STREAM=pre-commit', '--batch', 'B-1', '--now', NOW]);
  assert.equal(c.rc, RC.OK, c.out);
  assert.match(c.out, /^RK_GATE_CLOSE_BATCH=B-1$/m);
  assert.match(c.out, /^RK_GATE_CLOSE_ANSWERED=true$/m);
  assert.match(c.out, /^RK_GATE_CLOSE_HITS=1$/m);
  assert.match(c.out, /^RK_GATE_CLOSE_KNOWN_RULES=1$/m);
  assert.match(c.out, /^HIT PS-OUTPUT-STREAM stoppedBy=pre-commit$/m);
  assert.match(c.out, /^RK_GATE_CLOSE_RESULT=pass$/m);
  const list = rows(l);
  assert.equal(list.length, 2, '纯函数一次 + CLI 一次 = 2 行（append-only）');
  assert.equal(list[0].verdict, 'pass');
  assert.deepEqual(list[0].hits, [{ rule: 'PS-OUTPUT-STREAM', stoppedBy: 'pre-commit' }]);
  assert.equal(list[0].batch, 'B-1');
  assert.equal(list[0].answered, true);
});

test('green: 显式 --none（本批没碰到纪律）-> exit=0，台账记 none:true / hits:[]', () => {
  const l = landing('cl-none');
  const c = close(l, ['--none', '--batch', 'B-2', '--now', NOW]);
  assert.equal(c.rc, RC.OK, c.out);
  assert.match(c.out, /^RK_GATE_CLOSE_ANSWERED=true$/m);
  assert.match(c.out, /^RK_GATE_CLOSE_NONE=true$/m);
  assert.match(c.out, /^RK_GATE_CLOSE_HITS=0$/m);
  const row = rows(l)[0];
  assert.equal(row.none, true);
  assert.equal(row.answered, true);
  assert.deepEqual(row.hits, []);
  assert.equal(row.verdict, 'pass');
});

test('red: **沉默不算答**（既无 --hit 也无 --none）-> CLOSE_MISSING_ANSWER + exit=1', () => {
  const l = landing('cl-silent');
  const c = close(l, ['--batch', 'B-3']);
  assert.equal(c.rc, RC.FAIL, c.out);
  assert.match(c.out, /^RK_GATE_CLOSE_ANSWERED=false$/m);
  assert.match(c.out, /^FINDING CLOSE_MISSING_ANSWER /m);
  assert.match(c.out, /^RK_GATE_CLOSE_RESULT=fail$/m);
  const row = rows(l)[0];
  assert.equal(row.verdict, 'rejected');
  assert.equal(row.answered, false);
  assert.deepEqual(row.findings, ['CLOSE_MISSING_ANSWER']);
});

test('red: --hit 与 --none 同时给 -> 答不成对 -> exit=1', () => {
  const l = landing('cl-conflict');
  const c = close(l, ['--hit', 'PS-OUTPUT-STREAM=pre-commit', '--none']);
  assert.equal(c.rc, RC.FAIL);
  assert.match(c.out, /^FINDING CLOSE_CONFLICTING_ANSWER /m);
});

test('red: 纪律**不在账本里** -> CLOSE_UNKNOWN_RULE + exit=1（编个名字不算答）', () => {
  const l = landing('cl-unknown-rule');
  const c = close(l, ['--hit', '我编的纪律=pre-commit']);
  assert.equal(c.rc, RC.FAIL, c.out);
  assert.match(c.out, /^FINDING CLOSE_UNKNOWN_RULE 纪律在账本里不存在（canonical=我编的纪律）: 我编的纪律；账本已知 1 条纪律/m);
  const row = rows(l)[0];
  assert.deepEqual(row.findings, ['CLOSE_UNKNOWN_RULE']);
});

test('green: 纪律按 **canonical 口径**比对（大小写/分隔符不同也算同一条）', () => {
  const l = landing('cl-canonical', ['PS-OUTPUT-STREAM']);
  const r = closeGate({ projectRoot: l.projectRoot, landingDir: l.landingDir, hits: [{ rule: 'ps output stream', stoppedBy: 'ci' }] });
  assert.deepEqual(r.findings, []);
  assert.equal(r.ok, true);
  const c = close(l, ['--hit', 'ps_output_stream=ci']);
  assert.equal(c.rc, RC.OK, c.out);
});

test('red: "拦住它的机制"不是已知门 -> CLOSE_UNKNOWN_GATE + exit=1（写个漂亮词糊不过去）', () => {
  const l = landing('cl-unknown-gate');
  const c = close(l, ['--hit', 'PS-OUTPUT-STREAM=魔法门']);
  assert.equal(c.rc, RC.FAIL, c.out);
  assert.match(c.out, /^FINDING CLOSE_UNKNOWN_GATE 未知的"拦住它的机制": 魔法门/m);
  assert.equal(CLOSE_KNOWN_GATES.includes('魔法门'), false);
});

test('red: 把"不可机检"当免责（stoppedBy=uncheckable）但没附实证 -> exit=1', () => {
  const l = landing('cl-uncheck-no-decl');
  const c = close(l, ['--hit', 'PS-OUTPUT-STREAM=uncheckable']);
  assert.equal(c.rc, RC.FAIL, c.out);
  assert.match(c.out, /^RK_GATE_CLOSE_UNCHECKABLE=1$/m);
  assert.match(c.out, /^FINDING CLOSE_UNCHECKABLE_NO_DECLARATION /m);
});

test('green: uncheckable 附**合格实证**（复用 LF-2A0 的正例 fixture）-> exit=0', () => {
  const l = landing('cl-uncheck-ok');
  const c = close(l, ['--hit', 'PS-OUTPUT-STREAM=uncheckable', '--declaration', OK_DECL, '--now', NOW]);
  assert.equal(c.rc, RC.OK, c.out);
  assert.match(c.out, /^RK_GATE_CLOSE_UNCHECKABLE=1$/m);
  assert.match(c.out, /^RK_GATE_CLOSE_RESULT=pass$/m);
  const row = rows(l)[0];
  assert.equal(row.declaration.ok, true);
  assert.equal(row.declaration.rule, 'PS-OUTPUT-STREAM');
});

test('red: uncheckable 实证**不合格**（只有一句话）-> CLOSE_UNCHECKABLE_INVALID + exit=1', () => {
  const l = landing('cl-uncheck-bad');
  const c = close(l, ['--hit', 'PS-OUTPUT-STREAM=uncheckable', '--declaration', SENTENCE_ONLY_DECL, '--now', NOW]);
  assert.equal(c.rc, RC.FAIL, c.out);
  assert.match(c.out, /^FINDING CLOSE_UNCHECKABLE_INVALID /m);
  const row = rows(l)[0];
  assert.equal(row.declaration.ok, false);
});

test('red/green: --evidence 报了就必须有实体（报告了不存在的文件 -> 红；存在的 -> 绿）', () => {
  const l = landing('cl-evidence');
  const missing = close(l, ['--none', '--evidence', join(l.dir, 'nope.txt')]);
  assert.equal(missing.rc, RC.FAIL);
  assert.match(missing.out, /^FINDING CLOSE_EVIDENCE_MISSING /m);
  assert.match(missing.out, /^FINDING CLOSE_EVIDENCE_MISSING 证据文件不存在: nope\.txt$/m, '判决类输出里必须用相对路径（清单 ㉒）');
  assert.equal(/(^|[^A-Za-z])[A-Za-z]:[\\/]/.test(missing.out), false, '判决类输出不得含盘符绝对路径');
  const real = join(l.dir, 'evidence.txt');
  writeFileSync(real, 'ok\n', 'utf8');
  const ok = close(l, ['--none', '--evidence', real]);
  assert.equal(ok.rc, RC.OK, ok.out);
  assert.match(ok.out, /^RK_GATE_CLOSE_EVIDENCE=1 MISSING=0$/m);
  assert.equal(rows(l)[rows(l).length - 1].evidence.length, 1);
});

test('判据: parseHit 只认 "<纪律>=<机制>"（缺一侧 / 空 / 非串 -> null）', () => {
  assert.deepEqual(parseHit('A=b'), { rule: 'A', stoppedBy: 'b' });
  assert.deepEqual(parseHit('改前留证=pre-commit'), { rule: '改前留证', stoppedBy: 'pre-commit' });
  assert.equal(parseHit('just-a-rule'), null);
  assert.equal(parseHit('=gate'), null);
  assert.equal(parseHit('rule='), null);
  assert.equal(parseHit(''), null);
  assert.equal(parseHit(null), null);
});

test('判据: 两入口同源（close ∥ dsh-rulekeeper gate close）逐字相同；--json 可机读且不含盘符绝对路径', () => {
  const l = landing('cl-entries');
  const a = close(l, ['--hit', 'PS-OUTPUT-STREAM=pre-commit', '--now', NOW]);
  const b = capture((io) => runRulekeeper(['gate', 'close', '--project', l.projectRoot, '--landing', l.landingDir, '--hit', 'PS-OUTPUT-STREAM=pre-commit', '--now', NOW], io, {}));
  assert.equal(a.out, b.out);
  assert.equal(a.rc, b.rc);
  assert.equal(a.rc, RC.OK);
  const j = close(l, ['--hit', 'PS-OUTPUT-STREAM=pre-commit', '--json', '--now', NOW]);
  const parsed = JSON.parse(j.out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.answered, true);
  assert.deepEqual(parsed.hits, [{ rule: 'PS-OUTPUT-STREAM', stoppedBy: 'pre-commit' }]);
  assert.equal(parsed.knownRules, 1);
  assert.equal(/(^|[^A-Za-z])[A-Za-z]:[\\/]/.test(j.out), false, '判决类输出不得含盘符绝对路径（清单 ㉒）');
});

test('green: 已知门清单覆盖"用例/审计/人工"等现实机制（本项目实际靠这些拦住）', () => {
  const l = landing('cl-known-gates');
  for (const [rule, stoppedBy] of [['PS-OUTPUT-STREAM', 'test'], ['PS-OUTPUT-STREAM', 'audit'], ['PS-OUTPUT-STREAM', 'human']]) {
    const r = closeGate({ projectRoot: l.projectRoot, landingDir: l.landingDir, hits: [{ rule, stoppedBy }] });
    assert.equal(r.ok, true, `${stoppedBy}: ${JSON.stringify(r.findings)}`);
  }
  assert.deepEqual(
    [...CLOSE_KNOWN_GATES].sort(),
    ['audit', 'bypass', 'check', 'ci', 'guard', 'hooks', 'human', 'post-commit', 'pre-commit', 'project-check', 'test', 'uncheckable', 'write'],
  );
});

test('usage: --hit 格式不对 / --now 非法 / --declaration 不存在或不是 JSON / --project 不存在 -> rc=2', () => {
  const l = landing('cl-usage');
  assert.equal(close(l, ['--hit', 'just-a-rule']).rc, RC.USAGE);
  assert.equal(close(l, ['--now', '不是时间']).rc, RC.USAGE);
  assert.equal(close(l, ['--declaration', join(l.dir, 'nope.json')]).rc, RC.USAGE);
  const bad = join(l.dir, 'bad.json');
  writeFileSync(bad, '{不是 JSON\n', 'utf8');
  assert.equal(close(l, ['--declaration', bad]).rc, RC.USAGE);
  assert.equal(gate(['close', '--project', join(l.dir, 'nope')]).rc, RC.USAGE);
  assert.equal(gate(['close', '--help']).rc, RC.OK);
  assert.equal(gate(['close', '--bogus']).rc, RC.USAGE);
});

test('判据: 收尾结论无论通过与否都写台账（事后能核对"这批当时是怎么说的"）', () => {
  const l = landing('cl-audit');
  assert.equal(close(l, ['--batch', 'B-ok', '--none', '--now', NOW]).rc, RC.OK);
  assert.equal(close(l, ['--batch', 'B-bad']).rc, RC.FAIL);
  const list = rows(l);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((r) => [r.batch, r.verdict]), [['B-ok', 'pass'], ['B-bad', 'rejected']]);
  const raw = readFileSync(gateLedgerPath(l.landingDir), 'utf8');
  assert.equal(raw.includes('\r'), false, '台账必须 LF');
  assert.match(raw, /"gate":"close"/);
});
