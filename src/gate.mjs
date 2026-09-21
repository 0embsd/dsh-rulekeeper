// dsh-rulekeeper · LF-530 **写入侧对账**（不依赖 git）：受保护文件的"当前内容"必须等于"最新留证基线"
//
// 判据（清单 §5 LF-530）：受保护文件 mtime/sha256 vs `snapshots/index.jsonl`；**收尾与开场各跑一次**。
// 红态：**直接改文件、不留证、不提交** → 收尾 check **exit≠0 并列出该文件**
//        （这是覆盖"未提交直写"的**唯一位置**——git 侧（LF-500/LF-510）看不见没进暂存区的改动）。
//
// 契约（与 LF-300 的 8 字段冻结表一致，不新增字段）：
//   「留证基线」= 该路径**最新**快照记录的 `sha256_after ?? sha256_before`
//   —— 取法**单点**收敛在 `baselineOf()` 里（L474：同一语义只许一套实现；将来若引入"改后确认"只改这里）。
//   **判定只看 sha256**；mtime 只作辅助上报（L453 实测：mtime 会被复制/编辑器/脚本污染 ——
//   拿它判红会假红，拿它判绿会假绿）。清单写的是"mtime/sha256"，这里如实拆成"sha256 判、mtime 报"。
//
// 归属：core 模块（P5 门禁）。零依赖：只用 node:*。
// 自产物排除（清单 §0.1 ㉚）：`.git` / `node_modules` / `.dsh-ai` 一律不进候选，**并计数上报**。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { effectiveConfig, isProtected, loadLandingRules, normalizeTarget } from './rules.mjs';
import { displayPath } from './checks.mjs';
import { latestRecordFor, readIndex } from './snap.mjs';
import { blobMatchesBaseline, sha256LfOfBuffer } from './lineend.mjs';
import { appendLine } from './append.mjs';
import { defaultRunGit, defaultRunGitRaw } from './hooks.mjs';
import { canonicalRule } from './ruleid.mjs';
import { readLedger } from './ledger.mjs';
import { validateUncheckableDeclaration } from './uncheckable.mjs';
import { redactValue } from './redact.mjs';
import { offGuard } from './mode.mjs';
import { pathKey, resolveProjectLanding, toPosix } from './platform/paths.mjs';
import { PUBLIC_FACE_FORBIDDEN, findPublicFaceLeaks, scanPublicFacePaths } from './selfcheck.mjs';
import { resolveRepoPatterns } from './repo-patterns.mjs';

/** 工具自产物/非项目目录：任何判据都不得把它们当"项目文件"（㉚） */
export const SELF_ARTIFACT_DIRS = Object.freeze(['.git', 'node_modules', '.dsh-ai']);
/** 遍历上限：到顶就**如实报**（`SCAN_TRUNCATED`），不许静默只扫一半 */
export const SCAN_LIMIT = 50000;

/**
 * 「留证基线」单点取法：`sha256_after ?? sha256_before`。
 * 为什么不是二选一写死：LF-120 冻结表里 `sha256_after?` 是可选的——`take` 时与 before 同值，
 * 将来若有"改后确认"则以 after 为准；两处各写一遍 `??` 链必然漂移（L496 同族）。
 */
export function baselineOf(record) {
  if (record === null || typeof record !== 'object') return null;
  const after = typeof record.sha256_after === 'string' && record.sha256_after !== '' ? record.sha256_after : null;
  const before = typeof record.sha256_before === 'string' && record.sha256_before !== '' ? record.sha256_before : null;
  return after ?? before;
}

export function sha256OfFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** 文本的内容 sha256（LF-540 工作流完整性用；统一按 UTF-8 算，不吃平台换行差异） */
export function sha256OfText(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** 有效保护面：config.json 覆盖 rules.json（走 LF-230 的 effectiveConfig，不自己合并） */
export function effectiveProtection(landingDir) {
  const { rulesResult, config, configError } = loadLandingRules(landingDir);
  const eff = effectiveConfig({ rules: rulesResult.rules, config });
  const patterns = Array.isArray(eff.protected_paths)
    ? eff.protected_paths.filter((p) => typeof p === 'string' && p.trim() !== '')
    : [];
  const findings = [];
  if (rulesResult.error) findings.push({ code: 'GATE_WRITE_RULES_UNREADABLE', message: `rules.json 读不了: ${rulesResult.error}` });
  if (configError) findings.push({ code: 'GATE_WRITE_CONFIG_UNREADABLE', message: `config.json 读不了: ${configError}` });
  for (const f of rulesResult.findings ?? []) findings.push({ code: `GATE_WRITE_${f.code}`, message: f.msg });
  return {
    present: patterns.length > 0,
    source: patterns.length === 0 ? '(none)' : eff.sources.protected_paths,
    patterns,
    mode: eff.mode,
    findings,
  };
}

/**
 * 遍历项目根（**不跟随符号链接**）：返回候选文件 + 被排除的目录 + 是否触顶。
 * 自产物目录整棵跳过（不是"逐个文件判"——目录名命中即不进）。
 */
export function discoverFiles({ projectRoot, limit = SCAN_LIMIT } = {}) {
  const root = resolve(projectRoot);
  const files = [];
  const excluded = [];
  let truncated = false;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= limit) { truncated = true; return; }
      if (entry.isSymbolicLink()) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SELF_ARTIFACT_DIRS.includes(entry.name)) { excluded.push(abs); continue; }
        walk(abs);
      } else if (entry.isFile()) {
        files.push(abs);
      }
    }
  };
  walk(root);
  return { files, excluded, truncated };
}

/**
 * **大小写不敏感**的存在性检查（LF-565 头号根因）：
 *   快照索引里的 `path` 是 **pathKey（已全部小写）**；在大小写敏感的 Linux 上直接 `existsSync(key)`
 *   会对真实存在的文件**假报"已删除"** → `GATE_WRITE_PROTECTED_MISSING` 假红
 *   （实测：Linux 15 例失败里 6 例由这一条引起；Windows 因大小写不敏感把它掩盖了）。
 *   做法：逐级按目录项小写比对，不依赖平台的大小写语义；任一级找不到即"确实没了"。
 */
function existsCaseInsensitive(root, rel) {
  const parts = toPosix(rel).split('/').filter((p) => p !== '' && p !== '.');
  let cur = resolve(root);
  for (const part of parts) {
    let entries;
    try { entries = readdirSync(cur); } catch { return false; }
    const hit = entries.find((e) => e.toLowerCase() === part.toLowerCase());
    if (hit === undefined) return false;
    cur = join(cur, hit);
  }
  return existsSync(cur);
}

/**
 * 写入侧对账。
 * @param {object} opts
 * @param {string} opts.projectRoot 项目根（受保护路径相对它归一）
 * @param {string} [opts.landingDir] 落点（默认 `<project>/.dsh-ai/lessonflow`）
 * @param {string[]|null} [opts.files] 显式候选（相对项目根）；null/空 = 按保护面**遍历**项目根
 * @param {string} [opts.phase] `open` | `close`（只作标签：两端语义相同，都要 exit≠0 才算"拦住"）
 * @returns {{ok:boolean, ...}}
 */
export function reconWrite(opts = {}) {
  const root = resolve(opts.projectRoot ?? process.cwd());
  const landing = resolve(opts.landingDir ?? resolveProjectLanding(root));
  const phase = opts.phase === 'open' ? 'open' : 'close';
  const protection = effectiveProtection(landing);
  const findings = [...protection.findings];
  const index = readIndex(landing);
  if (typeof index.badLines === 'number' && index.badLines > 0) {
    findings.push({ code: 'GATE_WRITE_INDEX_BAD_LINES', message: `快照索引有 ${index.badLines} 条坏行 -> 对账结论不可信` });
  }
  if (index.truncatedTail === true) {
    findings.push({ code: 'GATE_WRITE_INDEX_TRUNCATED_TAIL', message: '快照索引末行没写完（截断）-> 对账结论不可信' });
  }

  const explicit = Array.isArray(opts.files) ? opts.files.filter((f) => typeof f === 'string' && f.trim() !== '') : [];
  let scanned = 0;
  let selfExcluded = 0;
  let truncated = false;
  let candidates = [];
  if (explicit.length > 0) {
    candidates = explicit.map((f) => ({ rel: normalizeTarget(f, root), abs: resolve(root, f) }));
  } else {
    const found = discoverFiles({ projectRoot: root, limit: opts.limit ?? SCAN_LIMIT });
    scanned = found.files.length;
    selfExcluded = found.excluded.length;
    truncated = found.truncated;
    candidates = found.files.map((abs) => ({ abs, rel: normalizeTarget(abs, root) }));
  }
  if (truncated) {
    findings.push({ code: 'GATE_WRITE_SCAN_TRUNCATED', message: `遍历触顶（${opts.limit ?? SCAN_LIMIT}）-> 只覆盖了部分文件，不得当作全量结论` });
  }

  const rules = { protected_paths: protection.patterns };
  const checked = [];
  const skipped = [];
  for (const c of candidates) {
    if (c.rel === null) continue;
    const verdict = isProtected(c.rel, rules, { projectRoot: root });
    if (verdict.protected !== true) { skipped.push(c.rel); continue; }
    if (!existsSync(c.abs)) {
      checked.push({ path: c.rel, matched: verdict.matchedPattern, verdict: 'missing-on-disk', sha256: null, mtimeMs: null, record: null, mtimeNewer: null });
      continue;
    }
    const sha256 = sha256OfFile(c.abs);
    const mtimeMs = statSync(c.abs).mtimeMs;
    const record = latestRecordFor(landing, c.rel);
    const baseline = baselineOf(record);
    let state;
    if (record === null || baseline === null) state = 'nosnapshot';
    else if (baseline !== sha256) state = 'unrecorded';
    else state = 'snapshotted';
    const recordTs = record !== null && typeof record.ts === 'string' ? record.ts : null;
    const mtimeNewer = recordTs === null ? null : Date.parse(recordTs) < mtimeMs;
    checked.push({
      path: c.rel, matched: verdict.matchedPattern, verdict: state, sha256, baseline,
      mtimeMs, recordTs, mtimeNewer, why: record?.why ?? null,
    });
  }

  const unrecorded = checked.filter((c) => c.verdict === 'unrecorded');
  const nosnapshot = checked.filter((c) => c.verdict === 'nosnapshot');
  const missingOnDisk = checked.filter((c) => c.verdict === 'missing-on-disk');
  const snapshotted = checked.filter((c) => c.verdict === 'snapshotted');

  // **删除面**（LF-540 独立评审 阻断①：删除受保护文件 = 对受保护路径的改动，此前两处都没兜）：
  //   `discoverFiles` 走的是"磁盘上存在的文件"，所以**被删掉的受保护文件根本不在候选集**，
  //   只能从**快照索引**（谁曾经留过证）反查："索引里有基线、磁盘上却没了" ⇒ 判红。
  const recordedMissing = [];
  if (protection.patterns.length > 0) {
    const seen = new Set(checked.map((c) => c.path));
    for (const rec of index.values) {
      const rel = typeof rec.path === 'string' && rec.path !== '' ? rec.path : null;
      if (rel === null || seen.has(rel)) continue;
      if (isProtected(rel, rules, { projectRoot: root }).protected !== true) continue;
      if (existsCaseInsensitive(root, rel)) continue;
      seen.add(rel);
      recordedMissing.push({ path: rel, baseline: baselineOf(rec), recordTs: typeof rec.ts === 'string' ? rec.ts : null });
    }
  }
  for (const c of recordedMissing) {
    findings.push({
      code: 'GATE_WRITE_PROTECTED_MISSING',
      message: `受保护文件**已被删除**但没留证（快照索引里有基线，磁盘上已不存在）: ${c.path} baseline=${(c.baseline ?? '').slice(0, 12)} record_ts=${c.recordTs ?? '(none)'} -> 删除也是改动，需先留证或改保护面`,
    });
  }

  for (const c of nosnapshot) {
    findings.push({
      code: 'GATE_WRITE_NO_SNAPSHOT',
      message: `受保护文件从未留证（无快照记录）: ${c.path}（匹配 ${c.matched}）current=${(c.sha256 ?? '').slice(0, 12)} -> 先 rk-snap take 再改`,
    });
  }
  for (const c of unrecorded) {
    findings.push({
      code: 'GATE_WRITE_UNRECORDED_CHANGE',
      message: `受保护文件被**改过但没留证**（当前内容 != 最新留证基线）: ${c.path} current=${c.sha256.slice(0, 12)} baseline=${(c.baseline ?? '').slice(0, 12)} record_ts=${c.recordTs ?? '(none)'}`,
    });
  }
  const mtimeAux = checked.filter((c) => c.mtimeNewer === true).length;
  return {
    ok: findings.length === 0,
    phase,
    landingPresent: existsSync(landing),
    present: protection.present,
    source: protection.source,
    patterns: protection.patterns,
    mode: protection.mode,
    scanned,
    selfExcluded,
    truncated,
    indexLines: index.lines ?? 0,
    indexBadLines: index.badLines ?? 0,
    indexTruncatedTail: index.truncatedTail === true,
    explicit: explicit.length > 0,
    checked,
    skipped: skipped.length,
    snapshotted,
    unrecorded,
    nosnapshot,
    missingOnDisk,
    recordedMissing,
    mtimeAux,
    findings,
  };
}

// ── LF-500 **pre-commit 真阻断**（暂存区视角）────────────────────────────────
//
// 判据（清单 §5 LF-500）：`pre-commit`：改受保护路径未 snap → **拒**；留证后提交通过。
//   红态：**不留证提交 → exit≠0**；**且拒绝时必须清空暂存区或记"未清空"台账**
//        （实测依据：被拒的改动若留在暂存区，会被下一次 `--no-verify` 提交**夹带**带走）。
//
// 与 LF-530 的关系（**同一判据、两个视角**，不是两套实现）：
//   · LF-530 = 工作区（磁盘）内容 vs 最新留证基线；
//   · LF-500 = **暂存区**（`git show :<path>` 的那一份）内容 vs 最新留证基线。
//   两者共用 `baselineOf()` / `effectiveProtection()` / `latestRecordFor()`（⑰：一套口径）。
//
// 删除类改动**不**进本判据（`--diff-filter=ACMR` 排掉 D）：文件消失属"没有了"，由 LF-530 的 MISSING 面覆盖；
// 把删除也算"改了没留证"会让"删掉受保护文件"变成一条查不出原因的拒绝。

/** 台账落点（落点内 `logs/`，属工具自产物 -> ㉚ 不进判据基线） */
export const GATE_LEDGER_REL = 'logs/gate.jsonl';

export function gateLedgerPath(landingDir) {
  return join(landingDir, 'logs', 'gate.jsonl');
}

/** 读台账（容错：坏行计数，不抛） */
export function readGateLedger(landingDir) {
  const file = gateLedgerPath(landingDir);
  if (!existsSync(file)) return { lines: 0, values: [], badLines: 0, missing: true };
  const values = [];
  let badLines = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      values.push(JSON.parse(trimmed));
    } catch {
      badLines += 1;
    }
  }
  return { lines: values.length, values, badLines, missing: false };
}

/** 暂存区里"新增/复制/改动/改名"的路径（`-z`：路径含空白/换行也安全） */
export function stagedPaths(repoRoot, runGitRaw = defaultRunGitRaw) {
  const r = runGitRaw(repoRoot, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']);
  if (!r.ok) return { ok: false, paths: [], reason: r.stderr || r.error || `git exit=${r.status}` };
  return { ok: true, paths: r.buffer.toString('utf8').split('\0').filter((s) => s !== ''), reason: null };
}

/** **暂存版本**（index 里那一份）的 sha256 —— 这才是"这次要提交的内容" */
export function stagedBlobSha(repoRoot, relPath, runGitRaw = defaultRunGitRaw) {
  const r = runGitRaw(repoRoot, ['show', `:${relPath}`]);
  if (!r.ok) return { ok: false, sha256: null, buffer: null, reason: r.stderr || r.error || `git exit=${r.status}` };
  // 同时回 buffer（G3：跨形态比对要看原始字节，不能只带摘要）
  return { ok: true, sha256: createHash('sha256').update(r.buffer).digest('hex'), buffer: r.buffer, reason: null };
}

/**
 * pre-commit 门禁（只读 + 可选清暂存区 + 写台账；**不**改动工作区文件）。
 * @param {object} opts `{repoRoot, landingDir, clearIndex, now, runGit, runGitRaw}`
 * @returns {{ok, present, source, staged, protectedStaged, violations, findings, cleared, clearedPaths, ledger, isGit}}
 */
export function precommitGate(opts = {}) {
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());
  const landing = resolve(opts.landingDir ?? resolveProjectLanding(repoRoot));
  const runGit = opts.runGit ?? defaultRunGit;
  const runGitRaw = opts.runGitRaw ?? defaultRunGitRaw;
  const now = opts.now ?? new Date();
  const protection = effectiveProtection(landing);
  const findings = [...protection.findings];
  const index = readIndex(landing);
  if (typeof index.badLines === 'number' && index.badLines > 0) {
    findings.push({ code: 'GATE_PRECOMMIT_INDEX_BAD_LINES', message: `快照索引有 ${index.badLines} 条坏行 -> 门禁结论不可信` });
  }

  const staged = stagedPaths(repoRoot, runGitRaw);
  if (!staged.ok) {
    return {
      ok: false, isGit: false, present: protection.present, source: protection.source,
      staged: [], protectedStaged: [], violations: [], cleared: false, clearedPaths: [], ledger: null,
      indexLines: index.lines ?? 0, indexBadLines: index.badLines ?? 0,
      findings: [...findings, { code: 'GATE_PRECOMMIT_NOT_GIT', message: `读暂存区失败（不是 git 仓库？）: ${staged.reason}` }],
    };
  }

  const rules = { protected_paths: protection.patterns };

  // ── 公开面脱敏的**提交时**机械面（2026-09-19，同一形态第三次复发后补）────────────
  // 复发史：脚本探针注释 → `src/landing.mjs` 注释 → `src/similarity.mjs` 注释，三次都是
  //   "新写文件的注释里带了内部项目名/本机路径"。此前只有 `rk-selfcheck` 的 S8 能发现它，
  //   而那要等到"有人跑自检"。这里在**提交那一刻**对暂存文件跑同一份模式表 ⇒ 当场被拒。
  // 为什么看工作区而不是 `git show :<path>`：S8 管的是"这段文字会不会进公开仓"，暂存区与
  //   工作区在本仓的实际流程里一致（且 `stagedBlobSha` 已单独负责内容指纹对账）。
  // **按仓库性质分档**（2026-09-21）：公开仓跑完整表；私有仓只跑基础设施/凭据类（"本仓自己的名字"
  //   在私有仓里没有泄漏语义）。档位由落点 config 的 `repoKind` 声明，未声明则按远端探测，兜底 private。
  //   注：档位只作**返回字段**上报（`leakMode`），**不进 findings** —— findings 一旦非空 `ok` 就为 false，
  //   把"档位是 private"当发现会让私有仓的每次提交都判红（那就成了自己拦自己）。
  // 注意用 `runGitRaw`（(repoRoot, argv) -> {status, stdout}），不是 `runGit`（不同的调用形态）；
  // `detectRepoKind` 只读 `git config --get remote.origin.url`，两者都兼容。
  const repoPatterns = resolveRepoPatterns({ root: repoRoot, landingDir: landing, runGitRaw });
  for (const leak of scanPublicFacePaths(repoRoot, staged.paths, { forbidden: repoPatterns.forbidden })) {
    findings.push({
      code: 'GATE_PRECOMMIT_INTERNAL_LEAK',
      message: `暂存文件出现${leak.why}「${leak.match}」: ${leak.rel}（${repoPatterns.kind === 'public' ? '公开仓不得暴露内部标识/本地路径/基础设施信息' : '私有仓不得暴露基础设施信息/凭据'}；改掉措辞再提交）`,
      path: leak.rel,
    });
  }

  const protectedStaged = [];
  const violations = [];
  for (const rel of staged.paths) {
    if (protection.patterns.length === 0) break;
    const verdict = isProtected(rel, rules, { projectRoot: repoRoot });
    if (verdict.protected !== true) continue;
    const blob = stagedBlobSha(repoRoot, rel, runGitRaw);
    if (blob.ok !== true) {
      findings.push({ code: 'GATE_PRECOMMIT_BLOB_UNREADABLE', message: `读暂存版本失败: ${rel}（${blob.reason}）` });
      continue;
    }
    const record = latestRecordFor(landing, rel);
    const baseline = baselineOf(record);
    const entry = {
      path: toPosix(rel), matched: verdict.matchedPattern, stagedSha256: blob.sha256,
      baseline, recordTs: record === null ? null : (record.ts ?? null), why: record === null ? null : (record.why ?? null),
    };
    protectedStaged.push(entry);
    if (record === null || baseline === null) {
      entry.verdict = 'nosnapshot';
      violations.push(entry);
      findings.push({
        code: 'GATE_PRECOMMIT_NO_SNAPSHOT',
        message: `受保护文件要提交但**从未留证**: ${entry.path} staged=${blob.sha256.slice(0, 12)} -> 先 rk-snap take <path> 再提交`,
      });
    } else if (blobMatchesBaseline(record, blob.buffer).match !== true) {   // G3：跨形态比对（只差行尾形态不算改）
      entry.verdict = 'unrecorded';
      violations.push(entry);
      findings.push({
        code: 'GATE_PRECOMMIT_UNRECORDED',
        message: `改受保护路径未 snap（**暂存内容 != 最新留证基线**）: ${entry.path} staged=${blob.sha256.slice(0, 12)} baseline=${baseline.slice(0, 12)} record_ts=${entry.recordTs ?? '(none)'}`,
      });
    } else {
      entry.verdict = 'snapshotted';
    }
  }

  // 拒绝时：**默认不动暂存区**（破坏性动作必须显式给 --clear-index），并且无论如何都记台账
  let cleared = false;
  let clearedPaths = [];
  let clearReason = null;
  if (findings.length > 0 && opts.clearIndex === true && violations.length > 0) {
    const r = runGit(repoRoot, ['restore', '--staged', '--', ...violations.map((v) => v.path)]);
    cleared = r.ok;
    clearedPaths = r.ok ? violations.map((v) => v.path) : [];
    clearReason = r.ok ? null : (r.stderr || r.error || `git exit=${r.status}`);
    if (r.ok !== true) findings.push({ code: 'GATE_PRECOMMIT_CLEAR_FAILED', message: `清空暂存区失败: ${clearReason}` });
  }

  let ledger = null;
  if (findings.length > 0) {
    const row = {
      schema: 1,
      ts: now.toISOString(),
      gate: 'precommit',
      repo: pathKey(repoRoot),
      staged: staged.paths.map((p) => toPosix(p)),
      protectedStaged: protectedStaged.map((p) => p.path),
      violations: violations.map((v) => ({
        path: v.path,
        code: v.verdict === 'unrecorded' ? 'GATE_PRECOMMIT_UNRECORDED' : 'GATE_PRECOMMIT_NO_SNAPSHOT',
        staged: v.stagedSha256,
        baseline: v.baseline,
      })),
      indexCleared: cleared,
      clearedPaths: clearedPaths.map((p) => toPosix(p)),
      // "未清空"就是风险本身：被拒的改动留在暂存区，会被下一次 --no-verify 夹带
      unrecordedStagedLeftBehind: violations.length > 0 && cleared !== true,
      bypass: 'git commit --no-verify',
    };
    try {
      mkdirSync(join(landing, 'logs'), { recursive: true });
      const appended = appendGateRow(landing, row);
      ledger = { ok: appended.ok === true, path: GATE_LEDGER_REL, reason: appended.reason ?? null };
      if (appended.ok !== true) findings.push({ code: 'GATE_PRECOMMIT_LEDGER_FAILED', message: `台账写入失败: ${appended.reason}` });
    } catch (err) {
      ledger = { ok: false, path: GATE_LEDGER_REL, reason: String(err?.message ?? err) };
      findings.push({ code: 'GATE_PRECOMMIT_LEDGER_FAILED', message: `台账写入异常: ${String(err?.message ?? err)}` });
    }
  }

  return {
    ok: findings.length === 0,
    isGit: true,
    present: protection.present,
    source: protection.source,
    patterns: protection.patterns.length,
    mode: protection.mode,
    leakMode: { kind: repoPatterns.kind, source: repoPatterns.source, patterns: repoPatterns.forbidden.length },
    staged: staged.paths.map((p) => toPosix(p)),
    protectedStaged,
    violations,
    findings,
    cleared,
    clearedPaths: clearedPaths.map((p) => toPosix(p)),
    clearReason,
    ledger,
    indexLines: index.lines ?? 0,
    indexBadLines: index.badLines ?? 0,
  };
}

// ── LF-510 **绕过对账**（`--no-verify` / hook 未装 的检出）────────────────────
//
// 判据（清单 §5 LF-510）：`post-commit`（`--no-verify` **不跳过它**）+ `git log` 与账本**差集** + 远端防线。
//   红态：构造 `--no-verify` 提交 → 对账 **exit≠0 且列出该 sha**。
//
// 为什么必须"事后对账"：`--no-verify` 天生跳过 `pre-commit`（真阻断只在**没被绕过**时有效），
//   而 **`post-commit` 在 `--no-verify` 下仍会执行**（本机实测：pre-commit 不跑、post-commit 照跑）。
//   于是：① post-commit 把"这次提交"的取证结论写进台账（通过 / 违规）；② `bypass` 拿 `git log` 里
//   "动过受保护路径的提交"与台账做**差集** —— 有条目=有取证；**没条目=那次提交根本没人看**（hook 未装/未启用）。
// 远端防线（CI / 受保护分支）是另一个条目（LF-540）；本函数只做本地可判定部分，且**不宣称**远端已覆盖。

/** 某次提交里"动过"的路径（新增/复制/改动/改名；删除不进本判据，同 LF-500） */
export function commitPaths(repoRoot, sha, runGitRaw = defaultRunGitRaw) {
  const r = runGitRaw(repoRoot, ['show', '--name-only', '--pretty=format:', '--diff-filter=ACMR', sha]);
  if (!r.ok) return { ok: false, paths: [], reason: r.stderr || r.error || `git exit=${r.status}` };
  return { ok: true, paths: r.buffer.toString('utf8').split('\n').map((s) => s.trim()).filter((s) => s !== ''), reason: null };
}

/**
 * **提交正文的公开面门禁**（`commit-msg` / `pre-push` 两道钩子共用；2026-09-21 事故后补，教训 L652）。
 *
 * 为什么必须有：`precommitGate` 的脱敏扫描只看**暂存文件**——公开面还有一块**正文**（提交消息）。
 *   实测事故：两个提交的文件全过、正文里各带一行绝对路径凭证（含内部项目名）⇒ 推送后才发现；
 *   想改写历史时被远端分支保护拒绝（`Cannot force-push to this branch`）⇒ **泄漏撤不回来**。
 *   ⇒ 只能把判据**前移到离机之前**，两个检查点缺一不可：
 *     · `commit-msg`（单条）：提交那一刻拦；人能当场改消息重来。
 *     · `pre-push`（**区间**）：推送那一刻把"所有未推提交的正文"再扫一遍 —— 它兜住
 *       ①`--no-verify` 绕过的提交 ②钩子装上**之前**就已经存在的提交 ③改过正文的 amend。
 *       这是最后一道：**过了这道，泄漏就出机器了**。
 *
 * 清洗规则（照 git 自己的口径，别把"模板注释"和 `-v` 的 diff 当正文）：
 *   · 丢弃以 `#` 开头的行（`git commit` 的模板/注释行）；
 *   · 丢弃剪刀线 `# ------------------------ >8 ------------------------` **之后**的所有内容
 *     （`git commit -v` 会把 diff 附在消息文件里）；
 *   · 其余按原样扫描（多行、含缩进都算）。
 * @param {{messageFile?: string, repoRoot?: string, range?: string, runGit?: Function}} opts
 * @returns {{ok: boolean, mode: string, files: string[], scannedLines: number, commits: object[], findings: object[]}}
 */
export function commitMessageGate(opts = {}) {
  const runGit = opts.runGit ?? defaultRunGit;
  // 档位解析（公开仓完整表 / 私有仓只跑基础设施类）：区间模式与单文件模式共用
  const leakPatterns = resolveLeakPatterns(opts);
  // ── 区间模式（pre-push）：把区间里**每个提交**的正文都扫一遍 ─────────────────────
  if (typeof opts.range === 'string' && opts.range.trim() !== '') {
    const range = opts.range.trim();
    const repoRoot = resolve(opts.repoRoot ?? process.cwd());
    const r = runGit(repoRoot, ['log', '--format=%H%x1f%B%x1e', range]);
    if (r.ok !== true) {
      return {
        ok: false, mode: 'range', range, files: [], scannedLines: 0, commits: [],
        findings: [{ code: 'GATE_COMMITMSG_RANGE_UNREADABLE', message: `读不到区间 ${range} 的提交正文: ${r.stderr || r.error || `git exit=${r.status}`}` }],
      };
    }
    const chunks = String(r.stdout ?? '').split('\x1e').map((s) => s.trim()).filter((s) => s !== '');
    const findings = [];
    const commits = [];
    let scannedLines = 0;
    for (const chunk of chunks) {
      const sep = chunk.indexOf('\x1f');
      const sha = (sep < 0 ? '' : chunk.slice(0, sep)).trim();
      const body = sep < 0 ? chunk : chunk.slice(sep + 1);
      const stripped = stripMessageForScan(body);
      scannedLines += stripped.length;
      const leaks = findPublicFaceLeaks('COMMIT_EDITMSG', stripped.join('\n'), leakPatterns.forbidden).map((leak) => ({
        code: 'GATE_COMMITMSG_INTERNAL_LEAK',
        message: `提交 ${sha.slice(0, 8)} 的正文出现${leak.why}「${leak.match}」（公开仓的正文同样算公开面；**推送前**改掉：amend 或 rebase 改消息）`,
        commit: sha.slice(0, 8),
        match: leak.match,
      }));
      commits.push({ sha: sha.slice(0, 8), scannedLines: stripped.length, leaks: leaks.length });
      findings.push(...leaks);
    }
    return { ok: findings.length === 0, mode: 'range', range, files: [], scannedLines, commits, findings };
  }
  // ── 单文件模式（commit-msg）────────────────────────────────────────────────────
  const messageFile = typeof opts.messageFile === 'string' ? opts.messageFile : '';
  if (messageFile === '' || !existsSync(messageFile)) {
    // fail-closed：读不到正文 = 这道判据不可信。宁可让人把路径给对，也不假装"扫过了"。
    return {
      ok: false, mode: 'file', files: [], scannedLines: 0, commits: [],
      findings: [{ code: 'GATE_COMMITMSG_UNREADABLE', message: `读不到提交正文文件（--file 未给或不存在）: ${messageFile || '(空)'}` }],
    };
  }
  let raw;
  try {
    raw = readFileSync(messageFile, 'utf8');
  } catch (error) {
    return {
      ok: false, mode: 'file', files: [], scannedLines: 0, commits: [],
      findings: [{ code: 'GATE_COMMITMSG_UNREADABLE', message: `读提交正文失败: ${String(error?.message ?? error)}` }],
    };
  }
  const lines = stripMessageForScan(raw);
  const findings = findPublicFaceLeaks('COMMIT_EDITMSG', lines.join('\n'), leakPatterns.forbidden).map((leak) => ({
    code: 'GATE_COMMITMSG_INTERNAL_LEAK',
    message: `提交正文出现${leak.why}「${leak.match}」（${leakPatterns.kind === 'public' ? '公开仓的正文同样算公开面' : '私有仓的正文同样不得出现基础设施信息/凭据'}；改掉措辞再提交）`,
    match: leak.match,
  }));
  return { ok: findings.length === 0, mode: 'file', files: [messageFile], scannedLines: lines.length, commits: [], findings };
}

/** 正文里"哪些行算正文"：丢掉 `#` 注释行与剪刀线之后的 diff（git 自己的口径） */
function stripMessageForScan(raw) {
  const SCISSORS = /^#\s*-+\s*>8\s*-+/;
  const lines = [];
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    if (SCISSORS.test(line)) break;
    if (line.startsWith('#')) continue;
    lines.push(line);
  }
  return lines;
}

/**
 * 公开面黑名单的**分档解析**（2026-09-21，交接第 1 步）：三类门（提交正文 / 引用名 / 暂存文件）
 * 都要回答同一个问题"这个仓该跑哪一档"，故口径只写一份。
 *
 * 三种用法：
 *   · `{ forbidden }`（调用方自己解析过）⇒ 直接用；
 *   · `{ landingDir }`（钩子/CLI 手上有落点）⇒ 读 config 的 `repoKind`，未声明则按远端探测；
 *   · 都没有 ⇒ **公开仓完整表**（保守默认：不确定就更严，宁可多扫一类）。
 */
function resolveLeakPatterns(opts = {}) {
  if (Array.isArray(opts.forbidden)) return { kind: opts.repoKind ?? 'public', source: 'explicit', forbidden: opts.forbidden };
  if (typeof opts.landingDir === 'string' && opts.landingDir !== '') {
    return resolveRepoPatterns({ root: opts.repoRoot, landingDir: opts.landingDir, runGitRaw: opts.runGitRaw });
  }
  return { kind: 'public', source: 'default', forbidden: PUBLIC_FACE_FORBIDDEN };
}

/**
 * **引用名（分支 / tag）的公开面门禁**（2026-09-21，形状同一个洞的第三块）。
 *
 * 为什么必须有：公开面 = **一切随推送离开本机的内容**。除文件与提交正文外，**引用名**同样会公开
 * （`refs/heads/<名字>` 会出现在 GitHub 的分支列表里，且常被写进 release/PR）。本地能管的就这一块：
 * `pre-push` 的 stdin 里本来就带着 `<localRef> <localSha> <remoteRef> <remoteSha>`，顺手扫即可。
 * 边界（如实）：PR 描述、issue 正文、CI 日志属**远端 API 面**，本机钩子天生看不见。
 * @param {{text?: string, refs?: string[], forbidden?: Array, landingDir?: string, repoRoot?: string}} opts
 * @returns {{ok: boolean, refs: string[], findings: object[]}}
 */
export function refsGate(opts = {}) {
  const rows = Array.isArray(opts.refs) ? opts.refs.map(String)
    : String(opts.text ?? '').split(/\r?\n/);
  const names = [];
  for (const row of rows) {
    const parts = row.trim().split(/\s+/).filter((s) => s !== '');
    if (parts.length < 4) continue;             // git 的 stdin 形态：四段
    for (const name of [parts[0], parts[2]]) {
      // 只把"像引用名"的字段当引用名：`refs/...`、`(delete)`，或不是 7–40 位十六进制（那是 sha）
      const looksLikeSha = /^[0-9a-f]{7,40}$/i.test(name);
      if (name === '' || looksLikeSha) continue;
      if (!names.includes(name)) names.push(name);
    }
  }
  const findings = [];
  // 档位解析（公开仓完整表 / 私有仓只跑基础设施类）：见 resolveLeakPatterns 的注释
  const leakPatterns = resolveLeakPatterns(opts);
  for (const name of names) {
    for (const leak of findPublicFaceLeaks('REFS', name, leakPatterns.forbidden)) {
      findings.push({
        code: 'GATE_REF_INTERNAL_LEAK',
        message: `推送的引用名出现${leak.why}「${leak.match}」（引用名同样是公开面：会出现在远端分支/tag 列表里）`,
        ref: name,
        match: leak.match,
      });
    }
  }
  return { ok: findings.length === 0, refs: names, findings };
}

/** 某次提交里某个路径的内容 sha256（提交态，不是工作区） */
export function commitBlobSha(repoRoot, sha, relPath, runGitRaw = defaultRunGitRaw) {
  const r = runGitRaw(repoRoot, ['show', `${sha}:${relPath}`]);
  if (!r.ok) return { ok: false, sha256: null, buffer: null, reason: r.stderr || r.error || `git exit=${r.status}` };
  // 同时回 buffer（G3：跨形态比对要看原始字节，不能只带摘要）
  return { ok: true, sha256: createHash('sha256').update(r.buffer).digest('hex'), buffer: r.buffer, reason: null };
}

/**
 * 枚举若干次提交（含每次动过的路径）：`--all` = 全历史；`range`（如 `base..head`）= 指定范围。
 * 范围优先于 `-n`：CI 场景要的是"这次 push 推上来的那些提交"，不是"最近 N 条"（L512）。
 *
 * ⚠ 用 `--name-status` 而**不是** `--diff-filter=ACMR`（LF-540 独立评审 阻断①的根因）：
 *   `git log --diff-filter=ACMR` 会把"**只做删除**"的提交**整条过滤掉**（连 `-n` 计数都不算），
 *   于是"删掉受保护文件"既进不了循环、也留不下任何判据。现在 D 面单列：
 *   `paths` = A/M/C + 改名后的目标路径（需取证的那一面）；`deleted` = D 面（删除也是改动）。
 */
export function listCommits(repoRoot, { limit = 50, all = false, range = null, runGitRaw = defaultRunGitRaw } = {}) {
  const args = ['log', '--name-status', '--pretty=format:__RK_C__%H'];
  const ranged = typeof range === 'string' && range.trim() !== '';
  if (ranged) args.push(range.trim());
  else if (all !== true && Number.isInteger(limit) && limit > 0) args.push(`-n${limit}`);
  const r = runGitRaw(repoRoot, args);
  if (!r.ok) return { ok: false, commits: [], reason: r.stderr || r.error || `git exit=${r.status}` };
  const commits = [];
  let current = null;
  for (const raw of r.buffer.toString('utf8').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('__RK_C__')) {
      current = { sha: line.slice('__RK_C__'.length).trim(), paths: [], deleted: [] };
      commits.push(current);
      continue;
    }
    if (current === null || line.trim() === '') continue;
    const parts = line.split('\t').map((s) => s.trim()).filter((s) => s !== '');
    const status = parts[0] ?? '';
    if (status.startsWith('D')) {
      if (parts[1] !== undefined) current.deleted.push(parts[1]);
    } else if (status.startsWith('R') || status.startsWith('C')) {
      if (parts[2] !== undefined) current.paths.push(parts[2]); // 改名/复制：判**目标**路径
    } else if (parts[1] !== undefined) {
      current.paths.push(parts[1]);
    }
  }
  return { ok: true, commits, reason: null };
}

/**
 * `post-commit` 载荷（LF-510）：记录**这次提交**里受保护路径的取证结论。
 * @returns {{ok, isGit, sha, protectedPaths, violations, ledger, findings}}
 */
export function postCommitRecon(opts = {}) {
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());
  const landing = resolve(opts.landingDir ?? resolveProjectLanding(repoRoot));
  const runGit = opts.runGit ?? defaultRunGit;
  const runGitRaw = opts.runGitRaw ?? defaultRunGitRaw;
  const now = opts.now ?? new Date();
  const protection = effectiveProtection(landing);
  const findings = [...protection.findings];

  let sha = opts.sha ?? null;
  if (sha === null) {
    const head = runGit(repoRoot, ['rev-parse', 'HEAD']);
    if (!head.ok) {
      return { ok: false, isGit: false, sha: null, protectedPaths: [], violations: [], ledger: null, findings: [...findings, { code: 'GATE_POSTCOMMIT_NOT_GIT', message: `取不到 HEAD（不是 git 仓库？）: ${head.stderr || head.error || ''}` }] };
    }
    sha = head.stdout;
  }
  const listed = commitPaths(repoRoot, sha, runGitRaw);
  if (listed.ok !== true) {
    return { ok: false, isGit: false, sha, protectedPaths: [], violations: [], ledger: null, findings: [...findings, { code: 'GATE_POSTCOMMIT_NOT_GIT', message: `读提交内容失败: ${listed.reason}` }] };
  }
  const rules = { protected_paths: protection.patterns };
  const protectedPaths = [];
  const violations = [];
  for (const rel of listed.paths) {
    if (protection.patterns.length === 0) break;
    const verdict = isProtected(rel, rules, { projectRoot: repoRoot });
    if (verdict.protected !== true) continue;
    const blob = commitBlobSha(repoRoot, sha, rel, runGitRaw);
    const record = latestRecordFor(landing, rel);
    const baseline = baselineOf(record);
    const entry = {
      path: toPosix(rel), committedSha256: blob.ok === true ? blob.sha256 : null, baseline,
      baselineLf: record === null ? null : (typeof record.sha256_lf === 'string' ? record.sha256_lf : null),   // G3：台账带上基线的归一形态，bypass 对账才能跨形态
      recordTs: record === null ? null : (record.ts ?? null),
    };
    if (blob.ok !== true) {
      entry.verdict = 'unreadable';
      findings.push({ code: 'GATE_POSTCOMMIT_BLOB_UNREADABLE', message: `读提交版本失败: ${entry.path}（${blob.reason}）` });
      protectedPaths.push(entry);
      continue;
    }
    if (record === null || baseline === null) {
      entry.verdict = 'nosnapshot';
      violations.push(entry);
      findings.push({ code: 'GATE_POSTCOMMIT_NO_SNAPSHOT', message: `提交里含受保护的**从未留证**路径: ${entry.path} sha=${sha.slice(0, 12)} -> 这次提交没有取证` });
    } else if (blobMatchesBaseline(record, blob.buffer).match !== true) {   // G3：跨形态比对
      entry.verdict = 'unrecorded';
      violations.push(entry);
      findings.push({
        code: 'GATE_POSTCOMMIT_UNRECORDED',
        message: `提交里含**未留证**的受保护路径: ${entry.path} sha=${sha.slice(0, 12)} committed=${blob.sha256.slice(0, 12)} baseline=${baseline.slice(0, 12)} record_ts=${entry.recordTs ?? '(none)'}`,
      });
    } else {
      entry.verdict = 'snapshotted';
    }
    protectedPaths.push(entry);
  }

  // 台账：**通过也要记**（这正是"这次提交有取证"的凭据；差集对账靠它）
  // 没有保护面时不写台账（没东西可记，避免给"未保护"的仓库灌一堆无意义行）
  let ledger = null;
  if (protection.present === true) {
    const row = {
      schema: 1,
      ts: now.toISOString(),
      gate: 'post-commit',
      repo: pathKey(repoRoot),
      sha,
      verdict: violations.length === 0 ? 'pass' : 'unrecorded',
      protectedPaths: protectedPaths.map((p) => ({ path: p.path, verdict: p.verdict, committed: p.committedSha256, baseline: p.baseline })),
      violations: violations.map((v) => v.path),
      bypassSuspected: violations.length > 0,
    };
    try {
      mkdirSync(join(landing, 'logs'), { recursive: true });
      const appended = appendGateRow(landing, row);
      ledger = { ok: appended.ok === true, path: GATE_LEDGER_REL, reason: appended.reason ?? null };
      if (appended.ok !== true) findings.push({ code: 'GATE_POSTCOMMIT_LEDGER_FAILED', message: `台账写入失败: ${appended.reason}` });
    } catch (err) {
      ledger = { ok: false, path: GATE_LEDGER_REL, reason: String(err?.message ?? err) };
      findings.push({ code: 'GATE_POSTCOMMIT_LEDGER_FAILED', message: `台账写入异常: ${String(err?.message ?? err)}` });
    }
  }
  return {
    ok: violations.length === 0 && findings.length === 0,
    isGit: true,
    sha,
    present: protection.present,
    source: protection.source,
    protectedPaths,
    violations,
    ledger,
    findings,
  };
}

/**
 * 绕过对账（LF-510）：`git log` 里"动过受保护路径的提交" ∖ 台账里有 `post-commit` 记录的 sha = **没人看过的提交**。
 *
 * LF-540 独立评审后的两处加硬（都是"能洗白"的路径，必须堵）：
 *   ① **删除面**：`--diff-filter=ACMR` 看不见 `D` ⇒ "只删受保护文件"曾 100% 放行。现在单列 `--diff-filter=D`，
 *      删除受保护路径同样进 `bypassed`（`state='protected-deleted'`）。
 *   ② **台账不再自证**：此前只要往 `logs/gate.jsonl` 追一行 `{gate:'post-commit',sha,verdict:'pass'}` 就能洗白。
 *      现在 `verdict:'pass'` 必须**带上可对账的物证**：`protectedPaths[]` 覆盖本次提交里**全部**受保护路径，
 *      且每条的 `committed` 非空并等于 `git show <sha>:<path>` 的实测 sha256（`baseline` 也必须同值）。
 *      对不上的行 → `state='ledger-unverified'` + `GATE_BYPASS_LEDGER_UNVERIFIED`（**仍判红**）。
 *      ⚠ 残留风险已自曝（见 `ledgerAuthenticated`）：台账**没有签名**，能改台账的人也能把物证写全 ——
 *      真正的防篡改只能靠"分支保护 + required status checks + CODEOWNERS"（GitHub 侧设置，属老板保留项）。
 * @returns {{ok, checked, gated, bypassed[], findings, ledgerAuthenticated}}
 */
export function bypassRecon(opts = {}) {
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());
  const landing = resolve(opts.landingDir ?? resolveProjectLanding(repoRoot));
  const limit = Number.isInteger(opts.limit) ? opts.limit : 50;
  const all = opts.all === true;
  const range = typeof opts.range === 'string' && opts.range.trim() !== '' ? opts.range.trim() : null;
  const runGitRaw = opts.runGitRaw ?? defaultRunGitRaw;
  // 调用方已经算过保护面/台账就复用（⑰ 同一判据不跑两遍）；否则各自算一次
  const protection = opts.protection ?? effectiveProtection(landing);
  const findings = [...protection.findings];
  const rules = { protected_paths: protection.patterns };

  const listed = listCommits(repoRoot, { limit, all, range, runGitRaw });
  if (listed.ok !== true) {
    return { ok: false, isGit: false, checked: 0, gated: [], bypassed: [], findings: [...findings, { code: 'GATE_BYPASS_NOT_GIT', message: `读 git log 失败（不是 git 仓库？）: ${listed.reason}` }], scope: range ?? (all ? 'all' : `last ${limit}`) };
  }
  const ledger = opts.ledger ?? readGateLedger(landing);
  const evidence = new Map();
  for (const row of ledger.values) {
    if (row !== null && typeof row === 'object' && row.gate === 'post-commit' && typeof row.sha === 'string') evidence.set(row.sha, row);
  }

  /** `verdict:'pass'` 的行必须能被物证对上（评审阻断②）：返回未被证实的路径清单 */
  const unverifiedPaths = (row, sha, hitPosix) => {
    const entries = Array.isArray(row.protectedPaths) ? row.protectedPaths : [];
    const byPath = new Map();
    for (const e of entries) {
      if (e !== null && typeof e === 'object' && typeof e.path === 'string') byPath.set(e.path, e);
    }
    const bad = [];
    for (const p of hitPosix) {
      const e = byPath.get(p);
      if (e === undefined || typeof e.committed !== 'string' || e.committed === '') { bad.push(p); continue; }
      const blob = commitBlobSha(repoRoot, sha, p, runGitRaw);
      if (blob.ok !== true || blob.sha256 !== e.committed) { bad.push(p); continue; }
      // G3：.committed !== e.baseline 是**跨形态**比较（提交 blob vs 工作区基线）⇒ 走同一实现
      if (blobMatchesBaseline({ sha256_after: e.baseline, sha256_before: e.baseline, sha256_lf: e.baselineLf ?? null }, blob.buffer).match !== true) bad.push(p);
    }
    return bad;
  };

  const relevant = [];
  for (const commit of listed.commits) {
    if (protection.patterns.length === 0) break;
    const hits = commit.paths.filter((p) => isProtected(p, rules, { projectRoot: repoRoot }).protected === true).map((p) => toPosix(p));
    // ① 删除面：本次提交里被删掉的受保护路径（`--diff-filter=ACMR` 看不见，且**只删**的提交连 git log 都不列）
    const deletedHits = (commit.deleted ?? []).filter((p) => isProtected(p, rules, { projectRoot: repoRoot }).protected === true).map((p) => toPosix(p));
    if (hits.length === 0 && deletedHits.length === 0) continue;
    if (deletedHits.length > 0) {
      relevant.push({ sha: commit.sha, paths: deletedHits, state: 'protected-deleted', ledgerVerdict: null });
      findings.push({
        code: 'GATE_BYPASS_PROTECTED_DELETED',
        message: `提交**删除了受保护路径**（删除也是改动，--diff-filter=ACMR 看不见它）: ${commit.sha.slice(0, 12)}（${deletedHits.join(', ')}）-> 需先留证或改保护面`,
      });
    }
    if (hits.length === 0) continue;
    const row = evidence.get(commit.sha) ?? null;
    // 行内的 verdict 与"现在的基线"可能已经不同（后续又改过），所以只看"当时记了什么"；
    // 但 `pass` 必须附**可对账物证**，否则视为未验证（防"追一行 JSON 洗白"）
    let state;
    let unverified = [];
    if (row === null) state = 'no-evidence';
    else if (row.verdict !== 'pass') state = 'gated-with-violation';
    else {
      unverified = unverifiedPaths(row, commit.sha, hits);
      state = unverified.length === 0 ? 'gated' : 'ledger-unverified';
    }
    relevant.push({ sha: commit.sha, paths: hits, state, ledgerVerdict: row === null ? null : row.verdict, unverified });
    if (state === 'no-evidence') {
      findings.push({
        code: 'GATE_BYPASS_NO_EVIDENCE',
        message: `提交动过受保护路径但**台账里没有任何 post-commit 取证**: ${commit.sha.slice(0, 12)}（${hits.join(', ')}）-> hook 未装/未启用，或那次提交绕过了取证`,
      });
    } else if (state === 'gated-with-violation') {
      findings.push({
        code: 'GATE_BYPASS_UNRECORDED',
        message: `提交动过受保护路径且当次取证结论是**未留证（疑似 --no-verify）**: ${commit.sha.slice(0, 12)}（${hits.join(', ')}）`,
      });
    } else if (state === 'ledger-unverified') {
      findings.push({
        code: 'GATE_BYPASS_LEDGER_UNVERIFIED',
        message: `台账里那条 \`verdict:"pass"\` **对不上物证**（缺 committed / committed≠baseline / committed≠提交内容）: ${commit.sha.slice(0, 12)}（未证实: ${unverified.join(', ')}）-> 台账被手工改写或被裁剪过`,
      });
    }
  }
  const bypassed = relevant.filter((r) => r.state !== 'gated');
  return {
    ok: findings.length === 0,
    isGit: true,
    scope: range ?? (all ? 'all' : `last ${limit}`),
    present: protection.present,
    source: protection.source,
    checked: listed.commits.length,
    relevantCommits: relevant.length,
    gated: relevant.filter((r) => r.state === 'gated'),
    bypassed,
    findings,
    ledgerRows: ledger.lines,
    /** **自曝边界**：台账无签名、不绑定提交树 ⇒ 能改台账的人也能把物证写全；本门只能防"没人看"，不能防"有人伪造" */
    ledgerAuthenticated: false,
  };
}

// ── LF-550 **收尾闸**（close 必答"本批碰到哪几条纪律、靠什么拦住"）────────────
//
// 判据（清单 §5 LF-550）：**答全 → exit=0**；**缺答 → exit≠0**。
// 设计单 L106 的硬要求：拿"不可机检"当免责的，**必须附实证**（LF-2A0 的三件套 + falsifier + 有效期），
//   否则收尾门禁判不通过 —— 所以 `stoppedBy=uncheckable` 必须配 `--declaration`，且复用 LF-2A0 的校验器（不写第二套）。
//
// 三道机检（都是"能把人问住"的那种）：
//   ① 必须**显式作答**：给了 `--hit` 或显式 `--none`；两者都没有 = 沉默，不算答（沉默最容易冒充"本批没碰到纪律"）
//   ② 纪律必须在**账本里真实存在**（canonical 口径，§0.1 ㉖）—— 编一个不存在的纪律名不算答
//   ③ "靠什么拦住"必须是**已知机制**（本系统实现的门 / 项目既有门 / CI / 人工），且 `uncheckable` 必须附实证
// 结论无论通过与否都写进台账（`gate:'close'`），便于事后核对"这批当时是怎么说的"。

/** 已知"拦住它的机制"：dsh-rulekeeper 自己实现的 + 项目既有门 + 远端/人工/用例（未知值一律判红，防止写个漂亮词糊过去） */
export const CLOSE_KNOWN_GATES = Object.freeze([
  'pre-commit', 'post-commit', 'bypass', 'write', 'hooks', 'check', 'uncheckable',
  'test', 'audit', 'ci', 'guard', 'project-check', 'human',
]);

/** 解析 `--hit "<纪律>=<拦住它的机制>"`；格式不对返回 null（由 CLI 判为用法错误） */
export function parseHit(arg) {
  if (typeof arg !== 'string') return null;
  const at = arg.lastIndexOf('=');
  if (at <= 0 || at === arg.length - 1) return null;
  const rule = arg.slice(0, at).trim();
  const stoppedBy = arg.slice(at + 1).trim();
  if (rule === '' || stoppedBy === '') return null;
  return { rule, stoppedBy };
}

/**
 * 收尾闸。
 * @param {object} opts `{projectRoot, landingDir, hits, none, batch, evidence, declaration, now}`
 */
export function closeGate(opts = {}) {
  const landing = resolve(opts.landingDir ?? resolveProjectLanding(resolve(opts.projectRoot ?? process.cwd())));
  const projectRoot = resolve(opts.projectRoot ?? process.cwd());
  const hits = Array.isArray(opts.hits) ? opts.hits : [];
  const none = opts.none === true;
  const evidence = Array.isArray(opts.evidence) ? opts.evidence : [];
  const batch = typeof opts.batch === 'string' && opts.batch !== '' ? opts.batch : '(unnamed)';
  const now = opts.now ?? new Date();
  const findings = [];

  // ① 显式作答
  if (hits.length === 0 && none !== true) {
    findings.push({ code: 'CLOSE_MISSING_ANSWER', message: '没答"本批碰到哪几条纪律"：要么给 --hit "<纪律>=<拦住它的机制>"，要么显式 --none（沉默不算答）' });
  }
  if (hits.length > 0 && none === true) {
    findings.push({ code: 'CLOSE_CONFLICTING_ANSWER', message: '同时给了 --hit 和 --none -> 答不成对' });
  }

  // ② 纪律必须在账本里真实存在（canonical 口径）
  const ledger = readLedger(landing);
  const known = new Map();
  for (const entry of ledger.values ?? []) {
    if (entry === null || typeof entry !== 'object' || typeof entry.rule !== 'string') continue;
    known.set(canonicalRule(entry.rule), entry.rule);
  }
  for (const hit of hits) {
    const canon = canonicalRule(hit.rule);
    if (!known.has(canon)) {
      findings.push({
        code: 'CLOSE_UNKNOWN_RULE',
        message: `纪律在账本里不存在（canonical=${canon}）: ${hit.rule}；账本已知 ${known.size} 条纪律 -> 编一个名字不算答`,
      });
    }
  }

  // ③ "靠什么拦住"必须是已知机制
  for (const hit of hits) {
    if (!CLOSE_KNOWN_GATES.includes(hit.stoppedBy)) {
      findings.push({
        code: 'CLOSE_UNKNOWN_GATE',
        message: `未知的"拦住它的机制": ${hit.stoppedBy}（已知：${CLOSE_KNOWN_GATES.join(' / ')}）`,
      });
    }
  }

  // ④ "不可机检"必须附实证（设计单 L106）—— 复用 LF-2A0 的校验器
  const uncheckableHits = hits.filter((h) => h.stoppedBy === 'uncheckable');
  let declarationResult = null;
  if (uncheckableHits.length > 0) {
    if (opts.declaration === undefined || opts.declaration === null) {
      findings.push({
        code: 'CLOSE_UNCHECKABLE_NO_DECLARATION',
        message: `把"不可机检"当免责（${uncheckableHits.map((h) => h.rule).join('、')}）必须附 --declaration <实证 JSON>（三件套 + falsifier + 有效期），否则收尾不通过`,
      });
    } else {
      declarationResult = validateUncheckableDeclaration(opts.declaration, { now, projectRoot });
      if (declarationResult.ok !== true) {
        findings.push({
          code: 'CLOSE_UNCHECKABLE_INVALID',
          message: `uncheckable 实证不合格：${declarationResult.findings.map((f) => f.code).join(', ') || declarationResult.verdict}`,
        });
      }
    }
  }

  // ⑤ 证据文件必须真的存在（报了就得有实体）；**判决类输出里一律用相对路径**（清单 ㉒：判据必须与 cwd 无关）
  const evidenceMissing = [];
  const evidenceDisplay = [];
  for (const p of evidence) {
    if (typeof p !== 'string' || p.trim() === '') continue;
    // displayPath：项目根内 -> 相对路径；根外 -> `<outside>/<basename>`（跨机稳定，不泄漏本机绝对路径）
    const shown = displayPath(resolve(p), projectRoot);
    evidenceDisplay.push(shown);
    if (!existsSync(resolve(p))) {
      evidenceMissing.push(shown);
      findings.push({ code: 'CLOSE_EVIDENCE_MISSING', message: `证据文件不存在: ${shown}` });
    }
  }

  const row = {
    schema: 1,
    ts: now.toISOString(),
    gate: 'close',
    repo: pathKey(projectRoot),
    batch,
    verdict: findings.length === 0 ? 'pass' : 'rejected',
    answered: hits.length > 0 || none,
    none,
    hits: hits.map((h) => ({ rule: h.rule, stoppedBy: h.stoppedBy })),
    evidence: evidenceDisplay,
    evidenceMissing,
    declaration: declarationResult === null ? null : { ok: declarationResult.ok, rule: declarationResult.detail?.rule ?? null },
    findings: findings.map((f) => f.code),
  };
  let ledgerWrite = null;
  try {
    mkdirSync(join(landing, 'logs'), { recursive: true });
    const appended = appendGateRow(landing, row);
    ledgerWrite = { ok: appended.ok === true, path: GATE_LEDGER_REL, reason: appended.reason ?? null };
    if (appended.ok !== true) findings.push({ code: 'CLOSE_LEDGER_FAILED', message: `收尾台账写入失败: ${appended.reason}` });
  } catch (err) {
    ledgerWrite = { ok: false, path: GATE_LEDGER_REL, reason: String(err?.message ?? err) };
    findings.push({ code: 'CLOSE_LEDGER_FAILED', message: `收尾台账写入异常: ${String(err?.message ?? err)}` });
  }

  return {
    ok: findings.length === 0,
    batch,
    answered: hits.length > 0 || none,
    none,
    hits,
    evidence,
    evidenceMissing,
    knownRules: known.size,
    uncheckableHits: uncheckableHits.length,
    declarationResult,
    ledger: ledgerWrite,
    findings,
  };
}

// ── LF-540 **远端防线**（服务端 CI / 受保护分支；**新 clone 没有 hook** 时的兜底）────────────
//
// 判据（清单 §3 LF-540）：**删掉本机 hook 之后 CI 仍拦得住** → 通过；**CI 也放行** → 必红。
//
// 为什么必须有这一条：LF-500/LF-510 的阻断与取证都挂在**本机 hook** 上，而 `git clone`
//   **不复制 hook**。新同事、新机器、CI 机器上都没有这层 —— "换台机器提交"就是绕过本机门的最短路径
//   （L508/L511 同族：**判据不能只在本机成立**）。所以服务端要有一道**不依赖本机 hook** 的等价门。
//
// **自曝边界**（同 LF-560 的 L4 纪律，宁可明说也不假绿）：
//   本条只交付「服务端入口 + 本机等价模拟」。`CI_CARRIER_DONE=false` —— 本仓无远端 / 未 push /
//   分支保护需要 token（属老板决策），因此 **GitHub 侧的真实执行与分支保护设置在本条内未验证**。
//   代码据此设闸：`--claim-remote` 会被判红 —— 不允许拿本机模拟冒充远端凭证。
//
// 四道机检（都能把"装饰品"戳穿）：
//   ① **保护面不能为空**：patterns=0 ⇒ 对任何提交都放行 = **空转闸**（vacuous gate）→ 判红。
//      "装了 CI" 与 "CI 能拦" 是两件事；空保护面下的绿灯是假绿（本轮实测：本仓 PROT_PRESENT=false）。
//   ② **范围对账**：`base..head`（或 `--all`）里"动过受保护路径且台账无取证"的提交 → 判红
//      （**复用 LF-510 的同一实现**，不写第二套：契约面上只多一个 `range` 入口）
//   ③ **CI 配置完整性**：工作流文件必须与 `ciWorkflowYaml()` 生成内容**逐字一致**
//      （缺文件 = 新 clone 无任何门；被手改放宽 = `|| true` 式假绿 → 两种都判红）
//   ④ **不得冒充远端**：`--claim-remote` 且无远端凭证 → 判红

/** 服务端入口的工作流文件（相对项目根）。目录形态与 GitHub Actions 对齐 */
export const CI_WORKFLOW_REL = '.github/workflows/dsh-rulekeeper-gate.yml';
/** 生成物里引用的 dsh-rulekeeper 入口（上游仓布局；消费方可用 `--bin` 覆盖） */
export const CI_BIN_REL = 'bin/rk-gate.mjs';
/** 本包根目录（`src/gate.mjs` 上溯两级） */
const PKG_ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * **自动推算**工作流里该引用的入口路径（相对仓库根）——两种消费方布局都不用手传参：
 *   · 包**就是**仓库根（本仓形态） → `bin/rk-gate.mjs`
 *   · 包被 vendored 在仓内子目录（消费方形态，如 `<repo>/dsh-rulekeeper/`） → `dsh-rulekeeper/bin/rk-gate.mjs`
 * 推算不出（包在仓外/相对路径越界）时回落到 `CI_BIN_REL`；显式 `--bin` 永远优先。
 */
export function autoCiBinRel(repoRoot) {
  if (typeof repoRoot !== 'string' || repoRoot.trim() === '') return CI_BIN_REL;
  const root = resolve(repoRoot);
  // ① **看仓里的真实布局**（比"猜代码在哪"可靠；夹具仓/消费方仓都能自动认出来）
  for (const candidate of ['bin/rk-gate.mjs', 'dsh-rulekeeper/bin/rk-gate.mjs']) {
    if (existsSync(join(root, candidate))) return candidate;
  }
  // ② 都找不到：若本包就在这个仓里，按相对位置算；换算不出来再回落默认
  const rel = toPosix(relative(root, join(PKG_ROOT_DIR, 'bin', 'rk-gate.mjs')));
  return rel.startsWith('..') || isAbsolute(rel) ? CI_BIN_REL : rel;
}/** **自曝边界**：远端 CI 是否真的执行过 —— 本机无法自证，恒为 false，谁要标 true 必须另附远端运行记录 */
export const CI_CARRIER_DONE = false;
export const CI_CARRIER_REASON = '本机代码无法自证 GitHub 侧事实（远端是否真执行过、分支保护是否设置）：要标 true 必须另附远端运行凭证（如 check-run 注解），本条不代替凭证、也不由本机推断';

/** 生成物里的 node 版本**唯一来源** = 本包 `package.json` 的 `engines.node`（避免"CI 跑 20、engines 要 22"这类自相矛盾） */
function engineNodeMajor() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const m = /(\d+)/.exec(String(pkg?.engines?.node ?? ''));
    return m === null ? '22' : m[1];
  } catch {
    return '22';
  }
}
export const ENGINE_NODE = engineNodeMajor();

/** test 任务的脚本正文 —— **单一来源**：生成物写盘用它，`test/ci-annotate.test.mjs` 也直接跑它
 *
 * 为什么不是一句 `node --test`（2026-09-16 实测的事实）：
 *   · GitHub 的 job 日志下载接口**要凭证**（无 token 实测 403 `Must have admin rights to Repository.`）；
 *   · 而 check-run **注解（annotation）无凭证可读**（实测 HTTP 200）——失败信息只有走注解才对外可见。
 * 所以失败时必须把「用例名 + 断言信息 + 文件:行」打成 `::error::` 工作流命令：
 * 只把输出留在日志里，仓外只读的审阅者（含本项目的自检流程）就看不到失败原因。
 * 输出转 TAP 是为了**机器可解析**（`spec` 是人看的、`tap` 才带 key: value 诊断块）。
 */
export const CI_TEST_SCRIPT = [
  'set +e',
  'node --test --test-reporter=tap > "$RUNNER_TEMP/rk-tap.txt" 2>&1',
  'rc=$?',
  'if [ "$rc" -eq 0 ]; then',
  '  # 成功也发一条 ::notice:: 注解（注解无凭证可读）⇒ "本平台真跑过 N 条用例"成了可公开复核的凭证，',
  '  # 而不是只能看结论色的自述（本仓此前 README 只能写 macOS 未实测，就是缺这条凭证）',
  '  summary=$(grep -E \'^# (tests|pass|fail|skipped) \' "$RUNNER_TEMP/rk-tap.txt" | tr \'\\n\' \' \')',
  '  echo "::notice::node --test 通过：$summary"',
  '  tail -n 5 "$RUNNER_TEMP/rk-tap.txt"',
  '  exit 0',
  'fi',
  'echo "::error::node --test 失败（rc=$rc）：先把失败的用例名占满注解配额，再补第一条的关键诊断"',
  'n=$(grep -c -E \'not ok \' "$RUNNER_TEMP/rk-tap.txt")',
  'echo "::error::失败行共 $n 条（含文件级汇总行）；GitHub 每步只展示 10 条注解，超出的看本步日志"',
  'grep -E \'not ok \' "$RUNNER_TEMP/rk-tap.txt" | head -n 8 | while IFS= read -r line; do echo "::error::$line"; done',
  'grep -A 16 -E \'not ok \' "$RUNNER_TEMP/rk-tap.txt" \\',
  '  | grep -vE \'duration_ms:|type: |name: |stack:|^--$|^ *-{3} *$|^ *\\.{3} *$|^ *$\' \\',
  '  | head -n 10 \\',
  '  | while IFS= read -r line; do echo "::error::$line"; done',
  'tail -n 60 "$RUNNER_TEMP/rk-tap.txt"',
  'exit "$rc"',
];

/** 工作流内容**单一来源**：生成与校验都走它（L474：同一语义只许一套实现）
 *
 * `run:` 行两种形态（**`range` 参数不再是死参数**，独立评审 中危①）：
 *   · 默认 = **事件感知**：`--base "${{ github.event.before }}" --head "${{ github.sha }}"`
 *     —— push 事件判"这次推上来的范围"；`before` 缺失/全零（首次 push、pull_request 事件）时 `--base` 为空，
 *     `ciGate` 自动退回全历史（fail-closed：不会因为拿不到范围就放行，`/^0+$/` 的首次 push 哨兵值也按空处理）。
 *   · 显式 `range`（如 `--all`）= 逐字使用，供"首次接入/一次性 backfill"场景生成。
 */
export function ciWorkflowYaml(opts = {}) {
  const nodeVersion = String(opts.nodeVersion ?? ENGINE_NODE);
  const binPath = toPosix(String(opts.binPath ?? (opts.projectRoot ? autoCiBinRel(opts.projectRoot) : CI_BIN_REL)));
  const range = typeof opts.range === 'string' && opts.range.trim() !== '' ? opts.range.trim() : null;
  const runLine = range !== null
    ? `        run: node ${binPath} ci ${range}`
    : `        run: node ${binPath} ci --base "\${{ github.event.before }}" --head "\${{ github.sha }}"`;
  return [
    '# 本文件由 dsh-rulekeeper 生成，请勿手改：`node <bin> ci --write-workflow`',
    '# 源：dsh-rulekeeper/src/gate.mjs 的 ciWorkflowYaml()（手改会被 `rk-gate ci` 的完整性校验判红）',
    '# 范围口径：push 用 github.event.before..github.sha；拿不到 before（首次 push / pull_request）退回 --all（fail-closed）',
    'name: dsh-rulekeeper-gate',
    'on:',
    '  push:',
    '  pull_request:',
    'jobs:',
    '  gate:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v5',
    '        with:',
    '          fetch-depth: 0',
    '      - uses: actions/setup-node@v5',
    '        with:',
    `          node-version: '${nodeVersion}'`,
    '      - name: dsh-rulekeeper 服务端防线（不依赖本机 hook：新 clone 也拦得住）',
    runLine,
    // 2026-09-16 新增：**跨平台测试任务**（此前 CI 只跑门禁、不跑用例）。
    // 为什么：本仓只在 Windows/Linux 上人工跑过用例；macOS 从未真跑过（README 曾如实标"未实测"）。
    //   把它放进 CI 矩阵，既补 macOS 实测，又让"CI 真的跑过用例"成为可引用的凭证。
    '  test:',
    '    strategy:',
    '      fail-fast: false',
    '      matrix:',
    '        os: [ubuntu-latest, macos-latest]',
    '    runs-on: ${{ matrix.os }}',
    '    steps:',
    '      - uses: actions/checkout@v5',
    '      - uses: actions/setup-node@v5',
    '        with:',
    `          node-version: '${nodeVersion}'`,
    '      - name: 全量用例（Windows 之外的两平台同源复核）',
    // 脚本正文来自 CI_TEST_SCRIPT（**同一份**东西既写盘也被用例真跑，防"生成物 ≠ 实测的东西"）
    '        run: |',
    ...CI_TEST_SCRIPT.map((l) => `          ${l}`),
    '',
  ].join('\n');
}

/** 读工作流文件（换行归一：内容比较不吃 CRLF/LF 差异 —— L494 家族） */
export function readCiWorkflow(projectRoot, rel = CI_WORKFLOW_REL) {
  const file = join(resolve(projectRoot), rel);
  if (!existsSync(file)) return { present: false, file, text: null, reason: 'not-found' };
  try {
    return { present: true, file, text: readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), reason: null };
  } catch (err) {
    return { present: false, file, text: null, reason: String(err?.message ?? err) };
  }
}

/** 生成工作流（**写盘是显式动作**：不给默认开 —— 同 precommit 的 `--clear-index` 纪律） */
export function writeCiWorkflow(opts = {}) {
  const projectRoot = resolve(opts.projectRoot ?? process.cwd());
  const rel = opts.rel ?? CI_WORKFLOW_REL;
  const file = join(projectRoot, rel);
  const text = ciWorkflowYaml(opts);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, 'utf8'); // LF 结尾：内容 sha 与生成方一致（Windows 上写字面量换行不受 CRLF 影响）
    return { ok: true, file, rel, bytes: Buffer.byteLength(text, 'utf8'), reason: null };
  } catch (err) {
    return { ok: false, file, rel, bytes: 0, reason: String(err?.message ?? err) };
  }
}

/** 工作流完整性校验：存在 + 与生成内容逐字一致 */
export function verifyCiWorkflow(opts = {}) {
  const projectRoot = resolve(opts.projectRoot ?? process.cwd());
  const rel = opts.rel ?? CI_WORKFLOW_REL;
  const expected = ciWorkflowYaml(opts);
  const expectedSha = sha256OfText(expected);
  const got = readCiWorkflow(projectRoot, rel);
  if (got.present !== true) return { ok: false, rel, present: false, reason: got.reason, expectedSha, actualSha: null };
  const actualSha = sha256OfText(got.text);
  const same = got.text === expected;
  return { ok: same, rel, present: true, reason: same ? null : 'content-mismatch', expectedSha, actualSha };
}

/**
 * 服务端 CI 等价门（LF-540）。
 * @returns {{ok, scope, protection, hooksInstalled, hookCarriers, checked, relevantCommits, bypassed, workflow, carrier, findings}}
 */
export function ciGate(opts = {}) {
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());
  const landing = resolve(opts.landingDir ?? resolveProjectLanding(repoRoot));
  const runGitRaw = opts.runGitRaw ?? defaultRunGitRaw;
  const rawBase = typeof opts.base === 'string' ? opts.base.trim() : '';
  // 事件感知入口：push 事件的 `before` 在"首次 push"时是全零 sha，pull_request 事件里干脆没有
  // ⇒ 一律按"没有 base"处理 → 退回全历史（fail-closed：不会因为拿不到范围就放行）
  const base = rawBase === '' || /^0+$/.test(rawBase) ? null : rawBase;
  const head = typeof opts.head === 'string' && opts.head.trim() !== '' ? opts.head.trim() : 'HEAD';
  const all = opts.all === true || base === null;
  const range = base === null ? null : `${base}..${head}`;
  const findings = [];

  // ① 本机 hook 现状：**只作信息上报**。新 clone 天然没有 hook（这正是本条存在的理由），
  //    所以"没装 hook"在这里**不是**失败 —— 失败的是"没装 hook 又没有任何服务端等价门"。
  const hp = runGitRaw(repoRoot, ['config', '--get', 'core.hooksPath']);
  const hpRaw = hp.ok ? hp.buffer.toString('utf8').trim() : '';
  const hooksPathRaw = hpRaw === '' ? null : hpRaw;
  // ㉒：上报值不得是绝对路径/盘符 —— 一律先相对化（评审 建议①）
  const relFor = (abs) => {
    const full = isAbsolute(abs) ? abs : join(repoRoot, abs);
    const r = relative(repoRoot, full);
    if (r === '') return '.';
    return r.startsWith('..') ? `<outside>/${basename(full)}` : toPosix(r);
  };
  const hooksPath = hooksPathRaw === null ? null : relFor(hooksPathRaw);
  const hooksDir = hooksPathRaw === null
    ? join(repoRoot, '.git', 'hooks')
    : (isAbsolute(hooksPathRaw) ? hooksPathRaw : join(repoRoot, hooksPathRaw));
  const hookCarriers = ['pre-commit', 'post-commit'].map((name) => ({ name, installed: existsSync(join(hooksDir, name)) }));
  const hooksInstalled = hookCarriers.every((h) => h.installed === true);

  // ② 保护面非空（空转闸判红）+ **写窄**下限（评审 中危③：保护面只写"没人动的文件"= 形同没保护）
  const protection = effectiveProtection(landing);
  for (const f of protection.findings) findings.push({ code: `CI_${f.code}`, message: f.message });
  let matchedFiles = 0;
  if (protection.present === true) {
    const rules = { protected_paths: protection.patterns };
    const found = discoverFiles({ projectRoot: repoRoot, limit: opts.limit ?? SCAN_LIMIT });
    for (const abs of found.files) {
      const rel = normalizeTarget(abs, repoRoot);
      if (rel !== null && isProtected(rel, rules, { projectRoot: repoRoot }).protected === true) matchedFiles++;
    }
  }
  if (protection.present !== true) {
    findings.push({
      code: 'CI_VACUOUS_NO_PROTECTION',
      message: '保护面为空（protected_paths=0）：这道 CI 对任何提交都会放行 = **空转闸**；先按 LF-230 配好受保护路径，再谈"CI 拦得住"',
    });
  } else if (matchedFiles === 0) {
    findings.push({
      code: 'CI_PROTECTION_MATCHES_NOTHING',
      message: `保护面**匹配不到任何真实文件**（patterns=${protection.patterns.length}，匹配 0 个）= 写窄即绿的空转闸；请让 protected_paths 至少覆盖真实存在的受保护文件`,
    });
  }

  // ③ 范围对账（复用 LF-510：同一判据只此一套实现）+ ④ 工作流完整性
  const ledger = readGateLedger(landing);
  const recon = bypassRecon({ repoRoot, landingDir: landing, range, all, limit: opts.limit, runGitRaw, protection, ledger });
  for (const f of recon.findings) findings.push({ code: `CI_${f.code}`, message: f.message });

  // 入口路径必须与**生成器**同一个来源（⑰ 单一实现）：此前这里写 `opts.binPath ?? CI_BIN_REL`，
  // 而生成器已改成 autoCiBinRel() ⇒ "写的是 A、查的是 B"，CI_BIN_MISSING 假红（2026-09-16 实测）。
  const binRel = toPosix(String(opts.binPath ?? autoCiBinRel(repoRoot)));
  const binAbs = isAbsolute(binRel) ? binRel : join(repoRoot, binRel);
  const binPresent = existsSync(binAbs);
  const binSha256 = binPresent ? sha256OfFile(binAbs) : null;
  if (!binPresent) {
    findings.push({
      code: 'CI_BIN_MISSING',
      message: `工作流指向的入口不存在: ${binRel} —— 这是**假 CI**（上机必然报错 = 等于没有门；与 LF-520 的"假安装"同族）`,
    });
  } else if (typeof opts.binSha === 'string' && opts.binSha.trim() !== '' && opts.binSha.trim() !== binSha256) {
    // 内容固定是**可选**的：钉死在生成物里会随每次改代码立即失配（假红），所以只提供显式 `--bin-sha`
    findings.push({
      code: 'CI_BIN_SHA_MISMATCH',
      message: `入口内容与 --bin-sha 不符: ${binRel} expected=${opts.binSha.trim().slice(0, 12)} actual=${binSha256.slice(0, 12)}`,
    });
  }
  const workflow = verifyCiWorkflow({
    projectRoot: repoRoot,
    rel: opts.workflowRel,
    binPath: opts.binPath,
    nodeVersion: opts.nodeVersion,
    range: opts.workflowRange,
  });
  if (workflow.present !== true) {
    findings.push({
      code: 'CI_WORKFLOW_MISSING',
      message: `服务端入口缺失: ${workflow.rel} —— 新 clone 上没有任何门；用 \`rk-gate ci --write-workflow\` 生成`,
    });
  } else if (workflow.ok !== true) {
    findings.push({
      code: 'CI_WORKFLOW_TAMPERED',
      message: `${workflow.rel} 与生成内容不一致（被手改/被放宽？）expected=${workflow.expectedSha.slice(0, 12)} actual=${workflow.actualSha.slice(0, 12)}；改模板后重新 --write-workflow 生成`,
    });
  }

  // ⑤ 不许冒充远端
  if (opts.claimRemote === true) {
    findings.push({ code: 'CI_REMOTE_CLAIM_UNSUPPORTED', message: `不许声称远端 CI 已执行：${CI_CARRIER_REASON}` });
  }

  return {
    ok: findings.length === 0,
    isGit: recon.isGit === true,
    scope: range ?? (all ? 'all' : 'range'),
    protection: { present: protection.present, source: protection.source, patterns: protection.patterns.length, matchedFiles },
    hooksPath, // 已经相对化（**不落绝对路径**，㉒）
    hooksInstalled,
    hookCarriers,
    checked: recon.checked,
    relevantCommits: recon.relevantCommits ?? 0,
    gated: recon.gated ?? [],
    bypassed: recon.bypassed ?? [],
    workflow: { rel: relFor(workflow.rel), present: workflow.present, ok: workflow.ok, expectedSha: workflow.expectedSha, actualSha: workflow.actualSha },
    bin: { rel: binRel, present: binPresent, sha256: binSha256 },
    carrier: { done: CI_CARRIER_DONE, reason: CI_CARRIER_REASON },
    /** **自曝边界**：台账无签名/不绑定提交树（见 `bypassRecon` 注释），本门能防"没人看"，不能防"有人伪造" */
    ledgerAuthenticated: recon.ledgerAuthenticated === true,
    findings,
  };
}


/**
 * 台账写入**单点**（LF-340 收尾）：门禁台账行里的自由文本（message/batch/evidence 路径…）先过 `redactValue`。
 * 为什么不改 `appendLine`：那是**所有** jsonl（含快照索引的 path/backup）的公共底；对路径做脱敏会破坏 8 字段契约与检索。
 */
export function appendGateRow(landing, row) {
  // LF-800 写入闸：off 档零副作用（门禁台账也不写）
  const gate = offGuard(landing, 'logs/gate.jsonl');
  if (gate.off) return { ok: true, skipped: true, bytes: 0, reason: gate.finding.message };
  const scrubbed = redactValue(row);
  return appendLine(gateLedgerPath(landing), scrubbed.value);
}