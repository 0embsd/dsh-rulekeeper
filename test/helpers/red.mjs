// dsh-rulekeeper · LF-150 反向红脚手架
//
// 目的：把清单 §6 规则 3「判据三要件 = 确定 exit + 关键输出行 + 固定 fixture」变成可执行断言。
// 核心思想：**"没报错"不等于"判据有效"**——必须证明"条件不满足时判据真的会红"，否则该判据可能恒真。
//
// 用法：
//   assertRed(() => ({ code: 1, out: 'FINDING S1_DEPENDENCIES ...' }), { want: 'S1_DEPENDENCIES', name: '注入依赖' });
//   assertGreen(() => ({ code: 0, out: 'RK_SELFCHECK_RESULT=pass' }), { want: 'pass' });
//
// 仪器自检（本助手自己的红态）：喂"合规样本"（code=0）给 assertRed 必须抛「未红」。
// 见 test/red-helper.test.mjs 的前 4 个用例。
//
// 零依赖：只用 node:*。注意 thunk 返回 {code, out}，本助手**不自己起子进程**
// （DSH 沙箱下 node 子进程的管道 stdio 可能被拒；CLI 的进程级 rc 由凭证在 pwsh 侧实测）。

export class RedAssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RedAssertionError';
  }
}

function firstLine(text) {
  const line = String(text ?? '').split('\n').find((l) => l.trim() !== '');
  return line === undefined ? '(空输出)' : line.trim().slice(0, 160);
}

function normalize(value) {
  if (value === null || typeof value !== 'object' || !('code' in value)) {
    throw new RedAssertionError('thunk 必须返回形如 {code, out} 的对象');
  }
  return { code: Number(value.code), out: String(value.out ?? '') };
}

/**
 * 断言"违规样本必须报红"：exit≠0 且（给定 want 时）输出含该标记。
 * @param {() => {code:number,out:string}} thunk
 * @param {{want?: string, name?: string}} [opts]
 */
export function assertRed(thunk, opts = {}) {
  const { want, name = '样本' } = opts;
  const r = normalize(thunk());
  if (r.code === 0) {
    throw new RedAssertionError(`未红: ${name} 期望 exit≠0，实测 exit=0（输出首行: ${firstLine(r.out)}）`);
  }
  if (want !== undefined && !r.out.includes(want)) {
    throw new RedAssertionError(
      `红信号不符: ${name} 期望输出含 "${want}"，实测未含（输出首行: ${firstLine(r.out)}）`,
    );
  }
  return r;
}

/**
 * 断言"合规样本必须为绿"：exit=0 且（给定 want 时）输出含该标记。
 * @param {() => {code:number,out:string}} thunk
 * @param {{want?: string, name?: string}} [opts]
 */
export function assertGreen(thunk, opts = {}) {
  const { want, name = '样本' } = opts;
  const r = normalize(thunk());
  if (r.code !== 0) {
    throw new RedAssertionError(`未绿: ${name} 期望 exit=0，实测 exit=${r.code}（输出首行: ${firstLine(r.out)}）`);
  }
  if (want !== undefined && !r.out.includes(want)) {
    throw new RedAssertionError(
      `绿信号不符: ${name} 期望输出含 "${want}"，实测未含（输出首行: ${firstLine(r.out)}）`,
    );
  }
  return r;
}
