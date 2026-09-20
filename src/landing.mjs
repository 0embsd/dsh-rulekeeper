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

import { pathKey, resolveProjectLanding, resolveUserLanding } from './platform/paths.mjs';

/** 宿主 Agent → 会话工作目录（**唯一取值点**；形状见 dsh-agent 的 `session.header.cwd`） */
export function agentCwd(agent) {
  const cwd = agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : null;
}

/**
 * **无 inject 要求**地读一个可选宿主服务（2026-09-20 晚补，用真 cordis 实测过）。
 *
 * 为什么需要它：`agents` / `userQuestions` 属**可选能力**，不该写进 `inject`（写进去 = 缺服务就不装载）；
 *   但直接读未声明的服务会**抛** `cannot get property "X" without inject` ⇒ 功能静默失效。
 *   正解是 `ctx.reflect.get(name)`：文档逐字"Read a service from the store **without the inject requirement**"，
 *   实测能读到祖先 fiber 提供的服务（same-instance）。
 * @returns {object|null} 服务对象；没有/形态不符/任何异常 ⇒ null（**永不抛**）
 */
export function readOptionalService(ctx, name) {
  if (ctx === null || typeof ctx !== 'object') return null;
  try {
    if (ctx.reflect !== null && typeof ctx.reflect === 'object' && typeof ctx.reflect.get === 'function') {
      const svc = ctx.reflect.get(name);            // ① 无 inject 要求
      if (svc !== null && typeof svc === 'object') return svc;
    }
  } catch { /* 落到下一档 */ }
  try {
    const svc = ctx[name];                          // ② 已 inject 或夹具（普通对象）
    return svc !== null && typeof svc === 'object' ? svc : null;
  } catch {
    return null;
  }
}

/**
 * **所有活着的根 agent**（宿主 `agents` 服务的形态**只在这里适配一次**；取不到 ⇒ 空数组，绝不抛）。
 *
 * 单一事实源：`liveCwds()`（广域实时判据）、`registryCwd()`（兜底来源）与插件层的
 * "根通道让路判定"（每个在册会话是否都有自己的通道）**共用**这一处取值逻辑 ——
 * 三者各自 `agents.roots()/list()` 一遍就会漂移（一处改成 `list` 另一处忘改，判定就静默失效）。
 * @returns {object[]}
 */
export function liveRootAgents(ctx) {
  try {
    const agents = readOptionalService(ctx, 'agents');
    if (agents === null) return [];
    const list = typeof agents.roots === 'function' ? agents.roots()
      : (typeof agents.list === 'function' ? agents.list() : null);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** `ctx.agents` 注册表里的根 agent cwd（服务形态不符时**当作取不到**，绝不抛） */
export function registryCwd(ctx) {
  for (const agent of liveRootAgents(ctx)) {
    const cwd = agentCwd(agent);
    if (cwd !== null) return cwd;
  }
  return null;
}

/**
 * 能力声明（**单一事实源**：文档/报告都读这里，避免与实现漂移）。
 * @returns {{sources: string[], resolution: string, unresolved: string}}
 */
export function landingCapability() {
  return {
    sources: ['static', 'project', 'user-fallback', 'user-multi-project', 'multi-project-no-user-landing', 'none'],
    resolution: 'static > agent.session.header.cwd（现场，最准）> noteAgent() 最近 cwd > ctx.agents 根 agent cwd > '
      + 'process.cwd()（宿主进程的工作目录；可观测事实，不是猜路径）；'
      + '解析结果同时给出 `dirs`（**落点集合**，2026-09-21 F-2 修复）：单项目时 = 项目落点 ∪ 用户级落点'
      + '（用户级纪律在任何项目里都该被提醒；项目落点不存在时就是用户级单独一项），'
      + '多项目时 = 只用户级（见下条），都没有 ⇒ 空集（reason 记 no-landing）',

    multiProject: '**拿不到 agent 的通道**（systemPrompt.context 索引/摘要）在"同时有两个以上不同会话目录在线"时'
      + '只投用户级落点（source=user-multi-project）—— 进程级只有一份注册，按任何一方投递都可能张冠李戴；'
      + '只有**一个**会话目录在线时不存在歧义，故投"项目落点 ∪ 用户级落点"（并集）——'
      + '根通道只在"有会话没有自己的通道"（注册失败 / 首轮窗口）时出话，若那时只给项目落点，'
      + '那个会话就永远收不到用户级纪律（与 F-2 同一失效形态，发生在兜底路径上）；'
      + '有 agent 的通道（agent/pre-step 全文）不受此限，永远按各自会话精确解析',
    unresolved: 'null —— 不投递、不猜路径、不硬编码家目录（reason 记 no-landing）',
  };
}

/** `process.cwd()` 作为**最后一档**来源（2026-09-20 补）
 *
 * 为什么它可以算"事实"而不是"猜路径"：插件跑在**宿主进程**里，进程的工作目录是操作系统给出的可观测值
 *   （与 CLI 侧 `projectRootOf(args, process.cwd())` 同一口径），不是我们编出来的目录。
 * 为什么必须补它：线上实测（2026-09-20 重启后）两条自动通道**一条提醒都没发**
 *   （全盘没有任何 `usage.json`），而同一份代码在测试里对任何合理 cwd 都能解析出落点并产出 589–842 字符
 *   ⇒ 说明真实进程里前四档来源全都没拿到值（事件还没来 / 注册表为空）。没有这一档，落点解析在
 *   "刚启动、还没有 agent" 的窗口里恒为 null，通道就是**静默哑的**。
 * 仍然守住底线：**只把它当来源，不当真相** —— 取不到就返回 null（不投递），并把 source 如实报出来。
 */
function processCwd() {
  const cwd = process.cwd();
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : null;
}

/**
 * **所有活着的根 agent 的会话目录**（去重）。用途：判断"是不是有多个不同项目同时在跑"。
 *
 * 为什么需要它（2026-09-20，方案"甲"止血）：`systemPrompt.context()` 的 provider **拿不到 agent**，
 *   只能靠"最后一次 pre-step 记下的目录"猜是哪个项目 ⇒ 多会话时 last-writer-wins，
 *   提醒会**串到另一个项目的落点**（张冠李戴）；而索引通道是**进程级一份注册**，无法按会话取。
 *   止血办法：一旦发现**两处以上不同的会话目录**在线，就**只投用户级落点**
 *   （用户级纪律与项目无关，绝不会张冠李戴）；单会话 / 同项目多会话时行为不变。
 * 注意：`agent/pre-step` 全文通道**不在此列** —— 它拿得到真实 agent，本来就能按各自会话精确解析。
 * @returns {Set<string>} cwd 集合（取不到任何东西 ⇒ 空集，行为退化成旧版）
 */
export function liveCwds(ctx) {
  const out = new Set();
  for (const agent of liveRootAgents(ctx)) {
    const cwd = agentCwd(agent);
    if (cwd !== null) out.add(cwd);
  }
  return out;
}

/**
 * 造一个落点解析器。
 * @param {object} ctx 宿主插件上下文（只读 `agents`；缺失也合法）
 * @param {{staticLanding?: string|null, env?: object, cwdOf?: () => string|null}} [opts]
 * @returns {{resolve: (agent?: object|null) => string|null, describe: (agent?: object|null) => {dir: string|null, source: string}, noteAgent: (agent: object) => void}}
 */
export function createLandingResolver(ctx, { staticLanding = null, env = process.env, cwdOf = processCwd } = {}) {
  let notedCwd = null;
  const describe = (agent = null) => {
    if (typeof staticLanding === 'string' && staticLanding.trim() !== '') {
      const dir = resolveProjectLanding(notedCwd ?? cwdOf() ?? process.cwd(), staticLanding);
      return { dir, source: 'static', dirs: [dir] };
    }
    // ── 方案"甲"止血（2026-09-20）：只在**拿不到 agent** 的那条通道上生效 ──────────────────
    // 拿不到 agent ⇒ 无法知道"这次求值是哪场会在问"（进程级一份注册）⇒ 若同时有多个不同项目在线，
    // 按任何一方投递都可能张冠李戴。此时**只投用户级落点**（与项目无关）。
    // 有 agent 时（`agent/pre-step` 全文通道）走下面的精确链，**不受影响**。
    if (agent === null && liveCwds(ctx).size >= 2) {
      const user = resolveUserLanding(env);
      if (existsSync(user)) return { dir: user, source: 'user-multi-project', dirs: [user] };
      return { dir: null, source: 'multi-project-no-user-landing', dirs: [] };
    }
    const cwd = agentCwd(agent) ?? notedCwd ?? registryCwd(ctx) ?? cwdOf();
    if (cwd === null) return { dir: null, source: 'none', dirs: [] };
    // **并集**（2026-09-21，F-2 残面）：项目落点存在时**也**带上用户级落点。
    // 为什么：单项目在线时"是哪个项目"没有歧义（不构成张冠李戴），而根通道只在**有会话没有自己的
    //   通道**（注册失败 / 首轮窗口）时出话 —— 那时若不带上用户级落点，那个会话就**永远收不到
    //   用户级纪律**（与 F-2 同一失效形态，只是发生在兜底路径上）。
    const dirs = [];
    const project = resolveProjectLanding(cwd);
    if (existsSync(project)) dirs.push(project);
    const user = resolveUserLanding(env);
    if (existsSync(user) && !dirs.some((d) => pathKey(d) === pathKey(user))) dirs.push(user);
    if (dirs.length === 0) return { dir: null, source: 'none', dirs: [] };
    return { dir: dirs[0], source: existsSync(project) ? 'project' : 'user-fallback', dirs };
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
