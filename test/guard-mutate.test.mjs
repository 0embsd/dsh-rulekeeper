// dsh-rulekeeper · 拦截面（guardRef）与"改已有条目"（mutate）用例（2026-09-21，交接第 2/3 步）
//
// 判据（读死再下结论）：
//   ① `mechanism=guard` **必须**点名 `--guard-ref <hook:名|gate:名>`，且那个拦截必须**真的在**
//      （钩子在 hooks.json 清单里 / 门禁在 rules.json 的 gates 里）⇒ 否则用法错误、不落盘
//   ② `guardRef` 只对 `guard` 档有意义：其它档带它 = 用法错误（防"随手挂个拦截面"）
//   ③ `mutate` 默认 dry-run **一个字都不写**；`--apply` 才落盘
//   ④ `--apply` 之后：**历史行逐字节不变**，追加"归档行 + 状态事件行"，旧行被 `supersededIds` fold 掉
//   ⑤ 幂等：同一 id 第二次 apply 不重复追加
//   ⑥ 身份字段（id/ts/rule）禁改；无 `--by`/无原因/空改 = 用法错误或判定不合格
//
// 红 = 上面任一条被放宽（例如 guard 不点名也能落盘、或 mutate 改写了历史行）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runRulekeeper } from '../src/cli.mjs';
import { installedHooks, registeredGates, verifyGuardRef, appendRowsVerified } from '../src/authier.mjs';
import { MUTATE_CATEGORY, MUTATE_MARK, MUTATE_MECHANISM, parseSets, planMutation } from '../src/ledger-mutate.mjs';
import { supersededIds } from '../src/ledger.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

function capture(fn) {
  let out = '';
  let err = '';
  const rc = fn({ out: (t) => { out += String(t); }, err: (t) => { err += String(t); } });
  return { rc, out, err };
}

/** 造落点：账本 + rules.json + hooks.json（可配） */
function fixture(label, { rows = [], gates = [], hooks = ['pre-commit', 'commit-msg'] } = {}) {
  const dir = tempDir(label);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify({ schema: 1, mode: 'observe' }, null, 2)}\n`, 'utf8');
  writeFileSync(join(dir, 'rules.json'), `${JSON.stringify({ schema: 1, project: 't', protected_paths: [], gates: gates.map((g) => ({ rule: 'GATE-DISCIPLINE', gate: g })), checks: [], inject: [] }, null, 2)}\n`, 'utf8');
  writeFileSync(join(dir, 'hooks.json'), `${JSON.stringify({ schema: 1, hooksPath: '.githooks', hooks: hooks.map((name) => ({ name, sha256: 'x', bytes: 1 })) }, null, 2)}\n`, 'utf8');
  writeFileSync(join(dir, 'ledger.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : ''), 'utf8');
  return dir;
}

const row = (over = {}) => ({
  schema: 1, id: over.id ?? 'L-A', ts: '2026-01-01T00:00:00.000Z', rule: over.rule ?? 'GATE-DISCIPLINE',
  category: over.category ?? '流程', problem: over.problem ?? '原问题表述', root_cause: 'r', solution: 's',
  mechanism: over.mechanism ?? 'text', evidence: over.evidence ?? ['原证据'], recurrence: 1,
  first_seen: '2026-01-01T00:00:00.000Z', last_seen: '2026-01-01T00:00:00.000Z', status: 'active',
});

const LANDS = ['--landing'];

// ── ① guardRef 存在性 ─────────────────────────────────────────────────────────

test('判据①: guard 必须点名拦截面，且该拦截真的在（缺/错都拒收，不落盘）', () => {
  const dir = fixture('gz-1');
  const before = readFileSync(join(dir, 'ledger.jsonl'), 'utf8');

  const noRef = capture((io) => runRulekeeper(['record', ...LANDS, dir, '--rule', 'GATE-DISCIPLINE', '--problem', 'p', '--root-cause', 'r', '--solution', 's', '--mechanism', 'guard'], io, {}));
  assert.equal(noRef.rc, 2, '缺 --guard-ref 应判用法错误');
  assert.match(noRef.err, /--guard-ref/);

  const wrongHook = capture((io) => runRulekeeper(['record', ...LANDS, dir, '--rule', 'GATE-DISCIPLINE', '--problem', 'p', '--root-cause', 'r', '--solution', 's', '--mechanism', 'guard', '--guard-ref', 'hook:nope'], io, {}));
  assert.equal(wrongHook.rc, 2);
  assert.match(wrongHook.err, /GUARD_REF_HOOK_MISSING/);

  const wrongGate = capture((io) => runRulekeeper(['record', ...LANDS, dir, '--rule', 'GATE-DISCIPLINE', '--problem', 'p', '--root-cause', 'r', '--solution', 's', '--mechanism', 'guard', '--guard-ref', 'gate:nope'], io, {}));
  assert.equal(wrongGate.rc, 2);
  assert.match(wrongGate.err, /GUARD_REF_GATE_MISSING/);

  const badShape = capture((io) => runRulekeeper(['record', ...LANDS, dir, '--rule', 'GATE-DISCIPLINE', '--problem', 'p', '--root-cause', 'r', '--solution', 's', '--mechanism', 'guard', '--guard-ref', 'pre-commit'], io, {}));
  assert.equal(badShape.rc, 2, '没写 hook:/gate: 前缀应判用法错误');

  assert.equal(readFileSync(join(dir, 'ledger.jsonl'), 'utf8'), before, '三次拒收都不许改动账本');

  const ok = capture((io) => runRulekeeper(['record', ...LANDS, dir, '--rule', 'GATE-DISCIPLINE', '--problem', '预提交公开面门禁真的拦过提交', '--root-cause', 'r', '--solution', 's', '--mechanism', 'guard', '--guard-ref', 'hook:pre-commit'], io, {}));
  assert.equal(ok.rc, 0, `合法 guardRef 应写入；stderr=${ok.err}`);
  const rows = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows[0].mechanism, 'guard');
  assert.equal(rows[0].guardRef, 'hook:pre-commit', '行里必须留下"靠哪个拦截"的凭据');
});

test('判据②: guardRef 只在 guard 档有意义（其它档带它 = 用法错误）', () => {
  const dir = fixture('gz-2');
  const out = capture((io) => runRulekeeper(['record', ...LANDS, dir, '--rule', 'X', '--problem', 'p', '--root-cause', 'r', '--solution', 's', '--mechanism', 'text', '--guard-ref', 'hook:pre-commit'], io, {}));
  assert.equal(out.rc, 2);
  assert.match(out.err, /只在 --mechanism guard 时有意义/);
});

test('判据①b: 探针层直接核 —— hooks.json / rules.json 的 gates 都能当拦截面', () => {
  const dir = fixture('gz-3', { gates: ['close'] });
  assert.deepEqual(installedHooks(dir).names, ['pre-commit', 'commit-msg']);
  assert.deepEqual(registeredGates(dir).names, ['close']);
  assert.equal(verifyGuardRef(dir, 'hook:commit-msg').ok, true);
  assert.equal(verifyGuardRef(dir, 'gate:close').ok, true);
  assert.equal(verifyGuardRef(dir, 'gate:open').ok, false);
  assert.equal(verifyGuardRef(dir, 'hook:pre-push').code, 'GUARD_REF_HOOK_MISSING');
  assert.equal(verifyGuardRef(dir, 'bogus:x').code, 'GUARD_REF_SHAPE');
});

// ── ③–⑥ mutate ───────────────────────────────────────────────────────────────

test('判据③: mutate 默认 dry-run，一个字都不写', () => {
  const dir = fixture('mut-1', { rows: [row({})] });
  const before = readFileSync(join(dir, 'ledger.jsonl'), 'utf8');
  const out = capture((io) => runRulekeeper(['mutate', ...LANDS, dir, '--id', 'L-A', '--set', 'mechanism=text', '--set', '证据加=补一条', '--by', 'human', '--reason', '自测'], io, {}));
  assert.equal(out.rc, 0, `dry-run 应通过；stderr=${out.err}`);
  assert.match(out.out, /RK_MUTATE_APPLIED=0/);
  assert.match(out.out, /RK_MUTATE_CHANGED=/);
  assert.equal(readFileSync(join(dir, 'ledger.jsonl'), 'utf8'), before, 'dry-run 不得改账本');
});

test('判据④: --apply 后历史行逐字节不变，归档行 + 状态事件行各一条', () => {
  const original = row({});
  const dir = fixture('mut-2', { rows: [original] });
  const before = readFileSync(join(dir, 'ledger.jsonl'), 'utf8');
  const out = capture((io) => runRulekeeper(['mutate', ...LANDS, dir, '--id', 'L-A', '--set', 'problem=新问题表述', '--set', '证据加=复核凭证 X', '--by', 'human', '--reason', '表述有误', '--apply'], io, {}));
  assert.equal(out.rc, 0, `apply 应成功；stderr=${out.err}`);
  const after = readFileSync(join(dir, 'ledger.jsonl'), 'utf8');
  assert.ok(after.startsWith(before), '历史行必须逐字节不变（新行只追加在后面）');
  const rows = after.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 3, '原行 + 归档行 + 状态事件行');
  // 身份看**类目**（`planMutation` 的产物：category=教训改写，mechanism 存**改后值**）
  const arch = rows.find((r) => r.category === MUTATE_CATEGORY);
  const status = rows.find((r) => r.category === '状态事件');
  assert.ok(arch, '必须有归档行');
  assert.equal(arch.problem, '新问题表述', '归档行承载改后的内容');
  assert.equal(arch.evidence[0], `${MUTATE_MARK} L-A`, '归档行首项必须标记"改的是哪一条"');
  assert.ok(arch.evidence.includes('复核凭证 X'), '证据是追加而不是替换');
  assert.equal(status.problem, 'STATUS_SUPERSEDE L-A');
  // fold：旧行被取代
  assert.ok(supersededIds(rows).has('L-A'), '读侧必须能算出旧行被取代');
  assert.notEqual(arch.mechanism, MUTATE_MECHANISM, '归档行的 mechanism 是**改后值**，不是身份标记');
});

test('判据⑤: 幂等 —— 同一 id 第二次 apply 不重复追加', () => {
  const dir = fixture('mut-3', { rows: [row({})] });
  const args = ['mutate', ...LANDS, dir, '--id', 'L-A', '--set', 'problem=改一次', '--by', 'human', '--reason', 'r1', '--apply'];
  assert.equal(capture((io) => runRulekeeper(args, io, {})).rc, 0);
  const lines1 = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').length;
  const second = capture((io) => runRulekeeper([...args.slice(0, -1), '--apply'], io, {}));
  assert.equal(second.rc, 0);
  assert.match(second.out, /RK_MUTATE_ALREADY=1/);
  const lines2 = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').length;
  assert.equal(lines2, lines1, '幂等：第二次不得再追加');
});

test('判据⑥: 身份字段禁改；缺 by/reason/内容 = 用法错误或判定不合格', () => {
  const dir = fixture('mut-4', { rows: [row({})] });
  const nowrite = readFileSync(join(dir, 'ledger.jsonl'), 'utf8');

  for (const bad of [
    ['--set', 'rule=CAT-X'],
    ['--set', 'id=Z'],
    ['--set', 'ts=2020-01-01T00:00:00.000Z'],
  ]) {
    const out = capture((io) => runRulekeeper(['mutate', ...LANDS, dir, '--id', 'L-A', ...bad, '--by', 'human', '--reason', 'x'], io, {}));
    assert.equal(out.rc, 2, `${bad[1]} 应判用法错误`);
    assert.match(out.err, /不可改/);
  }
  const missing = capture((io) => runRulekeeper(['mutate', ...LANDS, dir, '--id', 'L-A', '--set', 'problem=x'], io, {}));
  assert.equal(missing.rc, 2, '缺 --by/--reason 应判用法错误');

  const noop = capture((io) => runRulekeeper(['mutate', ...LANDS, dir, '--id', 'L-A', '--set', 'problem=原问题表述', '--by', 'human', '--reason', 'x'], io, {}));
  assert.equal(noop.rc, 1, '值没变应判"没有可改的内容"');
  assert.match(noop.err, /没有可改的内容/);

  const notFound = capture((io) => runRulekeeper(['mutate', ...LANDS, dir, '--id', 'NOPE', '--set', 'problem=x', '--by', 'human', '--reason', 'x'], io, {}));
  assert.equal(notFound.rc, 1);
  assert.match(notFound.err, /没有 id=NOPE/);

  assert.equal(readFileSync(join(dir, 'ledger.jsonl'), 'utf8'), nowrite, '上述六次都不许改账本');
});

test('判据⑥b: 纯函数层（parseSets / planMutation / appendRowsVerified）边界', () => {
  const p = parseSets(['problem=x', '证据加=e1', '证据加= ']);
  assert.equal(p.ok, false, '空的 证据加= 应报问题');
  assert.deepEqual(p.addEvidence, ['e1']);
  assert.equal(parseSets(['证据=看起来像整表替换']).ok, false, 'evidence 只能走 证据加=（整表替换太容易误删）');

  const rows = [row({})];
  const plan = planMutation(rows, { targetId: 'L-A', sets: { solution: 's2' }, by: 'human', reason: 'r', newId: 'L-NEW', now: new Date('2026-02-02T00:00:00.000Z') });
  assert.equal(plan.ok, true);
  assert.equal(plan.newRow.id, 'L-NEW');
  assert.equal(plan.newRow.solution, 's2');
  assert.equal(plan.statusRow.category, '状态事件');
  assert.equal(plan.statusRow.id, 'L-NEW-status');

  const noBy = planMutation(rows, { targetId: 'L-A', sets: { solution: 's2' }, by: '', reason: 'r', newId: 'X' });
  assert.equal(noBy.ok, false);
  assert.match(noBy.problems.join(' '), /--by/);

  // appendRowsVerified：备份 + 回读 + 失败回滚（用不存在的账本触发 no-ledger 分支）
  const empty = tempDir('mut-5');
  const res = appendRowsVerified({ landingDir: empty, rows: [row({ id: 'X' })] });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'NO_LEDGER');
});

test('判据⑦（写前重读）: 读出之后、替换之前有别的写者追加 ⇒ **放弃写入**，对方的行必须还在', () => {  const dir = fixture('mut-race', { rows: [row({})] });
  const ledger = join(dir, 'ledger.jsonl');
  const foreign = JSON.stringify(row({ id: 'L-FOREIGN', problem: '别的写者在我读完之后追加的行' }));
  const res = appendRowsVerified({
    landingDir: dir,
    rows: [row({ id: 'L-MINE', problem: '我要追加的行' })],
    // 测试缝：就在"读完了、准备替换"那一刻插进一次外部追加（模拟另一个会话的 record）
    _inject: { beforeReplace: ({ file }) => appendFileSync(file, `${foreign}\n`, 'utf8') },
  });
  assert.equal(res.ok, false, '检出并发写入后必须拒绝，不许静默覆盖');
  assert.equal(res.code, 'CONCURRENT_WRITE_DETECTED');
  assert.match(res.reason, /重跑本命令/);
  const after = readFileSync(ledger, 'utf8');
  assert.ok(after.includes('L-FOREIGN'), '对方的行必须**原样还在**（这正是这条判据存在的理由）');
  assert.ok(!after.includes('L-MINE'), '我的行一个都不该落进去（fail-closed）');
});

// ── P1（被治理项目侧提的"全作用域前置断言"）─────────────────────────────────────
// 现场事故：同一教训已被**另一会话**合规登记，当事人不知情又登了一遍 ⇒ 重复条目会把正确教训挤出 top-1。
// 根因：前置断言只看了"这一行还能不能改"（对象局部），没看"这件事是否已被别处做过"（全作用域）。

test('判据⑧（写前重读・前置断言）: record 必须打印该纪律的既有登记面', () => {
  const dir = fixture('pre-1', { rows: [row({ id: 'L-A' }), row({ id: 'L-B', problem: '另一条' })] });
  const out = capture((io) => runRulekeeper([
    'record', ...LANDS, dir, '--rule', 'GATE-DISCIPLINE', '--problem', '新的一条', '--root-cause', 'r', '--solution', 's',
    '--mechanism', 'text', '--no-activation', '自测',
  ], io, {}));
  assert.equal(out.rc, 0, `应当允许（该纪律还没有 guard 登记）; stderr=${out.err}`);
  const m = /RK_RECORD_PRECHECK rule=(\S+) entries=(\d+) live=(\d+) guard_rows=(\d+) superseded=(\d+)/.exec(out.out);
  assert.ok(m !== null, `输出里必须有 RK_RECORD_PRECHECK 读数；out=${out.out}`);
  assert.equal(m[2], '2', '既有条目数要如实');
  assert.equal(m[4], '0', '还没有 guard 登记');
});

test('判据⑨（前置断言的闸）: 该纪律已有 guard 登记 ⇒ 拒写，`--force` 才放行', () => {
  const dir = fixture('pre-2', {
    rows: [
      row({ id: 'L-A' }),
      // 已有一条 guard 登记（形状合法：点名了拦截面）
      { ...row({ id: 'L-G' }), mechanism: 'guard', guardRef: 'hook:pre-commit' },
    ],
  });
  const args = [
    'record', ...LANDS, dir, '--rule', 'GATE-DISCIPLINE', '--problem', '可能重复的一条', '--root-cause', 'r', '--solution', 's',
    '--mechanism', 'text', '--no-activation', '自测',
  ];
  const blocked = capture((io) => runRulekeeper(args, io, {}));
  assert.equal(blocked.rc, 1, '没有 --force 必须拒写（防"同一件事叠着登记"）');
  assert.match(blocked.err, /已有 1 条 guard 登记/);
  assert.match(blocked.out, /guard_rows=1/);
  const before = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').length;
  assert.equal(before, 2, '拒写时账本不得改动');

  const forced = capture((io) => runRulekeeper([...args, '--force'], io, {}));
  assert.equal(forced.rc, 0, `--force 应当放行；stderr=${forced.err}`);
  const after = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').length;
  assert.equal(after, 3, '放行后才追加一行');
});
