#!/usr/bin/env node
// rk-test 薄壳（2026-09-19 补）
//
// 为什么需要它：规则 40（门禁绕行禁令）要求"构建/测试走编排器入口"，但本项目此前**只有**
// package.json 里的 `test: "node --test"`（裸命令）⇒ 每次跑用例都落在"绕行"形态里，
// 属于"能力有、入口没有"的同类缺口（与 L628 那条"没检查=绿"同一族：流程缺口不该靠自觉）。
// 本壳就是那个入口，转调 `node --test`，把 rc 原样透传。
//
// 用法:
//   rk-test                     # 跑 test/ 全部用例
//   rk-test test/effect.test.mjs   # 只跑指定文件（透传给 node --test）
// 退出码: 见 src/rc.mjs 的 rc 契约家族；本壳**透传** node --test 的 rc（0 全绿 / 1 有败例）。
//
// **2026-09-19（教训 L636，同一形态复发）**：带参数的"部分运行"**不构成交付凭证** ——
//   当天实测：改完包内源码只跑焦点用例（6 个文件各自绿），一跑全量就 15 条红（新增文件的注释里
//   写了真实项目名/本机路径 ⇒ 包级脱敏不变量 S8_INTERNAL_LEAK 判红，凭据扫描用例整片红）。
//   根因不是"没检查"，而是**分文件跑绿被当成交付判据**。故：只要带了参数，就在**首尾**各打一次
//   醒目提示（写进输出流，不靠自觉记着）——交付判据是「全量 `rk-test` + `rk-selfcheck`」。
import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// **用法**（2026-09-23 补：要让 CI 与本地跑**同一条命令**）：
//   · 参数里以 `-` 开头的一律当作 **node 自己的选项**（如 `--test-reporter=tap`），透传给 node；
//   · 其余参数当作**测试路径**（显式列文件）；不带路径时按下面的 glob 只跑用例面。
// 为什么需要前者：CI 的 test 任务要 TAP（注解要机器可解析），而它此前跑的是裸 `node --test`
// ⇒ 与本机 `rk-test` **不是同一条命令** ⇒ 夹具面差异导致远端恒红（实测 2026-09-23）。
const args = process.argv.slice(2);
const nodeOpts = args.filter((a) => a.startsWith('-'));
const pathArgs = args.filter((a) => !a.startsWith('-'));

if (args.includes('--help') || args.includes('-h')) {
  console.log('用法: rk-test [node 选项…] [<test-file-or-dir> …]');
  console.log('说明: 转调 `node --test`（cwd=包根）；不带路径参数时只跑 `test/**/*.test.mjs`（用例面）；rc 原样透传。');
  console.log('      `-` 开头的参数视为 node 选项（例：--test-reporter=tap）。');
  console.log('注意: 带路径参数 = 部分运行，**不构成交付凭证**；交付请跑全量 rk-test + rk-selfcheck。');
  process.exit(0);
}

// **为什么改成"显式列文件"而不是裸 `node --test`**（2026-09-21 实测）：
//   node 默认会**发现**任意深度下匹配测试命名约定的文件，于是 `test-fixtures/red/**` 里那份
//   **故意违规的样本**也被当成用例执行 ⇒ 全量跑多一条"失败"（而那条"失败"恰恰是夹具的本意）。
//   样本是判据的**输入**，不是用例。故无参数时只跑 `test/**/*.test.mjs`（用例面），
//   其余深度（含 `.dsh-ai/tmp/` 与 `test-fixtures/`）不进用例面。
const discovered = pathArgs.length > 0
  ? []
  : globSync('test/**/*.test.mjs', { cwd: ROOT }).sort();
const runArgs = pathArgs.length > 0 ? pathArgs : discovered;

// ── **发现 0 条 ⇒ 明确失败，不回落**（2026-09-26，从 GitHub 装包实测发现）────────────────────
// 现场：`dsh plugin add github:0embsd/dsh-rulekeeper#<sha>` 装出来的包里**没有用例文件**
//   （`package.json` 的 `files` 只放 `test/fixtures/checker/`，98 个 `*.test.mjs` 不在发布面上）。
//   于是 `globSync` 得 0 条 ⇒ 旧行为把 `[]` 传下去 ⇒ `node --test --` 按**自己的默认发现**跑，
//   抓到 3 个**碰巧长得像测试**的文件（`scripts/checkers/test-isolation.mjs`、
//   `test-fixtures/red/test/violating.sample.mjs` —— 后者是**故意违规的夹具**），报 1 pass / 2 fail。
//   ⇒ 那是**误报**：既不是"装坏了"，也不是"用例挂了"，而是"这个包里根本没有用例面"。
// 诚实口径（与本仓"没判 ≠ 判绿"同族）：**没有可跑的用例就该判失败并说清为什么**，
//   绝不回落去跑别的文件 —— 否则每个装包的人都会看到两条假红，而"零用例"这个真事实被藏起来。
if (pathArgs.length === 0 && discovered.length === 0) {
  console.error(`rk-test: 在 <包根>/test/ 下没发现任何 \`*.test.mjs\`（包根=${ROOT}）`);
  console.error('  常见原因：这是**从发布包/从 GitHub 装出来**的副本 —— 用例文件不在 `package.json` 的 `files` 里');
  console.error('            （发布面只含 `test/fixtures/checker/` 等判据运行时要用的夹具）。');
  console.error('  处置：要跑自测请用**完整检出**（`git clone https://github.com/0embsd/dsh-rulekeeper.git`）后在包根跑本命令；');
  console.error('        只是想核对装出来的包是否健康，请跑 `rk-selfcheck --root <包根>`（S8 脱敏 / S9 可达性 / 文档漂移）。');
  console.error('  本命令**不回落**到 node 的默认测试发现 —— 那会把夹具与检查器脚本当成用例，产出与本包无关的假红。');
  process.exit(1);
}

const partial = pathArgs.length > 0;
if (partial) {
  console.error(`⚠ rk-test: **部分**运行（只跑 ${pathArgs.length} 个指定路径）——这**不是**交付凭证。`);
  console.error('   交付判据 = 全量 `rk-test`（不带路径参数）+ `rk-selfcheck --root <包根>`（S8 脱敏 / S9 可达性 / 文档漂移等**包级**不变量）。');
}

// ⚠ **参数顺序的坑（2026-09-23 实测）**：`node --test <files…> --test-reporter=tap` 形态**不可用** ——
//   `--test-reporter` 是**变参**（`--test-reporter=a --test-reporter=b` 也是合法的），于是它会把
//   后面跟的**所有文件路径**当成分隔符之后的第二个 reporter 值吃掉 ⇒ 实测只跑了 269 条（应有 795），
//   凭空多出 59 条"失败"。所以**必须**写成：`node --test [node 选项…] -- <文件…>`（用 `--` 分隔）。
const res = spawnSync(process.execPath, ['--test', ...nodeOpts, '--', ...runArgs], { cwd: ROOT, stdio: 'inherit' });
if (res.error) {
  console.error(`rk-test: 无法启动 node --test: ${String(res.error.message || res.error)}`);
  process.exit(1);
}
if (partial) {
  console.error('⚠ 上面的绿只代表**被选中的**用例通过 —— 它**不构成交付凭证**：包级不变量（S8 脱敏 / S9 可达性 / 文档漂移）未在本次校验（见教训 L636）。');
}
process.exit(res.status ?? 1);
