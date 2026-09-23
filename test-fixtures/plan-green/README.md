# 绿态样本：**有代码类改动，且有计划行覆盖它**

被检对象：本目录（一个真 git 仓；落点 `.dsh-ai/rulekeeper/`）。

判据期望：
- `RULEKEEPER_PLAN_BASE=HEAD~1 RULEKEEPER_PLAN_HEAD=HEAD node scripts/checkers/plan-artifact.mjs`
- 期望 **exit 0** + `PLAN_FINDINGS=0` + `PLAN_CHECK_RESULT=pass`

台账里那行 `PLAN_DECLARED` 的 `ts` 由用例在每次构造时写成"该提交时刻"⇒ 不依赖现场时钟（规则 42）。
