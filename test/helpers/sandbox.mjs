// dsh-rulekeeper · 测试沙箱助手（LF-150）
//
// 为什么需要：LF-100 的用例曾在测试文件里**内联**构造临时副本；到 LF-130/LF-140 会大量复用，
// 故抽成助手。所有临时目录都登记在 CLEANUPS 里，测试结束统一清掉，**不碰真实落点**。
//
// 注意：node --test 会把 test/ 下所有 .mjs 当测试文件加载，故本文件（无 test() 调用）会以
// "0 个用例的文件"出现，属预期；fixtures 一律用非 .mjs 扩展名（见 test/fixtures/README 说明）。

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

import { resolveUserLanding } from '../../src/platform/paths.mjs';

/** dsh-rulekeeper 包根（<pkg>/test/helpers/sandbox.mjs → 上溯 3 级） */export const PKG_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const FIXTURES_DIR = join(PKG_ROOT, 'test', 'fixtures');

const CLEANUPS = [];

export function tempDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `lf-${label}-`));
  CLEANUPS.push(dir);
  return dir;
}

/** 造"全新项目 + 全新 DSH_HOME"的隔离环境 */
export function freshProject(label) {
  const root = tempDir(label);
  const projectRoot = join(root, 'proj');
  const home = join(root, 'lfhome');
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { root, projectRoot, home, env: { ...process.env, DSH_HOME: home } };
}

/** 拷贝一份包到临时目录（用于注入违规，不动真实包） */
export function copyPkg(label) {
  const dst = join(tempDir(label), 'pkg');
  cpSync(PKG_ROOT, dst, { recursive: true });
  return dst;
}

export function readFixture(name) {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8');
}

/**
 * **可用的 POSIX shell（bash）探测**——单一来源，别在用例里各写一份。
 *
 * 为什么需要（2026-09-23 在 Linux 上实测）：三个用例文件此前写成
 * `process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash'` 再
 * `existsSync(GIT_BASH)` 判可用性 —— 在 POSIX 上那是**相对路径**、永远不存在 ⇒ 真 Linux 载体上
 * 白跳 4 条用例（理由写着"本机没有可用的 bash"），而 `/usr/bin/bash` 明明在。
 * 「存在性检查必须用**可解析的路径**」是同族坑（本仓已记过多次）。
 *
 * @returns {{ok: boolean, shell: string, reason: string|null}}
 */
export function posixShell() {
  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']
    : ['/bin/bash', '/usr/bin/bash', '/bin/sh', '/usr/bin/sh'];
  for (const c of candidates) if (existsSync(c)) return { ok: true, shell: c, reason: null };
  // 再退一步：交给 PATH 解析（`spawnSync` 自己会找）
  const probe = spawnSync('bash', ['-c', 'exit 0'], { encoding: 'utf8' });
  if (probe.status === 0) return { ok: true, shell: 'bash', reason: null };
  return { ok: false, shell: '', reason: `本机没有可用的 POSIX shell（试过 ${candidates.join(' | ')} 与 PATH 里的 bash）` };
}

/**
 * 造一个"能跑的落点"（LF-280/290/295 用）：`config.json` + `rules.json` + `ledger.jsonl`。
 * 两个实测来的硬前提：
 *   · `rules.json` 必须**先存在**，否则"evolve 没动过 rules.json"这条判据是**空判**（sha 前后都是 null）
 *   · `ledger.jsonl` 末行**必须带换行**：readLines 把"末尾没有换行的行"当作没写完的半行
 *     （LF-160 的 truncatedTail 语义）——实测漏掉换行会让第 2 条记录静默消失、候选数变 0
 */
export function freshLanding(label, { mode = 'observe', entries = [], rules = true } = {}) {
  const root = tempDir(label);
  const landing = join(root, 'landing');
  mkdirSync(landing, { recursive: true });
  writeLandingFiles(landing, { mode, entries, rules });
  return { root, landing };
}

/**
 * 造"**项目里**的落点"（`<projectRoot>/.dsh-ai/rulekeeper`）+ 独立 `DSH_HOME`。
 * 为什么要单独一个助手（2026-09-19）：`landing.mjs` 的解析器判据是"从会话 cwd 推出项目落点"，
 * 而 `freshLanding` 造的落点**不在项目布局里**（`<tmp>/landing`）⇒ 拿它测解析器等于测不出东西。
 */
export function freshProjectLanding(label, { mode = 'observe', entries = [], rules = true, userLanding = false, projectLanding = true } = {}) {
  const { root, projectRoot, home, env } = freshProject(label);
  const landing = join(projectRoot, '.dsh-ai', 'rulekeeper');
  if (projectLanding) {
    mkdirSync(landing, { recursive: true });
    writeLandingFiles(landing, { mode, entries, rules });
  }
  if (userLanding) {
    const user = join(home, 'rulekeeper');
    mkdirSync(user, { recursive: true });
    writeLandingFiles(user, { mode, entries, rules });
    return { root, projectRoot, home, env, landing, userLanding: user };
  }
  return { root, projectRoot, home, env, landing, userLanding: null };
}

/** 落点三件套（`freshLanding` / `freshProjectLanding` 共用，避免两处写法漂移） */
function writeLandingFiles(landing, { mode = 'observe', entries = [], rules = true } = {}) {
  writeFileSync(join(landing, 'config.json'), `${JSON.stringify({ schema: 1, mode }, null, 2)}\n`, 'utf8');
  if (rules) writeFileSync(join(landing, 'rules.json'), readFixture('rules-ok.json'), 'utf8');
  const body = entries.map((e) => JSON.stringify(e)).join('\n');
  writeFileSync(join(landing, 'ledger.jsonl'), entries.length === 0 ? '' : `${body}\n`, 'utf8');
}

/** 一条合法账本行（字段取自 LF-120 冻结表；`activation` 是 P0-2 新增的**可选**字段） */
export function ledgerEntry({ id, ts, rule, category = '纪律', problem = 'p', rootCause = 'r', solution = 's', mechanism = 'm', evidence = [], activation }) {
  const row = {
    schema: 1, id, ts, rule, category, problem, root_cause: rootCause, solution,
    evidence, mechanism, recurrence: 1, first_seen: ts, last_seen: ts, status: 'active',
  };
  // 可选字段：**仅在显式给出时写入**（既有用例的行形状保持不变——它们不传 activation）
  if (activation !== undefined) row.activation = activation;
  return row;
}

export function cleanupAll() {
  while (CLEANUPS.length > 0) {
    const dir = CLEANUPS.pop();
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 把本进程的 `DSH_HOME` 指向一次性临时目录（**用例文件顶层调用一次**），返回恢复函数。
 *
 * 为什么需要（2026-09-21 实测教训 L644，两次污染）：投递记账是**按落点**写的。落点解析加了
 * "项目 ∪ 用户级"并集之后，任何用 `process.env` 解析落点的用例都会把**测试会话**写进**真实**用户级
 * `usage.json`。靠"每处调用记得传 env"= 靠自觉，实测挡不住 ⇒ 提升为**文件级一次性机制**。
 * @returns {{dir: string, restore: () => void}}
 */
export function isolateProcessUserLanding(label = 'home') {
  const saved = process.env.DSH_HOME;
  const dir = tempDir(`rk-${label}`);
  process.env.DSH_HOME = dir;
  return {
    dir,
    restore: () => {
      if (saved === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = saved;
    },
  };
}

/**
 * **真实用户级落点污染护栏**（2026-09-21 实测教训，不是预防性猜测）。
 *
 * 事故现场：投递记账是**按落点**写的（`bumpUsage` / `writeEmission`）。落点解析加了"项目 ∪ 用户级"
 * 并集之后，用例若**忘了传隔离 `env`**，`resolveUserLanding(process.env)` 就会解析到**真实的**
 * 用户级落点 ⇒ 测试会话（`sc-*`）的指纹被写进真实 `usage.json`（本次实测：8 个 `sc-*` 键落进
 * `~/.dsh/lessonflow/usage.json`，真实落点被污染，且 `emissions` 有 20 键上限——测试键会**挤掉**
 * 真实会话的去重记录 ⇒ 那些会话重启后会重复收到提醒）。
 *
 * 判据（规则 41 的对象级形态）：**真实用户级落点的 `emissions` 里不得出现测试会话键**。
 * 为什么不比对整文件哈希：活跃宿主进程会并发更新计数/时间戳（比对哈希会假红）；
 * 而"测试键"只会由测试写入 ⇒ 这条判据既精确又不看别人脸色。
 * 约定：**测试造的会话 id 一律以 `sc-` 开头**（见 `test/scoped-delivery.test.mjs`）。
 *
 * 两条腿（预防 + 检测，缺一不可）：
 *   · 预防 = `isolateProcessUserLanding()`（用例文件顶层一行）；
 *   · 检测 = 下面的**进程退出自动核对**（本模块被 import 即生效）+ 需要即时报错时显式 `assertClean`。
 */
export const TEST_SESSION_PREFIX = 'sc-';

/** 真实用户级落点（用**改动前**的 env 解析；`:memory:` 兜底见注释） */
function realUserLandingDir() {
  const real = process.env.RK_TEST_REAL_DSH_HOME;
  if (typeof real === 'string' && real !== '') {
    return resolveUserLanding(real === '(unset)' ? { ...process.env, DSH_HOME: '' } : { ...process.env, DSH_HOME: real });
  }
  return resolveUserLanding({ ...process.env });
}

const GUARD_DIR = realUserLandingDir();

export function realUserLandingGuard() {
  const file = join(GUARD_DIR, 'usage.json');
  const readKeys = () => {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      return Object.keys(data?.emissions ?? {});
    } catch {
      return null;   // 文件不存在/不可解析 ⇒ 没有污染可言
    }
  };
  return {
    dir: GUARD_DIR,
    file,
    assertClean(label = '用例') {
      const keys = readKeys();
      if (keys === null) return;
      const leaked = keys.filter((k) => k.startsWith(TEST_SESSION_PREFIX));
      assert.deepEqual(leaked, [],
        `${label}把测试会话写进了**真实**用户级落点 ${file}（实际 emissions 键：${JSON.stringify(keys)}）`);
    },
  };
}

/** 检查器（`scripts/checkers/*.mjs`）约定的"不适用"退出码（与 `git diff --exit-code` 同族用 2） */
export const CHECKER_EXIT_NOT_APPLICABLE = 2;

/**
 * **退出码语义守卫**：跑一个检查器脚本，并把"不适用"与"通过"**强制分开**。
 *
 * 来历（2026-09-23，本会话差点交付假绿）：给交付判据换绿样本夹具时，第一版夹具是个"没有可核绑定的落点"，
 * 于是 `misreport-surface` 在它上面走"不适用"路径 **exit 2** —— 而我的**断言写的是 `rc === 0`**，
 * 按说应当红；但同一批用例里凡是把"不适用"当"绿"来读的地方都看不出来。
 * 更早点还有同族两例：`ledger-live-verdict` 判据③（存在性被前导点欺骗）、`test-isolation` 首版 58 条误报。
 * 共同点：**"我没判"被读成了"判绿"**（规则 41 的同族：判据必须落在对象自己的事实上）。
 *
 * 约定：
 *   · `expect: 'verdict'`（默认，**判据面**）⇒ 断言"有结论"：`exit 0` 通过、`exit 1` 失败，
 *     而 `exit 2`（不适用）**直接判失败并给出可操作提示** —— 因为判据在"没有被测对象"时给出的是"未判"，
 *     把它当绿就是空转。
 *   · `expect: 'not-applicable'`（**只有显式声明**的用例才允许）⇒ 断言"确实是不适用"，且必须正好是 2。
 *   · 其他退出码：一律失败（如实报出）。
 *
 * @returns {{status: number|null, stdout: string, stderr: string, script: string, sampleDir: string|null}}
 */
export function runCheckerVerdict(script, { sampleDir = null, env = {}, cwd = PKG_ROOT, expect = 'verdict', label = '' } = {}) {
  const sampleAbs = sampleDir === null ? null : resolve(sampleDir);
  const childEnv = { ...process.env, ...env };
  if (sampleAbs === null) delete childEnv.RULEKEEPER_SAMPLE_DIR;
  else childEnv.RULEKEEPER_SAMPLE_DIR = sampleAbs;
  const res = spawnSync(process.execPath, [resolve(PKG_ROOT, script)], { cwd, encoding: 'utf8', env: childEnv });
  const info = {
    status: typeof res.status === 'number' ? res.status : null,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    script,
    sampleDir: sampleAbs,
  };
  const who = `${label === '' ? script : `${label}（${script}）`}`;
  if (expect === 'not-applicable') {
    assert.equal(info.status, CHECKER_EXIT_NOT_APPLICABLE,
      `${who}: 本用例显式断言"不适用"（exit 2），实得 exit=${info.status}\n${info.stdout}${info.stderr}`);
    return info;
  }
  if (info.status === CHECKER_EXIT_NOT_APPLICABLE) {
    assert.fail(`${who}: 检查器给出**"不适用"**（exit 2）而不是判定 —— "我没判"不等于"判绿"。\n`
      + `  被检根：${info.sampleDir ?? '(默认 cwd)'}\n`
      + `  输出首行：${String(info.stdout).split('\n').map((l) => l.trim()).filter((l) => l !== '')[0] ?? '(空)'}\n`
      + '  修法：要么给检查器一个**真有被测对象**的样本（例如落点里含至少一条由规格支撑的绑定），\n'
      + '        要么本用例确实在断言"不适用"⇒ 显式传 { expect: "not-applicable" }。');
  }
  if (info.status !== 0 && info.status !== 1) {
    assert.fail(`${who}: 非契约退出码 exit=${info.status}（判据面只接受 0=通过 / 1=命中 / 2=不适用）\n${info.stdout}${info.stderr}`);
  }
  return info;
}

/**
 * **进程退出前的自动核对**（模块加载即生效）：本文件被 import ⇒ 该测试进程的末尾必查一次。
 *
 * 为什么要自动（而不是让每个用例文件自己注册）：两次污染都是"忘了注册/忘了传 env"造成的 ——
 * 靠自觉的护栏等于没有护栏。自动兜底 + 非零退出码 = 漏了会**红**，不会静默。
 * 边界（如实）：只查 `emissions` 键（对象级）；计数被并发的活跃宿主改动静默放过（那本来就分不清）。
 */
process.on('exit', () => {
  try {
    const guard = realUserLandingGuard();
    const keys = (() => {
      try { return Object.keys(JSON.parse(readFileSync(guard.file, 'utf8'))?.emissions ?? {}); } catch { return null; }
    })();
    if (keys === null) return;
    const leaked = keys.filter((k) => k.startsWith(TEST_SESSION_PREFIX));
    if (leaked.length > 0) {
      console.error(`[污染护栏] 本测试进程把测试会话写进了真实用户级落点 ${guard.file}：${JSON.stringify(leaked)}`);
      console.error('[污染护栏] 修法：用例文件顶层调用 isolateProcessUserLanding()，并显式传 env（见 test/helpers/sandbox.mjs）');
      process.exitCode = 1;
    }
  } catch { /* 护栏自身绝不抛（否则会把测试进程搞崩） */ }
});
