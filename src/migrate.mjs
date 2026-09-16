// dsh-rulekeeper · **R2 落点迁移**（`.dsh-ai/lessonflow` → `.dsh-ai/rulekeeper`）
//
// 为什么要有独立工具（而不是"改名时顺手搬"）：
//   · 落点里是**用户数据**（教训账本 ledger.jsonl、`logs/gate.jsonl` 门禁台账、snapshots/ 快照、backups/ 备份）。
//     工具**不得替用户动数据** —— 只有显式 `rk-migrate` 才搬，且默认 dry-run。
//   · 兼容窗口（`resolveProjectLanding`）：老落点存在时**继续在原处读写**，所以"不迁移"也是一等公民。
//   · 迁移必须**可核对**：文件数 + 逐文件 sha256（树指纹）+ 账本行数 + 门禁台账行数，四项对齐才算成功；
//     不通过就**一个字节都不删**（fail-closed）。
//
// 归属：core 模块（被 cli 调用）。零依赖：只用 node:*。

import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';

import { LANDING_DIRNAME, LEGACY_LANDING_DIRNAME, dshHome, resolveProjectLanding, resolveUserLanding, toPosix } from './platform/paths.mjs';

/** 逐文件清单（相对路径 + 字节数 + sha256），排序后作为树指纹的输入 */
function listTree(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const name of readdirSync(abs).sort()) {
      const childAbs = join(abs, name);
      const childRel = rel === '' ? name : `${rel}/${name}`;
      const st = statSync(childAbs);
      if (st.isDirectory()) {
        walk(childAbs, childRel);
      } else if (st.isFile()) {
        out.push({
          rel: childRel,
          bytes: st.size,
          sha256: createHash('sha256').update(readFileSync(childAbs)).digest('hex'),
        });
      }
    }
  };
  if (!existsSync(dir)) return [];
  walk(dir, '');
  return out;
}

function countLines(file) {
  if (!existsSync(file)) return 0;
  const text = readFileSync(file, 'utf8');
  if (text === '') return 0;
  const lines = text.split('\n');
  // 末尾无换行时最后一行也算一条（与 readLines 的"半行"语义一致：这里只做**计数核对**，不解析）
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/** 落点指纹：文件数 / 总字节 / 树 sha256 / 账本行数 / 门禁台账行数 */
export function landingFingerprint(dir) {
  const files = listTree(dir);
  const bytes = files.reduce((n, f) => n + f.bytes, 0);
  const fp = createHash('sha256').update(files.map((f) => `${f.rel}|${f.bytes}|${f.sha256}`).join('\n'), 'utf8').digest('hex');
  return {
    exists: existsSync(dir),
    files: files.length,
    bytes,
    fp,
    ledgerLines: countLines(join(dir, 'ledger.jsonl')),
    gateLines: countLines(join(dir, 'logs', 'gate.jsonl')),
  };
}

/** 解析"从哪迁到哪"（scope=project 用项目级，scope=user 用用户级） */
export function planMigration({ projectRoot = process.cwd(), scope = 'project', env = process.env, landingDir = null } = {}) {
  if (scope === 'user') {
    const from = resolveUserLanding(env);
    const to = join(dshHome(env), LANDING_DIRNAME);
    return { scope, from, to, needed: toPosix(from) !== toPosix(to), legacyName: LEGACY_LANDING_DIRNAME, newName: LANDING_DIRNAME };
  }
  const from = resolveProjectLanding(projectRoot, landingDir);
  const to = join(resolve(projectRoot), '.dsh-ai', LANDING_DIRNAME);
  return { scope, from, to, needed: toPosix(from) !== toPosix(to), legacyName: LEGACY_LANDING_DIRNAME, newName: LANDING_DIRNAME };
}

/**
 * 执行（或只规划）迁移。
 * @param {{projectRoot?, scope?, env?, apply?: boolean, removeOld?: boolean, now?: Date}} opts
 * @returns {{ok, code, mode, plan, before, after, verified, removedOld, reasons, record}}
 */
export function migrateLanding(opts = {}) {
  const apply = opts.apply === true;
  const removeOld = opts.removeOld === true;
  const now = opts.now ?? new Date();
  const plan = planMigration(opts);
  const before = landingFingerprint(plan.from);
  const reasons = [];

  if (removeOld && !apply) {
    reasons.push('--remove-old 必须与 --apply 同时使用（禁"只删不迁"）');
    return { ok: false, code: 'USAGE', mode: apply ? 'apply' : 'dry-run', plan, before, after: landingFingerprint(plan.to), verified: false, removedOld: false, reasons, record: null };
  }
  if (!before.exists) {
    reasons.push(`源落点不存在（无需迁移）: ${toPosix(plan.from)}`);
    return { ok: true, code: 'OK', mode: apply ? 'apply' : 'dry-run', plan, before, after: landingFingerprint(plan.to), verified: true, removedOld: false, reasons, record: null };
  }
  if (!plan.needed) {
    reasons.push(`已在目标落点（${plan.newName}），无需迁移`);
    return { ok: true, code: 'OK', mode: apply ? 'apply' : 'dry-run', plan, before, after: before, verified: true, removedOld: false, reasons, record: null };
  }
  const toExists = existsSync(plan.to) && listTree(plan.to).length > 0;
  if (apply && toExists) {
    reasons.push(`目标落点已存在且非空（拒绝覆盖，先人工确认）: ${toPosix(plan.to)}`);
    return { ok: false, code: 'FAIL', mode: 'apply', plan, before, after: landingFingerprint(plan.to), verified: false, removedOld: false, reasons, record: null };
  }

  if (!apply) {
    return {
      ok: true, code: 'OK', mode: 'dry-run', plan, before,
      after: landingFingerprint(plan.to), verified: false, removedOld: false,
      reasons: [`dry-run：将从 ${toPosix(plan.from)} 复制到 ${toPosix(plan.to)}（${before.files} 文件 / ${before.bytes} B）；加 --apply 落盘`],
      record: null,
    };
  }

  // ── 落盘：复制 → 核对（四项） → 写迁移记录 → 可选删旧 ──
  mkdirSync(plan.to, { recursive: true });
  cpSync(plan.from, plan.to, { recursive: true, force: true });
  const after = landingFingerprint(plan.to);
  const checks = [
    { name: 'files', ok: after.files === before.files, want: before.files, got: after.files },
    { name: 'bytes', ok: after.bytes === before.bytes, want: before.bytes, got: after.bytes },
    { name: 'tree_sha256', ok: after.fp === before.fp, want: before.fp.slice(0, 12), got: after.fp.slice(0, 12) },
    { name: 'ledger_lines', ok: after.ledgerLines === before.ledgerLines, want: before.ledgerLines, got: after.ledgerLines },
    { name: 'gate_lines', ok: after.gateLines === before.gateLines, want: before.gateLines, got: after.gateLines },
  ];
  const verified = checks.every((c) => c.ok);
  let record = null;
  if (!verified) {
    reasons.push(`核对不一致（${checks.filter((c) => !c.ok).map((c) => c.name).join(',')}）-> 保留目标副本供人工比对，**不删源**`);
    return { ok: false, code: 'FAIL', mode: 'apply', plan, before, after, verified, removedOld: false, reasons, record: null, checks };
  }

  let removedOld = false;
  if (removeOld) {
    rmSync(plan.from, { recursive: true, force: true });
    removedOld = true;
  }
  const row = {
    schema: 1,
    ts: now.toISOString(),
    scope: plan.scope,
    from: toPosix(plan.from),
    to: toPosix(plan.to),
    files: after.files,
    bytes: after.bytes,
    tree_sha256: after.fp,
    ledger_lines: after.ledgerLines,
    gate_lines: after.gateLines,
    removed_old: removedOld,
  };
  try {
    mkdirSync(join(plan.to, 'logs'), { recursive: true });
    appendFileSync(join(plan.to, 'logs', 'migrate.jsonl'), `${JSON.stringify(row)}\n`, 'utf8');
    record = { ok: true, path: `${toPosix(relative(resolve(plan.to), plan.to))}/logs/migrate.jsonl`.replace(/^\//, '') };
  } catch (err) {
    reasons.push(`迁移记录写入失败（迁移本身已核对通过）: ${err?.message ?? ''}`);
    record = { ok: false, reason: String(err?.message ?? err) };
  }
  reasons.push(`已迁移 ${after.files} 文件 / ${after.bytes} B（树指纹一致）${removedOld ? '；旧落点已删除（--remove-old）' : '；旧落点保留'}`);
  return { ok: true, code: 'OK', mode: 'apply', plan, before, after, verified, removedOld, reasons, record, checks };
}
