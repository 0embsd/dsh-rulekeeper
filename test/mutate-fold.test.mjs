// dsh-rulekeeper · `rk mutate` 的 fold 语义用例（2026-09-21，交接：给 mutate 补 fold）
//
// 现场缺口（实测确认，不是推断）：归档行原先被所有派生读数排除 ⇒ **改后的内容没人读** ——
// 效果上等于"改了不生效"。本用例把 fold 语义钉死：
//   ① **要读改后的内容**：`ledgerGroups` 的条目里必须有归档行承载的 `problem`
//   ② **不重复计数**：被取代的旧行必须不在（`supersededIds` 的职责）
//   ③ **不算复发**：归档行不进 `recurrenceIdentity`（"改个错别字"不该变成"又踩了一次"）
//   ④ 各消费方**同一口径**：adopt 的机制面统计与检查器都按同一组行算

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ledgerGroups, recurrenceIdentity } from '../src/effect.mjs';
import { MUTATE_CATEGORY, MUTATE_MECHANISM, foldMutates } from '../src/ledger-mutate.mjs';
import { supersededIds } from '../src/ledger.mjs';
import { adoptionReport } from '../src/adopt.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const BASE = {
  schema: 1, ts: '2026-01-01T00:00:00.000Z', rule: 'CAT-FOLD', category: '技术',
  problem: '原问题表述', root_cause: 'r', solution: 's', mechanism: 'text', evidence: [],
  recurrence: 1, first_seen: '2026-01-01T00:00:00.000Z', last_seen: '2026-01-01T00:00:00.000Z', status: 'active',
};

/** 造一个"已改过一条"的落点：原行 + 归档行 + 状态事件行 */
function mutatedLanding(label) {
  const dir = tempDir(label);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify({ schema: 1, mode: 'observe' }, null, 2)}\n`, 'utf8');
  writeFileSync(join(dir, 'rules.json'), `${JSON.stringify({ schema: 1, project: 't', protected_paths: [], gates: [], checks: [], inject: [] }, null, 2)}\n`, 'utf8');
  const rows = [
    { ...BASE, id: 'L-OLD' },
    {
      // **真实形态**（`planMutation` 的产物）：归档行的 **category = 教训改写** 是"我是改写行"的身份，
      // 而 `mechanism` 直接就是**改后值**。两件事必须分开：把身份塞进 `mechanism` 会让"改后值"被覆盖
      // ⇒ fold 出来还是旧值（写这条时实测踩到两次）。
      ...BASE, id: 'L-NEW', ts: '2026-02-01T00:00:00.000Z', problem: '改后的问题表述',
      category: MUTATE_CATEGORY, mechanism: 'text', evidence: ['MUTATES L-OLD'],
    },
    { ...BASE, id: 'L-NEW-status', ts: '2026-02-01T00:00:00.000Z', category: '状态事件', problem: 'STATUS_SUPERSEDE L-OLD', mechanism: MUTATE_MECHANISM, evidence: ['MUTATES L-OLD'] },
  ];
  writeFileSync(join(dir, 'ledger.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  return { dir, rows };
}

test('判据①②: 改后的内容**必须被读到**，且旧行不重复计数', () => {
  const { dir } = mutatedLanding('fold-read');
  const groups = ledgerGroups(dir);
  const g = groups.get('CAT-FOLD');
  assert.ok(g !== undefined, '这一条纪律应当仍在派生读数里');
  assert.equal(g.count, 1, '归档行算 1 条（旧行已被取代，不重复计）');

  // 关键：派生读数要能指出"内容现在是改后的那条"
  const live = [...(g.variants ?? [])];
  assert.ok(live.includes('CAT-FOLD'));
  // 直接看行级事实：活着的那条 problem 是改后的
  const report = adoptionReport({ landingDir: dir, projectRoot: dir });
  assert.equal(report.ok, true);
  assert.equal(report.stats.entries, 1, 'adopt 的教训条目数也应只有 1 条');
});

test('判据③: 归档行**不进复发比较**（改个错别字不是"又踩了一次"）', () => {
  const { rows } = mutatedLanding('fold-recur');
  const rec = recurrenceIdentity(rows, 'CAT-FOLD', '2026-01-15T00:00:00.000Z');
  assert.equal(rec.fresh, 0, '归档行与状态事件行都不该算"生效后新入账的教训"');
  assert.equal(rec.max, 0, '没有可比对象 ⇒ 相似度 0，不冒充复发');
});

test('判据④: 同一组行 —— adopt 的机制面统计不把状态事件行当教训', () => {
  const { dir } = mutatedLanding('fold-adopt');
  const report = adoptionReport({ landingDir: dir, projectRoot: dir });
  assert.equal(report.stats.entries, 1);
  assert.equal(report.stats.faceCount.unregistered, 0, '归档行的 mechanism=mutate 不该被当"未登记机制面"');
  assert.deepEqual(report.findings.filter((f) => f.code === 'ADOPT_MECHANISM_UNREGISTERED'), []);
});

test('判据⑤: supersededIds 仍是唯一的"谁被取代"权威（归档行不被取代）', () => {
  const { rows } = mutatedLanding('fold-supersede');
  const sup = supersededIds(rows);
  assert.deepEqual([...sup], ['L-OLD']);
  assert.ok(!sup.has('L-NEW'), '归档行自己是活着的（它承载改后内容）');
});

// ── P2（被治理项目侧提的"`--set` 值没有读者"）────────────────────────────────────
// 他们的实测：`mutate --set mechanism=question` 之后检查器仍读到旧值 ⇒ 把 `question` **静默降级**成 `text`，
// 于是他们**禁用**了这个方法。修法是给读侧补 fold：把归档行的字段值应用回目标 id。

test('判据⑥（P2）: fold 之后 `mutate --set mechanism=question` **必须**被读到', () => {
  const base = {
    schema: 1, ts: '2026-01-01T00:00:00.000Z', rule: 'CAT-P2', category: '技术',
    problem: '原问题', root_cause: 'r', solution: 's', mechanism: 'text', evidence: ['原证据'], status: 'active',
  };
  const rows = [
    { ...base, id: 'L-A', mechanism: 'text' },
    // 真实形态（planMutation 的产物）：归档行 **category = 教训改写**、`mechanism` 直接就是**改后值**；
    // 状态行另起一个 id 且也带 `MUTATES` 标记。
    { ...base, id: 'L-NEW', ts: '2026-02-01T00:00:00.000Z', category: MUTATE_CATEGORY, mechanism: 'question', evidence: ['MUTATES L-A'], problem: '改后的问题' },
    { ...base, id: 'L-NEW-status', ts: '2026-02-01T00:00:00.000Z', category: '状态事件', mechanism: MUTATE_MECHANISM, evidence: ['MUTATES L-A'], problem: 'STATUS_SUPERSEDE L-A' },
    { ...base, id: 'L-C', mechanism: 'text', problem: '另一条不受影响的' },
  ];
  const folded = foldMutates(rows);
  const ids = folded.map((r) => r.id);
  assert.ok(!ids.includes('L-NEW'), '归档行是迁移记录，不进结果');
  assert.ok(!ids.includes('L-NEW-status'), '状态事件行是迁移记录，不进结果');
  const target = folded.find((r) => r.id === 'L-A');
  assert.ok(target !== undefined, '**保留原 id** —— 消费方是按 id 认这条教训的');
  assert.equal(target.mechanism, 'question', '改后的 mechanism 必须被读到（这就是 P2 的验收判据）');
  assert.equal(target.problem, '改后的问题');
  assert.equal(target.category, '技术', '**身份字段不搬**：搬了 category 就会被消费方当迁移记录再排除（改了等于没改）');
  assert.deepEqual(target.evidence, ['原证据'], '证据是追加语义，fold 不改已有证据');
  assert.equal(folded.length, 2, '只剩两条真教训（L-A 改后 + L-C）');
});

test('判据⑦（P2 边界）: 没有 mutate 的账本原样返回（fold 不改无关行为）', () => {
  const rows = [
    { id: 'X', rule: 'R', category: '技术', problem: 'p', mechanism: 'text' },
    { id: 'Y', rule: 'R', category: '技术', problem: 'q', mechanism: 'text' },
  ];
  assert.deepEqual(foldMutates(rows), rows);
});
