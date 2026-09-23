#!/usr/bin/env node
// plan-artifact.mjs —— 检查器：**"声明做过事前设计"必须与"真有那个计划工件"对得上**
//
// 来历（2026-09-23，本轮做插件能力面扩张时先量后写的结果）：
//   「动手前先有计划」这条纪律，最直觉的两种机械形态**都被真仓数据否掉**：
//     ① 改代码的提交，其前 24h 内必须有 `.dsh-ai/plan|design` 工件 ⇒ 本仓近 60 提交里 **53/53 命中 = 100%**
//        （该仓历史上 plan/design 改动 0 条）⇒ 上线第一天判红所有代码提交，人人绕行；
//     ② 改代码的提交正文必须含要点（判据 + 为什么）⇒ **18/34 = 53%**，超 30% 止损线，且它测的是**关键词**。
//   能机械化的那片是：**把计划工件落成插件能查的对象（台账行）**，然后按"行 ↔ 改动"对账 ——
//   与插件已有的「受保护文件改了但没留证 ⇒ 拒提交」**同一机制**，只换对象。
//
// 判据（对每个**代码类**改动）：
//   存在一条计划行，满足 `计划行时间 ≤ 改动时间` 且 `head - 计划行时间 ≤ 窗口`（默认 24h）。
//
// **档位（V1 = observe）**：检查器**默认始终 exit 0**，命中作为**审计读数**打印；
//   `RULEKEEPER_PLAN_MODE=armed` 才以非 0 退出。**升级到阻断需另一次决策 + 真仓命中率数据。**
//
// **诚实边界（必须留在输出里，规则 43）**：
//   ① 它判的是"计划工件存不存在、时点对不对"，**判不了"你是不是真先想了"**；
//   ② `why/criteria/rollback` 是**声明**不是签名 —— 能改台账的人也能把话说得漂亮；
//   ③ 触发时机**天然滞后**：钩子只在提交时跑 ⇒ 抓的是"这次改动有没有计划"，抓不到"你已经开始乱改了"；
//      要真在动手前拦，只能靠宿主在写操作前拦截（不是本检查器的能力）；
//   ④ observe 档**不阻断任何东西** —— 把它当"已经拦住"就是自称型控制。
//
// 约定：被检根 = `RULEKEEPER_SAMPLE_DIR ?? cwd`；命中在 armed 档 ⇒ exit 1，observe 档 ⇒ exit 0；
//   **不适用 ⇒ exit 2**（没声明 planScope / 没有代码类改动 / 台账里一条计划行都没有）。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.env.RULEKEEPER_SAMPLE_DIR ?? process.cwd();
const landings = ['.dsh-ai/rulekeeper', '.dsh-ai/lessonflow'].map((d) => join(root, d));
const landing = landings.find((d) => existsSync(join(d, 'ledger.jsonl'))) ?? landings[0];
const mode = process.env.RULEKEEPER_PLAN_MODE === 'armed' ? 'armed' : 'observe';

/** `config.json` 里由**被治理仓**声明的"哪些算代码类 + 窗口多长"（不硬编扩展名） */
const configPath = join(landing, 'config.json');
const planScope = (() => {
  if (!existsSync(configPath)) return null;
  let cfg;
  try { cfg = JSON.parse(readFileSync(configPath, 'utf8')); } catch { return null; }
  const ps = cfg?.planScope;
  if (ps === null || typeof ps !== 'object' || !Array.isArray(ps.codeGlobs) || ps.codeGlobs.length === 0) return null;
  const windowHours = Number.isFinite(ps.windowHours) && ps.windowHours >= 0 ? ps.windowHours : 24;
  return { codeGlobs: ps.codeGlobs.map(String), windowHours, declaredBy: 'config.json' };
})();

if (planScope === null) {
  console.log('PLAN_CHECK=not-applicable（落点 config.json 没声明 planScope.codeGlobs ⇒ 本条不适用，不判绿）');
  process.exit(2);
}

/** 台账里的**计划行**（类目=计划 且 problem 以 PLAN_DECLARED 开头；与事件行同族的精确口径） */
const parseTs = (v) => {
  const t = Date.parse(String(v ?? ''));
  return Number.isNaN(t) ? null : t;
};
const planRows = (() => {
  const file = join(landing, 'ledger.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter((r) => r !== null
    && r.category === '计划'
    && typeof r.problem === 'string' && r.problem.startsWith('PLAN_DECLARED'))
    .map((r) => ({ ts: parseTs(r.ts), id: r.id ?? '(无 id)', problem: r.problem, solution: r.solution ?? '' }))
    .filter((r) => r.ts !== null);
})();

if (planRows.length === 0) {
  console.log(`PLAN_CHECK=not-applicable（台账里 0 条计划行 ⇒ 无从对账；先 \`rk-plan declare\` 落一条，别把"没判"当"通过"）`);
  process.exit(2);
}

/** 改动面：`RULEKEEPER_PLAN_BASE..RULEKEEPER_PLAN_HEAD`（缺省 = 暂存区；都不是 git 仓 ⇒ 不适用） */
const gitLines = (args) => {
  const r = spawnSync('git', ['-c', 'core.quotePath=false', '-C', root, ...args], { encoding: 'utf8' });
  return r.status === 0 && typeof r.stdout === 'string' ? r.stdout.split(/\r?\n/).filter((l) => l.trim() !== '') : null;
};
const base = process.env.RULEKEEPER_PLAN_BASE ?? null;
const head = process.env.RULEKEEPER_PLAN_HEAD ?? 'HEAD';
const changed = base === null ? gitLines(['diff', '--name-only', '--cached']) : gitLines(['diff', '--name-only', `${base}..${head}`]);
if (changed === null) {
  console.log('PLAN_CHECK=not-applicable（不是 git 仓 / git 不可执行 ⇒ 拿不到改动面）');
  process.exit(2);
}
const headTs = (() => {
  const r = spawnSync('git', ['-C', root, 'log', '-1', '--format=%cI', head], { encoding: 'utf8' });
  return r.status === 0 ? parseTs(String(r.stdout).trim()) : null;
})();
const when = headTs ?? Date.now();

const globToRe = (g) => new RegExp(`^${String(g).trim()
  .replace(/[.+^${}()|[\]\\]/g, '\\$&')
  .replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);
const codeRe = planScope.codeGlobs.map(globToRe);
const codeFiles = changed.filter((f) => codeRe.some((re) => re.test(f)));

if (codeFiles.length === 0) {
  console.log(`PLAN_CHECK=not-applicable（改动里没有代码类文件：改动 ${changed.length} 个 / 代码类 0 个）`);
  process.exit(2);
}

const windowMs = planScope.windowHours * 3600 * 1000;
const newest = [...planRows].sort((a, b) => b.ts - a.ts)[0];
const within = when - newest.ts <= windowMs;
const ordered = newest.ts <= when;
const findings = [];
if (!within || !ordered) {
  findings.push(`最近一条计划行（${newest.id} @ ${new Date(newest.ts).toISOString()}）不满足 "≤ 改动时刻 且 窗口 ≤ ${planScope.windowHours}h"`
    + `（改动时刻 ${new Date(when).toISOString()}）`);
}

console.log(`PLAN_CHECK_MODE=${mode} DECLARED_BY=${planScope.declaredBy} WINDOW_HOURS=${planScope.windowHours} CODE_GLOBS=${planScope.codeGlobs.join(',')}`);
console.log(`PLAN_CHECK_SCOPE changed=${changed.length} code=${codeFiles.length} plan_rows=${planRows.length} newest_plan=${newest.id}`);
console.log(`PLAN_CHECK_SELF_DISCLOSURE 本检查只核"计划工件是否存在且时点成立"，**判不了"是否真先想过"**；`
  + '`why/criteria/rollback` 是**声明**不是签名（能写台账的人也能把话说得漂亮）；且钩子只在提交时跑 ⇒ **抓不到"已经动手了"**。');
if (findings.length === 0) {
  console.log('PLAN_FINDINGS=0');
  console.log('PLAN_CHECK_RESULT=pass');
  process.exit(0);
}
console.log(`PLAN_FINDINGS=${findings.length}`);
for (const f of findings) console.log(`  PLAN_ARTIFACT_MISSING: ${f}（代码类改动 ${codeFiles.length} 个：${codeFiles.slice(0, 5).join(', ')}${codeFiles.length > 5 ? ' …' : ''}）`);
if (mode === 'observe') {
  console.log('PLAN_CHECK_RESULT=observe-hit（V1 只记审计、**不阻断**；要阻断需显式 RULEKEEPER_PLAN_MODE=armed 且经决策）');
  process.exit(0);
}
console.log('PLAN_CHECK_RESULT=fail');
process.exit(1);
