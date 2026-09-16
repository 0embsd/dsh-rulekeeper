#!/usr/bin/env node
// rk-snap —— LF-300 pre-image 快照 / LF-310 restore / LF-320 快照↔账本对账（薄壳：逻辑在 src/cli.mjs 的 runSnap）
import { runSnap } from '../src/cli.mjs';

process.exitCode = runSnap(process.argv.slice(2));
