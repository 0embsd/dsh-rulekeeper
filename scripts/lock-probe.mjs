#!/usr/bin/env node
// dsh-rulekeeper · LF-170 对照实验：8 进程受锁 RMW vs 无锁 RMW
//
// 退出码契约（本脚本）：0 = 计数精确（受锁应有此结果）；1 = 计数丢失；2 = 用法错误
// 用法: node scripts/lock-probe.mjs --mode locked|unlocked [--workers 8] [--iterations 100] [--dir <tmp>] [--keep]

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { line, resultLine, write, writeErr } from '../src/platform/out.mjs';

const LOCK_URL = pathToFileURL(fileURLToPath(new URL('../src/lock.mjs', import.meta.url))).href;

const WORKERS = {
  locked: `import { acquireLock, releaseLock } from ${JSON.stringify(LOCK_URL)};
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const [counter, lock, iterations, log] = process.argv.slice(2);
const diag = (m) => { try { appendFileSync(log, m + '\\n'); } catch {} };
for (let i = 0; i < Number(iterations); i += 1) {
  const h = acquireLock(lock, { timeoutMs: 20000, staleMs: 30000, retryMs: 5 });
  if (!h.ok) { diag('LOCK_FAIL i=' + i + ' stolen=' + h.stolen + ' reason=' + h.reason); process.exit(3); }
  try {
    const data = JSON.parse(readFileSync(counter, 'utf8'));
    data.count += 1;
    writeFileSync(counter, JSON.stringify(data));
  } catch (e) { diag('RMW_FAIL i=' + i + ' ' + e.message); process.exit(4); }
  finally {
    const rel = releaseLock(h);
    if (!rel.ok) diag('RELEASE_FAIL i=' + i + ' attempts=' + rel.attempts + ' ' + rel.reason);
  }
}
`,
  unlocked: `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const [counter, , iterations, log] = process.argv.slice(2);
for (let i = 0; i < Number(iterations); i += 1) {
  const data = JSON.parse(readFileSync(counter, 'utf8'));
  data.count += 1;
  writeFileSync(counter, JSON.stringify(data));
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

function runWorker(scriptPath, counter, lock, iterations, logPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, counter, lock, String(iterations), logPath], { stdio: 'ignore' });
    child.on('exit', (code) => resolve(code ?? -1));
    child.on('error', () => resolve(-1));
  });
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  write('用法: node scripts/lock-probe.mjs --mode locked|unlocked [--workers N] [--iterations M] [--dir D] [--keep]\n');
  process.exitCode = 0;
} else {
  const mode = readFlag(argv, '--mode', 'locked');
  if (!Object.hasOwn(WORKERS, mode)) {
    writeErr(`未知 --mode: ${mode}（可选 ${Object.keys(WORKERS).join('|')}）\n`);
    process.exitCode = 2;
  } else {
    const workers = Number(readFlag(argv, '--workers', '8'));
    const iterations = Number(readFlag(argv, '--iterations', '100'));
    const dir = readFlag(argv, '--dir', join(tmpdir(), `lf-lock-${Date.now()}`));
    const keep = argv.includes('--keep');
    mkdirSync(dir, { recursive: true });
    const scriptPath = join(dir, `worker-${mode}.mjs`);
    const counter = join(dir, 'counter.json');
    const lockPath = join(dir, 'counter.lock');
    writeFileSync(scriptPath, WORKERS[mode], 'utf8');
    writeFileSync(counter, JSON.stringify({ count: 0 }), 'utf8');

    const started = Date.now();
    const codes = await Promise.all(
      Array.from({ length: workers }, (_, wid) => runWorker(scriptPath, counter, lockPath, iterations, join(dir, `worker-${wid}.log`))),
    );
    const elapsedMs = Date.now() - started;
    // 诊断聚合：worker 的报错写文件（不用管道），父进程统一汇总——否则"看不见原因"（本轮实测教训）
    let diagText = '';
    for (const name of readdirSync(dir)) {
      if (name.startsWith('worker-') && name.endsWith('.log')) diagText += readFileSync(join(dir, name), 'utf8');
    }
    const diagLines = diagText.split('\n').filter((l) => l.trim() !== '');
    const countOf = (needle) => diagLines.filter((l) => l.startsWith(needle)).length;
    const expected = workers * iterations;
    const observed = JSON.parse(readFileSync(counter, 'utf8')).count;
    const ok = observed === expected;

    write(line(`MODE=${mode}`));
    write(line(`WORKERS=${workers}`));
    write(line(`ITERATIONS_PER_WORKER=${iterations}`));
    write(line(`EXPECTED=${expected}`));
    write(line(`OBSERVED=${observed}`));
    write(line(`LOST=${expected - observed}`));
    write(line(`LOST_PCT=${(((expected - observed) / expected) * 100).toFixed(1)}`));
    write(line(`ELAPSED_MS=${elapsedMs}`));
    write(line(`MS_PER_LOCK=${(elapsedMs / expected).toFixed(2)}`));
    write(line(`WORKER_EXIT_CODES=${codes.join(',')}`));
    write(line(`DIAG_LOCK_FAIL=${countOf('LOCK_FAIL')}`));
    write(line(`DIAG_RELEASE_FAIL=${countOf('RELEASE_FAIL')}`));
    write(line(`DIAG_RMW_FAIL=${countOf('RMW_FAIL')}`));
    write(line(`DIAG_SAMPLE=${diagLines.slice(0, 3).join(' | ') || '(无)'}`));
    write(resultLine('LOCKPROBE', ok));
    if (!keep) rmSync(dir, { recursive: true, force: true });
    process.exitCode = ok ? 0 : 1;
  }
}
