#!/usr/bin/env node
// rk-plan.mjs —— **计划工件声明**（薄壳，不是新机制）
//
// 为什么需要它：`plan-artifact` 检查器按"台账里的**计划行**"对账，而行形状有两条硬要求
// （`category=计划` + `problem` 以 `PLAN_DECLARED` 开头）。底层 `dsh-rulekeeper record` **已经能写**
// 任意类目的行 —— 本壳只是**把形状钉死**，避免"参数收了不生效"那类静默空转
// （本会话实测过一次：某教训工具的 `supersede` 只接受 `-Id`，多传的字段被静默丢弃）。
//
// 用法：
//   node bin/rk-plan.mjs declare --landing <落点目录> --why <为什么这么做> [--criteria <判据>] \
//        [--rollback <回滚>] [--red <反向红/验证>] [--scope <glob>]... [--json]
//
// ⚠ **`--landing` 要传"落点目录"本身**（如 `<项目>/.dsh-ai/rulekeeper`），**不是项目根** ——
//   底层 `record` 的 `resolveLanding` 会把 `<项目根>/.dsh-ai` 归一到 `.dsh-ai/` 下，写出来的台账就不在落点里
//   （本壳实测踩过一次：传项目根 ⇒ 行落在 `<项目>/.dsh-ai/ledger.jsonl`，检查器找不到）。
//
// 退出码：0 写入成功；1 失败（字段不合法/写入被拒）；2 用法错误。
// **诚实边界（必须留在输出里）**：这几段文本是**声明**不是签名（规则 43）——
// 能写台账的人也能把话说得漂亮；检查器只能核"有没有这行、时点对不对"，核不了"你是不是真先想了"。
import { runRulekeeper } from '../src/cli.mjs';

const argv = process.argv.slice(2);
const KNOWN = ['declare', '--help', '-h'];
if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
  console.log('用法: rk-plan declare --landing <落点目录，如 <项目>/.dsh-ai/rulekeeper> --why <为什么> [--criteria <判据>] [--rollback <回滚>] [--red <反向红>] [--scope <glob>]... [--json]');
  console.log('说明: 写一条**计划行**（category=计划 / problem 以 PLAN_DECLARED 开头），供 `scripts/checkers/plan-artifact.mjs` 对账。');
  console.log('边界: --why/--criteria/--rollback/--red 是**声明**不是签名；检查器核不了"是否真先想过"。');
  process.exit(argv.length === 0 ? 2 : 0);
}
if (!KNOWN.includes(argv[0])) {
  console.error(`rk-plan: 未知动作 ${JSON.stringify(argv[0])}（只支持 declare）`);
  process.exit(2);
}
// 只把"声明"翻译成底层 record 的两个必填字段；其余原样透传（不复制实现、不藏暗逻辑）
const rest = argv.slice(1);
const problem = (() => {
  const parts = [];
  const take = (flag) => { const i = rest.indexOf(flag); return i >= 0 && i + 1 < rest.length ? rest[i + 1] : null; };
  const why = take('--why');
  if (why === null || why.trim() === '') {
    console.error('rk-plan declare: 需要 --why <为什么这么做>（计划行的核心是"为什么"，不是"做了什么"）');
    process.exit(2);
  }
  parts.push('PLAN_DECLARED');
  const scope = rest.reduce((acc, a, i) => (a === '--scope' && i + 1 < rest.length ? [...acc, rest[i + 1]] : acc), []);
  if (scope.length > 0) parts.push(`scope=${scope.join(',')}`);
  parts.push(`why=${why}`);
  for (const [flag, key] of [['--criteria', 'criteria'], ['--red', 'red']]) {
    const v = take(flag);
    if (v !== null && v.trim() !== '') parts.push(`${key}=${v}`);
  }
  return parts.join(' ');
})();
// 底层 `record` 的必填三件（`--rule/--root-cause/--solution`）在这里给**计划语义的默认值**：
// 计划行不是"教训"，故 rule 用占位类目 `PLAN`；root_cause/solution 说清"这行是什么"。
// 为什么给默认值而不是让调用方每次都写：这三个字段对"声明计划"没有信息量，逼人填只会让人绕过壳去手写台账
// —— 那就等于没有合法入口（本会话刚在别处踩过"没有合法通路只剩违规通路"）。
const rc = runRulekeeper([
  'record',
  ...rest.filter((a, i) => !['--why', '--criteria', '--rollback', '--red', '--scope'].includes(a)
    && !(i > 0 && ['--why', '--criteria', '--rollback', '--red', '--scope'].includes(rest[i - 1]))),
  '--rule', 'PLAN',
  '--category', '计划',
  '--problem', problem,
  '--root-cause', '动手前的计划工件（不是教训条目）：本条由 `rk-plan declare` 写入，供 `plan-artifact` 检查器按"行 ↔ 改动"对账',
  '--solution', rest.reduce((acc, a, i) => (a === '--rollback' && i + 1 < rest.length ? rest[i + 1] : acc), '见 problem 行内的 why/criteria/red 段'),
], { out: (t) => process.stdout.write(String(t)), err: (t) => process.stderr.write(String(t)) }, {});
if (rc === 0) {
  console.log('RK_PLAN_DECLARED=1（**声明**，非签名：检查器只核"有没有这行/时点对不对"，核不了"是否真先想过"）');
}
process.exit(rc);
