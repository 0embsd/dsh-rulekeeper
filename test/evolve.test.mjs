// dsh-rulekeeper · LF-280（提案闸：先于写者）+ LF-290（复发 ≥2 → 提案）+ LF-295（提案质量门）
//
// 判据（清单 §3）：
//   LF-280：跑 evolve 后 `rules.json` **字节不变**（sha256 相同）——本文件用"整个落点除 proposals/ 外的字节指纹"加强版
//   LF-290：同 rule 复发 2 次 → **必产** `proposals/<id>.json`；复发 1 次 → **不得产**（负样本）
//   LF-295：提案四要件（redCriteria/counterExample/falsePositiveSurface/activationCheck）缺一 → exit≠0；
//           `source=auto` 单独触发"升门禁" → exit≠0（闸门本身不可被 AI 直接改）
// 红态：见各 `红态：` 用例；凭证里另有变异测试（把 evolve 改成顺手写 rules.json 等）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runRulekeeper } from '../src/cli.mjs';
import { RC } from '../src/rc.mjs';
import {
  PROPOSAL_QUALITY_FIELDS, RECURRENCE_THRESHOLD,
  buildProposal, listProposals, proposalFieldNames, validateProposalValues, writeProposal,
} from '../src/proposal.mjs';
import { cleanupAll, freshLanding, ledgerEntry } from './helpers/sandbox.mjs';

const { rmSync: require_fs_rm } = { rmSync };
function require_fs() { return { rmSync: require_fs_rm }; }

test.after(cleanupAll);

const QUALITY = Object.freeze({
  redCriteria: '新判据：同族两种写法入账 -> families MISMATCH exit=1',
  counterExample: 'test/fixtures/checks/untracked-violation/target.txt',
  falsePositiveSurface: '只对受保护路径生效；纯文本仓库不触发',
  activationCheck: 'node --test test/evolve.test.mjs + rk-rc --check',
});

function capture(fn) {
  let out = '';
  let err = '';
  const rc = fn({ out: (t) => { out += String(t); }, err: (t) => { err += String(t); } });
  return { rc, out, err };
}

function evolve(argv) {
  return capture((io) => runRulekeeper(['evolve', ...argv], io, {}));
}

/** 质量文件（每例一个临时文件，避免互相污染） */
function qualityFile(dir, map) {
  const path = join(dir, 'quality.json');
  writeFileSync(path, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
  return path;
}

/** 落点指纹：相对路径 -> sha256（**排除 proposals/**，因为那是 evolve 唯一允许的写点） */
function fingerprint(dir, { exclude = ['proposals'] } = {}) {
  const out = {};
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel), { withFileTypes: true }).map((d) => d.name).sort()) {
      const relPath = rel === '' ? name : `${rel}/${name}`;
      if (exclude.some((e) => relPath === e || relPath.startsWith(`${e}/`))) continue;
      const abs = join(dir, relPath);
      if (statSync(abs).isDirectory()) walk(relPath);
      else out[relPath] = createHash('sha256').update(readFileSync(abs)).digest('hex');
    }
  };
  walk('');
  return out;
}

function twoRecords(label, rule = 'FACT-WRITING', second = rule) {
  return freshLanding(label, {
    entries: [
      ledgerEntry({ id: 'LF-A1', ts: '2026-09-14T00:00:00.000Z', rule }),
      ledgerEntry({ id: 'LF-A2', ts: '2026-09-14T01:00:00.000Z', rule: second }),
    ],
  });
}

test('判据 LF-290：同一条纪律复发 2 次 -> 必产 proposals/<id>.json（四要件写入 + 字段集合 == 冻结表）', () => {
  const { root, landing } = twoRecords('e-two');
  const r = evolve(['--landing', landing, '--quality', qualityFile(root, { 'FACT-WRITING': QUALITY }), '--now', '2026-09-14T02:00:00Z']);
  assert.equal(r.rc, RC.OK, r.err + r.out);
  assert.match(r.out, /RK_EVOLVE_CANDIDATES=1/);
  assert.match(r.out, /RK_EVOLVE_PROPOSALS=1/);
  const files = readdirSync(join(landing, 'proposals'));
  assert.equal(files.length, 1);
  const proposal = JSON.parse(readFileSync(join(landing, 'proposals', files[0]), 'utf8'));
  assert.deepEqual(Object.keys(proposal).sort(), proposalFieldNames().slice().sort());
  for (const field of PROPOSAL_QUALITY_FIELDS) assert.equal(proposal[field], QUALITY[field]);
  assert.equal(proposal.rule, 'FACT-WRITING');
  assert.equal(proposal.source, 'auto');
  assert.equal(proposal.status, 'proposed');
  assert.equal(proposal.schema, 1);
  assert.equal(proposal.createdAt, '2026-09-14T02:00:00.000Z');
  assert.equal(listProposals(landing).items.length, 1);
});

test('判据 LF-290：同一条纪律"两种写法各 1 次"也算复发 2（按 canonical 聚合，非字面）', () => {
  const { root, landing } = twoRecords('e-canon', 'FACT-WRITING', 'fact-writing');
  const r = evolve(['--landing', landing, '--quality', qualityFile(root, { 'FACT-WRITING': QUALITY })]);
  assert.equal(r.rc, RC.OK, r.err + r.out);
  assert.match(r.out, /RK_EVOLVE_CANDIDATES=1/);
  assert.match(r.out, /rule=FACT-WRITING count=2/);
});

test('红态 LF-290 负样本：只复发 1 次 -> 不产提案（且不报错）', () => {
  const { root, landing } = freshLanding('e-one', {
    entries: [ledgerEntry({ id: 'LF-B1', ts: '2026-09-14T00:00:00.000Z', rule: 'FACT-WRITING' })],
  });
  const r = evolve(['--landing', landing, '--quality', qualityFile(root, { 'FACT-WRITING': QUALITY })]);
  assert.equal(r.rc, RC.OK);
  assert.match(r.out, /RK_EVOLVE_LEDGER_ENTRIES=1/);
  assert.match(r.out, /RK_EVOLVE_CANDIDATES=0/);
  assert.match(r.out, /RK_EVOLVE_PROPOSALS=0/);
  assert.equal(existsSync(join(landing, 'proposals')), false, '复发 1 次不得建 proposals/ 目录');
});

test('判据 LF-280：evolve 前后**整个落点（除 proposals/）字节指纹完全一致**，rules.json sha 不变', () => {
  const { root, landing } = twoRecords('e-gate');
  const before = fingerprint(landing);
  const rulesBefore = before['rules.json'];
  const r = evolve(['--landing', landing, '--quality', qualityFile(root, { 'FACT-WRITING': QUALITY }), '--now', '2026-09-14T02:00:00Z']);
  assert.equal(r.rc, RC.OK, r.err + r.out);
  const after = fingerprint(landing);
  assert.deepEqual(after, before, '除 proposals/ 外，落点里任何字节都不该变（LF-280）');
  assert.match(r.out, /RK_EVOLVE_RULES_UNCHANGED=true/);
  assert.equal(after['rules.json'], rulesBefore);
  assert.equal(existsSync(join(landing, 'proposals')), true);
});

test('红态 LF-280：指纹比较器不是空判——动 rules.json 一个字节必须被发现', () => {
  const { landing } = twoRecords('e-gate-detector');
  const before = fingerprint(landing);
  writeFileSync(join(landing, 'rules.json'), `${readFileSync(join(landing, 'rules.json'), 'utf8')} \n`, 'utf8');
  const after = fingerprint(landing);
  assert.notDeepEqual(after, before, '指纹比较器若发现不了这处改动，LF-280 判据就是空的');
  assert.notEqual(after['rules.json'], before['rules.json']);
});

test('判据 LF-295：四要件齐备 -> 落盘且 exit=0；逐个删要件 -> exit=1 且点名字段、不落盘', () => {
  for (const missing of PROPOSAL_QUALITY_FIELDS) {
    const { root, landing } = twoRecords(`e-q-${missing}`);
    const quality = { ...QUALITY };
    delete quality[missing];
    const r = evolve(['--landing', landing, '--quality', qualityFile(root, { 'FACT-WRITING': quality })]);
    assert.equal(r.rc, RC.FAIL, `缺 ${missing} 必须失败`);
    assert.match(r.out, /FINDING PROPOSAL_QUALITY_MISSING/);
    assert.match(r.out, new RegExp(missing), `必须点名缺的字段：${missing}`);
    assert.equal(existsSync(join(landing, 'proposals')), false, `缺 ${missing} 时不得落盘`);
  }
});

test('红态 LF-295：要件齐备但 auto 单独触发升门禁 -> exit=1 且不落盘；human 触发 -> exit=0 且落盘', () => {
  const a = twoRecords('e-escalate-auto');
  const ra = evolve(['--landing', a.landing, '--quality', qualityFile(a.root, { 'FACT-WRITING': QUALITY }), '--escalate-gate']);
  assert.equal(ra.rc, RC.FAIL);
  assert.match(ra.out, /FINDING PROPOSAL_GATE_ESCALATION_REQUIRES_HUMAN/);
  assert.equal(existsSync(join(a.landing, 'proposals')), false);

  const b = twoRecords('e-escalate-human');
  const rb = evolve(['--landing', b.landing, '--quality', qualityFile(b.root, { 'FACT-WRITING': QUALITY }),
    '--escalate-gate', '--source', 'human', '--now', '2026-09-14T03:00:00Z']);
  assert.equal(rb.rc, RC.OK, rb.err + rb.out);
  assert.match(rb.out, /RK_EVOLVE_PROPOSALS=1/);
  const files = readdirSync(join(b.landing, 'proposals'));
  assert.equal(JSON.parse(readFileSync(join(b.landing, 'proposals', files[0]), 'utf8')).source, 'human');
});

test('红态：幂等跳过**不得**掩盖质量缺失（先判质量/闸门，后判幂等）', () => {
  const { root, landing } = twoRecords('e-order');
  const good = evolve(['--landing', landing, '--quality', qualityFile(root, { 'FACT-WRITING': QUALITY }), '--now', '2026-09-14T02:00:00Z']);
  assert.equal(good.rc, RC.OK);
  const again = evolve(['--landing', landing, '--quality', qualityFile(root, { 'FACT-WRITING': QUALITY })]);
  assert.equal(again.rc, RC.OK);
  assert.match(again.out, /SKIPPED FACT-WRITING count=2 reason=EXISTING_PROPOSAL/);
  assert.equal(readdirSync(join(landing, 'proposals')).length, 1, '幂等：不得重复产提案');
  const bad = { ...QUALITY };
  delete bad.activationCheck;
  const r = evolve(['--landing', landing, '--quality', qualityFile(root, { 'FACT-WRITING': bad })]);
  assert.equal(r.rc, RC.FAIL, '已有提案也不能让"缺要件"静默通过（本轮实测撞到的顺序 bug）');
  assert.match(r.out, /FINDING PROPOSAL_QUALITY_MISSING/);
});

test('判据：mode=off / --dry-run 都不产文件；--source 非法、--quality 缺失或坏 JSON、--landing 不存在 -> 用法错误', () => {
  const off = twoRecords('e-off');
  writeFileSync(join(off.landing, 'config.json'), `${JSON.stringify({ schema: 1, mode: 'off' }, null, 2)}\n`, 'utf8');
  const rOff = evolve(['--landing', off.landing, '--quality', qualityFile(off.root, { 'FACT-WRITING': QUALITY })]);
  assert.equal(rOff.rc, RC.OK);
  assert.match(rOff.out, /FINDING EVOLVE_SKIPPED_MODE_OFF/);
  assert.equal(existsSync(join(off.landing, 'proposals')), false);

  const dry = twoRecords('e-dry');
  const rDry = evolve(['--landing', dry.landing, '--quality', qualityFile(dry.root, { 'FACT-WRITING': QUALITY }), '--dry-run']);
  assert.equal(rDry.rc, RC.OK);
  assert.match(rDry.out, /RK_EVOLVE_DRY_RUN=true/);
  assert.equal(existsSync(join(dry.landing, 'proposals')), false);

  const bad = twoRecords('e-usage');
  const q = qualityFile(bad.root, { 'FACT-WRITING': QUALITY });
  assert.equal(evolve(['--landing', bad.landing, '--quality', q, '--source', 'yolo']).rc, RC.USAGE);
  assert.equal(evolve(['--landing', bad.landing, '--quality', join(bad.root, 'ghost.json')]).rc, RC.USAGE);
  const broken = join(bad.root, 'broken.json');
  writeFileSync(broken, '{ nope', 'utf8');
  assert.equal(evolve(['--landing', bad.landing, '--quality', broken]).rc, RC.USAGE);
  assert.equal(evolve(['--landing', join(bad.root, 'no-such-dir')]).rc, RC.USAGE);
  assert.equal(evolve(['--landing', bad.landing, '--now', 'not-a-time', '--quality', q]).rc, RC.USAGE);
});

test('判据：--rule 过滤 + CLI 逐字段覆盖（质量要件可不必走文件）', () => {
  const { landing } = freshLanding('e-rule-filter', {
    entries: [
      ledgerEntry({ id: 'LF-C1', ts: '2026-09-14T00:00:00.000Z', rule: 'FACT-WRITING' }),
      ledgerEntry({ id: 'LF-C2', ts: '2026-09-14T01:00:00.000Z', rule: 'FACT-WRITING' }),
      ledgerEntry({ id: 'LF-C3', ts: '2026-09-14T02:00:00.000Z', rule: 'PATH-SANITIZE' }),
      ledgerEntry({ id: 'LF-C4', ts: '2026-09-14T03:00:00.000Z', rule: 'PATH-SANITIZE' }),
    ],
  });
  const r = evolve(['--landing', landing, '--rule', 'PATH-SANITIZE',
    '--red-criteria', 'rc', '--counter-example', 'ce', '--false-positive-surface', 'fp', '--activation-check', 'ac',
    '--now', '2026-09-14T04:00:00Z']);
  assert.equal(r.rc, RC.OK, r.err + r.out);
  assert.match(r.out, /RK_EVOLVE_CANDIDATES=1/);
  const files = readdirSync(join(landing, 'proposals'));
  const p = JSON.parse(readFileSync(join(landing, 'proposals', files[0]), 'utf8'));
  assert.equal(p.rule, 'PATH-SANITIZE');
  assert.deepEqual([p.redCriteria, p.counterExample, p.falsePositiveSurface, p.activationCheck], ['rc', 'ce', 'fp', 'ac']);
});

test('红态：proposals/ 里的坏 JSON 不得让 evolve 崩（容错 + 不误判为已有提案）', () => {
  const { root, landing } = twoRecords('e-badjson');
  mkdirSync(join(landing, 'proposals'), { recursive: true });
  writeFileSync(join(landing, 'proposals', 'P-broken.json'), '{ nope', 'utf8');
  const listed = listProposals(landing);
  assert.deepEqual(listed.unreadable, ['P-broken.json']);
  const r = evolve(['--landing', landing, '--quality', qualityFile(root, { 'FACT-WRITING': QUALITY }), '--now', '2026-09-14T02:00:00Z']);
  assert.equal(r.rc, RC.OK, r.err + r.out);
  assert.equal(listProposals(landing).items.length, 1);
});

test('判据：阈值常量与清单一致（复发 ≥2），且 proposals 只出现 evolve 一处写点', () => {
  assert.equal(RECURRENCE_THRESHOLD, 2);
  const checksSrc = readFileSync(new URL('../src/checks.mjs', import.meta.url), 'utf8');
  assert.ok(!checksSrc.includes('proposals'), 'checks 不该碰 proposals');
});

// ── 复核（046a782 盲审）换来的回归用例 ───────────────────────────────────────
test('红态：落点未初始化（缺 config.json）/ config 非法 mode -> 受控 rc，不许裸抛栈', () => {
  const noCfg = freshLanding('e-nocfg', { rules: true });
  const { rmSync } = require_fs();
  rmSync(join(noCfg.landing, 'config.json'));
  const r = evolve(['--landing', noCfg.landing, '--quality', qualityFile(noCfg.root, { 'FACT-WRITING': QUALITY })]);
  assert.equal(r.rc, RC.USAGE);
  assert.match(r.err, /落点未初始化/);
  assert.ok(!/\n\s+at /.test(r.err), '不许把调用栈丢给调用方');

  const badMode = freshLanding('e-badmode', { entries: [] });
  writeFileSync(join(badMode.landing, 'config.json'), `${JSON.stringify({ schema: 1, mode: 'yolo' })}\n`, 'utf8');
  const r2 = evolve(['--landing', badMode.landing]);
  assert.equal(r2.rc, RC.USAGE);
  assert.match(r2.err, /mode 非法/);
  assert.ok(!/\n\s+at /.test(r2.err));
});

test('红态：CLI 逐字段覆盖必须挂到 canonical 键；不给 --rule 则 rc=2（禁静默丢弃）', () => {
  const { landing } = twoRecords('e-canonkey');
  // --rule 用非规范形：覆盖仍须生效（旧实现用原始串作键 -> 覆盖被文件值吃掉）
  const r = evolve(['--landing', landing, '--rule', 'fact-writing',
    '--red-criteria', 'RC-OVERRIDE', '--counter-example', 'CE', '--false-positive-surface', 'FP', '--activation-check', 'AC-OVERRIDE',
    '--now', '2026-09-14T02:00:00Z']);
  assert.equal(r.rc, RC.OK, r.err + r.out);
  const file = readdirSync(join(landing, 'proposals'))[0];
  const p = JSON.parse(readFileSync(join(landing, 'proposals', file), 'utf8'));
  assert.equal(p.redCriteria, 'RC-OVERRIDE');
  assert.equal(p.activationCheck, 'AC-OVERRIDE');

  const orphan = twoRecords('e-orphanfields');
  const r2 = evolve(['--landing', orphan.landing, '--red-criteria', 'RC', '--counter-example', 'CE',
    '--false-positive-surface', 'FP', '--activation-check', 'AC']);
  assert.equal(r2.rc, RC.USAGE, '逐字段要件必须同时给 --rule');
  assert.match(r2.err, /必须同时给 --rule/);
});

test('红态：账本不洁（半行/坏行/超长行）必须显式报出并 exit≠0（不许把没检当通过）', () => {
  const half = freshLanding('e-halfline', { entries: [] });
  const two = [ledgerEntry({ id: 'LF-T1', ts: '2026-09-14T00:00:00.000Z', rule: 'FACT-WRITING' }),
    ledgerEntry({ id: 'LF-T2', ts: '2026-09-14T01:00:00.000Z', rule: 'FACT-WRITING' })];
  writeFileSync(join(half.landing, 'ledger.jsonl'), two.map((e) => JSON.stringify(e)).join('\n'), 'utf8'); // 末行无换行
  const r = evolve(['--landing', half.landing, '--quality', qualityFile(half.root, { 'FACT-WRITING': QUALITY })]);
  assert.equal(r.rc, RC.FAIL);
  assert.match(r.out, /RK_EVOLVE_LEDGER_TRUNCATED_TAIL=true/);
  assert.match(r.out, /FINDING EVOLVE_LEDGER_TRUNCATED_TAIL/);
  assert.equal(existsSync(join(half.landing, 'proposals')), false, '账本不洁时不许产提案');

  const bad = freshLanding('e-badline', { entries: [] });
  writeFileSync(join(bad.landing, 'ledger.jsonl'), `${JSON.stringify(ledgerEntry({ id: 'LF-U1', ts: '2026-09-14T00:00:00.000Z', rule: 'FACT-WRITING' }))}\n{ nope\n[]\n`, 'utf8');
  const r2 = evolve(['--landing', bad.landing, '--quality', qualityFile(bad.root, { 'FACT-WRITING': QUALITY })]);
  assert.equal(r2.rc, RC.FAIL);
  assert.match(r2.out, /RK_EVOLVE_LEDGER_BAD_LINES=1/);
  assert.match(r2.out, /FINDING EVOLVE_LEDGER_BAD_LINES/);
  assert.match(r2.out, /RK_EVOLVE_LEDGER_ENTRIES=1/, '数组行（[]）不得被算作条目（typeof 也是 object）');
});

test('红态：提案写盘排他（wx）+ 值域零校验 -> 二者都不能再犯', () => {
  const { landing } = freshLanding('e-wx', { entries: [] });
  const proposal = buildProposal({ rule: 'RULE-ONE', quality: QUALITY, now: new Date('2026-09-14T00:00:00.000Z') });
  const first = writeProposal(landing, proposal);
  assert.equal(first.ok, true, first.reason);
  const second = writeProposal(landing, { ...proposal, rule: 'RULE-TWO' });
  assert.equal(second.ok, false, '同 id 二次写盘必须失败（不许静默覆盖）');
  assert.match(second.reason, /已存在/);
  const kept = JSON.parse(readFileSync(join(landing, 'proposals', `${proposal.id}.json`), 'utf8'));
  assert.equal(kept.rule, 'RULE-ONE');

  const badValues = validateProposalValues({ ...proposal, status: 'bogus', schema: '不是数字', createdAt: 'not-a-time' });
  assert.equal(badValues.ok, false);
  assert.ok(badValues.problems.some((p) => p.includes('status')));
  assert.ok(badValues.problems.some((p) => p.includes('schema')), badValues.problems.join('；'));
  assert.ok(badValues.problems.some((p) => p.includes('createdAt')));
  assert.deepEqual(validateProposalValues(proposal), { ok: true, problems: [] });
  // 值域校验必须挡住落盘（不是只做只读检查）
  const blocked = writeProposal(landing, { ...proposal, id: 'P-20260914000000-ffffff', status: 'bogus' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /值域不合法/);
});

test('判据：无 rules.json 时"没变"标 n/a（不许拿 null===null 冒充"证明没被动过"）', () => {
  const { root, landing } = freshLanding('e-norules', {
    entries: [ledgerEntry({ id: 'LF-V1', ts: '2026-09-14T00:00:00.000Z', rule: 'FACT-WRITING' }),
      ledgerEntry({ id: 'LF-V2', ts: '2026-09-14T01:00:00.000Z', rule: 'FACT-WRITING' })],
    rules: false,
  });
  const r = evolve(['--landing', landing, '--quality', qualityFile(root, { 'FACT-WRITING': QUALITY })]);
  assert.equal(r.rc, RC.OK);
  assert.match(r.out, /RK_EVOLVE_RULES_PRESENT=false/);
  assert.match(r.out, /RK_EVOLVE_RULES_UNCHANGED=\(n\/a:no-rules-file\)/);
});

test('判据：候选暴露 distinctProblems（同 rule 不同 problem 也计入复发，语义边界如实可见）', () => {
  const { landing } = freshLanding('e-distinct', {
    entries: [
      ledgerEntry({ id: 'LF-W1', ts: '2026-09-14T00:00:00.000Z', rule: 'SOME-DISCIPLINE', problem: '坑A' }),
      ledgerEntry({ id: 'LF-W2', ts: '2026-09-14T01:00:00.000Z', rule: 'SOME-DISCIPLINE', problem: '坑B' }),
    ],
  });
  const r = evolve(['--landing', landing, '--dry-run']);
  assert.equal(r.rc, RC.FAIL, '缺质量要件 -> fail');
  assert.match(r.out, /SKIPPED SOME-DISCIPLINE count=2 reason=UNQUALIFIED distinctProblems=2/);
});
