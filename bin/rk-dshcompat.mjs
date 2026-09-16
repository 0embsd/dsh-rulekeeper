#!/usr/bin/env node
// rk-dshcompat —— LF-920 DSH 升级兼容门（宿主环境探针；薄壳：逻辑在 src/dshcompat.mjs）
//
// 用法: rk-dshcompat [--dsh-root <DSH 安装根>] [--json] [--max-files <n>] [--help]
// 退出码: 0 探针 pass / 1 任一用例 fail（契约漂了或宿主缺件）/ 2 用法错误
import { dshCompatProbe, defaultDshRoot } from '../src/dshcompat.mjs';

const USAGE = `用法: rk-dshcompat [--dsh-root <DSH 安装根>] [--json] [--max-files <n>] [--help]
说明: LF-920 —— 记录 dsh/cordis/dsh-tools 三版本 + 探测宿主契约 token（事件名 / API 形态）。
      默认安装根: win32=%APPDATA%/npm/node_modules/@deepseek-ai/dsh；POSIX 常见全局路径。
退出码: 0 pass / 1 fail / 2 用法错误`;

const argv = process.argv.slice(2);
const get = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : undefined;
};
if (argv.includes('--help')) {
  process.stdout.write(`${USAGE}\n`);
  process.exitCode = 0;
} else if (argv.some((a) => a.startsWith('--') && !['--dsh-root', '--json', '--max-files', '--help'].includes(a))) {
  process.stderr.write(`rk-dshcompat: 未知参数\n${USAGE}\n`);
  process.exitCode = 2;
} else {
  const root = get('--dsh-root') ?? defaultDshRoot();
  const maxFiles = get('--max-files') === undefined ? 20000 : Number(get('--max-files'));
  if (!Number.isInteger(maxFiles) || maxFiles <= 0) {
    process.stderr.write(`rk-dshcompat: --max-files 需要正整数\n${USAGE}\n`);
    process.exitCode = 2;
  } else {
    const r = dshCompatProbe({ dshRoot: root, maxFiles });
    const json = argv.includes('--json');
    if (json) {
      process.stdout.write(`${JSON.stringify({
        ok: r.ok,
        versions: r.versions,
        dshRootName: typeof root === 'string' ? root.split(/[\\/]/).slice(-2).join('/') : String(root), // ㉒ 不落绝对路径
        cases: r.cases,
        scanned: r.scanned,
      }, null, 2)}\n`);
    } else {
      process.stdout.write(`RK_DSHCOMPAT_DSH=${r.versions?.dsh?.version ?? '(none)'}\n`);
      process.stdout.write(`RK_DSHCOMPAT_CORDIS=${r.versions?.cordis?.version ?? '(none)'}\n`);
      process.stdout.write(`RK_DSHCOMPAT_DSH_TOOLS=${r.versions?.dshTools?.version ?? '(none)'}\n`);
      process.stdout.write(`RK_DSHCOMPAT_NODE=${r.versions?.node ?? '(none)'}\n`);
      process.stdout.write(`RK_DSHCOMPAT_SCANNED=${r.scanned}\n`);
      for (const c of r.cases) process.stdout.write(`CASE ${c.ok ? 'ok' : 'FAIL'} ${c.name} :: ${c.detail}\n`);
      process.stdout.write(`RK_DSHCOMPAT_RESULT=${r.ok ? 'pass' : 'fail'}\n`);
    }
    process.exitCode = r.ok ? 0 : 1;
  }
}
