// dsh-rulekeeper · 行尾纪律检查器用例（L648/L653 的通用化）
//
// 判据（读死再下结论）：
//   ① 红样本三处违规都必须报：混行尾 / `.gitattributes` 零钉规则 / `.githooks` 未被显式钉
//   ② 绿样本零违规；真仓零违规（含"夹具面必须豁免"这一条：`test-fixtures/` 里放着故意违规的样本）
//   ③ 没有被测对象（既无 .gitattributes 也无 .githooks）⇒ rc=2（不是"通过"）
//
// 红 = 上面任一条被放宽（例如混行尾被忽略、或夹具面没豁免 ⇒ 真仓永远红）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanupAll, PKG_ROOT, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const CHECKER = join(PKG_ROOT, 'scripts', 'checkers', 'byte-discipline.mjs');

function run(sampleDir, extraEnv = {}) {
  const res = spawnSync(process.execPath, [CHECKER], {
    cwd: PKG_ROOT, encoding: 'utf8', env: { ...process.env, RULEKEEPER_SAMPLE_DIR: sampleDir, ...extraEnv },
  });
  return { rc: res.status, out: res.stdout ?? '', err: res.stderr ?? '' };
}

/** 把临时目录变成**真 git 仓**（默认扫描面靠 `git ls-files` 判定，夹具必须真） */
function gitInit(dir) {
  for (const args of [['init', '-q'], ['add', '-A']]) {
    const r = spawnSync('git', ['-c', 'core.quotePath=false', '-C', dir, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, `夹具 git ${args.join(' ')} 失败：${r.stderr}`);
  }
}

test('判据②: 真仓零违规（夹具面必须豁免，否则永远红）', () => {
  const res = run(PKG_ROOT);
  assert.equal(res.rc, 0, `真仓应零违规；out=${res.out}`);
  assert.match(res.out, /BYTE_DISCIPLINE_VIOLATIONS=0/);
  // 反向钉住豁免面：真仓里的红样本是**故意**的，不该算违规
  assert.match(res.out, /PINS=\d+/);
});

test('判据①: 混行尾 / 零钉规则 / .githooks 未钉 —— 三类都要报', () => {
  const dir = tempDir('byte-3');
  mkdirSync(join(dir, '.githooks'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.gitattributes'), '# 只有注释，没有任何钉规则\n', 'utf8');
  writeFileSync(join(dir, 'src', 'mixed.txt'), 'a\r\nb\nc\r\n', 'utf8');       // CRLF 与裸 LF 混在一起
  writeFileSync(join(dir, '.githooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', 'utf8');
  const res = run(dir);
  assert.equal(res.rc, 1);
  assert.match(res.out, /BYTE_EOL_INCONSISTENT/);
  assert.match(res.out, /BYTE_NOT_DECLARED/);
  assert.match(res.out, /BYTE_EXT_PIN_MISSING/);
});

test('判据②b: 显式钉住 + 纯 LF ⇒ 绿', () => {
  const dir = tempDir('byte-green');
  mkdirSync(join(dir, '.githooks'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.gitattributes'), '*.txt text eol=lf\n.githooks/*  text eol=lf\n', 'utf8');
  writeFileSync(join(dir, 'src', 'clean.txt'), 'a\nb\n', 'utf8');
  writeFileSync(join(dir, '.githooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', 'utf8');
  const res = run(dir);
  assert.equal(res.rc, 0, `应当绿；out=${res.out}`);
});

test('判据②c: 纯 CRLF（**不混**）不算违规 —— 判的是"混"与"没声明"，不是"必须 LF"', () => {
  const dir = tempDir('byte-crlf');
  writeFileSync(join(dir, '.gitattributes'), '*.txt text eol=crlf\n', 'utf8');
  writeFileSync(join(dir, 'all.txt'), 'a\r\nb\r\nc\r\n', 'utf8');
  const res = run(dir);
  assert.equal(res.rc, 0, `统一 CRLF 也有显式声明 ⇒ 不违规；out=${res.out}`);
});

test('判据③: 没有被测对象 ⇒ rc=2', () => {
  const empty = tempDir('byte-empty');
  const res = run(empty);
  assert.equal(res.rc, 2);
  assert.match(res.out, /SUBJECT=absent/);
});

// ── D/E（BOM / 结尾换行）与"提前 continue"那个 bug ─────────────────────────────
// 现场：检查器为省两次计数加了 `if (!crlf) continue;`，把 D/E 一起跳过 ⇒ **LF 文件从不参与**
// "结尾换行"检查（本仓 `src/gate.mjs` 缺结尾换行、判据却报 0，且该 bug 活过了一版与一次误报面检查）。
// 这些用例就是为这种情况写的：**纯 LF 文件**也必须被 D/E 判到。

test('判据④: 纯 LF 文件缺结尾换行 ⇒ 必须报（钉住"提前 continue"那个回归）', () => {
  const dir = tempDir('byte-noeol');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.gitattributes'), '*.mjs text eol=lf\n', 'utf8');
  // 纯 LF、但结尾没有换行（无 CRLF ⇒ 旧实现的 `if (!crlf) continue` 会让它整条被跳过）
  writeFileSync(join(dir, 'src', 'noeol.mjs'), 'const a = 1;', 'utf8');
  const res = run(dir);
  assert.equal(res.rc, 1, `应报"缺结尾换行"；out=${res.out}`);
  assert.match(res.out, /BYTE_NO_TRAILING_NEWLINE/);
  assert.match(res.out, /src\/noeol\.mjs/);
});

test('判据⑤: UTF-8 BOM ⇒ 必须报；无 BOM 的同样内容 ⇒ 绿', () => {
  const withBom = tempDir('byte-bom');
  mkdirSync(join(withBom, 'src'), { recursive: true });
  writeFileSync(join(withBom, '.gitattributes'), '*.mjs text eol=lf\n', 'utf8');
  writeFileSync(join(withBom, 'src', 'bom.mjs'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('const a = 1;\n', 'utf8')]));
  const resBom = run(withBom);
  assert.equal(resBom.rc, 1);
  assert.match(resBom.out, /BYTE_BOM_PRESENT/);

  const noBom = tempDir('byte-nobom');
  mkdirSync(join(noBom, 'src'), { recursive: true });
  writeFileSync(join(noBom, '.gitattributes'), '*.mjs text eol=lf\n', 'utf8');
  writeFileSync(join(noBom, 'src', 'ok.mjs'), 'const a = 1;\n', 'utf8');
  assert.equal(run(noBom).rc, 0);
});

test('判据⑥: D/E 只扫"手写面"（生成态目录不参与，可用环境变量改）', () => {
  const dir = tempDir('byte-scope');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'generated'), { recursive: true });
  writeFileSync(join(dir, '.gitattributes'), '*.mjs text eol=lf\n', 'utf8');
  // 生成态里放一个"无结尾换行"的文件 —— 默认不该报（噪声止损）
  writeFileSync(join(dir, 'generated', 'x.mjs'), 'const a = 1;', 'utf8');
  const def = run(dir);
  assert.equal(def.rc, 0, `生成态默认不扫；out=${def.out}`);

  // 显式把生成态纳入扫描面 ⇒ 就该报
  const res2 = spawnSync(process.execPath, [CHECKER], {
    cwd: PKG_ROOT, encoding: 'utf8',
    env: { ...process.env, RULEKEEPER_SAMPLE_DIR: dir, RULEKEEPER_BYTE_STRICT_DIRS: 'generated' },
  });
  assert.equal(res2.status, 1, `显式声明扫描面后应报；out=${res2.stdout}`);
  assert.match(res2.stdout ?? '', /BYTE_NO_TRAILING_NEWLINE/);
});

// ── P10（被治理项目侧实测：截断 + 顺序不稳 + 范围不明 ⇒ 诱发误操作）──────────────
// 现场：恒有 13 条违规但每次只打印约 12 条、且**每次文件集合几乎不重叠** ⇒ 他们按"修到收敛"
// 写了循环，四轮改了 **57 个文件**（还顺带改了内容），最后全部回滚。
// 三条判据：①全量打印并给 PRINTED/TOTAL；②同输入两次输出**逐字相同**；③范围（含未跟踪/忽略）明示。

test('判据⑦（P10）: 违规**全量打印**，PRINTED == TOTAL，且不得静默截断', () => {
  const dir = tempDir('byte-print');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.gitattributes'), '*.txt text eol=lf\n', 'utf8');
  // 造 20 个混行尾文件（远超原先的 slice(0,8) 上限）
  for (let i = 0; i < 20; i += 1) writeFileSync(join(dir, 'src', `m${String(i).padStart(2, '0')}.txt`), 'a\r\nb\n', 'utf8');
  const res = run(dir);
  assert.equal(res.rc, 1);
  const m = /BYTE_DISCIPLINE_PRINTED=(\d+) TOTAL=(\d+) TRUNCATED=(\w+)/.exec(res.out);
  assert.ok(m !== null, `必须给出 PRINTED/TOTAL 读数；out=${res.out}`);
  assert.equal(m[1], m[2], 'PRINTED 必须等于 TOTAL（要么全打印，要么显式交代差额）');
  assert.equal(m[3], 'no');
  const printed = res.out.split('\n').filter((l) => l.includes('BYTE_EOL_INCONSISTENT')).length;
  assert.equal(printed, 20, `20 条违规必须全部打印（实得 ${printed}）`);
});

test('判据⑧（P10）: 同输入两次运行，输出**逐字相同**（顺序确定化）', () => {
  const dir = tempDir('byte-stable');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.gitattributes'), '*.txt text eol=lf\n', 'utf8');
  for (const n of ['z.txt', 'a.txt', 'm.txt', 'b.txt']) writeFileSync(join(dir, 'src', n), 'x\r\ny\n', 'utf8');
  const first = run(dir).out;
  const second = run(dir).out;
  assert.equal(second, first, '同一仓库两次运行必须逐字相同（否则任何"迭代收敛"自动化都会失控）');
});

test('判据⑨（P10）: 范围必须明示（非 git 仓 ⇒ 如实降级为文件系统扫，并打标）', () => {
  const dir = tempDir('byte-scope-readout');
  writeFileSync(join(dir, '.gitattributes'), '*.txt text eol=lf\n', 'utf8');
  writeFileSync(join(dir, 'x.txt'), 'a\n', 'utf8');
  const res = run(dir);
  // 临时目录不是 git 仓 ⇒ 拿不到跟踪清单 ⇒ **不得假装**是 tracked 模式
  assert.match(res.out, /BYTE_DISCIPLINE_SCOPE MODE=filesystem INCLUDES_UNTRACKED=yes INCLUDES_GITIGNORED=yes/);
  assert.match(res.out, /UNTRACKED_FILES=\d+ SKIPPED_BINARY=\d+ SCANNED=\d+/);
});

// ── 判据⑩（P10 第二段：扫描面必须等于"仓库承诺面"）─────────────────────────────
// 现场：检查器的违规清单会被下游当成"要修的全集"，而它当时连**被 `.gitignore` 忽略/未跟踪**的
// 本地文件一起报（某仓 `docs/archive/**` 的里程碑草稿）⇒ "按清单迭代到收敛"永远收敛不到零
// （改了也不进库，下一轮照报）。所以默认面 = `git ls-files`，两种模式都要把面**打在首行**。
test('判据⑩: 默认只扫已跟踪文件；未跟踪/被忽略的违规文件不计入，但被计数（filesystem 模式才报）', () => {
  const dir = tempDir('byte-tracked-only');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.gitattributes'), '*.txt text eol=lf\n', 'utf8');
  writeFileSync(join(dir, 'src', 'tracked.txt'), 'a\nb\n', 'utf8');
  gitInit(dir);
  // 入库之后才出现的本地草稿：被 `.gitignore` 吃掉 ⇒ **不在承诺面内**（模拟真实仓的 `docs/archive/**`）
  writeFileSync(join(dir, '.gitignore'), 'local-draft.txt\n', 'utf8');
  writeFileSync(join(dir, 'src', 'local-draft.txt'), 'a\r\nb\n', 'utf8');
  // 前置事实：它确实**没**被跟踪（否则这条用例测的是别的东西）
  assert.equal(spawnSync('git', ['-C', dir, 'ls-files', '--error-unmatch', 'src/local-draft.txt'], { encoding: 'utf8' }).status !== 0, true);

  const tracked = run(dir);
  assert.equal(tracked.rc, 0, `未跟踪文件的违规不该计入；out=${tracked.out}`);
  assert.match(tracked.out, /BYTE_DISCIPLINE_SCOPE MODE=tracked INCLUDES_UNTRACKED=no INCLUDES_GITIGNORED=no/);
  // 2 = `.gitignore`（入库前刚写）+ `src/local-draft.txt`：读数口径是"文件系统里有、跟踪清单里没有的**所有**文件"
  assert.match(tracked.out, /UNTRACKED_FILES=2 /, '被排除的文件数必须显式打出（"看到的 ≠ 全部"不能隐形）');
  assert.doesNotMatch(tracked.out, /local-draft\.txt/);

  const all = run(dir, { RULEKEEPER_BYTE_SCAN: 'filesystem' });
  assert.equal(all.rc, 1, `显式要求全盘扫时应报；out=${all.out}`);
  assert.match(all.out, /BYTE_EOL_INCONSISTENT.*local-draft\.txt/);
});
