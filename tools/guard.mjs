/* 凭证守卫：确保交付物里不含任何账号凭证
 *
 * 设计要点：这里**不写任何真实凭证的字面值**（写了就等于凭证又留在源码里），
 * 只按「形态」识别：token 赋值、Bearer 字面量、32 位 hex 串、8 位商家编码等。
 * 由 build.mjs 在打包时调用，也是 test/build.test.mjs 的断言对象。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 需要扫描的源码文件（数据夹具不含在内：里面有业务串号，可能长得像 hex） */
export const SOURCE_FILES = [
  'src/core.js',
  'src/erp.js',
  'src/store.js',
  'src/ui.js',
  'src/xlsx.js',
  'src/styles.css',
  'src/index.template.html',
  'build.mjs',
  'tools/guard.mjs',
  'tools/make-synthetic-fixture.mjs',
  'test/fixture-file.mjs',
  'test/browser-env.mjs',
  // 测试文件同样不允许出现生产凭证（凭证从环境变量取，见 test/env.mjs）
  'test/env.mjs',
  'test/engine.test.mjs',
  'test/fixture.test.mjs',
  'test/xlsx.test.mjs',
  'test/live.test.mjs',
  'test/login.test.mjs',
  'test/browser.test.mjs',
  'test/browser-login.test.mjs',
  'test/layout.test.mjs',
  'test/screenshot.mjs',
  'test/build.test.mjs',
];

export const ARTIFACT = '库存盘点.html';

/** 一个 32 位十六进制串（token 形态），要求至少含一个字母，避免把 32 位纯数字串号误判 */
const HEX32 = /\b(?=[0-9a-fA-F]{32}\b)(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{32}\b/g;

const RULES = [
  {
    name: '代码里写死了 token / 密码字面量',
    re: /(token|userpwd|password|passwd|secret|apikey)\s*[:=]\s*['"`][^'"`\s]{6,}['"`]/gi,
  },
  { name: '出现 Bearer 凭证字面量', re: /Bearer\s+[A-Za-z0-9._-]{16,}/g },
  { name: '出现 32 位十六进制 token 形态的串', re: HEX32 },
  {
    name: '写死了商家编码（companycode）',
    re: /companycode['"]?\s*[:=]\s*['"`]\d{6,}['"`]/gi,
  },
  {
    // 允许中间夹着 encodeURIComponent(...) 之类的包裹
    name: '请求头里带固定用户名（中文姓名）',
    re: /(username|userName|用户名)['"]?\s*[:=]\s*[^,\n;]{0,40}['"`][\u4e00-\u9fa5]{2,4}['"`]/g,
  },
  {
    // 不写具体某个人：任何「URL 编码的中文」被塞进 username/用户名 字段都算
    name: '出现 URL 编码后的中文用户名',
    re: /(username|userName|用户名)['"]?\s*[:=]\s*['"`](?:%E[4-9][0-9A-Fa-f]){3,}/g,
  },
];

/**
 * 明显是人造假值（测试用），不算凭证。
 * 判据：值里带 fake/dummy/test/example/... 这类字样，或整体是全 0 / 同一个字符重复。
 */
const SYNTHETIC_WORD = /(fake|dummy|test|example|sample|placeholder|changeme|todo|xxx|none|null)/i;
function isSynthetic(raw) {
  const v = String(raw);
  if (SYNTHETIC_WORD.test(v)) return true;
  const quoted = v.match(/['"`]([^'"`]*)['"`]/g) || [];
  return quoted.every((q) => {
    const inner = q.slice(1, -1);
    if (!inner) return true;
    if (/^0+$/.test(inner)) return true; // 00000000 这类占位商家编码
    if (new Set(inner).size === 1) return true; // 全同一个字符
    return SYNTHETIC_WORD.test(inner);
  }) && quoted.length > 0;
}

/**
 * 扫描一段文本（按行扫，便于用 // guard-allow 精确豁免某一行）
 * 行内出现 guard-allow 注释 => 该行跳过；值本身是明显假值 => 跳过。
 * @returns {Array<{rule:string, sample:string, line:number}>}
 */
export function scanText(text) {
  const hits = [];
  String(text)
    .split('\n')
    .forEach((line, i) => {
      if (/guard-allow/.test(line)) return; // 显式白名单：必须写清理由
      RULES.forEach((rule) => {
        const re = new RegExp(rule.re.source, rule.re.flags);
        let m;
        while ((m = re.exec(line))) {
          if (isSynthetic(m[0])) continue;
          hits.push({
            rule: rule.name,
            // 只回显少量字符，避免把疑似凭证整串打进日志
            sample: m[0].length > 12 ? m[0].slice(0, 6) + '…(' + m[0].length + '字符)' : m[0],
            line: i + 1,
          });
          if (hits.length > 40) return;
        }
      });
    });
  return hits;
}

/** 扫描一组文件 */
export function scanFiles(root, files) {
  const out = [];
  files.forEach((rel) => {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) return;
    const text = fs.readFileSync(p, 'utf8');
    scanText(text).forEach((h) => out.push(Object.assign({ file: rel }, h)));
  });
  return out;
}

/** 构建/测试统一入口：扫描源码 + 产物 */
export function scanAll(root) {
  const files = SOURCE_FILES.concat([ARTIFACT]);
  return scanFiles(root, files);
}

export function formatHits(hits) {
  return hits
    .map((h) => `  · ${h.file}${h.line ? ':' + h.line : ''}: ${h.rule} → ${h.sample}`)
    .join('\n');
}
