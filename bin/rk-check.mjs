#!/usr/bin/env node
// rk-check 薄壳（逻辑在 src/cli.mjs；rc 契约见 src/rc.mjs）
// LF-250 三类可机检 check：untracked-change / output-shape / invalid-reference
// LF-260 形态守卫：shape

import { runCheck } from '../src/cli.mjs';

process.exitCode = runCheck(process.argv.slice(2));
