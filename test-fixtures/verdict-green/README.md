# 绿态夹具：`CRED-FRESHNESS` 判据（`ledger-live-verdict`）必须在它上面 **exit=0**

## 为什么需要这个目录（2026-09-23 远端 CI 实测）

该判据的 `greenSample` 此前写的是 **`.`（插件仓根）** —— 那是**不可复现样本**：
- 本机跑绿，只因为**本机**有 `.dsh-ai/rulekeeper/ledger.jsonl`（它被 `.gitignore` 排除、**不入库**）；
- 干净 clone（= CI / 新装机）里没有那份台账 ⇒ 检查器判
  `LEDGER_LIVE_VERDICT_LEDGER=absent` / **exit 2**（"判据不适用"）
  ⇒ 误报面检查判 `MISREPORT_GREEN_FALSE_POSITIVE`（绿样本上非 0）⇒ 两个平台恒红。

规则 42 的原话是"红态样本必须能在任何时刻重跑"——**绿态样本同理**：判据的样本必须**入库**，
不能依赖某台机器上恰好存在的运行态文件。

## 本夹具的构成（最小可判绿）

```
test-fixtures/verdict-green/
  .dsh-ai/rulekeeper/ledger.jsonl   # 被检对象：1 行，evidence 指向下面那个真实文件
  docs/x.md                         # 对象锚点：evidence 引用的仓库内对象，真实存在
```

检查器对该树的判定面（`scripts/checkers/ledger-live-verdict.mjs`）：
① 账本存在（否则 exit 2）；② 每行 evidence 非空、无空项；③ evidence 里的路径 token **必须在树里存在**；
④ 必须有对象锚点（仓库内对象 / `key=value` / 具名错误码 / 指纹）；⑤ 无落点级故障。
本夹具满足全部五条 ⇒ **exit 0**。

## 可重跑验证

```bash
RULEKEEPER_SAMPLE_DIR=<包根>/test-fixtures/verdict-green node <包根>/scripts/checkers/ledger-live-verdict.mjs; echo $?   # 期望 0
```
