// dsh-rulekeeper · LF-140 退出码契约表（**唯一权威源**）
//
// 为什么必须成表：§9.8 rc 契约变更纪律——退出码是契约、不是实现细节；写「期望 rc = N」前必须
// 逐站点核对，禁凭印象。本文件把三面（CLI / hook / plugin）的 rc 语义集中声明，
// 并由 bin/rk-rc.mjs --check 机械校验：重复、(surface,code) 冲突、证据测试是否真的存在、
// 计划项是否带 owner。实现方（cli.mjs）从 RC 常量取值，禁止散落的字面量。
//
// 归属：core 模块。零依赖：只用 node:*。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 数值常量（实现方引用它，避免裸数字） */
export const RC = Object.freeze({ OK: 0, FAIL: 1, USAGE: 2, NO_SNAPSHOT: 3, NO_BACKUP: 4, NOT_IMPLEMENTED: 5 });

export const SURFACES = Object.freeze(['cli', 'hook', 'plugin']);

/**
 * 契约表。字段：
 *   surface   三面之一
 *   code      退出码
 *   name      短名（机读用）
 *   meaning   语义（人读）
 *   status    implemented（有可跑用例）| planned（未实现，必须带 owner）
 *   evidence  implemented 必须有 { file, test }；test 必须是该文件里真实存在的 test 名
 *   owner     planned 必须指向清单条目号
 *   note      自由说明
 */
export const RC_TABLE = Object.freeze([
  {
    surface: 'cli',
    code: RC.OK,
    name: 'OK',
    meaning: '成功',
    status: 'implemented',
    evidence: { file: 'test/rc.test.mjs', test: 'cli rc=0：init 成功并建立两处落点' },
  },
  {
    surface: 'cli',
    code: RC.FAIL,
    name: 'FAIL',
    meaning: '运行失败（落点建立/写盘失败等运行期异常）或**判定为不合格**（如 evolve 的提案缺质量要件/被闸门拒绝、账本不洁、check 判 violation）',
    status: 'implemented',
    evidence: { file: 'test/rc.test.mjs', test: 'cli rc=1：init 运行期失败（落点不可创建）' },
  },
  {
    surface: 'cli',
    code: RC.USAGE,
    name: 'USAGE',
    meaning: '用法/输入错误（未知子命令或参数、--project 非已存在目录、--now 非法、缺 --root）',
    status: 'implemented',
    evidence: { file: 'test/rc.test.mjs', test: 'cli rc=2：用法错误（未知子命令/非法 --project/非法 --now）' },
  },
  {
    surface: 'cli',
    code: RC.NO_SNAPSHOT,
    name: 'NO_SNAPSHOT',
    meaning: 'restore 时该路径没有快照（禁静默成功）',
    status: 'implemented',
    evidence: { file: 'test/snap.test.mjs', test: 'cli rc=3：restore 时该路径没有快照 -> NO_SNAPSHOT，且目标文件不变' },
  },
  {
    surface: 'cli',
    code: RC.NO_BACKUP,
    name: 'NO_BACKUP',
    meaning: 'restore 时备份文件缺失（禁静默成功；LF-190 已实现，LF-310 将复用同一语义）',
    status: 'implemented',
    evidence: { file: 'test/backup.test.mjs', test: 'cli rc=4：restore 时备份缺失 -> NO_BACKUP，且目标文件不变' },
  },
  {
    surface: 'cli',
    code: RC.NOT_IMPLEMENTED,
    name: 'NOT_IMPLEMENTED',
    meaning: '**保留码**：能力尚未实现时使用。LF-300 落地后 CLI 已无未实现子命令（码值不得复用、不得删除）',
    status: 'implemented',
    evidence: { file: 'test/cli.test.mjs', test: 'cli rc=5：NOT_IMPLEMENTED 是保留码（当前无子命令返回它，且码值固定为 5）' },
  },
  {
    surface: 'hook',
    code: RC.FAIL,
    name: 'HOOK_DENY',
    meaning: 'git hook 拒绝（受保护路径无留证 / hook 完整性不符）',
    status: 'planned',
    owner: 'LF-500',
    note: 'hook 门禁未实现（P5）；数值沿用 1（hook 以非 0 即拒绝）',
  },
  {
    surface: 'plugin',
    code: RC.FAIL,
    name: 'PLUGIN_SELFCHECK_FAIL',
    meaning: '插件装载自检失败（注册了不存在的事件名 / 工具名冲突）',
    status: 'planned',
    owner: 'LF-400',
    note: '插件未实现（P4）',
  },
]);

const OWNER_RE = /^LF-[0-9A-F]{2,3}[A-Z]?$/;

/**
 * 机械校验契约表。
 * @param {{root?: string, table?: object[], readFile?: (p:string)=>string, exists?: (p:string)=>boolean}} [opts]
 * @returns {{ok: boolean, findings: {code:string,msg:string}[]}}
 */
export function checkRcTable(opts = {}) {
  const root = opts.root ?? process.cwd();
  const table = opts.table ?? RC_TABLE;
  const exists = opts.exists ?? ((p) => existsSync(p));
  const readText = opts.readFile ?? ((p) => readFileSync(p, 'utf8'));
  const findings = [];
  const add = (code, msg) => findings.push({ code, msg });

  const seen = new Map();
  for (const entry of table) {
    const label = `${entry?.surface ?? '?'}/${entry?.code ?? '?'}`;
    if (!SURFACES.includes(entry?.surface)) {
      add('RC_SURFACE_BAD', `${label}: surface 必须是 ${SURFACES.join('|')} 之一`);
      continue;
    }
    if (!Number.isInteger(entry.code) || entry.code < 0 || entry.code > 125) {
      add('RC_CODE_BAD', `${label}: code 必须是 0..125 的整数`);
    }
    if (typeof entry.name !== 'string' || entry.name.trim() === '') add('RC_NAME_MISSING', `${label}: 缺 name`);
    if (typeof entry.meaning !== 'string' || entry.meaning.trim() === '') add('RC_MEANING_MISSING', `${label}: 缺 meaning`);

    const key = `${entry.surface}/${entry.code}`;
    if (seen.has(key)) {
      add('RC_DUP', `${key}: 与他项重复（先出现 name=${seen.get(key)}，本项 name=${entry.name}）`);
    } else {
      seen.set(key, entry.name);
    }

    if (entry.status === 'implemented') {
      const ev = entry.evidence;
      if (!ev || typeof ev.file !== 'string' || typeof ev.test !== 'string') {
        add('RC_EVIDENCE_MISSING', `${key}: implemented 必须带 evidence{file,test}`);
        continue;
      }
      const abs = join(root, ev.file);
      if (!exists(abs)) {
        add('RC_EVIDENCE_FILE_MISSING', `${key}: 证据文件不存在 ${ev.file}`);
        continue;
      }
      if (!readText(abs).includes(`'${ev.test}'`) && !readText(abs).includes(`"${ev.test}"`)) {
        add('RC_EVIDENCE_TEST_MISSING', `${key}: 证据文件 ${ev.file} 里找不到名为「${ev.test}」的用例`);
      }
    } else if (entry.status === 'planned') {
      if (typeof entry.owner !== 'string' || !OWNER_RE.test(entry.owner)) {
        add('RC_OWNER_MISSING', `${key}: planned 必须带形如 LF-500 的 owner（实际 ${JSON.stringify(entry.owner)}）`);
      }
    } else {
      add('RC_STATUS_BAD', `${key}: status 必须是 implemented|planned（实际 ${JSON.stringify(entry.status)}）`);
    }
  }

  for (const surface of SURFACES) {
    if (!table.some((e) => e.surface === surface)) {
      add('RC_SURFACE_MISSING', `契约表未覆盖 ${surface} 面（三面必须都有条目）`);
    }
  }

  return { ok: findings.length === 0, findings };
}

/** 渲染为 markdown 表（供文档/人工复核） */
export function renderRcTable(table = RC_TABLE) {
  const rows = [
    '| 面 | rc | 短名 | 语义 | 状态 | 凭据/归属 |',
    '|---|---|---|---|---|---|',
  ];
  for (const e of table) {
    const proof = e.status === 'implemented'
      ? `${e.evidence.file} :: ${e.evidence.test}`
      : `${e.owner}${e.note ? `（${e.note}）` : ''}`;
    rows.push(`| ${e.surface} | ${e.code} | ${e.name} | ${e.meaning} | ${e.status} | ${proof} |`);
  }
  return `${rows.join('\n')}\n`;
}
