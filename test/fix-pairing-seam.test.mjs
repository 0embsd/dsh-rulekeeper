// dsh-rulekeeper · 静态 pairing-seam 判据用例（fix-pairing-seam@1）
//
// 判据：绿 = 规格里的「文件存在 + 子串在 + 正则命中」三项全满足；
//   红 = 任一不满足（逐类各一条，且必须 exit 1，不是"静默放行"）；
//   规格缺失 / 空规格 = exit 2（不适用 ≠ 通过，用 runCheckerVerdict 的显式声明断言）。
// 夹具一律用合成名字（规则 50/55：公开仓不写被测项目的内部词汇）；检查器本身不跑任何测试。
// 跑检查器统一走 `runCheckerVerdict`（checker-exit-guard 判据①）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { runCheckerVerdict } from './helpers/sandbox.mjs';

const CHECKER = 'scripts/checkers/fix-pairing-seam.mjs';
const SPEC_REL = 'tools/rulekeeper/checkers/fix-pairing-seam.json';

function sandbox(label) {
  const dir = mkdtempSync(join(tmpdir(), `rk-seam-${label}-`));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function put(root, rel, text) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, 'utf8');
}

function spec(extra = {}) {
  return JSON.stringify({
    requireFiles: [
      { path: 'pkg/picker_test.go', contains: ['func TestPickPairsByName(', 'func TestPickDegradesKnown('] },
    ],
    requirePatterns: [
      { path: 'pkg/picker.go', pattern: 'case\\s+item\\.Name\\s*==\\s*base\\s*\\+\\s*"\\.sig"\\s*:', label: 'exact-pairing' },
    ],
    ...extra,
  }, null, 2);
}

function run(dir) {
  return runCheckerVerdict(CHECKER, { cwd: dir, label: 'fix-pairing-seam' });
}

test('green: 文件存在 + 两个用例名在 + 精确配对正则命中 ⇒ 0', () => {
  const { dir, done } = sandbox('green');
  try {
    put(dir, SPEC_REL, spec());
    put(dir, 'pkg/picker_test.go', 'func TestPickPairsByName(t *testing.T) {}\nfunc TestPickDegradesKnown(t *testing.T) {}\n');
    put(dir, 'pkg/picker.go', 'switch {\ncase item.Name == base+".sig":\n\tuse(item)\n}\n');
    const r = run(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /SEAM_PAIRING_VIOLATIONS=0/);
  } finally { done(); }
});

test('红: 用例名缺失 ⇒ exit 1 且点名 TOKEN_MISSING', () => {
  const { dir, done } = sandbox('token');
  try {
    put(dir, SPEC_REL, spec());
    put(dir, 'pkg/picker_test.go', 'func TestPickPairsByName(t *testing.T) {}\n');
    put(dir, 'pkg/picker.go', 'case item.Name == base+".sig":\n');
    const r = run(dir);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /SEAM_PAIRING_TOKEN_MISSING: pkg\/picker_test\.go/);
    assert.match(r.stdout, /SEAM_PAIRING_VIOLATIONS=1/);
  } finally { done(); }
});

test('红: 配对退回"任一后缀"⇒ 正则不命中，exit 1 且点名 PATTERN_MISSING', () => {
  const { dir, done } = sandbox('pattern');
  try {
    put(dir, SPEC_REL, spec());
    put(dir, 'pkg/picker_test.go', 'func TestPickPairsByName(t *testing.T) {}\nfunc TestPickDegradesKnown(t *testing.T) {}\n');
    put(dir, 'pkg/picker.go', 'case strings.HasSuffix(item.Name, ".sig"):\n');
    const r = run(dir);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /SEAM_PAIRING_PATTERN_MISSING: pkg\/picker\.go/);
  } finally { done(); }
});

test('红: 目标文件不存在 ⇒ exit 1 且点名 FILE_MISSING（不许当"不适用"）', () => {
  const { dir, done } = sandbox('missing');
  try {
    put(dir, SPEC_REL, spec());
    put(dir, 'pkg/picker.go', 'case item.Name == base+".sig":\n');
    const r = run(dir);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /SEAM_PAIRING_FILE_MISSING: pkg\/picker_test\.go/);
  } finally { done(); }
});

test('边界: 规格文件缺失 ⇒ exit 2（显式断言"不适用"）', () => {
  const { dir, done } = sandbox('nospec');
  try {
    const r = runCheckerVerdict(CHECKER, { cwd: dir, expect: 'not-applicable', label: 'fix-pairing-seam' });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /SEAM_SPEC_MISSING/);
  } finally { done(); }
});

test('边界: 空规格 ⇒ exit 2（显式断言"不适用"）', () => {
  const { dir, done } = sandbox('empty');
  try {
    put(dir, SPEC_REL, JSON.stringify({ requireFiles: [], requirePatterns: [] }));
    const r = runCheckerVerdict(CHECKER, { cwd: dir, expect: 'not-applicable', label: 'fix-pairing-seam' });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /SEAM_SPEC_EMPTY/);
  } finally { done(); }
});
