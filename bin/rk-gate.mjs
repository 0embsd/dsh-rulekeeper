#!/usr/bin/env node
// rk-gate —— P5 真阻断（LF-530 写入侧对账；薄壳：逻辑在 src/cli.mjs 的 runGate）
import { runGate } from '../src/cli.mjs';

process.exitCode = runGate(process.argv.slice(2));
