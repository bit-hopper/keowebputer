/**
 * lively.identity.PostcardReel
 *
 * The homestar's postcard reel: one real PostCardView card at a time, newest
 * first, turned with a swipe-away animation (prev/next buttons, arrow keys, or a
 * pointer drag). The cards are whichever ones the viewer may see — the server
 * applies that rule (GET /@:handle/postcards).
 *
 * The turn animation, nav buttons and card-height fitting are copied from
 * ConstellationLounge's reel rather than shared with it (that file is large and
 * the lounge is not being touched here). Sort pills use the same vocabulary and
 * server values as the lounge: New / Stellar / Hyphy / Goosed.
 *
 * One reel object lives for the whole page. Homestar._render() rebuilds its own
 * morphs on every fetch and resize, so the reel keeps its morphs and is only
 * re-positioned with attach(x, y, w); it asks for a re-render (opts.onResize)
 * when its height changes.
 *
 * The comment chip on a card opens the comments under it: MailboxThread
 * (the same component the mailbox uses) mounted compact in a box below the
 * card, so a signed-in viewer can answer too.
 *
 * Handlers below are plain closures in an Object.subclass, not BuildSpec or
 * addScript, so module-level helpers are safe to reference.
 */

module("lively.identity.PostcardReel")
  .requires(
    "lively.identity.HomestarUI",
    "lively.identity.PostCardView",
    "lively.identity.MailboxThread",
    "lively.identity.PostcardAudience",
    "lively.identity.AudienceRules",
    "lively.identity.AudienceDialog",
    "lively.identity.PostcardEdits",
    "lively.morphic.Complete",
  )
  .toRun(function () {

    var UI = lively.identity.HomestarUI;
    var PINK = UI.PINK, MUTED = UI.MUTED, CARD_BORDER = UI.CARD_BORDER;
    var noDrag = UI.noDrag, label = UI.label, icon = UI.icon, pill = UI.pill, textW = UI.textW;

    var PAD = 20;
    var CARD_MAX_W = 650, CARD_H = 395, CARD_H_MAX = 610;
    var EMPTY_H = 200;                 // card-area height while loading / empty
    var NAV_BTN_D = 34, NAV_GAP = 10, NAV_PILL_W = 78;
    var NAV_W = NAV_BTN_D * 2 + NAV_GAP * 2 + NAV_PILL_W;
    var THREAD_H = 340;                // the open comment thread under the card
    var PAGE_SIZE = 20, RANKED_SIZE = 100;
    var SWIPE_PX = 90;                 // horizontal drag needed to turn the card
    var SWIPE_START_PX = 6;            // movement before a press counts as a swipe

    // Display name -> server `sort` value. "new" is the plain newest-first,
    // cursor-paginated listing; the others come back as one capped ranked page.
    // Any `sort` makes the server list through the viewer-aware query, which is
    // what lets the owner see this reel instead of their mailbox listing.
    var SORTS = [
      { name: "New",     param: "new" },
      { name: "Stellar", param: "starred" },
      { name: "Hyphy",   param: "hyphy" },
      { name: "Goosed",  param: "goosed" },
    ];

    function reducedMotion() {
      try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); }
      catch (e) { return false; }
    }

    Object.subclass("lively.identity.PostcardReel",
    "init", {
      // opts: { handle, shown, viewer, isOwner, onNew(), onResize(), onCardShown(objId) }
      initialize: function (opts) {
        this._handle = opts.handle;
        this._shown = opts.shown || opts.handle;
        this._viewer = opts.viewer || null;
        this._isOwner = !!opts.isOwner;
        this._onNew = opts.onNew || null;
        this._onResize = opts.onResize || null;
        this._onCardShown = opts.onCardShown || null;

        this._sort = SORTS[0];
        this._feed = [];
        this._cursor = null;
        this._index = -1;
        this._loaded = false;           // first page of the current sort has landed
        this._feedToken = 0;
        this._cardH = CARD_H;
        this._cardW = CARD_MAX_W;
        this._busy = false;             // a turn animation is running
        this._threadOpen = false;       // the comment thread under the card is showing
        this._thread = null;            // its MailboxThread controller
        this._counts = {};              // objId -> reply count, for the comment chip
        this._audienceCtx = null;       // owner only: friends, orbit, lists, per-card audiences
        this._w = 0;

        this._build();
        this._installKeys();
        this._fetchFeed();
        if (this._isOwner) this._autoSyncAudiences();
      },

      dispose: function () {
        if (this._keyHandler) document.removeEventListener("keydown", this._keyHandler);
        this._removeSwipeListeners();
        if (this._panel) this._panel.remove();
      },
    },

    "build", {
      _build: function () {
        var self = this;
        var panel = UI.panel(lively.rect(0, 0, 400, 300));
        this._panel = panel;

        // The default postmark (an Image of the SVG, 150:80 aspect) is this
        // panel's mark. It is wider than a glyph, so the labels start further right.
        var mark = new lively.morphic.Image(
          lively.rect(18, 31, 50, 27), lively.identity.PostCardView.postmarkIconUrl(PINK.toString()));
        mark.applyStyle({ fill: null, borderWidth: 0 });
        noDrag(mark);
        mark.eventsAreIgnored = true;
        panel.addMorph(mark);
        panel.addMorph(label(lively.rect(78, 16, 200, 24), "Postcards", { px: 17, bold: true }));
        var sub = this._isOwner ? "Shared by you" : (this._viewer ? "Shared with you" : "Shared with everyone");
        panel.addMorph(label(lively.rect(78, 40, 200, 20), sub, { px: 12, color: MUTED }));

        this._newBtn = null;
        if (this._isOwner) {
          this._newBtn = pill(0, 18, "+ Postcard", { primary: true, w: 112, onClick: function () { if (self._onNew) self._onNew(); } });
          panel.addMorph(this._newBtn);
        }

        this._sortRow = [];
        this._buildSortRow();

        // The card area: an empty-state box and the card box, stacked at the same spot.
        this._emptyBox = new lively.morphic.Box(lively.rect(PAD, 112, 400, EMPTY_H));
        this._emptyBox.applyStyle({ fill: Color.rgb(250, 248, 252), borderRadius: 12, borderWidth: 1, borderColor: CARD_BORDER, clipMode: "hidden" });
        noDrag(this._emptyBox);
        panel.addMorph(this._emptyBox);

        this._cardBox = new lively.morphic.Box(lively.rect(PAD, 112, CARD_MAX_W, CARD_H));
        noDrag(this._cardBox);
        panel.addMorph(this._cardBox);
        var node = this._cardBox.renderContext().shapeNode;
        node.style.transformOrigin = "50% 50%";
        node.style.transition = "transform 260ms ease, opacity 260ms ease";
        node.style.touchAction = "pan-y";
        node.classList.add("homestar-reel-card");
        this._ensureStyle();
        node.addEventListener("pointerdown", this._onPointerDown.bind(this));

        this._navBox = new lively.morphic.Box(lively.rect(0, 0, NAV_W, NAV_BTN_D));
        this._navBox.applyStyle({ fill: null, borderWidth: 0 });
        noDrag(this._navBox);
        panel.addMorph(this._navBox);

        var pillBg = new lively.morphic.Box(lively.rect(NAV_BTN_D + NAV_GAP, 0, NAV_PILL_W, NAV_BTN_D));
        pillBg.applyStyle({ fill: Color.rgb(0xF7, 0xF2, 0xF4), borderWidth: 1, borderColor: Color.rgb(0xF0, 0xCE, 0xDC), borderRadius: NAV_BTN_D / 2 });
        noDrag(pillBg);
        pillBg.eventsAreIgnored = true;
        this._navBox.addMorph(pillBg);
        this._navLabel = label(lively.rect(NAV_BTN_D + NAV_GAP, Math.round((NAV_BTN_D - 20) / 2), NAV_PILL_W, 20), "", { px: 13, bold: true, align: "center", color: Color.rgb(90, 90, 90) });
        this._navBox.addMorph(this._navLabel);
        this._prevBtn = this._navButton("chevron_left", -1, 0);
        this._nextBtn = this._navButton("chevron_right", 1, NAV_BTN_D + NAV_GAP + NAV_PILL_W + NAV_GAP);
        this._navBox.addMorph(this._prevBtn);
        this._navBox.addMorph(this._nextBtn);

        this._caption = label(lively.rect(PAD, 0, 400, 20), "", { px: 12, color: MUTED, align: "center" });
        panel.addMorph(this._caption);

        // The comment thread: a box whose shape node hosts MailboxThread's DOM.
        this._threadBox = new lively.morphic.Box(lively.rect(PAD, 0, 400, THREAD_H));
        this._threadBox.applyStyle({ fill: Color.white, borderRadius: 12, borderWidth: 1, borderColor: CARD_BORDER, clipMode: "hidden" });
        noDrag(this._threadBox);
        this._threadBox.setVisible(false);
        panel.addMorph(this._threadBox);
        var tnode = this._threadBox.renderContext().shapeNode;
        tnode.classList.add("selectable");
        tnode.classList.add("homestar-reel-thread");
        tnode.style.userSelect = "text";
        this._threadHost = document.createElement("div");
        this._threadHost.style.cssText = "position:absolute;inset:0;";
        tnode.appendChild(this._threadHost);

        // Behind everything already in the world, like the rest of the page
        // (HomestarController._add). The reel is built once the first data
        // arrives, which can be after the visitor opened a window; a plain
        // addMorph would paint the reel over that window.
        $world.addMorphBack(panel);
        this._renderEmpty();
      },

      // A scoped scrollbar for the card's content area, as in the lounge's reel.
      _ensureStyle: function () {
        if (document.getElementById("homestar-reel-style")) return;
        var st = document.createElement("style");
        st.id = "homestar-reel-style";
        st.textContent =
          ".homestar-reel-card .lively-postcard-view-content{scrollbar-width:thin;scrollbar-color:#f4a7c6 #f7f2f4;}" +
          ".homestar-reel-card .lively-postcard-view-content::-webkit-scrollbar{width:10px;}" +
          ".homestar-reel-card .lively-postcard-view-content::-webkit-scrollbar-track{background:#f7f2f4;}" +
          ".homestar-reel-card .lively-postcard-view-content::-webkit-scrollbar-thumb{background:#f4a7c6;border-radius:999px;border:2px solid #f7f2f4;}" +
          ".homestar-reel-card .lively-postcard-view-content::-webkit-scrollbar-thumb:hover{background:#e8497e;}" +
          // The comment thread takes the homestar's pink for its accent (Send, the focus ring,
          // the "new" pill and highlight); the mailbox's own copy keeps its green.
          ".homestar-reel-thread .mbt-root{--mbt-accent:#CC0057;--mbt-accent-soft:#fdebf3;--mbt-accent-soft-border:#f4a7c6;}" +
          ".homestar-reel-thread .mbt-btn.accent:hover:not(:disabled){background:#a80048;border-color:#a80048;}";
        document.head.appendChild(st);
      },

      _buildSortRow: function () {
        var self = this;
        this._sortRow.forEach(function (m) { m.remove(); });
        this._sortRow = [];
        var x = PAD;
        SORTS.forEach(function (s) {
          var selected = s === self._sort;
          var w = textW(s.name, 12, true) + 28;
          var p = pill(x, 72, s.name, {
            primary: selected, w: w, h: 28,
            onClick: function () { self._setSort(s); },
          });
          self._panel.addMorph(p);
          self._sortRow.push(p);
          x += w + 8;
        });
      },

      // Circular Material-Symbols button, as the lounge's reel nav.
      _navButton: function (glyph, direction, x) {
        var self = this;
        var D = NAV_BTN_D, GLYPH_PX = 18;
        var btn = new lively.morphic.Text(lively.rect(x, 0, D, D));
        btn.textString = glyph;
        btn._navFill = Color.white;
        btn._navFillHover = Color.rgb(0xF7, 0xF2, 0xF4);
        btn.applyStyle({
          fontFamily: "'Material Symbols Rounded'", fontSize: GLYPH_PX * 0.75,
          textColor: Color.rgb(90, 90, 90), fill: btn._navFill,
          borderRadius: D / 2, borderWidth: 1, borderColor: Color.rgb(224, 224, 224),
          align: "center", padding: lively.Rectangle.inset(0, Math.round((D - GLYPH_PX) / 2), 0, 0),
          allowInput: false, selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre",
          handStyle: "pointer",
        });
        noDrag(btn);
        btn.toolTip = direction < 0 ? "Previous postcard" : "Next postcard";
        btn.onMouseOver = function () { if (!btn._navDisabled) btn.applyStyle({ fill: btn._navFillHover }); };
        btn.onMouseOut = function () { if (!btn._navDisabled) btn.applyStyle({ fill: btn._navFill }); };
        btn.onMouseUp = function (evt) {
          if (!btn._navDisabled) self._turn(direction);
          evt.stop();
          return true;
        };
        return btn;
      },

      _setNavEnabled: function (btn, enabled) {
        btn._navDisabled = !enabled;
        btn.applyStyle({
          textColor: enabled ? Color.rgb(90, 90, 90) : Color.rgb(205, 205, 205),
          fill: btn._navFill,
          handStyle: enabled ? "pointer" : "default",
        });
      },
    },

    "layout", {
      // Positions the panel and returns the y of its bottom edge.
      attach: function (x, y, w) {
        this._w = w;
        this._panel.setPosition(lively.pt(x, y));
        return y + this._layout();
      },

      // Sizes everything for the current width and card height; returns the panel height.
      _layout: function () {
        var w = this._w;
        if (!w) return 0;
        var inner = w - PAD * 2;
        var hasCards = this._feed.length > 0;
        var areaH = hasCards ? this._cardH : EMPTY_H;
        var areaY = 112;

        if (this._newBtn) this._newBtn.setPosition(lively.pt(w - PAD - this._newBtn.getExtent().x, 18));

        this._cardW = Math.min(CARD_MAX_W, inner);
        var cardX = PAD + Math.round((inner - this._cardW) / 2);
        this._emptyBox.setPosition(lively.pt(PAD, areaY));
        this._emptyBox.setExtent(lively.pt(inner, EMPTY_H));
        this._cardBox.setPosition(lively.pt(cardX, areaY));
        this._cardBox.setExtent(lively.pt(this._cardW, this._cardH));
        var view = this._cardBox._renderedView;
        if (view) view.setExtent(lively.pt(this._cardW, this._cardH));
        if (!hasCards) this._layoutEmpty(inner);

        this._emptyBox.setVisible(!hasCards);
        this._cardBox.setVisible(hasCards);
        this._navBox.setVisible(hasCards);

        var y = areaY + areaH + 16;
        if (hasCards) {
          this._navBox.setPosition(lively.pt(Math.round((w - NAV_W) / 2), y));
          y += NAV_BTN_D + 10;
        }
        this._caption.setPosition(lively.pt(PAD, y));
        this._caption.setExtent(lively.pt(inner, 22));
        y += 22 + 8;

        var showThread = hasCards && this._threadOpen;
        this._threadBox.setVisible(showThread);
        if (showThread) {
          this._threadBox.setPosition(lively.pt(PAD, y));
          this._threadBox.setExtent(lively.pt(inner, THREAD_H));
          y += THREAD_H + 8;
        }
        y += 6;

        var h = y;
        this._panel.setExtent(lively.pt(w, h));
        return h;
      },
    },

    "empty state", {
      // Loading / nothing-to-show message in the card area. Rebuilt whenever the
      // state changes; the box's own size comes from _layout.
      _renderEmpty: function () {
        var self = this;
        var box = this._emptyBox;
        (box.submorphs || []).slice().forEach(function (m) { m.remove(); });
        this._emptyContent = null;
        var title, body, button = null, glyph = "postmark";   // "postmark" = the default postmark Image, see _layoutEmpty
        if (!this._loaded) {
          title = "Loading…"; body = "";
        } else if (this._isOwner) {
          glyph = "edit_note";
          title = "Write your first postcard";
          body = "Postcards are how you share notes, photos and music. They will show up here.";
          button = { text: "Write a postcard", onClick: function () { if (self._onNew) self._onNew(); } };
        } else {
          title = "No postcards yet";
          body = "@" + this._shown + " hasn't shared any postcards" + (this._viewer ? " with you" : " publicly") + " yet.";
        }
        this._emptyContent = { glyph: glyph, title: title, body: body, button: button };
        this._layoutEmpty(box.getExtent().x);
      },

      _layoutEmpty: function (aw) {
        var c = this._emptyContent;
        var box = this._emptyBox;
        if (!c) return;
        (box.submorphs || []).slice().forEach(function (m) { m.remove(); });
        if (c.glyph === "postmark") {
          // 150:80 aspect, centered where the 36px glyphs sit.
          var mark = new lively.morphic.Image(
            lively.rect(Math.round((aw - 68) / 2), 26, 68, 36), lively.identity.PostCardView.postmarkIconUrl(PINK.toString()));
          mark.applyStyle({ fill: null, borderWidth: 0 });
          noDrag(mark);
          mark.eventsAreIgnored = true;
          box.addMorph(mark);
        } else {
          box.addMorph(icon(lively.rect(Math.round((aw - 36) / 2), 28, 36, 36), c.glyph, 30, PINK));
        }
        box.addMorph(label(lively.rect(20, 74, aw - 40, 24), c.title, { px: 16, bold: true, align: "center" }));
        if (c.body) box.addMorph(label(lively.rect(30, 100, aw - 60, 40), c.body, { px: 13, color: MUTED, wrap: true, align: "center" }));
        if (c.button) {
          var bw = textW(c.button.text, 12, true) + 36;
          box.addMorph(pill(Math.round((aw - bw) / 2), 148, c.button.text, { primary: true, w: bw, onClick: c.button.onClick }));
        }
      },
    },

    "feed", {
      _setSort: function (s) {
        if (s === this._sort) return;
        this._sort = s;
        this._buildSortRow();
        this._fetchFeed();
      },

      // Replaces the loaded cards with the first page of the current sort.
      _fetchFeed: function (thenDo) {
        var self = this;
        var token = ++this._feedToken;
        var ranked = this._sort.param !== "new";
        var url = "/@" + encodeURIComponent(this._handle) + "/postcards?limit=" + (ranked ? RANKED_SIZE : PAGE_SIZE) +
          "&sort=" + this._sort.param;
        UI.getJSON(url, function (err, body) {
          if (token !== self._feedToken) return;
          self._feed = (body && body.postcards) || [];
          self._cursor = (body && body.cursor) || null;
          self._index = self._feed.length ? 0 : -1;
          self._loaded = true;
          self._cardBox.renderContext().shapeNode.style.opacity = "1";
          self._renderEmpty();
          self._showActive();
          self._changed();
          if (thenDo) thenDo();
        });
      },

      // Pages in the next batch (cursor-paginated sorts only); thenDo(addedAny).
      _loadMore: function (thenDo) {
        var self = this;
        if (!this._cursor) return thenDo(false);
        var token = this._feedToken;
        var url = "/@" + encodeURIComponent(this._handle) + "/postcards?limit=" + PAGE_SIZE +
          "&sort=" + this._sort.param + "&cursor=" + encodeURIComponent(this._cursor);
        UI.getJSON(url, function (err, body) {
          if (token !== self._feedToken) return thenDo(false);
          var more = (body && body.postcards) || [];
          self._feed = self._feed.concat(more);
          self._cursor = (body && body.cursor) || null;
          thenDo(more.length > 0);
        });
      },

      // The objId of the card on show, or null.
      currentObjId: function () {
        var card = this._feed[this._index];
        return card ? card.objId : null;
      },

      // Number of cards currently loaded (a lower bound when more pages remain).
      cardCount: function () { return this._feed.length; },

      // Whether the first page has landed, and whether it held anything.
      isLoaded: function () { return this._loaded; },
    },

    "cards", {
      _changed: function () {
        var h = this._layout();
        if (this._lastH !== h) {
          this._lastH = h;
          if (this._onResize) this._onResize();
        }
      },

      // Shows a given card, e.g. when its pin on the map is clicked. A card already
      // loaded is jumped to; otherwise pages are loaded until it turns up (bounded),
      // which keeps "N / M" and the order of prev/next consistent with the feed. A
      // ranked sort has no further pages, so the reel goes back to New first. If
      // the card still never appears it is shown on its own and the position
      // label is left alone. A newer call supersedes one still paging.
      showCard: function (objId) {
        var self = this;
        var MAX_CARDS = 500;
        var jump = this._jumpToken = (this._jumpToken || 0) + 1;
        var triedNew = false;

        function indexOfCard() {
          for (var i = 0; i < self._feed.length; i++) if (self._feed[i].objId === objId) return i;
          return -1;
        }
        function bringIntoView() {
          var rect = self._panel.renderContext().shapeNode.getBoundingClientRect();
          if (rect.top >= 0 && rect.top < window.innerHeight * 0.5) return;
          try { window.scrollTo({ top: Math.max(0, (window.pageYOffset || 0) + rect.top - 80), behavior: reducedMotion() ? "auto" : "smooth" }); }
          catch (e) { window.scrollTo(0, Math.max(0, (window.pageYOffset || 0) + rect.top - 80)); }
        }
        function done() { bringIntoView(); }
        function direct() {
          self._renderCard(objId);
          if (self._onCardShown) self._onCardShown(objId);
          done();
        }
        (function step() {
          if (self._jumpToken !== jump) return;
          var idx = indexOfCard();
          if (idx >= 0) {
            if (idx !== self._index || !self._cardBox._renderedView) {
              self._index = idx;
              self._showActive();
            }
            return done();
          }
          if (self._cursor && self._feed.length < MAX_CARDS) {
            return self._loadMore(function (loaded) {
              if (self._jumpToken !== jump) return;
              if (loaded) step(); else direct();
            });
          }
          if (!triedNew && self._sort !== SORTS[0]) {
            triedNew = true;
            self._sort = SORTS[0];
            self._buildSortRow();
            return self._fetchFeed(step);
          }
          direct();
        })();
      },

      _showActive: function () {
        var card = this._feed[this._index];
        if (this._onCardShown) this._onCardShown(card ? card.objId : null);
        this._updateNav();
        this._updateCaption();
        this._unmountThread();
        if (card && this._threadOpen) this._mountThread(card);
        if (!card) {
          (this._cardBox.submorphs || []).slice().forEach(function (m) { m.remove(); });
          this._cardBox._renderedView = null;
          return;
        }
        this._renderCard(card.objId);
      },

      _updateNav: function () {
        var n = this._feed.length;
        this._navLabel.textString = n ? (this._index + 1) + " / " + n + (this._cursor ? "+" : "") : "";
        this._setNavEnabled(this._prevBtn, n > 1);
        this._setNavEnabled(this._nextBtn, n > 1 || !!this._cursor);
      },

      _updateCaption: function () {
        var text;
        if (!this._feed.length) text = "";
        else if (this._isOwner) text = "You are seeing every card you have posted.";
        else if (this._viewer) text = "Showing the cards shared with you.";
        else text = "You are signed out, so only public cards appear.";
        this._caption.textString = text;
      },

      // Embeds the real PostCardView in the card box, replacing the previous one.
      _renderCard: function (objId) {
        var self = this;
        var box = this._cardBox;
        var token = box._renderToken = (box._renderToken || 0) + 1;
        (box.submorphs || []).slice().forEach(function (m) { m.remove(); });
        box._renderedView = null;
        box._renderedView = lively.identity.PostCardView.open(this._handle, objId, {
          target: box,
          pinkHandle: true,
          previewMode: true,
          homestar: true,
          showCommentChip: true,
          onEnvelope: function (env, view) { self._showAudienceChip(env, view); self._showEditChip(env, view); },
          commentCount: this._counts[objId] || 0,
          onToggleComments: function () { self._toggleThread(); },
          bounds: lively.rect(0, 0, this._cardW, this._cardH),
        });
        box._renderedView.setCommentsExpanded(this._threadOpen);
        this._loadCommentCount(objId, box._renderedView);
        // Content may still be laying out or decrypting right after open().
        [60, 500, 1800].forEach(function (ms) {
          setTimeout(function () {
            if (box._renderToken === token) self._fitToContent();
          }, ms);
        });
      },

      // Reply count for the comment chip: the number of replies the server
      // lists for this viewer. Cached per card for the life of the page.
      _loadCommentCount: function (objId, view) {
        var self = this;
        if (this._counts[objId] !== undefined) return;
        UI.getJSON("/@" + encodeURIComponent(this._handle) + "/" + encodeURIComponent(objId) + "/replies?limit=100", function (err, body) {
          if (!body) return;
          self._counts[objId] = (body.postcards || []).length;
          if (view && view._objId === objId) view.setCommentCount(self._counts[objId]);
        });
      },

      // 76px header above the content area, 26px reactions footer below it
      // (PostCardView._buildChrome); the card grows to fit up to CARD_H_MAX.
      _measureCardHeight: function () {
        var content = this._cardBox.renderContext().shapeNode.querySelector(".lively-postcard-view-content");
        if (!content || !content.lastElementChild) return CARD_H;
        var last = content.lastElementChild;
        var contentH = last.offsetTop + last.offsetHeight + 14;   // + content's bottom padding
        return Math.max(CARD_H, Math.min(CARD_H_MAX, 76 + contentH + 26));
      },

      _fitToContent: function () {
        var h = this._measureCardHeight();
        if (h !== this._cardH) {
          this._cardH = h;
          this._changed();
        }
      },
    },

    "edits", {
      // The "Edited 3 days ago" pill, shown to anyone who can read a card that was
      // changed after people could first read it. The server says where this reader's
      // diff starts (a card nobody has edited makes no request); the diff itself is
      // worked out in this browser when the pill is clicked, and an empty one (the
      // owner changed something and put it back) takes the pill away again.
      _showEditChip: function (env, view) {
        var self = this;
        var PE = lively.identity.postcardEdits;
        var st = env.state || {};
        view.setEditChip(null);
        if (env.type !== "postcard" || !st.editedAt || !st.editBaseline) return;
        PE.baseline(this._handle, env.objId, function (err, b) {
          if (err || !b || !b.edited || view._envelope !== env) return;
          view.setEditChip({
            label: "Edited " + PE.agoLabel(b.editedAt),
            title: "See what changed",
            onClick: function () {
              PE.openDialog({
                handle: self._handle,
                objId: env.objId,
                title: st.title,
                editedAt: b.editedAt,
                onNoChange: function () { if (view._envelope === env) view.setEditChip(null); },
              });
            },
          });
        });
      },
    },

    "audience", {
      // The chip in the card's handle row: who it is shared with. A viewer sees only
      // the sets that are not private to the owner; the owner sees their own sets
      // with the count, and (for a card that can still change) clicks it to edit.
      _showAudienceChip: function (env, view) {
        var self = this;
        var R = lively.identity.AudienceRules;
        var isPublic = env.visibility === "public";
        if (!this._isOwner) {
          var shown = R.viewerChipLabel(env.visibility, env.state && env.state.audience);
          view.setAudienceChip(shown ? { label: shown, icon: isPublic ? "public" : "lock", title: "Who can see this postcard" } : null);
          return;
        }
        var frozen = !!(env.state && env.state.sentAt);
        var chipFor = function (ctx) {
          var rec = ctx && ctx.cardAudiences[env.objId];
          var recips = (env.record && env.record.recipients) || [];
          var text;
          if (isPublic) text = "Public";
          else if (rec) text = R.ownerChipLabel(rec, ctx, false);
          else text = recips.length ? recips.length + (recips.length === 1 ? " person" : " people") : "Only me";
          var chip = { label: text, icon: isPublic ? "public" : "lock", title: "Who can see this postcard" };
          if (isPublic) chip.title = "Public cards are changed in the editor";
          else if (frozen) chip.title = "Already sent, so its audience can no longer change";
          else {
            chip.title = "Change who can see this postcard";
            chip.onClick = function () { self._openAudienceDialog(env, view); };
          }
          return chip;
        };
        view.setAudienceChip(chipFor(this._audienceCtx));
        // The counts need the friend/orbit/list data; once it is here, redraw the chip.
        this._ensureAudienceCtx(false, function (err, ctx) {
          if (err || view._envelope !== env) return;        // failed, or the view has moved on
          view.setAudienceChip(chipFor(ctx));
        });
      },

      // owner only. fresh: load again even if cached. thenDo(err, ctx).
      _ensureAudienceCtx: function (fresh, thenDo) {
        var self = this;
        if (this._audienceCtx && !fresh) return thenDo(null, this._audienceCtx);
        lively.identity.postcardAudience.loadContext(function (err, ctx) {
          if (!err) self._audienceCtx = ctx;
          thenDo(err, ctx);
        });
      },

      _openAudienceDialog: function (env, view) {
        var self = this;
        this._ensureAudienceCtx(true, function (err, ctx) {
          if (err) return $world.alert("Could not load your friends and lists: " + err.message);
          var rec = ctx.cardAudiences[env.objId];
          var audience = rec, warning = null;
          if (!rec) {
            // A card shared before audiences existed: start from the friends it is
            // already sealed to. Anyone else it names would lose access on save.
            var dids = ((env.record && env.record.recipients) || []).map(function (r) { return r.did; });
            var friends = dids.filter(function (d) { return ctx.friendDids.indexOf(d) !== -1; });
            audience = { tiers: [], people: friends };
            var lost = dids.length - friends.length;
            if (lost > 0) {
              warning = lost + (lost === 1 ? " person who is" : " people who are") + " not your " +
                (lost === 1 ? "friend" : "friends") + " will lose access if you save.";
            }
          }
          lively.identity.AudienceDialog.open({
            ctx: ctx,
            audience: audience,
            isPublic: false,
            allowPublic: false,
            publicNote: "Public cards and private cards are changed in the editor",
            subtitle: (env.state && env.state.title) || "(untitled)",
            warning: warning,
            onSave: function (result) { self._applyAudience(env, view, result); },
          });
        });
      },

      // Record the new audience, then bring this one card in line with it (which may
      // ask for the passkey once if the session has no key cached yet).
      _applyAudience: function (env, view, result) {
        var self = this;
        var pa = lively.identity.postcardAudience;
        var objId = env.objId;
        view.setAudienceChip({ label: "Saving\u2026", icon: "lock" });
        function fail(msg) {
          $world.alert(msg);
          self._renderCard(objId);
        }
        pa.setCardAudience(objId, result.audience, function (err) {
          if (err) return fail("Could not save the audience: " + err.message);
          self._ensureAudienceCtx(true, function (ctxErr, ctx) {
            if (ctxErr) return fail("Saved the audience, but could not load your friends to update the card: " + ctxErr.message);
            pa.syncCard(objId, ctx, function (syncErr, r) {
              if (syncErr) return fail("Saved the audience, but updating the card failed: " + syncErr.message);
              var missed = (r.failed || []).map(function (f) { return "@" + (ctx.handleByDid[f.did] || "someone"); });
              if (missed.length) {
                $world.alert("Could not share with " + missed.join(", ") + " yet (they may not have set up encryption). " +
                  "It will be tried again the next time your homestar opens.");
              }
              self._renderCard(objId);
            });
          });
        });
      },

      // On page load, bring every card's recipients up to date with the friends,
      // orbit and lists as they are now. Quiet: it never opens a passkey prompt (a
      // sync with no cached key waits for the next time), and a failure is only logged.
      _autoSyncAudiences: function () {
        var self = this;
        setTimeout(function () {
          lively.identity.postcardAudience.syncAudiences({ onlyIfKekCached: true }, function (err, report) {
            if (err) return console.warn("[PostcardReel] audience sync failed:", err.message || err);
            if (report.failed && report.failed.length) console.warn("[PostcardReel] audience sync: some cards failed", report.failed);
            if (report.updated && report.updated.length) {
              self._audienceCtx = null;
              var card = self._feed[self._index];
              if (card) self._renderCard(card.objId);
            }
          });
        }, 1500);
      },
    },

    "thread", {
      _toggleThread: function () {
        this._threadOpen = !this._threadOpen;
        var view = this._cardBox._renderedView;
        if (view) view.setCommentsExpanded(this._threadOpen);
        var card = this._feed[this._index];
        if (this._threadOpen && card) {
          this._mountThread(card);
        } else {
          this._unmountThread();
          // A reply may have been added while it was open; re-read the count.
          if (card && view) {
            delete this._counts[card.objId];
            this._loadCommentCount(card.objId, view);
          }
        }
        this._changed();
      },

      _mountThread: function (card) {
        this._unmountThread();
        this._thread = lively.identity.mailboxThread.mount(this._threadHost, {
          rootHandle: this._handle,
          rootObjId: card.objId,
          title: (card.state && card.state.title) || "",
          compact: true,
        });
      },

      _unmountThread: function () {
        if (this._thread) { this._thread.destroy(); this._thread = null; }
      },
    },

    "turning", {
      // direction +1 = the next card in the list (older), -1 = the previous
      // (newer). Cycles past either end, paging in more first when it can.
      _turn: function (direction) {
        var self = this;
        if (this._busy) return;
        var n = this._feed.length;
        var next = this._index + direction;
        if (next < 0) {
          if (n <= 1) return this._settle();
          return this._animateTurn(direction, n - 1);
        }
        if (next >= n) {
          this._busy = true;
          return this._loadMore(function (loaded) {
            self._busy = false;
            if (loaded) return self._turn(direction);
            if (self._feed.length <= 1) return self._settle();
            self._animateTurn(direction, 0);
          });
        }
        this._animateTurn(direction, next);
      },

      // The old card flies off (left for +1, right for -1) and the new one settles in.
      _animateTurn: function (direction, nextIndex) {
        var self = this;
        var node = this._cardBox.renderContext().shapeNode;
        if (reducedMotion()) {
          this._index = nextIndex;
          this._showActive();
          return;
        }
        this._busy = true;
        var exitSign = direction > 0 ? -1 : 1;
        node.style.transition = "transform 260ms cubic-bezier(.4,0,1,1), opacity 260ms ease-in";
        node.style.transform = "translate(" + (exitSign * 620) + "px, 36px) rotate(" + (exitSign * 18) + "deg)";
        node.style.opacity = "0";
        setTimeout(function () {
          self._index = nextIndex;
          self._showActive();
          node.style.transition = "none";
          node.style.transform = "translate(0px, 0px) scale(0.92)";
          node.style.opacity = "0";
          node.offsetHeight;   // force layout so the settle-in animates
          node.style.transition = "transform 260ms cubic-bezier(0,0,.2,1), opacity 220ms ease-out";
          node.style.transform = "translate(0px, 0px) scale(1)";
          node.style.opacity = "1";
          setTimeout(function () { self._busy = false; }, 260);
        }, 260);
      },

      // Eases a card that was dragged part-way back into place.
      _settle: function () {
        var node = this._cardBox.renderContext().shapeNode;
        node.style.transition = "transform 200ms ease, opacity 200ms ease";
        node.style.transform = "translate(0px, 0px) rotate(0deg)";
        node.style.opacity = "1";
      },

      // Arrow keys turn the reel unless something is taking text input.
      _installKeys: function () {
        var self = this;
        this._keyHandler = function (evt) {
          if (evt.key !== "ArrowLeft" && evt.key !== "ArrowRight") return;
          if (evt.ctrlKey || evt.metaKey || evt.altKey || evt.shiftKey) return;
          if (lively.morphic.Text.activeInstance && lively.morphic.Text.activeInstance()) return;
          var el = document.activeElement;
          if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
          if (!self._feed.length) return;
          self._turn(evt.key === "ArrowLeft" ? -1 : 1);
        };
        document.addEventListener("keydown", this._keyHandler);
      },
    },

    "swipe", {
      // A press on the card starts tracking; once it moves mostly sideways the
      // card follows the pointer, and letting go past SWIPE_PX turns it. The
      // move/up listeners go on `document` in the capture phase, because
      // Lively's own capture chain swallows them on the element (CLAUDE.md,
      // "Drag handling on a plain DOM element inside a morph").
      _onPointerDown: function (evt) {
        if (this._busy || this._swipe || this._feed.length < 1) return;
        if (evt.pointerType === "mouse" && evt.button !== 0) return;
        var t = evt.target;
        if (t && t.closest && t.closest("button, a, input, textarea, select, [contenteditable='true']")) return;
        // A mouse drag inside the content area selects text; swiping from there is
        // for touch only. The header and footer strips swipe with either.
        if (evt.pointerType === "mouse" && t && t.closest && t.closest(".lively-postcard-view-content")) return;

        this._swipe = {
          id: evt.pointerId, x0: evt.clientX, y0: evt.clientY, dx: 0, engaged: false,
          move: this._onPointerMove.bind(this), up: this._onPointerUp.bind(this),
        };
        document.addEventListener("pointermove", this._swipe.move, true);
        document.addEventListener("pointerup", this._swipe.up, true);
        document.addEventListener("pointercancel", this._swipe.up, true);
      },

      _onPointerMove: function (evt) {
        var s = this._swipe;
        if (!s || evt.pointerId !== s.id) return;
        var dx = evt.clientX - s.x0, dy = evt.clientY - s.y0;
        if (!s.engaged) {
          if (Math.abs(dx) < SWIPE_START_PX) return;
          if (Math.abs(dy) > Math.abs(dx)) return;   // vertical-dominant: let the content scroll
          s.engaged = true;
          this._savedUserSelect = document.body.style.userSelect;
          document.body.style.userSelect = "none";
          try { window.getSelection().removeAllRanges(); } catch (e) {}
        }
        s.dx = dx;
        var node = this._cardBox.renderContext().shapeNode;
        node.style.transition = "none";
        node.style.transform = "translate(" + dx + "px, 0px) rotate(" + (dx / 40) + "deg)";
        evt.preventDefault();
      },

      _onPointerUp: function (evt) {
        var s = this._swipe;
        if (!s || evt.pointerId !== s.id) return;
        this._removeSwipeListeners();
        if (!s.engaged) return;
        // Drag left = the next card, drag right = the previous one.
        if (Math.abs(s.dx) >= SWIPE_PX && this._feed.length > 1) this._turn(s.dx < 0 ? 1 : -1);
        else this._settle();
      },

      _removeSwipeListeners: function () {
        var s = this._swipe;
        if (!s) return;
        document.removeEventListener("pointermove", s.move, true);
        document.removeEventListener("pointerup", s.up, true);
        document.removeEventListener("pointercancel", s.up, true);
        if (s.engaged) document.body.style.userSelect = this._savedUserSelect || "";
        this._swipe = null;
      },
    });

  });
