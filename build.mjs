/* 打包：把 src/* 内联成单文件 HTML（双击即可用）
 * 用法：node build.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(dir, p), 'utf8');

const parts = {
  '/*__CSS__*/': read('src/styles.css'),
  '/*__CORE__*/': read('src/core.js'),
  '/*__ERP__*/': read('src/erp.js'),
  '/*__STORE__*/': read('src/store.js'),
  '/*__XLSX__*/': read('src/xlsx.js'),
  '/*__UI__*/': read('src/ui.js'),
};

let html = read('src/index.template.html');
for (const [token, code] of Object.entries(parts)) {
  if (!html.includes(token)) throw new Error('模板缺少占位符 ' + token);
  if (/<\/script/i.test(code)) throw new Error('内联脚本里出现 </script，会破坏 HTML：' + token);
  html = html.replace(token, () => code);
}

// ---- 凭证守卫：源码或产物里出现任何账号凭证形态，直接构建失败 ----
const guard = await import('./tools/guard.mjs');
const hits = guard.scanAll(dir);
if (hits.length) {
  console.error('\n✗ 构建中止：检测到疑似账号凭证，交付物不允许内嵌凭证\n');
  console.error(guard.formatHits(hits));
  console.error('\n请把这些值改成空字符串 / 由使用者登录后获得（见 README「登录与凭证」）。\n');
  process.exit(1);
}

const out = path.join(dir, '库存盘点.html');
fs.writeFileSync(out, html);
const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
console.log(`已生成 ${path.basename(out)}（${kb} KB）`);
console.log('凭证检查：通过（源码与产物均不含账号凭证）');
console.log('双击该文件即可使用（推荐 Chrome / Edge）。');
