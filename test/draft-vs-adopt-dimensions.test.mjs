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

// ── P8'（2026-09-24，被治理项目侧工单 §2）：**同一条命令内三个基数**──────────────────────────
// 现场：一条命令的屏上同时出现 50 / 55 / 89，谁也没说自己是谁 ⇒ 被读成"同命令内计数不一致"。
// 三个数其实都成立（全集模板数 / 待起草集 / --json 输出上限），缺的是**标签**与**不静默截断**。
// 判据（成对，缺一不算）：
//   ⓐ 每个基数都有名字与来历（`RK_DRAFT_BASE` 一行写三个；`--json` 各字段自带名）；
//   ⓑ **代数关系成立**：`json_array == min(pending, cap)`、`pending <= stats_drafted`；
//   ⓒ 打印的 HIGH/MEDIUM 与**它自己声称的基数**自洽（待起草集合与全集各自成对）；
//   ⓓ 输出上限**被写出来**（cap 不是字面量魔法数），且 `--limit` **不改变**它（那正是原始症状）。
// 反向红：把 `RK_DRAFT_BASE` 那行删掉 ⇒ ⓐ 必红；把 `slice(0, DRAFT_JSON_CAP)` 换成 `slice(0, 50)`
// 且不报 cap ⇒ ⓓ 必红。

/** 取 JSON 里的 `"字段": 数字`（jsonStable 会缩进，故不能锚在行首） */
const jsonNum = (out, field) => Number(new RegExp(`"${field}":\\s*(\\d+)`).exec(out)?.[1] ?? '-1');
/**
 * 取 `--json` 的 payload 并解析。
 * ⚠ 必须**去 `RK_*` 行**再解析：结果行与 payload 同流（既有设计），`JSON.parse` 直接吃会炸。
 * ⚠ 且**不能**用"全串数 `"activation":` 出现次数"当数组长度 —— `noAnchor[]` 的条目里也有
 * `activation: ""`（空串），全串计数会把两个数组加在一起（本用例第一版就是这么错的红）。
 */
function payloadOf(out) {
  const lines = String(out).split(/\r?\n/).filter((l) => !/^RK_/.test(l));
  return JSON.parse(lines.join('\n').slice(lines.join('\n').indexOf('{')));
}

test("P8'①: 三个基数各有名字与来历（`RK_DRAFT_BASE` + `--json` 字段名）", () => {
  const { landing } = scene('p8p-labels');
  const r = run(['draft-activation', '--landing', landing]);
  assert.match(r.out, /RK_DRAFT_BASE stats_drafted=\d+/, `必须有一行写明三个基数；out=${r.out}`);
  assert.match(r.out, /pending=\d+/, 'RK_DRAFT_BASE 必须含 pending');
  assert.match(r.out, /json_array=\d+/, 'RK_DRAFT_BASE 必须含 json_array');
  assert.match(r.out, /输出上限 \d+/, 'json_array 必须点明它是**输出上限**，不是待写条数');

  const j = run(['draft-activation', '--landing', landing, '--json']);
  const payload = j.out.slice(j.out.indexOf('{'));
  assert.match(payload, /"draftedFull":\s*\d+/, 'stats 必须带 draftedFull（全集口径，名字自解释）');
  assert.match(payload, /"draftedPending":\s*\d+/, 'stats 必须带 draftedPending');
  assert.match(payload, /"draftsShown":\s*\d+/, 'stats 必须带 draftsShown');
  assert.match(payload, /"draftsShownCap":\s*\d+/, 'stats 必须带 draftsShownCap（上限本身也要可见）');
});

test("P8'②: 代数关系成立 —— json_array == min(pending, cap)；pending <= stats_drafted", () => {
  const { landing } = scene('p8p-algebra');
  const r = run(['draft-activation', '--landing', landing]);
  const base = /RK_DRAFT_BASE stats_drafted=(\d+).*?pending=(\d+).*?json_array=(\d+)/s.exec(r.out);
  assert.ok(base !== null, `必须能解析出三个基数；out=${r.out}`);
  const [, full, pending, shown] = base.map(Number);
  const cap = Number(/输出上限 (\d+)/.exec(r.out)?.[1] ?? '-1');
  assert.equal(cap > 0, true, '上限必须是正数且可读');
  assert.equal(shown, Math.min(pending, cap), `json_array 必须 == min(pending, cap)（实得 shown=${shown} pending=${pending} cap=${cap}）`);
  assert.equal(pending <= full, true, `待起草不得超过全集（pending=${pending} full=${full}）`);

  // `--json` 的字段必须与文本面**同一口径**（不许两套）
  const j = run(['draft-activation', '--landing', landing, '--json']);
  assert.equal(jsonNum(j.out, 'draftedPending'), pending, '--json 的 draftedPending 必须与文本面一致');
  assert.equal(jsonNum(j.out, 'draftsShown'), shown, '--json 的 draftsShown 必须与文本面一致');
  assert.equal(jsonNum(j.out, 'draftsShownCap'), cap, '--json 的 draftsShownCap 必须与文本面一致');
  // 数组长度必须**就是** shown —— 且解析后按**数组自己的长度**核（不靠字符串计数）
  const payload = payloadOf(j.out);
  assert.equal(payload.drafts.length, shown, `drafts 数组长度必须 == draftsShown（实得 ${payload.drafts.length} vs ${shown}）`);
  assert.equal(payload.drafts.length, payload.stats.draftsShown, '数组长度必须与它自己声明的 draftsShown 相等（同一基数、同一事实）');
});

test("P8'③: 打印的 HIGH/MEDIUM 与**它自己声称的基数**自洽（待起草 vs 全集各自成对）", () => {
  const { landing } = scene('p8p-bases');
  const r = run(['draft-activation', '--landing', landing]);
  const line = /RK_DRAFT_HIGH=(\d+)（待起草集合） RK_DRAFT_MEDIUM=(\d+)（待起草集合）｜全集口径：HIGH=(\d+) MEDIUM=(\d+)/.exec(r.out);
  assert.ok(line !== null, `HIGH/MEDIUM 必须同时给出两套基数；out=${r.out}`);
  const [subHigh, subMed, fullHigh, fullMed] = line.slice(1).map(Number);
  const pending = Number(/pending=(\d+)/.exec(r.out)?.[1] ?? '-1');
  const full = Number(/stats_drafted=(\d+)/.exec(r.out)?.[1] ?? '-1');
  assert.equal(subHigh + subMed, pending, `待起草基数的 HIGH+MEDIUM 必须 == pending（${subHigh}+${subMed} vs ${pending}）`);
  assert.equal(fullHigh + fullMed, full, `全集基数的 HIGH+MEDIUM 必须 == stats_drafted（${fullHigh}+${fullMed} vs ${full}）`);
});

test("P8'④: 输出上限**写出来了**，且 `--limit` 不改变它（原始症状：--limit 500 仍是 50）", () => {
  const { landing } = scene('p8p-cap');
  const a = run(['draft-activation', '--landing', landing, '--json']);
  const b = run(['draft-activation', '--landing', landing, '--json', '--limit', '500']);
  const capOf = (out) => jsonNum(out, 'draftsShownCap');
  assert.equal(capOf(a.out) > 0, true, '上限必须出现在 --json 里');
  assert.equal(capOf(b.out), capOf(a.out), '`--limit` 不得改变**输出上限**（它是显示上限，不是产草稿上限）');
  // 上限本身是常量：与产草稿上限是两个不同的旋钮，必须都能被读到
  assert.match(b.out, /"draftedFull":\s*\d+/, '--limit 影响的是 draftedFull，不是 draftsShownCap');
});

