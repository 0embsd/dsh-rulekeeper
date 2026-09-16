// dsh-rulekeeper · LF-130 平台层：唯一输出器
//
// 为什么必须唯一：跨平台实测差异里，换行（os.EOL="\r\n"）、控制台编码（本机代码页 936）、
// 排序（localeCompare 依赖 ICU 与 LANG/LC_ALL）都会让"逐字相同"失真。
// 故所有输出**只经本模块**：固定 LF、ASCII 标记、码位排序、控制字符转义。
//
// 归属：core 模块。零依赖：只用 node:*。

/** 输出换行一律 LF（Windows 上也一样；CRLF 会污染 diff 与逐字比对） */
export const LF = '\n';

/** ASCII 标记（不用 ✔/✖ 等非 ASCII 符号；本机代码页 936 下会乱码） */
export const MARK = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL' });

export function line(...parts) {
  return `${parts.join(' ')}${LF}`;
}

/** 码位排序（**禁用** localeCompare / Intl.Collator：依赖 ICU 与 LANG，跨机不稳定） */
export function sortCodePoints(items) {
  return [...items].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** 转义控制字符（单行字段里禁止裸控制字符：会被终端/日志解析器误读，也是注入面的第一道）。
 *  注意含 `\r`：CRLF 的行尾污染是跨平台判据最常见失真源，故一并转义；`\n` 保留作行分隔。 */
export function escapeControl(text) {
  return String(text).replace(
    /[\u0000-\u0008\u000b-\u001f\u007f]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** 稳定 JSON：递归按码位排序键 + LF 结尾（保证同一数据两次序列化逐字相同） */
export function jsonStable(value, indent = 2) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const out = {};
      for (const key of sortCodePoints(Object.keys(v))) out[key] = walk(v[key]);
      return out;
    }
    return v;
  };
  return `${JSON.stringify(walk(value), null, indent)}${LF}`;
}

/** 约定结果行（机械判据靠它，如 `RK_SELFCHECK_RESULT=pass`） */
export function resultLine(label, ok) {
  return line(`RK_${label}_RESULT=${ok ? 'pass' : 'fail'}`);
}

export function write(text) {
  process.stdout.write(text);
}

export function writeErr(text) {
  process.stderr.write(text);
}
