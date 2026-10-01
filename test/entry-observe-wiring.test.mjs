// dsh-rulekeeper · 入口接线判据：`appendLine` 必须在**生产入口**注入（2026-10-01）
//
// 判据（红/绿可重跑）：
//   绿 = 走 `index.js` 默认导出 `apply(fakeCtx)` 装上后，向捕获到的 `tools/pre-execute` 监听器喂一条
//        **命中形态**的命令 ⇒ 落点目录真的出现 `command-form-observe.jsonl` 行
//   红 = 入口漏传 `appendLine`（把 `applyPlugin` 的那个键删掉）⇒ 文件不出现 ⇒ 本用例必红
//
// 为什么必须有这条：现有两条用例都覆盖不到这段接线——
//   `command-form.test.mjs` 只测**纯函数**（`judgeCommand`）；`package-face.test.mjs` 只测入口**形态**
//   （`default {name,inject,apply}` 与工具名前缀）。而 `apply()` 的 `appendLine` 是**可选参数、默认 null**，
//   落盘侧又以 `typeof appendLine === 'function'` 做守卫 ⇒ 入口不传 = 落盘静默失效。
//   **归因（2026-10-01 独立 CR 更正，规则 41/54：说法必须与事实一致）**：此前初版注释写"单测为了可测性
//   显式注入 appendLine"，**不成立** —— 全仓 grep 证明**没有任何用例把 `appendLine` 传进 `apply()`**
//   （`isolation.test.mjs` 注入的是 `makeErrorSink`，那是**另一个缝**）。准确说法是：
//   **该落盘分支无任何用例覆盖**。这个区别很重要 —— 错根因会把预防指向"多加注入式用例"，
//   而真正要覆盖的是**入口接线**这一环。
//
// **为什么本用例不 skip（独立 CR 判 MAJOR 后的修正）**：初版照抄 `package-face.test.mjs` 的
//   "无宿主事件表就 skip"，而 CI（`.github/workflows/dsh-rulekeeper-gate.yml`）跑的正是**没有 `~/.dsh`**
//   的 runner ⇒ 本用例在 CI 上**恒为"跳过即绿"**，同一处接线再被删一次 CI 照旧全绿（本缺陷第一次就是这么漏过去的）。
//   现在改为：**自造夹具宿主**（在隔离的 `DSH_HOME` 里写一份含 `ctx.on('tools/pre-execute', …)` 的迷你宿主文件，
//   与 `test/plugin.test.mjs` 的 `fixtureHost()` 同一模式）⇒ 表非空、判定可下，**任何机器上都真跑**。
//
// 隔离（规则 47）：本文件驱动 `apply()`，而 `apply()` 用 `process.env` 解析落点 ⇒ 必须
//   `isolateProcessUserLanding()` 把 `DSH_HOME` 指到一次性临时目录，并在退出时核对**真实**用户级落点未被写入。
//
// 边界（诚实）：本用例用**假 ctx**，**不构成宿主契约验收**；它判的只是"入口 → 落盘"这一段接线。
// 零依赖：只用 node:*。

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import entry from '../index.js';
import { COMMAND_FORM_OBSERVE_REL, PLUGIN_EVENTS } from '../src/plugin.mjs';
import { cleanupAll, isolateProcessUserLanding, realUserLandingGuard } from './helpers/sandbox.mjs';

// `apply()` 内部用 `process.env` 解析落点 ⇒ 本文件**必须**隔离 DSH_HOME，否则并集记账会写进**真实**落点（L644 实测）。
const landedGuard = realUserLandingGuard();
const isolatedHome = isolateProcessUserLanding('entry-wiring-home');
const DSH = process.env.DSH_HOME;

// 夹具宿主：把本插件订阅的事件名写成 `ctx.on('<event>', …)` 字面量（与 plugin.test.mjs 的 fixtureHost 同一口径）。
// 事件集从 `PLUGIN_EVENTS` **派生**，以后新增事件夹具自动跟上。
mkdirSync(join(DSH, 'lib'), { recursive: true });
writeFileSync(
  join(DSH, 'lib', 'host.js'),
  ['// 迷你宿主（夹具）', ...PLUGIN_EVENTS.map((e) => `ctx.on('${e}', () => {})`), "ctx.on('other/event', () => {})"].join('\n') + '\n',
  'utf8',
);

test.after(() => {
  cleanupAll();
  isolatedHome.restore();
  landedGuard.assertClean('入口接线用例');
});

test('入口接线：命中形态的命令经**真实入口**后必须落盘（红样本＝入口漏传 appendLine）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rk-entry-wiring-'));
  const landing = join(root, '.dsh-ai', 'rulekeeper');
  mkdirSync(landing, { recursive: true });
  const cwd0 = process.cwd();
  const listeners = new Map();
  try {
    // 落点解析的最后一档来源是 `process.cwd()`（见 `src/landing.mjs` 的 processCwd）
    // ⇒ 用例把 cwd 指到临时工程，落点就落在临时目录里（不写真实落点）
    process.chdir(root);
    const ctx = {
      effect: (fn) => { fn(); },
      tools: { register: () => () => {} },
      on: (ev, fn) => { listeners.set(ev, fn); },
    };
    entry.apply(ctx);

    // ① 入口必须真的把 `tools/pre-execute` 订阅上（订阅集合由 PLUGIN_EVENTS 钉死）
    assert.equal(PLUGIN_EVENTS.includes('tools/pre-execute'), true);
    const pre = listeners.get('tools/pre-execute');
    assert.equal(typeof pre, 'function', '入口 apply(fakeCtx) 之后没有订阅 tools/pre-execute');

    // ② 喂一条**命中**形态：管道 + 取退出码 + 无 pipefail（命令串本身无害，不产生任何副作用）
    const command = "Get-Item . | Select-Object -First 1 | ForEach-Object { 'x' }; 'rc=' + $LASTEXITCODE";
    const ret = pre({ name: 'pwsh', arguments: { command } }, async () => ({ kind: 'allow' }));
    assert.equal(typeof ret?.then, 'function', '监听器必须参与瀑布流（返回 next 的结果 / thenable）');
    await ret;

    // ③ 判据落在**落点文件自身**（规则 41：对象级事实，不用聚合结论）
    const file = join(landing, COMMAND_FORM_OBSERVE_REL);
    assert.equal(existsSync(file), true,
      `命中形态未落盘：${file} 不存在 ⇒ 入口没有把 appendLine 传进 apply()`);
    const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(lines.length >= 1, '落点文件存在但零行');
    const row = JSON.parse(lines[lines.length - 1]);
    assert.equal(row.kind, 'command-form-observe');
    assert.deepEqual(row.forms, ['CMD_PIPE_NO_PIPEFAIL']);
    assert.equal(row.findings[0].id, 'CMD_PIPE_NO_PIPEFAIL');
  } finally {
    process.chdir(cwd0);
    rmSync(root, { recursive: true, force: true });
  }
});
