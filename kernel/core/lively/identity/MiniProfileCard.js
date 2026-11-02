/**
 * lively.identity.MiniProfileCard
 *
 * A small anchored popover (avatar, display name, @handle, sun sign when
 * set, host, short bio snippet, "View full profile" button) shown when a
 * handle rendered elsewhere in the app (e.g. ConstellationLounge.js's
 * co-creator handle) is clicked. Not a lively.BuildSpec window like
 * ProfileCard.js — this is a transient scrim+box popover, dismissed on
 * outside click, following the same shape as CalendarApp.js's
 * _showEventPopover/_hidePopover.
 *
 * Open: lively.identity.MiniProfileCard.open(handle, did, anchor, opts)
 * opts is optional: { roomContext, isController, constellationName, roomId }
 * — see open()'s own doc comment below. roomContext/isController gate the
 * mod-view shield badge; constellationName/roomId feed the overflow menu's
 * Flag Profile action (which constellation/room's controllers get the
 * report) and are otherwise unrelated to the shield.
 *
 * anchor is either a morph (its worldPoint()/getExtent() position the
 * popover just below it, as every morph-based call site does) or a plain
 * lively.pt(x, y) already in world coordinates, for callers with no morph
 * to point at — e.g. WikiView.js's raw-DOM avatar/handle chips, which
 * compute the world position themselves via their own owner morph's
 * worldPoint().
 *
 * The host row is the member's home instance, read from the "#home" service
 * entry the server records in their DID document (see DidHome.js). It is
 * left out when the document has none — never guessed.
 */

module("lively.identity.MiniProfileCard")
  .requires(
    "lively.identity.PostCardUtils",
    "lively.identity.DID",
    "lively.identity.PostCardSerializer",
    "lively.morphic.Complete",
  )
  .toRun(function () {

    var PINK = Color.rgb(0xCC, 0x00, 0x57); // ProfileCard.js's own window-frame color
    var TEXT_MUTED = Color.rgb(140, 140, 140);
    var CLOSE_HOVER_RED = Color.rgb(224, 66, 66); // base_theme.css's .Button.WindowControl.close:hover
    var CARD_W = 260;
    var LOADING_H = 92; // provisional height until the profile has loaded
    var CLOSE = 22, CLOSE_GLYPH_PX = 13;
    var MENU = 22, MENU_GLYPH_PX = 14; // "more_vert" reads a touch smaller than "close" at equal box size, bumped up 1px
    var TOPRIGHT_GAP = 4;
    var CLOSE_X = CARD_W - 8 - CLOSE;             // 230
    var MENU_X = CLOSE_X - TOPRIGHT_GAP - MENU;   // 204 — left of the close button
    var HEAD_W = MENU_X - TOPRIGHT_GAP - 64; // name/handle column: right of the avatar, left of the menu+close buttons
    var NAME_MAX = 20, HANDLE_MAX = 24, HOST_MAX = 30, BIO_MAX = 100;
    var ROW_H = 20, ROW_GAP = 2, ICON_NUDGE = 2, BIO_LINE_H = 17, BIO_CHARS_PER_LINE = 34, BIO_MAX_LINES = 3;

    // Same sign order / glyphs / element colors as ProfileCard.js's own sign
    // display (SIGNS/GLYPHS in its profile pane, ELEMENT_RGB indexed i % 4) —
    // duplicated so this popover doesn't have to load all of ProfileCard.js
    // just for a color table.
    var SIGNS  = ["Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo",
                  "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces"];
    var GLYPHS = ["♈︎", "♉︎", "♊︎", "♋︎", "♌︎", "♍︎", "♎︎", "♏︎", "♐︎", "♑︎", "♒︎", "♓︎"];
    var ELEMENT_RGB = [[196, 56, 24], [38, 120, 66], [0, 118, 148], [95, 74, 196]];

    // Every child morph a popover is built from needs this, not just the
    // card itself — a click landing on any decorative child (avatar, name,
    // bio) would otherwise still be eaten as a drag. See CLAUDE.md's
    // "disabling drag/drop/grab needs three flags, and every visible child
    // individually".
    function noDrag(m) {
      m.draggingEnabled = false;
      m.droppingEnabled = false;
      m.grabbingEnabled = false;
      return m;
    }

    function trunc(s, max) {
      s = String(s == null ? "" : s);
      return s.length > max ? s.slice(0, max - 1).replace(/\s+$/, "") + "…" : s;
    }

    function label(rect, text, opts) {
      opts = opts || {};
      var t = new lively.morphic.Text(rect);
      t.textString = text;
      t.applyStyle({
        fontSize: (opts.px || 12) * 0.75,
        fontWeight: opts.bold ? "bold" : "normal",
        textColor: opts.color || Color.rgb(40, 40, 40),
        fill: null,
        borderWidth: 0,
        align: "left",
        allowInput: false, selectable: false,
        clipMode: "hidden",
        whiteSpaceHandling: opts.wrap ? "normal" : "pre",
      });
      noDrag(t);
      t.eventsAreIgnored = true;
      return t;
    }

    // Material Symbols glyph (see CLAUDE.md's icon note); box sized from the
    // glyph's designed px size, not measured.
    function icon(rect, ligature, px, color) {
      var t = new lively.morphic.Text(rect, ligature);
      t.applyStyle({
        fontFamily: "'Material Symbols Rounded'", fontSize: px * 0.75,
        textColor: color, fill: null, borderWidth: 0, align: "center",
        allowInput: false, selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre",
      });
      noDrag(t);
      t.eventsAreIgnored = true;
      return t;
    }

    // Pink "mat" frame — same technique this codebase's other small dialogs
    // use (NewWikiPageDialog.js's BuildSpec `_Fill` on the outer Window
    // itself, which shows through as a colored margin around the inset
    // content pane; nothing painted on top, no thick extra border). Driven
    // via a scoped CSS class rather than applyStyle/setFill, since a plain
    // applyStyle({fill:...}) on an already-rendered classic Window can
    // silently update the model without reaching the DOM (CLAUDE.md's
    // applyStyle-DOM-sync gotcha) — same technique PostCardMailbox.js's
    // _ensureAccentChromeCss/DMChat.js's applyAccentChrome already use for
    // their own per-window accent colors. Default `.Text.window-title`
    // (dark gray, tuned for the default light-gray chrome) reads poorly
    // against this saturated a pink, so it's forced white here too — same
    // fix DMChat's indigo/Wallet's violet accents needed.
    function _ensureFlagDialogChromeCss() {
      var STYLE_ID = "miniprofilecard-flag-dialog-chrome-style";
      if (document.getElementById(STYLE_ID)) return;
      var styleEl = document.createElement("style");
      styleEl.id = STYLE_ID;
      styleEl.textContent = [
        ".Window.flag-dialog-pink-frame { background-color: rgb(204,0,87) !important; }",
        ".Window.flag-dialog-pink-frame .Text.window-title { color: #fff; }",
        ".Window.flag-dialog-pink-frame.highlighted .Text.window-title { color: #fff; font-weight: bold; }",
        ".Window.flag-dialog-pink-frame.highlighted { border: none !important; box-shadow: 0px 3px 10px rgba(204,0,87,0.35) !important; }",
      ].join("\n");
      document.head.appendChild(styleEl);
    }

    lively.identity.MiniProfileCard = {
      _scrim: null,
      _card: null,

      close: function () {
        if (this._card)  { this._card.remove();  this._card = null; }
        if (this._scrim) { this._scrim.remove(); this._scrim = null; }
      },

      // Home host (e.g. "tinylil.world") from a DID document's "#home"
      // service entry, or null.
      _homeHostOf: function (doc) {
        var services = (doc && Array.isArray(doc.service)) ? doc.service : [];
        for (var i = 0; i < services.length; i++) {
          var s = services[i];
          if (s && s.id === doc.id + "#home" && typeof s.serviceEndpoint === "string") {
            return s.serviceEndpoint.replace(/^https?:\/\//, "").replace(/\/+$/, "") || null;
          }
        }
        return null;
      },

      // anchor is either a morph (worldPoint()/getExtent(), as every
      // existing call site passes) or a plain lively.pt(x, y) already in
      // world coordinates (WikiView.js's DOM-anchored chips: there's no
      // morph to point at, so the caller computes the world position
      // itself via its own worldPoint()).
      //
      // opts is optional: { roomContext, isController }. roomContext marks
      // this popover as opened from a cluster/room (ConstellationLounge.js/
      // RoomView.js), as opposed to e.g. a wiki page. The mod-view shield
      // badge only shows when roomContext AND isController (the *viewer's*
      // own moderator/controller status, not the viewed person's) are both
      // true. Callers that omit opts (WikiView.js) get no shield, same as
      // before this param existed.
      open: function (handle, did, anchor, opts) {
        var self = this;
        this.close(); // only one popover open at a time
        var roomContext = !!(opts && opts.roomContext);
        var isController = !!(opts && opts.isController);
        var constellationName = (opts && opts.constellationName) || null;
        var roomId = (opts && opts.roomId) || null;

        var W = window.innerWidth, H = window.innerHeight;
        // World coordinates equal page/document coordinates (Core.js's
        // worldPoint composes the owner-chain transform, independent of
        // scroll) — but the viewport clamp bounds below are naturally
        // viewport-relative, so they need the current scroll offset added
        // to stay correct when the world is taller than the viewport and
        // the page has scrolled (see WikiView.js's _growWorldToFit). Zero
        // for every existing non-scrolling call site, so this is a no-op
        // there.
        var scrollX = (document.scrollingElement && document.scrollingElement.scrollLeft) || 0;
        var scrollY = (document.scrollingElement && document.scrollingElement.scrollTop) || 0;

        var scrim = new lively.morphic.Box(lively.rect(scrollX, scrollY, W, H));
        scrim.applyStyle({ fill: Color.rgba(0, 0, 0, 0), borderWidth: 0 });
        noDrag(scrim);
        scrim.onMouseUp = function (evt) { self.close(); evt.stop(); return true; };
        $world.addMorph(scrim);
        this._scrim = scrim;

        // anchorMorph lives directly in $world (same coordinate space, no
        // owner transform to account for) in every current call site, so
        // its worldPoint() is usable as-is for the card's own position.
        var anchorPos = (typeof anchor.worldPoint === "function")
          ? anchor.worldPoint(lively.pt(0, anchor.getExtent().y))
          : anchor;
        var px = Math.min(Math.max(8 + scrollX, anchorPos.x), scrollX + W - CARD_W - 8);
        var wantY = Math.max(8 + scrollY, anchorPos.y + 4);
        var py = Math.min(wantY, scrollY + H - LOADING_H - 8);

        var card = new lively.morphic.Box(lively.rect(px, py, CARD_W, LOADING_H));
        card.applyStyle({ fill: Color.white, borderRadius: 10, borderWidth: 1, borderColor: PINK, clipMode: "visible" });
        noDrag(card);
        // card intentionally has no onMouseUp of its own — added to $world
        // AFTER the scrim, so sibling paint/hit-test order alone keeps
        // clicks on it from reaching the scrim underneath (mirrors
        // CalendarApp.js's popover; see CLAUDE.md's capture-first mouse
        // dispatch note: an ancestor with no onMouseUp never blocks a
        // nested child's, and there's no ancestor/descendant relationship
        // between scrim and card here anyway — plain siblings).

        var avatar = new lively.morphic.Image(lively.rect(14, 14, 40, 40));
        avatar.setImageURL(lively.identity.postCardUtils.identiconDataUrl(did || handle, 40));
        avatar.applyStyle({ borderRadius: 20, borderWidth: 0, clipMode: "hidden" });
        noDrag(avatar);
        avatar.eventsAreIgnored = true;
        card.addMorph(avatar);

        var nameT = label(lively.rect(64, 16, HEAD_W, 18), trunc(handle, NAME_MAX), { px: 13, bold: true });
        card.addMorph(nameT);

        var handleT = label(lively.rect(64, 34, HEAD_W, 16), "@" + trunc(handle, HANDLE_MAX), { px: 11, color: TEXT_MUTED });
        card.addMorph(handleT);

        var loadingT = label(lively.rect(14, 62, CARD_W - 28, 20), "Loading…", { px: 11, color: Color.rgb(90, 90, 90) });
        card.addMorph(loadingT);

        // Modeled after the window chrome's own close button (base_theme.css's
        // .Button.WindowControl.close: circle backdrop, "close" glyph, red
        // circle + white glyph on hover) — same fontSize*0.75/padding-inset
        // icon-button idiom as ConstellationLounge.js's editBtn.
        var CLOSE_FILL = Color.rgb(240, 240, 240);
        var closeX = new lively.morphic.Text(lively.rect(CLOSE_X, 8, CLOSE, CLOSE), "close");
        closeX.applyStyle({
          fontFamily: "'Material Symbols Rounded'",
          fontSize: CLOSE_GLYPH_PX * 0.75,
          textColor: TEXT_MUTED,
          fill: CLOSE_FILL,
          borderRadius: CLOSE / 2,
          borderWidth: 0,
          align: "center",
          // 3px, not (CLOSE - CLOSE_GLYPH_PX)/2: the glyph's text box sits ~2px low
          // inside its circle at this size, measured live, so this centers the X.
          padding: lively.Rectangle.inset(0, 3, 0, 0),
          allowInput: false, selectable: false, clipMode: "hidden",
          whiteSpaceHandling: "pre", handStyle: "pointer",
        });
        noDrag(closeX);
        closeX.onMouseOver = function () { closeX.applyStyle({ fill: CLOSE_HOVER_RED, textColor: Color.white }); };
        closeX.onMouseOut  = function () { closeX.applyStyle({ fill: CLOSE_FILL, textColor: TEXT_MUTED }); };
        closeX.onMouseUp = function (evt) { self.close(); evt.stop(); return true; };
        card.addMorph(closeX);

        // Overflow menu — Share Profile always; Ignore/Block (labels flip to
        // Unignore/Unblock live, per lively.identity.did's synchronous
        // isMuted/isBlocked) and Flag Profile hidden on your own profile.
        // Built just-in-time on each open (not a static list) so it always
        // reflects current block/mute state. Same circle-backdrop
        // icon-button idiom as closeX above, but a neutral hover color (not
        // close's red) so the two read as distinct actions. Toggle-dance
        // (onMouseDown flags whether OUR menu was the one open at
        // mousedown; onMouseUp checks that flag and just closes instead of
        // reopening) copied from ProfileCard.js's own more_vert button,
        // which needs it for the same reason: a click that closes an open
        // menu (by landing on the scrim) still reaches this button's
        // onMouseUp right after, which would otherwise instantly reopen it.
        var MENU_FILL = Color.rgb(240, 240, 240);
        var MENU_HOVER = Color.rgb(224, 224, 224);
        var menuBtn = new lively.morphic.Text(lively.rect(MENU_X, 8, MENU, MENU), "more_vert");
        menuBtn.applyStyle({
          fontFamily: "'Material Symbols Rounded'",
          fontSize: MENU_GLYPH_PX * 0.75,
          textColor: TEXT_MUTED,
          fill: MENU_FILL,
          borderRadius: MENU / 2,
          borderWidth: 0,
          align: "center",
          padding: lively.Rectangle.inset(0, 3, 0, 0),
          allowInput: false, selectable: false, clipMode: "hidden",
          whiteSpaceHandling: "pre", handStyle: "pointer",
        });
        noDrag(menuBtn);
        menuBtn.onMouseOver = function () { menuBtn.applyStyle({ fill: MENU_HOVER }); };
        menuBtn.onMouseOut  = function () { menuBtn.applyStyle({ fill: MENU_FILL }); };
        menuBtn.onMouseDown = function () {
          menuBtn._wasMenuOpen = !!(menuBtn._openMenu && $world.currentMenu === menuBtn._openMenu);
        };
        menuBtn.onMouseUp = function (evt) {
          if (menuBtn._wasMenuOpen) { menuBtn._wasMenuOpen = false; menuBtn._openMenu = null; evt.stop(); return true; }
          var pos = menuBtn.worldPoint(lively.pt(0, menuBtn.getExtent().y));
          var isOwn = lively.identity.did.isOwnHandle(handle);
          var items = [
            ["Share Profile", function () { self._shareProfile(handle, menuBtn); }],
          ];
          if (!isOwn) {
            var muted = lively.identity.did.isMuted(did, handle);
            var blocked = lively.identity.did.isBlocked(did, handle);
            items.push([muted ? "Unignore @" + trunc(handle, HANDLE_MAX) : "Ignore @" + trunc(handle, HANDLE_MAX),
              function () { self._toggleMute(did, handle, muted, menuBtn); }]);
            items.push([blocked ? "Unblock @" + trunc(handle, HANDLE_MAX) : "Block @" + trunc(handle, HANDLE_MAX),
              function () { self._openBlockConfirm(did, handle, blocked, menuBtn); }]);
            if (constellationName) {
              items.push(["Flag Profile…", function () { self._openFlagReasonDialog(did, handle, constellationName, roomId); }]);
            }
          }
          menuBtn._openMenu = lively.morphic.Menu.openAt(pos, "@" + trunc(handle, HANDLE_MAX), items);
          evt.stop();
          return true;
        };
        card.addMorph(menuBtn);

        $world.addMorph(card);
        // Soft drop shadow, same idiom/values as the other floating panels
        // (FilePreview, WikiEditor): written straight to the shape node.
        card.renderContext().shapeNode.style.boxShadow = "0 4px 12px rgba(0,0,0,0.18)";
        this._card = card;

        var profileP = fetch("/@" + handle + "/profile", { credentials: "include" })
          .then(function (res) { return res.ok ? res.json() : null; });
        var hostP = fetch("/@" + handle + "/did-document", { credentials: "include" })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (doc) { return self._homeHostOf(doc); });

        Promise.all([profileP, hostP.catch(function () { return null; })])
          .then(function (r) { return { env: r[0], host: r[1], failed: false }; },
                function ()  { return { env: null, host: null, failed: true }; })
          .then(function (res) {
            if (self._card !== card) return; // popover closed/replaced before this resolved
            var payload = (res.env && res.env.record && res.env.record.payload) || {};
            if (res.env && payload.avatarUrl) avatar.setImageURL(payload.avatarUrl);
            if (res.env) {
              nameT.setTextString(trunc(payload.displayName || handle, NAME_MAX));
            }
            loadingT.remove();
            self._buildBody(card, {
              handle: handle,
              sunSign: res.env ? payload.sunSign : null,
              host: res.env ? res.host : null,
              bio: res.env ? (payload.bio || "").trim() : null,
              bioFallback: res.env ? "No bio yet." : "Could not load profile.",
              wantY: wantY,
              scrollY: scrollY,
              showModIcon: roomContext && isController,
            });
          });
      },

      // Meta rows + bio + "View full profile" button, laid out top to bottom
      // with each morph's final position baked into its constructor rect
      // (CLAUDE.md: don't setPosition a child right after addMorph), then the
      // card itself is resized to fit. Sun sign and host rows are only built
      // when there's a value for them, so an unset sign leaves no gap.
      _buildBody: function (card, d) {
        var self = this;
        var y = 62;
        var contentW = CARD_W - 28;

        var signIdx = SIGNS.indexOf(d.sunSign);
        if (signIdx >= 0) {
          var rgb = ELEMENT_RGB[signIdx % 4];
          // icons at y - ICON_NUDGE: measured live, an icon glyph's center sits
          // ~2.3px below the center of the adjacent Helvetica label at this size
          card.addMorph(icon(lively.rect(14, y - ICON_NUDGE, 18, ROW_H), "wb_sunny", 14, PINK));
          card.addMorph(label(lively.rect(36, y, contentW - 22, ROW_H), GLYPHS[signIdx] + " " + SIGNS[signIdx],
            { px: 11, bold: true, color: Color.rgb(rgb[0], rgb[1], rgb[2]) }));
          y += ROW_H + ROW_GAP;
        }

        // Shield/mod-view badge shares this row slot with the host line
        // (rowY captured before either renders) so it lands "aligned with
        // the host name" whether or not this particular person actually
        // has host data to show.
        var rowY = y;
        var SHIELD = 18;
        if (d.host) {
          var hostLabelW = contentW - 22 - (d.showModIcon ? SHIELD + 6 : 0);
          card.addMorph(icon(lively.rect(14, y - ICON_NUDGE, 18, ROW_H), "dns", 14, TEXT_MUTED));
          card.addMorph(label(lively.rect(36, y, hostLabelW, ROW_H), trunc(d.host, HOST_MAX),
            { px: 11, color: TEXT_MUTED }));
          y += ROW_H + ROW_GAP;
        }

        if (d.showModIcon) {
          var shield = new lively.morphic.Text(
            lively.rect(14 + contentW - SHIELD, rowY - ICON_NUDGE, SHIELD, ROW_H), "shield_person");
          shield.applyStyle({
            fontFamily: "'Material Symbols Rounded'", fontSize: 15 * 0.75,
            textColor: PINK, fill: null, borderWidth: 0, align: "center",
            allowInput: false, selectable: false, clipMode: "hidden",
            whiteSpaceHandling: "pre", handStyle: "pointer",
          });
          noDrag(shield);
          shield.onMouseUp = function (evt) {
            self._openModPlaceholderWindow(d.handle);
            evt.stop();
            return true;
          };
          card.addMorph(shield);
          if (!d.host) { y = rowY + ROW_H + ROW_GAP; } // reserve the row even with no host text
        }

        var bioText = d.bio ? trunc(d.bio, BIO_MAX) : d.bioFallback;
        var bioLines = Math.min(BIO_MAX_LINES, Math.max(1, Math.ceil(bioText.length / BIO_CHARS_PER_LINE)));
        var bioH = bioLines * BIO_LINE_H + 4;
        card.addMorph(label(lively.rect(14, y + 2, contentW, bioH), bioText,
          { px: 11, color: d.bio ? Color.rgb(90, 90, 90) : TEXT_MUTED, wrap: true }));
        y += 2 + bioH + 8;

        var cardH = self._addViewButton(card, d.handle, y) + 10;
        card.setExtent(lively.pt(CARD_W, cardH));

        // The taller card may no longer fit below the anchor: pull it up.
        var H = window.innerHeight;
        var scrollY = d.scrollY || 0;
        var pos = card.getPosition();
        var newY = Math.min(d.wantY, scrollY + H - cardH - 8);
        if (newY !== pos.y) card.setPosition(lively.pt(pos.x, Math.max(8 + scrollY, newY)));
      },

      // Returns the y of the button's bottom edge.
      _addViewButton: function (card, handle, y) {
        var self = this;

        // Label + trailing "arrow_outward" glyph, positioned as a tight
        // pair centered in the button rather than each independently
        // centered in its own half (which would leave an uneven gap
        // between them) — VIEW_LABEL_W is this exact string's real
        // rendered width at this fontSize, measured live once via a
        // throwaway probe morph and hardcoded here, same idiom as
        // WorldsBrowser.js's back-link width (CLAUDE.md: safe for a
        // short, static label that never changes).
        var VIEW_LABEL_W = 81, ICON_PX = 13, GAP = 4;
        var btnW = CARD_W - 28;
        var pairW = VIEW_LABEL_W + GAP + ICON_PX;
        var pairX = Math.round((btnW - pairW) / 2);

        var viewBtn = new lively.morphic.Box(lively.rect(14, y, btnW, 24));
        viewBtn.applyStyle({ fill: Color.white, borderRadius: 12, borderWidth: 1, borderColor: PINK, clipMode: "hidden" });
        noDrag(viewBtn);
        viewBtn.onMouseOver = function () { viewBtn.applyStyle({ fill: Color.rgb(253, 235, 243) }); };
        viewBtn.onMouseOut  = function () { viewBtn.applyStyle({ fill: Color.white }); };
        viewBtn.onMouseUp = function (evt) {
          self.close();
          lively.require("lively.identity.ProfileCard").toRun(function () {
            lively.identity.ProfileCard.open(handle);
          });
          evt.stop();
          return true;
        };
        card.addMorph(viewBtn);

        var viewLabel = new lively.morphic.Text(lively.rect(pairX - 4, 0, VIEW_LABEL_W + 8, 24), "View full profile");
        viewLabel.applyStyle({
          fontSize: 11 * 0.75, fontWeight: "600", textColor: PINK, fill: null, borderWidth: 0,
          align: "left", padding: lively.Rectangle.inset(0, 5, 0, 0),
          allowInput: false, selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre",
        });
        noDrag(viewLabel);
        viewLabel.eventsAreIgnored = true;
        viewBtn.addMorph(viewLabel);

        // x/padding-top both nudged from their naive computed values by an
        // empirical correction (measured live via getBoundingClientRect on
        // both glyphs: real gap came out ~12px against an intended ~4px,
        // and the icon's glyph center sat ~2.7px below the label's) —
        // same "measure, don't trust the naive box math" discipline as
        // the rest of this codebase's text-sizing gotchas.
        var viewIcon = new lively.morphic.Text(lively.rect(pairX + VIEW_LABEL_W + GAP - 8, 0, ICON_PX + 8, 24), "arrow_outward");
        viewIcon.applyStyle({
          fontFamily: "'Material Symbols Rounded'", fontSize: ICON_PX * 0.75,
          textColor: PINK, fill: null, borderWidth: 0,
          align: "center", padding: lively.Rectangle.inset(0, Math.round((24 - ICON_PX) / 2) - 3, 0, 0),
          allowInput: false, selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre",
        });
        noDrag(viewIcon);
        viewIcon.eventsAreIgnored = true;
        viewBtn.addMorph(viewIcon);

        return y + 24;
      },

      // Placeholder for the real moderator-view UI — proves the shield
      // icon's wiring works. Programmatic Window constructor (not a
      // declarative BuildSpec submorph), so contentOffset is applied
      // automatically and there's no title-bar-overlap gotcha to work
      // around here.
      _openModPlaceholderWindow: function (handle) {
        var body = new lively.morphic.Box(lively.rect(0, 0, 240, 70));
        body.applyStyle({ fill: Color.rgb(250, 250, 252), borderWidth: 0 });
        var msg = label(lively.rect(14, 14, 212, 42), "Coming soon.", { px: 12, color: Color.rgb(90, 90, 90), wrap: true });
        body.addMorph(msg);
        var win = new lively.morphic.Window(body, "Moderator View — @" + handle);
        $world.addMorph(win);
        win.comeForward();
      },

      // Small transient tooltip near a menu-adjacent morph — success/failure
      // feedback for a menu action that already closed its own menu. Raw DOM
      // bubble appended to document.body (a lively.morphic.Menu item click
      // leaves no morph-internal place to swap a label into), same idiom as
      // PostCardView.js's _flashNearMoreBtn, adapted for a morph ref instead
      // of a raw DOM element.
      _flashNear: function (refMorph, msg, isError) {
        if (isError) console.error("[MiniProfileCard]", msg);
        var node = refMorph && refMorph.renderContext && refMorph.renderContext().shapeNode;
        if (!node) return;
        var rect = node.getBoundingClientRect();
        var bubble = document.createElement("div");
        bubble.textContent = msg;
        var bg = isError ? "#fff5f5" : "#f0fdf4";
        var border = isError ? "#f3b4b4" : "#bbf7d0";
        var color = isError ? "#a33" : "#166534";
        bubble.style.cssText = [
          "position:fixed", "z-index:9999",
          "top:" + Math.round(rect.bottom + 4) + "px",
          "left:" + Math.round(rect.right - 180) + "px",
          "width:180px", "background:" + bg, "border:1px solid " + border,
          "color:" + color, "border-radius:8px", "box-shadow:0 4px 14px rgba(0,0,0,0.2)",
          "padding:7px 10px", "font-family:sans-serif", "font-size:12px",
          "box-sizing:border-box",
        ].join(";");
        document.body.appendChild(bubble);
        setTimeout(function () { bubble.remove(); }, 2200);
      },

      _shareProfile: function (handle, refMorph) {
        var self = this;
        var url = lively.identity.did.baseUrl() + "/@" + encodeURIComponent(handle);
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url)
            .then(function () { self._flashNear(refMorph, "Link copied"); })
            .catch(function () { window.prompt("Copy this link:", url); });
        } else {
          window.prompt("Copy this link:", url);
        }
      },

      _toggleMute: function (did, handle, wasMuted, refMorph) {
        var self = this;
        var fn = wasMuted ? lively.identity.did.unmuteDid : lively.identity.did.muteDid;
        fn.call(lively.identity.did, did, handle, function (err) {
          if (err) return self._flashNear(refMorph, "Could not update — " + err.message, true);
          self._flashNear(refMorph, wasMuted ? "Unignored" : "Ignored");
        });
      },

      _openBlockConfirm: function (did, handle, wasBlocked, refMorph) {
        var self = this;
        if (wasBlocked) {
          // Unblocking is not destructive — no confirmation needed.
          lively.identity.did.unblockDid(did, handle, function (err) {
            if (err) return self._flashNear(refMorph, "Could not unblock — " + err.message, true);
            self._flashNear(refMorph, "Unblocked");
          });
          return;
        }
        $world.confirm(
          "Block @" + handle + "? They won't be able to contact you and you won't see their messages.",
          function (ok) {
            if (!ok) return;
            lively.identity.did.blockDid(did, handle, function (err) {
              if (err) return self._flashNear(refMorph, "Could not block — " + err.message, true);
              self._flashNear(refMorph, "Blocked");
            });
          },
        );
      },

      // Small reason-entry dialog for Flag Profile. Programmatic Window
      // constructor (same idiom as _openModPlaceholderWindow above), not a
      // BuildSpec module, to keep this two-field dialog local to this file
      // — but styled after this codebase's established small-dialog look
      // (NewWikiPageDialog.js): a colored window "mat" (the outer Window's
      // own fill, showing through as a margin around the inset pane —
      // NOT a thick painted-on border) framing a light-gray content pane
      // with its own subtle dark border, small gray field labels above
      // white bordered inputs, and Cancel/primary buttons clustered
      // bottom-right rather than spread edge-to-edge.
      _openFlagReasonDialog: function (targetDid, targetHandle, constellationName, roomId) {
        var W = 360, PAD = 14;
        var MAX_REASON = 250;
        var body = new lively.morphic.Box(lively.rect(0, 0, W, 297));
        // Matches NewWikiPageDialog's content-pane look (_Fill:243/243/243,
        // _BorderColor:95/94/95, _BorderRadius:4) rather than this dialog's
        // previous borderless off-white box.
        body.applyStyle({ fill: Color.rgb(243, 243, 243), borderColor: Color.rgb(95, 94, 95), borderWidth: 1, borderRadius: 4 });

        body.addMorph(label(lively.rect(PAD, 12, W - PAD * 2, 18),
          "Report @" + targetHandle + " to moderators", { px: 13, bold: true, color: Color.rgb(40, 40, 40) }));

        // Small field label above the box (NewWikiPageDialog's addField
        // pattern: a short gray label, then the input directly below it),
        // rather than folding "briefly explain why" into the sentence above.
        body.addMorph(label(lively.rect(PAD, 32, W - PAD * 2, 16),
          "Reason", { px: 11, color: Color.rgb(120, 120, 120) }));

        // Multi-line, wrapped (whiteSpaceHandling: "pre-wrap", same as
        // RoomView.js's own chat-body text) — beInputLine() alone
        // (RoomSettingsDialog.js's textField idiom) is fine for a
        // genuinely single-line field, but this one needs real wrapping,
        // same as ProfileCard.js's own multi-line Bio field (which also
        // calls beInputLine() at a taller extent). 156px is a measured
        // constant (CLAUDE.md: guessed per-line-height math on a
        // multi-line box reliably undershoots and clips the last line) —
        // confirmed live against a real 280-char wrapped string at this
        // exact width/font, so a 250-char reason never clips.
        var reasonField = new lively.morphic.Text(lively.rect(PAD, 49, W - PAD * 2, 156), "");
        reasonField.name = "flagReasonField"; // looked up by name from the counter's addScript handler below, not a closure var
        reasonField.beInputLine();
        reasonField.applyStyle({
          allowInput: true, fontSize: 12, fontFamily: "Helvetica", clipMode: "hidden",
          fixedWidth: true, fixedHeight: true, whiteSpaceHandling: "pre-wrap",
          fill: Color.white, borderColor: Color.rgb(203, 203, 203), borderWidth: 1, borderRadius: 4,
          padding: lively.Rectangle.inset(6, 6, 0, 0),
        });
        reasonField.setExtent(lively.pt(W - PAD * 2, 156));
        body.addMorph(reasonField);

        // Live "N / 250" counter, truncating on overflow — same idiom as
        // ProfileCard.js's Bio field counter (onKeyUp fires Text's own
        // 'textString' signal; the counter listens and trims/repositions
        // the caret at the end so continued typing doesn't prepend).
        var counter = new lively.morphic.Text(lively.rect(PAD, 209, W - PAD * 2, 14), "0 / " + MAX_REASON);
        counter.applyStyle({ allowInput: false, fontSize: 10, align: "right",
          textColor: Color.rgb(140, 140, 148), fill: null, borderWidth: 0,
          selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre" });
        // maxReason is a plain morph property, not a closure `var` read
        // inside the script body — addScript-installed methods are
        // reconstructed from their own source text at call time and lose
        // the enclosing closure (CLAUDE.md), so MAX_REASON itself would be
        // "not defined" the first time this actually runs.
        counter.maxReason = MAX_REASON;
        counter.addScript(function onReasonChanged(s) {
          s = s || "";
          var max = this.maxReason;
          if (s.length > max) {
            s = s.slice(0, max);
            var inp = this.owner && this.owner.get("flagReasonField");
            if (inp) { inp.textString = s; inp.setSelectionRange(s.length, s.length); }
          }
          this.setTextString(s.length + " / " + max);
          this.applyStyle({ textColor: s.length >= max ? Color.rgb(200, 40, 40) : Color.rgb(140, 140, 148) });
        });
        body.addMorph(counter);
        lively.bindings.connect(reasonField, "textString", counter, "onReasonChanged");

        var errorLabel = label(lively.rect(PAD, 229, W - PAD * 2, 16), "", { px: 11, color: Color.rgb(200, 60, 60) });
        body.addMorph(errorLabel);

        // Cancel: plain white/gray-bordered, matching NewWikiPageDialog's
        // own Cancel button exactly. Primary (Send): the light-pink-tint +
        // pink-border + pink-text look this file's OWN "View full profile"
        // button already established (_addViewButton above) — its hover
        // fill (Color.rgb(253,235,243)) used here as Send's resting fill —
        // rather than a solid saturated pink block, for visual consistency
        // within this same file.
        function makeButton(rect, text, primary) {
          var btn = new lively.morphic.Box(rect);
          btn.applyStyle({
            fill: primary ? Color.rgb(253, 235, 243) : Color.white, borderRadius: 5, borderWidth: 1,
            borderColor: primary ? PINK : Color.rgb(214, 214, 214), clipMode: "hidden",
          });
          noDrag(btn);
          var t = new lively.morphic.Text(lively.rect(0, 0, rect.width, rect.height), text);
          t.applyStyle({
            fontSize: 12 * 0.75, textColor: primary ? PINK : Color.rgb(60, 60, 60),
            fill: null, borderWidth: 0, align: "center",
            padding: lively.Rectangle.inset(0, Math.round((rect.height - 12) / 2) - 2, 0, 0),
            allowInput: false, selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre",
          });
          noDrag(t);
          t.eventsAreIgnored = true;
          btn.addMorph(t);
          return btn;
        }

        // Both start at a generous placeholder width/position and get
        // snug-fit + re-clustered bottom-right below, once real span
        // measurement is possible (see the setTimeout pass at the end of
        // this function).
        var cancelBtn = makeButton(lively.rect(PAD, 255, 90, 28), "Cancel", false);
        cancelBtn.onMouseUp = function (evt) { win.remove(); evt.stop(); return true; };
        body.addMorph(cancelBtn);

        var sendBtn = makeButton(lively.rect(W - PAD - 90, 255, 90, 28), "Send", true);
        sendBtn.onMouseUp = function (evt) {
          var reason = (reasonField.textString || "").trim().slice(0, MAX_REASON);
          if (!reason) { errorLabel.setTextString("Please enter a reason."); evt.stop(); return true; }
          errorLabel.setTextString("");
          var user = lively.identity.did.currentUser();
          if (!user) { errorLabel.setTextString("Not signed in."); evt.stop(); return true; }

          var doc = {
            type: "doc",
            content: [{
              type: "paragraph",
              content: [{ type: "text",
                text: "Profile flag: @" + targetHandle + " — " + reason }],
            }],
          };
          lively.identity.postCardSerializer.serializePlainToEnvelope({
            doc: doc,
            title: "Profile flag: @" + targetHandle,
            titleExplicit: true,
            constellation: constellationName,
            visibility: "public",
            stateMeta: { kind: "profile-flag", reason: reason, targetDid: targetDid, targetHandle: targetHandle },
          }, function (err, envelope) {
            if (err) { errorLabel.setTextString("Could not create report: " + err.message); return; }
            var base = lively.identity.did.baseUrl();
            fetch(base + "/@" + encodeURIComponent(user.handle) + "/" + encodeURIComponent(envelope.objId), {
              method: "PUT", credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(envelope),
            }).then(function (r) {
              if (!r.ok) throw new Error("Could not save report (" + r.status + ")");
              return fetch(base + "/c/" + encodeURIComponent(constellationName) + "/flags", {
                method: "POST", credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ objId: envelope.objId, targetDid: targetDid, roomId: roomId || undefined }),
              });
            }).then(function (r) {
              if (!r) return;
              if (!r.ok) return r.json().catch(function () { return {}; }).then(function (b) {
                throw new Error(b.error || ("Flag failed (" + r.status + ")"));
              });
              win.remove();
              $world.alert("Report sent to moderators.");
            }).catch(function (err2) {
              errorLabel.setTextString(err2.message);
            });
          });
          evt.stop();
          return true;
        };
        body.addMorph(sendBtn);

        // new lively.morphic.Window(...)'s own initialize() takes its
        // initial bounds straight from targetMorph.bounds() — before
        // being added anywhere, `body`'s bounds are just its own
        // constructor rect, (0,0,...), so plain $world.addMorph(win)
        // (as _openModPlaceholderWindow above does) pins it to the
        // world's top-left corner instead of somewhere sensible.
        // openInWorldCenter() (MorphAddons.js) adds it to the world AND
        // re-centers it in the current viewport in one call — the same
        // idiom LoginDialog.js/RegisterDialog.js use for their own
        // programmatic-Window dialogs.
        var win = new lively.morphic.Window(body, "Flag Profile — @" + targetHandle);
        _ensureFlagDialogChromeCss();
        win.addStyleClassName("flag-dialog-pink-frame");
        win.openInWorldCenter();
        win.comeForward();
        reasonField.focus();

        // Snug-fit Cancel/Send to their own label width instead of the
        // generous 120px placeholder each was built at — needs a real
        // render pass first (CLAUDE.md: measuring a span in the same tick
        // as adding the morph to the world can still read back 0), so this
        // runs a turn later via setTimeout, not right after
        // openInWorldCenter() above.
        setTimeout(function () {
          var BTN_H_PAD = 16;
          function snugFit(btn) {
            var lbl = btn.submorphs[0];
            var span = lbl.renderContext().shapeNode.querySelector("span");
            if (!span) return;
            var w = span.offsetWidth + BTN_H_PAD * 2;
            btn.setExtent(lively.pt(w, btn.getExtent().y));
            lbl.setExtent(lively.pt(w, lbl.getExtent().y));
          }
          snugFit(cancelBtn);
          snugFit(sendBtn);
          // Cluster both buttons bottom-right (NewWikiPageDialog's own
          // Cancel/Create layout), not spread edge-to-edge.
          var y = sendBtn.getPosition().y;
          var sendX = W - PAD - sendBtn.getExtent().x;
          sendBtn.setPosition(lively.pt(sendX, y));
          cancelBtn.setPosition(lively.pt(sendX - 8 - cancelBtn.getExtent().x, y));
        }, 0);
      },
    };

  }); // end module('lively.identity.MiniProfileCard')
