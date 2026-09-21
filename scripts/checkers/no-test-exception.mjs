#!/usr/bin/env node
// no-test-exception.mjs —— 检查器：deny 列表**不得**为测试方便开例外（纪律 CAT-TECH）
//
// 来历（教训 L008，真实事故）：给"提交正文/引用名脱敏"写用例时，夹具里直接写了可疑串字面量，
//   结果 `rk-selfcheck` 的 S8 报 2 条 `S8_INTERNAL_LEAK` —— **检测器的测试文件自己被脱敏门禁判红**。
//   第一反应是"给 deny 列表加个 allow 例外放行测试文件"，但那是**安全边界越开越大**：
//   例外一开，真泄漏也能藏在被放行的文件里。正解是夹具的"可疑串"**运行时拼装**。
//
// 判据（两条，任一命中 ⇒ exit 1）：
//   A. `src/**` 里的例外/放行表（`S9_CONSUMER_API` 这类专门登记的例外面，或含 `allow`/`exempt`/
//      `ALLOWLIST`/`EXEMPT` 的标识符）**不得**把 `test/` 下的文件列为被放行对象
//      （deny 列表不因"测试需要"开例外）。
//   B. `src/**` 里出现"S8/S8_INTERNAL_LEAK/S8_LEAK 常量数组被测试路径填充"的形态
//      （例如 `S8_ALLOW = ['test/...']`）⇒ 同上。
//
// 边界（诚实声明）：本检查器只判"**新的**测试例外有没有被写进豁免表"，它不判"某个可疑串
//   到底该不该判红"（那要靠运行时构造的夹具 + S8 本身）。命中面是确定的：豁免表里出现 `test/`。
//
// 对象面（被检对象）与**反例面**（红态样本来源）分开：
//   · 被检对象 = `RULEKEEPER_SAMPLE_DIR ?? cwd`（本仓 ⇒ 判**真实** src/ 的豁免表）
//   · 反例面 = `RULEKEEPER_FIXTURE_DIR ?? cwd/test-fixtures` ⇒ 红态样本是**每次现造**的：把
//     "给测试开例外"的语法逐次写进一次性临时目录（规则 42）。
//
// 约定（见 src/checker.mjs 顶部）：被检根 = `RULEKEEPER_SAMPLE_DIR ?? cwd`；
//   命中 ⇒ exit 1；干净 ⇒ exit 0；**没有 src/ ⇒ exit 2**（没有被测对象 ≠ 通过）。
//   检查器只读被检对象，只写自己的临时目录；零网络。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';

// 被检对象：由绑定层传入（RULEKEEPER_SAMPLE_DIR）；直接手工跑时 = 当前目录。cwd 恒为项目根。
const root = process.env.RULEKEEPER_SAMPLE_DIR ?? process.cwd();
// 两态样本（旧口径红 / 新口径绿）只在**显式声明了 fixture 根**时检查：`test-fixtures/red` 这种
// "被检对象 = 违规样本"的用法里，fixture 根不它旁边 —— 那种情况由项目侧那次检查负责。
const fixturesDeclared = typeof process.env.RULEKEEPER_FIXTURE_DIR === 'string' && process.env.RULEKEEPER_FIXTURE_DIR !== '';
const fixtureRoot = process.env.RULEKEEPER_FIXTURE_DIR ?? join(root, 'test-fixtures');
const SRC = 'src';
const srcDir = join(root, SRC);
if (!existsSync(srcDir)) {
  console.log(`NO_TEST_EXCEPTION_SRC=absent（${SRC}/ 不存在 ⇒ 本条判据不适用）`);
  process.exit(2);
}

/** 现造一个违规样本树：豁免表里塞进测试路径。返回 null = 样本层不可用 */
function buildRedSample() {
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), 'rk-ne-red-'));
    mkdirSync(join(dir, SRC), { recursive: true });
    writeFileSync(join(dir, SRC, 'leaky.mjs'), [
      '// 违规样本：deny 列表为测试开了例外',
      'const S8_ALLOW = [',
      "  'test/hooks.test.mjs',",
      '];',
      'export default S8_ALLOW;',
      '',
    ].join('\n'), 'utf8');
    return { dir, note: '豁免表含 test/ 路径' };
  } catch (err) {
    if (dir !== undefined) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
    return { dir: null, note: `样本构造失败: ${String(err?.message ?? err)}` };
  }
}

/** 对一棵树的 `src/` 跑两条判据；返回命中列表（同样的树给同样的结论） */
function inspectTree(treeRoot) {
  const out = [];
  const base = join(treeRoot, SRC);
  const walk = (dir) => {
    let names;
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
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
      if (!/\.mjs$/.test(name)) continue;
      const rel = relative(treeRoot, full).split(sep).join('/');
      const text = readFileSync(full, 'utf8');
      // A：找"豁免表"标识符后面的字面量块，看里面有没有 test/ 路径
      const RE = /(?:ALLOWLIST|ALLOW_LIST|EXEMPT[A-Z_]*|allowlist|exempt|allowList)\s*[:=]\s*(?:Object\.freeze\(\s*)?[\[{]([\s\S]{0,2000}?)[\]}]/g;
      let m;
      while ((m = RE.exec(text)) !== null) {
        if (/['"`][^'"`]*\btest\//.test(m[1])) {
          const at = text.slice(0, m.index).split('\n').length;
          out.push(`${rel}:${at}: 豁免表里出现 test/ 路径 ⇒ deny 列表为测试开了例外（应改夹具运行时拼装，而不是放行）`);
        }
      }
      // B：S8 相关常量被 test/ 填充
      const RE_S8 = /S8[A-Z_]*\s*[:=]\s*[\[{]([\s\S]{0,600}?)[\]}]/g;
      while ((m = RE_S8.exec(text)) !== null) {
        if (/['"`][^'"`]*\btest\//.test(m[1])) {
          const at = text.slice(0, m.index).split('\n').length;
          out.push(`${rel}:${at}: S8 相关豁免里出现 test/ 路径 ⇒ 脱敏判据被测试放行`);
        }
      }
    }
  };
  walk(base);
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
  if (!existsSync(join(fixtureRoot, 'exception-two-state-' + k, 'README.md'))) {
    hits.push(`test-fixtures/exception-two-state-${k}: 两态样本缺失（判定语义改动没有可重跑的红样本 = 一次性判据，规则 42）`);
  }
}

console.log(`NO_TEST_EXCEPTION_ROOT=${root.split(sep).join('/')} RED_SAMPLE=${redNote}`);
if (hits.length > 0) {
  console.log(`NO_TEST_EXCEPTION_VIOLATIONS=${hits.length}`);
  for (const h of hits.slice(0, 10)) console.log(`  ${h}`);
  process.exit(1);
}
console.log('NO_TEST_EXCEPTION_VIOLATIONS=0');
process.exit(0);
