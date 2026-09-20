// checker.mjs —— `kind:"checker"` 绑定（2026-09-19，objective ③；按已立项设计 P1-1 实现）
//
// 为什么必须有它：现有绑定模型只能表达"某个文件被改了却没留 pre-image 证据"。而 E1 实验拿 10 条
//   真实技术类教训逐个试过——**0/10** 对得上那个模型，**10/10** 只能靠"跑一个检查器 + 用构造出的
//   违规样本判红"。`verifyBinding` 此前对非 `file_untracked_change` **直接 fail-closed**
//   （`EFFECT_KIND_UNSUPPORTED`），于是"把技术类教训升级成机械判据"在结构上做不到。
//
// 字段（与设计 P1-1 对齐）：
//   command[]            argv 数组，**无 shell**（不拼字符串 ⇒ 没有注入面）
//   expectRed.exitCode   违规样本上**必须**得到的退出码（必须非 0；设计明令禁 `stdoutContains`）
//   expectGreen.exitCode 合规样本上必须得到的退出码（通常 0）
//   redSample{kind:'tree', source:'<相对路径>'}   已入库的**违规样本**（检查器以它作为工作目录）
//   greenSample{kind:'tree', source:'<相对路径>'} 合规样本（缺省 = 当前项目根）
//   sampleHash           违规样本的**内容指纹**（treeHash）：样本事后被改 ⇒ inconclusive，不许静默沿用旧结论
//   checkerVersion      检查器版本（人写；用于"判据变了要重验"的追溯）
//   timeoutMs            单次执行上限（超时 = inconclusive，**不是**通过）
//
// 验证四项（设计里从三项扩到四项，第三项"反事实唯一性"与第四项"确定性"都要有）：
//   ① 命中红：违规样本上 exit≠expectGreen ⇒ 判据真的开火
//   ② 误报面绿：合规样本上 exit=expectGreen ⇒ 不是逢事就报
//   ③ 反事实唯一性：两个样本的结论**必须不同**（都红=检查器/环境坏了；都绿=判据没有判别力）
//   ④ 确定性：同一输入跑两次结论一致（否则判据不可复算）
// 状态三态：`green`（四项全过）/ `red`（判据没开火或没判别力）/ `inconclusive`（跑不动、超时、样本被改、未许可执行）
//
// **执行面诚实声明（规则 43 同族）**：本模块会**真的执行**绑定里写的本地命令。默认**不执行**——
//   必须显式 `--allow-exec`。这不是安全边界（能写 rules.json 的人也能写别的命令），而是
//   "别让一次例行体检顺手跑起来源不明的命令"的**显式确认**。
//
// 归属：core 模块。零依赖：只用 node:*。

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { toPosix } from './platform/paths.mjs';

export const CHECKER_SAMPLE_KINDS = Object.freeze(['tree']);
export const DEFAULT_CHECKER_TIMEOUT_MS = 20000;

/** 样本目录内容指纹（确定性的：相对路径排序 + 逐文件 sha256；跳过 `.git`） */
export function treeHash(dir) {
  const root = resolve(dir);
  if (!existsSync(root)) return null;
  const entries = [];
  const walk = (current) => {
    let names;
    try {
      names = readdirSync(current).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (name === '.git') continue;
      const full = join(current, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!st.isFile()) continue;
      const rel = toPosix(relative(root, full).split(sep).join('/'));
      const sha = createHash('sha256').update(readFileSync(full)).digest('hex');
      entries.push(`${rel}\u0000${sha}`);
    }
  };
  walk(root);
  return createHash('sha256').update(entries.join('\n'), 'utf8').digest('hex');
}

/**
 * 校验一条 checker 绑定的形状（**登记在写入之前**：形状不合法就不该落进 rules.json）。
 * @returns {string[]} 问题列表（空 = 合法）
 */
export function validateCheckerBinding(binding) {
  const problems = [];
  const b = binding ?? {};
  if (!Array.isArray(b.command) || b.command.length === 0 || b.command.some((a) => typeof a !== 'string' || a === '')) {
    problems.push('checker 绑定必须有非空 command 数组（argv 形态，无 shell）');
  }
  const exitOf = (v, label) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      problems.push(`checker 绑定缺 ${label}.exitCode`);
      return null;
    }
    if (!Number.isInteger(v.exitCode)) {
      problems.push(`checker 绑定的 ${label}.exitCode 必须是整数（禁 stdoutContains 这类文本判据）`);
      return null;
    }
    return v.exitCode;
  };
  const red = exitOf(b.expectRed, 'expectRed');
  const green = exitOf(b.expectGreen, 'expectGreen');
  if (red !== null && red === 0) problems.push('checker 绑定的 expectRed.exitCode 必须**非 0**（0 表示"没开火"，不是违规样本上的期望）');
  if (green !== null && green !== 0) problems.push(`checker 绑定的 expectGreen.exitCode 必须是 0（合规样本上"不报"），实得 ${green}`);
  if (red !== null && green !== null && red === green) problems.push('expectRed 与 expectGreen 不得相同（否则判据没有判别力）');
  const sampleOf = (v, label) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      problems.push(`checker 绑定缺 ${label}{kind:'tree', source:'…'}`);
      return;
    }
    if (!CHECKER_SAMPLE_KINDS.includes(v.kind)) problems.push(`${label}.kind 只支持 ${CHECKER_SAMPLE_KINDS.join('/')}（实得 ${JSON.stringify(v.kind)}）`);
    if (typeof v.source !== 'string' || v.source.trim() === '') problems.push(`${label}.source 必须是非空相对路径`);
  };
  sampleOf(b.redSample, 'redSample');
  if (b.greenSample !== undefined && b.greenSample !== null) sampleOf(b.greenSample, 'greenSample');
  if (b.sampleHash !== undefined && b.sampleHash !== null && !/^[0-9a-f]{64}$/i.test(String(b.sampleHash))) {
    problems.push('sampleHash 必须是 64 位十六进制 sha256（或省略）');
  }
  if (b.timeoutMs !== undefined && b.timeoutMs !== null && (!Number.isInteger(b.timeoutMs) || b.timeoutMs <= 0)) {
    problems.push('timeoutMs 必须是正整数');
  }
  return problems;
}

/**
 * 跑一次检查器（**无 shell**；超时/启动失败都如实返回，不抛）。
 *
 * 工作目录与样本传递（2026-09-19 定稿）：命令**始终以 `projectRoot` 为 cwd**，被检样本目录通过
 * 环境变量 `RULEKEEPER_SAMPLE_DIR` 传入 ⇒ 同一条命令能在"违规样本"与"合规样本"上跑，
 * 不必让 command 里写死样本路径（写死就没法做红/绿对照了）。
 * 检查器约定：读 `process.env.RULEKEEPER_SAMPLE_DIR ?? process.cwd()` 作为被检根。
 */
export function runChecker({ command, cwd, timeoutMs = DEFAULT_CHECKER_TIMEOUT_MS, env = process.env, sampleDir = null } = {}) {
  const res = spawnSync(command[0], command.slice(1), {
    cwd,
    shell: false,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: sampleDir === null ? env : { ...env, RULEKEEPER_SAMPLE_DIR: sampleDir },
    maxBuffer: 1024 * 1024,
  });
  const timedOut = res.error !== undefined && res.error !== null && res.error.code === 'ETIMEDOUT';
  return {
    ok: res.error === undefined || res.error === null ? true : false,
    exitCode: typeof res.status === 'number' ? res.status : null,
    timedOut,
    error: res.error === undefined || res.error === null ? null : String(res.error.message ?? res.error),
    stdout: typeof res.stdout === 'string' ? res.stdout.slice(0, 400) : '',
    stderr: typeof res.stderr === 'string' ? res.stderr.slice(0, 400) : '',
  };
}

/**
 * 四项验证 + 三态判决。
 * @param {{projectRoot: string, binding: object, allowExec?: boolean, timeoutMs?: number}} opts
 * @returns {{ok: boolean, state: 'green'|'red'|'inconclusive', cases: object[], findings: object[]}}
 */
export function verifyChecker(opts = {}) {
  const projectRoot = resolve(opts.projectRoot ?? process.cwd());
  const binding = opts.binding ?? {};
  const findings = [];
  const cases = [];
  const fail = (code, message, state = 'inconclusive') => ({ ok: false, state, cases, findings: [...findings, { code, message }] });

  const problems = validateCheckerBinding(binding);
  if (problems.length > 0) {
    return fail('EFFECT_CHECKER_BINDING_INVALID', `${binding.rule ?? '?'}: checker 绑定形状不合法：${problems.join('；')}`);
  }
  if (opts.allowExec !== true) {
    // **默认不执行**：如实报"未许可执行"，绝不因为"没跑"就判通过
    return fail('EFFECT_CHECKER_EXEC_NOT_ALLOWED', `${binding.rule}: checker 绑定需要显式 --allow-exec 才会执行本地命令（本次未执行 ⇒ 结论不可得）`);
  }

  const redDir = resolve(projectRoot, binding.redSample.source);
  const greenDir = binding.greenSample ? resolve(projectRoot, binding.greenSample.source) : projectRoot;
  const timeoutMs = Number.isInteger(binding.timeoutMs) ? binding.timeoutMs : (opts.timeoutMs ?? DEFAULT_CHECKER_TIMEOUT_MS);

  if (!existsSync(redDir)) {
    return fail('EFFECT_CHECKER_SAMPLE_MISSING', `${binding.rule}: 违规样本不存在: ${binding.redSample.source}`);
  }
  // 样本固定：写绑定时登记的指纹若对不上 ⇒ 结论作废（否则"样本被悄悄改小"能骗过所有用例）
  if (typeof binding.sampleHash === 'string' && binding.sampleHash !== '') {
    const actual = treeHash(redDir);
    const ok = actual !== null && actual.toLowerCase() === binding.sampleHash.toLowerCase();
    cases.push({ name: '样本固定', expect: binding.sampleHash.slice(0, 12), got: actual === null ? 'missing' : actual.slice(0, 12), ok });
    if (!ok) {
      findings.push({ code: 'EFFECT_CHECKER_SAMPLE_CHANGED', message: `${binding.rule}: 违规样本内容指纹与绑定登记的不一致（样本被改过）⇒ 验证结论作废，须重签 sampleHash` });
      return { ok: false, state: 'inconclusive', cases, findings };
    }
  }

  // ① 命中红：违规样本上必须按声明的非 0 退出码开火
  const red1 = runChecker({ command: binding.command, cwd: projectRoot, sampleDir: redDir, timeoutMs });
  if (red1.timedOut || red1.exitCode === null) {
    cases.push({ name: '命中红', expect: `exit=${binding.expectRed.exitCode}`, got: red1.timedOut ? 'timeout' : 'spawn-error', ok: false });
    findings.push({ code: 'EFFECT_CHECKER_INCONCLUSIVE', message: `${binding.rule}: 违规样本上检查器没跑出结论（${red1.timedOut ? '超时' : red1.error}）⇒ inconclusive` });
    return { ok: false, state: 'inconclusive', cases, findings };
  }
  const hitRed = red1.exitCode === binding.expectRed.exitCode;
  cases.push({ name: '命中红', expect: `exit=${binding.expectRed.exitCode}`, got: `exit=${red1.exitCode}`, ok: hitRed });
  if (!hitRed) {
    findings.push({
      code: 'EFFECT_CHECKER_NOT_HIT',
      message: `${binding.rule}: 违规样本上检查器 exit=${red1.exitCode}（期望 ${binding.expectRed.exitCode}）⇒ 判据没开火`,
    });
  }

  // ② 误报面绿：合规样本上必须不报
  const green1 = runChecker({ command: binding.command, cwd: projectRoot, sampleDir: greenDir, timeoutMs });
  const greenOk = green1.exitCode === binding.expectGreen.exitCode;
  cases.push({ name: '误报面绿', expect: `exit=${binding.expectGreen.exitCode}`, got: green1.timedOut ? 'timeout' : `exit=${green1.exitCode}`, ok: greenOk });
  if (!greenOk) {
    findings.push({ code: 'EFFECT_CHECKER_FALSE_POSITIVE', message: `${binding.rule}: 合规样本上检查器 exit=${green1.exitCode}（期望 ${binding.expectGreen.exitCode}）⇒ 误报` });
  }
  if (green1.timedOut) {
    findings.push({ code: 'EFFECT_CHECKER_INCONCLUSIVE', message: `${binding.rule}: 合规样本上检查器超时 ⇒ inconclusive` });
    return { ok: false, state: 'inconclusive', cases, findings };
  }

  // ③ 反事实唯一性：两个样本的结论必须**不同**（都红=环境/检查器坏了；都绿=判据没有判别力）
  const differs = red1.exitCode !== green1.exitCode;
  cases.push({ name: '反事实唯一性', expect: '两个样本结论不同', got: differs ? '不同' : `相同(exit=${red1.exitCode})`, ok: differs });
  if (!differs) {
    findings.push({
      code: 'EFFECT_CHECKER_NOT_DISCRIMINATING',
      message: `${binding.rule}: 违规样本与合规样本上的退出码相同（${red1.exitCode}）⇒ 判据没有判别力${red1.exitCode !== 0 ? '（且两个都非 0：多半是检查器/环境问题）' : ''}`,
    });
  }

  // ④ 确定性：同一输入两次结论一致
  const red2 = runChecker({ command: binding.command, cwd: projectRoot, sampleDir: redDir, timeoutMs });
  const deterministic = red2.exitCode === red1.exitCode && red2.timedOut === false;
  cases.push({ name: '确定性', expect: `exit=${red1.exitCode}`, got: red2.timedOut ? 'timeout' : `exit=${red2.exitCode}`, ok: deterministic });
  if (!deterministic) {
    findings.push({ code: 'EFFECT_CHECKER_NONDETERMINISTIC', message: `${binding.rule}: 同一输入两次结论不一致（${red1.exitCode} vs ${red2.exitCode}）⇒ 判据不可复算` });
  }

  const allOk = cases.every((c) => c.ok === true);
  const state = allOk ? 'green' : (hitRed || !differs ? 'red' : 'inconclusive');
  return { ok: allOk, state, cases, findings };
}
