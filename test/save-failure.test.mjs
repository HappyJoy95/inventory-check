/* 保存失败与备份（离线）
 * 用法：node test/save-failure.test.mjs
 *
 * 用一个"写入就抛配额错误"的 localStorage 打桩，验证：
 *   - 保存失败必须明确提示（含"空间不足"），不能静默丢数据
 *   - 备份按钮被标红，点它能下载出包含账面 + 记录的 JSON
 *   - 结束盘点仍然能把键清干净、状态复位
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findFixture, missingFixtureHint } from './fixture-file.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = path.join(root, '库存盘点.html');
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
let PORT = 9960 + Math.floor(Math.random() * 30); // 先给个候选，真正的端口由浏览器自己选（见 DevToolsActivePort）
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-quota-'));
const DL = path.join(root, 'test/tmp/downloads-quota');
fs.rmSync(DL, { recursive: true, force: true });
fs.mkdirSync(DL, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fx = findFixture();
if (!fx) {
  missingFixtureHint();
  process.exit(1);
}
const rows = fx.rows;
const meta = fx.meta;

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
      }, 120000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
    return r.result.value;
  }
}

// 打桩：写 ic.state.v2 时抛配额错误（账面仍可写，模拟"存满了"）
const seed = `
try {
  window.__QUOTA__ = { stateFails: true, errors: [] };
  const orig = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) {
    if (window.__QUOTA__.stateFails && String(k).indexOf('ic.state') === 0) {
      window.__QUOTA__.errors.push(String(k));
      const e = new Error('quota exceeded');
      e.name = 'QuotaExceededError';
      throw e;
    }
    return orig.call(this, k, v);
  };
  window.__FIXTURE__ = ${JSON.stringify(JSON.stringify(rows))};
  localStorage.setItem('ic.cfg.v2', ${JSON.stringify(
    JSON.stringify({
      token: 'quota-test-token',
      companycode: '00000000',
      username: 'quota-test',
      account: '',
      rememberPwd: false,
      sound: false,
      loadGlobalIndex: false,
    })
  )});
  const reply = (obj) => Promise.resolve({
    ok: true, status: 200, headers: { get: () => 'application/json' },
    text: () => Promise.resolve(JSON.stringify(obj)),
  });
  window.fetch = function (url, init) {
    const u = String(url);
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (/API\\/USER\\/STORE/i.test(u)) {
      return reply({ ResponseID: 0, Message: '', Data: [{ Id: ${meta.storeId}, Name: ${JSON.stringify(meta.storeName)}, BranchName: '店', BranchId: '1' }] });
    }
    if (/RptStoreNow/i.test(u)) {
      const list = JSON.parse(window.__FIXTURE__);
      return reply({ ResponseID: 0, Message: '', Data: { Data: list, TotalRows: list.length, PageIndex: 1, PageSize: body.PageSize } });
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
    scan: (code) => { const el=document.querySelector('#scan-input'); el.focus(); el.value=code;
      el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); },
    cell: (r,c) => { const tr=document.querySelectorAll('#tab-body tbody tr')[r]; return tr?tr.children[c].textContent.trim():null; },
    tab: (n) => { const b=[...document.querySelectorAll('#tabs button')].find(x=>x.textContent.includes(n)); if(b) b.click(); return !!b; },
    save: () => { const e=document.querySelector('#save-status'); return { text:e.textContent, cls:e.className, backupNeeds: document.querySelector('#btn-backup').classList.contains('need') }; },
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

  console.log('— 1. 存储写不进去时必须明确提示 —');
  const started = await cdp.eval(`(async () => {
    ${HELPERS}
    await __t.waitFor(() => document.querySelectorAll('#store option').length > 1, 20000, '仓库');
    document.querySelector('#date').value = ${JSON.stringify(meta.date)};
    document.querySelector('#store').value = ${JSON.stringify(meta.storeId)};
    document.querySelector('#btn-start').click();
    await __t.waitFor(() => !document.querySelector('#scan-card').classList.contains('hidden'), 25000, '账面');
    await __t.sleep(600);
    return { save: __t.save(), errors: window.__QUOTA__.errors.length,
             bookSaved: !!localStorage.getItem('ic.book.v2'), stateSaved: !!localStorage.getItem('ic.state.v2') };
  })()`);
  check(started.bookSaved, '账面（大对象）仍然保存成功', started.bookSaved);
  check(started.stateSaved === false, '状态写入被配额挡住（模拟存储写满）');
  check(started.errors > 0, '确实触发了写入失败', started.errors);
  check(started.save.cls.includes('err'), '状态栏是错误样式', started.save.cls);
  check(/空间不足|保存失败/.test(started.save.text), '明确提示保存失败', started.save.text);
  check(started.save.backupNeeds === true, '备份按钮被标红提示', started.save.backupNeeds);

  console.log('\n— 2. 继续扫码仍然可用，但每次都提示存不下来 —');
  const scanned = await cdp.eval(`(async () => {
    ${HELPERS}
    __t.tab('未扫到'); await __t.sleep(400);
    const code = __t.cell(0,2).split(' / ')[0];
    __t.scan(code);
    await __t.sleep(400);
    return { code, fb: document.querySelector('#feedback .fb-main').textContent, save: __t.save(),
             stats: [...document.querySelectorAll('#stats .stat')].map(x=>x.textContent).join('|').slice(0,80) };
  })()`);
  check(scanned.fb === '已盘到', '扫码功能不受影响', scanned.code);
  check(scanned.save.cls.includes('err'), '依然明确提示保存失败', scanned.save.text);

  console.log('\n— 3. 下载会话备份（保命通道）—');
  const before = fs.readdirSync(DL);
  await cdp.eval(`document.querySelector('#btn-backup').click()`);
  let exported = null;
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    const now = fs.readdirSync(DL).filter((f) => !f.endsWith('.crdownload'));
    if (now.length > before.length) {
      exported = now.find((f) => !before.includes(f));
      break;
    }
  }
  check(!!exported, '备份文件已下载', exported);
  if (exported) {
    const j = JSON.parse(fs.readFileSync(path.join(DL, exported), 'utf8'));
    check(j.kind === 'inventory-check-backup', '备份有类型标记', j.kind);
    check(j.session && j.session.state && j.session.state.scans.length === 1, '备份里有扫码记录', j.session && j.session.state.scans.length);
    check(j.session.book && j.session.book.items.length === rows.length, '备份里有完整账面', j.session.book && j.session.book.items.length);
    check(!!j.session.stats, '备份里有统计');
  }

  console.log('\n— 4. 结束盘点：即便一直保存失败也要清干净 —');
  const cleared = await cdp.eval(`(async () => {
    ${HELPERS}
    window.confirm = () => true;
    document.querySelector('#btn-new').click();
    await __t.sleep(500);
    return { book: localStorage.getItem('ic.book.v2'), state: localStorage.getItem('ic.state.v2'), save: __t.save() };
  })()`);
  check(cleared.book === null && cleared.state === null, '账面与状态键都已清除', [cleared.book, cleared.state]);
  check(cleared.save.text === '' && !cleared.save.cls.includes('err'), '保存状态已复位', cleared.save);
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
console.log(`\n保存失败与备份：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
