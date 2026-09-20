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
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const USAGE_FILE = 'usage.json';
export const USAGE_SCHEMA = 1;

/**
 * **文本指纹**（跨重启去重 + 跨通道去重用；sha256 前 16 字节足够区分，且不把正文写进状态文件）。
 *
 * 为什么放在 usage.mjs（2026-09-21 从 `scoped.mjs` 移过来）：它服务的对象就是**落盘的去重状态**
 * （`emissions`），而根通道（`deliver.mjs`）也要用同一个指纹写/读同一张表 —— 若留在 `scoped.mjs`，
 * `deliver.mjs` 就得反向 import（`scoped.mjs` 已 import `deliver.mjs` ⇒ 循环依赖）。
 * `scoped.mjs` 继续 re-export 这个名字（既有用例与调用方不受影响）。
 */
export function textSha(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 32);
}

/**
 * 根通道（进程级、拿不到 agent）的投递状态记在**这个伪会话键**上。
 *
 * 两个用途（同一份状态、两个读者）：
 *   · **计数器语义诚实化**：根通道的投递此前只计数、不落"投给了谁"⇒ `emitted` 里混着根通道的量，
 *     而它是**进程级一份**（一次投递进所有会话的装配）。记成 `(root)` 后，"按会话"读数才说得清。
 *   · **跨通道指纹去重**：作用域通道算出的文本与根通道刚投过的一致 ⇒ 不重复投（见 scoped.mjs 的
 *     `ROOT_DEDUP_WINDOW_MS`）。键用括号包住，与真实会话 id（宿主形如 `session-<uuid>`）不会撞。
 */
export const ROOT_EMISSION_KEY = '(root)';

/**
 * `emissions` 的保留上限与保鲜期（2026-09-21 修：原来是硬编码 20 键）。
 *
 * 为什么必须改：20 键是"单会话单落点"时代拍的数；现在①一个会话会往**它用到的每个落点**各写一条
 * （并集：项目 + 用户级），②多会话/多项目主机上很容易超过 20 个会话 ⇒ 触顶后按时间淘汰**最早**的会话，
 * 那些会话下次回来会被当成"没投过" ⇒ 重启后重复一次（正是这张表要防的事）。故：上限提到 200，
 * 并加**保鲜期**淘汰（只清超过 30 天没动过的），使上限只在真正的大主机上才生效。
 */
export const EMISSIONS_CAP = 200;
export const EMISSIONS_MAX_AGE_DAYS = 30;

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
    // `emissions`（跨重启去重的按会话状态）**必须在这里保留**：本函数白名单式重建对象，
    // 漏一个键就等于"写进去又被吃掉了"（2026-09-20 实测：投递状态写盘后读不回来，
    // 因为 normalize 只保留 schema/rules/totalEmitted —— 同一族已犯过三次的错）。
    ...(normalizeEmissions(raw.emissions) === null ? {} : { emissions: normalizeEmissions(raw.emissions) }),
  };
}

/** `emissions` 的形状归一（非法项丢弃；整体非法 ⇒ null） */
function normalizeEmissions(src) {
  if (src === null || typeof src !== 'object' || Array.isArray(src)) return null;
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (typeof k !== 'string' || k === '') continue;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) continue;
    if (typeof v.sha !== 'string' || v.sha === '') continue;
    out[k] = { sha: v.sha, at: typeof v.at === 'string' ? v.at : null };
  }
  return out;
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
  // 按会话读数（2026-09-21 计数器语义）：`emitted` 是"投递动作"计数，混了**通道数**（根通道一次进所有
  // 会话）与**重启次数**（同一会话跨重启可能再投一次）⇒ 不能直接当"命中了几次"用。
  // 这里把落盘的去重状态按会话摊开（含 `(root)` 伪会话），让"到底投给过几个会话/多少次"可读。
  const emissions = usage.emissions !== null && typeof usage.emissions === 'object' ? usage.emissions : {};
  const sessionRows = Object.entries(emissions)
    .map(([key, v]) => ({ key, sha: typeof v?.sha === 'string' ? v.sha : null, at: typeof v?.at === 'string' ? v.at : null, root: key === ROOT_EMISSION_KEY }))
    .sort((a, b) => String(b.at ?? '') < String(a.at ?? '') ? -1 : (String(b.at ?? '') > String(a.at ?? '') ? 1 : (a.key < b.key ? -1 : 1)));
  return {
    totalEmitted: usage.totalEmitted,
    totalEvaluated,
    rows,
    sessions: sessionRows.filter((s) => s.root !== true).length,   // 真实会话数（不含根通道伪会话）
    rootEmission: sessionRows.find((s) => s.root === true) ?? null,
    sessionRows,
  };
}

/**
 * **投递状态**（跨进程记忆）：最近投给**某个会话**的文本指纹。
 *
 * 为什么需要它（2026-09-20 线上实测到的重复）：插件的跨轮去重（`lastText`）只在**内存**里，
 *   进程一重启就没了 ⇒ 下一轮同一条文本又被当成"新文本"投一次 ⇒ **同一段提醒在会话里出现两份**。
 *   实测证据：`rulekeeper-boot.jsonl` 里两次重启各投一次同样的 842 字符文本（都标 `emitted=True`），
 *   而上下文里那段提醒确实**出现两遍**。
 * 形状：`usage.json` 顶层 `emissions: { <会话id>: { sha, at } }`（**按会话分开记**——
 *   只记"最后一条"的话，多会话会互相覆盖，导致每次切回来都重投）。
 * @returns {{sha: string, at: string|null}|null}
 */
export function readEmission(landingDir, agentKey) {
  const key = typeof agentKey === 'string' && agentKey !== '' ? agentKey : null;
  if (key === null) return null;
  const usage = readUsage(landingDir);
  const row = usage.emissions !== null && typeof usage.emissions === 'object' ? usage.emissions[key] : null;
  if (row === null || typeof row !== 'object' || typeof row.sha !== 'string' || row.sha === '') return null;
  return { sha: row.sha, at: typeof row.at === 'string' ? row.at : null };
}

/** 记下"这个会话收到了什么指纹"（原子写；失败返回 false，**绝不抛**） */
export function writeEmission(landingDir, agentKey, { sha, at = null } = {}) {
  const key = typeof agentKey === 'string' && agentKey !== '' ? agentKey : null;
  if (key === null || typeof sha !== 'string' || sha === '') return false;
  const usage = readUsage(landingDir);
  const emissions = usage.emissions !== null && typeof usage.emissions === 'object' ? { ...usage.emissions } : {};
  emissions[key] = { sha, at: at === null ? new Date().toISOString() : String(at) };
  // 有界（2026-09-21 修）：先按**保鲜期**淘汰久未动过的，再按上限淘汰最旧的。
  // 排序用**码位比较**（S5_LOCALE_COMPARE 禁 localeCompare：跨平台/跨语言环境下结果不稳定）。
  // `(root)` 键**永不淘汰**：它承载根通道的跨通道去重状态（进程级一份），不是"某个会话的历史"。
  const atOf = (k) => String(emissions[k]?.at ?? '');
  const staleBefore = new Date(Date.now() - EMISSIONS_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  for (const k of Object.keys(emissions)) {
    if (k === ROOT_EMISSION_KEY) continue;
    const at = atOf(k);
    if (at !== '' && at < staleBefore) delete emissions[k];
  }
  const keys = Object.keys(emissions);
  if (keys.length > EMISSIONS_CAP) {
    const sorted = keys.slice().sort((a, b) => {
      const x = atOf(a);
      const y = atOf(b);
      if (x < y) return -1;
      if (x > y) return 1;
      return a < b ? -1 : (a > b ? 1 : 0);
    });
    let over = keys.length - EMISSIONS_CAP;
    for (const k of sorted) {
      if (over <= 0) break;
      if (k === ROOT_EMISSION_KEY) continue;   // 根通道状态不参与淘汰
      delete emissions[k];
      over -= 1;
    }
  }
  usage.emissions = emissions;
  return writeUsage(landingDir, usage);
}
