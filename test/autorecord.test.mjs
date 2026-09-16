// dsh-rulekeeper · LF-420 **自动记录走 `tools/result`**用例
//
// 判据：绿 = 违规动作（**什么都不写**）→ 账本**自动**出现该条（rule/target/tool/evidence 逐字）；合规动作 → **0 新增行**
//   红 = 合规动作也入账 → 必红；字段缺失 → 必红。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AUTO_GATE, REQUIRED_FIELDS, assertRowFields, autoRecord, classifyResult, extractExecution, pickTarget, shouldRecord } from '../src/autorecord.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const landing = (label) => {
  const dir = tempDir(label);
  const l = join(dir, '.dsh-ai', 'rulekeeper');
  mkdirSync(join(l, 'logs'), { recursive: true });
  return l;
};
const linesOf = (l) => {
  const f = join(l, 'logs', 'gate.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((x) => x.trim() !== '') : [];
};
const EXEC = { name: 'rulekeeper_gate', callId: 'c1', arguments: { file: 'AGENTS.md' } };
const isProtected = (t) => t === 'AGENTS.md';

test('判据: 从真实契约字段抽取（`name` / `arguments`），路径候选名按形状挑', () => {
  assert.equal(pickTarget({ file: 'AGENTS.md' }), 'AGENTS.md');
  assert.equal(pickTarget({ files: ['a.md', 'b.md'] }), 'a.md');
  assert.equal(pickTarget({ other: 1 }), null);
  const ex = extractExecution(EXEC);
  assert.equal(ex.tool, 'rulekeeper_gate');
  assert.equal(ex.target, 'AGENTS.md');
  assert.equal(ex.ok, true);
});

test('判据: 结果三态分类（ok=false / isError / error 存在 → 失败）', () => {
  assert.equal(classifyResult({ ok: true }).ok, true);
  assert.equal(classifyResult({ ok: false }).ok, false);
  assert.equal(classifyResult({ isError: true }).ok, false);
  assert.equal(classifyResult({ error: 'boom' }).ok, false);
  assert.equal(classifyResult(null).ok, false);
});

test('绿（清单原文）: **不写任何东西**动一次受保护路径 → 账本自动出现该条，四字段逐字可读', () => {
  const l = landing('autorec-hit');
  assert.equal(linesOf(l).length, 0);
  const r = autoRecord({ landingDir: l, exec: EXEC, result: { ok: true }, isProtected, hasEvidence: false, evidence: 'AGENTS.md' });
  assert.equal(r.recorded, true, JSON.stringify(r.findings));
  assert.equal(r.delta, 1);
  const rows = linesOf(l);
  assert.equal(rows.length, 1);
  const row = JSON.parse(rows[0]);
  assert.equal(row.gate, AUTO_GATE);
  assert.equal(row.tool, 'rulekeeper_gate');
  assert.equal(row.target, 'AGENTS.md');
  assert.equal(row.rule, 'PROTECTED_WRITE');
  assert.equal(row.evidence, 'AGENTS.md');
  assert.equal(row.outcome, 'fail');
  for (const f of REQUIRED_FIELDS) assert.notEqual(row[f], undefined, `字段 ${f} 必须存在`);
});

test('绿（清单原文）: **合规动作 → 0 新增行**（合规也入账即判红）', () => {
  const l = landing('autorec-clean');
  // ① 有留证的受保护写入
  const r1 = autoRecord({ landingDir: l, exec: EXEC, result: { ok: true }, isProtected, hasEvidence: true });
  assert.equal(r1.recorded, false);
  assert.equal(r1.delta, undefined);
  // ② 非保护路径的成功写入
  const r2 = autoRecord({ landingDir: l, exec: { name: 'rulekeeper_gate', arguments: { file: 'docs/x.md' } }, result: { ok: true }, isProtected });
  assert.equal(r2.recorded, false);
  assert.equal(linesOf(l).length, 0, '合规动作一个字节都不许写进台账');
});

test('绿: 执行失败（无论是否保护路径）→ 记 EXEC_FAILED', () => {
  const l = landing('autorec-fail');
  const r = autoRecord({ landingDir: l, exec: { name: 'rk-check', arguments: {} }, result: { isError: true }, isProtected });
  assert.equal(r.recorded, true);
  assert.equal(JSON.parse(linesOf(l)[0]).rule, 'EXEC_FAILED');
});

test('红（清单红态）: 字段缺失 → 判红（字段级断言）', () => {
  const bad = { schema: 1, ts: 'x', gate: 'g', tool: 't' }; // 缺 target / rule / evidence / outcome
  const r = assertRowFields(bad);
  assert.equal(r.ok, false);
  assert.equal(r.findings.filter((f) => f.code === 'AUTOREC_FIELD_MISSING').length, 4);
  assert.match(r.findings[0].message, /字段级断言/);
});

test('红: exec 契约不符（缺 name / exec 非对象）→ findings 点名，且不写台账', () => {
  const l = landing('autorec-badexec');
  const r = autoRecord({ landingDir: l, exec: { arguments: {} }, result: { ok: true }, isProtected });
  assert.ok(r.findings.some((f) => f.code === 'AUTOREC_TOOL_MISSING'));
  assert.equal(linesOf(l).length, 0);
  assert.equal(extractExecution(null).findings[0].code, 'AUTOREC_EXEC_MISSING');
});

test('判据: 自动记账与门禁台账**同一写入单点**（写前过脱敏，LF-340 贯通）', () => {
  const l = landing('autorec-redact');
  const r = autoRecord({
    landingDir: l,
    exec: { name: 'rulekeeper_gate', arguments: { file: 'AGENTS.md' } },
    result: { ok: true },
    isProtected,
    hasEvidence: false,
    evidence: 'C:\\Users\\zhangsan\\AGENTS.md pw=13800138000',
  });
  assert.equal(r.recorded, true);
  const text = linesOf(l)[0];
  assert.equal(text.includes('zhangsan'), false, '台账里不得出现原文（脱敏单点生效）');
  assert.equal(text.includes('13800138000'), false);
});

test('判据: shouldRecord 只记"失败 / 保护面无留证"两类（其余一律不记）', () => {
  assert.equal(shouldRecord({ exec: EXEC, result: { ok: true }, isProtected, hasEvidence: true }).record, false);
  assert.equal(shouldRecord({ exec: EXEC, result: { ok: true }, isProtected, hasEvidence: false }).rule, 'PROTECTED_WRITE');
  assert.equal(shouldRecord({ exec: EXEC, result: { ok: false }, isProtected, hasEvidence: true }).rule, 'EXEC_FAILED');
});
