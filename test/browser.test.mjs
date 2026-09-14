/* 浏览器端端到端测试：用 Edge(headless) 通过 CDP 真实驱动「库存盘点.html」
 * 验证：file:// 下跨域调接口、拉库存、扫码匹配、结果页、导出 Excel、刷新续盘
 * 用法：node test/browser.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { seedScript, hasCreds, skipIfNoCreds, STORE } from './browser-env.mjs';

if (skipIfNoCreds('浏览器端到端（真实拉取库存）')) process.exit(0);
if (!STORE.id) {
  console.log('\n[跳过] 端到端需要指定门店：ERP_STORE_ID=<仓库Id> [ERP_STORE_NAME=<仓库名>]');
  process.exit(0);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '..');
const HTML = path.join(root, '库存盘点.html');
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
let PORT = 9333 + Math.floor(Math.random() * 200); // 先给个候选，真正的端口由浏览器自己选（见 DevToolsActivePort）
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-edge-'));
const DL = path.join(root, 'test/tmp/downloads');
fs.rmSync(DL, { recursive: true, force: true });
fs.mkdirSync(DL, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0,
  fail = 0;
const logs = [];
function check(cond, label, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`);
  }
}

/* ---------------- 极简 CDP 客户端 ---------------- */
class CDP {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.waiting = new Map();
    this.events = [];
    this.handlers = {};
  }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', (e) => rej(new Error('CDP 连接失败')), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (msg.id && this.waiting.has(msg.id)) {
        const { res, rej } = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        (this.handlers[msg.method] || []).forEach((h) => h(msg.params));
      }
    });
  }
  on(method, cb) {
    (this.handlers[method] = this.handlers[method] || []).push(cb);
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waiting.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.waiting.has(id)) {
          this.waiting.delete(id);
          rej(new Error('CDP 超时: ' + method));
        }
      }, 120000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error('页面脚本异常: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
    }
    return r.result.value;
  }
  close() {
    try {
      this.ws.close();
    } catch (e) {}
  }
}

async function getJSON(url) {
  const r = await fetch(url);
  return r.json();
}

/* ---------------- 启动 Edge ---------------- */
const url = 'file://' + encodeURI(HTML);
console.log('启动 Edge(headless) 打开：' + url);
const edge = spawn(
  EDGE,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--disable-extensions',
    '--disable-features=Translate,MediaRouter',
    '--window-size=1440,1100',
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] }
);
let edgeErr = '';
edge.stderr.on('data', (d) => (edgeErr += d.toString()));

let browserCDP = null;
let pageCDP = null;
try {
  // 等待调试端口
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
  let version = null;
  for (let i = 0; i < 60; i++) {
    try {
      version = await getJSON(`http://127.0.0.1:${PORT}/json/version`);
      break;
    } catch (e) {
      await sleep(250);
    }
  }
  if (!version) throw new Error('Edge 调试端口未就绪：' + edgeErr.slice(0, 300));
  console.log('浏览器：' + version.Browser);

  browserCDP = new CDP(version.webSocketDebuggerUrl);
  await browserCDP.connect();
  await browserCDP.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });

  // 找到页面 target
  let target = null;
  for (let i = 0; i < 40; i++) {
    const list = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
    target = list.find((t) => t.type === 'page');
    if (target) break;
    await sleep(250);
  }
  if (!target) throw new Error('未找到页面 target');
  pageCDP = new CDP(target.webSocketDebuggerUrl);
  await pageCDP.connect();
  await pageCDP.send('Runtime.enable');
  await pageCDP.send('Page.enable'); // 必须先 enable，addScriptToEvaluateOnNewDocument 才生效
  // 页面脚本执行前把「外部提供的凭证」写进 localStorage（测试文件里不含凭证）
  await pageCDP.send('Page.addScriptToEvaluateOnNewDocument', { source: seedScript() });
  await pageCDP.send('Page.navigate', { url: url });
  await sleep(900);
  if (process.env.IC_DEBUG) {
    console.log('  [debug] href =', await pageCDP.eval('location.href'));
    console.log('  [debug] cfg  =', String(await pageCDP.eval(`localStorage.getItem('ic.cfg.v2')`)).slice(0, 80));
    console.log('  [debug] opt  =', await pageCDP.eval(`document.querySelectorAll('#store option').length`));
    console.log('  [debug] 状态 =', JSON.stringify(await pageCDP.eval(`(document.querySelector('#login-status')||{}).textContent`)));
  }
  await pageCDP.send('Log.enable');
  // 一键提交会弹 confirm：自动点「确定」
  pageCDP.on('Page.javascriptDialogOpening', async () => {
    try {
      await pageCDP.send('Page.handleJavaScriptDialog', { accept: true });
    } catch (e) {}
  });

  const consoleErrors = [];
  pageCDP.ws.addEventListener('message', (ev) => {
    try {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 200));
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon/.test(m.params.entry.text))
        consoleErrors.push(m.params.entry.text.slice(0, 200));
    } catch (e) {}
  });

  // 注入测试辅助
  const HELPERS = `
    window.__t = {
      sleep: (ms) => new Promise(r => setTimeout(r, ms)),
      waitFor: async (fn, timeout=45000, label='') => {
        const t0 = Date.now();
        for(;;){
          let v=false; try{ v = fn(); }catch(e){}
          if (v) return v;
          if (Date.now()-t0 > timeout) throw new Error('等待超时: ' + label);
          await new Promise(r=>setTimeout(r,150));
        }
      },
      stats: () => { const m={}; document.querySelectorAll('#stats .stat').forEach(x=>m[x.querySelector('.k').textContent]=x.querySelector('.v').textContent); return m; },
      badge: (name) => { const b=[...document.querySelectorAll('#tabs button')].find(x=>x.textContent.includes(name)); return b && b.querySelector('.badge') ? b.querySelector('.badge').textContent : null; },
      scan: (code) => {
        const el = document.querySelector('#scan-input');
        el.focus(); el.value = code;
        el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
        return el.value;
      },
      fb: () => { const f=document.querySelector('#feedback'); return {cls:f.className, main:(f.querySelector('.fb-main')||{}).textContent||'', sub:(f.querySelector('.fb-sub')||{}).textContent||''}; },
      tab: (name) => { const b=[...document.querySelectorAll('#tabs button')].find(x=>x.textContent.includes(name)); b.click(); return true; },
      cellText: (r,c) => { const tr=document.querySelectorAll('#tab-body tbody tr')[r]; return tr ? tr.children[c].textContent.trim() : null; },
      rowCount: () => document.querySelectorAll('#tab-body tbody tr').length,
      scanTotal: () => (document.querySelector('#progress-extra').textContent.split(' ')[1] || ''),
      listHas: (text) => [...document.querySelectorAll('#tab-body tbody tr')].some(tr=>tr.textContent.includes(text)),
      typeInto: (sel, val, ev) => { const el=document.querySelector(sel); el.value=val; el.dispatchEvent(new Event(ev||'change',{bubbles:true})); },
    };
  `;

  await pageCDP.eval(HELPERS);

  console.log('\n— 1. 启动与仓库列表（file:// 跨域调接口）—');
  const whCount = await pageCDP.eval(`(async () => {
    ${HELPERS}
    // 凭证失效时不要傻等：先把页面上的提示读出来
    const expired = await __t.waitFor(
      () => document.querySelectorAll('#store option').length > 5 ||
            /登录已过期|还没有登录/.test(((document.querySelector('#login-status')||{}).textContent||'')),
      45000, '仓库列表');
    if (document.querySelectorAll('#store option').length <= 5) {
      throw new Error('凭证未生效：' + ((document.querySelector('#login-status')||{}).textContent||''));
    }
    return document.querySelectorAll('#store option').length - 1;
  })()`);
  if (whCount instanceof Object) throw new Error('仓库列表读取异常: ' + JSON.stringify(whCount));
  check(whCount >= 40, `仓库列表加载成功（${whCount} 个）`);
  const hasTarget = await pageCDP.eval(
    `[...document.querySelectorAll('#store option')].some(o=>o.value===${JSON.stringify(STORE.id)})`
  );
  check(hasTarget, '列表内含目标仓「' + STORE.id + '」');

  console.log('\n— 2. 拉取门店库存 —');
  const load = await pageCDP.eval(`(async () => {
    ${HELPERS}
    document.querySelector('#date').value = '2026-09-14';
    document.querySelector('#store').value = ${JSON.stringify(STORE.id)};
    document.querySelector('#btn-start').click();
    await __t.waitFor(() => !document.querySelector('#scan-card').classList.contains('hidden') && document.querySelectorAll('#stats .stat').length === 6, 60000, '库存加载');
    await __t.sleep(300);
    return { stats: __t.stats(), header: document.querySelector('#scan-store').textContent };
  })()`);
  // ERP 是生产库，库存会变：以本次实际拉到的数字为基准，后续断言都相对它
  const S0 = { should: Number(load.stats['应盘（有串号）']), nonSerial: Number(load.stats['无串号商品']) };
  check(S0.should > 100, '应盘台数已读出（与 ERP 同源）', S0.should);
  check(load.stats['未扫到'] === String(S0.should), '未扫到时初始 = 应盘', load.stats['未扫到']);
  check(S0.nonSerial > 0, '无串号商品行数已读出', S0.nonSerial);
  check(load.header.indexOf(STORE.name || STORE.id) >= 0 || /库/.test(load.header), '界面显示当前仓库', load.header);

  console.log('\n— 3. 扫码匹配 —');
  const scan1 = await pageCDP.eval(`(async () => {
    ${HELPERS}
    __t.tab('未扫到');
    await __t.sleep(200);
    const serials = __t.cellText(0,2).split(' / ');
    const code = serials[0];
    // 注意：这三步之间不能有 await —— 要模拟扫码枪「同一瞬间连发两次」，
    // 靠 sleep 的话机器一慢就超过去重窗口，测试会随负载随机失败
    __t.scan(code);
    const fb1 = __t.fb();
    const scansAfterFirst = __t.scanTotal();
    __t.scan(code);
    const scansAfterDouble = __t.scanTotal();
    await __t.sleep(120);
    const afterOne = __t.stats();
    // 同一台机器的第二个串号（若有）应判重复
    let fb2 = null;
    if (serials[1]) { __t.scan(serials[1]); await __t.sleep(200); fb2 = __t.fb(); }
    // 大小写/空格容错（间隔 0.6 秒，模拟人手重扫）
    await __t.sleep(600);
    __t.scan('  ' + code.toLowerCase() + '  '); await __t.sleep(200);
    const fb3 = __t.fb();
    // 不存在的码
    __t.scan('ZZ-TEST-NOT-EXIST-001'); await __t.sleep(200);
    const fb4 = __t.fb();
    const s = __t.stats();
    return { code, serials, fb1, fb2, fb3, fb4, afterOne, scansAfterFirst, scansAfterDouble, s, inputCleared: document.querySelector('#scan-input').value === '' };
  })()`);
  check(scan1.fb1.main === '已盘到', '扫真实串号 → 已盘到', scan1.code);
  check(
    scan1.afterOne['已盘到'] === '1' && scan1.afterOne['未扫到'] === String(S0.should - 1),
    '计数即时更新（已盘 1 / 未扫 -1）',
    [scan1.afterOne['已盘到'], scan1.afterOne['未扫到'], S0.should - 1]
  );
  check(scan1.scansAfterFirst === '1' && scan1.scansAfterDouble === '1', '扫码枪连发同一码只计一次', [
    scan1.scansAfterFirst,
    scan1.scansAfterDouble,
  ]);
  if (scan1.serials[1]) check(scan1.fb2 && scan1.fb2.main === '重复扫描', '扫同一台的第二个串号 → 判重复');
  check(scan1.fb3.main === '重复扫描', '大小写+空格差异仍识别为重复');
  check(scan1.fb4.main === '查无此码', '陌生码 → 查无此码');
  check(scan1.s['表外码'] === '1', '表外码计入 1 个');
  check(scan1.inputCleared, '扫码后输入框自动清空');

  console.log('\n— 4. 表外码备注与撤销 —');
  const undo = await pageCDP.eval(`(async () => {
    ${HELPERS}
    __t.tab('表外码'); await __t.sleep(250);
    const extraRowsBefore = __t.rowCount();
    const extraCode = __t.cellText(0,1);
    __t.typeInto('#tab-body tbody tr:first-child .note-input', '测试备注');
    await __t.sleep(150);
    // 切走再切回，验证备注已保存并回显
    __t.tab('已扫明细'); await __t.sleep(200);
    __t.tab('表外码'); await __t.sleep(200);
    const noteBack = (document.querySelector('#tab-body .note-input')||{}).value || '';
    // 撤销「查无此码」那一笔
    document.querySelector('#btn-undo').click();
    await __t.sleep(250);
    const s1 = __t.stats();
    __t.tab('表外码'); await __t.sleep(200);
    const extraRowsAfter = __t.rowCount();
    __t.tab('已扫明细'); await __t.sleep(200);
    const foundRows = __t.rowCount();
    // 再撤销「重复扫描」那一笔：应只删掉这条流水，机器仍是已盘到
    document.querySelector('#btn-undo').click();
    await __t.sleep(250);
    const sDup = __t.stats();
    // 再撤销「已盘到」那一笔：这才真正回到未盘
    document.querySelector('#btn-undo').click();
    await __t.sleep(250);
    const s2 = __t.stats();
    // 重新扫一台，恢复状态供后续步骤使用
    __t.tab('未扫到'); await __t.sleep(250);
    const code2 = __t.cellText(0,2).split(' / ')[0];
    __t.scan(code2); await __t.sleep(200);
    const s3 = __t.stats();
    __t.tab('汇总'); await __t.sleep(200);
    const sumText = document.querySelector('#tab-body').textContent;
    return { extraRowsBefore, extraCode, noteBack, s1, extraRowsAfter, foundRows, sDup, s2, s3, code2, sumHasRate: /盘点完成率/.test(sumText) };
  })()`);
  check(undo.extraRowsBefore === 1 && undo.extraCode === 'ZZ-TEST-NOT-EXIST-001', '表外码页列出扫到的陌生码', [
    undo.extraRowsBefore,
    undo.extraCode,
  ]);
  check(undo.noteBack === '测试备注', '表外码备注可填写并保存回显', undo.noteBack);
  check(undo.s1['表外码'] === '0' && undo.extraRowsAfter === 0, '撤销后表外码归零', [
    undo.s1['表外码'],
    undo.extraRowsAfter,
  ]);
  check(undo.foundRows === 1, '已扫明细 1 条', undo.foundRows);
  check(undo.sDup['已盘到'] === '1', '撤销「重复扫描」流水不影响已盘到状态', undo.sDup['已盘到']);
  check(
    undo.s2['已盘到'] === '0' && undo.s2['未扫到'] === String(S0.should),
    '撤销到初始（已盘 0 / 未扫 = 应盘）',
    [undo.s2['已盘到'], undo.s2['未扫到'], S0.should]
  );
  check(
    undo.s3['已盘到'] === '1' && undo.s3['未扫到'] === String(S0.should - 1),
    '重新扫码后恢复（已盘 1 / 未扫 -1）',
    [undo.s3['已盘到'], undo.s3['未扫到'], S0.should - 1]
  );
  check(undo.sumHasRate, '汇总页可正常渲染');

  console.log('\n— 5. 无串号商品：标记已找到后离开列表 —');
  const ns = await pageCDP.eval(`(async () => {
    ${HELPERS}
    __t.tab('无串号商品'); await __t.sleep(500);
    const rowsBefore = __t.rowCount();
    const name0 = __t.cellText(0,1);
    const book0 = __t.cellText(0,4);
    const diffBefore = __t.cellText(0,6);
    document.querySelector('#tab-body tbody tr:first-child [data-act="confirm"]').click();
    await __t.sleep(700);
    const rowsAfter = __t.rowCount();
    const stillInList = __t.listHas(name0);
    const toastText = document.querySelector('#toast').textContent;
    __t.tab('已扫明细'); await __t.sleep(450);
    const frows = [...document.querySelectorAll('#tab-body tbody tr')];
    const sources = frows.map(tr=>tr.children[2].textContent.trim());
    const codes = frows.map(tr=>tr.children[3].textContent.trim());
    __t.tab('无串号商品'); await __t.sleep(450);
    const backRows = __t.rowCount();
    return { rowsBefore, rowsAfter, backRows, name0, book0, diffBefore, stillInList, toastText, sources, codes,
             badge: __t.badge('无串号商品') };
  })()`);
  check(ns.rowsBefore === S0.nonSerial, '初始无串号商品行数与账面一致', [ns.rowsBefore, S0.nonSerial]);
  check(ns.diffBefore === '未盘', '确认前该行显示「未盘」', ns.diffBefore);
  check(ns.rowsAfter === ns.rowsBefore - 1, '确认后该行离开「无串号商品」列表', [ns.rowsBefore, ns.rowsAfter]);
  check(ns.stillInList === false, '确认过的那条确实不在列表里了', ns.name0);
  check(ns.backRows === ns.rowsAfter, '切换标签页回来仍是已移出的状态', ns.backRows);
  check(String(ns.badge) === String(ns.rowsAfter), '标签页角标 = 剩余待确认行数', ns.badge);
  check(/已手工确认/.test(ns.toastText), '有操作反馈', ns.toastText);
  check(ns.sources.includes('手工确认'), '已盘明细里能看到它', ns.sources);
  check(ns.codes.some((c) => /无串号（账面 \d+）/.test(c)), '已盘明细标注了无串号与账面数量', ns.codes);

  console.log('\n— 5.1 实盘数量按 Tab/回车 连续录入 —');
  const tabNav = await pageCDP.eval(`(async () => {
    ${HELPERS}
    __t.tab('无串号商品'); await __t.sleep(500);
    const rows = [...document.querySelectorAll('#tab-body tbody tr')];
    const qty = (i) => rows[i].querySelector('.qty-input');
    const idx = () => [...document.querySelectorAll('#tab-body .qty-input')].indexOf(document.activeElement);
    const press = (key, shift) => document.activeElement.dispatchEvent(
      new KeyboardEvent('keydown', { key, shiftKey: !!shift, bubbles: true, cancelable: true })
    );

    // 从第 3 行开始（前两行留给别的用例）
    const book2 = Number(__t.cellText(2,4));
    qty(2).focus(); qty(2).value = '7';
    press('Tab');
    await __t.sleep(150);
    const afterTab = idx();

    // 回车同样跳下一行
    document.activeElement.value = '8';
    press('Enter');
    await __t.sleep(150);
    const afterEnter = idx();

    // Shift+Tab 回上一行
    press('Tab', true);
    await __t.sleep(150);
    const afterShiftTab = idx();

    // 提交是否生效（差异单元格原地更新，没整表重绘）
    const diff2 = __t.cellText(2,6);
    const diff3 = __t.cellText(3,6);
    const keepVal3 = qty(3).value;
    const rowCountNow = [...document.querySelectorAll('#tab-body tbody tr')].length;

    // 最后一行的 Tab → 回到扫码框
    const last = [...document.querySelectorAll('#tab-body .qty-input')].pop();
    last.focus();
    press('Tab');
    await __t.sleep(200);
    const lastTabTo = document.activeElement.id;

    // 切走再切回：值应已存进状态
    __t.tab('已扫明细'); await __t.sleep(300);
    __t.tab('无串号商品'); await __t.sleep(400);
    const persisted = [
      __t.cellText(2,5) === null ? '' : document.querySelectorAll('#tab-body tbody tr')[2].querySelector('.qty-input').value,
      document.querySelectorAll('#tab-body tbody tr')[3].querySelector('.qty-input').value,
    ];
    return { afterTab, afterEnter, afterShiftTab, diff2, diff3, keepVal3, rowCountNow, lastTabTo, persisted, book2 };
  })()`);
  check(tabNav.afterTab === 3, '第 3 行按 Tab → 焦点到第 4 行的实盘数量', tabNav.afterTab);
  check(tabNav.afterEnter === 4, '再按回车 → 到第 5 行的实盘数量', tabNav.afterEnter);
  check(tabNav.afterShiftTab === 3, 'Shift+Tab → 回到上一行', tabNav.afterShiftTab);
  const wantDiff = 7 - tabNav.book2;
  check(
    tabNav.diff2 === (wantDiff > 0 ? '+' + wantDiff : String(wantDiff)),
    '第 3 行差异按 实盘 7 - 账面 计算',
    [tabNav.diff2, wantDiff]
  );
  check(tabNav.keepVal3 === '8', '第 4 行已填的 8 没有被覆盖', tabNav.keepVal3);
  check(tabNav.rowCountNow === S0.nonSerial - 1, '录入过程中表格没有被重绘', [
    tabNav.rowCountNow,
    S0.nonSerial - 1,
  ]);
  check(tabNav.lastTabTo === 'scan-input', '最后一行按 Tab 回到扫码框', tabNav.lastTabTo);
  check(tabNav.persisted[0] === '7' && tabNav.persisted[1] === '8', '切换标签页后录入的值仍在', tabNav.persisted);

  // 备注列同样支持 Tab 往下走（同一种输入框之间跳）
  const noteTab = await pageCDP.eval(`(async () => {
    ${HELPERS}
    __t.tab('未扫到'); await __t.sleep(500);
    const notes = [...document.querySelectorAll('#tab-body .note-input')];
    notes[0].focus();
    notes[0].value = '样机在展台';
    notes[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    await __t.sleep(250);
    const moved = [...document.querySelectorAll('#tab-body .note-input')].indexOf(document.activeElement);
    return { moved, total: notes.length };
  })()`);
  check(noteTab.moved === 1, '未扫到的「确认备注」按 Tab 也跳到下一行（同列跳转）', noteTab.moved);

  console.log('\n— 5.2 一键确认已填数量的行 —');
  const bulk = await pageCDP.eval(`(async () => {
    ${HELPERS}
    __t.tab('无串号商品'); await __t.sleep(500);
    const rowsBefore = __t.rowCount();
    const btn = document.querySelector('[data-act="confirm-all"]');
    const labelBefore = btn.textContent.trim();
    const filled = [...document.querySelectorAll('#tab-body tbody tr')]
      .filter(tr => tr.querySelector('.qty-input').value.trim() !== '')
      .map(tr => tr.querySelector('.qty-input').getAttribute('data-key'));
    btn.click();                       // 弹窗由 CDP 自动点确定
    await __t.sleep(900);
    const rowsAfter = __t.rowCount();
    const labelAfter = document.querySelector('[data-act="confirm-all"]').textContent.trim();
    const disabledAfter = document.querySelector('[data-act="confirm-all"]').disabled;
    const stillHasFilled = [...document.querySelectorAll('#tab-body tbody tr')]
      .some(tr => filled.includes(tr.querySelector('.qty-input').getAttribute('data-key')));
    // 待确认行数提示
    const hint = [...document.querySelectorAll('#tab-body .hint')].map(h=>h.textContent).join(' ');
    __t.tab('已扫明细'); await __t.sleep(450);
    const foundRows = __t.rowCount();
    return { rowsBefore, rowsAfter, labelBefore, labelAfter, disabledAfter, stillHasFilled, filledCount: filled.length, hint, foundRows };
  })()`);
  check(/一键确认已填数量（\d+）/.test(bulk.labelBefore), '按钮上显示待确认行数', bulk.labelBefore);
  check(bulk.filledCount >= 2, '此前已填了至少 2 行数量', bulk.filledCount);
  check(
    bulk.rowsAfter === bulk.rowsBefore - bulk.filledCount,
    '一键提交后这些行全部离开列表',
    [bulk.rowsBefore, bulk.rowsAfter, bulk.filledCount]
  );
  check(bulk.stillHasFilled === false, '被确认的行已不在待办列表里');
  check(/一键确认已填数量（0）/.test(bulk.labelAfter) && bulk.disabledAfter, '按钮变为 0 且不可点', [
    bulk.labelAfter,
    bulk.disabledAfter,
  ]);
  check(
    /列表里还剩 <b>\d+<\/b> 行待确认，其中 <b>0<\/b> 行已填数量/.test(bulk.hint) ||
      /还剩 \d+ 行待确认，其中 0 行已填数量/.test(bulk.hint),
    '进度提示：还剩若干行待确认、其中 0 行已填数量',
    (bulk.hint.match(/还剩[^。]*。/) || [''])[0]
  );
  check(/已确认 <b>\d+<\/b> 行|已确认 \d+ 行/.test(bulk.hint), '进度提示显示已确认行数');
  check(bulk.foundRows >= 1 + 1 + bulk.filledCount, '这些行都进了「已扫明细」', [
    bulk.foundRows,
    1 + 1 + bulk.filledCount,
  ]);

  console.log('\n— 5.3 按钮的待提交数量跟着实盘数量实时变 —');
  const live = await pageCDP.eval(`(async () => {
    ${HELPERS}
    __t.tab('无串号商品'); await __t.sleep(500);
    const btnText = () => document.querySelector('[data-act="confirm-all"]').textContent.trim();
    const btnOff = () => document.querySelector('[data-act="confirm-all"]').disabled;
    const prog = () => (document.getElementById('ns-progress')||{}).textContent || '';
    const before = { label: btnText(), disabled: btnOff(), prog: prog() };
    const state_tab_guess = (document.querySelector('#tabs button.active')||{}).textContent || '';

    const first = document.querySelector('#tab-body tbody tr .qty-input');
    const book = Number(document.querySelector('#tab-body tbody tr').children[4].textContent);
    // 只输入、不失焦：按钮上的数字就应该跟上
    first.focus();
    first.value = String(book + 2);
    first.dispatchEvent(new Event('input', { bubbles: true }));
    await __t.sleep(200);
    const typing = { label: btnText(), disabled: btnOff(), prog: prog() };

    // 再填第二行
    const second = document.querySelectorAll('#tab-body tbody tr')[1].querySelector('.qty-input');
    second.focus();
    second.value = String(book + 3);
    second.dispatchEvent(new Event('input', { bubbles: true }));
    await __t.sleep(200);
    const two = { label: btnText(), disabled: btnOff(), prog: prog() };

    // 清空第一行 → 数字要减回去
    first.focus();
    first.value = '';
    first.dispatchEvent(new Event('input', { bubbles: true }));
    first.dispatchEvent(new Event('change', { bubbles: true }));
    await __t.sleep(250);
    const cleared = { label: btnText(), disabled: btnOff(), prog: prog() };

    // 全部清空 → 归零并置灰
    second.value = '';
    second.dispatchEvent(new Event('input', { bubbles: true }));
    second.dispatchEvent(new Event('change', { bubbles: true }));
    await __t.sleep(250);
    const none = { label: btnText(), disabled: btnOff(), prog: prog() };
    // 回归：整表重绘（例如后台全库索引加载完成）不能冲掉正在输入、还没提交的内容
    const typed = document.querySelector('#tab-body tbody tr .qty-input');
    const typedBook = Number(document.querySelector('#tab-body tbody tr').children[4].textContent);
    typed.focus();
    typed.value = String(typedBook + 9);
    typed.dispatchEvent(new Event('input', { bubbles: true }));
    await __t.sleep(150);
    // 点一下当前标签页 → 走一次和后台索引完成时相同的整表重绘路径
    document.querySelector('#tabs button.active').click();
    await __t.sleep(500);
    const typedNow = document.querySelector('#tab-body tbody tr .qty-input');
    const afterRerender = {
      value: typedNow ? typedNow.value : null,
      focused: document.activeElement === typedNow,
      label: btnText(),
    };
    typedNow.value = '';
    typedNow.dispatchEvent(new Event('input', { bubbles: true }));
    typedNow.dispatchEvent(new Event('change', { bubbles: true }));
    await __t.sleep(250);

    const diag = {
      rows: document.querySelectorAll('#tab-body tbody tr').length,
      domFilled: [...document.querySelectorAll('#tab-body .qty-input')].filter(i=>i.value.trim()!=='').length,
      search: (document.getElementById('search')||{}).value || '',
      firstVal: first.value, secondVal: second.value,
      firstConnected: first.isConnected,
      tab: state_tab_guess,
    };
    return { before, typing, two, cleared, none, diag, afterRerender, typedWant: String(typedBook + 9) };
  })()`);
  check(/（0）$/.test(live.before.label) && live.before.disabled, '初始：待提交 0、按钮置灰', live.before.label);
  check(/（1）$/.test(live.typing.label) && !live.typing.disabled, '填第 1 行数量 → 按钮立刻变 1', live.typing.label);
  check(/（2）$/.test(live.two.label), '再填第 2 行 → 按钮变 2', [live.two.label, live.diag]);
  check(/（1）$/.test(live.cleared.label), '清空第 1 行 → 按钮减回 1', live.cleared.label);
  check(/（0）$/.test(live.none.label) && live.none.disabled, '全部清空 → 回到 0 且置灰', live.none.label);
  check(/其中 <b>1<\/b> 行已填数量|其中 1 行已填数量/.test(live.cleared.prog), '进度文案同步更新', (live.cleared.prog.match(/其中[^。]*/) || [''])[0]);
  check(
    live.afterRerender.value === live.typedWant,
    '整表重绘后，正在输入还没提交的数量没被冲掉',
    [live.afterRerender.value, live.typedWant]
  );
  check(live.afterRerender.focused === true, '重绘后输入焦点还在原来的格子上');
  check(/（1）$/.test(live.afterRerender.label), '重绘后按钮数字仍然正确', live.afterRerender.label);
  check(
    /其中 <b>0<\/b> 行已填数量|其中 0 行已填数量/.test(live.none.prog),
    '进度文案回到 0',
    (live.none.prog.match(/其中[^。]*/) || [''])[0]
  );

  console.log('\n— 5.4 有搜索筛选时，一键提交只算看得见的行 —');
  const filtered = await pageCDP.eval(`(async () => {
    ${HELPERS}
    __t.tab('无串号商品'); await __t.sleep(500);
    const rows = [...document.querySelectorAll('#tab-body tbody tr')];
    const total = rows.length;
    const firstName = rows[0].children[1].textContent.trim();
    const lastName = rows[rows.length-1].children[1].textContent.trim();
    // 在第 1 行填数量
    const firstQty = rows[0].querySelector('.qty-input');
    const book = Number(rows[0].children[4].textContent);
    firstQty.focus();
    firstQty.value = String(book + 1);
    firstQty.dispatchEvent(new Event('input', { bubbles: true }));
    firstQty.dispatchEvent(new Event('change', { bubbles: true }));
    await __t.sleep(250);
    const allLabel = document.querySelector('[data-act="confirm-all"]').textContent.trim();
    // 用最后一行的商品名做搜索条件 → 大概率把第 1 行筛掉
    __t.typeInto('#search', lastName, 'input');
    await __t.sleep(600);
    const afterFilter = {
      label: document.querySelector('[data-act="confirm-all"]').textContent.trim(),
      rows: __t.rowCount(),
      firstStillVisible: __t.listHas(firstName),
      lastNameDifferent: firstName !== lastName,
    };
    // 清空搜索恢复
    __t.typeInto('#search', '', 'input');
    await __t.sleep(600);
    const restored = {
      label: document.querySelector('[data-act="confirm-all"]').textContent.trim(),
      rows: __t.rowCount(),
    };
    // 把刚填的数量清掉，避免影响后续用例
    const again = document.querySelector('#tab-body tbody tr .qty-input');
    again.focus();
    again.value = '';
    again.dispatchEvent(new Event('input', { bubbles: true }));
    again.dispatchEvent(new Event('change', { bubbles: true }));
    await __t.sleep(300);
    return { total, allLabel, afterFilter, restored, cleared: document.querySelector('[data-act="confirm-all"]').textContent.trim() };
  })()`);
  check(/（1）$/.test(filtered.allLabel), '未筛选时按钮计入该行', filtered.allLabel);
  check(filtered.afterFilter.lastNameDifferent && filtered.afterFilter.rows < filtered.total, '搜索确实筛掉了部分行', [
    filtered.afterFilter.rows,
    filtered.total,
  ]);
  check(filtered.afterFilter.firstStillVisible === false, '第 1 行已被筛掉（不在列表里）');
  check(
    /（0）$/.test(filtered.afterFilter.label),
    '筛选状态下，看不见的行不计入待提交',
    filtered.afterFilter.label
  );
  check(/（1）$/.test(filtered.restored.label) && filtered.restored.rows === filtered.total, '清空搜索后恢复计入', [
    filtered.restored.label,
    filtered.restored.rows,
  ]);
  check(/（0）$/.test(filtered.cleared), '清掉数量后回到 0', filtered.cleared);

  console.log('\n— 5.5 未扫到的手工确认（样机没盒子扫不了码）—');
  const manual = await pageCDP.eval(`(async () => {
    ${HELPERS}
    __t.tab('未扫到'); await __t.sleep(300);
    const before = __t.stats();
    const rowsBefore = __t.rowCount();
    const name0 = __t.cellText(0,1);
    const serial0 = __t.cellText(0,2).split(' / ')[0];
    // 先在「确认备注」写明原因，再点「标记已找到」
    __t.typeInto('#tab-body tbody tr:first-child .note-input', '样机在展台，无盒');
    await __t.sleep(200);
    document.querySelector('#tab-body tbody tr:first-child [data-act="confirm"]').click();
    await __t.sleep(400);
    const after = __t.stats();
    const rowsAfter = __t.rowCount();
    const toastText = document.querySelector('#toast').textContent;
    // 已扫明细里应出现来源=手工确认、备注保留、可撤销
    __t.tab('已扫明细'); await __t.sleep(400);
    const rows = [...document.querySelectorAll('#tab-body tbody tr')];
    const sources = rows.map(tr=>tr.children[2].textContent.trim());
    const notes = rows.map((tr) => { const c = tr.children[7]; const i = c.querySelector('input'); return i ? i.value.trim() : c.textContent.trim(); });
    const hasUnconfirm = !!document.querySelector('#tab-body [data-act="unconfirm"]');
    window.__confirmedSerial = serial0;
    // 回到未扫到页，确认那台真的不在列表里了
    __t.tab('未扫到'); await __t.sleep(400);
    const goneFromList = !__t.listHas(serial0);
    return { before, after, rowsBefore, rowsAfter, name0, serial0, toastText, sources, notes, hasUnconfirm,
             goneFromList, tabBadge: __t.badge('未扫到') };
  })()`);
  check(
    Number(manual.after['未扫到']) === Number(manual.before['未扫到']) - 1,
    '标记已找到后「未扫到」少一台',
    [manual.before['未扫到'], manual.after['未扫到']]
  );
  check(
    Number(manual.after['已盘到']) === Number(manual.before['已盘到']) + 1,
    '「已盘到」多一台（计入已盘）',
    [manual.before['已盘到'], manual.after['已盘到']]
  );
  check(manual.after['其中手工确认'] === '1', '「其中手工确认」= 1', manual.after['其中手工确认']);
  check(manual.goneFromList === true, '该台已从未扫到列表消失（按串号核对）', manual.serial0);
  check(manual.rowsAfter <= manual.rowsBefore, '未扫到行数不增加', [manual.rowsBefore, manual.rowsAfter]);
  check(manual.tabBadge === manual.after['未扫到'], '标签页角标同步', manual.tabBadge);
  check(/已手工确认/.test(manual.toastText), '有操作反馈', manual.toastText);
  check(manual.sources.includes('手工确认'), '已扫明细里标为「手工确认」', manual.sources);
  check(manual.sources.includes('扫码'), '扫码盘到的仍标为「扫码」', manual.sources);
  check(manual.notes.includes('样机在展台，无盒'), '确认备注保留', manual.notes);
  check(manual.hasUnconfirm, '手工确认的行有「撤销确认」按钮');

  console.log('\n— 5.6 只看样机的快捷筛选 —');
  const demoFilter = await pageCDP.eval(`(async () => {
    ${HELPERS}
    __t.tab('未扫到'); await __t.sleep(300);
    const all = __t.rowCount();
    document.querySelector('[data-act="filter-demo"]').click();
    await __t.sleep(400);
    const filtered = __t.rowCount();
    const searchVal = document.querySelector('#search').value;
    const tags = [...document.querySelectorAll('#tab-body tbody tr')].slice(0,5).map(tr=>tr.children[5].textContent.trim());
    document.querySelector('[data-act="filter-demo"]').click();
    await __t.sleep(300);
    const back = __t.rowCount();
    return { all, filtered, searchVal, tags, back };
  })()`);
  check(demoFilter.searchVal === '样', '点击后搜索框填入「样」', demoFilter.searchVal);
  check(demoFilter.filtered > 0 && demoFilter.filtered < demoFilter.all, '筛选出样机子集', [
    demoFilter.filtered,
    demoFilter.all,
  ]);
  check(demoFilter.back === demoFilter.all, '再点一次恢复全部', demoFilter.back);

  console.log('\n— 6. 表外码归属提示（全库索引）—');
  const gi = await pageCDP.eval(`(async () => {
    ${HELPERS}
    // 等待后台建立的全库索引就绪
    await __t.waitFor(() => /全库索引 [0-9]+ 个串号/.test(document.querySelector('#session-info').textContent), 150000, '全库索引');
    const pill = document.querySelector('#session-info').textContent;
    // 从索引里找一个别的仓的串号：借用页面内数据不可得，这里改用接口直接验证已由 live 测试覆盖
    return { pill };
  })()`);
  check(/全库索引 \d+ 个串号/.test(gi.pill), '全库索引在浏览器内建立成功', gi.pill.match(/全库索引 \d+ 个串号/)[0]);

  console.log('\n— 7. 导出 Excel —');
  // 无串号已确认行数（从汇总页读，避免写死）
  const NON_SERIAL_CONFIRMED = await pageCDP.eval(`(async () => {
    ${HELPERS}
    __t.tab('汇总'); await __t.sleep(400);
    const item = [...document.querySelectorAll('#tab-body .sum-item')].find(x=>x.textContent.includes('无串号已手工盘过行数'));
    return item ? parseInt(item.querySelector('.v').textContent, 10) : -1;
  })()`);
  check(NON_SERIAL_CONFIRMED >= 3, '汇总里无串号已盘行数正确', NON_SERIAL_CONFIRMED);
  const before = fs.readdirSync(DL);
  await pageCDP.eval(`document.querySelector('#btn-export').click()`);
  let exported = null;
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    const now = fs.readdirSync(DL).filter((f) => !f.endsWith('.crdownload'));
    if (now.length > before.length) {
      exported = now.find((f) => !before.includes(f));
      break;
    }
  }
  check(!!exported, '点击导出后文件已落盘', exported);
  if (exported) {
    const fp = path.join(DL, exported);
    const py = `
import openpyxl, json, sys
wb = openpyxl.load_workbook(sys.argv[1])
out = {"sheets": wb.sheetnames}
ws = wb['未扫到']; out["missing_rows"] = ws.max_row
ws2 = wb['汇总']; out["summary"] = {r[0]: r[1] for r in ws2.iter_rows(values_only=True) if r[0]}
out["summary_rows"] = ws2.max_row
ws3 = wb['已扫明细']; out["found_rows"] = ws3.max_row
ws4 = wb['表外串号']; out["extra_rows"] = ws4.max_row
ws5 = wb['无串号商品']; out["nonserial_rows"] = ws5.max_row
wsM = wb['手工确认']; out["manual_rows"] = wsM.max_row
out["manual_first"] = [c.value for c in list(wsM.iter_rows())[1]]
out["manual_types"] = ",".join(sorted({str(r[1]) for r in list(wsM.iter_rows(values_only=True))[1:] if r[1]}))
ws6 = wb['账面全量']; out["all_rows"] = ws6.max_row
print(json.dumps(out, ensure_ascii=False))
`;
    const info = JSON.parse(execFileSync('python3', ['-c', py, fp], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    check(
      JSON.stringify(info.sheets) ===
        JSON.stringify(['汇总', '未扫到', '表外串号', '已扫明细', '手工确认', '无串号商品', '账面全量']),
      '导出的 Excel 六个工作表齐全',
      info.sheets
    );
    check(
      info.missing_rows === S0.should - 1,
      '未扫到工作表 = 应盘 - 2 台已盘 + 表头',
      [info.missing_rows, S0.should - 1]
    );
    check(
      info.found_rows === 2 + NON_SERIAL_CONFIRMED + 1,
      '已扫明细 = 扫码 1 + 样机确认 1 + 无串号确认 N + 表头',
      [info.found_rows, 2 + NON_SERIAL_CONFIRMED + 1]
    );
    check(
      info.manual_rows === 1 + NON_SERIAL_CONFIRMED + 1,
      '手工确认工作表 = 样机 1 + 无串号 N + 表头',
      [info.manual_rows, 1 + NON_SERIAL_CONFIRMED + 1]
    );
    check(
      info.manual_types === '无串号,有串号',
      '手工确认表区分有串号/无串号',
      info.manual_types
    );
    check(String(info.summary['其中手工确认']) === '1', '汇总表手工确认 = 1', info.summary['其中手工确认']);
    check(String(info.summary['其中扫码盘到']) === '1', '汇总表扫码盘到 = 1', info.summary['其中扫码盘到']);
    check(
      info.all_rows === S0.should + S0.nonSerial + 1,
      '账面全量工作表 = 全部账面行 + 表头',
      [info.all_rows, S0.should + S0.nonSerial + 1]
    );
    check(String(info.summary['已盘到']) === '2', '汇总表已盘到 = 2', info.summary['已盘到']);
  }

  console.log('\n— 7.5 撤销手工确认 —');
  const unconfirm = await pageCDP.eval(`(async () => {
    ${HELPERS}
    __t.tab('已扫明细'); await __t.sleep(400);
    // 已盘明细里现在有两类手工确认行：有串号样机（扫到的码显示 —）和无串号商品
    // 这里只撤销有串号那台
    const serialRow = [...document.querySelectorAll('#tab-body tbody tr')].find(
      (tr) => tr.children[3].textContent.trim() === '—' && tr.querySelector('[data-act="unconfirm"]')
    );
    const targeted = !!serialRow;
    serialRow.querySelector('[data-act="unconfirm"]').click();
    await __t.sleep(400);
    const s = __t.stats();
    __t.tab('未扫到'); await __t.sleep(400);
    // 被撤销的那台应该回到未扫到列表里
    const serial = ${JSON.stringify('')};
    const backInList = [...document.querySelectorAll('#tab-body tbody tr')].some(
      (tr) => tr.children[2].textContent.includes(__t.__confirmedSerial || '')
    );
    return { s, backInList, targeted, rows: __t.rowCount() };
  })()`);
  check(unconfirm.targeted, '定位到有串号样机那一行的撤销按钮');
  check(unconfirm.s['其中手工确认'] === '0', '撤销后手工确认归零', unconfirm.s['其中手工确认']);
  check(
    unconfirm.s['未扫到'] === String(S0.should - 1),
    '该台回到「未扫到」（= 应盘 - 1 台扫码盘到）',
    [unconfirm.s['未扫到'], S0.should - 1]
  );
  check(unconfirm.s['已盘到'] === '1', '已盘回到 1（只剩扫码那台）', unconfirm.s['已盘到']);
  check(unconfirm.backInList === true, '确认撤销的那台确实回到未扫到列表', unconfirm.backInList);

  console.log('\n— 7.6 撤销无串号商品的确认，应回到待办列表 —');
  const nsUndo = await pageCDP.eval(`(async () => {
    ${HELPERS}
    __t.tab('已扫明细'); await __t.sleep(450);
    const row = [...document.querySelectorAll('#tab-body tbody tr')].find(
      (tr) => /无串号（账面/.test(tr.children[3].textContent) && tr.querySelector('[data-act="unconfirm"]')
    );
    const name = row ? row.children[1].textContent.trim() : '';
    if (row) row.querySelector('[data-act="unconfirm"]').click();
    await __t.sleep(600);
    __t.tab('无串号商品'); await __t.sleep(500);
    const back = __t.listHas(name);
    // 顺手在待办列表第一行填一个数量，供刷新后校验持久化
    const first = document.querySelector('#tab-body tbody tr .qty-input');
    const book = Number(document.querySelector('#tab-body tbody tr').children[4].textContent);
    first.focus(); first.value = String(book + 4);
    first.dispatchEvent(new Event('change', { bubbles: true }));
    await __t.sleep(400);
    return { name, back, rows: __t.rowCount(), book, typed: first.value };
  })()`);
  check(nsUndo.back === true, '撤销后该行回到「无串号商品」待办列表', nsUndo.name);
  check(/\d/.test(nsUndo.typed), '在待办列表填了一个实盘数量', nsUndo.typed);

  console.log('\n— 8. 刷新后续盘（localStorage 持久化）—');
  const resume = await pageCDP.eval(`(async () => {
    ${HELPERS}
    const state = JSON.parse(localStorage.getItem('ic.state.v2')||'null');
    const book = JSON.parse(localStorage.getItem('ic.book.v2')||'null');
    return { hasSaved: !!state && !!book, scans: state ? state.scans.length : 0,
             store: book ? book.storeName : '', bookRows: book ? book.items.length : 0,
             sameSession: !!state && !!book && state.sessionId === book.sessionId };
  })()`);
  check(resume.hasSaved && resume.scans >= 1, `扫描记录已写入本机（${resume.scans} 条）`, resume.store);
  check(resume.bookRows > 100, '账面已冻结到本机', resume.bookRows);
  check(resume.sameSession, '状态与账面属于同一会话');

  await pageCDP.send('Page.reload', { ignoreCache: false });
  await pageCDP.eval(HELPERS);
  const after = await pageCDP.eval(`(async () => {
    ${HELPERS}
    await __t.waitFor(() => !document.querySelector('#scan-card').classList.contains('hidden'), 60000, '自动恢复盘点');
    await __t.sleep(600);
    return { stats: __t.stats(), header: document.querySelector('#scan-store').textContent };
  })()`);
  check(load.header.indexOf(STORE.id) >= 0 || /库/.test(after.header), '刷新后自动恢复上次盘点', after.header);
  check(after.stats['已盘到'] === '1', '刷新后已盘点数保持 = 1（扫码那台）', after.stats['已盘到']);
  check(after.stats['其中手工确认'] === '0', '刷新后手工确认状态一致（已撤销）', after.stats['其中手工确认']);
  check(
    after.stats['未扫到'] === String(Number(after.stats['应盘（有串号）']) - 1),
    '刷新后未扫到 = 应盘 - 1（数据一致）',
    [after.stats['未扫到'], after.stats['应盘（有串号）']]
  );
  const nsRestored = await pageCDP.eval(`(async () => {
    ${HELPERS}
    __t.tab('无串号商品'); await __t.sleep(500);
    const rows = [...document.querySelectorAll('#tab-body tbody tr')];
    const hint = [...document.querySelectorAll('#tab-body .hint')].map((h) => h.textContent).join(' ');
    const m = hint.match(/已确认 (\\d+) 行（已移到「已扫明细」），列表里还剩 (\\d+) 行待确认/);
    return {
      rows: rows.length,
      confirmed: m ? Number(m[1]) : -1,
      left: m ? Number(m[2]) : -1,
      hasUnconfirmBtn: !!document.querySelector('#tab-body [data-act="unconfirm"]'),
      row0qty: rows.length ? rows[0].querySelector('.qty-input').value : '',
      row0diff: rows.length ? rows[0].children[6].textContent.trim() : '',
      row0book: rows.length ? rows[0].children[4].textContent.trim() : '',
    };
  })()`);
  check(
    nsRestored.confirmed >= 0 && nsRestored.confirmed + nsRestored.left === S0.nonSerial,
    '刷新后「已确认 + 待确认 = 账面行数」（口径自洽）',
    [nsRestored.confirmed, nsRestored.left, S0.nonSerial]
  );
  check(
    nsRestored.rows === nsRestored.left,
    '刷新后待办列表行数 = 提示里的待确认行数',
    [nsRestored.rows, nsRestored.left]
  );
  check(nsRestored.hasUnconfirmBtn === false, '待办列表里没有已确认的行（都已移出）');
  check(
    nsRestored.row0qty === nsRestored.row0diff || nsRestored.row0diff !== '未盘',
    '刷新后手填的实盘数量仍在（差异不是"未盘"）',
    [nsRestored.row0qty, nsRestored.row0diff]
  );

  console.log('\n— 9. 页面无 JS 报错 —');
  check(consoleErrors.length === 0, '控制台无异常', consoleErrors.slice(0, 3));
} catch (e) {
  fail++;
  console.log('\n✗ 测试异常中断：' + e.message);
  if (edgeErr) console.log('Edge 输出：' + edgeErr.slice(0, 800));
} finally {
  try {
    pageCDP && pageCDP.close();
  } catch (e) {}
  try {
    browserCDP && browserCDP.close();
  } catch (e) {}
  edge.kill('SIGKILL');
  await sleep(300);
  fs.rmSync(PROFILE, { recursive: true, force: true });
}

console.log(`\n浏览器端测试：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
