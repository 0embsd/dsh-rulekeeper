// dsh-rulekeeper · LF-120 用例：schema v1 冻结单（字段表 / 版本字段 / 派生规则 / 文档防漂移）
//
// 判据（清单 LF-120）：
//   ①6 个文件逐文件字段表齐备（ledger 13 字段与方案 §3 逐个一致 + schema 版本字段）
//   ②rules 6 字段（含 project——双本判别依据）
//   ③每个文件有版本字段；可变聚合字段**一律派生**（禁原地更新）
// 红态：删文件 / 删 project / 标原地更新 / 文档漂移 各一例

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FILES, LEDGER_PLAN_FIELDS, LEDGER_ROW_WRITE_INVARIANTS, SCHEMA_VERSION, checkSchema, renderSchemaMarkdown } from '../src/schema.mjs';
import { PKG_ROOT, cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

test('schema：真实冻结单通过自检（含 SCHEMA.md 与代码一致）', () => {
  const report = checkSchema({ root: PKG_ROOT, checkDoc: true });
  assert.deepEqual(report.findings, []);
  assert.equal(report.ok, true);
});

test('schema：冻结 7 个文件（2026-09-19 契约变更 +activations.jsonl），且每个文件都有版本字段', () => {
  assert.equal(FILES.length, 7);
  assert.deepEqual(
    FILES.map((f) => f.name).sort(),
    ['activations.jsonl', 'config.json', 'findings.jsonl', 'ledger.jsonl', 'proposals/<id>.json', 'rules.json', 'snapshots/index.jsonl'],
  );
  for (const file of FILES) {
    assert.ok(file.fields.some((f) => f.name === file.versionField), `${file.name} 缺版本字段 ${file.versionField}`);
  }
});

test('schema：ledger 含方案 13 字段 + schema 版本字段（逐个一致）', () => {
  const ledger = FILES.find((f) => f.name === 'ledger.jsonl');
  const names = ledger.fields.map((f) => f.name);
  for (const field of LEDGER_PLAN_FIELDS) assert.ok(names.includes(field), `ledger 缺字段 ${field}`);
  // 基线契约（计划 §3 的 13 字段）**不得增删**；新增只能走显式扩展位，且必须是可选字段。
  // 2026-09-19：`activation`（P0-2 可判激活条件）即通过该机制加入 ⇒ 期望数 = 13 + 扩展数。
  const ext = ledger.extensions ?? [];
  assert.equal(
    names.filter((n) => n !== 'schema').length,
    13 + ext.length,
    '字段数必须 = 计划 13 + 显式扩展数（不许悄悄加字段，也不许悄悄删基线字段）',
  );
  for (const e of ext) {
    assert.ok(names.includes(e), `扩展字段 ${e} 未出现在 fields 表里`);
    const f = ledger.fields.find((x) => x.name === e);
    assert.equal(f.required, false, `扩展字段 ${e} 必须是可选（required:false）——加法不得破坏既有行形状`);
  }
  assert.equal(SCHEMA_VERSION, 1);
});

test('schema：rules 6 字段含 project；可变聚合字段均有派生规则', () => {
  const rules = FILES.find((f) => f.name === 'rules.json');
  assert.deepEqual(
    rules.fields.map((f) => f.name),
    ['schema', 'project', 'protected_paths', 'gates', 'checks', 'inject'],
  );
  for (const file of FILES) {
    const derived = new Set((file.derived ?? []).map((d) => d.field));
    for (const f of file.fields.filter((x) => x.mutable === true)) {
      assert.ok(derived.has(f.name), `${file.name}.${f.name} 标了可变但没有派生规则`);
    }
  }
});

test('schema：markdown 渲染确定性（两次生成逐字相同）', () => {
  assert.equal(renderSchemaMarkdown(), renderSchemaMarkdown());
});

test('red: 少一个文件 → SCHEMA_FILE_COUNT', () => {
  const report = checkSchema({ files: FILES.slice(0, 5) });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((f) => f.code === 'SCHEMA_FILE_COUNT'));
});

test('red: 文件被改名 → SCHEMA_FILE_NAME_UNKNOWN', () => {
  const files = FILES.map((f) => (f.name === 'findings.jsonl' ? { ...f, name: 'findings.jsonl.bak' } : f));
  const report = checkSchema({ files });
  assert.ok(report.findings.some((f) => f.code === 'SCHEMA_FILE_NAME_UNKNOWN'));
});

test('red: rules 丢 project → SCHEMA_REQUIRED_FIELD_MISSING', () => {
  const files = FILES.map((f) => (f.name === 'rules.json'
    ? { ...f, fields: f.fields.filter((x) => x.name !== 'project') }
    : f));
  const report = checkSchema({ files });
  assert.ok(report.findings.some((f) => f.code === 'SCHEMA_REQUIRED_FIELD_MISSING'));
});

test('red: append-only 文件里标原地更新 → SCHEMA_INPLACE_MUTATION', () => {
  const files = FILES.map((f) => (f.name === 'ledger.jsonl'
    ? { ...f, fields: f.fields.map((x) => (x.name === 'recurrence' ? { ...x, mutableInPlace: true } : x)) }
    : f));
  const report = checkSchema({ files });
  assert.ok(report.findings.some((f) => f.code === 'SCHEMA_INPLACE_MUTATION'));
});

test('red: 可变字段缺派生规则 → SCHEMA_DERIVED_RULE_MISSING', () => {
  const files = FILES.map((f) => (f.name === 'ledger.jsonl'
    ? { ...f, derived: f.derived.filter((d) => d.field !== 'recurrence') }
    : f));
  const report = checkSchema({ files });
  assert.ok(report.findings.some((f) => f.code === 'SCHEMA_DERIVED_RULE_MISSING'));
});

test('red: SCHEMA.md 漂移（改 1 字节）→ SCHEMA_DOC_DRIFT', () => {
  const root = tempDir('schema-drift');
  writeFileSync(join(root, 'SCHEMA.md'), `${renderSchemaMarkdown()}x`, 'utf8');
  const report = checkSchema({ root, checkDoc: true });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((f) => f.code === 'SCHEMA_DOC_DRIFT'));
});

test('red: 缺 SCHEMA.md → SCHEMA_DOC_MISSING', () => {
  const root = join(tempDir('schema-missing'), 'empty');
  mkdirSync(root, { recursive: true });
  const report = checkSchema({ root, checkDoc: true });
  assert.ok(report.findings.some((f) => f.code === 'SCHEMA_DOC_MISSING'));
});

// ── 行内写入不变式（2026-09-19：修"行内 recurrence 恒 1"与"派生：同 rule 行数"的口径矛盾）──

test('schema：行内不变式只挂在"可变 + 有派生规则"的 ledger 字段上（真实冻结单自证）', () => {
  const ledger = FILES.find((f) => f.name === 'ledger.jsonl');
  const derived = new Set(ledger.derived.map((d) => d.field));
  assert.ok(LEDGER_ROW_WRITE_INVARIANTS.length > 0, '不变式表不得为空（否则等于没有机械面）');
  for (const inv of LEDGER_ROW_WRITE_INVARIANTS) {
    const f = ledger.fields.find((x) => x.name === inv.field);
    assert.ok(f, `不变式字段 ${inv.field} 不在 ledger 字段表里`);
    assert.equal(f.mutable, true, `${inv.field} 若不标可变，就不该有条目级派生读法`);
    assert.ok(derived.has(inv.field), `${inv.field} 有行内不变式却没有派生规则 ⇒ 聚合该从哪读没交代`);
    assert.ok(['error', 'warn'].includes(inv.level), `${inv.field} 的违反级别非法`);
    assert.equal(typeof inv.equals, 'function');
  }
});

test('schema：status 不做常数不变式（导入的历史行可出生即 superseded ⇒ 做了就是假红）', () => {
  assert.equal(
    LEDGER_ROW_WRITE_INVARIANTS.some((inv) => inv.field === 'status'),
    false,
    'status 实测 active 374 + superseded 14，不能当常数核对',
  );
});

test('red: 行内不变式指向不存在的字段 → SCHEMA_ROW_INVARIANT_UNKNOWN', () => {
  const report = checkSchema({ rowInvariants: [{ ...LEDGER_ROW_WRITE_INVARIANTS[0], field: 'no_such_field' }] });
  assert.ok(report.findings.some((f) => f.code === 'SCHEMA_ROW_INVARIANT_UNKNOWN'));
});

test('red: 行内不变式字段不再标可变/派生 → SCHEMA_ROW_INVARIANT_NOT_DERIVED', () => {
  const files = FILES.map((f) => (f.name === 'ledger.jsonl'
    ? { ...f, derived: f.derived.filter((d) => d.field !== 'recurrence') }
    : f));
  const report = checkSchema({ files, rowInvariants: LEDGER_ROW_WRITE_INVARIANTS });
  assert.ok(report.findings.some((f) => f.code === 'SCHEMA_ROW_INVARIANT_NOT_DERIVED'));
});

test('red: 行内不变式缺 level/why/equals → SCHEMA_ROW_INVARIANT_NOT_DESCRIBED', () => {
  const report = checkSchema({ rowInvariants: [{ ...LEDGER_ROW_WRITE_INVARIANTS[0], why: '   ', equals: undefined }] });
  assert.ok(report.findings.some((f) => f.code === 'SCHEMA_ROW_INVARIANT_NOT_DESCRIBED'));
});

test('schema：行内 vs 派生 的口径必须写进 SCHEMA.md（生成物含 2.1 节与不变式表）', () => {
  const md = renderSchemaMarkdown();
  assert.ok(md.includes('行内值 ≠ 聚合值'), 'SCHEMA.md 缺口径更正节');
  for (const inv of LEDGER_ROW_WRITE_INVARIANTS) {
    assert.ok(md.includes(`\`${inv.field}\` | \`${inv.expect}\``), `不变式表缺 ${inv.field} 行`);
  }
});
