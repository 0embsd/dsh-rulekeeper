#!/usr/bin/env node
// e2-volume-vs-recall.mjs —— 实验 E2：**量增是否伤召回**（2026-09-19）
//
// 为什么要有这个脚本：
//   P0-3 把"提醒投递"接上了宿主，接着必须回答一个会被"抄现成方案"带偏的问题：
//   **账本条目涨上去以后，命中检索会不会变差？** 观点之争没意义——要有可重跑的数字。
//   本脚本用**生产同一份匹配实现**（`src/prestep.mjs` 的 `tokens/scoreMatch/pickMatch`，
//   即真正注入提醒时跑的那条路径）在**构造语料**上测量：
//     · 命中率（top-1 = 生产 pickMatch 的返回；top-3 = 同一评分的排序前 3 是否含目标）
//     · 两种"量增"形态分开测：**无关干扰**（新词表，不该伤）vs **近义干扰**（大量与目标共享词，才该伤）
//     · 阈值门拦截率：有多少条目/查询因为分数不够被静默丢弃（"量增"最可能的真实伤害形态）
//
// 为什么是构造语料（不是直接扫真实账本）：真实账本只有 385 条、且**还没有可判激活条件**
//   （`RK_EFFECT_ENTRY_ACTIVATION=0/385`）⇒ 拿它测"量增"等于在同一个体积上比大小。
//   构造语料才能把"体积"与"干扰类型"当成**自变量**动起来（规则 42：样本要能构造、可重跑）。
//
// 用法:
//   node scripts/e2-volume-vs-recall.mjs [--volumes 10,50,100,300,1000] [--seed 20260919] [--json]
// 退出码: 0 跑完（含"量增伤召回"的结论）；2 用法错误。

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PRESTEP_MIN_SCORE, pickMatch, scoreMatch, tokens } from '../src/prestep.mjs';

// ── 确定性伪随机（可重跑：同一 seed 逐字相同）──────────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SUBJECTS = ['接口', '契约', '落点', '凭证', '门禁', '快照', '账本', '注入', '投递', '召回',
  '阈值', '指纹', '用例', '夹具', '回滚', '备份', '锁', '分片', '迁移', '脱敏'];
const ACTIONS = ['同步', '校验', '备份', '回读', '重生成', '去重', '归档', '比对', '归一', '登记'];
const OBJECTS = ['文档', '路径', '签名', '时间戳', '行尾', '编码', '字段', '导出面', '载体', '条件'];
const FILLER = ['今天', '顺便', '这里', '那个', '请', '注意', '需要', '可能', '建议', '先'];
// **完全不相交**的噪声词表（用于控制实验：把"体积"与"词表碰撞"分开）
const N_SUBJECTS = ['咖啡', '地铁', '天气', '花园', '钢琴', '雪橇', '邮票', '灯塔', '陶罐', '风筝'];
const N_ACTIONS = ['烘焙', '修剪', '演奏', '擦拭', '晾晒', '折叠', '装订', '浇灌', '缝补', '打磨'];
const N_OBJECTS = ['围巾', '玻璃', '木箱', '日历', '汤勺', '灯罩', '信纸', '皮靴', '竹篮', '蜡笔'];
const N_FILLER = ['周末', '碰巧', '那边', '某天', '大概', '听说', '本来', '随后', '也许', '干脆'];

const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length) % arr.length];

/** 造一条"问题描述"：`<主语><动作><宾语>`（3 个内容词），再加 2 个填充词 */
function makeProblem(rnd, { subject, action, object } = {}) {
  const s = subject ?? pick(rnd, SUBJECTS);
  const a = action ?? pick(rnd, ACTIONS);
  const o = object ?? pick(rnd, OBJECTS);
  const f1 = pick(rnd, FILLER);
  const f2 = pick(rnd, FILLER);
  return { text: `${f1}${s}${a}${o}${f2}处理完了`, words: [s, a, o] };
}

/** 由目标条目派生"查询"（用户真实问法）：内容词全在，语序/填充词不同 ⇒ 应当命中 */
function makeQuery(rnd, words) {
  const [s, a, o] = words;
  return `${pick(rnd, FILLER)}这个${s}的${o}要${a}吗${pick(rnd, FILLER)}`;
}

/**
 * 造语料：
 * @param {'disjoint'|'random'|'near'} family 干扰形态（三个自变量各回答一个问题）
 *   · disjoint：噪声用**完全不相交**的词表 ⇒ 答案"体积本身伤不伤召回？"（对照臂）
 *   · random  ：噪声与目标**共用词表但非故意重叠** ⇒ 答案"同域词表下碰撞概率随体积涨不涨？"
 *   · near    ：噪声**故意与某目标共享 1–2 个内容词** ⇒ 答案"近义/同域干扰伤到什么程度？"
 * @returns {{entries: object[], queries: {query: string, wantRule: string}[]}}
 */
function buildCorpus({ targets = 20, volume = 100, family = 'disjoint', seed = 20260919 }) {
  const rnd = mulberry32(seed);
  const entries = [];
  const queries = [];
  const targetWords = [];
  // 目标条目：每条一个唯一问题
  for (let i = 0; i < targets; i += 1) {
    const p = makeProblem(rnd);
    const rule = `E2-TARGET-${String(i).padStart(2, '0')}`;
    targetWords.push({ rule, words: p.words });
    entries.push({ id: `t${i}`, rule, problem: p.text, words: p.words });
  }
  // 干扰条目：补到 volume
  for (let i = entries.length; i < volume; i += 1) {
    const rule = `E2-NOISE-${String(i).padStart(4, '0')}`;
    let words;
    if (family === 'near') {
      // 近义干扰：与**某些**目标共享 1–2 个内容词（同域不同事）
      const t = targetWords[Math.floor(rnd() * targetWords.length)];
      const share = rnd() < 0.5 ? 1 : 2;
      const w = [...t.words];
      for (let k = 0; k < share; k += 1) w[k] = pick(rnd, [SUBJECTS, ACTIONS, OBJECTS][k]);
      words = w;
    } else if (family === 'disjoint') {
      words = [pick(rnd, N_SUBJECTS), pick(rnd, N_ACTIONS), pick(rnd, N_OBJECTS)];
      const text = `${pick(rnd, N_FILLER)}${words[0]}${words[1]}${words[2]}${pick(rnd, N_FILLER)}处理完了`;
      entries.push({ id: `n${i}`, rule, problem: text, words });
      continue;
    } else {
      words = [pick(rnd, SUBJECTS), pick(rnd, ACTIONS), pick(rnd, OBJECTS)];
    }
    entries.push({ id: `n${i}`, rule, problem: makeProblem(rnd, { subject: words[0], action: words[1], object: words[2] }).text, words });
  }
  for (const { rule, words } of targetWords) queries.push({ query: makeQuery(rnd, words), wantRule: rule });
  return { entries, queries };
}

/** 把语料写成落点形态（`pickMatch` 读的是真实落点） */
function writeLanding(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'rk-e2-'));
  const landing = join(dir, 'landing');
  mkdirSync(landing, { recursive: true });
  writeFileSync(join(landing, 'config.json'), `${JSON.stringify({ schema: 1, mode: 'observe' }, null, 2)}\n`, 'utf8');
  writeFileSync(join(landing, 'rules.json'), `${JSON.stringify({ schema: 1, project: 'e2', protected_paths: [], gates: [], checks: [], inject: [] }, null, 2)}\n`, 'utf8');
  const ts = '2026-09-19T00:00:00.000Z';
  const rows = entries.map((e) => JSON.stringify({
    schema: 1, id: e.id, ts, rule: e.rule, category: '纪律', problem: e.problem, root_cause: 'r',
    solution: e.words.join('→'), evidence: [], mechanism: 'text', recurrence: 1,
    first_seen: ts, last_seen: ts, status: 'active',
  }));
  writeFileSync(join(landing, 'ledger.jsonl'), `${rows.join('\n')}\n`, 'utf8');
  return landing;
}

/**
 * **与生产逐字对齐**的评分体：`pickMatch` 打分的文本是
 * `` `${row.problem} ${row.solution} ${row.activation}` ``（`src/prestep.mjs:90`）。
 * 语料里 `solution` 写成 `words.join('→')`（见 `writeLanding`），故离线重排必须用同一形态，
 * 否则"离线预演"与"生产行为"不是同一件事（本轮实测过：用错的评分体时 margin=0 的命中率
 * 45% vs 25%，差 20 个百分点 —— 对齐检查已写成断言，见文末 `ALIGN`）。
 */
const bodyOfEntry = (e) => `${e.problem} ${e.words.join('→')} `;

/** 生产同一打分 + 生产同一并列语义（**先出现者胜**：`score > best.score` 才替换） */
function scoreAll(entries, query, minScore = PRESTEP_MIN_SCORE) {
  const q = tokens(query);
  const scored = entries.map((e) => ({ rule: e.rule, score: scoreMatch(q, bodyOfEntry(e)) }));
  let best = null;
  for (const s of scored) {
    if (s.score < minScore) continue;
    if (best === null || s.score > best.score) best = s;
  }
  let runnerUp = null;
  for (const s of scored) {
    if (best !== null && s === best) continue;
    if (runnerUp === null || s.score > runnerUp.score) runnerUp = s;
  }
  return { best, lead: best === null ? 0 : best.score - (runnerUp === null ? 0 : runnerUp.score) };
}

/** 同一评分的 top-k（生产 `pickMatch` 只返回 top-1；top-3 用于看判别力是否"差一点"） */
function rank(entries, query, k = 3) {
  const q = tokens(query);
  return entries
    .map((e) => ({ rule: e.rule, score: scoreMatch(q, bodyOfEntry(e)) }))
    .sort((a, b) => b.score - a.score || (a.rule < b.rule ? -1 : 1))
    .slice(0, k);
}

/**
 * 候选护栏的**离线预演**：要求 top1 领先"其它最佳"至少 `margin` 分才敢说话。
 * 为什么要试它：主实验显示失败形态是**误指**（错的条目抢到 top-1）而不是**沉默**（阈值门 gated=0%）
 *   ⇒ 提高 minScore 只会把误指变成沉默，挡不住词表碰撞；真正可能有效的是**间距门**（margin）。
 * 注意：这是**离线预演**（同一份评分重排），不是已落地实现——落地须另开改动并走用例。
 */
function sweepMargin({ volume, family, targets, seed, margins = [0, 1, 2, 3, 4] }) {
  const { entries, queries } = buildCorpus({ targets, volume, family, seed });
  const rows = [];
  for (const margin of margins) {
    let hit = 0;
    let wrong = 0;
    let silent = 0;
    for (const { query, wantRule } of queries) {
      const { best, lead } = scoreAll(entries, query);
      if (best === null || lead < margin) silent += 1;
      else if (best.rule === wantRule) hit += 1;
      else wrong += 1;
    }
    const n = queries.length;
    rows.push({ margin, hitRate: hit / n, misdirectedRate: wrong / n, silentRate: silent / n });
  }
  return { volume, family, rows };
}

function measure({ volume, family, targets, seed }) {
  const { entries, queries } = buildCorpus({ targets, volume, family, seed });
  const landing = writeLanding(entries);
  let top1 = 0;
  let top3 = 0;
  let gated = 0;          // 生产通道因分数不足而"没话说"
  let misdirected = 0;    // 命中了**别的**条目（真正的伤害形态：提醒错了东西）
  for (const { query, wantRule } of queries) {
    const hit = pickMatch({ landingDir: landing, query });
    if (hit === null) gated += 1;
    else if (hit.rule === wantRule) top1 += 1;
    else misdirected += 1;
    const r = rank(entries, query, 3).map((x) => x.rule);
    if (r.includes(wantRule)) top3 += 1;
  }
  const n = queries.length;
  return {
    volume: entries.length, family, queries: n,
    top1Rate: top1 / n, top3Rate: top3 / n, gatedRate: gated / n, misdirectedRate: misdirected / n,
  };
}

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const volumes = flag('--volumes', '10,50,100,300,1000').split(',').map((v) => Number(v.trim()));
const seed = Number(flag('--seed', '20260919'));
const asJson = argv.includes('--json');
if (volumes.some((v) => !Number.isInteger(v) || v < 1)) {
  console.error('e2: --volumes 需要正整数列表，如 10,50,100');
  process.exit(2);
}

const results = [];
for (const volume of volumes) {
  for (const family of ['disjoint', 'random', 'near']) results.push(measure({ volume, family, targets: 20, seed }));
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
if (asJson) {
  console.log(JSON.stringify({ seed, targets: 20, minScore: PRESTEP_MIN_SCORE, results }, null, 2));
} else {
  console.log(`E2 量增 vs 召回（生产同一实现：prestep.tokens/scoreMatch/pickMatch，minScore=${PRESTEP_MIN_SCORE}，seed=${seed}）`);
  console.log('volume  family      top1    top3    gated   misdirected');
  for (const r of results) {
    console.log(`${String(r.volume).padEnd(7)} ${r.family.padEnd(11)} ${pct(r.top1Rate).padEnd(7)} ${pct(r.top3Rate).padEnd(7)} ${pct(r.gatedRate).padEnd(7)} ${pct(r.misdirectedRate)}`);
  }
  const at = (v, f) => results.find((r) => r.volume === v && r.family === f);
  const first = results[0];
  const maxV = results[results.length - 1].volume;
  const dis = at(maxV, 'disjoint');
  const rndF = at(maxV, 'random');
  const near = at(maxV, 'near');
  console.log('');
  console.log(`① 体积本身（disjoint 对照臂，${first.volume} → ${maxV} 条）：top1 ${pct(first.top1Rate)} → ${pct(dis.top1Rate)}，top3 ${pct(first.top3Rate)} → ${pct(dis.top3Rate)}，misdirected ${pct(first.misdirectedRate)} → ${pct(dis.misdirectedRate)}`);
  console.log(`② 同域词表（random 臂，${maxV} 条）：top1 ${pct(rndF.top1Rate)}，top3 ${pct(rndF.top3Rate)}，misdirected ${pct(rndF.misdirectedRate)}`);
  console.log(`③ 近义干扰（near 臂，${maxV} 条）：top1 ${pct(near.top1Rate)}，top3 ${pct(near.top3Rate)}，misdirected ${pct(near.misdirectedRate)}`);
  console.log(`④ 阈值门 gated=${pct(near.gatedRate)}（被静默丢弃的比例 —— "没话说"而不是"说错话"）`);
  // ⑤ 候选护栏离线预演（间距门）
  console.log('');
  console.log(`⑤ 间距门预演（要求 top1 领先 top2 ≥ margin 分才说话；近义干扰 ${maxV} 条）`);
  const sweep = sweepMargin({ volume: maxV, family: 'near', targets: 20, seed });
  console.log('  margin  说对    说错    沉默');
  for (const r of sweep.rows) {
    console.log(`  ${String(r.margin).padEnd(6)} ${pct(r.hitRate).padEnd(7)} ${pct(r.misdirectedRate).padEnd(7)} ${pct(r.silentRate)}`);
  }
  const sweepDis = sweepMargin({ volume: maxV, family: 'disjoint', targets: 20, seed });
  console.log('  对照（disjoint 臂，margin=0 → 4）：');
  console.log('  margin  说对    说错    沉默');
  for (const r of sweepDis.rows) {
    console.log(`  ${String(r.margin).padEnd(6)} ${pct(r.hitRate).padEnd(7)} ${pct(r.misdirectedRate).padEnd(7)} ${pct(r.silentRate)}`);
  }
  // 对齐检查：margin=0 的离线预演必须**等于**生产 top1 —— 否则"预演"不是"被测对象"的一面镜子
  for (const [arm, prod, sweep] of [['near', near, sweepMargin({ volume: maxV, family: 'near', targets: 20, seed })],
    ['disjoint', dis, sweepDis]]) {
    const margin0 = sweep.rows.find((r) => r.margin === 0);
    const ok = Math.abs(margin0.hitRate - prod.top1Rate) < 1e-9;
    console.log(`ALIGN ${arm}: margin=0 说对 ${pct(margin0.hitRate)} vs 生产 top1 ${pct(prod.top1Rate)} => ${ok ? '一致' : '不一致（预演不可信！）'}`);
    if (!ok) process.exitCode = 3;
  }
}
