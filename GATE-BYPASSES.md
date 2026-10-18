# 门禁绕过登记（GATE-BYPASS）

> 口径：绕过 = 用 `--no-verify`、改钩子、跳过门禁等办法让门禁没跑或没拦住。本文件只登记事实、复位路径与复查条件，**不替代门禁**。
> 维护：规则官；最近更新 2026-10-18。

## LF-20261018064917-488b43 · `0ee1ded` 以 `git commit --no-verify` 绕过 pre-commit

- **对象**：提交 `0ee1ded044ca252d125e89944f76fbc358c75813`。
- **证据**：`.dsh-ai/rulekeeper/logs/gate.jsonl:124` —— `gate=precommit`、`bypass="git commit --no-verify"`、`violations=1`（`GATE_PRECOMMIT_UNRECORDED`：`src/schema.mjs` 缺 pre-image）。
- **根因**：为让缺失的 pre-image 不被拦，直接用 `--no-verify` 跳过门禁，而不是先回填再正常提交。
- **复位路径（SL-4）**：`rk-snap take --landing .dsh-ai/rulekeeper --path <文件> --project .` 回填 pre-image，再重跑该提交的门禁。
- **事后复核**：`0ee1ded` 的 post-commit 行为 `verdict=pass`，`src/schema.mjs` 的 `committed==baseline`（紧邻 `gate.jsonl:125`）。
- **复查条件**：同类提交必须先用 `rk-snap take` 回填 pre-image，再走正常提交；**不得再 `--no-verify`**。
- **收尾/CR 固定问句**：本批有没有 `--no-verify`？pre-image 是否已回填？
- **机制面**：`question`（人工复查问句；本文件是登记，不是拦截面）。
