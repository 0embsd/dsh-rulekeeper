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
- **不改历史行**：追加一条**归档行**（`category: "教训改写"`、`evidence[0] = "MUTATES <id>"`）
  \+ 一条**状态事件行**（`STATUS_SUPERSEDE <id>`）；读侧 `supersededIds()` 与 `foldMutates()` 配套
- **身份用 `category`，不用 `mechanism`**：归档行的 `mechanism` 存的是**改后值**（这样 fold 才能把
  `mutate --set mechanism=question` 如实带给消费方）。把身份塞进 `mechanism` 会让改后值被覆盖
  ⇒ fold 出来还是旧值（**实测踩到两次**，故写进契约）
- **读侧 fold（消费方必须用）**：`foldMutates(rows)` 把归档行的字段值应用回**目标 id**，并
  **保留原 id**（消费方按 id 认这条教训）、**不搬身份字段**（`id`/`ts`/`category`/`rule`/`evidence`）。
  不知道这条就会重演"改了 mechanism、检查器读旧值"的**静默降级**（这是被治理项目当时禁用该命令的原因）
- 可改字段白名单：`problem` / `root_cause` / `solution` / `mechanism` / `guard_ref` / `category`；
  **身份字段 `id` / `ts` / `rule` 禁改**（改了就不是"同一条教训"）
- 证据**只增不改**（`--set 证据加=…`；不接受 `--set evidence=…`）
- **幂等**：同一 id 已有未被取代的归档行 ⇒ 不重复追加
- 诚实边界：`--by` 是**声明**不是签名（与 `--by human` 同族，规则 43）

## 事件类目与教训类目分开（派生读数只数教训）

`生效登记` / `生效退役` / `状态事件` / `登记缺口` / `教训改写` 五类是**工具与迁移**用的类目。
派生读数（复发计数、机制面统计、凭据对象面）**跳过**它们；人工教训**不要**占用——
占用会污染复发判定与"凭证须晚于生效"判定（2026-09-21 实测踩过，见账本里的登记缺口行）。

## 已知欠账怎么登记（`ACKNOWLEDGED_GAPS` 口径，2026-09-21）

历史账本里"凭据是仓库外的东西、复核不了"的行，**不要**去删也不要改（账本 append-only），
而是**另起一行**把它挑明（`category: 登记缺口`）：

```
[evidence-repair] 缺口=<仓库外文件名> 缺口=<另一个>
```

- 语义：**这条凭据确属仓库外**（验收现场/会话期一次性产物），手里没有可复核的对象。
- 读侧：`scripts/checkers/ledger-live-verdict.mjs` 认这个标记 —— 被 `缺口=` 点名的文件**不算违规**，
  并且会计数打印（`ACKNOWLEDGED_GAPS=n`，**可见、不静默**）。
- 边界（如实）：只对**逐条点名**的文件生效（不认"整个仓已知欠账"这种笼统豁免——那会把判据作废）。
- 事件行（`生效登记`/`生效退役`）里的**绝对路径**单独一档：它们是事件事实、不是教训凭据，
  故只计数（`OUT_OF_SCOPE_ABS=n`）**不判红**（对象错位，规则 41 的同族）。

## 检查器能不能搬去别的项目？看 spec 的 `applicability`

8 份 spec 都有 `applicability: { scope, requires, note }`。要点：
- `scope: any` —— 与语言/工程类型无关（`byte-discipline` / `adoption-contract` / `ledger-live-verdict`）
- `scope: js-project-with-*` —— 只适用含 `src/` 或 `test/**/*.mjs` 的 JS 工程
- `scope: plugin-repo-only` —— **不可搬迁**（`misreport-surface`：它按 `cwd` 解析各绑定的 spec/command，
  要求"项目根相对路径"这套前提成立）
- `scope: any-with-git-hooks` —— 要求本仓装了 `.githooks/**`
- `scope: public-repo-only` —— `leak-check`（公开面泄漏）：私有仓用它是**错档** ⇒ 该检查器会**拒跑并
  报 `LEAK_CHECK_SUBJECT=wrong-tier`（exit 2）**，而不是把自家名字全报成违规（实测 296 条）

**统一口径**：没有被测对象 ⇒ **exit 2**（判据不适用），**不是 0**。按"exit 0 就是绿"去绑会在无对象的
仓上拿到**空转绿**。


## 读写侧的口径必须同源（两处踩过的坑）

| 坑 | 现象 | 现在怎么做 |
|---|---|---|
| 身份字段被当内容搬 | fold 出来的那条 `category=教训改写` ⇒ 消费方"排除迁移记录"的判据又把它排除（**改了等于没改**） | 身份字段（`id`/`ts`/`category`/`rule`/`evidence`）**不搬**（`MUTATE_FOLD_EXCLUDED`） |
| 迁移记录留在结果里 | 状态事件行本身也是迁移记录，留在结果里会被当教训（机制面统计多一条） | fold 的产物**只含教训行**：归档行与 `STATUS_SUPERSEDE` 行都滤掉 |

