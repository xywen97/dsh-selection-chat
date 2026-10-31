/**
 * dsh-selection-chat —— 浏览器半端
 * ============================================================================
 * 干什么：在 DSH 右侧栏的文件预览（代码 / Markdown / 纯文本）里选中一段文字，
 * 选区旁浮出一个小条：
 *
 *   ┌───────────────────┐
 *   │ 加入聊天   评论    │
 *   └───────────────────┘
 *
 *   加入聊天 → 把「文件路径:行号 + 引用正文」追加到当前会话的输入框草稿
 *   评论     → 弹出一个小输入框，写完把「引用 + 我的评论」追加进草稿
 *
 * 纪律（跟 dsh-blender-plugin / dsh-bili-scroll 一致）：
 *   · **只填草稿，绝不自动发送** —— 走 `inputActions.insertText`，不碰 `submit`。
 *   · **失败静默降级** —— 拿不到 inputActions / 插入被拒时给一句小提示，不抛错。
 *   · 只认右侧栏预览里的选区；正文、设置页里的选中一律不管。
 *   · 所有 DOM 监听、样式、浮层都在卸载时清干净。
 *
 * 依赖的宿主契约（2026-10 的 0.2.x 实测）：
 *   · 槽位 `conversation.input.dock`（session 作用域）的 props 里有
 *     `inputActions`：{ captureInsertion(), insertText(text, span), setDraft(), submit() }
 *   · 预览根 `[data-document-preview]`；文件路径 `[data-textpreview-path][title]`
 *   · 代码预览用 Shiki：`<pre><code>` 下每行一个 `.line`，行号按顺序数
 * ============================================================================
 */

window.__ModuleLoader__.load({
  id: 'dsh-selection-chat',
  factory: function (require) {
    var React = require('react');

    var PLUGIN_ID = 'dsh-selection-chat';
    var Z_INDEX = 2147483000;

    /** 跨组件/全局监听共享的可变状态。 */
    var state = {
      /** 当前会话的输入框动作面（由 dock 槽位注入）。 */
      inputActions: null,
      /** 当前会话 id（仅用于日志/调试）。 */
      sessionId: null,
      /** 最近一次有效选区。 */
      selection: null,
      /** 'hidden' | 'bar' | 'comment'。 */
      mode: 'hidden',
      /** 注释弹窗草稿。 */
      commentDraft: '',
    };

    var layerEl = null;
    var styleEl = null;
    var hideTimer = 0;
    var disposers = [];

    //#region ---------------------------------------------------------------- CSS

    var CSS = [
      // 关键：零尺寸、不覆盖任何东西 —— 否则会挡掉 Electron 的窗口拖拽/双击标题栏区域
      '.dsc-layer{position:fixed;left:0;top:0;width:0;height:0;z-index:' + Z_INDEX + ';pointer-events:none;}',
      '.dsc-layer *{box-sizing:border-box;}',
      '.dsc-bar,.dsc-pop{position:fixed;pointer-events:auto;-webkit-app-region:no-drag;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;}',
      '.dsc-bar{display:flex;align-items:center;gap:2px;padding:4px;border-radius:10px;background:var(--dsw-alias-bg-elevated,#ffffff);color:var(--dsw-alias-label-primary,#111);box-shadow:0 6px 24px rgba(0,0,0,.16),0 0 0 .5px rgba(0,0,0,.10);}',
      '.dsc-btn{appearance:none;border:0;background:transparent;color:inherit;font:inherit;padding:5px 10px;border-radius:7px;cursor:pointer;white-space:nowrap;user-select:none;-webkit-app-region:no-drag;}',
      '.dsc-btn:hover{background:rgba(127,127,127,.14);}',
      '.dsc-btn[data-primary="true"]{background:var(--dsw-alias-state-business-primary,#3b6cf6);color:#fff;}',
      '.dsc-btn[data-primary="true"]:hover{filter:brightness(.95);}',
      '.dsc-sep{width:1px;height:16px;background:rgba(127,127,127,.28);margin:0 2px;}',
      '.dsc-pop{width:340px;max-width:calc(100vw - 24px);padding:12px;border-radius:12px;background:var(--dsw-alias-bg-elevated,#ffffff);color:var(--dsw-alias-label-primary,#111);box-shadow:0 12px 40px rgba(0,0,0,.20),0 0 0 .5px rgba(0,0,0,.10);}',
      '.dsc-pop-head{display:flex;align-items:baseline;gap:8px;margin-bottom:6px;font-weight:600;}',
      '.dsc-pop-where{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:400;font-size:12px;opacity:.62;direction:rtl;text-align:left;}',
      '.dsc-pop-quote{margin:0 0 8px;padding:6px 8px;max-height:66px;overflow:hidden;border-radius:8px;background:rgba(127,127,127,.10);font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;opacity:.78;}',
      '.dsc-pop-input{display:block;width:100%;min-height:62px;max-height:160px;resize:vertical;padding:8px 9px;border-radius:8px;border:1px solid rgba(127,127,127,.32);background:transparent;color:inherit;font:inherit;outline:none;}',
      '.dsc-pop-input:focus{border-color:var(--dsw-alias-state-business-primary,#3b6cf6);}',
      '.dsc-pop-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:8px;}',
      '.dsc-hint{position:fixed;pointer-events:none;-webkit-app-region:no-drag;max-width:320px;padding:6px 9px;border-radius:8px;background:rgba(30,30,30,.92);color:#fff;font:12px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.24);}',
      '.dsc-layer ::selection{background:rgba(59,108,246,.30);}',
    ].join('');

    function ensureStyle() {
      if (styleEl && styleEl.isConnected) return;
      styleEl = document.createElement('style');
      styleEl.setAttribute('data-plugin-css', PLUGIN_ID);
      styleEl.textContent = CSS;
      document.head.appendChild(styleEl);
    }

    /** 浮层空了就把它从 DOM 里摘掉：绝不长期覆盖窗口。 */
    function destroyLayer() {
      if (!layerEl) return;
      if (layerEl.querySelector('.dsc-hint')) return;
      if (layerEl.parentNode) layerEl.parentNode.removeChild(layerEl);
      layerEl = null;
    }

    function ensureLayer() {
      if (layerEl && layerEl.isConnected) return layerEl;
      layerEl = document.createElement('div');
      layerEl.className = 'dsc-layer';
      layerEl.setAttribute('data-plugin', PLUGIN_ID);
      layerEl.addEventListener('mousedown', function (ev) {
        // 点浮层时不要夺走选区/焦点
        ev.preventDefault();
        ev.stopPropagation();
      });
      layerEl.addEventListener('click', onLayerClick);
      document.body.appendChild(layerEl);
      return layerEl;
    }

    //#endregion

    //#region --------------------------------------------------------- 选区解析

    function elementOf(node) {
      if (!node) return null;
      return node.nodeType === 1 ? node : node.parentElement || null;
    }

    /**
     * 选区允许的两个来源：
     *   preview —— 右侧栏文件预览的**正文**（不含 tab 条和路径头部）
     *   chat    —— 会话正文（聊天记录、工具回显…），用来引用聊天记录
     * 其它位置（app 自己的标签、标题、输入框）一律不认。
     * @param node - selection 的 anchor/focus 节点。
     * @returns {{kind: string, root: Element} | null}
     */
    function scopeOf(node) {
      var el = elementOf(node);
      if (!el || !el.closest) return null;
      if (el.closest('.dsc-layer')) return null;
      if (el.closest('[contenteditable="true"]')) return null;

      // 预览：只认**正文槽位**，不认 tab 条和路径头部（那里也是 [data-sidebar-right-tab]）
      var previewBody = el.closest('[data-slot="sidebar.right.tab.document"]');
      if (previewBody) return { kind: 'preview', root: previewBody };

      var chat = el.closest('[data-slot="conversation.chat.flow"]') || el.closest('[data-slot="conversation.chat.node"]');
      if (!chat) return null;
      if (el.closest('[data-slot="rightbar"]')) return null;
      if (el.closest('[data-slot="conversation.composer"]')) return null;
      if (el.closest('[data-slot="conversation.header"]')) return null;
      if (el.closest('button')) return null;
      return { kind: 'chat', root: chat };
    }

    /** 取预览里的绝对路径（同一 pane 头部 PathLabel 的 title）。 */
    function pathOf(scopeRoot) {
      var pane = scopeRoot && scopeRoot.closest ? scopeRoot.closest('[data-sidebar-right-tab]') : null;
      var node = pane && pane.querySelector('[data-textpreview-path]');
      var path = node && (node.getAttribute('title') || node.textContent);
      return path ? String(path).trim() : null;
    }

    /** 取代码预览的行号（Shiki 每行一个 `.line`）。 */
    function lineRangeOf(node, sel, previewRoot) {
      if (!previewRoot || !previewRoot.querySelector) return { start: null, end: null };
      var code = previewRoot.querySelector('[data-document-preview] pre > code') || previewRoot.querySelector('pre > code');
      if (!code) return { start: null, end: null };

      // 只有选区整个落在同一份代码里才算行号；Markdown 正文里虽然也可能有代码块，
      // 但选中的是正文段落，此时绝不能凭空给出 :1。
      var range = sel.getRangeAt(0);
      if (!code.contains(range.startContainer) || !code.contains(range.endContainer)) {
        return { start: null, end: null };
      }

      var spans = [];
      for (var i = 0; i < code.children.length; i += 1) {
        var child = code.children[i];
        if (child.classList && child.classList.contains('line')) spans.push(child);
      }
      if (!spans.length) return { start: null, end: null };

      function lineIndexFor(container) {
        var n = elementOf(container);
        while (n && n !== code) {
          if (n.classList && n.classList.contains('line')) {
            var at = spans.indexOf(n);
            if (at >= 0) return at;
          }
          n = n.parentElement;
        }
        return -1;
      }

      var a = lineIndexFor(range.startContainer);
      var b = lineIndexFor(range.endContainer);
      if (a < 0 || b < 0) return { start: null, end: null };
      if (b < a) { var t = a; a = b; b = t; }
      return { start: a + 1, end: b + 1 };
    }

    /** 读取当前选区；不满足条件返回 null。 */
    function readSelection() {
      var sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
      var text = sel.toString();
      if (!text || !text.trim()) return null;

      var anchorScope = scopeOf(sel.anchorNode);
      if (!anchorScope) return null;
      var focusScope = scopeOf(sel.focusNode);
      if (!focusScope || focusScope.kind !== anchorScope.kind) return null;
      if (anchorScope.kind === 'preview' && focusScope.root !== anchorScope.root) return null;

      var rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return null;

      // 拖选时很容易把首尾的空行也框进来：去掉它们，并把行号跟着往内收
      var rawLines = String(text).replace(/\r\n/g, '\n').split('\n');
      var lead = 0;
      var trail = rawLines.length;
      while (lead < trail && rawLines[lead].trim() === '') lead += 1;
      while (trail > lead && rawLines[trail - 1].trim() === '') trail -= 1;
      var kept = rawLines.slice(lead, trail);
      if (!kept.length || !kept.join('\n').trim()) return null;
      text = kept.join('\n');

      var lines = anchorScope.kind === 'preview'
        ? lineRangeOf(sel.anchorNode, sel, anchorScope.root)
        : { start: null, end: null };
      var startLine = lines.start === null ? null : lines.start + lead;
      var endLine = lines.start === null ? null : startLine + kept.length - 1;
      return {
        scope: anchorScope.kind,
        text: text,
        path: anchorScope.kind === 'preview' ? pathOf(anchorScope.root) : null,
        startLine: startLine,
        endLine: endLine,
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
        range: sel.getRangeAt(0).cloneRange(),
      };
    }

    //#endregion

    //#region --------------------------------------------------------- 文本拼装

    function locationLabel(selection) {
      if (!selection) return '';
      if (selection.scope === 'chat' || !selection.path) return '会话记录';
      var label = selection.path;
      if (selection.startLine) {
        label += ':' + selection.startLine;
        if (selection.endLine && selection.endLine !== selection.startLine) label += '-' + selection.endLine;
      }
      return label;
    }

    function quoteBody(selection) {
      return String(selection.text || '')
        .replace(/\r\n/g, '\n')
        .replace(/\s+$/, '')
        .split('\n')
        .map(function (line) { return '> ' + line; })
        .join('\n');
    }

    /** 「加入聊天」的正文。 */
    function buildQuote(selection) {
      return '引用 ' + locationLabel(selection) + '\n' + quoteBody(selection) + '\n\n';
    }

    /** 「评论」的正文。 */
    function buildComment(selection, comment) {
      var body = String(comment == null ? '' : comment).trim();
      return '评论 ' + locationLabel(selection) + '\n' + quoteBody(selection) + '\n我的评论：' + body + '\n\n';
    }

    //#endregion

    //#region --------------------------------------------------------- 写入草稿

    /** 往当前会话草稿追加纯文本；失败时退到剪贴板并提示。 */
    function appendToDraft(text) {
      var actions = state.inputActions;
      var written = false;
      if (actions) {
        try {
          written = actions.insertText(text, actions.captureInsertion()) === true;
        } catch (error) {
          written = false;
        }
        if (!written) {
          // 草稿锁/提交中会拒绝一次，拿新的插入点重试一次
          try {
            written = actions.insertText(text, actions.captureInsertion()) === true;
          } catch (error) {
            written = false;
          }
        }
      }
      if (!written) {
        // #[A] 没拿到 inputActions 或插入被拒：退到剪贴板，至少别让用户白选一次
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text);
        } catch (error) { /* 忽略 */ }
        showHint('没能写进输入框（会话可能正在提交），内容已复制到剪贴板');
        return false;
      }
      showHint('已加入输入框草稿（未发送）');
      return true;
    }

    /**
     * 「侧边提问」：等价 Codex 的 Ask in side chat —— 开一个临时侧边对话，
     * 并把选中的片段写进那边的输入框草稿（不自动发送）。
     */
    function askInSideChat() {
      var selection = state.selection;
      if (!selection) return;
      var bridge = window.__DSH_SIDE_CHAT__;
      if (!bridge || typeof bridge.openWithSnippet !== 'function') {
        showHint('需要先安装并启用 dsh-side-chat 插件');
        return;
      }
      var sessionId = state.sessionId;
      if (!sessionId) {
        showHint('没拿到当前会话：先点一下主对话的输入框，再选中文字');
        return;
      }
      var quote = buildQuote(selection);
      hide();
      Promise.resolve(bridge.openWithSnippet(sessionId, quote))
        .then(function (result) {
          showHint(result && result.seeded === true ? '已在侧边聊天里带入这个片段' : '侧边聊天已打开，片段没写进去——可在侧边手动 @ 引用');
        })
        .catch(function (error) {
          showHint('侧边聊天失败：' + (error && error.message ? error.message : String(error)));
        });
    }

    //#endregion

    //#region ------------------------------------------------------------- 浮层

    function hide(clearHint) {
      state.mode = 'hidden';
      state.selection = null;
      state.commentDraft = '';
      if (clearHint === true) removeHint();
      draw();
    }

    function removeHint() {
      if (!layerEl) return;
      var hint = layerEl.querySelector('.dsc-hint');
      if (hint && hint.parentNode) hint.parentNode.removeChild(hint);
      destroyLayer();
    }

    var hintTimer = 0;
    function showHint(message) {
      if (layerEl) {
        var stale = layerEl.querySelector('.dsc-hint');
        if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
      }
      var layer = ensureLayer();
      var hint = document.createElement('div');
      hint.className = 'dsc-hint';
      hint.textContent = message;
      hint.style.left = '50%';
      hint.style.bottom = '48px';
      hint.style.transform = 'translateX(-50%)';
      layer.appendChild(hint);
      if (hintTimer) window.clearTimeout(hintTimer);
      hintTimer = window.setTimeout(function () {
        hintTimer = 0;
        removeHint();
      }, 2600);
    }

    function placeNear(el, rect, preferAbove) {
      var margin = 8;
      var viewportW = document.documentElement.clientWidth;
      var viewportH = document.documentElement.clientHeight;
      el.style.visibility = 'hidden';
      el.style.left = '0px';
      el.style.top = '0px';
      var box = el.getBoundingClientRect();
      var width = box.width || 0;
      var height = box.height || 0;

      var left = rect.right + 6;
      if (left + width > viewportW - margin) left = rect.left - width - 6;
      if (left < margin) left = margin;
      if (left + width > viewportW - margin) left = Math.max(margin, viewportW - margin - width);

      var top = preferAbove ? rect.top - height - 6 : rect.bottom + 6;
      if (preferAbove && top < margin) top = rect.bottom + 6;
      if (top + height > viewportH - margin) top = Math.max(margin, rect.top - height - 6);
      if (top < margin) top = margin;

      el.style.left = Math.round(left) + 'px';
      el.style.top = Math.round(top) + 'px';
      el.style.visibility = 'visible';
    }

    function drawBar(layer) {
      var bar = document.createElement('div');
      bar.className = 'dsc-bar';
      bar.setAttribute('role', 'toolbar');
      bar.innerHTML =
        '<button type="button" class="dsc-btn" data-act="quote">加入对话</button>' +
        '<span class="dsc-sep"></span>' +
        '<button type="button" class="dsc-btn" data-act="side" title="打开侧边聊天并把这个片段带进去">侧边提问</button>' +
        '<span class="dsc-sep"></span>' +
        '<button type="button" class="dsc-btn" data-act="comment">评论</button>';
      layer.appendChild(bar);
      placeNear(bar, state.selection.rect, true);
    }

    function drawComment(layer) {
      var selection = state.selection;
      var pop = document.createElement('div');
      pop.className = 'dsc-pop';
      pop.setAttribute('role', 'dialog');
      pop.setAttribute('aria-label', '添加评论');
      pop.innerHTML =
        '<div class="dsc-pop-head">评论<span class="dsc-pop-where" title="' + escapeAttr(locationLabel(selection)) + '">' +
        escapeHtml(locationLabel(selection)) + '</span></div>' +
        '<pre class="dsc-pop-quote">' + escapeHtml(truncate(selection.text, 220)) + '</pre>' +
        '<textarea class="dsc-pop-input" placeholder="写一句评论…（⌘/Ctrl + Enter 插入）"></textarea>' +
        '<div class="dsc-pop-actions">' +
        '<button type="button" class="dsc-btn" data-act="cancel">取消</button>' +
        '<button type="button" class="dsc-btn" data-primary="true" data-act="send">插入评论</button>' +
        '</div>';
      layer.appendChild(pop);
      placeNear(pop, selection.rect, false);
      var input = pop.querySelector('.dsc-pop-input');
      if (input) {
        input.value = state.commentDraft || '';
        input.focus();
        var len = input.value.length;
        try { input.setSelectionRange(len, len); } catch (error) { /* 忽略 */ }
        input.addEventListener('input', function () { state.commentDraft = input.value; });
        input.addEventListener('keydown', function (ev) {
          if (ev.key === 'Escape') {
            ev.preventDefault();
            hide();
            return;
          }
          if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
            ev.preventDefault();
            sendComment();
          }
        });
      }
    }

    function draw() {
      if (state.mode === 'hidden' || !state.selection) {
        if (layerEl) {
          var stale = layerEl.querySelectorAll('.dsc-bar,.dsc-pop');
          for (var j = 0; j < stale.length; j += 1) stale[j].parentNode.removeChild(stale[j]);
          destroyLayer();
        }
        return;
      }
      var layer = ensureLayer();
      var old = layer.querySelectorAll('.dsc-bar,.dsc-pop');
      for (var i = 0; i < old.length; i += 1) old[i].parentNode.removeChild(old[i]);
      if (state.mode === 'bar') drawBar(layer);
      else if (state.mode === 'comment') drawComment(layer);
    }

    function onLayerClick(ev) {
      var target = ev.target;
      var button = target && target.closest ? target.closest('[data-act]') : null;
      if (!button) return;
      ev.preventDefault();
      ev.stopPropagation();
      var act = button.getAttribute('data-act');
      if (act === 'quote') {
        var selection = state.selection;
        if (!selection) return;
        if (appendToDraft(buildQuote(selection))) hide();
      } else if (act === 'side') {
        askInSideChat();
      } else if (act === 'comment') {
        state.mode = 'comment';
        state.commentDraft = '';
        draw();
      } else if (act === 'cancel') {
        hide(true);
      } else if (act === 'send') {
        sendComment();
      }
    }

    function sendComment() {
      var selection = state.selection;
      if (!selection) return;
      var comment = state.commentDraft || '';
      if (!comment.trim()) {
        var input = layerEl && layerEl.querySelector('.dsc-pop-input');
        if (input) input.focus();
        return;
      }
      if (appendToDraft(buildComment(selection, comment))) hide();
    }

    //#endregion

    //#region ------------------------------------------------------------- 事件

    var selectionTimer = 0;
    function scheduleSelectionCheck() {
      if (selectionTimer) window.clearTimeout(selectionTimer);
      selectionTimer = window.setTimeout(function () {
        selectionTimer = 0;
        onSelectionSettled();
      }, 60);
    }

    /** 诊断期临时：把一次被忽略的选区记成一句话，便于判断用户选在了哪。 */
    function describeAnchor(sel) {
      try {
        var el = elementOf(sel && sel.anchorNode);
        if (!el) return null;
        var chain = [];
        var n = el;
        for (var i = 0; i < 6 && n; i += 1) {
          var slot = n.getAttribute ? n.getAttribute('data-slot') : null;
          if (slot) chain.push(slot);
          n = n.parentElement;
        }
        return String(el.tagName || '?') + (chain.length ? ' < ' + chain.join(' < ') : '');
      } catch (error) {
        return null;
      }
    }

    function onSelectionSettled() {
      if (state.mode === 'comment') return; // 写评论时别被别处的选区变化打断
      var sel = window.getSelection();
      var rawChars = sel && !sel.isCollapsed ? String(sel.toString()).length : 0;
      var selection = null;
      try {
        selection = readSelection();
      } catch (error) {
        selection = null;
      }
      if (!selection) {
        if (rawChars > 0) probe('reject', { chars: rawChars, at: describeAnchor(sel) });
        if (state.mode !== 'hidden') hide();
        return;
      }
      state.selection = selection;
      state.mode = 'bar';
      probe('selection', { scope: selection.scope, path: selection.path, lines: [selection.startLine, selection.endLine], chars: String(selection.text || '').length });
      draw();
    }

    function onMouseUp(ev) {
      var target = ev.target;
      if (target && target.closest && target.closest('.dsc-layer')) return;
      // 等浏览器把选区定下来
      scheduleSelectionCheck();
    }

    function onMouseDown(ev) {
      var target = ev.target;
      if (target && target.closest && target.closest('.dsc-layer')) return;
      if (state.mode === 'comment') {
        // 点外面等于放弃这条评论
        hide(true);
        return;
      }
      if (state.mode === 'bar') hide();
    }

    function onSelectionChange() {
      if (state.mode === 'comment') return;
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        if (state.mode !== 'hidden') hide();
      }
    }

    function onKeyDown(ev) {
      if (ev.key === 'Escape' && state.mode !== 'hidden') {
        ev.preventDefault();
        hide(true);
      }
    }

    function onScrollOrResize() {
      if (state.mode === 'hidden' || !state.selection) return;
      var sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) { hide(); return; }
      var rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) { hide(); return; }
      state.selection.rect = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
      draw();
    }

    function bind(target, type, handler, options) {
      target.addEventListener(type, handler, options);
      disposers.push(function () { target.removeEventListener(type, handler, options); });
    }

    //#endregion


    //#region ------------------------------------------------------- 诊断探针
    // 诊断期临时：把「插件已 apply」和「识别到选区」写到 localStorage，
    // 便于在宿主外面确认渲染端到底有没有挂上（确认后会删掉）。
    var PROBE_KEY = 'dsh-selection-chat:probe';
    function probe(kind, detail) {
      try {
        var prev = [];
        try { prev = JSON.parse(window.localStorage.getItem(PROBE_KEY) || '[]'); } catch (e) { prev = []; }
        prev.push({ kind: kind, at: new Date().toISOString(), detail: detail || null });
        while (prev.length > 8) prev.shift();
        window.localStorage.setItem(PROBE_KEY, JSON.stringify(prev));
      } catch (e) { /* 忽略 */ }
    }
    //#endregion
    //#region ------------------------------------------------------------- 工具

    function escapeHtml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function escapeAttr(value) { return escapeHtml(value); }
    function truncate(value, max) {
      var text = String(value == null ? '' : value);
      return text.length > max ? text.slice(0, max) + '…' : text;
    }

    //#endregion

    //#region ------------------------------------------------------- dock 注入

    /**
     * 常驻挂载在 `conversation.input.dock` 上的空组件：只负责把当前会话的
     * `inputActions` / `sessionId` 存到模块状态里，然后渲染 null。
     */
    function DockHost(props) {
      var p = props || {};
      var markerRef = React.useRef(null);
      var sessionId = p.sessionId;
      var actions = p.inputActions;
      React.useEffect(function () {
        var el = markerRef.current;
        // 侧边聊天 / 子代理对话也挂在同一个 dock 槽位上：只认主对话，别抢写入目标
        if (el && el.closest && el.closest('[data-slot="rightbar"]')) return;
        if (actions) state.inputActions = actions;
        if (sessionId) state.sessionId = sessionId;
      }, [actions, sessionId]);
      return React.createElement('span', {
        ref: markerRef,
        style: { display: 'none' },
        'data-selection-chat-dock': '',
      });
    }

    //#endregion

    //#region ------------------------------------------------------------- apply

    function apply(ctx) {
      try {
        start.apply(null, [ctx]);
      } catch (error) {
        // 客户端插件抛错不该影响宿主 UI：最多是本插件不生效
        try { console.warn('[dsh-selection-chat] 启动失败：', error); } catch (ignore) { /* 忽略 */ }
      }
    }

    function start(ctx) {
      ensureStyle();
      probe('apply', { href: String(location.href).slice(0, 80) });

      bind(document, 'mouseup', onMouseUp, true);
      bind(document, 'mousedown', onMouseDown, true);
      bind(document, 'selectionchange', onSelectionChange, false);
      bind(document, 'keydown', onKeyDown, true);
      bind(window, 'scroll', onScrollOrResize, true);
      bind(window, 'resize', onScrollOrResize, false);

      var slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots;
      if (!slots) {
        // 没有槽位就没有 inputActions，浮层点了也写不进去；直接不启用
        return;
      }
      ctx.effect(function () {
        return slots.inject('conversation.input.dock', function () {
          return slots.register({
            name: 'conversation.input.dock',
            id: 'selection-chat-dock',
            order: 95,
          }, DockHost);
        });
      }, PLUGIN_ID + ': input dock');

      ctx.effect(function () {
        return function () {
          if (selectionTimer) window.clearTimeout(selectionTimer);
          if (hintTimer) window.clearTimeout(hintTimer);
          for (var i = 0; i < disposers.length; i += 1) {
            try { disposers[i](); } catch (error) { /* 忽略 */ }
          }
          disposers = [];
          state.inputActions = null;
          state.sessionId = null;
          state.selection = null;
          state.mode = 'hidden';
          if (layerEl && layerEl.parentNode) layerEl.parentNode.removeChild(layerEl);
          layerEl = null;
          if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
          styleEl = null;
        };
      }, PLUGIN_ID + ': teardown');
    }

    //#endregion

    return {
      inject: ['slots'],
      apply: apply,
      // 仅给离线自检用；DSH 只读 apply/inject
      __selftest: {
        locationLabel: locationLabel,
        buildQuote: buildQuote,
        buildComment: buildComment,
        quoteBody: quoteBody,
      },
    };
  },
});
