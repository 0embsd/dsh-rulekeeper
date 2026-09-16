# dsh-rulekeeper 止损 Runbook（Go/No-Go）

> **本文件由 `rk-stop-loss runbook --write-md` 生成，禁手改**（手改 = 漂移，`--check` 会判红）。
> 判据来源：todo 清单 **LF-820**（Go/No-Go 止损点 + Runbook：误拦率 / 上下文膨胀 / 并存反红连续失败 3 次 → 停在 observe）。

## 量化止损阈值（单一权威源 = `src/stoploss.mjs` 的 `STOP_LOSS_LIMITS`）

| 指标 | 阈值 | 含义 |
|---|---|---|
| `falseBlockRate`（误拦率） | > 0.02 | 正常操作被门禁拦下的比例；超了就是"门禁开始伤人" |
| `contextInflationRatio`（上下文膨胀） | > 3 | 注入文本 / 原始对话；拿上下文换纪律，超了不值 |
| `coexistRedFailures`（并存反红连续失败） | ≥ 3 | 与第三方插件同场时反红连续挂掉（判据原文"连续失败 3 次"） |
| `unrecordedWrites`（未留证直写） | > 0 | 一次都不许 |

判定口径（`rk-stop-loss status`）：

- 任一指标**超阈值** → `verdict=no-go`（先做 SL-1 止血）
- 任一指标**缺项** → `verdict=unknown`；**未知不等于通过**：同样先做 SL-1（fail-closed）
- 全部有值且不超 → `verdict=go`（exit=0）

## 动作表（每条都是**可复制的一句命令**）

命令里的占位符：`{bin}` = 包内 `bin/`，`{landing}` = 落点（`.dsh-ai/lessonflow`），`{repo}` = 项目根，
`{backup}` = 备份文件，`{path}` = 目标文件，`{pkg}` = 包根。

### SL-0 维护动作：先备份账本（**所有恢复动作的前置**）

```sh
node {bin}/rk-backup.mjs create --file {landing}/ledger.jsonl --landing {landing}
```

- 触发：每次收尾/改动前
- 判据：exit=0 且 stdout 有 `RK_BACKUP_PATH=`（create 自带**回读 sha256** 校验）

### SL-1 止血：把档位停在 `observe`（本文件所有其它动作的前提）

```sh
node {bin}/rk-stop-loss.mjs apply --landing {landing}
```

- 触发：误拦率 > 2% ∥ 上下文膨胀 > 3× ∥ 并存反红连续失败 ≥ 3 ∥ 指标缺项
- 判据：exit=0 且 stdout 有 `RK_STOP_LOSS_MODE_AFTER=observe`（**读回** config.json，不靠命令返回码）

### SL-2 hook 漂移：重装并校验（`hooksPath` 指向别处 = git 一次都不会执行它）

```sh
node {bin}/rk-gate.mjs hooks install --repo {repo} --force
```

- 触发：`rk-gate hooks verify` exit≠0
- 判据：`rk-gate hooks verify --repo {repo}` exit=0（装到 `.git/hooks/` 不算：那是**假安装**）

### SL-3 账本坏行：从最近备份**还原**（禁手改账本行）

```sh
node {bin}/rk-backup.mjs restore --file {landing}/ledger.jsonl --backup {backup}
```

- 触发：`rk-doctor --landing <落点>` 报 `DOCTOR_BAD_LINES`（error）或 `DOCTOR_TRUNCATED_TAIL`（warn）
- 判据：`rk-doctor --landing {landing} --strict` exit=0（回读 sha256 由 restore 自身保证）

### SL-4 未留证的直写：补一次**快照留证**（然后再提交）

```sh
node {bin}/rk-snap.mjs take --landing {landing} --path {path} --project {repo}
```

- 触发：`rk-gate write --project <项目根>` 报 `UNRECORDED>0`
- 判据：`rk-gate write --project {repo} --landing {landing}` exit=0 且 `RK_GATE_WRITE_UNRECORDED=0`

### SL-5 复位确证：医生 + 自检两道都过才算回到基线

```sh
node {bin}/rk-doctor.mjs --landing {landing} --strict
```

- 触发：止血动作做完之后（收尾门）
- 判据：exit=0；另加 `rk-selfcheck --root {pkg}` exit=0

## 故障 → 复位步骤（`rk-stop-loss verify` 逐条自动验）

| 故意造坏的态 | 复位步骤 | 为什么 |
|---|---|---|
| `mode-armed-forged` | SL-1 | 档位被改成 armed 但没有留证：先回 observe 止血 |
| `hooks-path-drift` | SL-2 | core.hooksPath 漂移 ⇒ hook 根本不执行（假安全） |
| `ledger-corrupt` | SL-3 | 账本中间坏行：从最近备份还原（禁手改） |
| `unrecorded-write` | SL-4 | 受保护文件被改动未留证：补快照留证 |

`rk-stop-loss verify` 的做法（**红先于绿**）：注入故障 → **先断言故障信号可见**（doctor/hooks verify/mode 变红）
→ 执行上表那一句命令 → 断言回到基线。任一步没复位 → exit≠0。

## 退役门槛（LF-830：删壳之前的硬门）

**连续 14 天零回退、零事故**才允许删壳；判定由 `rk-stop-loss retire` 机械执行：

```sh
node {bin}/rk-stop-loss.mjs retire --landing {landing} --shell <壳名> --since <最后回退日 ISO> --now <当前 ISO>
```

- 天数不足 `--min-days`（默认 14）→ **拒绝**（exit≠0）
- 期间存在回退/事故记录（`<落点>/logs/incidents.jsonl`）→ **拒绝**（exit≠0）
- 本文件缺失或没有这一节 → **拒绝**（"未写退役门槛就删壳"必须被拦住）
- 放行时写台账 `<落点>/logs/retire.jsonl`（可审计：谁在什么时候依据什么放的行）

