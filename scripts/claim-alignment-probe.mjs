// dsh-rulekeeper · 探针 C2：**claim 文本 ↔ 断言对象** 对齐检查（2026-09-19）
//
// 来历（为什么从 AST 转向"文本层"）：
//   C 方案第一轮（scripts/judgement-anchoring-probe.mjs）证明**纯 AST 不够** —— 规则 41 要判的是
//   "**人话里声称的目标**"↔"**verdict 的对象**"是否同一个，而"声称的目标"只存在于
//   测试函数名 / 断言消息（`t.Fatalf("...", ...)`、`assert.equal(a,b,"msg")`）这类**自然语言**里。
//   18/18 抽样假阳（myxV2 14 + rulekeeper 4）都源于此。
//   ⇒ C2 换切入口：**从文本里抽"声称的目标"，再核验它是否出现在被判的证据里**。
//
// 判据（H41-C2）：
//   在一个判据文件（`*_test.go` / `*.test.mjs`）里，逐条"断言/失败消息"取其**消息文本 + 所在测试函数名**，
//   从这两处抽**目标字面量**（路径样式：含 `/` 或 `\` 且带扩展名；或 `docs/…`、`internal/…` 这类仓内路径）。
//   若抽到目标，而该目标**既不在断言表达式里出现、也不在断言前 N 行内出现** ⇒ 记候选
//   （声称的目标与判据看的对象可能不是同一个 —— 规则 41 的核心形态）。
//
// 范围（delta 面）：默认只看**近期新增/改动**的判据文件（`git log --diff-filter=AM`）——
//   全量基线噪声大（C1 实测 myxV2 全树 H41′=1947），而"新增判据"才是风险面。
//
// 用法：node scripts/claim-alignment-probe.mjs <repo> [--delta 300] [--json]

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const RE_TEST_FN = /(?:func\s+(Test[A-Za-z0-9_]+)|(?:test|it)\(\s*['"`]([^'"`]+)['"`])/g;
const RE_ASSERT_MSG = /(?:t\.(?:Fatalf|Errorf|Fatal|Error)\(\s*['"`]([^'"`]{4,})['"`]|(?:assert|expect)[\w.]*\([^)]*,\s*['"`]([^'"`]{4,})['"`]\s*\))/g;
// 目标字面量：仓内路径样式（含分隔符 + 扩展名，或已知顶层目录）
const RE_TARGET_LITERAL = /((?:[A-Za-z0-9_.\-\u4e00-\u9fa5]+\/){1,}[A-Za-z0-9_.\-\u4e00-\u9fa5]+\.(?:go|mjs|js|ts|json|md|txt|yaml|yml|sh|ps1))|(?:docs|internal|cmd|test|src|scripts)\/[A-Za-z0-9_\-.\/\u4e00-\u9fa5]+/g;

function targetsIn(text) {
  const out = new Set();
  for (const m of String(text).matchAll(RE_TARGET_LITERAL)) out.add(m[0].replace(/^\.\//, ''));
  return [...out];
}

export function probeFile(file, rel) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const hits = [];

  // 逐个断言消息：取消息文本 + 最近的上方测试函数名
  let m;
  RE_ASSERT_MSG.lastIndex = 0;
  while ((m = RE_ASSERT_MSG.exec(text)) !== null) {
    const msg = m[1] ?? m[2] ?? '';
    const pos = m.index;
    const line = text.slice(0, pos).split('\n').length;
    const claimTargets = targetsIn(msg);
    if (claimTargets.length === 0) continue;
    // 函数名（向上找最近的 test 定义）
    const above = text.slice(0, pos);
    const fnMatches = [...above.matchAll(RE_TEST_FN)];
    const fnName = fnMatches.length > 0 ? (fnMatches[fnMatches.length - 1][1] ?? fnMatches[fnMatches.length - 1][2] ?? '') : '';
    for (const t of targetsIn(fnName)) claimTargets.push(t);
    if (claimTargets.length === 0) continue;
    // 证据面 = **断言的表达式部分**（去掉消息字面量！）+ **断言行之前**的 12 行。
    // 【仪器自纠 2026-09-19】第一版把 `text.slice(pos, pos+200)` 当证据面 ⇒ 断言自己的消息
    //   （必然含"声称的目标"）被算进证据 ⇒ `missing` 恒空 ⇒ **正对照都不响**（假阴性 0 候选）。
    //   教训对应 SKILL §9.6 R4：结论形如"实测为空"时，先用同一输入验证工具**能**给出非空结果。
    const callHead = m[0].slice(0, Math.max(0, m[0].indexOf(msg)));
    const evidence = lines.slice(Math.max(0, line - 13), Math.max(0, line - 1)).join('\n') + callHead;
    const missing = [...new Set(claimTargets)].filter((t) => !evidence.includes(t));
    if (missing.length === 0) continue;
    hits.push({
      code: 'H41C2-CLAIM-TARGET-NOT-IN-EVIDENCE',
      file: rel, line,
      text: msg.replace(/\s+/g, ' ').slice(0, 120),
      why: `消息/函数名声称的目标 [${missing.join(', ')}] 未出现在断言表达式或其前 12 行内 ⇒ 声称与判据可能不同对象（规则 41 · C2 候选）`,
    });
  }
  return hits;
}

export function probeRepo(repo, { delta = 300 } = {}) {
  let files = [];
  try {
    // **dogfood 规则 45**：git 路径输出必须带 -c core.quotePath=false
    const out = execFileSync('git', ['-C', repo, '-c', 'core.quotePath=false', 'log', '--diff-filter=AM', '--name-only', '--pretty=format:', '-n', String(delta)], { encoding: 'utf8' });
    files = [...new Set(out.split('\n').map((s) => s.trim()).filter((s) => s !== ''))]
      .filter((p) => /(_test\.go|\.test\.mjs|\.spec\.js)$/.test(p))
      .map((p) => join(repo, p))
      .filter((p) => existsSync(p));
  } catch (err) {
    return { files: 0, hits: [], error: `git 取 delta 清单失败: ${err.message}` };
  }
  const hits = [];
  for (const f of files) {
    try { hits.push(...probeFile(f, f.slice(repo.length + 1).replace(/\\/g, '/'))); } catch { /* 跳过不可读 */ }
  }
  return { files: files.length, hits };
}

if (process.argv[1]?.endsWith('claim-alignment-probe.mjs')) {
  const repo = process.argv[2];
  if (repo === undefined) { console.error('用法: node scripts/claim-alignment-probe.mjs <repo> [--delta N] [--json]'); process.exit(2); }
  const di = process.argv.indexOf('--delta');
  const delta = di === -1 ? 300 : Number(process.argv[di + 1]);
  const r = probeRepo(repo, { delta });
  if (process.argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); }
  else {
    console.log(`delta 判据文件 ${r.files} 个；H41C2 候选 ${r.hits.length} 条（**候选 ≠ 违规**，需人工裁定）`);
    for (const h of r.hits.slice(0, 30)) console.log(`  [${h.code}] ${h.file}:${h.line}\n      ${h.text}\n      ↳ ${h.why}`);
    if (r.hits.length > 30) console.log(`  … 其余 ${r.hits.length - 30} 条省略`);
  }
  process.exit(0);
}
