// dsh-rulekeeper · LF-410 **deny/warn + 软拦 vs 硬拦选型**（单调、不可 force-allow）
//
// 判据（清单 LF-410）：
//   绿 = **deny 真阻断且模型可见原因**；**warn 放行且原因可见**
//   红 = ① 误拦率 = 0 样本集（≥20 类正常操作全放行）② **`--force-allow` 能翻我们判的 deny → 必红**
//
// 设计要点（"单调不可 force-allow"）：
//   · 判定只有三档，**强度单调**：`allow < warn < deny`；合并时取**最强**那档 ⇒ 顺序无关，
//     后面的 `allow` 永远翻不掉前面的 `deny`（这就是"不可 force-allow"的机械含义）。
//   · **不存在** force 参数：`decide()` 见到任何 `forceAllow/force/override` 字段**直接判红**并落 finding
//     —— 不是"忽略它"，而是"看见就报"，这样"偷偷加个开关"会被判据抓住。
//   · 选型 fail-closed：**受保护目标**上的未知纪律 → 按**硬拦**处理；非保护目标上的未知纪律 → 软拦（warn），
//     且**原因一定带在 decision 里**（"模型可见原因"是判据的一半）。
//
// 零依赖：只用 node:*。

/** 三档强度（数字越大越强；合并取最大） */
export const LEVELS = Object.freeze({ allow: 0, warn: 1, deny: 2 });

/** 硬拦清单（这些纪律一旦命中就是 deny） */
export const HARD_RULES = Object.freeze([
  'CRED',            // 凭据落盘
  'PROTECTED_WRITE', // 受保护路径改动未留证
  'SECRET_LEAK',     // 已知密钥形态
  'IDENTITY',        // 身份类（需显式打开，见 LF-340）
]);
/** 软拦清单（命中只 warn，不阻断） */
export const SOFT_RULES = Object.freeze([
  'TAG',       // 标签/命名建议
  'STYLE',     // 风格
  'DOC',       // 文档措辞
  'PERF_HINT', // 性能提示
]);

const FORCE_KEYS = ['forceAllow', 'force_allow', 'force', 'override', 'bypass'];

/**
 * 单次判定（**唯一入口**）。任何 force/override 字段都会被判红（不是忽略）。
 * @returns {{ok: boolean, level: 'allow'|'warn'|'deny', reason: string, findings: {code,message}[]}}
 */
export function decide({ rule, target = '', protectedTarget = false, evidence = false, extra = {} } = {}) {
  const findings = [];
  for (const k of FORCE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(extra, k) || Object.prototype.hasOwnProperty.call(arguments[0] ?? {}, k)) {
      findings.push({
        code: 'GUARD_FORCE_ALLOW_REJECTED',
        message: `检测到 force/override 字段「${k}」：本守卫**单调不可 force-allow** —— 想翻掉 deny 只能改判据或改保护面，不能加开关（该字段被忽略并判红）`,
      });
    }
  }
  const r = typeof rule === 'string' ? rule : '';
  let level;
  if (HARD_RULES.includes(r)) level = 'deny';
  else if (SOFT_RULES.includes(r)) level = 'warn';
  else level = protectedTarget ? 'deny' : 'warn'; // fail-closed：受保护目标上的未知纪律按硬拦
  if (level === 'deny' && evidence === true) {
    // 已有留证 → 这一条不再阻断（但保留原因说明，便于模型理解）
    level = 'allow';
    findings.push({ code: 'GUARD_ALLOWED_WITH_EVIDENCE', message: `纪律 ${r} 命中但**已有留证**：放行（${target || 'n/a'}）` });
  } else if (level === 'deny') {
    findings.push({ code: 'GUARD_DENY', message: `硬拦：纪律 ${r} 命中且无留证 ⇒ 阻断执行（${target || 'n/a'}）` });
  } else if (level === 'warn') {
    findings.push({ code: 'GUARD_WARN', message: `软拦：纪律 ${r} 命中 ⇒ 放行但提示（${target || 'n/a'}）` });
  }
  const reason = findings.length === 0
    ? '未命中任何纪律，放行'
    : findings.map((f) => f.message).join('；');
  return { ok: findings.every((f) => f.code !== 'GUARD_FORCE_ALLOW_REJECTED'), level, reason, findings };
}

/** 合并多处判定：**取最强**（顺序无关 ⇒ 后面的 allow 翻不掉前面的 deny） */
export function combine(decisions) {
  const list = Array.isArray(decisions) ? decisions.filter((d) => d !== null && typeof d === 'object') : [];
  if (list.length === 0) return { level: 'allow', reason: '无判定（空输入按放行处理，但调用方应显式给判定）', findings: [] };
  const forced = list.flatMap((d) => (d.findings ?? []).filter((f) => f.code === 'GUARD_FORCE_ALLOW_REJECTED'));
  const strongest = list.reduce((acc, d) => (LEVELS[d.level] > LEVELS[acc.level] ? d : acc), list[0]);
  return {
    level: strongest.level,
    reason: list.map((d, i) => `#${i + 1}[${d.level}] ${d.reason}`).join(' ｜ '),
    findings: [...list.flatMap((d) => d.findings ?? []), ...forced],
  };
}

/** 宿主决策形状（模型看得见原因）：deny 才有 decision 字段；warn/allow 只带 notes */
export function toHostDecision(result) {
  if (result.level === 'deny') return { decision: 'deny', reason: result.reason };
  if (result.level === 'warn') return { notes: [result.reason] };
  return {};
}

/**
 * 把守卫挂到宿主（`tools.guard()` 优先；没有则退回 `tools.register`）。
 * **不接受 forceAllow**：传了就抛（装配期就拦住，比运行期忽略更安全）。
 */
export function registerGuard(ctx, { name, rule, level, forceAllow } = {}) {
  if (forceAllow !== undefined) throw new Error('registerGuard: 不接受 forceAllow（本守卫单调不可 force-allow）');
  if (ctx === null || typeof ctx !== 'object') throw new Error('registerGuard: ctx 非法');
  const hasGuard = ctx.tools !== null && typeof ctx.tools === 'object' && typeof ctx.tools.guard === 'function';
  const hasRegister = ctx.tools !== null && typeof ctx.tools === 'object' && typeof ctx.tools.register === 'function';
  if (!hasGuard && !hasRegister) throw new Error('registerGuard: 宿主 ctx 缺 tools.guard() 与 tools.register()（fail-fast）');
  if (typeof ctx.effect !== 'function') throw new Error('registerGuard: 宿主 ctx 缺 effect()（fail-fast）');
  const handler = (input) => toHostDecision(combine([decide({ rule, target: input?.target ?? '', protectedTarget: input?.protectedTarget === true, evidence: input?.evidence === true })]));
  const api = hasGuard ? 'guard' : 'register';
  ctx.effect(() => (hasGuard ? ctx.tools.guard(name, handler) : ctx.tools.register(name, handler)));
  return { ok: true, api, name, level: level ?? (HARD_RULES.includes(rule) ? 'deny' : 'warn') };
}

/**
 * 误拦率样本集（红态判据要求）：≥20 类**正常操作**必须全放行。
 * 每项 = {name, rule, target, protectedTarget, evidence}；`rule: null` 表示"没有任何纪律命中"。
 */
export function normalOpsSamples() {
  return [
    { name: '读文件', rule: null },
    { name: '列目录', rule: null },
    { name: 'git status', rule: null },
    { name: 'git log', rule: null },
    { name: 'git diff', rule: null },
    { name: 'git add 非保护文件', rule: null },
    { name: 'git commit 非保护文件', rule: null },
    { name: 'node --test', rule: null },
    { name: 'node --check', rule: null },
    { name: '跑门禁自检', rule: null },
    { name: '写文档（非保护）', rule: null },
    { name: '写日志（非保护）', rule: null },
    { name: '快照 take（留证动作本身）', rule: null },
    { name: '恢复 restore（留证动作本身）', rule: null },
    { name: '导出报告', rule: null },
    { name: '查账本', rule: null },
    { name: '查规则包', rule: null },
    { name: '提交受保护文件（**已留证**）', rule: 'PROTECTED_WRITE', target: 'AGENTS.md', protectedTarget: true, evidence: true },
    { name: '软拦类命中（标签建议）', rule: 'TAG', target: 'docs/x.md' },
    { name: '软拦类命中（文档措辞）', rule: 'DOC', target: 'README.md' },
    { name: '软拦类命中（风格）', rule: 'STYLE', target: 'src/x.mjs' },
    { name: '软拦类命中（性能提示）', rule: 'PERF_HINT', target: 'src/x.mjs' },
  ];
}

/** 误拦率（= 被判成 deny 的"正常操作"数 / 样本数）；判据要求为 0 */
export function falseBlockRate(samples = normalOpsSamples()) {
  const blocked = [];
  for (const s of samples) {
    const r = decide({ rule: s.rule, target: s.target ?? '', protectedTarget: s.protectedTarget === true, evidence: s.evidence === true });
    if (r.level === 'deny') blocked.push({ name: s.name, rule: s.rule, reason: r.reason });
  }
  return { total: samples.length, blocked, rate: samples.length === 0 ? 0 : blocked.length / samples.length };
}
