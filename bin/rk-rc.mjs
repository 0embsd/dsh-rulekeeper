#!/usr/bin/env node
// rk-rc 薄壳（逻辑在 src/cli.mjs；rc 契约见 src/rc.mjs）

import { runRc } from '../src/cli.mjs';

process.exitCode = runRc(process.argv.slice(2));
