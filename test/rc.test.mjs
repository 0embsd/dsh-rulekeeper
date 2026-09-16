// dsh-rulekeeper · LF-140 用例：每条 **implemented** rc 一试一断言 + 契约表自检
//
// 关键：rc 不是实现细节，是契约（§9.8）。故
//   ①每条 implemented rc 都有具名用例，且用例名被 RC_TABLE.evidence 引用（表与用例互锁）
//   ②用法错误类用例额外断言「未达执行路径」（out 为空 / 不含成功标记），防止"看起来跑过了"
//   ③契约表本身有自检（重复 / 三面覆盖 / 证据用例真实存在 / planned 带 owner）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runEnv, runRulekeeper, runSelfcheck } from '../src/cli.mjs';
import { RC, RC_TABLE, checkRcTable } from '../src/rc.mjs';
import { PKG_ROOT, cleanupAll, freshProject } from './helpers/sandbox.mjs';

test.after(cleanupAll);

function capture(fn) {
  let out = '';
  let err = '';
  const rc = fn({
    out: (t) => { out += String(t); },
    err: (t) => { err += String(t); },
  });
  return { rc, out, err };
}

test('cli rc=0：init 成功并建立两处落点', () => {
  const { projectRoot, env } = freshProject('rc0');
  const r = capture((io) => runRulekeeper(['init', '--project', projectRoot], io, env));
  assert.equal(r.rc, RC.OK);
  assert.match(r.out, /RK_INIT_RESULT=pass/);
  assert.equal(r.err, '');
});

test('cli rc=1：init 运行期失败（落点不可创建）', () => {
  const { projectRoot, env } = freshProject('rc1');
  const blocker = join(projectRoot, 'blocker');
  writeFileSync(blocker, 'x', 'utf8');
  const badEnv = { ...env, DSH_HOME: join(blocker, 'sub') }; // 祖先为文件 → mkdir 必失败
  const r = capture((io) => runRulekeeper(['init', '--project', projectRoot], io, badEnv));
  assert.equal(r.rc, RC.FAIL);
  assert.match(r.err, /init 失败/);
  assert.ok(!r.out.includes('RK_INIT_RESULT=pass'), '失败路径不得打印成功标记');
});

test('cli rc=2：用法错误（未知子命令/非法 --project/非法 --now）', () => {
  const unknown = capture((io) => runRulekeeper(['bogus'], io, {}));
  assert.equal(unknown.rc, RC.USAGE);
  assert.match(unknown.err, /未知子命令/);
  assert.equal(unknown.out, '', '未达执行路径：stdout 必须为空');

  const { projectRoot, env } = freshProject('rc2');
  const badProject = capture((io) => runRulekeeper(['init', '--project', join(projectRoot, 'nope')], io, env));
  assert.equal(badProject.rc, RC.USAGE);
  assert.match(badProject.err, /不是已存在目录/);
  assert.equal(badProject.out, '');

  const badNow = capture((io) => runEnv(['--now', 'illegal'], io, env));
  assert.equal(badNow.rc, RC.USAGE);
  assert.match(badNow.err, /不是合法时间/);
  assert.equal(badNow.out, '');

  const noRoot = capture((io) => runSelfcheck([], io, env));
  assert.equal(noRoot.rc, RC.USAGE);
  assert.match(noRoot.err, /必须提供 --root/);
  assert.equal(noRoot.out, '');
});

test('契约表自检：真实表通过（三面覆盖 + 证据用例真实存在）', () => {
  const report = checkRcTable({ root: PKG_ROOT });
  assert.deepEqual(report.findings, []);
  assert.equal(report.ok, true);
  const surfaces = [...new Set(RC_TABLE.map((e) => e.surface))].sort();
  assert.deepEqual(surfaces, ['cli', 'hook', 'plugin']);
});

test('契约表自检：重复 (surface,code) → RC_DUP', () => {
  const table = [
    ...RC_TABLE,
    { surface: 'cli', code: RC.OK, name: 'DUP', meaning: '重复项', status: 'planned', owner: 'LF-000' },
  ];
  const report = checkRcTable({ root: PKG_ROOT, table });
  assert.ok(report.findings.some((f) => f.code === 'RC_DUP'));
});

test('契约表自检：缺 plugin 面 → RC_SURFACE_MISSING', () => {
  const table = RC_TABLE.filter((e) => e.surface !== 'plugin');
  const report = checkRcTable({ root: PKG_ROOT, table });
  assert.ok(report.findings.some((f) => f.code === 'RC_SURFACE_MISSING'));
});

test('契约表自检：implemented 指向不存在的用例 → RC_EVIDENCE_TEST_MISSING', () => {
  // 名字必须**运行期生成**：写字面量会被本文件自身包含 → 检查器"找到"它 → 假绿（自匹配家族，第 4 次）
  const ghost = `__不存在_${Math.random().toString(36).slice(2)}__`;
  const table = RC_TABLE.map((e) => (e.surface === 'cli' && e.code === RC.OK
    ? { ...e, evidence: { file: 'test/rc.test.mjs', test: ghost } }
    : e));
  const report = checkRcTable({ root: PKG_ROOT, table });
  assert.ok(report.findings.some((f) => f.code === 'RC_EVIDENCE_TEST_MISSING'));
});

test('契约表自检：planned 缺 owner → RC_OWNER_MISSING', () => {
  const table = RC_TABLE.map((e) => (e.status === 'planned' ? { ...e, owner: undefined } : e));
  const report = checkRcTable({ root: PKG_ROOT, table });
  assert.ok(report.findings.some((f) => f.code === 'RC_OWNER_MISSING'));
});
