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
import { backupFile } from './backup.mjs';
import { CHECK_KINDS } from './checks.mjs';
import { CLOSE_KNOWN_GATES, effectiveProtection, reconWrite } from './gate.mjs';
import { injectPlan } from './inject.mjs';
import { record as ledgerRecord, readLedger } from './ledger.mjs';
import { offGuard } from './mode.mjs';
import { toPosix } from './platform/paths.mjs';
import { listProposals, proposalPath, validateProposalQuality } from './proposal.mjs';
import { redactValue } from './redact.mjs';
import { canonicalRule } from './ruleid.mjs';
import { isProtected, loadLandingRules, loadRules } from './rules.mjs';
import { SCHEMA_VERSION } from './schema.mjs';

export const EFFECT_STATES = Object.freeze(['none', 'injected', 'mechanized', 'verified', 'recurred']);
/** 生效登记事件行的事务名（账本里的 `category`）：状态**派生**，不原地改历史行 */
export const EFFECT_EVENT_CATEGORY = '生效登记';
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

/**
 * 从自由文本里解析判据载体。
 * @returns {{kind: 'path'|'inline'|null, value: string|null, reason: string|null}}
 */
export function parseCarrier(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { kind: null, value: null, reason: '文本为空（没有载体标记）' };
  }
  const inline = /(?:^|[\s([{"'，。;；])inline\s*[:：]/i.test(text);
  if (inline) return { kind: 'inline', value: null, reason: 'inline: 载体不被支持（三类 check 都吃文件路径）' };
  const m = RE_CARRIER.exec(text);
  if (m === null) return { kind: null, value: null, reason: '没有 `path:<相对路径>` 载体标记（判据载体与事实必须一一对应）' };
  return { kind: 'path', value: toPosix(m[1].replace(/^\.\//, '')), reason: null };
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
    proposal: str(entry.proposal),
    activatedAt: str(entry.activatedAt),
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
  const out = new Map();
  const read = readLedger(landingDir);
  for (const row of read.values) {
    if (row === null || typeof row !== 'object') continue;
    if (row.category !== EFFECT_EVENT_CATEGORY) continue;
    if (typeof row.rule !== 'string' || row.rule.trim() === '') continue;
    const rule = canonicalRule(row.rule);
    const m = /proposal=([A-Za-z0-9._-]+)/.exec(String(row.problem ?? ''));
    const list = out.get(rule) ?? [];
    list.push({ rule, ts: typeof row.ts === 'string' ? row.ts : null, proposal: m === null ? null : m[1], evidence: Array.isArray(row.evidence) ? row.evidence : [] });
    out.set(rule, list);
  }
  return out;
}

/** 验证记录 → `rule -> [record]`（读 findings.jsonl；该文件此前**没有生产者**，本模块是第一个） */
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

/** 账本按 canonical rule 聚合（复发计数 / 首末时间 / 条目） */
export function ledgerGroups(landingDir) {
  const groups = new Map();
  const read = readLedger(landingDir);
  for (const row of read.values) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    if (typeof row.rule !== 'string' || row.rule.trim() === '') continue;
    if (row.category === EFFECT_EVENT_CATEGORY) continue; // 生效登记不是"又踩了一次"
    const rule = canonicalRule(row.rule);
    const g = groups.get(rule) ?? { rule, count: 0, firstSeen: null, lastSeen: null, variants: new Set() };
    g.count += 1;
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
    // **复发**：只在"生效之后"入账的同 rule 条目才算（生效前踩的坑是提案的来历，不算判据失效）
    const recurred = lastActivation === null ? 0 : (g.lastSeen !== null && g.lastSeen > lastActivation ? 1 : 0);
    const verified = vers.some((v) => v.passed === true);
    const openProposal = proposals.find((p) => typeof p.rule === 'string' && canonicalRule(p.rule) === rule && p.status === 'proposed') ?? null;

    let state;
    if (b.checks.length === 0 && b.inject.length === 0 && b.gates.length === 0) state = 'none';
    else if (b.checks.length === 0) state = 'injected';
    else if (recurred > 0) state = 'recurred';
    else if (verified) state = 'verified';
    else state = 'mechanized';

    // 空转闸（"已实现未生效"在**数据面**的对应物）：绑定的载体必须真被保护面覆盖，否则这条绑定是挂名
    const uncovered = [];
    for (const c of b.checks) {
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
    if (openProposal !== null) {
      findings.push({ code: 'EFFECT_PENDING_PROPOSAL', severity: 'info', rule, message: `${rule}: 有未决提案 ${openProposal.id}，等人签字后 effect apply` });
    }
    if (state === 'mechanized') {
      findings.push({ code: 'EFFECT_NOT_VERIFIED', severity: 'warn', rule, message: `${rule}: 已绑判据但没跑过 effect verify（无验证凭证）` });
    }
    if (state === 'recurred') {
      findings.push({ code: 'EFFECT_RECURRED_AFTER_ACTIVATION', severity: 'error', rule, message: `${rule}: 生效后（${lastActivation}）又踩了（${g.lastSeen}）——判据没拦住，须升级` });
    }
    if (state !== 'recurred' && lastActivation !== null) {
      const ageDays = (now.getTime() - Date.parse(lastActivation)) / 86400000;
      if (Number.isFinite(ageDays) && ageDays > staleDays) {
        findings.push({ code: 'EFFECT_STALE_NO_SIGNAL', severity: 'warn', rule, message: `${rule}: 生效 ${Math.floor(ageDays)} 天既没拦住过也没再复发（零信号），建议退役或收紧` });
      }
    }

    items.push({
      rule,
      state,
      entries: g.count,
      firstSeen: g.firstSeen,
      lastSeen: g.lastSeen,
      variants: [...g.variants].sort(),
      checks: b.checks.length,
      inject: b.inject.length,
      gates: b.gates.length,
      activations: acts.length,
      lastActivation,
      verified,
      recurredAfterActivation: recurred > 0,
      openProposal: openProposal === null ? null : openProposal.id,
    });
  }

  const counts = {};
  for (const s of EFFECT_STATES) counts[s] = items.filter((i) => i.state === s).length;
  return { items, findings, counts, ok: findings.every((f) => f.severity !== 'error'), landed: loaded.rulesResult.missing !== true };
}

/**
 * 生效验证三项（LF-A40；**驱动真实入口** `reconWrite`，不做纯函数自我验证）。
 *
 * ① **命中红**：载体在真实落点上必须被判红（gate write 面 deny）
 * ② **反事实唯一性**：把载体从**有效保护面**里摘掉（临时落点，内存外落盘）后，同一载体**必须转绿**
 *    —— 仍红 ⇒ 拦住它的**不是这条绑定**（是坏索引/别的发现）⇒ `EFFECT_CHECK_NOT_THE_STOPPER`（挂名生效）
 * ③ **误报面绿**：误报面样本在当前保护面下必须**不受保护**（判绿）
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
  // ④ 载体检查（**先于判定**：没有载体就不许声称"能验证"）
  if (binding.carrier === null) {
    findings.push({ code: 'EFFECT_VERIFY_UNCARRIED', message: `${binding.rule}: 绑定没有 carrier（判据载体与事实必须一一对应，缺载体 = 凭证不足）` });
    return { ok: false, binding, cases, findings };
  }
  const carrier = binding.carrier;

  // ① 命中红
  const hit = reconWrite({ projectRoot, landingDir, files: [carrier], phase: 'close' });
  const hitCodes = (hit.findings ?? []).map((f) => f.code);
  const hitOk = hit.ok === false;
  cases.push({ name: '命中红', expect: 'deny', got: hitOk ? 'deny' : 'allow', ok: hitOk, codes: hitCodes });
  if (!hitOk) findings.push({ code: 'EFFECT_VERIFY_NOT_HIT', message: `${binding.rule}: 载体 ${carrier} 在真实落点上**没被判红**（判据没拦住）` });

  // ② 反事实唯一性（临时落点：有效保护面里去掉覆盖该载体的模式）
  const counter = counterfactualRecon({ landingDir, projectRoot, carrier });
  cases.push({ name: '反事实唯一性', expect: 'allow', got: counter.ok === true ? 'allow' : 'deny', ok: counter.ok === true, codes: (counter.findings ?? []).map((f) => f.code) });
  if (counter.ok !== true) {
    findings.push({
      code: 'EFFECT_CHECK_NOT_THE_STOPPER',
      message: `${binding.rule}: 摘掉绑定后载体 ${carrier} **仍然判红** ⇒ 拦住它的不是这条判据（挂名生效）；残留发现：${(counter.findings ?? []).map((f) => f.code).join(',') || '(none)'}`,
    });
  }

  // ③ 误报面绿（advisory：误报面没有可用载体时只提示，不阻断——它是"面"的描述，常是自由文本）
  const fpText = typeof opts.falsePositive === 'string' && opts.falsePositive.trim() !== ''
    ? opts.falsePositive
    : (binding.falsePositive ?? '');
  if (fpText !== '') {
    const parsed = carrierPathOf(fpText);
    if (parsed.path === null) {
      findings.push({ code: 'EFFECT_FALSE_POSITIVE_UNCARRIED', message: `${binding.rule}: 误报面没有可用载体（既非 path: 标记、也不像相对路径），跳过绿态用例（${parsed.reason}）` });
    } else {
      const fp = reconWrite({ projectRoot, landingDir, files: [parsed.path], phase: 'close' });
      const fpOk = fp.ok === true;
      cases.push({ name: '误报面绿', expect: 'allow', got: fpOk ? 'allow' : 'deny', ok: fpOk, codes: (fp.findings ?? []).map((f) => f.code) });
      if (!fpOk) findings.push({ code: 'EFFECT_FALSE_POSITIVE', message: `${binding.rule}: 误报面样本 ${parsed.path} 被判红（误报）` });
    }
  }

  const ok = findings.every((f) => f.code === 'EFFECT_FALSE_POSITIVE_UNCARRIED');
  return { ok, binding, cases, findings };
}

/**
 * 反事实：临时落点里把载体从**有效保护面**摘掉，跑同一个 `reconWrite`（真实入口）。
 * **必须保住真实落点的证据基座**（`snapshots/index.jsonl` 等）：只改保护面、不改现场，
 * 否则"摘掉后判绿"可能只是因为我们把坏索引也一起丢了 ⇒ 假绿（本函数第一版就踩了这个坑）。
 */
function counterfactualRecon({ landingDir, projectRoot, carrier }) {
  const protection = effectiveProtection(landingDir);
  const key = carrier.toLowerCase();
  const keep = protection.patterns.filter((p) => {
    const cleaned = String(p).trim().replace(/^\.\//, '');
    return !patternHits(cleaned, key);
  });
  const tmp = mkdtempSync(join(tmpdir(), 'rk-effect-cf-'));
  try {
    for (const rel of ['rules.json', join('snapshots', 'index.jsonl')]) {
      const src = join(landingDir, rel);
      if (!existsSync(src)) continue;
      mkdirSync(dirname(join(tmp, rel)), { recursive: true });
      copyFileSync(src, join(tmp, rel));
    }
    // 用 config.json 承载"摘掉后的有效保护面"（effectiveConfig 中 config 优先）——保证反事实改的是**生效面**
    writeFileSync(join(tmp, 'config.json'), `${JSON.stringify({ schema: SCHEMA_VERSION, mode: protection.mode === 'off' ? 'off' : (protection.mode ?? 'observe'), protected_paths: keep }, null, 2)}\n`, 'utf8');
    return reconWrite({ projectRoot, landingDir: tmp, files: [carrier], phase: 'close' });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** 保护面模式是否命中某个 pathKey（复用 rules.mjs 的 globToRegExp 语义，单点不复制） */
function patternHits(pattern, pathKeyValue) {
  return isProtected(pathKeyValue, { protected_paths: [pattern] }, { projectRoot: process.cwd() }).protected === true;
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
  const carriers = [];
  const ce = parseCarrier(proposal.counterExample);
  if (ce.kind === 'path') carriers.push(ce.value);
  else problems.push(`counterExample 缺 path: 载体（${ce.reason}）`);
  const fp = parseCarrier(proposal.falsePositiveSurface);
  const falsePositive = fp.kind === 'path' ? fp.value : null;
  if (problems.length > 0) return { ok: false, findings: problems.map((p) => ({ code: 'EFFECT_VERIFY_UNCARRIED', message: p })), candidate: null, additions: null };

  const patterns = Array.isArray(opts.patterns) && opts.patterns.length > 0
    ? opts.patterns.map((p) => toPosix(String(p).trim().replace(/^\.\//, ''))).filter((p) => p !== '')
    : carriers.map((c) => toPosix(c));
  const loaded = loadLandingRules(landingDir);
  const before = loaded.rulesResult.rules ?? { schema: SCHEMA_VERSION, project: 'unknown', protected_paths: [], gates: [], checks: [], inject: [] };
  const existing = new Set((Array.isArray(before.protected_paths) ? before.protected_paths : []).map((p) => String(p)));
  const addPatterns = patterns.filter((p) => !existing.has(p));
  const binding = {
    kind: 'file_untracked_change',
    rule,
    carrier: carriers[0],
    falsePositive,
    gate,
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
  if (typeof opts.proposalId !== 'string' || opts.proposalId.trim() === '') return fail('EFFECT_NO_PROPOSAL', '需要 --proposal <id>');

  const proposalFile = proposalPath(landingDir, opts.proposalId);
  if (!existsSync(proposalFile)) return fail('EFFECT_PROPOSAL_MISSING', `提案不存在: ${toPosix(proposalFile)}`);
  let proposal;
  try {
    proposal = JSON.parse(readFileSync(proposalFile, 'utf8'));
  } catch (err) {
    return fail('EFFECT_PROPOSAL_UNREADABLE', `提案不是合法 JSON: ${err?.message ?? String(err)}`);
  }
  const planned = planActivation({ landingDir, proposal, patterns: opts.patterns, gate: opts.gate, now });
  if (planned.ok !== true) return fail('EFFECT_PLAN_UNQUALIFIED', planned.findings.map((f) => f.message).join('；'), { findings: planned.findings });

  const rulesFile = join(landingDir, 'rules.json');
  const beforeSha = existsSync(rulesFile) ? sha256File(rulesFile) : null;
  const text = `${JSON.stringify(planned.candidate, null, 2)}\n`;
  if (apply !== true) {
    return {
      ok: true, applied: false, dryRun: true, rule: planned.rule, proposalId: opts.proposalId,
      additions: planned.additions, beforeSha, afterSha: createHash('sha256').update(text, 'utf8').digest('hex'), steps,
    };
  }

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

  // ⑥ 生效登记（账本事件行；`record` 自带脱敏 + off 档零副作用）
  const logged = ledgerRecord({
    rule: planned.rule,
    category: EFFECT_EVENT_CATEGORY,
    problem: `EFFECT_ACTIVATE rule=${planned.rule} proposal=${opts.proposalId} patterns=${planned.additions.patterns.length} gate=${planned.gate}`,
    root_cause: '入账未生效：生效面此前没有绑定（rules.json 的 checks 无消费者）',
    solution: `protected_paths += [${planned.additions.patterns.join(', ')}]；checks += [carrier=${planned.additions.binding.carrier}]`,
    mechanism: 'rules.json',
    evidence: [toPosix(rulesFile), ...(backupPath === null ? [] : [toPosix(backupPath)])],
  }, { landingDir, now });
  steps.push(`ledger ${logged.ok === true ? (logged.entry?.id ?? 'ok') : `FAILED(${logged.reason})`}`);

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
  const candidates = want.map((i) => ({
    rule: i.rule,
    problem: `这条纪律已入账 ${i.entries} 次但尚未绑定机械判据（state=${i.state}）：改动前先看它，别重复踩。`,
    fields: { rule: i.rule, target: 'rules.json', action: 'observe', wanted: '绑定判据或注入提醒', reason: '入账未生效' },
  }));
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

/** 供 CLI/自检复用：本模块声明的生效面（每个面都必须有真实消费者） */
export const EFFECT_SURFACES = Object.freeze([
  { name: 'plan', consumer: 'bin/rk-effect.mjs' },
  { name: 'verify', consumer: 'bin/rk-effect.mjs' },
  { name: 'apply', consumer: 'bin/rk-effect.mjs' },
  { name: 'inject', consumer: 'bin/rk-effect.mjs' },
  { name: 'rulekeeper_effect', consumer: 'src/handlers.mjs' },
]);

export const EFFECT_CHECK_KINDS = Object.freeze([...CHECK_KINDS]);
