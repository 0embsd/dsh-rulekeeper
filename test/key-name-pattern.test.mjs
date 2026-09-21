// dsh-rulekeeper · 私钥文件名判据的**误报面**用例（规则 53 的现场教训，2026-09-21）
//
// 来历（连着两轮实测，都是"先在真仓跑"抓出来的）：
//   ① 旧判据 旧的"子串"写法 命中子串 ⇒ `.gitignore` 里的忽略规则
//      `*.<扩展名>` 与 `<名字>*`（**配置内容**）被判成"私钥文件名" ⇒ 给预设仓装钩子时当场拒提交；
//   ② 收紧成"路径位置"后漏了 `m` 标志 ⇒ `^` 只匹配整段文本开头，中间行的 `<目录>/<私钥名>` 反而**漏过**；
//   ③ 再收紧后裸文件名又漏（后随是中文，`(?=[\s:/\\]|$)` 太窄）⇒ 改用 `(?![\w.])`。
//
// 判据（读死再下结论）：**配置形态必须绿、真凭据路径必须红**，两向都要有样本。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findPublicFaceLeaks } from '../src/selfcheck.mjs';
import { patternsForKind } from '../src/repo-patterns.mjs';

const PATS = patternsForKind('private');

// **可疑串一律运行时拼装**（规则 51）：拼接后才是真串，源码正文里不构成那个 token。
const KEYNAME = `id_${'rsa'}`;                    // 私钥文件名
const KEYNAME2 = `id_${'ed25519'}`;               // 另一种私钥文件名
const PEM = `.${'pem'}`;                          // 私钥扩展名

const hits = (text) => findPublicFaceLeaks('x.txt', text, PATS).length > 0;

test('判据（绿向）: 忽略规则/占位/普通英文词都不是"私钥文件名"', () => {
  // 这条就是现场误报：一个 .gitignore 让整个预设仓提交不上去
  assert.equal(hits(`${KEYNAME}*\n${KEYNAME2}*\n*${PEM}\n*.key\n.env`), false, '忽略规则是配置，不是凭据');
  assert.equal(hits(`忽略 *${PEM} 全部`), false);
  assert.equal(hits(`用 <name>${PEM} 占位`), false);
  assert.equal(hits(`${PEM.slice(1)} 是一种编码格式`), false);
});

test('判据（红向）: 真凭据路径/文件名两档都要红', () => {
  assert.equal(hits(`见 deploy/${KEYNAME} 这份`), true);
  assert.equal(hits(`cat ~/.ssh/${KEYNAME2}`), true);
  assert.equal(hits(`${KEYNAME} \n`), true, '行首裸名 + 空白');
  assert.equal(hits(`文件 ${KEYNAME2} 丢了`), true, '行中裸名（后随中文）');
  assert.equal(hits(`证书 server${PEM} 在`), true, '裸 .pem 文件名');
  assert.equal(hits(`C:\\keys\\app${PEM}`), true, 'Windows 路径');
});

test('判据（多行）: 中间行也必须扫到（`m` 标志的意义）', () => {
  const multi = ['# 注释行', '名字随便', `target=deploy/${KEYNAME}`, '', '结束'].join('\n');
  assert.equal(hits(multi), true, '`^` 不加 m 时会只看第一行 ⇒ 这条会漏');
});
