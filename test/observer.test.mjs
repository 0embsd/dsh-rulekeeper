// dsh-rulekeeper · LF-440 **观察者清点 + 顺序契约**用例
//
// 判据：绿 = 「事件×插件×位次(含 prepend)」表无空行；只读 result.content、不返回 content。
//   红 = 返回 {kind:'accept',content} → 必红；上游 deny 后记 upstream_denied 而非静默。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  KNOWN_THIRD_PARTY, OBSERVER_EVENTS, assertNoEmptyRows, assertObserverContract, buildOrderTable,
  classifyUpstream, observeResult, thirdPartyInventory,
} from '../src/observer.mjs';

/** 同场四插件 + 我们（位次由 prepend + 注册序决定） */
const FIELD = [
  { event: 'tools/pre-execute', plugin: 'rule-engine' },
  { event: 'tools/pre-execute', plugin: 'rule-engine' },
  { event: 'tools/pre-execute', plugin: 'gate-bypass' },
  { event: 'tools/post-execute', plugin: 'observation-pack' },
  { event: 'tools/post-execute', plugin: 'spill-policy', prepend: true },
  { event: 'tools/post-execute', plugin: 'dsh-rulekeeper' },
  { event: 'agent/pre-step', plugin: 'observation-pack' },
];

test('判据: 顺序表 —— **prepend=true 排最外层**，其余按注册序，位次从 1 连续', () => {
  const rows = buildOrderTable(FIELD);
  const post = rows.filter((r) => r.event === 'tools/post-execute');
  assert.equal(post[0].plugin, 'spill-policy', 'prepend 的必须排最前（最外层）');
  assert.equal(post[0].prepend, true);
  assert.deepEqual(post.slice(1).map((r) => r.plugin), ['observation-pack', 'dsh-rulekeeper']);
  assert.deepEqual(post.map((r) => r.position), [1, 2, 3]);
  const pre = rows.filter((r) => r.event === 'tools/pre-execute');
  assert.equal(pre.length, 3);
  assert.deepEqual(pre.map((r) => r.position), [1, 2, 3], 'pre-execute 无 prepend → 按注册序');
});

test('绿: 表**无空行**（每个事件都有观察者 + 插件名不空 + 位次连续）', () => {
  const rows = buildOrderTable(FIELD);
  const r = assertNoEmptyRows(rows);
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  // 三个事件都在表里
  for (const e of OBSERVER_EVENTS) assert.ok(rows.some((x) => x.event === e), `${e} 必须出现在表里`);
});

test('红: 某事件**没有观察者** → 表出现空行（OBSERVER_EVENT_EMPTY）', () => {
  const rows = buildOrderTable(FIELD.filter((o) => o.event !== 'agent/pre-step'));
  const r = assertNoEmptyRows(rows);
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.code === 'OBSERVER_EVENT_EMPTY' && f.message.includes('agent/pre-step')));
});

test('红: 插件名为空 / 位次有空洞 → 各自点名', () => {
  const empty = assertNoEmptyRows([{ event: 'tools/pre-execute', plugin: '', position: 1 }]);
  assert.ok(empty.findings.some((f) => f.code === 'OBSERVER_PLUGIN_EMPTY'));
  const gap = assertNoEmptyRows([{ event: 'tools/pre-execute', plugin: 'a', position: 1 }, { event: 'tools/pre-execute', plugin: 'b', position: 3 }]);
  assert.ok(gap.findings.some((f) => f.code === 'OBSERVER_POSITION_GAP'));
});

test('绿（原文判据）: **只读 result.content、不返回 content** —— 观察者的返回值必须是 undefined', () => {
  const out = observeResult({ exec: { name: 'rk-check' }, result: { content: 'hello' }, upstream: { decision: 'allow' } });
  assert.equal(out.returnValue, undefined, '永不回写');
  assert.equal(out.readOnly.hasContent, true);
  assert.equal(out.readOnly.contentLength, 5);
  assert.equal(assertObserverContract(out.returnValue).ok, true);
  assert.equal(assertObserverContract({}).ok, true);
});

test('红（清单原文）: 返回 `{kind:\'accept\',content}` → **必红**（与 spill-policy/obs-pack 冲突）', () => {
  const r = assertObserverContract({ kind: 'accept', content: '被我改写了' });
  assert.equal(r.ok, false);
  const codes = r.findings.map((f) => f.code);
  assert.ok(codes.includes('OBSERVER_RETURNS_CONTENT'));
  assert.ok(codes.includes('OBSERVER_ACCEPT_WITH_CONTENT'));
  // 只带 content 也红
  assert.equal(assertObserverContract({ content: 'x' }).ok, false);
  // 非对象返回也红
  assert.equal(assertObserverContract('x').findings[0].code, 'OBSERVER_BAD_RETURN');
});

test('红（清单原文）: 上游 deny 后**不许静默** —— 必须标注 upstream_denied', () => {
  const d1 = classifyUpstream({ decision: 'deny' });
  assert.equal(d1.denied, true);
  assert.equal(d1.marker, 'upstream_denied');
  assert.match(d1.reason, /观测不到结果/);
  const d2 = classifyUpstream({ kind: 'deny' });
  assert.equal(d2.marker, 'upstream_denied');
  const ok = classifyUpstream({ decision: 'allow' });
  assert.equal(ok.marker, 'observed');
  // observeResult 把这个标注带出去
  const out = observeResult({ exec: { name: 'x' }, result: null, upstream: { decision: 'deny' } });
  assert.equal(out.marker, 'upstream_denied');
  assert.equal(out.readOnly.hasContent, false);
});

test('判据: 第三方清点（缺谁要看得见，但不判红）', () => {
  const rows = buildOrderTable(FIELD);
  const inv = thirdPartyInventory(rows);
  assert.deepEqual(inv.present.sort(), ['gate-bypass', 'observation-pack', 'rule-engine', 'spill-policy']);
  assert.deepEqual(inv.missing, []);
  const partial = thirdPartyInventory(buildOrderTable([{ event: 'tools/pre-execute', plugin: 'rule-engine' }]));
  assert.ok(partial.missing.includes('spill-policy'));
  assert.equal(KNOWN_THIRD_PARTY.length, 4);
});
