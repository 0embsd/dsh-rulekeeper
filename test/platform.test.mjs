// dsh-rulekeeper · LF-130 用例：跨平台基线的**单点判据**
//
// 判据（清单 LF-130）：
//   ① `C:\a\B` ≡ `c:/a/b`（路径归一到同一 key）
//   ② 固定 `--now` 后，含时间戳的输出逐字可复现（本文件验证机制；两次**进程**运行见凭证）
// 红态：去掉 `--now` → 输出比较必红（凭证里用两次进程运行 + 中间 sleep 证明）

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UsageError, resolveNow, stamp } from '../src/platform/clock.mjs';
import { dshHome, expandHome, homeDir, pathKey, relativeToRoot, toPosix } from '../src/platform/paths.mjs';
import { LF, escapeControl, jsonStable, line, sortCodePoints } from '../src/platform/out.mjs';

// ── ① 路径归一 ──────────────────────────────────────────────────────
test('paths：C:\\a\\B 与 c:/a/b 归一到同一 key（LF-130 主判据）', () => {
  assert.equal(pathKey('C:\\a\\B'), 'c:/a/b');
  assert.equal(pathKey('c:/a/b'), 'c:/a/b');
  assert.equal(pathKey('C:\\a\\B'), pathKey('c:/a/b'));
});

test('paths：长路径前缀 / 重复斜杠 / 尾斜杠 / 盘根 / UNC / 空值', () => {
  assert.equal(toPosix('\\\\?\\C:\\x'), 'c:/x');
  assert.equal(toPosix('c:\\a\\\\b\\'), 'c:/a/b');
  assert.equal(toPosix('C:\\'), 'c:/');
  assert.equal(toPosix('\\\\srv\\share\\a'), '//srv/share/a');
  assert.equal(toPosix(''), '');
  assert.equal(toPosix(undefined), '');
  assert.equal(toPosix('  C:\\x  '), 'c:/x');
});

test('paths：home 兜底顺序 + ~ 展开', () => {
  assert.equal(homeDir({ USERPROFILE: 'C:\\u' }), 'C:\\u');
  assert.equal(homeDir({ HOME: '/home/u' }), '/home/u');
  assert.equal(homeDir({ HOMEDRIVE: 'D:', HOMEPATH: '\\h' }), 'D:\\h');
  assert.equal(pathKey(expandHome('~/x', { USERPROFILE: 'C:\\u' })), 'c:/u/x');
  assert.equal(toPosix(expandHome('~/x', { HOME: '/home/u' })), '/home/u/x');
  assert.equal(expandHome('/abs/x', { USERPROFILE: 'C:\\u' }), '/abs/x');
});

test('paths：DSH_HOME 兜底 + relativeToRoot（判据里禁绝对路径）', () => {
  if (process.platform === 'win32') {
    // Windows 形态的输入只在 Windows 上有意义（LF-565：Linux 上 `resolve('C:\\h')` 会变成相对路径）
    assert.equal(pathKey(dshHome({ DSH_HOME: 'C:\\h' })), 'c:/h');
    assert.equal(pathKey(dshHome({ DSH_HOME: '   ' , USERPROFILE: 'C:\\u' })), 'c:/u/.dsh');
    assert.equal(relativeToRoot('D:\\opt\\proj\\.dsh-ai\\x', 'D:/opt/proj'), '.dsh-ai/x');
    assert.equal(relativeToRoot('D:\\opt\\proj', 'D:/opt/proj'), '.');
    assert.equal(relativeToRoot('C:\\other', 'D:/opt/proj'), null);
  } else {
    // POSIX 等价面（同一语义、不同形态：**不是跳过**，是换平台输入跑同一条判据）
    assert.equal(pathKey(dshHome({ DSH_HOME: '/h' })), '/h');
    assert.equal(pathKey(dshHome({ DSH_HOME: '   ' })), `${pathKey(homeDir({}))}/.dsh`);
    assert.equal(relativeToRoot('/opt/proj/.dsh-ai/x', '/opt/proj'), '.dsh-ai/x');
    assert.equal(relativeToRoot('/opt/proj', '/opt/proj'), '.');
    assert.equal(relativeToRoot('/other', '/opt/proj'), null);
  }
  assert.equal(relativeToRoot('', 'D:/opt/proj'), null);
});

// ── ② 时钟注入 ──────────────────────────────────────────────────────
test('clock：--now 固定后两次解析逐字相同；未固定则 fixed=false', () => {
  const a = resolveNow({ argv: ['--now', '2026-09-14T00:00:00Z'], env: {} });
  const b = resolveNow({ argv: ['--now', '2026-09-14T00:00:00Z'], env: {} });
  assert.equal(a.fixed, true);
  assert.equal(a.iso, '2026-09-14T00:00:00.000Z');
  assert.equal(a.iso, b.iso);
  assert.equal(resolveNow({ argv: [], env: {} }).fixed, false);
});

test('clock：env 注入等价 + 非法值/缺值抛 UsageError', () => {
  const viaEnv = resolveNow({ argv: [], env: { RULEKEEPER_NOW: '2026-01-02T03:04:05Z' } });
  assert.equal(viaEnv.fixed, true);
  assert.equal(viaEnv.iso, '2026-01-02T03:04:05.000Z');
  assert.equal(stamp(new Date('2026-01-02T03:04:05Z')), '20260102-030405');
  assert.throws(() => resolveNow({ argv: ['--now', 'yesterday'], env: {} }), UsageError);
  assert.throws(() => resolveNow({ argv: ['--now'], env: {} }), UsageError);
  assert.throws(() => resolveNow({ argv: ['--now', '--json'], env: {} }), UsageError);
});

// ── ③ 唯一输出器 ────────────────────────────────────────────────────
test('out：一律 LF（无 CR），标记为 ASCII', () => {
  assert.equal(LF, '\n');
  assert.equal(line('a', 'b'), 'a b\n');
  assert.ok(!line('x').includes('\r'));
});

test('out：码位排序（与 locale 排序不同，故禁 localeCompare）', () => {
  assert.deepEqual(sortCodePoints(['b', 'A', 'z', 'ä']), ['A', 'b', 'z', 'ä']);
  assert.deepEqual(sortCodePoints(['z', 'ä']), ['z', 'ä']);
});

test('out：稳定 JSON（键按码位排序、两次序列化逐字相同）', () => {
  const value = { b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } };
  const s1 = jsonStable(value);
  const s2 = jsonStable(value);
  assert.equal(s1, s2);
  assert.ok(s1.indexOf('"a"') < s1.indexOf('"b"'));
  assert.deepEqual(Object.keys(JSON.parse(s1).a), ['c', 'd']);
  assert.ok(s1.endsWith('\n'));
  assert.ok(!s1.includes('\r'));
});

test('out：控制字符转义（含 CR，避免跨平台行尾污染）', () => {
  assert.equal(escapeControl('a\u0000b\u001fc'), 'a\\u0000b\\u001fc');
  assert.equal(escapeControl('a\r\n'), 'a\\u000d\n');
});
