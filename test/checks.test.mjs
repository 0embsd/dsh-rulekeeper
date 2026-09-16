// dsh-rulekeeper · LF-250 用例：三类可机检 check（6 fixture × expected 逐字比对）
//               LF-260 用例：形态守卫（阈值随冻结夹具 sha256）
//
// 判据（LF-250）：6 个 fixture 路径 × 期望 JSON 齐备（正 3 + 反 3）；每条 check 的 stdout **逐字 == expected/<name>.json**
// 红态（LF-250）：每类至少 1 例违规 → 确定 exit + 关键输出行，且与绿态输出**不同**；缺 expected → exit≠0
// 判据（LF-260）：`check --shape <合规>` exit 0、`<塌陷>` exit≠0；阈值随夹具 sha256
// 红态（LF-260）：夹具被改而阈值未更新 → SHAPE_FIXTURE_DRIFT → exit≠0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runCheck, runRulekeeper } from '../src/cli.mjs';
import { compareWithExpected, loadShapeBaseline, measureFile, PKG_ROOT } from '../src/checks.mjs';
import { RC } from '../src/rc.mjs';
import { tempDir, cleanupAll } from './helpers/sandbox.mjs';
import { CHECKS_DIR, CHECK_CASES, expectedPathOf } from './helpers/check-cases.mjs';

test.after(cleanupAll);

function capture(fn) {
  let out = '';
  let err = '';
  const rc = fn({ out: (t) => { out += String(t); }, err: (t) => { err += String(t); } });
  return { rc, out, err };
}

/** 跑一例（追加 `--json` 取判决 JSON） */
function runCase(item) {
  return { ...capture((io) => runCheck([...item.args, '--json'], io, {})), spec: item };
}

function caseOf(name) {
  return CHECK_CASES.find((c) => c.name === name);
}

test('判据：6 个 fixture 的判决 JSON 与 expected 逐字一致（正 3 rc=0 / 反 3 rc=1）', () => {
  assert.equal(CHECK_CASES.length, 6);
  assert.equal(CHECK_CASES.filter((c) => c.rc === 0).length, 3, '每类至少一例绿');
  assert.equal(CHECK_CASES.filter((c) => c.rc === 1).length, 3, '每类至少一例红');
  for (const item of CHECK_CASES) {
    const r = runCase(item);
    assert.equal(r.rc, item.rc, `${item.name} 期望 rc=${item.rc} 实测 ${r.rc}`);
    const cmp = compareWithExpected(r.out, expectedPathOf(item.name));
    assert.equal(cmp.ok, true, `${item.name}: ${cmp.reason ?? ''}`);
  }
});

test('红态：基准文件本身必须是纯 LF（PowerShell 生成的 CRLF 会让逐字比对假红）', () => {
  for (const item of CHECK_CASES) {
    const bytes = readFileSync(expectedPathOf(item.name));
    assert.equal(bytes.includes(0x0d), false, `${item.name}.json 含 CR；基准只能用 LF（见 scripts/gen-expected.mjs）`);
    assert.notEqual(bytes[0], 0xef, `${item.name}.json 带 UTF-8 BOM`);
  }
});

test('红态：每类至少 1 例违规，且违规输出与绿态**不同**并带确定 finding', () => {
  for (const kind of ['file_untracked_change', 'output_shape', 'invalid_reference']) {
    const ok = runCase(CHECK_CASES.find((c) => c.kind === kind && c.rc === 0));
    const bad = runCase(CHECK_CASES.find((c) => c.kind === kind && c.rc === 1));
    assert.notEqual(bad.out, ok.out, `${kind}: 违规输出必须与绿态不同`);
    const parsed = JSON.parse(bad.out);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.verdict, 'violation');
    assert.ok(parsed.findings.length >= 1, `${kind}: 违规必须给出至少一条 finding（关键输出行）`);
    assert.equal(parsed.kind, kind);
  }
});

test('判据：缺 expected 文件 → compareWithExpected 报红（没有基准不算通过）', () => {
  const ghost = join(tempDir('c-noexpect'), 'ghost.json');
  assert.equal(existsSync(ghost), false);
  const cmp = compareWithExpected('{}\n', ghost);
  assert.equal(cmp.ok, false);
  assert.match(cmp.reason, /缺少 expected 文件/);
});

test('判决里禁绝对路径、禁时间戳（fixture 与机器无关，判据可跨机复核）', () => {
  for (const item of CHECK_CASES) {
    const r = runCase(item);
    // 旧断言 `!/[A-Z]:[\\/]/` 在 displayPath 必经 toPosix（盘符小写化）之后**恒真**——
    // 实测 `d:/opt/x.txt` / `//srv/share` 都能溜过去（LF-250 复核建议 6）。改锚定行首形态。
    assert.ok(!/^[a-zA-Z]:\//m.test(r.out), `${item.name} 的判决不得含 Windows 绝对路径`);
    assert.ok(!/^\/\//m.test(r.out), `${item.name} 的判决不得含 UNC 路径`);
    assert.ok(!/\/(Users|home|tmp)\//.test(r.out), `${item.name} 的判决不得含 POSIX 绝对路径`);
    assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(r.out), `${item.name} 的判决不得含时间戳`);
  }
});

test('红态：换 cwd 后同一命令的判决必须逐字不变（曾因 cwd 泄漏绝对路径而变）', () => {
  const before = process.cwd();
  const away = tempDir('c-cwd');
  try {
    const fromPkg = CHECK_CASES.map((item) => runCase(item).out);
    process.chdir(away);
    const fromAway = CHECK_CASES.map((item) => runCase(item).out);
    for (let i = 0; i < CHECK_CASES.length; i += 1) {
      assert.equal(fromAway[i], fromPkg[i], `${CHECK_CASES[i].name}: 换 cwd 后判决变了`);
      assert.equal(compareWithExpected(fromAway[i], expectedPathOf(CHECK_CASES[i].name)).ok, true,
        `${CHECK_CASES[i].name}: 换 cwd 后与基准不一致`);
    }
  } finally {
    process.chdir(before);
  }
});

test('红态：阈值写错/不给冻结值都不许假绿（非数字 → rc=2；无冻结值 → SHAPE_NO_FROZEN_SHA）', () => {
  const sample = join(CHECKS_DIR, 'output-shape-ok.txt');
  for (const bad of ['abc', '3.9', '-1', '']) {
    const r = capture((io) => runCheck(['shape', '--file', sample, '--lines', bad], io, {}));
    assert.equal(r.rc, RC.USAGE, `--lines ${JSON.stringify(bad)} 必须 rc=2（不许静默丢弃后 pass）`);
    assert.match(r.err, /需要非负整数/);
  }
  // 包外文件 + 无 --sha256 + 无冻结源记录 -> 明确“没有冻结值不算通过”，而不是 pass
  const outside = join(tempDir('c-nofrozen'), 'copy.txt');
  writeFileSync(outside, readFileSync(sample, 'utf8'), 'utf8');
  const r = capture((io) => runCheck(['shape', '--file', outside], io, {}));
  assert.equal(r.rc, RC.FAIL);
  assert.match(r.out, /SHAPE_NO_FROZEN_SHA/);
  assert.ok(!/RK_CHECK_VERDICT=pass/.test(r.out));
});

test('判据：包内冻结源接线——不给任何阈值也能判（sha/行数取自 shape-baseline.json）', () => {
  const sample = join(CHECKS_DIR, 'output-shape-ok.txt');
  const r = capture((io) => runCheck(['shape', '--file', sample], io, {}));
  assert.equal(r.rc, RC.OK);
  assert.match(r.out, /RK_CHECK_VERDICT=pass/);
  const frozen = JSON.parse(readFileSync(join(CHECKS_DIR, 'shape-baseline.json'), 'utf8'));
  const entry = frozen.fixtures['test/fixtures/checks/output-shape-ok.txt'];
  assert.ok(entry !== undefined, '冻结源必须登记该夹具');
  assert.match(r.out, new RegExp(`RK_CHECK_SHA256=${entry.sha256}`));
  assert.match(r.out, new RegExp(`RK_CHECK_LINES=${entry.lines}`));
  // 冻结源与实物同源：任一不一致都说明"夹具改了没同步阈值"
  for (const [rel, want] of Object.entries(frozen.fixtures)) {
    const m = measureFile(join(PKG_ROOT, rel));
    assert.equal(m.sha256, want.sha256, `${rel} 冻结 sha 与实物不一致`);
    assert.equal(m.lines, want.lines, `${rel} 冻结行数与实物不一致`);
    assert.equal(m.maxLineLength, want.maxLineLength, `${rel} 冻结最长行与实物不一致`);
  }
});

test('红态：冻结源坏掉/缺失 -> 视为"没有冻结值"（fail-closed，不许静默放行）', () => {
  const dir = tempDir('c-badbaseline');
  const broken = join(dir, 'shape-baseline.json');
  writeFileSync(broken, '{ not json', 'utf8');
  assert.equal(loadShapeBaseline(broken), null);
  assert.equal(loadShapeBaseline(join(dir, 'ghost.json')), null);
});

test('红态：--file 指向目录 -> 明确 finding + 可解析 JSON（不许裸抛异常、stdout 为空）', () => {
  const dirAsFile = CHECKS_DIR;
  const cases = [
    ['output-shape', ['output-shape', '--file', dirAsFile, '--project', CHECKS_DIR]],
    ['invalid-reference', ['invalid-reference', '--file', dirAsFile, '--project', CHECKS_DIR]],
    ['untracked-change', ['untracked-change', '--file', dirAsFile, '--landing', CHECKS_DIR, '--project', CHECKS_DIR]],
    ['shape', ['shape', '--file', dirAsFile]],
  ];
  for (const [label, args] of cases) {
    const r = capture((io) => runCheck([...args, '--json'], io, {}));
    assert.notEqual(r.rc, RC.OK, `${label}: 目录当文件必须非 0`);
    assert.equal(r.err, '', `${label}: 不许把异常打到 stderr（应是判决的一部分）`);
    const parsed = JSON.parse(r.out);
    assert.equal(parsed.ok, false);
    assert.ok(parsed.findings.some((f) => f.code.endsWith('_FILE_UNREADABLE')), `${label}: 需给出 *_FILE_UNREADABLE`);
  }
});

test('红态：入口参数错误必须 rc=2（--project 缺失 / --shape 与 --landing 同给 / --sha256 格式错）', () => {
  const sample = join(CHECKS_DIR, 'output-shape-ok.txt');
  const noProject = capture((io) => runCheck(['untracked-change', '--file', join(CHECKS_DIR, 'untracked-ok', 'target.txt'), '--landing', join(CHECKS_DIR, 'untracked-ok')], io, {}));
  assert.equal(noProject.rc, RC.USAGE);
  assert.match(noProject.err, /需要 --project/);
  const both = capture((io) => runRulekeeper(['check', '--shape', sample, '--landing', CHECKS_DIR], io, {}));
  assert.equal(both.rc, RC.USAGE);
  assert.match(both.err, /互斥/);
  const badSha = capture((io) => runCheck(['shape', '--file', sample, '--sha256', 'XYZ'], io, {}));
  assert.equal(badSha.rc, RC.USAGE);
  assert.match(badSha.err, /64 位小写十六进制/);
});

test('判据：仓内行尾纪律有实体（.gitattributes 保护逐字基准，防 autocrlf 把基准变 CRLF）', () => {
  const attrs = readFileSync(join(PKG_ROOT, '.gitattributes'), 'utf8');
  assert.match(attrs, /\.json\s+text eol=lf/);
  assert.match(attrs, /test\/fixtures\/\*\*\s+-text/);
});

test('LF-260 形态守卫：合规样本 pass（阈值=实测值）', () => {
  const sample = join(CHECKS_DIR, 'output-shape-ok.txt');
  const m = measureFile(sample);
  const r = capture((io) => runCheck(['shape', '--file', sample, '--lines', String(m.lines), '--maxline', String(m.maxLineLength), '--sha256', m.sha256], io, {}));
  assert.equal(r.rc, RC.OK);
  assert.match(r.out, /RK_CHECK_KIND=shape_guard/);
  assert.match(r.out, /RK_CHECK_VERDICT=pass/);
  assert.match(r.out, new RegExp(`RK_CHECK_LINES=${m.lines}`));
  assert.match(r.out, new RegExp(`RK_CHECK_MAXLINE=${m.maxLineLength}`));
  assert.match(r.out, new RegExp(`RK_CHECK_SHA256=${m.sha256}`));
});

test('LF-260 形态守卫：塌陷样本 -> violation（行数/最长行不符）', () => {
  const collapsed = join(CHECKS_DIR, 'output-shape-violation.txt');
  const r = capture((io) => runCheck(['shape', '--file', collapsed, '--lines', '703', '--maxline', '776'], io, {}));
  assert.equal(r.rc, RC.FAIL);
  assert.match(r.out, /RK_CHECK_VERDICT=violation/);
  assert.match(r.out, /SHAPE_LINES_MISMATCH/);
  assert.match(r.out, /SHAPE_MAXLINE_MISMATCH/);
});

test('LF-260 红态：夹具被改而冻结 sha256 未更新 -> SHAPE_FIXTURE_DRIFT（防判据腐烂）', () => {
  const original = join(CHECKS_DIR, 'output-shape-ok.txt');
  const frozen = measureFile(original);
  const copy = join(tempDir('c-drift'), 'sample.txt');
  writeFileSync(copy, `${readFileSync(original, 'utf8')}appended-line\n`, 'utf8');
  const r = capture((io) => runCheck([
    'shape', '--file', copy, '--lines', String(frozen.lines), '--maxline', String(frozen.maxLineLength), '--sha256', frozen.sha256,
  ], io, {}));
  assert.equal(r.rc, RC.FAIL);
  assert.match(r.out, /SHAPE_FIXTURE_DRIFT/);
});

test('LF-260：`dsh-rulekeeper check --shape` 与 `rk-check shape` 是同一守卫、同一套 token', () => {
  const sample = join(CHECKS_DIR, 'output-shape-ok.txt');
  const m = measureFile(sample);
  const common = ['--lines', String(m.lines), '--maxline', String(m.maxLineLength), '--sha256', m.sha256];
  const viaRunner = capture((io) => runCheck(['shape', '--file', sample, ...common], io, {}));
  const viaEntry = capture((io) => runRulekeeper(['check', '--shape', sample, ...common], io, {}));
  assert.equal(viaEntry.rc, RC.OK);
  assert.equal(viaEntry.out, viaRunner.out, '两个入口必须逐字同输出（禁止两套口径）');
  const jsonRunner = capture((io) => runCheck(['shape', '--file', sample, ...common, '--json'], io, {}));
  const jsonEntry = capture((io) => runRulekeeper(['check', '--shape', sample, ...common, '--json'], io, {}));
  assert.equal(jsonEntry.out, jsonRunner.out);
  assert.equal(JSON.parse(jsonEntry.out).kind, 'shape_guard');
  const helpr = capture((io) => runRulekeeper(['check', '--help'], io, {}));
  assert.equal(helpr.rc, RC.OK);
  assert.match(helpr.out, /--shape/);
});

test('measureFile 与判决里的 lines/maxLineLength 同源（防两套口径）', () => {
  for (const name of ['output-shape-ok', 'output-shape-violation']) {
    const m = measureFile(join(CHECKS_DIR, `${name}.txt`));
    const parsed = JSON.parse(runCase(caseOf(name)).out);
    assert.equal(parsed.detail.lines, m.lines, `${name} 行数口径应一致`);
    assert.equal(parsed.detail.maxLineLength, m.maxLineLength, `${name} 最长行口径应一致`);
  }
});
