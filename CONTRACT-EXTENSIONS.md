# dsh-rulekeeper · 契约扩展位（手写文档，不进生成品）

> `SCHEMA.md` 是 `src/schema.mjs` 的**生成结果**，手改必被判漂移（`SCHEMA_DOC_DRIFT`，用例盯着）。
> 新增的**可选**契约位记在这里，并同步说明"缺省即旧行为"。

三处**新增可选字段**（都向后兼容：缺省即旧行为，故不改 schema 版本）：

| 文件 | 字段 | 类型 | 语义 |
|---|---|---|---|
| `config.json` | `repoKind` | `"public"` \| `"private"` | 公开面黑名单**跑哪一档**：identity 类（本仓自己的名字）只在 `public` 档扫；infrastructure 类（本机盘卷路径/真实 IPv4/私钥/云凭据真值）两档都扫。缺省 ⇒ 按 git 远端探测（已知公开托管商 ⇒ `public`），**兜底 `private`**。口径与理由见 `src/repo-patterns.mjs` |
| `ledger.jsonl`（行内） | `guardRef` | `"hook:<名>"` \| `"gate:<名>"` | `mechanism: "guard"` 时**必须**给出：点名靠哪个拦截面。写入时核**存在性**（`hook:` 要在 `hooks.json` 清单里 / `gate:` 要在 `rules.json` 的 `gates` 里），核不过拒收 |
| `ledger.jsonl`（行内） | `activation` | string（≥8 字符、含可观测锚点） | 可判激活条件；`record --activation "当…时"` 写入。缺省**不拦**，但会打可见警告（体检 `EFFECT_ENTRY_NO_ACTIVATION` 计数会涨） |

## 改写既有条目（不再需要手工编辑账本）

`rk-mutate --landing <落点> --id <条目id> --set <字段>=<值> [--set 证据加=…] --by <谁> --reason <为什么> [--apply]`

- 默认 dry-run；`--apply` 才落盘：**备份（回读 sha256）→ 写临时件 → 回读校验（行数 + 旧行确实被取代 + 新行 id 在）→ 原子替换 → 失败逐字节回滚**
- **不改历史行**：追加一条**归档行**（`mechanism: "mutate"`、`evidence[0] = "MUTATES <id>"`）
  \+ 一条**状态事件行**（`STATUS_SUPERSEDE <id>`）；读侧 `supersededIds()` fold
- 可改字段白名单：`problem` / `root_cause` / `solution` / `mechanism` / `guard_ref` / `category`；
  **身份字段 `id` / `ts` / `rule` 禁改**（改了就不是"同一条教训"）
- 证据**只增不改**（`--set 证据加=…`；不接受 `--set evidence=…`）
- **幂等**：同一 id 已有未被取代的归档行 ⇒ 不重复追加
- 诚实边界：`--by` 是**声明**不是签名（与 `--by human` 同族，规则 43）

## 事件类目与教训类目分开（派生读数只数教训）

`生效登记` / `生效退役` / `状态事件` / `登记缺口` 四类是**工具与迁移**用的类目。
派生读数（复发计数、机制面统计、凭据对象面）**跳过**它们；人工教训**不要**占用——
占用会污染复发判定与"凭证须晚于生效"判定（2026-09-21 实测踩过，见账本里的登记缺口行）。
