// dsh-rulekeeper · P16 用例：**三道门必须读同一档 `repoKind`**（2026-09-23）
//
// 现场（被治理项目报，实测确认为真）：`precommit`（文件面）走 `resolveRepoPatterns`（读落点 `repoKind`），
// 而 `commitmsg`（正文面）与 `refs`（引用名面）**没传落点** ⇒ `resolveLeakPatterns` 兜底成"公开仓完整表"
// ⇒ **同一段 identity 文本：文件面 pass、正文面 fail**（他们那档是 private，被拦过一次，属纯误拦）。
//
// 本文件的判据（成对，缺一不算）：
//   ① `private` 档：同一段 identity 文本在**正文面 / 引用名面**都**不得**报（identity 类只在公开仓有意义）；
//   ② `public` 档：同一段文本在**两面**都**必须**报；
//   ③ 两面各自的"没有落点时"仍走保守默认（公开面完整表）——**这道自曝不许被"修 P16"顺手删掉**；
//   ④ 落点声明优先于远端探测：仓里塞一个"看起来像公开托管商"的 remote，`private` 档仍判 private。
//
// 反向红：把任一面的 `landingDir` 传参删掉（退回修复前）⇒ ①②③ 必红。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runRulekeeper } from '../src/cli.mjs';
import { commitMessageGate, refsGate } from '../src/gate.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

/** identity 类样本：**运行时拼装**（规则 51：公开面文件里不写可疑串字面量） */
const IDENTITY_TEXT = ['myx', 'V2 的说明'].join('');

const SHA_A = '1'.repeat(40);
const SHA_B = '2'.repeat(40);

/** 造一个"有落点、可选 remote"的仓（不需要真 git：正文/引用名两面都不跑 git） */
function landingRepo({ repoKind, remote = null } = {}) {
  const root = tempDir(`p16-${repoKind}`);
  const landing = join(root, '.dsh-ai', 'rulekeeper');
  mkdirSync(landing, { recursive: true });
  writeFileSync(join(landing, 'config.json'),
    `${JSON.stringify({ schema: 1, mode: 'observe', ...(repoKind === null ? {} : { repoKind }) }, null, 2)}\n`, 'utf8');
  if (remote !== null) {
    // 只造目录形状，够 `detectRepoKind` 读配置即可（它只跑 `git config --get remote.origin.url`）
    spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
    spawnSync('git', ['-C', root, 'remote', 'add', 'origin', remote], { encoding: 'utf8' });
  }
  return root;
}

const cap = (fn) => {
  let out = ''; let err = '';
  const rc = fn({ out: (t) => { out += String(t); }, err: (t) => { err += String(t); } });
  return { rc, out, err };
};
const commitmsgVia = (root, text) => {
  const file = join(root, 'msg.txt');
  writeFileSync(file, text, 'utf8');
  return cap((io) => runRulekeeper(['gate', 'commitmsg', '--file', file, '--repo', root], io, {}));
};
const refsVia = (root, name) => {
  const file = join(root, 'refs.txt');
  writeFileSync(file, `refs/heads/${name} ${SHA_A} refs/heads/${name} ${SHA_B}\n`, 'utf8');
  return cap((io) => runRulekeeper(['gate', 'refs', '--file', file, '--repo', root], io, {}));
};
const leaksOf = (out) => Number(/LEAKS=(\d+)/.exec(out)?.[1] ?? '-1');

test('P16①: `private` 档 —— 同一段 identity 文本在**正文面与引用名面都不得报**', () => {
  const root = landingRepo({ repoKind: 'private' });
  const cm = commitmsgVia(root, IDENTITY_TEXT);
  const rf = refsVia(root, IDENTITY_TEXT);
  assert.equal(leaksOf(cm.out), 0, `private 档正文面不得报 identity；out=${cm.out}`);
  assert.equal(cm.rc, 0, `private 档正文面必须放行；out=${cm.out}`);
  assert.equal(leaksOf(rf.out), 0, `private 档引用名面不得报 identity；out=${rf.out}`);
  assert.equal(rf.rc, 0, `private 档引用名面必须放行；out=${rf.out}`);
});

test('P16②: `public` 档 —— 同一段文本在**两面都必须报**（成对，缺一不算）', () => {
  const root = landingRepo({ repoKind: 'public' });
  const cm = commitmsgVia(root, IDENTITY_TEXT);
  const rf = refsVia(root, IDENTITY_TEXT);
  assert.equal(leaksOf(cm.out), 1, `public 档正文面必须报；out=${cm.out}`);
  assert.equal(cm.rc, 1);
  assert.equal(leaksOf(rf.out), 1, `public 档引用名面必须报；out=${rf.out}`);
  assert.equal(rf.rc, 1);
  // 报的必须是 identity 类（不是基础设施类）—— 否则这条用例测的可能不是"分档"
  assert.match(cm.out, /内部项目名/, `必须点名 identity 类；out=${cm.out}`);
});

test('P16③（自曝）: 落点**没有 config.json 不算声明** ⇒ 两面走保守默认（公开面完整表）', () => {
  // 现场教训（本轮用例自己逼出来的）：若把"不存在的落点路径"也传给 `resolveRepoPatterns`，
  // 它对"没声明"的兜底是 **private（少扫一类）** ⇒ **没配落点的仓反而比改前更松**。
  // 现口径：落点必须有 `config.json` 才算声明过档位；否则交给 `resolveLeakPatterns` 走保守默认。
  const noConfig = tempDir('p16-noconfig');            // 没有任何落点
  const cm = commitmsgVia(noConfig, IDENTITY_TEXT);
  const rf = refsVia(noConfig, IDENTITY_TEXT);
  assert.equal(leaksOf(cm.out), 1, `无落点 ⇒ 保守默认必须报；out=${cm.out}`);
  assert.equal(leaksOf(rf.out), 1, `无落点 ⇒ 保守默认必须报；out=${rf.out}`);

  // 另一半：**有落点但 config.json 里没写 repoKind** ⇒ 走"探测 → 兜底 private"，如实不报（identity 只对公开仓有意义）
  const noKind = landingRepo({ repoKind: null });
  const cm2 = commitmsgVia(noKind, IDENTITY_TEXT);
  assert.equal(leaksOf(cm2.out), 0, `声明存在但没写档位 ⇒ 走探测/兜底 private，不报 identity；out=${cm2.out}`);

  // 函数层：完全不给 landingDir ⇒ 走保守默认（PUBLIC_FACE_FORBIDDEN）
  const bare = tempDir('p16-bare');
  const file = join(bare, 'm.txt');
  writeFileSync(file, `${IDENTITY_TEXT}\n`, 'utf8');
  assert.equal(commitMessageGate({ messageFile: file }).ok, false, '不给 landingDir ⇒ 不得静默放行');
  assert.equal(refsGate({ text: `refs/heads/${IDENTITY_TEXT} ${SHA_A} refs/heads/x ${SHA_B}` }).ok, false);
});

test('P16④: 落点声明**优先于远端探测**（远端像公开托管商，声明 private 仍判 private）', () => {
  const root = landingRepo({ repoKind: 'private', remote: 'https://github.com/example/private-repo.git' });
  const cm = commitmsgVia(root, IDENTITY_TEXT);
  const rf = refsVia(root, IDENTITY_TEXT);
  assert.equal(leaksOf(cm.out), 0, `落点声明优先 ⇒ 正文面不得因远端像托管商就报；out=${cm.out}`);
  assert.equal(leaksOf(rf.out), 0, `落点声明优先 ⇒ 引用名面同上；out=${rf.out}`);
});

test('P16⑤（函数层）: 两面同源 —— 显式 landingDir 时 `resolveLeakPatterns` 走落点档位', () => {
  const pub = landingRepo({ repoKind: 'public' });
  const pri = landingRepo({ repoKind: 'private' });
  const msg = (root) => {
    const file = join(root, 'm.txt');
    writeFileSync(file, `${IDENTITY_TEXT}\n`, 'utf8');
    return file;
  };
  assert.equal(commitMessageGate({ messageFile: msg(pub), landingDir: join(pub, '.dsh-ai', 'rulekeeper') }).ok, false);
  assert.equal(commitMessageGate({ messageFile: msg(pri), landingDir: join(pri, '.dsh-ai', 'rulekeeper') }).ok, true);
  assert.equal(refsGate({ text: `refs/heads/${IDENTITY_TEXT} ${SHA_A} refs/heads/x ${SHA_B}`, landingDir: join(pri, '.dsh-ai', 'rulekeeper') }).ok, true);
  assert.equal(refsGate({ text: `refs/heads/${IDENTITY_TEXT} ${SHA_A} refs/heads/x ${SHA_B}`, landingDir: join(pub, '.dsh-ai', 'rulekeeper') }).ok, false);
});
