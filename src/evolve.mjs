// dsh-rulekeeper · LF-280/290/295 `evolve`：复发计数 → 自动提案（**只产提案**）
//
// 三步闭环里的最后一步（方案 §2）：
//   自动计数（LF-200 派生 recurrence）→ **自动提案**（本模块）→ 人批准后才写 rules.json（不在本轮范围）
//
// 硬边界（LF-280 判据）：本模块**不 import rules.json 的写入路径**，也不调用任何写 rules/config 的函数；
//   调用方（CLI）只**读** rules.json 求 sha256 作为"没被动过"的证据。
//   实证手段：测试比较 evolve 前后**整个落点（除 proposals/ 外）**的字节指纹。
//
// 归属：core 模块。零依赖：只用 node:*。

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { loadConfig } from './config.mjs';
import {
  DEFAULT_STALE_DAYS, EFFECT_EVENT_CATEGORY, EFFECT_RETIRE_CATEGORY, activationsFromLanding,
  hitsFromLanding, hitsOfRule, retireQualityOf, retirementsFromLanding, ruleBindings,
} from './effect.mjs';
import { loadLandingRules } from './rules.mjs';
import { readLedger } from './ledger.mjs';
import { canonicalRule } from './ruleid.mjs';
import {
  PROPOSAL_SOURCES, RECURRENCE_THRESHOLD,
  buildProposal, listProposals, validateProposalQuality, writeProposal,
} from './proposal.mjs';

/**
 * 跑一次进化：把"复发 ≥2 且质量要件齐备"的纪律变成提案。
 *
 * @param {object} opts
 * @param {string} opts.landingDir           落点（必需）
 * @param {Date}   [opts.now]                注入时钟（判据可复现）
 * @param {'auto'|'human'} [opts.source]     提案来源（升门禁时必须是 human）
 * @param {object} [opts.quality]            rule → 四要件（显式提供，缺一即不合格）
 * @param {boolean} [opts.escalateGate]      本次是否请求"升门禁"档（闸门变更）
 * @param {string|null} [opts.rule]          只处理这一条纪律（canonical 前先规范化）
 * @param {boolean} [opts.dryRun]            true = 只算不写
 * @returns {{ok: boolean, mode: string, ledgerEntries: number, candidates: object[],
 *            proposals: object[], skipped: object[], findings: object[], dryRun: boolean}}
 */
export function evolve(opts = {}) {
  const landingDir = opts.landingDir;
  const now = opts.now ?? new Date();
  const source = opts.source ?? 'auto';
  const quality = opts.quality ?? {};
  const escalateGate = opts.escalateGate === true;
  const wantRule = typeof opts.rule === 'string' && opts.rule.trim() !== '' ? canonicalRule(opts.rule) : null;
  const dryRun = opts.dryRun === true;
  /** 退役候选窗口（天）：>0 才产退役提案；默认 30 天（对齐 `DEFAULT_STALE_DAYS`），0 = 关闭 */
  const retireDays = opts.retireDays === undefined ? DEFAULT_STALE_DAYS
    : (Number.isInteger(opts.retireDays) && opts.retireDays >= 0 ? opts.retireDays : DEFAULT_STALE_DAYS);

  const findings = [];
  const proposals = [];
  const skipped = [];
  // 早期返回也要带 ledgerHealth（CLI 一律读它打 token；缺字段会 undefined 崩——实测踩到）
  const emptyHealth = { badLines: 0, oversized: 0, truncatedTail: false, missing: false, bytes: 0 };

  if (typeof landingDir !== 'string' || landingDir.trim() === '') {
    return { ok: false, mode: 'unknown', ledgerEntries: 0, ledgerHealth: emptyHealth, candidates: [], proposals, skipped,
      findings: [{ code: 'EVOLVE_NO_LANDING', message: 'evolve 需要 landingDir' }], dryRun };
  }
  if (!PROPOSAL_SOURCES.includes(source)) {
    return { ok: false, mode: 'unknown', ledgerEntries: 0, ledgerHealth: emptyHealth, candidates: [], proposals, skipped,
      findings: [{ code: 'EVOLVE_BAD_SOURCE', message: `source 非法：${source}（可选 ${PROPOSAL_SOURCES.join('|')}）` }], dryRun };
  }

  const config = loadConfig(landingDir);
  const mode = config?.mode ?? 'observe';
  if (mode === 'off') {
    // off 档 = 明确关停：不产提案、不报错（"关掉"不是"失败"）
    return { ok: true, mode, ledgerEntries: 0, ledgerHealth: emptyHealth, candidates: [], proposals, skipped,
      findings: [{ code: 'EVOLVE_SKIPPED_MODE_OFF', message: 'mode=off，按约定不产提案' }], dryRun };
  }

  const read = readLedger(landingDir);
  // 账本健康度必须显式上报（复核 B3 实测：坏行/半行会被静默丢弃 -> 复发数缩水而 exit=0，等于假绿）
  const ledgerHealth = {
    badLines: read.badLines,
    oversized: read.oversized,
    truncatedTail: read.truncatedTail === true,
    missing: read.missing === true,
    bytes: read.bytes,
  };
  // 只认"对象行"：数组（如 `[]`）也是 typeof 'object'，按条目计数会虚增（复核 B3 实测）
  const entries = read.values.filter((v) => v !== null && typeof v === 'object' && !Array.isArray(v));
  if (ledgerHealth.badLines > 0) {
    findings.push({ code: 'EVOLVE_LEDGER_BAD_LINES', message: `账本有 ${ledgerHealth.badLines} 条坏行/撕裂行被跳过——复发数可能缩水，先修账本再提案` });
  }
  if (ledgerHealth.truncatedTail) {
    findings.push({ code: 'EVOLVE_LEDGER_TRUNCATED_TAIL', message: '账本末行没有换行（半行，写入未完成）——最后一条记账被丢弃，复发数可能少 1' });
  }
  if (ledgerHealth.oversized > 0) {
    findings.push({ code: 'EVOLVE_LEDGER_OVERSIZED', message: `账本有 ${ledgerHealth.oversized} 条超长行（超过行长上限）——内容可能被撕裂` });
  }

  /**
   * 候选纪律：按 **canonical rule** 聚合再数复发。
   * 为什么不在 `deriveCounts` 上直接数：那个函数按**字面** rule 分组，于是
   * `FACT-WRITING` / `fact-writing` / `fact_writing` 会被算成 3 条各 1 次 —— 而它们是**同一条纪律**
   * （LF-220 的 `detectRuleDivergence` 正是为此存在）。实测：同族两种写法各 1 条时，字面计数得 0 个候选。
   * 聚合并保留 `variants`，让"这条纪律被写歪过"在提案里可见。
   */
  const groups = new Map();
  for (const entry of entries) {
    if (typeof entry.rule !== 'string' || entry.rule.trim() === '') continue;
    // **生效登记行不是"又踩了一次"**（独立 CR major #8）：`src/effect.mjs` 的 ledgerGroups 显式排除它，
    //   这里此前没排除 —— 同一个"复发"概念两处口径不一致，导致 apply 之后立即可被当"复发"，
    //   还把 `EFFECT_ACTIVATE …` 那句 problem 算成"另一个不同的坑"（distinctProblems 虚增）。
    if (entry.category === EFFECT_EVENT_CATEGORY) continue;
    if (entry.category === EFFECT_RETIRE_CATEGORY) continue;   // 退役行同样不是"又踩了一次"
    const key = canonicalRule(entry.rule);
    const g = groups.get(key) ?? { rule: key, count: 0, variants: new Set(), problems: new Set(), latestId: null, latestTs: '' };
    g.count += 1;
    g.variants.add(entry.rule);
    // `distinctProblems`：同一 rule 下 problem 文本的去重数。
    // 复核 S4 指出：canonical 聚合会把"同 rule 的两个毫不相干的坑"也算成复发 2；
    // 是否该把 problem 维度纳入候选阈值属产品裁决，故此处**只暴露事实**，不改阈值语义。
    if (typeof entry.problem === 'string' && entry.problem.trim() !== '') g.problems.add(entry.problem);
    const ts = typeof entry.ts === 'string' ? entry.ts : '';
    if (ts >= g.latestTs) { g.latestTs = ts; g.latestId = entry.id ?? null; }
    groups.set(key, g);
  }
  const counts = [...groups.values()]
    .filter((c) => c.count >= RECURRENCE_THRESHOLD)
    .filter((c) => wantRule === null || c.rule === wantRule)
    .sort((a, b) => (a.rule < b.rule ? -1 : 1));

  /**
   * 幂等键**细化**（LF-A60，2026-09-19）。此前用的是 `proposedRules()`——它把 `proposed` 与
   * **`approved`（= 已生效）** 一起当"已有提案"跳过。后果：一条纪律生效之后**又踩了**，
   * 本该立刻产"升级提案"的时刻被**静默吃掉**（`skipped` 里连痕迹都没有）。
   * 现在分三档：
   *   · 有 **未决**（proposed）提案 ⇒ 跳过（幂等，防重复问同一件事）
   *   · 已 **生效**（approved）且生效后**没再复发** ⇒ 跳过（判据还在守）
   *   · 已生效且**生效后又复发** ⇒ **继续产新提案**（升级：收紧判据/换机制/提高档位）
   */
  const proposalsNow = listProposals(landingDir).items;
  const openRules = new Set(proposalsNow.filter((p) => p.status === 'proposed').map((p) => canonicalRule(p.rule)));
  const approvedRules = new Set(proposalsNow.filter((p) => p.status === 'approved').map((p) => canonicalRule(p.rule)));
  const activations = activationsFromLanding(landingDir);
  const ledgerEntries = entries.length;

  for (const candidate of counts) {
    const rule = candidate.rule;
    const info = { rule, count: candidate.count, variants: [...candidate.variants].sort(), distinctProblems: candidate.problems.size, latestId: candidate.latestId };

    const proposal = buildProposal({ rule, quality: quality[rule] ?? quality[candidate.rule] ?? {}, source, now });
    // 顺序很要紧（实测教训）：**先判质量与闸门，再判幂等**。
    // 反了的话，"缺要件的候选"会被一条早已存在的提案挡住 -> 静默 exit=0，
    // LF-295 的红态（缺字段必须 exit≠0）在第二次运行时就会失效（本轮冒烟实测撞到）。
    const qualified = validateProposalQuality(proposal);
    if (!qualified.ok) {
      // LF-295 绿态判据：缺任一要件 -> exit≠0（且**不落盘**）
      findings.push({ code: 'PROPOSAL_QUALITY_MISSING', message: `${rule}: ${qualified.reason}` });
      skipped.push({ ...info, reason: 'UNQUALIFIED' });
      continue;
    }
    if (escalateGate && source === 'auto') {
      // LF-295 红态：要件齐全，但 auto 单独触发升门禁 -> 拒绝（闸门本身不可被 AI 直接改）
      findings.push({
        code: 'PROPOSAL_GATE_ESCALATION_REQUIRES_HUMAN',
        message: `${rule}: 升门禁（gate escalation）必须由人触发（--source human），auto 不得单独触发`,
      });
      skipped.push({ ...info, reason: 'GATE_ESCALATION_REQUIRES_HUMAN' });
      continue;
    }
    const activationTs = (() => {
      const list = activations.get(rule) ?? [];
      return list.length === 0 ? null : list.map((a) => a.ts ?? '').sort().pop();
    })();
    const recurredAfterActivation = activationTs !== null && candidate.latestTs !== '' && candidate.latestTs > activationTs;
    if (openRules.has(rule)) {
      skipped.push({ ...info, reason: 'EXISTING_PROPOSAL' });
      findings.push({ code: 'EVOLVE_SKIP_EXISTING_PROPOSAL', message: `${rule} 已有**未决**提案，跳过（幂等；同一条纪律不重复问）` });
      continue;
    }
    if (approvedRules.has(rule) && !recurredAfterActivation) {
      skipped.push({ ...info, reason: 'ALREADY_ACTIVE' });
      findings.push({ code: 'EVOLVE_SKIP_ALREADY_ACTIVE', message: `${rule} 已生效（approved）且生效后没再复发，跳过（判据还在守）` });
      continue;
    }
    if (recurredAfterActivation) {
      // 这是"生效后自动进化"的触发点：判据拦不住 ⇒ 必须升级（产新提案），而不是重复原样提案
      findings.push({
        code: 'EFFECT_RECURRED_AFTER_ACTIVATION',
        message: `${rule} 生效（${activationTs}）之后又复发（${candidate.latestTs}）⇒ 产**升级提案**（判据没拦住，原档位不够）`,
      });
    }

    if (dryRun) {
      proposals.push({ ...info, id: proposal.id, path: null, bytes: 0, written: false, proposal });
      continue;
    }
    const written = writeProposal(landingDir, proposal);
    if (!written.ok) {
      findings.push({ code: 'PROPOSAL_WRITE_FAILED', message: `${rule}: ${written.reason}` });
      skipped.push({ ...info, reason: 'WRITE_FAILED' });
      continue;
    }
    proposals.push({ ...info, id: proposal.id, path: written.path, bytes: written.bytes, written: true, proposal });
  }

  // 只有"真的出问题"才 exit≠0：跳过（幂等）/ off 档 / 生效后复发后**已产升级提案**，都是正常结局
  const BENIGN = new Set([
    'EVOLVE_SKIP_EXISTING_PROPOSAL', 'EVOLVE_SKIP_ALREADY_ACTIVE', 'EVOLVE_SKIPPED_MODE_OFF',
    'EFFECT_RECURRED_AFTER_ACTIVATION', 'EFFECT_RETIRE_CANDIDATE',
  ]);
  const ok = findings.every((f) => BENIGN.has(f.code));
  // ── 生效后自动进化②：**退役候选**（零信号 ⇒ 产退役提案；仍只产提案，不写 rules）──────────────
  const retireProposals = [];
  if (retireDays > 0) {
    const hits = hitsFromLanding(landingDir);
    const retirements = retirementsFromLanding(landingDir);
    const bindingsNow = ruleBindings(loadLandingRules(landingDir).rulesResult.rules);
    for (const rule of [...approvedRules].sort()) {
      if (openRules.has(rule)) continue;
      if ((retirements.get(rule) ?? []).length > 0) continue;
      const mine = bindingsNow.get(rule) ?? { checks: [] };
      if (mine.checks.length === 0) continue;
      const acts = activations.get(rule) ?? [];
      const lastAct = acts.length === 0 ? null : acts.map((a) => a.ts ?? '').sort().pop();
      if (lastAct === null) continue;
      const ageDays = (now.getTime() - Date.parse(lastAct)) / 86400000;
      if (!(ageDays > retireDays)) continue;
      const g = groups.get(rule) ?? null;
      if (g !== null && g.lastSeen !== null && g.lastSeen > lastAct) continue;   // 复发 ⇒ 该升级，不退役
      const stat = hitsOfRule({ rule, bindings: mine, hits });
      if (stat.closes > 0 || stat.carrierViolations > 0) continue;               // 有命中 ⇒ 判据仍在干活
      const quality = retireQualityOf({
        rule, binding: mine.checks[0], windowDays: retireDays,
        closes: stat.closes, carrierViolations: stat.carrierViolations, lastActivation: lastAct,
      });
      const proposal = buildProposal({ rule, quality, source, now });
      const qualified = validateProposalQuality(proposal);
      if (!qualified.ok) {
        findings.push({ code: 'PROPOSAL_QUALITY_MISSING', message: `${rule}: ${qualified.reason}` });
        continue;
      }
      if (dryRun) {
        retireProposals.push({ rule, id: proposal.id, written: false, proposal });
        continue;
      }
      const written = writeProposal(landingDir, proposal);
      if (!written.ok) {
        findings.push({ code: 'PROPOSAL_WRITE_FAILED', message: `${rule}: ${written.reason}` });
        continue;
      }
      retireProposals.push({ rule, id: proposal.id, written: true, path: written.path, windowDays: retireDays, ageDays: Math.floor(ageDays) });
      findings.push({
        code: 'EFFECT_RETIRE_CANDIDATE',
        message: `${rule}: 生效 ${Math.floor(ageDays)} 天零命中零复发（close=${stat.closes} carrier=${stat.carrierViolations}）⇒ 产**退役提案** ${proposal.id}（须人签字后 rk-effect apply 才真摘绑定）`,
      });
    }
  }
  return {
    ok, mode, ledgerEntries, ledgerHealth,
    candidates: counts.map((c) => ({ rule: c.rule, count: c.count, variants: [...c.variants].sort(), distinctProblems: c.problems.size })),
    proposals, retireProposals, skipped, findings, dryRun,
  };
}

/** 读某个文件的 sha256（用于 LF-280 的"rules.json 没被动过"证据）；不存在返回 null */
export function fileSha256(path) {
  if (!existsSync(path)) return null;
  // 只读不写：evolve 全程不打开任何写入句柄指向 rules.json（LF-280 的机械保证）
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export const RULES_FILE_NAME = 'rules.json';

export function rulesPathOf(landingDir) {
  return join(landingDir, RULES_FILE_NAME);
}
