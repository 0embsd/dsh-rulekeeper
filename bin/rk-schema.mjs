#!/usr/bin/env node
// rk-schema 薄壳（逻辑在 src/cli.mjs；rc 契约见 src/rc.mjs）

import { runSchema } from '../src/cli.mjs';

process.exitCode = runSchema(process.argv.slice(2));
