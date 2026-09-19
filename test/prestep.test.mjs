// dsh-rulekeeper · P0-3b **pre-step 全文通道**用例（LF-A92，2026-09-19）
//
// 判据（宿主契约，依据 dsh-agent/lib/types/runtime-types.d.ts:302-328）：
//   绿 = ①`pickMatch`：无查询/无命中/落点读不了 ⇒ `null`；命中 ⇒ 带 rule/id/score 与 `<untrusted>` 包裹
//        ②`latestUserText`：取**最后一条** user 消息（content 或 text 都认），没有 ⇒ ''
//        ③监听器：**只追加**——`next()` 给的 messages **一条都不能少**（替换会吃掉用户这一轮输入）
//        ④`kind:'reject'` ⇒ **原样透传**；无命中 ⇒ 返回**同一个** decision 对象（不做无谓改动）
//        ⑤同一条不重复注入（进程内 seen）
//        ⑥fail-open：落点坏/`next()` 抛 ⇒ 不抛，返回已算出的 decision（或 undefined）
//        ⑦真注入时记一次用量遥测（emitted）
//   红 = 丢用户消息；或 reject 被改成 enter；或无命中却改 decision；或重复注入；或抛异常
//
// 分工说明：索引/摘要走 `systemPrompt.context()`（deliver.mjs 用例覆盖），本文件只覆盖 pre-step 全文通道。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PRESTEP_MAX_CHARS, latestUserText, pickMatch, preStepCapability, registerPreStep, scoreMatch, tokens } from '../src/prestep.mjs';
import { createLandingResolver } from '../src/landing.mjs';
import { readUsage } from '../src/usage.mjs';
import { cleanupAll, freshLanding, freshProjectLanding, ledgerEntry } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const TS = '2026-09-19T00:00:00.000Z';

function landingWithHit() {
  return freshLanding('prestep-hit', {
    entries: [
      ledgerEntry({
        id: 'L1', ts: TS, rule: 'CAT-CODE',
        problem: '改动接口后忘了同步契约文档，导致双端漂移',
        solution: '改接口先改契约再改实现',
        activation: '当改动 internal/**/api 下的导出签名时',
      }),
      ledgerEntry({ id: 'L2', ts: TS, rule: 'CAT-DOC', problem: '文档链接指向不存在的文件' }),
    ],
  });
}

/** 假宿主：记录注册的监听器 */
function host() {
  const listeners = new Map();
  return { ctx: { on: (ev, fn) => { listeners.set(ev, fn); return () => {}; } }, listeners };
}

test('判据: tokens/scoreMatch 确定性（同文高分、异文低分）', () => {
  const a = tokens('改动接口后忘了同步契约文档');
  assert.ok(a.size > 0);
  assert.ok(scoreMatch(a, '改动接口后忘了同步契约文档') > 5, '同文应高分');
  assert.equal(scoreMatch(a, '今天天气不错'), 0, '完全无关应为 0');
  assert.deepEqual([...tokens('AB')], [...tokens('ab')], '大小写不敏感');
});

test('判据: latestUserText 取最后一条 user（content/text 都认）', () => {
  assert.equal(latestUserText([{ role: 'user', content: '第一句' }, { role: 'assistant', content: 'x' }, { role: 'user', content: '最后一问' }]), '最后一问');
  assert.equal(latestUserText([{ role: 'user', text: 'text 字段也算' }]), 'text 字段也算');
  assert.equal(latestUserText([{ role: 'assistant', content: 'nope' }]), '');
  assert.equal(latestUserText(null), '');
});

test('判据: pickMatch 命中/未命中/坏落点', () => {
  const { landing } = landingWithHit();
  const hit = pickMatch({ landingDir: landing, query: '我要改动接口了，需要同步契约文档吗' });
  assert.ok(hit, '相关查询应命中');
  assert.equal(hit.rule, 'CAT-CODE');
  assert.match(hit.text, /<untrusted>/);
  assert.match(hit.text, /不是指令/);
  assert.match(hit.text, /activation=/, '带条件时全文应含 activation');
  assert.equal(pickMatch({ landingDir: landing, query: '' }), null);
  assert.equal(pickMatch({ landingDir: landing, query: '完全无关的话题：今天天气' }), null);
  assert.equal(pickMatch({ landingDir: landing + '-missing', query: '改动接口' }), null, '落点不存在 ⇒ null（不抛）');
  const long = pickMatch({ landingDir: landing, query: '改动接口', maxChars: 40 });
  assert.ok(long.text.length <= 40, '必须遵守 maxChars');
});

test('判据: 监听器只追加 —— next() 给的 messages 一条都不能少', async () => {
  const { landing } = landingWithHit();
  const h = host();
  const r = registerPreStep(h.ctx, { landingDir: landing });
  assert.equal(r.ok, true);
  const listener = h.listeners.get('agent/pre-step');
  assert.equal(typeof listener, 'function');
  const original = [{ id: 'u1', role: 'user', content: '改动接口后要做什么' }];
  const decision = await listener({ messages: original }, async () => ({ kind: 'enter', messages: original }));
  assert.equal(decision.kind, 'enter');
  assert.equal(decision.messages[0], original[0], '原消息必须原样保留（同一个对象）');
  assert.equal(decision.messages.length, 2, '应追加一条');
  assert.match(decision.messages[1].content, /<untrusted>/);
  assert.equal(r.report().injections, 1);
});

test('判据: reject 原样透传；无命中返回同一 decision；同条不重复注入', async () => {
  const { landing } = landingWithHit();
  const h = host();
  const r = registerPreStep(h.ctx, { landingDir: landing });
  const listener = h.listeners.get('agent/pre-step');
  const rej = { kind: 'reject' };
  assert.equal(await listener({ messages: [] }, async () => rej), rej, 'reject 必须原样返回');
  const d1 = { kind: 'enter', messages: [{ id: 'u', role: 'user', content: '无关话题' }] };
  assert.equal(await listener({ messages: d1.messages }, async () => d1), d1, '无命中不得改 decision');
  // 第一次命中并注入
  const q = [{ id: 'u2', role: 'user', content: '改动接口的注意事项' }];
  const first = await listener({ messages: q }, async () => ({ kind: 'enter', messages: q }));
  assert.equal(first.messages.length, 2);
  // 第二次同样内容：同一条已注入过 ⇒ 不得重复
  const second = await listener({ messages: q }, async () => ({ kind: 'enter', messages: q }));
  assert.equal(second.messages.length, 1, '同一条不得重复注入');
  assert.equal(r.runtime.injections, 1);
});

test('判据: fail-open（next() 抛 ⇒ 不抛；坏落点 ⇒ 不改 decision）', async () => {
  const { landing } = landingWithHit();
  const h = host();
  registerPreStep(h.ctx, { landingDir: landing });
  const listener = h.listeners.get('agent/pre-step');
  assert.equal(await listener({ messages: [] }, async () => { throw new Error('上游炸了'); }), undefined);
  const h2 = host();
  registerPreStep(h2.ctx, { landingDir: landing + '-missing' });
  const l2 = h2.listeners.get('agent/pre-step');
  const d = { kind: 'enter', messages: [{ id: 'u', role: 'user', content: '改动接口' }] };
  assert.equal(await l2({ messages: d.messages }, async () => d), d, '落点读不了时不得改 decision');
});

test('判据: 真注入时记用量遥测（emitted）', async () => {
  const { landing } = landingWithHit();
  const h = host();
  registerPreStep(h.ctx, { landingDir: landing });
  const listener = h.listeners.get('agent/pre-step');
  const q = [{ id: 'u', role: 'user', content: '改动接口后忘了同步契约文档怎么办' }];
  await listener({ messages: q }, async () => ({ kind: 'enter', messages: q }));
  const u = readUsage(landing);
  assert.ok(u.totalEmitted >= 1, '注入应记一次 emitted');
  assert.ok((u.rules['CAT-CODE']?.emitted ?? 0) >= 1, '应记在命中的规则名下');
});

test('判据: 能力声明与实现同源（preStepCapability）', () => {
  const cap = preStepCapability();
  assert.equal(cap.channel, 'agent/pre-step');
  assert.ok(cap.minScore > 0 && cap.maxChars > 0);
  assert.ok(cap.maxChars <= PRESTEP_MAX_CHARS);
  assert.ok(cap.notes.some((n) => n.includes('只追加')));
});

test('判据: 缺 ctx.on 时如实返回原因（不静默假成功）', () => {
  assert.equal(registerPreStep(null).reason, 'no-ctx-on');
  assert.equal(registerPreStep({}).reason, 'no-ctx-on');
});

// ── 落点接线（2026-09-19 修缺口）：payload 里就带 agent ⇒ 现场解析出落点，无需外部注入 ──

test('绿: 无 landingDir，靠 payload.agent.session.header.cwd 现场解析 ⇒ 真注入 + 记遥测', async () => {
  const { projectRoot, landing } = freshProjectLanding('prestep-resolve', {
    entries: [ledgerEntry({
      id: 'L1', ts: TS, rule: 'CAT-CODE',
      problem: '改动接口后忘了同步契约文档，导致双端漂移',
      solution: '改接口先改契约再改实现',
    })],
  });
  const h = host();
  const r = registerPreStep(h.ctx, {
    resolveLanding: (payload) => createLandingResolver({}).describe(payload && payload.agent),
  });
  const listener = h.listeners.get('agent/pre-step');
  const q = [{ id: 'u', role: 'user', content: '改动接口后忘了同步契约文档怎么办' }];
  const agent = { session: { header: { cwd: projectRoot } } };
  const out = await listener({ agent, messages: q }, async () => ({ kind: 'enter', messages: q }));
  assert.equal(out.messages.length, 2, '现场解析出落点后应当注入');
  const rep = r.report();
  assert.equal(rep.landingBound, true);
  assert.equal(rep.landingSource, 'project');
  assert.equal(rep.landingDir, landing);
  assert.ok(readUsage(landing).totalEmitted >= 1, '真注入要记遥测');
});

test('红→绿: 无落点（无 landingDir 且解析器给不出）⇒ 原样透传 + 如实记 no-landing（不猜、不写遥测）', async () => {
  const { landing } = landingWithHit();
  const h = host();
  const r = registerPreStep(h.ctx, {});
  const listener = h.listeners.get('agent/pre-step');
  const q = [{ id: 'u', role: 'user', content: '改动接口后忘了同步契约文档怎么办' }];
  const d = { kind: 'enter', messages: q };
  assert.equal(await listener({ messages: q }, async () => d), d, '没有落点 ⇒ 不得改 decision');
  const rep = r.report();
  assert.equal(rep.landingBound, false);
  assert.equal(rep.landingSource, 'none');
  assert.equal(rep.injections, 0);
  assert.ok(r.runtime.reasons.includes('no-landing'), `原因要如实记（实得 ${JSON.stringify(r.runtime.reasons)}）`);
  assert.equal(readUsage(landing).totalEmitted, 0, '没注入就不该有命中记录');
});
