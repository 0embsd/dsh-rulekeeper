// dsh-rulekeeper · LF-2A0 `uncheckable` 强制实证（**先于判定**）
//
// 要治的病（方案 §4 的"不可机检被滥用成免责"，以及清单 LF-2A0 行）：
//   条目只要写一句 `mechanism: uncheckable（抓不到）` 就能免掉机械判据 —— 免责成本太低。
//   治法：`uncheckable` 必须附**实证声明**，三件套缺一不可：
//     ① 探针命令（probeCommand）—— 到底跑了什么
//     ② 探针的**非空输出**（probeOutput）—— 实际看到了什么（不许"抓不到""无"这类占位话）
//     ③ **正对照样本 + 其输出**（controlSample / controlOutput）—— 证明这台"仪器"不是永远说抓不到
//   再加两件：
//     ④ falsifier —— 什么情况下这个"不可机检"结论作废
//     ⑤ 有效期 —— decidedAt/expiresAt，窗口 ≤ 30 天；**再复发即失效**（同一纪律在结论后又出现 -> 判失效）
//
// 归属：core 模块。零依赖：只用 node:*。

import { canonicalRule } from './ruleid.mjs';
import { readLedger } from './ledger.mjs';
import { displayPath, readTextFile } from './checks.mjs';

/** LF-2A0 声明的必需字段（**字面量清单**：冻结判据不许从别处派生，见清单 §0.1 ⑥） */
export const UNCHECKABLE_REQUIRED = Object.freeze([
  'rule', 'probeCommand', 'probeOutput', 'controlSample', 'controlOutput', 'falsifier', 'decidedAt', 'expiresAt',
]);
/** 仪器"说了等于没说"的占位话：只有这些字样的输出不算实证 */
export const PLACEHOLDER_OUTPUTS = Object.freeze([
  '抓不到', '无法', '无', '没有', '空', 'none', 'n/a', 'na', 'null', 'undefined', '-', '—', '--', '?',
]);
/** 有效期上限（天）：清单 LF-2A0 = 30 天 */
export const UNCHECKABLE_MAX_DAYS = 30;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function isPlaceholder(text) {
  const t = text.trim().toLowerCase();
  return PLACEHOLDER_OUTPUTS.includes(t);
}

function parseTime(value) {
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function finding(code, message) {
  return { code, message };
}

/**
 * 找"结论之后又复发"的最大 ts（**再复发即失效**）。
 * 只看**同一条 canonical 纪律**（与 evolve 同口径：字面写法不同也算同一条，L481）。
 */
export function recurrenceAfter(landingDir, rule, decidedAt) {
  const read = readLedger(landingDir);
  const want = canonicalRule(rule);
  const bound = parseTime(decidedAt);
  let latest = null;
  for (const row of read.values) {
    if (row === null || typeof row !== 'object') continue;
    if (!isNonEmptyString(row.rule) || canonicalRule(row.rule) !== want) continue;
    if (typeof row.ts !== 'string') continue;
    const ts = parseTime(row.ts);
    if (ts === null || bound === null || ts <= bound) continue;
    if (latest === null || row.ts > latest) latest = row.ts;
  }
  return latest;
}

/**
 * 校验一份 `uncheckable` 实证声明。
 * @param {object} decl 声明对象
 * @param {{file?: string, projectRoot?: string, now?: Date, maxDays?: number, landingDir?: string|null}} opts
 * @returns {{kind: string, ok: boolean, verdict: string, detail: object, findings: object[]}}
 */
export function validateUncheckableDeclaration(decl, opts = {}) {
  const now = opts.now ?? new Date();
  const maxDays = Number.isInteger(opts.maxDays) ? opts.maxDays : UNCHECKABLE_MAX_DAYS;
  const projectRoot = opts.projectRoot ?? process.cwd();
  const path = opts.file === undefined ? null : displayPath(opts.file, projectRoot);
  const findings = [];

  if (decl === null || typeof decl !== 'object' || Array.isArray(decl)) {
    return {
      kind: 'uncheckable_justified',
      ok: false,
      verdict: 'violation',
      detail: { path, type: Array.isArray(decl) ? 'array' : typeof decl },
      findings: [finding('UNCHECKABLE_NOT_OBJECT', '声明必须是 JSON 对象（"只有一句话"不算实证）')],
    };
  }

  // ① / ② / ③ / ④ / ⑤ 齐备性：正对照缺失单列一个码（清单红态点名要求）
  const missing = [];
  for (const field of UNCHECKABLE_REQUIRED) {
    if (!isNonEmptyString(decl[field])) missing.push(field);
  }
  for (const field of missing) {
    const isControl = field === 'controlSample' || field === 'controlOutput';
    findings.push(finding(
      isControl ? 'UNCHECKABLE_NO_CONTROL' : 'UNCHECKABLE_MISSING_FIELD',
      isControl
        ? `缺正对照（${field}）：没有正对照就无法证明"仪器不是永远说抓不到"`
        : `缺字段：${field}`,
    ));
  }

  // ② 非空输出 ≠ 有效输出：占位话不算实证
  for (const field of ['probeOutput', 'controlOutput']) {
    if (isNonEmptyString(decl[field]) && isPlaceholder(decl[field])) {
      findings.push(finding('UNCHECKABLE_PLACEHOLDER_OUTPUT',
        `${field} 只有占位话「${decl[field].trim()}」——不算实证（必须贴真实输出）`));
    }
  }

  // ⑤ 有效期：窗口 ≤ maxDays 且未过期
  let windowDays = null;
  let expired = null;
  const decided = isNonEmptyString(decl.decidedAt) ? parseTime(decl.decidedAt) : null;
  const expires = isNonEmptyString(decl.expiresAt) ? parseTime(decl.expiresAt) : null;
  if (decided === null || expires === null) {
    if (missing.includes('decidedAt') === false && missing.includes('expiresAt') === false) {
      findings.push(finding('UNCHECKABLE_BAD_WINDOW', 'decidedAt / expiresAt 不是可解析的时间'));
    }
  } else {
    windowDays = Math.round((expires - decided) / 86400000);
    if (expires <= decided) {
      findings.push(finding('UNCHECKABLE_BAD_WINDOW', `expiresAt 不晚于 decidedAt（${decl.decidedAt} -> ${decl.expiresAt}）`));
    } else if ((expires - decided) > maxDays * 86400000) {
      findings.push(finding('UNCHECKABLE_BAD_WINDOW', `有效期 ${windowDays} 天 > 上限 ${maxDays} 天`));
    }
    expired = now.getTime() > expires;
    if (expired) {
      findings.push(finding('UNCHECKABLE_EXPIRED', `有效期已过（expiresAt=${decl.expiresAt}，now=${now.toISOString()}）-> 结论作废，须重新实证`));
    }
  }

  // ⑤ 再复发即失效
  let recurredAt = null;
  if (isNonEmptyString(decl.rule) && isNonEmptyString(decl.decidedAt) && typeof opts.landingDir === 'string' && opts.landingDir !== '') {
    recurredAt = recurrenceAfter(opts.landingDir, decl.rule, decl.decidedAt);
    if (recurredAt !== null) {
      findings.push(finding('UNCHECKABLE_RECURRED',
        `同一纪律在结论之后又出现（${recurredAt} > ${decl.decidedAt}）-> "不可机检"结论失效`));
    }
  }

  const detail = {
    path,
    rule: isNonEmptyString(decl.rule) ? canonicalRule(decl.rule) : null,
    fields: {
      required: [...UNCHECKABLE_REQUIRED],
      missing: missing.slice().sort(),
    },
    window: {
      decidedAt: isNonEmptyString(decl.decidedAt) ? decl.decidedAt : null,
      expiresAt: isNonEmptyString(decl.expiresAt) ? decl.expiresAt : null,
      days: windowDays,
      maxDays,
    },
    expired,
    recurredAt,
    hasFalsifier: isNonEmptyString(decl.falsifier),
  };
  return {
    kind: 'uncheckable_justified',
    ok: findings.length === 0,
    verdict: findings.length === 0 ? 'pass' : 'violation',
    detail,
    findings,
  };
}

/** 从文件读声明（坏 JSON / 不可读 -> 明确的 violation，不抛裸异常） */
export function checkUncheckable(ctx = {}) {
  const file = ctx.file;
  const projectRoot = ctx.projectRoot ?? process.cwd();
  if (typeof file !== 'string' || file === '') {
    return {
      kind: 'uncheckable_justified', ok: false, verdict: 'violation',
      detail: { path: null }, findings: [finding('UNCHECKABLE_NO_FILE', '需要 --file <声明.json>')],
    };
  }
  const read = readTextFile(file);
  if (!read.ok) {
    return {
      kind: 'uncheckable_justified', ok: false, verdict: 'violation',
      detail: { path: displayPath(file, projectRoot), unreadable: read.reason },
      findings: [finding('UNCHECKABLE_FILE_UNREADABLE', `声明文件不可读（${read.reason}）: ${displayPath(file, projectRoot)}`)],
    };
  }
  let decl;
  try {
    decl = JSON.parse(read.text);
  } catch (err) {
    return {
      kind: 'uncheckable_justified', ok: false, verdict: 'violation',
      detail: { path: displayPath(file, projectRoot), parseError: err?.message ?? 'JSON 解析失败' },
      findings: [finding('UNCHECKABLE_BAD_JSON', `声明不是合法 JSON: ${err?.message ?? ''}`)],
    };
  }
  return validateUncheckableDeclaration(decl, { ...ctx, file, projectRoot });
}
