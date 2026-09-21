#!/usr/bin/env node
// hooks-integrity.mjs —— 检查器：git hook 的**完整性**（L648 / L653 的机械化判据）
//
// 为什么需要它：hook 装了、sha256 也对，但两件事会让它"等于没装"——
//   ①**无扩展名** ⇒ `.gitattributes` 里按扩展名钉 LF 的规则管不到 hook 脚本，
//     core.autocrlf=true 一 checkout 就把它转成 CRLF ⇒ a) 与 hooks.json 的 sha256 清单不符
//     b) POSIX 上 `#!/bin/sh\r` 直接坏掉（闸门变哑）。
//   ②**索引 mode 不是 100755** ⇒ POSIX 上 git **直接忽略**该 hook（Windows 上看不出来）。
// 两条都在 2026-09-21 现场验过（前者让 hooks verify 报 3 条 HOOK_MODIFIED；后者长期潜伏）。
//
// 约定（见 src/checker.mjs 顶部）：被检根 = `RULEKEEPER_SAMPLE_DIR ?? cwd`；
//   命中 ⇒ exit 1；干净 ⇒ exit 0；跑不动 ⇒ exit 2。只读、零网络、零写入。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.env.RULEKEEPER_SAMPLE_DIR ?? process.cwd();
const HOOKS_DIR = '.githooks';
const hooksDir = join(root, HOOKS_DIR);
const hits = [];

if (!existsSync(hooksDir)) {
  console.log('HOOKS_DIR=absent（本仓没装 hook ⇒ 本条判据不适用）');
  process.exit(0);   // 适用性边界：没装 hook 的仓不该被这条判红（装没装是另一条判据的事）
}

// ── A. hook 脚本必须只含 LF（CRLF 会让脚本在 POSIX 上直接坏掉）──────────────────
const hookFiles = readdirSync(hooksDir).filter((n) => {
  try { return statSync(join(hooksDir, n)).isFile(); } catch { return false; }
}).sort();
for (const name of hookFiles) {
  const buf = readFileSync(join(hooksDir, name));
  const crlf = buf.includes(Buffer.from('\r\n'));
  const loneCr = !crlf && buf.includes(Buffer.from('\r'));
  if (crlf || loneCr) hits.push(`${HOOKS_DIR}/${name}: 行尾不是纯 LF（${crlf ? 'CRLF' : '裸 CR'}）⇒ POSIX 上 shebang 行会坏`);
}

// ── B. `.gitattributes` 必须**显式**钉 `.githooks/*` 为 eol=lf ────────────────────
const gaPath = join(root, '.gitattributes');
const gaText = existsSync(gaPath) ? readFileSync(gaPath, 'utf8') : '';
const pinned = gaText.split(/\r?\n/).some((line) => {
  const t = line.trim();
  if (t === '' || t.startsWith('#')) return false;
  const [pattern, ...attrs] = t.split(/\s+/);
  if (!/^\.githooks\/(?:\*|\*\*)$/.test(pattern)) return false;
  return attrs.some((a) => a === 'eol=lf') && !attrs.includes('-text');
});
if (!pinned) hits.push(`${HOOKS_DIR}/*: .gitattributes 没有显式钉 eol=lf（按扩展名的规则管不到无扩展名的 hook）`);

// ── C. 索引 mode 必须是 100755（非 git 样本如实跳过，不假装检查过）────────────────
let indexNote = 'skipped(no-git)';
if (existsSync(join(root, '.git'))) {
  const r = spawnSync('git', ['-C', root, 'ls-files', '-s', HOOKS_DIR], { encoding: 'utf8' });
  if (r.status !== 0) {
    indexNote = `skipped(git exit=${r.status})`;
  } else {
    indexNote = 'checked';
    for (const line of String(r.stdout ?? '').split('\n')) {
      const m = /^(\d{6})\s+[0-9a-f]+\s+\d+\t(.+)$/.exec(line.trim());
      if (m === null) continue;
      if (m[1] !== '100755') hits.push(`${m[2]}: 索引 mode=${m[1]}（POSIX 上 git 会忽略非可执行 hook）`);
    }
  }
}

console.log(`INDEX_CHECK=${indexNote} HOOK_FILES=${hookFiles.length}`);
if (hits.length > 0) {
  console.log(`HOOKS_INTEGRITY_VIOLATIONS=${hits.length}`);
  for (const h of hits.slice(0, 10)) console.log(`  ${h}`);
  process.exit(1);
}
console.log('HOOKS_INTEGRITY_VIOLATIONS=0');
process.exit(0);
