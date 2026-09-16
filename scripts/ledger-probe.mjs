#!/usr/bin/env node
// dsh-rulekeeper · LF-200 对照实验：8 进程并发记账，两种实现对比（**同一判据**）
//
//   append-derive : 每个 worker 调 record()（只追加），父进程用 deriveCounts 派生计数
//   rmw-count     : 每个 worker 对 counts.json 做"整文件读-改-写"累加（原地更新聚合）
//
// 判据（两者共用）：**派生/记录的计数 == workers × perWorker**
//   -> append-derive 应通过；rmw-count 应失败（丢更新）。这样"禁原地更新"就不是口号而是可复现结论。
//
// 退出码契约（本脚本）：0 = 该实现满足判据；1 = 不满足；2 = 用法错误
// 用法: node scripts/ledger-probe.mjs --mode append-derive|rmw-count [--workers 8] [--per-worker 50] [--dir D] [--keep]

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { deriveCounts, readLedger } from '../src/ledger.mjs';
import { line, resultLine, write, writeErr } from '../src/platform/out.mjs';

const LEDGER_URL = pathToFileURL(fileURLToPath(new URL('../src/ledger.mjs', import.meta.url))).href;
const RULE = 'L900';

const WORKERS = {
  'append-derive': `import { record } from ${JSON.stringify(LEDGER_URL)};
import { appendFileSync } from 'node:fs';
const [landing, perWorker, wid, log] = process.argv.slice(2);
const diag = (m) => { try { appendFileSync(log, m + '\\n'); } catch {} };
for (let i = 0; i < Number(perWorker); i += 1) {
  const r = record({
    rule: '${RULE}', category: '实验', problem: 'p' + wid + '-' + i, root_cause: 'r', solution: 's',
    mechanism: 'text', id: 'LF-PROBE-' + wid + '-' + i,
  }, { landingDir: landing });
  if (!r.ok) { diag('RECORD_FAIL i=' + i + ' reason=' + r.reason); process.exit(3); }
}
`,
  'rmw-count': `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [landing, perWorker, wid, log] = process.argv.slice(2);
const diag = (m) => { try { appendFileSync(log, m + '\\n'); } catch {} };
const countsFile = join(landing, 'counts.json');
for (let i = 0; i < Number(perWorker); i += 1) {
  // 反例：整文件读-改-写累加聚合（正是 LF-120 禁止的形态）
  let data = {};
  try { data = JSON.parse(readFileSync(countsFile, 'utf8')); } catch { data = {}; }
  data['${RULE}'] = (data['${RULE}'] || 0) + 1;
  writeFileSync(countsFile, JSON.stringify(data));
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

function runWorker(scriptPath, landing, perWorker, wid, logPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, landing, String(perWorker), String(wid), logPath], { stdio: 'ignore' });
    child.on('exit', (code) => resolve(code ?? -1));
    child.on('error', () => resolve(-1));
  });
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  write('用法: node scripts/ledger-probe.mjs --mode append-derive|rmw-count [--workers N] [--per-worker M] [--dir D] [--keep]\n');
  process.exitCode = 0;
} else {
  const mode = readFlag(argv, '--mode', 'append-derive');
  if (!Object.hasOwn(WORKERS, mode)) {
    writeErr(`未知 --mode: ${mode}（可选 ${Object.keys(WORKERS).join('|')}）\n`);
    process.exitCode = 2;
  } else {
    const workers = Number(readFlag(argv, '--workers', '8'));
    const perWorker = Number(readFlag(argv, '--per-worker', '50'));
    const landing = readFlag(argv, '--dir', join(tmpdir(), `rk-ledger-${Date.now()}`));
    const keep = argv.includes('--keep');
    mkdirSync(landing, { recursive: true });
    const scriptPath = join(landing, `worker-${mode}.mjs`);
    writeFileSync(scriptPath, WORKERS[mode], 'utf8');

    const started = Date.now();
    const codes = await Promise.all(
      Array.from({ length: workers }, (_, wid) => runWorker(scriptPath, landing, perWorker, wid, join(landing, `worker-${wid}.log`))),
    );
    const elapsedMs = Date.now() - started;

    let diagText = '';
    for (const name of readdirSync(landing)) {
      if (name.startsWith('worker-') && name.endsWith('.log')) diagText += readFileSync(join(landing, name), 'utf8');
    }
    const diagLines = diagText.split('\n').filter((l) => l.trim() !== '');

    const expected = workers * perWorker;
    let observed;
    let extra;
    if (mode === 'append-derive') {
      const read = readLedger(landing);
      observed = deriveCounts(read.values).get(RULE)?.count ?? 0;
      extra = { rows: read.values.length, badLines: read.badLines, truncatedTail: read.truncatedTail };
    } else {
      let counts = {};
      try {
        counts = JSON.parse(readFileSync(join(landing, 'counts.json'), 'utf8'));
      } catch {
        counts = {};
      }
      observed = counts[RULE] ?? 0;
      extra = { counter_file: 'counts.json' };
    }
    const ok = observed === expected;

    write(line(`MODE=${mode}`));
    write(line(`RULE=${RULE}`));
    write(line(`WORKERS=${workers}`));
    write(line(`PER_WORKER=${perWorker}`));
    write(line(`EXPECTED=${expected}`));
    write(line(`OBSERVED=${observed}`));
    write(line(`LOST=${expected - observed}`));
    write(line(`LOST_PCT=${(((expected - observed) / expected) * 100).toFixed(1)}`));
    write(line(`ELAPSED_MS=${elapsedMs}`));
    write(line(`WORKER_EXIT_CODES=${codes.join(',')}`));
    write(line(`DIAG_LINES=${diagLines.length}`));
    for (const [k, v] of Object.entries(extra)) write(line(`${k.toUpperCase()}=${v}`));
    write(line(`LANDING=${landing}`));
    write(resultLine('LEDGER_PROBE', ok));
    if (!keep) rmSync(landing, { recursive: true, force: true });
    process.exitCode = ok ? 0 : 1;
  }
}
