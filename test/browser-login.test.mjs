/* 登录与自动续期 浏览器端测试：node test/browser-login.test.mjs
 * 用 Edge(headless) + CDP 驱动成品页面。
 * 真实登录接口无法用真实账号跑（没有密码），所以：
 *   - 真实接口契约由 test/login.test.mjs 覆盖
 *   - 这里覆盖界面接线：token 失效 → 自动用保存的账号密码重登 → 重试成功
 *     登录成功后 token 落盘、验证码界面、记住密码开关、无凭据时的提示
 * 手法：用 Page.addScriptToEvaluateOnNewDocument 在页面脚本之前替换 IC.erp.login
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { seedScript, CREDS, skipIfNoCreds } from './browser-env.mjs';

if (skipIfNoCreds('登录与自动续期（浏览器）')) process.exit(0);

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '..');
const HTML = path.join(root, '库存盘点.html');
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
let PORT = 9700 + Math.floor(Math.random() * 150); // 先给个候选，真正的端口由浏览器自己选（见 DevToolsActivePort）
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-login-'));
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
    waitFor: async (fn, timeout=60000, label='') => {
      const t0=Date.now();
      for(;;){ let v=false; try{v=fn();}catch(e){}
        if(v) return v;
        if(Date.now()-t0>timeout) throw new Error('等待超时 '+label);
        await new Promise(r=>setTimeout(r,150)); }
    },
    status: () => (document.querySelector('#login-status')||{}).textContent || '',
    tokenField: () => (document.querySelector('#cfg-token')||{}).value || '',
    cfg: () => JSON.parse(localStorage.getItem('ic.cfg.v2')||'{}'),
    setInput: (sel,v) => { const el=document.querySelector(sel); el.value=v; el.dispatchEvent(new Event('change',{bubbles:true})); },
    captchaVisible: () => !document.querySelector('#captcha-row').classList.contains('hidden'),
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
  await cdp.send('Page.enable'); // 必须先 enable，注入脚本才生效
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: seedScript() });
  await cdp.send('Page.navigate', { url: 'file://' + encodeURI(HTML) });
  await sleep(900);
  await cdp.eval(HELPERS);

  // 首次加载：等默认 token 生效，拿到真实 token 备用
  const first = await cdp.eval(`(async () => {
    await __t.waitFor(()=>document.querySelectorAll('#store option').length>5, 45000, '首次加载');
    return { token: __t.tokenField(), status: __t.status() };
  })()`);
  const realToken = first.token;
  check(!!realToken && realToken.length > 10, '默认 token 可用（首次加载成功）', realToken.slice(0, 8) + '…');

  console.log('\n— 1. token 失效 + 已保存账号密码 → 自动重登并重试 —');
  // 在页面脚本执行前装好 login 桩：返回真实 token（模拟登录成功）
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      document.addEventListener('DOMContentLoaded', () => {
        window.__loginCalls = [];
        if (window.IC && IC.erp) {
          IC.erp.login = async (cfg, cred) => {
            window.__loginCalls.push({ userName: cred.userName, userPwd: cred.userPwd, VCode: cred.VCode || '' });
            const real = localStorage.getItem('__test_real_token') || 'STUB-TOKEN';
            return { token: real, data: {} };
          };
        }
      });
    `,
  });
  await cdp.eval(`(() => {
    localStorage.setItem('__test_real_token', ${JSON.stringify(realToken)});
    localStorage.setItem('ic.cfg.v2', JSON.stringify({
      token: 'BAD-TOKEN-FOR-TEST',
      companycode: ${JSON.stringify(CREDS.companycode)},
      username: ${JSON.stringify(CREDS.username)},
      account: 'tester01',
      password: 'pw-for-test',
      rememberPwd: true,
      sound: false,
      loadGlobalIndex: false
    }));
    localStorage.removeItem('ic.state.v2');
    localStorage.removeItem('ic.book.v2');
    return true;
  })()`);
  await cdp.send('Page.reload', {});
  await cdp.eval(HELPERS);
  const auto = await cdp.eval(`(async () => {
    await __t.waitFor(()=>document.querySelectorAll('#store option').length>5, 60000, '自动重登后加载仓库');
    await __t.sleep(400);
    return { calls: window.__loginCalls || [], token: __t.tokenField(), cfg: __t.cfg(), status: __t.status(), opts: document.querySelectorAll('#store option').length-1 };
  })()`);
  check(auto.calls.length === 1, 'token 失效后自动发起了一次登录', auto.calls.length);
  check(auto.calls[0] && auto.calls[0].userName === 'tester01', '登录用的是保存的账号', auto.calls[0] && auto.calls[0].userName);
  check(auto.calls[0] && auto.calls[0].userPwd === 'pw-for-test', '登录用的是保存的密码（自动续期无需重新输入）');
  check(auto.opts >= 40, '重登成功后重试拉取仓库成功', auto.opts);
  check(auto.token === realToken, '新 token 已回填到 token 输入框');
  check(auto.cfg.token === realToken, '新 token 已写入本机存储');
  check(/登录成功/.test(auto.status), '界面提示登录成功', auto.status);

  console.log('\n— 2. 记住密码开关 —');
  const remember = await cdp.eval(`(async () => {
    const el = document.querySelector('#opt-remember');
    el.checked = false; el.dispatchEvent(new Event('change',{bubbles:true}));
    await __t.sleep(200);
    const off = __t.cfg();
    el.checked = true; el.dispatchEvent(new Event('change',{bubbles:true}));
    await __t.sleep(200);
    const on = __t.cfg();
    return { off, on };
  })()`);
  check(remember.off.password === undefined, '取消勾选后密码不再写入本机', remember.off.password);
  check(remember.on.password === 'pw-for-test', '重新勾选后密码写回本机', String(remember.on.password).slice(0, 3) + '***');

  console.log('\n— 3. 清除已保存密码 —');
  const cleared = await cdp.eval(`(async () => {
    document.querySelector('#btn-forget').click();
    await __t.sleep(300);
    return { cfg: __t.cfg(), pwdField: document.querySelector('#cfg-password').value, status: __t.status() };
  })()`);
  check(cleared.cfg.password === undefined, '本机不再保存密码');
  check(cleared.pwdField === '', '密码输入框已清空');
  check(/清除/.test(cleared.status), '有明确提示', cleared.status);

  console.log('\n— 4. token 失效且没有账号密码 → 提示去登录 —');
  await cdp.eval(`(() => {
    const c = __t.cfg();
    localStorage.setItem('ic.cfg.v2', JSON.stringify(Object.assign({}, c, {
      token: 'BAD-TOKEN-FOR-TEST', account: '', password: '', rememberPwd: true, loadGlobalIndex: false
    })));
    return true;
  })()`);
  await cdp.send('Page.reload', {});
  await cdp.eval(HELPERS);
  const noCred = await cdp.eval(`(async () => {
    await __t.waitFor(()=>/登录已过期|账号密码/.test(__t.status()), 30000, '提示登录');
    return {
      status: __t.status(),
      setupVisible: !document.querySelector('#setup').classList.contains('hidden'),
      hasAccountField: !!document.querySelector('#cfg-account'),
      hasPwdField: !!document.querySelector('#cfg-password'),
      hasLoginBtn: !!document.querySelector('#btn-login'),
    };
  })()`);
  check(/登录已过期/.test(noCred.status), '提示登录已过期', noCred.status);
  check(noCred.setupVisible, '自动展开设置区');
  check(noCred.hasAccountField && noCred.hasPwdField && noCred.hasLoginBtn, '账号 / 密码 / 登录按钮都在');

  console.log('\n— 5. 需要验证码时弹出验证码输入 —');
  const captcha = await cdp.eval(`(async () => {
    // 桩：登录接口要求验证码（返回 dataURL 图片）
    IC.erp.login = async () => {
      const e = new Error('验证码错误');
      e.needCaptcha = true;
      e.captcha = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      throw e;
    };
    __t.setInput('#cfg-account','tester01');
    __t.setInput('#cfg-password','pw-for-test');
    document.querySelector('#btn-login').click();
    await __t.sleep(600);
    return {
      visible: __t.captchaVisible(),
      imgSrc: (document.querySelector('#captcha-img').src||'').slice(0,22),
      hasVcode: !!document.querySelector('#cfg-vcode'),
      status: __t.status(),
    };
  })()`);
  check(captcha.visible, '验证码行自动显示');
  check(captcha.imgSrc.startsWith('data:image/png'), '验证码图片是可直接显示的 base64', captcha.imgSrc + '…');
  check(captcha.hasVcode, '有验证码输入框');
  check(/验证码/.test(captcha.status), '提示需要验证码', captcha.status);

  console.log('\n— 6. 密码错误时给出接口原话 —');
  const badPwd = await cdp.eval(`(async () => {
    IC.erp.login = async () => { throw new Error('用户名或密码错误'); };
    document.querySelector('#btn-login').click();
    await __t.sleep(600);
    return __t.status();
  })()`);
  check(/用户名或密码错误/.test(badPwd), '错误信息原样展示', badPwd);
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
console.log(`\n登录浏览器端测试：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
