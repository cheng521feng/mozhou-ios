/* ==========================================================================
   墨舟移动端 · 应用核心  app.js  v5
   --------------------------------------------------------------------------
   导航模型：5 个标签页 + 推入式页面栈（左侧边缘右滑返回）
   三件本版重点做的事：
   1) 「正在跑什么」变成界面的一部分 —— 灵动岛停靠条 + 实时进度卡 + 阶段步骤条
      + 模型队列 + 事件流，数据全部来自 /api/live（ops / queue / events / books）。
   2) 登录并入主界面：没会话就整屏显示登录卡，不再跳到乱码的独立登录页。
   3) 渲染永远有兜底：加载失败也要画出错误态和重试，绝不白屏。
   ========================================================================== */
'use strict';

window.MZApp = (function () {
  const { h, frag, add, clear, $, $$, api, toast, sheet, actions, modal, confirm, haptic,
          fmtNum, fmtWords, fmtDur, fmtDate, timeAgo, debounce, sleep, emptyBox, loadingBox, errBox,
          attachPull, icon, brand, ring, bar, chip, countNode, countUp, skeleton, reduceMotion } = MZ;

  const TABS = ['overview', 'books', 'write', 'jobs', 'me'];
  const TAB_LABEL = { overview: '总览', books: '书架', write: '写作', jobs: '任务', me: '我的' };
  const state = {
    tab: 'overview',
    liveJobs: [],
    stack: [],
    hero: null,
    novels: [],
    live: null,
    version: '',
    hydrated: false,
    authed: false,
  };
  const screens = {};

  /* ============================== 小工具 ============================== */
  function pick(o, keys) {
    o = o || {};
    for (let i = 0; i < keys.length; i++) {
      const v = o[keys[i]];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return '';
  }
  function span(text, cls) { return h('span' + (cls ? '.' + cls : ''), { text: text }); }
  function txt(v, dft) { return (v === null || v === undefined || v === '') ? (dft === undefined ? '—' : dft) : String(v); }

  function li(opt) {
    const row = h('div.li' + (opt.onTap ? '.tap' : ''), null,
      opt.ico ? h('div.li-ico', null, typeof opt.ico === 'string' && MZ.ICONS[opt.ico] ? icon(opt.ico, { size: 20 }) : h('span', { text: opt.ico })) : null,
      h('div.li-main', null,
        h('div.li-title', { text: opt.title }),
        opt.sub ? h('div.li-sub', { text: opt.sub }) : null),
      opt.right ? h('div.li-right', null, opt.right) : null,
      opt.arrow ? h('span.li-arrow', null, icon('fwd', { size: 16 })) : null);
    if (opt.onTap) row.addEventListener('click', function () { haptic('light'); opt.onTap(); });
    return row;
  }
  function card(title, extra, children) {
    const box = h('div.card');
    if (title) box.appendChild(h('div.card-head', null, h('h3', { text: title }), extra ? h('span.sp', null, extra) : null));
    [].concat(children || []).forEach(function (c) { if (c) add(box, c); });
    return box;
  }
  function kpi(list) {
    const g = h('div.kpi-grid' + (list.length >= 4 ? '.k4' : ''));
    list.forEach(function (k) {
      g.appendChild(h('div.kpi' + (k.tone ? '.' + k.tone : ''), null,
        h('div.k-label', { text: k.label }),
        h('div.k-value', null, countNode(k.value), k.unit ? h('small', { text: k.unit }) : null)));
    });
    return g;
  }
  function buttons(items) {
    const row = h('div.btn-row');
    items.forEach(function (it) {
      const b = h('button.btn' + (it.tone ? '.' + it.tone : '') + (it.size === 'sm' ? '.sm' : ''), { type: 'button', text: it.label });
      if (it.onTap) b.addEventListener('click', function () { haptic('light'); it.onTap(); });
      row.appendChild(b);
    });
    return row;
  }
  function seg(items, cur, onPick) {
    const s = h('div.seg');
    items.forEach(function (it) {
      const b = h('button' + (it.key === cur ? '.on' : ''), { type: 'button', text: it.label });
      b.addEventListener('click', function () { if (it.key !== cur) { haptic('light'); onPick(it.key); } });
      s.appendChild(b);
    });
    return s;
  }
  function barOf(pct, tone) {
    const v = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    return h('div.bar', null, h('div.bar-fill' + (tone ? '.' + tone : ''), { style: { width: v + '%' } }));
  }
  function busySheet(title) {
    return sheet({ title: '', height: 'auto', node: h('div.center', { style: { padding: '26px 0' } },
      h('div', null, h('span.spinner.lg')),
      h('div.mt12', { text: title || '处理中…' }),
      h('div.small.dim.mt8', { text: '这一步可能要几十秒，别退出' })) });
  }
  function topline(on) {
    const el = $('#topline');
    if (!el) return;
    el.classList.toggle('on', !!on);
    el.style.transform = on ? 'scaleX(.86)' : 'scaleX(1)';
    if (!on) setTimeout(function () { el.style.transform = ''; }, 320);
  }
  function stagger(root) {
    if (!root || !root.children || reduceMotion()) return;
    const kids = Array.prototype.slice.call(root.children).slice(0, 9);
    kids.forEach(function (k, i) {
      if (!k.style || !k.classList) return;
      k.style.setProperty('--i', String(i));
      k.classList.add('rise');
    });
  }

  /* ============================== 评分 / 面板 ============================== */
  const MZUI = {
    /* toneVar 传了就用它（进度环用 var(--accent)），不传就按分数自动上色（质检/爆款环） */
    ring(score, label, size, toneVar) {
      const n = Number(score);
      const v = score === null || score === undefined || isNaN(n) ? null : Math.max(0, Math.min(100, n));
      const tone = toneVar ? '' : (v === null ? '' : (v >= 75 ? 'ok' : (v >= 55 ? '' : 'bad')));
      const el = h('div.ring' + (tone ? '.' + tone : ''), { style: { width: (size || 76) + 'px', height: (size || 76) + 'px', '--p': 0 } },
        h('div.ring-in', null, h('b', { text: v === null ? '—' : String(Math.round(v)) }), h('small', { text: label || '分' })));
      if (toneVar) el.style.setProperty('--ring-tone', toneVar);
      if (v !== null) {
        if (reduceMotion()) el.style.setProperty('--p', String(v));
        else requestAnimationFrame(function () { requestAnimationFrame(function () { el.style.setProperty('--p', String(v)); }); });
      }
      return el;
    },
    metricsPanel(m, target) {
      m = m || {};
      const items = [
        ['字数', m.chars, target ? '目标 ' + target : ''],
        ['AI 腔词', m.ai_hits, '越少越好'],
        ['重复段落', m.dup_ratio === undefined ? '—' : Math.round((m.dup_ratio || 0) * 100) + '%', '越低越好'],
        ['对话占比', m.dialogue_ratio === undefined ? '—' : Math.round((m.dialogue_ratio || 0) * 100) + '%', '15%~65% 佳'],
        ['平均句长', m.avg_sentence, '42 字内佳'],
        ['超长句', m.long_ratio === undefined ? '—' : Math.round((m.long_ratio || 0) * 100) + '%', '越低越好'],
      ];
      const box = h('div');
      box.appendChild(h('div.row', { style: { gap: '14px', alignItems: 'center' } },
        MZUI.ring(m.score, '质检分'),
        h('div.flex1', null, h('div.small.muted', { text: '综合评分＝字数达标度 × AI 味 × 重复率 × 对话比 × 句长，加权得出。' }))));
      const l = h('div.list.mt12');
      items.forEach(function (it) {
        l.appendChild(li({ title: it[0], sub: it[2], right: h('span.num', { text: txt(it[1]) }) }));
      });
      box.appendChild(l);
      return box;
    },
    issueList(issues) {
      const l = h('div.list');
      (issues || []).forEach(function (it) {
        const tone = it.level === 'warn' ? 'warn' : (it.level === 'ok' ? 'ok' : '');
        l.appendChild(li({
          ico: it.level === 'warn' ? 'bolt' : (it.level === 'ok' ? 'check' : 'dot'),
          title: it.msg || String(it),
          right: tone ? chip(it.level === 'warn' ? '建议改' : (it.level === 'ok' ? '正常' : '参考'), tone) : null,
        }));
      });
      if (!(issues || []).length) l.appendChild(li({ title: '没有发现问题', sub: '可以先跑一次质检' }));
      return l;
    },
    hitPanel(agg, opts) {
      const box = h('div');
      if (!agg) {
        box.appendChild(emptyBox('target', '还没有爆款评分', '点「评分本章」让三个模型打分（约 10~40 秒）'));
        if (opts && opts.actions) box.appendChild(h('div.mt12', null, opts.actions));
        return box;
      }
      if (agg.ok === false) {
        box.appendChild(emptyBox('bolt', '评分失败', agg.msg || '模型没有返回可用结果'));
        if (opts && opts.actions) box.appendChild(h('div.mt12', null, opts.actions));
        return box;
      }
      box.appendChild(h('div.row', { style: { gap: '14px', alignItems: 'center' } },
        MZUI.ring(agg.hit_score, '爆款分'),
        h('div.flex1', null,
          h('div.row.wrap', { style: { gap: '6px' } },
            chip('爆款率 ' + (agg.viral_rate === null || agg.viral_rate === undefined ? '—' : Math.round(agg.viral_rate) + '%'), 'blue', 'fire'),
            chip('一致性 ' + (agg.agreement || 0) + '%', (agg.agreement >= 70 ? 'ok' : 'warn'), 'layers'),
            chip((agg.labels ? Object.keys(agg.labels).length : agg.count || 0) + ' 个模型', '', 'spark')),
          agg.verdict ? h('div.small.muted.mt8', { text: agg.verdict }) : null)));
      if (opts && opts.actions) box.appendChild(h('div.mt12', null, opts.actions));
      if (agg.top_fix) {
        box.appendChild(h('div.card.tight.mt12', null,
          h('div.small', { style: { color: 'var(--accent)', fontWeight: '600' } }, '只改一处 → 最该改这里'),
          h('div.mt8.pre-wrap', { text: agg.top_fix })));
      }
      if (agg.dims && agg.dims.length) {
        const dl = h('div.mt12');
        dl.appendChild(h('div.small.muted.mb8', { text: '十个维度（三模型取中位）' }));
        agg.dims.forEach(function (d) {
          const v = d.score;
          dl.appendChild(h('div.dim-row', null,
            h('span.dn', { text: d.name || d.key }),
            barOf(v === null || v === undefined ? 0 : v),
            h('span.dv.num', { text: v === null || v === undefined ? '—' : String(Math.round(v)) })));
        });
        box.appendChild(dl);
      }
      const issues = agg.issues || [];
      if (issues.length) {
        box.appendChild(h('div.small.muted.mt16.mb8', { text: '问题清单（带「共识」＝三个模型都提到）' }));
        const l = h('div.list');
        issues.forEach(function (it) {
          l.appendChild(li({
            ico: 'bolt',
            title: (it.dim_name ? '【' + it.dim_name + '】' : '') + (it.problem || it.advice || ''),
            sub: it.advice && it.advice !== it.problem ? '改法：' + it.advice : '',
            right: it.consensus ? chip('共识', 'bad', 'fire') : null,
          }));
        });
        box.appendChild(l);
      }
      if (agg.strengths && agg.strengths.length) {
        box.appendChild(h('div.small.muted.mt16.mb8', { text: '值得保留的优点' }));
        const l = h('div.list');
        agg.strengths.forEach(function (s) { l.appendChild(li({ ico: 'check', title: s.text || '', right: s.consensus ? chip('共识', 'ok') : null })); });
        box.appendChild(l);
      }
      if (agg.per_model) {
        box.appendChild(h('div.small.muted.mt16.mb8', { text: '各模型自己的分' }));
        const l = h('div.list');
        Object.keys(agg.per_model).forEach(function (p) {
          const pm = agg.per_model[p] || {};
          l.appendChild(li({ title: (agg.labels && agg.labels[p]) || p, right: h('span.num', { text: txt(pm.hit_score) }) }));
        });
        box.appendChild(l);
      }
      if (agg.failed && Object.keys(agg.failed).length) box.appendChild(h('div.footnote', { text: '失败模型：' + Object.keys(agg.failed).join('、') }));
      return box;
    },
  };

  /* 把「三模型诊断」翻成一条能直接执行的改写指令。
     只说 top_fix 太笼统，模型容易越改越平；这里把首要修改、拖后腿的维度、
     各模型的看法和具体改法一起说清楚，并锁死「不许改剧情、不许变短」。 */
  function hitFixInstruction(agg, retry) {
    agg = agg || {};
    const advs = (agg.issues || []).map(function (i) { return i.advice; }).filter(Boolean).slice(0, 4);
    const weak = (agg.dims || []).filter(function (d) { return d.score !== null && d.score !== undefined && d.score < 62; })
      .sort(function (a, b) { return (a.score - b.score) || ((b.weight || 0) - (a.weight || 0)); }).slice(0, 4)
      .map(function (d) { return (d.name || d.key) + ' ' + d.score + ' 分'; });
    const pm = Object.keys(agg.per_model || {}).map(function (k) {
      const v = agg.per_model[k] || {};
      const one = (v.issues || [])[0];
      const t = (one && (one.problem || one.advice)) || v.top_fix || '';
      return t ? (((agg.labels || {})[k] || k) + '：' + t) : '';
    }).filter(Boolean).slice(0, 3);
    return [
      '只改这一段：剧情走向、人物关系、时间线都不能变，改完必须和前后文无缝衔接。',
      agg.top_fix ? ('首要修改：' + agg.top_fix) : '',
      weak.length ? ('这次评分里最拖后腿的是：' + weak.join('；') + '。请针对这几项把细节写实、把张力写出来，不要靠压字数省事。') : '',
      pm.length ? ('各模型的看法：' + pm.join('；')) : '',
      advs.length ? ('其他建议：' + advs.join('；')) : '',
      retry ? '上一轮改完复评反而更低：这次把上面的建议逐条落到具体动作、对话和细节上，不要动剧情，也不要比原文短。' : '',
      '硬性：改完字数不得少于原文、段落数不得减少，不要出现「然而/仿佛/不禁/缓缓/微微/瞬间」这类 AI 腔词。',
    ].filter(Boolean).join(' ');
  }

  /* ============================== 实时进度组件 ==============================
     数据来自 /api/live：
       live.running / job_title / pct / done / total / elapsed
       live.books[] = {title, need, done, phase, current_idx, pct, last_title, last_words, failed, error}
       live.ops{}   = {title, steps[], step, phase, pct, finished, ok, error, note, elapsed}
       live.queue   = {active, cap, running[{label,elapsed}], waiting[{label,waited}], queued, total, done, current}
       live.events[]= {at, msg}
     ============================================================ */
  function qLabel(x) {
    if (!x) return '';
    if (typeof x === 'string') return x;
    return x.label || x.name || x.model || x.title || String(x);
  }
  function hhmmss(at) {
    if (!at) return '';
    const s = String(at);
    const m = /(\d{2}:\d{2}:\d{2})/.exec(s);
    return m ? m[1] : s.slice(-8);
  }
  function phaseLine(live) {
    const bits = [];
    const cur = qLabel(live.queue && live.queue.current);
    (live.books || []).forEach(function (b) {
      const who = b.title ? '《' + b.title + '》' : '';
      const what = b.phase || (b.last_title ? '正在写' : '准备中');
      const dup = b.current_idx && String(what).indexOf(String(b.current_idx)) >= 0;
      const where = (b.current_idx && !dup) ? '第 ' + b.current_idx + ' 章' : '';
      bits.push([who, where, what].filter(Boolean).join(' '));
    });
    if (!bits.length && live.job_title) bits.push(live.job_title);
    if (!bits.length) bits.push('正在准备…');
    return bits.join('　·　');
  }
  function stepsNode(steps, cur, phase) {
    const box = h('div.steps');
    (steps || []).forEach(function (s, i) {
      const label = typeof s === 'string' ? s : (s.label || s.title || s.name || ('第 ' + (i + 1) + ' 步'));
      const done = cur !== undefined && cur !== null && i < cur;
      const on = cur !== undefined && cur !== null && i === cur;
      box.appendChild(h('div.step' + (on ? '.on' : (done ? '.done' : '')), null,
        h('span.st-dot', null, done ? icon('check', { size: 12, w: 2.6 }) : String(i + 1)),
        h('span.st-line', { text: label })));
    });
    if (phase) box.appendChild(h('div.step' + (cur === undefined ? '.on' : ''), null, h('span.st-dot', null, icon('spark', { size: 12 })), h('span.st-line', { text: phase })));
    return box;
  }
  function queueNode(live) {
    const q = live.queue || {};
    const running = q.running || [];
    const waiting = q.waiting || [];
    if (!q.active && !running.length && !waiting.length && !q.queued) return null;
    const box = h('div.queue-box.mt12');
    box.appendChild(h('div.queue-head', null,
      h('span.live-dot'),
      h('span', { text: '模型队列' }),
      h('span.qh-n', { text: (q.active || running.length || 0) + ' 路在跑' }),
      q.cap ? h('span', { text: '· 上限 ' + q.cap }) : null,
      (q.queued || waiting.length) ? h('span', { text: '· 排队 ' + (q.queued || waiting.length) }) : null,
      q.cool ? h('span', { text: '· 冷切 ' + q.cool }) : null));
    const bar = h('div.qbar');
    if (!running.length && q.current) bar.appendChild(h('div.qslot.hot', null, h('span.spinner.sm'), h('span', { text: qLabel(q.current) })));
    running.forEach(function (r) {
      bar.appendChild(h('div.qslot.hot', null, h('span.spinner.sm'), h('span', { text: qLabel(r) }),
        (r && r.elapsed) ? h('span.dim', { text: fmtDur(r.elapsed) }) : null));
    });
    waiting.forEach(function (w) {
      bar.appendChild(h('div.qslot', null, h('span', { text: qLabel(w) }),
        (w && w.waited) ? h('span.dim', { text: '等 ' + fmtDur(w.waited) }) : null));
    });
    if (bar.children.length) box.appendChild(bar);
    return box;
  }
  function eventsNode(live, max) {
    const evs = (live.events || []).slice(-(max || 8)).reverse();
    if (!evs.length) return null;
    const box = h('div.ev-list.ev-list');
    evs.forEach(function (e, i) {
      const msg = (e && (e.msg || e.message)) || String(e || '');
      box.appendChild(h('div.ev' + (i === 0 ? '.hot' : ''), null,
        h('span.ev-t', { text: hhmmss(e && e.at) }),
        h('span.ev-m', { text: msg })));
    });
    return box;
  }
  function opsNode(live) {
    const ops = live.ops || {};
    const keys = Object.keys(ops);
    if (!keys.length) return null;
    const box = h('div.ops-grid');
    keys.forEach(function (k) {
      const o = ops[k] || {};
      const cardEl = h('div.op-card', null,
        h('div.op-top', null,
          h('span.live-dot'),
          h('span.op-t', { text: o.title || o.key || k }),
          h('span.sp', null, o.ok === false ? chip('失败', 'bad')
            : (o.finished ? chip('完成', 'ok') : chip((o.pct === undefined || o.pct === null ? '' : Math.round(o.pct) + '%'), 'warn')))),
        o.note ? h('div.op-note', { text: o.note }) : null,
        stepsNode(o.steps, (o.step === undefined || o.step === null) ? undefined : o.step, o.phase));
      box.appendChild(cardEl);
    });
    return box;
  }
  /* 总进度卡：总览页和任务页都用它 */
  function liveHero(live, opt) {
    opt = opt || {};
    live = live || {};
    const pct = Math.max(0, Math.min(100, Number(live.pct) || 0));
    const box = h('div.live-hero.running-card');
    box.appendChild(h('div.lh-top', null,
      h('span.live-dot'),
      h('span.lh-title', { text: live.job_title || (live.running ? '正在写作' : '待命中') }),
      h('span.sp', null, chip(Math.round(pct) + '%', live.running ? 'ok' : ''))));
    box.appendChild(h('div.lh-body', null,
      MZUI.ring(pct, '总进度', 76, 'var(--accent)'),
      h('div.lh-main', null,
        h('div.live-phase', { text: phaseLine(live) }),
        h('div', null, barOf(pct, live.running ? '' : 'ok')),
        h('div.live-nums.mt8', null,
          h('span', { text: (live.done || 0) + ' / ' + (live.total || 0) + ' 章' }),
          live.elapsed ? h('span', { text: '已用时 ' + fmtDur(live.elapsed) }) : null,
          live.chars ? h('span', { text: fmtWords(live.chars) }) : null))));
    const q = queueNode(live);
    if (q) box.appendChild(q);
    const books = live.books || [];
    if (books.length) {
      const bl = h('div.live-books');
      books.forEach(function (b) {
        const bp = b.pct === undefined || b.pct === null ? (b.need ? ((b.done || 0) / b.need) * 100 : 0) : b.pct;
        bl.appendChild(h('div', null,
          h('div.live-book', null,
            h('span.lb-t', { text: '《' + (b.title || '未命名') + '》' + (b.phase ? ' · ' + b.phase : '') }),
            h('span.lb-s', { text: (b.done || 0) + '/' + (b.need || 0) })),
          h('div.live-book', null,
            h('div.lb-bar', null, barOf(bp, b.failed ? 'bad' : '')),
            h('span.lb-s', { text: b.last_idx ? '第 ' + b.last_idx + ' 章' + (b.last_words ? ' · ' + fmtNum(b.last_words) + ' 字' : '') : '' })),
          b.error ? h('div.op-note', { text: b.error }) : null));
      });
      box.appendChild(bl);
    }
    if (opt.events !== false) {
      const ev = eventsNode(live, opt.maxEvents || 5);
      if (ev) box.appendChild(h('div.mt12', null, h('div.small.muted.mb8', { text: '运行日志' }), ev));
    }
    return box;
  }
  MZUI.liveHero = liveHero;
  MZUI.opsNode = opsNode;
  MZUI.queueNode = queueNode;
  MZUI.eventsNode = eventsNode;
  MZUI.stepsNode = stepsNode;

  /* 实时数据是否「有东西可看」 */
  function liveBusy(live) {
    if (!live) return false;
    const q = live.queue || {};
    return !!(live.running || (q.active || 0) > 0 || (q.queued || 0) > 0 ||
      Object.keys(live.ops || {}).length || (live.books || []).length);
  }

  /* ============================== 导航 ============================== */
  const navbar = function () { return $('#navbar'); };
  function applyNav(s) {
    const main = $('#main');
    const nb = navbar();
    if (!nb) return;
    $('#navLarge').textContent = s.title || '';
    $('#navInline').textContent = s.title || '';
    nb.classList.remove('no-large');
    if (s.noLarge) nb.classList.add('no-large');
    const back = $('#navBack');
    if (back) back.hidden = !state.stack.length;
    const act = $('#navAction');
    if (act) {
      if (s.action) {
        act.hidden = false;
        act.textContent = s.action.label;
        act.onclick = function () { haptic('light'); s.action.onTap(); };
      } else { act.hidden = true; act.onclick = null; }
    }
    nb.classList.toggle('scrolled', !s.noLarge && main.scrollTop > 10);
  }
  function clearMain() {
    const main = $('#main');
    Array.prototype.slice.call(main.children).forEach(function (c) {
      if (!c.classList || !c.classList.contains('pull')) main.removeChild(c);
    });
  }
  async function render() {
    const main = $('#main');
    if (!main) return;
    const s = state.stack.length ? state.stack[state.stack.length - 1] : (screens[state.tab] && screens[state.tab]());
    if (!s) return;
    applyNav(s);
    const anim = state.anim || '';
    state.anim = '';
    clearMain();
    const body = h('div');
    if (anim) body.classList.add('screen-' + anim);
    main.appendChild(body);
    body.appendChild(skeleton(3));
    main.scrollTop = 0;
    topline(true);
    try {
      const node = await s.mount(body);
      clear(body);
      if (node) {
        body.appendChild(node);
        if (anim) stagger(node);
      }
    } catch (e) {
      clear(body);
      body.appendChild(errBox(e, function () { render(); }));
      if (e && e.code === 401) showLogin(e);
    }
    topline(false);
    if (s.after) s.after(body);
  }
  function go(tab) {
    if (TABS.indexOf(tab) < 0) return;
    state.tab = tab;
    state.stack = [];
    $$('.tab').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === tab); });
    const tb = $('#tabbar');
    if (tb) tb.style.setProperty('--tab-i', String(TABS.indexOf(tab)));
  }
  function switchTab(tab) { go(tab); state.anim = 'fade'; haptic('light'); render(); }
  function push(s) { state.stack.push(s); state.anim = 'push'; haptic('light'); render(); }
  function pop() { if (!state.stack.length) return; state.stack.pop(); state.anim = 'back'; render(); }
  function doneMsg(res, okMsg) { toast((res && res.msg) || okMsg || '完成', 'ok'); return res; }
  /* ============================== 数据 ============================== */
  async function loadHero() {
    state.hero = await api.get('/api/overview');
    state.novels = state.hero.novels || [];
    state.version = state.hero.version || '';
    if (state.hero.live) state.live = state.hero.live;
    state.hydrated = true;
    return state.hero;
  }
  async function ensureHero() { if (!state.hydrated) await loadHero(); return state.hero; }
  function findNovel(nid) { return state.novels.filter(function (n) { return n.id === nid; })[0] || null; }
  function planNeed(n) {
    const p = n.plan || {};
    if (p.need !== undefined && p.need !== null) return Math.max(0, Number(p.need) || 0);
    const daily = p.daily || n.daily_count || 0;
    return Math.max(0, daily - planMade(n));
  }
  function planMade(n) {
    const p = n.plan || {};
    return p.today_made === undefined ? (n.today_made || 0) : p.today_made;
  }

  /* ============================== 总览 ============================== */
  function planCard(todos) {
    if (!todos.length) {
      return h('div.done-card', null,
        h('div.em-ico', null, icon('check', { size: 22, w: 2.4 })),
        h('div', null,
          h('div.dc-t', { text: '今日全部达标' }),
          h('div.dc-s', { text: state.novels.length
            ? '共 ' + state.novels.length + ' 本作品，今天的更新量都写完了'
            : '还没有作品，去「书架」建一本' })));
    }
    const totalNeed = todos.reduce(function (s, n) { return s + planNeed(n); }, 0);
    const box = h('div.card');
    box.appendChild(h('div.card-head', null, h('h3', { text: '今日待补' }), h('span.sp', { text: '还差 ' + totalNeed + ' 章' })));
    todos.forEach(function (n) {
      const need = planNeed(n), made = planMade(n);
      const daily = (n.plan && n.plan.daily) || n.daily_count || 0;
      const row = h('div.plan-row');
      row.appendChild(h('div.plan-main', null,
        h('div.plan-title', { text: '《' + (n.title || '未命名') + '》' }),
        h('div.plan-sub', { text: '今日 ' + made + '/' + daily + ' 章 · 全书 ' + (n.chapter_count || 0) + ' 章' }),
        h('div.plan-bar', null, barOf(daily ? (made / daily) * 100 : 0))));
      row.appendChild(h('span.plan-need', { text: '还差 ' + need + ' 章' }));
      row.addEventListener('click', function () { haptic('light'); askUpdate(n); });
      box.appendChild(row);
    });
    box.appendChild(h('div.card-foot', { text: '点一本书直接补更（续写）；这里只显示今天还没达标的作品。' }));
    return box;
  }
  function usageCard() {
    const u = (state.hero && state.hero.usage) || {};
    const days = (u.by_day || []).slice(-14);
    if (!days.length) return null;
    const max = days.reduce(function (m, d) { return Math.max(m, d.chars || 0); }, 0) || 1;
    const box = h('div.card');
    box.appendChild(h('div.card-head', null,
      h('h3', { text: '近两周产出' }),
      h('span.sp', { text: '今天 ' + fmtNum(u.today_chars || 0) + ' 字' })));
    const bars = h('div.spark-bars');
    days.forEach(function (d, i) {
      const b = h('div.sb' + (i === days.length - 1 ? '.on' : ''), { style: { height: Math.max(4, ((d.chars || 0) / max) * 100) + '%' } });
      b.title = (d.day || '') + ' · ' + fmtNum(d.chars || 0) + ' 字';
      bars.appendChild(b);
    });
    box.appendChild(bars);
    box.appendChild(h('div.live-nums.mt12', null,
      h('span', { text: '累计调用 ' + fmtNum(u.total_calls || 0) + ' 次' }),
      h('span', { text: '生成 ' + fmtNum(u.completion_chars || 0) + ' 字' }),
      h('span', { text: '今天 ' + fmtNum(u.today_calls || 0) + ' 次' })));
    return box;
  }
  screens.overview = function () {
    return {
      title: '总览',
      action: { label: '刷新', onTap: function () { refreshAll(true); } },
      async mount(body) {
        const d = await ensureHero();
        const st = d.stats || {};
        const live = state.live || d.live || {};
        const out = h('div.pad');
        out.appendChild(kpi([
          { label: '今日更新', value: st.today_chapters || 0, unit: '/ ' + (st.today_target || 0) + ' 章',
            tone: (st.today_target && st.today_chapters >= st.today_target) ? 'accent' : '' },
          { label: '累计字数', value: Number(st.chars) || 0, unit: '' },
          { label: '作品', value: st.novels || 0, unit: '本' },
          { label: '待改弱章', value: st.weak_count || 0, unit: '章', tone: st.weak_count ? 'amber' : '' },
        ]));
        if (liveBusy(live)) {
          const c = liveHero(live, { maxEvents: 4 });
          c.classList.add('mt12');
          out.appendChild(c);
        }
        const todos = state.novels.filter(function (n) { return n.enabled !== false && planNeed(n) > 0; })
          .sort(function (a, b) { return planNeed(b) - planNeed(a); });
        out.appendChild(h('div.mt12', null, planCard(todos)));
        const u = usageCard();
        if (u) out.appendChild(h('div.mt12', null, u));
        out.appendChild(h('div.section-title', { text: '快捷操作' }));
        const row = h('div.btn-row', { style: { marginTop: '0' } });
        row.appendChild(MZApp._btn('跑今日自动更新', 'primary', function () { runDaily(); }));
        if (live.running) row.appendChild(MZApp._btn('停止全部', 'danger', function () { stopAll(); }));
        out.appendChild(row);
        out.appendChild(h('div.footnote', { text: '「跑今日自动更新」会按每本书的每日章数补更，耗时较长，发起后放着不管就行。' }));
        return out;
      },
    };
  };

  /* ============================== 书架 ============================== */
  screens.books = function () {
    return {
      title: '书架',
      action: { label: '新建', onTap: function () { newNovel(); } },
      async mount(body) {
        const d = await ensureHero();
        const out = h('div.pad');
        if (!state.novels.length) {
          out.appendChild(emptyBox('books', '书架是空的', '点右上角「新建」建一本新书'));
          return out;
        }
        const st = d.stats || {};
        out.appendChild(h('div.small.muted.mb12', {
          text: '共 ' + (st.novels || state.novels.length) + ' 本 · ' + (st.chapters || 0) + ' 章 · ' + fmtNum(st.chars || 0) + ' 字' }));
        const list = state.novels.slice().sort(function (a, b) {
          if (!!b.pinned - !!a.pinned) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
          return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
        });
        list.forEach(function (n) { out.appendChild(bookCard(n)); });
        return out;
      },
    };
  };
  function bookCard(n) {
    const live = state.live || {};
    const running = (live.books || []).filter(function (b) { return b.id === n.id; })[0] || null;
    const need = planNeed(n), made = planMade(n);
    const daily = (n.plan && n.plan.daily) || n.daily_count || 0;
    const el = h('div.book' + (running ? '.running' : ''));
    if (n.cover_url) {
      el.appendChild(h('img.cover', { src: MZ.img(n.cover_url), alt: '', decoding: 'async',
        onerror: function (e) { const im = e && e.currentTarget; if (im && im.parentNode) im.parentNode.replaceChild(h('div.cover', { text: (n.title || '书').slice(0, 1) }), im); } }));
    } else {
      el.appendChild(h('div.cover', { text: (n.title || '书').slice(0, 1) }));
    }
    const main = h('div.bk-main');
    main.appendChild(h('div.bk-top', null,
      h('div', null,
        h('div.bk-title', { text: n.title || '未命名' }),
        h('div.bk-cat', { text: [n.category, n.author].filter(Boolean).join(' · ') || '未分类' })),
      running ? h('span.live-dot') : (n.busy ? chip('队列中', 'warn') : null)));
    main.appendChild(h('div.bk-meta', null,
      chip((n.chapter_count || 0) + ' 章', '', 'books'),
      chip(fmtNum(n.total_chars || 0) + ' 字', '', 'file'),
      (n.avg_score !== undefined && n.avg_score !== null) ? chip('均分 ' + Math.round(n.avg_score), (n.avg_score >= 75 ? 'ok' : ''), 'target') : null,
      n.weak_count ? chip(n.weak_count + ' 弱章', 'amber', 'bolt') : null));
    main.appendChild(h('div.bk-foot', null,
      barOf(daily ? (made / daily) * 100 : 0, need ? 'warn' : 'ok'),
      h('span.tiny.muted.num', { text: '今日 ' + made + '/' + daily })));
    if (running && running.phase) main.appendChild(h('div.op-note', { text: running.phase + (running.current_idx ? ' · 第 ' + running.current_idx + ' 章' : '') }));
    el.appendChild(main);
    el.addEventListener('click', function () { haptic('light'); openBook(n.id); });
    return el;
  }
  function openBook(nid) {
    push({
      title: '作品',
      action: null,
      async mount() {
        const n = findNovel(nid);
        const out = h('div.pad');
        if (!n) { out.appendChild(emptyBox('bolt', '找不到这本书', '可能已被删除，返回书架刷新看看')); return out; }
        out.appendChild(h('h2', { style: { fontSize: '20px', fontWeight: '700', letterSpacing: '-.4px', margin: '2px 0 6px' }, text: n.title || '未命名' }));
        out.appendChild(h('div.bk-meta', null,
          chip((n.chapter_count || 0) + ' 章', '', 'books'),
          chip(fmtNum(n.total_chars || 0) + ' 字', '', 'file'),
          n.enabled === false ? chip('已暂停', 'warn') : chip('每日 ' + ((n.plan && n.plan.daily) || n.daily_count || 0) + ' 章', 'blue', 'refresh')));
        if (n.intro) out.appendChild(h('div.card.tight.small.muted.mt12.pre-wrap', { text: String(n.intro).slice(0, 400) }));
        out.appendChild(buttons([
          { label: '补更（续写）', tone: 'primary', onTap: function () { askUpdate(n); } },
          { label: '全书体检', onTap: function () { bookHitReview(n); } },
        ]));
        out.appendChild(buttons([
          { label: '重写前几章', onTap: function () { askRewrite(n); } },
          { label: '导出 txt', onTap: function () { exportNovel(n); } },
        ]));
        const live = (state.live || {});
        const rb = (live.books || []).filter(function (b) { return b.id === nid; })[0];
        if (rb) { const c = liveHero(state.live, { maxEvents: 6 }); out.appendChild(h('div.mt16', null, c)); }
        const d = await api.get('/api/novel/' + nid);
        const nv = d.novel || {};
        const chapters = (nv.chapters || []).slice().sort(function (a, b) { return b.idx - a.idx; });
        const scoreMap = {};
        (nv.metrics || []).forEach(function (m) { scoreMap[m.idx] = m.score; });
        const title = h('div.section-title', null,
          h('span', { text: '章节' }), h('span.sp', { text: '共 ' + chapters.length + ' 章 · 点开就写' }));
        out.appendChild(title);
        if (!chapters.length) { out.appendChild(emptyBox('write', '还没有章节', '点上面「补更（续写）」写第一章')); return out; }
        const l = h('div.list');
        chapters.slice(0, 80).forEach(function (c) {
          const sc = scoreMap[c.idx];
          l.appendChild(li({
            title: '第 ' + c.idx + ' 章　' + (c.title || ''),
            sub: fmtNum(c.chars || 0) + ' 字 · ' + (c.updated_at ? timeAgo(c.updated_at) : ''),
            right: sc === undefined ? null : chip(String(Math.round(sc)), sc >= 75 ? 'ok' : (sc >= 55 ? '' : 'bad')),
            arrow: true,
            onTap: function () { MZEditor.openChapter(nid, c.id, { title: c.title, idx: c.idx }); },
          }));
        });
        out.appendChild(l);
        if (chapters.length > 80) out.appendChild(buttons([{ label: '还有 ' + (chapters.length - 80) + ' 章没显示（可到桌面版处理）' }]));
        return out;
      },
    });
  }
  /* ============================== 动作 ============================== */
  async function startJob(path, okMsg, body, opts) {
    opts = opts || {};
    try {
      const res = await api.post(path, body || {}, opts.timeout ? { timeout: opts.timeout } : undefined);
      toast((res && res.msg) || okMsg || '已开始', 'ok');
      haptic('success');
      await refreshLive();
      if (!opts.silent) await loadHero().catch(function () { });
      if (state.tab === 'jobs' || state.tab === 'overview' || state.tab === 'books') render();
      else render();
      return res;
    } catch (e) { toast(e.message, 'bad'); return null; }
  }
  function askUpdate(n) {
    const need = planNeed(n);
    modal({
      title: '补更《' + (n.title || '') + '》',
      text: '今天还差 ' + need + ' 章达标。填要写的章数，留空＝按目标补足。这个过程会调模型逐章生成，可以放着不管。',
      input: 'number', value: need || 1, placeholder: '章数', okText: '开始写',
    }).then(function (v) {
      if (v === null) return;
      const c = parseInt(v, 10);
      startJob('/api/novel/' + n.id + '/update', '已开始补更，正在写作', { count: isFinite(c) && c > 0 ? c : undefined });
    });
  }
  function askRewrite(n) {
    modal({
      title: '重写《' + (n.title || '') + '》',
      text: '会重写前面若干章，原内容先存档、可回滚。填章数：',
      input: 'number', value: 5, okText: '开始重写', danger: true,
    }).then(function (v) {
      if (v === null) return;
      startJob('/api/novel/' + n.id + '/rewrite', '已开始重写', { count: parseInt(v, 10) || 5 });
    });
  }
  async function bookHitReview(n) {
    const ok = await confirm('对《' + (n.title || '') + '》做全书爆款体检？会按抽样方式让多个模型评分，耗时较长。',
      { okText: '开始体检' });
    if (!ok) return;
    startJob('/api/novel/' + n.id + '/hit_review', '体检完成', { scope: 'sample' }, { timeout: 300000 });
  }
  async function exportNovel(n) {
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
  async function newNovel() {
    const v = await modal({ title: '新建作品', text: '先填书名，其他设定可以之后在桌面版里补。', input: 'text', placeholder: '书名', okText: '创建' });
    if (v === null || !String(v).trim()) return;
    try {
      const res = await api.post('/api/novels', { title: String(v).trim() });
      toast('已创建《' + String(v).trim() + '》', 'ok');
      haptic('success');
      await loadHero();
      await refreshLive();
      go('books'); render();
      if (res && res.novel && res.novel.id) setTimeout(function () { openBook(res.novel.id); }, 260);
    } catch (e) { toast(e.message, 'bad'); }
  }
  async function runDaily() {
    const ok = await confirm('立刻执行一次「今日自动更新」？会给所有启用的作品按每日章数补更，耗时可能很长。', { okText: '开始' });
    if (!ok) return;
    startJob('/api/run_daily', '已开始今日自动更新', {}, { timeout: 120000 });
  }
  async function stopAll() {
    const ok = await confirm('停止全部任务？当前这一章写完后就会停下，已写好的会保留。', { danger: true, okText: '停止全部' });
    if (!ok) return;
    try {
      const r = await api.post('/api/stop_all');
      toast((r && r.msg) || '已请求停止', 'ok');
      await refreshLive();
      render();
    } catch (e) { toast(e.message, 'bad'); }
  }

  /* ============================== 全局任务条（#opsDock） ==============================
     服务端会给每个长操作登记一条 ops（第几步 / 什么阶段 / 已用时 / 模型排队），
     这里把它画成挂在 body 上的 fixed 任务条。因为它不属于任何一屏的 DOM，
     所以切标签页、翻页、开关写作台、甚至重开 App 都不会把进度弄丢。 */
  let pendingOps = [];
  let pendingSeq = 1;
  function pending(label) {
    const t = { id: pendingSeq++, label: label || '正在跑', t0: Date.now() };
    pendingOps.push(t);
    paintOps();
    return t;
  }
  function pendingDone(t) {
    if (!t) return;
    pendingOps = pendingOps.filter(function (x) { return x.id !== t.id; });
    paintOps();
  }
  function opsAll() {
    const live = state.live || {};
    const out = [];
    Object.keys(live.ops || {}).forEach(function (k) {
      const o = live.ops[k] || {};
      out.push({
        key: k, title: o.title || k, phase: o.phase || '', note: o.note || '',
        pct: o.pct || 0, elapsed: o.elapsed || 0, steps: o.steps || [], step: o.step || 0,
        finished: !!o.finished, ok: o.ok !== false, error: o.error || '',
      });
    });
    (state.liveJobs || live.jobs || []).forEach(function (j) {
      out.push({
        key: 'job:' + j.id, title: j.title || j.kind || '任务', phase: j.message || j.status || '',
        note: '', pct: j.total ? Math.round(((j.done || 0) * 100) / j.total) : 0, elapsed: 0,
        steps: [], step: 0, finished: false, ok: true, error: '',
      });
    });
    if (live.running && !out.length) {
      out.push({
        key: 'main', title: live.job_title || '正在生成', phase: phaseLine(live), note: '',
        pct: live.pct || 0, elapsed: live.elapsed || 0, steps: [], step: 0,
        finished: false, ok: true, error: '',
      });
    }
    if (!Object.keys(live.ops || {}).length) {
      const now = Date.now();
      pendingOps.forEach(function (t) {
        if (now - t.t0 > 8000) return;
        out.push({
          key: 'pending:' + t.id, title: t.label, phase: '已发出，正在排队…', note: '',
          pct: 3, elapsed: Math.round((now - t.t0) / 1000), steps: [], step: 0,
          finished: false, ok: true, error: '',
        });
      });
    }
    return out;
  }
  function opsRowNode(o) {
    const cls = o.finished ? (o.ok ? 'ok' : 'bad') : 'run';
    const stepTxt = (o.steps && o.steps.length)
      ? ('第 ' + Math.min((o.step || 0) + 1, o.steps.length) + '/' + o.steps.length + ' 步') : '';
    const bits = [o.phase, stepTxt].filter(Boolean).join(' · ');
    const row = h('div.od-row.' + cls);
    row.appendChild(h('div.od-r1', null,
      h('span.od-ic', { text: o.finished ? (o.ok ? '\u2713' : '!') : '\u25cf' }),
      h('b.od-t', { text: o.title || '' }),
      h('span.sp'),
      h('span.dim.small', { text: o.elapsed ? fmtDur(o.elapsed) : '' })));
    row.appendChild(barOf(o.pct || 0, cls === 'bad' ? 'bad' : ''));
    if (bits || o.note || o.error) {
      row.appendChild(h('div.od-s', { text: [bits || '正在准备\u2026', o.note, o.error ? String(o.error).slice(0, 90) : ''].filter(Boolean).join(' · ') }));
    }
    if (o.steps && o.steps.length) row.appendChild(stepsNode(o.steps, o.step, ''));
    return row;
  }
  function paintOps() {
    const dock = $('#opsDock');
    if (!dock) return;
    const list = opsAll();
    if (!list.length) {
      dock.hidden = true;
      dock.classList.remove('on');
      const b0 = $('#odBody');
      if (b0) { b0.hidden = true; clear(b0); }
      const t0 = $('#odTitle'), s0 = $('#odSub'), p0 = $('#odPct'), f0 = $('#odFill');
      if (t0) t0.textContent = '';
      if (s0) s0.textContent = '';
      if (p0) p0.textContent = '0%';
      if (f0) f0.style.width = '0%';
      return;
    }
    const running = list.filter(function (o) { return !o.finished; });
    const head = running[0] || list[0];
    const t = $('#odTitle'), sub = $('#odSub'), pct = $('#odPct'), fill = $('#odFill'), body = $('#odBody');
    dock.hidden = false;
    if (t) t.textContent = running.length > 1 ? ('正在跑 ' + running.length + ' 项') : (head.title || '正在跑');
    if (sub) sub.textContent = head.phase || head.note || '正在准备\u2026';
    if (pct) pct.textContent = Math.round(head.pct || 0) + '%';
    if (fill) fill.style.width = Math.max(2, Math.min(100, head.pct || 0)) + '%';
    if (body && !body.hidden) {
      clear(body);
      list.forEach(function (o) { body.appendChild(opsRowNode(o)); });
    }
  }

  /* ============================== 活数据 ============================== */
  function paintDock() {
    const dock = $('#islandDock');
    if (!dock) return;
    const live = state.live || {};
    if (!liveBusy(live)) { dock.hidden = true; return; }
    const pct = Math.max(0, Math.min(100, Number(live.pct) || 0));
    const t = $('#idTitle'), sb = $('#idSub'), pc = $('#idPct'), fl = $('#idFill');
    if (t) t.textContent = live.job_title || '正在跑';
    if (sb) sb.textContent = phaseLine(live);
    if (pc) pc.textContent = Math.round(pct) + '%';
    if (fl) fl.style.width = pct + '%';
    dock.hidden = false;
  }
  function paintBadge() {
    const b = $('#badgeJobs');
    if (!b) return;
    const live = state.live || {};
    const q = live.queue || {};
    const n = (q.active || 0) + (q.queued || (q.waiting || []).length || 0);
    if (n > 0) { b.hidden = false; b.textContent = n > 99 ? '99+' : String(n); }
    else b.hidden = true;
  }
  async function refreshLive() {
    try {
      const d = await api.get('/api/live', { timeout: 20000 });
      /* 后端把实时状态包在 live 里（{ok, live:{...}, jobs:[...]}）；
         早先直接赋值给 state.live，于是 ops / running 全是 undefined——
         表现就是「轮询一刷新，进度条就没了」。这里必须拆包。 */
      state.live = (d && d.live) ? d.live : (d || {});
      state.liveJobs = (d && d.jobs) || [];
      paintDock(); paintBadge(); paintOps();
      return state.live;
    } catch (e) { paintDock(); return null; }
  }
  async function refreshAll(showToast) {
    try { await loadHero(); } catch (e) { if (showToast) toast(e.message, 'bad'); }
    await refreshLive();
    await render();
    if (showToast) toast('已刷新', 'ok');
  }

  /* ============================== 访问口令（老桌面版直连） ============================== */
  let authPrompting = false;
  function openTokenDialog(opts) {
    opts = opts || {};
    if (authPrompting) return Promise.resolve(false);
    authPrompting = true;
    return modal({
      title: '访问口令',
      text: opts.wrong
        ? '口令不对。口令区分大小写，请改成全小写再试。'
        : '手机连电脑上的墨舟时需要填电脑端设置的访问口令（区分大小写，全是小写字母和数字）。',
      input: 'text', value: MZ.getToken(), placeholder: '访问口令（全小写）', okText: '保存',
    }).then(function (v) {
      authPrompting = false;
      if (v === null) return false;
      MZ.setToken(String(v).trim());
      toast(MZ.getToken() ? '口令已保存，正在重连…' : '已清空口令', 'ok');
      return true;
    });
  }

  /* ============================== 登录 ============================== */
  function hasAuth() {
    try { if (localStorage.getItem('mz_gw')) return true; } catch (e) { /* 忽略 */ }
    return !!MZ.getToken();
  }
  function showLogin(err) {
    const app = $('#app'), lw = $('#loginWrap');
    if (lw) lw.hidden = false;
    if (app) app.hidden = true;
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
    if (err) {
      const e = $('#loginErr');
      if (e) { e.hidden = false; e.textContent = (err && err.message) || String(err); }
    }
  }
  function showApp() {
    const app = $('#app'), lw = $('#loginWrap');
    if (lw) lw.hidden = true;
    if (app) app.hidden = false;
    state.authed = true;
  }
  async function doLogin(phone, password) {
    const btn = $('#loginGo'), hint = $('#loginErr');
    if (btn) { btn.disabled = true; btn.textContent = '登录中…'; }
    if (hint) hint.hidden = true;
    try {
      const r = await fetch(MZ.url('/api/mz/login'), {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: String(phone).replace(/\s+/g, ''), password: String(password) }),
      });
      let d = null;
      try { d = await r.json(); } catch (e) { d = null; }
      if (r.ok && d && d.ok && d.token) {
        MZ.setSession(d.token);
        showApp();
        await refreshAll(false);
        startTimer();
        return true;
      }
      throw new Error((d && (d.error || d.msg)) || '登录失败，请检查手机号和密码');
    } catch (e) {
      if (hint) { hint.hidden = false; hint.textContent = e.message || '连不上云端服务器，请检查网络后重试'; }
      return false;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '登录并同步'; }
    }
  }
  function initLoginForm() {
    const f = $('#loginForm');
    if (!f) return;
    f.addEventListener('submit', function (ev) {
      ev.preventDefault();
      const p = ($('#lgPhone') || {}).value || '';
      const w = ($('#lgPass') || {}).value || '';
      if (!p.trim() || !w) {
        const e = $('#loginErr');
        if (e) { e.hidden = false; e.textContent = '请填写手机号和密码'; }
        return;
      }
      doLogin(p, w);
    });
    ['#lgPhone', '#lgPass'].forEach(function (sel) {
      const el = $(sel);
      if (el) el.addEventListener('input', function () { const e = $('#loginErr'); if (e) e.hidden = true; });
    });
  }

  /* ============================== 主题 ============================== */
  function applyTheme(t) {
    document.body.classList.toggle('light', t === 'light');
    const meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.setAttribute('content', t === 'light' ? '#eef2f8' : '#0a0e15');
    try { localStorage.setItem('mz_theme', t); } catch (e) { /* 忽略 */ }
  }
  function getTheme() { return document.body.classList.contains('light') ? 'light' : 'dark'; }

  /* ============================== 启动 ============================== */
  let liveTimer = null;
  function paintIcons() {
    $$('.tb-ico[data-ico]').forEach(function (el) {
      clear(el);
      el.appendChild(icon(el.dataset.ico, { size: 22 }));
    });
    ['#loginLogo', '#splashLogo'].forEach(function (sel) {
      const el = $(sel);
      if (!el) return;
      clear(el);
      el.appendChild(brand(38));
    });
  }
  function pollLive(delay) {
    liveTimer = setTimeout(async function () {
      if (document.hidden) { pollLive(4000); return; }
      await refreshLive();
      if (state.tab === 'jobs' || (state.tab === 'overview' && liveBusy(state.live))) render();
      pollLive(liveBusy(state.live) ? 1600 : 4000);
    }, delay);
  }
  function startTimer() {
    if (liveTimer) { clearTimeout(liveTimer); clearInterval(liveTimer); }
    pollLive(900);
  }
  function hideSplash() {
    const s = $('#splash');
    if (!s) return;
    s.classList.add('gone');
    setTimeout(function () { if (s.parentNode) s.parentNode.removeChild(s); }, 420);
  }
  function boot() {
    paintIcons();
    initLoginForm();
    $$('.tab').forEach(function (b) { b.addEventListener('click', function () { switchTab(b.dataset.tab); }); });
    const nb = $('#navBack');
    if (nb) nb.addEventListener('click', function () { haptic('light'); pop(); });
    const dock = $('#islandDock');
    if (dock) dock.addEventListener('click', function () { haptic('light'); switchTab('jobs'); });
    const od = $('#opsDock'), odTop = $('#odTop'), odBody = $('#odBody');
    if (odTop && odBody) {
      odTop.addEventListener('click', function () {
        haptic('light');
        odBody.hidden = !odBody.hidden;
        od.classList.toggle('on', !odBody.hidden);
        paintOps();
      });
    }
    applyTheme(localStorage.getItem('mz_theme') || 'dark');

    if (!hasAuth()) { showLogin(); hideSplash(); return; }

    showApp();
    go('overview');
    const main = $('#main');
    main.addEventListener('scroll', function () {
      const s = state.stack.length ? state.stack[state.stack.length - 1] : (screens[state.tab] && screens[state.tab]());
      if (s) navbar().classList.toggle('scrolled', !s.noLarge && main.scrollTop > 10);
    }, { passive: true });
    attachPull(main, async function () { await loadHero(); await refreshLive(); await render(); });

    /* 返回手势：屏幕左边缘右滑 */
    let sx = 0, sy = 0, tracking = false;
    document.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY;
      tracking = sx < 26 && state.stack.length > 0;
    }, { passive: true });
    document.addEventListener('touchend', function (e) {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      if (t.clientX - sx > 70 && Math.abs(t.clientY - sy) < 60) pop();
    }, { passive: true });

    refreshAll(false).then(hideSplash, hideSplash);
    startTimer();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  return {
    state: state, screens: screens, MZUI: MZUI,
    render: render, push: push, pop: pop, switchTab: switchTab, go: go,
    loadHero: loadHero, ensureHero: ensureHero, refreshAll: refreshAll, refreshLive: refreshLive,
    findNovel: findNovel, openBook: openBook, openTokenDialog: openTokenDialog,
    applyTheme: applyTheme, getTheme: getTheme, showLogin: showLogin, doLogin: doLogin,
    pick: pick, li: li, card: card, kpi: kpi, buttons: buttons, seg: seg, bar: barOf,
    span: span, txt: txt, busySheet: busySheet, startJob: startJob, newNovel: newNovel,
    runDaily: runDaily, stopAll: stopAll, stagger: stagger, topline: topline,
    askUpdate: askUpdate, askRewrite: askRewrite, bookHitReview: bookHitReview,
    liveBusy: liveBusy, phaseLine: phaseLine, emptyBox: emptyBox, loadingBox: loadingBox, errBox: errBox,
    pending: pending, pendingDone: pendingDone, paintOps: paintOps, opsAll: opsAll,
    hitFixInstruction: hitFixInstruction,
    _btn: function (label, tone, onTap, size) {
      const b = h('button.btn' + (tone ? '.' + tone : '') + (size === 'sm' ? '.sm' : ''), { type: 'button', text: label });
      b.addEventListener('click', function () { haptic('light'); onTap(); });
      return b;
    },
  };
})();