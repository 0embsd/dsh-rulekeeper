#!/usr/bin/env node
// gate-finality.mjs —— 检查器：收尾门禁**四件齐备且真能跑**（纪律 GATE-DISCIPLINE）
//
// 来历（教训 L004 / L007 / L008 / L009）：hook 装是装了、sha 也对，但 ①行尾被 autocrlf 转成 CRLF
//   ⇒ POSIX 上 `#!/bin/sh\r` 直接坏掉、与 sha256 清单不符；②索引 mode 是 100644 ⇒ POSIX 上 git
//   **直接忽略**这些 hook（"以为有闸、其实没有"）；③手工复现钩子时 cwd 不在仓库根 ⇒ 脚本第一行就死，
//   退出码与"门禁判红"撞车（都是 1）⇒ 把"没跑起来"误判成"拦住了"。
//
// 判据（四条，任一命中 ⇒ exit 1）：
//   A. `.gitattributes` 必须**显式**钉 `.githooks/*` 为 eol=lf（无扩展名的 hook 靠按扩展名的规则管不到）。
//   B. `.githooks/` 里收尾四件（pre-commit / commit-msg / post-commit / pre-push）必须齐备，
//      且每件都把自己的名字作为 `hook.mjs` 的**子命令**传下去（装错子命令 = 门禁空转）。
//   C. 每件 hook 在**索引里**必须 mode=100755（非 git 样本如实跳过，不假装检查过）。
//   D. hook 脚本行尾必须纯 LF（CRLF/裸 CR ⇒ POSIX 上 shebang 坏）。
//
// 对象面（被检对象）与**反例面**（红态样本来源）分开：
//   · 被检对象 = `RULEKEEPER_SAMPLE_DIR ?? cwd`（本仓 ⇒ 判**真实** hook 的完整性）
//   · 反例面 = `RULEKEEPER_FIXTURE_DIR ?? cwd/test-fixtures` ⇒ 红态样本是**每次现造**的：CRLF 与
//     "缺钉规则"逐次写进一次性临时目录（规则 42：样本必须能在任何时刻重跑，不靠现场恰好违规）。
//     为什么造而不是入库：`test/fixtures/**` 在 .gitattributes 里是 `-text`，CRLF 恰好能被原样保留；
//     但**入库一份"坏树"**等于把红态钉死在某个历史形态上，造出来的样本才是活的。
//
// 约定（见 src/checker.mjs 顶部）：命中 ⇒ exit 1；干净 ⇒ exit 0；**没有 .githooks 目录 ⇒ exit 2**
//   （没有被测对象 ≠ 通过）。检查器只读被检对象，只写自己的临时目录；零网络。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

// 被检对象：由绑定层传入（RULEKEEPER_SAMPLE_DIR）；直接手工跑时 = 当前目录。cwd 恒为项目根。
const root = process.env.RULEKEEPER_SAMPLE_DIR ?? process.cwd();
// 两态样本（旧口径红 / 新口径绿）只在**显式声明了 fixture 根**时检查：`test-fixtures/red` 这种
// "被检对象 = 违规样本"的用法里，fixture 根不它旁边 —— 那种情况由项目侧那次检查负责。
const fixturesDeclared = typeof process.env.RULEKEEPER_FIXTURE_DIR === 'string' && process.env.RULEKEEPER_FIXTURE_DIR !== '';
const fixtureRoot = process.env.RULEKEEPER_FIXTURE_DIR ?? join(root, 'test-fixtures');
const HOOKS_DIR = '.githooks';
const EXPECTED = ['pre-commit', 'commit-msg', 'post-commit', 'pre-push'];
const hooksDir = join(root, HOOKS_DIR);

/**
 * 造一个"违规的收尾门禁"临时树：hook 用 CRLF 行尾 + `.gitattributes` 不钉 `.githooks/*`。
 * 返回 null 表示样本层自身不可用（不静默跳过 —— 缺样本要如实说）。
 */
function buildRedSample() {
  const dir = mkdtempSync(join(tmpdir(), 'rk-gf-red-'));
  const hd = join(dir, HOOKS_DIR);
  try {
    mkdirSync(hd, { recursive: true });
    writeFileSync(join(dir, '.gitattributes'), '*.mjs text eol=lf\n', 'utf8');
    // CRLF 必须用**字节**写：Windows 上的 writeFileSync('utf8') 不会替我们把 \n 变成 \r\n
    writeFileSync(join(hd, 'pre-commit'), Buffer.from('#!/bin/sh\r\nroot=$(git rev-parse --show-toplevel) || exit 1\r\nexec node "$root/.dsh-ai/rulekeeper/hook.mjs" pre-commit "$@"\r\n', 'utf8'));
    return { dir, note: 'CRLF + 缺 .githooks/* 钉规则' };
  } catch (err) {
    return { dir: null, note: `样本构造失败: ${String(err?.message ?? err)}` };
  }
}

if (!existsSync(hooksDir)) {
  console.log(`GATE_FINALITY_HOOKS=absent（${HOOKS_DIR}/ 不存在 ⇒ 本条判据不适用）`);
  process.exit(2);
}

const hits = [];

/** 对一棵树跑完整性四项；返回 {hits, indexNote}（**纯函数式**：同样的树给同样的结论） */
function inspectTree(treeRoot) {
  const out = [];
  // ── A. `.gitattributes` 必须显式钉 `.githooks/*` 为 eol=lf ──────────────────────
  const gaPath = join(treeRoot, '.gitattributes');
  const gaText = existsSync(gaPath) ? readFileSync(gaPath, 'utf8') : '';
  const pinned = gaText.split(/\r?\n/).some((line) => {
    const t = line.trim();
    if (t === '' || t.startsWith('#')) return false;
    const [pattern, ...attrs] = t.split(/\s+/);
    if (!/^\.githooks\/(?:\*|\*\*)$/.test(pattern)) return false;
    return attrs.some((a) => a === 'eol=lf') && !attrs.includes('-text');
  });
  if (!pinned) out.push(`${HOOKS_DIR}/*: .gitattributes 没有显式钉 eol=lf（按扩展名的规则管不到无扩展名的 hook）`);

  // ── B. 四件齐备 + 子命令传对 ──────────────────────────────────────────────────
  const hd = join(treeRoot, HOOKS_DIR);
  for (const name of EXPECTED) {
    const file = join(hd, name);
    if (!existsSync(file)) {
      out.push(`${HOOKS_DIR}/${name}: 缺失（收尾门禁四件不全）`);
      continue;
    }
    const text = readFileSync(file, 'utf8');
    if (!text.includes(`hook.mjs" ${name}`)) {
      out.push(`${HOOKS_DIR}/${name}: 没有以 "${name}" 作为 hook.mjs 的子命令调用 ⇒ 门禁空转`);
    }
  }

  // ── C. 索引 mode 必须 100755（非 git 样本如实跳过）────────────────────────────
  let indexNote = 'skipped(no-git)';
  if (existsSync(join(treeRoot, '.git'))) {
    const r = spawnSync('git', ['-C', treeRoot, 'ls-files', '-s', HOOKS_DIR], { encoding: 'utf8' });
    if (r.status !== 0) {
      indexNote = `skipped(git exit=${r.status})`;
    } else {
      indexNote = 'checked';
      for (const line of String(r.stdout ?? '').split('\n')) {
        const m = /^(\d{6})\s+[0-9a-f]+\s+\d+\t(.+)$/.exec(line.trim());
        if (m === null) continue;
        if (m[1] !== '100755') out.push(`${m[2]}: 索引 mode=${m[1]}（POSIX 上 git 会忽略非可执行 hook）`);
      }
    }
  }

  // ── D. 行尾必须纯 LF ─────────────────────────────────────────────────────────
  if (existsSync(hd)) {
    for (const name of readdirSync(hd).sort()) {
      let st;
      try { st = statSync(join(hd, name)); } catch { continue; }
      if (!st.isFile()) continue;
      const buf = readFileSync(join(hd, name));
      const crlf = buf.includes(Buffer.from('\r\n'));
      const loneCr = !crlf && buf.includes(Buffer.from('\r'));
      if (crlf || loneCr) out.push(`${HOOKS_DIR}/${name}: 行尾不是纯 LF（${crlf ? 'CRLF' : '裸 CR'}）⇒ POSIX 上 shebang 行会坏`);
    }
  }
  return { hits: out, indexNote };
}

// ── 1) 被检对象：真实树 ────────────────────────────────────────────────────────
const real = inspectTree(root);
for (const h of real.hits) hits.push(h);

// ── 2) 反例面：红态样本必须**现造**且必须判红（规则 42：判据不能只在现场违规时才红）─────
const red = buildRedSample();
let redNote = 'built';
if (red.dir === null) {
  hits.push(`反例面不可用（${red.note}）⇒ 判据无法证明自己会开火`);
} else {
  try {
    const redOut = inspectTree(red.dir);
    redNote = `built(${red.note}) hits=${redOut.hits.length}`;
    if (redOut.hits.length === 0) {
      hits.push(`反例面（${red.note}）**没有被判红** ⇒ 判据没有判别力（检查器已失效或规则被放宽）`);
    }
  } finally {
    try { rmSync(red.dir, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ }
  }
}

// ── 3) 两态样本必须成对入库（判定语义改动要留旧口径红 / 新口径绿）──────────────────
if (fixturesDeclared) for (const k of ['red', 'green']) {
  if (!existsSync(join(fixtureRoot, 'gate-two-state-' + k, 'README.md'))) {
    hits.push(`test-fixtures/gate-two-state-${k}: 两态样本缺失（判定语义改动没有可重跑的红样本 = 一次性判据，规则 42）`);
  }
}

console.log(`GATE_FINALITY_INDEX=${real.indexNote} HOOKS_EXPECTED=${EXPECTED.length} RED_SAMPLE=${redNote}`);
if (hits.length > 0) {
  console.log(`GATE_FINALITY_VIOLATIONS=${hits.length}`);
  for (const h of hits.slice(0, 10)) console.log(`  ${h}`);
  process.exit(1);
}
console.log('GATE_FINALITY_VIOLATIONS=0');
process.exit(0);
