#!/usr/bin/env node
// rk-baseline —— LF-2B0 首次启用基线 + 账本自污染防护（薄壳：逻辑在 src/cli.mjs 的 runBaseline）
import { runBaseline } from '../src/cli.mjs';

process.exitCode = runBaseline(process.argv.slice(2));
