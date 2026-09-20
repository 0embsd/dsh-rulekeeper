// dsh-rulekeeper · LF-180 崩溃恢复 + doctor 自检
//
// 三件事：
//   ① 崩溃恢复的前提是**容错读**：半行/坏行不得让整文件读取失败（复用 LF-160 的 readLines）
//   ② doctor 把"账本是否可信"变成可机检结论：坏行、截断尾、超长行、重复 id、ts 非单调、
//      evidence 路径不存在、**行内写入不变式**（`recurrence` 恒 1 等，表在 schema.mjs）、
//      快照↔备份对账（有记录无备份 / 有备份无记录）、孤儿/超龄锁
//   ③ findings 分级：error（不可信，CLI exit 1）/ warn（可修复，默认放过，--strict 转 error）/ info
//
// 归属：core 模块。零依赖：只用 node:*。

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { validateActivation } from './annotations.mjs';
import { readLines } from './append.mjs';
import { backupDir } from './backup.mjs';
import { DEFAULT_STALE_MS, lockAgeMs } from './lock.mjs';
import { LEDGER_ROW_WRITE_INVARIANTS } from './schema.mjs';

const JSONL_FILES = ['ledger.jsonl', 'findings.jsonl', 'activations.jsonl', join('snapshots', 'index.jsonl')];

/**
 * 判断一个 evidence 字符串是否"形如**文件路径**"（只有这类才该做存在性检查）。
 *
 * 来历（两轮实测）：导入 468 条真实账本后，doctor 一度报 263 条 `DOCTOR_EVIDENCE_MISSING` 假警告——
 * 因为初版规则"含 `/` 即算路径"把 `Q1/Q4`、`AGENTS.md Q12/Q21 已机制化`、
 * `HK 空机真机：INSTALL_EXIT=0 / 容器 ActiveState=active …` 全当成了路径。
 *
 * 取值取向：**精度优先**（宁可漏检真实路径，也不刷屏假警告）——故要求：
 *   无空白 + 无 `=`/中文标点 + 末尾是已知扩展名（可带 `:行号` 尾巴）
 * 已知会漏检：路径里带空格（如 `docs/90-全局/会话里程碑-P1 地基（…）.md`）→ 按设计跳过。
 */
export function looksLikePath(value) {
  const s = String(value ?? '').trim();
  if (s === '') return false;
  if (/^https?:\/\//i.test(s)) return true;
  if (/\s/.test(s)) return false;
  if (s.length > 200) return false;
  if (/[=；，。！？、]/.test(s)) return false;
  const stripped = s.replace(/:\d+(-\d+)?$/, '').replace(/[),;]+$/, '');
  return /\.(md|txt|json|jsonl|go|ps1|mjs|cjs|js|sh|ya?ml|sha256|apk|bak|log|png|jpe?g|zip)$/i.test(stripped);
}

function push(findings, level, code, msg, extra = {}) {
  findings.push({ level, code, msg, ...extra });
}

/**
 * @param {{landingDir: string, projectRoot?: string, lockStaleMs?: number, nowMs?: number}} opts
 * @returns {{ok: boolean, findings: object[], summary: object}}
 */
export function doctor(opts = {}) {
  const landingDir = opts.landingDir;
  const projectRoot = opts.projectRoot ?? process.cwd();
  const lockStaleMs = opts.lockStaleMs ?? DEFAULT_STALE_MS;
  const findings = [];
  const summary = { files: {}, badLines: 0, truncatedTails: 0, entries: 0, locks: 0, backups: 0, nonPathEvidence: 0, rowViolations: 0 };
  if (typeof landingDir !== 'string' || landingDir.trim() === '') {
    push(findings, 'error', 'DOCTOR_NO_LANDING', 'doctor 需要 landingDir');
    return { ok: false, findings, summary };
  }

  // ── ① 逐文件读取健康 ───────────────────────────────────────────────
  const ledgerPath = join(landingDir, 'ledger.jsonl');
  for (const rel of JSONL_FILES) {
    const file = join(landingDir, rel);
    const read = readLines(file);
    summary.files[rel] = { entries: read.values.length, badLines: read.badLines, truncatedTail: read.truncatedTail, oversized: read.oversized, bytes: read.bytes };
    summary.badLines += read.badLines;
    if (read.truncatedTail) summary.truncatedTails += 1;
    if (read.missing) {
      push(findings, 'info', 'DOCTOR_FILE_MISSING', `${rel} 尚未创建（首次运行场景，非错误）`, { file: rel });
      continue;
    }
    if (read.error !== null) push(findings, 'error', 'DOCTOR_READ_ERROR', `${rel} 读取失败: ${read.error}`, { file: rel });
    // 分级关键：readLines.badLines 把"末尾半行"也算作坏行，但**语义不同**——
    //   中间损坏行 = 数据不可信（error）；末尾半行 = 崩溃残留、可截断修复（warn）。
    // 故这里把末尾半行从 BAD_LINES 里剔除，避免把可修复态升级成不可信态（2026-09-14 用例抓出）。
    const midFileBad = read.badLines - (read.truncatedTail ? 1 : 0);
    if (midFileBad > 0) {
      push(findings, 'error', 'DOCTOR_BAD_LINES', `${rel} 有 ${midFileBad} 行不是合法 JSON（中间损坏/撕裂，不含末尾半行）`, { file: rel, count: midFileBad });
    }
    if (read.truncatedTail) push(findings, 'warn', 'DOCTOR_TRUNCATED_TAIL', `${rel} 末尾是半行（崩溃残留，可截断修复）`, { file: rel });
    if (read.oversized > 0) push(findings, 'warn', 'DOCTOR_OVERSIZED', `${rel} 有 ${read.oversized} 行超过行长上限`, { file: rel, count: read.oversized });
    if (rel === 'ledger.jsonl') summary.entries = read.values.length;
  }

  // ── ② ledger 语义检查 ─────────────────────────────────────────────
  const ledger = readLines(ledgerPath);
  const seenIds = new Map();
  let lastTs = null;
  for (const [index, entry] of ledger.values.entries()) {
    if (entry === null || typeof entry !== 'object') continue;
    if (typeof entry.id === 'string') {
      if (seenIds.has(entry.id)) {
        push(findings, 'error', 'DOCTOR_DUP_ID', `ledger 第 ${index + 1} 行 id="${entry.id}" 与第 ${seenIds.get(entry.id)} 行重复`, { id: entry.id });
      } else {
        seenIds.set(entry.id, index + 1);
      }
    } else {
      push(findings, 'warn', 'DOCTOR_MISSING_ID', `ledger 第 ${index + 1} 行缺 id`, { index: index + 1 });
    }
    if (typeof entry.ts === 'string') {
      if (lastTs !== null && entry.ts < lastTs) {
        push(findings, 'warn', 'DOCTOR_TS_NOT_MONOTONIC', `ledger 第 ${index + 1} 行 ts=${entry.ts} 早于前一行 ${lastTs}`, { index: index + 1 });
      }
      lastTs = entry.ts;
    }
    if (typeof entry.rule === 'string' && entry.rule.trim() === '') {
      push(findings, 'warn', 'DOCTOR_EMPTY_RULE', `ledger 第 ${index + 1} 行 rule 为空`, { index: index + 1 });
    }
    // 行内写入不变式（2026-09-19）：`recurrence` 这类"行内恒为常数、聚合靠派生"的字段，
    // 一旦行内出现非常数，就说明有人把聚合写进了 append-only 行（LF-120 禁止的反面形态），
    // 或写入方口径变了 —— 两者都让"引用该字段的数字"不可信，故必须报出来（判据表在 schema.mjs）。
    for (const inv of LEDGER_ROW_WRITE_INVARIANTS) {
      if (inv.equals(entry)) continue;
      summary.rowViolations += 1;
      push(findings, inv.level, `DOCTOR_${inv.code}`, `ledger 第 ${index + 1} 行违反行内不变式 ${inv.field} ${inv.expect}（实测 ${JSON.stringify(entry[inv.field])}）：${inv.why}`, { index: index + 1, field: inv.field, value: entry[inv.field], invariant: inv.code });
    }
    const evidence = Array.isArray(entry.evidence) ? entry.evidence : [];
    for (const ref of evidence) {
      if (typeof ref !== 'string' || ref.trim() === '') continue;
      // 只对"看起来是路径/URL"的项做存在性检查：legacy 的 verification 常是自由文本
      // （实测 620 项里 357 项非路径，如 "AGENTS.md Q5 已机制化"）——对非路径项查"路径存在"是类别错误
      if (!looksLikePath(ref)) {
        summary.nonPathEvidence += 1;
        continue;
      }
      const candidates = [ref, resolve(projectRoot, ref)];
      if (!candidates.some((p) => existsSync(p))) {
        push(findings, 'warn', 'DOCTOR_EVIDENCE_MISSING', `ledger 第 ${index + 1} 行 evidence 路径不存在: ${ref}`, { index: index + 1, ref });
      }
    }
  }

  // ── ②b 注解层对账（activations.jsonl ↔ ledger.jsonl，2026-09-19 契约变更的配套检查）──────
  // 注解按 `id` 指向账本行；id 打错/账本被改写 ⇒ 注解就**永远不生效**（覆盖率读数却看不出来，
  // 因为它只数"有 activation 的行"）。这里把"孤儿注解"与"同一个 id 被注解多次"如实报出来。
  const annotationRead = readLines(join(landingDir, 'activations.jsonl'));
  const ledgerIds = new Set(ledger.values.filter((r) => r !== null && typeof r === 'object').map((r) => r.id).filter((v) => typeof v === 'string'));
  let annotationRows = 0;
  for (const [index, ann] of annotationRead.values.entries()) {
    if (ann === null || typeof ann !== 'object') continue;
    annotationRows += 1;
    const id = typeof ann.id === 'string' ? ann.id.trim() : '';
    if (id === '') {
      push(findings, 'warn', 'DOCTOR_ANNOTATION_NO_ID', `activations 第 ${index + 1} 行缺 id（指向账本行）`, { index: index + 1 });
      continue;
    }
    if (!ledgerIds.has(id)) {
      push(findings, 'warn', 'DOCTOR_ANNOTATION_ORPHAN', `activations 第 ${index + 1} 行指向不存在的账本 id: ${id}（注解永不生效）`, { index: index + 1, id });
    }
    const verdict = validateActivation(ann.activation);
    if (verdict.ok !== true) {
      push(findings, 'warn', 'DOCTOR_ANNOTATION_UNCHECKABLE', `activations 第 ${index + 1} 行的条件不可机械判定: ${verdict.reasons.join('；')}`, { index: index + 1, id });
    }
  }
  const byIdCount = new Map();
  for (const ann of annotationRead.values) {
    if (ann === null || typeof ann !== 'object' || typeof ann.id !== 'string') continue;
    byIdCount.set(ann.id, (byIdCount.get(ann.id) ?? 0) + 1);
  }
  summary.annotations = annotationRows;
  summary.annotationDuplicates = [...byIdCount.values()].filter((n) => n > 1).length;
  if (summary.annotationDuplicates > 0) {
    push(findings, 'info', 'DOCTOR_ANNOTATION_REDECLARED', `${summary.annotationDuplicates} 个账本 id 被注解多次（后写覆盖先写，历史仍保留在文件里）`, { count: summary.annotationDuplicates });
  }

  // ── ③ 快照 ↔ 备份 对账 ────────────────────────────────────────────
  const snapshots = readLines(join(landingDir, 'snapshots', 'index.jsonl'));
  const referenced = new Set();
  for (const [index, snap] of snapshots.values.entries()) {
    if (snap === null || typeof snap !== 'object') continue;
    if (typeof snap.backup !== 'string' || snap.backup.trim() === '') {
      push(findings, 'warn', 'DOCTOR_SNAPSHOT_NO_BACKUP_FIELD', `snapshots 第 ${index + 1} 行缺 backup 字段`, { index: index + 1 });
      continue;
    }
    referenced.add(snap.backup);
    const candidates = [snap.backup, resolve(projectRoot, snap.backup)];
    if (!candidates.some((p) => existsSync(p))) {
      push(findings, 'error', 'DOCTOR_BACKUP_ORPHAN', `有记录无备份：snapshots 第 ${index + 1} 行指向的备份不存在: ${snap.backup}`, { ref: snap.backup });
    }
  }
  const bdir = backupDir(landingDir);
  if (existsSync(bdir)) {
    for (const name of readdirSync(bdir)) {
      if (!name.endsWith('.bak')) continue;
      summary.backups += 1;
      const full = join(bdir, name);
      const matched = [...referenced].some((ref) => ref.endsWith(name) || ref.endsWith(`/${name}`) || ref === name);
      if (!matched) {
        push(findings, 'info', 'DOCTOR_BACKUP_UNREFERENCED', `有备份无记录（可能是 LF-190 的账本自备份，非错误）: ${name}`, { ref: name });
      }
    }
  }

  // ── ④ 孤儿 / 超龄锁 ───────────────────────────────────────────────
  for (const dir of [landingDir, bdir]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.lock')) continue;
      const path = join(dir, name);
      summary.locks += 1;
      const age = lockAgeMs(path, opts.nowMs);
      const stat = statSync(path);
      if (age !== null && age > lockStaleMs) {
        push(findings, 'warn', 'DOCTOR_LOCK_STALE', `超龄锁（年龄 ${Math.round(age)}ms > ${lockStaleMs}ms）：${path}（持锁进程可能已被杀）`, { path, ageMs: Math.round(age), lockPath: path });
      } else {
        push(findings, 'info', 'DOCTOR_LOCK_PRESENT', `存在锁文件（${stat.size} B，年龄 ${age === null ? '?' : Math.round(age)}ms）：${path}`, { path, lockPath: path });
      }
    }
  }

  const hasError = findings.some((f) => f.level === 'error');
  if (summary.nonPathEvidence > 0) {
    push(findings, 'info', 'DOCTOR_NON_PATH_EVIDENCE', `${summary.nonPathEvidence} 项 evidence 是自由文本（非路径）-> 按设计跳过存在性检查，仅计数`, { count: summary.nonPathEvidence });
  }
  return { ok: !hasError, findings, summary };
}

/** 供 CLI 复用：按 --strict 把 warn 也算失败 */
export function doctorExitCode(report, strict = false) {
  if (report.findings.some((f) => f.level === 'error')) return 1;
  if (strict && report.findings.some((f) => f.level === 'warn')) return 1;
  return 0;
}
