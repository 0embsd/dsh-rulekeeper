# 两态样本 · 红态：旧口径（改动前）

- 被测纪律：`CAT-TECH` —— deny 列表不得为测试方便开例外。
- 旧口径（红）：脱敏检测器（S8）判红了**它自己的测试文件**（夹具里直接写了可疑串字面量），
  于是给 deny 列表加了 `allow` 例外放行 `test/**` —— 安全边界越开越大：真泄漏也能藏在被放行的
  文件里（真实事故：`rk-selfcheck` 报 2 条 `S8_INTERNAL_LEAK`）。
- 新口径（绿）：见 `exception-two-state-green`。
- 可重跑的构造方式：检查器 `scripts/checkers/no-test-exception.mjs` 每次运行都会**现造**一棵
  "豁免表里塞进 `test/` 路径"的临时 `src/` 树，并断言它必须被判红。
