#!/usr/bin/env node
// rk-selfcheck 薄壳（逻辑在 src/cli.mjs）
// 退出码契约见 src/rc.mjs（唯一权威源）

import { runSelfcheck } from '../src/cli.mjs';

process.exitCode = runSelfcheck(process.argv.slice(2));
