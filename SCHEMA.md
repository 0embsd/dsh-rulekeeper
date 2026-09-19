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
| `recurrence` | number | 是 |  | 派生 | 派生：同 rule 行数 |
| `first_seen` | iso8601 | 是 |  | 派生 | 派生：同 rule 最早 ts |
| `last_seen` | iso8601 | 是 |  | 派生 | 派生：同 rule 最晚 ts |
| `status` | enum (active\|superseded\|archived) | 是 |  | 派生 | 派生：按状态事件行 fold |

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

### `usage.json`

- 形态：**json**｜版本字段：`schema`｜用途：**用量遥测**（P0-3，2026-09-19 新增）——回答"这条纪律真的被投递过几次"。
  来历（L634 的更正结论）：我们此前"只记不用"，根因之一是**没有度量**：既不知道哪条纪律被想起来过，
  也无法判断该留该淘汰。本文件让"真实投递次数"成为可统计事实（而不是"有人写过绑定"）。
  上游对照：Hermes Agent 的 `skills/.usage.json`（`tools/skill_usage.py:1-10`）——同一形态本地化。

| 字段 | 类型 | 必填 | 唯一 | 可变 | 说明 |
|---|---|---|---|---|---|
| `schema` | number | 是 |  |  |  |
| `rules` | object | 是 |  |  | 键=规范纪律名；值见下 |
| `rules.<RULE>.evaluated` | number | 是 |  |  | 投递提供者被**求值**的次数（宿主每轮 prompt assembly 会调） |
| `rules.<RULE>.emitted` | number | 是 |  |  | 返回**新**文本的次数（≠"模型一定看到"：宿主对相同文本有自己的去重，插件侧观测不到追加结果——如实登记，不臆断） |
| `rules.<RULE>.lastAt` | iso8601 | 否 |  |  | 最近一次 emitted 时间 |
| `totalEmitted` | number | 是 |  |  | 全落点累计 emitted |

**写入纪律**：原子写（临时文件 + rename）；读失败/损坏 ⇒ 降级为空账（fail-open，度量失败绝不打断投递）。
**通道纪律**：投递走宿主 `ctx.systemPrompt.context({name,order,text})`（`name=rulekeeper/reminders`）；
文本必须**稳定**（宿主按"文本变化"追加）、跨轮状态自持（宿主侧无跨轮去重）、变化最小间隔默认 30 分钟；
**绝不把动态内容写进 system prompt 正文**。实现与预算的唯一事实源见 `src/deliver.mjs` 的 `deliveryCapability()`。

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
