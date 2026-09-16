// dsh-rulekeeper · LF-240 用例：CLI 六子命令 + `--help` + 统一后的 bin 行为
//
// 判据（清单 LF-240）：每子命令 `--help` exit=0；未知子命令 exit=2（按 LF-140 契约）
// 红态：未知子命令 exit=0 -> 红（凭证里用变异测试：把该分支返回值改成 OK）
// 另覆盖：未实现能力必须明确报未实现（rc=5）而非假成功；统一到 cli.mjs 的三个 bin 行为不变

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { RC } from '../src/rc.mjs';
import {
  SUBCOMMANDS, SUB_USAGE, runRulekeeper, runLog, runRc, runSchema,
} from '../src/cli.mjs';
import { readLedger } from '../src/ledger.mjs';
import { FIXTURES_DIR, cleanupAll, freshProject, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const RULES_OK = join(FIXTURES_DIR, 'rules-ok.json');
const SUBCOMMAND_LIST = ['init', 'check', 'snap', 'record', 'rules', 'evolve', 'report', 'gate', 'redact', 'migrate'];

function capture(fn) {
  let out = '';
  let err = '';
  const rc = fn({ out: (t) => { out += String(t); }, err: (t) => { err += String(t); } });
  return { rc, out, err };
}

function landing(label) {
  const dir = join(tempDir(label), 'landing');
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('六子命令（+init）逐个 --help 必须 exit=0 且打印用法', () => {
  assert.deepEqual([...SUBCOMMANDS].sort(), [...SUBCOMMAND_LIST].sort());
  for (const command of SUBCOMMAND_LIST) {
    const r = capture((io) => runRulekeeper([command, '--help'], io, {}));
    assert.equal(r.rc, RC.OK, `${command} --help 应 rc=0（实测 ${r.rc}）`);
    assert.match(r.out, /用法/, `${command} --help 应打印用法`);
    assert.equal(r.err, '', `${command} --help 不应往 stderr 写东西`);
  }
});

test('init --help 只打印用法，不得真的建落点（回归：初版漏判建了目录）', () => {
  const before = join(tempDir('c-inithelp'), 'proj');
  mkdirSync(before, { recursive: true });
  const r = capture((io) => runRulekeeper(['init', '--help', '--project', before], io, {}));
  assert.equal(r.rc, RC.OK);
  assert.match(r.out, /用法: dsh-rulekeeper init/);
  assert.ok(!r.out.includes('RK_INIT_RESULT'), '带 --help 时不得执行 init');
});

test('未知子命令 -> exit=2、stderr 有说明、stdout 为空', () => {
  const r = capture((io) => runRulekeeper(['bogus'], io, {}));
  assert.equal(r.rc, RC.USAGE);
  assert.equal(r.rc, 2);
  assert.match(r.err, /未知子命令/);
  assert.equal(r.out, '');
});

test('cli rc=5：NOT_IMPLEMENTED 是保留码（当前无子命令返回它，且码值固定为 5）', () => {
  // LF-300 落地后 snap 也实现了 -> 5 变成"保留码"：码值不得复用、不得删除，但当前不应有子命令返回它。
  const dir = landing('c-notimpl');
  assert.equal(RC.NOT_IMPLEMENTED, 5, '保留码的值不得改动');
  for (const command of SUBCOMMANDS) {
    const r = capture((io) => runRulekeeper([command, '--help'], io, {}));
    assert.notEqual(r.rc, RC.NOT_IMPLEMENTED, `${command} 不该再返回 5（能力已实现）`);
  }
  for (const command of SUBCOMMANDS) {
    const r = capture((io) => runRulekeeper([command, '--landing', dir, '--path', 'x.txt'], io, {}));
    assert.notEqual(r.rc, RC.NOT_IMPLEMENTED, `${command} 跑真实参数也不该返回 5`);
  }
});

test('record：必填齐全 -> 落账本并可查；缺参数 -> exit=2', () => {
  const dir = landing('c-record');
  const okRun = capture((io) => runRulekeeper([
    'record', '--landing', dir, '--rule', 'FACT-WRITING', '--category', '流程',
    '--problem', 'p', '--root-cause', 'r', '--solution', 's', '--evidence', 'a.md,b.md',
    '--now', '2026-09-14T00:00:00Z',
  ], io, {}));
  assert.equal(okRun.rc, RC.OK);
  assert.match(okRun.out, /RK_RECORD_RULE=FACT-WRITING/);
  assert.match(okRun.out, /RK_RECORD_ID=LF-\d{14}-[0-9a-f]{6}/);
  const entries = readLedger(dir).values;
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].evidence, ['a.md', 'b.md']);

  const badRun = capture((io) => runRulekeeper(['record', '--landing', dir, '--rule', 'X'], io, {}));
  assert.equal(badRun.rc, RC.USAGE);
  assert.match(badRun.err, /缺少必填参数/);
  assert.equal(readLedger(dir).values.length, 1, '参数不全不得写账本');
});

test('check：干净落点 rc=0 并输出摘要；report：固定 --now 后可复现', () => {
  const dir = landing('c-check');
  const checkRun = capture((io) => runRulekeeper(['check', '--landing', dir], io, {}));
  assert.equal(checkRun.rc, RC.OK);
  assert.match(checkRun.out, /RK_CHECK_LEDGER_ENTRIES=0/);
  assert.match(checkRun.out, /RK_CHECK_RESULT=pass/);

  const now = '2026-09-14T00:00:00Z';
  const r1 = capture((io) => runRulekeeper(['report', '--landing', dir, '--now', now], io, {}));
  const r2 = capture((io) => runRulekeeper(['report', '--landing', dir, '--now', now], io, {}));
  assert.equal(r1.rc, RC.OK);
  assert.equal(r1.out, r2.out, '固定 --now 时报告应逐字可复现');
  assert.match(r1.out, /RK_REPORT_FIXED=true/);
});

test('rules 子命令：嵌套调用与 rk-rules 同源（check 样本 exit=0）', () => {
  const r = capture((io) => runRulekeeper(['rules', 'check', '--rules', RULES_OK], io, {}));
  assert.equal(r.rc, RC.OK);
  assert.match(r.out, /RK_RULES_FIELDS_OK=6/);
  const helpr = capture((io) => runRulekeeper(['rules', '--help'], io, {}));
  assert.equal(helpr.rc, RC.OK);
  assert.match(helpr.out, /rk-rules/);
});

test('统一后的三个 bin：用法错误 rc=2、正常路径 rc=0（行为与迁移前一致）', () => {
  for (const [label, runner, okArgs] of [
    ['rk-schema', runSchema, ['--check', '--root', process.cwd()]],
    ['rk-rc', runRc, ['--check', '--root', process.cwd()]],
  ]) {
    const help = capture((io) => runner(['--help'], io));
    assert.equal(help.rc, RC.OK, `${label} --help 应 rc=0`);
    const bad = capture((io) => runner(['--bogus'], io));
    assert.equal(bad.rc, RC.USAGE, `${label} 未知参数应 rc=2`);
    const ok = capture((io) => runner(okArgs, io));
    assert.equal(ok.rc, RC.OK, `${label} 正常路径应 rc=0`);
  }
  const logHelp = capture((io) => runLog(['--help'], io));
  assert.equal(logHelp.rc, RC.OK);
  const logNoDir = capture((io) => runLog([], io));
  assert.equal(logNoDir.rc, RC.USAGE);
  const logMissing = capture((io) => runLog(['--dir', join(tempDir('c-log'), 'nope')], io));
  assert.equal(logMissing.rc, RC.FAIL, '目录不存在 -> rc=1（与迁移前一致）');
});

test('SUB_USAGE：每个子命令都有用法文本（防"新增子命令忘写用法"）', () => {
  for (const command of SUBCOMMAND_LIST) {
    assert.equal(typeof SUB_USAGE[command], 'string', `${command} 缺 SUB_USAGE`);
    assert.match(SUB_USAGE[command], /用法/, `${command} 的用法文本应含"用法"`);
  }
});
