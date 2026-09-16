// dsh-rulekeeper · LF-2D0 跨平台三层判据（L1 结构 / L2 归一文本 / L3-Windows 逐字 + L3 跨平台**如实声明不做**）
//
// 红态判据（清单 §3 LF-2D0 原文）：**去掉 `--now` 或不做路径归一 → L2 必红**。
// 这里把"不做归一"与"时间戳不归一"两条都做成**可复现的红**，另加 L1 的四个注入式红
// （import 大小写 / import 目标缺失 / 依赖非空 / BOM·CRLF），以及防假绿守卫（声称 linux）。
//
// 仪器自检（L482 的教训）：判据里的"比对器"本身必须先被正对照证明有效——所以
//   · `verifyComparator()` 里"差 1 字节"必须判不同、"只差 CR/斜杠/前缀"必须判相同；
//   · 真包上 `RAW_DIFF_LINES > 0`：**未归一时必须真有差异**，否则"归一"这一步在判据里就是摆设（假绿）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runCrossplat } from '../src/cli.mjs';
import {
  compareNormalized, fakePlatformGuard, injectedEolCases, injectedPureFunctionCases,
  normalizeOutput, readNormalized, simulateOtherSide, structuralChecks, verifyComparator,
  windowsByteIdentical,
} from '../src/crossplat.mjs';
import { RC } from '../src/rc.mjs';
import { cleanupAll, copyPkg } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const PKG = join(import.meta.dirname, '..');

function capture(fn) {
  let out = '';
  let err = '';
  const rc = fn({ out: (t) => { out += String(t); }, err: (t) => { err += String(t); } });
  return { rc, out, err };
}

const crossplat = (args) => capture((io) => runCrossplat(args, io, {}));

/** 从 KEY=VALUE 行里取值（输出面向人眼，仍要能被判据读） */
function field(out, key) {
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(out);
  return m ? m[1] : null;
}

test('green: 真包 L1 结构全过（LF 无 BOM / 零依赖 / type=module / engines / import 大小写与存在性）', () => {
  const l1 = structuralChecks({ pkgRoot: PKG });
  assert.deepEqual(l1.findings, []);
  assert.equal(l1.ok, true);
  assert.ok(l1.files > 50, `应有 50+ 个 .mjs，实得 ${l1.files}`);
  assert.deepEqual(l1.crlfFiles, []);
  assert.deepEqual(l1.bomFiles, []);
  assert.deepEqual(l1.caseMismatches, []);
  assert.deepEqual(l1.missingImports, []);
  assert.deepEqual(l1.dependencies, []);
  assert.equal(l1.type, 'module');
  assert.equal(typeof l1.engines.node, 'string');
});

test('green: rk-crossplat 真包 exit=0，三层都过，且**未归一时确有差异**（证明归一不是摆设）', () => {
  const r = crossplat(['--project', '.', '--now', '2026-09-14T00:00:00Z']);
  assert.equal(r.rc, RC.OK, r.out);
  assert.equal(field(r.out, 'RK_CROSSPLAT_L1_RESULT'), 'pass');
  assert.equal(field(r.out, 'RK_CROSSPLAT_L2_RESULT'), 'pass');
  assert.equal(field(r.out, 'RK_CROSSPLAT_L2_NORMALIZE'), 'on');
  assert.equal(field(r.out, 'RK_CROSSPLAT_L2_NORMALIZED_DIFF_LINES'), '0');
  const raw = Number(field(r.out, 'RK_CROSSPLAT_L2_RAW_DIFF_LINES'));
  assert.ok(raw > 0, `未归一时必须真有差异（否则 L2 的归一步骤是摆设），实得 ${raw}`);
  assert.equal(field(r.out, 'RK_CROSSPLAT_L3_WINDOWS_IDENTICAL'), 'true');
  assert.equal(field(r.out, 'RK_CROSSPLAT_COMPARATOR_SELFTEST'), 'pass CASES=5');
  assert.equal(field(r.out, 'RK_CROSSPLAT_RESULT'), 'pass');
  assert.equal(field(r.out, 'RK_CROSSPLAT_L3_CROSS_DONE'), 'false', 'L3 跨平台必须如实声明不做');
});

test('red: 不做归一（--no-normalize）→ L2 必红、exit=1、FINDING 里带差异行号', () => {
  const r = crossplat(['--project', '.', '--now', '2026-09-14T00:00:00Z', '--no-normalize']);
  assert.equal(r.rc, RC.FAIL, r.out);
  assert.equal(field(r.out, 'RK_CROSSPLAT_L2_NORMALIZE'), 'off');
  assert.equal(field(r.out, 'RK_CROSSPLAT_L2_RESULT'), 'fail');
  assert.match(r.out, /^FINDING CROSSPLAT_L2_DIFF /m);
  assert.equal(field(r.out, 'RK_CROSSPLAT_L1_RESULT'), 'pass', '红只应出现在 L2，L1 不受影响');
});

test('red: 时间戳不在归一面内（--inject-now-diff）→ L2 必红（等于"去掉 --now"的等价证据）', () => {
  const r = crossplat(['--project', '.', '--now', '2026-09-14T00:00:00Z', '--inject-now-diff']);
  assert.equal(r.rc, RC.FAIL, r.out);
  assert.equal(field(r.out, 'RK_CROSSPLAT_L2_RESULT'), 'fail');
  assert.ok(Number(field(r.out, 'RK_CROSSPLAT_L2_NORMALIZED_DIFF_LINES')) > 0, '时间戳差异不得被归一吃掉');
  assert.match(r.out, /^FINDING CROSSPLAT_L2_DIFF /m);
});

test('red: 声称在 linux 上验证过 → 防假绿守卫判红（**除本机真是 linux 外**）', () => {
  // LF-565：本机**真是 Linux** 时，"我在 linux 上验证过"是真话 —— 判红反而成了假红（防假绿不等于把真话判假）。
  // 2026-09-16 macOS 首次真跑 CI 补的洞：原先写成 win32 / **else** 二分 ⇒ 把 darwin 当成"就是 linux"，
  // 于是 macOS 上"假声明"被当成"真话"（错的是**用例的判据**，产品侧 fakePlatformGuard 一直在如实判红）。
  const claimIsTrue = process.platform === 'linux';
  const r = crossplat(['--project', '.', '--claim-platform', 'linux']);
  assert.equal(r.out.includes('CROSSPLAT_FAKE_PLATFORM_CLAIM'), !claimIsTrue,
    `本机平台=${process.platform}：假声明必须判红、真话不得判红\n${r.out}`);
  if (!claimIsTrue) {
    assert.equal(r.rc, RC.FAIL, r.out);
    assert.match(r.out, /^FINDING CROSSPLAT_FAKE_PLATFORM_CLAIM /m);
  }
  // 判据本身与"平台二分"无关 —— 三平台各断言一遍（darwin 那条就是 CI 里真跑到的那条）
  assert.equal(fakePlatformGuard({ claim: 'linux', platform: 'win32' }).ok, false);
  assert.equal(fakePlatformGuard({ claim: 'linux', platform: 'darwin' }).ok, false, 'darwin 上声称 linux 同样是假声明');
  assert.equal(fakePlatformGuard({ claim: 'linux', platform: 'linux' }).ok, true, '真话必须放行');
  assert.equal(fakePlatformGuard({ claim: 'win32', platform: 'win32' }).ok, true);
  assert.equal(fakePlatformGuard({}).ok, true, '不声称就放行');
});

test('red: 注入 import 大小写不符 → CROSSPLAT_IMPORT_CASE（Windows 不敏感、Linux 敏感的经典假绿）', () => {
  const pkg = copyPkg('cp-case');
  writeFileSync(
    join(pkg, 'src', 'case-probe.mjs'),
    "import { RC } from './RC.mjs';\nexport default RC;\n",
    'utf8',
  );
  const l1 = structuralChecks({ pkgRoot: pkg });
  assert.equal(l1.ok, false);
  const f = l1.findings.find((x) => x.code === 'CROSSPLAT_IMPORT_CASE');
  assert.ok(f, `应报 CROSSPLAT_IMPORT_CASE，实得 ${JSON.stringify(l1.findings.map((x) => x.code))}`);
  assert.match(f.message, /rc\.mjs/);
  assert.equal(l1.caseMismatches.length, 1);
});

test('red: 注入 import 目标不存在 → CROSSPLAT_IMPORT_MISSING', () => {
  const pkg = copyPkg('cp-missing');
  writeFileSync(
    join(pkg, 'src', 'missing-probe.mjs'),
    "import { ghost } from './ghost-module.mjs';\nexport default ghost;\n",
    'utf8',
  );
  const l1 = structuralChecks({ pkgRoot: pkg });
  assert.equal(l1.ok, false);
  assert.ok(l1.findings.some((x) => x.code === 'CROSSPLAT_IMPORT_MISSING'));
});

test('red: 注入依赖 / 非 module / BOM / CRLF → 各自判红', () => {
  const pkg = copyPkg('cp-deps');
  const pkgPath = join(pkg, 'package.json');
  const json = JSON.parse(readFileSync(pkgPath, 'utf8'));
  json.dependencies = { 'left-pad': '1.3.0' };
  json.type = 'commonjs';
  delete json.engines;
  writeFileSync(pkgPath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
  mkdirSync(join(pkg, 'src'), { recursive: true });
  writeFileSync(join(pkg, 'src', 'bom-probe.mjs'), '\ufeffexport const b = 1;\n', 'utf8');
  writeFileSync(join(pkg, 'src', 'crlf-probe.mjs'), 'export const c = 1;\r\nexport const d = 2;\r\n', 'utf8');
  const codes = structuralChecks({ pkgRoot: pkg }).findings.map((x) => x.code);
  for (const want of ['CROSSPLAT_DEPS_NOT_EMPTY', 'CROSSPLAT_TYPE_NOT_MODULE', 'CROSSPLAT_ENGINES_MISSING', 'CROSSPLAT_BOM_FILE', 'CROSSPLAT_CRLF_FILE']) {
    assert.ok(codes.includes(want), `应报 ${want}，实得 ${JSON.stringify(codes)}`);
  }
});

test('green: 比对仪器正对照 —— 差 1 字节必被发现；只差 CR / 斜杠 / 绝对前缀必判相同', () => {
  const v = verifyComparator();
  assert.equal(v.ok, true, JSON.stringify(v.cases));
  assert.equal(v.cases.length, 5);
  const oneByte = v.cases.find((c) => c.name.includes('差 1 字节'));
  assert.equal(oneByte.expectIdentical, false);
  assert.equal(oneByte.actualIdentical, false, '差 1 字节被判相同 = 比对器失效');
  for (const name of ['只差 CRLF vs LF', '只差反斜杠 vs 正斜杠', '只差绝对前缀']) {
    const c = v.cases.find((x) => x.name.includes(name));
    assert.equal(c.actualIdentical, true, `${name} 应判相同`);
  }
});

test('green: 归一函数本身可被单独验证（CR / 反斜杠 / 绝对前缀三件事）', () => {
  assert.equal(normalizeOutput('a\r\nb\r\n'), 'a\nb\n');
  assert.equal(normalizeOutput('C:\\p\\x\n', { roots: ['C:\\p'] }), '<ABS>/x\n');
  assert.equal(normalizeOutput('C:/p/x\n', { roots: ['C:\\p'] }), '<ABS>/x\n', '根写法不同也必须吸掉');
  assert.equal(compareNormalized('x\r\n', 'x\n').identical, true);
  assert.equal(compareNormalized('x\n', 'y\n').identical, false);
  assert.equal(compareNormalized('x\n', 'y\n').diff.length, 1);
});

test('green: 模拟"另一平台侧"确实改变了文本（否则 L2 归一是空转）', () => {
  const side = simulateOtherSide('LF=P=C:\\proj\\a.mjs\n', { root: 'C:\\proj' });
  assert.match(side, /\r\n/, '另一侧应带 CRLF');
  assert.match(side, /<LINUX_ROOT>\/a\.mjs/);
  assert.notEqual(side, 'LF=P=C:\\proj\\a.mjs\n');
});

test('green: 注入式双写法纯函数层 + EOL 语义层全过', () => {
  const pure = injectedPureFunctionCases();
  assert.equal(pure.allEqual, true, JSON.stringify(pure.cases.filter((c) => !c.ok)));
  assert.equal(pure.cases.length, 6);
  const eol = injectedEolCases();
  assert.equal(eol.allOk, true, JSON.stringify(eol.cases.filter((c) => !c.ok)));
  assert.equal(eol.cases.length, 4);
  // 已知口径必须被**显式断言**（不假装两边完全相等）
  const maxLine = eol.cases.find((c) => c.name.includes('maxLineLength'));
  assert.match(maxLine.detail, /^\d+ vs \d+$/);
});

test('green: L3-Windows 逐字 —— 同命令两次相同为真、不同为假', () => {
  assert.equal(windowsByteIdentical({ run: () => 'A\r\nB\n' }).identical, true);
  const diff = windowsByteIdentical({ run: (() => { let i = 0; return () => `run${i += 1}`; })() });
  assert.equal(diff.identical, false, '两次输出不同必须判不同');
  assert.equal(diff.shas[0] === diff.shas[1], false);
});

test('green: readNormalized 读不到文件时 ok=false（不静默当空文件）', () => {
  const miss = readNormalized(join(PKG, 'no-such-file-xyz.txt'), [PKG]);
  assert.equal(miss.ok, false);
  assert.equal(miss.text, null);
  const ok = readNormalized(join(PKG, 'package.json'), [PKG]);
  assert.equal(ok.ok, true);
  assert.equal(ok.text.includes(PKG), false, '绝对前缀必须已被吸掉');
});

test('usage: 无参数与非法 flag → rc=2 且打印用法', () => {
  const noArgs = crossplat([]);
  assert.equal(noArgs.rc, RC.USAGE);
  assert.match(noArgs.out, /用法: rk-crossplat/);
  const bad = crossplat(['--project', '.', '--now', '不是时间']);
  assert.equal(bad.rc, RC.USAGE);
  assert.match(bad.err, /--now 不是合法时间/);
  const unknown = crossplat(['--project', '.', '--bogus']);
  assert.equal(unknown.rc, RC.USAGE);
});
