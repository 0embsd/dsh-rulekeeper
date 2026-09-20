// scoped.mjs —— **按会话（agent 作用域）隔离的提醒投递**（2026-09-20，方案"乙"根治）
//
// 要解决的问题（方案"甲"只是止血）：`systemPrompt.context()` 以前注册在**根上下文**上 ——
//   整个宿主进程只有**一份**，provider 拿不到 agent，只能靠"最后一次 pre-step 记下的目录"猜是哪场会
//   ⇒ 多会话时 last-writer-wins，提醒会**串到另一个项目的落点**。
//
// 根治办法：注册到**每个会话自己的作用域**里（`agent.ctx`）。宿主文档逐字：
//   `Agent.ctx` —— "Agent-scoped context; its contributions are agent-local, unwind on disposal,
//   and reject registration afterward."
//   ⇒ 每个会话一份、随会话销毁自动回卷；provider 用**这个会话自己的 cwd**解析落点，不再需要猜。
//
// 真 cordis 实测（决定可行性的那次实验，2026-09-20）：
//   · `createScope(ctx,key)` 造出的作用域上下文里 `ctx.systemPrompt` **可以直接读**（不抛 "without inject"）
//   · 在该作用域里 `ctx.systemPrompt.context({...})` 注册**生效**（provider 被记录且能返回文本）
//   · `ctx.effect` 可用（注册随作用域销毁而回卷）
//
// 归属：core 模块。零依赖：只用 node:*。

import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { DEFAULT_MAX_CHARS, DEFAULT_MAX_RULES, DEFAULT_MIN_INTERVAL_MS, DEFAULT_ORDER, REGISTRY_NAME, buildReminderText, createDeliveryRuntime, nextDelivery } from './deliver.mjs';
import { resolveProjectLanding, resolveUserLanding } from './platform/paths.mjs';
import { bumpUsage, readEmission, writeEmission } from './usage.mjs';

/** 文本指纹（跨重启去重用；sha256 前 16 字节足够区分，且不把正文写进状态文件） */
export function textSha(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 32);
}

/** 注册名后缀分隔符（每个会话一个唯一名字：宿主对同一作用域内的重名会抛） */
export const SCOPED_NAME_SEP = '#';

/** 会话标识（用于注册名与诊断；取不到 id 时用序号兜底） */
export function agentKeyOf(agent, fallback = 'agent') {
  const id = agent !== null && typeof agent === 'object' && typeof agent.id === 'string' && agent.id.trim() !== ''
    ? agent.id.trim()
    : null;
  return id ?? fallback;
}

/** 该会话的会话目录（`agent.session.header.cwd`；取不到 ⇒ null，绝不猜） */
export function agentSessionCwd(agent) {
  const cwd = agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : null;
}

/**
 * 用**这个会话自己的** cwd 解析落点：项目落点存在就用它，否则退用户级（与全局通道同一口径）。
 * @returns {{dir: string|null, source: string}}
 */
export function landingForAgent(agent, { env = process.env } = {}) {
  const cwd = agentSessionCwd(agent);
  if (cwd === null) return { dir: null, source: 'none' };
  const project = resolveProjectLanding(cwd);
  if (existsSync(project)) return { dir: project, source: 'agent-project' };
  const user = resolveUserLanding(env);
  if (existsSync(user)) return { dir: user, source: 'agent-user-fallback' };
  return { dir: null, source: 'none' };
}

/** 在给定作用域上下文里读 `systemPrompt`（先 reflect——无 inject 要求，再直接读；都不行 ⇒ null） */
function systemPromptOf(actx) {
  try {
    const viaReflect = actx?.reflect?.get?.('systemPrompt');
    if (viaReflect !== null && typeof viaReflect === 'object' && typeof viaReflect.context === 'function') return viaReflect;
  } catch { /* 落到下一档 */ }
  try {
    const direct = actx?.systemPrompt;
    if (direct !== null && typeof direct === 'object' && typeof direct.context === 'function') return direct;
  } catch { /* 不可用 */ }
  return null;
}

/**
 * 为一个会话注册**它自己作用域里的**提醒位。
 *
 * 幂等性由调用方负责（插件层用 Set 记录已注册的 agent）。
 * @param {{agent: object, order?: number, maxRules?: number, maxChars?: number, minIntervalMs?: number,
 *          now?: () => Date, env?: object, onDelivery?: Function}} opts
 * @returns {{ok: boolean, reason: string|null, name: string|null, runtime: object|null, report: Function|null}}
 */
export function registerAgentScopedDelivery({
  agent,
  order = DEFAULT_ORDER + 1,
  maxRules = DEFAULT_MAX_RULES,
  maxChars = DEFAULT_MAX_CHARS,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  now = () => new Date(),
  env = process.env,
  onDelivery = null,
} = {}) {
  const name = `${REGISTRY_NAME}${SCOPED_NAME_SEP}${agentKeyOf(agent)}`;
  const actx = agent !== null && typeof agent === 'object' ? agent.ctx : null;
  if (actx === null || typeof actx !== 'object' || typeof actx.effect !== 'function') {
    return { ok: false, reason: 'no-agent-ctx', mechanism: null, name, runtime: null, report: null };
  }

  const runtime = createDeliveryRuntime({ minIntervalMs });
  runtime.lastLanding = landingForAgent(agent, { env });
  const report = () => ({
    ok: true,
    scope: 'agent',
    mechanism: runtime.mechanism ?? null,
    agent: agentKeyOf(agent),
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

  const provider = () => {
    try {
      const picked = landingForAgent(agent, { env });      // ← 每次求值都用**这个会话自己**的 cwd
      runtime.lastLanding = picked;
      const built = buildReminderText({ landingDir: picked.dir, now: now(), maxRules, maxChars });
      // **跨重启不重复投**（2026-09-20 实测到的重复）：内存里去重状态随进程消失，
      //   重启后同一段文本会被再投一次（上下文里出现两份）。这里查"落盘的上次投递"：
      //   同一落点 + 同一个会话 + 同一段文本 ⇒ 本会话早就有它了，这次不出话。
      const selfKey = agentKeyOf(agent);
      const already = (() => {
        if (built.text === '') return false;
        const last = readEmission(picked.dir, selfKey);
        return last !== null && last.sha === textSha(built.text);
      })();
      if (already) {
        runtime.reasons.push('already-delivered-before-restart');
        return '';
      }
      const step = nextDelivery({ runtime, built, now: now() });
      try {
        const sig = JSON.stringify({ dir: picked.dir, source: picked.source, rules: built.rules, reason: built.reason ?? null });
        if (sig !== runtime.lastDiagSignature && typeof onDelivery === 'function') {
          runtime.lastDiagSignature = sig;
          onDelivery({ scope: 'agent', mechanism: runtime.mechanism ?? null, agent: agentKeyOf(agent), landing: picked, built, step, reason: built.reason ?? null });
        }
      } catch { /* 诊断绝不打断投递 */ }
      if (built.rules.length > 0) {
        bumpUsage(picked.dir, { rule: built.rules[0], event: 'evaluated', now: now() });
        if (step.emitted) {
          for (const rule of built.rules) bumpUsage(picked.dir, { rule, event: 'emitted', now: now() });
          writeEmission(picked.dir, selfKey, { sha: textSha(built.text), at: now().toISOString() });
        }
      }
      return step.text;
    } catch {
      return runtime.lastText;   // fail-open：返回上一版（或空串），绝不抛
    }
  };

  // ── 机制选择（**显式开关优先**）──────────────────────────────────────────────────
  // 机制①：作用域内**服务注册**（默认；真 cordis 实测能读到服务、注册能生效）。
  // 机制②：装配瀑布（`actx.on('system-prompt/assemble')`）——**默认关闭**。
  //   想法：宿主自己就是用 `agentCtx.on('system-prompt/assemble', …)` 往 assembly 里加东西的，
  //   这条路不读服务、看起来更稳。但 **2026-09-20 真 cordis 实测否决**：在"两个作用域、两个会话"
  //   的夹具里，每个装配**都收到了两份文本**（AAA 与 BBB 同时出现）⇒ 我**未能证明**这条路的
  //   作用域隔离；若它不隔离，多会话下会把别人的提醒塞进你的上下文（比原问题更糟）。
  //   ⇒ 只留显式开关 `RULEKEEPER_SCOPED_WATERFALL=1` 供后续验证，**不作默认**。
  const useWaterfall = process.env.RULEKEEPER_SCOPED_WATERFALL === '1' && typeof actx.on === 'function';
  if (useWaterfall) {
    try {
      actx.effect(() => {
        const off = actx.on('system-prompt/assemble', async (assembly, _context, next) => {
          const assembled = typeof next === 'function' ? await next() : assembly;
          const text = provider();
          if (text === '') return assembled;
          const contexts = Array.isArray(assembled?.contexts) ? assembled.contexts : [];
          return { ...assembled, contexts: [...contexts, { name, text }] };
        });
        return typeof off === 'function' ? off : undefined;
      });
    } catch (err) {
      return { ok: false, reason: `scope-hook-error:${String(err?.message ?? err)}`, mechanism: null, name, runtime, report };
    }
    runtime.mechanism = 'assemble-waterfall';
    return { ok: true, reason: null, mechanism: 'assemble-waterfall', name, runtime, report };
  }

  const sp = systemPromptOf(actx);
  if (sp !== null) {
    try {
      actx.effect(() => {
        sp.context({ name, order, text: provider });
        return undefined;   // cordis effect 只接受 函数/null/undefined/thenable/iterable
      });
    } catch (err) {
      return { ok: false, reason: `scope-register-error:${String(err?.message ?? err)}`, mechanism: null, name, runtime, report };
    }
    runtime.mechanism = 'service-context';
    return { ok: true, reason: null, mechanism: 'service-context', name, runtime, report };
  }

  return { ok: false, reason: 'no-systemPrompt-in-agent-scope', mechanism: null, name, runtime, report };
}
