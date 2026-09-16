#!/usr/bin/env node
// rk-backup 薄壳（逻辑在 src/cli.mjs；rc 契约见 src/rc.mjs）

import { runBackup } from '../src/cli.mjs';

process.exitCode = runBackup(process.argv.slice(2));
