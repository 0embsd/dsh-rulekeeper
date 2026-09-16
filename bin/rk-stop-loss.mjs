#!/usr/bin/env node
// rk-stop-loss —— LF-820 止损 Runbook（薄壳：逻辑在 src/cli.mjs 的 runStopLoss + src/stoploss.mjs）
import { runStopLoss } from '../src/cli.mjs';

process.exitCode = runStopLoss(process.argv.slice(2));
