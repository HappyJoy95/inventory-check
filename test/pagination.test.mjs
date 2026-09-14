/* 分页与完整性校验测试（全离线：stub 掉 fetch，构造各种畸形响应）
 * 用法：node test/pagination.test.mjs
 */
import '../src/core.js';
import '../src/erp.js';

const { fetchInventory } = globalThis.IC.erp;

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

const CFG = { token: 'x'.repeat(20), companycode: '00000000', timeout: 5000 };

/** 造一行库存（RowId 递增，便于识别页） */
const row = (i) => ({
  Store: '测试库',
  ProName: '商品' + i,
  Imei: 'SN' + String(i).padStart(4, '0'),
  ProCount: 1,
  RowId: i,
});

/**
 * 用脚本化的响应序列替换 fetch
 * @param {Array<Function|object>} pages 每页响应：对象=返回该 JSON，函数=(请求体,第几次)=>JSON
 */
function stubFetch(pages) {
  let call = 0;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const spec = pages[Math.min(call, pages.length - 1)];
    call++;
    const json = typeof spec === 'function' ? spec(body, call) : spec;
    if (json instanceof Error) throw json;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(json),
    };
  };
  return calls;
}

const page = (rows, totalRows, extra) =>
  Object.assign({ ResponseID: 0, Message: '', Data: { Data: rows, TotalRows: totalRows, PageIndex: 1, PageSize: 100 } }, extra || {});

async function expectError(label, pages, expectText, opt) {
  stubFetch(pages);
  try {
    const r = await fetchInventory(CFG, Object.assign({ date: '2026-09-14', storeId: '1', pageSize: 3 }, opt || {}));
    ok(false, label + '（竟然成功了）', r.rows && r.rows.length);
  } catch (e) {
    const hit = !expectText || new RegExp(expectText).test(e.message);
    ok(hit, label, e.message.slice(0, 90));
  }
}

console.log('— 正常路径 —');
{
  const calls = stubFetch([page([row(1), row(2), row(3)], 3)]);
  const r = await fetchInventory(CFG, { date: '2026-09-14', storeId: '1', pageSize: 3 });
  ok(r.rows.length === 3 && r.totalRows === 3, '单页拉全', [r.rows.length, r.pages]);
  ok(calls.length === 1, '只请求了一次');
}
{
  const calls = stubFetch([
    page([row(1), row(2)], 4),
    page([row(3), row(4)], 4),
  ]);
  const r = await fetchInventory(CFG, { date: '2026-09-14', storeId: '1', pageSize: 2 });
  ok(r.rows.length === 4 && r.pages === 2, '两页拉全', [r.rows.length, r.pages]);
  ok(calls[1].body.PageIndex === 2, '第二页 PageIndex=2');
}
{
  const progress = [];
  stubFetch([
    page([row(1), row(2)], 4),
    page([row(3), row(4)], 4),
  ]);
  await fetchInventory(CFG, {
    date: '2026-09-14',
    storeId: '1',
    pageSize: 2,
    onProgress: (d, t) => progress.push(`${d}/${t}`),
  });
  ok(JSON.stringify(progress) === JSON.stringify(['2/4', '4/4']), '进度回调逐页上报', progress);
}
{
  const r = await (async () => {
    stubFetch([page([], 0)]);
    return fetchInventory(CFG, { date: '2026-09-14', storeId: '1', pageSize: 3 });
  })();
  ok(r.empty === true && r.totalRows === 0 && r.rows.length === 0, '合法的零库存：成功返回空账面');
}

console.log('\n— 完整性失败必须阻断 —');
await expectError(
  '应有 3 行只收到 1 行 → 阻断并说明没拉全',
  [page([row(1)], 3), page([], 3)],
  '数据不完整|没拉全'
);
await expectError('第一页就少于总数、第二页为空 → 阻断', [page([row(1)], 3), page([], 3)], '第 2 页返回空');
await expectError(
  '分页过程中 TotalRows 变化 → 阻断',
  [page([row(1), row(2)], 4), page([row(3), row(4)], 5)],
  '总行数发生变化'
);
await expectError(
  '重复页 → 阻断',
  [
    page([row(1), row(2)], 6),
    page([row(1), row(2)], 6),
  ],
  '重复'
);
await expectError(
  '达到分页上限仍未拉全 → 阻断',
  [page([row(1)], 10), page([row(2)], 10), page([row(3)], 10)],
  '分页上限',
  { maxPages: 2 }
);
await expectError('声称 0 行却给了明细 → 阻断', [page([row(1)], 0)], '总行数为 0');
await expectError('返回行数超过总数 → 阻断', [page([row(1), row(2), row(3), row(4)], 2)], '超过总行数');

console.log('\n— 结构与状态校验 —');
await expectError('Data 不是对象 → 阻断', [{ ResponseID: 0, Data: 'oops' }], '结构异常');
await expectError('Data.Data 不是数组 → 阻断', [{ ResponseID: 0, Data: { Data: null, TotalRows: 3 } }], '明细数组');
await expectError('TotalRows 不合法 → 阻断', [{ ResponseID: 0, Data: { Data: [], TotalRows: 'abc' } }], 'TotalRows 不合法');
await expectError('ResponseID 非 0 → 阻断', [{ ResponseID: 7, Message: '系统忙' }], '系统忙');
{
  stubFetch([{ ResponseID: 1, Message: '未登录或登录超时！！！' }]);
  try {
    await fetchInventory(CFG, { date: '2026-09-14', storeId: '1' });
    ok(false, 'token 失效应报错');
  } catch (e) {
    ok(e.tokenExpired === true, 'token 失效被标记为「登录失效」而非「数据不完整」', [e.tokenExpired, !!e.incomplete]);
  }
}
{
  stubFetch([new Error('network down')]);
  try {
    await fetchInventory(CFG, { date: '2026-09-14', storeId: '1' });
    ok(false, '网络错误应报错');
  } catch (e) {
    ok(!e.incomplete, '网络错误不标记为「数据不完整」');
  }
}

console.log('\n— 未配置时一个请求都不发 —');
{
  let called = 0;
  globalThis.fetch = async () => {
    called++;
    throw new Error('不该被调用');
  };
  try {
    await fetchInventory({ token: '', companycode: '' }, { date: '2026-09-14', storeId: '1' });
    ok(false, '未配置应报错');
  } catch (e) {
    ok(e.notConfigured === true, '未配置被拦截');
    ok(called === 0, '确实没发请求', called);
  }
}

console.log(`\n分页完整性：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
