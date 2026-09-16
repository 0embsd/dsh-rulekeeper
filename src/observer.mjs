// dsh-rulekeeper · LF-440 **观察者清点 + 顺序契约**
//
// 判据（清单 LF-440）：
//   绿 = 「事件×插件×位次(含 prepend)」表**无空行**；**原文判据 = 只读 `result.content`、不返回 content**
//   红 = 返回 `{kind:'accept',content}` → 与 obs-pack/spill-policy 冲突 → **必红**；
//        上游 deny 后我们观测不到 → 记 `upstream_denied` 而**不是静默**
//
// 为什么要这张表：`post-execute` 是 **waterfall**——谁能改写 result 取决于**位次**。第三方插件里
//   `spill-policy` 用 `prepend=true` 挂在**最外层**；我们若也去改写 content，就会与它/obs-pack 打架（内容被叠一层或丢一层）。
//   所以本模块把"谁在哪个事件的第几位、是否 prepend"钉成**可机读的表**，并把我们的行为约束成**只读**。
// 零依赖：只用 node:*。

/** 我们关心的事件（顺序即表中分组顺序） */
export const OBSERVER_EVENTS = Object.freeze(['tools/pre-execute', 'tools/post-execute', 'agent/pre-step']);

/** 同场已知的第三方插件（清点用；缺一个不是错误，但表里要能看出来） */
export const KNOWN_THIRD_PARTY = Object.freeze(['gate-bypass', 'observation-pack', 'rule-engine', 'spill-policy']);

/**
 * 生成「事件×插件×位次」表。
 * 位次规则：**prepend=true 的排在本事件最前**（最外层），其余按注册顺序；`position` 从 1 起连续编号。
 * @param {{event: string, plugin: string, prepend?: boolean}[]} observers
 */
export function buildOrderTable(observers = []) {
  const list = Array.isArray(observers) ? observers.filter((o) => o !== null && typeof o === 'object') : [];
  const rows = [];
  for (const event of OBSERVER_EVENTS) {
    const group = list
      .map((o, idx) => ({ ...o, idx }))
      .filter((o) => o.event === event)
      .sort((a, b) => {
        const pa = a.prepend === true ? 0 : 1;
        const pb = b.prepend === true ? 0 : 1;
        if (pa !== pb) return pa - pb; // prepend 优先（最外层）
        return a.idx - b.idx;          // 其余按注册顺序（稳定）
      });
    group.forEach((o, i) => rows.push({ event, plugin: o.plugin, prepend: o.prepend === true, position: i + 1 }));
  }
  return rows;
}

/**
 * 表体检：**无空行**。
 * 空行定义：① 某事件一条观察者都没有（`OBSERVER_EVENT_EMPTY`）② 行的 plugin 为空（`OBSERVER_PLUGIN_EMPTY`）
 * ③ 位次不连续/不从 1 起（`OBSERVER_POSITION_GAP`）。
 */
export function assertNoEmptyRows(rows, events = OBSERVER_EVENTS) {
  const findings = [];
  const list = Array.isArray(rows) ? rows : [];
  for (const event of events) {
    const group = list.filter((r) => r.event === event);
    if (group.length === 0) findings.push({ code: 'OBSERVER_EVENT_EMPTY', message: `事件「${event}」没有任何观察者 ⇒ 表出现空行（清点不完整）` });
  }
  for (const r of list) {
    if (typeof r.plugin !== 'string' || r.plugin.trim() === '') {
      findings.push({ code: 'OBSERVER_PLUGIN_EMPTY', message: `事件「${r.event}」第 ${r.position} 位没有插件名（空行）` });
    }
  }
  for (const event of events) {
    const group = list.filter((r) => r.event === event).sort((a, b) => a.position - b.position);
    group.forEach((r, i) => {
      if (r.position !== i + 1) {
        findings.push({ code: 'OBSERVER_POSITION_GAP', message: `事件「${event}」位次不连续：期望 ${i + 1}，实得 ${r.position}` });
      }
    });
  }
  return { ok: findings.length === 0, findings };
}

/** 第三方清点：表里出现了哪些已知第三方、缺了哪些（缺了不判红，但要看得见） */
export function thirdPartyInventory(rows, known = KNOWN_THIRD_PARTY) {
  const present = new Set((Array.isArray(rows) ? rows : []).map((r) => r.plugin).filter((p) => typeof p === 'string'));
  return { present: known.filter((p) => present.has(p)), missing: known.filter((p) => !present.has(p)) };
}

/**
 * **只读契约**（原文判据）：我们只读 `result.content`，**不返回 content**。
 * 返回 `{kind:'accept',content}` / `{content}` / `{kind:'replace'...}` 一律判红——那会与 spill-policy/obs-pack 的改写打架。
 */
export function assertObserverContract(returnValue) {
  const findings = [];
  if (returnValue === undefined || returnValue === null) return { ok: true, findings };
  if (typeof returnValue !== 'object') {
    findings.push({ code: 'OBSERVER_BAD_RETURN', message: `观察者返回了非对象（${typeof returnValue}）⇒ 不应产生任何结果改写` });
    return { ok: false, findings };
  }
  const keys = Object.keys(returnValue);
  if (keys.length === 0) return { ok: true, findings };
  if ('content' in returnValue) {
    findings.push({
      code: 'OBSERVER_RETURNS_CONTENT',
      message: `观察者返回了 content ⇒ 与 spill-policy(prepend 最外层)/obs-pack 冲突（可能重复改写或丢内容）—— 我们**只读** result.content，不得回写`,
    });
  }
  if (returnValue.kind === 'accept' && 'content' in returnValue) {
    findings.push({ code: 'OBSERVER_ACCEPT_WITH_CONTENT', message: '返回 {kind:"accept",content} 是典型的"顺手改一下"——必红' });
  }
  return { ok: findings.length === 0, findings };
}

/**
 * 上游 deny 的如实标注：我们观测不到执行时，记 `upstream_denied`（**不是静默**）。
 * deny 形状：`{decision:'deny'}` 或 `{kind:'deny'}`（两种都见过）。
 */
export function classifyUpstream(prevResult) {
  const p = prevResult !== null && typeof prevResult === 'object' ? prevResult : null;
  const denied = p !== null && (p.decision === 'deny' || p.kind === 'deny');
  return {
    denied,
    marker: denied ? 'upstream_denied' : 'observed',
    reason: denied ? '上游已 deny：本次执行没发生，我们**观测不到结果**（如实标注，不假装看过）' : '上游放行：照常观测',
  };
}

/** 观察者本体（**只读**）：只看 result.content 是否存在/长度，不回写任何东西 */
export function observeResult({ exec, result, upstream } = {}) {
  const up = classifyUpstream(upstream);
  const r = result !== null && typeof result === 'object' ? result : null;
  const hasContent = r !== null && r.content !== undefined && r.content !== null;
  return {
    tool: exec !== null && typeof exec === 'object' && typeof exec.name === 'string' ? exec.name : null,
    upstreamDenied: up.denied,
    marker: up.marker,
    readOnly: { hasContent, contentLength: hasContent ? String(r.content).length : 0 },
    returnValue: undefined, // ← 我们**永不**回写：契约就是这个 undefined
  };
}
