// 违规样本里的"假检查器"：不管被检对象是什么，一律退出 1
// 也就是"这条判据在**正常仓库**上也在误报" —— misreport-surface 的 A 判据必须抓住它。
console.log('FAKE_HIT=1');
process.exit(1);
