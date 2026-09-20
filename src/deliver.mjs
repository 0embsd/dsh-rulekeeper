// deliver.mjs —— 提醒投递适配器（P0-3）
//
// 背景（L632 更正后的事实）：宿主**早就**给插件开放了"把内容送进上下文"的通道，我们此前
// 误判为"没有"，还写了一份要上游新开能力的 RFC（已作废）。本文件把**已经实现但没有投递口**
// 的提醒真正接上：`effect.mjs` 的 `effectInjectPlan()` 会算出"该提醒哪几条纪律"，
// 这里把它接到宿主 `ctx.systemPrompt.context({name, order, text})`。
//
// 通道选择（依据本机宿主源码实测）：
//   · `systemPrompt.context()` —— `AssembleContext` 只有 `{scope?, signal?}`，返回的文本被宿主
//     **物化为持久 user-role 快照消息**，且**文本相同不追加、变化才 append**（dsh-agent-loop
//     `lib/index.js:890-893` / `:336-355`）。适用于"索引/摘要"这类稳定内容 —— 本文件用它。
//   · `agent/pre-step`（`{kind:'enter', messages}`）—— 适用于"命中某条教训的全文、随本轮现场而定"
//     的内容。**本版未接**（留给下一批；见 REPORT 里的"未做"）。
//   · **绝不进 system prompt 正文**（Hermes `agent/turn_context.py:663-669` 的纪律，也是宿主
//     自身的约束：动态内容必须走 logged channels）。
//
// 三条硬约束（缺一条就会变成"刷屏"或"静默失效"）：
//   ① **文本必须稳定**：宿主按"文本变化"追加，所以文本里不能放时间戳/每次调用都变的计数；
//   ② **跨轮状态**：`injectPlan()` 的 `seenRules` 去重**只在单次调用内有效**（读源码确认），
//      跨轮不持久 ⇒ 若我们不自己记账，同一批提醒每轮都会被重新算成"该投递"；
//   ③ **变化最小间隔**：文本变化时才可能被宿主追加，故对"变化"本身设最小间隔（默认 30 分钟），
//      间隔内即使算出新文本也继续返回上一版，避免抖动造成连续追加。
//
// fail-open：任何异常（落点坏、依赖缺失、宿主 API 变化）一律返回空串或上一版文本，绝不抛。
import { effectInjectPlan } from './effect.mjs';
import { INJECT } from './inject.mjs';
import { bumpUsage } from './usage.mjs';

export const REGISTRY_NAME = 'rulekeeper/reminders';
export const DEFAULT_ORDER = 900;           // 与宿主既有段落错开即可（升序拼接）
export const DEFAULT_MAX_RULES = 3;         // 单次最多提醒几条纪律（预算）
export const DEFAULT_MAX_CHARS = 1200;      // 单次文本上限（预算）
export const DEFAULT_MIN_INTERVAL_MS = 30 * 60 * 1000; // 文本"变化"的最小间隔：30 分钟

/**
 * 纯函数：算出这次该投递的提醒文本（**稳定、可测**，不碰宿主）。
 *
 * **单落点**：传 `landingDir`（旧口径，行为逐字不变）。
 * **并集**：传 `landingDirs`（保序；如 `[项目落点, 用户级落点]`）——同一纪律只念一次，
 *   预算按"轮转"分配：每个落点轮流出一条，**保证每一方都被念到**。
 *   为什么必须轮转（2026-09-21 修 F-2）：若按"项目取满再取用户级"，项目落点占满 `maxRules` 时
 *   用户级纪律又会被饿死——那正是 F-2 的形态（项目会话里 `JUDGEMENT-*` 静默消失）。
 *   `effectInjectPlan` 是**纯计算**（零落点写入），故可对多个落点各算一次。
 * @returns {{text: string, rules: string[], candidates: number, chars: number, truncated: boolean,
 *            landings: string[], attribution: {dir: string, ok: boolean, rules: string[]}[], reason?: string}}
 */
export function buildReminderText({ landingDir, landingDirs, now = new Date(), maxRules = DEFAULT_MAX_RULES, maxChars = DEFAULT_MAX_CHARS } = {}) {
  const empty = { text: '', rules: [], candidates: 0, chars: 0, truncated: false, landings: [], attribution: [] };
  // 落点集合：`landingDirs`（并集）优先，否则退回单个 `landingDir`；去重保序
  const raw = Array.isArray(landingDirs) && landingDirs.length > 0 ? landingDirs : [landingDir];
  const dirs = [];
  for (const d of raw) {
    if (typeof d !== 'string' || d.trim() === '') continue;
    if (!dirs.includes(d)) dirs.push(d);
  }
  if (dirs.length === 0) return { ...empty, reason: 'no-landing' };

  let planFailed = false;
  const columns = [];
  for (const dir of dirs) {
    let plan;
    try {
      plan = effectInjectPlan({ landingDir: dir, now, maxPerSession: maxRules });
    } catch (error) {
      planFailed = true;
      columns.push({ dir, ok: false, entries: [], candidates: 0, reason: `plan-error:${String((error && error.message) || error)}` });
      continue;
    }
    const entries = [];
    for (const m of plan.appended ?? []) {
      const rule = m && typeof m.rule === 'string' && m.rule !== '' ? m.rule : null;
      const text = m && typeof m.text === 'string' ? m.text : '';
      if (rule === null && text === '') continue;
      entries.push({ rule, text });
    }
    columns.push({ dir, ok: plan.ok !== false, entries, candidates: Number.isFinite(plan.candidates) ? plan.candidates : entries.length });
  }

  // 并集去重：同一纪律（同一 `rule`）只念一次，**先出现的落点胜**
  const seen = new Set();
  for (const c of columns) {
    c.entries = c.entries.filter((e) => {
      if (e.rule === null) return true;
      if (seen.has(e.rule)) return false;
      seen.add(e.rule);
      return true;
    });
  }
  // 轮转取条目（第 0 轮：每个落点各一条；第 1 轮：各第二条；直到预算耗尽）
  const depth = columns.reduce((n, c) => Math.max(n, c.entries.length), 0);
  const picked = [];
  for (let i = 0; i < depth && picked.length < maxRules; i += 1) {
    for (const c of columns) {
      if (picked.length >= maxRules) break;
      const e = c.entries[i];
      if (e === undefined) continue;
      picked.push({ rule: e.rule, text: e.text, dir: c.dir });
    }
  }
  const text = picked.map((p) => p.text).filter((t) => t !== '').join('\n');
  const truncated = text.length > maxChars;
  const finalText = truncated ? `${text.slice(0, maxChars - 1)}…` : text;
  const attribution = columns.map((c) => ({
    dir: c.dir,
    ok: c.ok === true,
    rules: picked.filter((p) => p.dir === c.dir && p.rule !== null).map((p) => p.rule),
  }));
  const landings = [];
  for (const p of picked) if (!landings.includes(p.dir)) landings.push(p.dir);
  return {
    text: finalText,
    rules: picked.map((p) => p.rule).filter((r) => r !== null),
    candidates: columns.reduce((n, c) => n + c.candidates, 0),
    chars: finalText.length,
    truncated,
    landings,      // 真正**贡献了文本**的落点（跨重启去重与记账按这个集合逐落点做）
    attribution,   // 每条纪律出自哪个落点（遥测必须记到**它自己的**落点上，不许串账）
    // 如实给出"为什么没话说"（供遥测/诊断区分：落点坏 vs 无可投递内容 vs 预算耗尽）
    reason: finalText === '' ? (planFailed ? 'plan-not-ok' : 'nothing-to-say') : undefined,
  };
}

/** 跨轮运行时状态（每个插件进程一份；**不放时间戳进文本**，只用于记账与防抖） */
export function createDeliveryRuntime({ minIntervalMs = DEFAULT_MIN_INTERVAL_MS } = {}) {
  return {
    minIntervalMs,
    lastText: '',
    lastAt: 0,
    evaluations: 0,
    emissions: 0,   // "返回了新文本"的次数（≠ 模型一定看到；宿主可能因去重不追加）
    holds: 0,       // 因最小间隔而继续返回上一版的次数
    reasons: [],
    lastLanding: { dir: null, source: 'unset' }, // 最近一次求值用的落点与来源（诊断"为什么没话说"）
    lastLandings: [],                            // 最近一次求值用的**落点集合**（并集语义：项目 ∪ 用户级）
  };
}

/**
 * 按运行时状态决定"这次返回什么文本"，并记账。
 * 返回 `{text, emitted, held, shouldCount}`；`emitted=true` 表示这是一版**新**文本。
 */
export function nextDelivery({ runtime, built, now }) {
  const ts = now instanceof Date ? now.getTime() : Date.now();
  runtime.evaluations += 1;
  const text = built.text;
  if (text === '') {
    runtime.reasons.push(built.reason ?? 'nothing-to-say');
    return { text: '', emitted: false, held: false };
  }
  if (text === runtime.lastText) {
    runtime.reasons.push('unchanged');
    return { text, emitted: false, held: false };
  }
  const tooSoon = runtime.lastText !== '' && ts - runtime.lastAt < runtime.minIntervalMs;
  if (tooSoon) {
    runtime.holds += 1;
    runtime.reasons.push('held-min-interval');
    return { text: runtime.lastText, emitted: false, held: true };
  }
  runtime.lastText = text;
  runtime.lastAt = ts;
  runtime.emissions += 1;
  runtime.reasons.push('emitted');
  return { text, emitted: true, held: false };
}

/**
 * 把投递接到宿主。
 * @param {object} ctx 宿主插件上下文（需 `systemPrompt.context`；缺则**不注册**并如实返回原因）
 * @returns {{ok: boolean, reason?: string, name: string, runtime: object, report: function}}
 */
export function registerDelivery(ctx, {
  landingDir = null,
  resolveLanding = null,
  onDelivery = null,
  shouldStaySilent = null,
  order = DEFAULT_ORDER,
  maxRules = DEFAULT_MAX_RULES,
  maxChars = DEFAULT_MAX_CHARS,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  now = () => new Date(),
  name = REGISTRY_NAME,
} = {}) {
  const runtime = createDeliveryRuntime({ minIntervalMs });
  // 落点解析（2026-09-19 修缺口）：静态 `landingDir` 优先；否则每次求值调 `resolveLanding()`
  // （插件层传的是 `landing.mjs` 的解析器 —— 没有它，装载入口不传 landingDir 就永远 no-landing）。
  const pickLanding = () => {
    if (typeof landingDir === 'string' && landingDir.trim() !== '') return { dir: landingDir, source: 'static', dirs: [landingDir] };
    if (typeof resolveLanding === 'function') {
      const r = resolveLanding();
      if (typeof r === 'string' && r.trim() !== '') return { dir: r, source: 'resolver', dirs: [r] };
      if (r !== null && typeof r === 'object' && typeof r.dir === 'string' && r.dir.trim() !== '') {
        const dirs = Array.isArray(r.dirs) ? r.dirs.filter((d) => typeof d === 'string' && d.trim() !== '') : [];
        return { dir: r.dir, source: typeof r.source === 'string' ? r.source : 'resolver', dirs: dirs.length > 0 ? dirs : [r.dir] };
      }
      if (r !== null && typeof r === 'object' && typeof r.source === 'string') return { dir: null, source: r.source, dirs: [] };
      return { dir: null, source: 'resolver-none', dirs: [] };
    }
    return { dir: null, source: 'none', dirs: [] };
  };
  runtime.lastLanding = pickLanding();
  const report = () => ({
    ok: true,
    name,
    order,
    landingDir: runtime.lastLanding.dir,
    landingSource: runtime.lastLanding.source,
    landingBound: runtime.lastLanding.dir !== null,
    evaluations: runtime.evaluations,
    emissions: runtime.emissions,
    holds: runtime.holds,
    lastChars: runtime.lastText.length,
    maxChars,
    maxRules,
  });
  if (ctx === null || typeof ctx !== 'object') return { ok: false, reason: 'no-ctx', name, runtime, report };
  // **读宿主服务必须包 try**（2026-09-20 事故）：cordis 对**未在 `inject` 里声明**的服务，读属性会直接抛
  // `cannot get property "systemPrompt" without inject`；装载期抛错 = 插件树加载失败、DSH 退回 web-safe。
  let hasSystemPrompt = false;
  try {
    hasSystemPrompt = ctx.systemPrompt !== null && typeof ctx.systemPrompt === 'object'
      && typeof ctx.systemPrompt.context === 'function';
  } catch {
    hasSystemPrompt = false;
  }
  if (hasSystemPrompt !== true) {
    // 如实返回原因（不静默）：宿主未挂 systemPrompt 服务时，提醒只能缺省不投递。
    return { ok: false, reason: 'no-systemPrompt-service', name, runtime, report };
  }
  if (typeof ctx.effect !== 'function') return { ok: false, reason: 'no-ctx-effect', name, runtime, report };

  const provider = () => {
    try {
      // **让路**（方案"乙"）：所有会话都已按自己的作用域注册提醒位时，根通道不再出话，
      // 避免同一份提醒投两遍。判定是**每次求值时现算**（会话会来来去去）。
      if (typeof shouldStaySilent === 'function') {
        try {
          if (shouldStaySilent() === true) return '';
        } catch { /* 判定失败 ⇒ 照常投递（宁可重复也不静默） */ }
      }
      const picked = pickLanding();
      runtime.lastLanding = picked;
      // **并集**：解析器给出落点集合时（单项目兜底路径 = 项目 ∪ 用户级）按并集投；否则单落点（旧口径不变）
      const built = buildReminderText({ landingDir: picked.dir, landingDirs: picked.dirs, now: now(), maxRules, maxChars });
      const step = nextDelivery({ runtime, built, now: now() });
      // 诊断（2026-09-20）：只在**签名变化**时落一条（landing 来源 / 条数 / 原因变了才写），
      // 否则每轮都写会把文件刷满、反而没人看。来历见 `diag.mjs` 顶部：
      // "重启后一条都没发，而同样的代码在测试里一切正常" —— 从进程外查不出来的那种故障。
      try {
        const sig = JSON.stringify({ dir: picked.dir, source: picked.source, rules: built.rules, reason: built.reason ?? null });
        if (sig !== runtime.lastDiagSignature && typeof onDelivery === 'function') {
          runtime.lastDiagSignature = sig;
          onDelivery({ landing: picked, built, step, reason: built.reason ?? null });
        }
      } catch { /* 诊断绝不打断投递 */ }
      // E3 推演实验抓出的缺陷（2026-09-19）：原先只记 `built.rules[0]`，而 `maxRules` 默认 3
      // ⇒ 单次投递最多只记 1 条，命中账**系统性少记**（拿它做排序/淘汰时判别力天然偏低）。
      // 现在把这一版**实际投递到的每一条**都记上；`evaluated` 只记一次（它是"提供者被求值"的计数）。
      // 并集路径（2026-09-21）：**逐落点记账**（每条纪律记到它自己的落点，规则 41 的对象级形态）。
      const attribution = Array.isArray(built.attribution) ? built.attribution : [];
      const contributed = new Set(Array.isArray(built.landings) ? built.landings : []);
      const ownerOfFirst = attribution.find((a) => a.rules.includes(built.rules[0])) ?? attribution[0] ?? null;
      if (built.rules.length > 0 && ownerOfFirst !== null && contributed.has(ownerOfFirst.dir)) {
        bumpUsage(ownerOfFirst.dir, { rule: built.rules[0], event: 'evaluated', now: now() });
        if (step.emitted) {
          for (const a of attribution) {
            if (!contributed.has(a.dir)) continue;
            for (const rule of a.rules) bumpUsage(a.dir, { rule, event: 'emitted', now: now() });
          }
        }
      }
      return step.text;
    } catch {
      return runtime.lastText; // fail-open：返回上一版（或空串），绝不抛
    }
  };

  ctx.effect(() => {
    ctx.systemPrompt.context({ name, order, text: provider });
    return undefined; // cordis effect 只接受 函数/null/undefined/thenable/iterable
  });
  return { ok: true, name, runtime, report };
}

/** 供体检/CLI 展示：本通道的能力与预算（**单一事实源**，避免文档与实现漂移） */
export function deliveryCapability() {
  return {
    channel: 'systemPrompt.context',
    name: REGISTRY_NAME,
    order: DEFAULT_ORDER,
    maxRules: DEFAULT_MAX_RULES,
    maxChars: DEFAULT_MAX_CHARS,
    minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
    landing: {
      static: 'landingDir（显式传入，最高优先）',
      dynamic: 'resolveLanding()（插件层来自 landing.mjs：现场 agent cwd → 进程内最近 cwd → ctx.agents 根代理人 → 进程工作目录 → 用户级落点兜底）',
      multiProject: '**多项目同时在线**（两条以上不同会话目录）时只投用户级落点（source=user-multi-project）——'
        + '索引通道是进程级一份注册、拿不到 agent，按任一方投递都会张冠李戴；'
        + '`agent/pre-step` 全文通道拿得到真实 agent，永远按各自会话精确解析',
      unresolved: '取不到落点 ⇒ 如实返回空文本并记 reason=no-landing（不猜、不硬编码家目录）',
    },
    untrustedMarkers: { open: INJECT.open, close: INJECT.close },
    notes: [
      '文本相同 ⇒ 宿主不重复追加（故文本必须稳定）',
      '文本变化 ⇒ 宿主追加；故对"变化"设最小间隔防抖动',
      'agent/pre-step（全文随现场注入）**已接**，判据与预算见 preStepCapability()',
      '绝不把动态内容写进 system prompt 正文',
    ],
  };
}
