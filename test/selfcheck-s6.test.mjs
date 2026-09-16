// dsh-rulekeeper · S6 用例：重复导入绑定检测（LF-240 工具进化；来历见 L472）
//
// 为什么单独一个文件：S6 是"检查器自身"的能力，必须有**先红后绿**的直接用例，
// 否则下次它悄悄失效也没人知道（2026-09-14 实测：初版对 `import { line } from '…'`
// 这种单元素花括号去括号后没再 trim -> 名字解析成空串 -> 漏报，被"证明仪器有效"的
// 现场试验抓出）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
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
