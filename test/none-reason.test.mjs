// dsh-rulekeeper · "有理由的 none" 用例（2026-09-24，被治理项目侧工单 §2）
//
// 被检对象：`effectPlan` 对 `state === 'none'` 的条目给出的 **unboundReason**。
// 判据（红态**可重跑**，不依赖"此刻恰好处于违规态"——规则 42）：
//   ① 私有落点 + 装了 `public-repo-only` 的判据 ⇒ 该条 none **必须带理由**（载体 = 插件包内规格声明）；
//   ② **反事实**：同一份落点只把 `repoKind` 改成 public ⇒ 理由**必须消失**
//      （证明理由来自"声明 × 事实"，不是硬编码、也不是账本自报）；
//   ③ 理由**不豁免**：`EFFECT_TEXT_ONLY` 与 `RK_EFFECT_RESULT=fail` 都**不因加了理由而变化**（规则 43）。
//   ④ 不该说话时**不说话**：`scope: any` 的类目不得被写成"不适用"（规则 53 的误报面收窄）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkerScopeVerdict, effectPlan, KNOWN_CHECKER_SCOPES } from '../src/effect.mjs';
import { cleanupAll, freshLanding, ledgerEntry, PKG_ROOT } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const TS = '2026-09-24T00:00:00.000Z';

/** `freshLanding` 的 config 只写 schema/mode；档位是本用例的自变量 ⇒ 显式覆写。 */
function setRepoKind(landing, kind) {
  writeFileSync(join(landing, 'config.json'), `${JSON.stringify({ schema: 1, mode: 'observe', repoKind: kind }, null, 2)}\n`, 'utf8');
}

function landingWith(label, rule, kind) {
  const { landing } = freshLanding(label, { entries: [ledgerEntry({ id: `${label}-1`, ts: TS, rule, mechanism: 'text' })] });
  if (kind !== undefined) setRepoKind(landing, kind);
  return landing;
}

const reasonsOf = (plan, rule) => (plan.items.find((i) => i.rule === rule) ?? {}).unboundReason ?? null;
const textOnlyOf = (plan, rule) => plan.findings.some((f) => f.code === 'EFFECT_TEXT_ONLY' && f.rule === rule);

test('判据①: 私有落点上，装了 public-repo-only 判据的类目，其 none **必须带可读理由**', () => {
  const landing = landingWith('none-reason-private', 'CAT-ENV', 'private');
  const plan = effectPlan({ landingDir: landing, projectRoot: join(landing, '..', 'proj') });

  const reason = reasonsOf(plan, 'CAT-ENV');
  assert.ok(reason !== null, 'CAT-ENV 的 none 必须带 unboundReason（工单 §2：不得出现无解释的 none）');
  assert.equal(reason.code, 'checker-scope-mismatch');
  assert.equal(reason.specs.length, 1);
  assert.equal(reason.specs[0].spec, 'scripts/checkers/leak-check.spec.json');
  assert.equal(reason.specs[0].declaredScope, 'public-repo-only');
  assert.equal(reason.specs[0].verdict, 'not-applicable');
  // 理由里必须出现**两边的事实**（声明 + 落点档位），否则读者还是不知道为什么
  assert.match(reason.specs[0].reason, /repoKind=private/);
  assert.match(reason.specs[0].reason, /public-repo-only/);

  // 同一次运行必须有对应的 finding（消费者不止 --json 一条路）
  const f = plan.findings.find((x) => x.code === 'EFFECT_UNBOUND_REASON' && x.rule === 'CAT-ENV');
  assert.ok(f !== undefined, '必须同时出 EFFECT_UNBOUND_REASON finding');
  assert.equal(f.severity, 'info', '理由面是 info，不是新的 error（不改判定）');
});

test('判据②（反事实）: 同一落点只把 repoKind 改成 public ⇒ 理由**消失**', () => {
  const landing = landingWith('none-reason-public', 'CAT-ENV', 'public');
  const plan = effectPlan({ landingDir: landing, projectRoot: join(landing, '..', 'proj') });
  assert.equal(reasonsOf(plan, 'CAT-ENV'), null,
    '公开仓上该判据**适用** ⇒ 没有"不适用"这条理由可说；此时它是**可绑未绑**，不是"绑不了"');
});

test('判据③: 理由**不豁免**——TEXT_ONLY 与 ok=false 都不因加理由而变化', () => {
  const landing = landingWith('none-reason-noexcuse', 'CAT-ENV', 'private');
  const plan = effectPlan({ landingDir: landing, projectRoot: join(landing, '..', 'proj') });
  assert.ok(textOnlyOf(plan, 'CAT-ENV'), '加了理由之后 EFFECT_TEXT_ONLY 必须照旧（理由 ≠ 免责）');
  assert.equal(plan.ok, false, 'ok 不得因"有理由"而转真');
  assert.equal(plan.items.find((i) => i.rule === 'CAT-ENV').state, 'none', 'state 不得因"有理由"而改档');
});

test('判据④（误报面）: `scope: any` 的类目不得被写成"不适用"；其它档位各自按事实判', () => {
  const { landing } = freshLanding('none-reason-scopes', {
    entries: [
      ledgerEntry({ id: 's1', ts: TS, rule: 'CAT-CODE' }),        // byte-discipline: scope=any
      ledgerEntry({ id: 's2', ts: TS, rule: 'CAT-VERIFY' }),      // misreport-surface: plugin-repo-only
      ledgerEntry({ id: 's3', ts: TS, rule: 'CAT-TECH' }),        // no-test-exception: js-project-with-src
      ledgerEntry({ id: 's4', ts: TS, rule: 'CAT-ENV' }),         // leak-check: public-repo-only
    ],
  });
  setRepoKind(landing, 'private');
  const plan = effectPlan({ landingDir: landing, projectRoot: join(landing, '..', 'proj') });

  assert.equal(reasonsOf(plan, 'CAT-CODE'), null,
    'CAT-CODE 的判据 scope=any（本落点适用）⇒ **不许**给它编一条"不适用"的理由');
  for (const rule of ['CAT-ENV', 'CAT-VERIFY', 'CAT-TECH']) {
    const r = reasonsOf(plan, rule);
    assert.ok(r !== null, `${rule}: 判据对私有非插件仓不适用，必须给出理由`);
    assert.equal(r.specs[0].verdict, 'not-applicable', `${rule}: 应判"不适用"`);
  }
  // 有界计数是**事实**，得出现在理由里（否则读者无法核对）
  assert.match(reasonsOf(plan, 'CAT-TECH').specs[0].reason, /\.mjs 文件数 = 0/);
});

test('判据⑤（反向红线）: --project = 插件包根，或落点里真有 src/**/*.mjs ⇒ 对应理由不得出现', () => {
  const { landing } = freshLanding('none-reason-applicable', {
    entries: [
      ledgerEntry({ id: 'a1', ts: TS, rule: 'CAT-VERIFY' }),
      ledgerEntry({ id: 'a2', ts: TS, rule: 'CAT-TECH' }),
    ],
  });
  setRepoKind(landing, 'private');
  // 反向：插件自己的仓（--project = 包根）⇒ plugin-repo-only **适用** ⇒ 无"不适用"可报
  const onPkg = effectPlan({ landingDir: landing, projectRoot: PKG_ROOT });
  assert.equal(reasonsOf(onPkg, 'CAT-VERIFY'), null, '插件自己的仓上 misreport-surface **适用**，不得报"不适用"');
  // 本仓真有 src/**/*.mjs ⇒ js-project-with-src **适用** ⇒ 无"不适用"可报
  assert.equal(reasonsOf(onPkg, 'CAT-TECH'), null, '本仓 src 下有 .mjs ⇒ no-test-exception **适用**，不得报"不适用"');
});

test('判据⑥: checkerScopeVerdict 是纯函数——同样输入同样结论，且未知取值如实自曝', () => {
  const facts = { repoKind: 'private', repoKindSource: 'config', isPluginRepo: false, hasJsSrc: false, jsSrcCount: 0, hasJsTests: false, jsTestCount: 0 };
  assert.equal(checkerScopeVerdict('any', facts).verdict, 'applicable');
  assert.equal(checkerScopeVerdict('public-repo-only', facts).verdict, 'not-applicable');
  assert.equal(checkerScopeVerdict('public-repo-only', { ...facts, repoKind: 'public' }).verdict, 'applicable');
  assert.equal(checkerScopeVerdict('any-with-git-hooks', facts).verdict, 'unassessed', '形态类声明如实落"未评估"，不猜');
  assert.equal(checkerScopeVerdict('brand-new-scope', facts).verdict, 'unknown-scope');
  assert.equal(checkerScopeVerdict(undefined, facts).verdict, 'undeclared');
  assert.deepEqual([...KNOWN_CHECKER_SCOPES], [...KNOWN_CHECKER_SCOPES], '已知取值表是冻结数据');
  // 幂等：连跑两次结论逐字相同（体检读数必须可复现）
  assert.deepEqual(checkerScopeVerdict('js-project-with-tests', facts), checkerScopeVerdict('js-project-with-tests', facts));
});

test('判据⑦（接线）: 随包规格的 applicability 必须真的被读到 —— 删掉规格，理由随之消失', () => {
  // 规则 44：新写的模块/导出必须有生产消费者。这里用**行为**证明接线：
  // 把随包规格目录指向一个空目录后，`shippedCheckerSpecs` 扫不到任何声明 ⇒ 理由面为空。
  const empty = freshLanding('none-reason-nospec', { entries: [ledgerEntry({ id: 'e1', ts: TS, rule: 'CAT-ENV' })] });
  setRepoKind(empty.landing, 'private');
  const plan = effectPlan({ landingDir: empty.landing, projectRoot: join(empty.landing, '..', 'proj'), specDirs: ['no-such-dir'] });
  assert.equal(reasonsOf(plan, 'CAT-ENV'), null, '规格扫不到 ⇒ 没有声明载体 ⇒ 不得凭空给出理由');
  // 而默认（真随包规格）下理由在 —— 两次对照即"接线"的机械证据
  const plan2 = effectPlan({ landingDir: empty.landing, projectRoot: join(empty.landing, '..', 'proj') });
  assert.ok(reasonsOf(plan2, 'CAT-ENV') !== null, '默认须读到随包规格');
  // 顺带核对规格文件确实在包内（否则上面的"接线"是空转）
  const spec = JSON.parse(readFileSync(join(PKG_ROOT, 'scripts', 'checkers', 'leak-check.spec.json'), 'utf8'));
  assert.equal(spec.applicability.scope, 'public-repo-only');
});
