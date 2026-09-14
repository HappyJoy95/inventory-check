/* 会话与冻结账面测试（全离线，不需要网络/凭证）
 * 用法：node test/session.test.mjs
 *
 * 覆盖 review 要求：
 *  - 行号重排、账面增删，都不能让 A 商品的数量/确认状态转移到 B
 *  - 有串号按串号关联；无串号按仓库+商品编码+完整分组属性核对
 *  - 匹配不唯一的条目禁止自动继承确认状态
 *  - 冻结账面 + 状态可以完整往返（含只手工确认、只写备注的会话）
 *  - 保存失败（配额/禁用）必须抛出，不静默吞掉
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/core.js';
import '../src/store.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const { Stocktake, normalizeAll, bookFromItems, itemsFromBook, diffBooks, normCode } = globalThis.IC.core;
const store = globalThis.IC.store;

/* ---------- 极简 localStorage 打桩（含配额与禁用两种失败） ---------- */
function installStorage(opt) {
  opt = opt || {};
  const map = new Map();
  const ls = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if (opt.disabled) {
        const e = new Error('storage disabled');
        e.name = 'SecurityError';
        throw e;
      }
      const total = [...map.entries()].reduce((a, [kk, vv]) => a + (kk === k ? 0 : vv.length), 0) + String(v).length;
      if (opt.quotaBytes && total > opt.quotaBytes) {
        const e = new Error('quota');
        e.name = 'QuotaExceededError';
        throw e;
      }
      map.set(k, String(v));
    },
    removeItem: (k) => map.delete(k),
  };
  globalThis.localStorage = ls;
  return map;
}

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
const ok = (c, label, extra) => {
  if (c) {
    pass++;
    console.log(`  ✓ ${label}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`);
  }
};

installStorage();

/* ---------- 造两版账面 ---------- */
const rows = [
  { Store: '测试库', ProName: '手机A', Category1: '手机', Imei: 'SN-A', ProCount: 1, RowId: 1 },
  { Store: '测试库', ProName: '手机B', Category1: '手机', Imei: 'SN-B', ProCount: 1, RowId: 2 },
  { Store: '测试库', ProName: '手机C', Category1: '手机', Imei: 'SN-C', ProCount: 1, RowId: 3 },
  { Store: '测试库', ProName: '配件X', Category1: '周边', ProId: 900, ProCount: 10, RowId: 4 },
  { Store: '测试库', ProName: '配件Y', Category1: '周边', ProId: 901, ProCount: 5, RowId: 5 },
];

console.log('— uid 身份不依赖行号 —');
const items1 = normalizeAll(rows, '100001');
eq(items1[0].uid, 'sn:SN-A', '有串号按主串号');
eq(items1[3].uid.indexOf('ns:100001|900|') === 0, true, '无串号按仓库+商品编码+属性');

// 模拟"库存变动 + 行号重排"：前面插一行，原 A/B/C 的 RowId 全部位移
const rows2 = [
  { Store: '测试库', ProName: '新来的D', Category1: '手机', Imei: 'SN-D', ProCount: 1, RowId: 1 },
  ...rows.map((r, i) => Object.assign({}, r, { RowId: i + 2 })),
];
const items2 = normalizeAll(rows2, '100001');
eq(items2.find((i) => i.serials[0] === 'SN-A').uid, 'sn:SN-A', '重排后 A 的 uid 不变');
ok(
  items1[0].rowId !== items2.find((i) => i.serials[0] === 'SN-A').rowId,
  '但它的 RowId 变了（所以 RowId 不能当身份）',
  [items1[0].rowId, items2.find((i) => i.serials[0] === 'SN-A').rowId]
);

/* ---------- 核心回归：状态不能平移到别的商品 ---------- */
console.log('\n— 核心回归：行号重排 + 新增一行后，状态仍跟着商品走 —');
const st1 = new Stocktake({ date: '2026-09-14', storeId: '100001', storeName: '测试库', items: items1 });
const A = items1.find((i) => i.serials[0] === 'SN-A');
const B = items1.find((i) => i.serials[0] === 'SN-B');
const X = items1.find((i) => i.proId === '900');
st1.confirmFound(A.uid, 1000);
st1.setManualNote(A.uid, 'A 的样机备注');
st1.setManualQty(X.uid, 7);
st1.scan(B.serials[0], 2000);

// 用"重排后的新账面"按 uid 恢复同一个会话
const st1b = new Stocktake({
  date: '2026-09-14',
  storeId: '100001',
  storeName: '测试库',
  items: normalizeAll(rows2, '100001'),
});
st1b.restore(st1.toJSON());
const A2 = st1b.items.find((i) => i.serials[0] === 'SN-A');
const B2 = st1b.items.find((i) => i.serials[0] === 'SN-B');
const C2 = st1b.items.find((i) => i.serials[0] === 'SN-C');
const X2 = st1b.items.find((i) => i.proId === '900');
eq(A2.manualAt > 0, true, 'A 的手工确认仍在 A 上');
eq(st1b.manualNote(A2.uid), 'A 的样机备注', 'A 的备注仍在 A 上');
eq(B2.matchedCode, normCode('SN-B'), 'B 的扫码记录仍在 B 上');
eq(X2 && st1b.manualQty[X2.uid], 7, '配件X 的实盘数量仍在配件X 上');
eq(C2.manualAt, 0, 'C 没有被误标为已确认');
eq(st1b.stats().manualCount, 1, '手工确认总数仍是 1');
eq(st1b.stats().foundCount, 1 + 1, '已盘 = 手工 1 + 扫码 1');
eq(st1b.stats().nonSerialCounted, 1, '无串号已盘行数仍是 1');

console.log('\n— 移除一行后，状态跟着商品消失而不是平移到下一行 —');
const rows3 = rows.filter((r) => r.Imei !== 'SN-A'); // A 被移除
const st1c = new Stocktake({ items: normalizeAll(rows3, '100001') });
st1c.restore(st1.toJSON());
eq(st1c.items.some((i) => i.serials[0] === 'SN-A'), false, 'A 已不在新账面');
eq(st1c.items.find((i) => i.serials[0] === 'SN-B').matchedCode, normCode('SN-B'), 'B 的扫码仍在 B 上');
eq(st1c.items.find((i) => i.serials[0] === 'SN-C').manualAt, 0, 'C 没被 A 的确认状态污染');
ok(!st1c.items.some((i) => i.manualAt), 'A 被移除后没有任何条目继承它的确认');

/* ---------- 不唯一身份 ---------- */
console.log('\n— 匹配不唯一：禁止自动继承 —');
const dupRows = [
  { Store: '测试库', ProName: '同名配件', Category1: '周边', ProId: 900, ProCount: 3, RowId: 1 },
  { Store: '测试库', ProName: '同名配件', Category1: '周边', ProId: 900, ProCount: 4, RowId: 2 },
];
const dupItems = normalizeAll(dupRows, '100001');
ok(dupItems[0].dupUid && dupItems[1].dupUid, '同身份两条都被标记为不唯一');
ok(dupItems[0].uid !== dupItems[1].uid, 'uid 仍然可区分', [dupItems[0].uid, dupItems[1].uid]);

/* ---------- 账面比对 ---------- */
console.log('\n— 账面比对（更新账面评审） —');
const oldBook = bookFromItems(items1);
// 新账面 = 插入 SN-D + 配件X 数量从 10 变成 8（是"改"，不是"又加了一行"）
const rows4 = rows2.map((r) => (r.ProName === '配件X' ? Object.assign({}, r, { ProCount: 8 }) : r));
const newBook = bookFromItems(normalizeAll(rows4, '100001'));
const d = diffBooks(oldBook, newBook);
eq(d.added.length, 1, '识别出新增 1 条（SN-D）');
eq(d.removed.length, 0, '没有移除');
eq(d.changed.length, 1, '识别出数量变化 1 条（配件X 10→8）', d.changed);
eq(d.changed[0].oldQty, 10, '变化前数量');
eq(d.changed[0].newQty, 8, '变化后数量');
ok(d.sameCount >= 3, '其余算不变', d.sameCount);

const d2 = diffBooks(oldBook, bookFromItems(dupItems));
eq(d2.ambiguous.length, 1, '不唯一身份进入 ambiguous（不自动继承）', d2.ambiguous);

/* ---------- 冻结账面 + 状态往返 ---------- */
console.log('\n— 冻结账面与状态往返 —');
const bookPayload = {
  sessionId: st1.sessionId,
  companycode: '00000000',
  storeId: '100001',
  storeName: '测试库',
  date: '2026-09-14',
  version: 1,
  fetchedAt: 1700000000000,
  items: bookFromItems(items1),
};
store.saveBook(bookPayload);
const loaded = store.loadBook();
eq(loaded.items.length, 5, '账面写入后读回 5 行');
eq(loaded.sessionId, st1.sessionId, '会话号保留');
eq(loaded.fetchedAt, 1700000000000, '拉取时间保留');
const restoredItems = itemsFromBook(loaded.items, loaded.storeId, loaded.storeName);
eq(restoredItems.length, 5, '账面还原条目数');
eq(restoredItems[0].serials, ['SN-A'], '串号还原');
eq(restoredItems[3].hasSerial, false, '无串号条目仍是无串号');

store.saveState(st1.toJSON());
const st2 = new Stocktake({ items: restoredItems, sessionId: loaded.sessionId, bookVersion: 1 });
ok(store.stateMatches(store.loadState(), st2.sessionId, 1), '状态与账面版本对得上');
st2.restore(store.loadState());
eq(st2.stats().foundCount, 2, '恢复后已盘数一致');
eq(st2.stats().manualCount, 1, '恢复后手工确认一致');
eq(st2.scans.length, 1, '恢复后扫码流水一致');
ok(!store.stateMatches(store.loadState(), 'other-session', 1), '会话号不同 → 不匹配');
ok(!store.stateMatches(store.loadState(), st2.sessionId, 2), '账面版本不同 → 不匹配');

/* ---------- 只确认/只备注/什么都没扫也能保存与恢复 ---------- */
console.log('\n— 只要有内容就能保存与恢复（不只看扫码）—');
const st3 = new Stocktake({ items: normalizeAll(rows, '100001') });
eq(st3.hasContent(), false, '刚建立、什么都没做 → 无内容');
st3.setManualNote(items1[0].uid, '只有备注');
eq(st3.hasContent(), true, '只写了备注也算有内容');
const st4 = new Stocktake({ items: normalizeAll(rows, '100001') });
st4.confirmFound(items1[1].uid, 500);
eq(st4.hasContent(), true, '只手工确认也算有内容');
const st5 = new Stocktake({ items: normalizeAll(rows, '100001') });
st5.pendingReview = [{ kind: '手工确认', key: 'x' }];
eq(st5.hasContent(), true, '只有待核实条目也算有内容');

/* ---------- 保存失败必须抛出 ---------- */
console.log('\n— 保存失败必须明确抛出（不静默吞掉）—');
installStorage({ quotaBytes: 200 });
let quotaErr = null;
try {
  store.saveState(st1.toJSON());
} catch (e) {
  quotaErr = e;
}
ok(!!quotaErr, '配额不足时抛出');
eq(quotaErr && quotaErr.storage, 'quota', '错误类型标记为 quota');
ok(/空间不足/.test(quotaErr.message), '错误信息可读', quotaErr.message);
ok(store.status.lastError.includes('配额'), '状态里记录了失败原因', store.status.lastError);

installStorage({ disabled: true });
eq(store.available(), false, '存储被禁用时 available() 为 false');
let disabledErr = null;
try {
  store.saveBook(bookPayload);
} catch (e) {
  disabledErr = e;
}
ok(!!disabledErr && disabledErr.storage === 'unavailable', '禁用存储时抛出明确错误');

/* ---------- 旧版本迁移：不清空、不自动继承 ---------- */
console.log('\n— 旧版本记录迁移 —');
const map = installStorage();
map.set('ic.session.v1', JSON.stringify({ v: 1, storeId: '100001', storeName: '测试库', date: '2026-09-14', scans: [{ code: 'SN-A', ts: 1 }], manualQty: { r4: 7 }, manualFound: { r1: { ts: 2 } }, manualNotes: { r1: '旧备注' } }));
const legacy = store.takeLegacy();
eq(legacy.storeId, '100001', '读到旧记录');
eq(map.has('ic.session.v1'), false, '旧键已移走（不再参与恢复）');
ok(!!store.loadLegacyBackup(), '旧数据已备份，不会丢');
eq(store.loadLegacyBackup().data.manualQty.r4, 7, '备份内容完整');

/* ---------- 用量与备份 ---------- */
console.log('\n— 用量统计与备份导出 —');
installStorage();
store.saveBook(bookPayload);
store.saveState(st1.toJSON());
const usage = store.usage();
ok(usage.book > 100 && usage.state > 10, '能统计各键占用', usage);
const backup = store.buildBackup({ state: st1.toJSON(), book: store.loadBook() });
eq(backup.kind, 'inventory-check-backup', '备份有类型标记');
eq(backup.schema, 2, '备份带数据格式版本');
ok(JSON.stringify(backup).length > 200, '备份包含账面与状态');

/* ---------- 账面回滚 ---------- */
console.log('\n— 更新账面后保留上一版（可回滚） —');
store.saveBook(Object.assign({}, bookPayload, { version: 1 }));
store.replaceBook(Object.assign({}, bookPayload, { version: 2, items: bookFromItems(dupItems) }));
eq(store.loadBook().version, 2, '当前账面是第 2 版');
eq(store.loadPrevBook().version, 1, '上一版仍在（第 1 版）');
eq(store.loadPrevBook().items.length, 5, '上一版内容完整');

console.log(`\n会话与账面：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
