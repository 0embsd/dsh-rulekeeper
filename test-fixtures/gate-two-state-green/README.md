# 两态样本 · 绿态：新口径（改动后）

- 被测纪律：`GATE-DISCIPLINE` —— 收尾门禁四件齐备且真能跑。
- 新口径（绿）：四项一起判 ——
  ①`.gitattributes` 显式钉 `.githooks/* eol=lf`；②四件 hook 齐备且各自把自己的名字作为 `hook.mjs`
  的子命令；③索引里 mode 必须 100755；④hook 脚本行尾必须纯 LF。
- 旧口径红样本：见 `gate-two-state-red`（同一目录的姊妹样本）。
- 与对象级判据的关系：本条判的是**每件 hook 自己的事实**（它的行尾、它的索引 mode、它传的子命令），
  不是"整份 hooks verify 报告 ok"这类聚合结论（规则 41）。
