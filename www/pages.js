/* ==========================================================================
   墨舟移动端 · 任务中心 与 我的  pages.js  v5
   任务页是本版的核心：它回答的唯一问题就是「现在到底在跑什么」——
   总进度环 + 当前书/第几章/当前阶段 + 模型队列 + 功能步骤条 + 实时运行日志。
   ========================================================================== */
'use strict';

(function () {
  const { h, clear, api, toast, sheet, modal, confirm, haptic, fmtNum, fmtWords, fmtDur, fmtDate, timeAgo,
          emptyBox, loadingBox, errBox, icon, chip } = MZ;
  const A = window.MZApp;
  const { li, card, buttons, bar, busySheet, MZUI } = A;

  const STATUS = {
    running: { text: '进行中', tone: 'warn' },
    queued: { text: '排队中', tone: '' },
    done: { text: '已完成', tone: 'ok' },
    failed: { text: '失败', tone: 'bad' },
    cancelled: { text: '已取消', tone: '' },
    partial: { text: '部分完成', tone: 'warn' },
  };
  function statusChip(s) {
    const st = STATUS[s] || { text: s || '未知', tone: '' };
    return chip(st.text, st.tone);
  }

  /* ============================== 任务 ============================== */
  A.screens.jobs = function () {
    return {
      title: '任务',
      action: A.liveBusy(A.state.live) ? { label: '停止全部', onTap: function () { A.stopAll(); } } : null,
      async mount(body) {
        const out = h('div.pad');
        /* 顶部「现在在跑什么」和下面「最近任务」拆成两块独立刷新。
           轮询只调用 view.paint()，把内容真的变了的哪一块换掉，
           不再整页 clear + 重建——以前每 1.6 秒重来一次，用户的原话是
           「一直在跳、一直在刷新」。 */
        const view = jobsView(out);
        A.state.jobsView = view;
        view.busy = A.liveBusy(A.state.live);
        view.histAt = Date.now();
        view.paint(A.state.jobsHistory || null);
        try {
          const d = await api.get('/api/jobs?limit=30');
          A.state.jobsHistory = (d && d.jobs) || [];
        } catch (e) { A.state.jobsHistory = A.state.jobsHistory || []; }
        view.histAt = Date.now();
        view.paint(A.state.jobsHistory);
        return out;
      },
    };
  };

  function jobRunning(j) { return j.status === 'running' || j.status === 'queued'; }
  function jobsActiveKey() {
    return (A.state.liveJobs || []).filter(jobRunning)
      .map(function (j) { return j.id; }).sort().join(',');
  }
  /* 「最近任务」列表的数据指纹：这几项没变就不用重建那一列 DOM */
  function jobsListStamp(jobs) {
    if (!jobs) return '\u0000';
    return jobs.map(function (j) {
      return [j.id, j.status, j.done, j.total, j.failed, j.title, j.message,
        j.created_at, j.finished_at].join('|');
    }).join('\n');
  }
  /* 顶部那块只认「真的会画出来」的字段。
     elapsed 每轮都在涨，但它只是「已用时」那几个字，原地改那一处就行；
     把它算进指纹的话，每轮都要重建一次进度环（环会从 0 重播动画），
     看起来就是一直在闪。 */
  function jobsHeroStamp(live) {
    const ops = live.ops || {};
    const opSig = Object.keys(ops).map(function (k) {
      const o = ops[k] || {};
      return [k, o.title, o.phase, o.note, o.finished ? 1 : 0,
        o.ok === false ? 0 : 1, o.step, (o.steps || []).join(',')].join(':');
    }).join(';');
    const q = live.queue || {};
    const qSig = [q.active || 0, q.queued || 0,
      (q.waiting || []).map(function (w) { return (w && (w.model || w.name)) || w; }).join(',')].join(':');
    const bSig = (live.books || []).map(function (b) {
      return [b.id, b.title, b.phase, b.need, b.done, b.current_idx, b.last_idx,
        b.last_words, b.failed, b.error].join(':');
    }).join(';');
    const eSig = (live.events || []).slice(-12).map(function (e) {
      return ((e && e.at) || '') + '|' + ((e && (e.msg || e.message)) || e || '');
    }).join(';');
    return [live.running ? 1 : 0, live.done, live.total,
      live.job_title, live.phase, live.msg, live.chars, opSig, qSig, bSig, eSig].join('#');
  }
  function jobsView(out) {
    const heroBox = h('div.jobs-hero');
    const listBox = h('div.jobs-list');
    out.appendChild(heroBox);
    out.appendChild(listBox);
    const view = {
      heroBox: heroBox, listBox: listBox, heroSig: '', listSig: '',
      histAt: 0, histBusy: false, busy: false, activeKey: jobsActiveKey(),
    };
    /* 换块时把滚动位置补回来：块变高了，下面的内容整体往下挪，用户就会觉得「跳」。
       这里量一下高度差补进 scrollTop，读到的还是原来那一行。 */
    function swap(box, keepScroll, build) {
      const main = document.getElementById('main');
      const before = keepScroll && main ? box.getBoundingClientRect().height : 0;
      clear(box);
      build(box);
      if (keepScroll && main && main.scrollTop > 2) {
        const d = box.getBoundingClientRect().height - before;
        if (d) main.scrollTop += d;
      }
    }
    view.paintHero = function (live) {
      live = live || {};
      const sig = jobsHeroStamp(live);
      if (sig === view.heroSig) { paintElapsed(heroBox, live); return; }
      view.heroSig = sig;
      swap(heroBox, true, function (box) {
        if (A.liveBusy(live)) {
          box.appendChild(MZUI.liveHero(live, { maxEvents: 12 }));
          const ops = MZUI.opsNode(live);
          if (ops) {
            box.appendChild(h('div.section-title', { text: '正在跑的功能' }));
            box.appendChild(ops);
          }
        } else {
          box.appendChild(h('div.card', null,
            h('div.card-head', null, h('h3', { text: '当前没有任务在跑' }),
              h('span.sp', null, h('span.dot', { style: { opacity: '.35' } }))),
            h('div.small.muted', { text: '去书架点顶部的「补更」，或者在作品页点「补更（续写）」；跑起来之后这里会实时显示进度、当前章节和正在调用的模型。' }),
            buttons([{ label: '去书架', tone: 'primary', onTap: function () { A.switchTab('books'); } }])));
        }
      });
    };
    view.paintList = function (jobs) {
      const sig = jobsListStamp(jobs);
      if (sig === view.listSig) return;
      view.listSig = sig;
      swap(listBox, false, function (box) {
        box.appendChild(h('div.section-title', null, h('span', { text: '最近任务' }),
          h('span.sp', { text: jobs ? ('近 ' + jobs.length + ' 条') : '' })));
        if (jobs === null) return;   /* 还没拉到：先空着，免得闪一下「还没有任务记录」 */
        if (!jobs.length) { box.appendChild(emptyBox('jobs', '还没有任务记录', '发起一次补更就会出现在这里')); return; }
        jobs.forEach(function (j) { box.appendChild(jobCard(j)); });
      });
    };
    view.paint = function (jobs) {
      view.paintHero(A.state.live || {});
      view.paintList(jobs);
      const ids = jobsActiveKey();
      view.refreshHistory(ids !== view.activeKey);
      view.activeKey = ids;
    };
    /* 「最近任务」要查库（/api/jobs），不用每轮都查：
       任务开始 / 结束（活跃 id 变了）立刻查，跑着的时候最多 6 秒查一次，闲时不查。 */
    view.refreshHistory = function (force) {
      const now = Date.now();
      if (view.histBusy) return;
      if (!force && (now - view.histAt < 6000 || !A.liveBusy(A.state.live))) return;
      view.histBusy = true; view.histAt = now;
      api.get('/api/jobs?limit=30').then(function (d) {
        view.histBusy = false;
        A.state.jobsHistory = (d && d.jobs) || [];
        view.paintList(A.state.jobsHistory);
      }).catch(function () { view.histBusy = false; });
    };
    return view;
  }
  /* 「已用时」原地改字：不算进指纹，就不会为了跳秒把整块重建 */
  function paintElapsed(box, live) {
    const el = box.querySelector('.lh-elapsed');
    if (!el) return;
    const t = live.elapsed ? ('已用时 ' + fmtDur(live.elapsed)) : '';
    if (el.textContent !== t) el.textContent = t;
    if (t) el.removeAttribute('hidden'); else el.setAttribute('hidden', '');
  }

  function jobCard(j) {
    const total = j.total || 0, done = j.done || 0;
    const running = j.status === 'running' || j.status === 'queued';
    const box = h('div.job' + (running ? '.running' : ''));
    box.appendChild(h('div.job-top', null,
      (j.status === 'running') ? h('span.live-dot') : null,
      h('div.jt', { text: j.title || ('任务 #' + j.id) }),
      statusChip(j.status)));
    const subs = [];
    if (total) subs.push(done + '/' + total + ' 章');
    if (j.failed) subs.push('失败 ' + j.failed);
    if (j.kind) subs.push(j.kind);
    if (j.created_at) subs.push(timeAgo(j.created_at));
    if (subs.length) box.appendChild(h('div.job-sub', null, subs.map(function (s) { return h('span', { text: s }); })));
    if (j.message) box.appendChild(h('div.job-msg', { text: String(j.message) }));
    if (total) box.appendChild(bar((done / total) * 100, j.status === 'failed' ? 'bad' : ''));
    const row = h('div.btn-row');
    if (running) row.appendChild(A._btn('停止', 'danger', function () { cancelJob(j.id); }, 'sm'));
    if (j.status === 'failed' || j.status === 'partial') row.appendChild(A._btn('重试失败章节', 'primary', function () { retryJob(j.id); }, 'sm'));
    if (j.novel_id) row.appendChild(A._btn('看这本书', '', function () { A.openBook(j.novel_id); }, 'sm'));
    if (row.children.length) box.appendChild(row);
    return box;
  }
  async function cancelJob(id) {
    const ok = await confirm('停止这个任务？当前这一章写完后会停下。', { danger: true, okText: '停止' });
    if (!ok) return;
    try {
      const r = await api.post('/api/job/' + id + '/cancel');
      toast((r && r.msg) || '已请求停止', 'ok');
      await A.refreshLive(); A.render();
    } catch (e) { toast(e.message, 'bad'); }
  }
  async function retryJob(id) {
    try {
      const r = await api.post('/api/job/' + id + '/retry');
      toast((r && r.msg) || '已重试', 'ok');
      await A.refreshLive(); A.render();
    } catch (e) { toast(e.message, 'bad'); }
  }

  /* ============================== 我的 ============================== */
  A.screens.me = function () {
    return {
      title: '我的',
      async mount(body) {
        await A.ensureHero();
        const out = h('div.pad');
        const hero = A.state.hero || {};
        const st = hero.stats || {};
        const settings = hero.settings || {};
        const providers = hero.providers || {};

        /* ---- 我的资料（头像 / 用户名 / 性别 / 年龄） ---- */
        out.appendChild(profileCard());
        /* ---- 钱包与订阅：白名单会员也进得来，只是不给充值入口 ---- */
        await loadBill();
        out.appendChild(billEntryCard());

        /* ---- 账号与同步 ---- */
        const acct = h('div.card');
        acct.appendChild(h('div.card-head', null,
          h('h3', { text: '账号与同步' }),
          h('span.sp', null, chip(cloudLabel(), 'ok', 'cloud'))));
        acct.appendChild(h('div.small.muted', { text: '手机和电脑登录同一个账号，看到的永远是同一份稿子；每一次保存都会自动同步。' }));
        const pwRow = h('div.li.tap', null,
          h('div.li-ico', null, icon('lock', { size: 20 })),
          h('div.li-main', null,
            h('div.li-title', { text: '修改密码' }),
            h('div.li-sub', { text: '换密码之后，别的手机 / 电脑要重新登录' })),
          h('span.li-arrow', null, icon('fwd', { size: 16 })));
        pwRow.addEventListener('click', function () { haptic('light'); A.showChangePw(); });
        const pwWrap = h('div.list.pwrows');
        pwWrap.appendChild(pwRow);
        acct.appendChild(pwWrap);
        acct.appendChild(buttons([
          { label: '退出登录', tone: 'danger', size: 'sm', onTap: function () { logout(); } },
          { label: '填访问口令', size: 'sm', onTap: function () { A.openTokenDialog().then(function (saved) { if (saved) A.refreshAll(false); }); } },
        ]));
        out.appendChild(acct);

        /* ---- 正在跑 / 排队 ---- */
        if (A.liveBusy(A.state.live)) {
          out.appendChild(h('div.section-title', null, h('span', { text: '实时状态' })));
          out.appendChild(MZUI.liveHero(A.state.live, { maxEvents: 4 }));
        }

        out.appendChild(writingCard());

        /* ---- 用量 ---- */
        const u = hero.usage || {};
        const byP = u.by_provider || [];
        if (byP.length) {
          const uc = h('div.card');
          uc.appendChild(h('div.card-head', null,
            h('h3', { text: '模型用量' }),
            h('span.sp', { text: '累计 ' + fmtNum(u.total_calls || 0) + ' 次调用' })));
          const max = byP.reduce(function (m, x) { return Math.max(m, x.calls || 0); }, 0) || 1;
          byP.forEach(function (x) {
            uc.appendChild(h('div.usage-row', null,
              h('span.ur-k', { text: (providers[x.provider] && providers[x.provider].label) || x.provider }),
              h('span.ur-b', null, bar((x.calls || 0) / max * 100)),
              h('span.ur-v', { text: fmtNum(x.calls || 0) + ' 次' })));
          });
          uc.appendChild(h('div.footnote', { text: '生成 ' + fmtNum(u.completion_chars || 0) + ' 字'
            + (u.elapsed_ms ? ' · 耗时 ' + fmtDur(Math.round((u.elapsed_ms || 0) / 1000)) : '') }));
          out.appendChild(uc);
        }

        /* ---- 质检设置 ---- */
        const ql = h('div.list');
        ql.appendChild(li({
          ico: 'target',
          title: '质检评分模型',
          sub: reviewWord(settings),
          arrow: true,
          onTap: reviewModelSheet,
        }));
        ql.appendChild(pickRow('全书质检范围', '抽样省钱，全书逐章最准',
          settings.hit_review_scope === 'all' ? '全书逐章' : '抽样（约 24 章）', SCOPE_ITEMS,
          'hit_review_scope', function (v) { saveSetting('hit_review_scope', v, '质检范围已更新'); }, 'search'));
        ql.appendChild(swRow('评分不思考', '纯按评分标准判断，快 5~10 倍还省钱',
          settings.hit_review_fast !== '0', flagSetting('hit_review_fast', '评分不思考'), 'spark'));
        ql.appendChild(pickRow('同时评几章', '同时评得多容易被限流', (settings.hit_review_workers || '2') + ' 章',
          REVIEW_WORKER_ITEMS, 'hit_review_workers', function (v) { saveSetting('hit_review_workers', v, '质检并发已更新'); }, 'chart'));
        ql.appendChild(swRow('局部重写后自动复评', '改完自动再评一次，看到改前改后差多少分',
          settings.hit_review_auto !== '0', flagSetting('hit_review_auto', '自动复评'), 'check'));
        out.appendChild(card('质检设置', h('span', { text: '按评分标准逐章打分' }), [ql]));

        /* ---- 词表与合规 ---- */
        const cl = h('div.list');
        cl.appendChild(li({ ico: 'edit', title: '去AI化词表',
          sub: wordCount(settings.ai_words_extra, '还没加自定义词'), arrow: true, onTap: wordSheet }));
        cl.appendChild(li({ ico: 'shield', title: '合规预检词表',
          sub: '自己加的雷区词 / 误报放行名单', arrow: true, onTap: complianceSheet }));
        out.appendChild(card('词表与合规', h('span', { text: '换词的口气，不动剧情' }), [cl]));

        /* ---- 数据与备份 ---- */
        const bl = h('div.list');
        bl.appendChild(li({ ico: 'cloud', title: '立即备份数据库', sub: '备份存在云服务器上', arrow: true, onTap: doBackup }));
        bl.appendChild(li({ ico: 'history', title: '查看备份列表', arrow: true, onTap: showBackups }));
        bl.appendChild(li({ ico: 'download', title: '导出这本书', sub: '选一本导成 txt', arrow: true, onTap: pickExport }));
        bl.appendChild(li({ ico: 'trash', title: '回收站', sub: '删掉的作品 / 章节在这里，能恢复', arrow: true, onTap: showTrash }));
        out.appendChild(card('数据与备份', h('span', { text: '都在云服务器上' }), [bl]));

        /* ---- 外观 / 应用 ---- */
        out.appendChild(appearanceCard());
        const al = h('div.list');
        al.appendChild(li({
          ico: 'phone',
          title: standalone() ? '已在 App 模式运行' : '装到手机桌面',
          sub: standalone() ? '全屏运行中，没有地址栏' : '点一下看怎么装，像 App 一样用',
          right: chip(standalone() ? '已安装' : '可安装', standalone() ? 'ok' : ''),
          arrow: !standalone(),
          onTap: standalone() ? null : showInstallGuide,
        }));
                al.appendChild(li({
          ico: 'bell',
          title: '自动更新',
          sub: autoOn(settings) ? ('每天 ' + (settings.auto_time || '08:00') + ' 自动写') : '当前关闭',
          right: chip(autoOn(settings) ? '已开启' : '已关闭', autoOn(settings) ? 'ok' : ''),
          arrow: true,
          onTap: autoSheet,
        }));
        out.appendChild(card('应用', h('span', { text: standalone() ? '全屏运行中' : '可装到桌面' }), [al]));

        /* ---- 关于 ---- */
        const gl = h('div.list');
        gl.appendChild(li({ ico: 'dot', title: '服务端版本', right: h('span.num', { text: A.state.version || '—' }) }));
        gl.appendChild(li({ ico: 'books', title: '作品 / 章节', right: h('span.num', { text: (st.novels || 0) + ' 本 / ' + (st.chapters || 0) + ' 章' }) }));
        gl.appendChild(li({ ico: 'write', title: '累计字数', right: h('span.num', { text: fmtWords(st.chars || 0) }) }));
        gl.appendChild(li({ ico: 'layers', title: '界面', right: h('span', { text: '移动端 v5 · 液态墨' }) }));
        out.appendChild(card('关于', h('span', { text: 'v5 · 液态墨' }), [gl]));
        out.appendChild(h('div.footnote', { text: '数据都在服务器上：手机和电脑登录同一个账号，看到的就是同一份稿子，会自动同步。' }));
        return out;
      },
    };
  };

  function getTheme() { return A.getTheme(); }
  function cloudLabel() {
    const c = String(MZ.CLOUD || '');
    if (!c) return '本地调试';
    return '已连接';
  }
  function standalone() {
    try {
      return (window.matchMedia('(display-mode: standalone)').matches) ||
        (navigator.standalone === true) || !!window.Capacitor;
    } catch (e) { return false; }
  }
  function logout() {
    confirm('退出登录？本机不会删除任何稿件，重新登录后照样同步回来。', { danger: true, okText: '退出' })
      .then(function (ok) {
        if (!ok) return;
        MZ.setSession('');
        MZ.setToken('');
        /* 浏览器里用的是网关 Cookie 会话：不退掉它，刷新一下又被自动带进去，
           表现就是「退出登录不管用」。装机版 App 没有 Cookie，这个请求会落空，无副作用。 */
        try {
          if (/^https?:$/.test(location.protocol)) {
            fetch('/logout', { credentials: 'same-origin', cache: 'no-store' }).catch(function () { /* 忽略 */ });
          }
        } catch (e) { /* 忽略 */ }
        A.showLogin(null);
      });
  }
  async function testProvider(p, label) {
    const s = busySheet('正在测试 ' + label + '…');
    try {
      const r = await api.post('/api/settings/test', { provider: p }, { timeout: 60000 });
      s.close();
      const res = r.result || {};
      const ok = res.ok !== false;
      toast(label + (ok ? ' 连接正常' : ' 连接失败：' + (res.msg || res.error || '未知原因')), ok ? 'ok' : 'bad');
    } catch (e) { s.close(); toast(e.message, 'bad'); }
  }
  async function doBackup() {
    try {
      const r = await api.post('/api/backup', {}, { timeout: 120000 });
      toast((r && r.msg) || '已备份', 'ok');
    } catch (e) { toast(e.message, 'bad'); }
  }
  async function showBackups() {
    const s = sheet({ title: '备份列表', build: function (b) { b.appendChild(loadingBox()); } });
    try {
      const r = await api.get('/api/backups');
      const list = r.backups || [];
      clear(s.body);
      if (!list.length) { s.body.appendChild(emptyBox('history', '还没有备份')); return; }
      const l = h('div.list');
      list.forEach(function (x) {
        const name = x.name || x.file || String(x);
        l.appendChild(li({ title: name, sub: x.size ? fmtNum(x.size) + ' 字节' : (x.mtime ? fmtDate(x.mtime) : '') }));
      });
      s.body.appendChild(l);
      s.body.appendChild(buttons([{ label: '现在备份一份', tone: 'primary', onTap: function () { s.close(); doBackup(); } }]));
    } catch (e) { clear(s.body); s.body.appendChild(errBox(e)); }
  }
  function pickExport() {
    const novels = A.state.novels || [];
    if (!novels.length) { toast('还没有作品', 'bad'); return; }
    MZ.actions(novels.map(function (n) {
      return { label: '《' + (n.title || '未命名') + '》', sub: (n.chapter_count || 0) + ' 章', onPick: function () { exportOne(n); } };
    }), { title: '导出成 txt' });
  }
  async function exportOne(n) {
    toast('正在导出…');
    try {
      const r = await fetch(MZ.url('/api/novel/' + n.id + '/export?fmt=txt'),
        { headers: Object.assign({}, MZ.authHeaders(), MZ.getToken() ? { 'X-Mozhou-Token': MZ.getToken() } : {}) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const text = await r.text();
      const res = await MZ.saveText((n.title || 'novel') + '.txt', text);
      toast(res && res.native
        ? '已存到「文件」App → 我的 iPhone → 墨舟'
        : '已开始下载', 'ok');
    } catch (e) { toast('导出失败：' + e.message, 'bad'); }
  }
  /* ============================== 回收站 ==============================
     书架 / 作品页删掉的东西都先进这里：能恢复，也能彻底删掉。
     没有这个入口的话，「删除」在手机上就是个单向门——所以它跟删除是一套的。 */
  const TRASH_KIND = { novel: '整本作品', chapter: '章节', novel_all_chapters: '重写前的整本备份' };
  async function showTrash() {
    const s = sheet({ title: '回收站', build: function (b) { b.appendChild(loadingBox()); } });
    let items = [];
    try {
      const r = await api.get('/api/trash');
      items = r.items || [];
    } catch (e) { clear(s.body); s.body.appendChild(errBox(e)); return; }

    const drop = function (id) {
      items = items.filter(function (y) { return y.id !== id; });
      paint();
    };
    const paint = function () {
      clear(s.body);
      if (!items.length) {
        s.body.appendChild(emptyBox('trash', '回收站是空的', '在书架或作品页删掉的东西会先放这里，随时能恢复'));
        return;
      }
      s.body.appendChild(h('div.fld-hint', { text: '点一条就能恢复或者彻底删掉。彻底删掉之后就找不回来了。' }));
      const l = h('div.list');
      items.forEach(function (x) {
        const kind = TRASH_KIND[x.kind] || x.kind || '记录';
        l.appendChild(li({
          ico: x.kind === 'novel' ? 'books' : 'file',
          title: x.label || kind,
          sub: kind + (x.created_at ? ' · ' + timeAgo(x.created_at) : ''),
          right: h('span', { text: '恢复 / 删除' }),
          arrow: true,
          onTap: function () { trashMenu(x, drop); },
        }));
      });
      s.body.appendChild(l);
    };
    paint();
  }
  function trashMenu(x, drop) {
    MZ.actions([
      { label: '恢复回来', icon: 'history', onPick: function () { restoreTrash(x, drop); } },
      { label: '彻底删除', icon: 'trash', danger: true, sub: '删掉就找不回来了', onPick: function () { purgeTrash(x, drop); } },
    ], { title: x.label || '回收站记录' });
  }
  async function restoreTrash(x, drop) {
    const ok = await confirm('把「' + (x.label || '') + '」恢复回来？', { okText: '恢复' });
    if (!ok) return;
    toast('正在恢复…');
    try {
      const r = await api.post('/api/trash/restore', { id: x.id });
      let extra = '';
      if (r && r.title) extra = '《' + r.title + '》';
      else if (r && r.idx) extra = '第 ' + r.idx + ' 章';
      toast('已恢复' + extra, 'ok');
      haptic('success');
      await A.loadHero();
      drop(x.id);
    } catch (e) { toast(e.message, 'bad'); }
  }
  async function purgeTrash(x, drop) {
    const ok = await confirm('彻底删除「' + (x.label || '') + '」？这一步之后找不回来了。', { danger: true, okText: '彻底删除' });
    if (!ok) return;
    toast('正在删除…');
    try {
      await api.post('/api/trash/purge', { id: x.id });
      toast('已彻底删除', 'ok');
      drop(x.id);
    } catch (e) { toast(e.message, 'bad'); }
  }

  function showInstallGuide() {
    sheet({
      title: '装到手机桌面',
      build: function (b) {
        const steps = [
          '用 Safari 打开墨舟的网址（必须是 Safari，微信里打开不行）。',
          '点底部中间的「分享」按钮。',
          '在列表里选「添加到主屏幕」。',
          '起个名字（默认「墨舟」就行），点「添加」。',
        ];
        const l = h('div.list');
        steps.forEach(function (t, i) { l.appendChild(li({ ico: String(i + 1), title: t })); });
        b.appendChild(l);
        b.appendChild(h('div.footnote', { text: '装好之后图标会出现在桌面上，点开就是全屏，没有地址栏，和 App 一样。' }));
      },
    });
  }
  /* ============================== 设置：模型分工 ==============================
     这一版手机端不再是「只读 + 测连通性」：勾几个模型就调几个，谁在什么时候干活由 App
     自动分配。分配规则跟电脑端后端 writer._assign_roles 一模一样，这里只是把它算出来给用户看，
     省得「勾了三个到底谁写哪一章」还要跑去电脑上翻。 */
  const MODELS = ['doubao', 'mimo', 'deepseek'];
  const MODEL_LABEL = { doubao: '豆包', mimo: 'MiMo', deepseek: 'DeepSeek' };
  /* 三个模型的品牌图标（在 api.js ICONS 里定义） */
  const MODEL_ICON = { doubao: 'm_doubao', mimo: 'm_mimo', deepseek: 'm_deepseek' };
  const ROLE_LABEL = { plan: '策划', write: '写作', review: '审查', polish: '润色' };
  const ROLE_ORDER = ['plan', 'write', 'review', 'polish'];
  const INPUT_STYLE = {
    width: '100%', background: 'var(--panel2)', border: '1px solid var(--line)',
    borderRadius: '14px', padding: '13px 14px',
  };
  const TEXTAREA_STYLE = {
    width: '100%', minHeight: '130px', background: 'var(--panel2)', border: '1px solid var(--line)',
    borderRadius: '14px', padding: '13px 14px', lineHeight: '1.6',
  };
  const STRATEGY_ITEMS = [
    { key: '', label: '按作品设置（推荐）', sub: '按上面勾选的模型自动分工' },
    { key: 'doubao', label: '不管勾了几个，写作只用豆包' },
    { key: 'mimo', label: '不管勾了几个，写作只用 MiMo' },
    { key: 'deepseek', label: '不管勾了几个，写作只用 DeepSeek' },
  ];
  const CONC_ITEMS = [
    { key: '1', label: '一个个来', sub: '最稳，最慢' },
    { key: '2', label: '最多 2 个同时' },
    { key: '3', label: '最多 3 个同时（推荐）', sub: '三模型评分快约 3 倍' },
    { key: '0', label: '不限制', sub: '最快，容易被限流' },
  ];
  const RETRY_ITEMS = [
    { key: '0', label: '不重试' },
    { key: '1', label: '重试 1 次' },
    { key: '2', label: '重试 2 次（推荐）' },
    { key: '3', label: '重试 3 次' },
  ];
  const BOOK_WORKER_ITEMS = [
    { key: '1', label: '1 本（最稳）' },
    { key: '2', label: '2 本（推荐）' },
    { key: '3', label: '3 本' },
    { key: '4', label: '4 本' },
    { key: '6', label: '6 本（最快）' },
  ];
  const SCOPE_ITEMS = [
    { key: 'sample', label: '抽样（省钱，约 24 章）' },
    { key: 'all', label: '全书逐章（最准，最费）' },
  ];
  const REVIEW_WORKER_ITEMS = [
    { key: '1', label: '1 章（最稳，最少被限流）' },
    { key: '2', label: '2 章（推荐）' },
    { key: '3', label: '3 章（较快）' },
    { key: '4', label: '4 章（最快，可能被限流）' },
  ];

  function mLabel(k) { return MODEL_LABEL[k] || k; }
  function one(k, v) { const o = {}; o[k] = v; return o; }
  function splitModels(v) {
    return String(v == null ? '' : v).split(',').map(function (x) { return x.trim(); })
      .filter(function (x) { return MODELS.indexOf(x) >= 0; });
  }
  function sameSet(a, b) {
    if (a.length !== b.length) return false;
    return a.every(function (x) { return b.indexOf(x) >= 0; });
  }
  function settingsOf() { return (A.state.hero && A.state.hero.settings) || {}; }
  function hasKey(s, k) { return !!s['has_' + k + '_api_key']; }
  function configuredModels(s) { return MODELS.filter(function (k) { return hasKey(s, k); }); }

  /* 这一章到底会用哪几个模型（复刻后端 writer._get_selected_models 的优先级） */
  function activeModels(s) {
    const have = configuredModels(s);
    const gs = String(s.gen_strategy || '').trim();
    if (MODELS.indexOf(gs) >= 0 && (!have.length || have.indexOf(gs) >= 0)) return [gs];
    const sel = splitModels(s.selected_models);
    if (sel.length) {
      const ready = have.length ? sel.filter(function (m) { return have.indexOf(m) >= 0; }) : sel;
      if (ready.length) return ready;
    }
    return have;
  }
  /* 角色分配（复刻后端 writer._assign_roles；勾了 DeepSeek 就由它主写） */
  function assignRoles(sel) {
    if (!sel.length) return { plan: 'doubao', write: 'doubao', review: 'doubao', polish: 'doubao' };
    if (sel.length === 1) {
      const m = sel[0];
      return { plan: m, write: m, review: m, polish: m };
    }
    if (sel.indexOf('deepseek') >= 0) {
      const other = sel.indexOf('doubao') >= 0 ? 'doubao' : 'mimo';
      const review = sel.length >= 3 ? 'mimo' : other;
      return { plan: other, write: 'deepseek', review: review, polish: 'deepseek' };
    }
    return { plan: 'doubao', write: 'mimo', review: 'mimo', polish: 'doubao' };
  }

  /* 设置里存的自定义分工："plan=doubao,write=deepseek,review=mimo,polish=deepseek"
     分隔符认半角/全角逗号分号和换行；角色名或模型名对不上的丢掉，交给自动规则补 */
  const ROLE_SEP = ',;' + String.fromCharCode(10, 13, 65307, 65292);
  function parseRoles(raw, sel) {
    const out = {};
    const src = String(raw == null ? '' : raw);
    let buf = '';
    for (let i = 0; i < src.length; i++) buf += (ROLE_SEP.indexOf(src.charAt(i)) >= 0 ? ',' : src.charAt(i));
    buf.split(',').forEach(function (part) {
      const one = part.trim();
      if (!one || one.indexOf('=') < 0) return;
      const k = one.slice(0, one.indexOf('=')).trim().toLowerCase();
      const v = one.slice(one.indexOf('=') + 1).trim().toLowerCase();
      if (ROLE_ORDER.indexOf(k) >= 0 && sel.indexOf(v) >= 0) out[k] = v;
    });
    return out;
  }

  /* 这一章到底谁干什么：优先用后端算好发下来的 effective_roles，
     拿不到就本地按 model_roles + 自动规则算，保证跟后端一致 */
  function effRoles(s, act) {
    const out = {};
    const back = s && s.effective_roles;
    if (back && typeof back === 'object' && typeof back.write === 'string'
        && act.indexOf(back.write) >= 0
        && ROLE_ORDER.every(function (k) { return typeof back[k] === 'string' && back[k]; })) {
      ROLE_ORDER.forEach(function (k) { out[k] = back[k]; });
      return out;
    }
    const custom = parseRoles(s && s.model_roles, act);
    const auto = assignRoles(act);
    ROLE_ORDER.forEach(function (k) { out[k] = custom[k] || auto[k]; });
    return out;
  }

  /* 每个角色一个下拉，跟电脑端设置页那四个下拉一模一样：
     勾了几个模型，下拉里就有几个可选项；不动就是系统默认分工。 */
  function roleSelect(key, models, cur) {
    const sel = h('select.role-pick', {
      style: 'background:var(--panel2);border:1px solid var(--line);border-radius:12px;'
           + 'padding:9px 10px;color:inherit;font:inherit;font-size:15px;max-width:50vw;text-align:left',
    });
    models.forEach(function (m) { sel.appendChild(h('option', { value: m, text: mLabel(m) })); });
    sel.value = cur[key] || models[0];
    sel.addEventListener('change', function () { haptic('light'); setRole(key, sel.value, models); });
    return sel;
  }
  async function setRole(key, model, act) {
    const s = settingsOf();
    const auto = assignRoles(act);
    const cust = parseRoles(s.model_roles, act);
    const r = {};
    ROLE_ORDER.forEach(function (k) { r[k] = cust[k] || auto[k]; });
    r[key] = model;
    const str = ROLE_ORDER.filter(function (k) { return !!r[k]; })
      .map(function (k) { return k + '=' + r[k]; }).join(',');
    const ok = await putSettings({ model_roles: str }, ROLE_LABEL[key] + '改由 ' + mLabel(model));
    if (ok) A.render();
  }



  /* ---- 我的资料：头像 / 用户名 / 性别 / 年龄 ---- */
  const GENDER_OPTS = [['', '未填'], ['男', '男'], ['女', '女'], ['保密', '保密']];

  function avatarNode(url, name, big) {
    const box = h('div.pf-av' + (big ? '.big' : '') + (url ? '.has' : ''));
    if (url) box.appendChild(h('img', { src: MZ.img(url), alt: '' }));
    else box.appendChild(h('span', { text: String(name || '?').slice(0, 1) }));
    return box;
  }

  /* 头像压到 256x256 方图：省流量，上传也快 */
  function shrinkImage(file, cb) {
    try {
      const fr = new FileReader();
      fr.onload = function () {
        const img = new Image();
        img.onload = function () {
          try {
            const n = 256, cv = document.createElement('canvas');
            cv.width = n; cv.height = n;
            const ctx = cv.getContext('2d');
            const s = Math.min(img.width, img.height) || n;
            ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, n, n);
            cb(cv.toDataURL('image/jpeg', 0.88));
          } catch (e) { cb(''); }
        };
        img.onerror = function () { cb(''); };
        img.src = fr.result;
      };
      fr.onerror = function () { cb(''); };
      fr.readAsDataURL(file);
    } catch (e) { cb(''); }
  }

  function profileCard() {
    const p = A.state.profile || {};
    const name = p.name || '我';
    const info = [p.pen_name ? ('笔名 ' + p.pen_name) : '', p.gender, p.age ? p.age + ' 岁' : ''].filter(function (x) { return x; }).join(' · ');
    const c = h('div.card');
    const edit = h('button.btn.ghost.sm', { type: 'button', text: '编辑资料' });
    edit.addEventListener('click', function () { haptic('light'); openProfileSheet(); });
    c.appendChild(h('div.pf-row', null,
      avatarNode(p.avatar_url, name, false),
      h('div.pf-main', null,
        h('div.pf-name', { text: name }),
        h('div.pf-sub', { text: info || '还没填性别和年龄' })),
      edit));
    c.appendChild(h('div.pf-hello', { text: p.welcome
      ? '欢迎你，' + name + '！把资料补全吧'
      : '欢迎回来，' + name }));
    return c;
  }

  function openProfileSheet() {
    const p = A.state.profile || {};
    let uEl = null, pnEl = null, gEl = null, aEl = null, avEl = null, draft;
    const fileEl = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    const sb = sheet({
      title: '我的资料',
      build: function (b) {
        b.appendChild(h('div.fld-hint', { text: '用户名是登录用的。笔名是作品上的作者名，改它不影响账号，也不会把用户名印到书上。点头像换一张，会自动裁成方图。' }));
        avEl = avatarNode(p.avatar_url, p.name, true);
        avEl.addEventListener('click', function () { haptic('light'); fileEl.click(); });
        b.appendChild(h('div.pf-edit-av', null, avEl, h('div.small.muted', { text: '点头像换一张' })));
        uEl = h('input.li-input', { type: 'text', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
          value: p.username || '', placeholder: p.masked || '用户名', style: INPUT_STYLE });
        b.appendChild(field('用户名', uEl));
        pnEl = h('input.li-input', { type: 'text', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
          value: p.pen_name || '', placeholder: '作品作者名，比如 墨舟', style: INPUT_STYLE });
        b.appendChild(field('笔名', pnEl));
        gEl = h('select.li-input', { style: INPUT_STYLE },
          GENDER_OPTS.map(function (o) { return h('option', { value: o[0], text: o[1] }); }));
        gEl.value = p.gender || '';
        b.appendChild(field('性别', gEl));
        aEl = h('input.li-input', { type: 'number', inputmode: 'numeric', min: '1', max: '120',
          value: p.age || '', placeholder: '比如 28', style: INPUT_STYLE });
        b.appendChild(field('年龄', aEl));
        b.appendChild(buttons([{ label: '保存资料', tone: 'primary', onTap: save }]));
        b.appendChild(h('div.footnote', { text: '资料存在服务器上，手机和电脑看到的是同一份。' }));
        b.appendChild(fileEl);
      },
    });
    fileEl.addEventListener('change', function () {
      const f = fileEl.files && fileEl.files[0];
      fileEl.value = '';
      if (!f) return;
      shrinkImage(f, function (dataUrl) {
        if (!dataUrl) { toast('这张图读不了，换一张试试', 'bad'); return; }
        draft = dataUrl;
        clear(avEl);
        avEl.appendChild(h('img', { src: dataUrl, alt: '' }));
        toast('头像选好了，点「保存资料」', 'ok');
      });
    });
    async function save() {
      const patch = { username: uEl.value.trim(), pen_name: pnEl.value.trim(), gender: gEl.value, age: aEl.value.trim() };
      if (draft !== undefined) patch.avatar = draft;
      try {
        const r = await api.post('/api/mz/profile', patch);
        A.state.profile = (r && r.profile) || A.state.profile || {};
        sb.close();
        toast('资料已保存', 'ok');
        A.render();
      } catch (e) { toast(e.message || '保存失败', 'bad'); }
    }
  }

  /* ---- 读写设置 ---- */
  async function putSettings(patch, msg) {
    try {
      await api.put('/api/settings', patch);
    } catch (e) { toast('保存失败：' + e.message, 'bad'); return false; }
    const cur = A.state.hero && A.state.hero.settings;
    if (cur) {
      Object.keys(patch).forEach(function (k) {
        cur[k] = patch[k];
        if (/_api_key$/.test(k)) cur['has_' + k] = !!String(patch[k] || '').trim();
      });
    }
    if (msg) toast(msg, 'ok');
    return true;
  }
  function saveSetting(key, value, msg) {
    putSettings(one(key, value), msg).then(function (ok) { if (ok) A.render(); });
  }
  function flagSetting(key, title) {
    return function (on) { saveSetting(key, on ? '1' : '0', title + (on ? ' 已开启' : ' 已关闭')); };
  }

  /* ---- 小组件 ---- */
  function swRow(title, sub, on, onTap, ico) {
    const row = h('div.li.tap', null,
      ico ? h('div.li-ico', null, icon(ico, { size: 20 })) : null,
      h('div.li-main', null,
        h('div.li-title', { text: title }),
        sub ? h('div.li-sub', { text: sub }) : null),
      h('div.li-right', null, h('div.sw' + (on ? '.on' : ''), null, h('i'))));
    row.addEventListener('click', function () { haptic('light'); onTap(!on); });
    return row;
  }
  function pickRow(title, sub, value, items, key, after, ico) {
    return li({
      ico: ico, title: title, sub: sub, right: h('span', { text: value }), arrow: true,
      onTap: function () {
        const cur = String(settingsOf()[key] == null ? '' : settingsOf()[key]);
        MZ.actions(items.map(function (it) {
          return {
            label: it.label, sub: it.sub, icon: it.key === cur ? 'check' : null,
            onPick: function () { after(it.key); },
          };
        }), { title: title });
      },
    });
  }
  function field(label, el) {
    return h('div.fld', null, h('label', { text: label }), el);
  }

  /* ---- 自动更新（每日定时补更）----
     服务端存的是 auto_enabled 字符串 '0' / '1'；'0' 在 JS 里是真值，
     所以不能直接写 settings.auto_enabled ? ...（那样永远显示「已开启」）。 */
  function autoOn(settings) {
    const v = (settings || {}).auto_enabled;
    return v === true || v === 1 || String(v) === '1';
  }
  function autoSheet() {
    let on = autoOn(settingsOf());
    let timeInput = null;
    const sb = sheet({
      title: '自动更新',
      build: function (b) {
        b.appendChild(h('div.fld-hint', { text: '开启后，每天到你定好的时间，服务器会替你把没更完的章节补上；手机不用开着。' }));
        let row = null;
        row = swRow('每天自动更新', on ? '已开启' : '当前关闭', on, function (v) {
          on = v;
          const sw = row.querySelector('.sw');
          if (sw) sw.classList.toggle('on', on);
          const sub = row.querySelector('.li-sub');
          if (sub) sub.textContent = on ? '已开启' : '当前关闭';
          if (timeInput) timeInput.disabled = !on;
        }, 'bell');
        const l = h('div.list');
        l.appendChild(row);
        b.appendChild(l);
        timeInput = h('input.inp', { type: 'time', value: String(settingsOf().auto_time || '08:00').slice(0, 5), step: '300' });
        timeInput.disabled = !on;
        b.appendChild(field('每天几点开始（服务器时间）', timeInput));
        b.appendChild(buttons([{
          label: '保存', tone: 'primary',
          onTap: function () {
            const t = String(timeInput.value || '08:00').slice(0, 5);
            if (!/^\d{2}:\d{2}$/.test(t)) { toast('时间格式不对，应该是 08:00 这样', 'bad'); return; }
            putSettings({ auto_enabled: on ? '1' : '0', auto_time: t },
              on ? ('已开启：每天 ' + t + ' 自动写') : '已关闭自动更新')
              .then(function (ok) { if (ok) { sb.close(); A.render(); } });
          },
        }]));
      },
    });
  }

  function strategyWord(s) {
    const gs = String(s.gen_strategy || '').trim();
    return MODELS.indexOf(gs) >= 0 ? ('只用' + mLabel(gs)) : '按作品设置';
  }
  function concWord(s) {
    const v = String(s.llm_concurrency == null || s.llm_concurrency === '' ? '3' : s.llm_concurrency);
    return { '1': '一个个来', '2': '最多 2 个同时', '3': '最多 3 个同时', '0': '不限制' }[v] || '最多 3 个同时';
  }
  function reviewWord(s) {
    const rev = splitModels(s.review_models);
    const names = rev.map(mLabel).join(' + ') || '（未选）';
    if (sameSet(rev, splitModels(s.selected_models))) return '跟写作模型一致：' + names;
    return '单独指定：' + names;
  }
  function wordCount(v, dft) {
    const n = String(v || '').split('\n').filter(function (x) { return x.trim(); }).length;
    return n ? (n + ' 条') : dft;
  }

  /* ---- 模型勾选行（写作分工卡片里的第一块） ---- */
  function modelPickRow(k) {
    const s = settingsOf();
    const on = splitModels(s.selected_models).indexOf(k) >= 0;
    const has = hasKey(s, k);
    const info = ((A.state.hero && A.state.hero.providers) || {})[k] || {};
    const row = h('div.li.tap', null,
      h('div.li-ico.mk.mk-' + k, null, icon(MODEL_ICON[k] || 'spark', { size: 20 })),
      h('div.li-main', null,
        h('div.li-title', { text: mLabel(k) }),
        h('div.li-sub', { text: has ? (info.model || '已配置') : '密钥未配置 · 请到电脑端设置' })),
      h('div.li-right', null,
        h('button.mini', {
          type: 'button', text: has ? '查看' : '未配置',
          onclick: function (e) { e.stopPropagation(); haptic('light'); openProvider(k); },
        }),
        h('span.chk' + (on ? '.on' : ''), null, on ? icon('check', { size: 14, w: 3 }) : null)));
    row.addEventListener('click', function () { haptic('light'); toggleModel(k); });
    return row;
  }
  async function toggleModel(k) {
    const s = settingsOf();
    const cur = splitModels(s.selected_models);
    const has = cur.indexOf(k) >= 0;
    if (has && cur.length === 1) { toast('至少要留一个模型，全去掉就写不了了', 'bad'); return; }
    const next = MODELS.filter(function (m) { return (m === k ? !has : cur.indexOf(m) >= 0); });
    const patch = { selected_models: next.join(',') };
    if (sameSet(cur, splitModels(s.review_models))) patch.review_models = next.join(',');
    const oldRoles = parseRoles(s.model_roles, cur);
    if (Object.keys(oldRoles).length) {
      const keep = {};
      ROLE_ORDER.forEach(function (x) { if (oldRoles[x] && next.indexOf(oldRoles[x]) >= 0) keep[x] = oldRoles[x]; });
      patch.model_roles = ROLE_ORDER.filter(function (x) { return keep[x]; })
        .map(function (x) { return x + '=' + keep[x]; }).join(',');
    }
    const ok = await putSettings(patch, mLabel(k) + (has ? ' 已取消' : ' 已勾选'));
    if (ok) A.render();
  }
  function writingCard() {
    const settings = settingsOf();
    const sel = splitModels(settings.selected_models);
    const auto = assignRoles(sel);
    const cust = parseRoles(settings.model_roles, sel);
    const eff = {};
    ROLE_ORDER.forEach(function (k) { eff[k] = cust[k] || auto[k]; });
    const c = h('div.card');
    c.appendChild(h('div.card-head', null,
      h('h3', { text: '写作分工' }),
      h('span.sp', null, chip(sel.length >= 2 ? ('勾了 ' + sel.length + ' 个模型')
        : (sel.length ? '1 个模型' : '还没勾模型'), sel.length >= 2 ? 'ok' : 'warn'))));
    /* 一、勾模型（和电脑端的勾选框一对一） */
    const ml = h('div.list.models');
    MODELS.forEach(function (k) { ml.appendChild(modelPickRow(k)); });
    c.appendChild(ml);
    c.appendChild(h('div.footnote', { text: '勾选的模型会按角色分工（策划 / 写作 / 审查 / 润色）协作；勾了 DeepSeek 就由 DeepSeek 主写' }));
    /* 二、谁干什么：跟电脑端一样，只看勾了几个模型。
       勾 2 ~ 3 个才能自己分工；只勾 1 个就是它一个人全包，不给下拉。 */
    if (sel.length >= 2) {
      const l = h('div.list');
      ROLE_ORDER.forEach(function (k) {
        l.appendChild(li({ title: ROLE_LABEL[k], right: roleSelect(k, sel, eff) }));
      });
      c.appendChild(l);
      c.appendChild(h('div.footnote', { text: '自己定谁干什么；不动就是系统默认（勾了 DeepSeek 就由它主写）' }));
    } else {
      c.appendChild(h('div.footnote', { text: sel.length
        ? ('只勾了 1 个模型：策划、写作、审查、润色全交给 ' + mLabel(eff.write)
           + ' 一个人干，再勾一个模型就能分工。')
        : '还没勾任何模型：至少勾一个才能写。' }));
    }
    /* 三、写作策略等（电脑端同一张卡片里的那一组） */
    const wl = h('div.list');
    wl.appendChild(pickRow('写作策略', '默认按每本书自己的设置', strategyWord(settings), STRATEGY_ITEMS,
      'gen_strategy', function (v) { saveSetting('gen_strategy', v, '写作策略已更新'); }, 'target'));
    wl.appendChild(pickRow('模型调用并发', '撞限流会自动退回一个个来', concWord(settings), CONC_ITEMS,
      'llm_concurrency', function (v) { saveSetting('llm_concurrency', v, '调用并发已更新'); }, 'bolt'));
    wl.appendChild(pickRow('单章失败自动重试', '写崩了自动再试几次', (settings.auto_retry || '2') + ' 次', RETRY_ITEMS,
      'auto_retry', function (v) { saveSetting('auto_retry', v, '重试次数已更新'); }, 'refresh'));
    wl.appendChild(pickRow('并发写书数', '无人值守续写时同时写几本', (settings.gen_workers || '2') + ' 本', BOOK_WORKER_ITEMS,
      'gen_workers', function (v) { saveSetting('gen_workers', v, '并发写书数已更新'); }, 'layers'));
    wl.appendChild(swRow('快速模式', '跳过模型深度去AI化，只做规则清洗，快很多',
      settings.fast_mode === '1', flagSetting('fast_mode', '快速模式'), 'fire'));
    wl.appendChild(swRow('字数不达标自动补写', '推荐开着，免得每章都差几百字',
      settings.quality_gate === '1', flagSetting('quality_gate', '自动补写'), 'plus'));
    wl.appendChild(swRow('每章写完自动更新前情摘要', '关掉更省钱，但前后连贯性会下降',
      settings.summary_update === '1', flagSetting('summary_update', '前情摘要'), 'history'));
    wl.appendChild(swRow('本地演示模式', '不调用模型，用样例文本跑通全流程，用来试操作',
      settings.demo_mode === '1', flagSetting('demo_mode', '演示模式'), 'play'));
    c.appendChild(wl);
    return c;
  }

  /* ---- 模型详情（密钥由电脑端管理，手机上只能看不能改） ---- */
  function openProvider(k) {
    const info = ((A.state.hero && A.state.hero.providers) || {})[k] || {};
    const s = settingsOf();
    const has = hasKey(s, k);
    let urlEl = null, nameEl = null;
    const sb = sheet({
      title: mLabel(k) + ' · 模型详情',
      build: function (b) {
        b.appendChild(h('div.fld-hint', { text: '密钥在电脑端统一管理，手机上不能改。这里只能看配没配、用的哪个模型。' }));
        b.appendChild(li({ title: 'API Key', right: chip(has ? '已配置' : '未配置', has ? 'ok' : 'warn') }));
        urlEl = h('input.li-input', {
          type: 'text', autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false',
          placeholder: info.base_url || '', value: s[k + '_base_url'] || '', style: INPUT_STYLE,
        });
        b.appendChild(field('Base URL', urlEl));
        nameEl = h('input.li-input', {
          type: 'text', autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false',
          placeholder: info.model || '', value: s[k + '_model'] || '', style: INPUT_STYLE,
        });
        b.appendChild(field('模型名', nameEl));
        b.appendChild(buttons([
          { label: '保存', tone: 'primary', onTap: save },
          { label: '测连通性', onTap: function () { sb.close(); testProvider(k, mLabel(k)); } },
        ]));
        b.appendChild(h('div.footnote', { text: '模型名留空就用官方默认：' + (info.model || '') + '。要换密钥，请到电脑端的「设置 · 模型」里改。' }));
      },
    });
    async function save() {
      const patch = {};
      patch[k + '_base_url'] = urlEl.value.trim() || info.base_url || '';
      patch[k + '_model'] = nameEl.value.trim() || info.model || '';
      const ok = await putSettings(patch, mLabel(k) + ' 配置已保存');
      if (ok) { sb.close(); A.render(); }
    }
  }

  /* ---- 质检评分模型 ---- */
  function reviewModelSheet() {
    sheet({
      title: '质检评分模型',
      build: function (b) {
        const paint = function () {
          const s = settingsOf();
          const rev = splitModels(s.review_models);
          clear(b);
          b.appendChild(h('div.fld-hint', { text: '勾上的模型会同时给同一段文字打分，再按维度取中位数；只选一个就一个模型评，最省钱。' }));
          const l = h('div.list');
          MODELS.forEach(function (k) {
            const on = rev.indexOf(k) >= 0;
            const row = h('div.li.tap', null,
              h('div.li-main', null,
                h('div.li-title', { text: mLabel(k) }),
                h('div.li-sub', { text: hasKey(s, k) ? '已配置' : '密钥未配置 · 请到电脑端设置（勾了也不会真的评）' })),
              h('div.li-right', null, h('span.chk' + (on ? '.on' : ''), null, on ? icon('check', { size: 14, w: 3 }) : null)));
            row.addEventListener('click', function () {
              haptic('light');
              const cur = splitModels(settingsOf().review_models);
              const isOn = cur.indexOf(k) >= 0;
              if (isOn && cur.length === 1) { toast('至少留一个模型来评分', 'bad'); return; }
              const next = MODELS.filter(function (m) { return (m === k ? !isOn : cur.indexOf(m) >= 0); });
              putSettings(one('review_models', next.join(',')), null).then(function (ok) { if (ok) { paint(); A.render(); } });
            });
            l.appendChild(row);
          });
          b.appendChild(l);
          const follow = sameSet(rev, splitModels(settingsOf().selected_models));
          b.appendChild(h('div.footnote', { text: follow
            ? '现在跟「使用的模型」完全一致——写作那边改了勾选，这里会一起变。'
            : '已经跟「使用的模型」不一样了：质检只用这里勾的这几个。' }));
          b.appendChild(buttons([{
            label: '跟「使用的模型」保持一致',
            onTap: function () {
              const next = splitModels(settingsOf().selected_models);
              if (!next.length) { toast('先去「使用的模型」勾几个', 'bad'); return; }
              putSettings(one('review_models', next.join(',')), '已跟写作模型保持一致')
                .then(function (ok) { if (ok) { paint(); A.render(); } });
            },
          }]));
        };
        paint();
      },
    });
  }

  /* ---- 词表 ---- */
  function wordSheet() {
    let ta = null;
    const sb = sheet({
      title: '去AI化词表',
      build: function (b) {
        b.appendChild(h('div.fld-hint', { text: '每行一条：原词=替换词；只写原词表示直接删掉。这些不花模型钱，写完自动清洗。' }));
        ta = h('textarea.li-input', { placeholder: '空气中弥漫着=空气里有', style: TEXTAREA_STYLE });
        ta.value = String(settingsOf().ai_words_extra || '');
        b.appendChild(ta);
        b.appendChild(buttons([{
          label: '保存', tone: 'primary',
          onTap: function () {
            putSettings(one('ai_words_extra', ta.value), '词表已保存')
              .then(function (ok) { if (ok) { sb.close(); A.render(); } });
          },
        }]));
      },
    });
  }
  function complianceSheet() {
    let extra = null, allow = null;
    const sb = sheet({
      title: '合规预检词表',
      build: function (b) {
        b.appendChild(h('div.fld-hint', { text: '内置政治敏感 / 涉黄 / 暴力 / 违法犯罪 / 医疗药品 / 金融投资 / 广告法禁用 / 站外引流八类词表，本机跑，不联网不花钱。这里是自己加的和放行的。' }));
        extra = h('textarea.li-input', { placeholder: '例：榜一大哥，老铁们', style: TEXTAREA_STYLE });
        extra.value = String(settingsOf().compliance_extra || '');
        b.appendChild(field('追加要避开的词（逗号或换行分隔）', extra));
        allow = h('textarea.li-input', { placeholder: '例：最好，最佳', style: TEXTAREA_STYLE });
        allow.value = String(settingsOf().compliance_allow || '');
        b.appendChild(field('放行名单（这些词不再报警）', allow));
        b.appendChild(buttons([{
          label: '保存', tone: 'primary',
          onTap: function () {
            putSettings({ compliance_extra: extra.value, compliance_allow: allow.value }, '合规词表已保存')
              .then(function (ok) { if (ok) { sb.close(); A.render(); } });
          },
        }]));
      },
    });
  }

  /* ---- 外观（跟随系统 / 浅色 / 深色） ---- */
  function themeWord() {
    const p = A.getTheme();
    if (p === 'system') return '跟随系统（当前' + (A.isLightTheme() ? '浅色' : '深色') + '）';
    return p === 'light' ? '浅色' : '深色';
  }
  function appearanceCard() {
    const c = h('div.card');
    c.appendChild(h('div.card-head', null, h('h3', { text: '外观' }), h('span.sp', { text: themeWord() })));
    c.appendChild(A.seg([
      { key: 'system', label: '跟随系统' },
      { key: 'light', label: '浅色' },
      { key: 'dark', label: '深色' },
    ], A.getTheme(), function (k) {
      A.applyTheme(k);
      toast('外观：' + ({ system: '跟随系统', light: '浅色', dark: '深色' })[k], 'ok');
      A.render();
    }));
    c.appendChild(h('div.footnote', { text: '选「跟随系统」时，手机在设置里切深色 / 浅色，App 会立刻跟着换，不用再手动调一次。' }));
    return c;
  }

  /* ============================== 钱包与订阅 ==============================
     1 墨币 = 0.01 元。数字全部来自 /api/billing/*，界面不写死。
     永久会员（白名单账号）一样进得来：看得到会员身份、价目和用量，只是不出现充值按钮。 */
  const BILL_CHARGE_ST = { charged: ['已扣费', ''], vip: ['会员免费', 'ok'], free: ['免计费', ''],
                           refunded: ['已退款', 'warn'], failed: ['未扣费', 'bad'] };
  const BILL_KIND = { signup: '注册赠送', recharge: '充值', charge: '扣费',
                      refund: '退款', admin_adjust: '后台调整' };

  function bNum(v) {
    const n = Math.round((Number(v) || 0) * 100) / 100;
    const s = (n === Math.round(n)) ? String(Math.round(n)) : n.toFixed(2);
    return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function bYuan(coins, per) { return ((Number(coins) || 0) / (Number(per) || 100)).toFixed(2); }
  function bWhen(s) { return String(s || '').slice(5, 16); }

  async function loadBill() {
    try { A.state.bill = await api.get('/api/billing/status'); }
    catch (e) { A.state.bill = null; }
  }

  function billEntryCard() {
    const b = A.state.bill;
    let sub = '余额、套餐与用量';
    let right = null;
    if (b && b.permanent_vip) {
      sub = '永久会员 · 全部功能免费，任务走 VIP 优先队列';
      right = chip('永久会员', 'ok');
    } else if (b) {
      right = h('span.num', { text: bNum(b.balance) + ' 墨币' });
      sub = (b.subscription && b.subscription.remaining >= 0)
        ? (b.subscription.label + '套餐 · 本月还剩 ' + b.subscription.remaining + ' 章')
        : ('余额 ≈ ' + bYuan(b.balance, b.coin_per_yuan) + ' 元，按量计费');
    }
    return card('钱包与订阅', null, [h('div.list', null,
      li({ ico: 'wallet', title: '钱包与订阅', sub: sub, right: right, arrow: true,
           onTap: function () { A.push(billScreen()); } }))]);
  }

  function billHead(st, per) {
    const vip = !!st.permanent_vip;
    const sub = st.subscription || null;
    const box = h('div.card');
    box.appendChild(h('div.card-head', null, h('h3', { text: '账户状态' }),
      h('span.sp', { text: vip ? '永久会员' : (st.enrolled ? '已开通计费' : '未开通计费 · 当前不扣费') })));
    if (vip) {
      box.appendChild(h('div.vipbox', null,
        h('b', { text: '永久会员' }),
        h('span', { text: '全部功能免费、不扣墨币，任务走 VIP 优先队列。' })));
    }
    const kpis = A.kpi([
      { label: '墨币余额', value: bNum(st.balance), unit: ' 墨币',
        tone: vip ? 'accent' : (st.balance > 0 ? 'accent' : 'bad') },
      { label: '订阅剩余', value: sub ? String(sub.remaining) : '—', unit: sub ? ' 章' : '' },
    ]);
    kpis.classList.add('k2');
    box.appendChild(kpis);
    box.appendChild(h('div.footnote', { text: '1 墨币 = 0.01 元 · 余额 ≈ ' + bYuan(st.balance, per)
      + ' 元 · 失败任务自动全额退款' }));
    return box;
  }

  function billTiers(pr) {
    const grid = h('div.tiers');
    (pr.tiers || []).forEach(function (t, i) {
      const total = (t.coins || 0) + (t.bonus || 0);
      const btn = h('button.tier', { type: 'button' },
        h('span.t-yuan', { text: t.yuan + ' 元' }),
        h('span.t-coins', null, h('b', { text: bNum(total) }), h('i', { text: '墨币' })),
        h('span.t-bonus', { text: t.bonus ? ('送 ' + bNum(t.bonus)) : '无赠送' }));
      btn.addEventListener('click', function () {
        haptic('light');
        billOrder('recharge', { tier: i, channel: 'wechat' },
          '充值 ' + t.yuan + ' 元 → ' + bNum(total) + ' 墨币');
      });
      grid.appendChild(btn);
    });
    return card('充值墨币', '长期有效 · 不清零', [grid,
      h('div.footnote', { text: '注册直接送 ' + bNum(pr.signup_bonus || 0)
        + ' 墨币。支付渠道接入前，下单后把订单号交给管理员确认到账。' })]);
  }

  function billPlans(pr, onChange) {
    let annual = false;
    const segBox = h('div');
    const gridBox = h('div.tiers.plans');
    function paint() {
      clear(segBox);
      segBox.appendChild(A.seg([{ key: 'm', label: '按月' }, { key: 'y', label: '包年 8 折' }],
        annual ? 'y' : 'm', function (k) { annual = (k === 'y'); paint(); if (onChange) onChange(); }));
      clear(gridBox);
      (pr.plans || []).forEach(function (p) {
        const yuan = annual ? p.annual_yuan : p.yuan;
        const unit = annual ? '年' : '月';
        const btn = h('button.tier', { type: 'button' },
          h('span.t-yuan', null, h('b', { text: bNum(yuan) }), h('i', { text: ' 元/' + unit })),
          h('span.t-coins', null, h('b', { text: String(p.chapters) }), h('i', { text: ' 章/' + unit })),
          h('span.t-bonus', { text: p.label + (p.vip ? ' · VIP 队列' : '') + (p.shared ? ' · 团队共享' : '')
            + (annual && p.annual_save ? ' · 省 ' + bNum(p.annual_save) + ' 元' : '') }));
        btn.addEventListener('click', function () {
          haptic('light');
          billOrder('subscription', { plan: p.plan, months: 1, annual: annual, channel: 'alipay' },
            p.label + '套餐 · 1 ' + unit + '（' + bNum(yuan) + ' 元）');
        });
        gridBox.appendChild(btn);
      });
    }
    paint();
    return card('订阅套餐', '包年 8 折', [segBox, gridBox,
      h('div.footnote', { text: '先扣订阅额度（按月清零），用完的部分从钱包按 8 折扣墨币。' })]);
  }

  function billPriceCard(pr) {
    const models = pr.models || {};
    const order = ['deepseek', 'mimo', 'doubao'];
    const name = { deepseek: 'DeepSeek', mimo: 'MiMo', doubao: '豆包' };
    const wrap = h('div.price-table');
    wrap.appendChild(h('div.pt-head', null, h('span', { text: '功能' }),
      order.map(function (m) { return h('span', { text: name[m] + ' ×' + (models[m] || 1) }); })));
    (pr.actions || []).forEach(function (a) {
      wrap.appendChild(h('div.pt-row', null,
        h('span.pt-name', { text: a.label || a.action }),
        order.map(function (m) {
          return h('span', { text: bNum((a.by_model || {})[m] || a.coins) });
        })));
    });
    return card('价目表', bNum(pr.base_words || 2000) + ' 字基准章', [wrap,
      h('div.footnote', { text: '超出 ' + bNum(pr.base_words || 2000) + ' 字，每 100 字加 '
        + bNum(pr.extra_coin_per_100 || 0) + ' 墨币（单位：墨币）。' })]);
  }

  function billUsageCard(lg) {
    const charges = (lg && lg.charges) || [];
    const ledger = (lg && lg.ledger) || [];
    const list = h('div.list');
    if (!charges.length) list.appendChild(li({ title: '还没有计费记录', sub: '写作 / 体检之后这里会有明细' }));
    charges.forEach(function (c) {
      const stt = BILL_CHARGE_ST[c.status] || [c.status || '—', ''];
      const how = [];
      if (c.from_sub_units) how.push('订阅 ' + c.from_sub_units + ' 章');
      if (c.from_wallet_coins) how.push(bNum(c.from_wallet_coins) + ' 墨币');
      list.appendChild(li({
        ico: 'dot',
        title: (c.label || c.action || '—') + (c.provider ? ' · ' + c.provider : ''),
        sub: bWhen(c.created_at) + (how.length ? ' · ' + how.join(' + ') : ''),
        right: chip(stt[0], stt[1]),
      }));
    });
    const l2 = h('div.list');
    if (!ledger.length) l2.appendChild(li({ title: '钱包还没有流水' }));
    ledger.forEach(function (r) {
      const amt = Number(r.amount) || 0;
      l2.appendChild(li({
        ico: 'history',
        title: (BILL_KIND[r.kind] || r.kind || '—') + (r.note ? ' · ' + String(r.note).slice(0, 30) : ''),
        sub: bWhen(r.ts),
        right: h('span.num', { text: (amt > 0 ? '+' : '') + bNum(amt) + ' · 余 ' + bNum(r.balance_after) }),
      }));
    });
    return frag2(card('用量明细', '最近 ' + charges.length + ' 次', [list]),
                 card('钱包流水', '最近 ' + ledger.length + ' 笔', [l2]));
  }

  /* 两张卡一起返回：frag 会在挂载时把子节点摊平 */
  function frag2(a, b) { const f = h('div'); f.appendChild(a); f.appendChild(b); return f; }

  function billOrder(kind, body, label) {
    const url = kind === 'recharge' ? '/api/billing/recharge' : '/api/billing/subscribe';
    return api.post(url, body).then(function (d) {
      const o = (d && d.order) || {};
      const s = sheet({ title: '订单已生成', build: function (b) {
        b.appendChild(li({ title: '订单号', right: h('span.num', { text: o.order_no || '—' }) }));
        b.appendChild(li({ title: '内容', right: h('span', { text: label }) }));
        b.appendChild(li({ title: '金额', right: h('span.num', { text: bNum(o.amount_yuan) + ' 元' }) }));
        b.appendChild(h('div.footnote', { text: '微信 / 支付宝回调还没接上，所以现在只生成订单、不真扣钱。' +
          '把订单号发给管理员，后台确认到账后立刻生效。' }));
        b.appendChild(buttons([{ label: '知道了', tone: 'primary', onTap: function () { s.close(); } }]));
      } });
    }).catch(function (e) { toast(e.message, 'bad'); });
  }

  function billScreen() {
    return {
      title: '钱包与订阅',
      async mount(body) {
        const out = h('div.pad');
        const r = await Promise.all([
          api.get('/api/billing/status'),
          api.get('/api/billing/pricing'),
          api.get('/api/billing/ledger').catch(function () { return {}; }),
        ]);
        const st = r[0] || {};
        const pr = (r[1] && r[1].pricing) || st.pricing || {};
        const lg = r[2] || {};
        A.state.bill = st;
        const per = st.coin_per_yuan || pr.coin_per_yuan || 100;
        const vip = !!st.permanent_vip;
        out.appendChild(billHead(st, per));
        if (vip) {
          out.appendChild(card('永久会员', '无需充值', [
            h('div.small.muted', { text: '你是永久会员：不需要充值，也不用买套餐。下面是完整价目和用量明细，' +
              '方便你随时核对规则；每一笔会员用量都记成「会员免费」，不扣任何额度。' })]));
        } else {
          out.appendChild(billTiers(pr));
          out.appendChild(billPlans(pr));
        }
        out.appendChild(billPriceCard(pr));
        out.appendChild(billUsageCard(lg));
        return out;
      },
    };
  }

})();
