// dsh-rulekeeper · LF-810 **一键卸载 + 数据保全**
//
// 判据（条目 LF-810）：摘 hook（**先记原值**）→ 移除本工具装的东西 → **不删数据**；`export` 可重建。
//
// 判据（清单 LF-810 行）：
//   绿 = 重复卸载 exit=0；摘 hook **先记原值**；**不删数据**
//   红 = 卸载删数据 → 必红
//
// 本文件的三条"反假绿"设计：
//   · **先取数据见证、再卸载**：判据不是"卸载后目录里还有东西"，而是"**逐个数据文件 sha256 不变 + 账本条数不减**"
//     （用整个落点的 mtime/sha 会假红：hook runner 与 hooks 清单是**故意**被卸载掉的安装态文件）。
//   · **反向红**（§9.6 R3）：把 `ledger.jsonl` 手动删掉，证明同一套断言**真的会红**（否则分不清"判据恒真"与"事实成立"）。
//   · **手改过的 hook 不删**：删用户改动 = 破坏现场；保留并报 `HOOK_MODIFIED_KEPT` 才是安全方向。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runGate } from '../src/cli.mjs';
import { DEFAULT_HOOKS_PATH, HOOK_RUNNER, HOOKS_LOCAL_STATE, HOOKS_MANIFEST, installHooks, sha256File } from '../src/hooks.mjs';
import { landingDataWitness } from '../src/uninstall.mjs';
import { RC } from '../src/rc.mjs';
import { cleanupAll, copyPkg, ledgerEntry, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const PKG = join(import.meta.dirname, '..');
const GATE_BIN = join(PKG, 'bin', 'rk-gate.mjs');

function nodeCheck(file) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  return r.status ?? 1;
}

function capture(fn) {
  let out = '';
  let err = '';
  const rc = fn({ out: (t) => { out += String(t); }, err: (t) => { err += String(t); } });
  return { rc, out, err };
}
const gate = (args, env = {}) => capture((io) => runGate(args, io, env));
const git = (root, ...args) => {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  return { status: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
};

function gitRepo(label, { hooksPath = null } = {}) {
  const dir = tempDir(label);
  const root = join(dir, 'repo');
  mkdirSync(root, { recursive: true });
  const r = spawnSync('git', ['init', '-q', '-b', 'main', root], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git init 失败: ${r.stderr}`);
  if (hooksPath !== null) assert.equal(git(root, 'config', 'core.hooksPath', hooksPath).status, 0);
  writeFileSync(join(root, 'README.md'), 'x\n', 'utf8');
  return root;
}

/** 落点里的**数据**文件（不含 hook runner / hooks 清单 —— 那两个是安装态、卸载本来就要删） */
function writeData(root) {
  const landing = join(root, '.dsh-ai', 'rulekeeper');
  mkdirSync(join(landing, 'logs'), { recursive: true });
  mkdirSync(join(landing, 'snapshots'), { recursive: true });
  mkdirSync(join(landing, 'backups'), { recursive: true });
  mkdirSync(join(landing, 'proposals'), { recursive: true });
  writeFileSync(join(landing, 'config.json'), `${JSON.stringify({ schema: 1, mode: 'observe' }, null, 2)}\n`, 'utf8');
  const rows = [
    ledgerEntry({ id: 'l-1', ts: '2026-09-15T00:00:00.000Z', rule: 'R-1' }),
    ledgerEntry({ id: 'l-2', ts: '2026-09-15T00:01:00.000Z', rule: 'R-2' }),
  ];
  writeFileSync(join(landing, 'ledger.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  writeFileSync(join(landing, 'logs', 'gate.jsonl'), `${JSON.stringify({ schema: 1, ts: '2026-09-15T00:02:00.000Z', gate: 'precommit', ok: true })}\n`, 'utf8');
  writeFileSync(join(landing, 'snapshots', 'index.jsonl'), `${JSON.stringify({ schema: 1, path: 'a.txt' })}\n`, 'utf8');
  writeFileSync(join(landing, 'backups', 'a.txt.20260915-000000.bak'), 'old\n', 'utf8');
  writeFileSync(join(landing, 'proposals', 'p.md'), '# proposal\n', 'utf8');
  return landing;
}

/** 数据见证：数据文件清单（rel -> sha256）+ 账本条数（走**生产实现**同一个入口，避免"测试自己写一套判据"） */
function dataWitness(root) {
  const witness = landingDataWitness(join(root, '.dsh-ai', 'rulekeeper'));
  const files = {};
  for (const f of witness.files) files[f.path] = f.sha256;
  return { files, ledger: witness.ledgerEntries };
}

const uninstall = (args) => gate(['hooks', 'uninstall', ...args]);

test('green: install 记下"安装前的 core.hooksPath"（原本没有 -> existed=false）', () => {
  const root = gitRepo('lf810-prev-none');
  const ins = installHooks({ repoRoot: root, gateBin: GATE_BIN });
  assert.equal(ins.ok, true, JSON.stringify(ins.reasons));
  // P14：安装前状态住**本机态**（`hooks.local.json`）—— 它是"这台机器上的事实"，不入版本库
  const l = JSON.parse(readFileSync(join(root, '.dsh-ai', 'rulekeeper', HOOKS_LOCAL_STATE), 'utf8'));
  assert.deepEqual(l.previous, { hooksPath: null, existed: false }, '必须把"本来就没有"这件事本身记下来（否则卸载只能靠猜）');
});

test('green: 装前已有 core.hooksPath -> 记原值，且卸载后回到原值', () => {
  const root = gitRepo('lf810-prev-some', { hooksPath: '.myhooks' });
  const ins = installHooks({ repoRoot: root, gateBin: GATE_BIN });
  assert.equal(ins.ok, true, JSON.stringify(ins.reasons));
  const l = JSON.parse(readFileSync(join(root, '.dsh-ai', 'rulekeeper', HOOKS_LOCAL_STATE), 'utf8'));
  assert.deepEqual(l.previous, { hooksPath: '.myhooks', existed: true });
  assert.equal(git(root, 'config', '--get', 'core.hooksPath').out, DEFAULT_HOOKS_PATH, 'install 期间库里的值应指向本工具的 hooksPath');

  const r = uninstall(['--repo', root]);
  assert.equal(r.rc, RC.OK, r.err);
  assert.match(r.out, /RK_GATE_HOOKS_CONFIG_ACTION=restore/);
  assert.equal(git(root, 'config', '--get', 'core.hooksPath').out, '.myhooks', '必须回到原值（不是 unset）');
  assert.equal(existsSync(join(root, DEFAULT_HOOKS_PATH, 'pre-commit')), false);
});

test('green: 原本没有 -> 卸载后 core.hooksPath 未设置（unset）', () => {
  const root = gitRepo('lf810-prev-unset');
  installHooks({ repoRoot: root, gateBin: GATE_BIN });
  const r = uninstall(['--repo', root]);
  assert.equal(r.rc, RC.OK, r.err);
  assert.match(r.out, /RK_GATE_HOOKS_CONFIG_ACTION=unset/);
  assert.equal(git(root, 'config', '--get', 'core.hooksPath').status, 1, '应当未设置');
  assert.equal(git(root, 'config', '--get', 'core.hooksPath').out, '');
});

test('green: 数据保全 —— 卸载后逐个数据文件 sha256 不变、账本条数不减', () => {
  const root = gitRepo('lf810-keep');
  installHooks({ repoRoot: root, gateBin: GATE_BIN });
  writeData(root);
  const before = dataWitness(root);
  assert.ok(Object.keys(before.files).length >= 6, `数据见证应覆盖 config/账本/台账/快照/备份/提案: ${Object.keys(before.files)}`);
  assert.equal(before.ledger, 2);

  const r = uninstall(['--repo', root]);
  assert.equal(r.rc, RC.OK, r.err);
  assert.match(r.out, /RK_GATE_HOOKS_DATA_PRESERVED=true/);
  assert.match(r.out, /RK_GATE_HOOKS_LEDGER_ENTRIES=2/);
  assert.match(r.out, /RK_GATE_HOOKS_DATA_FILES=6/);

  const after = dataWitness(root);
  assert.deepEqual(after.files, before.files, '卸载**不许**动数据文件（内容逐字一致）');
  assert.equal(after.ledger, before.ledger);
  // 安装态文件确实被摘掉了
  assert.equal(existsSync(join(root, '.dsh-ai', 'rulekeeper', HOOK_RUNNER)), false);
  assert.equal(existsSync(join(root, '.dsh-ai', 'rulekeeper', HOOKS_MANIFEST)), false);
  assert.equal(existsSync(join(root, DEFAULT_HOOKS_PATH, 'post-commit')), false);
});

test('green: 重复卸载幂等 —— 连续两次 uninstall 都 exit=0，第二次 ALREADY_CLEAN', () => {
  const root = gitRepo('lf810-idem');
  installHooks({ repoRoot: root, gateBin: GATE_BIN });
  writeData(root);
  const first = uninstall(['--repo', root]);
  assert.equal(first.rc, RC.OK, first.err);
  assert.match(first.out, /RK_GATE_HOOKS_ALREADY_CLEAN=false/);
  const witness1 = dataWitness(root);

  const second = uninstall(['--repo', root]);
  assert.equal(second.rc, RC.OK, `重复卸载必须 exit=0（幂等），实测 rc=${second.rc} err=${second.err}`);
  assert.match(second.out, /RK_GATE_HOOKS_ALREADY_CLEAN=true/);
  assert.match(second.out, /RK_GATE_HOOKS_REMOVED=0/);
  assert.deepEqual(dataWitness(root), witness1, '第二次卸载也不许动数据');
});

test('green: 清单缺失但落点有数据 -> 卸载 exit=0 且数据分毫不动', () => {
  const root = gitRepo('lf810-nomanifest');
  writeData(root);
  const before = dataWitness(root);
  const r = uninstall(['--repo', root]);
  assert.equal(r.rc, RC.OK, r.err);
  assert.match(r.out, /RK_GATE_HOOKS_ALREADY_CLEAN=true/);
  assert.deepEqual(dataWitness(root), before);
});

test('红态④: 手改过的 hook **保留**（不删用户改动）并报 HOOK_MODIFIED_KEPT', () => {
  const root = gitRepo('lf810-modified');
  installHooks({ repoRoot: root, gateBin: GATE_BIN });
  const hookFile = join(root, DEFAULT_HOOKS_PATH, 'pre-commit');
  writeFileSync(hookFile, `${readFileSync(hookFile, 'utf8')}# 手工加一行\n`, 'utf8');
  const r = uninstall(['--repo', root]);
  assert.equal(r.rc, RC.OK, r.err);
  assert.equal(existsSync(hookFile), true, '改过的文件不能删（删了就是破坏现场）');
  assert.match(r.out, /FINDING GATE_HOOKS_UNINSTALL HOOK_MODIFIED_KEPT/);
  assert.match(r.out, /RK_GATE_HOOKS_KEPT=1/);
  // 没改的那个照删
  assert.equal(existsSync(join(root, DEFAULT_HOOKS_PATH, 'post-commit')), false);
});

test('红态⑤（反向红/N1）: 判据载体真的会红 —— 数据文件消失 / 账本条数减少都能被看见', () => {
  const root = gitRepo('lf810-witness');
  writeData(root);
  const before = landingDataWitness(join(root, '.dsh-ai', 'rulekeeper'));

  // ① 文件消失
  const ledger = join(root, '.dsh-ai', 'rulekeeper', 'ledger.jsonl');
  const kept = readFileSync(ledger);
  rmSync(ledger);
  const lostOne = landingDataWitness(join(root, '.dsh-ai', 'rulekeeper'));
  assert.notDeepEqual(lostOne.files, before.files, '判据必须能区分"数据还在"与"数据没了"');
  assert.equal(lostOne.ledgerEntries, 0, '条数也必须跟着变（不能只看文件在不在）');

  // ② 文件在但条数减少（截断：文件仍在、sha 变了 —— 只比"文件在不在"的实现会漏判）
  writeFileSync(ledger, `${JSON.stringify(ledgerEntry({ id: 'l-1', ts: '2026-09-15T00:00:00.000Z', rule: 'R-1' }))}\n`, 'utf8');
  const shrunk = landingDataWitness(join(root, '.dsh-ai', 'rulekeeper'));
  assert.equal(shrunk.ledgerEntries, 1);
  assert.ok(shrunk.ledgerEntries < before.ledgerEntries, '条数减少必须可判');
  writeFileSync(ledger, kept);
});

test('变异（N1）: 把卸载改成"删数据"的变体必须被判红（证明 DATA_LOST 判据不是摆设）', () => {
  // 变异体 = 包的一份副本，在"复核数据"之前插入 `rmSync(landing, {recursive:true})`
  const mutant = copyPkg('lf810-mutant');
  const file = join(mutant, 'src', 'uninstall.mjs');
  const src = readFileSync(file, 'utf8');
  const anchor = '  const dataAfter = landingDataWitness(landing);';
  assert.equal(src.split(anchor).length - 1, 1, '变异锚点必须**恰**命中 1 次（不猜、不静默）');
  writeFileSync(file, src.replace(anchor, `  rmSync(landing, { recursive: true, force: true });\n${anchor}`), 'utf8');
  assert.equal(nodeCheck(file), 0, '变异体必须仍是合法 JS（否则"判红"可能来自语法错，不是判据）');

  // 正对照：同一个夹具用**真包**卸载 → exit=0
  const rootA = gitRepo('lf810-mutant-ok');
  installHooks({ repoRoot: rootA, gateBin: GATE_BIN });
  writeData(rootA);
  const okRun = spawnSync(process.execPath, [join(PKG, 'bin', 'rk-gate.mjs'), 'hooks', 'uninstall', '--repo', rootA], { encoding: 'utf8' });
  assert.equal(okRun.status, 0, `正对照必须绿: ${okRun.stdout}${okRun.stderr}`);
  assert.match(okRun.stdout, /RK_GATE_HOOKS_DATA_PRESERVED=true/);

  // 变异体：装 + 卸 → 必须 exit≠0 且点名 DATA_LOST
  const rootB = gitRepo('lf810-mutant-bad');
  installHooks({ repoRoot: rootB, gateBin: GATE_BIN });
  writeData(rootB);
  const badRun = spawnSync(process.execPath, [join(mutant, 'bin', 'rk-gate.mjs'), 'hooks', 'uninstall', '--repo', rootB], { encoding: 'utf8' });
  assert.notEqual(badRun.status, 0, `删数据的变体必须被判红（实测 rc=${badRun.status}）`);
  assert.match(badRun.stdout, /DATA_LOST/, badRun.stdout + badRun.stderr);
  assert.match(badRun.stdout, /RK_GATE_HOOKS_DATA_PRESERVED=false/);
});

test('红态⑥: 清单被改写指向数据文件 -> 拒绝删除（防"卸载删数据"最阴的一条路）', () => {
  const root = gitRepo('lf810-traversal');
  installHooks({ repoRoot: root, gateBin: GATE_BIN });
  writeData(root);
  const manifestFile = join(root, '.dsh-ai', 'rulekeeper', HOOKS_MANIFEST);
  const m = JSON.parse(readFileSync(manifestFile, 'utf8'));
  m.hooks = [...m.hooks, { name: '../../../ledger.jsonl', sha256: sha256File(join(root, '.dsh-ai', 'rulekeeper', 'ledger.jsonl')), bytes: 1 }];
  writeFileSync(manifestFile, `${JSON.stringify(m, null, 2)}\n`, 'utf8');
  // P14：runner 指纹在**本机态**里 ⇒ 要伪造"清单被改写指向数据文件"必须改这里
  const localFile = join(root, '.dsh-ai', 'rulekeeper', HOOKS_LOCAL_STATE);
  const l = JSON.parse(readFileSync(localFile, 'utf8'));
  l.runner = { path: 'config.json', sha256: sha256File(join(root, '.dsh-ai', 'rulekeeper', 'config.json')), bytes: 1 };
  writeFileSync(localFile, `${JSON.stringify(l, null, 2)}\n`, 'utf8');

  const before = dataWitness(root);
  const r = uninstall(['--repo', root]);
  assert.equal(r.rc, RC.OK, r.err);
  assert.match(r.out, /FINDING GATE_HOOKS_UNINSTALL HOOK_NAME_UNEXPECTED/);
  assert.match(r.out, /FINDING GATE_HOOKS_UNINSTALL HOOK_RUNNER_PATH_UNEXPECTED/);
  assert.deepEqual(dataWitness(root), before, '被指向的数据文件必须原封不动');
});


test('红态（CR-M3）: 旧格式（无 previous/configChanged）卸载后必须把 config 还回去', () => {
  // 独立审查 M3：旧实现先判 `configChanged !== true` ⇒ 直接 skip，把"旧清单"分支变成不可达代码，
  // 于是 hook 被摘、`core.hooksPath` 仍指向 `.githooks`（git 从此静默不跑 hook）却 exit=0。
  // P14：这两个字段现在住**本机态**里；"旧格式"= 本机态里没有它们（拆分前装的老落点就是这形状）。
  const root = gitRepo('lf810-legacy');
  installHooks({ repoRoot: root, gateBin: GATE_BIN });
  writeData(root);
  const localFile = join(root, '.dsh-ai', 'rulekeeper', HOOKS_LOCAL_STATE);
  const l = JSON.parse(readFileSync(localFile, 'utf8'));
  delete l.previous;
  delete l.configChanged; // 老格式：两个字段都没有
  writeFileSync(localFile, `${JSON.stringify(l, null, 2)}\n`, 'utf8');
  assert.equal(git(root, 'config', '--get', 'core.hooksPath').out, DEFAULT_HOOKS_PATH);

  const r = uninstall(['--repo', root]);
  assert.equal(r.rc, RC.OK, r.err);
  assert.match(r.out, /RK_GATE_HOOKS_CONFIG_ACTION=unset-unknown-previous/);
  assert.equal(git(root, 'config', '--get', 'core.hooksPath').status, 1, '旧格式也必须把 config 还回去（不能只摘 hook）');
  assert.equal(existsSync(join(root, DEFAULT_HOOKS_PATH, 'pre-commit')), false);
});

test('红态（CR-M4）: 连装两次不许把自己的值当"原值"（卸载后应回到"未设置"）', () => {
  const root = gitRepo('lf810-double');
  installHooks({ repoRoot: root, gateBin: GATE_BIN });
  const again = installHooks({ repoRoot: root, gateBin: GATE_BIN, force: true });
  assert.equal(again.ok, true, JSON.stringify(again.reasons));
  const l = JSON.parse(readFileSync(join(root, '.dsh-ai', 'rulekeeper', HOOKS_LOCAL_STATE), 'utf8'));
  assert.deepEqual(l.previous, { hooksPath: null, existed: false }, '第二次安装必须沿用旧记录里的原值（不是自己上次设的 .githooks）');
  assert.equal(again.previous.hooksPath, null);

  const r = uninstall(['--repo', root]);
  assert.equal(r.rc, RC.OK, r.err);
  assert.equal(git(root, 'config', '--get', 'core.hooksPath').status, 1, '卸载后必须回到"未设置"，不是还成一个悬空的 .githooks');
});

test('红态（CR-M5）: 清单 hooksPath 越界 -> 拒绝按它删除任何文件（防删到仓外）', () => {
  const root = gitRepo('lf810-escape');
  installHooks({ repoRoot: root, gateBin: GATE_BIN });
  writeData(root);
  const outside = join(root, '..', 'data');
  mkdirSync(outside, { recursive: true });
  const decoy = join(outside, 'pre-commit');
  writeFileSync(decoy, '#!/bin/sh\necho outside\n', 'utf8');

  const manifestFile = join(root, '.dsh-ai', 'rulekeeper', HOOKS_MANIFEST);
  const m = JSON.parse(readFileSync(manifestFile, 'utf8'));
  m.hooksPath = '../data';
  m.hooks = m.hooks.map((h) => ({ ...h, sha256: sha256File(decoy) }));
  writeFileSync(manifestFile, `${JSON.stringify(m, null, 2)}\n`, 'utf8');

  const r = uninstall(['--repo', root]);
  assert.equal(r.rc, RC.OK, r.err);
  assert.match(r.out, /FINDING GATE_HOOKS_UNINSTALL HOOK_HOOKSPATH_UNEXPECTED/);
  assert.equal(existsSync(decoy), true, '仓外文件绝不能被删');
});

test('红态（CR-m1）: 清单里没有 sha256 指纹 -> 保留不删（fail-closed，不许"跳过校验直接删"）', () => {
  const root = gitRepo('lf810-nosha');
  installHooks({ repoRoot: root, gateBin: GATE_BIN });
  const manifestFile = join(root, '.dsh-ai', 'rulekeeper', HOOKS_MANIFEST);
  const m = JSON.parse(readFileSync(manifestFile, 'utf8'));
  m.hooks = m.hooks.map((h) => { const { sha256, ...rest } = h; return rest; });
  writeFileSync(manifestFile, `${JSON.stringify(m, null, 2)}\n`, 'utf8');

  const r = uninstall(['--repo', root]);
  assert.equal(r.rc, RC.OK, r.err);
  assert.match(r.out, /HOOK_SHA_MISSING/);
  assert.equal(existsSync(join(root, DEFAULT_HOOKS_PATH, 'pre-commit')), true, '无可核对指纹时必须保留');
});

test('red->green 对照: 未安装时卸载不报错（不把"没装过"当失败）', () => {
  const root = gitRepo('lf810-notinstalled');
  const r = uninstall(['--repo', root]);
  assert.equal(r.rc, RC.OK, r.err);
  assert.match(r.out, /RK_GATE_HOOKS_ALREADY_CLEAN=true/);
});

test('rc=2: hooks 动作白名单（未知动作仍是用法错误）', () => {
  const root = gitRepo('lf810-usage');
  const r = gate(['hooks', 'uninstal', '--repo', root]);
  assert.equal(r.rc, RC.USAGE);
  assert.match(r.err, /未知动作/);
});

test('rc=2: uninstall --repo 非已存在目录', () => {
  const r = uninstall(['--repo', join(tempDir('lf810-missing'), 'nope')]);
  assert.equal(r.rc, RC.USAGE);
});
