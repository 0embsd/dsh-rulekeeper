// dsh-rulekeeper · 多项目同时在线的止血用例（方案"甲"，2026-09-20）
//
// 背景（如实登记的设计边界）：`systemPrompt.context()` 的 provider **拿不到 agent**，只能靠
//   "最后一次 pre-step 记下的目录"猜是哪个项目 ⇒ 同一进程里开着两个不同项目的会话时，
//   last-writer-wins，提醒可能**串到另一个项目的落点**（张冠李戴）。
// 止血口径：**只有拿不到 agent 的那条通道**受影响；发现"两条以上不同会话目录在线"时
//   只投**用户级落点**（与项目无关，绝不会张冠李戴）；单会话/同项目多会话时行为不变。
//   有 agent 的 `agent/pre-step` 全文通道**永远按各自会话精确解析**（不受此限）。
//
// 判据：①liveCwds 能看出多项目 ②provider 在多项目下取用户级落点 ③单项目下仍取项目落点（不变）
//      ④多项目但**没有**用户级落点 ⇒ 空串（不猜、不说错话） ⑤带 agent 的解析在多项目下仍然精确

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createLandingResolver, liveCwds } from '../src/landing.mjs';
import { registerDelivery } from '../src/deliver.mjs';
import { cleanupAll, freshProjectLanding, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const agentAt = (cwd) => ({ id: `a-${cwd}`, session: { header: { cwd } } });

/** 造"两个不同项目 + 一个（可选）用户级落点"的环境 */
function twoProjects(label, { userLanding = true } = {}) {
  const a = freshProjectLanding(`${label}-a`, { entries: [], projectLanding: true, userLanding: false });
  const b = freshProjectLanding(`${label}-b`, { entries: [], projectLanding: true, userLanding: false });
  // 两个项目各自的账本内容不同：A 是 CAT-AAA，B 是 CAT-BBB（便于断言"拿的是谁的"）
  const ts = '2026-09-20T00:00:00.000Z';
  const row = (id, rule) => JSON.stringify({ schema: 1, id, ts, rule, category: '纪律', problem: 'p', root_cause: 'r', solution: 's', evidence: [], mechanism: 'm', recurrence: 1, first_seen: ts, last_seen: ts, status: 'active' });
  writeFileSync(join(a.landing, 'ledger.jsonl'), `${row('A1', 'CAT-AAA')}\n`, 'utf8');
  writeFileSync(join(b.landing, 'ledger.jsonl'), `${row('B1', 'CAT-BBB')}\n`, 'utf8');
  if (!userLanding) return { a, b, env: { DSH_HOME: join(tempDir(`${label}-nohome`), 'none') } };
  const home = join(tempDir(`${label}-home`), 'dsh');
  const user = join(home, 'lessonflow');
  mkdirSync(user, { recursive: true });
  writeFileSync(join(user, 'config.json'), `${JSON.stringify({ schema: 1, mode: 'observe' })}\n`, 'utf8');
  writeFileSync(join(user, 'rules.json'), JSON.stringify({ schema: 1, project: 'user', protected_paths: [], gates: [], checks: [], inject: [] }), 'utf8');
  writeFileSync(join(user, 'ledger.jsonl'), `${row('U1', 'USER-CCC')}\n`, 'utf8');
  return { a, b, env: { DSH_HOME: home }, userLanding: user };
}

test('判据: liveCwds 能看出"多项目同时在跑"（同一项目多会话只算一处）', () => {
  const { a, b } = twoProjects('mp-livecwds');
  assert.equal(liveCwds({ agents: { roots: () => [agentAt(a.projectRoot)] } }).size, 1, '单会话 = 一处');
  assert.equal(liveCwds({ agents: { roots: () => [agentAt(a.projectRoot), agentAt(a.projectRoot)] } }).size, 1, '同项目多会话仍是一处');
  assert.equal(liveCwds({ agents: { roots: () => [agentAt(a.projectRoot), agentAt(b.projectRoot)] } }).size, 2, '两个项目 = 两处');
  assert.equal(liveCwds({ agents: { roots: () => [] } }).size, 0);
});

test('判据（止血核心）: 多项目在线 ⇒ 索引通道只取**用户级**落点，绝不按某一方项目投', () => {
  const { a, b, env, userLanding } = twoProjects('mp-stopgap');
  const ctx = { agents: { roots: () => [agentAt(a.projectRoot), agentAt(b.projectRoot)] } };
  const r = createLandingResolver(ctx, { env, cwdOf: () => a.projectRoot });
  const d = r.describe();                 // 拿不到 agent 的通道 = provider 的处境
  assert.equal(d.source, 'user-multi-project');
  assert.equal(d.dir, userLanding);
  assert.notEqual(d.dir, a.landing, '不得按 A 项目投');
  assert.notEqual(d.dir, b.landing, '不得按 B 项目投');
});

test('判据: 单项目在线 ⇒ 行为不变（仍按项目落点投，不能因为止血把功能砍了）', () => {
  const { a, env } = twoProjects('mp-single');
  const ctx = { agents: { roots: () => [agentAt(a.projectRoot)] } };
  const r = createLandingResolver(ctx, { env, cwdOf: () => a.projectRoot });
  const d = r.describe();
  assert.equal(d.source, 'project');
  assert.equal(d.dir, a.landing);
});

test('判据: 带 agent 的解析（pre-step 全文通道）在多项目下**仍然精确**，不受止血影响', () => {
  const { a, b, env } = twoProjects('mp-agent-precise');
  const ctx = { agents: { roots: () => [agentAt(a.projectRoot), agentAt(b.projectRoot)] } };
  const r = createLandingResolver(ctx, { env, cwdOf: () => a.projectRoot });
  assert.equal(r.describe(agentAt(a.projectRoot)).dir, a.landing, 'A 的会必须解析到 A 的落点');
  assert.equal(r.describe(agentAt(b.projectRoot)).dir, b.landing, 'B 的会必须解析到 B 的落点');
});

test('判据: 多项目但**没有**用户级落点 ⇒ 空串（宁可不说，也不说错话）', () => {
  const { a, b, env } = twoProjects('mp-nouser', { userLanding: false });
  const ctx = { agents: { roots: () => [agentAt(a.projectRoot), agentAt(b.projectRoot)] } };
  const r = createLandingResolver(ctx, { env, cwdOf: () => a.projectRoot });
  const d = r.describe();
  assert.equal(d.dir, null);
  assert.equal(d.source, 'multi-project-no-user-landing');
  assert.match(String(d.source), /multi-project/);
});

test('判据（端到端）: 投递 provider 在多项目下产出的是**用户级**纪律，而非任一项目', () => {
  const { a, b, env } = twoProjects('mp-deliver');
  const ctx = { agents: { roots: () => [agentAt(a.projectRoot), agentAt(b.projectRoot)] }, effect: (fn) => fn(), systemPrompt: { context: (def) => { ctx.def = def; } } };
  const r = createLandingResolver(ctx, { env, cwdOf: () => a.projectRoot });
  const d = registerDelivery(ctx, { resolveLanding: () => r.describe() });
  assert.equal(d.ok, true);
  const text = ctx.def.text({});
  assert.match(text, /USER-CCC/, `多项目下应投用户级纪律；实际：\n${text}`);
  assert.ok(!/CAT-AAA|CAT-BBB/.test(text), '绝不能出现任一项目的纪律');
  assert.equal(d.report().landingSource, 'user-multi-project');
});
