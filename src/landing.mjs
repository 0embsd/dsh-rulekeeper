// landing.mjs —— 插件运行时「当前落点」的**唯一接线点**（2026-09-19，P0-3 实装时抓出的缺口）
//
// 缺口（实测，不是推断）：插件装载入口 `index.js` 只传 `{ dshRoot, handlers }`，**从不传 `landingDir`**
//   ⇒ `apply()` 的默认 `landingDir = null` 一路传到 `registerDelivery()` 与 `makePreStepHandler()`
//   ⇒ 两条**自动**通道（`systemPrompt.context()` / `agent/pre-step`）每轮都拿到 `no-landing` 而**静默不投递**：
//      · 实测三处落点（项目级、用户级、以及"会话工作目录下"这一形态）**都没有 `usage.json`**（遥测从未被写过）；
//      · 而同一时刻 `buildReminderText()` 对真实落点返回 **3 条 / 589–842 字符**（有话可说）。
//   ⇒ 典型「有实现 + 有用例 ≠ 已接线」（规则 44 的**取值面**版本：import 可达 ≠ 真的拿到了值）。
//
// 修法：把"落点从哪来"集中到本模块，顺序固定且**可报**（`source`）：
//   ① `staticLanding`（调用方显式指定，最高优先）
//   ② 现场 agent 的会话 cwd（`agent/pre-step` 的 payload 直接带 `agent`，最准）
//   ③ 进程内最近一次见过的 cwd（`noteAgent`；供"没有 agent 入参"的 systemPrompt.context 通道用）
//   ④ `ctx.agents` 注册表里的根 agent cwd（进程刚起、首个 pre-step 之前也能解析）
//   ⑤ 项目落点不存在时退**用户级落点**（`<DSH_HOME>/rulekeeper`，老 `lessonflow` 兼容）
//   ⑥ 都取不到 ⇒ 如实返回 `null`（**不投递、不猜、不硬编码家目录**）
//
// 归属：插件接线层。零依赖：只用 node:* 与本包 platform/paths。

import { existsSync } from 'node:fs';

import { resolveProjectLanding, resolveUserLanding } from './platform/paths.mjs';

/** 宿主 Agent → 会话工作目录（**唯一取值点**；形状见 dsh-agent 的 `session.header.cwd`） */
export function agentCwd(agent) {
  const cwd = agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : null;
}

/** `ctx.agents` 注册表里的根 agent cwd（服务形态不符时**当作取不到**，绝不抛） */
export function registryCwd(ctx) {
  try {
    const agents = ctx === null || typeof ctx !== 'object' ? null : ctx.agents;
    if (agents === null || typeof agents !== 'object') return null;
    const list = typeof agents.roots === 'function' ? agents.roots()
      : (typeof agents.list === 'function' ? agents.list() : null);
    if (!Array.isArray(list)) return null;
    for (const agent of list) {
      const cwd = agentCwd(agent);
      if (cwd !== null) return cwd;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * 能力声明（**单一事实源**：文档/报告都读这里，避免与实现漂移）。
 * @returns {{sources: string[], resolution: string, unresolved: string}}
 */
export function landingCapability() {
  return {
    sources: ['static', 'project', 'user-fallback', 'none'],
    resolution: 'static > agent.session.header.cwd（现场，最准）> noteAgent() 最近 cwd > ctx.agents 根 agent cwd；'
      + '项目落点不存在 ⇒ 退用户级落点（<DSH_HOME>/rulekeeper，老 lessonflow 兼容）',
    unresolved: 'null —— 不投递、不猜路径、不硬编码家目录（reason 记 no-landing）',
  };
}

/**
 * 造一个落点解析器。
 * @param {object} ctx 宿主插件上下文（只读 `agents`；缺失也合法）
 * @param {{staticLanding?: string|null, env?: object}} [opts]
 * @returns {{resolve: (agent?: object|null) => string|null, describe: (agent?: object|null) => {dir: string|null, source: string}, noteAgent: (agent: object) => void}}
 */
export function createLandingResolver(ctx, { staticLanding = null, env = process.env } = {}) {
  let notedCwd = null;
  const describe = (agent = null) => {
    if (typeof staticLanding === 'string' && staticLanding.trim() !== '') {
      return { dir: resolveProjectLanding(notedCwd ?? process.cwd(), staticLanding), source: 'static' };
    }
    const cwd = agentCwd(agent) ?? notedCwd ?? registryCwd(ctx);
    if (cwd === null) return { dir: null, source: 'none' };
    const project = resolveProjectLanding(cwd);
    if (existsSync(project)) return { dir: project, source: 'project' };
    // 项目自己没有落点 ⇒ 退用户级（用户级纪律本就该在**任何**项目里被提醒）
    const user = resolveUserLanding(env);
    if (existsSync(user)) return { dir: user, source: 'user-fallback' };
    return { dir: null, source: 'none' };
  };
  return {
    resolve: (agent = null) => describe(agent).dir,
    describe,
    noteAgent: (agent) => {
      const cwd = agentCwd(agent);
      if (cwd !== null) notedCwd = cwd;
    },
  };
}
