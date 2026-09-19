// dsh-rulekeeper · LF-460 **监听器异常隔离（fail-open）+ 装配面诚实声明**用例
//
// 判据：绿 = listener 内注入 throw → 工具**照常执行**、结果照常返回；异常只落诊断日志
//   红 = 注入 throw 后工具调用**变成报错结果** → 必红；设计单未写装配面诚实声明（每机一次 link:）→ exit≠0。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ASSEMBLY_DISCLOSURE, ASSEMBLY_PHRASES, LISTENER_ERRORS_REL, assertAssemblyDisclosure, assertFailOpen,
  makeErrorSink, safeListener,
} from '../src/isolation.mjs';
import { appendLine } from '../src/append.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

test('绿（清单原文）: **listener 内 throw → 工具照常执行**，结果原样返回给模型（fail-open）', async () => {
  const seen = [];
  const sink = (rec) => seen.push(rec);
  const r = await assertFailOpen({
    listener: () => { throw new Error('监听器炸了'); },
    sink,
    runTool: () => ({ ok: true, content: 'tool-output' }),
  });
  assert.equal(r.listenerReturn, undefined, '包装后对外不产生任何决策');
  assert.equal(r.toolExecuted, true, '工具必须照常执行');
  assert.equal(r.unchanged, true, '结果必须原样返回（没被我们的异常污染）');
  assert.equal(seen.length, 1, '异常必须落诊断日志（不是静默吞）');
  assert.equal(seen[0].listener, 'probe-listener');
  assert.match(seen[0].message, /监听器炸了/);
});

test('红（清单红态）: 未包装的 listener 抛错 → 调用会变成报错结果（证明"包装"不是摆设）', async () => {
  const raw = () => { throw new Error('未包装'); };
  await assert.rejects(async () => raw(), /未包装/);
  // 包装后同一函数不再向外抛
  const wrapped = safeListener({ name: 'x', run: raw, sink: () => {} });
  assert.equal(await wrapped(), undefined);
});

test('判据: 正常返回被**原样透传**（包装不改变行为）', async () => {
  const wrapped = safeListener({ name: 'x', run: (a) => ({ decision: 'deny', reason: `got ${a}` }), sink: () => {} });
  assert.deepEqual(await wrapped('A'), { decision: 'deny', reason: 'got A' });
});

test('判据: **async listener 的 rejection 也被含住**（不是只 catch 同步 throw）', async () => {
  const seen = [];
  const wrapped = safeListener({ name: 'async-x', run: async () => { throw new Error('异步也炸'); }, sink: (r) => seen.push(r) });
  assert.equal(await wrapped(), undefined);
  assert.equal(seen.length, 1);
  assert.match(seen[0].message, /异步也炸/);
});

test('判据: 异常落 **LF-1A0 诊断日志**（真实 appendLine 写盘，行可 JSON 解析）', () => {
  const dir = tempDir('iso-log');
  const landing = join(dir, '.dsh-ai', 'rulekeeper');
  mkdirSync(join(landing, 'logs'), { recursive: true });
  const sink = makeErrorSink({ landingDir: landing, appendLine, now: () => new Date('2026-09-15T00:00:00Z') });
  sink({ listener: 'l1', message: 'boom', stack: null });
  const text = readFileSync(join(landing, LISTENER_ERRORS_REL), 'utf8').trim();
  const row = JSON.parse(text);
  assert.equal(row.gate, 'listener-error');
  assert.equal(row.listener, 'l1');
  assert.equal(row.ts, '2026-09-15T00:00:00.000Z');
  assert.equal(sink.records.length, 1);
});

test('判据: 日志写入失败**不得**把异常抛回主流程（fail-open 到底）', () => {
  const sink = makeErrorSink({ landingDir: '/definitely/not/writable', appendLine: () => { throw new Error('写盘失败'); } });
  assert.doesNotThrow(() => sink({ listener: 'l', message: 'm' }));
  assert.equal(sink.records.length, 1, '即使写盘失败，记录仍留在内存里');
});

// 落点可以是**函数**（2026-09-19）：插件装载时还不知道"当前会话是哪个项目"（agent 还没建），
// 若在 apply 期把落点定死成 null，监听器异常日志会永远不落盘 —— 同一类"取值面未接线"缺口。
test('判据: landingDir 传函数时**每次写日志现算**（装载期未知会话也能落盘）', () => {
  const dir = tempDir('iso-log-fn');
  const landing = join(dir, '.dsh-ai', 'rulekeeper');
  mkdirSync(join(landing, 'logs'), { recursive: true });
  let resolved = null;
  const sink = makeErrorSink({
    landingDir: () => resolved,
    appendLine,
    now: () => new Date('2026-09-15T00:00:00Z'),
  });
  sink({ listener: 'before', message: 'no-landing-yet' });            // 解析不出 ⇒ 只留内存，不写盘、不抛
  assert.equal(existsSync(join(landing, LISTENER_ERRORS_REL)), false, '未解析出落点不得瞎写');
  resolved = landing;                                                 // 会话确定后
  sink({ listener: 'after', message: 'now-we-know' });
  const rows = readFileSync(join(landing, LISTENER_ERRORS_REL), 'utf8').trim().split('\n');
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0]).listener, 'after');
  // 解析器自己抛错 ⇒ 同样 fail-open
  const sink2 = makeErrorSink({ landingDir: () => { throw new Error('resolver boom'); }, appendLine });
  assert.doesNotThrow(() => sink2({ listener: 'l', message: 'm' }));
  assert.equal(sink2.records.length, 1);
});

test('红（清单红态）: 设计单**未写**装配面诚实声明 → 判红（缺哪个短语点名）', () => {
  assert.equal(assertAssemblyDisclosure('随便一段没有关键短语的文字').ok, false);
  const r = assertAssemblyDisclosure('这里只说 link: 安装');
  assert.equal(r.ok, false);
  assert.match(r.findings[0].message, /每机一次/);
  assert.match(r.findings[0].message, /零配置/);
  // 正对照：把声明原文放进去 → 绿
  assert.equal(assertAssemblyDisclosure(ASSEMBLY_DISCLOSURE).ok, true);
  assert.equal(ASSEMBLY_PHRASES.length, 3);
});

test('判据: **设计单 §6.1 真的写了**（路径由 RK_DESIGN_PLAN 注入；公开仓不硬编码内部路径）', {
  skip: process.env.RK_DESIGN_PLAN === undefined ? '未给 RK_DESIGN_PLAN（公开仓不硬编码内部路径；本地/CI 可显式注入）' : false,
}, () => {
  const plan = readFileSync(process.env.RK_DESIGN_PLAN, 'utf8');
  const r = assertAssemblyDisclosure(plan);
  assert.equal(r.ok, true, `设计单必须包含装配面诚实声明（缺: ${JSON.stringify(r.findings)}）`);
});
