// dsh-rulekeeper · 落点解析用例（2026-09-19，P0-3 实装时抓出的"取值面未接线"缺口）
//
// 真实缺口（实测，不是推断）：装载入口 `index.js` 只传 `{dshRoot, handlers}` ⇒ `apply()` 的
//   `landingDir` 恒为 null ⇒ 两条自动通道每轮都 `no-landing`、静默不投递；同刻三处落点都没有
//   `usage.json`，而 `buildReminderText()` 对真实落点返回 3 条 / 589–842 字符（有话可说）。
//
// 判据（读死再下结论）：
//   绿 = 静态 > 现场 agent cwd > noteAgent 最近 cwd > ctx.agents 根 agent cwd；项目无落点退用户级
//   红 = 取不到时**猜**一个路径（硬编码家目录/当前进程 cwd）；服务形态不符时抛错；source 谎报

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { agentCwd, createLandingResolver, landingCapability, registryCwd } from '../src/landing.mjs';
import { cleanupAll, freshProjectLanding, tempDir } from './helpers/sandbox.mjs';

test.after(cleanupAll);

const agentAt = (cwd) => ({ session: { header: { cwd } } });

test('判据: 现场 agent 的会话 cwd ⇒ 项目落点（最准的一条）', () => {
  const { projectRoot, landing } = freshProjectLanding('landing-agent');
  const r = createLandingResolver({});
  const d = r.describe(agentAt(projectRoot));
  assert.equal(d.dir, landing);
  assert.equal(d.source, 'project');
});

test('判据: 静态 landingDir 优先于一切（既有调用方语义不变）', () => {
  const { landing } = freshProjectLanding('landing-static');
  const other = join(tempDir('landing-static-other'), 'explicit');
  const r = createLandingResolver({}, { staticLanding: other });
  const d = r.describe(agentAt(landing)); // 给了 agent 也不影响静态优先
  assert.equal(d.dir, other);
  assert.equal(d.source, 'static');
});

test('判据: noteAgent 记下"最近一轮是哪个会话"（systemPrompt.context 通道的唯一来源）', () => {
  const { projectRoot, landing } = freshProjectLanding('landing-note');
  // `cwdOf` 注入成"没有落点的空目录"：证明**前几档全空时**确实解析不出落点（不靠 process.cwd() 蒙对）
  const { root: emptyRoot } = freshProjectLanding('landing-note-empty', { projectLanding: false });
  // env 也指向"没有用户级落点"的假 DSH_HOME —— 否则本机真实存在的用户级落点会让这条判据变成空转
  const r = createLandingResolver({}, { cwdOf: () => emptyRoot, env: { DSH_HOME: join(emptyRoot, 'nohome') } });
  assert.deepEqual(r.describe(), { dir: null, source: 'none' }, '未知会话 + 无落点的进程 cwd ⇒ 不得猜落点');
  r.noteAgent(agentAt(projectRoot));
  assert.equal(r.resolve(), landing, 'note 之后 provider 才解析得出落点');
  assert.equal(r.describe().source, 'project');
});

test('判据: 最后一档来源 = 进程工作目录（可观测事实，不是猜路径）', () => {
  const { projectRoot, landing } = freshProjectLanding('landing-procwd');
  // 前四档全空（无 agent / 没 note 过 / 注册表为空）⇒ 仍靠进程工作目录解析出**项目**落点
  const r = createLandingResolver({ agents: { roots: () => [] } }, { cwdOf: () => projectRoot });
  const d = r.describe();
  assert.equal(d.dir, landing);
  assert.equal(d.source, 'project');
  // 而"进程 cwd 也没有落点"时仍必须老实返回 none —— 补这一档 ≠ 开始猜路径
  const { root: bare } = freshProjectLanding('landing-procwd-bare', { projectLanding: false });
  const r2 = createLandingResolver({ agents: { roots: () => [] } }, { cwdOf: () => bare, env: { DSH_HOME: join(bare, 'nohome') } });
  assert.deepEqual(r2.describe(), { dir: null, source: 'none' });
});

test('判据: ctx.agents 注册表兜底（进程刚起、首个 pre-step 之前也能解析）', () => {
  const { projectRoot, landing } = freshProjectLanding('landing-registry');
  const ctx = { agents: { roots: () => [agentAt(projectRoot)] } };
  const r = createLandingResolver(ctx);
  assert.equal(r.describe().dir, landing);
  assert.equal(registryCwd(ctx), projectRoot);
});

test('判据: 项目没有落点 ⇒ 退用户级落点（用户级纪律在任何项目里都该被提醒）', () => {
  const { projectRoot, home, env, userLanding } = freshProjectLanding('landing-userfallback', { userLanding: true, projectLanding: false });
  const r = createLandingResolver({}, { env });
  const d = r.describe(agentAt(projectRoot));
  assert.equal(d.dir, userLanding);
  assert.equal(d.source, 'user-fallback');
  assert.ok(existsSync(join(home, 'rulekeeper')), '用户级落点确实存在（否则这条判据是空转）');
  assert.equal(existsSync(join(projectRoot, '.dsh-ai', 'rulekeeper')), false, '前提：项目确实没有落点');
});

test('判据: 都取不到 ⇒ null + source=none（不猜路径、不硬编码家目录）', () => {
  const bare = tempDir('landing-bare');   // 空目录：既无项目落点，也无用户落点
  const r = createLandingResolver({}, { env: { DSH_HOME: join(bare, 'nohome') }, cwdOf: () => bare });
  const d = r.describe(agentAt(bare));
  assert.deepEqual(d, { dir: null, source: 'none' });
  assert.equal(r.resolve(), null);
});

test('判据: 宿主服务形态不符/抛错 ⇒ 当作取不到（fail-open，绝不让插件装载或求值炸掉）', () => {
  assert.equal(registryCwd({ agents: { roots: () => { throw new Error('boom'); } } }), null);
  assert.equal(registryCwd({ agents: { roots: 'not-a-function' } }), null);
  assert.equal(registryCwd({ agents: 42 }), null);
  assert.equal(registryCwd(null), null);
  assert.equal(agentCwd({ session: { header: { cwd: '   ' } } }), null);
  const r = createLandingResolver({ agents: { roots: () => { throw new Error('boom'); } } });
  assert.doesNotThrow(() => r.describe());
});

test('判据: 能力声明与实现同源（顺序与实现一致，不是另写一份文案）', () => {
  const cap = landingCapability();
  // 2026-09-20（方案"甲"）：sources 增 `user-multi-project` 与 `multi-project-no-user-landing`
  assert.deepEqual(cap.sources, ['static', 'project', 'user-fallback', 'user-multi-project', 'multi-project-no-user-landing', 'none']);
  for (const [claimed, actual] of [['现场', 'agent'], ['noteAgent', 'noteAgent'], ['ctx.agents', 'ctx.agents']]) {
    assert.ok(cap.resolution.includes(claimed), `能力声明缺 ${actual} 顺位`);
  }
  // 多项目止血的口径也必须写进能力声明（否则"按会话隔离"只活在代码里，读文档的人不知道）
  assert.ok(String(cap.multiProject).includes('user-multi-project'), '能力声明必须写明多项目时只投用户级落点');
  assert.ok(String(cap.multiProject).includes('agent/pre-step'), '必须写明"有 agent 的通道不受此限"');
});
