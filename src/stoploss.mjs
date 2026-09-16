// dsh-rulekeeper · LF-820 **Go/No-Go 止损点 + Runbook**
//
// 判据（清单 LF-820 行）：
//   绿 = Runbook 每条动作附**可复制的一句命令**
//   红 = 按 Runbook **无法从"故意造坏的态"恢复到基线** → 必红
//
// 三条设计（理由见 `RUNBOOK.md` 与本模块顶部注释）：
//   ① **文档即代码**：`RUNBOOK.md` 只能由 `renderRunbookMarkdown()` 生成（`--write-md`），
//      `--check` 逐字比对 → 文档漂移即红。手写的"一句命令"迟早与真实行为不一致。
//   ② **先证"坏成了"再证"修好了"**：`verifyRunbook()` 注入故障后**必须**先断言故障信号可见，
//      否则"恢复成功"可能是空判（"根本没坏"与"修好了"无法区分，§9.6 R3/R4）。
//   ③ **缺指标不停留在 armed**（fail-closed）：`unknown` ≠ `go`；没证据就止血，不是没证据就放行。
//
// 恢复动作**只用已被验证过的既有能力**（备份/还原 LF-190、hook install LF-520、快照 LF-300、
// doctor LF-180、模式闸 LF-800）——止损路径上不允许出现未经验证的新代码。
//
// 归属：core 模块。零依赖：只用 node:*。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { PKG_ROOT } from './checks.mjs';
import { readMode, writeMode } from './mode.mjs';
import { LANDING_REL } from './platform/paths.mjs';

/** 量化止损阈值（**单一权威源**；Runbook 文档的阈值表由它生成，禁在别处写死） */
export const STOP_LOSS_LIMITS = Object.freeze({
  /** 误拦率上限（0.02 = 2%）：超了就是"门禁开始伤人"，先止血再谈别的 */
  falseBlockRateMax: 0.02,
  /** 上下文膨胀比上限（注入文本长度 / 原始对话长度）：超了等于拿上下文换纪律，不值 */
  contextInflationRatioMax: 3,
  /** 并存反红连续失败次数上限（判据原文就是"连续失败 3 次"） */
  coexistRedFailuresMax: 3,
  /** 未留证直写次数上限（0：一次都不许） */
  unrecordedWritesMax: 0,
  /** 退役门槛：连续多少天零回退/零事故才允许删壳（LF-830） */
  retireMinDays: 14,
});

/** 指标 → 阈值键 + 比较方式（`gt` 严格大于 / `gte` 达到即算） */
const METRIC_RULES = Object.freeze([
  { key: 'falseBlockRate', limitKey: 'falseBlockRateMax', cmp: 'gt', label: '误拦率' },
  { key: 'contextInflationRatio', limitKey: 'contextInflationRatioMax', cmp: 'gt', label: '上下文膨胀比' },
  { key: 'coexistRedFailures', limitKey: 'coexistRedFailuresMax', cmp: 'gte', label: '并存反红连续失败' },
  { key: 'unrecordedWrites', limitKey: 'unrecordedWritesMax', cmp: 'gt', label: '未留证直写' },
]);
const METRIC_KEYS = Object.freeze(METRIC_RULES.map((r) => r.key));
/** 每类故障 → 由哪一步复位（`verifyRunbook` 与文档共用这张映射） */
export const FAULT_STEPS = Object.freeze([
  { fault: 'mode-armed-forged', step: 'SL-1', why: '档位被改成 armed 但没有留证：先回 observe 止血' },
  { fault: 'hooks-path-drift', step: 'SL-2', why: 'core.hooksPath 漂移 ⇒ hook 根本不执行（假安全）' },
  { fault: 'ledger-corrupt', step: 'SL-3', why: '账本中间坏行：从最近备份还原（禁手改）' },
  { fault: 'unrecorded-write', step: 'SL-4', why: '受保护文件被改动未留证：补快照留证' },
]);

/**
 * Runbook 步骤表（**唯一权威源**）。`argv` 是可选执行形态；`cmd` 由 argv 派生（二者不可能漂移）。
 * 占位符：`{bin}` 包内 bin 目录、`{landing}` 落点、`{repo}` 项目根、`{backup}` 备份文件、`{path}` 目标文件、`{pkg}` 包根。
 */
const STEPS = Object.freeze([
  {
    id: 'SL-0',
    title: '维护动作：先备份账本（**所有恢复动作的前置**）',
    trigger: '每次收尾/改动前',
    argv: ['{bin}/rk-backup.mjs', 'create', '--file', '{landing}/ledger.jsonl', '--landing', '{landing}'],
    assert: 'exit=0 且 stdout 有 `RK_BACKUP_PATH=`（create 自带**回读 sha256** 校验）',
  },
  {
    id: 'SL-1',
    title: '止血：把档位停在 `observe`（本文件所有其它动作的前提）',
    trigger: '误拦率 > 2% ∥ 上下文膨胀 > 3× ∥ 并存反红连续失败 ≥ 3 ∥ 指标缺项',
    argv: ['{bin}/rk-stop-loss.mjs', 'apply', '--landing', '{landing}'],
    assert: 'exit=0 且 stdout 有 `RK_STOP_LOSS_MODE_AFTER=observe`（**读回** config.json，不靠命令返回码）',
  },
  {
    id: 'SL-2',
    title: 'hook 漂移：重装并校验（`hooksPath` 指向别处 = git 一次都不会执行它）',
    trigger: '`rk-gate hooks verify` exit≠0',
    argv: ['{bin}/rk-gate.mjs', 'hooks', 'install', '--repo', '{repo}', '--force'],
    assert: '`rk-gate hooks verify --repo {repo}` exit=0（装到 `.git/hooks/` 不算：那是**假安装**）',
  },
  {
    id: 'SL-3',
    title: '账本坏行：从最近备份**还原**（禁手改账本行）',
    trigger: '`rk-doctor --landing <落点>` 报 `DOCTOR_BAD_LINES`（error）或 `DOCTOR_TRUNCATED_TAIL`（warn）',
    argv: ['{bin}/rk-backup.mjs', 'restore', '--file', '{landing}/ledger.jsonl', '--backup', '{backup}'],
    assert: '`rk-doctor --landing {landing} --strict` exit=0（回读 sha256 由 restore 自身保证）',
  },
  {
    id: 'SL-4',
    title: '未留证的直写：补一次**快照留证**（然后再提交）',
    trigger: '`rk-gate write --project <项目根>` 报 `UNRECORDED>0`',
    argv: ['{bin}/rk-snap.mjs', 'take', '--landing', '{landing}', '--path', '{path}', '--project', '{repo}'],
    assert: '`rk-gate write --project {repo} --landing {landing}` exit=0 且 `RK_GATE_WRITE_UNRECORDED=0`',
  },
  {
    id: 'SL-5',
    title: '复位确证：医生 + 自检两道都过才算回到基线',
    trigger: '止血动作做完之后（收尾门）',
    argv: ['{bin}/rk-doctor.mjs', '--landing', '{landing}', '--strict'],
    assert: 'exit=0；另加 `rk-selfcheck --root {pkg}` exit=0',
  },
]);

/** 文档里展示的形态：`node <argv…>`（**一句**；占位符保留，便于复制后替换） */
export const RUNBOOK_STEPS = Object.freeze(STEPS.map((s) => Object.freeze({ ...s, cmd: `node ${s.argv.join(' ')}` })));

export function stepById(id) {
  const found = RUNBOOK_STEPS.find((s) => s.id === id);
  if (found === undefined) throw new Error(`未知 Runbook 步骤 ${id}`);
  return found;
}

function subst(text, vars) {
  return String(text).replace(/\{([a-z]+)\}/g, (whole, key) => (key in vars ? String(vars[key]) : whole));
}

/**
 * Go/No-Go 判定（**纯函数**：只看传入的档位与指标，不读盘、不写盘）。
 * @returns {{verdict: 'go'|'no-go'|'unknown', triggers: object[], missing: string[], actions: string[]}}
 */
export function evaluateStopLoss({ mode = 'observe', metrics = {} } = {}) {
  const triggers = [];
  const missing = [];
  for (const rule of METRIC_RULES) {
    const value = metrics[rule.key];
    if (typeof value !== 'number' || Number.isFinite(value) !== true) {
      missing.push(rule.key);
      continue;
    }
    const limit = STOP_LOSS_LIMITS[rule.limitKey];
    const breach = rule.cmp === 'gte' ? value >= limit : value > limit;
    if (breach) {
      triggers.push({
        key: rule.key, label: rule.label, value, limit, cmp: rule.cmp,
        why: `${rule.label} ${value} ${rule.cmp === 'gte' ? '达到' : '超过'}阈值 ${limit}`,
      });
    }
  }
  const missingTriggers = missing.map((key) => {
    const rule = METRIC_RULES.find((r) => r.key === key);
    return { key, label: rule.label, value: null, limit: STOP_LOSS_LIMITS[rule.limitKey], cmp: rule.cmp, why: `${rule.label}无证据（缺指标）` };
  });
  const all = [...triggers, ...missingTriggers];
  const verdict = triggers.length > 0 ? 'no-go' : missing.length > 0 ? 'unknown' : 'go';
  // 任何非 go（含 unknown）都要先止血：**未知不等于通过**
  const actions = verdict === 'go' ? [] : ['SL-1', ...(triggers.some((t) => t.key === 'unrecordedWrites') ? ['SL-4'] : [])];
  return { verdict, mode, triggers: all, missing, actions };
}

/** 读指标文件（坏文件 → 空对象 ⇒ 判定为 unknown，fail-closed） */
export function readMetrics(file) {
  if (typeof file !== 'string' || existsSync(file) !== true) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** `apply`：把档位写成 observe（唯一止血动作） */
export function applyStopLoss({ landing }) {
  const before = readMode(landing);
  const w = writeMode(landing, 'observe');
  return { ok: w.ok, before, after: w.after, reason: w.reason };
}

/** 生成 Runbook 文档（**唯一**来源；`--check` 与 `--write-md` 都用它） */
export function renderRunbookMarkdown() {
  const lines = [];
  lines.push('# dsh-rulekeeper 止损 Runbook（Go/No-Go）');
  lines.push('');
  lines.push('> **本文件由 `rk-stop-loss runbook --write-md` 生成，禁手改**（手改 = 漂移，`--check` 会判红）。');
  lines.push('> 判据来源：todo 清单 **LF-820**（Go/No-Go 止损点 + Runbook：误拦率 / 上下文膨胀 / 并存反红连续失败 3 次 → 停在 observe）。');
  lines.push('');
  lines.push('## 量化止损阈值（单一权威源 = `src/stoploss.mjs` 的 `STOP_LOSS_LIMITS`）');
  lines.push('');
  lines.push('| 指标 | 阈值 | 含义 |');
  lines.push('|---|---|---|');
  lines.push(`| \`falseBlockRate\`（误拦率） | > ${STOP_LOSS_LIMITS.falseBlockRateMax} | 正常操作被门禁拦下的比例；超了就是"门禁开始伤人" |`);
  lines.push(`| \`contextInflationRatio\`（上下文膨胀） | > ${STOP_LOSS_LIMITS.contextInflationRatioMax} | 注入文本 / 原始对话；拿上下文换纪律，超了不值 |`);
  lines.push(`| \`coexistRedFailures\`（并存反红连续失败） | ≥ ${STOP_LOSS_LIMITS.coexistRedFailuresMax} | 与第三方插件同场时反红连续挂掉（判据原文"连续失败 3 次"） |`);
  lines.push(`| \`unrecordedWrites\`（未留证直写） | > ${STOP_LOSS_LIMITS.unrecordedWritesMax} | 一次都不许 |`);
  lines.push('');
  lines.push('判定口径（`rk-stop-loss status`）：');
  lines.push('');
  lines.push('- 任一指标**超阈值** → `verdict=no-go`（先做 SL-1 止血）');
  lines.push('- 任一指标**缺项** → `verdict=unknown`；**未知不等于通过**：同样先做 SL-1（fail-closed）');
  lines.push('- 全部有值且不超 → `verdict=go`（exit=0）');
  lines.push('');
  lines.push('## 动作表（每条都是**可复制的一句命令**）');
  lines.push('');
  lines.push('命令里的占位符：`{bin}` = 包内 `bin/`，`{landing}` = 落点（`.dsh-ai/lessonflow`），`{repo}` = 项目根，');
  lines.push('`{backup}` = 备份文件，`{path}` = 目标文件，`{pkg}` = 包根。');
  lines.push('');
  for (const s of RUNBOOK_STEPS) {
    lines.push(`### ${s.id} ${s.title}`);
    lines.push('');
    lines.push('```sh');
    lines.push(s.cmd);
    lines.push('```');
    lines.push('');
    lines.push(`- 触发：${s.trigger}`);
    lines.push(`- 判据：${s.assert}`);
    lines.push('');
  }
  lines.push('## 故障 → 复位步骤（`rk-stop-loss verify` 逐条自动验）');
  lines.push('');
  lines.push('| 故意造坏的态 | 复位步骤 | 为什么 |');
  lines.push('|---|---|---|');
  for (const f of FAULT_STEPS) lines.push(`| \`${f.fault}\` | ${f.step} | ${f.why} |`);
  lines.push('');
  lines.push('`rk-stop-loss verify` 的做法（**红先于绿**）：注入故障 → **先断言故障信号可见**（doctor/hooks verify/mode 变红）');
  lines.push('→ 执行上表那一句命令 → 断言回到基线。任一步没复位 → exit≠0。');
  lines.push('');
  lines.push('## 退役门槛（LF-830：删壳之前的硬门）');
  lines.push('');
  lines.push(`**连续 ${STOP_LOSS_LIMITS.retireMinDays} 天零回退、零事故**才允许删壳；判定由 \`rk-stop-loss retire\` 机械执行：`);
  lines.push('');
  lines.push('```sh');
  lines.push('node {bin}/rk-stop-loss.mjs retire --landing {landing} --shell <壳名> --since <最后回退日 ISO> --now <当前 ISO>');
  lines.push('```');
  lines.push('');
  lines.push('- 天数不足 `--min-days`（默认 ' + STOP_LOSS_LIMITS.retireMinDays + '）→ **拒绝**（exit≠0）');
  lines.push('- 期间存在回退/事故记录（`<落点>/logs/incidents.jsonl`）→ **拒绝**（exit≠0）');
  lines.push('- 本文件缺失或没有这一节 → **拒绝**（"未写退役门槛就删壳"必须被拦住）');
  lines.push('- 放行时写台账 `<落点>/logs/retire.jsonl`（可审计：谁在什么时候依据什么放的行）');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export function runbookPathOf(pkgRoot = PKG_ROOT) {
  return join(pkgRoot, 'RUNBOOK.md');
}

/** 漂移门：磁盘上的 RUNBOOK.md 必须与生成结果逐字相同 */
export function checkRunbook({ pkgRoot = PKG_ROOT } = {}) {
  const file = runbookPathOf(pkgRoot);
  const generated = renderRunbookMarkdown();
  if (!existsSync(file)) return { ok: false, drift: true, file, reason: 'RUNBOOK.md 不存在（先跑 rk-stop-loss runbook --write-md）' };
  const onDisk = readFileSync(file, 'utf8');
  if (onDisk !== generated) return { ok: false, drift: true, file, reason: 'RUNBOOK.md 与生成器输出不一致（手改过或代码改了没重生成）' };
  return { ok: true, drift: false, file, reason: null };
}

/** 写 RUNBOOK.md（LF 无 BOM + 回读校验） */
export function writeRunbook({ pkgRoot = PKG_ROOT } = {}) {
  const file = runbookPathOf(pkgRoot);
  const text = renderRunbookMarkdown();
  writeFileSync(file, text, { encoding: 'utf8' });
  const back = readFileSync(file, 'utf8');
  if (back !== text) return { ok: false, file, reason: '回读与写出不一致' };
  return { ok: true, file, reason: null, bytes: Buffer.byteLength(text, 'utf8') };
}

// ── Runbook 自动验证（判据原文的"红"：恢复不出基线 → 必红）──────────────────────

function runStep(step, vars) {
  const argv = step.argv.map((a) => subst(a, vars));
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8', cwd: vars.repo });
  return { argv, exit: typeof r.status === 'number' ? r.status : 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * 在**临时目录**里逐类注入故障 → 断言"真的坏了" → 执行对应步骤 → 断言回到基线。
 * 不碰真实落点。返回的每步都带 `brokenDetected`（先证坏）与 `restored`（后证好）。
 */
export function verifyRunbook({ workdir, pkgRoot = PKG_ROOT }) {
  const bin = join(pkgRoot, 'bin');
  const repo = join(workdir, 'proj');
  // 落点名走**唯一权威源**（selfcheck S7 会拦拆开的字面量：改名时它被误替换过）
  const landing = join(repo, LANDING_REL);
  mkdirSync(landing, { recursive: true });
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'x\n', 'utf8');
  writeFileSync(join(repo, '.gitignore'), '.dsh-ai/\n', 'utf8');
  writeFileSync(join(landing, 'config.json'), `${JSON.stringify({ schema: 1, mode: 'armed' }, null, 2)}\n`, 'utf8');
  // rules.json 必须**六字段齐全**（LF-230 契约）：缺 gates/checks/inject 时 `rk-gate write` 会如实报
  // `GATE_WRITE_RULES_MISSING_FIELD` 并判红 —— 那是"规则包不完整"，与我们要验的故障不是同一件事。
  writeFileSync(join(landing, 'rules.json'), `${JSON.stringify({
    schema: 1,
    project: 'proj',
    protected_paths: ['README.md'],
    gates: [{ gateName: 'project-check', evidence: '.dsh-ai/gates.json', strict: true }],
    checks: ['file_untracked_change', 'output_shape', 'invalid_reference'],
    inject: [{ id: 'fact-writing', template: '先取证再下结论（无证据行禁止用陈述句）' }],
  }, null, 2)}\n`, 'utf8');
  const rows = [1, 2].map((n) => JSON.stringify({
    schema: 1, id: `v-${n}`, ts: `2026-09-15T00:0${n}:00.000Z`, rule: `R-${n}`, problem: 'p', root_cause: 'r',
    solution: 's', evidence: [], mechanism: 'm', recurrence: 1, first_seen: `2026-09-15T00:0${n}:00.000Z`,
    last_seen: `2026-09-15T00:0${n}:00.000Z`, status: 'active',
  }));
  writeFileSync(join(landing, 'ledger.jsonl'), `${rows.join('\n')}\n`, 'utf8');
  git('add', '-A');
  git('-c', 'user.email=v@x', '-c', 'user.name=v', 'commit', '-q', '-m', 'init');

  const steps = FAULT_STEPS.map((f) => ({ id: f.step, fault: f.fault, why: f.why, cmd: '', exit: null, brokenDetected: false, restored: false, note: '' }));

  // SL-2 前置：先把 hook 装好（否则"漂移"无从谈起）
  const installed = runStep(stepById('SL-2'), { bin, landing, repo, pkg: pkgRoot, path: 'README.md', backup: '' });

  // 各故障的注入/断红/复位
  const modeFile = join(landing, 'config.json');
  const setMode = (m) => {
    const cfg = JSON.parse(readFileSync(modeFile, 'utf8'));
    cfg.mode = m;
    writeFileSync(modeFile, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  };
  const hooksVerify = () => {
    // 断红/断绿都看**同一命令**（rk-gate hooks verify），不是 install
    const r = spawnSync(process.execPath, [join(bin, 'rk-gate.mjs'), 'hooks', 'verify', '--repo', repo], { encoding: 'utf8' });
    return { exit: typeof r.status === 'number' ? r.status : 1, stdout: r.stdout ?? '' };
  };
  const doctor = () => {
    const r = spawnSync(process.execPath, [join(bin, 'rk-doctor.mjs'), '--landing', landing, '--strict'], { encoding: 'utf8' });
    return typeof r.status === 'number' ? r.status : 1;
  };
  const writeRecon = () => {
    const r = spawnSync(process.execPath, [join(bin, 'rk-gate.mjs'), 'write', '--project', repo, '--landing', landing, '--phase', 'close'], { encoding: 'utf8' });
    return typeof r.status === 'number' ? r.status : 1;
  };

  // ── F1：档位被改成 armed 但无留证 ──
  {
    const s = steps[0];
    setMode('armed');
    s.brokenDetected = readMode(landing) === 'armed';
    const r = runStep(stepById('SL-1'), { bin, landing, repo, pkg: pkgRoot, path: '', backup: '' });
    s.cmd = stepById('SL-1').cmd; s.exit = r.exit;
    s.restored = r.exit === 0 && readMode(landing) === 'observe';
    if (!s.restored) s.note = `${r.stdout}${r.stderr}`.trim().slice(0, 200);
  }

  // ── F2：core.hooksPath 漂移 ──
  {
    const s = steps[1];
    if (installed.exit !== 0) s.note = `前置安装失败: ${installed.stdout}${installed.stderr}`;
    git('config', 'core.hooksPath', '.git/hooks'); // 漂移：文件在别处 = git 一次都不执行
    s.brokenDetected = hooksVerify().exit !== 0;
    const r = runStep(stepById('SL-2'), { bin, landing, repo, pkg: pkgRoot, path: '', backup: '' });
    s.cmd = stepById('SL-2').cmd; s.exit = r.exit;
    s.restored = r.exit === 0 && hooksVerify().exit === 0;
    if (!s.restored) s.note = `${r.stdout}${r.stderr}`.trim().slice(0, 200);
  }

  // ── F3：账本中间坏行（先按 SL-0 备份，再注入）──
  {
    const s = steps[2];
    const created = runStep(stepById('SL-0'), { bin, landing, repo, pkg: pkgRoot, path: '', backup: '' });
    const m = /RK_BACKUP_PATH=(.+)/.exec(created.stdout);
    const backup = m === null ? '' : m[1].trim();
    const ledger = join(landing, 'ledger.jsonl');
    const good = readFileSync(ledger, 'utf8');
    const [first, ...rest] = good.split('\n');
    writeFileSync(ledger, `${first}\n{ 这不是合法 JSON\n${rest.join('\n')}`, 'utf8'); // 中间坏行（error 级）
    s.brokenDetected = backup !== '' && doctor() !== 0;
    const r = runStep(stepById('SL-3'), { bin, landing, repo, pkg: pkgRoot, path: '', backup });
    s.cmd = stepById('SL-3').cmd; s.exit = r.exit;
    s.restored = r.exit === 0 && doctor() === 0;
    if (!s.restored) s.note = `backup=${backup} ${r.stdout}${r.stderr}`.trim().slice(0, 200);
  }

  // ── F4：受保护文件被改动未留证（先记基线，再改文件）──
  {
    const s = steps[3];
    spawnSync(process.execPath, [join(bin, 'rk-baseline.mjs'), 'record', '--landing', landing, '--project', repo, '--no-backup'], { encoding: 'utf8' });
    writeFileSync(join(repo, 'README.md'), 'changed without record\n', 'utf8');
    s.brokenDetected = writeRecon() !== 0;
    const r = runStep(stepById('SL-4'), { bin, landing, repo, pkg: pkgRoot, path: 'README.md', backup: '' });
    s.cmd = stepById('SL-4').cmd; s.exit = r.exit;
    s.restored = r.exit === 0 && writeRecon() === 0;
    if (!s.restored) s.note = `${r.stdout}${r.stderr}`.trim().slice(0, 200);
  }

  const failed = steps.filter((s) => s.brokenDetected !== true || s.restored !== true);
  return { ok: failed.length === 0, steps, landing, repo, failed: failed.map((s) => `${s.id}:${s.brokenDetected ? '' : 'brokenDetected'}${s.restored ? '' : '/restored'}`) };
}

// ── 退役门槛（LF-830：未写门槛就删壳 → exit≠0）───────────────────────────────

export const RETIRE_SECTION = '## 退役门槛';

export function retireGate({ landing, shell, since, now, minDays = STOP_LOSS_LIMITS.retireMinDays, runbookFile = runbookPathOf() }) {
  const reasons = [];
  const started = Date.parse(since);
  if (Number.isFinite(started) !== true) reasons.push(`--since 不是合法 ISO 时间: ${JSON.stringify(since)}`);
  const today = Date.parse(now);
  if (Number.isFinite(today) !== true) reasons.push(`--now 不是合法 ISO 时间: ${JSON.stringify(now)}`);
  if (reasons.length > 0) return { ok: false, code: 'BAD_TIME', days: null, rollbacks: null, reasons, ledger: null };

  // ① 退役门槛**必须写在**（缺失 = "未写退役门槛就删壳"，必须拦住）
  if (existsSync(runbookFile) !== true) {
    reasons.push(`退役门槛文档缺失：${runbookFile}（未写门槛就删壳 = 违规）`);
  } else {
    const doc = readFileSync(runbookFile, 'utf8');
    if (doc.includes(RETIRE_SECTION) !== true) reasons.push(`退役门槛文档里没有 "${RETIRE_SECTION}" 节（未写门槛就删壳 = 违规）`);
    else if (new RegExp(`连续 ${minDays} 天`).test(doc) !== true) reasons.push(`退役门槛文档里没写"连续 ${minDays} 天"（口径不明 = 未写门槛）`);
  }

  // ② 天数
  const days = Math.floor((today - started) / 86400000);
  if (days < minDays) reasons.push(`距最后一次回退只有 ${days} 天 < 门槛 ${minDays} 天`);

  // ③ 期间零回退/零事故（依据**记录**；无记录 ≠ 无事故，但方向保守）
  const incidentsFile = join(String(landing), 'logs', 'incidents.jsonl');
  const rollbacks = [];
  if (existsSync(incidentsFile)) {
    for (const line of readFileSync(incidentsFile, 'utf8').split('\n')) {
      const t = line.trim();
      if (t === '') continue;
      let row = null;
      try { row = JSON.parse(t); } catch { continue; }
      if (row === null || typeof row !== 'object') continue;
      if (row.shell !== shell) continue;
      if (typeof row.ts !== 'string' || Date.parse(row.ts) < started) continue;
      if (row.kind === 'rollback' || row.kind === 'incident') rollbacks.push(row);
    }
  }
  if (rollbacks.length > 0) reasons.push(`期间有 ${rollbacks.length} 条回退/事故记录（shell=${shell}）`);

  const ok = reasons.length === 0;
  const ledger = join(String(landing), 'logs', 'retire.jsonl');
  const row = { schema: 1, ts: now, shell, since, days, minDays, rollbacks: rollbacks.length, allowed: ok, reasons };
  try {
    mkdirSync(join(String(landing), 'logs'), { recursive: true });
    writeFileSync(ledger, `${JSON.stringify(row)}\n`, 'utf8');
  } catch { /* 台账落盘失败不影响判定结果本身（判定已算出） */ }
  return { ok, code: ok ? null : 'RETIRE_REFUSED', days, rollbacks: rollbacks.length, reasons, ledger, row };
}
