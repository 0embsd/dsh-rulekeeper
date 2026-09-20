// dsh-rulekeeper · LF-2B0 首次启用基线 + **账本自污染防护**
//
// 要治的两件事：
//   ① **首启刷屏**：工具第一次启用时若把"存量受保护文件"全报违规，用户看到的是满屏红（等于不能用）。
//      解法：首次启用先**建基线**（把当前 sha256 记进 `snapshots/index.jsonl`），之后 `verify` 的违规数必须是 **0**。
//   ② **账本自污染**：工具自己的产物（ledger/snapshots/logs/backups/proposals/config/rules）**每跑一次就变**，
//      若它们也被当成"受保护文件"记进基线，那么下一次 verify 必然报违规 -> 自己把自己判红（假红刷屏）。
//      解法：落点内的自产物一律**排除**，并显式计数上报（`RK_BASELINE_SELF_EXCLUDED`）。
//
// 契约：快照行**必须**符合 LF-120 冻结的 `snapshots/index.jsonl` 字段表
//   （schema / ts / path / sha256_before / sha256_after? / sha256_lf? / backup / why / job?），`path` 用 pathKey 形式
//   —— 这样 `rk-check untracked-change` 与 `rk-doctor` 的快照↔备份对账都能直接吃它，不需要第二套格式。
//   `sha256_lf`（G3）：基线的**行尾归一形态**（CRLF→LF；二进制为 null），供 `core.autocrlf=true` 时跨形态比对；
//   基线记录与快照记录都是 gate 的基线来源，故两边**必须**都写（只写一边 = 一半场景仍假红）。
//
// 归属：core 模块。零依赖：只用 node:*。

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { appendLine, readLines } from './append.mjs';
import { backupFile, sha256File } from './backup.mjs';
import { sha256LfOfBuffer } from './lineend.mjs';
import { pathKey, relativeToRoot, toPosix } from './platform/paths.mjs';
import { globToRegExp } from './rules.mjs';
import { SCHEMA_VERSION } from './schema.mjs';

export const SNAPSHOT_INDEX = 'snapshots/index.jsonl';
/** 落点内**自产物**（相对落点的前缀）：一律不进基线（进一次就自污染一次） */
export const SELF_ARTIFACT_PREFIXES = Object.freeze([
  'ledger.jsonl', 'findings.jsonl', 'activations.jsonl', 'config.json', 'rules.json',
  'snapshots/', 'logs/', 'backups/', 'proposals/',
]);
/** 单次基线最多处理的受保护文件数（防"glob 写太宽 -> 把整个仓库备一遍"） */
export const BASELINE_MAX_FILES = 200;

export function snapshotIndexPath(landingDir) {
  return join(landingDir, 'snapshots', 'index.jsonl');
}

/** 某路径是否落点内的自产物（relToProject 为相对项目根的 posix 路径） */
export function isSelfArtifact(relToProject, landingRel) {
  if (typeof relToProject !== 'string' || relToProject === '') return false;
  if (landingRel === null || landingRel === '') return false;
  const prefix = landingRel.endsWith('/') ? landingRel : `${landingRel}/`;
  if (!relToProject.startsWith(prefix) && relToProject !== landingRel) return false;
  const inner = relToProject === landingRel ? '' : relToProject.slice(prefix.length);
  if (inner === '') return true;
  return SELF_ARTIFACT_PREFIXES.some((p) => (p.endsWith('/') ? inner.startsWith(p) : inner === p));
}

/**
 * 遍历项目树（跳过 VCS/依赖目录——否则"扫全仓"这一步本身就很贵）。
 * 注意**不跳过** `.dsh-ai`：落点之外的 `.dsh-ai/*`（如凭证目录）是普通项目文件，
 * 而落点内的自产物由 `isSelfArtifact` 判定并**计数上报**（这样"排除了几个"是可核对的数字，不是静默跳过）。
 */
const WALK_SKIP = new Set(['.git', 'node_modules']);

function walkFiles(absDir, out, base) {
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    if (WALK_SKIP.has(entry.name)) continue;
    const abs = join(absDir, entry.name);
    if (entry.isDirectory()) walkFiles(abs, out, base);
    else if (entry.isFile()) out.push({ abs, rel: toPosix(relative(base, abs)) });
  }
}

/**
 * 展开 `rules.protected_paths` 为**具体文件**列表，并剔除落点自产物。
 * 目录模式（以 `/` 结尾）递归展开；其余按 glob 匹配文件路径。
 * @returns {{files: object[], excluded: string[], truncated: boolean}}
 */
export function expandProtected({ projectRoot, landingDir, rules, maxFiles = BASELINE_MAX_FILES }) {
  const patterns = Array.isArray(rules?.protected_paths) ? rules.protected_paths : [];
  const landingRel = relativeToRoot(landingDir, projectRoot);
  const all = [];
  walkFiles(projectRoot, all, projectRoot);
  const inLanding = (rel) => landingRel !== null && landingRel !== ''
    && (rel === landingRel || rel.startsWith(`${landingRel}/`));
  const matchers = patterns.map((p) => ({ p, re: globToRegExp(p) }));
  const files = [];
  const excluded = [];
  for (const f of all) {
    if (!matchers.some((m) => m.re.test(f.rel))) continue;
    // 双保险：即使 glob 写宽了（如 `.dsh-ai/**`），落点内的自产物也不进基线，且**计数上报**
    if (inLanding(f.rel)) {
      excluded.push(f.rel);
      continue;
    }
    files.push(f);
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  const truncated = files.length > maxFiles;
  return { files: truncated ? files.slice(0, maxFiles) : files, excluded: excluded.sort(), truncated };
}

/** 读快照索引（容错）：values 只保留对象行 */
export function readSnapshotIndex(landingDir) {
  const read = readLines(snapshotIndexPath(landingDir));
  return {
    values: read.values.filter((v) => v !== null && typeof v === 'object' && !Array.isArray(v)),
    badLines: read.badLines,
    oversized: read.oversized,
    truncatedTail: read.truncatedTail === true,
    missing: read.missing === true,
    bytes: read.bytes,
  };
}

/** 每个 pathKey 的**最新**记录 sha（`sha256_after ?? sha256_before`） */
export function latestShaByPath(values) {
  const out = new Map();
  for (const row of values) {
    if (typeof row.path !== 'string') continue;
    const sha = typeof row.sha256_after === 'string' && row.sha256_after !== '' ? row.sha256_after : row.sha256_before;
    if (typeof sha !== 'string' || sha === '') continue;
    const key = pathKey(row.path);
    const prev = out.get(key);
    const ts = typeof row.ts === 'string' ? row.ts : '';
    if (prev === undefined || ts >= prev.ts) out.set(key, { sha, ts });
  }
  return out;
}

/**
 * 建基线：把受保护文件的当前 sha256 记进快照索引（**幂等**：同 path 同 sha 不重复记）。
 * @returns {{ok: boolean, scanned: number, recorded: number, unchanged: number,
 *            excluded: string[], truncated: boolean, violations: number, reasons: string[]}}
 */
export function recordBaseline({ projectRoot, landingDir, rules, now = new Date(), maxFiles = BASELINE_MAX_FILES, withBackup = true, dryRun = false }) {
  const { files, excluded, truncated } = expandProtected({ projectRoot, landingDir, rules, maxFiles });
  if (truncated) {
    return { ok: false, scanned: files.length, recorded: 0, unchanged: 0, excluded, truncated: true, violations: 1,
      reasons: [`受保护文件数超过上限 ${maxFiles}（glob 可能写得太宽）-> 先收紧 protected_paths，再建基线`] };
  }
  const known = latestShaByPath(readSnapshotIndex(landingDir).values);
  let recorded = 0;
  let unchanged = 0;
  const reasons = [];
  const lines = [];
  for (const file of files) {
    const sha = sha256File(file.abs);
    const key = pathKey(file.rel);
    const seen = known.get(key);
    if (seen !== undefined && seen.sha === sha) { unchanged += 1; continue; }
    let backupRel = '';
    if (withBackup) {
      const bak = dryRun ? { ok: true, path: `(dry-run)/${file.rel}` } : backupFile(file.abs, { landingDir, now });
      if (bak.ok !== true) {
        reasons.push(`备份失败（${bak.reason}）: ${file.rel}`);
        continue;
      }
      backupRel = toPosix(relative(projectRoot, bak.path));
    }
    lines.push({
      schema: SCHEMA_VERSION,
      ts: now.toISOString(),
      path: key,
      sha256_before: sha,
      sha256_after: sha,
      sha256_lf: sha256LfOfBuffer(readFileSync(file.abs)),   // G3：基线的行尾归一形态（二进制为 null）
      backup: backupRel,
      why: '首次启用基线（LF-2B0）',
      job: 'baseline',
    });
    recorded += 1;
  }
  if (!dryRun) {
    // 首启时 snapshots/ 往往还不存在（ensureLanding 只建 config.json）——实测踩到：不建目录直接 append 会 ENOENT
    mkdirSync(join(landingDir, 'snapshots'), { recursive: true });
    for (const row of lines) {
      const appended = appendLine(snapshotIndexPath(landingDir), row);
      if (!appended.ok) {
        return { ok: false, scanned: files.length, recorded, unchanged, excluded, truncated: false, violations: 1, reasons: [`写快照失败: ${appended.reason}`] };
      }
    }
  }
  return { ok: reasons.length === 0, scanned: files.length, recorded, unchanged, excluded, truncated: false, violations: reasons.length, reasons, lines };
}

/**
 * 校验基线：受保护文件必须与快照索引里的最新 sha 一致。
 * @returns {{ok: boolean, scanned: number, violations: object[], excluded: string[],
 *            indexLines: number, badLines: number, truncatedTail: boolean, missing: boolean}}
 */
export function verifyBaseline({ projectRoot, landingDir, rules, maxFiles = BASELINE_MAX_FILES }) {
  const { files, excluded, truncated } = expandProtected({ projectRoot, landingDir, rules, maxFiles });
  const index = readSnapshotIndex(landingDir);
  const known = latestShaByPath(index.values);
  const violations = [];
  if (truncated) violations.push({ path: '(protected_paths)', reason: `受保护文件数超过上限 ${maxFiles}` });
  if (index.badLines > 0) violations.push({ path: SNAPSHOT_INDEX, reason: `索引有 ${index.badLines} 条坏行（篡改/撕裂）` });
  if (index.truncatedTail) violations.push({ path: SNAPSHOT_INDEX, reason: '索引末行没有换行（半行，写入未完成）' });
  for (const file of files) {
    const key = pathKey(file.rel);
    const seen = known.get(key);
    if (seen === undefined) {
      violations.push({ path: file.rel, reason: '受保护文件没有基线记录（首启基线未覆盖）' });
      continue;
    }
    const sha = sha256File(file.abs);
    if (sha !== seen.sha) violations.push({ path: file.rel, reason: `内容已变（现 ${sha.slice(0, 12)}… != 记录 ${seen.sha.slice(0, 12)}…）` });
  }
  return {
    ok: violations.length === 0,
    scanned: files.length,
    violations,
    excluded,
    indexLines: index.values.length,
    badLines: index.badLines,
    truncatedTail: index.truncatedTail,
    missing: index.missing,
  };
}

/** 供 CLI 打印：受保护文件相对项目根的 posix 列表（判据里不用绝对路径） */
export function protectedRelPaths(opts) {
  return expandProtected(opts).files.map((f) => f.rel);
}
