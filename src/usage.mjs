// usage.mjs —— 用量遥测（P0-3 配套；借自 Hermes 的 skills/.usage.json 形态，本地化）
//
// 为什么需要它（L634 的更正结论）：我们此前"只记不用"，根因之一是**没有度量**——
// 不知道哪条纪律真的被投递过、被投递了几次，于是既无法判断该留该淘汰，也无法回答
// "提醒到底有没有送到"。有了本文件，"真实投递次数"就是一个可统计的事实（而不是"有人写过绑定"）。
//
// 落点：`<landing>/usage.json`（与 rules.json 同级；不进项目仓库内容，随落点走）。
// 形状（与 landing 其它 JSON 一致：单文件 + schema 版本）：
//   { "schema": 1, "rules": { "<RULE>": { "evaluated": n, "emitted": n, "lastAt": iso } }, "totalEmitted": n }
//
// 纪律：
//   · **原子写**（写临时文件 + rename），崩溃不留半截文件；
//   · 读失败/损坏一律**降级为空账**（fail-open：度量失败绝不能打断投递）；
//   · 只记事实（evaluated=提供者被求值次数；emitted=返回了非空文本的次数），
//     不臆断"模型看过了"——宿主对相同文本有自己的去重，插件侧观测不到追加结果（如实登记）。
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const USAGE_FILE = 'usage.json';
export const USAGE_SCHEMA = 1;

/** 空的用量账（也是读失败时的降级值） */
export function emptyUsage() {
  return { schema: USAGE_SCHEMA, rules: {}, totalEmitted: 0 };
}

function normalize(raw) {
  if (raw === null || typeof raw !== 'object') return emptyUsage();
  const rules = {};
  const src = raw.rules !== null && typeof raw.rules === 'object' ? raw.rules : {};
  for (const [k, v] of Object.entries(src)) {
    if (v === null || typeof v !== 'object') continue;
    rules[k] = {
      evaluated: Number.isFinite(v.evaluated) ? v.evaluated : 0,
      emitted: Number.isFinite(v.emitted) ? v.emitted : 0,
      lastAt: typeof v.lastAt === 'string' ? v.lastAt : null,
    };
  }
  return {
    schema: USAGE_SCHEMA,
    rules,
    totalEmitted: Number.isFinite(raw.totalEmitted) ? raw.totalEmitted : 0,
  };
}

/** 读用量账；文件缺失/损坏/不可读 ⇒ 空账（不抛） */
export function readUsage(landingDir) {
  try {
    if (typeof landingDir !== 'string' || landingDir.trim() === '') return emptyUsage();
    const p = join(landingDir, USAGE_FILE);
    if (!existsSync(p)) return emptyUsage();
    return normalize(JSON.parse(readFileSync(p, 'utf8')));
  } catch {
    return emptyUsage();
  }
}

/** 原子写用量账；任何失败返回 false（不抛，调用方 fail-open） */
export function writeUsage(landingDir, usage) {
  try {
    if (typeof landingDir !== 'string' || landingDir.trim() === '') return false;
    mkdirSync(landingDir, { recursive: true });
    const dst = join(landingDir, USAGE_FILE);
    const tmp = `${dst}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, `${JSON.stringify(normalize(usage), null, 2)}\n`, 'utf8');
    renameSync(tmp, dst);
    return true;
  } catch {
    return false;
  }
}

/**
 * 记一次投递相关事件。
 * @param {string} landingDir
 * @param {{rule?: string|null, event: 'evaluated'|'emitted', now?: Date}} opts
 * @returns {{ok: boolean, usage: object}} ok=false 表示未能落盘（调用方不得据此中断）
 */
export function bumpUsage(landingDir, { rule = null, event, now = new Date() } = {}) {
  const usage = readUsage(landingDir);
  const key = rule === null || rule === undefined || rule === '' ? '(unknown)' : String(rule);
  const cur = usage.rules[key] ?? { evaluated: 0, emitted: 0, lastAt: null };
  if (event === 'evaluated') {
    cur.evaluated += 1;
  } else if (event === 'emitted') {
    cur.emitted += 1;
    cur.lastAt = now.toISOString();
    usage.totalEmitted += 1;
  } else {
    return { ok: false, usage };
  }
  usage.rules[key] = cur;
  return { ok: writeUsage(landingDir, usage), usage };
}

/** 汇总（供体检/CLI 展示）：按 emitted 降序
 *
 * 【2026-09-19 修缺口，教训 L635 同族】`:totalEvaluated` 是本轮补的：此前汇总只有 emitted，
 * 而"求值了但没投递"（`unchanged` / 最小间隔 hold / 无落点）恰恰是判断"量增是否伤召回"的关键分母。
 * 更根本的缺口是**这份读数此前没有任何生产消费者**（唯一读它的是用例）——"度量没人看 = 没有度量"。
 * 消费者已在 `rk-effect plan`（体检行）与 `rk-effect usage`（明细）接上。
 */
export function usageSummary(landingDir) {
  const usage = readUsage(landingDir);
  const rows = Object.entries(usage.rules)
    .map(([rule, v]) => ({ rule, ...v }))
    .sort((a, b) => b.emitted - a.emitted || (a.rule < b.rule ? -1 : 1));
  const totalEvaluated = rows.reduce((sum, r) => sum + (Number(r.evaluated) || 0), 0);
  return { totalEmitted: usage.totalEmitted, totalEvaluated, rows };
}
