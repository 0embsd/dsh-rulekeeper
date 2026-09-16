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
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { LANDING_DIRNAME, LEGACY_LANDING_DIRNAME, resolveProjectLanding, toPosix } from './platform/paths.mjs';

export const HOOKS_MANIFEST = 'hooks.json';
export const HOOK_RUNNER = 'hook.mjs';
export const DEFAULT_HOOKS_PATH = '.githooks';
/**
 * 默认装两个 hook（LF-520 + LF-510）：
 *   `pre-commit`  = 真阻断（LF-500：改受保护路径未留证就拒）
 *   `post-commit` = **绕过可检测**（LF-510）：`--no-verify` **不跳过 post-commit**（本机实测：
 *                   `--no-verify` 时 pre-commit 不跑、post-commit 照跑）⇒ 它是"被绕过"这件事的取证位置。
 */
export const DEFAULT_HOOK_NAMES = Object.freeze(['pre-commit', 'post-commit']);
export const KNOWN_HOOK_NAMES = Object.freeze(['pre-commit', 'post-commit']);
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
 * hook runner（本机产物，含 dsh-rulekeeper 绝对路径）：按 hook 名决定**载荷**。
 *   pre-commit  → ① `precommit --repo`（LF-500：暂存区视角，改受保护路径未留证即拒）② `write --project`（LF-530：工作区视角）
 *   post-commit → `postcommit --repo`（LF-510：记录本次提交的取证结论；`--no-verify` 时它仍会跑 ⇒ 绕过留痕）
 * 为什么 pre-commit 要两道门：它只看得见暂存区，**未暂存的直写**天生看不见（LF-530 是覆盖那一段的唯一位置）。
 */
export function hookRunnerContent({ gateBin }) {
  return [
    '#!/usr/bin/env node',
    '// dsh-rulekeeper hook runner（由 `rk-gate hooks install` 生成；本机产物，请勿手改）',
    "import { spawnSync } from 'node:child_process';",
    `const GATE_BIN = ${JSON.stringify(toPosix(gateBin))};`,
    'const hook = process.argv[2] ?? \'\';',
    'const repo = process.env.RULEKEEPER_REPO ?? process.cwd();',
    'const stepsByHook = {',
    "  'pre-commit': [['precommit', ['--repo', repo]], ['write', ['--project', repo, '--phase', 'close']]],",
    "  'post-commit': [['postcommit', ['--repo', repo]]],",
    '};',
    'const steps = stepsByHook[hook];',
    'if (steps === undefined) {',
    '  process.stderr.write("dsh-rulekeeper hook: 未知 hook 名 " + hook + "（未装任何门禁；只装过 pre-commit / post-commit）\\n");',
    '  process.exit(0);',
    '}',
    'for (const [cmd, args] of steps) {',
    '  const r = spawnSync(process.execPath, [GATE_BIN, cmd, ...args], { stdio: \'inherit\' });',
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
 * `rk-gate hooks install`：写 hook 脚本（入 `<hooksPath>/`）+ runner + manifest，并把 `core.hooksPath` 指到 `<hooksPath>`。
 * **默认会改本仓 git config**（`--no-config` 可跳过）：不改的话 hook 根本不会被执行 —— 那是"假安全"。
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
  for (const name of names) {
    if (!KNOWN_HOOK_NAMES.includes(name)) return { ok: false, reasons: [`未知 hook 名 "${name}"（只支持 ${KNOWN_HOOK_NAMES.join(' / ')}）`], hooksPath, names: [...names] };
    const file = join(hooksDir, name);
    const content = hookScriptContent({ name });
    const sha = sha256Text(content);
    if (existsSync(file) && opts.force !== true) {
      const current = sha256File(file);
      if (current !== sha) return { ok: false, reasons: [`${hooksPath}/${name} 已存在且内容不同（用 --force 覆盖）`], hooksPath, names: [...names] };
    }
    writeLfNoBom(file, content);
    // POSIX 上给可执行位（Windows 上是 no-op）；权威口径仍是索引 mode（见 verifyHooks）
    try { chmodSync(file, 0o755); } catch { /* Windows：无 exec 位，忽略 */ }
    written.push({ name, sha256: sha, bytes: Buffer.byteLength(content, 'utf8') });
  }
  const runner = hookRunnerContent({ gateBin });
  const runnerFile = join(landing, HOOK_RUNNER);
  writeLfNoBom(runnerFile, runner);
  const runnerSha = sha256Text(runner);

  let configSet = false;
  let configValue = null;
  // LF-810 判据原文要求"摘 hook **先记原值**"：装之前先读一次，把"原本指向哪 / 原本就没设"这件事本身写进清单。
  // 不记的话，卸载时只能靠猜（猜错 = 把用户原有的 hooksPath 抹掉，属"卸载破坏环境"）。
  //
  // M4（独立审查）：**重装**（升级重跑 / `--force`）时不能把"自己上次设的值"当成原值——
  //   否则卸载会把 `core.hooksPath` 还成一个指向已被删目录的悬空路径。判据：已有清单 + 当前值 == 该清单的
  //   `hooksPath` ⇒ 沿用**旧清单里的 previous**（那才是真正的原值）。
  const observed = readHooksPath(repoRoot, runGit);
  let previous = { hooksPath: observed.hooksPath, existed: observed.present };
  try {
    const old = JSON.parse(readFileSync(manifestPathOf(repoRoot), 'utf8'));
    const oldPrev = old !== null && typeof old === 'object' ? old.previous : null;
    if (old !== null && typeof old === 'object' && oldPrev !== null && typeof oldPrev === 'object'
      && typeof old.hooksPath === 'string' && observed.present === true && observed.hooksPath === old.hooksPath) {
      previous = { hooksPath: typeof oldPrev.hooksPath === 'string' ? oldPrev.hooksPath : null, existed: oldPrev.existed === true };
    }
  } catch { /* 无旧清单 / 坏 JSON：按**实测**原值记（不猜） */ }
  if (opts.setConfig !== false) {
    const r = runGit(repoRoot, ['config', 'core.hooksPath', hooksPath]);
    configSet = r.ok;
    configValue = hooksPath;
    if (!r.ok) reasons.push(`git config core.hooksPath 设置失败: ${r.stderr || r.error || '(未知)'}`);
  }
  const manifest = {
    schema: 1,
    createdAt: now.toISOString(),
    hooksPath,
    hooks: written,
    runner: { path: HOOK_RUNNER, sha256: runnerSha, bytes: Buffer.byteLength(runner, 'utf8') },
    // LF-810：卸载所需的**安装前状态**（"原值 + 本来有没有" + 我们到底改没改过 config）
    previous: { hooksPath: previous.hooksPath, existed: previous.existed === true },
    configChanged: opts.setConfig !== false && configSet,
  };
  writeLfNoBom(manifestPathOf(repoRoot), `${JSON.stringify(manifest, null, 2)}${EOL}`);
  return {
    ok: reasons.length === 0,
    reasons,
    repoRoot,
    hooksPath,
    hooksDir: toPosix(hooksDir),
    installed: written,
    runnerSha,
    configSet,
    configValue,
    previous: manifest.previous,
    configChanged: manifest.configChanged,
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
  let manifest = null;
  if (!existsSync(manifestFile)) {
    findings.push({ code: 'HOOK_MANIFEST_MISSING', message: `缺 hooks 清单（先跑 rk-gate hooks install）: ${toPosix(relative(repoRoot, landing))}/${HOOKS_MANIFEST}` });
  } else {
    try {
      manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
      if (manifest === null || typeof manifest !== 'object' || !Array.isArray(manifest.hooks)) {
        findings.push({ code: 'HOOK_MANIFEST_INVALID', message: 'hooks 清单结构不合法（缺 hooks 数组）' });
        manifest = null;
      }
    } catch (err) {
      findings.push({ code: 'HOOK_MANIFEST_UNREADABLE', message: `hooks 清单读不了: ${err?.message ?? ''}` });
    }
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

  // runner：hook 脚本靠它落地载荷，缺了照样"有闸不落"
  if (manifest !== null && manifest.runner !== null && typeof manifest.runner === 'object') {
    const runnerRel = `${toPosix(relative(repoRoot, landing))}/${manifest.runner.path ?? HOOK_RUNNER}`;
    const runnerFile = join(landing, manifest.runner.path ?? HOOK_RUNNER);
    if (!existsSync(runnerFile)) {
      findings.push({ code: 'HOOK_RUNNER_MISSING', message: `hook runner 缺失（hook 会在运行时失败）: ${runnerRel}` });
    } else {
      const actual = sha256File(runnerFile);
      if (typeof manifest.runner.sha256 === 'string' && actual !== manifest.runner.sha256) {
        findings.push({
          code: 'HOOK_RUNNER_MODIFIED',
          message: `hook runner 与清单不符: ${runnerRel} expected=${manifest.runner.sha256.slice(0, 12)} actual=${actual.slice(0, 12)}`,
        });
      }
    }
  }

  return {
    ok: findings.length === 0,
    repoRoot,
    hooksPath,
    configured,
    expectedPath,
    manifest,
    manifestFile: toPosix(manifestFile),
    hooks: report,
    names: names.length > 0 ? names : [...DEFAULT_HOOK_NAMES],
    findings,
  };
}
