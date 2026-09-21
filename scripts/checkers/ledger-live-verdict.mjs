#!/usr/bin/env node
// ledger-live-verdict.mjs —— 检查器：判据必须落在**被测对象自身的事实**上（纪律 CRED-FRESHNESS）
//
// 来历（教训 L005 + 规则 41）：写"根通道刚投过的同一段文本"去重用例时，把 `(root)` 指纹写进了
//   **会话 A 的落点**，却去**会话 B 的落点**查 ⇒ 用例假红；被测逻辑没错，是夹具把"写在哪、查在哪"
//   配错了对象。同族的真实事故更严重：用"落点里任意一条 finding"（聚合结论）当"判据拦住了载体"，
//   于是一个坏 config.json 就能让**根本没被保护的文件**拿到 EFFECT_VERIFIED。
//
// 判据（三条，任一命中 ⇒ exit 1）：
//   A. **对象级**：账本每一行的 `evidence` 里引用的每个仓库内路径，必须各自对应真实存在的文件
//      （凭据不得指向不存在的对象；历史凭据缺失 = 该结论不可复核）。
//   B. **对象级**：每条 `evidence` 项必须指定到**具体对象**——要么引用到存在的仓库内文件，
//      要么带 `key=value`（含 `=pass` / `=fail` / `=0` / 具名错误码）或 `sha256:` 指纹；
//      **只写"整份报告 ok / 全表绿"这类无对象的聚合断言** ⇒ 红（规则 41）。
//   C. **落点级与对象级分开报**：账本读取失败、行不可解析，报**落点级**故障码
//      （`LEDGER_UNREADABLE` / `LEDGER_BAD_ROW`），**不得**与对象级判据混成一个结论。
//
// 对象面（被检对象）与**反例面**（红态样本来源）分开：
//   · 被检对象 = `RULEKEEPER_SAMPLE_DIR ?? cwd`（本仓 ⇒ 判**真实**账本的凭据对象面）
//   · 反例面 = `RULEKEEPER_FIXTURE_DIR ?? cwd/test-fixtures` ⇒ 红态样本是**每次现造**的：把
//     "凭据指向不存在的对象 / 只有聚合断言"的账本逐次写进一次性临时目录（规则 42）。
//
// 约定（见 src/checker.mjs 顶部）：被检根 = `RULEKEEPER_SAMPLE_DIR ?? cwd`；
//   命中 ⇒ exit 1；干净 ⇒ exit 0；**缺账本 ⇒ exit 2**（"没有被测对象"不等于"通过"）。
//   检查器只读被检对象，只写自己的临时目录；零网络。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';

import { supersededIds } from '../../src/ledger.mjs';

// 被检对象：由绑定层传入（RULEKEEPER_SAMPLE_DIR）；直接手工跑时 = 当前目录。cwd 恒为项目根。
const root = process.env.RULEKEEPER_SAMPLE_DIR ?? process.cwd();
// 两态样本（旧口径红 / 新口径绿）只在**显式声明了 fixture 根**时检查：`test-fixtures/red` 这种
// "被检对象 = 违规样本"的用法里，fixture 根不它旁边 —— 那种情况由项目侧那次检查负责。
const fixturesDeclared = typeof process.env.RULEKEEPER_FIXTURE_DIR === 'string' && process.env.RULEKEEPER_FIXTURE_DIR !== '';
const fixtureRoot = process.env.RULEKEEPER_FIXTURE_DIR ?? join(root, 'test-fixtures');
const CANDIDATES = ['.dsh-ai/rulekeeper/ledger.jsonl', '.dsh-ai/lessonflow/ledger.jsonl'];

/** 现造一个违规样本树：凭据指向不存在的对象 + 只有聚合断言。返回 null = 样本层不可用 */
function buildRedSample() {
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), 'rk-lv-red-'));
    const landing = join(dir, '.dsh-ai', 'rulekeeper');
    mkdirSync(landing, { recursive: true });
    const bad = {
      schema: 1, id: 'L-RED', ts: '2026-01-01T00:00:00.000Z', rule: 'RED-RULE', category: '技术',
      problem: 'p', root_cause: 'r', solution: 's', mechanism: 'text', recurrence: 1,
      first_seen: '2026-01-01T00:00:00.000Z', last_seen: '2026-01-01T00:00:00.000Z', status: 'active',
      evidence: ['missing/object.json', '整份报告全绿（无对象）'],
    };
    writeFileSync(join(landing, 'ledger.jsonl'), `${JSON.stringify(bad)}\n`, 'utf8');
    return { dir, note: '凭据指向不存在的对象 + 聚合断言' };
  } catch (err) {
    if (dir !== undefined) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
    return { dir: null, note: `样本构造失败: ${String(err?.message ?? err)}` };
  }
}

const ledgerRel = CANDIDATES.find((p) => existsSync(join(root, p)));
if (ledgerRel === undefined) {
  console.log(`LEDGER_LIVE_VERDICT_LEDGER=absent（试过 ${CANDIDATES.join(' | ')}）`);
  process.exit(2);
}

/** 键值形态的对象锚点（键 = 标识符；`RESULT=pass` / `exit=1` / `approval=declared` 都算） */
const KV = /(?:^|[^\w])([A-Za-z][A-Za-z0-9_]{2,})\s*=\s*([^\s，；、）)]+)/g;
/** 具名错误码 / 指纹锚点 */
const OTHER_ANCHOR = /\b(?:sha256:[0-9a-f]{8,}|ERR-[A-Z0-9-]+|E[A-Z]{3,}\b)/;

/**
 * 这一项是不是**绝对路径**（盘符或根斜杠开头）。
 *
 * 为什么单拎出来：本仓自己的纪律明确禁绝对路径（规则 50 / S8）。而 `rk-effect apply` 写的**事件行**
 * （`EFFECT_ACTIVATE` / `EFFECT_RETIRE`）按设计要写"到底动了哪个文件"，那是事件事实、不是教训凭据；
 * 拿"凭据须可复核"去判事件行的绝对路径属**对象错位**。故绝对路径项只计数、不判红（标 `OUT_OF_SCOPE`），
 * 相对路径项照判。
 */
function isAbsolutePathish(s) {
  const t = String(s ?? '').trim();
  return /^[A-Za-z]:[\\/]/.test(t) || t.includes(':\\') || t.includes(':/') || t.startsWith('/');
}

/** 从一段文本里挑出"像仓库内相对路径"的候选（统一斜杠、去引号与首尾标点） */
function repoPathCandidates(text) {
  const out = [];
  const re = /[A-Za-z0-9_@.\-]+(?:\/[A-Za-z0-9_@.\-*]+)+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const t = m[0].replace(/[.,;:、，；）)】」'"`]+$/, '');
    if (t === '' || isAbsolute(t) || /^[A-Za-z]:/.test(t) || t.includes('\\')) continue;
    if (!/\.[A-Za-z]{1,8}$/.test(t)) continue;          // 必须有扩展名
    if (t.startsWith('..')) continue;
    out.push(t);
  }
  return out;
}

/**
 * 一段文本里出现的**文件样 token**（含"裸路径"与"叙述里提到的文件名"两种形态）。
 *
 * 为什么两种都要看：凭据的价值在于"能不能复核"。`验收报告 rk-xxx.md 附录二 F-2` 里那个文件名
 * 与 `rk-xxx.md`（裸路径）在"复核不了"这件事上没有区别 —— 所以**引用即须存在**，
 * 确属仓库外的历史凭据则必须有一条 `[evidence-repair]` 行把缺口登记下来（登记会计数，不静默）。
 */
function evidenceTokens(text) {
  const out = new Set();
  // 带扩展名的文件（相对路径或裸文件名都算）
  const reFile = /[A-Za-z0-9_@.\-]+(?:\/[A-Za-z0-9_@.\-*]+)*\.[A-Za-z]{1,8}\b/g;
  let m;
  while ((m = reFile.exec(text)) !== null) {
    // **不要去掉前导点**：`/^[.\-/]+/` 会把 `.dsh-ai/rulekeeper/rules.json` 变成
    // `dsh-ai/rulekeeper/rules.json` ⇒ 一个**存在的**对象被误判成"不存在"（写检查器时实测踩过）。
    const t = m[0].replace(/[.\-/]+$/, '');
    if (t === '' || isAbsolute(t) || /^[A-Za-z]:/.test(t) || t.includes('\\')) continue;
    if (!/\.[A-Za-z]{1,8}$/.test(t)) continue;
    if (/^v?\d+(\.\d+)*$/i.test(t)) continue;           // 纯版本号
    out.add(t);
  }
  // **目录样 token**：只认 `已知顶层目录/…` 形态（如 `test-fixtures/red`）——凭据是"某个样本目录"
  // 时才需要这一条。**故意不认** `13/13`、`F-2/F-3` 这种"比例/编号"：写检查器时实测它们被误判成
  // 路径，一次报出 4 条假阳（按 ≥30% 止损口径收紧）。
  const KNOWN_TOP = '(?:src|test|test-fixtures|scripts|bin|docs|\\.dsh-ai|\\.githooks|tools|packages|apps)';
  const reDir = new RegExp(`(?:^|[\\s（(「'"])((?:${KNOWN_TOP})/[A-Za-z0-9_@.\\-]+(?:/[A-Za-z0-9_@.\\-]+)*)`, 'g');
  while ((m = reDir.exec(text)) !== null) {
    const t = m[1].replace(/[.,;:、，；）)】」'"`]+$/, '');
    if (/\.[A-Za-z]{1,8}$/.test(t)) continue;           // 带扩展名的已由上面处理
    out.add(t);
  }
  return [...out];
}

/** 登记项标记：**裸路径指针指向的仓库外对象**必须被一条 `[evidence-repair]` 行登记（可见、可计数） */
const REPAIR_MARK = '[evidence-repair]';
/** 缺口声明形态：`缺口=<仓库外文件名>`（登记行必须逐条写明，否则"登记"就变成了笼统豁免） */
const GAP_RE = /(?:缺口|evidence-gaps?)\s*[:=]\s*([^\s，,；;。、（）()【】「」]+)/g;

/** 收集"已登记的凭据缺口"：`rule → Set(仓库外文件名)`（账本 append-only ⇒ 不能改行，只能另起一行登记） */
function collectRepairs(rows) {
  const map = new Map();
  for (const row of rows) {
    const rule = String(row?.rule ?? '');
    const parts = [
      ...(Array.isArray(row?.evidence) ? row.evidence : []),
      row?.solution,
      row?.problem,
    ].map((x) => String(x ?? ''));
    const text = parts.join(' ');
    if (!text.includes(REPAIR_MARK)) continue;
    const set = map.get(rule) ?? new Set();
    GAP_RE.lastIndex = 0;
    let m;
    while ((m = GAP_RE.exec(text)) !== null) set.add(m[1].replace(/[。；;，,）)]+$/, ''));
    map.set(rule, set);
  }
  return map;
}

/** 对被检对象做三项；返回 {hits, landingFaults, rows, acknowledged}（同样的输入给同样的结论） */
function inspectLedger(treeRoot, rel) {
  const hits = [];
  const landingFaults = [];
  const rows = [];
  const lines = readFileSync(join(treeRoot, rel), 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (t === '') continue;
    try {
      rows.push(JSON.parse(t));
    } catch (err) {
      // C. 落点级故障：单独报，不混进对象级结论
      landingFaults.push(`LEDGER_BAD_ROW line=${i + 1}: ${String(err?.message ?? err).slice(0, 80)}`);
    }
  }
  const repairs = collectRepairs(rows);
  // **被状态事件取代的行不判**（与 src/effect.mjs 的派生段同口径）：账本 append-only，"这条记错了/
  // 被后一条取代了"只能靠状态事件行表达；读侧不 fold 的话，历史行的错会**永远**在每次体检里重复喊。
  const superseded = supersededIds(rows);
  let acknowledged = 0;
  let outOfScope = 0;
  for (const row of rows) {
    const id = String(row?.id ?? '?');
    if (superseded.has(id)) continue;
    // **归档行**（`rk mutate` 的改写行）与状态事件行不进凭据对象面：它们是"改写/取代"的记录，
    // 不是一条声称"某某事发生过"的教训（同族：事件行的绝对路径也不判红）。
    if (row?.category === '状态事件' || String(row?.mechanism ?? '') === 'mutate') continue;
    const rule = String(row?.rule ?? '');
    const ev = Array.isArray(row?.evidence) ? row.evidence : [];
    // 登记行本身不是"被检凭据"（它的职责就是登记缺口），跳过——否则执法者把自己也抓了
    if (ev.some((x) => String(x ?? '').includes(REPAIR_MARK))) continue;
    if (ev.length === 0) {
      hits.push(`${id}: evidence 为空 ⇒ 结论没有对象（规则 41：判据必须落在被测对象自身）`);
      continue;
    }
    for (const item of ev) {
      const s = String(item ?? '').trim();
      if (s === '') {
        hits.push(`${id}: evidence 有空项`);
        continue;
      }
      // 事件行的绝对路径不属本判据的对象面（见 isAbsolutePathish 的注释）：只计数、不判红。
      if (isAbsolutePathish(s)) { outOfScope += 1; continue; }
      // A. **引用即须存在**：这一项里出现的每个文件和目录样 token，要么在仓库里，要么被一条
      //    `[evidence-repair]` 行登记为"确属仓库外的历史凭据"（登记项计数并打印，不静默豁免）。
      const tokens = evidenceTokens(s);
      const existing = tokens.filter((p) => existsSync(join(treeRoot, p)));
      const missing = tokens.filter((p) => !existsSync(join(treeRoot, p)));
      const ack = repairs.get(rule);
      const unacknowledged = missing.filter((p) => ack === undefined || !ack.has(p));
      for (const p of missing) if (ack !== undefined && ack.has(p)) acknowledged += 1;
      const acknowledgedHere = missing.filter((p) => ack !== undefined && ack.has(p)).length;
      if (unacknowledged.length > 0) {
        hits.push(`${id}: evidence 引用的对象「${unacknowledged[0]}」既不在仓库里，也没有 ${REPAIR_MARK} 行登记缺口 ⇒ 复核不了`);
      }
      // B. 必须有对象锚点（仓库内文件或目录 / key=value / 具名错误码 / 指纹）
      KV.lastIndex = 0;
      const hasKv = KV.test(s);
      const hasOther = OTHER_ANCHOR.test(s);
      const hasAck = acknowledgedHere > 0 || missing.length > 0 && unacknowledged.length === 0 && ack !== undefined;
      if (existing.length === 0 && !hasKv && !hasOther && !hasAck) {
        hits.push(`${id}: evidence「${s.slice(0, 60)}」没有对象锚点（既非存在的仓库内对象，也无 key=value / 错误码 / 指纹 ⇒ 疑似聚合结论）`);
      }
    }
  }
  return { hits, landingFaults, rows, acknowledged, outOfScope };
}

// ── 1) 被检对象：真实账本 ──────────────────────────────────────────────────────
const real = inspectLedger(root, ledgerRel);

// ── 2) 反例面：红态样本必须现造且必须判红（规则 42）─────────────────────────────
const red = buildRedSample();
let redNote = 'built';
if (red.dir === null) {
  real.hits.push(`反例面不可用（${red.note}）⇒ 判据无法证明自己会开火`);
} else {
  try {
    const redRel = '.dsh-ai/rulekeeper/ledger.jsonl';
    const redOut = inspectLedger(red.dir, redRel);
    redNote = `built(${red.note}) hits=${redOut.hits.length}`;
    if (redOut.hits.length === 0) real.hits.push(`反例面（${red.note}）**没有被判红** ⇒ 判据没有判别力`);
  } finally {
    try { rmSync(red.dir, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ }
  }
}

// ── 3) 两态样本必须成对入库（旧口径红 / 新口径绿）──────────────────────────────
if (fixturesDeclared) for (const k of ['red', 'green']) {
  if (!existsSync(join(fixtureRoot, 'verdict-two-state-' + k, 'README.md'))) {
    real.hits.push(`test-fixtures/verdict-two-state-${k}: 两态样本缺失（判定语义改动没有可重跑的红样本 = 一次性判据，规则 42）`);
  }
}

console.log(`LEDGER_LIVE_VERDICT_LEDGER=${ledgerRel} ROWS=${real.rows.length} RED_SAMPLE=${redNote} ACKNOWLEDGED_GAPS=${real.acknowledged} OUT_OF_SCOPE_ABS=${real.outOfScope}`);
for (const f of real.landingFaults.slice(0, 5)) console.log(`FINDING ${f}`);
if (real.hits.length > 0 || real.landingFaults.length > 0) {
  console.log(`LEDGER_LIVE_VERDICT_OBJECT_HITS=${real.hits.length} LANDING_FAULTS=${real.landingFaults.length}`);
  for (const h of real.hits.slice(0, 10)) console.log(`  ${h}`);
  process.exit(1);
}
console.log('LEDGER_LIVE_VERDICT_OBJECT_HITS=0 LANDING_FAULTS=0');
process.exit(0);
