// dsh-rulekeeper · 探针：规则 41/42 的**语义化**候选判据（C 方案原型，2026-09-19）
//
// 为什么要这个原型（老板 2026-09-19 决定"走 C 方案"）：
//   词法版探针（"代码里出现聚合布尔断言"）在四份真实语料上**假阳 100%**（6/6 抽样）——
//   因为 `chk := AuditXpadding(cfg); if !chk.OK` 里的 `chk` **本身就是被测对象**，断言它是对象级判据。
//   根因：同一个 `x.ok` 既可能是对象级也可能是聚合级，**词法层不可区分**。
//
// 本原型把判据从"有没有布尔"升级为"**这个布尔指向谁**"（对象绑定判定）：
//
//   H41′（对象绑定）对每个 `X.ok` / `X.OK` / `X.ok === false` 的引用：
//     ① 在**同一函数体**（花括号配平近似）内找 `X` 的绑定：
//        · `X := <call>(...)` / `X = <call>(...)` / `X, err := <call>(...)` ⇒ **对象级**（被测对象即该调用结果）→ 不算违规
//        · `X` 来自参数/全局/跨函数/读文件/聚合（如 `runAll()`、`json.Unmarshal` 的整包）⇒ 进 ②
//     ② 若该断言所在**代码块**里出现了**具体目标**（路径字面量 / 目标变量 / ID 字面量），
//        而断言只用了聚合布尔（没有对该目标的索引/查找/字段访问）⇒ **候选违规**（claim 与 verdict 不同对象）
//
//   H42′（样本构造）对**新增/改动的判据文件**：
//     文件里若存在"断言违规/失败"的判据，却**没有任何构造样本痕迹**（临时目录/派生落点/显式写夹具）
//     ⇒ 候选违规（判据依赖现场状态，稳态下不可复现）
//
// 用法：node scripts/judgement-anchoring-probe.mjs <目录或文件...> [--json]
// 输出：每个候选一行（file:line 文本 + 判定依据），末尾给计数。**候选 ≠ 违规**：需人工裁定。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const RE_AGG_USE = /\b([A-Za-z_][A-Za-z0-9_]*)\.(ok|OK|Ok)\b/g;
const RE_LOCAL_CALL = (name) => new RegExp(`\\b(?:const\\s+|let\\s+|var\\s+)?${name}\\s*(?::=|=(?!=))[^\\n]*?[A-Za-z_][A-Za-z0-9_]*\\s*\\(`);
const RE_TARGETY = /(['"])[^'"]*[\\/][^'"]*\1|\b(target|carrier|rule|path|id|key)\b/i;
const RE_INDEXED = /\[[^\]]+\]|\.find\(|\.filter\(|\.get\(|\.lookup\(|\.items?\b/i;
const RE_CONSTRUCT = /mkdtempSync|mkdtemp|tempDir|TempDir\(|t\.TempDir|t\.TempDir\(|freshLanding|freshProject|copyPkg|os\.MkdirTemp|MkdirTemp|WriteAllText|writeFileSync\(\s*join\(.*tmp|setup\(\)/i;
const RE_JUDGE = /violation|fail|FAIL|deny|denied|判红|应报错|必须失败|EFFECT_|not\s*ok|!=|!==/;

function walk(p, out = []) {
  const st = statSync(p);
  if (st.isFile()) { out.push(p); return out; }
  for (const name of readdirSync(p)) {
    if (name === 'node_modules' || name === '.git' || name === 'vendor') continue;
    walk(join(p, name), out);
  }
  return out;
}

/** 花括号配平近似：返回包含 pos 的最内层块 [start,end] */
function enclosingBlock(text, pos) {
  let depth = 0;
  let start = 0;
  const stack = [];
  let i = 0;
  let inStr = null;
  for (; i <= pos && i < text.length; i++) {
    const c = text[i];
    if (inStr !== null) {
      if (c === '\\') { i += 1; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (c === '{') { stack.push(i); continue; }
    if (c === '}') { stack.pop(); continue; }
  }
  start = stack.length > 0 ? stack[stack.length - 1] : 0;
  return [start, pos];
}

function lineOf(text, pos) { return text.slice(0, pos).split('\n').length; }
function lineText(text, pos) {
  const ls = text.slice(0, pos).lastIndexOf('\n') + 1;
  const le = text.indexOf('\n', pos);
  return text.slice(ls, le === -1 ? text.length : le).trim();
}

export function probeFile(file, root) {
  const text = readFileSync(file, 'utf8');
  const rel = root === null ? file : relative(root, file).split(sep).join('/');
  const hits = [];
  const isJudgeFile = RE_JUDGE.test(text);
  const hasConstruct = RE_CONSTRUCT.test(text);

  // H42′：判据文件里没有任何构造样本痕迹
  if (isJudgeFile && !hasConstruct && /(^|\/)(test|tests|spec)\b|_test\.|\.test\./.test(rel)) {
    hits.push({ code: 'H42-SAMPLE-NOT-CONSTRUCTED', file: rel, line: 0, text: '', why: '判据文件既无临时目录/派生落点，也无显式写夹具 ⇒ 可能依赖现场状态（规则 42）' });
  }

  // H41′：对象绑定判定
  let m;
  RE_AGG_USE.lastIndex = 0;
  while ((m = RE_AGG_USE.exec(text)) !== null) {
    const name = m[1];
    const pos = m.index;
    // ① 同一函数体（近似：向前 400 字符窗口 + 花括号块）里，X 是否由**就地调用**绑定
    const [bStart] = enclosingBlock(text, pos);
    const scope = text.slice(bStart, pos);
    const boundByCall = RE_LOCAL_CALL(name).test(scope.slice(-800));
    if (boundByCall) continue;                       // 对象级 ⇒ 不算违规（这正是词法版假阳的来源）
    // ② 块里出现具体目标字面量/标识，而该引用没有"按目标取用"的形态
    const blockText = text.slice(bStart, Math.min(text.length, pos + 200));
    if (!RE_TARGETY.test(blockText)) continue;        // 没有具体目标 ⇒ 谈不上"claim 与 verdict 不同对象"
    if (RE_INDEXED.test(m[0] + lineText(text, pos))) continue;
    hits.push({
      code: 'H41-AGGREGATE-FOR-TARGET',
      file: rel, line: lineOf(text, pos), text: lineText(text, pos).slice(0, 120),
      why: `块内有具体目标，但 \`${m[0]}\` 的绑定既非就地调用、也无按目标取用形态（规则 41 候选）`,
    });
  }
  return hits;
}

export function probePaths(paths) {
  const files = [];
  for (const p of paths) for (const f of walk(p)) files.push(f);
  const out = [];
  for (const f of files) {
    if (!/\.(go|mjs|js|ps1|py)$/.test(f)) continue;
    try { out.push(...probeFile(f, null)); } catch { /* 读不了就跳过 */ }
  }
  return { files: files.length, hits: out };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('judgement-anchoring-probe.mjs')) {
  const args = process.argv.slice(2).filter((a) => a !== '--json');
  if (args.length === 0) {
    console.error('用法: node scripts/judgement-anchoring-probe.mjs <目录或文件...> [--json]');
    process.exit(2);
  }
  const r = probePaths(args);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`扫描文件 ${r.files} 个；候选命中 ${r.hits.length} 条（**候选 ≠ 违规**，需人工裁定）`);
    for (const h of r.hits.slice(0, 40)) {
      console.log(`  [${h.code}] ${h.file}${h.line ? `:${h.line}` : ''}`);
      if (h.text) console.log(`      ${h.text}`);
      console.log(`      ↳ ${h.why}`);
    }
    if (r.hits.length > 40) console.log(`  … 其余 ${r.hits.length - 40} 条省略`);
  }
  process.exit(0);
}
