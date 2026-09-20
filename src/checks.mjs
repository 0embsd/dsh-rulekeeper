// dsh-rulekeeper · LF-250 三类可机检 check + LF-260 形态守卫
//
// 三类（其余一律标"不可机检"，见 rules.json 的 checks 白名单）：
//   file_untracked_change : 改动了 <path> 但 snapshots 无对应记录 / 当前 sha256 与记录不符
//   output_shape          : 输出行数 / 最长行 / 约定结果行（如 PROJ_*_RESULT=）缺失或超界
//   invalid_reference     : 文本里的 <file:line> / <§N> 与实际不符（文件不存在 / 行号越界 / 无该标题）
//
// LF-260 形态守卫与 `output_shape` **合并实现**（`check --shape` 只是入口）：
//   判据阈值必须**随冻结夹具的 sha256** 校验——夹具被改而阈值未更新就报 SHAPE_FIXTURE_DRIFT
//   （来历：LF-32 曾把 703/776 硬编码进清单，判据会随夹具腐烂）
//
// 判决一律是**确定性 JSON**（键按码位排序、无时间戳、无绝对路径）——这样才能与
// `test/fixtures/expected/<name>.json` 做**逐字**比对（LF-250 判据）。
//
// 归属：core 模块。零依赖：只用 node:*。

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readLines } from './append.mjs';
import { normalizeTarget } from './rules.mjs';
import { checkUncheckable } from './uncheckable.mjs';
import { pathKey, relativeToRoot, toPosix } from './platform/paths.mjs';

export const CHECK_KINDS = Object.freeze(['file_untracked_change', 'output_shape', 'invalid_reference', 'checker']);

/** 包根（src/checks.mjs → 上溯 2 级）：冻结源与夹具的定位基准 */
export const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const SHAPE_BASELINE_PATH = join(PKG_ROOT, 'test', 'fixtures', 'checks', 'shape-baseline.json');

function sha256Of(text) {
  // 同步、零依赖：用 node:crypto 的 createHash
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 行数（按 \n 切分、末行空串丢弃；**含行尾 CR**，与 maxLineLength 同口径） */
function shapeOf(text) {
  const rawLines = text.split('\n');
  const lines = rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines;
  let maxLineLength = 0;
  for (const line of lines) maxLineLength = Math.max(maxLineLength, line.length);
  return { lines: lines.length, maxLineLength, sha256: sha256Of(text) };
}

/** 读文本文件：目录/不可读一律**返回失败**而不是抛裸异常（LF-250 复核 B3） */
export function readTextFile(file) {
  try {
    if (!statSync(file).isFile()) return { ok: false, reason: '不是普通文件（目录/链接/设备）' };
    return { ok: true, text: readFileSync(file, 'utf8') };
  } catch (err) {
    return { ok: false, reason: `${err.code ?? 'ERR'}: ${err.message}` };
  }
}

/**
 * 判决里出现的路径一律**相对项目根**（判据里禁绝对路径；也让 fixture 与机器无关）。
 * 不在根下时返回 `<outside>/<basename>` —— 前缀本身就是"越界"标记，机器可读且**跨机稳定**
 * （旧实现退回绝对路径：同一命令换个 cwd 判决字节就变了，判据不可跨机复核；LF-250 复核 B1）。
 */
export function displayPath(file, projectRoot) {
  const rel = relativeToRoot(file, projectRoot);
  if (rel !== null && rel !== '.' && rel !== '') return rel;
  const posix = toPosix(file);
  return `<outside>/${posix.slice(posix.lastIndexOf('/') + 1)}`;
}

/** 冻结源（LF-260）：file -> {lines, maxLineLength, bytes, sha256}；缺文件/坏 JSON 一律返回 null（视为"没有冻结值"） */
export function loadShapeBaseline(path = SHAPE_BASELINE_PATH) {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const fx = parsed?.fixtures;
    return (fx !== null && typeof fx === 'object' && !Array.isArray(fx)) ? fx : null;
  } catch {
    return null;
  }
}

/** 冻结源的键：相对**包根**的 posix 路径；文件在包外则 null（包外样本必须显式给 --sha256） */
export function shapeBaselineKey(file) {
  const rel = relativeToRoot(file, PKG_ROOT);
  if (rel === null || rel === '.' || rel === '') return null;
  return rel;
}

/** 判决对象：键顺序由 jsonStable 在输出层统一，这里只保证字段集合固定 */
function verdict(kind, ok, verdictName, detail, findings = []) {
  return {
    kind,
    ok,
    verdict: verdictName,
    detail,
    findings: findings.map((f) => ({ code: f.code, message: f.message })),
  };
}

/**
 * file_untracked_change：受保护路径被改动但账本/快照无记录。
 * @param {{file: string, landingDir: string, projectRoot?: string}} ctx
 */
export function checkUntrackedChange(ctx = {}) {
  const { file, landingDir } = ctx;
  const projectRoot = ctx.projectRoot ?? process.cwd();
  const normalized = normalizeTarget(file, projectRoot);
  if (normalized === null || !existsSync(file)) {
    return verdict('file_untracked_change', false, 'violation',
      { path: normalized, exists: false },
      [{ code: 'UNTRACKED_FILE_MISSING', message: `目标文件不存在: ${normalized ?? file}` }]);
  }
  const read = readTextFile(file);
  if (!read.ok) {
    return verdict('file_untracked_change', false, 'violation',
      { path: normalized, exists: true, unreadable: read.reason },
      [{ code: 'UNTRACKED_FILE_UNREADABLE', message: `目标文件不可读（${read.reason}）: ${normalized}` }]);
  }
  const content = read.text;
  const actualSha = sha256Of(content);
  const indexPath = `${landingDir}/snapshots/index.jsonl`.replace(/\\/g, '/');
  const snapshotRead = readLines(indexPath);
  const key = pathKey(normalized);
  const records = snapshotRead.values.filter((row) => row !== null && typeof row === 'object'
    && typeof row.path === 'string' && pathKey(row.path) === key);
  const latest = records.length === 0 ? null : records[records.length - 1];
  const snapshotHealth = {
    badLines: snapshotRead.badLines,
    oversized: snapshotRead.oversized,
    truncatedTail: snapshotRead.truncatedTail,
    missing: snapshotRead.missing,
  };
  const detail = {
    path: normalized,
    exists: true,
    sha256: actualSha,
    snapshotRecords: records.length,
    snapshotHealth,
    recordedSha256: latest === null ? null : (latest.sha256_after ?? latest.sha256_before ?? null),
  };
  // 证据基座不完整（坏行/超长行/半行）→ 不许静默 pass：此时"没记录"与"记录读不出来"不可区分
  const unhealthy = snapshotHealth.badLines > 0 || snapshotHealth.oversized > 0 || snapshotHealth.truncatedTail === true;
  if (unhealthy) {
    return verdict('file_untracked_change', false, 'violation', detail,
      [{ code: 'UNTRACKED_SNAPSHOT_UNHEALTHY', message: `snapshots 基座不完整（badLines=${snapshotHealth.badLines} oversized=${snapshotHealth.oversized} truncatedTail=${snapshotHealth.truncatedTail}）——"无记录"与"记录读不出"不可区分` }]);
  }
  if (latest === null) {
    return verdict('file_untracked_change', false, 'violation', detail,
      [{ code: 'UNTRACKED_CHANGE_NO_SNAPSHOT', message: `${normalized} 已存在且被改动，但 snapshots 无对应记录` }]);
  }
  const recorded = latest.sha256_after ?? latest.sha256_before ?? null;
  if (recorded !== actualSha) {
    return verdict('file_untracked_change', false, 'violation', detail,
      [{ code: 'UNTRACKED_CHANGE_SHA_MISMATCH', message: `${normalized} 当前 sha256 与最近快照记录不符` }]);
  }
  return verdict('file_untracked_change', true, 'pass', detail, []);
}

/**
 * output_shape：行数 / 最长行 / 约定结果行。
 * @param {{file: string, expect?: {minLines?: number, maxLines?: number, maxLineLength?: number, resultLinePattern?: string}}} ctx
 */
export function checkOutputShape(ctx = {}) {
  const { file } = ctx;
  const expect = ctx.expect ?? {};
  const resultLinePattern = expect.resultLinePattern ?? '^(?:PROJ|LF)_[A-Z0-9_]*RESULT=(?:pass|fail)$';
  const projectRoot = ctx.projectRoot ?? process.cwd();
  if (!existsSync(file)) {
    return verdict('output_shape', false, 'violation', { path: displayPath(file, projectRoot), exists: false },
      [{ code: 'SHAPE_FILE_MISSING', message: `目标文件不存在: ${displayPath(file, projectRoot)}` }]);
  }
  const read = readTextFile(file);
  if (!read.ok) {
    return verdict('output_shape', false, 'violation', { path: displayPath(file, projectRoot), unreadable: read.reason },
      [{ code: 'SHAPE_FILE_UNREADABLE', message: `目标文件不可读（${read.reason}）: ${displayPath(file, projectRoot)}` }]);
  }
  const text = read.text;
  const { lines: lineCount, maxLineLength } = shapeOf(text);
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const re = new RegExp(resultLinePattern);
  const resultLine = lines.find((l) => re.test(l.trim())) ?? null;
  const detail = {
    path: displayPath(file, projectRoot),
    lines: lineCount,
    maxLineLength,
    resultLine,
    expect: {
      minLines: expect.minLines ?? null,
      maxLines: expect.maxLines ?? null,
      maxLineLength: expect.maxLineLength ?? null,
      resultLinePattern,
    },
  };
  const findings = [];
  if (resultLine === null) {
    findings.push({ code: 'SHAPE_RESULT_LINE_MISSING', message: `缺少约定结果行（模式 ${resultLinePattern}）` });
  }
  if (expect.minLines !== undefined && lines.length < expect.minLines) {
    findings.push({ code: 'SHAPE_TOO_FEW_LINES', message: `行数 ${lines.length} < 下限 ${expect.minLines}` });
  }
  if (expect.maxLines !== undefined && lines.length > expect.maxLines) {
    findings.push({ code: 'SHAPE_TOO_MANY_LINES', message: `行数 ${lines.length} > 上限 ${expect.maxLines}` });
  }
  if (expect.maxLineLength !== undefined && maxLineLength > expect.maxLineLength) {
    findings.push({ code: 'SHAPE_LINE_TOO_LONG', message: `最长行 ${maxLineLength} > 上限 ${expect.maxLineLength}` });
  }
  if (lines.length === 0) findings.push({ code: 'SHAPE_EMPTY_OUTPUT', message: '输出为空（疑似塌陷）' });
  return findings.length === 0
    ? verdict('output_shape', true, 'pass', detail, [])
    : verdict('output_shape', false, 'violation', detail, findings);
}

/**
 * invalid_reference：`<path>:<line>` 与 `§N` 的引用核对。
 * @param {{file: string, projectRoot?: string, scopeFile?: string}} ctx scopeFile 用于校验 §N（默认取被检文件自身）
 */
export function checkInvalidReference(ctx = {}) {
  const { file } = ctx;
  const projectRoot = ctx.projectRoot ?? process.cwd();
  const scopeFile = ctx.scopeFile ?? file;
  if (!existsSync(file)) {
    return verdict('invalid_reference', false, 'violation', { path: displayPath(file, projectRoot), exists: false },
      [{ code: 'REF_FILE_MISSING', message: `被检文件不存在: ${displayPath(file, projectRoot)}` }]);
  }
  const read = readTextFile(file);
  if (!read.ok) {
    return verdict('invalid_reference', false, 'violation', { path: displayPath(file, projectRoot), unreadable: read.reason },
      [{ code: 'REF_FILE_UNREADABLE', message: `被检文件不可读（${read.reason}）: ${displayPath(file, projectRoot)}` }]);
  }
  const text = read.text;
  const baseDir = toPosix(file).replace(/\/[^/]*$/, '');
  const findings = [];
  const lineCountCache = new Map();
  const fileRefs = [];

  // ① path:line 形态（不吃 http:// 与 Windows 盘符）
  const fileLineRe = /(?<![\w:/])([\w./\\-]+\.(?:md|txt|json|jsonl|go|ps1|mjs|js|sh|ya?ml)):(\d+)/g;
  let m;
  while ((m = fileLineRe.exec(text)) !== null) {
    const rawPath = m[1];
    const line = Number(m[2]);
    const candidates = [rawPath, `${baseDir}/${rawPath}`, `${toPosix(projectRoot)}/${rawPath}`, `${projectRoot}\\${rawPath.replace(/\//g, '\\')}`];
    const found = candidates.find((p) => existsSync(p));
    if (found === undefined) {
      fileRefs.push({ ref: `${rawPath}:${line}`, status: 'missing-file' });
      findings.push({ code: 'REF_FILE_NOT_FOUND', message: `引用文件不存在: ${rawPath}` });
      continue;
    }
    // 行数缓存：同一文件被多次引用时不做重复整读（复核实测 300 条引用 × 4MB = 5.5s）
    let lineCount = lineCountCache.get(found);
    if (lineCount === undefined) {
      const target = readTextFile(found);
      if (!target.ok) {
        fileRefs.push({ ref: `${rawPath}:${line}`, status: 'unreadable', reason: target.reason });
        findings.push({ code: 'REF_FILE_UNREADABLE', message: `引用目标不可读（${target.reason}）: ${rawPath}` });
        continue;
      }
      lineCount = shapeOf(target.text).lines;
      lineCountCache.set(found, lineCount);
    }
    if (line > lineCount) {
      fileRefs.push({ ref: `${rawPath}:${line}`, status: 'line-out-of-range', lineCount });
      findings.push({ code: 'REF_LINE_OUT_OF_RANGE', message: `${rawPath}:${line} 越界（该文件仅 ${lineCount} 行）` });
    } else {
      fileRefs.push({ ref: `${rawPath}:${line}`, status: 'ok', lineCount });
    }
  }

  // ② §N 形态：scope 文件里必须存在编号为 N 的标题
  const sectionRefs = [];
  const scopeText = (() => {
    const r = readTextFile(scopeFile);
    return r.ok ? r.text : '';
  })();
  const headings = new Set();
  for (const line of scopeText.split('\n')) {
    const h = /^#{1,6}\s*(\d+)[.．、]?/.exec(line.trim());
    if (h !== null) headings.add(Number(h[1]));
  }
  const sectionRe = /§(\d+)/g;
  while ((m = sectionRe.exec(text)) !== null) {
    const n = Number(m[1]);
    if (headings.has(n)) sectionRefs.push({ ref: `§${n}`, status: 'ok' });
    else {
      sectionRefs.push({ ref: `§${n}`, status: 'missing-heading' });
      findings.push({ code: 'REF_SECTION_NOT_FOUND', message: `§${n} 在 ${displayPath(scopeFile, projectRoot)} 中无对应标题` });
    }
  }

  const detail = { path: displayPath(file, projectRoot), scope: displayPath(scopeFile, projectRoot), fileRefs, sectionRefs, headings: [...headings].sort((a, b) => a - b) };
  return findings.length === 0
    ? verdict('invalid_reference', true, 'pass', detail, [])
    : verdict('invalid_reference', false, 'violation', detail, findings);
}

/**
 * LF-260 形态守卫：阈值随**冻结夹具的 sha256** 绑定——夹具变了而阈值没更新就报漂移。
 *
 * 冻结值来源（优先级）：显式 `frozenSha256`（`--sha256`）> 包内冻结源 `shape-baseline.json`（`baseline`）> 无。
 * **无冻结值 = 红**（`SHAPE_NO_FROZEN_SHA`）——与 `compareWithExpected` 的"缺基准不算通过"同一原则：
 * 旧实现把缺省阈值静默丢掉后输出 `pass`/rc=0，属**假绿**（LF-250 复核 B2/B4）。
 *
 * @param {{file: string, expectLines?: number, expectMaxLineLength?: number, frozenSha256?: string,
 *          baseline?: {lines?: number, maxLineLength?: number, sha256?: string}|null, projectRoot?: string}} ctx
 */
export function checkShapeGuard(ctx = {}) {
  const { file, expectLines, expectMaxLineLength, frozenSha256 } = ctx;
  const projectRoot = ctx.projectRoot ?? process.cwd();
  const baseline = ctx.baseline ?? null;
  if (!existsSync(file)) {
    return verdict('shape_guard', false, 'violation', { path: displayPath(file, projectRoot), exists: false },
      [{ code: 'SHAPE_FILE_MISSING', message: `样本文件不存在: ${displayPath(file, projectRoot)}` }]);
  }
  const read = readTextFile(file);
  if (!read.ok) {
    return verdict('shape_guard', false, 'violation', { path: displayPath(file, projectRoot), unreadable: read.reason },
      [{ code: 'SHAPE_FILE_UNREADABLE', message: `样本不可读（${read.reason}）: ${displayPath(file, projectRoot)}` }]);
  }
  const text = read.text;
  const shape = shapeOf(text);
  const baselineSha = typeof baseline?.sha256 === 'string' && baseline.sha256 !== '' ? baseline.sha256 : null;
  const effSha = (typeof frozenSha256 === 'string' && frozenSha256 !== '') ? frozenSha256 : baselineSha;
  const effLines = Number.isInteger(expectLines) ? expectLines : (Number.isInteger(baseline?.lines) ? baseline.lines : null);
  const effMax = Number.isInteger(expectMaxLineLength) ? expectMaxLineLength
    : (Number.isInteger(baseline?.maxLineLength) ? baseline.maxLineLength : null);
  const findings = [];
  if (effSha !== null && shape.sha256 !== effSha) {
    findings.push({ code: 'SHAPE_FIXTURE_DRIFT', message: `夹具 sha256 与冻结值不符（${shape.sha256} != ${effSha}）-> 阈值需同步更新` });
  }
  if (effLines !== null && shape.lines !== effLines) {
    findings.push({ code: 'SHAPE_LINES_MISMATCH', message: `行数 ${shape.lines} != 期望 ${effLines}` });
  }
  if (effMax !== null && shape.maxLineLength !== effMax) {
    findings.push({ code: 'SHAPE_MAXLINE_MISMATCH', message: `最长行 ${shape.maxLineLength} != 期望 ${effMax}` });
  }
  if (effSha === null) {
    findings.push({ code: 'SHAPE_NO_FROZEN_SHA', message: '没有冻结 sha256（既未给 --sha256，包内冻结源也没有该文件的记录）——没有冻结值不算通过' });
  }
  const detail = {
    path: displayPath(file, projectRoot),
    sha256: shape.sha256,
    lines: shape.lines,
    maxLineLength: shape.maxLineLength,
    expect: {
      lines: effLines,
      maxLineLength: effMax,
      frozenSha256: effSha,
      frozenShaSource: (typeof frozenSha256 === 'string' && frozenSha256 !== '') ? 'flag'
        : (baselineSha !== null ? 'baseline' : null),
    },
  };
  return findings.length === 0
    ? verdict('shape_guard', true, 'pass', detail, [])
    : verdict('shape_guard', false, 'violation', detail, findings);
}

/** 统一入口（LF-250 三类 + LF-260 形态守卫 + LF-2A0 uncheckable 实证） */
export function runCheckKind(kind, ctx = {}) {
  switch (kind) {
    case 'file_untracked_change': return checkUntrackedChange(ctx);
    case 'output_shape': return checkOutputShape(ctx);
    case 'invalid_reference': return checkInvalidReference(ctx);
    case 'shape_guard': return checkShapeGuard(ctx);
    case 'uncheckable_justified': return checkUncheckable(ctx);
    default: throw new Error(`未知 check 类型: ${kind}（可选 ${[...CHECK_KINDS, 'shape_guard', 'uncheckable_justified'].join('|')}）`);
  }
}

/**
 * LF-250 判据的机械载体：把"实际判决 JSON"与 `expected/<name>.json` 做**逐字**比对。
 * **缺 expected 文件就是红**（防"没有基准却宣称通过"）。
 * @returns {{ok: boolean, reason: string|null, expected?: string, actual?: string}}
 */
export function compareWithExpected(actualText, expectedPath) {
  if (!existsSync(expectedPath)) {
    return { ok: false, reason: `缺少 expected 文件（没有基准就不算通过）: ${toPosix(expectedPath)}` };
  }
  const expected = readFileSync(expectedPath, 'utf8');
  if (expected !== actualText) {
    return { ok: false, reason: '判决 JSON 与 expected 不逐字一致', expected, actual: actualText };
  }
  return { ok: true, reason: null };
}

/** 便捷：量一个文件的"形态"（行数/最长行/字节/sha256），供 CLI 默认阈值与凭证使用 */
export function measureFile(file) {
  const read = readTextFile(file);
  if (!read.ok) throw new Error(`measureFile: 不可读（${read.reason}）: ${file}`);
  return { ...shapeOf(read.text), bytes: statSync(file).size };
}
