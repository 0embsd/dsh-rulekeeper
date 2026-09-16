#!/usr/bin/env node
// rk-rules 薄壳（逻辑在 src/cli.mjs；rc 契约见 src/rc.mjs）

import { runRules } from '../src/cli.mjs';

process.exitCode = runRules(process.argv.slice(2));
