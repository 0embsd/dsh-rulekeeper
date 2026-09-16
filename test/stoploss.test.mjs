// dsh-rulekeeper · LF-820 **Go/No-Go 止损点 + Runbook**（命令与阈值见包内 `RUNBOOK.md`）
//
// 判据（清单 LF-820 行）：
//   绿 = Runbook 每条动作附**可复制的一句命令**
//   红 = 按 Runbook **无法从"故意造坏的态"恢复到基线** → 必红
//
// 本文件的三条"反假绿"设计：
//   · **文档即代码**：RUNBOOK.md 只能由 `renderRunbookMarkdown()` 出（`--write-md`），
//     测试逐字比对磁盘文件与生成结果 → 文档漂移 = 红（N5）。手写的"一句命令"迟早与工具行为不一致。
//   · **先证"坏成了"再证"修好了"**：`verifyRunbook` 每类故障注入后**必须**先断言故障信号可见
//     （doctor exit≠0 / hooks verify exit≠0 / mode≠observe），否则"恢复成功"可能是空判（§9.6 R3/R4）。
//   · **变异**：把某步命令指向别的落点（复制包改一行）→ 该步必须报 `restored=false` 且总体 exit≠0（N1/N7）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runStopLoss } from '../src/cli.mjs';
import {
  RUNBOOK_STEPS, STOP_LOSS_LIMITS, evaluateStopLoss, renderRunbookMarkdown, verifyRunbook,
} from '../src/stoploss.mjs';
import { readMode } from '../src/mode.mjs';
import { RC } from '../src/rc.mjs';
import { cleanupAll, copyPkg, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const PKG = join(import.meta.dirname, '..');
const BIN = join(PKG, 'bin');

function capture(fn) {
  let out = '';
  let err = '';
  const rc = fn({ out: (t) => { out += String(t); }, err: (t) => { err += String(t); } });
  return { rc, out, err };
}
const sl = (args, env = {}) => capture((io) => runStopLoss(args, io, env));
const git = (root, ...args) => {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  return { status: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
};

test('green: 阈值冻结表 + Runbook 步骤表结构合法（每条恰好一句可执行命令）', () => {
  assert.equal(typeof STOP_LOSS_LIMITS.falseBlockRateMax, 'number');
  assert.equal(STOP_LOSS_LIMITS.coexistRedFailuresMax, 3, '判据原文就是"连续失败 3 次"');
  assert.ok(RUNBOOK_STEPS.length >= 5, `步骤表至少要覆盖 5 类故障，实测 ${RUNBOOK_STEPS.length}`);
  const ids = RUNBOOK_STEPS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, '步骤 id 不得重复');
  for (const s of RUNBOOK_STEPS) {
    assert.match(s.id, /^SL-[0-9]$/);
    assert.ok(typeof s.title === 'string' && s.title.trim() !== '');
    assert.ok(typeof s.cmd === 'string' && s.cmd.trim() !== '', `${s.id} 缺命令`);
    assert.equal(s.cmd.includes('\n'), false, `${s.id} 的命令必须是**一句**（判据原文），实际含换行`);
    assert.match(s.cmd, /\{bin\}|\{landing\}|\{repo\}/, `${s.id} 的命令要带上可替换的路径占位符`);
  }
});

test('green（N5 正对照）: RUNBOOK.md 与生成器逐字一致；--check 通过', () => {
  const generated = renderRunbookMarkdown();
  const onDisk = readFileSync(join(PKG, 'RUNBOOK.md'), 'utf8');
  assert.equal(onDisk, generated, 'RUNBOOK.md 必须由 --write-md 生成（手改即漂移）');
  const r = sl(['runbook', '--check']);
  assert.equal(r.rc, RC.OK, r.err);
  assert.match(r.out, /RK_STOP_LOSS_RUNBOOK_DRIFT=false/);
  for (const s of RUNBOOK_STEPS) assert.ok(onDisk.includes(s.cmd), `文档里必须逐字含 ${s.id} 的命令`);
});

test('红态（N5）: RUNBOOK.md 被手改 1 字节 -> --check 报漂移且 exit≠0', () => {
  // 用**副本**做变异：不动真包文件（真包被测试改坏会污染后续用例与发布面）
  const mutant = copyPkg('sl-docmut');
  const file = join(mutant, 'RUNBOOK.md');
  const text = readFileSync(file, 'utf8');
  const mutated = text.replace('# ', '#  ', 1);
  assert.notEqual(mutated, text, '夹具必须真的改到内容');
  writeFileSync(file, mutated, 'utf8');
  const run = spawnSync(process.execPath, [join(mutant, 'bin', 'rk-stop-loss.mjs'), 'runbook', '--check'], { encoding: 'utf8' });
  assert.notEqual(run.status, 0, `漂移必须 exit≠0（实测 rc=${run.status}）`);
  assert.match(run.stdout + run.stderr, /RK_STOP_LOSS_RUNBOOK_DRIFT=true/);
});

test('green: 指标全健康 -> verdict=go，无触发', () => {
  const r = evaluateStopLoss({
    mode: 'armed',
    metrics: { falseBlockRate: 0.0, contextInflationRatio: 1.2, coexistRedFailures: 0, unrecordedWrites: 0 },
  });
  assert.equal(r.verdict, 'go');
  assert.deepEqual(r.triggers, []);
  assert.deepEqual(r.actions, []);
});

test('红态（N3）: 误拦率超阈值 -> no-go + 点名 falseBlockRate + 建议先止血', () => {
  const r = evaluateStopLoss({
    mode: 'armed',
    metrics: { falseBlockRate: 0.05, contextInflationRatio: 1.1, coexistRedFailures: 0, unrecordedWrites: 0 },
  });
  assert.equal(r.verdict, 'no-go');
  assert.ok(r.triggers.some((t) => t.key === 'falseBlockRate'), JSON.stringify(r.triggers));
  assert.ok(r.actions.includes('SL-1'), '止损第一动作必须是"停在 observe"');
});

test('红态（N4）: 并存反红连续失败 3 次 -> 触发' , () => {
  const r = evaluateStopLoss({
    mode: 'armed',
    metrics: { falseBlockRate: 0, contextInflationRatio: 1, coexistRedFailures: 3, unrecordedWrites: 0 },
  });
  assert.equal(r.verdict, 'no-go');
  assert.ok(r.triggers.some((t) => t.key === 'coexistRedFailures' && t.value === 3));
  const ok = evaluateStopLoss({
    mode: 'armed',
    metrics: { falseBlockRate: 0, contextInflationRatio: 1, coexistRedFailures: 2, unrecordedWrites: 0 },
  });
  assert.equal(ok.verdict, 'go', '2 次不算超限（阈值就是 3）');
});

test('红态（N2）: 指标缺项 -> unknown + 仍然建议止血（**不**因为"没证据"判 go）', () => {
  const r = evaluateStopLoss({ mode: 'armed', metrics: { falseBlockRate: 0 } });
  assert.equal(r.verdict, 'unknown');
  assert.ok(r.missing.includes('contextInflationRatio'));
  assert.ok(r.actions.includes('SL-1'), '未知不等于通过：fail-closed');
});

test('green: apply 把档位写成 observe（读回校验）且保留 config 其它字段', () => {
  const { landing } = freshLandingFixture('sl-apply');
  writeFileSync(join(landing, 'config.json'), `${JSON.stringify({ schema: 1, mode: 'armed', project: 'proj', keep: 'me' }, null, 2)}\n`, 'utf8');
  const r = sl(['apply', '--landing', landing]);
  assert.equal(r.rc, RC.OK, r.err);
  assert.match(r.out, /RK_STOP_LOSS_MODE_BEFORE=armed/);
  assert.match(r.out, /RK_STOP_LOSS_MODE_AFTER=observe/);
  assert.equal(readMode(landing), 'observe');
  const cfg = JSON.parse(readFileSync(join(landing, 'config.json'), 'utf8'));
  assert.equal(cfg.keep, 'me', '止血只改 mode，不许动其它字段');
  assert.equal(cfg.mode, 'observe');
});

test('green（核心判据）: verify —— 4 类"故意造坏的态"都能按 Runbook 复位到基线', () => {
  const work = tempDir('sl-verify');
  const r = verifyRunbook({ workdir: work, pkgRoot: PKG });
  assert.equal(r.ok, true, JSON.stringify(r.steps, null, 2));
  assert.equal(r.steps.length, 4, `应有 4 类故障，实测 ${r.steps.length}`);
  for (const s of r.steps) {
    assert.equal(s.brokenDetected, true, `${s.id}：注入后必须先证明"真的坏了"`);
    assert.equal(s.restored, true, `${s.id}：命令执行后必须回到基线`);
    assert.equal(s.exit, 0, `${s.id} 命令 exit=${s.exit}`);
  }
});

test('变异（N1/N7）: 把 SL-1 的命令指向**另一个落点** -> verify 必须报该步未恢复 + exit≠0', () => {
  const mutant = copyPkg('sl-mutant');
  const file = join(mutant, 'src', 'stoploss.mjs');
  const src = readFileSync(file, 'utf8');
  const anchor = "['{bin}/rk-stop-loss.mjs', 'apply', '--landing', '{landing}'],";
  assert.equal(src.split(anchor).length - 1, 1, '变异锚点必须恰命中 1 次（不猜、不静默）');
  writeFileSync(file, src.replace(anchor, "['{bin}/rk-stop-loss.mjs', 'apply', '--landing', '{landing}-nope'],"), 'utf8');
  assert.equal(spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }).status, 0, '变异体必须仍是合法 JS');

  const work = tempDir('sl-mutant-run');
  const run = spawnSync(process.execPath, [join(mutant, 'bin', 'rk-stop-loss.mjs'), 'verify', '--workdir', work], { encoding: 'utf8' });
  assert.notEqual(run.status, 0, `命令指错落点时必须判红（实测 rc=${run.status}）`);
  assert.match(run.stdout, /SL-1 .*restored=false|restored=false/, run.stdout + run.stderr);
});

test('green: retire 退役门槛 —— 满足 N 天且零回退记录才放行，并写台账', () => {
  const { landing } = freshLandingFixture('sl-retire');
  const r = sl(['retire', '--landing', landing, '--shell', 'gate-bypass', '--since', '2026-01-01T00:00:00Z', '--now', '2026-02-01T00:00:00Z']);
  assert.equal(r.rc, RC.OK, r.err);
  assert.match(r.out, /RK_STOP_LOSS_RETIRE_DAYS=31/);
  assert.match(r.out, /RK_STOP_LOSS_RETIRE_ALLOWED=true/);
  const ledger = readFileSync(join(landing, 'logs', 'retire.jsonl'), 'utf8').trim().split('\n');
  assert.equal(ledger.length, 1, '退役判定必须留台账');
  assert.equal(JSON.parse(ledger[0]).shell, 'gate-bypass');
});

test('红态（N6）: 不足 N 天 / 期间有回退记录 / 缺退役门槛文档 -> retire 必须拒绝（exit≠0）', () => {
  const { landing } = freshLandingFixture('sl-retire-red');
  const early = sl(['retire', '--landing', landing, '--shell', 'gate-bypass', '--since', '2026-01-20T00:00:00Z', '--now', '2026-02-01T00:00:00Z']);
  assert.notEqual(early.rc, RC.OK, '不足 N 天必须拒绝');
  assert.match(early.out, /RK_STOP_LOSS_RETIRE_ALLOWED=false/);

  mkdirSync(join(landing, 'logs'), { recursive: true });
  writeFileSync(join(landing, 'logs', 'incidents.jsonl'), `${JSON.stringify({ shell: 'gate-bypass', ts: '2026-01-10T00:00:00Z', kind: 'rollback' })}\n`, 'utf8');
  const withRollback = sl(['retire', '--landing', landing, '--shell', 'gate-bypass', '--since', '2026-01-01T00:00:00Z', '--now', '2026-02-01T00:00:00Z']);
  assert.notEqual(withRollback.rc, RC.OK, '期间有回退记录必须拒绝');
  assert.match(withRollback.out, /RK_STOP_LOSS_RETIRE_ROLLBACKS=1/);

  const noDoc = sl(['retire', '--landing', landing, '--shell', 'gate-bypass', '--since', '2026-01-01T00:00:00Z', '--now', '2026-02-01T00:00:00Z', '--runbook', join(tempDir('sl-nodoc'), 'missing.md')]);
  assert.notEqual(noDoc.rc, RC.OK, '缺退役门槛文档 = 未写门槛，必须拒绝');
  assert.match(noDoc.out + noDoc.err, /退役门槛文档缺失|未写门槛/, '缺门槛文档必须点名"未写门槛"');
});

test('rc=2: 未知子命令 / 缺 --landing / 非法 --now', () => {
  assert.equal(sl(['statu']).rc, RC.USAGE);
  assert.equal(sl(['status']).rc, RC.USAGE);
  assert.equal(sl(['apply']).rc, RC.USAGE);
  assert.equal(sl(['retire', '--landing', tempDir('sl-u'), '--shell', 'x', '--since', '2026-01-01T00:00:00Z']).rc, RC.USAGE, 'retire 需要 --now（时间不得靠猜）');
});

test('green: status --json 输出 verdict/triggers/actions/missing', () => {
  const { landing } = freshLandingFixture('sl-json');
  const metricsFile = join(tempDir('sl-metrics'), 'm.json');
  writeFileSync(metricsFile, `${JSON.stringify({ falseBlockRate: 0.5, contextInflationRatio: 1, coexistRedFailures: 0, unrecordedWrites: 0 })}\n`, 'utf8');
  const r = sl(['status', '--landing', landing, '--metrics', metricsFile, '--json']);
  assert.equal(r.rc, RC.FAIL, '超阈值时 status 也要以非 0 退出（可被脚本判定）');
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.verdict, 'no-go');
  assert.deepEqual(parsed.missing, []);
  assert.ok(parsed.actions.includes('SL-1'));
});

test('绿色正对照: 健康指标下 status exit=0（防"永远报红"）', () => {
  const { landing } = freshLandingFixture('sl-json-ok');
  const metricsFile = join(tempDir('sl-metrics-ok'), 'm.json');
  writeFileSync(metricsFile, `${JSON.stringify({ falseBlockRate: 0, contextInflationRatio: 1, coexistRedFailures: 0, unrecordedWrites: 0 })}\n`, 'utf8');
  const r = sl(['status', '--landing', landing, '--metrics', metricsFile, '--json']);
  assert.equal(r.rc, RC.OK, r.err);
  assert.equal(JSON.parse(r.out).verdict, 'go');
});

// ── 夹具 ──────────────────────────────────────────────────────────────────────

/** 最小落点：config.json(mode=armed) + rules.json + ledger.jsonl（2 条合法行） */
function freshLandingFixture(label) {
  const root = tempDir(label);
  const landing = join(root, 'landing');
  mkdirSync(join(landing, 'logs'), { recursive: true });
  writeFileSync(join(landing, 'config.json'), `${JSON.stringify({ schema: 1, mode: 'armed' }, null, 2)}\n`, 'utf8');
  writeFileSync(join(landing, 'rules.json'), `${JSON.stringify({ schema: 1, project: 'proj', protected_paths: ['README.md'] }, null, 2)}\n`, 'utf8');
  const rows = [1, 2].map((n) => JSON.stringify({
    schema: 1, id: `sl-${n}`, ts: `2026-09-15T00:0${n}:00.000Z`, rule: `R-${n}`, problem: 'p', root_cause: 'r',
    solution: 's', evidence: [], mechanism: 'm', recurrence: 1, first_seen: `2026-09-15T00:0${n}:00.000Z`,
    last_seen: `2026-09-15T00:0${n}:00.000Z`, status: 'active',
  }));
  writeFileSync(join(landing, 'ledger.jsonl'), `${rows.join('\n')}\n`, 'utf8');
  return { root, landing };
}
