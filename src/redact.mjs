// dsh-rulekeeper · LF-340 **脱敏**（隐私/凭据不落盘）
//
// 立场（老板 2026-09-15）：「我们是通用 DSH 功能，不是记录个人隐私数据的，所以要以脱敏」。
//
// 三条纪律（设计单 `.dsh-ai/design/dsh-rulekeeper-redaction-design.md`）：
//   ① **写入侧单点**：所有落盘入口先过这里的 `redactText`/`redactValue`；别处不许自己写正则（⑰ 一套实现）。
//   ② **只出计数不出原文**：`statsOf()` 只返回 {total, byRule}；本模块**永不**把命中的原文写进任何返回值。
//   ③ **可核对但不可逆**：替换成 `[RULE:sha12]`（同一原文 → 同一摘要，可跨行核对"是不是同一个值"）。
//      明确不声称"密钥移除"——这是 **known-pattern scrubbing**，不是 secret removal。
//
// 规则表**单一事实源** + **加载即自测**（规则与样本不同步就 throw，防"改了正则忘了改样本"的静默漂移）。

import { createHash } from 'node:crypto';

const sha12 = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);

/** 已脱敏占位符：`[RULE:xxxxxxxxxxxx]`（**幂等**：二次脱敏不得再动它） */
export const PLACEHOLDER_RE = /\[[A-Z_]+:[0-9a-f]{12}\]/g;

/**
 * 规则表（**单一事实源**）。每条：`name` / `re`（全局）/ `mask`（命中后如何替换；返回 null 表示不脱敏）。
 * `identity` 类默认**关**（需实体库，缺库不许假装处理过）。
 */
export const RULES = Object.freeze([
  // ① 家目录与用户名路径：保留路径形状，掩用户名
  {
    name: 'PATH_HOME',
    re: /([A-Za-z]:\\Users\\)(?!<|\*|\[)([^\\\s"'|:;]+)|(\/(?:home|Users)\/)(?!<|\*|\[)([^/\s"'|:;]+)/g,
    mask: (m, g) => `${g[0] ?? g[2]}<user>`,
  },
  // ② 私钥块（整块）
  {
    name: 'PRIVATE_KEY',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    mask: () => '[PRIVATE_KEY:redacted]',
  },
  // ③ 已知凭据形态
  {
    name: 'CRED_KEY',
    re: /\b(?:sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{6,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})\b/g,
    mask: (m) => `[CRED_KEY:${sha12(m)}]`,
  },
  // ④ 键值型凭据赋值（**按 key 名**检测；保留 key 名供定位）
  {
    name: 'CRED_ASSIGN',
    re: /\b(password|passwd|passphrase|secret|token|api[_-]?key|apikey|client[_-]?secret|private[_-]?key|access[_-]?key|pin|otp)\b(\s*[=:]\s*)(["']?)(?!<|\[|\$)([^\s"',;)\]]{6,})\3/gi,
    mask: (m, g) => `${g[0]}${g[1]}${g[2]}[CRED_ASSIGN:${sha12(g[3])}]${g[2]}`,
  },
  // ⑤ 连接串里的内嵌密码
  {
    name: 'CRED_DSN',
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^:@/\s]+):([^@/\s]{3,})@/gi,
    mask: (m, g) => `${g[0]}:[CRED_DSN:${sha12(g[1])}]@`,
  },
  // ⑥ 头部凭据（保头名、掩值）
  {
    name: 'CRED_HEADER',
    re: /\b(Authorization|Cookie|Set-Cookie|X-Api-Key)(\s*:\s*)(?!<|\[)([^\r\n]{6,})/gi,
    mask: (m, g) => `${g[0]}${g[1]}[CRED_HEADER:${sha12(g[2])}]`,
  },
  // ⑦ 联系方式：邮箱（保域名）
  {
    name: 'EMAIL',
    re: /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g,
    mask: (m, g) => `[EMAIL:${sha12(m)}]@${g[1]}`,
  },
  // ⑧ 中国大陆手机号
  {
    name: 'PHONE_CN',
    re: /(?<![0-9])1[3-9][0-9]{9}(?![0-9])/g,
    mask: (m) => `[PHONE_CN:${sha12(m)}]`,
  },
]);

/** `identity` 类（默认关）：身份证 18 位 */
export const IDENTITY_RULES = Object.freeze([
  {
    name: 'ID_CN',
    re: /(?<![0-9])[1-9][0-9]{5}(?:19|20)[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])[0-9]{3}[0-9Xx](?![0-9])/g,
    mask: (m) => `[ID_CN:${sha12(m)}]`,
  },
]);

/** 规则自测样本（**与规则表同源**：改规则不改样本 → 加载即 throw） */
const SAMPLES = Object.freeze([
  ['PATH_HOME', 'C:\\Users\\zhangsan\\proj', 'C:\\Users\\<user>\\proj'],
  ['PATH_HOME', '/home/lisi/x', '/home/<user>/x'],
  ['PRIVATE_KEY', '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----', '[PRIVATE_KEY:redacted]'],
  ['CRED_KEY', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', null], // null = 只要求"被命中且原值消失"
  ['CRED_ASSIGN', 'password=hunter2secret', null],
  ['CRED_DSN', 'postgres://user:s3cretpw@db:5432/x', null],
  ['CRED_HEADER', 'Authorization: Bearer abcdef123456', null],
  ['EMAIL', 'zhang.san@example.com', null],
  ['PHONE_CN', '13800138000', null],
]);

/**
 * 规则自测：每条规则的样本必须被命中；`notMask` 的**负面样本**必须**不**命中（防规则写宽到乱杀）。
 * 不同步即 throw（sofagent 的"规则漂移自测"思路）。
 */
export function selfTestRules() {
  const all = [...RULES, ...IDENTITY_RULES];
  const negatives = [
    ['PATH_HOME', 'C:\\Users\\<user>\\proj'],
    ['EMAIL', 'not-an-email@'],
    ['PHONE_CN', '23800138000'],
  ];
  for (const [name, sample, expect] of SAMPLES) {
    const rule = all.find((r) => r.name === name);
    if (rule === undefined) throw new Error(`redact: 规则表缺 ${name}（样本与规则不同步）`);
    const re = new RegExp(rule.re.source, rule.re.flags);
    if (!re.test(sample)) throw new Error(`redact: 规则 ${name} 命中不了自带样本（规则漂移）`);
    if (expect !== null) {
      const out = redactText(sample, { rules: [rule] }).text;
      if (out !== expect) throw new Error(`redact: 规则 ${name} 输出与样本不符（期望 ${expect}，实得 ${out}）`);
    } else {
      const out = redactText(sample, { rules: [rule] }).text;
      if (out.includes(sample)) throw new Error(`redact: 规则 ${name} 把原值留下来了`);
    }
  }
  for (const [name, bad] of negatives) {
    const rule = all.find((r) => r.name === name);
    const re = new RegExp(rule.re.source, rule.re.flags);
    if (re.test(bad)) throw new Error(`redact: 规则 ${name} 误伤负面样本 ${bad}`);
  }
  return { rules: all.length, samples: SAMPLES.length + negatives.length };
}

/**
 * 文本脱敏（**唯一入口**）。
 * @param {string} text
 * @param {{rules?: object[], identity?: boolean}} [opts] identity=true 时才带 `identity` 类规则
 * @returns {{text: string, hits: {rule: string, count: number}[], total: number, truncated: boolean}}
 */
export function redactText(text, opts = {}) {
  const src = typeof text === 'string' ? text : String(text ?? '');
  const rules = opts.rules ?? [...RULES, ...(opts.identity === true ? IDENTITY_RULES : [])];
  if (rules.length === 0) throw new Error('redact: 规则表为空（fail-closed：没有规则就不许声称"已脱敏"）');
  let out = src;
  const hits = [];
  for (const rule of rules) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    let count = 0;
    out = out.replace(re, (...args) => {
      // 参数尾部是 offset/string/groups；groups 在最后（对象）或 undefined
      const groups = args[args.length - 1];
      const g = Array.isArray(groups) ? args.slice(1, -2) : args.slice(1, -2);
      const masked = rule.mask(args[0], g);
      if (masked === null) return args[0];
      count += 1;
      return masked;
    });
    if (count > 0) hits.push({ rule: rule.name, count });
  }
  const total = hits.reduce((a, b) => a + b.count, 0);
  return { text: out, hits, total, truncated: false };
}

/** 递归处理对象/数组（只动字符串；**键名不动**，否则会破坏字段契约） */
export function redactValue(value, opts = {}) {
  const hits = [];
  const walk = (v) => {
    if (typeof v === 'string') {
      const r = redactText(v, opts);
      if (r.total > 0) hits.push(...r.hits);
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const o = {};
      for (const [k, val] of Object.entries(v)) o[k] = walk(val);
      return o;
    }
    return v;
  };
  const out = walk(value);
  return { value: out, hits: mergeHits(hits), total: hits.reduce((a, b) => a + b.count, 0) };
}

/** 合并同类命中（**只出计数**） */
export function mergeHits(hits) {
  const map = new Map();
  for (const h of hits) map.set(h.rule, (map.get(h.rule) ?? 0) + h.count);
  return [...map.entries()].map(([rule, count]) => ({ rule, count })).sort((a, b) => (a.rule < b.rule ? -1 : 1));
}

/** 统计（**永不返回原文或映射**）：只给 {total, byRule} */
export function statsOf(hits) {
  const merged = mergeHits(hits);
  return { total: merged.reduce((a, b) => a + b.count, 0), byRule: merged };
}

/** 扫描一段文本里**残留**的敏感模式（供 `rk-redact --check`；只返回规则名与计数） */
export function scanText(text, opts = {}) {
  const src = typeof text === 'string' ? text : String(text ?? '');
  const rules = opts.rules ?? [...RULES, ...(opts.identity === true ? IDENTITY_RULES : [])];
  const found = [];
  for (const rule of rules) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    const m = src.match(re);
    if (m !== null && m.length > 0) found.push({ rule: rule.name, count: m.length });
  }
  return { hits: found, total: found.reduce((a, b) => a + b.count, 0) };
}
