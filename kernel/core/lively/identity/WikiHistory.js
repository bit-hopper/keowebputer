/**
 * lively.identity.WikiHistory
 *
 * Version-history panel for a wiki page, shown inside a WikiView in place of
 * the page body (WikiView's three-dot menu -> History, or the editor's History
 * button, which saves and then opens the view on this panel). Replaced the old
 * floating timeline-slider window.
 *
 * Layout: a header (back to the page), then two columns -- the version list on
 * the left, the selected version on the right. The right side shows either the
 * page as it was ("Page") or what changed ("Changes", a block/word diff from
 * WikiDiff.js), against the previous version or against the current one.
 *
 * Versions come from GET /@:handle/:objId/versions ({cid, prevCid, createdAt,
 * title, lastEditedBy}, oldest first) and snapshots from .../at/:cid. Autosave
 * makes many versions, so the list is grouped: consecutive versions by the
 * same author with no gap longer than GAP_MS between them form one row, which
 * stands for the state at the end of the group and expands to the individual
 * versions. A version saved before the server recorded lastEditedBy is
 * attributed to the page's author (envelope.did, the genesis author).
 *
 * Plain DOM hosted in the view's wrapper (like WikiView itself), not morphs.
 *
 * Entry point: lively.identity.WikiHistory.open(wikiView)
 */

module('lively.identity.WikiHistory')
  .requires('lively.identity.DID', 'lively.identity.PostCardUtils', 'lively.identity.WikiDiff')
  .toRun(function () {

    var GAP_MS = 30 * 60 * 1000;
    var ACCENT = '#E31361';
    var STYLE_ID = 'lively-wiki-history-style';

    function injectStyle() {
      if (document.getElementById(STYLE_ID)) return;
      var s = document.createElement('style');
      s.id = STYLE_ID;
      s.textContent = [
        '.wh-root{font-family:sans-serif;color:#333;display:flex;flex-direction:column;box-sizing:border-box;background:#fff;}',
        '.wh-head{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:6px 14px 10px;border-bottom:1px solid #eee;}',
        '.wh-back{display:inline-flex;align-items:center;gap:4px;border:1px solid #ddd;background:#fff;border-radius:16px;padding:4px 12px 4px 8px;font-size:12px;color:#444;cursor:pointer;}',
        '.wh-back:hover{background:#f5f5f5;}',
        '.wh-back .material-symbols-rounded{font-size:16px;}',
        '.wh-title{font-size:15px;font-weight:600;color:#222;}',
        '.wh-sub{font-size:12px;color:#999;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;}',
        '.wh-body{flex:1 1 auto;min-height:0;display:flex;}',
        '.wh-list{flex:0 0 300px;overflow-y:auto;border-right:1px solid #eee;background:#fafafa;padding:6px 0;box-sizing:border-box;}',
        '.wh-pane{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;}',
        '.wh-panehead{flex:0 0 auto;padding:10px 16px;border-bottom:1px solid #eee;display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;font-size:12px;}',
        '.wh-panecontent{flex:1 1 auto;min-height:0;overflow-y:auto;padding:14px 20px 24px;font-size:13px;line-height:1.5;}',
        '.wh-grp{display:flex;align-items:center;gap:8px;padding:7px 12px;cursor:pointer;border-left:3px solid transparent;}',
        '.wh-grp:hover{background:#f0f0f0;}',
        '.wh-grp.wh-sel{background:#fdeaf1;border-left-color:' + ACCENT + ';}',
        '.wh-who{font-size:12.5px;font-weight:600;color:#333;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
        '.wh-meta{font-size:11px;color:#888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
        '.wh-col{min-width:0;flex:1 1 auto;}',
        '.wh-grp .wh-meta{white-space:normal;}',
        '.wh-badge{font-size:10px;font-weight:600;color:#fff;background:' + ACCENT + ';border-radius:8px;padding:1px 7px;flex:0 0 auto;}',
        '.wh-chev{font-size:18px;color:#999;flex:0 0 auto;transition:transform 120ms ease;}',
        '.wh-chev.wh-open{transform:rotate(90deg);}',
        '.wh-ver{display:flex;align-items:center;gap:8px;padding:4px 12px 4px 44px;cursor:pointer;font-size:11.5px;color:#555;border-left:3px solid transparent;}',
        '.wh-ver:hover{background:#f0f0f0;}',
        '.wh-ver.wh-sel{background:#fdeaf1;border-left-color:' + ACCENT + ';}',
        '.wh-seg{display:inline-flex;border:1px solid #ddd;border-radius:14px;overflow:hidden;}',
        '.wh-seg button{border:0;background:#fff;padding:4px 12px;font-size:12px;cursor:pointer;color:#555;}',
        '.wh-seg button.wh-on{background:' + ACCENT + ';color:#fff;}',
        '.wh-select{font-size:12px;padding:3px 6px;border:1px solid #ddd;border-radius:6px;background:#fff;color:#444;}',
        '.wh-restore{margin-left:auto;display:inline-flex;align-items:center;gap:5px;border:1px solid ' + ACCENT + ';background:#fff;color:' + ACCENT + ';border-radius:14px;padding:4px 12px 4px 8px;font-size:12px;cursor:pointer;}',
        '.wh-restore:hover{background:#fdeaf1;}',
        '.wh-restore .material-symbols-rounded{font-size:16px;}',
        '.wh-stat{font-size:11.5px;color:#777;}',
        '.wh-stat b.a{color:#1c6b38;} .wh-stat b.r{color:#a33;} .wh-stat b.m{color:#8a6a00;}',
        '.wh-empty{color:#999;font-size:13px;padding:30px 0;text-align:center;}',
        // diff lines
        '.wh-line{display:flex;align-items:baseline;gap:6px;padding:1px 8px;border-left:3px solid transparent;border-radius:2px;margin:1px 0;}',
        '.wh-line .wh-text{margin:3px 0;font-weight:inherit;flex:1 1 auto;min-width:0;overflow-wrap:anywhere;}',
        '.wh-line h1.wh-text{font-size:22px;} .wh-line h2.wh-text{font-size:19px;} .wh-line h3.wh-text{font-size:16px;}',
        '.wh-line h4.wh-text,.wh-line h5.wh-text,.wh-line h6.wh-text{font-size:14px;}',
        '.wh-line pre.wh-text{font-family:monospace;font-size:12px;white-space:pre-wrap;background:#f6f6f6;padding:4px 6px;border-radius:4px;}',
        '.wh-line .wh-mark{color:#999;flex:0 0 auto;}',
        '.wh-quote{border-left-color:#ddd;}',
        '.wh-same{color:#777;}',
        '.wh-del{background:#fff2f2;border-left-color:#e06c6c;color:#7a2020;}',
        '.wh-del .wh-text,.wh-del .wh-text *{text-decoration:line-through;text-decoration-color:#e06c6c;}',
        '.wh-ins{background:#eefaf1;border-left-color:#4aae6a;}',
        '.wh-mod{background:#fffdf0;border-left-color:#d8b42a;}',
        '.wh-mod del{background:#fbd5d5;color:#7a2020;text-decoration:line-through;}',
        '.wh-mod ins{background:#c9efd5;color:#14532d;text-decoration:none;}',
        '.wh-note{font-size:10.5px;color:#8a6a00;flex:0 0 auto;margin-left:6px;}',
        '.wh-node{display:block;}',
        '.wh-collapse{margin:6px 0;padding:3px 0;text-align:center;font-size:11px;color:#888;background:#f5f5f5;border-radius:10px;cursor:pointer;}',
        '.wh-collapse:hover{background:#ececec;}',
      ].join('');
      document.head.appendChild(s);
    }

    function el(tag, cls, text) {
      var e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    }

    function icon(name) {
      var s = el('span', 'material-symbols-rounded', name);
      return s;
    }

    function fmtDay(d) {
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }
    function fmtTime(d) {
      return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    function fmtFull(d) { return fmtDay(d) + ', ' + fmtTime(d); }
    function sameDay(a, b) { return a.toDateString() === b.toDateString(); }

    // Mouse-wheel scrolling for an overflow:auto element nested in the view's
    // overflow:hidden morph chain -- same workaround WikiView applies to its
    // own content div.
    function wireWheel(node) {
      node.addEventListener('wheel', function (e) {
        if (getComputedStyle(node).overflowY !== 'auto') return;
        node.scrollTop += e.deltaY;
        e.preventDefault();
      }, { passive: false });
    }

    Object.subclass('lively.identity.WikiHistory',

    'initialization', {

      initialize: function (view) {
        this.view = view;
        this.versions = [];
        this.groups = [];
        this.handles = {};
        this.cache = {};
        this.expanded = {};
        this.sel = null;          // { cid, baseCid }  baseCid: the previous version (or group)
        this.mode = 'changes';    // 'page' | 'changes'
        this.compare = 'previous';// 'previous' | 'current'
        this._token = 0;          // guards stale async renders
      },

      open: function () {
        injectStyle();
        var v = this.view;
        this._hidden = [v._titleEl, v._detailsToggleEl, v._detailsPanelEl, v._contentEl];
        this._hidden.forEach(function (n) { if (n) n.style.display = 'none'; });
        this._build();
        v._wrapperEl.appendChild(this.root);
        this._fetchVersions();
      },

      close: function () {
        if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
        this._hidden.forEach(function (n) { if (n) n.style.display = ''; });
        // _detailsPanelEl's own display follows the view's details toggle
        if (this.view._detailsPanelEl) this.view._detailsPanelEl.style.display = this.view._detailsOpen ? '' : 'none';
        this.view._history = null;
        this._token++;
      },

    },

    'chrome', {

      _build: function () {
        var self = this, v = this.view;
        var root = el('div', 'wh-root');
        if (v._autoHeight) root.style.height = Math.max(520, window.innerHeight - 230) + 'px';
        else root.style.cssText += ';flex:1 1 auto;min-height:0;';
        this.root = root;

        var head = el('div', 'wh-head');
        var back = el('button', 'wh-back');
        back.appendChild(icon('arrow_back'));
        back.appendChild(el('span', '', 'Back to page'));
        back.addEventListener('click', function (e) { e.stopPropagation(); self.close(); });
        head.appendChild(back);
        head.appendChild(el('span', 'wh-title', 'History'));
        var sub = el('span', 'wh-sub', (v._envelope && v._envelope.state && v._envelope.state.title) || '');
        head.appendChild(sub);
        root.appendChild(head);

        var body = el('div', 'wh-body');
        this.listEl = el('div', 'wh-list');
        wireWheel(this.listEl);
        this.listEl.appendChild(el('div', 'wh-empty', 'Loading versions…'));
        var pane = el('div', 'wh-pane');
        this.paneHeadEl = el('div', 'wh-panehead');
        this.paneHeadEl.style.display = 'none';
        this.contentEl = el('div', 'wh-panecontent selectable');
        this.contentEl.style.userSelect = 'text';
        wireWheel(this.contentEl);
        this.contentEl.addEventListener('click', function (e) {
          var t = e.target.closest && e.target.closest('[data-wh-toggle]');
          if (!t) return;
          var hidden = t.nextElementSibling;
          if (hidden) { hidden.style.display = ''; t.style.display = 'none'; }
        });
        pane.appendChild(this.paneHeadEl);
        pane.appendChild(this.contentEl);
        body.appendChild(this.listEl);
        body.appendChild(pane);
        root.appendChild(body);
      },

    },

    'data', {

      _url: function (suffix) {
        var v = this.view;
        return lively.identity.did.baseUrl() + '/@' + encodeURIComponent(v._handle) + '/' +
          encodeURIComponent(v._objId) + suffix;
      },

      _getJson: function (url, thenDo) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.onload = function () {
          if (xhr.status !== 200) return thenDo(new Error('HTTP ' + xhr.status));
          try { thenDo(null, JSON.parse(xhr.responseText)); } catch (e) { thenDo(e); }
        };
        xhr.onerror = function () { thenDo(new Error('Network error')); };
        xhr.send();
      },

      _fetchVersions: function () {
        var self = this;
        this._getJson(this._url('/versions'), function (err, data) {
          if (err) return self._listMessage('Could not load history (' + err.message + ').');
          var genesisDid = self.view._envelope && self.view._envelope.did;
          var list = (data.versions || []).map(function (r, i) {
            return {
              cid: r.cid, prevCid: r.prevCid, at: new Date(r.createdAt), seq: i + 1,
              title: r.title || '', did: r.lastEditedBy || genesisDid || null,
              attributed: !!r.lastEditedBy,
            };
          });
          if (!list.length) return self._listMessage('No versions.');
          self.versions = list;
          var dids = list.map(function (x) { return x.did; });
          self.view._resolveHandles(dids, function (map) {
            self.handles = map || {};
            self._group();
            self._renderList();
            self._select(self.groups[0].newest.cid);
          });
        });
      },

      // Newest group first. A group breaks on a change of author or on a gap
      // of more than GAP_MS between two consecutive versions.
      _group: function () {
        var groups = [], cur = null, prev = null;
        this.versions.forEach(function (ver) {
          if (!cur || ver.did !== cur.did || ver.at - prev.at > GAP_MS) {
            cur = { did: ver.did, versions: [], first: ver };
            groups.push(cur);
          }
          cur.versions.push(ver);
          cur.newest = ver;
          prev = ver;
        });
        groups.forEach(function (g, i) { g.index = i; g.prevGroup = i > 0 ? groups[i - 1] : null; });
        this.groups = groups.reverse();
        this.head = this.versions[this.versions.length - 1];
      },

      _snapshotOf: function (cid, thenDo) {
        var self = this;
        if (this.cache[cid]) return thenDo(null, this.cache[cid]);
        this._getJson(this._url('/at/' + encodeURIComponent(cid)), function (err, data) {
          if (err) return thenDo(err);
          var env = data.envelope || data;
          var payload = env.record && env.record.payload;
          var snap = (payload && payload.snapshot) || null;
          self.cache[cid] = { envelope: env, snapshot: snap };
          thenDo(null, self.cache[cid]);
        });
      },

    },

    'list', {

      _listMessage: function (text) {
        this.listEl.innerHTML = '';
        this.listEl.appendChild(el('div', 'wh-empty', text));
      },

      _handleOf: function (did) {
        var h = this.handles[did];
        return h || (did ? lively.identity.postCardUtils.truncateDid(did) : 'unknown');
      },

      _personAvatar: function (did, size) {
        var h = this.handles[did];
        var img = document.createElement('img');
        img.style.cssText = 'width:' + size + 'px;height:' + size + 'px;border-radius:50%;flex:0 0 auto;';
        this.view._loadAvatarInto(img, h || null);
        if (!h) img.src = lively.identity.postCardUtils.identiconDataUrl(did || '', size * 2);
        return img;
      },

      _renderList: function () {
        var self = this;
        this.listEl.innerHTML = '';
        this.rowEls = {};
        this.groups.forEach(function (g) {
          var multi = g.versions.length > 1;
          var row = el('div', 'wh-grp');
          row.appendChild(self._personAvatar(g.did, 26));
          var col = el('div', 'wh-col');
          col.appendChild(el('div', 'wh-who', '@' + self._handleOf(g.did)));
          var when = sameDay(g.first.at, g.newest.at)
            ? fmtDay(g.newest.at) + ', ' + fmtTime(g.first.at) + (multi ? ' – ' + fmtTime(g.newest.at) : '')
            : fmtFull(g.first.at) + ' – ' + fmtFull(g.newest.at);
          col.appendChild(el('div', 'wh-meta', (multi ? g.versions.length + ' edits · ' : '') + when));
          row.appendChild(col);
          if (g.newest === self.head) row.appendChild(el('span', 'wh-badge', 'Current'));
          var chev = null;
          if (multi) {
            chev = icon('chevron_right');
            chev.classList.add('wh-chev');
            row.appendChild(chev);
          }
          self.listEl.appendChild(row);
          self.rowEls[g.newest.cid] = self.rowEls[g.newest.cid] || [];
          self.rowEls[g.newest.cid].push(row);

          var sub = null;
          if (multi) {
            sub = el('div', '');
            sub.style.display = 'none';
            g.versions.slice().reverse().forEach(function (ver, i, arr) {
              var vr = el('div', 'wh-ver');
              var prevVer = arr[i + 1] || null;
              var label = fmtTime(ver.at) + (i === 0 && g.newest === self.head ? ' · current' : '');
              if (prevVer && prevVer.title !== ver.title) label += ' · title changed';
              vr.appendChild(el('span', '', 'v' + ver.seq));
              vr.appendChild(el('span', 'wh-meta', label));
              vr.addEventListener('click', function (e) { e.stopPropagation(); self._select(ver.cid, true); });
              sub.appendChild(vr);
              (self.rowEls[ver.cid] = self.rowEls[ver.cid] || []).push(vr);
            });
            self.listEl.appendChild(sub);
          }
          row.addEventListener('click', function () {
            if (multi) {
              var open = sub.style.display === 'none';
              sub.style.display = open ? '' : 'none';
              chev.classList.toggle('wh-open', open);
            }
            self._select(g.newest.cid, false);
          });
        });
      },

      _markSelected: function () {
        var self = this;
        Object.keys(this.rowEls || {}).forEach(function (cid) {
          self.rowEls[cid].forEach(function (r) {
            // a group row and its newest version share a cid; only highlight
            // the one the user actually picked
            var isGroupRow = r.classList.contains('wh-grp');
            var on = self.sel && cid === self.sel.cid && isGroupRow === !self.sel.individual;
            r.classList.toggle('wh-sel', !!on);
          });
        });
      },

    },

    'selection', {

      // individual: true when a single version was picked inside an expanded
      // group (compare against the version before it), false for a whole group
      // row (compare against the previous group's last version).
      _select: function (cid, individual) {
        var ver = this._versionByCid(cid);
        if (!ver) return;
        var base = null;
        if (individual) {
          var i = this.versions.indexOf(ver);
          base = i > 0 ? this.versions[i - 1] : null;
        } else {
          var g = this._groupOf(ver);
          base = g && this._prevGroupNewest(g);
        }
        this.sel = { cid: cid, baseCid: base ? base.cid : null, individual: !!individual };
        this._markSelected();
        this._renderPane();
      },

      _versionByCid: function (cid) {
        return this.versions.filter(function (x) { return x.cid === cid; })[0] || null;
      },
      _groupOf: function (ver) {
        return this.groups.filter(function (g) { return g.versions.indexOf(ver) >= 0; })[0] || null;
      },
      _prevGroupNewest: function (g) {
        var i = this.groups.indexOf(g);
        var older = this.groups[i + 1];
        return older ? older.newest : null;
      },

    },

    'pane', {

      _renderPane: function () {
        var self = this, token = ++this._token;
        var sel = this.sel;
        var ver = this._versionByCid(sel.cid);
        var wantBase = this.mode === 'changes'
          ? (this.compare === 'current' ? null : sel.baseCid) : null;
        this._paneHead(ver);
        this.contentEl.innerHTML = '';
        this.contentEl.appendChild(el('div', 'wh-empty', 'Loading…'));
        this.contentEl.scrollTop = 0;

        this._snapshotOf(sel.cid, function (err, cur) {
          if (token !== self._token) return;
          if (err) return self._paneError('Could not load this version (' + err.message + ').');
          if (self.mode === 'page') return self._showPage(cur);
          if (self.compare === 'current') {
            if (sel.cid === self.head.cid) return self._showDiff(null, cur, 'This is the current version.');
            return self._snapshotOf(self.head.cid, function (err2, head) {
              if (token !== self._token) return;
              if (err2) return self._paneError('Could not load the current version.');
              self._showDiff(cur, head, 'Changes since this version');
            });
          }
          if (!wantBase) return self._showDiff(null, cur, 'Created the page');
          self._snapshotOf(wantBase, function (err2, base) {
            if (token !== self._token) return;
            if (err2) return self._paneError('Could not load the previous version.');
            self._showDiff(base, cur, 'Changes made in this version');
          });
        });
      },

      _paneError: function (msg) {
        this.contentEl.innerHTML = '';
        var d = el('div', 'wh-empty', msg);
        d.style.color = '#c33';
        this.contentEl.appendChild(d);
      },

      _paneHead: function (ver) {
        var self = this;
        var h = this.paneHeadEl;
        h.innerHTML = '';
        h.style.display = '';
        var who = el('span', '');
        who.style.cssText = 'display:inline-flex;align-items:center;gap:6px;';
        who.appendChild(this._personAvatar(ver.did, 20));
        who.appendChild(el('b', '', '@' + this._handleOf(ver.did)));
        who.appendChild(el('span', '', 'saved ' + fmtFull(ver.at)));
        h.appendChild(who);

        var seg = el('span', 'wh-seg');
        [['changes', 'Changes'], ['page', 'Page']].forEach(function (m) {
          var b = el('button', self.mode === m[0] ? 'wh-on' : '', m[1]);
          b.addEventListener('click', function (e) {
            e.stopPropagation();
            if (self.mode === m[0]) return;
            self.mode = m[0];
            self._renderPane();
          });
          seg.appendChild(b);
        });
        h.appendChild(seg);

        if (this.mode === 'changes') {
          var sel = el('select', 'wh-select');
          [['previous', 'Compare with previous'], ['current', 'Compare with current']].forEach(function (o) {
            var opt = el('option', '', o[1]);
            opt.value = o[0];
            if (self.compare === o[0]) opt.selected = true;
            sel.appendChild(opt);
          });
          sel.addEventListener('change', function () {
            self.compare = sel.value;
            self._renderPane();
          });
          ['mousedown', 'click'].forEach(function (t) { sel.addEventListener(t, function (e) { e.stopPropagation(); }); });
          h.appendChild(sel);
          this.statEl = el('span', 'wh-stat');
          h.appendChild(this.statEl);
        }

        // Restore: only for someone who can edit the page, and not for the
        // version that is already current.
        if (this.view._canEdit && ver !== this.head) {
          var rb = el('button', 'wh-restore');
          rb.appendChild(icon('restore'));
          rb.appendChild(el('span', '', 'Restore this version'));
          rb.addEventListener('click', function (e) { e.stopPropagation(); self._confirmRestore(ver); });
          h.appendChild(rb);
        }
      },

      _confirmRestore: function (ver) {
        var self = this;
        var esc = lively.identity.postCardUtils.escapeHtml;
        var scrim = document.createElement('div');
        scrim.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:10000;background:rgba(0,0,0,0.35);' +
          'display:flex;align-items:center;justify-content:center;font-family:sans-serif;';
        var box = document.createElement('div');
        box.style.cssText = 'width:400px;max-width:calc(100vw - 32px);background:#fff;border-radius:12px;' +
          'box-shadow:0 8px 30px rgba(0,0,0,0.3);padding:20px;box-sizing:border-box;color:#333;';
        box.innerHTML =
          '<div style="font-size:16px;font-weight:600;margin-bottom:8px;">Restore this version?</div>' +
          '<div style="font-size:13px;line-height:1.45;color:#555;">The page content goes back to how it was when ' +
          '<b>@' + esc(this._handleOf(ver.did)) + '</b> saved it on ' + esc(fmtFull(ver.at)) + '. ' +
          'This is saved as a new version, so the current content stays in the history. ' +
          'Category, tags and edit permissions are not changed. Anyone editing the page right now will see it change.</div>' +
          '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px;"></div>';
        var row = box.lastChild;
        function btn(text, bg, color) {
          var b = document.createElement('button');
          b.textContent = text;
          b.style.cssText = 'border:none;border-radius:8px;padding:7px 16px;font-size:13px;cursor:pointer;background:' + bg + ';color:' + color + ';';
          return b;
        }
        var cancel = btn('Cancel', '#eee', '#333'), ok = btn('Restore', ACCENT, '#fff');
        row.appendChild(cancel);
        row.appendChild(ok);
        scrim.appendChild(box);
        document.body.appendChild(scrim);
        var close = function () { scrim.remove(); };
        cancel.addEventListener('click', close);
        scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) close(); });
        ok.addEventListener('click', function () {
          close();
          self._restore(ver);
        });
      },

      // Hands the version's content to the view, which opens the editor on it
      // (the editor applies it and saves a new version -- see
      // WikiEditor._applyRestore).
      _restore: function (ver) {
        var self = this;
        this._snapshotOf(ver.cid, function (err, entry) {
          if (err || !entry.snapshot) return self._paneError('Could not load that version to restore it.');
          var payload = entry.envelope.record && entry.envelope.record.payload;
          self.view._restoreVersion({
            snapshot: entry.snapshot,
            attachments: (payload && payload.attachments) || [],
            fromCid: ver.cid,
          });
        });
      },

      _showPage: function (cur) {
        var u = lively.identity.postCardUtils;
        this.contentEl.innerHTML = cur.snapshot
          ? u.snapshotToHtml(cur.snapshot)
          : '<div class="wh-empty">No content in this version.</div>';
        u.hydrateEmbeddedParts(this.contentEl);
        u.hydrateLinkPreviewEmbeds(this.contentEl);
      },

      // oldEntry null => everything counts as added (first version) -- unless
      // `note` says there is nothing to compare, in which case show that.
      _showDiff: function (oldEntry, newEntry, note) {
        var u = lively.identity.postCardUtils, W = lively.identity.wikiDiff;
        if (note === 'This is the current version.') {
          this.contentEl.innerHTML = '';
          this.contentEl.appendChild(el('div', 'wh-empty', note + ' Pick an older version to see what has changed since.'));
          if (this.statEl) this.statEl.textContent = '';
          return;
        }
        var diff = W.diffSnapshots(oldEntry && oldEntry.snapshot, newEntry.snapshot);
        var html = W.renderHtml(diff, {
          renderNode: function (node) { return u.snapshotToHtml({ content: [node] }); },
        });
        this.contentEl.innerHTML = '';
        this.contentEl.appendChild(el('div', 'wh-stat', note)).style.marginBottom = '8px';
        var box = el('div', '');
        box.innerHTML = diff.changed || !oldEntry
          ? html
          : '<div class="wh-empty">No changes to the page content in this version.</div>';
        this.contentEl.appendChild(box);
        if (this.statEl) {
          var s = diff.stats;
          this.statEl.innerHTML = '<b class="a">+' + s.added + '</b> added · <b class="r">−' + s.removed +
            '</b> removed · <b class="m">~' + s.modified + '</b> edited';
        }
      },

    });

    Object.extend(lively.identity.WikiHistory, {
      // The diff-line styles (.wh-*), for other places that show a WikiDiff.
      injectStyle: injectStyle,

      // Opens (or returns the already open) history panel inside a WikiView.
      open: function (view) {
        if (view._history) return view._history;
        var h = new lively.identity.WikiHistory(view);
        view._history = h;
        h.open();
        return h;
      },
    });

  }); // end module('lively.identity.WikiHistory')
