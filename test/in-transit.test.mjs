/* 在途（待入库）离线测试
 * 用法：node test/in-transit.test.mjs
 *
 * 需求：在途应出现在目标门店的账面里、盘点时带出来，但必须标记「待入库」，
 *       且不能混进"必须扫到"的应盘数/进度。
 * 接口契约来自 ERP 自己的库存明细页：Api/Report/InventoryImei + InventoryType=1(在途)
 * （真实凭证下尚未联调，本测试用桩覆盖逻辑与边界）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = path.join(root, '库存盘点.html');
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
let PORT = 9950 + Math.floor(Math.random() * 8); // 先给个候选，真正的端口由浏览器自己选（见 DevToolsActivePort）
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-transit-'));
const DL = path.join(root, 'test/tmp/downloads-transit');
fs.rmSync(DL, { recursive: true, force: true });
fs.mkdirSync(DL, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0,
  fail = 0;
const check = (cond, label, extra) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`);
  }
};

class CDP {
  constructor(u) {
    this.u = u;
    this.id = 0;
    this.waiting = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.u);
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', () => rej(new Error('连接失败')), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (m.id && this.waiting.has(m.id)) {
        const { res, rej } = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waiting.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.waiting.has(id)) {
          this.waiting.delete(id);
          rej(new Error('超时 ' + method));
        }
      }, 90000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
    return r.result.value;
  }
}

// 在库 3 行；在途 3 行（2 行属于本店、1 行属于别仓，用于验证防御性过滤）
const seed = `
try {
  window.__TRANSIT_FAIL__ = false;
  window.__CALLS__ = [];
  localStorage.setItem('ic.cfg.v2', ${JSON.stringify(
    JSON.stringify({
      token: 'transit-test-token',
      companycode: '00000000',
      username: 'transit-test',
      account: '',
      rememberPwd: false,
      sound: false,
      loadGlobalIndex: false,
      loadInTransit: true,
    })
  )});
  localStorage.removeItem('ic.book.v2');
  localStorage.removeItem('ic.state.v2');
  const reply = (obj) => Promise.resolve({
    ok: true, status: 200, headers: { get: () => 'application/json' },
    text: () => Promise.resolve(JSON.stringify(obj)),
  });
  // 同一张库存表：在库行的 ProCount_OnTransfer=0；在途行的 ProCount=0 且 ProCount_OnTransfer=1
  const onhand = [
    { Store: '测试门店库', ProName: '配件包', Category1: '周边', ProId: 900, ProCount: 10, ProCount_OnTransfer: 5, RowId: 9 },
    { Store: '测试门店库', ProName: '在库机A', Category1: '手机', Imei: 'ON-SN-1', ProCount: 1, ProCount_OnTransfer: 0, RowId: 1 },
    { Store: '测试门店库', ProName: '在库机B', Category1: '手机', Imei: 'ON-SN-2', ProCount: 1, ProCount_OnTransfer: 0, RowId: 2 },
    { Store: '测试门店库', ProName: '在库机C', Category1: '手机', Imei: 'ON-SN-3', ProCount: 1, ProCount_OnTransfer: 0, RowId: 3 },
    { Store: '测试门店库', ProName: '在途机X', Category1: '手机', Imei: 'WAY-SN-1', ProCount: 0, ProCount_OnTransfer: 1, RowId: 4 },
    { Store: '测试门店库', ProName: '在途机Y', Category1: '手机', Imei: 'WAY-SN-2', ProCount: 0, ProCount_OnTransfer: 1, RowId: 5 },
  ];
  const transit = [
    { StoreId: '100001', StoreName: '测试门店库', ProName: '在途机X', Imei: 'WAY-SN-1', ProCount: 1, RowId: 't1', ReceivingCode: 'REC-001', FromStoreName: '来源仓A' },
    { StoreId: '100001', StoreName: '测试门店库', ProName: '在途机Y', Imei: 'WAY-SN-2', ProCount: 1, RowId: 't2', ReceivingCode: 'REC-001', FromStoreName: '来源仓A' },
    { StoreId: '999999', StoreName: '别的仓', ProName: '别仓在途机', Imei: 'WAY-SN-9', ProCount: 1, RowId: 't9' },
  ];
  window.fetch = function (url, init) {
    const u = String(url);
    const body = init && init.body ? JSON.parse(init.body) : {};
    window.__CALLS__.push(u);
    if (/API\\/USER\\/STORE/i.test(u)) {
      return reply({ ResponseID: 0, Message: '', Data: [{ Id: 100001, Name: '测试门店库', BranchName: '测试门店', BranchId: '310453' }] });
    }
    if (/InventoryImei/i.test(u)) {
      window.__INVENTORY_TYPE__ = body.InventoryType;
      if (window.__TRANSIT_FAIL__) {
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => 'application/json' },
          text: () => Promise.resolve(JSON.stringify({ ResponseID: 7, Message: '在途查询失败（模拟）' })) });
      }
      if (window.__TRANSIT_FALLBACK_ONLY__ !== true) {
        // 同表在途列已经提供了数据，兜底接口不该被调用
        window.__DETAIL_CALLED__ = true;
      }
      return reply({ ResponseID: 0, Message: '', Data: { Data: transit, TotalRows: transit.length, PageIndex: 1 } });
    }
    if (/RptStoreNow/i.test(u)) {
      window.__OUTCOL__ = body.outCol;
      // __FORCE_FALLBACK__ 时只返回在库行，模拟"这张表这个口径拿不到在途"
      const list = window.__FORCE_FALLBACK__
        ? onhand.filter((r) => (r.ProCount || 0) > 0).map((r) => Object.assign({}, r, { ProCount_OnTransfer: 0 }))
        : onhand;
      return reply({ ResponseID: 0, Message: '', Data: { Data: list, TotalRows: list.length, PageIndex: 1 } });
    }
    return reply({ ResponseID: 0, Message: '', Data: null });
  };
} catch (e) {}
`;

const edge = spawn(
  EDGE,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${PROFILE}`,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--window-size=1440,1000',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

const HELPERS = `
  window.__t = {
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
    waitFor: async (fn, timeout = 20000, label = '') => {
      const t0 = Date.now();
      for (;;) { let v=false; try{v=fn();}catch(e){}
        if (v) return v;
        if (Date.now()-t0 > timeout) throw new Error('等待超时 ' + label);
        await new Promise(r=>setTimeout(r,120)); }
    },
    stats: () => { const m={}; document.querySelectorAll('#stats .stat').forEach(x=>m[x.querySelector('.k').textContent]=x.querySelector('.v').textContent); return m; },
    tabs: () => [...document.querySelectorAll('#tabs button')].map(b=>b.textContent.replace(/\\d+$/,'').trim()),
    tab: (n) => { const b=[...document.querySelectorAll('#tabs button')].find(x=>x.textContent.includes(n)); if(b) b.click(); return !!b; },
    rows: () => [...document.querySelectorAll('#tab-body tbody tr')].map(tr=>[...tr.children].map(td=>td.textContent.trim())),
    scan: (code) => { const el=document.querySelector('#scan-input'); el.focus(); el.value=code;
      el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); },
    header: () => document.querySelector('#session-info').textContent,
  };
`;

let cdp = null;
let browserCDP = null;
try {
  // 端口由浏览器自己挑（避免连续跑多个测试时撞端口），从 DevToolsActivePort 读回来
  for (let i = 0; i < 300; i++) {
    try {
      const f = path.join(PROFILE, 'DevToolsActivePort');
      if (fs.existsSync(f)) {
        const p = Number(String(fs.readFileSync(f, 'utf8')).split('\n')[0]);
        if (p) {
          PORT = p;
          break;
        }
      }
    } catch (e) {}
    await sleep(100);
  }
  let v = null;
  for (let i = 0; i < 180; i++) {
    try {
      v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      break;
    } catch (e) {
      await sleep(250);
    }
  }
  if (!v) throw new Error('Edge 未就绪');
  browserCDP = new CDP(v.webSocketDebuggerUrl);
  await browserCDP.connect();
  await browserCDP.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });

  let target = null;
  for (let i = 0; i < 120; i++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
    if (target) break;
    await sleep(250);
  }
  cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: seed });
  await cdp.send('Page.navigate', { url: 'file://' + encodeURI(HTML) });
  await cdp.eval(HELPERS);

  console.log('— 1. 开盘点：带出在途，但不混进应盘 —');
  const started = await cdp.eval(`(async () => {
    ${HELPERS}
    await __t.waitFor(() => document.querySelectorAll('#store option').length > 1, 20000, '仓库');
    document.querySelector('#store').value = '100001';
    document.querySelector('#btn-start').click();
    await __t.waitFor(() => !document.querySelector('#scan-card').classList.contains('hidden'), 25000, '账面');
    await __t.sleep(600);
    const book = JSON.parse(localStorage.getItem('ic.book.v2') || 'null');
    return {
      stats: __t.stats(),
      tabs: __t.tabs(),
      header: __t.header(),
      detailCalled: !!window.__DETAIL_CALLED__,
      outCol: window.__OUTCOL__,
      bookRows: book ? book.items.length : 0,
      source: (window.ICUI && window.ICUI.state().inTransitInfo) ? window.ICUI.state().inTransitInfo.source : '',
      transitInBook: book ? book.items.filter(i => i.inTransit).map(i => ({ uid: i.uid, name: i.name, qty: i.qty, from: i.inTransitInfo && i.inTransitInfo.fromStore })) : [],
    };
  })()`);
  check(started.detailCalled === false, '同表已经给出在途，没有再调明细接口（省一次请求）', started.detailCalled);
  check(started.outCol === 'ProCount,ProCount_OnTransfer', '库存查询的 outCol 同时取了在库与在途数量', started.outCol);
  check(started.stats['应盘（有串号）'] === '3', '应盘只算在库 3 台（在途不计入）', started.stats['应盘（有串号）']);
  check(started.stats['未扫到'] === '3', '未扫到只列在库的 3 台（在途不混进来）', started.stats['未扫到']);
  check(
    started.stats['在途待入库'] === '3',
    '在途待入库 3 条（2 台串号在途 + 配件在途 1 条）',
    started.stats['在途待入库']
  );
  check(started.stats['无串号商品'] === '1', '无串号商品只算在库那条', started.stats['无串号商品']);
  check(started.tabs.includes('在途待入库'), '出现「在途待入库」页签', started.tabs);
  check(started.bookRows === 7, '账面 7 条（在库 5 + 在途 2 条串号 + 配件在途 1 条）', started.bookRows);
  check(started.source === '库存表在途列', '在途来源标注为「库存表在途列」', started.source);
  check(
    started.transitInBook.length === 3 && started.transitInBook.every((t) => t.qty > 0),
    '3 条在途都被标记出来（含无串号配件那条）',
    started.transitInBook.map((t) => [t.name, t.qty])
  );
  check(/在途待入库 3/.test(started.header), '会话栏显示在途数量', started.header);

  console.log('\n— 2. 在途页标记「待入库」—');
  const transitTab = await cdp.eval(`(async () => {
    ${HELPERS}
    __t.tab('在途待入库'); await __t.sleep(500);
    return { rows: __t.rows() };
  })()`);
  check(transitTab.rows.length === 3, '列出 3 条在途', transitTab.rows.length);
  check(
    transitTab.rows.every((r) => r[6] === '待入库'),
    '每条都标着「待入库」',
    transitTab.rows.map((r) => r[6])
  );
  check(
    transitTab.rows.some((r) => r[1] === '在途机X' && r[2] === 'WAY-SN-1'),
    '商品与串号都带出来了',
    transitTab.rows[0]
  );

  const twin = await cdp.eval(`(async () => {
    ${HELPERS}
    __t.tab('在途待入库'); await __t.sleep(400);
    const rows = __t.rows();
    __t.tab('无串号商品'); await __t.sleep(400);
    const nsRows = __t.rows();
    return { transitRows: rows, nsRows };
  })()`);
  check(
    twin.transitRows.some((r) => r[1] === '配件包' && r[2] === '无串号（按数量）' && r[3] === '5'),
    '方案A：配件的在途 5 件单独成一条在途账目',
    twin.transitRows.map((r) => [r[1], r[3]])
  );
  check(
    twin.nsRows.some((r) => r[1] === '配件包' && r[4] === '10'),
    '配件的在库 10 件仍在「无串号商品」里按数量核对',
    twin.nsRows.map((r) => [r[1], r[4]])
  );
  check(twin.nsRows.every((r) => r[1] !== '配件包' || r[4] === '10'), '在途那条没有混进无串号商品清单');

  console.log('\n— 3. 货实际到了：扫它应当变成「已扫到（货已到）」—');
  const arrived = await cdp.eval(`(async () => {
    ${HELPERS}
    __t.scan('WAY-SN-1');
    await __t.sleep(500);
    const stats = __t.stats();
    const fb = document.querySelector('#feedback .fb-main').textContent;
    __t.tab('在途待入库'); await __t.sleep(400);
    const rows = __t.rows();
    return { fb, stats, rows, statuses: rows.map(r => r[6]) };
  })()`);
  check(arrived.fb === '已盘到', '扫在途串号能命中（不是"查无此码"）', arrived.fb);
  check(arrived.statuses.includes('已扫到（货已到）'), '该条状态变成「已扫到（货已到）」', arrived.statuses);
  check(
    arrived.stats['已盘到'] === '0',
    '在途到货不计入「已盘到」（进度只按在库的应盘算，避免出现 已盘 > 应盘）',
    arrived.stats['已盘到']
  );
  const arrivedDetail = await cdp.eval(`(async () => {
    ${HELPERS}
    __t.tab('已扫明细'); await __t.sleep(400);
    return { rows: __t.rows() };
  })()`);
  check(
    arrivedDetail.rows.some((r) => /在途机X/.test(r[1])),
    '但它会出现在「已扫明细」里（带出来了）',
    arrivedDetail.rows.map((r) => r[1])
  );
  check(arrived.stats['应盘（有串号）'] === '3', '应盘数不受影响（仍是在库 3 台）', arrived.stats['应盘（有串号）']);
  check(arrived.stats['未扫到'] === '3', '未扫到也不受影响', arrived.stats['未扫到']);

  console.log('\n— 4. 导出包含在途表 —');
  const before = fs.readdirSync(DL);
  await cdp.eval(`document.querySelector('#btn-export').click()`);
  let exported = null;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const now = fs.readdirSync(DL).filter((f) => !f.endsWith('.crdownload'));
    if (now.length > before.length) {
      exported = now.find((f) => !before.includes(f));
      break;
    }
  }
  check(!!exported, '导出成功', exported);
  if (exported) {
    const py = `
import openpyxl, json, sys
wb = openpyxl.load_workbook(sys.argv[1])
ws = wb['在途待入库']
out = {"sheets": wb.sheetnames, "transit_rows": ws.max_row,
       "transit": [list(r) for r in ws.iter_rows(values_only=True)],
       "summary": {r[0]: r[1] for r in wb['汇总'].iter_rows(values_only=True) if r[0]},
       "all_rows": [list(r) for r in wb['账面全量'].iter_rows(values_only=True)][1:]}
print(json.dumps(out, ensure_ascii=False))
`;
    const info = JSON.parse(
      execFileSync('python3', ['-c', py, path.join(DL, exported)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    );
    check(info.sheets.includes('在途待入库'), '导出有「在途待入库」工作表', info.sheets);
    check(info.transit_rows === 4, '在途表 4 行（3 条 + 表头）', info.transit_rows);
    check(String(info.summary['在途（待入库）台数']) === '3', '汇总里在途条数 = 3', info.summary['在途（待入库）台数']);
    check(String(info.summary['其中已扫到（货已到）']) === '1', '汇总里已到货 = 1', info.summary['其中已扫到（货已到）']);
    const modes = info.all_rows.map((r) => r[5]);
    check(
      modes.filter((m) => m === '在途待入库').length === 2 && modes.filter((m) => m === '在途·已扫到').length === 1,
      '账面全量的盘点方式区分「在途待入库 / 在途·已扫到」',
      modes
    );
    check(
      info.all_rows.filter((r) => r[5] === '在途待入库').every((r) => r[3] === 0 && r[4] > 0),
      '在途行的「在库」列为 0、「在途」列为实际在途数量',
      info.all_rows.filter((r) => r[5] === '在途待入库').map((r) => [r[3], r[4]])
    );
    check(
      info.all_rows.some((r) => r[0] === '配件包' && r[3] === 10 && r[5] === '无串号'),
      '方案A：配件包在账面全量里是在库 10 + 在途 5 两条',
      info.all_rows.filter((r) => r[0] === '配件包').map((r) => [r[3], r[4], r[5]])
    );
  }

  console.log('\n— 5. 兜底接口失败：不影响在库盘点 —');
  const failPath = await cdp.eval(`(async () => {
    ${HELPERS}
    window.confirm = () => true;
    window.__TRANSIT_FAIL__ = true;
    // 让主路径（同表在途列）拿不到数据，逼它走明细接口兜底
    window.__FORCE_FALLBACK__ = true;
    // 结束当前盘，重新开一次（这次在途查询会失败）
    document.querySelector('#btn-new').click();
    await __t.sleep(600);
    document.querySelector('#btn-settings').click();
    await __t.sleep(300);
    document.querySelector('#store').value = '100001';
    document.querySelector('#btn-start').click();
    await __t.waitFor(() => !document.querySelector('#scan-card').classList.contains('hidden'), 25000, '第二次账面');
    await __t.sleep(600);
    return { stats: __t.stats(), header: __t.header(), tabs: __t.tabs(),
             toast: (document.querySelector('#toast') || {}).textContent || '' };
  })()`);
  check(failPath.stats['应盘（有串号）'] === '3', '在途拉取失败时，在库账面照常', failPath.stats['应盘（有串号）']);
  check(failPath.stats['在途待入库'] === '0', '在途数量显示 0', failPath.stats['在途待入库']);
  check(/在途未拉到/.test(failPath.header), '会话栏明确提示「在途未拉到」', failPath.header);
  check(!failPath.tabs.includes('在途待入库'), '没有在途数据时不显示该页签', failPath.tabs);
  check(/在途/.test(failPath.toast), '有可读的失败提示', failPath.toast.slice(0, 50));
} catch (e) {
  fail++;
  console.log('✗ 中断：' + e.message);
} finally {
  try {
    cdp && cdp.ws.close();
  } catch (e) {}
  try {
    browserCDP && browserCDP.ws.close();
  } catch (e) {}
  edge.kill('SIGKILL');
  await sleep(250);
  fs.rmSync(PROFILE, { recursive: true, force: true });
}
console.log(`\n在途待入库：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
