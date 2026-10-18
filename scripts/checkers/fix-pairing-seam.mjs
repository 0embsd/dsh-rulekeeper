#!/usr/bin/env node
// dsh-rulekeeper · 静态 pairing-seam 判据（fix-pairing-seam@1）
//
// 目的：把「配对键必须精确等于名字（不是"最后一个 .sha256"）」这类契约**钉在源码文本上**。
//   只读文件、只做文本/正则核对，**不运行任何测试**（规则 40：测试走编排器，不直跑）。
//   语义由规格文件驱动（argv[2]，项目根相对路径），故判据本脚本不写死任何项目词汇，
//   可放到公开仓而不泄露被测项目的内部标识（规则 50/55）。
//
// 规格字段（只看这两个）：
//   requireFiles:    [{ path, contains: [子串...] }]      文件必须存在，且每个子串都出现
//   requirePatterns: [{ path, pattern, flags?, label? }]  正则必须在文件里命中
// 退出码：0 = 全过；1 = 有违规；2 = 用法/规格不可用（**不适用 ≠ 通过**）。
// 输出：每题一行 `SEAM_PAIRING_<CODE>: ...`，末行 `SEAM_PAIRING_VIOLATIONS=<n>`。

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 规格路径：`SEAM_SPEC` 环境变量 > argv[2] > 约定路径
//   tools/rulekeeper/checkers/fix-pairing-seam.json（项目根相对；bind/verify 都以 cwd = 项目根/样本根运行）。
const specRel = (() => {
  const fromEnv = typeof process.env.SEAM_SPEC === 'string' ? process.env.SEAM_SPEC.trim() : '';
  if (fromEnv !== '') return fromEnv;
  const fromArgv = typeof process.argv[2] === 'string' ? process.argv[2].trim() : '';
  if (fromArgv !== '') return fromArgv;
  return 'tools/rulekeeper/checkers/fix-pairing-seam.json';
})();

const specAbs = resolve(process.cwd(), specRel);
if (!existsSync(specAbs)) {
  console.error(`SEAM_SPEC_MISSING=${specRel}`);
  process.exit(2);
}

let spec;
try {
  spec = JSON.parse(readFileSync(specAbs, 'utf8'));
} catch (err) {
  console.error(`SEAM_SPEC_BAD_JSON=${err?.message ?? String(err)}`);
  process.exit(2);
}

const requireFiles = Array.isArray(spec?.requireFiles) ? spec.requireFiles : [];
const requirePatterns = Array.isArray(spec?.requirePatterns) ? spec.requirePatterns : [];
if (requireFiles.length + requirePatterns.length === 0) {
  console.error('SEAM_SPEC_EMPTY=规格里没有 requireFiles / requirePatterns');
  process.exit(2);
}

const findings = [];

// 被检根：verify 跑红/绿样本时通过 RULEKEEPER_SAMPLE_DIR 传入样本目录
// （checker.mjs:170-173 的约定：命令始终以 projectRoot 为 cwd，样本目录走环境变量）；
// 手工直接运行时退回 cwd。规格文件本身仍按 cwd 解析。
const rootDir = process.env.RULEKEEPER_SAMPLE_DIR ?? process.cwd();

/** 读目标文件；缺失记一条并返回 null（后续检查跳过，不重复报）。 */
function readTarget(rel) {
  const abs = resolve(rootDir, rel);
  if (!existsSync(abs)) {
    findings.push(`SEAM_PAIRING_FILE_MISSING: ${rel}`);
    return null;
  }
  return readFileSync(abs, 'utf8');
}

for (const item of requireFiles) {
  const rel = String(item?.path ?? '');
  if (rel === '') {
    findings.push('SEAM_PAIRING_SPEC_INVALID: requireFiles 条目缺 path');
    continue;
  }
  const text = readTarget(rel);
  if (text === null) continue;
  for (const token of Array.isArray(item?.contains) ? item.contains : []) {
    if (!text.includes(String(token))) {
      findings.push(`SEAM_PAIRING_TOKEN_MISSING: ${rel} token=${JSON.stringify(String(token))}`);
    }
  }
}

for (const item of requirePatterns) {
  const rel = String(item?.path ?? '');
  if (rel === '') {
    findings.push('SEAM_PAIRING_SPEC_INVALID: requirePatterns 条目缺 path');
    continue;
  }
  const text = readTarget(rel);
  if (text === null) continue;
  let re;
  try {
    re = new RegExp(String(item?.pattern ?? ''), typeof item?.flags === 'string' ? item.flags : 'm');
  } catch (err) {
    findings.push(`SEAM_PAIRING_PATTERN_INVALID: ${rel} ${err?.message ?? String(err)}`);
    continue;
  }
  if (!re.test(text)) {
    findings.push(`SEAM_PAIRING_PATTERN_MISSING: ${rel} label=${JSON.stringify(String(item?.label ?? item?.pattern ?? ''))}`);
  }
}

for (const line of findings) console.log(line);
console.log(`SEAM_PAIRING_VIOLATIONS=${findings.length}`);
process.exit(findings.length === 0 ? 0 : 1);
