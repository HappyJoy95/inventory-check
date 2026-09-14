/* 库存盘点 - 云商 ERP 接口客户端（无依赖）
 * 归入 globalThis.IC.erp
 *
 * 接口来源：erp.yserp.cc 报表页 322.chunk / 登录组件
 *  - 仓库列表：POST https://apicommon.yserp.cc/API/USER/STORE
 *  - 库存查询：POST https://apireport.yserp.cc/api/supplier/RptStoreNow
 *  - 账号登录：POST https://api.yserp.cc/api/User/Login
 * 都回显请求 Origin，因此本地 file:// 打开的单文件页面可直接调用。
 */
globalThis.IC = globalThis.IC || {};
(function () {
  const IC = globalThis.IC;
  const core = IC.core;

  // 不带任何内置凭证：token / 商家编码 / 用户名都必须由使用者登录后获得，
  // 或者由使用者自己填入（见 UI 的「账号密码登录」）。
  const DEFAULT_CFG = {
    token: '',
    companycode: '',
    username: '',
    reportBase: 'https://apireport.yserp.cc/',
    commonBase: 'https://apicommon.yserp.cc/',
    loginBase: 'https://api.yserp.cc/',
    timeout: 90000,
    pageSize: 30000,
  };

  /** 配置是否完整到可以发业务请求 */
  function isConfigured(cfg) {
    return !!(cfg && cfg.token && cfg.companycode);
  }

  /** 配置不完整就别发请求，直接给出可执行的提示 */
  function assertConfigured(cfg) {
    if (!cfg || !cfg.token) {
      const e = new Error('还没有登录：请用 ERP 账号密码登录后再拉取库存');
      e.notConfigured = true;
      throw e;
    }
    if (!cfg.companycode) {
      const e = new Error('缺少商家编码：请重新登录（登录会自动带出商家编码），或手动填写');
      e.notConfigured = true;
      throw e;
    }
    return true;
  }

  // 报表分组字段（与 ERP 页面一致，决定返回哪些列）
  const GROUP_BY =
    'Store,Category1,Category2,Category3,Brand,Model,ProName,OldFlag,Category4,Imei,Imei2,Imei3,ProId,SNCode,PriceLabel';

  function headers(cfg) {
    const h = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      Authorization: 'Bearer ' + (cfg.token || ''),
      traceId: randHex(32),
    };
    if (cfg.companycode) h.companycode = cfg.companycode;
    if (cfg.username) h.username = encodeURIComponent(cfg.username);
    return h;
  }

  function randHex(n) {
    let out = '';
    for (let i = 0; i < n; i++) out += '0123456789abcdef'[(Math.random() * 16) | 0];
    return out;
  }

  // 登录失效能被识别出来（ResponseID 1/9 = 未登录或登录超时），
  // 界面据此用保存的账号密码自动重新登录
  function tokenError(message) {
    const e = new Error(message || '登录已失效');
    e.tokenExpired = true;
    e.code = 1;
    return e;
  }

  /** 数据不完整的统一错误：带标记便于调用方区分「没拉全」和「接口报错」 */
  function incomplete(what, detail) {
    const e = new Error(`${what}：数据不完整，已阻止开始盘点 —— ${detail}`);
    e.incomplete = true;
    e.detail = detail;
    return e;
  }

  async function request(cfg, url, opt) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeout || 90000);
    let resp;
    try {
      resp = await fetch(url, {
        method: opt.method || 'POST',
        headers: opt.headers,
        body: opt.body,
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError')
        throw new Error('请求超时（' + (cfg.timeout || 90000) / 1000 + ' 秒），请检查网络后重试');
      throw new Error('网络请求失败：' + (e && e.message ? e.message : e) + '（请确认能打开 erp.yserp.cc）');
    }
    clearTimeout(timer);
    const text = await resp.text();
    if (!resp.ok) throw new Error('接口返回 HTTP ' + resp.status + '：' + text.slice(0, 200));
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error('接口返回内容无法解析：' + text.slice(0, 200));
    }
    return json;
  }

  async function post(cfg, url, body) {
    const json = await request(cfg, url, {
      headers: headers(cfg),
      body: JSON.stringify(body),
    });
    const rid = Number(json.ResponseID);
    if (rid === 1 || rid === 9) throw tokenError(json.Message || '未登录或登录超时');
    // 与 ERP 前端一致：只有 ResponseID=0 算成功，其余一律当失败，避免把异常响应当数据用
    if (json.is_error === 'true' || json.is_error === true || rid !== 0) {
      throw new Error(
        '接口报错：' + (json.Message || json.return_message || '未知错误') + (Number.isFinite(rid) ? '（ResponseID=' + rid + '）' : '')
      );
    }
    return json;
  }

  /**
   * 账号密码登录换取 token
   * 接口契约（来自 ERP 登录组件）：
   *   请求 POST api/User/Login，表单参数 {token:'', userName, userPwd, VCode?}
   *   成功 ResponseID=0，Data.token 即后续要用的 token
   *   需要验证码时 ResponseID=2，Data 是 data:image/png;base64,... 验证码图片
   * @returns {Promise<{token:string, data:object}>}
   * @throws {Error} 带 needCaptcha / captcha(dataURL) / needRegister 标记
   */
  async function login(cfg, cred) {
    const c = Object.assign({}, DEFAULT_CFG, cfg);
    const form = new URLSearchParams();
    form.set('token', '');
    form.set('userName', core.s(cred.userName));
    form.set('userPwd', core.s(cred.userPwd));
    if (core.s(cred.VCode)) form.set('VCode', core.s(cred.VCode));

    const json = await request(c, c.loginBase + 'api/User/Login', {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json, text/plain, */*',
      },
      body: form.toString(),
    });

    const rid = Number(json.ResponseID);
    const data = json.Data;
    if (rid === 0) {
      const token =
        (data && typeof data === 'object' && (data.token || data.Token)) ||
        (typeof data === 'string' ? data : '');
      if (!token) {
        const e = new Error('登录成功但接口没有返回 token');
        e.raw = json;
        throw e;
      }
      return { token: token, data: data || {} };
    }

    const err = new Error(json.Message || '登录失败');
    err.code = rid;
    if (data && typeof data === 'object' && data.Status) {
      // 该账号需要走注册/审核流程
      err.needRegister = true;
      err.raw = data;
    } else if (typeof data === 'string' && /^data:image\//.test(data)) {
      err.needCaptcha = true;
      err.captcha = data;
    }
    err.raw = json;
    throw err;
  }


  /**
   * 用 token 拉用户资料：登录后用它自动带出商家编码、用户名，
   * 所以使用者只需要输账号密码，不需要知道 companycode。
   * 实测该接口在没有 companycode 请求头时也能正常返回。
   */
  async function fetchUserIndex(cfg) {
    const c = Object.assign({}, DEFAULT_CFG, cfg);
    const json = await post(c, c.loginBase + 'Api/User/UserIndex', { token: c.token });
    const d = json.Data || {};
    return {
      companycode: core.s(d.CompanyCode),
      username: core.s(d.Real) || core.s(d.UserName),
      loginName: core.s(d.UserName),
      raw: d,
    };
  }

  /** 拉取仓库（分仓）列表 -> [{id, name, branchName, branchId}] */
  async function fetchWarehouses(cfg) {
    const c = Object.assign({}, DEFAULT_CFG, cfg);
    assertConfigured(c);
    const json = await post(c, c.commonBase + 'API/USER/STORE', {
      token: c.token,
      DataPower: 1,
      StoreCheckPower: '',
    });
    const list = Array.isArray(json.Data) ? json.Data : [];
    return list
      .map((x) => ({
        id: String(x.Id),
        name: core.s(x.Name),
        branchName: core.s(x.BranchName),
        branchId: core.s(x.BranchId),
      }))
      .filter((x) => x.id && x.name)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  function buildQuery(cfg, opt) {
    return {
      token: cfg.token,
      BranchId: opt.branchId || '',
      DateOfSnapshot: opt.date,
      StoreIds: opt.storeId ? String(opt.storeId) : '',
      CustomerId: '',
      vendorIds: '',
      CategoryId: '',
      ProName: opt.proName || '',
      Brands: '',
      Models: '',
      Config: '',
      Imei: opt.imei || '',
      SubImei: '',
      groupBy: GROUP_BY,
      // 同时取「在库数量」和「在途数量」：
      // 列名 ProCount_OnTransfer 来自报表列配置接口 /Api/RoleMenu/RoleRptCol（RptId=100 就是这张库存表），
      // ERP 前端在查"今天"时会保留这列、查历史快照时才把它剔除。
      outCol: 'ProCount,ProCount_OnTransfer',
      Sort: '',
      OrderBy: '',
      PriceLabelIdStr: '',
      PageSize: opt.pageSize || cfg.pageSize,
      PageIndex: opt.pageIndex || 1,
    };
  }

  /**
   * 分页拉取库存明细
   * @param {object} opt {date, storeId, pageSize, onProgress(done,total), maxPages}
   * @returns {Promise<{rows:Array, totalRows:number, pages:number}>}
   */
  async function fetchInventory(cfg, opt) {
    const c = Object.assign({}, DEFAULT_CFG, cfg);
    assertConfigured(c);
    opt = opt || {};
    const pageSize = opt.pageSize || c.pageSize;
    const maxPages = opt.maxPages || 40;
    const what = opt.label || '库存查询';
    const rows = [];
    const pageFingerprints = new Set();
    let pageIndex = 1;
    let totalRows = null;
    let pages = 0;

    for (;;) {
      const json = await post(
        c,
        c.reportBase + 'api/supplier/RptStoreNow',
        buildQuery(c, {
          date: opt.date,
          storeId: opt.storeId,
          branchId: opt.branchId,
          proName: opt.proName,
          imei: opt.imei,
          pageSize: pageSize,
          pageIndex: pageIndex,
        })
      );

      // ---- 1. 响应结构校验 ----
      const data = json.Data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw incomplete(what, `第 ${pageIndex} 页返回结构异常：Data 不是对象`);
      }
      if (!Array.isArray(data.Data)) {
        throw incomplete(what, `第 ${pageIndex} 页返回结构异常：Data.Data 不是明细数组`);
      }
      const batch = data.Data;
      const tr = Number(data.TotalRows);
      if (!Number.isFinite(tr) || tr < 0) {
        throw incomplete(what, `第 ${pageIndex} 页的 TotalRows 不合法：${JSON.stringify(data.TotalRows)}`);
      }

      // ---- 2. 总行数一致性 ----
      if (totalRows === null) {
        totalRows = tr;
        // 合法的零库存：总行数 0 且确实没有明细
        if (totalRows === 0) {
          if (batch.length !== 0) {
            throw incomplete(what, `声称总行数为 0，却返回了 ${batch.length} 行明细`);
          }
          return { rows: [], totalRows: 0, pages: 1, empty: true };
        }
      } else if (tr !== totalRows) {
        throw incomplete(
          what,
          `分页过程中总行数发生变化（第 1 页 ${totalRows} → 第 ${pageIndex} 页 ${tr}），账面正在变动，请重新拉取`
        );
      }

      // ---- 3. 提前空页 ----
      if (batch.length === 0) {
        throw incomplete(
          what,
          `第 ${pageIndex} 页返回空，但只收到 ${rows.length}/${totalRows} 行，数据没拉全`
        );
      }

      // ---- 4. 重复页 ----
      const fp = batch.length + '|' + core.s(batch[0].RowId) + '|' + core.s(batch[batch.length - 1].RowId);
      if (pageFingerprints.has(fp)) {
        throw incomplete(what, `第 ${pageIndex} 页与前面某页内容重复，分页异常`);
      }
      pageFingerprints.add(fp);

      rows.push.apply(rows, batch);
      pages++;

      if (rows.length > totalRows) {
        throw incomplete(what, `返回行数（${rows.length}）超过总行数（${totalRows}）`);
      }
      if (opt.onProgress) {
        try {
          opt.onProgress(rows.length, totalRows);
        } catch (e) {
          /* 忽略回调异常 */
        }
      }
      if (rows.length === totalRows) break;

      // ---- 5. 分页上限 ----
      if (pages >= maxPages) {
        throw incomplete(what, `达到分页上限（${maxPages} 页）仍未拉全：${rows.length}/${totalRows}`);
      }
      pageIndex++;
    }

    // ---- 6. 最终核对 ----
    if (rows.length !== totalRows) {
      throw incomplete(what, `只拉到 ${rows.length} 行，应有 ${totalRows} 行`);
    }
    return { rows: rows, totalRows: totalRows, pages: pages, empty: false };
  }

  /**
   * 拉取「在途（待入库）」清单
   *
   * 契约来自 ERP 自己的「库存明细」页面代码：
   *   curAPI = "Api/Report/InventoryImei"
   *   search.InventoryType 取值：0=在库、1=在途（页面上的「在库/在途」开关）
   *   search 里还有 StoreId / StoreName / DateOfSnapshot / ReceivingCode（收货单号）等
   *
   * 说明：这条链路目前**没有用真实凭证验证过**（token 失效期间无法联调），
   * 所以这里做了三件事兜底：
   *   1) 只认真实返回的数组，形状不对就明确报错，绝不悄悄当成"没有在途"；
   *   2) 拿到结果后再按仓库名/仓库 ID 过滤一次，防止接口忽略过滤条件时把别仓的混进来；
   *   3) 调用方失败时只提示、不阻断盘点。
   */
  async function fetchInTransit(cfg, opt) {
    const c = Object.assign({}, DEFAULT_CFG, cfg);
    assertConfigured(c);
    opt = opt || {};
    const pageSize = opt.pageSize || 500;
    const rows = [];
    let pageIndex = 1;
    let totalRows = null;
    const maxPages = opt.maxPages || 20;

    for (;;) {
      const json = await post(c, c.reportBase + 'Api/Report/InventoryImei', {
        token: c.token,
        InventoryType: 1, // 1 = 在途
        DateOfSnapshot: opt.date || '',
        StoreId: opt.storeId ? String(opt.storeId) : '',
        StoreName: opt.storeName || '',
        BranchId: opt.branchId || '',
        BranchName: opt.branchName || '',
        ProName: '',
        Category: '',
        IsBorrowed: '',
        old: '',
        Imei: '',
        ReceivingCode: '',
        WarningFlag: false,
        PageIndex: pageIndex,
        PageSize: pageSize,
      });

      const data = json.Data;
      let batch = null;
      if (Array.isArray(data)) batch = data;
      else if (data && Array.isArray(data.Data)) batch = data.Data;
      if (!batch) {
        const e = new Error('在途查询：返回结构异常，既不是数组也没有 Data.Data 数组');
        e.incomplete = true;
        throw e;
      }
      const tr = data && typeof data === 'object' && !Array.isArray(data) ? Number(data.TotalRows) : NaN;
      if (totalRows === null && Number.isFinite(tr)) totalRows = tr;

      rows.push.apply(rows, batch);
      if (!batch.length || batch.length < pageSize) break;
      if (Number.isFinite(totalRows) && rows.length >= totalRows) break;
      if (pageIndex >= maxPages) break;
      pageIndex++;
    }

    // 防御性过滤：只保留确实属于这个仓的在途
    const storeId = core.s(opt.storeId);
    const storeName = core.s(opt.storeName);
    const kept = [];
    let droppedByStore = 0;
    rows.forEach((r) => {
      const sid = core.s(r.StoreId || r.storeId);
      const sname = core.s(r.StoreName || r.Store || r.storeName);
      const matchId = storeId && sid && sid === storeId;
      const matchName = storeName && sname && sname === storeName;
      // 接口没带仓库信息时不做丢弃（宁可多展示，也不漏）
      if (!sid && !sname) {
        kept.push(r);
        return;
      }
      if (matchId || matchName) kept.push(r);
      else droppedByStore++;
    });

    return { rows: kept, fetched: rows.length, droppedByStore: droppedByStore, totalRows: totalRows };
  }

  /**
   * 拉取全公司串号索引（用于判断"这个码在哪个仓"）
   * @returns {Promise<Map<string, Array<{store:string,name:string}>>>}
   */
  async function fetchGlobalIndex(cfg, opt) {
    opt = opt || {};
    const res = await fetchInventory(cfg, {
      date: opt.date,
      storeId: '',
      pageSize: 30000,
      label: '全库索引',
      onProgress: opt.onProgress,
    });
    const map = new Map();
    res.rows.forEach((raw) => {
      const store = core.s(raw.Store);
      const name = core.s(raw.ProName);
      const it = core.normalizeItem(raw, '', 0);
      it.serials.forEach((code) => {
        const k = core.normCode(code);
        if (!k) return;
        if (!map.has(k)) map.set(k, []);
        const arr = map.get(k);
        if (!arr.some((x) => x.store === store)) arr.push({ store: store, name: name });
      });
    });
    return map;
  }

  IC.erp = {
    DEFAULT_CFG,
    GROUP_BY,
    isConfigured,
    assertConfigured,
    fetchUserIndex,
    post,
    request,
    login,
    tokenError,
    incomplete,
    isTokenError: (e) => !!(e && e.tokenExpired),
    isIncomplete: (e) => !!(e && e.incomplete),
    fetchWarehouses,
    fetchInventory,
    fetchInTransit,
    fetchGlobalIndex,
  };
})();
