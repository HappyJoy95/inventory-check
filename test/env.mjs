/* 测试用凭证入口：一律从环境变量取，测试文件里不出现任何真实凭证
 *
 *   ERP_TOKEN       必填，ERP 登录后的 token
 *   ERP_COMPANYCODE 必填，商家编码
 *   ERP_USERNAME    选填，用户名（中文姓名），会做 URL 编码后放进请求头
 *
 * 生产联调测试：ERP_TOKEN=xxx ERP_COMPANYCODE=yyy node test/live.test.mjs
 * 不提供时，相关用例会明确跳过（默认测试全部离线可跑）。
 */
export const CREDS = {
  token: process.env.ERP_TOKEN || '',
  companycode: process.env.ERP_COMPANYCODE || '',
  username: process.env.ERP_USERNAME || '',
};

export const hasCreds = () => !!(CREDS.token && CREDS.companycode);

export const SKIP_HINT =
  '未提供 ERP_TOKEN / ERP_COMPANYCODE，跳过生产接口联调（这些用例需要外部凭证，默认测试不含生产凭证）';

/** 没有凭证就打印提示并退出（退出码 0：跳过不算失败） */
export function skipIfNoCreds(label) {
  if (hasCreds()) return false;
  console.log(`\n[跳过] ${label}`);
  console.log('  ' + SKIP_HINT);
  console.log('  示例：ERP_TOKEN=xxx ERP_COMPANYCODE=yyy node ' + process.argv[1].replace(process.cwd() + '/', ''));
  return true;
}

/** 是否显式要求覆盖回归夹具（默认绝不覆盖） */
export const writeFixture = process.argv.includes('--write-fixture');

/** 凭证失效时给出可执行的提示（而不是抛一堆栈） */
export function explainCredFailure(e) {
  const msg = (e && (e.message || String(e))) || '';
  if ((e && e.tokenExpired) || /未登录|登录超时/.test(msg)) {
    console.log('\n[凭证失效] 提供的 ERP_TOKEN 已失效：' + msg);
    console.log('  这不是代码问题：请重新登录 ERP 取一个新 token，再带上商家编码重跑，例如：');
    console.log('    ERP_TOKEN=新token ERP_COMPANYCODE=你的商家编码 npm run test:live');
    console.log('  离线测试不受影响：npm test 不需要任何凭证。');
    return true;
  }
  return false;
}
