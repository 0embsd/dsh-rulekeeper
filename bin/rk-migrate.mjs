#!/usr/bin/env node
// rk-migrate 薄壳（逻辑在 src/cli.mjs）
// 退出码契约见 src/rc.mjs（唯一权威源）

import { runMigrate } from '../src/cli.mjs';

process.exitCode = runMigrate(process.argv.slice(2));
