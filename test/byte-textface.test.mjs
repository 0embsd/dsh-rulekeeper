// dsh-rulekeeper · P18 + P12 用例：**文本面 = 非二进制**（不再靠扩展名白名单）+ **夹具面口径可见**
//
// 现场（2026-09-23，两侧各自实测）：
//   ① 本仓自己的 `.gitattributes`（**无扩展名**）从来没被这个检查器看过，而它当时正带着 1 处 CRLF
//      （`bytes=1439 crlf=1 lf=21`）—— 判据面被一个与事实无关的扩展名清单决定了；
//   ② 被治理项目独立复测："真混行尾 4 处，判据只报 1"；被过滤掉的文件**完全没计数**；
//   ③ 夹具面（`test-fixtures/`）的豁免口径只写在源码注释里，**输出里看不到** ⇒ 样本放错目录时，
//      人只会看到"仓库违规"，查不出是"被跳过的面"没覆盖到它。
//
// 本文件的判据：
//   ① 无扩展名 / 白名单之外扩展名的**文本**文件，混行尾必须被报（P18 的正面）
//   ② 二进制（含 NUL）仍必须跳过**并计数**（不许把压缩包当文本做行尾手术）
//   ③ 夹具面跳过了哪个目录、跳了多少文件，必须出现在输出的**计数字段**里（P12）
//   ④ `.gitattributes` **自己**没被钉住 ⇒ 必须报（`BYTE_GITATTRIBUTES_UNPINNED`）：
//      属性值带 `\r` 会让**所有规则失效**，且这与 `.gitignore` 的直觉相反（模式要写带前导点的全名）
//   ⑤ 真仓零误报（新口径不得让 `rk-selfcheck` / 交付判据变红）
//
// 反向红：把 `TEXT_EXT` 白名单加回去 ⇒ ①② 红。

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

function gitInit(dir, autocrlf = null) {
  const args = ['init', '-q'];
  spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (autocrlf !== null) spawnSync('git', ['-C', dir, 'config', 'core.autocrlf', String(autocrlf)], { encoding: 'utf8' });
  spawnSync('git', ['-C', dir, 'config', 'user.email', 'p@l'], { encoding: 'utf8' });
  spawnSync('git', ['-C', dir, 'config', 'user.name', 'p'], { encoding: 'utf8' });
}

test('P18①: 扩展名白名单之外的文本文件，混行尾必须被报（无扩展名 / .patch / .conf）', () => {
  const dir = tempDir('p18-face');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.gitattributes'), '*.mjs text eol=lf\n.gitattributes text eol=lf\n', 'utf8');
  // 三种都**不在**旧白名单里：无扩展名（与 `.gitattributes` 同类）、`.patch`、`.conf`
  writeFileSync(join(dir, 'NOTICE'), 'a\r\nb\n', 'utf8');
  writeFileSync(join(dir, 'fix.patch'), 'a\r\nb\n', 'utf8');
  writeFileSync(join(dir, 'src', 'app.conf'), 'a\r\nb\n', 'utf8');
  const res = run(dir);
  assert.equal(res.rc, 1, `白名单外的文本混行尾必须报；out=${res.out}`);
  for (const f of ['NOTICE', 'fix.patch', 'src/app.conf']) {
    assert.match(res.out, new RegExp(`BYTE_EOL_INCONSISTENT: ${f.replace(/[.]/g, '\\.')}`), `${f} 必须被扫到`);
  }
  // 计数字段必须与实际一致（P18 的"TOTAL 与真实一致"诉求）
  assert.match(res.out, /BYTE_DISCIPLINE_COUNTS mixed=3 /);
});

test('P18②: 二进制（含 NUL）仍跳过**并计数**，不得被当文本做行尾手术', () => {
  const dir = tempDir('p18-bin');
  writeFileSync(join(dir, '.gitattributes'), '*.mjs text eol=lf\n.gitattributes text eol=lf\n', 'utf8');
  writeFileSync(join(dir, 'blob.bin'), Buffer.from([0x41, 0x0d, 0x0a, 0x00, 0x42, 0x0a]));
  const res = run(dir);
  assert.equal(res.rc, 0, `二进制不算文本违规；out=${res.out}`);
  assert.match(res.out, /SKIPPED_BINARY=1/, '跳过的二进制必须计数（"少看了多少"要如实）');
  assert.doesNotMatch(res.out, /blob\.bin/);
});

test('P12: 夹具面口径必须打在输出里（跳过了哪个目录、多少文件）', () => {
  const dir = tempDir('p12-fixture');
  mkdirSync(join(dir, 'test-fixtures', 'red'), { recursive: true });
  writeFileSync(join(dir, '.gitattributes'), '*.mjs text eol=lf\n.gitattributes text eol=lf\n', 'utf8');
  // 夹具面里放一个**故意违规**的样本：它是证据，不是被检对象
  writeFileSync(join(dir, 'test-fixtures', 'red', 'mixed.txt'), 'a\r\nb\n', 'utf8');
  writeFileSync(join(dir, 'test-fixtures', 'red', 'README.md'), 'r\n', 'utf8');
  const res = run(dir);
  assert.equal(res.rc, 0, `夹具面里的样本不该算仓库违规；out=${res.out}`);
  assert.match(res.out, /BYTE_DISCIPLINE_FIXTURE_FACE dirs=test-fixtures skipped=test-fixtures\(2\)/,
    `跳过的夹具面必须可见（目录 + 文件数）；out=${res.out}`);
});

test('P18④: `.gitattributes` 自己没被钉住 ⇒ 必须报（属性带 \\r 会让所有规则失效）', () => {
  const dir = tempDir('p18-unpinned-ga');
  gitInit(dir, true);
  writeFileSync(join(dir, '.gitattributes'), '*.mjs text eol=lf\n', 'utf8');   // 没钉自己
  writeFileSync(join(dir, 'a.mjs'), 'const a = 1;\n', 'utf8');
  const res = run(dir);
  assert.equal(res.rc, 1, `属性表自己没钉住必须报；out=${res.out}`);
  assert.match(res.out, /BYTE_GITATTRIBUTES_UNPINNED/);
  // 修法必须写清楚"模式要带前导点"——这条与 .gitignore 直觉相反，是本轮 6 组实验换来的
  assert.match(res.out, /带前导点的全名/);
});

test('P18④b: 钉住之后同仓转绿（两向都验）', () => {
  const dir = tempDir('p18-pinned-ga');
  gitInit(dir, true);
  writeFileSync(join(dir, '.gitattributes'), '*.mjs text eol=lf\n.gitattributes text eol=lf\n', 'utf8');
  writeFileSync(join(dir, 'a.mjs'), 'const a = 1;\n', 'utf8');
  const res = run(dir);
  assert.equal(res.rc, 0, `钉住后必须绿；out=${res.out}`);
  assert.doesNotMatch(res.out, /BYTE_GITATTRIBUTES_UNPINNED/);
});

test('P18⑤: 真仓零误报（新口径不得让交付判据变红）', () => {
  const res = run(PKG_ROOT);
  assert.equal(res.rc, 0, `真仓必须零违规；out=${res.out}`);
  assert.match(res.out, /BYTE_DISCIPLINE_VIOLATIONS=0/);
  // 新口径必须**真的多看了文件**（否则"非二进制即文本"没生效）：SCANNED 至少覆盖无扩展名文件
  const scanned = Number(/SCANNED=(\d+)/.exec(res.out)?.[1] ?? '0');
  assert.equal(scanned > 250, true, `SCANNED 应覆盖所有文本文件（实得 ${scanned}）`);
});
