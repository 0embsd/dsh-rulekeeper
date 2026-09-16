// dsh-rulekeeper · LF-150 用例：反向红脚手架的**仪器自检** + fixture 驱动的正/反样本
//
// 关键纪律（清单 §6 规则 3 + §9.6 R3）：判据必须自带反向红。
// 本文件先证明"脚手架自己会红"（前 4 例），再用固定 fixture 驱动真实检查器（后 4 例）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { assertGreen, assertRed, RedAssertionError } from './helpers/red.mjs';
import { cleanupAll, copyPkg, freshProject, readFixture } from './helpers/sandbox.mjs';
import { checkSkeleton, collectSpecifiers, toCode } from '../src/selfcheck.mjs';
import { ensureLanding } from '../src/config.mjs';

test.after(cleanupAll);

/** 把 checkSkeleton 的报告折叠成 CLI 同形的 {code, out}（判据载体与真实入口一致） */
function asRun(report) {
  const findings = report.findings.map((f) => `FINDING ${f.code} ${f.msg}`).join('\n');
  const tail = `RK_SELFCHECK_RESULT=${report.ok ? 'pass' : 'fail'}`;
  return { code: report.ok ? 0 : 1, out: `${findings}\n${tail}`.trim() };
}

/** 造一个受控的"包副本 + 临时项目 + 临时 DSH_HOME"，可按 fixture 覆盖 package.json / config.json */
function staged({ packageFixture, configFixture } = {}) {
  const pkg = copyPkg('stage');
  if (packageFixture !== undefined) {
    writeFileSync(join(pkg, 'package.json'), readFixture(packageFixture), 'utf8');
  }
  const { projectRoot, env } = freshProject('stage');
  ensureLanding({ projectRoot, env });
  if (configFixture !== undefined) {
    writeFileSync(join(projectRoot, '.dsh-ai', 'rulekeeper', 'config.json'), readFixture(configFixture), 'utf8');
  }
  return { pkg, projectRoot, env, run: () => asRun(checkSkeleton(pkg, { projectRoot, env })) };
}

// ── ① 仪器自检：脚手架自己必须会红 ────────────────────────────────────
test('仪器自检：assertRed 喂合规样本（exit=0）必须报「未红」', () => {
  assert.throws(
    () => assertRed(() => ({ code: 0, out: 'RK_SELFCHECK_RESULT=pass' }), { want: 'FINDING', name: '合规样本' }),
    /未红/,
  );
});

test('仪器自检：样本红了但缺预期标记，必须报「红信号不符」', () => {
  assert.throws(
    () => assertRed(() => ({ code: 1, out: 'FINDING S9_OTHER boom' }), { want: 'S1_DEPENDENCIES', name: '错标记样本' }),
    /红信号不符/,
  );
});

test('仪器自检：assertGreen 喂红样本必须报「未绿」', () => {
  assert.throws(() => assertGreen(() => ({ code: 1, out: 'FINDING X' }), { name: '红样本' }), /未绿/);
});

test('仪器自检：thunk 返回非 {code,out} 必须报「必须返回」', () => {
  assert.throws(() => assertRed(() => 'pass'), /必须返回/);
  assert.throws(() => assertRed(() => 'pass'), RedAssertionError);
});

// ── ② fixture 驱动：package.json ────────────────────────────────────
test('fixture：package-bad-deps.json → 红 S1_DEPENDENCIES', () => {
  const s = staged({ packageFixture: 'package-bad-deps.json' });
  assertRed(s.run, { want: 'S1_DEPENDENCIES', name: 'package-bad-deps.json' });
});

test('fixture：package-ok.json → 绿（无 finding）', () => {
  const s = staged({ packageFixture: 'package-ok.json' });
  assertGreen(s.run, { want: 'RK_SELFCHECK_RESULT=pass', name: 'package-ok.json' });
});

// ── ③ fixture 驱动：落点 config ─────────────────────────────────────
test('fixture：config-bad-mode.json → 红 S3_CONFIG_INVALID', () => {
  const s = staged({ configFixture: 'config-bad-mode.json' });
  assertRed(s.run, { want: 'S3_CONFIG_INVALID', name: 'config-bad-mode.json' });
});

test('fixture：config-ok.json → 绿', () => {
  const s = staged({ configFixture: 'config-ok.json' });
  assertGreen(s.run, { want: 'RK_SELFCHECK_RESULT=pass', name: 'config-ok.json' });
});

// ── ④ fixture 驱动：导入样本（落在包内新文件上，避开"检查器自身导入图"边界） ──
test('fixture：imports-bad → 红 S4_BARE_IMPORT + S4_CJS_REQUIRE', () => {
  const s = staged();
  writeFileSync(join(s.pkg, 'src', 'probe-imports-bad.mjs'), readFixture('imports-bad.mjs.txt'), 'utf8');
  assertRed(s.run, { want: 'S4_BARE_IMPORT', name: 'imports-bad' });
  assertRed(s.run, { want: 'S4_CJS_REQUIRE', name: 'imports-bad(require)' });
});

test('fixture：imports-ok → 绿；且扫描器对干扰项不误报', () => {
  const s = staged();
  writeFileSync(join(s.pkg, 'src', 'probe-imports-ok.mjs'), readFixture('imports-ok.mjs.txt'), 'utf8');
  assertGreen(s.run, { want: 'RK_SELFCHECK_RESULT=pass', name: 'imports-ok' });
  const specs = collectSpecifiers(toCode(readFixture('imports-ok.mjs.txt')));
  assert.deepEqual(specs.sort(), ['./config.mjs', './renamed.mjs', 'node:fs']);
});
