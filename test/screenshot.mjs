/* 截图脚本：把界面各状态截成 PNG，便于人工快速检查
 * 用法：node test/screenshot.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { seedScript, skipIfNoCreds } from './browser-env.mjs';

if (skipIfNoCreds('截图')) process.exit(0);

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '..');
const HTML = path.join(root, '库存盘点.html');
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
let PORT = 9600 + Math.floor(Math.random() * 200); // 先给个候选，真正的端口由浏览器自己选（见 DevToolsActivePort）
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-shot-'));
const OUT = path.join(root, 'test/tmp/shots');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.waiting = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
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
          rej(new Error('CDP 超时 ' + method));
        }
      }, 120000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
    return r.result.value;
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
    console.log('  · ' + name + '.png');
  }
}

const url = 'file://' + encodeURI(HTML);
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
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--window-size=1440,1200',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

const HELPERS = `
  window.__t = {
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
    waitFor: async (fn, timeout=60000, label='') => {
      const t0=Date.now();
      for(;;){ let v=false; try{v=fn();}catch(e){}
        if(v) return v;
        if(Date.now()-t0>timeout) throw new Error('等待超时 '+label);
        await new Promise(r=>setTimeout(r,150)); }
    },
    scan: (code) => { const el=document.querySelector('#scan-input'); el.focus(); el.value=code;
      el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); },
    tab: (n) => { [...document.querySelectorAll('#tabs button')].find(x=>x.textContent.includes(n)).click(); },
    typeInto: (sel,val,ev='change') => { const el=document.querySelector(sel); el.value=val; el.dispatchEvent(new Event(ev,{bubbles:true})); },
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
  let version = null;
  for (let i = 0; i < 60; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      break;
    } catch (e) {
      await sleep(250);
    }
  }
  if (!version) throw new Error('Edge 未就绪');
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
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: seedScript() });
  await cdp.send('Page.navigate', { url: url });
  await sleep(900);

  console.log('截图输出：' + OUT);
  await cdp.eval(HELPERS);
  await cdp.eval(`__t.waitFor(()=>document.querySelectorAll('#store option').length>5, 40000, '仓库')`);
  await cdp.eval(`document.querySelector('#date').value='2026-09-14'; document.querySelector('#store').selectedIndex=1;`);
  await cdp.eval(`__t.sleep(200)`);
  await cdp.shot('1-设置页');

  await cdp.eval(`document.querySelector('#btn-start').click()`);
  await cdp.eval(`__t.waitFor(()=>!document.querySelector('#scan-card').classList.contains('hidden') && document.querySelectorAll('#stats .stat').length===6, 60000,'库存')`);
  await cdp.eval(`__t.sleep(400)`);
  await cdp.shot('2-扫码台-初始');

  // 扫 12 台真实机器 + 1 个别仓码 + 1 个陌生码 + 1 个重复
  const codes = await cdp.eval(`(async () => {
    __t.tab('未扫到'); await __t.sleep(300);
    const out=[];
    document.querySelectorAll('#tab-body tbody tr').forEach((tr,i)=>{ if(i<12){ const c=tr.children[2].textContent.trim().split(' / ')[0]; out.push(c);} });
    return out;
  })()`);
  for (const c of codes) {
    await cdp.eval(`__t.scan(${JSON.stringify(c)})`);
    await sleep(60);
  }
  await cdp.eval(`__t.sleep(500); __t.scan(${JSON.stringify(codes[2])})`); // 重复
  await sleep(200);
  await cdp.eval(`__t.sleep(500); __t.scan('354325371007231')`); // 别仓码
  await sleep(300);
  await cdp.eval(`__t.sleep(500); __t.scan('999888777666555')`); // 陌生码
  await cdp.eval(`__t.sleep(600)`);
  await cdp.shot('3-扫码台-扫描中');

  // 表外码页 + 备注
  await cdp.eval(`__t.tab('表外码'); __t.sleep(200); __t.typeInto('#tab-body tbody tr:first-child .note-input','疑似调拨未入账')`);
  await cdp.eval(`__t.sleep(400)`);
  await cdp.shot('4-表外码');

  // 无串号商品页
  await cdp.eval(`__t.tab('无串号商品'); __t.sleep(200)`);
  await cdp.eval(`(()=>{const rows=[...document.querySelectorAll('#tab-body tbody tr')];const set=(i,v)=>{const el=rows[i].querySelector('.qty-input');el.value=v;el.dispatchEvent(new Event('change',{bubbles:true}));};const books=[5,1,2];rows.slice(0,3).forEach((r,i)=>{const b=Number(r.children[4].textContent.trim());set(i,String(b-1>=0?b-1:0));});})()`);
  await cdp.eval(`__t.sleep(500)`);
  await cdp.shot('5-无串号商品');

  // 未扫到页
  await cdp.eval(`__t.tab('未扫到'); __t.sleep(400)`);
  await cdp.shot('6-未扫到');

  // 汇总
  await cdp.eval(`__t.tab('汇总'); __t.sleep(400)`);
  await cdp.shot('7-汇总');

  console.log('完成');
} catch (e) {
  console.log('截图失败：' + e.message);
} finally {
  try {
    cdp && cdp.ws.close();
  } catch (e) {}
  edge.kill('SIGKILL');
  await sleep(300);
  fs.rmSync(PROFILE, { recursive: true, force: true });
}
