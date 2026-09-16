#!/usr/bin/env node
// rk-ledger 薄壳（逻辑在 src/cli.mjs；rc 契约见 src/rc.mjs）

import { runLedger } from '../src/cli.mjs';

process.exitCode = runLedger(process.argv.slice(2));
