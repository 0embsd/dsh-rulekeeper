// dsh-rulekeeper · P19 用例：**混行尾的修法提示必须按现场分诊**（不是一句"git restore"打天下）
//
// 现场（2026-09-23，被治理项目实测 + 本仓受控实验）：
//   原提示写「修法优先 `git restore -- <路径>`」。在 `core.autocrlf=true` 且**该文件没被
//   `.gitattributes` 显式钉住**的仓上，`git restore` 把工作区刷成**整份 CRLF**（不是回到 LF）
//   ⇒ 人照提示做完，字节没修好，下一轮照报。而"先删后取"在同一现场也**不是**真修法。
//
// 本文件的判据（红 = 任一形态被喂错提示，或"照提示做完仍然红"）：
//   ① 已钉 `eol=lf` ⇒ 提示 `EOL_FIX=git-restore`，且照做后 CRLF=0、重跑判绿
//   ② 未钉 + `autocrlf=true` ⇒ 提示 `EOL_FIX=pin-then-renormalize`（且明说 `git restore` 不管用），
//      照 ①②③ 三步做完后 CRLF=0、重跑判绿；**负对照**：只跑 `git restore` 拿不到纯 LF
//   ③ 未钉 + `autocrlf=false` ⇒ 提示 `EOL_FIX=git-restore`，且照做后 CRLF=0、重跑判绿
//   ④ 真仓（本机 `autocrlf=true`）零误报：绿样本与真仓都不因这条改动冒出新违规
//
// ⚠ 反向红：本文件在"按现场分诊"实现之前必须**红**（原实现恒发 `git restore` 提示，输出里没有 `EOL_FIX=`）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanupAll, PKG_ROOT, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const CHECKER = join(PKG_ROOT, 'scripts', 'checkers', 'byte-discipline.mjs');

function run(sampleDir, extraEnv = {}) {
  const res = spawnSync(process.execPath, [CHECKER], {
    cwd: PKG_ROOT, encoding: 'utf8', env: { ...process.env, RULEKEEPER_SAMPLE_DIR: sampleDir, ...extraEnv },
  });
  return { rc: res.status, out: res.stdout ?? '', err: res.stderr ?? '' };
}

/** 仓库根 = root，`-C root` 显式（不继承测试进程 cwd，避免 sibling 进程污染） */
function git(root, ...args) {
  const r = spawnSync('git', ['-c', 'core.quotePath=false', '-C', root, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} 失败：${r.stderr}`);
  return (r.stdout ?? '').trim();
}

/** 逐字节量具（禁 `Get-Content`/`Out-String` 那类会归一化行尾的读法） */
function bytes(root, rel) {
  const b = readFileSync(join(root, rel));
  const s = b.toString('latin1');
  const crlf = (s.match(/\r\n/g) || []).length;
  const lf = (s.match(/\n/g) || []).length - crlf;
  return { size: b.length, crlf, lf, endsWithNewline: b.length > 0 && b[b.length - 1] === 0x0a };
}

/**
 * 造一个"混行尾"现场：blob 里是纯 LF（正常入库），工作区被改成 CRLF+裸 LF 混排。
 * `attrs` = `.gitattributes` 内容；`autocrlf` 显式设成 true/false（不给就不动）。
 */
function makeMixedRepo({ tag, attrs, autocrlf, rel = 'src/probe.txt' }) {
  const dir = tempDir(tag);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.gitattributes'), attrs, 'utf8');
  writeFileSync(join(dir, rel), 'line one\nline two\nline three\n', 'utf8');
  git(dir, 'init', '-q');
  if (autocrlf !== undefined) git(dir, 'config', 'core.autocrlf', String(autocrlf));
  git(dir, 'config', 'user.email', 'probe@local');
  git(dir, 'config', 'user.name', 'probe');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  // 前置事实断言：入库 blob 是纯 LF（否则这个用例测的不是"工作区混行尾"）
  const blob = spawnSync('git', ['-C', dir, 'cat-file', 'blob', `HEAD:${rel}`]).stdout.toString('latin1');
  assert.equal(blob.includes('\r'), false, '前置：blob 必须是纯 LF');
  writeFileSync(join(dir, rel), 'line one\r\nline two\nline three\n', 'utf8');
  return dir;
}

const fixKindOf = (out, rel) => {
  const line = out.split(/\r?\n/).find((l) => l.includes(`BYTE_EOL_INCONSISTENT: ${rel}`));
  if (line === undefined) return null;
  const m = /\[EOL_FIX=([a-z-]+)\]/.exec(line);
  return m === null ? null : m[1];
};

const eolHitLines = (out) => out.split(/\r?\n/).filter((l) => l.includes('BYTE_EOL_INCONSISTENT'));

test('P19①: 已钉 eol=lf ⇒ 分诊 git-restore，且照做后 CRLF=0、重跑判绿', () => {
  const dir = makeMixedRepo({ tag: 'p19-pinned', attrs: '*.txt text eol=lf\n', autocrlf: true });
  const before = bytes(dir, 'src/probe.txt');
  assert.deepEqual([before.crlf, before.lf], [1, 2], '前置：工作区确实是混行尾');

  const res = run(dir);
  assert.equal(res.rc, 1, `混行尾必须报；out=${res.out}`);
  assert.equal(fixKindOf(res.out, 'src/probe.txt'), 'git-restore', `已钉文件应分诊 git-restore；out=${res.out}`);

  git(dir, 'restore', '--', 'src/probe.txt');
  const after = bytes(dir, 'src/probe.txt');
  assert.equal(after.crlf, 0, `照提示做完必须 CRLF=0（实得 ${after.crlf}）`);
  assert.equal(after.lf, 3);
  assert.equal(run(dir).rc, 0, '修完同命令重跑必须判绿');
});

test('P19②: 未钉 + autocrlf=true ⇒ 分诊 pin-then-renormalize；只 git restore 治不了（负对照）', () => {
  const dir = makeMixedRepo({ tag: 'p19-unpinned-crlf', attrs: '*.md text eol=lf\n', autocrlf: true });
  const res = run(dir);
  assert.equal(res.rc, 1);
  assert.equal(fixKindOf(res.out, 'src/probe.txt'), 'pin-then-renormalize',
    `未钉 + autocrlf=true 必须分诊"先补声明再 renormalize"；out=${res.out}`);
  const line = eolHitLines(res.out)[0];
  assert.match(line, /git restore -- <路径>` \*\*不解决问题\*\*/, '提示必须明说 git restore 在这个现场不管用');

  // ── 负对照：照**旧**提示做（只 git restore）拿不到纯 LF ──────────────────────
  git(dir, 'restore', '--', 'src/probe.txt');
  const afterRestore = bytes(dir, 'src/probe.txt');
  assert.equal(afterRestore.crlf > 0, true,
    `旧提示在这个现场必须留下 CRLF（实得 crlf=${afterRestore.crlf}）—— 这就是"照提示做完仍然坏"`);

  // ── 正路：三步做完 ⇒ 纯 LF + 重跑绿 ─────────────────────────────────────────
  writeFileSync(join(dir, '.gitattributes'), '*.md text eol=lf\nsrc/probe.txt text eol=lf\n', 'utf8');
  git(dir, 'add', '--renormalize', '--', 'src/probe.txt');
  rmSync(join(dir, 'src', 'probe.txt'));
  git(dir, 'restore', '--', 'src/probe.txt');
  const afterFix = bytes(dir, 'src/probe.txt');
  assert.equal(afterFix.crlf, 0, `三步做完必须 CRLF=0（实得 ${afterFix.crlf}）`);
  assert.equal(afterFix.lf, 3);
  assert.equal(run(dir).rc, 0, '修完同命令重跑必须判绿');
});

test('P19③: 未钉 + autocrlf=false ⇒ git restore 真修（分诊 git-restore），且提示自曝"依赖机器配置"', () => {
  const dir = makeMixedRepo({ tag: 'p19-unpinned-lf', attrs: '*.md text eol=lf\n', autocrlf: false });
  const res = run(dir);
  assert.equal(res.rc, 1);
  assert.equal(fixKindOf(res.out, 'src/probe.txt'), 'git-restore',
    `autocrlf=false 时取回不做转换 ⇒ 应分诊 git-restore；out=${res.out}`);
  assert.match(eolHitLines(res.out)[0], /依赖机器配置/, '必须自曝这条修法依赖机器配置（否则换机复现）');

  git(dir, 'restore', '--', 'src/probe.txt');
  const after = bytes(dir, 'src/probe.txt');
  assert.equal(after.crlf, 0, `照提示做完必须 CRLF=0（实得 ${after.crlf}）`);
  assert.equal(run(dir).rc, 0);
});

test('P19④: 真仓（本机 autocrlf=true）零误报 —— 判据只动提示，不动判定', () => {
  const res = run(PKG_ROOT);
  assert.equal(res.rc, 0, `真仓必须仍零违规；out=${res.out}`);
  assert.match(res.out, /BYTE_DISCIPLINE_VIOLATIONS=0/);
  assert.doesNotMatch(res.out, /EOL_FIX=/, '零违规时不该出现任何分诊提示');
});
