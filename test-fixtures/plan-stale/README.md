# 红态样本之二：**有计划行，但已过窗** ⇒ 命中（不是"无从对账"）

被检对象：本目录（一个真 git 仓；落点 `.dsh-ai/rulekeeper/`）。

判据期望（两态都验）：
- **observe 档**（默认）：`PLAN_FINDINGS=1` 且 **exit 0**（只记审计、不阻断）；
- **armed 档**（`RULEKEEPER_PLAN_MODE=armed`）：同一现场 **exit 1**。

`windowHours: 0` 是**故意**的：它让"计划行早于改动时刻"在**任何时钟**下都算过窗 ⇒ 样本不依赖现场时间（规则 42）。
