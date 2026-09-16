# test/fixtures —— 固定正/反样本（LF-150）

| 文件 | 用途 | 期望判定 |
|---|---|---|
| `package-ok.json` | 骨架 package.json 合规样本 | 绿（无 finding） |
| `package-bad-deps.json` | 含 `dependencies: left-pad` | 红 `S1_DEPENDENCIES` |
| `config-ok.json` | 落点 config 合规样本 | 绿 |
| `config-bad-mode.json` | `mode: "yolo"` 非法档位 | 红 `S3_CONFIG_INVALID` |
| `imports-ok.mjs.txt` | 合规导入样本（含注释/字符串/正则里的 `require(` 干扰项） | 绿 |
| `imports-bad.mjs.txt` | 一条裸导入 + 一条 `require('left-pad')` | 红 `S4_BARE_IMPORT` + `S4_CJS_REQUIRE` |
| `rules-ok.json` | rules 规则包合规样本（LF-120 冻结 6 字段齐全） | 绿（`lf-rules check` exit 0） |
| `rules-missing-project.json` | 缺 `project` 字段 | 红：exit≠0 且 stderr 逐字含 `missing field: project` |
| `checks/untracked-ok/*` | 文件 + 记录了其当前 sha256 的 `snapshots/index.jsonl` | 绿：`file_untracked_change` pass |
| `checks/untracked-violation/target.txt` | 同内容但**无快照记录** | 红：`UNTRACKED_CHANGE_NO_SNAPSHOT` |
| `checks/output-shape-ok.txt` | 有结果行、无超长行 | 绿：`output_shape` pass |
| `checks/output-shape-violation.txt` | 缺结果行 + 120 字符超长行 | 红：`SHAPE_RESULT_LINE_MISSING` + `SHAPE_LINE_TOO_LONG` |
| `checks/invalid-reference-ok.md` | `§1/§2` 有对应标题；`output-shape-ok.txt:2` 行号在范围内 | 绿：`invalid_reference` pass |
| `checks/invalid-reference-violation.md` | `ghost.md:5`（文件不存在）/ `…:9999`（越界）/ `§9`（无标题） | 红：`REF_FILE_NOT_FOUND` + `REF_LINE_OUT_OF_RANGE` + `REF_SECTION_NOT_FOUND` |
| `expected/<name>.json`（6 份） | LF-250 的**逐字基准**：判决 JSON 的冻结快照 | 判据：实际输出 `===` 基准；**缺基准即红**（`compareWithExpected`） |

## 基准（`expected/`）的维护规则

- **唯一再生成入口**：`node scripts/gen-expected.mjs`（`--check` 只比对不写盘，供门禁用）。
  基准必须由**判决输出本身**生成，手改基准 = 改判据。
- 用例表的唯一来源是 `test/helpers/check-cases.mjs`：判据（`test/checks.test.mjs`）与再生成器
  共用同一张表，避免"基准"和"判据"各自漂移。
- 基准文件必须是 **纯 LF、无 BOM**：曾用 PowerShell `Out-File` 生成 → 全文件 CRLF，
  肉眼完全看不出而逐字比对全红（教训已入清单 §0.1）。用例里有专门的 CR/LF 断言守着这条。

## 为什么用 `.mjs.txt` 这种扩展名

`node --test`（Node 22+）默认把 **`test/` 目录下所有 `.js/.mjs/.cjs`** 当作测试文件加载。
若把违规样本写成 `.mjs`，跑测试时 Node 会先尝试加载它（裸导入 → `ERR_MODULE_NOT_FOUND`），
整个测试运行就失败了。这些 fixture 的**文本**是被检查器按源码扫描的，扩展名不影响扫描结果，
故统一加 `.txt`。真正需要被 import 的助手放在 `test/helpers/*.mjs`（无 `test()` 调用，
会以"0 用例文件"出现在测试摘要里，属预期）。
