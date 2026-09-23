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
import { bypassRecon, ciGate, closeGate, commitMessageGate, parseHit, postCommitRecon, precommitGate, reconWrite, refsGate, writeCiWorkflow, CI_WORKFLOW_REL, TOOL_CHECKOUT_DIR } from './gate.mjs';
import { DEFAULT_HOOKS_PATH, KNOWN_HOOK_NAMES, defaultRunGitRaw, installHooks, verifyHooks } from './hooks.mjs';
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
import {
  DEFAULT_STALE_DAYS, EFFECT_STATES, appendVerification, applyActivation,
  effectInjectPlan, effectPlan, parseCarrier, ruleBindings, verifyBinding,
} from './effect.mjs';
import { isSafeId } from './proposal.mjs';
import { carrierOfBinding } from './checker.mjs';
import { adoptionReport, writeDrafts } from './adopt.mjs';
import { importLedger } from './importer.mjs';
import { landingFingerprint, migrateLanding, planMigration } from './migrate.mjs';
import { MECHANISM_FACE_DEFAULT, MECHANISM_FACES, makeId, query as queryLedger, readLedger, record, supersededIds, summary as ledgerSummary } from './ledger.mjs';
import { appendRowsVerified, installedHooks, registeredGates, verifyGuardRef } from './authier.mjs';
import { parseSets, planMutation } from './ledger-mutate.mjs';
import { listLogFiles, readEntries, rotateIfNeeded, totalBytes } from './log.mjs';
import { RC, checkRcTable, renderRcTable } from './rc.mjs';
import { checkSchema, renderSchemaMarkdown } from './schema.mjs';
import { DEFAULT_NEAR_DUP_THRESHOLD, findNearDuplicates } from './similarity.mjs';
import { activationsById, appendAnnotation, validateActivation } from './annotations.mjs';
import { draftActivations } from './draft.mjs';
import { USAGE_FILE, usageSummary } from './usage.mjs';
import { canonicalRule, dedupe, detectRuleDivergence, ruleFragmentation } from './ruleid.mjs';
import { redactText, redactValue, scanText, selfTestRules, statsOf } from './redact.mjs';
import {
  CONSUMERS, checkConsumersConsistency, effectiveConfig, isProtected, loadLandingRules, loadRules,
} from './rules.mjs';
import { UsageError, resolveNow, stamp } from './platform/clock.mjs';
import { dshHome, LANDING_DIRNAME, LANDING_REL, packageVersion, pathKey, resolveProjectLanding, toPosix } from './platform/paths.mjs';
import { escapeControl, jsonStable, line, resultLine, sortCodePoints, write as stdWrite, writeErr as stdWriteErr } from './platform/out.mjs';
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
                  [--no-test-job] [--tool-repo <owner/repo> --tool-ref <40hex>] [--bin-sha <sha256>] [--claim-remote] [--limit <n>] [--json]
       rk-gate close [--project <项目根>] [--landing <落点>] [--hit "<纪律>=<拦住它的机制>"]... [--none] [--batch <名>]
                     [--evidence <路径>]... [--declaration <实证.json>] [--now <ISO>] [--json]
       rk-gate hooks verify  [--repo <仓库根>] [--hooks-path <.githooks>] [--json]
       rk-gate hooks install [--repo <仓库根>] [--hooks-path <.githooks>] [--names <a,b>] [--force] [--adopt-existing] [--no-config] [--json]
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
  · **自曝边界**：CI_CARRIER_DONE=false（本机代码无法自证 GitHub 侧事实：远端是否真执行、分支保护是否设置）——
    本机模拟**不冒充**远端已执行，显式 --claim-remote 判红；谁要说"远端 CI 拦住了"必须另附远端运行记录
    （如 check-run 注解；注解无需 token 可读，job 日志要 token），并需分支保护 + required checks（属老板保留项）

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

// 版本串**从 package.json 读**（不再写死：两处各写一份必然漂移，发布时就会对不上）
export const USAGE_RULEKEEPER = `dsh-rulekeeper ${packageVersion() ?? '(version unknown)'}
用法:
  dsh-rulekeeper init    [--project <dir>]                     建立两处落点 + config.json（默认 mode=observe）
  dsh-rulekeeper check   --landing <dir> [--project <dir>]     自检：账本/落点可信性（doctor）+ 计数
  dsh-rulekeeper snap    --landing <dir>                       pre-image 快照（**未实现**，属 LF-300）
  dsh-rulekeeper record  --landing <dir> --rule <r> --problem <p> --root-cause <r> --solution <s> [--category c] [--mechanism m] [--evidence a,b]
                         · --mechanism 四选一：text（承认仅文本，会被计数）/ mechanized（有机械判据）/ guard（有插件拦截）/ question（靠人工问句）
                         · --category 默认「纪律」；**生效登记 / 生效退役** 是工具自己的事件类目（事件行不进复发计数），
                           人工教训别占用它们 —— 实测教训：占用后复发判定与"凭证须晚于生效"判定双双被污染
  dsh-rulekeeper rules   <check|is-protected|effective> …      规则包校验 / 单点判定 / 生效配置
  dsh-rulekeeper evolve  --landing <dir> [--quality <file.json>] [--source auto|human] [--escalate-gate] [--rule r] [--dry-run]  自进化提案（**只写 proposals/**）
  dsh-rulekeeper report  --landing <dir> [--now <ISO>]         报告（账本摘要 + 自检 + 生效配置，可复现）
  dsh-rulekeeper migrate [--project <dir>] [--scope project|user] [--apply] [--remove-old]   落点迁移（老 .dsh-ai/lessonflow -> 新 .dsh-ai/rulekeeper；默认 dry-run）
  dsh-rulekeeper --help
退出码: 0 成功 / 2 用法错误 / 1 运行失败 / 5 该能力尚未实现（见 src/rc.mjs 契约表）`;

export const SUBCOMMANDS = Object.freeze(['init', 'check', 'snap', 'record', 'mutate', 'rules', 'evolve', 'report', 'gate', 'redact', 'migrate', 'effect']);

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
  rk-ledger near-dup --landing <落点> [--threshold 0.6] [--fields problem] [--fail-on-found] [--json]
                     （**近似**重复检测：精确键 dedupe 抓不到"同一次事故的第二次记录"；E2 实验依据见 src/similarity.mjs）
  rk-ledger families --landing <落点> --expect <RULE>=<id,id,...>   （校验同族条目归同 rule）
退出码: 0 成功 / 1 失败（导入写入失败 / families 不符 / near-dup --fail-on-found 且确有近似重复） / 2 用法错误`;

export const USAGE_EFFECT = `用法:
  rk-effect plan   --landing <落点> [--project <项目根>] [--now <ISO>] [--stale-days n] [--json]
  rk-effect verify --landing <落点> [--project <项目根>] [--proposal <id>] [--all] [--now <ISO>] [--json] [--allow-exec]
                     （--allow-exec 才会**真的执行** kind:"checker" 绑定里写的命令；
                       未加时 checker 一律报 inconclusive，绝不判通过）
  rk-effect apply  --landing <落点> --proposal <id> --by human [--pattern <glob>]... [--gate <机制>] [--carrier <载体>] [--apply] [--project <项目根>] [--now <ISO>] [--json]
  rk-effect inject --landing <落点> [--max-per-session n] [--now <ISO>] [--json]
  rk-effect usage  --landing <落点> [--json]
  rk-effect draft-activation --landing <落点> [--limit n] [--write] [--json]
                     （机器起草"条目级可判激活条件"；默认只出草稿，--write 才写注解层
                       activations.jsonl（**不碰账本**，账本 append-only 逐字节不变））
  （亦可用 dsh-rulekeeper effect <子命令>，两者同实现）
说明: **入账 ≠ 生效**（LF-A*，2026-09-19）。七个动作：
      plan   = 只读体检：每条纪律的生效状态（none/injected/mechanized/verified/recurred）+ findings；
               有 error 级 finding（如只写下来了 EFFECT_TEXT_ONLY、绑定空转 EFFECT_BINDING_UNENFORCED）=> exit 1
      verify = 生效验证三项（①命中红 ②**反事实唯一性** ③误报面绿）；缺载体一律判"凭证不足"（EFFECT_VERIFY_UNCARRIED）
      apply  = **唯一**能写 rules.json 的通路：默认 dry-run，--apply 才落盘；**必须 --by human**
               （--by auto 一律拒绝——闸门不可被 AI 直接改）；写前备份 + 写后回读 + 失败逐字节回滚
               提案带 EFFECT_SUPERSEDE + supersedes{spec,reason} ⇒ **换绑**（摘旧加新，不中断保护）
      inject = 把"只写下来了"的纪律经注入面变成会话提醒（纯计算，零落点写入）
      usage  = 读**用量遥测**（<落点>/usage.json）：哪几条纪律真被投递过、投递多少次（只读；没投递过就是 0，不造假命中）
      adopt  = 自动收养记账：把账本里"声明了机制面/可绑判据"的纪律**如实分类**（text/mechanized/guard/question），
               并提出可绑草案（默认只出读数与草稿，零落点写入；看 RK_ADOPT_* 读数）
      draft-activation = 机器起草**条目级**可判激活条件（见上方用法行；默认只出草稿）
退出码: 0 通过 / 1 判定不合格（或被闸门拒绝/回滚） / 2 用法错误`;

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
    // **提示面**（不是判据）：如实打印"缺了什么、缺了会怎样"，但**不参与 ok/rc**
    for (const n of report.notes ?? []) io.out(line(`NOTE ${n}`));
    io.out(line(`RK_SELFCHECK_FINDINGS=${report.findings.length} NOTES=${(report.notes ?? []).length}`));
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
  if (!['import', 'query', 'summary', 'dedupe', 'near-dup', 'families'].includes(command)) {
    io.err(`rk-ledger: 未知子命令 "${command}"\n${USAGE_LEDGER}\n`);
    return RC.USAGE;
  }
  let flags;
  try {
    flags = scanFlags(argv.slice(1), {
      '--legacy': 'string', '--landing': 'string', '--id': 'string', '--rule': 'string',
      '--expect': 'string', '--now': 'string', '--dry-run': 'boolean', '--json': 'boolean',
      '--threshold': 'string', '--fields': 'string', '--fail-on-found': 'boolean',
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

  if (command === 'near-dup') {
    // **近似**重复（E2 实验落地，2026-09-19）：精确键 dedupe 抓不到"同一次事故的第二次记录"。
    // 只读；`--fail-on-found` 时才用 rc=1 表达"确有近似重复"（便于当入库门用）。
    const threshold = flags.threshold === undefined ? DEFAULT_NEAR_DUP_THRESHOLD : Number(flags.threshold);
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
      io.err(`rk-ledger near-dup: --threshold 必须在 (0,1]，实得 ${JSON.stringify(flags.threshold)}\n`);
      return RC.USAGE;
    }
    const fields = flags.fields === undefined ? ['problem'] : flags.fields.split(',').map((s) => s.trim()).filter((s) => s !== '');
    const read = readLedger(landing);
    const report = findNearDuplicates(read.values, { threshold, fields });
    if (flags.json === true) {
      io.out(jsonStable({ landing, ...report }));
    } else {
      io.out(line(`RK_NEAR_DUP_LANDING=${toPosix(landing)}`));
      io.out(line(`RK_NEAR_DUP_ENTRIES=${report.entries}`));
      io.out(line(`RK_NEAR_DUP_THRESHOLD=${report.threshold}`));
      io.out(line(`RK_NEAR_DUP_FIELDS=${report.fields.join(',')}`));
      io.out(line(`RK_NEAR_DUP_COMPARED=${report.compared}`));
      io.out(line(`RK_NEAR_DUP_PAIRS=${report.pairs.length}`));
      io.out(line(`RK_NEAR_DUP_SAME_RULE=${report.pairs.filter((p) => p.sameRule).length}`));
      if (report.truncated) io.out(line('RK_NEAR_DUP_TRUNCATED=true'));
      for (const p of report.pairs) {
        io.out(line(`PAIR ${p.score} ${p.aId} ~ ${p.bId} rule=${p.aRule ?? '-'}/${p.bRule ?? '-'} sameRule=${p.sameRule}`));
      }
    }
    const found = report.pairs.length > 0;
    io.out(resultLine('LEDGER_NEAR_DUP', flags['fail-on-found'] === true ? !found : true));
    return flags['fail-on-found'] === true && found ? RC.FAIL : RC.OK;
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
  record: '用法: dsh-rulekeeper record --landing <落点> --rule <r> --problem <p> --root-cause <r> --solution <s> [--category <c>] [--mechanism <m>] [--guard-ref <hook:x|gate:y>] [--evidence <a,b>] [--now <ISO>]\n退出码: 0 成功 / 1 写入失败 / 2 用法错误',
  mutate: '用法: dsh-rulekeeper mutate --landing <落点> --id <条目id> --set <字段>=<值> [--set 证据加=<文本>]... --by <谁> --reason <为什么> [--apply] [--now <ISO>] [--json]\n'
    + '说明: **改一条已有教训**的唯一通路（不必再手工编辑 ledger.jsonl）。默认 dry-run；--apply 才落盘。\n'
    + '      不改历史行：追加一条**归档行**（mechanism=mutate，evidence 首项 MUTATES <id>）+ 一条**状态事件行**（STATUS_SUPERSEDE <id>），\n'
    + '      由读侧 supersededIds() fold ⇒ 效果上"这条教训变了"，物理上历史逐字节不变。\n'
    + '      可改字段：problem / root_cause / solution / mechanism / guard_ref / category（身份字段 id/ts/rule 禁改）；\n'
    + '      可重复 --set 证据加=... 往证据里加一项（不改写已有证据）。\n'
    + '      落盘路径：备份（回读 sha256）→ 写临时件 → 回读校验（行数 + 旧行确实被取代）→ 原子替换 → 失败逐字节回滚。\n'
    + '      诚实边界：--by 是**声明**不是签名（与 --by human 同族）。\n'
    + '退出码: 0 成功（或 dry-run 通过）/ 1 判定不合格（目标不存在/无可改内容/回滚）/ 2 用法错误',
  rules: USAGE_RULES,
  redact: USAGE_REDACT,
  evolve: '用法: dsh-rulekeeper evolve --landing <落点> [--quality <file.json>] [--source auto|human] [--escalate-gate] [--rule <纪律>] [--dry-run] [--now <ISO>] [--json]\n'
    + '说明: 复发 ≥2 的纪律 -> 生成 proposals/<id>.json（**闸先于写者**：绝不写 rules.json）；\n'
    + '      提案四要件（LF-295）缺一即失败；--escalate-gate 属"升门禁"，必须 --source human。\n'
    + '退出码: 0 无 error 级问题 / 1 有不合格提案或被闸门拒绝 / 2 用法错误',
  report: '用法: dsh-rulekeeper report --landing <落点> [--project <项目根>] [--now <ISO>] [--json]\n退出码: 0 成功 / 1 读失败 / 2 用法错误',
  effect: USAGE_EFFECT,
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
  if (sub === 'commitmsg') return runGateCommitmsg(rest, io, env);
  if (sub === 'refs') return runGateRefs(rest, io, env);
  if (sub === 'postcommit') return runGatePostcommit(rest, io, env);
  if (sub === 'bypass') return runGateBypass(rest, io, env);
  if (sub === 'ci') return runGateCi(rest, io, env);
  if (sub === 'close') return runGateClose(rest, io, env);
  if (sub === 'hooks') return runGateHooks(rest, io, env);
  io.err(`rk-gate: 未知子命令 "${sub}"\n${USAGE_GATE}\n`);
  return RC.USAGE;
}

/** `rk-gate commitmsg`（2026-09-21，教训 L652）：**提交正文**的公开面门禁（由 `commit-msg` / `pre-push` 钩子调用） */
export function runGateCommitmsg(argv, io = defaultIo(), env = process.env) {
  let flags;
  try {
    flags = scanFlags(argv, { '--file': 'string', '--range': 'string', '--repo': 'string', '--landing': 'string', '--json': 'boolean', '--help': 'boolean' });
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`rk-gate commitmsg: ${err.message}\n用法: rk-gate commitmsg --file <提交正文文件> | --repo <仓库根> --range <A..B> [--json]\n`);
      return RC.USAGE;
    }
    throw err;
  }
  if (flags.help === true) {
    io.out('用法: rk-gate commitmsg --file <提交正文文件> [--json]\n'
      + '      rk-gate commitmsg --repo <仓库根> --range <A..B> [--json]\n'
      + '作用: 用公开面模式表扫**提交正文**（丢弃 `#` 注释行与剪刀线之后的 diff）；有泄漏 ⇒ exit≠0。\n'
      + '两道检查点: `commit-msg`（单条，提交那刻）与 `pre-push`（区间，**离机之前**最后一道）。\n');
    return RC.OK;
  }
  const hasFile = typeof flags.file === 'string' && flags.file.trim() !== '';
  const hasRange = typeof flags.range === 'string' && flags.range.trim() !== '';
  if (hasFile === hasRange) {
    io.err('rk-gate commitmsg: 二选一 —— `--file <提交正文文件>`（commit-msg）或 `--repo <仓库根> --range <A..B>`（pre-push）\n');
    return RC.USAGE;
  }
  // ── **档位口径唯一**（P16，2026-09-23）──────────────────────────────────────────
  // 现场：`precommit` 走 `resolveRepoPatterns`（读落点 `repoKind`），而本命令与 `refs` 却**没传落点**
  // ⇒ `resolveLeakPatterns` 兜底成"公开仓完整表" ⇒ **同一段 identity 文本：文件面 pass、正文面 fail**
  // （被治理项目被拦过一次，且他们那档是 private）。修法是**让三面读同一个口径**。
  // ⚠ **只在落点真的存在时才传它**（实测教训）：`resolveRepoPatterns` 对"没有声明"的兜底是 **private**（少扫一类），
  // 而"压根没落点"应当走**保守默认（公开面完整表）**。若把"不存在的落点路径"也传进去，
  // 没配落点的仓会从"多扫一类"退化成"少扫一类" —— 那等于修 P16 时把检查放松了。
  const resolveLeakLanding = (repoRoot) => {
    const explicit = typeof flags.landing === 'string' && flags.landing.trim() !== '' ? resolve(flags.landing) : null;
    const candidate = explicit ?? (() => { try { return resolveProjectLanding(resolve(repoRoot)); } catch { return null; } })();
    if (candidate === null) return null;
    // 落点必须**有 config.json** 才算"声明过档位"；否则交给 resolveLeakPatterns 走保守默认
    return existsSync(join(candidate, 'config.json')) ? candidate : null;
  };
  const repoRootForLeak = hasFile
    ? resolve(flags.repo ?? process.cwd())
    : resolve(flags.repo ?? process.cwd());
  const r = hasFile
    ? commitMessageGate({ messageFile: resolve(flags.file), repoRoot: repoRootForLeak, landingDir: resolveLeakLanding(repoRootForLeak) })
    : commitMessageGate({ repoRoot: repoRootForLeak, range: flags.range.trim(), landingDir: resolveLeakLanding(repoRootForLeak) });
  if (flags.json === true) {
    io.out(jsonStable(r));
    return r.ok === true ? RC.OK : RC.FAIL;
  }
  io.out(line(`RK_GATE_COMMITMSG_MODE=${r.mode}`));
  if (hasFile) io.out(line(`RK_GATE_COMMITMSG_FILE=${toPosix(resolve(flags.file))}`));
  if (hasRange) {
    io.out(line(`RK_GATE_COMMITMSG_RANGE=${r.range}`));
    io.out(line(`RK_GATE_COMMITMSG_COMMITS=${r.commits.length}`));
  }
  io.out(line(`RK_GATE_COMMITMSG_LINES=${r.scannedLines}`));
  io.out(line(`RK_GATE_COMMITMSG_LEAKS=${r.findings.length}`));
  for (const f of r.findings) io.out(line(`FINDING ${f.code} ${f.commit ?? '-'} ${f.match ?? '-'} ${f.message}`));
  io.out(resultLine('COMMITMSG', r.ok === true));
  if (r.ok !== true) io.err(`rk-gate commitmsg: 提交正文未过公开面脱敏（${r.findings.map((f) => f.code).join(',')}）——**推送前**改掉（amend / rebase 改消息），一旦推送就撤不回来\n`);
  return r.ok === true ? RC.OK : RC.FAIL;
}

/** `rk-gate refs`（2026-09-21）：**引用名**（分支/tag）的公开面门禁（由 `pre-push` 调用，refs 来自 stdin） */
export function runGateRefs(argv, io = defaultIo(), env = process.env) {
  let flags;
  try {
    flags = scanFlags(argv, { '--file': 'string', '--repo': 'string', '--landing': 'string', '--json': 'boolean', '--help': 'boolean' });
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`rk-gate refs: ${err.message}\n用法: rk-gate refs --file <refs 文件（每行 <localRef> <localSha> <remoteRef> <remoteSha>）> [--json]\n`);
      return RC.USAGE;
    }
    throw err;
  }
  if (flags.help === true) {
    io.out('用法: rk-gate refs --file <refs 文件> [--json]\n'
      + '作用: 扫**推送引用名**（分支/tag）的公开面；有泄漏 ⇒ exit≠0。refs 文件就是 `pre-push` 的 stdin 内容。\n');
    return RC.OK;
  }
  if (typeof flags.file !== 'string' || flags.file.trim() === '') {
    io.err('rk-gate refs: 必须给 --file <refs 文件>（pre-push 的 stdin 内容）\n');
    return RC.USAGE;
  }
  const file = resolve(flags.file);
  let text = '';
  if (existsSync(file)) {
    try { text = readFileSync(file, 'utf8'); } catch { text = ''; }
  }
  // **档位口径唯一**（P16）：与 `precommit`/`commitmsg` 同源 —— 引用名同样按落点 `repoKind` 分档。
  // refs 的 stdin 里没有仓库路径，故落点按 `--repo`（缺省 cwd）解析；显式 `--landing` 优先。
  const refsRepoRoot = resolve(flags.repo ?? process.cwd());
  const refsLanding = (() => {
    const explicit = typeof flags.landing === 'string' && flags.landing.trim() !== '' ? resolve(flags.landing) : null;
    const candidate = explicit ?? (() => { try { return resolveProjectLanding(refsRepoRoot); } catch { return null; } })();
    if (candidate === null) return null;
    // 与 commitmsg 同一取舍：落点必须**有 config.json** 才算"声明过档位"（否则走保守默认，而不是退化成 private）
    return existsSync(join(candidate, 'config.json')) ? candidate : null;
  })();
  const r = refsGate({ text, repoRoot: refsRepoRoot, landingDir: refsLanding });
  if (flags.json === true) {
    io.out(jsonStable(r));
    return r.ok === true ? RC.OK : RC.FAIL;
  }
  io.out(line(`RK_GATE_REFS_FILE=${toPosix(file)}`));
  io.out(line(`RK_GATE_REFS_CHECKED=${r.refs.length}`));
  io.out(line(`RK_GATE_REFS_LEAKS=${r.findings.length}`));
  for (const f of r.findings) io.out(line(`FINDING ${f.code} ${f.ref ?? '-'} ${f.match ?? '-'} ${f.message}`));
  io.out(resultLine('REFS', r.ok === true));
  if (r.ok !== true) io.err('rk-gate refs: 推送的引用名未过公开面脱敏——**推送前**改名（改名后旧名仍可能留在远端，别用内部名建分支）\n');
  return r.ok === true ? RC.OK : RC.FAIL;
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
  // **档位口径唯一**（P16）：与 `commitmsg`/`refs` 一致 —— 未显式给 `--landing` 时也解析**项目落点**，
  // 否则 `repoPatterns` 会退回"远端探测 → 兜底 private"，同一段文本在三面上的判定就可能不同。
  const landingDir = flags.landing === undefined
    ? (() => { try { return resolveProjectLanding(repoRoot); } catch { return undefined; } })()
    : resolve(flags.landing);
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
      '--write-workflow': 'boolean', '--workflow': 'string', '--workflow-range': 'string', '--no-test-job': 'boolean',
      '--tool-repo': 'string', '--tool-ref': 'string',
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
  // `--tool-repo` 下 bin 的口径**由本工具钉死**：`binPath` 表达的是**工具仓内部**的入口
  //   （前缀由 `ciWorkflowYaml` 加**一次**）。实测坑：两侧各加一次前缀 ⇒ 路径变成
  //   `.dsh-rulekeeper-tool/.dsh-rulekeeper-tool/bin/…`（真机验收当场抓到）。
  const ciBinPath = flags.bin ?? (flags['tool-repo'] !== undefined ? 'bin/rk-gate.mjs' : undefined);
  if (flags['write-workflow'] === true) {
    const w = (() => {
      try {
        return writeCiWorkflow({
          projectRoot: repoRoot,
          rel: flags.workflow ?? CI_WORKFLOW_REL,
          binPath: ciBinPath,
          nodeVersion: flags['node-version'],
          range: flags['workflow-range'],
          // 消费方仓开关：本仓没有本包的全量用例时，带上 test 作业会让 CI **恒红**（实测）
          withTestJob: flags['no-test-job'] !== true,
          // 消费方仓开关：从**独立 checkout 的钉版本工具仓**跑 gate（本包零依赖，CI 里无需 npm install）
          toolRepo: flags['tool-repo'],
          toolRef: flags['tool-ref'],
        });
      } catch (err) {
        // 生成期就拒绝（而不是写出一份"看起来能跑、其实钉错 ref"的工作流）
        io.err(`rk-gate ci --write-workflow: ${err?.message ?? err}\n`);
        return { ok: false, reason: 'usage', usage: true };
      }
    })();
    if (w.usage === true) return RC.USAGE;
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
    withTestJob: flags['no-test-job'] === true ? false : undefined,
    toolRepo: flags['tool-repo'],
    toolRef: flags['tool-ref'],
    binPath: ciBinPath,
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
      '--names': 'string', '--adopt-existing': 'boolean', '--json': 'boolean', '--help': 'boolean',
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
    // `--names`（P13）：逗号/空白分隔的 hook 名单（`pre-commit,post-commit`）。库层一直支持 `opts.names`，
    // 只是 CLI 没暴露 ⇒ "只想装/校验其中几件"这件事在命令行上做不到。空值/空项按**用法错误**处置
    // （静默当成"全装"会让人以为指定生效了）。
    let names;
    if (flags.names !== undefined) {
      names = String(flags.names).split(/[,;\s]+/).map((s) => s.trim()).filter((s) => s !== '');
      if (names.length === 0) {
        io.err(`rk-gate hooks install: --names 为空（应形如 --names pre-commit,post-commit）\n${USAGE_GATE}\n`);
        return RC.USAGE;
      }
      const unknown = names.filter((n) => !KNOWN_HOOK_NAMES.includes(n));
      if (unknown.length > 0) {
        io.err(`rk-gate hooks install: --names 含未知 hook 名 ${unknown.join(', ')}（只支持 ${KNOWN_HOOK_NAMES.join(' / ')}）\n${USAGE_GATE}\n`);
        return RC.USAGE;
      }
    }
    const r = installHooks({
      repoRoot,
      hooksPath: flags['hooks-path'] ?? DEFAULT_HOOKS_PATH,
      gateBin: join(PKG_ROOT, 'bin', 'rk-gate.mjs'),
      names,
      force: flags.force === true,
      adoptExisting: flags['adopt-existing'] === true,
      setConfig: flags['no-config'] !== true,
    });
    if (flags.json === true) {
      io.out(jsonStable({
        ok: r.ok,
        hooksPath: r.hooksPath,
        installed: r.installed ?? [],
        skipped: r.skipped ?? [],
        runnerSha256: r.runnerSha ?? null,
        configSet: r.configSet ?? false,
        reasons: r.reasons ?? [],
      }));
      return r.ok ? RC.OK : RC.FAIL;
    }
    io.out(line(`RK_GATE_HOOKS_ACTION=install`));
    io.out(line(`RK_GATE_HOOKS_PATH=${r.hooksPath}`));
    io.out(line(`RK_GATE_HOOKS_NAMES=${(r.names ?? []).join(',')}`));
    io.out(line(`RK_GATE_HOOKS_INSTALLED=${(r.installed ?? []).length}`));
    io.out(line(`RK_GATE_HOOKS_SKIPPED=${(r.skipped ?? []).length}`));
    io.out(line(`RK_GATE_HOOKS_ADOPTED=${(r.adopted ?? []).length}`));
    io.out(line(`RK_GATE_HOOKS_RETAINED=${(r.retained ?? []).length}`));
    io.out(line(`RK_GATE_HOOKS_CONFIG_SET=${r.configSet === true}`));
    io.out(line(`RK_GATE_HOOKS_RUNNER_SHA256=${short(r.runnerSha)}`));
    for (const h of r.installed ?? []) io.out(line(`HOOK ${h.adopted === true ? 'adopted' : 'installed'} ${h.name} sha256=${short(h.sha256)} bytes=${h.bytes}`));
    for (const s of r.skipped ?? []) io.out(line(`HOOK skipped ${s.name} sha256=${short(s.sha256)}: ${s.reason}`));
    for (const h of r.retained ?? []) io.out(line(`HOOK retained ${h.name} sha256=${short(h.sha256)}（本次没点名，清单里保留）`));
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
      localStatePresent: v.localStatePresent === true,
      scope: v.scope ?? 'manifest',
      stateSource: v.stateSource ?? 'none',
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
  // P14：跨机核的是**钩子名**（清单入库）；runner 指纹是**本机事实**（hooks.local.json）。分开可读。
  io.out(line(`RK_GATE_HOOKS_LOCAL_STATE=${v.localStatePresent === true ? 'present' : 'missing'}`));
  io.out(line(`RK_GATE_HOOKS_SCOPE=${v.scope ?? 'manifest'}`));
  io.out(line(`RK_GATE_HOOKS_STATE_SOURCE=${v.stateSource ?? 'none'}`));
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
    case 'mutate': return runCliMutate(argv, io, env);
    case 'rules': return runRules(argv, io, env);
    case 'report': return runCliReport(argv, io, env);
    case 'snap': return runSnap(['take', ...argv], io, env);
    case 'gate': return runGate(argv, io, env);
    case 'redact': return runRedact(argv, io, env);
    case 'evolve': return runCliEvolve(argv, io, env);
    case 'effect': return runCliEffect(argv, io, env);
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

/** 落点父目录里推断项目根（`<项目>/.dsh-ai/rulekeeper` 形态）；推不出则退回 cwd */
function projectRootOfLanding(landing) {
  const parts = String(landing).split(/[\\/]/).filter((s) => s !== '');
  if (parts.length >= 2 && parts[parts.length - 2] === '.dsh-ai') {
    const guess = resolve(parts.slice(0, -2).join('/'));
    if (existsSync(guess)) return guess;
  }
  return process.cwd();
}

/**
 * `dsh-rulekeeper effect <plan|verify|apply|inject>`（LF-A* **生效闭环**）。
 *
 * rc 契约（沿用既有数值，不新增码——§9.8 契约变更纪律）：
 *   0 = 通过（plan 无 error 级 finding / verify 全过 / apply 成功或 dry-run 通过 / inject 计划产出）
 *   1 = **判定不合格**（只写下来了、绑定空转、验证未过、被闸门拒绝并回滚）
 *   2 = 用法错误（缺子命令/未知参数/缺 --by/--by 取值非法/--proposal 不存在）
 */
function runCliEffect(argv, io, env) {
  const EFFECT_SUBS = ['plan', 'verify', 'apply', 'inject', 'usage', 'draft-activation', 'adopt'];
  const sub = argv[0] ?? null;
  if (sub === null || !EFFECT_SUBS.includes(sub)) {
    io.err(`dsh-rulekeeper effect: 需要子命令（${EFFECT_SUBS.join('|')}）\n${USAGE_EFFECT}\n`);
    return RC.USAGE;
  }
  const parsed = parseSub('effect', argv.slice(1), {
    '--landing': 'string', '--project': 'string', '--now': 'string', '--stale-days': 'string',
    '--proposal': 'string', '--all': 'boolean', '--by': 'string', '--apply': 'boolean',
    '--pattern': 'string[]', '--gate': 'string', '--max-per-session': 'string', '--json': 'boolean',
    '--carrier': 'string',
    '--limit': 'string', '--write': 'boolean', '--allow-exec': 'boolean',
  }, io);
  if (parsed.error !== null) return parsed.error;
  const flags = parsed.flags;
  const target = resolveLanding('effect', flags, io);
  if (target.error !== null) return target.error;
  const landing = target.landing;
  const projectRoot = flags.project === undefined ? projectRootOfLanding(landing) : resolve(flags.project);
  const now = flags.now === undefined ? new Date() : new Date(flags.now);
  if (Number.isNaN(now.getTime())) {
    io.err(`dsh-rulekeeper effect: --now 不是合法时间: ${flags.now}\n`);
    return RC.USAGE;
  }
  const intFlag = (key, fallback) => {
    if (flags[key] === undefined) return fallback;
    if (!/^\d+$/.test(flags[key])) return null;
    return Number(flags[key]);
  };
  const staleDays = intFlag('stale-days', DEFAULT_STALE_DAYS);
  const maxPerSession = intFlag('max-per-session', 5);
  if (staleDays === null || maxPerSession === null) {
    io.err('dsh-rulekeeper effect: --stale-days / --max-per-session 需要非负整数\n');
    return RC.USAGE;
  }

  if (sub === 'draft-activation') {
    // 机器起草"条目级可判激活条件"（objective ②）：**默认只出草稿**，`--write` 才写注解层。
    // 为什么写注解层而不是改账本：账本 append-only 不可原地改写（LF-120），注解层是唯一合法通路
    // （协议与理由见 src/annotations.mjs 顶部）。
    const limit = flags.limit === undefined ? Infinity : Number(flags.limit);
    if (flags.limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
      io.err(`rk-effect draft-activation: --limit 需要非负整数，实得 ${JSON.stringify(flags.limit)}\n`);
      return RC.USAGE;
    }
    const rows = readLedger(landing).values;
    const result = draftActivations(rows, { limit });
    const byId = activationsById(landing);
    // 已经注解过的行不再起草（幂等：重复跑不会把注解层灌满）
    const todo = result.drafts.filter((d) => !byId.has(d.id));
    if (flags['write'] === true) {
      if (flags.dryRun === true) {
        // parseSub 未必认识 --dry-run；这里只是把语义写清：--write 与 --dry-run 同时给 = 不写
      }
      let written = 0;
      let failed = 0;
      for (const d of todo) {
        const r = appendAnnotation(landing, { id: d.id, activation: d.activation, by: 'machine', confidence: d.confidence, evidence: d.anchors }, { now });
        if (r.ok === true) written += 1;
        else {
          failed += 1;
          if (failed <= 3) io.err(`draft-activation: 写入失败（${d.id}）: ${r.reason}\n`);
        }
      }
      const after = effectPlan({ landingDir: landing, projectRoot, now, staleDays });
      io.out(line(`RK_DRAFT_WRITTEN=${written}`));
      io.out(line(`RK_DRAFT_FAILED=${failed}`));
      io.out(line(`RK_DRAFT_COVERAGE_AFTER=${after.entryStats.withActivation}/${after.entryStats.entries}`));
      io.out(line(`RK_DRAFT_COVERAGE_PCT=${(after.entryStats.coverage * 100).toFixed(2)}`));
    }
    io.out(line(`RK_DRAFT_LANDING=${toPosix(landing)}`));
    io.out(line(`RK_DRAFT_ROWS=${result.stats.rows}`));
    io.out(line(`RK_DRAFT_ALREADY=${rows.length - result.stats.rows}`));
    io.out(line(`RK_DRAFT_ANNOTATED=${[...byId.keys()].length}`));
    io.out(line(`RK_DRAFT_PENDING=${todo.length}`));
    // ── **P8：两个"草稿数"不是一回事，输出必须替它们说清**（2026-09-23）────────────────────────
    // 现场：`RK_DRAFT_ANNOTATED`（**注解层**已覆盖的条目数）与 `adopt` 段的 `DRAFTS`
    // （**由规格派生出的绑定草稿数**）并排出现在同一屏，语义完全不同 ⇒ 实测被读成
    // "注解了 34 条却一个字没草拟？自相矛盾"（连 lowQuality 的结论也跟着被误读）。
    // 改法：① 给两个数各加**自解释**的名字（旧名保留，兼容既有消费方）；② 打印一行明确的关系说明。
    io.out(line(`RK_ACTIVATION_ANNOTATED=${[...byId.keys()].length}（**注解层**：条目级"何时适用"已被注解覆盖的行数）`));
    io.out(line(`RK_ACTIVATION_PENDING=${todo.length}（**待起草**：本次能起草但还没进注解层的条目数）`));
    io.out(line(`RK_ACTIVATION_DIMENSION_NOTE=本条命令只产"**条目级激活条件注解**"（何时适用）；`
      + '它**不产绑定草稿**——绑定草稿由 `rk-effect adopt` 的 `DRAFTS` 给出（**规格派生**，回答"哪条纪律该挂哪个检查器"）。'
      + '两个数**不同维度、不可比**：本行的 ANNOTATED/PENDING 与 adopt 的 DRAFTS/ALREADY_BOUND 不要并排读成同一件事。'));
    io.out(line(`RK_DRAFT_HIGH=${todo.filter((d) => d.confidence === 'high').length}`));
    io.out(line(`RK_DRAFT_MEDIUM=${todo.filter((d) => d.confidence === 'medium').length}`));
    io.out(line(`RK_DRAFT_NO_ANCHOR=${result.stats.noAnchor}`));
    io.out(line(`RK_DRAFT_LOW_QUALITY=${result.stats.lowQuality}`));
    if (flags.json === true) {
      io.out(jsonStable({ landing, stats: result.stats, drafts: todo.slice(0, 50), noAnchor: result.noAnchor.slice(0, 50), lowQuality: result.lowQuality.slice(0, 20) }));
    } else {
      for (const d of todo.slice(0, 10)) io.out(line(`DRAFT ${d.id} [${d.confidence}] ${d.activation}`));
      if (todo.length > 10) io.out(line(`…（其余 ${todo.length - 10} 条见 --json）`));
    }
    io.out(resultLine('EFFECT_DRAFT_ACTIVATION', true));
    return RC.OK;
  }

  if (sub === 'adopt') {
    // P2 自动管线三段（2026-09-21）：机制面必填 + 可机械化类目自动出绑定草稿。
    // 默认 dry-run；`--apply` 才把草稿写进 `proposals/<id>.json`（**不碰** rules.json —— 唯一写通路仍是 apply）。
    const report = adoptionReport({ landingDir: landing, projectRoot, now });
    if (report.ok !== true) {
      for (const f of report.findings) io.err(`rk-effect adopt: ${f.code}: ${f.message}\n`);
      io.out(resultLine('EFFECT_ADOPT', false));
      return RC.FAIL;
    }
    let written = [];
    let skipped = [];
    if (flags.apply === true) {
      const out = writeDrafts(landing, report.drafts);
      written = out.written;
      skipped = [...report.drafts.filter((d) => out.skipped.some((s) => s.rule === d.rule)).map((d) => ({ rule: d.rule })), ...out.skipped];
      for (const f of out.findings) io.out(line(`FINDING ${f.code} error ${f.rule ?? '-'} ${f.message}`));
    }
    const s = report.stats;
    io.out(line(`RK_ADOPT_LANDING=${toPosix(landing)}`));
    io.out(line(`RK_ADOPT_ENTRIES=${s.entries} EVENT_ROWS=${s.eventRows} RULES=${s.rules}`));
    io.out(line(`RK_ADOPT_FACE text=${s.faceCount.text} mechanized=${s.faceCount.mechanized} guard=${s.faceCount.guard} question=${s.faceCount.question} unregistered=${s.faceCount.unregistered}`));
    io.out(line(`RK_ADOPT_SPECS=${s.specs} SPECS_SKIPPED=${s.specsSkipped ?? 0} DRAFTS=${s.drafts} ALREADY_BOUND=${s.alreadyBound} OPEN_PROPOSAL=${s.openProposal}`));
    // **P8**：`DRAFTS` 是"**规格派生**的绑定草稿数"（该挂哪个检查器），与 `draft-activation` 的
    // `RK_ACTIVATION_ANNOTATED/PENDING`（条目级"何时适用"注解）**不同维度**。自解释名 + 关系说明。
    io.out(line(`RK_ADOPT_BINDING_DRAFTS=${s.drafts}（**规格派生**的绑定草稿：规格在、尚未绑定的纪律数）`
      + `；与 draft-activation 的注解层计数不是同一件事（见该命令的 RK_ACTIVATION_DIMENSION_NOTE）`));
    // **账本自称 vs 实际已绑**（P21）：两个数分开命名、各自标明来源，禁止被读成同一件事。
    io.out(line(`RK_ADOPT_BINDINGS source=rules.json rules=${s.boundRules} checker_rules=${s.boundCheckerRules} checks=${s.boundChecks}`));
    io.out(line(`RK_ADOPT_LEDGER_SELFCLAIM source=ledger.jsonl mechanized=${s.faceCount.mechanized}（账本自称的"已机械化"条数；与上面检查器绑定数**不是同一件事**）`));
    for (const sk of report.skippedSpecs ?? []) io.out(line(`RK_ADOPT_SPEC_SKIPPED rel=${sk.rel} reason=${sk.reason}`));
    io.out(line(`RK_ADOPT_APPLIED=${flags.apply === true ? 1 : 0} WRITTEN=${written.length} SKIPPED=${skipped.length}`));
    for (const p of report.plans) io.out(line(`RK_ADOPT_PLAN rule=${p.rule} entries=${p.entries} spec=${p.spec} decision=${p.decision}`));
    for (const d of report.drafts) io.out(line(`RK_ADOPT_DRAFT rule=${d.rule} spec=${d.spec} proposal=${d.proposal.id}`));
    for (const w of written) io.out(line(`RK_ADOPT_WROTE ${w.rule} ${w.id} ${w.path}`));
    for (const f of report.findings) io.out(line(`FINDING ${f.code} ${f.rule === undefined ? 'warn' : 'error'} ${f.rule ?? '-'} ${f.message}`));
    if (flags.json === true) io.out(jsonStable({ stats: report.stats, plans: report.plans, drafts: report.drafts.map((d) => d.proposal), written }));
    // rc：有 error 级 finding（机制面未登记 / 规格坏了）⇒ 1；否则 0（草稿本身不是失败）
    const hasError = report.findings.some((f) => f.rule !== undefined);
    io.out(resultLine('EFFECT_ADOPT', !hasError));
    return hasError ? RC.FAIL : RC.OK;
  }

  if (sub === 'usage') {
    // P0-3 配套的**读者面**（2026-09-19 修缺口）：此前 `usage.json` 只有写者（deliver/prestep 投递时计数），
    // 唯一的读者是**用例** ⇒ "度量没人看 = 没有度量"（与 L635"取值面未接线"同族：写得出 ≠ 有人读）。
    const us = usageSummary(landing);
    if (flags.json === true) {
      io.out(jsonStable(us));
    } else {
      io.out(line(`RK_EFFECT_USAGE_FILE=${toPosix(join(landing, USAGE_FILE))}`));
      io.out(line(`RK_EFFECT_USAGE_RULES=${us.rows.length}`));
      io.out(line(`RK_EFFECT_USAGE_EMITTED=${us.totalEmitted}`));
      io.out(line(`RK_EFFECT_USAGE_EVALUATED=${us.totalEvaluated}`));
      // 按会话读数（2026-09-21 计数器语义）：`EMITTED` 是**投递动作**计数（混了通道数与重启次数），
      // 这里补"到底投给过几个会话 + 根通道最近投过什么"，两个数一起看才不会把动作数当命中数。
      io.out(line(`RK_EFFECT_USAGE_SESSIONS=${us.sessions}`));
      io.out(line(`RK_EFFECT_USAGE_ROOT_EMISSION ${us.rootEmission === null ? 'sha=- at=-' : `sha=${String(us.rootEmission.sha).slice(0, 8)} at=${us.rootEmission.at ?? '-'}`}`));
      for (const s of us.sessionRows.slice(0, 5)) {
        if (s.root === true) continue;
        io.out(line(`RK_EFFECT_USAGE_SESSION ${s.key} sha=${s.sha === null ? '-' : String(s.sha).slice(0, 8)} at=${s.at ?? '-'}`));
      }
      for (const r of us.rows) {
        io.out(line(`RK_EFFECT_USAGE_ROW ${r.rule} emitted=${r.emitted} evaluated=${r.evaluated} lastAt=${r.lastAt ?? '-'}`));
      }
      if (us.rows.length === 0) io.out(line('（空账：没有任何提醒被投递过——要么从未装载投递通道，要么落点一直 no-landing）'));
    }
    io.out(resultLine('EFFECT_USAGE', true));
    return RC.OK;
  }

  if (sub === 'plan') {
    const plan = effectPlan({ landingDir: landing, projectRoot, now, staleDays });
    if (flags.json === true) {
      io.out(jsonStable(plan));
    } else {
      io.out(line(`RK_EFFECT_RULES=${plan.items.length}`));
      for (const s of EFFECT_STATES) io.out(line(`RK_EFFECT_${s.toUpperCase()}=${plan.counts[s] ?? 0}`));
      io.out(line(`RK_EFFECT_TEXT_ONLY=${plan.findings.filter((f) => f.code === 'EFFECT_TEXT_ONLY').length}`));
      io.out(line(`RK_EFFECT_UNENFORCED=${plan.findings.filter((f) => f.code === 'EFFECT_BINDING_UNENFORCED').length}`));
      io.out(line(`RK_EFFECT_UNVERIFIED=${plan.findings.filter((f) => f.code === 'EFFECT_NOT_VERIFIED').length}`));
      io.out(line(`RK_EFFECT_RECURRED_AFTER=${plan.findings.filter((f) => f.code === 'EFFECT_RECURRED_AFTER_ACTIVATION').length}`));
      // P0-2 新口径（2026-09-19）：**条目级**可判激活条件覆盖——比"类目是否绑定"可机械统计，
      // 且直接指出缺的是原料（可判条件/指纹），而不是含糊地报"21/22 没绑定"。
      const es = plan.entryStats ?? { entries: 0, withActivation: 0, withoutActivation: 0, coverage: 0 };
      io.out(line(`RK_EFFECT_ENTRY_ACTIVATION=${es.withActivation}/${es.entries}`));
      io.out(line(`RK_EFFECT_ENTRY_COVERAGE=${(es.coverage * 100).toFixed(2)}`));
      // 用量遥测读数（2026-09-19）：体检里必须能直接看到"有没有真的投递过"——
      // 否则"投递已接线"只能靠读代码相信（本轮实测：三处落点 usage.json 全不存在，
      // 而体检此前一个字都不提，缺口是靠人肉翻文件才发现的）。
      const us = usageSummary(landing);
      io.out(line(`RK_EFFECT_USAGE_RULES=${us.rows.length}`));
      io.out(line(`RK_EFFECT_USAGE_EMITTED=${us.totalEmitted}`));
      io.out(line(`RK_EFFECT_USAGE_EVALUATED=${us.totalEvaluated}`));
      io.out(line(`RK_EFFECT_USAGE_SESSIONS=${us.sessions}`));   // 按会话读数（2026-09-21）：动作数 ≠ 会话数
      for (const r of us.rows.slice(0, 3)) io.out(line(`RK_EFFECT_USAGE_TOP ${r.rule} emitted=${r.emitted} evaluated=${r.evaluated}`));
      for (const f of plan.findings) io.out(line(`FINDING ${f.code} ${f.severity ?? 'warn'} ${f.rule ?? '-'} ${f.message}`));
    }
    io.out(resultLine('EFFECT', plan.ok === true));
    return plan.ok === true ? RC.OK : RC.FAIL;
  }

  if (sub === 'verify') {
    // `--all` **必须真的被读**（独立 CR nit #10：此前它被解析却从不使用 = 空转 flag，
    // 而 README/RUNBOOK/用例都在传播"verify --all"这个错觉）。语义：显式选择"全部绑定"。
    if (flags.proposal === undefined && flags.all !== true) {
      io.err(`dsh-rulekeeper effect verify: 需要 --proposal <id>（只验某条纪律）或 --all（验全部绑定）\n${USAGE_EFFECT}\n`);
      return RC.USAGE;
    }
    const rules = loadLandingRules(landing).rulesResult.rules;
    const bindings = ruleBindings(rules);
    let entries = [];
    for (const [rule, b] of bindings) for (const c of b.checks) entries.push({ rule, binding: c });
    if (flags.proposal !== undefined) {
      // id 是**输入**：含 `../` 或分隔符时会拼出落点之外的路径（读写都在此列）⇒ 先过安全校验
      if (!isSafeId(flags.proposal)) {
        io.err(`dsh-rulekeeper effect verify: --proposal id 不安全（只允许 [A-Za-z0-9._-] 且禁 ".."）: ${JSON.stringify(flags.proposal)}\n`);
        return RC.USAGE;
      }
      const pf = join(landing, 'proposals', `${flags.proposal}.json`);
      if (!existsSync(pf)) {
        io.err(`dsh-rulekeeper effect verify: 提案不存在: ${toPosix(pf)}\n`);
        return RC.USAGE;
      }
      let proposal;
      try {
        proposal = JSON.parse(readFileSync(pf, 'utf8'));
      } catch (err) {
        io.err(`dsh-rulekeeper effect verify: 提案不是合法 JSON: ${err?.message ?? String(err)}\n`);
        return RC.USAGE;
      }
      const want = canonicalRule(proposal.rule);
      const fromProposal = parseCarrier(proposal.falsePositiveSurface);
      entries = entries.filter((e) => e.rule === want);
      for (const e of entries) {
        if (e.binding.falsePositive === null && fromProposal.kind === 'path') e.binding.falsePositive = fromProposal.value;
      }
    }
    if (entries.length === 0) {
      io.out(line('RK_EFFECT_VERIFY_NONE=1'));
      io.out(line('FINDING EFFECT_NO_BINDING error - 没有任何 checks 生效绑定可验证（先 effect apply 把人签字的提案落成绑定）'));
      io.out(resultLine('EFFECT_VERIFY', false));
      return RC.FAIL;
    }
    let passed = 0;
    let failed = 0;
    for (const e of entries) {
      // checker 绑定会**真的执行**本地命令 ⇒ 必须显式 `--allow-exec`（未许可时如实报 inconclusive，不判通过）
      const report = verifyBinding({
        landingDir: landing, projectRoot, binding: e.binding, falsePositive: e.binding.falsePositive,
        allowExec: flags['allow-exec'] === true,
      });
      for (const c of report.cases) io.out(line(`RK_EFFECT_CASE rule=${e.rule} name=${c.name} expect=${c.expect} got=${c.got} ok=${c.ok}`));
      if (report.state !== undefined) io.out(line(`RK_EFFECT_STATE rule=${e.rule} state=${report.state}`));
      for (const f of report.findings) io.out(line(`FINDING ${f.code} ${f.severity ?? 'error'} ${e.rule} ${f.message}`));
      const wrote = appendVerification(landing, {
        // target 与 plan 的"载体集合"**必须同源**（都走 carrierOfBinding）—— 见 src/checker.mjs 的注释：
        // 此前这里写 `checker:${command[0]}`（=`checker:node`），绑定上又没有 carrier 字段 ⇒
        // plan 的载体集合为空 ⇒ 真跑过验证的绑定被报成"没跑过 verify"。
        rule: e.rule, target: carrierOfBinding(e.binding) ?? '',
        ok: report.ok,
        evidence: [
          `kind=${e.binding.kind}`,
          `carrier=${carrierOfBinding(e.binding) ?? '(none)'}`,
          `gate=${e.binding.gate ?? '(none)'}`,
          ...(e.binding.kind === 'checker' ? [`checkerVersion=${e.binding.checkerVersion ?? '(none)'}`, `state=${report.state ?? 'inconclusive'}`] : []),
        ], now,
      });
      io.out(line(`RK_EFFECT_VERIFY_RULE=${e.rule} RESULT=${report.ok === true ? 'pass' : 'fail'} EVIDENCE=${wrote.ok !== true ? `failed(${wrote.reason ?? ''})` : (wrote.skipped === true ? 'skipped(mode=off)' : 'written')}`));
      if (report.ok === true) passed += 1; else failed += 1;
    }
    io.out(line(`RK_EFFECT_VERIFY_PASSED=${passed} FAILED=${failed}`));
    io.out(resultLine('EFFECT_VERIFY', failed === 0));
    return failed === 0 ? RC.OK : RC.FAIL;
  }

  if (sub === 'apply') {
    if (flags.proposal === undefined) {
      io.err(`dsh-rulekeeper effect apply: 需要 --proposal <id>\n${USAGE_EFFECT}\n`);
      return RC.USAGE;
    }
    if (flags.by === undefined) {
      // **缺 --by 就是用法错误**（不许有默认值）：默认成 human 等于把"人签字"这条红线做成摆设
      io.err(`dsh-rulekeeper effect apply: 需要 --by human（rules.json 只能由人签字写入；没有默认值）\n${USAGE_EFFECT}\n`);
      return RC.USAGE;
    }
    if (!['human', 'auto'].includes(flags.by)) {
      io.err(`dsh-rulekeeper effect apply: --by 只能是 human|auto（收到 ${JSON.stringify(flags.by)}）\n`);
      return RC.USAGE;
    }
    // id 是**输入**（会拼进文件名）：含 `../` 时 `renameSync` 会写到落点之外 ⇒ 先过安全校验、按用法错误处置
    if (!isSafeId(flags.proposal)) {
      io.err(`dsh-rulekeeper effect apply: --proposal id 不安全（只允许 [A-Za-z0-9._-] 且禁 ".."）: ${JSON.stringify(flags.proposal)}\n`);
      return RC.USAGE;
    }
    const out = applyActivation({
      landingDir: landing, projectRoot, proposalId: flags.proposal, by: flags.by,
      patterns: Array.isArray(flags.pattern) ? flags.pattern : undefined,
      gate: flags.gate, carrier: flags.carrier, apply: flags.apply === true, now,
    });
    if (out.ok !== true) {
      io.out(line(`RK_EFFECT_APPLY_CODE=${out.code}`));
      if (out.reasonCode !== null && out.reasonCode !== undefined) io.out(line(`RK_EFFECT_APPLY_REASON_CODE=${out.reasonCode}`));
      if (out.rolledBack === true) io.out(line(`RK_EFFECT_APPLY_ROLLED_BACK=1 RESTORED_SHA=${out.restoredSha ?? '(none)'}`));
      io.err(`dsh-rulekeeper effect apply: ${out.code}: ${out.message}\n`);
      io.out(resultLine('EFFECT_APPLY', false));
      return RC.FAIL;
    }
    io.out(line(`RK_EFFECT_APPLY_RULE=${out.rule} DRYRUN=${out.applied === true ? 0 : 1}`));
    io.out(line(`RK_EFFECT_APPLY_PATTERNS=${(out.additions?.patterns ?? []).join(',') || '(none)'}`));
    io.out(line(`RK_EFFECT_APPLY_CARRIER=${out.additions?.binding?.carrier ?? (out.additions?.binding?.kind === 'checker' ? `checker:${out.additions.binding.redSample?.source ?? '?'}` : '(none)')} GATE=${out.additions?.binding?.gate ?? (out.additions?.binding?.kind === 'checker' ? 'checker' : '(none)')}`));
    if (out.additions?.binding?.kind === 'checker') {
      io.out(line(`RK_EFFECT_APPLY_CHECKER_COMMAND=${(out.additions.binding.command ?? []).join(' ')}`));
      io.out(line(`RK_EFFECT_APPLY_CHECKER_EXPECT=red:${out.additions.binding.expectRed?.exitCode} green:${out.additions.binding.expectGreen?.exitCode}`));
    }
    // 换绑（supersede）必须**打印出来**：dry-run 的 diff 若看不出"旧绑定被摘掉"，
    // 操作者签的就是自己没看见的东西（这正是"dry-run 先行"存在的意义）。
    if (out.additions?.superseded !== undefined && out.additions.superseded !== null) {
      const s = out.additions.superseded;
      io.out(line(`RK_EFFECT_APPLY_SUPERSEDE=${s.identity} FROM_PROPOSAL=${s.proposal ?? '(none)'} ACTIVATED_AT=${s.activatedAt ?? '(none)'} REASON=${s.supersededReason ?? '(none)'}`));
    }
    io.out(line(`RK_EFFECT_APPLY_SHA_BEFORE=${out.beforeSha ?? '(new)'} AFTER=${out.afterSha}`));
    if (out.applied === true) {
      io.out(line(`RK_EFFECT_APPLY_BACKUP=${out.backup ?? '(none)'}`));
      io.out(line(`RK_EFFECT_APPLY_LEDGER=${out.ledger ?? '(none)'}${out.ledgerWarning === null || out.ledgerWarning === undefined ? '' : ` WARNING=${out.ledgerWarning}`}`));
    }
    for (const s of out.steps ?? []) io.out(line(`STEP ${s}`));
    io.out(resultLine('EFFECT_APPLY', true));
    return RC.OK;
  }

  // inject
  const plan = effectInjectPlan({ landingDir: landing, now, maxPerSession });
  if (flags.json === true) {
    io.out(jsonStable(plan));
  } else {
    io.out(line(`RK_EFFECT_INJECT_CANDIDATES=${plan.candidates ?? 0} APPENDED=${plan.appended.length} DROPPED=${plan.dropped.length} LEDGER_ONLY=${plan.ledgerOnly.length}`));
    for (const m of plan.appended) {
      io.out(line(`RK_EFFECT_INJECT id=${m.id} chars=${m.chars} anchor=${escapeControl(m.anchor ?? '')}`));
      io.out(line(m.text));
    }
    for (const f of plan.findings) io.out(line(`FINDING ${f.code} warn - ${f.message}`));
  }
  io.out(resultLine('EFFECT_INJECT', plan.ok === true));
  return plan.ok === true ? RC.OK : RC.FAIL;
}

function runCliRecord(argv, io, env) {
  const parsed = parseSub('record', argv, {
    '--landing': 'string', '--rule': 'string', '--category': 'string', '--problem': 'string',
    '--root-cause': 'string', '--solution': 'string', '--mechanism': 'string', '--guard-ref': 'string', '--evidence': 'string', '--now': 'string',
    '--activation': 'string', '--no-activation': 'string', '--force': 'boolean',
    '--on-near-dup': 'string', '--near-dup-threshold': 'string',
  }, io);
  if (parsed.error !== null) return parsed.error;
  const flags = parsed.flags;
  // 入库近似重复门（E2 实验落地）：默认 **observe**（只报不拦），`--on-near-dup reject` 才拒收。
  // 为什么默认不拦：仓里一贯"先观察再上闸"（规则 40 的 guard 也是 observe 起步）；但**必须报**
  // ——E2 的数字说明伤害发生在入库那一刻，报出来才有机会改。
  const onNearDup = flags['on-near-dup'] ?? 'observe';
  if (!['observe', 'reject', 'off'].includes(onNearDup)) {
    io.err(`dsh-rulekeeper record: --on-near-dup 只能是 observe|reject|off，实得 ${JSON.stringify(flags['on-near-dup'])}\n`);
    return RC.USAGE;
  }
  const nearDupThreshold = flags['near-dup-threshold'] === undefined
    ? DEFAULT_NEAR_DUP_THRESHOLD
    : Number(flags['near-dup-threshold']);
  if (!Number.isFinite(nearDupThreshold) || nearDupThreshold <= 0 || nearDupThreshold > 1) {
    io.err(`dsh-rulekeeper record: --near-dup-threshold 必须在 (0,1]，实得 ${JSON.stringify(flags['near-dup-threshold'])}\n`);
    return RC.USAGE;
  }
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
  // ── 可判激活条件（A4，2026-09-21）：**可见化，不硬拦** ────────────────────────────
  // 现状：`plan` 报 `EFFECT_ENTRY_NO_ACTIVATION`（本仓 27/27），根因是"条件本该挂在条目层、
  // 历史上没人写"。硬拦会逼出灌水条件（把覆盖率刷上去、质量是零 —— E1 实测机器起草齐备率 0/10），
  // **放宽判据更不行**。故选中间档：给 `--activation`（写进行内，走 annotations 的同一套校验）；
  // 不给则打一行**可见警告**（带当前缺口计数），让人当场知道"这条又进了无条件的池子"。
  let activationText = null;
  if (flags.activation !== undefined) {
    const verdict = validateActivation(String(flags.activation));
    if (verdict.ok !== true) {
      io.err(`dsh-rulekeeper record: --activation 不合格（${verdict.reasons.join('；')}）\n`
        + '  要求：8~300 字符，且含至少一个**可观测锚点**（文件路径/扩展名/通配符/命令名/错误串或退出码）\n');
      return RC.USAGE;
    }
    activationText = String(flags.activation).trim();
  } else if (flags['no-activation'] === undefined) {
    io.err('⚠ dsh-rulekeeper record: 这条没给可判激活条件（--activation "当…时"）⇒ 会进"无条件的池子"，\n'
      + '   体检里的 EFFECT_ENTRY_NO_ACTIVATION 计数会 +1。确有理由不给就显式写 --no-activation "<为什么>"。\n');
  }
  // ── 机制面必填（四选一）────────────────────────────────────────────────────────
  // 为什么在这里拦：`mechanism` 决定这条纪律**有没有机械面**（见规则 46）。此前它可以是任意自由文本
  // （空 → 默认 `text`，拼错 → 原样入库），于是"我写了机械判据"这类**自称**也能进账本，
  // 体检面没有任何东西能据此判定 ⇒ 免责成本太低 = 等于没登记。四选一：
  //   text        承认仅文本（会被计入 `RK_EFFECT_TEXT_ONLY`，可见、不静默）
  //   mechanized  有机械判据（adopt 会要求 rules.json 里真有这条绑定）
  //   guard       **拦截面**：git 钩子或 rules.json 的 gates 条目（必须用 --guard-ref 点名靠哪个，
  //               且那个拦截必须真的在 —— 见 src/authier.mjs 的 verifyGuardRef）
  //   question    靠人工问句（收尾/CR 清单里的固定问句）
  const mechanism = flags.mechanism === undefined ? MECHANISM_FACE_DEFAULT : String(flags.mechanism).trim();
  if (!MECHANISM_FACES.includes(mechanism)) {
    io.err(`dsh-rulekeeper record: --mechanism 只能是四选一 ${MECHANISM_FACES.join('|')}（实得 ${JSON.stringify(flags.mechanism)}）\n`
      + '  说明: text=承认仅文本(会被计数) / mechanized=有机械判据 / guard=有拦截面(钩子或门禁) / question=靠人工问句\n');
    return RC.USAGE;
  }
  // ── **写前重读：全作用域前置断言**（2026-09-21，被治理项目侧 P1；真实事故换来）──────────
  // 现场：同一教训已被**另一会话**合规登记（追加取代行），当事人不知情又登了一遍；根因是前置断言
  // 只看了"这一行还能不能改"（**对象局部**），没看"这件事是否已被别处做过"（**全作用域**）。
  // 故此处在写盘前重读落点，把"这条纪律的既有登记面"打印出来，并对"已有 guard 登记"加一道显式确认：
  //   没给 `--force` 就**拒写**（避免两次"同一件事"叠着登记）；给了就是"我知道，仍要追加"。
  // 与 `appendRowsVerified` 的并发检测**互补**：那条管"写入窗口内被改动"，这条管"开始写之前就该知道的事"。
  {
    const preRows = readLedger(target.landing).values;
    const preSuperseded = supersededIds(preRows);
    const sameRule = preRows.filter((r) => canonicalRule(String(r.rule ?? '')) === canonicalRule(String(flags.rule ?? '')));
    const live = sameRule.filter((r) => !preSuperseded.has(String(r.id ?? '')));
    const guardRows = sameRule.filter((r) => String(r.mechanism ?? '').trim() === 'guard');
    const guardRefs = [...new Set(guardRows.map((r) => String(r.guardRef ?? '(未点名)')))] ;
    io.out(line(`RK_RECORD_PRECHECK rule=${canonicalRule(String(flags.rule ?? ''))} entries=${sameRule.length} live=${live.length} guard_rows=${guardRows.length} superseded=${sameRule.length - live.length}`));
    if (guardRows.length > 0) {
      io.err(`⚠ dsh-rulekeeper record: 这条纪律**已有 ${guardRows.length} 条 guard 登记**（拦截面：${guardRefs.join(' / ')}）\n`
        + '   除非这次是**另一件事**，否则重复登记会把正确教训挤出 top-1（E2）。确认要追加请加 --force。\n');
      if (flags.force !== true) {
        io.out(resultLine('RECORD', false));
        return RC.FAIL;
      }
    } else if (live.length > 0) {
      io.err(`ℹ dsh-rulekeeper record: 这条纪律已有 ${live.length} 条存活登记（未取代 ${sameRule.length} 条中）——若属同一次事故请改用 supersede/mutate 而不是再追加一行\n`);
    }
  }

  // ── `guard` 档必须点名**靠哪个拦截**，且那个拦截必须真的在（2026-09-21，交接第 2 步）──────
  // 只写 `mechanism=guard` 等于"我靠拦截面"——没说靠哪个 ⇒ 又成了自称（规则 43 同族）。
  // 形状 `hook:<名>` / `gate:<名>`；存在性由本模块核（钩子在 hooks.json 清单里 / 门禁在 rules.json 里）。
  let guardRef = null;
  if (mechanism === 'guard') {
    if (flags['guard-ref'] === undefined || String(flags['guard-ref']).trim() === '') {
      io.err('dsh-rulekeeper record: mechanism=guard 时必须给 --guard-ref <hook:名|gate:名>（否则"我靠拦截面"是自称，不可核）\n'
        + `  本落点已装钩子: ${installedHooks(target.landing).names.join('/') || '（无）'}\n`
        + `  已登记门禁: ${registeredGates(target.landing).names.join('/') || '（无）'}\n`);
      return RC.USAGE;
    }
    const verdict = verifyGuardRef(target.landing, String(flags['guard-ref']).trim());
    if (verdict.ok !== true) {
      io.err(`dsh-rulekeeper record: --guard-ref 核不过（${verdict.code}）: ${verdict.reason}\n`);
      return RC.USAGE;
    }
    guardRef = verdict.ref;
  } else if (flags['guard-ref'] !== undefined) {
    io.err(`dsh-rulekeeper record: --guard-ref 只在 --mechanism guard 时有意义（当前 ${mechanism}）\n`);
    return RC.USAGE;
  }
  // ── 入库门：这条新问题与账本里已有的某条**过于相似**吗？（与已有行比，不含自己）──────
  if (onNearDup !== 'off') {
    const existing = readLedger(target.landing).values;
    const probe = { id: '(new)', rule: flags.rule, problem: flags.problem };
    const dup = findNearDuplicates([...existing, probe], { threshold: nearDupThreshold });
    const hits = dup.pairs.filter((p) => p.aId === '(new)' || p.bId === '(new)');
    if (hits.length > 0) {
      const top = hits[0];
      const other = top.aId === '(new)' ? top.bId : top.aId;
      if (onNearDup === 'reject') {
        io.err(`dsh-rulekeeper record: 拒收——与已有条目 ${other} 近似重复（相似度 ${top.score} ≥ ${nearDupThreshold}）\n`);
        io.out(line(`RK_RECORD_NEAR_DUP=${other}@${top.score}`));
        io.out(line('RK_RECORD_NEAR_DUP_ACTION=reject'));
        io.out(resultLine('RECORD', false));
        return RC.FAIL;
      }
      io.out(line(`RK_RECORD_NEAR_DUP=${other}@${top.score}`));
      io.out(line(`RK_RECORD_NEAR_DUP_COUNT=${hits.length}`));
      io.out(line('RK_RECORD_NEAR_DUP_ACTION=observe'));
      io.err(`⚠ 近似重复提醒（observe，仍写入）：与 ${other} 相似度 ${top.score} ≥ ${nearDupThreshold}；`
        + '若确为同一次事故，请改用事件行/supersede 而不是 append 新行（E2：重复条目会把正确教训挤出 top-1）\n');
    }
  }
  const result = record({
    rule: flags.rule,
    category: flags.category ?? '未分类',
    problem: flags.problem,
    root_cause: flags['root-cause'],
    solution: flags.solution,
    mechanism,
    ...(guardRef === null ? {} : { guardRef }),
    ...(activationText === null ? {} : { activation: activationText }),
    evidence,
  }, { landingDir: target.landing, now });
  if (!result.ok) {
    io.err(`dsh-rulekeeper record: 写入失败: ${result.reason}\n`);
    return RC.FAIL;
  }
  io.out(line(`RK_RECORD_ID=${result.entry.id}`));
  io.out(line(`RK_RECORD_RULE=${result.entry.rule}`));
  io.out(line(`RK_RECORD_MECHANISM=${result.entry.mechanism}${result.entry.guardRef === undefined ? '' : ` guardRef=${result.entry.guardRef}`}`));
  io.out(line(`RK_RECORD_BYTES=${result.bytes}`));
  io.out(resultLine('RECORD', true));
  return RC.OK;
}

/**
 * `mutate` —— **改一条已有教训**的唯一通路（2026-09-21，交接第 3 步）。
 *
 * 为什么必须有：账本 append-only，"这条机械面登记错了 / 证据写错了"此前只能**手工编辑
 * ledger.jsonl** —— 没有备份、没有回读校验、没有审计。本命令把那条路封掉：
 *   默认 dry-run → `--apply` 才落盘 → 备份（回读 sha256）→ 写临时件 → 回读校验（行数 + 旧行确实
 *   被取代 + 新行 id 在）→ 原子替换 → 失败逐字节回滚。
 *
 * 历史行**逐字节不变**：追加"归档行 + 状态事件行"，由 `supersededIds()` fold。
 * 诚实边界：`--by` 是**声明**不是签名（与 `--by human` 同族）。
 */
function runCliMutate(argv, io, env) {
  const parsed = parseSub('mutate', argv, {
    '--landing': 'string', '--id': 'string', '--set': 'string[]', '--by': 'string', '--reason': 'string',
    '--apply': 'boolean', '--now': 'string', '--json': 'boolean',
  }, io);
  if (parsed.error !== null) return parsed.error;
  const flags = parsed.flags;
  const target = resolveLanding('mutate', flags, io);
  if (target.error !== null) return target.error;
  let now;
  try {
    now = resolveNow({ argv, env }).date;
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`dsh-rulekeeper mutate: ${err.message}\n`);
      return RC.USAGE;
    }
    throw err;
  }
  const missing = ['id', 'by', 'reason', 'set'].filter((k) => flags[k] === undefined);
  if (missing.length > 0) {
    io.err(`dsh-rulekeeper mutate: 缺少必填参数 ${missing.map((k) => `--${k}`).join(' ')}\n${SUB_USAGE.mutate}\n`);
    return RC.USAGE;
  }
  const parsedSets = parseSets(Array.isArray(flags.set) ? flags.set : [flags.set]);
  if (parsedSets.ok !== true) {
    for (const p of parsedSets.problems) io.err(`dsh-rulekeeper mutate: ${p}\n`);
    return RC.USAGE;
  }
  const rows = readLedger(target.landing).values;
  const planned = planMutation(rows, {
    targetId: String(flags.id),
    sets: parsedSets.sets,
    addEvidence: parsedSets.addEvidence,
    by: String(flags.by),
    reason: String(flags.reason),
    now,
    newId: makeId(now),
  });
  if (planned.ok !== true) {
    for (const p of planned.problems ?? ['未知问题']) io.err(`dsh-rulekeeper mutate: ${p}\n`);
    io.out(resultLine('MUTATE', false));
    return RC.FAIL;
  }
  io.out(line(`RK_MUTATE_LANDING=${toPosix(target.landing)}`));
  io.out(line(`RK_MUTATE_TARGET=${String(flags.id)} RULE=${planned.oldRow.rule} DRYRUN=${flags.apply === true ? 0 : 1}`));
  if (planned.already === true) {
    io.out(line('RK_MUTATE_ALREADY=1'));
    io.out(line('RK_MUTATE_NOTE=该 id 已有一条未被取代的归档行 ⇒ 不重复追加（幂等）'));
    if (flags.json === true) io.out(jsonStable({ targetId: String(flags.id), already: true }));
    io.out(resultLine('MUTATE', true));
    return RC.OK;
  }
  io.out(line(`RK_MUTATE_CHANGED=${planned.changed.join(',')}`));
  io.out(line(`RK_MUTATE_NEW_ID=${planned.newRow.id}`));
  for (const [key, value] of Object.entries(parsedSets.sets)) {
    const before = escapeControl(String(planned.oldRow[key] ?? ''));
    io.out(line(`RK_MUTATE_FIELD ${key}: ${before.slice(0, 80)} -> ${escapeControl(String(value)).slice(0, 80)}`));
  }
  for (const e of parsedSets.addEvidence) io.out(line(`RK_MUTATE_EVIDENCE_ADD ${escapeControl(e).slice(0, 120)}`));

  if (flags.apply !== true) {
    io.out(line('RK_MUTATE_APPLIED=0'));
    io.out(line('（dry-run：加 --apply 才落盘；落盘 = 备份 + 回读校验 + 原子替换 + 失败逐字节回滚）'));
    if (flags.json === true) io.out(jsonStable({ newRow: planned.newRow, statusRow: planned.statusRow, changed: planned.changed }));
    io.out(resultLine('MUTATE', true));
    return RC.OK;
  }

  const written = appendRowsVerified({
    landingDir: target.landing,
    rows: [planned.newRow, planned.statusRow],
    expectSuperseded: [String(flags.id)],
    now,
  });
  io.out(line(`RK_MUTATE_BACKUP=${written.backup ?? '(none)'}`));
  io.out(line(`RK_MUTATE_SHA_BEFORE=${written.beforeSha ?? '(none)'} AFTER=${written.afterSha ?? '(none)'}`));
  if (written.rolledBack === true) io.out(line('RK_MUTATE_ROLLED_BACK=1'));
  if (written.ok !== true) {
    io.err(`dsh-rulekeeper mutate: ${written.code}: ${written.reason}\n`);
    io.out(resultLine('MUTATE', false));
    return RC.FAIL;
  }
  io.out(line(`RK_MUTATE_LINES=${written.lines}`));
  io.out(line('RK_MUTATE_APPLIED=1'));
  io.out(line('RK_MUTATE_NOTE=新行是**归档行**；历史行逐字节不变（读侧 supersededIds() fold）'));
  if (flags.json === true) io.out(jsonStable({ applied: true, backup: written.backup, lines: written.lines, newRow: planned.newRow }));
  io.out(resultLine('MUTATE', true));
  return RC.OK;
}

function runCliReport(argv, io, env) {  const parsed = parseSub('report', argv, { '--landing': 'string', '--project': 'string', '--now': 'string', '--json': 'boolean' }, io);
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
    '--activation-check': 'string', '--retire-days': 'string',
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
      retireDays: parsed.flags['retire-days'] === undefined ? undefined : Number(parsed.flags['retire-days']),
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
  // **分级读数**（P23，2026-09-23）：这几类**不计入判定** —— 但必须看得见，否则"这次为什么没红"就成了黑箱。
  io.out(line(`RK_RECON_RELOCATED_BACKUPS=${(report.relocatedBackups ?? []).length}`));
  io.out(line(`RK_RECON_SUPERSEDED_UNRECORDED=${(report.supersededUnrecordedBackups ?? []).length}`));
  io.out(line(`RK_RECON_NON_SNAPSHOT_BACKUPS=${(report.nonSnapshotBackups ?? []).length}`));
  for (const m of report.missingBackups) io.out(line(`MISSING_BACKUP ${m.path} backup=${m.backup}`));
  for (const u of report.unrecordedBackups) io.out(line(`UNRECORDED_BACKUP ${u.backup}`));
  for (const r of report.relocatedBackups ?? []) io.out(line(`RELOCATED_BACKUP ${r.backup}（备份在落点 backups/ 里同名存在 ⇒ 不是丢失）`));
  for (const s of report.supersededUnrecordedBackups ?? []) io.out(line(`SUPERSEDED_BACKUP ${s.backup}（${s.reason}）`));
  for (const n of report.nonSnapshotBackups ?? []) io.out(line(`NON_SNAPSHOT_BACKUP ${n.backup}（${n.reason}）`));
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
