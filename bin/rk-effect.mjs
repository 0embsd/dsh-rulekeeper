#!/usr/bin/env node
// rk-effect 薄壳（逻辑在 src/cli.mjs；rc 契约见 src/rc.mjs）
//
// 生效闭环：`plan`（只读体检）/ `verify`（三项验证）/ `apply`（**唯一**写 rules.json，须人签字）/ `inject`（注入计划）。

import { runRulekeeperSub } from '../src/cli.mjs';

process.exitCode = runRulekeeperSub('effect', process.argv.slice(2));
