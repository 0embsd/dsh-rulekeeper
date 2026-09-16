// dsh-rulekeeper · **R2 落点口径**：新默认 `.dsh-ai/rulekeeper` + 老落点 `.dsh-ai/lessonflow` 兼容窗口
//
// 判据（R2 设计单 §3）：
//   ① 空项目 `init` → 新建**新落点**（不得再产生老落点）
//   ② **预置老落点**的项目 → 工具仍在老落点读写（不搬、不新建）——"不迁移也能用"是一等公民
//   ③ 两处并存 → 解析**优先新落点**
//   ④ 用户级落点（`<DSH_HOME>`）同语义
//   ⑤ hook shim：优先新落点、老落点回退（迁移数据后不必重装 hook）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runRulekeeper, runSnap } from '../src/cli.mjs';
import { landingDirs } from '../src/config.mjs';
import { hookScriptContent } from '../src/hooks.mjs';
import { RC } from '../src/rc.mjs';
import { LANDING_DIRNAME, LEGACY_LANDING_DIRNAME, hasBothLandings, resolveProjectLanding, resolveUserLanding } from '../src/platform/paths.mjs';
import { cleanupAll, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

function capture(fn) {
  let out = '';
  let err = '';
  const rc = fn({ out: (t) => { out += String(t); }, err: (t) => { err += String(t); } });
  return { rc, out, err };
}
const init = (projectRoot, env = {}) => capture((io) => runRulekeeper(['init', '--project', projectRoot], io, env));

test('常量：新默认 rulekeeper、老名 lessonflow（兼容常量必须存在且值固定）', () => {
  assert.equal(LANDING_DIRNAME, 'rulekeeper');
  assert.equal(LEGACY_LANDING_DIRNAME, 'lessonflow');
});

test('① 空项目 init -> 建**新落点**，且不产生老落点', () => {
  const root = tempDir('r2-new');
  assert.equal(init(root).rc, RC.OK);
  assert.equal(existsSync(join(root, '.dsh-ai', 'rulekeeper', 'config.json')), true);
  assert.equal(existsSync(join(root, '.dsh-ai', 'lessonflow')), false, '空白项目不得再建老落点');
  assert.equal(hasBothLandings(root), false);
});

test('② 预置老落点 -> 工具仍在老落点读写（不搬、不新建）', () => {
  const root = tempDir('r2-legacy');
  const legacy = join(root, '.dsh-ai', 'lessonflow');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'config.json'), '{\n  "schema": 1,\n  "mode": "observe"\n}\n', 'utf8');
  writeFileSync(join(legacy, 'rules.json'), '{"schema":1,"project":"p","protected_paths":[],"gates":[],"checks":[],"inject":[]}\n', 'utf8');
  writeFileSync(join(root, 'target.txt'), 'v1\n', 'utf8');

  assert.equal(init(root).rc, RC.OK);
  assert.equal(existsSync(join(root, '.dsh-ai', 'rulekeeper')), false, '老落点存在时不得新建新落点');
  const snap = capture((io) => runSnap(['take', '--landing', legacy, '--project', root, '--path', 'target.txt'], io, {}));
  assert.equal(snap.rc, RC.OK, snap.out);
  assert.equal(existsSync(join(legacy, 'snapshots', 'index.jsonl')), true, '数据必须落在老落点里');
  assert.equal(landingDirs({ projectRoot: root }).project, legacy, '解析器必须沿用老落点');
});

test('③ 两处并存 -> 解析优先新落点（并可由 hasBothLandings 报"分叉"）', () => {
  const root = tempDir('r2-both');
  mkdirSync(join(root, '.dsh-ai', 'lessonflow'), { recursive: true });
  mkdirSync(join(root, '.dsh-ai', 'rulekeeper'), { recursive: true });
  assert.equal(resolveProjectLanding(root), join(root, '.dsh-ai', 'rulekeeper'));
  assert.equal(hasBothLandings(root), true);
});

test('④ 用户级落点同语义：老 <DSH_HOME>/lessonflow 存在时沿用，否则用 rulekeeper', () => {
  const home = tempDir('r2-user');
  assert.equal(resolveUserLanding({ DSH_HOME: home }), join(home, 'rulekeeper'), '空 DSH_HOME -> 新名');
  mkdirSync(join(home, 'lessonflow'), { recursive: true });
  assert.equal(resolveUserLanding({ DSH_HOME: home }), join(home, 'lessonflow'), '老落点存在 -> 沿用');
  mkdirSync(join(home, 'rulekeeper'), { recursive: true });
  assert.equal(resolveUserLanding({ DSH_HOME: home }), join(home, 'rulekeeper'), '两处并存 -> 优先新名');
});

test('⑤ hook shim：优先新落点、老落点回退（迁移后不必重装）', () => {
  const shim = hookScriptContent({ name: 'pre-commit' });
  assert.match(shim, /if \[ -f "\$root\/\.dsh-ai\/rulekeeper\/hook\.mjs" \]; then L="rulekeeper"; else L="lessonflow"; fi/);
  assert.match(shim, /exec node "\$root\/\.dsh-ai\/\$L\/hook\.mjs" pre-commit "\$@"/);
  // 生成物必须可携带：不含盘符绝对路径
  assert.equal(/[A-Za-z]:[\\/]/.test(shim), false, 'shim 里不得出现盘符路径');
});
