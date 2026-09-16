// dsh-rulekeeper · CLI 运行体（LF-140 前置：把 rc 变成可测的返回值）
//
// 设计理由（对齐 golang-cli 的同类纪律）：**命令实现里不直接 process.exit**，
// 一律「返回值 = rc」，由 bin/*.mjs 薄壳写进 process.exitCode。
// 好处：①rc 可在单测里断言（无需起子进程）②io 可注入（输出可捕获，便于"未达执行路径"断言）
// ③rc 常量集中取自 rc.mjs，禁散落字面量。
//
// 归属：core 模块。零依赖：只用 node:*。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import { ensureLanding, MODES } from './config.mjs';
import { backupFile, listBackups, restoreFile } from './backup.mjs';
import { CHECK_KINDS, compareWithExpected, displayPath, loadShapeBaseline, measureFile, PKG_ROOT, runCheckKind, shapeBaselineKey } from './checks.mjs';
import { evolve as runEvolve, fileSha256, rulesPathOf } from './evolve.mjs';
import { runReplayAll } from './replay.mjs';
import { recordBaseline, verifyBaseline } from './baseline.mjs';
import { applyGc, planGc, shardLedger } from './shard.mjs';
import { reconSnapshots, restoreSnapshot, takeSnapshot } from './snap.mjs';
import { bypassRecon, ciGate, closeGate, parseHit, postCommitRecon, precommitGate, reconWrite, writeCiWorkflow, CI_WORKFLOW_REL } from './gate.mjs';
import { DEFAULT_HOOKS_PATH, defaultRunGitRaw, installHooks, verifyHooks } from './hooks.mjs';
import { uninstallHooks } from './uninstall.mjs';
import { exportLanding, isInside, rebuildLanding, writeBundle } from './portable.mjs';
import {
  GIT_BASH_DEFAULT,
  L3_CROSS_DONE, L3_CROSS_REASON, LINUX_CARRIER_DONE, LINUX_CARRIER_REASON,
  compareNormalized, fakeLinuxClaimGuard, fakePlatformGuard, gitBashProbe, hookArtifactChecks,
  injectedEolCases, injectedPureFunctionCases,
  simulateOtherSide, structuralChecks, verifyComparator, windowsByteIdentical,
} from './crossplat.mjs';
import { doctor, doctorExitCode } from './doctor.mjs';
import { importLedger } from './importer.mjs';
import { landingFingerprint, migrateLanding, planMigration } from './migrate.mjs';
import { query as queryLedger, readLedger, record, summary as ledgerSummary } from './ledger.mjs';
import { listLogFiles, readEntries, rotateIfNeeded, totalBytes } from './log.mjs';
import { RC, checkRcTable, renderRcTable } from './rc.mjs';
import { checkSchema, renderSchemaMarkdown } from './schema.mjs';
import { canonicalRule, dedupe, detectRuleDivergence, ruleFragmentation } from './ruleid.mjs';
import { redactText, redactValue, scanText, selfTestRules, statsOf } from './redact.mjs';
import {
  CONSUMERS, checkConsumersConsistency, effectiveConfig, isProtected, loadLandingRules, loadRules,
} from './rules.mjs';
import { UsageError, resolveNow, stamp } from './platform/clock.mjs';
import { dshHome, LANDING_DIRNAME, LANDING_REL, pathKey, resolveProjectLanding, toPosix } from './platform/paths.mjs';
import { jsonStable, line, resultLine, sortCodePoints, write as stdWrite, writeErr as stdWriteErr } from './platform/out.mjs';
import { checkSkeleton } from './selfcheck.mjs';
import { readMode } from './mode.mjs';
import {
  RUNBOOK_STEPS, applyStopLoss, checkRunbook, evaluateStopLoss, readMetrics, retireGate, verifyRunbook, writeRunbook,
} from './stoploss.mjs';
import {
  dropShell, restoreShell, SHELL_FIXTURES, snapshotShell, verifyShell,
} from './shellrevert.mjs';

export function defaultIo() {
  return { out: stdWrite, err: stdWriteErr };
}

export const USAGE_CROSSPLAT = `用法: rk-crossplat [--project <项目根>] [--now <ISO>] [--claim-platform <win32|linux>] [--no-normalize] [--inject-now-diff] [--json]
三层判据:
  L1 结构    —— 全部 .mjs 为 LF 无 BOM、零依赖、type/engines 声明、src+bin 的相对 import **大小写与磁盘一致**
  L2 归一文本 —— 本机侧 ∥ "另一平台侧"（把本机输出按 Linux 形态模拟改写：CRLF + \\→/ + 根替换），
                删 CR + \\→/ + 绝对前缀替换后 **diff 必须 0 行**；未归一时**必须**有差异（否则归一是摆设）
  L3 逐字    —— **同平台（本机）**同命令两次逐字相同；**L3 跨平台不做**（无 Linux 载体，见下方原因）
说明: --no-normalize 是取证开关（不做归一时**应当**红）；--inject-now-diff 注入时间戳差异（时间戳不归一时**应当**红）；
      --claim-platform 用于验证"防假绿"守卫（声称在别平台验过 -> 判红）。
退出码: 0 三层都过 / 1 任一层失败或宣称不成立 / 2 用法错误`;

export const USAGE_SNAP = `用法:
  rk-snap take    --landing <落点> --path <文件> [--project <项目根>] [--now <ISO>] [--why <文本>] [--json]
  rk-snap restore --landing <落点> --path <文件> [--project <项目根>] [--json]
  rk-snap recon   --landing <落点> [--project <项目根>] [--json]
说明: LF-300/310/320。take = 备份 + **回读校验** + snapshots/index.jsonl 登记（回读不一致则**不登记**并报错）；
      restore = 按最新快照回滚（无快照 -> NO_SNAPSHOT(3)，禁静默成功）；recon = 快照↔账本对账，
      "有记录无备份"与"有备份无记录"两类都报，任一类非空即 exit≠0。
退出码: 0 通过 / 1 快照或对账失败 / 2 用法错误 / 3 无快照（NO_SNAPSHOT）/ 4 备份缺失（NO_BACKUP）`;

export const USAGE_SHARD = `用法:
  rk-shard split --landing <落点> [--keep-days n] [--now <ISO>] [--apply] [--json]
  rk-shard gc    --landing <落点> [--dry-run] [--apply] [--json]
说明: LF-2C0 分片 + gc + 引用完整性。split 把早于 --keep-days 天的行搬进 shards/ledger-YYYYMMDD.jsonl，
      铁律是"写新片 -> 回读校验 -> 才动旧片"（校验不过就整步失败、原文件不动）。gc **默认 dry-run 只报告**，
      --apply 才真删；被 proposals 四要件或其它行 evidence[] 引用的行**永不删**（后置断言兜底）。
退出码: 0 通过 / 1 有违规（回读校验失败 / 计划含被引用行）/ 2 用法错误`;

export const USAGE_BASELINE = `用法:
  rk-baseline record --landing <落点> [--project <项目根>] [--now <ISO>] [--max-files n] [--no-backup] [--dry-run] [--json]
  rk-baseline verify --landing <落点> [--project <项目根>] [--json]
说明: LF-2B0 首次启用基线 + 账本自污染防护。record 把受保护文件的当前 sha256 记进 snapshots/index.jsonl（幂等、
      **落点内自产物一律排除并计数**）——这样"首启"不会把存量文件全报违规；verify 比较现状与基线记录。
退出码: 0 通过（verify 时违规数 == 0）/ 1 有违规或索引不洁 / 2 用法错误`;

export const USAGE_REPLAY = `用法: rk-replay [--project <项目根>] [--landing <落点>] [--declaration <声明.json>] [--collapsed <塌陷样本>] [--now <ISO>] [--json]
说明: LF-270 历史缺陷回放（L412 文件名注入 / L451 输出塌陷 / L454 半失效）。每条结论只允许
      hit（已被机械判据命中）或 uncheckable（须附**通过 LF-2A0** 的实证声明：探针命令 + 非空输出 + 正对照 + falsifier + 有效期）。
退出码: 0 三条都命中或都有合格实证 / 1 有 miss（既没命中也没有合格实证）/ 2 用法错误`;

export const USAGE_CHECK = `用法:
  rk-check untracked-change --file <文件> --landing <落点> [--project <项目根>] [--json]
  rk-check output-shape     --file <输出文件> [--min-lines n] [--max-lines n] [--max-line-length n] [--result-line-pattern re] [--json]
  rk-check invalid-reference --file <文本> [--scope <提供 §N 标题的文件>] [--project <项目根>] [--json]
  rk-check shape            --file <样本> [--lines n] [--maxline n] [--sha256 <冻结值>] [--json]
  rk-check uncheckable      --file <声明.json> [--landing <落点>] [--now <ISO>] [--max-days n] [--json]
退出码: 0 通过 / 1 违规 / 2 用法错误
说明: --json 时 stdout **只输出判决 JSON**（键按码位排序、无时间戳、无绝对路径），可与 expected/*.json 逐字比对
      uncheckable（LF-2A0）三件套：探针命令 + 非空输出 + **正对照样本与其输出**，另加 falsifier 与有效期（≤30 天，再复发即失效）`;

export const USAGE_REDACT = `用法: rk-redact --text <字符串> [--identity] [--json]
       rk-redact --check [--project <项目根>] [--landing <落点>] [--identity] [--json]
       rk-redact --self-control [--json]
说明: LF-340 脱敏（写入侧单点 + 扫描复验）。--text 只出计数与脱敏后的文本；--check 扫描落点既有产物，
      命中即 exit=1，且**只打印规则名/行号/计数**（从不打印原文）；--self-control 是正对照（命中数必须 >0）。
      四类规则：家目录/用户名路径、凭据（私钥块/已知形态/键值赋值/连接串/头部）、联系方式（邮箱/手机号）；
      identity 类（身份证）默认关，需 --identity 显式打开。零依赖；不声称"密钥移除"，是 known-pattern scrubbing。
退出码: 0 通过 / 1 命中残留或规则自测失败 / 2 用法错误`;

export const USAGE_GATE = `用法: rk-gate write [--project <项目根>] [--landing <落点>] [--file <相对路径>]... [--phase open|close] [--json]
       rk-gate precommit [--repo <仓库根>] [--landing <落点>] [--clear-index] [--now <ISO>] [--json]
       rk-gate postcommit [--repo <仓库根>] [--landing <落点>] [--sha <commit>] [--now <ISO>] [--json]
       rk-gate bypass [--repo <仓库根>] [--landing <落点>] [--limit <n>] [--all] [--json]
       rk-gate ci [--repo <仓库根>] [--landing <落点>] [--base <sha>] [--head <sha>] [--all]
                  [--write-workflow] [--workflow <相对路径>] [--workflow-range '<ci 参数>'] [--bin <相对入口>]
                  [--bin-sha <sha256>] [--claim-remote] [--limit <n>] [--json]
       rk-gate close [--project <项目根>] [--landing <落点>] [--hit "<纪律>=<拦住它的机制>"]... [--none] [--batch <名>]
                     [--evidence <路径>]... [--declaration <实证.json>] [--now <ISO>] [--json]
       rk-gate hooks verify  [--repo <仓库根>] [--hooks-path <.githooks>] [--json]
       rk-gate hooks install [--repo <仓库根>] [--hooks-path <.githooks>] [--force] [--no-config] [--json]
       rk-gate hooks uninstall [--repo <仓库根>] [--json]

write = 写入侧对账（LF-530，**不依赖 git**）：受保护文件的「当前 sha256」必须等于「最新留证基线」
  （= snapshots/index.jsonl 里该路径**最新**记录的 sha256_after ?? sha256_before）。
  · 白名单 = **有效保护面**（config.json 覆盖 rules.json 的 protected_paths）；无保护面时如实打 RULES_PRESENT=false（不冒充通过）
  · 不带 --file 时**遍历项目根**（跳过 .git / node_modules / .dsh-ai 自产物并计数上报）
  · mtime 只作辅助上报：**判定只看 sha256**（mtime 会被复制/编辑器污染 —— 拿它判红会假红、判绿会假绿）
  · 清单要求"收尾与开场各跑一次"：--phase 只作标签，两端判红语义相同

precommit = pre-commit **真阻断**（LF-500，暂存区视角）：暂存内容 != 最新留证基线 或 从未留证 -> 拒（exit≠0）
  · 与 write 是**同一判据的两个视角**（暂存区 / 工作区），共用 baselineOf()+effectiveConfig()
  · **拒绝时默认不动暂存区**；要清空必须显式 --clear-index（破坏性动作不给默认开）
  · 无论是否清空，都会往 <落点>/logs/gate.jsonl 追加一条**未清空台账**（append-only）；
    被拒改动留在暂存区会被下次 \`git commit --no-verify\` 夹带 —— 台账就是这件事的凭据

postcommit = 提交后取证（LF-510，由 post-commit hook 调用）：记录**这次提交**里受保护路径的取证结论
  · **通过也记**（"这次提交有取证"的凭据）；有违规则 exit≠0 并写进台账（bypassSuspected=true）
  · 关键实测：\`git commit --no-verify\` **跳过 pre-commit，但 post-commit 仍执行** ⇒ 这里是"被绕过"的取证位置

bypass = 绕过对账（LF-510）：git log 里"动过受保护路径的提交" **差集** 台账里有 post-commit 记录的 sha
  · 没条目的提交 = 那次提交**根本没人看**（hook 未装/未启用/绕过且无取证）-> exit≠0 并列出该 sha
  · 远端防线（CI / 受保护分支）是另一个条目 LF-540，本命令只覆盖本地可判定部分

ci = 远端防线（LF-540，**服务端入口**：新 clone 没有 hook 时的兜底）
  · 范围对账复用 bypass 的同一实现（--base..--head 或 --all），"动过受保护路径但台账无取证" -> exit≠0
  · **删除也算改动**：删掉受保护文件同样判红（--diff-filter=ACMR 看不见 D，故单列 D 面）
  · **台账不再自证**：verdict:"pass" 必须带可对账物证（protectedPaths[].committed == 提交内容 == baseline），
    否则判红（防"追一行 JSON 洗白"）；ledgerAuthenticated=false 是**自曝边界**（无签名 ⇒ 能改台账的人也能写全物证）
  · **空转闸判红**：保护面为空、或保护面**匹配不到任何真实文件** -> CI_VACUOUS_NO_PROTECTION / CI_PROTECTION_MATCHES_NOTHING
  · **配置完整性**：工作流必须与生成内容逐字一致（缺文件/被放宽 -> 判红）；--write-workflow 显式生成
  · **范围口径**：生成物默认用 github.event.before..github.sha（push 判"这次推上来的"）；
    拿不到 before（首次 push / pull_request）时 --base 为空 ⇒ **自动退回全历史**（fail-closed，不默认放行）；
    --workflow-range <参数> 可生成固定范围（首次接入/一次性 backfill 用）
  · **自曝边界**：CI_CARRIER_DONE=false（无远端/未 push/分支保护需 token）—— 本机模拟**不冒充**远端已执行，
    显式 --claim-remote 判红；谁要说"远端 CI 拦住了"必须另附远端运行记录（并需分支保护 + required checks，属老板保留项）

close = **收尾闸**（LF-550）：close 必答"本批碰到哪几条纪律、靠什么拦住"
  · 必须**显式作答**（--hit 或 --none；沉默不算答）· 纪律必须在**账本里真实存在**（canonical 口径）
  · "拦住它的机制"必须是已知门（本系统实现的门 / 项目既有门 / ci / human）
  · 把"不可机检"当免责（stoppedBy=uncheckable）**必须附 --declaration**（LF-2A0 三件套 + falsifier + 有效期）
  · 结论（pass/rejected）都写进 <落点>/logs/gate.jsonl

hooks = hook 完整性 preflight（LF-520）：hooksPath + hook 文件存在 + sha256 + 可执行位（索引 mode=100755）
  · 红态：①hook 缺失 ②改 1 字节 ③装到 .git/hooks/ 而非 hooksPath（**git 根本不会执行它 = 假安装**）
  · install 默认会设置本仓 core.hooksPath（不设 = hook 永不执行）；--no-config 只写文件不改配置
  · install 会**先记下安装前的 core.hooksPath 原值**；uninstall（LF-810）据此**原样还回去**（原本没设就 unset）
  · uninstall = 摘 hook + 摘 runner + 还 config + 删清单，**绝不删数据**；重复卸载 exit=0（幂等）；
    手改过或名单异常的文件**保留不删**（HOOK_MODIFIED_KEPT / HOOK_NAME_UNEXPECTED 等 FINDING，仍 exit=0）；
    数据有丢失（文件消失/条数减少）或 core.hooksPath 还原失败 → exit≠0
退出码: 0 全部合规（或本项目没有保护面）/ 1 有未留证的直写、hook 完整性违规或卸载丢数据 / 2 用法错误`;

export const USAGE_RULEKEEPER = `dsh-rulekeeper 0.1.0
用法:
  dsh-rulekeeper init    [--project <dir>]                     建立两处落点 + config.json（默认 mode=observe）
  dsh-rulekeeper check   --landing <dir> [--project <dir>]     自检：账本/落点可信性（doctor）+ 计数
  dsh-rulekeeper snap    --landing <dir>                       pre-image 快照（**未实现**，属 LF-300）
  dsh-rulekeeper record  --landing <dir> --rule <r> --problem <p> --root-cause <r> --solution <s> [--category c] [--mechanism m] [--evidence a,b]
  dsh-rulekeeper rules   <check|is-protected|effective> …      规则包校验 / 单点判定 / 生效配置
  dsh-rulekeeper evolve  --landing <dir> [--quality <file.json>] [--source auto|human] [--escalate-gate] [--rule r] [--dry-run]  自进化提案（**只写 proposals/**）
  dsh-rulekeeper report  --landing <dir> [--now <ISO>]         报告（账本摘要 + 自检 + 生效配置，可复现）
  dsh-rulekeeper migrate [--project <dir>] [--scope project|user] [--apply] [--remove-old]   落点迁移（老 .dsh-ai/lessonflow -> 新 .dsh-ai/rulekeeper；默认 dry-run）
  dsh-rulekeeper --help
退出码: 0 成功 / 2 用法错误 / 1 运行失败 / 5 该能力尚未实现（见 src/rc.mjs 契约表）`;

export const SUBCOMMANDS = Object.freeze(['init', 'check', 'snap', 'record', 'rules', 'evolve', 'report', 'gate', 'redact', 'migrate']);

export const USAGE_SELFCHECK = `用法: rk-selfcheck --root <dsh-rulekeeper 包根> [--project <项目根>] [--json]
退出码: 0 通过 / 1 有违规 / 2 用法错误`;

export const USAGE_MIGRATE = `用法: rk-migrate [--project <项目根>] [--scope project|user] [--landing <落点>] [--apply] [--remove-old] [--now <ISO>] [--json]
说明: R2 落点迁移 —— 老落点 \`.dsh-ai/lessonflow\` -> 新落点 \`.dsh-ai/rulekeeper\`。
      · 默认 **dry-run**（只报告将复制什么）；\`--apply\` 才落盘
      · 迁移=复制 + **四项核对**（文件数 / 总字节 / 树 sha256 / 账本行数 + 门禁台账行数）后才算通过
      · **默认保留旧落点**；\`--remove-old\`（须与 --apply 同用）才删旧。核对不通过**一个字节都不删**
      · 兼容窗口：不迁移也能继续用（解析器优先新落点、老落点存在则沿用）
退出码: 0 成功（含 dry-run 与"无需迁移"）/ 1 核对失败或拒绝覆盖 / 2 用法错误`;

export const USAGE_ENV = `用法: rk-env [--project <dir>] [--now <ISO>] [--json]
退出码: 0 成功 / 2 用法错误 / 1 运行失败
说明: 固定 --now 后同机两次运行输出逐字相同；用于跨平台判据（LF-2D0）与自查`;

export const USAGE_BACKUP = `用法:
  rk-backup create  --file <src> --landing <落点目录> [--now <ISO>]
  rk-backup restore --file <src> --backup <备份文件> [--expect-sha <hex>]
  rk-backup list    --landing <落点目录> [--file <原文件名>]      （LF-190）
  rk-backup export  --landing <落点目录> --out <导出件.json> [--now <ISO>] [--json]
  rk-backup rebuild --file <导出件.json> --landing <落点目录> [--force] [--json]
退出码: 0 成功 / 1 备份或恢复失败（含 sha 不符）/ 2 用法错误 / 4 备份缺失（NO_BACKUP，禁静默成功）
export/rebuild = **数据保全**（LF-810）：export 把落点**全部文件**导成一个 JSON；
  rebuild **两阶段**：先全量校验（路径安全 + 载荷 sha256 + 自报条数交叉核对），全过才落盘并回读校验
  —— 任一不过 ⇒ exit≠0 且**一个字节都不写**（坏件不许留残渣）。
  落点已有**任何**文件（不只账本）且未给 --force → 拒绝（exit≠0）；
  --out 落在落点内部 → 拒绝（exit=2，防自我包含）`;

export const USAGE_DOCTOR = `用法: rk-doctor --landing <落点目录> [--project <项目根>] [--strict] [--json]
退出码: 0 无 error 级问题 / 1 有 error 级问题（--strict 时 warn 也算）/ 2 用法错误`;

export const USAGE_SHELL_REVERT = `用法:
  rk-shell-revert snapshot --landing <落点> --shell <壳名> --entry <入口脚本> [--now <ISO>] [--json]
  rk-shell-revert verify   --landing <落点> --shell <壳名> --entry <入口脚本> [--json]
  rk-shell-revert restore  --landing <落点> --shell <壳名> --target <还原到哪个路径> [--json]
  rk-shell-revert drop     --landing <落点> --shell <壳名> --since <ISO> --now <ISO> [--min-days n] [--runbook <文件>] [--json]
说明: LF-830 降壳可反转 + 退役门槛。
      snapshot = **降壳前**保留可反转副本（回读校验 sha256）+ 抓 **10 条固定 fixture** 的三面基线
      （stdout sha256 / exit / stderr 归一后）；verify = 逐 fixture 三面比对（任一面不符点名报出）；
      restore = 先校验副本指纹再还原（副本被动过一律拒绝，且不覆盖目标）；
      drop = **删壳的唯一一条路**，内部先过退役门槛（门槛文本 + 连续 N 天 + 零回退/事故），
      不过则拒绝（exit≠0）且**可反转副本原封不动**。
      入口解释器按扩展名选：.mjs/.js → node，.ps1 → pwsh -NoProfile -File，.sh → sh，其它直接执行（缺解释器如实报错）。
退出码: 0 通过（快照成功 / 三面全等 / 还原成功 / 允许退役）/ 1 行为不等·无法还原·拒绝退役 / 2 用法错误`;

export const USAGE_STOP_LOSS = `用法:
  rk-stop-loss status  --landing <落点> [--metrics <指标.json>] [--json]
  rk-stop-loss apply   --landing <落点> [--json]
  rk-stop-loss runbook [--write-md] [--check] [--json]
  rk-stop-loss verify  [--workdir <临时目录>] [--json]
  rk-stop-loss retire  --landing <落点> --shell <壳名> --since <ISO> --now <ISO> [--min-days n] [--runbook <文件>] [--json]
说明: LF-820 Go/No-Go 止损点 + Runbook。阈值冻结在 src/stoploss.mjs 的 STOP_LOSS_LIMITS；
      status 判 go/no-go/unknown（**缺指标 = unknown = 先止血**，fail-closed）；
      apply 把档位写成 observe（只改 mode、回读校验）；runbook 生成/校验包内 RUNBOOK.md（手改即漂移）；
      verify 在临时目录里**逐类注入故障 → 先证"真的坏了" → 按 Runbook 复位 → 证回基线**（复位不出即红）；
      retire = LF-830 退役门槛（连续 N 天零回退/零事故才允许删壳；门槛文档缺失或天数不足 → 拒绝）。
退出码: 0 通过（go / 已止血 / 文档一致 / 全部复位 / 允许退役）/ 1 需止损·未复位·拒绝退役 / 2 用法错误`;

export const USAGE_LEDGER = `用法:
  rk-ledger import  --legacy <旧账本 lessons.json> --landing <落点> [--now <ISO>] [--dry-run]
  rk-ledger query   --landing <落点> [--id <id>] [--rule <rule>] [--json]
  rk-ledger summary --landing <落点> [--json]
  rk-ledger dedupe  --landing <落点> [--json]
  rk-ledger families --landing <落点> --expect <RULE>=<id,id,...>   （校验同族条目归同 rule）
退出码: 0 成功 / 1 失败（导入写入失败 / families 不符） / 2 用法错误`;

export const USAGE_RULES = `用法:
  rk-rules check        --rules <rules.json> [--project <项目根>]
  rk-rules is-protected --rules <rules.json> --path <路径> [--project <项目根>] [--json]
  rk-rules consistency  --rules <rules.json> --paths <p1,p2,...> [--project <项目根>]
  rk-rules effective    --landing <落点> [--rules <rules.json>] [--project <项目根>]
退出码: 0 通过 / 1 校验失败或四点判定不一致 / 2 用法错误`;

/** 极简 flag 解析（只认白名单；未知参数一律 UsageError → rc 2） */
function scanFlags(argv, spec) {
  const values = {};
  const rest = [...argv];
  while (rest.length > 0) {
    const flag = rest.shift();
    if (flag === '--help' || flag === '-h') {
      values.help = true;
      continue;
    }
    const kind = spec[flag];
    if (kind === undefined) throw new UsageError(`未知参数: ${flag}`);
    if (kind === 'boolean') {
      values[flag.slice(2)] = true;
      continue;
    }
    const value = rest.shift();
    if (value === undefined) throw new UsageError(`${flag} 需要一个值`);
    if (kind === 'string[]') {
      // 可重复 flag（`--file a --file b`）：LF-530/LF-500 要按"一批文件"对账
      const key = flag.slice(2);
      if (!Array.isArray(values[key])) values[key] = [];
      values[key].push(value);
      continue;
    }
    values[flag.slice(2)] = value;
  }
  return values;
}

/** `dsh-rulekeeper init|--help` */
export function runRulekeeper(argv, io = defaultIo(), env = process.env) {
  const command = argv[0] ?? null;
  if (command === '--help' || command === '-h' || command === null) {
    io.out(`${USAGE_RULEKEEPER}\n`);
    return command === null ? RC.USAGE : RC.OK;
  }
  if (command !== 'init') {
    if (SUBCOMMANDS.includes(command)) return runRulekeeperSub(command, argv.slice(1), io, env);
    io.err(`dsh-rulekeeper: 未知子命令 "${command}"\n${USAGE_RULEKEEPER}\n`);
    return RC.USAGE;
  }
  // init --help 必须只打印用法，**不得真的建落点**（2026-09-14 实测：初版漏判 -> 在包目录里建了 .dsh-ai/）
  if (argv.slice(1).includes('--help') || argv.slice(1).includes('-h')) {
    io.out(`${SUB_USAGE.init}\n`);
    return RC.OK;
  }
  let flags;
  try {
    flags = scanFlags(argv.slice(1), { '--project': 'string' });
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`dsh-rulekeeper: ${err.message}\n${USAGE_RULEKEEPER}\n`);
      return RC.USAGE;
    }
    throw err;
  }
  const project = resolve(flags.project ?? process.cwd());
  if (!existsSync(project) || !statSync(project).isDirectory()) {
    io.err(`dsh-rulekeeper: --project 不是已存在目录: ${project}\n`);
    return RC.USAGE;
  }
  try {
    const { dirs, created, kept } = ensureLanding({ projectRoot: project, env });
    io.out(line(`RK_INIT_PROJECT=${dirs.project}`));
    io.out(line(`RK_INIT_USER=${dirs.user}`));
    io.out(line(`RK_INIT_CREATED=${created.length}`));
    io.out(line(`RK_INIT_KEPT=${kept.length}`));
    for (const file of created) io.out(line(`CREATED ${file}`));
    for (const file of kept) io.out(line(`KEPT ${file}`));
    io.out('RK_INIT_RESULT=pass\n');
    return RC.OK;
  } catch (err) {
    io.err(`dsh-rulekeeper: init 失败: ${err.message}\n`);
    return RC.FAIL;
  }
}

/** `rk-selfcheck --root <dir> [--project <dir>] [--json]` */
export function runSelfcheck(argv, io = defaultIo(), env = process.env) {
  let flags;
  try {
    flags = scanFlags(argv, { '--root': 'string', '--project': 'string', '--json': 'boolean' });
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`rk-selfcheck: ${err.message}\n${USAGE_SELFCHECK}\n`);
      return RC.USAGE;
    }
    throw err;
  }
  if (flags.help) {
    io.out(`${USAGE_SELFCHECK}\n`);
    return RC.OK;
  }
  if (flags.root === undefined) {
    io.err(`rk-selfcheck: 必须提供 --root <dsh-rulekeeper 包根>\n${USAGE_SELFCHECK}\n`);
    return RC.USAGE;
  }
  const root = resolve(flags.root);
  const project = resolve(flags.project ?? process.cwd());
  if (!existsSync(root)) {
    io.err(`rk-selfcheck: --root 不存在: ${root}\n`);
    return RC.USAGE;
  }
  const report = checkSkeleton(root, { projectRoot: project, env });
  if (flags.json) {
    io.out(jsonStable(report));
  } else {
    io.out(line(`RK_SELFCHECK_ROOT=${root}`));
    io.out(line(`RK_SELFCHECK_PROJECT=${project}`));
    io.out(line(`RK_SELFCHECK_LANDING_PROJECT=${report.dirs.project}`));
    io.out(line(`RK_SELFCHECK_LANDING_USER=${report.dirs.user}`));
    for (const f of report.findings) io.out(line(`FINDING ${f.code} ${f.msg}`));
    io.out(line(`RK_SELFCHECK_FINDINGS=${report.findings.length}`));
  }
  io.out(resultLine('SELFCHECK', report.ok));
  return report.ok ? RC.OK : RC.FAIL;
}

/** `rk-env [--project <dir>] [--now <ISO>] [--json]` */
export function runEnv(argv, io = defaultIo(), env = process.env) {
  let flags;
  let now;
  try {
    flags = scanFlags(argv, { '--project': 'string', '--now': 'string', '--json': 'boolean' });
    if (flags.help) {
      io.out(`${USAGE_ENV}\n`);
      return RC.OK;
    }
    now = resolveNow({ argv, env });
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`rk-env: ${err.message}\n${USAGE_ENV}\n`);
      return RC.USAGE;
    }
    io.err(`rk-env: 运行失败: ${err.message}\n`);
    return RC.FAIL;
  }
  try {
    const project = resolve(flags.project ?? process.cwd());
    const payload = {
      now: now.iso,
      fixed: now.fixed,
      stamp: stamp(now.date),
      node: process.version,
      platform: process.platform,
      eol: JSON.stringify(process.platform === 'win32' ? '\r\n' : '\n'),
      sep: process.platform === 'win32' ? '\\' : '/',
      projectPosix: toPosix(project),
      projectKey: pathKey(project),
      dshHomePosix: toPosix(dshHome(env)),
      sorted: sortCodePoints(['b', 'A', 'z', 'ä']),
    };
    io.out(line(`RK_ENV_NOW=${payload.now}`));
    io.out(line(`RK_ENV_FIXED=${payload.fixed}`));
    io.out(line(`RK_ENV_STAMP=${payload.stamp}`));
    io.out(line(`RK_ENV_PLATFORM=${payload.platform}`));
    io.out(line(`RK_ENV_PROJECT_POSIX=${payload.projectPosix}`));
    io.out(line(`RK_ENV_PROJECT_KEY=${payload.projectKey}`));
    io.out(line(`RK_ENV_DSHHOME_POSIX=${payload.dshHomePosix}`));
    io.out(line(`RK_ENV_SORTED=${payload.sorted.join(',')}`));
    if (flags.json) io.out(jsonStable(payload));
    io.out(resultLine('ENV', true));
    return RC.OK;
  } catch (err) {
    io.err(`rk-env: 运行失败: ${err.message}\n`);
    return RC.FAIL;
  }
}

/** `rk-backup create|restore|list|export|rebuild …`（LF-190 备份 / LF-810 数据保全） */
export function runBackup(argv, io = defaultIo(), env = process.env) {
  const command = argv[0] ?? null;
  if (command === '--help' || command === '-h' || command === null) {
    io.out(`${USAGE_BACKUP}\n`);
    return command === null ? RC.USAGE : RC.OK;
  }
  if (!['create', 'restore', 'list', 'export', 'rebuild'].includes(command)) {
    io.err(`rk-backup: 未知子命令 "${command}"\n${USAGE_BACKUP}\n`);
    return RC.USAGE;
  }
  let flags;
  try {
    flags = scanFlags(argv.slice(1), {
      '--file': 'string', '--landing': 'string', '--backup': 'string', '--out': 'string',
      '--expect-sha': 'string', '--now': 'string', '--json': 'boolean', '--force': 'boolean',
    });
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`rk-backup: ${err.message}\n${USAGE_BACKUP}\n`);
      return RC.USAGE;
    }
    throw err;
  }
  if (command === 'create' && (flags.file === undefined || flags.landing === undefined)) {
    io.err('rk-backup: create 需要 --file <src> 与 --landing <落点目录>\n');
    return RC.USAGE;
  }
  if (command === 'restore' && (flags.file === undefined || flags.backup === undefined)) {
    io.err('rk-backup: restore 需要 --file <src> 与 --backup <备份文件>\n');
    return RC.USAGE;
  }
  if (command === 'list' && flags.landing === undefined) {
    io.err('rk-backup: list 需要 --landing <落点目录>\n');
    return RC.USAGE;
  }
  if (command === 'export' && (flags.landing === undefined || flags.out === undefined)) {
    io.err(`rk-backup: export 需要 --landing <落点目录> 与 --out <导出件.json>\n${USAGE_BACKUP}\n`);
    return RC.USAGE;
  }
  if (command === 'rebuild' && (flags.file === undefined || flags.landing === undefined)) {
    io.err(`rk-backup: rebuild 需要 --file <导出件.json> 与 --landing <落点目录>\n${USAGE_BACKUP}\n`);
    return RC.USAGE;
  }

  if (command === 'export') {
    const landing = resolve(flags.landing);
    const out = resolve(flags.out);
    if (isInside(landing, out)) {
      // 自我包含会让"导出件"在下次导出时把自己也导进去（且长度每次都在变）——直接拒绝
      io.err(`rk-backup: export 的 --out 不能落在落点内部（防自我包含）: ${out}\n`);
      return RC.USAGE;
    }
    let now;
    try {
      now = resolveNow({ argv, env }).date;
    } catch (err) {
      if (err instanceof UsageError) {
        io.err(`rk-backup: ${err.message}\n`);
        return RC.USAGE;
      }
      throw err;
    }
    const r = exportLanding({ landingDir: landing, now });
    if (!r.ok) {
      io.err(`rk-backup: 导出失败: ${r.reason}\n`);
      return RC.FAIL;
    }
    const w = writeBundle(out, r.bundle);
    if (!w.ok) {
      io.err(`rk-backup: 导出件落盘失败: ${w.reason}\n`);
      return RC.FAIL;
    }
    if (flags.json === true) {
      io.out(jsonStable({ ok: true, out: toPosix(out), bytes: w.bytes, sha256: w.sha256, counts: r.bundle.counts }));
      return RC.OK;
    }
    io.out(line(`RK_EXPORT_PATH=${toPosix(out)}`));
    io.out(line(`RK_EXPORT_SHA256=${w.sha256}`));
    io.out(line(`RK_EXPORT_BYTES=${w.bytes}`));
    io.out(line(`RK_EXPORT_FILES=${r.bundle.counts.files}`));
    io.out(line(`RK_EXPORT_LEDGER_ENTRIES=${r.bundle.counts.ledgerEntries}`));
    io.out(line(`RK_EXPORT_GATE_ROWS=${r.bundle.counts.gateRows}`));
    io.out('RK_EXPORT_RESULT=pass\n');
    return RC.OK;
  }

  if (command === 'rebuild') {
    const r = rebuildLanding({ file: resolve(flags.file), landingDir: resolve(flags.landing), force: flags.force === true });
    if (!r.ok) {
      io.err(`rk-backup: 重建失败（${r.code}）: ${r.reason}\n`);
      return RC.FAIL;
    }
    if (flags.json === true) {
      io.out(jsonStable({ ok: true, files: r.files, verified: r.verified, counts: r.counts, countsMatch: true }));
      return RC.OK;
    }
    io.out(line(`RK_REBUILD_FILES=${r.files}`));
    io.out(line(`RK_REBUILD_VERIFIED=${r.verified}`));
    io.out(line(`RK_REBUILD_LEDGER_ENTRIES=${r.counts.ledgerEntries}`));
    io.out(line(`RK_REBUILD_GATE_ROWS=${r.counts.gateRows}`));
    io.out(line(`RK_REBUILD_COUNTS_MATCH=true`));
    io.out('RK_REBUILD_RESULT=pass\n');
    return RC.OK;
  }

  if (command === 'create') {
    let now;
    try {
      now = resolveNow({ argv, env }).date;
    } catch (err) {
      if (err instanceof UsageError) {
        io.err(`rk-backup: ${err.message}\n`);
        return RC.USAGE;
      }
      throw err;
    }
    const result = backupFile(resolve(flags.file), { landingDir: resolve(flags.landing), now });
    if (!result.ok) {
      io.err(`rk-backup: 备份失败: ${result.reason}\n`);
      return RC.FAIL;
    }
    io.out(line(`RK_BACKUP_PATH=${result.path}`));
    io.out(line(`RK_BACKUP_SHA256=${result.sha256}`));
    io.out(line(`RK_BACKUP_BYTES=${result.bytes}`));
    io.out('RK_BACKUP_RESULT=pass\n');
    return RC.OK;
  }

  if (command === 'restore') {
    const result = restoreFile({
      src: resolve(flags.file),
      backup: resolve(flags.backup),
      expectSha: flags['expect-sha'] ?? null,
    });
    if (!result.ok) {
      io.err(`rk-backup: 恢复失败（${result.code}）: ${result.reason}\n`);
      return result.code === 'NO_BACKUP' ? RC.NO_BACKUP : RC.FAIL;
    }
    io.out(line(`RK_RESTORE_SHA256=${result.sha256}`));
    io.out('RK_RESTORE_RESULT=pass\n');
    return RC.OK;
  }

  const list = listBackups(resolve(flags.landing), flags.file === undefined ? null : basename(resolve(flags.file)));
  if (flags.json === true) {
    io.out(jsonStable({ landing: resolve(flags.landing), count: list.length, backups: list }));
  } else {
    io.out(line(`RK_BACKUP_COUNT=${list.length}`));
    for (const b of list) io.out(line(`BACKUP ${b.name} ${b.bytes} ${b.sha256}`));
  }
  io.out('RK_BACKUP_RESULT=pass\n');
  return RC.OK;
}

/** `rk-doctor --landing <落点> [--project <root>] [--strict] [--json]`（LF-180） */
export function runDoctor(argv, io = defaultIo(), env = process.env) {
  let flags;
  try {
    flags = scanFlags(argv, { '--landing': 'string', '--project': 'string', '--strict': 'boolean', '--json': 'boolean' });
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`rk-doctor: ${err.message}\n${USAGE_DOCTOR}\n`);
      return RC.USAGE;
    }
    throw err;
  }
  if (flags.help) {
    io.out(`${USAGE_DOCTOR}\n`);
    return RC.OK;
  }
  if (flags.landing === undefined) {
    io.err(`rk-doctor: 需要 --landing <落点目录>\n${USAGE_DOCTOR}\n`);
    return RC.USAGE;
  }
  const landingDir = resolve(flags.landing);
  if (!existsSync(landingDir) || !statSync(landingDir).isDirectory()) {
    io.err(`rk-doctor: --landing 不是已存在目录: ${landingDir}\n`);
    return RC.USAGE;
  }
  const report = doctor({ landingDir, projectRoot: resolve(flags.project ?? process.cwd()) });
  const strict = flags.strict === true;
  if (flags.json === true) {
    io.out(jsonStable(report));
  } else {
    io.out(line(`RK_DOCTOR_LANDING=${landingDir}`));
    for (const f of report.findings) io.out(line(`FINDING ${f.level.toUpperCase()} ${f.code} ${f.msg}`));
    io.out(line(`RK_DOCTOR_ERRORS=${report.findings.filter((f) => f.level === 'error').length}`));
    io.out(line(`RK_DOCTOR_WARNS=${report.findings.filter((f) => f.level === 'warn').length}`));
    io.out(line(`RK_DOCTOR_INFOS=${report.findings.filter((f) => f.level === 'info').length}`));
    io.out(line(`RK_DOCTOR_NON_PATH_EVIDENCE=${report.summary.nonPathEvidence}`));
    io.out(line(`RK_DOCTOR_LEDGER_ENTRIES=${report.summary.entries}`));
  }
  const rc = doctorExitCode(report, strict);
  io.out(resultLine('DOCTOR', rc === 0));
  return rc === 0 ? RC.OK : RC.FAIL;
}

/**
 * `rk-snap --path` 的目标路径解析（**唯一入口**）。
 *
 * 判据（LF-820 止损 Runbook 实测抓到，2026-09-15）：给了 `--project` 时，**相对**路径必须相对项目根解析
 * —— 按 CWD 解析会让"给项目里的受保护文件留证"变成"给当时工作目录里同名文件留证"，
 * 于是受保护文件依旧未留证、Runbook 的复位动作**做不到**（假绿）。
 * 绝对路径照给（显式绝对路径就是要那个文件）。
 */
function snapTargetPath(rawPath, projectRoot) {
  return isAbsolute(rawPath) ? resolve(rawPath) : resolve(projectRoot, rawPath);
}

/** `rk-shell-revert snapshot|verify|restore|drop`（LF-830） */
export function runShellRevert(argv, io = defaultIo(), env = process.env) {
  const command = argv[0] ?? null;
  if (command === '--help' || command === '-h' || command === null) {
    io.out(`${USAGE_SHELL_REVERT}\n`);
    return command === null ? RC.USAGE : RC.OK;
  }
  if (!['snapshot', 'verify', 'restore', 'drop'].includes(command)) {
    io.err(`rk-shell-revert: 未知子命令 "${command}"\n${USAGE_SHELL_REVERT}\n`);
    return RC.USAGE;
  }
  let flags;
  try {
    flags = scanFlags(argv.slice(1), {
      '--landing': 'string', '--shell': 'string', '--entry': 'string', '--target': 'string',
      '--since': 'string', '--now': 'string', '--min-days': 'string', '--runbook': 'string',
      '--json': 'boolean', '--help': 'boolean',
    });
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`rk-shell-revert: ${err.message}\n${USAGE_SHELL_REVERT}\n`);
      return RC.USAGE;
    }
    throw err;
  }
  if (flags.help === true) {
    io.out(`${USAGE_SHELL_REVERT}\n`);
    return RC.OK;
  }
  if (flags.landing === undefined || flags.shell === undefined) {
    io.err(`rk-shell-revert: 需要 --landing <落点> 与 --shell <壳名>\n${USAGE_SHELL_REVERT}\n`);
    return RC.USAGE;
  }
  const landing = resolve(flags.landing);
  const shell = flags.shell;

  if (command === 'snapshot') {
    if (flags.entry === undefined) {
      io.err(`rk-shell-revert: snapshot 需要 --entry <入口脚本>\n${USAGE_SHELL_REVERT}\n`);
      return RC.USAGE;
    }
    let now = new Date();
    if (flags.now !== undefined) {
      now = new Date(flags.now);
      if (Number.isNaN(now.getTime())) {
        io.err(`rk-shell-revert: --now 不是合法时间: ${flags.now}\n`);
        return RC.USAGE;
      }
    }
    const r = snapshotShell({ landing, shell, entry: resolve(flags.entry), now });
    if (flags.json === true) {
      io.out(jsonStable({ ok: r.ok, reason: r.reason, copy: r.copy === null ? null : toPosix(r.copy), copySha256: r.copySha256, sourceSha256: r.sourceSha256, fixtures: r.fixtures }));
      return r.ok ? RC.OK : RC.FAIL;
    }
    io.out(line(`RK_SHELL_REVERT_ACTION=snapshot`));
    io.out(line(`RK_SHELL_REVERT_SHELL=${shell}`));
    io.out(line(`RK_SHELL_REVERT_COPY=${r.copy === null ? '(none)' : toPosix(r.copy)}`));
    io.out(line(`RK_SHELL_REVERT_SOURCE_SHA256=${(r.sourceSha256 ?? '(none)').slice(0, 16)}`));
    io.out(line(`RK_SHELL_REVERT_COPY_SHA256=${(r.copySha256 ?? '(none)').slice(0, 16)}`));
    io.out(line(`RK_SHELL_REVERT_FIXTURES=${r.fixtures}`));
    if (r.ok !== true) io.out(line(`FINDING SHELL_REVERT_SNAPSHOT ${r.reason}`));
    io.out(resultLine('SHELL_REVERT_SNAPSHOT', r.ok));
    return r.ok ? RC.OK : RC.FAIL;
  }

  if (command === 'verify') {
    if (flags.entry === undefined) {
      io.err(`rk-shell-revert: verify 需要 --entry <入口脚本>\n${USAGE_SHELL_REVERT}\n`);
      return RC.USAGE;
    }
    const v = verifyShell({ landing, shell, entry: resolve(flags.entry) });
    if (flags.json === true) {
      io.out(jsonStable({ ok: v.ok, reason: v.reason, checked: v.checked, matched: v.matched, mismatches: v.mismatches, rows: v.rows }));
      return v.ok ? RC.OK : RC.FAIL;
    }
    io.out(line(`RK_SHELL_REVERT_ACTION=verify`));
    io.out(line(`RK_SHELL_REVERT_SHELL=${shell}`));
    io.out(line(`RK_SHELL_REVERT_CHECKED=${v.checked}`));
    io.out(line(`RK_SHELL_REVERT_MATCHED=${v.matched}`));
    io.out(line(`RK_SHELL_REVERT_MISMATCHES=${v.mismatches.length}`));
    for (const row of v.rows) {
      io.out(line(`SHELL_FIXTURE ${row.id} stdout=${row.stdoutSame} exit=${row.exitSame} stderr=${row.stderrSame}`));
    }
    for (const m of v.mismatches) {
      io.out(line(`FINDING SHELL_REVERT_BEHAVIOR_DIFF ${m.id} face=${m.face} expected=${String(m.expected).slice(0, 32)} actual=${String(m.actual).slice(0, 32)}`));
    }
    if (v.reason !== null) io.out(line(`FINDING SHELL_REVERT_VERIFY ${v.reason}`));
    io.out(resultLine('SHELL_REVERT_VERIFY', v.ok));
    return v.ok ? RC.OK : RC.FAIL;
  }

  if (command === 'restore') {
    if (flags.target === undefined) {
      io.err(`rk-shell-revert: restore 需要 --target <还原到哪个路径>\n${USAGE_SHELL_REVERT}\n`);
      return RC.USAGE;
    }
    const r = restoreShell({ landing, shell, target: resolve(flags.target) });
    if (flags.json === true) {
      io.out(jsonStable({ ok: r.ok, reason: r.reason, sha256: r.sha256, expectedSha256: r.expectedSha256 }));
      return r.ok ? RC.OK : RC.FAIL;
    }
    io.out(line(`RK_SHELL_REVERT_ACTION=restore`));
    io.out(line(`RK_SHELL_REVERT_SHELL=${shell}`));
    io.out(line(`RK_SHELL_REVERT_RESTORED_SHA256=${(r.sha256 ?? '(none)').slice(0, 16)}`));
    io.out(line(`RK_SHELL_REVERT_EXPECTED_SHA256=${(r.expectedSha256 ?? '(none)').slice(0, 16)}`));
    if (r.ok !== true) io.out(line(`FINDING SHELL_REVERT_RESTORE ${r.reason}`));
    io.out(resultLine('SHELL_REVERT_RESTORE', r.ok));
    return r.ok ? RC.OK : RC.FAIL;
  }

  // drop：删壳的唯一一条路（先过退役门槛）
  if (flags.since === undefined || flags.now === undefined) {
    io.err(`rk-shell-revert: drop 需要 --since <ISO> 与 --now <ISO>（时间不许靠猜）\n${USAGE_SHELL_REVERT}\n`);
    return RC.USAGE;
  }
  const minDays = flags['min-days'] === undefined ? undefined : Number(flags['min-days']);
  if (minDays !== undefined && Number.isFinite(minDays) !== true) {
    io.err(`rk-shell-revert: --min-days 不是数字: ${flags['min-days']}\n`);
    return RC.USAGE;
  }
  const d = dropShell({
    landing, shell, since: flags.since, now: flags.now,
    ...(minDays === undefined ? {} : { minDays }),
    ...(flags.runbook === undefined ? {} : { runbookFile: resolve(flags.runbook) }),
  });
  if (flags.json === true) {
    io.out(jsonStable({ ok: d.ok, removed: d.removed, reasons: d.reasons, days: d.days ?? null, rollbacks: d.rollbacks ?? null }));
    return d.ok ? RC.OK : RC.FAIL;
  }
  io.out(line(`RK_SHELL_REVERT_ACTION=drop`));
  io.out(line(`RK_SHELL_REVERT_SHELL=${shell}`));
  io.out(line(`RK_SHELL_REVERT_DROP_ALLOWED=${d.ok}`));
  io.out(line(`RK_SHELL_REVERT_DROP_REMOVED=${d.removed === true}`));
  io.out(line(`RK_SHELL_REVERT_RETIRE_DAYS=${d.days ?? '(none)'}`));
  io.out(line(`RK_SHELL_REVERT_RETIRE_ROLLBACKS=${d.rollbacks ?? '(none)'}`));
  for (const why of d.reasons) io.out(line(`FINDING SHELL_REVERT_DROP_REFUSED ${why}`));
  io.out(resultLine('SHELL_REVERT_DROP', d.ok));
  return d.ok ? RC.OK : RC.FAIL;
}

/** `rk-stop-loss status|apply|runbook|verify|retire`（LF-820 / LF-830 退役门槛） */
export function runStopLoss(argv, io = defaultIo(), env = process.env) {
  const command = argv[0] ?? null;
  if (command === '--help' || command === '-h' || command === null) {
    io.out(`${USAGE_STOP_LOSS}\n`);
    return command === null ? RC.USAGE : RC.OK;
  }
  if (!['status', 'apply', 'runbook', 'verify', 'retire'].includes(command)) {
    io.err(`rk-stop-loss: 未知子命令 "${command}"\n${USAGE_STOP_LOSS}\n`);
    return RC.USAGE;
  }
  let flags;
  try {
    flags = scanFlags(argv.slice(1), {
      '--landing': 'string', '--metrics': 'string', '--workdir': 'string', '--runbook': 'string',
      '--shell': 'string', '--since': 'string', '--now': 'string', '--min-days': 'string',
      '--write-md': 'boolean', '--check': 'boolean', '--json': 'boolean', '--help': 'boolean',
    });
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`rk-stop-loss: ${err.message}\n${USAGE_STOP_LOSS}\n`);
      return RC.USAGE;
    }
    throw err;
  }
  if (flags.help === true) {
    io.out(`${USAGE_STOP_LOSS}\n`);
    return RC.OK;
  }

  if (command === 'runbook') {
    if (flags['write-md'] === true) {
      const w = writeRunbook({});
      if (!w.ok) {
        io.err(`rk-stop-loss: 写 RUNBOOK.md 失败: ${w.reason}\n`);
        return RC.FAIL;
      }
      io.out(line(`RK_STOP_LOSS_RUNBOOK_PATH=${toPosix(w.file)}`));
      io.out(line(`RK_STOP_LOSS_RUNBOOK_BYTES=${w.bytes}`));
      io.out(line('RK_STOP_LOSS_RUNBOOK_DRIFT=false'));
      io.out('RK_STOP_LOSS_RUNBOOK_RESULT=pass\n');
      return RC.OK;
    }
    const c = checkRunbook({});
    if (flags.json === true) {
      io.out(jsonStable({ ok: c.ok, drift: c.drift, file: toPosix(c.file), reason: c.reason, steps: RUNBOOK_STEPS.length }));
      return c.ok ? RC.OK : RC.FAIL;
    }
    io.out(line(`RK_STOP_LOSS_RUNBOOK_PATH=${toPosix(c.file)}`));
    io.out(line(`RK_STOP_LOSS_RUNBOOK_STEPS=${RUNBOOK_STEPS.length}`));
    io.out(line(`RK_STOP_LOSS_RUNBOOK_DRIFT=${c.drift === true}`));
    if (c.ok !== true) io.out(line(`FINDING STOP_LOSS_RUNBOOK ${c.reason}`));
    io.out(resultLine('STOP_LOSS_RUNBOOK', c.ok));
    return c.ok ? RC.OK : RC.FAIL;
  }

  if (command === 'verify') {
    const workdir = flags.workdir === undefined ? mkdtempSync(join(tmpdir(), 'rk-stop-loss-')) : resolve(flags.workdir);
    const v = verifyRunbook({ workdir });
    if (flags.json === true) {
      io.out(jsonStable({ ok: v.ok, workdir: toPosix(workdir), failed: v.failed, steps: v.steps }));
      return v.ok ? RC.OK : RC.FAIL;
    }
    io.out(line(`RK_STOP_LOSS_VERIFY_WORKDIR=${toPosix(workdir)}`));
    io.out(line(`RK_STOP_LOSS_VERIFY_FAULTS=${v.steps.length}`));
    for (const s of v.steps) {
      io.out(line(`RK_STOP_LOSS_STEP ${s.id} fault=${s.fault} broken_detected=${s.brokenDetected} restored=${s.restored} exit=${s.exit}`));
      io.out(line(`STOP_LOSS_CMD ${s.id} ${s.cmd}`));
      if (s.restored !== true) io.out(line(`FINDING STOP_LOSS_NOT_RESTORED ${s.id} ${s.note}`));
    }
    io.out(line(`RK_STOP_LOSS_VERIFY_RESTORED=${v.steps.filter((s) => s.restored === true).length}`));
    io.out(resultLine('STOP_LOSS_VERIFY', v.ok));
    return v.ok ? RC.OK : RC.FAIL;
  }

  if (command === 'apply') {
    if (flags.landing === undefined) {
      io.err(`rk-stop-loss: apply 需要 --landing <落点>\n${USAGE_STOP_LOSS}\n`);
      return RC.USAGE;
    }
    const landing = resolve(flags.landing);
    const a = applyStopLoss({ landing });
    if (flags.json === true) {
      io.out(jsonStable({ ok: a.ok, landing: toPosix(landing), before: a.before, after: a.after, reason: a.reason }));
      return a.ok ? RC.OK : RC.FAIL;
    }
    io.out(line(`RK_STOP_LOSS_MODE_BEFORE=${a.before ?? '(none)'}`));
    io.out(line(`RK_STOP_LOSS_MODE_AFTER=${a.after ?? '(none)'}`));
    if (a.ok !== true) io.out(line(`FINDING STOP_LOSS_APPLY ${a.reason}`));
    io.out(resultLine('STOP_LOSS_APPLY', a.ok));
    return a.ok ? RC.OK : RC.FAIL;
  }

  if (command === 'retire') {
    if (flags.landing === undefined || flags.shell === undefined || flags.since === undefined || flags.now === undefined) {
      io.err(`rk-stop-loss: retire 需要 --landing <落点> --shell <壳名> --since <ISO> --now <ISO>（时间不许靠猜）\n${USAGE_STOP_LOSS}\n`);
      return RC.USAGE;
    }
    const minDays = flags['min-days'] === undefined ? undefined : Number(flags['min-days']);
    if (minDays !== undefined && Number.isFinite(minDays) !== true) {
      io.err(`rk-stop-loss: --min-days 不是数字: ${flags['min-days']}\n`);
      return RC.USAGE;
    }
    const r = retireGate({
      landing: resolve(flags.landing),
      shell: flags.shell,
      since: flags.since,
      now: flags.now,
      ...(minDays === undefined ? {} : { minDays }),
      ...(flags.runbook === undefined ? {} : { runbookFile: resolve(flags.runbook) }),
    });
    if (flags.json === true) {
      io.out(jsonStable({ ok: r.ok, days: r.days, minDays: r.row?.minDays ?? null, rollbacks: r.rollbacks, reasons: r.reasons, ledger: r.ledger === null ? null : toPosix(r.ledger) }));
      return r.ok ? RC.OK : RC.FAIL;
    }
    io.out(line(`RK_STOP_LOSS_RETIRE_SHELL=${flags.shell}`));
    io.out(line(`RK_STOP_LOSS_RETIRE_DAYS=${r.days ?? '(none)'}`));
    io.out(line(`RK_STOP_LOSS_RETIRE_MIN_DAYS=${r.row?.minDays ?? '(none)'}`));
    io.out(line(`RK_STOP_LOSS_RETIRE_ROLLBACKS=${r.rollbacks ?? '(none)'}`));
    io.out(line(`RK_STOP_LOSS_RETIRE_ALLOWED=${r.ok}`));
    for (const why of r.reasons) io.out(line(`FINDING STOP_LOSS_RETIRE_REFUSED ${why}`));
    io.out(resultLine('STOP_LOSS_RETIRE', r.ok));
    return r.ok ? RC.OK : RC.FAIL;
  }

  if (flags.landing === undefined) {
    io.err(`rk-stop-loss: status 需要 --landing <落点>\n${USAGE_STOP_LOSS}\n`);
    return RC.USAGE;
  }
  const landing = resolve(flags.landing);
  const metrics = readMetrics(flags.metrics === undefined ? undefined : resolve(flags.metrics));
  const verdict = evaluateStopLoss({ mode: readMode(landing), metrics });
  if (flags.json === true) {
    io.out(jsonStable({ landing: toPosix(landing), ...verdict }));
    return verdict.verdict === 'go' ? RC.OK : RC.FAIL;
  }
  io.out(line(`RK_STOP_LOSS_MODE=${verdict.mode}`));
  io.out(line(`RK_STOP_LOSS_VERDICT=${verdict.verdict}`));
  io.out(line(`RK_STOP_LOSS_TRIGGERS=${verdict.triggers.length}`));
  io.out(line(`RK_STOP_LOSS_MISSING=${verdict.missing.length}`));
  io.out(line(`RK_STOP_LOSS_ACTIONS=${verdict.actions.length === 0 ? '(none)' : verdict.actions.join(',')}`));
  for (const t of verdict.triggers) io.out(line(`STOP_LOSS_TRIGGER ${t.key} value=${t.value ?? '(none)'} limit=${t.limit} why=${t.why}`));
  io.out(resultLine('STOP_LOSS', verdict.verdict === 'go'));
  return verdict.verdict === 'go' ? RC.OK : RC.FAIL;
}

/** `rk-ledger import|query|summary|dedupe|families …`（LF-210 / LF-220） */
export function runLedger(argv, io = defaultIo(), env = process.env) {
  const command = argv[0] ?? null;
  if (command === '--help' || command === '-h' || command === null) {
    io.out(`${USAGE_LEDGER}\n`);
    return command === null ? RC.USAGE : RC.OK;
  }
  if (!['import', 'query', 'summary', 'dedupe', 'families'].includes(command)) {
    io.err(`rk-ledger: 未知子命令 "${command}"\n${USAGE_LEDGER}\n`);
    return RC.USAGE;
  }
  let flags;
  try {
    flags = scanFlags(argv.slice(1), {
      '--legacy': 'string', '--landing': 'string', '--id': 'string', '--rule': 'string',
      '--expect': 'string', '--now': 'string', '--dry-run': 'boolean', '--json': 'boolean',
    });
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`rk-ledger: ${err.message}\n${USAGE_LEDGER}\n`);
      return RC.USAGE;
    }
    throw err;
  }
  if (flags.help) {
    io.out(`${USAGE_LEDGER}\n`);
    return RC.OK;
  }
  if (flags.landing === undefined) {
    io.err(`rk-ledger: ${command} 需要 --landing <落点>\n`);
    return RC.USAGE;
  }
  const landing = resolve(flags.landing);
  if (!existsSync(landing) || !statSync(landing).isDirectory()) {
    io.err(`rk-ledger: --landing 不是已存在目录: ${landing}\n`);
    return RC.USAGE;
  }

  if (command === 'import') {
    if (flags.legacy === undefined) {
      io.err('rk-ledger: import 需要 --legacy <旧账本文件>\n');
      return RC.USAGE;
    }
    let now = new Date();
    if (flags.now !== undefined || (typeof env.RULEKEEPER_NOW === 'string' && env.RULEKEEPER_NOW !== '')) {
      try {
        now = resolveNow({ argv, env }).date;
      } catch (err) {
        if (err instanceof UsageError) {
          io.err(`rk-ledger: ${err.message}\n`);
          return RC.USAGE;
        }
        throw err;
      }
    }
    const report = importLedger({
      legacyFile: resolve(flags.legacy), landingDir: landing, now, dryRun: flags['dry-run'] === true,
    });
    if (report.error !== null) {
      io.err(`rk-ledger: 导入失败: ${report.error}\n`);
      return RC.FAIL;
    }
    if (flags.json === true) {
      io.out(jsonStable(report));
    } else {
      io.out(line(`RK_IMPORT_TOTAL=${report.total}`));
      io.out(line(`RK_IMPORT_IMPORTED=${report.imported}`));
      io.out(line(`RK_IMPORT_SKIPPED_EXISTING=${report.skippedExisting}`));
      io.out(line(`RK_IMPORT_SKIPPED_INVALID=${report.skippedInvalid}`));
      io.out(line(`RK_IMPORT_INVALID_IDS=${report.invalidIds.join(',') || '(none)'}`));
      io.out(line(`RK_IMPORT_FALLBACK=${report.fallbackCount}`));
      io.out(line(`RK_IMPORT_AMBIGUOUS=${report.ambiguous.length}`));
      io.out(line(`RK_IMPORT_STATUS_REMAPPED=${report.statusRemapped}`));
      io.out(line(`RK_IMPORT_DUPLICATE_IDS=${report.duplicateIds.join(',') || '(none)'}`));
      for (const f of report.findings) io.out(line(`FINDING ${f.level.toUpperCase()} ${f.code} ${f.msg}`));
      for (const row of report.ruleHistogram) io.out(line(`RULE ${row.rule} ${row.count}`));
      const read = readLedger(landing);
      const emptyRule = read.values.filter((e) => typeof e.rule !== 'string' || e.rule.trim() === '').length;
      io.out(line(`RK_IMPORT_EMPTY_RULE=${emptyRule}`));
    }
    io.out(resultLine('IMPORT', report.ok));
    return report.ok ? RC.OK : RC.FAIL;
  }

  if (command === 'query') {
    const read = readLedger(landing);
    const matches = queryLedger(read.values, {
      id: flags.id, rule: flags.rule === undefined ? undefined : canonicalRule(flags.rule),
    });
    if (flags.json === true) {
      io.out(jsonStable({ landing, matches: matches.length, entries: matches }));
    } else {
      io.out(line(`RK_QUERY_LANDING=${landing}`));
      io.out(line(`RK_QUERY_MATCHES=${matches.length}`));
      for (const entry of matches) io.out(line(`ENTRY ${JSON.stringify(entry)}`));
    }
    io.out(resultLine('QUERY', matches.length > 0));
    return matches.length > 0 ? RC.OK : RC.FAIL;
  }

  if (command === 'summary') {
    const s = ledgerSummary(landing);
    if (flags.json === true) {
      io.out(jsonStable(s));
    } else {
      io.out(line(`RK_LEDGER_ENTRIES=${s.entries}`));
      io.out(line(`RK_LEDGER_BAD_LINES=${s.badLines}`));
      io.out(line(`RK_LEDGER_TRUNCATED_TAIL=${s.truncatedTail}`));
      io.out(line(`RK_LEDGER_EMPTY_RULE=${readLedger(landing).values.filter((e) => typeof e.rule !== 'string' || e.rule.trim() === '').length}`));
      io.out(line(`RK_LEDGER_RULES=${s.rules.length}`));
      for (const row of s.rules) io.out(line(`RULE ${row.rule} ${row.count}`));
    }
    io.out(resultLine('LEDGER', true));
    return RC.OK;
  }

  if (command === 'dedupe') {
    const read = readLedger(landing);
    const result = dedupe(read.values);
    const divergent = detectRuleDivergence(read.values);
    const fragmented = ruleFragmentation(read.values);
    if (flags.json === true) {
      io.out(jsonStable({ landing, groups: result.groups.slice(0, 50), collapsed: result.collapsed, divergent, fragmented: fragmented.slice(0, 20) }));
    } else {
      io.out(line(`RK_DEDUPE_ENTRIES=${read.values.length}`));
      io.out(line(`RK_DEDUPE_GROUPS=${result.groups.length}`));
      io.out(line(`RK_DEDUPE_COLLAPSED=${result.collapsed}`));
      io.out(line(`RK_DEDUPE_DIVERGENT=${divergent.length}`));
      io.out(line(`RK_DEDUPE_FRAGMENTED_RULES=${fragmented.length}`));
      for (const g of result.groups.filter((x) => x.count > 1).slice(0, 20)) {
        io.out(line(`GROUP ${g.key} count=${g.count} ids=${g.ids.join(',')}`));
      }
      for (const d of divergent.slice(0, 10)) io.out(line(`DIVERGENT ${d.canonical} variants=${d.variants.join('|')}`));
    }
    io.out(resultLine('DEDUPE', true));
    return RC.OK;
  }

  // families：校验"同族条目必须归同 rule"（LF-210 的红态判据入口）
  if (flags.expect === undefined) {
    io.err('rk-ledger: families 需要 --expect <RULE>=<id,id,...>\n');
    return RC.USAGE;
  }
  const eq = flags.expect.indexOf('=');
  if (eq <= 0) {
    io.err('rk-ledger: --expect 格式应为 <RULE>=<id,id,...>\n');
    return RC.USAGE;
  }
  const wantRule = canonicalRule(flags.expect.slice(0, eq));
  const ids = flags.expect.slice(eq + 1).split(',').map((s) => s.trim()).filter((s) => s !== '');
  const entries = readLedger(landing).values;
  io.out(line(`RK_FAMILY_EXPECT=${wantRule}`));
  let bad = 0;
  for (const id of ids) {
    const found = entries.find((e) => e?.id === id);
    const actual = found === undefined ? '(缺失)' : String(found.rule ?? '');
    const ok = actual === wantRule;
    if (!ok) bad += 1;
    io.out(line(`FAMILY ${id} rule=${actual} expected=${wantRule} ${ok ? 'ok' : 'MISMATCH'}`));
  }
  io.out(line(`RK_FAMILY_MISMATCH=${bad}`));
  io.out(resultLine('FAMILY', bad === 0));
  return bad === 0 ? RC.OK : RC.FAIL;
}

/** `rk-rules check|is-protected|consistency|effective …`（LF-230） */
export function runRules(argv, io = defaultIo(), env = process.env) {
  const command = argv[0] ?? null;
  if (command === '--help' || command === '-h' || command === null) {
    io.out(`${USAGE_RULES}\n`);
    return command === null ? RC.USAGE : RC.OK;
  }
  if (!['check', 'is-protected', 'consistency', 'effective'].includes(command)) {
    io.err(`rk-rules: 未知子命令 "${command}"\n${USAGE_RULES}\n`);
    return RC.USAGE;
  }
  let flags;
  try {
    flags = scanFlags(argv.slice(1), {
      '--rules': 'string', '--landing': 'string', '--path': 'string', '--paths': 'string',
      '--project': 'string', '--json': 'boolean',
    });
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`rk-rules: ${err.message}\n${USAGE_RULES}\n`);
      return RC.USAGE;
    }
    throw err;
  }
  if (flags.help) {
    io.out(`${USAGE_RULES}\n`);
    return RC.OK;
  }
  const projectRoot = resolve(flags.project ?? process.cwd());

  if (command === 'effective') {
    if (flags.landing === undefined && flags.rules === undefined) {
      io.err('rk-rules: effective 需要 --landing <落点> 或 --rules <rules.json>\n');
      return RC.USAGE;
    }
    let rules = null;
    let config = null;
    if (flags.landing !== undefined) {
      const landing = resolve(flags.landing);
      if (!existsSync(landing) || !statSync(landing).isDirectory()) {
        io.err(`rk-rules: --landing 不是已存在目录: ${landing}\n`);
        return RC.USAGE;
      }
      const loaded = loadLandingRules(landing);
      if (loaded.rulesResult.error !== null) {
        io.err(`rk-rules: 读 rules.json 失败: ${loaded.rulesResult.error}\n`);
        return RC.FAIL;
      }
      rules = loaded.rulesResult.rules;
      config = loaded.config;
    } else {
      const loaded = loadRules(resolve(flags.rules));
      if (loaded.error !== null) {
        io.err(`rk-rules: 读 rules.json 失败: ${loaded.error}\n`);
        return RC.FAIL;
      }
      rules = loaded.rules;
    }
    const merged = effectiveConfig({ rules, config });
    if (flags.json === true) {
      io.out(jsonStable(merged));
    } else {
      io.out(line(`RK_EFFECTIVE_MODE=${merged.mode}`));
      io.out(line(`RK_EFFECTIVE_PROJECT=${merged.project ?? '(未声明)'}`));
      io.out(line(`RK_EFFECTIVE_LEDGER_PATH=${merged.ledgerPath}`));
      io.out(line(`RK_EFFECTIVE_MAX_INJECT_CHARS=${merged.maxInjectChars}`));
      io.out(line(`RK_EFFECTIVE_PROTECTED=${merged.protected_paths.length}`));
      io.out(line(`RK_EFFECTIVE_SOURCE_PROTECTED=${merged.sources.protected_paths}`));
    }
    io.out(resultLine('RULES_EFFECTIVE', true));
    return RC.OK;
  }

  if (flags.rules === undefined) {
    io.err(`rk-rules: ${command} 需要 --rules <rules.json>\n`);
    return RC.USAGE;
  }
  const rulesPath = resolve(flags.rules);
  const loaded = loadRules(rulesPath);
  if (loaded.error !== null) {
    io.err(`rk-rules: 读 rules.json 失败: ${loaded.error}\n`);
    return RC.FAIL;
  }
  if (!loaded.ok) {
    for (const finding of loaded.findings) io.err(`rk-rules: ${finding.msg}\n`);
    io.err(`RK_RULES_FINDINGS=${loaded.findings.length}\nRK_RULES_RESULT=fail\n`);
    return RC.FAIL;
  }
  const rules = loaded.rules;

  if (command === 'check') {
    io.out(line(`RK_RULES_PATH=${rulesPath}`));
    io.out(line(`RK_RULES_PROJECT=${rules.project}`));
    io.out(line(`RK_RULES_PROTECTED=${Array.isArray(rules.protected_paths) ? rules.protected_paths.length : 0}`));
    io.out(line('RK_RULES_FIELDS_OK=6'));
    io.out(resultLine('RULES', true));
    return RC.OK;
  }

  if (command === 'is-protected') {
    if (flags.path === undefined) {
      io.err('rk-rules: is-protected 需要 --path <路径>\n');
      return RC.USAGE;
    }
    const verdict = isProtected(flags.path, rules, { projectRoot });
    const paths = [flags.path];
    const consistency = checkConsumersConsistency(rules, paths, { projectRoot });
    if (flags.json === true) {
      io.out(jsonStable({ path: flags.path, ...verdict, consumers: consistency.probes[0]?.verdicts ?? {} }));
    } else {
      io.out(line(`RK_IS_PROTECTED_NORMALIZED=${verdict.normalizedPath ?? '(空)'}`));
      io.out(line(`RK_IS_PROTECTED_MATCHED=${verdict.matchedPattern ?? '(无)'}`));
      io.out(line(`RK_IS_PROTECTED=${verdict.protected}`));
      for (const name of CONSUMERS) {
        io.out(line(`CONSUMER ${name} ${consistency.probes[0]?.verdicts?.[name]}`));
      }
    }
    const diverged = consistency.findings.length > 0;
    io.out(resultLine('IS_PROTECTED', !diverged));
    return diverged ? RC.FAIL : RC.OK;
  }

  // consistency：四点必须与单点一致
  if (flags.paths === undefined) {
    io.err('rk-rules: consistency 需要 --paths <p1,p2,...>\n');
    return RC.USAGE;
  }
  const paths = flags.paths.split(',').map((s) => s.trim()).filter((s) => s !== '');
  const report = checkConsumersConsistency(rules, paths, { projectRoot });
  if (flags.json === true) {
    io.out(jsonStable(report));
  } else {
    io.out(line(`RK_CONSISTENCY_PROBES=${paths.length}`));
    for (const probe of report.probes) {
      io.out(line(`PROBE ${probe.path} single=${probe.single} consumers=${CONSUMERS.map((n) => probe.verdicts[n]).join(',')}`));
    }
    for (const finding of report.findings) io.out(line(`FINDING ${finding.code} ${finding.msg}`));
    io.out(line(`RK_CONSISTENCY_DIVERGED=${report.findings.length}`));
  }
  io.out(resultLine('CONSISTENCY', report.ok));
  return report.ok ? RC.OK : RC.FAIL;
}

// ── LF-240：dsh-rulekeeper 六子命令 ──────────────────────────────────────────────
export const SUB_USAGE = Object.freeze({
  init: '用法: dsh-rulekeeper init [--project <dir>]\n建立两处落点 + config.json（默认 mode=observe；已存在的 config 不覆盖）\n退出码: 0 成功 / 2 用法错误 / 1 运行失败',
  check: '用法: dsh-rulekeeper check --landing <落点> [--project <项目根>] [--strict] [--json]\n       dsh-rulekeeper check --shape <样本> [--lines n] [--maxline n] [--sha256 <冻结值>] [--json]   （LF-260 形态守卫入口）\n退出码: 0 无 error 级问题 / 1 有 error 级问题 / 2 用法错误',
  snap: '用法: dsh-rulekeeper snap --landing <落点> --path <路径> [--project <项目根>] [--now <ISO>] [--why <文本>] [--json]\n'
    + '说明: LF-300 pre-image 快照 = 备份 + **回读校验** + snapshots/index.jsonl 登记（等价于 `rk-snap take`）；\n'
    + '      回滚用 `rk-snap restore --path <路径>`，对账用 `rk-snap recon`。\n'
    + '退出码: 0 成功 / 1 失败（含回读不一致）/ 2 用法错误',
  record: '用法: dsh-rulekeeper record --landing <落点> --rule <r> --problem <p> --root-cause <r> --solution <s> [--category <c>] [--mechanism <m>] [--evidence <a,b>] [--now <ISO>]\n退出码: 0 成功 / 1 写入失败 / 2 用法错误',
  rules: USAGE_RULES,
  redact: USAGE_REDACT,
  evolve: '用法: dsh-rulekeeper evolve --landing <落点> [--quality <file.json>] [--source auto|human] [--escalate-gate] [--rule <纪律>] [--dry-run] [--now <ISO>] [--json]\n'
    + '说明: 复发 ≥2 的纪律 -> 生成 proposals/<id>.json（**闸先于写者**：绝不写 rules.json）；\n'
    + '      提案四要件（LF-295）缺一即失败；--escalate-gate 属"升门禁"，必须 --source human。\n'
    + '退出码: 0 无 error 级问题 / 1 有不合格提案或被闸门拒绝 / 2 用法错误',
  report: '用法: dsh-rulekeeper report --landing <落点> [--project <项目根>] [--now <ISO>] [--json]\n退出码: 0 成功 / 1 读失败 / 2 用法错误',
  gate: USAGE_GATE,
  stoploss: USAGE_STOP_LOSS,
  migrate: USAGE_MIGRATE,
});

/**
 * `rk-gate`（P5 真阻断）：`write` = LF-530 写入侧对账；`hooks` = LF-520 hook 完整性 preflight。
 */
/**
 * `rk-redact` / `dsh-rulekeeper redact`（LF-340 脱敏）
 * 三种用途：① `--text <s>` 预览脱敏结果（只出计数）② `--check` 扫描落点既有产物（只出规则名/行号/计数）
 * ③ `--self-control` 正对照（必然命中的内置样本，命中数必须 >0 —— 防"扫描器坏了却报零命中"的假绿）
 */
export function runRedact(argv, io = defaultIo(), env = process.env) {
  let flags;
  try {
    flags = scanFlags(argv, {
      '--project': 'string', '--landing': 'string', '--text': 'string', '--file': 'string',
      '--check': 'boolean', '--self-control': 'boolean', '--identity': 'boolean', '--json': 'boolean', '--help': 'boolean',
    });
  } catch (err) {
    if (err instanceof UsageError) { io.err(`rk-redact: ${err.message}\n${USAGE_REDACT}\n`); return RC.USAGE; }
    throw err;
  }
  if (flags.help === true) { io.out(`${USAGE_REDACT}\n`); return RC.OK; }
  const identity = flags.identity === true;
  let self;
  try {
    self = selfTestRules();
  } catch (err) {
    io.err(`rk-redact: 规则自测失败（fail-closed，不许在规则漂移时假装能脱敏）: ${err.message}\n`);
    return RC.FAIL;
  }
  if (flags.json !== true) io.out(line(`RK_REDACT_RULES=${self.rules} SAMPLES=${self.samples} IDENTITY=${identity}`));

  if (flags.text !== undefined) {
    const r = redactText(flags.text, { identity });
    const s = statsOf(r.hits);
    if (flags.json === true) { io.out(jsonStable({ ok: true, changed: r.text !== flags.text, stats: s })); return RC.OK; }
    io.out(line(`RK_REDACT_CHANGED=${r.text !== flags.text}`));
    for (const h of s.byRule) io.out(line(`REDACTED ${h.rule} count=${h.count}`));
    io.out(line(`RK_REDACT_TOTAL=${s.total}`));
    io.out(resultLine('REDACT', true));
    return RC.OK;
  }

  if (flags['self-control'] === true) {
    const sample = 'C:\\Users\\zhangsan 13800138000 a@b.com ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 password=hunter2secret';
    const r = redactText(sample, { identity });
    const s = statsOf(r.hits);
    const ok = s.total > 0;
    if (flags.json === true) { io.out(jsonStable({ ok, stats: s })); return ok ? RC.OK : RC.FAIL; }
    for (const h of s.byRule) io.out(line(`SELF_CONTROL ${h.rule} count=${h.count}`));
    io.out(line(`RK_REDACT_SELF_CONTROL_HITS=${s.total}`));
    io.out(resultLine('REDACT_SELF_CONTROL', ok));
    return ok ? RC.OK : RC.FAIL;
  }

  if (flags.check === true) {
    const projectRoot = resolve(flags.project ?? process.cwd());
    const landing = resolve(flags.landing ?? resolveProjectLanding(projectRoot));
    const files = [
      join(landing, 'ledger.jsonl'),
      join(landing, 'logs', 'gate.jsonl'),
      ...(existsSync(join(landing, 'proposals')) ? readdirSync(join(landing, 'proposals')).filter((f) => f.endsWith('.md') || f.endsWith('.json')).map((f) => join(landing, 'proposals', f)) : []),
    ];
    const findings = [];
    let scanned = 0;
    for (const file of files) {
      if (!existsSync(file)) continue;
      scanned += 1;
      const rows = readFileSync(file, 'utf8').split('\n');
      rows.forEach((row, i) => {
        if (row.trim() === '') return;
        const s = scanText(row, { identity });
        for (const h of s.hits) {
          findings.push({ code: 'REDACT_RESIDUAL', file: displayPath(file), line: i + 1, rule: h.rule, count: h.count });
        }
      });
    }
    const ok = findings.length === 0;
    if (flags.json === true) { io.out(jsonStable({ ok, scanned, findings })); return ok ? RC.OK : RC.FAIL; }
    io.out(line(`RK_REDACT_CHECK_FILES=${scanned} RESIDUAL_LINES=${findings.length}`));
    for (const f of findings) io.out(line(`RESIDUAL ${f.rule} ${f.file}:${f.line} count=${f.count}`));
    io.out(line('NOTE 只打印规则名/行号/计数——**从不打印原文**（否则扫描器自己就成了泄漏点）'));
    io.out(resultLine('REDACT_CHECK', ok));
    return ok ? RC.OK : RC.FAIL;
  }

  io.err(`rk-redact: 需要 --text / --check / --self-control 之一\n${USAGE_REDACT}\n`);
  return RC.USAGE;
}

export function runGate(argv, io = defaultIo(), env = process.env) {
  const [sub, ...rest] = argv;
  if (sub === undefined) {
    io.out(`${USAGE_GATE}\n`);
    return RC.USAGE;
  }
  if (sub === '--help' || sub === '-h') {
    io.out(`${USAGE_GATE}\n`);
    return RC.OK;
  }
  if (sub === 'write') return runGateWrite(rest, io, env);
  if (sub === 'precommit') return runGatePrecommit(rest, io, env);
  if (sub === 'postcommit') return runGatePostcommit(rest, io, env);
  if (sub === 'bypass') return runGateBypass(rest, io, env);
  if (sub === 'ci') return runGateCi(rest, io, env);
  if (sub === 'close') return runGateClose(rest, io, env);
  if (sub === 'hooks') return runGateHooks(rest, io, env);
  io.err(`rk-gate: 未知子命令 "${sub}"\n${USAGE_GATE}\n`);
  return RC.USAGE;
}

/** `rk-gate precommit`（LF-500） */
export function runGatePrecommit(argv, io = defaultIo(), env = process.env) {
  let flags;
  try {
    flags = scanFlags(argv, {
      '--repo': 'string', '--landing': 'string', '--clear-index': 'boolean', '--now': 'string',
      '--json': 'boolean', '--help': 'boolean',
    });
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`rk-gate precommit: ${err.message}\n${USAGE_GATE}\n`);
      return RC.USAGE;
    }
    throw err;
  }
  if (flags.help === true) {
    io.out(`${USAGE_GATE}\n`);
    return RC.OK;
  }
  const repoRoot = resolve(flags.repo ?? process.cwd());
  if (!existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) {
    io.err(`rk-gate precommit: --repo 不是已存在目录: ${repoRoot}\n`);
    return RC.USAGE;
  }
  let now = new Date();
  if (flags.now !== undefined) {
    const parsed = Date.parse(flags.now);
    if (Number.isNaN(parsed)) {
      io.err(`rk-gate precommit: --now 不是合法时间: ${flags.now}\n`);
      return RC.USAGE;
    }
    now = new Date(parsed);
  }
  const landingDir = flags.landing === undefined ? undefined : resolve(flags.landing);
  const r = precommitGate({ repoRoot, landingDir, clearIndex: flags['clear-index'] === true, now });
  if (r.isGit !== true) {
    if (flags.json === true) {
      io.out(jsonStable({ ok: false, isGit: false, findings: r.findings }));
      return RC.USAGE;
    }
    io.err(`rk-gate precommit: ${r.findings.map((f) => f.message).join('; ')}\n`);
    return RC.USAGE;
  }
  const short = (h) => (typeof h === 'string' && h !== '' ? h.slice(0, 12) : '(none)');
  if (flags.json === true) {
    io.out(jsonStable({
      ok: r.ok,
      rulesPresent: r.present,
      source: r.source,
      mode: r.mode,
      staged: r.staged,
      protectedStaged: r.protectedStaged.map((p) => ({ path: p.path, verdict: p.verdict, stagedSha256: p.stagedSha256, baseline: p.baseline ?? null, recordTs: p.recordTs })),
      violations: r.violations.map((v) => v.path),
      clearIndex: flags['clear-index'] === true,
      indexCleared: r.cleared,
      clearedPaths: r.clearedPaths,
      ledger: r.ledger,
      findings: r.findings,
    }));
    return r.ok ? RC.OK : RC.FAIL;
  }
  io.out(line(`RK_GATE_PRECOMMIT_RULES_PRESENT=${r.present}`));
  io.out(line(`RK_GATE_PRECOMMIT_SOURCE=${r.source}`));
  io.out(line(`RK_GATE_PRECOMMIT_MODE=${r.mode}`));
  io.out(line(`RK_GATE_PRECOMMIT_STAGED=${r.staged.length}`));
  io.out(line(`RK_GATE_PRECOMMIT_PROTECTED=${r.protectedStaged.length}`));
  io.out(line(`RK_GATE_PRECOMMIT_OK=${r.protectedStaged.filter((p) => p.verdict === 'snapshotted').length}`));
  io.out(line(`RK_GATE_PRECOMMIT_UNRECORDED=${r.violations.filter((v) => v.verdict === 'unrecorded').length}`));
  io.out(line(`RK_GATE_PRECOMMIT_NOSNAPSHOT=${r.violations.filter((v) => v.verdict === 'nosnapshot').length}`));
  io.out(line(`RK_GATE_PRECOMMIT_INDEX_LINES=${r.indexLines} RK_GATE_PRECOMMIT_INDEX_BAD_LINES=${r.indexBadLines}`));
  io.out(line(`RK_GATE_PRECOMMIT_CLEAR_REQUESTED=${flags['clear-index'] === true}`));
  io.out(line(`RK_GATE_PRECOMMIT_INDEX_CLEARED=${r.cleared}`));
  io.out(line(`RK_GATE_PRECOMMIT_LEDGER=${r.ledger === null ? '(none)' : `${r.ledger.path} ok=${r.ledger.ok}`}`));
  for (const p of r.protectedStaged) {
    io.out(line(`STAGED ${p.path} verdict=${p.verdict} staged=${short(p.stagedSha256)} baseline=${short(p.baseline)} record_ts=${p.recordTs ?? '(none)'}`));
  }
  for (const f of r.findings) io.out(line(`FINDING ${f.code} ${f.message}`));
  if (r.violations.length > 0) {
    io.out(line(`HINT 留证后重试: rk-snap take --path <文件> --landing <落点>；或显式放弃本次改动: git restore --staged -- <文件>`));
    io.out(line(`HINT 暂存区${r.cleared ? '已清空' : '**未清空**'}；被拒改动留在暂存区会被下次 \`git commit --no-verify\` 夹带（已记台账）`));
  }
  io.out(resultLine('GATE_PRECOMMIT', r.ok));
  return r.ok ? RC.OK : RC.FAIL;
}

/** `rk-gate postcommit`（LF-510 的取证端；由 post-commit hook 调用） */
export function runGatePostcommit(argv, io = defaultIo(), env = process.env) {
  let flags;
  try {
    flags = scanFlags(argv, { '--repo': 'string', '--landing': 'string', '--sha': 'string', '--now': 'string', '--json': 'boolean', '--help': 'boolean' });
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`rk-gate postcommit: ${err.message}\n${USAGE_GATE}\n`);
      return RC.USAGE;
    }
    throw err;
  }
  if (flags.help === true) {
    io.out(`${USAGE_GATE}\n`);
    return RC.OK;
  }
  const repoRoot = resolve(flags.repo ?? process.cwd());
  if (!existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) {
    io.err(`rk-gate postcommit: --repo 不是已存在目录: ${repoRoot}\n`);
    return RC.USAGE;
  }
  let now = new Date();
  if (flags.now !== undefined) {
    const parsed = Date.parse(flags.now);
    if (Number.isNaN(parsed)) {
      io.err(`rk-gate postcommit: --now 不是合法时间: ${flags.now}\n`);
      return RC.USAGE;
    }
    now = new Date(parsed);
  }
  const r = postCommitRecon({ repoRoot, landingDir: flags.landing === undefined ? undefined : resolve(flags.landing), sha: flags.sha ?? null, now });
  if (r.isGit !== true) {
    if (flags.json === true) {
      io.out(jsonStable({ ok: false, isGit: false, findings: r.findings }));
      return RC.USAGE;
    }
    io.err(`rk-gate postcommit: ${r.findings.map((f) => f.message).join('; ')}\n`);
    return RC.USAGE;
  }
  const short = (h) => (typeof h === 'string' && h !== '' ? h.slice(0, 12) : '(none)');
  if (flags.json === true) {
    io.out(jsonStable({
      ok: r.ok,
      sha: r.sha,
      rulesPresent: r.present,
      source: r.source,
      protectedPaths: r.protectedPaths,
      violations: r.violations.map((v) => v.path),
      ledger: r.ledger,
      findings: r.findings,
    }));
    return r.ok ? RC.OK : RC.FAIL;
  }
  io.out(line(`RK_GATE_POSTCOMMIT_SHA=${short(r.sha)}`));
  io.out(line(`RK_GATE_POSTCOMMIT_RULES_PRESENT=${r.present}`));
  io.out(line(`RK_GATE_POSTCOMMIT_SOURCE=${r.source}`));
  io.out(line(`RK_GATE_POSTCOMMIT_PROTECTED=${r.protectedPaths.length}`));
  io.out(line(`RK_GATE_POSTCOMMIT_VIOLATIONS=${r.violations.length}`));
  io.out(line(`RK_GATE_POSTCOMMIT_LEDGER=${r.ledger === null ? '(none)' : `${r.ledger.path} ok=${r.ledger.ok}`}`));
  for (const p of r.protectedPaths) {
    io.out(line(`COMMIT ${p.path} verdict=${p.verdict} committed=${short(p.committedSha256)} baseline=${short(p.baseline)} record_ts=${p.recordTs ?? '(none)'}`));
  }
  for (const f of r.findings) io.out(line(`FINDING ${f.code} ${f.message}`));
  if (r.violations.length > 0) {
    io.out(line('HINT 这次提交已成立（post-commit 无法撤回）；补救：rk-snap take 补齐留证，或 git revert/--amend 配合 pre-commit 重来'));
    io.out(line('HINT 若本次用了 `git commit --no-verify`：pre-commit 被跳过，但 post-commit 仍执行 —— 这条记录就是"绕过"的凭据（对账用 rk-gate bypass）'));
  }
  io.out(resultLine('GATE_POSTCOMMIT', r.ok));
  return r.ok ? RC.OK : RC.FAIL;
}

/** `rk-gate bypass`（LF-510 的对账端） */
export function runGateBypass(argv, io = defaultIo(), env = process.env) {
  let flags;
  try {
    flags = scanFlags(argv, { '--repo': 'string', '--landing': 'string', '--limit': 'string', '--all': 'boolean', '--json': 'boolean', '--help': 'boolean' });
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`rk-gate bypass: ${err.message}\n${USAGE_GATE}\n`);
      return RC.USAGE;
    }
    throw err;
  }
  if (flags.help === true) {
    io.out(`${USAGE_GATE}\n`);
    return RC.OK;
  }
  const repoRoot = resolve(flags.repo ?? process.cwd());
  if (!existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) {
    io.err(`rk-gate bypass: --repo 不是已存在目录: ${repoRoot}\n`);
    return RC.USAGE;
  }
  let limit = 50;
  if (flags.limit !== undefined) {
    limit = Number(flags.limit);
    if (!Number.isInteger(limit) || limit <= 0) {
      io.err(`rk-gate bypass: --limit 需要正整数（收到 ${flags.limit}）\n`);
      return RC.USAGE;
    }
  }
  const r = bypassRecon({ repoRoot, landingDir: flags.landing === undefined ? undefined : resolve(flags.landing), limit, all: flags.all === true });
  if (r.isGit !== true) {
    if (flags.json === true) {
      io.out(jsonStable({ ok: false, isGit: false, findings: r.findings }));
      return RC.USAGE;
    }
    io.err(`rk-gate bypass: ${r.findings.map((f) => f.message).join('; ')}\n`);
    return RC.USAGE;
  }
  if (flags.json === true) {
    io.out(jsonStable({
      ok: r.ok,
      scope: r.scope,
      rulesPresent: r.present,
      source: r.source,
      checked: r.checked,
      relevantCommits: r.relevantCommits,
      gated: r.gated,
      bypassed: r.bypassed,
      ledgerRows: r.ledgerRows,
      findings: r.findings,
    }));
    return r.ok ? RC.OK : RC.FAIL;
  }
  io.out(line(`RK_GATE_BYPASS_SCOPE=${r.scope}`));
  io.out(line(`RK_GATE_BYPASS_RULES_PRESENT=${r.present}`));
  io.out(line(`RK_GATE_BYPASS_CHECKED=${r.checked}`));
  io.out(line(`RK_GATE_BYPASS_RELEVANT=${r.relevantCommits}`));
  io.out(line(`RK_GATE_BYPASS_GATED=${r.gated.length}`));
  io.out(line(`RK_GATE_BYPASS_BYPASSED=${r.bypassed.length}`));
  io.out(line(`RK_GATE_BYPASS_LEDGER_ROWS=${r.ledgerRows}`));
  for (const b of r.bypassed) {
    io.out(line(`BYPASSED ${b.sha} state=${b.state} paths=${b.paths.join(',')}`));
  }
  for (const g of r.gated) io.out(line(`GATED ${g.sha} paths=${g.paths.join(',')}`));
  for (const f of r.findings) io.out(line(`FINDING ${f.code} ${f.message}`));
  io.out(line('HINT 远端防线（CI / 受保护分支）是另一条目 LF-540 —— 本命令**只**覆盖本地可判定部分'));
  io.out(resultLine('GATE_BYPASS', r.ok));
  return r.ok ? RC.OK : RC.FAIL;
}

/** `rk-gate ci`（LF-540 远端防线：服务端入口，新 clone 无 hook 时的兜底） */
export function runGateCi(argv, io = defaultIo(), env = process.env) {
  let flags;
  try {
    flags = scanFlags(argv, {
      '--repo': 'string', '--landing': 'string', '--base': 'string', '--head': 'string', '--all': 'boolean',
      '--write-workflow': 'boolean', '--workflow': 'string', '--workflow-range': 'string',
      '--bin': 'string', '--bin-sha': 'string', '--node-version': 'string',
      '--claim-remote': 'boolean', '--limit': 'string', '--json': 'boolean', '--help': 'boolean',
    });
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`rk-gate ci: ${err.message}\n${USAGE_GATE}\n`);
      return RC.USAGE;
    }
    throw err;
  }
  if (flags.help === true) {
    io.out(`${USAGE_GATE}\n`);
    return RC.OK;
  }
  const repoRoot = resolve(flags.repo ?? process.cwd());
  if (!existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) {
    io.err(`rk-gate ci: --repo 不是已存在目录: ${repoRoot}\n`);
    return RC.USAGE;
  }
  let limit;
  if (flags.limit !== undefined) {
    limit = Number(flags.limit);
    if (!Number.isInteger(limit) || limit <= 0) {
      io.err(`rk-gate ci: --limit 需要正整数（收到 ${flags.limit}）\n`);
      return RC.USAGE;
    }
  }

  // 生成动作**显式**（不给默认开）：只写工作流文件，不跑对账 —— 生成与校验是两件事，别混成一个绿灯
  if (flags['write-workflow'] === true) {
    const w = writeCiWorkflow({
      projectRoot: repoRoot,
      rel: flags.workflow ?? CI_WORKFLOW_REL,
      binPath: flags.bin,
      nodeVersion: flags['node-version'],
      range: flags['workflow-range'],
    });
    if (flags.json === true) {
      io.out(jsonStable({ ok: w.ok, rel: w.rel, bytes: w.bytes, findings: w.ok ? [] : [{ code: 'CI_WORKFLOW_WRITE_FAILED', message: String(w.reason) }] }));
      return w.ok ? RC.OK : RC.FAIL;
    }
    if (!w.ok) {
      io.err(`rk-gate ci: 工作流写入失败: ${w.reason}\n`);
      return RC.FAIL;
    }
    io.out(line(`RK_GATE_CI_WROTE=${w.rel} BYTES=${w.bytes}`));
    io.out(resultLine('GATE_CI_WRITE', true));
    return RC.OK;
  }

  const r = ciGate({
    repoRoot,
    landingDir: flags.landing === undefined ? undefined : resolve(flags.landing),
    base: flags.base,
    head: flags.head,
    all: flags.all === true,
    limit,
    workflowRel: flags.workflow,
    workflowRange: flags['workflow-range'],
    binPath: flags.bin,
    binSha: flags['bin-sha'],
    nodeVersion: flags['node-version'],
    claimRemote: flags['claim-remote'] === true,
  });
  if (r.isGit !== true) {
    // 评审 中危⑥：这里是"环境错"（不是 git 仓）与"ref 不存在"共用的分支 —— 用一个**能区分**的码上报，
    //   仍然 rc=2（rc 表里 0–5 没有"环境错"这一档，判红(1)会谎称"判过了"）
    const codes = r.findings.map((f) => f.code).join(',');
    if (flags.json === true) {
      io.out(jsonStable({ ok: false, isGit: false, rcReason: codes.includes('NOT_GIT') ? 'not-a-git-repo' : 'bad-revision-range', findings: r.findings }));
      return RC.USAGE;
    }
    io.err(`rk-gate ci: ${r.findings.map((f) => f.message).join('; ')}\n`);
    return RC.USAGE;
  }
  if (flags.json === true) {
    io.out(jsonStable({
      ok: r.ok,
      scope: r.scope,
      protection: r.protection,
      hooksInstalled: r.hooksInstalled,
      hooksPath: r.hooksPath,
      hookCarriers: r.hookCarriers,
      checked: r.checked,
      relevantCommits: r.relevantCommits,
      bypassed: r.bypassed,
      workflow: r.workflow,
      bin: r.bin,
      carrier: r.carrier,
      ledgerAuthenticated: r.ledgerAuthenticated,
      findings: r.findings,
    }));
    return r.ok ? RC.OK : RC.FAIL;
  }
  io.out(line(`RK_GATE_CI_SCOPE=${r.scope}`));
  io.out(line(`RK_GATE_CI_PROTECTION_PRESENT=${r.protection.present}`));
  io.out(line(`RK_GATE_CI_PROTECTION_PATTERNS=${r.protection.patterns}`));
  io.out(line(`RK_GATE_CI_PROTECTION_MATCHED_FILES=${r.protection.matchedFiles}`));
  io.out(line(`RK_GATE_CI_HOOKS_PATH=${r.hooksPath === null ? '(none)' : r.hooksPath}`));
  io.out(line(`RK_GATE_CI_HOOKS_INSTALLED=${r.hooksInstalled}（服务端门**不依赖**它：新 clone 天然没有）`));
  io.out(line(`RK_GATE_CI_CHECKED=${r.checked}`));
  io.out(line(`RK_GATE_CI_RELEVANT=${r.relevantCommits}`));
  io.out(line(`RK_GATE_CI_BYPASSED=${r.bypassed.length}`));
  io.out(line(`RK_GATE_CI_WORKFLOW=${r.workflow.rel} present=${r.workflow.present} ok=${r.workflow.ok} sha=${(r.workflow.actualSha ?? '(none)').slice(0, 12)}`));
  io.out(line(`RK_GATE_CI_BIN=${r.bin.rel} present=${r.bin.present} sha=${(r.bin.sha256 ?? '(none)').slice(0, 12)}`));
  io.out(line(`RK_GATE_CI_LEDGER_AUTHENTICATED=${r.ledgerAuthenticated}（自曝：台账无签名/不绑定提交树 ⇒ 能改台账的人也能把物证写全）`));
  io.out(line(`RK_GATE_CI_CARRIER_DONE=${r.carrier.done}（自曝边界：${r.carrier.reason}）`));
  for (const b of r.bypassed) io.out(line(`BYPASSED ${b.sha.slice(0, 12)} state=${b.state} paths=${b.paths.join(',')}`));
  for (const f of r.findings) io.out(line(`FINDING ${f.code} ${f.message}`));
  io.out(resultLine('GATE_CI', r.ok));
  return r.ok ? RC.OK : RC.FAIL;
}

/** `rk-gate close`（LF-550 收尾闸） */
export function runGateClose(argv, io = defaultIo(), env = process.env) {
  let flags;
  try {
    flags = scanFlags(argv, {
      '--project': 'string', '--landing': 'string', '--hit': 'string[]', '--none': 'boolean', '--batch': 'string',
      '--evidence': 'string[]', '--declaration': 'string', '--now': 'string', '--json': 'boolean', '--help': 'boolean',
    });
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`rk-gate close: ${err.message}\n${USAGE_GATE}\n`);
      return RC.USAGE;
    }
    throw err;
  }
  if (flags.help === true) {
    io.out(`${USAGE_GATE}\n`);
    return RC.OK;
  }
  const hits = [];
  for (const raw of flags.hit ?? []) {
    const parsed = parseHit(raw);
    if (parsed === null) {
      io.err(`rk-gate close: --hit 必须是 "<纪律>=<拦住它的机制>"（收到 ${raw}）\n`);
      return RC.USAGE;
    }
    hits.push(parsed);
  }
  let now = new Date();
  if (flags.now !== undefined) {
    const parsed = Date.parse(flags.now);
    if (Number.isNaN(parsed)) {
      io.err(`rk-gate close: --now 不是合法时间: ${flags.now}\n`);
      return RC.USAGE;
    }
    now = new Date(parsed);
  }
  let declaration;
  if (flags.declaration !== undefined) {
    const file = resolve(flags.declaration);
    if (!existsSync(file)) {
      io.err(`rk-gate close: --declaration 文件不存在: ${flags.declaration}\n`);
      return RC.USAGE;
    }
    try {
      declaration = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      io.err(`rk-gate close: --declaration 不是合法 JSON: ${err?.message ?? ''}\n`);
      return RC.USAGE;
    }
  }
  const projectRoot = resolve(flags.project ?? process.cwd());
  if (!existsSync(projectRoot) || !statSync(projectRoot).isDirectory()) {
    io.err(`rk-gate close: --project 不是已存在目录: ${projectRoot}\n`);
    return RC.USAGE;
  }
  if (!existsSync(projectRoot)) {
    io.err(`rk-gate close: --project 不存在: ${projectRoot}\n`);
    return RC.USAGE;
  }
  const r = closeGate({
    projectRoot,
    landingDir: flags.landing === undefined ? undefined : resolve(flags.landing),
    hits,
    none: flags.none === true,
    batch: flags.batch ?? '(unnamed)',
    evidence: flags.evidence ?? [],
    declaration,
    now,
  });
  if (flags.json === true) {
    io.out(jsonStable({
      ok: r.ok,
      batch: r.batch,
      answered: r.answered,
      none: r.none,
      hits: r.hits,
      evidence: r.evidence,
      evidenceMissing: r.evidenceMissing,
      knownRules: r.knownRules,
      uncheckable: r.uncheckableHits,
      declaration: r.declarationResult === null ? null : { ok: r.declarationResult.ok, verdict: r.declarationResult.verdict, rule: r.declarationResult.detail?.rule ?? null },
      ledger: r.ledger,
      findings: r.findings,
    }));
    return r.ok ? RC.OK : RC.FAIL;
  }
  io.out(line(`RK_GATE_CLOSE_BATCH=${r.batch}`));
  io.out(line(`RK_GATE_CLOSE_ANSWERED=${r.answered}`));
  io.out(line(`RK_GATE_CLOSE_NONE=${r.none}`));
  io.out(line(`RK_GATE_CLOSE_HITS=${r.hits.length}`));
  io.out(line(`RK_GATE_CLOSE_KNOWN_RULES=${r.knownRules}`));
  io.out(line(`RK_GATE_CLOSE_UNCHECKABLE=${r.uncheckableHits}`));
  io.out(line(`RK_GATE_CLOSE_EVIDENCE=${r.evidence.length} MISSING=${r.evidenceMissing.length}`));
  io.out(line(`RK_GATE_CLOSE_LEDGER=${r.ledger === null ? '(none)' : `${r.ledger.path} ok=${r.ledger.ok}`}`));
  for (const h of r.hits) io.out(line(`HIT ${h.rule} stoppedBy=${h.stoppedBy}`));
  for (const f of r.findings) io.out(line(`FINDING ${f.code} ${f.message}`));
  io.out(resultLine('GATE_CLOSE', r.ok));
  return r.ok ? RC.OK : RC.FAIL;
}

/** `rk-gate hooks verify|install|uninstall`（LF-520 / LF-810） */
export function runGateHooks(argv, io = defaultIo(), env = process.env) {
  const [action, ...rest] = argv;
  if (action === undefined) {
    io.err(`rk-gate hooks: 需要 verify / install / uninstall\n${USAGE_GATE}\n`);
    return RC.USAGE;
  }
  let flags;
  try {
    flags = scanFlags(rest, {
      '--repo': 'string', '--hooks-path': 'string', '--force': 'boolean', '--no-config': 'boolean',
      '--json': 'boolean', '--help': 'boolean',
    });
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`rk-gate hooks: ${err.message}\n${USAGE_GATE}\n`);
      return RC.USAGE;
    }
    throw err;
  }
  if (flags.help === true) {
    io.out(`${USAGE_GATE}\n`);
    return RC.OK;
  }
  const repoRoot = resolve(flags.repo ?? process.cwd());
  if (!existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) {
    io.err(`rk-gate hooks: --repo 不是已存在目录: ${repoRoot}\n`);
    return RC.USAGE;
  }
  const short = (h) => (typeof h === 'string' && h !== '' ? h.slice(0, 12) : '(none)');

  if (action === 'install') {
    const r = installHooks({
      repoRoot,
      hooksPath: flags['hooks-path'] ?? DEFAULT_HOOKS_PATH,
      gateBin: join(PKG_ROOT, 'bin', 'rk-gate.mjs'),
      force: flags.force === true,
      setConfig: flags['no-config'] !== true,
    });
    if (flags.json === true) {
      io.out(jsonStable({
        ok: r.ok,
        hooksPath: r.hooksPath,
        installed: r.installed ?? [],
        runnerSha256: r.runnerSha ?? null,
        configSet: r.configSet ?? false,
        reasons: r.reasons ?? [],
      }));
      return r.ok ? RC.OK : RC.FAIL;
    }
    io.out(line(`RK_GATE_HOOKS_ACTION=install`));
    io.out(line(`RK_GATE_HOOKS_PATH=${r.hooksPath}`));
    io.out(line(`RK_GATE_HOOKS_INSTALLED=${(r.installed ?? []).length}`));
    io.out(line(`RK_GATE_HOOKS_CONFIG_SET=${r.configSet === true}`));
    io.out(line(`RK_GATE_HOOKS_RUNNER_SHA256=${short(r.runnerSha)}`));
    for (const h of r.installed ?? []) io.out(line(`HOOK installed ${h.name} sha256=${short(h.sha256)} bytes=${h.bytes}`));
    for (const reason of r.reasons ?? []) io.out(line(`FINDING GATE_HOOKS_INSTALL ${reason}`));
    io.out(resultLine('GATE_HOOKS', r.ok));
    return r.ok ? RC.OK : RC.FAIL;
  }
  if (action === 'uninstall') {
    // m6（独立审查）：uninstall 不读这三个开关；静默忽略会让人以为"我传了 --force 就会强删"。
    for (const unused of ['--force', '--no-config', '--hooks-path']) {
      if (flags[unused.slice(2)] !== undefined) {
        io.err(`rk-gate hooks uninstall: 不支持 ${unused}（卸载只认 --repo/--json；不接受的开关静默忽略会误导）\n${USAGE_GATE}\n`);
        return RC.USAGE;
      }
    }
    const u = uninstallHooks({ repoRoot });
    if (flags.json === true) {
      io.out(jsonStable({
        ok: u.ok,
        alreadyClean: u.alreadyClean,
        hooksPath: u.hooksPath,
        removed: u.removed,
        kept: u.kept,
        absent: u.absent,
        config: u.config,
        dataPreserved: u.dataPreserved,
        dataFiles: u.dataAfter.files.length,
        ledgerEntries: u.ledgerEntries,
        gateRows: u.gateRows,
        findings: u.findings,
      }));
      return u.ok ? RC.OK : RC.FAIL;
    }
    io.out(line(`RK_GATE_HOOKS_ACTION=uninstall`));
    io.out(line(`RK_GATE_HOOKS_ALREADY_CLEAN=${u.alreadyClean === true}`));
    io.out(line(`RK_GATE_HOOKS_PATH=${u.hooksPath ?? '(none)'}`));
    io.out(line(`RK_GATE_HOOKS_REMOVED=${u.removed.length}`));
    io.out(line(`RK_GATE_HOOKS_KEPT=${u.kept.length}`));
    io.out(line(`RK_GATE_HOOKS_CONFIG_ACTION=${u.config.action}`));
    io.out(line(`RK_GATE_HOOKS_CONFIG_VALUE=${u.config.value ?? '(none)'}`));
    io.out(line(`RK_GATE_HOOKS_PREVIOUS_EXISTED=${u.config.previous?.existed === true}`));
    io.out(line(`RK_GATE_HOOKS_PREVIOUS_VALUE=${u.config.previous?.hooksPath ?? '(none)'}`));
    io.out(line(`RK_GATE_HOOKS_DATA_FILES=${u.dataAfter.files.length}`));
    io.out(line(`RK_GATE_HOOKS_DATA_PRESERVED=${u.dataPreserved === true}`));
    io.out(line(`RK_GATE_HOOKS_LEDGER_ENTRIES=${u.ledgerEntries}`));
    io.out(line(`RK_GATE_HOOKS_GATE_ROWS=${u.gateRows}`));
    for (const name of u.removed) io.out(line(`HOOK removed ${name}`));
    for (const k of u.kept) io.out(line(`HOOK kept ${k.name} reason=${k.reason}`));
    for (const f of u.findings) io.out(line(`FINDING GATE_HOOKS_UNINSTALL ${f.code} ${f.message}`));
    io.out(resultLine('GATE_HOOKS', u.ok));
    return u.ok ? RC.OK : RC.FAIL;
  }
  if (action !== 'verify') {
    io.err(`rk-gate hooks: 未知动作 "${action}"（只允许 verify|install|uninstall）\n${USAGE_GATE}\n`);
    return RC.USAGE;
  }
  const v = verifyHooks({ repoRoot, hooksPath: flags['hooks-path'] });
  if (flags.json === true) {
    io.out(jsonStable({
      ok: v.ok,
      hooksPath: v.hooksPath,
      configured: v.configured,
      expectedPath: v.expectedPath,
      manifest: v.manifest === null ? null : { hooksPath: v.manifest.hooksPath, hooks: v.manifest.hooks },
      hooks: v.hooks,
      findings: v.findings,
    }));
    return v.ok ? RC.OK : RC.FAIL;
  }
  io.out(line(`RK_GATE_HOOKS_ACTION=verify`));
  io.out(line(`RK_GATE_HOOKS_PATH=${v.hooksPath}`));
  io.out(line(`RK_GATE_HOOKS_CONFIGURED=${v.configured === '' ? '(empty)' : v.configured}`));
  io.out(line(`RK_GATE_HOOKS_EXPECTED=${v.expectedPath ?? '(none)'}`));
  io.out(line(`RK_GATE_HOOKS_MANIFEST=${v.manifest === null ? 'missing' : 'present'}`));
  io.out(line(`RK_GATE_HOOKS_CHECKED=${v.hooks.length}`));
  io.out(line(`RK_GATE_HOOKS_OK=${v.hooks.filter((h) => h.present === true && h.match === true && h.execOk !== false).length}`));
  io.out(line(`RK_GATE_HOOKS_MISSING=${v.hooks.filter((h) => h.present === false).length}`));
  io.out(line(`RK_GATE_HOOKS_MODIFIED=${v.findings.filter((f) => f.code === 'HOOK_MODIFIED').length}`));
  io.out(line(`RK_GATE_HOOKS_NOT_EXECUTABLE=${v.findings.filter((f) => f.code === 'HOOK_NOT_EXECUTABLE').length}`));
  io.out(line(`RK_GATE_HOOKS_INERT=${v.findings.filter((f) => f.code === 'HOOK_INERT_IN_DOTGIT').length}`));
  for (const h of v.hooks) {
    io.out(line(`HOOK ${h.name} path=${h.path} present=${h.present} sha256=${short(h.sha256)} match=${h.match ?? false} exec=${h.execSource ?? '(n/a)'} exec_ok=${h.execOk ?? false} inert=${h.inert ?? false}`));
  }
  for (const f of v.findings) io.out(line(`FINDING ${f.code} ${f.message}`));
  io.out(resultLine('GATE_HOOKS', v.ok));
  return v.ok ? RC.OK : RC.FAIL;
}

/** `rk-gate write`（LF-530） */
export function runGateWrite(rest, io = defaultIo(), env = process.env) {
  let flags;
  try {
    flags = scanFlags(rest, {
      '--project': 'string', '--landing': 'string', '--file': 'string[]', '--phase': 'string',
      '--json': 'boolean', '--help': 'boolean',
    });
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`rk-gate: ${err.message}\n${USAGE_GATE}\n`);
      return RC.USAGE;
    }
    throw err;
  }
  if (flags.help === true) {
    io.out(`${USAGE_GATE}\n`);
    return RC.OK;
  }
  if (flags.phase !== undefined && flags.phase !== 'open' && flags.phase !== 'close') {
    io.err(`rk-gate: --phase 只能是 open|close（收到 ${flags.phase}）\n`);
    return RC.USAGE;
  }
  const projectRoot = resolve(flags.project ?? process.cwd());
  if (!existsSync(projectRoot) || !statSync(projectRoot).isDirectory()) {
    io.err(`rk-gate: --project 不是已存在目录: ${projectRoot}\n`);
    return RC.USAGE;
  }
  const landingDir = flags.landing === undefined ? undefined : resolve(flags.landing);
  const r = reconWrite({
    projectRoot,
    landingDir,
    files: flags.file ?? null,
    phase: flags.phase ?? 'close',
  });
  const short = (h) => (typeof h === 'string' && h !== '' ? h.slice(0, 12) : '(none)');
  if (flags.json === true) {
    io.out(jsonStable({
      ok: r.ok,
      phase: r.phase,
      rulesPresent: r.present,
      source: r.source,
      patterns: r.patterns.length,
      mode: r.mode,
      scope: r.explicit ? 'explicit' : 'discover',
      scanned: r.scanned,
      selfExcludedDirs: r.selfExcluded,
      index: { lines: r.indexLines, badLines: r.indexBadLines, truncatedTail: r.indexTruncatedTail },
      counts: {
        checked: r.checked.length,
        snapshotted: r.snapshotted.length,
        unrecorded: r.unrecorded.length,
        nosnapshot: r.nosnapshot.length,
        missingOnDisk: r.missingOnDisk.length,
        skippedNotProtected: r.skipped,
        mtimeNewerThanRecord: r.mtimeAux,
      },
      violations: [...r.nosnapshot, ...r.unrecorded].map((c) => ({ path: c.path, verdict: c.verdict, sha256: c.sha256, baseline: c.baseline ?? null, recordTs: c.recordTs ?? null, matched: c.matched })),
      findings: r.findings,
    }));
    return r.ok ? RC.OK : RC.FAIL;
  }
  io.out(line(`RK_GATE_WRITE_PHASE=${r.phase}`));
  io.out(line(`RK_GATE_WRITE_RULES_PRESENT=${r.present}`));
  io.out(line(`RK_GATE_WRITE_SOURCE=${r.source}`));
  io.out(line(`RK_GATE_WRITE_PATTERNS=${r.patterns.length}`));
  io.out(line(`RK_GATE_WRITE_MODE=${r.mode}`));
  io.out(line(`RK_GATE_WRITE_SCOPE=${r.explicit ? 'explicit' : 'discover'}`));
  io.out(line(`RK_GATE_WRITE_SCANNED=${r.scanned}`));
  io.out(line(`RK_GATE_WRITE_SELF_EXCLUDED_DIRS=${r.selfExcluded}`));
  io.out(line(`RK_GATE_WRITE_INDEX_LINES=${r.indexLines} RK_GATE_WRITE_INDEX_BAD_LINES=${r.indexBadLines}`));
  io.out(line(`RK_GATE_WRITE_CHECKED=${r.checked.length}`));
  io.out(line(`RK_GATE_WRITE_SNAPSHOTTED=${r.snapshotted.length}`));
  io.out(line(`RK_GATE_WRITE_UNRECORDED=${r.unrecorded.length}`));
  io.out(line(`RK_GATE_WRITE_NOSNAPSHOT=${r.nosnapshot.length}`));
  io.out(line(`RK_GATE_WRITE_MISSING_ON_DISK=${r.missingOnDisk.length}`));
  io.out(line(`RK_GATE_WRITE_SKIPPED_NOT_PROTECTED=${r.skipped}`));
  io.out(line(`RK_GATE_WRITE_MTIME_NEWER_THAN_RECORD=${r.mtimeAux}`));
  for (const c of r.nosnapshot) io.out(line(`NOSNAPSHOT ${c.path} current=${short(c.sha256)} matched=${c.matched}`));
  for (const c of r.unrecorded) {
    io.out(line(`UNRECORDED ${c.path} current=${short(c.sha256)} baseline=${short(c.baseline)} record_ts=${c.recordTs ?? '(none)'}`));
  }
  for (const c of r.missingOnDisk) io.out(line(`MISSING_ON_DISK ${c.path} matched=${c.matched}`));
  for (const f of r.findings) io.out(line(`FINDING ${f.code} ${f.message}`));
  io.out(resultLine('GATE_WRITE', r.ok));
  return r.ok ? RC.OK : RC.FAIL;
}

/**
 * `rk-migrate`（R2 落点迁移）：老落点 `.dsh-ai/lessonflow` → 新落点 `.dsh-ai/rulekeeper`。
 * 判据：① 默认 dry-run（不动盘）② `--apply` 后**四项核对**通过才算成功 ③ 默认保留旧落点、
 *       `--remove-old` 才删且必须与 `--apply` 同用 ④ 核对不通过**一个字节都不删**。
 * 输出一律 **相对路径**（判决面禁绝对路径；与其它子命令同口径）。
 */
export function runMigrate(argv, io = defaultIo(), env = process.env) {
  let flags;
  try {
    flags = scanFlags(argv, {
      '--project': 'string', '--scope': 'string', '--landing': 'string',
      '--apply': 'boolean', '--remove-old': 'boolean', '--now': 'string', '--json': 'boolean', '--help': 'boolean',
    });
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`rk-migrate: ${err.message}\n${USAGE_MIGRATE}\n`);
      return RC.USAGE;
    }
    throw err;
  }
  if (flags.help === true) {
    io.out(`${USAGE_MIGRATE}\n`);
    return RC.OK;
  }
  const scope = flags.scope ?? 'project';
  if (scope !== 'project' && scope !== 'user') {
    io.err(`rk-migrate: --scope 只能是 project|user（收到 ${JSON.stringify(flags.scope)}）\n${USAGE_MIGRATE}\n`);
    return RC.USAGE;
  }
  const projectRoot = resolve(flags.project ?? process.cwd());
  if (scope === 'project' && (!existsSync(projectRoot) || !statSync(projectRoot).isDirectory())) {
    io.err(`rk-migrate: --project 不是已存在目录: ${projectRoot}\n`);
    return RC.USAGE;
  }
  let now = new Date();
  if (flags.now !== undefined) {
    const parsed = Date.parse(flags.now);
    if (Number.isNaN(parsed)) {
      io.err(`rk-migrate: --now 不是合法时间: ${flags.now}\n`);
      return RC.USAGE;
    }
    now = new Date(parsed);
  }
  if (flags['remove-old'] === true && flags.apply !== true) {
    io.err(`rk-migrate: --remove-old 必须与 --apply 同时使用（禁"只删不迁"）\n`);
    return RC.USAGE;
  }

  const r = migrateLanding({
    projectRoot, scope, env, landingDir: flags.landing ?? null,
    apply: flags.apply === true, removeOld: flags['remove-old'] === true, now,
  });
  const base = scope === 'user' ? dshHome(env) : projectRoot;
  const rel = (p) => toPosix(relative(base, p)) || '.';
  const rc = r.code === 'OK' ? RC.OK : (r.code === 'USAGE' ? RC.USAGE : RC.FAIL);

  if (flags.json === true) {
    io.out(jsonStable({
      ok: r.ok, mode: r.mode, scope: r.plan.scope,
      from: rel(r.plan.from), to: rel(r.plan.to), needed: r.plan.needed,
      before: r.before, after: r.after, verified: r.verified, removedOld: r.removedOld,
      reasons: r.reasons, checks: r.checks ?? null, record: r.record,
    }));
    return rc;
  }
  io.out(line(`RK_MIGRATE_MODE=${r.mode}`));
  io.out(line(`RK_MIGRATE_SCOPE=${r.plan.scope}`));
  io.out(line(`RK_MIGRATE_FROM=${rel(r.plan.from)}`));
  io.out(line(`RK_MIGRATE_TO=${rel(r.plan.to)}`));
  io.out(line(`RK_MIGRATE_NEEDED=${r.plan.needed}`));
  io.out(line(`RK_MIGRATE_FILES=${r.before.files}`));
  io.out(line(`RK_MIGRATE_BYTES=${r.before.bytes}`));
  io.out(line(`RK_MIGRATE_TREE_SHA256=${r.before.fp.slice(0, 16)}`));
  io.out(line(`RK_MIGRATE_LEDGER_LINES=${r.before.ledgerLines}`));
  io.out(line(`RK_MIGRATE_GATE_LINES=${r.before.gateLines}`));
  for (const c of r.checks ?? []) io.out(line(`CHECK ${c.name} ok=${c.ok} want=${c.want} got=${c.got}`));
  if (r.mode === 'apply') io.out(line(`RK_MIGRATE_TARGET_TREE_SHA256=${r.after.fp.slice(0, 16)}`));
  io.out(line(`RK_MIGRATE_VERIFIED=${r.verified}`));
  io.out(line(`RK_MIGRATE_REMOVED_OLD=${r.removedOld}`));
  io.out(line(`RK_MIGRATE_RECORD=${r.record === null ? '(none)' : (r.record.ok ? 'logs/migrate.jsonl' : '(failed)')}`));
  for (const reason of r.reasons) io.out(line(`REASON ${reason.split(toPosix(base)).join('.')}`));
  for (const f of r.findings ?? []) io.out(line(`FINDING ${f.code} ${f.message}`));
  io.out(resultLine('MIGRATE', r.ok));
  return rc;
}

export function runRulekeeperSub(command, argv, io = defaultIo(), env = process.env) {  const usage = SUB_USAGE[command] ?? USAGE_RULEKEEPER;
  if (argv.includes('--help') || argv.includes('-h')) {
    io.out(`${usage}\n`);
    return RC.OK;
  }
  switch (command) {
    case 'check': return runCliCheck(argv, io, env);
    case 'record': return runCliRecord(argv, io, env);
    case 'rules': return runRules(argv, io, env);
    case 'report': return runCliReport(argv, io, env);
    case 'snap': return runSnap(['take', ...argv], io, env);
    case 'gate': return runGate(argv, io, env);
    case 'redact': return runRedact(argv, io, env);
    case 'evolve': return runCliEvolve(argv, io, env);
    case 'migrate': return runMigrate(argv, io, env);
    default:
      io.err(`dsh-rulekeeper: 未知子命令 "${command}"\n`);
      return RC.USAGE;
  }
}

function parseSub(command, argv, spec, io) {
  try {
    return { flags: scanFlags(argv, spec), error: null };
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`dsh-rulekeeper ${command}: ${err.message}\n${SUB_USAGE[command] ?? ''}\n`);
      return { flags: null, error: RC.USAGE };
    }
    throw err;
  }
}

function resolveLanding(command, flags, io) {
  if (flags.landing === undefined) {
    io.err(`dsh-rulekeeper ${command}: 需要 --landing <落点>\n`);
    return { landing: null, error: RC.USAGE };
  }
  const landing = resolve(flags.landing);
  if (!existsSync(landing) || !statSync(landing).isDirectory()) {
    io.err(`dsh-rulekeeper ${command}: --landing 不是已存在目录: ${landing}\n`);
    return { landing: null, error: RC.USAGE };
  }
  return { landing, error: null };
}

/**
 * 统一的 check 判决打印（LF-250/LF-260）：`rk-check <kind>` 与 `dsh-rulekeeper check --shape` 共用**同一套 token**。
 * 教训：同一守卫若有两个入口各印一套 token（RK_CHECK_* / RK_SHAPE_*），复核者会拿两套口径对不上号，
 * 正是本会话反复踩的「两套口径」坑，故此处收敛为单一实现、单一词汇表。
 */
function emitCheckReport(report, io) {
  io.out(line(`RK_CHECK_KIND=${report.kind}`));
  io.out(line(`RK_CHECK_VERDICT=${report.verdict}`));
  for (const finding of report.findings) io.out(line(`FINDING ${finding.code} ${finding.message}`));
  io.out(line(`RK_CHECK_PATH=${report.detail.path ?? '(n/a)'}`));
  if (typeof report.detail.lines === 'number') io.out(line(`RK_CHECK_LINES=${report.detail.lines}`));
  if (typeof report.detail.maxLineLength === 'number') io.out(line(`RK_CHECK_MAXLINE=${report.detail.maxLineLength}`));
  if (typeof report.detail.sha256 === 'string') io.out(line(`RK_CHECK_SHA256=${report.detail.sha256}`));
  io.out(resultLine('CHECK_KIND', report.ok));
}

/**
 * 形态守卫的公共上下文（**两个入口共用**，避免"两套口径"）：
 *  · 冻结源：包内文件命中 `shape-baseline.json` 则取之（无命中交给守卫报 SHAPE_NO_FROZEN_SHA）
 *  · projectRoot：包内文件一律以**包根**为基准算相对路径 -> 判决与 cwd 无关；
 *    包外文件才用 `--project`/cwd（外来 cwd 下曾让两个入口输出不同，被 cwd 用例抓到）
 */
function shapeGuardContext(file, flags) {
  const fixtures = loadShapeBaseline();
  const key = shapeBaselineKey(file);
  return {
    baseline: (fixtures !== null && key !== null && Object.hasOwn(fixtures, key)) ? fixtures[key] : null,
    projectRoot: key !== null ? PKG_ROOT : resolve(flags.project ?? process.cwd()),
  };
}

/**
 * `uncheckable` 声明的公共上下文（`rk-check uncheckable` 与 `dsh-rulekeeper check --uncheckable` **共用**）：
 * 单点实现，避免两个入口各自解析 `--now/--max-days/--landing` 而出现两套口径（L474 的老坑）。
 * @returns {{ctx: object|null, message: string|null}}
 */
function uncheckableContext(flags) {
  let now = new Date();
  if (flags.now !== undefined) {
    now = new Date(flags.now);
    if (Number.isNaN(now.getTime())) return { ctx: null, message: `--now 不是合法时间（收到 ${JSON.stringify(flags.now)}）` };
  }
  let maxDays;
  if (flags['max-days'] !== undefined) {
    if (!/^\d+$/.test(flags['max-days'])) return { ctx: null, message: `--max-days 需要非负整数（收到 ${JSON.stringify(flags['max-days'])}）` };
    maxDays = Number(flags['max-days']);
  }
  let landingDir = null;
  if (flags.landing !== undefined) {
    landingDir = resolve(flags.landing);
    if (!existsSync(landingDir)) return { ctx: null, message: `--landing 不是已存在目录: ${landingDir}` };
  }
  return { ctx: { now, maxDays, landingDir, rule: flags.rule ?? null }, message: null };
}

function runCliCheck(argv, io, env) {
  const parsed = parseSub('check', argv, {
    '--landing': 'string', '--project': 'string', '--strict': 'boolean', '--json': 'boolean',
    '--shape': 'string', '--lines': 'string', '--maxline': 'string', '--sha256': 'string',
    '--uncheckable': 'string', '--now': 'string', '--max-days': 'string', '--rule': 'string',
  }, io);
  if (parsed.error !== null) return parsed.error;
  // LF-2A0：`check --uncheckable <声明.json>` 是"先于判定"的入口（与 --shape 互斥）
  if (parsed.flags.uncheckable !== undefined) {
    if (parsed.flags.shape !== undefined) {
      io.err('dsh-rulekeeper check: --uncheckable 与 --shape 互斥（一个是不可机检实证，一个是形态守卫）\n');
      return RC.USAGE;
    }
    const declFile = resolve(parsed.flags.uncheckable);
    if (!existsSync(declFile)) {
      io.err(`dsh-rulekeeper check: --uncheckable 声明不存在: ${declFile}\n`);
      return RC.USAGE;
    }
    const resolved = uncheckableContext(parsed.flags);
    if (resolved.message !== null) {
      io.err(`dsh-rulekeeper check: ${resolved.message}\n`);
      return RC.USAGE;
    }
    const report = runCheckKind('uncheckable_justified', {
      file: declFile,
      projectRoot: resolve(parsed.flags.project ?? process.cwd()),
      ...resolved.ctx,
    });
    if (parsed.flags.json === true) io.out(jsonStable(report));
    else emitCheckReport(report, io);
    return report.ok ? RC.OK : RC.FAIL;
  }
  // LF-260：check --shape 只是形态守卫的入口（阈值随冻结夹具 sha256 校验）
  if (parsed.flags.shape !== undefined) {
    if (parsed.flags.landing !== undefined) {
      io.err('dsh-rulekeeper check: --shape 与 --landing 互斥（一个是形态守卫，一个是落点体检）\n');
      return RC.USAGE;
    }
    const file = resolve(parsed.flags.shape);
    if (!existsSync(file)) {
      io.err(`dsh-rulekeeper check: --shape 文件不存在: ${file}\n`);
      return RC.USAGE;
    }
    if (parsed.flags.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(parsed.flags.sha256)) {
      io.err(`dsh-rulekeeper check: --sha256 需要 64 位小写十六进制（收到 ${JSON.stringify(parsed.flags.sha256)}）\n`);
      return RC.USAGE;
    }
    const asCount = (flagName, raw) => {
      if (raw === undefined) return undefined;
      if (!/^\d+$/.test(raw)) throw new UsageError(`${flagName} 需要非负整数（收到 ${JSON.stringify(raw)}）`);
      return Number(raw);
    };
    let report;
    try {
      report = runCheckKind('shape_guard', {
        file,
        ...shapeGuardContext(file, parsed.flags),
        expectLines: asCount('--lines', parsed.flags.lines),
        expectMaxLineLength: asCount('--maxline', parsed.flags.maxline),
        frozenSha256: parsed.flags.sha256,
      });
    } catch (err) {
      if (err instanceof UsageError) {
        io.err(`dsh-rulekeeper check: ${err.message}\n`);
        return RC.USAGE;
      }
      io.err(`dsh-rulekeeper check: 内部错误: ${err?.message ?? String(err)}\n`);
      return RC.FAIL;
    }
    if (parsed.flags.json === true) io.out(jsonStable(report));
    else emitCheckReport(report, io);
    return report.ok ? RC.OK : RC.FAIL;
  }
  const target = resolveLanding('check', parsed.flags, io);
  if (target.error !== null) return target.error;
  const landing = target.landing;
  const projectRoot = resolve(parsed.flags.project ?? process.cwd());
  const docReport = doctor({ landingDir: landing, projectRoot });
  const ledger = ledgerSummary(landing);
  const emptyRule = readLedger(landing).values.filter((e) => typeof e.rule !== 'string' || e.rule.trim() === '').length;
  if (parsed.flags.json === true) {
    io.out(jsonStable({ landing, ledger, emptyRule, doctor: docReport }));
  } else {
    io.out(line(`RK_CHECK_LANDING=${landing}`));
    io.out(line(`RK_CHECK_LEDGER_ENTRIES=${ledger.entries}`));
    io.out(line(`RK_CHECK_LEDGER_BAD_LINES=${ledger.badLines}`));
    io.out(line(`RK_CHECK_LEDGER_EMPTY_RULE=${emptyRule}`));
    io.out(line(`RK_CHECK_RULES=${ledger.rules.length}`));
    for (const finding of docReport.findings) io.out(line(`FINDING ${finding.level.toUpperCase()} ${finding.code} ${finding.msg}`));
    io.out(line(`RK_CHECK_ERRORS=${docReport.findings.filter((f) => f.level === 'error').length}`));
  }
  const rc = doctorExitCode(docReport, parsed.flags.strict === true);
  io.out(resultLine('CHECK', rc === 0));
  return rc === 0 ? RC.OK : RC.FAIL;
}

function runCliRecord(argv, io, env) {
  const parsed = parseSub('record', argv, {
    '--landing': 'string', '--rule': 'string', '--category': 'string', '--problem': 'string',
    '--root-cause': 'string', '--solution': 'string', '--mechanism': 'string', '--evidence': 'string', '--now': 'string',
  }, io);
  if (parsed.error !== null) return parsed.error;
  const flags = parsed.flags;
  const target = resolveLanding('record', flags, io);
  if (target.error !== null) return target.error;
  const missing = ['rule', 'problem', 'root-cause', 'solution'].filter((k) => flags[k] === undefined);
  if (missing.length > 0) {
    io.err(`dsh-rulekeeper record: 缺少必填参数 ${missing.map((k) => `--${k}`).join(' ')}\n${SUB_USAGE.record}\n`);
    return RC.USAGE;
  }
  let now;
  try {
    now = resolveNow({ argv, env }).date;
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`dsh-rulekeeper record: ${err.message}\n`);
      return RC.USAGE;
    }
    throw err;
  }
  const evidence = flags.evidence === undefined ? [] : flags.evidence.split(',').map((s) => s.trim()).filter((s) => s !== '');
  const result = record({
    rule: flags.rule,
    category: flags.category ?? '未分类',
    problem: flags.problem,
    root_cause: flags['root-cause'],
    solution: flags.solution,
    mechanism: flags.mechanism ?? 'text',
    evidence,
  }, { landingDir: target.landing, now });
  if (!result.ok) {
    io.err(`dsh-rulekeeper record: 写入失败: ${result.reason}\n`);
    return RC.FAIL;
  }
  io.out(line(`RK_RECORD_ID=${result.entry.id}`));
  io.out(line(`RK_RECORD_RULE=${result.entry.rule}`));
  io.out(line(`RK_RECORD_BYTES=${result.bytes}`));
  io.out(resultLine('RECORD', true));
  return RC.OK;
}

function runCliReport(argv, io, env) {
  const parsed = parseSub('report', argv, { '--landing': 'string', '--project': 'string', '--now': 'string', '--json': 'boolean' }, io);
  if (parsed.error !== null) return parsed.error;
  const target = resolveLanding('report', parsed.flags, io);
  if (target.error !== null) return target.error;
  let now;
  try {
    now = resolveNow({ argv, env });
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`dsh-rulekeeper report: ${err.message}\n`);
      return RC.USAGE;
    }
    throw err;
  }
  const landing = target.landing;
  const projectRoot = resolve(parsed.flags.project ?? process.cwd());
  const ledger = ledgerSummary(landing);
  const docReport = doctor({ landingDir: landing, projectRoot });
  const loaded = loadLandingRules(landing);
  const effective = effectiveConfig({ rules: loaded.rulesResult.rules, config: loaded.config });
  const payload = {
    now: now.iso,
    fixed: now.fixed,
    landing,
    ledger: { entries: ledger.entries, badLines: ledger.badLines, truncatedTail: ledger.truncatedTail, rules: ledger.rules.length, totalRecurrence: ledger.totalRecurrence },
    doctor: { errors: docReport.findings.filter((f) => f.level === 'error').length, warns: docReport.findings.filter((f) => f.level === 'warn').length, infos: docReport.findings.filter((f) => f.level === 'info').length, nonPathEvidence: docReport.summary.nonPathEvidence },
    effective,
  };
  if (parsed.flags.json === true) {
    io.out(jsonStable(payload));
  } else {
    io.out(line(`RK_REPORT_NOW=${payload.now}`));
    io.out(line(`RK_REPORT_FIXED=${payload.fixed}`));
    io.out(line(`RK_REPORT_LANDING=${landing}`));
    io.out(line(`RK_REPORT_LEDGER_ENTRIES=${payload.ledger.entries}`));
    io.out(line(`RK_REPORT_LEDGER_RULES=${payload.ledger.rules}`));
    io.out(line(`RK_REPORT_DOCTOR_ERRORS=${payload.doctor.errors}`));
    io.out(line(`RK_REPORT_DOCTOR_WARNS=${payload.doctor.warns}`));
    io.out(line(`RK_REPORT_MODE=${payload.effective.mode}`));
    io.out(line(`RK_REPORT_PROTECTED=${payload.effective.protected_paths.length}`));
  }
  io.out(resultLine('REPORT', true));
  return RC.OK;
}

// ── LF-250 / LF-260：可机检 check 的 CLI 入口（rk-check） ─────────────────────
const CHECK_ALIASES = Object.freeze({
  'untracked-change': 'file_untracked_change',
  file_untracked_change: 'file_untracked_change',
  'output-shape': 'output_shape',
  output_shape: 'output_shape',
  'invalid-reference': 'invalid_reference',
  invalid_reference: 'invalid_reference',
  shape: 'shape_guard',
  shape_guard: 'shape_guard',
  uncheckable: 'uncheckable_justified',
  uncheckable_justified: 'uncheckable_justified',
});

/** `rk-check expect --file <实际判决 json> --expected <expected/<name>.json>`：逐字比对（LF-250 判据载体） */
function runCheckExpect(argv, io) {
  let flags;
  try {
    flags = scanFlags(argv, { '--file': 'string', '--expected': 'string' });
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`rk-check: ${err.message}\n${USAGE_CHECK}\n`);
      return RC.USAGE;
    }
    throw err;
  }
  if (flags.help) {
    io.out(`${USAGE_CHECK}\n`);
    return RC.OK;
  }
  if (flags.file === undefined || flags.expected === undefined) {
    io.err('rk-check: expect 需要 --file <实际判决 json> 与 --expected <基准 json>\n');
    return RC.USAGE;
  }
  if (!existsSync(flags.file)) {
    io.err(`rk-check: --file 不存在: ${resolve(flags.file)}\n`);
    return RC.USAGE;
  }
  const report = compareWithExpected(readFileSync(resolve(flags.file), 'utf8'), resolve(flags.expected));
  io.out(line(`RK_EXPECT_ACTUAL=${toPosix(resolve(flags.file))}`));
  io.out(line(`RK_EXPECT_BASELINE=${toPosix(resolve(flags.expected))}`));
  if (!report.ok) io.out(line(`FINDING EXPECT_MISMATCH ${report.reason}`));
  io.out(resultLine('EXPECT', report.ok));
  return report.ok ? RC.OK : RC.FAIL;
}

export function runCheck(argv, io = defaultIo(), env = process.env) {
  const sub = argv[0] ?? null;
  if (sub === '--help' || sub === '-h' || sub === null) {
    io.out(`${USAGE_CHECK}\n`);
    return sub === null ? RC.USAGE : RC.OK;
  }
  if (sub === 'expect') return runCheckExpect(argv.slice(1), io);
  const kind = CHECK_ALIASES[sub];
  if (kind === undefined) {
    io.err(`rk-check: 未知子命令 "${sub}"（可选 ${Object.keys(CHECK_ALIASES).join('|')}）\n${USAGE_CHECK}\n`);
    return RC.USAGE;
  }
  let flags;
  try {
    flags = scanFlags(argv.slice(1), {
      '--file': 'string', '--landing': 'string', '--project': 'string', '--scope': 'string',
      '--min-lines': 'string', '--max-lines': 'string', '--max-line-length': 'string',
      '--result-line-pattern': 'string', '--lines': 'string', '--maxline': 'string',
      '--sha256': 'string', '--json': 'boolean', '--measure': 'boolean',
      '--now': 'string', '--max-days': 'string', '--rule': 'string',
    });
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`rk-check: ${err.message}\n${USAGE_CHECK}\n`);
      return RC.USAGE;
    }
    throw err;
  }
  if (flags.help) {
    io.out(`${USAGE_CHECK}\n`);
    return RC.OK;
  }
  if (flags.file === undefined) {
    io.err(`rk-check: ${sub} 需要 --file <文件>\n${USAGE_CHECK}\n`);
    return RC.USAGE;
  }
  const file = resolve(flags.file);
  if (!existsSync(file)) {
    io.err(`rk-check: --file 不存在: ${file}\n`);
    return RC.USAGE;
  }
  if (flags.measure === true) {
    let measured;
    try {
      measured = measureFile(file);
    } catch (err) {
      io.err(`rk-check: --measure 失败: ${err?.message ?? String(err)}\n`);
      return RC.FAIL;
    }
    // 注：--measure 是本机工具输出，path 为 posix 绝对形态（与判决 JSON 的相对化口径**不同**，勿混用）
    io.out(jsonStable({ path: toPosix(file), ...measured }));
    return RC.OK;
  }
  // 阈值一律**严格解析**：非数字/负数/小数 -> rc=2 用法错误。
  // 旧实现用 Number(v) + Number.isInteger，'abc'->NaN 被静默丢弃 -> "什么都没检"也输出 pass（假绿，复核 B2）。
  const projectRoot = resolve(flags.project ?? process.cwd());
  const asCount = (flagName, raw) => {
    if (raw === undefined) return undefined;
    if (!/^\d+$/.test(raw)) throw new UsageError(`${flagName} 需要非负整数（收到 ${JSON.stringify(raw)}）`);
    return Number(raw);
  };
  let report;
  try {
    switch (kind) {
    case 'file_untracked_change':
      if (flags.landing === undefined) {
        io.err('rk-check: untracked-change 需要 --landing <落点>\n');
        return RC.USAGE;
      }
      // --project 必填：快照里记的是**相对项目根**的 path，缺省拿 cwd 顶替会让同一文件同一快照
      // 红/绿两判（复核 B5）。宁可 rc=2 也不做口径分裂。
      if (flags.project === undefined) {
        io.err('rk-check: untracked-change 需要 --project <项目根>（快照 path 以项目根为基准）\n');
        return RC.USAGE;
      }
      report = runCheckKind(kind, { file, landingDir: resolve(flags.landing), projectRoot });
      break;
    case 'output_shape':
      report = runCheckKind(kind, {
        file,
        projectRoot,
        expect: {
          minLines: asCount('--min-lines', flags['min-lines']),
          maxLines: asCount('--max-lines', flags['max-lines']),
          maxLineLength: asCount('--max-line-length', flags['max-line-length']),
          resultLinePattern: flags['result-line-pattern'],
        },
      });
      break;
    case 'invalid_reference':
      report = runCheckKind(kind, {
        file,
        projectRoot,
        scopeFile: flags.scope === undefined ? undefined : resolve(flags.scope),
      });
      break;
    case 'shape_guard': {
      // `--sha256` 只接受 64 位小写 hex（写错不许静默关闭漂移检查）
      if (flags.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(flags.sha256)) {
        io.err(`rk-check: --sha256 需要 64 位小写十六进制（收到 ${JSON.stringify(flags.sha256)}）\n`);
        return RC.USAGE;
      }
      // 冻结值来源：显式 --sha256 > 包内冻结源 shape-baseline.json（复核 B4：仓内必须有实体，否则漂移拦不住）
      report = runCheckKind(kind, {
        file,
        projectRoot,
        expectLines: asCount('--lines', flags.lines),
        expectMaxLineLength: asCount('--maxline', flags.maxline),
        frozenSha256: flags.sha256,
        ...shapeGuardContext(file, flags),
      });
      break;
    }
    case 'uncheckable_justified': {
      // LF-2A0：`--now` 保证"是否过期"可复现；`--landing` 用于"再复发即失效"
      const resolved = uncheckableContext(flags);
      if (resolved.message !== null) throw new UsageError(resolved.message);
      report = runCheckKind(kind, { file, projectRoot, ...resolved.ctx });
      break;
    }
    default:
      io.err(`rk-check: 未知 check: ${kind}\n`);
      return RC.USAGE;
    }
  } catch (err) {
    // 阈值解析/内部错误一律转成明确 rc，绝不裸抛（bin 薄壳里带栈的异常会让 stdout 为空、rc=1 与 violation 混淆）
    if (err instanceof UsageError) {
      io.err(`rk-check: ${err.message}\n${USAGE_CHECK}\n`);
      return RC.USAGE;
    }
    io.err(`rk-check: 内部错误: ${err?.message ?? String(err)}\n`);
    return RC.FAIL;
  }
  if (flags.json === true) {
    io.out(jsonStable(report));
    return report.ok ? RC.OK : RC.FAIL;
  }
  emitCheckReport(report, io);
  return report.ok ? RC.OK : RC.FAIL;
}

/**
 * `dsh-rulekeeper evolve`（LF-280/290/295）：复发 ≥2 → 提案，**只写 proposals/**。
 *
 * 判据口径（写进凭证）：
 *   · LF-280：打印 rules.json 的 sha256 before/after + `RK_EVOLVE_RULES_UNCHANGED=true`
 *   · LF-290：`RK_EVOLVE_CANDIDATES` / `RK_EVOLVE_PROPOSALS` + 每个提案一行 `PROPOSAL … path=proposals/<id>.json`
 *   · LF-295：`FINDING PROPOSAL_QUALITY_MISSING …` / `FINDING PROPOSAL_GATE_ESCALATION_REQUIRES_HUMAN …` + exit=1
 */
function runCliEvolve(argv, io, env) {
  const parsed = parseSub('evolve', argv, {
    '--landing': 'string', '--project': 'string', '--quality': 'string', '--source': 'string',
    '--escalate-gate': 'boolean', '--rule': 'string', '--dry-run': 'boolean',
    '--red-criteria': 'string', '--counter-example': 'string', '--false-positive-surface': 'string',
    '--activation-check': 'string',
    '--now': 'string', '--json': 'boolean',
  }, io);
  if (parsed.error !== null) return parsed.error;
  const target = resolveLanding('evolve', parsed.flags, io);
  if (target.error !== null) return target.error;
  const landing = target.landing;
  const source = parsed.flags.source ?? 'auto';
  if (!['auto', 'human'].includes(source)) {
    io.err(`dsh-rulekeeper evolve: --source 只能是 auto|human（收到 ${JSON.stringify(source)}）\n${SUB_USAGE.evolve}\n`);
    return RC.USAGE;
  }
  const now = parsed.flags.now === undefined ? new Date() : new Date(parsed.flags.now);
  if (Number.isNaN(now.getTime())) {
    io.err(`dsh-rulekeeper evolve: --now 不是合法时间: ${parsed.flags.now}\n`);
    return RC.USAGE;
  }
  // 落点必须先 init（config.json 在位且 mode 合法）：否则 loadConfig 是 throw 语义 ->
  // 复核 B1 实测会以 7 行调用栈裸抛（LF-250/260 修过的"不裸抛"被新子命令带回来了）
  const configPath = resolve(landing, 'config.json');
  if (!existsSync(configPath)) {
    io.err(`dsh-rulekeeper evolve: 落点未初始化（缺 config.json）: ${toPosix(configPath)}；先跑 dsh-rulekeeper init\n`);
    return RC.USAGE;
  }
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    if (cfg === null || typeof cfg !== 'object' || !MODES.includes(cfg.mode)) {
      io.err(`dsh-rulekeeper evolve: config.json 的 mode 非法（收到 ${JSON.stringify(cfg?.mode)}，可选 ${MODES.join('|')}）: ${toPosix(configPath)}\n`);
      return RC.USAGE;
    }
  } catch (err) {
    io.err(`dsh-rulekeeper evolve: config.json 不是合法 JSON: ${err?.message ?? String(err)}\n`);
    return RC.USAGE;
  }
  // 质量要件：显式提供（文件 + 单条 CLI 覆盖）
  let quality = {};
  if (parsed.flags.quality !== undefined) {
    const qPath = resolve(parsed.flags.quality);
    if (!existsSync(qPath)) {
      io.err(`dsh-rulekeeper evolve: --quality 文件不存在: ${qPath}\n`);
      return RC.USAGE;
    }
    try {
      const loaded = JSON.parse(readFileSync(qPath, 'utf8'));
      if (loaded === null || typeof loaded !== 'object' || Array.isArray(loaded)) throw new Error('顶层必须是对象');
      quality = loaded;
    } catch (err) {
      io.err(`dsh-rulekeeper evolve: --quality 不是合法 JSON 对象: ${err?.message ?? String(err)}\n`);
      return RC.USAGE;
    }
  }
  const PER_FIELD_FLAGS = [['red-criteria', 'redCriteria'], ['counter-example', 'counterExample'],
    ['false-positive-surface', 'falsePositiveSurface'], ['activation-check', 'activationCheck']];
  const givenFields = PER_FIELD_FLAGS.filter(([key]) => parsed.flags[key] !== undefined);
  if (givenFields.length > 0 && parsed.flags.rule === undefined) {
    // 禁静默丢弃：逐字段要件必须说明是哪条纪律（复核 B2 实测：不带 --rule 时四个 flag 被整体丢掉，用户却看到"缺四要件"）
    io.err(`dsh-rulekeeper evolve: 给了 ${givenFields.map(([key]) => `--${key}`).join('/')} 就必须同时给 --rule <纪律>（否则要件不知道该挂到哪条纪律上）\n${SUB_USAGE.evolve}\n`);
    return RC.USAGE;
  }
  if (parsed.flags.rule !== undefined) {
    const overrides = {};
    for (const [key, field] of PER_FIELD_FLAGS) {
      // 注意：scanFlags 的键**不含** `--` 前缀（实测踩过：带前缀取值为 undefined -> 要件静默丢失）
      if (parsed.flags[key] !== undefined) overrides[field] = parsed.flags[key];
    }
    // 键必须用 **canonical** 形：evolve 内部按 canonical 取 quality，用原始串作键会让
    // `--rule fact-writing` 的覆盖静默失效（复核 B2 实测：AC-OVERRIDE 被文件值吃掉）
    const key = canonicalRule(parsed.flags.rule);
    const base = quality[key] ?? quality[parsed.flags.rule] ?? {};
    quality = { ...quality, [key]: { ...base, ...overrides } };
  }

  const rulesPath = rulesPathOf(landing);
  const rulesPresent = existsSync(rulesPath);
  const shaBefore = fileSha256(rulesPath);
  let report;
  try {
    report = runEvolve({
      landingDir: landing,
      now,
      source,
      quality,
      escalateGate: parsed.flags['escalate-gate'] === true,
      rule: parsed.flags.rule ?? null,
      dryRun: parsed.flags['dry-run'] === true,
    });
  } catch (err) {
    // 兜底：任何未预期异常都转成受控 rc（绝不把栈留给调用方）
    if (parsed.flags.json === true) {
      io.out(jsonStable({ landing, findings: [{ code: 'EVOLVE_INTERNAL_ERROR', message: err?.message ?? String(err) }], ok: false }));
    } else {
      io.out(line(`FINDING EVOLVE_INTERNAL_ERROR ${err?.message ?? String(err)}`));
    }
    io.err(`dsh-rulekeeper evolve: 内部错误: ${err?.message ?? String(err)}\n`);
    return RC.FAIL;
  }
  const shaAfter = fileSha256(rulesPath);
  const rulesUnchanged = shaBefore === shaAfter;

  if (parsed.flags.json === true) {
    io.out(jsonStable({
      landing, mode: report.mode, ledgerEntries: report.ledgerEntries, ledgerHealth: report.ledgerHealth,
      candidates: report.candidates,
      proposals: report.proposals.map((p) => ({ id: p.id, rule: p.rule, count: p.count, path: p.written ? p.path : null, bytes: p.bytes })),
      skipped: report.skipped, findings: report.findings, dryRun: report.dryRun,
      rulesPresent, rulesSha256Before: shaBefore, rulesSha256After: shaAfter, rulesUnchanged, ok: report.ok && rulesUnchanged,
    }));
    return (report.ok && rulesUnchanged) ? RC.OK : RC.FAIL;
  }
  io.out(line(`RK_EVOLVE_LANDING=${toPosix(landing)}`));
  io.out(line(`RK_EVOLVE_MODE=${report.mode}`));
  io.out(line(`RK_EVOLVE_LEDGER_ENTRIES=${report.ledgerEntries}`));
  io.out(line(`RK_EVOLVE_LEDGER_BAD_LINES=${report.ledgerHealth.badLines}`));
  io.out(line(`RK_EVOLVE_LEDGER_TRUNCATED_TAIL=${report.ledgerHealth.truncatedTail}`));
  io.out(line(`RK_EVOLVE_LEDGER_OVERSIZED=${report.ledgerHealth.oversized}`));
  io.out(line(`RK_EVOLVE_LEDGER_MISSING=${report.ledgerHealth.missing}`));
  io.out(line(`RK_EVOLVE_CANDIDATES=${report.candidates.length}`));
  io.out(line(`RK_EVOLVE_PROPOSALS=${report.proposals.length}`));
  io.out(line(`RK_EVOLVE_SKIPPED=${report.skipped.length}`));
  io.out(line(`RK_EVOLVE_DRY_RUN=${report.dryRun}`));
  for (const p of report.proposals) {
    io.out(line(`PROPOSAL ${p.id} rule=${p.rule} count=${p.count} distinctProblems=${p.distinctProblems ?? 0} status=proposed path=${p.written ? `proposals/${p.id}.json` : '(dry-run)'} bytes=${p.bytes}`));
  }
  for (const s of report.skipped) io.out(line(`SKIPPED ${s.rule} count=${s.count} reason=${s.reason} distinctProblems=${s.distinctProblems ?? 0}`));
  for (const f of report.findings) io.out(line(`FINDING ${f.code} ${f.message}`));
  io.out(line(`RK_EVOLVE_RULES_PRESENT=${rulesPresent}`));
  io.out(line(`RK_EVOLVE_RULES_SHA256_BEFORE=${shaBefore ?? '(no-rules-file)'}`));
  io.out(line(`RK_EVOLVE_RULES_SHA256_AFTER=${shaAfter ?? '(no-rules-file)'}`));
  // 无 rules.json 时"没变"是**空判**（null===null）——显式标 n/a，别让它冒充"证明没被动过"（复核 S2）
  io.out(line(`RK_EVOLVE_RULES_UNCHANGED=${rulesPresent ? String(rulesUnchanged) : '(n/a:no-rules-file)'}`));
  const ok = report.ok && rulesUnchanged;
  io.out(resultLine('EVOLVE', ok));
  return ok ? RC.OK : RC.FAIL;
}

/**
 * `rk-crossplat`（LF-2D0）：三层跨平台判据。
 *   L1 结构（LF/BOM/零依赖/engines/import 大小写）· L2 归一文本 diff 必须 0 行 · L3-Windows 同机逐字
 *   L3-跨平台：**不做**（无 Linux 载体）——显式标 false + 原因，并对"声称在别的平台验证过"判红。
 */
export function runCrossplat(argv, io = defaultIo(), env = process.env) {
  let flags;
  try {
    flags = scanFlags(argv, {
      '--project': 'string', '--now': 'string', '--claim-platform': 'string', '--claim-linux': 'string',
      '--no-normalize': 'boolean', '--inject-now-diff': 'boolean', '--hooks': 'boolean', '--bash': 'string',
      '--json': 'boolean', '--help': 'boolean',
    });
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`rk-crossplat: ${err.message}\n${USAGE_CROSSPLAT}\n`);
      return RC.USAGE;
    }
    throw err;
  }
  if (flags.help === true || argv.length === 0) {
    io.out(`${USAGE_CROSSPLAT}\n`);
    return flags.help === true ? RC.OK : RC.USAGE;
  }
  const projectRoot = resolve(flags.project ?? process.cwd());
  const nowIso = flags.now ?? '2026-09-14T00:00:00.000Z';
  if (Number.isNaN(Date.parse(nowIso))) {
    io.err(`rk-crossplat: --now 不是合法时间: ${nowIso}\n`);
    return RC.USAGE;
  }
  const findings = [];

  // ── L1 结构 ──────────────────────────────────────────────────────────
  const l1 = structuralChecks({ pkgRoot: PKG_ROOT });
  for (const f of l1.findings) findings.push(f);

  // ── L2 归一文本：本机侧 ∥ "另一平台侧"（后者是把本机输出按 Linux 形态**模拟**改写） ──
  const captureEnv = (projectArg, nowArg = nowIso) => {
    let out = '';
    const rc = runEnv(['--project', projectArg, '--now', nowArg], { out: (t) => { out += String(t); }, err: () => {} }, {});
    return { rc, out };
  };
  const nativeForm = projectRoot;
  const posixForm = toPosix(projectRoot);
  const sideA = captureEnv(nativeForm);
  let sideB = simulateOtherSide(sideA.out, { root: projectRoot, eol: '\r\n' });
  if (flags['inject-now-diff'] === true) {
    // 取证开关：把另一侧的时间戳改成不同值 —— 因为**时间戳不在归一面内**，L2 必须因此红
    sideB = sideB.replace(/RK_ENV_NOW=[^\r\n]*/, 'RK_ENV_NOW=2026-09-14T09:09:09.000Z');
  }
  const roots = [projectRoot, posixForm, '<LINUX_ROOT>'];
  const cmp = compareNormalized(sideA.out, sideB, { roots });
  const cmpRaw = compareNormalized(sideA.out, sideB, { roots: [] });
  const useNormalize = flags['no-normalize'] !== true;
  const l2Ok = sideA.rc === RC.OK && (useNormalize ? cmp.identical : cmpRaw.identical);
  if (!l2Ok) {
    const shown = useNormalize ? cmp : cmpRaw;
    findings.push({
      code: 'CROSSPLAT_L2_DIFF',
      message: `两侧输出${useNormalize ? '归一后' : '（未归一）'}仍有 ${shown.diff.length} 行差异（例：第 ${shown.diff[0]?.line ?? '-'} 行）`,
    });
  }
  if (cmpRaw.identical) {
    // 仪器自检：若"未归一时完全相同"，说明 L2 的归一这一步在判据里毫无作用（假绿）
    findings.push({ code: 'CROSSPLAT_L2_NORMALIZE_VACUOUS', message: '未归一时两侧已逐行相同 -> 归一步骤在判据里是摆设（模拟侧改写失效）' });
  }

  // ── L3-Windows 同机逐字（同命令两次） ────────────────────────────────
  const l3win = windowsByteIdentical({ run: () => captureEnv(nativeForm).out });
  if (!l3win.identical) findings.push({ code: 'CROSSPLAT_L3_WINDOWS_DIFF', message: '同机两次运行输出不逐字相同' });

  // ── 仪器自检（正对照）：改 1 字节必须被发现；只差 CR/斜杠/前缀必须视为相同 ──
  const comparator = verifyComparator();
  for (const c of comparator.cases) {
    if (!c.ok) findings.push({ code: 'CROSSPLAT_COMPARATOR_SELFTEST', message: `比对仪器自检失败：${c.name}（期望 identical=${c.expectIdentical} 实得 ${c.actualIdentical}）` });
  }

  // ── 注入式双平台纯函数层 + EOL ───────────────────────────────────────
  const injected = injectedPureFunctionCases();
  for (const c of injected.cases) {
    if (!c.ok) findings.push({ code: 'CROSSPLAT_INJECTED_PURE', message: `双写法纯函数不一致：${c.name}（${JSON.stringify(c.a)} vs ${JSON.stringify(c.b)}）` });
  }
  const eol = injectedEolCases();
  for (const c of eol.cases) {
    if (!c.ok) findings.push({ code: 'CROSSPLAT_INJECTED_EOL', message: `EOL 注入用例失败：${c.name}（${c.detail}）` });
  }

  // ── L3 跨平台：如实声明不做 + 防假绿 ─────────────────────────────────
  const guard = fakePlatformGuard({ claim: flags['claim-platform'] });
  if (!guard.ok) findings.push(guard.finding);

  // ── L4 门禁跨平台（LF-560，`--hooks` 才跑）：hook 形态 + Git Bash 语义 + 防"Linux 已验证"假绿 ──
  let l4 = null;
  let probe = null;
  if (flags.hooks === true) {
    const tmp = join(tmpdir(), `lf-hookchk-${process.pid}-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    try {
      // install 要求"是 git 仓库"（它要设 core.hooksPath）⇒ 先 init 一个临时仓（不提交、随时删）
      const init = defaultRunGitRaw(tmp, ['init', '-q', '-b', 'main', '.']);
      if (init.ok !== true) findings.push({ code: 'CROSSPLAT_L4_INSTALL', message: `L4 前置失败（临时仓 git init）: ${init.stderr || init.error || ''}` });
      const inst = installHooks({ repoRoot: tmp, gateBin: join(PKG_ROOT, 'bin', 'rk-gate.mjs'), setConfig: false });
      if (inst.ok !== true) findings.push({ code: 'CROSSPLAT_L4_INSTALL', message: `L4 前置失败（装不了 hook 到临时仓）: ${(inst.reasons ?? []).join('; ')}` });
      const files = [
        { relPath: `.githooks/pre-commit`, absPath: join(tmp, '.githooks', 'pre-commit'), role: 'hook' },
        { relPath: `.githooks/post-commit`, absPath: join(tmp, '.githooks', 'post-commit'), role: 'hook' },
        { relPath: `${LANDING_REL}/hook.mjs`, absPath: join(tmp, '.dsh-ai', LANDING_DIRNAME, 'hook.mjs'), role: 'runner' },
      ];
      l4 = hookArtifactChecks({ files, bashPath: flags.bash ?? GIT_BASH_DEFAULT });
      for (const c of l4.cases) {
        if (!c.ok) findings.push({ code: 'CROSSPLAT_L4_HOOK', message: `门禁生成物跨平台形态不合规：${c.name}（${c.detail}）` });
      }
      probe = gitBashProbe({ bashPath: flags.bash ?? GIT_BASH_DEFAULT });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    const linuxGuard = fakeLinuxClaimGuard({ claim: flags['claim-linux'], probe });
    if (!linuxGuard.ok) findings.push(linuxGuard.finding);
    if (probe.available !== true) {
      findings.push({ code: 'CROSSPLAT_L4_NO_BASH', message: `L4 需要 Git Bash（POSIX shell 语义）才能验证 shebang/CRLF/可执行位，但探针不可用: ${probe.bashPath}` });
    }
  }

  const ok = findings.length === 0;
  if (flags.json === true) {
    io.out(jsonStable({
      ok,
      l1: { ok: l1.ok, files: l1.files, crlfFiles: l1.crlfFiles.length, bomFiles: l1.bomFiles.length, caseMismatches: l1.caseMismatches.length, missingImports: l1.missingImports.length, dependencies: l1.dependencies, type: l1.type, engines: l1.engines },
      // ㉒：判决类输出不得含 cwd 派生的绝对路径 -> 两种写法只报"是不是同一种写法"，不报具体路径
      l2: { ok: l2Ok, normalize: useNormalize, normalizedDiffLines: cmp.diff.length, rawDiffLines: cmpRaw.diff.length, formsDiffer: nativeForm !== posixForm },
      l4: l4 === null ? null : {
        ok: l4.ok,
        // ㉒：判决类输出里不放盘符绝对路径 —— 只报"是不是 bash / 什么版本"（版本足以标识被测载体）
        bash: { present: probe === null ? false : probe.available === true, name: basename(l4.bashPath), version: probe === null ? null : probe.bashVersion },
        cases: l4.cases.map((c) => ({ name: c.name, ok: c.ok, detail: c.detail })),
        probe: probe === null ? null : { available: probe.available, uname: probe.uname, bashVersion: probe.bashVersion, nodePath: probe.nodePath, nodePlatform: probe.nodePlatform, isWindowsNode: probe.isWindowsNode },
        linuxCarrier: { done: LINUX_CARRIER_DONE, reason: LINUX_CARRIER_REASON },
      },
      l3Windows: { identical: l3win.identical, shas: l3win.shas },
      l3Cross: { done: L3_CROSS_DONE, reason: L3_CROSS_REASON },
      comparator: { ok: comparator.ok, cases: comparator.cases.map((c) => ({ name: c.name, ok: c.ok, diffLines: c.diffLines })) },
      injected: { pure: injected.allEqual, eol: eol.allOk },
      findings,
    }));
    return ok ? RC.OK : RC.FAIL;
  }
  io.out(line(`RK_CROSSPLAT_PLATFORM=${process.platform}`));
  io.out(line(`RK_CROSSPLAT_L1_FILES=${l1.files}`));
  io.out(line(`RK_CROSSPLAT_L1_CRLF_FILES=${l1.crlfFiles.length}`));
  io.out(line(`RK_CROSSPLAT_L1_BOM_FILES=${l1.bomFiles.length}`));
  io.out(line(`RK_CROSSPLAT_L1_IMPORT_CASE_MISMATCH=${l1.caseMismatches.length}`));
  io.out(line(`RK_CROSSPLAT_L1_IMPORT_MISSING=${l1.missingImports.length}`));
  io.out(line(`RK_CROSSPLAT_L1_DEPS=${l1.dependencies.length}`));
  io.out(line(`RK_CROSSPLAT_L1_TYPE=${l1.type ?? '(none)'}`));
  io.out(line(`RK_CROSSPLAT_L1_ENGINES_NODE=${l1.engines?.node ?? '(none)'}`));
  io.out(line(`RK_CROSSPLAT_L1_RESULT=${l1.ok ? 'pass' : 'fail'}`));
  io.out(line(`RK_CROSSPLAT_L2_NORMALIZE=${useNormalize ? 'on' : 'off'}`));
  io.out(line(`RK_CROSSPLAT_L2_NORMALIZED_DIFF_LINES=${cmp.diff.length}`));
  io.out(line(`RK_CROSSPLAT_L2_RAW_DIFF_LINES=${cmpRaw.diff.length}`));
  io.out(line(`RK_CROSSPLAT_L2_RESULT=${l2Ok ? 'pass' : 'fail'}`));
  io.out(line(`RK_CROSSPLAT_L3_WINDOWS_IDENTICAL=${l3win.identical}`));
  io.out(line(`RK_CROSSPLAT_L3_WINDOWS_SHA256=${l3win.shas[0] ?? '(n/a)'}`));
  io.out(line(`RK_CROSSPLAT_L3_CROSS_DONE=${L3_CROSS_DONE}`));
  io.out(line(`RK_CROSSPLAT_L3_CROSS_REASON=${L3_CROSS_REASON}`));
  io.out(line(`RK_CROSSPLAT_COMPARATOR_SELFTEST=${comparator.ok ? 'pass' : 'fail'} CASES=${comparator.cases.length}`));
  io.out(line(`RK_CROSSPLAT_INJECTED_CASES=${injected.cases.length} PURE_ALL_EQUAL=${injected.allEqual} EOL_ALL_OK=${eol.allOk}`));
  if (l4 !== null) {
    io.out(line(`RK_CROSSPLAT_L4_HOOK_CASES=${l4.cases.length} L4_HOOK_OK=${l4.cases.filter((c) => c.ok).length} L4_RESULT=${l4.ok ? 'pass' : 'fail'}`));
    io.out(line(`RK_CROSSPLAT_L4_BASH_PRESENT=${probe.available === true} L4_BASH_NAME=${basename(l4.bashPath)}`));
    io.out(line(`RK_CROSSPLAT_L4_BASH_VERSION=${probe.bashVersion}`));
    io.out(line(`RK_CROSSPLAT_L4_BASH_UNAME=${probe.uname}`));
    io.out(line(`RK_CROSSPLAT_L4_BASH_NODE=${probe.nodePath}`));
    io.out(line(`RK_CROSSPLAT_L4_BASH_NODE_PLATFORM=${probe.nodePlatform}`));
    io.out(line(`RK_CROSSPLAT_L4_IS_WINDOWS_NODE=${probe.isWindowsNode}`));
    io.out(line(`RK_CROSSPLAT_LINUX_CARRIER_DONE=${LINUX_CARRIER_DONE}`));
    io.out(line(`RK_CROSSPLAT_LINUX_CARRIER_REASON=${LINUX_CARRIER_REASON}`));
  }
  for (const f of findings) io.out(line(`FINDING ${f.code} ${f.message}`));
  io.out(resultLine('CROSSPLAT', ok));
  return ok ? RC.OK : RC.FAIL;
}

/**
 * `rk-snap`（LF-300/310/320）：pre-image 快照 / 回滚 / 快照↔账本对账。
 * 判据口径：①take -> `SNAP_OK` == 真实 sha256、回读一致、索引 **+1 行**（回读不一致则**不登记**且 exit≠0）
 *          ②restore -> 回滚后 sha256 == 改前；**无快照 -> NO_SNAPSHOT(3)**（禁静默成功）
 *          ③recon -> "有记录无备份"与"有备份无记录"两类都要报出；漏报任一类 -> exit≠0
 */
export function runSnap(argv, io = defaultIo(), env = process.env) {
  const sub = argv[0] ?? null;
  if (sub === '--help' || sub === '-h' || sub === null) {
    io.out(`${USAGE_SNAP}\n`);
    return sub === null ? RC.USAGE : RC.OK;
  }
  if (!['take', 'restore', 'recon'].includes(sub)) {
    io.err(`rk-snap: 未知子命令 "${sub}"（可选 take|restore|recon）\n${USAGE_SNAP}\n`);
    return RC.USAGE;
  }
  let flags;
  try {
    flags = scanFlags(argv.slice(1), {
      '--landing': 'string', '--project': 'string', '--path': 'string', '--now': 'string',
      '--why': 'string', '--corrupt-backup-after-copy': 'boolean', '--json': 'boolean',
    });
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`rk-snap: ${err.message}\n${USAGE_SNAP}\n`);
      return RC.USAGE;
    }
    throw err;
  }
  if (flags.landing === undefined) {
    io.err(`rk-snap: 需要 --landing <落点>\n${USAGE_SNAP}\n`);
    return RC.USAGE;
  }
  const landing = resolve(flags.landing);
  if (!existsSync(landing) || !statSync(landing).isDirectory()) {
    io.err(`rk-snap: --landing 不是已存在目录: ${landing}\n`);
    return RC.USAGE;
  }
  const projectRoot = resolve(flags.project ?? process.cwd());
  let now = new Date();
  if (flags.now !== undefined) {
    now = new Date(flags.now);
    if (Number.isNaN(now.getTime())) {
      io.err(`rk-snap: --now 不是合法时间: ${flags.now}\n`);
      return RC.USAGE;
    }
  }
  const needPath = sub === 'take' || sub === 'restore';
  if (needPath && flags.path === undefined) {
    io.err(`rk-snap: ${sub} 需要 --path <文件>\n${USAGE_SNAP}\n`);
    return RC.USAGE;
  }

  if (sub === 'take') {
    const report = takeSnapshot({
      projectRoot, landingDir: landing, file: snapTargetPath(flags.path, projectRoot), now,
      ...(flags.why === undefined ? {} : { why: flags.why }),
      ...(flags['corrupt-backup-after-copy'] === true ? { _inject: { corruptBackupAfterCopy: true } } : {}),
    });
    if (flags.json === true) {
      io.out(jsonStable({ landing, ...report, ok: report.ok }));
      return report.ok ? RC.OK : RC.FAIL;
    }
    io.out(line(`RK_SNAP_LANDING=${toPosix(landing)}`));
    io.out(line(`RK_SNAP_MODE=take`));
    io.out(line(`RK_SNAP_PATH=${report.path ?? '(n/a)'}`));
    if (report.ok) {
      io.out(line(`RK_SNAP_SHA256_BEFORE=${report.sha256}`));
      io.out(line(`RK_SNAP_READBACK_SHA256=${report.readBackSha}`));
      io.out(line(`RK_SNAP_BACKUP=${report.backup}`));
      io.out(line(`RK_SNAP_INDEX_LINES=${report.indexLines}`));
      io.out(line(report.snapOk));
    } else {
      if (report.code !== undefined) io.out(line(`RK_SNAP_CODE=${report.code}`));
      for (const reason of report.reasons) io.out(line(`FINDING ${report.code ?? 'SNAP_FAILED'} ${reason}`));
    }
    io.out(resultLine('SNAP', report.ok));
    return report.ok ? RC.OK : RC.FAIL;
  }

  if (sub === 'restore') {
    const report = restoreSnapshot({ projectRoot, landingDir: landing, file: snapTargetPath(flags.path, projectRoot), now });
    const rc = report.ok ? RC.OK : (report.code === 'NO_SNAPSHOT' ? RC.NO_SNAPSHOT : (report.code === 'NO_BACKUP' ? RC.NO_BACKUP : RC.FAIL));
    if (flags.json === true) {
      io.out(jsonStable({ landing, ...report, rc }));
      return rc;
    }
    io.out(line(`RK_RESTORE_LANDING=${toPosix(landing)}`));
    io.out(line(`RK_RESTORE_MODE=restore`));
    io.out(line(`RK_RESTORE_PATH=${report.path ?? '(n/a)'}`));
    io.out(line(`RK_RESTORE_CODE=${report.code ?? 'OK'}`));
    if (report.sha256BeforeRestore !== undefined) io.out(line(`SHA256_BEFORE_RESTORE=${report.sha256BeforeRestore ?? '(file-missing)'}`));
    if (report.sha256AfterRestore !== undefined) io.out(line(`SHA256_AFTER_RESTORE=${report.sha256AfterRestore}`));
    if (report.restoredTo !== undefined) io.out(line(`RESTORED_TO=${report.restoredTo}`));
    if (report.match !== undefined) io.out(line(`RK_RESTORE_MATCH=${report.match}`));
    for (const reason of report.reasons) io.out(line(`FINDING RESTORE_${report.code ?? 'FAILED'} ${reason}`));
    io.out(resultLine('RESTORE', report.ok));
    return rc;
  }

  const report = reconSnapshots({ projectRoot, landingDir: landing });
  if (flags.json === true) {
    io.out(jsonStable({ landing, ...report }));
    return report.ok ? RC.OK : RC.FAIL;
  }
  io.out(line(`RK_RECON_LANDING=${toPosix(landing)}`));
  io.out(line(`RK_RECON_MODE=recon`));
  io.out(line(`RK_RECON_INDEX_LINES=${report.indexLines}`));
  io.out(line(`RK_RECON_INDEX_BAD_LINES=${report.indexBadLines}`));
  io.out(line(`RK_RECON_INDEX_MISSING=${report.indexMissing}`));
  io.out(line(`RK_RECON_RECORDS=${report.records}`));
  io.out(line(`RK_RECON_BACKUPS=${report.backups}`));
  io.out(line(`RK_RECON_MISSING_BACKUPS=${report.missingBackups.length}`));
  io.out(line(`RK_RECON_UNRECORDED_BACKUPS=${report.unrecordedBackups.length}`));
  for (const m of report.missingBackups) io.out(line(`MISSING_BACKUP ${m.path} backup=${m.backup}`));
  for (const u of report.unrecordedBackups) io.out(line(`UNRECORDED_BACKUP ${u.backup}`));
  if (report.missingBackups.length > 0) io.out(line(`FINDING SNAP_RECON_MISSING_BACKUP 有记录无备份 ${report.missingBackups.length} 条`));
  if (report.unrecordedBackups.length > 0) io.out(line(`FINDING SNAP_RECON_UNRECORDED_BACKUP 有备份无记录 ${report.unrecordedBackups.length} 条`));
  io.out(resultLine('RECON', report.ok));
  return report.ok ? RC.OK : RC.FAIL;
}

/**
 * `rk-shard`（LF-2C0）：账本分片（split）+ gc + **引用完整性**。
 * 判据口径：①`gc --dry-run` 报告（只报告不动盘）②被 evidence/proposals 引用的行**不删**
 *          ③分片"写新片 → 回读校验 → 才删旧片" ④红态：gc 删掉被引用行 → exit≠0（后置断言）。
 */
export function runShard(argv, io = defaultIo(), env = process.env) {
  const sub = argv[0] ?? null;
  if (sub === '--help' || sub === '-h' || sub === null) {
    io.out(`${USAGE_SHARD}\n`);
    return sub === null ? RC.USAGE : RC.OK;
  }
  if (!['split', 'gc'].includes(sub)) {
    io.err(`rk-shard: 未知子命令 "${sub}"（可选 split|gc）\n${USAGE_SHARD}\n`);
    return RC.USAGE;
  }
  let flags;
  try {
    flags = scanFlags(argv.slice(1), {
      '--landing': 'string', '--now': 'string', '--keep-days': 'string',
      '--dry-run': 'boolean', '--apply': 'boolean', '--json': 'boolean',
      '--force-deletable': 'string',
    });
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`rk-shard: ${err.message}\n${USAGE_SHARD}\n`);
      return RC.USAGE;
    }
    throw err;
  }
  if (flags.landing === undefined) {
    io.err(`rk-shard: 需要 --landing <落点>\n${USAGE_SHARD}\n`);
    return RC.USAGE;
  }
  const landing = resolve(flags.landing);
  if (!existsSync(landing) || !statSync(landing).isDirectory()) {
    io.err(`rk-shard: --landing 不是已存在目录: ${landing}\n`);
    return RC.USAGE;
  }
  let now = new Date();
  if (flags.now !== undefined) {
    now = new Date(flags.now);
    if (Number.isNaN(now.getTime())) {
      io.err(`rk-shard: --now 不是合法时间: ${flags.now}\n`);
      return RC.USAGE;
    }
  }
  const asCount = (flagName, raw) => {
    if (raw === undefined) return undefined;
    if (!/^\d+$/.test(raw)) throw new UsageError(`${flagName} 需要非负整数（收到 ${JSON.stringify(raw)}）`);
    return Number(raw);
  };

  if (sub === 'split') {
    let keepDays;
    try {
      keepDays = asCount('--keep-days', flags['keep-days']);
    } catch (err) {
      io.err(`rk-shard: ${err.message}\n${USAGE_SHARD}\n`);
      return RC.USAGE;
    }
    const report = shardLedger({ landingDir: landing, now, ...(keepDays === undefined ? {} : { keepDays }), dryRun: flags['dry-run'] === true || flags.apply !== true });
    if (flags.json === true) {
      io.out(jsonStable({ landing, mode: 'split', dryRun: !(flags.apply === true), moved: report.moved, kept: report.kept, shards: report.shards, reasons: report.reasons, sourceRemoved: report.sourceRemoved, ok: report.ok }));
      return report.ok ? RC.OK : RC.FAIL;
    }
    io.out(line(`RK_SHARD_LANDING=${toPosix(landing)}`));
    io.out(line(`RK_SHARD_MODE=split`));
    io.out(line(`RK_SHARD_COLD_ONLY=${flags.apply !== true}`));
    io.out(line(`RK_SHARD_MOVED=${report.moved}`));
    io.out(line(`RK_SHARD_KEPT=${report.kept}`));
    for (const s of report.shards) io.out(line(`SHARD ${s.name} lines=${s.lines}`));
    io.out(line(`RK_SHARD_SOURCE_REMOVED=${report.sourceRemoved}`));
    for (const reason of report.reasons) io.out(line(`FINDING SHARD_PROBLEM ${reason}`));
    io.out(resultLine('SHARD', report.ok));
    return report.ok ? RC.OK : RC.FAIL;
  }

  // gc：默认 dry-run（只看不动盘）；--apply 才真删
  // `--force-deletable` 是**取证/测试专用**（把指定 id 硬塞进"可删"集合）：它存在的意义就是验证后置断言真的会拦——
  // 生产禁用；一旦塞进去的是被引用行，整步必须 exit≠0 且**什么都不删**。
  const forceDeletable = flags['force-deletable'] === undefined
    ? []
    : flags['force-deletable'].split(',').map((s) => s.trim()).filter((s) => s !== '');
  const plan = planGc({ landingDir: landing, forceDeletable });
  const apply = flags.apply === true && flags['dry-run'] !== true;
  if (!plan.postConditionOk) {
    io.out(line(`RK_GC_LANDING=${toPosix(landing)}`));
    io.out(line(`RK_GC_MODE=${apply ? 'apply' : 'dry-run'}`));
    io.out(line(`RK_GC_ENTRIES=${plan.entries}`));
    io.out(line(`RK_GC_REFERENCED=${plan.referenced}`));
    io.out(line(`RK_GC_DELETABLE=${plan.deletable.length}`));
    io.out(line(`RK_GC_POST_CONDITION=fail`));
    io.out(line(`FINDING GC_WOULD_DELETE_REFERENCED 计划里含被引用行（禁止删除）: ${plan.wouldDeleteReferenced.join(',')}`));
    io.out(resultLine('GC', false));
    return RC.FAIL;
  }
  const applied = apply ? applyGc({ landingDir: landing, plan }) : { ok: true, deleted: 0, files: [], reasons: [] };
  const ok = plan.postConditionOk && applied.ok;
  if (flags.json === true) {
    io.out(jsonStable({
      landing, mode: apply ? 'apply' : 'dry-run', entries: plan.entries, shardFiles: plan.shardFiles,
      referenced: plan.referenced, referencedIds: plan.referencedIds, deletable: plan.deletable,
      kept: plan.kept, badLines: plan.badLines, truncatedTail: plan.truncatedTail,
      postCondition: plan.postConditionOk ? 'pass' : 'fail', deleted: applied.deleted, files: applied.files,
      reasons: applied.reasons, ok,
    }));
    return ok ? RC.OK : RC.FAIL;
  }
  io.out(line(`RK_GC_LANDING=${toPosix(landing)}`));
  io.out(line(`RK_GC_MODE=${apply ? 'apply' : 'dry-run'}`));
  io.out(line(`RK_GC_LEDGER_ENTRIES=${plan.entries}`));
  io.out(line(`RK_GC_SHARD_FILES=${plan.shardFiles}`));
  io.out(line(`RK_GC_REFERENCED=${plan.referenced}`));
  io.out(line(`RK_GC_DELETABLE=${plan.deletable.length}`));
  io.out(line(`RK_GC_KEPT_ACTIVE=${plan.kept.active}`));
  io.out(line(`RK_GC_KEPT_REFERENCED=${plan.kept.referenced}`));
  io.out(line(`RK_GC_LEDGER_BAD_LINES=${plan.badLines}`));
  for (const d of plan.deletable) io.out(line(`GC_DELETABLE ${d.id} status=${d.status} reason=${d.reason}`));
  for (const f of applied.files) io.out(line(`GC_FILE ${f.file} kept=${f.kept} removed=${f.removed}`));
  for (const reason of applied.reasons) io.out(line(`FINDING GC_PROBLEM ${reason}`));
  io.out(line(`RK_GC_POST_CONDITION=${plan.postConditionOk ? 'pass' : 'fail'}`));
  io.out(line(`RK_GC_DELETED=${applied.deleted}`));
  io.out(resultLine('GC', ok));
  return ok ? RC.OK : RC.FAIL;
}

/**
 * `rk-baseline`（LF-2B0）：首次启用基线（record）+ 基线校验（verify）。
 * 判据口径：①首启后首轮违规数 == 预期（逐字数字，期望 **0**）②篡改 index 一行 → exit≠0 ③落点自产物一律排除并计数。
 */
export function runBaseline(argv, io = defaultIo(), env = process.env) {
  const sub = argv[0] ?? null;
  if (sub === '--help' || sub === '-h' || sub === null) {
    io.out(`${USAGE_BASELINE}\n`);
    return sub === null ? RC.USAGE : RC.OK;
  }
  if (!['record', 'verify'].includes(sub)) {
    io.err(`rk-baseline: 未知子命令 "${sub}"（可选 record|verify）\n${USAGE_BASELINE}\n`);
    return RC.USAGE;
  }
  let flags;
  try {
    flags = scanFlags(argv.slice(1), {
      '--landing': 'string', '--project': 'string', '--now': 'string',
      '--max-files': 'string', '--no-backup': 'boolean', '--dry-run': 'boolean', '--json': 'boolean',
    });
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`rk-baseline: ${err.message}\n${USAGE_BASELINE}\n`);
      return RC.USAGE;
    }
    throw err;
  }
  if (flags.landing === undefined) {
    io.err(`rk-baseline: 需要 --landing <落点>\n${USAGE_BASELINE}\n`);
    return RC.USAGE;
  }
  const landing = resolve(flags.landing);
  if (!existsSync(landing) || !statSync(landing).isDirectory()) {
    io.err(`rk-baseline: --landing 不是已存在目录: ${landing}\n`);
    return RC.USAGE;
  }
  const projectRoot = resolve(flags.project ?? process.cwd());
  const configPath = resolve(landing, 'config.json');
  if (!existsSync(configPath)) {
    io.err(`rk-baseline: 落点未初始化（缺 config.json）: ${toPosix(configPath)}；先跑 dsh-rulekeeper init\n`);
    return RC.USAGE;
  }
  let now = new Date();
  if (flags.now !== undefined) {
    now = new Date(flags.now);
    if (Number.isNaN(now.getTime())) {
      io.err(`rk-baseline: --now 不是合法时间: ${flags.now}\n`);
      return RC.USAGE;
    }
  }
  let maxFiles;
  if (flags['max-files'] !== undefined) {
    if (!/^\d+$/.test(flags['max-files'])) {
      io.err(`rk-baseline: --max-files 需要非负整数（收到 ${JSON.stringify(flags['max-files'])}）\n`);
      return RC.USAGE;
    }
    maxFiles = Number(flags['max-files']);
  }
  const loaded = loadLandingRules(landing);
  const rules = loaded.rulesResult?.rules ?? loaded.rules ?? null;
  const opts = { projectRoot, landingDir: landing, rules, ...(maxFiles === undefined ? {} : { maxFiles }) };

  if (sub === 'record') {
    const report = recordBaseline({
      ...opts, now,
      withBackup: flags['no-backup'] !== true,
      dryRun: flags['dry-run'] === true,
    });
    if (flags.json === true) {
      io.out(jsonStable({
        landing, scanned: report.scanned, recorded: report.recorded, unchanged: report.unchanged,
        selfExcluded: report.excluded.length, selfExcludedPaths: report.excluded,
        truncated: report.truncated, violations: report.violations, reasons: report.reasons,
        dryRun: flags['dry-run'] === true, ok: report.ok,
      }));
      return report.ok ? RC.OK : RC.FAIL;
    }
    io.out(line(`RK_BASELINE_LANDING=${toPosix(landing)}`));
    io.out(line(`RK_BASELINE_MODE=record`));
    io.out(line(`RK_BASELINE_DRY_RUN=${flags['dry-run'] === true}`));
    io.out(line(`RK_BASELINE_SCANNED=${report.scanned}`));
    io.out(line(`RK_BASELINE_RECORDED=${report.recorded}`));
    io.out(line(`RK_BASELINE_UNCHANGED=${report.unchanged}`));
    io.out(line(`RK_BASELINE_SELF_EXCLUDED=${report.excluded.length}`));
    for (const p of report.excluded) io.out(line(`SELF_EXCLUDED ${p}`));
    io.out(line(`RK_BASELINE_VIOLATIONS=${report.violations}`));
    for (const reason of report.reasons) io.out(line(`FINDING BASELINE_RECORD_PROBLEM ${reason}`));
    io.out(resultLine('BASELINE', report.ok));
    return report.ok ? RC.OK : RC.FAIL;
  }

  const report = verifyBaseline(opts);
  if (flags.json === true) {
    io.out(jsonStable({
      landing, scanned: report.scanned, indexLines: report.indexLines, badLines: report.badLines,
      truncatedTail: report.truncatedTail, missing: report.missing, selfExcluded: report.excluded.length,
      violations: report.violations, violationCount: report.violations.length, ok: report.ok,
    }));
    return report.ok ? RC.OK : RC.FAIL;
  }
  io.out(line(`RK_BASELINE_LANDING=${toPosix(landing)}`));
  io.out(line(`RK_BASELINE_MODE=verify`));
  io.out(line(`RK_BASELINE_SCANNED=${report.scanned}`));
  io.out(line(`RK_BASELINE_INDEX_LINES=${report.indexLines}`));
  io.out(line(`RK_BASELINE_INDEX_BAD_LINES=${report.badLines}`));
  io.out(line(`RK_BASELINE_INDEX_TRUNCATED_TAIL=${report.truncatedTail}`));
  io.out(line(`RK_BASELINE_SELF_EXCLUDED=${report.excluded.length}`));
  io.out(line(`RK_BASELINE_VIOLATIONS=${report.violations.length}`));
  for (const v of report.violations) io.out(line(`FINDING BASELINE_VIOLATION ${v.path}: ${v.reason}`));
  io.out(resultLine('BASELINE', report.ok));
  return report.ok ? RC.OK : RC.FAIL;
}

/**
 * `rk-replay`（LF-270）：回放三处历史缺陷，结论只允许 `hit` 或**合格的** `uncheckable`。
 * 复核红态（清单原文）：判 uncheckable 但不含正对照 → exit≠0。
 */
export function runReplay(argv, io = defaultIo(), env = process.env) {
  let flags;
  try {
    flags = scanFlags(argv, {
      '--project': 'string', '--landing': 'string', '--declaration': 'string',
      '--collapsed': 'string', '--now': 'string', '--json': 'boolean', '--help': 'boolean',
    });
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`rk-replay: ${err.message}\n${USAGE_REPLAY}\n`);
      return RC.USAGE;
    }
    throw err;
  }
  if (flags.help === true || argv.length === 0) {
    io.out(`${USAGE_REPLAY}\n`);
    return flags.help === true ? RC.OK : RC.USAGE;
  }
  let now = new Date();
  if (flags.now !== undefined) {
    now = new Date(flags.now);
    if (Number.isNaN(now.getTime())) {
      io.err(`rk-replay: --now 不是合法时间: ${flags.now}\n`);
      return RC.USAGE;
    }
  }
  let landingDir = flags.landing === undefined ? null : resolve(flags.landing);
  if (landingDir !== null && !existsSync(landingDir)) {
    io.err(`rk-replay: --landing 不是已存在目录: ${landingDir}\n`);
    return RC.USAGE;
  }
  if (landingDir === null) landingDir = mkdtempSync(join(tmpdir(), 'rk-replay-'));
  let report;
  try {
    report = runReplayAll({
      landingDir,
      projectRoot: resolve(flags.project ?? process.cwd()),
      collapsedSample: flags.collapsed === undefined ? undefined : resolve(flags.collapsed),
      declaration: flags.declaration === undefined ? undefined : resolve(flags.declaration),
      now,
    });
  } catch (err) {
    io.err(`rk-replay: 内部错误: ${err?.message ?? String(err)}\n`);
    return RC.FAIL;
  }
  const hits = report.items.filter((i) => i.verdict === 'hit').length;
  const uncheckable = report.items.filter((i) => i.verdict === 'uncheckable').length;
  const miss = report.items.filter((i) => i.verdict === 'miss').length;
  if (flags.json === true) {
    io.out(jsonStable({ ok: report.ok, hits, uncheckable, miss, items: report.items, findings: report.findings }));
    return report.ok ? RC.OK : RC.FAIL;
  }
  io.out(line(`RK_REPLAY_ITEMS=${report.items.length}`));
  for (const item of report.items) {
    const extra = item.id === 'L451'
      ? ` lines=${item.detail.lines} maxline=${item.detail.maxLineLength} expect_lines=${item.detail.expect?.lines} expect_maxline=${item.detail.expect?.maxLineLength}`
      : (item.id === 'L454' ? ` declaration=${item.detail.declaration ?? '(none)'}` : '');
    io.out(line(`REPLAY ${item.id} verdict=${item.verdict} mode=${item.mode} rule=${item.rule}${extra}`));
  }
  io.out(line(`RK_REPLAY_HITS=${hits}`));
  io.out(line(`RK_REPLAY_UNCHECKABLE=${uncheckable}`));
  io.out(line(`RK_REPLAY_MISS=${miss}`));
  for (const f of report.findings) io.out(line(`FINDING ${f.code} ${f.message}`));
  io.out(resultLine('REPLAY', report.ok));
  return report.ok ? RC.OK : RC.FAIL;
}

/** 供 `rk-check --help` 与清单引用：三类可机检 + 形态守卫 */
export const CHECK_KIND_LIST = Object.freeze([...CHECK_KINDS, 'shape_guard', 'uncheckable_justified']);

// ── LF-240 收口：把仍自带 main() 的三个 bin 也统一到这里（bin/*.mjs 一律薄壳） ──
export const USAGE_SCHEMA = `用法: rk-schema [--check] [--write-md] [--emit-md] [--json] [--root <dir>]
退出码: 0 通过 / 1 冻结单有问题 / 2 用法错误`;

export const USAGE_RC = `用法: rk-rc [--check] [--emit] [--json] [--root <dir>]
退出码: 0 通过 / 1 表有问题 / 2 用法错误`;

export const USAGE_LOG = `用法: rk-log --dir <日志目录> [--tail <n>] [--rotate] [--json]
退出码: 0 成功 / 1 读失败 / 2 用法错误`;

export function runSchema(argv, io = defaultIo()) {
  let flags;
  try {
    flags = scanFlags(argv, { '--check': 'boolean', '--write-md': 'boolean', '--emit-md': 'boolean', '--json': 'boolean', '--root': 'string' });
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`rk-schema: ${err.message}\n${USAGE_SCHEMA}\n`);
      return RC.USAGE;
    }
    throw err;
  }
  if (flags.help) {
    io.out(`${USAGE_SCHEMA}\n`);
    return RC.OK;
  }
  const root = resolve(flags.root ?? process.cwd());
  if (!existsSync(root)) {
    io.err(`rk-schema: --root 不存在: ${root}\n`);
    return RC.USAGE;
  }
  if (flags['write-md'] === true) {
    const target = join(root, 'SCHEMA.md');
    writeFileSync(target, renderSchemaMarkdown(), 'utf8');
    io.out(line(`RK_SCHEMA_WROTE=${target}`));
    io.out(resultLine('SCHEMA', true));
    return RC.OK;
  }
  if (flags['emit-md'] === true) {
    io.out(renderSchemaMarkdown());
    return RC.OK;
  }
  const report = checkSchema({ root, checkDoc: true });
  if (flags.json === true) {
    io.out(jsonStable({ root, ok: report.ok, findings: report.findings }));
    return report.ok ? RC.OK : RC.FAIL;
  }
  io.out(line(`RK_SCHEMA_ROOT=${root}`));
  for (const finding of report.findings) io.out(line(`FINDING ${finding.code} ${finding.msg}`));
  io.out(line(`RK_SCHEMA_FINDINGS=${report.findings.length}`));
  io.out(resultLine('SCHEMA', report.ok));
  return report.ok ? RC.OK : RC.FAIL;
}

export function runRc(argv, io = defaultIo()) {
  let flags;
  try {
    flags = scanFlags(argv, { '--check': 'boolean', '--emit': 'boolean', '--json': 'boolean', '--root': 'string' });
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`rk-rc: ${err.message}\n${USAGE_RC}\n`);
      return RC.USAGE;
    }
    throw err;
  }
  if (flags.help) {
    io.out(`${USAGE_RC}\n`);
    return RC.OK;
  }
  const root = resolve(flags.root ?? process.cwd());
  if (!existsSync(root)) {
    io.err(`rk-rc: --root 不存在: ${root}\n`);
    return RC.USAGE;
  }
  const emit = flags.emit === true;
  const check = flags.check === true || !emit;
  const report = check ? checkRcTable({ root }) : { ok: true, findings: [] };
  if (flags.json === true) {
    io.out(jsonStable({ root, ok: report.ok, findings: report.findings }));
  } else {
    if (check) {
      io.out(line(`RK_RC_ROOT=${root}`));
      for (const finding of report.findings) io.out(line(`FINDING ${finding.code} ${finding.msg}`));
      io.out(line(`RK_RC_FINDINGS=${report.findings.length}`));
      io.out(resultLine('RC', report.ok));
    }
    if (emit) io.out(renderRcTable());
  }
  return report.ok ? RC.OK : RC.FAIL;
}

export function runLog(argv, io = defaultIo()) {
  let flags;
  try {
    flags = scanFlags(argv, { '--dir': 'string', '--tail': 'string', '--rotate': 'boolean', '--json': 'boolean' });
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`rk-log: ${err.message}\n${USAGE_LOG}\n`);
      return RC.USAGE;
    }
    throw err;
  }
  if (flags.help) {
    io.out(`${USAGE_LOG}\n`);
    return RC.OK;
  }
  if (flags.dir === undefined) {
    io.err(`rk-log: 必须提供 --dir <日志目录>\n${USAGE_LOG}\n`);
    return RC.USAGE;
  }
  const dir = resolve(flags.dir);
  if (!existsSync(dir)) {
    io.err(`rk-log: 目录不存在: ${dir}\n`);
    return RC.FAIL;
  }
  const rotateResult = flags.rotate === true ? rotateIfNeeded({ dir }) : null;
  const report = readEntries(dir);
  if (report.error !== undefined) {
    io.err(`rk-log: 读失败: ${report.error}\n`);
    return RC.FAIL;
  }
  const tail = flags.tail === undefined ? 5 : Number(flags.tail);
  if (!Number.isInteger(tail) || tail < 0) {
    io.err('rk-log: --tail 需要非负整数\n');
    return RC.USAGE;
  }
  if (flags.json === true) {
    io.out(jsonStable({
      dir,
      files: listLogFiles(dir).map((f) => f.file),
      totalBytes: totalBytes(dir),
      badLines: report.badLines,
      entries: report.entries.slice(-tail),
    }));
  } else {
    io.out(line(`RK_LOG_DIR=${dir}`));
    io.out(line(`RK_LOG_FILES=${report.files.length}`));
    io.out(line(`RK_LOG_TOTAL_BYTES=${totalBytes(dir)}`));
    io.out(line(`RK_LOG_BAD_LINES=${report.badLines}`));
    io.out(line(`RK_LOG_ENTRIES=${report.entries.length}`));
    for (const entry of report.entries.slice(-tail)) io.out(line(`ENTRY ${JSON.stringify(entry)}`));
    if (rotateResult !== null) io.out(line(`RK_LOG_ROTATED=${rotateResult.rotated.length} DROPPED=${rotateResult.dropped.length}`));
    io.out(resultLine('LOG', true));
  }
  return RC.OK;
}
