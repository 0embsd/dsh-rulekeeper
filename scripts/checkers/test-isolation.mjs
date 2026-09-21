#!/usr/bin/env node
// test-isolation.mjs —— 检查器：用例**不得**写真实落点（纪律 CONCURRENCY-IO）
//
// 来历（教训 L001，真实事故，两次）：给投递加"项目落点 ∪ 用户级落点"并集后，用例仍用 process.env
//   解析落点 ⇒ 8 个测试会话键（sc-*）被写进**真实**用户级 usage.json；该表有键数上限 ⇒ 测试键会
//   **挤掉真实会话**的去重记录（那些会话重启后会重复收到提醒）。根因不是"忘了传 env"，而是
//   **隔离靠自觉、没有机制面**。
//
// 判据（两条，任一命中 ⇒ exit 1）：**判的是"真实落点会不会被这套用例写到"，不是"有没有调某个函数"**
//   A. 用例树里存在"**真实落点来源** + 写动作"同处的文件 ⇒ 该文件是真污染路径，必须显式隔离
//      （`isolateProcessUserLanding()`）。
//   B. 整棵树里只要**任何**文件含真实落点来源，整套用例就必须有**进程级隔离机制面**：
//      必须有文件顶层调用 `isolateProcessUserLanding()`（一处机制，替代 N 处自觉传 env）。
//      一处都没有 ⇒ 隔离完全靠自觉，等于没隔离。
//
// 反面校准（写检查器时的两次实测，都记在案）：
//   ① 第一版把"导入了沙箱 helper 却没调隔离"**一律**判红 ⇒ 真仓一次报出 58 条，绝大多数只是
//      只读用例（根本不会写到真实落点）——那是拿"函数名"当判据，不是拿"对象会不会被写到"当判据。
//   ② 第二版改成"跟落点打交道且写文件就要隔离" ⇒ 仍报 41 条，因为**每个**用例都会在 tmpdir 里
//      造自己的落点（那是隔离的正确做法，不是污染）。故最终把判据钉在**真实落点来源**上：
//      `process.env.DSH_HOME` / `LESSONFLOW_HOME` / `RULEKEEPER_HOME`（拼 `.dsh` 的 homedir 形态）。
//
// 约定（见 src/checker.mjs 顶部）：被检根 = `RULEKEEPER_SAMPLE_DIR ?? cwd`；
//   命中 ⇒ exit 1；干净 ⇒ exit 0；跑不动 ⇒ exit 2。检查器只读被检对象、只写自己的临时目录；零网络。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';

// 被检对象：由绑定层传入（RULEKEEPER_SAMPLE_DIR）；直接手工跑时 = 当前目录。cwd 恒为项目根。
const root = process.env.RULEKEEPER_SAMPLE_DIR ?? process.cwd();
// 两态样本（旧口径红 / 新口径绿）只在**显式声明了 fixture 根**时检查：`test-fixtures/red` 这种
// "被检对象 = 违规样本"的用法里，fixture 根不它旁边 —— 那种情况由项目侧那次检查负责。
const fixturesDeclared = typeof process.env.RULEKEEPER_FIXTURE_DIR === 'string' && process.env.RULEKEEPER_FIXTURE_DIR !== '';
const fixtureRoot = process.env.RULEKEEPER_FIXTURE_DIR ?? join(root, 'test-fixtures');
// 跳过 `test-fixtures`：那里放的是**夹具树**（含故意违规的红样本），它不是被检对象；
// 被检对象是项目自己的 `test/` 与 `src/`。夹具树由绑定层的红态样本通道单独判。
const SKIP_DIRS = new Set(['test-fixtures', '.git', 'node_modules', '.dsh-ai', 'fixtures']);
const MJS_RE = /\.mjs$/;

/** 现造一个违规样本树：用例直取真实用户级落点且有写动作、且全树无隔离入口。返回 null = 样本层不可用 */
function buildRedSample() {
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), 'rk-ti-red-'));
    const target = join(dir, 'test');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'violating.test.mjs'), [
      "import { test } from 'node:test';",
      "import { join } from 'node:path';",
      "import { writeFileSync } from 'node:fs';",
      "import { cleanupAll, ledgerEntry } from './helpers/sandbox.mjs';",
      '',
      'test.after(cleanupAll);',
      '',
      "test('违规样本：直取真实用户级落点并写入', () => {",
      "  const home = process.env.DSH_HOME;",
      "  writeFileSync(join(home, 'lessonflow', 'usage.json'), '{}');",
      "  recordOnce({ projectRoot: home, input: ledgerEntry({ id: 'sc-x' }) });",
      '});',
      '',
    ].join('\n'), 'utf8');
    return { dir, note: '直取真实落点 + 写动作 + 全树无隔离入口' };
  } catch (err) {
    if (dir !== undefined) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
    return { dir: null, note: `样本构造失败: ${String(err?.message ?? err)}` };
  }
}

/** 对一棵树跑两条判据；返回命中列表（同样的树给同样的结论） */
function inspectTree(treeRoot) {
  const out = [];
  const files = [];
  const walk = (dir) => {
    let names;
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!MJS_RE.test(name)) continue;
      const rel = relative(treeRoot, full).split(sep).join('/');
      // 只扫"用例面"：`test/**` 下的 `.mjs`。**故意不要求 `.test.mjs` 后缀** —— 夹具树里的违规样本
      // 用中性文件名（`.sample.mjs`），否则 `node --test` 会把它当用例执行（实测：全量用例里多一条
      // 失败，而那条"失败"其实是夹具的故意违规）。判据看的是**文件内容**，不是文件名后缀。
      if (!rel.includes('test/') || rel.includes('test/helpers/')) continue;
      files.push({ rel, full });
    }
  };
  walk(treeRoot);

  let anyRealLanding = false;
  let anyMechanism = false;
  for (const f of files) {
    const text = readFileSync(f.full, 'utf8');
    const realUserLanding = /process\.env\.(DSH_HOME|LESSONFLOW_HOME|RULEKEEPER_HOME)\b/.test(text)
      || (/homedir\s*\(\s*\)/.test(text) && /['"]\.dsh['"]/.test(text));
    const writes = /\b(record|recordOnce|deliver[A-Za-z]*|prestep[A-Za-z]*|appendLine|writeFileSync|appendFileSync|mkdirSync|snapOnce|ledgerRecord|usageRecord)\s*\(/.test(text);
    const isolates = /\bisolateProcessUserLanding\s*\(/.test(text);
    if (realUserLanding) anyRealLanding = true;
    if (isolates) anyMechanism = true;
    // 机制实现面（`test/helpers/**`）本身就是那个"被允许直取真实落点"的地方（它要在退出前核对
    // 真实落点没被污染），故只对**用例文件**判"你有没有给自己的真实落点做隔离"。
    const isMechanismImpl = f.rel.includes('test/helpers/');
    if (realUserLanding && writes && !isolates && !isMechanismImpl) {
      out.push(`${f.rel}: 真实落点来源与写动作同处（DSH_HOME/homedir+.dsh）却没有进程级隔离 ⇒ 该文件会污染真实落点`);
    }
  }

  if (anyRealLanding && !anyMechanism) {
    out.push('用例树里出现真实落点来源，但**没有任何文件**调用 isolateProcessUserLanding() ⇒ 隔离完全靠自觉 = 没隔离');
  }
  return out;
}

// ── 1) 被检对象：真实树 ────────────────────────────────────────────────────────
const hits = inspectTree(root);

// ── 2) 反例面：红态样本必须现造且必须判红（规则 42）─────────────────────────────
const red = buildRedSample();
let redNote = 'built';
if (red.dir === null) {
  hits.push(`反例面不可用（${red.note}）⇒ 判据无法证明自己会开火`);
} else {
  try {
    const redHits = inspectTree(red.dir);
    redNote = `built(${red.note}) hits=${redHits.length}`;
    if (redHits.length === 0) hits.push(`反例面（${red.note}）**没有被判红** ⇒ 判据没有判别力`);
  } finally {
    try { rmSync(red.dir, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ }
  }
}

// ── 3) 两态样本必须成对入库（旧口径红 / 新口径绿）──────────────────────────────
if (fixturesDeclared) for (const k of ['red', 'green']) {
  if (!existsSync(join(fixtureRoot, 'isolation-two-state-' + k, 'README.md'))) {
    hits.push(`test-fixtures/isolation-two-state-${k}: 两态样本缺失（判定语义改动没有可重跑的红样本 = 一次性判据，规则 42）`);
  }
}

console.log(`TEST_ISOLATION_ROOT=${root.split(sep).join('/')} RED_SAMPLE=${redNote}`);
if (hits.length > 0) {
  console.log(`TEST_ISOLATION_VIOLATIONS=${hits.length}`);
  for (const h of hits.slice(0, 10)) console.log(`  ${h}`);
  process.exit(1);
}
console.log('TEST_ISOLATION_VIOLATIONS=0');
process.exit(0);
