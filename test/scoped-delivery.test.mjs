// dsh-rulekeeper · 方案"乙"用例：**按会话隔离的提醒投递**（2026-09-20 根治 last-writer-wins）
//
// 要钉住的判据：
//   ①每个会话的 provider 只投**它自己项目**的账本（两个会话两个项目 ⇒ 各收各的，**绝不串台**）
//   ②跨轮状态（去重 / 最小间隔）**按会话分开**（一场会念过，不影响另一场）
//   ③遥测写进**各自的落点**
//   ④拿不到 `agent.ctx` 或作用域里读不到 systemPrompt ⇒ 如实返回 `{ok:false}`（不抛）
//      —— 此时**根通道必须继续兜底**（这是"乙"不成立时也不能变哑的底线）
//   ⑤根通道让路：**所有在册会话都拿到自己的通道**才让路（F-3 修复后语义；判据⑧⑨）
//   ⑥跨重启去重：同一会话 + 同一段文本 + 每个贡献落点都记过 ⇒ 不再重投
//   ⑦（F-2）作用域文本 = **项目落点 ∪ 用户级落点**（项目会话也要收到用户级纪律）
//   ⑧（F-3）只要有一个在册会话没有自己的通道 ⇒ 根通道**继续投递**（不许静默丢失）
//   ⑨注册失败**有界重试**：首轮窗口里 `agent.ctx` 之后才就绪时能收敛（随后根通道再让路）
//
// ⚠ **污染护栏**（2026-09-21 实测教训）：作用域文本是并集 ⇒ 记账会**同时写两个落点**。
//   用例必须传**隔离 `env`**（`freshProjectLanding().env`），否则会把测试会话写进**真实**用户级落点
//   （实测发生过）。文件末尾的 `realUserLandingGuard()` 是机械判据，不靠自觉。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { agentSessionCwd, landingForAgent, landingsForAgent, registerAgentScopedDelivery, ROOT_DEDUP_WINDOW_MS, textSha } from '../src/scoped.mjs';
import { registerDelivery } from '../src/deliver.mjs';
import { ROOT_EMISSION_KEY, readEmission, usageSummary, writeEmission } from '../src/usage.mjs';
import { cleanupAll, freshProjectLanding, isolateProcessUserLanding, realUserLandingGuard, tempDir } from './helpers/sandbox.mjs';

const landedGuard = realUserLandingGuard();   // 必须在改 DSH_HOME **之前**建（它要的是**真实**落点路径）
// 本文件整体在**隔离 DSH_HOME**下跑（机制，不靠每处调用自觉）：
//   投递记账按落点写入，若用真实 env，测试会话的指纹会落进真实用户级 `usage.json`（实测发生过两次，
//   见 helpers/sandbox.mjs 的 `realUserLandingGuard`）。隔离后本文件的"用户级落点" = 临时目录。
const isolatedHome = isolateProcessUserLanding('scoped-home');
test.after(() => {
  cleanupAll();
  isolatedHome.restore();
  landedGuard.assertClean('本文件的用例');
});

const TS = '2026-09-20T00:00:00.000Z';
const row = (id, rule) => JSON.stringify({ schema: 1, id, ts: TS, rule, category: '纪律', problem: 'p', root_cause: 'r', solution: 's', evidence: [], mechanism: 'm', recurrence: 1, first_seen: TS, last_seen: TS, status: 'active' });

/** 造一个"项目落点 + 该项目的会话（含自己的作用域 ctx）"
 *  默认给**两种机制都可用**的 ctx：`systemPrompt`（首选，作用域内服务注册）+ `on`（瀑布，仅显式开关时用）。
 *  `env` 是**隔离**环境（`DSH_HOME` 指向临时目录）—— 用例一律用它解析用户级落点，绝不碰真实落点。
 */
function projectSession(label, rule) {
  const { projectRoot, landing, home, env } = freshProjectLanding(label, { entries: [] });
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
  return { projectRoot, landing, home, env, agent, hooks, contexts, assemble, textOf };
}

/** 造"项目落点 **和** 用户级落点**都有**"的会话（F-2 并集判据用；两侧规则可不同） */
function sessionWithBothLandings(label, projectRules, userRules) {
  const s = freshProjectLanding(label, { entries: [], userLanding: true });
  const body = (rules, tag) => (rules.length === 0 ? '' : `${rules.map((r, i) => row(`${label}-${tag}${i}`, r)).join('\n')}\n`);
  writeFileSync(join(s.landing, 'ledger.jsonl'), body(projectRules, 'p'), 'utf8');
  writeFileSync(join(s.userLanding, 'ledger.jsonl'), body(userRules, 'u'), 'utf8');
  const contexts = [];
  const agent = {
    id: label,
    session: { header: { cwd: s.projectRoot } },
    ctx: { effect: (fn) => fn(), systemPrompt: { context: (def) => { contexts.push(def); return () => {}; } } },
  };
  return { ...s, agent, contexts, textOf: () => (contexts.length === 0 ? '' : contexts[contexts.length - 1].text({})) };
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

test('判据⑤+⑧+⑨（F-3 修复）: 让路 = **所有在册会话都有通道**；有一个没通道 ⇒ 根通道继续兜底', async () => {
  const ns = await import('../src/plugin.mjs');   // **不解构 lastApplyReport**（解构会把它快照成 null）
  const { apply, PLUGIN_EVENTS, SCOPED_MAX_ATTEMPTS } = ns;
  const a = projectSession('sc-yield-a', 'CAT-AAA');
  const listeners = new Map();
  let rootDef = null;
  let liveAgents = [];
  const ctx = {
    effect: (fn) => fn(),
    on: (ev, fn) => listeners.set(ev, fn),
    tools: { register: () => {} },
    systemPrompt: { context: (def) => { rootDef = def; return () => {}; } },
    agents: { roots: () => liveAgents },           // 宿主 `agents` 服务（`liveRootAgents` 的唯一入口）
  };
  const hostRoot = tempDir('sc-yield-host');
  mkdirSync(join(hostRoot, 'lib'), { recursive: true });
  writeFileSync(join(hostRoot, 'lib', 'host.js'), `${[...PLUGIN_EVENTS].map((e) => `ctx.on('${e}', () => {})`).join('\n')}\n`, 'utf8');
  // 静态落点 = 临时项目落点：保证本用例**只写临时账本**，不碰任何真实落点
  apply(ctx, { dshRoot: hostRoot, landingDir: a.landing });
  const prestep = listeners.get('agent/pre-step');
  const rootText = () => rootDef.text({});
  const step = (agent) => prestep({ agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }));

  // ①启动窗口：还没有任何会话注册 ⇒ 根通道必须先投（否则首轮是静默的）
  assert.match(rootText(), /CAT-AAA/, '还没有会话接管时，根通道照常投（兜底）');

  // ②会话 A 注册成功 ⇒ 唯一在册会话都有通道 ⇒ 根通道让路
  liveAgents = [a.agent];
  await step(a.agent);
  assert.equal(ns.lastApplyReport.scoped.mode, 'per-agent');
  assert.equal(rootText(), '', '全部在册会话都有自己的通道 ⇒ 根通道让路（防投两遍）');

  // ③F-3 红态还原：再来一个会话 B，**没有 agent.ctx** ⇒ 它没有自己的通道
  const b = { id: 'sc-yield-b', session: { header: { cwd: a.projectRoot } } };   // 无 ctx（首轮窗口/注册失败形态）
  liveAgents = [a.agent, b];
  await step(b);
  assert.equal(ns.lastApplyReport.scoped.registered, 1);
  assert.equal(ns.lastApplyReport.scoped.failed.length, 1, '注册失败必须如实记账（不静默）');
  assert.match(rootText(), /CAT-AAA/,
    'F-3 判据：有会话没有自己的通道 ⇒ 根通道**必须继续投递**（上一版"任一接管就让路"会让它零提醒）');

  // ④有界重试：B 的 ctx 后来就绪（真实成因：首轮窗口里 agent.ctx 尚未挂上）⇒ 下一次 pre-step 收敛
  b.ctx = { effect: (fn) => fn(), systemPrompt: { context: () => () => {} } };
  await step(b);
  assert.equal(ns.lastApplyReport.scoped.registered, 2, '失败后应有界重试并收敛');
  assert.equal(rootText(), '', '全部会话都拿到自己的通道 ⇒ 根通道再次让路');

  // ⑤重试有上限（不许无限刷）：一直是失败的会话，尝试次数到顶后不再增长
  const c = { id: 'sc-yield-c', session: { header: { cwd: a.projectRoot } } };
  liveAgents = [a.agent, b, c];
  for (let i = 0; i < SCOPED_MAX_ATTEMPTS + 3; i += 1) await step(c);
  const cRow = ns.lastApplyReport.scoped.failed.find((r) => r.agent === 'rulekeeper/reminders#sc-yield-c');
  assert.ok(cRow, `诊断报告里应能看到失败会话；实得 ${JSON.stringify(ns.lastApplyReport.scoped)}`);
  assert.equal(cRow.attempts, SCOPED_MAX_ATTEMPTS, '重试次数必须有界');
  // 兜底不变：C 始终没有通道 ⇒ 根通道始终在投（这就是"宁重复、不静默"）
  assert.match(rootText(), /CAT-AAA/);

  // 判定函数抛错 ⇒ 照常投递（宁可重复也不静默；deliver.mjs 的内层 try 契约）
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

test('判据⑦（F-2 修复）: 作用域文本 = **项目落点 ∪ 用户级落点** —— 项目会话不再丢掉用户级纪律', () => {
  // 现场形态（验收报告 §2）：会话 cwd 在项目里 ⇒ 旧口径只装项目账本；根通道让路后
  // 用户级纪律（JUDGEMENT-*）在该会话里**静默消失**。修复后必须两边都念到。
  const s = sessionWithBothLandings('sc-union', ['CAT-AAA', 'CAT-BBB'], ['JUDGEMENT-XXX', 'JUDGEMENT-YYY']);
  const r = registerAgentScopedDelivery({ agent: s.agent, env: s.env, now: () => new Date(TS) });
  assert.equal(r.ok, true, r.reason ?? '');
  const text = s.textOf();
  assert.match(text, /CAT-AAA/);
  assert.match(text, /CAT-BBB/);
  assert.match(text, /JUDGEMENT-/, 'F-2 判据：项目会话**必须**拿到用户级纪律（否则用户级纪律零通道）');
  assert.equal((text.match(/JUDGEMENT-/g) ?? []).length, 1,
    `预算 maxRules=3 时按**轮转**取：2 项目规则 + 用户级 1 条；实得 ${JSON.stringify(text)}`);
  // 对象级记账（规则 41）：每条纪律只记到**它自己**的落点
  const proj = JSON.parse(readFileSync(join(s.landing, 'usage.json'), 'utf8'));
  const user = JSON.parse(readFileSync(join(s.userLanding, 'usage.json'), 'utf8'));
  assert.ok(proj.rules['CAT-AAA'] && proj.rules['CAT-BBB'], `项目落点该记两条项目纪律；实得 ${JSON.stringify(proj.rules)}`);
  assert.ok(proj.rules['JUDGEMENT-XXX'] === undefined, '用户级纪律不得记到项目落点');
  assert.ok(user.rules['JUDGEMENT-XXX'], `用户级落点该记那条用户级纪律；实得 ${JSON.stringify(user.rules)}`);
  assert.ok(user.rules['CAT-AAA'] === undefined, '项目纪律不得记到用户级落点');
  // 跨重启去重：两个**贡献过的**落点都记了同一指纹（下次重启才知道"这个会话已经有了"）
  assert.equal(proj.emissions['sc-union'].sha, user.emissions['sc-union'].sha, '同一段文本的指纹应逐落点落盘');
  assert.deepEqual(r.report().landingDirs, [s.landing, s.userLanding], '报告要如实给出并集落点');
});

test('判据⑦b（F-2 饿死面）: 项目落点规则**撑满**预算时，用户级纪律仍必须被念到', () => {
  // 这是"先项目取满、再取用户级"的失败形态（若实现退化成非轮转，本用例立刻变红）
  const s = sessionWithBothLandings('sc-union-starve', ['CAT-AAA', 'CAT-BBB', 'CAT-CCC'], ['JUDGEMENT-XXX']);
  registerAgentScopedDelivery({ agent: s.agent, env: s.env, now: () => new Date(TS) });
  const text = s.textOf();
  assert.match(text, /JUDGEMENT-XXX/, `项目规则占满预算也不能把用户级挤掉；实得 ${JSON.stringify(text)}`);
  assert.equal((text.match(/CAT-/g) ?? []).length, 2, '预算 3 条 = 项目 2 + 用户级 1（轮转）');
});

test('判据⑦c（并集去重）: 两侧同名的纪律**只念一次**，且只算它第一次出现的落点', () => {
  const s = sessionWithBothLandings('sc-union-dup', ['CAT-SAME'], ['CAT-SAME']);
  const r = registerAgentScopedDelivery({ agent: s.agent, env: s.env, now: () => new Date(TS) });
  const text = s.textOf();
  assert.equal((text.match(/CAT-SAME/g) ?? []).length, 1, `同名纪律只该念一次；实得 ${JSON.stringify(text)}`);
  // 去重后用户级落点**没有贡献** ⇒ 指纹只落项目落点（不许给没出力的落点记账）
  const proj = JSON.parse(readFileSync(join(s.landing, 'usage.json'), 'utf8'));
  const userUsage = existsSync(join(s.userLanding, 'usage.json'))
    ? JSON.parse(readFileSync(join(s.userLanding, 'usage.json'), 'utf8'))
    : {};
  assert.ok(proj.emissions['sc-union-dup'], '贡献过的落点要记指纹');
  assert.equal(userUsage.emissions?.['sc-union-dup'], undefined, '没贡献的落点不得被记账（连 usage.json 都不该被创建）');
  assert.deepEqual(r.report().contributedDirs, [s.landing], '报告要如实区分"候选落点"与"真正被念到的落点"');
  assert.deepEqual(r.report().landingDirs, [s.landing, s.userLanding], '候选落点仍是并集（两侧都被考查过）');
});

test('判据⑪（F-2 兜底面）: 根通道兜底时也走并集 —— 未接管/注册失败的项目会话照样拿到用户级纪律', async () => {
  const ns = await import('../src/plugin.mjs');
  const { apply, PLUGIN_EVENTS } = ns;
  const s = sessionWithBothLandings('sc-root-union', ['CAT-AAA'], ['JUDGEMENT-XXX']);
  const listeners = new Map();
  let rootDef = null;
  const ctx = {
    effect: (fn) => fn(),
    on: (ev, fn) => listeners.set(ev, fn),
    tools: { register: () => {} },
    systemPrompt: { context: (def) => { rootDef = def; return () => {}; } },
    agents: { roots: () => [s.agent] },          // 单项目在线 ⇒ 是哪个项目**无歧义**
  };
  const hostRoot = tempDir('sc-root-union-host');
  mkdirSync(join(hostRoot, 'lib'), { recursive: true });
  writeFileSync(join(hostRoot, 'lib', 'host.js'), `${[...PLUGIN_EVENTS].map((e) => `ctx.on('${e}', () => {})`).join('\n')}\n`, 'utf8');
  const savedHome = process.env.DSH_HOME;
  process.env.DSH_HOME = s.home;                  // 该会话自己的（隔离目录内的）用户级落点
  try {
    apply(ctx, { dshRoot: hostRoot });            // **不传** landingDir ⇒ 走 ctx.agents 解析
    // 关键：**不跑** pre-step ⇒ 该会话没有自己的通道（注册失败 / 首轮窗口的形态）⇒ 只能靠根通道兜底
    const text = rootDef.text({});
    assert.match(text, /CAT-AAA/, '项目纪律必须在兜底文本里');
    assert.match(text, /JUDGEMENT-XXX/,
      'F-2 残面：兜底通道也必须带上用户级纪律 —— 否则没有自己通道的项目会话**永远**收不到用户级纪律');
    // 对象级记账：两条纪律各记到自己的落点（规则 41）
    const proj = JSON.parse(readFileSync(join(s.landing, 'usage.json'), 'utf8'));
    const user = JSON.parse(readFileSync(join(s.userLanding, 'usage.json'), 'utf8'));
    assert.ok(proj.rules['CAT-AAA'], `项目纪律记项目落点；实得 ${JSON.stringify(proj.rules)}`);
    assert.equal(proj.rules['JUDGEMENT-XXX'], undefined, '用户级纪律不得记到项目落点');
    assert.ok(user.rules['JUDGEMENT-XXX'], `用户级纪律记用户级落点；实得 ${JSON.stringify(user.rules)}`);
    assert.equal(user.rules['CAT-AAA'], undefined, '项目纪律不得记到用户级落点');
  } finally {
    process.env.DSH_HOME = savedHome;
  }
});

test('判据⑦d: 只有用户级落点的会话（项目没落点）行为不变 —— 仍退用户级', () => {
  const s = freshProjectLanding('sc-useronly', { entries: [], projectLanding: false, userLanding: true });
  const contexts = [];
  const agent = {
    id: 'sc-useronly',
    session: { header: { cwd: s.projectRoot } },
    ctx: { effect: (fn) => fn(), systemPrompt: { context: (def) => { contexts.push(def); return () => {}; } } },
  };
  const r = registerAgentScopedDelivery({ agent, env: s.env, now: () => new Date(TS) });
  assert.equal(r.report().landingSource, 'agent-user-fallback');
  assert.deepEqual(r.report().landingDirs, [s.userLanding]);
  assert.ok(contexts.length === 1);
});

test('判据⑩（按会话 id 记账）: 同一 id 的**不同对象包装**只注册一次；id 不明的会话不算"已接管"', async () => {
  const ns = await import('../src/plugin.mjs');
  const { apply, PLUGIN_EVENTS } = ns;
  const a = projectSession('sc-idem', 'CAT-AAA');
  const listeners = new Map();
  let rootDef = null;
  let liveAgents = [];
  const ctx = {
    effect: (fn) => fn(),
    on: (ev, fn) => listeners.set(ev, fn),
    tools: { register: () => {} },
    systemPrompt: { context: (def) => { rootDef = def; return () => {}; } },
    agents: { roots: () => liveAgents },
  };
  const hostRoot = tempDir('sc-idem-host');
  mkdirSync(join(hostRoot, 'lib'), { recursive: true });
  writeFileSync(join(hostRoot, 'lib', 'host.js'), `${[...PLUGIN_EVENTS].map((e) => `ctx.on('${e}', () => {})`).join('\n')}\n`, 'utf8');
  apply(ctx, { dshRoot: hostRoot, landingDir: a.landing });
  const prestep = listeners.get('agent/pre-step');
  const step = (agent) => prestep({ agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }));
  const rootText = () => rootDef.text({});

  // 同一会话的**另一个对象**（宿主换包装的形态）：id 相同、ctx 相同
  const a2 = { ...a.agent };
  liveAgents = [a.agent];
  await step(a.agent);
  liveAgents = [a2];
  await step(a2);
  assert.equal(ns.lastApplyReport.scoped.registered, 1, '同一 id 只该注册一次（按 id 幂等，不按对象身份）');
  assert.equal(ns.lastApplyReport.scoped.failed.length, 0, `不该出现重复注册失败；实得 ${JSON.stringify(ns.lastApplyReport.scoped.failed)}`);
  assert.equal(a.contexts.length, 1, '同一会话不得注册两份（真实宿主里同作用域重名**会抛**）');
  assert.equal(rootText(), '', '按 id 记账 ⇒ 同 id 的不同包装仍算"已接管"');

  // id 不明的会话**且没有通道**（注册失败）：不得被当成已接管（否则它的提醒可能一条都没有）
  const noId = { session: { header: { cwd: a.projectRoot } } };   // 无 ctx ⇒ 注册必失败
  const noId2 = { session: { header: { cwd: a.projectRoot } } };  // 另一个 id 不明的对象（必须与上一个分开记账）
  liveAgents = [a2, noId, noId2];
  await step(noId);
  await step(noId2);
  assert.equal(ns.lastApplyReport.scoped.failed.length, 2,
    `两个 id 不明的会话必须**各记一笔**（退回对象身份），不许被合并成一个；实得 ${JSON.stringify(ns.lastApplyReport.scoped.failed)}`);
  assert.match(rootText(), /CAT-AAA/, 'id 不明且无通道的会话必须让根通道继续兜底（宁重复，不静默）');
});

test('判据（2026-09-21 生命周期）: `agent/created` 就建通道（首轮装配之前）＋ `agent/disposed` 回收记账', async () => {
  const ns = await import('../src/plugin.mjs');
  const { apply, PLUGIN_EVENTS } = ns;
  // 事件名必须先真实存在于宿主事件表（否则 boot 自检会红）——本机已核实，见 plugin.mjs 的注释
  assert.ok(PLUGIN_EVENTS.includes('agent/created') && PLUGIN_EVENTS.includes('agent/disposed'),
    '必须在 PLUGIN_EVENTS 里登记（订阅集合 == PLUGIN_EVENTS 的不变量）');
  const a = projectSession('sc-lifecycle-a', 'CAT-AAA');
  const b = projectSession('sc-lifecycle-b', 'CAT-BBB');
  const listeners = new Map();
  let rootDef = null;
  let liveAgents = [];
  const ctx = {
    effect: (fn) => fn(),
    on: (ev, fn) => listeners.set(ev, fn),
    tools: { register: () => {} },
    systemPrompt: { context: (def) => { rootDef = def; return () => {}; } },
    agents: { roots: () => liveAgents },
  };
  const hostRoot = tempDir('sc-lifecycle-host');
  mkdirSync(join(hostRoot, 'lib'), { recursive: true });
  writeFileSync(join(hostRoot, 'lib', 'host.js'), `${[...PLUGIN_EVENTS].map((e) => `ctx.on('${e}', () => {})`).join('\n')}\n`, 'utf8');
  apply(ctx, { dshRoot: hostRoot, landingDir: a.landing });
  const created = listeners.get('agent/created');
  const disposed = listeners.get('agent/disposed');
  const rootText = () => rootDef.text({});

  // ①创建即注册：**不跑任何 pre-step** ⇒ 通道已就位（这正是"首轮装配之前"的形态）
  liveAgents = [a.agent];
  await created({ agent: a.agent }, async () => undefined);
  assert.equal(ns.lastApplyReport.scoped.registered, 1, 'agent/created 就该注册（首轮装配前就有自己的通道）');
  assert.equal(a.contexts.length, 1);
  assert.match(a.textOf(), /CAT-AAA/);
  assert.equal(rootText(), '', '已创建的会话都有自己的通道 ⇒ 根通道不必再出话（F-1 竞态从机制上消失）');
  // 诊断要能看出"这次注册是 created 触发的"（否则事后分不清是哪个钩子干的）
  const diag1 = readFileSync(join(hostRoot, 'rulekeeper-boot.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(diag1.filter((r) => r.kind === 'scoped').at(-1).trigger, 'created');

  // ②销毁即回收：记账删掉（否则"全部在册会话都有通道"会去比对早就死掉的会话）
  await disposed({ agent: a.agent }, async () => undefined);
  assert.equal(ns.lastApplyReport.scoped.registered, 0, 'disposed 后不该再把它算作在册');
  const diag2 = readFileSync(join(hostRoot, 'rulekeeper-boot.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const release = diag2.filter((r) => r.kind === 'scoped-release').at(-1);
  assert.ok(release, '回收也要落盘（否则"通道为什么没了"又是查不出来的那种故障）');
  assert.equal(release.reason, 'agent-disposed');

  // ③反事实：新会话还没建通道时，根通道**必须**继续兜底（回收不等于闭麦）
  liveAgents = [b.agent];
  assert.match(rootText(), /CAT-AAA/, '还有会话没有通道 ⇒ 根通道继续投（宁重复，不静默）');
  await created({ agent: b.agent }, async () => undefined);
  assert.equal(ns.lastApplyReport.scoped.registered, 1);
  assert.equal(rootText(), '');
});

test('判据（2026-09-21 跨通道指纹去重）: 根通道刚投过的同一段文本，作用域通道不再重复投', () => {
  // 现场成因：宿主顺序"先装配、后 pre-step"，根通道先出话、随后该会话自己的通道又出同一段。
  // 用户点选的修法：根通道把指纹落在它用的落点上（键 `(root)`），作用域通道比对指纹 + 时间窗。
  const s = projectSession('sc-rootdedup', 'CAT-AAA');
  const r = registerAgentScopedDelivery({ agent: s.agent, env: s.env, now: () => new Date(TS) });
  assert.equal(r.ok, true, r.reason ?? '');
  const first = s.textOf();
  assert.match(first, /CAT-AAA/);
  const sha = textSha(first);
  // 新注册一个同项目会话（模拟竞态现场里"自己的通道后建"的那个会话），把"根通道刚投过同一段"落在**它用的落点**上
  const s2 = projectSession('sc-rootdedup2', 'CAT-AAA');
  writeEmission(s2.landing, ROOT_EMISSION_KEY, { sha, at: TS });
  const r2 = registerAgentScopedDelivery({ agent: s2.agent, env: s2.env, now: () => new Date(TS) });
  assert.equal(s2.textOf(), '', '根通道刚投过逐字相同的一段 ⇒ 本会话不再重复投');
  assert.equal(r2.runtime.rootDedupSkips, 1, '拦下的次数必须可观测（否则"少投一次"是看不见的行为）');
  assert.ok(r2.runtime.reasons.includes('already-delivered-by-root'));

  // 反事实①：**不同文本**（多项目时根通道只投用户级、作用域投并集）⇒ 不拦，照投
  const s3 = sessionWithBothLandings('sc-rootdedup3', ['CAT-AAA'], ['JUDGEMENT-XXX']);
  writeEmission(s3.userLanding, ROOT_EMISSION_KEY, { sha: textSha(first), at: TS });
  const r3 = registerAgentScopedDelivery({ agent: s3.agent, env: s3.env, now: () => new Date(TS) });
  assert.match(s3.textOf(), /JUDGEMENT-XXX/, '文本不同（并集 vs 用户级）⇒ 指纹对不上 ⇒ 必须照投');
  assert.equal(r3.runtime.rootDedupSkips, 0);

  // 反事实②：指纹相同但**超出时间窗**（90 秒）⇒ 照投（新会话不能被旧的根投递憋死）
  const s4 = projectSession('sc-rootdedup4', 'CAT-AAA');
  writeEmission(s4.landing, ROOT_EMISSION_KEY, { sha: textSha(first), at: new Date(new Date(TS).getTime() - (ROOT_DEDUP_WINDOW_MS + 1000)).toISOString() });
  const r4 = registerAgentScopedDelivery({ agent: s4.agent, env: s4.env, now: () => new Date(TS) });
  assert.match(s4.textOf(), /CAT-AAA/, '超窗 ⇒ 照投（宁重复，不静默）');
  assert.equal(r4.runtime.rootDedupSkips, 0);
});

test('判据（2026-09-21 根通道落 `(root)` 状态）: 根通道投递时把指纹落盘（跨通道去重与计数器语义共用这一条）', () => {
  const a = projectSession('sc-rootrecord', 'CAT-AAA');
  const host = { effect: (fn) => fn(), systemPrompt: { context: (def) => { host.def = def; } } };
  registerDelivery(host, { landingDir: a.landing });
  assert.match(host.def.text({}), /CAT-AAA/);
  const rootRow = readEmission(a.landing, ROOT_EMISSION_KEY);
  assert.ok(rootRow !== null, '根通道投过 ⇒ 必须留下 `(root)` 指纹（否则跨通道去重没有依据）');
  assert.equal(rootRow.sha, textSha(host.def.text({})), '指纹必须对应它投的那段文本');
  const sum = usageSummary(a.landing);
  assert.equal(sum.sessions, 0, '根通道的投递不算"某个会话收到过"（计数器语义要分清）');
  assert.equal(sum.rootEmission.sha, rootRow.sha);
});
