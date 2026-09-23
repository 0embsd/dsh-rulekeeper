// dsh-rulekeeper · P20 用例：`gate-finality` 的**子命令判定**必须是语义等价类，不是字面子串
//
// 现场（2026-09-23，被治理项目报）：原实现 `text.includes('hook.mjs" ' + name)` 把
// **变量间接调用**（`runner="$root/.../hook.mjs"` → `exec node "$runner" commit-msg "$@"`）
// 判成"门禁空转"——语义完全等价，属误报；而"真装错子命令"（commit-msg 里传 `pre-push`）必须仍判红。
//
// 判据（红 = 任一侧被喂错结论）：
//   ① 字面路径调用 ⇒ 绿
//   ② 变量间接调用 ⇒ **绿**（本用例的核心：旧口径在这里红）
//   ③ 变量间接 + **名字装错** ⇒ 红，且 finding 里看得见是哪一件、错在哪
//   ④ 变量间接 + **runner 不是 hook.mjs**（`exec node "$runner" pre-commit "$@"`，runner=别的脚本）⇒ 红
//   ⑤ 对照：旧口径（子串匹配）在 ② 上必然判红 —— 证明本用例真的钉住了这条改动
//   ⑥ 真仓四件 hook 仍判绿，且 `GATE_FINALITY_DISPATCH` 如实打印每件的分诊
//
// 反向红：把 `dispatchOf` 退回字面子串实现 ⇒ ② 红、⑥ 里真仓也红（真仓就是变量间接形态）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanupAll, PKG_ROOT, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const CHECKER = join(PKG_ROOT, 'scripts', 'checkers', 'gate-finality.mjs');
const EXPECTED = ['pre-commit', 'commit-msg', 'post-commit', 'pre-push'];

/** 在指定树上跑**诊断模式**（只读、只打印、不参与判定路径） */
function exportTree(dir) {
  const res = spawnSync(process.execPath, [CHECKER], {
    cwd: PKG_ROOT, encoding: 'utf8',
    env: { ...process.env, GATE_FINALITY_MODE: 'export', RULEKEEPER_SAMPLE_DIR: dir },
  });
  return { rc: res.status, out: res.stdout ?? '', err: res.stderr ?? '' };
}

/** 无 MUTEX 的 runner 调用形态（③ 用它证明"名字装错"会被抓） */
const callWithVar = (sub) => `runner="$root/.dsh-ai/rulekeeper/hook.mjs"\nexec node "$runner" ${sub} "$@"`;
const callLiteral = (sub) => `exec node "$root/.dsh-ai/rulekeeper/hook.mjs" ${sub} "$@"`;

/**
 * 造一棵树。`overrides` = { <hook 名>: { runner?: 'hook'|'other', sub?: string } }
 * —— 不传则四件都用"变量间接 + 自己的名字"（与真仓同形的绿态）。
 */
function makeTree(tag, overrides = {}) {
  const dir = tempDir(tag);
  mkdirSync(join(dir, '.githooks'), { recursive: true });
  writeFileSync(join(dir, '.gitattributes'), '.githooks/*  text eol=lf\n', 'utf8');
  for (const name of EXPECTED) {
    const ov = overrides[name] ?? {};
    const runner = ov.runner === 'other' ? 'runner="$root/other-tool.mjs"' : 'runner="$root/.dsh-ai/rulekeeper/hook.mjs"';
    const sub = ov.sub ?? name;
    writeFileSync(join(dir, '.githooks', name),
      `#!/bin/sh\nroot=$(git rev-parse --show-toplevel 2>/dev/null) || exit 1\n${runner}\nexec node "$runner" ${sub} "$@"\n`,
      'utf8');
  }
  return dir;
}

const dispatchOf = (out) => Object.fromEntries(
  (/DISPATCH=(\S+)/.exec(out)?.[1] ?? '').split(',').filter((s) => s !== '').map((kv) => kv.split('=')),
);
const hooksHits = (out) => out.split(/\r?\n/).filter((l) => l.includes('.githooks/'));

/** 旧口径（修复前的字面子串语义）—— 只用来做对照，证明本用例钉住了这次改动 */
const oldCriterionOk = (text, name) => text.includes(`hook.mjs" ${name}`);

test('P20①: 字面路径调用 ⇒ 绿', () => {
  const dir = tempDir('p20-literal');
  mkdirSync(join(dir, '.githooks'), { recursive: true });
  writeFileSync(join(dir, '.gitattributes'), '.githooks/*  text eol=lf\n', 'utf8');
  for (const name of EXPECTED) {
    writeFileSync(join(dir, '.githooks', name),
      `#!/bin/sh\nroot=$(git rev-parse --show-toplevel 2>/dev/null) || exit 1\n${callLiteral(name)}\n`, 'utf8');
  }
  const res = exportTree(dir);
  assert.equal(res.rc, 0, `字面调用必须绿；out=${res.out}`);
  assert.deepEqual(dispatchOf(res.out), Object.fromEntries(EXPECTED.map((n) => [n, 'ok'])));
});

test('P20②: 变量间接调用 ⇒ **绿**（旧口径在这里判红 = 误报）', () => {
  const dir = makeTree('p20-var');
  const res = exportTree(dir);
  assert.equal(res.rc, 0, `变量间接调用语义等价，必须绿；out=${res.out}`);
  assert.deepEqual(dispatchOf(res.out), Object.fromEntries(EXPECTED.map((n) => [n, 'ok'])));
});

test('P20③: 变量间接 + 名字装错（commit-msg 传 pre-push）⇒ 红，且指明是哪一件', () => {
  const dir = makeTree('p20-wrong-sub', { 'commit-msg': { sub: 'pre-push' } });
  const res = exportTree(dir);
  assert.equal(res.rc, 1, `装错子命令必须红；out=${res.out}`);
  assert.equal(dispatchOf(res.out)['commit-msg'], 'dispatch-missing', '分诊必须指明"名字没出现"');
  assert.equal(dispatchOf(res.out)['pre-commit'], 'ok', '其余三件不该被连带判红');
  const hits = hooksHits(res.out);
  assert.equal(hits.length, 1, `只该报 commit-msg 一件；hits=${JSON.stringify(hits)}`);
  assert.match(hits[0], /commit-msg: 没有把自己的名字/);
});

test('P20④: 变量间接 + runner 不是 hook.mjs ⇒ 红（"没调到派发器"与"名字装错"分开报）', () => {
  const dir = makeTree('p20-wrong-runner', { 'pre-commit': { runner: 'other' } });
  const res = exportTree(dir);
  assert.equal(res.rc, 1, `派发器都调错了必须红；out=${res.out}`);
  assert.equal(dispatchOf(res.out)['pre-commit'], 'runner-missing');
  assert.match(hooksHits(res.out).join('\n'), /pre-commit: 没有调到 hook\.mjs/);
});

test('P20⑤: 对照 —— 旧口径在"子命令本身是变量"的形态上判红（本仓形态恰好不受影响）', () => {
  // 被修的误报形态：**子命令**是变量（`exec node "$runner" "$name" "$@"`）
  const varSub = '#!/bin/sh\nroot=$(git rev-parse --show-toplevel 2>/dev/null) || exit 1\n'
    + 'name=pre-commit\nrunner="$root/.dsh-ai/rulekeeper/hook.mjs"\nexec node "$runner" "$name" "$@"\n';
  assert.equal(oldCriterionOk(varSub, 'pre-commit'), false, '旧口径在"子命令是变量"上判红 = 被修的误报');

  // 同一条旧口径的**盲区**：runner 变量化也一样（只要 `hook.mjs" ` 后面不是名字）
  const varRunner = '#!/bin/sh\nexec node "$runner" pre-commit "$@"\n';
  assert.equal(oldCriterionOk(varRunner, 'pre-commit'), false, 'runner 变量化时旧口径同样盲');

  // 新口径必须把上面两种**都判绿**（容忍变量 ≠ 放弃判别力）：造真树跑一遍。
  // 记清这两种形态的差别：`varsub` 是**子命令**变量（`name=<自己>` → `"$name"`）；
  // `varpath` 是**runner 路径**变量（runner 指向 hook.mjs，子命令仍是字面名字）。
  for (const [tag, body] of [
    ['p20-varsub', (n) => `#!/bin/sh\nname=${n}\nexec node "$root/.dsh-ai/rulekeeper/hook.mjs" "$name" "$@"\n`],
    ['p20-varpath', (n) => '#!/bin/sh\nrunner="$root/.dsh-ai/rulekeeper/hook.mjs"\n'
      + `exec node "$runner" ${n} "$@"\n`],
  ]) {
    const dir = tempDir(tag);
    mkdirSync(join(dir, '.githooks'), { recursive: true });
    writeFileSync(join(dir, '.gitattributes'), '.githooks/*  text eol=lf\n', 'utf8');
    for (const name of EXPECTED) {
      writeFileSync(join(dir, '.githooks', name), body(name), 'utf8');
    }
    const r = exportTree(dir);
    assert.equal(r.rc, 0, `${tag}: 新口径必须判绿（变量间接/子命令变量）；out=${r.out}`);
  }

  // 本仓形态是"变量拼**路径** + 字面**子命令**"：`hook.mjs"` 后面正好是名字 ⇒ 旧口径**恰好**命中。
  // 如实写下这条边界，避免把"本仓没被误伤"误读成"旧口径没问题"。
  const real = spawnSync(process.execPath, [CHECKER], { cwd: PKG_ROOT, encoding: 'utf8' });
  assert.equal(real.status, 0);
  const realHook = readFileSync(join(PKG_ROOT, '.githooks', 'pre-commit'), 'utf8');
  assert.equal(oldCriterionOk(realHook, 'pre-commit'), true,
    '本仓是"路径变量 + 字面子命令"形态 ⇒ 旧口径恰好命中（所以本仓当年没暴露这个误报）');
  // 而新口径两种形态都判绿：这才是"容忍变量 ≠ 放弃判别力"
});

test('P20⑦: 判别力不得被注释/echo 里的整词冲掉（独立复核实测的绕过形态）', () => {
  // 现场：真把子命令装错成 `commit-msg`，再补一行"说明性"文本提到本名 ⇒ 旧实现判绿。
  const dir = makeTree('p20-comment-bypass', { 'pre-push': { sub: 'commit-msg' } });
  // 在装错的那件里加注释与 echo 提示串（都是"提到本名"的合法装饰）
  const file = join(dir, '.githooks', 'pre-push');
  writeFileSync(file, `${readFileSync(file, 'utf8')}# this file is the pre-push wrapper\necho "usage: hook.mjs pre-push"\n`, 'utf8');
  const res = exportTree(dir);
  assert.equal(res.rc, 1, `装错就是装错，注释里的名字不算派发；out=${res.out}`);
  assert.equal(dispatchOf(res.out)['pre-push'], 'dispatch-missing');
  // 反向：**只有**注释/echo 提本名、真正派发也对的树必须仍判绿（不能把装饰当违规）
  const okDir = makeTree('p20-comment-ok');
  const okFile = join(okDir, '.githooks', 'pre-push');
  writeFileSync(okFile, `${readFileSync(okFile, 'utf8')}# pre-push wrapper\necho "usage: hook.mjs pre-push"\n`, 'utf8');
  const okRes = exportTree(okDir);
  assert.equal(okRes.rc, 0, `装饰不得让正当写法判红；out=${okRes.out}`);
});

test('P20⑧: `"$(basename "$0")"` 自命名写法（教科书式）必须判绿', () => {
  const dir = makeTree('p20-basename-self', Object.fromEntries(EXPECTED.map((n) => [n, {
    sub: '"$(basename "$0")"',
  }])));
  const res = exportTree(dir);
  assert.equal(res.rc, 0, `合法自命名写法不得判红（旧实现 4/4 判 red）；out=${res.out}`);
  assert.equal(dispatchOf(res.out)['pre-commit'], 'ok-basename-self', '分诊要如实标明是哪一种等价形态');
});

test('P20⑥: 真仓四件 hook 判绿，且分诊读数逐件如实打印', () => {
  const res = spawnSync(process.execPath, [CHECKER], { cwd: PKG_ROOT, encoding: 'utf8' });
  assert.equal(res.status, 0, `真仓必须绿；out=${res.stdout}`);
  assert.match(res.stdout ?? '', /GATE_FINALITY_VIOLATIONS=0/);
  const disp = dispatchOf(res.stdout ?? '');
  for (const name of EXPECTED) assert.equal(disp[name], 'ok', `${name} 的分诊必须是 ok（实得 ${disp[name]}）`);
  // ⚠ 只断言 rc / VIOLATIONS=0 是**不够强**的：旧口径（字面子串）在本仓形态下恰好命中 ⇒ 它也全绿。
  // 所以这里额外钉住"分诊读数"本身（反向红实测：退回旧实现时本断言必须红）。
  assert.match(res.stdout ?? '', /GATE_FINALITY_DISPATCH=pre-commit=ok,commit-msg=ok,post-commit=ok,pre-push=ok/);
  assert.match(res.stdout ?? '', /RED_OK=true/, '活体证明必须仍然成立（两棵红态样本都判红）');
});
