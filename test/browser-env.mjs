/* 浏览器测试共用：把「外部提供的凭证」注入页面，测试文件本身不含任何凭证
 *
 * 做法：用 CDP 的 Page.addScriptToEvaluateOnNewDocument 在页面脚本之前写入 localStorage，
 * 且只在配置不存在时写入 —— 这样刷新页面时不会覆盖应用自己保存的配置。
 */
import { CREDS, hasCreds, skipIfNoCreds } from './env.mjs';

export { CREDS, hasCreds, skipIfNoCreds };

/** 生产联调用的门店（真实门店标识只从环境变量来，仓库里不留） */
export const STORE = {
  id: process.env.ERP_STORE_ID || '',
  name: process.env.ERP_STORE_NAME || '',
};

/** 注入到页面 document-start 的脚本：给应用一份可用的接口配置 */
export function seedScript() {
  const cfg = {
    token: CREDS.token,
    companycode: CREDS.companycode,
    username: CREDS.username,
    account: '',
    rememberPwd: false,
    sound: false,
    loadGlobalIndex: true, // 端到端流程要验证「表外码归属提示」，保持开启
  };
  return `
    try {
      // 清掉可能残留的会话，保证每个用例从"没有进行中的盘点"开始
      localStorage.removeItem('ic.state.v2');
      localStorage.removeItem('ic.book.v2');
      if (!localStorage.getItem('ic.cfg.v2')) {
        localStorage.setItem('ic.cfg.v2', ${JSON.stringify(JSON.stringify(cfg))});
      }
    } catch (e) {}
  `;
}

/** 覆盖式注入（登录流程测试用：每次导航都强制换成指定配置） */
export function forceSeedScript(extra) {
  const cfg = Object.assign(
    {
      token: CREDS.token,
      companycode: CREDS.companycode,
      username: CREDS.username,
      account: '',
      rememberPwd: false,
      sound: false,
      loadGlobalIndex: false,
    },
    extra || {}
  );
  return `
    try { localStorage.setItem('ic.cfg.v2', ${JSON.stringify(JSON.stringify(cfg))}); } catch (e) {}
  `;
}
