#!/usr/bin/env node
// rk-crossplat —— LF-2D0 跨平台验证（L1 结构 / L2 归一文本 / L3 同平台逐字；L3 跨平台不做）
import { runCrossplat } from '../src/cli.mjs';

process.exitCode = runCrossplat(process.argv.slice(2));
