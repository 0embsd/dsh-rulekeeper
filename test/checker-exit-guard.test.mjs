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
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CHECKER_EXIT_NOT_APPLICABLE, PKG_ROOT, runCheckerVerdict, tempDir } from './helpers/sandbox.mjs';
import { mkdirSync } from 'node:fs';

const TEST_DIR = join(PKG_ROOT, 'test');
const CHECKER_SCRIPT_RE = /scripts\/checkers\/[A-Za-z0-9._-]+\.mjs/;

/**
 * 用例会 spawn 的**非检查器**入口（白名单）。
 *
 * 为什么需要白名单（2026-09-26，本启发式第五次被实测教训）：口径④的"声明行后 200 字符"窗口
 * **会跨过常量声明本身**，把一个"下一段函数里恰好提到 `scripts/checkers/`"的**无关常量**当成
 * 检查器路径。实证：新写的 `test/adopt-alarm-surface.test.mjs` 里
 * `const EFFECT = join(PKG_ROOT, 'bin', 'rk-effect.mjs')` 被误判 —— 它的 200 字符窗口里落进了
 * 后面 `alarmSpec()` 的 `.../checkers/...`，于是 `spawnSync(process.execPath, [EFFECT, ...])`
 * 被读成"自己 spawn 检查器"。**那是假阳**（它 spawn 的是 CLI，不是检查器本体）。
 *
 * 判据落在**事实**上：这些是仓里的 CLI 入口名，`offenders()` 只找"指向检查器脚本"的常量；
 * 把已知的 CLI 入口排除掉，比继续放宽/收紧那个字符窗口更有依据（窗口口径四次都栽在窗口上）。
 */
const NON_CHECKER_ENTRYPOINTS = Object.freeze(['bin/rk-effect.mjs', 'bin/rk-test.mjs', 'bin/dsh-rulekeeper.mjs', 'bin/rk-gate.mjs']);

/**
 * 收集"自己 spawn 检查器"的用例文件（不借助守卫的）。
 *
 * **这个启发式被实测教训过五次**，全写下来（它自己就是"判据要先量"的活标本）：
 *   ① `spawnSync(process.execPath` + 文件里出现 `scripts/checkers/` ⇒ **误报**
 *      （`checker.test.mjs` 只在字符串里提到检查器，实际 spawn 的是 `bin/rk-effect.mjs`）；
 *   ② 要求 `spawnSync(process.execPath, [<VAR>` **紧跟** ⇒ **报 0 个（假绿）**：真实写法把路径拆成
 *      多个实参 `join(PKG_ROOT, 'scripts', 'checkers', 'x.mjs')` ⇒ 文件里**没有**连续串 `scripts/checkers`；
 *   ③ 改看"spawn 点附近 400 字符内的实参" ⇒ 仍 **报 0 个**：spawn 的实参只是**变量名** `[CHECKER]`，
 *      路径在别处 → 就近窗口里看不到 `checkers`；
 *   ④ 现口径（**跟随变量名**）：先找"同一行里声明、且其后 200 字符内含 `checkers` 与 `.mjs` 的常量"
 *      （即"这个变量就是检查器路径"），再看它是否出现在 `spawnSync(process.execPath, [<它>` 里；
 *   ⑤ **2026-09-26 收窄**：口径④的窗口会跨过声明本身 ⇒ 误把"后面函数里提到 checkers"的**CLI 常量**
 *      当成检查器（实证见 `NON_CHECKER_ENTRYPOINTS` 的注释）⇒ 增加**已知 CLI 入口白名单**；
 *      白名单只排除"入口名恰好叫这几个"的常量，不放宽"什么算 spawn 检查器"。
 */
function offenders() {
  const out = [];
  for (const name of readdirSync(TEST_DIR)) {
    if (!name.endsWith('.test.mjs')) continue;
    const text = readFileSync(join(TEST_DIR, name), 'utf8');
    const checkerVars = [];
    const declRe = /const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g;
    for (let m = declRe.exec(text); m !== null; m = declRe.exec(text)) {
      // 声明行之后 200 字符里同时出现 checkers 与 .mjs ⇒ 该常量指向检查器脚本。
      // ⑤a **窗口止于本声明自己的分号**（2026-09-26）：定长 200 字符会跨过声明本身、把**下一条**
      //    常量/函数的路径算成这个常量的目标（实证：CLI 探针里 `const EFFECT=…rk-effect.mjs;` 的窗口
      //    吞掉了后面 `specPath()` 里的 `'scripts','checkers','x.mjs'` ⇒ 假阳）。
      const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 200);
      const semi = rest.indexOf(';');
      const tail = `const ${m[1]} = ${semi === -1 ? rest : rest.slice(0, semi)}`;
      if (!tail.includes('checkers') || !tail.includes('.mjs')) continue;
      // ⑤b 白名单：这段窗口里出现的 `.mjs` 若**全是**已知 CLI 入口，就不是检查器常量。
      // ⚠ 只认**路径形态**的名字（含目录分隔），不认 `sandbox.mjs` 这种无路径的文件名 ——
      //   否则同文件里的 `import ... from './helpers/sandbox.mjs'` 会被当成本常量的目标。
      const mjsNames = [...tail.matchAll(/([A-Za-z0-9._@-]*[\\/][A-Za-z0-9._@/-]+\.mjs)/g)].map((x) => x[1]);
      const onlyEntrypoints = mjsNames.length > 0
        && mjsNames.every((p) => NON_CHECKER_ENTRYPOINTS.some((e) => p.endsWith(e)));
      if (onlyEntrypoints) continue;
      checkerVars.push(m[1]);
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

test('自进化③（注入式：判据不得退化成恒绿，也不得对 CLI 入口假阳）', () => {
  // 为什么用**注入探针文件**而不是就地断言正则：白名单是否正确，最终只体现在 `offenders()`
  // 的输出上。就地拼字符串断言只能测到正则片段（第一版就是这么写成"假红"的：
  // `join(PKG_ROOT,'bin','rk-effect.mjs')` 里 `.mjs` 前面是 `'`，正则取不到完整名）。
  const probeBad = join(TEST_DIR, 'zz-probe-checker-spawn.test.mjs');
  const probeCli = join(TEST_DIR, 'zz-probe-cli-spawn.test.mjs');
  try {
    // ① 真违规：自己 spawn 一个 `scripts/checkers/*.mjs` ⇒ **必须**被抓到
    writeFileSync(probeBad, [
      "import { spawnSync } from 'node:child_process';",
      "import { join } from 'node:path';",
      "import { PKG_ROOT } from './helpers/sandbox.mjs';",
      "const CHECKER = join(PKG_ROOT, 'scripts', 'checkers', 'byte-discipline.mjs');",
      "spawnSync(process.execPath, [CHECKER, '--x'], { encoding: 'utf8' });",
    ].join('\n'), 'utf8');
    assert.equal(offenders().includes('zz-probe-checker-spawn.test.mjs'), true,
      '注入一个"自己 spawn 检查器"的探针 ⇒ `offenders()` 必须抓到它（否则这条红线已退化成恒绿）');

    // ② 假阳回归：只 spawn CLI 入口，但文件里（别的函数中）提到 `scripts/checkers/` ⇒ **不得**被抓
    writeFileSync(probeCli, [
      "import { spawnSync } from 'node:child_process';",
      "import { join } from 'node:path';",
      "import { PKG_ROOT } from './helpers/sandbox.mjs';",
      "const EFFECT = join(PKG_ROOT, 'bin', 'rk-effect.mjs');",
      "function specPath() { return join('scripts', 'checkers', 'x.mjs'); }",
      "spawnSync(process.execPath, [EFFECT, specPath()], { encoding: 'utf8' });",
    ].join('\n'), 'utf8');
    assert.equal(offenders().includes('zz-probe-cli-spawn.test.mjs'), false,
      '只 spawn CLI 入口的用例不得因"窗口里提到 checkers"被误判（2026-09-26 实测的假阳）');
  } finally {
    rmSync(probeBad, { force: true });
    rmSync(probeCli, { force: true });
  }
});
