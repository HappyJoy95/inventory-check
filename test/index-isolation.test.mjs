/* 全库索引按会话隔离（离线，用页面内桩）
 * 用法：node test/index-isolation.test.mjs
 *
 * 场景：A 会话开始加载全库索引（接口故意慢 4 秒），期间切到 B 会话。
 * 期望：A 的索引晚返回时被丢弃，**不污染 B**：
 *   - B 的「全库索引」状态不会变成已就绪
 *   - B 里扫到别仓的串号，只能说"本店账面没有，归属尚未核实"，不能报出 A 索引里的归属仓
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = path.join(root, '库存盘点.html');
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
let PORT = 9930 + Math.floor(Math.random() * 50); // 先给个候选，真正的端口由浏览器自己选（见 DevToolsActivePort）
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-idx-'));
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
      }, 120000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
    return r.result.value;
  }
}

// 两个仓：A(111) / B(222)。索引里 FOREIGN-SN-001 属于 A 仓。
const seed = `
try {
  window.__IDX_CALLS__ = [];
  localStorage.setItem('ic.cfg.v2', ${JSON.stringify(
    JSON.stringify({
      token: 'offline-idx-token',
      companycode: '00000000',
      username: 'offline-idx',
      account: '',
      rememberPwd: false,
      sound: false,
      loadGlobalIndex: true,
    })
  )});
  const reply = (obj) => Promise.resolve({
    ok: true, status: 200, headers: { get: () => 'application/json' },
    text: () => Promise.resolve(JSON.stringify(obj)),
  });
  const row = (store, name, sn) => ({ Store: store, ProName: name, Category1: '手机', Imei: sn, ProCount: 1, RowId: 1 });
  window.fetch = function (url, init) {
    const u = String(url);
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (/API\\/USER\\/STORE/i.test(u)) {
      return reply({ ResponseID: 0, Message: '', Data: [
        { Id: 111, Name: '甲仓', BranchName: '甲店', BranchId: '1' },
        { Id: 222, Name: '乙仓', BranchName: '乙店', BranchId: '2' },
      ] });
    }
    if (/RptStoreNow/i.test(u)) {
      if (!body.StoreIds) {
        // 全库索引：故意慢 4 秒返回
        window.__IDX_CALLS__.push('index-start');
        return new Promise((resolve) => setTimeout(() => {
          window.__IDX_CALLS__.push('index-done');
          resolve({
            ok: true, status: 200, headers: { get: () => 'application/json' },
            text: () => Promise.resolve(JSON.stringify({
              ResponseID: 0, Message: '',
              Data: { Data: [row('甲仓', '甲仓的手机', 'FOREIGN-SN-001'), row('甲仓', '甲仓的手机2', 'FOREIGN-SN-002')], TotalRows: 2, PageIndex: 1, PageSize: 30000 },
            })),
          });
        }, 4000));
      }
      const list = String(body.StoreIds) === '111'
        ? [row('甲仓', '甲仓的手机', 'A-SN-001'), row('甲仓', '甲仓的手机2', 'A-SN-002')]
        : [row('乙仓', '乙仓的手机', 'B-SN-001'), row('乙仓', '乙仓的手机2', 'B-SN-002')];
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
      for (;;) {
        let v = false; try { v = fn(); } catch (e) {}
        if (v) return v;
        if (Date.now() - t0 > timeout) throw new Error('等待超时 ' + label);
        await new Promise(r => setTimeout(r, 120));
      }
    },
    scan: (code) => { const el=document.querySelector('#scan-input'); el.focus(); el.value=code;
      el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); },
    fb: () => { const f=document.querySelector('#feedback'); return { cls:f.className, main:(f.querySelector('.fb-main')||{}).textContent||'', sub:(f.querySelector('.fb-sub')||{}).textContent||'' }; },
    header: () => document.querySelector('#session-info').textContent,
  };
`;

let cdp = null;
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

  console.log('— 1. 甲仓开盘点，索引开始加载（4 秒后才返回）—');
  const a = await cdp.eval(`(async () => {
    ${HELPERS}
    window.confirm = () => true;
    await __t.waitFor(() => document.querySelectorAll('#store option').length > 2, 20000, '仓库列表');
    document.querySelector('#store').value = '111';
    document.querySelector('#btn-start').click();
    await __t.waitFor(() => !document.querySelector('#scan-card').classList.contains('hidden'), 20000, '甲仓账面');
    await __t.waitFor(() => /全库索引 加载中/.test(__t.header()) || window.__IDX_CALLS__.length > 0, 8000, '索引开始');
    return { header: __t.header(), calls: window.__IDX_CALLS__.slice() };
  })()`);
  check(/甲仓/.test(a.header), '甲仓会话已开始', a.header);
  check(a.calls.includes('index-start'), '索引请求已发出', a.calls);

  console.log('\n— 2. 索引还没回来就切到乙仓（乙仓不加载索引，只可能被甲仓的晚返回污染）—');
  const b = await cdp.eval(`(async () => {
    ${HELPERS}
    // 关掉「自动建立全库索引」，这样乙仓不会自己发索引请求：
    // 一旦乙仓出现索引结果，就只可能来自甲仓那次晚返回
    document.querySelector('#btn-settings').click();
    await __t.sleep(300);
    const opt = document.querySelector('#opt-index');
    opt.checked = false;
    opt.dispatchEvent(new Event('change', { bubbles: true }));
    await __t.sleep(200);
    document.querySelector('#store').value = '222';
    document.querySelector('#btn-start').click();
    await __t.waitFor(() => /乙仓/.test(document.querySelector('#scan-store').textContent), 20000, '乙仓账面');
    await __t.sleep(300);
    return { store: document.querySelector('#scan-store').textContent, header: __t.header(), calls: window.__IDX_CALLS__.slice() };
  })()`);
  check(/乙仓/.test(b.store), '已切到乙仓会话', b.store);
  check(b.calls.filter((c) => c === 'index-start').length === 1, '乙仓没有发起新的索引请求', b.calls);
  check(!/个串号/.test(b.header), '切换后索引状态被清掉（未就绪）', b.header);

  console.log('\n— 3. 等甲仓的索引晚返回（这是关键）—');
  await sleep(5200);
  const after = await cdp.eval(`(async () => {
    ${HELPERS}
    await __t.sleep(300);
    // 在乙仓里扫一个「按甲仓索引属于甲仓」的串号
    __t.scan('FOREIGN-SN-001');
    await __t.sleep(500);
    return { header: __t.header(), fb: __t.fb(), calls: window.__IDX_CALLS__.slice() };
  })()`);
  check(after.calls.includes('index-done'), '甲仓的索引请求确实已经返回了', after.calls);
  check(after.calls.filter((c) => c === 'index-start').length === 1, '全程只有甲仓那一次索引请求', after.calls);
  check(!/个串号/.test(after.header), '晚返回的索引没有写入乙仓（状态仍未就绪）', after.header);
  check(/未加载/.test(after.header), '乙仓的索引状态保持「未加载」', after.header);
  check(
    after.fb.main === '查无此码',
    '乙仓里扫该串号判为「查无此码」，而不是被甲仓索引贴上归属',
    after.fb.main
  );
  check(/归属尚未核实/.test(after.fb.sub), '提示明确说明归属未核实', after.fb.sub.slice(0, 70));
  check(!/属于：甲仓/.test(after.fb.sub), '没有被甲仓索引贴上归属');

  console.log('\n— 4. 乙仓自己再加载一次索引：这次应当生效 —');
  const fresh = await cdp.eval(`(async () => {
    ${HELPERS}
    document.querySelector('#btn-gi').click();
    await __t.waitFor(() => /个串号/.test(__t.header()), 20000, '乙仓索引');
    const header = __t.header();
    // 换一个没扫过的别仓串号（前面那个已经扫过，会判重复）
    __t.scan('FOREIGN-SN-002');
    await __t.sleep(500);
    return { header, fb: __t.fb() };
  })()`);
  check(/全库索引 2 个串号/.test(fresh.header), '主动加载后索引就绪', fresh.header);
  check(fresh.fb.main === '非本店库存', '索引就绪后能给出归属判断', fresh.fb.main);
  check(/甲仓/.test(fresh.fb.sub), '归属指向甲仓', fresh.fb.sub.slice(0, 60));
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
}
console.log(`\n索引隔离：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
