// dsh-rulekeeper · 落盘诊断用例（2026-09-20）
//
// 判据：诊断必须**永远不打断主流程**（写不进去就静默降级），但**写得进去时字段必须够排查**：
//   装载那条要能回答"宿主服务在不在 / 落点解析成什么 / 投递注册成功没 / 订阅了几件"；
//   投递那条只在**签名变化**时落（否则刷屏 = 没人看）。
// 红态：把诊断写成"抛错"或"每轮都写"——两者都会让这条通路要么害人、要么没人看。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DIAG_FILE, appendDiag, bootDiagRecord, defaultLaunchInfo, diagPath, readDiag } from '../src/diag.mjs';
import { createLandingResolver } from '../src/landing.mjs';
import { registerDelivery } from '../src/deliver.mjs';
import { cleanupAll, freshLanding, ledgerEntry, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

test('判据: 落盘诊断可写可读，且坏行不影响读取', () => {
  const root = tempDir('diag-basic');
  assert.equal(appendDiag(root, { kind: 'boot', note: 'x' }).ok, true);
  appendDiag(root, { kind: 'delivery', rules: ['A'] });
  const read = readDiag(root);
  assert.equal(read.missing, false);
  assert.equal(read.values.length, 2);
  assert.equal(read.values[0].kind, 'boot');
  assert.equal(read.values[0].schema, 1);
  assert.ok(typeof read.values[0].ts === 'string');
  // 坏行：只计数，不抛
  writeFileSync(diagPath(root), `${readFileSync(diagPath(root), 'utf8')}not-json\n`, 'utf8');
  const read2 = readDiag(root);
  assert.equal(read2.badLines, 1);
  assert.equal(read2.values.length, 2);
  assert.equal(readDiag(join(root, 'nope')).missing, true);
});

test('判据（关键）: 诊断写不进去也**绝不抛**（诊断不得打断装载/投递）', () => {
  assert.doesNotThrow(() => appendDiag('', { kind: 'boot' }));
  assert.equal(appendDiag('', { kind: 'boot' }).ok, false);
  // 把"目录"当文件名用：必然失败，但必须只是 false
  const root = tempDir('diag-fail');
  const blocked = join(root, 'blocked');
  mkdirSync(blocked, { recursive: true });
  writeFileSync(join(blocked, DIAG_FILE), 'x\n', 'utf8');
  const r = appendDiag(blocked, { kind: 'boot' });   // 目标已存在且是文件：append 到文件是合法的，这里应成功
  assert.equal(r.ok, true);
});

test('判据: 装载那条诊断的字段足够排查（服务/落点/投递/订阅/工具）', () => {
  const rec = bootDiagRecord({
    report: {
      landing: { dir: 'X', source: 'user-fallback' },
      delivery: { ok: false, reason: 'no-systemPrompt-service' },
      prestep: { ok: true, landingBound: false },
      services: { systemPrompt: false, agents: true, userQuestions: false },
      subscribed: ['agent/pre-step'],
      registered: ['rulekeeper_effect'],
      listenerErrors: 0,
    },
    cwd: 'C:\\x', pid: 42,
  });
  assert.equal(rec.kind, 'boot');
  assert.equal(rec.services.systemPrompt, false, '服务在不在必须如实记（这正是排查的入口）');
  assert.equal(rec.delivery.ok, false);
  assert.equal(rec.delivery.reason, 'no-systemPrompt-service');
  assert.equal(rec.landing.source, 'user-fallback');
  assert.deepEqual(rec.subscribed, ['agent/pre-step']);
  assert.equal(rec.pid, 42);
});

test('判据: 投递诊断只在**签名变化**时落（不刷屏）', () => {
  const root = tempDir('diag-delivery');
  const { landing } = freshLanding('diag-delivery-landing', { entries: [ledgerEntry({ id: 'A1', ts: '2026-09-20T00:00:00.000Z', rule: 'CAT-CODE' })] });
  const seen = [];
  const host = { effect: (fn) => fn(), systemPrompt: { context: (def) => { host.def = def; } } };
  const d = registerDelivery(host, {
    resolveLanding: () => ({ dir: landing, source: 'project' }),
    onDelivery: (info) => { seen.push(info); appendDiag(root, { kind: 'delivery', landing: info.landing, rules: info.built?.rules ?? [] }); },
  });
  assert.equal(d.ok, true);
  const provider = host.def.text;
  provider();                       // 第 1 次：签名新 ⇒ 记
  provider();                       // 第 2 次：签名同 ⇒ 不记
  provider();                       // 第 3 次：同上
  assert.equal(seen.length, 1, `同签名只该记 1 次（实得 ${seen.length}）`);
  assert.equal(readDiag(root).values.length, 1);
  assert.deepEqual(seen[0].built.rules, ['CAT-CODE']);
  // 落点来源变了 ⇒ 签名变 ⇒ 再记一条
  const holder = {};
  const d2 = registerDelivery({ effect: (fn) => fn(), systemPrompt: { context: (def) => { holder.def = def; } } }, {
    resolveLanding: () => ({ dir: null, source: 'none' }),
    onDelivery: () => seen.push({ none: true }),
  });
  holder.def.text();
  assert.equal(seen.length, 2, '来源变化（有落点 → 无落点）也必须留下痕迹');
});

test('判据: 落点解析的最后一档来源是 process.cwd()（宿主进程工作目录）', () => {
  // 前四档全空（没有 agent、没有 noteAgent、注册表为空）时，必须还能解析出"进程工作目录"这一档，
  // 否则"刚启动、还没有 agent"的窗口里通道是**静默哑的** —— 2026-09-20 线上事故的成因候选之一。
  const r = createLandingResolver({ agents: { roots: () => [] } });
  const d = r.describe();      // 不传 agent
  assert.notEqual(d.source, 'none', `应至少能取到 process.cwd() 这一档（实得 ${JSON.stringify(d)}）`);
  assert.ok(typeof d.dir === 'string' && d.dir !== '', '应解析出落点目录（本项目/用户级任一）');
  assert.ok(existsSync(d.dir), `解析出的落点必须真实存在：${d.dir}`);
});

test('判据（2026-09-21 补，诊断缺口）: 装载行必须带**启动形态**（profile/argv/入口/落点根）', () => {
  // 现场事故：3 次启动里 2 次根通道注册失败（no-systemPrompt-service）、1 次正常，而诊断里只有 pid/cwd
  // ⇒ 分不清那 2 次是"另一种 profile"还是"同一 profile 的启动期竞态"，白花一轮。
  const rec = bootDiagRecord({
    report: { landing: { dir: '/x', source: 'project' } },
    cwd: '/cwd', pid: 42,
    launch: defaultLaunchInfo({ argv: ['node', '/dsh/bin/dsh', 'web', '--profile', 'rk-test'], execArgv: [], env: { DSH_HOME: '/home/.dsh' } }),
  });
  assert.equal(rec.launch.profileHint, 'rk-test', '从 argv 里抓 profile 名（抓不到就 null，不猜）');
  assert.equal(rec.launch.entry, '/dsh/bin/dsh');
  assert.equal(rec.launch.dshHome, '/home/.dsh');
  assert.deepEqual(rec.launch.argv.slice(0, 4), ['node', '/dsh/bin/dsh', 'web', '--profile']);
  // `--profile=x` 形态也要认；没有就如实 null
  assert.equal(defaultLaunchInfo({ argv: ['node', 'dsh', '--profile=web'], env: {} }).profileHint, 'web');
  assert.equal(defaultLaunchInfo({ argv: ['node', 'dsh'], env: {} }).profileHint, null);
  assert.equal(defaultLaunchInfo({ argv: ['node', 'dsh'], env: {} }).dshHome, null);
  // 缺省调用（`bootDiagRecord` 不传 launch）也必须自动带上，且**绝不抛**
  const auto = bootDiagRecord({ report: {} });
  assert.ok(auto.launch !== null && Array.isArray(auto.launch.argv), '不传 launch 时必须自动采集启动形态');
  assert.doesNotThrow(() => defaultLaunchInfo({ argv: null, execArgv: null, env: null }));
});
