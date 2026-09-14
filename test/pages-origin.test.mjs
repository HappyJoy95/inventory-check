/* 网页托管形态检查：node test/pages-origin.test.mjs
 *
 * 交付物除了「双击 file:// 打开」，还会放到网页上（GitHub Pages 项目站点，
 * 形如 https://<user>.github.io/<repo>/ ）。这份测试把成品托管在一个真实的
 * http 来源 + 子路径下（与 Pages 的 URL 形态一致），验证：
 *   1) 页面能正常启动、拉仓库列表、拉库存、冻结账面、扫码落盘；
 *   2) 网页来源下 localStorage 可用（续盘依赖它）；
 *   3) 全流程无 JS 报错——即没有任何藏在 file:// 假设里的东西。
 * 接口用页面内 fetch 桩顶替，全程离线、不需要凭证。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = path.join(root, '库存盘点.html');
const INDEX = path.join(root, 'index.html');
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-http-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const meta = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/synthetic-store-999999-2026-09-14.meta.json'), 'utf8'));
const rows = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/synthetic-store-999999-2026-09-14.json'), 'utf8'));

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

// ---- 静态服务器：模拟项目型 Pages 的子路径 /inventory-check/ ----
// 托管的就是 Pages 实际会吐出去的那个文件（index.html），而不是本地双击用的那一份
const body = fs.readFileSync(INDEX);
check(body.equals(fs.readFileSync(HTML)), 'index.html 与 库存盘点.html 内容逐字节相同（线上 = 线下）');
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/inventory-check/' || u === '/inventory-check/index.html' || u === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('404');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${server.address().port}/inventory-check/`;
console.log('静态站点：' + SITE);

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
      }, 60000);
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
  window.__FIXTURE__ = ${JSON.stringify(JSON.stringify(rows))};
  window.__API_CALLS__ = [];
  window.__ERRORS__ = [];
  window.addEventListener('error', (e) => window.__ERRORS__.push(String(e.message)));
  localStorage.setItem('ic.cfg.v2', ${JSON.stringify(
    JSON.stringify({
      token: 'smoke-token', // guard-allow 离线占位值：接口已被页面内 fetch 桩顶替，不发真实请求
      companycode: '00000000',
      username: 'smoke',
      account: '',
      rememberPwd: false,
      sound: false,
      loadGlobalIndex: false,
    })
  )});
  const reply = (obj) => Promise.resolve({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: () => Promise.resolve(JSON.stringify(obj)) });
  window.fetch = function (url, init) {
    const u = String(url);
    const b = init && init.body ? JSON.parse(init.body) : {};
    if (/API\\/USER\\/STORE/i.test(u)) {
      window.__API_CALLS__.push({ api: 'warehouses' });
      return reply({ ResponseID: 0, Message: '', Data: [{ Id: ${meta.storeId}, Name: ${JSON.stringify(meta.storeName)}, BranchName: '测试门店', BranchId: '310453' }] });
    }
    if (/RptStoreNow/i.test(u)) {
      window.__API_CALLS__.push({ api: 'inventory' });
      const all = JSON.parse(window.__FIXTURE__);
      return reply({ ResponseID: 0, Message: '', Data: { Data: all, TotalRows: all.length, PageIndex: 1, PageSize: b.PageSize } });
    }
    window.__API_CALLS__.push({ api: 'other', url: u });
    return reply({ ResponseID: 0, Message: '', Data: null });
  };
} catch (e) {}
`;

let port = 0;
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
    '--window-size=1440,1100',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

let cdp = null;
try {
  for (let i = 0; i < 300; i++) {
    const f = path.join(PROFILE, 'DevToolsActivePort');
    if (fs.existsSync(f)) {
      const p = Number(String(fs.readFileSync(f, 'utf8')).split('\n')[0]);
      if (p) {
        port = p;
        break;
      }
    }
    await sleep(100);
  }
  if (!port) throw new Error('Edge 未就绪');

  let target = null;
  for (let i = 0; i < 120; i++) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
    if (target) break;
    await sleep(250);
  }
  cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: seed });
  await cdp.send('Page.navigate', { url: SITE });
  await sleep(1500);

  console.log('\n— 1. 页面在 http 源下启动 —');
  const boot = await cdp.eval(`(async () => {
    const t0 = Date.now();
    const wait = async (fn, ms) => { for (;;) { let v=false; try { v=fn(); } catch(e){} if (v) return true; if (Date.now()-t0>ms) return false; await new Promise(r=>setTimeout(r,150)); } };
    const ok = await wait(() => document.querySelectorAll('#store option').length > 1, 20000);
    return {
      origin: location.origin, protocol: location.protocol, secure: isSecureContext,
      title: document.title,
      storeOptions: document.querySelectorAll('#store option').length,
      hasSetup: !!document.querySelector('#setup'),
      calls: window.__API_CALLS__,
      errors: window.__ERRORS__,
      lsOk: (() => { try { localStorage.setItem('__probe','1'); localStorage.removeItem('__probe'); return true; } catch(e) { return String(e.name); } })(),
      storesLoaded: ok,
    };
  })()`);
  check(boot.title === '门店库存盘点 · 扫码核对', '标题正常渲染', boot.title);
  check(boot.storesLoaded, '仓库列表从接口加载成功（页面 JS 全部跑通）', boot.storeOptions);
  check(boot.calls.filter((c) => c.api === 'warehouses').length === 1, '确实发出了仓库列表请求');
  check(boot.lsOk === true, 'http 源下 localStorage 可用（进度可续盘）', boot.lsOk);
  check(boot.errors.length === 0, '无页面 JS 报错', boot.errors);

  console.log('\n— 2. 完整一步：拉库存 → 冻结账面 → 扫码 → 落盘 —');
  const flow = await cdp.eval(`(async () => {
    const t0 = Date.now();
    const wait = async (fn, ms) => { for (;;) { let v=false; try { v=fn(); } catch(e){} if (v) return true; if (Date.now()-t0>ms) return false; await new Promise(r=>setTimeout(r,150)); } };
    document.querySelector('#date').value = ${JSON.stringify(meta.date)};
    document.querySelector('#store').value = ${JSON.stringify(meta.storeId)};
    document.querySelector('#btn-start').click();
    const started = await wait(() => !document.querySelector('#scan-card').classList.contains('hidden'), 30000);
    await new Promise(r=>setTimeout(r,600));
    const book = JSON.parse(localStorage.getItem('ic.book.v2') || 'null');
    const stats = {}; document.querySelectorAll('#stats .stat').forEach(x=>stats[x.querySelector('.k').textContent]=x.querySelector('.v').textContent);
    // 扫一个账面里的串号
    const code = book ? (book.items.find(i => i.imei || i.sn)?.imei || book.items.find(i => i.sn)?.sn) : null;
    const el = document.querySelector('#scan-input');
    el.focus(); el.value = code;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await new Promise(r=>setTimeout(r,400));
    const state = JSON.parse(localStorage.getItem('ic.state.v2') || 'null');
    return { started, code, bookRows: book ? book.items.length : 0, bookStore: book ? book.storeName : null,
      scans: state ? (state.scans||[]).length : -1, stats, errors: window.__ERRORS__, url: location.href };
  })()`);
  check(flow.started, '点「开始拉取库存」后进入扫码台');
  check(flow.bookRows === rows.length, '账面冻结到本地存储（行数一致）', [flow.bookRows, rows.length]);
  check(flow.scans === 1, '扫码后写入本地（可续盘）', flow.scans);
  check(flow.errors.length === 0, '全流程无 JS 报错', flow.errors);
  check(flow.url.startsWith(SITE), 'URL 保持在站点子路径下', flow.url);
} catch (e) {
  fail++;
  console.log('  ✗ 执行异常：' + e.message);
} finally {
  try {
    if (cdp && cdp.ws) cdp.ws.close();
  } catch (e) {}
  edge.kill();
  server.close();
  await sleep(300);
  fs.rmSync(PROFILE, { recursive: true, force: true });
}

console.log(`\n网页托管形态：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
