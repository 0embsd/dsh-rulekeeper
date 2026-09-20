// dsh-rulekeeper · 落点与配置（LF-100 种子模块）
//
// 归属：本模块是 P1 的"落点 + config"最小实现。后续按清单扩展，**不新开模块**（模块收敛 4+1）：
//   - LF-120（schema v1 冻结）：config.json 字段表与版本字段（schema）
//   - LF-130（跨平台基线）：paths/clock/out —— 本文件的 dshHome/landingDirs 会被并进 platform 层
//   - LF-230（rules 规则包）：config 作为规则包的运行时覆盖层
// 零依赖：只用 node:* 内置模块（LF-100 判据：package.json 无 dependencies）

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { dshHome, resolveProjectLanding, resolveUserLanding } from './platform/paths.mjs';

export const SCHEMA_VERSION = 1;
export const MODES = Object.freeze(['observe', 'armed', 'off']);
export const CONFIG_FILE = 'config.json';

// dshHome 的**单点定义**已挪到 platform/paths.mjs（LF-130 平台层：home 四级兜底）；
// 这里 re-export 以保持既有调用方（selfcheck / 测试）不变——避免同一逻辑两处实现。
export { dshHome };

/** 两处落点：项目级 `<project>/.dsh-ai/rulekeeper`、用户级 `<DSH_HOME>/rulekeeper`（Q3 双本）
 *  R2 兼容窗口：老落点 `.dsh-ai/lessonflow` / `<DSH_HOME>/lessonflow` 已存在时**优先沿用**（不搬、不新建）。 */
export function landingDirs({ projectRoot = process.cwd(), env = process.env } = {}) {
  return {
    project: resolveProjectLanding(projectRoot),
    user: resolveUserLanding(env),
  };
}

export function defaultConfig() {
  return { schema: SCHEMA_VERSION, mode: 'observe' };
}

/** 校验 config 形状，返回问题字符串数组（空数组 = 合法） */
export function validateConfig(obj) {
  const out = [];
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return ['config 必须是 JSON 对象'];
  }
  if (obj.schema !== SCHEMA_VERSION) {
    out.push(`schema 必须是 ${SCHEMA_VERSION}（实际 ${JSON.stringify(obj.schema)}）`);
  }
  if (!MODES.includes(obj.mode)) {
    out.push(`mode 必须是 ${MODES.join('|')} 之一（实际 ${JSON.stringify(obj.mode)}）`);
  }
  // 锚定式人签字（2026-09-19，契约扩展位）：落点级开关。true ⇒ 没有"问过真人"的凭证一律不许写 rules.json。
  if (Object.hasOwn(obj, 'requireAnchoredApproval') && typeof obj.requireAnchoredApproval !== 'boolean') {
    out.push(`requireAnchoredApproval 必须是布尔（实际 ${JSON.stringify(obj.requireAnchoredApproval)}）`);
  }
  return out;
}

/** 读落点的"要不要锚定人签字"开关（**读不了就当作 false**：不能因为配置读不到就把写通路锁死，但也绝不假装锚定过） */
export function requireAnchoredApprovalOf(landingDir) {
  try {
    return loadConfig(landingDir).requireAnchoredApproval === true;
  } catch {
    return false;
  }
}

/**
 * 建立两处落点；已存在的 config.json **一律不覆盖**（幂等，保护用户已改的 mode）
 * @returns {{dirs: object, created: string[], kept: string[]}}
 */
export function ensureLanding({ projectRoot = process.cwd(), env = process.env } = {}) {
  const dirs = landingDirs({ projectRoot, env });
  const created = [];
  const kept = [];
  for (const dir of Object.values(dirs)) {
    mkdirSync(dir, { recursive: true });
    const cfg = join(dir, CONFIG_FILE);
    if (existsSync(cfg)) {
      kept.push(cfg);
      continue;
    }
    writeFileSync(cfg, `${JSON.stringify(defaultConfig(), null, 2)}\n`, 'utf8');
    created.push(cfg);
  }
  return { dirs, created, kept };
}

/** 读取并校验某落点的 config；非法即 throw（调用方按 rc 契约映射退出码） */
export function loadConfig(dir) {
  const cfg = join(dir, CONFIG_FILE);
  if (!existsSync(cfg)) throw new Error(`缺少配置文件: ${cfg}`);
  let obj;
  try {
    obj = JSON.parse(readFileSync(cfg, 'utf8'));
  } catch (err) {
    throw new Error(`配置不是合法 JSON: ${cfg}（${err.message}）`);
  }
  const problems = validateConfig(obj);
  if (problems.length > 0) throw new Error(`配置非法: ${cfg} -> ${problems.join('；')}`);
  return obj;
}
