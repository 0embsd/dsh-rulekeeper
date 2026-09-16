#!/usr/bin/env node
// dsh-rulekeeper · LF-160 对照实验：8 进程并发追加同一文件，三种实现对比
//
// 为什么用真进程：LF-160 的判据写的是"≥8 进程 x ≥250 行"。同进程 await 交错能证明丢更新
// （见 demo-rmw-loss），但**证明不了**"单次 write 在进程间不撕裂"——那必须真进程。
//
// 退出码契约（本脚本）：0 = 该实现通过校验（行数精确 + 无坏行 + 无超长 + 无截断尾）；1 = 校验失败；2 = 用法错误
// 用法: node scripts/atomicity-probe.mjs --impl atomic|segmented|overwrite [--workers 8] [--lines 250] [--dir <tmp>] [--keep]

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readLines } from '../src/append.mjs';
import { line, resultLine, write, writeErr } from '../src/platform/out.mjs';

const APPEND_URL = pathToFileURL(fileURLToPath(new URL('../src/append.mjs', import.meta.url))).href;

const WORKERS = {
  // 正例：单次 writeSync 写整行
  atomic: `import { appendLine } from ${JSON.stringify(APPEND_URL)};
const [file, lines, wid] = process.argv.slice(2);
for (let i = 0; i < Number(lines); i += 1) {
  const r = appendLine(file, { w: Number(wid), i });
  if (!r.ok) { process.exitCode = 1; break; }
}
`,
  // 反例一：把一行拆成 3 段写（并发下会被别的进程插进来 -> 行撕裂）
  segmented: `import { closeSync, openSync, writeSync } from 'node:fs';
const [file, lines, wid] = process.argv.slice(2);
for (let i = 0; i < Number(lines); i += 1) {
  const buf = Buffer.from(JSON.stringify({ w: Number(wid), i }) + '\\n', 'utf8');
  const fd = openSync(file, 'a');
  writeSync(fd, buf.subarray(0, 6));
  writeSync(fd, buf.subarray(6, 12));
  writeSync(fd, buf.subarray(12));
  closeSync(fd);
}
`,
  // 反例二：整文件读-改-写（丢更新）
  overwrite: `import { readFileSync, writeFileSync } from 'node:fs';
const [file, lines, wid] = process.argv.slice(2);
for (let i = 0; i < Number(lines); i += 1) {
  let arr = [];
  try { arr = JSON.parse(readFileSync(file, 'utf8')); } catch { arr = []; }
  arr.push({ w: Number(wid), i });
  writeFileSync(file, JSON.stringify(arr));
}
`,
};

function readFlag(argv, name, fallback) {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const value = argv[i + 1];
  if (value === undefined) throw new Error(`${name} 需要一个值`);
  return value;
}

function runWorker(scriptPath, file, lines, wid) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, file, String(lines), String(wid)], { stdio: 'ignore' });
    child.on('exit', (code) => resolve(code ?? -1));
    child.on('error', () => resolve(-1));
  });
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  write('用法: node scripts/atomicity-probe.mjs --impl atomic|segmented|overwrite [--workers N] [--lines M] [--dir D] [--keep]\n');
  process.exitCode = 0;
} else {
  const impl = readFlag(argv, '--impl', 'atomic');
  if (!Object.hasOwn(WORKERS, impl)) {
    writeErr(`未知 --impl: ${impl}（可选 ${Object.keys(WORKERS).join('|')}）\n`);
    process.exitCode = 2;
  } else {
    const workers = Number(readFlag(argv, '--workers', '8'));
    const lines = Number(readFlag(argv, '--lines', '250'));
    const dir = readFlag(argv, '--dir', join(tmpdir(), `lf-atomic-${Date.now()}`));
    const keep = argv.includes('--keep');
    mkdirSync(dir, { recursive: true });
    const scriptPath = join(dir, `worker-${impl}.mjs`);
    const target = join(dir, `out-${impl}.jsonl`);
    writeFileSync(scriptPath, WORKERS[impl], 'utf8');
    writeFileSync(target, '', 'utf8');

    const codes = await Promise.all(
      Array.from({ length: workers }, (_, wid) => runWorker(scriptPath, target, lines, wid)),
    );
    const report = readLines(target);
    const expected = workers * lines;
    const ok = report.values.length === expected && report.badLines === 0 && report.oversized === 0 && !report.truncatedTail;

    write(line(`IMPL=${impl}`));
    write(line(`WORKERS=${workers}`));
    write(line(`LINES_PER_WORKER=${lines}`));
    write(line(`EXPECTED=${expected}`));
    write(line(`OBSERVED_LINES=${report.values.length}`));
    write(line(`LOST=${expected - report.values.length}`));
    write(line(`BAD_LINES=${report.badLines}`));
    write(line(`OVERSIZED=${report.oversized}`));
    write(line(`TRUNCATED_TAIL=${report.truncatedTail}`));
    write(line(`WORKER_EXIT_CODES=${codes.join(',')}`));
    write(line(`TARGET=${target}`));
    write(resultLine('ATOMICITY', ok));
    if (!keep) rmSync(dir, { recursive: true, force: true });
    process.exitCode = ok ? 0 : 1;
  }
}
