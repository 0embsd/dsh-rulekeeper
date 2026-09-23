# 静态红样本 A：有计划行，但**已过窗**（48h 前 > 24h 窗口）

期望：observe 档 **exit 0** + `PLAN_FINDINGS=1`（`已过窗`）；`RULEKEEPER_PLAN_MODE=armed` 时 **exit 1**。
