// 红样本：一个**代码类**文件（`**/*.mjs` 命中），而落点台账里**没有任何计划行**
// ⇒ `plan-artifact` 必须报 `PLAN_CHECK=not-applicable`（0 条计划行 ⇒ 无从对账）
//    —— 注意：这**不是**"通过"，是"没得判"；另一条红样本（`plan-stale`）走的是"有计划行但过窗"。
export const fixture = 'red-code-change-without-plan';
