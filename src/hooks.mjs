// dsh-rulekeeper · LF-520 **hook 完整性 preflight**（`hooksPath` + 文件存在 + sha256 + 可执行位）
//
// 判据（清单 §5 LF-520）：原样 → exit=0；红态三件套：
//   ① hook 缺失 → exit≠0 ② 改 1 字节 → exit≠0 ③ **装到 `.git/hooks/` 而非 `hooksPath` → 不生效（须红）**。
//
// 为什么"不生效"也必须判红：hook 文件躺在 `.git/hooks/` 里、而 `core.hooksPath` 指向别处（或为空）时，
// 文件看起来"装好了"，git **一次都不会执行它** —— 这是最典型的"以为有闸、其实没有"（假安全）。
//
// 可执行位怎么在 Windows 上诚实判定（本条目实测口径）：
//   · 文件**已入索引** → 用 `git ls-files -s` 的 mode 判（`100755` = 可执行）：这是 git 自己的记录，**跨平台一致**，
//     而且在 POSIX 上 git 会**忽略**非可执行的 hook ⇒ 这一条是真正的跨平台红线（不是 Windows 特有检查）。
//   · 文件**未入索引** → POSIX 看 on-disk 权限位；Windows（NTFS 无 exec 位）如实记 `n/a:untracked-win32`，**不作违规**，
//     但"从未入索引"这件事本身会被 `execSource` 记录，复核方可核对（不静默）。
//
// 归属：core 模块（P5 门禁）。零依赖：只用 node:*（git 通过子进程调用，可注入替身以便测试）。

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { LANDING_DIRNAME, LEGACY_LANDING_DIRNAME, resolveProjectLanding, toPosix } from './platform/paths.mjs';

export const HOOKS_MANIFEST = 'hooks.json';
/**
 * **本机态**文件名（P14，2026-09-23）：装的是"随机器变化"的那几个字段 ——
 *   `createdAt`（安装时刻）/ `runner{path,sha256,bytes}`（本轮已去机器相关性，但仍是本机安装事实）/
 *   `previous` + `configChanged`（LF-810 卸载所需的"安装前 hooksPath 原值"）。
 * 为什么拆出来：`hooks.json` 要**入库**（对方工单 §P14 拍板：清单入库 + `hook:` 点名只核名字），
 * 而入库的文件里**不得有随机器变化的内容** —— 否则换机跑一次 install 就把它改写 ⇒ 工作区变脏 ⇒
 * 在本仓（pre-push「脏树即阻断」）上直接推不出去。本文件**保持被 .gitignore 忽略**。
 */
export const HOOKS_LOCAL_STATE = 'hooks.local.json';
export const HOOK_RUNNER = 'hook.mjs';
export const DEFAULT_HOOKS_PATH = '.githooks';
/**
 * 默认装四个 hook（LF-520 + LF-510 + 2026-09-21 两件）：
 *   `pre-commit`  = 真阻断（LF-500：改受保护路径未留证就拒）
 *   `commit-msg`  = **提交正文的公开面门禁**（2026-09-21，教训 L652）：暂存文件过了不等于公开面干净——
 *                   实测事故是"文件全过、**正文**里带了绝对路径与内部项目名"，推上去才发现、
 *                   而远端分支保护**禁止强推** ⇒ 泄漏撤不回来。修法只能在这里拦。
 *   `post-commit` = **绕过可检测**（LF-510）：`--no-verify` **不跳过 post-commit**（本机实测：
 *                   `--no-verify` 时 pre-commit 不跑、post-commit 照跑）⇒ 它是"被绕过"这件事的取证位置。
 *   `pre-push`    = **CI 等价门禁**（2026-09-21，用户点选 A）：推送前在本机跑与远端 workflow 同一条
 *                   `rk-gate ci --base <远端已有 sha> --head HEAD`。为什么需要它：仓库的规则面确实要求
 *                   3 个必需检查，但**所有者推送会被 bypass**（实测远端逐字回报
 *                   `Bypassed rule violations … 3 of 3 required status checks are expected`）⇒
 *                   远端门禁管不住自己，只能在本机补一道。
 */
export const DEFAULT_HOOK_NAMES = Object.freeze(['pre-commit', 'commit-msg', 'post-commit', 'pre-push']);
export const KNOWN_HOOK_NAMES = Object.freeze(['pre-commit', 'commit-msg', 'post-commit', 'pre-push']);
/** 生成物一律 LF 无 BOM（清单 §0.1 ㉑ / ⑯：CRLF 会让"逐字比对"假红） */
const EOL = '\n';

/** git 调用的单点封装（可注入替身：`{ runGit }`）——**只此一处** spawn git（gate.mjs 复用，避免第二套实现） */
export function defaultRunGitRaw(repoRoot, args) {
  const r = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'buffer' });
  return {
    ok: r.status === 0,
    status: r.status,
    buffer: Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.alloc(0),
    error: r.error ? String(r.error.message) : null,
    stderr: Buffer.isBuffer(r.stderr) ? r.stderr.toString('utf8').trim() : '',
  };
}

export function defaultRunGit(repoRoot, args) {
  const raw = defaultRunGitRaw(repoRoot, args);
  return {
    ok: raw.ok,
    status: raw.status,
    stdout: raw.buffer.toString('utf8').trim(),
    stderr: raw.stderr,
    error: raw.error,
  };
}

/**
 * 读**当前** `core.hooksPath`（LF-810：这是"原值"的唯一权威读法）。
 *
 * 为什么必须单独成函数：`git config --get` 在"键不存在"时 **exit=1 且 stdout 为空**——
 * 那是**正常状态**（大多数仓库本来就没设），不是错误。把 exit=1 当失败会让"记原值"这一步
 * 在**绝大多数仓库**上失败（假红）。所以这里把 (exit=1 + 空输出) 判定为 `present:false`。
 */
export function readHooksPath(repoRoot, runGit = defaultRunGit) {
  const r = runGit(repoRoot, ['config', '--get', 'core.hooksPath']);
  const value = typeof r.stdout === 'string' ? r.stdout.trim() : '';
  return {
    present: r.ok === true && value !== '',
    hooksPath: value === '' ? null : value,
    status: typeof r.status === 'number' ? r.status : null,
    error: r.error ?? null,
  };
}

export function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * hook 脚本内容：**确定性**（不含任何机器路径），LF 无 BOM。
 * 把 hook 名写进脚本 —— git 调用 hook 时**不传 hook 名**（post-commit 无参、pre-push 传 remote/url），
 * 所以"我是谁"只能由生成期刻进去（脚本内容逐 hook 不同 -> 清单按 hook 记 sha256）。
 */
export function hookScriptContent({ name = 'pre-commit' } = {}) {
  return [
    '#!/bin/sh',
    `# dsh-rulekeeper git hook (${name}) —— 由 \`rk-gate hooks install\` 生成，请勿手改。`,
    '# 手改会被 `rk-gate hooks verify` 判红（sha256 失配）；要改请改模板后重新 install。',
    'root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 1',
    // R2 兼容窗口：**优先新落点，老落点仍在用时回退** —— 这样"迁移数据"之后不必重装 hook。
    // 两个落点名都取自 platform/paths.mjs 的常量（shim 里不留字面量，selfcheck S7 才拦得住漂移）。
    `if [ -f "$root/.dsh-ai/${LANDING_DIRNAME}/${HOOK_RUNNER}" ]; then L="${LANDING_DIRNAME}"; else L="${LEGACY_LANDING_DIRNAME}"; fi`,
    `exec node "$root/.dsh-ai/$L/${HOOK_RUNNER}" ${name} "$@"`,
    '',
  ].join(EOL);
}

/**
 * hook runner（**不含任何机器相关路径**，故内容在任意安装位置逐字节相同 —— P14 验收判据②）。
 *   pre-commit  → ① `precommit --repo`（LF-500：暂存区视角，改受保护路径未留证即拒）② `write --project`（LF-530：工作区视角）
 *   post-commit → `postcommit --repo`（LF-510：记录本次提交的取证结论；`--no-verify` 时它仍会跑 ⇒ 绕过留痕）
 *   pre-push    → `ci --base <远端已有 sha> --head HEAD`（2026-09-21：本机 CI 等价门禁，逐条 ref 比对基点；
 *                  新分支/删引用时基点全零 ⇒ **如实跳过并喊一声**，不假装通过）
 * 为什么 pre-commit 要两道门：它只看得见暂存区，**未暂存的直写**天生看不见（LF-530 是覆盖那一段的唯一位置）。
 *
 * **P14（2026-09-23）为什么要收掉 `gateBin` 参数**：原先这里写死 `const GATE_BIN = "<包根>/bin/rk-gate.mjs"`
 *   ⇒ 换机器/换目录 runner 内容与 sha 必变 ⇒ 把它记进清单就等于把**必然跨机失配**的指纹入库
 *   （新 clone 上"钩子被改"的假红）。现在改成**运行时解析**（`resolveGate()`），解析不到时**大声失败**，
 *   而不是静默回落到一个死路径 —— 后者是"以为有闸、其实没有"的同族问题。
 */
export function hookRunnerContent() {
  return [
    '#!/usr/bin/env node',
    '// dsh-rulekeeper hook runner（由 `rk-gate hooks install` 生成；本机产物，请勿手改）',
    "import { spawnSync } from 'node:child_process';",
    "import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "import { dirname, join } from 'node:path';",
    'const hook = process.argv[2] ?? \'\';',
    'const repo = process.env.RULEKEEPER_REPO ?? process.cwd();',
    '// ── rk-gate 入口的**运行时解析**（P14）：四处按序试，任一处**命中且存在**即用 ──────────────',
    '//   ① 环境变量 `RK_GATE_BIN`（显式覆盖；也便于用例注入替身）',
    '//   ② 本机态 `hooks.local.json` 的 `gateBin` —— 装钩子时**已经解析好**的那个入口，最贴近现实',
    '//      （少了这一路，`hooks install` 装完钩子当场不工作：真机实测踩到过一次）',
    '//   ③ 项目里的 `node_modules/dsh-rulekeeper/bin/rk-gate.mjs`（干净 clone 由包管理器提供时）',
    '//   ④ 落点配置 `config.json` 的 `gateBin`（显式声明面；这个文件可能被跟踪 ⇒ 不主动写它）',
    '// 四处全落空 ⇒ **大声失败**（不静默回落到死路径：那会变成"以为有闸、其实没有"）。',
    'function readLandingJson(name) {',
    '  for (const rel of [\'rulekeeper\', \'lessonflow\']) {',
    '    const p = join(repo, \'.dsh-ai\', rel, name);',
    '    try { const c = JSON.parse(readFileSync(p, \'utf8\')); if (c && typeof c === \'object\') return c; } catch { /* 没有就继续 */ }',
    '  }',
    '  return {};',
    '}',
    'function resolveGate() {',
    '  const tried = [];',
    '  const env = process.env.RK_GATE_BIN;',
    '  if (typeof env === \'string\' && env !== \'\') {',
    '    if (existsSync(env)) return { bin: env, from: \'env:RK_GATE_BIN\' };',
    '    tried.push(\'env:RK_GATE_BIN=\' + env + \'（不存在）\');',
    '  } else { tried.push(\'env:RK_GATE_BIN（未设）\'); }',
    '  const local = readLandingJson(\'hooks.local.json\').gateBin;',
    '  if (typeof local === \'string\' && local !== \'\') {',
    '    if (existsSync(local)) return { bin: local, from: \'本机态 hooks.local.json gateBin\' };',
    '    tried.push(\'hooks.local.json gateBin=\' + local + \'（不存在）\');',
    '  } else { tried.push(\'hooks.local.json gateBin（未设）\'); }',
    '  const packed = join(repo, \'node_modules\', \'dsh-rulekeeper\', \'bin\', \'rk-gate.mjs\');',
    '  if (existsSync(packed)) return { bin: packed, from: \'node_modules\' };',
    '  tried.push(\'node_modules/dsh-rulekeeper/bin/rk-gate.mjs（不存在）\');',
    '  const cfg = readLandingJson(\'config.json\').gateBin;',
    '  if (typeof cfg === \'string\' && cfg !== \'\') {',
    '    if (existsSync(cfg)) return { bin: cfg, from: \'落点 config.json gateBin\' };',
    '    tried.push(\'config.json gateBin=\' + cfg + \'（不存在）\');',
    '  } else { tried.push(\'config.json gateBin（未设）\'); }',
    '  process.stderr.write(\'dsh-rulekeeper hook: **找不到 rk-gate 入口**，本次门禁**未执行**（fail-closed）\\\\n\'',
    '    + \'  试过：\' + tried.join(\' / \') + \'\\\\n\'',
    '    + \'  修法：在本仓重跑一次 `rk-gate hooks install`（会把入口记进本机态），或设 RK_GATE_BIN，\'',
    '    + \'或在落点 config.json 写 "gateBin"\\\\n\');',
    '  process.exit(1);',
    '}',
    'const gate = resolveGate();',
    'function runGate(args) { return spawnSync(process.execPath, [gate.bin, ...args], { stdio: \'inherit\' }); }',
    '// **pre-push 三件可拆**（P22）：载荷是**生成物、不吃命令行参数** ⇒ 开关放在**落点配置**里，由本载荷自己读。',
    '// 语义：`prePush.noCi=true` ⇒ 跳过第②段（与远端 workflow 同一条 CI 等价门禁），只跑 refs + 未推正文。',
    '// 为什么需要：没有服务端工作流的仓上，`ci` 会报 CI_WORKFLOW_MISSING/CI_BIN_MISSING ⇒ 整条 pre-push exit 1，',
    '// 而第①②段其实是干净的。⚠ 这是**声明型开关**（能改 config 的人也能打开它）—— 故默认 false，且跳过时**大声说明**。',
    'const noCi = readLandingJson(\'config.json\')?.prePush?.noCi === true;',
    "// commit-msg：正文文件路径由 git 作为**第一个参数**传进来（`$1`），扫同一份公开面模式表",
    "if (hook === 'commit-msg') {",
    "  const msgFile = process.argv[3] ?? '';",
    "  const r = runGate(['commitmsg', '--file', msgFile]);",
    '  if (r.error) { process.stderr.write("dsh-rulekeeper commit-msg: 无法执行 commitmsg: " + r.error.message + "\\n"); process.exit(1); }',
    "  process.exit(typeof r.status === 'number' ? r.status : 1);",
    '}',
    '// pre-push：refs 从 **stdin** 来（`<localRef> <localSha> <remoteRef> <remoteSha>`），逐个远端 sha 做基点',
    "if (hook === 'pre-push') {",
    '  let input = \'\';',
    "  try { input = readFileSync(0, 'utf8'); } catch { input = ''; }",
    '  const bases = new Set();',
    '  let skipped = 0;',
    "  for (const line of input.split('\\n')) {",
    "    const parts = line.trim().split(/\\s+/);",
    '    if (parts.length < 4) continue;',
    '    const remoteSha = parts[3];',
    "    if (!/^[0-9a-f]{7,40}$/i.test(remoteSha) || /^0+$/.test(remoteSha)) { skipped += 1; continue; }",
    '    bases.add(remoteSha);',
    '  }',
    '  if (bases.size === 0) {',
    '    process.stderr.write("dsh-rulekeeper pre-push: 无可用比对基点（新分支/删除引用 " + skipped + " 条）⇒ 跳过 CI 等价门禁（如实告知，不是静默通过）\\n");',
    '  }',
    "  // ⓪**引用名**也是公开面（会出现在远端分支/tag 列表）⇒ 先扫 refs（refs 文件就是本次 stdin 内容）",
    "  try {",
    "    const refsFile = join(tmpdir(), 'rk-prepush-refs-' + process.pid + '.txt');",
    "    writeFileSync(refsFile, input, 'utf8');",
    "    const rf = runGate(['refs', '--file', refsFile]);",
    "    try { unlinkSync(refsFile); } catch {}",
    '    if (rf.error) { process.stderr.write("dsh-rulekeeper pre-push: 无法执行 refs: " + rf.error.message + "\\n"); process.exit(1); }',
    "    if (typeof rf.status !== 'number' || rf.status !== 0) process.exit(typeof rf.status === 'number' ? rf.status : 1);",
    '  } catch (err) {',
    '    process.stderr.write("dsh-rulekeeper pre-push: refs 扫描自身出错（fail-closed，拒绝推送）: " + String(err && err.message || err) + "\\n");',
    '    process.exit(1);',
    '  }',
    '  if (bases.size === 0) {',
    '    process.exit(0);',
    '  }',
    '  for (const base of bases) {',
    "    // ①**先扫未推提交的正文**（离机之前的最后一道；兜住 --no-verify 提交、钩子装上之前的旧提交、amend 改过的正文）",
    "    const m = runGate(['commitmsg', '--repo', repo, '--range', base + '..HEAD']);",
    '    if (m.error) { process.stderr.write("dsh-rulekeeper pre-push: 无法执行 commitmsg: " + m.error.message + "\\n"); process.exit(1); }',
    "    if (typeof m.status !== 'number' || m.status !== 0) process.exit(typeof m.status === 'number' ? m.status : 1);",
    "    // ②再跑与远端 workflow 同一条 CI 等价门禁（`prePush.noCi=true` 时**跳过并大声说明**）",
    "    if (noCi) {",
    "      process.stderr.write('dsh-rulekeeper pre-push: 按落点配置 prePush.noCi=true **跳过** CI 等价门禁（第②段）；'",
    "        + 'refs 与未推正文已扫过 —— 这是**声明型开关**，本仓自己声明不需要服务端工作流那一面\\n');",
    "      continue;",
    "    }",
    "    const r = runGate(['ci', '--base', base, '--head', 'HEAD']);",
    '    if (r.error) { process.stderr.write("dsh-rulekeeper pre-push: 无法执行 ci: " + r.error.message + "\\n"); process.exit(1); }',
    "    if (typeof r.status !== 'number' || r.status !== 0) process.exit(typeof r.status === 'number' ? r.status : 1);",
    '  }',
    '  process.exit(0);',
    '}',
    'const stepsByHook = {',
    "  'pre-commit': [['precommit', ['--repo', repo]], ['write', ['--project', repo, '--phase', 'close']]],",
    "  'post-commit': [['postcommit', ['--repo', repo]]],",
    '};',
    'const steps = stepsByHook[hook];',
    'if (steps === undefined) {',
    '  process.stderr.write("dsh-rulekeeper hook: 未知 hook 名 " + hook + "（未装任何门禁；已装 pre-commit / post-commit / pre-push）\\n");',
    '  process.exit(0);',
    '}',
    'for (const [cmd, args] of steps) {',
    "  const r = runGate([cmd, ...args]);",
    '  if (r.error) { process.stderr.write("dsh-rulekeeper hook: 无法执行 " + cmd + ": " + r.error.message + "\\n"); process.exit(1); }',
    '  if (typeof r.status !== \'number\' || r.status !== 0) process.exit(typeof r.status === \'number\' ? r.status : 1);',
    '}',
    'process.exit(0);',
    '',
  ].join(EOL);
}

export function landingDirOf(repoRoot) {
  // R2：走落点解析器（新默认 `.dsh-ai/rulekeeper`；老落点存在时沿用，兼容窗口期不搬数据）
  return resolveProjectLanding(repoRoot);
}
export function manifestPathOf(repoRoot) {
  return join(landingDirOf(repoRoot), HOOKS_MANIFEST);
}
/** 本机态文件（P14：`createdAt` / runner 指纹 / 安装前 hooksPath 原值 / configChanged）——**不入版本库** */
export function localStatePathOf(repoRoot) {
  return join(landingDirOf(repoRoot), HOOKS_LOCAL_STATE);
}

/**
 * 读清单 + 本机态的**合并视图**（P14，向后兼容的单一入口）。
 *
 * 为什么要有它：清单已拆两半 ——
 *   · `hooks.json`（**稳定、入库**）：`schema` / `hooksPath` / `hooks[]`（名字 + sha256 + bytes ± adopted）
 *   · `hooks.local.json`（**本机、忽略**）：`createdAt` / `runner{path,sha256,bytes}` / `previous` / `configChanged`
 * 老落点（拆分之前装的）把后四个字段**混在清单里**。读取端一律走这里，**local 优先、清单回退**
 * ⇒ 老落点不炸、新落点不脏。返回 `source` 让调用方能如实说出"本机态是从哪来的"（不静默）。
 *
 * @returns {{manifest: object|null, local: object|null, previous: object|null, configChanged: boolean|null,
 *            runner: object|null, source: 'local'|'manifest-legacy'|'none', manifestFile: string, localFile: string,
 *            localPresent: boolean, invalid: string|null}}
 */
export function readHooksState(repoRoot) {
  const landing = landingDirOf(repoRoot);
  const manifestFile = join(landing, HOOKS_MANIFEST);
  const localFile = join(landing, HOOKS_LOCAL_STATE);
  const out = {
    manifest: null, local: null, previous: null, configChanged: null, runner: null,
    source: 'none', manifestFile, localFile, localPresent: existsSync(localFile), invalid: null,
  };
  const load = (file) => {
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      return parsed !== null && typeof parsed === 'object' ? parsed : null;
    } catch { return null; }
  };
  out.manifest = load(manifestFile);
  out.local = load(localFile);
  if (out.manifest !== null && !Array.isArray(out.manifest.hooks)) {
    out.invalid = '缺 hooks 数组';
    out.manifest = null;
  }
  const pick = (key) => {
    const l = out.local?.[key];
    if (l !== undefined && l !== null) return { value: l, from: 'local' };
    const m = out.manifest?.[key];
    if (m !== undefined && m !== null) return { value: m, from: 'manifest-legacy' };
    return { value: null, from: null };
  };
  const prev = pick('previous');
  const changed = pick('configChanged');
  const runner = pick('runner');
  out.previous = prev.value;
  out.configChanged = typeof changed.value === 'boolean' ? changed.value : null;
  out.runner = runner.value !== null && typeof runner.value === 'object' ? runner.value : null;
  // 来源：只要有一个字段来自本机态就算 local；否则若来自清单（老落点）算 manifest-legacy
  const froms = [prev.from, changed.from, runner.from].filter((f) => f !== null);
  out.source = froms.includes('local') ? 'local' : (froms.length > 0 ? 'manifest-legacy' : 'none');
  return out;
}

function writeLfNoBom(file, text) {
  writeFileSync(file, text, { encoding: 'utf8' });
}

/** 索引里的 mode（`100755` / `100644` / null=未入索引） */
export function indexModeOf(repoRoot, relPath, runGit = defaultRunGit) {
  const r = runGit(repoRoot, ['ls-files', '-s', '--', relPath]);
  if (!r.ok || r.stdout === '') return { tracked: false, mode: null };
  const m = /^(\d{6})\s/.exec(r.stdout);
  return { tracked: true, mode: m === null ? null : m[1] };
}

/**
 * `rk-gate hooks install`：写 hook 脚本（入 `<hooksPath>/`）+ runner + **拆分后的清单/本机态**，
 * 并把 `core.hooksPath` 指到 `<hooksPath>`。**默认会改本仓 git config**（`--no-config` 可跳过）：
 * 不改的话 hook 根本不会被执行 —— 那是"假安全"。
 *
 * P14 之后 `gateBin` 只做两件事：① 校验"调用方确实有一个能用的 rk-gate 入口"（装机前置，缺了就整单失败）；
 * ② 记进**本机态**文件（人看得见"这台机器是从哪装的"）。它**不再进入 runner 内容** ⇒ runner 跨机同 sha。
 */
export function installHooks(opts = {}) {
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());
  const hooksPath = opts.hooksPath ?? DEFAULT_HOOKS_PATH;
  const names = opts.names ?? DEFAULT_HOOK_NAMES;
  const runGit = opts.runGit ?? defaultRunGit;
  const gateBin = opts.gateBin ?? null;
  const now = opts.now ?? new Date();
  const reasons = [];
  if (gateBin === null || !existsSync(gateBin)) reasons.push('缺少可用的 rk-gate 入口（--gate-bin）');
  if (reasons.length > 0) return { ok: false, reasons, hooksPath, names: [...names] };

  const gitDir = join(repoRoot, '.git');
  if (!existsSync(gitDir)) return { ok: false, reasons: [`不是 git 仓库（无 .git）: ${repoRoot}`], hooksPath, names: [...names] };

  const hooksDir = join(repoRoot, hooksPath);
  mkdirSync(hooksDir, { recursive: true });
  const landing = landingDirOf(repoRoot);
  mkdirSync(landing, { recursive: true });

  const written = [];
  const skipped = [];
  /** `--adopt-existing` 采纳的条目（登记现状、**不写内容**；与"本工具模板装出来的"区分开） */
  const adopted = [];
  for (const name of names) {
    if (!KNOWN_HOOK_NAMES.includes(name)) return { ok: false, reasons: [`未知 hook 名 "${name}"（只支持 ${KNOWN_HOOK_NAMES.join(' / ')}）`], hooksPath, names: [...names] };
    const file = join(hooksDir, name);
    const content = hookScriptContent({ name });
    const sha = sha256Text(content);
    if (existsSync(file) && opts.force !== true) {
      const current = sha256File(file);
      // 内容不同 = 这位置已经有**别人写的** hook（项目自有手写门禁/别的工具装的）。
      // **不覆盖**，并**如实回报"我跳过了它"**（P13）：这里原先直接 `return ok:false` 整单失败，
      // 于是"只想装另外几件"的人拿不到任何东西；改成跳过并记账后，`--names` 才能表达
      // "只装我要的那几件、别动我手写的那件"。要覆盖仍是显式 `--force`。
      if (current !== sha) {
        // `--adopt-existing`：**登记现状但不写内容**（P13 复核 blocker 的修法）。
        // 为什么必须有这条路：手写钩子被 verify 判 `HOOK_MANIFEST_INCOMPLETE`（"不会被核"）时，
        // 唯一被推荐的 `--force` 会把它覆盖成模板 —— 合法路径不存在，只剩违规路径（手改 hooks.json）。
        // 采纳即把**当前字节**登记为新基线（`adopted: true` 标明来源），文件一个字节都不动。
        if (opts.adoptExisting === true) {
          written.push({ name, sha256: current, bytes: statSync(file).size, adopted: true });
          adopted.push({ name, sha256: current });
          continue;
        }
        skipped.push({ name, reason: `${hooksPath}/${name} 已存在且内容不同（跳过，未覆盖；要覆盖用 --force，要登记现状用 --adopt-existing）`, sha256: current });
        continue;
      }
    }
    writeLfNoBom(file, content);
    // POSIX 上给可执行位（Windows 上是 no-op）；权威口径仍是索引 mode（见 verifyHooks）
    try { chmodSync(file, 0o755); } catch { /* Windows：无 exec 位，忽略 */ }
    written.push({ name, sha256: sha, bytes: Buffer.byteLength(content, 'utf8') });
  }
  const runner = hookRunnerContent();
  const runnerFile = join(landing, HOOK_RUNNER);
  writeLfNoBom(runnerFile, runner);
  const runnerSha = sha256Text(runner);

  let configSet = false;
  let configValue = null;
  // LF-810 判据原文要求"摘 hook **先记原值**"：装之前先读一次，把"原本指向哪 / 原本就没设"这件事本身写下来。
  // 不记的话，卸载时只能靠猜（猜错 = 把用户原有的 hooksPath 抹掉，属"卸载破坏环境"）。
  //
  // M4（独立审查）：**重装**（升级重跑 / `--force`）时不能把"自己上次设的值"当成原值——
  //   否则卸载会把 `core.hooksPath` 还成一个指向已被删目录的悬空路径。判据：已有清单 + 当前值 == 该清单的
  //   `hooksPath` ⇒ 沿用**旧记录里的 previous**（那才是真正的原值）。
  // P14：原值记录改放**本机态**；读取走 `readHooksState`（local 优先、清单回退）⇒ 老落点也能沿用旧值。
  const priorState = readHooksState(repoRoot);
  const observed = readHooksPath(repoRoot, runGit);
  let previous = { hooksPath: observed.hooksPath, existed: observed.present };
  {
    const oldPrev = priorState.previous;
    const oldHooksPath = priorState.local?.hooksPath ?? priorState.manifest?.hooksPath ?? null;
    if (oldPrev !== null && typeof oldPrev === 'object'
      && typeof oldHooksPath === 'string' && observed.present === true && observed.hooksPath === oldHooksPath) {
      previous = { hooksPath: typeof oldPrev.hooksPath === 'string' ? oldPrev.hooksPath : null, existed: oldPrev.existed === true };
    }
  }
  if (opts.setConfig !== false) {
    const r = runGit(repoRoot, ['config', 'core.hooksPath', hooksPath]);
    configSet = r.ok;
    configValue = hooksPath;
    if (!r.ok) reasons.push(`git config core.hooksPath 设置失败: ${r.stderr || r.error || '(未知)'}`);
  }
  // ── 清单**合并**（P13 复核 blocker，2026-09-23）─────────────────────────────────
  // 现场：`install --names pre-commit` 之后再来一次 `install --names post-commit`，
  // 原实现把清单直接写成"本批写的"，于是 pre-commit **从清单里消失**（磁盘上还在）⇒
  // `hooks verify` 报 `HOOK_MANIFEST_INCOMPLETE`，而它给的修法 `install --force`
  // **正好会把用户手写的钩子覆盖成模板**（"别覆盖我的手写件"换来一条会毁掉它的建议）。
  // 现口径：`--names` 是**增量**语义 —— 本次没点名的、清单里已登记的条目**原样保留**。
  const previousHooks = (() => {
    try {
      const old = JSON.parse(readFileSync(manifestPathOf(repoRoot), 'utf8'));
      return old !== null && typeof old === 'object' && Array.isArray(old.hooks) ? old.hooks : [];
    } catch { return []; }
  })();
  const writtenNames = new Set(written.map((h) => h.name));
  const retained = previousHooks.filter((h) => h !== null && typeof h === 'object'
    && typeof h.name === 'string' && !writtenNames.has(h.name));
  const manifestHooks = [...written, ...retained];
  // ── 清单**入库面**（P14）：只放**跨机稳定**的东西 —— 换机器跑 install 得到逐字节相同的内容 ──────
  const manifest = {
    schema: 1,
    hooksPath,
    hooks: manifestHooks,
  };
  // ── **本机态**（P14）：随机器变化的东西一律在这里，文件保持被忽略 ────────────────────────────
  const localState = {
    schema: 1,
    createdAt: now.toISOString(),
    hooksPath,
    gateBin: gateBin === null ? null : toPosix(gateBin),
    runner: { path: HOOK_RUNNER, sha256: runnerSha, bytes: Buffer.byteLength(runner, 'utf8') },
    // LF-810：卸载所需的**安装前状态**（"原值 + 本来有没有" + 我们到底改没改过 config）
    previous: { hooksPath: previous.hooksPath, existed: previous.existed === true },
    configChanged: opts.setConfig !== false && configSet,
  };
  writeLfNoBom(manifestPathOf(repoRoot), `${JSON.stringify(manifest, null, 2)}${EOL}`);
  writeLfNoBom(localStatePathOf(repoRoot), `${JSON.stringify(localState, null, 2)}${EOL}`);
  return {
    ok: reasons.length === 0,
    reasons,
    repoRoot,
    hooksPath,
    hooksDir: toPosix(hooksDir),
    installed: written,
    skipped,
    retained,
    adopted,
    runnerSha,
    configSet,
    configValue,
    previous: localState.previous,
    configChanged: localState.configChanged,
    localStateFile: toPosix(localStatePathOf(repoRoot)),
    manifest,
    names: [...names],
  };
}

/**
 * `rk-gate hooks verify`：完整性 preflight（不改盘、不改 config）。
 * 红态三件套 ① 缺失 ② 改 1 字节 ③ 装到 `.git/hooks/` 而不生效。
 */
export function verifyHooks(opts = {}) {
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());
  const runGit = opts.runGit ?? defaultRunGit;
  const findings = [];
  const details = [];

  const landing = landingDirOf(repoRoot);
  const manifestFile = manifestPathOf(repoRoot);
  // P14：合并视图（local 优先、清单回退）——`manifest` 只承载**稳定面**（hooksPath + hooks[]）。
  const state = readHooksState(repoRoot);
  let manifest = state.manifest;
  if (!existsSync(manifestFile)) {
    findings.push({ code: 'HOOK_MANIFEST_MISSING', message: `缺 hooks 清单（先跑 rk-gate hooks install）: ${toPosix(relative(repoRoot, landing))}/${HOOKS_MANIFEST}` });
  } else if (manifest === null) {
    // 逐字保留原判据：**结构不合法**（读得动 JSON、但缺 hooks 数组）与**读不了**（坏 JSON）分开报
    let parseError = null;
    try { JSON.parse(readFileSync(manifestFile, 'utf8')); } catch (err) { parseError = err; }
    if (parseError !== null) findings.push({ code: 'HOOK_MANIFEST_UNREADABLE', message: `hooks 清单读不了: ${parseError?.message ?? ''}` });
    else findings.push({ code: 'HOOK_MANIFEST_INVALID', message: 'hooks 清单结构不合法（缺 hooks 数组）' });
  }

  const cfg = runGit(repoRoot, ['config', '--get', 'core.hooksPath']);
  const gitAvailable = cfg.error === null;
  const configured = cfg.ok ? cfg.stdout : '';
  details.push({ key: 'REPO_IS_GIT', value: gitAvailable && cfg.status !== 128 });
  if (!gitAvailable) findings.push({ code: 'HOOK_GIT_UNAVAILABLE', message: `git 不可用或不是仓库: ${cfg.error ?? cfg.stderr}` });

  const expectedPath = manifest?.hooksPath ?? opts.hooksPath ?? null;
  if (configured === '') {
    findings.push({ code: 'HOOK_PATH_NOT_SET', message: 'core.hooksPath 为空 -> 本仓的 .githooks 里装了什么都不会被执行（必须先 install 或 git config core.hooksPath <dir>）' });
  } else if (expectedPath !== null && configured !== expectedPath) {
    findings.push({ code: 'HOOK_PATH_MISMATCH', message: `core.hooksPath=${configured} 与清单 ${expectedPath} 不一致` });
  }
  const hooksPath = configured !== '' ? configured : (expectedPath ?? DEFAULT_HOOKS_PATH);
  const hooksDir = join(repoRoot, hooksPath);
  if (!existsSync(hooksDir)) findings.push({ code: 'HOOK_PATH_MISSING', message: `hooks 目录不存在: ${hooksPath}/` });

  const names = (manifest?.hooks ?? []).map((h) => h.name).filter((n) => typeof n === 'string');

  // ── 清单**完整性**（2026-09-21，交接：补全落点 hooks.json 清单）──────────────────────────
  // 现场问题：另一个落点的清单里只有 2 条（pre-commit / post-commit），而 `.githooks/` 里实际有 4 个
  // 脚本、`hook.mjs` 也**真的**在处理 commit-msg 与 pre-push。于是 `hooks verify` 只核 2/4 ——
  // **在用的 pre-push（真拦截面）根本没被核**：它被改坏/被清空，verify 照样 pass。
  // 判据：清单里缺了"磁盘上存在且属于已知钩子"的那几条 ⇒ 报 `HOOK_MANIFEST_INCOMPLETE`。
  // （只认 KNOWN_HOOK_NAMES，避免把别的工具装的 hook 也算成"我们的清单漏了"。）
  const onDisk = existsSync(hooksDir)
    ? readdirSync(hooksDir).filter((n) => KNOWN_HOOK_NAMES.includes(n))
    : [];
  const unlisted = onDisk.filter((n) => !names.includes(n));
  if (unlisted.length > 0) {
    findings.push({
      code: 'HOOK_MANIFEST_INCOMPLETE',
      message: `清单漏了磁盘上已有的钩子: ${unlisted.join(' / ')}（清单里只有 ${names.join(' / ') || '（空）'}）`
        + ' ⇒ 这些钩子**不会被 verify 核**（被改坏也看不见）。'
        + `修法：把这些名字**补进清单**：\`rk-gate hooks install --names ${[...names, ...unlisted].join(',')}\``
        + '（`--names` 是**增量**语义，已登记条目会保留）。'
        + '若其中某件是**你手写的**（内容 ≠ 本工具模板），它会因"不覆盖"而被跳过 —— '
        + `那就用 \`rk-gate hooks install --names ${[...names, ...unlisted].join(',')} --adopt-existing\` `
        + '**采纳现状**（只登记当前字节、**一个字节都不改**），这样它才会被 verify 核。'
        + '⚠ **不要用 `--force`**：它会把磁盘上**内容不同**的钩子（含你手写的）覆盖成模板 —— '
        + '那是以"清掉一条 finding"为代价毁掉项目自有门禁。',
    });
  }
  details.push({ key: 'HOOKS_ON_DISK', value: onDisk.length });
  details.push({ key: 'HOOKS_UNLISTED', value: unlisted.length });

  const report = [];
  for (const entry of manifest?.hooks ?? []) {
    const name = entry.name;
    const rel = `${hooksPath}/${name}`;
    const file = join(hooksDir, name);
    if (!existsSync(file)) {
      findings.push({ code: 'HOOK_MISSING', message: `hook 缺失: ${rel}` });
      report.push({ name, path: rel, present: false });
      continue;
    }
    const actual = sha256File(file);
    const match = actual === entry.sha256;
    if (!match) {
      findings.push({
        code: 'HOOK_MODIFIED',
        message: `hook 内容与清单不符（被改过或装错）: ${rel} expected=${String(entry.sha256).slice(0, 12)} actual=${actual.slice(0, 12)}`,
      });
    }
    // 可执行位：索引 mode 优先（跨平台一致）；未入索引时按平台如实记
    const idx = indexModeOf(repoRoot, rel, runGit);
    let execSource;
    let execOk = true;
    if (idx.tracked && idx.mode !== null) {
      execSource = `index:${idx.mode}`;
      execOk = idx.mode === '100755';
    } else if (process.platform === 'win32') {
      execSource = 'n/a:untracked-win32';
    } else {
      const mode = statSync(file).mode & 0o111;
      execSource = mode !== 0 ? 'stat:exec' : 'stat:no-exec';
      execOk = mode !== 0;
    }
    if (!execOk) {
      findings.push({
        code: 'HOOK_NOT_EXECUTABLE',
        message: `hook 不可执行（POSIX 上 git 会**忽略**它）: ${rel} ${execSource} -> git update-index --chmod=+x ${rel}`,
      });
    }
    // ③ "装到 .git/hooks/ 却不生效"：文件在，git 却不会跑它
    const dotGitHook = join(repoRoot, '.git', 'hooks', name);
    const inert = existsSync(dotGitHook) && configured !== '.git/hooks';
    if (inert) {
      findings.push({
        code: 'HOOK_INERT_IN_DOTGIT',
        message: `.git/hooks/${name} 存在但 core.hooksPath=${configured === '' ? '(空)' : configured} -> git **不会执行**它（假安装）`,
      });
    }
    report.push({ name, path: rel, present: true, sha256: actual, match, execSource, execOk, inert });
  }

  // ── runner：hook 脚本靠它落地载荷，缺了照样"有闸不落" ──────────────────────────────────────
  // P14 口径：**跨机核的是名字（清单入库）**，runner 指纹是**本机事实**（`hooks.local.json`）。
  //   有本机态 ⇒ 照核（改了/换机装错当场报 `HOOK_RUNNER_MODIFIED`）；
  //   无本机态（新 clone / 别人给的树）⇒ **如实标注"本机指纹无从核"**（advisory，不判红），
  //   绝不静默当成"核过了" —— 这正是 P14 要治的"静默失败"。
  const runnerInfo = state.runner;
  if (runnerInfo !== null) {
    const runnerRel = `${toPosix(relative(repoRoot, landing))}/${runnerInfo.path ?? HOOK_RUNNER}`;
    const runnerFile = join(landing, runnerInfo.path ?? HOOK_RUNNER);
    if (!existsSync(runnerFile)) {
      findings.push({ code: 'HOOK_RUNNER_MISSING', message: `hook runner 缺失（hook 会在运行时失败）: ${runnerRel}` });
    } else {
      const actual = sha256File(runnerFile);
      if (typeof runnerInfo.sha256 === 'string' && actual !== runnerInfo.sha256) {
        findings.push({
          code: 'HOOK_RUNNER_MODIFIED',
          message: `hook runner 与${state.source === 'local' ? '本机态' : '清单（旧格式）'}不符: ${runnerRel} expected=${runnerInfo.sha256.slice(0, 12)} actual=${actual.slice(0, 12)}`,
        });
      }
    }
  } else if (existsSync(manifestFile)) {
    findings.push({
      code: 'HOOK_RUNNER_UNVERIFIED',
      message: `无本机态（${HOOKS_LOCAL_STATE} 不存在）⇒ runner 指纹**无从核**（跨机口径只核钩子名）: `
        + `${toPosix(relative(repoRoot, landing))}/${HOOK_RUNNER}。要在本机核指纹就重跑一次 \`rk-gate hooks install\`（同参数，不改钩子内容）。`,
      advisory: true,
    });
  }

  // P14：把「跨机核什么 / 本机核什么」在输出里**分开可读**（不让人把"核过名字"读成"核过一切"）
  details.push({ key: 'HOOKS_SCOPE', value: state.localPresent ? 'manifest+local' : 'manifest' });
  details.push({ key: 'HOOKS_LOCAL_STATE', value: state.localPresent ? `present(${HOOKS_LOCAL_STATE})` : `missing(${HOOKS_LOCAL_STATE})` });
  details.push({ key: 'HOOKS_STATE_SOURCE', value: state.source });

  return {
    ok: findings.filter((f) => f.advisory !== true).length === 0,
    repoRoot,
    hooksPath,
    configured,
    expectedPath,
    manifest,
    manifestFile: toPosix(manifestFile),
    localStateFile: toPosix(localStatePathOf(repoRoot)),
    localStatePresent: state.localPresent,
    stateSource: state.source,
    scope: state.localPresent ? 'manifest+local' : 'manifest',
    details,
    hooks: report,
    names: names.length > 0 ? names : [...DEFAULT_HOOK_NAMES],
    findings,
  };
}
