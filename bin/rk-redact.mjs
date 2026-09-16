#!/usr/bin/env node
// rk-redact —— LF-340 脱敏（薄壳：逻辑在 src/cli.mjs 的 runRedact）
import { runRedact } from '../src/cli.mjs';

process.exitCode = runRedact(process.argv.slice(2));
