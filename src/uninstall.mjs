// dsh-rulekeeper · LF-810 **一键卸载 + 数据保全**（摘 hook 先记原值 → 移除本工具装的东西 → **不删数据**）
//
// 判据（条目 LF-810）：摘 hook（**先记原值**）→ 移除本工具装的东西 → **不删数据**；`export` 可重建。
//   绿 = 重复卸载 exit=0；卸载后 `core.hooksPath` 回到**安装前的原值**；落点数据**逐文件不变**
//   红 = **卸载删数据 → 必红**（数据文件消失 / 账本或台账条数减少 ⇒ `ok:false`）
//
// 三条设计取舍（都是"宁可保守，不可破坏现场"）：
//   ① **手改过的 hook 不删**：文件内容与清单 sha256 不符时保留并报 `HOOK_MODIFIED_KEPT`——
//      卸载不该顺手抹掉用户自己的改动（那是数据丢失的另一种形态）。
//   ② **数据见证取在卸载之前**："没删数据"不能靠"卸载后目录里还有东西"来判（任何残留都能骗过它），
//      必须是"卸载前记下每个数据文件的 sha256 + 账本/台账条数，卸载后逐个复核"。
//   ③ **并发写者不误判**（§9.6 R2）：真实项目里账本可能被别的会话并发追加 ⇒ sha256 变化**不算**丢失，
//      只有"**文件消失**"或"**条数减少**"才判红。
//
// 归属：core 模块。零依赖：只用 node:*。

import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import {
  DEFAULT_HOOKS_PATH, HOOK_RUNNER, HOOKS_LOCAL_STATE, HOOKS_MANIFEST, KNOWN_HOOK_NAMES,
  defaultRunGit, landingDirOf, manifestPathOf, readHooksPath, readHooksState, sha256File,
} from './hooks.mjs';
import { readLedger } from './ledger.mjs';
import { readGateLedger } from './gate.mjs';
import { pathKey } from './platform/paths.mjs';

/** 数据文件走查（**排除** hook runner 与 hooks 清单/本机态：那几个是安装态，卸载本来就要删） */
function listDataFiles(dir, rel = '') {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = join(dir, e.name);
    const r = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...listDataFiles(abs, r));
    else if (e.name !== HOOK_RUNNER && e.name !== HOOKS_MANIFEST && e.name !== HOOKS_LOCAL_STATE) out.push({ path: r, sha256: sha256File(abs) });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** 数据见证：数据文件（rel+sha256）+ 账本/台账**条数** */
export function landingDataWitness(landingDir) {
  return {
    files: listDataFiles(String(landingDir)),
    ledgerEntries: readLedger(String(landingDir)).values.length,
    gateRows: readGateLedger(String(landingDir)).values.length,
  };
}

function compareWitness(before, after) {
  const beforePaths = new Set(before.files.map((f) => f.path));
  const afterPaths = new Set(after.files.map((f) => f.path));
  const lost = [...beforePaths].filter((p) => !afterPaths.has(p));
  const modified = before.files
    .filter((f) => afterPaths.has(f.path))
    .filter((f) => (after.files.find((g) => g.path === f.path)?.sha256 ?? null) !== f.sha256)
    .map((f) => f.path);
  return {
    lost,
    modified, // 只作信息项：并发写者（别的会话追加账本）也会让它非空 ⇒ 不作违规判据
    ledgerShrunk: after.ledgerEntries < before.ledgerEntries,
    gateShrunk: after.gateRows < before.gateRows,
  };
}

/**
 * 卸载：① 摘 hook（只摘**内容相符**的）② 摘 runner ③ 恢复 `core.hooksPath` 原值 ④ 删 hooks 清单 ⑤ 复核数据。
 *
 * @returns {{
 *   ok: boolean, alreadyClean: boolean, repoRoot: string, hooksPath: string|null,
 *   removed: string[], kept: object[], absent: string[], findings: object[],
 *   config: {action: string, value: string|null, previous: object|null, error: string|null},
 *   dataBefore: object, dataAfter: object, dataPreserved: boolean, ledgerEntries: number, gateRows: number,
 * }}
 */
export function uninstallHooks(opts = {}) {
  const repoRoot = String(opts.repoRoot ?? process.cwd());
  const runGit = opts.runGit ?? defaultRunGit;
  const landing = landingDirOf(repoRoot);
  const manifestFile = manifestPathOf(repoRoot);
  const findings = [];
  const removed = [];
  const kept = [];
  const absent = [];
  const base = {
    repoRoot,
    hooksPath: null,
    removed,
    kept,
    absent,
    findings,
    config: { action: 'skip-not-installed', value: null, previous: null, error: null },
  };

  // 数据见证**必须在动手之前**取（判据载体：见文件头 ②）
  const dataBefore = landingDataWitness(landing);

  if (!existsSync(manifestFile)) {
    // 幂等：没装过（或已卸载过）→ **不是失败**。重复卸载 exit=0 靠的就是这一支。
    return {
      ...base,
      ok: true,
      alreadyClean: true,
      dataBefore,
      dataAfter: dataBefore,
      dataPreserved: true,
      ledgerEntries: dataBefore.ledgerEntries,
      gateRows: dataBefore.gateRows,
    };
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  } catch (err) {
    findings.push({ code: 'HOOK_MANIFEST_INVALID', message: `hooks 清单不是合法 JSON（${err.message}）：不猜内容、直接停手（数据零改动）` });
    return { ...base, ok: false, alreadyClean: false, dataBefore, dataAfter: dataBefore, dataPreserved: true, ledgerEntries: dataBefore.ledgerEntries, gateRows: dataBefore.gateRows };
  }
  if (manifest === null || typeof manifest !== 'object' || !Array.isArray(manifest.hooks)) {
    findings.push({ code: 'HOOK_MANIFEST_INVALID', message: 'hooks 清单结构不合法（缺 hooks 数组）：不猜内容、直接停手' });
    return { ...base, ok: false, alreadyClean: false, dataBefore, dataAfter: dataBefore, dataPreserved: true, ledgerEntries: dataBefore.ledgerEntries, gateRows: dataBefore.gateRows };
  }
  // P14：runner 指纹 / 安装前 hooksPath 原值 / configChanged 已移到 `hooks.local.json`
  //   —— 读取走合并视图（local 优先、清单回退）⇒ 老落点照旧，新落点按新形状。
  const state = readHooksState(repoRoot);

  const hooksPath = typeof manifest.hooksPath === 'string' && manifest.hooksPath !== '' ? manifest.hooksPath : DEFAULT_HOOKS_PATH;
  // M5（独立审查）：清单里的 `hooksPath` 是**可被改写的输入**，直接用它会删掉仓外文件。
  // 判据：非绝对路径、无 `..` 段、且拼出来的目录必须落在仓库根之下；否则**只报不删**。
  const hooksSegs = hooksPath.split(/[\\/]/);
  const hooksDirRaw = join(repoRoot, hooksPath);
  const hooksPathUnsafe = isAbsolute(hooksPath)
    || hooksSegs.includes('..')
    || pathKey(hooksDirRaw) === pathKey(repoRoot)
    || pathKey(hooksDirRaw).startsWith(`${pathKey(repoRoot)}/`) !== true;
  const hooksDir = hooksDirRaw;
  if (hooksPathUnsafe) {
    findings.push({
      code: 'HOOK_HOOKSPATH_UNEXPECTED',
      message: `清单里的 hooksPath 越界（拒绝按它删除任何文件，防删到仓外）: ${JSON.stringify(hooksPath)}`,
    });
  }

  // ① 摘 hook 文件（内容不符者**保留**）
  for (const h of manifest.hooks) {
    const name = typeof h?.name === 'string' ? h.name : null;
    if (name === null) continue;
    // 名单白名单 + 不带路径分隔符：清单是**可被改写的输入**，若它写了 `../../ledger.jsonl`
    // 就直接删掉数据了（这是"卸载删数据"最阴的一条路）。不在白名单 → 一律不删、如实报。
    if (!KNOWN_HOOK_NAMES.includes(name) || name.includes('/') || name.includes('\\')) {
      kept.push({ name, reason: 'HOOK_NAME_UNEXPECTED' });
      findings.push({ code: 'HOOK_NAME_UNEXPECTED', message: `清单里的 hook 名不在白名单（拒绝删除，防误删数据）: ${JSON.stringify(name)}` });
      continue;
    }
    if (hooksPathUnsafe) {
      kept.push({ name, reason: 'HOOK_HOOKSPATH_UNEXPECTED' });
      continue;
    }
    const file = join(hooksDir, name);
    if (!existsSync(file)) {
      absent.push(name);
      continue;
    }
    const actual = sha256File(file);
    if (typeof h.sha256 !== 'string' || actual !== h.sha256) {
      // m1（独立审查）：清单里**没有** sha256 字段时旧实现会"跳过校验直接删" → 手改过的文件被静默删。
      // 判据：**没有可核对的指纹 = 不许删**（fail-closed），并如实报告原因。
      const reason = typeof h.sha256 === 'string' ? 'HOOK_MODIFIED_KEPT' : 'HOOK_SHA_MISSING';
      kept.push({ name, reason, actual, expected: typeof h.sha256 === 'string' ? h.sha256 : null });
      findings.push({
        code: reason,
        message: typeof h.sha256 === 'string'
          ? `${hooksPath}/${name} 与清单 sha256 不符（用户手改过）⇒ **保留不删**（卸载不破坏现场）`
          : `${hooksPath}/${name} 在清单里没有 sha256 指纹 ⇒ 无法核对，**保留不删**（fail-closed）`,
      });
      continue;
    }
    rmSync(file);
    removed.push(name);
  }

  // ② 摘 hook runner（同样只在内容相符时；且路径**必须**是我们装的那个名字）
  const runnerRel = typeof state.runner?.path === 'string' ? state.runner.path : HOOK_RUNNER;
  const runnerFile = join(landing, runnerRel);
  if (runnerRel !== HOOK_RUNNER) {
    // 清单被改写指向别的文件（例如 `ledger.jsonl`）⇒ 删它就是删数据。不删，如实报。
    kept.push({ name: runnerRel, reason: 'HOOK_RUNNER_PATH_UNEXPECTED' });
    findings.push({ code: 'HOOK_RUNNER_PATH_UNEXPECTED', message: `清单里的 runner 路径不是 ${HOOK_RUNNER}（拒绝删除，防误删数据）: ${JSON.stringify(runnerRel)}` });
  } else if (existsSync(runnerFile)) {
    const actual = sha256File(runnerFile);
    if (typeof state.runner?.sha256 === 'string' && actual !== state.runner.sha256) {
      kept.push({ name: runnerRel, reason: 'HOOK_RUNNER_MODIFIED_KEPT', actual, expected: state.runner.sha256 });
      findings.push({ code: 'HOOK_RUNNER_MODIFIED_KEPT', message: `${runnerRel} 与${state.source === 'local' ? '本机态' : '清单'} sha256 不符 ⇒ 保留不删` });
    } else {
      rmSync(runnerFile);
      removed.push(runnerRel);
    }
  } else {
    absent.push(runnerRel);
  }
  // ②b P14：本机态文件是我们自己写的安装记录（无数据价值）⇒ 与 runner 一起摘掉，卸载后才真的干净。
  //   但**runner 路径越界时保留它**（那一支已经报了 `HOOK_RUNNER_PATH_UNEXPECTED`）：现场留证 > 目录干净，
  //   否则"谁把 runner 指到别处去了"这条线索会随卸载一起消失。
  if (existsSync(state.localFile)) {
    if (runnerRel === HOOK_RUNNER) {
      rmSync(state.localFile);
      removed.push(HOOKS_LOCAL_STATE);
    } else {
      kept.push({ name: HOOKS_LOCAL_STATE, reason: 'HOOK_RUNNER_PATH_UNEXPECTED' });
    }
  }

  // ③ 恢复 core.hooksPath（**不猜**：记录里写了什么就回什么）
  // M3（独立审查）：判断顺序必须是"**先看有没有原值记录**"，再看 `configChanged`。
  //   旧清单（本次改动之前装的）**没有** `configChanged` 字段；旧实现先判 `configChanged !== true`
  //   ⇒ 直接走 `skip-no-config-change`，把"旧清单"分支变成**不可达代码**，于是 config 没还回去却 exit=0。
  const previous = state.previous ?? null;
  const configUnchanged = state.configChanged === false;
  let config = { action: 'skip-no-config-change', value: null, previous, error: null };
  if (configUnchanged) {
    config = { action: 'skip-no-config-change', value: null, previous, error: null };
  } else if (previous === null || typeof previous !== 'object') {
    // 旧清单：没有原值记录 ⇒ 只在"当前值确实是我们的 hooksPath"时才 unset（不猜用户原本的值）
    const current = readHooksPath(repoRoot, runGit);
    if (current.present && current.hooksPath === hooksPath) {
      const r = runGit(repoRoot, ['config', '--unset', 'core.hooksPath']);
      const after = readHooksPath(repoRoot, runGit);
      const ok = after.present === false;
      config = { action: 'unset-unknown-previous', value: null, previous: null, error: ok ? null : (r.stderr || r.error || 'unset 失败') };
      if (!ok) findings.push({ code: 'HOOK_CONFIG_RESTORE_FAILED', message: `core.hooksPath 未能 unset: ${config.error}` });
    } else {
      config = { action: 'skip-unknown-previous', value: null, previous: null, error: null };
      findings.push({
        code: 'HOOK_PREVIOUS_UNKNOWN',
        message: '清单无 previous（旧版安装）：当前 core.hooksPath 不指向本工具 ⇒ 保持不动（不猜原值）',
      });
    }
  } else if (previous.existed === true && typeof previous.hooksPath === 'string' && previous.hooksPath !== '') {
    const r = runGit(repoRoot, ['config', 'core.hooksPath', previous.hooksPath]);
    config = { action: 'restore', value: previous.hooksPath, previous, error: r.ok ? null : (r.stderr || r.error || 'git config 失败') };
    if (!r.ok) findings.push({ code: 'HOOK_CONFIG_RESTORE_FAILED', message: `core.hooksPath 未能还原为 ${previous.hooksPath}: ${config.error}` });
  } else {
    const r = runGit(repoRoot, ['config', '--unset', 'core.hooksPath']);
    const after = readHooksPath(repoRoot, runGit);
    const ok = after.present === false;
    config = { action: 'unset', value: null, previous, error: ok ? null : (r.stderr || r.error || 'unset 失败') };
    if (!ok) findings.push({ code: 'HOOK_CONFIG_RESTORE_FAILED', message: `core.hooksPath 未能 unset（安装前本来就没设）: ${config.error}` });
  }

  const configOk = findings.every((f) => f.code !== 'HOOK_CONFIG_RESTORE_FAILED');
  const invalid = findings.some((f) => f.code === 'HOOK_MANIFEST_INVALID');

  // ④ 删清单（**安装态**，不是数据）。config 没恢复成功就留着，好让重试有据可依。
  if (configOk && !invalid) rmSync(manifestFile);

  // ⑤ 复核数据
  const dataAfter = landingDataWitness(landing);
  const diff = compareWitness(dataBefore, dataAfter);
  const dataPreserved = diff.lost.length === 0 && diff.ledgerShrunk === false && diff.gateShrunk === false;
  if (diff.lost.length > 0) {
    findings.push({ code: 'DATA_LOST', message: `卸载弄丢了数据文件（必红）：${diff.lost.join(', ')}` });
  }
  if (diff.ledgerShrunk || diff.gateShrunk) {
    findings.push({
      code: 'DATA_LOST',
      message: `卸载后条数减少（必红）：账本 ${dataBefore.ledgerEntries}->${dataAfter.ledgerEntries} / 台账 ${dataBefore.gateRows}->${dataAfter.gateRows}`,
    });
  }
  if (diff.modified.length > 0) {
    findings.push({
      code: 'DATA_MODIFIED_CONCURRENT',
      message: `下列数据文件内容变了（**不计违规**：并发会话追加是合法写者）：${diff.modified.join(', ')}`,
    });
  }

  return {
    ...base,
    hooksPath,
    findings,
    config,
    ok: dataPreserved && configOk && !invalid,
    alreadyClean: false,
    dataBefore,
    dataAfter,
    dataPreserved,
    ledgerEntries: dataAfter.ledgerEntries,
    gateRows: dataAfter.gateRows,
  };
}
