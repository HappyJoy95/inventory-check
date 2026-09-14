/* 真实接口联调测试：node test/live.test.mjs
 * 需要联网，会真实调用云商 ERP 接口（只读查询，不写任何数据）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/core.js';
import '../src/erp.js';
import { CREDS, skipIfNoCreds, writeFixture, explainCredFailure } from './env.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const { Stocktake, normalizeAll, normalizeItem, todayStr, normCode } = globalThis.IC.core;
const { fetchWarehouses, fetchInventory, fetchGlobalIndex } = globalThis.IC.erp;

let pass = 0,
  fail = 0;
function eq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
    console.log(`  ✓ ${label} = ${JSON.stringify(actual)}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}  期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

if (skipIfNoCreds('生产接口联调（仓库列表 / 库存拉取 / 扫码匹配 / 全库索引）')) process.exit(0);

const TODAY = todayStr();
// 门店也由外部提供，仓库里不留任何真实门店标识
const STORE = process.env.ERP_STORE_ID || '';
const STORE_NAME = process.env.ERP_STORE_NAME || '';
if (!STORE) {
  console.log('\n[跳过] 生产接口联调需要指定门店：ERP_STORE_ID=<仓库Id> [ERP_STORE_NAME=<仓库名>]');
  process.exit(0);
}

console.log(`— 仓库列表（${TODAY}）—`);
const t0 = Date.now();
let whs;
try {
  whs = await fetchWarehouses(CREDS);
} catch (e) {
  if (explainCredFailure(e)) process.exit(1);
  throw e;
}
console.log(`  耗时 ${Date.now() - t0}ms`);
eq(whs.length > 30, true, '仓库数量 > 30');
const target = whs.find((w) => w.id === STORE);
eq(!!target, true, `找到目标仓 ${STORE}`);
ok(STORE_NAME ? target.name === STORE_NAME : !!target.name, '仓名匹配', target.name);
console.log(`    所属门店：${target.branchName}`);

console.log('\n— 拉取门店库存 —');
const t1 = Date.now();
const inv = await fetchInventory(CREDS, { date: TODAY, storeId: STORE, onProgress: (d, t) => process.stdout.write(`\r    进度 ${d}/${t}   `) });
console.log(`\n  耗时 ${Date.now() - t1}ms，共 ${inv.rows.length} 行 / TotalRows=${inv.totalRows} / ${inv.pages} 页`);
eq(inv.rows.length, inv.totalRows, '拉全了（行数=TotalRows）');

const items = normalizeAll(inv.rows, STORE);
const serialItems = items.filter((i) => i.hasSerial);
const nonSerial = items.filter((i) => !i.hasSerial);
eq(serialItems.length + nonSerial.length, items.length, '有串号+无串号=总行数');
console.log(`    有串号 ${serialItems.length} 行，无串号 ${nonSerial.length} 行，账面合计 ${items.reduce((a, i) => a + i.qty, 0)}`);
eq(inv.rows.every((r) => r.Store === STORE_NAME), true, '返回数据全部属于该仓');

// 串号唯一性
const codeCount = new Map();
serialItems.forEach((i) => i.serials.forEach((c) => codeCount.set(normCode(c), (codeCount.get(normCode(c)) || 0) + 1)));
const dupCodes = [...codeCount.entries()].filter(([, n]) => n > 1);
eq(dupCodes.length, 0, '本仓串号无重复');

// 存一份样例数据，供离线回归使用
if (!writeFixture) {
  console.log('\n[夹具] 未加 --write-fixture，本次不覆盖回归夹具（避免生产数据悄悄改掉回归基准）');
} else {
fs.mkdirSync(path.join(dir, 'fixtures'), { recursive: true });
const fixtureName = `store-${STORE}-${TODAY}`;
fs.writeFileSync(path.join(dir, 'fixtures', `${fixtureName}.json`), JSON.stringify(inv.rows));
// 同时记录抓取当时的统计口径：ERP 是生产库，库存随时会变，
// 离线回归测试以这份 meta 为准，而不是写死 409/444 这类数字
fs.writeFileSync(
  path.join(dir, 'fixtures', `${fixtureName}.meta.json`),
  JSON.stringify(
    {
      storeId: STORE,
      storeName: STORE_NAME,
      date: TODAY,
      capturedAt: new Date().toISOString(),
      totalRows: items.length,
      serialRows: serialItems.length,
      nonSerialRows: nonSerial.length,
      totalSerials: serialItems.reduce((a, i) => a + i.serials.length, 0),
      multiSerialRows: serialItems.filter((i) => i.serials.length > 1).length,
      tripleSerialRows: serialItems.filter((i) => i.serials.length === 3).length,
      bookQty: items.reduce((a, i) => a + i.qty, 0),
    },
    null,
    1
  )
);
console.log(`    样例已存 test/fixtures/${fixtureName}.json（含统计口径 meta）`);
}

console.log('\n— 扫码流程（真实串号）—');
const st = new Stocktake({ date: TODAY, storeId: STORE, storeName: STORE_NAME, items });
const phone = serialItems.find((i) => i.serials.length >= 2) || serialItems[0];
const r1 = st.scan(phone.serials[0]);
eq(r1.status, 'ok', `扫 ${phone.serials[0]} → 已盘到`);
if (phone.serials[1]) {
  const r2 = st.scan(phone.serials[1]);
  eq(r2.status, 'dup', `再扫同机 ${phone.serials[1]} → 重复`);
}
const other = serialItems.find((i) => i !== phone);
eq(st.scan(other.serials[0]).status, 'ok', '扫第二台 → 已盘到');
eq(st.scan('  ' + phone.serials[0].toLowerCase() + ' ').status, 'dup', '大小写+空格容错');
const before = st.stats();
eq(before.foundCount, 2, '已盘 2 台');
eq(before.missingCount, serialItems.length - 2, `未盘 ${serialItems.length - 2} 台`);
eq(before.shouldCount, serialItems.length, '应盘数=有串号行数');

console.log('\n— 全库索引（识别表外码归属）—');
const t2 = Date.now();
const gidx = await fetchGlobalIndex(CREDS, { date: TODAY });
console.log(`  耗时 ${Date.now() - t2}ms，索引串号 ${gidx.size} 个`);
eq(gidx.size > 20000, true, '全库串号索引已建立');
// 找一个属于别仓的串号来模拟"窜货码"
let foreignCode = null;
for (const [code, owners] of gidx) {
  if (owners.length === 1 && owners[0].store !== STORE_NAME && /^\d{15}$/.test(code)) {
    foreignCode = code;
    break;
  }
}
st.setGlobalIndex(gidx);
const rf = st.scan(foreignCode);
eq(rf.status, 'foreign', `扫别仓串号 ${foreignCode} → 非本店库存`);
console.log(`    提示：属于 ${rf.owners.map((o) => o.store).join('、')}`);
eq(st.scan('THIS-CODE-DOES-NOT-EXIST-999').status, 'unknown', '不存在的码 → 查无此码');
eq(st.extras().length, 2, '表外码 2 个（别仓+查无）');
const after = st.stats();
eq(after.extraCount, 2, '汇总表外码 2 个');
eq(after.foundCount, 2, '异常码不影响已盘点数');

console.log('\n— 结果导出结构 —');
const miss = st.missing();
eq(miss.length, serialItems.length - 2, '未扫清单条数正确');
eq(miss.every((i) => i.hasSerial && !i.matchedCode), true, '未扫清单只含有串号且未扫的');
eq(st.found().length, 2, '已扫明细 2 条');
eq(st.nonSerialRows().length, nonSerial.length, '无串号清单条数正确');

console.log(`\n联调测试：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
