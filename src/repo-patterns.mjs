// repo-patterns.mjs —— **按仓库性质分档**的公开面黑名单（2026-09-21，交接第 1 步）
//
// 现场问题（不是设计洁癖）：原来的 `PUBLIC_FACE_FORBIDDEN` 是**一份**表，里面同时装着两类性质完全不同的模式：
//   · **本仓自己的名字**（内部项目名 / 内部工具名 / 内部结果行前缀 / 内部容器仓名）
//     —— 只有"这个仓是公开的"时候，写出这些才叫泄漏；
//   · **基础设施与凭据**（真实 IPv4 / 私钥头 / 私钥文件名 / 云凭据真值 / 本机盘卷路径）
//     —— 无论公开还是私有，写进任何仓都是事故。
// 后果实测：私有仓（如内部项目）里 `myx-*`、主机编号这些**是它自己的名字**，却被当成泄漏 ⇒
//   pre-commit / commit-msg / pre-push 三道门一起拒提交，`rules.json` 这类正常产物也提不上去。
//   而"本仓自己的名字"对私有仓根本没有泄漏语义（它就是在那儿诞生的）。
//
// 分档口径（**单一事实源**，三道门 + S8 + 检查器都读这一份）：
//   public  → 完整表（identity + infra）
//   private → 只跑 infra（主机编号 / IP / 凭据 / 私钥 / 本机绝对路径），**不跑** identity
//
// 解析顺序（`resolveRepoKind`）：
//   ① 落点 `config.json` 的 `repoKind`（显式声明，最高优先；它随仓走，是唯一权威）
//   ② 自动探测：`git remote.origin.url` 指向已知公开托管商 ⇒ public
//   ③ 兜底 **private**（fail-open 到"少扫一类"）：扫多了会拦住内部仓的正常提交，而内部仓本来
//      就不承诺"不出现自己的名字"；基础设施那几条**任何时候都跑**。
//
// 诚实边界：`repoKind` 是**声明**，不是签名 —— 私有仓把自己标成 public 只会更严（自伤不伤人），
//   反过来公开仓标成 private 才能少扫一类，故 **git 层仍需分支保护**（本模块管不了托管商侧）。
//
// 归属：core 模块。零依赖：只用 node:*。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const REPO_KINDS = Object.freeze(['public', 'private']);
export const REPO_KIND_DEFAULT = 'private';

/** 判定"这个仓是公开的还是私有的"的**显式开关名**（写在落点的 config.json 里） */
export const REPO_KIND_FIELD = 'repoKind';

/**
 * **identity 类**：只在**公开仓**里才算泄漏 —— 它们的泄漏语义来自"这个仓的名字/编号不该对外出现"。
 * 私有仓里这些是它自己的标识，扫它们等于自己拦自己。
 */
export const IDENTITY_PATTERNS = Object.freeze([
  { re: /\bmyxV2\b/i, why: '内部项目名' },
  { re: /\bmyx-[a-z]/i, why: '内部工具名' },
  { re: /\bMYX_[A-Z]/i, why: '内部结果行前缀' },
  { re: /\bpresets\b/i, why: '内部容器仓名' },
  { re: /\b101\b/, why: '内部主机编号' },
]);

/**
 * **infrastructure 类**：公开与私有**都跑** —— 主机 IP、私钥、云凭据真值、本机盘卷路径，
 * 写进哪个仓都是事故（私有仓被 clone 走、被截图、被贴到 issue 里，一样会漏）。
 */
export const INFRA_PATTERNS = Object.freeze([
  { re: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/i, why: '本机用户绝对路径' },
  { re: /[A-Za-z]:\\opt\\/i, why: '本机盘符路径' },
  // 「检测器自身必须写出模式」的例外（**只对检测模块生效**，且私钥头还要求文件里没有真密钥正文）：
  //   src/redact.mjs / src/selfcheck.mjs / src/repo-patterns.mjs 是**脱敏/门禁的实现**，它们必须包含
  //   模式字面量 —— 属元数据，不是凭据。防滥用：私钥头例外额外要求"该文件里没有 60+ 字符的 base64
  //   正文"（真密钥被粘进来仍会被抓）。
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    why: '私钥头（凭据）',
    allow: (rel, _s, text) => (rel === 'src/redact.mjs' || rel === 'src/selfcheck.mjs' || rel === 'src/repo-patterns.mjs')
      && !/[A-Za-z0-9+/]{60,}/.test(text),
  },
  {
    re: /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/,
    why: '真实 IPv4（基础设施标识）',
    allow: (rel, s) => s === '127.0.0.1' || s === '0.0.0.0',   // 回环/未指定不算基础设施标识
  },
  { re: /\b(?:ali[_-]?key|ali[_-]?secret|cf[_-]?token|aws_secret_access_key|api[_-]?key|password|passwd)\b\s*[:=]\s*['"][^'"]{8,}/i, why: '云凭据/口令真值' },
  {
    re: /\b(?:id_rsa|id_ed25519)\b|\.pem\b/i,
    why: '私钥文件名（基础设施标识）',
    allow: (rel) => rel === 'src/selfcheck.mjs' || rel === 'src/repo-patterns.mjs',   // 仅本模式表自身
  },
]);

/** 分档表：`public` = identity + infra；`private` = 只 infra */
export function patternsForKind(kind) {
  return kind === 'public' ? [...IDENTITY_PATTERNS, ...INFRA_PATTERNS] : [...INFRA_PATTERNS];
}

/** 兼容别名：公开面完整表（= 公开仓那一档）。既有调用方与用例读它时行为不变。 */
export const PUBLIC_FACE_FORBIDDEN = Object.freeze(patternsForKind('public'));

const PUBLIC_REMOTE_RE = /(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|gitee\.com|git\.sr\.ht)[:/]/i;

/**
 * 从 git 远端探测仓库性质（**只做一次默认判断**，可被 config 覆盖）。
 * @returns {'public'|'private'|null} `null` = 探测不出来（不是 git 仓 / 没有 remote）
 */
export function detectRepoKind(root, { runGitRaw = null } = {}) {
  if (typeof root !== 'string' || root === '' || !existsSync(join(root, '.git'))) return null;
  const run = runGitRaw ?? ((args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }));
  let res;
  try {
    res = run(['config', '--get', 'remote.origin.url']);
  } catch {
    return null;
  }
  if (res === null || res === undefined || res.status !== 0) return null;
  const url = String(res.stdout ?? '').trim();
  if (url === '') return null;
  return PUBLIC_REMOTE_RE.test(url) ? 'public' : 'private';
}

/** 读落点 `config.json` 的显式声明；读不到/非法 ⇒ `null`（交给自动探测） */
export function declaredRepoKind(landingDir) {
  if (typeof landingDir !== 'string' || landingDir === '') return null;
  const file = join(landingDir, 'config.json');
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const kind = parsed?.[REPO_KIND_FIELD];
    return REPO_KINDS.includes(kind) ? kind : null;
  } catch {
    return null;
  }
}

/**
 * 解析"这个仓该跑哪一档"。
 * @param {{root?: string, landingDir?: string, runGitRaw?: Function}} opts
 * @returns {{kind: 'public'|'private', source: 'config'|'remote'|'default', forbidden: Array}}
 */
export function resolveRepoPatterns(opts = {}) {
  const declared = declaredRepoKind(opts.landingDir);
  if (declared !== null) return { kind: declared, source: 'config', forbidden: patternsForKind(declared) };
  const detected = detectRepoKind(opts.root, { runGitRaw: opts.runGitRaw });
  if (detected !== null) return { kind: detected, source: 'remote', forbidden: patternsForKind(detected) };
  return { kind: REPO_KIND_DEFAULT, source: 'default', forbidden: patternsForKind(REPO_KIND_DEFAULT) };
}
