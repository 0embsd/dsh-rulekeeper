// dsh-rulekeeper · LF-540 家族：CI 失败必须**自助可诊**（失败原因无凭证也能读到）
//
// 为什么单独立一条（2026-09-16 实测的两条事实）：
//   ① GitHub 的 **job 日志下载接口要凭证** —— 无 token 实测 403 `Must have admin rights to Repository.`；
//   ② 而 check-run 的**注解（annotation）无凭证可读** —— 实测同一份 run 的 `/check-runs/<id>/annotations`
//      返回 HTTP 200（内容只有 `Process completed with exit code 1.` 这种废话）。
// 结论：CI 只把输出写进日志 ⇒ 失败原因对仓外只读者**等于不存在**（本仓第一次 macOS 失败就卡在这里）。
// 本文件把「失败 ⇒ 注解里带用例名与断言信息」钉死，且**跑的是生成物里那份脚本本身**
//   （`CI_TEST_SCRIPT` 同一来源；防"生成物 ≠ 实测的东西"这类假绿）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CI_TEST_SCRIPT, ciWorkflowYaml } from '../src/gate.mjs';

// 与 hooks.test.mjs 同一纪律：Windows 走 Git Bash（POSIX sh 语义），没有就显式跳过并说明
const GIT_BASH = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
const HAS_BASH = existsSync(GIT_BASH);
const skipNoBash = HAS_BASH ? false : `本机没有可用的 bash（${GIT_BASH}）⇒ 跳过`;

function tempDir(label) {
  return mkdtempSync(join(tmpdir(), `lf-ci-annotate-${label}-`));
}

/** 真跑生成物里那份脚本（必要时在用例里删掉，验红用） */
function runStep(dir, script) {
  const file = join(dir, 'step.sh');
  writeFileSync(file, script, 'utf8');
  const env = { ...process.env, RUNNER_TEMP: dir };   // 生成物只依赖 RUNNER_TEMP（GitHub 提供）
  // 关键：必须摘掉 NODE_TEST_CONTEXT —— 它是**父测试进程**注入的，子 node 会以为自己在嵌套跑
  // `node:test`，实测直接告警 "run() is being called recursively ... skipping running files" 并返回 0
  // （在 CI 里是独立步骤、没有这个变量，所以本地用例必须自己还原那个环境，否则测的不是 CI 的语义）
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(GIT_BASH, [file], { cwd: dir, encoding: 'utf8', env });
}

test('判据: 生成物里的 test 步骤**逐字**内嵌 CI_TEST_SCRIPT（单一来源，防两套实现）', () => {
  const yml = ciWorkflowYaml({ binPath: 'bin/rk-gate.mjs' });
  for (const line of CI_TEST_SCRIPT) {
    assert.equal(yml.includes(`          ${line}\n`), true,
      `生成物必须逐字包含脚本正文（缺这行说明生成器与实测脚本已分叉）:\n  ${line}`);
  }
  assert.equal(yml.includes('run: node --test\n'), false,
    '不得退回"一句话 run: node --test"（那样失败原因只剩需凭证的日志）');
  assert.equal(yml.includes('--test-reporter=tap'), true, '必须用 TAP 报告器：只有它带 key: value 诊断块');
  assert.equal(yml.includes('::error::'), true, '必须发 GitHub 注解工作流命令（注解无凭证可读）');
  // 注解能力实测（2026-09-16）：v4 系动作仍能用，但会被强制跑在 Node 24 上并附降级告警 —— 用 v5 消掉噪声
  assert.equal(yml.includes('actions/checkout@v5'), true);
  assert.equal(yml.includes('actions/setup-node@v5'), true);
});

test('green: 用例全过 ⇒ 退出码 0、且**不打**任何注解（注解不能被噪声淹没）', { skip: skipNoBash }, () => {
  const dir = tempDir('green');
  try {
    writeFileSync(join(dir, 'ok.test.mjs'), "import { test } from 'node:test';\ntest('全过', () => {});\n", 'utf8');
    const r = runStep(dir, CI_TEST_SCRIPT.join('\n') + '\n');
    assert.equal(r.status, 0, `全过时脚本必须返回 0:\n${r.stdout}${r.stderr}`);
    assert.equal(r.stdout.includes('::error::'), false, `全过时不得有注解:\n${r.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('red: 有用例失败 ⇒ 注解里必须有用例名 + 断言信息 + 文件:行，且退出码沿用失败码', { skip: skipNoBash }, () => {
  const dir = tempDir('red');
  try {
    writeFileSync(join(dir, 'bad.test.mjs'),
      "import { test } from 'node:test';\n"
      + "import assert from 'node:assert/strict';\n"
      + "test('探针必红', () => { assert.equal(1, 2, 'deliberate probe failure'); });\n", 'utf8');
    const r = runStep(dir, CI_TEST_SCRIPT.join('\n') + '\n');
    assert.notEqual(r.status, 0, `有条目失败时退出码必须非 0:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /^::error::.*not ok .*探针必红$/m, `注解里必须有失败用例名:\n${r.stdout}`);
    assert.match(r.stdout, /^::error::.*deliberate probe failure$/m, `注解里必须有断言信息:\n${r.stdout}`);
    assert.match(r.stdout, /^::error::.*bad\.test\.mjs:\d+/m, `注解里必须有 文件:行（否则不知道该去哪看）:\n${r.stdout}`);
    assert.equal(r.stdout.includes('::error::node --test 失败'), true, `必须先给一条总体失败注解:\n${r.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('红（变异自检）: 把脚本换成"只跑 node --test"的老写法 ⇒ 注解断言必须失败', { skip: skipNoBash }, () => {
  // 变异用例的意义：证明上面那条 red 断言**真的能抓到**退化（而不是恒真）
  const dir = tempDir('mutant');
  try {
    writeFileSync(join(dir, 'bad.test.mjs'), "import { test } from 'node:test';\ntest('必红', () => { throw new Error('boom'); });\n", 'utf8');
    const r = runStep(dir, 'set +e\nnode --test --test-reporter=tap\n');
    assert.notEqual(r.status, 0, '老写法同样会失败（退出码层面没差别）');
    assert.equal(/^::error::/m.test(r.stdout), false, '但**没有任何注解** ⇒ 失败原因对外不可见（这就是必须修的病）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
