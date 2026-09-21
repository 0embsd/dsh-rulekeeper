# 两态样本 · 绿态：新口径（改动后）

- 被测纪律：`CAT-PROC` —— 入账必须登记机制面（四选一），声明了机械判据就必须真有绑定。
- 新口径（绿）：
  ①`mechanism` 必须是 `text` / `mechanized` / `guard` / `question` 之一（**四选一**，拼错即红）；
  ②声明 `mechanized` 的行必须在 `rules.json` 的 `checks` 里有绑定；声明 `guard` 的必须在 `gates` 里
  有绑定（空转的声明 = 自称型控制）；
  ③`text`（承认仅文本、不拦）必须被**计数并打印**（`ADOPTION_TEXT_ONLY`），不得静默。
- 与 §47 的对应：这一条把"机制面必填"从文档纪律变成机械判据 —— 只写下来了不再能蒙过去。
- 旧口径红样本：见 `adoption-two-state-red`。
