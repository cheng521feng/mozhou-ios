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
            h('div.small.muted', { text: '去书架点顶部的「补更」，或者在作品页点「补更（续写）」；跑起来之后这里会实时显示进度、当前章节和正在调用的模型。' }),
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

        /* 我的资料（头像 / 用户名 / 性别 / 年龄） */
        out.appendChild(profileCard());

        /* 账号 */
        const acct = h('div.card');
        acct.appendChild(h('div.card-head', null,
          h('h3', { text: '账号与同步' }),
          chip(cloudLabel(), 'ok', 'cloud')));
        acct.appendChild(h('div.small.muted', { text: '手机和电脑登录同一个账号，看到的永远是同一份稿子；每一次保存都会自动同步。' }));
        acct.appendChild(buttons([
          { label: '退出登录', tone: 'danger', size: 'sm', onTap: function () { logout(); } },
          { label: '填访问口令', size: 'sm', onTap: function () { A.openTokenDialog().then(function (saved) { if (saved) A.refreshAll(false); }); } },
        ]));
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
        out.appendChild(acct);

        /* 正在跑 / 排队 */
        if (A.liveBusy(A.state.live)) {
          out.appendChild(h('div.section-title', { text: '实时状态' }));
          out.appendChild(MZUI.liveHero(A.state.live, { maxEvents: 4 }));
        }

        /* 使用的模型：勾几个就调几个，谁干什么由 App 自动分配 */
        out.appendChild(h('div.section-title', null,
          h('span', { text: '使用的模型' }),
          h('span.sp', { text: '勾几个就调几个' })));
        const ml = h('div.list.models');
        MODELS.forEach(function (k) { ml.appendChild(modelPickRow(k)); });
        out.appendChild(ml);
        out.appendChild(roleCard());

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

        /* 写作设置（跟电脑端设置页同一套项，改完立即生效） */
        out.appendChild(h('div.section-title', { text: '写作设置' }));
        const wl = h('div.list');
        wl.appendChild(pickRow('写作策略', '默认按每本书自己的设置', strategyWord(settings), STRATEGY_ITEMS,
          'gen_strategy', function (v) { saveSetting('gen_strategy', v, '写作策略已更新'); }));
        wl.appendChild(pickRow('模型调用并发', '撞限流会自动退回一个个来', concWord(settings), CONC_ITEMS,
          'llm_concurrency', function (v) { saveSetting('llm_concurrency', v, '调用并发已更新'); }));
        wl.appendChild(pickRow('单章失败自动重试', '写崩了自动再试几次', (settings.auto_retry || '2') + ' 次', RETRY_ITEMS,
          'auto_retry', function (v) { saveSetting('auto_retry', v, '重试次数已更新'); }));
        wl.appendChild(pickRow('并发写书数', '无人值守续写时同时写几本', (settings.gen_workers || '2') + ' 本', BOOK_WORKER_ITEMS,
          'gen_workers', function (v) { saveSetting('gen_workers', v, '并发写书数已更新'); }));
        wl.appendChild(swRow('快速模式', '跳过模型深度去AI化，只做规则清洗，快很多',
          settings.fast_mode === '1', flagSetting('fast_mode', '快速模式')));
        wl.appendChild(swRow('字数不达标自动补写', '推荐开着，免得每章都差几百字',
          settings.quality_gate === '1', flagSetting('quality_gate', '自动补写')));
        wl.appendChild(swRow('每章写完自动更新前情摘要', '关掉更省钱，但前后连贯性会下降',
          settings.summary_update === '1', flagSetting('summary_update', '前情摘要')));
        wl.appendChild(swRow('本地演示模式', '不调用模型，用样例文本跑通全流程，用来试操作',
          settings.demo_mode === '1', flagSetting('demo_mode', '演示模式')));
        out.appendChild(wl);

        /* 质检设置 */
        out.appendChild(h('div.section-title', { text: '质检设置' }));
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
          'hit_review_scope', function (v) { saveSetting('hit_review_scope', v, '质检范围已更新'); }));
        ql.appendChild(swRow('评分不思考', '纯按评分标准判断，快 5~10 倍还省钱',
          settings.hit_review_fast !== '0', flagSetting('hit_review_fast', '评分不思考')));
        ql.appendChild(pickRow('同时评几章', '同时评得多容易被限流', (settings.hit_review_workers || '2') + ' 章',
          REVIEW_WORKER_ITEMS, 'hit_review_workers', function (v) { saveSetting('hit_review_workers', v, '质检并发已更新'); }));
        ql.appendChild(swRow('局部重写后自动复评', '改完自动再评一次，看到改前改后差多少分',
          settings.hit_review_auto !== '0', flagSetting('hit_review_auto', '自动复评')));
        out.appendChild(ql);

        /* 词表与合规 */
        out.appendChild(h('div.section-title', { text: '词表与合规' }));
        const cl = h('div.list');
        cl.appendChild(li({ ico: 'edit', title: '去AI化词表',
          sub: wordCount(settings.ai_words_extra, '还没加自定义词'), arrow: true, onTap: wordSheet }));
        cl.appendChild(li({ ico: 'shield', title: '合规预检词表',
          sub: '自己加的雷区词 / 误报放行名单', arrow: true, onTap: complianceSheet }));
        out.appendChild(cl);

        /* 数据与备份 */
        out.appendChild(h('div.section-title', { text: '数据与备份' }));
        const bl = h('div.list');
        bl.appendChild(li({ ico: 'cloud', title: '立即备份数据库', sub: '备份存在云服务器上', arrow: true, onTap: doBackup }));
        bl.appendChild(li({ ico: 'history', title: '查看备份列表', arrow: true, onTap: showBackups }));
        bl.appendChild(li({ ico: 'download', title: '导出这本书', sub: '选一本导成 txt', arrow: true, onTap: pickExport }));
        bl.appendChild(li({ ico: 'trash', title: '回收站', sub: '删掉的作品 / 章节在这里，能恢复', arrow: true, onTap: showTrash }));
        out.appendChild(bl);

        /* 应用与显示 */
        out.appendChild(h('div.section-title', { text: '应用与显示' }));
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

  function roleHint(s, act) {
    const gs = String(s.gen_strategy || '').trim();
    if (MODELS.indexOf(gs) >= 0) {
      return '「写作策略」选了只用 ' + mLabel(gs)
        + '，所以不管勾了几个，写作都只用它。想按勾选分工，把写作策略改回「按作品设置」。';
    }
    if (act.length === 1) {
      return '只勾了 1 个模型，从策划、写作到审查、润色全交给 ' + mLabel(act[0])
        + ' 一个人干。勾 2 个会分成「写的」和「审的」，勾 3 个各干各拿手的。';
    }
    if (act.indexOf('deepseek') >= 0) {
      return '勾了 DeepSeek 就由它主写：从落笔到润色都是这一支笔，语气和节奏接得上；'
        + '点子和挑毛病交给别的模型。';
    }
    if (act.length === 2) {
      return '两个模型分工：一个负责想点子和落笔，一个负责挑毛病和润色。再勾上一个就变成三个各干各拿手的。';
    }
    return '三个模型各干各拿手的。';
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
  function swRow(title, sub, on, onTap) {
    const row = h('div.li.tap', null,
      h('div.li-main', null,
        h('div.li-title', { text: title }),
        sub ? h('div.li-sub', { text: sub }) : null),
      h('div.li-right', null, h('span.sw' + (on ? '.on' : ''), null, h('i'))));
    row.addEventListener('click', function () { haptic('light'); onTap(!on); });
    return row;
  }
  function pickRow(title, sub, value, items, key, after) {
    return li({
      title: title, sub: sub, right: h('span', { text: value }), arrow: true,
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

  /* ---- 「使用的模型」块 ---- */
  function modelPickRow(k) {
    const s = settingsOf();
    const on = splitModels(s.selected_models).indexOf(k) >= 0;
    const has = hasKey(s, k);
    const info = ((A.state.hero && A.state.hero.providers) || {})[k] || {};
    const row = h('div.li.tap', null,
      h('div.li-ico', null, icon('spark', { size: 20 })),
      h('div.li-main', null,
        h('div.li-title', { text: mLabel(k) }),
        h('div.li-sub', { text: has ? (info.model || '已配置') : '还没填 API Key' })),
      h('div.li-right', null,
        h('button.mini', {
          type: 'button', text: has ? '改' : '填 Key',
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
    const ok = await putSettings(patch, mLabel(k) + (has ? ' 已取消' : ' 已勾选'));
    if (ok) A.render();
  }
  function roleCard() {
    const s = settingsOf();
    const act = activeModels(s);
    const c = h('div.card');
    c.appendChild(h('div.card-head', null,
      h('h3', { text: '谁干什么' }),
      h('span.sp', null, chip(act.length ? ('会调用 ' + act.length + ' 个模型') : '没有可用的模型',
        act.length ? 'ok' : 'warn'))));
    if (!act.length) {
      c.appendChild(h('div.small.muted', { text: '一个 API Key 都没配。点上面模型右边的「填 Key」随便配一个，就能开始写了。' }));
      return c;
    }
    const r = assignRoles(act);
    const l = h('div.list');
    ROLE_ORDER.forEach(function (k) {
      l.appendChild(li({ title: ROLE_LABEL[k], right: h('span', { text: mLabel(r[k]) }) }));
    });
    c.appendChild(l);
    c.appendChild(h('div.footnote', { text: roleHint(s, act) }));
    return c;
  }

  /* ---- 模型详情（填 Key / 改模型名 / 测连通性） ---- */
  function openProvider(k) {
    const info = ((A.state.hero && A.state.hero.providers) || {})[k] || {};
    const s = settingsOf();
    const has = hasKey(s, k);
    let keyEl = null, urlEl = null, nameEl = null;
    const sb = sheet({
      title: mLabel(k) + ' · 模型配置',
      build: function (b) {
        b.appendChild(h('div.fld-hint', { text: 'API Key 存在云服务器上，手机上只显示「已配置」，看不到原来的值；粘一个新的就能换掉。' }));
        keyEl = h('input.li-input', {
          type: 'password', autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false',
          placeholder: has ? '已配置（粘贴新的可覆盖）' : '粘贴 API Key', style: INPUT_STYLE,
        });
        b.appendChild(field('API Key', keyEl));
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
        b.appendChild(h('div.footnote', { text: '模型名留空就用官方默认：' + (info.model || '') + '。换 Key 不影响别的模型。' }));
      },
    });
    async function save() {
      const patch = {};
      if (keyEl.value.trim()) patch[k + '_api_key'] = keyEl.value.trim();
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
                h('div.li-sub', { text: hasKey(s, k) ? '已配置' : '还没填 API Key（勾了也不会真的评）' })),
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

})();
