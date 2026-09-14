/* 离线回归测试（用真实抓取的库存快照做夹具，不需要联网）
 * 夹具由 test/live.test.mjs 生成：xxx.json（库存行）+ xxx.meta.json（抓取当时的统计口径）
 *
 * 注意：ERP 是生产库，库存随时会变。所以这里不写死 409/444 这类数字，
 * 而是与 meta 对齐——测的是「解析与判定逻辑有没有回归」，不是数据本身。
 * 用法：node test/fixture.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/core.js';
import '../src/erp.js';
import { findFixture, missingFixtureHint } from './fixture-file.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));

let pass = 0,
  fail = 0;
const eq = (a, e, label) => {
  if (JSON.stringify(a) === JSON.stringify(e)) {
    pass++;
    console.log(`  ✓ ${label} = ${JSON.stringify(a)}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}  期望 ${JSON.stringify(e)}，实际 ${JSON.stringify(a)}`);
  }
};

const fx = findFixture();
if (!fx) {
  missingFixtureHint();
  process.exit(1);
}
const { file, meta } = fx;
const rows = fx.rows;

const { Stocktake, normalizeAll, normCode } = globalThis.IC.core;
const STORE = meta.storeId;
const NAME = meta.storeName;
console.log(`夹具：${file}（${meta.synthetic ? '合成数据' : '真实抓取'}，生成于 ${meta.capturedAt}）`);

console.log('\n— 解析结果与抓取时的口径一致 —');
eq(rows.length, meta.totalRows, '总行数');
eq(
  rows.every((r) => r.Store === NAME),
  true,
  `全部属于 ${NAME}`
);
const items = normalizeAll(rows, STORE);
const serial = items.filter((i) => i.hasSerial);
const nonSerial = items.filter((i) => !i.hasSerial);
eq(serial.length, meta.serialRows, '有串号行数');
eq(nonSerial.length, meta.nonSerialRows, '无串号行数');
eq(serial.length + nonSerial.length, items.length, '有串号 + 无串号 = 总行数');
eq(
  serial.every((i) => i.qty === 1),
  true,
  '有串号行在库数量均为 1'
);
eq(items.reduce((a, i) => a + i.serials.length, 0), meta.totalSerials, '串号总数');
eq(items.filter((i) => i.serials.length > 1).length, meta.multiSerialRows, '一台多串号的行数');
eq(items.filter((i) => i.serials.length === 3).length, meta.tripleSerialRows, '带串号3的行数');
eq(items.reduce((a, i) => a + i.qty, 0), meta.bookQty, '账面数量合计');

console.log('\n— 串号取值 —');
eq(
  serial.every((i) => i.serials.every((c) => c === c.trim() && c.length > 0)),
  true,
  '串号已去空白且非空'
);
eq(
  serial.every((i) => i.serials.every((c) => i.serials.indexOf(c) === i.serials.lastIndexOf(c))),
  true,
  '同一行内串号不重复（SubImei 兜底没造成重复）'
);
const withSub = rows.find((r) => (r.SubImei || '').split(/\s+/).filter(Boolean).length > 1);
if (withSub) {
  const it = items.find((i) => i.serials.indexOf(withSub.Imei) >= 0); // 不再用行号找条目
  eq(it.serials.length >= 2, true, 'SubImei 里的多串号被正确拆出');
  eq(it.serials.indexOf(withSub.Imei) >= 0, true, '串号1 在解析结果内');
}

console.log('\n— 全量扫描模拟 —');
const st = new Stocktake({ date: meta.date, storeId: STORE, storeName: NAME, items });
const t0 = Date.now();
serial.forEach((i) => st.scan(i.serials[0]));
const cost = Date.now() - t0;
const s = st.stats();
eq(s.shouldCount, serial.length, '应盘 = 有串号行数');
eq(s.foundCount, serial.length, '全部扫到');
eq(s.scannedCount, serial.length, '全部算扫码盘到');
eq(s.manualCount, 0, '没有手工确认');
eq(s.missingCount, 0, '未扫到为 0');
eq(s.progress, 100, '完成率 100%');
eq(s.dupCount, 0, '无重复');
console.log(`    （扫描 ${serial.length} 台耗时 ${cost}ms）`);

console.log('\n— 同一台的其余串号再扫：应全部判重复 —');
let dupOk = 0,
  dupBad = 0;
serial.forEach((i) =>
  i.serials.slice(1).forEach((c) => (st.scan(c).status === 'dup' ? dupOk++ : dupBad++))
);
eq(dupBad, 0, '误判数');
eq(st.stats().foundCount, serial.length, '重复扫描不影响已盘数');

console.log('\n— 手工确认（样机没盒子扫不了码）—');
const stM = new Stocktake({ items: normalizeAll(rows, STORE) });
const target = stM.serialItems()[0];
stM.confirmFound(target.key, 1000);
stM.setManualNote(target.key, '样机在展台，无盒');
const sM = stM.stats();
eq(sM.manualCount, 1, '手工确认 1 台');
eq(sM.scannedCount, 0, '扫码 0 台');
eq(sM.foundCount, 1, '已盘 1 台');
eq(sM.missingCount, serial.length - 1, '未扫少一台');
eq(stM.manualNote(target.key), '样机在展台，无盒', '备注可读');
eq(stM.missing().some((i) => i.key === target.key), false, '确认过的不再出现在未扫清单');
eq(stM.confirmFound(target.key, 5000).manualAt, 1000, '重复确认保留最早时间');
stM.scan(target.serials[0], 2000);
eq(stM.stats().manualCount, 0, '扫到后自动转为扫码盘到');
eq(stM.manualNote(target.key), '样机在展台，无盒', '备注仍保留供追溯');
stM.undo();
eq(stM.stats().manualCount, 1, '撤销扫码后手工确认恢复');
eq(stM.stats().scannedCount, 0, '扫码数回到 0');
stM.unconfirmFound(target.key);
eq(stM.stats().missingCount, serial.length, '撤销确认后回到全部未扫');

console.log('\n— 无串号商品「标记已找到」—');
const stNs = new Stocktake({ items: normalizeAll(rows, STORE) });
const ns0 = stNs.nonSerialRows()[0];
eq(ns0.confirmed, false, '初始未确认');
eq(ns0.actual, null, '初始实盘为空');
stNs.confirmFound(ns0.item.key, 3000);
const nsAfter = stNs.nonSerialRows()[0];
eq(nsAfter.confirmed, true, '标记后为已确认');
eq(nsAfter.actual, ns0.book, '实盘自动等于账面');
eq(nsAfter.diff, 0, '差异为 0');
eq(stNs.stats().nonSerialCounted, 1, '计入无串号已盘行数');
eq(stNs.found().some((i) => i.key === ns0.item.key), true, '进入已盘明细');
eq(stNs.stats().foundCount, 0, '不影响有串号的已盘口径');
eq(stNs.stats().shouldCount, serial.length, '应盘口径不变');
stNs.setManualQty(ns0.item.key, ns0.book - 2);
eq(stNs.nonSerialRows()[0].diff, -2, '改实盘数量后差异 -2');
stNs.unconfirmFound(ns0.item.key);
eq(stNs.nonSerialRows()[0].confirmed, false, '可撤销确认');
eq(stNs.stats().nonSerialCounted, 1, '撤销确认但保留手工录入的数量');
eq(stNs.nonSerialRows()[0].actual, ns0.book - 2, '手填的数量没被清掉（只清自动带出的）');
eq(stNs.found().some((i) => i.key === ns0.item.key), false, '撤销后不在已盘明细里');
stNs.setManualQty(ns0.item.key, '');
eq(stNs.stats().nonSerialCounted, 0, '数量清空后回到未盘');

console.log('\n— 无串号商品：一键确认已填数量的行 —');
const stBk = new Stocktake({ items: normalizeAll(rows, STORE) });
const rows3 = stBk.nonSerialRows().slice(0, 3);
eq(stBk.pendingNonSerial().length, 0, '初始没有待提交的行');
rows3.forEach((r, i) => stBk.setManualQty(r.item.key, r.book + (i === 0 ? -1 : 0)));
eq(stBk.pendingNonSerial().length, 3, '填了 3 行数量 → 3 行待提交');
eq(stBk.manualNonSerial().length, 0, '但一行都还没确认');
const confirmed3 = stBk.confirmAllFilledNonSerial(4000);
eq(confirmed3.length, 3, '一键确认了 3 行');
eq(stBk.manualNonSerial().length, 3, '已确认 3 行');
eq(stBk.pendingNonSerial().length, 0, '没有残留的待提交行');
eq(
  stBk.nonSerialRows().filter((r) => !r.confirmed).length,
  nonSerial.length - 3,
  '待办列表（未确认）剩 = 总数 - 3'
);
eq(stBk.found().filter((i) => !i.hasSerial).length, 3, '这 3 行都进了已盘明细');
eq(stBk.stats().nonSerialDiff, -1, '手填的那行差异 -1 计入汇总');
eq(stBk.stats().foundCount, 0, '不影响有串号的已盘口径');
eq(stBk.stats().shouldCount, serial.length, '应盘口径不变');

console.log('\n— 异常码 —');
st.setGlobalIndex(new Map([[normCode('999000111222333'), [{ store: '别家门店库', name: '某机型' }]]]));
eq(st.scan('999000111222333').status, 'foreign', '别仓码判为非本店库存');
eq(st.scan('THIS-IS-NOT-A-REAL-CODE').status, 'unknown', '假码判为查无此码');
eq(st.extras().length, 2, '表外码 2 条');
eq(st.stats().extraCount, 2, '汇总表外码 2 条');
eq(st.missing().length, 0, '未扫到仍为 0');

console.log('\n— 无串号商品账实对照 —');
eq(st.nonSerialRows().length, nonSerial.length, '无串号商品行数与账面一致');
eq(
  st.nonSerialRows().every((r) => r.actual === null && r.diff === null),
  true,
  '未录入时实盘为空'
);
const first = st.nonSerialRows()[0];
eq(st.stats().nonSerialDiff, 0, '一行都没盘时差异为 0（不把未盘行当盘亏）');
st.manualQty[first.item.key] = first.book + 2;
eq(st.nonSerialRows()[0].diff, 2, '录入后该行差异 = +2');
eq(st.stats().nonSerialCounted, 1, '已手工盘过 1 行');
eq(st.stats().nonSerialBookCounted, first.book, '已盘部分账面只算这一行');
eq(st.stats().nonSerialDiff, 2, '汇总差异只比较已盘部分 = +2');
st.nonSerialRows().forEach((r) => (st.manualQty[r.item.key] = r.book - 1));
eq(st.stats().nonSerialCounted, nonSerial.length, '全部盘完');
eq(st.stats().nonSerialDiff, -nonSerial.length, '每行少 1 件时差异 = -行数');

console.log(`\n离线回归：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
