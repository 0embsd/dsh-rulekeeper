// dsh-rulekeeper · LF-230 rules 规则包 + config 覆盖层 + **单点 isProtected(path)**
//
// 为什么必须"单点"：`protected_paths` 会被四处消费（protect 是否快照 / check 是否查 /
// pre-execute 是否拦 / pre-commit 是否拒）。四处各写一遍判定 = 四份实现，必然漂移。
// 故本模块把判定收敛成 `isProtected(path, rules)`，其余消费点**只能委托**它；
// `checkConsumersConsistency()` 把这条约定变成可执行断言（变异测试可证其有效性）。
//
// 字段按 LF-120 冻结表（6 个）：schema / project / protected_paths / gates / checks / inject
//
// 归属：core 模块。零依赖：只用 node:*。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { pathKey, relativeToRoot, toPosix } from './platform/paths.mjs';
import { SCHEMA_VERSION } from './schema.mjs';

export const RULES_FILE = 'rules.json';
export const CONFIG_FILE_NAME = 'config.json';
export const RULES_FIELDS = Object.freeze(['schema', 'project', 'protected_paths', 'gates', 'checks', 'inject']);
export const DEFAULT_MAX_INJECT_CHARS = 1200;
export const CONSUMERS = Object.freeze(['protect', 'check', 'pre-execute', 'pre-commit']);

/** 校验规则包：字段缺失的报错文本固定为 `missing field: <name>`（LF-230 判据②要求 stderr 逐字含它） */
export function validateRules(obj) {
  const findings = [];
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, findings: [{ code: 'RULES_NOT_OBJECT', msg: 'rules 必须是 JSON 对象' }] };
  }
  for (const field of RULES_FIELDS) {
    if (!Object.hasOwn(obj, field)) findings.push({ code: 'RULES_MISSING_FIELD', msg: `missing field: ${field}` });
  }
  if (Object.hasOwn(obj, 'schema') && obj.schema !== SCHEMA_VERSION) {
    findings.push({ code: 'RULES_SCHEMA_VERSION', msg: `schema 必须是 ${SCHEMA_VERSION}（实际 ${JSON.stringify(obj.schema)}）` });
  }
  if (Object.hasOwn(obj, 'project') && (typeof obj.project !== 'string' || obj.project.trim() === '')) {
    findings.push({ code: 'RULES_PROJECT_EMPTY', msg: 'project 必须是非空字符串（双本判别依据）' });
  }
  if (Object.hasOwn(obj, 'protected_paths') && !Array.isArray(obj.protected_paths)) {
    findings.push({ code: 'RULES_PROTECTED_NOT_ARRAY', msg: 'protected_paths 必须是数组' });
  }
  for (const field of ['gates', 'checks', 'inject']) {
    if (Object.hasOwn(obj, field) && !Array.isArray(obj[field])) {
      findings.push({ code: 'RULES_FIELD_NOT_ARRAY', msg: `${field} 必须是数组` });
    }
  }
  if (Array.isArray(obj.checks)) {
    const allowed = ['file_untracked_change', 'output_shape', 'invalid_reference'];
    for (const check of obj.checks) {
      if (typeof check === 'string' && !allowed.includes(check)) {
        findings.push({ code: 'RULES_CHECK_UNKNOWN', msg: `未知 check 类型: ${check}（只允许 ${allowed.join('/')}）` });
      }
    }
  }
  return { ok: findings.length === 0, findings };
}

export function loadRules(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const report = validateRules(parsed);
    return { ok: report.ok, rules: parsed, findings: report.findings, error: null };
  } catch (err) {
    return { ok: false, rules: null, findings: [], error: `${err.code ?? 'ERR'}: ${err.message}` };
  }
}

/**
 * 模式 → 正则：支持 `*`（段内任意）、`**`（跨层任意；`**` 后紧跟斜杠时允许零层）、`?`（单字符）；
 * 目录模式（以 `/` 结尾）自动按"该目录下所有"处理。大小写不敏感（Windows 语义，且 pathKey 已折叠）。
 *
 * 【注意】本注释里**不能**出现星号紧跟斜杠的序列——那会提前关闭块注释（2026-09-14 实测：
 * 该写法让整个文件语法崩，且报错落在几十行之后，极难定位）。
 */
export function globToRegExp(pattern) {
  const dirMode = pattern.endsWith('/');
  const src = dirMode ? `${pattern}**` : pattern;
  let re = '';
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (c === '*') {
      if (src[i + 1] === '*') {
        re += '.*';
        i += 1;
        if (src[i + 1] === '/') i += 1; // `**/` -> 允许零层目录
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

/** 把任意输入归一为"相对项目根的 posix 路径"（判定一律在这个形态上做） */
export function normalizeTarget(input, projectRoot) {
  if (typeof input !== 'string' || input.trim() === '') return null;
  const relative = relativeToRoot(input, projectRoot);
  if (relative !== null && relative !== '.') return toPosix(relative);
  return toPosix(input).replace(/^\.\//, '');
}

/**
 * **单点判定**：某个路径是否受保护。
 * @returns {{protected: boolean, matchedPattern: string|null, normalizedPath: string|null, reason: string|null}}
 */
export function isProtected(input, rules, opts = {}) {
  const patterns = Array.isArray(rules?.protected_paths) ? rules.protected_paths : [];
  const normalizedPath = normalizeTarget(input, opts.projectRoot ?? process.cwd());
  if (normalizedPath === null) {
    return { protected: false, matchedPattern: null, normalizedPath: null, reason: '路径为空' };
  }
  const key = pathKey(normalizedPath);
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern.trim() === '') continue;
    const cleaned = pattern.trim().replace(/^\.\//, '');
    if (globToRegExp(cleaned).test(key)) {
      return { protected: true, matchedPattern: cleaned, normalizedPath, reason: null };
    }
  }
  return { protected: false, matchedPattern: null, normalizedPath, reason: null };
}

// ── 四个消费点：**必须委托单点**（薄适配；真实消费路径在 P3/P4/P5 落地） ──────────────
export function asProtect(path, rules, opts) {
  return isProtected(path, rules, opts).protected;
}
export function asCheck(path, rules, opts) {
  return isProtected(path, rules, opts).protected;
}
export function asPreExecute(path, rules, opts) {
  return isProtected(path, rules, opts).protected;
}
export function asPreCommit(path, rules, opts) {
  return isProtected(path, rules, opts).protected;
}

export function consumerVerdict(name, path, rules, opts) {
  switch (name) {
    case 'protect': return asProtect(path, rules, opts);
    case 'check': return asCheck(path, rules, opts);
    case 'pre-execute': return asPreExecute(path, rules, opts);
    case 'pre-commit': return asPreCommit(path, rules, opts);
    default: throw new Error(`未知消费点: ${name}（只允许 ${CONSUMERS.join('|')}）`);
  }
}

/**
 * 四点一致性：对每个探针路径，四个消费点的判定必须与单点一致。
 * @param {object} rules
 * @param {string[]} paths
 * @param {{projectRoot?: string, consumers?: Record<string, Function>}} [opts]
 *        consumers 可注入替身，用于**变异测试**（证明该断言不是恒真）
 * @returns {{ok: boolean, findings: object[], probes: object[]}}
 */
export function checkConsumersConsistency(rules, paths, opts = {}) {
  const findings = [];
  const probes = [];
  const overrides = opts.consumers ?? null;
  for (const path of paths) {
    const single = isProtected(path, rules, opts).protected;
    const verdicts = {};
    for (const name of CONSUMERS) {
      let value;
      try {
        value = overrides !== null && typeof overrides[name] === 'function'
          ? overrides[name](path, rules, opts)
          : consumerVerdict(name, path, rules, opts);
      } catch (err) {
        value = `ERROR:${err.message}`;
      }
      verdicts[name] = value;
      if (value !== single) {
        findings.push({
          code: 'RULES_CONSUMER_DIVERGED',
          msg: `消费点 ${name} 对 ${path} 判定 ${JSON.stringify(value)}，与单点 ${JSON.stringify(single)} 不一致`,
          consumer: name, path, single, actual: value,
        });
      }
    }
    probes.push({ path, single, verdicts });
  }
  return { ok: findings.length === 0, findings, probes };
}

/** 运行时覆盖层：config.json 覆盖 rules.json（config 优先） */
export function effectiveConfig(opts = {}) {
  const rules = opts.rules ?? null;
  const config = opts.config ?? null;
  return {
    mode: config?.mode ?? 'observe',
    project: rules?.project ?? null,
    protected_paths: Array.isArray(config?.protected_paths) ? config.protected_paths : (rules?.protected_paths ?? []),
    ledgerPath: config?.ledgerPath ?? 'ledger.jsonl',
    maxInjectChars: Number.isInteger(config?.maxInjectChars) ? config.maxInjectChars : DEFAULT_MAX_INJECT_CHARS,
    sources: {
      protected_paths: Array.isArray(config?.protected_paths) ? 'config.json' : 'rules.json',
      mode: config?.mode === undefined ? '(默认 observe)' : 'config.json',
      maxInjectChars: Number.isInteger(config?.maxInjectChars) ? 'config.json' : '(默认 1200)',
    },
  };
}

/** 从落点读取 rules.json / config.json（缺文件不算错，返回 null） */
export function loadLandingRules(landingDir) {
  const rulesPath = join(landingDir, RULES_FILE);
  const configPath = join(landingDir, CONFIG_FILE_NAME);
  const rulesResult = existsSync(rulesPath) ? loadRules(rulesPath) : { ok: true, rules: null, findings: [], error: null, missing: true };
  let config = null;
  let configError = null;
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (err) {
      configError = `${err.code ?? 'ERR'}: ${err.message}`;
    }
  }
  return { rulesResult, config, configError, rulesPath, configPath };
}
