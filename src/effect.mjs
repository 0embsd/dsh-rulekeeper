// dsh-rulekeeper · LF-A* **生效闭环**（入账 ≠ 生效）
//
// 要解决的问题（老板 2026-09-19 指出，实测取证见设计单 §1）：
//   ① 教训 `record` 进账本后就**没有下文**——账本行不驱动任何判据，也不驱动任何提醒（"记了不用"）。
//   ② `rules.json` 的 `checks` / `gates` / `inject` 三个数组**没有任何消费者**（只有 `protected_paths` 活着），
//      即"生效"在数据模型里**没有位置**：写进去也不会有东西读它。
//   ③ `proposals/<id>.json` 的 `status='approved'` **没有生产者**，提案落盘后永远变不成判据（提案不生效）。
//   ④ 生效之后没有回写：`proposal.mjs:proposedRules` 把 `approved` 也当"已有提案"跳过 ⇒ **生效后再次复发被静默忽略**。
//
// 本模块是"生效"的**唯一**实现处，四件事：
//   · `effectPlan`      —— 只读体检：每条纪律的**生效状态**（none / injected / mechanized / verified / recurred）+ findings
//   · `verifyBinding`   —— 生效验证三项（「反向红 + 正对照」）：①命中红 ②**反事实唯一性** ③误报面绿
//   · `applyActivation` —— **唯一**写 `rules.json` 的通路（必须人签字 `by='human'`；备份 + 回读 + 失败回滚）
//   · `effectInjectPlan`—— 把 text-only 的纪律经 `inject.mjs`（LF-430）变成**注入计划**（只读，零落点写入）
//
// 硬边界（红线，与 `evolve.mjs` 的 LF-280 同源）：
//   · `rules.json` 的自动写点**只有** `applyActivation`，且 `by !== 'human'` 一律拒绝；
//   · 本模块**不发明新规则**：写进 rules.json 的东西全部来自**已签名批准**的提案（四要件齐备）；
//   · 写入前必须过 `validateRules`（"草稿产前用目标工具自己的校验器验形状"——来自既有纪律治理实践的直接搬运）。
//
// 归属：core 模块。零依赖：只用 node:*。

import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { appendLine, readLines } from './append.mjs';
import { activationsById, mergeActivation } from './annotations.mjs';
import { describeApproval, validateAnchoredApproval } from './approval.mjs';
import { verifyChecker, validateCheckerBinding, treeHash } from './checker.mjs';
import { backupFile } from './backup.mjs';
import { CHECK_KINDS } from './checks.mjs';
import { CLOSE_KNOWN_GATES, effectiveProtection, readGateLedger, reconWrite } from './gate.mjs';
import { injectPlan } from './inject.mjs';
import { record as ledgerRecord, readLedger } from './ledger.mjs';
import { acquireLock, releaseLock } from './lock.mjs';
import { offGuard } from './mode.mjs';
import { toPosix } from './platform/paths.mjs';
import { requireAnchoredApprovalOf } from './config.mjs';
import { isSafeId, listProposals, proposalPath, validateProposalQuality } from './proposal.mjs';
import { redactValue } from './redact.mjs';
import { canonicalRule } from './ruleid.mjs';
import { isProtected, loadLandingRules, loadRules } from './rules.mjs';
import { SCHEMA_VERSION } from './schema.mjs';

export const EFFECT_STATES = Object.freeze(['none', 'injected', 'mechanized', 'verified', 'recurred', 'retired']);
/** 生效登记事件行的事务名（账本里的 `category`）：状态**派生**，不原地改历史行 */
export const EFFECT_EVENT_CATEGORY = '生效登记';
/** 生效**退役**事件行的事务名（与登记同族：退役也是一次可审计的状态迁移） */
export const EFFECT_RETIRE_CATEGORY = '生效退役';
/** 退役提案的机器标记（写在 `redCriteria` 前缀）：`planActivation` 据此走"摘绑定"而不是"加绑定" */
export const RETIRE_MARK = 'EFFECT_RETIRE_CANDIDATE';
/** 验证记录的机器标记（写在 findings.jsonl 的 evidence 里） */
export const EFFECT_VERIFIED_MARK = 'EFFECT_VERIFIED';
export const EFFECT_FAILED_MARK = 'EFFECT_VERIFY_FAILED';
export const FINDINGS_FILE = 'findings.jsonl';
/** 零信号判定窗口（生效后 N 天既没拦住过、也没再复发 ⇒ 建议退役） */
export const DEFAULT_STALE_DAYS = 30;
/** 生效登记的机制名（必须是 `CLOSE_KNOWN_GATES` 成员，否则收尾闸会判"未知机制"） */
export const DEFAULT_EFFECT_GATE = 'pre-commit';

// ── 载体解析（对齐 SKILL §9.6 R1：判据载体必须与事实一一对应，没有载体 = 凭证不足）──────────
//
// 四要件是**自由文本**（LF-120 冻结成 string，不能改成对象）。要让它们**可执行**，
// 唯一不改契约的办法：约定一个显式载体标记，由文本里解析出来——
//   · `path:<相对项目根的路径>`  —— 反例样本 / 误报面样本（必填其一才能验证）
//   · `inline:<内容>`            —— 目前**不支持**（本工具的三类 check 都吃文件），如实报 uncarried
// 载体词法：路径在**空格 / 中英文标点 / 括号**处截断（实测踩到：`path:docs/x.md（改过没留证的样本）`
// 曾把整句括号说明当成路径 ⇒ 判据载体与事实对不上，正是本条纪律要防的形态）
const RE_CARRIER = /(?:^|[\s([{"'，。;；])(?:path|file|路径)\s*[:：]\s*([^\s()[\]{}<>（），、;；"'《》【】]+)/i;
/** `checker:<项目根相对的规格文件>`（2026-09-19，objective ③ 收口）：检查器绑定的载体标记 */
const RE_CHECKER_CARRIER = /(?:^|[\s([{"'，。;；])checker\s*[:：]\s*([^\s()[\]{}<>（），、;；"'《》【】]+)/i;

/**
 * 从自由文本里解析判据载体。
 * @returns {{kind: 'path'|'checker'|'inline'|null, value: string|null, reason: string|null}}
 */
export function parseCarrier(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { kind: null, value: null, reason: '文本为空（没有载体标记）' };
  }
  const inline = /(?:^|[\s([{"'，。;；])inline\s*[:：]/i.test(text);
  if (inline) return { kind: 'inline', value: null, reason: 'inline: 载体不被支持（三类 check 都吃文件路径）' };
  // checker 标记优先于 path（规格文件里通常也会写路径，先认哪一个不能靠运气）
  const chk = RE_CHECKER_CARRIER.exec(text);
  if (chk !== null) return { kind: 'checker', value: toPosix(chk[1].replace(/^\.\//, '')), reason: null };
  const m = RE_CARRIER.exec(text);
  if (m === null) return { kind: null, value: null, reason: '没有 `path:<相对路径>` 或 `checker:<规格文件>` 载体标记（判据载体与事实必须一一对应）' };
  return { kind: 'path', value: toPosix(m[1].replace(/^\.\//, '')), reason: null };
}

/**
 * 载体必须是**项目根相对路径**（对抗性 QA 10 号发现）。
 * 实证：`path:C:/Users/…/outside.txt` 与 `../../../outside.txt` 都被写进了 `protected_paths` 并"验证通过"——
 * 既把**机器相关绝对路径**带进 rules.json 与输出（违背"判据输出不含绝对路径/跨机可复现"），
 * 又让保护面伸到项目之外。判据：拒绝绝对路径（盘符 / 前导 `/` / UNC）与任何 `..` 段。
 */
export function isRelativeCarrier(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const v = toPosix(value.trim().replace(/^\.\//, ''));
  if (/^[A-Za-z]:/.test(v)) return false;        // C:/…
  if (v.startsWith('/')) return false;           // /etc/…
  if (v.startsWith('//')) return false;          // UNC
  if (v.split('/').some((seg) => seg === '..')) return false;
  return true;
}

/**
 * 误报面载体的**宽松**解析：接受两种口径，避免"同名字段两处口径不一致"。
 *
 * 来历（2026-09-19 实测抓到）：绑定的 `falsePositive` 字段存的是**已解析的路径**（`README.md`），
 * 而 `verifyBinding` 一开始只认**带标记的原文**（`path:README.md`）⇒ 走 CLI 时误报面用例被静默跳过、
 * 报成 `EFFECT_FALSE_POSITIVE_UNCARRIED`（"判据载体与事实对不上"的同一族问题）。
 * 现在：`path:` 标记优先；没有标记时，**只有看起来像相对路径**的裸值才当载体（防把自由描述当路径）。
 */
export function carrierPathOf(text) {
  const parsed = parseCarrier(text);
  if (parsed.kind === 'path') return { path: parsed.value, reason: null };
  const bare = typeof text === 'string' ? text.trim().replace(/^\.\//, '') : '';
  if (bare !== '' && /^[A-Za-z0-9._\-/\\]+$/.test(bare)) return { path: toPosix(bare), reason: null };
  return { path: null, reason: parsed.reason };
}

/**
 * 归一化 `rules.json` 里的一条**生效绑定**（checks 数组的对象条目）。
 * 返回 null 表示"不是绑定条目"（裸字符串等旧形态）。
 * @returns {{kind: string, rule: string, carrier: string|null, falsePositive: string|null,
 *            gate: string|null, proposal: string|null, activatedAt: string|null} | null}
 */
export function normalizeBinding(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const kind = typeof entry.kind === 'string' ? entry.kind.trim() : '';
  const rule = typeof entry.rule === 'string' ? entry.rule.trim() : '';
  if (kind === '' || rule === '') return null;
  const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  return {
    kind,
    rule: canonicalRule(rule),
    carrier: str(entry.carrier) === null ? null : toPosix(str(entry.carrier).replace(/^\.\//, '')),
    falsePositive: str(entry.falsePositive) === null ? null : toPosix(str(entry.falsePositive).replace(/^\.\//, '')),
    gate: str(entry.gate),
    patterns: Array.isArray(entry.patterns)
      ? entry.patterns.filter((p) => typeof p === 'string' && p.trim() !== '').map((p) => toPosix(p.trim().replace(/^\.\//, '')))
      : null,
    proposal: str(entry.proposal),
    activatedAt: str(entry.activatedAt),
    // checker 绑定的字段（kind='checker' 时才用；其余 kind 保持 null，便于判据区分"没写"与"写了空"）
    command: Array.isArray(entry.command) ? entry.command.filter((a) => typeof a === 'string' && a !== '') : null,
    expectRed: entry.expectRed !== null && typeof entry.expectRed === 'object' ? entry.expectRed : null,
    expectGreen: entry.expectGreen !== null && typeof entry.expectGreen === 'object' ? entry.expectGreen : null,
    redSample: entry.redSample !== null && typeof entry.redSample === 'object' ? entry.redSample : null,
    greenSample: entry.greenSample !== null && typeof entry.greenSample === 'object' ? entry.greenSample : null,
    sampleHash: str(entry.sampleHash),
    checkerVersion: str(entry.checkerVersion),
    timeoutMs: Number.isInteger(entry.timeoutMs) ? entry.timeoutMs : null,
  };
}

/** 按 canonical rule 汇总 rules.json 的三类绑定（**唯一**读取处） */
export function ruleBindings(rules) {
  const map = new Map();
  const push = (rule, name, value) => {
    const g = map.get(rule) ?? { rule, checks: [], gates: [], inject: [] };
    g[name].push(value);
    map.set(rule, g);
  };
  for (const entry of Array.isArray(rules?.checks) ? rules.checks : []) {
    const b = normalizeBinding(entry);
    if (b !== null) push(b.rule, 'checks', b);
  }
  for (const entry of Array.isArray(rules?.gates) ? rules.gates : []) {
    const b = normalizeGateBinding(entry);
    if (b !== null) push(b.rule, 'gates', b);
  }
  for (const entry of Array.isArray(rules?.inject) ? rules.inject : []) {
    const b = normalizeInjectBinding(entry);
    if (b !== null) push(b.rule, 'inject', b);
  }
  return map;
}

/**
 * `inject` 绑定条目：`{ rule, fields }`（与 checks 的 `{kind, rule, …}` **不同形状**——
 * 这里不要求 `kind`：注入是"软生效"面，没有 check 类型可绑）。
 */
export function normalizeInjectBinding(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (typeof entry.rule !== 'string' || entry.rule.trim() === '') return null;
  return { rule: canonicalRule(entry.rule), fields: entry.fields !== null && typeof entry.fields === 'object' ? entry.fields : {} };
}

/** `gates` 绑定条目：`{ gate, rule }`（机制名 + 纪律） */
export function normalizeGateBinding(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (typeof entry.rule !== 'string' || entry.rule.trim() === '') return null;
  if (typeof entry.gate !== 'string' || entry.gate.trim() === '') return null;
  return { rule: canonicalRule(entry.rule), gate: entry.gate.trim() };
}

/** 生效登记事件行 → `rule -> [activation]`（**派生**，不原地改账本） */
export function activationsFromLanding(landingDir) {
  return eventRowsOf(landingDir, EFFECT_EVENT_CATEGORY);
}

/** 生效**退役**事件行 → `rule -> [retirement]`（同族派生；退役后不再报"登记了却没绑定"） */
export function retirementsFromLanding(landingDir) {
  return eventRowsOf(landingDir, EFFECT_RETIRE_CATEGORY);
}

function eventRowsOf(landingDir, category) {
  const out = new Map();
  const read = readLedger(landingDir);
  for (const row of read.values) {
    if (row === null || typeof row !== 'object') continue;
    if (row.category !== category) continue;
    if (typeof row.rule !== 'string' || row.rule.trim() === '') continue;
    const rule = canonicalRule(row.rule);
    const m = /proposal=([A-Za-z0-9._-]+)/.exec(String(row.problem ?? ''));
    const list = out.get(rule) ?? [];
    list.push({ rule, ts: typeof row.ts === 'string' ? row.ts : null, proposal: m === null ? null : m[1], evidence: Array.isArray(row.evidence) ? row.evidence : [] });
    out.set(rule, list);
  }
  return out;
}

/**
 * **有效性回写（命中）**：从门禁台账里把"这条纪律真的拦住过"读出来（LF-A50，2026-09-19）。
 *
 * 两个来源（都是**规则/载体可归属**的，不是"落点里有过 finding"那种不可归属的计数）：
 *  · `gate:'close'` 行的 `hits[].rule` —— 收尾闸自报"本批碰到哪几条纪律、靠什么拦住"（**规则级**）
 *  · `gate:'precommit'` 行的 `violations[].path` —— 真阻断在**具体路径**上拦过（**载体级**，与绑定的 carrier 对齐）
 *
 * 诚实边界：precommit 行**不带 rule**（机械门禁不知道自己拦的是哪条纪律），故载体级命中必须靠
 * "绑定声明的 carrier"来归属——这也正是要求绑定写 `carrier` 的另一个理由。
 */
export function hitsFromLanding(landingDir) {
  const byRule = new Map();
  const byPath = new Map();
  const read = readGateLedger(landingDir);
  for (const row of read.values) {
    if (row === null || typeof row !== 'object') continue;
    if (row.gate === 'close' && Array.isArray(row.hits)) {
      for (const h of row.hits) {
        if (h === null || typeof h !== 'object' || typeof h.rule !== 'string' || h.rule.trim() === '') continue;
        const rule = canonicalRule(h.rule);
        const cur = byRule.get(rule) ?? { rule, closes: 0, stoppedBy: new Set() };
        cur.closes += 1;
        if (typeof h.stoppedBy === 'string' && h.stoppedBy !== '') cur.stoppedBy.add(h.stoppedBy);
        byRule.set(rule, cur);
      }
    }
    if (row.gate === 'precommit' && Array.isArray(row.violations)) {
      for (const v of row.violations) {
        if (v === null || typeof v !== 'object' || typeof v.path !== 'string' || v.path === '') continue;
        const key = toPosix(v.path.toLowerCase());
        byPath.set(key, (byPath.get(key) ?? 0) + 1);
      }
    }
  }
  return { byRule, byPath, rows: read.values.length };
}

/** 某条纪律的命中统计（收尾闸自报 + 其绑定 carrier 上的真阻断） */
export function hitsOfRule({ rule, bindings, hits }) {
  const info = hits.byRule.get(rule) ?? { closes: 0, stoppedBy: new Set() };
  let carrierViolations = 0;
  for (const c of bindings?.checks ?? []) {
    if (c.carrier === null) continue;
    carrierViolations += hits.byPath.get(toPosix(c.carrier.toLowerCase())) ?? 0;
  }
  return { closes: info.closes, carrierViolations, stoppedBy: [...info.stoppedBy].sort() };
}

/**
 * 退役提案的**四要件**（LF-A55）。
 *
 * 为什么不"推定"：本仓红线是"四要件只能显式提供、不得从账本条目推定"（那会把质量门降级成复制粘贴）。
 * 这里给的不是"推定的判据"，而是**实测事实 + 可否证的底线**：零信号的窗口/计数是量出来的，
 * 载体沿用已生效绑定的事实值，`activationCheck` 写明"什么情况下这次退役作废"。
 * 且产物**只是提案**：真正摘绑定仍要人签字走 `rk-effect apply`。
 */
export function retireQualityOf({ rule, binding, windowDays, closes, carrierViolations, lastActivation }) {
  return {
    redCriteria: `${RETIRE_MARK} 退役后底线：${rule} 在生效后 ${windowDays} 天内零命中（close=${closes} carrier=${carrierViolations}）且零复发；一旦再命中/再复发 ⇒ 本次退役作废，须恢复绑定`,
    counterExample: binding?.carrier
      ? `path:${binding.carrier}（原判据载体：退役后它将不再被这条绑定拦，故必须靠"零复发"作为替代证据）`
      : `${rule}：原绑定没有 carrier（无反例载体可指，退役建议需人工补载体后再批准）`,
    falsePositiveSurface: binding?.falsePositive ? `path:${binding.falsePositive}` : '无（原绑定未声明误报面载体）',
    activationCheck: `rk-effect plan --landing <落点> --rule ${rule} 必须显示 retired（生效登记${lastActivation === null ? '无' : `=${lastActivation}`}），且此后 30 天不得再现 EFFECT_RECURRED_AFTER_ACTIVATION`,
  };
}

/** 验证记录 → `rule -> [record]`（读 findings.jsonl；该文件此前**没有生产者**，本模块是第一个）
 *
 * **诚实边界（照本仓惯例自曝）**：`findings.jsonl` **没有任何签名**——能改台账的人也能把"已验证"写全。
 * 故 `verified` 状态是**可核对**（谁、何时、对哪个载体、跑出什么），**不是不可伪造**；
 * 真正的防篡改在 git 层（pre-commit 真阻断 / CI 门 / 分支保护 + required checks），与本文件无关。
 * 同族声明见 `src/gate.mjs` 的 `RK_GATE_CI_LEDGER_AUTHENTICATED=false`。
 */
export function verificationsFromLanding(landingDir) {
  const out = new Map();
  const read = readLines(join(landingDir, FINDINGS_FILE));
  for (const row of read.values) {
    if (row === null || typeof row !== 'object') continue;
    const ev = Array.isArray(row.evidence) ? row.evidence.map(String) : [];
    const passed = ev.includes(EFFECT_VERIFIED_MARK);
    const failed = ev.includes(EFFECT_FAILED_MARK);
    if (passed !== true && failed !== true) continue;
    if (typeof row.rule !== 'string' || row.rule.trim() === '') continue;
    const rule = canonicalRule(row.rule);
    const list = out.get(rule) ?? [];
    list.push({ rule, ts: typeof row.ts === 'string' ? row.ts : null, passed, target: typeof row.target === 'string' ? row.target : null });
    out.set(rule, list);
  }
  return out;
}

/** 可判激活条件的占位符黑名单（trim 后等于这些值 ⇒ 视为**没有**条件，不许蒙混） */
export const ACTIVATION_PLACEHOLDERS = Object.freeze(['todo', 'tbd', 'n/a', '待补', '待定', '待写', '无']);

/**
 * 条目的**可判激活条件**（P0-2，2026-09-19）。
 *
 * 语义：一句话说明"在什么**可观测**条件下这条纪律适用 / 该被想起 / 该被判红"，
 * 措辞必须可机械判定（禁"注意""小心一点"这类不可判表述）。
 *
 * 为什么必须挂在**条目层**而不是类目层（06 Hermes 深读给出的结构性根因）：
 *   类目（CAT-*）只是分组标签、不承担生效语义；成熟实现把 `conditions` 挂在**每一条**技能上
 *   （`agent/skill_utils.py:635`、`agent/prompt_builder.py:1174-1192`）。我们把绑定做在类目层，
 *   于是 `TEXT_ONLY 21/22` 是**结构必然**——不是执行不力。
 * 为什么先做"可统计"这一步（E1 实验结论）：10 条真实教训里 **0 条**能对上现有"文件载体"模型、
 *   **10 条**只能靠 `kind:"checker"`；而 634 条账本里仅 **6 条**带可判指纹 ⇒ 先把
 *   "这条到底有没有一条可判条件"变成**可机械统计的事实**，才谈得上推进。
 *
 * @returns {string} trim 后的条件文本；空/非字符串/占位符 ⇒ `''`（= 没有可判激活条件）
 */
export function activationOf(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return '';
  const raw = row.activation;
  if (typeof raw !== 'string') return '';
  const t = raw.trim();
  if (t === '') return '';
  if (ACTIVATION_PLACEHOLDERS.includes(t.toLowerCase())) return '';
  return t;
}

/** 账本按 canonical rule 聚合（复发计数 / 首末时间 / 条目 / **带可判激活条件的条目数**）
 *
 * 2026-09-19 契约变更：条件是**合并视图**（行内 `activation` 优先；为空则取 `activations.jsonl`
 * 注解层）。原因：账本 append-only 不可原地改写，而 385 条既有教训一开始全都没有条件 ——
 * 补条件只能走注解层（`annotations.mjs`），否则就是"改行=违宪"或"复制新行=制造重复"。
 */
export function ledgerGroups(landingDir) {
  const groups = new Map();
  const read = readLedger(landingDir);
  const byId = activationsById(landingDir);
  for (const row of read.values) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    if (typeof row.rule !== 'string' || row.rule.trim() === '') continue;
    if (row.category === EFFECT_EVENT_CATEGORY) continue; // 生效登记不是"又踩了一次"
    if (row.category === EFFECT_RETIRE_CATEGORY) continue; // 生效退役同理
    const rule = canonicalRule(row.rule);
    const g = groups.get(rule) ?? { rule, count: 0, withActivation: 0, firstSeen: null, lastSeen: null, variants: new Set() };
    g.count += 1;
    if (activationOf(mergeActivation(row, byId)) !== '') g.withActivation += 1;
    g.variants.add(row.rule);
    const ts = typeof row.ts === 'string' ? row.ts : '';
    if (ts !== '') {
      if (g.firstSeen === null || ts < g.firstSeen) g.firstSeen = ts;
      if (g.lastSeen === null || ts > g.lastSeen) g.lastSeen = ts;
    }
    groups.set(rule, g);
  }
  return groups;
}

/**
 * **只读**生效体检（LF-A20/A30）。
 * @param {{landingDir: string, now?: Date, staleDays?: number, rules?: object|null}} opts
 */
export function effectPlan(opts = {}) {
  const landingDir = opts.landingDir;
  const now = opts.now ?? new Date();
  const staleDays = Number.isInteger(opts.staleDays) ? opts.staleDays : DEFAULT_STALE_DAYS;
  const empty = { items: [], findings: [{ code: 'EFFECT_NO_LANDING', message: 'effectPlan 需要 landingDir', severity: 'error' }], counts: {}, ok: false };
  if (typeof landingDir !== 'string' || landingDir.trim() === '') return empty;

  const loaded = loadLandingRules(landingDir);
  const rules = opts.rules ?? loaded.rulesResult.rules;
  const protection = effectiveProtection(landingDir);
  const bindings = ruleBindings(rules);
  const activations = activationsFromLanding(landingDir);
  const retirements = retirementsFromLanding(landingDir);
  const hits = hitsFromLanding(landingDir);
  const verifications = verificationsFromLanding(landingDir);
  const groups = ledgerGroups(landingDir);
  const proposals = listProposals(landingDir).items;

  const findings = [];
  const items = [];
  const allRules = [...new Set([...groups.keys(), ...bindings.keys(), ...activations.keys()])].sort();

  for (const rule of allRules) {
    const g = groups.get(rule) ?? { rule, count: 0, firstSeen: null, lastSeen: null, variants: new Set() };
    const b = bindings.get(rule) ?? { rule, checks: [], gates: [], inject: [] };
    const acts = activations.get(rule) ?? [];
    const vers = verifications.get(rule) ?? [];
    const lastActivation = acts.length === 0 ? null : acts.map((a) => a.ts ?? '').sort().pop();
    // 验证凭证**必须与绑定对齐**（对抗性 QA 7 号发现）：此前只要 findings.jsonl 里有一行带
    // `EFFECT_VERIFIED` 就判 verified，**从不比对 target** —— 拿一行指向别的文件的伪造记录即可翻盘。
    // 现在要求 `target` 恰是某条绑定的 carrier，否则"可核对"这句话就是假的。
    const carriers = new Set(b.checks.map((c) => c.carrier).filter((c) => typeof c === 'string' && c !== ''));
    // **复发**：只在"生效之后"入账的同 rule 条目才算（生效前踩的坑是提案的来历，不算判据失效）
    const recurred = lastActivation === null ? 0 : (g.lastSeen !== null && g.lastSeen > lastActivation ? 1 : 0);
    const verified = vers.some((v) => v.passed === true && v.target !== null && carriers.has(v.target));
    const targetMismatch = vers.some((v) => v.passed === true && (v.target === null || !carriers.has(v.target)));
    const openProposal = proposals.find((p) => typeof p.rule === 'string' && canonicalRule(p.rule) === rule && p.status === 'proposed') ?? null;

    let state;
    if (b.checks.length === 0 && b.inject.length === 0 && b.gates.length === 0) state = 'none';
    else if (b.checks.length === 0) state = 'injected';
    else if (recurred > 0) state = 'recurred';
    else if (verified) state = 'verified';
    else state = 'mechanized';
    // **退役**（LF-A55）：有人签字退役过、且晚于最后一次生效登记 ⇒ 这一条是"主动不再拦"，
    // 不是"坏了"。故它既不算没绑定（ACTIVATED_UNBOUND），也不算"只写下来了"（TEXT_ONLY）。
    const retireTs = (() => {
      const list = retirements.get(rule) ?? [];
      return list.length === 0 ? null : list.map((x) => x.ts ?? '').sort().pop();
    })();
    const retired = retireTs !== null && (lastActivation === null || retireTs > lastActivation);
    if (retired) state = 'retired';
    const hitInfo = hitsOfRule({ rule, bindings: b, hits });

    // 空转闸（"已实现未生效"在**数据面**的对应物）：绑定的载体必须真被保护面覆盖，否则这条绑定是挂名
    const uncovered = [];
    for (const c of b.checks) {
      // checker 绑定没有文件载体：它的"空转"形态是**检查器压根跑不起来**（形状不合法）。
      // 用同一份形状校验代替 carrier 覆盖检查，避免把合法的 checker 绑定误报成"缺 carrier"。
      if (c.kind === 'checker') {
        const cproblems = validateCheckerBinding(c);
        if (cproblems.length > 0) uncovered.push(`${c.rule}: checker 绑定形状不合法（${cproblems.join('；')}）`);
        continue;
      }
      if (c.carrier === null) { uncovered.push(`${c.rule}: 绑定缺 carrier`); continue; }
      const verdict = isProtected(c.carrier, { protected_paths: protection.patterns }, { projectRoot: opts.projectRoot ?? process.cwd() });
      if (verdict.protected !== true) uncovered.push(`${c.rule}: carrier ${c.carrier} 未被保护面覆盖（空转闸）`);
    }
    if (uncovered.length > 0) {
      findings.push({ code: 'EFFECT_BINDING_UNENFORCED', severity: 'error', rule, message: uncovered.join('；') });
    }
    for (const c of b.checks) {
      if (c.gate !== null && !CLOSE_KNOWN_GATES.includes(c.gate)) {
        findings.push({ code: 'EFFECT_BINDING_UNKNOWN_GATE', severity: 'error', rule, message: `绑定的机制 ${c.gate} 不在已知机制表（${CLOSE_KNOWN_GATES.join(' / ')}）` });
      }
    }
    if (g.count > 0 && state === 'none') {
      findings.push({ code: 'EFFECT_TEXT_ONLY', severity: 'error', rule, message: `${rule}: 账本有 ${g.count} 条但 rules.json 无绑定（只写下来了，没生效）` });
    }
    if (state === 'retired') {
      findings.push({ code: 'EFFECT_RETIRED', severity: 'info', rule, message: `${rule}: 已于 ${retireTs} 人签字退役（零信号窗口内）；再命中/再复发即作废` });
    }
    // **"登记了却没绑定"**（对抗性 QA 2 号发现，fail-closed）：有生效登记、却没有对应绑定
    //   —— 可能来自：并发写互相覆盖、绑定被手删、`rk-backup rebuild` 用旧包覆盖。
    //   此前只查 `g.count > 0`（有教训行）才报 TEXT_ONLY，于是"登记在、绑定没了"这种**最危险的状态**
    //   反而判 pass（plan 输出 TEXT_ONLY=0 + 全绿）⇒ 现在单列一条 error 级发现。
    if (acts.length > 0 && b.checks.length === 0 && b.inject.length === 0 && state !== 'retired') {
      findings.push({ code: 'EFFECT_ACTIVATED_UNBOUND', severity: 'error', rule, message: `${rule}: 有 ${acts.length} 次生效登记但 rules.json 里**没有绑定**（被回滚/被删/被还原覆盖）——体检不得判通过` });
    }
    if (openProposal !== null) {
      findings.push({ code: 'EFFECT_PENDING_PROPOSAL', severity: 'info', rule, message: `${rule}: 有未决提案 ${openProposal.id}，等人签字后 effect apply` });
    }
    if (state === 'mechanized') {
      findings.push({ code: 'EFFECT_NOT_VERIFIED', severity: 'warn', rule, message: `${rule}: 已绑判据但没跑过 effect verify（无验证凭证）` });
    }
    if (targetMismatch && state !== 'mechanized') {
      findings.push({ code: 'EFFECT_VERIFY_TARGET_MISMATCH', severity: 'warn', rule, message: `${rule}: findings.jsonl 里有"通过"记录，但其 target 与绑定的 carrier（${[...carriers].join(',') || '(无)'}）不一致——不计入 verified` });
    }
    // 绑定的来源可审计（对抗性 QA 14 号发现）：绑定里写着 proposal=<id>，就该真的存在且已批准
    for (const c of b.checks) {
      if (c.proposal === null) continue;
      const p = proposals.find((x) => x.id === c.proposal) ?? null;
      if (p === null) {
        findings.push({ code: 'EFFECT_BINDING_PROPOSAL_MISSING', severity: 'error', rule, message: `${rule}: 绑定引用的提案 ${c.proposal} **不存在**（绑定来源不可审计）` });
      } else if (p.status !== 'approved') {
        findings.push({ code: 'EFFECT_BINDING_PROPOSAL_UNVERIFIED', severity: 'error', rule, message: `${rule}: 绑定引用的提案 ${c.proposal} 状态是 ${p.status}（不是 approved——"写进 rules.json 的东西全部来自已签名批准的提案"这条链断了）` });
      }
    }
    if (state === 'recurred') {
      findings.push({ code: 'EFFECT_RECURRED_AFTER_ACTIVATION', severity: 'error', rule, message: `${rule}: 生效后（${lastActivation}）又踩了（${g.lastSeen}）——判据没拦住，须升级` });
    }
    if (state !== 'recurred' && state !== 'retired' && lastActivation !== null) {
      const ageDays = (now.getTime() - Date.parse(lastActivation)) / 86400000;
      // **零信号 = 零命中 + 零复发**（有效性回写后再判，不再是"只看复发"的弱判据）
      if (Number.isFinite(ageDays) && ageDays > staleDays && recurred === 0 && hitInfo.closes === 0 && hitInfo.carrierViolations === 0) {
        findings.push({ code: 'EFFECT_STALE_NO_SIGNAL', severity: 'warn', rule, message: `${rule}: 生效 ${Math.floor(ageDays)} 天零命中零复发（close=0 carrier=0），建议退役（rk-effect apply 批准退役提案）或收紧` });
      }
    }

    items.push({
      rule,
      state,
      entries: g.count,
      // P0-2：条目级"可判激活条件"覆盖（**新口径**：可机械统计；类目层绑定不是生效的充分条件）
      entriesWithActivation: g.withActivation ?? 0,
      activationCoverage: g.count > 0 ? Number(((g.withActivation ?? 0) / g.count).toFixed(4)) : 0,
      firstSeen: g.firstSeen,
      lastSeen: g.lastSeen,
      variants: [...g.variants].sort(),
      checks: b.checks.length,
      inject: b.inject.length,
      gates: b.gates.length,
      activations: acts.length,
      lastActivation,
      retired,
      lastRetirement: retireTs,
      hits: hitInfo,
      verified,
      recurredAfterActivation: recurred > 0,
      openProposal: openProposal === null ? null : openProposal.id,
    });
  }

  const counts = {};
  for (const s of EFFECT_STATES) counts[s] = items.filter((i) => i.state === s).length;

  // ── P0-2：条目级可判激活条件的**体检口径**（2026-09-19）──────────────────────────
  // 旧口径问"这个类目有没有生效绑定"；新口径问"**条目**有没有一条可判激活条件"。
  // 为什么换：类目只是分组标签（06 深读的结构性根因），旧口径下 21/22 全空是必然，
  // 看不出"到底缺什么"；新口径直接指出"缺的是原料（可判条件/指纹）"，且**可机械统计**。
  // 严重性取 `info`：**不改 ok 与 exit code**（这是口径补充，不是新增阻断）。
  const entryStats = {
    entries: items.reduce((n, i) => n + i.entries, 0),
    withActivation: items.reduce((n, i) => n + i.entriesWithActivation, 0),
  };
  entryStats.withoutActivation = entryStats.entries - entryStats.withActivation;
  entryStats.coverage = entryStats.entries > 0
    ? Number((entryStats.withActivation / entryStats.entries).toFixed(4))
    : 0;
  if (entryStats.entries > 0 && entryStats.withoutActivation > 0) {
    findings.push({
      code: 'EFFECT_ENTRY_NO_ACTIVATION',
      severity: 'info',
      message: `${entryStats.withoutActivation}/${entryStats.entries} 条纪律**没有可判激活条件**（账本行的 activation 字段为空或占位符）⇒ 它们无法被机械判定"何时适用"，绑定再写也是空转。先补原料（可判条件/反例/误报面）——口径说明见 SCHEMA.md 的 ledger.jsonl 与 effect.mjs 的 activationOf()`,
    });
  }

  return {
    items, findings, counts, entryStats,
    ok: findings.every((f) => f.severity !== 'error'),
    landed: loaded.rulesResult.missing !== true,
  };
}

/**
 * 生效验证三项（LF-A40；**驱动真实入口** `reconWrite`，判据落在**载体自身**）。
 *
 * 设计要点（v3，2026-09-19 独立 CR 的 blocker #1 与 major #3/#4/#5 全在这里收口）：
 *  · **判据绑定到载体**：不再用"落点里有任意 finding"当命中（那会让"配置坏了"冒充"判据拦住了"），
 *    而是取 `reconWrite` 报告里**该 carrier 自己的 verdict** ∈ {unrecorded, nosnapshot, missing-on-disk}。
 *  · **违规样本是构造出来的**：在派生落点（真实 rules/snapshots 的副本，只把该载体的快照记录摘掉）里跑，
 *    于是"受保护但没留证"这一形态**任何时刻都能复现**——稳态（已留证未改）下也能重跑，不再是一次性状态。
 *  · **反事实只摘这条绑定的模式**（`binding.patterns`）：摘完必须**转绿**，否则拦住它的不是这条判据。
 *    没声明 patterns ⇒ fail-closed（不可隔离）。
 *  · **落点级发现不冒充判据**：rules/config 不可读 ⇒ `EFFECT_VERIFY_LANDING_DIRTY` 直接判不通过。
 *
 * ① 命中红：样本载体必须被判 deny；② 反事实唯一性：摘掉本绑定的模式后必须转 allow；
 * ③ 误报面绿：误报面样本不得被判 deny；④ 载体/类型检查：没有 carrier、或 kind 不是 `file_untracked_change` ⇒ 不许声称能验证。
 *
 * @param {{landingDir: string, projectRoot: string, binding: object, falsePositive?: string|null}} opts
 */
export function verifyBinding(opts = {}) {
  const landingDir = opts.landingDir;
  const projectRoot = opts.projectRoot;
  const binding = normalizeBinding(opts.binding);
  const findings = [];
  const cases = [];
  if (binding === null) {
    return { ok: false, binding: null, cases, findings: [{ code: 'EFFECT_BINDING_UNREADABLE', message: '绑定条目形状不合法' }] };
  }
  // ④ 类型/载体检查（**先于判定**）：不支持的 kind 不许"用文件写入门禁"糊过去（CR major #2）
  // 2026-09-19（objective ③）：`checker` 已实现（委托给 checker.mjs 的四项验证 + 三态），
  //   其余非文件类 kind 仍 fail-closed 如实报"未实现"。
  if (binding.kind === 'checker') {
    const r = verifyChecker({
      projectRoot: opts.projectRoot ?? process.cwd(),
      binding,
      allowExec: opts.allowExec === true,
      ...(Number.isInteger(opts.timeoutMs) ? { timeoutMs: opts.timeoutMs } : {}),
    });
    for (const c of r.cases) cases.push({ ...c, kind: 'checker' });
    for (const f of r.findings) findings.push({ ...f, rule: binding.rule });
    if (r.ok === true) {
      findings.push({ code: 'EFFECT_CHECKER_VERIFIED', severity: 'info', rule: binding.rule, message: `${binding.rule}: checker 四项验证全过（状态 ${r.state}）：命中红/误报面绿/反事实唯一性/确定性` });
    }
    return { ok: r.ok === true, binding, cases, findings, state: r.state };
  }
  if (binding.kind !== 'file_untracked_change') {
    findings.push({ code: 'EFFECT_KIND_UNSUPPORTED', message: `${binding.rule}: 绑定 kind=${binding.kind} 暂不支持验证（本工具已实现 file_untracked_change 与 checker；其余 kind 必须如实报"未实现"，不得判通过）` });
    return { ok: false, binding, cases, findings, state: 'inconclusive' };
  }
  if (binding.carrier === null) {
    findings.push({ code: 'EFFECT_VERIFY_UNCARRIED', message: `${binding.rule}: 绑定没有 carrier（判据载体与事实必须一一对应，缺载体 = 凭证不足）` });
    return { ok: false, binding, cases, findings };
  }
  if (!Array.isArray(binding.patterns) || binding.patterns.length === 0) {
    findings.push({ code: 'EFFECT_COUNTERFACTUAL_UNDECLARED', message: `${binding.rule}: 绑定未声明 patterns（无法只摘掉"这一条绑定带来"的拦截 ⇒ 反事实不可隔离，fail-closed）` });
    return { ok: false, binding, cases, findings };
  }
  const carrier = binding.carrier;

  // 派生落点 A（完整保护面）：违规样本 = 该载体"受保护但没留证"
  const treatment = buildSampleLanding({ landingDir, carrier, dropPatterns: [] });
  if (treatment.ok !== true) {
    return { ok: false, binding, cases, findings: [{ code: treatment.code, message: `${binding.rule}: ${treatment.reason}` }] };
  }
  const control = buildSampleLanding({ landingDir, carrier, dropPatterns: binding.patterns });
  try {
    // ① 命中红（judge 落在载体自身）
    const t = reconWrite({ projectRoot, landingDir: treatment.dir, files: [carrier], phase: 'close' });
    const tv = carrierVerdictOf(t, carrier);
    const hitOk = DENY_VERDICTS.has(tv);
    cases.push({ name: '命中红', expect: 'deny', got: hitOk ? 'deny' : 'allow', ok: hitOk, codes: [`carrier=${tv}`] });
    if (!hitOk) findings.push({ code: 'EFFECT_VERIFY_NOT_HIT', message: `${binding.rule}: 载体 ${carrier} 在**构造的违规样本**上没被判红（carrier verdict=${tv}）——判据没拦住它` });

    // ② 反事实唯一性（只摘本绑定声明的模式）
    if (control.ok !== true) {
      findings.push({ code: control.code, message: `${binding.rule}: 反事实落点构造失败——${control.reason}` });
    } else {
      const c = reconWrite({ projectRoot, landingDir: control.dir, files: [carrier], phase: 'close' });
      const cv = carrierVerdictOf(c, carrier);
      const ctrlOk = !DENY_VERDICTS.has(cv);
      cases.push({ name: '反事实唯一性', expect: 'allow', got: ctrlOk ? 'allow' : 'deny', ok: ctrlOk, codes: [`carrier=${cv}`] });
      if (!ctrlOk) {
        findings.push({
          code: 'EFFECT_CHECK_NOT_THE_STOPPER',
          message: `${binding.rule}: 摘掉本绑定声明的模式（${binding.patterns.join(', ')}）后载体 ${carrier} **仍被判红**（carrier verdict=${cv}）⇒ 拦住它的不是这条判据（挂名生效）`,
        });
      }
    }

    // ③ 误报面绿（advisory：误报面没有可用载体时只提示，不阻断）
    const fpText = typeof opts.falsePositive === 'string' && opts.falsePositive.trim() !== ''
      ? opts.falsePositive
      : (binding.falsePositive ?? '');
    if (fpText !== '') {
      const parsed = carrierPathOf(fpText);
      if (parsed.path === null) {
        findings.push({ code: 'EFFECT_FALSE_POSITIVE_UNCARRIED', message: `${binding.rule}: 误报面没有可用载体（既非 path: 标记、也不像相对路径），跳过绿态用例（${parsed.reason}）` });
      } else {
        const fp = reconWrite({ projectRoot, landingDir: treatment.dir, files: [parsed.path], phase: 'close' });
        const fv = carrierVerdictOf(fp, parsed.path);
        const fpOk = !DENY_VERDICTS.has(fv);
        cases.push({ name: '误报面绿', expect: 'allow', got: fpOk ? 'allow' : 'deny', ok: fpOk, codes: [`carrier=${fv}`] });
        if (!fpOk) findings.push({ code: 'EFFECT_FALSE_POSITIVE', message: `${binding.rule}: 误报面样本 ${parsed.path} 被判红（误报；carrier verdict=${fv}）` });
      }
    }
  } finally {
    for (const d of [treatment.dir, control.dir]) {
      if (typeof d === 'string' && existsSync(d)) rmSync(d, { recursive: true, force: true });
    }
  }

  const ok = findings.every((f) => f.code === 'EFFECT_FALSE_POSITIVE_UNCARRIED');
  return { ok, binding, cases, findings };
}

/** 门禁报告里**该载体自己**的判定（找不到 = 不在保护面）——"命中红"判据的唯一落点 */
export function carrierVerdictOf(report, carrier) {
  const key = toPosix(String(carrier).toLowerCase());
  const hit = (report?.checked ?? []).find((c) => toPosix(String(c.path).toLowerCase()) === key);
  return hit === undefined ? 'unprotected' : String(hit.verdict);
}

/** 会被判"改过但没留证"的 verdict（命中红 = verdict ∈ 此集合） */
export const DENY_VERDICTS = new Set(['unrecorded', 'nosnapshot', 'missing-on-disk']);

/**
 * 构造**违规样本落点**：真实落点的副本（rules.json 原样 + snapshots/index.jsonl 摘掉该载体记录 +
 * config.json 承载"要用的保护面"）。`dropPatterns=[]` ⇒ 完整保护面（治疗组）；给模式 ⇒ 摘掉它们（对照组）。
 *
 * 为什么必须构造（独立 CR major #5）：真实稳态下载体已留证且未改 ⇒ 门禁判 pass ⇒ "命中红"永远无法通过、
 * `verified` 变成**一次性**状态（README/RUNBOOK 承诺的"重跑 verify 得 exit=0"在健康仓库里做不到）。
 * 为什么规则/配置不可读要 fail-closed（QA #3）：否则坏配置的那条 deny 会在副本里被"洗掉"，两边都"符合预期"。
 */
function buildSampleLanding({ landingDir, carrier, dropPatterns }) {
  const protection = effectiveProtection(landingDir);
  const unreadable = (protection.findings ?? []).filter((f) => f.code === 'GATE_WRITE_CONFIG_UNREADABLE' || f.code === 'GATE_WRITE_RULES_UNREADABLE');
  if (unreadable.length > 0) {
    return { ok: false, code: 'EFFECT_VERIFY_LANDING_DIRTY', reason: `落点自身配置不可读（${unreadable.map((f) => f.code).join(',')}）——判定不可信，fail-closed` };
  }
  // 证据基座不完整同样判"落点脏"：此时"没记录"与"记录读不出"不可区分（与 checks.mjs 同口径），
  // 旧实现会把这类**落点级**发现算进"命中红/反事实"，把"判据没生效"的帽子扣在没问题的绑定上（CR major #4）。
  const idxHealth = readLines(join(landingDir, 'snapshots', 'index.jsonl'));
  if ((idxHealth.badLines ?? 0) > 0 || (idxHealth.oversized ?? 0) > 0 || idxHealth.truncatedTail === true) {
    return { ok: false, code: 'EFFECT_VERIFY_LANDING_DIRTY', reason: `快照索引基座不完整（badLines=${idxHealth.badLines ?? 0} oversized=${idxHealth.oversized ?? 0} truncatedTail=${idxHealth.truncatedTail === true}）——判定不可信，fail-closed` };
  }
  const tmp = mkdtempSync(join(tmpdir(), 'rk-effect-sample-'));
  mkdirSync(join(tmp, 'snapshots'), { recursive: true });
  const rulesSrc = join(landingDir, 'rules.json');
  if (existsSync(rulesSrc)) copyFileSync(rulesSrc, join(tmp, 'rules.json'));
  const idxSrc = join(landingDir, 'snapshots', 'index.jsonl');
  if (existsSync(idxSrc)) {
    const key = toPosix(String(carrier).toLowerCase());
    const kept = readFileSync(idxSrc, 'utf8').split('\n').filter((l) => l.trim() !== '').filter((l) => {
      try {
        const row = JSON.parse(l);
        return !(row !== null && typeof row === 'object' && typeof row.path === 'string' && toPosix(row.path.toLowerCase()) === key);
      } catch {
        return true;   // 坏行原样保留（**不替落点洗手**：坏索引该继续被看见）
      }
    });
    writeFileSync(join(tmp, 'snapshots', 'index.jsonl'), kept.length === 0 ? '' : `${kept.join('\n')}\n`, 'utf8');
  }
  const cfgSrc = join(landingDir, 'config.json');
  let cfg = {};
  if (existsSync(cfgSrc)) {
    try { cfg = JSON.parse(readFileSync(cfgSrc, 'utf8')) ?? {}; } catch { cfg = {}; }
  }
  const norm = (p) => toPosix(String(p).trim().replace(/^\.\//, '').toLowerCase());
  const drop = new Set((dropPatterns ?? []).map(norm));
  const keep = (Array.isArray(protection.patterns) ? protection.patterns : []).filter((p) => !drop.has(norm(p)));
  writeFileSync(join(tmp, 'config.json'), `${JSON.stringify({ schema: SCHEMA_VERSION, mode: typeof cfg.mode === 'string' ? cfg.mode : (protection.mode ?? 'observe'), protected_paths: keep }, null, 2)}\n`, 'utf8');
  return { ok: true, dir: tmp, patterns: keep };
}

/** 保护面模式是否命中某个 pathKey（复用 rules.mjs 的 globToRegExp 语义，单点不复制）
 *  `projectRoot` 必须由调用方传入（CR major #4：此前写死 `process.cwd()`，**绝对载体**下永不匹配 ⇒ 假红） */
function patternHits(pattern, pathKeyValue, projectRoot) {
  return isProtected(pathKeyValue, { protected_paths: [pattern] }, { projectRoot: projectRoot ?? process.cwd() }).protected === true;
}

/**
 * 由**已批准**的提案生成 `rules.json` 变更草案（**不写盘**）。LF-A30/A40 共用。
 * @param {{landingDir: string, proposal: object, patterns?: string[], gate?: string, now?: Date}} opts
 */
export function planActivation(opts = {}) {
  const landingDir = opts.landingDir;
  const proposal = opts.proposal;
  const now = opts.now ?? new Date();
  const gate = typeof opts.gate === 'string' && opts.gate.trim() !== '' ? opts.gate.trim() : DEFAULT_EFFECT_GATE;
  const problems = [];
  if (proposal === null || typeof proposal !== 'object') problems.push('提案不是对象');
  if (problems.length === 0) {
    const q = validateProposalQuality(proposal);
    if (q.ok !== true) problems.push(q.reason);
    if (proposal.status !== 'proposed') problems.push(`提案状态必须是 proposed（实际 ${JSON.stringify(proposal?.status)}）`);
    if (!CLOSE_KNOWN_GATES.includes(gate)) problems.push(`机制 ${gate} 不在已知机制表（${CLOSE_KNOWN_GATES.join(' / ')}）`);
  }
  if (problems.length > 0) return { ok: false, findings: problems.map((p) => ({ code: 'EFFECT_PLAN_UNQUALIFIED', message: p })), candidate: null, additions: null };

  const rule = canonicalRule(proposal.rule);
  const loaded = loadLandingRules(landingDir);
  const before = loaded.rulesResult.rules ?? { schema: SCHEMA_VERSION, project: 'unknown', protected_paths: [], gates: [], checks: [], inject: [] };

  // ── **退役**分支（LF-A55）：提案带 RETIRE_MARK ⇒ 摘绑定，而不是加绑定 ────────────────────
  // 判据：只摘**这条纪律自己的** checks 绑定；其 `patterns` 若仍被**别的**绑定声明，则**不许摘**
  //（否则会顺手把别人的保护面削掉 —— 那是"退役"变"拆台"）。
  if (typeof proposal.redCriteria === 'string' && proposal.redCriteria.includes(RETIRE_MARK)) {
    const mine = ruleBindings(before).get(rule) ?? { checks: [] };
    if (mine.checks.length === 0) {
      return { ok: false, findings: [{ code: 'EFFECT_PLAN_UNQUALIFIED', message: `${rule}: 没有可退役的 checks 绑定（已经是未绑定状态）` }], candidate: null, additions: null };
    }
    const others = new Set();
    for (const [r, g] of ruleBindings(before)) {
      if (r === rule) continue;
      for (const c of g.checks) for (const p of c.patterns ?? []) others.add(toPosix(String(p).toLowerCase()));
    }
    const removable = new Set();
    for (const c of mine.checks) for (const p of c.patterns ?? []) removable.add(toPosix(String(p)));
    const dropPatterns = [...removable].filter((p) => !others.has(toPosix(p.toLowerCase())));
    const candidate = {
      ...before,
      protected_paths: (Array.isArray(before.protected_paths) ? before.protected_paths : []).filter((p) => !dropPatterns.includes(toPosix(String(p)))),
      checks: (Array.isArray(before.checks) ? before.checks : []).filter((e) => {
        const b = normalizeBinding(e);
        return !(b !== null && b.rule === rule);
      }),
    };
    return {
      ok: true,
      kind: 'retire',
      findings: [],
      rule,
      gate: mine.checks[0].gate ?? DEFAULT_EFFECT_GATE,
      carriers: mine.checks.map((c) => c.carrier).filter((c) => c !== null),
      falsePositive: mine.checks[0].falsePositive ?? null,
      patterns: dropPatterns,
      additions: { patterns: [], binding: null, retirement: { removedPatterns: dropPatterns, removedBindings: mine.checks.length } },
      candidate,
      before,
    };
  }

  const carriers = [];
  const ce = parseCarrier(proposal.counterExample);

  // ── **checker 分支**（2026-09-19，objective ③ 的收口）────────────────────────────────
  // 提案的 `counterExample` 写 `checker:<项目根相对的规格文件>` ⇒ 由**已入库的规格文件**构造
  // `kind:"checker"` 绑定，走的是**同一条**人签字写通路（备份 / 写入 / 回读 / 失败回滚 / 台账）。
  // 为什么非做不可：否则写 checker 绑定只能手改 rules.json ⇒ 绕过唯一写通路，前面所有
  // "闸门不可被 AI 直接改"的声明就都成了空话（规则 43 同族：自称型控制不是边界）。
  if (ce.kind === 'checker') {
    if (!isRelativeCarrier(ce.value)) {
      problems.push(`counterExample 的 checker 规格文件必须是**项目根相对路径**（收到 ${ce.value}）`);
      return { ok: false, findings: problems.map((p) => ({ code: 'EFFECT_PLAN_UNQUALIFIED', message: p })), candidate: null, additions: null };
    }
    const specAbs = join(opts.projectRoot ?? process.cwd(), ce.value);
    if (!existsSync(specAbs)) {
      return { ok: false, findings: [{ code: 'EFFECT_CHECKER_SPEC_MISSING', message: `checker 规格文件不存在: ${ce.value}（规格必须**入库**，否则判据在别的机器上无法复现）` }], candidate: null, additions: null };
    }
    let spec;
    try {
      spec = JSON.parse(readFileSync(specAbs, 'utf8'));
    } catch (err) {
      return { ok: false, findings: [{ code: 'EFFECT_CHECKER_SPEC_BAD_JSON', message: `checker 规格文件不是合法 JSON（${ce.value}）: ${String(err?.message ?? err)}` }], candidate: null, additions: null };
    }
    if (spec !== null && typeof spec === 'object' && spec.rule !== undefined && canonicalRule(String(spec.rule)) !== rule) {
      return { ok: false, findings: [{ code: 'EFFECT_CHECKER_SPEC_RULE_MISMATCH', message: `规格文件的 rule=${JSON.stringify(spec.rule)} 与提案的 rule=${rule} 不一致（防止把 A 的检查器挂到 B 上）` }], candidate: null, additions: null };
    }
    const binding = {
      kind: 'checker',
      rule,
      command: spec.command,
      expectRed: spec.expectRed,
      expectGreen: spec.expectGreen,
      redSample: spec.redSample,
      ...(spec.greenSample === undefined ? {} : { greenSample: spec.greenSample }),
      ...(spec.sampleHash === undefined ? {} : { sampleHash: spec.sampleHash }),
      ...(spec.checkerVersion === undefined ? {} : { checkerVersion: spec.checkerVersion }),
      ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
      ...(typeof spec.notes === 'string' && spec.notes.trim() !== '' ? { notes: spec.notes.trim() } : {}),
      proposal: proposal.id ?? null,
      activatedAt: now.toISOString(),
    };
    const shapeProblems = validateCheckerBinding(binding);
    if (shapeProblems.length > 0) {
      return { ok: false, findings: shapeProblems.map((p) => ({ code: 'EFFECT_CHECKER_SPEC_INVALID', message: `${rule}: 规格文件构造出的绑定形状不合法：${p}` })), candidate: null, additions: null };
    }
    // 样本固定：规格里写了 sampleHash 就必须与**当前**样本一致，否则落盘的是"签给旧样本的判据"
    if (typeof binding.sampleHash === 'string' && binding.sampleHash !== '') {
      const sampleAbs = join(opts.projectRoot ?? process.cwd(), binding.redSample.source);
      const actual = treeHash(sampleAbs);
      if (actual === null) {
        return { ok: false, findings: [{ code: 'EFFECT_CHECKER_SAMPLE_MISSING', message: `${rule}: 违规样本目录不存在: ${binding.redSample.source}` }], candidate: null, additions: null };
      }
      if (actual.toLowerCase() !== binding.sampleHash.toLowerCase()) {
        return { ok: false, findings: [{ code: 'EFFECT_CHECKER_SAMPLE_CHANGED', message: `${rule}: 规格里的 sampleHash 与当前样本内容不一致（样本被改过）⇒ 拒绝落盘，须重算并重签规格` }], candidate: null, additions: null };
      }
    }
    const already = (Array.isArray(before.checks) ? before.checks : [])
      .map((e) => normalizeBinding(e))
      .some((b) => b !== null && b.rule === rule && b.kind === 'checker');
    if (already) {
      return { ok: false, findings: [{ code: 'EFFECT_CHECKER_ALREADY_BOUND', message: `${rule}: 已有 checker 绑定（避免重复挂同一判据；要先退役再改）` }], candidate: null, additions: null };
    }
    const candidate = {
      ...before,
      checks: [...(Array.isArray(before.checks) ? before.checks : []), binding],
    };
    return {
      ok: true,
      kind: 'activate-checker',
      findings: [],
      rule,
      gate,
      carriers: [],
      falsePositive: null,
      patterns: [],
      additions: { patterns: [], binding },
      candidate,
      spec: ce.value,
    };
  }

  if (ce.kind === 'path') {
    if (!isRelativeCarrier(ce.value)) problems.push(`counterExample 的载体必须是**项目根相对路径**（收到 ${ce.value}：绝对路径或 .. 段会把保护面伸到项目之外，且不可跨机复现）`);
    else carriers.push(ce.value);
  } else problems.push(`counterExample 缺 path: 载体（${ce.reason}）`);
  const fp = parseCarrier(proposal.falsePositiveSurface);
  const falsePositive = fp.kind === 'path' && isRelativeCarrier(fp.value) ? fp.value : null;
  if (problems.length > 0) return { ok: false, findings: problems.map((p) => ({ code: 'EFFECT_VERIFY_UNCARRIED', message: p })), candidate: null, additions: null };

  const patterns = Array.isArray(opts.patterns) && opts.patterns.length > 0
    ? opts.patterns.map((p) => toPosix(String(p).trim().replace(/^\.\//, ''))).filter((p) => p !== '')
    : carriers.map((c) => toPosix(c));
  const existing = new Set((Array.isArray(before.protected_paths) ? before.protected_paths : []).map((p) => String(p)));
  const addPatterns = patterns.filter((p) => !existing.has(p));
  // 覆盖该 carrier 的**既有**保护面模式（本次没新增时，靠它把"谁在拦"写进绑定）
  const protection = effectiveProtection(landingDir);
  const key = carriers[0].toLowerCase();
  const covering = protection.patterns
    .map((p) => toPosix(String(p).trim().replace(/^\.\//, '')))
    .filter((p) => p !== '' && patternHits(p, key, opts.projectRoot ?? process.cwd()));
  const declaredPatterns = addPatterns.length > 0 ? addPatterns : covering;
  const binding = {
    kind: 'file_untracked_change',
    rule,
    carrier: carriers[0],
    falsePositive,
    gate,
    // `patterns` = **实际覆盖 carrier 的保护面模式**（新增的优先；本次没新增就用既有覆盖它的那条）。
    // 反事实验证只摘这些模式 ⇒ 若摘完仍判红，说明拦住它的是**别的**东西（挂名绑定，必须报红）。
    // 若既不新增、也没有任何既有模式覆盖该 carrier，则 patterns=[] ⇒ 验证判 `EFFECT_COUNTERFACTUAL_UNDECLARED`
    // （fail-closed：没有可隔离的拦截，就不许声称"这条判据拦住了它"）。
    patterns: declaredPatterns,
    proposal: proposal.id ?? null,
    activatedAt: now.toISOString(),
  };
  const candidate = {
    ...before,
    protected_paths: [...(Array.isArray(before.protected_paths) ? before.protected_paths : []), ...addPatterns],
    checks: [...(Array.isArray(before.checks) ? before.checks : []), binding],
  };
  return {
    ok: true,
    kind: 'activate',
    findings: [],
    rule,
    gate,
    carriers,
    falsePositive,
    patterns,
    additions: { patterns: addPatterns, binding },
    candidate,
    before,
  };
}

/**
 * **唯一**写 `rules.json` 的通路（LF-A40）。默认 dry-run；`apply=true` 才落盘。
 *
 * 红线与失败语义：
 *   · `by !== 'human'` ⇒ 拒绝（`EFFECT_HUMAN_SIGNATURE_REQUIRED`，exit≠0）
 *   · 写入顺序：备份 → 写临时件 → 回读校验（sha256 + validateRules）→ 原子替换 → 回读复核
 *   · 任一步失败 ⇒ **回滚**（从备份逐字节还原）并如实报告；**不留半成品**
 *
 * @param {{landingDir: string, projectRoot?: string, proposalId: string, by: string, patterns?: string[],
 *          gate?: string, apply?: boolean, now?: Date}} opts
 */
export function applyActivation(opts = {}) {
  const landingDir = opts.landingDir;
  const by = opts.by;
  const now = opts.now ?? new Date();
  const apply = opts.apply === true;
  const steps = [];
  const fail = (code, message, extra = {}) => ({ ok: false, code, message, steps, applied: false, ...extra });
  if (typeof landingDir !== 'string' || landingDir.trim() === '') return fail('EFFECT_NO_LANDING', 'applyActivation 需要 landingDir');
  if (by !== 'human') return fail('EFFECT_HUMAN_SIGNATURE_REQUIRED', `rules.json 只能由人签字写入（收到 by=${JSON.stringify(by)}）；auto 一律拒绝——闸门本身不可被 AI 直接改`);
  // ── 锚定式人签字（2026-09-19）──────────────────────────────────────────────────────
  // `--by human` 只是字符串（规则 43 自曝）。这里把"确实问过真人"的**凭证**变成落盘的前置条件：
  //   · 给了凭证 ⇒ 校验；decision=reject ⇒ **直接拒写**（人说不，就不写）
  //   · 落点配了 `requireAnchoredApproval: true` ⇒ 没有合法规格凭证一律拒（EFFECT_APPROVAL_NOT_ANCHORED）
  // 凭证由 `src/approval.mjs` 定义与校验；唯一会去问真人的是插件工具 `rulekeeper_apply`
  // （它拿得到 `ctx.userQuestions`，而子代理调那条通道会被宿主判 `DELEGATED_CALLER`）。
  const approval = opts.approval ?? null;
  const approvalProblems = approval === null ? [] : validateAnchoredApproval(approval);
  if (approvalProblems.length > 0) {
    return fail('EFFECT_APPROVAL_INVALID', `审批凭证不合法，拒绝落盘：${approvalProblems.join('；')}`);
  }
  if (approval !== null && approval.decision === 'reject') {
    return fail('EFFECT_APPROVAL_REJECTED', `真人应答为"拒绝"（${approval.questionId}）⇒ 不写任何东西`);
  }
  const requireAnchored = opts.requireAnchored === true || requireAnchoredApprovalOf(landingDir);
  // **只在真写时强制**（2026-09-19 自查修正）：`--apply` 缺省是 dry-run，dry-run **不写任何东西**，
  //   拦它只会让操作者"连准备写什么都没看到就被要求先签字"。故：dry-run 允许无锚定（但仍拦伪造凭证与已拒绝的应答）。
  if (requireAnchored && approval === null && apply === true) {
    return fail('EFFECT_APPROVAL_NOT_ANCHORED', '本落点要求**锚定式**人签字（requireAnchoredApproval=true）：`--by human` 只是声明，真写必须带"问过真人"的凭证（插件工具 rulekeeper_apply）；只看不写的 dry-run 不受此限');
  }
  if (typeof opts.proposalId !== 'string' || opts.proposalId.trim() === '') return fail('EFFECT_NO_PROPOSAL', '需要 --proposal <id>');
  // **id 必须先过安全校验**（LF-270 的同族风险）：`proposalPath()` 会把 id 拼进文件名，
  // 含 `../` 或分隔符的 id 会让随后的 `renameSync` **写到落点之外**（读时会泄露落点外的文件）。
  if (!isSafeId(opts.proposalId)) {
    return fail('EFFECT_PROPOSAL_ID_UNSAFE', `提案 id 不安全（只允许 [A-Za-z0-9._-] 且禁 ".."）: ${JSON.stringify(opts.proposalId)}`);
  }

  const proposalFile = proposalPath(landingDir, opts.proposalId);
  if (!existsSync(proposalFile)) return fail('EFFECT_PROPOSAL_MISSING', `提案不存在: ${toPosix(proposalFile)}`);
  let proposal;
  try {
    proposal = JSON.parse(readFileSync(proposalFile, 'utf8'));
  } catch (err) {
    return fail('EFFECT_PROPOSAL_UNREADABLE', `提案不是合法 JSON: ${err?.message ?? String(err)}`);
  }
  const planned = planActivation({ landingDir, proposal, patterns: opts.patterns, gate: opts.gate, now, projectRoot: opts.projectRoot ?? process.cwd() });
  if (planned.ok !== true) {
    // **具体原因码必须活下来**（2026-09-19 实测）：以前只有 `EFFECT_PLAN_UNQUALIFIED` 一个大类码，
    // 于是"规格文件不存在""样本被改""rule 不一致"这些**可操作**的原因在 CLI 上全被拍平成一个码，
    // 操作者只能看到"不合格"。现在附带 `reasonCode`（= 第一条 finding 的码），CLI 单独打印。
    return fail('EFFECT_PLAN_UNQUALIFIED', planned.findings.map((f) => f.message).join('；'), {
      findings: planned.findings,
      reasonCode: planned.findings[0]?.code ?? null,
    });
  }
  // **不许凭空发明规则包**（独立 CR nit #15）：落点没有 rules.json 时，旧实现会用 `project:'unknown'` 兜底
  // 造出一份 —— 而 `project` 是"双本（项目级/用户级）"的判别依据，哨兵值会把落点身份冲掉。
  if (!existsSync(join(landingDir, 'rules.json'))) {
    return fail('EFFECT_RULES_MISSING', `落点没有 rules.json（先跑 dsh-rulekeeper init 建立规则包；本命令不发明 sentinel 值）: ${toPosix(join(landingDir, 'rules.json'))}`);
  }

  const rulesFile = join(landingDir, 'rules.json');
  const beforeSha = existsSync(rulesFile) ? sha256File(rulesFile) : null;
  const text = `${JSON.stringify(planned.candidate, null, 2)}\n`;
  if (apply !== true) {
    return {
      ok: true, applied: false, dryRun: true, rule: planned.rule, proposalId: opts.proposalId,
      additions: planned.additions, beforeSha, afterSha: createHash('sha256').update(text, 'utf8').digest('hex'), steps,
    };
  }

  // ── 跨进程互斥（对抗性 QA 1 号发现，2026-09-19）────────────────────────────────
  // 两个 `apply` 并发时，各自"读 rules.json → 改 → 原子替换"会互相覆盖：**两者都报成功**，
  // 而其中一次生效登记凭空消失（QA 实测：ledger 有 2 条生效登记、rules.json 只剩 1 条绑定、plan 仍报 pass）。
  // LF-170 的 `lock.mjs` 本就是为此存在（账本侧一直在用），写通路此前漏用了它。
  const lock = acquireLock(join(landingDir, 'rules.json.lock'));
  if (lock.ok !== true) return fail('EFFECT_LOCK_BUSY', `未能取得 rules.json 写锁（另一处正在写同一落点？）: ${lock.reason}`);
  try {
    return doWrite();
  } finally {
    releaseLock(lock);
  }

  /** 真正的写路径（**只在持锁时调用**）：备份 → 写临时件 → 回读校验 → 原子替换 → 回读复核 → 提案/账本 */
  function doWrite() {
    // ① 备份（缺文件时不备份：baseline 用 null 表示"新建"）
    let backupPath = null;
    if (existsSync(rulesFile)) {
      const b = backupFile(rulesFile, { landingDir, now });
      if (b.ok !== true) return fail('EFFECT_BACKUP_FAILED', `备份失败，未动 rules.json：${b.reason}`);
      backupPath = b.path;
      steps.push(`backup ${toPosix(backupPath)}`);
    }

    // ② 写临时件 + 回读校验（**先校验临时件**，通过才替换——"草稿产前用目标工具自己的校验器验形状"）
    const tmp = `${rulesFile}.tmp-${randomBytes(3).toString('hex')}`;
    try {
      writeFileSync(tmp, text, 'utf8');
    } catch (err) {
      return fail('EFFECT_WRITE_FAILED', `写临时件失败: ${err?.code ?? 'ERR'}: ${err?.message ?? ''}`);
    }
    const checked = readBackValidate(tmp, planned.candidate);
    if (checked.ok !== true) {
      rmSync(tmp, { force: true });
      return fail('EFFECT_TMP_INVALID', `临时件校验不通过（未替换生效文件）: ${checked.reason}`);
    }
    const afterSha = sha256File(tmp);
    if (beforeSha !== null && afterSha === beforeSha) {
      rmSync(tmp, { force: true });
      return fail('EFFECT_NO_CHANGE', '候选内容与现有 rules.json 逐字节相同（没有新增绑定）');
    }

    // ③ 原子替换 + ④ 回读复核
    try {
      renameSync(tmp, rulesFile);
    } catch (err) {
      rmSync(tmp, { force: true });
      return fail('EFFECT_RENAME_FAILED', `原子替换失败（原文件未改）: ${err?.code ?? 'ERR'}: ${err?.message ?? ''}`);
    }
    steps.push(`replace ${toPosix(rulesFile)}`);
    const reread = readBackValidate(rulesFile, planned.candidate);
    // 测试缝（与 cli.mjs 的 `_inject`、plugin 的 `faultInjection` 同族）：强制走"写后回读不一致"分支，
    // 用来实测**回滚**真的把字节还原了（否则回滚路径永远没人跑过 = 假安全感）。
    const forcedMismatch = opts._inject?.failAfterReplace === true;
    if (forcedMismatch || reread.ok !== true || sha256File(rulesFile) !== afterSha) {
      const rolled = rollback(rulesFile, backupPath);
      return fail('EFFECT_VERIFY_AFTER_WRITE', `写后回读不一致（已回滚=${rolled.ok}）: ${forcedMismatch ? '测试缝强制不一致' : (reread.reason ?? 'sha256 不符')}`, { rolledBack: rolled.ok === true, restoredSha: existsSync(rulesFile) ? sha256File(rulesFile) : null });
    }

    // ⑤ 提案状态 → approved（**只改 status 一个键**，形状不变；失败也要回滚 rules.json）
    const approved = writeProposalStatus(proposalFile, proposal);
    if (approved.ok !== true) {
      const rolled = rollback(rulesFile, backupPath);
      return fail('EFFECT_PROPOSAL_STATUS_FAILED', `提案状态写回失败（rules.json 已回滚=${rolled.ok}）: ${approved.reason}`);
    }
    steps.push(`proposal ${opts.proposalId} -> approved`);

    // ⑥ 生效登记 / **生效退役**（账本事件行；`record` 自带脱敏 + off 档零副作用）
    const isRetire = planned.kind === 'retire';
    const logged = ledgerRecord({
      rule: planned.rule,
      category: isRetire ? EFFECT_RETIRE_CATEGORY : EFFECT_EVENT_CATEGORY,
      problem: isRetire
        ? `EFFECT_RETIRE rule=${planned.rule} proposal=${opts.proposalId} removedPatterns=${planned.additions.retirement.removedPatterns.length} removedBindings=${planned.additions.retirement.removedBindings}`
        : (planned.kind === 'activate-checker'
          ? `EFFECT_ACTIVATE rule=${planned.rule} proposal=${opts.proposalId} kind=checker spec=${planned.spec ?? '-'} exitRed=${planned.additions.binding.expectRed?.exitCode} exitGreen=${planned.additions.binding.expectGreen?.exitCode}`
          : `EFFECT_ACTIVATE rule=${planned.rule} proposal=${opts.proposalId} patterns=${planned.additions.patterns.length} gate=${planned.gate}`),
      root_cause: isRetire
        ? '零信号窗口内主动不再拦（退役）：判据成本高于收益，或场景已消失'
        : '入账未生效：生效面此前没有绑定（rules.json 的 checks 无消费者）',
      solution: isRetire
        ? `checks 摘掉 ${planned.additions.retirement.removedBindings} 条绑定；protected_paths -= [${planned.additions.retirement.removedPatterns.join(', ')}]`
        : (planned.kind === 'activate-checker'
          ? `checks += [kind=checker spec=${planned.spec ?? '-'} command=${(planned.additions.binding.command ?? []).join(' ')} sample=${planned.additions.binding.redSample?.source ?? '-'}]`
          : `protected_paths += [${planned.additions.patterns.join(', ')}]；checks += [carrier=${planned.additions.binding.carrier}]`),
      mechanism: 'rules.json',
      evidence: [
        toPosix(rulesFile),
        ...(backupPath === null ? [] : [toPosix(backupPath)]),
        describeApproval(approval),
      ],
    }, { landingDir, now });
    steps.push(`ledger ${logged.ok === true ? (logged.entry?.id ?? 'ok') : `FAILED(${logged.reason})`}`);
    // ⑦ 回读复核（锁内最后一件事）：候选的 mode 必须与落点真实 mode 一致
    //    （`record` 在 mode=off 时会**零副作用**跳过 —— 那不是失败，但必须如实告知）
    return {
      ok: true,
      applied: true,
      dryRun: false,
      rule: planned.rule,
      proposalId: opts.proposalId,
      additions: planned.additions,
      beforeSha,
      afterSha,
      backup: backupPath === null ? null : toPosix(backupPath),
      ledger: logged.ok === true ? (logged.entry?.id ?? null) : null,
      ledgerWarning: logged.ok === true ? null : logged.reason,
      steps,
    };
  }
}

/** 写后/写前统一校验：能解析 + `validateRules` 过 + 关键字段与候选一致 */
function readBackValidate(file, candidate) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { ok: false, reason: `不是合法 JSON: ${err?.message ?? String(err)}` };
  }
  const report = loadRules(file);
  if (report.ok !== true) {
    return { ok: false, reason: `rules 校验不通过: ${(report.findings ?? []).map((f) => `${f.code}:${f.msg}`).join('；') || report.error}` };
  }
  if (JSON.stringify(parsed) !== JSON.stringify(candidate)) return { ok: false, reason: '回读内容与候选内容不一致' };
  return { ok: true, reason: null };
}

/** 回滚：从备份逐字节还原（无备份 ⇒ 删除新建的文件） */
function rollback(rulesFile, backupPath) {
  try {
    if (backupPath === null) {
      if (existsSync(rulesFile)) rmSync(rulesFile, { force: true });
      return { ok: true, reason: null };
    }
    copyFileSync(backupPath, rulesFile);
    const restored = sha256File(rulesFile);
    const backed = sha256File(backupPath);
    return { ok: restored === backed, reason: restored === backed ? null : `还原后 sha256 与备份不符（${restored} != ${backed}）` };
  } catch (err) {
    return { ok: false, reason: `${err?.code ?? 'ERR'}: ${err?.message ?? ''}` };
  }
}

/** 只把提案的 `status` 改成 approved（形状/其余字段逐字不动） */
function writeProposalStatus(proposalFile, proposal) {
  const next = { ...proposal, status: 'approved' };
  const keysBefore = Object.keys(proposal).sort().join(',');
  const keysAfter = Object.keys(next).sort().join(',');
  if (keysBefore !== keysAfter) return { ok: false, reason: `形状漂移（${keysBefore} -> ${keysAfter}）` };
  const text = `${JSON.stringify(next, null, 2)}\n`;
  const tmp = `${proposalFile}.tmp-${randomBytes(3).toString('hex')}`;
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, proposalFile);
    const back = JSON.parse(readFileSync(proposalFile, 'utf8'));
    if (back.status !== 'approved') return { ok: false, reason: `回读 status=${JSON.stringify(back.status)}` };
    return { ok: true, reason: null };
  } catch (err) {
    rmSync(tmp, { force: true });
    return { ok: false, reason: `${err?.code ?? 'ERR'}: ${err?.message ?? ''}` };
  }
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * 注入计划（LF-A50）：把"只写下来了"的纪律经 LF-430 的注入面变成**会话提醒**。
 * **零落点写入**（纯计算）；真正的投递由宿主/消费者决定（诚实边界：默认插件面不自动注入）。
 */
export function effectInjectPlan(opts = {}) {
  const landingDir = opts.landingDir;
  const now = opts.now ?? new Date();
  const maxPerSession = Number.isInteger(opts.maxPerSession) ? opts.maxPerSession : 5;
  if (typeof landingDir !== 'string' || landingDir.trim() === '') {
    return { ok: false, appended: [], dropped: [], ledgerOnly: [], findings: [{ code: 'EFFECT_NO_LANDING', message: 'effectInjectPlan 需要 landingDir' }] };
  }
  const plan = effectPlan({ landingDir, now });
  const want = plan.items
    .filter((i) => (i.state === 'none' || i.state === 'injected') && i.entries > 0)
    .sort((a, b) => (a.rule < b.rule ? -1 : 1));
  // **`inject` 绑定声明的 `fields` 必须真被消费**（2026-09-19 自审，规则 44 的正面用法）：
  // 此前 `rules.json` 里 inject 条目的 `fields` 只用于"状态判定"（有绑定 ⇒ injected），
  // 生成提醒时却被硬编码的通用字段取代 ⇒ 声明了却没人读（正是"已实现未生效"的同类形态）。
  // 现在：有 inject 绑定的纪律，提醒里用它自己声明的 target/wanted/reason。
  const bindings = ruleBindings(loadLandingRules(landingDir).rulesResult.rules);
  const candidates = want.map((i) => {
    const declared = bindings.get(i.rule)?.inject?.[0]?.fields ?? null;
    const fields = declared !== null && Object.keys(declared).length > 0
      ? { ...declared, rule: i.rule }
      : { rule: i.rule, target: 'rules.json', action: 'observe', wanted: '绑定判据或注入提醒', reason: '入账未生效' };
    return {
      rule: i.rule,
      problem: declared !== null
        ? `这条纪律已入账 ${i.entries} 次（state=${i.state}）：按它自己声明的注入面提醒一次。`
        : `这条纪律已入账 ${i.entries} 次但尚未绑定机械判据（state=${i.state}）：改动前先看它，别重复踩。`,
      fields,
    };
  });
  const out = injectPlan({ candidates, messages: [], delivered: 0, maxPerSession, now });
  return { ok: out.ok, appended: out.appended, dropped: out.dropped, ledgerOnly: out.ledgerOnly, findings: out.findings, candidates: candidates.length };
}

/** 写一条验证记录到 findings.jsonl（**该文件的第一个生产者**；off 档零副作用） */
export function appendVerification(landingDir, { rule, target, ok, evidence = [], now = new Date() }) {
  const gate = offGuard(landingDir, FINDINGS_FILE);
  if (gate.off) return { ok: true, skipped: true, reason: gate.finding.message };
  const row = {
    schema: SCHEMA_VERSION,
    ts: now.toISOString(),
    rule: canonicalRule(rule),
    severity: ok === true ? 'info' : 'error',
    target: String(target ?? ''),
    evidence: [...evidence.map(String), ok === true ? EFFECT_VERIFIED_MARK : EFFECT_FAILED_MARK],
    action: ok === true ? 'observe' : 'warn',
  };
  const scrubbed = redactValue(row);
  return appendLine(join(landingDir, FINDINGS_FILE), scrubbed.value, {});
}

// 注（2026-09-19 自审）：本模块此前还导出过 `EFFECT_SURFACES`（"生效面声明表"）与 `EFFECT_CHECK_KINDS`。
// 二者**没有任何生产消费者**（只有用例读），正是本模块要治的"已实现未生效"形态 —— 自己摆一张
// 没人读的"接线声明表"等于自欺，故删除：接线事实由 `rk-selfcheck` 的 **S9** 在**调用图**上机械判定。
