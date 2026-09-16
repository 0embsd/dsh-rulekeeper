// dsh-rulekeeper · LF-210 用例：旧账本导入（只读兼容 + rule 回填）
//
// 判据（清单 LF-210）：①固定样本可查 ②`rule 为空` 计数 == 0
// 红态：回填后同族（L450/L455）**仍无法归同 rule** → 必须能被抓出（本文件用"抽掉词表"证明该判据非恒真）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CATEGORY_CODES, importLedger, inferRule, loadLegacy, mapLegacyEntry,
} from '../src/importer.mjs';
import { readLedger, record } from '../src/ledger.mjs';
import { validateRuleId } from '../src/ruleid.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const FACT_A = {
  id: 'L450', ts: '2026-09-14T00:00:00.000Z', category: '流程',
  problem: '设计单凭印象写事实（未取证即下结论）', root_cause: '未取证即下结论', solution: '固化事实写作律',
  verification: '凭证 X', commit: '', source: 'self-audit', status: 'active',
};
const FACT_B = {
  id: 'L455', ts: '2026-09-14T00:00:01.000Z', category: '流程',
  problem: '同类错第 N 次复发：未取证即下结论 6 次', root_cause: '取证不足', solution: '机械化检查',
  verification: '自证清单', commit: '', source: 'L450 复发', status: 'active',
};
const PATH_C = {
  id: 'L412', ts: '2026-09-14T00:00:02.000Z', category: '代码',
  problem: '文件名未净化导致伪目录', root_cause: '路径分隔符未处理', solution: '净化文件名并折叠分隔符',
  verification: '实证输出', commit: 'abc1234', source: '', status: 'fixed',
};
const NO_KW = {
  id: 'L900', ts: '2026-09-14T00:00:03.000Z', category: '文档',
  problem: '文档措辞', root_cause: '习惯', solution: '改', verification: '', commit: '', source: '', status: 'active',
};

function legacyFile(label, entries) {
  const dir = tempDir(label);
  const file = join(dir, 'lessons.json');
  writeFileSync(file, JSON.stringify({ schema: 1, updated: '2026-09-14', note: 'test', entries }, null, 2), 'utf8');
  return file;
}

function landing(label) {
  const dir = join(tempDir(label), 'landing');
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('loadLegacy：只读解析；坏文件返回 error 而不抛', () => {
  const file = legacyFile('i-load', [FACT_A]);
  const ok = loadLegacy(file);
  assert.equal(ok.ok, true);
  assert.equal(ok.entries.length, 1);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).entries[0].id, 'L450', '只读：文件内容未变');
  const bad = loadLegacy(join(tempDir('i-bad'), 'nope.json'));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /ENOENT/);
});

test('inferRule：同族两条（L450/L455）必须归同一 rule；跨族不串', () => {
  const a = inferRule(FACT_A);
  const b = inferRule(FACT_B);
  const c = inferRule(PATH_C);
  assert.equal(a.rule, 'FACT-WRITING');
  assert.equal(b.rule, 'FACT-WRITING');
  assert.equal(a.rule, b.rule, '同族必须同 rule（LF-210 红态判据的反面）');
  assert.equal(c.rule, 'PATH-SANITIZE');
  assert.notEqual(a.rule, c.rule);
  for (const r of [a, b, c]) assert.equal(validateRuleId(r.rule).ok, true);
  assert.equal(a.fallback, false);
});

test('inferRule：无关键词 -> CAT-<类别码> 兜底（保证 rule 不为空）', () => {
  const r = inferRule(NO_KW);
  assert.equal(r.fallback, true);
  assert.equal(r.rule, `CAT-${CATEGORY_CODES['文档']}`);
  assert.equal(validateRuleId(r.rule).ok, true);
  assert.equal(inferRule({ category: '不存在的类' }).rule, 'CAT-UNCLASSIFIED');
});

test('red: 词表偏斜 -> 同族会分裂（证明「同族同 rule」判据对词表敏感，非恒真）', () => {
  // 把「事实写作」与「复发」拆给两个不同族 -> 同族两条会被判到不同 rule
  const skewed = [
    { rule: 'FACT-WRITING', keywords: ['事实写作'] },
    { rule: 'PROCESS-ORDER', keywords: ['复发'] },
  ];
  const a = inferRule(FACT_A, { vocabulary: skewed });
  const b = inferRule(FACT_B, { vocabulary: skewed });
  assert.equal(a.rule, 'FACT-WRITING');
  assert.equal(b.rule, 'PROCESS-ORDER');
  assert.notEqual(a.rule, b.rule, '同族被拆到两个 rule -> LF-210 的红态判据（同族同 rule）会报红');
});

test('mapLegacyEntry：problem/solution 逐字保留；evidence 由 verification/commit/source 组装', () => {
  const mapped = mapLegacyEntry(PATH_C);
  assert.equal(mapped.entry.problem, PATH_C.problem, '逐字保留');
  assert.equal(mapped.entry.solution, PATH_C.solution, '逐字保留');
  assert.deepEqual(mapped.entry.evidence, ['实证输出', 'abc1234']);
  assert.equal(mapped.entry.root_cause, PATH_C.root_cause);
  assert.equal(mapped.entry.ts, PATH_C.ts);
  assert.equal(mapped.entry.first_seen, PATH_C.ts);
  assert.equal(mapped.entry.recurrence, 1);
  assert.equal(mapped.entry.mechanism, 'text');
  assert.equal(mapped.entry.status, 'active');
  assert.equal(mapped.statusRemapped, true, 'legacy 的 fixed 越出冻结枚举，必须计数上报');
  assert.deepEqual(Object.keys(mapped.entry).sort(), [
    'category', 'evidence', 'first_seen', 'id', 'last_seen', 'mechanism', 'problem',
    'recurrence', 'root_cause', 'rule', 'schema', 'solution', 'status', 'ts',
  ]);
});

test('importLedger：dry-run 只统计不写盘', () => {
  const file = legacyFile('i-dry', [FACT_A, FACT_B, PATH_C, NO_KW]);
  const dir = landing('i-dry');
  const report = importLedger({ legacyFile: file, landingDir: dir, dryRun: true });
  assert.equal(report.ok, true);
  assert.equal(report.total, 4);
  assert.equal(report.imported, 4);
  assert.equal(report.fallbackCount, 1);
  assert.equal(readLedger(dir).values.length, 0, 'dry-run 不得写盘');
});

test('importLedger：真导入 -> rule 为空计数 == 0；重复 id 被报出；重复导入幂等', () => {
  const file = legacyFile('i-real', [FACT_A, FACT_B, PATH_C, NO_KW, { ...NO_KW, problem: '第二条同 id' }]);
  const dir = landing('i-real');
  const first = importLedger({ legacyFile: file, landingDir: dir });
  assert.equal(first.ok, true);
  assert.equal(first.total, 5);
  assert.equal(first.imported, 4, '重复 id 的第二条被跳过');
  assert.deepEqual(first.duplicateIds, ['L900']);
  assert.ok(first.findings.some((f) => f.code === 'IMPORT_DUPLICATE_ID'));
  assert.equal(first.statusRemapped, 1);

  const read = readLedger(dir);
  assert.equal(read.values.length, 4);
  assert.equal(read.badLines, 0);
  const emptyRule = read.values.filter((e) => typeof e.rule !== 'string' || e.rule.trim() === '').length;
  assert.equal(emptyRule, 0, 'LF-210 判据②：rule 为空计数必须为 0');

  const second = importLedger({ legacyFile: file, landingDir: dir });
  assert.equal(second.imported, 0);
  assert.equal(second.skippedExisting, 4, '幂等：已有同 id 一律跳过');
  assert.equal(readLedger(dir).values.length, 4);
});

test('importLedger：写入失败时以 error 级 finding 报出且 ok=false', () => {
  const file = legacyFile('i-fail', [FACT_A]);
  const dir = landing('i-fail');
  // 目标 ledger 变成一个目录 -> append 必失败
  mkdirSync(join(dir, 'ledger.jsonl'), { recursive: true });
  const report = importLedger({ legacyFile: file, landingDir: dir });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((f) => f.code === 'IMPORT_WRITE_FAIL'));
  assert.equal(report.imported, 0);
});

test('legacy 缺必填字段 -> 跳过并逐条列出（不静默丢、也不误报 error）', () => {
  const noRootCause = { ...FACT_A, id: 'L061', root_cause: '' };
  const file = legacyFile('i-invalid', [FACT_A, noRootCause, PATH_C]);
  const dir = landing('i-invalid');
  const report = importLedger({ legacyFile: file, landingDir: dir });
  assert.equal(report.total, 3);
  assert.equal(report.imported, 2, '缺字段的那条不进账本');
  assert.equal(report.skippedInvalid, 1);
  assert.deepEqual(report.invalidIds, ['L061']);
  assert.equal(report.ok, true, '数据质量问题用 warn 级上报，不是 error');
  const finding = report.findings.find((f) => f.code === 'IMPORT_SKIPPED_INVALID_FIELD');
  assert.ok(finding, '必须有一个 warn 级 finding 说明跳过了什么');
  assert.equal(finding.level, 'warn');
  assert.match(finding.msg, /L061/);
  assert.equal(readLedger(dir).values.length, 2);
});

test('集成：导入后的行能被 ledger 的派生计数与查询直接用', () => {
  const file = legacyFile('i-integrate', [FACT_A, FACT_B]);
  const dir = landing('i-integrate');
  importLedger({ legacyFile: file, landingDir: dir });
  const entries = readLedger(dir).values;
  assert.equal(entries.filter((e) => e.rule === 'FACT-WRITING').length, 2, '同族归同 rule 后可计数');
  // 导入后仍可继续追加（注意：record 要的是 **ledger 形状**，不是 legacy 条目形状）
  const appended = record(
    { id: 'L999', rule: 'PATH-SANITIZE', category: '代码', problem: 'p', root_cause: 'r', solution: 's', mechanism: 'text' },
    { landingDir: dir },
  );
  assert.equal(appended.ok, true, appended.reason ?? '');
  assert.equal(readLedger(dir).values.length, 3);
  // 反向：legacy 形状直接喂 record 必须被拒（防"两种形状混用"的静默错误）
  const wrongShape = record(PATH_C, { landingDir: dir });
  assert.equal(wrongShape.ok, false);
  assert.match(wrongShape.reason, /字段不合法/);
});
