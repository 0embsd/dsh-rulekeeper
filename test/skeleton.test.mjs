// dsh-rulekeeper · LF-100 骨架自检的**先红后绿**测试（清单 §6 规则 3：判据三要件）
//
// 设计要点：
//   1. 全部用例**只碰临时目录**（os.tmpdir()），不改本机真实落点、不改仓库文件 —— 可反复运行
//   2. 红态用"注入违规的临时副本"证明，绿态用"真实包根 + 临时项目/临时 DSH_HOME"证明
//   3. 零依赖：只用 node:*（node:test / node:assert）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureLanding, loadConfig } from '../src/config.mjs';
import { checkSkeleton } from '../src/selfcheck.mjs';

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLEANUPS = [];

function makeTemp(label) {
  const dir = mkdtempSync(join(tmpdir(), `lf-100-${label}-`));
  CLEANUPS.push(dir);
  return dir;
}

/** 造一个"全新项目 + 全新 DSH_HOME"的隔离环境 */
function freshEnv(label) {
  const projectRoot = makeTemp(`${label}-proj`);
  const home = makeTemp(`${label}-home`);
  return { projectRoot, env: { ...process.env, DSH_HOME: home } };
}

/** 拷贝一份包到临时目录，用于注入违规（不动真实包） */
function copyPkg(label) {
  const dst = join(makeTemp(label), 'pkg');
  cpSync(PKG_ROOT, dst, { recursive: true });
  return dst;
}

test.after(() => {
  for (const dir of CLEANUPS) rmSync(dir, { recursive: true, force: true });
});

test('red: 落点缺失 → S3_LANDING_MISSING（先证"条件不满足时判据会红"）', () => {
  const { projectRoot, env } = freshEnv('red-landing');
  const report = checkSkeleton(PKG_ROOT, { projectRoot, env });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((f) => f.code === 'S3_LANDING_MISSING'));
});

test('green: ensureLanding 后自检通过，且默认 mode === observe', () => {
  const { projectRoot, env } = freshEnv('green-init');
  const { dirs, created } = ensureLanding({ projectRoot, env });
  assert.equal(created.length, 2);
  for (const dir of [dirs.project, dirs.user]) {
    const cfg = join(dir, 'config.json');
    assert.ok(existsSync(cfg), `应存在 ${cfg}`);
    assert.equal(JSON.parse(readFileSync(cfg, 'utf8')).mode, 'observe');
  }
  const report = checkSkeleton(PKG_ROOT, { projectRoot, env });
  assert.deepEqual(report.findings, []);
  assert.equal(report.ok, true);
});

test('green: ensureLanding 幂等 —— 已存在的 config.json 不被覆盖（mode 保护）', () => {
  const { projectRoot, env } = freshEnv('idempotent');
  const { dirs } = ensureLanding({ projectRoot, env });
  const cfg = join(dirs.project, 'config.json');
  writeFileSync(cfg, `${JSON.stringify({ schema: 1, mode: 'armed' }, null, 2)}\n`, 'utf8');
  const second = ensureLanding({ projectRoot, env });
  assert.deepEqual(second.created, []);
  assert.equal(second.kept.length, 2);
  assert.equal(JSON.parse(readFileSync(cfg, 'utf8')).mode, 'armed');
});

test('red: config mode 非法 → S3_CONFIG_INVALID', () => {
  const { projectRoot, env } = freshEnv('red-mode');
  ensureLanding({ projectRoot, env });
  const { dirs } = ensureLanding({ projectRoot, env });
  writeFileSync(join(dirs.project, 'config.json'), `${JSON.stringify({ schema: 1, mode: 'yolo' })}\n`, 'utf8');
  const report = checkSkeleton(PKG_ROOT, { projectRoot, env });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((f) => f.code === 'S3_CONFIG_INVALID'));
  assert.throws(() => loadConfig(dirs.project), /mode 必须是/);
});

test('red: 注入 dependencies → S1_DEPENDENCIES（零依赖红线）', () => {
  const pkg = copyPkg('red-dep');
  const { projectRoot, env } = freshEnv('red-dep');
  ensureLanding({ projectRoot, env });
  const pkgPath = join(pkg, 'package.json');
  const pkgJson = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkgJson.dependencies = { 'left-pad': '1.3.0' };
  writeFileSync(pkgPath, `${JSON.stringify(pkgJson, null, 2)}\n`, 'utf8');
  const report = checkSkeleton(pkg, { projectRoot, env });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((f) => f.code === 'S1_DEPENDENCIES'));
});

test('green: 仪器回归 —— 注释/字符串/模板/正则字面量里的 require( 与 from 不得误报（含 2 个正对照）', () => {
  const pkg = copyPkg('instrument');
  const { projectRoot, env } = freshEnv('instrument');
  ensureLanding({ projectRoot, env });
  const probe = join(pkg, 'src', 'probe-clean.mjs');
  const tricky = [
    "// 说明：真 require('x') 会被抓，正则字面量 /\\brequire\\s*\\(/ 不该命中",
    "/* 块注释里的 import x from 'ghost-pkg' 不该命中 */",
    'export const RE = /\\brequire\\s*\\(/;',
    'export const S = "from \'ghost-pkg\'";',
    "export const T = `require('ghost-pkg')`;",
    "export const MODES_FP = Object.freeze(['observe', 'armed']);",
    "export const NAME_FP = 'config.json';",
    "import ok from 'node:path';",
    "import rel from './config.mjs';",
    "export * from './renamed.mjs';",
  ].join('\n') + '\n';
  writeFileSync(probe, tricky, 'utf8');
  // S9（模块接线检查）落地后：往 src/ 丢一个**没人 import** 的模块本身就是违规 —— 探针必须接上线，
  // 否则本用例的"全绿"断言会被 S9 撕掉（而它想验的是 S4 不误报，不是 S9 有白名单）。
  appendFileSync(join(pkg, 'src', 'cli.mjs'), "import './probe-clean.mjs';\n", 'utf8');
  assert.deepEqual(checkSkeleton(pkg, { projectRoot, env }).findings, [], '非代码文本不得触发 S4');

  // 正对照 1：真 require('…') 必须报红（否则"不报"只是恒真）
  writeFileSync(probe, `${tricky}const x = require('left-pad');\nexport default x;\n`, 'utf8');
  assert.ok(
    checkSkeleton(pkg, { projectRoot, env }).findings.some((f) => f.code === 'S4_CJS_REQUIRE'),
    '真 require 必须报红',
  );

  // 正对照 2：真裸导入必须报红
  writeFileSync(probe, `${tricky}import bad from 'left-pad';\nexport default bad;\n`, 'utf8');
  assert.ok(
    checkSkeleton(pkg, { projectRoot, env }).findings.some((f) => f.code === 'S4_BARE_IMPORT'),
    '真裸导入必须报红',
  );
});

test('red: 注入裸导入 → S4_BARE_IMPORT', () => {
  const pkg = copyPkg('red-import');
  const { projectRoot, env } = freshEnv('red-import');
  ensureLanding({ projectRoot, env });
  const target = join(pkg, 'src', 'config.mjs');
  writeFileSync(target, `${readFileSync(target, 'utf8')}\nimport leftPad from 'left-pad';\n`, 'utf8');
  const report = checkSkeleton(pkg, { projectRoot, env });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((f) => f.code === 'S4_BARE_IMPORT'));
});
