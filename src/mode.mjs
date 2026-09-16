// dsh-rulekeeper · LF-800 **`off` 档零副作用**（模式判定 + 写入闸）
//
// 判据（清单 LF-800）：
//   绿 = `off` 下跑一天会话 + 一次提交 → `.dsh-ai/lessonflow/**` **mtime 集合不变**
//   红 = **有任何写入 → 必红**
//
// 为什么需要一个**写入闸**：模式（mode）如果只写进 config 而没人读，就是"死开关"——看起来关掉了，其实照样落盘。
//   所以所有落盘入口（台账 / 门禁台账 / 快照备份）都必须在写之前问一次 `offGuard()`。
// 零依赖：只用 node:*。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 三档模式（与 LF-100 的 config.json 契约一致） */
export const MODES = Object.freeze(['observe', 'armed', 'off']);
export const DEFAULT_MODE = 'observe';

/**
 * 读落点模式：config.json 缺失 / 坏 JSON / 字段非法 → **按默认 observe**（fail-safe 到"最保守的记录档"，
 * 而不是"静默 off"——把 off 当默认会让所有门禁凭空消失）。
 */
export function readMode(landingDir) {
  try {
    const cfg = JSON.parse(readFileSync(join(String(landingDir), 'config.json'), 'utf8'));
    const m = cfg !== null && typeof cfg === 'object' ? cfg.mode : undefined;
    return typeof m === 'string' && MODES.includes(m) ? m : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

export function isOff(landingDir) {
  return readMode(landingDir) === 'off';
}

/**
 * **写档位**（LF-820 止损用）：只改 `mode`，其余字段原样保留；**回读校验**（不信"写盘调用成功"）。
 * 非法档位一律拒绝（返回 ok:false）——档位是契约，不是自由文本。
 * @returns {{ok: boolean, before: string|null, after: string|null, reason: string|null}}
 */
export function writeMode(landingDir, mode) {
  if (!MODES.includes(mode)) return { ok: false, before: null, after: null, reason: `非法档位 ${JSON.stringify(mode)}（允许 ${MODES.join('/')}）` };
  const file = join(String(landingDir), 'config.json');
  let cfg = {};
  let before = null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) cfg = parsed;
    before = typeof cfg.mode === 'string' ? cfg.mode : null;
  } catch {
    // config 缺失/坏 JSON：**新建**一份最小合法 config（档位是唯一必填项）
    before = null;
  }
  cfg.mode = mode;
  try {
    writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: 'utf8' });
  } catch (err) {
    return { ok: false, before, after: null, reason: `${err.code ?? 'ERR'}: ${err.message}` };
  }
  const after = readMode(landingDir);
  if (after !== mode) return { ok: false, before, after, reason: `回读不一致：期望 ${mode} 实得 ${after}` };
  return { ok: true, before, after, reason: null };
}

/**
 * **写入闸**（唯一入口）：off 档一律不许写。
 * @param {string} landingDir 落点
 * @param {string} target 要被写的对象（用于消息里点名）
 * @returns {{off: boolean, allowed: boolean, finding: object|null}}
 */
export function offGuard(landingDir, target = '(unknown)') {
  if (!isOff(landingDir)) return { off: false, allowed: true, finding: null };
  return {
    off: true,
    allowed: false,
    finding: {
      code: 'MODE_OFF_NO_WRITE',
      message: `mode=off：**零副作用** —— 拒绝写入 ${target}（off 档不写任何文件、不改 git 行为、不注入）`,
    },
  };
}

/** 落点下的文件清单 + mtime（判据原文用"mtime 集合不变"来判"零写入"） */
export function landingFingerprint(landingDir, { readdirSync, statSync } = {}) {
  const rd = readdirSync ?? null;
  const st = statSync ?? null;
  if (rd === null || st === null) throw new Error('landingFingerprint: 需要传入 readdirSync/statSync（避免与 node:fs 重复导入）');
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = rd(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(abs, r);
      else out.push(`${r}@${st(abs).mtimeMs}`);
    }
  };
  if (existsSync(String(landingDir))) walk(String(landingDir), '');
  return out.sort();
}
