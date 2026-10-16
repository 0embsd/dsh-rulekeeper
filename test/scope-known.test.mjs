// dsh-rulekeeper · **声明面 vs 消费面漂移**守卫（2026-10-16 加）
//
// 为什么加（真事故，不是假想）：
//   `scripts/checkers/misreport-surface.spec.json` 自 **2026-09-28（N-B4 搬迁改造）**起把
//   `applicability.scope` 由 `plugin-repo-only` 改成 `any-with-checker-bindings`，
//   但 `src/effect.mjs` 的 `KNOWN_CHECKER_SCOPES` **没跟着加** ⇒ 引擎此后一直判 `unknown-scope`：
//     · 该判据在**插件自己的仓**上也报"不适用"（判据⑤ 红）
//     · 私有非插件落点上给出的理由是 `unknown-scope` 而非 `not-applicable`（判据④ 红）
//   全量实测：**2026-09-26 之后连续 8 次推送全红**，直到 2026-10-16 才被定位（953/948/4 → 953/952/0）。
//   漂移能漂两周，是因为**没有任何机械读者**把"随包规格声明的 scope"与"引擎的已知表"对起来。
//
// 判据（可复跑，规则 42；锚**被测对象自身**，规则 41）：
//   ① 随包规格里出现的每个 scope ⇒ 必须 ∈ `KNOWN_CHECKER_SCOPES`（否则引擎只能如实说"不认识"）
//   ② 随包规格的 scope 不得为空 ⇒ 不得进 `undeclared`
//   ③ 若某 scope 落到 `unassessed`（引擎如实边界：本轮未机械评估）⇒ **打印出来**（不判红，但可见）
//
// 边界（如实）：本用例只覆盖**随包** `scripts/checkers/*.spec.json`；项目侧落点自带的规格
//   （`config.specDirs` 声明）不在本仓面内，天然测不到 —— 那一侧由落点自己的体检负责。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { KNOWN_CHECKER_SCOPES, checkerScopeVerdict } from '../src/effect.mjs';
import { PKG_ROOT } from './helpers/sandbox.mjs';

const SPEC_DIR = join(PKG_ROOT, 'scripts', 'checkers');

/** 读随包规格：形状不合法如实列出，不静默跳过（跳过 ≠ 通过） */
function shippedSpecs() {
  const out = [];
  const bad = [];
  for (const name of readdirSync(SPEC_DIR).filter((n) => n.endsWith('.spec.json'))) {
    const rel = `scripts/checkers/${name}`;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(SPEC_DIR, name), 'utf8'));
    } catch (error) {
      bad.push({ rel, why: `JSON 解析失败: ${String(error?.message ?? error)}` });
      continue;
    }
    const scope = parsed?.applicability?.scope;
    out.push({ rel, rule: parsed?.rule ?? null, scope: typeof scope === 'string' ? scope.trim() : scope });
  }
  return { specs: out, bad };
}

test('守卫①: 随包规格声明的 scope 必须都在 KNOWN_CHECKER_SCOPES 里（漂移即红）', () => {
  const { specs, bad } = shippedSpecs();
  assert.equal(bad.length, 0, `随包规格里有无法解析的件：${bad.map((b) => `${b.rel}（${b.why}）`).join('；')}`);
  assert.ok(specs.length > 0, '一个随包规格都没扫到 ⇒ 本判据会变成空转（fail-closed，不放过）');

  const unknown = [];
  const undeclared = [];
  const unassessed = [];
  for (const s of specs) {
    if (s.scope === undefined || s.scope === null || s.scope === '') {
      undeclared.push(s.rel);
      continue;
    }
    if (!KNOWN_CHECKER_SCOPES.includes(s.scope)) {
      unknown.push(`${s.rel}（rule=${s.rule}）声明 scope=${s.scope}`);
      continue;
    }
    // 已知取值 ⇒ 再问一次引擎自己怎么判（防止"表里有、分支没有"这种半漂移）
    const v = checkerScopeVerdict(s.scope, { repoKind: 'private', isPluginRepo: false, hasCheckerBindings: false });
    if (v.verdict === 'unassessed') unassessed.push(`${s.rel}（scope=${s.scope}）`);
  }

  if (unassessed.length > 0) {
    // 不判红（引擎的"未评估"是如实边界），但**必须可见**
    console.log(`  ℹ 引擎对下列 scope 如实落"未评估"（有声明、无机械判据）：${unassessed.join('；')}`);
  }
  assert.deepEqual(undeclared, [], `规格未声明 applicability.scope ⇒ 引擎只能判 undeclared：${undeclared.join('；')}`);
  assert.deepEqual(unknown, [],
    `规格声明的 scope 不在引擎已知表里 ⇒ 引擎会一直判 unknown-scope（这正是本仓 2026-09-28→10-16 的漂移）：` +
    `${unknown.join('；')}。修法二选一：把它加进 src/effect.mjs 的 KNOWN_CHECKER_SCOPES **并实现其判定**，或改规格用已知取值。`);
});

test('守卫②: 本检查器认得的那条真规格（misreport-surface）必须被判"适用/不适用"，不得 unknown', () => {
  const rel = 'scripts/checkers/misreport-surface.spec.json';
  const parsed = JSON.parse(readFileSync(join(PKG_ROOT, rel), 'utf8'));
  const scope = parsed.applicability.scope;
  assert.ok(KNOWN_CHECKER_SCOPES.includes(scope), `${rel} 的 scope=${scope} 必须在已知表里`);

  // 插件包根 ⇒ 适用（判据⑤ 的同一口径）
  assert.equal(checkerScopeVerdict(scope, { repoKind: 'private', isPluginRepo: true, hasCheckerBindings: false }).verdict,
    'applicable', '插件自己的仓上该判据必须适用');
  // 私有非插件落点且零 checker 绑定 ⇒ 不适用（理由必须带两边事实）
  const na = checkerScopeVerdict(scope, { repoKind: 'private', isPluginRepo: false, hasCheckerBindings: false, checkerBindingsCount: 0 });
  assert.equal(na.verdict, 'not-applicable', '私有非插件落点且零绑定 ⇒ 必须判"不适用"');
  assert.match(na.reason, /any-with-checker-bindings/, '理由里必须出现**声明面**的事实');
  assert.match(na.reason, /0 条/, '理由里必须出现**落点面**的事实（绑定条数），否则读者无法核对');
});
