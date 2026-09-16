// dsh-rulekeeper · **S8 公开面去内部关联**（含 2026-09-16 扩展：基础设施标识 + 顶层文档覆盖面）
//
// 为什么这几条是硬判据（本仓是 **public**）：
//   · 事故原型（2026-09-15）：README 里写了"与某内部项目的关系" + 内部机器名/路径/工具名 ⇒ 把私密结构公开了出去；
//   · 2026-09-16 追加要求："本仓要独立多平台通用，公开面不得出现个人的主机/服务器信息"
//     ⇒ 判据加上**通用**的基础设施模式（真实 IPv4 / 私钥头 / 云凭据真值 / 私钥文件名）。
//   · 同批修掉一处**判据错位**：S8 注释写着"+顶层文档"，实现却只扫 src/bin/test/scripts 的 .mjs
//     ⇒ README/RUNBOOK 这些最可能泄漏的文件根本没被扫（事故原型恰好在 README）。
//
// ⚠ 本文件**刻意不在源码里写出完整违规样本**（否则 S8 会抓自己 —— 首版实测 8/8 全红就是被自己抓的）。
//   所有样本都在**运行时拼装**（`['203','0','113','9'].join('.')` 这种），文件文本里不留连续模式。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkSkeleton } from '../src/selfcheck.mjs';
import { copyPkg, cleanupAll } from './helpers/sandbox.mjs';

test.after(cleanupAll);

// ── 运行时拼装的违规样本（文本里不出现完整模式）──
const S = {
  internalProject: ['myx', 'V2'].join(''),                      // 内部项目名
  internalRepo: ['pre', 'sets'].join(''),                       // 内部容器仓名
  hostNo: ['1', '0', '1'].join(''),                             // 内部主机编号
  drivePath: [['D', ':'].join(''), '\\', 'opt', '\\', 'proj'].join(''),   // 本机盘符路径
  realIp: ['203', '0', '113', '9'].join('.'),                    // 真实 IPv4（TEST-NET-3，文档示例段）
  loopback: ['127', '0', '0', '1'].join('.'),
  anyAddr: ['0', '0', '0', '0'].join('.'),
  keyHeader: ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join(''),   // 私钥头
  keyBody: 'A'.repeat(64),                                       // 假"密钥正文"（触发例外失效分支）
  credName: ['api', '_', 'key'].join(''),                        // 云凭据名
  credValue: ['abcdefgh', 'ijklmnop'].join(''),                  // 假"凭据真值"（≥8 字符）
  idRsa: ['id', '_rsa'].join(''),                                // 私钥文件名
  pemExt: ['.', 'pem'].join(''),
};

const findings = (root) => checkSkeleton(root).findings.filter((f) => f.code === 'S8_INTERNAL_LEAK');

/** 往包副本的指定相对路径写入样本，返回命中 */
function probe(label, relPath, content) {
  const pkg = copyPkg(label);
  writeFileSync(join(pkg, relPath), content, 'utf8');
  return { pkg, hits: findings(pkg) };
}

test('green：线上包自身零命中（含新增的四类通用模式 + 顶层文档覆盖）', () => {
  const pkg = copyPkg('s8-clean');
  const all = checkSkeleton(pkg);
  assert.deepEqual(all.findings.filter((f) => f.code === 'S8_INTERNAL_LEAK'), []);
  assert.equal(all.ok, true, JSON.stringify(all.findings.slice(0, 3)));
});

test('red：源码里出现**真实 IPv4** → 必报（基础设施标识）', () => {
  const { hits } = probe('s8-ip', 'src/leak-ip.mjs', `export const host = '${S.realIp}';\n`);
  assert.equal(hits.length, 1);
  assert.match(hits[0].msg, /真实 IPv4/);
  assert.match(hits[0].msg, /src\/leak-ip\.mjs/);
});

test('green：回环/未指定地址不算基础设施标识（放行）', () => {
  const content = `export const a = '${S.loopback}';\nexport const b = '${S.anyAddr}';\n`;
  const { hits } = probe('s8-loopback', 'src/local.mjs', content);
  assert.deepEqual(hits, []);
});

test('red：私钥头 → 必报；检测器模块里的模式字面量按例外放行，但**真密钥正文**仍会报', () => {
  const a = probe('s8-key', 'src/leak-key.mjs', `export const k = \`${S.keyHeader}\`;\n`);
  assert.equal(a.hits.length, 1);
  assert.match(a.hits[0].msg, /私钥头/);
  // 检测器文件里"模式 + 60+ 字符正文"并存 ⇒ 例外不成立（防"把真密钥粘进检测器"）
  const detector = readFileSync(join(a.pkg, 'src', 'redact.mjs'), 'utf8');
  const b = probe('s8-key2', 'src/redact.mjs', `${detector}\nexport const x = '${S.keyBody}';\n`);
  assert.equal(b.hits.some((f) => /私钥头/.test(f.msg)), true, '检测器里出现真密钥正文必须报');
});

test('red：云凭据/口令真值（赋值形态）→ 必报', () => {
  const { hits } = probe('s8-cred', 'src/leak-cred.mjs', `export const cfg = { ${S.credName}: "${S.credValue}" };\n`);
  assert.equal(hits.length, 1);
  assert.match(hits[0].msg, /云凭据/);
});

test(`red：私钥文件名（${S.idRsa} / *${S.pemExt}）→ 必报`, () => {
  const { hits } = probe('s8-keyfile', 'src/leak-keyfile.mjs', `export const p = '~/.ssh/${S.idRsa}';\nexport const q = 'deploy${S.pemExt}';\n`);
  assert.equal(hits.length, 1);
  assert.match(hits[0].msg, /私钥文件名/);
});

test('red：**顶层文档**（README.md）出现内部标识 → 必报（2026-09-16 覆盖面修复）', () => {
  const { hits } = probe('s8-readme', 'README.md', `# t\n\n本工具配合内部仓库 ${S.internalRepo} 使用。\n`);
  assert.equal(hits.length, 1, 'README 必须被扫（此前只扫 .mjs ⇒ 事故原型恰好漏检）');
  assert.match(hits[0].msg, /README\.md/);
});

test('红态对照（历史基线仍在）：内部项目名 / 本机盘符路径 / 内部主机编号', () => {
  assert.equal(probe('s8-b1', 'src/a.mjs', `export const x = '${S.internalProject}';\n`).hits.length, 1);
  assert.equal(probe('s8-b2', 'src/b.mjs', `export const x = '${S.drivePath}';\n`).hits.length, 1);
  assert.equal(probe('s8-b3', 'src/c.mjs', `export const x = 'host ${S.hostNo}';\n`).hits.length, 1);
});
