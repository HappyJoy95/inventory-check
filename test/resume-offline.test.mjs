/* 离线续盘端到端测试（不需要网络、不需要凭证）
 * 用法：node test/resume-offline.test.mjs
 *
 * 场景：把一份「冻结账面 + 已盘记录」直接塞进浏览器本地存储，然后打开成品页面。
 * 期望：直接从本地恢复，**一个请求都不发**，能继续扫码、导出。
 * 这同时验证了「断网/登录过期也能继续盘点和导出」。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findFixture, missingFixtureHint } from './fixture-file.mjs';
import '../src/core.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = path.join(root, '库存盘点.html');
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Edge';
const EDGE_BIN = fs.existsSync(EDGE) ? EDGE : '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
let PORT = 9880 + Math.floor(Math.random() * 80); // 先给个候选，真正的端口由浏览器自己选（见 DevToolsActivePort）
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-offline-'));
const DL = path.join(root, 'test/tmp/downloads');
fs.rmSync(DL, { recursive: true, force: true });
fs.mkdirSync(DL, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const core = globalThis.IC.core;
const fx = findFixture();
if (!fx) {
  missingFixtureHint();
  process.exit(1);
}
const rows = fx.rows;
const meta = fx.meta;
const STORE = meta.storeId;
const STORE_NAME = meta.storeName;

// ---- 造会话：冻结账面 + 一些已录记录 ----
const items = core.normalizeAll(rows, STORE);
const serialItems = items.filter((i) => i.hasSerial);
const nonSerial = items.filter((i) => !i.hasSerial);
const scanned = serialItems[0];
const confirmed = serialItems[1];
const nonSerialItem = nonSerial[0];

const sessionId = 'offline-test-session';
const book = {
  sessionId,
  companycode: '00000000',
  storeId: STORE,
  storeName: STORE_NAME,
  date: meta.date,
  version: 1,
  fetchedAt: 1700000000000,
  items: core.bookFromItems(items),
};
const st = new core.Stocktake({
  sessionId,
  date: meta.date,
  storeId: STORE,
  storeName: STORE_NAME,
  items,
  bookVersion: 1,
  bookFetchedAt: 1700000000000,
});
st.scan(scanned.serials[0], 1700000001000);
st.confirmFound(confirmed.uid, 1700000002000);
st.setManualNote(confirmed.uid, '样机在展台，无盒');
st.setManualQty(nonSerialItem.uid, nonSerialItem.qty - 2);
const state = st.toJSON();

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
      }, 120000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
    return r.result.value;
  }
}

const seed = `
try {
  // 故意放一个无效 token：一旦有人偷偷请求 ERP，就会失败得很明显
  localStorage.setItem('ic.cfg.v2', ${JSON.stringify(
    JSON.stringify({
      token: 'offline-test-token-not-valid',
      companycode: '00000000',
      username: 'offline-test',
      account: '',
      rememberPwd: false,
      sound: false,
      loadGlobalIndex: false,
    })
  )});
  localStorage.setItem('ic.book.v2', ${JSON.stringify(JSON.stringify(book))});
  localStorage.setItem('ic.state.v2', ${JSON.stringify(JSON.stringify(state))});
} catch (e) {}
`;

const edge = spawn(
  EDGE_BIN,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${PROFILE}`,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--window-size=1440,1100',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

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
  await cdp.send('Network.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: seed });
  await cdp.send('Page.navigate', { url: 'file://' + encodeURI(HTML) });
  await sleep(2500);

  const HELPERS = `
    window.__t = {
      sleep: (ms) => new Promise(r => setTimeout(r, ms)),
      stats: () => { const m={}; document.querySelectorAll('#stats .stat').forEach(x=>m[x.querySelector('.k').textContent]=x.querySelector('.v').textContent); return m; },
      scan: (code) => { const el=document.querySelector('#scan-input'); el.focus(); el.value=code;
        el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); },
      tab: (n) => { const b=[...document.querySelectorAll('#tabs button')].find(x=>x.textContent.includes(n)); if(b) b.click(); return !!b; },
      rowCount: () => document.querySelectorAll('#tab-body tbody tr').length,
      cell: (r,c) => { const tr=document.querySelectorAll('#tab-body tbody tr')[r]; return tr?tr.children[c].textContent.trim():null; },
      qty: (r) => { const tr=document.querySelectorAll('#tab-body tbody tr')[r]; const i=tr?tr.querySelector('.qty-input'):null; return i?i.value:null; },
    };
  `;
  await cdp.eval(HELPERS);

  console.log('— 1. 从本地冻结账面恢复（不发任何请求）—');
  const resumed = await cdp.eval(`(async () => {
    ${HELPERS}
    const t0 = Date.now();
    while (document.querySelector('#scan-card').classList.contains('hidden')) {
      if (Date.now() - t0 > 15000) throw new Error('没有自动恢复');
      await __t.sleep(150);
    }
    await __t.sleep(500);
    return { stats: __t.stats(), store: document.querySelector('#scan-store').textContent };
  })()`);
  check(/测试门店库|离线/.test(resumed.store), '已进入扫码台', resumed.store);
  const erpReqs = cdp.requests.filter((u) => /yserp\.cc/.test(u));
  check(erpReqs.length === 0, '恢复过程没有向 ERP 发任何请求', erpReqs);
  check(
    resumed.stats['应盘（有串号）'] === String(serialItems.length),
    '应盘台数 = 冻结账面的有串号行数',
    [resumed.stats['应盘（有串号）'], serialItems.length]
  );
  check(resumed.stats['已盘到'] === '2', '已盘 2（1 扫码 + 1 手工确认）', resumed.stats['已盘到']);
  check(resumed.stats['其中手工确认'] === '1', '手工确认 1 台', resumed.stats['其中手工确认']);
  check(resumed.stats['无串号商品'] === String(nonSerial.length), '无串号商品行数一致', resumed.stats['无串号商品']);

  console.log('\n— 2. 恢复的明细内容正确 —');
  const detail = await cdp.eval(`(async () => {
    ${HELPERS}
    __t.tab('已扫明细'); await __t.sleep(400);
    const rows = [...document.querySelectorAll('#tab-body tbody tr')].map(tr=>({
      name: tr.children[1].textContent.trim(),
      src: tr.children[2].textContent.trim(),
      note: (tr.children[7].querySelector('input') ? tr.children[7].querySelector('input').value : tr.children[7].textContent).trim(),
    }));
    __t.tab('无串号商品'); await __t.sleep(400);
    const firstQty = __t.qty(0);
    const firstBook = __t.cell(0,4);
    const firstDiff = __t.cell(0,6);
    return { rows, firstQty, firstBook, firstDiff };
  })()`);
  check(detail.rows.some((r) => r.src === '扫码'), '扫到的记录来源是「扫码」');
  check(
    detail.rows.some((r) => r.src === '手工确认' && /样机在展台/.test(r.note)),
    '手工确认与备注都恢复了',
    detail.rows.filter((r) => r.src === '手工确认').map((r) => r.note)
  );
  check(detail.firstQty === String(nonSerialItem.qty - 2), '无串号实盘数量恢复', [detail.firstQty, nonSerialItem.qty - 2]);
  check(detail.firstDiff === '-2', '差异按恢复后的数量算出 -2', detail.firstDiff);

  console.log('\n— 3. 离线继续扫码 —');
  const scan = await cdp.eval(`(async () => {
    ${HELPERS}
    __t.tab('未扫到'); await __t.sleep(400);
    const code = __t.cell(0,2).split(' / ')[0];
    __t.scan(code);
    await __t.sleep(400);
    return { code, stats: __t.stats(), fb: document.querySelector('#feedback .fb-main').textContent };
  })()`);
  check(scan.fb === '已盘到', '离线扫码仍然可用', scan.code);
  check(scan.stats['已盘到'] === '3', '已盘数增加到 3', scan.stats['已盘到']);
  check(cdp.requests.filter((u) => /yserp\.cc/.test(u)).length === 0, '扫码过程也不发请求');

  console.log('\n— 4. 离线导出 Excel —');
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
  check(!!exported, '离线也能导出文件', exported);
  if (exported) {
    const py = `
import openpyxl, json, sys
wb = openpyxl.load_workbook(sys.argv[1])
ws = wb['汇总']
print(json.dumps({"sheets": wb.sheetnames,
  "summary": {r[0]: r[1] for r in ws.iter_rows(values_only=True) if r[0]},
  "found_rows": wb['已扫明细'].max_row,
  "missing_rows": wb['未扫到'].max_row}, ensure_ascii=False))
`;
    const info = JSON.parse(
      execFileSync('python3', ['-c', py, path.join(DL, exported)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    );
    check(String(info.summary['已盘到']) === '3', '导出的汇总里已盘 = 3', info.summary['已盘到']);
    check(info.found_rows === 4, '已扫明细 4 行（3 条 + 表头）', info.found_rows);
    check(
      String(info.summary['应盘（有串号）']) === String(serialItems.length),
      '导出里的应盘数 = 冻结账面',
      info.summary['应盘（有串号）']
    );
  }

  console.log('\n— 5. 保存状态可见 —');
  const saveStatus = await cdp.eval(`(document.querySelector('#save-status')||{}).textContent || ''`);
  check(/已保存/.test(saveStatus), '界面显示「已保存」', saveStatus);

  console.log('\n— 6. 无网络请求总校验 —');
  check(
    cdp.requests.filter((u) => /yserp\.cc/.test(u)).length === 0,
    '整个离线流程 0 个 ERP 请求',
    cdp.requests.filter((u) => /yserp\.cc/.test(u))
  );
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
console.log(`\n离线续盘：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
