#!/usr/bin/env node
// rk-doctor 薄壳（逻辑在 src/cli.mjs；rc 契约见 src/rc.mjs）

import { runDoctor } from '../src/cli.mjs';

process.exitCode = runDoctor(process.argv.slice(2));
