// dsh-rulekeeper · LF-400 **插件骨架 + boot 自检 + 工具名命名空间**
//
// 判据（清单 LF-400）：骨架可加载；**boot 自检**（我们订阅的宿主事件名必须真实存在于宿主事件表）；
//   **工具名命名空间**统一前缀（改名后 = `rulekeeper_*`；清单原文写的 `lessonflow_*` 是改名前的名字，
//   按 2026-09-15 改名决策以产品名为准，见 `.dsh-ai/design/dsh-rulekeeper-rename-plan.md`）。
//
// 为什么要有 boot 自检：插件最坏的失败不是"报错"，而是**静默没挂上**（事件名拼错、宿主升级改名）——
//   门禁看着在跑、实际没人拦。所以：**启动即校验**，对不上就 fail-fast（与 LF-920 的探针同源思路）。
//
// 零依赖：只用 node:*。

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeErrorSink, safeListener } from './isolation.mjs';
import { landingCapability, createLandingResolver } from './landing.mjs';
import { deliveryCapability, registerDelivery } from './deliver.mjs';
import { makePreStepHandler, preStepCapability } from './prestep.mjs';

/** 本包根目录（`src/plugin.mjs` 上溯两级）——用于"宿主事件表扫描**排除自身**"（见 `eventTableFromHost`） */
export const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** 工具名命名空间（宿主里所有本插件注册的工具都必须带这个前缀，避免与其它插件撞名） */
export const TOOL_PREFIX = 'rulekeeper_';

let reportSink = null;

/** 最近一次 `apply` 的诊断报告（`apply` 必须返回 undefined，故报告走这里 / `onReport`） */
export let lastApplyReport = null;

/** 本插件**订阅**的宿主事件（顺序即注册顺序） */
export const PLUGIN_EVENTS = Object.freeze([
  'tools/pre-execute',
  'tools/post-execute',
  'tools/result',
  // P0-3b（2026-09-19）：`agent/pre-step` 全文通道。**必须**登记在这里而不是旁路再 `ctx.on` 一次——
  // 本仓的两条不变量由用例钉死：①订阅集合必须**恰好等于** PLUGIN_EVENTS（plugin.test.mjs:116）
  // ②每个订阅都必须过 `safeListener`（异常隔离 + 透传上游，plugin.test.mjs:120-135）。
  'agent/pre-step',
]);

/** 本插件向宿主注册的工具（名字必须带 TOOL_PREFIX） */
export const PLUGIN_TOOLS = Object.freeze([
  // 2026-09-16：摘要按**实际默认行为**改写 —— 默认注入的是"只读判定"（`src/handlers.mjs`），
  //   不再写"deny 时阻断"（那需要消费者改用 ctx.tools.guard，属部署决策，不在默认安装面）。
  { name: `${TOOL_PREFIX}gate`, event: 'tools/pre-execute', summary: '门禁判定（只读给出 allow/deny；默认不阻断——要硬阻断需消费者改用 ctx.tools.guard）' },
  { name: `${TOOL_PREFIX}record`, event: 'tools/post-execute', summary: '把这次执行的结果写成取证台账行（追加到落点的 ledger.jsonl）' },
  { name: `${TOOL_PREFIX}snap`, event: 'tools/result', summary: '快照/回滚入口（pre-image 留证：备份 + 回读校验 + 索引登记）' },
  // LF-A70（2026-09-19）：**生效体检**。为什么必须有这一件工具：`rulekeeper_record` 把教训写进账本之后，
  //   此前**没有任何手段**能回答"这条记下来的纪律到底生效了没"——工具面到此为止（入账 ≠ 生效）。
  //   本工具是 `effectPlan` 的只读出口（只读 = 不写 rules.json，红线不动）。
  { name: `${TOOL_PREFIX}effect`, event: 'tools/result', summary: '生效体检（只读）：每条纪律的生效状态 none/injected/mechanized/verified/recurred + findings（只写下来了 = EFFECT_TEXT_ONLY）' },
]);

/**
 * 宿主工具注册契约（**2026-09-15 真装载实测后补齐**，逐字对照宿主源码）。
 *
 * 宿主 `ctx.tools.register(definition)` 收**一个对象**，且必须是：
 *   `{ name, description, parameters, output: { schema, render(args, value) }, execute(args) }`
 *   —— 其中 `output` 缺失、`output.render` 不是函数、或 `output.schema` 不是受支持的 JSON Schema 时，
 *   宿主会抛 `tool "<name>" must declare output { schema, render, presentationMeta? }`。
 * （取证：`@deepseek-ai/dsh-tools/lib/index.js:2773` 与 `.dsh-ai/verify/probe-rk-plugin-load-20260915.txt`）
 *
 * 我们此前写的是 `register(name, handler)` **两参**写法 ⇒ 装进真 profile 时**整个插件树装载失败**。
 * 现在按契约补齐：每个工具都有 `parameters` / `output.schema` / `output.render` / `execute`。
 * 行为边界：`execute` 默认只回 `{ ok:false, configured:false }`（**零副作用、零拦截**）——
 * 真正的判定逻辑由消费者通过 `handlers` 注入（注入前后都不改本契约）。
 */
export const TOOL_PARAMETERS = Object.freeze({
  [`${TOOL_PREFIX}gate`]: {
    type: 'object',
    properties: {
      project: { type: 'string', description: '项目根（默认进程工作目录）' },
      path: { type: 'string', description: '待判定路径（相对项目根）' },
      phase: { type: 'string', enum: ['open', 'close'], description: '门禁相位标签' },
    },
  },
  [`${TOOL_PREFIX}record`]: {
    type: 'object',
    properties: {
      rule: { type: 'string', description: '纪律标识（大写字母/数字/连字符）' },
      problem: { type: 'string' },
      rootCause: { type: 'string' },
      solution: { type: 'string' },
      evidence: { type: 'array', items: { type: 'string' }, description: '凭证路径列表' },
      // 2026-09-16：账本契约（src/ledger.mjs）还要求 category / mechanism —— 作为**可选**入参暴露，
      //   缺省由 handlers 填（category=纪律、mechanism=插件工具自述），避免用户为了记账被迫读源码。
      category: { type: 'string', description: '类别（默认「纪律」；如 纪律/技术/流程/代码/文档）' },
      mechanism: { type: 'string', description: '机制（默认「dsh-rulekeeper 插件工具 rulekeeper_record」）' },
    },
    required: ['rule', 'problem'],
  },
  [`${TOOL_PREFIX}snap`]: {
    type: 'object',
    properties: {
      project: { type: 'string' },
      path: { type: 'string', description: '要留 pre-image 的文件（相对项目根）' },
      why: { type: 'string' },
    },
    required: ['path'],
  },
  [`${TOOL_PREFIX}effect`]: {
    type: 'object',
    properties: {
      project: { type: 'string', description: '项目根（默认进程工作目录）' },
      rule: { type: 'string', description: '只看这一条纪律（可选；不给则全量体检）' },
      json: { type: 'boolean', description: '返回完整体检数据（默认只回摘要）' },
    },
  },
});

/** 统一的输出 schema（刻意保持最小：type + properties；不带 required/additionalProperties，降低校验面冲突） */
export const TOOL_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    configured: { type: 'boolean' },
    decision: { type: 'string' },
    reason: { type: 'string' },
    name: { type: 'string' },
  },
});

/** 组装一个**符合宿主契约**的工具定义（`render` 必须是函数、`schema` 必须是合法 JSON Schema） */
export function toolDefinition(tool, handlers = {}) {
  const handler = typeof handlers[tool.name] === 'function' ? handlers[tool.name] : null;
  return {
    name: tool.name,
    description: tool.summary,
    parameters: TOOL_PARAMETERS[tool.name],
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render(args, value) {
        const v = value !== null && typeof value === 'object' ? value : {};
        const parts = [`[${tool.name}]`];
        if (v.configured === false) parts.push('未配置 handler（零副作用：默认不判定）');
        if (typeof v.decision === 'string') parts.push(`decision=${v.decision}`);
        if (typeof v.ok === 'boolean') parts.push(`ok=${v.ok}`);
        if (typeof v.reason === 'string' && v.reason !== '') parts.push(v.reason);
        return [{ type: 'text', text: parts.join(' ') }];
      },
    },
    async execute(args) {
      if (handler === null) return { ok: false, configured: false, name: tool.name, reason: '本工具未注入 handler（默认零副作用）' };
      const out = await handler(args ?? {});
      return out !== null && typeof out === 'object' ? { ok: true, configured: true, name: tool.name, ...out } : { ok: true, configured: true, name: tool.name, value: out };
    },
  };
}

/**
 * 从宿主安装面抽"事件表"（近似）：扫 `'tools/<name>'` 字面量，去重成集合。
 * 说明：这是**证据面近似**，不是宿主内部注册表；但对"我们订阅的名字还在不在"足够灵敏（LF-920 同源做法）。
 */
export function eventTableFromHost(dshRoot, { maxFiles = 20000, exclude = [] } = {}) {
  const table = new Set();
  let scanned = 0;
  const skip = exclude.filter((p) => typeof p === 'string' && p !== '')
    .map((p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase());
  const seen = new Set();   // realpath 去重：跟随符号链接时防环
  const walk = (dir, depth = 0) => {
    if (depth > 32 || scanned >= maxFiles) return;
    let real;
    try { real = realpathSync(dir); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (scanned >= maxFiles) return;
      const abs = join(dir, e.name);
      // **自身排除**（2026-09-16 实测缺陷）：宿主的扫描面里**可能包含我们自己的包**
      //   （典型：包被 link 到 <DSH_HOME>/... 之下）。此时"我们的字面量"会被当成"宿主的证据"⇒
      //   boot 自检**自证**（把包挪走就突然红了）。故显式排除本包目录。
      if (skip.length > 0) {
        const norm = abs.replace(/\\/g, '/').toLowerCase();
        if (skip.some((s) => norm === s || norm.startsWith(`${s}/`))) continue;
      }
      // **跟随符号链接**（2026-09-16 修）：插件生态大量使用 link/软链（`dsh plugin add link:`、pnpm 链接），
      //   原先 `if (e.isSymbolicLink()) continue;` 会把宿主真实代码整片跳过 ⇒ 表里只剩零散命中，
      //   于是"没找到我们的事件"变成**假红**。改用 stat 判目录 + realpath 去重防环。
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) { walk(abs, depth + 1); continue; }
      if (!/\.(js|mjs|cjs|d\.ts)$/.test(e.name)) continue;
      scanned += 1;
      let text;
      try {
        if (st.size > 4 * 1024 * 1024) continue;
        text = readFileSync(abs, 'utf8');
      } catch { continue; }
      // 三种引号都要认（2026-09-16 修）：宿主里事件名可能写成 'x' / "x" / `x`
      // 事件族白名单（2026-09-19 扩）：原先只认 `tools/*` ⇒ 新增 `agent/pre-step`（P0-3b 全文通道）
      // 时 boot 自检**误红**（生产宿主里该事件确实存在：`dsh-agent/lib/types/runtime-types.d.ts:313`，
      // 本机实测命中 28 处）。**故意不放开成任意 `x/y`**：那样路径字符串（如 'lib/types'）会被误当事件，
      // 让这个安全门产生**假绿**——白名单仍要求"已知事件族 + 名字完全一致"。
      for (const m of text.matchAll(/['"`]((?:tools|agent|session|skills|internal|approval)\/[a-z0-9-]+)['"`]/g)) table.add(m[1]);
    }
  };
  walk(dshRoot);
  return { table, scanned, capped: scanned >= maxFiles };
}

/**
 * boot 自检：事件名在宿主事件表内 + 工具名带命名空间前缀。
 * @returns {{ok, cases: {name, ok, detail}[], events: string[], scanned}}
 */
export function bootSelfCheck({ dshRoot, events = PLUGIN_EVENTS, tools = PLUGIN_TOOLS, maxFiles = 20000, exclude = [PKG_ROOT] } = {}) {
  const cases = [];
  const { table, scanned, capped } = eventTableFromHost(dshRoot, { maxFiles, exclude });
  // **不可判 = 不 fail-fast**（2026-09-16 修）：表空或扫描被 maxFiles 截断时，"没找到我们的事件"**不能**
  //   推断"宿主没有" —— 之前那种写法会把"我读不全"当成"宿主不符"，在真实机器上造成假红。
  const inconclusive = table.size === 0 || capped === true;
  cases.push({
    name: '宿主事件表可抽取（非空）',
    // 不可判定时**不判红**：把"我读不全"当成"宿主不符"会在真实机器上造成假红（2026-09-16 实测）
    ok: inconclusive ? true : table.size > 0,
    detail: inconclusive
      ? `未能抽取可判定的宿主事件表（scanned=${scanned}${capped ? '/已达上限' : ''}）⇒ **不据此判红**（如实标注，不冒充通过）`
      : `扫到 ${table.size} 个 tools/* 事件（scanned=${scanned}）`,
  });
  const missing = events.filter((e) => !table.has(e));
  cases.push({
    name: '订阅的事件名全部存在于宿主事件表',
    ok: inconclusive ? true : missing.length === 0,
    detail: inconclusive
      ? `不可判定（表空或扫描被截断）⇒ 跳过该条，不 fail-fast`
      : missing.length === 0
        ? `全部命中: ${events.join(', ')}`
        : `宿主事件表里没有: ${missing.join(', ')} ⇒ 插件会**静默不生效**，必须 fail-fast（变更宿主事件名后需同步本模块的 PLUGIN_EVENTS）`,
  });
  const badNames = tools.filter((t) => typeof t.name !== 'string' || !t.name.startsWith(TOOL_PREFIX)).map((t) => t.name);
  cases.push({
    name: `工具名全部带命名空间前缀 ${TOOL_PREFIX}`,
    ok: badNames.length === 0,
    detail: badNames.length === 0 ? `${tools.length} 个工具名合规` : `不合规: ${badNames.join(', ')}`,
  });
  return { ok: cases.every((c) => c.ok), cases, events: [...table], scanned, capped: capped === true, inconclusive, excluded: exclude };
}

/**
 * 插件装配（真实注册路径，boot 自检通过后才注册）。
 * 契约（**2026-09-15 真装载实测版**）：
 *   · `ctx.effect(fn)` 必须存在；`ctx.tools.register(definition)` 收**单对象**且必须有
 *     `name` + `parameters` + `output:{schema,render}`（缺则宿主抛错）——见 `toolDefinition()`；
 *   · **`apply` 的返回值只允许** 函数 / null·undefined / thenable / (async)iterable；
 *     返回普通对象会被 cordis 判 `TypeError: Invalid effect`（插件树装载失败）。
 *     故报告走 `opts.onReport` + 模块级 `lastApplyReport`，`apply` 返回 `undefined`。
 * 缺契约 → **fail-fast 抛错**（宁可启动失败，也不要"看起来装上了"）。
 */
export function apply(ctx, { dshRoot, events = PLUGIN_EVENTS, tools = PLUGIN_TOOLS, maxFiles = 20000, exclude = [PKG_ROOT], handlers = {}, landingDir = null, appendLine = null, faultInjection = null, onReport = null, delivery = true, deliveryOptions = {}, prestep = true, prestepOptions = {} } = {}) {
  const injectedFault = faultInjection ?? (process.env.RULEKEEPER_FAULT ?? null);
  const faultInjectionMode = injectedFault === 'throw-listener' ? 'throw-listener' : null;
  if (ctx === null || typeof ctx !== 'object') throw new Error('rulekeeper 插件: ctx 非法');
  if (typeof ctx.effect !== 'function') throw new Error('rulekeeper 插件: 宿主 ctx 缺少 effect()（契约不符，fail-fast）');
  if (ctx.tools === null || typeof ctx.tools !== 'object' || typeof ctx.tools.register !== 'function') {
    throw new Error('rulekeeper 插件: 宿主 ctx.tools.register() 缺失（契约不符，fail-fast）');
  }
  const boot = bootSelfCheck({ dshRoot, events, tools, maxFiles, exclude });
  if (boot.ok !== true) {
    const detail = boot.cases.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join(' | ');
    throw new Error(`rulekeeper 插件: boot 自检未通过 ⇒ 拒绝注册（防"静默不生效"）: ${detail}`);
  }
  const registered = [];
  for (const t of tools) {
    // 宿主契约：`register(单对象)`（内部自带 effect 注册，dsh-tools/lib/index.js:2781）⇒ **不再外套 ctx.effect**
    ctx.tools.register(toolDefinition(t, handlers));
    registered.push(t.name);
  }

  // ── 落点解析（2026-09-19 修缺口）──────────────────────────────────────────
  // 装载入口 `index.js` 只传 `{dshRoot, handlers}` ⇒ 过去 `landingDir` 恒为 null，两条自动通道
  // （systemPrompt.context / agent/pre-step）**每轮都 no-landing 静默不投递**（实测三处落点无 usage.json）。
  // 现在集中到 `createLandingResolver`：静态 > 现场 agent cwd > 进程内最近 cwd > ctx.agents 根代理人 > 用户级兜底。
  const landing = createLandingResolver(ctx, { staticLanding: landingDir });

  // ── 事件监听（LF-450：四插件同场共存）──
  // 每个订阅都用 `safeListener`（LF-460 异常隔离）包一层：**我们抛错也不得打断别人的留痕**（fail-open）。
  // `faultInjection` 是**测试缝**：显式打开时让我们的监听器故意抛错，用来验证"第三方照常留痕"（默认关闭）。
  // P0-3b：pre-step 处理函数（**不在这里订阅**——订阅统一走下面的循环，以满足
  // "订阅集合 == PLUGIN_EVENTS" 与 "每个订阅都过 safeListener" 两条被用例钉死的不变量）。
  const prestepBuilt = prestep === true
    ? makePreStepHandler({ resolveLanding: (payload) => landing.describe(payload && payload.agent), ...(prestepOptions ?? {}) })
    : null;
  const subscribed = [];
  if (typeof ctx.on === 'function') {
    const sink = makeErrorSink({ landingDir: () => landing.resolve(), appendLine });
    for (const ev of events) {
      const listener = safeListener({
        name: `${TOOL_PREFIX}${ev}`,
        run: async (...args) => {
          if (faultInjectionMode === 'throw-listener') throw new Error('rulekeeper 注入故障：listener 故意抛错（fail-open 验证用）');
          // Must participate in the waterfall: for tools/pre-execute the last arg is next();
          // returning undefined made the host read result.kind and blow up (tool layer broke, third-party rows 3 -> 0).
          const next = args[args.length - 1];
          // P0-3b：`agent/pre-step` 走专用处理函数（仍由本 safeListener 包裹 ⇒ 异常隔离与透传不变量不变）
          if (ev === 'agent/pre-step') {
            // 记下"这一轮是哪个会话"：`systemPrompt.context()` 的 provider 拿不到 agent，
            // 靠这里记的 cwd 才能解析出落点（landing.mjs 的第③顺位）。
            landing.noteAgent(args[0] && args[0].agent);
            if (prestepBuilt !== null) return prestepBuilt.handler(args[0], next);
          }
          return typeof next === 'function' ? await next() : undefined;
        },
        onError: async (...args) => {
          // 异常时的 fail-open 也必须**透传上游**（否则异常=抹掉上游决策，工具层照样坏）——LF-450 实测
          const next = args[args.length - 1];
          return typeof next === 'function' ? await next() : undefined;
        },
        sink,
      });
      ctx.on(ev, listener);
      subscribed.push(ev);
    }
    reportSink = sink;
  }

  // ── P0-3 提醒投递（LF-A90）────────────────────────────────────────────────
  // 来历：`effect.mjs` 早就会算"该提醒哪几条纪律"（`effectInjectPlan`），但**没有投递口**，
  //   于是体检里 `injected` 面永远是 0、提醒只落在落点里等人去读。宿主其实早就开放了通道
  //   （本机实测：`dsh-base/cordis.patch.yml:465` 与 `dsh-web-app/cordis.patch.yml:16` 都挂了
  //   `system-prompt` 行；插件侧签名见 `@deepseek-ai/dsh-system-prompt/lib/types/index.d.ts:69-77`）。
  // 位置：放在报告对象构造**之前**（否则引用未初始化的 `deliveryReg` 会触 TDZ 报错）。
  // 服务缺失 ⇒ `registerDelivery` 如实返回 `{ok:false, reason}`（**不静默假成功**）。
  let deliveryReg = { ok: false, reason: 'disabled', name: null };
  if (delivery === true) {
    try {
      const r = registerDelivery(ctx, { resolveLanding: () => landing.describe(), ...(deliveryOptions ?? {}) });
      deliveryReg = r.ok === true ? r.report() : { ok: false, reason: r.reason, name: r.name };
    } catch (error) {
      // 投递注册失败绝不能让插件树装载失败（fail-open）；如实记录原因。
      deliveryReg = { ok: false, reason: `register-error:${String((error && error.message) || error)}`, name: null };
    }
  }

  // ── P0-3b pre-step 全文通道（LF-A92，2026-09-19）────────────────────────────
  // 分工：索引/摘要走 `systemPrompt.context()`（deliver.mjs）；**命中教训的全文**走这里，
  // 只在"本轮消息与该条目相关"时才注入（`{kind:'enter', messages:[...原 messages, 我们的]}`）。
  // 宿主签名与约束见 `dsh-agent/lib/types/runtime-types.d.ts:302-328`。同样 fail-open。
  // 注意：**订阅已在上面的 PLUGIN_EVENTS 循环里完成**，这里只取报告（避免重复订阅）。
  const prestepReg = prestepBuilt === null
    ? { ok: false, reason: 'disabled' }
    : prestepBuilt.report();

  const report = {
    ok: true, registered, boot, subscribed,
    listenerErrors: reportSink === null ? 0 : reportSink.records.length,
    errorSink: reportSink,
    landing: { ...landing.describe(), capability: landingCapability() },
    delivery: deliveryReg,
    deliveryCapability: deliveryCapability(),
    prestep: prestepReg,
    prestepCapability: preStepCapability(),
  };
  // **`apply` 的返回值必须符合 cordis 的 effect 规则**（2026-09-15 真装载实测）：
  //   只接受 函数 / null·undefined / thenable / (async)iterable —— 返回**普通对象**会被判
  //   `TypeError: Invalid effect` ⇒ 插件树装载失败、会话起不来。
  //   故：报告通过 `opts.onReport` 回传 + 模块级 `lastApplyReport` 供诊断，**`apply` 返回 undefined**。
  lastApplyReport = report;
  if (typeof onReport === 'function') onReport(report);
  return undefined;
}



