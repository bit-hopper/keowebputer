/**
 * lively.identity.MailboxThread
 *
 * The comments under a postcard: the original card, every reply to it
 * (nested), and a composer for answering. Used in two places:
 *
 *   - Inside the Mailbox's Inbox tab, when the author opens a thread row
 *     (opts.inbox: reads GET /@:handle/inbox/threads/:rootObjId, marks the
 *     thread read, and offers Mute).
 *   - In its own small window, opened from a card's ⋯ menu, which is how
 *     someone other than the author answers a card (openWindow below).
 *
 * Replies are ordinary postcard envelopes carrying replyTo: {objId, anchor},
 * saved with PUT /@:handle/:objId. The server screens each new reply (block
 * lists in both directions; a blocked reply is returned and never shown) and
 * files a notification in the card author's inbox. Replies to a private or
 * shared card are encrypted to the people who need to read them: the card's
 * author, and the author of the reply being answered. Replies to a public
 * card are public. A reply holds text and at most one photo, GIF or video.
 *
 * Entry points:
 *   lively.identity.mailboxThread.mount(containerEl, opts) -> controller
 *     opts.rootHandle  handle of the card's author (blob URLs, "Open card")
 *     opts.rootObjId   the card being replied to
 *     opts.title       fallback title if the card has none
 *     opts.inbox       true when the viewer is the author reading their inbox
 *     opts.onBack      if set, a Back button is shown and calls this
 *     opts.onRead      called after the thread is marked read (inbox only)
 *     opts.compact     omit the header and original-card summary (the homestar reel
 *                      shows the thread under a card that is already on screen)
 *   lively.identity.mailboxThread.openWindow(rootHandle, rootObjId, title)
 *
 * All styling is scoped under .mbt-root so it can't leak into the host.
 */

module('lively.identity.MailboxThread')
  .requires(
    'lively.identity.DID',
    'lively.identity.PostCardUtils',
    'lively.identity.PostCardSerializer',
    'lively.identity.WebAuthn',
    'lively.identity.WebKey',
    'lively.identity.Crypto',
    'lively.identity.FileCrypto'
  )
  .toRun(function () {

    lively.identity = lively.identity || {};

    var MAX_DEPTH_INDENT = 3; // deeper replies stay at the last indent level
    // How many levels of replies the server will return and accept (the
    // server's REPLY_TREE_MAX_DEPTH). A reply to a reply already this deep
    // is attached to that reply's parent instead, shown right beside it.
    var MAX_REPLY_DEPTH = 12;

    function _ensureStyle() {
      var STYLE_ID = 'mailbox-thread-style';
      if (document.getElementById(STYLE_ID)) return;
      var s = document.createElement('style');
      s.id = STYLE_ID;
      s.textContent = [
        '.mbt-root { --mbt-bg:#fafafa; --mbt-surface:#fff; --mbt-border:#e4e4e7; --mbt-border-strong:#d4d4d8;',
        '  --mbt-text:#18181b; --mbt-text2:#52525b; --mbt-text3:#71717a;',
        '  --mbt-accent:#15803d; --mbt-accent-ink:#fff; --mbt-accent-soft:#f0fdf4; --mbt-accent-soft-border:#bbf7d0;',
        '  --mbt-danger:#e11d48; --mbt-danger-soft:#fff1f2;',
        '  --mbt-font:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;',
        '  display:flex; flex-direction:column; width:100%; height:100%; background:var(--mbt-bg); color:var(--mbt-text);',
        '  font-family:var(--mbt-font); font-size:13px; box-sizing:border-box; position:relative; }',
        '.mbt-root * { box-sizing:border-box; }',
        // The hidden attribute alone loses to the display:flex rules below.
        '.mbt-root [hidden] { display:none !important; }',
        // Icons are <i> elements, which browsers italicize; without font-style:normal every glyph renders slanted.
        '.mbt-ic { font-family:"Material Symbols Rounded"; font-style:normal; font-size:18px; line-height:1; width:1em; height:1em; overflow:hidden; display:inline-block; vertical-align:middle; flex:none; }',
        '.mbt-btn { display:inline-flex; align-items:center; gap:5px; font-family:var(--mbt-font); font-size:12px; font-weight:600;',
        '  padding:6px 11px; border-radius:999px; border:1px solid var(--mbt-border-strong); background:var(--mbt-surface);',
        '  color:var(--mbt-text); cursor:pointer; }',
        '.mbt-btn:hover:not(:disabled) { border-color:var(--mbt-text3); }',
        '.mbt-btn:disabled { opacity:.5; cursor:default; }',
        '.mbt-btn.accent { background:var(--mbt-accent); border-color:var(--mbt-accent); color:var(--mbt-accent-ink); }',
        '.mbt-btn.ghost { border-color:transparent; background:transparent; color:var(--mbt-text2); }',
        // An icon-only button is a true circle, not a pill with stretched padding.
        '.mbt-btn.icon { width:34px; height:34px; padding:0; justify-content:center; border-radius:50%; }',
        '.mbt-btn.ghost:hover:not(:disabled) { background:var(--mbt-bg); border-color:var(--mbt-border); }',
        '.mbt-head { display:flex; align-items:center; gap:8px; padding:8px 12px; background:var(--mbt-surface); border-bottom:1px solid var(--mbt-border); flex:none; }',
        '.mbt-head .t { flex:1; min-width:0; font-weight:650; font-size:13.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
        '.mbt-scroll { flex:1; min-height:0; overflow-y:auto; padding:12px; display:flex; flex-direction:column; gap:10px; }',
        '.mbt-orig { background:var(--mbt-surface); border:1px solid var(--mbt-border); border-radius:12px; padding:12px; display:flex; gap:12px; align-items:center; }',
        '.mbt-thumb { width:84px; height:60px; border-radius:8px; flex:none; position:relative; box-shadow:inset 0 0 0 1px rgba(0,0,0,.08); }',
        '.mbt-thumb:after { content:""; position:absolute; top:5px; right:5px; width:13px; height:17px; border-radius:2px; border:1.5px dashed rgba(255,255,255,.85); background:rgba(255,255,255,.25); }',
        '.mbt-orig .info { flex:1; min-width:0; display:flex; flex-direction:column; gap:3px; }',
        '.mbt-orig .name { font-weight:650; font-size:14px; }',
        '.mbt-orig .meta { font-size:12px; color:var(--mbt-text2); display:flex; flex-wrap:wrap; gap:3px 10px; }',
        '.mbt-orig .meta span { display:inline-flex; gap:3px; align-items:center; }',
        '.mbt-orig .meta .mbt-ic { font-size:14px; color:var(--mbt-text3); }',
        '.mbt-sect { font-size:11px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--mbt-text3); padding-top:4px; }',
        '.mbt-empty { color:var(--mbt-text3); text-align:center; padding:28px 0; }',
        '.mbt-rp { display:flex; flex-direction:column; }',
        '.mbt-rp-row { display:flex; gap:10px; align-items:stretch; }',
        '.mbt-avcol { display:flex; flex-direction:column; align-items:center; width:30px; flex:none; }',
        '.mbt-av { width:30px; height:30px; border-radius:50%; flex:none; border:1px solid var(--mbt-border); object-fit:cover; background:#fff; }',
        // Threading: a rail drops from under a parent\'s avatar (its centre
        // line, x=15) alongside the parent bubble, then each reply is joined
        // by an elbow: straight down the rail, one rounded corner, straight
        // across into the reply\'s own avatar (the same L the rooms chat
        // draws from a reply back to its parent). Each .mbt-kid is 26px of
        // left padding wide (the horizontal leg) and 10px of top padding
        // tall (the gap above it, which the rail crosses); the corner sits
        // at the avatar\'s vertical centre, 10 + 15 = 25px down.
        '.mbt-rail { flex:1; width:2px; margin-top:4px; background:var(--mbt-border-strong); border-radius:1px; }',
        '.mbt-bubble { flex:1; min-width:0; background:var(--mbt-surface); border:1px solid var(--mbt-border); border-radius:12px; padding:8px 12px 6px; }',
        '.mbt-rp.fresh > .mbt-rp-row .mbt-bubble { background:var(--mbt-accent-soft); border-color:var(--mbt-accent-soft-border); }',
        '.mbt-rh { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; }',
        '.mbt-who { font-weight:650; }',
        '.mbt-tm { font-size:11.5px; color:var(--mbt-text3); }',
        '.mbt-pill { font-size:10.5px; font-weight:700; padding:0 7px; border-radius:999px; background:var(--mbt-accent); color:var(--mbt-accent-ink); }',
        '.mbt-pill.you { background:var(--mbt-bg); color:var(--mbt-text2); border:1px solid var(--mbt-border); }',
        '.mbt-body { margin:3px 0 4px; font-size:13.5px; line-height:1.45; overflow-wrap:anywhere; user-select:text; }',
        '.mbt-body p { margin:0 0 4px; }',
        '.mbt-body img, .mbt-body video { max-width:100%; max-height:300px; border-radius:10px; display:block; }',
        '.mbt-body .lively-attachment-placeholder { max-width:100%; max-height:300px; border-radius:10px; }',
        '.mbt-locked { color:var(--mbt-text3); font-style:italic; }',
        '.mbt-link { font-family:var(--mbt-font); font-size:12px; font-weight:600; color:var(--mbt-text2); background:none; border:0; padding:2px 8px 2px 0; cursor:pointer; display:inline-flex; gap:4px; align-items:center; }',
        '.mbt-link:hover { color:var(--mbt-accent); }',
        '.mbt-link .mbt-ic { font-size:15px; }',
        '.mbt-kids { margin:0 0 0 14px; display:flex; flex-direction:column; }',
        '.mbt-kid { position:relative; padding:10px 0 0 26px; }',
        '.mbt-kid:before { content:""; position:absolute; left:0; top:0; width:26px; height:26px; box-sizing:border-box;',
        '  border-left:2px solid var(--mbt-border-strong); border-bottom:2px solid var(--mbt-border-strong); border-bottom-left-radius:11px; }',
        '.mbt-kid:not(:last-child):after { content:""; position:absolute; left:0; top:26px; bottom:0; border-left:2px solid var(--mbt-border-strong); }',
        // Past the indent limit replies stay at one level, with no connectors.
        '.mbt-kids.flat { margin-left:0; }',
        '.mbt-kids.flat > .mbt-kid { padding-left:0; }',
        '.mbt-kids.flat > .mbt-kid:before, .mbt-kids.flat > .mbt-kid:after { display:none; }',
        '.mbt-composer { border-top:1px solid var(--mbt-border); background:var(--mbt-surface); padding:10px 12px 8px; display:flex; flex-direction:column; gap:6px; flex:none; position:relative; }',
        '.mbt-target { font-size:12px; color:var(--mbt-text2); background:var(--mbt-bg); border:1px solid var(--mbt-border); border-radius:999px; padding:2px 4px 2px 10px; display:inline-flex; align-items:center; gap:4px; align-self:flex-start; }',
        '.mbt-target button, .mbt-att button { border:0; background:transparent; color:var(--mbt-text3); cursor:pointer; padding:2px; display:grid; place-items:center; }',
        '.mbt-att { display:inline-flex; align-items:center; gap:8px; align-self:flex-start; background:var(--mbt-bg); border:1px solid var(--mbt-border); border-radius:10px; padding:4px; font-size:12px; color:var(--mbt-text2); max-width:100%; }',
        '.mbt-att img { width:44px; height:32px; object-fit:cover; border-radius:6px; }',
        '.mbt-att .vid { width:44px; height:32px; border-radius:6px; background:var(--mbt-border); display:grid; place-items:center; }',
        '.mbt-att .nm { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:220px; }',
        '.mbt-row { display:flex; gap:8px; align-items:flex-end; }',
        '.mbt-composer textarea { flex:1; min-width:0; resize:none; font-family:var(--mbt-font); font-size:13.5px; color:var(--mbt-text); background:var(--mbt-bg); border:1px solid var(--mbt-border); border-radius:12px; padding:8px 12px; outline:0; max-height:120px; }',
        '.mbt-composer textarea:focus { border-color:var(--mbt-accent); }',
        '.mbt-note { font-size:11.5px; color:var(--mbt-text3); display:flex; gap:4px; align-items:center; }',
        '.mbt-note.err { color:var(--mbt-danger); }',
        '.mbt-note .mbt-ic { font-size:14px; }',
        '.mbt-menu { position:absolute; left:12px; bottom:calc(100% - 4px); background:var(--mbt-surface); border:1px solid var(--mbt-border); border-radius:12px; box-shadow:0 8px 24px rgba(24,24,27,.14); padding:4px; display:flex; flex-direction:column; min-width:170px; z-index:6; }',
        '.mbt-menu button { font-family:var(--mbt-font); font-size:13px; text-align:left; border:0; background:transparent; color:var(--mbt-text); padding:8px 10px; border-radius:8px; cursor:pointer; display:flex; gap:10px; align-items:center; }',
        '.mbt-menu button:hover { background:var(--mbt-bg); }',
        '.mbt-toast { position:absolute; left:50%; bottom:92px; transform:translateX(-50%); background:var(--mbt-text); color:#fff; border-radius:999px; padding:7px 14px; font-size:12.5px; font-weight:600; z-index:7; max-width:calc(100% - 24px); }',
      ].join('\n');
      document.head.appendChild(s);
    }

    // ── small helpers ────────────────────────────────────────────────────────

    function el(tag, className, text) {
      var e = document.createElement(tag);
      if (className) e.className = className;
      if (text != null) e.textContent = text;
      return e;
    }
    function icon(name) { return el('i', 'mbt-ic', name); }
    function btn(label, iconName, className) {
      var b = el('button', 'mbt-btn' + (className ? ' ' + className : ''));
      b.type = 'button';
      if (iconName) b.appendChild(icon(iconName));
      if (label) b.appendChild(document.createTextNode(label));
      return b;
    }

    function xhrJson(method, url, body, thenDo) {
      var xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Accept', 'application/json');
      if (body !== undefined) xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onload = function () {
        var data = null;
        try { data = JSON.parse(xhr.responseText); } catch (e) { /* non-JSON body */ }
        if (xhr.status >= 200 && xhr.status < 300) return thenDo(null, data);
        thenDo(new Error((data && data.error) || ('status ' + xhr.status)), data);
      };
      xhr.onerror = function () { thenDo(new Error('network error')); };
      xhr.send(body === undefined ? null : JSON.stringify(body));
    }

    function relTime(iso) {
      if (!iso) return '';
      var m = Math.max(0, (Date.now() - new Date(iso).getTime()) / 60000);
      if (m < 1) return 'now';
      if (m < 60) return Math.round(m) + 'm';
      if (m < 1440) return Math.round(m / 60) + 'h';
      if (m < 43200) return Math.round(m / 1440) + 'd';
      return new Date(iso).toLocaleDateString();
    }

    function hueOf(str) {
      var h = 0;
      for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
      return h;
    }

    var _avatarCache = {}; // handle -> avatarUrl|null (or pending callbacks)
    function loadAvatar(handle, imgEl) {
      imgEl.src = lively.identity.postCardUtils.identiconDataUrl(handle || '', 30);
      if (!handle) return;
      var cached = _avatarCache[handle];
      if (cached === null) return;
      if (typeof cached === 'string') { imgEl.src = cached; return; }
      var base = lively.identity.did.baseUrl();
      fetch(base + '/@' + encodeURIComponent(handle) + '/profile', { credentials: 'include' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (env) {
          var url = env && env.record && env.record.payload && env.record.payload.avatarUrl;
          _avatarCache[handle] = url || null;
          if (url) imgEl.src = url;
        })
        .catch(function () { _avatarCache[handle] = null; });
    }

    // handle -> { did, handle, x25519PublicKey }, with the same profile CID
    // integrity check PostCardEditor._resolveRecipientPubKeys does before
    // trusting a key a DEK will be sealed to (postcard-audit F22).
    function resolveRecipient(handle, thenDo) {
      var base = lively.identity.did.baseUrl();
      lively.identity.webKey.resolveHandle(handle, function (err, info) {
        if (err || !info || !info.did) return thenDo(new Error('Could not find @' + handle));
        xhrJson('GET', base + '/@' + encodeURIComponent(handle) + '/profile', undefined, function (err, env) {
          var pub = env && env.record && env.record.payload && env.record.payload.accountX25519Pub;
          if (err || !pub) return thenDo(new Error('@' + handle + ' has no encryption key yet'));
          lively.identity.crypto.computeCid(env.record.payload, function (cidErr, cid) {
            if (cidErr || cid !== env.record.cid) return thenDo(new Error('@' + handle + "'s key failed its integrity check"));
            thenDo(null, { did: info.did, handle: handle, x25519PublicKey: pub });
          });
        });
      });
    }

    function resolveRecipients(handles, thenDo) {
      var out = [];
      (function next(i) {
        if (i >= handles.length) return thenDo(null, out);
        resolveRecipient(handles[i], function (err, r) {
          if (err) return thenDo(err);
          out.push(r);
          next(i + 1);
        });
      })(0);
    }

    // The encrypted-reply path needs the account KEK; a restored session may
    // not have it cached yet, so derive it on demand (one passkey prompt),
    // the same self-contained ceremony _unwrapDekForEnvelope does.
    function ensureKek(thenDo) {
      var wa = lively.identity.webAuthn;
      var user = lively.identity.did.currentUser();
      if (wa && wa._kekCache && wa._kekCache[user.credentialId]) return thenDo(null);
      var ch = new Uint8Array(32);
      crypto.getRandomValues(ch);
      wa.deriveKek({ credentialId: user.credentialId, rpId: user.rpId, challenge: ch }, function (err) { thenDo(err || null); });
    }

    // env -> { snapshot, attachments } for a reply, decrypting if needed.
    function decodeReply(env, thenDo) {
      if (env.visibility === 'public') {
        var p = env.record && env.record.payload;
        var snap = p && (p.format === 'prosemirror-doc-v1' ? p.doc : p.snapshot);
        return thenDo(null, { snapshot: snap || null, attachments: (p && p.attachments) || [] });
      }
      lively.identity.postCardSerializer.deserializeEncryptedAuto(env, function (err, kind, content, payload) {
        if (err) return thenDo(err);
        if (kind !== 'plain') return thenDo(new Error('unsupported reply format'));
        thenDo(null, { snapshot: content, attachments: (payload && payload.attachments) || [] });
      });
    }

    // ── controller ───────────────────────────────────────────────────────────

    function Thread(container, opts) {
      this.container = container;
      this.opts = opts;
      this.state = null;      // server payload
      this.decoded = {};      // objId -> { snapshot, attachments } | { error }
      this.replyTo = null;    // objId the reply will be filed under (null = the card)
      this.replyShown = null; // objId the user clicked Reply on, when that was too deep to nest under
      this.attachFile = null; // File chosen in the composer
      this.sending = false;
      this.destroyed = false;
      this.user = lively.identity.did.currentUser();
      this.build();
      this.load();
    }

    Thread.prototype.destroy = function () {
      this.destroyed = true;
      if (this.container) this.container.innerHTML = '';
    };

    Thread.prototype.reload = function () { this.load(); };

    Thread.prototype.build = function () {
      var self = this;
      _ensureStyle();
      var c = this.container;
      c.innerHTML = '';
      c.classList.add('mbt-root');

      this.headEl = el('div', 'mbt-head');
      c.appendChild(this.headEl);

      this.scrollEl = el('div', 'mbt-scroll');
      this.scrollEl.appendChild(el('div', 'mbt-empty', 'Loading…'));
      c.appendChild(this.scrollEl);

      var comp = el('div', 'mbt-composer');
      this.compEl = comp;
      this.targetEl = el('div', 'mbt-target');
      this.targetEl.hidden = true;
      comp.appendChild(this.targetEl);
      this.attEl = el('div', 'mbt-att');
      this.attEl.hidden = true;
      comp.appendChild(this.attEl);

      this.menuEl = el('div', 'mbt-menu');
      this.menuEl.hidden = true;
      [['image', 'Photo or GIF', 'image/*'], ['videocam', 'Video', 'video/*']].forEach(function (k) {
        var b = el('button');
        b.type = 'button';
        b.appendChild(icon(k[0]));
        b.appendChild(document.createTextNode(k[1]));
        b.addEventListener('click', function () { self.menuEl.hidden = true; self.pickFile(k[2]); });
        self.menuEl.appendChild(b);
      });
      comp.appendChild(this.menuEl);

      var row = el('div', 'mbt-row');
      this.attachBtn = btn('', 'add_circle', 'ghost icon');
      this.attachBtn.title = 'Attach a photo, GIF or video';
      this.attachBtn.setAttribute('aria-label', 'Attach a photo, GIF or video');
      this.attachBtn.addEventListener('click', function () { self.menuEl.hidden = !self.menuEl.hidden; });
      row.appendChild(this.attachBtn);
      this.textEl = document.createElement('textarea');
      this.textEl.rows = 1;
      this.textEl.setAttribute('aria-label', 'Write a reply');
      this.textEl.addEventListener('input', function () {
        self.textEl.style.height = 'auto';
        self.textEl.style.height = Math.min(self.textEl.scrollHeight, 120) + 'px';
        self.syncSend();
      });
      this.textEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); self.send(); }
      });
      row.appendChild(this.textEl);
      this.sendBtn = btn('Send', 'send', 'accent');
      this.sendBtn.disabled = true;
      this.sendBtn.addEventListener('click', function () { self.send(); });
      row.appendChild(this.sendBtn);
      comp.appendChild(row);

      this.noteEl = el('div', 'mbt-note');
      comp.appendChild(this.noteEl);
      c.appendChild(comp);

      // A signed-out viewer can read a public thread but not answer it.
      if (!this.user) {
        comp.hidden = true;
      }
    };

    Thread.prototype.toast = function (msg) {
      var t = el('div', 'mbt-toast', msg);
      this.container.appendChild(t);
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2600);
    };

    Thread.prototype.syncSend = function () {
      this.sendBtn.disabled = this.sending || !(this.textEl.value.trim() || this.attachFile);
    };

    Thread.prototype.setNote = function (text, isError, iconName) {
      this.noteEl.className = 'mbt-note' + (isError ? ' err' : '');
      this.noteEl.innerHTML = '';
      if (!text) return;
      this.noteEl.appendChild(icon(isError ? 'error' : (iconName || 'public')));
      this.noteEl.appendChild(document.createTextNode(text));
    };

    // ── loading ──────────────────────────────────────────────────────────────

    Thread.prototype.load = function () {
      var self = this;
      var base = lively.identity.did.baseUrl();
      var o = this.opts;
      var url = o.inbox
        ? base + '/@' + encodeURIComponent(this.user.handle) + '/inbox/threads/' + encodeURIComponent(o.rootObjId)
        : base + '/@' + encodeURIComponent(o.rootHandle) + '/' + encodeURIComponent(o.rootObjId) + '/thread';
      xhrJson('GET', url, undefined, function (err, data) {
        if (self.destroyed) return;
        if (err || !data) {
          self.scrollEl.innerHTML = '';
          self.scrollEl.appendChild(el('div', 'mbt-empty', 'Could not load this thread (' + (err ? err.message : 'no data') + ').'));
          return;
        }
        self.state = data;
        self.decodeAll(function () {
          if (self.destroyed) return;
          self.render();
          if (o.inbox) {
            xhrJson('POST', base + '/@' + encodeURIComponent(self.user.handle) + '/inbox/threads/' + encodeURIComponent(o.rootObjId) + '/read', {}, function () {
              if (o.onRead) o.onRead();
            });
          }
        });
      });
    };

    // One at a time: the first encrypted reply may need a passkey prompt to
    // derive the account key, and parallel prompts would stack.
    Thread.prototype.decodeAll = function (thenDo) {
      var self = this;
      var replies = this.state.replies;
      (function next(i) {
        if (self.destroyed) return;
        if (i >= replies.length) return thenDo();
        var env = replies[i];
        if (self.decoded[env.objId] && self.decoded[env.objId].cid === env.record.cid) return next(i + 1);
        decodeReply(env, function (err, d) {
          self.decoded[env.objId] = err ? { error: err, cid: env.record.cid } : { snapshot: d.snapshot, attachments: d.attachments, cid: env.record.cid };
          next(i + 1);
        });
      })(0);
    };

    // ── rendering ────────────────────────────────────────────────────────────

    Thread.prototype.handleOf = function (did) {
      return (this.state.handles && this.state.handles[did]) || null;
    };

    Thread.prototype.cardTitle = function () {
      var st = this.state.root.state || {};
      return st.title || this.opts.title || 'Untitled postcard';
    };

    Thread.prototype.render = function () {
      var self = this;
      var s = this.state;
      var root = s.root;
      var isInbox = !!this.opts.inbox;

      // header (a compact thread sits under a card that is already on screen, so
      // it has neither the header nor the original-card summary)
      this.headEl.innerHTML = '';
      this.headEl.hidden = !!this.opts.compact;
      if (!this.opts.compact && this.opts.onBack) {
        var back = btn('Inbox', 'arrow_back', 'ghost');
        back.addEventListener('click', function () { self.opts.onBack(); });
        this.headEl.appendChild(back);
      }
      if (!this.opts.compact) this.headEl.appendChild(el('div', 't', 'Replies to “' + this.cardTitle() + '”'));
      if (isInbox) {
        var mute = btn(s.muted ? 'Muted' : 'Mute', s.muted ? 'notifications_off' : 'notifications', 'ghost');
        mute.title = s.muted ? 'Unmute this thread' : 'Mute this thread';
        mute.addEventListener('click', function () { self.toggleMute(); });
        this.headEl.appendChild(mute);
      }

      // body
      var sc = this.scrollEl;
      sc.innerHTML = '';
      if (!this.opts.compact) sc.appendChild(this.renderOrig());

      var replies = s.replies;
      // "New" means sent by someone else after the last time the author
      // opened this thread; only the inbox view tracks that.
      var lastRead = s.lastReadAt || null;
      var fresh = {};
      var nFresh = 0;
      replies.forEach(function (r) {
        if (isInbox && r.did !== (self.user && self.user.did) && (!lastRead || r.created > lastRead)) {
          fresh[r.objId] = true;
          nFresh++;
        }
      });

      sc.appendChild(el('div', 'mbt-sect', 'Comments' + (nFresh ? ' · ' + nFresh + ' new' : '')));

      if (!replies.length) {
        sc.appendChild(el('div', 'mbt-empty', 'No comments yet.'));
      } else {
        var byParent = {};
        var known = {};
        replies.forEach(function (r) { known[r.objId] = true; });
        replies.forEach(function (r) {
          var p = r.replyTo && r.replyTo.objId;
          if (!known[p] && p !== root.objId) p = root.objId; // orphan: show at the top level
          (byParent[p] = byParent[p] || []).push(r);
        });
        Object.keys(byParent).forEach(function (k) {
          byParent[k].sort(function (a, b) { return a.created < b.created ? -1 : a.created > b.created ? 1 : 0; });
        });
        var tree = el('div');
        tree.style.cssText = 'display:flex;flex-direction:column;gap:10px;';
        var hydrate = [];
        (byParent[root.objId] || []).forEach(function (r) {
          tree.appendChild(self.renderNode(r, 0, byParent, fresh, hydrate));
        });
        sc.appendChild(tree);
        hydrate.forEach(function (h) { h(); });
      }

      this.renderTarget();
      this.updateNote();
      var firstFresh = sc.querySelector('.mbt-rp.fresh');
      if (firstFresh) firstFresh.scrollIntoView({ block: 'center' });
    };

    Thread.prototype.renderOrig = function () {
      var self = this;
      var root = this.state.root;
      var wrap = el('div', 'mbt-orig');
      var th = el('span', 'mbt-thumb');
      var h = hueOf(root.objId);
      th.style.background = 'linear-gradient(135deg,hsl(' + h + ' 70% 82%),hsl(' + (h + 45) + ' 65% 70%))';
      wrap.appendChild(th);

      var info = el('div', 'info');
      info.appendChild(el('div', 'name', this.cardTitle()));
      var meta = el('div', 'meta');
      var vis = el('span');
      if (root.visibility === 'public') {
        vis.appendChild(icon('public'));
        vis.appendChild(document.createTextNode('Public' + (root.constellation ? ' in c/' + root.constellation : '')));
      } else {
        vis.appendChild(icon('lock'));
        var to = ((root.record && root.record.recipients) || []).map(function (r) { return self.handleOf(r.did || r); }).filter(Boolean);
        var iAmAuthor = this.user && this.user.did === root.did;
        vis.appendChild(document.createTextNode(iAmAuthor
          ? (to.length ? 'Private, sent to ' + to.map(function (x) { return '@' + x; }).join(', ') : 'Private')
          : 'Private, from @' + (this.handleOf(root.did) || 'unknown')));
      }
      meta.appendChild(vis);
      var when = el('span');
      when.appendChild(icon('schedule'));
      when.appendChild(document.createTextNode('Sent ' + relTime(root.created) + (relTime(root.created) === 'now' ? '' : ' ago')));
      meta.appendChild(when);
      var cnt = el('span');
      cnt.appendChild(icon('mode_comment'));
      var n = this.state.replies.length;
      cnt.appendChild(document.createTextNode(n + (n === 1 ? ' reply' : ' replies')));
      meta.appendChild(cnt);
      info.appendChild(meta);
      wrap.appendChild(info);

      var open = btn('Open card', 'open_in_new');
      open.addEventListener('click', function () {
        lively.require('lively.identity.PostCardView').toRun(function () {
          lively.identity.PostCardView.open(self.opts.rootHandle, root.objId);
        });
      });
      wrap.appendChild(open);
      return wrap;
    };

    Thread.prototype.renderNode = function (r, depth, byParent, fresh, hydrate) {
      var self = this;
      var wrap = el('div', 'mbt-rp' + (fresh[r.objId] ? ' fresh' : ''));
      wrap.id = 'mbt-' + r.objId;
      var row = el('div', 'mbt-rp-row');
      var handle = this.handleOf(r.did);
      var av = el('img', 'mbt-av');
      av.alt = '';
      loadAvatar(handle, av);
      var kids = byParent[r.objId];
      var indented = !!(kids && kids.length) && depth + 1 < MAX_DEPTH_INDENT;
      var avcol = el('div', 'mbt-avcol');
      avcol.appendChild(av);
      if (indented) avcol.appendChild(el('div', 'mbt-rail'));
      row.appendChild(avcol);

      var bubble = el('div', 'mbt-bubble');
      var head = el('div', 'mbt-rh');
      head.appendChild(el('span', 'mbt-who', handle ? '@' + handle : (r.did || '').slice(0, 18) + '…'));
      if (this.user && r.did === this.user.did) head.appendChild(el('span', 'mbt-pill you', 'you'));
      var tm = el('span', 'mbt-tm', relTime(r.created));
      tm.title = r.created ? new Date(r.created).toLocaleString() : '';
      head.appendChild(tm);
      if (fresh[r.objId]) head.appendChild(el('span', 'mbt-pill', 'New'));
      bubble.appendChild(head);

      var body = el('div', 'mbt-body');
      var d = this.decoded[r.objId];
      if (!d || d.error || !d.snapshot) {
        body.className += ' mbt-locked';
        if (d && d.error) {
          body.appendChild(lively.identity.postCardUtils.lockGlyph({ size: 16 }));
          body.appendChild(document.createTextNode(' Could not open this reply'));
        }
      } else {
        body.innerHTML = lively.identity.postCardUtils.snapshotToHtml(d.snapshot, { suppressEmbeds: false });
        hydrate.push(function () {
          var u = lively.identity.postCardUtils;
          try { u.hydrateEmbeddedParts(body); } catch (e) { /* decorative */ }
          try { u.hydrateAttachments(body, handle, d.attachments); } catch (e) { /* decorative */ }
          try { u.hydrateLinkPreviews(body); } catch (e) { /* decorative */ }
        });
      }
      bubble.appendChild(body);

      if (this.user) {
        var actions = el('div');
        var rb = el('button', 'mbt-link');
        rb.type = 'button';
        rb.appendChild(icon('reply'));
        rb.appendChild(document.createTextNode('Reply'));
        rb.addEventListener('click', function () { self.setReplyTarget(r.objId); });
        actions.appendChild(rb);
        bubble.appendChild(actions);
      }
      row.appendChild(bubble);
      wrap.appendChild(row);

      if (kids && kids.length) {
        var kc = el('div', 'mbt-kids' + (indented ? '' : ' flat'));
        kids.forEach(function (k) {
          var kid = el('div', 'mbt-kid');
          kid.appendChild(self.renderNode(k, depth + 1, byParent, fresh, hydrate));
          kc.appendChild(kid);
        });
        wrap.appendChild(kc);
      }
      return wrap;
    };

    Thread.prototype.toggleMute = function () {
      var self = this;
      var base = lively.identity.did.baseUrl();
      var next = !this.state.muted;
      xhrJson('PUT', base + '/@' + encodeURIComponent(this.user.handle) + '/inbox/threads/' + encodeURIComponent(this.opts.rootObjId) + '/mute', { muted: next }, function (err) {
        if (err) return self.toast('Could not change mute');
        self.state.muted = next;
        self.render();
        self.toast(next ? 'Thread muted. New replies stay quiet.' : 'Thread unmuted');
        if (self.opts.onRead) self.opts.onRead();
      });
    };

    // ── composer ─────────────────────────────────────────────────────────────

    // How many levels below the card a reply sits (a direct reply is 1).
    Thread.prototype.replyDepth = function (objId) {
      var byId = {};
      this.state.replies.forEach(function (r) { byId[r.objId] = r; });
      var depth = 0;
      var cur = byId[objId];
      while (cur && depth <= MAX_REPLY_DEPTH + 1) {
        depth++;
        cur = byId[cur.replyTo && cur.replyTo.objId];
      }
      return depth;
    };

    Thread.prototype.setReplyTarget = function (objId) {
      var target = this.state.replies.filter(function (r) { return r.objId === objId; })[0];
      this.replyShown = null;
      if (target && this.replyDepth(objId) >= MAX_REPLY_DEPTH) {
        // Anything under this reply would be one level too deep to be
        // shown, so the answer goes in beside it, under the same parent.
        var parentId = target.replyTo && target.replyTo.objId;
        this.replyShown = objId;
        this.replyTo = parentId === this.state.root.objId ? null : parentId;
      } else {
        this.replyTo = objId;
      }
      this.renderTarget();
      this.updateNote();
      this.textEl.focus();
    };

    Thread.prototype.clearReplyTarget = function () {
      this.replyTo = null;
      this.replyShown = null;
    };

    Thread.prototype.renderTarget = function () {
      var self = this;
      var t = this.targetEl;
      t.innerHTML = '';
      var shownId = this.replyShown || this.replyTo;
      if (!shownId) { t.hidden = true; return; }
      var r = this.state.replies.filter(function (x) { return x.objId === shownId; })[0];
      if (!r) { this.clearReplyTarget(); t.hidden = true; return; }
      t.hidden = false;
      t.appendChild(document.createTextNode('Replying to @' + (this.handleOf(r.did) || 'unknown') +
        (this.replyShown ? ' (comments nest ' + MAX_REPLY_DEPTH + ' deep, so this is shown just beside it)' : '')));
      var x = el('button');
      x.type = 'button';
      x.setAttribute('aria-label', 'Cancel replying to this reply');
      x.appendChild(icon('close'));
      x.addEventListener('click', function () { self.clearReplyTarget(); self.renderTarget(); self.updateNote(); });
      t.appendChild(x);
    };

    Thread.prototype.pickFile = function (accept) {
      var self = this;
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.style.display = 'none';
      document.body.appendChild(input);
      input.addEventListener('change', function () {
        var f = input.files && input.files[0];
        if (input.parentNode) input.parentNode.removeChild(input);
        if (f) self.setAttachment(f);
      });
      input.click();
    };

    Thread.prototype.setAttachment = function (file) {
      this.attachFile = file;
      this.attEl.innerHTML = '';
      this.attEl.hidden = false;
      var self = this;
      if (/^image\//.test(file.type)) {
        var im = document.createElement('img');
        im.src = URL.createObjectURL(file);
        im.alt = '';
        this.attEl.appendChild(im);
      } else {
        var v = el('span', 'vid');
        v.appendChild(icon('movie'));
        this.attEl.appendChild(v);
      }
      this.attEl.appendChild(el('span', 'nm', file.name));
      var x = el('button');
      x.type = 'button';
      x.setAttribute('aria-label', 'Remove attachment');
      x.appendChild(icon('close'));
      x.addEventListener('click', function () { self.clearAttachment(); });
      this.attEl.appendChild(x);
      this.syncSend();
    };

    Thread.prototype.clearAttachment = function () {
      this.attachFile = null;
      this.attEl.hidden = true;
      this.attEl.innerHTML = '';
      this.syncSend();
    };

    // Who must be able to read a reply sent right now, as handles. [] means
    // the card is public and the reply is too.
    Thread.prototype.recipientHandles = function () {
      var self = this;
      var root = this.state.root;
      if (root.visibility === 'public') return [];
      var me = this.user.did;
      var dids = [];
      var parent = this.replyTo ? this.state.replies.filter(function (r) { return r.objId === self.replyTo; })[0] : null;
      if (!parent) {
        if (me === root.did) {
          ((root.record && root.record.recipients) || []).forEach(function (r) { dids.push(r.did || r); });
        } else {
          dids.push(root.did);
        }
      } else {
        dids.push(root.did);
        dids.push(parent.did);
      }
      // At the depth cap the reply is filed beside the one being answered;
      // its author still has to be able to read it.
      var shown = this.replyShown ? this.state.replies.filter(function (r) { return r.objId === self.replyShown; })[0] : null;
      if (shown) dids.push(shown.did);
      var seen = {};
      return dids.filter(function (d) {
        if (d === me || seen[d]) return false;
        seen[d] = true;
        return true;
      }).map(function (d) { return self.handleOf(d); }).filter(Boolean);
    };

    Thread.prototype.updateNote = function () {
      if (!this.state) return;
      var root = this.state.root;
      if (root.visibility === 'public') {
        return this.setNote('Anyone who can see this card can see replies.', false, 'public');
      }
      var hs = this.recipientHandles();
      this.setNote(hs.length
        ? 'Only ' + hs.map(function (h) { return '@' + h; }).join(', ') + ' and you can see this reply.'
        : 'Only people on this card can see replies.', false, 'lock');
    };

    Thread.prototype.send = function () {
      var self = this;
      if (this.sending || !this.state) return;
      var text = this.textEl.value.trim();
      var file = this.attachFile;
      if (!text && !file) return;
      var root = this.state.root;
      var isPublic = root.visibility === 'public';
      var parentId = this.replyTo || root.objId;
      this.sending = true;
      this.sendBtn.disabled = true;
      this.setNote('Sending…', false, 'send');

      function fail(err) {
        self.sending = false;
        self.syncSend();
        self.setNote((err && err.message) || 'Could not send', true);
      }

      function withRecipients(cb) {
        if (isPublic) return cb(null, []);
        var hs = self.recipientHandles();
        if (!hs.length) return cb(new Error('Nobody to send this reply to'));
        resolveRecipients(hs, cb);
      }

      function withKek(cb) { return isPublic ? cb(null) : ensureKek(cb); }

      withKek(function (err) {
        if (err) return fail(err);
        withRecipients(function (err, recipients) {
          if (err) return fail(err);
          self.uploadAttachment(file, isPublic, recipients, function (err, entry) {
            if (err) return fail(err);
            self.serializeAndPut(text, entry, isPublic, recipients, parentId, root, function (err) {
              if (err) return fail(err);
              self.sending = false;
              self.textEl.value = '';
              self.textEl.style.height = '';
              self.clearAttachment();
              self.clearReplyTarget();
              self.toast('Reply sent');
              self.load();
            });
          });
        });
      });
    };

    // Uploads the staged file (if any). Public replies upload a plaintext
    // blob with a permanent URL; private ones encrypt the blob to the same
    // recipients as the reply and carry the key in the reply's payload.
    Thread.prototype.uploadAttachment = function (file, isPublic, recipients, thenDo) {
      if (!file) return thenDo(null, null);
      var user = this.user;
      var base = lively.identity.did.baseUrl();
      var isImage = /^image\//.test(file.type);
      lively.identity.fileCrypto.encryptAndUpload(file, isPublic
        ? { visibility: 'public', name: file.name }
        : { visibility: 'shared', recipients: recipients.map(function (r) { return { did: r.did, x25519PublicKey: r.x25519PublicKey }; }) },
      function (err, result) {
        if (err) return thenDo(err);
        thenDo(null, {
          kind: isImage ? 'image' : 'video',
          url: isPublic ? base + '/@' + encodeURIComponent(user.handle) + '/blobs/' + encodeURIComponent(result.blobCid) : '',
          entry: {
            objId: result.objId,
            dek: result.dek ? lively.identity.crypto.base64urlEncode(result.dek) : null,
            blobCid: result.blobCid,
            blobNonce: result.blobNonce || null,
            chunked: result.chunked,
            name: file.name,
            mime: file.type || 'application/octet-stream'
          }
        });
      });
    };

    Thread.prototype.serializeAndPut = function (text, att, isPublic, recipients, parentId, root, thenDo) {
      var user = this.user;
      var content = [];
      if (text) content.push({ type: 'paragraph', content: [{ type: 'text', text: text }] });
      if (att) {
        // Schema (PostCardEditor): image is inline so it sits inside a
        // paragraph; video is a block atom and sits beside paragraphs. A
        // private attachment carries an empty src and is resolved from its
        // objId when the reply is opened.
        if (att.kind === 'image') {
          content.push({ type: 'paragraph', content: [{ type: 'image', attrs: { src: att.url, alt: att.entry.name, title: att.entry.name, objId: att.entry.objId } }] });
        } else {
          content.push({ type: 'video', attrs: { src: att.url, name: att.entry.name, objId: att.entry.objId } });
        }
      }
      if (!content.length) return thenDo(new Error('Nothing to send'));
      var params = {
        doc: { type: 'doc', content: content },
        attachments: att ? [att.entry] : [],
        replyTo: { objId: parentId, anchor: null }
      };
      if (root.constellation) params.constellation = root.constellation;

      function put(err, envelope) {
        if (err) return thenDo(err);
        var base = lively.identity.did.baseUrl();
        xhrJson('PUT', base + '/@' + encodeURIComponent(user.handle) + '/' + encodeURIComponent(envelope.objId), envelope, function (err) {
          thenDo(err || null);
        });
      }

      var ser = lively.identity.postCardSerializer;
      if (isPublic) {
        params.visibility = 'public';
        ser.serializePlainToEnvelope(params, put);
      } else {
        params.recipients = recipients.map(function (r) { return { did: r.did, x25519PublicKey: r.x25519PublicKey }; });
        ser.serializePlainEncrypted(params, put);
      }
    };

    // ── entry points ─────────────────────────────────────────────────────────

    function mount(container, opts) {
      return new Thread(container, opts);
    }

    // A small standalone window, so someone who isn't the card's author can
    // read and answer the comments from the card's menu.
    var ThreadWindowClass = lively.morphic.Box.subclass('lively.identity.MailboxThreadWindow',

      'serialization', {
        doNotSerialize: ['_ctrl', '_mountedNode'],
      },

      'initialization', {
        initialize: function ($super, bounds, rootHandle, rootObjId, title) {
          $super(bounds);
          this._rootHandle = rootHandle;
          this._rootObjId = rootObjId;
          this._title = title || '';
          this._ctrl = null;
          this._mountedNode = null;
          this.setFill(Color.white);
          this.setDroppingEnabled(false);
          this._mountThread();
        },

        // Re-mounts after attaching to the window's render context or a
        // world reload; the guard skips the redundant same-node call.
        prepareForNewRenderContext: function ($super, renderCtx) {
          $super(renderCtx);
          if (!this._rootObjId) return;
          this._mountThread();
        },

        _mountThread: function () {
          var node = this.renderContext().shapeNode;
          if (this._mountedNode === node) return;
          this._mountedNode = node;
          if (this._ctrl) this._ctrl.destroy();
          node.innerHTML = '';
          this._ctrl = mount(node, {
            rootHandle: this._rootHandle,
            rootObjId: this._rootObjId,
            title: this._title,
            inbox: false
          });
        }
      });

    function _ensureChromeCss() {
      var STYLE_ID = 'mailbox-thread-chrome-style';
      if (document.getElementById(STYLE_ID)) return;
      var s = document.createElement('style');
      s.id = STYLE_ID;
      s.textContent = [
        '.Window.mailbox-accent-chrome { background-color: #61D565 !important; }',
        '.Window.mailbox-accent-chrome .Text.window-title { color: #fff; }',
        '.Window.mailbox-accent-chrome.highlighted .Text.window-title { color: #fff; font-weight: bold; }',
        '.Window.mailbox-accent-chrome.highlighted { border: none !important; box-shadow: 0px 3px 10px rgba(20,60,20,0.35) !important; }'
      ].join('\n');
      document.head.appendChild(s);
    }

    function openWindow(rootHandle, rootObjId, title) {
      var morph = new ThreadWindowClass(lively.rect(0, 0, 480, 600), rootHandle, rootObjId, title);
      morph.setName('Replies');
      morph.openInWindow({
        title: 'Replies',
        pos: lively.morphic.World.current().visibleBounds().center().subPt(lively.pt(240, 300))
      });
      var win = morph.getWindow();
      _ensureChromeCss();
      win.addStyleClassName('mailbox-accent-chrome');
      win.comeForward();
      return morph;
    }

    // The plain text of one of the signed-in user's own replies, for the
    // Returned list (a returned reply is never shown in a thread). Reads the
    // stored copy, decrypting it if the card was private. thenDo(err, text,
    // hasMedia): text may be '' when the reply was only a photo/video.
    function readOwnReplyText(objId, thenDo) {
      var user = lively.identity.did.currentUser();
      if (!user) return thenDo(new Error('not signed in'));
      xhrJson('GET', lively.identity.did.baseUrl() + '/@' + encodeURIComponent(user.handle) + '/' + encodeURIComponent(objId), undefined, function (err, env) {
        if (err) return thenDo(err);
        decodeReply(env, function (err, decoded) {
          if (err) return thenDo(err);
          var parts = [];
          var hasMedia = !!(decoded.attachments && decoded.attachments.length);
          (function walk(node) {
            if (!node) return;
            if (node.type === 'image' || node.type === 'video') hasMedia = true;
            if (node.text) parts.push(node.text);
            (node.content || []).forEach(walk);
            if (node.type === 'paragraph') parts.push('\n');
          })(decoded.snapshot);
          thenDo(null, parts.join('').replace(/\n+/g, '\n').trim(), hasMedia);
        });
      });
    }

    lively.identity.mailboxThread = {
      mount: mount,
      openWindow: openWindow,
      readOwnReplyText: readOwnReplyText
    };

  }); // end module('lively.identity.MailboxThread')
