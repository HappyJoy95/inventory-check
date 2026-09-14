/* 生成「合成」回归夹具：结构与真实抓取完全一致，但商品名/串号全是假的
 *
 * 为什么需要：真实夹具里是门店的真实商品名和串号（IMEI），
 * 不适合进代码仓库。合成夹具保留同样的结构与统计特征，
 * 离线回归测试的覆盖度基本不变，而真实数据不出本机。
 *
 * 用法：node tools/make-synthetic-fixture.mjs [输出前缀]
 *   node tools/make-synthetic-fixture.mjs                      # 默认 synthetic-store-999999-<今天>
 *   node tools/make-synthetic-fixture.mjs my-store-123-2026-01-01
 *
 * 注意：真实夹具由 `node test/live.test.mjs --write-fixture` 生成，
 * 已被 .gitignore 排除，不会被提交。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(root, 'test/fixtures');

/* ---------- 可重复的伪随机（同一个种子永远生成同一份数据） ---------- */
function makeRandom(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const rnd = makeRandom(20260914);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));

/* ---------- 结构参数：照着真实门店账面的形态来 ---------- */
const STORE = { id: '999999', name: '测试门店库' };
const SERIAL_ROWS = 407; // 有串号
const NON_SERIAL_ROWS = 35; // 无串号（配件/促销品）
const MULTI_SERIAL = 176; // 其中「一台带两个串号」的行数
const TRIPLE_SERIAL = 92; // 其中「带三个串号」的行数（含在 MULTI 里）

const CATEGORIES = [
  ['手机', '智能手机', ['Mate 系列', 'P 系列']],
  ['平板', '平板电脑', ['MatePad 系列', 'Mini 系列']],
  ['笔记本', '笔记本办公机', ['MateBook 系列', '']],
  ['音频产品', '无线耳机', ['FreeBuds 系列', '']],
  ['智能穿戴', '智能手表', ['Watch 系列', '']],
  ['手机平板周边', '陈列哑机', ['', '']],
  ['智能家居', '路由器', ['', '']],
];
const BRANDS = ['品牌甲', '品牌乙', '品牌丙'];
const TAGS = ['新', '样,新', 'J,新', 'K,新', ''];
const MODELS = ['A100', 'B200', 'C300', ''];

/** 造一个像样的串号：SN 是字母数字混排，IMEI 是 15 位数字 */
function makeSerial(kind, n) {
  if (kind === 'imei') return '86' + String(1000000000000 + n).slice(-13);
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < 15; i++) out += chars[Math.floor(rnd() * chars.length)];
  return out;
}

const rows = [];
let serialSeq = 0;

/* 有串号的行：一台一行，数量恒为 1 */
for (let i = 0; i < SERIAL_ROWS; i++) {
  const [cat1, cat2, cat3s] = pick(CATEGORIES);
  const brand = pick(BRANDS);
  const cat3 = pick(cat3s);
  const model = pick(MODELS);
  const tag = pick(TAGS);

  // 串号个数：三串号 / 双串号 / 单串号
  let count = 1;
  if (i < TRIPLE_SERIAL) count = 3;
  else if (i < MULTI_SERIAL) count = 2;

  const serials = [];
  for (let k = 0; k < count; k++) {
    serialSeq++;
    // 第一个串号可能是 SN 也可能是 IMEI（真实数据两种都有）
    const kind = k === 0 ? (rnd() < 0.3 ? 'imei' : 'sn') : 'imei';
    serials.push(makeSerial(kind, serialSeq * 7 + k));
  }

  rows.push({
    Store: STORE.name,
    Category1: cat1,
    Category2: cat2,
    Category3: cat3,
    Brand: brand,
    Model: model,
    ProName: `${cat1}/${brand}/${model || '通用'} 测试机型 ${i + 1}${tag ? '[' + tag + ']' : ''}`,
    OldFlag: tag,
    Category4: rnd() < 0.3 ? model : '',
    Imei: serials[0],
    ProId: 9000000 + i,
    SNCode: String(100000 + i),
    SubImei: serials.join(' '),
    CategoryId: 1800000 + (i % 40),
    ProCount: 1,
    Imei2: serials[1] || '',
    Imei3: serials[2] || '',
    RowId: i + 1,
    PriceLabel: rnd() < 0.15 ? '标签' + int(1, 9) : '',
  });
}

/* 无串号的行：配件/促销品，数量 > 1（少数等于 1） */
for (let i = 0; i < NON_SERIAL_ROWS; i++) {
  const qty = i % 4 === 0 ? 1 : int(2, 60);
  rows.push({
    Store: STORE.name,
    Category1: pick(['手机平板周边', '音频产品', '智能家居', '外购散件']),
    Category2: pick(['配件', '促销品', '其他']),
    Category3: '',
    Brand: pick(BRANDS),
    Model: '',
    ProName: `配件/促销品 测试物料 ${i + 1}`,
    OldFlag: '',
    Category4: '',
    Imei: '',
    ProId: 8000000 + i,
    SNCode: String(200000 + i),
    SubImei: '',
    CategoryId: 1700000 + i,
    ProCount: qty,
    Imei2: '',
    Imei3: '',
    RowId: SERIAL_ROWS + i + 1,
    PriceLabel: '',
  });
}

/* ---------- 统计口径（测试以它为准） ---------- */
const serialRows = rows.filter((r) => (r.Imei || '').trim());
const nonSerialRows = rows.filter((r) => !(r.Imei || '').trim());
const meta = {
  storeId: STORE.id,
  storeName: STORE.name,
  date: process.env.IC_FIXTURE_DATE || new Date().toISOString().slice(0, 10),
  capturedAt: new Date().toISOString(),
  synthetic: true,
  note: '合成夹具：结构同真实抓取，商品名与串号均为生成数据，不含真实门店信息',
  totalRows: rows.length,
  serialRows: serialRows.length,
  nonSerialRows: nonSerialRows.length,
  totalSerials: serialRows.reduce((a, r) => a + [r.Imei, r.Imei2, r.Imei3].filter((x) => (x || '').trim()).length, 0),
  multiSerialRows: serialRows.filter((r) => (r.Imei2 || '').trim()).length,
  tripleSerialRows: serialRows.filter((r) => (r.Imei3 || '').trim()).length,
  bookQty: rows.reduce((a, r) => a + (Number(r.ProCount) || 0), 0),
};

const prefix = process.argv[2] || `synthetic-store-${STORE.id}-${meta.date}`;
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, `${prefix}.json`), JSON.stringify(rows));
fs.writeFileSync(path.join(OUT_DIR, `${prefix}.meta.json`), JSON.stringify(meta, null, 1));

console.log(`已生成合成夹具 test/fixtures/${prefix}.json`);
console.log(
  `  总行 ${meta.totalRows}｜有串号 ${meta.serialRows}｜无串号 ${meta.nonSerialRows}｜` +
    `串号总数 ${meta.totalSerials}｜多串号 ${meta.multiSerialRows}｜三串号 ${meta.tripleSerialRows}｜账面数量 ${meta.bookQty}`
);
