// dsh-rulekeeper · **版本纪律**用例（2026-09-26，安装测试暴露的缺口）
//
// 缺口现场：`package.json` 的 `version` 停在 `0.2.0`，而 `v0.2.0` 这个 tag 之后已经积了 **48 个提交**、
//   3 次对外能力变更（有理由的 none / 三个基数 / 项目侧报警器面）+ 1 次行为修复。
//   更糟的是 README 的"方式 1①"照抄一条 `…/releases/download/v0.2.0/dsh-rulekeeper-0.2.0.tgz`，
//   而 GitHub 上**一个 Release 都没有**（`/releases/tags/v0.2.0` 实测 404）⇒ **文档里的"推荐方式"是死的**。
//   根因不是"忘了改"，是**没有任何东西盯着版本号**：`packageVersion()` 只被用在 `--help` 的用法串上。
//
// 本文件的判据（红 = 任一）：
//   ① `package.json` 的 `version` ≠ **最近 tag**（`v<version>` 形态）的版本号 ⇒ 红
//      ⇒ 以后"改了对外能力却没 bump"会被拦住，而不是靠人记得；
//   ② 工作流里**测试作业**必须 `fetch-depth: 0`（否则浅克隆不带 tag ⇒ 判据①在本机绿、在 CI 恒 skipped）；
//   ③ README 里出现的 `…/releases/download/v<x.y.z>/…` 里那个版本号必须 = 包版本
//      ⇒ 换版本时不会留下指向旧（或不存在的）tarball 的死链。
//
// 诚实边界（如实登记，不假装它更强）：
//   · 它管**版本号与 tag 的一致性**，**不管**语义化版本判断（那要人定：新增=minor、破坏=patch？）；
//   · Release **产物**是否存在核不了（要 `gh`/token 查远端 API），只能核工作流是否会被 tag 触发；
//   · 浅克隆 / 无 tag 时判据①**如实跳过并打印原因**（skipped 不等于绿，它等于"没判"）。
//
// 反向红：把 version 改成 `9.9.9` ⇒ ① 红；把 CI 测试作业的 fetch-depth 删掉 ⇒ ② 红；
//         把 README 的 tarball 版本号改成别的 ⇒ ③ 红。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanupAll, PKG_ROOT } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
const WORKFLOW = join(PKG_ROOT, '.github', 'workflows', 'dsh-rulekeeper-gate.yml');

/** 跑一条 git 命令（**必须关 quotePath**：本仓规则 45；这里虽然只取 tag 名，仍统一包一层） */
function gitErr(args) {
  const res = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: PKG_ROOT, encoding: 'utf8' });
  return { status: res.status, stdout: String(res.stdout ?? ''), stderr: String(res.stderr ?? '') };
}

/** 最新版本 tag（`v<x.y.z>` 形态，按版本号排序取最大；轻量/附注都一样） */
function latestVersionTag() {
  const res = gitErr(['tag', '--list', 'v[0-9]*.[0-9]*.[0-9]*']);
  if (res.status !== 0) return { tag: null, reason: `git tag 读取失败（rc=${res.status}）：${res.stderr.trim().slice(0, 120)}` };
  const tags = res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (tags.length === 0) return { tag: null, reason: '本检出里没有任何 `v<x.y.z>` tag（浅克隆/无 tag）' };
  const key = (t) => t.replace(/^v/, '').split('.').map((n) => Number(n));
  tags.sort((a, b) => {
    const x = key(a); const y = key(b);
    for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  });
  return { tag: tags[tags.length - 1], reason: null };
}

test('判据①: `package.json` 的 version 必须等于**最近 tag** 的版本号', (t) => {
  const { tag, reason } = latestVersionTag();
  if (tag === null) {
    t.diagnostic(`判据① 未执行（如实登记，不是通过）：${reason}`);
    return;
  }
  assert.equal(pkg.version, tag.replace(/^v/, ''),
    `package.json 版本 ${pkg.version} 与最近 tag ${tag} 不一致 ⇒ 改了对外能力却没 bump 版本（或 bump 了没打 tag）。`
    + ' 处置：改 package.json 的 version 并打附注 tag `v<version>`，两者必须成对。');
});

test('判据②: CI 的**测试作业**必须 fetch-depth: 0（否则判据①在 CI 恒 skipped）', () => {
  const yml = readFileSync(WORKFLOW, 'utf8');
  const testJob = yml.split(/^  test:/m)[1];
  assert.ok(testJob !== undefined, '工作流里必须有 `test:` 作业（没有它 = 用例只在本地跑过）');
  assert.match(testJob, /fetch-depth:\s*0/,
    'test 作业的 checkout 必须 `fetch-depth: 0` —— 浅克隆不带 tag ⇒ 判据①拿不到 tag，只能 skipped（判据形同不存在）');
});

test('判据③: README 里的 release tarball 版本号必须 = 包版本（不留死链）', () => {
  const readme = readFileSync(join(PKG_ROOT, 'README.md'), 'utf8');
  const urls = [...readme.matchAll(/releases\/download\/(v[0-9]+\.[0-9]+\.[0-9]+)\//g)].map((m) => m[1]);
  assert.ok(urls.length > 0, 'README 的安装节应当给出从 GitHub 装的 tarball 路径（否则"方式 1①"无从照抄）');
  for (const v of urls) {
    assert.equal(v.replace(/^v/, ''), pkg.version,
      `README 里的 release tarball 指向 ${v}，而包版本是 ${pkg.version} ⇒ 换版本时会留下死链`
      + '（实测教训：v0.2.0 那条 URL 对应的 Release 在 GitHub 上根本不存在，404）');
  }
  // 自曝边界：Release 产物本身核不了（要 gh/token 查远端 API）—— 读得到就说明，读不到就不假装核过
  assert.match(readme, /Release/, 'README 里要写清"Release 必须真的建出来"，否则 tag 有了而 URL 仍然 404');
});
