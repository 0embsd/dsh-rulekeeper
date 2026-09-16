// dsh-rulekeeper · LF-2A0 `uncheckable` 强制实证（先于判定）
//
// 判据（清单 §3 LF-2A0）：实证声明须含 `{探针命令, 非空输出, 正对照样本+输出}` + falsifier + 有效期（≤30 天/再复发即失效）；
//   三字段齐备才算合格。
// 红态：只有一句"探针说抓不到" → exit≠0；仪器正对照缺失 → exit≠0；占位话输出/过期/窗口超限/再复发 → 各自点名 FINDING。
// 另覆盖：8 例判决与 `test/fixtures/expected/uncheckable-*.json` **逐字**一致；两个入口同源。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runCheck, runRulekeeper } from '../src/cli.mjs';
import { compareWithExpected } from '../src/checks.mjs';
import { RC } from '../src/rc.mjs';
import { recurrenceAfter, UNCHECKABLE_MAX_DAYS, validateUncheckableDeclaration } from '../src/uncheckable.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';
import { CHECKS_DIR, expectedPathOf, UNCHECKABLE_CASES } from './helpers/check-cases.mjs';

test.after(cleanupAll);

const NOW = '2026-09-20T00:00:00.000Z';

function capture(fn) {
  let out = '';
  let err = '';
  const rc = fn({ out: (t) => { out += String(t); }, err: (t) => { err += String(t); } });
  return { rc, out, err };
}

function runCase(item) {
  return { ...capture((io) => runCheck([...item.args, '--json'], io, {})), spec: item };
}

/** 往临时目录写一份声明，返回其路径 */
function declFile(label, decl) {
  const dir = tempDir(label);
  const path = join(dir, 'decl.json');
  writeFileSync(path, `${JSON.stringify(decl, null, 2)}\n`, 'utf8');
  return path;
}

function baseDecl(overrides = {}) {
  return {
    rule: 'PS-OUTPUT-STREAM',
    probeCommand: 'node bin/rk-check.mjs untracked-change --file <目标> --landing <落点> --project <根>',
    probeOutput: 'FINDING UNTRACKED_CHANGE_NO_SNAPSHOT target.txt | exit=1',
    controlSample: 'test/fixtures/checks/untracked-ok/target.txt',
    controlOutput: 'RK_CHECK_VERDICT=pass | exit=0',
    falsifier: '若该纪律再复发一次且能给出可机检判据，本结论即失效',
    decidedAt: '2026-09-01T00:00:00.000Z',
    expiresAt: '2026-09-20T00:00:00.000Z',
    ...overrides,
  };
}

/** 跑一次判决；**默认 --json**（本文件多数断言要读结构化判决） */
function judge(decl, extra = []) {
  const file = declFile('u-judge', decl);
  return capture((io) => runCheck(['uncheckable', '--file', file, '--now', NOW, '--json', ...extra], io, {}));
}

test('判据：8 例 uncheckable 判决与 expected/*.json 逐字一致（正 1 反 7）', () => {
  assert.equal(UNCHECKABLE_CASES.length, 8);
  assert.equal(UNCHECKABLE_CASES.filter((c) => c.rc === 0).length, 1);
  assert.equal(UNCHECKABLE_CASES.filter((c) => c.rc === 1).length, 7);
  for (const item of UNCHECKABLE_CASES) {
    const r = runCase(item);
    assert.equal(r.rc, item.rc, `${item.name} 期望 rc=${item.rc} 实测 ${r.rc}\n${r.out}`);
    const cmp = compareWithExpected(r.out, expectedPathOf(item.name));
    assert.equal(cmp.ok, true, `${item.name}: ${cmp.reason ?? ''}`);
    assert.ok(!/^[a-zA-Z]:\//m.test(r.out), `${item.name}: 判决不得含绝对路径`);
  }
});

test('判据：三件套 + falsifier + 有效期齐备 -> pass，missing 为空', () => {
  const r = judge(baseDecl());
  assert.equal(r.rc, RC.OK, r.out);
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.verdict, 'pass');
  assert.deepEqual(parsed.detail.fields.missing, []);
  assert.equal(parsed.detail.hasFalsifier, true);
  assert.equal(parsed.detail.window.days, 19);
  assert.equal(parsed.detail.window.maxDays, UNCHECKABLE_MAX_DAYS);
  assert.equal(parsed.detail.expired, false);
});

test('红态：只有一句「探针说抓不到」-> 缺件点名 + exit≠0', () => {
  const r = judge({ rule: 'FACT-WRITING', mechanism: 'uncheckable（探针说抓不到）' });
  assert.equal(r.rc, RC.FAIL);
  const parsed = JSON.parse(r.out);
  const codes = parsed.findings.map((f) => f.code);
  assert.ok(codes.includes('UNCHECKABLE_MISSING_FIELD'));
  assert.ok(codes.includes('UNCHECKABLE_NO_CONTROL'));
  const msgs = parsed.findings.map((f) => f.message).join('\n');
  for (const field of ['probeCommand', 'probeOutput', 'falsifier', 'decidedAt', 'expiresAt']) {
    assert.match(msgs, new RegExp(field), `必须点名缺字段：${field}`);
  }
});

test('红态：仪器正对照缺失 -> 专门码 UNCHECKABLE_NO_CONTROL（不是泛泛"缺字段"）', () => {
  const r = judge(baseDecl({ controlSample: '', controlOutput: '   ' }));
  assert.equal(r.rc, RC.FAIL);
  const parsed = JSON.parse(r.out);
  const codes = parsed.findings.map((f) => f.code);
  assert.deepEqual([...new Set(codes)], ['UNCHECKABLE_NO_CONTROL']);
  assert.deepEqual(parsed.detail.fields.missing, ['controlOutput', 'controlSample']);
});

test('红态：占位话输出（"抓不到"/"无"/"n/a"）不算实证', () => {
  for (const placeholder of ['抓不到', '无', 'n/a', '—']) {
    const r = judge(baseDecl({ probeOutput: placeholder }));
    assert.equal(r.rc, RC.FAIL, `${placeholder} 必须失败`);
    assert.match(r.out, /UNCHECKABLE_PLACEHOLDER_OUTPUT/);
  }
});

test('红态：有效期过期 / 窗口 > 30 天 -> 各自点名；--max-days 可放宽（证明阈值不是死的）', () => {
  const expired = judge(baseDecl({ decidedAt: '2026-08-01T00:00:00.000Z', expiresAt: '2026-08-31T00:00:00.000Z' }));
  assert.equal(expired.rc, RC.FAIL);
  assert.match(expired.out, /UNCHECKABLE_EXPIRED/);

  const wide = baseDecl({ decidedAt: '2026-08-20T00:00:00.000Z', expiresAt: '2026-09-20T00:00:00.000Z' });
  const bad = judge(wide);
  assert.equal(bad.rc, RC.FAIL);
  assert.match(bad.out, /UNCHECKABLE_BAD_WINDOW/);
  assert.match(bad.out, /31 天 > 上限 30 天/);
  const relaxed = judge(wide, ['--max-days', '45']);
  assert.equal(relaxed.rc, RC.OK, relaxed.out);

  const reversed = judge(baseDecl({ decidedAt: '2026-09-10T00:00:00.000Z', expiresAt: '2026-09-01T00:00:00.000Z' }));
  assert.equal(reversed.rc, RC.FAIL);
  assert.match(reversed.out, /不晚于 decidedAt/);
});

test('红态：结论之后再复发即失效（按 canonical 口径，写法不同也算同一条）', () => {
  const r = runCase(UNCHECKABLE_CASES.find((c) => c.name === 'uncheckable-recurred'));
  assert.equal(r.rc, RC.FAIL);
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.detail.recurredAt, '2026-09-10T00:00:00.000Z');
  assert.match(r.out, /UNCHECKABLE_RECURRED/);
  // 同一份声明、换一个「结论之后没有复发」的落点 -> pass（证明失效的是复发，不是声明本身）
  const r2 = judge(baseDecl(), ['--landing', join(CHECKS_DIR, 'untracked-ok', 'landing')]);
  assert.equal(r2.rc, RC.OK, r2.out);
});

test('判据：recurrenceAfter 只算"结论之后"的行（结论前的不算）', () => {
  const dir = tempDir('u-recur');
  const landing = join(dir, 'landing');
  mkdirSync(landing, { recursive: true });
  const rows = [
    { schema: 1, id: 'A', ts: '2026-08-15T00:00:00.000Z', rule: 'PS-OUTPUT-STREAM' },
    { schema: 1, id: 'B', ts: '2026-09-10T00:00:00.000Z', rule: 'ps-output-stream' },
  ];
  writeFileSync(join(landing, 'ledger.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  assert.equal(recurrenceAfter(landing, 'PS-OUTPUT-STREAM', '2026-08-20T00:00:00.000Z'), '2026-09-10T00:00:00.000Z');
  assert.equal(recurrenceAfter(landing, 'PS-OUTPUT-STREAM', '2026-09-15T00:00:00.000Z'), null);
  assert.equal(recurrenceAfter(landing, 'OTHER-RULE', '2026-08-01T00:00:00.000Z'), null);
});

test('红态：非对象 / 坏 JSON / 目录当文件 / 文件不存在 -> 各自明确码或用法错误', () => {
  const notObject = judge(['nope', 'array']);
  assert.equal(notObject.rc, RC.FAIL);
  assert.match(notObject.out, /UNCHECKABLE_NOT_OBJECT/);

  const dir = tempDir('u-badjson');
  const broken = join(dir, 'broken.json');
  writeFileSync(broken, '{ nope', 'utf8');
  const bad = capture((io) => runCheck(['uncheckable', '--file', broken, '--now', NOW, '--json'], io, {}));
  assert.equal(bad.rc, RC.FAIL);
  assert.match(bad.out, /UNCHECKABLE_BAD_JSON/);

  const asDir = capture((io) => runCheck(['uncheckable', '--file', CHECKS_DIR, '--now', NOW, '--json'], io, {}));
  assert.equal(asDir.rc, RC.FAIL);
  assert.match(asDir.out, /UNCHECKABLE_FILE_UNREADABLE/);
  assert.equal(asDir.err, '', '异常不许打到 stderr（应是判决的一部分）');

  const ghost = capture((io) => runCheck(['uncheckable', '--file', join(dir, 'ghost.json')], io, {}));
  assert.equal(ghost.rc, RC.USAGE);
});

test('红态：参数错误 -> rc=2（--now 非法 / --max-days 非整数 / --landing 不存在）', () => {
  const file = declFile('u-args', baseDecl());
  const badNow = capture((io) => runCheck(['uncheckable', '--file', file, '--now', 'not-a-time'], io, {}));
  assert.equal(badNow.rc, RC.USAGE);
  assert.match(badNow.err, /--now 不是合法时间/);
  const badDays = capture((io) => runCheck(['uncheckable', '--file', file, '--max-days', 'abc'], io, {}));
  assert.equal(badDays.rc, RC.USAGE);
  const badLanding = capture((io) => runCheck(['uncheckable', '--file', file, '--landing', join(tempDir('u-none'), 'nope')], io, {}));
  assert.equal(badLanding.rc, RC.USAGE);
});

test('判据：两个入口同源（rk-check uncheckable 与 dsh-rulekeeper check --uncheckable 逐字同输出）', () => {
  const file = join(CHECKS_DIR, 'uncheckable-ok.json');
  const viaRunner = capture((io) => runCheck(['uncheckable', '--file', file, '--project', CHECKS_DIR, '--now', NOW], io, {}));
  const viaEntry = capture((io) => runRulekeeper(['check', '--uncheckable', file, '--project', CHECKS_DIR, '--now', NOW], io, {}));
  assert.equal(viaEntry.rc, viaRunner.rc);
  assert.equal(viaEntry.out, viaRunner.out, '两个入口必须逐字同输出（禁止两套口径）');
  const jsonRunner = capture((io) => runCheck(['uncheckable', '--file', file, '--project', CHECKS_DIR, '--now', NOW, '--json'], io, {}));
  const jsonEntry = capture((io) => runRulekeeper(['check', '--uncheckable', file, '--project', CHECKS_DIR, '--now', NOW, '--json'], io, {}));
  assert.equal(jsonEntry.out, jsonRunner.out);
  const both = capture((io) => runRulekeeper(['check', '--uncheckable', file, '--shape', file], io, {}));
  assert.equal(both.rc, RC.USAGE);
  assert.match(both.err, /互斥/);
});

test('判据：纯函数层与 CLI 层同结论（防两套实现）', () => {
  const decl = baseDecl();
  const direct = validateUncheckableDeclaration(decl, { now: new Date(NOW), maxDays: UNCHECKABLE_MAX_DAYS });
  const viaCli = judge(decl);
  assert.equal(direct.ok, true);
  assert.equal(JSON.parse(viaCli.out).ok, direct.ok);
  const badDecl = baseDecl({ controlOutput: '' });
  const directBad = validateUncheckableDeclaration(badDecl, { now: new Date(NOW) });
  assert.equal(directBad.ok, false);
  assert.equal(JSON.parse(judge(badDecl).out).ok, directBad.ok);
  assert.equal(existsSync(join(CHECKS_DIR, 'uncheckable-ok.json')), true);
  assert.ok(readFileSync(join(CHECKS_DIR, 'uncheckable-ok.json'), 'utf8').includes('probeCommand'));
});
