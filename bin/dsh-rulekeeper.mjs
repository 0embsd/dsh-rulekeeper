#!/usr/bin/env node
// dsh-rulekeeper CLI 薄壳（逻辑在 src/cli.mjs，rc 由返回值决定）
// 退出码契约见 src/rc.mjs（唯一权威源）

import { runRulekeeper } from '../src/cli.mjs';

process.exitCode = runRulekeeper(process.argv.slice(2));
