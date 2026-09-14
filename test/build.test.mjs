/* 交付物检查：node test/build.test.mjs
 * 1) 源码与产物里不含任何账号凭证（含凭证守卫自身的有效性验证）
 * 2) 产物与源码一致（重新构建后逐字节相同）
 * 全程离线，不需要任何凭证。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanText, scanAll, SOURCE_FILES, ARTIFACT, ARTIFACTS } from '../tools/guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0,
  fail = 0;
const ok = (cond, label, extra) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`);
  }
};

console.log('— 源码与产物不含凭证 —');
const hits = scanAll(root);
ok(hits.length === 0, '源码 + 产物凭证扫描通过', hits.map((h) => h.file + ': ' + h.rule));
const html = fs.readFileSync(path.join(root, ARTIFACT), 'utf8');
ok(!/Bearer\s+[A-Za-z0-9._-]{16,}/.test(html), '产物里没有 Bearer 凭证');
ok(!/token:\s*['"][^'"]+['"]/.test(html), '产物里没有写死的 token');

console.log('\n— 凭证守卫本身有效（用假凭证验证它会拦下来）—');
// 注意：这里用的是明显造出来的假值，不是任何真实凭证
// 这里全是**故意造出来的假值**，用来验证守卫能拦住；
// 守卫自身对这些行要豁免，所以逐行标 guard-allow。
const FAKE = [
  { text: `token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'`, label: '32 位 hex token' }, // guard-allow 守卫自测假值
  { text: `Authorization: 'Bearer AAABBBCCCDDDEEEFFF111'`, label: 'Bearer 字面量' }, // guard-allow 守卫自测假值
  { text: `companycode: '12345678'`, label: '写死商家编码' }, // guard-allow 守卫自测假值
  { text: `username: encodeURIComponent('张三')`, label: '写死中文用户名' }, // guard-allow 守卫自测假值
  { text: `userPwd: 'hunter2hunter2'`, label: '写死密码' }, // guard-allow 守卫自测假值
];
FAKE.forEach((c) => {
  const found = scanText(c.text);
  ok(found.length > 0, `能拦住：${c.label}`, found.map((f) => f.rule));
});
ok(scanText('token: \'\'').length === 0, '空 token 不会误报');
ok(scanText('const n = randHex(32);').length === 0, 'randHex(32) 这类运行时代码不误报');

console.log('\n— 产物与源码一致 —');
const before = fs.readFileSync(path.join(root, ARTIFACT), 'utf8');
const out = execFileSync('node', ['build.mjs'], { cwd: root, encoding: 'utf8' });
ok(/凭证检查：通过/.test(out), '构建时执行了凭证检查');
const after = fs.readFileSync(path.join(root, ARTIFACT), 'utf8');
ok(before === after, '重新构建后产物逐字节相同');

// 网页托管入口：index.html 必须与单文件交付物逐字节相同（否则线上版本会和线下发出去的版本不一致）
ok(ARTIFACTS.length === 2 && ARTIFACTS.includes(ARTIFACT) && ARTIFACTS.includes('index.html'), '产物清单同时包含单文件交付物与网页入口', ARTIFACTS);
const idx = path.join(root, 'index.html');
ok(fs.existsSync(idx), '网页入口 index.html 存在（GitHub Pages 只认 index.html）');
ok(fs.existsSync(idx) && fs.readFileSync(idx, 'utf8') === after, 'index.html 与单文件交付物内容逐字节相同');
ok(!fs.readFileSync(idx, 'utf8').includes('/*__CORE__*/'), 'index.html 里没有未替换的占位符');
ok(
  SOURCE_FILES.every((f) => fs.existsSync(path.join(root, f))),
  '守卫覆盖的源文件都存在',
  SOURCE_FILES.length + ' 个'
);
// 源码是被内联进产物的：抽一段核心函数名验证确实打进去了
ok(html.includes('globalThis.IC = globalThis.IC || {}') && html.includes('Stocktake'), '产物内联了核心逻辑');
ok(!html.includes('/*__CORE__*/') && !html.includes('/*__UI__*/'), '产物里没有未替换的占位符');

console.log(`\n交付物检查：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
