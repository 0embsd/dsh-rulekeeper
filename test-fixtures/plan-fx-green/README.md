# 静态绿样本：有计划行且**覆盖**这次改动

期望：`node scripts/checkers/plan-artifact.mjs`（`RULEKEEPER_SAMPLE_DIR=本目录`）⇒ **exit 0** + `PLAN_FINDINGS=0` + `pass`
并打印 `PLAN_CHECK_TIMELINE=fixture`（**自曝**用的是样本宣告的时间线，不是真 git 历史）。

时间线（`.plan-sample.json`）：改动时刻 `2026-09-23T10:00Z`，计划行 `09:30Z` ⇒ 早于改动且在 24h 窗口内。
