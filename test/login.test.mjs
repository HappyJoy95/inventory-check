/* 登录 / token 续期 联调测试：node test/login.test.mjs
 * 真实调用 ERP 登录接口（用不存在的测试账号，只验证错误分支与契约；不会影响真实账号）
 */
import '../src/core.js';
import '../src/erp.js';
import { CREDS, hasCreds, explainCredFailure } from './env.mjs';

const { login, fetchWarehouses, isTokenError } = globalThis.IC.erp;

let pass = 0,
  fail = 0;
const eq = (a, e, label) => {
  if (JSON.stringify(a) === JSON.stringify(e)) {
    pass++;
    console.log(`  ✓ ${label} = ${JSON.stringify(a)}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}  期望 ${JSON.stringify(e)}，实际 ${JSON.stringify(a)}`);
  }
};
const ok = (c, label, extra) => {
  if (c) {
    pass++;
    console.log(`  ✓ ${label}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`);
  }
};

console.log('— 1. token 失效可被识别（自动重登的触发条件）—');
try {
  // 用明显造出来的假 token（不是真实凭证），配合假商家编码
  await fetchWarehouses({ token: 'fake-token-for-test', companycode: '00000000' });
  ok(false, '无效 token 应当报错');
} catch (e) {
  eq(isTokenError(e), true, '被标记为「登录失效」');
  ok(/未登录|登录超时/.test(e.message), '错误信息可读', e.message);
}

console.log('\n— 2. 有效 token 正常（对照组，需要外部凭证）—');
if (hasCreds()) {
  try {
    const whs = await fetchWarehouses(CREDS);
    ok(whs.length > 30, '外部提供的 token 可用，仓库数', whs.length);
  } catch (e) {
    if (explainCredFailure(e)) {
      fail++;
      console.log('  ✗ 提供的 ERP_TOKEN 已失效（其余用例不依赖它，继续跑）');
    } else throw e;
  }
} else {
  console.log('  · 未提供 ERP_TOKEN / ERP_COMPANYCODE，跳过对照组');
  pass++;
}

console.log('\n— 3. 账号密码错误：给出明确提示 —');
// 故意造的假账号假密码（含 test 字样，凭证守卫会识别为假值）
const BAD = { userName: 'zz_not_exist_test_001', userPwd: 'wrong-password-for-test' };
let err1 = null;
try {
  await login(CREDS, BAD);
  ok(false, '错误账号不应登录成功');
} catch (e) {
  err1 = e;
  ok(/密码错误|验证码|失败/.test(e.message), '错误信息来自接口', e.message);
  eq(typeof e.code, 'number', '带 ResponseID 编号');
}
ok(err1 && !err1.needRegister, '没有误判为「需要注册」');

console.log('\n— 4. 验证码分支：接口直接回一张 base64 图片 —');
let err2 = null;
for (let i = 0; i < 3 && !err2; i++) {
  try {
    await login(CREDS, BAD);
  } catch (e) {
    if (e.needCaptcha) err2 = e;
  }
}
if (err2) {
  eq(err2.needCaptcha, true, '标记为「需要验证码」');
  ok(/^data:image\/(png|jpe?g);base64,/.test(err2.captcha), '验证码是可直接显示的 dataURL');
  ok(err2.captcha.length > 500, '图片内容非空', err2.captcha.length + ' 字节');
} else {
  // 服务端未要求验证码时也属正常（说明该 IP 未触发风控）
  console.log('  · 本次服务端未要求验证码（错误分支已覆盖，跳过图片断言）');
  pass++;
}

console.log('\n— 5. 带验证码重试仍是错误分支（不会抛异常崩溃）—');
let err3 = null;
try {
  await login(CREDS, { userName: BAD.userName, userPwd: BAD.userPwd, VCode: 'abcd' });
} catch (e) {
  err3 = e;
}
ok(!!err3, '确实被接口拒绝', err3 && err3.message);

console.log(`\n登录联调：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
