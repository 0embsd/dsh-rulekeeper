// dsh-rulekeeper · LF-120 schema v1 冻结单（**数据的唯一权威源**）
//
// 为什么把 schema 写成数据而不是文档：文档会漂移，代码不会。SCHEMA.md 由本文件
// **生成**（`rk-schema --write-md`），并有 `--check` 比对文档与生成结果是否逐字一致
// —— 手改文档会被判红（SCHEMA_DOC_DRIFT）。
//
// 本文件冻结三件事：
//   ① 6 个数据文件的**逐文件字段表**（含类型/必填/唯一）
//   ② 每个文件的**版本字段**（ledger 与 rules 对称带 schema）
//   ③ **可变聚合字段的派生规则**（禁原地更新）——来历：实测"整文件读-改-写"计数在
//      并发下丢失（见 scripts/demo-rmw-loss.mjs 与 LF-120 凭证）
//
// 归属：core 模块。零依赖：只用 node:*。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SCHEMA_VERSION = 1;
export const FIELD_TYPES = Object.freeze([
  'string', 'number', 'boolean', 'array', 'object', 'iso8601', 'sha256', 'enum',
]);

/** plan §3 的 ledger 13 字段（逐字，用于机读比对） */
export const LEDGER_PLAN_FIELDS = Object.freeze([
  'id', 'ts', 'rule', 'category', 'problem', 'root_cause', 'solution', 'evidence',
  'mechanism', 'recurrence', 'first_seen', 'last_seen', 'status',
]);

/** 6 个数据文件（**冻结**；新增文件 = 走 §9.8 式契约变更，需同步全部消费方） */
export const FILES = Object.freeze([
  {
    name: 'ledger.jsonl',
    kind: 'append-only',
    versionField: 'schema',
    purpose: '教训/纪律账本：一行一条事实记录',
    fields: [
      { name: 'schema', type: 'number', required: true, note: '每行都带（与 rules.json 对称）' },
      { name: 'id', type: 'string', required: true, unique: true, note: '如 L412 / LF-140；全局唯一' },
      { name: 'ts', type: 'iso8601', required: true },
      { name: 'rule', type: 'string', required: true, note: '对应哪条纪律/规则；去重键之一' },
      { name: 'category', type: 'string', required: true },
      { name: 'problem', type: 'string', required: true },
      { name: 'root_cause', type: 'string', required: true },
      { name: 'solution', type: 'string', required: true },
      { name: 'evidence', type: 'array', required: true, note: '凭证路径列表（字符串数组）' },
      { name: 'mechanism', type: 'string', required: true, note: 'text | mechanized | uncheckable(+理由)' },
      // ↓ 注意口径（2026-09-19 更正）：`mutable` 描述的是**该字段的语义要派生着读**，
      //   而**行里写下的**是写入那一刻的单行事实（`recurrence` 恒 1、`first_seen`/`last_seen` 恒 = 本行 ts）。
      //   旧 note 写"派生：同 rule 行数"会被读成"行内字段就是聚合" ⇒ 直接读恒得 1（E3 仿真发现的口径矛盾）。
      { name: 'recurrence', type: 'number', required: true, mutable: true, note: '**行内恒为 1**（写入时单行事实）；同 rule 行数须派生（recurrenceOf()/summary），读行内字段恒得 1' },
      { name: 'first_seen', type: 'iso8601', required: true, mutable: true, note: '**行内 = 本行 ts**（写入时事实）；同 rule 最早 ts 须派生' },
      { name: 'last_seen', type: 'iso8601', required: true, mutable: true, note: '**行内 = 本行 ts**（写入时事实）；同 rule 最晚 ts 须派生' },
      { name: 'status', type: 'enum', required: true, mutable: true, values: ['active', 'superseded', 'archived'], note: '**行内 = 写入时状态**（导入的历史行可出生即 superseded，故无常数不变式）；后续迁移按状态事件行 fold，禁原地改写' },
      // P0-2（2026-09-19）：**可判激活条件**（可选）。生效语义过去只挂类目层（`rule` 标签），
      // 而类目只是分组标签 ⇒ TEXT_ONLY 21/22 是结构必然；现把"何时适用"挂到**条目**上，
      // 体检报 RK_EFFECT_ENTRY_ACTIVATION / _COVERAGE（判据见 effect.mjs 的 activationOf()）。
      // 可选：缺失/空白/占位符一律视为"没有条件"（不改旧行形状）。
      { name: 'activation', type: 'string', required: false, note: '可判激活条件：一句话说明在什么**可观测**条件下这条纪律适用/该被想起/该被判红（须可机械判定；占位符不算）' },
    ],
    derived: [
      { field: 'recurrence', rule: 'scan:count-rows-with-same-rule', note: '禁原地更新' },
      { field: 'first_seen', rule: 'scan:min-ts-of-same-rule' },
      { field: 'last_seen', rule: 'scan:max-ts-of-same-rule' },
      { field: 'status', rule: 'event:fold-status-events', note: '状态迁移写事件行，不覆写历史行' },
    ],
    // **显式扩展位**（2026-09-19 引入）：计划 §3 的 13 字段是**基线契约**（不得改），
    // 新增字段只能走这里登记，且**必须是可选**（required:false —— 加法不得破坏既有行形状）。
    // 机检：checkSchema 会断言每个扩展字段在 fields 里存在且非必填（SCHEMA_EXTENSION_*）。
    extensions: ['activation'],
    dedupeKey: ['rule', 'target', 'sha256'],
  },
  {
    name: 'rules.json',
    kind: 'json',
    versionField: 'schema',
    purpose: '项目声明的规则包（被 protect/check/plugin/cli 全域消费，**单点权威**）',
    fields: [
      { name: 'schema', type: 'number', required: true },
      { name: 'project', type: 'string', required: true, note: '双本（项目级/用户级）的判别依据（Q3）' },
      { name: 'protected_paths', type: 'array', required: true, note: '受保护路径；由 rules.isProtected() **单点**判定' },
      { name: 'gates', type: 'array', required: true, note: 'gateName / 凭证路径 / 严格档' },
      { name: 'checks', type: 'array', required: true, note: '三种可机检类型（见下）；条目可为裸字符串（旧形态）或**生效绑定对象** `{kind, rule, carrier, falsePositive?, gate?, proposal?, activatedAt?, notes?}`（LF-A*：把"哪条纪律靠哪个判据拦"变成可机检数据，无 carrier 即无法验证）' },
      { name: 'inject', type: 'array', required: true, note: '注入模板（白名单字段）' },
    ],
    derived: [],
    checks: ['file_untracked_change', 'output_shape', 'invalid_reference'],
  },
  {
    name: 'snapshots/index.jsonl',
    kind: 'append-only',
    versionField: 'schema',
    purpose: 'pre-image 快照索引（path 形式一律 pathKey 归一，作为 protect↔detect 的显式契约）',
    fields: [
      { name: 'schema', type: 'number', required: true },
      { name: 'ts', type: 'iso8601', required: true },
      { name: 'path', type: 'string', required: true, note: '**pathKey** 形式（posix + 折叠大小写）' },
      { name: 'sha256_before', type: 'sha256', required: true },
      { name: 'sha256_after', type: 'sha256', required: false },
      { name: 'sha256_lf', type: 'sha256', required: false, note: '**行尾归一形态**（CRLF→LF）的 sha256：仅文本文件（二进制为 null）；供 core.autocrlf=true 时跨形态比对（G3）' },
      { name: 'backup', type: 'string', required: true, note: '备份文件相对项目根路径' },
      { name: 'why', type: 'string', required: true },
      { name: 'job', type: 'string', required: false },
    ],
    derived: [],
  },
  {
    name: 'findings.jsonl',
    kind: 'append-only',
    versionField: 'schema',
    purpose: '观测流：一次判定一条（**不是**诊断日志；诊断日志见 LF-1A0 的 dsh-rulekeeper.log）',
    fields: [
      { name: 'schema', type: 'number', required: true },
      { name: 'ts', type: 'iso8601', required: true },
      { name: 'rule', type: 'string', required: true },
      { name: 'severity', type: 'enum', required: true, values: ['info', 'warn', 'error'] },
      { name: 'target', type: 'string', required: true },
      { name: 'evidence', type: 'array', required: true },
      { name: 'action', type: 'enum', required: true, values: ['observe', 'deny', 'warn'] },
    ],
    derived: [],
  },
  // **第 7 个文件（2026-09-19 契约变更）**：注解层 —— 给既有 append-only 行补 `activation` 的合法通路。
  // 来历：账本行不可原地改写，而 activation 是行内字段 ⇒ 想给 385 条既有教训补"何时适用"，
  //   改行=违宪、复制新行=制造重复（E2 实测重复会把正确教训挤出 top-1）。故用 sidecar 注解层：
  //   账本逐字节不动，注解单独 append，读侧合并（`annotations.mergeActivation`）。
  // 同步面（契约变更必须同步全部消费方）：本冻结单（6→7）、`annotations.mjs`、`doctor` 健康检查、
  //   `baseline` 的自产物清单、`effect` 的覆盖率口径。
  {
    name: 'activations.jsonl',
    kind: 'append-only',
    versionField: 'schema',
    purpose: '条目级注解流：`id` 指向账本行，携带"可判激活条件"；账本保持 append-only 不被改写',
    fields: [
      { name: 'schema', type: 'number', required: true },
      { name: 'ts', type: 'iso8601', required: true },
      { name: 'id', type: 'string', required: true, note: '指向 ledger.jsonl 的 id（孤儿注解由 doctor 报 DOCTOR_ANNOTATION_ORPHAN）' },
      { name: 'activation', type: 'string', required: true, note: '可判激活条件；必须含可观测锚点（路径/通配符/命令/错误串），判据见 annotations.validateActivation()' },
      { name: 'by', type: 'enum', required: true, values: ['machine', 'human'], note: '**声明**不是签名（规则 43）' },
      { name: 'confidence', type: 'string', required: false, note: '起草置信度（machine 起草时给出，供人优先复核低置信项）' },
      { name: 'evidence', type: 'array', required: true },
    ],
    derived: [],
  },
  {
    name: 'config.json',
    kind: 'json',
    versionField: 'schema',
    purpose: '运行时覆盖层（落在两处落点各一份；已存在的**不被覆盖**）',
    fields: [
      { name: 'schema', type: 'number', required: true },
      { name: 'mode', type: 'enum', required: true, values: ['observe', 'armed', 'off'] },
      { name: 'protected_paths', type: 'array', required: false },
      { name: 'ledgerPath', type: 'string', required: false },
      { name: 'maxInjectChars', type: 'number', required: false },
      // 锚定式人签字（2026-09-19 契约扩展位）：true ⇒ rules.json 的写入必须带"问过真人"的凭证，
      // `--by human` 这种字符串声明一律拒（规则 43 的同族落地）。缺省 = 不要求（保持既有落点行为不变）。
      { name: 'requireAnchoredApproval', type: 'boolean', required: false, note: 'true ⇒ 无锚定人签字凭证时拒绝写 rules.json（凭证由插件工具 rulekeeper_apply 经 ctx.userQuestions 取得）' },
    ],
    derived: [],
    extensions: ['requireAnchoredApproval'],
  },
  {
    name: 'proposals/<id>.json',
    kind: 'json',
    versionField: 'schema',
    purpose: '自进化提案（**闸先于写者**：evolve 只产提案，绝不直接写 rules.json）',
    fields: [
      { name: 'schema', type: 'number', required: true },
      { name: 'id', type: 'string', required: true, unique: true },
      { name: 'rule', type: 'string', required: true },
      { name: 'source', type: 'enum', required: true, values: ['auto', 'human'] },
      { name: 'createdAt', type: 'iso8601', required: true },
      { name: 'redCriteria', type: 'string', required: true, note: '提案必须自带红态判据' },
      { name: 'counterExample', type: 'string', required: true, note: '反例样本 ≥1' },
      { name: 'falsePositiveSurface', type: 'string', required: true, note: '误报面' },
      { name: 'activationCheck', type: 'string', required: true, note: '生效验证方式' },
      { name: 'status', type: 'enum', required: true, values: ['proposed', 'approved', 'rejected'] },
      {
        name: 'supersedes',
        type: 'object',
        required: false,
        note: '换绑声明（与 redCriteria 里的 EFFECT_SUPERSEDE 标记配套）：`{ spec?, carrier?, reason }`。'
          + '点名"要换掉哪一个已有绑定"以及理由 —— 同一纪律允许多条绑定，不点名就可能换错对象（且是静默的）。'
          + '只有"该纪律已有一条同 kind 绑定、而判据本身演进"时才需要；缺失或点名对不上 ⇒ 拒绝落盘。',
      },
    ],
    derived: [],
  },
]);

const REQUIRED_PLAN_FIELDS = Object.freeze({
  'ledger.jsonl': LEDGER_PLAN_FIELDS,
  'rules.json': ['schema', 'project', 'protected_paths', 'gates', 'checks', 'inject'],
});

/**
 * 冻结的文件名集合 —— **必须是字面量，禁止从 FILES 派生**。
 * 【2026-09-14 自曝】初版写成 `FILES.map(f => f.name)`，等于拿自己校验自己：
 * 把 findings.jsonl 改名后，校验集合也跟着改名 -> 检查恒真（R1 变异测试当场抓出）。
 */
export const FROZEN_FILE_NAMES = Object.freeze([
  'ledger.jsonl',
  'rules.json',
  'snapshots/index.jsonl',
  'findings.jsonl',
  'activations.jsonl',
  'config.json',
  'proposals/<id>.json',
]);

/**
 * ledger 行的**写入时不变式** —— 把"行内字段不是聚合值"从注释变成**可机检数据**。
 *
 * 来历（2026-09-19，E3 治理仿真发现的口径矛盾）：落点 `ledger.jsonl` 实测 **388 行里
 * `recurrence` 全为 1**，而本文件旧 note 写的是"派生：同 rule 行数" ⇒ 两条读法互相矛盾，
 * 任何"引用该字段当复发次数"的数字都不可信。实测同时确认 `first_seen`/`last_seen` 各 388 行
 * 都等于本行 `ts`；`status` 则是 active 374 + superseded 14（导入的历史行**出生即 superseded**），
 * 故 **status 不做常数不变式**（做了就是假红）。
 *
 * 为什么要有机械面：单纯改注释只治"读文档的人"，治不了"读字段的代码"。消费方：
 * `doctor()` 逐行核对（违反 → `DOCTOR_<code>`），SCHEMA.md 由本常量渲染出对照表（防文档漂移）。
 *
 * 判据分级理由：`recurrence ≠ 1` 只可能是**把聚合写进了 append-only 行**（LF-120 明令禁止的
 * 反面形态）⇒ error；`first_seen/last_seen ≠ ts` 理论上导入历史行可携带原值 ⇒ warn（一旦真有
 * 这样的调用方，要么升级 error、要么改口径，两者都要落到本常量上）。
 *
 * @type {ReadonlyArray<{field:string, expect:string, level:'error'|'warn', code:string, why:string, equals:(row:object)=>boolean}>}
 */
export const LEDGER_ROW_WRITE_INVARIANTS = Object.freeze([
  Object.freeze({
    field: 'recurrence',
    expect: '=== 1',
    level: 'error',
    code: 'ROW_RECURRENCE_NOT_ONE',
    equals: (row) => row.recurrence === 1,
    why: '行内 recurrence 是写入时的单行事实（恒 1）；同 rule 行数必须派生。出现非 1 ⇒ 有人把聚合写进了 append-only 行里（LF-120 禁原地更新的反面形态），该行及其它读数一律不可信',
  }),
  Object.freeze({
    field: 'first_seen',
    expect: '=== ts',
    level: 'warn',
    code: 'ROW_FIRST_SEEN_NOT_TS',
    equals: (row) => row.first_seen === row.ts,
    why: '行内 first_seen 是写入时事实（= 本行 ts）；同 rule 最早 ts 必须派生。不等 ⇒ 该行携带了跨行聚合，口径可疑',
  }),
  Object.freeze({
    field: 'last_seen',
    expect: '=== ts',
    level: 'warn',
    code: 'ROW_LAST_SEEN_NOT_TS',
    equals: (row) => row.last_seen === row.ts,
    why: '行内 last_seen 是写入时事实（= 本行 ts）；同 rule 最晚 ts 必须派生。不等 ⇒ 该行携带了跨行聚合，口径可疑',
  }),
]);

/**
 * 校验冻结单自身的一致性。
 * @param {{files?: object[], rowInvariants?: object[], readFile?: (p:string)=>string, exists?: (p:string)=>boolean, root?: string, checkDoc?: boolean}} [opts]
 */
export function checkSchema(opts = {}) {
  const files = opts.files ?? FILES;
  const invariants = opts.rowInvariants ?? LEDGER_ROW_WRITE_INVARIANTS;
  const findings = [];
  const add = (code, msg) => findings.push({ code, msg });
  if (files.length !== 7) add('SCHEMA_FILE_COUNT', `必须冻结 7 个数据文件，实测 ${files.length}`);

  for (const file of files) {
    const label = file?.name ?? '?';
    if (!FROZEN_FILE_NAMES.includes(file?.name)) {
      add('SCHEMA_FILE_NAME_UNKNOWN', `${label}: 不在冻结文件名集合内（改名/新增文件须走契约变更）`);
    }
    if (typeof file?.versionField !== 'string' || file.versionField === '') {
      add('SCHEMA_VERSION_FIELD_MISSING', `${label}: 缺 versionField`);
    } else if (!file.fields.some((f) => f.name === file.versionField)) {
      add('SCHEMA_VERSION_FIELD_ABSENT', `${label}: versionField "${file.versionField}" 不在字段表里`);
    }
    if (!['append-only', 'json'].includes(file?.kind)) {
      add('SCHEMA_KIND_BAD', `${label}: kind 必须是 append-only|json`);
    }
    const names = file.fields.map((f) => f.name);
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    if (dup.length > 0) add('SCHEMA_FIELD_DUP', `${label}: 字段重复 ${[...new Set(dup)].join(',')}`);

    for (const f of file.fields) {
      if (!FIELD_TYPES.includes(f.type)) add('SCHEMA_FIELD_TYPE_BAD', `${label}.${f.name}: 未知类型 ${f.type}`);
      if (f.type === 'enum' && (!Array.isArray(f.values) || f.values.length === 0)) {
        add('SCHEMA_ENUM_VALUES_MISSING', `${label}.${f.name}: enum 必须列 values`);
      }
      // 结构性矛盾：append-only 文件里的字段**不得**原地更新
      if (f.mutable === true && f.mutableInPlace === true) {
        add('SCHEMA_INPLACE_MUTATION', `${label}.${f.name}: 同时标 mutable+可变聚合与原地更新（禁止：append-only 行不可改写）`);
      }
      if (file.kind === 'append-only' && f.mutableInPlace === true) {
        add('SCHEMA_INPLACE_MUTATION', `${label}.${f.name}: append-only 文件里出现 mutableInPlace`);
      }
    }

    const derived = new Set((file.derived ?? []).map((d) => d.field));
    for (const f of file.fields) {
      if (f.mutable === true && !derived.has(f.name)) {
        add('SCHEMA_DERIVED_RULE_MISSING', `${label}.${f.name}: 可变聚合字段必须给出派生规则（禁原地更新）`);
      }
    }
    for (const rule of file.derived ?? []) {
      if (!names.includes(rule.field)) add('SCHEMA_DERIVED_FIELD_UNKNOWN', `${label}: 派生规则指向不存在的字段 ${rule.field}`);
      if (typeof rule.rule !== 'string' || rule.rule === '') add('SCHEMA_DERIVED_RULE_EMPTY', `${label}.${rule.field}: 派生规则为空`);
    }

    // 显式扩展位（2026-09-19）：计划 §3 的基线字段集**不得增删**；新增字段只能登记在
    // `extensions` 里，且必须可选（required:false）——加法不得破坏既有行形状。
    for (const ext of file.extensions ?? []) {
      if (!names.includes(ext)) {
        add('SCHEMA_EXTENSION_UNKNOWN', `${label}: 扩展字段 "${ext}" 不在 fields 表里`);
        continue;
      }
      const extField = file.fields.find((x) => x.name === ext);
      if (extField.required === true) {
        add('SCHEMA_EXTENSION_REQUIRED', `${label}.${ext}: 扩展字段必须可选（required:false）`);
      }
    }

    for (const required of REQUIRED_PLAN_FIELDS[file.name] ?? []) {
      if (!names.includes(required)) add('SCHEMA_REQUIRED_FIELD_MISSING', `${label}: 缺必需字段 "${required}"`);
    }

    // 行内写入不变式（2026-09-19）：不变式只能挂在"确实是行内写入时事实"的字段上，
    // 即该字段必须是 ledger 的**可变 + 有派生规则**字段（否则口径自相矛盾：既说是行内常数、
    // 又没告诉人聚合该从哪读）。
    if (file.name === 'ledger.jsonl') {
      const mutables = new Set(file.fields.filter((f) => f.mutable === true).map((f) => f.name));
      const derivedNames = new Set((file.derived ?? []).map((d) => d.field));
      for (const inv of invariants) {
        const invLabel = `${label}.${inv?.field ?? '?'}`;
        if (!names.includes(inv?.field)) {
          add('SCHEMA_ROW_INVARIANT_UNKNOWN', `${invLabel}: 行内不变式指向不存在的字段`);
          continue;
        }
        if (!mutables.has(inv.field) || !derivedNames.has(inv.field)) {
          add('SCHEMA_ROW_INVARIANT_NOT_DERIVED', `${invLabel}: 行内不变式字段必须同时是"可变 + 有派生规则"字段（否则"行内是常数、聚合在哪读"没交代）`);
        }
        if (!['error', 'warn'].includes(inv?.level) || typeof inv?.why !== 'string' || inv.why.trim() === '' || typeof inv?.equals !== 'function') {
          add('SCHEMA_ROW_INVARIANT_NOT_DESCRIBED', `${invLabel}: 不变式必须写清 level(error|warn) + why(为什么) + equals(判据函数)`);
        }
      }
    }
  }

  if (opts.checkDoc === true && typeof opts.root === 'string') {
    const docPath = join(opts.root, 'SCHEMA.md');
    const exists = opts.exists ?? ((p) => existsSync(p));
    const readText = opts.readFile ?? ((p) => readFileSync(p, 'utf8'));
    if (!exists(docPath)) {
      add('SCHEMA_DOC_MISSING', `缺 SCHEMA.md（用 rk-schema --write-md 生成）: ${docPath}`);
    } else if (readText(docPath) !== renderSchemaMarkdown(files, invariants)) {
      add('SCHEMA_DOC_DRIFT', 'SCHEMA.md 与 src/schema.mjs 的生成结果不一致（手改文档或改码未重生成）');
    }
  }

  return { ok: findings.length === 0, findings };
}

/** 渲染冻结单 markdown（**唯一生成路径**；SCHEMA.md 必须等于它的输出） */
export function renderSchemaMarkdown(files = FILES, invariants = LEDGER_ROW_WRITE_INVARIANTS) {
  const lines = [];
  lines.push(`# dsh-rulekeeper schema v${SCHEMA_VERSION}（冻结单）`);
  lines.push('');
  lines.push('> **本文件由 `src/schema.mjs` 生成，禁手改。** 改字段请改代码后重跑 `node bin/rk-schema.mjs --write-md`；');
  lines.push('> 手改会被 `rk-schema --check` 判红（`SCHEMA_DOC_DRIFT`）。');
  lines.push('');
  lines.push('## 0. 冻结范围');
  lines.push('');
  lines.push(`共 ${files.length} 个数据文件，每个文件都有版本字段；可变聚合字段**一律派生**（禁原地更新）。`);
  lines.push('');
  lines.push('## 1. 逐文件字段表');
  lines.push('');
  for (const file of files) {
    lines.push(`### \`${file.name}\``);
    lines.push('');
    lines.push(`- 形态：**${file.kind}**｜版本字段：\`${file.versionField}\`｜用途：${file.purpose}`);
    if (file.dedupeKey) lines.push(`- 去重键：${file.dedupeKey.map((k) => `\`${k}\``).join(' × ')}`);
    if (file.checks) lines.push(`- 可机检类型：${file.checks.map((c) => `\`${c}\``).join(' / ')}`);
    lines.push('');
    lines.push('| 字段 | 类型 | 必填 | 唯一 | 可变 | 说明 |');
    lines.push('|---|---|---|---|---|---|');
    for (const f of file.fields) {
      lines.push(`| \`${f.name}\` | ${f.type}${f.values ? ` (${f.values.join('\\|')})` : ''} | ${f.required ? '是' : '否'} | ${f.unique ? '是' : ''} | ${f.mutable ? '派生' : ''} | ${f.note ?? ''} |`);
    }
    lines.push('');
  }
  lines.push('## 2. 可变字段的派生规则（**禁原地更新**）');
  lines.push('');
  lines.push('| 文件 | 字段 | 派生方式 | 说明 |');
  lines.push('|---|---|---|---|');
  for (const file of files) {
    for (const rule of file.derived ?? []) {
      lines.push(`| \`${file.name}\` | \`${rule.field}\` | \`${rule.rule}\` | ${rule.note ?? ''} |`);
    }
  }
  lines.push('');
  lines.push('**为什么禁止**：把"计数/状态"放进 append-only 行里原地改写，等于在并发下做「整文件读-改-写」。');
  lines.push('实测该形态会丢计数（`scripts/demo-rmw-loss.mjs` 复现；本机曾测得期望 1600 实得 56，丢 96.5%）。');
  lines.push('计数用**派生**（扫同 rule 行数），状态迁移用**事件行**；写入侧的原子性与锁由 LF-160 / LF-170 保证。');
  lines.push('');
  lines.push('### 2.1 行内值 ≠ 聚合值（2026-09-19 口径更正）');
  lines.push('');
  lines.push('上表 `可变` 列标"派生"说的是**读法**（该字段的语义要派生着读），**不是**"行里存的是聚合值"。');
  lines.push('**行里写下的永远是写入那一刻的单行事实**：`recurrence` 恒 `1`、`first_seen`/`last_seen` 恒等于本行 `ts`、');
  lines.push('`status` 为写入时状态（导入的历史行可**出生即** `superseded`）。因此**直接读行内字段当聚合用会得到常数**——');
  lines.push('同 rule 行数请用 `recurrenceOf()` / `summary()`。下表由 `LEDGER_ROW_WRITE_INVARIANTS` 渲染（改口径请改代码重生成）：');
  lines.push('');
  lines.push('| 字段 | 行内不变式 | 违反级别 | 为什么 |');
  lines.push('|---|---|---|---|');
  for (const inv of invariants) {
    lines.push(`| \`${inv.field}\` | \`${inv.expect}\` | ${inv.level} | ${inv.why} |`);
  }
  lines.push('');
  lines.push('机械面：`doctor()` 逐行核对上表，违反即报 `DOCTOR_<code>`（如 `DOCTOR_ROW_RECURRENCE_NOT_ONE`）并计入 `summary.rowViolations`。');
  lines.push('');
  return `${lines.join('\n')}`;
}
