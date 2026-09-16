// dsh-rulekeeper · LF-2B0 首次启用基线 + 账本自污染防护
//
// 判据（清单 §3 LF-2B0）：①首启后首轮违规数 == 预期（逐字数字。期望 **0**——基线就是用来免"存量全报"的）
//   ②篡改 index 一行 → exit≠0
// 红态（清单原文）：首启把存量文件全报违规（刷屏）→ exit≠0（= 没有基线这一步时 verify 必须报出 N 条"无记录"）
// 另覆盖：自污染防护（落点自产物一律排除且计数）、幂等、上限、快照行符合 LF-120 冻结表、与 LF-250 check 打通。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runBaseline, runCheck } from '../src/cli.mjs';
import { BASELINE_MAX_FILES, SELF_ARTIFACT_PREFIXES, expandProtected, latestShaByPath, readSnapshotIndex, verifyBaseline } from '../src/baseline.mjs';
import { FILES } from '../src/schema.mjs';
import { RC } from '../src/rc.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const NOW = '2026-09-14T00:00:00Z';

function capture(fn) {
  let out = '';
  let err = '';
  const rc = fn({ out: (t) => { out += String(t); }, err: (t) => { err += String(t); } });
  return { rc, out, err };
}

const baseline = (args) => capture((io) => runBaseline(args, io, {}));

/** 造一个"项目 + 落点 + 受保护文件"的最小场景 */
function project(label, { patterns = ['protected/'], protectedFiles = ['protected/a.txt', 'protected/b.txt', 'protected/c.txt'], extraFiles = {} } = {}) {
  const root = tempDir(label);
  const landing = join(root, '.dsh-ai', 'rulekeeper');
  mkdirSync(landing, { recursive: true });
  writeFileSync(join(landing, 'config.json'), `${JSON.stringify({ schema: 1, mode: 'observe' }, null, 2)}\n`, 'utf8');
  writeFileSync(join(landing, 'rules.json'), `${JSON.stringify({
    schema: 1, project: 'baseline-test', protected_paths: patterns, gates: [], checks: ['file_untracked_change'], inject: [],
  }, null, 2)}\n`, 'utf8');
  for (const rel of protectedFiles) {
    mkdirSync(join(root, rel.split('/').slice(0, -1).join('/')), { recursive: true });
    writeFileSync(join(root, rel), `content of ${rel}\n`, 'utf8');
  }
  for (const [rel, text] of Object.entries(extraFiles)) {
    mkdirSync(join(root, rel.split('/').slice(0, -1).join('/')), { recursive: true });
    writeFileSync(join(root, rel), text, 'utf8');
  }
  return { root, landing };
}

test('判据①：首启 record 后，首轮 verify 违规数 == 0（逐字数字，不是"少报"）', () => {
  const { root, landing } = project('b-first');
  const rec = baseline(['record', '--landing', landing, '--project', root, '--now', NOW]);
  assert.equal(rec.rc, RC.OK, rec.err + rec.out);
  assert.match(rec.out, /RK_BASELINE_SCANNED=3/);
  assert.match(rec.out, /RK_BASELINE_RECORDED=3/);
  assert.match(rec.out, /RK_BASELINE_VIOLATIONS=0/);
  assert.match(rec.out, /RK_BASELINE_RESULT=pass/);

  const ver = baseline(['verify', '--landing', landing, '--project', root]);
  assert.equal(ver.rc, RC.OK, ver.out);
  assert.match(ver.out, /RK_BASELINE_SCANNED=3/);
  assert.match(ver.out, /RK_BASELINE_INDEX_LINES=3/);
  assert.match(ver.out, /RK_BASELINE_VIOLATIONS=0/);
  assert.match(ver.out, /RK_BASELINE_RESULT=pass/);
  // 快照行必须符合 LF-120 冻结表（不是自造格式）
  const frozen = FILES.find((f) => f.name === 'snapshots/index.jsonl').fields.map((f) => f.name);
  const rows = readFileSync(join(landing, 'snapshots', 'index.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 3);
  for (const row of rows) {
    for (const key of Object.keys(row)) assert.ok(frozen.includes(key), `快照行出现冻结表外的字段: ${key}`);
    for (const field of frozen.filter((f) => !['sha256_after', 'job'].includes(f))) {
      assert.ok(row[field] !== undefined, `快照行缺字段 ${field}`);
    }
    assert.equal(row.why.includes('LF-2B0'), true);
    assert.equal(row.job, 'baseline');
    // business 契约：backup 指向的文件必须真实存在（否则 doctor 会报 BACKUP_ORPHAN）
    if (row.backup !== '') assert.equal(existsSync(join(root, row.backup)), true, `备份不存在: ${row.backup}`);
  }
});

test('红态（清单原文）：没有基线时 verify 会把存量全报违规（刷屏 -> exit≠0）', () => {
  const { root, landing } = project('b-nobaseline');
  const dry = baseline(['record', '--landing', landing, '--project', root, '--now', NOW, '--dry-run']);
  assert.equal(dry.rc, RC.OK, dry.out);
  assert.match(dry.out, /RK_BASELINE_DRY_RUN=true/);
  assert.equal(existsSync(join(landing, 'snapshots', 'index.jsonl')), false, 'dry-run 不得落盘');
  const ver = baseline(['verify', '--landing', landing, '--project', root]);
  assert.equal(ver.rc, RC.FAIL, '没有基线 -> 必须报出"存量全无记录"');
  assert.match(ver.out, /RK_BASELINE_VIOLATIONS=3/);
  assert.match(ver.out, /受保护文件没有基线记录/);
});

test('判据：自污染防护——落点内自产物一律排除并计数，且不进快照索引', () => {
  const { root, landing } = project('b-self', { patterns: ['protected/', '.dsh-ai/**'] });
  const rec = baseline(['record', '--landing', landing, '--project', root, '--now', NOW]);
  assert.equal(rec.rc, RC.OK, rec.out);
  const excludedCount = Number(/(?:RK_BASELINE_SELF_EXCLUDED=)(\d+)/.exec(rec.out)[1]);
  assert.ok(excludedCount >= 2, `config.json/rules.json 必须被计为自产物，实得 ${excludedCount}`);
  assert.match(rec.out, /SELF_EXCLUDED \.dsh-ai\/rulekeeper\/config\.json/);
  const rows = readFileSync(join(landing, 'snapshots', 'index.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.some((r) => r.path.startsWith('.dsh-ai/')), false, '自产物绝不能进基线（进一次就自污染一次）');
  assert.equal(rows.length, 3, '只有 3 个受保护文件该被记录');

  // 模拟"工具自己又跑了一轮"：往账本/日志追加 + 新增备份 -> verify 仍必须 0 违规
  appendFileSync(join(landing, 'ledger.jsonl'), `${JSON.stringify({ schema: 1, id: 'LF-X', ts: NOW, rule: 'R', category: '纪律', problem: 'p', root_cause: 'r', solution: 's', evidence: [], mechanism: 'm', recurrence: 1, first_seen: NOW, last_seen: NOW, status: 'active' })}\n`, 'utf8');
  mkdirSync(join(landing, 'logs'), { recursive: true });
  writeFileSync(join(landing, 'logs', 'x.jsonl'), '{"level":"error"}\n', 'utf8');
  const ver = baseline(['verify', '--landing', landing, '--project', root]);
  assert.equal(ver.rc, RC.OK, `自产物变化不得判违规:\n${ver.out}`);
  assert.match(ver.out, /RK_BASELINE_VIOLATIONS=0/);
});

test('判据：SELF_ARTIFACT_PREFIXES 覆盖全部自产物类型（新增产物必须同步这张表）', () => {
  for (const p of ['ledger.jsonl', 'findings.jsonl', 'config.json', 'rules.json', 'snapshots/', 'logs/', 'backups/', 'proposals/']) {
    assert.ok(SELF_ARTIFACT_PREFIXES.includes(p), `${p} 必须在自产物清单里`);
  }
  const { root, landing } = project('b-prefix');
  const { excluded } = expandProtected({ projectRoot: root, landingDir: landing, rules: { protected_paths: ['.dsh-ai/**'] } });
  assert.ok(excluded.length >= 2);
  assert.equal(excluded.some((p) => !p.startsWith('.dsh-ai/')), false);
});

test('红态：受保护文件被改 -> 违规数 1 且 exit≠0；与 LF-250 的 untracked-change 打通', () => {
  const { root, landing } = project('b-tamper');
  assert.equal(baseline(['record', '--landing', landing, '--project', root, '--now', NOW]).rc, RC.OK);
  const target = join(root, 'protected', 'a.txt');
  const okCheck = capture((io) => runCheck(['untracked-change', '--file', target, '--landing', landing, '--project', root, '--json'], io, {}));
  assert.equal(okCheck.rc, RC.OK, okCheck.out);
  assert.match(okCheck.out, /"verdict": "pass"/);

  appendFileSync(target, 'tampered\n', 'utf8');
  const ver = baseline(['verify', '--landing', landing, '--project', root]);
  assert.equal(ver.rc, RC.FAIL);
  assert.match(ver.out, /RK_BASELINE_VIOLATIONS=1/);
  assert.match(ver.out, /FINDING BASELINE_VIOLATION protected\/a\.txt: 内容已变/);
  const badCheck = capture((io) => runCheck(['untracked-change', '--file', target, '--landing', landing, '--project', root, '--json'], io, {}));
  assert.equal(badCheck.rc, RC.FAIL);
  assert.match(badCheck.out, /UNTRACKED_CHANGE_SHA_MISMATCH/);
});

test('判据②（清单）：篡改 index 一行 -> badLines=1 -> 违规 + exit≠0', () => {
  const { root, landing } = project('b-indexline');
  assert.equal(baseline(['record', '--landing', landing, '--project', root, '--now', NOW]).rc, RC.OK);
  const indexPath = join(landing, 'snapshots', 'index.jsonl');
  appendFileSync(indexPath, '{ 这一行被篡改坏了\n', 'utf8');
  const ver = baseline(['verify', '--landing', landing, '--project', root]);
  assert.equal(ver.rc, RC.FAIL);
  assert.match(ver.out, /RK_BASELINE_INDEX_BAD_LINES=1/);
  assert.match(ver.out, /FINDING BASELINE_VIOLATION snapshots\/index\.jsonl: 索引有 1 条坏行/);
});

test('红态：index 末行被截断（半行）-> truncatedTail -> exit≠0', () => {
  const { root, landing } = project('b-trunc');
  assert.equal(baseline(['record', '--landing', landing, '--project', root, '--now', NOW]).rc, RC.OK);
  const indexPath = join(landing, 'snapshots', 'index.jsonl');
  const text = readFileSync(indexPath, 'utf8');
  writeFileSync(indexPath, text.trimEnd(), 'utf8'); // 去掉末尾换行 = 半行
  const ver = baseline(['verify', '--landing', landing, '--project', root]);
  assert.equal(ver.rc, RC.FAIL);
  assert.match(ver.out, /RK_BASELINE_INDEX_TRUNCATED_TAIL=true/);
  assert.match(ver.out, /索引末行没有换行/);
});

test('判据：record 幂等（同 path 同 sha 不重复记），索引行数不膨胀', () => {
  const { root, landing } = project('b-idem');
  assert.equal(baseline(['record', '--landing', landing, '--project', root, '--now', NOW]).rc, RC.OK);
  const linesAfterFirst = readFileSync(join(landing, 'snapshots', 'index.jsonl'), 'utf8').trim().split('\n').length;
  const again = baseline(['record', '--landing', landing, '--project', root, '--now', '2026-09-14T01:00:00Z']);
  assert.equal(again.rc, RC.OK);
  assert.match(again.out, /RK_BASELINE_RECORDED=0/);
  assert.match(again.out, /RK_BASELINE_UNCHANGED=3/);
  const linesAfterSecond = readFileSync(join(landing, 'snapshots', 'index.jsonl'), 'utf8').trim().split('\n').length;
  assert.equal(linesAfterSecond, linesAfterFirst, '幂等：不得重复追加');
});

test('红态：受保护文件数超过上限（glob 写太宽）-> record exit≠0 且不落盘', () => {
  const { root, landing } = project('b-cap');
  const rec = baseline(['record', '--landing', landing, '--project', root, '--now', NOW, '--max-files', '2']);
  assert.equal(rec.rc, RC.FAIL);
  assert.match(rec.out, /RK_BASELINE_VIOLATIONS=1/);
  assert.match(rec.out, /受保护文件数超过上限 2/);
  assert.equal(existsSync(join(landing, 'snapshots', 'index.jsonl')), false);
  assert.equal(BASELINE_MAX_FILES >= 100, true, '默认上限不得小到不可用');
});

test('红态：参数错误 -> rc=2（缺 --landing / 未初始化落点 / --max-files 非整数 / 未知子命令 / 非法 --now）', () => {
  const { root, landing } = project('b-usage');
  assert.equal(baseline(['record', '--project', root]).rc, RC.USAGE);
  const bare = tempDir('b-bare');
  assert.equal(baseline(['record', '--landing', bare, '--project', root]).rc, RC.USAGE);
  assert.equal(baseline(['record', '--landing', landing, '--project', root, '--max-files', 'abc']).rc, RC.USAGE);
  assert.equal(baseline(['bogus', '--landing', landing]).rc, RC.USAGE);
  assert.equal(baseline(['record', '--landing', landing, '--project', root, '--now', 'nope']).rc, RC.USAGE);
  assert.equal(baseline(['--help']).rc, RC.OK);
  assert.equal(baseline([]).rc, RC.USAGE);
});

test('判据：verifyBaseline 纯函数层与 CLI 层同结论（防两套实现）', () => {
  const { root, landing } = project('b-parity');
  assert.equal(baseline(['record', '--landing', landing, '--project', root, '--now', NOW]).rc, RC.OK);
  const rules = JSON.parse(readFileSync(join(landing, 'rules.json'), 'utf8'));
  const direct = verifyBaseline({ projectRoot: root, landingDir: landing, rules });
  const cli = JSON.parse(baseline(['verify', '--landing', landing, '--project', root, '--json']).out);
  assert.equal(cli.ok, direct.ok);
  assert.equal(cli.violationCount, direct.violations.length);
  assert.equal(cli.scanned, direct.scanned);
  assert.equal(cli.indexLines, direct.indexLines);
  const index = readSnapshotIndex(landing);
  assert.equal(latestShaByPath(index.values).size, 3);
  assert.equal(readdirSync(join(root, 'protected')).length, 3);
  rmSync(join(landing, 'snapshots'), { recursive: true, force: true });
});
