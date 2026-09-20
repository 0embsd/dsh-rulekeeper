// dsh-rulekeeper · `kind:"checker"` 用例（2026-09-19，objective ③）
//
// 判据（读死再下结论）：
//   绿 = ①四条验证（命中红 / 误报面绿 / 反事实唯一性 / 确定性）都在**真检查器**上跑通，状态 green
//        ②**默认不执行**：不给 --allow-exec ⇒ 一律 inconclusive（绝不因"没跑"判通过）
//        ③样本指纹不符 ⇒ inconclusive（样本被改过，旧结论作废）
//        ④检查器不开火 / 没有判别力 / 不确定 ⇒ 分别判红或 inconclusive（**不许糊成 pass**）
//        ⑤形状非法（command 空、expectRed=0、expectGreen≠0、redSample 缺）⇒ 在**装载期**就被 rules 校验拦下
//   红 = 上面任一条被放宽（例如"跑不动"被当成"通过"）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_CHECKER_TIMEOUT_MS, runChecker, treeHash, validateCheckerBinding, verifyChecker } from '../src/checker.mjs';
import { validateBindingEntry } from '../src/rules.mjs';
import { cleanupAll, PKG_ROOT, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const CHECKER = 'scripts/checkers/leak-check.mjs';
const RED = 'test/fixtures/checker/red-sample';
const GREEN = 'test/fixtures/checker/green-sample';

/** 绑定样例：真检查器 + 真红/绿样本（`sampleHash` 由 treeHash 现算，见下） */
function binding(overrides = {}) {
  return {
    kind: 'checker',
    rule: 'PATH-SANITIZE',
    command: ['node', CHECKER],
    expectRed: { exitCode: 1 },
    expectGreen: { exitCode: 0 },
    redSample: { kind: 'tree', source: RED },
    greenSample: { kind: 'tree', source: GREEN },
    checkerVersion: 'leak-check@1',
    timeoutMs: 20000,
    ...overrides,
  };
}

test('判据: 真检查器四项全过（命中红 / 误报面绿 / 反事实唯一性 / 确定性）', () => {
  const r = verifyChecker({ projectRoot: PKG_ROOT, binding: binding(), allowExec: true });
  assert.equal(r.ok, true, `应当全过；findings=${JSON.stringify(r.findings)}`);
  assert.equal(r.state, 'green');
  assert.deepEqual(r.cases.map((c) => c.name), ['命中红', '误报面绿', '反事实唯一性', '确定性']);
  for (const c of r.cases) assert.equal(c.ok, true, `用例应通过：${c.name} got=${c.got}`);
  assert.equal(r.cases[0].got, 'exit=1', '违规样本上必须开火（exit=1）');
  assert.equal(r.cases[1].got, 'exit=0', '合规样本上必须不报（exit=0）');
});

test('判据（默认安全）: 不给 allowExec ⇒ inconclusive，**一条命令都不跑**', () => {
  const r = verifyChecker({ projectRoot: PKG_ROOT, binding: binding() });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'inconclusive');
  assert.equal(r.cases.length, 0, '未许可执行时不该产生任何用例结论');
  assert.equal(r.findings[0].code, 'EFFECT_CHECKER_EXEC_NOT_ALLOWED');
  // 反证"真的没跑"：把命令换成一个**会留下痕迹**的写法，跑完不该有痕迹
  const marker = join(tempDir('checker-norun'), 'touched.txt');
  const r2 = verifyChecker({ projectRoot: PKG_ROOT, binding: binding({ command: ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'x')`] }) });
  assert.equal(r2.state, 'inconclusive');
  assert.equal(existsSync(marker), false, '未许可执行时不得真的跑命令');
});

test('判据: 样本指纹不符 ⇒ inconclusive（样本事后被改，旧结论作废）', () => {
  const hash = treeHash(join(PKG_ROOT, RED));
  assert.ok(typeof hash === 'string' && hash.length === 64);
  const okRun = verifyChecker({ projectRoot: PKG_ROOT, binding: binding({ sampleHash: hash }), allowExec: true });
  assert.equal(okRun.ok, true, '指纹一致时应照常通过');
  assert.ok(okRun.cases.some((c) => c.name === '样本固定' && c.ok === true), '应产出"样本固定"用例');
  const bad = verifyChecker({ projectRoot: PKG_ROOT, binding: binding({ sampleHash: 'f'.repeat(64) }), allowExec: true });
  assert.equal(bad.ok, false);
  assert.equal(bad.state, 'inconclusive');
  assert.equal(bad.findings[0].code, 'EFFECT_CHECKER_SAMPLE_CHANGED');
});

test('判据: 检查器不开火 / 没判别力 / 不确定 —— 分别判红或 inconclusive，绝不判通过', () => {
  // ① 永远 exit 0（对违规样本也不开火）⇒ 判红（NOT_HIT），不是通过
  const dead = verifyChecker({ projectRoot: PKG_ROOT, binding: binding({ command: ['node', '-e', 'process.exit(0)'] }), allowExec: true });
  assert.equal(dead.ok, false);
  assert.equal(dead.state, 'red');
  assert.ok(dead.findings.some((f) => f.code === 'EFFECT_CHECKER_NOT_HIT'));
  // ② 永远 exit 1（两个样本都报）⇒ 没有判别力
  const always = verifyChecker({ projectRoot: PKG_ROOT, binding: binding({ command: ['node', '-e', 'process.exit(1)'] }), allowExec: true });
  assert.equal(always.ok, false);
  assert.ok(always.findings.some((f) => f.code === 'EFFECT_CHECKER_NOT_DISCRIMINATING'), `实得 ${JSON.stringify(always.findings)}`);
  // ③ 超时 ⇒ inconclusive（不是红，也不是通过）
  const slow = verifyChecker({ projectRoot: PKG_ROOT, binding: binding({ command: ['node', '-e', 'setTimeout(()=>{},5000)'], timeoutMs: 300 }), allowExec: true });
  assert.equal(slow.ok, false);
  assert.equal(slow.state, 'inconclusive');
  assert.ok(slow.findings.some((f) => f.code === 'EFFECT_CHECKER_INCONCLUSIVE'));
  // ④ 样本不存在 ⇒ inconclusive
  const missing = verifyChecker({ projectRoot: PKG_ROOT, binding: binding({ redSample: { kind: 'tree', source: 'no/such/dir' } }), allowExec: true });
  assert.equal(missing.findings[0].code, 'EFFECT_CHECKER_SAMPLE_MISSING');
});

test('判据: runChecker 无 shell（argv 数组直传，不做字符串拼接）', () => {
  const r = runChecker({ command: ['node', '-e', 'console.log(process.argv.slice(1).join("|"))', 'a b', '; rm -rf /'], cwd: PKG_ROOT });
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /a b\|; rm -rf \//, '带空格与分号的参数必须原样作为一个 argv 传递');
});

test('判据: 装载期就拦非法 checker 绑定（不许进了 rules.json 才发现）', () => {
  assert.ok(validateCheckerBinding(binding()).length === 0, '合法绑定不该有问题');
  assert.match(validateCheckerBinding(binding({ command: [] })).join('；'), /command/);
  assert.match(validateCheckerBinding(binding({ command: 'node x.mjs' })).join('；'), /command/);
  assert.match(validateCheckerBinding(binding({ expectRed: { exitCode: 0 } })).join('；'), /非 0/);
  assert.match(validateCheckerBinding(binding({ expectGreen: { exitCode: 1 } })).join('；'), /必须是 0/);
  assert.match(validateCheckerBinding(binding({ redSample: { kind: 'mutate-derived', source: 'x' } })).join('；'), /kind/);
  assert.match(validateCheckerBinding(binding({ sampleHash: 'nothex' })).join('；'), /sha256/);
  // rules.json 的绑定校验也必须走同一份判据（**同源**，不是两套）
  const problems = validateBindingEntry(binding());
  assert.deepEqual(problems, [], `合法 checker 绑定不该被判非法：${problems.join('；')}`);
  assert.ok(validateBindingEntry({ kind: 'checker', rule: 'X' }).length > 0, '缺 checker 字段必须报出来');
  assert.equal(validateBindingEntry({ kind: 'checker', rule: 'X', carrier: 'AGENTS.md', command: ['node', CHECKER], expectRed: { exitCode: 1 }, expectGreen: { exitCode: 0 }, redSample: { kind: 'tree', source: RED } }).length, 0, 'checker 允许带 carrier（可选）');
});

test('判据: DEFAULT_CHECKER_TIMEOUT_MS 是正数且是有限值（超时必须有上限）', () => {
  assert.ok(Number.isInteger(DEFAULT_CHECKER_TIMEOUT_MS) && DEFAULT_CHECKER_TIMEOUT_MS > 0);
});

test('判据（端到端）: 真实落点里写一条 checker 绑定，`rk-effect verify --all --allow-exec` 判 pass', () => {
  const dir = tempDir('checker-e2e');
  const repo = join(dir, 'repo');
  const landing = join(repo, '.dsh-ai', 'rulekeeper');
  mkdirSync(landing, { recursive: true });
  mkdirSync(join(repo, 'test', 'fixtures', 'checker', 'red-sample'), { recursive: true });
  mkdirSync(join(repo, 'test', 'fixtures', 'checker', 'green-sample'), { recursive: true });
  writeFileSync(join(repo, 'test', 'fixtures', 'checker', 'leak-check.mjs'),
    "process.exit(process.env.RULEKEEPER_SAMPLE_DIR?.endsWith('red-sample') ? 1 : 0);\n", 'utf8');
  writeFileSync(join(repo, 'test', 'fixtures', 'checker', 'red-sample', 'note.md'), 'D:\\opt\\x\n', 'utf8');
  writeFileSync(join(repo, 'test', 'fixtures', 'checker', 'green-sample', 'note.md'), 'clean\n', 'utf8');
  writeFileSync(join(landing, 'config.json'), `${JSON.stringify({ schema: 1, mode: 'observe' }, null, 2)}\n`, 'utf8');
  writeFileSync(join(landing, 'rules.json'), `${JSON.stringify({
    schema: 1, project: 't', protected_paths: [], gates: [], inject: [],
    checks: [{
      kind: 'checker', rule: 'PATH-SANITIZE',
      command: ['node', 'test/fixtures/checker/leak-check.mjs'],
      expectRed: { exitCode: 1 }, expectGreen: { exitCode: 0 },
      redSample: { kind: 'tree', source: 'test/fixtures/checker/red-sample' },
      greenSample: { kind: 'tree', source: 'test/fixtures/checker/green-sample' },
      checkerVersion: 'demo@1', proposal: 'P-demo', activatedAt: '2026-09-19T00:00:00.000Z',
    }],
  }, null, 2)}\n`, 'utf8');
  writeFileSync(join(landing, 'ledger.jsonl'), '', 'utf8');

  const run = (args) => spawnSync(process.execPath, [join(PKG_ROOT, 'bin', 'rk-effect.mjs'), ...args], { cwd: PKG_ROOT, encoding: 'utf8' });
  const noExec = run(['verify', '--landing', landing, '--all', '--project', repo]);
  assert.equal(noExec.status, 1, '未许可执行必须判失败（不许因"没跑"通过）');
  assert.match(noExec.stdout, /EFFECT_CHECKER_EXEC_NOT_ALLOWED/);

  const withExec = run(['verify', '--landing', landing, '--all', '--project', repo, '--allow-exec']);
  assert.equal(withExec.status, 0, `应当通过；stdout=${withExec.stdout} stderr=${withExec.stderr}`);
  assert.match(withExec.stdout, /RK_EFFECT_CASE rule=PATH-SANITIZE name=命中红 expect=exit=1 got=exit=1 ok=true/);
  assert.match(withExec.stdout, /RK_EFFECT_CASE rule=PATH-SANITIZE name=误报面绿 expect=exit=0 got=exit=0 ok=true/);
  assert.match(withExec.stdout, /RK_EFFECT_CASE rule=PATH-SANITIZE name=确定性/);
  assert.match(withExec.stdout, /RK_EFFECT_STATE rule=PATH-SANITIZE state=green/);
  assert.match(withExec.stdout, /RK_EFFECT_VERIFY_PASSED=1 FAILED=0/);
});
