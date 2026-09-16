// dsh-rulekeeper · LF-410 **deny/warn + 软硬拦选型**用例
//
// 判据：绿 = deny 真阻断且原因可见 / warn 放行且原因可见；
//   红 = ① 误拦率 = 0 样本集（≥20 类正常操作全放行）② `--force-allow` 能翻我们判的 deny → 必红。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HARD_RULES, SOFT_RULES, combine, decide, falseBlockRate, normalOpsSamples, registerGuard, toHostDecision } from '../src/guard.mjs';

test('判据（绿·deny）: 硬拦真阻断，且**原因对模型可见**', () => {
  const r = decide({ rule: 'CRED', target: 'AGENTS.md' });
  assert.equal(r.level, 'deny');
  const host = toHostDecision(r);
  assert.equal(host.decision, 'deny');
  assert.match(host.reason, /硬拦/);
  assert.match(host.reason, /CRED/);
  assert.match(host.reason, /AGENTS\.md/);
});

test('判据（绿·warn）: 软拦放行，但原因同样可见（notes，而不是 decision）', () => {
  const r = decide({ rule: 'TAG', target: 'docs/x.md' });
  assert.equal(r.level, 'warn');
  const host = toHostDecision(r);
  assert.equal(host.decision, undefined);
  assert.equal(Array.isArray(host.notes), true);
  assert.match(host.notes[0], /软拦/);
});

test('判据（fail-closed 选型）: 受保护目标上的**未知**纪律 → deny；非保护目标 → warn', () => {
  assert.equal(decide({ rule: 'SOMETHING_NEW', target: 'AGENTS.md', protectedTarget: true }).level, 'deny');
  assert.equal(decide({ rule: 'SOMETHING_NEW', target: 'src/x.mjs', protectedTarget: false }).level, 'warn');
});

test('判据（单调不可翻）: combine 取最强档，顺序无关 —— 后面的 allow 翻不掉前面的 deny', () => {
  const deny = decide({ rule: 'CRED' });
  const allow = decide({ rule: 'TAG' }); // warn 也算"较弱"
  const a = combine([deny, allow]);
  const b = combine([allow, deny]);
  assert.equal(a.level, 'deny');
  assert.equal(b.level, 'deny');
  assert.equal(a.level, b.level, '合并结果与顺序无关');
  assert.match(a.reason, /#1\[deny\]/);
});

test('红（清单红态）: **`--force-allow` 能翻我们判的 deny → 必红**（我们有 force 字段就直接判红）', () => {
  const r = decide({ rule: 'CRED', extra: { forceAllow: true } });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.code === 'GUARD_FORCE_ALLOW_REJECTED'));
  // 而且**不能**把级别降下来：即使带 force，命中硬拦仍是 deny
  assert.equal(r.level, 'deny');
  // 各种别名一视同仁
  for (const k of ['force_allow', 'force', 'override', 'bypass']) {
    assert.equal(decide({ rule: 'CRED', extra: { [k]: true } }).ok, false, `${k} 也必须被判红`);
  }
  // 装配期就拒绝 forceAllow（比运行期忽略更安全）
  assert.throws(() => registerGuard({ effect: () => {}, tools: { guard: () => {} } }, { name: 'g', rule: 'CRED', forceAllow: true }), /forceAllow/);
});

test('红（清单红态）: **误拦率 = 0** —— ≥20 类正常操作必须全放行', () => {
  const samples = normalOpsSamples();
  assert.ok(samples.length >= 20, `样本数需 ≥20，实得 ${samples.length}`);
  const r = falseBlockRate(samples);
  assert.equal(r.total, samples.length);
  assert.equal(r.rate, 0, `误拦了: ${JSON.stringify(r.blocked)}`);
});

test('判据: 硬拦/软拦清单互斥且非空（选型表就是单一事实源）', () => {
  assert.ok(HARD_RULES.length >= 3);
  assert.ok(SOFT_RULES.length >= 3);
  for (const r of HARD_RULES) assert.equal(SOFT_RULES.includes(r), false, `${r} 不能同时在硬/软清单里`);
  assert.equal(new Set(HARD_RULES).size, HARD_RULES.length);
});

test('绿: registerGuard 优先用 tools.guard()，缺则退回 tools.register；都不支持 -> fail-fast', () => {
  const made = [];
  const guardCtx = { effect: (fn) => fn(), tools: { guard: (n, h) => made.push({ api: 'guard', n, h }) } };
  const g = registerGuard(guardCtx, { name: 'rulekeeper_gate', rule: 'CRED' });
  assert.equal(g.api, 'guard');
  assert.equal(made.length, 1);
  // handler 真能给出 deny 决策（模型可见原因）
  const d = made[0].h({ target: 'AGENTS.md' });
  assert.equal(d.decision, 'deny');
  assert.match(d.reason, /CRED/);

  const made2 = [];
  const regCtx = { effect: (fn) => fn(), tools: { register: (n, h) => made2.push({ n, h }) } };
  assert.equal(registerGuard(regCtx, { name: 'rulekeeper_gate', rule: 'TAG' }).api, 'register');
  assert.equal(made2.length, 1);
  assert.throws(() => registerGuard({ effect: () => {}, tools: {} }, { name: 'x' }), /tools\.guard\(\)/);
  assert.throws(() => registerGuard({ tools: { guard: () => {} } }, { name: 'x' }), /effect\(\)/);
});

test('判据: 受保护文件**已留证**时放行（不能因为"动过保护面"就一律拦）', () => {
  const r = decide({ rule: 'PROTECTED_WRITE', target: 'AGENTS.md', protectedTarget: true, evidence: true });
  assert.equal(r.level, 'allow');
  assert.ok(r.findings.some((f) => f.code === 'GUARD_ALLOWED_WITH_EVIDENCE'));
});

test('判据: 空输入 combine 不炸（给 allow + 说明），显式判定缺失不该表现为 deny', () => {
  const r = combine([]);
  assert.equal(r.level, 'allow');
  assert.match(r.reason, /空输入/);
});
