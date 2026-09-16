// dsh-rulekeeper · LF-130 平台层：路径归一（跨平台判据的地基）
//
// 为什么必须单点：跨平台实测差异里，"路径写法"是最容易让判据假红/假绿的一类
// （盘符大小写、`\` vs `/`、`\\?\` 长路径前缀、UNC、尾斜杠）。所有比较、索引、去重
// **一律先过 toPosix/pathKey**，禁止各处自己拼字符串比较。
//
// 归属：core 模块（与 ledger/rules/io 同层）。零依赖：只用 node:*。

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Windows 长路径前缀 `\\?\`（大小写无关的 `\\?\` 形式） */
const LONG_PREFIX = /^\\\\\?\\/;

/**
 * **落点目录名**（`.dsh-ai/` 下那一层，以及用户级 `<DSH_HOME>/` 下那一层）。
 *
 * 唯一的权威源：别处一律 `resolveProjectLanding()` / `resolveUserLanding()`，**不许再写字面量**
 * （selfcheck **S7** 会机械拦下硬编码）。
 *
 * 历史（两轮改名，教训都写在这里）：
 *   · 2026-09-15 改名 `lessonflow` → `dsh-rulekeeper` 时，一次性文本替换把
 *     `join(root, '.dsh-ai', 'lessonflow')` 里的**落点名字面量**也换掉了 ⇒ CLI 默认落点漂移到
 *     `.dsh-ai/dsh-rulekeeper`、真项目数据看不见（selfcheck `S3_LANDING_MISSING`）⇒ 当时把落点名收敛成
 *     常量并把值**冻结**为 `'lessonflow'`（"产品名可改、落点不能跟着改"）。
 *   · 2026-09-16 老板批 R2（选 D）：落点**正式改名 `rulekeeper`**，老落点留**兼容窗口**：
 *     解析顺序 = 显式指定 > 已存在的新落点 > **已存在的旧落点** > 新落点（新建用新名）。
 *     ⇒ "新用户拿到正确名字、老项目零迁移继续可用"，数据搬迁由 `rk-migrate` 显式执行（不替用户动数据）。
 */
export const LANDING_DIRNAME = 'rulekeeper';
/** 旧落点名（**仅供兼容解析**；不得用于新建） */
export const LEGACY_LANDING_DIRNAME = 'lessonflow';
/** 落点相对路径（posix，用于消息/relPath）：`.dsh-ai/rulekeeper`（分隔符固定 `/`，落盘字段用） */
export const LANDING_REL = `.dsh-ai/${LANDING_DIRNAME}`;
/** 旧落点相对路径（兼容窗口内的**读**路径） */
export const LEGACY_LANDING_REL = `.dsh-ai/${LEGACY_LANDING_DIRNAME}`;

/**
 * 项目级落点解析（**唯一入口**）。
 * @param {string} projectRoot 项目根
 * @param {string|null} explicit 显式 `--landing`（原样 resolve；不做兼容探测）
 * @returns {string} 原生绝对路径；**不创建目录**
 */
export function resolveProjectLanding(projectRoot, explicit = null) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return resolve(expandHome(explicit.trim()));
  const root = resolve(projectRoot ?? process.cwd());
  const next = join(root, '.dsh-ai', LANDING_DIRNAME);
  if (existsSync(next)) return next;
  const legacy = join(root, '.dsh-ai', LEGACY_LANDING_DIRNAME);
  if (existsSync(legacy)) return legacy;   // 兼容窗口：老项目在原地读写（不搬、不新建）
  return next;
}

/** 用户级落点解析（同上语义：`<DSH_HOME>/rulekeeper`，老 `<DSH_HOME>/lessonflow` 兼容） */
export function resolveUserLanding(env = process.env) {
  const home = dshHome(env);
  const next = join(home, LANDING_DIRNAME);
  if (existsSync(next)) return next;
  const legacy = join(home, LEGACY_LANDING_DIRNAME);
  if (existsSync(legacy)) return legacy;
  return next;
}

/** 新旧两处落点**同时存在**（数据分叉风险 → selfcheck/doctor 报告警，R2 兼容窗口期专用） */
export function hasBothLandings(projectRoot) {
  const root = resolve(projectRoot ?? process.cwd());
  return existsSync(join(root, '.dsh-ai', LANDING_DIRNAME)) && existsSync(join(root, '.dsh-ai', LEGACY_LANDING_DIRNAME));
}

/**
 * 归一为 posix 形式（跨平台可比较的"显示/判据形态"，**不是** fs 可用的原生路径）：
 *   `\\?\C:\x`      -> `c:/x`
 *   `C:\a\B`        -> `c:/a/B`（**盘符小写**、其余大小写保留）
 *   `c:\a\\b\`      -> `c:/a/b`（去重复斜杠与尾斜杠）
 *   `\\srv\share\a` -> `//srv/share/a`（UNC 保留双斜杠）
 *   `C:\`           -> `c:/`（盘根不塌成 `c:`）
 *
 * 注意区分两个函数：**展示/落盘**用 toPosix（保留正文大小写），
 * **作键**用 pathKey（再折叠大小写）——判据里比较路径一律用 pathKey。
 */
export function toPosix(input) {
  if (typeof input !== 'string') return '';
  let s = input.trim();
  if (s === '') return '';
  if (LONG_PREFIX.test(s)) s = s.replace(LONG_PREFIX, '');
  s = s.replace(/\\/g, '/');
  if (s.startsWith('//')) {
    s = `//${s.slice(2).replace(/\/{2,}/g, '/')}`;
  } else {
    s = s.replace(/\/{2,}/g, '/');
  }
  s = s.replace(/^([A-Za-z]):\//, (_, drive) => `${drive.toLowerCase()}:/`);
  if (s.length > 1 && s.endsWith('/')) {
    const trimmed = s.replace(/\/+$/, '');
    s = trimmed === '' ? '/' : trimmed.endsWith(':') ? `${trimmed}/` : trimmed;
  }
  return s;
}

/**
 * 路径**作键**用（去重/索引/查表）：posix 归一 + 折叠大小写
 * （Windows FS 不区分大小写；Linux 区分——宁可多合并也不许漏，故统一折叠）
 */
export function pathKey(input) {
  return toPosix(input).toLowerCase();
}

/** home 兜底顺序：USERPROFILE → HOME → HOMEDRIVE+HOMEPATH → os.homedir() */
export function homeDir(env = process.env) {
  const drive = typeof env.HOMEDRIVE === 'string' ? env.HOMEDRIVE.trim() : '';
  const rest = typeof env.HOMEPATH === 'string' ? env.HOMEPATH.trim() : '';
  const candidates = [env.USERPROFILE, env.HOME, drive && rest ? `${drive}${rest}` : ''];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '') return c.trim();
  }
  return homedir();
}

/** 展开开头的 `~` / `~/` / `~\`；其余原样返回 */
export function expandHome(input, env = process.env) {
  if (typeof input !== 'string') return '';
  if (input === '~') return homeDir(env);
  if (input.startsWith('~/') || input.startsWith('~\\')) return join(homeDir(env), input.slice(2));
  return input;
}

/** DSH_HOME 兜底：env.DSH_HOME（去空白）→ <home>/.dsh。返回**原生**路径（供 fs 使用） */
export function dshHome(env = process.env) {
  const raw = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  return raw ? resolve(raw) : join(homeDir(env), '.dsh');
}

/**
 * 相对项目根的 posix 相对路径（判据里**禁止出现绝对路径**）；
 * 不在根下时返回 null；等于根时返回 '.'。
 */
export function relativeToRoot(input, root) {
  const target = toPosix(input);
  const base = toPosix(root).replace(/\/+$/, '');
  if (target === '' || base === '') return null;
  const t = pathKey(target);
  const b = pathKey(base);
  if (t === b) return '.';
  if (!t.startsWith(`${b}/`)) return null;
  return target.slice(base.length + 1);
}
