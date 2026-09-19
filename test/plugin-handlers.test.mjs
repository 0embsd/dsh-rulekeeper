// dsh-rulekeeper · **装上即用**（2026-09-16 老板当场指出的缺陷：插件装上了不能用）
//
// 背景：此前 `index.js` 装载时**不注入 handlers** ⇒ 工具调用只回
//   `{ok:false, configured:false, reason:'本工具未注入 handler（默认零副作用）'}`——
//   用户装完什么都不能做。本文件把"默认装载必须真的干活"钉死，覆盖三条能力 + 两条边界：
//   · 判定（只读 allow/deny，红绿两态由**同一条路径**产出）· 记账（真追加台账行，缺字段如实拒绝）
//   · 快照（真留 pre-image + 索引登记）· `mode=off` 零副作用（LF-800）· 不注入 handlers 时仍是空壳（对照）
//
// fixture 纪律沿用 gate-write.test.mjs：一切只碰临时目录。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { defaultHandlers } from '../src/handlers.mjs';
import { sha256OfFile } from '../src/gate.mjs';
import { PLUGIN_EVENTS, PLUGIN_TOOLS, toolDefinition } from '../src/plugin.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

/** 造"项目 + 落点"（受保护路径可配） */
function fixture(label, { protectedPaths = ['AGENTS.md'], mode = 'observe' } = {}) {
  const root = tempDir(label);
  const projectRoot = join(root, 'proj');
  const landingDir = join(projectRoot, '.dsh-ai', 'rulekeeper');
  mkdirSync(landingDir, { recursive: true });
  writeFileSync(join(projectRoot, 'AGENTS.md'), 'v1\n', 'utf8');
  writeFileSync(join(projectRoot, 'src.txt'), 'x\n', 'utf8');
  writeFileSync(join(landingDir, 'config.json'), `${JSON.stringify({ schema: 1, mode }, null, 2)}\n`, 'utf8');
  writeFileSync(join(landingDir, 'rules.json'), `${JSON.stringify({ schema: 1, project: 't', protected_paths: protectedPaths, gates: [], checks: [], inject: [] }, null, 2)}\n`, 'utf8');
  return { root, projectRoot, landingDir };
}

/** 落点内文件树的相对路径快照（用来证明"gate 是只读的"） */
function treeOf(dir) {
  const out = [];
  const walk = (d, prefix) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const rel = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.isDirectory()) walk(join(d, e.name), rel);
      else out.push(rel);
    }
  };
  walk(dir, '');
  return out.sort();
}

test('装上即用: 三个工具在默认 handlers 下都 configured:true（不注入 handlers = 空壳，作对照）', async () => {
  const f = fixture('ph-wired');
  const wired = defaultHandlers({ cwd: f.projectRoot });
  for (const t of PLUGIN_TOOLS) {
    const good = await toolDefinition(t, wired).execute({ project: f.projectRoot, path: 'src.txt' });
    assert.equal(good.configured, true, `${t.name} 默认装载后必须真的干活（不许是"未注入 handler"的空壳）`);
    const bare = await toolDefinition(t, {}).execute({ project: f.projectRoot, path: 'src.txt' });
    assert.equal(bare.configured, false, `对照组：显式不注入 handlers 时才是空壳 —— 证明本用例抓得到退化`);
  }
});

test('gate 真判定: 改过没留证 -> deny；留证后 -> allow；再改 -> 又 deny（红绿同路径产出）', () => {
  const f = fixture('ph-gate');
  const h = defaultHandlers({ cwd: f.projectRoot });
  const red1 = h.rulekeeper_gate({ project: f.projectRoot, path: 'AGENTS.md' });
  assert.equal(red1.decision, 'deny', JSON.stringify(red1));
  assert.match(red1.reason, /GATE_WRITE_NO_SNAPSHOT/);
  assert.equal(h.rulekeeper_snap({ project: f.projectRoot, path: 'AGENTS.md' }).ok, true);
  const green = h.rulekeeper_gate({ project: f.projectRoot, path: 'AGENTS.md' });
  assert.equal(green.decision, 'allow', JSON.stringify(green));
  writeFileSync(join(f.projectRoot, 'AGENTS.md'), 'v2\n', 'utf8');
  const red2 = h.rulekeeper_gate({ project: f.projectRoot, path: 'AGENTS.md' });
  assert.equal(red2.decision, 'deny', JSON.stringify(red2));
  assert.match(red2.reason, /GATE_WRITE_UNRECORDED_CHANGE/);
  // 不在保护面内的路径不得误报
  assert.equal(h.rulekeeper_gate({ project: f.projectRoot, path: 'src.txt' }).decision, 'allow');
});

test('gate 是只读的: 判定不新增/修改落点内任何文件', () => {
  const f = fixture('ph-gate-ro');
  const h = defaultHandlers({ cwd: f.projectRoot });
  h.rulekeeper_snap({ project: f.projectRoot, path: 'AGENTS.md' });
  const before = treeOf(f.landingDir);
  h.rulekeeper_gate({ project: f.projectRoot, path: 'AGENTS.md' });
  h.rulekeeper_gate({ project: f.projectRoot, path: 'AGENTS.md', phase: 'open' });
  assert.deepEqual(treeOf(f.landingDir), before, 'gate 不得写任何东西（只读判定）');
});

test('record 真记账: 追加一行合法台账；缺字段时如实拒绝、不写占位文本', () => {
  const f = fixture('ph-record');
  const h = defaultHandlers({ cwd: f.projectRoot });
  const ok = h.rulekeeper_record({
    project: f.projectRoot, rule: 'RK-PLUGIN', problem: '演示记账', rootCause: 'r', solution: 's', evidence: ['a.txt'],
  });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.match(ok.id, /^LF-/);
  const ledgerFile = join(f.landingDir, 'ledger.jsonl');
  const rows = readFileSync(ledgerFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rule, 'RK-PLUGIN');
  assert.equal(rows[0].category, '纪律', '类别缺省由 handler 填（账本契约必填）');
  assert.match(rows[0].mechanism, /rulekeeper_record/);
  assert.deepEqual(rows[0].evidence, ['a.txt']);

  const bad = h.rulekeeper_record({ project: f.projectRoot, rule: 'RK-PLUGIN', problem: 'p' });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /root_cause|solution/);
  assert.equal(readFileSync(ledgerFile, 'utf8').trim().split('\n').length, 1, '拒绝时不得写行');
});

test('snap 真留证: 写备份 + 索引登记（含 sha256_before），路径出项目根/不存在文件时如实报错', () => {
  const f = fixture('ph-snap');
  const h = defaultHandlers({ cwd: f.projectRoot });
  const ok = h.rulekeeper_snap({ project: f.projectRoot, path: 'AGENTS.md', why: '用例' });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.match(String(ok.sha256), /^[0-9a-f]{64}$/);
  assert.equal(existsSync(join(f.landingDir, 'snapshots', 'index.jsonl')), true);
  const rows = readFileSync(join(f.landingDir, 'snapshots', 'index.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  // 索引里的 path 是 `pathKey()` 归一形态（大小写折叠，跨平台稳定键）——不是原样路径，属既有口径
  assert.equal(rows[0].path, 'agents.md');
  const missing = h.rulekeeper_snap({ project: f.projectRoot, path: 'nope.txt' });
  assert.equal(missing.ok, false);
  assert.equal(missing.skipped, false);
});

test('相对路径必须按**项目根**解析: cwd 里有同名文件时也不得抓错（2026-09-16 实测缺陷）', () => {
  const f = fixture('ph-snap-rel');
  const h = defaultHandlers({ cwd: f.projectRoot });
  const out = h.rulekeeper_snap({ project: f.projectRoot, path: 'AGENTS.md', why: '相对路径解析用例' });
  assert.equal(out.ok, true, JSON.stringify(out));
  const rows = readFileSync(join(f.landingDir, 'snapshots', 'index.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows[0].sha256_before, sha256OfFile(join(f.projectRoot, 'AGENTS.md')), '必须拍项目根下那个文件');
  // 诱饵：测试进程的 cwd（= 包根）里也存在同名 AGENTS.md —— 修复前会抓到它
  const decoy = join(process.cwd(), 'AGENTS.md');
  if (existsSync(decoy)) {
    assert.notEqual(rows[0].sha256_before, sha256OfFile(decoy), '不得拍到 cwd 里的同名文件（本仓的 167KB AGENTS.md）');
  }
});

test('off 档零副作用（LF-800）: record/snap 都不落盘，且如实说明原因', () => {
  const f = fixture('ph-off', { mode: 'off' });
  const h = defaultHandlers({ cwd: f.projectRoot });
  const r = h.rulekeeper_record({ project: f.projectRoot, rule: 'RK-PLUGIN', problem: 'p', rootCause: 'r', solution: 's' });
  assert.equal(r.skipped, true);
  assert.match(r.reason, /mode=off/);
  assert.equal(existsSync(join(f.landingDir, 'ledger.jsonl')), false, 'off 档不得建台账文件');
  const s = h.rulekeeper_snap({ project: f.projectRoot, path: 'AGENTS.md' });
  assert.equal(s.skipped, true);
  assert.equal(existsSync(join(f.landingDir, 'snapshots')), false, 'off 档不得建快照目录');
});

test('集成: index.js 默认装载就注入 handlers（apply 注册出来的工具能真判定）', async () => {
  const root = tempDir('ph-boot');
  const dshRoot = join(root, '.dsh');
  mkdirSync(join(dshRoot, 'lib'), { recursive: true });
  // 宿主事件表的近似来源：宿主代码里出现的**事件名字面量**（boot 自检据此判定）。
  // 2026-09-19 改：**从 PLUGIN_EVENTS 派生**——此前硬编码三个 tools/*，PLUGIN_EVENTS 新增
  // `agent/pre-step` 后 boot 自检在夹具里误红（生产宿主确有该事件）。派生后不会再漂移。
  writeFileSync(join(dshRoot, 'lib', 'host.js'), `${[...PLUGIN_EVENTS].map((e) => `ctx.on('${e}');`).join(' ')}\n`, 'utf8');
  const f = fixture('ph-boot-proj');
  const registered = [];
  const ctx = { effect: (fn) => fn(), tools: { register: (d) => { registered.push(d); } }, on: () => {} };
  const savedHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dshRoot;
  try {
    const mod = await import('../index.js');
    mod.default.apply(ctx);
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedHome;
  }
  assert.equal(registered.length, 4, 'apply 应注册四个工具（gate/record/snap/effect）');
  const gateDef = registered.find((d) => d.name === 'rulekeeper_gate');
  const out = await gateDef.execute({ project: f.projectRoot, path: 'AGENTS.md' });
  assert.equal(out.configured, true, '默认装载后必须 configured:true（否则等于没装）');
  assert.equal(out.decision, 'deny', JSON.stringify(out));
});
