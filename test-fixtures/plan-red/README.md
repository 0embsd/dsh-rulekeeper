# 红态样本：**有代码类改动、台账里没有任何计划行**

被检对象：本目录（一个真 git 仓；落点 `.dsh-ai/rulekeeper/`）。

判据期望：
- `RULEKEEPER_PLAN_BASE=HEAD~1 RULEKEEPER_PLAN_HEAD=HEAD node scripts/checkers/plan-artifact.mjs`
- 期望 **exit 2** + `PLAN_CHECK=not-applicable（台账里 0 条计划行…）`

**为什么这算"红"**：它证明检查器**不会**把"我没得判"报成"通过"。
⚠ 这条本身**不是**"计划缺失"的命中 —— 那种命中由 `plan-stale` 样本给（有计划行但过窗）。
