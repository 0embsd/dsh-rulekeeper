// dsh-rulekeeper · P22 用例：`pre-push` 三件**可拆** —— `prePush.noCi`
//
// 现场（治理项目实测）：他们那次 `REFS_RESULT=pass` + `COMMITMSG_RESULT=pass`，但 `CI_RESULT=fail`
// （`CI_WORKFLOW_MISSING` + `CI_BIN_MISSING`，因为该仓没有服务端工作流）⇒ 整条 pre-push exit 1。
// 诉求：能只跑"引用名 + 未推正文"那两段（备用开关；他们已决定暂不接）。
//
// ⚠ 接入点的事实（决定了实现形态）：pre-push 的三段是由**生成的 hook 载荷**串起来的
// （`src/hooks.mjs` 的 `hookRunnerContent`），而载荷**不接受命令行参数**（git 调它时只给 refs stdin）
// ⇒ 开关只能放**落点配置**（`config.json` 的 `prePush.noCi`），由载荷自己读。
//
// 本文件的判据（成对，缺一不算）：
//   ① `prePush.noCi=true` ⇒ refs 段通过后**跳过** ci 段：exit 0、打印"跳过 + 声明型开关"的说明；
//   ② 不给该开关（或 `false`）⇒ **仍然**跑 ci 段（缺工作流 ⇒ 与改前同结论：非 0）；
//   ③ 开关只影响**第②段**：refs 段仍然跑（refs 有泄漏时照样拒 —— 不许"跳过 ci"顺手把 refs 也放过）；
//   ④ 落点 `config.json` 的 `prePush` 形状非法 ⇒ config 校验报错（不许静默当成 false）。
//
// 反向红：把载荷里的 `noCi` 分支删掉（退回修复前）⇒ ① 必红。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { hookRunnerContent } from '../src/hooks.mjs';
import { validateConfig } from '../src/config.mjs';
import { cleanupAll, PKG_ROOT, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

/** 造一个"假门禁"：每段在被调用时打一行，并按脚本里的期望码退出（用来观察**哪几段真的跑了**） */
function fakeGate() {
  const dir = tempDir('p22-gate');
  const file = join(dir, 'rk-gate-fake.mjs');
  writeFileSync(file, [
    "const sub = process.argv[2] ?? '';",
    "console.log('GATE_CALLED ' + sub);",
    // refs / commitmsg 段：干净（exit 0）；ci 段：模拟"没有服务端工作流"⇒ 非 0
    "if (sub === 'ci') { console.log('CI_WORKFLOW_MISSING'); process.exit(1); }",
    'process.exit(0);',
  ].join('\n') + '\n', 'utf8');
  return file;
}

/** 造一个仓库形状（含落点 config）+ 生成好的 pre-push 载荷 */
function prePushRepo({ label, config = null, refsText }) {
  const root = tempDir(label);
  const landing = join(root, '.dsh-ai', 'rulekeeper');
  mkdirSync(landing, { recursive: true });
  if (config !== null) writeFileSync(join(landing, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  const gateBin = fakeGate();
  const runner = join(root, 'runner.mjs');
  // P14：runner 内容**不再吃 gateBin**（生成物里不带本机路径）⇒ 假门禁从**运行时解析链**注入
  //   （第一优先 = `RK_GATE_BIN` 环境变量，见 `hookRunnerContent` 的 `resolveGate()`）
  writeFileSync(runner, hookRunnerContent(), 'utf8');
  const refsFile = join(root, 'refs.txt');
  writeFileSync(refsFile, refsText, 'utf8');
  return { root, runner, refsFile, gateBin };
}

/** 跑载荷（git 调 pre-push 的形态：`runner pre-push` + refs 从 stdin 来，cwd=仓库根） */
function runPrePush({ runner, refsFile, root, gateBin }) {
  const refs = readFileSync(refsFile, 'utf8');
  const r = spawnSync(process.execPath, [runner, 'pre-push'], {
    cwd: root, encoding: 'utf8', input: refs, env: { ...process.env, RK_GATE_BIN: gateBin },
  });
  return { rc: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const CLEAN_REFS = 'refs/heads/main 1111111111111111111111111111111111111111 refs/heads/main 2222222222222222222222222222222222222222\n';

test('P22①: `prePush.noCi=true` ⇒ 跳过 ci 段：exit 0 且**大声说明**', () => {
  const { root, runner, refsFile, gateBin } = prePushRepo({
    label: 'p22-noci-on',
    config: { schema: 1, mode: 'observe', repoKind: 'private', prePush: { noCi: true } },
    refsText: CLEAN_REFS,
  });
  const r = runPrePush({ runner, refsFile, root, gateBin });
  assert.equal(r.rc, 0, `应当放行；out=${r.out}`);
  assert.doesNotMatch(r.out, /GATE_CALLED ci/, 'ci 段不该被调用');
  assert.match(r.out, /跳过\*\*? CI 等价门禁|跳过 CI 等价门禁/, '必须说明跳过了哪一段');
  assert.match(r.out, /声明型开关/, '必须自曝它是声明型开关（规则 43）');
  assert.match(r.out, /GATE_CALLED refs/, 'refs 段必须照旧跑');
});

test('P22②: 不给开关 / `noCi=false` ⇒ **仍然**跑 ci 段（与改前同结论）', () => {
  for (const cfg of [
    { schema: 1, mode: 'observe', repoKind: 'private' },
    { schema: 1, mode: 'observe', repoKind: 'private', prePush: { noCi: false } },
  ]) {
    const { root, runner, refsFile, gateBin } = prePushRepo({ label: `p22-noci-off-${cfg.prePush === undefined ? 'absent' : 'false'}`, config: cfg, refsText: CLEAN_REFS });
    const r = runPrePush({ runner, refsFile, root, gateBin });
    assert.match(r.out, /GATE_CALLED ci/, `默认必须跑 ci 段；cfg=${JSON.stringify(cfg)} out=${r.out}`);
    assert.notEqual(r.rc, 0, '假门禁在 ci 段非 0 ⇒ 整条必须非 0（缺工作流时就是这种结论）');
  }
});

test('P22③: 开关只影响 ci 段 —— refs 段有泄漏时照样拒（不许顺手放过）', () => {
  const { root, runner, refsFile, gateBin } = prePushRepo({
    label: 'p22-refs-still-runs',
    config: { schema: 1, mode: 'observe', repoKind: 'private', prePush: { noCi: true } },
    refsText: CLEAN_REFS,
  });
  // 把假门禁改成"refs 段判红"，验证 noCi 不会把 refs 一起放过（P14：改**同一个被解析到的**入口）
  writeFileSync(gateBin, [
    "const sub = process.argv[2] ?? '';",
    "console.log('GATE_CALLED ' + sub);",
    "if (sub === 'refs') { console.log('REFS_LEAK'); process.exit(1); }",
    'process.exit(0);',
  ].join('\n') + '\n', 'utf8');
  const r = runPrePush({ runner, refsFile, root, gateBin });
  assert.notEqual(r.rc, 0, `refs 段判红必须仍拦住（noCi 只拆 ci 那一段）；out=${r.out}`);
  assert.match(r.out, /GATE_CALLED refs/);
  assert.doesNotMatch(r.out, /GATE_CALLED ci/, 'ci 段仍应被跳过');
});

test('P22④: `prePush` 形状非法 ⇒ config 校验报错（不许静默当成 false）', () => {
  const base = { schema: 1, mode: 'observe' };   // 最小合法骨架（mode 是必填）
  assert.deepEqual(validateConfig({ ...base, prePush: { noCi: true } }), [], '合法形状不得报错');
  assert.deepEqual(validateConfig({ ...base, prePush: { noCi: false } }), [], 'false 也合法');
  assert.deepEqual(validateConfig(base), [], '不给 prePush 也合法（默认不跳过）');
  assert.equal(validateConfig({ ...base, prePush: { noCi: 'yes' } }).length > 0, true, 'noCi 非布尔必须报错');
  assert.equal(validateConfig({ ...base, prePush: 'on' }).length > 0, true, 'prePush 非对象必须报错');
});
