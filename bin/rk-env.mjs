#!/usr/bin/env node
// rk-env 薄壳（逻辑在 src/cli.mjs）
// 退出码契约见 src/rc.mjs（唯一权威源）

import { runEnv } from '../src/cli.mjs';

process.exitCode = runEnv(process.argv.slice(2));
