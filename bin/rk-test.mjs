#!/usr/bin/env node
// rk-test 薄壳（2026-09-19 补）
//
// 为什么需要它：规则 40（门禁绕行禁令）要求"构建/测试走编排器入口"，但本项目此前**只有**
// package.json 里的 `test: "node --test"`（裸命令）⇒ 每次跑用例都落在"绕行"形态里，
// 属于"能力有、入口没有"的同类缺口（与 L628 那条"没检查=绿"同一族：流程缺口不该靠自觉）。
// 本壳就是那个入口，转调 `node --test`，把 rc 原样透传。
//
// 用法:
//   rk-test                     # 跑 test/ 全部用例
//   rk-test test/effect.test.mjs   # 只跑指定文件（透传给 node --test）
// 退出码: 见 src/rc.mjs 的 rc 契约家族；本壳**透传** node --test 的 rc（0 全绿 / 1 有败例）。
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log('用法: rk-test [<test-file-or-dir> ...]');
  console.log('说明: 转调 `node --test`（cwd=包根）；不带参数跑 test/ 全部用例；rc 原样透传。');
  process.exit(0);
}

const res = spawnSync(process.execPath, ['--test', ...args], { cwd: ROOT, stdio: 'inherit' });
if (res.error) {
  console.error(`rk-test: 无法启动 node --test: ${String(res.error.message || res.error)}`);
  process.exit(1);
}
process.exit(res.status ?? 1);
