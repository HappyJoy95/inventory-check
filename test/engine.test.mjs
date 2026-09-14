/* 引擎单测（不依赖网络）：node test/engine.test.mjs */
import '../src/core.js';

const { Stocktake, normalizeAll, normCode } = globalThis.IC.core;

let pass = 0;
let fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`);
  }
}
function ok(cond, label) {
  eq(!!cond, true, label);
}

console.log('— 归一化 —');
eq(normCode(' 5fv0225a30002656 '), '5FV0225A30002656', '去空格并大写');
eq(normCode('86 67 0907 0265 938'), '866709070265938', '去掉内部空格');

const rows = [
  {
    Store: '测试店库',
    ProName: '智能手机/Mate 70',
    Category1: '手机',
    Imei: 'SN-AAA-001',
    Imei2: '860000000000001',
    Imei3: '',
    SubImei: 'SN-AAA-001 860000000000001',
    ProId: 111,
    ProCount: 1,
    RowId: 1,
    OldFlag: '新',
  },
  {
    Store: '测试店库',
    ProName: '智能手机/Mate 70',
    Category1: '手机',
    Imei: 'SN-BBB-002',
    Imei2: '',
    Imei3: '',
    SubImei: 'SN-BBB-002',
    ProId: 111,
    ProCount: 1,
    RowId: 2,
  },
  {
    Store: '测试店库',
    ProName: '无线耳机/FreeBuds',
    Category1: '音频产品',
    Imei: '',
    Imei2: '',
    Imei3: '',
    SubImei: '',
    ProId: 222,
    ProCount: 8,
    RowId: 3,
  },
];

const items = normalizeAll(rows, '999');
console.log('— 归一化明细 —');
eq(items.length, 3, '3 条明细');
eq(items[0].serials, ['SN-AAA-001', '860000000000001'], '串号1+2 合并');
eq(items[0].hasSerial, true, '有串号');
eq(items[2].hasSerial, false, '无串号');
eq(items[2].qty, 8, '无串号数量 8');

// uid 身份（不再用报表行号）：有串号按主串号，无串号按商品属性
const A = items[0].uid; // SN-AAA-001
const B = items[1].uid; // SN-BBB-002
const N = items[2].uid; // 无串号：无线耳机/FreeBuds
console.log('— uid 身份 —');
eq(A, 'sn:SN-AAA-001', '有串号按主串号生成 uid');
eq(B, 'sn:SN-BBB-002', '第二台按主串号生成 uid');
eq(N.indexOf('ns:999|222|') === 0, true, '无串号按仓库+商品编码+属性生成 uid');
eq(items.every((i) => i.key === i.uid), true, '条目 key 就是 uid');
eq(items.some((i) => i.dupUid), false, '本夹具没有不唯一的身份');

const st = new Stocktake({ date: '2026-09-14', storeId: '999', storeName: '测试店库', items: items });

console.log('— 扫码判定 —');
eq(st.scan('SN-AAA-001', 1000).status, 'ok', '扫串号1 → 已盘到');
eq(st.scan('860000000000001', 2000).status, 'dup', '扫同一台的串号2 → 重复');
eq(st.scan('sn-aaa-001 ', 3000).status, 'dup', '大小写/空格差异也认出重复');
eq(st.scan('SN-BBB-002', 4000).status, 'ok', '扫第二台 → 已盘到');

let r = st.scan('999999999999999', 5000);
eq(r.status, 'unknown', '陌生码 → 查无此码');
eq(r.message, '本店账面没有该码，归属尚未核实', '无全库索引时的提示（不下"全公司都没有"的结论）');

// 装入全库索引后，异常码自动回填归属
st.setGlobalIndex(new Map([['999999999999999', [{ store: '别的店库', name: '某商品' }]]]));
eq(st.extras()[0].status, 'foreign', '索引到位后回填为「非本店库存」');
eq(st.extras()[0].owners[0].store, '别的店库', '带出归属仓');

console.log('— 结果集 —');
const stats = st.stats();
eq(stats.shouldCount, 2, '应盘 2 台');
eq(stats.foundCount, 2, '已盘 2 台');
eq(stats.missingCount, 0, '未盘 0 台');
eq(stats.progress, 100, '进度 100%');
eq(stats.extraCount, 1, '表外码 1 个');
eq(stats.nonSerialRows, 1, '无串号商品 1 行');
eq(stats.nonSerialBook, 8, '无串号账面 8');
eq(stats.bookTotal, 10, '账面合计 10');

console.log('— 撤销 —');
const undone = st.undo();
eq(undone.code, '999999999999999', '撤销的是最后一笔（异常码）');
eq(st.extras().length, 0, '表外码随撤销消失');
eq(st.stats().foundCount, 2, '撤销异常码不影响已盘点数');

const stU = new Stocktake({ items: normalizeAll(rows, '999') });
stU.scan('SN-AAA-001', 1);
stU.scan('SN-BBB-002', 2);
stU.undo();
eq(stU.stats().foundCount, 1, '撤销后已盘 1 台');
eq(stU.missing().length, 1, '撤销后未盘 1 台');
eq(stU.missing()[0].serials[0], 'SN-BBB-002', '未盘的就是撤销那台');
eq(stU.scan('SN-BBB-002', 3).status, 'ok', '撤销后可以重新扫该码');

console.log('— 删除中间一笔 —');
const st2 = new Stocktake({ items: normalizeAll(rows, '999') });
st2.scan('SN-AAA-001', 1);
st2.scan('SN-BBB-002', 2);
st2.removeScan(0);
eq(st2.stats().foundCount, 1, '删掉第一笔后剩 1 台已盘');
eq(st2.scanByCode.has('SNAAA001'), false, '被删的码从索引移除');
eq(st2.scan('SN-AAA-001', 3).status, 'ok', '被删的码可以重新扫');

console.log('— 在途拆分（方案A：在库配在库、在途配在途）—');
const rowsT = [
  { Store: '测试店库', ProName: '手机T', Category1: '手机', Imei: 'SN-T1', ProCount: 1, ProCount_OnTransfer: 0, RowId: 1 },
  { Store: '测试店库', ProName: '手机T2', Category1: '手机', Imei: 'SN-T2', ProCount: 0, ProCount_OnTransfer: 1, RowId: 2 },
  { Store: '测试店库', ProName: '配件Z', Category1: '周边', ProId: 700, ProCount: 10, ProCount_OnTransfer: 5, RowId: 3 },
];
const itemsT = normalizeAll(rowsT, '999');
eq(itemsT.length, 4, '3 行账目拆成 4 条（配件Z 在库/在途各一条）');
const zOn = itemsT.find((i) => i.proId === '700' && !i.inTransit);
const zWay = itemsT.find((i) => i.proId === '700' && i.inTransit);
eq(zOn.qty, 10, '在库那条数量 = 10');
eq(zWay.qty, 5, '在途那条数量 = 5');
eq(zOn.uid.indexOf('ns:') === 0, true, '在库条目 uid 用 ns: 前缀');
eq(zWay.uid.indexOf('nst:') === 0, true, '在途条目 uid 用 nst: 前缀（不会和在库撞）');
ok(zOn.uid !== zWay.uid, '两条 uid 不同');
const t2 = itemsT.find((i) => i.serials[0] === 'SN-T2');
eq(t2.inTransit, true, '在库为 0、在途为 1 的串号行整行算在途');
eq(t2.qty, 1, '它的数量取在途数量，不显示 0');
const t1 = itemsT.find((i) => i.serials[0] === 'SN-T1');
eq(t1.inTransit, false, '正常在库行不受影响');
eq(t1.qtyOnTransfer, 0, '它的在途数量为 0');

const stT = new Stocktake({ items: itemsT });
const sT = stT.stats();
eq(sT.shouldCount, 1, '应盘只算在库且有串号的 1 台');
eq(sT.missingCount, 1, '未扫到 1 台');
eq(sT.inTransitCount, 2, '在途待入库 2 条（串号在途 + 配件在途）');
eq(sT.nonSerialRows, 1, '无串号商品只算在库那条（在途的不进来核对）');
eq(sT.nonSerialBook, 10, '无串号账面 = 在库 10（不含在途 5）');
eq(stT.inTransitItems().find((i) => i.proId === '700').qty, 5, '在途清单里能看到配件的 5 件');
eq(sT.bookOnHand, 11, '在库账面合计 = 1 + 10');
eq(sT.bookTotal, 17, '账面合计（含在途）= 1 + 10 + 1 + 5');
stT.setManualQty(zOn.uid, 9);
eq(stT.nonSerialRows()[0].diff, -1, '实盘差异只对在库那条算（10→9 = -1）');
eq(stT.stats().nonSerialDiff, -1, '在途那 5 件不进差异计算');

console.log('— 手工确认（样机没盒子扫不了码）—');
const stM = new Stocktake({ items: normalizeAll(rows, '999') });
eq(stM.stats().missingCount, 2, '初始未扫 2 台');
eq(stM.stats().manualCount, 0, '初始手工确认 0');
eq(stM.confirmFound(A, 5000).uid, A, '手工确认第 1 台');
eq(stM.stats().foundCount, 1, '已盘 1 台');
eq(stM.stats().scannedCount, 0, '扫码盘到 0 台');
eq(stM.stats().manualCount, 1, '手工确认 1 台');
eq(stM.stats().missingCount, 1, '未扫减到 1 台');
eq(stM.missing()[0].serials[0], 'SN-BBB-002', '未扫清单里只剩没确认的那台');
eq(stM.manualList()[0].serials[0], 'SN-AAA-001', '手工确认清单里是确认的那台');
eq(stM.confirmFound(A, 9999).manualAt, 5000, '重复确认是幂等的（保留最早确认时间）');
eq(stM.unconfirmFound(A).uid, A, '（清理）撤销 A 的确认');
stM.confirmFound(A, 5000);
eq(stM.confirmFound(N).uid, N, '无串号商品也能「标记已找到」');
eq(stM.isManualFound(A), true, 'isManualFound 为真');

stM.setManualNote(A, '样机在展台，无盒');
eq(stM.manualNote(A), '样机在展台，无盒', '确认备注可写可读');
stM.setManualNote(A, '');
eq(stM.manualNote(A), '', '备注可清空');

stM.confirmFound(B, 6000);
eq(stM.stats().foundCount, 2, '两台都手工确认');
eq(stM.stats().missingCount, 0, '未扫清零');
eq(stM.stats().progress, 100, '进度 100%');

eq(stM.unconfirmFound(B).uid, B, '撤销第 2 台的手工确认');
eq(stM.stats().foundCount, 1, '撤销后已盘 1 台');
eq(stM.stats().manualCount, 1, '撤销后手工确认 1 台');
eq(stM.stats().missingCount, 1, '撤销后未扫 1 台');
eq(stM.isManualFound(B), false, 'B 不再是手工确认');

console.log('— 无串号商品的「标记已找到」—');
const stNs = new Stocktake({ items: normalizeAll(rows, '999') });
eq(stNs.stats().nonSerialCounted, 0, '初始没有已盘的无串号行');
eq(stNs.nonSerialRows()[0].actual, null, '初始实盘为空');
eq(stNs.nonSerialRows()[0].confirmed, false, '初始未确认');
stNs.confirmFound(N, 7000);
eq(stNs.isManualFound(N), true, '标记后为已确认');
eq(stNs.nonSerialRows()[0].actual, 8, '实盘数量自动等于账面 8');
eq(stNs.nonSerialRows()[0].diff, 0, '差异自动为 0');
eq(stNs.nonSerialRows()[0].confirmed, true, '该行标记为已确认');
eq(stNs.stats().nonSerialCounted, 1, '计入无串号已盘行数');
eq(stNs.found().some((it) => it.key === N), true, '会出现在已盘明细里');
eq(stNs.found().length, 1, '已盘明细共 1 条');
eq(stNs.stats().foundCount, 0, '不计入「有串号的已盘数」（口径不混）');
eq(stNs.stats().shouldCount, 2, '应盘仍是有串号的 2 台');
eq(stNs.stats().manualCount, 0, '也不计入「其中手工确认」');
eq(stNs.stats().nonSerialDiff, 0, '无串号差异为 0');
eq(stNs.confirmFound(N, 8000).manualAt, 7000, '重复标记保留最早时间');
stNs.unconfirmFound(N);
eq(stNs.isManualFound(N), false, '可撤销确认');
eq(stNs.stats().nonSerialCounted, 0, '撤销后不计入已盘行数');
eq(stNs.found().some((it) => it.key === N), false, '撤销后不在已盘明细里');
eq(stNs.nonSerialRows()[0].actual, null, '撤销后实盘回到空（自动带出的数量已清掉）');
stNs.setManualQty(N, 6);
eq(stNs.nonSerialRows()[0].diff, -2, '手动改实盘数量仍算差异 -2');
eq(stNs.stats().nonSerialCounted, 1, '手工录入数量也算已盘过的行');
eq(stNs.stats().nonSerialDiff, -2, '汇总差异 -2');

console.log('— 一键确认已填数量的无串号商品 —');
const stB = new Stocktake({ items: normalizeAll(rows, '999') });
eq(stB.pendingNonSerial().length, 0, '没填数量时没有待确认的');
eq(stB.confirmAllFilledNonSerial().length, 0, '一个都没填时一键确认不动任何行');
eq(stB.stats().nonSerialCounted, 0, '仍然 0 行已盘');
stB.setManualQty(N, 6);
eq(stB.pendingNonSerial().length, 1, '填了数量后有 1 行待确认');
eq(stB.nonSerialRows()[0].diff, -2, '差异 -2');
const done = stB.confirmAllFilledNonSerial(9000);
eq(done.length, 1, '一键确认了 1 行');
eq(stB.isManualFound(N), true, '标记为已确认');
eq(stB.stats().nonSerialCounted, 1, '计入已盘行数');
eq(stB.stats().foundCount, 0, '不影响有串号的已盘口径');
eq(stB.pendingNonSerial().length, 0, '确认后没有待确认的了');
stB.unconfirmFound(N);
eq(stB.nonSerialRows()[0].actual, 6, '撤销确认后手填的 6 保留（不是自动带出的）');
stB.setManualQty(N, '');
eq(stB.nonSerialRows()[0].actual, null, '清空数量后回到未盘');
stB.confirmFound(N);
eq(stB.nonSerialRows()[0].actual, 8, '确认时自动带出账面数量 8');
stB.unconfirmFound(N);
eq(stB.nonSerialRows()[0].actual, null, '撤销后自动带出的数量被清掉');

eq(stNs.manualNonSerial().length, 0, '只录数量没点确认时，已确认数仍为 0（两种口径不混）');
stNs.confirmFound(N);
eq(stNs.manualNonSerial().length, 1, '点确认后已确认数 = 1');
eq(stNs.stats().nonSerialCounted, 1, '已录数量行数也是 1');

console.log('— 一键确认可以只提交指定的行（配合界面筛选）—');
const stK = new Stocktake({ items: normalizeAll(rows, '999') });
stK.setManualQty(N, 5);
eq(stK.confirmAllFilledNonSerial(1000, [N]).length, 1, '指定 uid 时只提交这一行');
eq(stK.isManualFound(N), true, '该行已确认');
const stK2 = new Stocktake({ items: normalizeAll(rows, '999') });
stK2.setManualQty(N, 5);
eq(stK2.confirmAllFilledNonSerial(1000, [A]).length, 0, '指定的 uid 没填数量时不提交');
eq(stK2.isManualFound(N), false, '别的行不受影响');
eq(stK2.confirmAllFilledNonSerial(1000, []).length, 1, '传空数组则回到「全部已填数量」的语义');

console.log('— 手工确认与扫码的关系 —');
const stN = new Stocktake({ items: normalizeAll(rows, '999') });
stN.confirmFound(A, 100);
stN.scan('SN-AAA-001', 200); // 后来又扫到了
eq(stN.stats().manualCount, 0, '扫到之后不再算手工确认');
eq(stN.stats().scannedCount, 1, '改成算扫码盘到');
eq(stN.stats().foundCount, 1, '已盘数不重复计算');
eq(stN.manualList().length, 0, '手工确认清单为空');
stN.undo(); // 撤销这次扫码
eq(stN.stats().manualCount, 1, '撤销扫码后手工确认自动恢复');
eq(stN.stats().scannedCount, 0, '扫码数回到 0');
eq(stN.scan('SN-BBB-002', 300).status, 'ok', '其它机器扫码不受影响');

console.log('— 手工确认的持久化 —');
const stP = new Stocktake({ items: normalizeAll(rows, '999') });
stP.confirmFound(A, 111);
stP.setManualNote(A, '样机无盒');
stP.scan('SN-BBB-002', 222);
const snapM = JSON.parse(JSON.stringify(stP.toJSON()));
const stQ = new Stocktake({ items: normalizeAll(rows, '999') });
stQ.restore(snapM);
eq(stQ.stats().manualCount, 1, '恢复后手工确认数一致');
eq(stQ.stats().scannedCount, 1, '恢复后扫码数一致');
eq(stQ.stats().missingCount, 0, '恢复后未扫为 0');
eq(stQ.manualNote(A), '样机无盒', '恢复后备注保留');
eq(stQ.isManualFound(A), true, '恢复后 A 仍是手工确认');
eq(stQ.isManualFound(B), false, '恢复后 B 不是手工确认');

console.log('— 单独撤销某一条扫码 —');
const stU2 = new Stocktake({ items: normalizeAll(rows, '999') });
stU2.scan('SN-AAA-001', 1);
stU2.scan('SN-BBB-002', 2);
stU2.scan('ZZ-NOT-EXIST', 3);
eq(stU2.stats().foundCount, 2, '先扫两台 + 一个陌生码');
const recU2 = stU2.undoScanForItem('sn:SN-AAA-001');
eq(recU2 && recU2.code, 'SN-AAA-001', '撤销回的是那一台的记录（码保留连字符）');
eq(stU2.stats().foundCount, 1, '只剩 1 台已盘');
eq(stU2.missing().some((i) => i.serials[0] === 'SN-AAA-001'), true, '被撤销的那台回到未扫到');
eq(stU2.missing().some((i) => i.serials[0] === 'SN-BBB-002'), false, '别的台不受影响');
eq(stU2.scans.length, 2, '流水里还剩 2 条（另一台 + 陌生码）');
eq(stU2.extras().length, 1, '陌生码的记录没被牵连');
eq(stU2.undoScanForItem('sn:SN-AAA-001'), null, '再撤销同一台返回 null（已经没记录了）');

// 重复扫的场景：删掉「已盘到」那条后，重复那条应当顶上
const stU3 = new Stocktake({ items: normalizeAll(rows, '999') });
stU3.scan('SN-AAA-001', 1);
stU3.scan('SN-AAA-001', 2);
eq(stU3.scans.length, 2, '同码扫两次记两条');
eq(stU3.stats().foundCount, 1, '只算一台已盘');
stU3.undoScanForItem('sn:SN-AAA-001');
eq(stU3.scans.length, 1, '删掉一条后剩一条');
eq(stU3.stats().foundCount, 1, '剩下那条（原来的重复）顶上，仍是已盘');

// 按码删除：表外码可以整条删掉
const stU4 = new Stocktake({ items: normalizeAll(rows, '999') });
stU4.scan('ZZ-1', 1);
stU4.scan('ZZ-1', 2);
stU4.scan('ZZ-2', 3);
eq(stU4.extras().length, 2, '两个陌生码');
eq(stU4.removeCode('ZZ-1'), 2, '删掉 ZZ-1 的 2 条记录');
eq(stU4.extras().length, 1, '只剩 ZZ-2');
eq(stU4.removeCode('ZZ-9'), 0, '删不存在的码返回 0');
stU4.scan('SN-AAA-001', 4);
eq(stU4.removeCode('SN-AAA-001'), 1, '已盘到的码也能整条删');
eq(stU4.stats().foundCount, 0, '删完后回到未盘');

console.log('— 无串号账实对照 —');
const st3 = new Stocktake({ items: normalizeAll(rows, '999') });
st3.setManualQty(N, 6);
const nsr = st3.nonSerialRows();
eq(nsr.length, 1, '无串号 1 行');
eq(nsr[0].book, 8, '账面 8');
eq(nsr[0].actual, 6, '实盘 6');
eq(nsr[0].diff, -2, '差异 -2');
eq(st3.stats().nonSerialDiff, -2, '汇总差异 -2');

console.log('— 存续盘（序列化/恢复） —');
const snapshot = {
  v: 1,
  storeId: '999',
  storeName: '测试店库',
  date: '2026-09-14',
  scans: [{ code: 'SN-BBB-002', ts: 2, note: '' }],
  manualQty: { [N]: 6 },
  remarks: {},
};
const st4 = new Stocktake({ items: normalizeAll(rows, '999') });
st4.restore(snapshot);
eq(st4.stats().foundCount, 1, '恢复后已盘数一致');
eq(st4.scans.length, 1, '恢复后流水一致');
eq(st4.missing()[0].serials[0], 'SN-AAA-001', '恢复后未盘清单正确');
eq(st4.manualQty[N], 6, '恢复后手工实盘数保留');
const roundTrip = JSON.parse(JSON.stringify(st4.toJSON()));
eq(roundTrip.scans.length, 1, '再次序列化可往返');

console.log(`\n引擎单测：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
