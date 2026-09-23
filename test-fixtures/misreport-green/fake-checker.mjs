// 夹具用的假检查器：**行为由样本目录内容决定**，让"红/绿两跑"都能被验证器驱动。
//   · 样本目录里存在 `FAIL` 文件 ⇒ exit 1（命中红）
//   · 否则 ⇒ exit 0（合规）
// 这样同一个命令在"红样本树"与"绿样本树"上给出**不同结论**，才能满足验证器的"反事实唯一性"判据。
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.RULEKEEPER_SAMPLE_DIR ?? process.cwd();
const shouldFail = existsSync(join(root, 'FAIL'));
console.log(`FIXTURE_CHECKER sample=${root.split('\\').join('/')} verdict=${shouldFail ? 'red' : 'green'}`);
process.exit(shouldFail ? 1 : 0);
