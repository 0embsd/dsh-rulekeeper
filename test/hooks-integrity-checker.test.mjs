// dsh-rulekeeper · hook 完整性检查器用例（2026-09-21）
//
// 为什么单独立这个文件：`kind:"checker"` 的绑定只有在**能构造红态**时才算真判据（规则 42）。
// 本检查器判两条**真实踩过**的坑：
//   L648 索引 mode 不是 100755 ⇒ POSIX 上 git 直接忽略该 hook（Windows 上看不出来）；
//   L653 `.gitattributes` 没显式钉无扩展名的 hook 为 LF ⇒ core.autocrlf 一 checkout 就转 CRLF
//        ⇒ 与 hooks.json 的 sha256 清单不符（verify 报 HOOK_MODIFIED）+ POSIX 上 shebang 行坏掉。
// 四项判据（与 checker.test.mjs 同款）：①命中红 ②误报面绿 ③反事实唯一性 ④确定性。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { verifyChecker } from '../src/checker.mjs';
import { cleanupAll, PKG_ROOT } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const CHECKER = 'scripts/checkers/hooks-integrity.mjs';
const RED = 'test/fixtures/checker/hooks-lf-red';
const GREEN = 'test/fixtures/checker/hooks-lf-green';

/** 真绑定样例：真检查器 + 真红/绿样本（与将来落进 rules.json 的那条逐字同形） */
function binding(overrides = {}) {
  return {
    kind: 'checker',
    rule: 'CAT-PROC',
    command: ['node', CHECKER],
    expectRed: { exitCode: 1 },
    expectGreen: { exitCode: 0 },
    redSample: { kind: 'tree', source: RED },
    greenSample: { kind: 'tree', source: GREEN },
    checkerVersion: 'hooks-integrity@1',
    timeoutMs: 20000,
    ...overrides,
  };
}

test('判据: hook 完整性检查器四项全过（命中红 / 误报面绿 / 反事实唯一性 / 确定性）', () => {
  const r = verifyChecker({ projectRoot: PKG_ROOT, binding: binding(), allowExec: true });
  assert.equal(r.ok, true, `应当全过；findings=${JSON.stringify(r.findings)}`);
  assert.equal(r.state, 'green');
});

test('反事实①: 拿"绿样本"当红样本 ⇒ 必须判不合格（红样本不红 = 判据是空的）', () => {
  const r = verifyChecker({ projectRoot: PKG_ROOT, binding: binding({ redSample: { kind: 'tree', source: GREEN } }), allowExec: true });
  assert.equal(r.ok, false, '红样本不红必须被发现，否则绑定只是摆设');
});

test('反事实②: 拿"红样本"当绿样本 ⇒ 必须判不合格（误报面不绿 = 判据会误伤）', () => {
  const r = verifyChecker({ projectRoot: PKG_ROOT, binding: binding({ greenSample: { kind: 'tree', source: RED } }), allowExec: true });
  assert.equal(r.ok, false, '误报面不绿必须被发现');
});

test('边界（如实）: 检查器自身缺失 ⇒ 判"凭证不足/跑不动"，不得判通过', () => {
  const r = verifyChecker({ projectRoot: PKG_ROOT, binding: binding({ command: ['node', 'scripts/checkers/no-such-checker.mjs'] }), allowExec: true });
  assert.equal(r.ok, false, '检查器跑不动时必须 fail-closed，绝不判绿');
});
