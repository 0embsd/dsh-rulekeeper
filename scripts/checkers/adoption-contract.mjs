#!/usr/bin/env node
// adoption-contract.mjs —— 检查器：入账**必须登记机制面**（纪律 CAT-PROC）
//
// 来历（教训 L002 + 规则 46）：规则正文只是"正文面"，**不产生任何拦截**。真实事故是"判定语义
//   单方面改了、文档与判据没同源"，根因是同一条纪律**没有机制面**：写下来了、没人读、没人拦。
//   所以本检查器不判"文档措辞好不好"，只判**入账契约本身**：
//
// 判据（三条，任一命中 ⇒ exit 1）：
//   A. **机制面必填且四选一**：账本每行的 `mechanism` 必须是
//      `text`（承认仅文本、不拦）/ `mechanized`（机械判据）/ `guard`（插件拦截）/ `question`（人工问句）
//      之一；空值、拼错、或写一句自由文本（如"靠自觉"）⇒ 红（免责成本太低 = 等于没登记）。
//   B. **声明了就要有**：`mechanism=mechanized` 的行，`rule` 必须在 `rules.json` 的 `checks` 里
//      有绑定；`mechanism=guard` 的行必须在 `gates` 里有绑定（空转的机制面声明 = 自称型控制）。
//   C. **只写下来了要计数**：`mechanism=text` 的行必须能在体检面被读出来（本检查器自己打印
//      `ADOPTION_TEXT_ONLY` 计数），不得静默。
//
// 对象面（被检对象）与**反例面**（红态样本来源）分开：
//   · 被检对象 = `RULEKEEPER_SAMPLE_DIR ?? cwd`（本仓 ⇒ 判**真实**账本的机制面登记）
//   · 反例面 = `RULEKEEPER_FIXTURE_DIR ?? cwd/test-fixtures` ⇒ 红态样本是**每次现造**的：把
//     "mechanism 拼错 / 声明 mechanized 却没有绑定"的账本逐次写进一次性临时目录（规则 42）。
//
// 约定（见 src/checker.mjs 顶部）：被检根 = `RULEKEEPER_SAMPLE_DIR ?? cwd`；
//   命中 ⇒ exit 1；干净 ⇒ exit 0；**缺账本 ⇒ exit 2**（没有被测对象 ≠ 通过）。
//   检查器只读被检对象，只写自己的临时目录；零网络。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 读侧 fold（P2）：把 `rk mutate` 归档行的字段值应用回目标 id。**唯一权威源**在插件包里，
// 故这里 import（检查器随包走；被治理项目通过 checkerRef 引用同一份实现，不会各写一遍）。
import { foldMutates } from '../../src/ledger-mutate.mjs';

// 被检对象：由绑定层传入（RULEKEEPER_SAMPLE_DIR）；直接手工跑时 = 当前目录。cwd 恒为项目根。
const root = process.env.RULEKEEPER_SAMPLE_DIR ?? process.cwd();
// 两态样本（旧口径红 / 新口径绿）只在**显式声明了 fixture 根**时检查：`test-fixtures/red` 这种
// "被检对象 = 违规样本"的用法里，fixture 根不它旁边 —— 那种情况由项目侧那次检查负责。
const fixturesDeclared = typeof process.env.RULEKEEPER_FIXTURE_DIR === 'string' && process.env.RULEKEEPER_FIXTURE_DIR !== '';
const fixtureRoot = process.env.RULEKEEPER_FIXTURE_DIR ?? join(root, 'test-fixtures');
const LEDGERS = ['.dsh-ai/rulekeeper/ledger.jsonl', '.dsh-ai/lessonflow/ledger.jsonl'];
const RULES = ['.dsh-ai/rulekeeper/rules.json', '.dsh-ai/lessonflow/rules.json'];

/** 机制面四选一（与 src/ledger.mjs 的口径同源；这里独立一份是为了检查器能单跑） */
const MECHANISM_FACES = Object.freeze(['text', 'mechanized', 'guard', 'question']);

/** 现造一个违规样本树：mechanism 拼错 + 声明 mechanized 却没有绑定。返回 null = 样本层不可用 */
function buildRedSample() {
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), 'rk-ac-red-'));
    const landing = join(dir, '.dsh-ai', 'rulekeeper');
    mkdirSync(landing, { recursive: true });
    const base = { schema: 1, ts: '2026-01-01T00:00:00.000Z', category: '技术', problem: 'p', root_cause: 'r', solution: 's' };
    const rows = [
      { ...base, id: 'L-RED-1', rule: 'RED-A', mechanism: 'text-only' },          // 拼错
      { ...base, id: 'L-RED-2', rule: 'RED-B', mechanism: 'mechanized' },          // 声明了却没有绑定
    ];
    writeFileSync(join(landing, 'ledger.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    writeFileSync(join(landing, 'rules.json'), JSON.stringify({ schema: 1, project: 'red', protected_paths: [], gates: [], checks: [], inject: [] }, null, 2), 'utf8');
    return { dir, note: 'mechanism 拼错 + 声明 mechanized 无绑定' };
  } catch (err) {
    if (dir !== undefined) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
    return { dir: null, note: `样本构造失败: ${String(err?.message ?? err)}` };
  }
}

const ledgerRel = LEDGERS.find((p) => existsSync(join(root, p)));
if (ledgerRel === undefined) {
  console.log(`ADOPTION_CONTRACT_LEDGER=absent（试过 ${LEDGERS.join(' | ')}）`);
  process.exit(2);
}

/** 对一棵树跑三条判据；返回 {hits, textOnly, rows}（同样的树给同样的结论） */
function inspectTree(treeRoot, rel) {
  const hits = [];
  const rows = [];
  for (const raw of readFileSync(join(treeRoot, rel), 'utf8').split(/\r?\n/)) {
    const t = raw.trim();
    if (t === '') continue;
    try {
      rows.push(JSON.parse(t));
    } catch {
      // 落点级故障不在这里判（ledger-live-verdict 负责），本条只判对象级机制面
    }
  }

  const rulesRel = RULES.find((p) => existsSync(join(treeRoot, p)));
  const boundRules = new Map();
  /** 本落点**真实存在**的拦截面：git 钩子名与 rules.json 的 gates 名（`guardRef` 的存在性判据） */
  const realGuards = new Set();
  if (rulesRel !== undefined) {
    try {
      const parsed = JSON.parse(readFileSync(join(treeRoot, rulesRel), 'utf8'));
      for (const c of Array.isArray(parsed?.checks) ? parsed.checks : []) {
        if (c === null || typeof c !== 'object') continue;
        const cur = boundRules.get(String(c.rule ?? '')) ?? { checks: 0, gates: 0 };
        cur.checks += 1;
        boundRules.set(String(c.rule ?? ''), cur);
      }
      for (const g of Array.isArray(parsed?.gates) ? parsed.gates : []) {
        const cur = boundRules.get(String(g?.rule ?? '')) ?? { checks: 0, gates: 0 };
        cur.gates += 1;
        boundRules.set(String(g?.rule ?? ''), cur);
        if (g !== null && typeof g === 'object' && typeof g.gate === 'string' && g.gate !== '') realGuards.add(`gate:${g.gate}`);
      }
    } catch {
      // 绑定面不可读 ⇒ 下面一律按"没有绑定"判（fail-closed），不静默放过
    }
  }
  // 已安装的 git 钩子（`hooks.json` 清单）；读不到 ⇒ 不把 `hook:*` 当存在（fail-closed）
  const hooksRel = ['hooks.json', '.dsh-ai/rulekeeper/hooks.json'].find((p) => existsSync(join(treeRoot, p)));
  if (hooksRel !== undefined) {
    try {
      const parsed = JSON.parse(readFileSync(join(treeRoot, hooksRel), 'utf8'));
      for (const h of Array.isArray(parsed?.hooks) ? parsed.hooks : []) {
        if (h !== null && typeof h === 'object' && typeof h.name === 'string' && h.name !== '') realGuards.add(`hook:${h.name}`);
      }
    } catch {
      // 同上：读不到就不认
    }
  }

  let textOnly = 0;
  // **读侧 fold**（P2，2026-09-21）：把 `rk mutate` 归档行的字段值应用回目标 id ⇒ 这里读到的是**改后**的
  // mechanism，不会把 `mutate --set mechanism=question` 静默降级成旧值。
  // （此前只"跳过归档行"、不"应用其值" —— 那正是被治理项目禁用该方法的原因。）
  for (const row of foldMutates(rows)) {
    const id = String(row?.id ?? '?');
    const rule = String(row?.rule ?? '?');
    // **事件行不参与**（与 src/adopt.mjs 同口径）：`rk-effect apply` 写的 `生效登记`/`生效退役` 行是
    // **工具自己**记的事件（`mechanism: 'rules.json'` = "写在哪个文件里"，不是人的机制面声明）
    // ⇒ 拿"教训须登记机制面"去判事件行属**对象错位**（同族：ledger-live-verdict 判"事件行的绝对
    // 路径不判红"）。绑定事实由 rules.json 承载，`rk-effect plan` 已单独判。
    if (row?.category === '生效登记' || row?.category === '生效退役') continue;
    // **状态事件行**也不参与：它是"改写/取代"的迁移记录，不是新登记。
    if (row?.category === '状态事件') continue;
    const m = typeof row?.mechanism === 'string' ? row.mechanism.trim() : '';
    // A. 机制面必填且四选一
    if (!MECHANISM_FACES.includes(m)) {
      hits.push(`${id}(${rule}): mechanism=${JSON.stringify(row?.mechanism ?? null)} 不是四选一（${MECHANISM_FACES.join('/')}）⇒ 机制面未登记（"没登记"等于"没生效"）`);
      continue;
    }
    if (m === 'text') { textOnly += 1; continue; }
    // B. 声明了就要有
    const bound = boundRules.get(rule) ?? { checks: 0, gates: 0 };
    if (m === 'mechanized' && bound.checks === 0) {
      hits.push(`${id}(${rule}): mechanism=mechanized 但 rules.json 的 checks 里没有这条绑定 ⇒ 空转的机制面声明`);
    }
    // `guard` 档的判据是**点名 + 存在**（2026-09-21，交接第 2 步）：拦截面不只有 rules.json 的 gates，
    // git 钩子同样是拦截面（预提交公开面门禁就是钩子）。故：缺 guardRef ⇒ 红（自称）；guardRef 指向的
    // 拦截现在不在 ⇒ 红（空转/被卸载）。
    if (m === 'guard') {
      const ref = typeof row?.guardRef === 'string' ? row.guardRef.trim() : '';
      if (ref === '') hits.push(`${id}(${rule}): mechanism=guard 但缺 guardRef（"我靠拦截面"没说靠哪个 ⇒ 自称）`);
      else if (!realGuards.has(ref)) hits.push(`${id}(${rule}): guardRef=${ref} 在当前落点核不到（已装钩子/gates：${[...realGuards].join(' ') || '（无）'}）⇒ 空转的拦截面声明`);
    }
  }
  return { hits, textOnly, rows, rulesRel, realGuards: [...realGuards] };
}

// ── 1) 被检对象：真实账本 ──────────────────────────────────────────────────────
const real = inspectTree(root, ledgerRel);

// ── 2) 反例面：红态样本必须现造且必须判红（规则 42）─────────────────────────────
const red = buildRedSample();
let redNote = 'built';
if (red.dir === null) {
  real.hits.push(`反例面不可用（${red.note}）⇒ 判据无法证明自己会开火`);
} else {
  try {
    const redOut = inspectTree(red.dir, '.dsh-ai/rulekeeper/ledger.jsonl');
    redNote = `built(${red.note}) hits=${redOut.hits.length}`;
    if (redOut.hits.length === 0) real.hits.push(`反例面（${red.note}）**没有被判红** ⇒ 判据没有判别力`);
  } finally {
    try { rmSync(red.dir, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ }
  }
}

// ── 3) 两态样本必须成对入库（旧口径红 / 新口径绿）──────────────────────────────
if (fixturesDeclared) for (const k of ['red', 'green']) {
  if (!existsSync(join(fixtureRoot, 'adoption-two-state-' + k, 'README.md'))) {
    real.hits.push(`test-fixtures/adoption-two-state-${k}: 两态样本缺失（判定语义改动没有可重跑的红样本 = 一次性判据，规则 42）`);
  }
}

console.log(`ADOPTION_CONTRACT_LEDGER=${ledgerRel} ROWS=${real.rows.length} RULES=${real.rulesRel ?? 'absent'} RED_SAMPLE=${redNote}`);
console.log(`ADOPTION_TEXT_ONLY=${real.textOnly}`);   // C. 只写下来了要计数（可见信号，不是拦截）
if (real.hits.length > 0) {
  console.log(`ADOPTION_CONTRACT_VIOLATIONS=${real.hits.length}`);
  for (const h of real.hits.slice(0, 10)) console.log(`  ${h}`);
  process.exit(1);
}
console.log('ADOPTION_CONTRACT_VIOLATIONS=0');
process.exit(0);
