/* ==========================================================================
   墨舟移动端 · 客户端核心层 v5
   - 请求封装（会话口令 / 超时 / 统一错误 / 离线标记）
   - iOS 交互组件：Sheet（可下拉关闭）/ ActionSheet / Modal / Toast / 触感 / 下拉刷新
   - 图标系统：全套重绘 SVG（底栏 5 个主图标 + 40 余枚功能图标，描边统一 1.7）
   - 动效原语：进度环 / 进度条 / 数字滚动 / 骨架屏 / 点击涟漪 / 弹簧常量
   - 轻量 hyperscript，避免 innerHTML 拼接带来的转义问题

   ⚠️ 历史缺陷（v1.3 已修，勿回退）：
   旧版关闭遮罩时会先触发 onClose 回调，而 modal 把 onClose 当作「取消」处理
   （resolve(null)）。点「确定」时 close() 先执行，Promise 已被 resolve 成 null，
   随后的 resolve(真实值) 不再生效。结果是所有弹窗恒返回 null：
   confirm 恒为 false（删除 / 回滚 / 停止全部静默失效），
   补更（续写）填完章数点「开始写」也没有任何反应。
   v1.3 起，确定与取消都先摘掉 onClose 再关闭，Promise 不会被抢答。
   ========================================================================== */
'use strict';

window.MZ = (function () {
  const SVGNS = 'http://www.w3.org/2000/svg';
  const VERSION = '1.3';

  /* ============================== 会话与地址 ============================== */
  const TOKEN_KEY = 'mz_token';
  let token = '';
  try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { token = ''; }

  /* 支持用「带口令的链接」直接进入：.../m/?token=xxx */
  try {
    const _m = /[?&]token=([^&]*)/.exec(location.search || '');
    if (_m && _m[1]) {
      token = decodeURIComponent(_m[1]).trim();
      try { localStorage.setItem(TOKEN_KEY, token); } catch (e) { /* 忽略 */ }
      try {
        document.cookie = 'mz_token=' + encodeURIComponent(token) + '; path=/; max-age=31536000; SameSite=Lax';
      } catch (e) { /* 忽略 */ }
      try { history.replaceState(null, '', location.pathname); } catch (e) { /* 忽略 */ }
    }
  } catch (e) { /* 忽略 */ }

  /* 装机版：云地址 + 会话口令。
     App 里的页面跑在 capacitor://localhost，属于跨域，所以接口都要用绝对地址
     打到云服务器并带会话头。window.MZ_CLOUD 留给自己调试（本地假后端时设成空串）。 */
  const CLOUD = (window.MZ_CLOUD !== undefined && window.MZ_CLOUD !== null)
    ? String(window.MZ_CLOUD)
    : 'https://47-101-72-16.sslip.io';
  const SESS_KEY = 'mz_gw';
  let sess = '';
  try { sess = localStorage.getItem(SESS_KEY) || ''; } catch (e) { sess = ''; }

  function url(p) { return (p && p.charAt(0) === '/') ? CLOUD + p : p; }
  /* 图片标签发不出自定义请求头，改用 ?mz_sess= 会话参数 */
  function img(p) {
    if (!p) return p;
    let u = url(p);
    if (!sess) return u;
    return u + (u.indexOf('?') < 0 ? '?' : '&') + 'mz_sess=' + encodeURIComponent(sess);
  }
  function authHeaders() {
    const o = { 'X-Mz-App': '1' };
    if (sess) o['X-Mz-Sess'] = sess;
    return o;
  }
  function setSession(t) {
    sess = t || '';
    try { if (sess) localStorage.setItem(SESS_KEY, sess); else localStorage.removeItem(SESS_KEY); } catch (e) { /* 忽略 */ }
  }
  function logout() {
    setSession('');
    try { localStorage.removeItem('mz_token'); } catch (e) { /* 忽略 */ }
    location.replace('index.html');
  }

  /* ============================== 请求 ============================== */
  class ApiError extends Error {
    constructor(msg, code) { super(msg); this.code = code || 0; }
  }

  async function req(path, opts) {
    opts = opts || {};
    const init = {
      method: opts.method || 'GET',
      headers: { 'Accept': 'application/json' },
      cache: 'no-store',
    };
    if (token) init.headers['X-Mozhou-Token'] = token;
    Object.assign(init.headers, authHeaders());
    if (opts.body !== undefined && opts.body !== null) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }

    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timer = null;
    const ms = opts.timeout || 120000;
    if (ctrl) {
      init.signal = ctrl.signal;
      timer = setTimeout(function () { ctrl.abort(); }, ms);
    }

    let resp;
    try {
      resp = await fetch(url(path), init);
    } catch (e) {
      if (timer) clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new ApiError('超时：服务端 ' + Math.round(ms / 1000) + ' 秒内没有响应', -1);
      MZ.online = false;
      throw new ApiError('连不上云端服务器，请检查手机网络后重试', -2);
    }
    if (timer) clearTimeout(timer);
    MZ.online = true;

    let data = null;
    const text = await resp.text();
    if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }

    if (resp.status === 401) {
      /* 会话过期：清掉本地口令，退回登录页重新登录 */
      setSession('');
      if (!/index\.html$/.test(location.pathname)) {
        setTimeout(function () { location.replace('index.html'); }, 600);
      }
      throw new ApiError('登录已过期，请重新登录', 401);
    }
    if (!resp.ok) {
      const m = (data && (data.msg || data.message || data.error)) || ('请求失败（HTTP ' + resp.status + '）');
      throw new ApiError(m, resp.status);
    }
    if (data && data.ok === false) throw new ApiError(data.msg || data.error || '操作失败', 0);
    return data || {};
  }

  const api = {
    get: function (p, o) { return req(p, Object.assign({ method: 'GET' }, o)); },
    post: function (p, b, o) { return req(p, Object.assign({ method: 'POST', body: b || {} }, o)); },
    put: function (p, b, o) { return req(p, Object.assign({ method: 'PUT', body: b || {} }, o)); },
    del: function (p, o) { return req(p, Object.assign({ method: 'DELETE' }, o)); },
  };

  /* ============================== hyperscript ============================== */
  function h(tag, attrs) {
    const parts = String(tag).split(/([.#])/);
    const el = document.createElement(parts[0] || 'div');
    for (let i = 1; i < parts.length; i += 2) {
      if (parts[i] === '.') el.classList.add(parts[i + 1]);
      else if (parts[i] === '#') el.id = parts[i + 1];
    }
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = (el.className ? el.className + ' ' : '') + v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v);
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'text') el.textContent = v;
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      });
    }
    for (let i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, child) {
    if (child === null || child === undefined || child === false || child === true) return;
    if (Array.isArray(child)) { child.forEach(function (c) { add(el, c); }); return; }
    el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  function frag() {
    const f = document.createDocumentFragment();
    for (let i = 0; i < arguments.length; i++) add(f, arguments[i]);
    return f;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* ============================== 动效开关 / 触感 ============================== */
  function reduceMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (e) { return false; }
  }

  function haptic(kind) {
    try {
      const C = window.Capacitor;
      const H = C && C.Plugins && C.Plugins.Haptics;
      if (H) {
        if (kind === 'success') return H.notification({ type: 'SUCCESS' });
        if (kind === 'error' || kind === 'bad') return H.notification({ type: 'ERROR' });
        if (kind === 'warn') return H.notification({ type: 'WARNING' });
        if (kind === 'medium') return H.impact({ style: 'MEDIUM' });
        if (kind === 'heavy') return H.impact({ style: 'HEAVY' });
        return H.impact({ style: 'LIGHT' });
      }
      if (navigator.vibrate) navigator.vibrate(kind === 'error' || kind === 'bad' ? [18, 40, 18] : 12);
    } catch (e) { /* 触感失败不影响功能 */ }
  }

  /* ============================== 图标（重绘） ==============================
     24×24 网格 / 描边 1.7 / 圆角端点。底栏五个主图标是为本版重画的：
     总览=罗盘、书架=三本立书、写作=钢笔尖、任务=心跳脉冲、我的=舵轮。 */
  const ICONS = {
    overview: '<circle cx="12" cy="12" r="8.6"/><path d="M15.4 8.6l-1.9 4.9-4.9 1.9 1.9-4.9z"/>',
    books: '<path d="M4 5.4A1.4 1.4 0 0 1 5.4 4h2.7v15.6H5.4A1.4 1.4 0 0 1 4 18.2z"/><path d="M8.1 4h3.1v15.6H8.1z"/><path d="M14.3 6.4l2.2-.6 3.5 13-2.2.6z"/>',
    write: '<path d="M12 3.4s5.3 6.4 5.3 10a5.3 5.3 0 0 1-10.6 0c0-3.6 5.3-10 5.3-10z"/><path d="M12 12.4v9"/>',
    jobs: '<path d="M3.8 12.6h3l1.8-4.4 2.6 8.6 2-5.4 1.5 1.2h5.5"/>',
    me: '<circle cx="12" cy="12" r="8.6"/><circle cx="12" cy="12" r="2.6"/><path d="M12 3.4v6M12 14.6v6M3.4 12h6M14.6 12h6"/>',

    back: '<path d="M14.8 5.4L8.2 12l6.6 6.6"/>',
    fwd: '<path d="M9.2 5.4L15.8 12l-6.6 6.6"/>',
    up: '<path d="M5.4 14.8L12 8.2l6.6 6.6"/>',
    down: '<path d="M5.4 9.2L12 15.8l6.6-6.6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    check: '<path d="M4.8 12.6l4.6 4.6L19.4 7.4"/>',
    more: '<circle cx="5.4" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="18.6" cy="12" r="1.5"/>',
    search: '<circle cx="11" cy="11" r="6.4"/><path d="M15.8 15.8l4.7 4.7"/>',
    filter: '<path d="M4 6.5h16M6.8 12h10.4M10 17.5h4"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4.4V10h-5.4"/>',
    spark: '<path d="M11 4.2l1.6 4.3 4.3 1.6-4.3 1.6L11 16l-1.6-4.3L5.1 10.1l4.3-1.6z"/><path d="M18.4 15.2l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
    shield: '<path d="M12 3.6l6.6 2.4v5.4c0 4.2-2.9 7.3-6.6 8.7-3.7-1.4-6.6-4.5-6.6-8.7V6z"/><path d="M9.2 12.2l2 2 3.7-3.9"/>',
    hook: '<circle cx="12" cy="5.6" r="2"/><path d="M12 7.6v10.8"/><path d="M5.8 12.6c.6 3.6 2.9 5.8 6.2 5.8s5.6-2.2 6.2-5.8"/>',
    history: '<path d="M3.8 12a8.2 8.2 0 1 0 2.6-6"/><path d="M3.6 5.6V11h5.4"/><path d="M12 8.4V12l2.6 1.8"/>',
    trash: '<path d="M4.8 7.4h14.4"/><path d="M9.2 7.4V5.6c0-.6.5-1.1 1.1-1.1h3.4c.6 0 1.1.5 1.1 1.1v1.8"/><path d="M6.6 7.4l.9 11.4c.1.9.8 1.6 1.7 1.6h5.6c.9 0 1.6-.7 1.7-1.6l.9-11.4"/>',
    download: '<path d="M12 4v10.4"/><path d="M8 10.6l4 4 4-4"/><path d="M4.8 18.6h14.4"/>',
    cloud: '<path d="M7.4 18.4h9.7a3.6 3.6 0 0 0 .5-7.2 5.4 5.4 0 0 0-10.4-1.2 3.9 3.9 0 0 0 .2 8.4z"/>',
    key: '<circle cx="8.4" cy="12" r="3.4"/><path d="M11.8 12H21"/><path d="M18 12v3M15 12v2.4"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.8v2.2M12 19v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.8 12H5M19 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/>',
    moon: '<path d="M20 14.4A8.4 8.4 0 0 1 9.6 4 8.4 8.4 0 1 0 20 14.4z"/>',
    sliders: '<path d="M4.6 7.4h7.2M17.4 7.4h2M4.6 12h3.2M13.4 12h6M4.6 16.6h7.2M17.4 16.6h2"/><circle cx="14.4" cy="7.4" r="2.1"/><circle cx="10.4" cy="12" r="2.1"/><circle cx="14.4" cy="16.6" r="2.1"/>',
    chart: '<path d="M4.6 19.4V13M9.5 19.4V6.6M14.5 19.4v-8M19.4 19.4V9"/>',
    bolt: '<path d="M13.4 3L6.8 13.2h4.4L10 21l6.8-10.4h-4.6z"/>',
    play: '<path d="M8 5.4l10 6.6-10 6.6z"/>',
    stop: '<rect x="6.4" y="6.4" width="11.2" height="11.2" rx="2.6"/>',
    wifi: '<path d="M4.6 9.6a11 11 0 0 1 14.8 0"/><path d="M7.6 13a6.6 6.6 0 0 1 8.8 0"/><circle cx="12" cy="17.4" r="1.3"/>',
    user: '<circle cx="12" cy="8.6" r="3.6"/><path d="M5.2 20c.8-3.6 3.5-5.4 6.8-5.4s6 1.8 6.8 5.4"/>',
    phone: '<rect x="7" y="3.4" width="10" height="17.2" rx="2.6"/><path d="M10.6 18.2h2.8"/>',
    lock: '<rect x="5.4" y="10.4" width="13.2" height="9.4" rx="2.6"/><path d="M8.6 10.4V8a3.4 3.4 0 0 1 6.8 0v2.4"/>',
    book: '<path d="M5 4.4h11.6A2.4 2.4 0 0 1 19 6.8v12.8H7.4A2.4 2.4 0 0 1 5 17.2z"/><path d="M8.6 4.4v15.2"/>',
    edit: '<path d="M4.4 19.6l4-.9 9.2-9.2a2.1 2.1 0 0 0-3-3l-9.2 9.2z"/><path d="M13.6 6.6l3 3"/>',
    file: '<path d="M6.4 3.6h6.8l4.4 4.4v12.4H6.4z"/><path d="M13 3.6V8.2h4.6"/>',
    clock: '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.4V12l3.2 2.2"/>',
    star: '<path d="M12 4.2l2.5 5.1 5.6.8-4 3.9 1 5.6-5.1-2.7-5.1 2.7 1-5.6-4-3.9 5.6-.8z"/>',
    fire: '<path d="M12 3.6c3.4 3.2 5.4 5.9 5.4 9a5.4 5.4 0 0 1-10.8 0c0-1.6.7-3 1.9-4.4.4 1.2 1.1 1.9 2.1 2.1-.4-2.2-.6-4.4 1.4-6.7z"/>',
    target: '<circle cx="12" cy="12" r="8.4"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1.1"/>',
    layers: '<path d="M12 3.8l8 4.2-8 4.2-8-4.2z"/><path d="M4 12.4l8 4.2 8-4.2"/><path d="M4 16.6l8 4.2 8-4.2"/>',
    copy: '<rect x="8.4" y="8.4" width="11.2" height="11.2" rx="2.6"/><path d="M15.6 5.6A2.4 2.4 0 0 0 13.2 4.4H6.8A2.4 2.4 0 0 0 4.4 6.8v6.4c0 1 .6 1.9 1.4 2.2"/>',
    eye: '<path d="M2.8 12S6.4 6 12 6s9.2 6 9.2 6-3.6 6-9.2 6-9.2-6-9.2-6z"/><circle cx="12" cy="12" r="2.6"/>',
    bell: '<path d="M6.6 10.4a5.4 5.4 0 0 1 10.8 0c0 3.6 1.4 5 1.4 5H5.2s1.4-1.4 1.4-5z"/><path d="M10.2 18.4a2 2 0 0 0 3.6 0"/>',
    help: '<circle cx="12" cy="12" r="8.4"/><path d="M9.6 9.6a2.4 2.4 0 1 1 3.4 2.2c-.6.4-1 .9-1 1.6v.5"/><circle cx="12" cy="17.1" r=".9"/>',
    git: '<circle cx="6.4" cy="6.4" r="2.6"/><circle cx="6.4" cy="17.6" r="2.6"/><circle cx="17.6" cy="9.6" r="2.6"/><path d="M6.4 9v6M9 6.4h4.2a4.4 4.4 0 0 1 4.4 4.4v3.4"/>',
    dot: '<circle cx="12" cy="12" r="3"/>',
  };

  function icon(name, opt) {
    opt = opt || {};
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', opt.view || '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', String(opt.w || 1.7));
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'ico' + (opt.cls ? ' ' + opt.cls : ''));
    if (opt.size) { const s = (typeof opt.size === 'number' ? opt.size + 'px' : opt.size); svg.style.width = svg.style.height = s; }
    const body = ICONS[name] || ICONS.dot;
    try { svg.innerHTML = body; }
    catch (e) {
      const doc = new DOMParser().parseFromString('<svg xmlns="' + SVGNS + '">' + body + '</svg>', 'image/svg+xml');
      while (doc.documentElement.firstChild) svg.appendChild(doc.importNode(doc.documentElement.firstChild, true));
    }
    return svg;
  }

  /* 品牌标：一叶舟 + 一道水痕 */
  function brand(size) {
    const svg = icon('dot', { size: size || 44, view: '0 0 48 48', w: 2.1 });
    try {
      svg.innerHTML =
        '<path d="M9 29.4h30c0 5.4-6.7 9.6-15 9.6S9 34.8 9 29.4z"/>' +
        '<path d="M24 6.6v22.8"/>' +
        '<path d="M24 10.4c5.6 3.4 8.4 8 8.4 12.6H24z"/>' +
        '<path d="M4.4 43c3.2-2.2 6.4-2.2 9.6 0s6.4 2.2 9.6 0 6.4-2.2 9.6 0 6.4 2.2 9.6 0"/>';
    } catch (e) { /* 忽略 */ }
    return svg;
  }

  /* ============================== Toast ============================== */
  function toast(msg, kind, opt) {
    opt = opt || {};
    const box = $('#toasts');
    if (!box) return;
    const el = h('div.toast' + (kind ? '.' + kind : ''), null,
      h('span.t-ico', null, icon(kind === 'ok' ? 'check' : (kind === 'bad' ? 'close' : 'bell'), { size: 17 })),
      h('span.t-msg', { text: String(msg) }));
    if (opt.action) {
      const b = h('button.t-act', { type: 'button', text: opt.action });
      b.addEventListener('click', function () {
        haptic('light');
        kill(0);
        if (opt.onTap) opt.onTap();
      });
      el.appendChild(b);
    }
    box.appendChild(el);
    let dead = false;
    function kill(delay) {
      if (dead) return;
      dead = true;
      setTimeout(function () {
        el.classList.add('out');
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 320);
      }, delay === undefined ? (kind === 'bad' ? 4200 : 2600) : delay);
    }
    kill();
    el.addEventListener('click', function () { if (!opt.action) kill(0); });
    return el;
  }

  /* ============================== 遮罩基类 ============================== */
  function bindMask(maskId, boxId) {
    const mask = $('#' + maskId);
    const box = $('#' + boxId);
    let onClose = null;
    function close() {
      mask.classList.remove('on');
      mask.classList.add('hidden');
      setTimeout(function () { clear(box); }, 320);
      const cb = onClose; onClose = null;
      if (cb) cb();
    }
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    return {
      mask: mask, box: box, close: close,
      setOnClose: function (f) { onClose = f; },
      /* 关键：按钮自己给结果时，先摘掉 onClose 再关，避免它抢答成 null */
      closeSilent: function () { onClose = null; close(); },
    };
  }

  let sheetCtl = null, actionsCtl = null, modalCtl = null;

  /* Sheet：底部抽屉，承载长内容与操作。支持下拉关闭（橡皮筋）。 */
  function sheet(opt) {
    opt = opt || {};
    if (!sheetCtl) sheetCtl = bindMask('maskSheet', 'sheetBox');
    const box = sheetCtl.box;
    clear(box);
    const head = opt.title ? h('div.sheet-head', null,
      h('h3', { text: opt.title }),
      opt.headRight || null) : null;
    const body = h('div.sheet-body');
    box.appendChild(h('div.grabber', null, h('i')));
    if (head) box.appendChild(head);
    box.appendChild(body);
    sheetCtl.setOnClose(opt.onClose || null);
    if (opt.build) opt.build(body, function () { sheetCtl.closeSilent(); });
    else if (opt.node) add(body, opt.node);
    box.style.height = opt.height || '';

    /* 下拉关闭：只跟手，松手看距离决定回弹还是关掉 */
    let y0 = 0, dy = 0, drag = false;
    function onDown(e) {
      if (e.target.closest && e.target.closest('button,input,textarea,.no-drag')) return;
      const t = e.touches ? e.touches[0] : e;
      y0 = t.clientY; dy = 0; drag = true;
      box.style.transition = 'none';
    }
    function onMove(e) {
      if (!drag) return;
      const t = e.touches ? e.touches[0] : e;
      dy = Math.max(0, t.clientY - y0);
      box.style.transform = 'translateY(' + (dy * (dy > 130 ? 0.5 : 0.86)) + 'px)';
    }
    function onUp() {
      if (!drag) return;
      drag = false;
      box.style.transition = '';
      box.style.transform = '';
      if (dy > 96) sheetCtl.closeSilent();
    }
    box.addEventListener('touchstart', onDown, { passive: true });
    box.addEventListener('touchmove', onMove, { passive: true });
    box.addEventListener('touchend', onUp);
    box.addEventListener('touchcancel', onUp);

    sheetCtl.mask.classList.remove('hidden');
    requestAnimationFrame(function () { sheetCtl.mask.classList.add('on'); });
    haptic('light');
    return { close: function () { sheetCtl.closeSilent(); }, body: body };
  }

  /* ActionSheet：底部动作列表 */
  function actions(items, opt) {
    opt = opt || {};
    if (!actionsCtl) actionsCtl = bindMask('maskActions', 'actionsBox');
    const box = actionsCtl.box;
    clear(box);
    const group = h('div.as-group');
    if (opt.title) group.appendChild(h('div.as-title', { text: opt.title }));
    items.forEach(function (it) {
      const btn = h('button.as-item' + (it.danger ? '.danger' : '') + (it.strong ? '.strong' : ''),
        { type: 'button' },
        h('span.as-label', null, it.icon ? icon(it.icon, { size: 19 }) : null, h('span', { text: it.label })),
        it.sub ? h('span.as-sub', { text: it.sub }) : null);
      btn.addEventListener('click', function () {
        actionsCtl.closeSilent();
        haptic('light');
        if (it.onPick) setTimeout(it.onPick, 70);
      });
      group.appendChild(btn);
    });
    box.appendChild(group);
    const cancel = h('button.as-group.as-item', { type: 'button', text: '取消' });
    cancel.style.borderRadius = '16px';
    cancel.addEventListener('click', function () { actionsCtl.closeSilent(); });
    box.appendChild(cancel);
    actionsCtl.setOnClose(null);
    actionsCtl.mask.classList.remove('hidden');
    requestAnimationFrame(function () { actionsCtl.mask.classList.add('on'); });
    return { close: function () { actionsCtl.closeSilent(); } };
  }

  /* Modal：居中确认 / 输入对话框。返回 Promise，取消为 null。 */
  function modal(opt) {
    opt = opt || {};
    return new Promise(function (resolve) {
      if (!modalCtl) modalCtl = bindMask('maskModal', 'modalBox');
      const box = modalCtl.box;
      clear(box);
      let inputEl = null;
      box.appendChild(h('h3', { text: opt.title || '' }));
      if (opt.text) box.appendChild(h('p', { text: opt.text }));
      if (opt.input) {
        inputEl = h('input.li-input', {
          type: opt.input === 'number' ? 'number' : 'text',
          autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false',
          inputmode: opt.input === 'number' ? 'decimal' : 'text',
          placeholder: opt.placeholder || '',
          value: opt.value === undefined || opt.value === null ? '' : String(opt.value),
          style: { textAlign: 'left', background: 'var(--panel2)', border: '1px solid var(--line)',
                   borderRadius: '14px', padding: '13px 14px' },
        });
        box.appendChild(inputEl);
      }
      const okBtn = h('button.btn.' + (opt.danger ? 'danger' : 'primary'), { type: 'button' },
        opt.okText || '确定');
      const cancelBtn = h('button.btn.ghost', { type: 'button', text: opt.cancelText || '取消' });
      const row = h('div.row.mt16', { style: { gap: '10px' } });
      cancelBtn.style.flex = '1';
      okBtn.style.flex = '1.4';
      cancelBtn.addEventListener('click', function () {
        modalCtl.closeSilent();       /* 先摘回调，否则 close() 会把结果抢答成 null */
        resolve(null);
      });
      okBtn.addEventListener('click', function () {
        const v = inputEl ? inputEl.value : true;
        modalCtl.closeSilent();
        resolve(v);
      });
      if (inputEl) {
        inputEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') okBtn.click(); });
      }
      row.appendChild(cancelBtn);
      row.appendChild(okBtn);
      box.appendChild(row);
      modalCtl.setOnClose(function () { resolve(null); });   /* 点遮罩 / 系统返回 */
      modalCtl.mask.classList.remove('hidden');
      requestAnimationFrame(function () { modalCtl.mask.classList.add('on'); });
      /* 聚焦时带 preventScroll：iOS 上自动聚焦输入框会把整页顶上去 */
      if (inputEl) {
        setTimeout(function () {
          try { inputEl.focus({ preventScroll: true }); inputEl.select(); } catch (e) { inputEl.focus(); }
        }, 240);
      }
    });
  }

  function confirm(text, opt) {
    opt = opt || {};
    return modal({ text: text, title: opt.title, okText: opt.okText || '确定',
      cancelText: opt.cancelText || '取消', danger: !!opt.danger })
      .then(function (v) { return v === true; });
  }

  /* ============================== 下拉刷新 ============================== */
  function attachPull(scroller, onRefresh) {
    let startY = 0, pulling = false, dist = 0, busy = false;
    const holder = h('div.pull', null,
      h('div.pull-spin', null, icon('refresh', { size: 18 })),
      h('div.pull-txt', { text: '下拉刷新' }));
    scroller.insertBefore(holder, scroller.firstChild);
    const TH = 64;
    function setH(v) { holder.style.height = v + 'px'; }
    scroller.addEventListener('touchstart', function (e) {
      if (busy || scroller.scrollTop > 0 || e.touches.length !== 1) { pulling = false; return; }
      startY = e.touches[0].clientY; pulling = true; dist = 0;
    }, { passive: true });
    scroller.addEventListener('touchmove', function (e) {
      if (!pulling) return;
      dist = e.touches[0].clientY - startY;
      if (dist <= 0) { setH(0); return; }
      const damp = Math.min(TH, dist * 0.45);
      setH(damp);
      const ok = damp >= TH * 0.8;
      holder.classList.toggle('ready', ok);
      holder.querySelector('.pull-txt').textContent = ok ? '松开刷新' : '下拉刷新';
    }, { passive: true });
    scroller.addEventListener('touchend', function () {
      if (!pulling) return;
      pulling = false;
      if (dist * 0.45 >= TH * 0.8 && !busy) {
        busy = true;
        setH(48);
        holder.classList.remove('ready');
        holder.classList.add('busy');
        holder.querySelector('.pull-txt').textContent = '正在刷新…';
        haptic('light');
        Promise.resolve(onRefresh()).then(done, done);
      } else { setH(0); }
      function done() {
        setH(0);
        holder.classList.remove('busy');
        holder.querySelector('.pull-txt').textContent = '下拉刷新';
        busy = false;
      }
    });
  }

  /* ============================== 动效原语 ============================== */
  /* 进度环：靠 CSS 变量 --p 驱动 conic-gradient，比 SVG 动画省电 */
  function ring(pct, opt) {
    opt = opt || {};
    const v = Math.max(0, Math.min(100, Number(pct) || 0));
    const size = opt.size || 76;
    const tone = opt.tone !== undefined ? opt.tone : (v >= 75 ? 'ok' : (v >= 45 ? '' : 'bad'));
    const el = h('div.ring' + (tone ? '.' + tone : '') + (opt.thin ? '.thin' : ''),
      { style: { width: size + 'px', height: size + 'px', '--p': 0 } },
      h('div.ring-in', null,
        opt.icon ? h('span.ring-ico', null, icon(opt.icon, { size: Math.round(size * 0.26) })) : null,
        h('b', { text: opt.text === undefined ? String(Math.round(v)) : opt.text }),
        opt.label ? h('small', { text: opt.label }) : null));
    if (reduceMotion()) el.style.setProperty('--p', String(v));
    else requestAnimationFrame(function () { requestAnimationFrame(function () {
      el.style.setProperty('--p', String(v));
    }); });
    return el;
  }

  function bar(pct, tone) {
    const v = Math.max(0, Math.min(100, Number(pct) || 0));
    const fill = h('div.bar-fill' + (tone ? '.' + tone : ''), { style: { width: '0%' } });
    const el = h('div.bar' + (tone ? '.' + tone : ''), null, fill);
    if (reduceMotion()) fill.style.width = v + '%';
    else requestAnimationFrame(function () { requestAnimationFrame(function () {
      fill.style.width = v + '%';
    }); });
    return el;
  }

  function chip(text, tone, iconName) {
    return h('span.chip' + (tone ? '.' + tone : ''), null,
      iconName ? icon(iconName, { size: 13, w: 2 }) : null, h('span', { text: text }));
  }

  /* 数字滚动：KPI 从 0 涨上去，比直接蹦出来舒服 */
  function countUp(node, to) {
    if (!node || reduceMotion() || !isFinite(to) || to <= 0) return;
    const dur = 660, t0 = performance.now();
    (function step(t) {
      const k = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      node.nodeValue = String(Math.round(to * e));
      if (k < 1) requestAnimationFrame(step); else node.nodeValue = String(to);
    })(t0);
  }
  function countNode(v) {
    const t = document.createTextNode(String(v === null || v === undefined ? '' : v));
    if (typeof v === 'number' && isFinite(v) && v > 0) countUp(t, v);
    return t;
  }

  /* 点击涟漪：给按钮一点「水面」手感 */
  function ripple(e) {
    const el = e && e.currentTarget;
    if (!el || reduceMotion()) return;
    const r = el.getBoundingClientRect();
    const t = (e.touches && e.touches[0]) || e;
    const d = Math.max(r.width, r.height) * 1.4;
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    const ink = h('span.ripple', { style: {
      left: ((t.clientX || (r.left + r.width / 2)) - r.left - d / 2) + 'px',
      top: ((t.clientY || (r.top + r.height / 2)) - r.top - d / 2) + 'px',
      width: d + 'px', height: d + 'px',
    } });
    el.appendChild(ink);
    setTimeout(function () { if (ink.parentNode) ink.parentNode.removeChild(ink); }, 620);
  }

  function skeleton(rows) {
    const box = h('div.skel-card');
    for (let i = 0; i < (rows || 3); i++) box.appendChild(h('div.skel-line'));
    return box;
  }

  /* ============================== 格式化 ============================== */
  function fmtNum(n) {
    n = Number(n || 0);
    if (!isFinite(n)) return '0';
    if (n >= 100000000) return (n / 100000000).toFixed(2) + '亿';
    if (n >= 10000) return (n / 10000).toFixed(n >= 1000000 ? 0 : 1) + '万';
    return n.toLocaleString('zh-CN');
  }
  function fmtWords(n) {
    n = Number(n || 0);
    if (n >= 10000) return (n / 10000).toFixed(n >= 100000 ? 0 : 1) + ' 万字';
    return n + ' 字';
  }
  function fmtDur(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    if (sec < 60) return sec + ' 秒';
    const m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60) return m + ' 分' + (s ? ' ' + s + ' 秒' : '');
    return Math.floor(m / 60) + ' 时 ' + (m % 60) + ' 分';
  }
  function fmtDate(s) {
    if (!s) return '—';
    const d = new Date(String(s).replace(' ', 'T'));
    if (isNaN(d.getTime())) return String(s).slice(0, 16);
    const p = function (x) { return (x < 10 ? '0' : '') + x; };
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function timeAgo(s) {
    if (!s) return '';
    const d = new Date(String(s).replace(' ', 'T'));
    if (isNaN(d.getTime())) return '';
    const sec = Math.floor((Date.now() - d.getTime()) / 1000);
    if (sec < 60) return '刚刚';
    if (sec < 3600) return Math.floor(sec / 60) + ' 分钟前';
    if (sec < 86400) return Math.floor(sec / 3600) + ' 小时前';
    if (sec < 86400 * 7) return Math.floor(sec / 86400) + ' 天前';
    return String(s).slice(5, 10);
  }
  function debounce(fn, wait) {
    let t = null;
    return function () {
      const a = arguments, self = this;
      if (t) clearTimeout(t);
      t = setTimeout(function () { t = null; fn.apply(self, a); }, wait);
    };
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ============================== 状态块 ============================== */
  function emptyBox(iconName, title, sub) {
    return h('div.empty', null,
      h('div.em-ico', null, (typeof iconName === 'string' && ICONS[iconName]) ? icon(iconName, { size: 30, w: 1.5 }) : iconName),
      h('div.em-t', { text: title || '暂无内容' }),
      sub ? h('div.em-s', { text: sub }) : null);
  }
  function loadingBox(text) {
    return h('div.empty', null,
      h('div.spinner'), h('div.em-s.mt12', { text: text || '加载中…' }));
  }
  function errBox(err, retry) {
    const b = h('div.empty', null,
      h('div.em-ico.warn', null, icon('bolt', { size: 28, w: 1.6 })),
      h('div.em-t', { text: '加载失败' }),
      h('div.em-s', { text: (err && err.message) || String(err) }));
    if (retry) {
      const btn = h('button.btn.mt16', { type: 'button', text: '重试' });
      btn.addEventListener('click', retry);
      b.appendChild(h('div.mt16', null, btn));
    }
    return b;
  }

  function setToken(v) {
    token = (v || '').trim();
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* 隐私模式下忽略 */ }
    try {
      document.cookie = 'mz_token=' + encodeURIComponent(token) + '; path=/; max-age=31536000; SameSite=Lax';
    } catch (e) { /* cookie 写不了不影响主流程 */ }
  }
  function getToken() { return token; }

  return {
    api: api, ApiError: ApiError, req: req, VERSION: VERSION,
    h: h, frag: frag, add: add, clear: clear, $: $, $$: $$,
    icon: icon, brand: brand, ICONS: ICONS,
    haptic: haptic, toast: toast, sheet: sheet, actions: actions, modal: modal, confirm: confirm,
    attachPull: attachPull, ripple: ripple, skeleton: skeleton,
    ring: ring, bar: bar, chip: chip, countNode: countNode, countUp: countUp,
    fmtNum: fmtNum, fmtWords: fmtWords, fmtDur: fmtDur, fmtDate: fmtDate, timeAgo: timeAgo,
    debounce: debounce, sleep: sleep, reduceMotion: reduceMotion,
    emptyBox: emptyBox, loadingBox: loadingBox, errBox: errBox,
    setToken: setToken, getToken: getToken,
    url: url, img: img, authHeaders: authHeaders, setSession: setSession, logout: logout, CLOUD: CLOUD,
    online: true,
  };
})();
