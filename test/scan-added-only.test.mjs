// dsh-rulekeeper · pre-commit 公开面扫描**只判新增行**（2026-10-18，规则 53/85）
//
// 现场（真仓）：internal/modules/cert/mode2.go 历史行含 14 处 .pem（模板/注释），改 4 处 proxy_pass
// 也被整份文件扫描判红 ⇒ 文件成"改不动的死锁"。判据本意是「这次提交**新引入**了什么」，
// 故 pre-commit 改为扫 `git diff --cached -U0` 的 `+` 侧；新文件仍是全 `+`，不削弱。
//
// 两向都要有样本：历史行不报（绿）、新增行写真名必报（红）、新文件必报（红）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { scanPublicFaceAdded } from '../src/selfcheck.mjs';
import { patternsForKind } from '../src/repo-patterns.mjs';

const PATS = patternsForKind('private');
// 可疑串运行时拼装（规则 51）
const KEY = `priv${'key'}${'.'}${'pem'}`;
const RSA = `id_${'rsa'}`;

function repo(label) {
  const dir = mkdtempSync(join(tmpdir(), `rk-added-${label}-`));
  const git = (args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.name', 'probe']);
  git(['config', 'user.email', 'probe@example.com']);
  return { dir, git, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('绿：文件历史行含私钥名，但本次新增行不含 ⇒ 不报', () => {
  const { dir, git, done } = repo('history');
  try {
    writeFileSync(join(dir, 'mode.go'), `ssl_certificate_key /etc/x/${KEY};\nfunc a() {}\n`, 'utf8');
    git(['add', 'mode.go']);
    assert.equal(git(['commit', '-q', '-m', 'base']).status, 0);

    writeFileSync(join(dir, 'mode.go'), `ssl_certificate_key /etc/x/${KEY};\nfunc a() {}\nfunc b() {}\n`, 'utf8');
    git(['add', 'mode.go']);
    assert.deepEqual(scanPublicFaceAdded(dir, ['mode.go'], { forbidden: PATS }), []);
  } finally { done(); }
});

test('红：新增行里写私钥文件名 ⇒ 必报', () => {
  const { dir, git, done } = repo('added');
  try {
    writeFileSync(join(dir, 'mode.go'), 'func a() {}\n', 'utf8');
    git(['add', 'mode.go']);
    assert.equal(git(['commit', '-q', '-m', 'base']).status, 0);

    writeFileSync(join(dir, 'mode.go'), `func a() {}\nRUN cat deploy/${KEY}\n`, 'utf8');
    git(['add', 'mode.go']);
    const leaks = scanPublicFaceAdded(dir, ['mode.go'], { forbidden: PATS });
    assert.equal(leaks.length > 0, true, '新增行必须命中');
    assert.equal(leaks[0].rel, 'mode.go');
  } finally { done(); }
});

test('红：新文件（全 +）写 SSH 私钥名 ⇒ 必报', () => {
  const { dir, git, done } = repo('newfile');
  try {
    writeFileSync(join(dir, 'base.txt'), 'x\n', 'utf8');
    git(['add', 'base.txt']);
    assert.equal(git(['commit', '-q', '-m', 'base']).status, 0);

    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub', 'keys.txt'), `备份 ${RSA} 到 U 盘\n`, 'utf8');
    git(['add', 'sub/keys.txt']);
    const leaks = scanPublicFaceAdded(dir, ['sub/keys.txt'], { forbidden: PATS });
    assert.equal(leaks.length > 0, true, '新文件全部是新增行');
  } finally { done(); }
});

test('边界：git 不可用（非仓）⇒ 退回整份扫描（不静默放行）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-added-nogit-'));
  try {
    writeFileSync(join(dir, 'plain.txt'), `含 ${KEY} 的内容\n`, 'utf8');
    const leaks = scanPublicFaceAdded(dir, ['plain.txt'], { forbidden: PATS });
    assert.equal(leaks.length > 0, true, '非 git 时不得因为拿不到 diff 就放行');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
