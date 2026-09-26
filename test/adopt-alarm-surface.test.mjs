// dsh-rulekeeper · **项目侧报警器面**用例（2026-09-26，契约扩展位 `config.specDirs`）
//
// 要解决的问题（被治理项目侧实测）：`adopt` 默认只扫 `scripts/checkers` 与 `tools/rulekeeper/checkers`，
// 项目把自己的报警器放在别处时，插件**完全看不见** ⇒ 只能喊"没绑定"，说不出
// "**你仓里已经有东西在拦它，只是没按规则登记**" ⇒ 人被告警推着去**重装已经装过的报警器**。
//
// 本文件的判据（成对，缺一不算）：
//   ① **归属标签**：规格按**目录自己的事实**标 `origin`（有 `*.spec.json` ⇒ plugin；否则 project；
//      `config.specDirs` 声明的目录 ⇒ 一律 project）；
//   ② **看得见**：声明 `specDirs` 后，项目侧报警器进 `RK_ADOPT_ALARM_*` 与逐条 `RK_ADOPT_ALARM`，
//      且未绑定的那条**能出绑定草稿**（这就是"廉价路"的机械面）；
//   ③ **不加覆盖**（假覆盖红线）：加了项目侧报警器之后，`RK_ADOPT_ENTRIES` / `RK_ADOPT_FACE` /
//      `RK_EFFECT_ENTRY_ACTIVATION` **逐字不变**；
//   ④ **不影响判定**：`rk-effect plan` 的 `NONE/VERIFIED/TEXT_ONLY/UNBOUND_REASON` 与退出码**逐字不变**；
//   ⑤ **不写回**：`adopt` 跑完 `ledger.jsonl` 与 `rules.json` 逐字节不变；
//   ⑥ **配置形状**：`specDirs` 只收项目根相对目录，绝对路径 / `..` 一律判错（不静默接受）；
//   ⑦ **零回归**：未声明 `specDirs` ⇒ 看不见那个目录（不偷偷扩大扫描面）；
//   ⑧ **实证必填**：缺 `evidence` / 实证路径不存在 ⇒ warn，且**不算带实证**（`with/without` 分开报）；
//   ⑨ **严重度按声明读**：只有 warn 时 `adopt` 的 rc 必须是 0（老启发式"有 rule 字段 ⇒ error"已废）；
//   ⑩ **正对照**：实证齐全 ⇒ 没有实证类 finding，且 `without=0`。
//
// 反向红：把 `origin` 一律写成 'plugin' ⇒ ① 红；把 alarmSpecs 并进 faceCount ⇒ ③ 红；
//        把 `severityOf` 换回"有 rule 即 error" ⇒ ⑨ 红。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { adoptionReport, scanSpecs } from '../src/adopt.mjs';
import { declaredSpecDirs, validateConfig } from '../src/config.mjs';
import { effectPlan } from '../src/effect.mjs';
import { cleanupAll, freshProjectLanding, ledgerEntry, PKG_ROOT } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const TS = '2026-09-26T00:00:00.000Z';
const EFFECT = join(PKG_ROOT, 'bin', 'rk-effect.mjs');

/** 造一份"像规格"的项目侧报警器（形状与 `scripts/checkers/*.spec.json` 同族） */
function alarmSpec({ rule, cmd = ['node', 'tools/rulekeeper/alarms/check.mjs'], evidence }) {
  const spec = {
    schema: 1,
    rule,
    command: cmd,
    expectRed: { exitCode: 1 },
    expectGreen: { exitCode: 0 },
    redSample: { kind: 'tree', source: 'tools/rulekeeper/fixtures/red' },
    greenSample: { kind: 'tree', source: '.' },
    checkerVersion: 'alarm@1',
    timeoutMs: 20000,
  };
  if (evidence !== undefined) spec.evidence = evidence;
  return spec;
}

/**
 * 场景：`<proj>/.dsh-ai/rulekeeper` 落点 + `<proj>/tools/rulekeeper/alarms/` 报警器目录。
 * `declare` = 是否在 `config.json` 里声明 `specDirs`。
 */
function scene(label, { declare = true, alarms = [], extraConfig = {} } = {}) {
  const { projectRoot, landing } = freshProjectLanding(label, {
    entries: [
      ledgerEntry({ id: `${label}-1`, ts: TS, rule: 'CAT-X', mechanism: 'text' }),
      ledgerEntry({ id: `${label}-2`, ts: TS, rule: 'CAT-Y', mechanism: 'text' }),
    ],
  });
  const dir = join(projectRoot, 'tools', 'rulekeeper', 'alarms');
  mkdirSync(dir, { recursive: true });
  for (const [name, spec] of alarms) writeFileSync(join(dir, name), `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
  const cfg = { schema: 1, mode: 'observe', ...extraConfig };
  if (declare) cfg.specDirs = ['tools/rulekeeper/alarms'];
  writeFileSync(join(landing, 'config.json'), `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  return { projectRoot, landing, alarmDir: dir };
}

const runAdoptCli = (landing, projectRoot) => {
  const res = spawnSync(process.execPath, [EFFECT, 'adopt', '--landing', landing, '--project', projectRoot], { encoding: 'utf8' });
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
};

test('判据①: 归属标签按目录自己的事实给（.spec.json ⇒ plugin；否则 / config 声明 ⇒ project）', () => {
  const { projectRoot } = scene('alarm-origin', { declare: false, alarms: [['a.json', alarmSpec({ rule: 'CAT-X' })]] });
  // 把报警器目录**显式当 projectDirs** 传进来 ⇒ 必须标 project（哪怕目录里放了 .spec.json）
  const { specs } = scanSpecs(projectRoot, { dirs: ['tools/rulekeeper/alarms'], projectDirs: ['tools/rulekeeper/alarms'] });
  assert.equal(specs.length, 1);
  assert.equal(specs[0].origin, 'project', '显式声明的目录一律 project');

  // 反向：本包自己的 `scripts/checkers` 里有 `*.spec.json` ⇒ 必须标 plugin
  const own = scanSpecs(join(PKG_ROOT), { dirs: ['scripts/checkers'] });
  assert.ok(own.specs.length > 0, '本包 scripts/checkers 下应当有规格');
  assert.equal(own.specs.every((s) => s.origin === 'plugin'), true,
    '含 `*.spec.json` 的目录 = 插件自身的规格目录 ⇒ 必须标 plugin（否则"项目侧报警器"计数会被自己的规格灌满）');
});

test('判据②: 声明 specDirs 后，项目侧报警器**看得见**；未绑定的那条能出绑定草稿', () => {
  const { landing, projectRoot } = scene('alarm-visible', {
    alarms: [
      ['bound-ish.json', alarmSpec({ rule: 'CAT-PROC' })],
      ['free.json', alarmSpec({ rule: 'CAT-X', evidence: ['tools/rulekeeper/fixtures/red/x'] })],
    ],
  });
  // 把 CAT-PROC 真的绑成一条 checker（否则"已绑"这一支测不到：fixtures 的 rules-ok.json 里
  // `checks` 是**裸字符串**形态，没有 kind:"checker" ⇒ boundCheckerRules 为空）
  writeFileSync(join(landing, 'rules.json'), `${JSON.stringify({
    schema: 1,
    project: 'proj',
    protected_paths: ['AGENTS.md'],
    gates: [],
    checks: [{
      kind: 'checker',
      rule: 'CAT-PROC',
      command: ['node', 'tools/rulekeeper/alarms/bound-ish.json'],
      expectRed: { exitCode: 1 },
      expectGreen: { exitCode: 0 },
      redSample: { kind: 'tree', source: 'tools/rulekeeper/fixtures/red' },
      greenSample: { kind: 'tree', source: '.' },
    }],
    inject: [],
  }, null, 2)}\n`, 'utf8');

  const r = adoptionReport({ landingDir: landing, projectRoot, specDirs: declaredSpecDirs(landing), now: new Date(TS) });
  const projectPlans = r.plans.filter((p) => p.origin === 'project');
  assert.equal(projectPlans.length, 2, '两条项目侧报警器都要进 plans（并标 origin=project）');
  assert.equal(r.stats.alarmSpecs, 2);
  assert.equal(r.stats.alarmUnbound, 1, 'CAT-X 在 rules.json 里没绑 checker ⇒ 记 UNBOUND');
  assert.equal(r.stats.alarmBound, 1, 'CAT-PROC 已绑（本用例显式绑的）⇒ 记 BOUND');
  assert.equal(r.stats.pluginSpecs, 0, '本场景没有插件随包规格');
  const drafted = r.drafts.map((d) => d.rule);
  assert.deepEqual(drafted, ['CAT-X'], `未绑定的项目侧报警器必须产草稿；实得 ${JSON.stringify(drafted)}`);
  assert.equal(r.drafts.some((d) => d.rule === 'CAT-PROC'), false, '已绑定的不得再出草稿');
});

test('判据③（假覆盖红线）: 项目侧报警器**不得**改变 entries / faceCount / 覆盖率', () => {
  const bare = scene('alarm-nocover-a', { declare: false, alarms: [] });
  const withAlarms = scene('alarm-nocover-b', {
    alarms: [['a.json', alarmSpec({ rule: 'CAT-X' })], ['b.json', alarmSpec({ rule: 'CAT-Y' })]],
  });
  const r1 = adoptionReport({ landingDir: bare.landing, projectRoot: bare.projectRoot, specDirs: [], now: new Date(TS) });
  const r2 = adoptionReport({
    landingDir: withAlarms.landing, projectRoot: withAlarms.projectRoot,
    specDirs: declaredSpecDirs(withAlarms.landing), now: new Date(TS),
  });
  assert.equal(r2.stats.entries, r1.stats.entries, '项目侧报警器不得改变账本条目数');
  assert.deepEqual(r2.stats.faceCount, r1.stats.faceCount, '**不得**把报警器并进机制面计数（那正是"假覆盖"）');
  assert.equal(r2.stats.alarmSpecs, 2, '它只能体现在自己的那三个平行读数里');

  const p1 = effectPlan({ landingDir: bare.landing, projectRoot: bare.projectRoot, now: new Date(TS), specDirs: [] });
  const p2 = effectPlan({ landingDir: withAlarms.landing, projectRoot: withAlarms.projectRoot, now: new Date(TS) });
  assert.equal(p2.entryStats.withActivation, p1.entryStats.withActivation, '条目级激活**不得**因报警器而涨');
  assert.equal(p2.entryStats.coverage, p1.entryStats.coverage);
});

test('判据④: `plan` 的判定与退出码**逐字不变**（报警器只影响 adopt 的读数）', () => {
  const { landing, projectRoot } = scene('alarm-plan-neutral', {
    alarms: [['a.json', alarmSpec({ rule: 'CAT-X' })], ['b.json', alarmSpec({ rule: 'CAT-Y' })], ['c.json', alarmSpec({ rule: 'CAT-PROC' })]],
  });
  const before = effectPlan({ landingDir: landing, projectRoot, now: new Date(TS), specDirs: [] });
  const after = effectPlan({ landingDir: landing, projectRoot, now: new Date(TS) });
  const strip = (p) => ({
    counts: p.counts,
    ok: p.ok,
    entries: p.entryStats.entries,
    withActivation: p.entryStats.withActivation,
    findings: p.findings.map((f) => `${f.code}|${f.rule ?? '-'}`).sort(),
    items: p.items.map((i) => `${i.rule}|${i.state}|${i.entries}|${i.unboundReason === null ? '-' : 'R'}`).sort(),
  });
  assert.deepEqual(strip(after), strip(before),
    '`plan` 不得因项目侧报警器而变（它读的是 rules.json / 注解层 / 快照，不是项目自报的报警器）');
});

test('判据⑤（不写回）: `adopt` 跑完 `ledger.jsonl` 与 `rules.json` 逐字节不变', () => {
  const { landing, projectRoot } = scene('alarm-readonly', { alarms: [['a.json', alarmSpec({ rule: 'CAT-X' })]] });
  const ledgerBefore = readFileSync(join(landing, 'ledger.jsonl'));
  const rulesBefore = readFileSync(join(landing, 'rules.json'));
  adoptionReport({ landingDir: landing, projectRoot, specDirs: declaredSpecDirs(landing), now: new Date(TS) });
  assert.deepEqual(readFileSync(join(landing, 'ledger.jsonl')), ledgerBefore, '账本必须逐字节不变（`mechanism` 不许回填）');
  assert.deepEqual(readFileSync(join(landing, 'rules.json')), rulesBefore, 'rules.json 必须逐字节不变');
});

test('判据⑥: `specDirs` 只收项目根相对目录；绝对路径 / `..` / 非数组一律判错', () => {
  const ok = validateConfig({ schema: 1, mode: 'observe', specDirs: ['tools/rulekeeper/alarms'] });
  assert.deepEqual(ok, [], `合法声明不该报错；实得 ${JSON.stringify(ok)}`);
  for (const bad of [['C:/abs/dir'], ['/abs/dir'], ['tools/../etc'], ['tools/x', ''], 'tools/x', [1, 2]]) {
    const out = validateConfig({ schema: 1, mode: 'observe', specDirs: bad });
    assert.equal(out.some((m) => m.includes('specDirs')), true,
      `非法 specDirs=${JSON.stringify(bad)} 必须被判错（不静默接受）`);
  }
  const { landing } = scene('alarm-badcfg', { declare: false });
  writeFileSync(join(landing, 'config.json'), `${JSON.stringify({ schema: 1, mode: 'observe', specDirs: ['C:/abs'] }, null, 2)}\n`, 'utf8');
  assert.deepEqual(declaredSpecDirs(landing), [], '绝对路径必须被读侧拒掉（坏值不抛，但也绝不假装读到了）');
  assert.equal(validateConfig(JSON.parse(readFileSync(join(landing, 'config.json'), 'utf8'))).length > 0, true, '同时必须能被校验器判错');
});

test('判据⑦: 未声明 `specDirs` ⇒ 默认面不变（老落点零回归）', () => {
  const { landing, projectRoot } = scene('alarm-default', { declare: false, alarms: [['a.json', alarmSpec({ rule: 'CAT-X' })]] });
  assert.deepEqual(declaredSpecDirs(landing), [], '未声明 ⇒ 空');
  const r = adoptionReport({ landingDir: landing, projectRoot, specDirs: declaredSpecDirs(landing), now: new Date(TS) });
  assert.equal(r.stats.alarmSpecs, 0, '未声明时**看不见**那个目录（行为与改动前一致：不偷偷扩大扫描面）');
  assert.equal(r.stats.specs, 0);
});

test('判据⑧（实证必填）: 缺实证 / 实证路径不存在 ⇒ warn，且**不算带实证**；有实证的作正对照', () => {
  const { landing, projectRoot, alarmDir } = scene('alarm-evidence', {
    alarms: [
      ['none.json', alarmSpec({ rule: 'CAT-X' })],                                                  // 缺 evidence
      ['ghost.json', alarmSpec({ rule: 'CAT-Y', evidence: ['tools/rulekeeper/fixtures/ghost'] })],  // 指向不存在的路径
    ],
  });
  // 造一条**真存在**的实证：证明这不是"永远报 warn"的装饰
  mkdirSync(join(projectRoot, 'tools', 'rulekeeper', 'fixtures', 'red'), { recursive: true });
  writeFileSync(join(projectRoot, 'tools', 'rulekeeper', 'fixtures', 'red', 'x.md'), '# 违规样本\n', 'utf8');
  writeFileSync(join(alarmDir, 'ok.json'), `${JSON.stringify(alarmSpec({ rule: 'CAT-Z', evidence: ['tools/rulekeeper/fixtures/red/x.md'] }), null, 2)}\n`, 'utf8');

  const r = adoptionReport({ landingDir: landing, projectRoot, specDirs: declaredSpecDirs(landing), now: new Date(TS) });
  const byCode = (c) => r.findings.filter((f) => f.code === c).map((f) => f.rule);
  assert.deepEqual(byCode('ADOPT_ALARM_NO_EVIDENCE'), ['CAT-X'], '缺 evidence ⇒ 报 NO_EVIDENCE（只报缺的那个）');
  assert.deepEqual(byCode('ADOPT_ALARM_EVIDENCE_MISSING'), ['CAT-Y'], '实证路径不存在 ⇒ 报 EVIDENCE_MISSING');
  assert.equal(r.stats.alarmSpecs, 3);
  assert.equal(r.stats.alarmWithEvidence, 1, '只有实证**逐项解析得到**的那条算带实证');
  assert.equal(r.ok, true, 'warn 不得让 adopt 判失败');
  assert.equal(r.plans.find((p) => p.rule === 'CAT-X').evidence, null, '没实证的条目 evidence 必须是 null（不许拿"写了字段"当实证）');
  assert.deepEqual(r.plans.find((p) => p.rule === 'CAT-Z').evidence, ['tools/rulekeeper/fixtures/red/x.md'], '有实证的条目要带出**可复核实证本身**');
});

test('判据⑨（CLI 面）: 实证 warn **打出来**，且**不得**把 `adopt` 判成 fail（rc=0）', () => {
  // 为什么单列一条：`adopt` 的 rc 老口径是"有没有 `rule` 字段 ⇒ error"，而实证 warn **也带 rule**
  // ⇒ 老启发式把"只是提醒补实证"读成了失败（启发式判严重度 = 判据错位）。本用例钉住新口径。
  const { landing, projectRoot } = scene('alarm-cli', { alarms: [['a.json', alarmSpec({ rule: 'CAT-X' })]] });
  const { status, out } = runAdoptCli(landing, projectRoot);
  assert.equal(status, 0, `只有 warn ⇒ rc 必须是 0；实得 ${status}\n${out}`);
  assert.match(out, /FINDING ADOPT_ALARM_NO_EVIDENCE warn CAT-X/, `实证 warn 必须打出来且标明 severity；out=${out}`);
  assert.match(out, /RK_ADOPT_ALARM_EVIDENCE with=0 without=1/, `实证面读数必须在；out=${out}`);
  assert.match(out, /RK_ADOPT_ALARM_SPECS=1 BOUND=0 UNBOUND=1/, `报警器面读数必须在；out=${out}`);
  assert.match(out, /RK_ADOPT_SPEC_DIRS declared=tools\/rulekeeper\/alarms/, `声明的目录必须打出来（便于核对前件）；out=${out}`);
});

test('判据⑩（正对照）: 实证齐全时**没有** ADOPT_ALARM_* finding，且 `without=0`', () => {
  const { landing, projectRoot, alarmDir } = scene('alarm-cli-ok', { alarms: [] });
  mkdirSync(join(projectRoot, 'tools', 'rulekeeper', 'evidence'), { recursive: true });
  writeFileSync(join(projectRoot, 'tools', 'rulekeeper', 'evidence', 'red.log'), 'hit\n', 'utf8');
  writeFileSync(join(alarmDir, 'ok.json'), `${JSON.stringify(alarmSpec({ rule: 'CAT-X', evidence: ['tools/rulekeeper/evidence/red.log'] }), null, 2)}\n`, 'utf8');
  const { status, out } = runAdoptCli(landing, projectRoot);
  assert.equal(status, 0, `实得 ${status}\n${out}`);
  assert.equal(/FINDING ADOPT_ALARM_/.test(out), false, `实证齐全时不得报实证类 finding；out=${out}`);
  assert.match(out, /RK_ADOPT_ALARM_EVIDENCE with=1 without=0/, `正对照：with 必须为 1；out=${out}`);
});
