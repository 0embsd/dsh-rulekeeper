// dsh-rulekeeper · LF-400 **插件骨架 + boot 自检 + 命名空间**用例
//
// 判据：绿 = boot 自检全过 + 工具名带前缀 + 真实注册路径可用；红 = ①订阅的事件名宿主里没有（**静默不生效**）
//   ②工具名缺前缀 ③宿主 ctx 契约不符（缺 effect / tools.register）。全部用 fixture，不依赖本机装没装 DSH。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { apply, bootSelfCheck, eventTableFromHost, lastApplyReport, PLUGIN_EVENTS, PLUGIN_TOOLS, TOOL_PREFIX } from '../src/plugin.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

/** 迷你宿主安装面：把事件名写成 `'tools/xxx'` 字面量 */
// 默认事件表**从 PLUGIN_EVENTS 派生**（2026-09-19 改）：此前硬编码三个 tools/*，
// 导致 PLUGIN_EVENTS 新增 `agent/pre-step` 后 boot 自检在夹具里误红（生产宿主是有的）。
// 单一口径 ⇒ 以后 PLUGIN_EVENTS 变了，夹具自动跟上；需要"故意缺事件"的用例仍可显式传 events。
function fixtureHost(label, { events = [...PLUGIN_EVENTS] } = {}) {
  const root = tempDir(label);
  mkdirSync(join(root, 'lib'), { recursive: true });
  const js = ['// 迷你宿主', ...events.map((e) => `ctx.on('${e}', () => {})`), "ctx.on('other/event', () => {})"].join('\n');
  writeFileSync(join(root, 'lib', 'host.js'), `${js}\n`, 'utf8');
  return root;
}
const fakeCtx = () => {
  const registered = [];
  const effects = [];
  return {
    registered,
    effects,
    effect: (fn) => { effects.push(fn); },
    // 宿主契约：`register(单个 definition)`（2026-09-15 真装载实测：两参写法 → 插件树装载失败）
    tools: { register: (definition) => { registered.push(definition); } },
  };
};

test('判据: 事件表从宿主安装面抽取（含 tools/* 之外的事件被忽略）', () => {
  const root = fixtureHost('plugin-table');
  const { table, scanned } = eventTableFromHost(root);
  assert.equal(table.has('tools/pre-execute'), true);
  assert.equal(table.has('other/event'), false);
  assert.ok(scanned >= 1);
});

test('绿: boot 自检全过（订阅事件都在 + 工具名带前缀）', () => {
  const root = fixtureHost('plugin-ok');
  const r = bootSelfCheck({ dshRoot: root });
  assert.equal(r.ok, true, JSON.stringify(r.cases));
  assert.equal(r.cases.length, 3);
});

test('红: **订阅的事件名宿主里没有** -> boot 必红（防"静默不生效"）', () => {
  const root = fixtureHost('plugin-bad-event', { events: ['tools/pre-execute', 'tools/post-execute'] }); // 少 tools/result
  const r = bootSelfCheck({ dshRoot: root });
  assert.equal(r.ok, false);
  const c = r.cases.find((x) => x.name.includes('订阅的事件名'));
  assert.equal(c.ok, false);
  assert.match(c.detail, /tools\/result/);
  assert.match(c.detail, /静默不生效/);
});

test('红: 工具名缺命名空间前缀 -> boot 必红', () => {
  const root = fixtureHost('plugin-bad-name');
  const r = bootSelfCheck({ dshRoot: root, tools: [{ name: 'gate' }] });
  assert.equal(r.ok, false);
  assert.equal(r.cases.find((x) => x.name.includes('命名空间')).ok, false);
});

test('红: 宿主 ctx 缺 effect / tools.register -> 装配 fail-fast 抛错（不静默装一半）', () => {
  const root = fixtureHost('plugin-ctx');
  assert.throws(() => apply({ tools: { register: () => {} } }, { dshRoot: root }), /effect\(\)/);
  assert.throws(() => apply({ effect: () => {}, tools: {} }, { dshRoot: root }), /tools\.register\(\)/);
  assert.throws(() => apply(null, { dshRoot: root }), /ctx 非法/);
});

test('红: boot 未过时 apply 拒绝注册（防"静默不生效"）', () => {
  const root = fixtureHost('plugin-refuse', { events: ['tools/other'] });
  const ctx = fakeCtx();
  assert.throws(() => apply(ctx, { dshRoot: root }), /boot 自检未通过/);
  assert.equal(ctx.effects.length, 0, 'boot 没过就一个 effect 都不许注册');
});

test('绿: apply 真实注册路径 —— 注册定义满足宿主契约且与 PLUGIN_TOOLS 一致（不外套 ctx.effect）', () => {
  const root = fixtureHost('plugin-apply');
  const ctx = fakeCtx();
  const ret = apply(ctx, { dshRoot: root });
  assert.equal(ret, undefined, 'apply 必须返回 undefined（cordis effect 规则）');
  assert.equal(lastApplyReport.ok, true);
  // 宿主 `tools.register` 内部**自带** effect 注册（dsh-tools/lib/index.js:2781）⇒ 我们不再外套 `ctx.effect`；
  // 外套一层会让 cordis 见到 effect 句柄 → `TypeError: Invalid effect`（2026-09-15 真装载实测）
  assert.equal(ctx.effects.length, 0, '不得再外套 ctx.effect（宿主 register 内部已注册 effect）');
  assert.deepEqual(ctx.registered.map((d) => d.name), PLUGIN_TOOLS.map((t) => t.name));
  for (const d of ctx.registered) {
    assert.ok(d.name.startsWith(TOOL_PREFIX), `${d.name} 必须带前缀`);
    // 宿主 register() 的硬要求（缺一项宿主就抛 "must declare output { schema, render, presentationMeta? }"）
    assert.equal(typeof d.parameters, 'object', `${d.name} 缺 parameters`);
    assert.equal(typeof d.output, 'object', `${d.name} 缺 output`);
    assert.equal(typeof d.output.render, 'function', `${d.name}.output.render 必须是函数`);
    assert.equal(typeof d.output.schema, 'object', `${d.name}.output.schema 必须是对象`);
    assert.equal(typeof d.execute, 'function', `${d.name} 缺 execute`);
  }
});

test('判据: 订阅事件与注册工具都指向同一批事件名（不许各写一套）', () => {
  const used = new Set(PLUGIN_TOOLS.map((t) => t.event));
  for (const e of used) assert.ok(PLUGIN_EVENTS.includes(e), `${e} 必须在 PLUGIN_EVENTS 里`);
});


test('绿: apply 订阅全部 PLUGIN_EVENTS（每个订阅都过 safeListener 包装）', () => {
  const root = fixtureHost('plugin-subscribe');
  const on = [];
  const registered = [];
  const ctx = { effect: () => {}, on: (ev, fn) => on.push({ ev, fn }), tools: { register: (d) => registered.push(d) } };
  const ret = apply(ctx, { dshRoot: root });
  assert.equal(ret, undefined);
  assert.deepEqual(on.map((x) => x.ev), [...PLUGIN_EVENTS], '订阅的事件必须与 PLUGIN_EVENTS 一致');
  for (const x of on) assert.equal(typeof x.fn, 'function');
});

test('红态→绿（LF-450 fail-open）: 注入 listener 抛错后订阅回调不抛、落诊断、且**透传上游决策**', async () => {
  const root = fixtureHost('plugin-fault');
  const on = [];
  const ctx = { effect: () => {}, on: (ev, fn) => on.push({ ev, fn }), tools: { register: () => {} } };
  apply(ctx, { dshRoot: root, faultInjection: 'throw-listener' });
  assert.equal(on.length, PLUGIN_EVENTS.length);
  for (const x of on) {
    // 不抛 = fail-open 的第一要件；**透传上游** = 第二要件：返回 undefined 会抹掉上游决策，
    // 宿主随后读 result.kind 直接抛错 ⇒ 工具层坏掉（LF-450 实测：第三方留痕 1 → 0）
    const upstream = { kind: 'accept' };
    const r = await x.fn({ exec: { name: 'pwsh', args: {} } }, async () => upstream);
    assert.equal(r, upstream, `${x.ev} 的 listener 抛错后必须**透传上游决策**`);
  }
  assert.equal(lastApplyReport.errorSink.records.length, PLUGIN_EVENTS.length);
  for (const rec of lastApplyReport.errorSink.records) assert.equal(rec.gate, 'listener-error');
});

// ── 2026-09-16（独立成仓当天实测暴露的三处"证据面"缺陷；每条都用变异证明判据不再骗人）──
//
// 事故背景：把包从 `<DSH_HOME>/…` 之下搬到独立目录后，**原本"绿"的 boot 自检突然变红** ——
//   根因不是宿主变了，而是旧实现有三处缺陷：① 扫描**没排除自身**（它命中的其实是"我们自己的字面量"）
//   ② **跳过符号链接**（插件生态大量用 link/软链 ⇒ 宿主真实代码整片没被扫到）
//   ③ 只认**单引号**（宿主里可能是双引号/反引号）
//   ⇒ 结论：这种"看似在验证宿主、实则可能自证"的判据必须逐条钉住，否则它会长期骗过所有人。

test('红（自证缺陷）: 扫描面里"我们自己的包"不得被算作宿主证据（exclude 必须生效）', () => {
  const root = tempDir('plugin-selfmatch');           // 空宿主：本来一个事件都没有
  const own = join(root, 'our-own-package');          // 假装"包被 link 到 DSH_HOME 之下"
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, 'plugin.mjs'), "const E = ['tools/pre-execute', 'tools/post-execute', 'tools/result'];\n", 'utf8');

  const withoutExclude = eventTableFromHost(root);
  assert.equal(withoutExclude.table.has('tools/pre-execute'), true, '前提：不排除时确实会"自证"（表里有我们自己的字面量）');

  const withExclude = eventTableFromHost(root, { exclude: [own] });
  assert.equal(withExclude.table.size, 0, '排除自身后，宿主表必须为空（我们的字面量不算宿主证据）');

  const r = bootSelfCheck({ dshRoot: root, exclude: [own] });
  assert.equal(r.inconclusive, true, '表空 ⇒ 不可判定，禁止据此判红（否则真实机器上会假红）');
  assert.equal(r.ok, true, '不可判定时不 fail-fast（注册继续，但如实标注）');
});

test('绿（引号形态）: 双引号 / 反引号写出的事件名同样要被认到', () => {
  const root = tempDir('plugin-quotes');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'host.js'), `${[...PLUGIN_EVENTS].map((e, i) => `const q${i} = ${['"', '`', "'"][i % 3]}${e}${['"', '`', "'"][i % 3]};`).join(' ')}\n`, 'utf8');
  const { table } = eventTableFromHost(root);
  for (const e of PLUGIN_EVENTS) assert.equal(table.has(e), true, `${e} 必须被认到（引号形态不该影响判据）`);
});

test('绿（软链）: 跟随符号链接（插件的 link/软链安装形态）', (t) => {
  const base = tempDir('plugin-symlink');
  const realDir = join(base, 'real-host');
  const linkDir = join(base, 'linked');
  mkdirSync(realDir, { recursive: true });
  writeFileSync(join(realDir, 'host.js'), "const e = 'tools/pre-execute';\n", 'utf8');
  try {
    symlinkSync(realDir, linkDir, 'junction');
  } catch (err) {
    t.skip(`本机不允许建软链（${err?.code ?? err?.message}）⇒ 跳过（Windows 需开发者模式/管理员）`);
    return;
  }
  const { table } = eventTableFromHost(base);
  assert.equal(table.has('tools/pre-execute'), true, '软链后面的宿主代码必须被扫到（否则真实机器上会假红）');
});

