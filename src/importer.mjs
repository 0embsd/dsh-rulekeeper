// dsh-rulekeeper · LF-210 旧账本导入（只读兼容 + rule 回填）
//
// 事实（2026-09-14 实测 .dsh-ai/lessons.json）：
//   · **468 条**（清单原写 455 —— 随会话增长，判据用实测数）
//   · 字段 13 个：id/ts/category/problem/root_cause/solution/verification/commit/source/status/
//     usage_count/last_used_at/effectiveness —— **没有 rule，也没有 evidence 数组**
//   · **468/468 的 rule 为空** ⇒ 回填是真活，不是形式
//   · status 分布 active 440 / superseded 22 / **fixed 6**（fixed 越出 LF-120 冻结枚举）
//   · 已存在重复 id：**L134**（导入必须报出，禁静默吞）
//
// 设计取舍：
//   ① **只读**旧账本（绝不改写它）——符合 LF-X6"只读兼容"
//   ② rule 回填用**显式词表 + 计分**（deterministic），命中不了则落 `CAT-<类别码>` 兜底，
//      并把"兜底数"与"歧义数"（top-2 同分）**写进报告**，不假装分类很准
//   ③ status 越出枚举的值**映射并计数上报**（不静默改写）
//   ④ 幂等：目标账本已有同 id 行则跳过（免重复导入）
//
// 归属：core 模块。零依赖：只用 node:*。

import { readFileSync } from 'node:fs';

import { normalizeEntry, readLedger, record } from './ledger.mjs';
import { canonicalRule, validateRuleId } from './ruleid.mjs';
import { SCHEMA_VERSION } from './schema.mjs';

/** 词表：每个族给一组**可审计**的关键词；命中计分，同分按规则名排序（确定性） */
export const RULE_VOCABULARY = Object.freeze([
  { rule: 'FACT-WRITING', keywords: ['事实写作', '未取证', '凭印象', '无证据', '未核实', '不核实', '取证'], note: '事实写作律：先取证再下结论' },
  { rule: 'PS-OUTPUT-STREAM', keywords: ['逗号', 'return ,@', 'unshift', 'Add-Member', 'LASTEXITCODE', '输出流'], note: 'PowerShell 输出流/管道陷阱' },
  { rule: 'PATH-SANITIZE', keywords: ['净化', '文件名', '路径分隔', '未净化', '伪目录'], note: '文件名/路径净化' },
  { rule: 'CRED-FRESHNESS', keywords: ['凭证时效', 'mtime', '时效律', '指纹'], note: '凭证时效与内容判据' },
  { rule: 'GATE-DISCIPLINE', keywords: ['门禁', 'pre-push', 'pre-commit', 'project-check'], note: '门禁纪律与绕过' },
  { rule: 'CROSS-PLATFORM', keywords: ['跨平台', 'CRLF', 'EOL', 'posix', '代码页'], note: '跨平台差异' },
  { rule: 'PROCESS-ORDER', keywords: ['顺序偏离', '先提交', '后审查', '跳步', '未过门'], note: '流程顺序' },
  { rule: 'CONCURRENCY-IO', keywords: ['并发', '原子', '丢更新', '撕裂', '锁句柄'], note: '并发/原子/锁' },
]);

/** 类别 → 兜底 rule 的英文码（LF-220 要求 rule 全 ASCII 大写） */
export const CATEGORY_CODES = Object.freeze({
  代码: 'CODE', 流程: 'PROC', 真机: 'DEVICE', 工具: 'TOOL', 环境: 'ENV', 验证: 'VERIFY',
  事实: 'FACT', 文档: 'DOC', 安全: 'SEC', 运维: 'OPS', 技术: 'TECH', 链路: 'LINK',
  部署: 'DEPLOY', CI: 'CI', 测试: 'TEST',
});

/** status 映射（LF-120 冻结枚举 active|superseded|archived）；越界值会被计数上报 */
export const STATUS_MAP = Object.freeze({ active: 'active', superseded: 'superseded', archived: 'archived', fixed: 'active' });
export const STATUS_OUT_OF_ENUM = Object.freeze(['fixed']);

export function loadLegacy(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed?.entries)) return { ok: false, entries: [], error: '缺少 entries 数组' };
    return { ok: true, entries: parsed.entries, schema: parsed.schema ?? null, note: parsed.note ?? null, error: null };
  } catch (err) {
    return { ok: false, entries: [], error: `${err.code ?? 'ERR'}: ${err.message}` };
  }
}

/** 计分式 rule 推断（确定性 + 可解释） */
export function inferRule(entry, opts = {}) {
  const vocabulary = opts.vocabulary ?? RULE_VOCABULARY;
  const haystack = [entry.problem, entry.root_cause, entry.solution, entry.verification, entry.category]
    .map((v) => String(v ?? ''))
    .join(' ');
  const scored = [];
  for (const family of vocabulary) {
    const hits = family.keywords.filter((k) => haystack.includes(k));
    if (hits.length > 0) scored.push({ rule: canonicalRule(family.rule), score: hits.length, hits });
  }
  scored.sort((a, b) => (b.score - a.score) || (a.rule < b.rule ? -1 : 1));
  if (scored.length === 0) {
    const code = CATEGORY_CODES[String(entry.category ?? '').trim()] ?? 'UNCLASSIFIED';
    return { rule: `CAT-${code}`, matched: [], fallback: true, ambiguous: false, runnerUp: null };
  }
  const top = scored[0];
  const ambiguous = scored.length > 1 && scored[1].score === top.score;
  return { rule: top.rule, matched: top.hits, fallback: false, ambiguous, runnerUp: ambiguous ? scored[1].rule : null };
}

/** 旧条目 → LF-120 冻结字段行（problem/solution **逐字**保留；evidence 由 verification/commit/source 组成） */
export function mapLegacyEntry(entry, opts = {}) {
  const now = opts.now ?? new Date();
  const ts = typeof entry.ts === 'string' && entry.ts.trim() !== '' ? entry.ts : now.toISOString();
  const evidence = [entry.verification, entry.commit, entry.source]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => v !== '');
  const inferred = inferRule(entry, opts);
  const rawStatus = String(entry.status ?? '').trim();
  return {
    entry: {
      schema: SCHEMA_VERSION,
      id: String(entry.id ?? ''),
      ts,
      rule: inferred.rule,
      category: String(entry.category ?? ''),
      problem: String(entry.problem ?? ''),
      root_cause: String(entry.root_cause ?? ''),
      solution: String(entry.solution ?? ''),
      evidence,
      mechanism: 'text',
      recurrence: 1,
      first_seen: ts,
      last_seen: ts,
      status: STATUS_MAP[rawStatus] ?? 'active',
    },
    inferred,
    statusRemapped: STATUS_OUT_OF_ENUM.includes(rawStatus),
  };
}

/**
 * 导入：只读旧账本 → 逐条映射 → 追加进目标 ledger（已有同 id 则跳过）。
 * @returns {{ok: boolean, total: number, imported: number, skippedExisting: number, findings: object[], ruleHistogram: object[], fallbackCount: number, ambiguous: object[], statusRemapped: number, duplicateIds: string[], invalidRules: object[], error: string|null}}
 */
export function importLedger(opts = {}) {
  const { legacyFile, landingDir } = opts;
  const now = opts.now ?? new Date();
  const out = {
    ok: false, total: 0, imported: 0, skippedExisting: 0, skippedInvalid: 0, findings: [],
    ruleHistogram: [], fallbackCount: 0, ambiguous: [], statusRemapped: 0,
    duplicateIds: [], invalidRules: [], invalidIds: [], invalidReasons: [], error: null,
  };
  if (typeof legacyFile !== 'string' || typeof landingDir !== 'string') {
    out.error = 'importLedger 需要 legacyFile 与 landingDir';
    return out;
  }
  const legacy = loadLegacy(legacyFile);
  if (!legacy.ok) {
    out.error = `读取旧账本失败: ${legacy.error}`;
    return out;
  }
  const existingIds = new Set(readLedger(landingDir).values.map((e) => e?.id).filter((v) => typeof v === 'string'));

  const seenLegacyIds = new Set();
  const histogram = new Map();
  for (const raw of legacy.entries) {
    out.total += 1;
    const id = String(raw?.id ?? '');
    if (id !== '' && seenLegacyIds.has(id)) {
      out.duplicateIds.push(id);
      out.findings.push({ level: 'warn', code: 'IMPORT_DUPLICATE_ID', msg: `旧账本内 id 重复，保留首条、跳过后续: ${id}` });
      continue;
    }
    seenLegacyIds.add(id);
    if (id !== '' && existingIds.has(id)) {
      out.skippedExisting += 1;
      continue;
    }
    const mapped = mapLegacyEntry(raw, { now, vocabulary: opts.vocabulary });
    // 用与 record 完全相同的校验（单一权威）：legacy 里确实存在缺 root_cause 的条目（实测 83 条），
    // 这类行**不能**编出来（禁凭空补内容）-> 显式跳过并逐条列出，绝不静默丢（2026-09-14 实测）
    const pre = normalizeEntry(mapped.entry, { now });
    if (!pre.ok) {
      out.skippedInvalid += 1;
      out.invalidIds.push(id);
      out.invalidReasons.push({ id, problems: pre.problems });
      continue;
    }
    const ruleCheck = validateRuleId(mapped.entry.rule);
    if (!ruleCheck.ok) out.invalidRules.push({ id, rule: mapped.entry.rule, reason: ruleCheck.reason });
    if (mapped.inferred.fallback) out.fallbackCount += 1;
    if (mapped.inferred.ambiguous) {
      out.ambiguous.push({ id, rule: mapped.inferred.rule, runnerUp: mapped.inferred.runnerUp });
    }
    if (mapped.statusRemapped) out.statusRemapped += 1;
    histogram.set(mapped.entry.rule, (histogram.get(mapped.entry.rule) ?? 0) + 1);

    if (opts.dryRun === true) {
      out.imported += 1;
      continue;
    }
    const written = record(mapped.entry, { landingDir, now });
    if (!written.ok) {
      out.findings.push({ level: 'error', code: 'IMPORT_WRITE_FAIL', msg: `写入失败 id=${id}: ${written.reason}` });
      continue;
    }
    out.imported += 1;
  }

  if (out.statusRemapped > 0) {
    out.findings.push({
      level: 'warn', code: 'IMPORT_STATUS_REMAPPED',
      msg: `${out.statusRemapped} 条 status 越出 LF-120 冻结枚举（fixed）-> 已映射为 active 并计数上报`,
    });
  }
  if (out.skippedInvalid > 0) {
    const byReason = new Map();
    for (const item of out.invalidReasons) {
      const key = item.problems.join('；');
      byReason.set(key, (byReason.get(key) ?? 0) + 1);
    }
    const detail = [...byReason.entries()].map(([k, v]) => `${k} × ${v}`).join(' / ');
    out.findings.push({
      level: 'warn', code: 'IMPORT_SKIPPED_INVALID_FIELD',
      msg: `${out.skippedInvalid} 条 legacy 条目缺必填字段（不能凭空补内容）-> 已跳过并逐条列出: ${detail}；ids=${out.invalidIds.slice(0, 20).join(',')}${out.invalidIds.length > 20 ? '…' : ''}`,
    });
  }
  if (out.fallbackCount > 0) {
    out.findings.push({ level: 'info', code: 'IMPORT_RULE_FALLBACK', msg: `${out.fallbackCount} 条未命中词表 -> 落 CAT-<类别码> 兜底` });
  }
  out.ruleHistogram = [...histogram.entries()].map(([rule, count]) => ({ rule, count })).sort((a, b) => b.count - a.count);
  out.ok = !out.findings.some((f) => f.level === 'error');
  return out;
}
