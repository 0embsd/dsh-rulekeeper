// dsh-rulekeeper · 方案"乙"用例：**按会话隔离的提醒投递**（2026-09-20 根治 last-writer-wins）
//
// 要钉住的判据：
//   ①每个会话的 provider 只投**它自己项目**的账本（两个会话两个项目 ⇒ 各收各的，**绝不串台**）
//   ②跨轮状态（去重 / 最小间隔）**按会话分开**（一场会念过，不影响另一场）
//   ③遥测写进**各自的落点**
//   ④拿不到 `agent.ctx` 或作用域里读不到 systemPrompt ⇒ 如实返回 `{ok:false}`（不抛）
//      —— 此时**根通道必须继续兜底**（这是"乙"不成立时也不能变哑的底线）
//   ⑤根通道让路：所有会话都已按作用域注册 ⇒ 根通道出空串（同一份提醒不投两遍）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { agentSessionCwd, landingForAgent, registerAgentScopedDelivery } from '../src/scoped.mjs';
import { registerDelivery } from '../src/deliver.mjs';
import { cleanupAll, freshProjectLanding, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const TS = '2026-09-20T00:00:00.000Z';
const row = (id, rule) => JSON.stringify({ schema: 1, id, ts: TS, rule, category: '纪律', problem: 'p', root_cause: 'r', solution: 's', evidence: [], mechanism: 'm', recurrence: 1, first_seen: TS, last_seen: TS, status: 'active' });

/** 造一个"项目落点 + 该项目的会话（含自己的作用域 ctx）"
 *  默认给**两种机制都可用**的 ctx：`systemPrompt`（首选，作用域内服务注册）+ `on`（瀑布，仅显式开关时用）。
 */
function projectSession(label, rule) {
  const { projectRoot, landing } = freshProjectLanding(label, { entries: [] });
  writeFileSync(join(landing, 'ledger.jsonl'), `${row(`${label}-1`, rule)}\n`, 'utf8');
  const hooks = [];
  const contexts = [];
  const ctx = {
    effect: (fn) => fn(),                                   // 作用域里注册即生效（真实宿主同语义）
    on: (ev, fn) => { hooks.push({ ev, fn }); return () => {}; },
    systemPrompt: { context: (def) => { contexts.push(def); return () => {}; } },
  };
  const agent = { id: label, session: { header: { cwd: projectRoot } }, ctx };
  const base = () => ({ sections: [], contexts: [], tools: [], variables: {} });
  /** 机制①（首选）：直接问**作用域内注册**的那个 provider 要文本 */
  const textOf = () => {
    const def = contexts[contexts.length - 1];
    return def === undefined ? '' : def.text({});
  };
  /** 机制②（显式开关时）：模拟宿主装配瀑布 */
  const assemble = async (assembly = base()) => {
    const hook = hooks.find((h) => h.ev === 'system-prompt/assemble');
    if (hook === undefined) return assembly;
    return hook.fn(assembly, {}, async () => assembly);
  };
  return { projectRoot, landing, agent, hooks, contexts, assemble, textOf };
}

test('判据①（根治核心）: 两个会话两个项目 ⇒ 各投**自己**的账本，绝不串台', () => {
  const a = projectSession('sc-a', 'CAT-AAA');
  const b = projectSession('sc-b', 'CAT-BBB');
  const ra = registerAgentScopedDelivery({ agent: a.agent, now: () => new Date(TS) });
  const rb = registerAgentScopedDelivery({ agent: b.agent, now: () => new Date(TS) });
  assert.equal(ra.ok, true, ra.reason ?? '');
  assert.equal(rb.ok, true, rb.reason ?? '');
  assert.equal(ra.mechanism, 'service-context', '首选机制 = 作用域内服务注册（瀑布那条作用域隔离未验证，不作默认）');
  assert.notEqual(ra.name, rb.name, '每个会话必须用**不同的注册名**');
  const ta = a.textOf();
  const tb = b.textOf();
  assert.match(ta, /CAT-AAA/);
  assert.ok(!/CAT-BBB/.test(ta), 'A 的提醒绝不能出现 B 的纪律');
  assert.match(tb, /CAT-BBB/);
  assert.ok(!/CAT-AAA/.test(tb), 'B 的提醒绝不能出现 A 的纪律');
  assert.equal(ra.report().landingSource, 'agent-project');
  assert.equal(rb.report().landingSource, 'agent-project');
});

test('判据（显式开关）: 装配瀑布机制**默认不启用**，只有 `RULEKEEPER_SCOPED_WATERFALL=1` 才挂', () => {
  const off = projectSession('sc-waterfall-off', 'CAT-AAA');
  const r1 = registerAgentScopedDelivery({ agent: off.agent });
  assert.equal(r1.mechanism, 'service-context', '默认不得挂瀑布（作用域隔离未验证）');
  assert.equal(off.hooks.length, 0, '默认不该产生任何 on() 订阅');

  process.env.RULEKEEPER_SCOPED_WATERFALL = '1';
  try {
    const on = projectSession('sc-waterfall-on', 'CAT-AAA');
    const r2 = registerAgentScopedDelivery({ agent: on.agent });
    assert.equal(r2.mechanism, 'assemble-waterfall');
    assert.equal(on.hooks.length, 1, '开关打开时才挂瀑布');
  } finally {
    delete process.env.RULEKEEPER_SCOPED_WATERFALL;
  }
});

test('判据②: 跨轮状态按会话分开（一场会念过，不影响另一场）', () => {
  const a = projectSession('sc-dedup-a', 'CAT-AAA');
  const b = projectSession('sc-dedup-b', 'CAT-BBB');
  const ra = registerAgentScopedDelivery({ agent: a.agent, now: () => new Date(TS) });
  const rb = registerAgentScopedDelivery({ agent: b.agent, now: () => new Date(TS) });
  a.textOf();   // A 第一次：emitted
  a.textOf();   // A 第二次：同一内容 ⇒ 不再投（内存 unchanged 或落盘状态命中）
  b.textOf();   // B 第一次：**必须仍然 emitted**（不受 A 影响）
  assert.equal(ra.report().emissions, 1, 'A 只该 emit 一次');
  assert.ok(ra.report().evaluations >= 1);
  assert.equal(rb.report().emissions, 1, 'B 的状态必须独立');
});

test('判据③: 遥测写进**各自的落点**（不串账）', async () => {
  const a = projectSession('sc-usage-a', 'CAT-AAA');
  const b = projectSession('sc-usage-b', 'CAT-BBB');
  registerAgentScopedDelivery({ agent: a.agent, now: () => new Date(TS) });
  registerAgentScopedDelivery({ agent: b.agent, now: () => new Date(TS) });
  a.textOf();
  b.textOf();
  const ua = JSON.parse(readFileSync(join(a.landing, 'usage.json'), 'utf8'));
  const ub = JSON.parse(readFileSync(join(b.landing, 'usage.json'), 'utf8'));
  assert.equal(ua.totalEmitted, 1);
  assert.ok(ua.rules['CAT-AAA'], 'A 的落点只该记 A 的纪律');
  assert.equal(ub.totalEmitted, 1);
  assert.ok(ub.rules['CAT-BBB'], 'B 的落点只该记 B 的纪律');
});

test('判据④: 拿不到 agent.ctx / 两种机制都挂不上 ⇒ 如实 ok:false（不抛），根通道可兜底', () => {
  const bare = { id: 'x', session: { header: { cwd: tempDir('sc-bare') } } };
  const noCtx = registerAgentScopedDelivery({ agent: bare });
  assert.equal(noCtx.ok, false);
  assert.equal(noCtx.reason, 'no-agent-ctx');
  // 没有两种机制都不可用的 ctx ⇒ 如实拒绝（reason 说明"作用域里读不到 systemPrompt"）
  const noHook = registerAgentScopedDelivery({ agent: { ...bare, ctx: { effect: (fn) => fn() } } });
  assert.equal(noHook.ok, false);
  assert.equal(noHook.reason, 'no-systemPrompt-in-agent-scope');
  // 作用域拒绝注册（`actx.effect` 抛）也要如实返回，不抛
  const throwy = registerAgentScopedDelivery({
    agent: { ...bare, ctx: { effect: () => { throw new Error('registration rejected'); }, systemPrompt: { context: () => () => {} } } },
  });
  assert.equal(throwy.ok, false);
  assert.match(String(throwy.reason), /scope-register-error/);
  // 兜底机制：只有 systemPrompt、没有 on ⇒ 走服务注册并成功
  const svcOnly = registerAgentScopedDelivery({
    agent: { ...bare, ctx: { effect: (fn) => fn(), systemPrompt: { context: () => () => {} } } },
  });
  assert.equal(svcOnly.ok, true);
  assert.equal(svcOnly.mechanism, 'service-context');
  // 没有任何落点 ⇒ provider 出空串（不猜、不说错话）
  const lonely = tempDir('sc-lonely');
  const none = registerAgentScopedDelivery({ agent: { id: 'l', session: { header: { cwd: lonely } }, ctx: { effect: (fn) => fn(), systemPrompt: { context: () => {} } } }, env: { DSH_HOME: join(lonely, 'nohome') } });
  assert.equal(none.report().landingBound, false);
  assert.equal(agentSessionCwd({ session: { header: { cwd: '  ' } } }), null);
  assert.deepEqual(landingForAgent({ session: { header: { cwd: lonely } } }, { env: { DSH_HOME: join(lonely, 'nohome') } }), { dir: null, source: 'none' });
});

test('判据⑤: 根通道让路 —— **只要有任何一个会话**接管了自己的提醒位，根通道就闭嘴（防投两遍）', () => {
  const a = projectSession('sc-yield', 'CAT-AAA');
  const host = { effect: (fn) => fn(), systemPrompt: { context: (def) => { host.def = def; } } };
  let anyScoped = false;   // 模拟插件层的判定结果（any，不是 all）
  registerDelivery(host, {
    resolveLanding: () => ({ dir: a.landing, source: 'project' }),
    shouldStaySilent: () => anyScoped,
  });
  assert.match(host.def.text({}), /CAT-AAA/, '还没有任何会话接管时，根通道照常投（兜底）');
  anyScoped = true;
  assert.equal(host.def.text({}), '', '已有会话接管 ⇒ 根通道让路（空串；否则那个会话会收到两遍 —— 线上实测过）');
  // 判定函数抛错 ⇒ 照常投递（宁可重复也不静默）
  const host2 = { effect: (fn) => fn(), systemPrompt: { context: (def) => { host2.def = def; } } };
  registerDelivery(host2, { resolveLanding: () => ({ dir: a.landing, source: 'project' }), shouldStaySilent: () => { throw new Error('boom'); } });
  assert.match(host2.def.text({}), /CAT-AAA/);
});

test('判据⑥（线上实测缺陷回归）: 重启后**不再重复投同一段**（内存去重随进程消失，得靠落盘状态）', () => {
  const a = projectSession('sc-restart', 'CAT-AAA');
  // 第一次（进程 1）：投出去并落盘状态
  const first = registerAgentScopedDelivery({ agent: a.agent, now: () => new Date(TS) });
  const t1 = a.textOf();
  assert.ok(t1.length > 0);
  assert.equal(first.report().emissions, 1);
  const persisted = JSON.parse(readFileSync(join(a.landing, 'usage.json'), 'utf8'));
  assert.ok(persisted.emissions && typeof persisted.emissions['sc-restart'].sha === 'string',
    `投递状态必须**按会话**落盘（否则重启后无从判断）；实得 ${JSON.stringify(persisted.emissions)}`);

  // 第二次（模拟**重启后的新进程**：新的 runtime，但落盘状态还在）——同一会话、同一内容 ⇒ 不再出话
  const again = registerAgentScopedDelivery({ agent: a.agent, now: () => new Date(TS) });
  const t2 = a.textOf();
  assert.equal(t2, '', '同一会话同一内容，重启后不得再投一遍（这就是"上下文里出现两份"的成因）');
  assert.equal(again.report().emissions, 0);
  assert.ok(again.runtime.reasons.includes('already-delivered-before-restart'));

  // 反事实①：换个会话（不同 agent id）⇒ 必须照投（新会话需要它）
  const b = projectSession('sc-restart-other', 'CAT-AAA');
  const other = registerAgentScopedDelivery({ agent: b.agent, now: () => new Date(TS) });
  assert.ok(b.textOf().length > 0, '另一个会话必须照投');

  // 反事实②：内容变了（新增一条纪律）⇒ 必须照投（不能因为"投过"就永远闭嘴）
  writeFileSync(join(a.landing, 'ledger.jsonl'), `${row('sc-restart-2', 'CAT-ZZZ')}\n`, 'utf8');
  const changed = registerAgentScopedDelivery({ agent: a.agent, now: () => new Date(TS) });
  assert.ok(a.textOf().length > 0, '内容变化后必须重新投递');
  assert.equal(changed.report().emissions, 1);
});

test('判据: 插件层真的会为每个会话注册（agent/pre-step 监听器带这次接线 + 状态可读 + 结果落盘）', async () => {
  const a = projectSession('sc-wired', 'CAT-AAA');
  const ns = await import('../src/plugin.mjs');   // **不解构 lastApplyReport**（解构会把它快照成 null）
  const { apply, PLUGIN_EVENTS } = ns;
  const listeners = new Map();
  const registered = [];
  const ctx = {
    effect: (fn) => fn(),
    on: (ev, fn) => listeners.set(ev, fn),
    tools: { register: (d) => registered.push(d) },
    systemPrompt: { context: () => () => {} },
  };
  const hostRoot = tempDir('sc-host');
  mkdirSync(join(hostRoot, 'lib'), { recursive: true });
  writeFileSync(join(hostRoot, 'lib', 'host.js'), `${[...PLUGIN_EVENTS].map((e) => `ctx.on('${e}', () => {})`).join('\n')}\n`, 'utf8');
  apply(ctx, { dshRoot: hostRoot });
  const prestep = listeners.get('agent/pre-step');
  assert.equal(typeof prestep, 'function');
  const before = ns.lastApplyReport.scoped;
  assert.equal(before.registered, 0, '装载时还没有会话 ⇒ 0');
  await prestep({ agent: a.agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }));
  assert.equal(ns.lastApplyReport.scoped.mode, 'per-agent', `报告要能读到按会话注册的**实时**状态；实得 ${JSON.stringify(ns.lastApplyReport.scoped)}`);
  assert.equal(ns.lastApplyReport.scoped.registered, 1);
  assert.equal(a.contexts.length, 1, '应当为该会话在它自己的作用域里注册提醒位（service-context）');
  // 注册结果必须**落盘**（上一轮失败之所以浪费了一轮，就是因为它是"看不见的"）
  const diag = readFileSync(join(hostRoot, 'rulekeeper-boot.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const scopedRow = diag.find((r) => r.kind === 'scoped');
  assert.ok(scopedRow, '诊断文件里必须有 kind=scoped 的记录');
  assert.equal(scopedRow.ok, true);
  assert.equal(scopedRow.mechanism, 'service-context');
});
