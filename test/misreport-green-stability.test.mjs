// dsh-rulekeeper · 交付判据（CAT-VERIFY）绿样本的**稳定性**用例
//
// 现场（2026-09-23，本会话实测）：`misreport-surface.spec.json` 的 `greenSample.source = "."`
// = **此刻的活体工作区**。有在途改动时（并发写落点 / 正在改检查器），它会报
// `MISREPORT_GREEN_FALSE_POSITIVE` ⇒ 把"交付判据"这条门禁判红，而它其实没坏；复跑即绿。
// 属规则 42 同族：**判据的红/绿样本都必须能随时重跑，不能依赖"此刻恰好是什么状态"**。
//
// 本文件的判据（红 = 任一性质被破坏）：
//   ① 规格里的 `greenSample.source` 必须是**入库夹具**（不是 `.`，也不是空）
//   ② 夹具**必须让本检查器真能核出结论**：夹具自带一条 checker 绑定 ⇒ 本检查器在其上 exit 0
//      （第一版夹具是个"空绑定落点"，在本检查器的绿样本上 exit 2 ⇒ 误报面判红，`rk-effect verify` 当场抓到）
//   ③ **字节稳定性**：同一棵夹具树跑两次，输出逐字相同；且检查器不改动夹具一个字节
//   ④ **假绿防线 A**：夹具里放"有绑定但 spec 缺失"的坏落点 ⇒ 必须判红（`MISREPORT_SPEC_MISSING`）
//   ⑤ **假绿防线 B**：把夹具的假检查器改成"恒 exit 0" ⇒ **红样本上不开火**必须判红（`MISREPORT_RED_NOT_HIT`）
//      —— 这条证明"绿"来自**真跑**，不是恒绿
//   ⑥ 真仓上仍绿，且 `CAT-VERIFY` 那条**真被核**（没被递归护栏顺手跳过）
//
// 反向红：把 `greenSample.source` 改回 `"."` ⇒ ① 红；把夹具的绑定删掉 ⇒ ② 红；
// 把夹具的假检查器改成恒 0 ⇒ ⑤ 红。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanupAll, PKG_ROOT, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const CHECKER = join(PKG_ROOT, 'scripts', 'checkers', 'misreport-surface.mjs');
const SPEC = join(PKG_ROOT, 'scripts', 'checkers', 'misreport-surface.spec.json');
const FIXTURE = join(PKG_ROOT, 'test-fixtures', 'misreport-green');
const FIXTURE_RULES = join(FIXTURE, '.dsh-ai', 'rulekeeper', 'rules.json');

function run(sampleDir = null) {
  const env = { ...process.env };
  if (sampleDir === null) delete env.RULEKEEPER_SAMPLE_DIR;
  else env.RULEKEEPER_SAMPLE_DIR = sampleDir;
  const res = spawnSync(process.execPath, [CHECKER], { cwd: PKG_ROOT, encoding: 'utf8', env });
  return { rc: res.status, out: res.stdout ?? '', err: res.stderr ?? '' };
}

/** 复制夹具到临时目录（用于"注入破坏"而不污染入库夹具） */
function copyFixture(label) {
  const dir = tempDir(label);
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

test('缺口②①: 交付判据的绿样本必须是**入库夹具**，不能是活体工作区（"."）', () => {
  const spec = JSON.parse(readFileSync(SPEC, 'utf8'));
  const src = spec.greenSample?.source;
  assert.equal(typeof src, 'string', '规格必须写 greenSample.source（缺了就是 MISREPORT_NO_GREEN_SAMPLE）');
  assert.notEqual(src, '.', `绿样本不得取活体工作区（有在途改动就会假红）；实得 ${JSON.stringify(src)}`);
  assert.equal(src, 'test-fixtures/misreport-green', `绿样本应是入库夹具；实得 ${JSON.stringify(src)}`);
  assert.equal(existsSync(FIXTURE_RULES), true, '夹具必须是结构合法的落点（含 rules.json）');
});

test('缺口②②: 夹具必须**自带可核绑定** ⇒ 本检查器在其上 exit 0（不是"没有可核对象"）', () => {
  const rules = JSON.parse(readFileSync(FIXTURE_RULES, 'utf8'));
  const checkerBindings = (rules.checks ?? []).filter((c) => c?.kind === 'checker');
  assert.equal(checkerBindings.length >= 1, true, '夹具至少要有一条 checker 绑定（否则本检查器在其上 exit 2）');
  const res = run(FIXTURE);
  assert.equal(res.rc, 0, `夹具上必须绿（第一版空绑定落点在这里 exit=2 ⇒ 会被 verify 判误报）；out=${res.out}`);
  assert.match(res.out, /MISREPORT_VIOLATIONS=0/);
  assert.match(res.out, /MISREPORT_CHECK rule=FIXTURE-RULE .*verdict=ok/, '夹具那条绑定必须真被核过');
});

test('缺口②③: **字节稳定性** —— 同一棵夹具树跑两次，输出逐字相同；且检查器不改动夹具', () => {
  const before = readFileSync(FIXTURE_RULES, 'utf8');
  const redBefore = readFileSync(join(FIXTURE, 'test-fixtures', 'fake', 'red', 'FAIL'), 'utf8');
  const a = run();
  const b = run();
  assert.equal(b.out, a.out, '同一夹具两次运行必须逐字相同（活体工作区做不到这一点）');
  assert.equal(readFileSync(FIXTURE_RULES, 'utf8'), before, '检查器不得改动夹具一个字节');
  assert.equal(readFileSync(join(FIXTURE, 'test-fixtures', 'fake', 'red', 'FAIL'), 'utf8'), redBefore);
});

test('缺口②④（假绿防线 A）: 夹具里放"有绑定但 spec 缺失"的坏落点 ⇒ 必须判红', () => {
  const dir = copyFixture('misreport-green-broken-spec');
  writeFileSync(join(dir, '.dsh-ai', 'rulekeeper', 'rules.json'), `${JSON.stringify({
    schema: 1, project: 'broken', protected_paths: [], gates: [], inject: [],
    checks: [{ kind: 'checker', rule: 'BROKEN-RULE', spec: 'nope.spec.json', command: ['node', 'x.mjs'] }],
  }, null, 2)}\n`, 'utf8');
  const res = run(dir);
  assert.equal(res.rc, 1, `坏落点必须判红（否则"绿"是恒绿）；out=${res.out}`);
  assert.match(res.out, /MISREPORT_SPEC_MISSING/, `必须指明是规格缺失；out=${res.out}`);
});

test('缺口②⑤（假绿防线 B）: 夹具的假检查器改成"恒 exit 0" ⇒ 红样本不开火必须判红', () => {
  const dir = copyFixture('misreport-green-blind-checker');
  // 把假检查器改成恒绿：红样本树上的退出码就不再是 1 ⇒ 本检查器必须报 MISREPORT_RED_NOT_HIT
  writeFileSync(join(dir, 'fake-checker.mjs'), 'console.log("always green");\nprocess.exit(0);\n', 'utf8');
  const res = run(dir);
  assert.equal(res.rc, 1, `判据不开火必须判红；out=${res.out}`);
  assert.match(res.out, /MISREPORT_RED_NOT_HIT/, `必须指明是"红样本不开火"；out=${res.out}`);
});

test('缺口②⑥: 真仓上仍绿，且 `CAT-VERIFY` 那条**真被核**（没被递归护栏顺手跳过）', () => {
  const res = run();
  assert.equal(res.rc, 0, `真仓必须绿；out=${res.out}`);
  assert.match(res.out, /MISREPORT_VIOLATIONS=0/);
  assert.match(res.out, /MISREPORT_ROOT=\S+ BINDINGS=\d+ CHECKED=\d+ SKIPPED_SELF=\d+ SKIPPED_SHAPE=\d+/);
  const skippedSelf = Number(/SKIPPED_SELF=(\d+)/.exec(res.out)?.[1] ?? '0');
  assert.equal(skippedSelf, 1, '只应跳过 1 条（CAT-VERIFY 自己那条）；多了就是把别的绑定也跳过了');
});
