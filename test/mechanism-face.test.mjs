// dsh-rulekeeper · 机制面四选一 + 状态事件 fold 用例（2026-09-21）
//
// 判据（读死再下结论）：
//   ① `record --mechanism` 只接受四选一 —— 拼错/自由文本一律**用法错误**（rc=2），不落盘
//   ② 缺 `--mechanism` ⇒ 默认 `text`（**仍会被计数**，不是免检）
//   ③ `状态事件` 行把被点名的历史行 fold 成 superseded：不进复发计数、不进事件派生
//   ④ `状态事件` 行自己**不是教训**（不会让那个 rule 重新出现在体检里）
//
// 红 = 上面任一条被放宽（例如拼错的 mechanism 能落盘、"取代"只改文本不影响读数）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runRulekeeper } from '../src/cli.mjs';
import { MECHANISM_FACES, STATUS_EVENT_CATEGORY, supersededIds } from '../src/ledger.mjs';
import { ledgerGroups } from '../src/effect.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

/** 与 test/cli.test.mjs 同形的 io 捕获（不共享 helper：那份是本地函数，不是导出） */
function capture(fn) {
  let out = '';
  let err = '';
  const rc = fn({ out: (t) => { out += String(t); }, err: (t) => { err += String(t); } });
  return { rc, out, err };
}

/** 造一个只含空账本 + rules.json 的落点 */
function freshLanding2(label) {
  const dir = join(tempDir(label), 'landing');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ledger.jsonl'), '', 'utf8');
  writeFileSync(join(dir, 'rules.json'), `${JSON.stringify({ schema: 1, project: 't', protected_paths: [], gates: [], checks: [], inject: [] }, null, 2)}\n`, 'utf8');
  return dir;
}

const row = (over = {}) => ({
  schema: 1, id: over.id ?? 'L-A', ts: over.ts ?? '2026-01-01T00:00:00.000Z', rule: over.rule ?? 'CAT-X',
  category: over.category ?? '技术', problem: over.problem ?? 'p', root_cause: 'r', solution: 's',
  mechanism: over.mechanism ?? 'text', evidence: [], recurrence: 1,
  first_seen: '2026-01-01T00:00:00.000Z', last_seen: '2026-01-01T00:00:00.000Z', status: 'active',
});

function writeLedger(dir, rows) {
  writeFileSync(join(dir, 'ledger.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

test('判据①: mechanism 拼错 ⇒ 用法错误（rc=2），且**不落盘**', () => {
  const landing = freshLanding2('mech-bad');
  const before = readFileSync(join(landing, 'ledger.jsonl'), 'utf8');
  const out = capture((io) => runRulekeeper([
    'record', '--landing', landing, '--rule', 'CAT-X', '--problem', 'p', '--root-cause', 'r', '--solution', 's',
    '--mechanism', 'text-only',
  ], io, {}));
  assert.equal(out.rc, 2, `应当判用法错误；stdout=${out.out}`);
  assert.match(out.err, /四选一/);
  assert.equal(readFileSync(join(landing, 'ledger.jsonl'), 'utf8'), before, '用法错误时账本不得被改动');
});

test('判据②: 缺 --mechanism ⇒ 默认 text（会被计数，不是免检）', () => {
  const landing = freshLanding2('mech-default');
  const out = capture((io) => runRulekeeper([
    'record', '--landing', landing, '--rule', 'CAT-X', '--problem', 'p', '--root-cause', 'r', '--solution', 's',
  ], io, {}));
  assert.equal(out.rc, 0, `应当成功；stderr=${out.err}`);
  const last = readFileSync(join(landing, 'ledger.jsonl'), 'utf8').trim().split('\n').pop();
  assert.equal(JSON.parse(last).mechanism, 'text');
});

test('判据③: 状态事件把被点名的行 fold 成 superseded（不进复发计数）', () => {
  const landing = freshLanding2('supersede');
  writeLedger(landing, [
    row({ id: 'L-OLD', rule: 'CAT-Y', ts: '2026-01-01T00:00:00.000Z' }),
    row({ id: 'L-EV', rule: 'CAT-Y', category: STATUS_EVENT_CATEGORY, problem: 'STATUS_SUPERSEDE L-OLD', ts: '2026-01-02T00:00:00.000Z' }),
  ]);
  const groups = ledgerGroups(landing);
  assert.equal(groups.has('CAT-Y'), false, '被取代之后该 rule 不该出现在派生读数里（它只剩状态事件行）');
  const ids = supersededIds([row({ id: 'L-OLD' }), row({ id: 'L-EV', category: STATUS_EVENT_CATEGORY, problem: 'STATUS_SUPERSEDE L-OLD,L-OTHER' })]);
  assert.deepEqual([...ids].sort(), ['L-OLD', 'L-OTHER'], '一条事件可点名多个 id');
});

test('判据④: 状态事件行自己不是教训（不新增 rule、不计条目）', () => {
  const landing = freshLanding2('supersede-self');
  writeLedger(landing, [
    row({ id: 'L-A', rule: 'CAT-Z' }),
    row({ id: 'L-EV', rule: 'CAT-ONLY-EVENT', category: STATUS_EVENT_CATEGORY, problem: 'STATUS_SUPERSEDE L-A', ts: '2026-01-02T00:00:00.000Z' }),
  ]);
  const groups = ledgerGroups(landing);
  assert.equal(groups.has('CAT-Z'), false, '被取代的行不计数');
  assert.equal(groups.has('CAT-ONLY-EVENT'), false, '状态事件行不得自己造出一条纪律');
});

test('判据⑤（契约暴露面）: 机制面四选一是导出常量，且含 text/mechanized/guard/question', () => {
  assert.deepEqual([...MECHANISM_FACES], ['text', 'mechanized', 'guard', 'question']);
  assert.equal(STATUS_EVENT_CATEGORY, '状态事件');
  assert.equal(existsSync(join(tempDir('noop'), 'x')), false, 'tempDir 应可用（用例自检）');
});
