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
        const live = A.state.live || {};

        if (A.liveBusy(live)) {
          out.appendChild(MZUI.liveHero(live, { maxEvents: 12 }));
          const ops = MZUI.opsNode(live);
          if (ops) {
            out.appendChild(h('div.section-title', { text: '正在跑的功能' }));
            out.appendChild(ops);
          }
        } else {
          out.appendChild(h('div.card', null,
            h('div.card-head', null, h('h3', { text: '当前没有任务在跑' }), h('span.sp', null, h('span.dot', { style: { opacity: '.35' } }))),
            h('div.small.muted', { text: '去书架点「补更（续写）」或总览点「跑今日自动更新」，这里就会实时显示进度、当前章节和正在调用的模型。' }),
            buttons([{ label: '去书架', tone: 'primary', onTap: function () { A.switchTab('books'); } }])));
        }

        const d = await api.get('/api/jobs?limit=30');
        const jobs = d.jobs || [];
        out.appendChild(h('div.section-title', null, h('span', { text: '最近任务' }), h('span.sp', { text: '近 ' + jobs.length + ' 条' })));
        if (!jobs.length) { out.appendChild(emptyBox('jobs', '还没有任务记录', '发起一次补更就会出现在这里')); return out; }
        jobs.forEach(function (j) { out.appendChild(jobCard(j)); });
        return out;
      },
    };
  };
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

        /* 账号 */
        const acct = h('div.card');
        acct.appendChild(h('div.card-head', null,
          h('h3', { text: '账号与同步' }),
          chip(cloudLabel(), 'ok', 'cloud')));
        acct.appendChild(h('div.small.muted', { text: '手机和电脑登录同一个账号，看到的永远是同一份稿子；每一次保存都会同步到云端。' }));
        acct.appendChild(buttons([
          { label: '退出登录', tone: 'danger', size: 'sm', onTap: function () { logout(); } },
          { label: '填访问口令', size: 'sm', onTap: function () { A.openTokenDialog().then(function (saved) { if (saved) A.refreshAll(false); }); } },
        ]));
        out.appendChild(acct);

        /* 正在跑 / 排队 */
        if (A.liveBusy(A.state.live)) {
          out.appendChild(h('div.section-title', { text: '实时状态' }));
          out.appendChild(MZUI.liveHero(A.state.live, { maxEvents: 4 }));
        }

        /* 模型与密钥 */
        out.appendChild(h('div.section-title', { text: '模型与密钥' }));
        const ml = h('div.list');
        Object.keys(providers).forEach(function (k) {
          const info = providers[k] || {};
          const hasKey = settings['has_' + k + '_api_key'];
          ml.appendChild(li({
            ico: 'spark',
            title: info.label || k,
            sub: (info.model || '当前模型') + (hasKey ? '' : ' · 还没填 Key'),
            right: chip(hasKey ? '已配置' : '未配置', hasKey ? 'ok' : 'warn'),
            arrow: true,
            onTap: function () { testProvider(k, info.label || k); },
          }));
        });
        out.appendChild(ml);
        out.appendChild(h('div.footnote', { text: '点一个模型可以立刻测一次连通性；换 Key、改模型请到桌面版设置里改。' }));

        /* 用量 */
        const u = hero.usage || {};
        const byP = u.by_provider || [];
        if (byP.length) {
          out.appendChild(h('div.section-title', { text: '模型用量' }));
          const uc = card(null, null, null);
          const max = byP.reduce(function (m, x) { return Math.max(m, x.calls || 0); }, 0) || 1;
          byP.forEach(function (x) {
            uc.appendChild(h('div.usage-row', null,
              h('span.ur-k', { text: (providers[x.provider] && providers[x.provider].label) || x.provider }),
              h('span.ur-b', null, bar((x.calls || 0) / max * 100)),
              h('span.ur-v', { text: fmtNum(x.calls || 0) + ' 次' })));
          });
          uc.appendChild(h('div.live-nums.mt12', null,
            h('span', { text: '累计 ' + fmtNum(u.total_calls || 0) + ' 次调用' }),
            h('span', { text: '生成 ' + fmtNum(u.completion_chars || 0) + ' 字' }),
            (u.elapsed_ms ? h('span', { text: '耗时 ' + fmtDur(Math.round((u.elapsed_ms || 0) / 1000)) }) : null)));
          out.appendChild(uc);
        }

        /* 数据与备份 */
        out.appendChild(h('div.section-title', { text: '数据与备份' }));
        const bl = h('div.list');
        bl.appendChild(li({ ico: 'cloud', title: '立即备份数据库', sub: '备份存在云服务器上', arrow: true, onTap: doBackup }));
        bl.appendChild(li({ ico: 'history', title: '查看备份列表', arrow: true, onTap: showBackups }));
        bl.appendChild(li({ ico: 'download', title: '导出这本书', sub: '选一本导成 txt', arrow: true, onTap: pickExport }));
        out.appendChild(bl);

        /* 应用与显示 */
        out.appendChild(h('div.section-title', { text: '应用与显示' }));
        const al = h('div.list');
        al.appendChild(li({
          ico: getTheme() === 'light' ? 'sun' : 'moon',
          title: '外观',
          right: h('span', { text: A.getTheme() === 'light' ? '浅色' : '深色' }),
          arrow: true,
          onTap: function () {
            const next = A.getTheme() === 'light' ? 'dark' : 'light';
            A.applyTheme(next);
            toast('已切换为' + (next === 'dark' ? '深色' : '浅色'), 'ok');
            A.render();
          },
        }));
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
          sub: settings.auto_enabled ? ('每天 ' + (settings.auto_time || '08:00') + ' 自动写') : '当前关闭',
          right: chip(settings.auto_enabled ? '已开启' : '已关闭', settings.auto_enabled ? 'ok' : ''),
        }));
        out.appendChild(al);

        /* 关于 */
        out.appendChild(h('div.section-title', { text: '关于' }));
        const gl = h('div.list');
        gl.appendChild(li({ ico: 'dot', title: '服务端版本', right: h('span.num', { text: A.state.version || '—' }) }));
        gl.appendChild(li({ ico: 'books', title: '作品 / 章节', right: h('span.num', { text: (st.novels || 0) + ' 本 / ' + (st.chapters || 0) + ' 章' }) }));
        gl.appendChild(li({ ico: 'write', title: '累计字数', right: h('span.num', { text: fmtWords(st.chars || 0) }) }));
        gl.appendChild(li({ ico: 'layers', title: '界面', right: h('span', { text: '移动端 v5 · 液态墨' }) }));
        out.appendChild(gl);
        out.appendChild(h('div.footnote', { text: '数据在云服务器上：手机和电脑登录同一个账号，看到的就是同一份稿子，会自动同步。' }));
        return out;
      },
    };
  };
  function getTheme() { return A.getTheme(); }
  function cloudLabel() {
    const c = String(MZ.CLOUD || '');
    if (!c) return '本地调试';
    return '云端已连接';
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
      const blob = await r.blob();
      const a = h('a', { href: URL.createObjectURL(blob), download: (n.title || 'novel') + '.txt' });
      document.body.appendChild(a); a.click(); a.remove();
      toast('已下载', 'ok');
    } catch (e) { toast('导出失败：' + e.message, 'bad'); }
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
})();