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

**验证三项为什么是三项**（对齐"反向红 + 正对照"）：只有"①命中红"的话，把判据整条删掉也照样全绿——
**②反事实唯一性**要求"把这个绑定摘掉之后同一载体必须转绿"，才证明拦住它的**确实是这条判据**
（否则报 `EFFECT_CHECK_NOT_THE_STOPPER`，即挂名生效）。判据载体必须显式写成 `path:<相对路径>`：
没有载体 ⇒ `EFFECT_VERIFY_UNCARRIED`（**凭证不足，禁标"已生效"**）。

**生效之后**：`evolve` 不再对已生效的纪律一律沉默——生效后又复发 ⇒ 产**升级提案**（原档位拦不住）；
生效后长期零信号 ⇒ `effectPlan` 报 `EFFECT_STALE_NO_SIGNAL`（建议退役，**不自动改规则**）。

## 硬约束（不是"最佳实践"，是设计底线）

- **零依赖**：只用 `node:*`（`rk-selfcheck` 的 S4 机械拦裸导入与 `require`）。
- **fail-closed**：拿不到范围/结果不可信/规则表为空 → 判红，不判绿。
- **自曝边界**：做不到的事写在输出里而不是藏在文档里——例如 `CI_CARRIER_DONE=false`（远端 CI 未真正执行过）、
  `RK_GATE_CI_LEDGER_AUTHENTICATED=false`（台账无签名，能改台账的人也能把物证写全；真防篡改靠分支保护 + required checks + CODEOWNERS）。
- **判据可被弄红**：每条判据都配"红态样本"，且有**变异测试**矩阵（把判据改坏 → 用例必须失败）。
- **判据输出不含绝对路径**（跨机可复现）。
- **公开面零基础设施信息**：S8 扫发布面全量文件，命中"真实 IP / 私钥头 / 云凭据真值 / 私钥文件名 / 本机绝对路径"等即判红。

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
