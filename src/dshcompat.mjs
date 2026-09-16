// dsh-rulekeeper · LF-920 **DSH 升级兼容门**（三版本 + 契约探针）
//
// 为什么需要：本工具挂的是**宿主（DSH）的插件契约**（事件名 / 形参 / decision 形状）。宿主要是一升级、
//   契约漂了，我们的门禁/注入就会**静默失效**（最坏是"看起来在跑、其实没挂上"）。所以升级前后必须能一键探。
//
// 判据（清单 LF-920）：**探针 pass**；**三版本原文入凭证**；红态：**故意把事件名改错 → 探针必红**（防恒真判据）。
//
// 设计取舍：这是**宿主环境探针**，不是规则/门禁判决 ⇒ 不塞进 `dsh-rulekeeper <子命令>`（不污染 SUBCOMMANDS 契约），
//   独立 bin `rk-dshcompat.mjs` 直调本模块。零依赖：只用 node:*。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 契约 token（**实测自 dsh 0.1.5-rc.1 安装面**；升级后若这里全查不到 ⇒ 探针必红，提示人工复核） */
export const CONTRACT_TOKENS = Object.freeze({
  事件名: ['pre-execute', 'tools/pre', 'plugin/'],
  API形态: ['ctx.effect', 'tools.register', 'waterfall'],
});

/** 默认 DSH 安装根（各平台常见位置；可用 `--dsh-root` 覆盖） */
export function defaultDshRoot(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const appdata = env.APPDATA ?? '';
    return appdata === '' ? null : join(appdata, 'npm', 'node_modules', '@deepseek-ai', 'dsh');
  }
  const home = env.HOME ?? '';
  const candidates = [
    '/usr/lib/node_modules/@deepseek-ai/dsh',
    '/usr/local/lib/node_modules/@deepseek-ai/dsh',
    home === '' ? null : join(home, '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
  ].filter((p) => p !== null);
  return candidates[0] ?? null;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 三版本：dsh 本体 / cordis / dsh-tools（后者按 package.json 名字里含 tool 自动发现） */
export function readVersions(dshRoot) {
  const root = dshRoot;
  const dsh = readJson(join(root, 'package.json'));
  const deps = dsh?.dependencies ?? {};
  const cordisName = Object.keys(deps).find((n) => n.endsWith('/cordis') || n === 'cordis') ?? null;
  const cordisPkg = cordisName === null ? null : readJson(join(root, 'node_modules', cordisName, 'package.json'));
  let toolsName = null;
  let toolsVersion = null;
  // 泛化发现（不写死 @deepseek-ai 作用域）：node_modules/* 与 node_modules/@scope/*
  const nm = join(root, 'node_modules');
  const candidates = [];
  if (existsSync(nm)) {
    for (const entry of readdirSync(nm)) {
      if (entry.startsWith('@')) {
        const scopeDir = join(nm, entry);
        try {
          for (const sub of readdirSync(scopeDir)) candidates.push(join(scopeDir, sub));
        } catch { /* 忽略不可读 */ }
      } else {
        candidates.push(join(nm, entry));
      }
    }
  }
  for (const dir of candidates) {
    const base = dir.split(/[\\/]/).pop() ?? '';
    if (!/tool/i.test(base)) continue;
    const pj = readJson(join(dir, 'package.json'));
    if (pj !== null && typeof pj.version === 'string') {
      toolsName = pj.name ?? base;
      toolsVersion = pj.version;
      break;
    }
  }
  return {
    dsh: dsh === null ? null : { name: dsh.name ?? null, version: dsh.version ?? null },
    cordis: cordisPkg === null
      ? { declared: cordisName, name: cordisName, version: null }
      : { declared: cordisName, name: cordisPkg.name ?? cordisName, version: cordisPkg.version ?? null },
    dshTools: toolsName === null ? null : { name: toolsName, version: toolsVersion },
    node: process.version,
  };
}

/** 扫安装面里哪些文件含某 token（**只看"有没有"，不判断语义**；语义由人复核） */
export function scanTokens(dshRoot, tokens, { maxFiles = 20000 } = {}) {
  const hits = new Map(tokens.map((t) => [t, 0]));
  let scanned = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (scanned >= maxFiles) return;
      const abs = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!/\.(js|mjs|cjs|ts|d\.ts)$/.test(e.name)) continue;
      scanned += 1;
      let text;
      try {
        if (statSync(abs).size > 4 * 1024 * 1024) continue;
        text = readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      for (const t of tokens) {
        if (text.includes(t)) hits.set(t, hits.get(t) + 1);
      }
    }
  };
  walk(dshRoot);
  return { hits, scanned };
}

/**
 * 契约探针：三版本齐 + 两组 token 各至少命中 1 个文件。
 * @returns {{ok, versions, cases: {name, ok, detail}[], scanned}}
 */
export function dshCompatProbe({ dshRoot, tokens = CONTRACT_TOKENS, maxFiles = 20000 } = {}) {
  const cases = [];
  if (typeof dshRoot !== 'string' || dshRoot === '' || !existsSync(dshRoot)) {
    return { ok: false, versions: null, cases: [{ name: 'dsh 安装根存在', ok: false, detail: `找不到 DSH 安装根: ${String(dshRoot)}（用 --dsh-root 指定）` }], scanned: 0 };
  }
  const versions = readVersions(dshRoot);
  cases.push({ name: 'dsh 本体可解析（name+version）', ok: versions.dsh !== null && typeof versions.dsh.version === 'string' && versions.dsh.version !== '', detail: `dsh=${versions.dsh?.name ?? '(none)'}@${versions.dsh?.version ?? '(none)'}` });
  cases.push({ name: 'cordis 为声明依赖且可解析', ok: versions.cordis.declared !== null && typeof versions.cordis.version === 'string', detail: `declared=${versions.cordis.declared ?? '(none)'} version=${versions.cordis.version ?? '(none)'}` });
  const allTokens = [...tokens.事件名, ...tokens.API形态];
  const { hits, scanned } = scanTokens(dshRoot, allTokens, { maxFiles });
  for (const [group, list] of Object.entries(tokens)) {
    const missing = list.filter((t) => (hits.get(t) ?? 0) === 0);
    cases.push({
      name: `契约 token 组「${group}」至少各命中 1 个文件`,
      ok: missing.length === 0,
      detail: missing.length === 0
        ? list.map((t) => `${t}=${hits.get(t)}`).join(' ')
        : `缺失/未命中: ${missing.join(', ')}（实测 ${list.map((t) => `${t}=${hits.get(t)}`).join(' ')}）`,
    });
  }
  return { ok: cases.every((c) => c.ok), versions, cases, scanned };
}
