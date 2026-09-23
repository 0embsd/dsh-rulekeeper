// 绿样本：一个**代码类**文件（`**/*.mjs` 命中），且落点台账里有一条**覆盖它的计划行**
// （时间 = 该提交时刻 ⇒ 满足"计划行 ≤ 改动"且"head − 计划行 ≤ 窗口"）。
export const fixture = 'green-code-change-with-plan';
