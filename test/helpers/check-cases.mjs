// dsh-rulekeeper · LF-250 判决用例表（**唯一**定义处）
//
// 为什么单独抽出来：`test/checks.test.mjs`（判据）与 `scripts/gen-expected.mjs`（基准再生成）必须用
// **同一张表**，否则"基准"和"判据"会分别漂移——那时逐字比对就成了摆设。
// 注意：node --test 会把 test/ 下所有 .mjs 当测试文件加载，本文件无 test() 调用，会以"0 用例"出现，属预期。

import { join } from 'node:path';

import { FIXTURES_DIR } from './sandbox.mjs';

export const CHECKS_DIR = join(FIXTURES_DIR, 'checks');
export const EXPECTED_DIR = join(FIXTURES_DIR, 'expected');

const untrackedOk = join(CHECKS_DIR, 'untracked-ok');
const untrackedBad = join(CHECKS_DIR, 'untracked-violation');

/** 三名类 × {绿, 红} = 6 例；`args` 是 `rk-check <args...>` 的完整参数（含 `--json` 由调用方决定） */
export const CHECK_CASES = Object.freeze([
  Object.freeze({
    name: 'untracked-ok', kind: 'file_untracked_change', rc: 0,
    args: Object.freeze(['untracked-change', '--file', join(untrackedOk, 'target.txt'), '--landing', join(untrackedOk, 'landing'), '--project', untrackedOk]),
  }),
  Object.freeze({
    name: 'untracked-violation', kind: 'file_untracked_change', rc: 1,
    args: Object.freeze(['untracked-change', '--file', join(untrackedBad, 'target.txt'), '--landing', untrackedBad, '--project', untrackedBad]),
  }),
  Object.freeze({
    name: 'output-shape-ok', kind: 'output_shape', rc: 0,
    args: Object.freeze(['output-shape', '--file', join(CHECKS_DIR, 'output-shape-ok.txt'), '--project', CHECKS_DIR, '--min-lines', '2', '--max-lines', '5', '--max-line-length', '80']),
  }),
  Object.freeze({
    name: 'output-shape-violation', kind: 'output_shape', rc: 1,
    args: Object.freeze(['output-shape', '--file', join(CHECKS_DIR, 'output-shape-violation.txt'), '--project', CHECKS_DIR, '--min-lines', '2', '--max-lines', '5', '--max-line-length', '80']),
  }),
  Object.freeze({
    name: 'invalid-reference-ok', kind: 'invalid_reference', rc: 0,
    args: Object.freeze(['invalid-reference', '--file', join(CHECKS_DIR, 'invalid-reference-ok.md'), '--project', CHECKS_DIR]),
  }),
  Object.freeze({
    name: 'invalid-reference-violation', kind: 'invalid_reference', rc: 1,
    args: Object.freeze(['invalid-reference', '--file', join(CHECKS_DIR, 'invalid-reference-violation.md'), '--project', CHECKS_DIR]),
  }),
]);

export function expectedPathOf(name) {
  return join(EXPECTED_DIR, `${name}.json`);
}

/**
 * LF-2A0 的 `uncheckable` 实证声明用例（**与 LF-250 同一套机制**：判决 JSON 逐字基准）。
 * 与上面三类分开成表，是因为它们的 `--now` 必须固定（否则"是否过期"会随运行时间变，基准不可复现）。
 */
export const UNCHECKABLE_CASES = Object.freeze([
  Object.freeze({
    name: 'uncheckable-ok', rc: 0,
    args: Object.freeze(['uncheckable', '--file', join(CHECKS_DIR, 'uncheckable-ok.json'), '--project', CHECKS_DIR, '--now', '2026-09-20T00:00:00.000Z']),
  }),
  Object.freeze({
    name: 'uncheckable-sentence-only', rc: 1,
    args: Object.freeze(['uncheckable', '--file', join(CHECKS_DIR, 'uncheckable-sentence-only.json'), '--project', CHECKS_DIR, '--now', '2026-09-20T00:00:00.000Z']),
  }),
  Object.freeze({
    name: 'uncheckable-placeholder-output', rc: 1,
    args: Object.freeze(['uncheckable', '--file', join(CHECKS_DIR, 'uncheckable-placeholder-output.json'), '--project', CHECKS_DIR, '--now', '2026-09-20T00:00:00.000Z']),
  }),
  Object.freeze({
    name: 'uncheckable-no-control', rc: 1,
    args: Object.freeze(['uncheckable', '--file', join(CHECKS_DIR, 'uncheckable-no-control.json'), '--project', CHECKS_DIR, '--now', '2026-09-20T00:00:00.000Z']),
  }),
  Object.freeze({
    name: 'uncheckable-expired', rc: 1,
    args: Object.freeze(['uncheckable', '--file', join(CHECKS_DIR, 'uncheckable-expired.json'), '--project', CHECKS_DIR, '--now', '2026-09-20T00:00:00.000Z']),
  }),
  Object.freeze({
    name: 'uncheckable-bad-window', rc: 1,
    args: Object.freeze(['uncheckable', '--file', join(CHECKS_DIR, 'uncheckable-bad-window.json'), '--project', CHECKS_DIR, '--now', '2026-09-20T00:00:00.000Z']),
  }),
  Object.freeze({
    name: 'uncheckable-recurred', rc: 1,
    args: Object.freeze(['uncheckable', '--file', join(CHECKS_DIR, 'uncheckable-recurred.json'), '--project', CHECKS_DIR, '--landing', join(CHECKS_DIR, 'uncheckable-landing'), '--now', '2026-09-20T00:00:00.000Z']),
  }),
  Object.freeze({
    name: 'uncheckable-not-object', rc: 1,
    args: Object.freeze(['uncheckable', '--file', join(CHECKS_DIR, 'uncheckable-not-object.json'), '--project', CHECKS_DIR, '--now', '2026-09-20T00:00:00.000Z']),
  }),
]);
