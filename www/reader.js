/* ==========================================================================
   墨舟移动端 · 沉浸阅读器  reader.js  v1
   --------------------------------------------------------------------------
   多看阅读那种「读」的界面，专门用来读书稿，不写作：

     · 点屏幕中间 —— 顶部 / 底部菜单淡入淡出（菜单在的时候，点哪儿都是收起）
     · 点左边 1/3 —— 上一章；点右边 1/3 —— 下一章
     · 上下滑 —— 正文跟着走；滑到章末再往上滑，自动进下一章
     · 顶部那条细线 —— 全书读到哪了；底部那条 —— 按住拖动跳章
     · 阅读设置 —— 字号 / 行距 / 背景（纸白·米黄·护眼·深灰·纯黑）/ 字体
     · 读到哪儿按书记着，下次点「继续阅读」接着看；进度还会同步到账号（换手机也在）
     · 长按正文里的句子 —— 划线 / 写想法，攒在「更多 → 摘录本」里

   对外只暴露 window.MZReader：
     MZReader.open(nid, cid?, opt?)   打开；不传 cid 就接着上次读的地方
     MZReader.resume(nid)             接着上次读
     MZReader.last(nid)               上次读到的位置 {cid, idx, label, ratio}
     MZReader.isOpen()                阅读器是不是开着

   这一层是 fixed 全屏覆盖：压住写作台（55），低于全局任务条（60）和弹窗（150）。
   ========================================================================== */
'use strict';

window.MZReader = (function () {
  const { h, clear, api, toast, sheet, actions, haptic, icon, chip, fmtNum } = MZ;
  const A = window.MZApp;

  /* ============================== 这台设备上的阅读偏好 ============================== */
  const FS_KEY = 'mz_rd_fs', LH_KEY = 'mz_rd_lh', BG_KEY = 'mz_rd_bg', FT_KEY = 'mz_rd_font';
  const POS_KEY = 'mz_rd_pos', HINT_KEY = 'mz_rd_hint', MK_KEY = 'mz_rd_marks';
  const FS_STEPS = [16, 17, 18, 19, 20, 21, 22, 24, 26];
  const LH_STEPS = [1.55, 1.7, 1.85, 2.0, 2.15, 2.35];
  const FONTS = [
    { key: 'song', name: '宋体', css: '"Songti SC","Source Han Serif SC","Noto Serif SC",Georgia,serif' },
    { key: 'hei', name: '黑体', css: '"PingFang SC","Helvetica Neue","Source Han Sans SC",system-ui,sans-serif' },
    { key: 'kai', name: '楷体', css: '"Kaiti SC","STKaiti","KaiTi","Songti SC",serif' },
  ];
  const BGS = [
    { key: 'paper', name: '纸白', bg: '#f7f6f2', fg: '#22222a', dim: '#8b8b91' },
    { key: 'sepia', name: '米黄', bg: '#f4ead6', fg: '#3b3226', dim: '#8d8272' },
    { key: 'green', name: '护眼', bg: '#e2ebdc', fg: '#232f24', dim: '#78876f' },
    { key: 'night', name: '深灰', bg: '#26282d', fg: '#c6c9cf', dim: '#82868f' },
    { key: 'black', name: '纯黑', bg: '#0a0a0b', fg: '#9aa0a6', dim: '#5f646c' },
  ];

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 忽略 */ } }
  function readNum(k, def) { const v = parseFloat(lsGet(k)); return isFinite(v) && v > 0 ? v : def; }
  function prefs() {
    let bg = BGS[0], ft = FONTS[0];
    for (let i = 0; i < BGS.length; i++) if (BGS[i].key === lsGet(BG_KEY)) bg = BGS[i];
    for (let i = 0; i < FONTS.length; i++) if (FONTS[i].key === lsGet(FT_KEY)) ft = FONTS[i];
    return { fs: readNum(FS_KEY, 18), lh: readNum(LH_KEY, 1.85), bg: bg, ft: ft };
  }
  function writeNum(k, v) { lsSet(k, String(v)); }
  function stepIn(list, cur, d) {
    let i = 0, best = Infinity;
    for (let k = 0; k < list.length; k++) {
      const gap = Math.abs(list[k] - cur);
      if (gap < best) { best = gap; i = k; }
    }
    i = Math.max(0, Math.min(list.length - 1, i + d));
    return list[i];
  }

  /* 阅读位置：{ 书 id: {cid, idx, title, ratio, ts} }，只记在这台设备上 */
  function readPos() {
    try { const o = JSON.parse(lsGet(POS_KEY) || '{}'); return (o && typeof o === 'object') ? o : {}; }
    catch (e) { return {}; }
  }
  function lastPos(nid) {
    const p = readPos()[String(nid)];
    return (p && p.cid) ? p : null;
  }
  function writePos(nid, p) {
    const o = readPos();
    o[String(nid)] = p;
    const keys = Object.keys(o).sort(function (a, b) { return (o[b].ts || 0) - (o[a].ts || 0); });
    keys.slice(40).forEach(function (k) { delete o[k]; });
    lsSet(POS_KEY, JSON.stringify(o));
  }

  /* 摘录本：本机一份（没网也能翻），云端一份（换手机也在）。
     一条 = {id, nid, cid, idx, title, pi, text, note, ratio, ts} */
  function readMarks(nid) {
    try {
      const o = JSON.parse(lsGet(MK_KEY) || '{}');
      const a = o && o[String(nid)];
      return Array.isArray(a) ? a : [];
    } catch (e) { return []; }
  }
  function writeMarks(nid, list) {
    let o = {};
    try { o = JSON.parse(lsGet(MK_KEY) || '{}') || {}; } catch (e) { o = {}; }
    o[String(nid)] = (list || []).slice(-300);
    const keys = Object.keys(o);
    if (keys.length > 40) {
      /* 只留最近 40 本，别把 localStorage 撑爆 */
      keys.sort(function (a, b) {
        const la = o[a] && o[a].length ? (o[a][o[a].length - 1].ts || 0) : 0;
        const lb = o[b] && o[b].length ? (o[b][o[b].length - 1].ts || 0) : 0;
        return lb - la;
      }).slice(40).forEach(function (k) { delete o[k]; });
    }
    lsSet(MK_KEY, JSON.stringify(o));
  }

  /* ============================== 正文排版 ============================== */
  /* 切段：先按换行切；整章糊成一整段（没换行）时，按句号断行 —— 手机上读着才不累。 */
  function splitParas(text) {
    const src = String(text || '').replace(/\r\n?/g, '\n').replace(/\u3000/g, ' ').trim();
    if (!src) return [];
    let parts = src.split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (parts.length <= 1 && src.length > 220) {
      const one = parts[0] || src;
      const out = [];
      let buf = '';
      for (let i = 0; i < one.length; i++) {
        const ch = one.charAt(i);
        buf += ch;
        if (buf.length >= 104 && /[。！？…”』」]/.test(ch)) { out.push(buf.trim()); buf = ''; }
      }
      if (buf.trim()) out.push(buf.trim());
      if (out.length > 1) parts = out;
    }
    return parts;
  }
  function readMinute(chars) { return Math.max(1, Math.round((Number(chars) || 0) / 430)); }

  /* ============================== 状态 ============================== */
  let rd = null;                 /* 当前打开着的阅读器；关掉就是 null */
  const cache = {};              /* 章 id -> {content, title, idx}，翻回来不用再请求 */
  /* ============================== 开关 ============================== */
  function isOpen() { return !!rd; }

  async function open(nid, cid, opt) {
    opt = opt || {};
    nid = Number(nid);
    if (rd && rd.nid === nid) {
      /* 已经开着这本书：要么换章，要么把菜单叫出来 */
      if (cid) await gotoCid(Number(cid));
      else setUI(true);
      return;
    }
    if (rd) close(true);
    if (!A.state.novels || !A.state.novels.length) { try { await A.loadHero(); } catch (e) { /* 离线也照读 */ } }
    build(nid);
    await boot(nid, cid ? Number(cid) : null, opt);
  }
  function resume(nid) { return open(nid); }

  function close(silent) {
    if (!rd) return;
    saveNow();
    pushPos(true);              /* 退出这一刻的进度一定上报 */
    const w = rd.wrap;
    if (rd.hideT) clearTimeout(rd.hideT);
    if (rd.saveT) clearTimeout(rd.saveT);
    if (rd.pushTimer) clearTimeout(rd.pushTimer);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onResize);
    rd = null;
    document.body.style.overflow = '';
    document.documentElement.style.removeProperty('--dock-bottom');
    if (w && w.parentNode) w.parentNode.removeChild(w);
    if (!silent) haptic('light');
    /* 底下那一屏是进页面时画好的：读完回来，「继续阅读 · 第 N 章」得跟着变。
       keepScroll = 原样重画，滚动位置不动，不会又跳回页首。 */
    if (!silent && A && A.render) { try { A.render({ keepScroll: true }); } catch (e) { /* 忽略 */ } }
  }

  /* ============================== 骨架 ============================== */
  function build(nid) {
    const wrap = h('div.rd-wrap');

    /* 顶部细线：全书进度（只做指示，不给拖） */
    const prog = h('div.rd-prog', null, h('i'));

    /* 正文 */
    const view = h('div.rd-view');
    const page = h('div.rd-page');
    view.appendChild(page);

    /* 顶栏 */
    const navTitle = h('div.rd-navt');
    const back = h('button.rd-ic', { type: 'button', 'aria-label': '返回' }, icon('back', { size: 20 }));
    const more = h('button.rd-ic', { type: 'button', 'aria-label': '更多' }, icon('more', { size: 20 }));
    const top = h('div.rd-top', null, h('div.rd-row', null, back, navTitle, more));

    /* 底栏：进度条 + 四个动作 */
    const stat = h('div.rd-stat');
    const lineFill = h('div.rd-linefill');
    const knob = h('div.rd-knob');
    const track = h('div.rd-track', { role: 'slider', 'aria-label': '全书进度' },
      h('div.rd-line'), lineFill, knob);
    const prev = h('button.rd-tool', { type: 'button' }, h('span.rd-ti', null, icon('back', { size: 18 })), h('span', { text: '上一章' }));
    const next = h('button.rd-tool', { type: 'button' }, h('span.rd-ti', null, icon('fwd', { size: 18 })), h('span', { text: '下一章' }));
    const dirB = h('button.rd-tool', { type: 'button' }, h('span.rd-ti', null, icon('layers', { size: 18 })), h('span', { text: '目录' }));
    const setB = h('button.rd-tool', { type: 'button' }, h('span.rd-ti', null, icon('sliders', { size: 18 })), h('span', { text: '设置' }));
    const bot = h('div.rd-bot', null, stat, track,
      h('div.rd-row.rd-tools', null, prev, dirB, setB, next));

    /* 首次进来的一句提示 */
    const hint = h('div.rd-hint', null,
      h('div.rd-hintbox', { text: '点中间出菜单 · 左右翻章 · 长按句子划线' }));

    wrap.appendChild(prog);
    wrap.appendChild(view);
    wrap.appendChild(top);
    wrap.appendChild(bot);
    wrap.appendChild(hint);
    document.body.appendChild(wrap);
    document.body.style.overflow = 'hidden';

    rd = {
      nid: nid, cid: 0, idx: 0, t: '', content: '', bookTitle: '',
      chList: [], chIdx: -1, restore: null,
      wrap: wrap, view: view, page: page, prog: prog.firstChild, stat: stat,
      lineFill: lineFill, knob: knob, track: track, navTitle: navTitle,
      el: { back: back, more: more, prev: prev, next: next, dir: dirB, set: setB, bot: bot },
      uiOn: true, rest: false, atBottom: false, lastAuto: 0, lastY: 0,
      hideT: 0, saveT: 0, pct: -1, drag: null,
    paras: [], marks: [], press: 0, pressAt: null, touched: false, pushT: 0, pushTimer: 0,
    posTs: 0,
  };
    applyPrefs();
    bind();
    setUI(true, true);
    syncDock();
  }

  /* ============================== 外观 ============================== */
  function applyPrefs() {
    if (!rd) return;
    const p = prefs();
    rd.wrap.style.setProperty('--rd-fs', p.fs + 'px');
    rd.wrap.style.setProperty('--rd-lh', String(p.lh));
    rd.wrap.style.setProperty('--rd-bg', p.bg.bg);
    rd.wrap.style.setProperty('--rd-fg', p.bg.fg);
    rd.wrap.style.setProperty('--rd-dim', p.bg.dim);
    rd.wrap.style.setProperty('--rd-font', p.ft.css);
  }

  /* 当前生效的底部安全区（app.js 会把 env() 读出来写进 --safe-b） */
  function safeBottom() {
    const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-b'));
    return isFinite(v) && v > 0 ? v : 0;
  }
  /* 任务条是 body 级的 fixed 条，抬到阅读器底栏上面，别把「目录 / 设置」盖住 */
  function syncDock() {
    if (!rd) return;
    const hgt = rd.el.bot.getBoundingClientRect().height || 0;
    /* 菜单收起来时底栏也没了，但底下还有一条 home 指示条：离底至少留出安全区，
       不然任务条会贴在屏幕最下沿（看着就是「位置过于靠下」）。 */
    const px = uiVisible() ? (hgt + 10) : Math.max(safeBottom() + 12, 14);
    document.documentElement.style.setProperty('--dock-bottom', Math.round(px) + 'px');
  }
  function onResize() { syncDock(); }

  /* ============================== 菜单显隐 ============================== */
  function setUI(on, init) {
    if (!rd) return;
    rd.uiOn = !!on;
    rd.wrap.classList.toggle('ui-on', !!on);
    if (rd.hideT) { clearTimeout(rd.hideT); rd.hideT = 0; }
    if (on) {
      syncDock();
      rd.hideT = setTimeout(function () { if (rd) setUI(false); }, init ? 3800 : 3200);
    }
  }
  function maybeHint() {
    if (lsGet(HINT_KEY)) return;
    lsSet(HINT_KEY, '1');
    rd.wrap.classList.add('hint-on');
    setTimeout(function () { if (rd) rd.wrap.classList.remove('hint-on'); }, 3400);
  }

  /* ============================== 事件 ============================== */
  function bind() {
    const e = rd.el, view = rd.view;

    e.back.addEventListener('click', function () { haptic('light'); close(false); });
    e.more.addEventListener('click', function () { haptic('light'); moreSheet(); });
    e.prev.addEventListener('click', function () { step(-1); });
    e.next.addEventListener('click', function () { step(1); });
    e.dir.addEventListener('click', function () { haptic('light'); dirSheet(); });
    e.set.addEventListener('click', function () { haptic('light'); setSheet(); });

    /* 点正文：左 1/3 上一章，右 1/3 下一章，中间出菜单。
       用 pointer 事件做「点」判定：滑动手势会被 pointercancel 掐掉，不会误翻章。 */
    let pt = null;
    view.addEventListener('pointerdown', function (ev) {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      if (rd) rd.touched = true;      /* 用户真的动手了，别再自动跳到云端的位置 */
      if (ev.target && ev.target.closest && ev.target.closest('a,button')) return;
      pt = { x: ev.clientX, y: ev.clientY, sx: view.scrollTop, t: Date.now(), moved: false };
    });
    view.addEventListener('pointermove', function (ev) {
      if (!pt || pt.moved) return;
      if (Math.abs(ev.clientX - pt.x) > 10 || Math.abs(ev.clientY - pt.y) > 10) pt.moved = true;
    });
    view.addEventListener('pointerup', function (ev) {
      const p = pt; pt = null;
      if (!p || p.moved || Date.now() - p.t > 520) return;
      if (Math.abs(view.scrollTop - p.sx) > 6) return;
      tap(ev.clientX);
    });
    view.addEventListener('pointercancel', function () { pt = null; });

    /* 长按正文里的句子：划线 / 写想法。
       没用系统那套文字选择 —— 手机上跟翻页手势老打架，各家壳里表现也不一样。 */
    view.addEventListener('pointerdown', function (ev) {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      const p = ev.target && ev.target.closest ? ev.target.closest('.rd-text p') : null;
      if (!p || !rd) return;
      if (rd.press) clearTimeout(rd.press);
      rd.pressAt = { x: ev.clientX, y: ev.clientY, el: p };
      rd.press = setTimeout(function () {
        rd.press = 0;
        const at = rd.pressAt;
        rd.pressAt = null;
        if (!at || !rd) return;
        haptic('medium');
        markSheet(at.el);
      }, 560);
    });
    view.addEventListener('pointermove', function (ev) {
      if (!rd || !rd.press || !rd.pressAt) return;
      if (Math.abs(ev.clientX - rd.pressAt.x) > 8 || Math.abs(ev.clientY - rd.pressAt.y) > 8) {
        clearTimeout(rd.press);
        rd.press = 0;
        rd.pressAt = null;
      }
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (name) {
      view.addEventListener(name, function () {
        if (rd && rd.press) { clearTimeout(rd.press); rd.press = 0; rd.pressAt = null; }
      });
    });
    /* 电脑上右键 = 长按，调试 / 桌面壳都方便 */
    view.addEventListener('contextmenu', function (ev) {
      const p = ev.target && ev.target.closest ? ev.target.closest('.rd-text p') : null;
      if (!p || !rd) return;
      ev.preventDefault();
      haptic('medium');
      markSheet(p);
    });

    /* 滚动：进度条、记位置、章末越界翻章 */
    view.addEventListener('scroll', function () {
      if (!rd) return;
      const br = bookRatio();
      rd.prog.style.width = (br * 100).toFixed(2) + '%';
      const pc = Math.round(br * 100);
      if (pc !== rd.pct) { rd.pct = pc; paintStat(); }
      syncBottom();
      if (!rd.rest) schedSave();   /* touched 只看真正的手势，见下面的 pointerdown */
    }, { passive: true });

    view.addEventListener('touchstart', function (ev) {
      if (rd) rd.touched = true;
      if (ev.touches.length === 1) rd.lastY = ev.touches[0].clientY;
    }, { passive: true });
    view.addEventListener('touchmove', function (ev) {
      if (!rd || ev.touches.length !== 1) return;
      const y = ev.touches[0].clientY;
      if (rd.atBottom && y < rd.lastY - 3) autoNext();
      rd.lastY = y;
      if (uiVisible()) setUI(false);
    }, { passive: true });
    view.addEventListener('wheel', function (ev) {
      if (!rd) return;
      rd.touched = true;
      if (rd.atBottom && ev.deltaY > 0) autoNext();
      if (uiVisible() && Math.abs(ev.deltaY) > 2) setUI(false);
    }, { passive: true });

    /* 拖动底部进度条跳章 */
    e.bot.addEventListener('pointerdown', function (ev) {
      if (!rd || !rd.track.contains(ev.target)) return;
      rd.drag = true;
      try { e.bot.setPointerCapture(ev.pointerId); } catch (err) { /* 忽略 */ }
      paintTrack(ev.clientX);
    });
    e.bot.addEventListener('pointermove', function (ev) { if (rd && rd.drag) paintTrack(ev.clientX); });
    e.bot.addEventListener('pointerup', function (ev) {
      if (!rd || !rd.drag) return;
      rd.drag = false;
      const i = trackIdx(ev.clientX);
      if (i >= 0) gotoIdx(i);
    });
    e.bot.addEventListener('pointercancel', function () { if (rd) rd.drag = false; });

    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
  }

  /* 菜单是不是露着：以 DOM 上的类为准（setUI 里类跟内部状态一起翻） */
  function uiVisible() { return !!(rd && rd.wrap.classList.contains('ui-on')); }
  function tap(x) {
    if (!rd) return;
    if (uiVisible()) { setUI(false); return; }
    const r = rd.view.getBoundingClientRect();
    const t = (x - r.left) / Math.max(1, r.width);
    if (t < 0.28) step(-1);
    else if (t > 0.72) step(1);
    else setUI(true);
  }

  /* ============================== 章末自动翻章 ============================== */
  function autoNext() {
    if (rd.chIdx < 0 || rd.chIdx >= rd.chList.length - 1) return;
    const now = Date.now();
    if (now - rd.lastAuto < 1300) return;
    rd.lastAuto = now;
    step(1);
  }

  /* ============================== 进度 / 记位置 ============================== */
  /* 是不是滚到章末了。短到一屏放得下的章，一进来就该算「到底」——
     否则这种章永远触发不了「再往上滑进下一章」。 */
  function syncBottom() {
    if (!rd) return;
    const v = rd.view;
    rd.atBottom = v.scrollTop + v.clientHeight >= v.scrollHeight - 4;
  }
  function chapterRatio() {
    if (!rd) return 0;
    const v = rd.view, max = v.scrollHeight - v.clientHeight;
    if (max <= 2) return 1;
    return Math.max(0, Math.min(1, v.scrollTop / max));
  }
  function bookRatio() {
    if (!rd || !rd.chList.length) return 0;
    const n = rd.chList.length;
    return Math.max(0, Math.min(1, (Math.max(0, rd.chIdx) + chapterRatio()) / n));
  }
  function saveNow() {
    if (!rd || !rd.cid) return;
    if (rd.touched) rd.posTs = Date.now();      /* 用户真读到这儿了，时间戳才算新的 */
    writePos(rd.nid, { cid: rd.cid, idx: rd.idx, title: rd.t || '',
                       ratio: chapterRatio(), ts: rd.posTs || Date.now() });
    pushPos(false);
  }
  function schedSave() {
    if (rd.saveT) clearTimeout(rd.saveT);
    rd.saveT = setTimeout(function () { if (rd) saveNow(); }, 600);
  }

  /* 云端进度：拉一份（换手机就靠它），比本机新才认 */
  async function pullPos(nid) {
    if (!MZ.reading || !MZ.reading.pos) return null;
    let d = null;
    try { d = await MZ.reading.pos(nid); } catch (e) { return null; }
    const p = d && d.pos;
    if (!p || !p.cid) return null;
    const mine = lastPos(nid);
    if (mine && (mine.ts || 0) >= (p.ts || 0)) return null;
    writePos(nid, p);
    return p;
  }
  /* 上报进度：滚动时最多 12 秒一次（翻章 / 退出会 force 立刻报） */
  function pushPos(force) {
    if (!rd || !rd.cid || !MZ.reading || !MZ.reading.putPos) return;
    const now = Date.now();
    if (!force && now - rd.pushT < 12000) {
      if (!rd.pushTimer) {
        rd.pushTimer = setTimeout(function () {
          if (!rd) return;
          rd.pushTimer = 0;
          pushPos(true);
        }, 12000);
      }
      return;
    }
    rd.pushT = now;
    if (rd.pushTimer) { clearTimeout(rd.pushTimer); rd.pushTimer = 0; }
    try {
      const r = MZ.reading.putPos({ nid: rd.nid, cid: rd.cid, idx: rd.idx, title: rd.t || '',
                                    ratio: chapterRatio(), ts: rd.posTs || now });
      if (r && r.then) r.then(function () {}, function () {});
    } catch (e) { /* 没网就算了，本机那份还在 */ }
  }
  /* 本机有进度时也在后台跟云端对一次：别处读得更靠前就跳过去（用户还没动手才跳） */
  async function catchUp(nid, openedCid) {
    const p = await pullPos(nid);
    if (!rd || Number(rd.nid) !== Number(nid) || !p) return;
    if (Number(p.cid) === Number(openedCid) || rd.touched) return;
    const ch = findCid(p.cid);
    if (!ch) return;
    toast('已同步到你在别处读到的地方', 'ok');
    rd.posTs = p.ts || 0;
    await showChapter(ch, p.ratio || 0);
  }
  function last(nid) {
    const p = lastPos(nid);
    if (!p) return null;
    return {
      cid: p.cid, idx: p.idx || 0, title: p.title || '', ratio: p.ratio || 0,
      label: '第 ' + (p.idx || '?') + ' 章' + (p.title ? ' ' + p.title : ''),
    };
  }
  function trackIdx(clientX) {
    if (!rd || !rd.chList.length) return -1;
    const r = rd.track.getBoundingClientRect();
    const t = (clientX - r.left) / Math.max(1, r.width);
    return Math.max(0, Math.min(rd.chList.length - 1, Math.floor(t * rd.chList.length)));
  }
  function paintTrack(clientX) {
    const i = trackIdx(clientX);
    if (i < 0) return;
    const t = rd.chList.length ? (i + 0.5) / rd.chList.length : 0;
    rd.lineFill.style.width = (t * 100) + '%';
    rd.knob.style.left = (t * 100) + '%';
    rd.stat.textContent = '拖到 第 ' + rd.chList[i].idx + ' 章 / 共 ' + rd.chList.length + ' 章';
  }
  function paintStat() {
    if (!rd) return;
    const total = rd.chList.length;
    if (!total) { rd.stat.textContent = ''; return; }
    const br = Math.round(bookRatio() * 100);
    rd.stat.textContent = '第 ' + rd.idx + ' 章 / 共 ' + total + ' 章 · 全书 ' + br + '%';
  }
  function paintNavTitle() {
    if (!rd) return;
    clear(rd.navTitle);
    rd.navTitle.appendChild(h('b', { text: rd.bookTitle || '阅读' }));
    rd.navTitle.appendChild(h('span', {
      text: rd.chList.length ? ('第 ' + rd.idx + ' 章 / 共 ' + rd.chList.length + ' 章') : '—',
    }));
  }
  /* ============================== 载入 ============================== */
  async function boot(nid, cid, opt) {
    const n = A.findNovel(nid) || {};
    rd.bookTitle = n.title || opt.book || '';
    paintNavTitle();
    paintEmpty2('正在打开…');
    try {
      const r = await api.get('/api/novel/' + nid + '/chapters');
      rd.chList = ((r && r.chapters) || []).slice().sort(function (a, b) { return (a.idx || 0) - (b.idx || 0); });
    } catch (e) { rd.chList = []; }
    if (!rd) return;
    if (!rd.chList.length) {
      paintEmpty('这本书还没有章节', '去「写作 → 补更」让模型写第一章，写完再回来读。');
      paintNavTitle(); paintStat();
      return;
    }
    let use = cid ? findCid(cid) : null;
    const local = use ? null : lastPos(nid);
    if (!use && local) { use = findCid(local.cid); if (use) rd.restore = local; }
    if (!use) {
      /* 本机没有进度：多半是换了台手机，云端那份才是真的 */
      const cloud = await pullPos(nid);
      if (!rd) return;
      if (cloud) { use = findCid(cloud.cid); if (use) rd.restore = cloud; }
    }
    if (!use) use = rd.chList[0];
    maybeHint();
    loadMarks(nid);
    /* 打开时先把「这条进度是什么时候读到的」定下来：没动过手就沿用原来那条的时间戳，
       别拿 now 去把别的设备刚读到的位置冲掉。 */
    rd.posTs = cid ? Date.now() : ((rd.restore && rd.restore.ts) || 0);
    await showChapter(use, rd.restore ? rd.restore.ratio : 0);
    if (!cid && local) catchUp(nid, use.id);
  }

  function findCid(cid) {
    for (let i = 0; i < rd.chList.length; i++) if (Number(rd.chList[i].id) === Number(cid)) return rd.chList[i];
    return null;
  }

  async function showChapter(ch, ratio) {
    if (!rd || !ch) return;
    const want = Number(ch.id);
    rd.cid = want;
    rd.idx = ch.idx || 0;
    rd.t = ch.title || '';
    rd.chIdx = -1;
    for (let i = 0; i < rd.chList.length; i++) if (Number(rd.chList[i].id) === want) { rd.chIdx = i; break; }
    paintNavTitle();
    paintStat();
    const hit = cache[want];
    if (hit) { rd.content = String(hit.content || ''); if (hit.title) rd.t = hit.title; paintBody(false); restoreScroll(ratio); prefetch(rd.chIdx + 1); pushPos(true); return; }

    paintEmpty2('正在取这一章…');
    let c = null;
    try { const d = await api.get('/api/chapter/' + want); c = (d && d.chapter) || null; }
    catch (e) { c = null; }
    if (!rd || rd.cid !== want) return;
    if (!c) {
      paintEmpty('这一章没读出来', '网不太顺？点一下重试。', function () { showChapter(ch, ratio); });
      return;
    }
    cache[want] = c;
    rd.content = String(c.content || '');
    if (c.title) rd.t = c.title;
    if (c.idx) rd.idx = c.idx;
    paintNavTitle();
    paintStat();
    paintBody(true);
    restoreScroll(ratio);
    prefetch(rd.chIdx + 1);
    pushPos(true);
  }

  function paintBody(anim) {
    if (!rd) return;
    const page = rd.page;
    clear(page);
    const chars = rd.content.length;
    page.appendChild(h('div.rd-chhead', null,
      h('div.rd-chtitle', { text: '第 ' + rd.idx + ' 章' }),
      h('h1.rd-cname', { text: rd.t || '（无标题）' }),
      h('div.rd-chmeta', { text: fmtNum(chars) + ' 字 · 读完约 ' + readMinute(chars) + ' 分钟' })));
    const txt = h('div.rd-text');
    const paras = splitParas(rd.content);
    rd.paras = paras;
    if (!paras.length) txt.appendChild(h('div.rd-blank', { text: '这一章还没有正文。' }));
    const marks = markTexts();
    paras.forEach(function (p, i) {
      const el = h('p', { dataset: { idx: String(i) } });
      renderPara(el, p, marks);
      txt.appendChild(el);
    });
    page.appendChild(txt);
    page.appendChild(endCard());
    page.appendChild(h('div.rd-footpad'));
    if (anim) flick();
  }

  /* 章末那张卡：读完就往下点，不用退出去找目录 */
  function endCard() {
    const lastOne = rd.chList.length ? rd.chIdx >= rd.chList.length - 1 : true;
    const box = h('div.rd-endcard');
    box.appendChild(h('div.rd-et', { text: '第 ' + rd.idx + ' 章 · 读完' }));
    const acts = h('div.rd-endacts');
    const p = h('button.rd-btn', { type: 'button', text: '上一章' });
    p.addEventListener('click', function () { step(-1); });
    if (rd.chIdx <= 0) p.setAttribute('disabled', '');
    acts.appendChild(p);
    if (lastOne) {
      box.appendChild(h('div.rd-es', { text: '这是最新一章了。回书架点「补更」，让 AI 接着写。' }));
      const b = h('button.rd-btn.pri', { type: 'button', text: '回书架' });
      b.addEventListener('click', function () { haptic('light'); close(false); });
      acts.appendChild(b);
    } else {
      const n = h('button.rd-btn.pri', { type: 'button', text: '下一章' });
      n.addEventListener('click', function () { step(1); });
      acts.appendChild(n);
    }
    box.appendChild(acts);
    box.appendChild(h('div.rd-es', { text: uiVisible() ? '往上滑也能接着读下一章' : '点两下屏幕中间能叫出菜单' }));
    return box;
  }

  function flick() {
    if (!rd) return;
    const p = rd.page;
    p.style.transition = 'none';
    p.style.opacity = '.3';
    requestAnimationFrame(function () {
      if (!rd) return;
      p.style.transition = 'opacity .18s var(--spring)';
      p.style.opacity = '1';
    });
  }

  function restoreScroll(ratio) {
    if (!rd) return;
    rd.rest = true;
    const view = rd.view;
    const apply = function () {
      if (!rd) return;
      const max = view.scrollHeight - view.clientHeight;
      view.scrollTop = ratio > 0 ? Math.round(Math.max(0, max) * ratio) : 0;
    };
    apply();
    requestAnimationFrame(function () {
      apply();
      requestAnimationFrame(function () {
        apply();
        syncBottom();
        rd.rest = false;
        rd.prog.style.width = (bookRatio() * 100).toFixed(2) + '%';
        rd.pct = Math.round(bookRatio() * 100);
        paintStat();
      });
    });
  }

  function prefetch(i) {
    if (!rd || i < 0 || i >= rd.chList.length) return;
    const id = Number(rd.chList[i].id);
    if (cache[id]) return;
    api.get('/api/chapter/' + id).then(function (d) {
      const c = d && d.chapter;
      if (c && c.id) cache[Number(c.id)] = c;
    }, function () { /* 预取失败没关系，真翻过去时再请求一次 */ });
  }

  /* ============================== 翻章 ============================== */
  async function gotoIdx(i) {
    if (!rd || !rd.chList.length) return;
    rd.touched = true;
    rd.posTs = Date.now();
    if (i < 0) { toast('已经是第一章了', 'warn'); return; }
    if (i >= rd.chList.length) {
      const lastOne = rd.chList[rd.chList.length - 1];
      saveNow();
      toast('已经是最后一章了（第 ' + (lastOne ? lastOne.idx : '') + ' 章）', 'warn');
      return;
    }
    rd.restore = null;
    haptic('light');
    await showChapter(rd.chList[i], 0);
  }
  function step(d) { if (rd) gotoIdx(rd.chIdx + d); }
  function gotoCid(cid) {
    const ch = findCid(cid);
    return ch ? gotoIdx(rd.chList.indexOf(ch)) : null;
  }

  /* ============================== 空态 ============================== */
  function paintEmpty2(msg) {
    if (!rd) return;
    clear(rd.page);
    rd.page.appendChild(h('div.rd-blank', null,
      h('div.rd-spin', null, h('span.spinner.lg')),
      h('div.rd-blankmsg', { text: msg || '正在载入…' })));
  }
  function paintEmpty(title, sub, retry) {
    if (!rd) return;
    clear(rd.page);
    const box = h('div.rd-blank');
    box.appendChild(h('div.rd-blankt', { text: title }));
    if (sub) box.appendChild(h('div.rd-blankmsg', { text: sub }));
    if (retry) {
      const b = h('button.rd-btn.pri', { type: 'button', text: '重试' });
      b.addEventListener('click', function () { haptic('light'); retry(); });
      const wrap = h('div.rd-endacts');
      wrap.appendChild(b);
      box.appendChild(wrap);
    }
    rd.page.appendChild(box);
  }
  /* ============================== 目录 ============================== */
  function dirSheet() {
    if (!rd) return;
    const all = rd.chList;
    const box = h('div');
    const kw = h('input.inp', { type: 'search', placeholder: '输入章号或标题…', spellcheck: 'false' });
    const lb = h('div.list');
    const foot = h('div.footnote.txt-c');
    let limit = 80, sh = null;
    function paint() {
      const k = (kw.value || '').trim().toLowerCase();
      clear(lb);
      const hits = k ? all.filter(function (c) {
        return String(c.idx).indexOf(k) >= 0 || String(c.title || '').toLowerCase().indexOf(k) >= 0;
      }) : all;
      if (!hits.length) { lb.appendChild(h('div.small.muted.center', { text: '没找到「' + k + '」' })); foot.textContent = ''; return; }
      hits.slice(0, limit).forEach(function (c) {
        lb.appendChild(A.li({
          title: '第 ' + c.idx + ' 章　' + (c.title || ''),
          sub: fmtNum(c.chars || 0) + ' 字' + (c.updated_at ? ' · ' + MZ.timeAgo(c.updated_at) : ''),
          right: Number(c.id) === Number(rd && rd.cid) ? chip('正在读', 'ok') : null,
          onTap: function () {
            const i = all.indexOf(c);
            if (sh) sh.close();
            gotoIdx(i);
          },
        }));
      });
      foot.textContent = hits.length > limit ? '还有 ' + (hits.length - limit) + ' 章，搜章号更快' : '';
    }
    kw.addEventListener('input', function () { limit = 80; paint(); });
    box.appendChild(kw);
    box.appendChild(h('div.mt8', null, lb));
    box.appendChild(foot);
    sh = sheet({ title: '目录 · 共 ' + all.length + ' 章', height: '78vh',
      build: function (b) { b.appendChild(box); paint(); } });
  }

  /* ============================== 阅读设置 ============================== */
  function setSheet() {
    if (!rd) return;
    const box = h('div');
    const fsChip = h('span.chip'), lhChip = h('span.chip');
    function paintChips() {
      const p = prefs();
      fsChip.textContent = p.fs + ' 号';
      lhChip.textContent = p.lh + ' 倍';
    }
    function bumpFs(d) { writeNum(FS_KEY, stepIn(FS_STEPS, prefs().fs, d)); applyPrefs(); paintChips(); haptic('light'); }
    function bumpLh(d) { writeNum(LH_KEY, stepIn(LH_STEPS, prefs().lh, d)); applyPrefs(); paintChips(); haptic('light'); }

    box.appendChild(h('div.card.tight', null,
      h('div.row', { style: { gap: '8px', alignItems: 'center' } },
        h('span.small.muted', { style: { flex: '0 0 auto', width: '42px' }, text: '字号' }),
        A._btn('小 A', '', function () { bumpFs(-1); }),
        A._btn('大 A', '', function () { bumpFs(1); }),
        h('span.sp'), fsChip),
      h('div.row', { style: { gap: '8px', alignItems: 'center', marginTop: '10px' } },
        h('span.small.muted', { style: { flex: '0 0 auto', width: '42px' }, text: '行距' }),
        A._btn('紧一点', '', function () { bumpLh(-1); }),
        A._btn('松一点', '', function () { bumpLh(1); }),
        h('span.sp'), lhChip)));

    /* 背景：一眼看出是什么纸 */
    const sw = h('div.rd-sw');
    function paintSw() {
      const cur = lsGet(BG_KEY) || 'paper';
      Array.prototype.forEach.call(sw.children, function (el) {
        el.classList.toggle('on', el.dataset.key === cur);
      });
    }
    BGS.forEach(function (b) {
      const el = h('button.rd-swatch', { type: 'button', 'aria-label': b.name, dataset: { key: b.key },
        style: { background: b.bg, color: b.fg, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.12)' } },
        h('span', { text: b.name }));
      el.addEventListener('click', function () { haptic('light'); lsSet(BG_KEY, b.key); applyPrefs(); paintSw(); });
      sw.appendChild(el);
    });
    box.appendChild(h('div.card.tight.mt12', null, h('div.small.muted.mb8', { text: '背景' }), sw));
    paintSw();

    /* 字体 */
    const seg = A.seg(FONTS.map(function (f) { return { key: f.key, label: f.name }; }), (lsGet(FT_KEY) || 'song'),
      function (k) {
        lsSet(FT_KEY, k);
        applyPrefs();
        Array.prototype.forEach.call(seg.children, function (b, i) { b.classList.toggle('on', FONTS[i].key === k); });
        haptic('light');
      });
    box.appendChild(h('div.card.tight.mt12', null, h('div.small.muted.mb8', { text: '字体' }), seg));

    box.appendChild(h('div.mt12', null, A.buttons([{ label: '恢复默认（18 号 / 1.85 倍 / 纸白 / 宋体）', onTap: function () {
      writeNum(FS_KEY, 18); writeNum(LH_KEY, 1.85); lsSet(BG_KEY, 'paper'); lsSet(FT_KEY, 'song');
      applyPrefs(); paintChips(); paintSw();
      Array.prototype.forEach.call(seg.children, function (b, i) { b.classList.toggle('on', FONTS[i].key === 'song'); });
      haptic('light');
    } }])));
    box.appendChild(h('div.footnote', { text: '阅读偏好只存在这台设备上，和写作台的字号行距是两套。' }));
    paintChips();
    sheet({ title: '阅读设置', build: function (b) { b.appendChild(box); } });
  }

  /* ============================== 划线 / 摘录 ============================== */
  /* 手机上不用系统那套文字选择：跟翻页手势老打架，各家壳里表现也不一样。
     改成「长按段落 → 挑一句」—— 落点清楚，也不误触。 */
  function cloudKey(m) { return Number(m.cid) + '|' + String(m.text || ''); }

  function markTexts() {
    if (!rd) return [];
    const cid = Number(rd.cid), out = [];
    (rd.marks || []).forEach(function (m) {
      if (Number(m.cid) === cid && m.text) out.push(String(m.text));
    });
    return out;
  }

  /* 在一段里找出所有该划线的位置：重叠只留一处，长的优先 */
  function markRanges(txt, texts) {
    const spans = [];
    (texts || []).forEach(function (t) {
      const key = String(t || '').trim();
      if (key.length < 2) return;
      let i = txt.indexOf(key), guard = 0;
      while (i >= 0 && guard++ < 40) {
        spans.push([i, i + key.length]);
        i = txt.indexOf(key, i + key.length);
      }
    });
    if (!spans.length) return [];
    spans.sort(function (a, b) { return a[0] - b[0] || b[1] - a[1]; });
    const out = [];
    let last = -1;
    spans.forEach(function (sp) { if (sp[0] < last) return; out.push(sp); last = sp[1]; });
    return out;
  }

  function renderPara(el, text, texts) {
    clear(el);
    const src = String(text || '');
    const ranges = markRanges(src, texts || []);
    if (!ranges.length) { el.appendChild(document.createTextNode(src)); return; }
    let at = 0;
    ranges.forEach(function (rg) {
      if (rg[0] > at) el.appendChild(document.createTextNode(src.slice(at, rg[0])));
      const mk = document.createElement('span');
      mk.className = 'rd-mark';
      mk.textContent = src.slice(rg[0], rg[1]);
      el.appendChild(mk);
      at = rg[1];
    });
    if (at < src.length) el.appendChild(document.createTextNode(src.slice(at)));
  }

  /* 只重画正文的划线，不动滚动位置 */
  function paintMarksOnly() {
    if (!rd) return;
    const txt = rd.page.querySelector('.rd-text');
    if (!txt) return;
    const texts = markTexts();
    Array.prototype.forEach.call(txt.querySelectorAll('p'), function (el) {
      const i = Number(el.dataset.idx);
      const src = (rd.paras && rd.paras[i] !== undefined) ? rd.paras[i] : el.textContent;
      renderPara(el, src, texts);
    });
  }

  /* 一段切成句子：挑一句来划，比整段划线精细 */
  function sentenceList(text) {
    const src = String(text || '').trim();
    if (!src) return [];
    const out = [];
    let buf = '';
    for (let i = 0; i < src.length; i++) {
      const ch = src.charAt(i);
      buf += ch;
      if (/[。！？…]/.test(ch)) {
        while (i + 1 < src.length && /[”』」]/.test(src.charAt(i + 1))) buf += src.charAt(++i);
        if (buf.trim()) out.push(buf.trim());
        buf = '';
      }
    }
    if (buf.trim()) out.push(buf.trim());
    return out.length > 1 ? out.slice(0, 14) : [];
  }

  function doMark(text, pi, note) {
    if (!rd) return;
    const body = String(text || '').trim();
    if (!body) return;
    addMark({ id: 0, nid: rd.nid, cid: rd.cid, idx: rd.idx, title: rd.t || '', pi: pi || 0,
              text: body.slice(0, 600), note: note || '', ratio: chapterRatio(), ts: Date.now() },
            false);
  }

  /* 存一条划线：本机先落地（马上看得到），云端补一份（换手机也在） */
  function addMark(item, quiet) {
    if (!rd) return;
    const cur = rd.marks || [];
    const key = cloudKey(item);
    let hit = null;
    for (let i = 0; i < cur.length; i++) if (cloudKey(cur[i]) === key) { hit = cur[i]; break; }
    if (hit) {
      if (item.note) hit.note = item.note;
      hit.ts = item.ts;
      item = hit;
    } else {
      cur.push(item);
    }
    rd.marks = cur;
    writeMarks(rd.nid, cur);
    paintMarksOnly();
    if (!quiet) {
      haptic('success');
      toast(item.note ? '已存进摘录本' : '已划线 · 更多 → 摘录本', 'ok');
    }
    if (MZ.reading && MZ.reading.addMark) {
      const r = MZ.reading.addMark({ nid: item.nid, cid: item.cid, idx: item.idx, title: item.title,
        pi: item.pi || 0, text: item.text, note: item.note, ratio: item.ratio, ts: item.ts });
      if (r && r.then) r.then(function (d) { if (d && d.mark && item.id === 0) item.id = d.mark.id; },
                             function () { /* 离线：等下次进来再补 */ });
    }
  }

  function delMark(item) {
    if (!rd) return;
    const key = cloudKey(item);
    rd.marks = (rd.marks || []).filter(function (m) { return cloudKey(m) !== key; });
    writeMarks(rd.nid, rd.marks);
    paintMarksOnly();
    if (item.id && MZ.reading && MZ.reading.delMark) {
      const r = MZ.reading.delMark(item.id);
      if (r && r.then) r.then(function () {}, function () {});
    }
  }

  /* 打开一本书：先铺本机那份（快），再跟云端对（齐） */
  async function loadMarks(nid) {
    if (!rd) return;
    rd.marks = readMarks(nid);
    paintMarksOnly();
    if (!MZ.reading || !MZ.reading.marks) return;
    let d = null;
    try { d = await MZ.reading.marks(nid); } catch (e) { return; }
    if (!rd || Number(rd.nid) !== Number(nid)) return;
    const cloud = (d && d.marks) || [];
    const seen = {};
    cloud.forEach(function (m) { seen[cloudKey(m)] = 1; });
    /* 本机有、云端没有的（上一趟离线划的）：顺手补上去 */
    const extra = (rd.marks || []).filter(function (m) { return !seen[cloudKey(m)]; }).slice(0, 5);
    rd.marks = cloud.slice();
    writeMarks(nid, rd.marks);
    extra.forEach(function (m) { addMark(m, true); });
    paintMarksOnly();
  }

  function scrollToPara(pi) {
    if (!rd) return;
    const el = rd.page.querySelector('.rd-text p[data-idx="' + Number(pi || 0) + '"]');
    if (!el) return;
    const v = rd.view;
    const top = el.getBoundingClientRect().top - v.getBoundingClientRect().top + v.scrollTop - 88;
    v.scrollTop = Math.max(0, top);
  }
  async function jumpMark(m) {
    if (!rd || !m) return;
    if (Number(m.cid) !== Number(rd.cid)) {
      const ch = findCid(m.cid);
      if (ch) await showChapter(ch, 0);
    }
    if (!rd) return;
    scrollToPara(m.pi);
  }

  /* 直接给一整段写想法（还没划过线的那种） */
  function noteStart(text, pi) {
    MZ.modal({ title: '写点想法', text: String(text || '').slice(0, 80), input: 'text',
               placeholder: '这处想到了什么？', okText: '存进摘录本' }).then(function (v) {
      if (v === null || v === undefined || !rd) return;
      doMark(text, pi, String(v).slice(0, 1000));
    });
  }
  /* 给已经划过的那条补 / 改想法 */
  function noteEdit(m, after) {
    MZ.modal({ title: '改想法', text: '第 ' + (m.idx || '?') + ' 章 · ' + String(m.text).slice(0, 60),
               input: 'text', value: m.note || '', placeholder: '这处想到了什么？',
               okText: '存进摘录本' }).then(function (v) {
      if (v === null || v === undefined || !rd) return;
      const note = String(v).slice(0, 1000);
      addMark({ nid: rd.nid, cid: m.cid, idx: m.idx, title: m.title, pi: m.pi || 0,
                text: m.text, note: note, ratio: m.ratio || 0, ts: Date.now() }, false);
      if (after) after();
    });
  }

  function markActions(m, after) {
    actions([
      { label: '复制这一句', icon: 'copy', onPick: function () {
        MZ.clipboard(m.text).then(function (okc) {
          toast(okc ? '已复制' : '复制失败，手动选一下吧', okc ? 'ok' : 'bad');
        });
      } },
      { label: m.note ? '改想法' : '写点想法', icon: 'edit', onPick: function () { noteEdit(m, after); } },
      { label: '删掉这条摘录', icon: 'trash', onPick: function () {
        delMark(m);
        toast('已删掉这条摘录', 'ok');
        if (after) after();
      } },
    ], { title: '第 ' + (m.idx || '?') + ' 章 · 摘录' });
  }

  /* 长按段落：挑一句划，或者整段划 / 写想法 */
  function markSheet(pEl) {
    if (!rd) return;
    const pi = Number(pEl.dataset ? pEl.dataset.idx : 0);
    const full = (rd.paras && rd.paras[pi] !== undefined) ? rd.paras[pi] : (pEl.textContent || '');
    const sents = sentenceList(full);
    const box = h('div');
    box.appendChild(h('div.card.tight', null,
      h('div.small.muted', { text: '第 ' + rd.idx + ' 章 · ' + (rd.t || '') }),
      h('div.rd-quote', { text: full.length > 150 ? full.slice(0, 150) + '…' : full })));
    if (sents.length) {
      const lb = h('div.list.mt8');
      sents.forEach(function (sn) {
        lb.appendChild(A.li({
          title: sn.length > 34 ? sn.slice(0, 34) + '…' : sn,
          sub: sn.length > 34 ? sn.slice(34, 78) : '',
          right: chip('划这句', ''),
          onTap: function () { if (sh) sh.close(); doMark(sn, pi, ''); },
        }));
      });
      box.appendChild(lb);
    }
    box.appendChild(h('div.mt12', null, A.buttons([
      { label: sents.length ? '整段划线' : '划线这一段', onTap: function () {
        if (sh) sh.close();
        doMark(full, pi, '');
      } },
      { label: '写点想法…', onTap: function () { if (sh) sh.close(); noteStart(full, pi); } },
      { label: '复制这一段', onTap: function () {
        if (sh) sh.close();
        MZ.clipboard(full).then(function (okc) {
          toast(okc ? '这一段已复制' : '复制失败：长按手动选吧', okc ? 'ok' : 'bad');
        });
      } },
    ])));
    let sh = sheet({ title: '划线 / 摘录', build: function (b) { b.appendChild(box); } });
  }

  /* 摘录本：这本书划过的线全在这儿 */
  function marksSheet() {
    if (!rd) return;
    const box = h('div');
    const head = h('div.row.mb8');
    const lb = h('div.list');
    function paint() {
      clear(head); clear(lb);
      const ms = (rd && rd.marks) || [];
      head.appendChild(h('span.small.muted', { text: '共 ' + ms.length + ' 条' }));
      head.appendChild(h('span.sp'));
      if (ms.length) head.appendChild(h('span.small.muted', { text: '长按一条可改想法 / 删除' }));
      if (!ms.length) {
        lb.appendChild(h('div.small.muted.center', { text: '这本书还没划过线。' }));
        lb.appendChild(h('div.small.muted.center.mt8', { text: '回正文长按一句话，就能划线、写想法。' }));
        return;
      }
      ms.forEach(function (m) {
        const row = A.li({
          title: m.text.length > 32 ? m.text.slice(0, 32) + '…' : m.text,
          sub: '第 ' + (m.idx || '?') + ' 章' +
               (m.note ? ' · ' + (m.note.length > 22 ? m.note.slice(0, 22) + '…' : m.note) : ''),
          right: chip(m.note ? '有想法' : '划线', m.note ? 'ok' : ''),
          onTap: function () { if (sh) sh.close(); jumpMark(m); },
        });
        MZ.hold(row, function () { markActions(m, paint); });
        lb.appendChild(row);
      });
    }
    box.appendChild(head);
    box.appendChild(lb);
    let sh = sheet({ title: '摘录本', height: '78vh', build: function (b) { b.appendChild(box); paint(); } });
  }

  /* ============================== 更多 ============================== */
  function moreSheet() {
    if (!rd) return;
    const nid = rd.nid, cid = rd.cid, idx = rd.idx, t = rd.t;
    actions([
      { label: '目录 / 跳章', icon: 'layers', sub: '共 ' + rd.chList.length + ' 章', onPick: dirSheet },
      { label: '阅读设置', icon: 'sliders', sub: '字号 / 行距 / 背景 / 字体', onPick: setSheet },
      { label: '摘录本', icon: 'book',
        sub: (rd.marks && rd.marks.length) ? ('共 ' + rd.marks.length + ' 条划线 / 想法') : '长按正文就能划线',
        onPick: marksSheet },
      { label: '用写作台改这一章', icon: 'edit', onPick: function () {
        close(true);
        MZEditor.openChapter(nid, cid, { title: t, idx: idx, nid: nid });
      } },
      { label: '复制这一章', icon: 'copy', sub: '含标题，可直接发出去', onPick: function () { copyChapter(); } },
      { label: '导出这一章 txt', icon: 'download', onPick: function () { exportChapter(); } },
    ], { title: '第 ' + idx + ' 章' });
  }

  async function copyChapter() {
    if (!rd || !rd.content.trim()) { toast('这一章还没有正文', 'warn'); return; }
    const body = '第 ' + rd.idx + ' 章 ' + (rd.t || '') + '\n\n' + rd.content;
    const okCopy = await MZ.clipboard(body);
    toast(okCopy ? '整章已复制' : '复制失败：长按正文手动全选吧', okCopy ? 'ok' : 'bad');
    haptic(okCopy ? 'success' : 'warn');
  }

  async function exportChapter() {
    if (!rd || !rd.content.trim()) { toast('这一章还没有正文', 'warn'); return; }
    const name = '第' + rd.idx + '章 ' + (rd.t || '') + '.txt';
    const text = '第 ' + rd.idx + ' 章 ' + (rd.t || '') + '\n\n' + rd.content;
    try {
      const r = await MZ.saveText(name, text);
      toast(r && r.native ? '已存到「文件 → 墨舟 → 墨舟导出」' : '已导出 ' + name, 'ok');
      haptic('success');
    } catch (e) { toast('导出失败：' + ((e && e.message) || e), 'bad'); }
  }

  return {
    open: open, resume: resume, last: last, isOpen: isOpen,
    close: function () { close(false); },
    marks: function (nid) { return readMarks(nid); },
    openMarks: marksSheet,
    _prefs: prefs,
  };
})();