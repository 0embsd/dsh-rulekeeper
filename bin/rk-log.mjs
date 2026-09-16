#!/usr/bin/env node
// rk-log 薄壳（逻辑在 src/cli.mjs；rc 契约见 src/rc.mjs）

import { runLog } from '../src/cli.mjs';

process.exitCode = runLog(process.argv.slice(2));
