// dsh-rulekeeper · 按仓库性质分档的黑名单（2026-09-21，交接第 1 步）用例
//
// 判据（读死再下结论）：
//   ① 分档：public = identity + infra；private = 只 infra（**不含**"本仓自己的名字"）
//   ② 解析顺序：落点 config 的 `repoKind` 优先 > 远端探测 > 兜底 private
//   ③ 三道门（暂存文件 / 提交正文 / 引用名）都能**按档**跑：同一段文本在 public 下红、private 下绿
//   ④ 反向：基础设施类（本机绝对路径 / 真实 IPv4 / 私钥头 / 云凭据真值）**两档都红**（私有仓也会漏）
//
// 红 = 上面任一条被放宽（例如 private 也跑 identity ⇒ 私有仓的正常提交被自己拦住）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  IDENTITY_PATTERNS, INFRA_PATTERNS, PUBLIC_FACE_FORBIDDEN, declaredRepoKind, detectRepoKind,
  patternsForKind, resolveRepoPatterns,
} from '../src/repo-patterns.mjs';
import { commitMessageGate, precommitGate, refsGate } from '../src/gate.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

// **可疑串一律运行时拼装**（规则 51 / 教训 L008）：本文件测的就是"这些串该不该被拦"，
// 若把字面量写进源码，检测器自己的用例就会被自己判红（S8_INTERNAL_LEAK）——而给 deny 列表开例外
// 是**安全边界越开越大**，正解是运行时构造（运行时是真串、源码正文里不构成那个 token）。
test.after(cleanupAll);

const PROJECT_NAME = `myx${'V2'}`;                       // 内部项目名（拼接后才是真串）
const HOST_NO = `${'1'}${'01'}`;                         // 内部主机编号
const TEST_NET_IP = `${'203'}.${'0'}.${'113'}.${'9'}`;   // 文档用测试网段（不是真实基础设施）

/** 造一个最小落点（可选 config） */
function landing(label, config = null) {
  const dir = tempDir(label);
  mkdirSync(dir, { recursive: true });
  if (config !== null) writeFileSync(join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  writeFileSync(join(dir, 'rules.json'), `${JSON.stringify({ schema: 1, project: 't', protected_paths: [], gates: [], checks: [], inject: [] }, null, 2)}\n`, 'utf8');
  return dir;
}

test('判据①: public = identity + infra；private = 只 infra', () => {
  assert.equal(patternsForKind('public').length, IDENTITY_PATTERNS.length + INFRA_PATTERNS.length);
  assert.equal(patternsForKind('private').length, INFRA_PATTERNS.length);
  const priv = patternsForKind('private').map((p) => p.why);
  for (const why of ['内部项目名', '内部工具名', '内部结果行前缀', '内部容器仓名', '内部主机编号']) {
    assert.ok(!priv.includes(why), `private 档不该含 identity 类「${why}」`);
  }
  for (const why of ['本机用户绝对路径', '本机盘符路径', '私钥头（凭据）', '真实 IPv4（基础设施标识）', '云凭据/口令真值', '私钥文件名（基础设施标识）']) {
    assert.ok(priv.includes(why), `private 档必须含 infra 类「${why}」`);
  }
  assert.equal(PUBLIC_FACE_FORBIDDEN.length, IDENTITY_PATTERNS.length + INFRA_PATTERNS.length, 'PUBLIC_FACE_FORBIDDEN 兼容别名 = 公开档');
});

test('判据②: 解析顺序 config > remote > 兜底 private', () => {
  const conf = landing('rk-kind-conf', { schema: 1, mode: 'observe', repoKind: 'private' });
  assert.equal(declaredRepoKind(conf), 'private');
  const r1 = resolveRepoPatterns({ root: 'D:/opt/dsh-rulekeeper', landingDir: conf });
  assert.equal(r1.kind, 'private');
  assert.equal(r1.source, 'config', 'config 优先于远端探测（本仓远端是 github ⇒ 探测会给 public）');

  const noConf = landing('rk-kind-noconf');
  const r2 = resolveRepoPatterns({ root: 'D:/opt/dsh-rulekeeper', landingDir: noConf });
  assert.equal(r2.source, 'remote');
  assert.equal(r2.kind, 'public');

  const nowhere = resolveRepoPatterns({ root: tempDir('rk-kind-none'), landingDir: tempDir('rk-kind-none2') });
  assert.equal(nowhere.source, 'default');
  assert.equal(nowhere.kind, 'private', '探测不出来 ⇒ 兜底 private（宁可不扫名字，也不拦死内部仓）');
});

test('判据②b: 远端是公开托管商 ⇒ public；其它/无 remote ⇒ private/null', () => {
  const root = tempDir('rk-kind-remote');
  mkdirSync(join(root, '.git'), { recursive: true });
  const fake = (url) => () => ({ status: 0, stdout: `${url}\n` });
  assert.equal(detectRepoKind(root, { runGitRaw: fake('git@github.com:someone/repo.git') }), 'public');
  assert.equal(detectRepoKind(root, { runGitRaw: fake('https://gitlab.com/g/r.git') }), 'public');
  assert.equal(detectRepoKind(root, { runGitRaw: fake('git@internal.example:team/repo.git') }), 'private');
  assert.equal(detectRepoKind(root, { runGitRaw: () => ({ status: 1, stdout: '' }) }), null);
  assert.equal(detectRepoKind(tempDir('rk-kind-nogit')), null);
});

test('判据③: 同一个内部项目名 —— public 红、private 绿（三道门一致）', () => {
  const privLanding = landing('rk-kind-priv', { schema: 1, mode: 'observe', repoKind: 'private' });
  const pubLanding = landing('rk-kind-pub', { schema: 1, mode: 'observe', repoKind: 'public' });
  const repo = tempDir('rk-kind-repo');
  // 内部项目名 + 内部主机编号（identity 类）；写成"提交正文"形态直接过门
  const body = `fix: 把 ${PROJECT_NAME} 的 ${HOST_NO} 号机接进来\n`;

  const pub = commitMessageGate({ repoRoot: repo, messageFile: writeMsg(repo, body), landingDir: pubLanding });
  const priv = commitMessageGate({ repoRoot: repo, messageFile: writeMsg(repo, body), landingDir: privLanding });
  assert.equal(pub.ok, false, 'public 档必须拦住内部项目名');
  assert.ok(pub.findings.some((f) => f.code === 'GATE_COMMITMSG_INTERNAL_LEAK'));
  assert.equal(priv.ok, true, `private 档不该拦自己的名字；findings=${JSON.stringify(priv.findings)}`);

  // 引用名（pre-push 面）同档
  const stdin = `refs/heads/feat/${PROJECT_NAME}-x ${'a'.repeat(40)} refs/heads/feat/${PROJECT_NAME}-x ${'b'.repeat(40)}\n`;
  assert.equal(refsGate({ text: stdin, landingDir: pubLanding }).ok, false);
  assert.equal(refsGate({ text: stdin, landingDir: privLanding }).ok, true);

  // 暂存文件（pre-commit 面）同档：写一个含内部项目名的文件并"暂存"
  writeFileSync(join(repo, 'note.md'), `见 ${PROJECT_NAME} 的部署说明\n`, 'utf8');
  // runGitRaw 的形态与 src/gate.mjs 的 stagedPaths 一致：`(repoRoot, argv) -> {ok, buffer}`
  const staged = (_repo, argv) => {
    if (argv[0] === 'diff') return { ok: true, status: 0, buffer: Buffer.from('note.md\0', 'utf8') };
    return { ok: true, status: 0, buffer: Buffer.from('', 'utf8') };
  };
  const prePub = precommitGate({ repoRoot: repo, landingDir: pubLanding, runGitRaw: staged });
  const prePriv = precommitGate({ repoRoot: repo, landingDir: privLanding, runGitRaw: staged });
  assert.ok(prePub.findings.some((f) => f.code === 'GATE_PRECOMMIT_INTERNAL_LEAK'), 'public 档必须拦住暂存文件里的内部项目名');
  assert.ok(!prePriv.findings.some((f) => f.code === 'GATE_PRECOMMIT_INTERNAL_LEAK'), `private 档不该拦；findings=${JSON.stringify(prePriv.findings.map((f) => f.code))}`);
  assert.equal(prePub.leakMode.kind, 'public');
  assert.equal(prePriv.leakMode.kind, 'private', '档位必须作为字段上报（不进 findings，否则私有仓每次提交都判红）');
});

test('判据④（反向）: 基础设施类两档都红 —— 私有仓照样会漏', () => {
  const privLanding = landing('rk-kind-priv2', { schema: 1, mode: 'observe', repoKind: 'private' });
  const repo = tempDir('rk-kind-repo2');
  const body = `fix: 连 ${TEST_NET_IP} 那台机器\n`;
  const out = commitMessageGate({ repoRoot: repo, messageFile: writeMsg(repo, body), landingDir: privLanding });
  assert.equal(out.ok, false, '真实 IPv4 在 private 档也必须红（基础设施标识不分公开/私有）');
  assert.ok(out.findings.some((f) => f.why === undefined && f.code === 'GATE_COMMITMSG_INTERNAL_LEAK'));
});

/** 写一个提交正文文件，返回路径 */
function writeMsg(repo, body) {
  const file = join(repo, `msg-${Math.random().toString(16).slice(2)}.txt`);
  writeFileSync(file, body, 'utf8');
  return file;
}
