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
import { bumpUsage, emptyUsage, readEmission, readUsage, usageSummary, writeEmission, writeUsage, ROOT_EMISSION_KEY } from '../src/usage.mjs';
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

test('判据（并集 + 轮转，F-2 修复）: `landingDirs` 两侧都念到，且项目撑满预算也挤不掉用户级', () => {
  const { landing: proj } = freshLanding('deliver-union-proj', {
    entries: [
      ledgerEntry({ id: 'P1', ts: TS, rule: 'CAT-AAA' }),
      ledgerEntry({ id: 'P2', ts: TS, rule: 'CAT-BBB' }),
      ledgerEntry({ id: 'P3', ts: TS, rule: 'CAT-CCC' }),
    ],
  });
  const { landing: user } = freshLanding('deliver-union-user', {
    entries: [ledgerEntry({ id: 'U1', ts: TS, rule: 'JUDGEMENT-XXX' })],
  });
  const built = buildReminderText({ landingDirs: [proj, user], now: new Date(TS), maxRules: 3 });
  assert.deepEqual(built.rules, ['CAT-AAA', 'JUDGEMENT-XXX', 'CAT-BBB'],
    `按**轮转**取（项目-first，不许多取）：实得 ${JSON.stringify(built.rules)}`);
  assert.deepEqual(built.landings, [proj, user], '两个落点都真正出了力');
  assert.deepEqual(built.attribution.map((a) => a.rules), [['CAT-AAA', 'CAT-BBB'], ['JUDGEMENT-XXX']]);
  // 同名纪律只念一次，且算**先出现的落点**（项目在前 ⇒ 用户级那条被去重掉，不重复念）
  const { landing: dupProj } = freshLanding('deliver-union-dup-p', { entries: [ledgerEntry({ id: 'D1', ts: TS, rule: 'CAT-SAME' })] });
  const { landing: dupUser } = freshLanding('deliver-union-dup-u', { entries: [ledgerEntry({ id: 'D2', ts: TS, rule: 'CAT-SAME' })] });
  const dup = buildReminderText({ landingDirs: [dupProj, dupUser], now: new Date(TS), maxRules: 3 });
  assert.equal((dup.text.match(/CAT-SAME/g) ?? []).length, 1, `同名纪律只该念一次；实得 ${JSON.stringify(dup.text)}`);
  assert.deepEqual(dup.landings, [dupProj], '去重后只有先出现的落点真正出力');
});

test('判据（单落点逐字不变）: 传 `landingDir` 与传 `landingDirs:[它]` 产出**逐字相同**（向后兼容）', () => {
  const { landing } = freshLanding('deliver-compat', {
    entries: [
      ledgerEntry({ id: 'A', ts: TS, rule: 'CAT-CODE' }),
      ledgerEntry({ id: 'B', ts: TS, rule: 'CAT-DOC' }),
    ],
  });
  const one = buildReminderText({ landingDir: landing, now: new Date(TS) });
  const list = buildReminderText({ landingDirs: [landing], now: new Date(TS) });
  assert.equal(list.text, one.text, '单落点必须逐字一致（否则"旧口径不变"这句话就是假的）');
  assert.deepEqual(list.rules, one.rules);
  assert.equal(list.chars, one.chars);
  // 空集 / 全空字符串 ⇒ 如实 no-landing（不投、不猜）
  assert.equal(buildReminderText({ landingDirs: [], now: new Date(TS) }).reason, 'no-landing');
  assert.equal(buildReminderText({ landingDirs: ['', '  '], now: new Date(TS) }).reason, 'no-landing');
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

test('判据（白名单吃掉字段的回归）: 按会话的投递状态必须能往返（跨重启去重靠它）', () => {
  const dir = tempDir('usage-emission');
  assert.equal(readEmission(dir, 'sess-1'), null, '空账 ⇒ null');
  assert.equal(writeEmission(dir, 'sess-1', { sha: 'a'.repeat(32), at: '2026-09-20T00:00:00.000Z' }), true);
  assert.deepEqual(readEmission(dir, 'sess-1'), { sha: 'a'.repeat(32), at: '2026-09-20T00:00:00.000Z' },
    '写进去又读不回来 = 字段被 normalize 的白名单吃掉了（本仓已犯过三次的错）');
  // **按会话分开**：会话 2 不受会话 1 的状态影响
  assert.equal(readEmission(dir, 'sess-2'), null, '别的会话不该看到 sess-1 的状态');
  writeEmission(dir, 'sess-2', { sha: 'b'.repeat(32) });
  assert.equal(readEmission(dir, 'sess-1').sha, 'a'.repeat(32), '写 sess-2 不能覆盖 sess-1');
  // 与用量计数共存：互相不能覆盖
  bumpUsage(dir, { rule: 'CAT-CODE', event: 'emitted' });
  assert.equal(readUsage(dir).totalEmitted, 1);
  assert.equal(readEmission(dir, 'sess-1').sha, 'a'.repeat(32), 'bump 之后状态仍要在');
  // 非法输入 ⇒ 当作没有 / 返回 false（不放半截数据进去）
  assert.equal(writeEmission(dir, 'sess-3', { sha: '' }), false);
  assert.equal(writeEmission('', 'sess-3', { sha: 'x' }), false);
  assert.equal(writeEmission(dir, '', { sha: 'x' }), false);
  assert.equal(readEmission(dir, ''), null);
});

test('判据（2026-09-21 修上限）: 去重状态表不再 20 键封顶；`(root)` 键不参与淘汰；陈旧条目按保鲜期清掉', () => {
  const dir = tempDir('usage-emissions-cap');
  // 25 个会话（旧实现会在第 21 个起淘汰最早的 ⇒ 那些会话回来时会重复收到提醒）
  for (let i = 0; i < 25; i += 1) {
    writeEmission(dir, `session-${String(i).padStart(2, '0')}`, { sha: 'c'.repeat(32), at: `2026-09-20T00:00:${String(i).padStart(2, '0')}.000Z` });
  }
  writeEmission(dir, ROOT_EMISSION_KEY, { sha: 'd'.repeat(32), at: '2026-09-20T00:00:00.000Z' });
  const keys = Object.keys(readUsage(dir).emissions);
  assert.equal(keys.length, 26, `25 个会话 + (root) 都该在（旧实现只剩 20；实得 ${keys.length}）`);
  assert.ok(keys.includes('session-00'), '最早的会话也必须还在（20 键上限正是被它踩到的）');
  assert.ok(keys.includes(ROOT_EMISSION_KEY), '(root) 键必须常驻');
  // 保鲜期：把一条改成 40 天前 ⇒ 下一次写入时被清掉；但 (root) 即使很旧也不清
  writeEmission(dir, 'session-old', { sha: 'e'.repeat(32), at: '2026-01-01T00:00:00.000Z' });
  writeEmission(dir, ROOT_EMISSION_KEY, { sha: 'd'.repeat(32), at: '2026-01-01T00:00:00.000Z' });
  writeEmission(dir, 'session-new', { sha: 'f'.repeat(32), at: new Date().toISOString() });
  const after = Object.keys(readUsage(dir).emissions);
  assert.ok(!after.includes('session-old'), '超过保鲜期的会话条目应被清掉（表只在真正的大主机上才触顶）');
  assert.ok(after.includes(ROOT_EMISSION_KEY), '(root) 是根通道的跨通道去重状态，不按会话保鲜期清理');
});

test('判据（2026-09-21 计数器语义）: 汇总要能把"投递动作数"与"投过几个会话"分开报，并单独给出根通道最近一次投递', () => {
  const dir = tempDir('usage-sessions');
  bumpUsage(dir, { rule: 'CAT-CODE', event: 'evaluated' });
  bumpUsage(dir, { rule: 'CAT-CODE', event: 'emitted' });
  writeEmission(dir, 'session-a', { sha: 'a'.repeat(32), at: '2026-09-20T00:00:01.000Z' });
  writeEmission(dir, 'session-b', { sha: 'b'.repeat(32), at: '2026-09-20T00:00:02.000Z' });
  writeEmission(dir, ROOT_EMISSION_KEY, { sha: 'c'.repeat(32), at: '2026-09-20T00:00:03.000Z' });
  const sum = usageSummary(dir);
  assert.equal(sum.totalEmitted, 1, '动作数照旧');
  assert.equal(sum.sessions, 2, '会话数 = 真实会话（**不含** (root) 伪会话）');
  assert.equal(sum.rootEmission.sha, 'c'.repeat(32), '根通道最近一次投递的指纹要能单独读到');
  assert.equal(sum.sessionRows[0].key, ROOT_EMISSION_KEY, '按时间倒序：最近的是 (root)');
  assert.equal(sum.sessionRows.filter((s) => s.root === true).length, 1);
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

// ── 落点接线（2026-09-19 修缺口）：装载入口不传 landingDir 时，provider 必须仍能投递 ──
// 缺口本体：`index.js` 只传 `{dshRoot, handlers}` ⇒ 旧实现每轮 no-landing、静默不投递，
// 且落点里连 `usage.json` 都不会出现。下面两条把"接线前/接线后"钉成对照。

test('红→绿: 不传 landingDir 且无解析器 ⇒ 如实不投递（landingBound=false，且不写遥测）', () => {
  const { landing } = freshLanding('deliver-nolanding', {
    entries: [ledgerEntry({ id: 'L1', ts: TS, rule: 'CAT-CODE' })],
  });
  const h = host();
  const d = registerDelivery(h.ctx, { now: () => new Date(TS) });   // 既不传 landingDir，也不传 resolveLanding
  assert.equal(d.ok, true, '服务在 ⇒ 注册仍应成功（失败的是"有没有落点"，不是通道）');
  assert.equal(h.registered[0].text({}), '', '没有落点 ⇒ 必须产出空串（不猜路径）');
  const rep = d.report();
  assert.equal(rep.landingBound, false);
  assert.equal(rep.landingSource, 'none');
  assert.ok(d.runtime.reasons.includes('no-landing'), `原因要如实记下来（实得 ${JSON.stringify(d.runtime.reasons)}）`);
  assert.equal(existsSync(join(landing, 'usage.json')), false, '没投递就不该写遥测（别造假命中）');
});

test('绿: 传 resolveLanding ⇒ provider 真投递，并把**实际投递到的每一条**记进 usage.json', () => {
  const { landing } = freshLanding('deliver-resolver', {
    entries: [
      ledgerEntry({ id: 'A', ts: TS, rule: 'CAT-CODE' }),
      ledgerEntry({ id: 'B', ts: TS, rule: 'CAT-DOC' }),
      ledgerEntry({ id: 'C', ts: TS, rule: 'CAT-ENV' }),
    ],
  });
  const h = host();
  const d = registerDelivery(h.ctx, {
    resolveLanding: () => ({ dir: landing, source: 'project' }),
    now: () => new Date(TS),
  });
  const text = h.registered[0].text({});
  assert.ok(text.length > 0, '有落点 + 有话可说 ⇒ 必须产出文本');
  assert.match(text, /CAT-CODE/);
  const rep = d.report();
  assert.equal(rep.landingBound, true);
  assert.equal(rep.landingSource, 'project');
  assert.equal(rep.landingDir, landing);
  // 遥测：一次投递里 3 条都该记（E3 抓出的"只记 rules[0]"缺陷的回归判据）
  const usage = readUsage(landing);
  assert.equal(usage.totalEmitted, 3, `单次投递应记满 3 条（实得 ${usage.totalEmitted}）`);
  assert.ok(usage.rules['CAT-ENV'].emitted >= 1, '最后一条也要记（旧实现只记 rules[0]）');
  // 第二次求值：文本不变 ⇒ unchanged，不得重复计入 emitted
  h.registered[0].text({});
  assert.equal(readUsage(landing).totalEmitted, 3, '同文重放不得重复计数');
});
