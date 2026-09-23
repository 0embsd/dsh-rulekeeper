// 判据：**跑检查器的用例必须走退出码语义守卫**（`runCheckerVerdict`），不得自己读 exit code。
//
// 来历（2026-09-23，本会话差点交付假绿）：我给交付判据换绿样本夹具时，第一版夹具是"没有可核绑定"的落点
// ⇒ `misreport-surface` 走"不适用"路径 **exit 2**；而用例只看"有没有违规" ⇒ **看起来通过了**。
// 直到 `rk-effect verify` 的"误报面绿（期望 0）"拿到 2 才判红。**"我没判"被当成了"判绿"。**
//
// 判据（红 = 任一）：
//   ① `test/**/*.test.mjs` 里出现"直接 spawn 一个 `scripts/checkers/*.mjs`"的形态，且该文件**没有**用
//      `runCheckerVerdict` ⇒ 说明它自己读 exit code，绕过了"不适用 ≠ 通过"的守卫；
//   ② 守卫助手自身必须对 `exit 2` **fail**（注入式自检：拿一个真会 exit 2 的被检根喂它，必须抛）。
//
// 反向红：把 `runCheckerVerdict` 里的 `exit 2` 分支删掉 ⇒ ② 红；
//         在某个用例里用裸 spawn 跑检查器 ⇒ ① 红。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { CHECKER_EXIT_NOT_APPLICABLE, PKG_ROOT, runCheckerVerdict, tempDir } from './helpers/sandbox.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const TEST_DIR = join(PKG_ROOT, 'test');
const CHECKER_SCRIPT_RE = /scripts\/checkers\/[A-Za-z0-9._-]+\.mjs/;

/**
 * 收集"自己 spawn 检查器"的用例文件（不借助守卫的）。
 *
 * **这个启发式被实测教训过四次**，全写下来（它自己就是"判据要先量"的活标本）：
 *   ① `spawnSync(process.execPath` + 文件里出现 `scripts/checkers/` ⇒ **误报**
 *      （`checker.test.mjs` 只在字符串里提到检查器，实际 spawn 的是 `bin/rk-effect.mjs`）；
 *   ② 要求 `spawnSync(process.execPath, [<VAR>` **紧跟** ⇒ **报 0 个（假绿）**：真实写法把路径拆成
 *      多个实参 `join(PKG_ROOT, 'scripts', 'checkers', 'x.mjs')` ⇒ 文件里**没有**连续串 `scripts/checkers`；
 *   ③ 改看"spawn 点附近 400 字符内的实参" ⇒ 仍 **报 0 个**：spawn 的实参只是**变量名** `[CHECKER]`，
 *      路径在别处 → 就近窗口里看不到 `checkers`；
 *   ④ 现口径（**跟随变量名**）：先找"同一行里声明、且其后 200 字符内含 `checkers` 与 `.mjs` 的常量"
 *      （即"这个变量就是检查器路径"），再看它是否出现在 `spawnSync(process.execPath, [<它>` 里。
 */
function offenders() {
  const out = [];
  for (const name of readdirSync(TEST_DIR)) {
    if (!name.endsWith('.test.mjs')) continue;
    const text = readFileSync(join(TEST_DIR, name), 'utf8');
    const checkerVars = [];
    const declRe = /const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g;
    for (let m = declRe.exec(text); m !== null; m = declRe.exec(text)) {
      // 声明行之后 200 字符里同时出现 checkers 与 .mjs ⇒ 该常量指向检查器脚本
      const tail = text.slice(m.index, m.index + 200);
      if (tail.includes('checkers') && tail.includes('.mjs')) checkerVars.push(m[1]);
    }
    if (checkerVars.length === 0) continue;
    const spawnsOne = checkerVars.some((v) => new RegExp(`spawnSync\\(process\\.execPath,\\s*\\[\\s*${v}\\b`).test(text));
    if (!spawnsOne) continue;
    if (text.includes('runCheckerVerdict')) continue;
    out.push(name);
  }
  return out;
}

test('自进化①: 跑检查器的用例必须走 `runCheckerVerdict`（不适用 ≠ 通过）', () => {
  const bad = offenders();
  console.log(`CHECKER_GUARD_OFFENDERS=${bad.length}${bad.length === 0 ? '' : ` -> ${bad.join(', ')}`}`);
  assert.deepEqual(bad, [],
    `这些用例自己读检查器 exit code ⇒ 可能把"不适用(exit 2)"读成绿：${bad.join(', ')}\n`
    + '  修法：改用 test/helpers/sandbox.mjs 的 runCheckerVerdict(script, { sampleDir, label })，'
    + '它默认要求"有结论"，`exit 2` 直接判失败；确实要断言"不适用"时显式传 { expect: "not-applicable" }。');
});

test('自进化②: 守卫助手对 `exit 2` **必须失败**（注入式自检，防它自己被改成恒绿）', () => {
  // 造一个"检查器会 exit 2"的最简被检根：misreport-surface 在"无 checker 绑定"的落点上就是 exit 2
  const dir = tempDir('exit-guard-probe');
  mkdirSync(join(dir, '.dsh-ai', 'rulekeeper'), { recursive: true });
  writeFileSync(join(dir, '.dsh-ai', 'rulekeeper', 'rules.json'),
    `${JSON.stringify({ schema: 1, project: 'probe', protected_paths: [], gates: [], inject: [], checks: [] }, null, 2)}\n`, 'utf8');
  const script = 'scripts/checkers/misreport-surface.mjs';

  // ① 显式声明"不适用"⇒ 允许，且必须正好是 2
  const na = runCheckerVerdict(script, { sampleDir: dir, expect: 'not-applicable', label: 'probe' });
  assert.equal(na.status, CHECKER_EXIT_NOT_APPLICABLE);

  // ② 默认判据面 ⇒ 必须失败（这就是那条缝的机械面）
  assert.throws(() => runCheckerVerdict(script, { sampleDir: dir, label: 'probe' }),
    (err) => /不适用/.test(String(err?.message)) && /不等于|判绿/.test(String(err?.message)),
    '守卫必须把"不适用"判成失败，否则这条纪律没有机械面');
});
