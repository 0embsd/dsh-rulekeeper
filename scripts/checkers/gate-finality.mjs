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
 * 造红态样本（每次现造，规则 42）。**两棵**树，因为两类缺陷的判别路径不同：
 *   ① `crlf-unpinned`：CRLF 行尾 + `.gitattributes` 缺 `.githooks/*` 钉规则（A 与 D 的判别力）；
 *   ② `bad-subcommand`：行尾/钉规则**全干净**、四件齐备，但 hook **装错了子命令**
 *      （`pre-push` 里传 `commit-msg`）—— 这一棵专门证明 B 的判别力。
 *      为什么必须有它（P20 自曝）：B 改成语义等价类之后，如果只留 ① 那棵树，**把 B 整条删掉
 *      检查器照样"红"**（① 靠 A/D 就会红）⇒ B 的判别力没有任何东西在证明，属挂名判据。
 * 可用 `RULEKEEPER_GATE_FINALITY_RED_DIR` 把 ① 换成**调用方指定**的树（用例拿它钉"变化式间接调用"）
 * —— 这是"让判据能被外部拷问"的口子，不是隐藏开关：读不到/不是目录时**如实说**，不静默回退。
 */
function redTreeWithDispatch(dispatchName = 'pre-commit') {
  const dir = mkdtempSync(join(tmpdir(), 'rk-gf-red-'));
  const hd = join(dir, HOOKS_DIR);
  mkdirSync(hd, { recursive: true });
  writeFileSync(join(dir, '.gitattributes'), '*.mjs text eol=lf\n', 'utf8');
  // CRLF 必须用**字节**写：Windows 上的 writeFileSync('utf8') 不会替我们把 \n 变成 \r\n
  writeFileSync(join(hd, 'pre-commit'), Buffer.from(`#!/bin/sh\r\nroot=$(git rev-parse --show-toplevel) || exit 1\r\nexec node "$root/.dsh-ai/rulekeeper/hook.mjs" ${dispatchName} "$@"\r\n`, 'utf8'));
  return { dir, note: `CRLF + 缺 .githooks/* 钉规则（子命令传的是 ${dispatchName}）` };
}

/** 2 号样本树：行尾干净、钉规则齐、四件齐备，但 pre-push 把自己的子命令装错 */
function buildBadSubcommandSample() {
  const dir = mkdtempSync(join(tmpdir(), 'rk-gf-badsub-'));
  try {
    const hd = join(dir, HOOKS_DIR);
    mkdirSync(hd, { recursive: true });
    writeFileSync(join(dir, '.gitattributes'), `${HOOKS_DIR}/*  text eol=lf\n`, 'utf8');
    const body = (sub) => '#!/bin/sh\n'
      + 'root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 1\n'
      + `exec node "$root/.dsh-ai/rulekeeper/hook.mjs" ${sub} "$@"\n`;
    for (const name of EXPECTED) {
      // 故意装错：pre-push 传 commit-msg（其余三件正确）
      const sub = name === 'pre-push' ? 'commit-msg' : name;
      writeFileSync(join(hd, name), body(sub), 'utf8');
    }
    return { dir, note: '四件齐备/行尾干净，但 pre-push 装了 commit-msg（B 的专属反例）' };
  } catch (err) {
    return { dir: null, note: `样本构造失败: ${String(err?.message ?? err)}` };
  }
}

function buildRedSample() {
  try {
    return redTreeWithDispatch('pre-commit');
  } catch (err) {
    return { dir: null, note: `样本构造失败: ${String(err?.message ?? err)}` };
  }
}

if (!existsSync(hooksDir)) {
  console.log(`GATE_FINALITY_HOOKS=absent（${HOOKS_DIR}/ 不存在 ⇒ 本条判据不适用）`);
  process.exit(2);
}

const hits = [];

const HOOK_RUNNER_RE = /\bhook\.mjs\b/;
const WORD_BOUNDARY = '[\\s;&|"\'$}{()]';
/**
 * B 的**判据面**（P20，2026-09-23）：这个 hook 有没有把自己的名字当作 hook.mjs 的子命令传下去。
 *
 * 来历：原实现是字面子串 `text.includes('hook.mjs" ' + name)` —— 它把**变量间接调用**
 * （`exec node "$runner" commit-msg "$@"`，runner 里存的是 hook.mjs 路径）判成"门禁空转"。
 * 那类写法语义上完全等价，被误判的代价是"没坏的东西被要求改"，比漏判更贵。而"真装错子命令"
 * （commit-msg 里传 `pre-push`）必须仍然判红 —— 容忍变量 ≠ 放弃判别力。
 *
 * 判定分两层，缺一层就判红：
 *   ① 文件里必须真的调到**派发器**（存在 `hook.mjs` 这个 token）；
 *   ② 文件里必须把**自己的名字**送到命令行上 —— 允许两种等价写法：
 *      · 字面名字（`... hook.mjs commit-msg "$@"` 或 `"commit-msg"`）；
 *      · 简单变量（`name=commit-msg` … `exec node "$runner" "$name" "$@"`）：只解析**无副作用的
 *        简单赋值**（`KEY=value` 与 `KEY="$OTHER/…"` 两种形态），解析不出名字就**如实判红**。
 * 已知边界（诚实登记，不是"已覆盖"）：更花哨的造名写法（函数返回、`$(printf …)`、`eval`）解析不出来，
 * 会被判红 —— 方向是"宁可要求人写清楚"，不假装能读懂任意 shell。
 */
function dispatchOf(text, name) {
  if (!HOOK_RUNNER_RE.test(text)) return { ok: false, kind: 'runner-missing' };
  const asWord = (t, n) => new RegExp(`(^|${WORD_BOUNDARY})${n}(?=$|${WORD_BOUNDARY})`, 'm').test(t);
  if (asWord(text, name)) return { ok: true, kind: 'ok' };
  // ②b：名字经**简单变量**传递 —— 只在词边界上取值（不匹配 `probe.mjs` 里的片段）
  const VAR = '[A-Za-z_][A-Za-z0-9_]*';
  const literals = new Map();
  for (const m of text.matchAll(new RegExp(`(?:^|\\n)[ \\t]*(?:export[ \\t]+)?(${VAR})=(?:"([^"\\n$]+)"|'([^'\\n]*)'|([^\\s;|&"'\\n]+))`, 'g'))) {
    literals.set(m[1], m[2] ?? m[3] ?? m[4] ?? '');
  }
  const resolves = new Map();
  const resolve = (key, depth = 0) => {
    if (resolves.has(key)) return resolves.get(key);
    if (depth > 4) return null;
    const raw = literals.get(key);
    if (raw === undefined) return null;
    // 纯变量透传（`A="$B"` 形态已在正则里落进「含 $ 的单段」分支 ⇒ 这里兜一层）
    const passthrough = new RegExp(`^\\$\\{?(${VAR})\\}?$`).exec(raw);
    const out = passthrough === null ? raw : resolve(passthrough[1], depth + 1);
    resolves.set(key, out);
    return out;
  };
  for (const key of literals.keys()) {
    if (resolve(key) === name && asWord(text, `\\$${key}|\\$\\{${key}\\}`)) return { ok: true, kind: 'ok' };
  }
  return { ok: false, kind: 'dispatch-missing' };
}

/** 对一棵树跑完整性四项；返回 {hits, indexNote, dispatch}（**纯函数式**：同样的树给同样的结论） */
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

  // ── B. 四件齐备 + 子命令传对（判据见 dispatchOf 上方）──────────────────────────
  const hd = join(treeRoot, HOOKS_DIR);
  const dispatch = {};
  for (const name of EXPECTED) {
    const file = join(hd, name);
    if (!existsSync(file)) {
      dispatch[name] = 'missing';
      out.push(`${HOOKS_DIR}/${name}: 缺失（收尾门禁四件不全）`);
      continue;
    }
    const text = readFileSync(file, 'utf8');
    const v = dispatchOf(text, name);
    dispatch[name] = v.kind;
    if (!v.ok && v.kind === 'runner-missing') {
      out.push(`${HOOKS_DIR}/${name}: 没有调到 hook.mjs（找不到 runner）⇒ 门禁空转`);
    } else if (!v.ok) {
      out.push(`${HOOKS_DIR}/${name}: 没有把自己的名字（${name}）作为 hook.mjs 的子命令传下去 ⇒ 门禁空转（变量间接调用是允许的，见脚本头部 P20）`);
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
  return { hits: out, indexNote, dispatch };
}

// ── 0) 显式诊断模式（P20 新增）：对**指定的一棵树**跑同一份 inspectTree 并打印分诊读数 ────
// 为什么需要：B 的判据面是"这个 hook 有没有把自己的名字当子命令传下去"，而**活体证明**（下面第 2 段）
// 只能自证"某几棵树判红/判绿"。要把"变量间接调用"与"真装错子命令"这两侧的判别力**摆到台面上**，
// 需要一个可被外部拷问的入口。与"给判据开后门"的区别：本模式**只读、只打印、立即退出**，
// **不参与**任何判定路径 —— 活体证明该跑还跑（不当开关用）。
if (process.env.GATE_FINALITY_MODE === 'export') {
  const target = process.env.RULEKEEPER_SAMPLE_DIR ?? root;
  if (!existsSync(target)) {
    console.log(`GATE_FINALITY_MODE=export 的目标不存在：${target.split('\\').join('/')}`);
    process.exit(2);
  }
  const r = inspectTree(target);
  const dispatch = Object.entries(r.dispatch).map(([k, v]) => `${k}=${v}`).join(',');
  const root2 = target.split('\\').join('/');
  console.log(`GATE_FINALITY_MODE=export ROOT=${root2} INDEX=${r.indexNote} DISPATCH=${dispatch}`);
  for (const h of r.hits) console.log(`  ${h}`);
  console.log(`GATE_FINALITY_EXPORT_HITS=${r.hits.length}`);
  process.exit(r.hits.length > 0 ? 1 : 0);
}

// ── 1) 被检对象：真实树 ────────────────────────────────────────────────────────
const real = inspectTree(root);
for (const h of real.hits) hits.push(h);

// ── 2) 反例面：红态样本必须**现造**且必须判红（规则 42：判据不能只在现场违规时才红）─────
const redParts = [];
let redOk = true;
const red = buildRedSample();
if (red.dir === null) {
  redOk = false;
  hits.push(`反例面不可用（${red.note}）⇒ 判据无法证明自己会开火`);
} else {
  redParts.push(`built(${red.note})`);
  try {
    const redOut = inspectTree(red.dir);
    // 如实打印这棵树的派发分诊：① 号样本的 pre-commit 是**装对了**的（它的缺陷在 CRLF/缺钉）
    // ⇒ 这里 `pre-commit=ok` 是正确读数；B 的判别力由 ② 号专属反例证明（见下）。
    const disp = Object.entries(redOut.dispatch).map(([k, v]) => `${k}=${v}`).join(',');
    redParts.push(`hits=${redOut.hits.length} dispatch=${disp}`);
    if (redOut.hits.length === 0) {
      redOk = false;
      hits.push(`反例面（${red.note}）**没有被判红** ⇒ 判据没有判别力（检查器已失效或规则被放宽）`);
    }
  } finally {
    try { rmSync(red.dir, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ }
  }
}

// B 的专属反例：行尾/钉规则全干净，只有"装错子命令"一条缺陷 ⇒ 必须判红
const badSub = buildBadSubcommandSample();
if (badSub.dir === null) {
  redOk = false;
  hits.push(`B 的专属反例不可用（${badSub.note}）⇒ 无法证明"装错子命令"会被判红`);
} else {
  try {
    const out = inspectTree(badSub.dir);
    redParts.push(`badsub built(${badSub.note}) hits=${out.hits.length}`);
    if (out.hits.length === 0) {
      redOk = false;
      hits.push(`B 的专属反例（${badSub.note}）**没有被判红** ⇒ "装错子命令"这条判别力是挂名的`);
    }
  } finally {
    try { rmSync(badSub.dir, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ }
  }
}

// ── 3) 两态样本必须成对入库（判定语义改动要留旧口径红 / 新口径绿）──────────────────
if (fixturesDeclared) for (const k of ['red', 'green']) {
  if (!existsSync(join(fixtureRoot, 'gate-two-state-' + k, 'README.md'))) {
    hits.push(`test-fixtures/gate-two-state-${k}: 两态样本缺失（判定语义改动没有可重跑的红样本 = 一次性判据，规则 42）`);
  }
}

console.log(`GATE_FINALITY_INDEX=${real.indexNote} HOOKS_EXPECTED=${EXPECTED.length} RED_SAMPLE=${redParts.join(' | ')} RED_OK=${redOk}`);
console.log(`GATE_FINALITY_DISPATCH=${Object.entries(real.dispatch).map(([k, v]) => `${k}=${v}`).join(',')}`);
if (hits.length > 0) {
  console.log(`GATE_FINALITY_VIOLATIONS=${hits.length}`);
  for (const h of hits.slice(0, 10)) console.log(`  ${h}`);
  process.exit(1);
}
console.log('GATE_FINALITY_VIOLATIONS=0');
process.exit(0);
