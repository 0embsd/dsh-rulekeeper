// dsh-rulekeeper · **宿主保真**回归用例（2026-09-20 事故后补，务必保留）
//
// 事故（真实，当天）：
//   我为了"让通道为什么没发可见"，在 `apply()` 里加了诊断代码：`ctx.systemPrompt !== null && …`。
//   但 cordis 的 ctx **只允许读在 `inject` 里声明过的服务**，否则属性访问**直接抛**：
//     `cannot get property "systemPrompt" without inject`
//   ⇒ 装载期抛错 = **整个插件树加载失败**、DSH 退回 web-safe（用户的整个插件环境被停用）。
//   而**所有既有用例都是绿的**：夹具用普通对象，读不存在的属性只返回 `undefined`，永远不会抛。
//
// 这类"夹具比宿主温柔"的退役模式在本仓已出现过多次（取值面未接线 / 样本不构造）。
// 本文件的存在就是为了让**下一个人加 ctx 探针时**立刻被拦住：
//   · `apply()` 在"未 inject 的服务会抛"的宿主上**必须照常装载**
//   · 诊断必须**如实记 false**，而不是把装载搞挂
//   · 每个读宿主服务的地方都必须**只观察、不改变**装载可行性

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { apply, lastApplyReport, PLUGIN_EVENTS, probeService } from '../src/plugin.mjs';
import { registerDelivery } from '../src/deliver.mjs';
import { makeAnchoredApplyHandler } from '../src/handlers.mjs';
import { createLandingResolver, registryCwd } from '../src/landing.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

/** 造"像 cordis 一样刻薄"的宿主 ctx：读**未声明**的服务属性**直接抛** */
function strictHost(label, { events = [...PLUGIN_EVENTS], declared = ['tools'] } = {}) {
  const root = tempDir(label);
  mkdirSync(join(root, 'lib'), { recursive: true });
  writeFileSync(join(root, 'lib', 'host.js'), `${events.map((e) => `ctx.on('${e}', () => {})`).join('\n')}\n`, 'utf8');
  const registered = [];
  const base = {
    effect: (fn) => fn(),
    on: () => {},
    tools: { register: (d) => registered.push(d) },
  };
  const ctx = new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && !(prop in target) && !declared.includes(prop)) {
        // 与 cordis 同款行为：**抛**，不是返回 undefined
        throw new Error(`cannot get property "${prop}" without inject`);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { root, ctx, registered };
}

test('判据（事故回归）: 宿主对未 inject 的服务**会抛**时，apply() 仍必须照常装载', () => {
  const h = strictHost('strict-host-apply');
  let report = null;
  assert.doesNotThrow(() => {
    apply(h.ctx, { dshRoot: h.root, onReport: (r) => { report = r; } });
  }, '装载期绝不允许因"探一下服务在不在"而抛 —— 抛了就是整个插件树加载失败');
  assert.ok(report !== null, 'report 必须回传（apply 的返回值仍是 undefined）');
  assert.equal(report.registered.length > 0, true, '工具必须照常注册');
  assert.deepEqual(report.services, { systemPrompt: false, agents: false, userQuestions: false },
    '诊断必须如实记 false（在，则 true；不在/未 inject，则 false）—— 它是观察，不是前置条件');
  assert.equal(report.delivery.ok, false, '拿不到 systemPrompt 服务 ⇒ 投递如实报未注册');
  assert.equal(report.delivery.reason, 'no-systemPrompt-service', `原因要干净可读（实得 ${report.delivery.reason}）`);
  assert.equal(lastApplyReport.ok, true);
});

test('判据: probeService 对"抛/缺失/形态不符"一律返回 false，且永不抛', () => {
  assert.equal(probeService(strictHost('strict-probe').ctx, 'systemPrompt'), false, '未 inject ⇒ 抛 ⇒ false');
  assert.equal(probeService({}, 'anything'), false);
  assert.equal(probeService(null, 'x'), false);
  assert.equal(probeService({ x: 42 }, 'x'), false, '不是对象 ⇒ false');
  assert.equal(probeService({ x: {} }, 'x', 'ask'), false, '缺方法 ⇒ false');
  assert.equal(probeService({ x: { ask: () => {} } }, 'x', 'ask'), true);
  assert.doesNotThrow(() => probeService({ get boom() { throw new Error('nope'); } }, 'boom'));
});

test('判据: 其余读宿主服务的地方同样不能在"刻薄宿主"上抛', async () => {
  const h = strictHost('strict-host-others', { declared: [] });
  // ① 投递注册：返回"如实原因"，不抛
  let r = null;
  assert.doesNotThrow(() => { r = registerDelivery(h.ctx, {}); });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-systemPrompt-service');
  // ② 锚定落盘 handler：拿不到 userQuestions ⇒ no-answerer（且不抛）
  const handler = makeAnchoredApplyHandler({ ctx: h.ctx, cwd: tempDir('strict-handler') });
  const out = await handler({ proposal: 'P1' });
  assert.equal(out.ok, false);
  assert.ok(['no-answerer', 'plan-failed'].includes(out.decision), `应如实拒绝（实得 ${out.decision}）`);
  // ③ 落点解析：注册表读不到 ⇒ 不抛（返回 null 或进程 cwd 那一档）
  assert.equal(registryCwd(h.ctx), null);
  assert.doesNotThrow(() => createLandingResolver(h.ctx).describe());
});

test('判据: 诊断报告不得把"探服务"写成装载前置条件（inject 白名单必须保持最小）', async () => {
  const entry = (await import('../index.js')).default;
  // `inject` 一旦加上 systemPrompt/agents/userQuestions，就变成"缺服务即不装载" ⇒ 与"只观察"相反。
  assert.deepEqual(entry.inject, ['tools'], 'inject 只放真正必需的宿主能力；诊断用服务必须靠 probeService 观察');
});
