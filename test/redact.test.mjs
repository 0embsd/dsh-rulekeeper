// dsh-rulekeeper · LF-340 **脱敏**用例
//
// 判据（清单 LF-340 行）：
//   绿 = 含隐私/凭据的教训写入后，落点内**零命中原文**（只出现占位符）；`--check` 对含原文的产物 exit≠0 且**只打印规则名/行号/计数**；
//        `--self-control` 正对照输出非空。
//   红 = ① 原文能 Select-String 到 ② 二次脱敏破坏占位符（非幂等）③ 规则表出现第二份 ④ 扫描器对必然命中的样本报 0 命中
//        ⑤ 规则与样本不同步未 throw ⑥ 规则表为空/自测失败仍报通过。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runRedact, runRulekeeper } from '../src/cli.mjs';
import { record } from '../src/ledger.mjs';
import { closeGate } from '../src/gate.mjs';
import { proposalPath, writeProposal } from '../src/proposal.mjs';
import { RULES, scanText, selfTestRules, statsOf, redactText, redactValue, PLACEHOLDER_RE } from '../src/redact.mjs';
import { RC } from '../src/rc.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

function capture(fn) {
  let out = '';
  let err = '';
  const rc = fn({ out: (t) => { out += String(t); }, err: (t) => { err += String(t); } });
  return { rc, out, err };
}
const redact = (args) => capture((io) => runRedact(args, io, {}));

const PII = 'C:\\Users\\zhangsan\\proj 13800138000 zhang.san@example.com';
const SECRET = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 password=hunter2secret';

test('判据: 规则表加载即自测（样本与规则同源）；规则表非空', () => {
  const r = selfTestRules();
  assert.equal(r.rules, RULES.length + 1, 'RULES + IDENTITY_RULES');
  assert.ok(RULES.length >= 8);
  assert.equal(statsOf([{ rule: 'A', count: 2 }, { rule: 'A', count: 1 }]).byRule[0].count, 3, '同类命中合并');
});

test('绿: 文本脱敏后**不含原文**，且出现占位符；统计只出计数', () => {
  const r = redactText(`${PII} ${SECRET}`);
  assert.equal(r.text.includes('zhangsan'), false);
  assert.equal(r.text.includes('13800138000'), false);
  assert.equal(r.text.includes('zhang.san@example.com'), false);
  assert.equal(r.text.includes('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'), false);
  assert.equal(r.text.includes('hunter2secret'), false);
  assert.match(r.text, PLACEHOLDER_RE);
  const s = statsOf(r.hits);
  assert.ok(s.total >= 5, `至少命中 5 处（路径/手机号/邮箱/凭据/键值赋值），实得 ${s.total}`);
  assert.equal(JSON.stringify(s).includes('zhangsan'), false, '统计里**不得**出现原文');
});

test('判据（幂等）: 对已脱敏文本再脱敏一次 → 逐字相同（占位符不被二次破坏）', () => {
  const once = redactText(`${PII} ${SECRET}`).text;
  const twice = redactText(once).text;
  assert.equal(twice, once, '二次脱敏必须幂等');
});

test('判据（同值同摘要）: 同一原文出现两次 → 同一占位符（可跨行核对，但不可逆）', () => {
  const out = redactText('a zhang.san@example.com b zhang.san@example.com').text;
  const tags = out.match(/\[EMAIL:[0-9a-f]{12}\]/g) ?? [];
  assert.equal(tags.length, 2);
  assert.equal(tags[0], tags[1]);
});

test('判据（identity 默认关）: 身份证默认不脱敏；`identity:true` 才脱敏', () => {
  const id = '11010119900307123X';
  assert.equal(redactText(id).text.includes(id), true, '默认关（需实体库，不假装处理过）');
  assert.equal(redactText(id, { identity: true }).text.includes(id), false, '显式打开才处理');
});

test('红: 规则表为空 → 抛错（fail-closed：没有规则就不许声称"已脱敏"）', () => {
  assert.throws(() => redactText('x', { rules: [] }), /规则表为空/);
});

test('红: `--check` 对含原文的产物 exit≠0，且**只打印规则名/行号/计数**（不打印原文）', () => {
  const dir = tempDir('redact-check');
  const landing = join(dir, '.dsh-ai', 'rulekeeper');
  mkdirSync(join(landing, 'logs'), { recursive: true });
  writeFileSync(join(landing, 'ledger.jsonl'), `${JSON.stringify({ problem: PII, solution: SECRET })}\n`, 'utf8');
  const r = redact(['--check', '--project', dir]);
  assert.equal(r.rc, RC.FAIL, r.out);
  assert.match(r.out, /^RESIDUAL (PATH_HOME|PHONE_CN|EMAIL|CRED_KEY|CRED_ASSIGN) /m);
  assert.equal(r.out.includes('zhangsan'), false, '扫描器自己不许泄漏原文');
  assert.equal(r.out.includes('hunter2secret'), false);
  // 正对照：干净产物 → exit=0
  writeFileSync(join(landing, 'ledger.jsonl'), `${JSON.stringify({ problem: '无隐私内容' })}\n`, 'utf8');
  assert.equal(redact(['--check', '--project', dir]).rc, RC.OK);
});

test('红: `--self-control` 正对照必须命中 >0（防"扫描器坏了却报零命中"的假绿）', () => {
  const r = redact(['--self-control']);
  assert.equal(r.rc, RC.OK, r.out);
  const m = /^RK_REDACT_SELF_CONTROL_HITS=(\d+)$/m.exec(r.out);
  assert.notEqual(m, null);
  assert.ok(Number(m[1]) > 0);
});

test('绿（写入侧单点）: 含隐私/凭据的教训落盘后，台账文件里**零命中原文**', () => {
  const dir = tempDir('redact-ledger');
  const landing = join(dir, '.dsh-ai', 'rulekeeper');
  mkdirSync(landing, { recursive: true });
  const r = record({
    problem: `本地路径 ${PII}`,
    root_cause: `凭据泄漏 ${SECRET}`,
    solution: '用 rk-redact 写入侧收敛',
    verification: '--check 零命中',
    rule: 'PS-OUTPUT-STREAM',
    mechanism: 'rk-redact 写入侧单点',
    category: '代码',
    source: 'LF-340',
  }, { landingDir: landing });
  assert.equal(r.ok, true, r.reason);
  assert.ok(r.redacted.length > 0, '写入时应当报告脱敏计数');
  const text = readFileSync(join(landing, 'ledger.jsonl'), 'utf8');
  for (const raw of ['zhangsan', '13800138000', 'zhang.san@example.com', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 'hunter2secret']) {
    assert.equal(text.includes(raw), false, `台账里不得出现原文: ${raw}`);
  }
  assert.match(text, PLACEHOLDER_RE);
  assert.equal(redact(['--check', '--project', dir]).rc, RC.OK, '写入侧脱敏后，扫描应当干净');
});

test('判据: 对象脱敏只动字符串值，不动字段名（契约稳定）', () => {
  const out = redactValue({ problem: 'a@b.com', rule: 'PS-OUTPUT-STREAM', n: 1 }).value;
  assert.deepEqual(Object.keys(out), ['problem', 'rule', 'n']);
  assert.equal(out.rule, 'PS-OUTPUT-STREAM');
  assert.equal(out.n, 1);
  assert.equal(out.problem.includes('a@b.com'), false);
});

test('判据: 两个入口同源（`rk-redact` 与 `dsh-rulekeeper redact` 逐字同输出）', () => {
  const a = redact(['--text', PII, '--json']);
  const b = capture((io) => runRulekeeper(['redact', '--text', PII, '--json'], io, {}));
  assert.equal(a.out, b.out);
  assert.equal(a.rc, b.rc);
});

test('rc: `--help`=0；未知参数/缺少动作 = 2', () => {
  assert.equal(redact(['--help']).rc, RC.OK);
  assert.equal(redact(['--bogus']).rc, RC.USAGE);
  assert.equal(redact([]).rc, RC.USAGE);
});

test('绿（Q1 收尾·门禁台账）: 台账行里的自由文本写入前已脱敏（原文 0 命中）', () => {
  const dir = tempDir('redact-gate-ledger');
  const landing = join(dir, '.dsh-ai', 'rulekeeper');
  mkdirSync(landing, { recursive: true });
  // 先把该纪律写进账本（closeGate 要求纪律真实存在）
  assert.equal(record({ problem: 'seed', root_cause: 'seed', solution: 'seed', verification: 'seed', rule: 'CAT-VERIFY', mechanism: 'test', category: '验证', source: 'seed' }, { landingDir: landing }).ok, true);
  const r = closeGate({
    projectRoot: dir,
    landingDir: landing,
    hits: [{ rule: 'CAT-VERIFY', stoppedBy: 'test' }],
    none: false,
    batch: `${PII} ${SECRET}`,
    evidence: [],
    now: new Date('2026-09-15T00:00:00Z'),
  });
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  const led = readFileSync(join(landing, 'logs', 'gate.jsonl'), 'utf8');
  for (const raw of ['zhangsan', '13800138000', 'zhang.san@example.com', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 'hunter2secret']) {
    assert.equal(led.includes(raw), false, `门禁台账不得出现原文: ${raw}`);
  }
});

test('绿（Q1 收尾·提案正文）: proposals/<id>.json 写入前已脱敏', () => {
  const dir = tempDir('redact-proposal');
  const landing = join(dir, '.dsh-ai', 'rulekeeper');
  mkdirSync(landing, { recursive: true });
  const values = {
    schema: 1,
    id: 'P-20260915-000001',
    rule: 'CAT-VERIFY',
    createdAt: '2026-09-15T00:00:00.000Z',
    status: 'proposed',
    source: 'auto',
    redCriteria: `复发样本里带了隐私 ${PII}`,
    counterExample: `反例里带了凭据 ${SECRET}`,
    falsePositiveSurface: '可能误红',
    activationCheck: '启用前跑一遍夹具',
  };
  const w = writeProposal(landing, values);
  assert.equal(w.ok, true, JSON.stringify(w));
  const text = readFileSync(proposalPath(landing, values.id), 'utf8');
  for (const raw of ['zhangsan', '13800138000', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 'hunter2secret']) {
    assert.equal(text.includes(raw), false, `提案不得出现原文: ${raw}`);
  }
});
