// dsh-rulekeeper · 测试沙箱助手（LF-150）
//
// 为什么需要：LF-100 的用例曾在测试文件里**内联**构造临时副本；到 LF-130/LF-140 会大量复用，
// 故抽成助手。所有临时目录都登记在 CLEANUPS 里，测试结束统一清掉，**不碰真实落点**。
//
// 注意：node --test 会把 test/ 下所有 .mjs 当测试文件加载，故本文件（无 test() 调用）会以
// "0 个用例的文件"出现，属预期；fixtures 一律用非 .mjs 扩展名（见 test/fixtures/README 说明）。

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** dsh-rulekeeper 包根（<pkg>/test/helpers/sandbox.mjs → 上溯 3 级） */
export const PKG_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const FIXTURES_DIR = join(PKG_ROOT, 'test', 'fixtures');

const CLEANUPS = [];

export function tempDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `lf-${label}-`));
  CLEANUPS.push(dir);
  return dir;
}

/** 造"全新项目 + 全新 DSH_HOME"的隔离环境 */
export function freshProject(label) {
  const root = tempDir(label);
  const projectRoot = join(root, 'proj');
  const home = join(root, 'lfhome');
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { root, projectRoot, home, env: { ...process.env, DSH_HOME: home } };
}

/** 拷贝一份包到临时目录（用于注入违规，不动真实包） */
export function copyPkg(label) {
  const dst = join(tempDir(label), 'pkg');
  cpSync(PKG_ROOT, dst, { recursive: true });
  return dst;
}

export function readFixture(name) {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8');
}

/**
 * 造一个"能跑的落点"（LF-280/290/295 用）：`config.json` + `rules.json` + `ledger.jsonl`。
 * 两个实测来的硬前提：
 *   · `rules.json` 必须**先存在**，否则"evolve 没动过 rules.json"这条判据是**空判**（sha 前后都是 null）
 *   · `ledger.jsonl` 末行**必须带换行**：readLines 把"末尾没有换行的行"当作没写完的半行
 *     （LF-160 的 truncatedTail 语义）——实测漏掉换行会让第 2 条记录静默消失、候选数变 0
 */
export function freshLanding(label, { mode = 'observe', entries = [], rules = true } = {}) {
  const root = tempDir(label);
  const landing = join(root, 'landing');
  mkdirSync(landing, { recursive: true });
  writeFileSync(join(landing, 'config.json'), `${JSON.stringify({ schema: 1, mode }, null, 2)}\n`, 'utf8');
  if (rules) writeFileSync(join(landing, 'rules.json'), readFixture('rules-ok.json'), 'utf8');
  const body = entries.map((e) => JSON.stringify(e)).join('\n');
  writeFileSync(join(landing, 'ledger.jsonl'), entries.length === 0 ? '' : `${body}\n`, 'utf8');
  return { root, landing };
}

/** 一条合法账本行（字段取自 LF-120 冻结表；`activation` 是 P0-2 新增的**可选**字段） */
export function ledgerEntry({ id, ts, rule, category = '纪律', problem = 'p', rootCause = 'r', solution = 's', mechanism = 'm', evidence = [], activation }) {
  const row = {
    schema: 1, id, ts, rule, category, problem, root_cause: rootCause, solution,
    evidence, mechanism, recurrence: 1, first_seen: ts, last_seen: ts, status: 'active',
  };
  // 可选字段：**仅在显式给出时写入**（既有用例的行形状保持不变——它们不传 activation）
  if (activation !== undefined) row.activation = activation;
  return row;
}

export function cleanupAll() {
  while (CLEANUPS.length > 0) {
    const dir = CLEANUPS.pop();
    rmSync(dir, { recursive: true, force: true });
  }
}
