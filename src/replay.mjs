// dsh-rulekeeper · LF-270 历史缺陷回放（LF-2A0 已就位后）
//
// 做法（对齐清单 LF-270 行）：把三处历史缺陷**逐条回放**，结论只允许两种：
//   · `hit`        —— 现在有机械判据能命中它（给出判据与实测）
//   · `uncheckable`—— 明确判"不可机检"，**且**必须附通过 LF-2A0 的实证声明（三件套 + falsifier + 有效期）
// 复核红态（清单原文）：判 uncheckable 但不含正对照 → exit≠0。
//
// 三处的来历（都是**真发生过的**，不是构造）：
//   L412  `日志工具 close` 把用户可读的 Session/Phase 直接当文件名片段 -> `-Phase "批次2/3/4 + 真机"`
//         造出嵌套伪目录 `会话里程碑-批次2/3/`，里程碑被埋在里面。
//         → 同族风险在 dsh-rulekeeper 的位置：**提案 id 拼进文件名**（`proposals/<id>.json`）。
//   L451  PowerShell `return ,@($d.entries)` 逗号包装 -> 输出流塌陷成单个数组对象：
//         450 条教训拼成一行，全量输出 380,087 字符 / 43 行 / **最长行 68,188**，"①轨"假报 1 条。
//         → 命中的判据：**LF-260 形态守卫**（行数骤降 + 单行暴涨正是它的判据）。
//   L454  同 idiom 第三次复发（`进化工具.ps1`）：计数正确、**标签全空**的半失效。
//         修法要求"类级清查 + 必须用 AST"。而 dsh-rulekeeper 是零依赖 Node CLI，
//         跨语言对 23 个 pwsh 工具做 AST 清查**超出本工具边界** -> 判 `uncheckable`（须附实证）。
//
// 归属：core 模块。零依赖：只用 node:*。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkShapeGuard, PKG_ROOT } from './checks.mjs';
import { isSafeId, makeProposalId, writeProposal } from './proposal.mjs';
import { validateUncheckableDeclaration } from './uncheckable.mjs';

/** 回放件 id 是否安全（L412 的判据本体；导出以便测试与别的调用方复用） */
export { isSafeId };

/** L451 的形态判据：塌陷样本 vs "修好后"的量级（数字取自 L451 实证：修后 208 条 / 最长 776） */
export const L451_EXPECT = Object.freeze({ lines: 208, maxLineLength: 776 });

/** 回放：L412 —— 文件名/标识符注入（`/`、`..` 不得穿透到落点外） */
export function replayL412(ctx = {}) {
  const landingDir = ctx.landingDir;
  const findings = [];
  const probes = [];
  const base = { schema: 1, rule: 'PATH-SANITIZE', source: 'auto', createdAt: '2026-09-14T00:00:00.000Z',
    redCriteria: 'rc', counterExample: 'ce', falsePositiveSurface: 'fp', activationCheck: 'ac', status: 'proposed' };
  const unsafeIds = ['../../evil', 'a/b', '..\\evil', 'C:evil', '..', '.'];
  for (const id of unsafeIds) {
    const r = writeProposal(landingDir, { ...base, id });
    probes.push({ id, ok: r.ok, reason: r.reason });
    if (r.ok) findings.push({ code: 'REPLAY_L412_UNSAFE_ID_ACCEPTED', message: `不安全 id 被写入: ${JSON.stringify(id)}` });
  }
  const safeId = makeProposalId(new Date('2026-09-14T00:00:00.000Z'));
  const safeWrite = writeProposal(landingDir, { ...base, id: safeId });
  probes.push({ id: safeId, ok: safeWrite.ok, reason: safeWrite.reason });
  if (!safeWrite.ok) findings.push({ code: 'REPLAY_L412_SAFE_ID_REJECTED', message: `安全 id 被误拒: ${safeId}（判据过敏）` });
  // 正对照：不安全 id 若被放行，路径确实会跑到落点之外
  const outside = join(landingDir, '..', '..', 'evil.json');
  const control = { wouldEscapeTo: outside.replace(/\\/g, '/'), insideProposals: join(landingDir, 'proposals', `${safeId}.json`).replace(/\\/g, '/') };
  return {
    id: 'L412', rule: 'PATH-SANITIZE', mode: 'check',
    verdict: findings.length === 0 ? 'hit' : 'miss',
    detail: { probes, control },
    findings,
  };
}

/** 回放：L451 —— 输出塌陷（行数骤降 + 单行暴涨）必须被 LF-260 形态守卫命中 */
export function replayL451(ctx = {}) {
  const sample = ctx.collapsedSample ?? join(PKG_ROOT, 'test', 'fixtures', 'replay', 'l451-collapsed.txt');
  if (!existsSync(sample)) {
    return { id: 'L451', rule: 'PS-OUTPUT-STREAM', mode: 'check', verdict: 'miss',
      detail: { sample }, findings: [{ code: 'REPLAY_L451_FIXTURE_MISSING', message: `塌陷样本缺失: ${sample}` }] };
  }
  const report = checkShapeGuard({
    file: sample,
    projectRoot: ctx.projectRoot ?? PKG_ROOT,
    expectLines: L451_EXPECT.lines,
    expectMaxLineLength: L451_EXPECT.maxLineLength,
    frozenSha256: ctx.frozenSha256 ?? null,
  });
  const codes = report.findings.map((f) => f.code);
  const hit = report.verdict === 'violation'
    && codes.includes('SHAPE_LINES_MISMATCH')
    && codes.includes('SHAPE_MAXLINE_MISMATCH');
  return {
    id: 'L451', rule: 'PS-OUTPUT-STREAM', mode: 'check',
    verdict: hit ? 'hit' : 'miss',
    detail: { sample: report.detail.path, lines: report.detail.lines, maxLineLength: report.detail.maxLineLength,
      expect: { lines: L451_EXPECT.lines, maxLineLength: L451_EXPECT.maxLineLength }, findings: codes },
    findings: hit ? [] : [{ code: 'REPLAY_L451_NOT_CAUGHT', message: `形态守卫未命中塌陷样本（verdict=${report.verdict}, codes=${codes.join(',')}）` }],
  };
}

/** 回放：L454 —— 判 uncheckable，**必须**附通过 LF-2A0 的实证声明（缺件/缺正对照即红） */
export function replayL454(ctx = {}) {
  const declaration = ctx.declaration ?? join(PKG_ROOT, 'test', 'fixtures', 'replay', 'l454-uncheckable.json');
  if (!existsSync(declaration)) {
    return { id: 'L454', rule: 'PS-OUTPUT-STREAM', mode: 'uncheckable', verdict: 'miss',
      detail: { declaration }, findings: [{ code: 'REPLAY_L454_DECLARATION_MISSING', message: `实证声明缺失: ${declaration}` }] };
  }
  const report = validateUncheckableDeclaration(
    JSON.parse(ctx.declarationText ?? readFileSync(declaration, 'utf8')),
    { file: declaration, projectRoot: ctx.projectRoot ?? PKG_ROOT, now: ctx.now ?? new Date(), maxDays: ctx.maxDays },
  );
  return {
    id: 'L454', rule: 'PS-OUTPUT-STREAM', mode: 'uncheckable',
    verdict: report.ok ? 'uncheckable' : 'miss',
    detail: { declaration: report.detail.path, missing: report.detail.fields.missing, window: report.detail.window },
    findings: report.ok ? [] : report.findings.map((f) => ({ code: f.code, message: f.message })),
  };
}

/**
 * 跑全部回放。
 * @returns {{ok: boolean, items: object[], findings: object[]}}
 */
export function runReplayAll(ctx = {}) {
  const items = [replayL412(ctx), replayL451(ctx), replayL454(ctx)];
  const findings = [];
  for (const item of items) {
    for (const f of item.findings) findings.push({ code: f.code, message: `[${item.id}] ${f.message}` });
    if (item.verdict === 'miss') findings.push({ code: 'REPLAY_MISS', message: `[${item.id}] 既未被机械判据命中，也没有合格的 uncheckable 实证` });
  }
  return { ok: items.every((i) => i.verdict !== 'miss'), items, findings };
}
