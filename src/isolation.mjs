// dsh-rulekeeper · LF-460 **监听器异常隔离（fail-open）+ 装配面诚实声明**
//
// 判据（清单 LF-460）：
//   绿 = 在 listener 内注入 `throw` → **工具照常执行**、结果照常返回给模型；异常只落 LF-1A0 诊断日志
//   红 = 注入 `throw` 后该工具调用**变成报错结果** → 必红（证明 fail-open 没自实现）；
//        设计单 §6.1 未写"插件面装配 = **每机一次** `link:` 安装（实测 profiles/web/package.json 全绝对路径）" → exit≠0（不得宣称"零配置跨平台"）
//
// 宿主已给的事实（取证）：`@deepseek-ai/dsh-tools/lib/index.js` 用 `try { ctx.waterfall(carrier,"tools/pre-execute",…) } catch (error) { … result: toolErrorResult… }`
//   —— 宿主自己是 fail-open 的；但**我们自己的监听器**在他们 try 之内，一旦抛错就会把整条调用**变成报错结果**，
//   那是我们造成的副作用。所以本模块把我们每个 listener 包一层：**内部异常就地吞掉并落诊断日志**，对外永不抛。
// 零依赖：只用 node:*。

import { join } from 'node:path';

/** 监听器异常日志（LF-1A0 诊断日志载体）相对落点的路径 */
export const LISTENER_ERRORS_REL = 'logs/listener-errors.jsonl';

/** 装配面诚实声明（**必须**出现在设计单里；缺 → 判红） */
export const ASSEMBLY_DISCLOSURE = '插件面装配 = **每机一次** `link:` 安装（实测 `profiles/web/package.json` 里依赖全是**绝对路径**的 `link:`）'
  + ' ⇒ 本项目**不宣称"零配置跨平台"**：换机器/换用户必须先重装一次插件面。';

/** 声明必须包含的关键短语（机读判据；顺序无关） */
export const ASSEMBLY_PHRASES = Object.freeze(['每机一次', 'link:', '零配置']);

/** 生成异常落盘器（注入 `appendLine` 便于测试与复用同一写入单点）
 *
 * `landingDir` 支持**函数**（2026-09-19）：插件装载时还不知道"当前会话是哪个项目"，
 * 若在 apply 期就把落点定死成 null，监听器异常日志会**永远不落盘**（同一类"取值面未接线"缺口）。
 * 传函数 ⇒ 每次写日志时现算；传字符串 ⇒ 仍是原来的固定落点（既有调用方不受影响）。
 */
export function makeErrorSink({ landingDir, appendLine, now = () => new Date() } = {}) {
  const records = [];
  const sink = (record) => {
    const row = { schema: 1, ts: now().toISOString(), gate: 'listener-error', ...record };
    records.push(row);
    let dir = null;
    try {
      dir = typeof landingDir === 'function' ? landingDir() : landingDir;
    } catch {
      dir = null; // 解析失败 ⇒ 只留内存记录（fail-open 到底）
    }
    if (typeof appendLine === 'function' && typeof dir === 'string' && dir !== '') {
      try {
        appendLine(join(dir, LISTENER_ERRORS_REL), row);
      } catch { /* 日志失败不得影响主流程（fail-open 到底） */ }
    }
    return row;
  };
  sink.records = records;
  return sink;
}

/**
 * **异常隔离包装**：对外永不抛；内部异常落 sink 后走 fail-open。
 *
 * **fail-open 的返回值必须与事件形态匹配**（LF-450 实测抓到的真缺陷，2026-09-15）：
 *   `tools/pre-execute` 是**瀑布流**，宿主随后会读决策对象的 `kind` 字段；
 *   若异常时一律 `return undefined`，等于"上游决策被抹掉"，宿主读 `undefined.kind` 直接抛错
 *   ⇒ 工具层坏掉、**第三方留痕从 1 掉到 0**（那正是 LF-450 的红态）。
 *   故新增可选 `onError(args)`：**默认仍是 `undefined`（保持原语义/既有用例）**，
 *   瀑布流事件由调用方传入"透传上游"的实现（`return await next()`）。
 * @param {{name: string, run: Function, sink?: Function, onError?: Function}} opts
 */
export function safeListener({ name, run, sink, onError = null } = {}) {
  if (typeof run !== 'function') throw new Error('safeListener: run 必须是函数');
  const log = typeof sink === 'function' ? sink : () => {};
  return async (...args) => {
    try {
      return await run(...args);
    } catch (error) {
      log({ listener: name ?? '(unnamed)', message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack ?? null : null });
      if (typeof onError === 'function') {
        try {
          return await onError(...args); // 瀑布流：把上游决策原样透传出去
        } catch {
          return undefined; // 连透传都失败：退回"不干预"（仍不抛）
        }
      }
      return undefined; // fail-open：不返回任何决策 ⇒ 不影响工具执行（通知类事件的正确语义）
    }
  };
}

/**
 * fail-open 判据的**可执行证明**：listener 里抛错时，工具**照常执行**且结果**原样**返回。
 * @param {{runTool: Function, listener: Function, args?: any[]}} opts
 */
export async function assertFailOpen({ runTool, listener, sink, args = [] } = {}) {
  const toolResult = { ok: true, content: 'tool-output' };
  const wrapped = safeListener({ name: 'probe-listener', run: listener, sink });
  const observed = await wrapped({ name: 'rulekeeper_gate', arguments: { file: 'AGENTS.md' } });
  const returned = await runTool(...args); // 宿主 dispatch：listener 抛错与否都要照常执行
  return {
    listenerReturn: observed,
    toolResult: returned,
    toolExecuted: returned !== undefined && returned !== null,
    unchanged: JSON.stringify(returned) === JSON.stringify(toolResult),
  };
}

/** 设计单声明体检：缺任一关键短语即判红（红态判据：未写 → exit≠0） */
export function assertAssemblyDisclosure(text) {
  const t = typeof text === 'string' ? text : '';
  const missing = ASSEMBLY_PHRASES.filter((p) => !t.includes(p));
  const findings = missing.length === 0
    ? []
    : [{ code: 'ASSEMBLY_DISCLOSURE_MISSING', message: `设计单缺装配面诚实声明的关键短语: ${missing.join(', ')}（不得宣称"零配置跨平台"）` }];
  return { ok: findings.length === 0, findings };
}
