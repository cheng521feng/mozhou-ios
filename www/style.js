/* ==========================================================================
   墨舟移动端 · 文风学习  style.js  v1
   --------------------------------------------------------------------------
   一句话：导入一份 TXT / PDF，让 DeepSeek 读一段采样片段，学出「写作风格档案」，
   再把档案绑到作品上 —— 续写和去 AI 化都会按这份档案的写作铁则 / 禁用词走。

   接口（与电脑端同一套，后端一份实现，两端共用）：
     POST /api/style/parse      multipart: file       服务端取文本 + 采样，不调模型
      POST /api/style/import     multipart: token / name / novel_id
     GET  /api/style/list
     PUT  /api/style/<sid>      改名 / 总结 / 铁则 / 禁用句式 / 禁用词
     DELETE /api/style/<sid>
     POST /api/novel/<nid>/bind-style   body {style_id}，null 或空串 = 解绑

   为什么文件要传到服务器取字：手机上没法在本地把 PDF 拆成文字（那要带一整套
   pdf.js 离线资源）。所以文件交给「你自己的账号后端」取字，取完立刻用一次性
   token 换掉原文；真正发给 DeepSeek 的只有采样出来的那几千字。
   ========================================================================== */
'use strict';

window.MZStyle = (function () {
  const { h, clear, api, postForm, toast, sheet, actions, confirm, haptic, chip, icon, fmtWords } = MZ;
  const A = window.MZApp;
  const { buttons } = A;

  const MAX_MB = 30;

  /* ============================== 小工具 ============================== */
  function fmtSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function hintNode(t) { return h('div.fld-hint', { text: t }); }
  function swRow(label, on, onToggle) {
    const sw = h('div.sw' + (on ? '.on' : ''), null, h('i'));
    const row = h('div.sw-row', null, sw, h('span.lab', { text: label }));
    row.addEventListener('click', function () {
      haptic('light');
      sw.classList.toggle('on');
      onToggle(sw.classList.contains('on'));
    });
    return row;
  }
  /* 十个维度里的可读条目（手机端只挑人看得懂的几条） */
  function dimLines(st) {
    const out = [];
    [['叙事视角', 'narrative_perspective'], ['语言质感', 'language_texture'],
     ['对话写法', 'dialogue_style'], ['场景描写', 'scene_description'],
     ['情绪表达', 'emotion_expression']].forEach(function (p) {
      const v = st[p[1]];
      if (!v) return;
      out.push(p[0] + '：' + (typeof v === 'string' ? v : JSON.stringify(v)));
    });
    const sf = st.sentence_features || {};
    const parts = Object.keys(sf).map(function (k) { return k + sf[k]; });
    if (parts.length) out.push('句式特点：' + parts.join('，'));
    return out;
  }
  function bulletBox(lines, empty) {
    const box = h('div.card.tight.small');
    if (!lines.length) { box.appendChild(h('div.muted', { text: empty || '（没有）' })); return box; }
    lines.forEach(function (t) { box.appendChild(h('div.pre-wrap', { text: t })); });
    return box;
  }
  function loadStyles() {
    return api.get('/api/style/list').then(function (r) { return (r && r.styles) || []; });
  }

  /* ============================== 一、导入学文风 ============================== */
  function importSheet(opt) {
    opt = opt || {};
    let file = null, novelId = '';
    let nameEl = null, fileLabel = null, prog = null, barFill = null, stepTxt = null, goBtn = null;

    const inp = h('input', {
      type: 'file', accept: '.txt,.pdf,text/plain,application/pdf',
      style: { display: 'none' },
    });

    function setProg(pct, text, tone) {
      if (!prog) return;
      prog.style.display = '';
      barFill.style.width = Math.max(0, Math.min(100, pct)) + '%';
      barFill.className = 'bar-fill' + (tone ? ' ' + tone : '');
      stepTxt.textContent = text || '';
    }

    const sb = sheet({
      title: '导入文本学文风',
      build: function (b) {
        b.appendChild(hintNode('选一份 TXT / PDF，让 AI 读一段样本，提炼出这份文本的行文风格。'
          + '文件在你自己账号的后端取字，只有采样出来的几千字会交给 DeepSeek 分析，原文不会发给第三方模型。'));
        const row = h('div.btn-row');
        const pick = h('button.btn', { type: 'button', text: '选择文件' });
        pick.addEventListener('click', function () { haptic('light'); inp.click(); });
        row.appendChild(pick);
        fileLabel = h('div.fld-hint', { text: '还没选文件（支持 .txt / .pdf，单个不超过 ' + MAX_MB + 'MB）' });
        row.appendChild(fileLabel);
        b.appendChild(row);

        b.appendChild(h('div.footnote', { text: '仅可导入您拥有合法著作权的文本，请勿导入盗版作品。' }));

        const B = window.MZBook;
        nameEl = B && B.field ? B.field('风格名称', '', { ph: '不填就用文件名' }) : null;
        if (nameEl) b.appendChild(nameEl.node);

        const bookRow = h('div.li.tap', null,
          h('div.li-ico', null, icon('books', { size: 20 })),
          h('div.li-main', null,
            h('div.li-title', { text: '套用到作品' }),
            h('div.li-sub', { text: '还没选（学完可以直接绑到一本书上）' })),
          h('span.li-arrow', null, icon('fwd', { size: 16 })));
        bookRow.addEventListener('click', function () { haptic('light'); pickNovel(); });
        b.appendChild(bookRow);
        function pickNovel() {
          const list = (A.state.novels || []).filter(function (n) { return !n.archived; });
          const items = [{ label: '先不绑定', sub: '学完在素材库里再套用', icon: 'check', onPick: function () { novelId = ''; setBookSub('还没选（学完可以直接绑到一本书上）'); } }];
          list.forEach(function (n) {
            items.push({
              label: '《' + (n.title || '未命名') + '》',
              sub: (n.chapter_count || 0) + ' 章',
              icon: 'books',
              onPick: function () { novelId = n.id; setBookSub('《' + (n.title || '未命名') + '》'); },
            });
          });
          actions(items, { title: '把这份文风套到哪本书' });
        }
        function setBookSub(t) {
          const s = bookRow.querySelector('.li-sub');
          if (s) s.textContent = t;
        }

        prog = h('div', { style: { display: 'none', marginTop: '12px' } });
        barFill = h('div.bar-fill', { style: { width: '0%' } });
        stepTxt = h('div.fld-hint', { text: '' });
        prog.appendChild(h('div.bar', null, barFill));
        prog.appendChild(stepTxt);
        b.appendChild(prog);

        goBtn = h('button.btn.primary', { type: 'button', text: '开始' });
        goBtn.addEventListener('click', function () { haptic('light'); start(); });
        b.appendChild(h('div.btn-row', null, goBtn));

        b.appendChild(inp);
      },
    });

    inp.addEventListener('change', function () {
      const f = inp.files && inp.files[0];
      inp.value = '';
      if (!f) return;
      if (f.size > MAX_MB * 1048576) { toast('这个文件 ' + fmtSize(f.size) + '，太大了（上限 ' + MAX_MB + 'MB）', 'bad'); return; }
      file = f;
      if (fileLabel) fileLabel.textContent = '已选：' + f.name + '（' + fmtSize(f.size) + '）';
      if (nameEl && !nameEl.value().trim()) {
        try { nameEl.input.value = f.name.replace(/\.[^.]+$/, ''); } catch (e) { /* 忽略 */ }
      }
      haptic('success');
    });

    async function start() {
      if (!file) { toast('先选一个 .txt / .pdf 文件', 'bad'); return; }
      goBtn.disabled = true;
      try {
        setProg(12, '解析中 · 正在取文本（这一步不调模型，不花钱）…');
        const fd = new FormData();
        fd.append('file', file, file.name);
        const pr = await postForm('/api/style/parse', fd, { timeout: 240000 });
        setProg(55, '文本提取完成：共 ' + fmtWords(pr.chars || 0) + '，'
          + '采样 ' + fmtWords(pr.sample_words || 0) + (pr.tip ? '（' + pr.tip + '）' : ''));
        const nm = nameEl ? nameEl.value().trim() : '';
        setProg(72, '风格分析中 · 正在把采样片段交给 DeepSeek…');
        const fd2 = new FormData();
        fd2.append('token', pr.token || '');
        fd2.append('name', nm || pr.name || '未命名风格');
        fd2.append('novel_id', novelId ? String(novelId) : '');
        const r2 = await postForm('/api/style/import', fd2, { timeout: 420000 });
        setProg(100, '完成 · 风格档案已生成', 'ok');
        haptic('success');
        toast('文风已学会：' + ((r2.style && r2.style.name) || nm || '新风格'), 'ok');
        A.state.novels = null;
        sb.close();
        previewSheet(r2.style || {}, libSheet);
        return;
      } catch (e) {
        setProg(100, '失败：' + ((e && e.message) || e), 'bad');
        toast((e && e.message) || '导入失败', 'bad');
      } finally {
        goBtn.disabled = false;
      }
    }
    return sb;
  }

  /* ============================== 二、素材库 ============================== */
  function styleCard(st, onView, onEdit, onApply, onDel) {
    const rules = (st.writing_rules || []).length;
    const bans = (st.forbidden_words || []).length;
    const binds = (st.bind_novel_ids || []).length;
    const c = h('div.card.pad-s');
    c.appendChild(h('div.card-head', null,
      h('h3', { text: st.name || '未命名风格' }),
      h('span.sp', null, chip(String(st.source_type || '文本').toUpperCase(), ''))));
    c.appendChild(h('div.fld-hint', { text: '来源：' + (st.source_file || '—')
      + ' · 采样 ' + fmtWords(st.sample_word_count || 0) }));
    c.appendChild(h('div.small.mt8.pre-wrap', { text: st.style_summary || '（还没有风格总结）' }));
    const chips = h('div.chips.mt8');
    if (rules) chips.appendChild(chip('铁则 ' + rules, ''));
    if (bans) chips.appendChild(chip('禁用词 ' + bans, ''));
    chips.appendChild(binds ? chip('已绑 ' + binds + ' 本', 'ok') : chip('未绑定', 'light'));
    c.appendChild(chips);
    c.appendChild(buttons([
      { label: '预览', size: 'sm', onTap: function () { onView(); } },
      { label: '改名', size: 'sm', onTap: function () { onEdit(); } },
      { label: '套用', size: 'sm', onTap: function () { onApply(); } },
      { label: '删除', size: 'sm', tone: 'danger', onTap: function () { onDel(); } },
    ]));
    return c;
  }

  function libSheet() {
    const body = h('div');
    const sb = sheet({
      title: '文风素材库',
      build: function (b) {
        b.appendChild(hintNode('这里是你导进来的写作风格。绑到作品上之后，续写和去 AI 化都会按这份风格走。'));
        b.appendChild(buttons([{ label: '导入文本学文风', tone: 'primary', size: 'sm', onTap: function () { importSheet(); } }]));
        b.appendChild(body);
      },
    });
    function paint() {
      clear(body);
      body.appendChild(MZ.loadingBox ? MZ.loadingBox('正在读素材…') : h('div.small.muted', { text: '正在读素材…' }));
      loadStyles().then(function (list) {
        clear(body);
        if (!list.length) {
          body.appendChild(h('div.empty', { text: '还没有文风素材。点上面「导入文本学文风」，选一份你拥有著作权的 TXT / PDF 试试。' }));
          return;
        }
        list.forEach(function (st) {
          body.appendChild(styleCard(st,
            function () { previewSheet(st, libSheet); },
            function () { editSheet(st, libSheet); },
            function () { applySheet(st, libSheet); },
            function () { delStyle(st, paint); }));
        });
      }).catch(function (e) {
        clear(body);
        body.appendChild(h('div.small.muted', { text: '读不到素材：' + ((e && e.message) || e) }));
      });
    }
    paint();
    return sb;
  }

  function delStyle(st, done) {
    confirm('删除风格档案「' + (st.name || '') + '」？\n\n已经绑定它的作品会自动解绑，正文一个字都不动。')
      .then(function (ok) {
        if (!ok) return null;
        return api.del('/api/style/' + st.style_id).then(function () {
          toast('已删除', 'ok');
          A.state.novels = null;
          if (done) done();
        }).catch(function (e) { toast((e && e.message) || '删除失败', 'bad'); });
      });
  }

  /* ============================== 三、预览 ============================== */
  function previewSheet(st, back) {
    const bans = [].concat(st.forbidden_patterns || [], st.forbidden_words || []);
    return sheet({
      title: '文风档案 · ' + (st.name || ''),
      build: function (b, close) {
        b.appendChild(h('div.fld-hint', { text: '来源：' + (st.source_file || '—')
          + ' · 采样 ' + fmtWords(st.sample_word_count || 0) + ' · 生成于 ' + (st.create_time || '').slice(0, 10) }));
        b.appendChild(h('div.section-title', { text: '风格总结' }));
        b.appendChild(h('div.card.tight', { text: st.style_summary || '（没有总结）' }));
        b.appendChild(h('div.section-title', { text: '行文特征' }));
        b.appendChild(bulletBox(dimLines(st), '（没有维度数据）'));
        b.appendChild(h('div.section-title', { text: '写作铁则' }));
        b.appendChild(bulletBox((st.writing_rules || []).map(function (x, i) { return (i + 1) + '. ' + x; }), '（没有铁则）'));
        b.appendChild(h('div.section-title', { text: '禁用句式 / 禁用词' }));
        b.appendChild(bulletBox(bans, '（没有禁用项）'));
        const row = h('div.btn-row');
        row.appendChild(buttons([
          { label: '套用到作品', tone: 'primary', onTap: function () { close(); applySheet(st, back); } },
          { label: '返回素材库', onTap: function () { close(); if (back) back(); } },
        ]));
        b.appendChild(row);
      },
    });
  }

  /* ============================== 四、改名 / 改内容 ============================== */
  function editSheet(st, back) {
    const B = window.MZBook;
    if (!B || !B.field) { toast('界面组件没加载出来，退出重进一次试试', 'bad'); return null; }
    const fName = B.field('风格名称', st.name || '', {});
    const fSum = B.field('风格总结', st.style_summary || '', { area: true, rows: 3 });
    const fRules = B.field('写作铁则（一行一条）', (st.writing_rules || []).join('\n'), { area: true, rows: 5 });
    const fPat = B.field('禁用句式（一行一条）', (st.forbidden_patterns || []).join('\n'), { area: true, rows: 3 });
    const fWords = B.field('禁用词（一行一条）', (st.forbidden_words || []).join('\n'), { area: true, rows: 4 });
    return sheet({
      title: '改名 / 改内容',
      build: function (b, close) {
        b.appendChild(hintNode('改完点保存。写作铁则和禁用词会直接影响续写和去 AI 化。'));
        [fName, fSum, fRules, fPat, fWords].forEach(function (f) { b.appendChild(f.node); });
        b.appendChild(buttons([
          { label: '保存', tone: 'primary', onTap: async function () {
            const lines = function (s) { return String(s || '').split('\n').map(function (x) { return x.trim(); }).filter(Boolean); };
            try {
              await api.put('/api/style/' + st.style_id, {
                name: fName.value().trim() || st.name || '未命名风格',
                style_summary: fSum.value().trim(),
                writing_rules: lines(fRules.value()),
                forbidden_patterns: lines(fPat.value()),
                forbidden_words: lines(fWords.value()),
              });
              toast('已保存', 'ok');
              close();
              if (back) back();
            } catch (e) { toast((e && e.message) || '保存失败', 'bad'); }
          } },
          { label: '返回素材库', onTap: function () { close(); if (back) back(); } },
        ]));
      },
    });
  }

  /* ============================== 五、套用（绑到作品） ============================== */
  function applySheet(st, back) {
    const body = h('div');
    const bound = {};
    const rows = {};
    (st.bind_novel_ids || []).forEach(function (x) { bound[String(x)] = 1; });
    let list = (A.state.novels || []).filter(function (n) { return !n.archived; });

    function paint() {
      clear(body);
      if (!list.length) { body.appendChild(h('div.empty', { text: '还没有作品' })); return; }
      body.appendChild(h('div.small.muted', { text: '勾选要让这本书用这份文风的，取消勾选就是解绑；下一章续写时生效。' }));
      list.forEach(function (n) {
        const sw = h('div.sw' + (bound[String(n.id)] ? '.on' : ''), null, h('i'));
        const row = h('div.sw-row', null,
          sw,
          h('span.lab', { text: '《' + (n.title || '未命名') + '》' }));
        row.addEventListener('click', function () {
          haptic('light');
          sw.classList.toggle('on');
          rows[n.id] = sw.classList.contains('on');
        });
        body.appendChild(row);
      });
    }
    const sb = sheet({
      title: '套用文风 · ' + (st.name || ''),
      build: function (b, close) {
        b.appendChild(body);
        b.appendChild(buttons([
          { label: '保存', tone: 'primary', onTap: async function () {
            try {
              const jobs = Object.keys(rows).map(function (nid) {
                const want = rows[nid];
                const isBound = !!bound[String(nid)];
                if (want === isBound) return null;
                return api.post('/api/novel/' + nid + '/bind-style', { style_id: want ? st.style_id : null });
              }).filter(Boolean);
              if (!jobs.length) { toast('没有改动', ''); close(); if (back) back(); return; }
              await Promise.all(jobs);
              toast('已套用', 'ok');
              A.state.novels = null;
              close();
              if (back) back();
            } catch (e) { toast((e && e.message) || '套用失败', 'bad'); }
          } },
          { label: '返回素材库', onTap: function () { close(); if (back) back(); } },
        ]));
      },
    });
    paint();
    return sb;
  }

  /* ============================== 六、给某一本书挑文风 ============================== */
  async function bindSheet(nid, done) {
    let styles = [], cur = '';
    try {
      const r = await api.get('/api/style/list');
      styles = (r && r.styles) || [];
    } catch (e) { toast((e && e.message) || '读不到素材', 'bad'); return; }
    try {
      const d = await api.get('/api/novel/' + nid);
      cur = String((d && (d.style_id || (d.novel && d.novel.style_id))) || '');
    } catch (e) { /* 拿不到就按没绑定算 */ }
    const items = [{
      label: '默认文风', icon: 'check', strong: !cur,
      sub: cur ? '取消绑定，这本书回到自己原本的写法' : '当前就是默认（不绑定任何素材）',
      onPick: function () { apply(nid, '', done); },
    }];
    styles.forEach(function (st) {
      items.push({
        label: st.name || '未命名风格',
        icon: 'spark',
        sub: (String(st.style_id) === cur ? '当前 · ' : '')
          + ((st.style_summary || '').slice(0, 40) || '（没有总结）'),
        onPick: function () { apply(nid, st.style_id, done); },
      });
    });
    if (!styles.length) {
      items.push({ label: '还没有文风素材', icon: 'file', sub: '点这里去导入一份 TXT / PDF', onPick: function () { importSheet(); } });
    }
    actions(items, { title: '这本书按哪份风格写' });
  }

  async function apply(nid, sid, done) {
    try {
      await api.post('/api/novel/' + nid + '/bind-style', { style_id: sid || null });
      const list = A.state.novels || [];
      for (let i = 0; i < list.length; i++) { if (String(list[i].id) === String(nid)) list[i].style_id = sid || ''; }
      toast(sid ? '已绑定，下一章按这份风格写' : '已解绑，回到默认写法', 'ok');
      haptic('success');
      if (done) done();
    } catch (e) { toast((e && e.message) || '设置失败', 'bad'); }
  }

  return { importSheet: importSheet, libSheet: libSheet, previewSheet: previewSheet,
           bindSheet: bindSheet, applySheet: applySheet };
})();