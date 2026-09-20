// dsh-rulekeeper · activation 起草 + 注解层协议用例（2026-09-19，objective ②）
//
// 判据（读死再下结论）：
//   绿 = ①`validateActivation`：可观测锚点（路径/通配符/命令/错误串）才过；泛指词/占位符/太短太长不过
//        ②`looksLikePathAnchor` 拒绝 `Q17/A.1` 这类"版本号当扩展名"；`globOfPath` **去掉机器相关前缀**
//        ③判别力门：锚点在参与起草的行里出现率 > maxAnchorShare ⇒ 不作为草稿（防"灌水式覆盖率"）
//        ④**协议**：写注解后 `ledger.jsonl` 逐字节不变（append-only 不被改写）
//        ⑤端到端：`--write` 之后体检覆盖率读数从 0 上升，且 doctor 能抓出孤儿/不可判注解
//   红 = 灌水条件被当成草稿；或写注解时改了账本；或覆盖率涨了而条件不可判

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { ACTIVATIONS_FILE, activationsById, appendAnnotation, mergeActivation, validateActivation } from '../src/annotations.mjs';
import { DEFAULT_MAX_ANCHOR_SHARE, anchorCandidates, draftActivations, globOfPath, looksLikePathAnchor } from '../src/draft.mjs';
import { doctor } from '../src/doctor.mjs';
import { cleanupAll, freshLanding, ledgerEntry, PKG_ROOT } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const TS = '2026-09-19T00:00:00.000Z';
const EFFECT = join(PKG_ROOT, 'bin', 'rk-effect.mjs');
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

// ── ① 可判性判据 ────────────────────────────────────────────────────────────
test('判据: validateActivation 只放"可观测锚点"的条件', () => {
  assert.equal(validateActivation('注意小心一点').ok, false, '无锚点的泛指词不得通过');
  assert.equal(validateActivation('相关时注意').ok, false);
  assert.equal(validateActivation('todo').ok, false, '占位符不得通过');
  assert.equal(validateActivation('短').ok, false);
  assert.equal(validateActivation('无').ok, false);
  assert.equal(validateActivation(`当 ${'很长的废话'.repeat(60)} 时`).ok, false, '超长不得通过');
  for (const good of [
    '当改动 src/cli.mjs 时',
    '当 exit 码为 2 时',
    '当出现错误 ERR-D3KTJC 时',
    '当改动 *.go 文件时',
    '当跑 rk-test 时',
  ]) {
    assert.equal(validateActivation(good).ok, true, `应当通过：${good}`);
  }
});

// ── ② 锚点形态（第一版实测踩过的坑，逐个钉住）────────────────────────────────
test('判据: 路径锚点形态 —— 拒绝"版本号当扩展名"，绝对路径必须去掉机器前缀', () => {
  assert.equal(looksLikePathAnchor('Q17/A.1'), false, '`.1` 不是扩展名');
  assert.equal(looksLikePathAnchor('评分.2'), false);
  assert.equal(looksLikePathAnchor('一句话 里有空格/还有斜杠.txt'), false, '带空格多半是句子');
  assert.equal(looksLikePathAnchor('.dsh-ai/verify/x.txt'), true);
  assert.equal(globOfPath('.dsh-ai/verify/x.txt'), '.dsh-ai/verify/*.txt');
  // 绝对路径（含盘符/家目录）不得把本机目录结构写进条件
  assert.equal(globOfPath('D:/opt/somewhere/proj/.dsh-ai/rulekeeper/logs/a.jsonl'), '…/logs/*.jsonl');
  assert.ok(!globOfPath('D:/opt/somewhere/x.mjs').includes('opt'), '去掉盘符之后不得残留本机目录');
});

test('判据: 候选锚点 —— `文件:行号` 优先，泛用工具名不作候选', () => {
  const row = ledgerEntry({ id: 'X1', ts: TS, rule: 'CAT-CODE', problem: '构建失败', solution: '改 ops/tasks.go:20 的判定', rootCause: 'r' });
  const cands = anchorCandidates(row);
  assert.ok(cands.length > 0);
  assert.match(cands[0].activation, /ops\/\*\.go/);
  assert.equal(cands[0].confidence, 'high');
  const generic = ledgerEntry({ id: 'X2', ts: TS, rule: 'CAT-CODE', problem: '用 git 的时候要注意', solution: 's', rootCause: 'r' });
  assert.deepEqual(anchorCandidates(generic), [], '泛用工具名（git）不得成为候选');
});

// ── ③ 判别力门（防灌水）────────────────────────────────────────────────────
test('判据: 判别力门 —— 出现率高的锚点不产草稿（否则覆盖率涨而质量为零）', () => {
  const rows = [];
  for (let i = 0; i < 20; i += 1) rows.push(ledgerEntry({ id: `C${i}`, ts: TS, rule: 'CAT-CODE', problem: `第${i}件事：跑 rk-test 时的独立问题`, solution: 's', rootCause: 'r' }));
  rows.push(ledgerEntry({ id: 'RARE', ts: TS, rule: 'CAT-CODE', problem: '构建失败', solution: '改 ops/tasks.go:20 的判定', rootCause: 'r' }));
  const r = draftActivations(rows, {});
  assert.equal(r.drafts.length, 1, `只应产出 1 条（稀有锚点）；实得 ${r.drafts.length}：${r.drafts.map((d) => d.activation).join(' | ')}`);
  assert.equal(r.drafts[0].id, 'RARE');
  assert.ok(r.drafts[0].anchorShare <= DEFAULT_MAX_ANCHOR_SHARE, '被选中的锚点必须真的低于门限');
  const common = r.noAnchor.find((x) => x.id === 'C0');
  assert.ok(common, '高出现率的行应进"无锚点"桶');
  assert.match(common.reason, /判别力|出现率/);
});

// ── ④ 协议：不动账本 ────────────────────────────────────────────────────────
test('判据（协议核心）: 写注解后 `ledger.jsonl` **逐字节不变**，注解进独立文件', () => {
  const { landing } = freshLanding('annot-protocol', {
    entries: [ledgerEntry({ id: 'A1', ts: TS, rule: 'CAT-CODE', problem: '构建失败', solution: '改 src/cli.mjs:12', rootCause: 'r' })],
  });
  const ledgerPath = join(landing, 'ledger.jsonl');
  const before = sha(ledgerPath);
  const w = appendAnnotation(landing, { id: 'A1', activation: '当改动 src/cli.mjs 时', by: 'machine', confidence: 'high' });
  assert.equal(w.ok, true, `写入应成功：${w.reason}`);
  assert.equal(sha(ledgerPath), before, '账本必须逐字节不变（append-only 不被改写）');
  const rows = readFileSync(join(landing, ACTIVATIONS_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'A1');
  assert.equal(rows[0].by, 'machine');
  // 合并视图：行内为空时用注解补；行内有值时以行内为准
  const byId = activationsById(landing);
  assert.equal(mergeActivation({ id: 'A1', activation: '' }, byId).activation, '当改动 src/cli.mjs 时');
  assert.equal(mergeActivation({ id: 'A1', activation: '行内优先' }, byId).activation, '行内优先');
  // 不合格的条件不得写进去（否则注解层会被灌水）
  assert.equal(appendAnnotation(landing, { id: 'A1', activation: '注意一点' }).ok, false);
  assert.equal(appendAnnotation(landing, { id: '', activation: '当改动 src/cli.mjs 时' }).ok, false);
  assert.equal(appendAnnotation(landing, { id: 'A1', activation: '当改动 src/cli.mjs 时', by: 'robot' }).ok, false);
});

// ── ⑤ 端到端：覆盖率上升 + doctor 抓孤儿 ────────────────────────────────────
test('判据（端到端）: `--write` 让体检覆盖率从 0 上升，且条件是**可判**的', () => {
  const { landing } = freshLanding('annot-e2e', {
    entries: [
      ledgerEntry({ id: 'A1', ts: TS, rule: 'CAT-CODE', problem: '构建失败', solution: '改 ops/tasks.go:20 的判定', rootCause: 'r' }),
      ledgerEntry({ id: 'A2', ts: TS, rule: 'CAT-DOC', problem: '文档链接失效', solution: '无锚点的一句话', rootCause: 'r' }),
    ],
  });
  const before = spawnSync(process.execPath, [EFFECT, 'plan', '--landing', landing], { cwd: PKG_ROOT, encoding: 'utf8' });
  assert.match(before.stdout, /RK_EFFECT_ENTRY_ACTIVATION=0\/2/, '前提：起点覆盖率必须是 0');

  const write = spawnSync(process.execPath, [EFFECT, 'draft-activation', '--landing', landing, '--write'], { cwd: PKG_ROOT, encoding: 'utf8' });
  assert.equal(write.status, 0, write.stderr);
  assert.match(write.stdout, /RK_DRAFT_WRITTEN=1/, `只该写 1 条（另一条无锚点）；实际：\n${write.stdout}`);
  assert.match(write.stdout, /RK_DRAFT_COVERAGE_AFTER=1\/2/);
  assert.match(write.stdout, /RK_DRAFT_NO_ANCHOR=1/);

  const after = spawnSync(process.execPath, [EFFECT, 'plan', '--landing', landing], { cwd: PKG_ROOT, encoding: 'utf8' });
  assert.match(after.stdout, /RK_EFFECT_ENTRY_ACTIVATION=1\/2/, `覆盖率应由 0 上升；实际：\n${after.stdout}`);
  assert.match(after.stdout, /RK_EFFECT_ENTRY_COVERAGE=50\.00/);

  // 幂等：再跑一次不得重复写（`ALREADY` 只数"行内自带条件"的行；注解层覆盖数看 `ANNOTATED`/`PENDING`）
  const again = spawnSync(process.execPath, [EFFECT, 'draft-activation', '--landing', landing, '--write'], { cwd: PKG_ROOT, encoding: 'utf8' });
  assert.match(again.stdout, /RK_DRAFT_ANNOTATED=1/, '注解层已有 1 条');
  assert.match(again.stdout, /RK_DRAFT_PENDING=0/, '没有待起草的行 ⇒ 幂等');
  assert.match(again.stdout, /RK_DRAFT_WRITTEN=0/, '不得重复写');
});

test('判据: doctor 抓出孤儿注解与不可判注解（否则注解失败是静默的）', () => {
  const { landing } = freshLanding('annot-doctor', {
    entries: [ledgerEntry({ id: 'K1', ts: TS, rule: 'CAT-CODE', problem: 'p', solution: 's', rootCause: 'r' })],
  });
  writeFileSync(join(landing, ACTIVATIONS_FILE), [
    JSON.stringify({ schema: 1, ts: TS, id: 'NOPE', activation: '当改动 src/cli.mjs 时', by: 'machine', evidence: [] }),
    JSON.stringify({ schema: 1, ts: TS, id: 'K1', activation: '注意一点就好', by: 'machine', evidence: [] }),
    JSON.stringify({ schema: 1, ts: TS, id: 'K1', activation: '当 exit 码为 2 时', by: 'machine', evidence: [] }),
  ].join('\n') + '\n', 'utf8');
  const report = doctor({ landingDir: landing });
  const codes = report.findings.map((f) => f.code);
  assert.ok(codes.includes('DOCTOR_ANNOTATION_ORPHAN'), '孤儿注解必须被抓');
  assert.ok(codes.includes('DOCTOR_ANNOTATION_UNCHECKABLE'), '不可判注解必须被抓');
  assert.ok(codes.includes('DOCTOR_ANNOTATION_REDECLARED'), '重复注解必须被计数');
  assert.equal(report.summary.annotations, 3);
});
