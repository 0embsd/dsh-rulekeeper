// diag.mjs —— 插件装载/投递的**落盘诊断**（2026-09-20）
//
// 为什么必须有它（本轮真实事故）：用户重启 DSH 后，两条自动通道**一条提醒都没发**（全盘没有 `usage.json`），
//   而同一份代码在测试里对任何合理 cwd 都能解析出落点、产出 589–842 字符。也就是说"为什么没发"
//   这个问题，从**进程外面根本查不出来** —— 装载报告只活在内存里（`lastApplyReport`），
//   进程一重启就没了。这违反本仓一贯的"不静默"：**看不见的失败 = 不会被修的失败**。
//
// 落点选择：写 `<DSH_HOME>/rulekeeper-boot.jsonl`（**不依赖落点解析** —— 否则"解析失败"这件事本身
//   就没地方记，正是上一轮踩的坑）。append-only、纯 JSONL、坏行容忍；任何异常都吞掉（诊断绝不打断主流程）。
//
// 归属：core 模块。零依赖：只用 node:*。

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DIAG_FILE = 'rulekeeper-boot.jsonl';
/** 单文件上限（超过就轮转一次，避免诊断文件无限长大） */
export const DIAG_MAX_BYTES = 512 * 1024;

/** 诊断文件路径（`<dshRoot>/rulekeeper-boot.jsonl`） */
export function diagPath(dshRoot) {
  return join(String(dshRoot ?? ''), DIAG_FILE);
}

/**
 * 追加一条诊断（**best-effort**：任何失败都吞掉，绝不抛）。
 * @param {string} dshRoot 宿主根（`~/.dsh`）
 * @param {object} record 任意 JSON 可序列化对象（会补上 schema/ts）
 * @returns {{ok: boolean, path: string|null, reason: string|null}}
 */
export function appendDiag(dshRoot, record, { now = new Date() } = {}) {
  const path = diagPath(dshRoot);
  try {
    if (typeof dshRoot !== 'string' || dshRoot.trim() === '') return { ok: false, path: null, reason: 'no-dshRoot' };
    mkdirSync(String(dshRoot), { recursive: true });
    const row = { schema: 1, ts: (now instanceof Date ? now : new Date()).toISOString(), ...record };
    appendFileSync(path, `${JSON.stringify(row)}\n`, 'utf8');
    return { ok: true, path, reason: null };
  } catch (err) {
    return { ok: false, path, reason: String(err?.message ?? err) };
  }
}

/**
 * 读诊断（容错：坏行计数；文件不存在 ⇒ 空）。
 * @returns {{values: object[], badLines: number, missing: boolean, path: string}}
 */
export function readDiag(dshRoot, { limit = 200 } = {}) {
  const path = diagPath(dshRoot);
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { values: [], badLines: 0, missing: true, path };
  }
  const rows = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const values = [];
  let badLines = 0;
  for (const line of rows) {
    try {
      values.push(JSON.parse(line));
    } catch {
      badLines += 1;
    }
  }
  return { values: values.slice(-limit), badLines, missing: false, path };
}

/**
 * 把插件装载报告压成一条**可读**诊断（只取排查真正需要的字段，避免把整份报告灌进去）。
 *
 * 【2026-09-21 补：`launch`（启动形态）】为什么必须有这一栏：现场出现过"3 次启动里 2 次根通道注册失败
 * （`no-systemPrompt-service`）、另 1 次正常"，而诊断里只有 pid/cwd ⇒ **分不清那 2 次是哪种启动方式**
 * （是另一个 profile？还是同一 profile 的启动期竞态？），只能靠 cwd 猜，白花一轮。
 * 这一栏只记**可观测的启动事实**（argv/execArgv/入口脚本/DSH_HOME），不是推断：
 *   · `argv`/`execArgv`：宿主怎么被拉起来的（profile 名、模式开关通常就在里面）；
 *   · `entry`：主脚本路径（区分 dsh CLI / 其它入口）；
 *   · `dshHome`：落点根（多机器/多用户时区分环境）；
 *   · `profileHint`：从 argv 里抓 `--profile <name>` / `--profile=<name>`（抓不到就是 null，不猜）。
 * @param {{report?: object, dshRoot?: string, cwd?: string, pid?: number, launch?: object}} opts
 */
export function bootDiagRecord({ report = {}, cwd = null, pid = null, launch = null } = {}) {
  const services = report.services ?? {};
  return {
    kind: 'boot',
    pid,
    cwd,
    launch: launch ?? defaultLaunchInfo(),
    landing: report.landing ?? null,
    delivery: report.delivery ?? null,
    scoped: report.scoped ?? null,
    prestep: report.prestep ?? null,
    services,
    subscribed: Array.isArray(report.subscribed) ? report.subscribed : [],
    tools: Array.isArray(report.registered) ? report.registered : [],
    listenerErrors: report.listenerErrors ?? 0,
  };
}

/** 启动形态（**只记事实**；任何一项取不到就 null/空数组，绝不推断、绝不抛） */
export function defaultLaunchInfo({ argv = process.argv, execArgv = process.execArgv, env = process.env } = {}) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  let profileHint = null;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--profile' && typeof args[i + 1] === 'string' && args[i + 1].trim() !== '') profileHint = args[i + 1].trim();
    else if (typeof a === 'string' && a.startsWith('--profile=')) profileHint = a.slice('--profile='.length).trim() || null;
  }
  return {
    argv: args.slice(0, 12),
    execArgv: (Array.isArray(execArgv) ? execArgv : []).map(String).slice(0, 8),
    entry: args[1] ?? null,
    profileHint,
    dshHome: typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '' ? env.DSH_HOME.trim() : null,
  };
}

/**
 * 投递求值诊断（**只在"签名"变化时记**：landing 来源 / 有话说条数 / 结果变了才写，
 * 否则每轮都写会把文件刷满，反而没人看）。
 * @param {string} dshRoot
 * @param {{landing: object|null, built: object, step: object, reason?: string, signature?: string}} info
 * @returns {{written: boolean, signature: string}}
 */
export function deliveryDiagRecord(dshRoot, { landing = null, built = {}, step = {}, reason = null } = {}, { now = new Date() } = {}) {
  const signature = JSON.stringify({
    dir: landing === null ? null : (landing.dir ?? null),
    source: landing === null ? null : (landing.source ?? null),
    rules: Array.isArray(built.rules) ? built.rules : [],
    emitted: step.emitted === true,
    reason: reason ?? built.reason ?? null,
  });
  appendDiag(dshRoot, {
    kind: 'delivery',
    landing,
    rules: Array.isArray(built.rules) ? built.rules : [],
    chars: built.chars ?? 0,
    emitted: step.emitted === true,
    reason: reason ?? built.reason ?? null,
    signature,
  }, { now });
  return { written: true, signature };
}
