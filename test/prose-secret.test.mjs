// dsh-rulekeeper · P15 用例：公开面 deny 表补**散文语境口令**判据
//
// 现场（2026-09-23，被治理项目报）：原表只认 `key[:=] "值"` 形态，而"⟨关键词⟩是⟨口令值⟩"这种散文写法
// 一路漏过去（他们那边真漏过一次）。
//
// 本文件的判据：
//   ① 散文形态**必红**（中文"是/为/："、英文"is"、`=` 带引号值）
//   ② 正常散文**不得红**（提到"密码学/口令写在 config/函数调用/行号引用/环境变量名/纯数字权限位"…）
//   ③ **误报面读数**必须打印（规则 53：先量后写）—— 负样本 N 条里误报 M 条、真仓扫描命中 R 个文件
//   ④ 分档口径不破：private 档不跑 identity 类、infra 类两档都跑（新判据属 infra）
//   ⑤ **不为用例开例外**（规则 51）：本文件里的样本全部**运行时拼装**，不出现连续字面量；
//      并且钉住"这不是靠文件路径豁免实现的"（同样内容换个文件名照样命中）
//
// ⚠ 本文件里所有可疑串要么拼装、要么写成非连续片段 —— 否则 S8/公开面判据会把**用例自己**判红
//   （本会话实测过一次：注释里写样例串被 S8 抓）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { findPublicFaceLeaks, PUBLIC_FACE_FORBIDDEN } from '../src/selfcheck.mjs';
import { patternsForKind } from '../src/repo-patterns.mjs';
import { PKG_ROOT } from './helpers/sandbox.mjs';

const PATTERNS = patternsForKind('public');

/** 拼装一条"散文口令"样本：关键词与值都不作为连续字面量出现 */
const prose = (kw, sep, value, tail = '') => [kw, sep, value, tail].join('');
const KW_ZH = ['密', '码'].join('');        // "密码"
const KW_KOU = ['口', '令'].join('');        // "口令"
const KW_SI = ['私', '钥'].join('');         // "私钥"
const SEP_IS = ['是', ''].join('');          // "是"
const SEP_COLON = ['：', ''].join('');       // "："

/** 负样本 N 条（必须全部不红） */
const NEGATIVE = Object.freeze([
  ['密码学不是边界', [['密', '码'].join(''), '学签名不是边界'].join('')],
  ['口令写在 config 里', [KW_KOU, '写在 config 里，见 config.json'].join('')],
  ['函数调用', 'Password = splitCred(args[2])'],
  ['行号引用', [KW_ZH, ' :77-81'].join('')],
  ['凭据为 check-run', ['凭据', '为 check-run 注解'].join('')],
  ['正则字面量', 'TOKEN = /\\b(?:LF-\\d{8})\\b/g;'],
  ['环境变量名', 'apiKey = OPENAI_API_KEY'],
  ['路径引用', [KW_ZH, '：src/config/credential-resolver.ts:71-75'].join('')],
  ['权限位', [KW_SI, '：0640'].join('')],
  ['类型标注', 'password: string'],
  ['URL 参数', 'sslmode=disable&password=secret'],
  ['普通词（裸值无数字）', [KW_ZH, SEP_IS, ' restore'].join('')],
  ['真值在别处', ['secret_key ', 'is', ' set via env'].join('')],
  ['字段赋值', 'resolver.password = env.PASSWORD'],
  ['尖括号占位', 'password: <YOUR_TOKEN_HERE>'],
  // ⚠ 这一组是**独立复核的 blocker 抓出来的**（2026-09-23）：讲"口令怎么存"的正常技术文档句。
  // 它们全都"带数字"，恰好满足"裸值必须含数字"那条线 ⇒ 曾被判成硬编码口令（那批语料 50% 假阳），
  // 而且会穿透到 pre-commit 拦下正常提交。**必须留在负样本里**，否则下一次收紧还会漏掉这一整类。
  ['算法名 sha256', ['数据库存储：', KW_ZH, SEP_IS, ' ', 'sha256 哈希后的值'].join('')],
  ['算法名 aes256', ['', KW_ZH, '为', ' ', 'aes256 加密存储'].join('')],
  ['编码名 base64', [KW_KOU, '是', ' ', 'base64 编码后传输'].join('')],
  ['派生算法 argon2id', ['口令经 ', 'argon2id 派生'].join('')],
  ['摘要 md5', ['', KW_ZH, SEP_IS, ' ', 'md5 摘要'].join('')],
  ['字符集 utf8', [KW_ZH, SEP_IS, ' ', 'utf8 编码'].join('')],
]);

test('P15①: 散文形态的硬编码口令**必红**（中文/英文/赋值三种写法）', () => {
  const positives = [
    ['中文散文', prose(KW_ZH, SEP_IS, ' ', 'hunter2XYZ，别外传')],
    ['中文冒号', prose(KW_KOU, SEP_COLON, 'Pr0d-Pass-2026')],
    ['英文 is', ['the api_key ', 'is', ' "sk-abc12345DEF"'].join('')],
    ['等号加引号', ['pwd ', '= ', '"Zx9$kQ2m"'].join('')],
  ];
  for (const [label, text] of positives) {
    const hits = findPublicFaceLeaks('probe.md', text, PATTERNS);
    assert.equal(hits.some((h) => h.why.includes('散文')), true,
      `${label} 必须被判红：${JSON.stringify(text)} -> ${JSON.stringify(hits)}`);
  }
});

test('P15②: 正常散文/代码**不得红**，且打印误报面读数（规则 53）', () => {
  const falsePositives = [];
  for (const [label, text] of NEGATIVE) {
    const hits = findPublicFaceLeaks('probe.md', text, PATTERNS).filter((h) => h.why.includes('散文'));
    if (hits.length > 0) falsePositives.push(`${label}: ${JSON.stringify(hits[0].match)}`);
  }
  // **误报面读数**（不是断言句，是证据行）：负样本总数与误报数都必须打出来
  console.log(`PROSE_FP_MEASURED negatives=${NEGATIVE.length} false_positives=${falsePositives.length}`);
  assert.deepEqual(falsePositives, [], `正常散文不得触发散文判据：${JSON.stringify(falsePositives)}`);
});

test('P15②b: "口令怎么存的"整类不得红（算法/编码名），而"口令是什么"必须红', () => {
  // 这一条是独立复核 blocker 的回归钉：算法名带数字 ⇒ 曾被误判（那批语料 50% 假阳）。
  const algorithms = ['sha256 哈希后的值', 'aes256 加密存储', 'base64 编码后传输', 'argon2id 派生', 'md5 摘要'];
  for (const tail of algorithms) {
    const text = [KW_ZH, SEP_IS, ' ', tail].join('');
    const hits = findPublicFaceLeaks('AUTH.md', text, PATTERNS).filter((h) => h.why.includes('散文'));
    assert.equal(hits.length, 0, `"怎么存的"不得判红：${JSON.stringify(text)} -> ${JSON.stringify(hits)}`);
  }
  // 同一条判据在"口令是什么"上必须仍然开火（收紧不得把判别力一起收掉）
  const real = [KW_ZH, SEP_IS, ' ', 'P@ssw0rd!2026'].join('');
  assert.equal(findPublicFaceLeaks('AUTH.md', real, PATTERNS).some((h) => h.why.includes('散文')), true);
});

test('P15③: 真仓自扫的**误报面读数**必须为 0（判据先在真仓量过才写）', () => {
  // 判据面就是本仓自己的源码/文档/用例：新判据若误报，这里立刻看得见。
  const roots = ['src/repo-patterns.mjs', 'src/selfcheck.mjs', 'src/gate.mjs', 'README.md', 'SCHEMA.md', 'RUNBOOK.md'];
  const hits = [];
  for (const rel of roots) {
    let text; try { text = readFileSync(join(PKG_ROOT, rel), 'utf8'); } catch { continue; }
    for (const h of findPublicFaceLeaks(rel, text, PATTERNS)) if (h.why.includes('散文')) hits.push(`${rel}: ${h.match}`);
  }
  console.log(`PROSE_REPO_HITS files=${roots.length} hits=${hits.length}`);
  assert.deepEqual(hits, [], `真仓不得因新判据冒违规：${JSON.stringify(hits)}`);
});

test('P15④: 分档不破 —— 新判据属 infra，两档都跑；identity 仍只在 public 档', () => {
  const pub = patternsForKind('public');
  const pri = patternsForKind('private');
  assert.equal(pub.length > pri.length, true, 'public 档必须包含 identity 类');
  const prose = ['数据库的', KW_ZH, SEP_IS, ' ', 'hunter2XYZ'].join('');
  assert.equal(findPublicFaceLeaks('probe.md', prose, pub).length > 0, true, 'public 档必须跑新判据');
  assert.equal(findPublicFaceLeaks('probe.md', prose, pri).length > 0, true, 'private 档也必须跑（基础设施/凭据类）');
  // identity 类仍只在 public 档（新判据不得顺手把 identity 拉进 private）
  const identitySample = ['myx', 'V2'].join('');
  assert.equal(findPublicFaceLeaks('probe.md', identitySample, pub).length > 0, true);
  assert.equal(findPublicFaceLeaks('probe.md', identitySample, pri).length, 0, 'private 档不许跑 identity 类');
});

test('P15⑤: 判据不靠**文件路径豁免**（规则 51）—— 同样内容换个文件名照样命中', () => {
  const prose = ['数据库的', KW_ZH, SEP_IS, ' ', 'hunter2XYZ'].join('');
  for (const rel of ['test/prose-secret.test.mjs', 'README.md', 'docs/x.md', 'src/anything.mjs', 'a.txt']) {
    const hits = findPublicFaceLeaks(rel, prose, PATTERNS).filter((h) => h.why.includes('散文'));
    assert.equal(hits.length > 0, true, `${rel}: 命中不得取决于文件名（否则就是给用例开后门）`);
  }
  // 反向钉住（**本判据自己**的豁免表）：把新判据的 `allow()` **函数体**取出来抽查它有没有按路径放行。
  // 只取函数体（注释不算证据，注释里提到用例路径是正常的）；"豁免表里有没有 test/"另由
  // `scripts/checkers/no-test-exception.mjs` 机械检查（不在这里重复实现）。
  const src = readFileSync(join(PKG_ROOT, 'src', 'repo-patterns.mjs'), 'utf8');
  const proseStart = src.indexOf('散文语境的口令');
  const proseRule = src.slice(proseStart, src.indexOf('只看真正的路径形态', proseStart));
  const allowBody = proseRule.slice(proseRule.indexOf('allow:'), proseRule.lastIndexOf('},'));
  assert.doesNotMatch(allowBody, /rel\s*===/, '新判据的 allow() 不得按 `rel` 路径放行');
  assert.doesNotMatch(allowBody, /test-fixtures|test\//, '新判据的 allow() 不得出现 test/ 或夹具路径');
});
