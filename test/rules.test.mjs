// dsh-rulekeeper · LF-230 用例：rules 规则包 + config + **单点 isProtected** + 四点一致性
//
// 判据（清单 LF-230）：①fixtures/rules-ok.json -> exit 0 ②fixtures/rules-missing-project.json -> exit≠0
//   且 stderr 含 `missing field: project` ③6 字段齐全 ④四点（protect/check/pre-execute/pre-commit）
//   对同一路径判定与单点一致
// 红态：任一消费点判定与单点不一致 -> exit≠0（本文件用**注入不委托的替身**证明该断言非恒真）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { runRules } from '../src/cli.mjs';
import { RC } from '../src/rc.mjs';
import {
  CONSUMERS, RULES_FIELDS, checkConsumersConsistency, effectiveConfig, globToRegExp,
  isProtected, loadLandingRules, loadRules, normalizeTarget, validateRules,
} from '../src/rules.mjs';
import { FIXTURES_DIR, cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const RULES_OK = join(FIXTURES_DIR, 'rules-ok.json');
const RULES_MISSING_PROJECT = join(FIXTURES_DIR, 'rules-missing-project.json');
const PROBE_ROOT = 'D:/opt/proj';

const okRules = {
  schema: 1,
  project: 'proj',
  protected_paths: ['AGENTS.md', '.claude/rules/', 'deploy/openwrt/**', '**/*_test.go', 'internal/modules/ops/backup.go'],
  gates: [],
  checks: ['output_shape'],
  inject: [],
};

function capture(fn) {
  let out = '';
  let err = '';
  const rc = fn({ out: (t) => { out += String(t); }, err: (t) => { err += String(t); } });
  return { rc, out, err };
}

test('fixtures/rules-ok.json：6 字段齐全 -> 自检通过（LF-230 判据①③）', () => {
  const loaded = loadRules(RULES_OK);
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.findings, []);
  assert.deepEqual(Object.keys(loaded.rules).sort(), [...RULES_FIELDS].sort());
  assert.equal(RULES_FIELDS.length, 6);
});

test('fixtures/rules-missing-project.json：报错文本逐字含 missing field: project（判据②）', () => {
  const loaded = loadRules(RULES_MISSING_PROJECT);
  assert.equal(loaded.ok, false);
  const finding = loaded.findings.find((f) => f.msg === 'missing field: project');
  assert.ok(finding, `应有一条 msg 恰为 "missing field: project" 的报错，实际 ${JSON.stringify(loaded.findings)}`);
  assert.equal(finding.code, 'RULES_MISSING_FIELD');
});

test('validateRules：非对象 / schema 不符 / 非法 check 类型 都要报出', () => {
  assert.equal(validateRules(null).ok, false);
  assert.equal(validateRules([]).ok, false);
  const bad = validateRules({ ...okRules, schema: 99, protected_paths: 'x', checks: ['nope'] });
  assert.equal(bad.ok, false);
  const codes = bad.findings.map((f) => f.code);
  assert.ok(codes.includes('RULES_SCHEMA_VERSION'));
  assert.ok(codes.includes('RULES_PROTECTED_NOT_ARRAY'));
  assert.ok(codes.includes('RULES_CHECK_UNKNOWN'));
});

test('isProtected：glob/目录模式/大小写/相对化的判定矩阵（单点）', () => {
  const cases = [
    ['AGENTS.md', true],
    ['agents.md', true],                       // 大小写不敏感（Windows 语义 + pathKey 折叠）
    ['.claude/rules/x.md', true],              // 目录模式 .claude/rules/
    ['deploy/openwrt/a/b.go', true],           // ** 跨层
    ['internal/modules/ops/backup.go', true],  // 精确文件
    ['internal/x/y_test.go', true],            // **/*_test.go
    ['y_test.go', true],                       // **/ 允许零层
    ['internal/modules/ops/other.go', false],
    ['deploy/openwrtx/a.go', false],           // 不得误匹配 deploy/openwrt/**
    ['README.md', false],
  ];
  for (const [path, expected] of cases) {
    assert.equal(isProtected(path, okRules).protected, expected, `${path} 应判 ${expected}`);
  }
  const hit = isProtected('internal/modules/ops/backup.go', okRules);
  assert.equal(hit.matchedPattern, 'internal/modules/ops/backup.go');
  assert.equal(isProtected('', okRules).protected, false);
  assert.equal(isProtected('x', { }).protected, false, '无 protected_paths 时一律不保护');
});

test('isProtected：绝对路径先归一为相对项目根（判据里禁绝对路径）', () => {
  assert.equal(normalizeTarget(`${PROBE_ROOT}/internal/modules/ops/backup.go`, PROBE_ROOT), 'internal/modules/ops/backup.go');
  assert.equal(isProtected('D:\\opt\\proj\\AGENTS.md', okRules, { projectRoot: 'D:/opt/proj' }).protected, true);
  assert.equal(isProtected('D:\\other\\AGENTS.md', okRules, { projectRoot: 'D:/opt/proj' }).protected, false);
});

test('globToRegExp：目录模式补 **；**/ 允许零层', () => {
  assert.equal(globToRegExp('.claude/rules/').test('.claude/rules/a/b.md'), true);
  assert.equal(globToRegExp('.claude/rules').test('.claude/rules/a/b.md'), false, '不带尾斜杠就不是目录模式');
  assert.equal(globToRegExp('**/*.go').test('a.go'), true);
  assert.equal(globToRegExp('a?c').test('abc'), true);
  assert.equal(globToRegExp('a?c').test('a/c'), false, '? 不跨层');
});

test('四点一致性：默认四个消费点都委托单点 -> 全一致（判据④绿态）', () => {
  const paths = ['AGENTS.md', 'agents.md', 'internal/x/y_test.go', 'README.md'];
  const report = checkConsumersConsistency(okRules, paths, { projectRoot: PROBE_ROOT });
  assert.deepEqual(report.findings, []);
  assert.equal(report.ok, true);
  assert.equal(report.probes.length, paths.length);
  for (const probe of report.probes) {
    for (const name of CONSUMERS) assert.equal(probe.verdicts[name], probe.single);
  }
});

test('red: 注入"不委托单点"的消费点 -> 四点一致性必须报红（证明断言非恒真）', () => {
  // 反例形态：自己实现一遍（大小写敏感、且不处理 glob）——正是"四份实现必然漂移"的样子
  const badCheck = (path, rules) => (Array.isArray(rules.protected_paths) ? rules.protected_paths : []).includes(path);
  const report = checkConsumersConsistency(okRules, ['AGENTS.md', 'agents.md'], {
    projectRoot: PROBE_ROOT, consumers: { check: badCheck },
  });
  assert.equal(report.ok, false);
  const finding = report.findings.find((f) => f.consumer === 'check');
  assert.ok(finding, '应报出 check 消费点与单点不一致');
  assert.equal(finding.path, 'agents.md');
  assert.equal(finding.single, true);
  assert.equal(finding.actual, false);
});

test('effectiveConfig：config 覆盖 rules；缺省值可辨来源', () => {
  const merged = effectiveConfig({ rules: okRules, config: { mode: 'armed', maxInjectChars: 500 } });
  assert.equal(merged.mode, 'armed');
  assert.equal(merged.maxInjectChars, 500);
  assert.equal(merged.protected_paths.length, 5, 'config 未给 protected_paths 时用 rules 的');
  assert.equal(merged.sources.protected_paths, 'rules.json');
  assert.equal(merged.sources.maxInjectChars, 'config.json');

  const override = effectiveConfig({ rules: okRules, config: { protected_paths: ['only.md'] } });
  assert.deepEqual(override.protected_paths, ['only.md']);
  assert.equal(override.sources.protected_paths, 'config.json');

  const bare = effectiveConfig({});
  assert.equal(bare.mode, 'observe');
  assert.equal(bare.maxInjectChars, 1200);
  assert.deepEqual(bare.protected_paths, []);
});

test('loadLandingRules：缺文件不算错（首次运行场景）', () => {
  const landing = join(tempDir('r-empty'), 'landing');
  mkdirSync(landing, { recursive: true });
  const loaded = loadLandingRules(landing);
  assert.equal(loaded.rulesResult.ok, true);
  assert.equal(loaded.rulesResult.rules, null);
  assert.equal(loaded.config, null);
});

test('cli: check / is-protected / consistency 的 rc 与关键输出', () => {
  const okRun = capture((io) => runRules(['check', '--rules', RULES_OK], io, {}));
  assert.equal(okRun.rc, RC.OK);
  assert.match(okRun.out, /RK_RULES_PROJECT=proj/);

  const badRun = capture((io) => runRules(['check', '--rules', RULES_MISSING_PROJECT], io, {}));
  assert.equal(badRun.rc, RC.FAIL);
  assert.match(badRun.err, /missing field: project/, 'stderr 必须逐字含该文本（判据②）');
  assert.equal(badRun.out, '');

  const protectRun = capture((io) => runRules(['is-protected', '--rules', RULES_OK, '--path', 'AGENTS.md', '--project', PROBE_ROOT], io, {}));
  assert.equal(protectRun.rc, RC.OK);
  assert.match(protectRun.out, /RK_IS_PROTECTED=true/);
  for (const name of CONSUMERS) assert.match(protectRun.out, new RegExp(`CONSUMER ${name} true`));

  const consistencyRun = capture((io) => runRules(['consistency', '--rules', RULES_OK, '--paths', 'AGENTS.md,README.md', '--project', PROBE_ROOT], io, {}));
  assert.equal(consistencyRun.rc, RC.OK);
  assert.match(consistencyRun.out, /RK_CONSISTENCY_DIVERGED=0/);

  const usageRun = capture((io) => runRules(['bogus'], io, {}));
  assert.equal(usageRun.rc, RC.USAGE);
  const noRules = capture((io) => runRules(['check'], io, {}));
  assert.equal(noRules.rc, RC.USAGE);
});
