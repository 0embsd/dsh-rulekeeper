// dsh-rulekeeper · P26：索引记录的**路径形态**必须分级，不得把"越界形态"报成"文件已删除"
//
// 现场（被治理方 2026-09-24 实测，我独立复现）：
//   `rk-gate write` 报 `GATE_WRITE_PROTECTED_MISSING 受保护文件已被删除 … d:/opt/<项目>/.claude/rules/x.md`，
//   而该文件**在磁盘上**、sha 与索引里那条补留证一致。
// 根因（同一判断链里两处口径不一致）：`isProtected()` 会**归一**后匹配（判 protected=true），
//   而紧接着的 `existsCaseInsensitive(root, rel)` 用的是**未归一的原值** ⇒ 从项目根下找 `<root>/d:/…`
//   必然不存在 ⇒ 记入"已删除"。而那条记录**永远修不好**（索引 append-only，被治理方不得手改）
//   ⇒ 落点**永久卡死**提交，只剩 `--no-verify` 或摘保护面两条违规路。
//
// 本文件钉住修法（判据语义改动，规则 48：与文档/红态样本同源）：
//   ① 越界形态（含绝对路径）⇒ 报 `INDEX_PATH_FORM`（**advisory**，不判红）——被治理方无法合规修复历史行；
//   ② **真删除**（相对形态记录 + 磁盘上确实没有）⇒ 仍必须判红（不许被这次分级顺手放过）；
//   ③ 越界形态**即使文件也不在**，仍只算形态问题、不算"删除"（两件事分开报，规则 41 同族）；
//   ④ 本仓这类"没有违法记录"的落点 ⇒ 结论与改动前一致。
// 反向红：把存在性检查改回用**未归一原值** ⇒ ① 必红。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { PKG_ROOT, tempDir } from './helpers/sandbox.mjs';

const GATE = join(PKG_ROOT, 'bin', 'rk-gate.mjs');
const shaOf = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** 造一个"受保护面 = `.claude/rules/**`"的落点；`rows` 直接写进快照索引（模拟历史遗留） */
function landingWith({ label, rows = [], files = {} }) {
  const dir = tempDir(label);
  const repo = join(dir, 'proj');
  const landing = join(repo, '.dsh-ai', 'rulekeeper');
  mkdirSync(join(landing, 'snapshots'), { recursive: true });
  writeFileSync(join(landing, 'config.json'), `${JSON.stringify({ schema: 1, mode: 'observe' }, null, 2)}\n`, 'utf8');
  writeFileSync(join(landing, 'rules.json'),
    `${JSON.stringify({ schema: 1, project: 't', protected_paths: ['.claude/rules/**'], gates: [], checks: [], inject: [] }, null, 2)}\n`, 'utf8');
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(repo, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text, 'utf8');
  }
  const file = join(landing, 'snapshots', 'index.jsonl');
  writeFileSync(file, '', 'utf8');
  for (const r of rows) appendFileSync(file, `${JSON.stringify(r)}\n`, 'utf8');
  return { repo, landing };
}

const row = ({ ts, path, sha = 'a'.repeat(64) }) => ({
  schema: 1, ts, path, sha256_before: sha, sha256_after: sha, sha256_lf: sha,
  backup: '.dsh-ai/rulekeeper/backups/x.bak', why: '用例', job: 'snap',
});

/** 跑 write 门（只读） */
function runWrite({ repo, landing }) {
  const r = spawnSync(process.execPath, [GATE, 'write', '--project', repo, '--landing', landing, '--phase', 'close'], {
    cwd: PKG_ROOT, encoding: 'utf8',
  });
  return { rc: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
const has = (out, code) => new RegExp(`FINDING ${code}\\b`).test(out);

test('P26①: 索引里那条**绝对形态**记录不得报成"文件已删除"（改报形态问题，且不判红）', () => {
  // 现场复刻：文件在磁盘上，索引里有一条**绝对形态**记录（旧写侧烙下的），另有一条正常相对记录。
  // ⚠ 两条记录的基线都必须**等于当前内容**，否则会因"改过没留证"判红 —— 那与本用例要验的形态问题无关。
  const text = 'v1\n';
  const sha = shaOf(text);
  const { repo, landing } = landingWith({
    label: 'p26-absform',
    files: { ['.claude/rules/fix-requires-plan.md']: text },
    rows: [
      row({ ts: '2026-09-15T13:00:00.000Z', path: '.claude/rules/fix-requires-plan.md', sha }),
      row({ ts: '2026-09-23T13:22:42.056Z', path: 'd:/opt/projx/.claude/rules/fix-requires-plan.md', sha }),
    ],
  });
  const r = runWrite({ repo, landing });
  assert.doesNotMatch(r.out, /FINDING GATE_WRITE_PROTECTED_MISSING/,
    `绝对形态记录**不得**被报成"文件已删除"（这正是卡死被治理方的假红）；out=\n${r.out}`);
  assert.match(r.out, /RK_GATE_WRITE_INDEX_PATH_FORM=1/, '必须如实登记"有 1 条形态越界记录"');
  assert.match(r.out, /INDEX_PATH_FORM out-of-root/, '明细要给出形态分类与原值');
  assert.match(r.out, /RK_GATE_WRITE_RESULT=pass/, 'advisory 不判红 ⇒ 落点恢复可提交');
  assert.equal(r.rc, 0);
});

test('P26②（守卫）: **真删除**（相对形态记录 + 磁盘上确实没有）仍必须判红', () => {
  const { repo, landing } = landingWith({
    label: 'p26-realdelete',
    rows: [row({ ts: '2026-09-23T14:00:00.000Z', path: '.claude/rules/real-gone.md' })],
  });
  const r = runWrite({ repo, landing });
  assert.match(r.out, /FINDING GATE_WRITE_PROTECTED_MISSING/, `真删除必须照旧判红；out=\n${r.out}`);
  assert.match(r.out, /real-gone\.md/);
  assert.equal(r.rc, 1);
});

test('P26③: 越界形态**且文件也不在** ⇒ 只算形态问题，不得算"删除"（两件事分开报）', () => {
  const { repo, landing } = landingWith({
    label: 'p26-formonly',
    rows: [row({ ts: '2026-09-23T13:22:42.056Z', path: 'c:/other/place/.claude/rules/ghost.md' })],
  });
  const r = runWrite({ repo, landing });
  assert.match(r.out, /RK_GATE_WRITE_INDEX_PATH_FORM=1/);
  assert.doesNotMatch(r.out, /FINDING GATE_WRITE_PROTECTED_MISSING/,
    '形态越界 ≠ 文件被删：判定对象不同（规则 41 同族），不得混报');
  assert.match(r.out, /RK_GATE_WRITE_RESULT=pass/);
});

test('P26④: 没有越界记录的落点 ⇒ 结论与改动前一致（计数为 0、不产生新 finding）', () => {
  const text = 'v1\n';
  const { repo, landing } = landingWith({
    label: 'p26-clean',
    files: { ['.claude/rules/ok.md']: text },
    rows: [row({ ts: '2026-09-23T10:00:00.000Z', path: '.claude/rules/ok.md', sha: shaOf(text) })],
  });
  const r = runWrite({ repo, landing });
  assert.match(r.out, /RK_GATE_WRITE_INDEX_PATH_FORM=0/, '干净落点该读数为 0');
  assert.doesNotMatch(r.out, /FINDING GATE_WRITE_INDEX_PATH_FORM/);
  assert.doesNotMatch(r.out, /FINDING GATE_WRITE_PROTECTED_MISSING/);
  assert.match(r.out, /RK_GATE_WRITE_RESULT=pass/);
});
