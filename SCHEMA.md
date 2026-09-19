# dsh-rulekeeper schema v1（冻结单）

> **本文件由 `src/schema.mjs` 生成，禁手改。** 改字段请改代码后重跑 `node bin/rk-schema.mjs --write-md`；
> 手改会被 `rk-schema --check` 判红（`SCHEMA_DOC_DRIFT`）。

## 0. 冻结范围

共 6 个数据文件，每个文件都有版本字段；可变聚合字段**一律派生**（禁原地更新）。

## 1. 逐文件字段表

### `ledger.jsonl`

- 形态：**append-only**｜版本字段：`schema`｜用途：教训/纪律账本：一行一条事实记录
- 去重键：`rule` × `target` × `sha256`

| 字段 | 类型 | 必填 | 唯一 | 可变 | 说明 |
|---|---|---|---|---|---|
| `schema` | number | 是 |  |  | 每行都带（与 rules.json 对称） |
| `id` | string | 是 | 是 |  | 如 L412 / LF-140；全局唯一 |
| `ts` | iso8601 | 是 |  |  |  |
| `rule` | string | 是 |  |  | 对应哪条纪律/规则；去重键之一 |
| `category` | string | 是 |  |  |  |
| `problem` | string | 是 |  |  |  |
| `root_cause` | string | 是 |  |  |  |
| `solution` | string | 是 |  |  |  |
| `evidence` | array | 是 |  |  | 凭证路径列表（字符串数组） |
| `mechanism` | string | 是 |  |  | text | mechanized | uncheckable(+理由) |
| `recurrence` | number | 是 |  | 派生 | **行内恒为 1**（写入时单行事实）；同 rule 行数须派生（recurrenceOf()/summary），读行内字段恒得 1 |
| `first_seen` | iso8601 | 是 |  | 派生 | **行内 = 本行 ts**（写入时事实）；同 rule 最早 ts 须派生 |
| `last_seen` | iso8601 | 是 |  | 派生 | **行内 = 本行 ts**（写入时事实）；同 rule 最晚 ts 须派生 |
| `status` | enum (active\|superseded\|archived) | 是 |  | 派生 | **行内 = 写入时状态**（导入的历史行可出生即 superseded，故无常数不变式）；后续迁移按状态事件行 fold，禁原地改写 |
| `activation` | string | 否 |  |  | 可判激活条件：一句话说明在什么**可观测**条件下这条纪律适用/该被想起/该被判红（须可机械判定；占位符不算） |

### `rules.json`

- 形态：**json**｜版本字段：`schema`｜用途：项目声明的规则包（被 protect/check/plugin/cli 全域消费，**单点权威**）
- 可机检类型：`file_untracked_change` / `output_shape` / `invalid_reference`

| 字段 | 类型 | 必填 | 唯一 | 可变 | 说明 |
|---|---|---|---|---|---|
| `schema` | number | 是 |  |  |  |
| `project` | string | 是 |  |  | 双本（项目级/用户级）的判别依据（Q3） |
| `protected_paths` | array | 是 |  |  | 受保护路径；由 rules.isProtected() **单点**判定 |
| `gates` | array | 是 |  |  | gateName / 凭证路径 / 严格档 |
| `checks` | array | 是 |  |  | 三种可机检类型（见下）；条目可为裸字符串（旧形态）或**生效绑定对象** `{kind, rule, carrier, falsePositive?, gate?, proposal?, activatedAt?, notes?}`（LF-A*：把"哪条纪律靠哪个判据拦"变成可机检数据，无 carrier 即无法验证） |
| `inject` | array | 是 |  |  | 注入模板（白名单字段） |

### `snapshots/index.jsonl`

- 形态：**append-only**｜版本字段：`schema`｜用途：pre-image 快照索引（path 形式一律 pathKey 归一，作为 protect↔detect 的显式契约）

| 字段 | 类型 | 必填 | 唯一 | 可变 | 说明 |
|---|---|---|---|---|---|
| `schema` | number | 是 |  |  |  |
| `ts` | iso8601 | 是 |  |  |  |
| `path` | string | 是 |  |  | **pathKey** 形式（posix + 折叠大小写） |
| `sha256_before` | sha256 | 是 |  |  |  |
| `sha256_after` | sha256 | 否 |  |  |  |
| `sha256_lf` | sha256 | 否 |  |  | **行尾归一形态**（CRLF→LF）的 sha256：仅文本文件（二进制为 null）；供 core.autocrlf=true 时跨形态比对（G3） |
| `backup` | string | 是 |  |  | 备份文件相对项目根路径 |
| `why` | string | 是 |  |  |  |
| `job` | string | 否 |  |  |  |

### `findings.jsonl`

- 形态：**append-only**｜版本字段：`schema`｜用途：观测流：一次判定一条（**不是**诊断日志；诊断日志见 LF-1A0 的 dsh-rulekeeper.log）

| 字段 | 类型 | 必填 | 唯一 | 可变 | 说明 |
|---|---|---|---|---|---|
| `schema` | number | 是 |  |  |  |
| `ts` | iso8601 | 是 |  |  |  |
| `rule` | string | 是 |  |  |  |
| `severity` | enum (info\|warn\|error) | 是 |  |  |  |
| `target` | string | 是 |  |  |  |
| `evidence` | array | 是 |  |  |  |
| `action` | enum (observe\|deny\|warn) | 是 |  |  |  |

### `config.json`

- 形态：**json**｜版本字段：`schema`｜用途：运行时覆盖层（落在两处落点各一份；已存在的**不被覆盖**）

| 字段 | 类型 | 必填 | 唯一 | 可变 | 说明 |
|---|---|---|---|---|---|
| `schema` | number | 是 |  |  |  |
| `mode` | enum (observe\|armed\|off) | 是 |  |  |  |
| `protected_paths` | array | 否 |  |  |  |
| `ledgerPath` | string | 否 |  |  |  |
| `maxInjectChars` | number | 否 |  |  |  |

### `proposals/<id>.json`

- 形态：**json**｜版本字段：`schema`｜用途：自进化提案（**闸先于写者**：evolve 只产提案，绝不直接写 rules.json）

| 字段 | 类型 | 必填 | 唯一 | 可变 | 说明 |
|---|---|---|---|---|---|
| `schema` | number | 是 |  |  |  |
| `id` | string | 是 | 是 |  |  |
| `rule` | string | 是 |  |  |  |
| `source` | enum (auto\|human) | 是 |  |  |  |
| `createdAt` | iso8601 | 是 |  |  |  |
| `redCriteria` | string | 是 |  |  | 提案必须自带红态判据 |
| `counterExample` | string | 是 |  |  | 反例样本 ≥1 |
| `falsePositiveSurface` | string | 是 |  |  | 误报面 |
| `activationCheck` | string | 是 |  |  | 生效验证方式 |
| `status` | enum (proposed\|approved\|rejected) | 是 |  |  |  |

## 2. 可变字段的派生规则（**禁原地更新**）

| 文件 | 字段 | 派生方式 | 说明 |
|---|---|---|---|
| `ledger.jsonl` | `recurrence` | `scan:count-rows-with-same-rule` | 禁原地更新 |
| `ledger.jsonl` | `first_seen` | `scan:min-ts-of-same-rule` |  |
| `ledger.jsonl` | `last_seen` | `scan:max-ts-of-same-rule` |  |
| `ledger.jsonl` | `status` | `event:fold-status-events` | 状态迁移写事件行，不覆写历史行 |

**为什么禁止**：把"计数/状态"放进 append-only 行里原地改写，等于在并发下做「整文件读-改-写」。
实测该形态会丢计数（`scripts/demo-rmw-loss.mjs` 复现；本机曾测得期望 1600 实得 56，丢 96.5%）。
计数用**派生**（扫同 rule 行数），状态迁移用**事件行**；写入侧的原子性与锁由 LF-160 / LF-170 保证。

### 2.1 行内值 ≠ 聚合值（2026-09-19 口径更正）

上表 `可变` 列标"派生"说的是**读法**（该字段的语义要派生着读），**不是**"行里存的是聚合值"。
**行里写下的永远是写入那一刻的单行事实**：`recurrence` 恒 `1`、`first_seen`/`last_seen` 恒等于本行 `ts`、
`status` 为写入时状态（导入的历史行可**出生即** `superseded`）。因此**直接读行内字段当聚合用会得到常数**——
同 rule 行数请用 `recurrenceOf()` / `summary()`。下表由 `LEDGER_ROW_WRITE_INVARIANTS` 渲染（改口径请改代码重生成）：

| 字段 | 行内不变式 | 违反级别 | 为什么 |
|---|---|---|---|
| `recurrence` | `=== 1` | error | 行内 recurrence 是写入时的单行事实（恒 1）；同 rule 行数必须派生。出现非 1 ⇒ 有人把聚合写进了 append-only 行里（LF-120 禁原地更新的反面形态），该行及其它读数一律不可信 |
| `first_seen` | `=== ts` | warn | 行内 first_seen 是写入时事实（= 本行 ts）；同 rule 最早 ts 必须派生。不等 ⇒ 该行携带了跨行聚合，口径可疑 |
| `last_seen` | `=== ts` | warn | 行内 last_seen 是写入时事实（= 本行 ts）；同 rule 最晚 ts 必须派生。不等 ⇒ 该行携带了跨行聚合，口径可疑 |

机械面：`doctor()` 逐行核对上表，违反即报 `DOCTOR_<code>`（如 `DOCTOR_ROW_RECURRENCE_NOT_ONE`）并计入 `summary.rowViolations`。
