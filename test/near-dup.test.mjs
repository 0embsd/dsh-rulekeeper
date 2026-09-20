// dsh-rulekeeper · 近似重复检测用例（2026-09-19，实验 E2 的直接落地）
//
// 判据（读死再下结论）：
//   绿 = ①结构相同的两条文本相似度接近 1、无关文本接近 0（度量本身可信）
//        ②**分块不得漏对**：任何 ≥ 阈值 的对必须被找到（与全量两两比较的结果一致）
//        ③CLI `rk-ledger near-dup` 在构造出的重复落点上报出该对；干净落点报 0（**非恒真**）
//        ④`--fail-on-found` 只在"确有近似重复"时 rc=1
//        ⑤入库门：observe **仍写入**但必须报；reject **不写入**（行数不变）+ rc=1；off 不报
//   红 = 干净落点也报重复；或 reject 之后行还是写进去了；或 observe 悄悄不报

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_NEAR_DUP_THRESHOLD, findNearDuplicates, jaccard, similarityText } from '../src/similarity.mjs';
import { tokens } from '../src/prestep.mjs';
import { cleanupAll, freshLanding, ledgerEntry, PKG_ROOT } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const TS = '2026-09-19T00:00:00.000Z';
const LEDGER = join(PKG_ROOT, 'bin', 'rk-ledger.mjs');
const RECORD = join(PKG_ROOT, 'bin', 'dsh-rulekeeper.mjs');

const run = (bin, args) => {
  const res = spawnSync(process.execPath, [bin, ...args], { cwd: PKG_ROOT, encoding: 'utf8' });
  assert.equal(res.error, undefined, `spawn 失败：${res.error?.message}`);
  return res;
};
const lines = (landing) => readFileSync(join(landing, 'ledger.jsonl'), 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');

// ── 度量本体 ────────────────────────────────────────────────────────────────
test('判据: 相似度度量可信（同文=1 / 无关≈0 / 长文加后缀超阈值 / 短句改写不到阈值）', () => {
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['c', 'd'])), 0);
  assert.equal(jaccard(new Set(), new Set(['a'])), 0, '空集不得算作相似');
  const t = '改动接口后忘了同步契约文档';
  assert.equal(similarityText(t, t), 1);
  assert.ok(similarityText(t, '今天天气不错适合出门散步') < 0.05, '无关文本应接近 0');
  // **口径写死**：Jaccard on 2–3gram 比 Dice 严 —— "同一次事故 + 后缀差异"能过 0.6，
  // 而短句改写（只换两三个字，句长本身很短）过不了。阈值 0.6 的语义因此是"几乎同一次事故"，
  // 不是"意思差不多"。这正是真实账本上 4 对里 2 对同 rule 的原因（见下条 CLI 用例）。
  const long = 'SSH 密集重试触发自封：认证失败 5 次封 24 小时，越试越封';
  assert.ok(similarityText(long, `${long}（proposal 号不同）`) > DEFAULT_NEAR_DUP_THRESHOLD, '同事故+后缀必须超阈值');
  assert.ok(similarityText(t, '改了接口但没同步契约文档') < DEFAULT_NEAR_DUP_THRESHOLD, '短句改写不应被当成重复（否则会误伤）');
});

test('判据: 分块不得漏对（与全量两两比较结果逐对一致）', () => {
  // 构造：3 条几乎相同（真重复簇）+ 一批**真正互不相关**的噪声
  const rows = [];
  for (let i = 0; i < 3; i += 1) rows.push(ledgerEntry({ id: `D${i}`, ts: TS, rule: 'CAT-PROC', problem: `同一次事故的记录：proposal P-${i} 号不同，其余逐字相同` }));
  const noise = [
    'PowerShell 替换把行尾弄成 CRLF 导致构建失败',
    'git 路径输出没关 quotePath，中文路径变八进制转义',
    '快照索引写了记录但备份文件不存在，回滚时才发现',
    '锁文件超龄没清，下一次写入直接卡住',
    '分片后的热尾读取漏掉冷段，聚合数字偏小',
  ];
  for (let i = 0; i < 25; i += 1) rows.push(ledgerEntry({ id: `N${i}`, ts: TS, rule: 'CAT-CODE', problem: `${noise[i % noise.length]}（第 ${i} 次，场景 ${i}）` }));
  const fast = findNearDuplicates(rows, { threshold: 0.6 }).pairs.map((p) => `${p.aId}~${p.bId}`).sort();
  // 全量两两（**判据的判据**：分块是优化，不许改变结果）
  const brute = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const s = jaccard(tokens(rows[i].problem), tokens(rows[j].problem));
      if (s >= 0.6) brute.push(`${rows[i].id}~${rows[j].id}`);
    }
  }
  assert.deepEqual(fast, brute.sort(), '分块结果必须与全量比较逐对一致');
  for (const pair of ['D0~D1', 'D0~D2', 'D1~D2']) assert.ok(fast.includes(pair), `真重复簇必须被找到：${pair}`);
});

// ── CLI ─────────────────────────────────────────────────────────────────────
test('判据: CLI 在构造落点上报出该对；干净落点报 0（非恒真）', () => {
  const dirty = freshLanding('neardup-cli', {
    entries: [
      ledgerEntry({ id: 'A1', ts: TS, rule: 'CAT-PROC', problem: 'SSH 密集重试触发自封：认证失败 5 次封 24 小时，越试越封' }),
      ledgerEntry({ id: 'A2', ts: TS, rule: 'CAT-PROC', problem: 'SSH 密集重试触发自封：认证失败 5 次封 24 小时，越试越封（第二次记录）' }),
    ],
  });
  const res = run(LEDGER, ['near-dup', '--landing', dirty.landing]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /RK_NEAR_DUP_PAIRS=1/);
  assert.match(res.stdout, /RK_NEAR_DUP_SAME_RULE=1/);
  assert.match(res.stdout, /PAIR 0\.\d+ A1 ~ A2/, `应点名这两条；实际：\n${res.stdout}`);

  const clean = freshLanding('neardup-clean', {
    entries: [
      ledgerEntry({ id: 'B1', ts: TS, rule: 'CAT-PROC', problem: 'SSH 密集重试触发自封：认证失败 5 次封 24 小时' }),
      ledgerEntry({ id: 'B2', ts: TS, rule: 'CAT-CODE', problem: 'PowerShell 批量替换写 .go 文件时把行尾弄成 CRLF，导致构建失败' }),
    ],
  });
  const res2 = run(LEDGER, ['near-dup', '--landing', clean.landing]);
  assert.equal(res2.status, 0);
  assert.match(res2.stdout, /RK_NEAR_DUP_PAIRS=0/);
  assert.ok(!/PAIR /.test(res2.stdout), '干净落点不得出现 PAIR 行');
});

test('判据: --fail-on-found 只在确有近似重复时 rc=1', () => {
  const dirty = freshLanding('neardup-fail', {
    entries: [
      ledgerEntry({ id: 'C1', ts: TS, rule: 'CAT-PROC', problem: '同一件事的记录号不同，其余逐字相同 A' }),
      ledgerEntry({ id: 'C2', ts: TS, rule: 'CAT-PROC', problem: '同一件事的记录号不同，其余逐字相同 B' }),
    ],
  });
  assert.equal(run(LEDGER, ['near-dup', '--landing', dirty.landing, '--fail-on-found']).status, 1);
  const clean = freshLanding('neardup-fail-clean', { entries: [ledgerEntry({ id: 'D1', ts: TS, rule: 'CAT-PROC', problem: '只有一条，不可能有重复' })] });
  assert.equal(run(LEDGER, ['near-dup', '--landing', clean.landing, '--fail-on-found']).status, 0);
  // 阈值非法 ⇒ 用法错误（不得静默按默认值跑）
  assert.equal(run(LEDGER, ['near-dup', '--landing', clean.landing, '--threshold', 'abc']).status, 2);
  assert.equal(run(LEDGER, ['near-dup', '--landing', clean.landing, '--threshold', '1.5']).status, 2);
});

// ── 入库门（observe / reject / off）─────────────────────────────────────────
test('判据: 入库门 observe ⇒ **必须报**但仍写入（gate 不能变成静默丢弃）', () => {
  const { landing } = freshLanding('neardup-record-observe', {
    entries: [ledgerEntry({ id: 'E1', ts: TS, rule: 'CAT-PROC', problem: '同一件事：认证失败 5 次封 24 小时，越试越封' })],
  });
  const before = lines(landing).length;
  const res = run(RECORD, ['record', '--landing', landing, '--rule', 'CAT-PROC', '--problem', '同一件事：认证失败 5 次封 24 小时，越试越封（又记了一次）', '--root-cause', 'r', '--solution', 's']);
  assert.equal(res.status, 0, `observe 不得拒收；stderr=${res.stderr}`);
  assert.match(res.stdout, /RK_RECORD_NEAR_DUP=E1@0\.\d+/);
  assert.match(res.stdout, /RK_RECORD_NEAR_DUP_ACTION=observe/);
  assert.match(res.stderr, /近似重复提醒/, '警告必须打给人看');
  assert.equal(lines(landing).length, before + 1, 'observe 仍应写入');
});

test('判据: 入库门 reject ⇒ 拒收且**账本行数不变**（rc=1）', () => {
  const { landing } = freshLanding('neardup-record-reject', {
    entries: [ledgerEntry({ id: 'F1', ts: TS, rule: 'CAT-PROC', problem: '同一件事：认证失败 5 次封 24 小时，越试越封' })],
  });
  const before = lines(landing).length;
  const res = run(RECORD, ['record', '--landing', landing, '--rule', 'CAT-PROC', '--problem', '同一件事：认证失败 5 次封 24 小时，越试越封（又记了一次）', '--root-cause', 'r', '--solution', 's', '--on-near-dup', 'reject']);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /RK_RECORD_NEAR_DUP=F1@0\.\d+/);
  assert.match(res.stdout, /RK_RECORD_NEAR_DUP_ACTION=reject/);
  assert.equal(lines(landing).length, before, 'reject 之后账本不得多出一行');
});

test('判据: 入库门 off / 新问题 ⇒ 不报也不拦（不能把正常记录也挡下来）', () => {
  const { landing } = freshLanding('neardup-record-off', {
    entries: [ledgerEntry({ id: 'G1', ts: TS, rule: 'CAT-PROC', problem: '同一件事：认证失败 5 次封 24 小时，越试越封' })],
  });
  const off = run(RECORD, ['record', '--landing', landing, '--rule', 'CAT-PROC', '--problem', '同一件事：认证失败 5 次封 24 小时，越试越封（又记了一次）', '--root-cause', 'r', '--solution', 's', '--on-near-dup', 'off']);
  assert.equal(off.status, 0);
  assert.ok(!/RK_RECORD_NEAR_DUP/.test(off.stdout), 'off 档不得报门禁信息');
  const fresh = run(RECORD, ['record', '--landing', landing, '--rule', 'CAT-CODE', '--problem', 'PowerShell 替换把行尾弄成 CRLF 导致构建失败', '--root-cause', 'r', '--solution', 's', '--on-near-dup', 'reject']);
  assert.equal(fresh.status, 0, '与已有条目不同的新问题不得被当成重复拒收');
  assert.ok(!/RK_RECORD_NEAR_DUP/.test(fresh.stdout));
});
