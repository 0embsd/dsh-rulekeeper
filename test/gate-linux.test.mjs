// dsh-rulekeeper · LF-560 **门禁跨平台**（hook 的 shebang / EOL / 可执行位 + Git Bash 语义 + 防"Linux 已验证"假绿）
//
// 判据（清单 §5 LF-560）：
//   ① 本机 **Git Bash（POSIX shell 语义）** 验证 shebang / CRLF / 可执行位；
//   ② Linux 侧 `tar`+`sha256sum` **文件级**校验通过（②由取证脚本 + 工具调用完成，本文件只覆盖文件级比对器）；
//   红态：把"Git Bash 里 node 能跑"写成 **Linux 验证通过** → **必红**。
//
// 本文件的"事实基础"是自己实测的（不引用二手结论）：
//   Git Bash 里 `uname -s` = MINGW64_*（**不是** Linux），`command -v node` = `/c/Program Files/nodejs/node`，
//   而该 node 自己报 `process.platform === 'win32'` ⇒ **它就是 Windows node**。
//   所以"Git Bash 能跑 node" ≠ "Linux 能跑 node" —— 这正是本条目要机检的假绿。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runCrossplat } from '../src/cli.mjs';
import {
  GIT_BASH_DEFAULT, LINUX_CARRIER_DONE, LINUX_CARRIER_REASON,
  compareFileHashes, fakeLinuxClaimGuard, fileHashManifest, gitBashProbe, hookArtifactChecks,
} from '../src/crossplat.mjs';
import { RC } from '../src/rc.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

// LF-565：POSIX 上默认 shell 是 PATH 里的 bash（不需要 existsSync 探测路径）
const HAS_BASH = process.platform === 'win32' ? existsSync(GIT_BASH_DEFAULT) : true;
function capture(fn) {
  let out = '';
  let err = '';
  const rc = fn({ out: (t) => { out += String(t); }, err: (t) => { err += String(t); } });
  return { rc, out, err };
}
const crossplat = (args) => capture((io) => runCrossplat(args, io, {}));

/** 造三个"门禁生成物"（正常 / CRLF / 无 shebang），用于形态检查的红绿 */
function artifacts(label, { eol = '\n', shebang = true } = {}) {
  const dir = tempDir(label);
  const sh = join(dir, 'pre-commit');
  const runner = join(dir, 'hook.mjs');
  const body = ['#!/bin/sh', 'root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 1', 'exec node "$root/.dsh-ai/rulekeeper/hook.mjs" pre-commit "$@"', ''].join(eol);
  writeFileSync(sh, shebang ? body : body.replace('#!/bin/sh\n', ''), 'utf8');
  writeFileSync(runner, '#!/usr/bin/env node\nprocess.exit(0);\n', 'utf8');
  return {
    dir,
    files: [
      { relPath: '.githooks/pre-commit', absPath: sh, role: 'hook' },
      { relPath: '.dsh-ai/rulekeeper/hook.mjs', absPath: runner, role: 'runner' },
    ],
  };
}
const allCases = (r) => r.cases.map((c) => `${c.ok ? 'OK' : 'FAIL'} ${c.name}`);

test('green: 生成物形态全过（shebang / 纯 LF / 无 BOM / bash -n）', { skip: !HAS_BASH ? '本机没有 Git Bash' : false }, () => {
  const a = artifacts('lf560-green');
  const r = hookArtifactChecks({ files: a.files });
  assert.equal(r.ok, true, allCases(r).join('\n'));
  const names = r.cases.map((c) => c.name);
  assert.ok(names.some((n) => n.includes('有 shebang')));
  assert.ok(names.some((n) => n.includes('纯 LF')));
  assert.ok(names.some((n) => n.includes('无 BOM')));
  assert.ok(names.some((n) => n.includes('bash -n 通过')));
});

test('red: CRLF 的 hook 必须被抓住（POSIX 上是灾难：`\\r` 会进参数/命令名）', { skip: !HAS_BASH ? '本机没有 Git Bash' : false }, () => {
  const a = artifacts('lf560-crlf', { eol: '\r\n' });
  const r = hookArtifactChecks({ files: a.files });
  assert.equal(r.ok, false);
  const crCase = r.cases.find((c) => c.name.includes('纯 LF'));
  assert.equal(crCase.ok, false);
  assert.match(crCase.detail, /含 CR：\d+ 个/);
});

test('red: 缺 shebang 必须被抓住', { skip: !HAS_BASH ? '本机没有 Git Bash' : false }, () => {
  const a = artifacts('lf560-noshebang', { shebang: false });
  const r = hookArtifactChecks({ files: a.files });
  assert.equal(r.ok, false);
  assert.equal(r.cases.find((c) => c.name.includes('有 shebang')).ok, false);
});

test('判据: 可执行位用**索引 mode**（跨平台一致）；给不出索引时 win32 如实标注、不冒充', () => {
  const a = artifacts('lf560-exec');
  const withIndex = hookArtifactChecks({ files: a.files, indexMode: () => '100644' });
  assert.equal(withIndex.cases.find((c) => c.name.includes('可执行位')).ok, false, 'mode=100644 必须判不合规');
  const withIndexOk = hookArtifactChecks({ files: a.files, indexMode: () => '100755' });
  assert.equal(withIndexOk.cases.find((c) => c.name.includes('可执行位')).ok, true);
  const noIndexWin = hookArtifactChecks({ files: a.files, indexMode: () => null, platform: 'win32' });
  const c = noIndexWin.cases.find((x) => x.name.includes('可执行位'));
  assert.equal(c.ok, true, 'win32 没有 exec 位：不判违规');
  assert.match(c.detail, /未入索引；win32 无 exec 位/);
  const noIndexPosix = hookArtifactChecks({ files: a.files, indexMode: () => null, platform: 'linux' });
  assert.equal(noIndexPosix.cases.find((x) => x.name.includes('可执行位（on-disk）')).ok, false, 'POSIX 未入索引时看 on-disk 权限位');
});

test('前提实测（防假绿的事实基础）：Git Bash 里 uname=MINGW64_*、node 自报 win32', {
  // LF-565：该前提只对 Windows 有意义（POSIX 上真 Linux 载体由 L1/L2/L4 直接覆盖，不是被掩盖）
  skip: process.platform !== 'win32' ? 'POSIX 上不存在 Git Bash 前提（真 Linux 载体由 L1/L2/L4 覆盖）' : (!HAS_BASH ? '本机没有 Git Bash' : false),
}, () => {
  const p = gitBashProbe();
  assert.equal(p.available, true);
  assert.match(p.uname, /^MINGW64_NT-/);
  assert.match(p.nodePath, /nodejs\/node$/);
  assert.equal(p.nodePlatform, 'win32');
  assert.equal(p.isWindowsNode, true, 'Git Bash 的 node 就是 Windows node（process.platform 说了算）');
  assert.match(p.bashVersion, /^5\./);
});

test('判据: 探针可注入替身（不依赖本机有没有 Git Bash —— 用例在任何机器上都能跑）', () => {
  const fake = gitBashProbe({
    bashPath: '(fake)',
    run: (args) => {
      const cmd = args.join(' ');
      if (cmd.includes('uname')) return { ok: true, stdout: 'MINGW64_NT-10.0-19044', status: 0, stderr: '', error: null };
      if (cmd.includes('command -v node')) return { ok: true, stdout: '/c/Program Files/nodejs/node', status: 0, stderr: '', error: null };
      if (cmd.includes('process.platform')) return { ok: true, stdout: 'win32', status: 0, stderr: '', error: null };
      return { ok: true, stdout: '5.3.15(2)-release', status: 0, stderr: '', error: null };
    },
  });
  assert.equal(fake.available, true);
  assert.equal(fake.isWindowsNode, true);
  const linuxish = gitBashProbe({ bashPath: '(fake)', run: (args) => ({ ok: true, stdout: args.join(' ').includes('process.platform') ? 'linux' : '/usr/bin/node', status: 0, stderr: '', error: null }) });
  assert.equal(linuxish.isWindowsNode, false, '若 node 自报 linux，才允许认为不是 Windows node');
});

test('red（清单红态）: 把"Git Bash 里 node 能跑"写成 **Linux 验证通过** -> 必红', () => {
  const probe = { available: true, uname: 'MINGW64_NT-10.0-19044', nodePath: '/c/Program Files/nodejs/node', nodePlatform: 'win32' };
  // 单元层：**显式**给定 carrierDone=false 来验证守卫本身（不看本机平台；本机平台只影响默认值）
  const g = fakeLinuxClaimGuard({ claim: 'linux', probe, carrierDone: false });
  assert.equal(g.ok, false);
  assert.equal(g.finding.code, 'CROSSPLAT_FAKE_LINUX_CLAIM');
  assert.match(g.finding.message, /Git Bash 提供的是 \*\*POSIX shell 语义\*\*，不等于 Linux node 运行时/);
  assert.match(g.finding.message, /process\.platform=win32/);
  // 正对照：不宣称就放行；声明"没有该载体"时载体标记为 false 仍判红
  assert.equal(fakeLinuxClaimGuard({}).ok, true);
  assert.equal(fakeLinuxClaimGuard({ claim: 'win32', probe }).ok, true, '声称 win32 不在此守卫范围');
  // LF-565 + 2026-09-16 macOS 实测：载体成立与否 = **本机是不是 Linux**，
  // 不是"非 win32 就是 Linux"—— darwin 上没有 Linux node 载体（用例原来这么写，macOS 首次真跑就红）
  if (process.platform === 'linux') {
    assert.equal(LINUX_CARRIER_DONE, true);
    assert.match(LINUX_CARRIER_REASON, /本机就是 Linux/);
  } else {
    assert.equal(LINUX_CARRIER_DONE, false, `本机平台=${process.platform} 不是 Linux ⇒ 没有 Linux node 载体`);
    assert.match(LINUX_CARRIER_REASON, /没有 Linux node 载体/);
  }
});

test('green/red: `rk-crossplat --hooks` 走 L4；`--claim-linux linux` 必红', { skip: !HAS_BASH ? '本机没有 Git Bash' : false }, () => {
  const isWin = process.platform === 'win32';
  const isLinux = process.platform === 'linux';
  const ok = crossplat(['--project', '.', '--now', '2026-09-14T00:00:00Z', '--hooks']);
  assert.equal(ok.rc, RC.OK, ok.out);
  assert.match(ok.out, /^RK_CROSSPLAT_L4_HOOK_CASES=\d+ L4_HOOK_OK=\d+ L4_RESULT=pass$/m);
  // LF-565 + 2026-09-16 macOS 实测：L4 报的是**本机 bash/node 的事实** —— "非 win32"不等于 Linux
  // （macOS 上 uname=Darwin、node 自报 darwin；原先的 else 分支按 Linux 断言，macOS 首次真跑即红）
  const expectUname = isWin ? 'MINGW64_NT-\\S*' : (process.platform === 'darwin' ? 'Darwin' : 'Linux');
  assert.match(ok.out, new RegExp(`^RK_CROSSPLAT_L4_BASH_UNAME=${expectUname}$`, 'm'));
  assert.match(ok.out, new RegExp(`^RK_CROSSPLAT_L4_BASH_NODE_PLATFORM=${process.platform}$`, 'm'));
  assert.match(ok.out, new RegExp(`^RK_CROSSPLAT_L4_IS_WINDOWS_NODE=${isWin}$`, 'm'));
  assert.match(ok.out, new RegExp(`^RK_CROSSPLAT_LINUX_CARRIER_DONE=${isLinux}$`, 'm'));
  assert.match(ok.out, /^RK_CROSSPLAT_RESULT=pass$/m);
  const bad = crossplat(['--project', '.', '--now', '2026-09-14T00:00:00Z', '--hooks', '--claim-linux', 'linux']);
  if (isLinux) {
    // 本机真是 Linux：声明成立 ⇒ 不判红（防假绿的反面：也不许把真话判成假话）
    assert.equal(bad.out.includes('CROSSPLAT_FAKE_LINUX_CLAIM'), false, bad.out);
  } else {
    // win32/darwin 上声称"Linux 验证通过"都是假声明 ⇒ 必红
    assert.equal(bad.rc, RC.FAIL, bad.out);
    assert.match(bad.out, /^FINDING CROSSPLAT_FAKE_LINUX_CLAIM /m);
    assert.match(bad.out, /^RK_CROSSPLAT_RESULT=fail$/m);
  }
  // 默认（不带 --hooks）不跑 L4：老口径的输出保持原样（不破坏 LF-2D0 的凭证语义）
  const plain = crossplat(['--project', '.', '--now', '2026-09-14T00:00:00Z']);
  assert.equal(plain.rc, RC.OK);
  assert.equal(/RK_CROSSPLAT_L4_/.test(plain.out), false, '不带 --hooks 不应出现 L4 行');
});

test('判据: 文件级比对器（Linux 侧 `sha256sum` 的对账口径）—— 一致 / 缺文件 / 内容不符 / 多文件', () => {
  const dir = tempDir('lf560-manifest');
  mkdirSync(join(dir, 'pkg', 'src'), { recursive: true });
  writeFileSync(join(dir, 'pkg', 'src', 'a.mjs'), 'export const a = 1;\n', 'utf8');
  writeFileSync(join(dir, 'pkg', 'b.txt'), 'b\n', 'utf8');
  const rows = fileHashManifest(join(dir, 'pkg'), ['src/a.mjs', 'b.txt']);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].relPath, 'b.txt', '按码位排序（跨平台稳定）');
  const remote = rows.map((r) => `${r.sha256}  ${r.relPath}`).join('\n');
  const same = compareFileHashes(rows, remote);
  assert.equal(same.ok, true);
  assert.deepEqual([same.localCount, same.remoteCount], [2, 2]);
  const missing = compareFileHashes(rows, `${rows[1].sha256}  ${rows[1].relPath}`);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ['b.txt']);
  const mismatch = compareFileHashes(rows, `${'0'.repeat(64)}  b.txt\n${rows[1].sha256}  src/a.mjs`);
  assert.equal(mismatch.ok, false, 'sha 不符必须判不通过');
  assert.equal(mismatch.mismatched[0].relPath, 'b.txt');
  const extra = compareFileHashes(rows, `${remote}\n${'1'.repeat(64)}  ghost.txt`);
  assert.equal(extra.ok, false);
  assert.deepEqual(extra.extra, ['ghost.txt']);
  // sha256sum 的 `*` 标记形式（二进制模式）与 `./` 前缀也要能解析
  const starred = compareFileHashes(rows, rows.map((r) => `${r.sha256} *./${r.relPath}`).join('\n'));
  assert.equal(starred.ok, true);
});

test('判据: 本地清单只收"存在且是文件"的路径（缺文件不静默算通过）', () => {
  const dir = tempDir('lf560-missing');
  writeFileSync(join(dir, 'only.txt'), 'x\n', 'utf8');
  const rows = fileHashManifest(dir, ['only.txt', 'nope.txt']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].relPath, 'only.txt');
});

test('usage: `--hooks` 之外的参数照旧；未知 flag 仍 rc=2', () => {
  assert.equal(crossplat(['--project', '.', '--bogus']).rc, RC.USAGE);
  assert.equal(crossplat(['--project', '.', '--now', '不是时间']).rc, RC.USAGE);
  assert.equal(crossplat(['--help']).rc, RC.OK);
});

test('判据: L4 检查的生成物是真 install 出来的（不是硬编码字符串）—— 形态与安装器同源', { skip: !HAS_BASH ? '本机没有 Git Bash' : false }, () => {
  // 直接看 CLI 那条路径的结果：临时仓里 install 出来的三个文件都过了形态检查
  const out = crossplat(['--project', '.', '--hooks', '--json']);
  assert.equal(out.rc, RC.OK, out.out);
  const j = JSON.parse(out.out);
  assert.equal(j.l4.ok, true);
  const names = j.l4.cases.map((c) => c.name);
  assert.ok(names.includes('.githooks/pre-commit 有 shebang'));
  assert.ok(names.includes('.githooks/post-commit 有 shebang'));
  assert.ok(names.includes('.dsh-ai/rulekeeper/hook.mjs 无 BOM'));
  assert.equal(/(^|[^A-Za-z])[A-Za-z]:[\\/]/.test(out.out), false, '判决类输出不得含盘符绝对路径（清单 ㉒）');
});

test('判据: probe 的 bash 路径可注入（`--bash`）且默认值是 Git Bash 标准路径；判决输出里不出现该绝对路径（㉒）', () => {
  // LF-565：默认 shell **平台自适应**（Windows=Git Bash 标准位置；POSIX=PATH 里的 bash）
  const EXPECT_DEFAULT = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
  assert.equal(GIT_BASH_DEFAULT, EXPECT_DEFAULT);
  const r = crossplat(['--project', '.', '--hooks', '--bash', GIT_BASH_DEFAULT, '--json']);
  const j = JSON.parse(r.out);
  assert.equal(j.l4.bash.name, process.platform === 'win32' ? 'bash.exe' : 'bash');
  assert.equal(j.l4.bash.present, true);
  assert.equal(/(^|[^A-Za-z])[A-Za-z]:[\\/]/.test(r.out), false, '只报"是不是 bash / 什么版本"，不放盘符绝对路径');
  const t = crossplat(['--project', '.', '--hooks', '--bash', GIT_BASH_DEFAULT]);
  assert.match(t.out, new RegExp(`^RK_CROSSPLAT_L4_BASH_PRESENT=true L4_BASH_NAME=${process.platform === 'win32' ? 'bash\\.exe' : 'bash'}$`, 'm'));
  assert.equal(/(^|[^A-Za-z])[A-Za-z]:[\\/]/.test(t.out), false);
});
