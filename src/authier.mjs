// authier.mjs —— **账本唯一写通路**（2026-09-21，交接第 3 步的落盘面）
//
// 为什么需要它：`record` 只管**追加新行**；"改一条已有教训"此前只能手工编辑 `ledger.jsonl` ——
//   没有备份、没有回读校验、没有原子替换。本模块把"写账本"这件事收成**一条通路**：
//     备份（回读 sha256）→ 追加归档行 + 状态事件行 → **回读校验**（能解析 + 旧行确实被取代 +
//     行数 +N）→ 失败**逐字节回滚**。
//   `record` 的追加路径继续走 `appendLine`（单次 writeSync，并发安全）；本模块只在**要改已有行**时用
//   （那种场景天然是低频人工动作，整文件重写的代价可以接受，而"可回读可回滚"更值钱）。
//
// `guard` 档的**存在性核对**也在这里：`mechanism: 'guard'` 必须点名靠哪个拦截，而那个拦截必须真的在
//   （`hook:` 在 `hooks.json` 清单里 / `gate:` 在 `rules.json` 的 gates 里），否则拒收 —— 否则
//   "我靠拦截面"又变成自称（规则 43 同族）。
//
// 诚实边界：`by` 是**声明**，不是签名（与 `--by human` 同族）。真隔离靠 git 层的提交审批/分支保护。
//
// 归属：core 模块。零依赖：只用 node:*。

import { appendFileSync, copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { backupFile, sha256File } from './backup.mjs';
import { GUARD_REF_KINDS, validateGuardRef } from './ledger.mjs';
import { toPosix } from './platform/paths.mjs';

export const LEDGER_FILE = 'ledger.jsonl';
export const HOOKS_MANIFEST = 'hooks.json';
export const RULES_FILE = 'rules.json';

/** 已安装的 git 钩子名（读 `hooks.json`；读不到 ⇒ 空数组，**不假装检查过**） */
export function installedHooks(landingDir) {
  const file = join(landingDir, HOOKS_MANIFEST);
  if (!existsSync(file)) return { ok: false, names: [], reason: `无 ${HOOKS_MANIFEST}（该落点没装钩子）` };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const names = (Array.isArray(parsed?.hooks) ? parsed.hooks : [])
      .map((h) => (h !== null && typeof h === 'object' ? String(h.name ?? '') : ''))
      .filter((n) => n !== '');
    return { ok: true, names, reason: null };
  } catch (err) {
    return { ok: false, names: [], reason: `${HOOKS_MANIFEST} 不是合法 JSON: ${String(err?.message ?? err)}` };
  }
}

/** `rules.json` 里已登记的 gates 名（`gate` 字段；读不到 ⇒ 空数组） */
export function registeredGates(landingDir) {
  const file = join(landingDir, RULES_FILE);
  if (!existsSync(file)) return { ok: false, names: [], reason: `无 ${RULES_FILE}` };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const names = (Array.isArray(parsed?.gates) ? parsed.gates : [])
      .map((g) => (g !== null && typeof g === 'object' ? String(g.gate ?? '') : ''))
      .filter((n) => n !== '');
    return { ok: true, names, reason: null };
  } catch (err) {
    return { ok: false, names: [], reason: `${RULES_FILE} 不是合法 JSON: ${String(err?.message ?? err)}` };
  }
}

/**
 * 核对 `guardRef` 指向的拦截**真的存在**。
 * @returns {{ok: boolean, code: string|null, reason: string|null, ref: string|null}}
 */
export function verifyGuardRef(landingDir, ref) {
  const shape = validateGuardRef(ref);
  if (shape.length > 0) return { ok: false, code: 'GUARD_REF_SHAPE', reason: shape.join('；'), ref: null };
  const [kind, name] = ref.trim().split(':', 2);
  if (!GUARD_REF_KINDS.includes(kind)) return { ok: false, code: 'GUARD_REF_KIND', reason: `未知种类 ${kind}`, ref: null };
  if (kind === 'hook') {
    const hooks = installedHooks(landingDir);
    if (!hooks.ok) return { ok: false, code: 'GUARD_REF_HOOKS_UNREADABLE', reason: hooks.reason, ref: null };
    if (!hooks.names.includes(name)) {
      return { ok: false, code: 'GUARD_REF_HOOK_MISSING', reason: `钩子 ${name} 不在已安装清单（已装：${hooks.names.join('/') || '（无）'}）`, ref: null };
    }
    return { ok: true, code: null, reason: null, ref: `${kind}:${name}` };
  }
  const gates = registeredGates(landingDir);
  if (!gates.ok) return { ok: false, code: 'GUARD_REF_RULES_UNREADABLE', reason: gates.reason, ref: null };
  if (!gates.names.includes(name)) {
    return { ok: false, code: 'GUARD_REF_GATE_MISSING', reason: `门禁 ${name} 不在 rules.json 的 gates 里（已登记：${gates.names.join('/') || '（无）'}）`, ref: null };
  }
  return { ok: true, code: null, reason: null, ref: `${kind}:${name}` };
}

/** 回读校验：能逐行解析 + 行数 + 指定条目被取代 */
function readBackValidate(file, { expectLines, expectSuperseded = [], expectIds = [] }) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, reason: `回读失败: ${String(err?.message ?? err)}` };
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length !== expectLines) return { ok: false, reason: `回读行数不符：期望 ${expectLines} 实际 ${lines.length}` };
  const rows = [];
  for (let i = 0; i < lines.length; i += 1) {
    try {
      rows.push(JSON.parse(lines[i]));
    } catch (err) {
      return { ok: false, reason: `第 ${i + 1} 行不是合法 JSON: ${String(err?.message ?? err)}` };
    }
  }
  const ids = new Set(rows.map((r) => String(r?.id ?? '')));
  for (const id of expectIds) {
    if (!ids.has(id)) return { ok: false, reason: `回读后找不到新行 id=${id}` };
  }
  if (expectSuperseded.length > 0) {
    const flat = rows.filter((r) => r?.category === '状态事件').map((r) => String(r.problem ?? '')).join('\n');
    for (const id of expectSuperseded) {
      if (!flat.includes(id)) return { ok: false, reason: `回读后找不到取代 ${id} 的状态事件行` };
    }
  }
  return { ok: true, reason: null, rows };
}

/**
 * 往账本**追加若干行**（备份 + 回读 + 失败回滚）。
 *
 * 为什么用"整文件重写"而不是 `appendFileSync`：要能**回读校验 + 回滚**（append 无法回滚）。
 * 低频人工动作，代价可接受；`record` 的常规追加仍走 `appendLine`。
 *
 * @param {{landingDir: string, rows: object[], now?: Date, expectSuperseded?: string[]}} opts
 * @returns {{ok: boolean, code: string|null, reason: string|null, backup: string|null, beforeSha: string|null, afterSha: string|null, lines: number, rolledBack?: boolean}}
 */
export function appendRowsVerified(opts = {}) {
  const landingDir = opts.landingDir;
  const rows = Array.isArray(opts.rows) ? opts.rows : [];
  const expectSuperseded = Array.isArray(opts.expectSuperseded) ? opts.expectSuperseded : [];
  if (typeof landingDir !== 'string' || landingDir === '') return { ok: false, code: 'NO_LANDING', reason: '缺 landingDir', backup: null, beforeSha: null, afterSha: null, lines: 0 };
  if (rows.length === 0) return { ok: false, code: 'NO_ROWS', reason: '没有要追加的行', backup: null, beforeSha: null, afterSha: null, lines: 0 };
  for (const [i, row] of rows.entries()) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      return { ok: false, code: 'BAD_ROW', reason: `第 ${i + 1} 行不是对象`, backup: null, beforeSha: null, afterSha: null, lines: 0 };
    }
  }
  const file = join(landingDir, LEDGER_FILE);
  if (!existsSync(file)) return { ok: false, code: 'NO_LEDGER', reason: `账本不存在: ${toPosix(file)}`, backup: null, beforeSha: null, afterSha: null, lines: 0 };

  const beforeSha = sha256File(file);
  const beforeText = readFileSync(file, 'utf8');
  const beforeLines = beforeText.split(/\r?\n/).filter((l) => l.trim() !== '').length;
  const backup = backupFile(file, { landingDir, now: opts.now });
  if (backup.ok !== true) {
    return { ok: false, code: 'BACKUP_FAILED', reason: `备份失败（拒绝在无备份的情况下改账本）: ${backup.reason}`, backup: null, beforeSha, afterSha: null, lines: 0 };
  }

  const payload = `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
  const nextText = beforeText.endsWith('\n') || beforeText === '' ? beforeText + payload : `${beforeText}\n${payload}`;
  const tmp = `${file}.tmp-${randomBytes(3).toString('hex')}`;
  try {
    writeFileSync(tmp, nextText, 'utf8');
  } catch (err) {
    rmSync(tmp, { force: true });
    return { ok: false, code: 'WRITE_FAILED', reason: `写临时件失败: ${String(err?.message ?? err)}`, backup: toPosix(backup.path), beforeSha, afterSha: null, lines: 0 };
  }
  const checked = readBackValidate(tmp, {
    expectLines: beforeLines + rows.length,
    expectSuperseded,
    expectIds: rows.map((r) => String(r.id ?? '')),
  });
  if (checked.ok !== true) {
    rmSync(tmp, { force: true });
    return { ok: false, code: 'TMP_INVALID', reason: `临时件回读不通过（未替换生效文件）: ${checked.reason}`, backup: toPosix(backup.path), beforeSha, afterSha: null, lines: 0 };
  }

  // ── **写前重读**（2026-09-21，交接：record/mutate 加写前重读）────────────────────────────
  // 为什么必须有：本通路是"整文件重写"。若在**读出 beforeText 之后、rename 之前**有别的写者
  // （另一个会话的 `record`、或本会话的另一次 mutate）追加了行，我们的 rename 会把它的行**抹掉**
  // —— 典型的 lost update，而且**无声**（对方的行就那么没了）。
  // 测法：比 sha256。变了就**放弃本次写入**（fail-closed），让人**重跑命令**。
  //
  // 为什么不自动重试：重试必须重算"归档行 / 状态事件行"的内容与 id（它们依赖读到的快照），
  // 在写通路里悄悄重算 = 让人拿到一份自己没看过的 diff。宁可让人重跑一次（重跑会基于新内容算）。
  // 测试缝（与 `src/effect.mjs` 的 `_inject.failAfterReplace` 同族）：用来**实测**并发写入会被拒，
  // 而不是靠"读了代码觉得应该拦得住"。生产路径不传它就是空操作。
  if (typeof opts._inject?.beforeReplace === 'function') opts._inject.beforeReplace({ file, tmp, beforeSha });
  const liveSha = sha256File(file);
  if (liveSha !== beforeSha) {
    rmSync(tmp, { force: true });
    return {
      ok: false,
      code: 'CONCURRENT_WRITE_DETECTED',
      reason: `写前重读发现账本已被别的写者改动（读时 ${String(beforeSha).slice(0, 12)} → 现在 ${String(liveSha).slice(0, 12)}）`
        + ' ⇒ **放弃本次写入**（否则会抹掉对方刚追加的行）；请重跑本命令（重跑会基于新内容重新计算）',
      backup: toPosix(backup.path),
      beforeSha,
      afterSha: null,
      lines: 0,
    };
  }

  const afterSha = sha256File(tmp);
  try {
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    return { ok: false, code: 'RENAME_FAILED', reason: `原子替换失败（原文件未改）: ${String(err?.message ?? err)}`, backup: toPosix(backup.path), beforeSha, afterSha: null, lines: 0 };
  }
  const reread = readBackValidate(file, {
    expectLines: beforeLines + rows.length,
    expectSuperseded,
    expectIds: rows.map((r) => String(r.id ?? '')),
  });
  if (reread.ok !== true || sha256File(file) !== afterSha) {
    const rolled = rollback(file, backup.path);
    return {
      ok: false, code: 'VERIFY_AFTER_WRITE',
      reason: `写后回读不一致（已回滚=${rolled.ok}）: ${reread.reason ?? 'sha256 不符'}`,
      backup: toPosix(backup.path), beforeSha, afterSha: null, lines: 0, rolledBack: rolled.ok === true,
    };
  }
  return { ok: true, code: null, reason: null, backup: toPosix(backup.path), beforeSha, afterSha, lines: beforeLines + rows.length };
}

/** 逐字节回滚（从备份还原；无备份 ⇒ 删除新建的文件） */
function rollback(file, backupPath) {
  try {
    if (typeof backupPath !== 'string' || backupPath === '') {
      if (existsSync(file)) rmSync(file, { force: true });
      return { ok: true };
    }
    copyFileSync(backupPath, file);
    return { ok: sha256File(file) === sha256File(backupPath) };
  } catch {
    return { ok: false };
  }
}

/**
 * 往账本**常规追加**一行（`record` 主路径；与 appendRowsVerified 分开：这条路不需要回滚语义）。
 * 留在这里是为了让"写账本"只有**一个模块**，调用方不必记得用哪个底层函数。
 */
export function appendRowPlain(file, row) {
  appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
}
