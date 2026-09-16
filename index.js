// dsh-rulekeeper · **插件装载入口**（LF-450/630 的前置：让本包成为可装载的 host 插件 bundle）
//
// 为什么需要这一层：`src/plugin.mjs` 的 `apply(ctx, opts)` 需要 `dshRoot`（用来读宿主事件表做 boot 自检），
// 而 DSH 装载插件时只传 `ctx`。此前本包**没有** `dsh.bundle.patch` 清单字段，也没有默认导出对象，
// 因此 `dsh plugin --profile <p> add …` 装不上（LF-400/LF-440 凭证自认"未实装"）——见 runbook §4。
//
// 本文件只做两件事：①把 `apply` 包成宿主约定形态 `export default { name, inject, apply }`
// ②按 `src/platform/paths.mjs` 的**唯一权威源**解析 `DSH_HOME`（不硬编码家目录）。
// 行为边界（诚实声明）：默认 handlers 全部返回 `{decision:'allow'}` ⇒ **本插件装载后是"零拦截"**，
// 装载只验证"能装上 + 能与第三方同场 + 不打断别人"；真正的 deny 规则要由消费者按需注入 handlers。
//
// **2026-09-16 修正（装上即用）**：上面那条"零拦截"一度被实现成"零功能"——`apply()` 不注入任何 handler，
// 于是工具调用只回 `{ok:false, configured:false, reason:'本工具未注入 handler（默认零副作用）'}`，
// 用户装完什么都不能做（老板当场指出："插件安装上了不能用，装它干嘛"）。现在默认装载**注入包内真实实现**
// （判定 / 记账 / 快照，见 `src/handlers.mjs`）；语义仍与上面一致：**默认不阻断**（只读判定），
// 要"真拦下来"必须由消费者改用 `ctx.tools.guard(name, handler)`。

import { apply as applyPlugin, bootSelfCheck, eventTableFromHost, PLUGIN_EVENTS, PLUGIN_TOOLS, TOOL_PREFIX } from './src/plugin.mjs';
import { defaultHandlers } from './src/handlers.mjs';
import { dshHome } from './src/platform/paths.mjs';

export { bootSelfCheck, eventTableFromHost, PLUGIN_EVENTS, PLUGIN_TOOLS, TOOL_PREFIX };

/** 宿主根：`DSH_HOME` 优先，回落 `<home>/.dsh`（与 CLI 侧同一实现） */
export function resolveDshRoot(env = process.env) {
  return dshHome(env);
}

export default {
  name: 'dsh-rulekeeper',
  inject: ['tools'],
  apply(ctx) {
    // **不返回报告对象**：cordis 只接受 函数/null·undefined/thenable/iterable 作为 effect 结果，
    // 返回普通对象会被判 `TypeError: Invalid effect`（2026-09-15 真装载实测）。
    // 报告本体在 `src/plugin.mjs` 的 `lastApplyReport` / `apply(..., {onReport})`。
    // 2026-09-16：**默认注入真实 handlers**（装上即用）—— 消费者仍可自行调用 applyPlugin 覆盖。
    applyPlugin(ctx, { dshRoot: resolveDshRoot(), handlers: defaultHandlers() });
  },
};
