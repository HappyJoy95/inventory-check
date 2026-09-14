/* 加载未完成盘点（会话备份导入）离线测试
 * 用法：node test/load-backup.test.mjs
 *
 * 场景：A 机器盘到一半导出备份 → B 机器（全新浏览器、没登录、没网络）加载它继续盘。
 * 期望：账面、扫码、手工确认、实盘数量、备注全部回来，且整个过程 0 个网络请求。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = path.join(root, '库存盘点.html');
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-load-'));
let PORT = 9000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const corePath = 'file://' + path.join(root, 'src/core.js');
await import(corePath);
const core = globalThis.IC.core;

// 造一份备份：3 台在库 + 1 台在途，1 台已扫、1 台手工确认（带备注）、无串号填了实盘数
const rows = [
  { Store: '测试门店库', ProName: '在库机A', Category1: '手机', Imei: 'SN-A', ProCount: 1, ProCount_OnTransfer: 0, RowId: 1 },
  { Store: '测试门店库', ProName: '在库机B', Category1: '手机', Imei: 'SN-B', ProCount: 1, ProCount_OnTransfer: 0, RowId: 2 },
  { Store: '测试门店库', ProName: '在库机C', Category1: '手机', Imei: 'SN-C', ProCount: 1, ProCount_OnTransfer: 0, RowId: 3 },
  { Store: '测试门店库', ProName: '在途机X', Category1: '手机', Imei: 'SN-X', ProCount: 0, ProCount_OnTransfer: 1, RowId: 4 },
  { Store: '测试门店库', ProName: '配件包', Category1: '周边', ProId: 900, ProCount: 10, ProCount_OnTransfer: 0, RowId: 5 },
];
const items = core.normalizeAll(rows, '100001');
const st = new core.Stocktake({
  sessionId: 'backup-session-1',
  date: '2026-09-14',
  storeId: '100001',
  storeName: '测试门店库',
  items,
  bookVersion: 1,
  bookFetchedAt: 1700000000000,
});
const A = items.find((i) => i.serials[0] === 'SN-A');
const B = items.find((i) => i.serials[0] === 'SN-B');
const NS = items.find((i) => !i.hasSerial);
st.scan('SN-C', 1700000001000);
st.confirmFound(B.uid, 1700000002000);
st.setManualNote(B.uid, '样机在展台，无盒');
st.setManualQty(NS.uid, 8);

const book = {
  sessionId: st.sessionId,
  companycode: '00000000',
  storeId: '100001',
  storeName: '测试门店库',
  date: '2026-09-14',
  version: 1,
  fetchedAt: 1700000000000,
  items: core.bookFromItems(items),
};
const backup = {
  kind: 'inventory-check-backup',
  schema: 2,
  exportedAt: new Date().toISOString(),
  session: { state: st.toJSON(), book, stats: st.stats() },
};
const backupPath = path.join(os.tmpdir(), 'ic-backup-test.json');
fs.writeFileSync(backupPath, JSON.stringify(backup, null, 1));

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
    this.requests = [];
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
      } else if (m.method === 'Network.requestWillBeSent') {
        this.requests.push(m.params.request.url);
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

// 全新浏览器：没有登录、没有网络（fetch 直接失败），只能用本地备份
const seed = `
try {
  localStorage.clear();
  window.__NET__ = 0;
  window.fetch = function () { window.__NET__++; return Promise.reject(new Error('offline')); };
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
    tab: (n) => { const b=[...document.querySelectorAll('#tabs button')].find(x=>x.textContent.includes(n)); if(b) b.click(); return !!b; },
    rows: () => [...document.querySelectorAll('#tab-body tbody tr')].map(tr=>[...tr.children].map(td=>{
      const i = td.querySelector('input'); return (i ? i.value : td.textContent).trim();
    })),
    qty: (i) => { const tr=document.querySelectorAll('#tab-body tbody tr')[i]; const el=tr?tr.querySelector('.qty-input'):null; return el?el.value:null; },
  };
`;

let cdp = null;
try {
  // 端口由浏览器自己挑
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
  await cdp.send('Network.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: seed });
  await cdp.send('Page.navigate', { url: 'file://' + encodeURI(HTML) });
  await cdp.eval(HELPERS);

  console.log('— 1. 开头就有「加载未完成盘点」按钮 —');
  const ui = await cdp.eval(`(() => {
    const b = document.querySelector('#btn-load-backup');
    const inp = document.querySelector('#backup-file');
    return { exists: !!b, text: b ? b.textContent.trim() : '', hasInput: !!inp,
             accept: inp ? inp.getAttribute('accept') : '',
             visible: b ? !b.closest('#setup').classList.contains('hidden') : false };
  })()`);
  check(ui.exists && /加载未完成盘点/.test(ui.text), '设置区有「加载未完成盘点」按钮', ui.text);
  check(ui.hasInput && /json/.test(ui.accept), '有隐藏的文件选择框（只收 JSON）', ui.accept);
  check(ui.visible, '按钮在开头就能看到（不用先进盘点）');

  console.log('\n— 2. 加载备份：换机器接手 —');
  const loaded = await cdp.eval(`(async () => {
    ${HELPERS}
    const text = ${JSON.stringify(JSON.stringify(backup))};
    const file = new File([text], 'backup.json', { type: 'application/json' });
    await window.ICUI.loadBackupFile(file);
    await __t.waitFor(() => !document.querySelector('#scan-card').classList.contains('hidden'), 15000, '恢复');
    await __t.sleep(500);
    const b = JSON.parse(localStorage.getItem('ic.book.v2') || 'null');
    const s = JSON.parse(localStorage.getItem('ic.state.v2') || 'null');
    return { stats: __t.stats(), store: document.querySelector('#scan-store').textContent,
             bookRows: b ? b.items.length : 0, sessionId: b ? b.sessionId : '',
             stateScans: s ? (s.scans || []).length : -1, net: window.__NET__,
             toast: (document.querySelector('#toast') || {}).textContent || '' };
  })()`);
  check(/测试门店库/.test(loaded.store), '进入的是备份里的那个门店', loaded.store);
  check(loaded.bookRows === 5, '账面 5 行全部恢复', loaded.bookRows);
  check(loaded.sessionId === 'backup-session-1', '会话号沿用备份里的', loaded.sessionId);
  check(loaded.stateScans === 1, '扫码记录恢复', loaded.stateScans);
  check(loaded.stats['应盘（有串号）'] === '3', '应盘 3 台（在途不算）', loaded.stats['应盘（有串号）']);
  check(loaded.stats['已盘到'] === '2', '已盘 2 台（1 扫码 + 1 手工确认）', loaded.stats['已盘到']);
  check(loaded.stats['其中手工确认'] === '1', '手工确认 1 台', loaded.stats['其中手工确认']);
  check(loaded.stats['在途待入库'] === '1', '在途待入库 1 台', loaded.stats['在途待入库']);
  check(loaded.net === 0, '整个过程 0 个网络请求（没登录也能加载）', loaded.net);
  check(/已加载会话备份/.test(loaded.toast), '有明确提示', loaded.toast);

  console.log('\n— 3. 备注与实盘数量也回来了 —');
  const detail = await cdp.eval(`(async () => {
    ${HELPERS}
    __t.tab('已扫明细'); await __t.sleep(400);
    const rows = __t.rows();
    __t.tab('无串号商品'); await __t.sleep(400);
    return { rows, qty: __t.qty(0), diff: __t.rows()[0] ? __t.rows()[0][6] : null };
  })()`);
  check(detail.rows.some((r) => r[2] === '手工确认' && /样机在展台/.test(r[7])), '手工确认的备注恢复', detail.rows.map((r) => r[7]));
  check(detail.qty === '8', '无串号商品实盘数量恢复', detail.qty);
  check(detail.diff === '-2', '差异按恢复数量算出 -2', detail.diff);

  console.log('\n— 4. 接着盘：扫码可用 —');
  const cont = await cdp.eval(`(async () => {
    ${HELPERS}
    __t.tab('未扫到'); await __t.sleep(400);
    const code = __t.rows()[0][2].split(' / ')[0];
    const el = document.querySelector('#scan-input'); el.focus(); el.value = code;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await __t.sleep(400);
    return { code, fb: document.querySelector('#feedback .fb-main').textContent, stats: __t.stats(), net: window.__NET__ };
  })()`);
  check(cont.fb === '已盘到', '能继续扫码', cont.code);
  check(cont.stats['已盘到'] === '3', '又扫一台后已盘 3', cont.stats['已盘到']);
  check(cont.net === 0, '仍然没有网络请求');

  console.log('\n— 5. 坏文件要给出明确错误 —');
  const bad = await cdp.eval(`(async () => {
    ${HELPERS}
    const out = [];
    const tryLoad = async (content, name) => {
      document.querySelector('#toast').textContent = '';
      await window.ICUI.loadBackupFile(new File([content], name, { type: 'application/json' }));
      await __t.sleep(300);
      return (document.querySelector('#toast') || {}).textContent || '';
    };
    out.push(await tryLoad('这不是 json', 'bad.json'));
    out.push(await tryLoad(JSON.stringify({ hello: 'world' }), 'other.json'));
    out.push(await tryLoad(JSON.stringify({ kind: 'inventory-check-backup', session: {} }), 'empty.json'));
    return out;
  })()`);
  check(/不是有效的 JSON/.test(bad[0]), '非 JSON 文件 → 明确报错', bad[0].slice(0, 40));
  check(/不是本工具导出/.test(bad[1]), '别的 JSON → 提示不是本工具的备份', bad[1].slice(0, 40));
  check(/没有账面数据/.test(bad[2]), '缺账面 → 提示文件不完整', bad[2].slice(0, 40));
} catch (e) {
  fail++;
  console.log('✗ 中断：' + e.message);
} finally {
  try {
    cdp && cdp.ws.close();
  } catch (e) {}
  edge.kill('SIGKILL');
  await sleep(250);
  fs.rmSync(PROFILE, { recursive: true, force: true });
  try {
    fs.rmSync(backupPath, { force: true });
  } catch (e) {}
}
console.log(`\n加载未完成盘点：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
