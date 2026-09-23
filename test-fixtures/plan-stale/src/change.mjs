// 红样本之二：**有计划行，但它已经过窗**（本样本把 windowHours 声明为 0 ⇒ 任何"严格更早"的计划行都算过窗）。
// 为什么单独造这一条：`plan-red` 走的是"0 条计划行 ⇒ 无从对账（exit 2）"，
// 而"有计划行却过期"走的是**命中路径**（`PLAN_FINDINGS≥1`）—— 两条红态的判别路径不同，缺一条就少一半覆盖。
export const fixture = 'stale-plan-outside-window';
