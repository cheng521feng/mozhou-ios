/* ==========================================================================
   墨舟移动端 · 写作台  editor.js  v6
   --------------------------------------------------------------------------
   这一版解决四件事（都是「用起来卡住」的地方）：
   1) 「正在跑什么」永远看得见 —— 所有长操作都会在服务端登记一条 ops，
      由 app.js 的全局任务条（#opsDock）实时画出来：第几步 / 什么阶段 /
      已用多久 / 模型在排队还是已经在写。它是 fixed 的、挂在 body 上，
      切页、切章、关掉写作台、甚至重开 App 都不会丢。
   2) 选中就能改 —— 正文里选中任意几段，下方浮出「局部改写 / 评分选中段 / 复制」。
      注意：重写接口按「段号」算范围，不是字符位置，这里统一换算好再发。
   3) 检查面板重做 —— 质检 / 爆款 / 合规 / 一致性 / 钩子 / 读者 / 版本，
      每一项都用后端真实字段渲染，并且给出「一键按建议改」。
   4) 复制整章 / 复制选中 —— 一键搞定，iOS 剪贴板被限制时自动兜底。
   ========================================================================== */
'use strict';

window.MZEditor = (function () {
  const { h, clear, api, toast, sheet, actions, modal, confirm, haptic, icon, chip,
          fmtNum, fmtDur, fmtDate, timeAgo, emptyBox, loadingBox, errBox, sleep, clipboard } = MZ;
  const A = window.MZApp;
  const { li, card, buttons, seg, MZUI } = A;

  let selectedNovelId = null;

  /* ============== 段落工具（重写/评分接口用的是「段号」，不是字符位置） ============== */
  function paraMarks(text) {
    const lines = String(text || '').split('\n');
    const marks = []; let off = 0;
    lines.forEach(function (l, i) {
      if (l.trim()) marks.push({ i: i, start: off, end: off + l.length });
      off += l.length + 1;
    });
    return marks;
  }
  function paraRange(text, a, b) {
    const marks = paraMarks(text);
    if (!marks.length) return null;
    let s = -1, e = -1;
    for (let k = 0; k < marks.length; k++) { if (marks[k].end > a) { s = k; break; } }
    if (s < 0) s = marks.length - 1;
    for (let k = marks.length - 1; k >= 0; k--) { if (marks[k].start < b) { e = k; break; } }
    if (e < s) e = s;
    return { start: s, end: e };
  }
  function paraCount(text) { return paraMarks(text).length; }
  function rangeText(text, r) {
    const marks = paraMarks(text);
    if (!r || !marks.length) return '';
    const a = Math.max(0, Math.min(r.start, marks.length - 1));
    const b = Math.max(a, Math.min(r.end, marks.length - 1));
    return text.slice(marks[a].start, marks[b].end);
  }
  function rangeLabel(r) { return r ? ('第 ' + (r.start + 1) + '~' + (r.end + 1) + ' 段') : ''; }

  function paraTextNode(text) { return h('div.para-text.pre-wrap', { text: text }); }
  function noteNode(text) { return h('div.footnote', { text: text }); }

  /* 不含空白的字数（和顶部 chip 的口径一致） */
  function plainChars(t) { return String(t || '').replace(/\s/g, '').length; }

  /* 找出一段文本里所有匹配位置（大小写不敏感）。查找/替换用。 */
  function findMatches(text, needle) {
    const n = String(needle || '');
    if (!n) return [];
    const hay = String(text || '').toLowerCase();
    const nee = n.toLowerCase();
    const out = [];
    let i = hay.indexOf(nee);
    while (i >= 0) {
      out.push({ start: i, end: i + nee.length });
      i = hay.indexOf(nee, i + Math.max(1, nee.length));
    }
    return out;
  }

  /* 章节行右边那个「读」：不用先开写作台，直接进沉浸阅读器 */
  function readBtn(nid, c) {
    const b = h('button.ed-read', { type: 'button', 'aria-label': '阅读这一章' }, icon('book', { size: 17 }));
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      haptic('light');
      if (window.MZReader && MZReader.open) MZReader.open(nid, c.id, { title: c.title, idx: c.idx });
      else toast('阅读器没加载出来，退出重进一次试试', 'bad');
    });
    return b;
  }

  /* ============================== 写作标签页 ============================== */
  function bookNeed(n) {
    const daily = (n.plan && n.plan.daily) || n.daily_count || 0;
    const made = (n.plan && n.plan.today_made) || 0;
    return Math.max(0, daily - made);
  }
  /* 一张可以左右滑的选书卡：封面 + 书名 + 今日还差几章，
     当前正在写的那本贴一个「当前」角标。 */
  function pickCard(n, mine, onTap) {
    const el = h('button.pick-card' + (mine ? '.on' : ''), { type: 'button' });
    const title = n.title || '未命名';
    const cov = h('div.pick-cover');
    if (n.cover_url) {
      const img = document.createElement('img');
      img.alt = ''; img.decoding = 'async'; img.loading = 'lazy';
      /* 必须走 MZ.img()：封面地址是 /api/covers/...，取图要带会话口令。
         装机版（iPhone / iPad）跑在 capacitor://localhost，裸相对路径既拼不对主机、
         又没带 ?mz_sess=，两张卡就永远是空白 —— 书架那边一直用的是 MZ.img()，
         写作台这一处漏了，用户的原话是「写作台没有封面」。 */
      img.src = MZ.img(n.cover_url);
      img.addEventListener('error', function () {
        if (img.parentNode) img.parentNode.removeChild(img);
        cov.appendChild(h('span.pick-ph', { text: title.slice(0, 1) }));
      });
      cov.appendChild(img);
    } else {
      cov.appendChild(h('span.pick-ph', { text: title.slice(0, 1) }));
    }
    el.appendChild(cov);
    if (mine) el.appendChild(h('span.pick-badge', { text: '当前' }));
    el.appendChild(h('div.pick-name', { text: '《' + title + '》' }));
    const need = bookNeed(n);
    el.appendChild(h('div.pick-sub', { text: (n.chapter_count || 0) + ' 章 · '
      + (need > 0 ? ('今日还差 ' + need + ' 章') : '今日已更完') }));
    el.addEventListener('click', function () { haptic('light'); onTap(n.id); });
    return el;
  }

  A.screens.write = function () {
    return {
      title: '写作',
      action: null,
      /* 切完书这一屏会整块重建，横向那条选书卡也回到初始位置 —— 选中的那张可能被甩到
         屏幕外，看着就像「点了没切换」。这里把它滚回眼前（只动这一条的横向，不动整页）。 */
      after(body) {
        const on = body.querySelector('.pick-strip .pick-card.on');
        if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'center' });
      },
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

        /* 写作页选书：横滑卡片（scroll-snap），跟写作台里「换书」抽屉同一套卡片。
           以前这里是一排小药丸（.pillbar），书一多就换行，也看不到封面和今日进度，
           用户的原话就是「写作页面还是没有滑动选择书」。 */
        out.appendChild(h('div.pick-hint', { text: '左右滑动挑书 · 点一下切到这本' }));
        const picker = h('div.pick-strip.slim.no-drag');
        novels.forEach(function (n) {
          picker.appendChild(pickCard(n, Number(n.id) === Number(selectedNovelId), function (id) {
            selectedNovelId = id; haptic('light'); A.render();
          }));
        });
        out.appendChild(picker);

        const d = await api.get('/api/novel/' + selectedNovelId);
        const n = d.novel || {};
        const made = (n.plan && n.plan.today_made) || 0;
        const daily = (n.plan && n.plan.daily) || n.daily_count || 0;

        const hero = h('div.card');
        hero.appendChild(h('div.row', { style: { gap: '16px', alignItems: 'center' } },
          MZUI.ring(daily ? Math.min(100, (made / daily) * 100) : 0, '今日进度', 78, 'var(--accent)'),
          h('div.flex1', null,
            h('div', { style: { fontSize: '15.5px', fontWeight: '660' }, text: '《' + (n.title || '') + '》' }),
            h('div.small.muted.mt8', { text: '今日 ' + made + '/' + daily + ' 章 · 全书 ' + (n.chapter_count || 0) + ' 章 ' + fmtNum(n.total_chars || 0) + ' 字' }))));
        const chapters = (n.chapters || []).slice().sort(function (a, b) { return b.idx - a.idx; });
        const heroActs = [{ label: '补更（续写）', tone: 'primary', onTap: function () { A.askUpdate(n); } }];
        if (chapters.length) {
          heroActs.push({ label: '写最新一章', onTap: function () { openChapter(selectedNovelId, chapters[0].id, { title: chapters[0].title, idx: chapters[0].idx, nid: selectedNovelId }); } });
        }
        if (A.liveBusy(A.state.live)) heroActs.push({ label: '停止全部', tone: 'danger', size: 'sm', onTap: function () { A.stopAll(); } });
        hero.appendChild(buttons(heroActs));
        out.appendChild(hero);

        if (A.liveBusy(A.state.live)) out.appendChild(h('div.mt12', null, MZUI.liveHero(A.state.live, { maxEvents: 4 })));

        if (!chapters.length) {
          out.appendChild(emptyBox('write', '还没有章节', '点「补更（续写）」开始写第一章'));
          return out;
        }
        const scoreMap = {};
        (n.metrics || []).forEach(function (m) { scoreMap[m.idx] = m.score; });
        out.appendChild(h('div.section-title', null,
          h('span', { text: '章节' }), h('span.sp', { text: '点开就能改 · 共 ' + chapters.length + ' 章' })));
        const kw = h('input.inp', { type: 'search', placeholder: '输入章号或标题找章节…', spellcheck: 'false' });
        out.appendChild(kw);
        const listBox = h('div.list.rise-list');
        const moreBox = h('div.mt12');
        out.appendChild(listBox); out.appendChild(moreBox);
        let limit = 40;
        function paintList() {
          const k = (kw.value || '').trim().toLowerCase();
          const hits = k ? chapters.filter(function (c) {
            return String(c.idx).indexOf(k) >= 0 || String(c.title || '').toLowerCase().indexOf(k) >= 0;
          }) : chapters;
          clear(listBox); clear(moreBox);
          hits.slice(0, limit).forEach(function (c, i) {
            const sc = scoreMap[c.idx];
            const row = li({
              title: '第 ' + c.idx + ' 章　' + (c.title || ''),
              sub: fmtNum(c.chars || 0) + ' 字 · ' + (c.updated_at ? timeAgo(c.updated_at) : ''),
              right: h('div.row', { style: { gap: '7px' } },
                sc === undefined ? null : chip(String(Math.round(sc)), sc >= 75 ? 'ok' : (sc >= 55 ? '' : 'bad')),
                readBtn(selectedNovelId, c)),
              arrow: true,
              onTap: function () { openChapter(selectedNovelId, c.id, { title: c.title, idx: c.idx, nid: selectedNovelId }); },
            });
            row.style.setProperty('--i', String(i));
            listBox.appendChild(row);
          });
          if (!hits.length) moreBox.appendChild(h('div.small.muted.center', { text: '没找到「' + k + '」相关的章节' }));
          else if (hits.length > limit) {
            moreBox.appendChild(buttons([{ label: '再显示 40 章（还有 ' + (hits.length - limit) + ' 章）',
              onTap: function () { limit += 40; paintList(); } }]));
          }
        }
        kw.addEventListener('input', function () { limit = 40; paintList(); });
        paintList();
        return out;
      },
    };
  };
  /* ============================== 检查结果渲染（按后端真实字段） ============================== */
  /* 合规：{level, level_name, count, chars, kinds, hits[{word,kind,paras[],count,suggest,advice,level}]} */
  function complianceNode(res) {
    const box = h('div');
    if (!res) {
      box.appendChild(noteNode('还没跑过。合规预检走本机雷区词表，秒出结果，不联网、不花额度。'));
      return box;
    }
    const lv = res.level || 'ok';
    const clean = lv === 'ok';
    box.appendChild(h('div.row', { style: { gap: '13px', alignItems: 'center' } },
      h('div.big-num' + (clean ? '.ok' : '.warn'), { text: String(res.count || 0) }),
      h('div.flex1', null,
        h('div.row.wrap', { style: { gap: '6px' } },
          chip(res.level_name || lv, clean ? 'ok' : 'bad', 'shield'),
          chip(fmtNum(res.chars || 0) + ' 字', ''),
          res.kinds ? chip(res.kinds + ' 类风险词', 'warn') : null),
        h('div.small.muted.mt8', { text: clean
          ? '这一章没踩到平台的雷区词，可以直接发。'
          : '发布前建议逐条改掉，标了「要紧」的先改。' }))));
    const hits = res.hits || [];
    if (hits.length) {
      box.appendChild(h('div.section-title', { text: '命中 ' + hits.length + ' 处' }));
      const l = h('div.list');
      hits.slice(0, 16).forEach(function (hd) {
        l.appendChild(li({
          ico: hd.level === 'high' ? 'bolt' : 'dot',
          title: String(hd.word || '') + (hd.kind ? '　' + hd.kind : ''),
          sub: '第 ' + ((hd.paras || []).join('、') || '—') + ' 段 ×' + (hd.count || 1)
            + (hd.suggest ? ' · 可改成：' + hd.suggest : '')
            + (hd.advice ? ' · ' + hd.advice : ''),
          right: hd.level === 'high' ? chip('要紧', 'bad') : null,
        }));
      });
      box.appendChild(l);
      if (hits.length > 16) box.appendChild(noteNode('还有 ' + (hits.length - 16) + ' 处没列出来。'));
    }
    return box;
  }

  /* 钩子：{has_hook, strength, kind, why, candidates[], cached} */
  function hookNode(res) {
    const box = h('div');
    if (!res) {
      box.appendChild(noteNode('还没体检过。看章节结尾有没有让人想点下一章的东西。'));
      return box;
    }
    const s = Math.round(res.strength || 0);
    const tone = s >= 70 ? 'ok' : (s >= 45 ? 'warn' : 'bad');
    box.appendChild(h('div.row', { style: { gap: '14px', alignItems: 'center' } },
      MZUI.ring(res.has_hook ? s : 0, '钩子强度', 78),
      h('div.flex1', null,
        h('div.row.wrap', { style: { gap: '6px' } },
          chip(res.has_hook ? '有钩子' : '没有钩子', res.has_hook ? tone : 'bad', 'hook'),
          res.kind ? chip(res.kind, '', 'spark') : null,
          res.cached ? chip('上次结果', '') : null),
        res.why ? h('div.small.muted.mt8', { text: res.why }) : null)));
    const cands = res.candidates || [];
    if (cands.length) {
      box.appendChild(h('div.section-title', null,
        h('span', { text: '候选钩子' }), h('span.sp', { text: '点一下插到章末' })));
      const l = h('div.list');
      cands.forEach(function (c) {
        const txtv = String(c || '');
        l.appendChild(li({
          ico: 'hook', title: txtv, right: chip('插入', '', 'down'),
          onTap: function () { insertHook(txtv); },
        }));
      });
      box.appendChild(l);
    }
    return box;
  }

  /* 读者视角：{verdict, chars, personas[{who,drop_at,why,best,worst}], fixes[]} */
  function readerDropRange(res) {
    const ps = (res && res.personas) || [];
    const drops = ps.map(function (p) { return parseInt(p.drop_at, 10) || 0; }).filter(function (x) { return x > 0; });
    const total = paraCount(textArea.value);
    if (!drops.length || !total) return null;
    const last = total - 1;
    const a = Math.max(0, Math.min(Math.min.apply(null, drops) - 1, last));
    const b = Math.max(a, Math.min(Math.max.apply(null, drops) - 1, last));
    return { start: a, end: b };
  }
  function readerNode(res) {
    const box = h('div');
    if (!res) {
      box.appendChild(noteNode('还没跑过。三个不同口味的读者各读一遍，指出谁在第几段看不下去、为什么。'));
      return box;
    }
    const ps = res.personas || [];
    const drops = ps.filter(function (p) { return (parseInt(p.drop_at, 10) || 0) > 0; });
    box.appendChild(h('div.row', { style: { gap: '13px', alignItems: 'center' } },
      MZUI.ring(drops.length ? Math.max(12, 100 - drops.length * 26) : 100, '留存', 76),
      h('div.flex1', null,
        h('div.row.wrap', { style: { gap: '6px' } },
          chip(drops.length ? drops.length + ' 人想划走' : '都看完了', drops.length ? 'warn' : 'ok', 'eye'),
          chip(fmtNum(res.chars || 0) + ' 字', '')),
        res.verdict ? h('div.small.muted.mt8', { text: res.verdict }) : null)));
    ps.forEach(function (p, i) {
      const at = parseInt(p.drop_at, 10) || 0;
      const c = h('div.card.tight.mt12');
      c.style.setProperty('--i', String(i));
      c.appendChild(h('div.row', { style: { gap: '8px', alignItems: 'center' } },
        chip(p.who || ('读者 ' + (i + 1)), at ? 'warn' : 'ok'),
        at ? h('span.small', { style: { color: 'var(--amber)' }, text: '第 ' + at + ' 段想划走' })
           : h('span.small.muted', { text: '看完了' })));
      if (p.why) c.appendChild(h('div.small.muted.mt8.pre-wrap', { text: p.why }));
      if (p.best) c.appendChild(h('div.small.mt8', null, h('b', { text: '最好：' }), h('span.muted', { text: p.best })));
      if (p.worst) c.appendChild(h('div.small.mt8', null, h('b', { text: '最假：' }), h('span.muted', { text: p.worst })));
      box.appendChild(c);
    });
    const fixes = res.fixes || [];
    if (fixes.length) {
      box.appendChild(h('div.section-title', { text: '最该改的几处' }));
      const l = h('div.list');
      fixes.forEach(function (f) { l.appendChild(li({ ico: 'bolt', title: String(f) })); });
      box.appendChild(l);
    }
    const r = readerDropRange(res);
    if (r) {
      box.appendChild(h('div.btn-row.mt12', null,
        A._btn('按读者建议改 ' + rangeLabel(r), 'primary', function () { readerFix(res, r); })));
      box.appendChild(noteNode('会把「谁在第几段想划走 + 上面的改法」当成改写要求，只动这几段，前后文一个字不改；改完自动复跑一次读者视角。'));
    } else if (ps.length) {
      box.appendChild(noteNode('三个人设都看完了、没有想划走的段落，这一章不用重写。'));
    }
    return box;
  }

  /* 一致性：{score, verdict, counts{bad,warn,info}, dims[{key,name,score,weight,detail}], issues[{level,where,title,evidence,advice}], checked{cards,chapters,chars,ms}, scope, neighbors[]} */
  const CONS_LV = { bad: '要紧', warn: '建议', info: '提示' };
  const CONS_CLS = { bad: 'bad', warn: 'warn', info: '' };
  function consColor(s) {
    if (s === null || s === undefined) return 'var(--muted)';
    return s >= 90 ? 'var(--accent)' : (s >= 75 ? 'var(--blue)' : (s >= 60 ? 'var(--amber)' : 'var(--red)'));
  }
  function consistencyNode(res) {
    const box = h('div');
    if (!res) {
      box.appendChild(noteNode('本地规则检查：拿正文和设定卡、状态卡对一遍，查跨章衔接、人物、时间线、伏笔。不联网、不花额度，秒出。'));
      return box;
    }
    const ck = res.checked || {}, c = res.counts || {}, score = res.score;
    const ms = ck.ms || 0;
    box.appendChild(h('div.row', { style: { gap: '13px', alignItems: 'center' } },
      h('div.big-num', { style: { color: consColor(score) }, text: score === null || score === undefined ? '—' : String(score) }),
      h('div.flex1', null,
        h('div.small.muted', { text: res.verdict || '' }),
        h('div.row.wrap.mt8', { style: { gap: '6px' } },
          chip('要紧 ' + (c.bad || 0), (c.bad ? 'bad' : ''), 'bolt'),
          chip('建议 ' + (c.warn || 0), (c.warn ? 'warn' : '')),
          chip('提示 ' + (c.info || 0), ''),
          chip('本地检查 · 不花额度', 'ok', 'shield')),
        h('div.dim.small.mt8', { text: '读了 ' + fmtNum(ck.chars || 0) + ' 字 · ' + fmtNum(ck.cards || 0) + ' 张设定卡 · 用时 '
          + (ms < 1000 ? Math.max(1, Math.round(ms)) + ' 毫秒' : (ms / 1000).toFixed(1) + ' 秒') }))));
    const dims = res.dims || [];
    if (dims.length) {
      box.appendChild(h('div.section-title', { text: '七个维度' }));
      dims.forEach(function (d) {
        box.appendChild(h('div.dim-row', null,
          h('span.dn', { text: d.name || d.key }),
          A.bar(d.score === null || d.score === undefined ? 0 : d.score),
          h('span.dv.num', { text: d.score === null || d.score === undefined ? '—' : String(d.score) })));
        if (d.detail) box.appendChild(h('div.dim-detail', { text: d.detail }));
      });
    }
    const issues = res.issues || [];
    box.appendChild(h('div.section-title', { text: '查出来的问题' }));
    if (!issues.length) {
      box.appendChild(h('div.issue.ok', { text: '没查出前后矛盾，很干净。' }));
    } else {
      issues.forEach(function (it) {
        const row = h('div.issue' + (CONS_CLS[it.level] ? '.' + CONS_CLS[it.level] : ''));
        row.appendChild(h('div.row', { style: { gap: '7px', alignItems: 'center' } },
          chip(CONS_LV[it.level] || it.level || '', CONS_CLS[it.level] || ''),
          it.where ? h('span.dim.small', { text: it.where }) : null,
          h('span', { text: it.title || '' })));
        if (it.evidence) row.appendChild(h('div.dim.small.mt8', { text: '依据：' + it.evidence }));
        if (it.advice) row.appendChild(h('div.small.mt8', { text: '改法：' + it.advice }));
        box.appendChild(row);
      });
    }
    return box;
  }
  /* 所有异步入口都过这道闸：失败只弹一条提示，不产生未处理的 rejection */
  function guard(p) {
    return Promise.resolve(p).catch(function (e) {
      const msg = (e && e.message) || String(e || '出错了');
      if (msg !== 'busy') toast(msg, 'bad');
    });
  }

  /* ============================== 编辑器 ============================== */
  let ed = null;
  let inspector = null;      /* 打开着的检查抽屉：{tab, paint()} */

  /* ---- 正文字号 / 行距：只记在这台设备上，换章、重开都还在 ---- */
  const FS_KEY = 'mz_ed_fs', LH_KEY = 'mz_ed_lh';
  const FS_STEPS = [15, 16, 17, 18, 19, 20, 22, 24];
  const LH_STEPS = [1.6, 1.75, 1.85, 1.95, 2.1];
  function readNum(key, def) {
    try { const v = parseFloat(localStorage.getItem(key)); return (isFinite(v) && v > 0) ? v : def; }
    catch (e) { return def; }
  }
  function writeNum(key, v) { try { localStorage.setItem(key, String(v)); } catch (e) { /* 忽略 */ } }
  function textPrefs() { return { fs: readNum(FS_KEY, 17), lh: readNum(LH_KEY, 1.85) }; }
  function applyTextPrefs() {
    if (!ed || !ed.wrap) return;
    const p = textPrefs();
    ed.wrap.style.setProperty('--ed-fs', p.fs + 'px');
    ed.wrap.style.setProperty('--ed-lh', String(p.lh));
  }
  function fontSheet() {
    const box = h('div');
    const fsLabel = h('span.chip');
    const lhLabel = h('span.chip');
    function paintChips() {
      const p = textPrefs();
      fsLabel.textContent = '字号 ' + p.fs;
      lhLabel.textContent = '行距 ' + p.lh;
    }
    function setF(step) {
      const cur = textPrefs().fs;
      let i = FS_STEPS.indexOf(Math.round(cur));
      if (i < 0) i = FS_STEPS.indexOf(17);
      i = Math.max(0, Math.min(FS_STEPS.length - 1, i + step));
      writeNum(FS_KEY, FS_STEPS[i]); applyTextPrefs(); paintChips(); haptic('light');
    }
    function setL(step) {
      const cur = textPrefs().lh;
      let i = 0;
      for (let k = 1; k < LH_STEPS.length; k++) { if (Math.abs(LH_STEPS[k] - cur) < Math.abs(LH_STEPS[i] - cur)) i = k; }
      i = Math.max(0, Math.min(LH_STEPS.length - 1, i + step));
      writeNum(LH_KEY, LH_STEPS[i]); applyTextPrefs(); paintChips(); haptic('light');
    }
    function prow(label, down, up, tag) {
      return h('div.row', { style: { gap: '8px', alignItems: 'center', marginTop: '8px' } },
        h('span.small.muted', { style: { flex: '0 0 auto', width: '42px' }, text: label }),
        A._btn(down, '', function () { (label === '字号' ? setF : setL)(-1); }),
        A._btn(up, '', function () { (label === '字号' ? setF : setL)(1); }),
        h('span.sp'),
        tag);
    }
    box.appendChild(h('div.card.tight', null,
      prow('字号', '小 A', '大 A', fsLabel),
      prow('行距', '紧一点', '松一点', lhLabel)));
    box.appendChild(noteNode('只存在这台设备上，不影响别人。沉浸模式下也照样生效。'));
    box.appendChild(h('div.mt12', null, buttons([{ label: '恢复默认（17 号 / 1.85 倍）',
      onTap: function () { writeNum(FS_KEY, 17); writeNum(LH_KEY, 1.85); applyTextPrefs(); paintChips(); haptic('light'); } }])));
    paintChips();
    sheet({ title: '正文字号与行距', build: function (b) { b.appendChild(box); } });
  }

  async function openChapter(nid, cid, opt) {
    opt = opt || {};
    if (ed) return;
    const wrap = h('div.ed-wrap');
    document.body.appendChild(wrap);
    document.body.style.overflow = 'hidden';
    ed = {
      nid: nid, cid: cid, dirty: false, saving: false, data: null,
      wrap: wrap, check: {}, timers: [], savedAt: '',
    };
    applyTextPrefs();

    /* ---- 顶部：返回 / 章号 / 检查 ---- */
    const nav = h('div.ed-nav');
    const navRow = h('div.nb-row');
    const back = h('button.nb-back', { type: 'button' }, h('span', { text: '‹' }));
    const prevBtn = h('button.ed-step', { type: 'button', 'aria-label': '上一章' }, h('span', { text: '‹' }));
    const nextBtn = h('button.ed-step', { type: 'button', 'aria-label': '下一章' }, h('span', { text: '›' }));
    const navTitle = h('button.ed-titletap', { type: 'button', text: opt.idx ? '第 ' + opt.idx + ' 章' : '章节' });
    const immersiveBtn = h('button.nb-action.ed-nb-sm', { type: 'button', 'aria-label': '沉浸模式' }, icon('eye', { size: 17 }));
    const navAct = h('button.nb-action', { type: 'button', text: '检查' });
    navRow.appendChild(back); navRow.appendChild(prevBtn); navRow.appendChild(navTitle);
    navRow.appendChild(nextBtn); navRow.appendChild(immersiveBtn); navRow.appendChild(navAct);
    const meta = h('div.ed-meta');
    nav.appendChild(navRow); nav.appendChild(meta);

    /* ---- 章节目录：上一章 / 下一章 / 点标题跳章 ---- */
    let chList = [];
    let chIdx = -1;
    function paintNavSteps() {
      const multi = chList.length > 1;
      prevBtn.disabled = !(chIdx > 0);
      nextBtn.disabled = !(chIdx >= 0 && chIdx < chList.length - 1);
      prevBtn.style.opacity = prevBtn.disabled ? '.3' : '';
      nextBtn.style.opacity = nextBtn.disabled ? '.3' : '';
      navTitle.textContent = (opt.idx ? '第 ' + opt.idx + ' 章' : '章节')
        + (multi && chIdx >= 0 ? ' · ' + (chIdx + 1) + '/' + chList.length : '');
    }
    async function loadChapterList() {
      try {
        const r = await api.get('/api/novel/' + nid + '/chapters');
        if (!ed) return;
        chList = (r.chapters || []).slice().sort(function (a, b) { return a.idx - b.idx; });
        chIdx = -1;
        for (let i = 0; i < chList.length; i++) { if (Number(chList[i].id) === Number(cid)) { chIdx = i; break; } }
        paintNavSteps();
      } catch (e) { /* 目录拿不到不影响写作 */ }
    }
    let closeJump = function () { };
    function jumpList() {
      if (!chList.length) { toast('还没有章节', 'warn'); return; }
      const box = h('div');
      const kw2 = h('input.inp', { type: 'search', placeholder: '输入章号或标题…', spellcheck: 'false' });
      const lb = h('div.list');
      function paint() {
        const k = (kw2.value || '').trim().toLowerCase();
        clear(lb);
        const hits = k ? chList.filter(function (c) {
          return String(c.idx).indexOf(k) >= 0 || String(c.title || '').toLowerCase().indexOf(k) >= 0;
        }) : chList.slice(Math.max(0, chIdx - 25), chIdx + 26);
        if (!hits.length) { lb.appendChild(h('div.small.muted.center', { text: '没找到' })); return; }
        hits.forEach(function (c) {
          lb.appendChild(li({
            title: '第 ' + c.idx + ' 章　' + (c.title || ''),
            sub: fmtNum(c.chars || 0) + ' 字',
            right: Number(c.id) === Number(cid) ? chip('当前', 'ok') : null,
            onTap: function () { closeJump(); gotoChapter(c); },
          }));
        });
      }
      kw2.addEventListener('input', paint);
      box.appendChild(kw2);
      box.appendChild(h('div.mt8', null, lb));
      const sh = sheet({ title: '跳章 · 共 ' + chList.length + ' 章', height: '72vh',
        build: function (b) { b.appendChild(box); paint(); } });
      closeJump = function () { sh.close(); };
    }
    async function switchTo(c) {
      if (!ed || !c) return;
      if (ed.dirty) {
        await save(false);
        /* 还脏就是没存上：切走会 teardown，那一章的新改动就没了 */
        if (ed && ed.dirty) { toast('这一章还没保存上，先别切章', 'bad'); return; }
      }
      if (!ed) return;
      teardown();
      await openChapter(nid, c.id, { title: c.title, idx: c.idx, nid: nid });
    }
    function gotoChapter(c) { if (!c || Number(c.id) === Number(cid)) return; switchTo(c); }
    function stepChapter(d) {
      if (chIdx < 0) { toast('章节目录还没加载好，稍后再试', 'warn'); return; }
      const t = chList[chIdx + d];
      if (!t) { toast(d > 0 ? '已经是最后一章了' : '已经是第一章了', 'warn'); return; }
      switchTo(t);
    }

    /* ---- 查找 / 替换 ---- */
    const findInput = h('input.inp.ed-find-in', { type: 'text', placeholder: '查找…', spellcheck: 'false' });
    const replInput = h('input.inp.ed-find-in', { type: 'text', placeholder: '替换为…（留空就是删掉）', spellcheck: 'false' });
    const findCount = h('span.small.muted', { text: '0/0' });
    const findBar = h('div.ed-find', { hidden: true },
      h('div.row', { style: { gap: '8px' } }, findInput, findCount),
      h('div.row.mt8', { style: { gap: '8px' } }, replInput),
      h('div.btn-row.mt8', null,
        A._btn('上一个', '', function () { findStep(-1); }),
        A._btn('下一个', '', function () { findStep(1); }),
        A._btn('替换', '', function () { replaceOne(); }),
        A._btn('全部替换', 'primary', function () { replaceAll(); }),
        A._btn('关闭', '', function () { toggleFind(false); })));
    let findHits = [], findPos = -1;
    findInput.addEventListener('input', function () { findPos = -1; findScan(); });
    function findScan() {
      findHits = findMatches(textArea.value, findInput.value);
      if (findPos >= findHits.length) findPos = findHits.length - 1;
      if (findPos < -1) findPos = -1;
      findCount.textContent = (findHits.length && findPos >= 0 ? (findPos + 1) : 0) + '/' + findHits.length;
      return findHits;
    }
    function scrollToChar(pos) {
      const total = textArea.value.length || 1;
      const ratio = Math.max(0, Math.min(1, pos / total));
      textArea.scrollTop = Math.max(0, ratio * textArea.scrollHeight - textArea.clientHeight / 2);
    }
    function findStep(d) {
      const hits = findScan();
      if (!hits.length) { toast('没找到「' + findInput.value + '」', 'warn'); return; }
      findPos = findPos < 0 ? (d > 0 ? 0 : hits.length - 1) : (findPos + d + hits.length) % hits.length;
      findScan();
      const t = hits[findPos];
      textArea.focus();
      textArea.setSelectionRange(t.start, t.end);
      scrollToChar(t.start);
    }
    function replaceOne() {
      const hits = findScan();
      if (!hits.length) { toast('没找到「' + findInput.value + '」', 'warn'); return; }
      if (findPos < 0) findPos = 0;
      const t = hits[findPos];
      const before = snapshot();
      textArea.setRangeText(replInput.value, t.start, t.end, 'end');
      recordBefore(before);
      findPos = -1;
      onEdit();
      findScan();
      haptic('light');
    }
    function replaceAll() {
      const hits = findScan();
      if (!hits.length) { toast('没找到「' + findInput.value + '」', 'warn'); return; }
      const before = snapshot();
      const parts = [];
      let last = 0;
      hits.forEach(function (t) { parts.push(textArea.value.slice(last, t.start), replInput.value); last = t.end; });
      parts.push(textArea.value.slice(last));
      textArea.value = parts.join('');
      recordBefore(before);
      findPos = -1;
      onEdit();
      findScan();
      toast('已替换 ' + hits.length + ' 处', 'ok');
      haptic('success');
    }
    function toggleFind(on) {
      const want = on === undefined ? findBar.hidden : !!on;
      findBar.hidden = !want;
      if (want) {
        const sel = textArea.value.slice(textArea.selectionStart, textArea.selectionEnd).trim();
        if (sel && sel.length <= 40 && sel.indexOf('\n') < 0) findInput.value = sel;
        findScan();
        setTimeout(function () { findInput.focus(); findInput.select(); }, 40);
      } else {
        textArea.focus();
      }
      syncDockLift();
    }

    /* ---- 撤销 / 重做（只在本机记快照，不碰服务端） ---- */
    ed.undo = []; ed.redo = []; ed.lastSnap = null;
    function snapshot() { return { title: titleInput.value, content: textArea.value }; }
    function markSnap() { ed.lastSnap = snapshot(); }
    /* 历史里存的一律是「改之前」的状态：撤销才看得见变化 */
    function _pushSnap(s) {
      if (!s || !ed) return;
      const last = ed.undo[ed.undo.length - 1];
      if (last && last.title === s.title && last.content === s.content) return;
      ed.undo.push({ title: s.title, content: s.content });
      if (ed.undo.length > 60) ed.undo.shift();
      ed.redo.length = 0;
    }
    /* 在「即将改正文」之前调用：把当前状态记进历史 */
    function pushHistory() {
      if (!ed) return;
      markSnap();
      _pushSnap(ed.lastSnap);
    }
    /* 已经改完才想起来记：把「改之前」的状态记进历史 */
    function recordBefore(prev) { if (!ed) return; markSnap(); _pushSnap(prev); }
    /* 把「刚才那一串输入」结算成一条历史（撤销前先结算，免得刚打完字还撤不动） */
    function noteEdit() {
      if (!ed || !ed.lastSnap) return;
      const s = snapshot();
      if (s.title === ed.lastSnap.title && s.content === ed.lastSnap.content) return;
      const prev = ed.lastSnap;
      ed.lastSnap = s;
      _pushSnap(prev);
    }
    const historyTick = MZ.debounce(function () { noteEdit(); }, 900);
    function applySnap(s) {
      titleInput.value = s.title;
      textArea.value = s.content;
      if (!ed) return;
      ed.lastSnap = { title: s.title, content: s.content };
      ed.dirty = true;
      paintMeta();
      autoSave();
    }
    function undo() {
      noteEdit();
      if (!ed || !ed.undo.length) { toast('没有可撤销的修改了', 'warn'); return; }
      const cur = snapshot();
      applySnap(ed.undo.pop());
      ed.redo.push(cur);
      haptic('light');
      toast('已撤销', 'ok');
    }
    function redo() {
      if (!ed || !ed.redo.length) { toast('没有可重做的修改', 'warn'); return; }
      const cur = snapshot();
      applySnap(ed.redo.pop());
      ed.undo.push(cur);
      haptic('light');
    }

    /* ---- 沉浸模式：只留正文 ---- */
    const exitBtn = h('button.ed-exit', { type: 'button', hidden: true },
      icon('down', { size: 15 }), h('span', { text: '退出全屏' }));
    function setImmersive(on) {
      wrap.classList.toggle('ed-immersive', !!on);
      /* 顶栏和底部标签栏在 wrap 外面，得挂在 body 上才藏得住 */
      document.body.classList.toggle('ed-immersive', !!on);
      exitBtn.hidden = !on;
      immersiveBtn.classList.toggle('on', !!on);
      syncDockLift();
      if (on) { toast('沉浸模式：只留正文，右上角「退出全屏」回来', 'ok'); setTimeout(function () { textArea.focus(); }, 60); }
    }
    exitBtn.addEventListener('click', function () { haptic('light'); setImmersive(false); });

    /* ---- 本章目标字数 ---- */
    async function editTarget() {
      const cur = (ed && ed.data && ed.data.target_words) || 2500;
      const v = await modal({
        title: '本章目标字数', text: '只影响字数达标度和进度显示，不会改正文。',
        input: 'number', value: String(cur), okText: '保存',
      });
      if (v === null) return;
      const n2 = Math.max(300, Math.min(20000, parseInt(v, 10) || 2500));
      try {
        await api.put('/api/novel/' + nid, { target_words: n2 });
        if (ed) ed.data.target_words = n2;
        paintMeta();
        toast('目标字数已改成 ' + fmtNum(n2), 'ok');
      } catch (e) { toast(e.message, 'bad'); }
    }

    /* ---- 导出本章 ---- */
    async function exportChapter() {
      const text = (titleInput.value ? titleInput.value + '\n\n' : '') + textArea.value;
      if (!text.trim()) { toast('正文是空的', 'warn'); return; }
      const idx = (ed && ed.data && ed.data.chapter && ed.data.chapter.idx) || '';
      const name = '第' + idx + '章 ' + (titleInput.value || '') + '.txt';
      try {
        const r = await MZ.saveText(name, text);
        toast(r && r.native ? '已存到「文件 → 墨舟 → 墨舟导出」' : '已导出 ' + name, 'ok');
        haptic('success');
      } catch (e) { toast('导出失败：' + ((e && e.message) || e), 'bad'); }
    }

    /* ---- AI 接着写 / 卡文了给三个走向 ---- */
    function insertContinuation(text) {
      if (!ed) return;
      pushHistory();
      textArea.value = textArea.value.replace(/\s+$/, '') + '\n\n' + text;
      onEdit();
      haptic('success');
      toast('已插到章末，读一遍再点保存', 'ok');
    }
    function continueResult(text, words, hint) {
      sheet({
        title: '接着写好了 · ' + plainChars(text) + ' 字',
        build: function (b, close) {
          b.appendChild(h('div.card.tight.small', null, paraTextNode(text)));
          b.appendChild(h('div.btn-row.mt12', null,
            A._btn('插到章末', 'primary', function () { close(); insertContinuation(text); }),
            A._btn('再写一段', '', function () { close(); guard(runContinue('write', words, hint)); }),
            A._btn('复制', '', function () { clipboard(text); toast('已复制', 'ok'); }),
            A._btn('丢掉', '', function () { close(); })));
        },
      });
    }
    function ideasSheet(ideas, hint) {
      if (!ideas.length) { toast('没拿到走向建议，再试一次', 'warn'); return; }
      sheet({
        title: '卡文了？往这三个方向写',
        build: function (b, close) {
          b.appendChild(noteNode('点一条就按这个方向往下写；也可以只借方向，自己动笔。'));
          ideas.forEach(function (t, i) {
            b.appendChild(h('div.card.tight.mt12', null, h('div.small.pre-wrap', { text: (i + 1) + '. ' + t })));
          });
          b.appendChild(buttons(ideas.map(function (t, i) {
            return { label: '按第 ' + (i + 1) + ' 条写', tone: i === 0 ? 'primary' : '', onTap: function () {
              close();
              guard(runContinue('write', 800, (hint ? hint + '；' : '') + '按这个方向写：' + t));
            } };
          })));
        },
      });
    }
    async function runContinue(mode, words, hint) {
      const res = await runOp(mode === 'ideas' ? 'AI 想三个走向' : 'AI 接着写',
        '/api/chapter/' + cid + '/continue',
        { body: { mode: mode, words: words || 800, hint: hint || '' }, timeout: 900000, match: '接着写' });
      if (!ed) return;
      if (mode === 'ideas') { ideasSheet((res && res.ideas) || [], hint); return; }
      const text = (res && (res.text || (res.result && res.result.text))) || '';
      if (!text) { toast('模型没有返回内容', 'bad'); return; }
      continueResult(text, words, hint);
    }
    function continueSheet() {
      const s2 = sheet({ title: '接着写', height: 'auto' });
      let words = 600;
      const segs = h('div.seg');
      [300, 600, 1000, 1500].forEach(function (wd) {
        const b = h('button' + (wd === words ? '.on' : ''), { type: 'button', text: wd + ' 字' });
        b.addEventListener('click', function () {
          words = wd; haptic('light');
          Array.prototype.forEach.call(segs.children, function (x) { x.classList.remove('on'); });
          b.classList.add('on');
        });
        segs.appendChild(b);
      });
      const hint = h('input.inp', { type: 'text', placeholder: '想让它往哪写？（可留空）', spellcheck: 'false' });
      s2.body.appendChild(h('div.small.muted.mb8', { text: 'AI 顺着本章最后一句往下写；写完先给你看，点「插到章末」才进正文。' }));
      s2.body.appendChild(segs);
      s2.body.appendChild(h('div.mt12', null, hint));
      s2.body.appendChild(buttons([
        { label: '卡文了，给我三个走向', onTap: function () { s2.close(); guard(runContinue('ideas', 0, hint.value)); } },
        { label: '开始往下写', tone: 'primary', onTap: function () { s2.close(); guard(runContinue('write', words, hint.value)); } },
      ]));
    }

    /* ---- 键盘快捷键（iPad 外接键盘 / 桌面浏览器） ---- */
    function onKey(e) {
      if (!ed || !(e.metaKey || e.ctrlKey)) return;
      const k = String(e.key || '').toLowerCase();
      if (k === 's') { e.preventDefault(); guard(save(true)); }
      else if (k === 'f') { e.preventDefault(); toggleFind(true); }
      else if (k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (k === 'y') { e.preventDefault(); redo(); }
      else if (k === 'g') { e.preventDefault(); jumpList(); }
      else if (k === 'e') { e.preventDefault(); guard(exportChapter()); }
    }
    window.addEventListener('keydown', onKey);
    prevBtn.addEventListener('click', function () { haptic('light'); stepChapter(-1); });
    nextBtn.addEventListener('click', function () { haptic('light'); stepChapter(1); });
    navTitle.addEventListener('click', function () { haptic('light'); jumpList(); });
    immersiveBtn.addEventListener('click', function () { haptic('light'); setImmersive(!wrap.classList.contains('ed-immersive')); });

    const titleInput = h('input.ed-title', { type: 'text', placeholder: '章节标题', value: opt.title || '' });
    const textArea = h('textarea.ed-text', { placeholder: '在这里写正文…（输入会自动保存）', spellcheck: 'false' });
    const bodyBox = h('div.ed-body', null, titleInput, textArea);

    /* ---- 选中操作条：选中正文就浮出来 ---- */
    const selInfo = h('span.sel-info', { text: '未选中' });
    const selBar = h('div.sel-bar', { hidden: true },
      h('span.sel-ic', null, icon('edit', { size: 15 })),
      selInfo,
      h('span.sp'),
      h('button.sel-btn', { type: 'button', text: '局部改写' }),
      h('button.sel-btn', { type: 'button', text: '评分' }),
      h('button.sel-btn', { type: 'button', text: '复制' }));
    const selBtns = selBar.querySelectorAll('.sel-btn');
    function selRange() {
      const a = textArea.selectionStart, b = textArea.selectionEnd;
      if (b - a < 2) return null;
      return paraRange(textArea.value, a, b);
    }
    function paintSel() {
      const a = textArea.selectionStart, b = textArea.selectionEnd;
      const r = (b - a >= 2) ? paraRange(textArea.value, a, b) : null;
      if (!r) { selBar.hidden = true; syncDockLift(); return; }
      selBar.hidden = false;
      syncDockLift();
      selInfo.textContent = '已选 ' + rangeLabel(r) + ' · ' + (b - a) + ' 字';
      selBtns[0].disabled = false; selBtns[1].disabled = false; selBtns[2].disabled = false;
    }
    selBtns[0].addEventListener('click', function () { const r = selRange(); if (r) rewriteHint(r); });
    selBtns[1].addEventListener('click', function () {
      const r = selRange();
      if (!r) { toast('先在正文里选中几段', 'warn'); return; }
      runHit(r);
    });
    selBtns[2].addEventListener('click', function () { copySelection(); });
    ['select', 'keyup', 'touchend', 'mouseup', 'input'].forEach(function (ev) {
      textArea.addEventListener(ev, function () { setTimeout(paintSel, 0); });
    });

    /* ---- 底部工具条 ---- */
    const toolbar = h('div.ed-toolbar');
    function tb(label, tone, ico, onTap) {
      const b = h('button.tb' + (tone ? '.' + tone : ''), { type: 'button' },
        ico ? h('span.tb-i', null, icon(ico, { size: 15 })) : null,
        h('span', { text: label }));
      b.addEventListener('click', function () { haptic('light'); guard(onTap()); });
      toolbar.appendChild(b);
      return b;
    }
    tb('保存', 'primary', 'check', function () { save(true); });
    tb('接着写', 'blue', 'spark', function () { continueSheet('write'); });
    tb('复制整章', '', 'copy', function () { copyChapter(); });
    tb('重生成', '', 'spark', function () { regen(); });
    tb('去 AI 化', '', 'refresh', function () { deai(); });
    tb('起名', '', 'target', function () { autoTitle(); });
    tb('检查', 'blue', 'shield', function () { openInspect(); });
    tb('更多', '', 'more', function () { moreActions(); });

    wrap.appendChild(nav); wrap.appendChild(findBar); wrap.appendChild(bodyBox);
    wrap.appendChild(selBar); wrap.appendChild(toolbar); wrap.appendChild(exitBtn);

    /* 全局任务条是 body 级的 fixed 条，默认贴在标签栏上方；
       写作台没有标签栏，但底部有自己的工具条 + 选中条 —— 量出它们的高度，
       让任务条抬到上面去，别把工具条盖住。 */
    function syncDockLift() {
      if (!ed) return;
      const tb = (toolbar.getBoundingClientRect().height || 0);
      const sb = selBar.hidden ? 0 : (selBar.getBoundingClientRect().height || 0);
      document.documentElement.style.setProperty('--dock-bottom', Math.round(tb + sb + 12) + 'px');
    }
    syncDockLift();
    window.addEventListener('resize', syncDockLift);
    window.addEventListener('orientationchange', function () { setTimeout(syncDockLift, 260); });

    /* ---- 载入 ---- */
    async function load() {
      try {
        const d = await api.get('/api/chapter/' + cid);
        if (!ed) return;
        ed.data = d;
        const ch = d.chapter || {};
        titleInput.value = ch.title || '';
        textArea.value = ch.content || '';
        navTitle.textContent = '第 ' + (ch.idx || '') + ' 章';
        ed.dirty = false;
        ed.savedAt = '';
        ed.undo = []; ed.redo = []; ed.lastSnap = null;
        markSnap();
        ed.check.hit = d.hit_review || null;
        paintMeta();
        loadChapterList();
        loadCachedChecks();
      } catch (e) {
        clear(bodyBox);
        bodyBox.appendChild(errBox(e, load));
      }
    }

    /* 切章/重进后把这一章已有的合规 / 钩子 / 读者结果捞回来 */
    async function loadCachedChecks() {
      if (!ed) return;
      try {
        const a = await api.get('/api/chapter/' + cid + '/compliance');
        if (ed && a.review && a.review.result) ed.check.compliance = a.review.result;
      } catch (e) { /* 没有就算了 */ }
      try {
        const b = await api.get('/api/chapter/' + cid + '/hook');
        if (ed && b.review && b.review.result) ed.check.hook = b.review.result;
      } catch (e) { /* 没有就算了 */ }
      try {
        const nid2 = ed ? ed.nid : nid;
        const c = await api.get('/api/novel/' + nid2 + '/ledger/reader');
        const r = c.ledger && c.ledger.result;
        if (ed && r && Number(r.chapter_id) === Number(cid)) ed.check.reader = r;
      } catch (e) { /* 没有就算了 */ }
      refreshInspect();
    }

    /* ---- 选书：不用退出写作台，直接换一本书接着写 ---- */
    function bookTitleOf(id) { const n = A.findNovel(Number(id)); return (n && n.title) || ''; }
    async function openBookSheet() {
      const cur = Number(ed ? ed.nid : nid);
      let list = A.state.novels || [];
      if (!list.length) {
        try { await A.ensureHero(); } catch (e) { /* 拉不到就空列表 */ }
        list = A.state.novels || [];
      }
      const box = h('div');
      if (!list.length) {
        box.appendChild(h('div.small.muted.center', { text: '作品列表没拉出来，退回「写作」页刷新一下再试' }));
      } else {
        /* 横滑选书：左右滑卡片挑书（scroll-snap）。点卡片与点下面列表
           走的是同一条路（都是 guard(openBook(id))）。 */
        box.appendChild(h('div.pick-hint', { text: '左右滑动挑书 · 点一下就开始写这本' }));
        const strip = h('div.pick-strip.no-drag');
        list.forEach(function (n) {
          strip.appendChild(pickCard(n, Number(n.id) === cur, function (id) {
            sh.close(); guard(openBook(id));
          }));
        });
        box.appendChild(strip);
        box.appendChild(h('div.section-title', { text: '全部作品' }));
        const lb = h('div.list');
        list.forEach(function (n) {
          const mine = Number(n.id) === cur;
          const need = bookNeed(n);
          lb.appendChild(li({
            title: (mine ? '正在写　' : '') + '《' + (n.title || '未命名') + '》',
            sub: (n.chapter_count || 0) + ' 章 · ' + fmtNum(n.total_chars || 0) + ' 字'
              + (need > 0 ? ' · 今日还差 ' + need + ' 章' : ' · 今日已更完'),
            right: mine ? chip('当前', 'ok') : null,
            arrow: !mine,
            onTap: function () { sh.close(); if (!mine) guard(openBook(n.id)); },
          }));
        });
        box.appendChild(lb);
        box.appendChild(h('div.footnote', { text: '换书会自动把这一章的改动先存好，再跳到那本书的最后一章。' }));
      }
      let sh = null;
      sh = sheet({ title: '选择作品 · 共 ' + list.length + ' 本',
        height: '66vh', build: function (b) { b.appendChild(box); } });
    }
    async function openBook(id) {
      if (!ed || !id) return;
      if (Number(id) === Number(ed.nid)) return;
      if (ed.dirty) await save(false);
      if (!ed) return;
      let list = [];
      try {
        const r = await api.get('/api/novel/' + id + '/chapters');
        list = (r.chapters || []).slice().sort(function (a, b) { return a.idx - b.idx; });
      } catch (e) { /* 目录拿不到就当没有 */ }
      const last = list[list.length - 1];
      selectedNovelId = Number(id);
      if (!last) {
        toast('《' + bookTitleOf(id) + '》还没有章节，回「写作」页点「补更（续写）」开第一章', 'warn');
        teardown();
        A.render();
        return;
      }
      haptic('light');
      toast('已切到《' + bookTitleOf(id) + '》第 ' + last.idx + ' 章', 'ok');
      teardown();
      await openChapter(Number(id), last.id, { title: last.title, idx: last.idx, nid: Number(id) });
    }

    function paintMeta() {
      const d = ed && ed.data ? ed.data : {};
      const m = d.metrics || {};
      const chars = textArea.value.replace(/\s/g, '').length;
      const target = d.target_words || (d.chapter && d.chapter.target_words) || 2500;
      clear(meta);
      meta.appendChild(chip(fmtNum(chars) + ' 字', chars >= target ? 'ok' : '', 'write'));
      const tchip = chip('目标 ' + fmtNum(target), chars >= target ? 'ok' : '', 'target');
      tchip.style.cursor = 'pointer';
      tchip.title = '点一下改本章目标字数';
      tchip.addEventListener('click', function () { editTarget(); });
      meta.appendChild(tchip);
      if (m.score !== undefined && m.score !== null) {
        meta.appendChild(chip('质检 ' + Math.round(m.score), m.score >= 75 ? 'ok' : (m.score >= 55 ? '' : 'bad'), 'shield'));
      }
      const segs = paraCount(textArea.value);
      if (segs) meta.appendChild(chip(segs + ' 段', '', 'menu'));
      if (d.weak && d.weak.length) meta.appendChild(chip(d.weak.length + ' 段可疑', 'amber', 'bolt'));
      if (d.novel_title) {
        const bk = chip('《' + d.novel_title + '》', '', 'books');
        bk.classList.add('ed-book');
        bk.title = '点一下换一本书写';
        bk.addEventListener('click', function () { haptic('light'); openBookSheet(); });
        meta.appendChild(bk);
      }
      const si = h('div.ed-saveinfo');
      if (ed.saving) { si.textContent = '保存中…'; si.style.color = 'var(--muted)'; }
      else if (ed.dirty) { si.textContent = '● 有未保存修改'; si.style.color = 'var(--amber)'; }
      else { si.textContent = ed.savedAt ? '已保存 ' + ed.savedAt : '✓ 已同步'; si.style.color = 'var(--muted)'; }
      meta.appendChild(si);
      meta.scrollLeft = 0;
    }

    /* ---- 自动保存 ---- */
    const autoSave = MZ.debounce(function () { if (ed && ed.dirty) save(false); }, 2200);
    function onEdit() {
      if (!ed) return;
      ed.dirty = true;
      paintMeta();
      historyTick();
      autoSave();
    }
    titleInput.addEventListener('input', onEdit);
    textArea.addEventListener('input', onEdit);
    textArea.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '　　'); }
    });

    async function save(manual) {
      /* 返回「这次到底存上了没有」，调用方要拿它决定能不能安全地离开这一章。
         关键一条：PUT 在路上的时候用户还能继续打字。以前回来就无条件 ed.dirty = false，
         那几段新打的字既不会被重发、界面还显示「✓ 已同步」、关编辑器也不拦 —— 直接丢稿。
         所以只认「发出去的那份 == 现在这份」才算干净，否则把自动保存再排一次。 */
      if (!ed || ed.saving) return false;
      ed.saving = true;
      const content = textArea.value;
      const title = titleInput.value;
      paintMeta();
      try {
        const res = await api.put('/api/chapter/' + cid, { content: content, title: title });
        if (!ed) return false;
        ed.data = Object.assign({}, ed.data, { chapter: res.chapter, metrics: res.metrics });
        if (textArea.value === content && titleInput.value === title) ed.dirty = false;
        else autoSave();
        const dd = new Date();
        ed.savedAt = dd.getHours() + ':' + ('0' + dd.getMinutes()).slice(-2);
        if (manual) { toast('已保存', 'ok'); haptic('success'); }
        return true;
      } catch (e) {
        if (manual) toast('保存失败：' + e.message, 'bad');
        else toast('自动保存失败，请手动点「保存」', 'bad');
        return false;
      } finally { if (ed) { ed.saving = false; paintMeta(); } }
    }
    /* ============== 长操作：进度交给全局任务条（服务端 ops，刷新/切页都不丢） ==============
       label 是任务条上先显示的文字；match 是「服务端那条 ops 的标题长什么样」的正则源码。
       两者对不上就会同一条任务显示成两行，所以下面每个按钮都把 match 写清楚。
       没有 match 的操作（改写、一致性检查）服务端不登记 ops，任务条就只显示本地占位。 */
    async function runOp(label, path, opts) {
      opts = opts || {};
      const token = A.pending(label, { match: opts.match });
      try {
        return await api.post(path, opts.body || {}, { timeout: opts.timeout || 900000 });
      } finally {
        A.pendingDone(token);
        A.refreshLive();
      }
    }

    /* ============== 检查：合规 / 钩子 / 读者视角 / 一致性 ============== */
    const CHECK_LABEL = { compliance: '合规预检', hook: '章末钩子体检', reader: '读者视角模拟', consistency: '一致性检查' };
    const CHECK_PATH = { compliance: '/compliance', hook: '/hook', reader: '/reader_sim', consistency: '/consistency_check' };
    const CHECK_RENDER = { compliance: complianceNode, hook: hookNode, reader: readerNode, consistency: consistencyNode };
    /* 一致性检查是本地规则跑的，服务端不登记 ops，所以这里没有 match */
    const CHECK_MATCH = { compliance: '合规预检', hook: '章末钩子体检', reader: '读者视角模拟' };

    async function runCheck(kind) {
      const res = await runOp(CHECK_LABEL[kind], '/api/chapter/' + cid + CHECK_PATH[kind], {
        body: (kind === 'hook' || kind === 'reader') ? { force: true } : {},
        match: CHECK_MATCH[kind],
      });
      ed.check[kind] = res;
      toast(CHECK_LABEL[kind] + ' 完成', 'ok');
      haptic('success');
      refreshInspect();
      if (kind === 'reader' || kind === 'hook' || kind === 'compliance') {
        const r = res && res.result ? res.result : res;
        if (r) ed.check[kind] = r;
      }
      return ed.check[kind];
    }

    /* ============== 三模型评分 + 按建议重写 ============== */
    async function runHit(range) {
      const body = range ? { start: range.start, end: range.end, force: true } : { force: false };
      const res = await runOp(range ? '评分选中段' : '三模型爆款评分',
        '/api/chapter/' + cid + '/hit_review',
        { body: body, timeout: 900000, match: range ? '评分选中段' : '三模型评分' });
      let agg = res;
      if (res && res.review) agg = res.review.result || res.review;
      if (res && res.result) agg = res.result;
      ed.check.hit = agg;
      if (ed) ed.data.hit_review = agg;
      haptic('success');
      toast('评分完成' + (agg && agg.hit_score !== null && agg.hit_score !== undefined ? '：' + agg.hit_score + ' 分' : ''), 'ok');
      refreshInspect();
      return agg;
    }

    /* 一次「重写 + 复评」；返回 {range, after} */
    async function doRewrite(range, instruction) {
      pushHistory();
      const res = await runOp('改写 ' + rangeLabel(range), '/api/chapter/' + cid + '/rewrite', {
        body: { start: range.start, end: range.end, instruction: instruction || '' },
        timeout: 900000,
      });
      if (!ed) return null;
      const out = res.content || (res.result && res.result.content) || '';
      if (!out) { toast('模型没有返回改写结果', 'bad'); return null; }
      textArea.value = out;
      ed.dirty = true;
      paintMeta();
      setTimeout(paintSel, 0);
      await save(false);
      const nr = (res.range_start !== undefined && res.range_start !== null)
        ? { start: res.range_start, end: res.range_end } : range;
      haptic('success');
      return { range: nr, metrics: res.metrics || null };
    }

    async function hitFix(agg, retry) {
      if (!ed) return;
      if (!agg || agg.ok === false) { toast('先跑一次三模型评分', 'warn'); return; }
      let r = null;
      if (agg.scope === 'selection' && agg.range_start !== undefined && agg.range_start !== null) {
        r = { start: agg.range_start, end: agg.range_end };
      } else {
        const n = paraCount(textArea.value);
        r = n ? { start: 0, end: n - 1 } : null;
      }
      if (!r) { toast('这一章还没有正文', 'warn'); return; }
      const before = { hit_score: agg.hit_score, viral_rate: agg.viral_rate };
      const inst = A.hitFixInstruction(agg, !!retry);
      const one = await doRewrite(r, inst);
      if (!one) return;
      toast('已替换 ' + rangeLabel(one.range) + '，正在复评…', 'ok');
      const after = await runHit(one.range);
      const lower = function (a, b) { return a !== null && a !== undefined && b !== null && b !== undefined && a < b - 0.5; };
      if (after && lower(after.hit_score, before.hit_score)) {
        if (!retry) {
          toast('复评 ' + after.hit_score + ' 分，比改前低 '
            + (Math.round((before.hit_score - after.hit_score) * 10) / 10) + ' 分，换更聚焦的指令再改一次…', 'warn');
          await hitFix(after, true);
        } else {
          toast('改完还是 ' + after.hit_score + ' 分（改前 ' + before.hit_score
            + '），可以在「版本」里回滚到改写前', 'bad');
        }
      } else if (after && after.hit_score !== null && after.hit_score !== undefined) {
        toast('复评 ' + after.hit_score + ' 分' + (before.hit_score !== null && before.hit_score !== undefined
          ? '（改前 ' + before.hit_score + '）' : ''), 'ok');
      }
    }

    /* 按读者建议重写那几段，改完自动复跑读者视角 */
    async function readerFix(res, r) {
      if (!ed) return;
      const drops = ((res && res.personas) || []).filter(function (p) { return (parseInt(p.drop_at, 10) || 0) > 0; });
      const who = drops.map(function (p) { return (p.who || '读者') + '（第 ' + p.drop_at + ' 段想划走）'; });
      const inst = [
        '只改这几段：剧情走向、人物关系、时间线都不能变，改完必须和前后文无缝衔接。',
        who.length ? ('三个人设的弃读原因：' + who.join('；') + '。') : '',
        ((res && res.fixes) || []).slice(0, 4).join('；'),
        '硬性：改完字数不得少于原文、段落数不得减少，不要出现「然而/仿佛/不禁/缓缓/微微/瞬间」这类 AI 腔词。',
      ].filter(Boolean).join(' ');
      const one = await doRewrite(r, inst);
      if (!one) return;
      toast('已按读者建议重写，正在复跑读者视角…', 'ok');
      await runCheck('reader');
    }

    function insertHook(t) {
      if (!ed) return;
      pushHistory();
      textArea.value = textArea.value.replace(/\s+$/, '') + '\n\n' + t;
      onEdit();
      haptic('success');
      toast('已插到章末，读一遍再保存', 'ok');
    }

    /* ============== 其他工具 ============== */
    async function copyChapter() {
      const body = (titleInput.value ? titleInput.value + '\n\n' : '') + textArea.value;
      if (!body.trim()) { toast('正文是空的', 'warn'); return; }
      const okCopy = await clipboard(body);
      toast(okCopy ? '整章已复制（含标题）' : '复制失败：长按正文手动全选吧', okCopy ? 'ok' : 'bad');
      haptic(okCopy ? 'success' : 'warn');
    }
    async function copySelection() {
      const r = selRange();
      const t = r ? rangeText(textArea.value, r) : '';
      if (!t) { toast('先在正文里选中几段', 'warn'); return; }
      const okCopy = await clipboard(t);
      toast(okCopy ? '已复制 ' + rangeLabel(r) : '复制失败', okCopy ? 'ok' : 'bad');
    }
    async function copyJson(obj) {
      const okCopy = await clipboard(JSON.stringify(obj, null, 2));
      toast(okCopy ? '结果已复制' : '复制失败', okCopy ? 'ok' : 'bad');
    }

    async function regen() {
      const ok = await confirm(ed.dirty
        ? '重生成整章：会覆盖当前正文，未保存的修改会丢失（原内容会存档，可回滚）。继续？'
        : '重生成整章：会覆盖当前正文（原内容会存档，可回滚）。继续？',
        { okText: '继续', danger: true });
      if (!ok) return;
      pushHistory();
      const res = await runOp('重生成整章', '/api/chapter/' + cid + '/regen', { match: '整章重生成' });
      toast((res && res.msg) || '重生成完成', 'ok');
      haptic('success');
      await load();
    }
    async function deai() {
      const ok = await confirm('去 AI 化：会把「像 AI 写的」段落重写一遍，原内容会存档可回滚。继续？', { okText: '继续' });
      if (!ok) return;
      pushHistory();
      const res = await runOp('去 AI 化', '/api/chapter/' + cid + '/deai', { match: '去\\s*AI\\s*化' });
      toast((res && res.msg) || '去 AI 化完成', 'ok');
      haptic('success');
      await load();
    }
    async function autoTitle() {
      const res = await runOp('AI 起名', '/api/chapter/' + cid + '/title', { match: 'AI\\s*命名本章' });
      const t = (res && (res.title || res.result || res.msg)) || '';
      if (t && String(t).length <= 30) { titleInput.value = String(t); onEdit(); haptic('success'); toast('已起名：' + t, 'ok'); }
      else toast('已生成建议，去检查面板看看', 'ok');
    }

    async function rewriteHint(range) {
      const r = range || selRange();
      if (!r) { toast('先在正文里选中要改的段落，再点这里', 'warn'); return; }
      const before = rangeText(textArea.value, r);
      const v = await modal({
        title: '按我说的改 ' + rangeLabel(r),
        text: '用大白话说想怎么改，比如「这段再爽一点」「换成她的视角」「压到 200 字」。留空就按评分/质检的建议改。',
        input: 'text', placeholder: '（可留空）', okText: '开始改',
      });
      if (v === null) return;
      const inst = String(v || '') || A.hitFixInstruction((ed.data || {}).hit_review || {}, false);
      const one = await doRewrite(r, inst);
      if (!one) return;
      const after = rangeText(textArea.value, one.range);
      sheet({
        title: '改写结果对比',
        build: function (b, close) {
          b.appendChild(h('div.small.muted.mb8', { text: '改前 · ' + rangeLabel(r) }));
          b.appendChild(h('div.card.tight.small', null, paraTextNode(before)));
          b.appendChild(h('div.small.muted.mt12.mb8', { text: '改后 · ' + rangeLabel(one.range) + '（已写入正文并自动保存）' }));
          b.appendChild(h('div.card.tight.small', null, paraTextNode(after)));
          b.appendChild(h('div.btn-row.mt12', null,
            A._btn('复制改后文本', '', function () { clipboard(after); toast('已复制', 'ok'); }),
            A._btn('在版本里回滚', '', function () { close(); openInspect('versions'); })));
        },
      });
    }

    async function restoreVersion(vid) {
      const ok = await confirm('回滚到这一版？当前正文会先存档，可再切回。', { okText: '回滚' });
      if (!ok) return;
      await api.post('/api/version/' + vid + '/restore');
      toast('已回滚', 'ok');
      haptic('success');
      await load();
    }

    function moreActions() {
      actions([
        { label: '用阅读器读这一章', sub: '沉浸阅读，左右翻章', icon: 'book', onPick: function () { guard(goRead()); } },
        { label: '接着写（AI 往下写）', sub: '顺着章末接下去，先给你看再插进去', icon: 'spark', onPick: function () { continueSheet(); } },
        { label: '写下一章（AI 补更）', sub: '这章差不多了，让 AI 接着往下开新章', icon: 'books', onPick: function () { guard(writeNext()); } },
        { label: '切换作品（换一本书写）', sub: '还在写作台里，改的是同一本书的别的章', icon: 'books', onPick: function () { guard(openBookSheet()); } },
        { label: '卡文了？给我三个走向', sub: '不写正文，只给想法', icon: 'target', onPick: function () { guard(runContinue('ideas', 0, '')); } },
        { label: '查找 / 替换', sub: '章内找字、批量替换（Ctrl/Cmd+F）', icon: 'menu', onPick: function () { toggleFind(); } },
        { label: '撤销上一步', sub: '快捷键 Ctrl/Cmd+Z', icon: 'refresh', onPick: function () { undo(); } },
        { label: '重做', sub: 'Ctrl/Cmd+Shift+Z', icon: 'refresh', onPick: function () { redo(); } },
        { label: '沉浸模式', sub: '隐藏所有边栏，只留正文', icon: 'eye', onPick: function () { setImmersive(!wrap.classList.contains('ed-immersive')); } },
        { label: '正文字号与行距', sub: '嫌字小、行挤，在这儿调', icon: 'menu', onPick: function () { fontSheet(); } },
        { label: '导出本章 txt', sub: '存到「文件」或发给自己', icon: 'download', onPick: function () { guard(exportChapter()); } },
        { label: '章节目录 / 跳章', sub: '上一章、下一章也在顶部', icon: 'books', onPick: function () { jumpList(); } },
        { label: '改本章目标字数', sub: '点顶部的「目标」chip 也能改', icon: 'target', onPick: function () { editTarget(); } },
        { label: '复制整章', sub: '含标题，直接粘到番茄后台', icon: 'copy', onPick: function () { copyChapter(); } },
        { label: '按我说的改选中段落', sub: '选中正文里的一段再点', icon: 'edit', onPick: function () { rewriteHint(null); } },
        { label: '合规预检', sub: '本机词表，秒出', icon: 'shield', onPick: function () { openInspect('compliance'); } },
        { label: '一致性检查', sub: '正文对着设定卡查矛盾', icon: 'layers', onPick: function () { openInspect('consistency'); } },
        { label: '章末钩子体检', icon: 'hook', onPick: function () { openInspect('hook'); } },
        { label: '读者视角模拟', icon: 'eye', onPick: function () { openInspect('reader'); } },
        { label: '三模型爆款评分', icon: 'fire', onPick: function () { openInspect('hit'); } },
        { label: '版本历史', icon: 'history', onPick: function () { openInspect('versions'); } },
        { label: '删除本章', danger: true, icon: 'trash', onPick: function () { delChapter(); } },
      ], { title: '第 ' + ((ed.data && ed.data.chapter && ed.data.chapter.idx) || '') + ' 章' });
    }

    /* 从写作台切到阅读器：先把改动存好，再把写作台拆掉，最后让阅读器盖上 */
    async function goRead() {
      if (!ed) return;
      if (ed.dirty) {
        await save(false);
        if (ed && ed.dirty) { toast('这一章还没保存上，先别切到阅读器', 'bad'); return; }
      }
      if (!ed) return;
      const nid2 = ed.nid, cid2 = ed.cid, t2 = titleInput.value;
      const idx2 = (ed.data && ed.data.chapter && ed.data.chapter.idx) || 0;
      teardown();
      if (window.MZReader && MZReader.open) MZReader.open(nid2, cid2, { title: t2, idx: idx2 });
      else toast('阅读器没加载出来，退出重进一次试试', 'bad');
    }

    /* 从写作台直接开下一章：先把手改存好，再走「补更」那套后台流程 */
    async function writeNext() {
      if (!ed) return;
      if (ed.dirty) await save(false);
      const d = await api.get('/api/novel/' + nid);
      if (!d || !d.novel) { toast('拿不到这本书的信息', 'bad'); return; }
      A.askUpdate(d.novel);
    }

    async function delChapter() {
      const ok = await confirm('删除本章？会移到回收站，可在桌面版恢复。', { danger: true, okText: '删除' });
      if (!ok) return;
      await api.del('/api/chapter/' + cid);
      toast('已删除', 'ok');
      closeEditor(true);
    }
    /* ============== 检查抽屉（底部抽屉 + 分段，每段都能「跑一次」） ============== */
    const INSPECT_SEGS = [
      { key: 'quality', label: '质检' },
      { key: 'hit', label: '爆款' },
      { key: 'compliance', label: '合规' },
      { key: 'consistency', label: '一致性' },
      { key: 'hook', label: '钩子' },
      { key: 'reader', label: '读者' },
      { key: 'versions', label: '版本' },
    ];
    const CHECK_NOTE = {
      compliance: '本机雷区词表扫一遍，秒出；不联网、不花额度。',
      consistency: '本地规则：正文 × 设定卡 × 状态卡，查跨章衔接 / 人物 / 时间线 / 伏笔，秒出。',
      hook: '看章末有没有让人想点下一章的东西；没有就给几条候选，点一下直接插到结尾。',
      reader: '三个不同口味的读者各读一遍，指出谁在第几段看不下去；要调模型，约 30~90 秒。',
    };
    function refreshInspect() {
      if (!inspector) return;
      if (!inspector.host || !inspector.host.isConnected) { inspector = null; return; }
      inspector.paint();
    }
    function openInspect(startKey) {
      let tab = startKey || (inspector && inspector.tab) || 'quality';
      const head = h('div.insp-head');
      const pane = h('div.insp-pane.mt12');
      let closeFn = function () { };
      function paint() {
        if (!ed) { if (closeFn) closeFn(); return; }
        if (inspector) inspector.tab = tab;
        clear(head);
        head.appendChild(seg(INSPECT_SEGS, tab, function (k) { tab = k; haptic('light'); paint(); }));
        clear(pane);
        paintPane(tab, pane, closeFn);
      }
      inspector = { tab: tab, paint: paint, host: head };
      sheet({
        title: '本章检查 · 第 ' + ((ed.data && ed.data.chapter && ed.data.chapter.idx) || '') + ' 章',
        height: '82vh',
        build: function (b, close) {
          closeFn = close;
          b.appendChild(head); b.appendChild(pane);
          paint();
        },
      });
    }

    function runCheckBtn(kind) {
      return A._btn('跑一次' + CHECK_LABEL[kind], 'primary', function () { guard(runCheck(kind)); });
    }

    function paintPane(tab, pane, close) {
      const d = ed.data || {};

      if (tab === 'quality') {
        pane.appendChild(h('div.btn-row', { style: { marginTop: '0' } },
          A._btn('用当前正文重新质检', 'primary', function () {
            guard((async function () {
              await save(false);
              const r = await runOp('重新质检本章', '/api/chapter/' + cid + '/analyze', { match: '重新质检' });
              if (ed) { ed.data.metrics = r.metrics; paintMeta(); }
              toast('已重新质检', 'ok');
              refreshInspect();
            })());
          }),
          A._btn('复制整章', '', function () { guard(copyChapter()); })));
        pane.appendChild(card('质检指标', null, [MZUI.metricsPanel(d.metrics, d.target_words || 2500)]));
        pane.appendChild(h('div.section-title', { text: '发现的问题' }));
        pane.appendChild(MZUI.issueList(d.issues));
        const weak = d.weak || [];
        if (weak.length) {
          pane.appendChild(h('div.section-title', { text: '最像 AI 灌水的段落' }));
          const l = h('div.list');
          weak.forEach(function (w) {
            l.appendChild(li({
              ico: 'bolt',
              title: '第 ' + (w.para + 1) + ' 段',
              sub: (w.hits || []).join('、') + (w.text ? ' · ' + w.text.slice(0, 60) : ''),
              right: chip('可疑 ' + w.score, 'warn'),
            }));
          });
          pane.appendChild(l);
        }
        return;
      }

      if (tab === 'hit') {
        const agg = d.hit_review || ed.check.hit || null;
        const actions = h('div.btn-row', { style: { marginTop: '0' } });
        actions.appendChild(A._btn('评分本章', 'primary', function () { guard(runHit(null)); }));
        actions.appendChild(A._btn('评分选中段', '', function () {
          const r = selRange();
          if (!r) { toast('先在正文里选中几段', 'warn'); return; }
          guard(runHit(r));
        }));
        if (agg && agg.ok !== false && agg.top_fix) {
          actions.appendChild(A._btn('按建议重写', 'blue', function () { close(); guard(hitFix(agg, false)); }));
        }
        pane.appendChild(MZUI.hitPanel(agg, { actions: actions }));
        pane.appendChild(noteNode('「按建议重写」会把三模型给出的首要修改 + 拖后腿的维度 + 各模型的看法，合成一条改写指令，'
          + '只动这一段（或整章），改完自动复评一次；分数反而更低就换更聚焦的指令再改一次。'));
        return;
      }

      if (tab === 'versions') {
        pane.appendChild(loadingBox('读取版本…'));
        api.get('/api/chapter/' + cid + '/versions').then(function (r) {
          clear(pane);
          const vs = r.versions || [];
          if (!vs.length) { pane.appendChild(emptyBox('history', '还没有历史版本', '编辑或重生成后会自动存档')); return; }
          const l = h('div.list');
          vs.forEach(function (v) {
            l.appendChild(li({
              ico: 'history',
              title: v.title || ('版本 #' + v.id),
              sub: [v.created_at ? fmtDate(v.created_at) : '', v.chars ? fmtNum(v.chars) + ' 字' : '', v.source || v.reason || ''].filter(Boolean).join(' · '),
              right: chip('回滚', '', 'history'),
              onTap: function () { guard(restoreVersion(v.id)); },
            }));
          });
          pane.appendChild(l);
          pane.appendChild(noteNode('回滚前当前正文会先存档，随时能再切回来。'));
        }).catch(function (e) { clear(pane); pane.appendChild(errBox(e)); });
        return;
      }

      /* 合规 / 一致性 / 钩子 / 读者 */
      const res = ed.check[tab];
      pane.appendChild(h('div.btn-row', { style: { marginTop: '0' } },
        runCheckBtn(tab),
        res ? A._btn('复制结果', '', function () { guard(copyJson(res)); }) : null));
      if (CHECK_NOTE[tab]) pane.appendChild(noteNode(CHECK_NOTE[tab]));
      pane.appendChild((CHECK_RENDER[tab] || function () { return h('div'); })(res));
    }

    /* ============== 关闭 ============== */
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
    /* 把写作台从页面上拆下来（不重绘底下的页面）。
       切章、关闭都走它，不会因为拆得不干净而漏事件监听。 */
    function teardown() {
      if (!ed) return null;
      const w = ed.wrap;
      (ed.timers || []).forEach(function (t) { clearInterval(t); });
      window.removeEventListener('keydown', onKey);
      inspector = null;
      ed = null;
      document.body.style.overflow = '';
      document.documentElement.style.removeProperty('--dock-bottom');
      /* 沉浸模式的 body 类不清掉的话，退出写作台后顶栏和底部标签栏会一直藏着 */
      document.body.classList.remove('ed-immersive');
      if (w && w.parentNode) w.parentNode.removeChild(w);
      return w;
    }
    async function closeEditor(force) {
      if (!force && ed && ed.dirty) {
        const pick = await pickCloseAction();
        if (pick === 'cancel') return;
        if (pick === 'save') {
          await save(false);
          /* 没存上就留在编辑器里：以前不看结果直接 teardown，那一章就白写了 */
          if (ed && ed.dirty) { toast('还没保存上，先别退出', 'bad'); return; }
        }
      } else if (!force && ed) {
        await save(false);
      }
      if (!ed) return;
      teardown();
      A.render();
    }

    back.addEventListener('click', function () { haptic('light'); guard(closeEditor(false)); });
    navAct.addEventListener('click', function () { haptic('light'); openInspect(); });
    window.addEventListener('beforeunload', function (e) {
      if (ed && ed.dirty) { e.preventDefault(); e.returnValue = ''; }
    });

    await load();
    /* 注意顺序：必须等正文装进去了再 focus。
       先 focus 再 load 的话，输入框被填上内容后光标会落到末尾，
       浏览器就会把整个页面/输入框滚到最下面 —— 看着就像「点开章节卡在下面」。
       现在：先装正文，再把光标放开头、正文滚到最上。 */
    if (!ed) return;
    try {
      textArea.focus();
      textArea.setSelectionRange(0, 0);
      textArea.scrollTop = 0;
    } catch (e) { /* 忽略 */ }
  }

  return { openChapter: openChapter };
})();
