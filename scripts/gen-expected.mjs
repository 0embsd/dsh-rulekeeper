#!/usr/bin/env node
// dsh-rulekeeper · LF-250/LF-260 基准再生成器（**唯一**入口，两样东西一起管）
//
//   ① `test/fixtures/expected/*.json` —— 判决的"逐字基准"（只能由判决输出本身生成）
//   ② `test/fixtures/checks/shape-baseline.json` —— 形态守卫的"冻结源"（file -> lines/maxLineLength/bytes/sha256）
//
// 为什么必须存在：
//   · 踩过的坑：曾用 PowerShell `Out-File` 生成 → 文件里全是 CRLF，肉眼完全看不出，逐字比对却全红。
//     故基准一律由本脚本用 Node **LF** 写出，并在写盘前断言"判决输出不含 CR"。
//   · 复核实测（LF-250 复核 B4）：旧实现没有任何"冻结值"实体，`rk-check shape` 不传 `--sha256` 时
//     等长内容漂移会**静默 pass** —— 宣称的"夹具冻结副本 + sha256"没有物。故冻结源必须落盘、入库、
//     与夹具同批再生成；缺记录 = `SHAPE_NO_FROZEN_SHA`（没有冻结值不算通过）。
//
// 用法: node scripts/gen-expected.mjs [--check] [--baseline]
//   --check    : 只比对不写盘；基准或冻结源有漂移则 exit 1（供门禁用）
//   --baseline : 只（重）生成冻结源 shape-baseline.json（改夹具后同步阈值用）

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runCheck } from '../src/cli.mjs';
import { PKG_ROOT, measureFile, shapeBaselineKey, SHAPE_BASELINE_PATH } from '../src/checks.mjs';
import { CHECK_CASES, EXPECTED_DIR, UNCHECKABLE_CASES, expectedPathOf } from '../test/helpers/check-cases.mjs';

const checkOnly = process.argv.includes('--check');
const baselineOnly = process.argv.includes('--baseline');
let failed = 0;

function render(args) {
  let out = '';
  const rc = runCheck([...args, '--json'], { out: (t) => { out += String(t); }, err: () => {} }, {});
  return { rc, out };
}

// ── ① 逐字基准 ────────────────────────────────────────────────────────────────
if (!baselineOnly) {
  mkdirSync(EXPECTED_DIR, { recursive: true });
  let drifted = 0;
  const ALL_CASES = [...CHECK_CASES, ...UNCHECKABLE_CASES];
  for (const item of ALL_CASES) {
    const { rc, out } = render(item.args);
    if (rc !== item.rc) {
      console.error(`[gen-expected] ${item.name}: exit ${rc} != 期望 ${item.rc}`);
      process.exit(1);
    }
    if (out.includes('\r')) {
      console.error(`[gen-expected] ${item.name}: 判决输出含 CR —— 基准必须纯 LF`);
      process.exit(1);
    }
    // 判决里禁绝对路径（复核 B1：曾因 cwd 泄漏绝对路径，换目录跑输出就变）
    if (/^[a-zA-Z]:\//m.test(out) || out.includes(PKG_ROOT.replace(/\\/g, '/'))) {
      console.error(`[gen-expected] ${item.name}: 判决含绝对路径 —— 基准必须与机器无关`);
      process.exit(1);
    }
    const path = expectedPathOf(item.name);
    if (checkOnly) {
      const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
      if (current !== out) drifted += 1;
      console.log(`[gen-expected] ${item.name}: ${current === out ? 'identical' : (current === null ? '缺少基准' : 'DRIFTED')}`);
    } else {
      writeFileSync(path, out, 'utf8');
      console.log(`[gen-expected] ${item.name}: rc=${rc} bytes=${Buffer.byteLength(out, 'utf8')} -> ${path}`);
    }
  }
  if (checkOnly && drifted > 0) {
    console.error(`[gen-expected] 有 ${drifted} 份基准漂移/缺失：跑 node scripts/gen-expected.mjs 再复核`);
    failed += 1;
  }
  if (!checkOnly) console.log(`[gen-expected] 已写出 ${ALL_CASES.length} 份逐字基准`);
}

// ── ② 形态冻结源 ──────────────────────────────────────────────────────────────
// 登记对象：形态守卫的通用夹具（output-shape 两例）。其它文件（真实样本）由调用方显式给 --sha256。
const BASELINE_FILES = [
  'test/fixtures/checks/output-shape-ok.txt',
  'test/fixtures/checks/output-shape-violation.txt',
];
{
  const fixtures = {};
  for (const rel of BASELINE_FILES) {
    const abs = join(PKG_ROOT, rel);
    if (!existsSync(abs)) {
      console.error(`[gen-expected] 冻结源登记的文件不存在: ${rel}`);
      process.exit(1);
    }
    const m = measureFile(abs);
    fixtures[shapeBaselineKey(abs) ?? rel] = { lines: m.lines, maxLineLength: m.maxLineLength, bytes: m.bytes, sha256: m.sha256 };
  }
  const doc = {
    schema: 'dsh-rulekeeper.shape-baseline/1',
    note: 'LF-260 形态守卫的冻结源：rk-check shape / dsh-rulekeeper check --shape 未显式给 --sha256 时从这里取。'
      + '改了夹具必须跑 node scripts/gen-expected.mjs --baseline 同步，否则报 SHAPE_FIXTURE_DRIFT。'
      + '键 = 相对包根的 posix 路径。',
    fixtures,
  };
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  if (checkOnly) {
    const current = existsSync(SHAPE_BASELINE_PATH) ? readFileSync(SHAPE_BASELINE_PATH, 'utf8') : null;
    const same = current === text;
    if (!same) failed += 1;
    console.log(`[gen-expected] shape-baseline: ${same ? 'identical' : (current === null ? '缺少冻结源' : 'DRIFTED')}`);
  } else {
    writeFileSync(SHAPE_BASELINE_PATH, text, 'utf8');
    console.log(`[gen-expected] shape-baseline: 已写出 ${Object.keys(fixtures).length} 项 -> ${SHAPE_BASELINE_PATH}`);
  }
}

if (failed > 0) {
  console.error(`[gen-expected] 检查未通过（${failed} 项）`);
  process.exit(1);
}
console.log(`[gen-expected] ${checkOnly ? '基准与冻结源均与实测一致' : '完成'}`);
