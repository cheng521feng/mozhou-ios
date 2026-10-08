/* ==========================================================================
   墨舟移动端 · 作品页（作品库）  book.js  v7
   --------------------------------------------------------------------------
   把电脑端「作品库」里能在手机上真正做完的事搬过来：

     资料 —— 编辑资料（书名 / 分类 / 作者 / 简介 / 主线大纲 / 人物 / 设定 / 文风 /
             每日章数 / 每章目标字数 / 计划总章数 / 参与自动更新 / 书架置顶）
     大纲 —— AI 根据书名写大纲（书名 + 简介 → 简介 / 三幕大纲 / 人物 / 前 20 章章纲，
             先给你看，点「采纳」才写回设定，不会偷偷覆盖）
     四个页签 —— 章节 / 人物 / 伏笔 / 故事记忆（点标题下面那排切）
     底部动作 —— 写下一章 / 自动写到第 N 章 / 生成封面
     写作 —— 补更（续写）、无人值守续写、重写前几章
     质量 —— 质检全书、全书合规预检
     分析 —— 伏笔台账、前情摘要（看 + 用 AI 重建）
     物料 —— AI 生成封面、导出 txt
     章节 —— 点开就写、重命名、删除（进回收站）
     危险 —— 删除作品（进回收站，「我的 → 回收站」里能恢复）

   故意没做（手机上做不了，或者太危险）：
     · 全书去 AI 化 —— 电脑端要逐章勾选，手机上一点就烧掉几十次模型调用
     · 发布到番茄 / 平台登录 —— 要用电脑上的浏览器会话
     · 导入本地文件 —— 手机选不到文件；改成「书架 → 新建 → 粘贴文本导入」
     · 手工新建空白章节 —— 后端没有这个接口（只能让模型写，或去电脑上导入）
     · EPUB / Markdown 导出、计划任务、备份还原点、系统信息 —— 电脑专属
   ========================================================================== */
'use strict';

window.MZBook = (function () {
  const { h, clear, api, toast, sheet, actions, modal, confirm, haptic, icon, chip,
          fmtNum, timeAgo, emptyBox, loadingBox, hold, saveImage } = MZ;
  const A = window.MZApp;
  const { li, buttons, bar, busySheet } = A;

  /* ============================== 表单件 ============================== */
  /* 手机端没有 <form>，这里手搓三个够用的控件：单行、多行、开关。 */

  function textField(label, value, opt) {
    opt = opt || {};
    const inp = opt.area
      ? h('textarea.inp', { rows: String(opt.rows || 4), placeholder: opt.ph || '', spellcheck: 'false' })
      : h('input.inp', {
          type: opt.type || 'text', placeholder: opt.ph || '',
          inputmode: opt.type === 'number' ? 'decimal' : 'text',
          autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false',
        });
    inp.value = (value === undefined || value === null) ? '' : String(value);
    const node = h('div.fld', null,
      h('label', { text: label }), inp,
      opt.hint ? h('div.fld-hint', { text: opt.hint }) : null);
    return { node: node, input: inp, value: function () { return inp.value; } };
  }

  function toggleRow(label, on) {
    const sw = h('div.sw' + (on ? '.on' : ''), null, h('i'));
    const node = h('div.sw-row', null, sw, h('span.lab', { text: label }));
    let state = !!on;
    node.addEventListener('click', function () {
      haptic('light');
      state = !state;
      sw.classList.toggle('on', state);
    });
    return { node: node, on: function () { return state; } };
  }

  /* ============================== 频道 / 题材 ==============================
     清单来自后端 /api/genres（config.CHANNELS），和电脑端共用一份，改一处两边都变。 */
  let GENRES = null;
  async function loadGenres() {
    if (GENRES) return GENRES;
    try { GENRES = await api.get('/api/genres'); }
    catch (e) {
      GENRES = { channels: { '男频': ['都市'], '女频': ['现言'] },
                 order: ['男频', '女频'], default: '男频' };
    }
    return GENRES;
  }

  /* 男频/女频（分段器）+ 类型（可点的小标签）。选中的类型不在清单里就补一条，改老书不会把分类弄丢。 */
  function genrePicker(curChan, curCat) {
    const box = h('div');
    let chan = curChan || '', cat = curCat || '';
    const g = { channels: {}, order: [], default: '' };
    const chanSeg = h('div.seg');
    const catWrap = h('div.chips');
    box.appendChild(h('div.fld', null, h('label', { text: '频道' }), chanSeg));
    box.appendChild(h('div.fld', null, h('label', { text: '类型' }), catWrap));

    function paintCats() {
      clear(catWrap);
      const list = (g.channels[chan] || []).slice();
      if (cat && list.indexOf(cat) < 0) list.unshift(cat);
      if (list.length && list.indexOf(cat) < 0) cat = list[0];
      list.forEach(function (c) {
        const el = h('span.chip.pick' + (c === cat ? '.on' : ''), { text: c });
        el.addEventListener('click', function () {
          if (c === cat) return;
          haptic('light'); cat = c; paintCats();
        });
        catWrap.appendChild(el);
      });
    }
    function paintChans() {
      clear(chanSeg);
      (g.order.length ? g.order : Object.keys(g.channels)).forEach(function (c) {
        const b = h('button' + (c === chan ? '.on' : ''), { type: 'button', text: c });
        b.addEventListener('click', function () {
          if (c === chan) return;
          haptic('light'); chan = c; cat = ''; paintChans(); paintCats();
        });
        chanSeg.appendChild(b);
      });
    }
    loadGenres().then(function (gg) {
      g.channels = gg.channels || {}; g.order = gg.order || []; g.default = gg.default || '';
      const chans = g.order.length ? g.order : Object.keys(g.channels);
      if (chans.indexOf(chan) < 0) chan = (g.default && chans.indexOf(g.default) >= 0) ? g.default : (chans[0] || '男频');
      paintChans(); paintCats();
    });
    return { node: box, channel: function () { return chan; }, category: function () { return cat; } };
  }

  /* ============================== 作品页 ============================== */

  function open(nid) {
    A.push({
      title: '作品',
      action: { label: '更多', onTap: function () { moreSheet(nid); } },
      async mount() { return page(nid); },
    });
  }

  async function page(nid) {
    const out = h('div.pad');
    await A.ensureHero();
    const n = A.findNovel(nid);
    if (!n) {
      out.appendChild(emptyBox('bolt', '找不到这本书', '可能已经被删掉了，回书架下拉刷新看看'));
      return out;
    }
    out.appendChild(head(n));
    let nv = {};
    try {
      const d = await api.get('/api/novel/' + nid);
      nv = (d && d.novel) || {};
    } catch (e) { /* 详情拿不到也不影响下面的页签 */ }

    /* 四个页签：章节 / 人物 / 伏笔 / 故事记忆。
       以前这一页是把所有卡片一路堆下来（前情摘要、Bible、伏笔、章节、一堆按钮），
       手机上要滑很久才找得到想看的那一段；现在按「看什么」分四个页签，
       写作、剪号... 那些动作收在右上角「更多」和底部操作条里。 */
    const TABS = [
      { key: 'chapters', label: '章节' },
      { key: 'characters', label: '人物' },
      { key: 'foreshadows', label: '伏笔' },
      { key: 'memory', label: '故事记忆' },
    ];
    let tab = 'chapters';
    const tabBox = h('div.bk-tabs');
    const pane = h('div.bk-pane');
    function paint() {
      clear(tabBox);
      tabBox.appendChild(A.seg(TABS, tab, function (k) { tab = k; haptic('light'); paint(); }));
      clear(pane);
      if (tab === 'chapters') pane.appendChild(chaptersCard(nid, nv));
      else if (tab === 'characters') pane.appendChild(charactersCard(n, nv));
      else if (tab === 'foreshadows') pane.appendChild(foreshadowCard(n, nv));
      else { pane.appendChild(bibleCard(n, nv)); pane.appendChild(summaryCard(n, nv)); }
    }
    out.appendChild(tabBox);
    out.appendChild(pane);
    /* 底部大按钮上把价钱写出来（跟写作页同一个口径，价格问后端） */
    const price = await A.chapterPrice(n.target_words || 2500, 'continue');
    out.appendChild(actionBar(n, price));
    paint();
    return out;
  }

  /* 底部动作条：写下一章 / 自动写到第 N 章 / 生成封面。
     sticky 贴在屏底（让开底部标签栏），章节列表再长也不用滑到底才能接着写。 */
  function actionBar(n, price) {
    return h('div.bk-actbar', null, buttons([
      { label: price ? ('写下一章 · ' + price + ' 墨币') : '写下一章',
        tone: 'primary', onTap: function () { A.askUpdate(n); } },
      { label: '自动写到第N章', onTap: function () { unattended(n); } },
      { label: n.cover_url ? '重画封面' : '生成封面', onTap: function () { genCover(n); } },
    ]));
  }

  /* ---------- 人物：novel.characters（补更 / 重写时会喂给模型的人物小传） ---------- */
  function charactersCard(n, nv) {
    const ta = h('textarea.inp', { rows: '10', spellcheck: 'false',
      placeholder: '主要人物 + 一句话人设，例如：\n林晚——女主，绣娘，外柔内刚，认死理。\n沈砚——男主，漕帮少主，嘴上刻薄心里软。\n（这段会随补更一起喂给模型，写清楚谁是谁，模型就不容易把人写串。）' });
    ta.value = nv.characters || n.characters || '';
    const box = h('div.card');
    box.appendChild(h('div.card-head', null, h('h3', { text: '人物' }),
      h('span.sp', { text: '补更时会喂给模型' })));
    box.appendChild(ta);
    box.appendChild(buttons([
      { label: '保存', tone: 'primary', onTap: async function () {
        try {
          await api.put('/api/novel/' + n.id, { characters: ta.value });
          toast('人物已保存', 'ok'); haptic('success');
        } catch (e) { toast(e.message, 'bad'); }
      } },
      { label: '从正文抽取', tone: 'blue', onTap: function () { extractCharacters(n, ta); } },
    ]));
    box.appendChild(h('div.footnote', { text: '「从正文抽取」会让模型通读最近几章，把人名和当前状态列出来，你确认后再合并进来。' }));
    return box;
  }

  /* AI 从最近几章抽人物：列出来给用户选，选中的合并到上面那个「人物」里 */
  async function extractCharacters(n, ta) {
    const bs = busySheet('AI 正在读最近几章…');
    let r = null;
    try { r = await api.post('/api/novel/' + n.id + '/cards/suggest', { kind: 'character' }, { timeout: 300000 }); }
    catch (e) { bs.close(); toast(e.message, 'bad'); return; }
    bs.close();
    const items = (r && r.items) || [];
    if (!items.length) { toast('这次没抽到新人物', 'warn'); return; }
    const on = {};
    items.forEach(function (x) { on[x.name] = true; });
    sheet({
      title: '从正文抽到的人物',
      build: function (b, close) {
        b.appendChild(h('div.fld-hint', { text: '点一下取消勾选；合并时名字已经在里面的会自动跳过，不会重复。' }));
        const wrap = h('div.chips.mt12');
        items.forEach(function (x) {
          const c = h('button.chip.pick' + (on[x.name] ? '.on' : ''), { type: 'button', text: x.name });
          c.addEventListener('click', function () {
            haptic('light');
            on[x.name] = !on[x.name];
            c.classList.toggle('on', on[x.name]);
          });
          wrap.appendChild(c);
        });
        b.appendChild(wrap);
        const l = h('div.list.mt12');
        items.forEach(function (x) {
          l.appendChild(li({
            title: x.name,
            sub: Object.keys(x.data || {}).map(function (k) { return k + '：' + x.data[k]; }).join(' · ').slice(0, 140) || '（正文里没给到更多细节）',
          }));
        });
        b.appendChild(l);
        b.appendChild(buttons([
          { label: '合并到人物', tone: 'primary', onTap: async function () {
            const add = items.filter(function (x) { return on[x.name]; });
            const cur = String(ta.value || '');
            const lines = cur ? cur.replace(/\s+$/, '').split('\n') : [];
            let added = 0;
            add.forEach(function (x) {
              const dup = lines.some(function (l2) { return l2.indexOf(x.name) === 0; });
              if (dup) return;
              const tail = Object.keys(x.data || {}).map(function (k) { return x.data[k]; }).join('；');
              lines.push(x.name + '——' + tail);
              added++;
            });
            ta.value = lines.join('\n');
            close();
            if (!added) { toast('这些人物都已经在里面了', 'warn'); return; }
            try {
              await api.put('/api/novel/' + n.id, { characters: ta.value });
              toast('已合并 ' + added + ' 人', 'ok'); haptic('success');
            } catch (e) { toast(e.message, 'bad'); }
          } },
          { label: '先不要', onTap: function () { close(); } },
        ]));
      },
    });
  }

  function coverNode(n, cls) {
    /* 给封面挂上「点一下 / 长按都出菜单」；图片加载失败换成占位块时也要过这里，
       不然封面图一 404，长按就再也弹不出菜单了。 */
    function bindCover(el) {
      const hh = hold(el, function () { coverSheet(n); });
      el.addEventListener('click', function () {
        if (hh.swallow()) return;
        haptic('light');
        coverSheet(n);
      });
      return el;
    }
    if (n.cover_url) {
      return bindCover(h('img' + (cls || '.cover'), {
        src: MZ.img(n.cover_url), alt: '', decoding: 'async',
        onerror: function (e) {
          const im = e && e.currentTarget;
          if (im && im.parentNode) {
            im.parentNode.replaceChild(bindCover(h('div' + (cls || '.cover'), { text: (n.title || '书').slice(0, 1) })), im);
          }
        },
      }));
    }
    return bindCover(h('div' + (cls || '.cover'), { text: (n.title || '书').slice(0, 1) }));
  }

  function head(n) {
    const daily = (n.plan && n.plan.daily) || n.daily_count || 0;
    const made = (n.plan && n.plan.today_made) === undefined ? (n.today_made || 0) : n.plan.today_made;
    const need = (n.plan && n.plan.need) || 0;
    const main = h('div.bk-main');
    main.appendChild(h('div.bk-title', { text: n.title || '未命名', style: { fontSize: '19px' } }));
    main.appendChild(h('div.bk-cat', { text: [n.channel, n.category, n.author].filter(Boolean).join(' · ') || '未分类' }));
    main.appendChild(h('div.bk-meta', null,
      chip((n.chapter_count || 0) + ' 章', '', 'books'),
      chip(fmtNum(n.total_chars || 0) + ' 字', '', 'file'),
      n.avg_score ? chip('均分 ' + n.avg_score, n.avg_score >= 75 ? 'ok' : '', 'target') : null,
      n.pinned ? chip('置顶', 'blue', 'star') : null));
    main.appendChild(h('div.bk-foot', null,
      bar(daily ? (made / daily) * 100 : 0, need ? 'warn' : 'ok'),
      h('span.tiny.muted.num', { text: '今日 ' + made + '/' + daily })));
    if (n.fanqie_book_name) main.appendChild(h('div.bk-cat', { text: '番茄：' + n.fanqie_book_name }));
    return h('div.bk-head', null, coverNode(n), main);
  }

  /* 阅读器的入口统一走这里：脚本万一没加载出来，给一句人话，别静默 */
  function openReader(nid, cid, opt) {
    if (window.MZReader && MZReader.open) { MZReader.open(nid, cid, opt); return; }
    toast('阅读器没加载出来，退出重进一次试试', 'bad');
  }

  /* 「继续阅读」按钮上的字：上次读到哪儿就写哪儿（位置只记在本机） */
  function readLabel(n) {
    const p = (window.MZReader && MZReader.last) ? MZReader.last(n.id) : null;
    if (!p) return '开始阅读' + (n.chapter_count ? '（共 ' + n.chapter_count + ' 章）' : '');
    const tail = p.label.length > 15 ? p.label.slice(0, 15) + '…' : p.label;
    return '继续阅读 · ' + tail;
  }

  /* ---------- 前情摘要：看 / 手改 / 用 AI 重建 ---------- */
  function summaryCard(n, nv) {
    const ta = h('textarea.inp', { rows: '5', placeholder: '还没有前情摘要（写满几章后可以用下面的「用 AI 重建」生成）', spellcheck: 'false' });
    ta.value = nv.summary || n.summary || '';
    const box = h('div.card');
    box.appendChild(h('div.card-head', null, h('h3', { text: '前情摘要' }), h('span.sp', { text: '续写时会喂给模型' })));
    box.appendChild(ta);
    box.appendChild(buttons([
      { label: '保存', onTap: async function () {
        try {
          await api.put('/api/novel/' + n.id, { summary: ta.value });
          toast('摘要已保存', 'ok');
        } catch (e) { toast(e.message, 'bad'); }
      } },
      { label: '用 AI 重建', tone: 'blue', onTap: async function () {
        const ok = await confirm('让 AI 按最近几章重写前情摘要？上面这段会被覆盖。', { okText: '重建' });
        if (!ok) return;
        const bs = busySheet('AI 正在读最近几章…');
        try {
          const r = await api.post('/api/novel/' + n.id + '/summary/rebuild', {}, { timeout: 300000 });
          bs.close();
          const s = (r && (r.summary || (r.result && r.result.summary))) || '';
          if (s) ta.value = s;
          toast('摘要已重建', 'ok');
          haptic('success');
        } catch (e) { bs.close(); toast(e.message, 'bad'); }
      } },
    ]));
    return box;
  }

  /* ---------- 章节：点开就写，右边「⋯」里改名 / 删除 ---------- */
  function chaptersCard(nid, nv) {
    const list = (nv.chapters || []).slice().sort(function (a, b) { return (b.idx || 0) - (a.idx || 0); });
    const scoreMap = {};
    (nv.metrics || []).forEach(function (m) { scoreMap[m.idx] = m.score; });
    const box = h('div');
    box.appendChild(h('div.section-title', null,
      h('span', { text: '章节' }), h('span.sp', { text: '共 ' + list.length + ' 章 · 点开就读' })));
    if (!list.length) {
      box.appendChild(emptyBox('write', '还没有章节',
        '点上面「补更（续写）」让模型写第一章；已经有稿子的话，回书架用「新建 → 粘贴文本导入」'));
      return box;
    }
    const l = h('div.list');
    list.slice(0, 100).forEach(function (c) {
      const sc = scoreMap[c.idx];
      const more = h('button.bk-more', { type: 'button', 'aria-label': '这一章的操作' }, icon('more', { size: 17 }));
      more.addEventListener('click', function (e) {
        e.stopPropagation();
        haptic('light');
        chapterMenu(nid, c);
      });
      l.appendChild(li({
        title: '第 ' + c.idx + ' 章　' + (c.title || ''),
        sub: fmtNum(c.chars || 0) + ' 字' + (c.updated_at ? ' · ' + timeAgo(c.updated_at) : '') + (c.source === 'demo' ? ' · 演示' : ''),
        right: h('div.row', { style: { gap: '7px' } },
          sc === undefined || sc === null ? null : chip(String(Math.round(sc)), sc >= 75 ? 'ok' : (sc >= 55 ? '' : 'bad')),
          more),
        arrow: true,
        onTap: function () { openReader(nid, c.id, { title: c.title, idx: c.idx }); },
      }));
    });
    box.appendChild(l);
    if (list.length > 100) box.appendChild(h('div.footnote', { text: '还有 ' + (list.length - 100) + ' 章没列出来，看全部请用电脑版。' }));
    return box;
  }

  function chapterMenu(nid, c) {
    actions([
      { label: '读这一章', icon: 'book', sub: '沉浸阅读器，左右翻章', onPick: function () { openReader(nid, c.id, { title: c.title, idx: c.idx }); } },
      { label: '写这一章', icon: 'edit', onPick: function () { MZEditor.openChapter(nid, c.id, { title: c.title, idx: c.idx }); } },
      { label: '重命名', icon: 'file', onPick: function () { renameChapter(c); } },
      { label: '删除这一章', icon: 'trash', danger: true, sub: '进回收站，可恢复', onPick: function () { deleteChapter(c); } },
    ], { title: '第 ' + c.idx + ' 章' });
  }

  async function renameChapter(c) {
    const v = await modal({
      title: '重命名第 ' + c.idx + ' 章', text: '只改章节名，正文不动。',
      input: 'text', value: c.title || '', placeholder: '章节名', okText: '保存',
    });
    if (v === null) return;
    const name = String(v).trim();
    if (!name || name === (c.title || '')) return;
    const bs = busySheet('正在保存…');
    try {
      /* 后端这个接口是「整章保存」：必须把正文原样带回去，否则会把正文冲成空 */
      const d = await api.get('/api/chapter/' + c.id);
      const cur = (d && d.chapter) || {};
      await api.put('/api/chapter/' + c.id, { title: name, content: cur.content || '' });
      bs.close();
      toast('已改名为「' + name + '」', 'ok');
      haptic('success');
      A.render();
    } catch (e) { bs.close(); toast('改名失败：' + e.message, 'bad'); }
  }

  async function deleteChapter(c) {
    const ok = await confirm('删除「第 ' + c.idx + ' 章　' + (c.title || '') + '」？先放进回收站，随时能恢复。',
      { danger: true, okText: '删除' });
    if (!ok) return;
    const bs = busySheet('正在删除…');
    try {
      await api.del('/api/chapter/' + c.id);
      bs.close();
      toast('已移入回收站', 'ok');
      haptic('success');
      await A.loadHero();
      A.render();
    } catch (e) { bs.close(); toast(e.message, 'bad'); }
  }

  /* ---------- 删除作品（进回收站，二次确认） ---------- */
  async function remove(n) {
    if (!n) return;
    const ok = await confirm(
      '删除《' + (n.title || '') + '》整本书？\n连 ' + (n.chapter_count || 0) + ' 章正文一起，会先放进回收站，之后能在「我的 → 回收站」里恢复。',
      { danger: true, okText: '删除' });
    if (!ok) return;
    const ok2 = await confirm('再确认一次：真的要删除《' + (n.title || '') + '》？', { danger: true, okText: '确认删除' });
    if (!ok2) return;
    const bs = busySheet('正在删除…');
    try {
      const r = await api.del('/api/novel/' + n.id);
      bs.close();
      toast((r && r.msg) || '已移入回收站，可在「我的 → 回收站」恢复', 'ok');
      haptic('success');
      await A.loadHero();
      A.switchTab('books');
    } catch (e) { bs.close(); toast(e.message, 'bad'); }
  }

  /* ---------- AI 根据书名写大纲 ---------- */
  /* opt.silent：刚建好书时已经问过一次，这里就别再弹一个确认框 */
  async function aiOutline(n, opt) {
    opt = opt || {};
    if (!n) return;
    if (!opt.silent) {
      const ok = await confirm(
        'AI 根据书名《' + (n.title || '') + '》写大纲？\n会出简介、三幕大纲、主要人物和前 20 章章纲。生成后先给你看，点「采纳」才写进这本书。',
        { okText: '开始生成' });
      if (!ok) return;
    }
    const bs = busySheet('AI 正在构思大纲…');
    let r = null;
    try {
      /* 书名单独传；这本书已有的简介当成「方向」传 —— 这样模型才不会抛开这本书自己另起一个题 */
      r = await api.post('/api/idea', {
        title: n.title || '', idea: String(n.intro || '').trim().slice(0, 200),
        topic: [n.channel, n.category].filter(Boolean).join(' '),
        channel: n.channel || '', category: n.category || '都市', count: 20, create: 0,
      }, { timeout: 300000 });
    } catch (e) { bs.close(); toast(e.message, 'bad'); return; }
    bs.close();
    showPlan(n, r || {});
  }

  function showPlan(n, r) {
    const chs = r.chapters || [];
    const outline = (r.outline || '') + (chs.length
      ? '\n\n【章纲】\n' + chs.map(function (c) { return (c.title || '') + '：' + (c.brief || ''); }).join('\n')
      : '');
    sheet({
      title: '《' + (n.title || '') + '》大纲方案',
      build: function (b, close) {
        b.appendChild(h('div.fld-hint', { text: '这是 AI 给出的方案。点下面的「采纳」才会写进这本书的设定，现在什么都不改。' }));
        if (r.warn) b.appendChild(h('div.card.tight.small', { text: '提示：' + r.warn }));
        if (r.tags && r.tags.length) {
          b.appendChild(h('div.bk-meta.mt12', null, r.tags.map(function (t) { return chip(String(t)); })));
        }
        if (r.direction_check) {
          b.appendChild(h('div.card.tight.small.mt12', null,
            h('b', { text: '贴合方向：' }), h('span', { text: r.direction_check })));
        }
        b.appendChild(h('div.section-title', { text: '简介' }));
        b.appendChild(h('div.card.tight.small.pre-wrap', { text: r.intro || '（这次没给简介）' }));
        b.appendChild(h('div.section-title', null,
          h('span', { text: '三幕大纲' }),
          h('span.sp', { text: (r.outline || '').length + ' 字' })));
        b.appendChild(h('div.card.tight.small.pre-wrap', { text: r.outline || '（这次没给大纲）' }));
        if (r.characters) {
          b.appendChild(h('div.section-title', { text: '人物' }));
          b.appendChild(h('div.card.tight.small.pre-wrap', { text: r.characters }));
        }
        if (chs.length) {
          b.appendChild(h('div.section-title', null,
            h('span', { text: '前 ' + chs.length + ' 章章纲' })));
          const l = h('div.list');
          chs.forEach(function (c, i) {
            l.appendChild(li({ title: A.chapTitle(c, i), sub: c.brief || '' }));
          });
          b.appendChild(h('div.plan-scroll', null, l));
        }
        b.appendChild(buttons([
          { label: '采纳（大纲 + 人物 + 简介）', tone: 'primary', onTap: async function () {
            close();
            const bs = busySheet('正在写回设定…');
            try {
              await api.put('/api/novel/' + n.id + '/meta', { outline: outline, characters: r.characters || '' });
              if ((r.intro || '').trim()) await api.put('/api/novel/' + n.id, { intro: r.intro });
              if (r.foreshadows && r.foreshadows.length) {
                /* 大纲里顺带提取的待埋伏笔，直接写进伏笔清单 */
                try { await api.post('/api/novel/' + n.id + '/foreshadows', { items: r.foreshadows }); }
                catch (e) { /* 伏笔落库失败不影响大纲采纳 */ }
              }
              bs.close();
              toast('已写进这本书的设定', 'ok');
              haptic('success');
              await A.loadHero();
              A.render();
            } catch (e) { bs.close(); toast(e.message, 'bad'); }
          } },
          { label: '换一份', onTap: function () { close(); aiOutline(n, { silent: true }); } },
          { label: '先不用', onTap: function () { close(); } },
        ]));
      },
    });
  }

  /* ---------- 编辑资料 ---------- */
  async function editMeta(n) {
    if (!n) return;
    const s = sheet({ title: '编辑资料', build: function (b) { b.appendChild(loadingBox()); } });
    let nv = {};
    try {
      const d = await api.get('/api/novel/' + n.id);
      nv = (d && d.novel) || {};
    } catch (e) { /* 拿不到就用列表里的摘要兜底 */ }
    const val = function (k, dft) {
      const v = nv[k] !== undefined && nv[k] !== null ? nv[k] : n[k];
      return v === undefined || v === null ? dft : v;
    };
    const title = textField('书名', val('title', ''), { ph: '书名' });
    const genre = genrePicker(val('channel', ''), val('category', ''));
    const author = textField('作者', val('author', ''));
    const intro = textField('简介', val('intro', ''), { area: true, rows: 4, ph: '读者看到的那段话，最后一句要勾人' });
    const outline = textField('主线大纲', val('outline', ''), { area: true, rows: 6, hint: '内核写作时会按它推进剧情。懒得写就回上一页点「AI 根据书名写大纲」。' });
    const characters = textField('人物', val('characters', ''), { area: true, rows: 4 });
    const setting = textField('世界设定', val('setting', ''), { area: true, rows: 3 });
    const style = textField('文风', val('style', ''), { ph: '如：冷硬写实' });
    const daily = textField('每日章数', val('daily_count', 3), { type: 'number' });
    const tw = textField('每章目标字数', val('target_words', 2500), { type: 'number' });
    const tc = textField('计划总章数', val('target_chapters', 0), { type: 'number', hint: '填 0 表示不设上限' });
    const enabled = toggleRow('参与「今日自动更新」', !!val('enabled', false));
    const pinned = toggleRow('在书架置顶', !!val('pinned', false));

    clear(s.body);
    [title, genre, author, intro, outline, characters, setting, style].forEach(function (f) {
      s.body.appendChild(f.node);
    });
    s.body.appendChild(h('div.g2', null, daily.node, tw.node));
    s.body.appendChild(tc.node);
    s.body.appendChild(enabled.node);
    s.body.appendChild(pinned.node);
    s.body.appendChild(buttons([
      { label: '保存资料', tone: 'primary', onTap: async function () {
        const name = title.value().trim();
        if (!name) { toast('书名不能为空', 'bad'); return; }
        const body = {
          title: name,
          channel: genre.channel(),
          category: genre.category().trim(),
          author: author.value().trim(),
          intro: intro.value(),
          outline: outline.value(),
          characters: characters.value(),
          setting: setting.value(),
          style: style.value().trim(),
          daily_count: parseInt(daily.value(), 10) || 0,
          target_words: parseInt(tw.value(), 10) || 0,
          target_chapters: parseInt(tc.value(), 10) || 0,
          enabled: enabled.on() ? 1 : 0,
          pinned: pinned.on() ? 1 : 0,
        };
        const bs = busySheet('正在保存…');
        try {
          await api.put('/api/novel/' + n.id, body);
          bs.close();
          toast('资料已保存', 'ok');
          haptic('success');
          s.close();
          await A.loadHero();
          A.render();
        } catch (e) { bs.close(); toast('保存失败：' + e.message, 'bad'); }
      } },
    ]));
  }

  /* ---------- 无人值守续写 ---------- */
  function unattended(n) {
    const count = textField('连写几章', 3, { type: 'number', hint: '最多 20 章，一章一次模型调用' });
    const th = textField('低于多少分自动改', 72, { type: 'number' });
    const fix = toggleRow('低分自动按建议重写', true);
    const hook = toggleRow('每章做章末钩子体检（每章多一次调用）', true);
    sheet({
      title: '无人值守续写《' + (n.title || '') + '》',
      build: function (b, close) {
        b.appendChild(h('div.small.muted', { text: '连着写 N 章：每章写完自动质检，分数低于阈值就按建议自动重写一次，最后再跑一遍章末钩子体检。任务在后台跑，底部任务条能看到进度。' }));
        b.appendChild(count.node);
        b.appendChild(th.node);
        b.appendChild(fix.node);
        b.appendChild(hook.node);
        b.appendChild(buttons([
          { label: '开始无人值守', tone: 'primary', onTap: async function () {
            const c = Math.max(1, Math.min(20, parseInt(count.value(), 10) || 3));
            close();
            await startOp('/api/novel/' + n.id + '/auto_write', '无人值守续写', {
              count: c,
              threshold: parseFloat(th.value()) || 72,
              auto_fix: fix.on(),
              do_hook: hook.on(),
            });
          } },
        ]));
      },
    });
  }

  /* ---------- 伏笔台账 ---------- */
  async function foreshadow(n) {
    const bs = busySheet('AI 正在梳理全书伏笔…');
    let r = null;
    try { r = await api.post('/api/novel/' + n.id + '/foreshadow', {}, { timeout: 300000 }); }
    catch (e) { bs.close(); toast(e.message, 'bad'); return; }
    bs.close();
    const res = (r && r.ledger && r.ledger.result) || (r && r.result) || r || {};
    const items = res.items || [];
    sheet({
      title: '伏笔台账',
      build: function (b) {
        const stat = [];
        if (res.open_count !== undefined) stat.push('未回收 ' + res.open_count);
        if (res.stale_count !== undefined) stat.push('埋太久 ' + res.stale_count);
        if (res.chapters) stat.push('共 ' + res.chapters + ' 章');
        if (stat.length) b.appendChild(h('div.bk-meta.mt12', null, stat.map(function (s) { return chip(s, 'amber', 'hook'); })));
        if (res.summary) b.appendChild(h('div.card.tight.small.pre-wrap.mt12', { text: res.summary }));
        if (!items.length) {
          b.appendChild(emptyBox('hook', '这次没有列出伏笔', '至少要有 3 章正文才看得出伏笔'));
          return;
        }
        const l = h('div.list');
        items.forEach(function (x) {
          const tone = x.status === '未回收' ? 'amber' : (x.status === '埋太久' ? 'bad' : '');
          l.appendChild(li({
            title: x.name || '伏笔',
            sub: [x.planted ? '埋于' + x.planted : '', x.note || ''].filter(Boolean).join(' · '),
            right: x.status ? chip(x.status, tone) : null,
          }));
        });
        b.appendChild(l);
        const advice = res.advice || [];
        if (advice.length) {
          b.appendChild(h('div.section-title', { text: '建议' }));
          const al = h('div.list');
          advice.forEach(function (a) { al.appendChild(li({ title: String(a) })); });
          b.appendChild(al);
        }
      },
    });
  }

  /* ---------- 故事Bible：长篇一致性档案（每章轻量追加，每 10 章完整浓缩，≤800 字） ---------- */
  function bibleCard(n, nv) {
    const ta = h('textarea.inp', { rows: '8', spellcheck: 'false',
      placeholder: '还没有故事Bible：写满几章后点下面「重建」，或连续写下去，每章会自动追加关键变化、每 10 章完整浓缩一次' });
    ta.value = nv.bible || '';
    const box = h('div.card');
    box.appendChild(h('div.card-head', null, h('h3', { text: '故事Bible' }),
      h('span.sp', { text: nv.bible_at ? ('已浓缩到第 ' + nv.bible_at + ' 章') : '每章自动追加 / 每 10 章浓缩' })));
    box.appendChild(h('div.small.muted', { text: '人物当前状态 / 核心设定 / 已埋伏笔 / 已填坑 / 最近剧情，浓缩在 800 字以内。补更和重写都会自动带上它，比只喂前情摘要更不容易崩设定。' }));
    box.appendChild(ta);
    box.appendChild(buttons([
      { label: '保存', onTap: async function () {
        try { await api.put('/api/novel/' + n.id, { bible: ta.value }); toast('故事Bible 已保存', 'ok'); }
        catch (e) { toast(e.message, 'bad'); }
      } },
      { label: '重建', tone: 'blue', onTap: async function () {
        const ok = await confirm('让 AI 按已写章节重写故事Bible？上面这段会被覆盖。', { okText: '重建' });
        if (!ok) return;
        const bs = busySheet('AI 正在浓缩故事Bible…');
        try {
          const r = await api.post('/api/novel/' + n.id + '/bible/rebuild', {}, { timeout: 300000 });
          bs.close();
          if (r && r.bible) ta.value = r.bible;
          toast('故事Bible 已重建', 'ok');
          haptic('success');
        } catch (e) { bs.close(); toast(e.message, 'bad'); }
      } },
    ]));
    return box;
  }

  /* ---------- 伏笔清单：novel.foreshadows（大纲生成时提取，AI 填坑后自动划掉） ---------- */
  function foreshadowCard(n) {
    const box = h('div.card');
    box.appendChild(h('div.card-head', null, h('h3', { text: '伏笔' }),
      h('span.sp', { text: '点一条可手动划掉 / 恢复' })));
    const stat = h('div.small.muted');
    const listBox = h('div');
    box.appendChild(stat);
    box.appendChild(listBox);

    async function paint() {
      let items = [], open = 0, done = 0;
      try {
        const d = await api.get('/api/novel/' + n.id + '/foreshadows');
        items = (d && d.items) || [];
        open = (d && d.open) || 0;
        done = (d && d.done) || 0;
      } catch (e) { /* 取不到就先空着，下面给引导 */ }
      clear(listBox);
      stat.textContent = items.length
        ? ('共 ' + items.length + ' 条 · 未填 ' + open + ' · 已填 ' + done)
        : '还没有伏笔清单：先用「AI 根据书名写大纲」生成大纲，再点下面「从大纲提取」。';
      if (items.length) {
        const l = h('div.list');
        items.forEach(function (x) {
          const filled = x.status === '已填';
          l.appendChild(li({
            title: (filled ? '✓ ' : '· ') + (x.name || '伏笔'),
            sub: [x.planted, x.note, filled && x.filled ? ('回收：' + x.filled) : ''].filter(Boolean).join(' · '),
            right: chip(filled ? '已填' : '未填', filled ? 'ok' : 'amber'),
            onTap: async function () {
              try {
                await api.post('/api/novel/' + n.id + '/foreshadows', { name: x.name, status: filled ? '未填' : '已填' });
                paint();
              } catch (e) { toast(e.message, 'bad'); }
            },
          }));
        });
        listBox.appendChild(l);
      }
      listBox.appendChild(buttons([
        { label: '从大纲提取', tone: 'blue', onTap: async function () {
          const bs = busySheet('AI 正在从大纲里提伏笔…');
          try {
            await api.post('/api/novel/' + n.id + '/foreshadows', { build: true }, { timeout: 300000 });
            bs.close(); toast('伏笔清单已更新', 'ok'); haptic('success'); paint();
          } catch (e) { bs.close(); toast(e.message, 'bad'); }
        } },
        { label: 'AI 梳理台账', onTap: function () { foreshadow(n); } },
      ]));
    }
    paint();
    return box;
  }

  /* ---------- 封面：保存 / 预览 / 重画 ---------- */
  function coverName(n) { return (n.title || 'cover') + '-封面.png'; }

  /* 长按封面就能存：手机壳里写进「文件 → 墨舟 → 墨舟封面」，
     再弹系统分享面板（点「存储图像」就进相册）。 */
  async function saveCover(n) {
    if (!n || !n.cover_url) { toast('这本书还没有封面，先点「AI 生成封面」', 'warn'); return; }
    const bs = busySheet('正在保存封面…');
    try {
      const r = await saveImage(n.cover_url, coverName(n));
      bs.close();
      if (r && r.native) toast('已存到「文件 → 墨舟 → 墨舟封面」；分享面板里点「存储图像」就能进相册', 'ok');
      else if (r && r.opened) toast('已在新窗口打开图片，长按图片选「存储到照片」', 'ok');
      else toast('封面已保存', 'ok');
      haptic('success');
    } catch (e) { bs.close(); toast((e && e.message) || '保存失败', 'bad'); }
  }

  function coverPreview(n) {
    if (!n || !n.cover_url) { toast('这本书还没有封面', 'warn'); return; }
    sheet({
      title: '封面预览', height: 'auto',
      node: h('div',
        h('img', { src: MZ.img(n.cover_url), alt: '', decoding: 'async',
          style: { width: '100%', maxWidth: '340px', display: 'block', margin: '0 auto', borderRadius: '14px' } }),
        h('div.small.muted.mt12', { text: '长按图片也能存到相册；点下面的按钮会弹系统分享面板。' }),
        buttons([{ label: '保存到相册 / 文件', tone: 'primary', onTap: function () { saveCover(n); } }])),
    });
  }

  function coverSheet(n) {
    if (!n) return;
    const items = [
      { label: '开始阅读', sub: '沉浸阅读器', icon: 'book', onPick: function () { openReader(n.id); } },]
    if (n.cover_url) {
      items.push({ label: '保存封面', sub: '存到相册 / 文件', icon: 'download', onPick: function () { saveCover(n); } });
      items.push({ label: '看大图', icon: 'eye', onPick: function () { coverPreview(n); } });
    }
    items.push({ label: n.cover_url ? '重画一张' : 'AI 生成封面', icon: 'spark', onPick: function () { genCover(n); } });
    actions(items, { title: '《' + (n.title || '') + '》封面' });
  }

  /* ---------- AI 生成封面（可写给 AI 的画面要求 / 画风） ---------- */
  async function genCover(n) {
    const s = sheet({ title: 'AI 画封面 · 《' + (n.title || '') + '》', height: 'auto' });
    const hint = textField('画面要求（可留空）', '', { area: true, rows: 3,
      ph: '例如：雪夜城楼、主角提刀回头、冷蓝色调' });
    const style = textField('画风（可留空）', '', { ph: '例如：国漫插画 / 水墨 / 港漫质感' });
    s.body.appendChild(h('div.small.muted.mb12', { text: '会按书名、简介、大纲、人物卡自动设计，并把书名和作者直接画在画面上。写点要求它更听话。' }));
    s.body.appendChild(hint.node);
    s.body.appendChild(style.node);
    s.body.appendChild(buttons([
      { label: '开始画（约 30~90 秒）', tone: 'primary', onTap: async function () {
        const h2 = hint.value().trim(), st = style.value().trim();
        s.close();
        const bs = busySheet('AI 正在画封面…');
        try {
          await api.post('/api/novel/' + n.id + '/cover', { hint: h2, style: st }, { timeout: 300000 });
          bs.close();
          toast('封面已生成：长按封面可以保存到相册', 'ok');
          haptic('success');
          await A.loadHero();
          A.render();
        } catch (e) { bs.close(); toast(e.message, 'bad'); }
      } },
    ]));
  }

  /* ---------- 交给后端的作业（进度看底部任务条 / 任务页） ---------- */
  async function runJob(n, path, label) {
    const ok = await confirm(label + '：《' + (n.title || '') + '》\n跑起来后可以随便切页面，底部任务条会显示进度，跑完在「任务」里能看结果。',
      { okText: '开始' });
    if (!ok) return;
    await startOp(path, label, {});
  }

  async function startOp(path, label, body) {
    const bs = busySheet('正在提交…');
    try {
      const r = await api.post(path, body || {});
      bs.close();
      toast((r && r.msg) || (label + ' 已开始，底部任务条能看到进度'), 'ok');
      haptic('success');
      await A.refreshLive();
      return r;
    } catch (e) { bs.close(); toast(e.message, 'bad'); return null; }
  }

  /* ---------- 「更多」 ---------- */
  /* ---------- 「更多」：不放在页面上的动作都收在这张表里 ---------- */
  function moreSheet(nid) {
    const n = A.findNovel(nid);
    if (!n) return;
    actions([
      { label: readLabel(n), icon: 'book', onPick: function () { openReader(n.id); } },
      { label: '无人值守续写', icon: 'play', sub: '连着写几章，写完自动质检',
        onPick: function () { unattended(n); } },
      { label: 'AI 根据书名写大纲', icon: 'spark',
        sub: n.has_outline ? '会覆盖现有大纲，先给你看再采纳' : '这本书还没有大纲',
        onPick: function () { aiOutline(n); } },
      { label: '编辑资料', icon: 'edit', onPick: function () { editMeta(n); } },
      { label: n.pinned ? '取消置顶' : '置顶到书架最前', icon: 'star',
        onPick: function () { A.setPinned([n.id], !n.pinned); } },
      { label: '质检全书', icon: 'target', sub: '逐章打分，看哪几章弱',
        onPick: function () { runJob(n, '/api/novel/' + n.id + '/analyze', '质检全书'); } },
      { label: '全书合规预检', icon: 'shield', sub: '本机词表扫全书，秒出',
        onPick: function () { runJob(n, '/api/novel/' + n.id + '/compliance', '全书合规预检'); } },
      { label: 'AI 梳理伏笔台账', icon: 'layers', sub: '点「伏笔」页签也能看清单',
        onPick: function () { foreshadow(n); } },
      { label: '重写前几章', icon: 'refresh', onPick: function () { A.askRewrite(n); } },
      { label: n.cover_url ? '重画封面' : 'AI 生成封面', icon: 'spark', onPick: function () { genCover(n); } },
      { label: '保存封面', icon: 'download', sub: '存到相册 / 文件', onPick: function () { saveCover(n); } },
      { label: '导出 txt', icon: 'download', onPick: function () { A.exportNovel(n); } },
      { label: '删除作品', icon: 'trash', danger: true, sub: '进回收站，可恢复', onPick: function () { remove(n); } },
    ], { title: n.title || '作品' });
  }


  return {
    open: open, editMeta: editMeta, aiOutline: aiOutline, remove: remove,
    askAutoWrite: unattended,          // 写作台的「自动写到第 N 章」复用这一张表
    moreSheet: moreSheet, field: textField, toggle: toggleRow,
    coverSheet: coverSheet, saveCover: saveCover, genCover: genCover,
    picker: genrePicker, genres: loadGenres,
  };
})();
