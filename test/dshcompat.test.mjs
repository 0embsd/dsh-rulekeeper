// dsh-rulekeeper · LF-920 **DSH 升级兼容门**用例
//
// 判据（清单 LF-920）：探针 pass；三版本原文入凭证；**红态：故意把事件名改错 → 探针必红**（防恒真判据）。
// fixture 造一个"迷你 DSH 安装面"，因此用例**不依赖本机是否装了 DSH**（可移植：不依赖本机是否装了 DSH）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONTRACT_TOKENS, dshCompatProbe, readVersions, scanTokens } from '../src/dshcompat.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

/** 迷你 DSH 安装面（版本号刻意与真机不同，证明探针读的是文件而不是硬编码） */
function fixtureDsh(label, { cordisDeclared = true, eventName = 'pre-execute' } = {}) {
  const root = tempDir(label);
  const scoped = join(root, 'node_modules', '@x');
  mkdirSync(join(scoped, 'cordis'), { recursive: true });
  mkdirSync(join(scoped, 'dsh-tools'), { recursive: true });
  mkdirSync(join(root, 'lib'), { recursive: true });
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({
    name: '@x/dsh',
    version: '9.9.9',
    dependencies: cordisDeclared ? { '@x/cordis': '^1.0.0' } : {},
  }, null, 2)}\n`, 'utf8');
  writeFileSync(join(scoped, 'cordis', 'package.json'), `${JSON.stringify({ name: '@x/cordis', version: '1.2.3' }, null, 2)}\n`, 'utf8');
  writeFileSync(join(scoped, 'dsh-tools', 'package.json'), `${JSON.stringify({ name: '@x/dsh-tools', version: '9.9.9' }, null, 2)}\n`, 'utf8');
  // 契约 token 全塞进一个文件（模拟宿主安装面）
  const js = [
    `// ${eventName} 钩子`,
    'tools/pre-execute waterfall',
    "plugin/loader",
    'ctx.effect(() => tools.register(x))',
    '',
  ].join('\n');
  writeFileSync(join(root, 'lib', 'plugin.js'), js, 'utf8');
  return root;
}

test('判据: 三版本从安装面读出（不是硬编码）', () => {
  const root = fixtureDsh('dsh-ver');
  const v = readVersions(root);
  assert.equal(v.dsh.version, '9.9.9');
  assert.equal(v.cordis.version, '1.2.3');
  assert.equal(v.dshTools.version, '9.9.9');
  assert.equal(typeof v.node, 'string');
});

test('绿: 契约齐备 -> 探针 exit 判定为 pass（四类用例全 ok）', () => {
  const root = fixtureDsh('dsh-ok');
  const r = dshCompatProbe({ dshRoot: root });
  assert.equal(r.ok, true, JSON.stringify(r.cases));
  assert.equal(r.cases.length, 4);
  assert.ok(r.scanned >= 1);
});

test('红（清单红态）: **故意把事件名改错** -> 探针必红（防恒真判据）', () => {
  const root = fixtureDsh('dsh-bad-event', { eventName: 'preExecut' });
  // 把文件里唯一的 pre-execute 也改错：连 `tools/pre` 一起破坏，确保事件名那一组真的查不到
  writeFileSync(join(root, 'lib', 'plugin.js'), '// preExecut\ntools/preX waterfall\nplugin/loader\nctx.effect(() => tools.register(x))\n', 'utf8');
  const r = dshCompatProbe({ dshRoot: root });
  assert.equal(r.ok, false);
  const eventCase = r.cases.find((c) => c.name.includes('事件名'));
  assert.notEqual(eventCase, undefined);
  assert.equal(eventCase.ok, false);
  assert.match(eventCase.detail, /缺失/);
  // 正对照：API 形态那组仍然过（证明红的是**事件名**这一组，不是"全都红"）
  assert.equal(r.cases.find((c) => c.name.includes('API形态')).ok, true);
});

test('红: cordis 未声明为依赖 -> 判红（宿主升级后依赖改名/移除）', () => {
  const root = fixtureDsh('dsh-no-cordis', { cordisDeclared: false });
  const r = dshCompatProbe({ dshRoot: root });
  assert.equal(r.ok, false);
  assert.equal(r.cases.find((c) => c.name.includes('cordis')).ok, false);
});

test('红: 安装根不存在 -> 立刻判红并给出可操作提示（不抛异常）', () => {
  const r = dshCompatProbe({ dshRoot: join(tempDir('dsh-missing'), 'not-installed') });
  assert.equal(r.ok, false);
  assert.match(r.cases[0].detail, /--dsh-root/);
});

test('判据: `scanTokens` 只数"含该 token 的文件数"（同文件多次出现只计 1）', () => {
  const root = fixtureDsh('dsh-scan');
  const { hits, scanned } = scanTokens(root, ['ctx.effect', '不存在的token']);
  assert.equal(hits.get('ctx.effect'), 1);
  assert.equal(hits.get('不存在的token'), 0);
  assert.ok(scanned >= 1);
});

test('判据: 契约 token 表非空且分组齐（事件名 / API形态）', () => {
  assert.ok(CONTRACT_TOKENS.事件名.length >= 3);
  assert.ok(CONTRACT_TOKENS.API形态.length >= 3);
});
