// dsh-rulekeeper · `ci --write-workflow --no-test-job`（消费方仓开关，P17 跨仓实测缺口）
//
// 缺口的形状（实测，不是推断）：生成的工作流里有**两个**作业 ——
//   `gate`（跑 `node bin/rk-gate.mjs ci …`）与 `test`（跑 `node bin/rk-test.mjs …`）。
//   后者是本包**自带**的用例入口；**消费方仓里没有这个文件** ⇒ 给它生成一个带 test 作业的工作流，
//   等于给它生成一个**恒红的 CI**（共享预设库仓实测形状：无 `bin/`、无 `bin/rk-test.mjs`、无工作流）。
//
// 本文件钉住两件事：
//   ① 默认**一个字节都不变**（本仓行为不能因为新增开关而漂移）；
//   ② `withTestJob:false` ⇒ 只出 gate 作业，且**生成与校验同源**（关掉生成、校验也按关掉比 ⇒ 不假红）。

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { CI_WORKFLOW_REL, ciWorkflowYaml, verifyCiWorkflow, writeCiWorkflow } from '../src/gate.mjs';
import { tempDir } from './helpers/sandbox.mjs';

const hasTestJob = (yaml) => yaml.split('\n').some((l) => l.trim() === 'test:');
const hasGateJob = (yaml) => yaml.split('\n').some((l) => l.trim() === 'gate:');
const gateRunLine = (yaml) => yaml.split('\n').find((l) => l.includes('run: node') && l.includes(' ci ')) ?? '';

test('默认（不给开关）⇒ 两个作业都在、行为与改动前逐字节口径一致', () => {
  const y = ciWorkflowYaml({ projectRoot: process.cwd() });
  assert.equal(hasGateJob(y), true);
  assert.equal(hasTestJob(y), true, '本仓默认必须保留 test 作业（跨平台用例矩阵是既有能力）');
  assert.match(gateRunLine(y), /ci --base/);
  assert.match(y, /macos-latest/);
  assert.doesNotMatch(y, /只有 gate 作业/, '默认不该出现"只有 gate 作业"的说明注释');
});

test('`withTestJob:false` ⇒ 只出 gate 作业，且**说明为什么**（不许静默少一个作业）', () => {
  const y = ciWorkflowYaml({ projectRoot: process.cwd(), withTestJob: false });
  assert.equal(hasGateJob(y), true, 'gate 作业必须还在（它是这道门的意义）');
  assert.equal(hasTestJob(y), false, 'test 作业必须去掉（消费方仓没有 bin/rk-test.mjs）');
  assert.doesNotMatch(y, /rk-test\.mjs/, '不能留下指向不存在文件的调用行');
  assert.match(y, /只有 gate 作业/, '必须如实说明这个工作流被裁过（否则下一个人会以为 CI 没跑用例是"配置错误"）');
  assert.match(gateRunLine(y), /ci --base/, 'gate 调用行不得被裁掉');
});

test('生成与校验**同一组开关** ⇒ 关掉 test 生成的工作流不该被判"内容不一致"（防假红）', () => {
  const root = tempDir('ci-notest-same');
  // 仓里放一个能解析的 bin 相对入口（本用例只验工作流比对，不真跑 CI）
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'bin', 'rk-gate.mjs'), '// 替身\n', 'utf8');
  const rel = '.github/workflows/gate.yml';
  const w = writeCiWorkflow({ projectRoot: root, rel, binPath: 'bin/rk-gate.mjs', withTestJob: false });
  assert.equal(w.ok, true, String(w.reason));
  const same = verifyCiWorkflow({ projectRoot: root, rel, binPath: 'bin/rk-gate.mjs', withTestJob: false });
  assert.equal(same.ok, true, `关掉开关生成的文件必须按关掉开关校验通过；reason=${same.reason}`);
  // 反向：**默认口径**去校验它 ⇒ 必须判不一致（证明这个开关真的改了内容，不是空开关）
  const dflt = verifyCiWorkflow({ projectRoot: root, rel, binPath: 'bin/rk-gate.mjs' });
  assert.equal(dflt.ok, false, '默认口径（带 test）去校验"裁过的"工作流必须判不一致');
  assert.equal(dflt.reason, 'content-mismatch');
});

test('`CI_WORKFLOW_REL` 是默认落点（口径单一来源，不许各处自拼路径）', () => {
  assert.equal(CI_WORKFLOW_REL, '.github/workflows/dsh-rulekeeper-gate.yml');
});
