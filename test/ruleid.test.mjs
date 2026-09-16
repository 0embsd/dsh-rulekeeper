// dsh-rulekeeper · LF-220 用例：rule 命名规范 / 冲突检测 / 去重键
//
// 判据（清单 LF-220）：①同 rule×target 重复 → 计数只 +1 ②**不同 target 同 rule → 必须 +1**
// 红态：过度去抖（只按 rule 合并）会吞掉真复发 → 本文件用 byRuleOnly 反例证明该守卫有效

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RULE_ID_PATTERN, canonicalRule, dedupe, dedupeKey, detectRuleDivergence,
  projectSha256, projectTarget, ruleFragmentation, validateRuleId,
} from '../src/ruleid.mjs';

test('canonicalRule / validateRuleId：规范形与非法值', () => {
  assert.equal(canonicalRule('fact-writing'), 'FACT-WRITING');
  assert.equal(canonicalRule('  Fact_Writing  '), 'FACT-WRITING');
  assert.equal(canonicalRule('a--b'), 'A-B');
  assert.equal(canonicalRule('-x-'), 'X');
  assert.equal(canonicalRule(''), '');
  assert.equal(canonicalRule(null), '');
  assert.equal(RULE_ID_PATTERN.test('CAT-TECH'), true);
  assert.equal(validateRuleId('fact-writing').ok, true, '小写只是"两种写法"问题，不是非法');
  assert.equal(validateRuleId('CAT-技术').ok, false, '中文不属于规范形');
  assert.equal(validateRuleId('').ok, false);
  assert.equal(validateRuleId('1ABC').ok, false, '必须以字母开头');
});

test('dedupeKey：空分量显式占位（避免"空 = 任意"的隐式合并）', () => {
  assert.equal(dedupeKey({ rule: 'fact-writing', target: 'A.TXT', sha256: 'AB' }), 'FACT-WRITING|a.txt|ab');
  assert.equal(dedupeKey({}), 'UNSPECIFIED|NO-TARGET|NO-SHA');
  assert.notEqual(dedupeKey({ rule: 'R' }), dedupeKey({ rule: 'R', target: 'x' }));
});

test('判据①：同 rule × target × sha256 重复 -> 合并为 count（不是 N 行）', () => {
  const rows = [
    { id: 'A1', rule: 'FACT-WRITING', target: 'a.txt', sha256: 'aa' },
    { id: 'A2', rule: 'fact_writing', target: 'A.TXT', sha256: 'AA' },
  ];
  const { groups, collapsed } = dedupe(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 2);
  assert.deepEqual(groups[0].ids, ['A1', 'A2']);
  assert.equal(collapsed, 1);
});

test('判据②：不同 target 同 rule -> 必须各算一次（不得合并）', () => {
  const rows = [
    { id: 'A1', rule: 'FACT-WRITING', target: 'a.txt', sha256: 'aa' },
    { id: 'A2', rule: 'FACT-WRITING', target: 'b.txt', sha256: 'aa' },
  ];
  const { groups } = dedupe(rows);
  assert.equal(groups.length, 2, '不同 target 必须分开');
  assert.deepEqual(groups.map((g) => g.count), [1, 1]);
});

test('判据②补充：同 rule 同 target 但内容不同（sha 不同）-> 也必须各算一次', () => {
  const rows = [
    { id: 'A1', rule: 'FACT-WRITING', target: 'a.txt', sha256: 'aa' },
    { id: 'A2', rule: 'FACT-WRITING', target: 'a.txt', sha256: 'bb' },
  ];
  assert.equal(dedupe(rows).groups.length, 2);
});

test('red: 过度去抖（只按 rule 合并）会吞真复发 -> 守卫必须能识别', () => {
  const rows = [
    { id: 'A1', rule: 'FACT-WRITING', target: 'a.txt', sha256: 'aa' },
    { id: 'A2', rule: 'FACT-WRITING', target: 'b.txt', sha256: 'bb' },
    { id: 'A3', rule: 'PS-OUTPUT-STREAM', target: 'c.txt', sha256: 'cc' },
  ];
  const good = dedupe(rows);
  const bad = dedupe(rows, { byRuleOnly: true });
  assert.equal(good.groups.length, 3, '正解：三个不同 (rule,target,sha) 各自成组');
  assert.equal(bad.groups.length, 2, '反例：只按 rule 合并 -> 两条不同 target 被吞成一组');
  assert.equal(bad.groups.find((g) => g.rule === 'FACT-WRITING').count, 2);
  // 于是"计数只 +1"这条判据在反例下会被误判为"没复发" —— 这正是要防的
  assert.notDeepEqual(good.groups.map((g) => g.count), bad.groups.map((g) => g.count));
});

test('detectRuleDivergence：同一条纪律两种写法必须被抓出', () => {
  const rows = [
    { id: 'A1', rule: 'FACT-WRITING' },
    { id: 'A2', rule: 'fact-writing' },
    { id: 'A3', rule: 'fact_writing' },
    { id: 'A4', rule: 'PS-OUTPUT-STREAM' },
  ];
  const div = detectRuleDivergence(rows);
  assert.equal(div.length, 1);
  assert.equal(div[0].canonical, 'FACT-WRITING');
  assert.deepEqual(div[0].variants, ['FACT-WRITING', 'fact-writing', 'fact_writing']);
  assert.deepEqual(div[0].ids, ['A1', 'A2', 'A3']);
});

test('projectTarget / projectSha256：投影规则是文档化的', () => {
  assert.equal(projectTarget({ target: ' x.txt ' }), 'x.txt');
  assert.equal(projectTarget({ evidence: ['', 'a/b.md'] }), 'a/b.md');
  assert.equal(projectTarget({}), '(none)');
  assert.equal(projectSha256({ sha256: 'AABB' }), 'aabb');
  const h1 = projectSha256({ problem: 'p', solution: 's' });
  const h2 = projectSha256({ problem: 'p', solution: 's' });
  const h3 = projectSha256({ problem: 'p2', solution: 's' });
  assert.equal(h1, h2, '同内容同哈希');
  assert.notEqual(h1, h3, '不同内容不同哈希');
  assert.match(h1, /^[0-9a-f]{64}$/);
});

test('ruleFragmentation：同一 rule 被拆成多个键（去重键过严的信号）', () => {
  const rows = [
    { id: 'A1', rule: 'FACT-WRITING', target: 'a', sha256: '1' },
    { id: 'A2', rule: 'FACT-WRITING', target: 'b', sha256: '2' },
    { id: 'A3', rule: 'PS-OUTPUT-STREAM', target: 'c', sha256: '3' },
  ];
  const frag = ruleFragmentation(rows);
  assert.equal(frag.length, 1);
  assert.deepEqual(frag[0], { rule: 'FACT-WRITING', keyCount: 2 });
});
