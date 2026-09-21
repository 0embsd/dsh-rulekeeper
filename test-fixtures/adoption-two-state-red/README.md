# 两态样本 · 红态：旧口径（改动前）

- 被测纪律：`CAT-PROC` —— 入账必须登记机制面（四选一），声明了机械判据就必须真有绑定。
- 旧口径（红）：`mechanism` 是**自由文本**，写 "text-only"、"靠自觉"、"待补" 都能过 —— 免责成本太低，
  等于没登记；声明 `mechanized` 却没有绑定也无人发现（自称型控制）。
- 新口径（绿）：见 `adoption-two-state-green`。
- 可重跑的构造方式：检查器 `scripts/checkers/adoption-contract.mjs` 每次运行都会**现造**一棵
  "mechanism 拼错 + 声明 mechanized 却无绑定"的临时账本，并断言它必须被判红。
