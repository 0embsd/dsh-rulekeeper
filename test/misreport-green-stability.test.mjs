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

import { cleanupAll, PKG_ROOT, runCheckerVerdict, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const CHECKER = join(PKG_ROOT, 'scripts', 'checkers', 'misreport-surface.mjs');
const SPEC = join(PKG_ROOT, 'scripts', 'checkers', 'misreport-surface.spec.json');
const FIXTURE = join(PKG_ROOT, 'test-fixtures', 'misreport-green');
const FIXTURE_RULES = join(FIXTURE, '.dsh-ai', 'rulekeeper', 'rules.json');

/**
 * 跑检查器。**统一走 `runCheckerVerdict`**（退出码语义守卫）：默认要求"有结论"，
 * `exit 2`（不适用）会被判失败并给出可操作提示 —— 这正是本会话差点交付假绿的那条缝。
 */
function run(sampleDir = null, opts = {}) {
  return runCheckerVerdict(CHECKER, { sampleDir, label: 'misreport-surface', ...opts });
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
  assert.equal(res.status, 0, `夹具上必须绿（第一版空绑定落点在这里 exit=2 ⇒ 会被 verify 判误报）；out=${res.stdout}`);
  assert.match(res.stdout, /MISREPORT_VIOLATIONS=0/);
  assert.match(res.stdout, /MISREPORT_CHECK rule=FIXTURE-RULE .*verdict=ok/, '夹具那条绑定必须真被核过');
});

test('缺口②③: **字节稳定性** —— 同一棵夹具树跑两次，输出逐字相同；且检查器不改动夹具', () => {
  const before = readFileSync(FIXTURE_RULES, 'utf8');
  const redBefore = readFileSync(join(FIXTURE, 'test-fixtures', 'fake', 'red', 'FAIL'), 'utf8');
  const a = run();
  const b = run();
  assert.equal(b.stdout, a.stdout, '同一夹具两次运行必须逐字相同（活体工作区做不到这一点）');
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
  assert.equal(res.status, 1, `坏落点必须判红（否则"绿"是恒绿）；out=${res.stdout}`);
  assert.match(res.stdout, /MISREPORT_SPEC_MISSING/, `必须指明是规格缺失；out=${res.stdout}`);
});

test('缺口②⑤（假绿防线 B）: 夹具的假检查器改成"恒 exit 0" ⇒ 红样本不开火必须判红', () => {
  const dir = copyFixture('misreport-green-blind-checker');
  // 把假检查器改成恒绿：红样本树上的退出码就不再是 1 ⇒ 本检查器必须报 MISREPORT_RED_NOT_HIT
  writeFileSync(join(dir, 'fake-checker.mjs'), 'console.log("always green");\nprocess.exit(0);\n', 'utf8');
  const res = run(dir);
  assert.equal(res.status, 1, `判据不开火必须判红；out=${res.stdout}`);
  assert.match(res.stdout, /MISREPORT_RED_NOT_HIT/, `必须指明是"红样本不开火"；out=${res.stdout}`);
});

test('缺口②⑥: 真仓上仍绿，且 `CAT-VERIFY` 那条**真被核**（没被递归护栏顺手跳过）', () => {
  const res = run();
  assert.equal(res.status, 0, `真仓必须绿；out=${res.stdout}`);
  assert.match(res.stdout, /MISREPORT_VIOLATIONS=0/);
  assert.match(res.stdout, /MISREPORT_ROOT=\S+ BINDINGS=\d+ CHECKED=\d+ SKIPPED_SELF=\d+ SKIPPED_SHAPE=\d+/);
  const skippedSelf = Number(/SKIPPED_SELF=(\d+)/.exec(res.stdout)?.[1] ?? '0');
  assert.equal(skippedSelf, 1, '只应跳过 1 条（CAT-VERIFY 自己那条）；多了就是把别的绑定也跳过了');
});

// ── 缺口②⑦（**本轮最危险那条缝的永久反例**）：判据给出"不适用"时，**不得**被读成绿 ─────────────
// 现场：第一版夹具是"没有可核绑定"的落点 ⇒ 检查器走"不适用"路径 **exit 2**，
// 而我的断言只看"有没有违规"，于是**看起来是通过的** —— 直到 `rk-effect verify` 的"误报面绿"（期望 0）
// 拿到 2 才把它判红。也就是说：**"我没判"被当成了"判绿"**。
test('缺口②⑦: "不适用"必须与"通过"分开 —— 空绑定落点不得被读成绿', () => {
  // ① 语义层：这类落点**确实是**"不适用"（0 个绑定），必须显式声明才允许断言它
  const empty = copyFixture('misreport-green-empty');
  writeFileSync(join(empty, '.dsh-ai', 'rulekeeper', 'rules.json'), `${JSON.stringify({
    schema: 1, project: 'no-bindings', protected_paths: [], gates: [], inject: [], checks: [],
  }, null, 2)}\n`, 'utf8');
  const na = run(empty, { expect: 'not-applicable' });
  assert.equal(na.status, 2);
  assert.match(na.stdout, /MISREPORT_BINDINGS=none/, '必须如实说清"为什么没核"');
  assert.doesNotMatch(na.stdout, /MISREPORT_VIOLATIONS=0/, '"不适用"不得打印"零违规"这种"通过"措辞');

  // ② **守卫层（本用例的核心）**：默认（判据面）读它 ⇒ 必须**失败**，而不是"绿了但没判"
  assert.throws(() => run(empty), /不适用.*不等于.*判绿|"不适用"/s,
    '默认判据面读"不适用"必须直接失败 —— 这就是那条缝的机械面');
});
