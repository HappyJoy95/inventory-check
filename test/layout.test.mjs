/* 布局审计：在真实浏览器里量取关键元素几何与样式，代替肉眼看图
 * 用法：node test/layout.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { seedScript, skipIfNoCreds } from './browser-env.mjs';

if (skipIfNoCreds('布局审计（需要真实库存数据）')) process.exit(0);

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '..');
const HTML = path.join(root, '库存盘点.html');
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
let PORT = 9800 + Math.floor(Math.random() * 150); // 先给个候选，真正的端口由浏览器自己选（见 DevToolsActivePort）
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-layout-'));
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
  for (let i = 0; i < 60; i++) {
    try {
      v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      break;
    } catch (e) {
      await sleep(250);
    }
  }
  let target = null;
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
    if (target) break;
    await sleep(250);
  }
  cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: seedScript() });
  await cdp.send('Page.navigate', { url: 'file://' + encodeURI(HTML) });
  await sleep(900);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });

  await cdp.eval('window.__w = (ms)=>new Promise(r=>setTimeout(r,ms))');
  await cdp.eval(
    `(async()=>{const t0=Date.now();while(document.querySelectorAll('#store option').length<=5){if(Date.now()-t0>40000)throw new Error('仓库超时');await __w(200);}document.querySelector('#date').value='2026-09-14';document.querySelector('#store').selectedIndex=1;document.querySelector('#btn-start').click();const t1=Date.now();while(document.querySelector('#scan-card').classList.contains('hidden')){const st=(document.querySelector('#login-status')||{}).textContent||'';if(/登录已过期|还没有登录/.test(st))throw new Error('凭证未生效：'+st);if(Date.now()-t1>60000)throw new Error('库存超时');await __w(200);}await __w(600);return 1;})()`
  );

  console.log('— 设置页布局 —');
  const setup = await cdp.eval(`(() => {
    const g = (s) => { const e=document.querySelector(s); if(!e) return null; const r=e.getBoundingClientRect(); const c=getComputedStyle(e);
      return {w:Math.round(r.width),h:Math.round(r.height),x:Math.round(r.left),y:Math.round(r.top),display:c.display,vis:c.visibility,color:c.color,bg:c.backgroundColor,fs:c.fontSize,border:c.borderColor,bw:c.borderWidth}; };
    return {
      docW: document.documentElement.scrollWidth,
      winW: window.innerWidth,
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      wideEls: [...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect(); return r.right > window.innerWidth + 1 && r.width>0;}).slice(0,5).map(e=>e.tagName+'.'+e.className+' right='+Math.round(e.getBoundingClientRect().right)),
      scanInput: g('#scan-input'),
      feedback: g('#feedback'),
      stats: g('#stats'),
      tabs: g('#tabs'),
      tableWrap: g('.table-wrap'),
      exportBtn: g('#btn-export'),
      statCount: document.querySelectorAll('#stats .stat').length,
      firstStat: (()=>{const e=document.querySelector('#stats .stat .v'); return e?{text:e.textContent,fs:getComputedStyle(e).fontSize}:null;})(),
      tabCount: document.querySelectorAll('#tabs button').length,
    };
  })()`);
  check(!setup.overflow, '页面没有横向溢出', { docW: setup.docW, winW: setup.winW });
  check(setup.wideEls.length === 0, '没有元素超出视口右边界', setup.wideEls);
  check(setup.scanInput && setup.scanInput.h >= 50, '扫码输入框足够大（≥50px 高）', setup.scanInput && setup.scanInput.h);
  check(
    setup.scanInput && setup.scanInput.border === 'rgb(31, 111, 235)' && parseFloat(setup.scanInput.fs) >= 24,
    '扫码框高亮边框与大字已生效',
    setup.scanInput && { border: setup.scanInput.border, fs: setup.scanInput.fs }
  );
  check(setup.feedback && setup.feedback.h >= 60, '结果提示条高度正常', setup.feedback && setup.feedback.h);
  check(setup.statCount === 6, '统计卡片 6 个', setup.statCount);
  check(setup.firstStat && parseFloat(setup.firstStat.fs) >= 20, '统计数字字号够大（≥20px）', setup.firstStat && setup.firstStat.fs);
  check(setup.tabCount === 5, '结果标签页 5 个', setup.tabCount);
  check(setup.tableWrap && setup.tableWrap.w > 800, '结果表格宽度正常', setup.tableWrap && setup.tableWrap.w);

  console.log('\n— 登录区（展开设置）—');
  const loginBox = await cdp.eval(`(async () => {
    const d = document.querySelector('.adv'); d.open = true;
    document.querySelector('#setup').classList.remove('hidden');
    await __w(400);
    const g = (s) => { const e=document.querySelector(s); if(!e) return null; const r=e.getBoundingClientRect();
      const c=getComputedStyle(e); return {w:Math.round(r.width),h:Math.round(r.height),right:Math.round(r.right),vis:c.visibility,display:c.display}; };
    return {
      box: g('.login-box'), account: g('#cfg-account'), pwd: g('#cfg-password'), btn: g('#btn-login'),
      remember: g('#opt-remember'), forget: g('#btn-forget'), status: g('#login-status'),
      pwdType: document.querySelector('#cfg-password').type,
      pwdAutocomplete: document.querySelector('#cfg-password').getAttribute('autocomplete'),
      captchaHidden: document.querySelector('#captcha-row').classList.contains('hidden'),
      overflowRight: [...document.querySelectorAll('#setup *')].filter(e=>{const r=e.getBoundingClientRect(); return r.right > window.innerWidth+1 && r.width>0;}).length,
      winW: window.innerWidth,
    };
  })()`);
  check(!!loginBox.box && loginBox.box.w > 600, '登录区已渲染', loginBox.box && loginBox.box.w);
  check(!!loginBox.account && !!loginBox.pwd && !!loginBox.btn, '账号 / 密码 / 登录按钮齐全');
  check(loginBox.pwdType === 'password', '密码框是密码类型（不明文显示）', loginBox.pwdType);
  check(loginBox.pwdAutocomplete === 'current-password', '密码框声明了 autocomplete', loginBox.pwdAutocomplete);
  check(!!loginBox.remember && !!loginBox.forget, '记住密码开关与清除按钮都在');
  check(loginBox.captchaHidden, '默认不显示验证码行');
  check(loginBox.overflowRight === 0, '展开设置后仍无横向溢出', { winW: loginBox.winW });

  console.log('\n— 反馈条四种状态配色 —');
  const colors = await cdp.eval(`(async () => {
    const el = document.querySelector('#scan-input');
    const scan = async (code) => { el.focus(); el.value=code; el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); await __w(250);
      const f=document.querySelector('#feedback'); const c=getComputedStyle(f); const m=f.querySelector('.fb-main'); 
      return { cls:f.className, bg:c.backgroundColor, main:m?m.textContent:'', color:m?getComputedStyle(m).color:'' }; };
    const codes = [...document.querySelectorAll('#tab-body tbody tr')].slice(0,2).map(tr=>tr.children[2].textContent.trim().split(' / ')[0]);
    const ok = await scan(codes[0]);
    await __w(500);
    const dup = await scan(codes[0]);
    await __w(500);
    const unknown = await scan('ZZ-000-NOT-FOUND');
    return { ok, dup, unknown, codes };
  })()`);
  check(colors.ok.cls.includes('ok') && colors.ok.main === '已盘到', '已盘到 = 绿色系', { cls: colors.ok.cls, bg: colors.ok.bg });
  check(colors.dup.cls.includes('dup') && colors.dup.main === '重复扫描', '重复 = 黄色系', { cls: colors.dup.cls, bg: colors.dup.bg });
  check(colors.unknown.cls.includes('unknown') && colors.unknown.main === '查无此码', '异常 = 红色系', {
    cls: colors.unknown.cls,
    bg: colors.unknown.bg,
  });
  check(new Set([colors.ok.bg, colors.dup.bg, colors.unknown.bg]).size === 3, '三种状态背景色互不相同');

  console.log('\n— 各标签页渲染 —');
  const tabs = await cdp.eval(`(async () => {
    const out = {};
    for (const name of ['未扫到','表外码','已扫明细','无串号商品','汇总']) {
      const btn=[...document.querySelectorAll('#tabs button')].find(x=>x.textContent.includes(name));
      btn.click(); await __w(400);
      const body=document.querySelector('#tab-body');
      const tb=body.querySelector('table');
      const err=body.querySelector('.empty');
      out[name]={ rows: body.querySelectorAll('tbody tr').length, hasTable: !!tb, empty: !!err,
        h: Math.round(body.getBoundingClientRect().height), text: body.textContent.replace(/\\s+/g,' ').slice(0,400) };
    }
    return out;
  })()`);
  check(tabs['未扫到'].hasTable && tabs['未扫到'].rows > 0, '未扫到页有数据表', tabs['未扫到'].rows);
  check(tabs['表外码'].hasTable && tabs['表外码'].rows === 1, '表外码页列出 1 条', tabs['表外码'].rows);
  check(tabs['已扫明细'].rows === 1, '已扫明细 1 条', tabs['已扫明细'].rows);
  const nsRowsStat = await cdp.eval(
    `[...document.querySelectorAll('#stats .stat')].find(x=>x.textContent.includes('无串号商品')).querySelector('.v').textContent`
  );
  check(
    tabs['无串号商品'].hasTable && String(tabs['无串号商品'].rows) === String(nsRowsStat),
    '无串号商品行数与统计卡片一致',
    [tabs['无串号商品'].rows, nsRowsStat]
  );
  check(/盘点完成率/.test(tabs['汇总'].text), '汇总页渲染统计');
  check(Object.values(tabs).every((t) => t.h > 100), '各页高度正常（无塌陷）', Object.fromEntries(Object.entries(tabs).map(([k, v]) => [k, v.h])));

  console.log('\n— 未扫到页的手工确认控件 —');
  const manualUI = await cdp.eval(`(async () => {
    const btn = [...document.querySelectorAll('#tabs button')].find(x=>x.textContent.includes('未扫到'));
    btn.click(); await __w(500);
    const tr = document.querySelector('#tab-body tbody tr');
    const cells = tr ? [...tr.children] : [];
    const confirmBtn = tr ? tr.querySelector('[data-act="confirm"]') : null;
    const noteInput = tr ? tr.querySelector('.note-input') : null;
    const r = confirmBtn ? confirmBtn.getBoundingClientRect() : null;
    const nr = noteInput ? noteInput.getBoundingClientRect() : null;
    return {
      cellCount: cells.length,
      headers: [...document.querySelectorAll('#tab-body thead th')].map(th=>th.textContent.trim()),
      btnText: confirmBtn ? confirmBtn.textContent.trim() : '',
      btnSize: r ? [Math.round(r.width), Math.round(r.height)] : null,
      btnVisible: !!(r && r.width > 40 && r.height > 18),
      noteW: nr ? Math.round(nr.width) : 0,
      notePlaceholder: noteInput ? noteInput.placeholder : '',
      tableW: Math.round(document.querySelector('#tab-body table').getBoundingClientRect().width),
      wrapW: Math.round(document.querySelector('#tab-body .table-wrap').getBoundingClientRect().width),
      hint: (document.querySelector('#tab-body .hint')||{}).textContent || '',
      docOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  })()`);
  check(manualUI.headers.includes('确认备注') && manualUI.headers.includes('操作'), '未扫到表新增「确认备注 / 操作」列', manualUI.headers);
  check(manualUI.btnText === '✓ 标记已找到', '行内有「标记已找到」按钮', manualUI.btnText);
  check(manualUI.btnVisible, '按钮可点击尺寸正常', manualUI.btnSize);
  check(manualUI.noteW > 60, '备注输入框宽度正常', manualUI.noteW);
  check(/样机/.test(manualUI.notePlaceholder), '备注框有样机场景的占位提示', manualUI.notePlaceholder);
  check(!manualUI.docOverflow, '加列后页面仍无横向溢出', { tableW: manualUI.tableW, wrapW: manualUI.wrapW });
  check(/手工确认|标记已找到/.test(manualUI.hint), '页面有手工确认用法提示');

  console.log('\n— 无串号商品页的「标记已找到」—');
  const nsUI = await cdp.eval(`(async () => {
    const btn=[...document.querySelectorAll('#tabs button')].find(x=>x.textContent.includes('无串号商品'));
    btn.click(); await __w(500);
    const tr = document.querySelector('#tab-body tbody tr');
    const confirmBtn = tr.querySelector('[data-act="confirm"]');
    const r = confirmBtn.getBoundingClientRect();
    const headers = [...document.querySelectorAll('#tab-body thead th')].map(th=>th.textContent.trim());
    return {
      headers,
      btnText: confirmBtn.textContent.trim(),
      btnW: Math.round(r.width), btnH: Math.round(r.height),
      hasQty: !!tr.querySelector('.qty-input'),
      hasNote: !!tr.querySelector('.note-input'),
      hint: (document.querySelector('#tab-body .hint')||{}).textContent || '',
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  })()`);
  check(nsUI.headers.includes('操作') && nsUI.headers.includes('实盘数量'), '无串号商品表有实盘数量与操作列', nsUI.headers);
  check(nsUI.btnText === '✓ 标记已找到', '有「标记已找到」按钮', nsUI.btnText);
  check(nsUI.btnW > 40 && nsUI.btnH > 18, '按钮尺寸可点击', [nsUI.btnW, nsUI.btnH]);
  check(nsUI.hasQty && nsUI.hasNote, '实盘数量与备注仍可编辑');
  check(/标记已找到|实盘数量/.test(nsUI.hint), '页面有用法提示');
  check(!nsUI.overflow, '无串号页无横向溢出');

  console.log('\n— 窄屏（笔记本一半宽 1024）—');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  const narrow = await cdp.eval(`(() => ({
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    docW: document.documentElement.scrollWidth,
    gridCols: getComputedStyle(document.querySelector('.scan-grid')).gridTemplateColumns,
  }))()`);
  check(!narrow.overflow, '1024 宽下无横向溢出', { docW: narrow.docW });

  console.log('\n— 手机宽度 430 —');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 1, mobile: true });
  await sleep(400);
  const mob = await cdp.eval(`(() => ({
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    docW: document.documentElement.scrollWidth,
    gridCols: getComputedStyle(document.querySelector('.scan-grid')).gridTemplateColumns,
    scanH: Math.round(document.querySelector('#scan-input').getBoundingClientRect().height),
  }))()`);
  check(!mob.overflow, '手机宽度下无横向溢出', { docW: mob.docW });
  check(mob.gridCols.split(' ').length === 1, '窄屏下扫码区改为单列', mob.gridCols);

  console.log(`\n布局审计：通过 ${pass}，失败 ${fail}`);
} catch (e) {
  fail++;
  console.log('✗ 中断：' + e.message);
} finally {
  try {
    cdp && cdp.ws.close();
  } catch (e) {}
  edge.kill('SIGKILL');
  await sleep(200);
  fs.rmSync(PROFILE, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
