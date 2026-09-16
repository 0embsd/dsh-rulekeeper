# NOTICE —— 来源、许可与红线

本文件记录 dsh-rulekeeper 的**参考基线**与**致谢**，并写明硬红线。
**本项目的代码为自研**；下列项目只作**只读参考**（读思路、自己实现），**未复制任何代码、规则 JSON、夹具或 README 文案**。

## 1. 参考基线 R1–R6（立项时的对照物；只读）

| 编号 | 来源 | 许可状态 | 是否复用代码 |
|---|---|---|---|
| R1 | `jypjypjypjyp/dsh-guardrail`（GitHub） | **无 LICENSE**（GitHub API 实测 2026-09-15：`license` 字段为空）⇒ 按 §3 红线**禁复制任何内容** | 否 —— 只参考其"工具执行前 waterfall 拦截"的思路 |
| R2 | `loeanxi/dsh-injection-guard`（GitHub） | **无 LICENSE**（GitHub API 实测 2026-09-15）⇒ 禁复制 | 否 —— 只参考其"turn 级来源跟踪"的思路 |
| R3 | `@shion-lab/dsh-plugin-memory`（npm） | **MIT**（npm registry 实测：v0.3.2，源仓 `avaritiachaos/dsh-plugin-memory`） | 否 —— 只参考其记忆条目的组织方式 |
| R4 | `Taler97/dsh-rollback`（GitHub / dsh-plugin.org） | **MIT**（GitHub API 实测 2026-09-15）；**默认分支 `master`** —— 立项时"404"的根因是**分支名写错** | 否 —— 只参考"pre-image 快照 + 回滚"的概念 |
| R5 | 自有工具 `dsh-ssh-guard`（本机） | 自有 | 否 —— 只参考其装配线结构（upstream/patch/our） |
| R6 | 自有工具 `dsh-observation-pack`（本机） | 自有 | 否 —— 只参考其注册前自校验的做法 |

## 2. 致谢：借鉴了**机制思路**的项目（许可已按 GitHub API 实测标注）

| 项目 | 许可 | 借鉴的机制（自己实现） |
|---|---|---|
| `PerryLink/dsh-mask` | Apache-2.0 | 检测→占位符→统计只出计数；映射归约 |
| `KongFangXun/sofagent` | MIT | 规则库单一事实源 + **加载时样本自测**（漂移即抛错）；保留前后缀可核对 |
| `moonrunnerkc/swarm-orchestrator` | ISC | 按 key 名检测、幂等脱敏标记、诚实声明"known-pattern scrubbing" |
| `PerryLink/dsh-defend` | Apache-2.0 | 熵阈值降误报；审计事件只记类型不记原文 |
| OpenTelemetry Collector `redactionprocessor` | Apache-2.0 | allowlist fail-closed；低熵值用哈希而非裸存 |
| `mnemox-ai/tradememory-protocol` | MIT | 内容摘要 + 链式哈希，使"删原文"仍可核验 |
| `gitleaks` | MIT | 规则表 + allowlist 的组织方式（**仅思路**） |

> 以上**均为思路借鉴**，未复制其代码或文案。若将来需要引入任何第三方代码/数据，必须先在 `THIRD_PARTY.md` 登记来源与许可，并按下面的红线执行。

## 3. 硬红线（不是建议）

1. **无 LICENSE 或许可未核实的仓库**：禁止复制其**任何**文件、规则 JSON、夹具、README/文档文案；只能"读思路、自己实现"，并在此表登记。
2. **LGPL / AGPL / 无许可**：一律**不得**复制代码；如确需引用，改走"独立实现 + 登记机制来源"。
3. **MIT / ISC / BSD-3 / Apache-2.0**：可以借代码，但必须①在 `THIRD_PARTY.md` 登记②保留其版权与许可声明③Apache-2.0 需附 NOTICE。
4. **引入任何第三方依赖**：与本项目"零依赖（只用 `node:*`）"的定位冲突；如确需，必须走独立评审并在本文件说明理由。
5. **参考基线只是对照物**：不合并其代码；定期回看即可。

## 4. 本项目许可

MIT（见 `LICENSE`）。
