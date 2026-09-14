/* 首次使用不得使用他人身份：全新浏览器（无任何本地配置）打开成品，必须
 *   1) 一个业务请求都不发（不碰 yserp.cc）
 *   2) 展示登录引导，而不是静默用内置凭证
 *   3) 不配置就点「开始拉取库存」也不发请求
 * 全程离线可跑（测试本身就是断言"没有网络请求"）。
 * 用法：node test/no-credentials.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = path.join(root, '库存盘点.html');
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
let PORT = 9860 + Math.floor(Math.random() * 100); // 先给个候选，真正的端口由浏览器自己选（见 DevToolsActivePort）
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-nocred-'));
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
      }, 60000);
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
    '--window-size=1280,900',
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
  await cdp.send('Page.navigate', { url: 'file://' + encodeURI(HTML) });
  await sleep(4000);

  console.log('— 全新浏览器（无本地配置）打开成品 —');
  check(cdp.requests.filter((u) => /yserp\.cc/.test(u)).length === 0, '没有向 ERP 发任何请求', cdp.requests.filter((u) => /yserp\.cc/.test(u)));
  check(
    (await cdp.eval(`document.querySelectorAll('#store option').length`)) === 0,
    '仓库下拉为空（没有偷偷加载别人的数据）'
  );
  const status = await cdp.eval(`(document.querySelector('#login-status')||{}).textContent || ''`);
  check(/首次使用/.test(status), '展示首次使用登录引导', status);
  check(await cdp.eval(`!document.querySelector('#setup').classList.contains('hidden')`), '设置区已展开');
  check(await cdp.eval(`document.querySelector('.adv').open === true`), '账号密码登录区自动展开');
  const cfg = await cdp.eval(`localStorage.getItem('ic.cfg.v2')`);
  check(cfg === null, '本机没有写入任何身份配置', cfg);
  check(
    await cdp.eval(`document.querySelector('#cfg-account').value === '' && document.querySelector('#cfg-token').value === ''`),
    '账号和 token 输入框都是空的'
  );
  check(
    (await cdp.eval(`document.querySelector('#opt-remember').checked`)) === false,
    '「记住密码」默认不勾选（默认只保存 token）'
  );
  check(
    (await cdp.eval(`document.querySelector('#cfg-password').type`)) === 'password',
    '密码框是密码类型'
  );
  check(
    /不含任何内置账号或凭证|首次使用/.test(await cdp.eval(`document.querySelector('#setup').textContent`)),
    '设置区写明了「不含内置凭证」'
  );

  console.log('\n— 配置不全时点「开始拉取库存」也不发请求 —');
  const before = cdp.requests.length;
  await cdp.eval(`document.querySelector('#btn-start').click()`);
  await sleep(1500);
  const newReqs = cdp.requests.slice(before);
  check(newReqs.filter((u) => /yserp\.cc/.test(u)).length === 0, '仍然没有发请求', newReqs);
  const toast = await cdp.eval(`(document.querySelector('#toast')||{}).textContent || ''`);
  check(/登录|仓库/.test(toast), '给出可执行的提示', toast);
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
console.log(`\n首次使用身份检查：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
