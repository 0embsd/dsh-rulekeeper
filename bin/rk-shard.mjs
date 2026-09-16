#!/usr/bin/env node
// rk-shard —— LF-2C0 账本分片 + gc + 引用完整性（薄壳：逻辑在 src/cli.mjs 的 runShard）
import { runShard } from '../src/cli.mjs';

process.exitCode = runShard(process.argv.slice(2));
