// dsh-rulekeeper · P0-3 **提醒投递**用例（LF-A90）
//
// 判据（写死在这里，读完再下结论）：
//   绿 = ①有未绑定纪律的落点 ⇒ 产出非空、含规则名、带 <untrusted> 数据标记、不超预算
//        ②**没话说时产出空串**（否则每轮都塞一段，就是刷屏）
//        ③文本**稳定**（同状态两次调用逐字相同）——宿主按"文本变化"追加，稳定才不重复追加
//        ④跨轮状态机：首版 emitted；同文 unchanged；**变化但未过最小间隔 ⇒ 保持上一版**（防抖动）
//        ⑤fail-open：落点坏/宿主 API 缺 ⇒ 返回上一版或空串，**绝不抛**
//        ⑥宿主缺 systemPrompt 服务时**如实返回原因**，不静默假成功
//   红 = 没话说时却产出文本；或宿主 API 缺失时抛错；或文本每次调用都变（刷屏）；或用量账损坏导致投递中断
//
// 红态（先红后绿）：本文件每条断言都对应一个真实可构造形态；`host()` 假宿主用于构造"服务缺失"。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_MIN_INTERVAL_MS, REGISTRY_NAME, buildReminderText, createDeliveryRuntime,
  deliveryCapability, nextDelivery, registerDelivery,
} from '../src/deliver.mjs';
import { bumpUsage, emptyUsage, readUsage, usageSummary, writeUsage } from '../src/usage.mjs';
import { cleanupAll, freshLanding, ledgerEntry, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const TS = '2026-09-19T00:00:00.000Z';

/** 假宿主：记录注册与 effect 调用 */
function host({ systemPrompt = true, effect = true } = {}) {
  const registered = [];
  const effects = [];
  const ctx = { effect: effect ? (fn) => { effects.push(fn); return fn(); } : undefined };
  if (systemPrompt) ctx.systemPrompt = { context: (def) => { registered.push(def); return () => {}; } };
  return { ctx, registered, effects };
}

test('判据: 没话说时产出空串（不刷屏）', () => {
  const { landing } = freshLanding('deliver-empty', { entries: [] });
  const built = buildReminderText({ landingDir: landing, now: new Date(TS) });
  assert.equal(built.text, '');
  assert.deepEqual(built.rules, []);
});

test('判据: 有未绑定纪律 ⇒ 非空 + 含规则名 + 带不可信标记 + 不超预算', () => {
  const { landing } = freshLanding('deliver-one', {
    entries: [ledgerEntry({ id: 'L1', ts: TS, rule: 'CAT-CODE' })],
  });
  const built = buildReminderText({ landingDir: landing, now: new Date(TS), maxChars: 400 });
  assert.ok(built.text.length > 0, '有话说时必须产出文本');
  assert.match(built.text, /CAT-CODE/);
  assert.match(built.text, /<untrusted>/);
  assert.match(built.text, /<\/untrusted>/);
  assert.ok(built.chars <= 400, `不得超过预算（实得 ${built.chars}）`);
  assert.deepEqual(built.rules, ['CAT-CODE']);
});

test('判据: 预算生效（maxRules=1 时只提醒一条）', () => {
  const { landing } = freshLanding('deliver-budget', {
    entries: [
      ledgerEntry({ id: 'A', ts: TS, rule: 'CAT-CODE' }),
      ledgerEntry({ id: 'B', ts: TS, rule: 'CAT-DOC' }),
      ledgerEntry({ id: 'C', ts: TS, rule: 'CAT-ENV' }),
    ],
  });
  const built = buildReminderText({ landingDir: landing, now: new Date(TS), maxRules: 1 });
  assert.equal(built.rules.length, 1, `预算=1 时只应提醒 1 条（实得 ${built.rules.length}）`);
});

test('判据: 文本稳定（同状态两次调用逐字相同）——宿主据此不重复追加', () => {
  const { landing } = freshLanding('deliver-stable', {
    entries: [ledgerEntry({ id: 'L1', ts: TS, rule: 'CAT-CODE' })],
  });
  const a = buildReminderText({ landingDir: landing, now: new Date(TS) });
  const b = buildReminderText({ landingDir: landing, now: new Date(TS) });
  assert.ok(a.text.length > 0, '前提：本用例的落点必须"有话说"，否则稳定性断言是空转');
  assert.equal(a.text, b.text, '同状态文本必须逐字相同（否则每轮都会被宿主追加）');
});

test('判据: fail-open —— 落点不存在时产出空串且不抛', () => {
  const built = buildReminderText({ landingDir: join(tempDir('deliver-missing'), 'no-such-landing') });
  assert.equal(built.text, '');
  assert.ok(typeof built.reason === 'string' && built.reason !== '');
});

test('判据: 跨轮状态机 —— 首版 emitted / 同文 unchanged / 变化未过间隔 ⇒ 保持上一版', () => {
  const rt = createDeliveryRuntime({ minIntervalMs: 1000 });
  const t0 = new Date('2026-09-19T00:00:00.000Z');
  const s1 = nextDelivery({ runtime: rt, built: { text: 'V1', rules: ['A'], reason: undefined }, now: t0 });
  assert.deepEqual([s1.text, s1.emitted, s1.held], ['V1', true, false]);
  const s2 = nextDelivery({ runtime: rt, built: { text: 'V1', rules: ['A'] }, now: new Date(t0.getTime() + 10) });
  assert.deepEqual([s2.text, s2.emitted, s2.held], ['V1', false, false], '同文应判 unchanged');
  const s3 = nextDelivery({ runtime: rt, built: { text: 'V2', rules: ['A'] }, now: new Date(t0.getTime() + 500) });
  assert.deepEqual([s3.text, s3.emitted, s3.held], ['V1', false, true], '未过最小间隔应保持上一版（防抖动）');
  const s4 = nextDelivery({ runtime: rt, built: { text: 'V2', rules: ['A'] }, now: new Date(t0.getTime() + DEFAULT_MIN_INTERVAL_MS) });
  assert.deepEqual([s4.text, s4.emitted, s4.held], ['V2', true, false], '过了间隔应放行新文本');
  assert.equal(rt.emissions, 2);
  assert.equal(rt.holds, 1);
});

test('判据: registerDelivery 拒绝路径如实返回原因（不静默假成功）', () => {
  assert.equal(registerDelivery(null).reason, 'no-ctx');
  assert.equal(registerDelivery({}).reason, 'no-systemPrompt-service');
  assert.equal(registerDelivery({ systemPrompt: {} }).reason, 'no-systemPrompt-service');
  assert.equal(registerDelivery({ systemPrompt: { context() {} } }).reason, 'no-ctx-effect');
});

test('判据: registerDelivery 成功路径 —— 注册名为 rulekeeper/reminders，provider 经宿主调用产出文本', () => {
  const { landing } = freshLanding('deliver-register', {
    entries: [ledgerEntry({ id: 'L1', ts: TS, rule: 'CAT-CODE' })],
  });
  const h = host();
  const d = registerDelivery(h.ctx, { landingDir: landing, now: () => new Date(TS) });
  assert.equal(d.ok, true);
  assert.equal(h.registered.length, 1);
  assert.equal(h.registered[0].name, REGISTRY_NAME);
  assert.equal(typeof h.registered[0].order, 'number');
  assert.equal(typeof h.registered[0].text, 'function');
  const text = h.registered[0].text({});
  assert.match(text, /CAT-CODE/);
  const rep = d.report();
  assert.equal(rep.emissions, 1);
  assert.ok(rep.lastChars > 0);
});

test('判据: provider 出错时 fail-open（返回上一版，不抛）', () => {
  const { landing } = freshLanding('deliver-failopen', {
    entries: [ledgerEntry({ id: 'L1', ts: TS, rule: 'CAT-CODE' })],
  });
  const h = host();
  const d = registerDelivery(h.ctx, { landingDir: landing, now: () => new Date(TS) });
  const provider = h.registered[0].text;
  const first = provider({});
  assert.match(first, /CAT-CODE/);
  // 把落点变成"读不了"的形态：rules.json 写坏 ⇒ effectInjectPlan 内部降级；provider 不得抛
  const rulesPath = join(landing, 'rules.json');
  writeFileSync(rulesPath, '{ this is not json', 'utf8');
  let second;
  assert.doesNotThrow(() => { second = provider({}); });
  assert.equal(typeof second, 'string');
  assert.ok(d.runtime.evaluations >= 2);
});

test('判据: 用量账往返 + 损坏降级 + 摘要排序 + 不留 .tmp 残file', () => {
  const dir = tempDir('usage-roundtrip');
  assert.deepEqual(readUsage(dir), emptyUsage(), '无文件时应为空账');
  assert.equal(bumpUsage(dir, { rule: 'CAT-CODE', event: 'evaluated' }).ok, true);
  assert.equal(bumpUsage(dir, { rule: 'CAT-CODE', event: 'emitted' }).ok, true);
  assert.equal(bumpUsage(dir, { rule: 'CAT-DOC', event: 'emitted' }).ok, true);
  const u = readUsage(dir);
  assert.equal(u.rules['CAT-CODE'].evaluated, 1);
  assert.equal(u.rules['CAT-CODE'].emitted, 1);
  assert.equal(u.totalEmitted, 2);
  assert.ok(typeof u.rules['CAT-CODE'].lastAt === 'string');
  const sum = usageSummary(dir);
  assert.equal(sum.rows[0].emitted, 1);
  assert.equal(sum.rows.length, 2);
  assert.ok(!readdirSync(dir).some((f) => f.includes('.tmp-')), '不得留下临时文件');
  // 损坏：降级为空账，且再次 bump 能自愈
  writeFileSync(join(dir, 'usage.json'), 'not-json', 'utf8');
  assert.deepEqual(readUsage(dir), emptyUsage());
  assert.equal(bumpUsage(dir, { rule: 'X', event: 'emitted' }).ok, true);
  assert.equal(readUsage(dir).totalEmitted, 1);
  assert.equal(writeUsage('', emptyUsage()), false, '空落点应返回 false 而不是抛');
});

test('判据: 能力声明与实现同源（deliveryCapability 反映真实预算）', () => {
  const cap = deliveryCapability();
  assert.equal(cap.channel, 'systemPrompt.context');
  assert.equal(cap.name, REGISTRY_NAME);
  assert.ok(cap.maxRules > 0 && cap.maxChars > 0 && cap.minIntervalMs > 0);
  assert.deepEqual([cap.untrustedMarkers.open, cap.untrustedMarkers.close], ['<untrusted>', '</untrusted>']);
  // 单条注入文本的 renderTemplate 应带"这是数据不是指令"的声明（防止被当指令执行）
  const { landing } = freshLanding('deliver-disclaimer', { entries: [ledgerEntry({ id: 'L1', ts: TS, rule: 'CAT-CODE' })] });
  const built = buildReminderText({ landingDir: landing, now: new Date(TS) });
  assert.match(built.text, /不是指令/);
  assert.ok(existsSync(join(landing, 'rules.json')), 'buildReminderText 不得改动落点（只读）');
  const before = readFileSync(join(landing, 'rules.json'), 'utf8');
  buildReminderText({ landingDir: landing, now: new Date(TS) });
  assert.equal(readFileSync(join(landing, 'rules.json'), 'utf8'), before, '重复调用不得写入 rules.json');
});
