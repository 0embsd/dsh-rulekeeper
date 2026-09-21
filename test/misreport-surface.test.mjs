// dsh-rulekeeper · 误报面检查器（规则 53 的机械面）用例
//
// 判据（读死再下结论）：
//   ① 真仓（绿样本）上零违规；红样本（假检查器恒定非 0）上必红，且报 **GREEN_FALSE_POSITIVE**
//   ② 规格缺 `greenSample` ⇒ `NO_GREEN_SAMPLE`（"误报面根本没被核过"不许默认成通过）
//   ③ 绑定声明的规格不存在 ⇒ `SPEC_MISSING`（判据的来历丢了）
//   ④ 递归护栏：命令里含本检查器 ⇒ 跳过并计数（本检查器不判自己）
//   ⑤ 没有被测对象（无 rules.json）⇒ rc=2（不是"通过"）
//
// 红 = 上面任一条被放宽（例如绿样本缺失被当成"没问题"、或本检查器去调自己）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanupAll, PKG_ROOT, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const CHECKER = join(PKG_ROOT, 'scripts', 'checkers', 'misreport-surface.mjs');
const SHIPPED_RED = join(PKG_ROOT, 'test-fixtures', 'misreport-red');

/** 跑检查器：`--sample` 为被检根。**cwd 恒为包根**（与绑定层一致：规格/命令按 cwd 相对解析） */
function runChecker(sampleDir) {
  const res = spawnSync(process.execPath, [CHECKER], {
    cwd: PKG_ROOT,
    encoding: 'utf8',
    env: { ...process.env, RULEKEEPER_SAMPLE_DIR: sampleDir },
  });
  return { rc: res.status, out: res.stdout ?? '', err: res.stderr ?? '' };
}

/**
 * 造一棵**自洽**的被检树：`<tmp>/.dsh-ai/rulekeeper/rules.json` + 本地假检查器 + 本地规格 + 样本目录。
 * 为什么自洽：检查器要求 command 与样本都相对 cwd 可解析；把假检查器与实际文件都放进同一棵临时树，
 * 就不必往仓库里塞"没人调用的假检查器"（也会踩 S9）。
 */
function fakeTree(label, { spec = {}, checkerExit = 1, specsFile = 'fake.spec.json', bindingSpec = null } = {}) {
  const rootDir = tempDir(label);
  mkdirSync(join(rootDir, '.dsh-ai', 'rulekeeper'), { recursive: true });
  mkdirSync(join(rootDir, 'sample'), { recursive: true });
  writeFileSync(join(rootDir, 'sample', 'x.txt'), 'x\n', 'utf8');
  const checkerRel = join(rootDir, 'fake-checker.mjs');
  writeFileSync(checkerRel, `console.log('FAKE');\nprocess.exit(${checkerExit});\n`, 'utf8');
  const command = ['node', checkerRel];
  const base = {
    schema: 1, rule: 'FAKE-RULE', command,
    expectRed: { exitCode: 1 }, expectGreen: { exitCode: 0 },
    redSample: { kind: 'tree', source: join(rootDir, 'sample') },
    greenSample: { kind: 'tree', source: join(rootDir, 'sample') },
    checkerVersion: 'fake@1',
  };
  const fullSpec = { ...base, ...spec };
  writeFileSync(join(rootDir, specsFile), `${JSON.stringify(fullSpec, null, 2)}\n`, 'utf8');
  const binding = {
    kind: 'checker', rule: 'FAKE-RULE',
    spec: bindingSpec ?? specsFile,
    command,
    expectRed: fullSpec.expectRed, expectGreen: fullSpec.expectGreen,
    redSample: fullSpec.redSample, ...(fullSpec.greenSample === undefined ? {} : { greenSample: fullSpec.greenSample }),
  };
  writeFileSync(
    join(rootDir, '.dsh-ai', 'rulekeeper', 'rules.json'),
    `${JSON.stringify({ schema: 1, project: 't', protected_paths: [], gates: [], checks: [binding], inject: [] }, null, 2)}\n`,
    'utf8',
  );
  return rootDir;
}

test('判据①: 真仓零违规；假检查器（绿样本上恒定非 0）必被抓住', () => {
  const real = runChecker(PKG_ROOT);
  assert.equal(real.rc, 0, `真仓上应零违规；out=${real.out}`);
  assert.match(real.out, /MISREPORT_VIOLATIONS=0/);
  assert.match(real.out, /CHECKED=5/, '五条已绑定判据都应被核到');

  const selfMade = runChecker(fakeTree('mis-red-self'));
  assert.equal(selfMade.rc, 1, `自造红树应判红；out=${selfMade.out}`);
  assert.match(selfMade.out, /MISREPORT_GREEN_FALSE_POSITIVE/);

  const shipped = runChecker(SHIPPED_RED);
  assert.equal(shipped.rc, 1, `随包红样本应判红；out=${shipped.out}`);
  assert.match(shipped.out, /MISREPORT_GREEN_FALSE_POSITIVE/);
});

test('判据②: 规格缺 greenSample ⇒ NO_GREEN_SAMPLE（不许默认成通过）', () => {
  const rootDir = fakeTree('mis-nogreen');
  // fakeTree 的 base 里有 greenSample ⇒ 显式从**规格与绑定两处**都删掉，才能验"误报面没被核过"
  const rulesPath = join(rootDir, '.dsh-ai', 'rulekeeper', 'rules.json');
  const rules = JSON.parse(readFileSync(rulesPath, 'utf8'));
  delete rules.checks[0].greenSample;
  writeFileSync(rulesPath, `${JSON.stringify(rules, null, 2)}\n`, 'utf8');
  const specPath = join(rootDir, 'fake.spec.json');
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  delete spec.greenSample;
  writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');

  const res = runChecker(rootDir);
  assert.equal(res.rc, 1);
  assert.match(res.out, /MISREPORT_NO_GREEN_SAMPLE/);
});

test('判据③: 绑定声明的规格不存在 ⇒ SPEC_MISSING', () => {
  const rootDir = fakeTree('mis-nospec', { bindingSpec: 'nope.spec.json' });
  const res = runChecker(rootDir);
  assert.equal(res.rc, 1);
  assert.match(res.out, /MISREPORT_SPEC_MISSING/);
});

test('判据④: 递归护栏 —— 命令里含本检查器的绑定被跳过并计数', () => {
  const rootDir = fakeTree('mis-self', {
    spec: { command: ['node', CHECKER] },
  });
  const res = runChecker(rootDir);
  assert.equal(res.rc, 0, `跳过自己以后不应有违规；out=${res.out}`);
  assert.match(res.out, /SKIPPED_SELF=1/);
  assert.match(res.out, /CHECKED=0/);
});

test('判据⑤: 没有被测对象 ⇒ rc=2（不是"通过"）', () => {
  const empty = tempDir('mis-empty');
  const res = runChecker(empty);
  assert.equal(res.rc, 2);
  assert.match(res.out, /MISREPORT_RULES=absent/);
});
