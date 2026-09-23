// dsh-rulekeeper · 计划工件对账检查的用例（插件能力面扩张 · V1 observe）
//
// 设计单：`.dsh-ai/design/plan-artifact-check-20260923.md`
// 为什么先量后写（本文件的存在理由）：这条纪律最直觉的两种机械形态都被真仓数据否掉 ——
//   ① "改代码的提交前 24h 必须有 plan/design 工件" ⇒ 本仓 **53/53 = 100% 命中**（该仓历史上 plan/design 改动 0 条）；
//   ② "提交正文必须含要点（判据+为什么）" ⇒ **18/34 = 53%**（超 30% 止损线，且测的是关键词）。
// 选定形态：**计划工件落成台账行**（`类目=计划` + `problem` 以 `PLAN_DECLARED` 开头），门禁按"行 ↔ 改动"对账。
//
// 本文件的判据：
//   ① 绿样本（有计划行且覆盖）⇒ `PLAN_FINDINGS=0` `pass`
//   ② 红样本 A（0 条计划行）⇒ **exit 2 = 不适用**（"没得判"绝不等于"通过"）
//   ③ 红样本 B（有计划行但过窗）⇒ `PLAN_FINDINGS≥1`；**observe 档 exit 0**、**armed 档 exit 1**（档位与命中分开报）
//   ④ 没声明 `planScope` 的落点 ⇒ exit 2（不硬编扩展名；口径由被治理仓声明）
//   ⑤ **诚实边界**必须打印：判不了"是否真先想过"、`why/criteria/rollback` 是声明不是签名、钩子只在提交时跑
//   ⑥ 真仓（本仓**未**声明 planScope）⇒ exit 2 —— 如实报"我没量到"，不是通过
//
// 反向红：① 把窗口判定改成恒"在窗内" ⇒ ③ 的 armed 档必须红；
//         ② 把"计划行数=0"分支改成 exit 0（当绿）⇒ ② 必须红。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanupAll, PKG_ROOT, runCheckerVerdict, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const CHECKER = join(PKG_ROOT, 'scripts', 'checkers', 'plan-artifact.mjs');
const FIXTURE = (name) => join(PKG_ROOT, 'test-fixtures', name);

const git = (root, ...args) => {
  const r = spawnSync('git', ['-c', 'core.quotePath=false', '-C', root, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} 失败：${r.stderr}`);
  return (r.stdout ?? '').trim();
};

/**
 * 把夹具复制成**真 git 仓**：一次基线提交 + 一次"改代码"提交。
 * 返回 `{ dir, headTs }`（headTs 供计划行时间对齐 ⇒ 不依赖现场时钟，规则 42）。
 */
function makeRepo(name, { plan = null } = {}) {
  const dir = tempDir(`plan-${name}`);
  cpSync(FIXTURE(name), dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'probe@local');
  git(dir, 'config', 'user.name', 'probe');
  writeFileSync(join(dir, 'base.txt'), 'baseline\n', 'utf8');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'baseline');
  // 第二次提交 = 代码类改动
  writeFileSync(join(dir, 'src', 'change.mjs'), `${readFileSync(join(dir, 'src', 'change.mjs'), 'utf8')}// touched\n`, 'utf8');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'change code');
  const headTs = git(dir, 'log', '-1', '--format=%cI');
  if (plan !== null) {
    const row = JSON.stringify({
      schema: 1, id: plan.id, ts: plan.ts(headTs), category: '计划',
      problem: plan.problem, root_cause: '', solution: plan.solution ?? '', verification: '', evidence: [],
    });
    writeFileSync(join(dir, '.dsh-ai', 'rulekeeper', 'ledger.jsonl'), `${row}\n`, 'utf8');
  }
  return { dir, headTs };
}

const runPlan = (dir, env = {}, expect = 'verdict') => runCheckerVerdict(CHECKER, {
  sampleDir: dir,
  env: { RULEKEEPER_PLAN_BASE: 'HEAD~1', RULEKEEPER_PLAN_HEAD: 'HEAD', ...env },
  label: 'plan-artifact',
  expect,
});

test('计划①: 绿样本（有计划行且覆盖改动）⇒ PLAN_FINDINGS=0 / pass', () => {
  const { dir } = makeRepo('plan-green', {
    plan: { id: 'LF-PLAN-1', ts: (headTs) => headTs, problem: 'PLAN_DECLARED scope=**/*.mjs why=先写计划 criteria=判据 rollback=revert', solution: 'runCheckerVerdict + 两态样本' },
  });
  const r = runPlan(dir);
  assert.equal(r.status, 0, `绿样本必须 pass；out=${r.stdout}`);
  assert.match(r.stdout, /PLAN_FINDINGS=0/);
  assert.match(r.stdout, /PLAN_CHECK_RESULT=pass/);
  assert.match(r.stdout, /PLAN_CHECK_SCOPE changed=\d+ code=\d+ plan_rows=1/, '必须如实给出范围读数');
});

test('计划②: 红样本 A（0 条计划行）⇒ exit 2「不适用」，绝不等于通过', () => {
  const { dir } = makeRepo('plan-red');   // 夹具落点里没有 ledger.jsonl
  const r = runPlan(dir, {}, 'not-applicable');
  assert.equal(r.status, 2, `没有计划行 ⇒ 不适用；out=${r.stdout}`);
  assert.match(r.stdout, /PLAN_CHECK=not-applicable/);
  assert.match(r.stdout, /别把"没判"当"通过"/, '必须自曝"这不是通过"');
  assert.doesNotMatch(r.stdout, /PLAN_CHECK_RESULT=pass/);
});

test('计划③: 红样本 B（有计划行但过窗）⇒ 命中；observe 不阻断 / armed 阻断（档位与命中分开报）', () => {
  const { dir } = makeRepo('plan-stale', {
    // windowHours=0（夹具声明）⇒ 任何"严格更早"的计划行都算过窗，与现场时钟无关
    plan: { id: 'LF-PLAN-2', ts: () => '2020-01-01T00:00:00.000Z', problem: 'PLAN_DECLARED scope=**/*.mjs why=很久以前 criteria=…' },
  });
  const observed = runPlan(dir);
  assert.equal(observed.status, 0, `observe 档只记审计、不得阻断；out=${observed.stdout}`);
  assert.match(observed.stdout, /PLAN_FINDINGS=1/);
  assert.match(observed.stdout, /PLAN_CHECK_MODE=observe/);
  assert.match(observed.stdout, /PLAN_ARTIFACT_MISSING/, '必须点名"缺的是计划工件"');
  assert.match(observed.stdout, /observe-hit/, '读数要明说"命中了但不阻断"');

  const armed = runPlan(dir, { RULEKEEPER_PLAN_MODE: 'armed' });
  assert.equal(armed.status, 1, `armed 档必须阻断；out=${armed.stdout}`);
  assert.match(armed.stdout, /PLAN_CHECK_RESULT=fail/);
});

test('计划④: 没声明 `planScope` 的落点 ⇒ exit 2（口径由被治理仓声明，不硬编扩展名）', () => {
  const { dir } = makeRepo('plan-green', { plan: { id: 'x', ts: () => new Date().toISOString(), problem: 'PLAN_DECLARED' } });
  // 把 config.json 里的 planScope 拿掉 ⇒ 必须"不适用"，而不是"用默认清单判"
  const cfgPath = join(dir, '.dsh-ai', 'rulekeeper', 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  delete cfg.planScope;
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  const r = runPlan(dir, {}, 'not-applicable');
  assert.equal(r.status, 2);
  assert.match(r.stdout, /没声明 planScope\.codeGlobs/);
});

test('计划⑤: **诚实边界**必须打印（判不了"是否真先想过" / 声明不是签名 / 钩子只在提交时跑）', () => {
  const { dir } = makeRepo('plan-stale', {
    plan: { id: 'LF-PLAN-3', ts: () => '2020-01-01T00:00:00.000Z', problem: 'PLAN_DECLARED' },
  });
  const r = runPlan(dir, { RULEKEEPER_PLAN_MODE: 'armed' }, 'verdict');
  assert.match(r.stdout, /PLAN_CHECK_SELF_DISCLOSURE/);
  assert.match(r.stdout, /判不了"是否真先想过"|判不了/, '必须自曝它判不了意图');
  assert.match(r.stdout, /声明\*\*不是签名|不是签名/, '规则 43：自称型控制必须自曝');
  assert.match(r.stdout, /抓不到"已经动手了"|抓不到/, '必须自曝触发时机滞后');
});

test('计划⑥: 真仓（本仓未声明 planScope）⇒ exit 2，如实报"我没量到"而不是通过', () => {
  const r = runCheckerVerdict(CHECKER, { sampleDir: null, label: 'plan-artifact@真仓', expect: 'not-applicable' });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /PLAN_CHECK=not-applicable/);
  assert.doesNotMatch(r.stdout, /PLAN_CHECK_RESULT=pass/);
});

// ── 计划⑦~⑩：**静态样本**（`.plan-sample.json` 宣告时间线）—— 这是"能挂 spec/绑定"的前提 ─────────
// 背景（设计单 §9）：本检查器的结论依赖 **git 历史 + 落点配置** ⇒ 静态样本目录原本表达不出来
// ⇒ 硬造 spec 只能产出"看起来有判别力、实际没核过"的假绑定。现在样本可以**自己宣告时间线**：
// `{ files, now, plan:{id,ts}, armed?:true }`。

const FX = (name) => join(PKG_ROOT, 'test-fixtures', name);

test('计划⑦: 静态绿样本 ⇒ exit 0 / PLAN_FINDINGS=0 / pass', () => {
  const r = runCheckerVerdict(CHECKER, { sampleDir: FX('plan-fx-green'), label: 'plan-fx-green' });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /PLAN_FINDINGS=0/);
  assert.match(r.stdout, /PLAN_CHECK_RESULT=pass/);
});

test('计划⑧: 三个静态红样本 ⇒ exit 1 / PLAN_FINDINGS=1（各自的命中理由不同）', () => {
  const cases = [
    ['plan-fx-stale', /已过窗/],
    ['plan-fx-scoped', /晚于.*改动时刻|先做后补/],
    ['plan-fx-noplan', /没有任何计划行覆盖/],
  ];
  for (const [name, reason] of cases) {
    const r = runCheckerVerdict(CHECKER, { sampleDir: FX(name), label: name });
    assert.equal(r.status, 1, `${name} 必须红；out=${r.stdout}`);
    assert.match(r.stdout, /PLAN_FINDINGS=1/);
    assert.match(r.stdout, reason, `${name} 的命中理由必须点名`);
  }
});

test('计划⑨（护栏）: 样本宣告的时间线必须**自曝**，且真仓上不得出现该自曝', () => {
  const fx = runCheckerVerdict(CHECKER, { sampleDir: FX('plan-fx-green'), label: 'plan-fx-green' });
  assert.match(fx.stdout, /PLAN_CHECK_TIMELINE=fixture/, '用了样本宣告就必须自曝（否则它就是个后门）');
  assert.match(fx.stdout, /真台账行数按 0 计/, '必须说清"真台账没参与本次判定"');
  // 生产路径（真仓）不得出现 fixture 字样
  const real = runCheckerVerdict(CHECKER, { sampleDir: null, label: '真仓', expect: 'not-applicable' });
  assert.doesNotMatch(real.stdout, /fixture/, '真仓上不得出现样本宣告的痕迹（生产不读那个文件）');
});

test('计划⑩（护栏）: 样本的 `armed` 声明优先于环境变量，且只影响被检根内的判定', () => {
  // 红样本自带 armed:true ⇒ 即便显式把环境变量设成 observe，也必须 exit 1
  const r = spawnSync(process.execPath, [CHECKER], {
    cwd: PKG_ROOT, encoding: 'utf8',
    env: { ...process.env, RULEKEEPER_SAMPLE_DIR: FX('plan-fx-stale'), RULEKEEPER_PLAN_MODE: 'observe' },
  });
  assert.equal(r.status, 1, `样本宣告 armed 必须压过环境变量；out=${r.stdout}`);
  assert.match(r.stdout ?? '', /PLAN_CHECK_MODE=armed/);
});
