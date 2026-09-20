# dsh-rulekeeper

> **独立工具**：把「纪律」从文字变成**可机械阻断 + 可自动留证 + 可自进化**的**零依赖 Node CLI**。
> **跨平台**（Windows / Linux / macOS），**不依赖任何具体项目**，且**不含任何主机地址/凭据/身份信息**
> —— 这条由 `rk-selfcheck` 的 **S8** 机械保证（扫发布面全量文件，含 README/RUNBOOK 等顶层文档）。
>
> 历史注记（2026-09-16）：更早的本文写的是"它与某个内部项目的关系……"，既让人误以为本仓依附某个项目、
> 又把内部结构写到了公开面。现改为**不含项目名**的表述；内部侧的历史不改写。

```
dsh-rulekeeper <子命令>        # 主入口（bin/dsh-rulekeeper.mjs）
rk-gate / rk-check / rk-snap / rk-crossplat / …   # 22 个薄壳子命令
```

## 运行环境（跨平台）

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | **≥ 22** | 纯 ESM、**零 npm 依赖**（只用 `node:*`；`rk-selfcheck` 的 S4 机械拦裸导入与 `require`） |
| git | 2.x | 判据与钩子依赖 `git rev-parse` / `git show` / `git log --name-status` / `--no-verify` 语义 |
| POSIX shell | Windows：**Git for Windows** 自带的 `sh`；Linux/macOS：系统自带 | 只用来跑 `.githooks/*` 里的**钩子薄壳**（内容就一行 `exec node …`）；也可用 `--hooks-path` 指到别处 |
| PowerShell | **不需要** | 只有当**你自己**写的控制脚本是 `.ps1` 时才会用到——解释器按扩展名选：`.mjs/.js → node`、`.sh → sh`、`.ps1 → pwsh` |
| 远端 CI | 任意 | `rk-gate ci --write-workflow` 生成 `ubuntu-latest` 工作流（新 clone 天然没有 hook，故需要这条"远端兜底"） |

**实测口径（诚实）**：Windows（Git for Windows）与 Linux（Ubuntu + Node v22.23.2）两侧的全量用例与三个自检门都已跑过；
**macOS 尚未实测**（按设计走系统 `bash`/`sh` 分支）。谁要声称 macOS 可用，请先贴实测。

> **更正（2026-09-16，原文保留不改写）**：macOS **已实测** —— 本仓 CI 的 `test (macos-latest)` 任务在 `main` 上
> 跑全量用例 **531 条（524 pass / 0 fail / 7 skip）**，与 `test (ubuntu-latest)` 同源同结果；凭证是该任务
> check-run 的**注解**（注解无需 token 即可读）：`node --test 通过：# tests 531 # pass 524 # fail 0 # skipped 7`。
> 跳过数差异来自"只对 Windows 有意义"的 Git Bash 用例（POSIX 上显式跳过并说明理由，不是掩盖）。
> 首次真跑同时暴露并修掉 3 处**用例**里的平台二分假设（"非 win32 即 Linux"），详见 CHANGELOG 式提交 `045f91f`。

## 它解决什么问题

纪律写在文档里，靠人记；人一忙就绕过，绕过之后**没人知道**。本工具把三件事做成机械的：

| 能力 | 机制 | 判据 |
|---|---|---|
| **真阻断** | `pre-commit` 钩子：受保护文件"改了但没留证" → 直接拒提交 | 拒时 `exit≠0` 且点名文件 |
| **被绕过也对账** | `--no-verify` 跳过 `pre-commit`，但 `post-commit` 仍执行 ⇒ 台账留痕；`rk-gate bypass` 用 `git log ∖ 台账` 找出"没人看过的提交" | 有差集 → `exit≠0` |
| **远端兜底** | `rk-gate ci`：**不依赖本机 hook**（新 clone 天然没有 hook），按 `base..head` 范围对账 | 未留证改动 → `exit≠0` |
| **删除也算改动** | 提交枚举用 `--name-status`，D 面单列（`--diff-filter=ACMR` 会**整条漏掉**"只删"的提交） | 删受保护文件 → 判红 |
| **台账不自证** | `verdict:"pass"` 必须带可对账物证（`committed == 提交内容 == baseline`），否则判红 | 手写一行 JSON **洗不白** |
| **自进化** | 同一纪律复发 ≥2 次 → `evolve` 生成**提案**（只写 `proposals/`，**绝不自动改规则**） | 闸先于写者 |
| **落点可迁移** | `rk-migrate`：老落点 → 新落点（默认 dry-run；五项核对通过才成功；默认保留旧落点） | 核对不一致 → `exit≠0` 且不删源 |

## 快速开始

```bash
# 1) 建落点（<项目>/.dsh-ai/rulekeeper + <DSH_HOME>/rulekeeper）
node bin/dsh-rulekeeper.mjs init --project <项目根>
#    老落点兼容：若项目里已存在 .dsh-ai/lessonflow，工具会**继续沿用**它（不搬、不新建）

# 2) 配保护面（哪些文件"改之前必须先留证"）
#    <项目>/.dsh-ai/rulekeeper/rules.json 里的 protected_paths
#    没配保护面 = 空转闸：rk-gate ci 会直接判 CI_VACUOUS_NO_PROTECTION

# 3) 装钩子（默认装到 .githooks 并设置 core.hooksPath）
node bin/rk-gate.mjs hooks install --repo <仓库根>

# 4) 生成服务端入口（GitHub Actions，事件感知范围）
node bin/rk-gate.mjs ci --repo <仓库根> --write-workflow

# 日常：改受保护文件前先留证
node bin/rk-snap.mjs take --landing <项目>/.dsh-ai/rulekeeper --path AGENTS.md --project .

# 老项目要搬到新落点（默认 dry-run；--apply 才落盘）
node bin/rk-migrate.mjs --project <项目根>
```

## 命令面（23 个入口）

`dsh-rulekeeper`（init/check/snap/record/rules/evolve/report/gate/redact/migrate）｜`rk-gate`（write/precommit/postcommit/bypass/ci/close/hooks）
｜`rk-check`｜`rk-snap`｜`rk-ledger`｜`rk-rules`｜`rk-doctor`｜`rk-schema`｜`rk-rc`｜`rk-replay`｜`rk-crossplat`｜`rk-selfcheck`｜`rk-shard`｜`rk-baseline`｜`rk-backup`｜`rk-log`｜`rk-env`｜`rk-migrate`｜`rk-redact`｜`rk-stop-loss`｜`rk-shell-revert`｜`rk-dshcompat`｜`rk-effect`（plan/verify/apply/inject —— 生效闭环，见下节）

## 入账 ≠ 生效（`rk-effect`：生效闭环，2026-09-19）

账本记下一条教训，**只证明它被写下来了**，不证明它拦得住任何东西。此前四个洞：

| 洞 | 现象 | 现在 |
|---|---|---|
| ① 没有"生效"的位置 | `rules.json` 的 `checks`/`gates`/`inject` 三个数组**没有任何消费者**（只有 `protected_paths` 活着） | 对象形态条目 = **生效绑定** `{kind, rule, carrier, gate, …}`，由 `rk-effect` 消费 |
| ② 没有写通路 | `proposals/<id>.json` 的 `status='approved'` **没有生产者**，提案落盘后永远变不成判据 | `rk-effect apply`（**唯一**写 `rules.json` 的通路，**必须 `--by human`**） |
| ③ 有实现没接线 | `src/inject.mjs`（LF-430 注入）**零消费者**；`findings.jsonl` **零生产者** | `rk-effect inject` 消费注入面；`rk-effect verify` 写验证凭证 |
| ④ 生效后不回写 | 幂等键把 `approved` 也当"已有提案"跳过 ⇒ **生效后再次复发被静默忽略** | 复发 ⇒ 产**升级提案**（`EFFECT_RECURRED_AFTER_ACTIVATION`）；零信号超期 ⇒ `EFFECT_STALE_NO_SIGNAL` |

```bash
rk-effect plan   --landing <落点>                       # 只读体检：每条纪律 none/injected/mechanized/verified/recurred
rk-effect apply  --landing <落点> --proposal <id> --by human            # 默认 dry-run，先看要写什么
rk-effect apply  --landing <落点> --proposal <id> --by human --apply    # 真写：备份 + 回读 + 失败回滚
rk-effect verify --landing <落点> --all                 # 三项验证：命中红 / 反事实唯一性 / 误报面绿
rk-effect inject --landing <落点>                       # 把"只写下来了"的纪律变成会话提醒（纯计算，零落点写入）
```

**红线**：`rules.json` 的自动写点只有 `rk-effect apply`，且 `--by auto` 一律拒绝——闸门不可被 AI 直接改；
写入前过 `validateRules`（草稿先用目标工具自己的校验器验形状），写失败**一个字节都不留**（逐字节回滚）。

> 精确性补记（P1 事实写作律）：上句"只有 `rk-effect apply`"指**生产路径**。全仓另有一处
> `writeFileSync('rules.json')` 在 `src/stoploss.mjs` 的 `verifyRunbook()` 里 —— 那是它为自己造的
> **临时工作目录夹具**（`{workdir}/proj/.dsh-ai/rulekeeper/rules.json`），不碰任何真实落点。

**验证三项为什么是三项**（对齐"反向红 + 正对照"）：只有"①命中红"的话，把判据整条删掉也照样全绿——
**②反事实唯一性**要求"把这个绑定摘掉之后同一载体必须转绿"，才证明拦住它的**确实是这条判据**
（否则报 `EFFECT_CHECK_NOT_THE_STOPPER`，即挂名生效）。判据载体必须显式写成 `path:<相对路径>`：
没有载体 ⇒ `EFFECT_VERIFY_UNCARRIED`（**凭证不足，禁标"已生效"**）。

**生效之后**：`evolve` 不再对已生效的纪律一律沉默——生效后又复发 ⇒ 产**升级提案**（原档位拦不住）；
生效后长期零信号 ⇒ `effectPlan` 报 `EFFECT_STALE_NO_SIGNAL`（建议退役，**不自动改规则**）。

### 有效性回写与退役通路（LF-A50/A55，2026-09-19）

- **命中（有效性）回写**：`effectPlan` 从门禁台账读**可归属**的真命中——`gate:'close'` 行的 `hits[].rule`
  （收尾闸自报"这批碰到哪条纪律、靠什么拦住"）与 `gate:'precommit'` 行在**绑定 carrier 路径**上的真阻断。
  于是"零信号"= **零命中 + 零复发**（不再只看复发）。诚实边界：precommit 行**不带 rule**，
  载体级命中只能靠"绑定声明的 carrier"归属——这也是绑定必须写 `carrier` 的另一个理由。
- **退役提案**：`evolve`（`--retire-days N`，默认 30 天）对"已生效 + 零命中零复发 + 无未决提案"的纪律
  产**退役提案**（`redCriteria` 前缀 `EFFECT_RETIRE_CANDIDATE`）。四要件**不是推定的判据**，而是
  **实测窗口/计数 + 可否证的底线**（窗口天数、命中数、载体都取自事实；`activationCheck` 写明"什么情况下本次退役作废"）。
- **退役仍走同一条写通路**：`rk-effect apply --proposal <退役提案id> --by human --apply` ⇒ 摘掉**这条纪律自己的**
  绑定与其声明的模式（若该模式仍被**别的**绑定声明则**不摘**，避免"退役变拆台"），并写一条 `生效退役` 账本事件行。
  退役后 `plan` 报 `state=retired`（`EFFECT_RETIRED`，info），**不再**误报"登记了却没绑定"。

**诚实边界（与 `CI_CARRIER_DONE=false` 同族）**：验证凭证 `findings.jsonl` **没有任何签名** ——
能改台账的人也能把"已验证"写全。故 `verified` 是**可核对**（谁/何时/对哪个载体/跑出什么），
**不是不可伪造**；真正的防篡改仍在 git 层（pre-commit 真阻断 / CI 门 / 分支保护 + required checks）。

同一族的另外五条边界（2026-09-19 独立 CR / 对抗性 QA 评审后补齐，逐条都有实测）：

- **`--by human` 是"声明"，不是"签名"**：工具只比较字面量，**无法证明**输入者是人（AI 同样能敲这四个字符）。
  它挡住的是"顺手自动写"（`--by auto` 一律拒绝），挡不住"自签自批"。真正的隔离要靠**权限/会话边界**
  （人不在回路里时，别把写权限交给 AI）。
- **"唯一写通路"仅指"新建绑定"**：`rk-backup restore/rebuild`、`rk-portable rebuild/import` 会**还原或物化**
  整份 `rules.json`（数据保全面，本行不是激活面），手工编辑同理——它们都不经 `rk-effect apply`。
- **`checks` 对象条目是闭集校验，且与门禁同源**：升级到本版后，形状不合规的绑定对象（未知字段、缺 `carrier`…）
  会让 `rk-gate write` 判红（fail-closed）。旧 `rules.json` 请先跑 `rk-rules check` 按提示改写。
- **注入的去重/预算是"单次调用内"的**：`rk-effect inject` 不落盘计数 ⇒ 反复调用会重新产出提醒（id 每次都是新的）。
  > 更正（2026-09-19，P0-3 落地）：**插件侧的投递通道自己维护跨轮状态**——见下节《提醒投递通道》。本行仍适用于 CLI 子命令本身。

### 提醒投递通道（P0-3，2026-09-19）

**为什么有这一节**：`effect.mjs` 早就会算"该提醒哪几条纪律"（`effectInjectPlan()`），但**没有投递口** ——
提醒只落在落点里等人去读，体检的 `injected` 面永远是 0。宿主其实**早就**给插件开放了通道，我们此前误判为
"没有"（还起草了一份要上游新开能力的请求，已作废）。

- **通道**：宿主 `ctx.systemPrompt.context({ name, order, text })`（`@deepseek-ai/dsh-system-prompt`；
  `name = rulekeeper/reminders`，`order = 900`）。宿主把返回文本物化为**持久 user-role 快照消息**，
  且**文本相同不重复追加、变化才 append**（依据：`dsh-agent-loop/lib/index.js:890-893` / `:336-355`）。
  我们 profile 的组合里默认已挂该服务（`dsh-base/cordis.patch.yml:465`、`dsh-web-app/cordis.patch.yml:16`）。
- **三条硬约束**（缺一条就刷屏或静默失效，实现见 `src/deliver.mjs`）：
  1. **文本必须稳定**（宿主按"文本变化"追加 ⇒ 文本里不放时间戳/每次都变的计数）；
  2. **跨轮状态自持**（`injectPlan()` 的 `seenRules` 去重**只在单次调用内**有效——读源码确认）；
  3. **变化最小间隔默认 30 分钟**（文本变化才可能被追加，故对"变化"本身设最小间隔防抖动）。
- **绝不进 system prompt 正文**：动态内容一律走 logged channel（这也是宿主自身的约束）。
- **服务缺失时如实返回原因**（`delivery.reason=no-systemPrompt-service`），**不静默假成功**；
  注册失败 fail-open（绝不让插件树装载失败）。
- **`agent/pre-step`（"命中教训全文随现场注入"）尚未接**——本版只做上面的索引/摘要通道。
  > **更正（2026-09-19，P0-3b 落地）**：已接。全文只在该条目与**本轮消息**相关时才注入（确定性 n-gram
  > 交集打分，阈值/预算见 `preStepCapability()`），且**只追加不替换**宿主 `decision.messages`。
- **落点从哪来（P0-3c，2026-09-19 修缺口）**：插件装载入口 `index.js` 只传 `{ dshRoot, handlers }`，
  **从不传 `landingDir`** ⇒ 此前两条自动通道每轮都拿到 `null`、**静默不投递**（实测：三处落点都没有
  `usage.json`，而同一时刻 `buildReminderText()` 对真实落点返回 3 条 / 589–842 字符 —— **有话可说却没说**）。
  修法见 `src/landing.mjs`，顺序固定且**可报**（`landing.source`）：
  `static`（显式 `landingDir`）→ 现场 `agent.session.header.cwd`（pre-step payload 自带，最准）
  → `noteAgent()` 记下的最近 cwd（给拿不到 agent 的 `systemPrompt.context` 用）
  → `ctx.agents` 根 agent 的 cwd（进程刚起也能解析）→ 项目无落点则退**用户级落点** → 都没有则 `null`。
  取不到时**不投递、不猜路径**，并在 `delivery.reason` / `prestep.landingBound` 上如实暴露
  （"装上但没生效"不再是一个看不见的状态）。诊断字段：`apply` 报告的 `landing.{dir,source}`、
  `delivery.{landingBound,landingSource}`、`prestep.{landingBound,landingSource}`。
  **已知边界（如实登记）**：首轮装配可能早于本轮 `agent/pre-step` ⇒ 会话**第二轮起**才可能有提醒；
  该边界无法在不重启宿主进程的情况下现场复验（进程内已装载的是旧代码），故本轮凭证只到单元级。

### 用量遥测 `usage.json`（P0-3 配套）

- 落点：`<landing>/usage.json`。形状：`{schema, rules:{"<RULE>":{evaluated,emitted,lastAt}}, totalEmitted}`。
- 语义：`evaluated` = 投递提供者被求值次数；`emitted` = 返回**新**文本次数。
  **≠"模型一定看到了"**（宿主对相同文本有自己的去重，插件侧观测不到追加结果——如实登记，不臆断）。
- 纪律：原子写（临时文件 + rename）；读失败/损坏 ⇒ 降级为空账（fail-open，度量失败绝不打断投递）。
- **它不在 SCHEMA.md 的冻结 6 文件里**：`rk-schema` 的冻结单恰好 6 个数据文件（`SCHEMA_FILE_COUNT` 硬校验），
  本文件属**运行态遥测**。⚠ **待决**：是否把它纳入冻结单（要走 §9.8 式契约变更）——当前按"运行态"处理并在此登记。
- **读数在哪儿看**（2026-09-19 补：此前它**只有写者、没有读者**——唯一的读者是用例，等于"度量没人看 = 没有度量"，
  与"取值面未接线"同族）：
  - `rk-effect usage --landing <落点> [--json]`：逐条明细（`RK_EFFECT_USAGE_ROW <RULE> emitted=… evaluated=… lastAt=…`）
    与三个总数（`RULES` / `EMITTED` / `EVALUATED`）；空账时如实打印"空账：没有任何提醒被投递过"。
  - `rk-effect plan`：体检里也带 `RK_EFFECT_USAGE_{RULES,EMITTED,EVALUATED}` 与前 3 名（`RK_EFFECT_USAGE_TOP`），
    ⇒ "投递到底接上没有"从"读代码相信"变成**一眼可读的读数**（本轮实测该行为 `EMITTED=0`，正是它暴露了 P0-3c 的缺口）。
  - `evaluated` 是判断"量增是否伤召回"的**分母**（求值了却没投递 = `unchanged` / 最小间隔 hold / 无落点）。

### 条目级条件的**注解层**（`activations.jsonl`，2026-09-19 契约变更 · 6 → 7 个数据文件）

- **协议问题**：账本 `ledger.jsonl` 是 append-only（行不可原地改写），而 `activation` 是**行内字段**
  ⇒ 给既有条目补"什么时候该想起它"时，改行=违宪；复制新行补字段=制造重复（E2 实测：重复条目
  会把正确教训挤出 top-1）。
- **解法**：注解层 sidecar。`<落点>/activations.jsonl`，一行一条 `{schema, ts, id, activation, by, confidence, evidence}`，
  `id` 指向账本行；读侧**合并**（行内值优先，为空才取注解）⇒ 账本**逐字节不变**（有用例钉住 sha256 相等）。
- **机器起草**：`rk-effect draft-activation --landing <落点> [--limit n] [--write] [--json]`
  - 只从条目**已有**的可观测锚点派生：凭证路径 → `文件:行号`（E1 点名的真原料）→ 项目自有命令 `rk-*` → 具名错误串 → 非 0 退出码
  - **判别力门**：锚点在参与起草的行里出现次数 ≤ `max(2, 15%×行数)` 才算判别性锚点；
    **且**条件必须过 `validateActivation`（含路径/通配符/命令/错误串之一）⇒ 防"灌水式覆盖率"
    （第一版实测产出过 `当命令里出现 git 时`、`当 exit 码为 0 时` 这种恒真废话，已淘汰）
  - 默认**只出草稿**；`--write` 才写注解层（幂等：已注解的不再起草）
- **体检可读**：`RK_EFFECT_ENTRY_ACTIVATION` / `RK_EFFECT_ENTRY_COVERAGE` 取的是**合并视图**；
  `doctor` 抓 `DOCTOR_ANNOTATION_ORPHAN`（注解指向不存在的 id）与 `DOCTOR_ANNOTATION_UNCHECKABLE`（条件不可判）。
- **实测（真实落点，2026-09-19）**：起草 34 条（全部 high，锚点为 `文件:行号`）⇒ 覆盖率
  **0/385 → 31/385（8.05%）**；写注解前后 `ledger.jsonl` 的 sha256 相同。
  其余 **353 条无可观测锚点** —— 与 E1/E3 的结论一致：**缺的是原料，不是工具**。

### `kind:"checker"` 绑定（2026-09-19，objective ③ · 技术类教训的唯一出路）

- **为什么必须有**：现有文件类绑定只能表达"某文件被改了却没留证"。E1 拿 10 条真实技术类教训逐个试：
  **0/10** 对得上那个模型、**10/10** 只能靠"跑检查器 + 用构造的违规样本判红"。此前 `verify` 对非文件类
  kind 直接 `EFFECT_KIND_UNSUPPORTED`（fail-closed），于是"把技术类教训变成机械判据"结构上做不到。
- **字段**（写进 `rules.json` 的 `checks[]`，与已立项设计 P1-1 对齐）：
  `command[]`（argv，**无 shell**）／`expectRed.exitCode`（**必须非 0**，禁 `stdoutContains`）／
  `expectGreen.exitCode`（必须 0）／`redSample{kind:'tree',source}`／`greenSample{...}`（缺省 = 项目根）／
  `sampleHash`（样本内容指纹）／`checkerVersion`／`timeoutMs`。形状在**装载期**就校验（`rules.mjs`）。
- **验证四项 + 三态**：
  ① 命中红（违规样本上 exit 必须等于 `expectRed`）② 误报面绿（合规样本上必须等于 `expectGreen`）
  ③ **反事实唯一性**（两样本结论必须不同：都红=检查器/环境坏了、都绿=判据没有判别力）
  ④ **确定性**（同一输入两次结论一致）。状态：`green` / `red` / `inconclusive`。
- **约定**：检查器**以项目根为 cwd**，被检样本目录由环境变量 `RULEKEEPER_SAMPLE_DIR` 传入
  （同一条命令因此能跑红/绿两个样本）；命中 exit≠0、干净 exit=0。
- **默认不执行**：checker 绑定**只有**加 `--allow-exec` 才会真的跑本地命令；不加时一律 `inconclusive`
  （`EFFECT_CHECKER_EXEC_NOT_ALLOWED`）—— 这是**显式确认**而非安全边界（规则 43 同族自曝）。
- **样本指纹**：`sampleHash` 对不上 ⇒ `inconclusive`（样本事后被改小也能骗过用例，必须作废重签）。
- 样例检查器：`scripts/checkers/leak-check.mjs`（判的是一条**真实复发三次**的纪律：公开面不得出现
  内部标识/本机路径），红/绿样本在 `test/fixtures/checker/{red,green}-sample/`。
- **已知缺口**：checker 绑定目前**还不能经 `rk-effect apply` 落盘**（apply 只构造文件类绑定）
  ⇒ 现在要写它得手工编辑 `rules.json`。下一步：让 apply 认提案里的 `checker:<spec.json>` 标记，
  由已入库的 spec 文件构造绑定（保持"唯一写通路 + 人签字"不破）。
  > **已补齐（2026-09-19 收口，本条取代上面的"已知缺口"）**：提案的 `counterExample` 写
  > `checker:<项目根相对的规格文件>` ⇒ `rk-effect apply --proposal <id> --by human [--apply]` 由
  > **已入库的规格文件**构造 checker 绑定，走**同一条**写通路（备份 → 写入 → 回读校验 → 失败回滚 →
  > 提案置 approved → 账本事件行）。规格文件
  > （`{command, expectRed, expectGreen, redSample, greenSample, sampleHash, checkerVersion, timeoutMs}`）
  > 必须入库（拒绝项目外路径）；落盘前核对：`sampleHash` 与当前样本一致、`rule` 与提案一致、
  > 同一 rule 不得重复挂、AI 不许签字（`--by auto` 一律拒）。具体失败原因码经
  > `RK_EFFECT_APPLY_REASON_CODE` 如实透出（不再被拍平成一个"不合格"）。
  > 样例规格：`test/fixtures/checker/leak-check.spec.json`。

### 锚定式人签字（2026-09-19 · 把"自称 human"换成"宿主问出来的真人应答"）

- **问题**（本仓早自曝过，规则 43）：`rk-effect apply --by human` 里的 `--by human` **只是一个字符串**——
  AI 也敲得出来。而 `rules.json` 是**生效面本身**（改它 = 改哪条纪律真会被拦），所以这一步必须真锚住。
- **锚在哪**：宿主的人机问答通道 `ctx.userQuestions.ask()`（`@deepseek-ai/dsh-user-questions`）。
  它的边界是**运行时归属**（源码逐字）：传入的 agent 必须是注册表里**恰好那个活着的实例**
  （否则 `CALLER_NOT_LIVE`），且**被别的 agent 拥有**的（子代理）会被判 `DELEGATED_CALLER`
  ⇒ **AI 在结构上造不出应答**。
- **怎么用**：插件工具 `rulekeeper_apply`（`{proposal, project?, apply?}`）——
  ①先 dry-run 算清要写什么 → ②问真人（选项标签 `批准落盘` / `拒绝`）→ ③**拒绝 / 问不通 / 应答不可解析
  一律不写**（fail-closed，**绝不退回** `--by human` 声明）→ ④批准才带凭证落盘。
- **落点级开关**：`config.json` 的 `requireAnchoredApproval: true` ⇒ 没有锚定凭证的写入**一律拒**
  （`EFFECT_APPROVAL_NOT_ANCHORED`），CLI 也拦。缺省不要求（老落点行为不变）。
- **凭证进账本**：`approval=anchored(<questionId>) decision=approve digest=<12 hex>`；
  没有凭证时**逐字**写 `approval=declared(--by human 字符串；非锚定)` —— 不假装字符串是签名。
- **诚实边界**：凭证是**可核对**（问答内容进宿主会话记录、可人工比对），**不是密码学签名**；
  能改落点文件的人仍能把字段抄进去。防伪造落在流程层：唯一会问真人的提供者是 `rulekeeper_apply`，
  且问不通就不写；要更硬须引入外部签名密钥（未做，如实登记）。

### 提醒落点的**多会话**问题：止血（甲）+ 根治（乙）（2026-09-20）

**问题**：`systemPrompt.context()` 以前只注册**一份**（根上下文）——整个宿主进程共享。它的 provider
**拿不到 agent**，只能靠"最后一次 `agent/pre-step` 记下的目录"猜是哪场会话 ⇒ 同时开着两个不同项目的
会话时 **last-writer-wins**，提醒会**串到另一个项目的落点**（张冠李戴）。

**甲（止血，`929d03a`）**：只在**拿不到 agent 的那条通道**上生效 ——
新增 `landing.liveCwds(ctx)`（从 `ctx.agents` 取全部会话目录、去重）；当**两处以上不同目录在线**时
**只投用户级落点**（`source=user-multi-project`；用户级纪律与项目无关，绝不会张冠李戴）；
没有用户级落点 ⇒ 返回空（`multi-project-no-user-landing`，**宁可不说也不说错话**）。
单会话 / 同项目多会话行为不变；`agent/pre-step` 全文通道**不受影响**（它拿得到真实会话，本来就精确）。

**乙（根治，本轮）**：把提醒位注册进**每个会话自己的作用域**（`agent.ctx`，宿主文档逐字：
"Agent-scoped context; its contributions are agent-local, unwind on disposal, and reject registration
afterward."）⇒ provider 用**该会话自己的 cwd**解析落点，不再需要猜；跨轮状态（去重 / 最小间隔）
与遥测也随之**按会话分开**。实现见 `src/scoped.mjs`：
- 每个会话一个唯一注册名 `rulekeeper/reminders#<会话id>`（同作用域重名会抛）；
- 落点来源 `agent-project` / `agent-user-fallback`（沿用"项目优先、用户级兜底"口径）；
- 拿不到 `agent.ctx` 或作用域里读不到 `systemPrompt` ⇒ 如实 `{ok:false}`（**不抛**），
  此时**根通道继续兜底**（甲的多项目规则仍然生效）——"乙不成立也不能变哑"；
- **根通道让路**：当**所有**活着的会话都已按作用域注册成功时，根通道的 provider 返回空串，
  避免同一份提醒被投两遍（两次注册是两份不同 name 的 context）；判定每次求值现算，判定函数抛错时
  照常投递（**宁可重复也不静默**）。
- 报告里 `scoped` 是**实时读数**（getter）：`{registered, failed:[{agent,reason}], mode: root-only|per-agent|mixed}`。

**真 cordis 实测（乙）**：两个真实作用域（模拟两个会话、两个项目）⇒ 注册名不同、
各自的 provider **只投自己项目的纪律**（`CAT-AAA` 里没有 `CAT-BBB`，反之亦然）、
各自落点的 `usage.json` 各记 1 条 emitted、rc=0。

### 生效面口径变更：从"类目层"到"条目层"（P0-2，2026-09-19）

- **旧口径**问"这个**类目**有没有生效绑定"⇒ `TEXT_ONLY 21/22` 是**结构必然**（类目只是分组标签，不承担生效语义；
  成熟实现把条件挂在**每一条**上）。
- **新口径**问"**条目**有没有一条可判激活条件"：账本行新增可选字段 `activation`（见 SCHEMA.md），
  体检新增两行读数：`RK_EFFECT_ENTRY_ACTIVATION=<带条件条目>/<总条目>` 与 `RK_EFFECT_ENTRY_COVERAGE=<百分比>`；
  缺条件时产 `EFFECT_ENTRY_NO_ACTIVATION`（**severity=info**，不改 ok / exit code）。
- **实测起点**：`RK_EFFECT_ENTRY_ACTIVATION=0/385` —— 385 条账本行里**0 条**带可判条件。
  这正是"缺原料"（不是"缺工具"）：先补条件/反例/误报面，再谈自动捕获或生命周期治理。
- **零信号只报 `EFFECT_STALE_NO_SIGNAL`（warn），不自动产退役提案**：提案四要件必须**由人显式给**，
  工具不替人编判据（"自动生成的是草稿不是规则"）。
  > 更正（同日稍后，LF-A55 落地）：**已实现自动退役提案**——`evolve --retire-days N` 会为零信号的已生效纪律
  > 产退役提案；四要件不是"推定的判据"，而是**实测窗口/计数 + 可否证的底线**（见上节）。上面这条仅保留作
  > 决策轨迹：当时以"要件不能推定"为由砍掉，后确认"量出来的事实"不属于推定。**真正不可自动化的仍是"摘绑定"**——
  > 它必须人签字走 `rk-effect apply`。

## 硬约束（不是"最佳实践"，是设计底线）

- **零依赖**：只用 `node:*`（`rk-selfcheck` 的 S4 机械拦裸导入与 `require`）。
- **fail-closed**：拿不到范围/结果不可信/规则表为空 → 判红，不判绿。
- **自曝边界**：做不到的事写在输出里而不是藏在文档里——例如 `CI_CARRIER_DONE=false`（远端 CI 未真正执行过）、
  `RK_GATE_CI_LEDGER_AUTHENTICATED=false`（台账无签名，能改台账的人也能把物证写全；真防篡改靠分支保护 + required checks + CODEOWNERS）。
- **判据可被弄红**：每条判据都配"红态样本"，且有**变异测试**矩阵（把判据改坏 → 用例必须失败）。
- **判据输出不含绝对路径**（跨机可复现）。
- **公开面零基础设施信息**：S8 扫发布面全量文件，命中"真实 IP / 私钥头 / 云凭据真值 / 私钥文件名 / 本机绝对路径"等即判红。

## 判据自证检查（`rk-selfcheck` S10，2026-09-19）

本包自己有四条纪律（源头见 SKILL §9.17），其中**关于"判据怎么写"的三条**已落成 S10 的结构化不变式
（跑 `rk-selfcheck` 即生效，不是文档约定）：

| 检查项 | 断言 | 对应纪律 |
|---|---|---|
| `S10_AGGREGATE_AS_HIT` | `src/effect.mjs` 不得用聚合布尔（`hit.ok === false`）当命中判据 | 判据必须绑定被测对象自身 |
| `S10_OBJECT_VERDICT_MISSING` | `src/effect.mjs` 必须存在对象级判定 `carrierVerdictOf(` | 同上 |
| `S10_SAMPLE_NOT_CONSTRUCTED` | 必须存在 `buildSampleLanding(`（违规样本**构造**出来，不靠现场） | 判据必须可复现 |
| `S10_SELF_ATTEST_NO_DISCLOSURE` | 发布面带自称型签字 flag ⇒ README 必须同时有自曝（"这是声明、不是签名"） | 自称型控制不是安全边界 |
| `S9_UNWIRED_MODULE` | `src/**/*.mjs` 必须从入口沿静态 import 可达 | 新模块/导出必须有生产消费者 |

**跨项目用法（用户级落点）**：把纪律登记到用户级落点后，用 `inject` 绑定把它们挂成"软生效面"——
`rk-effect plan` 会显示 `RK_EFFECT_INJECTED=N`（而不是 `none`），`rk-effect inject` 用**该绑定自己声明的**
`target/wanted/reason` 生成提醒（`inject` 条目的 `fields` 是**真被消费**的，不是装饰）。

## 安装到 DSH（两种方式）

本包既是 **CLI**（`node <包目录>/bin/rk-gate.mjs …`），也是 **DSH 插件/bundle**（入口 `index.js` + bundle 补丁 `dsh-rulekeeper.patch.yml`）。
`dsh plugin` 子命令是对 **pnpm** 的直通（`dsh plugin --profile <档> add | remove | list`），所以两种方式在三平台一致。

### 方式 1：本地挂载（推荐起步）

```bash
git clone https://github.com/0embsd/dsh-rulekeeper.git <包目录>
dsh plugin --profile <你的档> add link:<包目录>
# ⚠ 实测提醒：`add` 只写 dependencies；bundle 清单是**手工表** —— 请确认
#    <档目录>/package.json 的 dsh.profile.bundles 里出现 "dsh-rulekeeper"
#    （2026-09-16 补充实测：对**带 `dsh.bundle.patch` 的包**，`dsh plugin add` 会**自动**同时登记进
#     `dsh.profile.bundles`；上面那句"手工表"在更早的 DSH 构建上成立。无论哪种，**装完核对一次**最稳。）
# 然后**重启该档 DSH**（插件树在启动时装载）
```

本包**没有构建步骤**（纯 ESM、零 npm 依赖），**不需要** `npm run assemble`、也没有 `dist/` 需要挂——直接挂包目录即可。

### 方式 2：从 npm 安装（发布到 npm 之后）

```bash
dsh plugin --profile <你的档> add dsh-rulekeeper
```

尚未发布到 npm 时请用方式 1。

### 装完怎么验证（三条，缺一不算装上）

```bash
node <包目录>/bin/rk-dshcompat.mjs                            # 宿主契约探针（事件名 / 形参 / decision 形状）
node <包目录>/bin/rk-selfcheck.mjs --root <包目录>            # 期望 FINDINGS=0 / RESULT=pass
node <包目录>/bin/rk-gate.mjs hooks verify --repo <某个仓库根> # 真调一次工具面
```

### ⚠ 装上之后，`rulekeeper_*` 工具默认是**空壳**（诚实边界，2026-09-16 实测）

- 插件装载后注册的三个工具（`rulekeeper_gate` / `rulekeeper_record` / `rulekeeper_snap`）**默认不判定、不写任何东西**：
  调用返回 `{ok:false, configured:false, reason:'本工具未注入 handler（默认零副作用）'}`（`src/plugin.mjs` 的 `toolDefinition()`）。
  这是**设计**：本包只提供"装得上 + 与第三方同场不互相打断"的契约面，真正的判定逻辑由**消费者注入** `handlers`
  （`apply(ctx, { handlers })` / `index.js` 的默认装载**不注入**任何 handler）。
- 因此装机后立刻可用的形态是 **CLI**：`node <包目录>/bin/dsh-rulekeeper.mjs <子命令>`（以及 `rk-gate` / `rk-snap` / `rk-migrate` 等入口）。
- 想要"会话里点一下就跑真判定"，需要消费者侧注入 handler；若要用**硬阻断**，消费者应走 `ctx.tools.guard(name, handler)`
  而非 `register`（见 `src/guard.mjs`）——那会真的拒绝宿主动作，属部署决策，不在默认安装面内。

> **已修（2026-09-16，同日）**：上面这段"默认是空壳"是**当时的实现缺陷**，不是应有行为 ——
> 老板当场指出"插件装上了不能用，装它干嘛"。现在默认装载**注入包内真实实现**（`src/handlers.mjs`）：
> `rulekeeper_gate` 真判定（只读 allow/deny）、`rulekeeper_record` 真追加取证台账行、`rulekeeper_snap` 真留 pre-image 快照；
> 落点默认 `<项目>/.dsh-ai/rulekeeper`，`mode=off` 仍零副作用。**边界不变**：判定是**只读**的，
> 要"真的拦下来"必须由消费者改用 `ctx.tools.guard`（默认安装面不阻断任何操作）。

### 卸载

```bash
dsh plugin --profile <你的档> remove dsh-rulekeeper
# 并把 <档目录>/package.json 的 dsh.profile.bundles 里的 "dsh-rulekeeper" 删掉
```

### 排障

- **档起不来**：多半是"同名工具/事件重复注册"（同一档里装了功能重叠的插件）→ 先 `remove` 掉冲突的那个。
- **装完没反应**：① 忘了重启档；② `dsh.profile.bundles` 里没登记（见方式 1 的提醒）；③ 宿主契约不符 —— `rk-dshcompat.mjs` 会点名具体哪条不符。
- **只想用 CLI**：不装插件也能用：`node <包目录>/bin/dsh-rulekeeper.mjs <子命令>`。

## 独立性 / 边界

- 本仓**独立演进、独立发布**：不引用、不依赖任何内部项目，也不需要任何内部服务。
- 本仓**不含**主机地址、私钥、云凭据与使用者身份信息（S8 机械保证，见上）。
- 工具的开发计划与内部凭证台账**不在本仓**（历史不改）。

## 状态与边界

- **524 个用例**（Windows：523 pass / 0 fail / 1 skip）、**22 个入口**、`node --check` 0 失败；
  `rk-selfcheck` / `rk-schema` / `rk-rc` 三门 0 finding；`scripts/gen-expected.mjs --check` 逐字一致。
  - **更正（2026-09-16，原文保留不改写）**：用例数已增至 **531**：Windows 本机 530 pass / 0 fail / 1 skip；
    Linux 与 macOS（CI 实测，凭证见上文注解）各 524 pass / **0 fail** / 7 skip。三门自检与基准逐字比对仍在 Windows 侧重跑。
- 环境：**Node ≥ 22**，纯 ESM；Windows 与 Linux 双侧已实测（见"运行环境"）。
  - ⚠ **历史更正（保留不改写）**：更早版本本行曾写"Windows 与 Linux 两侧都有实测凭证"，**当时是错的**——Linux 侧
    从未真正跑过；首次在 Linux 上跑暴露 15 例失败，根因是 `GIT_BASH_DEFAULT` 写死 Windows 路径（`C:\Program Files\Git\bin\bash.exe`）。
    该硬编码已改为**平台自适应**（win32 → Git Bash；其它 → `bash`），并在 Linux 侧复跑到 0 失败。**macOS 仍未实测。**
    - **更正（2026-09-16，原文保留不改写）**：macOS 已实测通过（CI 的 `test (macos-latest)`，531 用例 0 失败，凭证见"运行环境"节）；
      首次真跑还暴露了**同类硬编码的第三种形态**——三处**用例**把"非 win32"当成 Linux（载体标记、L4 的 uname/node 平台、假声明判定），
      已按真实平台改为三支（win32 / darwin / linux），产品侧判据本身无误。
- 已完成（曾列在"未做"里）：落点目录迁移（老 `.dsh-ai/lessonflow` → 新 `.dsh-ai/rulekeeper`，含兼容窗口与 `rk-migrate`）、
  `core.autocrlf=true` 下的跨形态对比口径、写入侧脱敏收敛 + `--check` 扫描。
- 仍未做：分支保护强制项（需仓库 token）、macOS 实测、远端 CI 的**真实载体**运行（当前如实自曝 `CI_CARRIER_DONE=false`）。
  - **进展（2026-09-16，原文保留不改写）**：macOS 实测**已完成**、远端 CI **真实载体已运行**（`main` 上 `gate` 与两个平台任务全绿，
    凭证为 check-run 注解）。**仍未做**：
    ① **分支保护强制项**（把 `gate` / `test (ubuntu-latest)` / `test (macos-latest)` 设为 required status checks）——需仓库管理员在 GitHub 设置里开；
       - **已完成（2026-09-16）**：三个 context 已写入 `main` 的 required status checks（`strict=true` = 合并前须与目标分支同步，
         `enforce_admins=false` ⇒ 管理员仍可直推）。读回复核：`GET /branches/main/protection` →
         `contexts = gate | test (ubuntu-latest) | test (macos-latest)`、`strict=true`、PR 要求未启用、禁强推 / 禁删除分支。
       - **同批教训**：只勾"Require status checks"开关而**不选检查名** ⇒ `required_status_checks.contexts` 为空 = **空转闸**
         （页面看着配了、实际一条都不拦）——与本工具 `CI_VACUOUS_NO_PROTECTION` 要防的是同一件事：**配完必须回读明细，不能只看勾选框**。
    ② `CI_CARRIER_DONE` 仍**恒为 false**：本机代码无法自证远端执行，标注 true 必须另附远端运行记录（凭证制，不由工具自动推断）。

## 许可证

MIT（见 `LICENSE`）。第三方思路致谢与红线见 `NOTICE.md`。
