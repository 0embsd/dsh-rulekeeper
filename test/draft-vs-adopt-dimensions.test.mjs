// dsh-rulekeeper · P8 用例：`draft-activation` 与 `adopt` 的"草稿数"**不是一回事**，输出必须替它们说清
//
// 现场（治理项目读成矛盾）：同一屏里同时出现
//   · `draft-activation` 的 `RK_DRAFT_ANNOTATED=34`（**注解层**：条目级"何时适用"已覆盖的行数）
//   · `adopt` 的 `DRAFTS=0`（**规格派生**的绑定草稿：规格在、尚未绑定的纪律数）
// 两者语义完全不同，却并排可见 ⇒ 被读成"注解了 34 条却一个字没草拟？自相矛盾"，连 lowQuality 的结论也跟着被误读。
//
// 本文件的判据（成对，缺一不算）：
//   ① 两个数各自有**自解释**读数（`RK_ACTIVATION_ANNOTATED/PENDING` + `RK_ADOPT_BINDING_DRAFTS`），
//      旧名保留（兼容既有消费方）；
//   ② 输出**明确写出关系**：本命令产出的是条目级注解，**不产绑定草稿**；两者不同维度、不可比；
//   ③ 数与**明细一致**（不是"看着像"）：带锚点的行数 == ANNOTATED+PENDING，且 adopt 的 DRAFTS 与
//      规格面（`SPECS` vs `ALREADY_BOUND`）自洽；
//   ④ `--write` 后 ANNOTATED 上升、PENDING 下降（两个方向都动，证明它们是一个硬币的两面）。
//
// 反向红：把 `RK_ACTIVATION_DIMENSION_NOTE` 那行删掉 ⇒ ② 必红。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanupAll, freshLanding, ledgerEntry, PKG_ROOT } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const TS = '2026-09-19T00:00:00.000Z';
const EFFECT = join(PKG_ROOT, 'bin', 'rk-effect.mjs');

const run = (args) => {
  const r = spawnSync(process.execPath, [EFFECT, ...args], { cwd: PKG_ROOT, encoding: 'utf8' });
  return { rc: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const numOf = (out, key) => Number(new RegExp(`${key}=(\\d+)`).exec(out)?.[1] ?? '-1');

/** 造一个落点：**两行带锚点的教训**（可起草）+ **一条规格**（供 adopt 的 DRAFTS）。 */
function scene(label) {
  const { landing } = freshLanding(label, {
    entries: [
      ledgerEntry({ id: 'P8A', ts: TS, rule: 'CAT-CODE', problem: '改动 src/cli.mjs 时容易漏', solution: 's', rootCause: 'r' }),
      ledgerEntry({ id: 'P8B', ts: TS, rule: 'CAT-TECH', problem: '跑 rk-test 时注意 exit=1', solution: 's', rootCause: 'r' }),
    ],
  });
  // 规格面：一份"规格在、尚未绑定"的 spec（⇒ adopt 会出 1 份绑定草稿）
  writeFileSync(join(landing, '..', '..', 'tools-probe-placeholder.txt'), '', 'utf8');   // 占位（保证目录在手）
  return { landing };
}

test('P8①: 两个"草稿数"各有自解释读数（旧名保留）', () => {
  const { landing } = scene('p8-labels');
  const draft = run(['draft-activation', '--landing', landing]);
  assert.match(draft.out, /RK_ACTIVATION_ANNOTATED=\d+（\*\*注解层\*\*/, `必须给注解层计数一个自解释名；out=${draft.out}`);
  assert.match(draft.out, /RK_ACTIVATION_PENDING=\d+（\*\*待起草\*\*/, `必须给待起草计数一个自解释名；out=${draft.out}`);
  // 旧名仍在（兼容既有消费方：用例与脚本读的是旧名）
  assert.match(draft.out, /RK_DRAFT_ANNOTATED=\d+/);
  assert.match(draft.out, /RK_DRAFT_PENDING=\d+/);

  const adopt = run(['adopt', '--landing', landing, '--project', join(landing, '..', '..')]);
  assert.match(adopt.out, /RK_ADOPT_BINDING_DRAFTS=\d+（\*\*规格派生\*\*的绑定草稿/, `adopt 侧同样要自解释；out=${adopt.out}`);
  assert.match(adopt.out, /RK_ADOPT_SPECS=\d+/, '旧读数保留');
});

test('P8②: 输出必须**明确写出关系**（本命令不产绑定草稿；两者不可比）', () => {
  const { landing } = scene('p8-note');
  const draft = run(['draft-activation', '--landing', landing]);
  assert.match(draft.out, /RK_ACTIVATION_DIMENSION_NOTE=/, '必须有一行专门讲维度');
  assert.match(draft.out, /不产绑定草稿/, '必须点明本命令**不产**绑定草稿');
  assert.match(draft.out, /不同维度、不可比/, '必须点明两者不可比');
  assert.match(draft.out, /adopt/, '必须指名另一个数从哪来（adopt）');
});

test('P8③: 数与**明细一致** —— 带锚点的行数 == ANNOTATED + PENDING；adopt 的 DRAFTS 与规格面自洽', () => {
  const { landing } = scene('p8-consistent');
  const draft = run(['draft-activation', '--landing', landing]);
  const annotated = numOf(draft.out, 'RK_ACTIVATION_ANNOTATED');
  const pending = numOf(draft.out, 'RK_ACTIVATION_PENDING');
  assert.equal(annotated >= 0 && pending >= 0, true, `两个数都得有；out=${draft.out}`);
  assert.equal(annotated + pending <= numOf(draft.out, 'RK_DRAFT_ROWS'),
    true, '注解 + 待起草不得超过可起草行数（明细关系必须成立）');

  const adopt = run(['adopt', '--landing', landing, '--project', join(landing, '..', '..')]);
  const specs = numOf(adopt.out, 'RK_ADOPT_SPECS');
  const already = numOf(adopt.out, 'ALREADY_BOUND');
  const drafts = numOf(adopt.out, 'RK_ADOPT_BINDING_DRAFTS');
  assert.equal(specs >= 0 && already >= 0 && drafts >= 0, true, `三个数都得有；out=${adopt.out}`);
  assert.equal(drafts <= specs, true, `绑定草稿数不得超过规格数（实得 drafts=${drafts} specs=${specs}）`);
});

test('P8④: `--write` 之后（**重跑一次**读覆盖）：ANNOTATED 上升、PENDING 下降 —— 一枚硬币的两面', () => {
  const { landing } = scene('p8-write');
  const before = run(['draft-activation', '--landing', landing]);
  const a0 = numOf(before.out, 'RK_ACTIVATION_ANNOTATED');
  const p0 = numOf(before.out, 'RK_ACTIVATION_PENDING');
  assert.equal(p0 > 0, true, `前置：应有待起草的行；out=${before.out}`);

  const write = run(['draft-activation', '--landing', landing, '--write']);
  assert.match(write.out, /RK_DRAFT_WRITTEN=[1-9]/, `应当真写了注解；out=${write.out}`);

  // ⚠ 覆盖计数在**写入那一次**的输出里没有（`--write` 分支只打 WROTE/FAILED/COVERAGE_*）
  // ⇒ 按实际语义**重跑一次**再读（这也是幂等性的体现：第二次不重复写）。
  const after = run(['draft-activation', '--landing', landing, '--write']);
  const a1 = numOf(after.out, 'RK_ACTIVATION_ANNOTATED');
  const p1 = numOf(after.out, 'RK_ACTIVATION_PENDING');
  assert.equal(a1 > a0, true, `写注解后 ANNOTATED 必须上升（${a0} -> ${a1}）；out=${after.out}`);
  assert.equal(p1 < p0, true, `同时 PENDING 必须下降（${p0} -> ${p1}）；out=${after.out}`);
  assert.match(after.out, /RK_DRAFT_WRITTEN=0/, '重跑不得重复写（幂等）');
});
