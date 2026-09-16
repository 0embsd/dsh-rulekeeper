// dsh-rulekeeper · LF-130 平台层：时钟注入
//
// 为什么必须注入：本机实测——同一次运行的报告里任何 `ts`/`duration` 都会变，
// 于是"两次输出逐字相同"这类判据永远为假（假红）；反过来，如果判据只比字段集合，
// 又会漏掉真实的时间格式漂移（假绿）。唯一出路是**时钟可注入**：
//   --now <ISO>   或   RULEKEEPER_NOW=<ISO>
// 固定后，所有含时间戳的输出都应逐字可复现。
//
// 归属：core 模块。零依赖：只用 node:*。

/** 用法/输入错误（调用方按 rc 契约映射为 exit 2） */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/** 从 argv 里取 `--flag <value>`；缺值或下一项是另一个 flag → UsageError */
export function readFlag(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${name} 需要一个值`);
  return value;
}

/**
 * 解析"当前时间"：固定则返回注入值，未固定则取墙上时钟。
 * @param {{argv?: string[], env?: object}} [opts]
 * @returns {{fixed: boolean, date: Date, iso: string}}
 */
export function resolveNow(opts = {}) {
  const argv = opts.argv ?? [];
  const env = opts.env ?? process.env;
  const fromArg = readFlag(argv, '--now');
  const fromEnv = typeof env.RULEKEEPER_NOW === 'string' && env.RULEKEEPER_NOW.trim() !== ''
    ? env.RULEKEEPER_NOW.trim()
    : undefined;
  const raw = fromArg ?? fromEnv;
  if (raw === undefined) {
    const date = new Date();
    return { fixed: false, date, iso: date.toISOString() };
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new UsageError(`--now/RULEKEEPER_NOW 不是合法时间: ${raw}`);
  return { fixed: true, date, iso: date.toISOString() };
}

/** 稳定时间戳 `YYYYMMDD-HHMMSS`（UTC；用于凭证/日志文件名，避免时区漂移） */
export function stamp(date) {
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return [
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`,
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`,
  ].join('-');
}
