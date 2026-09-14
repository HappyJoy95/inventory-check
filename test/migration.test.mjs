/* 旧版本记录迁移（离线）
 * 用法：node test/migration.test.mjs
 *
 * 场景：本机只有旧版记录（ic.session.v1，没有保存原始账面）。
 * 期望：保留备份 → 重新建立账面 → 扫码按串号核对回来 →
 *       手工数量/确认/备注一律进「待核实」，不自动继承。
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
let PORT = 9990 + Math.floor(Math.random() * 20); // 先给个候选，真正的端口由浏览器自己选（见 DevToolsActivePort）
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-mig-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fx = findFixture();
if (!fx) {
  missingFixtureHint();
  process.exit(1);
}
const rows = fx.rows;
const meta = fx.meta;
const serialRow = rows.find((r) => (r.Imei || '').trim());

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

// 旧版记录：1 条扫码（串号真实存在）+ 手工数量/确认/备注（键是旧的行号 rN，无法对应商品）
const legacy = {
  v: 1,
  date: meta.date,
  storeId: meta.storeId,
  storeName: meta.storeName,
  startedAt: 1700000000000,
  scans: [{ code: serialRow.Imei, ts: 1700000001000, note: '' }],
  manualQty: { r4: 7 },
  manualFound: { r1: { ts: 1700000002000 } },
  manualNotes: { r1: '旧版本的样机备注' },
};

const seed = `
try {
  window.__FIXTURE__ = ${JSON.stringify(JSON.stringify(rows))};
  localStorage.setItem('ic.cfg.v2', ${JSON.stringify(
    JSON.stringify({
      token: 'offline-migration-token', // guard-allow 离线占位值：接口已被页面内 fetch 桩顶替，不发真实请求
      companycode: '00000000',
      username: 'offline-migration',
      account: '',
      rememberPwd: false,
      sound: false,
      loadGlobalIndex: false,
    })
  )});
  localStorage.removeItem('ic.book.v2');
  localStorage.removeItem('ic.state.v2');
  localStorage.setItem('ic.session.v1', ${JSON.stringify(JSON.stringify(legacy))});
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
    waitFor: async (fn, timeout = 25000, label = '') => {
      const t0 = Date.now();
      for (;;) { let v=false; try{v=fn();}catch(e){}
        if (v) return v;
        if (Date.now()-t0 > timeout) throw new Error('等待超时 ' + label);
        await new Promise(r=>setTimeout(r,120)); }
    },
    stats: () => { const m={}; document.querySelectorAll('#stats .stat').forEach(x=>m[x.querySelector('.k').textContent]=x.querySelector('.v').textContent); return m; },
    tab: (n) => { const b=[...document.querySelectorAll('#tabs button')].find(x=>x.textContent.includes(n)); if(b) b.click(); return !!b; },
    rowCount: () => document.querySelectorAll('#tab-body tbody tr').length,
    cells: (r) => { const tr=document.querySelectorAll('#tab-body tbody tr')[r]; return tr?[...tr.children].map(td=>td.textContent.trim()):null; },
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

  console.log('— 旧记录迁移 —');
  const mig = await cdp.eval(`(async () => {
    ${HELPERS}
    await __t.waitFor(() => !document.querySelector('#scan-card').classList.contains('hidden'), 30000, '迁移完成');
    await __t.sleep(800);
    const book = JSON.parse(localStorage.getItem('ic.book.v2') || 'null');
    const state = JSON.parse(localStorage.getItem('ic.state.v2') || 'null');
    return {
      stats: __t.stats(),
      bookRows: book ? book.items.length : 0,
      stateScans: state ? (state.scans || []).length : -1,
      pending: state ? (state.pendingReview || []).length : -1,
      legacyKeyGone: localStorage.getItem('ic.session.v1') === null,
      legacyBackup: !!localStorage.getItem('ic.legacy.v1'),
      toast: (document.querySelector('#toast') || {}).textContent || '',
      tabs: [...document.querySelectorAll('#tabs button')].map(b => b.textContent.replace(/\\d+$/, '').trim()),
    };
  })()`);
  check(mig.bookRows === rows.length, '重新建立了冻结账面', [mig.bookRows, rows.length]);
  check(mig.legacyKeyGone, '旧键已移走，不再参与恢复');
  check(mig.legacyBackup, '旧数据已保留备份');
  check(mig.stateScans === 1, '扫码记录按串号核对回来 1 条', mig.stateScans);
  check(mig.stats['已盘到'] === '1', '界面已盘 = 1（只算扫码那条）', mig.stats['已盘到']);
  check(mig.stats['其中手工确认'] === '0', '旧的手工确认没有被自动继承', mig.stats['其中手工确认']);
  check(mig.pending === 3, '手工数量/确认/备注 3 条进入待核实', mig.pending);
  check(mig.tabs.includes('待核实'), '出现「待核实」页签', mig.tabs);
  check(/待核实|人工核对/.test(mig.toast), '有明确提示', mig.toast.slice(0, 60));

  console.log('\n— 待核实页内容 —');
  const review = await cdp.eval(`(async () => {
    ${HELPERS}
    __t.tab('待核实'); await __t.sleep(500);
    const rows = [];
    for (let i = 0; i < __t.rowCount(); i++) rows.push(__t.cells(i));
    return { rows, count: __t.rowCount() };
  })()`);
  check(review.count === 3, '待核实页列出 3 条', review.count);
  const kinds = review.rows.map((r) => r[1]);
  check(kinds.includes('无串号实盘数量'), '含旧的无串号实盘数量', kinds);
  check(kinds.includes('手工确认'), '含旧的手工确认');
  check(kinds.includes('确认备注'), '含旧的确认备注');
  check(
    review.rows.some((r) => /旧版本的样机备注/.test(r[3])),
    '备注内容保留下来供人工核对'
  );
  check(
    review.rows.every((r) => /人工核对|无法确认/.test(r[4])),
    '每条都写明原因',
    review.rows.map((r) => r[4])
  );

  console.log('\n— 迁移后仍可正常扫码 —');
  const scanAfter = await cdp.eval(`(async () => {
    ${HELPERS}
    __t.tab('未扫到'); await __t.sleep(400);
    const tr = document.querySelectorAll('#tab-body tbody tr')[0];
    const code = tr.children[2].textContent.trim().split(' / ')[0];
    const el = document.querySelector('#scan-input'); el.focus(); el.value = code;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await __t.sleep(400);
    return { code, fb: document.querySelector('#feedback .fb-main').textContent, stats: __t.stats() };
  })()`);
  check(scanAfter.fb === '已盘到', '迁移后扫码正常', scanAfter.code);
  check(scanAfter.stats['已盘到'] === '2', '已盘增加到 2', scanAfter.stats['已盘到']);
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
console.log(`\n旧版迁移：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
