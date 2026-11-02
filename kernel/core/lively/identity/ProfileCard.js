/**
 * lively.identity.ProfileCard
 *
 * Simple single-column profile window.
 * Read view: handle, displayName, bio, links, DID + device info.
 * Owner: Edit button switches to editable fields with Save/Cancel.
 *
 * Button handlers use this.owner._win to reach the Window and
 * this._prop for data stored on the button, avoiding evalJS closure loss.
 *
 * Open: lively.identity.ProfileCard.open(handle?)
 */

module("lively.identity.ProfileCard")
  .requires(
    "lively.identity.UserSpace",
    "lively.identity.DID",
    "lively.identity.FileCrypto",
    "lively.identity.ImageCropper",
    "lively.identity.PostCardUtils",
    "lively.identity.QuiltPatterns",
    "lively.identity.WebKey",
    "lively.identity.NatalChart",
    "lively.persistence.BuildSpec",
    "lively.morphic.Complete",
  )
  .toRun(function () {

    lively.BuildSpec("lively.identity.ProfileCard", {
      _Extent:         lively.pt(840, 620),
      _BorderRadius:   10,
      // Fill-frame/mat technique (see NewWikiPageDialog.js): the window's
      // own fill shows through as a colored margin around the white
      // ProfileCardPane below and behind the title bar (which has its own
      // background: none in base_theme.css), giving a colored frame with
      // no separate border morph needed.
      _Fill:           Color.rgb(0xCC, 0x00, 0x57),
      className:       "lively.morphic.Window",
      contentOffset:   lively.pt(3, 22),
      draggingEnabled: true,
      droppingEnabled: false,
      layout:          { adjustForNewBounds: true },
      name:            "ProfileCardWindow",

      submorphs: [{
        _Extent:       lively.pt(834, 595),
        _Fill:         Color.rgb(255, 255, 255),
        _Position:     lively.pt(3, 22),
        _BorderRadius: 10,
        className:     "lively.morphic.Box",
        layout:    { adjustForNewBounds: true, resizeHeight: true, resizeWidth: true },
        name:      "ProfileCardPane",
        submorphs: [],
      }],

      onFromBuildSpecCreated: function onFromBuildSpecCreated() {
        this.targetMorph = this.get("ProfileCardPane");
        this._editMode   = false;
        this._handle     = null;
        this._envelope   = null;
        this._isOwner    = false;
        var titleBar = this.makeTitleBar("Profile", this.getExtent().x);
        this.titleBar = this.addMorph(titleBar);
        this._ensureAccentChromeCss();
        this.addStyleClassName("identity-accent-chrome");
      },

      // Title text sits on the window's colored fill, so the base theme's
      // #555 is hard to read -- same shared class/technique as
      // LoginDialog.js's _ensureAccentChromeCss.
      _ensureAccentChromeCss: function () {
        var STYLE_ID = "identity-accent-chrome-style";
        if (document.getElementById(STYLE_ID)) return;
        var styleEl = document.createElement("style");
        styleEl.id = STYLE_ID;
        styleEl.textContent = [
          ".Window.identity-accent-chrome .Text.window-title { color: #fff; }",
          ".Window.identity-accent-chrome.highlighted .Text.window-title { color: #fff; font-weight: bold; }",
        ].join("\n");
        document.head.appendChild(styleEl);
      },

      loadProfile: function loadProfile(handle) {
        var self   = this;
        var user   = lively.identity.did.currentUser();
        var target = handle || (user && user.handle);
        if (!target) { self._showMsg("Not logged in."); return; }

        self._handle      = target;
        self._isOwner     = !!(user && user.handle === target);
        // The Enter button opens this handle's homestar, so it is pointless on
        // that very page (the card is a window over it there).
        self._showEnter   = decodeURIComponent(window.location.pathname).replace(/\/+$/, "") !== "/@" + target;

        fetch("/@" + target + "/profile", { credentials: "include" })
          .then(function (res) {
            if (!res.ok) {
              self._showMsg("Could not load profile (HTTP " + res.status + ")");
              return;
            }
            return res.json().then(function (env) {
              self._envelope = env;
              var payload    = (env.record && env.record.payload) || {};
              // The card may be opened by domain handle (/@example.com), which
              // never equals the session's registered handle — the DID is the
              // identity that always matches.
              if (user && env.did && user.did === env.did) self._isOwner = true;
              var fetchDoc = function () {
                return fetch("/@" + target + "/did-document", { credentials: "include" })
                  .then(function (r) { return r.ok ? r.json() : null; })
                  .catch(function () { return null; });
              };
              var cached = self._isOwner && user.document;
              var hasHome = function (d) {
                return !!(d && Array.isArray(d.service) && d.service.some(function (s) { return s && s.id === d.id + "#home"; }));
              };
              // The owner's locally cached document can predate the server
              // recording a "#home" entry: take just the service list from the
              // server's copy in that case, keeping everything else as cached.
              var dp = cached
                ? (hasHome(cached) ? Promise.resolve(cached) : fetchDoc().then(function (srv) {
                    if (!hasHome(srv)) return cached;
                    var merged = {};
                    Object.keys(cached).forEach(function (k) { merged[k] = cached[k]; });
                    merged.service = srv.service;
                    return merged;
                  }))
                : fetchDoc();
              var domainsP = fetch("/@" + target + "/domains", { credentials: "include" })
                .then(function (r) { return r.ok ? r.json() : { domains: [] }; })
                .then(function (r) { return r.domains || []; })
                .catch(function () { return []; });
              // Friends widget data — shape differs by who's looking:
              //   owner viewing their own card: their actual friends list.
              //   signed-in visitor: relationship status vs. this handle.
              //   signed-out visitor: neither route can be called
              //   (both require auth), so friendInfo stays { status: 'signed-out' }.
              var friendInfoP;
              if (self._isOwner) {
                friendInfoP = fetch("/@" + target + "/friends", { credentials: "include" })
                  .then(function (r) { return r.ok ? r.json() : { friends: [] }; })
                  .then(function (r) { return { status: "owner", friends: r.friends || [] }; })
                  .catch(function () { return { status: "owner", friends: [] }; });
              } else if (user) {
                friendInfoP = fetch("/@" + target + "/friend-status", { credentials: "include" })
                  .then(function (r) { return r.ok ? r.json() : { status: "none" }; })
                  .then(function (r) { return { status: r.status || "none" }; })
                  .catch(function () { return { status: "none" }; });
              } else {
                friendInfoP = Promise.resolve({ status: "signed-out" });
              }
              Promise.all([dp, domainsP, friendInfoP]).then(function (results) {
                var didDoc     = results[0];
                var domains    = results[1];
                var friendInfo = results[2];
                self._domains = domains;
                self._renderView(target, payload, didDoc, env.did, domains, friendInfo);
              });
            });
          })
          .catch(function (err) {
            self._showMsg("Error: " + err.message);
          });
      },

      _showMsg: function _showMsg(msg) {
        var pane = this.targetMorph;
        if (!pane) return;
        pane.removeAllMorphs();
        var t = new lively.morphic.Text(lively.rect(12, 12, 390, 20), msg);
        t.applyStyle({ allowInput: false, fontSize: 12,
          textColor: Color.rgb(100, 100, 100),
          fill: Color.rgb(255, 255, 255), borderWidth: 0 });
        pane.addMorph(t);
      },

      // ── invite-to-constellation (friend nameplate menu) ─────────────────────
      // Real top-level BuildSpec methods (not addScript handlers), so they're
      // reachable as plain `win._openInviteToConstellationPicker(...)` calls
      // from inside a friend nameplate's addScript-reconstructed three-dot
      // menu handler — same "closure is lost, but a real method call on the
      // object graph isn't" idiom loadProfile/_renderEdit already rely on
      // elsewhere in this file.

      _openInviteToConstellationPicker: function _openInviteToConstellationPicker(targetDid, targetHandle, screenPos) {
        var self = this;
        var user = lively.identity.did.currentUser();
        if (!user) return;
        fetch('/@' + user.handle + '/constellations', { credentials: 'include' })
          .then(function (r) { return r.ok ? r.json() : { constellations: [] }; })
          .then(function (r) {
            // /@:handle/constellations now returns every constellation the
            // caller belongs to at all (My Constellations tab needs plain
            // members too), tagged with `role` — only controllers may
            // invite, so filter back down to creator/moderator rows here to
            // keep this picker's original controller-only behavior.
            var list = (r.constellations || []).filter(function (c) { return c.role !== 'member'; });
            if (!list.length) {
              $world.alert("You don't control any constellations to invite @" + (targetHandle || targetDid) + " to.");
              return;
            }
            var items = list.map(function (c) {
              return [c.name + ' (' + c.memberCount + ' member' + (c.memberCount === 1 ? '' : 's') + ')',
                function () { self._sendConstellationInvite(c.name, targetDid, targetHandle); }];
            });
            lively.morphic.Menu.openAt(screenPos, 'Invite @' + (targetHandle || targetDid) + ' to…', items);
          })
          .catch(function () { $world.alert('Could not load your constellations.'); });
      },

      // Identical postal-rail flow to ConstellationLounge.js's _requestJoin
      // (a real, client-signed postcard, never server-fabricated) with the
      // direction reversed: the controller signs+PUTs the card, then POSTs
      // its objId + the target's DID to /c/:name/invites, which records the
      // invite and delivers the card to the target's own inbox.
      _sendConstellationInvite: function _sendConstellationInvite(constellationName, targetDid, targetHandle) {
        var user = lively.identity.did.currentUser();
        if (!user) return;
        // Defensive re-check: the friend-nameplate menu already omits this
        // item for a blocked target, but the menu can go stale if a block
        // was applied elsewhere while it stayed open.
        if (lively.identity.did.isBlocked(targetDid, targetHandle)) return;
        lively.require("lively.identity.PostCardSerializer").toRun(function () {
          var doc = {
            type: "doc",
            content: [{
              type: "paragraph",
              content: [{ type: "text",
                text: "@" + lively.identity.did.displayHandle() + " invited @" + (targetHandle || targetDid) + " to join c/" + constellationName + "." }],
            }],
          };
          lively.identity.postCardSerializer.serializePlainToEnvelope({
            doc: doc,
            title: "Invitation to join c/" + constellationName,
            titleExplicit: true,
            constellation: constellationName,
            visibility: "public",
            stateMeta: { kind: "constellation-invite" },
          }, function (err, envelope) {
            if (err) return $world.alert("Could not create invite: " + err.message);

            var base = lively.identity.did.baseUrl();
            var putXhr = new XMLHttpRequest();
            putXhr.open("PUT", base + "/@" + encodeURIComponent(user.handle) + "/" + encodeURIComponent(envelope.objId), true);
            putXhr.withCredentials = true;
            putXhr.setRequestHeader("Content-Type", "application/json");
            putXhr.onload = function () {
              if (putXhr.status !== 200) return $world.alert("Could not save invite card (" + putXhr.status + ")");

              var postXhr = new XMLHttpRequest();
              postXhr.open("POST", base + "/c/" + encodeURIComponent(constellationName) + "/invites", true);
              postXhr.withCredentials = true;
              postXhr.setRequestHeader("Content-Type", "application/json");
              postXhr.onload = function () {
                if (postXhr.status !== 201) {
                  var msg = "Invite failed (" + postXhr.status + ")";
                  try { var body = JSON.parse(postXhr.responseText); if (body.error) msg = body.error; } catch (e) {}
                  return $world.alert(msg);
                }
                $world.alert("Invite sent to @" + (targetHandle || targetDid) + ".");
              };
              postXhr.onerror = function () { $world.alert("Network error sending invite"); };
              postXhr.send(JSON.stringify({ objId: envelope.objId, targetDid: targetDid }));
            };
            putXhr.onerror = function () { $world.alert("Network error saving invite card"); };
            putXhr.send(JSON.stringify(envelope));
          });
        });
      },

      // ── read view ────────────────────────────────────────────────────────────

      _renderView: function _renderView(handle, payload, didDoc, did, domains, friendInfo) {
        var self = this;
        var pane = this.targetMorph;
        if (!pane) return;
        pane.removeAllMorphs();

        // The base layout has room for a 4-line bio. If the bio wraps to more,
        // grow the window by the extra height, and shrink back on the next
        // render. Done before anything is laid out so pane.getExtent() below
        // is already final. The line count is measured, not estimated from
        // the character count: long unbroken words wrap early, and a
        // chars-per-line guess undershot by a line (the divider then ran
        // through the last line of a 300-char bio). Text width is the pane
        // width minus the fixed left/right layout columns used for `cw` below
        // (32 + 32 margins, 190 astro box, 12 gap) minus the text node's own
        // 4px left/right padding. 20px/line is the measured rendered height
        // of 12pt Helvetica; +8 padding matches the bio box below.
        // Undo any height the Connect card added on the previous render; it
        // re-adds what it needs (if anything) once its own size is known.
        var prevConnect = self._connectExtra || 0;
        if (prevConnect) {
          var ce = self.getExtent();
          self.setExtent(lively.pt(ce.x, ce.y - prevConnect));
          self._connectExtra = 0;
        }
        var BIO_LINE_H = 20, BIO_PAD = 8, BIO_BASE_H = 4 * BIO_LINE_H + BIO_PAD;
        var bioTextW = pane.getExtent().x - 266 - 8;
        var bioBoxH = payload.bio
          ? Math.max(32, lively.identity.ProfileCard.ui.wrapLineCount(payload.bio, bioTextW, 16, 'Helvetica') * BIO_LINE_H + BIO_PAD)
          : 0;
        var bioExtra = Math.max(0, bioBoxH - BIO_BASE_H);
        var prevExtra = self._bioExtra || 0;
        if (bioExtra !== prevExtra) {
          var curExt = self.getExtent();
          self.setExtent(lively.pt(curExt.x, curExt.y + bioExtra - prevExtra));
          self._bioExtra = bioExtra;
        }

        // Preset platform catalog for the social-account circles below.
        // Declared locally (not shared from outer module scope) because
        // lively.BuildSpec methods are rehydrated via evalJS from their
        // source text, which discards any closure over the enclosing
        // .toRun(function(){...}) scope — same reason SIGNS/GLYPHS are
        // redeclared locally rather than shared, see _renderEdit below.
        // Each key doubles as the icon's filename under
        // core/media/social-icons/<key>.svg.
        var SOCIAL_PLATFORMS = [
          { key: 'discord',     label: 'Discord' },
          { key: 'spotify',     label: 'Spotify' },
          { key: 'instagram',   label: 'Instagram' },
          { key: 'github',      label: 'GitHub' },
          { key: 'youtube',     label: 'YouTube' },
          { key: 'tiktok',      label: 'TikTok' },
          { key: 'twitch',      label: 'Twitch' },
          { key: 'bluesky',     label: 'Bluesky' },
          { key: 'blacksky',    label: 'Blacksky' },
          { key: 'behance',     label: 'Behance' },
          { key: 'steam',       label: 'Steam' },
          { key: 'cashapp',     label: 'Cash App' },
          { key: 'pinterest',   label: 'Pinterest' },
          { key: 'arena',       label: 'Are.na' },
          { key: 'goodreads',   label: 'Goodreads' },
          { key: 'applemusic',  label: 'Apple Music' },
          { key: 'ytmusic',     label: 'YT Music' },
          { key: 'storygraph',  label: 'StoryGraph' },
          { key: 'itch',        label: 'itch.io' },
          { key: 'psn',         label: 'PlayStation Network' },
          { key: 'mynintendo',  label: 'My Nintendo' },
          { key: 'xbox',        label: 'Xbox' },
          { key: 'epic',        label: 'Epic Games' },
          { key: 'tumblr',      label: 'Tumblr' },
          { key: 'threads',     label: 'Threads' },
        ];
        function socialPlatformInfo(key) {
          for (var i = 0; i < SOCIAL_PLATFORMS.length; i++) {
            if (SOCIAL_PLATFORMS[i].key === key) return SOCIAL_PLATFORMS[i];
          }
          return null;
        }
        function socialIconUrl(platformKey) {
          // Absolute path (leading slash) — this card is normally viewed at
          // a nested URL like /@handle/objId, where a relative path would
          // resolve against that path instead of site root and 404.
          return '/core/media/social-icons/' + platformKey + '.svg';
        }

        // Store context on the pane so button onFire handlers can reach it
        // without relying on closures (evalJS loses them).
        // _win is excluded from serialization to prevent a circular-reference
        // crash when the world is saved with ProfileCard open.
        pane._win = self;
        if (pane.doNotSerialize && pane.doNotSerialize.indexOf('_win') === -1)
          pane.doNotSerialize.push('_win');
        self._currentDid = did;

        var pw   = pane.getExtent().x;
        var BH   = 160;
        var AV   = 72;
        var RING = 4;

        // Material Symbols glyph as a plain Text morph (see CLAUDE.md's icon
        // section). Declared locally, not at module scope, for the same
        // evalJS closure-loss reason as SOCIAL_PLATFORMS above. `px` is the
        // real rendered glyph size; fontSize is points (px * 0.75). The box
        // is px + 8 so the shapeNode's fixed internal padding doesn't clip
        // it, and it's shifted back by 4 so the glyph's top-left lands at
        // (x, y). Purely decorative, so it ignores Lively events.
        function ico(name, x, y, px, r, g, b) {
          var box = px + 8;
          // +2 (net of the -4 padding shift): the icon font's glyph center
          // sits ~6px above a regular-font text line's center at the same
          // box y, measured live via getBoundingClientRect on the spans.
          var m = new lively.morphic.Text(lively.rect(x - 4, y + 2, box, box), name);
          m.draggingEnabled = false; m.droppingEnabled = false; m.grabbingEnabled = false;
          m.applyStyle({ allowInput: false, selectable: false, clipMode: 'hidden',
            fontFamily: "'Material Symbols Rounded'", fontSize: px * 0.75, align: 'center',
            whiteSpaceHandling: 'pre', padding: lively.Rectangle.inset(0, 0, 0, 0),
            textColor: Color.rgb(r, g, b),
            fill: Color.rgba(0, 0, 0, 0), borderWidth: 0 });
          m.eventsAreIgnored = true;
          return m;
        }

        // Button label color: applyStyle({textColor}) on a Button updates the
        // model but not the label's DOM (see CLAUDE.md), so write it directly.
        function tint(btn, r, g, b) {
          var c = 'rgb(' + r + ',' + g + ',' + b + ')';
          var n = btn.label && btn.label.renderContext().shapeNode;
          if (!n) return;
          n.style.color = c;
          var kids = n.querySelectorAll('*');
          for (var i = 0; i < kids.length; i++) kids[i].style.color = c;
        }

        // banner — always rendered; image if set, placeholder otherwise
        var hasBanner = true;
        if (payload.bannerUrl) {
          var banner = new lively.morphic.Image(lively.rect(0, 0, pw, BH));
          banner.setImageURL(payload.bannerUrl);
          banner.applyStyle({ borderWidth: 0 });
          pane.addMorph(banner);
        } else {
          var bannerBg = new lively.morphic.Box(lively.rect(0, 0, pw, BH));
          lively.identity.quiltPatterns.applyQuiltBackground(bannerBg, handle);
          pane.addMorph(bannerBg);
        }

        // avatar always straddles banner bottom-left
        var avX = 32;
        var avY = BH - Math.floor(AV / 2);

        // white ring behind avatar
        var RS = AV + RING * 2;
        var avRing = new lively.morphic.Box(lively.rect(avX - RING, avY - RING, RS, RS));
        avRing.applyStyle({ fill: Color.white, borderRadius: RS / 2, borderWidth: 0 });
        pane.addMorph(avRing);

        // avatar image or blockie identicon
        if (payload.avatarUrl) {
          var img = new lively.morphic.Image(lively.rect(avX, avY, AV, AV));
          img.setImageURL(payload.avatarUrl);
          img.applyStyle({ borderRadius: AV / 2, borderWidth: 0, clipMode: 'hidden' });
          pane.addMorph(img);
        } else {
          var bi = new lively.morphic.Image(lively.rect(avX, avY, AV, AV));
          bi.setImageURL(lively.identity.postCardUtils.identiconDataUrl(handle, AV));
          bi.applyStyle({ borderRadius: AV / 2, borderWidth: 0, clipMode: 'hidden' });
          pane.addMorph(bi);
        }

        var y = avY + AV + 12;

        var contentX = avX; // left margin for all text content

        // astrological signs box — top-right, below banner
        var BW     = 190; // astro box width — also used to constrain content cw
        var SIGNS  = ['Aries','Taurus','Gemini','Cancer','Leo','Virgo',
                      'Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'];
        var GLYPHS = ['♈︎','♉︎','♊︎','♋︎','♌︎','♍︎','♎︎','♏︎','♐︎','♑︎','♒︎','♓︎'];
        var astroItems = [
          { sym: 'wb_sunny',   label: 'Sun',    val: payload.sunSign    || null },
          { sym: 'dark_mode',  label: 'Moon',   val: payload.moonSign   || null },
          { sym: 'north',      label: 'Rising', val: payload.risingSign || null },
        ];
        var hasAstro = astroItems.some(function (a) { return !!a.val; });
        var bx        = pw - BW - contentX;
        var by        = hasBanner ? (BH + 12) : 12;
        var ROW       = 22;
        var astroBoxH = ROW * 3 + 20;
        if (hasAstro || self._isOwner) {
          var astroBox = new lively.morphic.Box(
            lively.rect(bx, by, BW, astroBoxH));
          astroBox.applyStyle({ fill: Color.rgb(247, 246, 249),
            borderRadius: 12, borderColor: Color.rgb(232, 230, 236), borderWidth: 1 });
          pane.addMorph(astroBox);
          astroItems.forEach(function (item, i) {
            var ry = 7 + i * ROW;
            var si = SIGNS.indexOf(item.val);
            astroBox.addMorph(ico(item.sym, 12, ry, 16, 204, 0, 87));
            var lblM = new lively.morphic.Text(lively.rect(32, ry + 4, 44, 14), item.label);
            lblM.applyStyle({ allowInput: false, fontSize: 9,
              textColor: Color.rgb(160, 160, 160),
              fill: Color.rgba(0,0,0,0), borderWidth: 0 });
            astroBox.addMorph(lblM);
            var signStr = item.val && si >= 0 ? (GLYPHS[si] + ' ' + item.val) : '—';
            var valM = new lively.morphic.Text(lively.rect(80, ry + 2, BW - 88, ROW - 2), signStr);
            valM.applyStyle({ allowInput: false, fontSize: 11,
              fontWeight: item.val ? 'bold' : 'normal',
              textColor: si >= 0 ? Color.rgb.apply(null, lively.identity.ProfileCard.signRgb(si))
                                 : (item.val ? Color.rgb(35, 35, 35) : Color.rgb(180, 180, 180)),
              fill: Color.rgba(0,0,0,0), borderWidth: 0 });
            astroBox.addMorph(valM);
          });
        }

        // Orbit widget — under the astro box, same x/width. Two separate
        // categories live in payload.orbit = { status, spotlights }:
        //   status     — ONE relationship status, { label, emoji } ("Booked 💋",
        //                "Dating 💘", "Open ♾️"), drawn as a pill at the top.
        //   spotlights — up to 3 people from the network, { label, handle }
        //                ("Opp @gameboy", "Twin @…"), listed below the
        //                pill; the handle links to that profile.
        // Visitors only see the card when either is set. orbitBottom feeds the
        // divider reservation further down.
        var orbitBottom = by + astroBoxH;
        (function () {
          var SPOT_MAX = 3, OROW = 22, PILL_H = 24;
          var orbitData = payload.orbit || {};
          var status = orbitData.status && typeof orbitData.status.label === 'string' && orbitData.status.label
            ? orbitData.status : null;
          var spots = (orbitData.spotlights || []).filter(function (o) {
            return o && typeof o.label === 'string' && o.label && typeof o.handle === 'string' && o.handle;
          }).slice(0, SPOT_MAX);
          if (!status && !spots.length) return;

          var oy = by + astroBoxH + 8;
          var CAP_H = 18, SEC_GAP = 10;
          var both = !!status && spots.length > 0;
          var oh = 8
            + (status ? CAP_H + PILL_H + 4 : 0)
            + (both ? SEC_GAP : 0)
            + (spots.length ? CAP_H + spots.length * OROW : 0)
            + 6;
          var orbitCard = new lively.morphic.Box(lively.rect(bx, oy, BW, oh));
          orbitCard.applyStyle({ fill: Color.rgb(249, 246, 253),
            borderRadius: 12, borderColor: Color.rgb(232, 224, 244), borderWidth: 1 });
          orbitCard.draggingEnabled = false; orbitCard.droppingEnabled = false;
          orbitCard.grabbingEnabled = false;
          orbitCard.eventsAreIgnored = true;
          pane.addMorph(orbitCard);

          function caption(str, capX, capY) {
            var c = new lively.morphic.Text(lively.rect(capX, capY, 150, 14), str);
            c.applyStyle({ allowInput: false, fontSize: 9, textColor: Color.rgb(160, 160, 160),
              fill: Color.rgba(0, 0, 0, 0), borderWidth: 0 });
            c.eventsAreIgnored = true;
            pane.addMorph(c);
          }

          var cy = oy + 8;

          // Category 1 — relationship status: "Relationship" caption, then
          // a white pill with the chosen status.
          if (status) {
            caption('Relationship', bx + 8, cy + 1);
            cy += CAP_H;
            // Snug pill, centered in the card: width comes from the measured
            // text (canvas, same approach as wrapLineCount — a live-DOM span
            // read isn't reliable in the tick the morph is added) plus PILL_PAD
            // each side. The label box adds the shapeNode's own 4px/side
            // padding back, plus 2px slack so the last glyph never clips.
            var statusStr = status.emoji ? status.label + ' ' + status.emoji : status.label;
            var mctx = document.createElement('canvas').getContext('2d');
            mctx.font = 'bold ' + (11 * 4 / 3) + 'px Helvetica';
            var textW = Math.ceil(mctx.measureText(statusStr).width);
            var PILL_PAD = 14;
            var pillW = Math.min(BW - 20, textW + PILL_PAD * 2);
            var pillX = bx + Math.round((BW - pillW) / 2);
            var pill = new lively.morphic.Box(lively.rect(pillX, cy, pillW, PILL_H));
            pill.applyStyle({ fill: Color.white, borderRadius: PILL_H / 2,
              borderColor: Color.rgb(232, 224, 244), borderWidth: 1 });
            pill.draggingEnabled = false; pill.droppingEnabled = false; pill.grabbingEnabled = false;
            pill.eventsAreIgnored = true;
            pane.addMorph(pill);
            // Label first, emoji after — one Text morph so both share a baseline.
            var slbl = new lively.morphic.Text(
              lively.rect(pillX + PILL_PAD - 4, cy + 1, pillW - PILL_PAD * 2 + 10, PILL_H - 2),
              statusStr);
            slbl.applyStyle({ allowInput: false, fontSize: 11, fontWeight: 'bold',
              textColor: Color.rgb(35, 35, 35), fill: Color.rgba(0, 0, 0, 0), borderWidth: 0 });
            slbl.eventsAreIgnored = true;
            pane.addMorph(slbl);
            cy += PILL_H + 4;
          }

          if (both) {
            var sep = new lively.morphic.Box(lively.rect(bx + 12, cy + SEC_GAP / 2, BW - 24, 1));
            sep.applyStyle({ fill: Color.rgb(232, 224, 244), borderWidth: 0 });
            sep.eventsAreIgnored = true;
            pane.addMorph(sep);
            cy += SEC_GAP;
          }

          // Category 2 — spotlights: "Orbit" caption, then "Label @handle" rows.
          if (spots.length) {
            pane.addMorph(ico('orbit', bx + 12, cy, 12, 204, 0, 87));
            caption('Orbit', bx + 30, cy + 1);
            cy += CAP_H;
          }
          // Handle column starts after the longest label (labels are free text,
          // up to 10 chars), measured on a canvas.
          var lctx = document.createElement('canvas').getContext('2d');
          lctx.font = (11 * 4 / 3) + 'px Helvetica';
          var labW = 0;
          spots.forEach(function (o) { labW = Math.max(labW, Math.ceil(lctx.measureText(o.label).width)); });
          labW = Math.min(labW, 80);
          spots.forEach(function (o, i) {
            var ry = cy + i * OROW;
            var tag = o.handle.replace(/^@/, '');
            var lx = bx + 12;
            var lbl = new lively.morphic.Text(lively.rect(lx - 4, ry, labW + 10, OROW - 2), o.label);
            lbl.applyStyle({ allowInput: false, fontSize: 11, fontWeight: 'normal',
              textColor: Color.rgb(120, 120, 128),
              fill: Color.rgba(0, 0, 0, 0), borderWidth: 0 });
            lbl.eventsAreIgnored = true;
            pane.addMorph(lbl);
            var hx = lx + labW + 8;
            var hm = new lively.morphic.Text(
              lively.rect(hx - 4, ry, bx + BW - hx - 4, OROW - 2), '@' + tag);
            hm.applyStyle({ allowInput: false, fontSize: 11, fontWeight: 'bold',
              textColor: Color.rgb(204, 0, 87), fill: Color.rgba(0, 0, 0, 0),
              borderWidth: 0, handStyle: 'pointer' });
            hm.draggingEnabled = false; hm.droppingEnabled = false; hm.grabbingEnabled = false;
            hm._handle = tag;
            hm.addScript(function onMouseUp(evt) {
              lively.identity.ProfileCard.open(this._handle);
              evt.stop();
              return true;
            });
            pane.addMorph(hm);
          });
          orbitBottom = oy + oh;
        })();

        function txt(str, x, top, w, h, size, r, g, b, bold) {
          var t = new lively.morphic.Text(lively.rect(x, top, w, h), str || "");
          t.applyStyle({ allowInput: false, fontSize: size || 12,
            textColor: Color.rgb(r || 30, g || 30, b || 30),
            fontWeight: bold ? "bold" : "normal",
            fill: Color.rgb(255, 255, 255), borderWidth: 0 });
          return t;
        }

        var cw = bx - contentX - 12; // stop before astro box (12px gap)

        // handle + display name
        // A verified domain handle is the account's main handle, so show it
        // instead of the registered handle (the handle we were opened with
        // can be either); keep it in the window title too. Only a verified
        // domain counts — a lapsed one falls back to the registered handle.
        var verifiedDomain = (domains || []).filter(function (d) { return d.status === 'verified'; })[0];
        var shownHandle = verifiedDomain ? verifiedDomain.domain : handle;
        self.setTitle("Profile — @" + shownHandle);
        pane.addMorph(txt("@" + shownHandle, contentX, y, cw, 16, 11, 120, 120, 120, false));
        y += 19;
        pane.addMorph(txt(payload.displayName || handle, contentX, y, cw, 28, 16, 20, 20, 20, true));
        y += 28;
        if (payload.pronouns) {
          pane.addMorph(txt(payload.pronouns, contentX, y, cw, 14, 10, 120, 120, 120, false));
          y += 17;
        }

        // bio
        var bioText = payload.bio ||
          (self._isOwner ? "No bio yet. Click Edit to add one." : "");
        if (bioText) {
          // Height comes from the measured wrapped line count (see the growth
          // block at the top of _renderView), not a fixed or guessed value.
          // The "No bio yet" placeholder isn't in payload.bio, so measure it here.
          var bioH = payload.bio
            ? bioBoxH
            : Math.max(32, lively.identity.ProfileCard.ui.wrapLineCount(bioText, cw - 8, 16, 'Helvetica') * BIO_LINE_H + BIO_PAD);
          var bio = new lively.morphic.Text(lively.rect(contentX, y, cw, bioH), bioText);
          bio.applyStyle({ allowInput: false, fontSize: 12,
            textColor: Color.rgb(80, 80, 80),
            fill: Color.rgb(255, 255, 255), borderWidth: 0 });
          pane.addMorph(bio);
          y += bioH + 8;
        }

        // Reserve room below the astro-signs box (drawn above at a fixed
        // [by, by+astroBoxH] independent of this y accumulator) so the
        // divider/Connect row below never collide with it when the left
        // column has little content (short/no bio, no pronouns, no links) —
        // confirmed live on a bare profile (@candle): with nothing above
        // pushing y down, dividerY landed just 1px below astroBoxH's bottom
        // edge. (The Friends button now sits beside the box, not under it.)
        // (orbitBottom already includes the orbit card when one is drawn.)
        if (hasAstro || self._isOwner || orbitBottom > by + astroBoxH) {
          y = Math.max(y, orbitBottom + 12);
        }

        // divider
        y += 8;
        var div = new lively.morphic.Box(lively.rect(contentX, y, pw - contentX * 2, 1));
        div.applyStyle({ fill: Color.rgb(220, 220, 220), borderWidth: 0 });
        pane.addMorph(div);
        var dividerY = y;
        y += 12;

        // social account circles — right column, directly under the
        // divider, in the space below the astro-signs box/Friends button
        // (same x = bx as that column, so it reads as one aligned strip).
        // Owner always sees all 5 slots (filled + empty "add" placeholders,
        // clicking an empty one jumps straight to the Accounts tab);
        // visitors only see the filled ones, packed with no gaps for the
        // slots the owner hasn't used.
        (function () {
          // Connect card — socials and websites in one soft card, styled like
          // the astro-signs card above it (rounded, faint border, pink icons,
          // small gray captions) with a faint pink tint as its accent. Its
          // right edge lines up with the divider and astro card
          // (pw - contentX); content is inset by PAD, so the icon row's
          // GAP is tighter than it used to be to keep the card width sane.
          // Filled social accounts render as the bare logo (no enclosing
          // circle); CIRC is the slot each one (and each empty "add"
          // placeholder circle) occupies, ICON the logo's own size within it.
          var CIRC = 38, GAP = 16, ICON = 28, PAD = 16;
          var rowEndX = pw - contentX - PAD;
          var rowStartX = rowEndX - (5 * CIRC + 4 * GAP);
          var accounts = (payload.socialAccounts || []).slice(0, 5);
          // Websites (up to 3). Only http(s) URLs are rendered/opened.
          var sites = (payload.links || []).filter(function (l) {
            return l && l.url && /^https?:\/\//i.test(l.url);
          }).slice(0, 3);
          // The owner always gets the social row (empty "add" circles
          // included); a visitor only sees sections that have something in
          // them, and no card at all when both are empty.
          var hasSocial = self._isOwner || accounts.length > 0;
          var hasSites  = sites.length > 0;
          if (!hasSocial && !hasSites) return;

          // Layout pass: every y is decided before the card is drawn so the
          // card can be sized to its content (a guessed height would clip or
          // leave dead space).
          var cardTop = dividerY + 10;
          var ly = cardTop + 12;
          var connectY, ry, divY, sitesLblY, wy;
          if (hasSocial) { connectY = ly; ly += 18; ry = ly; ly += CIRC + 14; }
          if (hasSocial && hasSites) { divY = ly - 4; ly += 10; }
          if (hasSites) { sitesLblY = ly; ly += 20; wy = ly; ly += sites.length * 22; }
          var cardX = rowStartX - PAD;
          var cardW = (pw - contentX) - cardX;
          var cardH = ly + 2 - cardTop;

          var connectCard = new lively.morphic.Box(lively.rect(cardX, cardTop, cardW, cardH));
          connectCard.applyStyle({ fill: Color.rgb(252, 246, 249),
            borderRadius: 12, borderColor: Color.rgb(241, 225, 233), borderWidth: 1 });
          connectCard.draggingEnabled = false; connectCard.droppingEnabled = false;
          connectCard.grabbingEnabled = false;
          connectCard.eventsAreIgnored = true;
          pane.addMorph(connectCard);

          // Small pink icon + gray caption, the same pairing the astro card uses.
          function caption(icon, label, capY) {
            pane.addMorph(ico(icon, rowStartX, capY, 12, 204, 0, 87));
            var l = new lively.morphic.Text(lively.rect(rowStartX + 18, capY + 1, 140, 14), label);
            l.applyStyle({ allowInput: false, fontSize: 9, textColor: Color.rgb(160, 160, 160),
              fill: Color.rgba(0, 0, 0, 0), borderWidth: 0 });
            l.eventsAreIgnored = true;
            pane.addMorph(l);
          }

          if (hasSocial) caption('share', 'Connect', connectY);
          if (hasSocial && hasSites) {
            var cardDiv = new lively.morphic.Box(lively.rect(rowStartX, divY, rowEndX - rowStartX, 1));
            cardDiv.applyStyle({ fill: Color.rgb(240, 226, 233), borderWidth: 0 });
            cardDiv.eventsAreIgnored = true;
            pane.addMorph(cardDiv);
          }

          // A transparent slot Box holds the click/tooltip, with the logo as
          // a child Image: setImageURL's useNativeExtent callback repositions
          // whatever morph it's called on to re-center it, so that morph can't
          // also be the one carrying the slot's own fixed position.
          function addFilledCircle(cx, acc) {
            var slot = new lively.morphic.Box(lively.rect(cx, ry, CIRC, CIRC));
            slot.applyStyle({ fill: Color.rgba(0, 0, 0, 0), borderWidth: 0, handStyle: 'pointer' });
            slot.draggingEnabled = false; slot.droppingEnabled = false; slot.grabbingEnabled = false;
            var icon = new lively.morphic.Image(
              lively.rect(Math.round((CIRC - ICON) / 2), Math.round((CIRC - ICON) / 2), ICON, ICON));
            icon.applyStyle({ borderWidth: 0 });
            icon.draggingEnabled = false; icon.droppingEnabled = false; icon.grabbingEnabled = false;
            icon.eventsAreIgnored = true;
            slot.addMorph(icon);
            // useNativeExtent + max{Width,Height} scales the logo down to fit
            // ICON x ICON while preserving aspect ratio (plain setImageURL
            // stretches to exactly fill it, distorting any non-square logo) —
            // then re-center it, since the resulting extent may be narrower or
            // shorter than ICON.
            icon.setImageURL(socialIconUrl(acc.platform),
              { useNativeExtent: true, maxWidth: ICON, maxHeight: ICON },
              function (err, loadedIcon) {
                if (err) return;
                var ext = loadedIcon.getExtent();
                loadedIcon.setPosition(lively.pt(
                  Math.round((CIRC - ext.x) / 2),
                  Math.round((CIRC - ext.y) / 2)));
                // Rendering.js's htmlImg() leaves the <img> node's left/top
                // unset; pin them so the morph's own (correct) position is
                // what shows.
                var imgNode = loadedIcon.renderContext && loadedIcon.renderContext().imgNode;
                if (imgNode) { imgNode.style.left = '0px'; imgNode.style.top = '0px'; }
              });
            slot._openUrl = acc.url;
            slot.addScript(function onMouseUp(evt) {
              if (this._openUrl) window.open(this._openUrl, '_blank', 'noopener');
              evt.stop(); return true;
            });
            pane.addMorph(slot);
            var info = socialPlatformInfo(acc.platform);
            slot.renderContext().morphNode.title = info ? info.label : acc.platform;
          }

          function addEmptyCircle(cx) {
            var btn = new lively.morphic.Button(lively.rect(cx, ry, CIRC, CIRC), '');
            btn.applyStyle({
              fill: new lively.morphic.LinearGradient([
                { offset: 0, color: Color.rgb(230, 230, 238) },
                { offset: 1, color: Color.rgb(248, 248, 251) },
              ], 'northwest'),
              borderRadius: CIRC / 2,
              borderColor: Color.rgb(222, 222, 228), borderWidth: 1,
            });
            btn.setAppearanceStylingMode(false);
            btn.setBorderStylingMode(false);
            btn.addScript(function doAction() {
              var pane = this.owner;
              var win  = pane && pane.owner;
              if (!win) return;
              var env = win._envelope;
              var p   = (env && env.record && env.record.payload) || {};
              win._renderEdit(win._handle, p, win._currentDid, 'accounts');
            });
            lively.bindings.connect(btn, 'fire', btn, 'doAction');
            pane.addMorph(btn);
            btn.renderContext().morphNode.title = 'Add a social account';
          }

          if (self._isOwner) {
            for (var i = 0; i < 5; i++) {
              var cx = rowStartX + i * (CIRC + GAP);
              if (accounts[i]) addFilledCircle(cx, accounts[i]);
              else addEmptyCircle(cx);
            }
          } else {
            accounts.forEach(function (acc, i) {
              addFilledCircle(rowStartX + i * (CIRC + GAP), acc);
            });
          }

          if (hasSites) caption('language', 'Websites', sitesLblY);
          sites.forEach(function (site) {
            var shown = (site.label || site.url).replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
            if (shown.length > 30) shown = shown.slice(0, 29) + '…';
            var siteM = txt(shown, rowStartX + 2, wy, rowEndX - rowStartX - 2, 16, 11, 204, 0, 87, false);
            siteM.applyStyle({ fill: Color.rgba(0, 0, 0, 0), handStyle: 'pointer',
              selectable: false });
            siteM.draggingEnabled = false; siteM.droppingEnabled = false; siteM.grabbingEnabled = false;
            siteM._openUrl = site.url;
            siteM.addScript(function onMouseUp(evt) {
              if (this._openUrl) window.open(this._openUrl, '_blank', 'noopener');
              evt.stop(); return true;
            });
            pane.addMorph(siteM);
            siteM.renderContext().morphNode.title = site.url;
            wy += 22;
          });

          // Grow the window if the card (plus the Edit button pinned to the
          // pane's bottom-right, owner only) doesn't fit in what's left below
          // it. Runs before the Edit button is placed, which reads the
          // pane's final height.
          // 44 whenever a bottom-right button (Edit and/or Enter) will sit at
          // ph - 36 below the card; a visitor on that homestar needs less.
          var needPaneH = cardTop + cardH + ((self._isOwner || self._showEnter) ? 44 : 14);
          var havePaneH = pane.getExtent().y;
          if (needPaneH > havePaneH) {
            var we = self.getExtent();
            self.setExtent(lively.pt(we.x, we.y + (needPaneH - havePaneH)));
            self._connectExtra = needPaneH - havePaneH;
          }
        })();

        // encryption status — whether this account can receive private/shared
        // postcards. Surfaced here (rather than only failing at Send time,
        // see PostCardEditor.js's Send dialog) so it's visible up front,
        // including to the owner themselves if their own device never
        // completed the WebAuthn PRF delegation ceremony that publishes this.
        var encLabel = payload.accountX25519Pub
          ? "Can receive encrypted postcards"
          : "Hasn't set up encryption yet";
        var encColor = payload.accountX25519Pub ? [46, 125, 50] : [170, 130, 20];
        var encW = Math.min(cw - 20, Math.ceil(encLabel.length * 7.5) + 16);
        pane.addMorph(ico(payload.accountX25519Pub ? 'lock' : 'lock_open',
          contentX, y, 14, encColor[0], encColor[1], encColor[2]));
        pane.addMorph(txt(encLabel, contentX + 20, y, encW, 14, 10,
          encColor[0], encColor[1], encColor[2], false));
        y += 17;

        // Section heading: small gray icon + caption, used for the
        // identity/domain/wallet/device/meta rows below. Local for the same
        // closure-loss reason as ico() above.
        function heading(icon, label) {
          pane.addMorph(ico(icon, contentX, y + 1, 12, 150, 150, 158));
          pane.addMorph(txt(label, contentX + 18, y, cw - 18, 16, 10, 140, 140, 148, false))
            .applyStyle({ fixedWidth: false });
          y += 18;
        }

        // Enable-encryption button — owner only, only while missing. Prior
        // to this there was no way to complete this after skipping
        // RegisterDialog.js's "Enable encryption?" prompt (or having its PRF
        // ceremony fail) — the account would be permanently unable to
        // receive private/shared postcards or files, only ever discovering
        // that as a "hasn't set up encryption yet" failure when someone else
        // tried to send them one.
        if (self._isOwner && !payload.accountX25519Pub) {
          var encBtn = new lively.morphic.Button(lively.rect(contentX, y, 140, 24), 'Enable encryption');
          encBtn.applyStyle({ borderRadius: 6, borderWidth: 1,
            borderColor: Color.rgb(200, 200, 210),
            fill: Color.rgb(249, 249, 251), fontSize: 11 });
          encBtn.setAppearanceStylingMode(false);
          encBtn.setBorderStylingMode(false);
          encBtn.addScript(function doAction() {
            var win = this.owner && this.owner.owner;
            var btn = this;
            btn.setLabel('Confirm passkey…');
            btn.setActive(false);
            lively.identity.userSpace.enableEncryption(function (err) {
              if (err) {
                alert('Could not enable encryption: ' + err.message);
                btn.setLabel('Enable encryption');
                btn.setActive(true);
                return;
              }
              if (win && typeof win.loadProfile === 'function') win.loadProfile(win._handle);
            });
          });
          lively.bindings.connect(encBtn, 'fire', encBtn, 'doAction');
          pane.addMorph(encBtn);
          y += 30;
        }

        // Friends button — shown to all; behaviour/content is driven by
        // friendInfo (fetched in loadProfile: FriendRegistry-backed
        // /@:handle/friends for the owner's own card, /@:handle/friend-status
        // for a signed-in visitor). Every nested button below stores what it
        // needs directly on itself (_handle/_targetDid/etc.) rather than
        // closing over this IIFE's locals — addScript handlers are
        // reconstructed from their own source text at runtime and lose that
        // closure (see this file's own header comment / CLAUDE.md's
        // BuildSpec-closure-loss gotcha).
        (function () {
          var info = friendInfo || { status: self._isOwner ? 'owner' : 'signed-out' };
          // Label reflects the viewer's relationship to this handle: only
          // 'Friends' when they actually are (or it's the owner's own card,
          // where it opens their friends list); otherwise it's the action.
          var FRIEND_LABELS = { owner: 'Friends', friends: 'Friends',
            none: 'Send friend request', 'signed-out': 'Send friend request',
            'pending-outgoing': 'Request sent', 'pending-incoming': 'Respond to request' };
          var friendLabel = FRIEND_LABELS[info.status] || 'Send friend request';
          var btnW = friendLabel.length > 18 ? 150 : friendLabel.length > 9 ? 136 : 108, btnH = 26;
          // Sits left of the astro box, vertically centered on it, with the
          // send-postcard circle (when shown) as part of the same right-aligned
          // group ending 12px before the box.
          var viewer = lively.identity.did.currentUser();
          var showPc = !self._isOwner && !!viewer;
          var groupW = btnW + (showPc ? 8 + btnH : 0);
          var btnX = bx - 12 - groupW;
          var btnY = by + Math.round((astroBoxH - btnH) / 2);
          var friendsBtn = new lively.morphic.Button(lively.rect(btnX, btnY, btnW, btnH), friendLabel);
          friendsBtn.applyStyle({ borderRadius: 26, borderWidth: 1,
            borderColor: Color.rgb(204, 0, 87),
            fill: Color.rgb(204, 0, 87), textColor: Color.white, fontSize: 12, fontWeight: 'bold' });
          friendsBtn.setAppearanceStylingMode(false);
          friendsBtn.setBorderStylingMode(false);
          friendsBtn._handle     = handle;
          friendsBtn._targetDid  = did;
          friendsBtn._status     = info.status;
          friendsBtn._friends    = info.friends || [];
          friendsBtn.addScript(function doAction() {
            var pane = this.owner;
            var win  = pane && pane.owner;
            var status = this._status;
            // No relationship yet: the button IS the action, no panel.
            if (status === 'none') {
              fetch('/@' + this._handle + '/friend-requests',
                { method: 'POST', credentials: 'include' })
                .then(function (r) {
                  if (!r.ok) alert('Could not send friend request (HTTP ' + r.status + ')');
                  if (win) win.loadProfile(win._handle);
                });
              return;
            }
            // Owner's list renders one nameplate row (avatar + handle + chat
            // icon + three-dot menu) per friend rather than a plain text
            // line, so it gets its own wider panel and taller row height —
            // ROWH matches the nameplate build below exactly (32px avatar +
            // 6px top/bottom breathing room).
            var FW   = status === 'owner' ? 320 : 280;
            var ROWH = 44;
            var rows = status === 'owner' ? Math.min(this._friends.length, 5) : 0;
            // Each status renders a fixed, known set of rows below the
            // title (msg line(s) + 0-2 stacked action buttons) — heights
            // below match that layout exactly rather than guessing, same
            // "measure/derive, don't assume" discipline as elsewhere in
            // this file's own layout code.
            var FH = { owner: this._friends.length
                ? (34 + rows * ROWH + (this._friends.length > 5 ? 20 : 0) + 10)
                : 80,
              friends: 120, 'pending-outgoing': 120, 'pending-incoming': 160,
              'signed-out': 96 }[status];
            if (FH == null) FH = 120; // 'none' — msg + one action button
            var anchorPos = this.getPosition();
            var px = pane ? Math.min(anchorPos.x, Math.max(0, pane.getExtent().x - FW - 8)) : anchorPos.x;
            var panel  = new lively.morphic.Box(
              lively.rect(px, anchorPos.y + this.getExtent().y + 4, FW, FH));
            panel.applyStyle({ fill: Color.white, borderRadius: 8,
              borderColor: Color.rgb(204, 0, 87), borderWidth: 1 });
            var titleM = new lively.morphic.Text(lively.rect(12, 10, FW - 44, 18), 'Friends');
            titleM.applyStyle({ allowInput: false, fontSize: 13, fontWeight: 'bold',
              fill: Color.rgba(0,0,0,0), borderWidth: 0,
              textColor: Color.rgb(30, 30, 30) });
            panel.addMorph(titleM);

            function msg(text, top, height) {
              var m = new lively.morphic.Text(lively.rect(12, top, FW - 24, height || 40), text);
              m.applyStyle({ allowInput: false, fontSize: 12,
                textColor: Color.rgb(60, 60, 60),
                fill: Color.rgba(0,0,0,0), borderWidth: 0 });
              panel.addMorph(m);
              return m;
            }

            function actionBtn(label, top) {
              var b = new lively.morphic.Button(lively.rect(12, top, FW - 24, 28));
              b.setLabel(label);
              b.applyStyle({ borderRadius: 6, fontSize: 12, borderWidth: 1,
                borderColor: Color.rgb(200, 200, 210),
                fill: Color.rgb(249, 249, 251) });
              b.setAppearanceStylingMode(false);
              b.setBorderStylingMode(false);
              panel.addMorph(b);
              return b;
            }

            if (status === 'owner') {
              if (!this._friends.length) {
                msg('No friends yet.', 36, 20).applyStyle({ textColor: Color.rgb(150, 150, 150) });
              } else {
                // Nameplate row: avatar circle, @handle, a disabled chat-icon
                // placeholder (no 1:1 DM system exists yet — this just marks
                // the spot for when one does), and a three-dot menu (Invite
                // to constellation) opened via the
                // framework's own lively.morphic.Menu.openAt, same idiom
                // ConstellationLounge.js's _openMembershipMenu uses — it
                // handles click-outside-to-close for free, unlike a
                // hand-rolled dropdown box would.
                var AVSZ = 32;
                var rowW = FW - 16;
                this._friends.slice(0, 5).forEach(function (f, i) {
                  var row = new lively.morphic.Box(lively.rect(8, 34 + i * ROWH, rowW, ROWH - 4));
                  row.applyStyle({ fill: Color.rgba(0, 0, 0, 0), borderWidth: 0 });
                  row.draggingEnabled = false; row.droppingEnabled = false; row.grabbingEnabled = false;
                  panel.addMorph(row);

                  var avatarImg = new lively.morphic.Image(
                    lively.rect(0, Math.round((ROWH - 4 - AVSZ) / 2), AVSZ, AVSZ));
                  avatarImg.setImageURL(f.avatarUrl ||
                    lively.identity.postCardUtils.identiconDataUrl(f.handle || f.did, AVSZ));
                  avatarImg.applyStyle({ borderRadius: AVSZ / 2, borderWidth: 0, clipMode: 'hidden' });
                  avatarImg.draggingEnabled = false; avatarImg.droppingEnabled = false; avatarImg.grabbingEnabled = false;
                  avatarImg.eventsAreIgnored = true;
                  row.addMorph(avatarImg);

                  var DOTSZ  = 20;
                  var CHATSZ = 28;
                  var dotX   = rowW - DOTSZ;
                  var nameH  = 16;
                  var nameX  = AVSZ + 8;
                  var nameW  = 100;
                  var chatX  = nameX + nameW + 6;
                  // y is nudged 4.33px above the box-center formula every
                  // other row element uses — a plain Text morph's glyph
                  // renders with its visual vertical center sitting lower
                  // than its own box's geometric center (font line-height,
                  // not a bug in the box math), confirmed by measuring the
                  // live rendered span's getBoundingClientRect against the
                  // avatar's (a true image, so box-center == visual-center)
                  // until both landed on the same row-relative y. Without
                  // this, avatar/name/chat-icon don't share one visual
                  // midline even though their boxes are all centered.
                  var nameM = new lively.morphic.Text(
                    lively.rect(nameX, Math.round((ROWH - 4 - nameH) / 2) - 4.33, nameW, nameH),
                    '@' + (f.handle || f.did));
                  nameM.applyStyle({ allowInput: false, fontSize: 12,
                    textColor: Color.rgb(40, 40, 40),
                    fill: Color.rgba(0, 0, 0, 0), borderWidth: 0 });
                  nameM.draggingEnabled = false; nameM.droppingEnabled = false; nameM.grabbingEnabled = false;
                  nameM.eventsAreIgnored = true;
                  row.addMorph(nameM);

                  // Chat icon — opens a real 1:1 P2P E2EE DM window
                  // (lively.identity.DMChat, p2pchat.md) with this friend.
                  // Messaging is friend-gated server-side (FriendRegistry),
                  // so every row here is already a valid DM target — no
                  // separate lookup/permission UI needed. Same
                  // box-center-vs-visual-center nudge as nameM above,
                  // measured the same way (+0.67px here — small because the
                  // icon font's glyph sits much closer to its own line-box
                  // center than the regular text font's does).
                  var chatIcon = new lively.morphic.Text(
                    lively.rect(chatX, Math.round((ROWH - 4 - CHATSZ) / 2) + 0.67, CHATSZ, CHATSZ), 'chat_bubble');
                  chatIcon.draggingEnabled = false; chatIcon.droppingEnabled = false; chatIcon.grabbingEnabled = false;
                  chatIcon._friendHandle = f.handle;
                  chatIcon._friendDid    = f.did;
                  // fontSize is points, not px (1pt = 4/3px) — 16pt renders
                  // as a real ~21px glyph that fills this 28px box almost
                  // exactly with no extra padding needed, confirmed by
                  // measuring the live rendered span (getBoundingClientRect)
                  // rather than guessing; see CLAUDE.md's fontSize gotcha.
                  chatIcon.applyStyle({ allowInput: false, selectable: false, clipMode: 'hidden',
                    fontFamily: "'Material Symbols Rounded'", fontSize: 16, align: 'center',
                    whiteSpaceHandling: 'pre', padding: lively.Rectangle.inset(0, 0, 0, 0),
                    textColor: Color.black, handStyle: 'pointer',
                    fill: Color.rgba(0, 0, 0, 0), borderWidth: 0 });
                  row.addMorph(chatIcon);
                  chatIcon.renderContext().morphNode.title = 'Message';
                  chatIcon.addScript(function onMouseUp(evt) {
                    var handle = this._friendHandle, did = this._friendDid;
                    lively.require('lively.identity.DMChat').toRun(function () {
                      lively.identity.DMChat.open(handle, did);
                    });
                    evt.stop(); return true;
                  });

                  var moreBtn = new lively.morphic.Text(
                    lively.rect(dotX, Math.round((ROWH - 4 - DOTSZ) / 2), DOTSZ, DOTSZ), 'more_vert');
                  moreBtn.draggingEnabled = false; moreBtn.droppingEnabled = false; moreBtn.grabbingEnabled = false;
                  moreBtn.applyStyle({ allowInput: false, selectable: false, clipMode: 'hidden',
                    fontFamily: "'Material Symbols Rounded'", fontSize: 14, align: 'center',
                    whiteSpaceHandling: 'pre', padding: lively.Rectangle.inset(0, 3, 0, 0),
                    textColor: Color.rgb(100, 100, 100), handStyle: 'pointer',
                    fill: Color.rgba(0, 0, 0, 0), borderWidth: 0 });
                  moreBtn._friendDid    = f.did;
                  moreBtn._friendHandle = f.handle;
                  row.addMorph(moreBtn);
                  moreBtn.renderContext().morphNode.title = 'More';
                  // Toggle-close, part 1/2: snapshot "is my own menu still
                  // open" at mousedown time, INTO a flag onMouseUp reads.
                  // Checking $world.currentMenu directly inside onMouseUp
                  // doesn't work — confirmed live by tracing both handlers:
                  // World's own onMouseUp (Events.js) already runs its
                  // "close whatever menu is open, the click target isn't a
                  // menu item" check and clears $world.currentMenu BEFORE
                  // this button's own onMouseUp handler is reached, so by
                  // then it always looks like nothing was open and this
                  // just reopens an identical menu. Reading the same state
                  // one event earlier, at onMouseDown (which always fires
                  // before any mouseup handling, world's or this button's),
                  // sees the true pre-close state instead.
                  moreBtn.addScript(function onMouseDown(evt) {
                    this._wasMyMenuOpen = !!(this._openMenu && $world.currentMenu === this._openMenu);
                  });
                  moreBtn.addScript(function onMouseUp(evt) {
                    var btn = this;
                    // Toggle-close, part 2/2: the snapshot from onMouseDown
                    // above tells us the click that just landed was a
                    // second click while our own menu was still open (and
                    // the world has since closed it as a side effect of
                    // this same click) — respect that as "close", don't
                    // reopen. Same toggle idiom as PostCardMailbox.js's
                    // _toggleRowMenu, just keyed off a different signal
                    // since that file's menus aren't lively.morphic.Menu.
                    if (btn._wasMyMenuOpen) {
                      btn._wasMyMenuOpen = false;
                      btn._openMenu = null;
                      evt.stop();
                      return true;
                    }
                    var did   = btn._friendDid;
                    var hndl  = btn._friendHandle;
                    var rowM  = btn.owner;
                    var pnl   = rowM && rowM.owner;
                    var pn    = pnl && pnl.owner;
                    var w     = pn && pn.owner;
                    var pos   = btn.worldPoint(lively.pt(0, btn.getExtent().y));
                    var items = [];
                    // Blocking someone disables all interactions both ways,
                    // including inviting them — see DID.js's isBlocked/
                    // MiniProfileCard.js's Block menu item.
                    if (!lively.identity.did.isBlocked(did, hndl)) {
                      items.push(["Invite to constellation…", function () {
                        if (w) w._openInviteToConstellationPicker(did, hndl, pos);
                      }]);
                    }
                    if (!items.length) return true; // nothing to offer; don't open an empty menu
                    btn._openMenu = lively.morphic.Menu.openAt(pos, '@' + (hndl || did), items);
                    evt.stop();
                    return true;
                  });
                });
                if (this._friends.length > 5) {
                  msg((this._friends.length - 5) + ' more…', 34 + 5 * ROWH, 16)
                    .applyStyle({ fontSize: 10, textColor: Color.rgb(150, 150, 150) });
                }
              }
            } else if (status === 'friends') {
              msg('You and @' + this._handle + ' are friends.', 36);
            } else if (status === 'pending-outgoing') {
              msg('Friend request sent — pending.', 36);
              var cancelBtn = actionBtn('Cancel request', 80);
              cancelBtn.applyStyle({ textColor: Color.rgb(150, 40, 40) });
              cancelBtn._targetDid = this._targetDid;
              cancelBtn.addScript(function doAction() {
                var self_ = this;
                fetch('/@' + lively.identity.did.currentUser().handle + '/friend-requests/' + this._targetDid,
                  { method: 'DELETE', credentials: 'include' })
                  .then(function () {
                    var w = self_.owner && self_.owner.owner && self_.owner.owner.owner;
                    self_.owner.remove();
                    if (w) w.loadProfile(w._handle);
                  });
              });
              lively.bindings.connect(cancelBtn, 'fire', cancelBtn, 'doAction');
            } else if (status === 'pending-incoming') {
              msg('@' + this._handle + ' sent you a friend request.', 36, 40);
              var acceptBtn = actionBtn('Accept', 80);
              var declineBtn = actionBtn('Decline', 116);
              declineBtn.applyStyle({ textColor: Color.rgb(150, 40, 40) });
              acceptBtn._targetDid  = this._targetDid;
              declineBtn._targetDid = this._targetDid;
              // Deliberately duplicated (not a shared `respond` helper) —
              // addScript reconstructs each button's handler from its own
              // source text at click time, discarding any closure over a
              // function declared in this outer doAction's scope (same
              // BuildSpec-closure-loss gotcha as everywhere else in this
              // file); only this._targetDid and real global paths
              // (fetch, lively.identity.did) survive that reconstruction.
              acceptBtn.addScript(function doAction() {
                var self_ = this;
                fetch('/@' + lively.identity.did.currentUser().handle + '/friend-requests/' + this._targetDid,
                  { method: 'PUT', credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'approve' }) })
                  .then(function () {
                    var w = self_.owner && self_.owner.owner && self_.owner.owner.owner;
                    self_.owner.remove();
                    if (w) w.loadProfile(w._handle);
                  });
              });
              declineBtn.addScript(function doAction() {
                var self_ = this;
                fetch('/@' + lively.identity.did.currentUser().handle + '/friend-requests/' + this._targetDid,
                  { method: 'PUT', credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'decline' }) })
                  .then(function () {
                    var w = self_.owner && self_.owner.owner && self_.owner.owner.owner;
                    self_.owner.remove();
                    if (w) w.loadProfile(w._handle);
                  });
              });
              lively.bindings.connect(acceptBtn, 'fire', acceptBtn, 'doAction');
              lively.bindings.connect(declineBtn, 'fire', declineBtn, 'doAction');
            } else if (status === 'signed-out') {
              msg('Sign in to connect with @' + this._handle + '.', 36);
            } else {
              // 'none' — no relationship on file either direction.
              msg('You and @' + this._handle + ' are not yet friends.', 36);
              var reqBtn = actionBtn('Send friend request', 80);
              reqBtn._handle = this._handle;
              reqBtn.addScript(function doAction() {
                var self_ = this;
                fetch('/@' + this._handle + '/friend-requests',
                  { method: 'POST', credentials: 'include' })
                  .then(function () {
                    var w = self_.owner && self_.owner.owner && self_.owner.owner.owner;
                    self_.owner.remove();
                    if (w) w.loadProfile(w._handle);
                  });
              });
              lively.bindings.connect(reqBtn, 'fire', reqBtn, 'doAction');
            }

            // See copyBtn's comment further down (below the astro box) for
            // why this is a Text morph, not a Button.
            // Same look as MiniProfileCard's close button: light gray circle,
            // muted 13px glyph, red circle + white glyph on hover. Literals
            // (not that module's constants) since this handler is rebuilt
            // from source text at runtime and loses its enclosing scope.
            var closeBtn = new lively.morphic.Text(lively.rect(FW - 30, 8, 22, 22), 'close');
            closeBtn.draggingEnabled = false;
            closeBtn.droppingEnabled = false;
            closeBtn.grabbingEnabled = false;
            closeBtn.applyStyle({ borderRadius: 11, borderWidth: 0,
              fill: Color.rgb(240, 240, 240),
              fontFamily: "'Material Symbols Rounded'", fontSize: 13 * 0.75,
              textColor: Color.rgb(140, 140, 140), align: 'center',
              padding: lively.Rectangle.inset(0, 3, 0, 0),
              allowInput: false, selectable: false, clipMode: 'hidden',
              whiteSpaceHandling: 'pre', handStyle: 'pointer' });
            closeBtn.onMouseOver = function () {
              closeBtn.applyStyle({ fill: Color.rgb(224, 66, 66), textColor: Color.white });
            };
            closeBtn.onMouseOut = function () {
              closeBtn.applyStyle({ fill: Color.rgb(240, 240, 240), textColor: Color.rgb(140, 140, 140) });
            };
            closeBtn.addScript(function onMouseUp(evt) {
              this.owner.remove();
              evt.stop();
              return true;
            });
            panel.addMorph(closeBtn);
            if (pane) pane.addMorph(panel);
            // Soft drop shadow, same idiom/values as the other floating panels
            // (FilePreview, WikiEditor): written straight to the shape node.
            panel.renderContext().shapeNode.style.boxShadow = '0 4px 12px rgba(0,0,0,0.18)';
          });
          lively.bindings.connect(friendsBtn, 'fire', friendsBtn, 'doAction');
          pane.addMorph(friendsBtn);
          tint(friendsBtn, 255, 255, 255);
          // The label is a child morph; style changes on it don't always reach
          // the DOM (CLAUDE.md), so set the weight directly as well.
          var fbLabel = friendsBtn.label && friendsBtn.label.renderContext().shapeNode;
          if (fbLabel) {
            fbLabel.style.fontWeight = 'bold';
            var fbKids = fbLabel.querySelectorAll('*');
            for (var fi = 0; fi < fbKids.length; fi++) fbKids[fi].style.fontWeight = 'bold';
          }

          // Send-postcard button, right of the Friends pill: opens a new
          // postcard editor with this profile's handle preset as the
          // recipient (private, encrypted to them). Signed-in visitors on
          // someone else's card only — no point postcarding yourself.
          if (showPc) {
            var pcSize = btnH;
            var pcBtn = new lively.morphic.Text(
              lively.rect(btnX + btnW + 8, btnY, pcSize, pcSize), 'cards_stack');
            pcBtn.draggingEnabled = false;
            pcBtn.droppingEnabled = false;
            pcBtn.grabbingEnabled = false;
            pcBtn.applyStyle({ fill: Color.rgb(204, 0, 87),
              borderRadius: pcSize / 2, borderWidth: 0,
              fontFamily: "'Material Symbols Rounded'", fontSize: 13.5,
              textColor: Color.white, align: 'center',
              // 1px top padding: measured live, the glyph's ink sat ~1.3px
              // above the circle's center without it (now ~0.7px off).
              padding: lively.rect(0, 1, 0, 0),
              allowInput: false, selectable: false, clipMode: 'hidden',
              whiteSpaceHandling: 'pre', handStyle: 'pointer' });
            pcBtn._handle = handle;
            pcBtn.addScript(function onMouseUp(evt) {
              var toHandle = this._handle;
              var me = lively.identity.did.currentUser();
              if (me) {
                lively.require("lively.identity.PostCardEditor").toRun(function () {
                  lively.identity.PostCardEditor.newCard(me.handle,
                    { recipientHandle: toHandle, visibility: 'private' });
                });
              }
              evt.stop();
              return true;
            });
            pane.addMorph(pcBtn);
            pcBtn.renderContext().morphNode.title = 'Send @' + handle + ' a postcard';
          }
        })();


        // verified identity
        heading('fingerprint', "Verified identity");

        var didStr = did ? lively.identity.postCardUtils.truncateDid(did) : "—";
        var didW = Math.ceil(didStr.length * 7.5) + 16;
        pane.addMorph(txt(didStr, contentX, y, didW, 16, 10, 50, 50, 50, false));

        // Copy DID button — sits immediately after the DID text. A real
        // lively.morphic.Text (not a Button) rendering a Material Symbols
        // Rounded glyph, same construction AmbientPresencePanel.js's
        // makeIconButton uses — confirmed live that this is NOT
        // interchangeable with a Button: lively.morphic.Button renders its
        // text through an internal child `this.label` Text morph, and
        // applyStyle({fontFamily:...}) on that child silently no-ops (the
        // glyph stayed literal "content_copy" text in the default font even
        // after direct application on an already-rendered label — root
        // cause not fully pinned down, textColor applies fine through the
        // same call so it isn't a blanket style-application failure). A
        // bare Text morph styled and clicked the same way as this file's
        // BuildSpec makeIconButton reference doesn't have that problem.
        // Box grown from the original 26x22 (with a 5px top `padding`) to
        // 24x24 with no custom padding -- confirmed live (chrome-devtools
        // MCP, cropped/zoomed screenshot + getBoundingClientRect) that the
        // old box clipped the glyph's bottom by ~5px, matching the clip
        // already flagged (but not yet fixed here) in inventory.md's
        // write-up of this exact button. `y - 4` instead of `y - 2` keeps
        // the taller box vertically centered on the 16px-tall value line
        // above it.
        var copyBtn = new lively.morphic.Text(lively.rect(contentX + didW + 4, y - 4, 24, 24), 'content_copy');
        copyBtn.draggingEnabled = false;
        copyBtn.droppingEnabled = false;
        copyBtn.grabbingEnabled = false;
        copyBtn.applyStyle({ fill: Color.rgba(0, 0, 0, 0),
          borderRadius: 12, borderWidth: 0,
          fontFamily: "'Material Symbols Rounded'", fontSize: 12,
          textColor: Color.rgb(120, 120, 128), align: 'center',
          allowInput: false, selectable: false, clipMode: 'hidden',
          whiteSpaceHandling: 'pre', handStyle: 'pointer' });
        copyBtn._copyDid = did;
        copyBtn.addScript(function onMouseUp(evt) {
          var theDid = this._copyDid;
          var m      = this;
          if (theDid && navigator.clipboard) {
            navigator.clipboard.writeText(theDid).then(function () {
              m.setTextString('check');
              setTimeout(function () { m.setTextString('content_copy'); }, 1500);
            });
          }
          evt.stop();
          return true;
        });
        pane.addMorph(copyBtn);
        copyBtn.renderContext().morphNode.title = 'Copy DID';
        y += 24;

        // Domain — same heading/content convention as "Verified identity"/DID
        // above: gray label line, then the value(s) on their own line(s).
        // Verified domains get a green tick immediately after the domain
        // text (not way off at the content edge); lapsed ones get a yellow
        // "?" (tooltip "Invalid domain"). The @handle line up top is never
        // replaced by a domain, verified or not, so an invalid domain
        // "falls back to the original handle" by construction.
        if (domains && domains.length) {
          heading('language', "Domain");
          domains.forEach(function (d) {
            var isVerified = d.status === 'verified';
            var domW = Math.ceil(d.domain.length * 7.5) + 16;
            pane.addMorph(txt(d.domain, contentX, y, domW, 16, 10, 50, 50, 50, false));
            var bc = isVerified ? [34, 139, 34] : [200, 150, 0];
            var badgeIcon = ico(isVerified ? 'verified' : 'error', contentX + domW + 4, y - 2, 14, bc[0], bc[1], bc[2]);
            pane.addMorph(badgeIcon);
            var badge = txt(isVerified ? 'Verified' : 'Invalid', contentX + domW + 24, y, 70, 16, 10,
              bc[0], bc[1], bc[2], false);
            pane.addMorph(badge);
            badge.renderContext().morphNode.title = isVerified ? 'Verified domain' : 'Invalid domain';
            y += 20;
          });
          y += 6;
        }

        // joined + hosting
        var joinedStr = "—";
        if (self._envelope && self._envelope.created) {
          var d = new Date(self._envelope.created);
          var months = ["Jan","Feb","Mar","Apr","May","Jun",
                        "Jul","Aug","Sep","Oct","Nov","Dec"];
          joinedStr = months[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear();
        }
        // Home instance: the "#home" service entry the server records in the
        // DID document (DidHome.js). Left out when absent, never guessed.
        var hostStr = null;
        ((didDoc && Array.isArray(didDoc.service)) ? didDoc.service : []).forEach(function (s) {
          if (!hostStr && s && s.id === didDoc.id + "#home" && typeof s.serviceEndpoint === "string") {
            hostStr = s.serviceEndpoint.replace(/^https?:\/\//, "").replace(/\/+$/, "") || null;
          }
        });
        pane.addMorph(ico('calendar_today', contentX, y + 1, 12, 150, 150, 158));
        pane.addMorph(txt("Joined " + joinedStr, contentX + 18, y, cw - 18, 16, 10, 100, 100, 108, false)).applyStyle({ fixedWidth: false });
        y += 18;
        if (hostStr) {
          pane.addMorph(ico('dns', contentX, y + 1, 12, 150, 150, 158));
          pane.addMorph(txt("Hosted on " + hostStr, contentX + 18, y, cw - 18, 16, 10, 100, 100, 108, false)).applyStyle({ fixedWidth: false });
          y += 18;
        }
        y += 6;

        // ETH address — heading line, then the copiable address on its own line.
        if (payload.ethAddress) {
          heading('account_balance_wallet', "ETH address");
          var addrStr = lively.identity.postCardUtils.truncateAddress(payload.ethAddress);
          var addrW = Math.ceil(addrStr.length * 7.5) + 16;
          pane.addMorph(txt(addrStr, contentX, y, addrW, 16, 10, 50, 50, 50, false));
          // See copyBtn above for why this is a Text morph, not a Button.
          // See copyBtn above for why this is 24x24 with no custom padding.
          var addrCopyBtn = new lively.morphic.Text(lively.rect(contentX + addrW + 4, y - 4, 24, 24), 'content_copy');
          addrCopyBtn.draggingEnabled = false;
          addrCopyBtn.droppingEnabled = false;
          addrCopyBtn.grabbingEnabled = false;
          addrCopyBtn.applyStyle({ fill: Color.rgba(0, 0, 0, 0),
            borderRadius: 12, borderWidth: 0,
            fontFamily: "'Material Symbols Rounded'", fontSize: 12,
            textColor: Color.rgb(120, 120, 128), align: 'center',
            allowInput: false, selectable: false, clipMode: 'hidden',
            whiteSpaceHandling: 'pre', handStyle: 'pointer' });
          addrCopyBtn._copyText = payload.ethAddress;
          addrCopyBtn.addScript(function onMouseUp(evt) {
            var theText = this._copyText;
            var m       = this;
            if (theText && navigator.clipboard) {
              navigator.clipboard.writeText(theText).then(function () {
                m.setTextString('check');
                setTimeout(function () { m.setTextString('content_copy'); }, 1500);
              });
            }
            evt.stop();
            return true;
          });
          pane.addMorph(addrCopyBtn);
          addrCopyBtn.renderContext().morphNode.title = 'Copy ETH address';
          y += 24;
        }

        // device
        heading('devices', "Device");
        var vms = (didDoc && didDoc.verificationMethod) || [];
        if (vms.length === 0) {
          pane.addMorph(txt("No device registered", contentX, y, cw, 16, 10, 160, 160, 160, false)).applyStyle({ fixedWidth: false });
          y += 18;
        } else {
          vms.forEach(function (vm) {
            var label = (vm.lively && vm.lively.deviceLabel) || vm.id || "Unknown device";
            pane.addMorph(txt(label, contentX, y, cw, 16, 10, 80, 80, 80, false)).applyStyle({ fixedWidth: false });
            y += 18;
          });
        }

        // Grow the window if the detail rows run past the bottom of the pane.
        // `y` is now one row past the last row (rowY + 18). Originally added
        // because the last row then was an icon row: ico() puts its (px + 8)
        // -tall box at rowY + 3, bottom = rowY + 23 = y + 5, which measured
        // live as 3px below the window's bottom edge. Keeping the same
        // y + 10 margin regardless of which row ends up last.
        var needLeftH = y + 10, haveLeftH = pane.getExtent().y;
        if (needLeftH > haveLeftH) {
          var le = self.getExtent();
          self.setExtent(lively.pt(le.x, le.y + (needLeftH - haveLeftH)));
          // Same bookkeeping as the Connect card's growth, so the undo at
          // the top of the next render takes this back out too.
          self._connectExtra = (self._connectExtra || 0) + (needLeftH - haveLeftH);
        }

        var ph = pane.getExtent().y;

        // Enter button — opens this handle's homestar (GET /@:handle). Hidden
        // when the card is already open over that page. Sits to the left of
        // the owner's Edit button when both are present, otherwise takes the
        // Edit button's usual bottom-right slot.
        if (self._showEnter) {
          var EW = 130;
          var ex = self._isOwner ? (pw - 78 - 8 - EW) : (pw - EW - 12);
          var worldBtn = new lively.morphic.Button(
            lively.rect(ex, ph - 36, EW, 26), "Enter Home →");
          worldBtn.applyStyle({ fill: Color.rgb(255, 255, 255),
            borderColor: Color.rgb(204, 0, 87), borderRadius: 13,
            fontSize: 12, textColor: Color.rgb(204, 0, 87), borderWidth: 1 });
          worldBtn.setAppearanceStylingMode(false);
          worldBtn.setBorderStylingMode(false);
          worldBtn._targetHandle = handle;
          worldBtn.addScript(function doAction() {
            window.location.href = '/@' + encodeURIComponent(this._targetHandle);
          });
          lively.bindings.connect(worldBtn, 'fire', worldBtn, 'doAction');
          pane.addMorph(worldBtn);
          tint(worldBtn, 204, 0, 87);
        }

        // Edit button — navigates to Window via this.owner._win
        if (self._isOwner) {
          var editBtn = new lively.morphic.Button(
            lively.rect(pw - 78, ph - 36, 66, 26), "Edit");
          editBtn.applyStyle({ fill: Color.rgb(204, 0, 87),
            borderColor: Color.rgb(204, 0, 87), borderRadius: 13,
            fontSize: 12, textColor: Color.white, borderWidth: 1 });
          editBtn.setAppearanceStylingMode(false);
          editBtn.setBorderStylingMode(false);
          editBtn.addScript(function doAction() {
            var pane = this.owner;
            var win  = pane && pane.owner;
            if (!win) return;
            var env = win._envelope;
            var p   = (env && env.record && env.record.payload) || {};
            win._renderEdit(win._handle, p, win._currentDid);
          });
          lively.bindings.connect(editBtn, 'fire', editBtn, 'doAction');
          pane.addMorph(editBtn);
          tint(editBtn, 255, 255, 255);
        }
      },

      // ── edit view ────────────────────────────────────────────────────────────

      _renderEdit: function _renderEdit(handle, payload, did, tab) {
        var self = this;
        var pane = this.targetMorph;
        if (!pane) return;
        pane.removeAllMorphs();
        self._editMode    = true;
        self._editPayload = payload; // authoritative merged state across tab switches
        tab = tab || 'profile';

        // Store context on pane for button handlers (_win excluded from serialization)
        pane._win = self;
        if (pane.doNotSerialize && pane.doNotSerialize.indexOf('_win') === -1)
          pane.doNotSerialize.push('_win');

        var pw   = pane.getExtent().x;
        var y    = 12;
        var PINK = Color.rgb(204, 0, 87);
        var ew   = Math.min(pw - 24, 500); // cap form width so inputs don't span the full pane

        function addField(labelText, inputName, value, h) {
          var lbl = new lively.morphic.Text(lively.rect(12, y, ew, 16), labelText);
          lbl.applyStyle({ allowInput: false, fontSize: 10,
            textColor: Color.rgb(120, 120, 120),
            fill: Color.rgb(255, 255, 255), borderWidth: 0 });
          pane.addMorph(lbl);
          y += 17;
          var inp = new lively.morphic.Text(
            lively.rect(12, y, ew, h || 24), value || "");
          inp.name = inputName;
          inp.applyStyle({ allowInput: true, fontSize: 12,
            fill: Color.rgb(252, 252, 252),
            borderColor: Color.rgb(200, 200, 200), borderWidth: 1, borderRadius: 6 });
          inp.beInputLine();
          pane.addMorph(inp);
          y += (h || 24) + 8;
        }

        // Tab headers — switching tabs snapshots the currently-visible
        // fields into self._editPayload first (via win._snapshotEditFields)
        // so in-progress edits on the tab being left aren't lost, since each
        // tab is a full pane rebuild rather than a show/hide of two
        // pre-built panels (only one tab's fields exist in the pane at a time).
        // Button label color: applyStyle({textColor}) doesn't reach a
        // Button's label DOM (see CLAUDE.md), so write it directly.
        function tint(btn, r, g, b) {
          var c = 'rgb(' + r + ',' + g + ',' + b + ')';
          var n = btn.label && btn.label.renderContext().shapeNode;
          if (!n) return;
          n.style.color = c;
          var kids = n.querySelectorAll('*');
          for (var i = 0; i < kids.length; i++) kids[i].style.color = c;
        }

        function addTabButton(label, tabName, x) {
          var isActive = tab === tabName;
          var tb = new lively.morphic.Button(lively.rect(x, y, 124, 28), label);
          tb.applyStyle({
            fill:       isActive ? PINK : Color.rgb(255, 255, 255),
            borderColor: isActive ? PINK : Color.rgb(222, 222, 228),
            borderRadius: 14, fontSize: 11,
            textColor:  isActive ? Color.white : Color.rgb(90, 90, 98),
            borderWidth: 1,
          });
          tb.setAppearanceStylingMode(false);
          tb.setBorderStylingMode(false);
          tb._targetTab = tabName;
          tb.addScript(function doAction() {
            var pane = this.owner;
            var win  = pane && pane.owner;
            if (!win) return;
            win._editPayload = Object.assign({}, win._editPayload, win._snapshotEditFields(pane));
            win._renderEdit(win._handle, win._editPayload, win._currentDid, this._targetTab);
          });
          lively.bindings.connect(tb, 'fire', tb, 'doAction');
          pane.addMorph(tb);
          if (isActive) tint(tb, 255, 255, 255); else tint(tb, 90, 90, 98);
        }
        addTabButton("Profile", "profile", 12);
        addTabButton("Orbit", "orbit", 142);
        addTabButton("Accounts", "accounts", 272);
        addTabButton("Domain Handle", "domains", 402);
        y += 40;

        if (tab === 'profile') {

        addField("Display name", "pcDisplayName", payload.displayName || "");
        addField("Pronouns",     "pcPronouns",    payload.pronouns    || "");
        // Bio is capped at 300 chars. The counter sits on the label row,
        // right-aligned, and is fed by the input's 'textString' signal
        // (fired from Text#onKeyUp); anything past the cap is trimmed
        // there, and again on snapshot/save.
        var bioLblY = y;
        var bioStart = (payload.bio || "").slice(0, 300);
        addField("Bio",          "pcBio",         bioStart, 88);
        var bioCounter = new lively.morphic.Text(
          lively.rect(12 + ew - 90, bioLblY, 90, 16), bioStart.length + " / 300");
        bioCounter.applyStyle({ allowInput: false, fontSize: 10, align: 'right',
          textColor: Color.rgb(140, 140, 148),
          fill: Color.rgb(255, 255, 255), borderWidth: 0 });
        bioCounter.addScript(function onBioChanged(s) {
          s = s || '';
          var inp = this.owner && this.owner.get('pcBio');
          if (s.length > 300) {
            s = s.slice(0, 300);
            if (inp) {
              inp.textString = s;
              // Resetting textString drops the caret to the start; put it
              // back at the end so continued typing doesn't prepend.
              inp.setSelectionRange(s.length, s.length);
            }
          }
          this.setTextString(s.length + ' / 300');
          this.applyStyle({ textColor: s.length >= 300 ? Color.rgb(200, 40, 40) : Color.rgb(140, 140, 148) });
        });
        pane.addMorph(bioCounter);
        lively.bindings.connect(pane.get("pcBio"), 'textString', bioCounter, 'onBioChanged');

        y = self._buildProfileExtras(pane, payload, y, ew);

        } else if (tab === 'accounts') {

        // ── Accounts tab ─────────────────────────────────────────────────

        y = self._buildSocials(pane, payload, y, ew);

        // ── websites (up to 3 — listed under the social circles on the
        // read view). Saved as payload.links = [{label, url}]. ────────────
        y += 8;
        var wsLbl = new lively.morphic.Text(lively.rect(12, y, ew, 16), "Websites (up to 3)");
        wsLbl.applyStyle({ allowInput: false, fontSize: 10,
          textColor: Color.rgb(120, 120, 120),
          fill: Color.rgb(255, 255, 255), borderWidth: 0 });
        pane.addMorph(wsLbl);
        y += 20;
        var siteLinks = payload.links || [];
        for (var wi = 0; wi < 3; wi++) {
          var wsInp = new lively.morphic.Text(lively.rect(12, y, ew, 24),
            (siteLinks[wi] && (siteLinks[wi].url || siteLinks[wi].label)) || "");
          wsInp.name = "pcWebsite" + wi;
          wsInp.applyStyle({ allowInput: true, fontSize: 12,
            fill: Color.rgb(252, 252, 252),
            borderColor: Color.rgb(200, 200, 200), borderWidth: 1, borderRadius: 3 });
          wsInp.beInputLine();
          pane.addMorph(wsInp);
          y += 30;
        }

        // ETH wallet last: the least-used field on this tab.
        y += 8;
        addField("ETH wallet address", "pcEthAddress", payload.ethAddress || "");

        } else if (tab === 'orbit') {

        y = self._buildOrbitTab(pane, payload, y, ew);

        } else {

        y = self._buildDomainTab(pane, y, ew);

        }

        // Save/Cancel are pinned to the bottom-right of the card (matching
        // the read view's "Edit" button anchoring) rather than following
        // wherever the current tab's content happens to end — the Account
        // tab's content is much shorter than Profile's, which otherwise
        // left them stranded near the top with a large dead area below.
        // Grow the window (never shrink) if the tab's content plus the button
        // row doesn't fit, same as the read view does — otherwise a tall tab
        // (Profile, with the birth-chart panel) runs under Save/Cancel and
        // past the window's bottom edge.
        var needPaneH = y + 46, havePaneH = pane.getExtent().y;
        if (needPaneH > havePaneH) {
          var we = self.getExtent();
          self.setExtent(lively.pt(we.x, we.y + (needPaneH - havePaneH)));
        }
        var btnY = pane.getExtent().y - 36;

        // Save — reads named inputs from pane, merges onto self._editPayload
        // so fields from whichever tab isn't currently visible survive.
        var saveBtn = new lively.morphic.Button(lively.rect(pw - 166, btnY, 74, 26), "Save");
        saveBtn.applyStyle({ fill: PINK, borderColor: PINK, borderRadius: 13,
          fontSize: 12, textColor: Color.white, borderWidth: 1 });
        saveBtn.setAppearanceStylingMode(false);
        saveBtn.setBorderStylingMode(false);
        saveBtn.addScript(function doAction() {
          var win  = this.owner && this.owner.owner;
          var pane = this.owner;
          if (!win || !pane) return;
          var merged = Object.assign({}, win._editPayload, win._snapshotEditFields(pane));
          if (merged.ethAddress && !/^0x[a-fA-F0-9]{40}$/.test(merged.ethAddress)) {
            alert('ETH address must be a 42-character 0x-prefixed hex address (or left blank).');
            return;
          }
          var newPayload = {
            displayName: merged.displayName || win._handle,
            pronouns:    merged.pronouns    || "",
            bio:         merged.bio         || "",
            avatarUrl:   merged.avatarUrl   || null,
            bannerUrl:   merged.bannerUrl   || null,
            links:       merged.links       || [],
            sunSign:     merged.sunSign     || "",
            moonSign:    merged.moonSign    || "",
            risingSign:  merged.risingSign  || "",
            ethAddress:  merged.ethAddress  || "",
            socialAccounts: merged.socialAccounts || [],
            orbit:       merged.orbit       || { status: null, spotlights: [] },
          };
          lively.identity.userSpace.saveProfile(newPayload, function (err) {
            if (err) { alert("Save failed: " + err.message); return; }
            win._editMode    = false;
            win._editPayload = null;
            win.loadProfile(win._handle);
          });
        });
        lively.bindings.connect(saveBtn, 'fire', saveBtn, 'doAction');
        pane.addMorph(saveBtn);
        tint(saveBtn, 255, 255, 255);

        // Cancel — navigates to Window and reloads view
        var cancelBtn = new lively.morphic.Button(lively.rect(pw - 84, btnY, 72, 26), "Cancel");
        cancelBtn.applyStyle({ fill: Color.rgb(255, 255, 255),
          borderColor: Color.rgb(200, 200, 208), borderRadius: 13,
          fontSize: 12, textColor: Color.rgb(90, 90, 98), borderWidth: 1 });
        cancelBtn.setAppearanceStylingMode(false);
        cancelBtn.setBorderStylingMode(false);
        cancelBtn.addScript(function doAction() {
          var win = this.owner && this.owner.owner;
          if (!win) return;
          win._editMode    = false;
          win._editPayload = null;
          win.loadProfile(win._handle);
        });
        lively.bindings.connect(cancelBtn, 'fire', cancelBtn, 'doAction');
        pane.addMorph(cancelBtn);
        tint(cancelBtn, 90, 90, 98);
      },

      // Reads whichever named inputs are currently present in `pane` (only
      // one tab's worth exist at a time — see _renderEdit) into a partial
      // payload object, for merging onto self._editPayload on tab switch
      // or Save so fields from the tab not currently visible aren't lost.
      _snapshotEditFields: function _snapshotEditFields(pane) {
        var SV = ['Aries','Taurus','Gemini','Cancer','Leo','Virgo',
                  'Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'];
        var partial = {};
        var nameInp     = pane.get("pcDisplayName");
        var pronounsInp = pane.get("pcPronouns");
        var bioInp      = pane.get("pcBio");
        var avatarInp   = pane.get("pcAvatarUrl");
        var bannerInp   = pane.get("pcBannerUrl");
        var sunInp     = pane.get("pcSunSign");
        var moonInp     = pane.get("pcMoonSign");
        var risingInp   = pane.get("pcRisingSign");
        var ethInp      = pane.get("pcEthAddress");
        if (nameInp)     partial.displayName = nameInp.textString || "";
        if (pronounsInp) partial.pronouns    = pronounsInp.textString || "";
        if (bioInp)      partial.bio         = (bioInp.textString || "").slice(0, 300);
        if (avatarInp)   partial.avatarUrl   = avatarInp.textString || null;
        if (bannerInp)   partial.bannerUrl   = bannerInp.textString || null;
        if (pane.get("pcWebsite0")) {
          var links = [];
          for (var wi = 0; wi < 3; wi++) {
            var wInp = pane.get("pcWebsite" + wi);
            var wUrl = ((wInp && wInp.textString) || "").trim();
            if (!wUrl) continue;
            if (!/^https?:\/\//i.test(wUrl)) wUrl = "https://" + wUrl;
            links.push({ label: wUrl.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, ""), url: wUrl });
          }
          partial.links = links;
        }
        if (sunInp)    partial.sunSign = sunInp._signIdx >= 0 ? SV[sunInp._signIdx] : '';
        if (moonInp)   partial.moonSign = moonInp._signIdx >= 0 ? SV[moonInp._signIdx] : '';
        if (risingInp) partial.risingSign = risingInp._signIdx >= 0 ? SV[risingInp._signIdx] : '';
        if (ethInp)    partial.ethAddress = (ethInp.textString || "").trim();
        // Orbit tab: the status is held on _editPayload by its chips (they
        // aren't inputs); only the spotlight rows are read here. A row needs
        // both a label and a handle to count.
        if (pane.get("pcOrbitLbl0")) {
          var curOrbit = (this._editPayload && this._editPayload.orbit) || {};
          var spots = [];
          for (var oi = 0; oi < 3; oi++) {
            var oLbl = pane.get("pcOrbitLbl" + oi), oHdl = pane.get("pcOrbitHandle" + oi);
            var ol = ((oLbl && oLbl.textString) || "").trim().slice(0, 10);
            var oh = ((oHdl && oHdl.textString) || "").trim().replace(/^@+/, "");
            if (ol && oh) spots.push({ label: ol, handle: oh });
          }
          partial.orbit = { status: curOrbit.status || null, spotlights: spots };
        }
        return partial;
      },

      // Resolve this device's soft signing private key (imported CryptoKey),
      // deriving/caching the KEK via a passkey ceremony if not already
      // cached this session — same recipe as UserSpace.js's
      // _signProfileEnvelopeIfPossible, used here to sign the domain
      // verification .well-known document.
      // Calls thenDo(err, privateKey).
      _getSoftSigningKey: function _getSoftSigningKey(thenDo) {
        var didMod = lively.identity.did;
        var user   = didMod.currentUser();
        if (!user) return thenDo(new Error('Not logged in'));
        var method = didMod.findMethodByCredentialId(user.document, user.credentialId);
        var livelyMeta = method && method.lively;
        if (!livelyMeta || !livelyMeta.softSigningKeyWrapped || !livelyMeta.delegationCert) {
          return thenDo(new Error('This device has not set up signing yet — use "Enable encryption" on the profile first.'));
        }
        var wa = lively.identity.webAuthn;
        var c  = lively.identity.crypto;

        function withKek(kek) {
          var wrapped;
          try { wrapped = JSON.parse(livelyMeta.softSigningKeyWrapped); }
          catch (e) { return thenDo(e); }
          c.decryptPayload(wrapped.ciphertext, wrapped.nonce, kek, function (err, softPrivJwk) {
            if (err) return thenDo(err);
            c.importPrivateKeyJwk(softPrivJwk, thenDo);
          });
        }

        if (wa._kekCache && wa._kekCache[user.credentialId]) {
          return withKek(wa._kekCache[user.credentialId]);
        }
        var challenge = new Uint8Array(32);
        crypto.getRandomValues(challenge);
        wa.deriveKek({ credentialId: user.credentialId, challenge: challenge, rpId: user.rpId }, function (err, kek) {
          if (err) return thenDo(err);
          withKek(kek);
        });
      },

      // ── edit-tab builders (Accounts / Domain Handle) ─────────────────────────
      // Each returns the new y cursor. Everything they (or the handlers they
      // install) need from outside the method body goes through
      // lively.identity.ProfileCard.* — see the namespace helpers at the end
      // of this file — never module-scope vars (evalJS closure loss).

      _buildProfileExtras: function _buildProfileExtras(pane, payload, y, ew) {
        var PC = lively.identity.ProfileCard;
        var ui = PC.ui;

        // Image URL row: label, input, Upload pill. `cropOpts` (optional)
        // is passed through to the cropper (banner is a wide rect).
        function imageRow(label, inputName, value, cropOpts) {
          ui.text(pane, label, 12, y, ew, 16, 10, 120, 120, 128, false);
          y += 18;
          ui.input(pane, inputName, 12, y, ew - 92, value || '');
          var up = ui.pill(pane, 'Upload', 12 + ew - 84, y, 84, 26, false, function () {
            var p   = lively.identity.ProfileCard.ui.paneOf(this);
            var win = p && p._win;
            if (!win) return;
            var target = this._targetInput, opts = this._cropOpts;
            var input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.style.display = 'none';
            document.body.appendChild(input);
            input.addEventListener('change', function () {
              var file = input.files && input.files[0];
              document.body.removeChild(input);
              if (!file) return;
              lively.identity.imageCropper.open(file, function (url) {
                var inp2 = win.targetMorph && win.targetMorph.get(target);
                if (inp2) inp2.textString = url;
              }, opts);
            });
            input.click();
          });
          up._targetInput = inputName;
          up._cropOpts = cropOpts;
          y += 36;
        }
        imageRow('Avatar URL', 'pcAvatarUrl', payload.avatarUrl);
        imageRow('Banner URL', 'pcBannerUrl', payload.bannerUrl,
          { width: 834, height: 160, shape: 'rect', title: 'Crop Banner', basename: 'banner' });

        y += 4;
        ui.text(pane, 'Astrological signs', 12, y, ew, 16, 10, 120, 120, 128, false);
        y += 22;

        // Each row steps through "Not set" (-1) and the 12 signs, so a
        // blank sign stays blank instead of silently saving as Aries.
        [['Sun', 'pcSunSign', payload.sunSign], ['Moon', 'pcMoonSign', payload.moonSign],
         ['Rising', 'pcRisingSign', payload.risingSign]].forEach(function (row) {
          var idx = PC.ZODIAC.SIGNS.indexOf(row[2]);
          ui.text(pane, row[0], 12, y + 4, 56, 18, 11, 90, 90, 98, false);
          var prev = ui.iconBtn(pane, 'chevron_left', 72, y + 2, 90, 90, 98, 'Previous');
          var disp = new lively.morphic.Text(lively.rect(100, y, 200, 26), PC.signLabel(idx));
          disp.name = row[1];
          disp._signIdx = idx;
          ui.noDrag(disp);
          disp.applyStyle({ allowInput: false, fontSize: 12, fontWeight: 'bold',
            textColor: Color.rgb.apply(null, PC.signRgb(idx)),
            fill: Color.rgb(248, 248, 251), borderColor: Color.rgb(225, 225, 231),
            borderWidth: 1, borderRadius: 13, align: 'center' });
          pane.addMorph(disp);
          var next = ui.iconBtn(pane, 'chevron_right', 304, y + 2, 90, 90, 98, 'Next');
          prev._field = next._field = row[1];
          prev._step = -1; next._step = 1;
          prev.onMouseUp = next.onMouseUp = function (evt) {
            evt.stop();
            var P = lively.identity.ProfileCard;
            var p = P.ui.paneOf(this);
            var d = p && p.get(this._field);
            if (!d) return true;
            // -1..11 → 13 states
            d._signIdx = ((d._signIdx + 1 + this._step + 13) % 13) - 1;
            d.textString = P.signLabel(d._signIdx);
            var c = P.signCss(d._signIdx);
            var n = d.renderContext().shapeNode;
            n.style.color = c;
            var kids = n.querySelectorAll('*');
            for (var i = 0; i < kids.length; i++) kids[i].style.color = c;
            return true;
          };
          y += 34;
        });

        // Birth-chart calculator: opens as a popup over the tab (PC.natal.open)
        // and fills the three pickers above.
        y += 4;
        ui.pill(pane, 'Calculate from birth chart', 12, y, 196, 26, false, function () {
          lively.identity.ProfileCard.natal.open(this);
        });
        ui.text(pane, 'Your birth details stay on this device.', 220, y + 5, ew - 208, 16, 10, 150, 150, 158, false);
        y += 32;
        return y + 6;
      },

      _buildSocials: function _buildSocials(pane, payload, y, ew) {
        var PC  = lively.identity.ProfileCard;
        var ui  = PC.ui;
        var MAX = 5;
        var accounts = payload.socialAccounts || [];
        pane._selPlatform = null; // tiles are rebuilt unhighlighted

        y += 8;
        ui.text(pane, 'Social accounts', 12, y, ew - 80, 18, 11, 60, 60, 68, true);
        var counter = ui.text(pane, accounts.length + ' / ' + MAX, 12 + ew - 80, y, 80, 18, 10, 140, 140, 148, false);
        counter.applyStyle({ align: 'right' });
        y += 26;

        if (!accounts.length) {
          ui.text(pane, 'Nothing here yet. Pick a platform below and paste your profile link.',
            12, y, ew, 18, 11, 150, 150, 158, false);
          y += 26;
        }

        accounts.forEach(function (acc, idx) {
          var info = PC.platformInfo(acc.platform);
          var chip = ui.chip(pane, 12, y, 30);
          ui.chipIcon(chip, acc.platform, 30);
          ui.text(pane, info ? info.label : acc.platform, 50, y - 2, ew - 100, 18, 11, 40, 40, 48, true);
          ui.text(pane, String(acc.url || '').replace(/^https?:\/\/(www\.)?/i, ''),
            50, y + 14, ew - 100, 18, 10, 120, 120, 128, false);
          var rm = ui.iconBtn(pane, 'close', 12 + ew - 28, y + 3, 150, 30, 30, 'Remove');
          rm._idx = idx;
          rm.onMouseUp = function (evt) {
            evt.stop();
            var p   = lively.identity.ProfileCard.ui.paneOf(this);
            var win = p && p._win;
            if (!win) return true;
            var current = ((win._editPayload && win._editPayload.socialAccounts) || []).slice();
            current.splice(this._idx, 1);
            win._editPayload = Object.assign({}, win._editPayload, win._snapshotEditFields(p), { socialAccounts: current });
            win._renderEdit(win._handle, win._editPayload, win._currentDid, 'accounts');
            return true;
          };
          y += 36;
        });

        if (accounts.length >= MAX) {
          ui.text(pane, 'Maximum of ' + MAX + ' social accounts reached. Remove one to add another.',
            12, y, ew, 18, 10, 140, 140, 148, false);
          return y + 24;
        }

        y += 6;
        ui.text(pane, 'Add an account', 12, y, ew, 16, 10, 120, 120, 128, false);
        y += 20;

        var STEP = 38;
        var cols = Math.max(1, Math.floor((ew + 6) / STEP));
        PC.SOCIAL_PLATFORMS.forEach(function (p, i) {
          var chip = ui.chip(pane, 12 + (i % cols) * STEP, y + Math.floor(i / cols) * STEP, 32);
          chip.name = 'pcPlat_' + p.key;
          chip._platformKey = p.key;
          ui.chipIcon(chip, p.key, 32);
          chip.renderContext().morphNode.title = p.label;
          chip.onMouseUp = function (evt) {
            evt.stop();
            lively.identity.ProfileCard.ui.selectPlatform(this.owner, this._platformKey);
            return true;
          };
        });
        y += Math.ceil(PC.SOCIAL_PLATFORMS.length / cols) * STEP + 2;

        var sel = ui.text(pane, 'Choose a platform', 12, y, ew, 18, 11, 120, 120, 128, true);
        sel.name = 'pcSelPlatLbl';
        // Pasting a recognisable link picks the platform automatically
        // (same textString-signal + addScript idiom as the bio counter).
        sel.addScript(function onUrlChanged(s) {
          var P = lively.identity.ProfileCard;
          var key = P.platformForUrl(s);
          if (key && this.owner) P.ui.selectPlatform(this.owner, key);
        });
        y += 24;

        var urlInp = ui.input(pane, 'pcNewSocialUrl', 12, y, ew - 84, '');
        lively.bindings.connect(urlInp, 'textString', sel, 'onUrlChanged');
        ui.pill(pane, 'Add', 12 + ew - 76, y, 76, 26, true, function () {
          var P   = lively.identity.ProfileCard;
          var p   = P.ui.paneOf(this);
          var win = p && p._win;
          if (!win) return;
          function fail(t) { P.ui.setMsg(p, 'pcSocialMsg', t, true); }
          var inp = p.get('pcNewSocialUrl');
          var url = ((inp && inp.textString) || '').trim();
          var key = p._selPlatform || P.platformForUrl(url);
          if (!key) return fail('Pick a platform first.');
          if (!url) return fail('Paste your ' + P.platformInfo(key).label + ' profile link.');
          if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
          var current = ((win._editPayload && win._editPayload.socialAccounts) || []).slice();
          if (current.length >= 5) return fail('Maximum 5 social accounts.');
          current.push({ platform: key, url: url });
          win._editPayload = Object.assign({}, win._editPayload, win._snapshotEditFields(p), { socialAccounts: current });
          win._renderEdit(win._handle, win._editPayload, win._currentDid, 'accounts');
        });
        y += 32;

        var msg = ui.text(pane, '', 12, y, ew, 18, 10, 200, 40, 40, false);
        msg.name = 'pcSocialMsg';
        return y + 22;
      },

      // Orbit tab: two categories, matching the read view's Orbit widget.
      //   1. Relationship status — one pick from preset chips (click again to
      //      clear). Chips aren't inputs, so a pick is written straight onto
      //      win._editPayload.orbit.status (see PC.orbit.pickStatus).
      //   2. Spotlights — up to 3 rows of label + @handle inputs
      //      (pcOrbitLbl<i> / pcOrbitHandle<i>, read by _snapshotEditFields),
      //      with quick-label chips that fill the first empty label.
      _buildOrbitTab: function _buildOrbitTab(pane, payload, y, ew) {
        var PC    = lively.identity.ProfileCard;
        var ui    = PC.ui;
        var orbit = payload.orbit || {};
        var curStatus = orbit.status && orbit.status.label ? orbit.status.label : null;
        var spots = (orbit.spotlights || []).slice(0, 3);

        // Chip widths come from a canvas measure of the label (same approach
        // as the read view's pill), plus a flat horizontal margin.
        var mctx = document.createElement('canvas').getContext('2d');
        mctx.font = (11 * 4 / 3) + 'px Helvetica';
        function chipW(str) { return Math.ceil(mctx.measureText(str).width) + 28; }

        y += 8;
        ui.text(pane, 'Relationship status', 12, y, ew, 18, 11, 60, 60, 68, true);
        y += 20;
        ui.text(pane, 'Shown on your card. Click your pick again to clear it.',
          12, y, ew, 16, 10, 120, 120, 128, false);
        y += 26;

        var x = 12;
        PC.ORBIT_STATUSES.forEach(function (s) {
          var str = s.label + ' ' + s.emoji;
          var w = chipW(str);
          if (x + w > 12 + ew) { x = 12; y += 34; }
          var chip = ui.pill(pane, str, x, y, w, 26, s.label === curStatus, function () {
            lively.identity.ProfileCard.orbit.pickStatus(this);
          });
          chip._orbitStatus = s;
          x += w + 8;
        });
        y += 44;

        ui.text(pane, 'Spotlights', 12, y, ew, 18, 11, 60, 60, 68, true);
        y += 20;
        ui.text(pane, 'Tag up to 3 people in your orbit: a short label, then their @handle.',
          12, y, ew, 16, 10, 120, 120, 128, false);
        y += 26;

        var LW = 130;
        ui.text(pane, 'Label', 12, y, LW, 14, 9, 160, 160, 160, false);
        ui.text(pane, 'Handle', 12 + LW + 8, y, ew - LW - 8, 14, 9, 160, 160, 160, false);
        y += 16;
        for (var i = 0; i < 3; i++) {
          var sp = spots[i] || {};
          ui.input(pane, 'pcOrbitLbl' + i, 12, y, LW, sp.label || '');
          ui.input(pane, 'pcOrbitHandle' + i, 12 + LW + 8, y, ew - LW - 8,
            sp.handle ? '@' + String(sp.handle).replace(/^@+/, '') : '');
          y += 32;
        }

        y += 6;
        ui.text(pane, 'Quick labels', 12, y, ew, 14, 9, 160, 160, 160, false);
        y += 18;
        var qx = 12;
        PC.ORBIT_SPOTLIGHT_LABELS.forEach(function (lab) {
          var w = chipW(lab);
          var q = ui.pill(pane, lab, qx, y, w, 24, false, function () {
            lively.identity.ProfileCard.orbit.fillLabel(this);
          });
          q._orbitLabel = lab;
          qx += w + 8;
        });
        return y + 34;
      },

      _buildDomainTab: function _buildDomainTab(pane, y, ew) {
        var self = this;
        var PC   = lively.identity.ProfileCard;
        var ui   = PC.ui;
        var rows = self._domains || [];

        // ── A domain is already set: show it as a status card ─────────────
        if (rows.length) {
          self._pendingDomain = null;
          self._domainMethod  = null;
          var d  = rows[0];
          var ok = d.status === 'verified';
          ui.text(pane, 'Domain handle', 12, y, ew, 18, 11, 60, 60, 68, true);
          y += 26;
          var card = ui.card(pane, 12, y, ew, 58);
          ui.icon(card, 'language', 14, 17, 22, 90, 90, 98);
          ui.text(card, d.domain, 48, 8, ew - 110, 20, 13, 30, 30, 38, true);
          if (ok) {
            ui.icon(card, 'check_circle', 48, 32, 14, 34, 139, 34);
            ui.text(card, 'Verified', 66, 30, 200, 18, 10, 34, 139, 34, false);
          } else {
            ui.icon(card, 'error', 48, 32, 14, 200, 140, 20);
            ui.text(card, "Couldn't verify right now", 66, 30, 240, 18, 10, 170, 115, 10, false);
          }
          var rm = ui.iconBtn(card, 'delete', ew - 36, 18, 150, 30, 30, 'Remove domain');
          rm._domain = d.domain;
          rm.onMouseUp = function (evt) {
            evt.stop();
            var p   = lively.identity.ProfileCard.ui.paneOf(this);
            var win = p && p._win;
            if (!win) return true;
            win._editPayload = Object.assign({}, win._editPayload, win._snapshotEditFields(p));
            lively.identity.userSpace.removeDomain(this._domain, function (err) {
              if (err) { alert('Could not remove domain: ' + err.message); return; }
              lively.identity.userSpace.listDomains(win._handle, function (err2, rows2) {
                win._domains = rows2 || [];
                win._renderEdit(win._handle, win._editPayload, win._currentDid, 'domains');
              });
            });
            return true;
          };
          y += 70;
          if (!ok) {
            var re = ui.pill(pane, 'Re-check now', 12, y, 120, 26, false, function () {
              lively.identity.ProfileCard.ui.runVerify(this);
            });
            re._domain = d.domain;
            var reMsg = ui.text(pane, '', 144, y, ew - 132, 30, 10, 200, 40, 40, false);
            reMsg.name = 'pcDomainMsg';
            y += 38;
          }
          ui.text(pane, 'One domain handle per identity. Remove it to use a different domain.',
            12, y, ew, 30, 10, 140, 140, 148, false);
          return y + 34;
        }

        // ── Step 1: enter a domain ────────────────────────────────────────
        if (!self._pendingDomain) {
          ui.text(pane, 'Use your own domain as your handle', 12, y, ew, 20, 12, 40, 40, 48, true);
          y += 24;
          ui.text(pane, "Add a domain to your profile e.g example.com and verify ownership with a single DNS record check.",
            12, y, ew, 44, 10, 120, 120, 128, false);
          y += 50;
          ui.text(pane, 'Your domain', 12, y, ew, 16, 10, 120, 120, 128, false);
          y += 18;
          ui.input(pane, 'pcNewDomain', 12, y, ew - 108, '');
          ui.pill(pane, 'Continue', 12 + ew - 100, y, 100, 26, true, function () {
            var P   = lively.identity.ProfileCard;
            var p   = P.ui.paneOf(this);
            var win = p && p._win;
            if (!win) return;
            var inp = p.get('pcNewDomain');
            var dom = P.normalizeDomain(inp && inp.textString);
            if (!dom) return P.ui.setMsg(p, 'pcDomainMsg', 'Enter a valid domain, like example.com.', true);
            win._editPayload   = Object.assign({}, win._editPayload, win._snapshotEditFields(p));
            win._pendingDomain = dom;
            win._domainMethod  = 'dns';
            win._renderEdit(win._handle, win._editPayload, win._currentDid, 'domains');
          });
          y += 34;
          var m1 = ui.text(pane, '', 12, y, ew, 18, 10, 200, 40, 40, false);
          m1.name = 'pcDomainMsg';
          return y + 22;
        }

        // ── Step 2: prove ownership ───────────────────────────────────────
        var dom    = self._pendingDomain;
        var method = self._domainMethod || 'dns';

        var back = ui.iconBtn(pane, 'arrow_back', 12, y - 1, 90, 90, 98, 'Use a different domain');
        back.onMouseUp = function (evt) {
          evt.stop();
          var p   = lively.identity.ProfileCard.ui.paneOf(this);
          var win = p && p._win;
          if (!win) return true;
          win._pendingDomain = null;
          win._renderEdit(win._handle, win._editPayload, win._currentDid, 'domains');
          return true;
        };
        ui.text(pane, 'Verify ' + dom, 44, y, ew - 44, 20, 13, 30, 30, 38, true);
        y += 34;

        if (method === 'dns') {
          ui.text(pane, "Add this TXT record in your domain's DNS settings:", 12, y, ew, 18, 11, 80, 80, 88, false);
          y += 26;
          // The value is a did:jwk: (~180+ chars, one unbroken token), so the
          // row's height comes from its length — a fixed height overflowed
          // the card. Deliberately conservative (8px/char, 18px/line) since
          // a short box clips/overflows while a slightly tall one is harmless.
          var recVal   = 'did=' + self._currentDid;
          var perLine  = Math.max(10, Math.floor((ew - 100) / 8));
          var valueH   = Math.ceil(recVal.length / perLine) * 18 + 8;
          var rec = ui.card(pane, 12, y, ew, 76 + valueH + 8);
          ui.recordRow(rec, 'Type',  'TXT',         12, 30, null,          ew);
          ui.recordRow(rec, 'Name',  '_lively-did', 44, 30, '_lively-did', ew);
          ui.recordRow(rec, 'Value', recVal,        76, valueH, recVal,    ew, 10);
          y += 76 + valueH + 8 + 10;
          ui.text(pane, 'If your DNS provider wants the full name, use _lively-did.' + dom + ' instead.',
            12, y, ew, 30, 10, 140, 140, 148, false);
          y += 34;
        } else {
          ui.text(pane, 'Publish a signed file at this address on your site:', 12, y, ew, 18, 11, 80, 80, 88, false);
          y += 26;
          var url = 'https://' + dom + '/.well-known/lively-did';
          var fcard = ui.card(pane, 12, y, ew, 44);
          ui.recordRow(fcard, 'URL', url, 12, 30, url, ew);
          y += 54;
          var gen = ui.pill(pane, 'Generate signed file', 12, y, 170, 26, false, function () {
            var P   = lively.identity.ProfileCard;
            var btn = this;
            var p   = P.ui.paneOf(btn);
            var win = p && p._win;
            if (!win) return;
            btn.setLabel('Signing…');
            btn.setActive(false);
            function reset() { btn.setLabel('Generate signed file'); btn.setActive(true); }
            win._getSoftSigningKey(function (err, key) {
              if (err) { reset(); return P.ui.setMsg(p, 'pcDomainMsg', 'Could not sign: ' + err.message, true); }
              var doc = lively.identity.webKey.buildWellKnownPayload({
                did: win._currentDid, handle: win._handle, domain: win._pendingDomain });
              lively.identity.webKey.signWellKnown(doc, key, function (err2, signed) {
                if (err2) { reset(); return P.ui.setMsg(p, 'pcDomainMsg', 'Signing failed: ' + err2.message, true); }
                var json = JSON.stringify(signed, null, 2);
                var box  = p.get('pcSignedJson');
                if (box) { box.setTextString(json); box._json = json; }
                var cp = p.get('pcCopyJson');
                if (cp) cp._copyText = json;
                btn.setLabel('Regenerate');
                btn.setActive(true);
                P.ui.setMsg(p, 'pcDomainMsg', 'Save this as the file above, then click Verify.', false);
              });
            });
          });
          y += 34;
          var jbox = new lively.morphic.Text(lively.rect(12, y, ew - 30, 84),
            'The signed file will appear here.');
          jbox.name = 'pcSignedJson';
          jbox.applyStyle({ allowInput: false, fixedWidth: true, fixedHeight: true,
            wordBreak: 'break-all', clipMode: 'auto', fontSize: 9, textColor: Color.rgb(60, 60, 68),
            fill: Color.rgb(248, 248, 251), borderColor: Color.rgb(225, 225, 231),
            borderWidth: 1, borderRadius: 8 });
          pane.addMorph(jbox);
          var cpj = ui.copyBtn(pane, 12 + ew - 24, y + 2, '');
          cpj.name = 'pcCopyJson';
          y += 94;
        }

        var vb = ui.pill(pane, 'Verify', 12, y, 96, 28, true, function () {
          lively.identity.ProfileCard.ui.runVerify(this);
        });
        vb._domain = dom;
        var vm = ui.text(pane, (method === 'dns' ? 'DNS changes can take a few minutes to show up.' : 'Verify once the file is live on your site.'), 120, y + 2, ew - 108, 30, 10, 140, 140, 148, false);
        vm.name = 'pcDomainMsg';
        y += 42;

        var alt = ui.link(pane, method === 'dns' ? "Can't edit DNS? Use a signed file instead"
                                                 : 'Use a DNS record instead', 12, y, ew);
        alt.onMouseUp = function (evt) {
          evt.stop();
          var p   = lively.identity.ProfileCard.ui.paneOf(this);
          var win = p && p._win;
          if (!win) return true;
          win._domainMethod = win._domainMethod === 'file' ? 'dns' : 'file';
          win._renderEdit(win._handle, win._editPayload, win._currentDid, 'domains');
          return true;
        };
        return y + 26;
      },
    });

    lively.identity.ProfileCard = {
      open: function (handle) {
        var win    = lively.BuildSpec("lively.identity.ProfileCard").createMorph();
        var user   = lively.identity.did.currentUser();
        var target = handle || (user && user.handle);
        win.setTitle(target ? "Profile — @" + target : "Profile");
        win.openInWorldCenter();
        win.loadProfile(handle || null);
        return win;
      },
    };

    // Shared data + widget helpers for the edit tabs (_buildSocials /
    // _buildDomainTab). They live on the namespace, not as module-scope
    // vars, because BuildSpec methods and addScript'd handlers are rebuilt
    // from source text and lose their enclosing closure — a dotted global
    // path is the only thing that survives (see CLAUDE.md).
    Object.extend(lively.identity.ProfileCard, {
      PINK: Color.rgb(204, 0, 87),
      ZODIAC: {
        SIGNS:  ['Aries','Taurus','Gemini','Cancer','Leo','Virgo',
                 'Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'],
        GLYPHS: ['♈︎','♉︎','♊︎','♋︎','♌︎','♍︎','♎︎','♏︎','♐︎','♑︎','♒︎','♓︎'],
      },
      // Orbit presets. Status is single-pick; spotlight labels are quick-fill
      // suggestions only (the label field itself is free text, 10 chars max).
      ORBIT_STATUSES: [
        { label: 'Single',      emoji: '✨' },
        { label: 'Booked',      emoji: '💋' },
        { label: 'Dating',      emoji: '💘' },
        { label: 'Open',        emoji: '♾️' },
        { label: 'Complicated', emoji: '🌀' },
      ],
      ORBIT_SPOTLIGHT_LABELS: ['Opp', 'Twin', 'Bestie', 'Crush'],

      orbit: {
        // Status chip clicked: toggle it in win._editPayload.orbit.status and
        // repaint the chips in place (no tab rebuild, so half-typed spotlight
        // rows aren't lost).
        pickStatus: function (btn) {
          var PC  = lively.identity.ProfileCard;
          var p   = PC.ui.paneOf(btn);
          var win = p && p._win;
          if (!win || !btn._orbitStatus) return;
          var cur  = (win._editPayload && win._editPayload.orbit) || {};
          var same = cur.status && cur.status.label === btn._orbitStatus.label;
          var next = same ? null : { label: btn._orbitStatus.label, emoji: btn._orbitStatus.emoji };
          win._editPayload = Object.assign({}, win._editPayload,
            { orbit: { status: next, spotlights: cur.spotlights || [] } });
          PC.orbit.paintStatus(p, next && next.label);
        },

        // Selected chip = primary (pink fill, white label); the rest = outline.
        // Model updates on an already-rendered morph don't always reach the
        // DOM (CLAUDE.md), so fill/border are written to the node as well.
        paintStatus: function (pane, label) {
          var PC = lively.identity.ProfileCard;
          pane.submorphs.forEach(function (m) {
            if (!m._orbitStatus) return;
            var on     = m._orbitStatus.label === label;
            var fill   = on ? PC.PINK : Color.white;
            var border = on ? PC.PINK : Color.rgb(222, 222, 228);
            m.applyStyle({ fill: fill, borderColor: border });
            var n = m.renderContext().shapeNode;
            n.style.background  = fill.toString();
            n.style.borderColor = border.toString();
            if (on) PC.ui.tint(m, 255, 255, 255); else PC.ui.tint(m, 90, 90, 98);
          });
        },

        // Quick-label chip: put its label in the first empty label field.
        fillLabel: function (btn) {
          var p = lively.identity.ProfileCard.ui.paneOf(btn);
          if (!p) return;
          for (var i = 0; i < 3; i++) {
            var inp = p.get('pcOrbitLbl' + i);
            if (inp && !(inp.textString || '').trim()) { inp.setTextString(btn._orbitLabel); return; }
          }
        },
      },

      signLabel: function (idx) {
        var Z = lively.identity.ProfileCard.ZODIAC;
        return idx < 0 ? 'Not set' : Z.GLYPHS[idx] + '  ' + Z.SIGNS[idx];
      },
      // Sign color by element (fire/earth/air/water), shared by the read view
      // and the edit pickers. Each is >= 4.8:1 against the card's light fills.
      // Signs cycle fire, earth, air, water in zodiac order, so idx % 4 picks it.
      ELEMENT_RGB: [[196, 56, 24], [38, 120, 66], [0, 118, 148], [95, 74, 196]],
      UNSET_RGB:   [150, 150, 158],
      // [r, g, b] for a sign index; the muted gray for -1 / not set.
      signRgb: function (idx) {
        var P = lively.identity.ProfileCard;
        return idx < 0 ? P.UNSET_RGB : P.ELEMENT_RGB[idx % 4];
      },
      signCss: function (idx) {
        return 'rgb(' + lively.identity.ProfileCard.signRgb(idx).join(',') + ')';
      },

      // Birth-chart calculator (edit → Profile tab → "Calculate from birth
      // chart"), shown as a popup over the tab. Birth date/time/place live
      // only in these inputs: they're never added to _editPayload or saved,
      // and are cleared after a successful calculation. Only the three sign
      // pickers are filled.
      natal: {
        PANEL_H: 328,
        PANEL_W: 410,

        // Popup: a dimming scrim over the whole pane plus the calculator card
        // centered on it. They're siblings, not parent/child: mouse dispatch
        // is capture-first, so a clickable scrim that owned the card would
        // get every click on the card's own widgets before they did.
        open: function (btn) {
          var PC   = lively.identity.ProfileCard, ui = PC.ui;
          var pane = ui.paneOf(btn);
          if (!pane || pane.get('pcNatalCard')) return;
          var ext = pane.getExtent();
          var scrim = new lively.morphic.Box(lively.rect(0, 0, ext.x, ext.y));
          scrim.name = 'pcNatalScrim';
          ui.noDrag(scrim);
          scrim.applyStyle({ fill: Color.rgba(20, 16, 24, 0.45), borderWidth: 0, handStyle: 'default' });
          scrim.onMouseUp = function (evt) {
            evt.stop();
            lively.identity.ProfileCard.natal.close(this);
            return true;
          };
          pane.addMorph(scrim);
          var w = Math.min(ext.x - 24, PC.natal.PANEL_W);
          var card = PC.natal.build(pane, Math.round((ext.x - w) / 2),
            Math.max(12, Math.round((ext.y - PC.natal.PANEL_H) / 2)), w);
          var x = ui.iconBtn(card, 'close', w - 30, 4, 120, 120, 128, 'Close');
          x.onMouseUp = function (evt) {
            evt.stop();
            lively.identity.ProfileCard.natal.close(this);
            return true;
          };
        },

        close: function (m) {
          var pane = lively.identity.ProfileCard.ui.paneOf(m);
          if (!pane) return;
          ['pcNatalCard', 'pcNatalScrim'].forEach(function (n) {
            var x = pane.get(n);
            if (x) x.remove();
          });
        },

        INFO: 'Your birth chart details are only used locally on this device to calculate your placements ' +
              'and never saved or sent to a remote server.',

        build: function (pane, x, y, w) {
          var PC = lively.identity.ProfileCard, ui = PC.ui, H = PC.natal.PANEL_H, PANEL_H = H;
          var card = ui.card(pane, x, y, w, H);
          card.name = 'pcNatalCard';
          // Faint pink accent (the card's usual neutral fill/border, warmed).
          card.applyStyle({ fill: Color.rgb(255, 245, 249), borderColor: Color.rgb(243, 200, 219) });
          var heading = ui.text(card, 'Birth chart calculator', 12, 8, w - 24, 16, 11, 60, 60, 68, true);
          heading.applyStyle({ fixedWidth: true, align: 'center' });
          ui.icon(card, 'lock', 10, 26, 12, 120, 120, 128);
          // Symmetric side margins (30px) keep the centered text centered on the
          // card itself; the lock icon sits in the left margin.
          var info = ui.text(card, PC.natal.INFO, 30, 27, w - 60, 44, 9, 120, 120, 128, false);
          info.applyStyle({ fixedWidth: true, align: 'center' });
          // Each label is centered over its own input; the date/time pair is centered as a row.
          function label(str, lx, ly, lw) {
            var t = ui.text(card, str, lx, ly, lw, 14, 9, 120, 120, 128, false);
            t.applyStyle({ fixedWidth: true, align: 'center' });
            return t;
          }
          // Widest labels need ~150px of text plus the box's own padding; below
          // that width they fall back to shorter wording rather than wrapping.
          var GAP = 12, IW = Math.max(112, Math.min(172, Math.floor((w - 24 - GAP) / 2)));
          var x0 = Math.round((w - (IW * 2 + GAP)) / 2);
          label(IW >= 168 ? 'Birth date (YYYY-MM-DD)' : 'Birth date', x0, 76, IW);
          label(IW >= 144 ? 'Time (needed for Rising)' : 'Time (for Rising)', x0 + IW + GAP, 76, IW);
          ui.input(card, 'pcNatalDate', x0, 98, IW, '');
          ui.input(card, 'pcNatalTime', x0 + IW + GAP, 98, IW, '');
          label('Birth place  (search for a city)', 12, 132, w - 24);
          var place = ui.input(card, 'pcNatalPlace', 12, 154, w - 24, '');
          card.addScript(function onPlaceTyped(s) {
            lively.identity.ProfileCard.natal.placeTyped(this, s);
          });
          lively.bindings.connect(place, 'textString', card, 'onPlaceTyped');
          ui.pill(card, 'Calculate', 12, 192, 96, 26, true, function () {
            lively.identity.ProfileCard.natal.calculate(this);
          });
          var msg = ui.text(card, '', 12, 226, w - 24, 72, 10, 140, 140, 148, false);
          msg.name = 'pcNatalMsg';
          msg.applyStyle({ fixedWidth: true });
          var credit = ui.text(card, 'Ephemeris: astronomy-engine (MIT)  ·  City data: GeoNames, CC BY 4.0',
            12, PANEL_H - 24, w - 24, 14, 8, 160, 160, 168, false);
          credit.applyStyle({ fixedWidth: true });
          credit.renderContext().morphNode.title = 'astronomy-engine by Donald Cross; city data from geonames.org, licensed CC BY 4.0';
          return card;
        },

        say: function (card, str, isError) {
          var PC = lively.identity.ProfileCard, m = card.get('pcNatalMsg');
          if (m) PC.ui.setMsg(card, 'pcNatalMsg', str, isError);
        },

        // Color a sign picker morph for a sign index (-1 = "Not set").
        setSign: function (pane, field, idx) {
          var PC = lively.identity.ProfileCard, d = pane.get(field);
          if (!d) return;
          d._signIdx = idx;
          d.textString = PC.signLabel(idx);
          var c = PC.signCss(idx);
          var n = d.renderContext().shapeNode;
          n.style.color = c;
          var kids = n.querySelectorAll('*');
          for (var i = 0; i < kids.length; i++) kids[i].style.color = c;
        },

        clearSuggestions: function (card) {
          var old = card.get('pcNatalSuggest');
          if (old) old.remove();
        },

        // The place input changed: forget any earlier pick and offer matches.
        placeTyped: function (card, s) {
          var PC = lively.identity.ProfileCard, N = lively.identity.NatalChart;
          s = s || '';
          if (card._pickedLabel === s) return; // set by pick(), not typed
          card._place = null;
          card._pickedLabel = null;
          PC.natal.clearSuggestions(card);
          PC.natal.say(card, '', false);
          if (s.trim().length < 2) return;
          N.ensureLoaded(function (err) {
            if (err) return PC.natal.say(card, err.message, true);
            var inp = card.get('pcNatalPlace');
            if (!card.world() || !inp || inp.textString !== s) return; // pane rebuilt / typed on
            PC.natal.showSuggestions(card, N.searchCities(s, 5));
          });
        },

        showSuggestions: function (card, cities) {
          var PC = lively.identity.ProfileCard, ui = PC.ui, N = lively.identity.NatalChart;
          PC.natal.clearSuggestions(card);
          if (!cities.length) return PC.natal.say(card, 'No matching city found.', true);
          var w = card.getExtent().x - 24, rowH = 24;
          var box = new lively.morphic.Box(lively.rect(12, 186, w, cities.length * rowH + 4));
          box.name = 'pcNatalSuggest';
          ui.noDrag(box);
          box.applyStyle({ fill: Color.white, borderColor: Color.rgb(200, 200, 200),
            borderWidth: 1, borderRadius: 6 });
          cities.forEach(function (c, i) {
            var row = new lively.morphic.Text(lively.rect(2, 2 + i * rowH, w - 4, rowH), N.cityLabel(c));
            ui.noDrag(row);
            row.applyStyle({ allowInput: false, selectable: false, fontSize: 11,
              textColor: Color.rgb(50, 50, 58), fill: Color.rgba(0, 0, 0, 0),
              borderWidth: 0, borderColor: null, handStyle: 'pointer' });
            row._city = c;
            row.onMouseUp = function (evt) {
              evt.stop();
              lively.identity.ProfileCard.natal.pick(this);
              return true;
            };
            box.addMorph(row);
          });
          card.addMorph(box);
        },

        pick: function (row) {
          var PC = lively.identity.ProfileCard, N = lively.identity.NatalChart;
          var card = row.owner.owner, c = row._city, label = N.cityLabel(c);
          card._place = { lat: c.lat, lon: c.lon, tz: c.tz };
          card._pickedLabel = label;
          PC.natal.clearSuggestions(card);
          var inp = card.get('pcNatalPlace');
          if (inp) inp.textString = label;
          PC.natal.say(card, 'Time zone: ' + c.tz.replace(/_/g, ' '), false);
        },

        calculate: function (btn) {
          var PC = lively.identity.ProfileCard, N = lively.identity.NatalChart;
          var pane = PC.ui.paneOf(btn), card = pane && pane.get('pcNatalCard');
          if (!card) return;
          var say = function (s, e) { PC.natal.say(card, s, e); };
          var date = N.parseDate(card.get('pcNatalDate').textString);
          if (!date) return say('Enter your birth date as YYYY-MM-DD, e.g. 1990-01-20.', true);
          var time = N.parseTime(card.get('pcNatalTime').textString);
          if (time === null) return say('Enter the birth time like 19:24 or 7:24 pm, or leave it empty.', true);
          var typed = (card.get('pcNatalPlace').textString || '').trim();
          say('Calculating…', false);
          N.ensureLoaded(function (err) {
            if (err) return say(err.message, true);
            var place = card._place;
            if (!place && typed) {
              var hit = N.searchCities(typed, 5).filter(function (c) {
                return N.cityLabel(c).toLowerCase() === typed.toLowerCase();
              })[0];
              if (!hit) return say('Pick your birth place from the suggestions.', true);
              place = { lat: hit.lat, lon: hit.lon, tz: hit.tz };
            }
            var r;
            try {
              r = N.calculate({ date: date, time: time || null, place: place });
            } catch (e) { return say(e.message, true); }

            var Z = PC.ZODIAC, parts = [], open = [];
            [['Sun', 'pcSunSign', r.sun, r.sunAlt], ['Moon', 'pcMoonSign', r.moon, r.moonAlt],
             ['Rising', 'pcRisingSign', r.rising, null]].forEach(function (row) {
              var alt = row[3];
              if (alt && alt.length > 1) {
                open.push(row[0] + ' is ' + alt.map(function (i) { return Z.SIGNS[i]; }).join(' or ') +
                          ' on that day, so a birth time is needed.');
              } else if (row[2] >= 0) {
                PC.natal.setSign(pane, row[1], row[2]);
                parts.push(row[0] + ' ' + Z.GLYPHS[row[2]] + ' ' + Z.SIGNS[row[2]]);
              }
            });
            var lines = [];
            if (parts.length) lines.push('Filled in: ' + parts.join(' · ') + '. Save to keep.');
            if (r.risingAlt && r.risingAlt.length > 1) {
              lines.push('Rising is close to the edge of ' +
                r.risingAlt.map(function (i) { return Z.SIGNS[i]; }).join(' and ') +
                '; a few minutes could change it.');
            }
            lines = lines.concat(open, r.notes);
            if (parts.length) {
              // The birth details have done their job; don't leave them sitting in the
              // form. _pickedLabel = '' makes placeTyped ignore the resulting empty value.
              card._place = null; card._pickedLabel = '';
              ['pcNatalDate', 'pcNatalTime', 'pcNatalPlace'].forEach(function (n) {
                var inp = card.get(n); if (inp) inp.textString = '';
              });
            }
            say(lines.join(' '), !parts.length);
          });
        },
      },

      // hosts: hostnames (and their subdomains) used to auto-detect the
      // platform from a pasted profile link; the longest match wins, so
      // music.youtube.com resolves to ytmusic rather than youtube.
      SOCIAL_PLATFORMS: [
        { key: 'discord',    label: 'Discord',             hosts: ['discord.com', 'discord.gg'] },
        { key: 'spotify',    label: 'Spotify',             hosts: ['spotify.com'] },
        { key: 'instagram',  label: 'Instagram',           hosts: ['instagram.com'] },
        { key: 'github',     label: 'GitHub',              hosts: ['github.com'] },
        { key: 'youtube',    label: 'YouTube',             hosts: ['youtube.com', 'youtu.be'] },
        { key: 'tiktok',     label: 'TikTok',              hosts: ['tiktok.com'] },
        { key: 'twitch',     label: 'Twitch',              hosts: ['twitch.tv'] },
        { key: 'bluesky',    label: 'Bluesky',             hosts: ['bsky.app'] },
        { key: 'blacksky',   label: 'Blacksky',            hosts: ['blacksky.community'] },
        { key: 'behance',    label: 'Behance',             hosts: ['behance.net'] },
        { key: 'steam',      label: 'Steam',               hosts: ['steamcommunity.com'] },
        { key: 'cashapp',    label: 'Cash App',            hosts: ['cash.app'] },
        { key: 'pinterest',  label: 'Pinterest',           hosts: ['pinterest.com'] },
        { key: 'arena',      label: 'Are.na',              hosts: ['are.na'] },
        { key: 'goodreads',  label: 'Goodreads',           hosts: ['goodreads.com'] },
        { key: 'applemusic', label: 'Apple Music',         hosts: ['music.apple.com'] },
        { key: 'ytmusic',    label: 'YT Music',            hosts: ['music.youtube.com'] },
        { key: 'storygraph', label: 'StoryGraph',          hosts: ['thestorygraph.com'] },
        { key: 'itch',       label: 'itch.io',             hosts: ['itch.io'] },
        { key: 'psn',        label: 'PlayStation Network', hosts: ['psnprofiles.com', 'playstation.com'] },
        { key: 'mynintendo', label: 'My Nintendo',         hosts: ['nintendo.com'] },
        { key: 'xbox',       label: 'Xbox',                hosts: ['xbox.com'] },
        { key: 'epic',       label: 'Epic Games',          hosts: ['epicgames.com'] },
        { key: 'tumblr',     label: 'Tumblr',              hosts: ['tumblr.com'] },
        { key: 'threads',    label: 'Threads',             hosts: ['threads.net', 'threads.com'] },
      ],

      platformInfo: function (key) {
        var L = lively.identity.ProfileCard.SOCIAL_PLATFORMS;
        for (var i = 0; i < L.length; i++) if (L[i].key === key) return L[i];
        return null;
      },

      // Absolute path — the card is viewed at nested URLs like /@handle/obj.
      iconUrl: function (key) { return '/core/media/social-icons/' + key + '.svg'; },

      platformForUrl: function (url) {
        var m = /^(?:[a-z]+:\/\/)?([^\/?#\s]+)/i.exec(String(url || '').trim());
        if (!m) return null;
        var host = m[1].toLowerCase().replace(/^www\./, '');
        var L = lively.identity.ProfileCard.SOCIAL_PLATFORMS;
        var best = null, bestLen = 0;
        L.forEach(function (p) {
          p.hosts.forEach(function (h) {
            if ((host === h || host.slice(-(h.length + 1)) === '.' + h) && h.length > bestLen) {
              best = p.key; bestLen = h.length;
            }
          });
        });
        return best;
      },

      // "https://Alice.com/foo" -> "alice.com"; null when it isn't a plausible domain.
      normalizeDomain: function (str) {
        var d = String(str || '').trim().toLowerCase()
          .replace(/^[a-z]+:\/\//, '').replace(/[\/?#].*$/, '').replace(/^www\./, '');
        return /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(d) ? d : null;
      },

      ui: {
        // Number of lines `text` occupies when wrapped at `widthPx` the way
        // the browser wraps a pre-wrap Text morph: explicit newlines start a
        // new line, words break only at whitespace, and a word wider than the
        // line overflows rather than splitting. Measured with a canvas in the
        // same font, so it matches the DOM without needing the morph rendered.
        wrapLineCount: function (text, widthPx, fontPx, family) {
          var ctx = document.createElement('canvas').getContext('2d');
          ctx.font = fontPx + 'px ' + family;
          var total = 0;
          String(text).split('\n').forEach(function (para) {
            var lines = 1, x = 0;
            (para.match(/\S+|\s+/g) || []).forEach(function (tok) {
              var w = ctx.measureText(tok).width;
              if (/^\s/.test(tok)) { x += w; return; }   // trailing whitespace hangs
              if (x > 0 && x + w > widthPx) { lines++; x = 0; }
              x += w;
            });
            total += lines;
          });
          return total;
        },

        noDrag: function (m) {
          m.draggingEnabled = false; m.droppingEnabled = false; m.grabbingEnabled = false;
          return m;
        },

        // Owning edit pane (the morph carrying _win), whatever the nesting depth.
        paneOf: function (m) {
          while (m && !m._win) m = m.owner;
          return m || null;
        },

        // Button label colour: applyStyle({textColor}) doesn't reach a
        // Button's label DOM (CLAUDE.md), so write it directly.
        tint: function (btn, r, g, b) {
          var c = 'rgb(' + r + ',' + g + ',' + b + ')';
          var n = btn.label && btn.label.renderContext().shapeNode;
          if (!n) return;
          n.style.color = c;
          var kids = n.querySelectorAll('*');
          for (var i = 0; i < kids.length; i++) kids[i].style.color = c;
        },

        // Plain label. Default Text border is 1px black, so zero it.
        text: function (parent, str, x, y, w, h, size, r, g, b, bold) {
          var t = new lively.morphic.Text(lively.rect(x, y, w, h), str);
          lively.identity.ProfileCard.ui.noDrag(t);
          t.applyStyle({ allowInput: false, fontSize: size, fontWeight: bold ? 'bold' : 'normal',
            textColor: Color.rgb(r, g, b), fill: Color.rgba(0, 0, 0, 0),
            borderWidth: 0, borderColor: null });
          parent.addMorph(t);
          return t;
        },

        input: function (parent, name, x, y, w, value) {
          var inp = new lively.morphic.Text(lively.rect(x, y, w, 26), value || '');
          inp.name = name;
          inp.applyStyle({ allowInput: true, fontSize: 12, fill: Color.rgb(252, 252, 252),
            borderColor: Color.rgb(200, 200, 200), borderWidth: 1, borderRadius: 6 });
          inp.beInputLine();
          parent.addMorph(inp);
          return inp;
        },

        // Rounded surface for grouped content; children use card-local coords.
        card: function (parent, x, y, w, h) {
          var b = new lively.morphic.Box(lively.rect(x, y, w, h));
          lively.identity.ProfileCard.ui.noDrag(b);
          b.applyStyle({ fill: Color.rgb(248, 248, 251), borderColor: Color.rgb(225, 225, 231),
            borderWidth: 1, borderRadius: 10 });
          parent.addMorph(b);
          return b;
        },

        // Square clickable tile (platform picker / account row icon).
        chip: function (parent, x, y, size) {
          var b = new lively.morphic.Box(lively.rect(x, y, size, size));
          lively.identity.ProfileCard.ui.noDrag(b);
          b.applyStyle({ fill: Color.white, borderColor: Color.rgb(225, 225, 231),
            borderWidth: 1, borderRadius: 8, handStyle: 'pointer' });
          parent.addMorph(b);
          return b;
        },

        chipIcon: function (chip, platformKey, size) {
          var s   = size - 14;
          var img = new lively.morphic.Image(lively.rect(7, 7, s, s));
          img.setImageURL(lively.identity.ProfileCard.iconUrl(platformKey));
          img.applyStyle({ borderWidth: 0, clipMode: 'hidden' });
          lively.identity.ProfileCard.ui.noDrag(img);
          img.eventsAreIgnored = true;
          chip.addMorph(img);
          return img;
        },

        // Highlight one platform tile, update the caption.
        selectPlatform: function (pane, key) {
          var PC = lively.identity.ProfileCard;
          pane._selPlatform = key;
          pane.submorphs.forEach(function (m) {
            if (!m._platformKey) return;
            var on = m._platformKey === key;
            var border = on ? PC.PINK : Color.rgb(225, 225, 231);
            var fill   = on ? Color.rgb(255, 240, 246) : Color.white;
            m.applyStyle({ borderColor: border, fill: fill });
            // Model updates on an already-rendered morph don't always reach
            // the DOM (CLAUDE.md) — write it directly too.
            var n = m.renderContext().shapeNode;
            n.style.borderColor = border.toString();
            n.style.background  = fill.toString();
          });
          var lbl  = pane.get('pcSelPlatLbl');
          var info = PC.platformInfo(key);
          if (lbl && info) {
            lbl.setTextString(info.label);
            var n2 = lbl.renderContext().shapeNode;
            n2.style.color = 'rgb(204,0,87)';
            var kids = n2.querySelectorAll('*');
            for (var i = 0; i < kids.length; i++) kids[i].style.color = 'rgb(204,0,87)';
          }
        },

        // Material Symbols glyph as a non-interactive Text morph; see
        // _renderView's ico() for the box/padding/offset reasoning.
        icon: function (parent, name, x, y, px, r, g, b) {
          var box = px + 8;
          var m = new lively.morphic.Text(lively.rect(x - 4, y + 2, box, box), name);
          lively.identity.ProfileCard.ui.noDrag(m);
          m.applyStyle({ allowInput: false, selectable: false, clipMode: 'hidden',
            fontFamily: "'Material Symbols Rounded'", fontSize: px * 0.75, align: 'center',
            whiteSpaceHandling: 'pre', padding: lively.Rectangle.inset(0, 0, 0, 0),
            textColor: Color.rgb(r, g, b), fill: Color.rgba(0, 0, 0, 0), borderWidth: 0 });
          m.eventsAreIgnored = true;
          parent.addMorph(m);
          return m;
        },

        // Clickable icon: same recipe as the profile card's own close button.
        // Caller assigns .onMouseUp on the returned morph.
        iconBtn: function (parent, name, x, y, r, g, b, tip) {
          var m = new lively.morphic.Text(lively.rect(x, y, 22, 22), name);
          lively.identity.ProfileCard.ui.noDrag(m);
          m.applyStyle({ borderRadius: 11, borderWidth: 0, fill: Color.rgba(0, 0, 0, 0),
            fontFamily: "'Material Symbols Rounded'", fontSize: 12,
            textColor: Color.rgb(r, g, b), align: 'center',
            padding: lively.Rectangle.inset(0, 5, 0, 0),
            allowInput: false, selectable: false, clipMode: 'hidden',
            whiteSpaceHandling: 'pre', handStyle: 'pointer' });
          parent.addMorph(m);
          if (tip) m.renderContext().morphNode.title = tip;
          return m;
        },

        copyBtn: function (parent, x, y, text) {
          var m = lively.identity.ProfileCard.ui.iconBtn(parent, 'content_copy', x, y, 120, 120, 128, 'Copy');
          m._copyText = text;
          m.onMouseUp = function (evt) {
            evt.stop();
            var self = this;
            var txt  = this._copyText;
            if (!txt || !navigator.clipboard) return true;
            navigator.clipboard.writeText(txt).then(function () {
              self.setTextString('check');
              setTimeout(function () { self.setTextString('content_copy'); }, 1200);
            });
            return true;
          };
          return m;
        },

        // One "Label   value  [copy]" row inside a card. copyValue null = no copy button.
        recordRow: function (card, label, value, y, h, copyValue, cardW, size) {
          var ui = lively.identity.ProfileCard.ui;
          ui.text(card, label, 12, y + 2, 44, 18, 10, 140, 140, 148, false);
          var v = ui.text(card, value, 60, y + 1, cardW - 60 - 40, h - 2, size || 11, 30, 30, 38, false);
          v.applyStyle({ wordBreak: 'break-all', fixedWidth: true });
          if (copyValue) ui.copyBtn(card, cardW - 32, y - 1, copyValue);
        },

        // Text link (pink, pointer). Caller assigns .onMouseUp.
        link: function (parent, str, x, y, w) {
          var t = lively.identity.ProfileCard.ui.text(parent, str, x, y, w, 18, 10, 204, 0, 87, false);
          t.applyStyle({ handStyle: 'pointer' });
          return t;
        },

        // Inline status line under a control; replaces alert().
        setMsg: function (pane, name, str, isError) {
          var m = pane.get(name);
          if (!m) return;
          m.setTextString(str);
          var c = isError ? 'rgb(200,40,40)' : 'rgb(140,140,148)';
          var n = m.renderContext().shapeNode;
          n.style.color = c;
          var kids = n.querySelectorAll('*');
          for (var i = 0; i < kids.length; i++) kids[i].style.color = c;
        },

        // Pill button; fn is stored as _onClick and must be self-contained.
        pill: function (parent, label, x, y, w, h, primary, fn) {
          var PC = lively.identity.ProfileCard;
          var b  = new lively.morphic.Button(lively.rect(x, y, w, h), label);
          b.applyStyle({
            fill:        primary ? PC.PINK : Color.white,
            borderColor: primary ? PC.PINK : Color.rgb(222, 222, 228),
            borderRadius: h / 2, fontSize: 11, borderWidth: 1,
            textColor:   primary ? Color.white : Color.rgb(90, 90, 98),
          });
          b.setAppearanceStylingMode(false);
          b.setBorderStylingMode(false);
          b._idleLabel = label;
          b._onClick = fn;
          b.addScript(function doAction() { this._onClick(); });
          lively.bindings.connect(b, 'fire', b, 'doAction');
          parent.addMorph(b);
          if (primary) PC.ui.tint(b, 255, 255, 255); else PC.ui.tint(b, 90, 90, 98);
          return b;
        },

        // Ask the server to verify btn._domain (or the pending one); shows
        // progress/errors on the pane's 'pcDomainMsg' line, and on success
        // reloads the Domain Handle tab.
        runVerify: function (btn) {
          var PC   = lively.identity.ProfileCard;
          var pane = PC.ui.paneOf(btn);
          var win  = pane && pane._win;
          var dom  = btn._domain || (win && win._pendingDomain);
          if (!win || !dom) return;
          var tint = btn._idleLabel === 'Verify' ? [255, 255, 255] : [90, 90, 98];
          btn.setLabel('Checking…');
          btn.setActive(false);
          PC.ui.setMsg(pane, 'pcDomainMsg', 'Checking ' + dom + '…', false);
          lively.identity.userSpace.verifyDomain(dom, function (err) {
            if (err) {
              btn.setLabel(btn._idleLabel);
              btn.setActive(true);
              PC.ui.tint(btn, tint[0], tint[1], tint[2]);
              return PC.ui.setMsg(pane, 'pcDomainMsg', err.message, true);
            }
            lively.identity.userSpace.listDomains(win._handle, function (err2, rows) {
              win._domains       = rows || [];
              win._pendingDomain = null;
              win._renderEdit(win._handle, win._editPayload, win._currentDid, 'domains');
            });
          });
        },
      },
    });

  }); // end module('lively.identity.ProfileCard')
