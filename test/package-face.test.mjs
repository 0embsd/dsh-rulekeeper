// dsh-rulekeeper · LF-450/LF-630 **前置：可装载插件 bundle**（打包面机械判据）
//
// 判据（本条目自定，服务于 LF-450/630 的"装/卸 lessonflow"）：
//   绿 = ①`package.json` 有 `main` + `dsh.bundle.patch`，两者指向**真实存在**的文件
//        ②patch 文件里有 `- insert:` 且点名本包名（否则装载时静默不生效）
//        ③入口 `export default { name, inject, apply }` 形态正确，`apply(fakeCtx)` 返回 ok 且注册的工具全带 `rulekeeper_` 前缀
//   红 = 清单字段缺失 / patch 指向不存在的文件 / patch 里没点名本包 / 入口形态不对 → 必红
//
// 为什么必须有这条测试：LF-400/LF-440 凭证自认"未在旁路 profile 实装"，缺的正是这一层清单；
//   而"清单指向不存在的文件"在 DSH 里表现为**静默不装载**（最危险的那种失败）。
//
// **验收边界（2026-09-15 实测，必须记住）**：本文件用**假 ctx**（`{effect, tools:{register}}`）调 `apply`，
//   它只能证明"入口形态对、工具名带前缀"——**不构成宿主契约验收**。
//   真实验收 = 把本包装进一个旁路 profile 并起一次**真会话**（`dsh --profile <p> "<task>"`）且 `exit=0`；
//   实测反例：`ctx.tools.register(name, handler)` 的**两参**写法在真宿主上直接抛
//   `tool "undefined" must declare output { schema, render, presentationMeta? }` ⇒ 插件树装载失败、
//   会话起不来（宿主契约是 `register(单个 definition)` 且必须带 `output{schema,render}`；
//   取证与逐字输出见 `.dsh-ai/verify/probe-rk-plugin-load-20260915.txt`）。
//   因此本文件**不得**被当作"插件能装入 DSH"的证据。
//
// 平台说明：`apply` 需要宿主事件表（读 `DSH_HOME`）；**没有 DSH 的机器**（Linux 载体）上如实跳过，
// 并打印 reason（不把"没装 DSH"当"通过"）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import entry, { resolveDshRoot, TOOL_PREFIX } from '../index.js';
import { eventTableFromHost, PLUGIN_TOOLS } from '../src/plugin.mjs';

const PKG = join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));

test('green: 清单字段齐全且指向真实文件（main / dsh.bundle.patch）', () => {
  assert.equal(typeof manifest.main, 'string', '缺 main ⇒ DSH 找不到入口');
  assert.equal(existsSync(join(PKG, manifest.main)), true, `main 指向不存在的文件: ${manifest.main}`);
  const patch = manifest.dsh?.bundle?.patch;
  assert.equal(typeof patch, 'string', '缺 dsh.bundle.patch ⇒ profile 装载时静默不生效');
  assert.equal(existsSync(join(PKG, patch)), true, `patch 指向不存在的文件: ${patch}`);
  assert.equal(Array.isArray(manifest.files), true, 'files 白名单缺省会让发布包丢掉入口/patch');
  for (const f of ['index.js', patch.replace('./', '')]) {
    assert.equal(manifest.files.includes(f), true, `files 白名单缺 ${f}（发布后装载会失败）`);
  }
  assert.equal(manifest.dependencies, undefined, '零依赖（清单面不得引入 dependencies）');
  assert.equal(manifest.type, 'module');
});

test('green: patch 文件点名本包（否则 insert 了别的名字 = 静默不装载）', () => {
  const patch = readFileSync(join(PKG, manifest.dsh.bundle.patch), 'utf8');
  assert.match(patch, /^- insert:/m, 'patch 必须是 `- insert:` 形态');
  assert.ok(patch.includes(`id: ${manifest.name}`), `patch 里没有 id: ${manifest.name}`);
  assert.ok(patch.includes(`name: '${manifest.name}'`), `patch 里没有 name: '${manifest.name}'`);
});

test('green: 入口是宿主约定形态（default {name, inject, apply}）', () => {
  assert.equal(entry.name, manifest.name);
  assert.deepEqual(entry.inject, ['tools', 'systemPrompt']);   // 2026-09-20：+systemPrompt（提醒投递的载体，不声明就读不到）
  assert.equal(typeof entry.apply, 'function');
  assert.equal(typeof resolveDshRoot(), 'string');
});

test('green: apply(fakeCtx) 注册的工具全带前缀；无 DSH 的机器如实跳过', (t) => {
  const dshRoot = resolveDshRoot();
  // `eventTableFromHost()` 返回 `{table, scanned}`（table 是 Set）——不是"表本身"
  const probe = eventTableFromHost(dshRoot);
  const table = probe?.table ?? probe;
  const size = typeof table?.size === 'number' ? table.size : (Array.isArray(table) ? table.length : 0);
  if (size === 0) {
    // 无 DSH 的载体（Linux 机器）上 boot 自检必然失败 —— 那是**正确**的 fail-fast ⇒ 只验形态、如实跳过真实 apply
    t.skip(`本机没有可读的宿主事件表（DSH_HOME=${dshRoot}）⇒ 跳过真实 apply（无 DSH 的载体属此列）`);
    return;
  }
  const registered = [];
  const ctx = {
    effect: (fn) => { fn(); },
    // 宿主契约：register 收**单个 definition 对象**（2026-09-15 真装载实测；两参写法会让插件树装载失败）
    tools: { register: (definition) => { registered.push(definition); return () => {}; } },
  };
  const ret = entry.apply(ctx);
  assert.equal(ret, undefined, 'apply 必须返回 undefined（cordis 只接受 函数/null/thenable/iterable）');
  assert.equal(registered.length, PLUGIN_TOOLS.length, 'PLUGIN_TOOLS 有几件，就注册几件（个数从登记表派生，避免新增工具时用例假红）');
  assert.ok(registered.length >= 3, `至少注册 3 个工具，实测 ${registered.length}`);
  for (const d of registered) {
    assert.equal(typeof d.name, 'string', 'definition.name 必须是字符串');
    assert.ok(d.name.startsWith(TOOL_PREFIX), `工具名必须带 ${TOOL_PREFIX} 前缀: ${d.name}`);
    assert.equal(typeof d.parameters, 'object', `${d.name} 缺 parameters`);
    assert.equal(typeof d.output, 'object', `${d.name} 缺 output（宿主会直接拒绝注册）`);
    assert.equal(typeof d.output.render, 'function', `${d.name}.output.render 必须是函数`);
    assert.equal(typeof d.output.schema, 'object', `${d.name}.output.schema 必须是对象`);
    assert.equal(typeof d.execute, 'function', `${d.name} 缺 execute`);
  }
});

test('红态: 清单指向不存在的 patch 文件 → 判据必须能发现（非恒真）', () => {
  // 用**同一套判据**判定一个坏清单：patch 指向不存在的文件 + files 白名单缺入口
  const bad = { ...manifest, dsh: { bundle: { patch: './nope.patch.yml' } }, files: ['bin/'] };
  const findings = [];
  const patch = bad.dsh?.bundle?.patch;
  if (typeof patch !== 'string') findings.push('NO_PATCH_FILE');
  else if (!existsSync(join(PKG, patch))) findings.push('PATCH_FILE_MISSING');
  if (!Array.isArray(bad.files) || !bad.files.includes('index.js')) findings.push('FILES_WHITELIST_MISSING_ENTRY');
  assert.deepEqual(findings, ['PATCH_FILE_MISSING', 'FILES_WHITELIST_MISSING_ENTRY'], '坏清单必须被抓到');
});

// ── 判据（2026-09-23 新增）：**装上之后判据真能跑** ────────────────────────────────────
// 现场：`files` 白名单只有 `index.js/src/bin/...`，而 `scripts/checkers/**` 与两个样本目录
// **都不在里面** ⇒ `npm pack` / 从 GitHub 装上之后：所有 spec 命令指不到脚本、所有红/绿样本不存在
// ⇒ 判据全部跑不起来。旧判据只核了"入口 + patch 在不在"，**核不到这一层**（"发布面 ≠ 入口面"）。
// npm 语义：`files` 里的目录条目包含整棵子树；`package.json`/`README`/`LICENSE` 恒含。
function coveredByFiles(rel, files) {
  const norm = String(rel).replace(/\\/g, '/').replace(/^\.\//, '');
  return (Array.isArray(files) ? files : []).some((entry) => {
    const e = String(entry).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    return e !== '' && (norm === e || norm.startsWith(`${e}/`));
  });
}

test('green: 发布包里必须带齐"判据运行时真正要读的东西"（spec / 检查器脚本 / 红绿样本）', () => {
  const specDir = join(PKG, 'scripts', 'checkers');
  const specs = readdirSync(specDir).filter((f) => f.endsWith('.spec.json'));
  assert.ok(specs.length >= 9, `spec 数量异常（实得 ${specs.length}）`);
  const missing = [];
  // ① 规格文件与它们命令指向的脚本（同一个目录，故核目录覆盖即可）
  if (!coveredByFiles('scripts/checkers/', manifest.files)) missing.push('scripts/checkers/');
  // ② 每份规格的红/绿样本目录
  for (const f of specs) {
    const spec = JSON.parse(readFileSync(join(specDir, f), 'utf8'));
    for (const key of ['redSample', 'greenSample']) {
      const src = spec[key]?.source;
      if (typeof src !== 'string' || src === '' || src === '.') continue;   // `.` = 被检对象自身，无需打包
      if (!coveredByFiles(src, manifest.files)) missing.push(`${src}  (${f} 的 ${key})`);
    }
  }
  assert.deepEqual(missing, [], `发布包会丢掉判据运行时必需的文件 ⇒ 装上跑不起来：\n  ${missing.join('\n  ')}`);
});

test('红态: 上述判据对"白名单缺样本/缺脚本"必须能发现（非恒真）', () => {
  const badFiles = ['index.js', 'src/', 'bin/'];   // = 修复前的真实形态
  assert.equal(coveredByFiles('scripts/checkers/', badFiles), false, '缺 scripts/ 必须判不覆盖');
  assert.equal(coveredByFiles('test-fixtures/red', badFiles), false, '缺样本目录必须判不覆盖');
  assert.equal(coveredByFiles('scripts/checkers/gate.mjs', ['scripts/']), true, '目录条目要按子树覆盖');
  assert.equal(coveredByFiles('index.js', badFiles), true);
});

