#!/usr/bin/env node
// rk-replay —— LF-270 历史缺陷回放（薄壳：逻辑在 src/cli.mjs 的 runReplay）
import { runReplay } from '../src/cli.mjs';

process.exitCode = runReplay(process.argv.slice(2));
