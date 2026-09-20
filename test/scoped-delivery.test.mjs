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

/** 造一个"项目落点 + 该项目的会话（含自己的作用域 ctx）" */
function projectSession(label, rule) {
  const { projectRoot, landing } = freshProjectLanding(label, { entries: [] });
  writeFileSync(join(landing, 'ledger.jsonl'), `${row(`${label}-1`, rule)}\n`, 'utf8');
  const registered = [];
  const ctx = {
    effect: (fn) => fn(),                                   // 作用域里注册即生效（真实宿主同语义）
    systemPrompt: { context: (def) => { registered.push(def); return () => {}; } },
  };
  const agent = { id: label, session: { header: { cwd: projectRoot } }, ctx };
  return { projectRoot, landing, agent, registered, provider: () => registered[registered.length - 1].text };
}

test('判据①（根治核心）: 两个会话两个项目 ⇒ provider 各投**自己**的账本，绝不串台', () => {
  const a = projectSession('sc-a', 'CAT-AAA');
  const b = projectSession('sc-b', 'CAT-BBB');
  const ra = registerAgentScopedDelivery({ agent: a.agent, now: () => new Date(TS) });
  const rb = registerAgentScopedDelivery({ agent: b.agent, now: () => new Date(TS) });
  assert.equal(ra.ok, true, ra.reason ?? '');
  assert.equal(rb.ok, true, rb.reason ?? '');
  assert.notEqual(ra.name, rb.name, '每个会话必须用**不同的注册名**（同作用域重名会抛）');
  const ta = a.provider()({});
  const tb = b.provider()({});
  assert.match(ta, /CAT-AAA/);
  assert.ok(!/CAT-BBB/.test(ta), 'A 的提醒绝不能出现 B 的纪律');
  assert.match(tb, /CAT-BBB/);
  assert.ok(!/CAT-AAA/.test(tb), 'B 的提醒绝不能出现 A 的纪律');
  assert.equal(ra.report().landingSource, 'agent-project');
  assert.equal(rb.report().landingSource, 'agent-project');
});

test('判据②: 跨轮状态按会话分开（一场会念过，不影响另一场）', () => {
  const a = projectSession('sc-dedup-a', 'CAT-AAA');
  const b = projectSession('sc-dedup-b', 'CAT-BBB');
  const ra = registerAgentScopedDelivery({ agent: a.agent, now: () => new Date(TS) });
  const rb = registerAgentScopedDelivery({ agent: b.agent, now: () => new Date(TS) });
  a.provider()({});   // A 第一次：emitted
  a.provider()({});   // A 第二次：unchanged
  b.provider()({});   // B 第一次：**必须仍然 emitted**（不受 A 影响）
  assert.equal(ra.report().emissions, 1, 'A 只该 emit 一次');
  assert.equal(ra.report().evaluations, 2);
  assert.equal(rb.report().emissions, 1, 'B 的状态必须独立');
});

test('判据③: 遥测写进**各自的落点**（不串账）', () => {
  const a = projectSession('sc-usage-a', 'CAT-AAA');
  const b = projectSession('sc-usage-b', 'CAT-BBB');
  registerAgentScopedDelivery({ agent: a.agent, now: () => new Date(TS) });
  registerAgentScopedDelivery({ agent: b.agent, now: () => new Date(TS) });
  a.provider()({});
  b.provider()({});
  const ua = JSON.parse(readFileSync(join(a.landing, 'usage.json'), 'utf8'));
  const ub = JSON.parse(readFileSync(join(b.landing, 'usage.json'), 'utf8'));
  assert.equal(ua.totalEmitted, 1);
  assert.ok(ua.rules['CAT-AAA'], 'A 的落点只该记 A 的纪律');
  assert.equal(ub.totalEmitted, 1);
  assert.ok(ub.rules['CAT-BBB'], 'B 的落点只该记 B 的纪律');
});

test('判据④: 拿不到 agent.ctx / 作用域读不到 systemPrompt ⇒ 如实 ok:false（不抛），根通道可兜底', () => {
  const bare = { id: 'x', session: { header: { cwd: tempDir('sc-bare') } } };
  const noCtx = registerAgentScopedDelivery({ agent: bare });
  assert.equal(noCtx.ok, false);
  assert.equal(noCtx.reason, 'no-agent-ctx');
  const noSp = registerAgentScopedDelivery({ agent: { ...bare, ctx: { effect: (fn) => fn() } } });
  assert.equal(noSp.ok, false);
  assert.equal(noSp.reason, 'no-systemPrompt-in-scope');
  // 作用域里注册抛错（宿主拒绝注册）也要如实返回，不抛
  const throwy = registerAgentScopedDelivery({ agent: { ...bare, ctx: { effect: () => { throw new Error('registration rejected'); }, systemPrompt: { context: () => {} } } } });
  assert.equal(throwy.ok, false);
  assert.match(String(throwy.reason), /scope-register-error/);
  // 没有任何落点 ⇒ provider 出空串（不猜、不说错话）
  const lonely = tempDir('sc-lonely');
  const none = registerAgentScopedDelivery({ agent: { id: 'l', session: { header: { cwd: lonely } }, ctx: { effect: (fn) => fn(), systemPrompt: { context: () => {} } } }, env: { DSH_HOME: join(lonely, 'nohome') } });
  assert.equal(none.report().landingBound, false);
  assert.equal(agentSessionCwd({ session: { header: { cwd: '  ' } } }), null);
  assert.deepEqual(landingForAgent({ session: { header: { cwd: lonely } } }, { env: { DSH_HOME: join(lonely, 'nohome') } }), { dir: null, source: 'none' });
});

test('判据⑤: 根通道让路 —— 所有会话都按作用域注册后，根通道出空串（不投两遍）', async () => {
  const a = projectSession('sc-yield', 'CAT-AAA');
  const host = { effect: (fn) => fn(), systemPrompt: { context: (def) => { host.def = def; } } };
  let allScoped = false;   // 模拟插件层的判定结果
  registerDelivery(host, {
    resolveLanding: () => ({ dir: a.landing, source: 'project' }),
    shouldStaySilent: () => allScoped,
  });
  assert.match(host.def.text({}), /CAT-AAA/, '有会话尚未按作用域注册时，根通道照常投（兜底）');
  allScoped = true;
  assert.equal(host.def.text({}), '', '全部会话已按作用域注册 ⇒ 根通道让路（空串）');
  // 判定函数抛错 ⇒ 照常投递（宁可重复也不静默）
  const host2 = { effect: (fn) => fn(), systemPrompt: { context: (def) => { host2.def = def; } } };
  registerDelivery(host2, { resolveLanding: () => ({ dir: a.landing, source: 'project' }), shouldStaySilent: () => { throw new Error('boom'); } });
  assert.match(host2.def.text({}), /CAT-AAA/);
});

test('判据: 插件层真的会为每个会话注册（PLUGIN_EVENTS 里 agent/pre-step 的监听器带这次接线）', async () => {
  const a = projectSession('sc-wired', 'CAT-AAA');
  const ns = await import('../src/plugin.mjs');   // **不解构 lastApplyReport**（解构会把它快照成 null）
  const { apply, PLUGIN_EVENTS } = ns;
  const listeners = new Map();
  const registered = [];
  const makeCtx = (label) => ({
    effect: (fn) => fn(),
    on: (ev, fn) => listeners.set(`${label}:${ev}`, fn),
    tools: { register: (d) => registered.push(d) },
    systemPrompt: { context: () => () => {} },
  });
  const hostRoot = tempDir('sc-host');
  mkdirSync(join(hostRoot, 'lib'), { recursive: true });
  writeFileSync(join(hostRoot, 'lib', 'host.js'), `${[...PLUGIN_EVENTS].map((e) => `ctx.on('${e}', () => {})`).join('\n')}\n`, 'utf8');
  const ctx = makeCtx('p');
  apply(ctx, { dshRoot: hostRoot });
  const prestep = listeners.get(`p:agent/pre-step`);
  assert.equal(typeof prestep, 'function');
  await prestep({ agent: a.agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }));
  assert.equal(ns.lastApplyReport.scoped.mode, 'per-agent', `报告里要能看到按会话注册的模式；实得 ${JSON.stringify(ns.lastApplyReport.scoped)}`);
  assert.ok(a.registered.length >= 1, 'pre-step 时应当为该会话注册它自己的提醒位');
});
