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
// 夹具面豁免（与 rk-selfcheck 的 S8 同口径）：`test/fixtures/**` 与 `test-fixtures/**` 里放的是
// **故意违规的样本**（红态证据），不是被检对象。不豁免就会"全仓扫时把自己的红样本算成违规"。
const SKIP_DIRS = new Set(['.git', 'node_modules', '.dsh-ai', 'test-fixtures', 'fixtures']);

// ── **错档检测**（2026-09-21，P7）：本检查器判的是**公开面**泄漏（内部项目名/内部工具名/本机盘符路径）。
// 私有仓里"本仓自己的名字"**不是泄漏**（分档口径见 src/repo-patterns.mjs）⇒ 对私有仓它是**错档**：
// 实测在被治理项目（私有）上跑出 **296 条**，全是它自己的名字。
// 判据 → **exit 2（不适用）**，并指明该用什么替代；**不假装"不适用=通过"**。
// 读法：直接读落点 config（本检查器**刻意不 import** 插件源码，为的是能单跑）——
//   只有显式 `repoKind: "private"` 才拒跑；没声明/声明 public ⇒ 照常判（保守：宁可多扫）。
for (const rel of ['.dsh-ai/rulekeeper/config.json', '.dsh-ai/lessonflow/config.json']) {
  let kind = null;
  try {
    kind = JSON.parse(readFileSync(join(root, rel), 'utf8'))?.repoKind ?? null;
  } catch {
    continue;
  }
  if (kind === 'private') {
    console.log('LEAK_CHECK_SUBJECT=wrong-tier（本仓显式声明 repoKind=private ⇒ 公开面判据**不适用**）');
    console.log('  说明：私有仓里"本仓自己的名字"不是泄漏；硬扫会把自家名字全报成违规（实测 296 条）。');
    console.log('  替代：① 敏感面（IP/凭据/私钥/本机路径）用 `rk-gate precommit`（按 repoKind 分档）');
    console.log('        ② 字节纪律用 scripts/checkers/byte-discipline.mjs');
    process.exit(2);
  }
  break;
}

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
