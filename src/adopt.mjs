// adopt.mjs —— **自动管线三段**（2026-09-21，交接 P2；把"入账 → 机制面 → 绑定 → 验证"接成一条命令行）
//
// 为什么要有它（现场症状，不是设计洁癖）：本仓落点 9 条纪律入账、`rules.json` 一个绑定都没有，
//   而体检只会说"入账未生效"——**没人知道下一步该干什么**。三处断点各自都好修，缺的是把它们串起来：
//     ① 接账：教训先要进**本仓落点**（训练账/项目账在别处）—— `rk-ledger import` 存在但没人跑
//     ② 机制面：新条目必须四选一（text/mechanized/guard/question），否则"我写了机械判据"这种自称也进账本
//     ③ 绑定：可机械化的类目要能**自动出草稿**（四要件 + counterExample + 红绿样本），人只做签字
//
// 诚实边界（必须一起读）：
//   · 本模块**绝不写** `rules.json`（唯一写通路仍是 `rk-effect apply --by human`）；它只产
//     `proposals/<id>.json`（草稿），且**不替人签字**。
//   · 草稿的**四要件不自动编**：`redCriteria` / `counterExample` / `falsePositiveSurface` /
//     `activationCheck` 全部由**规格文件里已有的实测事实**派生（命令、退出码、样本目录、验证命令行）。
//     规格文件缺失的类目宁可不产草稿（E1 实验：机器起草四要件的齐备率是 0/10，别假装能编）。
//   · 接账只跑**幂等**的 import；`--apply` 才写（默认 dry-run）。
//
// 归属：core 模块。零依赖：只用 node:*。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { MECHANISM_FACES, STATUS_EVENT_CATEGORY } from './ledger.mjs';
import { readLedger } from './ledger.mjs';
import { EFFECT_EVENT_CATEGORY, EFFECT_RETIRE_CATEGORY, ruleBindings } from './effect.mjs';
import { MUTATE_CATEGORY, foldMutates } from './ledger-mutate.mjs';
import { verifyGuardRef } from './authier.mjs';
import { loadLandingRules } from './rules.mjs';
import { buildProposal, writeProposal, listProposals } from './proposal.mjs';
import { canonicalRule } from './ruleid.mjs';
import { toPosix } from './platform/paths.mjs';

/** 规格文件默认搜索目录（项目根相对） */
export const DEFAULT_SPEC_DIRS = Object.freeze(['scripts/checkers', 'tools/rulekeeper/checkers']);

/**
 * 扫可机械化类目的**规格文件**并配对账本类目。
 *
 * 规格文件的形状见 SCHEMA.md 的 `checkerRef` 小节与 `scripts/checkers/*.spec.json`。
 * 配对判据是**规格自己的 `rule` 字段**（不是文件名）—— 防止"把 A 的检查器挂到 B 上"。
 *
 * @returns {{specs: object[], findings: object[]}}
 */
export function scanSpecs(projectRoot, { dirs = DEFAULT_SPEC_DIRS } = {}) {
  const specs = [];
  const findings = [];
  for (const dir of dirs) {
    const abs = join(projectRoot, dir);
    if (!existsSync(abs)) continue;
    let names;
    try {
      names = readdirSync(abs).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.spec.json')) continue;
      const rel = toPosix(join(dir, name).split(sep).join('/'));
      let spec;
      try {
        spec = JSON.parse(readFileSync(join(abs, name), 'utf8'));
      } catch (err) {
        findings.push({ code: 'ADOPT_SPEC_BAD_JSON', message: `${rel}: 不是合法 JSON（${String(err?.message ?? err)}）` });
        continue;
      }
      if (spec === null || typeof spec !== 'object' || typeof spec.rule !== 'string' || spec.rule.trim() === '') {
        findings.push({ code: 'ADOPT_SPEC_NO_RULE', message: `${rel}: 缺非空 rule（无法与账本类目配对）` });
        continue;
      }
      specs.push({ rel, rule: canonicalRule(spec.rule), spec, mtimeMs: statSync(join(abs, name)).mtimeMs });
    }
  }
  return { specs, findings };
}

/** 账本按 rule 聚合（条数 / 机制面取值分布 / 首末时间） */
export function mechanismStats(rows = []) {
  const byRule = new Map();
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const rule = canonicalRule(String(row.rule ?? ''));
    if (rule === '') continue;
    const cur = byRule.get(rule) ?? { rule, entries: 0, faces: new Map(), firstSeen: null, lastSeen: null };
    cur.entries += 1;
    const face = typeof row.mechanism === 'string' ? row.mechanism.trim() : '';
    cur.faces.set(face === '' ? '(空)' : face, (cur.faces.get(face === '' ? '(空)' : face) ?? 0) + 1);
    const ts = typeof row.ts === 'string' ? row.ts : null;
    if (ts !== null) {
      if (cur.firstSeen === null || ts < cur.firstSeen) cur.firstSeen = ts;
      if (cur.lastSeen === null || ts > cur.lastSeen) cur.lastSeen = ts;
    }
    byRule.set(rule, cur);
  }
  return byRule;
}

/**
 * 三段报告的**纯计算**部分（不写盘）。
 *
 * @param {{landingDir: string, projectRoot: string, now?: Date}} opts
 * @returns {{ok: boolean, stats: object, plans: object[], drafts: object[], findings: object[]}}
 */
export function adoptionReport(opts = {}) {
  const landingDir = opts.landingDir;
  const projectRoot = opts.projectRoot;
  const now = opts.now ?? new Date();
  const findings = [];
  if (typeof landingDir !== 'string' || landingDir === '') {
    return { ok: false, stats: {}, plans: [], drafts: [], findings: [{ code: 'ADOPT_NO_LANDING', message: 'adoptionReport 需要 landingDir' }] };
  }

  // ── 段②：机制面必填（四选一）────────────────────────────────────────────────
  // **事件行不参与这一段**：`rk-effect apply` 写的 `生效登记`/`生效退役` 行是**工具自己**记的事件
  // （`mechanism: 'rules.json'` = "写在哪个文件里"，不是人的机制面声明）。它们是**机制面的产物**，
  // 不是待登记的教训 —— 拿"教训须登记机制面"去判事件行属**对象错位**（与 ledger-live-verdict 里
  // "事件行的绝对路径不判红"同族）。绑定事实本身由 `rules.json` 承载，`rk-effect plan` 已单独判。
  const rows = readLedger(landingDir).values.filter((r) => r !== null && typeof r === 'object');
  const eventRows = rows.filter((r) => r.category === EFFECT_EVENT_CATEGORY || r.category === EFFECT_RETIRE_CATEGORY);
  // **先做读侧 fold**（P2，2026-09-21）：把 `rk mutate` 归档行的字段值应用回目标 id
  // ⇒ 消费方读到的是**改后**的值，不会出现"改了 mechanism、检查器还读旧值"的静默降级。
  const folded = foldMutates(rows);
  const lessonRows = folded.filter((r) => r.category !== EFFECT_EVENT_CATEGORY && r.category !== EFFECT_RETIRE_CATEGORY
    && r.category !== STATUS_EVENT_CATEGORY && r.category !== MUTATE_CATEGORY);
  const byRule = mechanismStats(lessonRows);
  // ── 段②b：`guard` 档必须点名靠哪个拦截，且那个拦截必须真的在（2026-09-21，交接第 2 步）──
  // 只写 `mechanism=guard` 是自称（规则 43 同族）；`guardRef` 的**存在性**在这里核（写入时已核过一次，
  // 但拦截可能被卸载 ⇒ 落点侧也要有"现在还成立吗"的读者面）。
  const guardRows = lessonRows.filter((r) => String(r.mechanism ?? '').trim() === 'guard');
  const guardIssues = [];
  for (const row of guardRows) {
    const id = String(row.id ?? '?');
    const ref = typeof row.guardRef === 'string' ? row.guardRef.trim() : '';
    if (ref === '') {
      guardIssues.push({ id, rule: String(row.rule ?? ''), code: 'ADOPT_GUARD_REF_MISSING', message: `${id}: mechanism=guard 但缺 guardRef（"我靠拦截面"没说靠哪个 ⇒ 自称）` });
      continue;
    }
    const verdict = verifyGuardRef(landingDir, ref);
    if (verdict.ok !== true) {
      guardIssues.push({ id, rule: String(row.rule ?? ''), code: 'ADOPT_GUARD_REF_STALE', message: `${id}: guardRef=${ref} 现在核不过（${verdict.code}）: ${verdict.reason}` });
    }
  }
  for (const g of guardIssues) findings.push(g);
  for (const [rule, info] of [...byRule.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    for (const [face, n] of info.faces) {
      if (!MECHANISM_FACES.includes(face)) {
        findings.push({
          code: 'ADOPT_MECHANISM_UNREGISTERED',
          rule,
          message: `${rule}: ${n} 条条目的 mechanism=${JSON.stringify(face)} 不是四选一（${MECHANISM_FACES.join('/')}）⇒ 机制面未登记（"没登记"等于"没生效"）`,
        });
      }
    }
  }

  // ── 段③：可机械化类目自动出绑定草稿 ──────────────────────────────────────────
  const rulesResult = loadLandingRules(landingDir).rulesResult;
  const bindings = ruleBindings(rulesResult.rules);
  const existingProposals = listProposals(landingDir).items;
  const openRules = new Set(existingProposals
    .filter((p) => p.status === 'proposed' || p.status === 'approved')
    .map((p) => canonicalRule(String(p.rule ?? ''))));
  const boundCheckerRules = new Set();
  for (const [rule, b] of bindings) {
    if ((b.checks ?? []).some((c) => c !== null && typeof c === 'object' && c.kind === 'checker')) boundCheckerRules.add(rule);
  }

  const { specs, findings: specFindings } = scanSpecs(projectRoot);
  for (const f of specFindings) findings.push(f);

  const drafts = [];
  const plans = [];
  for (const s of specs) {
    const info = byRule.get(s.rule);
    const bound = boundCheckerRules.has(s.rule);
    const hasOpen = openRules.has(s.rule);
    const decision = bound ? 'already-bound' : (hasOpen ? 'open-proposal' : 'draft');
    plans.push({ rule: s.rule, spec: s.rel, entries: info?.entries ?? 0, decision });
    if (decision !== 'draft') continue;

    // 四要件**从规格里已实测的事实派生**（不编）：命令、期望退出码、样本目录、验证命令行
    const cmd = Array.isArray(s.spec.command) ? s.spec.command.join(' ') : '(缺 command)';
    const red = s.spec.expectRed?.exitCode;
    const green = s.spec.expectGreen?.exitCode;
    const redSample = s.spec.redSample?.source ?? '(缺红样本)';
    const greenSample = s.spec.greenSample?.source ?? '(缺绿样本)';
    const quality = {
      redCriteria: `命中即红：${cmd} 在违规样本上退出码必须为 ${red}（合规样本上必须为 ${green}）。样本/命令都取自规格 ${s.rel}，规格改了必须重跑 verify。`,
      counterExample: `checker:${s.rel}`,
      falsePositiveSurface: `tree:${redSample} 是违规样本；误报面 = 合规样本 ${greenSample}`,
      activationCheck: `rk-effect verify --allow-exec --project <项目根>（先 apply 本提案）`,
    };
    const proposal = buildProposal({ rule: s.rule, quality, source: 'auto', now });
    drafts.push({ rule: s.rule, spec: s.rel, proposal });
  }

  const faceCount = { text: 0, mechanized: 0, guard: 0, question: 0, unregistered: 0 };
  for (const info of byRule.values()) {
    for (const [face, n] of info.faces) {
      if (Object.hasOwn(faceCount, face)) faceCount[face] += n;
      else faceCount.unregistered += n;
    }
  }

  return {
    ok: true,
    stats: {
      entries: lessonRows.length,
      eventRows: eventRows.length,
      rules: byRule.size,
      faceCount,
      specs: specs.length,
      drafts: drafts.length,
      alreadyBound: plans.filter((p) => p.decision === 'already-bound').length,
      openProposal: plans.filter((p) => p.decision === 'open-proposal').length,
    },
    plans,
    drafts,
    findings,
  };
}

/**
 * 把草稿写盘（`--apply` 才调）。**幂等**：已存在同 rule 的未决提案就不重复产（E2：重复条目有害）。
 * @returns {{written: object[], skipped: object[], findings: object[]}}
 */
export function writeDrafts(landingDir, drafts) {
  const written = [];
  const skipped = [];
  const findings = [];
  const open = new Set(listProposals(landingDir).items
    .filter((p) => p.status === 'proposed' || p.status === 'approved')
    .map((p) => canonicalRule(String(p.rule ?? ''))));
  for (const d of drafts) {
    if (open.has(d.rule)) {
      skipped.push({ rule: d.rule, reason: '已有未决/已批准提案' });
      continue;
    }
    const r = writeProposal(landingDir, d.proposal);
    if (r.ok === true) {
      written.push({ rule: d.rule, id: d.proposal.id, path: toPosix(r.path) });
      open.add(d.rule);
    } else {
      findings.push({ code: 'ADOPT_WRITE_FAILED', rule: d.rule, message: `${d.rule}: 提案写盘失败: ${r.reason}` });
    }
  }
  return { written, skipped, findings };
}
