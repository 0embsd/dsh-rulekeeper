#!/usr/bin/env node
// misreport-surface.mjs —— 检查器：**每条已绑定判据的误报面必须可控**（纪律 CAT-VERIFY，规则 53 的机械面）
//
// 来历（本轮四次返工的共同点，不是设计洁癖）：
//   ① `test-isolation` 第一版判据在真仓一次报出 **58 条**误报（绝大多数只是只读用例）；
//   ② `packageRootOfThisModule()` 少升一层 ⇒ 引用永远解析不到（静默）；
//   ③ `ledger-live-verdict` 去前导点 ⇒ 把**存在**的 `.dsh-ai/...` 判成"不存在"；
//   ④ 三条新教训记进未绑定类目 ⇒ 根通道持续注入提醒、复发判定被污染。
//   共同点：**先写红样本，后拿真仓试**。红样本当然绿，真仓当然炸。
//   ⇒ 本条把"误报面"变成**可机械复核的事实**：对 `rules.json` 里每一条 checker 绑定，
//     真仓（绿样本）上必须 exit=0；违规样本（红样本）上必须非 0；且**规格必须写明绿样本**。
//
// 判据（四条，任一命中 ⇒ exit 1）：
//   A. `MISREPORT_GREEN_FALSE_POSITIVE`：绿样本（真仓 / 规格声明的合规样本）上检查器 **exit≠0**
//      ⇒ 这条判据在正常仓库上就在误报（规则 53 的核心）。
//   B. `MISREPORT_RED_NOT_HIT`：红样本上检查器 **exit=0** ⇒ 判据不开火（判别力没了）。
//   C. `MISREPORT_NO_GREEN_SAMPLE`：规格没写 `greenSample` ⇒ "误报面"这件事**根本没被核过**
//      （不许默认成"过了"）。
//   D. `MISREPORT_SPEC_MISSING`：绑定声明的规格文件不存在 ⇒ 判据的来历丢了。
//
// **递归护栏**（必须写清，否则本检查器会调自己）：命令里出现本检查器文件名的绑定一律**跳过并计数**
//   （`SKIPPED_SELF`）。诚实边界：故它**不判自己**——自己的误报面由"金样本必红"（自带现造红样本）与
//   本仓 `rk-test` 覆盖。
//
// 约定（见 src/checker.mjs 顶部）：被检根 = `RULEKEEPER_SAMPLE_DIR ?? cwd`（本仓用法：`cwd` 是仓库根，
//   样本路径按 `cwd` 相对解析——规格里的 `redSample.source` 就是项目根相对路径）。
//   命中 ⇒ exit 1；干净 ⇒ exit 0；**没有被测对象（无 rules.json / 无 checker 绑定）⇒ exit 2**。
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const SELF = 'scripts/checkers/misreport-surface.mjs';
const root = process.env.RULEKEEPER_SAMPLE_DIR ?? process.cwd();
const rulesRel = ['.dsh-ai/rulekeeper/rules.json', '.dsh-ai/lessonflow/rules.json'].find((p) => existsSync(join(root, p)));
if (rulesRel === undefined) {
  console.log('MISREPORT_RULES=absent（没有 rules.json ⇒ 没有被测对象）');
  process.exit(2);
}
// 本检查器自身的定位护栏：**看 cwd**（不是看被检根）——因为规格/命令都是按 `cwd`（= 项目根）解析的，
// 若本文件不在 cwd 下，说明"相对路径解析"这套前提不成立 ⇒ 判据不可信，如实 2。
// （写红样本时实测踩过：按被检根找自己会把"被检对象 = 违规样本目录"这种用法误判成不可信。）
if (!existsSync(join(process.cwd(), SELF))) {
  console.log(`MISREPORT_SELF=absent（${SELF} 不在 cwd 下 ⇒ 相对路径解析前提不成立，判据不可信）`);
  process.exit(2);
}

let parsed;
try {
  parsed = JSON.parse(readFileSync(join(root, rulesRel), 'utf8'));
} catch (err) {
  console.log(`MISREPORT_RULES=bad-json（${String(err?.message ?? err).slice(0, 80)}）`);
  process.exit(2);
}
const bindings = (Array.isArray(parsed?.checks) ? parsed.checks : [])
  .filter((c) => c !== null && typeof c === 'object' && c.kind === 'checker');

/**
 * 解析"项目根相对路径"：先按被检根，再按 `cwd`。
 *
 * 为什么要两条：本检查器有两类被检对象——① 真仓（`root` 就是项目根，两者相同）；
 * ② 违规样本树（`root` = `test-fixtures/misreport-red`，而规格与检查器脚本在**真仓**里）。
 * 绑定层给检查器传的是"项目根相对路径"，样本树那条用法下必须回退到 `cwd` 才找得到。
 * （写红样本时实测踩过：只按被检根解析 ⇒ 红样本永远停在 SPEC_MISSING，A 判据根本没被走到。）
 */
function resolveRel(rel) {
  const a = join(root, rel);
  if (existsSync(a)) return a;
  const b = join(process.cwd(), rel);
  if (existsSync(b)) return b;
  return null;
}

const hits = [];
let checked = 0;
let skippedSelf = 0;
let skippedShape = 0;

for (const b of bindings) {
  const rule = String(b.rule ?? '?');
  const specRel = typeof b.spec === 'string' && b.spec !== '' ? b.spec : null;
  if (specRel === null) {
    skippedShape += 1;
    hits.push(`${rule}: 绑定没写 spec ⇒ 找不到它的规格（来历丢了）`);
    continue;
  }
  const specAbs = resolveRel(specRel);
  if (specAbs === null) {
    hits.push(`${rule}: MISREPORT_SPEC_MISSING 规格文件不存在（${specRel}）`);
    continue;
  }
  let spec;
  try {
    spec = JSON.parse(readFileSync(specAbs, 'utf8'));
  } catch (err) {
    hits.push(`${rule}: MISREPORT_SPEC_BAD_JSON（${specRel}: ${String(err?.message ?? err).slice(0, 60)}）`);
    continue;
  }
  const command = Array.isArray(spec.command) ? spec.command : null;
  if (command === null || command.length === 0 || command.some((a) => typeof a !== 'string' || a === '')) {
    hits.push(`${rule}: MISREPORT_SPEC_NO_COMMAND（${specRel} 缺 command 数组）`);
    continue;
  }
  // 递归护栏：命令里出现本检查器 ⇒ 跳过（否则本检查器会调自己）
  if (command.some((a) => a.includes('misreport-surface'))) {
    skippedSelf += 1;
    continue;
  }
  const redSource = spec.redSample !== null && typeof spec.redSample === 'object' ? spec.redSample.source : null;
  const greenSource = spec.greenSample !== null && typeof spec.greenSample === 'object' ? spec.greenSample.source : null;
  if (typeof greenSource !== 'string' || greenSource === '') {
    hits.push(`${rule}: MISREPORT_NO_GREEN_SAMPLE 规格没写 greenSample ⇒ "误报面"这件事根本没被核过（${specRel}）`);
    continue;
  }
  if (typeof redSource !== 'string' || redSource === '') {
    hits.push(`${rule}: MISREPORT_NO_RED_SAMPLE 规格没写 redSample（${specRel}）`);
    continue;
  }

  const run = (sampleDir) => {
    const sampleAbs = resolveRel(sampleDir) ?? join(root, sampleDir);
    return spawnSync(command[0], command.slice(1), {
      cwd: root,
      shell: false,
      encoding: 'utf8',
      timeout: Number.isInteger(spec.timeoutMs) ? spec.timeoutMs : 20000,
      env: { ...process.env, RULEKEEPER_SAMPLE_DIR: sampleAbs },
      maxBuffer: 1024 * 1024,
    });
  };

  const green = run(greenSource);
  const greenExit = typeof green.status === 'number' ? green.status : null;
  const greenExpected = Number.isInteger(spec.expectGreen?.exitCode) ? spec.expectGreen.exitCode : 0;
  if (greenExit === null) {
    hits.push(`${rule}: MISREPORT_GREEN_UNRUNNABLE 绿样本上检查器跑不出结论（${green.error?.message ?? 'spawn-error'}）`);
  } else if (greenExit !== greenExpected) {
    const firstLine = String(green.stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== '')[0] ?? '';
    hits.push(`${rule}: MISREPORT_GREEN_FALSE_POSITIVE 绿样本「${greenSource}」上检查和 exit=${greenExit}（期望 ${greenExpected}）⇒ 这条判据在正常仓库上就在误报${firstLine === '' ? '' : `｜首行: ${firstLine.slice(0, 90)}`}`);
  }

  const red = run(redSource);
  const redExit = typeof red.status === 'number' ? red.status : null;
  const redExpected = Number.isInteger(spec.expectRed?.exitCode) ? spec.expectRed.exitCode : 1;
  if (redExit === null) {
    hits.push(`${rule}: MISREPORT_RED_UNRUNNABLE 红样本上检查器跑不出结论（${red.error?.message ?? 'spawn-error'}）`);
  } else if (redExit !== redExpected) {
    hits.push(`${rule}: MISREPORT_RED_NOT_HIT 红样本「${redSource}」上检查和 exit=${redExit}（期望 ${redExpected}）⇒ 判据不开火`);
  }

  checked += 1;
  console.log(`MISREPORT_CHECK rule=${rule} spec=${specRel} green=${greenExit ?? 'err'} red=${redExit ?? 'err'} verdict=${greenExit === greenExpected && redExit === redExpected ? 'ok' : 'bad'}`);
}

console.log(`MISREPORT_ROOT=${root.split('\\').join('/')} BINDINGS=${bindings.length} CHECKED=${checked} SKIPPED_SELF=${skippedSelf} SKIPPED_SHAPE=${skippedShape}`);
if (hits.length > 0) {
  console.log(`MISREPORT_VIOLATIONS=${hits.length}`);
  for (const h of hits.slice(0, 12)) console.log(`  ${h}`);
  process.exit(1);
}
console.log('MISREPORT_VIOLATIONS=0');
process.exit(0);
