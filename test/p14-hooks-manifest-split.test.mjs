// dsh-rulekeeper · P14 验收判据：`hooks.json` 入库面 / 本机面分家 + runner 去机器相关性
//
// 工单口径（对方已拍板，非开放决策）：**清单入库 + `hook:` 点名只核「名字在名单里」、不核 sha**；
// 补一条：「runner 指纹（机器相关）必须移出被跟踪文件」，否则「解决了跨机核不过、换来跨机工作区必脏」。
//
// 本文件钉住两件事（都是**可重跑**的判据，规则 42）：
//   ① `hook.mjs` 在**任意安装位置**生成的 sha 相同 ⇒ 入库的指纹不会因换机/换目录失配；
//   ② 入库的 `hooks.json` 只装**跨机稳定**的东西（钩子名 + sha256 + hooksPath），
//      随机器变化的一律在 `hooks.local.json`（保持被忽略）。
// 反向红：把"写死本机路径"的老写法（`refNaiveRunner`）造出来 ⇒ ① 必红（证明这条判据不是摆设）。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  HOOKS_LOCAL_STATE, HOOKS_MANIFEST, HOOK_RUNNER, hookRunnerContent, installHooks,
  localStatePathOf, manifestPathOf, readHooksState, sha256Text, verifyHooks,
} from '../src/hooks.mjs';
import { PKG_ROOT, tempDir } from './helpers/sandbox.mjs';

const GATE_BIN = join(PKG_ROOT, 'bin', 'rk-gate.mjs');

function git(root, ...args) {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}
function gitRepo(label, hooksPath = null) {
  const root = tempDir(label);
  assert.equal(git(root, 'init', '-q', '-b', 'main').status, 0);
  if (hooksPath !== null) assert.equal(git(root, 'config', 'core.hooksPath', hooksPath).status, 0);
  return root;
}
const read = (file) => readFileSync(file, 'utf8');

/** 造一个"假 rk-gate"：把收到的子命令写进日志文件后按 `FAKE_GATE_RC` 退出 */
function fakeGate(label) {
  const file = join(tempDir(label), 'rk-gate-fake.mjs');
  writeFileSync(file, [
    "import { appendFileSync } from 'node:fs';",
    'appendFileSync(process.env.FAKE_GATE_LOG, process.argv[2] + "\\n");',
    "process.exit(process.env.FAKE_GATE_RC === '0' ? 0 : 1);",
    '',
  ].join('\n'), 'utf8');
  return file;
}

/**
 * **反向红载体**：把"老写法"复刻出来 —— 把本机绝对路径写死进生成物。
 * 它用来证明判据①真的会红（而不是"怎么写都绿"）。语义上等于 P14 之前 `hookRunnerContent({gateBin})`。
 */
function refNaiveRunner(gateBin) {
  return [
    '#!/usr/bin/env node',
    `const GATE_BIN = ${JSON.stringify(gateBin.split('\\').join('/'))};`,
    '',
  ].join('\n');
}

/** 在给定仓库里装好钩子，返回三份产物的字节 */
function installAt(root, { gateBin = GATE_BIN, names } = {}) {
  const ins = installHooks({ repoRoot: root, gateBin, ...(names === undefined ? {} : { names }) });
  assert.equal(ins.ok, true, JSON.stringify(ins.reasons));
  const runnerFile = join(root, '.dsh-ai', 'rulekeeper', HOOK_RUNNER);
  return {
    ins,
    manifest: read(manifestPathOf(root)),
    local: read(localStatePathOf(root)),
    runner: read(runnerFile),
    runnerSha: sha256Text(read(runnerFile)),
  };
}

// ── ① 去机器相关性：任意安装位置 sha 相同（工单验收判据②）──────────────────────────────
test('P14①: `hook.mjs` 在**两处不同安装位置**生成的内容与 sha 逐字节相同', () => {
  const a = installAt(gitRepo('p14-loc-a'));
  const b = installAt(gitRepo('p14-loc-b'));
  assert.equal(a.runner, b.runner, '两处安装点的 runner 内容必须逐字节相同（不然入库的 sha 必然跨机失配）');
  assert.equal(a.runnerSha, b.runnerSha, 'runner sha256 必须相同');
  assert.equal(/(^|[^A-Za-z])[A-Za-z]:[\\/]/.test(a.runner), false, 'runner 里不得有盘符绝对路径');
  assert.equal(a.runner.includes(PKG_ROOT.split('\\').join('/')), false, 'runner 里不得回显包根绝对路径');
});

test('P14①反向红: "写死本机路径"的老写法在两处安装点 sha **不同**（证明 ① 不是空判）', () => {
  const rootA = gitRepo('p14-naive-a');
  const rootB = gitRepo('p14-naive-b');
  const naiveA = refNaiveRunner(join(rootA, 'bin', 'rk-gate.mjs'));
  const naiveB = refNaiveRunner(join(rootB, 'bin', 'rk-gate.mjs'));
  assert.notEqual(naiveA, naiveB, '老写法必须两处不同 —— 否则本判据测不出东西（空判）');
  assert.notEqual(sha256Text(naiveA), sha256Text(naiveB));
});

// ── ② 清单拆两半：入库面稳定 / 本机面才有机器相关字段 ────────────────────────────────
test('P14②: 入库的 `hooks.json` 只装跨机稳定字段；`createdAt`/runner 指纹/原值在本机态', () => {
  const a = installAt(gitRepo('p14-split-a'));
  const b = installAt(gitRepo('p14-split-b'));
  assert.equal(a.manifest, b.manifest, '不同安装点上入库清单必须逐字节相同（否则换机一装就脏）');
  const m = JSON.parse(a.manifest);
  assert.deepEqual(Object.keys(m).sort(), ['hooks', 'hooksPath', 'schema'], '清单只该有这三样');
  assert.equal(m.hooks.length, 4);
  for (const h of m.hooks) {
    assert.equal(typeof h.name, 'string');
    assert.equal(typeof h.sha256, 'string');
    assert.equal(typeof h.bytes, 'number');
    assert.equal(/(^|[^A-Za-z])[A-Za-z]:[\\/]/.test(JSON.stringify(h)), false, '钩子条目里不得有本机路径');
  }
  // 本机态承载"随机器变化"的东西
  const l = JSON.parse(a.local);
  for (const key of ['createdAt', 'runner', 'previous', 'configChanged']) {
    assert.equal(Object.prototype.hasOwnProperty.call(l, key), true, `本机态必须含 ${key}`);
  }
  assert.equal(typeof l.runner.sha256, 'string');
  assert.equal(typeof l.gateBin, 'string', '本机态记下"这台机器是从哪装的"（人看得见，不入库）');
  // 两边本机态**允许**不同（时间/路径），但它们都不入库
  assert.notEqual(a.local, b.local, '本机态本来就会不同 —— 这正是它不该被跟踪的原因');
});

test('P14②: `.gitignore` 口径 —— `hooks.json` 入跟踪面、`hooks.local.json` 仍被忽略', () => {
  const root = gitRepo('p14-ignore');
  installAt(root);
  // 直接问 git 自己（不信手写的规则列表）
  const ignored = (rel) => git(root, 'check-ignore', '-q', '--', rel).status === 0;
  // 仓库里没有 .gitignore（临时仓）⇒ 用本包的规则文件当输入不可行；
  // 故这里换一种**可达的**核法：把本包的 .gitignore 抄进临时仓，再看 git 的判定。
  const pkgIgnore = read(join(PKG_ROOT, '.gitignore'));
  writeFileSync(join(root, '.gitignore'), pkgIgnore, 'utf8');
  assert.equal(ignored('.dsh-ai/rulekeeper/hooks.json'), false, '入库面：hooks.json 必须**不被忽略**');
  assert.equal(ignored('.dsh-ai/rulekeeper/hooks.local.json'), true, '本机面：hooks.local.json 必须**被忽略**');
  assert.equal(ignored('.dsh-ai/rulekeeper/hook.mjs'), true, 'runner 本身仍是本机产物（不入库）');
  assert.equal(ignored('.dsh-ai/rulekeeper/config.json'), false, '既有口径不破');
  assert.equal(ignored('.dsh-ai/rulekeeper/rules.json'), false, '既有口径不破');
  // 实际 add 一次：只有清单进得来（`git add -A` 后被跟踪的那一组）
  assert.equal(git(root, 'add', '-A').status, 0);
  const tracked = git(root, 'ls-files').stdout.split('\n').map((s) => s.trim()).filter((s) => s !== '');
  assert.equal(tracked.includes('.dsh-ai/rulekeeper/hooks.json'), true, `清单必须能被 add 进来：${tracked.join(' | ')}`);
  assert.equal(tracked.includes('.dsh-ai/rulekeeper/hooks.local.json'), false, '本机态不得被 add 进来');
});

// ── ③ runner 的运行时解析链（四路 + 全落空的 fail-closed）──────────────────────────────
/** 直接跑 runner，返回 {rc, out}；env 里可注入解析链的线索 */
function runRunner(root, { env = {}, args = ['pre-push'], input = '' } = {}) {
  const runner = join(root, '.dsh-ai', 'rulekeeper', HOOK_RUNNER);
  const r = spawnSync(process.execPath, [runner, ...args], {
    cwd: root, encoding: 'utf8', input,
    env: { ...process.env, RULEKEEPER_REPO: root, FAKE_GATE_RC: '1', ...env },
  });
  return { rc: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
const ZERO_REFS = 'refs/heads/main aaa1111 refs/heads/main 0000000000000000000000000000000000000000\n';

test('P14③: 解析链第①路 `RK_GATE_BIN` 命中 ⇒ 真的把门禁跑起来（不是静默跳过）', () => {
  const root = gitRepo('p14-chain-env');
  installAt(root);
  const log = join(root, 'gate.log');
  const r = runRunner(root, { env: { RK_GATE_BIN: fakeGate('p14-env-gate'), FAKE_GATE_LOG: log }, input: ZERO_REFS });
  assert.equal(existsSync(log), true, `门禁必须真的被调用；out=${r.out}`);
  assert.match(read(log), /refs/, 'refs 段必须先跑（引用名也是公开面）');
  assert.notEqual(r.rc, 0, '假门禁判红 ⇒ runner 必须非零');
});

test('P14③: 解析链第②路 —— **装钩子时记下的本机态入口**（少了这一路，装完当场不工作）', () => {
  // 真机实测踩到的洞：`installHooks` 明明拿着一个可用的 rk-gate 入口，却没把它记在 runner 能找到的地方
  // ⇒ 临时仓里一提交就"找不到入口"。这一路就是那个修法，必须有**独立**用例钉住。
  const root = gitRepo('p14-chain-local');
  installAt(root);
  const log = join(root, 'gate-local.log');
  const gate = fakeGate('p14-local-gate');
  const l = JSON.parse(read(localStatePathOf(root)));
  l.gateBin = gate.split('\\').join('/');
  writeFileSync(localStatePathOf(root), `${JSON.stringify(l, null, 2)}\n`, 'utf8');
  const r = runRunner(root, { env: { FAKE_GATE_LOG: log }, input: ZERO_REFS });
  assert.equal(existsSync(log), true, `必须走本机态这一路；out=${r.out}`);
  assert.notEqual(r.rc, 0, '假门禁判红 ⇒ 非零');
});

test('P14③: 本机态**优先于** node_modules（装的时候解析到的那个入口，就是"这台机器上的事实"）', () => {
  const root = gitRepo('p14-chain-order');
  installAt(root);
  const log = join(root, 'gate-order.log');
  const gate = fakeGate('p14-order-local');
  const l = JSON.parse(read(localStatePathOf(root)));
  l.gateBin = gate.split('\\').join('/');
  writeFileSync(localStatePathOf(root), `${JSON.stringify(l, null, 2)}\n`, 'utf8');
  // 同时放一个会"自报姓名"的 node_modules 替身：若它被选中，说明顺序反了
  const binDir = join(root, 'node_modules', 'dsh-rulekeeper', 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'rk-gate.mjs'), "console.log('NM_GATE_SHOULD_NOT_WIN');process.exit(0);\n", 'utf8');
  const r = runRunner(root, { env: { FAKE_GATE_LOG: log }, input: ZERO_REFS });
  assert.doesNotMatch(r.out, /NM_GATE_SHOULD_NOT_WIN/, '本机态应当先命中（它不是"缓存"，是安装时的解析结果）');
  assert.equal(existsSync(log), true, `本机态的入口必须被调用；out=${r.out}`);
});

test('P14③: 解析链第③路 `node_modules/dsh-rulekeeper/bin/rk-gate.mjs` 命中', () => {
  const root = gitRepo('p14-chain-nm');
  installAt(root);
  // 抹掉本机态的 gateBin ⇒ 逼它走 node_modules 这一路（只改这一处，保证测的是这一路）
  const l = JSON.parse(read(localStatePathOf(root)));
  delete l.gateBin;
  writeFileSync(localStatePathOf(root), `${JSON.stringify(l, null, 2)}\n`, 'utf8');
  const binDir = join(root, 'node_modules', 'dsh-rulekeeper', 'bin');
  mkdirSync(binDir, { recursive: true });
  // 用"打印自己是谁"的替身证明**这一路**被走到（不依赖环境变量）
  writeFileSync(join(binDir, 'rk-gate.mjs'), [
    "console.log('NM_GATE_CALLED ' + (process.argv[2] ?? ''));",
    'process.exit(0);',
    '',
  ].join('\n'), 'utf8');
  const r = runRunner(root, { input: ZERO_REFS });
  assert.match(r.out, /NM_GATE_CALLED refs/, `必须走 node_modules 这一路；out=${r.out}`);
  assert.equal(r.rc, 0, '替身全绿 ⇒ 放行');
});

test('P14③: 解析链第④路 落点 `config.json` 的 `gateBin` 命中', () => {
  const root = gitRepo('p14-chain-cfg');
  installAt(root);
  const l = JSON.parse(read(localStatePathOf(root)));
  delete l.gateBin; // 逼它走到最后一档
  writeFileSync(localStatePathOf(root), `${JSON.stringify(l, null, 2)}\n`, 'utf8');
  const log = join(root, 'gate4.log');
  const gate = fakeGate('p14-cfg-gate');
  writeFileSync(join(root, '.dsh-ai', 'rulekeeper', 'config.json'),
    `${JSON.stringify({ schema: 1, mode: 'observe', gateBin: gate.split('\\').join('/') }, null, 2)}\n`, 'utf8');
  const r = runRunner(root, { env: { FAKE_GATE_LOG: log }, input: ZERO_REFS });
  assert.equal(existsSync(log), true, `必须走 config.json 这一路；out=${r.out}`);
  assert.notEqual(r.rc, 0, '假门禁判红 ⇒ 非零');
});

test('P14③: 四路全落空 ⇒ **大声失败**（fail-closed，不静默回落到死路径）', () => {
  const root = gitRepo('p14-chain-none');
  installAt(root);
  // 本机态里的 gateBin 指向一个已被删掉的位置 ⇒ 这一路也落空
  const l = JSON.parse(read(localStatePathOf(root)));
  l.gateBin = join(root, 'no-such-gate', 'rk-gate.mjs').split('\\').join('/');
  writeFileSync(localStatePathOf(root), `${JSON.stringify(l, null, 2)}\n`, 'utf8');
  const r = runRunner(root, { input: ZERO_REFS });
  assert.notEqual(r.rc, 0, '找不到 rk-gate 入口必须非零（否则就是"以为有闸、其实没有"）');
  assert.match(r.out, /找不到 rk-gate 入口/, `必须点名是入口找不到；out=${r.out}`);
  assert.match(r.out, /RK_GATE_BIN/, '必须把"试过哪几路"列出来（可诊断）');
  assert.match(r.out, /hooks\.local\.json/, '必须列出本机态这一路');
  assert.match(r.out, /node_modules/, '必须列出 node_modules 这一路');
  assert.match(r.out, /hooks install/, '修法要给可执行的下一步');
});

// ── ④ 兼容与如实标注：老落点（本机态缺失 / 字段还在清单里）不许炸、也不许假装核过 ──────────
test('P14④: 老落点（无本机态、字段仍混在清单里）⇒ verify 仍核 runner 指纹且不因此判红', () => {
  const root = gitRepo('p14-legacy');
  const a = installAt(root);
  // 复刻"拆分之前装的老落点"：把本机态字段塞回清单，删掉本机态文件
  const legacy = { schema: 1, ...JSON.parse(a.manifest), ...JSON.parse(a.local) };
  writeFileSync(manifestPathOf(root), `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');
  rmSync(localStatePathOf(root));

  const v = verifyHooks({ repoRoot: root });
  assert.equal(v.localStatePresent, false);
  assert.equal(v.scope, 'manifest', '无本机态 ⇒ 跨机口径如实报 manifest');
  assert.equal(v.findings.some((f) => f.code === 'HOOK_RUNNER_UNVERIFIED'), false, '老格式里**有**指纹 ⇒ 应当照核，不算无从核');
  assert.equal(v.findings.some((f) => f.code === 'HOOK_RUNNER_MISSING'), false);
  assert.deepEqual(v.findings.filter((f) => f.code !== 'HOOK_NOT_EXECUTABLE'), [], '老格式不得因拆分而判红');

  // 真实改 1 字节 ⇒ 老格式也必须报 runner 被改（判据没被削弱）
  const rf = join(root, '.dsh-ai', 'rulekeeper', HOOK_RUNNER);
  writeFileSync(rf, `${read(rf)}\n// tampered\n`, 'utf8');
  const v2 = verifyHooks({ repoRoot: root });
  assert.equal(v2.findings.some((f) => f.code === 'HOOK_RUNNER_MODIFIED'), true, '老格式下改 runner 仍必须报 HOOK_RUNNER_MODIFIED');
});

test('P14④: 新 clone 形状（入库清单在、本机态不在）⇒ **如实标注"本机指纹无从核"**（advisory，不判红）', () => {
  const root = gitRepo('p14-newclone');
  installAt(root);
  rmSync(localStatePathOf(root)); // 新 clone：清单随库来了，本机态从来没生成过
  const v = verifyHooks({ repoRoot: root });
  const f = v.findings.find((x) => x.code === 'HOOK_RUNNER_UNVERIFIED');
  assert.ok(f !== undefined, `必须**明确标注**本机指纹无从核（P14 要治的就是静默失败）：${JSON.stringify(v.findings)}`);
  assert.equal(f.advisory, true, '这是"本机口径做不到"的如实标注，不是钩子坏了 ⇒ advisory');
  assert.match(f.message, /hook\.mjs/, '要说清是哪个文件');
  assert.match(f.message, /hooks install/, '要给出可执行的补救动作');
  assert.equal(v.ok, true, '跨机口径（名字核得过）不应因此判红');
  // 但"名字核得过"这件事必须可读
  assert.equal(v.hooks.filter((h) => h.present === true && h.match === true).length, 4);
});

test('P14④: `readHooksState` 合并视图 —— 本机态优先、清单回退，且来源如实', () => {
  const root = gitRepo('p14-state');
  installAt(root);
  const s1 = readHooksState(root);
  assert.equal(s1.source, 'local');
  assert.equal(s1.localPresent, true);
  assert.equal(s1.runner.sha256, sha256Text(read(join(root, '.dsh-ai', 'rulekeeper', HOOK_RUNNER))));
  // 把本机态改成一个"可辨认"的假指纹 ⇒ 合并视图必须取本机值（不是清单里的任何值）
  const l = JSON.parse(read(localStatePathOf(root)));
  l.runner = { path: HOOK_RUNNER, sha256: 'f'.repeat(64), bytes: 1 };
  writeFileSync(localStatePathOf(root), `${JSON.stringify(l, null, 2)}\n`, 'utf8');
  assert.equal(readHooksState(root).runner.sha256, 'f'.repeat(64), '本机态优先');
  // 删掉本机态 ⇒ 无 runner 可核（来源 none），不抛错
  rmSync(localStatePathOf(root));
  const s3 = readHooksState(root);
  assert.equal(s3.source, 'none');
  assert.equal(s3.runner, null);
  assert.equal(s3.manifest.hooks.length, 4, '清单仍读得到（跨机面照常）');
});

// ── ⑤ 卸载收尾：本机态不留残渣 ────────────────────────────────────────────────────────
test('P14⑤: 卸载把本机态一起摘掉（不是留个孤儿文件在落点里）', () => {
  const root = gitRepo('p14-uninstall');
  installAt(root);
  assert.equal(existsSync(localStatePathOf(root)), true);
  const r = spawnSync(process.execPath, [join(PKG_ROOT, 'bin', 'rk-gate.mjs'), 'hooks', 'uninstall', '--repo', root], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.equal(existsSync(localStatePathOf(root)), false, '卸载后本机态不得残留');
  assert.match(r.stdout, /HOOK removed hooks\.local\.json/);
});

test('P14⑤: 清单文件仍叫 `hooks.json`（口径变了、文件名不变 —— 别让读者两头找）', () => {
  assert.equal(HOOKS_MANIFEST, 'hooks.json');
  assert.equal(HOOKS_LOCAL_STATE, 'hooks.local.json');
  assert.equal(HOOK_RUNNER, 'hook.mjs');
});
