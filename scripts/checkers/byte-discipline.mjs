#!/usr/bin/env node
// byte-discipline.mjs —— 检查器：**行尾纪律**必须是"显式钉住"的，不能靠机器默认配置（纪律 CAT-TECH，L648/L653）
//
// 来历（两次真实事故，都是"行尾"）：①`.gitattributes` 只按**扩展名**钉 LF，而 git hook 脚本**没有扩展名**
//   ⇒ autocrlf=true 的机器一 checkout 就转成 CRLF ⇒ 与 sha256 清单不符、POSIX 上 shebang 直接坏掉
//   （L648）；②`test/fixtures/**` 是逐字基准，被转换后逐字比对全红而肉眼看不出来（LF-250）。
//   两次的共同形态：**判据依赖机器的默认配置，而不是仓库里的显式声明**。
//
// 判据（三条，任一命中 ⇒ exit 1）：
//   A. `MISREPORT`… 不，这里是行尾：
//      `BYTE_EOL_INCONSISTENT`：样本树里出现 **CRLF 混入**（同一文件既有 LF 又有 CRLF，或声明为纯 LF
//      的文件里出现 CRLF）—— 混行尾是最常见的"肉眼看不见"事故形态。
//   B. `BYTE_NOT_DECLARED`：被检根有 `.gitattributes`，但里面**没有**任何"把某个路径/扩展名显式钉住"的行
//      （`text` / `-text` / `eol=lf` 三者任一）⇒ 行尾完全交给机器默认配置（换台机器/换 autocrlf 设置就变）。
//   C. `BYTE_EXT_PIN_MISSING`：`.githooks/**` 存在，但 `.gitattributes` 没有显式钉它
//      （L648 的原形：无扩展名文件落进"按扩展名钉"的盲区）。
//
// 通用性：不假定任何具体项目结构——"必须钉什么"由**仓库自己声明**（`.gitattributes`），
//   而"有没有声明、混没混行尾"是可机械判定的。只读、零网络、零写入。
//
// 约定（见 src/checker.mjs 顶部）：被检根 = `RULEKEEPER_SAMPLE_DIR ?? cwd`；
//   命中 ⇒ exit 1；干净 ⇒ exit 0；**没有 .gitattributes 且没有 .githooks ⇒ exit 2**（没有被测对象）。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.RULEKEEPER_SAMPLE_DIR ?? process.cwd();
// `test-fixtures/` 是**夹具面**：那里放的是"故意违规的样本"（红态证据），不是被检对象。
// 与 `rk-selfcheck` 的 S8 对夹具的豁免同一口径；被检对象是仓库自己的文件。
const SKIP_DIRS = new Set(['.git', 'node_modules', '.dsh-ai', 'test-fixtures']);
const TEXT_EXT = /\.(?:mjs|cjs|js|ts|md|json|jsonl|ps1|psm1|txt|yml|yaml|sh|go|py)$/i;

const gaPath = join(root, '.gitattributes');
const hooksDir = join(root, '.githooks');
if (!existsSync(gaPath) && !existsSync(hooksDir)) {
  console.log('BYTE_DISCIPLINE_SUBJECT=absent（既无 .gitattributes 也无 .githooks ⇒ 本条不适用）');
  process.exit(2);
}

const hits = [];
const gaText = existsSync(gaPath) ? readFileSync(gaPath, 'utf8') : '';
const lines = gaText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));

/** 这一份 .gitattributes 有没有"显式钉住行尾形态"的行 */
const pins = lines.filter((l) => {
  const attrs = l.split(/\s+/).slice(1);
  return attrs.includes('text') || attrs.includes('-text') || attrs.some((a) => /^eol=(lf|crlf)$/.test(a));
});

// ── A. 混行尾（同一文件既有 CRLF 又有裸 LF）─────────────────────────────────────
const mixed = [];
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
    if (!TEXT_EXT.test(name)) continue;
    const buf = readFileSync(full);
    const crlf = buf.includes(Buffer.from('\r\n'));
    if (!crlf) continue;
    // 判"混行尾"必须**按字节**：数出 `\r\n` 的个数与 `\n` 的总数，不等就是混
    //（写第一版时用"把 \r\n 换成 \n 再看还有没有 \n" ⇒ 恒真、连纯 CRLF 都误报，用例当场抓到）。
    let crlfCount = 0;
    for (let i = 1; i < buf.length; i += 1) if (buf[i] === 0x0a && buf[i - 1] === 0x0d) crlfCount += 1;
    let lfCount = 0;
    for (let i = 0; i < buf.length; i += 1) if (buf[i] === 0x0a) lfCount += 1;
    if (lfCount <= crlfCount) continue;              // 全是 CRLF（或没有裸 LF）⇒ 统一形态，不算混
    const rel = full.slice(root.length).replace(/^[\\/]/, '').split('\\').join('/');
    mixed.push(rel);
  }
};
if (existsSync(root)) walk(root);
for (const rel of mixed.slice(0, 8)) {
  hits.push(`BYTE_EOL_INCONSISTENT: ${rel} 同一文件里既有 CRLF 又有裸 LF（混行尾：肉眼看不见，逐字比对会假红）`);
}

// ── B. 有 .gitattributes 却一行钉规则都没有 ─────────────────────────────────────
if (existsSync(gaPath) && pins.length === 0) {
  hits.push('BYTE_NOT_DECLARED: .gitattributes 存在但**没有任何**钉行尾形态的行（text / -text / eol=lf）⇒ 行尾完全交给机器默认配置');
}

// ── C. .githooks 存在但没显式钉（L648 的原形：无扩展名文件落进按扩展名钉的盲区）──
if (existsSync(hooksDir)) {
  const pinned = lines.some((l) => {
    const [pattern, ...attrs] = l.split(/\s+/);
    if (!/^\.githooks\/(?:\*|\*\*)$/.test(pattern)) return false;
    return attrs.some((a) => a === 'eol=lf') && !attrs.includes('-text');
  });
  if (!pinned) {
    hits.push('BYTE_EXT_PIN_MISSING: .githooks/ 存在，但 .gitattributes 没有显式钉 `.githooks/* text eol=lf`（hook 脚本无扩展名，按扩展名的规则管不到；autocrlf=true 一 checkout 就坏）');
  }
}

console.log(`BYTE_DISCIPLINE_ROOT=${root.split('\\').join('/')} GITATTRIBUTES=${existsSync(gaPath) ? 'present' : 'absent'} PINS=${pins.length} HOOKS=${existsSync(hooksDir) ? 'present' : 'absent'}`);
if (hits.length > 0) {
  console.log(`BYTE_DISCIPLINE_VIOLATIONS=${hits.length}`);
  for (const h of hits.slice(0, 12)) console.log(`  ${h}`);
  process.exit(1);
}
console.log('BYTE_DISCIPLINE_VIOLATIONS=0');
process.exit(0);
