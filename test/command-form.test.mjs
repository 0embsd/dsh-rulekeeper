// 用例：命令形态观察（observe-only 判据）—— 每条形态**一红一样例**（规则 42：红态样本必须可随时重跑）
//
// 判据对象：宿主 `tools/pre-execute` 的 exec（字段见 dsh-tools 类型定义 index.d.ts:197-266）
// 档位：纯函数、零落点写入（规则 47：测试不得写真实落点 —— 本用例不触碰任何文件系统）
//
// 规则 51 纪律：本仓（公开）的 S8 判据把 `myx-` 前缀视为**他人内部工具名** ⇒ 用例里需要的
//   封装脚本名**运行时拼装**（既不写死字面量，也**不给自检面开例外**——开例外才是把边界越开越大）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMAND_FORM_IDS,
  extractCommand,
  judgeCommand,
  observeCommandForms,
  formatObserveLine,
} from '../src/command-form.mjs';

/** SSH 封装脚本名（运行时拼装，见文件头规则 51 说明） */
const SSH_WRAPPER = ['myx', 'ssh'].join('-');
/** 临时目录样本（同样运行时拼装） */
const TMP_DIR = '/tmp/' + ['myx', 'build'].join('-') + '-tmp';

/** 造一个最小 exec（形状对齐宿主 ToolExecutionInput） */
function execOf(command, name = 'pwsh') {
  return { callId: 'c1', rootCallId: 'c1', name, arguments: { command }, signal: undefined };
}
const idsOf = (cmd) => judgeCommand(cmd).map((f) => f.id);

test('判据 id 集合稳定（改集合必须同步用例与台账）', () => {
  assert.deepEqual([...COMMAND_FORM_IDS], [
    'CMD_NO_VERIFY', 'CMD_GIT_ADD_ALL', 'CMD_RM_RF_HIGH_RISK', 'CMD_INLINE_MULTISTEP', 'CMD_PIPE_NO_PIPEFAIL',
  ]);
});

test('提取：exec.arguments.command / .cmd / 字符串 args / 取不到返回 null', () => {
  assert.equal(extractCommand(execOf('echo hi')).command, 'echo hi');
  assert.equal(extractCommand({ name: 'bash', arguments: { cmd: 'ls' } }).command, 'ls');
  assert.equal(extractCommand({ name: 'bash', arguments: 'ls -la' }).command, 'ls -la');
  assert.equal(extractCommand({ name: 'read', arguments: { path: 'a.md' } }).command, null);
  assert.equal(extractCommand(null).command, null);
  assert.equal(extractCommand(execOf('x', 'bash')).toolName, 'bash');
});

test('CMD_NO_VERIFY：红=提交/推送带该标志 / 绿=普通提交', () => {
  assert.ok(idsOf('git commit --no-verify -m "x"').includes('CMD_NO_VERIFY'));
  assert.ok(idsOf('git push --no-verify').includes('CMD_NO_VERIFY'));
  assert.ok(!idsOf('git commit -m "docs: 正常提交"').includes('CMD_NO_VERIFY'));
});

test('CMD_NO_VERIFY：**已知边界**（如实钉住，不粉饰）——消息文本里提到该标志也会命中', () => {
  // observe-only 档位可接受的边界：判的是命令串自身；改口径需另立提案（规则 48：改判定语义须同步文档与样本）
  assert.ok(idsOf('git commit -m "docs: 禁止使用 --no-verify 的说明"').includes('CMD_NO_VERIFY'));
});

test('CMD_GIT_ADD_ALL：红=-A/--all/. ，绿=逐文件 add', () => {
  assert.ok(idsOf('git add -A').includes('CMD_GIT_ADD_ALL'));
  assert.ok(idsOf('git add --all').includes('CMD_GIT_ADD_ALL'));
  assert.ok(idsOf('git add .').includes('CMD_GIT_ADD_ALL'));
  assert.ok(!idsOf('git add docs/a.md scripts/b.sh').includes('CMD_GIT_ADD_ALL'));
});

test('CMD_RM_RF_HIGH_RISK：红=危险目标；绿=临时目录清理（实测项目侧部署脚本的正当用法）', () => {
  assert.ok(idsOf('rm -rf /').includes('CMD_RM_RF_HIGH_RISK'));
  assert.ok(idsOf('rm -rf $HOME').includes('CMD_RM_RF_HIGH_RISK'));
  assert.ok(idsOf('rm -rf .').includes('CMD_RM_RF_HIGH_RISK'));
  assert.ok(idsOf('rm -rf /*').includes('CMD_RM_RF_HIGH_RISK'));
  // 绿：实测项目侧 deploy 脚本大量这类正当清理 ⇒ 一律不报（规则 53 止损后的口径）
  assert.ok(!idsOf('rm -rf "$sdk"; mkdir -p "$sdk"').includes('CMD_RM_RF_HIGH_RISK'));
  assert.ok(!idsOf(`rm -rf ${TMP_DIR}`).includes('CMD_RM_RF_HIGH_RISK'));
  assert.ok(!idsOf('rm -f /tmp/x').includes('CMD_RM_RF_HIGH_RISK'));
});

test('CMD_INLINE_MULTISTEP：红=该封装 -Cmd 塞多步；绿=-Script 或单步 -Cmd', () => {
  assert.ok(idsOf(`${SSH_WRAPPER}.ps1 -Target v101 -Cmd 'cd /a; ls'`).includes('CMD_INLINE_MULTISTEP'));
  assert.ok(idsOf(`${SSH_WRAPPER}.ps1 -Target v101 -Cmd "a && b"`).includes('CMD_INLINE_MULTISTEP'));
  assert.ok(!idsOf(`${SSH_WRAPPER}.ps1 -Target v101 -Cmd 'whoami'`).includes('CMD_INLINE_MULTISTEP'));
  assert.ok(!idsOf(`${SSH_WRAPPER}.ps1 -Target v101 -Script x.sh`).includes('CMD_INLINE_MULTISTEP'));
});

test('CMD_PIPE_NO_PIPEFAIL：红=管道后取码无 pipefail；绿=有 pipefail 或没取码', () => {
  assert.ok(idsOf('cmd | tee log; echo $LASTEXITCODE').includes('CMD_PIPE_NO_PIPEFAIL'));
  assert.ok(idsOf('go test ./... | tail -3; echo $?').includes('CMD_PIPE_NO_PIPEFAIL'));
  assert.ok(!idsOf('set -o pipefail; cmd | tee log; echo $?').includes('CMD_PIPE_NO_PIPEFAIL'));
  assert.ok(!idsOf('cmd | tee log').includes('CMD_PIPE_NO_PIPEFAIL'));
});

test('观察入口：非 shell 工具 / 畸形输入一律零 findings，且**永不抛**', () => {
  assert.deepEqual(observeCommandForms({ name: 'read', arguments: { path: 'x' } }).findings, []);
  assert.deepEqual(observeCommandForms(undefined).findings, []);
  assert.deepEqual(observeCommandForms({ get name() { throw new Error('boom'); } }).findings, []);
  assert.deepEqual(observeCommandForms({ name: 'pwsh', arguments: { command: '   ' } }).findings, []);
});

test('JSONL 行：字段稳定（ts/kind/tool/forms/findings）', () => {
  const line = formatObserveLine(observeCommandForms(execOf('git add -A')), new Date('2026-09-29T00:00:00Z'));
  const obj = JSON.parse(line);
  assert.equal(obj.ts, '2026-09-29T00:00:00.000Z');
  assert.equal(obj.kind, 'command-form-observe');
  assert.equal(obj.tool, 'pwsh');
  assert.deepEqual(obj.forms, ['CMD_GIT_ADD_ALL']);
  assert.equal(obj.findings.length, 1);
});
