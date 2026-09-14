/* 完整流程离线端到端（不需要网络/凭证）
 * 用法：node test/e2e-offline.test.mjs
 *
 * 用页面内 fetch 桩顶替 ERP 接口，跑完整链路：
 *   选仓库 → 拉取（冻结账面）→ 扫码 → 立即保存 → 刷新 → 从本地账面续盘 → 导出
 * 断言重点是「续盘不再回头拉 ERP」和「账面被冻结到本地」。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findFixture, missingFixtureHint } from './fixture-file.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = path.join(root, '库存盘点.html');
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
let PORT = 9900 + Math.floor(Math.random() * 60); // 先给个候选，真正的端口由浏览器自己选（见 DevToolsActivePort）
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-e2e-'));
const DL = path.join(root, 'test/tmp/downloads-e2e');
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

// 页面启动前装好：配置 + fetch 桩（把夹具当成 ERP 的返回）
const seed = `
try {
  window.__FIXTURE__ = ${JSON.stringify(JSON.stringify(rows))};
  window.__API_CALLS__ = [];
  localStorage.setItem('ic.cfg.v2', ${JSON.stringify(
    JSON.stringify({
      token: 'offline-e2e-token', // guard-allow 离线占位值：接口已被页面内 fetch 桩顶替，不发真实请求
      companycode: '00000000',
      username: 'offline-e2e',
      account: '',
      rememberPwd: false,
      sound: false,
      loadGlobalIndex: false,
    })
  )});
  const reply = (obj) => Promise.resolve({
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    text: () => Promise.resolve(JSON.stringify(obj)),
  });
  window.fetch = function (url, init) {
    const u = String(url);
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (/API\\/USER\\/STORE/i.test(u)) {
      window.__API_CALLS__.push({ api: 'warehouses' });
      return reply({ ResponseID: 0, Message: '', Data: [
        { Id: ${meta.storeId}, Name: ${JSON.stringify(meta.storeName)}, BranchName: '测试门店', BranchId: '310453' },
      ] });
    }
    if (/RptStoreNow/i.test(u)) {
      window.__API_CALLS__.push({ api: 'inventory', pageIndex: body.PageIndex, storeIds: body.StoreIds });
      const all = JSON.parse(window.__FIXTURE__);
      const list = body.StoreIds ? all.filter((r) => String(r.__storeId || ${JSON.stringify(meta.storeId)}) === String(body.StoreIds)) : all;
      return reply({ ResponseID: 0, Message: '', Data: { Data: list, TotalRows: list.length, PageIndex: 1, PageSize: body.PageSize } });
    }
    window.__API_CALLS__.push({ api: 'other', url: u });
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
    '--window-size=1440,1100',
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
    stats: () => { const m={}; document.querySelectorAll('#stats .stat').forEach(x=>m[x.querySelector('.k').textContent]=x.querySelector('.v').textContent); return m; },
    scan: (code) => { const el=document.querySelector('#scan-input'); el.focus(); el.value=code;
      el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); },
    cell: (r,c) => { const tr=document.querySelectorAll('#tab-body tbody tr')[r]; return tr?tr.children[c].textContent.trim():null; },
    tab: (n) => { const b=[...document.querySelectorAll('#tabs button')].find(x=>x.textContent.includes(n)); if(b) b.click(); return !!b; },
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

  console.log('— 1. 开新盘点：拉取 + 冻结账面 —');
  const start = await cdp.eval(`(async () => {
    ${HELPERS}
    await __t.waitFor(() => document.querySelectorAll('#store option').length > 1, 20000, '仓库列表');
    document.querySelector('#date').value = ${JSON.stringify(meta.date)};
    document.querySelector('#store').value = ${JSON.stringify(meta.storeId)};
    document.querySelector('#btn-start').click();
    await __t.waitFor(() => !document.querySelector('#scan-card').classList.contains('hidden'), 25000, '库存拉取');
    await __t.sleep(500);
    const book = JSON.parse(localStorage.getItem('ic.book.v2') || 'null');
    const state = JSON.parse(localStorage.getItem('ic.state.v2') || 'null');
    return {
      stats: __t.stats(),
      book: book ? { rows: book.items.length, version: book.version, store: book.storeName, sessionId: book.sessionId, fetchedAt: book.fetchedAt } : null,
      state: state ? { scans: (state.scans || []).length, sessionId: state.sessionId } : null,
      calls: window.__API_CALLS__,
    };
  })()`);
  check(!!start.book, '账面已冻结到本地（ic.book.v2）');
  check(start.book && start.book.rows === rows.length, '冻结账面行数 = 接口返回行数', [start.book && start.book.rows, rows.length]);
  check(start.book && start.book.version === 1, '账面版本号为 1');
  check(start.book && start.book.fetchedAt > 0, '记录了账面实际拉取时间');
  check(
    start.stats['应盘（有串号）'] === String(meta.serialRows),
    '界面应盘台数 = 账面有串号行数',
    [start.stats['应盘（有串号）'], meta.serialRows]
  );
  check(start.state && start.state.sessionId === start.book.sessionId, '状态与会话号绑在一起');
  check(start.calls.filter((c) => c.api === 'inventory').length === 1, '库存只请求了一次（未超分页）');

  console.log('\n— 2. 扫码后立即落盘（不靠延迟）—');
  const afterScan = await cdp.eval(`(async () => {
    ${HELPERS}
    __t.tab('未扫到'); await __t.sleep(400);
    const code = __t.cell(0,2).split(' / ')[0];
    __t.scan(code);
    await __t.sleep(150);   // 只要 150ms：验证不是"延迟保存"
    const state = JSON.parse(localStorage.getItem('ic.state.v2') || 'null');
    // 手工确认也要落盘
    document.querySelector('#tab-body tbody tr:first-child [data-act="confirm"]').click();
    await __t.sleep(150);
    const state2 = JSON.parse(localStorage.getItem('ic.state.v2') || 'null');
    return {
      code,
      scansAfter150ms: state ? (state.scans || []).length : -1,
      manualAfter150ms: state2 ? Object.keys(state2.manualFound || {}).length : -1,
      status: (document.querySelector('#save-status') || {}).textContent || '',
    };
  })()`);
  check(afterScan.scansAfter150ms === 1, '扫码后 150ms 内就已写入本机', afterScan.scansAfter150ms);
  check(afterScan.manualAfter150ms === 1, '手工确认后 150ms 内也已写入', afterScan.manualAfter150ms);
  check(/已保存/.test(afterScan.status), '界面显示已保存状态', afterScan.status);

  console.log('\n— 2.5 扫码记录可以单独撤销 —');
  const undoOne = await cdp.eval(`(async () => {
    ${HELPERS}
    // 先补两台，凑够可撤销的条数
    __t.tab('未扫到'); await __t.sleep(400);
    const codes = [__t.cell(0,2).split(' / ')[0], __t.cell(1,2).split(' / ')[0], __t.cell(2,2).split(' / ')[0]];
    for (const c of codes) { __t.scan(c); await __t.sleep(250); }
    const before = __t.stats();
    __t.tab('已扫明细'); await __t.sleep(500);
    const rows = [...document.querySelectorAll('#tab-body tbody tr')];
    const scannedRow = rows.find((tr) => tr.children[2].textContent.trim() === '扫码');
    const targetName = scannedRow.children[1].textContent.trim();
    const targetCode = scannedRow.children[3].textContent.trim();
    const btn = scannedRow.querySelector('[data-act="unscan"]');
    const hasBtn = !!btn;
    btn.click();
    await __t.sleep(600);
    const afterRows = [...document.querySelectorAll('#tab-body tbody tr')].map((tr) => tr.children[3].textContent.trim());
    const after = __t.stats();
    __t.tab('未扫到'); await __t.sleep(500);
    const backInMissing = [...document.querySelectorAll('#tab-body tbody tr')]
      .some((tr) => tr.children[2].textContent.includes(targetCode));
    return { before: before['已盘到'], after: after['已盘到'], hasBtn, targetName, targetCode,
             goneFromFound: !afterRows.includes(targetCode), backInMissing,
             toast: (document.querySelector('#toast') || {}).textContent || '' };
  })()`);
  check(undoOne.hasBtn, '已扫明细里每条扫码记录都有「撤销这一扫」按钮');
  check(
    Number(undoOne.after) === Number(undoOne.before) - 1,
    '撤销后已盘数 -1（只影响这一条）',
    [undoOne.before, undoOne.after]
  );
  check(undoOne.goneFromFound, '该条从「已扫明细」消失', undoOne.targetCode);
  check(undoOne.backInMissing, '对应商品回到「未扫到」', undoOne.targetCode);
  check(/已撤销这一扫/.test(undoOne.toast), '有明确提示', undoOne.toast);

  console.log('\n— 2.6 表外码可以整条删除 —');
  const delExtra = await cdp.eval(`(async () => {
    ${HELPERS}
    __t.scan('ZZ-NOT-IN-BOOK-9');
    await __t.sleep(400);
    __t.tab('表外码'); await __t.sleep(500);
    const count = () => document.querySelectorAll('#tab-body tbody tr').length;
    const before = count();
    const row = document.querySelector('#tab-body tbody tr');
    const code = row.children[1].textContent.trim();
    row.querySelector('[data-act="unscan-code"]').click();
    await __t.sleep(600);
    return { before, after: count(), code };
  })()`);
  check(delExtra.before === 1 && delExtra.after === 0, '删除后表外码归零', [delExtra.before, delExtra.after]);
  check(/^ZZ-NOT-IN-BOOK-9$/.test(delExtra.code), '删的是那个码', delExtra.code);

  console.log('\n— 2.7 最近扫描的小叉也能删 —');
  const delRecent = await cdp.eval(`(async () => {
    ${HELPERS}
    __t.scan('ZZ-RECENT-1');
    await __t.sleep(400);
    const n1 = __t.stats()['表外码'];
    document.querySelector('#recent [data-act="unscan-at"]').click();
    await __t.sleep(500);
    return { n1, n2: __t.stats()['表外码'] };
  })()`);
  check(delRecent.n1 === '1' && delRecent.n2 === '0', '点最近扫描的 ✕ 能删掉刚扫错的那条', [delRecent.n1, delRecent.n2]);

  console.log('\n— 3. 刷新：从本地账面续盘，不再拉 ERP —');
  await cdp.send('Page.reload', {});
  await cdp.eval(HELPERS);
  const resumed = await cdp.eval(`(async () => {
    ${HELPERS}
    await __t.waitFor(() => !document.querySelector('#scan-card').classList.contains('hidden'), 20000, '自动续盘');
    await __t.sleep(500);
    window.__API_CALLS__ = [];   // 从这一刻起统计
    const s = __t.stats();
    const invCallsAfter = window.__API_CALLS__.filter(c => c.api === 'inventory').length;
    return { stats: s, invCallsAfter, store: document.querySelector('#scan-store').textContent };
  })()`);
  check(Number(resumed.stats['已盘到']) >= 2, '续盘后已盘数保持（含前面补扫的）', resumed.stats['已盘到']);
  check(resumed.stats['其中手工确认'] === '1', '手工确认状态保住了', resumed.stats['其中手工确认']);
  check(resumed.invCallsAfter === 0, '续盘过程没有重新拉库存', resumed.invCallsAfter);

  console.log('\n— 4. 续盘后导出 —');
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
ws = wb['汇总']
print(json.dumps({"summary": {r[0]: r[1] for r in ws.iter_rows(values_only=True) if r[0]},
  "found_rows": wb['已扫明细'].max_row, "missing_rows": wb['未扫到'].max_row}, ensure_ascii=False))
`;
    const info = JSON.parse(
      execFileSync('python3', ['-c', py, path.join(DL, exported)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    );
    check(Number(info.summary['已盘到']) >= 2, '导出汇总里已盘数与界面一致', info.summary['已盘到']);
    check(
      String(info.summary['应盘（有串号）']) === String(meta.serialRows),
      '导出应盘数 = 冻结账面有串号行数',
      info.summary['应盘（有串号）']
    );
    check(
      info.found_rows === Number(info.summary['已盘到']) + 1,
      '已扫明细行数 = 已盘数 + 表头',
      [info.found_rows, info.summary['已盘到']]
    );
  }

  console.log('\n— 5. 结束盘点：清键 + 取消待执行保存 —');
  const cleared = await cdp.eval(`(async () => {
    ${HELPERS}
    window.confirm = () => true;   // 自动确认弹窗
    document.querySelector('#btn-new').click();
    await __t.sleep(600);
    return {
      book: localStorage.getItem('ic.book.v2'),
      state: localStorage.getItem('ic.state.v2'),
      setupVisible: !document.querySelector('#setup').classList.contains('hidden'),
      saveStatus: (document.querySelector('#save-status') || {}).textContent || '',
    };
  })()`);
  check(cleared.book === null && cleared.state === null, '账面与状态都已清除', [cleared.book, cleared.state]);
  check(cleared.setupVisible, '回到选择仓库界面');
  check(cleared.saveStatus === '', '保存状态已复位', cleared.saveStatus);
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
console.log(`\n离线端到端：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
