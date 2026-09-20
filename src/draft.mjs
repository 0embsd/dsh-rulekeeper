// draft.mjs —— **activation 机器起草器**（2026-09-19，objective ②）
//
// 目标：把"给既有教训补'什么时候该想起它'"从**从零写**降到**审改草稿**。
//
// 与 E1 的关系（必须一起读，别把这条当成"自动化捕获"）：
//   E1 用 10 条真实教训测过"机器起草四要件"——齐备率 **0/10**。根因不是措辞差，而是
//   **账本里没有可观测锚点**（`evidence` 是历史凭证路径，不是可重跑的违规样本）。
//   所以本模块不假装能造出四要件，只做一件更小、可判的事：**从条目已有的锚点派生一句"何时适用"**。
//
// **判别力门（本模块的核心判据，第一版实测后补）**：第一版只查"含不含命令/扩展名锚点"，
//   于是产出了 `当命令/现象里出现 git 时` 这类**恒真条件**（git 在账本里到处都是）——
//   覆盖率会涨，质量是零。这正是"灌水式自动化"。故现在要求锚点**有判别力**：
//     · 该锚点在**参与起草的行**里出现的比例 ≤ `maxAnchorShare`（默认 0.15）
//     · 泛用工具名（git/node/npm/go/...）**直接不作为候选**（它们不区分"何时适用"）
//     · 路径锚点必须是"像样的路径"（有已知扩展名或 ≥2 段目录），`Q17/A.1` 这种带数字后缀的不算
//   过不了门的行 ⇒ 进 `noAnchor` 清单（**如实说"缺原料"**，不编一句凑数）。
//
// 归属：core 模块。零依赖：只用 node:*。

import { ANNOTATION_MAX_CHARS, validateActivation } from './annotations.mjs';

/** 默认判别力门：锚点在参与起草的行里出现比例超过它 ⇒ 不算判别性锚点 */
export const DEFAULT_MAX_ANCHOR_SHARE = 0.15;

/** 泛用工具名：不作为候选（出现率必然高，且不区分"何时适用"） */
const GENERIC_COMMANDS = Object.freeze([
  'git', 'node', 'npm', 'pnpm', 'python', 'pwsh', 'powershell', 'go', 'cargo', 'docker', 'make',
]);
/** 项目自有 CLI 工具名（只认 `rk-*`：`dsh-*` 会命到 `.dsh-ai/` 这种**路径片段**，第一版实测踩过） */
const RE_SPECIFIC_CMD = /(?<![\w./-])(rk-[a-z][a-z-]*)\b/;
/** 具名错误串：只要真正的错误码（`E[A-Z]{3,}` 会命中 `EXIT`/`ERROR` 这种普通词，第一版实测踩过） */
const RE_ERR = /\b(ERR-[A-Z0-9][A-Z0-9-]*|ENOENT|EACCES|EPERM|EEXIST|ECONNREFUSED|ETIMEDOUT)\b/;
/** `文件:行号` 锚点 —— E1 实验点名的"真原料"（`root_cause` 里的位置引用），比扩展名判别力强得多 */
const RE_FILELINE = /(?<![\w./-])([\w.-]+(?:\/[\w.-]+)*\.[A-Za-z]{1,8}):(\d+)(?![\d])/;
const RE_EXIT = /\bexit(?:code)?\s*[=:]\s*(\d+)/i;
const RE_EXT = /\b([\w-]+\.(mjs|cjs|js|ts|md|json|jsonl|ps1|go|py|sh|yml|yaml|toml|txt))\b/i;

/** 已知扩展名（用于判断 evidence 是否"像样的文件路径"） */
const KNOWN_EXT = /\.(?:mjs|cjs|js|ts|md|json|jsonl|ps1|psm1|go|py|sh|bash|yml|yaml|toml|txt|cfg|ini|log|bak|png|jpg|pdf|zip|tgz|exe)$/i;

/**
 * evidence 项是否"像样的路径锚点"。
 * 反例（第一版误判）：`Q17/A.1`、`评分.2` —— 版本号后缀被当成扩展名 ⇒ 产出 `*.2` 这种可笑条件。
 */
export function looksLikePathAnchor(s) {
  const t = String(s ?? '').trim().replace(/\\/g, '/');
  if (t === '' || t.length < 4) return false;
  if (/\s/.test(t)) return false;                       // 带空格的多半是句子，不是路径
  const segs = t.split('/').filter((x) => x !== '');
  if (segs.length < 2) return false;                    // 至少一段目录 + 一段文件名
  const last = segs[segs.length - 1];
  if (KNOWN_EXT.test(last)) return /\.[A-Za-z]/.test(last);   // 扩展名必须以字母开头（排除 .1/.2）
  return false;                                          // 无已知扩展名 ⇒ 不当路径锚点（宁缺勿滥）
}

/**
 * 把路径归一成"可判形态"：**去掉机器相关前缀**（盘符/家目录等），文件名转通配，保留目录与扩展名。
 * 为什么必须去前缀：条件是给人/机器判断"何时适用"用的，`d:/opt/<私有目录>/…` 既不可移植，
 *   也把本机目录结构写进了产品数据（第一版实测产出过这种条件）。
 */
export function globOfPath(p) {
  const s = String(p ?? '').trim().replace(/\\/g, '/');
  let segs = s.split('/').filter((x) => x !== '');
  const absolute = /^[A-Za-z]:$/.test(segs[0] ?? '') || s.startsWith('//') || s.startsWith('/');
  if (absolute && segs.length > 2) {
    // 绝对路径：只保留最后两段（目录 + 文件），前面用 … 代替
    segs = ['…', ...segs.slice(-2)];
  } else if (/^[A-Za-z]:$/.test(segs[0] ?? '')) {
    segs = segs.slice(1);
  }
  if (segs.length === 0) return '';
  const last = segs[segs.length - 1];
  if (KNOWN_EXT.test(last)) segs[segs.length - 1] = `*${last.slice(last.lastIndexOf('.'))}`;
  return segs.join('/');
}

/**
 * 一条行的**候选锚点**（有序，强的在前）。判别力由调用方统一裁定。
 * @returns {{activation:string, confidence:'high'|'medium', anchor:string, token:string}[]}
 */
export function anchorCandidates(row) {
  const out = [];
  const evidence = Array.isArray(row?.evidence) ? row.evidence.filter((e) => typeof e === 'string' && e.trim() !== '') : [];
  // ① 凭证路径（最强：它是这条教训当初留下的可核对痕迹）
  for (const e of evidence) {
    if (!looksLikePathAnchor(e)) continue;
    const g = globOfPath(e);
    if (g === '') continue;
    out.push({ activation: `当改动或核对落在 ${g} 覆盖的文件上时（凭证形态）`, confidence: 'high', anchor: g, token: g });
  }
  const text = `${String(row?.problem ?? '')} ${String(row?.solution ?? '')} ${String(row?.root_cause ?? '')}`;
  // ② `文件:行号`（E1 点名的"真原料"：位置引用比扩展名判别力强，且天然可核对）
  const fl = RE_FILELINE.exec(text);
  if (fl !== null && KNOWN_EXT.test(fl[1])) {
    const file = globOfPath(fl[1]);
    out.push({ activation: `当核对 ${file} 的行为或改动该文件时（源码位置锚点，原文 ${fl[1]}:${fl[2]}）`, confidence: 'high', anchor: `${fl[1]}:${fl[2]}`, token: file });
  }
  // ③ 项目自有工具名（rk-* / dsh-*）：比泛用工具强，但仍需过判别力门
  const cmd = RE_SPECIFIC_CMD.exec(text);
  if (cmd !== null) out.push({ activation: `当命令里出现 ${cmd[1]} 时（项目自有工具）`, confidence: 'medium', anchor: cmd[1], token: cmd[1] });
  // ④ 具名错误串（ERR-* / ENOENT …）
  const err = RE_ERR.exec(text);
  if (err !== null) out.push({ activation: `当出现错误 ${err[1]} 时（具名错误串）`, confidence: 'medium', anchor: err[1], token: err[1] });
  // ⑤ 退出码：**只认非 0**（`exit=0` 恒真，不是条件 —— 第一版实测产出过"当 exit 码为 0 时"这种废话）
  const exit = RE_EXIT.exec(text);
  if (exit !== null && exit[1] !== '0') out.push({ activation: `当 exit 码为 ${exit[1]} 时（可观测退出码）`, confidence: 'medium', anchor: `exit=${exit[1]}`, token: `exit=${exit[1]}` });
  // ⑥ **不再有"按文件扩展名"这一类**（第一版实测淘汰）：`当改动 .json 文件时` 虽可判，但
  //   它不区分"何时适用"（几乎任何一次改动都命中）⇒ 属灌水。E1 的结论一致：真原料是
  //   **位置引用 / 可复跑反例 / 误报面**，不是文件类型。
  return out;
}

/** 泛用工具名不得作为锚点（即使被 ⑤ 之类漏进来，这里再兜一次） */
export function isGenericAnchor(token) {
  const t = String(token ?? '').toLowerCase().replace(/^\./, '');
  return GENERIC_COMMANDS.includes(t);
}

/**
 * 批量起草（带**判别力门**）。
 * @param {object[]} rows
 * @param {{limit?: number, validate?: boolean, maxAnchorShare?: number}} [opts]
 * @returns {{drafts: object[], noAnchor: object[], lowQuality: object[], stats: object}}
 */
export function draftActivations(rows = [], {
  limit = Infinity,
  validate = true,
  maxAnchorShare = DEFAULT_MAX_ANCHOR_SHARE,
} = {}) {
  const usable = rows.filter((r) => r !== null && typeof r === 'object'
    && !(typeof r.activation === 'string' && r.activation.trim() !== ''));
  const total = usable.length;
  // 锚点文档频率（分母 = 参与起草的行数）⇒ 判别力门
  const df = new Map();
  const candidatesById = new Map();
  for (const row of usable) {
    const cands = anchorCandidates(row);
    candidatesById.set(row, cands);
    const seen = new Set(cands.map((c) => c.token));
    for (const token of seen) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const shareOf = (token) => (total === 0 ? 1 : (df.get(token) ?? 0) / total);
  // 判别力门用**绝对文档频率**而不是纯比例：小语料上比例不稳定（2 行的落点里任何锚点都占 50%，
  // 会把唯一的好锚点也毙掉——端到端用例第一版实测就红在这）。规则：出现次数 ≤ max(2, share×总量)。
  //   小语料（≤ 13 行）：只要不重复出现就放行；大语料（388 行）：出现 >58 次的锚点视为不判别。
  const maxDf = Math.max(2, Math.ceil(maxAnchorShare * total));

  const drafts = [];
  const noAnchor = [];
  const lowQuality = [];
  for (const row of usable) {
    const cands = candidatesById.get(row) ?? [];
    const viable = cands.filter((c) => !isGenericAnchor(c.token) && (df.get(c.token) ?? 0) <= maxDf);
    if (viable.length === 0) {
      noAnchor.push({
        id: typeof row.id === 'string' ? row.id : '',
        confidence: 'none',
        activation: '',
        anchors: cands.map((c) => c.anchor),
        reason: cands.length === 0
          ? '无可观测锚点（凭证路径不合形态、也没有具名命令/错误串/退出码）⇒ 需人工补原料，机器不编'
          : `候选锚点都缺判别力（出现 ${cands.map((c) => df.get(c.token) ?? 0).join('/')} 次 > 门限 ${maxDf}，或为泛用工具）：${cands.map((c) => c.anchor).join('、')}`,
      });
      continue;
    }
    const pick = viable[0];
    const v = validateActivation(pick.activation);
    if (validate && v.ok !== true) {
      lowQuality.push({ ...pick, id: typeof row.id === 'string' ? row.id : '', reasons: v.reasons });
      continue;
    }
    if (drafts.length >= limit) continue;
    drafts.push({
      id: typeof row.id === 'string' ? row.id : '',
      activation: pick.activation,
      confidence: pick.confidence,
      anchors: [pick.anchor],
      anchorShare: Number(shareOf(pick.token).toFixed(4)),
      chars: pick.activation.length <= ANNOTATION_MAX_CHARS,
    });
  }
  return {
    drafts,
    noAnchor,
    lowQuality,
    stats: {
      rows: total,
      drafted: drafts.length,
      noAnchor: noAnchor.length,
      lowQuality: lowQuality.length,
      highConfidence: drafts.filter((d) => d.confidence === 'high').length,
      mediumConfidence: drafts.filter((d) => d.confidence === 'medium').length,
      maxAnchorShare,
    },
  };
}
