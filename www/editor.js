/* ==========================================================================
   墨舟移动端 · 写作台  editor.js  v5
   --------------------------------------------------------------------------
   这一版写作台只解决一件事：让人「心里有底」。
   · 全屏沉浸编辑，拇指可达的底部工具条，输入即自动保存。
   · 长操作（重生成 / 去 AI 化 / 起名 / 合规 / 钩子 / 读者视角 / 三模型评分）
     不再是一个转圈遮罩，而是底部常驻浮条：写清正在跑哪一步、跑了多久、
     到哪一步了，还能展开看运行日志 —— 你可以一边等一边继续写。
   · 检查面板收进一张底部抽屉，分「质检 / 爆款 / 合规 / 钩子 / 版本」。
   ========================================================================== */
'use strict';

window.MZEditor = (function () {
  const { h, clear, api, toast, sheet, actions, modal, confirm, haptic, icon, chip,
          fmtNum, fmtWords, fmtDur, timeAgo, emptyBox, loadingBox, errBox, sleep } = MZ;
  const A = window.MZApp;
  const { li, card, buttons, seg, busySheet, MZUI } = A;

  let selectedNovelId = null;

  /* ============================== 写作标签页 ============================== */
  A.screens.write = function () {
    return {
      title: '写作',
      action: null,
      async mount(body) {
        await A.ensureHero();
        const out = h('div.pad');
        const novels = A.state.novels || [];
        if (!novels.length) {
          out.appendChild(emptyBox('write', '还没有作品', '先建一本，再来这里写'));
          out.appendChild(buttons([{ label: '新建作品', tone: 'primary', onTap: function () { A.newNovel(); } }]));
          return out;
        }
        if (!selectedNovelId || !A.findNovel(selectedNovelId)) selectedNovelId = novels[0].id;

        /* 作品选择：横向滚动的胶囊 */
        const picker = h('div.pillbar');
        novels.forEach(function (n) {
          const b = h('button' + (n.id === selectedNovelId ? '.on' : ''), { type: 'button', text: n.title || '未命名' });
          b.addEventListener('click', function () { selectedNovelId = n.id; haptic('light'); A.render(); });
          picker.appendChild(b);
        });
        out.appendChild(picker);

        const d = await api.get('/api/novel/' + selectedNovelId);
        const n = d.novel || {};
        const need = planNeedOf(n);
        const made = (n.plan && n.plan.today_made) || 0;
        const daily = (n.plan && n.plan.daily) || n.daily_count || 0;

        /* 今日进度：一个环 + 一行说明 + 补更入口 */
        const live = (A.state.live || {});
        const rb = (live.books || []).filter(function (b) { return b.id === selectedNovelId; })[0];
        const hero = h('div.card');
        hero.appendChild(h('div.row', { style: { gap: '16px', alignItems: 'center' } },
          MZUI.ring(daily ? Math.min(100, (made / daily) * 100) : 0, '今日进度', 78, 'var(--accent)'),
          h('div.flex1', null,
            h('div', { style: { fontSize: '15.5px', fontWeight: '660' }, text: '《' + (n.title || '') + '》' }),
            h('div.small.muted.mt8', { text: '今日 ' + made + '/' + daily + ' 章 · 还差 ' + need + ' 章 · 全书 ' + (n.chapter_count || 0) + ' 章 ' + fmtNum(n.total_chars || 0) + ' 字' }),
            rb ? h('div.live-phase.mt8', { text: '正在跑：' + (rb.phase || '写作中') + (rb.current_idx ? ' · 第 ' + rb.current_idx + ' 章' : '') }) : null)));
        const heroActs = [{ label: '补更（续写）', tone: 'primary', onTap: function () { A.askUpdate(n); } }];
        if (live.running) heroActs.push({ label: '停止全部', tone: 'danger', size: 'sm', onTap: function () { A.stopAll(); } });
        hero.appendChild(buttons(heroActs));
        out.appendChild(hero);

        /* 正在写作时：把实时进度卡也放这儿，写作页不用切来切去 */
        if (A.liveBusy(live)) out.appendChild(h('div.mt12', null, MZUI.liveHero(live, { maxEvents: 4 })));

        const chapters = (n.chapters || []).slice().sort(function (a, b) { return b.idx - a.idx; });
        if (!chapters.length) {
          out.appendChild(emptyBox('write', '还没有章节', '点「补更（续写）」开始写第一章'));
          return out;
        }
        const scoreMap = {};
        (n.metrics || []).forEach(function (m) { scoreMap[m.idx] = m.score; });
        out.appendChild(h('div.section-title', null,
          h('span', { text: '最近章节' }), h('span.sp', { text: '点开就写 · 共 ' + chapters.length + ' 章' })));
        const l = h('div.list.rise-list');
        chapters.slice(0, 40).forEach(function (c, i) {
          const sc = scoreMap[c.idx];
          const row = li({
            title: '第 ' + c.idx + ' 章　' + (c.title || ''),
            sub: fmtNum(c.chars || 0) + ' 字 · ' + (c.updated_at ? timeAgo(c.updated_at) : ''),
            right: sc === undefined ? null : chip(String(Math.round(sc)), sc >= 75 ? 'ok' : (sc >= 55 ? '' : 'bad')),
            arrow: true,
            onTap: function () { openChapter(selectedNovelId, c.id, { title: c.title, idx: c.idx }); },
          });
          row.style.setProperty('--i', String(i));
          l.appendChild(row);
        });
        out.appendChild(l);
        if (chapters.length > 40) out.appendChild(buttons([{ label: '查看全部 ' + chapters.length + ' 章', onTap: function () { A.openBook(selectedNovelId); } }]));
        return out;
      },
    };
  };
  function planNeedOf(n) {
    const p = n.plan || {};
    if (p.need !== undefined && p.need !== null) return Math.max(0, Number(p.need) || 0);
    const daily = p.daily || n.daily_count || 0;
    return Math.max(0, daily - ((p.today_made === undefined ? (n.today_made || 0) : p.today_made)));
  }

  /* ============================== 渲染任意结构的检查结果 ============================== */
  const LABELS = {
    hits: '命中', hit: '命中', words: '词', word: '词', level: '级别', msg: '说明',
    problem: '问题', advice: '改法', suggest: '建议', suggestion: '建议', text: '内容',
    para: '段落', index: '位置', reason: '原因', score: '分数', total: '合计',
    ok: '通过', clean: '干净', category: '类别', type: '类型', fix: '改法',
    hook: '钩子', strong: '强度', verdict: '结论', candidates: '候选钩子',
    has_hook: '结尾有钩子', position: '位置', line: '行', paragraph: '段落',
  };
  function label(k) { return LABELS[k] || k; }
  function renderAny(v, depth) {
    depth = depth || 0;
    if (v === null || v === undefined) return h('div.small.dim', { text: '—' });
    if (typeof v === 'boolean') return chip(v ? '是' : '否', v ? 'ok' : 'warn');
    if (typeof v === 'number' || typeof v === 'string') return h('div.small.pre-wrap', { text: String(v) });
    if (Array.isArray(v)) {
      if (!v.length) return h('div.small.dim', { text: '（空）' });
      const l = h('div.list');
      v.forEach(function (it, i) {
        if (it !== null && typeof it === 'object') {
          const title = it.msg || it.problem || it.text || it.word || it.suggest || it.advice || ('第 ' + (i + 1) + ' 条');
          const subParts = Object.keys(it).filter(function (k) {
            const val = it[k];
            return k !== 'msg' && k !== 'problem' && k !== 'text' && k !== 'word'
              && (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean');
          }).map(function (k) { return label(k) + '：' + String(it[k]); });
          l.appendChild(li({ title: String(title), sub: subParts.join(' · ').slice(0, 160) }));
        } else l.appendChild(li({ title: String(it) }));
      });
      return l;
    }
    const l = h('div.list');
    Object.keys(v).forEach(function (k) {
      const val = v[k];
      if (val !== null && typeof val === 'object') {
        l.appendChild(h('div', { style: { padding: '12px 14px' } },
          h('div.small', { style: { fontWeight: '600', marginBottom: '6px' }, text: label(k) }),
          renderAny(val, depth + 1)));
      } else {
        l.appendChild(li({ title: label(k), right: h('span.small.num', { text: String(val) }) }));
      }
    });
    return l;
  }
  /* ============================== 编辑器 ============================== */
  let ed = null;

  async function openChapter(nid, cid, opt) {
    opt = opt || {};
    if (ed) return;
    const wrap = h('div.ed-wrap');
    document.body.appendChild(wrap);
    document.body.style.overflow = 'hidden';
    ed = { nid: nid, cid: cid, dirty: false, saving: false, data: null, wrap: wrap, op: null, timers: [] };

    /* --- 顶部：返回 / 章号 / 检查 --- */
    const nav = h('div.ed-nav');
    const navRow = h('div.nb-row');
    const back = h('button.nb-back', { type: 'button' }, h('span', { text: '‹' }));
    const navTitle = h('div.nb-title', { text: opt.title || (opt.idx ? '第 ' + opt.idx + ' 章' : '章节') });
    const navAct = h('button.nb-action', { type: 'button', text: '检查' });
    navRow.appendChild(back); navRow.appendChild(navTitle); navRow.appendChild(navAct);
    const meta = h('div.ed-meta');
    nav.appendChild(navRow); nav.appendChild(meta);

    const titleInput = h('input.ed-title', { type: 'text', placeholder: '章节标题', value: opt.title || '' });
    const textArea = h('textarea.ed-text', { placeholder: '在这里写正文…（输入会自动保存）', spellcheck: 'false' });
    const bodyBox = h('div.ed-body', null, titleInput, textArea);
    const toolbar = h('div.ed-toolbar');

    /* --- 底部常驻任务浮条：长操作的进度就长在这里 --- */
    const dbTitle = h('span.db-title', { text: '准备中' });
    const dbPct = h('span.db-pct', { text: '0%' });
    const dbChev = h('span.db-chev', null, icon('down', { size: 15 }));
    const dbFill = h('div.db-fill');
    const dbBody = h('div.db-body');
    const dbBodyWrap = h('div', { style: { display: 'none' } }, dbBody);
    const dbTop = h('div.db-top', null, h('span.live-dot'), dbTitle, dbPct, dbChev);
    const dock = h('div.dockbar', { hidden: true },
      dbTop, h('div.db-track', null, dbFill), dbBodyWrap);
    let dockOpen = false;
    dbTop.addEventListener('click', function () {
      dockOpen = !dockOpen;
      dock.classList.toggle('open', dockOpen);
      dbBodyWrap.style.display = dockOpen ? '' : 'none';
    });

    wrap.appendChild(nav); wrap.appendChild(bodyBox); wrap.appendChild(toolbar); wrap.appendChild(dock);

    /* --- 工具条 --- */
    function tb(label, tone, onTap) {
      const b = A._btn(label, tone, onTap, 'sm');
      toolbar.appendChild(b);
      return b;
    }
    tb('保存', 'primary', function () { save(true); });
    tb('重生成', '', function () { regen(); });
    tb('去 AI 化', '', function () { deai(); });
    tb('起名', '', function () { autoTitle(); });
    tb('检查', 'blue', function () { openInspect(); });
    tb('更多', '', function () { moreActions(); });

    /* --- 载入 --- */
    async function load() {
      try {
        const d = await api.get('/api/chapter/' + cid);
        ed.data = d;
        const ch = d.chapter || {};
        titleInput.value = ch.title || '';
        textArea.value = ch.content || '';
        navTitle.textContent = '第 ' + (ch.idx || '') + ' 章';
        ed.dirty = false;
        paintMeta();
      } catch (e) {
        clear(bodyBox);
        bodyBox.appendChild(errBox(e, load));
      }
    }
    function paintMeta() {
      const d = ed && ed.data ? ed.data : {};
      const m = d.metrics || {};
      const chars = textArea.value.replace(/\s/g, '').length;
      const target = d.target_words || (d.chapter && d.chapter.target_words) || 2500;
      clear(meta);
      meta.appendChild(chip(fmtNum(chars) + ' 字', chars >= target ? 'ok' : '', 'write'));
      meta.appendChild(chip('目标 ' + fmtNum(target), '', 'target'));
      if (m.score !== undefined && m.score !== null) {
        meta.appendChild(chip('质检 ' + Math.round(m.score), m.score >= 75 ? 'ok' : (m.score >= 55 ? '' : 'bad'), 'shield'));
      }
      if (d.weak && d.weak.length) meta.appendChild(chip(d.weak.length + ' 段可疑', 'amber', 'bolt'));
      if (d.novel_title) meta.appendChild(chip(d.novel_title, '', 'books'));
      const si = h('div.ed-saveinfo');
      if (ed.saving) { si.textContent = '保存中…'; si.style.color = 'var(--muted)'; }
      else if (ed.dirty) { si.textContent = '● 有未保存修改'; si.style.color = 'var(--amber)'; }
      else { si.textContent = ed.savedAt ? '已保存 ' + ed.savedAt : '✓ 已同步'; si.style.color = 'var(--muted)'; }
      meta.appendChild(si);
      meta.scrollLeft = 0;
    }

    /* --- 自动保存（防丢稿） --- */
    const autoSave = MZ.debounce(function () { if (ed && ed.dirty) save(false); }, 2200);
    function onEdit() {
      if (!ed) return;
      ed.dirty = true;
      paintMeta();
      autoSave();
    }
    titleInput.addEventListener('input', onEdit);
    textArea.addEventListener('input', onEdit);
    textArea.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '　　'); }
    });

    async function save(manual) {
      if (!ed || ed.saving) return;
      ed.saving = true;
      const content = textArea.value;
      const title = titleInput.value;
      paintMeta();
      try {
        const res = await api.put('/api/chapter/' + cid, { content: content, title: title });
        if (!ed) return;
        ed.data = Object.assign({}, ed.data, { chapter: res.chapter, metrics: res.metrics });
        ed.dirty = false;
        const d = new Date();
        ed.savedAt = d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2);
        if (manual) { toast('已保存', 'ok'); haptic('success'); }
      } catch (e) {
        if (manual) toast('保存失败：' + e.message, 'bad');
        else toast('自动保存失败，请手动点「保存」', 'bad');
      } finally { if (ed) { ed.saving = false; paintMeta(); } }
    }

    /* ============ 长操作：底部浮条实时进度（本版重点） ============ */
    function opSet(pct, titleText, steps, stepIdx, phase, note, tone) {
      dbFill.style.width = Math.max(0, Math.min(100, pct)) + '%';
      if (tone) dbFill.style.background = tone;
      else dbFill.style.background = '';
      dbTitle.textContent = titleText;
      dbPct.textContent = Math.round(pct) + '%';
      clear(dbBody);
      if (steps && steps.length) dbBody.appendChild(MZUI.stepsNode(steps, stepIdx, phase));
      if (note) dbBody.appendChild(h('div.footnote', { text: note }));
    }
    /* 同步接口拿不到服务端进度，就用「已用时 + 阶段推进 + 服务端 phase」拼一个诚实的进度：
       前 95% 按时间渐近，最后 5% 留给真正返回的那一刻。 */
    function runOp(label, path, opts) {
      opts = opts || {};
      const steps = opts.steps || ['准备上下文', '调用模型生成', '清洗与质检', '写入章节'];
      const stepSec = opts.stepSec || Math.max(5, Math.round((opts.expect || 45) / steps.length));
      const tau = opts.tau || Math.max(12, (opts.expect || 45) / 2.2);
      return new Promise(function (resolve, reject) {
        if (ed.op) { toast('还有一个操作在跑，等它结束再点', 'warn'); reject(new Error('busy')); return; }
        const t0 = Date.now();
        ed.op = { label: label };
        dock.hidden = false;
        opSet(2, label + '…', steps, 0, '正在准备', '这一步可能要几十秒，你可以边等边继续写，不耽误保存。');
        let lastLive = 0;
        const timer = setInterval(async function () {
          if (!ed) return;
          const el = (Date.now() - t0) / 1000;
          const pct = Math.min(95, Math.round(100 * (1 - Math.exp(-el / tau))));
          const idx = Math.min(steps.length - 1, Math.floor(el / stepSec));
          let phase = el < stepSec ? '正在准备上下文' : ('进行中 · 已用时 ' + fmtDur(el));
          let note = '已用时 ' + fmtDur(el) + ' · 服务端返回后会自动写入并刷新';
          /* 服务端如果登记了 ops，就用它的 phase/note 显示「真正在跑什么」 */
          if (Date.now() - lastLive > 2600) {
            lastLive = Date.now();
            A.refreshLive().then(function (lv) {
              if (!ed || !lv) return;
              const ops = lv.ops || {};
              const keys = Object.keys(ops);
              const first = keys.length ? ops[keys[0]] : null;
              if (first && (first.phase || first.note)) {
                const el2 = (Date.now() - t0) / 1000;
                const p2 = Math.min(95, Math.round(100 * (1 - Math.exp(-el2 / tau))));
                opSet(p2, label + '…', (first.steps && first.steps.length ? first.steps : steps),
                  (first.step === undefined || first.step === null ? Math.min(steps.length - 1, Math.floor(el2 / stepSec)) : first.step),
                  first.phase, first.note || note);
              }
            });
          }
          opSet(pct, label + '…', steps, idx, phase, note);
        }, 900);
        ed.timers.push(timer);
        api.post(path, opts.body || {}, { timeout: opts.timeout || 600000 })
          .then(function (res) {
            clearInterval(timer);
            if (!ed) { resolve(res); return; }
            ed.op = null;
            opSet(100, label + '完成', steps, steps.length - 1, '完成', null);
            dbFill.style.background = 'linear-gradient(90deg,#63e3b3,var(--ok))';
            setTimeout(function () { if (ed) { dock.hidden = true; dbFill.style.background = ''; } }, 1400);
            resolve(res);
          }, function (err) {
            clearInterval(timer);
            if (ed) {
              ed.op = null;
              opSet(100, label + '失败', steps, 0, err.message || '出错了', err.message || '');
              dbFill.style.background = 'linear-gradient(90deg,#ff9a90,var(--red))';
            }
            reject(err);
          });
      });
    }
    /* --- 长操作入口 --- */
    async function regen() {
      const ok = await confirm(ed.dirty
        ? '重生成整章：会覆盖当前正文，未保存的修改会丢失（原内容会存档，可回滚）。继续？'
        : '重生成整章：会覆盖当前正文（原内容会存档，可回滚）。继续？',
        { okText: '继续', danger: true });
      if (!ok) return;
      try {
        const res = await runOp('重生成整章', '/api/chapter/' + cid + '/regen', {
          steps: ['读取原文与上下文', '生成新稿', '去 AI 味处理', '质检并归档旧稿'], expect: 75, tau: 30,
        });
        toast((res && res.msg) || '重生成完成', 'ok'); haptic('success'); await load();
      } catch (e) { if (e.message !== 'busy') toast(e.message, 'bad'); }
    }
    async function deai() {
      const ok = await confirm('去 AI 化：会把「像 AI 写的」段落重写一遍，原内容会存档可回滚。继续？', { okText: '继续' });
      if (!ok) return;
      try {
        const res = await runOp('去 AI 化', '/api/chapter/' + cid + '/deai', {
          steps: ['扫描 AI 腔词与套路句', '逐段改写', '复检 AI 味'], expect: 45, tau: 20,
        });
        toast((res && res.msg) || '去 AI 化完成', 'ok'); haptic('success'); await load();
      } catch (e) { if (e.message !== 'busy') toast(e.message, 'bad'); }
    }
    async function autoTitle() {
      try {
        const res = await runOp('AI 起名', '/api/chapter/' + cid + '/title', {
          steps: ['读取本章要点', '生成候选标题', '挑一个最吸睛的'], expect: 20, tau: 9,
        });
        const t = (res && (res.title || res.result || res.msg)) || '';
        if (t && String(t).length <= 30) { titleInput.value = String(t); onEdit(); toast('已起名：' + t, 'ok'); }
        else toast('已生成建议，看看检查面板', 'ok');
      } catch (e) { if (e.message !== 'busy') toast(e.message, 'bad'); }
    }
    function moreActions() {
      actions([
        { label: '合规预检', sub: '本机词表，秒出', icon: 'shield', onPick: function () { runCheck('compliance'); } },
        { label: '章末钩子体检', icon: 'hook', onPick: function () { runCheck('hook'); } },
        { label: '读者视角模拟', icon: 'eye', onPick: function () { runCheck('reader'); } },
        { label: '按我说的改选中段落', sub: '选中正文里的一段再点', icon: 'edit', onPick: function () { rewriteHint(); } },
        { label: '三模型爆款评分', icon: 'fire', onPick: function () { openInspect('hit'); } },
        { label: '版本历史', icon: 'history', onPick: function () { openInspect('versions'); } },
        { label: '删除本章', danger: true, icon: 'trash', onPick: function () { delChapter(); } },
      ], { title: '第 ' + ((ed.data && ed.data.chapter && ed.data.chapter.idx) || '') + ' 章' });
    }

    async function delChapter() {
      const ok = await confirm('删除本章？会移到回收站，可在桌面版恢复。', { danger: true, okText: '删除' });
      if (!ok) return;
      try {
        await api.del('/api/chapter/' + cid);
        toast('已删除', 'ok');
        closeEditor(true);
      } catch (e) { toast(e.message, 'bad'); }
    }

    async function runCheck(kind) {
      const label = { compliance: '合规预检', hook: '章末钩子', reader: '读者视角' }[kind];
      const stepMap = {
        compliance: ['加载词表', '逐段比对', '汇总风险'],
        hook: ['定位章末', '判断钩子强度', '给出改法'],
        reader: ['模拟读者', '找弃读点', '给出建议'],
      };
      try {
        const res = await runOp(label, '/api/chapter/' + cid + '/' + kind, {
          steps: stepMap[kind], expect: 30, tau: 14,
        });
        sheet({ title: label, build: function (b) { b.appendChild(renderAny(res.result || res.review || res)); } });
      } catch (e) { if (e.message !== 'busy') toast(e.message, 'bad'); }
    }

    /* --- 检查抽屉 --- */
    let segKey = 'quality';
    function openInspect(startKey) {
      segKey = startKey || 'quality';
      sheet({ title: '本章检查', build: function (b, close) { drawInspect(b, close); } });
    }
    function drawInspect(b, close) {
      clear(b);
      b.appendChild(seg([
        { key: 'quality', label: '质检' },
        { key: 'hit', label: '爆款' },
        { key: 'compliance', label: '合规' },
        { key: 'hook', label: '钩子' },
        { key: 'versions', label: '版本' },
      ], segKey, function (k) { segKey = k; drawInspect(b, close); }));
      const pane = h('div.mt12');
      b.appendChild(pane);

      if (segKey === 'quality') {
        pane.appendChild(h('div.btn-row', { style: { marginTop: '0' } },
          A._btn('用当前正文重新质检', 'primary', async function () {
            await save(false);
            try {
              const r = await api.post('/api/chapter/' + cid + '/analyze');
              toast('已重新质检', 'ok');
              if (ed) { ed.data.metrics = r.metrics; paintMeta(); }
              drawInspect(b, close);
            } catch (e) { toast(e.message, 'bad'); }
          }),
          A._btn('按建议重写', '', function () { close(); rewriteHint(); })));
        pane.appendChild(card('质检指标', null, [MZUI.metricsPanel((ed.data || {}).metrics, (ed.data || {}).target_words || 2500)]));
        pane.appendChild(h('div.section-title', { text: '发现的问题' }));
        pane.appendChild(MZUI.issueList((ed.data || {}).issues));
        const weak = (ed.data || {}).weak || [];
        if (weak.length) {
          pane.appendChild(h('div.section-title', { text: '最像 AI 灌水的段落' }));
          const l = h('div.list');
          weak.forEach(function (w) {
            l.appendChild(li({
              title: '第 ' + (w.para + 1) + ' 段',
              sub: (w.hits || []).join('、') + (w.text ? ' · ' + w.text.slice(0, 60) : ''),
              right: chip('可疑 ' + w.score, 'warn', 'bolt'),
            }));
          });
          pane.appendChild(l);
        }
      } else if (segKey === 'hit') {
        pane.appendChild(h('div.btn-row', { style: { marginTop: '0' } },
          A._btn('评分本章（三模型）', 'primary', function () { runHit(pane, b, close); })));
        pane.appendChild(MZUI.hitPanel((ed.data || {}).hit_review));
      } else if (segKey === 'compliance' || segKey === 'hook') {
        const key = segKey;
        pane.appendChild(h('div.btn-row', { style: { marginTop: '0' } },
          A._btn(key === 'compliance' ? '跑一次合规预检' : '体检章末钩子', 'primary',
            function () { close(); runCheck(key); })));
        pane.appendChild(h('div.footnote', { text: key === 'compliance'
          ? '合规预检走本机词表，秒出结果，不会把正文发给模型。'
          : '钩子体检看的是章末有没有让人想点下一章的东西。' }));
      } else if (segKey === 'versions') {
        pane.appendChild(loadingBox('读取版本…'));
        api.get('/api/chapter/' + cid + '/versions').then(function (r) {
          clear(pane);
          const vs = r.versions || [];
          if (!vs.length) { pane.appendChild(emptyBox('history', '还没有历史版本', '编辑或重生成后会自动存档')); return; }
          const l = h('div.list');
          vs.forEach(function (v) {
            l.appendChild(li({
              title: v.title || ('版本 #' + v.id),
              sub: [v.created_at ? fmtDate(v.created_at) : '', v.chars ? fmtNum(v.chars) + ' 字' : '', v.source || ''].filter(Boolean).join(' · '),
              right: chip('回滚', '', 'history'),
              onTap: function () { restoreVersion(v.id); },
            }));
          });
          pane.appendChild(l);
        }).catch(function (e) { clear(pane); pane.appendChild(errBox(e)); });
      }
    }
    async function runHit(pane, b, close) {
      try {
        const res = await runOp('三模型爆款评分', '/api/chapter/' + cid + '/hit_review', {
          steps: ['三个模型并行读稿', '各自打十个维度', '取中位并汇总共识'], expect: 70, tau: 26, timeout: 900000,
        });
        if (ed) ed.data.hit_review = res.review || res;
        toast('评分完成', 'ok'); haptic('success');
        drawInspect(b, close);
      } catch (e) { if (e.message !== 'busy') toast(e.message, 'bad'); }
    }
    function rewriteHint() {
      const sel = textArea.value.substring(textArea.selectionStart, textArea.selectionEnd);
      if (!sel || sel.length < 10) { toast('先在正文里选中要改的段落，再点这里', 'bad'); return; }
      const start = textArea.selectionStart, end = textArea.selectionEnd;
      modal({
        title: '按我说的改',
        text: '用大白话说想怎么改，比如「这段再爽一点」「换成她的视角」「压到 200 字」。留空则按质检建议改。',
        input: 'text', placeholder: '（可留空）', okText: '开始改',
      }).then(async function (v) {
        if (v === null) return;
        try {
          const res = await runOp('重写选中段落', '/api/chapter/' + cid + '/rewrite', {
            body: { start: start, end: end, instruction: String(v || '') },
            steps: ['读取选中段落', '按你的要求改写', '对比原文'], expect: 35, tau: 16,
          });
          const after = (res.result && res.result.content) || res.content || res.after || '';
          if (!after) { toast('模型没有返回改写结果', 'bad'); return; }
          sheet({
            title: '改写结果对比',
            build: function (b, close) {
              b.appendChild(h('div.small.muted.mb8', { text: '改前' }));
              b.appendChild(h('div.card.tight.small.pre-wrap', { text: sel }));
              b.appendChild(h('div.small.muted.mt12.mb8', { text: '改后' }));
              b.appendChild(h('div.card.tight.small.pre-wrap', { text: after }));
              const row = h('div.btn-row.mt12');
              row.appendChild(A._btn('用这一版', 'primary', async function () {
                try {
                  await api.post('/api/chapter/' + cid + '/rewrite_apply', { start: start, end: end, content: after }, { timeout: 300000 });
                  close(); toast('已套用', 'ok');
                  await load();
                } catch (e) { toast(e.message, 'bad'); }
              }));
              row.appendChild(A._btn('复制改后文本', '', function () {
                if (navigator.clipboard) navigator.clipboard.writeText(after);
                toast('已复制', 'ok');
              }));
              b.appendChild(row);
            },
          });
        } catch (e) { if (e.message !== 'busy') toast(e.message, 'bad'); }
      });
    }
    async function restoreVersion(vid) {
      const ok = await confirm('回滚到这一版？当前正文会先存档，可再切回。', { okText: '回滚' });
      if (!ok) return;
      try {
        await api.post('/api/version/' + vid + '/restore');
        toast('已回滚', 'ok');
        await load();
      } catch (e) { toast(e.message, 'bad'); }
    }

    /* --- 关闭 --- */
    function pickCloseAction() {
      return new Promise(function (resolve) {
        const mask = MZ.$('#maskActions');
        function finish(v) { mask.removeEventListener('click', onMask); resolve(v); }
        function onMask() { finish('cancel'); }
        MZ.actions([
          { label: '保存并退出', strong: true, onPick: function () { finish('save'); } },
          { label: '放弃修改并退出', danger: true, onPick: function () { finish('drop'); } },
        ], { title: '还有未保存的修改' });
        setTimeout(function () { mask.addEventListener('click', onMask); }, 0);
      });
    }
    async function closeEditor(force) {
      if (!force && ed && ed.dirty) {
        const pick = await pickCloseAction();
        if (pick === 'cancel') return;
        if (pick === 'save') await save(false);
      } else if (!force && ed) {
        await save(false);
      }
      if (!ed) return;
      const w = ed.wrap;
      (ed.timers || []).forEach(function (t) { clearInterval(t); });
      ed = null;
      document.body.style.overflow = '';
      if (w && w.parentNode) w.parentNode.removeChild(w);
      A.render();
    }

    back.addEventListener('click', function () { haptic('light'); closeEditor(false); });
    navAct.addEventListener('click', function () { haptic('light'); openInspect(); });
    window.addEventListener('beforeunload', function (e) {
      if (ed && ed.dirty) { e.preventDefault(); e.returnValue = ''; }
    });

    textArea.focus();
    await load();
  }

  return { openChapter: openChapter, renderAny: renderAny };
})();