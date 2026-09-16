#!/usr/bin/env node
// rk-shell-revert —— LF-830 降壳可反转 + 退役门槛（薄壳：逻辑在 src/cli.mjs 的 runShellRevert + src/shellrevert.mjs）
import { runShellRevert } from '../src/cli.mjs';

process.exitCode = runShellRevert(process.argv.slice(2));
