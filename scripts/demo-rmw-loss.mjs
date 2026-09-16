// dsh-rulekeeper · LF-120 证据脚本：复现"整文件读-改-写聚合"的丢计数（禁原地更新的实证）
//
// 为什么要有它：schema 里把 recurrence/status 定为**派生**而不是原地更新，理由是实测
// 「整文件 RMW 在并发下丢更新」。本脚本把这个理由做成可复跑的对照实验：
//   反例（RMW）：N 个 worker 各自 readFileSync → +1 → writeFileSync，期望 N*M，实际明显偏少
//   正例（append）：N 个 worker 各自 appendFileSync 一行，最后按行计数，期望 N*M，实际精确
//
// 退出码契约（本脚本）：0 = **反例确实丢 + 正例确实准**（判据成立）；1 = 反例没丢（假设被推翻，需重估）；2 = 用法错误
// 用法: node scripts/demo-rmw-loss.mjs [--workers 6] [--iterations 150] [--dir <临时目录>]

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { line, resultLine, write, writeErr } from '../src/platform/out.mjs';

function readFlag(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`${name} 需要一个值`);
  return value;
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  write('用法: node scripts/demo-rmw-loss.mjs [--workers N] [--iterations M] [--dir <dir>]\n');
  process.exitCode = 0;
} else {
  const workers = Number(readFlag(argv, '--workers', '6'));
  const iterations = Number(readFlag(argv, '--iterations', '150'));
  const base = readFlag(argv, '--dir', join(tmpdir(), `lf-rmw-${Date.now()}`));
  if (!Number.isInteger(workers) || workers < 2 || !Number.isInteger(iterations) || iterations < 1) {
    writeErr('参数非法：--workers>=2、--iterations>=1\n');
    process.exitCode = 2;
  } else {
    mkdirSync(base, { recursive: true });
    const expected = workers * iterations;

    // ── 反例：整文件读-改-写 ───────────────────────────────────────
    const rmwFile = join(base, 'counter.json');
    writeFileSync(rmwFile, JSON.stringify({ count: 0 }), 'utf8');
    const yieldLoop = () => new Promise((r) => setImmediate(r));
    await Promise.all(
      Array.from({ length: workers }, async () => {
        for (let i = 0; i < iterations; i += 1) {
          const data = JSON.parse(readFileSync(rmwFile, 'utf8'));
          await yieldLoop(); // 让出事件循环，制造交错（真实并发的等价物）
          data.count += 1;
          writeFileSync(rmwFile, JSON.stringify(data), 'utf8');
        }
      }),
    );
    const rmwObserved = JSON.parse(readFileSync(rmwFile, 'utf8')).count;

    // ── 正例：append 一行一条 + 按行派生 ───────────────────────────
    const appendFile = join(base, 'events.jsonl');
    writeFileSync(appendFile, '', 'utf8');
    await Promise.all(
      Array.from({ length: workers }, async () => {
        for (let i = 0; i < iterations; i += 1) {
          appendFileSync(appendFile, `${JSON.stringify({ ts: '2026-09-14T00:00:00.000Z' })}\n`, 'utf8');
          await yieldLoop();
        }
      }),
    );
    const appendObserved = readFileSync(appendFile, 'utf8').split('\n').filter((l) => l.trim() !== '').length;

    const lost = expected - rmwObserved;
    const lostPct = ((lost / expected) * 100).toFixed(1);
    write(line(`RMW_FILE=${rmwFile}`));
    write(line(`APPEND_FILE=${appendFile}`));
    write(line(`EXPECTED=${expected}`));
    write(line(`RMW_OBSERVED=${rmwObserved}`));
    write(line(`RMW_LOST=${lost}`));
    write(line(`RMW_LOST_PCT=${lostPct}`));
    write(line(`APPEND_OBSERVED=${appendObserved}`));
    write(line(`APPEND_EXACT=${appendObserved === expected}`));
    const ok = lost > 0 && appendObserved === expected;
    write(resultLine('RMW_DEMO', ok));
    if (existsSync(base)) rmSync(base, { recursive: true, force: true });
    process.exitCode = ok ? 0 : 1;
  }
}
