#!/usr/bin/env node
// leak-check.mjs —— 检查器样例（`kind:"checker"` 的第一条**真**绑定用）
//
// 它判的是一条**真实存在**的纪律：公开面（src/ 与顶层文档）不得出现内部项目名 / 本机盘卷路径 /
// 基础设施标识（`selfcheck.checkSkeleton` 的 S8）。这条纪律在 2026-09-19 一天之内**复发三次**
// （脚本探针注释 → src/landing.mjs 注释 → src/similarity.mjs 注释），正是"文本纪律挡不住复发"的典型，
// 也正是 E1 说的"技术类教训只能靠 checker 才能变机械判据"。
//
// 约定（见 src/checker.mjs 顶部）：
//   · 被检根 = `process.env.RULEKEEPER_SAMPLE_DIR ?? process.cwd()`
//   · 命中 ⇒ exit 1；干净 ⇒ exit 0；跑不动 ⇒ exit 2（inconclusive 由绑定层判定）
//   · 只读、零网络、零写入
//
// 用法：RULEKEEPER_SAMPLE_DIR=<样本目录> node test/fixtures/checker/leak-check.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const root = process.env.RULEKEEPER_SAMPLE_DIR ?? process.cwd();
const SKIP_DIRS = new Set(['.git', 'node_modules', '.dsh-ai']);

// 与 selfcheck 的 S8 同源模式（这里是**独立实现**，故意不 import —— 检查器样例要能独立跑）
const PATTERNS = [
  { re: /\bmyxV2\b/i, why: '内部项目名' },
  { re: /\bmyx-[a-z]/i, why: '内部工具名' },
  { re: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/i, why: '本机用户绝对路径' },
  { re: /[A-Za-z]:\\opt\\/i, why: '本机盘符路径' },
];

const hits = [];
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
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(?:mjs|cjs|js|ts|md|json|yml|yaml|txt)$/i.test(name)) continue;
    const rel = relative(root, full).split(sep).join('/');
    const text = readFileSync(full, 'utf8');
    for (const { re, why } of PATTERNS) {
      const m = re.exec(text);
      if (m !== null) {
        hits.push(`${rel}: ${why}「${m[0]}」`);
        break;
      }
    }
  }
};
walk(root);

if (hits.length > 0) {
  console.log(`LEAK_FOUND=${hits.length}`);
  for (const h of hits.slice(0, 10)) console.log(`  ${h}`);
  process.exit(1);
}
console.log('LEAK_FOUND=0');
process.exit(0);
