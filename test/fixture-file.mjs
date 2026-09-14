/* 回归夹具的发现逻辑（4 个测试共用）
 *
 * 约定：
 *  - 仓库里提交的是**合成夹具**（synthetic-*.json，结构与真实一致、数据是生成的）；
 *  - 真实抓取的夹具由 `node test/live.test.mjs --write-fixture` 生成，
 *    被 .gitignore 排除，不进仓库；
 *  - 取「最近修改」的那一份，所以本机刚抓过真实数据时会自动用它。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

export function findFixture() {
  if (!fs.existsSync(FIXTURE_DIR)) return null;
  const files = fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.meta.json'));
  if (!files.length) return null;
  files.sort(
    (a, b) => fs.statSync(path.join(FIXTURE_DIR, b)).mtimeMs - fs.statSync(path.join(FIXTURE_DIR, a)).mtimeMs
  );
  const file = files[0];
  const metaFile = file.replace(/\.json$/, '.meta.json');
  const metaPath = path.join(FIXTURE_DIR, metaFile);
  if (!fs.existsSync(metaPath)) return null;
  return {
    file,
    metaFile,
    rows: JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8')),
    meta: JSON.parse(fs.readFileSync(metaPath, 'utf8')),
    synthetic: !!JSON.parse(fs.readFileSync(metaPath, 'utf8')).synthetic,
  };
}

/** 找不到夹具时的提示（并返回退出码语义：1=失败，0=跳过） */
export function missingFixtureHint() {
  console.log('缺少回归夹具：test/fixtures/ 里没有可用的账面快照。');
  console.log('  · 仓库自带合成夹具，正常 clone 下来就有（synthetic-*.json）');
  console.log('  · 想重新生成合成夹具：node tools/make-synthetic-fixture.mjs');
  console.log('  · 想用真实数据抓一份：ERP_TOKEN=... ERP_COMPANYCODE=... node test/live.test.mjs --write-fixture');
}
