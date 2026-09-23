// dsh-rulekeeper · 消费方仓 CI 真可跑：「独立 checkout 的**钉版本工具仓**」形态
//
// 缺口的形状（P17 跨仓实测）：生成的 gate 作业是 `node <**仓内** bin> ci …`，而消费方仓里没有本包
//   （共享预设库仓实测：无 `bin/`、无用例运行器）⇒ 要么把包 vendoring 进去（60 模块 / ~1.09MB，且会过期），
//   要么这道门只能关掉。两条都不是好答案。
// 本形态：多 checkout 一份**钉 40 位 sha** 的工具仓到 `.dsh-rulekeeper-tool`，从那里跑 gate。
//   本包**零依赖**（实测 checkout 出来无 node_modules 也能跑）⇒ CI 里不需要 npm install。
//
// 本文件钉住四件事：
//   ① 缺省（不给 toolRepo）⇒ 输出口径不变（既有消费方与本仓零影响）；
//   ② 给了 toolRepo ⇒ 出双 checkout + `--repo "$GITHUB_WORKSPACE"`，且 ref 是**逐字**的 sha；
//   ③ `toolRef` 缺失/非法（含浮动 ref）⇒ **拒绝生成**（钉 main 会让消费方判定随工具仓漂移）；
//   ④ 生成与校验**同一组开关** ⇒ 不自判内容不一致（反向：默认口径校验它必须判不一致）。

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { ciWorkflowYaml, verifyCiWorkflow, writeCiWorkflow } from '../src/gate.mjs';
import { tempDir } from './helpers/sandbox.mjs';

const SHA40 = 'cc77bb235cfa2d4d124005ca80b44ded872ba5e6';   // 本包某一真实提交（形态用；不是"必须等于它"）
const TOOL_REPO = '0embsd/dsh-rulekeeper';
const lines = (y) => y.split('\n');
const runLine = (y) => lines(y).find((l) => l.includes('run: node') && l.includes(' ci ')) ?? '';

test('① 缺省（不给 toolRepo）⇒ 不出现工具仓 checkout，口径不变', () => {
  const y = ciWorkflowYaml({ projectRoot: process.cwd() });
  assert.doesNotMatch(y, /\.dsh-rulekeeper-tool/, '缺省不该引入工具仓目录');
  assert.match(runLine(y), /run: node bin\/rk-gate\.mjs ci --base/, '缺省仍用仓内 bin 形态');
  assert.equal(lines(y).filter((l) => l.includes('uses: actions/checkout@v5')).length, 2,
    '缺省时 checkout 步数 = gate 作业 1 + test 作业 1（不得多出第三处）');
});

test('② 给了 toolRepo ⇒ 双 checkout + 40 位 sha + `--repo $GITHUB_WORKSPACE`', () => {
  const y = ciWorkflowYaml({ projectRoot: process.cwd(), toolRepo: TOOL_REPO, toolRef: SHA40 });
  assert.match(y, new RegExp(`repository: ${TOOL_REPO.replace('/', '\\/')}`), '必须 checkout 工具仓');
  assert.match(y, new RegExp(`ref: ${SHA40}`), 'ref 必须是逐字的 40 位 sha');
  assert.match(y, /path: \.dsh-rulekeeper-tool/, '必须落到独立目录（不污染被治理仓）');
  assert.match(runLine(y), /run: node \.dsh-rulekeeper-tool\/bin\/rk-gate\.mjs ci --repo "\$GITHUB_WORKSPACE" --base/,
    'gate 必须从工具仓跑，并把被治理仓显式指过去（不靠 cwd 猜）');
  assert.match(y, /钉版本工具仓/, '必须写明这是钉版本形态（下一个人要知道升级 = 改 ref）');
  assert.doesNotMatch(y, /--repo "\.\/"/, '不许用含糊的仓内相对形态');
});

test('②b 有 toolRepo 时 test 作业仍可 `--no-test-job` 去掉（两个开关可组合）', () => {
  const y = ciWorkflowYaml({ projectRoot: process.cwd(), toolRepo: TOOL_REPO, toolRef: SHA40, withTestJob: false });
  assert.equal(lines(y).some((l) => l.trim() === 'test:'), false, 'test 作业应被去掉');
  assert.match(runLine(y), /\.dsh-rulekeeper-tool/, 'gate 行仍必须是工具仓形态');
  assert.equal(lines(y).filter((l) => l.includes('uses: actions/checkout@v5')).length, 2,
    '去掉 test 作业后 checkout 步数 = 被治理仓 1 + 工具仓 1');
});

test('③ `toolRef` 缺失 / 非 40hex（含浮动 ref）⇒ 拒绝生成，且给出可复制修法', () => {
  for (const bad of [undefined, '', 'main', 'v1.2.3', 'CC77BB2', SHA40.slice(0, 39), `${SHA40}a`]) {
    assert.throws(
      () => ciWorkflowYaml({ projectRoot: process.cwd(), toolRepo: TOOL_REPO, toolRef: bad }),
      /toolRef/,
      `toolRef=${JSON.stringify(bad)} 必须被拒绝（钉浮动 ref 会让消费方判定随工具仓漂移）`,
    );
  }
  // 错误信息要能照抄执行
  try {
    ciWorkflowYaml({ projectRoot: process.cwd(), toolRepo: TOOL_REPO });
    assert.fail('缺 toolRef 必须抛错');
  } catch (err) {
    assert.match(String(err.message), /rev-parse HEAD/, '修法必须给得出具体命令');
  }
  // toolRepo 形态也要挡
  assert.throws(() => ciWorkflowYaml({ projectRoot: process.cwd(), toolRepo: 'just-a-name', toolRef: SHA40 }),
    /owner\/repo/, 'toolRepo 必须是 owner/repo');
});

test('④ 生成与校验同一组开关 ⇒ 不自判不一致；默认口径校验它 ⇒ 必须判不一致（反向）', () => {
  const root = tempDir('ci-toolcheckout-same');
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'bin', 'rk-gate.mjs'), '// 替身\n', 'utf8');
  const rel = '.github/workflows/gate.yml';
  const opts = { projectRoot: root, rel, binPath: 'bin/rk-gate.mjs', toolRepo: TOOL_REPO, toolRef: SHA40, withTestJob: false };
  const w = writeCiWorkflow(opts);
  assert.equal(w.ok, true, String(w.reason));
  const same = verifyCiWorkflow(opts);
  assert.equal(same.ok, true, `同开关校验必须通过；reason=${same.reason}`);
  const dflt = verifyCiWorkflow({ projectRoot: root, rel, binPath: 'bin/rk-gate.mjs' });
  assert.equal(dflt.ok, false, '默认口径（仓内 bin）去校验工具仓形态必须判不一致 —— 证明该开关真的改了内容');
  assert.equal(dflt.reason, 'content-mismatch');
});
