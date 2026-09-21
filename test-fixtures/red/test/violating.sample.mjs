// 违规样本：用例直取真实用户级落点并写入，且全树没有任何进程级隔离入口
// （写这个样本时踩过一次：注释里写出那个隔离函数名，会让检查器的"有没有隔离入口"判成真 ——
//  文字命中不等于机制存在。样本正文里因此**不出现**该函数名。）
import { test } from 'node:test';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { cleanupAll } from './helpers/sandbox.mjs';

test.after(cleanupAll);

test('违规：把测试会话写进真实用户级落点', () => {
  const home = process.env.DSH_HOME;
  writeFileSync(join(home, 'lessonflow', 'usage.json'), '{}');
});
