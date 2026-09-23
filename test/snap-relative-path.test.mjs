// dsh-rulekeeper · `rk-snap take` 落进索引的路径必须是**项目相对**（与闸门/保护面同一口径）
//
// 现场（2026-09-23 真机验收抓到）：`runSnap` 的 `projectRoot` 默认取 **cwd**。在"落点在别处、cwd 不是
// 项目根"的调用形态下（消费方仓 / 夹具仓，都是真实用法），`normalizeTarget` 换算不出来 ⇒ 索引里存
// **绝对路径**；而写闸门与保护面 glob 都按**项目相对**比对 ⇒ 受保护文件被判"从未留证"、提交被拒。
// 这类"同一语义两套路径口径"是本仓反复吃过的病害（同族：S1 同名字段只允许一个解析处）。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { PKG_ROOT, tempDir } from './helpers/sandbox.mjs';

const SNAP = join(PKG_ROOT, 'bin', 'rk-snap.mjs');
const posix = (s) => String(s).split('\\').join('/');

test('rk-snap take：cwd 不是项目根时，索引里也必须落**项目相对**路径', () => {
  const root = tempDir('snap-relpath');
  const repo = join(root, 'proj');
  const landing = join(repo, '.dsh-ai', 'rulekeeper');
  mkdirSync(landing, { recursive: true });
  writeFileSync(join(landing, 'config.json'), `${JSON.stringify({ schema: 1, mode: 'observe' }, null, 2)}\n`, 'utf8');
  writeFileSync(join(repo, 'README.md'), 'v1\n', 'utf8');

  // 关键：**在别的目录**调用（cwd = 包的安装位置），只给 --landing 与绝对 --path
  const r = spawnSync(process.execPath, [SNAP, 'take', '--path', join(repo, 'README.md'), '--landing', landing, '--why', '用例'], {
    cwd: PKG_ROOT, encoding: 'utf8',
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  // 诊断读数：把"它解析到的项目根 / 目标文件"一并核对 —— CI 上只报"结果是绝对路径"时无法定位根因
  const outLine = (k) => (r.stdout.split('\n').find((l) => l.startsWith(`${k}=`)) ?? '').slice(k.length + 1);
  assert.equal(posix(outLine('RK_SNAP_PROJECT')).toLowerCase(), posix(repo).toLowerCase(), `解析到的项目根必须是 ${repo}（实得 ${outLine('RK_SNAP_PROJECT')}）`);
  assert.equal(posix(outLine('RK_SNAP_TARGET')).toLowerCase(), posix(join(repo, 'README.md')).toLowerCase(), `目标文件必须是仓内那个（实得 ${outLine('RK_SNAP_TARGET')}）`);
  const rows = readFileSync(join(landing, 'snapshots', 'index.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  const stored = posix(rows[0].path);
  assert.equal(stored, 'readme.md', `索引里必须落项目相对路径（实得 ${stored}；本仓口径经 pathKey 归一为小写，既有索引行同形）`);
  assert.equal(/^[A-Za-z]:\//.test(stored), false, '索引里不得出现盘符绝对路径');
  assert.equal(rows[0].backup.includes('/backups/'), true, '备份路径仍要登记（相对或绝对都要在落点下）');
  assert.doesNotMatch(posix(rows[0].backup), /^[A-Za-z]:\//, `备份也必须相对化：${rows[0].backup}`);

  // 显式 --project 仍然优先（不许把"推断"变成"抢参数"）
  const r2 = spawnSync(process.execPath, [SNAP, 'take', '--path', join(repo, 'README.md'), '--landing', landing, '--project', repo, '--why', '用例2'], {
    cwd: PKG_ROOT, encoding: 'utf8',
  });
  assert.equal(r2.status, 0, `${r2.stdout}${r2.stderr}`);
  const rows2 = readFileSync(join(landing, 'snapshots', 'index.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(posix(rows2[1].path), 'readme.md', '本仓口径：索引路径经 pathKey 归一为小写（既有索引行同形）');
});
