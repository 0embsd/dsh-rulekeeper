// dsh-rulekeeper · N-A12 负向判据：**「全文绝不进 system prompt」**
//
// 判据（写死在这里，读完再下结论）：
//   绿 = ① **索引面**（`registerDelivery` 注册进 `ctx.systemPrompt.context()` 的提供者，及其底层
//          `buildReminderText`）**不含**命中教训的全文片段（只放规则名/摘要行）
//        ② **全文面**（`agent/pre-step` 通道：`pickMatch` / `makePreStepHandler` 注入的文本）
//          **必须含**同一片段
//        ③ 同一断言函数对"泄漏样本"**必红**（证明判据本身有牙，而不是恒真）
//   红 = 全文片段出现在索引面；或片段未出现在全文面（说明通道接反/失效）；或断言对泄漏样本不报
//
// 来历（N-A12，2026-09-28）：4.2 落地后，`deliver.test.mjs` 与 `prestep.test.mjs` 覆盖的都是**投递行为**
//   （产出非空/稳定/预算/去重），**没有一条**断言这个**否命题**——"全文不出现 system prompt 供给面"。
//   本文件就是那一条。
//
// 隔离：用 `helpers/sandbox.mjs` 的一次性落点（规则 47：用例不得写真实落点）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildReminderText, registerDelivery } from '../src/deliver.mjs';
import { pickMatch, registerPreStep } from '../src/prestep.mjs';
import { cleanupAll, freshLanding, ledgerEntry } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const TS = '2026-09-28T00:00:00.000Z';

// 全文独有标记：长且有辨识度，**不应**出现在索引面的摘要行里
const MARKER = 'NA12KEYWORD全文独有片段ABCDEFGHIJKLMNOP';

/** 造一个"有全文可注入"的落点：账本行带 problem/root_cause/solution（= pre-step 的 body） */
function mkLanding(label) {
  return freshLanding(label, {
    entries: [
      ledgerEntry({
        id: 'N12',
        ts: TS,
        rule: 'CAT-CODE',
        problem: `改动前未备份：${MARKER}`,
        root_cause: '把"改前备份"当成可选项',
        solution: '任何改源码前先做备份（fail-closed）',
      }),
    ],
  });
}

/** 从注册进 systemPrompt.context() 的定义里取"索引面文本"（提供者可能是函数或字符串） */
function indexTextOf(landing) {
  const registered = [];
  const ctx = {
    effect: (fn) => fn(),
    systemPrompt: { context: (def) => { registered.push(def); return () => {}; } },
  };
  const cap = registerDelivery(ctx, { landingDir: landing });
  assert.equal(cap.ok, true, `registerDelivery 应成功（实得 ${JSON.stringify(cap)}）`);
  assert.equal(registered.length, 1, '应恰好注册一个 context 提供者');
  const def = registered[0];
  const text = typeof def.text === 'function' ? def.text() : def.text;
  return { text: String(text ?? ''), def };
}

/** 断言函数（判据本体）：索引面不含 MARKER 且 全文面含 MARKER */
function assertSplit({ indexText, fullText }) {
  assert.ok(fullText.includes(MARKER), '全文面必须含标记片段（否则通道失效）');
  assert.ok(!indexText.includes(MARKER), '索引面**不得**含全文片段（N-A12 否命题）');
}

test('N-A12 判据①：索引面（registerDelivery→systemPrompt.context）不含全文片段', () => {
  const { landing } = mkLanding('na12-index');
  const { text } = indexTextOf(landing);
  // 索引面本身应有话说（否则"不含"是空洞成立）
  assert.ok(text.length > 0, `索引面应有内容；实得 ${JSON.stringify(text)}`);
  assert.ok(!text.includes(MARKER), `索引面不得含全文片段；实得：${text.slice(0, 200)}`);
});

test('N-A12 判据②：全文面（pre-step 通道）必须含同一片段', async () => {
  const { landing } = mkLanding('na12-full');
  const hit = pickMatch({ landingDir: landing, query: `备份 ${MARKER}` });
  assert.ok(hit !== null, 'pickMatch 应命中（query 取自该行全文）');
  assert.ok(hit.text.includes(MARKER), `全文面必须含片段；实得：${hit.text.slice(0, 200)}`);

  // 真实 pre-step 处理器（生产入口 registerPreStep → ctx.on('agent/pre-step')）注入的文本同样必须含该片段
  const listeners = new Map();
  const ctx = {
    effect: (fn) => fn(),
    on: (event, fn) => { listeners.set(event, fn); return () => {}; },
  };
  const reg = registerPreStep(ctx, { landingDir: landing });
  assert.equal(reg.ok, true, `registerPreStep 应成功（实得 ${JSON.stringify(reg)}）`);
  const listener = listeners.get('agent/pre-step');
  assert.equal(typeof listener, 'function', '应注册 agent/pre-step 监听器');

  const original = [{ id: 'u1', role: 'user', content: `备份 ${MARKER}` }];
  const decision = await listener({ messages: original }, async () => ({ kind: 'enter', messages: original }));
  const injected = (decision?.messages ?? []).map((m) => String(m.content ?? '')).join('\n');
  assert.ok(injected.includes(MARKER), `pre-step 注入必须含片段；实得：${injected.slice(0, 200)}`);
});

test('N-A12 判据③（合体）：索引面与全文面**分处两条通道**，且判据对泄漏样本必红', () => {
  const { landing } = mkLanding('na12-split');
  const { text: indexText } = indexTextOf(landing);
  const hit = pickMatch({ landingDir: landing, query: `备份 ${MARKER}` });
  assert.ok(hit !== null, 'pickMatch 应命中');

  // 正样本：分处两条通道 ⇒ 通过
  assertSplit({ indexText, fullText: hit.text });

  // **反向红**：构造"把全文塞回索引面"的泄漏样本 ⇒ 同一断言必须报红
  let leaked = false;
  try {
    assertSplit({ indexText: `${indexText}\n${hit.text}`, fullText: hit.text });
  } catch {
    leaked = true;
  }
  assert.equal(leaked, true, '泄漏样本（全文进了索引面）必须被这条判据判红——否则判据没有牙');

  // 反向红之二：全文面拿不到片段（通道失效）也必须报红
  let broken = false;
  try {
    assertSplit({ indexText, fullText: '（注入失败，只有标题）' });
  } catch {
    broken = true;
  }
  assert.equal(broken, true, '全文面缺片段（通道失效）必须被判红');
});

test('N-A12 判据④：索引面文本长度受预算约束（全文放不进去的结构性原因）', () => {
  const { landing } = mkLanding('na12-budget');
  const built = buildReminderText({ landingDir: landing, now: new Date(TS), maxChars: 300 });
  assert.ok(built.chars <= 300, `索引面不得超过预算（实得 ${built.chars}）`);
  assert.ok(!built.text.includes(MARKER), '预算内的索引面不得含全文片段');
});
