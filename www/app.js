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

/* ============================== 视口 / 安全区 ==============================
   iOS 的 WKWebView 冷启动有个已知毛病：页面第一次布局时 env(safe-area-inset-*)
   可能报回来 0，而且这一整个会话都不再自己更新。底部标签栏、全局任务条都是按
   var(--safe-b) 定位的，于是就贴到屏幕最下沿、骑在 home 指示条那一条上 ——
   用户的原话是「dock 栏位置过于靠下」；把 App 关掉重开，下一次侥幸拿到正确的值
   就正常了，所以症状是「时好时坏，重开就好」。

   这里做两件事：
   1) 用探针元素把当前真正生效的 env() 读出来，主动写回 --safe-t / --safe-b，
      并在首帧 / load / resize / 转屏 / visualViewport 变化时重读。系统只要后来
      报对了，界面自己就跟上，不用重开 App。
   2) 给「确定带 home 指示条」的机型钉一个下限（iPhone X 及以后竖屏逻辑高度 812
      起；无 home 键的 iPad 是 20）。万一 env() 一直报 0，底栏也不会骑上去。
      只在整屏显示（装机壳 / 加到主屏幕 / 全屏）时钉；手机浏览器带着上下工具栏时
      不钉 —— 那种情况 Safari 自己已经让开了，钉下限反而多出一块空白。

   整块包在 try 里、rAF 也做了兜底：读不到安全区（老 WebView、测试用的假 DOM、
   没有 screen）绝不能抛出去 —— app.js 一抛就是白屏，代价远大于「底栏高一点」。 */

(function () {
  try {
    const D = document.documentElement;
    const probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText =
      'position:fixed;left:-2px;bottom:-2px;width:1px;height:1px;visibility:hidden;' +
      'pointer-events:none;padding-top:env(safe-area-inset-top,0px);' +
      'padding-bottom:env(safe-area-inset-bottom,0px)';

    function readInset() {
      if (!probe.parentNode) D.appendChild(probe);
      const cs = getComputedStyle(probe);
      return { t: parseFloat(cs.paddingTop) || 0, b: parseFloat(cs.paddingBottom) || 0 };
    }
    /* 屏的物理尺寸（CSS 逻辑像素）。screen 都没有的环境按 0 处理，一律不钉下限。 */
    function screenSize() {
      if (typeof screen === 'undefined' || !screen) return { w: 0, h: 0 };
      const a = screen.width || 0, b = screen.height || 0;
      return { w: Math.min(a, b), h: Math.max(a, b) };
    }
    /* 整屏显示才钉下限：Safari 带工具栏时 innerHeight 明显小于屏高 */
    function fullscreen() {
      if (window.navigator.standalone) return true;
      const s = screenSize();
      const ih = Math.max(window.innerWidth || 0, window.innerHeight || 0);
      return !!s.h && ih >= s.h - 24;
    }
    /* 带 home 指示条的机型：iPhone X 起最矮也有 812（竖屏逻辑高度）；
       iPadOS 13 起 UA 报 Macintosh，用「多点触控 + 屏高」认出来（真 Mac 恒为 0）。 */
    function btn() {
      const s = screenSize();
      if (s.h < 812 || s.w < 375) return 0;
      const portrait = (window.innerHeight || 0) >= (window.innerWidth || 0);
      const ua = navigator.userAgent || '';
      if (/iPhone|iPod/i.test(ua)) return portrait ? 34 : 21;
      if (/iPad/i.test(ua)) return 20;
      if ((navigator.maxTouchPoints || 0) > 1 && /Macintosh/i.test(ua)) return 20;
      return 0;
    }
    let raf = 0;
    function apply() {
      raf = 0;
      const v = readInset();
      const fb = fullscreen() ? btn() : 0;
      const portrait = (window.innerHeight || 0) >= (window.innerWidth || 0);
      D.style.setProperty('--safe-t', Math.max(v.t, (fb && portrait) ? 44 : 0) + 'px');
      D.style.setProperty('--safe-b', Math.max(v.b, fb) + 'px');
    }
    function sync() {
      if (raf) return;
      if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(apply);
      else apply();
    }

    sync();
    window.addEventListener('resize', sync);
    window.addEventListener('pageshow', sync);
    window.addEventListener('orientationchange', function () {
      sync(); setTimeout(sync, 260); setTimeout(sync, 700);
    });
    window.addEventListener('load', function () {
      sync(); setTimeout(sync, 320); setTimeout(sync, 1200);
    });
    if (window.visualViewport) window.visualViewport.addEventListener('resize', sync);
    setTimeout(sync, 0); setTimeout(sync, 400); setTimeout(sync, 1500);
  } catch (e) {
    /* 静默放弃：布局照旧吃 CSS 里的 env() 兜底值 */
  }
})();

window.MZApp = (function () {
  const { h, frag, add, clear, $, $$, api, toast, sheet, actions, modal, confirm, haptic,
          fmtNum, fmtWords, fmtDur, fmtDate, timeAgo, debounce, sleep, emptyBox, loadingBox, errBox,
          attachPull, icon, brand, ring, bar, chip, countNode, countUp, skeleton, reduceMotion, hold } = MZ;

  /* 四个标签：书架就是首页（跟阅读器一样的思路 —— 打开就是书）
     老代码里 switchTab('overview') 的地方统一落到书架，不报错。 */
  const TABS = ['books', 'write', 'jobs', 'me'];
  const LEGACY_TAB = { overview: 'books', shelf: 'books', home: 'books', books: 'books', more: 'me', mine: 'me' };
  const TAB_LABEL = { books: '书架', write: '写作', jobs: '任务', me: '我的' };
  const state = {
    tab: 'books',
    liveJobs: [],
    stack: [],
    hero: null,
    profile: null,
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

  /* 书名要拼进正则（任务条上「本地占位」和「服务端那条」靠它去重），先转义更稳 */
  function reEsc(v) { return String(v == null ? '' : v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

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
    const kids = Array.prototype.slice.call(root.children).filter(function (k) {
      return !k.hasAttribute || !k.hasAttribute('data-static');
    }).slice(0, 9);
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
    const pct = creepPct(live.pct, live.rate, !!live.running);
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
          h('span.lh-elapsed', live.elapsed ? { text: '已用时 ' + fmtDur(live.elapsed) } : { hidden: true }),
          live.chars ? h('span', { text: fmtWords(live.chars) }) : null))));
    const q = queueNode(live);
    if (q) box.appendChild(q);
    const books = live.books || [];
    if (books.length) {
      const bl = h('div.live-books');
      books.forEach(function (b) {
        const bp = b.pct === undefined || b.pct === null ? (b.need ? ((b.done || 0) / b.need) * 100 : 0)
          : creepPct(b.pct, b.rate, (b.done || 0) < (b.need || 0));
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
  /* opts.keepScroll：原样刷新（轮询 / 操作收尾）时保持用户当前看到的位置。
     以前轮询和「开始写」的收尾都直接 render()：main.scrollTop 归零 + 整屏骨架闪一下，
     用户的原话就是「老是自动刷新，有种跳感」。现在这种刷新先在离屏把新内容建好，
     最后一次性换上去：中途高度不会塔，滚动位置也不会被浏览器夹回页首。 */
  async function render(opts) {
    opts = opts || {};
    /* 换页时把写作台 / 阅读器留下的「任务条抬升」清掉：那是给它们自己的
       fixed 工具条让位用的，带回别的页会让任务条停在一个不属于这里的离底
       距离上（太高或太低都见过），严重时只能重开 App 才正常。 */
    if (!document.querySelector('.ed-wrap') && !document.querySelector('.rd-wrap')) {
      document.documentElement.style.removeProperty('--dock-bottom');
    }
    const main = $('#main');
    if (!main) return;
    const s = state.stack.length ? state.stack[state.stack.length - 1] : (screens[state.tab] && screens[state.tab]());
    if (!s) return;
    const keep = opts.keepScroll ? main.scrollTop : 0;
    applyNav(s);
    const anim = state.anim || '';
    state.anim = '';
    const body = h('div');
    if (anim) body.classList.add('screen-' + anim);
    if (!keep) {
      clearMain();
      main.appendChild(body);
    }
    body.appendChild(skeleton(3));
    if (!keep) main.scrollTop = 0;
    topline(true);
    /* 每一屏重画之前先作废上个任务页的「原地刷新器」；只有任务页的 mount 会重新挂上。 */
    state.jobsView = null;
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
    if (keep) {
      clearMain();
      main.appendChild(body);
      main.scrollTop = keep;
      /* 列表/封面高度还在长，下一帧再兜一次 */
      requestAnimationFrame(function () { main.scrollTop = keep; });
    }
    if (s.after) s.after(body);
  }
  function go(tab) {
    if (LEGACY_TAB[tab]) tab = LEGACY_TAB[tab];
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

  /* ---------- 别的客户端改了稿子，这边自己跟上 ----------
     墨舟是「电脑上一个本地库 + 云端一份」：手机 / 平板看到的一直是云端那份，
     电脑上删了书 / 写了新章，云端要等一次同步才变；别人在另一头删了书，
     这边界面也会一直摆着那本已经没了的书，点进去才报错。
     以前只有「下拉刷新」和「重开 App」才会重新拉一次书架 —— 用户的原话是
     「同一账号下删除作品，其他客户端并没有同步」。
     现在每 15 秒（以及从后台切回前台时）对一次 /api/overview：
     书的数量 / 标题 / 章节数 / 字数 / 更新时间有任何变化才重画，没变就一个像素都不动。 */
  const SHELF_CHECK_MS = 15000;
  let shelfSig = '';
  let shelfTimer = null;
  let shelfBusy = false;

  /* 书架的「指纹」：只取会显示在界面上的那几项，够用来判断「变没变」 */
  function shelfSignature(h) {
    if (!h) return '';
    const ns = (h.novels || []).map(function (n) {
      return [n.id, n.title, n.chapter_count, n.total_chars, n.updated_at,
        (n.plan && n.plan.today_made) || 0, n.busy ? 1 : 0,
        n.cover_url ? 1 : 0].join('~');
    }).join('|');
    const st = h.stats || {};
    return ns + '#' + [st.novels, st.chapters, st.chars].join(',');
  }

  /* 全屏覆盖层（写作台 / 阅读器）开着的时候不要去动底下那一屏 */
  function shelfOverlayOpen() {
    return !!document.querySelector('.ed-wrap, .rd-wrap');
  }

  async function syncShelf() {
    if (document.hidden || shelfBusy) return false;
    /* 写作台 / 阅读器开着：先不动，等它关掉之后那一轮再来对 */
    if (shelfOverlayOpen()) return false;
    /* 正在输入（搜索书名之类）：重画会把输入框的焦点和键盘弄掉，等下轮到再说 */
    const ae = document.activeElement;
    if (ae && (/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) || ae.isContentEditable)) return false;
    shelfBusy = true;
    try {
      const h = await api.get('/api/overview', { timeout: 20000 });
      if (shelfOverlayOpen()) return false;
      const sig = shelfSignature(h);
      const changed = !!shelfSig && sig !== shelfSig;
      state.hero = h;
      state.novels = h.novels || [];
      state.version = h.version || '';
      if (h.live) state.live = h.live;
      state.hydrated = true;
      shelfSig = sig;
      if (changed) await render({ keepScroll: true });
      return changed;
    } catch (e) {
      return false;      /* 断网 / 超时：下一轮再来，不弹错 */
    } finally {
      shelfBusy = false;
    }
  }

  async function loadHero() {
    state.hero = await api.get('/api/overview');
    state.novels = state.hero.novels || [];
    state.version = state.hero.version || '';
    if (state.hero.live) state.live = state.hero.live;
    state.hydrated = true;
    shelfSig = shelfSignature(state.hero);
    return state.hero;
  }
  async function ensureHero() { if (!state.hydrated) await loadHero(); return state.hero; }
  /* 个人资料（用户名/性别/年龄/头像）。读不到不影响主流程，只是"我的"页少张卡。 */
  async function loadProfile() {
    try {
      const r = await api.get('/api/mz/profile');
      state.profile = (r && r.profile) || {};
    } catch (e) { /* 资料读不到不影响用 */ }
    return state.profile;
  }
  function findNovel(nid) { return state.novels.filter(function (n) { return n.id === nid; })[0] || null; }
  /* 作品上的作者名：只跟「笔名」走，笔名没填才退回用户名。
     这样改用户名不会动到已写的书，也不会把登录名印到封面和导出的 txt 上。 */
  function myName() { return (state.profile && (state.profile.pen_name || state.profile.name || state.profile.username)) || ''; }
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
  /* 「整理（多选）」和「搜索 / 排序 / 筛选」的状态都放模块级：
     删除、切模式、切页面回来之后都要 render()，重建 DOM 不能把用户看到哪儿丢了。 */
  const booksSel = { mode: false, ids: {} };
  const booksView = { q: '', sort: 'updated', filter: 'all' };

  const BOOK_SORTS = [
    { key: 'updated', label: '最近更新' },
    { key: 'chars', label: '字数' },
    { key: 'chapters', label: '章节' },
    { key: 'score', label: '评分' },
    { key: 'title', label: '书名' },
  ];
  const BOOK_FILTERS = [
    { key: 'all', label: '全部' },
    { key: 'male', label: '男频' },
    { key: 'female', label: '女频' },
    { key: 'draft', label: '没开写' },
    { key: 'nooutline', label: '缺大纲' },
    { key: 'pinned', label: '置顶' },
  ];
  const BOOK_EMPTY = {
    draft: ['这些书都还没开写', '筛出来的书都是 0 章。打开一本，点「补更（续写）」就能写起来。'],
    nooutline: ['这些书都有大纲', '按「缺大纲」筛出来的书都已经有主线大纲了。'],
    pinned: ['还没有置顶的书', '长按一本书 → 置顶，或者在「编辑资料」里打开「书架置顶」。'],
  };

  function booksSelCount() {
    return Object.keys(booksSel.ids).filter(function (k) { return booksSel.ids[k]; }).length;
  }
  function pickedIds() {
    return Object.keys(booksSel.ids).filter(function (k) { return booksSel.ids[k]; }).map(Number);
  }
  function novelTitleOf(id) {
    const n = state.novels.filter(function (x) { return x.id === Number(id); })[0];
    return n ? (n.title || '未命名') : ('#' + id);
  }
  function hasOutline(n) {
    if (!n) return false;
    if (typeof n.has_outline === 'boolean') return n.has_outline;
    return !!(n.outline && String(n.outline).trim());
  }
  /* 章纲标题：模型可能已经带了「第 3 章」，也可能只给标题，统一成「第 N 章 标题」 */
  function chapTitle(c, i) {
    const t = String((c && c.title) || '').trim();
    if (/^第\s*[0-9一二三四五六七八九十百千零两]+\s*章/.test(t)) return t;
    return '第' + ((c && c.idx) || i + 1) + '章 ' + (t || '（没写标题）');
  }
  function sortBooks(list, key) {
    const arr = (list || []).slice();
    arr.sort(function (a, b) {
      const pin = (!!b.pinned ? 1 : 0) - (!!a.pinned ? 1 : 0);
      if (pin) return pin;
      if (key === 'chars') return (b.total_chars || 0) - (a.total_chars || 0);
      if (key === 'chapters') return (b.chapter_count || 0) - (a.chapter_count || 0);
      if (key === 'score') return (b.avg_score || 0) - (a.avg_score || 0);
      if (key === 'title') return String(a.title || '').localeCompare(String(b.title || ''), 'zh');
      return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
    });
    return arr;
  }
  function filterBooks(list, key) {
    if (!key || key === 'all') return list;
    return (list || []).filter(function (n) {
      if (key === 'male') return String(n.channel || '').indexOf('男') >= 0;
      if (key === 'female') return String(n.channel || '').indexOf('女') >= 0;
      if (key === 'draft') return !(n.chapter_count || 0);
      if (key === 'nooutline') return !hasOutline(n);
      if (key === 'pinned') return !!n.pinned;
      return true;
    });
  }
  function searchBooks(list, q) {
    q = String(q || '').trim().toLowerCase();
    if (!q) return list;
    return (list || []).filter(function (n) {
      return [n.title, n.author, n.category, n.channel, n.last_title]
        .some(function (v) { return String(v || '').toLowerCase().indexOf(q) >= 0; });
    });
  }
  function visibleBooks() {
    return filterBooks(searchBooks(sortBooks(state.novels, booksView.sort), booksView.q), booksView.filter);
  }

  screens.books = function () {
    return {
      title: '书架',
      action: { label: '新建', onTap: function () { newNovelMenu(); } },
      async mount() {
        const d = await ensureHero();
        const out = h('div');
        if (!state.novels.length) {
          booksSel.mode = false; booksSel.ids = {};
          const em = emptyBox('books', '书架是空的',
            '点右上角「新建」：可以自己取个书名让 AI 写大纲，也可以把整本书粘进来导入');
          em.classList.add('pad');
          out.appendChild(em);
          return out;
        }
        const st = d.stats || {};
        const total = state.novels.length;
        const stat = h('span.bh-stat');
        const host = h('div.books-grid');
        const tip = h('div.footnote');

        function paintStat(shown) {
          clear(stat);
          if (booksSel.mode) {
            stat.appendChild(h('b', { text: '已选 ' + booksSelCount() + ' / ' + shown + ' 本' }));
            return;
          }
          stat.appendChild(h('b', { text: '共 ' + (st.novels || total) + ' 本' }));
          if (shown !== total) stat.appendChild(h('span', { text: ' · 筛出 ' + shown + ' 本' }));
          stat.appendChild(h('span', { text: ' · ' + (st.chapters || 0) + ' 章 · ' + fmtNum(st.chars || 0) + ' 字' }));
        }
        function paint() {
          const list = visibleBooks();
          clear(host);
          list.forEach(function (n) { host.appendChild(bookCard(n)); });
          if (!list.length) {
            const e = BOOK_EMPTY[booksView.filter];
            host.appendChild(emptyBox('search', e ? e[0] : '没有符合条件的书',
              e ? e[1] : '换个关键词，或者把上面的筛选切回「全部」。'));
          }
          paintStat(list.length);
        }

        /* 吸顶条：往上滚的时候「共几本 / 整理 / 删除」一直挂在导航栏下面 */
        const head = h('div.books-head' + (booksSel.mode ? '.sel' : ''), { 'data-static': true });
        head.appendChild(stat);
        const tools = h('div.bh-tools');
        if (booksSel.mode) {
          const shown = visibleBooks().length;
          const allPicked = shown > 0 && booksSelCount() >= shown;
          tools.appendChild(miniBtn(allPicked ? '取消全选' : '全选', '', function () {
            if (allPicked) booksSel.ids = {};
            else visibleBooks().forEach(function (n) { booksSel.ids[n.id] = true; });
            render();
          }));
          tools.appendChild(miniBtn('置顶', '', function () {
            const ids = pickedIds();
            if (!ids.length) { toast('先点书封选中要操作的书', 'bad'); return; }
            setPinned(ids, true);
          }));
          tools.appendChild(miniBtn('取消置顶', '', function () {
            const ids = pickedIds();
            if (!ids.length) { toast('先点书封选中要操作的书', 'bad'); return; }
            setPinned(ids, false);
          }));
          tools.appendChild(miniBtn(booksSelCount() ? '删除 ' + booksSelCount() : '删除', 'danger', function () {
            if (!booksSelCount()) { toast('先点书封选中要删的书', 'bad'); return; }
            removeSelected();
          }));
          tools.appendChild(miniBtn('完成', '', function () {
            booksSel.mode = false; booksSel.ids = {}; render();
          }));
        } else {
          tools.appendChild(miniBtn('整理', '', function () {
            booksSel.mode = true; booksSel.ids = {}; render();
          }));
        }
        head.appendChild(tools);

        if (!booksSel.mode) out.appendChild(todayStrip(d));
        out.appendChild(head);
        out.appendChild(booksTools(paint));
        out.appendChild(host);
        tip.textContent = booksSel.mode
          ? '选好之后点上面的「置顶 / 删除」；删除会先放进「我的 → 回收站」，随时能恢复。'
          : '点封面直接进这本书；长按封面或点右上角「⋯」，可以编辑资料、写大纲、置顶、删书。';
        out.appendChild(tip);
        paint();
        return out;
      },
    };
  };

  /* 书架最上面那条：今天还差几章 + 一键补更。
     以前在「总览」页，现在书架就是首页，这条直接摆在书名上面。 */
  function todayStrip(d) {
    const st = (d && d.stats) || {};
    const done = Number(st.today_chapters) || 0;
    const target = Number(st.today_target) || 0;
    const todos = state.novels.filter(function (n) { return n.enabled !== false && planNeed(n) > 0; });
    const box = h('div.today-strip');
    const main = h('div.ts-main');
    main.appendChild(h('div.ts-num', null,
      h('span', { text: String(done) }),
      h('small', { text: target ? '/ ' + target + ' 章' : '章 · 今天' })));
    main.appendChild(h('div.ts-sub', { text: target
      ? (done >= target ? '今天的量已经达标，想写就接着写' : '还差 ' + (target - done) + ' 章达标' + (todos.length ? ' · ' + todos.length + ' 本待补' : ''))
      : (state.novels.length ? '共 ' + state.novels.length + ' 本作品 · ' + (st.chapters || 0) + ' 章' : '还没有作品') }));
    main.appendChild(h('div.ts-bar', null, barOf(target ? (done / target) * 100 : 0, (target && done >= target) ? 'ok' : '')));
    box.appendChild(main);
    const b = h('button.bh-btn.primary', { type: 'button', text: '补更' });
    b.addEventListener('click', function () { haptic('light'); runDaily(); });
    box.appendChild(b);
    return box;
  }

  /* 搜索 / 排序 / 筛选：只重画书卡，不整体 render()，否则搜索框会失焦、键盘会掉 */
  function booksTools(repaint) {
    const box = h('div.bk-tools', { 'data-static': true });
    const inp = h('input.inp.bk-search', {
      type: 'search', placeholder: '搜书名 / 作者 / 类型',
      autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false',
    });
    inp.value = booksView.q;
    inp.addEventListener('input', function () { booksView.q = inp.value; repaint(); });
    const sortBox = seg(BOOK_SORTS, booksView.sort, function (k) {
      booksView.sort = k; repaint(); marks();
    });
    sortBox.classList.add('bk-sort');
    const chipBox = h('div.chips.bk-filter');
    BOOK_FILTERS.forEach(function (f) {
      const c = h('button.chip.pick' + (booksView.filter === f.key ? '.on' : ''), { type: 'button', text: f.label });
      c.addEventListener('click', function () {
        haptic('light');
        booksView.filter = f.key; repaint(); marks();
      });
      chipBox.appendChild(c);
    });
    function marks() {
      Array.prototype.forEach.call(sortBox.children, function (x, i) {
        x.classList.toggle('on', BOOK_SORTS[i].key === booksView.sort);
      });
      Array.prototype.forEach.call(chipBox.children, function (x, i) {
        x.classList.toggle('on', BOOK_FILTERS[i].key === booksView.filter);
      });
    }
    box.appendChild(inp);
    box.appendChild(sortBox);
    box.appendChild(chipBox);
    return box;
  }

  function miniBtn(label, tone, onTap) {
    const b = h('button.bh-btn' + (tone ? '.' + tone : ''), { type: 'button', text: label });
    b.addEventListener('click', function () { haptic('light'); onTap(); });
    return b;
  }

  /* 封面长按 → 封面菜单（保存到相册 / 看大图 / 重画）。
     封面上要把事件止住，否则松手时卡片自己的长按菜单也会弹出来（两个菜单叠在一起）。 */
  function bindCoverMenu(el, n) {
    const hh = hold(el, function () {
      if (window.MZBook && window.MZBook.coverSheet) window.MZBook.coverSheet(n);
    });
    ['touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach(function (ev) {
      el.addEventListener(ev, function (e) { e.stopPropagation(); }, { passive: true });
    });
    /* 点封面 = 点这张卡片：直接进这本书（以前点封面弹的是封面菜单，很反直觉）。
       封面菜单挪到「长按封面」和封面右上角「⋯」里。 */
    el.addEventListener('click', function (e) {
      e.stopPropagation();
      if (hh.swallow()) return;
      haptic('light');
      openBook(n.id);
    });
  }

  function bookCard(n) {
    const live = state.live || {};
    const running = (live.books || []).filter(function (b) { return b.id === n.id; })[0] || null;
    const need = planNeed(n), made = planMade(n);
    const daily = (n.plan && n.plan.daily) || n.daily_count || 0;
    const picked = !!booksSel.ids[n.id];
    const el = h('div.book' + (running ? '.running' : '') + (picked ? '.picked' : ''));
    let cv;
    if (n.cover_url) {
      cv = h('img.cover', { src: MZ.img(n.cover_url), alt: '', decoding: 'async', loading: 'lazy',
        onerror: function (e) {
          const im = e && e.currentTarget;
          if (im && im.parentNode) {
            /* 图片加载失败会换成占位块：换了也得把长按菜单一并挂上，否则封面就点不动了 */
            const d2 = h('div.cover', { text: (n.title || '书').slice(0, 1) });
            bindCoverMenu(d2, n);
            im.parentNode.replaceChild(d2, im);
          }
        } });
    } else {
      cv = h('div.cover', { text: (n.title || '书').slice(0, 1) });
    }
    bindCoverMenu(cv, n);
    el.appendChild(cv);
    const main = h('div.bk-main');
    main.appendChild(h('div.bk-top', null,
      h('div', null,
        h('div.bk-title', { text: n.title || '未命名' }),
        h('div.bk-cat', { text: [n.category, n.author].filter(Boolean).join(' · ') || '未分类' })),
      running ? h('span.live-dot') : (n.busy ? chip('队列中', 'warn') : null)));
    main.appendChild(h('div.bk-meta', null,
      chip((n.chapter_count || 0) + ' 章'),
      chip(fmtNum(n.total_chars || 0) + ' 字'),
      n.pinned ? chip('置顶', 'blue') : null,
      n.weak_count ? chip(n.weak_count + ' 弱章', 'warn') : null,
      hasOutline(n) ? null : chip('缺大纲', 'warn')));
    main.appendChild(h('div.bk-foot', null,
      barOf(daily ? (made / daily) * 100 : 0, need ? 'warn' : 'ok'),
      h('span.tiny.muted.num', { text: '今日 ' + made + '/' + daily })));
    if (running && running.phase) main.appendChild(h('div.op-note', { text: running.phase + (running.current_idx ? ' · 第 ' + running.current_idx + ' 章' : '') }));
    el.appendChild(main);

    if (booksSel.mode) {
      el.appendChild(h('div.bk-pick' + (picked ? '.on' : ''), null, picked ? icon('check', { size: 15, w: 2.8 }) : null));
      el.addEventListener('click', function () {
        haptic('light');
        if (booksSel.ids[n.id]) delete booksSel.ids[n.id];
        else booksSel.ids[n.id] = true;
        render();
      });
      return el;
    }

    /* 「⋯」和长按都给同一个操作菜单：删书不用先点进作品页 */
    const dot = h('button.bk-dot', { type: 'button', 'aria-label': '《' + (n.title || '') + '》的操作' },
      icon('more', { size: 16 }));
    dot.addEventListener('click', function (e) { e.stopPropagation(); haptic('light'); bookMore(n); });
    el.appendChild(dot);

    let hold = null, held = false;
    el.addEventListener('touchstart', function () {
      held = false;
      if (hold) clearTimeout(hold);
      hold = setTimeout(function () { hold = null; held = true; haptic('medium'); bookMore(n); }, 480);
    }, { passive: true });
    const dropHold = function () { if (hold) { clearTimeout(hold); hold = null; } };
    el.addEventListener('touchend', dropHold);
    el.addEventListener('touchmove', dropHold);
    el.addEventListener('touchcancel', dropHold);
    el.addEventListener('click', function () {
      if (held) { held = false; return; }
      haptic('light'); openBook(n.id);
    });
    return el;
  }

  function bookMore(n) {
    if (window.MZBook && window.MZBook.moreSheet) { window.MZBook.moreSheet(n.id); return; }
    actions([
      { label: '打开作品页', icon: 'book', onPick: function () { openBook(n.id); } },
      { label: n.pinned ? '取消置顶' : '置顶到书架最前', icon: 'star', onPick: function () { setPinned([n.id], !n.pinned); } },
      { label: 'AI 根据书名写大纲', icon: 'spark', sub: hasOutline(n) ? '会覆盖现有大纲，先给你看再采纳' : '这本书还没有大纲',
        onPick: function () { if (window.MZBook && window.MZBook.aiOutline) window.MZBook.aiOutline(n); } },
      { label: '保存封面', icon: 'download', onPick: function () {
        if (window.MZBook && window.MZBook.saveCover) window.MZBook.saveCover(n); } },
      { label: '删除作品', icon: 'trash', danger: true, sub: '进回收站，可恢复', onPick: function () { removeNovels([n.id]); } },
    ], { title: n.title || '作品' });
  }

  /* 批量置顶 / 取消置顶：一本一次 PUT，单本失败不打断整批 */
  async function setPinned(ids, on) {
    ids = (ids || []).map(Number).filter(function (x) { return !!x; });
    if (!ids.length) return 0;
    const bs = busySheet(on ? '正在置顶…' : '正在取消置顶…');
    let done = 0;
    for (let i = 0; i < ids.length; i++) {
      try { await api.put('/api/novel/' + ids[i], { pinned: on ? 1 : 0 }); done++; }
      catch (e) { /* 单本失败继续 */ }
    }
    bs.close();
    toast(done ? ((on ? '已置顶 ' : '已取消置顶 ') + done + ' 本') : '操作失败', done ? 'ok' : 'bad');
    if (done) haptic('success');
    booksSel.mode = false; booksSel.ids = {};
    await loadHero();
    render();
    return done;
  }

  /* 删作品：二次确认 → 一本一次 DELETE（进回收站）→ 单本失败不打断整批 */
  async function removeNovels(ids, prompt) {
    ids = (ids || []).map(Number).filter(function (x) { return !!x; });
    if (!ids.length) return 0;
    const ok = await confirm(prompt || ('删除这 ' + ids.length + ' 本书？正文会一起放进回收站，之后还能恢复。'),
      { title: '删除作品', danger: true, okText: '删除' });
    if (!ok) return 0;
    const bs = busySheet('正在删除…');
    let done = 0;
    for (let i = 0; i < ids.length; i++) {
      try { await api.del('/api/novel/' + ids[i]); done++; }
      catch (e) { /* 单本失败继续删下一本 */ }
    }
    bs.close();
    toast(done ? ('已删除 ' + done + ' 本，可在「我的 → 回收站」恢复') : '删除失败', done ? 'ok' : 'bad');
    if (done) haptic('success');
    booksSel.mode = false; booksSel.ids = {};
    await loadHero();
    render();
    return done;
  }

  async function removeSelected() {
    const ids = pickedIds();
    if (!ids.length) return;
    const names = ids.map(novelTitleOf);
    await removeNovels(ids,
      '删除选中的 ' + ids.length + ' 本书？\n' + names.slice(0, 5).join('、') + (names.length > 5 ? ' 等' : '') +
      '\n正文会一起放进回收站，之后能在「我的 → 回收站」里恢复。');
  }

  function openBook(nid) {
    if (window.MZBook && window.MZBook.open) { window.MZBook.open(nid); return; }
    toast('作品页组件没加载出来，退出重进一次试试', 'bad');
  }

  /* ============================== 动作 ============================== */
  /* 长操作统一入口：补更 / 重写 / 体检 / 今日更新。
     以前这里有两个毛病，用户的原话是「写文章总是没开始写」「开始写的时候
     总是自动刷新，有种跳感」：
       1) 只等服务器回话，手指到反馈之间是一段空窗 —— 现在跟写作台里的长操作
          一样，手指一落先在本地登记一条任务条占位（服务器那条露面后自动接棒）；
       2) 收尾无条件 render()，整屏重画 + 滚动归零 —— 现在只重画任务条，当前这一屏
          不动，滚动位置自然也就不会被甩回页首。 */
  async function startJob(path, okMsg, body, opts) {
    opts = opts || {};
    const token = pending(opts.op || okMsg || '正在跑', { match: opts.match });
    try {
      const res = await api.post(path, body || {}, opts.timeout ? { timeout: opts.timeout } : undefined);
      toast((res && res.msg) || okMsg || '已开始', 'ok');
      haptic('success');
      await refreshLive();
      pendingDone(token);
      if (!opts.silent) loadHero().catch(function () { });
      if (opts.repaint) opts.repaint();
      else if (state.tab === 'jobs') render({ keepScroll: true });
      return res;
    } catch (e) {
      pendingDrop(token);
      toast(e.message, 'bad');
      return null;
    }
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
      const cnt = isFinite(c) && c > 0 ? c : (need || 1);
      const book = n.title || '';
      startJob('/api/novel/' + n.id + '/update', '已开始补更，正在写作',
        { count: isFinite(c) && c > 0 ? c : undefined },
        { op: '补更《' + book + '》' + cnt + ' 章', match: '^补更《' + reEsc(book) + '》' });
    });
  }
  function askRewrite(n) {
    modal({
      title: '重写《' + (n.title || '') + '》',
      text: '会重写前面若干章，原内容先存档、可回滚。填章数：',
      input: 'number', value: 5, okText: '开始重写', danger: true,
    }).then(function (v) {
      if (v === null) return;
      const cnt = parseInt(v, 10) || 5;
      const book = n.title || '';
      startJob('/api/novel/' + n.id + '/rewrite', '已开始重写', { count: cnt },
        { op: '重写《' + book + '》' + cnt + ' 章', match: '^重写《' + reEsc(book) + '》' });
    });
  }
  async function bookHitReview(n) {
    const ok = await confirm('对《' + (n.title || '') + '》做全书爆款体检？会按抽样方式让多个模型评分，耗时较长。',
      { okText: '开始体检' });
    if (!ok) return;
    const book = n.title || '';
    startJob('/api/novel/' + n.id + '/hit_review', '体检完成', { scope: 'sample' },
      { timeout: 300000, op: '爆款质检《' + book + '》', match: '^爆款质检《' + reEsc(book) + '》' });
  }
  async function exportNovel(n) {
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
  function newNovelMenu() {
    actions([
      { label: '选频道类型，AI 写大纲', icon: 'spark', sub: '男频 / 女频 · 选好类型，AI 出简介·大纲·人物，满意再建书', onPick: function () { newNovel(); } },
      { label: '粘贴整本书导入', icon: 'file', sub: '按「第 N 章」自动切章，适合搬已经写完的稿子', onPick: function () { importNovel(); } },
    ], { title: '新建作品' });
  }

  /* 新建作品：先选男频/女频 → 选类型 → 可选地让 AI 写大纲（简介/大纲/人物），满意再建书。
     手机端的抽屉是单例：生成时要先把抽屉让出去，好了再把表单重开（所以输入都存进 st）。 */
  async function newNovel() {
    const B = window.MZBook;
    if (!B || !B.picker || !B.field) { toast('界面组件没加载出来，退出重进一次试试', 'bad'); return; }
    if (!state.profile) { try { await loadProfile(); } catch (e) { /* 拿不到就让用户自己填 */ } }
    const st = { title: '', author: '', chan: '', cat: '', idea: '', plan: null };

    /* AI 给的方案先给作者过一眼，点「创建这本书」才写进去 */
    function planBox(plan) {
      const box = h('div.plan-box');
      box.appendChild(h('div.section-title', { text: 'AI 方案（点「创建这本书」才写进去）' }));
      if (plan.warn) {
        box.appendChild(h('div.card.tight.small', { text: '提示：' + plan.warn }));
      }
      if (plan.tags && plan.tags.length) {
        box.appendChild(h('div.chips.mt12', null, plan.tags.map(function (t) { return chip(String(t)); })));
      }
      if (plan.check) {
        box.appendChild(h('div.card.tight.small.mt12', null,
          h('b', { text: '贴合你给的方向：' }), h('span', { text: plan.check })));
      }
      if (plan.alt) {
        box.appendChild(h('div.fld-hint', { text: '模型本来想叫《' + plan.alt + '》，书名还是按你填的来。' }));
      }
      box.appendChild(h('div.card.tight.small.pre-wrap', { text: plan.intro || '（这次没给简介）' }));
      box.appendChild(h('div.section-title', null,
        h('span', { text: '三幕大纲' }),
        h('span.sp', { text: (plan.main || '').length + ' 字' })));
      box.appendChild(h('div.card.tight.small.pre-wrap', { text: plan.main || '（这次没给大纲）' }));
      if (plan.characters) {
        box.appendChild(h('div.section-title', { text: '人物' }));
        box.appendChild(h('div.card.tight.small.pre-wrap', { text: plan.characters }));
      }
      const chs = plan.chapters || [];
      if (chs.length) {
        box.appendChild(h('div.section-title', null, h('span', { text: '前 ' + chs.length + ' 章章纲' })));
        const l = h('div.list');
        chs.forEach(function (c, i) {
          l.appendChild(li({ title: chapTitle(c, i), sub: c.brief || '' }));
        });
        box.appendChild(h('div.plan-scroll', null, l));
      }
      return box;
    }

    function openSheet() {
      sheet({
        title: '新建作品',
        build: function (b, close) {
          b.appendChild(h('div.fld-hint', { text: '先选频道和类型，再填个书名。想让 AI 先出简介 / 大纲 / 人物，点「AI 写大纲」，满意了再点「创建这本书」。' }));
          const fTitle = B.field('书名', st.title, { ph: '书名' });
          const fAuthor = B.field('作者', st.author || myName(), {
            ph: '笔名 / 你的名字',
            hint: '作者名会印在 AI 封面和导出的 txt 上；建完也能在「编辑资料」里改。',
          });
          const picker = B.picker(st.chan, st.cat);
          const fIdea = B.field('一句话方向', st.idea, {
            ph: '如：退伍兵回村搞养殖（可留空）',
            hint: '留空也行，AI 会在你选的频道和类型里自己挑一个题。',
          });
          b.appendChild(fTitle.node);
          b.appendChild(fAuthor.node);
          b.appendChild(picker.node);
          b.appendChild(fIdea.node);
          if (st.plan) {
            const chs = st.plan.chapters || [];
            b.appendChild(h('div.fld-hint', { text: 'AI 方案已就绪：'
              + '简介 / 三幕大纲 / 人物 / 前 ' + chs.length + ' 章章纲。'
              + '不对就点「按我的方向重写」，满意再点「创建这本书」。' }));
          }
          const pv = st.plan ? planBox(st.plan) : null;
          if (pv) b.appendChild(pv);

          function mkBtn(label, tone, onTap) {
            const el = h('button.btn' + (tone ? '.' + tone : ''), { type: 'button', text: label });
            el.addEventListener('click', function () { haptic('light'); onTap(el); });
            return el;
          }
          const row = h('div.btn-row');
          row.appendChild(mkBtn(st.plan ? (st.idea ? '按我的方向重写' : '重新写一份') : 'AI 写大纲', 'blue', async function () {
            st.title = fTitle.value().trim();
            st.author = fAuthor.value().trim();
            st.chan = picker.channel(); st.cat = picker.category();
            st.idea = fIdea.value().trim();
            close();
            const bs = busySheet('AI 正在构思大纲…');
            try {
              const r = await api.post('/api/idea', {
                idea: st.idea, title: st.title, channel: st.chan,
                category: st.cat || '都市', count: 20, create: 0,
              }, { timeout: 300000 });
              bs.close();
              st.plan = {
                title: r.title || '', intro: r.intro || '', characters: r.characters || '',
                main: r.outline || '', chapters: r.chapters || [], alt: r.alt_title || '',
                tags: r.tags || [], check: r.direction_check || '', warn: r.warn || '',
              };
              if (!st.title && st.plan.title) st.title = st.plan.title;
              haptic('success');
              openSheet();
              toast(r.warn ? 'AI 方案好了，方案里有一条提示' : 'AI 方案已就绪，看看满意不', 'ok');
            } catch (e) { bs.close(); toast(e.message, 'bad'); openSheet(); }
          }));
          if (pv) {
            pv.hidden = false;
            row.appendChild(mkBtn('收起 AI 方案', '', function (el) {
              pv.hidden = !pv.hidden;
              el.textContent = pv.hidden ? '看看 AI 方案' : '收起 AI 方案';
            }));
          }
          row.appendChild(mkBtn('创建这本书', 'primary', async function () {
            st.title = fTitle.value().trim();
            st.author = fAuthor.value().trim();
            st.chan = picker.channel(); st.cat = picker.category();
            if (!st.title) { toast('先填个书名', 'bad'); return; }
            close();
            const bs = busySheet('正在创建…');
            const body = { title: st.title, channel: st.chan, category: st.cat, author: st.author };
            if (st.plan) {
              const chs = st.plan.chapters || [];
              body.intro = st.plan.intro;
              body.characters = st.plan.characters;
              body.outline = st.plan.main + (chs.length
                ? '\n\n【章纲】\n' + chs.map(function (c) { return (c.title || '') + '：' + (c.brief || ''); }).join('\n')
                : '');
            }
            let nid = 0;
            try {
              const res = await api.post('/api/novels', body);
              nid = (res && res.novel && res.novel.id) || (res && res.id) || 0;
              bs.close();
            } catch (e) { bs.close(); toast(e.message, 'bad'); return; }
            toast('已创建《' + st.title + '》', 'ok');
            haptic('success');
            await loadHero();
            await refreshLive();
            go('books'); render();
            if (!nid) return;
            if (!st.plan && window.MZBook && window.MZBook.aiOutline) {
              const novel = findNovel(nid) || { id: nid, title: st.title, category: st.cat, channel: st.chan, intro: '' };
              const want = await confirm(
                '《' + st.title + '》建好了。\n现在让 AI 根据书名写大纲？（简介 + 三幕大纲 + 人物 + 前 20 章章纲；生成后先给你看，点「采纳」才写进去）',
                { okText: '写大纲', cancelText: '先不用' });
              if (want) window.MZBook.aiOutline(novel, { silent: true });
            }
            openBook(nid);
          }));
          b.appendChild(row);
        },
      });
    }
    openSheet();
  }

  /* 粘贴导入：手机选不到本地文件，所以改成把整本书粘进来，后端按「第N章」切章 */
  function importNovel() {
    const B = window.MZBook;
    if (!B || !B.field) { toast('导入组件没加载出来，退出重进一次试试', 'bad'); return; }
    const title = B.field('书名', '', { ph: '不填就自动取一个名字' });
    const author = B.field('作者', myName(), { ph: '笔名 / 你的名字', hint: '作者名会印在 AI 封面和导出的 txt 上。' });
    const text = B.field('正文', '', {
      area: true, rows: 10, ph: '把整本书粘到这里',
      hint: '按「第 N 章」自动切章；没有章节标记就当作第 1 章。导入后默认不参与「今日自动更新」。',
    });
    sheet({
      title: '粘贴导入',
      build: function (b, close) {
        b.appendChild(h('div.small.muted', { text: '适合把已经写好的稿子搬进来。粘的字数很多的话，手机可能要转一会儿。' }));
        b.appendChild(title.node);
        b.appendChild(author.node);
        b.appendChild(text.node);
        b.appendChild(buttons([
          { label: '导入这本书', tone: 'primary', onTap: async function () {
            const t = text.value().trim();
            if (!t) { toast('先把正文粘进来', 'bad'); return; }
            close();
            const bs = busySheet('正在导入…');
            try {
              const r = await api.post('/api/novel/import', {
                text: t, title: title.value().trim(), author: author.value().trim(),
              }, { timeout: 180000 });
              bs.close();
              toast((r && r.msg) || '导入完成', 'ok');
              haptic('success');
              await loadHero();
              go('books'); render();
              if (r && r.id) setTimeout(function () { openBook(r.id); }, 240);
            } catch (e) { bs.close(); toast(e.message, 'bad'); }
          } },
        ]));
      },
    });
  }

  async function runDaily() {
    const ok = await confirm('立刻执行一次「今日自动更新」？会给所有启用的作品按每日章数补更，耗时可能很长。', { okText: '开始' });
    if (!ok) return;
    startJob('/api/run_daily', '已开始今日自动更新', {},
      { timeout: 120000, op: '今日自动更新', match: '^补更《' });
  }
  async function stopAll() {
    const ok = await confirm('停止全部任务？当前这一章写完后就会停下，已写好的会保留。', { danger: true, okText: '停止全部' });
    if (!ok) return;
    try {
      const r = await api.post('/api/stop_all');
      toast((r && r.msg) || '已请求停止', 'ok');
      await refreshLive();
      render({ keepScroll: true });
    } catch (e) { toast(e.message, 'bad'); }
  }

  /* ============================== 全局任务条（#opsDock） ==============================
     服务端会给每个长操作登记一条 ops（第几步 / 什么阶段 / 已用时 / 模型排队），
     这里把它画成挂在 body 上的 fixed 任务条。因为它不属于任何一屏的 DOM，
     所以切标签页、翻页、开关写作台、甚至重开 App 都不会把进度弄丢。

     这一版把状态机补全，专治五个体感毛病：
     1) 按了按钮半天没动静 —— 手指一落就在本地登记一条「排队中」，不等 /api/live 回来。
        旧版只在服务端一条 ops 都没有时才显示本地占位，别处有任务在跑就完全不反馈。
     2) 同一条任务显示成两行 —— 本地占位与服务端条目按标题匹配去重（match 由调用方给），
        服务端条目一露面（例：合规预检 · 第12章）本地这条立刻让位，不重复也不闪断。
     3) 进度与「已用时」卡住 —— 600ms 本地节拍器只重绘数字和进度条，取数仍走 /api/live，
        两次轮询之间用时照常往上走；进度只进不退。
     4) 跑完了还挂着一个 100% 的条 —— 全部结束显示「已完成」，4 秒后自动收起；
        失败的条目不会被收走：标红留在那里，等用户点「知道了」。
     5) 多条任务时标题来回跳 —— 固定排序（失败 → 进行中 → 完成），组内按开始时间。 */
  const OPS_OPEN_KEY = 'mz_ops_open';
  const OPS_TICK_MS = 600;
  const OPS_GRACE = 5000;        /* 请求已返回、服务端条目还没露面的宽限（要大于一次轮询间隔） */
  const OPS_STALE = 120000;      /* 本地占位最多挂 2 分钟，免得网络卡死时一直转 */
  const OPS_LINGER = 4200;       /* 全部跑完后自动收起的等待 */

  let localOps = [];             /* 本地占位：按钮已按下、服务端 ops 还没露面 */
  let localSeq = 1;
  let liveAt = 0;                /* 最近一次 /api/live 成功的时刻（用来推算用时） */
  let pctMemo = {};              /* key -> {v, started}：显示过的最大百分比，只进不退 */
  let acked = {};                /* 用户点过「知道了」的条目：key -> 时间戳 */
  let hideAt = 0;                /* 全部跑完后的自动收起时刻 */
  let tickTimer = null;
  let dockOpen = false;
  let failSig = '';
  try { dockOpen = localStorage.getItem(OPS_OPEN_KEY) === '1'; } catch (e) { /* 忽略 */ }

  function opsTickOn() {
    if (tickTimer) return;
    tickTimer = setInterval(function () { paintOps(); }, OPS_TICK_MS);
  }
  function opsTickOff() {
    if (!tickTimer) return;
    clearInterval(tickTimer); tickTimer = null;
  }
  function setDockOpen(on) {
    dockOpen = !!on;
    try { localStorage.setItem(OPS_OPEN_KEY, dockOpen ? '1' : '0'); } catch (e) { /* 忽略 */ }
  }
  /* 登记一条本地占位：label 是给人看的，match 是拿服务端标题去重用的正则源码 */
  function pending(label, opts) {
    opts = opts || {};
    let re = null;
    try { if (opts.match) re = new RegExp(String(opts.match)); } catch (e) { re = null; }
    const t = { id: localSeq++, label: label || '正在跑', re: re, t0: Date.now(), doneAt: 0, pct: 3 };
    localOps.push(t);
    if (localOps.length > 8) localOps = localOps.slice(-8);
    hideAt = 0;
    paintOps(); opsTickOn();
    return t;
  }
  function pendingDone(t) {
    if (!t) return;
    t.doneAt = Date.now();       /* 不立刻删：服务端条目可能还在路上，先走宽限期 */
    paintOps();
  }
  /* 请求失败时把本地占位撒掉：别留一条一直在转的假进度骗人 */
  function pendingDrop(t) {
    if (!t) return;
    localOps = localOps.filter(function (x) { return x !== t; });
    paintOps();
  }
  function ackOp(key) {
    acked[key] = Date.now();
    const ks = Object.keys(acked);
    if (ks.length > 80) {
      ks.sort(function (a, b) { return acked[a] - acked[b]; })
        .slice(0, ks.length - 60).forEach(function (k) { delete acked[k]; });
    }
    hideAt = 0;
    paintOps();
  }
  /* 服务端给的是「快照那一刻」的百分比 + 爬升速度（%/秒）。
     两次轮询之间照这个速度自己往前推：数字一直在动，又不会越过 99.5%
     （没完成就不许显示 100%），所以不会再出现「点完半天不动，然后一下跳过去」。 */
  function creepPct(pct, rate, running) {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    const r = Math.max(0, Number(rate) || 0);
    const dt = liveAt ? Math.max(0, (Date.now() - liveAt) / 1000) : 0;
    return Math.min(running ? 99.5 : 100, p + r * dt);
  }
  /* 进度只进不退；同一个 key 换了一次新运行（started 变了）就重新计 */
  function pctKeep(key, pct, started) {
    const v = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    const cur = pctMemo[key];
    if (!cur || cur.started !== started) { pctMemo[key] = { v: v, started: started }; return v; }
    if (cur.v > v) return cur.v;
    cur.v = v;
    return v;
  }
  function titleHit(t, title) {
    if (!title) return false;
    if (t.re) { try { return t.re.test(title); } catch (e) { return false; } }
    return String(title).indexOf(t.label) === 0;
  }
  function opsAll() {
    const live = state.live || {};
    const now = Date.now();
    const drift = liveAt ? Math.max(0, (now - liveAt) / 1000) : 0;
    const out = [];

    Object.keys(live.ops || {}).forEach(function (k) {
      const o = live.ops[k] || {};
      if (acked[k]) return;
      const started = Number(o.started_at) || 0;
      out.push({
        key: k, title: o.title || k, phase: o.phase || '', note: o.note || '',
        pct: creepPct(pctKeep(k, o.pct || 0, started), o.rate, !o.finished),
        elapsed: Math.round((o.elapsed || 0) + (o.finished ? 0 : drift)),
        steps: o.steps || [], step: o.step || 0,
        finished: !!o.finished, ok: o.ok !== false, error: o.error || '',
        started: started, local: false,
      });
    });
    /* 后端把「写作任务」登记在 jobs 里（没有 ops 条目）时也要看得见 */
    /* j.message 整章都不变（「正在写第 16 章」），光看它会以为卡住了；
       接力一下这本书在 live.books 里的实时 phase（策划/写作/审查/润色），
       任务条上的字才会一直在动。 */
    const liveBooks = live.books || [];
    (state.liveJobs || live.jobs || []).forEach(function (j) {
      const k = 'job:' + j.id;
      if (acked[k]) return;
      const b = liveBooks.filter(function (x) { return Number(x.id) === Number(j.novel_id); })[0] || null;
      const where = (b && Number(b.current_idx)) ? ('第 ' + b.current_idx + ' 章') : '';
      const what = (b && b.phase) ? b.phase : (j.message || '');
      out.push({
        key: k, title: j.title || j.kind || '任务',
        phase: [where, what].filter(Boolean).join(' ') || (j.status || ''),
        note: '', pct: creepPct(j.total ? ((j.done || 0) * 100) / j.total : (live.pct || 0),
          (b && b.rate) || 0, true),
        elapsed: live.running ? (live.elapsed || 0) : 0,
        steps: [], step: 0, finished: false, ok: true, error: '',
        started: 0, local: false,
      });
    });
    /* 只有「写作总进度」在跑、又没有单独的 ops 条目时，兜一条总的 */
    if (live.running && !out.length) {
      out.push({
        key: 'main', title: live.job_title || '正在生成', phase: phaseLine(live),
        note: '', pct: live.pct || 0, elapsed: live.elapsed || 0,
        steps: [], step: 0, finished: false, ok: true, error: '',
        started: 0, local: false,
      });
    }
    /* 本地占位：服务端一出现匹配条目就让位（把进度过继过去，进度条不会回退） */
    const keep = [];
    localOps.forEach(function (t) {
      let hit = null;
      for (let i = 0; i < out.length; i++) {
        if (titleHit(t, out[i].title)) { hit = out[i]; break; }
      }
      if (hit) { hit.pct = pctKeep(hit.key, Math.max(hit.pct, t.pct), hit.started); return; }
      if (t.doneAt && (!t.re || now - t.doneAt > OPS_GRACE)) return;
      if (now - t.t0 > OPS_STALE) return;
      keep.push(t);
    });
    localOps = keep;
    localOps.forEach(function (t) {
      const sec = (now - t.t0) / 1000;
      t.pct = pctKeep('local:' + t.id, Math.min(12, 3 + sec * 0.5), t.t0);
      out.push({
        key: 'local:' + t.id, title: t.label,
        phase: t.doneAt ? '正在整理结果…'
          : (sec < 6 ? '已发出，正在排队…' : '服务器还在处理，稍等…'),
        note: '', pct: t.pct, elapsed: Math.round(sec),
        steps: [], step: 0, finished: false, ok: true, error: '',
        started: t.t0, local: true,
      });
    });

    /* 固定排序：失败 → 进行中 → 完成；同组按开始时间，本地占位放最后 */
    out.sort(function (a, b) {
      const ra = a.finished ? (a.ok ? 2 : 0) : 1;
      const rb = b.finished ? (b.ok ? 2 : 0) : 1;
      if (ra !== rb) return ra - rb;
      if (a.local !== b.local) return a.local ? 1 : -1;
      if ((a.started || 0) !== (b.started || 0)) return (a.started || 0) - (b.started || 0);
      return String(a.key) < String(b.key) ? -1 : (String(a.key) > String(b.key) ? 1 : 0);
    });
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
    if (o.finished && !o.ok) {
      const b = h('button.btn.sm', { type: 'button', text: '知道了' });
      b.addEventListener('click', function () { haptic('light'); ackOp(o.key); });
      row.appendChild(h('div.btn-row', null, b));
    }
    return row;
  }
  function paintOps() {
    const dock = $('#opsDock');
    if (!dock) return;
    const list = opsAll();
    const body = $('#odBody');
    const t = $('#odTitle'), sub = $('#odSub'), pct = $('#odPct'), fill = $('#odFill');

    if (!list.length) {
      opsTickOff(); hideAt = 0; failSig = '';
      dock.hidden = true; dock.classList.remove('on');
      if (body) { body.hidden = true; clear(body); }
      if (t) t.textContent = '';
      if (sub) sub.textContent = '';
      if (pct) pct.textContent = '0%';
      if (fill) fill.style.width = '0%';
      return;
    }
    opsTickOn();

    const running = list.filter(function (o) { return !o.finished; });
    const failed = list.filter(function (o) { return o.finished && !o.ok; });

    /* 全部结束：成功的那批显示一会儿自动收起，失败的那批留着等用户确认 */
    if (!running.length && !failed.length) {
      if (!hideAt) hideAt = Date.now() + OPS_LINGER;
      if (Date.now() >= hideAt) {
        list.forEach(function (o) { acked[o.key] = Date.now(); });
        opsTickOff(); hideAt = 0;
        dock.hidden = true; dock.classList.remove('on');
        if (body) { body.hidden = true; clear(body); }
        return;
      }
    } else {
      hideAt = 0;
    }

    /* 冒出新的失败：自动展开一次，让用户当场看到原因 */
    const fsig = failed.map(function (o) { return o.key; }).join(',');
    if (fsig && fsig !== failSig) { failSig = fsig; dockOpen = true; }
    if (!fsig) failSig = '';

    const head = running[0] || failed[0] || list[0];
    const multi = running.length > 1;
    dock.hidden = false;
    if (t) {
      t.textContent = multi ? ('正在跑 ' + running.length + ' 项')
        : (running.length ? (head.title || '正在跑')
          : (failed.length ? ('有 ' + failed.length + ' 项失败') : '已完成'));
    }
    if (sub) {
      sub.textContent = running.length
        ? (multi ? (head.title + ' · ' + (head.phase || '进行中')) : (head.phase || head.note || '正在准备\u2026'))
        : (failed.length ? '点开看原因' : (head.phase || '全部完成'));
    }
    if (pct) pct.textContent = Math.round(head.pct || 0) + '%';
    if (fill) fill.style.width = Math.max(2, Math.min(100, head.pct || 0)) + '%';

    dock.classList.toggle('on', dockOpen);
    if (body) {
      if (dockOpen) {
        const keepTop = body.scrollTop;
        clear(body);
        list.forEach(function (o) { body.appendChild(opsRowNode(o)); });
        body.hidden = false;
        body.scrollTop = keepTop;
      } else {
        body.hidden = true;
      }
    }
  }

  /* ============================== 活数据 ============================== */
  function paintDock() {
    const dock = $('#islandDock');
    if (!dock) return;
    const live = state.live || {};
    /* 灵动岛只回答「书写得怎么样了」。单纯的章节检查 / 评分不该在这里冒充写作进度，
       那些长操作交给底部那条全局任务条（#opsDock）显示，两条各有各的分工。 */
    /* 只有真的在跑才显示。以前只要 live.books 非空就显示，
       而服务端跑完后不会清 _books，结果顶部活灵岛一直挂着
       「补更《…》3 章 · 完成 · 0%」这种自相矛盾的残留。 */
    const activeJobs = (state.liveJobs || []).filter(function (j) {
      return j.status === 'running' || j.status === 'queued';
    }).length;
    const writing = !!(live.running || activeJobs);
    if (!writing) { dock.hidden = true; return; }
    const pct = creepPct(live.pct, live.rate, !!live.running);

    const t = $('#idTitle'), sb = $('#idSub'), pc = $('#idPct'), fl = $('#idFill');
    if (t) t.textContent = live.job_title || '正在跑';
    if (sb) sb.textContent = phaseLine(live);
    if (pc) pc.textContent = Math.round(pct) + '%';
    if (fl) fl.style.width = pct + '%';
    dock.hidden = false;
  }
  /* 两次 /api/live 之间把进度往前推：只改样式和文字，不重建 DOM，
     所以数字一直在动，又不会闪、不会跳、不会把进度环动画重播。 */
  function paintLiveSoft() {
    const live = state.live || {};
    if (!liveBusy(live)) return;
    const pct = creepPct(live.pct, live.rate, !!live.running);
    const hero = document.querySelector('.live-hero');
    if (hero) {
      const ringEl = hero.querySelector('.ring');
      if (ringEl) {
        ringEl.style.setProperty('--p', String(pct));
        const b = ringEl.querySelector('b');
        if (b) b.textContent = String(Math.round(pct));
      }
      const chipEl = hero.querySelector('.lh-top .chip');
      if (chipEl) chipEl.textContent = Math.round(pct) + '%';
      const fill = hero.querySelector('.lh-main .bar-fill');
      if (fill) fill.style.width = pct + '%';
      const bl = hero.querySelectorAll('.lb-bar .bar-fill');
      (live.books || []).forEach(function (b, i) {
        if (!bl[i]) return;
        bl[i].style.width = creepPct(b.pct, b.rate, (b.done || 0) < (b.need || 0)) + '%';
      });
      const cards = hero.querySelectorAll('.op-card');
      Object.keys(live.ops || {}).forEach(function (k, i) {
        const o = live.ops[k] || {}, card = cards[i];
        if (!card) return;
        const c = card.querySelector('.chip');
        if (!c) return;
        const t = o.ok === false ? '失败'
          : (o.finished ? '完成' : Math.round(creepPct(o.pct, o.rate, !o.finished)) + '%');
        if (c.textContent !== t) c.textContent = t;
      });
      const el = hero.querySelector('.lh-elapsed');
      if (el) {
        const sec = Math.round((live.elapsed || 0) + (liveAt ? (Date.now() - liveAt) / 1000 : 0));
        const t = live.elapsed ? ('已用时 ' + fmtDur(sec)) : '';
        if (el.textContent !== t) el.textContent = t;
      }
    }
    const fl = $('#idFill'), pc = $('#idPct');
    if (fl) fl.style.width = pct + '%';
    if (pc) pc.textContent = Math.round(pct) + '%';
  }

  function paintBadge() {
    const b = $('#badgeJobs');
    if (!b) return;
    const live = state.live || {};
    const q = live.queue || {};
    /* 角标要反映「一共还有几件事没跑完」：模型队列 + 正在跑的功能 + 排队中的写作任务，
       只看模型队列的话，跑一个不占模型的本地检查时角标是空的。 */
    const ops = live.ops || {};
    const opsN = Object.keys(ops).filter(function (k) { return !(ops[k] || {}).finished; }).length;
    const jobsN = (state.liveJobs || []).filter(function (j) {
      return j.status === 'running' || j.status === 'queued';
    }).length;
    const n = Math.max((q.active || 0) + (q.queued || (q.waiting || []).length || 0), opsN + jobsN);

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
      liveAt = Date.now();   /* 本地按时长推算「已用时」的基准点 */
      paintDock(); paintBadge(); paintOps();
      return state.live;
    } catch (e) {
      /* 断网也要重绘：本地占位还在走时，任务条不该跟着僵住 */
      paintDock(); paintOps(); return null;
    }

  }
  async function refreshAll(showToast) {
    try { await loadHero(); } catch (e) { if (showToast) toast(e.message, 'bad'); }
    await refreshLive();
    await loadProfile();
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
  /* 密码眼睛的两个图标 */
  const EYE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 12S6.2 5.8 12 5.8 21.4 12 21.4 12 17.8 18.2 12 18.2 2.6 12 2.6 12Z"/><circle cx="12" cy="12" r="3.2"/></svg>';
  const OFF_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 3.2 20.8 20.8"/><path d="M10.5 6.3A9.9 9.9 0 0 1 12 6.2c5.8 0 9.4 5.8 9.4 5.8a17.6 17.6 0 0 1-2.5 3.2"/><path d="M6.5 8A16.4 16.4 0 0 0 2.6 12s3.6 6.2 9.4 6.2a9.7 9.7 0 0 0 3.5-.7"/><path d="M9.9 9.9a3.2 3.2 0 0 0 4.3 4.3"/></svg>';

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
  async function doLogin(user, password) {
    const btn = $('#loginGo'), hint = $('#loginErr');
    if (btn) { btn.disabled = true; btn.textContent = '登录中…'; }
    if (hint) hint.hidden = true;
    try {
      /* 登录也走「入口自动切换」：域名入口被云厂商拦掉时会换备用入口重试 */
      const rp = await MZ.login(user, password);
      const r = rp.resp; const d = rp.data;
      if (r.ok && d && d.ok && d.token) {
        MZ.setSession(d.token);
        /* 登录响应里就带着资料，先摆上，免得"我的"页先空一下 */
        state.profile = {
          name: d.name || '', username: d.username || '', pen_name: d.pen_name || '', gender: d.gender || '',
          age: d.age || '', avatar: !!d.avatar, avatar_url: d.avatar_url || '',
          welcome: !!d.welcome, masked: d.masked || '', phone: d.phone || '',
        };
        showApp();
        /* 欢迎页先盖上来，书稿在后面照常载入；点一下或几秒后自己退场 */
        const wp = showWelcome();
        await refreshAll(false);
        wireApp();          /* 登录卡这条路以前不走 enterApp()，下拉刷新 / 右滑返回会一直缺着 */
        startTimer();
        await wp;
        return true;
      }
      throw new Error((d && (d.error || d.msg)) || '登录失败，请检查用户名和密码');
    } catch (e) {
      if (hint) { hint.hidden = false; hint.textContent = e.message || '连不上服务器，请检查网络后重试'; }
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
      const p = ($('#lgUser') || {}).value || '';
      const w = ($('#lgPass') || {}).value || '';
      if (!p.trim() || !w) {
        const e = $('#loginErr');
        if (e) { e.hidden = false; e.textContent = '请填写用户名和密码'; }
        return;
      }
      doLogin(p, w);
    });
    ['#lgUser', '#lgPass'].forEach(function (sel) {
      const el = $(sel);
      if (el) el.addEventListener('input', function () { const e = $('#loginErr'); if (e) e.hidden = true; });
    });
    const reg = $('#loginReg');
    if (reg) reg.addEventListener('click', function () {
      haptic('light');
      const e = $('#loginErr'); if (e) e.hidden = true;
      showRegister();
    });
    const fg = $('#loginForgot');
    if (fg) fg.addEventListener('click', function () {
      haptic('light');
      const e = $('#loginErr'); if (e) e.hidden = true;
      showForgot();
    });
    bindEye();
  }


  /* ============================== 手机号注册 ==============================
     登录卡下面点「没有账号？用手机号注册」进这里：手机号 → 短信验证码 → 设密码。
     验证码走服务器短信接口；测试模式下服务器会把验证码回显（debug_code），这里直接帮用户填上。 */
  function showRegister() {
    let timer = null;
    const mkInp = function (opt) {
      return h('input.inp', {
        type: opt.type || 'text', placeholder: opt.ph || '',
        inputmode: opt.inputmode || 'text', maxlength: opt.maxlength || '',
        autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
        autocomplete: opt.ac || 'off',
      });
    };
    const phoneInp = mkInp({ ph: '11 位手机号', inputmode: 'numeric', maxlength: '11', ac: 'tel' });
    const codeInp = mkInp({ ph: '6 位数字', inputmode: 'numeric', maxlength: '6', ac: 'one-time-code' });
    const pwInp = mkInp({ ph: '至少 8 位，别用纯数字', type: 'password', ac: 'new-password' });
    const pw2Inp = mkInp({ ph: '再输一遍', type: 'password', ac: 'new-password' });

    /* 密码眼睛：和登录页一样，怕输错就点开看一眼 */
    const eye = h('button.eye', { type: 'button', 'aria-label': '显示密码', title: '显示密码', html: EYE_SVG });
    eye.addEventListener('click', function () {
      const show = pwInp.type === 'password';
      pwInp.type = show ? 'text' : 'password';
      eye.innerHTML = show ? OFF_SVG : EYE_SVG;
      eye.className = 'eye' + (show ? ' on' : '');
    });

    const fPhone = h('div.fld', null, h('label', { text: '手机号' }), phoneInp);
    const capTip = h('div.fld-hint');
    const getBtn = h('button.btn.sm', { type: 'button', text: '获取验证码' });
    const fCode = h('div.fld', null, h('label', { text: '短信验证码' }),
      h('div.reg-cap', null, codeInp, getBtn));
    const fPw = h('div.fld', null, h('label', { text: '设置密码' }), h('div.pw', null, pwInp, eye));
    const fPw2 = h('div.fld', null, h('label', { text: '再输一遍密码' }), pw2Inp);

    getBtn.addEventListener('click', async function () {
      const ph = String(phoneInp.value || '').trim();
      if (!/^1\d{10}$/.test(ph)) { toast('手机号看起来不对（要 11 位）', 'bad'); return; }
      getBtn.disabled = true;
      getBtn.textContent = '发送中…';
      let d = null;
      try {
        const rp = await MZ.sms(ph);
        d = rp.data || {};
        if (!rp.resp.ok || d.ok === false) throw new Error(d.msg || d.error || '发送失败');
      } catch (e) {
        getBtn.disabled = false;
        getBtn.textContent = '获取验证码';
        toast((e && e.message) || '发送失败', 'bad');
        return;
      }
      if (d && d.debug_code) {
        capTip.textContent = '测试模式：验证码是 ' + d.debug_code + '（已帮你填上）';
        codeInp.value = d.debug_code;
      } else {
        capTip.textContent = (d && d.msg) || '验证码已发出，5 分钟内有效';
      }
      let n = 60;
      getBtn.textContent = n + ' 秒后重发';
      timer = setInterval(function () {
        n -= 1;
        if (n <= 0) {
          clearInterval(timer); timer = null;
          getBtn.disabled = false;
          getBtn.textContent = '重新获取';
        } else getBtn.textContent = n + ' 秒后重发';
      }, 1000);
    });

    const goBtn = h('button.btn.primary', { type: 'button', text: '注册并进入' });
    goBtn.addEventListener('click', async function () {
      const ph = String(phoneInp.value || '').trim();
      const code = String(codeInp.value || '').trim();
      const pw = String(pwInp.value || ''), pw2 = String(pw2Inp.value || '');
      if (!/^1\d{10}$/.test(ph)) { toast('手机号要 11 位，别漏了', 'bad'); return; }
      if (!code) { toast('先填短信验证码', 'bad'); return; }
      if (pw.length < 8) { toast('密码至少 8 位', 'bad'); return; }
      if (pw !== pw2) { toast('两次密码不一样', 'bad'); return; }
      goBtn.disabled = true;
      goBtn.textContent = '注册中…';
      let d = null;
      try {
        const rp = await MZ.register(ph, code, pw);
        d = rp.data || {};
        if (!rp.resp.ok || !d.ok) throw new Error(d.msg || d.error || '注册失败');
      } catch (e) {
        goBtn.disabled = false;
        goBtn.textContent = '注册并进入';
        toast((e && e.message) || '注册失败', 'bad');
        return;
      }
      if (timer) { clearInterval(timer); timer = null; }
      MZ.setSession(d.token || '');
      state.profile = {
        name: d.name || '', username: d.username || '', pen_name: d.pen_name || '', gender: d.gender || '',
        age: d.age || '', avatar: !!d.avatar, avatar_url: d.avatar_url || '',
        welcome: !!d.first_time,
      };
      if (regCtl) regCtl.close();
      haptic('success');
      toast('注册成功，欢迎你', 'ok');
      enterApp(true);
    });

    const rows = h('div');
    rows.appendChild(h('div.fld-hint', { text: '填手机号 → 收短信验证码 → 设个密码，就成了。新账号已经预置好模型 API Key，登进去就能开写。' }));
    rows.appendChild(fPhone);
    rows.appendChild(fCode);
    rows.appendChild(capTip);
    rows.appendChild(fPw);
    rows.appendChild(fPw2);
    const btns = h('div.btn-row');
    btns.appendChild(goBtn);
    const cancel = h('button.btn', { type: 'button', text: '还是去登录' });
    cancel.addEventListener('click', function () { haptic('light'); if (regCtl) regCtl.close(); });
    btns.appendChild(cancel);
    rows.appendChild(btns);

    regCtl = sheet({
      title: '手机号注册',
      node: rows,
      onClose: function () { if (timer) { clearInterval(timer); timer = null; } },
    });
  }
  let regCtl = null;

  /* ============================== 密码：忘记 / 修改 ==============================
     两条路共用一张表单（跟注册那张一个风格）：
       · 忘记密码 forgot：手机号 + 短信验证码（purpose=reset）+ 新密码；
       · 登录后改密码 change：旧密码，或者给本机号发一条 purpose=change 的验证码 + 新密码。
     密码规则跟服务端一致：至少 8 位、不能纯数字。改完服务端会作废别处的登录态，
     所以这里要把返回的新口令收下来，免得自己也被踢出去。 */
  function showPwSheet(opt) {
    const mode = opt && opt.mode === 'change' ? 'change' : 'forgot';
    let timer = null;
    const mk = function (o) {
      return h('input.inp', {
        type: o.type || 'text', placeholder: o.ph || '',
        inputmode: o.inputmode || 'text', maxlength: o.maxlength || '',
        autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
        autocomplete: o.ac || 'off',
      });
    };
    const phoneInp = mode === 'forgot' ? mk({ ph: '11 位手机号', inputmode: 'numeric', maxlength: '11', ac: 'tel' }) : null;
    const oldInp = mode === 'change' ? mk({ type: 'password', ph: '现在用的密码', ac: 'current-password' }) : null;
    const codeInp = mk({ ph: '6 位数字', inputmode: 'numeric', maxlength: '6', ac: 'one-time-code' });
    const pwInp = mk({ type: 'password', ph: '至少 8 位，别用纯数字', ac: 'new-password' });
    const pw2Inp = mk({ type: 'password', ph: '再输一遍新密码', ac: 'new-password' });

    /* 密码眼睛：跟登录页一样，怕输错就点开看一眼 */
    const eye = h('button.eye', { type: 'button', 'aria-label': '显示密码', title: '显示密码', html: EYE_SVG });
    eye.addEventListener('click', function () {
      const show = pwInp.type === 'password';
      pwInp.type = show ? 'text' : 'password';
      eye.innerHTML = show ? OFF_SVG : EYE_SVG;
      eye.className = 'eye' + (show ? ' on' : '');
    });

    const capTip = h('div.fld-hint');
    const getBtn = h('button.btn.sm', { type: 'button', text: '获取验证码' });
    const purpose = mode === 'forgot' ? 'reset' : 'change';

    getBtn.addEventListener('click', async function () {
      let ph = '';
      if (mode === 'forgot') {
        ph = String(phoneInp.value || '').trim();
        if (!/^1\d{10}$/.test(ph)) { toast('手机号看起来不对（要 11 位）', 'bad'); return; }
      }
      getBtn.disabled = true;
      getBtn.textContent = '发送中…';
      let d = null;
      try {
        /* 改密码模式：手机号由服务器按登录会话认，本地知道就顺手带上 */
        const who = mode === 'forgot' ? ph : ((state.profile && state.profile.phone) || '');
        const rp = await MZ.sms(who, purpose);
        d = rp.data || {};
        if (!rp.resp.ok || d.ok === false) throw new Error(d.msg || d.error || '发送失败');
      } catch (e) {
        getBtn.disabled = false;
        getBtn.textContent = '获取验证码';
        toast((e && e.message) || '发送失败', 'bad');
        return;
      }
      if (d && d.debug_code) {
        capTip.textContent = '测试模式：验证码是 ' + d.debug_code + '（已帮你填上）';
        codeInp.value = d.debug_code;
      } else {
        capTip.textContent = (d && d.msg) || '验证码已发出，5 分钟内有效';
      }
      let n = 60;
      getBtn.textContent = n + ' 秒后重发';
      timer = setInterval(function () {
        n -= 1;
        if (n <= 0) {
          clearInterval(timer); timer = null;
          getBtn.disabled = false;
          getBtn.textContent = '重新获取';
        } else getBtn.textContent = n + ' 秒后重发';
      }, 1000);
    });

    const goBtn = h('button.btn.primary', { type: 'button', text: '确定' });
    goBtn.addEventListener('click', async function () {
      const code = String(codeInp.value || '').trim();
      const pw = String(pwInp.value || ''), pw2 = String(pw2Inp.value || '');
      if (pw.length < 8) { toast('新密码至少 8 位', 'bad'); return; }
      if (pw !== pw2) { toast('两次密码不一样', 'bad'); return; }
      goBtn.disabled = true;
      goBtn.textContent = '提交中…';
      let d = null, rp = null;
      try {
        if (mode === 'forgot') {
          const ph = String(phoneInp.value || '').trim();
          if (!/^1\d{10}$/.test(ph)) throw new Error('手机号要 11 位，别漏了');
          if (!code) throw new Error('先填短信验证码');
          rp = await MZ.resetPassword(ph, code, pw, pw2);
        } else {
          const oldv = String(oldInp.value || '');
          if (!oldv && !code) throw new Error('填旧密码，或者发一条验证码');
          rp = oldv ? await MZ.changePassword(oldv, pw, pw2)
                    : await MZ.changePasswordByCode(code, pw, pw2);
        }
        d = rp.data || {};
        if (!rp.resp.ok || !d.ok) throw new Error(d.error || d.msg || '提交失败');
      } catch (e) {
        goBtn.disabled = false;
        goBtn.textContent = '确定';
        toast((e && e.message) || '提交失败', 'bad');
        return;
      }
      if (timer) { clearInterval(timer); timer = null; }
      /* 服务器改完密码会把老会话作废，这里收下新口令，自己不掉线 */
      if (d.token) MZ.setSession(d.token);
      if (mode === 'forgot' && d.name !== undefined) {
        state.profile = {
          name: d.name || '', username: d.username || '', pen_name: d.pen_name || '',
          gender: d.gender || '', age: d.age || '', avatar: !!d.avatar,
          avatar_url: d.avatar_url || '', welcome: !!d.first_time, masked: d.masked || '',
        };
      }
      if (ctl) ctl.close();
      haptic('success');
      if (mode === 'forgot') {
        toast('密码已改，欢迎回来', 'ok');
        enterApp(true);
      } else {
        toast('密码已改，别的地方要重新登录', 'ok');
        loadProfile().then(function () { render(); }, function () {});
      }
    });

    const rows = h('div');
    if (mode === 'forgot') {
      rows.appendChild(h('div.fld-hint', { text: '用注册时那个手机号收一条验证码，就能换个新密码；改完直接登进去。' }));
      rows.appendChild(h('div.fld', null, h('label', { text: '手机号' }), phoneInp));
      rows.appendChild(h('div.fld', null, h('label', { text: '短信验证码' }),
        h('div.reg-cap', null, codeInp, getBtn)));
    } else {
      rows.appendChild(h('div.fld-hint', { text: '填旧密码就行；要是忘了旧密码，给本机号发一条验证码也能改（两个填一个）。' }));
      rows.appendChild(h('div.fld', null, h('label', { text: '旧密码' }), oldInp));
      rows.appendChild(h('div.fld', null, h('label', { text: '短信验证码' }),
        h('div.reg-cap', null, codeInp, getBtn)));
    }
    rows.appendChild(capTip);
    rows.appendChild(h('div.fld', null, h('label', { text: '新密码' }),
      h('div.pw', null, pwInp, eye)));
    rows.appendChild(h('div.fld', null, h('label', { text: '再输一遍新密码' }), pw2Inp));
    const btns = h('div.btn-row');
    btns.appendChild(goBtn);
    const cancel = h('button.btn', { type: 'button', text: '取消' });
    cancel.addEventListener('click', function () { haptic('light'); if (ctl) ctl.close(); });
    btns.appendChild(cancel);
    rows.appendChild(btns);
    rows.appendChild(h('div.footnote', { text: '改完密码，别的手机 / 电脑上的登录状态会自动失效，要用新密码重新登。' }));

    var ctl = sheet({
      title: mode === 'forgot' ? '忘记密码' : '修改密码',
      node: rows,
      onClose: function () { if (timer) { clearInterval(timer); timer = null; } },
    });
  }

  function showForgot() { showPwSheet({ mode: 'forgot' }); }
  function showChangePw() { showPwSheet({ mode: 'change' }); }

  /* 密码眼睛：点一下在「•••」和明文之间切换，防止输错 */
  function bindEye() {
    const pw = $('#lgPass'), eye = $('#lgEye');
    if (!pw || !eye) return;
    eye.innerHTML = EYE_SVG;
    eye.addEventListener('click', function () {
      const show = pw.type === 'password';
      pw.type = show ? 'text' : 'password';
      eye.innerHTML = show ? OFF_SVG : EYE_SVG;
      eye.className = 'eye' + (show ? ' on' : '');
      eye.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
      eye.title = eye.getAttribute('aria-label');
      try { pw.focus(); const n = pw.value.length; pw.setSelectionRange(n, n); } catch (e) { /* 忽略 */ }
    });
  }

  /* 开屏欢迎页：头像 + 「欢迎回来」+ 名字。资料拉不到也照常显示，不许卡住。 */
  function showWelcome() {
    const el = $('#welcome');
    if (!el) return Promise.resolve();
    const p = state.profile || {};
    const nm = p.name || p.username || '';
    const hi = $('#wcHi'), nameEl = $('#wcName'), av = $('#wcAv'), sub = $('#wcSub');
    if (hi) hi.textContent = p.welcome ? '欢迎你' : '欢迎回来';
    if (nameEl) nameEl.textContent = nm || '我的书稿';
    if (av) {
      clear(av);
      if (p.avatar_url) {
        const im = h('img', { src: MZ.img(p.avatar_url), alt: '' });
        im.addEventListener('error', function () {   /* 头像读不出来就退回名字首字 */
          clear(av);
          av.appendChild(document.createTextNode(String(nm || '墨').slice(0, 1)));
        });
        av.appendChild(im);
      } else av.appendChild(document.createTextNode(String(nm || '墨').slice(0, 1)));
    }
    if (sub) {
      const info = [p.gender, p.age ? p.age + ' 岁' : ''].filter(function (x) { return x; }).join(' · ');
      sub.textContent = p.welcome ? '资料还空着，去「我的」补一下'
        : (info ? info + '　·　正在载入书稿…' : '正在载入你的书稿…');
    }
    el.hidden = false;
    /* 网关会往页面里塞一个右上角账号胶囊，它的 z-index 比这层还高，
       欢迎页盖全屏时先让它收起来，别浮在头像上面。 */
    document.body.classList.add('wc-open');
    return new Promise(function (resolve) {
      let done = false;
      function finish() {
        if (done) return;
        done = true;
        el.removeEventListener('click', finish);
        document.body.classList.remove('wc-open');
        el.classList.add('out');
        setTimeout(function () { el.hidden = true; el.classList.remove('out'); resolve(); }, 400);
      }
      el.addEventListener('click', finish);
      setTimeout(finish, 2600);
    });
  }

  /* ============================== 主题 ==============================
     三档：跟随系统 / 浅色 / 深色。默认跟随系统——手机切到深色，App 跟着切。
     主题类挂在 <html> 上（style.css 用 html.light）：这样 main.html 里一段
     内联脚本能在首次绘制前就把类打上，冷启动不会先闪一下白/黑。 */
  const THEME_KEY = 'mz_theme';
  const THEMES = ['system', 'light', 'dark'];
  let sysLight = null;
  function systemPrefersLight() {
    if (sysLight !== null) return sysLight;
    try { sysLight = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches); }
    catch (e) { sysLight = false; }
    return sysLight;
  }
  /* 读用户的选择；system/light/dark；旧版本没存过就当跟随系统 */
  function themePref() {
    let t = null;
    try { t = localStorage.getItem(THEME_KEY); } catch (e) { /* 忽略 */ }
    return THEMES.indexOf(t) >= 0 ? t : 'system';
  }
  /* 眼下到底是浅色还是深色（把跟随系统算进去） */
  function isLightTheme() {
    const t = themePref();
    return t === 'light' || (t === 'system' && systemPrefersLight());
  }
  function paintTheme() {
    const light = isLightTheme();
    document.documentElement.classList.toggle('light', light);
    /* 壳色必须跟 --bg 一模一样，不然顶栏/状态栏会漏出另一条色带 */
    const meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.setAttribute('content', light ? '#f2f1ee' : '#0c0d0f');
    const sch = document.querySelector('meta[name=color-scheme]');
    if (sch) sch.setAttribute('content', light ? 'light' : 'dark');
    return light;
  }
  /* 手机从后台回来、或 App 壳首帧读错系统外观时，再量一次 */
  function rereadTheme() {
    try {
      sysLight = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
    } catch (e) { sysLight = false; }
    if (themePref() === 'system') paintTheme();
  }
  function applyTheme(t) {
    const pref = THEMES.indexOf(t) >= 0 ? t : 'system';
    try { localStorage.setItem(THEME_KEY, pref); } catch (e) { /* 忽略 */ }
    return paintTheme();
  }
  function getTheme() { return themePref(); }
  /* 系统外观变了：只有选了「跟随系统」时才跟着重画 */
  function watchTheme() {
    try {
      const mq = window.matchMedia('(prefers-color-scheme: light)');
      const on = function () {
        sysLight = mq.matches;
        if (themePref() === 'system') paintTheme();
      };
      if (mq.addEventListener) mq.addEventListener('change', on);
      else if (mq.addListener) mq.addListener(on);
    } catch (e) { /* 忽略 */ }
    document.addEventListener('visibilitychange', function () { if (!document.hidden) rereadTheme(); });
    window.addEventListener('pageshow', rereadTheme);
  }

  /* ============================== 启动 ============================== */
  let liveTimer = null;
  let softTimer = null;
  let pollBound = false;

  function paintIcons() {
    $$('.tb-ico[data-ico]').forEach(function (el) {
      clear(el);
      el.appendChild(icon(el.dataset.ico, { size: 22 }));
    });
    /* 登录页和启动页直接放 App 图标本体（跟桌面图标、启动图同一个标），
       拿不到图再退回矢量品牌标。 */
    ['#loginLogo', '#splashLogo'].forEach(function (sel) {
      const el = $(sel);
      if (!el) return;
      clear(el);
      const img = document.createElement('img');
      img.alt = '墨舟';
      img.decoding = 'async';
      img.addEventListener('error', function () { clear(el); el.appendChild(brand(46)); }, { once: true });
      img.src = 'icons/icon-192.png';
      el.appendChild(img);
    });
  }
  function pollLive(delay) {
    liveTimer = setTimeout(async function () {
      /* 退到后台就降到低频兜底（iOS 本来也会挂起定时器），回前台由下方
         visibilitychange 立刻补一次，省电也更稳。 */
      if (document.hidden) { pollLive(6000); return; }
      const wasBusy = liveBusy(state.live);
      await refreshLive();
      const busy = liveBusy(state.live);
      /* 写作台是全屏覆盖层，它开着的时候不去动下面那屏 */
      if (!document.querySelector('.ed-wrap')) {
        /* 任务页：不再整页重画（以前每 1.6 秒 clear + 重建 + 滚动归零，
           用户原话就是「一直在跳、一直在刷新」），改成只把变化的那一块原地换掉。
           只有「在跑 / 跑完」这个状态切换才整页重画一次——顶栏的「停止全部」要跟着变。 */
        const jv = (state.tab === 'jobs' && !state.stack.length) ? state.jobsView : null;
        if (jv) {
          jv.paint(state.jobsHistory || null);
          /* 在跑 / 跑完切换时只同步顶栏的「停止全部」，不重画整页。 */
          if (jv.busy !== busy) { jv.busy = busy; applyNav(screens.jobs()); }
        }
        /* 别的页只在一轮任务跑完的那一刻补画一次：新章节出来了列表要能看到 */
        else if (wasBusy && !busy) render({ keepScroll: true });
      }
      pollLive(busy ? 1600 : 4000);
    }, delay);
  }
  function startTimer() {
    /* 这个函数必须「调几次都行」：会话过期后在登录卡重新登录会再进来一次，
       而它一开头就把旧定时器都清掉 —— 要是只在第一次建新的，第二次之后书架就
       再也不会自动对齐了（别的端删了书，本机一直看不见）。所以除了一次性的监听，
       定时器一律「先清后建」。 */
    if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
    if (shelfTimer) { clearInterval(shelfTimer); shelfTimer = null; }
    if (softTimer) clearInterval(softTimer);
    softTimer = setInterval(paintLiveSoft, 500);   // 两次轮询之间把百分比往前推
    pollLive(900);
    /* 书架对齐：每 15 秒一次（定时器退到后台会被系统挂起，没关系，回来时会立刻补一次） */
    shelfTimer = setInterval(function () { syncShelf(); }, SHELF_CHECK_MS);
    if (!pollBound) {
      pollBound = true;
      /* visibilitychange 只挂一次，别攒监听 */
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) {
          refreshLive();   /* 回到前台：不等定时器，立刻对齐真实状态 */
          syncShelf();     /* 顺手把书架也对一次：别的端删了书，一回来就看不到它了 */
        }
      });
    }
  }

  function hideSplash() {
    /* 告诉开屏看门狗：界面已经起来了，别再弹「重新加载」 */
    window.__mzBooted = true;
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
    const odTop = $('#odTop');
    if (odTop) {
      odTop.addEventListener('click', function () {
        haptic('light');
        setDockOpen(!dockOpen);   /* 折叠偏好记到本地：重绘不会又把抽屉弹回去 */
        paintOps();
      });
    }
    applyTheme(getTheme());
    watchTheme();

    /* 登录页跳过来会带 ?welcome=1：进门先露一下脸，顺便把地址还原干净 */
    const wantWelcome = /[?&]welcome=1\b/.test(location.search || '');
    if (wantWelcome) {
      try { history.replaceState(null, '', location.pathname + (location.hash || '')); } catch (e) { /* 忽略 */ }
    }

    if (hasAuth()) { enterApp(wantWelcome); return; }

    /* 桌面端换了监听端口之后，localStorage（按 origin 隔离）是空的，
       先问一句本机后端，把已存的会话接回来，用户就不用莫名其妙再登录一次。 */
    Promise.resolve(MZ.localSession ? MZ.localSession() : false).then(function (got) {
      if (got && hasAuth()) { enterApp(wantWelcome); return; }
      bootAuth(wantWelcome);
    });
  }

  /* 没有本地会话时的后一段启动：浏览器 Cookie 会话，拿不到就弹登录卡 */
  function bootAuth(wantWelcome) {
    /* 浏览器里可能已经是「网关登录过」的状态（Cookie 还在）：先问一声，能拿到资料就直接进。
       否则表现就是「刚在登录页输完账号密码，进来又要输一遍」。
       装机版 App 跑在 capacitor://localhost，没有 Cookie，这一问会 401，照旧弹登录卡。 */
    let webOrigin = false;
    try { webOrigin = /^https?:$/.test(location.protocol); } catch (e) { webOrigin = false; }
    if (!webOrigin) { showLogin(); hideSplash(); return; }
    api.get('/api/mz/profile').then(function (d) {
      if (d && d.ok && d.profile) {
        state.profile = d.profile;
        enterApp(wantWelcome);
      } else { showLogin(); hideSplash(); }
    }).catch(function () { showLogin(); hideSplash(); });
  }

  /* 真正进主界面：本地会话和「网关 Cookie 会话」都走这里 */
  /* 界面接线：滚动收起大标题、下拉刷新、左边缘右滑返回。
     这些是「挂一次就够」的监听，但以前只在 enterApp() 里挂 —— 而登录卡那条路
     （会话过期后重新登录）根本不走 enterApp()，结果是重登之后下拉刷新和右滑返回
     全失灵，得整页重载才回来。抽成 wireApp()，两条路都调。 */
  let wired = false;
  function wireApp() {
    if (wired) return;
    wired = true;
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
  }

  function enterApp(wantWelcome) {
    showApp();
    go('overview');
    wireApp();

    /* 欢迎页要名字和头像，所以先把资料拉回来再画 */
    const wp = wantWelcome
      ? loadProfile().then(function () { return showWelcome(); })
      : null;
    refreshAll(false).then(hideSplash, hideSplash);
    startTimer();
    if (wp) wp.catch(function () { /* 欢迎页出问题也不能挡着进主界面 */ });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  return {
    state: state, screens: screens, MZUI: MZUI,
    render: render, push: push, pop: pop, switchTab: switchTab, go: go,
    loadHero: loadHero, ensureHero: ensureHero, refreshAll: refreshAll, refreshLive: refreshLive,
    loadProfile: loadProfile,
    findNovel: findNovel, openBook: openBook, openTokenDialog: openTokenDialog,
    applyTheme: applyTheme, getTheme: getTheme, themePref: themePref, isLightTheme: isLightTheme, rereadTheme: rereadTheme,
    showLogin: showLogin, doLogin: doLogin, showRegister: showRegister,
    showForgot: showForgot, showChangePw: showChangePw,
    pick: pick, li: li, card: card, kpi: kpi, buttons: buttons, seg: seg, bar: barOf,
    span: span, txt: txt, busySheet: busySheet, startJob: startJob, newNovel: newNovel,
    newNovelMenu: newNovelMenu, importNovel: importNovel, removeNovels: removeNovels, exportNovel: exportNovel,
    runDaily: runDaily, stopAll: stopAll, stagger: stagger, topline: topline,
    askUpdate: askUpdate, askRewrite: askRewrite, bookHitReview: bookHitReview,
    liveBusy: liveBusy, phaseLine: phaseLine, emptyBox: emptyBox, loadingBox: loadingBox, errBox: errBox,
    pending: pending, pendingDone: pendingDone, pendingDrop: pendingDrop, paintOps: paintOps, opsAll: opsAll,
    hitFixInstruction: hitFixInstruction,
    chapTitle: chapTitle, setPinned: setPinned,
    _btn: function (label, tone, onTap, size) {
      const b = h('button.btn' + (tone ? '.' + tone : '') + (size === 'sm' ? '.sm' : ''), { type: 'button', text: label });
      b.addEventListener('click', function () { haptic('light'); onTap(); });
      return b;
    },
  };
})();
