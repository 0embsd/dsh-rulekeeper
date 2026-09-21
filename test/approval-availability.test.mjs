// dsh-rulekeeper · 审批**三态分开**用例（2026-09-21，交接 A1）
//
// 判据（读死再下结论）：
//   ① "拒绝" / "协议对不上" / "**审批通道不可用**" 必须分成三态，不许糊成一句"无法判定"
//   ② 不可用态必须给**独立错误码**（`EFFECT_APPROVAL_UNAVAILABLE`）与**可执行的等价通路**
//   ③ 三态一律 fail-closed：一个字都不写（本文件只验判定层；写路径的 fail-closed 由 handlers 用例覆盖）
//
// 红 = 上面任一条被放宽（例如把"空应答"也算成"人拒绝了"）

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { answererUnavailable, buildApprovalQuestion, parseApprovalAnswer } from '../src/approval.mjs';

const q = buildApprovalQuestion({ rule: 'X', proposalId: 'P-1', summary: 's', landing: 'l' });
const at = (selected, extra = {}) => ({ answers: [{ id: q.id, selected, ...extra }] });

test('判据①: 三态分开 —— 拒绝 / 协议对不上 / 通道不可用', () => {
  const reject = parseApprovalAnswer(at(['拒绝']), q.id);
  assert.equal(reject.decision, 'reject');
  assert.equal(answererUnavailable(reject), false, '人拒绝不是"通道不可用"');

  const noItem = parseApprovalAnswer({ answers: [{ id: 'other', selected: ['批准落盘'] }] }, q.id);
  assert.equal(noItem.decision, 'unknown');
  assert.equal(answererUnavailable(noItem), false, '问与答对不上属**协议问题**，不该说成"通道不可用"');

  const malformed = parseApprovalAnswer(null, q.id);
  assert.equal(malformed.decision, 'unknown');
  assert.equal(answererUnavailable(malformed), false, '应答形状不合法属协议问题');

  const empty = parseApprovalAnswer({ answers: [] }, q.id);
  assert.equal(answererUnavailable(empty), false, '根本没有本问题的应答项 ⇒ 协议/未提问，不是"问了没人答"');

  const blank = parseApprovalAnswer(at([]), q.id);
  assert.equal(blank.decision, 'unknown');
  assert.equal(answererUnavailable(blank), true, '问了但选空 ⇒ 审批通道不可用');

  const custom = parseApprovalAnswer(at([], { custom: '我再想想' }), q.id);
  assert.equal(answererUnavailable(custom), true, '只有自定义文本、没选项 ⇒ 同样按"不可用"处置（fail-closed）');
});

test('判据②: 批准态不受影响（三态改造不得把"批准"也带偏）', () => {
  const approve = parseApprovalAnswer(at(['批准落盘']), q.id);
  assert.equal(approve.decision, 'approve');
  assert.equal(answererUnavailable(approve), false);
});

test('判据②b: handlers 的不可用分支必须带独立错误码与等价通路（源码级断言）', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/handlers.mjs', import.meta.url), 'utf8');
  assert.match(src, /EFFECT_APPROVAL_UNAVAILABLE/, '必须给独立错误码，别让人猜');
  assert.match(src, /decision: 'approval-unavailable'/);
  assert.match(src, /这不是"你拒绝了"/, '文案必须显式区分"拒绝"与"路不通"（规则 43 同族的自曝）');
  assert.match(src, /rk-effect apply --landing/, '必须给出可执行的等价通路');
});
