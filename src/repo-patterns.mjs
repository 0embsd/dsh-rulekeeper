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

/** 散文口令判据里"值"的形状（供正则与 `allow()` 共用，避免两处口径不一致） */
const PROSE_VALUE_RE = /[A-Za-z_][A-Za-z0-9_@#$%^&*+=.!~-]{3,}$/;
/** 关键词（`allow()` 复核用；与上面那条正则的关键词表**必须同源**，改一处就要改另一处） */
const PROSE_KEYWORD_RE = /(?:password|passwd|pwd|api[_-]?key|secret[_-]?key|access[_-]?key|私钥|密钥|密码|口令)/i;
/**
 * 更严的那条凭据判据（`key[:=] "值"`，值 ≥8 字符）。**必须与 INFRA_PATTERNS 里的字面量同源**：
 * 这里只用它做"本条是否与它重叠"的判定（重叠 ⇒ 不重复报），口径漂移会导致漏报或重复报。
 */
const STRICT_CRED_RE = /\b(?:ali[_-]?key|ali[_-]?secret|cf[_-]?token|aws_secret_access_key|api[_-]?key|password|passwd)\b\s*[:=]\s*['"][^'"]{8,}/i;

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
    // **散文语境的口令**（P15，2026-09-23）。工单实测的漏检形态：上面那条只认 `key[:=] "值"`，
    // 而"⟨关键词⟩是⟨口令值⟩"这种**散文写法**一路漏过去（他们那边真漏过一次）。
    // ⚠ 本注释里那个真实样例**故意不写成连续字面量**（写成示例会被本条判据自己命中 —— 实测过一次）：
    //   要复现请用 `node -e` 拼串，或看 `test/prose-secret.test.mjs` 的**运行时拼装**样本（规则 51 同向）。
    // 判定 = 关键词 + **分隔符（是/为/＝/=/:/：，或英文 is）** + 口令值：
    //   · 值以字母/下划线开头、≥4 字符（挡 `0640` / `77-81` 这类行号）；
    //   · `allow` 再挡三类**代码/占位**写法（见下方注释）。
    //
    // 误报面（规则 53 第①步：先量后写，**误报面读数**）：真仓 279 文件 **0 命中**；
    // 被治理仓 1292 文件 **0 命中**（但那仓有一处硬编码口令的测试样本由**上面那条**判据拦到，
    // 本条不重复报；具体串不写进本文件 —— 写进来会被 S8 判成"本文件含凭据真值"，实测过一次）。
    // 判别力（负样本 15/15 不命中、正样本 5/5 命中）；样本清单与推导留在提交信息与用例里。
    //
    // **已登记边界（不当成"已覆盖"）**：值旁边没有任何分隔符的写法（`口令 hunter2x`）与
    // 纯字母的裸值（`密码是 correcthorse`，正则分不出"普通词"与"口令"）**不报**。
    // 收紧优先于放宽：公开面误报会拦住正常提交，而"漏一种写法"由人复核兜。
    re: /(?<![\w.$:])(?:password|passwd|pwd|api[_-]?key|secret[_-]?key|access[_-]?key|私钥|密钥|(?<!口)密码|口令)\s*(?:是|为|＝|=|:|：|\bis\b)\s*["'「『]?([A-Za-z_][A-Za-z0-9_@#$%^&*+=.!~-]{3,})/gi,
    why: '散文语境里的口令真值',
    allow: (rel, s) => {
      // `rel` 未用：这里没有**按文件豁免**，只有按内容判定（见下）—— 与规则 51 同向：不为用例开例外。
      void rel;
      const value = PROSE_VALUE_RE.exec(s)?.[0] ?? '';
      const kw = PROSE_KEYWORD_RE.exec(s);
      const tail = kw === null ? s : s.slice(kw.index + kw[0].length);
      // ① 与上面那条更严的判据（`key[:=] "值"`，值 ≥8 字符）**不重叠**：那条已经**真会**拦的，本条不再重复报。
      //    判据是"同一个串会不会被那条拦"，不是"有没有等号" —— 实测栽过：`pwd = "短值"` 里 `pwd`
      //    不在那条的关键词表里 ⇒ 那条根本拦不住，被这条的重叠守卫顺手放过去就是**漏检**。
      if (STRICT_CRED_RE.test(s)) return true;
      // ①b **无空白的整串赋值**（`KEY=VALUE`）：这是"把凭据钉在代码或文档里举例"的写法，属**凭据样本**
      //    而非"散文里提到口令" —— 它的拦截面归上面那条（以及 redact 判据），本条不抢。
      //    实测：本仓夹具串（拼接而成，见用例）就是这一形态，漏掉这个约束会让新判据把**检测器自己的
      //    样本**报成泄漏（一次性红了 16 条用例，实测过）。
      //    ⚠ **不能**写成 `\S+\s*[:=]\s*\S+`（允许空白）：那会把我要抓的正样本 `pwd = "值"` 一起放掉
      //      （写宽一档就漏检，写窄一档就误报检测器自己的样本 —— 这条线是两向实测压出来的）。
      if (/^\S+[:=]\S+$/.test(s)) return true;
      // ② 占位词：`password: example` / `your` / `xxx` / `changeme`…
      if (/^(?:example|your|the|my|some|xxx+|todo|none|null|undefined|false|true|string|number|changeme|placeholder|redacted)$/i.test(value)) return true;
      // ② 代码赋值（`=` 紧跟值之前）：那是实现里的写法，不是散文 —— 实测 `password = splitCred(args[2])` 最常误报
      if (/=\s*$/.test(tail.slice(0, Math.max(0, tail.lastIndexOf(value))))) return true;
      // ③ 值是**全大写标识符**（环境变量名，如 `apiKey = OPENAI_API_KEY`）⇒ 不是口令
      if (/^[A-Z][A-Z0-9_]*$/.test(value)) return true;
      // ④ 散文里"关键词 + 是/为 + 单个普通小写词"（`密码是 restore` / `password 是 msmtp`）：
      //    裸值**必须含数字**（真口令通常带数字，普通词几乎不带）—— 本轮实测收窄出来的那条线。
      const quoted = /["'「『]/.test(s) && /["'」』]/.test(s);
      if (!/\d/.test(value) && !quoted) return true;
      // ⑤ 带引号但引号里不是口令（含非 ASCII，如 `"见附件"`）
      if (quoted && !/^[\x20-\x7e]*$/.test(value)) return true;
      return false;
    },
  },
  {
    // **只看真正的路径形态**（规则 53：新判据先在真仓跑误报面）。这一条改了两轮，两轮都是**实测**逼出来的：
    //   ① 旧写法 `\b(?:id_rsa|id_ed25519)\b|\.pem\b` 命中**子串** ⇒ `.gitignore` 里的忽略规则
    //      `*.pem` / `id_rsa*`（**配置内容**，不是凭据）被判成"私钥文件名" ⇒ 给预设仓装钩子当场拒提交；
    //   ② 收紧成"路径位置"时漏了 `m` 标志 ⇒ `^` 只匹配整段文本开头，中间行的 `deploy/id_rsa` 反而**漏过**
    //      （反向红实测抓到）。
    // 现写法：允许前导路径分隔（`/` `\`），或行首，且**后随**必须是路径非词字符（`/` `\` `:` 空白 行尾）；
    // 行首紧跟 `*` `?`（通配）一律不算 —— 那是 ignore 规则。
    // 前导用**拉丁字母/数字的否定回看**（`(?<![\w.*?])`）而不是"行首或斜杠"：因为中文里
    // 「文件 id_ed25519 丢了」这种写法太常见，紧贴着汉字也算**裸文件名**（写这一行时被用例抓到）。
    re: /(?<![\w.*?])(?:id_rsa|id_ed25519)(?![\w.*?])|(?:^|[/\\]|[\s"'(=])(?<![*?<]\.)[\w@.-]{2,}\.pem\b/m,
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
