/* 墨舟 · iPad 版的小动作   ipad.js

   排版全在 ipad.css 里（纯 CSS 就能成型，一行 JS 都不用）。这里只补 CSS 干不了的两件事：

     1) 外接键盘（妙控键盘 / 蓝牙键盘）：⌘1~4 切页、Esc 关掉最上面那一层、⌘F 跳到搜索框。
        写作台自己有更全的一套（⌘S 保存 / ⌘F 查找 / ⌘Z 撤销 / ⌘G 跳章），那些在 editor.js 里，
        这里不重复，也不抢它 —— 只在「没开写作台」的时候接管。

     2) 给 <html> 打一个 mz-ipad 标记：以后排查「到底是哪套版式在生效」时一眼就能看出来。

   为什么不做「双击不缩放」的 JS 兜底：CSS 的 touch-action: manipulation 在 iPadOS 上已经管住了，
   再用 touchend + preventDefault 去拦，会把「连点两下切页」这种正常操作也一起吃掉，得不偿失。

   注意：这个文件以前开头误写成 Python 的「编码声明 + 三引号 docstring」，浏览器整份解析失败
   （Invalid or unexpected token），下面的快捷键一条都没生效过。改它的时候别再把注释写成 # 开头。 */
(function () {
  'use strict';

  document.documentElement.classList.add('mz-ipad');

  var ORDER = ['books', 'write', 'jobs', 'me'];

  /* 正在输入框 / 正文里打字时，别抢人家的快捷键 */
  function isEditing() {
    var el = document.activeElement;
    if (!el) return false;
    var t = el.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || el.isContentEditable;
  }

  /* 最上面那一层：模态 → 动作菜单 → 抽屉。Esc 从它开始关。 */
  function topLayer() {
    var ids = ['maskModal', 'maskActions', 'maskSheet'];
    for (var i = 0; i < ids.length; i++) {
      var m = document.getElementById(ids[i]);
      if (m && !m.classList.contains('hidden')) return m;
    }
    return null;
  }

  /* 当前屏上那个搜索框（书架搜书名，写作页 / 作品页搜章节） */
  function searchBox() {
    return document.querySelector('.bk-search')
        || document.querySelector('.ed-find-in')
        || document.querySelector('input.inp[type=text][placeholder*="搜索"]')
        || document.querySelector('input.inp[type=text][placeholder*="查找"]');
  }

  function switchTab(tab) {
    var btn = document.querySelector('.tab[data-tab="' + tab + '"]');
    if (btn && !btn.classList.contains('on')) btn.click();
  }

  document.addEventListener('keydown', function (e) {
    /* Esc：关掉最上面那层。没有层可关就什么也不做 —— 别把人从当前页踢出去。 */
    if (e.key === 'Escape') {
      var m = topLayer();
      if (m) { m.click(); e.preventDefault(); }
      return;
    }
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
    /* ⌘1~4（老键盘上 Alt+1~4 由 main.html 里那段管着，这里只加 ⌘） */
    var n = parseInt(e.key, 10);
    if (n >= 1 && n <= ORDER.length && !isEditing()) {
      switchTab(ORDER[n - 1]);
      e.preventDefault();
      return;
    }
    /* ⌘F：跳到搜索框 */
    if (String(e.key || '').toLowerCase() === 'f' && !isEditing()) {
      var box = searchBox();
      if (box) {
        box.focus();
        if (box.select) box.select();
        e.preventDefault();
      }
    }
  }, false);
})();
