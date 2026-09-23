// dsh-rulekeeper · S6 用例：重复导入绑定检测（LF-240 工具进化；来历见 L472）
//
// 为什么单独一个文件：S6 是"检查器自身"的能力，必须有**先红后绿**的直接用例，
// 否则下次它悄悄失效也没人知道（2026-09-14 实测：初版对 `import { line } from '…'`
// 这种单元素花括号去括号后没再 trim -> 名字解析成空串 -> 漏报，被"证明仪器有效"的
// 现场试验抓出）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkSkeleton, duplicateImportBindings } from '../src/selfcheck.mjs';
import { cleanupAll, copyPkg, freshProject } from './helpers/sandbox.mjs';

test.after(cleanupAll);

test('duplicateImportBindings：单元素花括号导入也必须被抓（回归：初版漏报）', () => {
  const code = [
    "import { line, resultLine } from './out.mjs';",
    "import { line } from './out.mjs';",
  ].join('\n');
  assert.deepEqual(duplicateImportBindings(code), ['line']);
});

test('duplicateImportBindings：多元素 / 别名 / 默认导入 的各种形态', () => {
  assert.deepEqual(duplicateImportBindings("import { a, b } from 'x';\nimport { b, c } from 'y';"), ['b']);
  assert.deepEqual(duplicateImportBindings("import a from 'x';\nimport a from 'y';"), ['a']);
  assert.deepEqual(duplicateImportBindings("import { a as x } from 'x';\nimport { b as x } from 'y';"), ['x']);
  // 别名不冲突：line as lineDup 绑的是新名字
  assert.deepEqual(duplicateImportBindings("import { line } from 'x';\nimport { line as lineDup } from 'y';"), []);
  // 干净的导入块
  assert.deepEqual(duplicateImportBindings("import { a } from 'x';\nimport { b } from 'y';"), []);
  assert.deepEqual(duplicateImportBindings(''), []);
});

test('red: 在图外文件注入重复导入 → S6_DUPLICATE_IMPORT（现场试验的复现）', () => {
  const pkg = copyPkg('s6-offgraph');
  const { projectRoot, env } = freshProject('s6-offgraph');
  const target = join(pkg, 'test', 'helpers', 'red.mjs');
  writeFileSync(target, `${'// 图外文件（不被 CLI 导入）\n'}import { Test } from 'node:test';\nimport { Test } from 'node:test';\n`, 'utf8');
  const report = checkSkeleton(pkg, { projectRoot, env });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((f) => f.code === 'S6_DUPLICATE_IMPORT'), JSON.stringify(report.findings));
});

test('green: 真实包内无重复导入绑定（S6 不误报）', () => {
  const { projectRoot, env } = freshProject('s6-clean');
  const report = checkSkeleton(copyPkg('s6-clean-pkg'), { projectRoot, env });
  assert.deepEqual(report.findings.filter((f) => f.code === 'S6_DUPLICATE_IMPORT'), []);
});

// ── S3：**用户级落点缺失不是"包坏了"**（2026-09-23 远端 CI 实测；v101 上定位）──────────────
// 现场：本检查原无条件要求"两处落点都在" ⇒ 在一台没装过本包、没有 `~/.dsh` 的干净机器上
// （CI runner / 新装机 / 新用户）恒判 `S3_LANDING_MISSING user ...` ⇒ 所有"在本包上跑 selfcheck
// 必须绿"的用例全红（CI 的 S9/S10 两条就是这么红的）。而我本机一直绿，只因这台机器上恰好有
// `~/.dsh/lessonflow`（历史遗留）—— 又一次"本机绿、干净环境红"。
// 口径：用户级落点是**全局能力**，不是包的必需件；项目落点已在时它缺失只出 NOTE，不判红。
test('green: 项目落点在、用户级落点缺失 ⇒ S3 不判红（只出 NOTE）', () => {
  const pkg = copyPkg('s3-nouserhome');
  const { projectRoot, home } = freshProject('s3-nouserhome');
  // 项目落点造出来（两处都缺才是真问题，见下一条）
  const landing = join(projectRoot, '.dsh-ai', 'rulekeeper');
  mkdirSync(landing, { recursive: true });
  writeFileSync(join(landing, 'config.json'), '{"schema":1,"mode":"observe"}\n', 'utf8');
  const env = { ...process.env, DSH_HOME: home };   // home 里**没有** rulekeeper/（= 全新机器）
  const report = checkSkeleton(pkg, { projectRoot, env });
  assert.equal(report.ok, true,
    `缺用户级落点不该判红（这正是 CI 上 S9/S10 红的原因）: ${JSON.stringify(report.findings)}`);
  assert.deepEqual(report.findings.filter((f) => f.code === 'S3_LANDING_MISSING'), []);
  assert.equal(report.notes.length > 0, true, '不判红 ≠ 不说：必须以 NOTE 如实告知缺了什么');
});

test('red: **两处**落点都缺 ⇒ 仍然必须判红（不许借"用户级可选"把项目级也放过）', () => {
  const pkg = copyPkg('s3-noany');
  const { projectRoot, home } = freshProject('s3-noany');   // 项目落点与用户级落点**都不造**
  const env = { ...process.env, DSH_HOME: home };
  const report = checkSkeleton(pkg, { projectRoot, env });
  assert.equal(report.ok, false, '两处都缺必须判红（否则这条判据就被放宽成空转）');
  const codes = report.findings.filter((f) => f.code === 'S3_LANDING_MISSING').map((f) => f.msg);
  assert.equal(codes.length, 2, `两处都应被点名: ${JSON.stringify(codes)}`);
  assert.ok(codes.some((m) => m.startsWith('project ')), JSON.stringify(codes));
  assert.ok(codes.some((m) => m.startsWith('user ')), JSON.stringify(codes));
});
