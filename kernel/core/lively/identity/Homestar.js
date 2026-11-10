/**
 * lively.identity.Homestar
 *
 * A handle's home page, served by GET /@:handle (buildHomestarPage in
 * IdentityServer.js): what a new user lands on after registering, what a
 * shared profile link opens, and what the profile card's Enter button goes to.
 *
 * Like the constellation lounge it is a Lively world whose whole UI is morphs
 * (Box / Text / Image added to $world), created fresh on every page load — it
 * is not a saved world object, and every visitor gets the same fixed layout.
 * Everything is rebuilt from current state by _render(), which runs on load,
 * whenever a fetch lands, and (debounced) on window resize.
 *
 * So far: identity header, an orbit panel, the postcard reel (PostcardReel.js),
 * a worlds panel and a map of the located postcards (HomestarMap.js), each with
 * its empty state. Audience control and the
 * remaining widgets are separate steps (homestar.md §8).
 *
 * Open: lively.identity.Homestar.open(data) — buildHomestarPage's onStartWorld
 * hook passes the JSON it embedded: { handle, displayHandle, did, viewer,
 * isOwner, profile }.
 *
 * Handlers below are plain assignments / closures inside an Object.subclass, not
 * BuildSpec or addScript, so module-level helpers are safe to reference.
 */

module("lively.identity.Homestar")
  .requires(
    "lively.identity.DID",
    "lively.identity.PostCardUtils",
    "lively.identity.HomestarUI",
    "lively.identity.PostcardReel",
    "lively.identity.HomestarMap",
    "lively.identity.HomestarShelves",
    "lively.identity.HomestarBadges",
    "lively.identity.BadgePicker",
    "lively.identity.BadgesDialog",
    "lively.transit.TransitClient",
    "lively.identity.PostcardAudience",
    "lively.identity.BannerLines",
    "lively.morphic.Complete",
  )
  .toRun(function () {

    var UI = lively.identity.HomestarUI;
    var PINK = UI.PINK, PINK_SOFT = UI.PINK_SOFT, PAGE_FILL = UI.PAGE_FILL;
    var CARD_BORDER = UI.CARD_BORDER, INK = UI.INK, MUTED = UI.MUTED;
    var noDrag = UI.noDrag, trunc = UI.trunc, textW = UI.textW;
    var label = UI.label, icon = UI.icon, panel = UI.panel, pill = UI.pill;

    var TOP = 64;                  // clears the menu bar
    var PAD = 24;                  // page side margin, and hero inner margin
    var MAX_W = 1240;
    var GAP = 20;
    var LEFT_W = 290, RIGHT_W = 310;
    var WIDE_MIN = 1100;           // content width needed for three columns
    var BANNER_H = 168, AVATAR = 108;
    var TEXT_X = PAD + AVATAR + 20;   // hero text column, right of the avatar
    var BIO_LINE_H = 21, BIO_MAX_LINES = 3;
    var TRANSIT_REFRESH_MS = 60 * 1000;   // matches how long the transit proxy keeps an answer

    var SIGNS  = ["Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo",
                  "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces"];
    var GLYPHS = ["♈︎", "♉︎", "♊︎", "♋︎", "♌︎", "♍︎", "♎︎", "♏︎", "♐︎", "♑︎", "♒︎", "♓︎"];

    // Safe to use as a CSS url() / <img>: http(s) or a same-site path.
    function safeUrl(u) {
      u = String(u || "").trim();
      return /^(https?:\/\/|\/(?!\/))/i.test(u) ? u : null;
    }

    // The orbit's slow drift: each ring turns one way, its satellites turn back so
    // faces stay upright. A CSS animation on the morph's own node, as the postcard
    // reel's turn does. The negative delay keeps the phase across the page's
    // frequent re-renders (they rebuild the morphs), so the rings never jump back.
    var OUTER_SECONDS = 240, INNER_SECONDS = 160;

    function ensureOrbitStyle() {
      if (document.getElementById("homestar-orbit-style")) return;
      var s = document.createElement("style");
      s.id = "homestar-orbit-style";
      s.textContent = "@keyframes homestar-orbit-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}" +
        "@media (prefers-reduced-motion: reduce){.homestar-orbit-spin{animation:none!important}}";
      document.head.appendChild(s);
    }

    function spinNode(morph, seconds, reverse, t0, now) {
      var node = morph.renderContext().shapeNode;
      var delay = -(((now - t0) / 1000) % seconds);
      node.classList.add("homestar-orbit-spin");
      node.style.animation = "homestar-orbit-spin " + seconds + "s linear " + delay.toFixed(2) + "s infinite " +
        (reverse ? "reverse" : "normal");
    }

    function chip(x, y, text, opts) {
      opts = opts || {};
      var px = 12;
      var w = textW(text, px, false) + 24, h = 24;
      var box = new lively.morphic.Box(lively.rect(x, y, w, h));
      box.applyStyle({ fill: opts.fill || PINK_SOFT, borderRadius: h / 2, borderWidth: 0, clipMode: "hidden" });
      noDrag(box);
      box.addMorph(label(lively.rect(0, 1, w, 20), text, { px: px, color: opts.color || PINK, align: "center" }));
      if (opts.onClick) {
        box.applyStyle({ handStyle: "pointer" });
        box.onMouseUp = function (evt) { evt.stop(); opts.onClick(); return true; };
      }
      return {morph: box, w: w, h: h};
    }

    var getJSON = UI.getJSON;

    Object.subclass("lively.identity.HomestarController",
    "init", {
      initialize: function (data) {
        this._data = data;
        this._handle = data.handle;
        this._shown = data.displayHandle || data.handle;
        this._did = data.did;
        this._viewer = data.viewer || null;
        this._isOwner = !!data.isOwner;
        this._profile = data.profile || {};

        this._morphs = [];        // top-level page morphs, replaced wholesale by _render()
        this._friendStatus = null;  // null = not loaded / not applicable
        this._orbit = null;         // null = loading
        this._worlds = null;        // null = loading; else the featured worlds this viewer may open, in order
        this._visibleWorlds = null; // every world this viewer may open (GET /worlds)
        this._constellations = null; // null = loading, failed or locked; else GET /constellations/public rows
        this._constellationsInfo = null; // the owner's own view of it: { hiddenCount, visibility }
        this._wikiPages = null;     // null = loading, failed or locked; else GET /wiki-card rows
        this._wikiInfo = null;      // the owner's own view of it: { hiddenCount, visibility }
        this._badges = null;        // null = loading or failed; else the badges this viewer may see (GET /badges), place first
        this._transit = null;       // null = loading, failed or locked; else { station, visibility, times }
        this._transitTimer = null;  // refreshes the times while the page is open
        this._gbObjId = null;       // the profile object's id: the guestbook is comments on it
        this._gbEntries = null;     // null = loading or unreadable; else the comments, newest first
        this._shelfBooks = [];      // the Books world's books, reading first (HomestarShelves.loadBooks)
        this._shelfRecord = null;   // {album, spinning} from the Music world, or null
        this._shelfWorlds = {};     // { books, music }: the worlds those came from, as /worlds lists them
        this._avatarUrls = {};      // orbit member did -> avatar url, or null when they have none
        this._avatarLoading = {};
        this._orbitT0 = null;       // when the rings started turning
        this._renderTimer = null;
      },
    },

    "boot", {
      start: function () {
        var staticEl = document.getElementById("homestar-static");
        if (staticEl) staticEl.remove();
        var loader = document.getElementById("homestar-loader");
        if (loader) loader.remove();

        // Reserve the scrollbar's width up front so the world's width (taken from
        // clientWidth) doesn't shift when the page grows taller than the window.
        document.documentElement.style.overflowY = "scroll";
        $world.setFill(PAGE_FILL);

        this._render();
        this._load();
        this._installMenuBarEntry();
        window.addEventListener("resize", this._onResize.bind(this));
      },

      _load: function () {
        var self = this;
        var base = "/@" + encodeURIComponent(this._handle);

        getJSON(base + "/orbit", function (err, body) {
          self._orbit = body || { locked: false, members: [], pinned: [], failed: true };
          self._scheduleRender();
        });
        getJSON(base + "/worlds", function (err, body) {
          var worlds = (body && body.worlds) || [];
          self._visibleWorlds = worlds;
          self._worlds = self._featuredWorlds(worlds);
          self._scheduleRender();
          self._loadShelf(worlds);
        });
        this._loadGuestbook();
        this._loadConstellations();
        this._loadTransit();
        this._loadBadges();
        this._loadWiki();
        if (this._viewer && !this._isOwner) {
          getJSON(base + "/friend-status", function (err, body) {
            self._friendStatus = (body && body.status) || "none";
            self._scheduleRender();
          });
        }
      },

      // The constellations card's rows. A failed load leaves the card out (null), and a
      // viewer the owner has locked out gets no card either.
      _loadConstellations: function () {
        var self = this;
        getJSON("/@" + encodeURIComponent(this._handle) + "/constellations/public", function (err, body) {
          var ok = body && Array.isArray(body.constellations);
          self._constellations = ok && !body.locked ? body.constellations : null;
          self._constellationsInfo = ok ? { hiddenCount: body.hiddenCount || 0, visibility: body.visibility || null } : null;
          self._scheduleRender();
        });
      },

      // The badge row. The server filters each badge for this viewer (and reads the old
      // public profile location through as a place badge), so whatever comes back is
      // drawn as is. A failed read leaves the row out.
      _loadBadges: function () {
        var self = this;
        getJSON("/@" + encodeURIComponent(this._handle) + "/badges", function (err, body) {
          self._badges = body && Array.isArray(body.badges) ? body.badges : null;
          self._scheduleRender();
        });
      },

      // Removes one badge for the owner (the remove button on a badge). A real badge is
      // dropped from state.badges through patchSettings, which re-reads the stored copy first
      // so another tab's change is not overwritten. The synthetic place (id "_legacy") is not
      // in state.badges at all: it is the old public profile.location, so removing it clears
      // that. Removing ANY place also clears a leftover profile.location, or the fallback
      // would bring the old value straight back as a public place. Then the row is re-read.
      _removeBadge: function (b) {
        var self = this;
        if (this._badgeBusy) return;
        this._badgeBusy = true;
        var finish = function (err, what) {
          self._badgeBusy = false;
          if (err) $world.alert(what + ((err && err.message) || err));
          self._loadBadges();
        };
        var clearOldLocation = function (thenDo) {
          var loc = String(self._profile.location || "").trim();
          if (b.kind !== "place" || !loc) return thenDo(null);
          lively.require("lively.identity.UserSpace").toRun(function () {
            lively.identity.userSpace.saveProfile({ location: "" }, function (err) {
              if (!err) self._profile.location = "";
              thenDo(err);
            });
          });
        };
        if (b.id === "_legacy") {
          return clearOldLocation(function (err) { finish(err, "Could not remove your place: "); });
        }
        lively.identity.postcardAudience.patchSettings(function (state) {
          state.badges = (state.badges || []).filter(function (x) { return x.id !== b.id; });
        }, function (err) {
          if (err) return finish(err, "Could not remove the badge: ");
          clearOldLocation(function (err2) { finish(err2, "The badge was removed, but your old public location could not be cleared: "); });
        });
      },

      // The wiki card's pages (the owner's choice of who sees the card and which pages it lists
      // is applied by the server). A failed or locked read leaves the card out.
      _loadWiki: function () {
        var self = this;
        getJSON("/@" + encodeURIComponent(this._handle) + "/wiki-card", function (err, body) {
          var ok = body && Array.isArray(body.pages);
          self._wikiPages = ok && !body.locked ? body.pages : null;
          self._wikiInfo = ok ? { hiddenCount: body.hiddenCount || 0, visibility: body.visibility || null } : null;
          self._scheduleRender();
        });
      },

      // The Transit card: the owner's BART station (a private setting the server only
      // sends to a viewer it lets in), then the next trains there. times is null while
      // the first read is on its way, false when live times could not be had, else the
      // predictions. A failed or locked read leaves the card out (null).
      _loadTransit: function () {
        var self = this;
        clearInterval(this._transitTimer);
        this._transitTimer = null;
        getJSON("/@" + encodeURIComponent(this._handle) + "/transit", function (err, body) {
          if (!body || body.locked) { self._transit = null; return self._scheduleRender(); }
          self._transit = { station: body.station || null, visibility: body.visibility || null, times: null };
          self._scheduleRender();
          if (!self._transit.station) return;
          self._refreshTransit();
          self._transitTimer = setInterval(function () { if (!document.hidden) self._refreshTransit(); }, TRANSIT_REFRESH_MS);
        });
      },

      _refreshTransit: function () {
        var self = this;
        var t = this._transit;
        if (!t || !t.station) return;
        lively.transit.TransitClient.stopMonitoring(t.station, function (err, res) {
          // The station may have been changed while this was on its way.
          if (self._transit !== t) return;
          // Made-up times are labelled as such on the transit map, but this page is a
          // public one: show none rather than numbers that are not real.
          t.times = err || !res || res.simulated ? false : res.predictions;
          self._scheduleRender();
        });
      },

      // The guestbook: comments on the profile object. The object id comes from the profile
      // envelope; the entries are only read when it is known, and a failed read leaves the
      // card out rather than showing an empty one.
      _loadGuestbook: function () {
        var self = this;
        var base = "/@" + encodeURIComponent(this._handle);
        var read = function () {
          getJSON(base + "/" + encodeURIComponent(self._gbObjId) + "/comments?limit=20", function (err, body) {
            self._gbEntries = body && Array.isArray(body.comments) ? body.comments : null;
            if (self._gbEntries) self._loadOrbitAvatars(self._gbEntries.slice(0, 3).filter(function (e) { return e.handle; }));
            self._scheduleRender();
          });
        };
        if (this._gbObjId) return read();
        getJSON(base + "/profile", function (err, env) {
          if (!env || !env.objId) return;
          self._gbObjId = env.objId;
          read();
        });
      },

      // The books and the record for the "On the shelf" card, read from the account's
      // Books and Music worlds (the first of each the viewer may open).
      _loadShelf: function (worlds) {
        var self = this;
        var S = lively.identity.HomestarShelves;
        var bw = worlds.filter(function (w) { return w.template === "books"; })[0] || null;
        var mw = worlds.filter(function (w) { return w.template === "music"; })[0] || null;
        this._shelfWorlds = { books: bw, music: mw };
        S.loadBooks(this._handle, this._did, bw, function (books) {
          self._shelfBooks = books;
          self._scheduleRender();
        });
        S.loadAlbum(this._handle, this._did, mw, this._isOwner, function (rec) {
          self._shelfRecord = rec;
          self._scheduleRender();
        });
      },

      // The worlds the page lists: the profile's featured ones, in that order,
      // limited to what /worlds says this viewer may open. Accounts from before
      // featured worlds existed have none recorded, so they get their oldest
      // world (the one the old landing page used to open).
      _featuredWorlds: function (visibleWorlds) {
        var hs = this._profile.homestar || {};
        var ids = hs.featuredWorlds;
        if (!Array.isArray(ids)) return visibleWorlds.slice(0, 1);
        var byId = {};
        visibleWorlds.forEach(function (w) { byId[w.objId] = w; });
        return ids.map(function (id) { return byId[id]; }).filter(Boolean);
      },

      // Re-reads the profile after the profile card edited it, then redraws.
      _refreshProfile: function () {
        var self = this;
        getJSON("/@" + encodeURIComponent(this._handle) + "/profile", function (err, env) {
          var p = env && env.record && env.record.payload;
          if (!p) return;
          self._profile = p;
          // The featured list may have changed with it.
          if (self._visibleWorlds) self._worlds = self._featuredWorlds(self._visibleWorlds);
          self._scheduleRender();
        });
      },

      _installMenuBarEntry: function () {
        var self = this;
        var attempts = 0;
        (function tryInstall() {
          var menuBar = typeof $world !== "undefined" && $world && $world.get(/^MenuBar/);
          var entry = menuBar && (menuBar.submorphs || []).find(function (m) { return m.name === "WorldNameMenuBarEntry"; });
          if (entry) return self._patchMenuBarEntry(entry);
          if (++attempts > 25) return;
          setTimeout(tryInstall, 200);
        })();
      },

      // The entry normally names the current saved world and opens its
      // save/rename menu; this page is neither, so it names the page instead.
      _patchMenuBarEntry: function (entry) {
        var self = this;
        var name = this._atName();
        entry.currentWorldDisplayName = function () { return name; };
        entry.toolTip = name + "'s homestar";
        entry.onMouseUp = function (evt) {
          var pos = entry.worldPoint(lively.pt(0, entry.getExtent().y));
          lively.morphic.Menu.openAt(pos, name, [
            ["Copy link", function () { self._copyLink(); }],
          ]);
          evt.stop();
          return true;
        };
        entry.update();
      },

      // A local identity (the keo app, no host) has no handle: its "handle" is its DID and its name is the label the person gave it,
      // so there is nothing to put an "@" in front of. A handle assigned by a host is shown as @handle, as before.
      _isLocalId: function () { return /^did:/.test(String(this._handle)); },

      // How the page names its owner in running text and in the menu bar.
      _atName: function () { return this._isLocalId() ? this._shown : "@" + this._shown; },

      // The line under the name in the header: @handle, or for a local identity the short form of its DID (the label is the name
      // above it already).
      _subName: function () {
        if (!this._isLocalId()) return "@" + this._shown;
        var li = lively.identity.localIdentity;
        return li && li.shortDid ? li.shortDid(this._did) : String(this._did);
      },

      _copyLink: function () {
        var url = lively.identity.did.baseUrl() + "/@" + encodeURIComponent(this._shown);
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).catch(function () { window.prompt("Copy this link:", url); });
        } else {
          window.prompt("Copy this link:", url);
        }
      },
    },

    "render", {
      _scheduleRender: function () {
        var self = this;
        if (this._renderTimer) return;
        this._renderTimer = setTimeout(function () { self._renderTimer = null; self._render(); }, 30);
      },

      _onResize: function () {
        lively.lang.fun.debounceNamed("homestar-resize-" + this._handle, 150, this._render.bind(this))();
      },

      // Adds one rebuilt page morph (a card, the hero, a shelf) to the world,
      // BEHIND everything else already there. _render() removes and re-adds every
      // page morph on each run (load, resize, any async data arriving), and a plain
      // addMorph appends to the top of the z-order, so a window opened earlier
      // (My worlds, a chat, a dialog) ended up underneath the new cards on the next
      // render. The page is the backdrop; windows and dialogs belong above it.
      // Call it only for page morphs built by _render(); a morph that should float
      // over the page (a popup, a dialog) must use addMorph / openInWorld instead.
      // The page morphs never overlap each other, so their order among themselves
      // does not matter.
      _add: function (m) {
        $world.addMorphBack(m);
        this._morphs.push(m);
        return m;
      },

      _render: function () {
        this._morphs.forEach(function (m) { m.remove(); });
        this._morphs = [];

        var W = document.documentElement.clientWidth - 1;
        var contentW = Math.min(W - PAD * 2, MAX_W);
        var x0 = Math.round((W - contentW) / 2);
        var wide = contentW >= WIDE_MIN;

        var y = TOP;
        y = this._buildHero(x0, y, contentW) + GAP;

        var bottom;
        if (wide) {
          var centerX = x0 + LEFT_W + GAP;
          var centerW = contentW - LEFT_W - RIGHT_W - GAP * 2;
          var leftBottom = this._buildOrbit(x0, y, LEFT_W);
          leftBottom = this._buildConstellations(x0, leftBottom + GAP, LEFT_W);
          var centerBottom = this._buildPostcards(centerX, y, centerW);
          var rightBottom = this._buildWorlds(x0 + contentW - RIGHT_W, y, RIGHT_W);
          rightBottom = this._buildMap(x0 + contentW - RIGHT_W, rightBottom + GAP, RIGHT_W);
          bottom = Math.max(leftBottom, centerBottom, rightBottom);
        } else {
          // One column: the postcards first, then worlds, the map, then orbit.
          y = this._buildPostcards(x0, y, contentW) + GAP;
          y = this._buildWorlds(x0, y, contentW) + GAP;
          y = this._buildMap(x0, y, contentW) + GAP;
          bottom = this._buildOrbit(x0, y, contentW);
          bottom = this._buildConstellations(x0, bottom + GAP, contentW);
        }

        bottom = this._buildShelves(x0, bottom + GAP, contentW);

        // Taller than the window: grow the world so the page scrolls.
        var H = Math.max(window.innerHeight, bottom + 40);
        $world.setExtent(lively.pt(W, H));
      },
    },

    "hero", {
      _buildHero: function (x, y, w) {
        var self = this;
        var p = this._profile;
        var name = p.displayName || this._shown;

        // Actions are laid out first because their width decides how much room
        // the name has; on a narrow hero they drop below the chips instead.
        var actions = this._buildActions();
        var actionsW = actions.reduce(function (s, a) { return s + a.getExtent().x + 10; }, 0);
        var actionsBeside = w - TEXT_X - PAD - actionsW > 220;

        var hero = panel(lively.rect(x, y, w, 300));
        hero.applyStyle({ borderRadius: 18 });
        this._add(hero);

        // Same banner and avatar defaults as the profile card (ProfileCard.js): a
        // contour-map banner seeded by the handle when there is no banner image, and
        // the handle-seeded blockie when there is no avatar image. A banner image
        // is cover-fitted (the card stretches it, which distorts it at this width).
        var banner = new lively.morphic.Box(lively.rect(0, 0, w, BANNER_H));
        banner.applyStyle({ fill: null, borderWidth: 0 });
        noDrag(banner);
        banner.eventsAreIgnored = true;
        hero.addMorph(banner);
        var bannerUrl = safeUrl(p.bannerUrl);
        if (bannerUrl) {
          banner.renderContext().shapeNode.style.background = "center / cover no-repeat url(" + JSON.stringify(bannerUrl) + ")";
        } else {
          lively.identity.bannerLines.applyBannerBackground(banner, this._handle);
        }

        var avatar = new lively.morphic.Image(lively.rect(PAD, BANNER_H - AVATAR / 2, AVATAR, AVATAR));
        avatar.setImageURL(safeUrl(p.avatarUrl) || lively.identity.postCardUtils.identiconDataUrl(this._handle, AVATAR));
        avatar.applyStyle({ borderRadius: AVATAR / 2, borderWidth: 4, borderColor: Color.white, clipMode: "hidden" });
        noDrag(avatar);
        avatar.eventsAreIgnored = true;
        hero.addMorph(avatar);

        // The owner's ghost "Manage badges" button, top-right over the banner. Shown once the
        // dialog exists (BadgesDialog.js); until then there is nothing for it to open.
        var Manage = lively.identity.BadgesDialog;
        if (this._isOwner && Manage && Manage.open) {
          try {
            lively.identity.HomestarBadges.manageButton(hero, 24, 20, function () {
              Manage.open({
                handle: self._handle, badges: self._badges || [],
                // saving makes the dialog clear the old public profile.location; keep our copy in step
                oldLocation: self._profile && self._profile.location,
                onSave: function (info) {
                  if (info && info.locationCleared && self._profile) self._profile.location = "";
                  self._loadBadges();
                },
              });
            });
          } catch (e) { console.error("[Homestar] manage button failed:", e); }
        }

        var textTop = BANNER_H + 10;
        var nameW = actionsBeside ? w - TEXT_X - PAD - actionsW - 12 : w - TEXT_X - PAD;
        var shownName = trunc(name, 40);
        hero.addMorph(label(lively.rect(TEXT_X, textTop, nameW, 34), shownName, { px: 26, bold: true }));

        var sub = this._subName() + (p.pronouns ? "  ·  " + trunc(p.pronouns, 24) : "");
        hero.addMorph(label(lively.rect(TEXT_X, textTop + 36, nameW, 22), sub, { px: 14, color: MUTED }));

        var cy = textTop + 66;
        var bio = String(p.bio || "").trim();
        if (bio) {
          var bioW = w - TEXT_X - PAD;
          var cap = BIO_MAX_LINES * Math.max(20, Math.floor(bioW / 7.6));
          hero.addMorph(label(lively.rect(TEXT_X, cy, bioW, BIO_LINE_H * BIO_MAX_LINES + 6), trunc(bio, cap),
            { px: 14, color: Color.rgb(91, 84, 112), wrap: true }));
          cy += BIO_LINE_H * Math.min(BIO_MAX_LINES, Math.max(1, Math.ceil(Math.min(bio.length, cap) / Math.max(20, Math.floor(bioW / 7.6))))) + 12;
        }

        // The badge row (place, transit, school, library, teams) sits between the bio and
        // the chips. The server has already dropped the badges this viewer may not see.
        // A failure drawing it must not take the rest of the page down with it.
        try {
          var rowOpts = { onFontReady: function () { self._scheduleRender(); } };
          if (this._isOwner) {
            rowOpts.onRemove = function (b) { self._removeBadge(b); };
            // The "Add badge" pill appears once the picker exists (BadgePicker.js).
            var Picker = lively.identity.BadgePicker;
            if (Picker && Picker.open) {
              rowOpts.onAdd = function () {
                Picker.open({
                  handle: self._handle, badges: self._badges || [],
                  // a saved place makes the picker clear the old public profile.location; keep our copy in step
                  oldLocation: self._profile && self._profile.location,
                  onSave: function (info) {
                    if (info && info.locationCleared && self._profile) self._profile.location = "";
                    self._loadBadges();
                  },
                });
              };
            }
          }
          var badgesBottom = lively.identity.HomestarBadges.buildRow(hero, TEXT_X, cy, w - TEXT_X - PAD, this._badges, rowOpts);
          if (badgesBottom > cy) cy = badgesBottom + 12;
        } catch (e) {
          console.error("[Homestar] badge row failed:", e);
        }

        cy = this._buildChips(hero, TEXT_X, cy, w - TEXT_X - PAD);

        // Action pills.
        if (actionsBeside) {
          var ax = w - PAD;
          actions.slice().reverse().forEach(function (a) {
            ax -= a.getExtent().x;
            a.setPosition(lively.pt(ax, textTop + 2));
            hero.addMorph(a);
            ax -= 10;
          });
        } else {
          var bx = TEXT_X;
          actions.forEach(function (a) {
            a.setPosition(lively.pt(bx, cy));
            hero.addMorph(a);
            bx += a.getExtent().x + 10;
          });
          cy += 40;
        }

        var heroH = Math.max(cy + 12, BANNER_H + AVATAR / 2 + 20);
        hero.setExtent(lively.pt(w, heroH));
        return y + heroH;
      },

      // Sun/moon/rising and status, then up to five links; flows onto further
      // rows when they don't fit. Returns the y below the last row.
      _buildChips: function (hero, x, y, maxW) {
        var p = this._profile;
        var items = [];
        var st = p.orbit && p.orbit.status;
        if (st && st.label) items.push({ text: (st.emoji ? st.emoji + " " : "") + trunc(st.label, 16) });
        [["☉", p.sunSign], ["☽", p.moonSign], ["↑", p.risingSign]].forEach(function (pair) {
          var i = SIGNS.indexOf(pair[1]);
          if (i >= 0) items.push({ text: pair[0] + " " + GLYPHS[i] + " " + SIGNS[i] });
        });
        (p.links || []).slice(0, 5).forEach(function (l) {
          var url = l && safeUrl(l.url);
          if (!url) return;
          items.push({
            text: "↗ " + trunc(l.label || url.replace(/^https?:\/\/(www\.)?/i, ""), 28),
            onClick: function () { window.open(url, "_blank", "noopener"); },
          });
        });
        if (!items.length) return y;

        var cx = x, rowY = y;
        items.forEach(function (it) {
          var c = chip(cx, rowY, it.text, { onClick: it.onClick });
          if (cx > x && cx + c.w > x + maxW) {
            cx = x; rowY += 30;
            c.morph.setPosition(lively.pt(cx, rowY));
          }
          hero.addMorph(c.morph);
          cx += c.w + 8;
        });
        return rowY + 30;
      },

      // The viewer-dependent pills. Built unpositioned; _buildHero places them.
      _buildActions: function () {
        var self = this;
        var out = [];
        var handle = this._handle;

        if (this._isOwner) {
          out.push(pill(0, 0, "Edit profile", { primary: true, onClick: function () { self._openProfileCard(); } }));
          return out;
        }

        out.push(pill(0, 0, "Profile", { onClick: function () { self._openProfileCard(); } }));

        if (!this._viewer) {
          out.unshift(pill(0, 0, "Sign in to say hi", { primary: true, onClick: function () { self._openLogin(); } }));
          return out;
        }

        var st = this._friendStatus;
        if (st === "friends") {
          out.unshift(pill(0, 0, "Message", { primary: true, onClick: function () { self._openDM(); } }));
        } else if (st === "none") {
          out.unshift(pill(0, 0, "Add friend", { primary: true, onClick: function () { self._sendFriendRequest(); } }));
        } else if (st === "pending-outgoing") {
          out.unshift(pill(0, 0, "Request sent", { disabled: true }));
        } else if (st === "pending-incoming") {
          out.unshift(pill(0, 0, "Accept friend request", { primary: true, onClick: function () { self._approveFriendRequest(); } }));
        }
        return out;
      },
    },

    "orbit", {
      _buildOrbit: function (x, y, w) {
        var self = this;
        var box = panel(lively.rect(x, y, w, 140));
        box.applyStyle({ fill: Color.rgb(249, 246, 253), borderColor: Color.rgb(232, 224, 244) });
        this._add(box);
        box.addMorph(icon(lively.rect(16, 14, 22, 22), "group", 18, PINK));
        box.addMorph(label(lively.rect(44, 14, w - 60 - 80, 22), "Orbit", { px: 15, bold: true }));

        var o = this._orbit;
        var canManage = this._isOwner && o && !o.failed && !o.locked;
        if (canManage) {
          var manage = pill(0, 0, "Manage", { w: 72, h: 26, onClick: function () { self._openOrbitDialog(); } });
          manage.setPosition(lively.pt(w - 16 - 72, 11));
          box.addMorph(manage);
        }

        var bodyY = 46, bodyH = 40, text;
        if (!o) {
          text = "Loading…";
        } else if (o.failed) {
          text = "Could not load the orbit.";
        } else if (o.locked) {
          text = this._atName() + " keeps their orbit " + (o.visibility === "friends" ? "for friends." : "private.");
        } else if (!o.members.length) {
          text = this._isOwner ? "Your orbit is empty. Add the friends you are closest to." : "Nobody in orbit yet.";
        }

        if (text) {
          box.addMorph(label(lively.rect(16, bodyY, w - 32, bodyH), text, { px: 13, color: MUTED, wrap: true }));
          var h0 = bodyY + bodyH + 14;
          if (canManage && !o.members.length) {
            var add = pill(0, 0, "Add close friends", { primary: true, onClick: function () { self._openOrbitDialog(); } });
            add.setPosition(lively.pt(16, bodyY + bodyH));
            box.addMorph(add);
            h0 = bodyY + bodyH + 30 + 16;
          }
          box.setExtent(lively.pt(w, h0));
          return y + h0;
        }

        // Rings: the owner at the core, pinned friends on the inner ring, the rest
        // on the outer one. Positions are worked out here and baked into each
        // morph's rect.
        var S = Math.min(w - 32, 300);
        var ringX = Math.round((w - S) / 2), ringTop = 38;
        var cx = ringX + S / 2, cy = ringTop + S / 2;
        var Ro = S / 2 - 20, Ri = Math.round(Ro * 0.52);
        var RING_LINE = Color.rgb(224, 214, 240);
        // Each ring is a box the size of its circle that holds its satellites, so one
        // CSS rotation on it carries them round; the satellites turn back the other
        // way, which keeps each face upright. Positions are relative to the ring.
        function makeRing(r) {
          var ring = new lively.morphic.Box(lively.rect(cx - r, cy - r, r * 2, r * 2));
          ring.applyStyle({ fill: null, borderWidth: 1.5, borderColor: RING_LINE, borderRadius: r, clipMode: "visible" });
          noDrag(ring);
          ring.eventsAreIgnored = true;
          box.addMorph(ring);
          return ring;
        }
        var outerRing = makeRing(Ro), innerRing = makeRing(Ri);
        ensureOrbitStyle();
        if (!this._orbitT0) this._orbitT0 = Date.now();
        var t0 = this._orbitT0, now = Date.now();   // one clock reading, so a ring and its satellites stay in step
        spinNode(outerRing, OUTER_SECONDS, false, t0, now);
        spinNode(innerRing, INNER_SECONDS, true, t0, now);

        var p = this._profile;
        var CORE = 52;
        var core = new lively.morphic.Image(lively.rect(cx - CORE / 2, cy - CORE / 2, CORE, CORE));
        core.setImageURL(safeUrl(p.avatarUrl) || lively.identity.postCardUtils.identiconDataUrl(this._handle, CORE));
        core.applyStyle({ borderRadius: CORE / 2, borderWidth: 3, borderColor: Color.white, clipMode: "hidden" });
        noDrag(core);
        core.eventsAreIgnored = true;
        box.addMorph(core);

        var pinned = o.pinned || [];
        var inner = o.members.filter(function (m) { return pinned.indexOf(m.did) >= 0; });
        var outerAll = o.members.filter(function (m) { return pinned.indexOf(m.did) < 0; });
        var OUTER_MAX = 10;
        var outer = outerAll.slice(0, OUTER_MAX);

        function satellite(ring, seconds, reverse, m, r, D, pinnedRing, angle) {
          var ax = Math.round(r + r * Math.cos(angle) - D / 2), ay = Math.round(r + r * Math.sin(angle) - D / 2);
          var img = new lively.morphic.Image(lively.rect(ax, ay, D, D));
          img.setImageURL(self._avatarFor(m, D));
          img.applyStyle({
            borderRadius: D / 2, clipMode: "hidden", handStyle: "pointer",
            borderWidth: 2, borderColor: pinnedRing ? PINK : Color.white,
          });
          noDrag(img);
          if (m.handle) {
            img.toolTip = "@" + m.handle;
            img.onMouseUp = function (evt) {
              evt.stop();
              // The satellite is moving, so anchor the popover to where it is on screen
              // now, in page coordinates (which are world coordinates).
              var rect = img.renderContext().shapeNode.getBoundingClientRect();
              var at = lively.pt(rect.left + (window.pageXOffset || 0), rect.bottom + (window.pageYOffset || 0));
              lively.require("lively.identity.MiniProfileCard").toRun(function () {
                lively.identity.MiniProfileCard.open(m.handle, m.did, at);
              });
              return true;
            };
          }
          ring.addMorph(img);
          spinNode(img, seconds, !reverse, t0, now);
          if (self._avatarUrls[m.did]) self._fallBackOnError(img, m, D);
        }
        inner.forEach(function (m, i) {
          satellite(innerRing, INNER_SECONDS, true, m, Ri, 40, true, -Math.PI / 2 + (i * 2 * Math.PI) / inner.length);
        });
        outer.forEach(function (m, i) {
          // Offset so the first outer friend is not straight above the core's pins.
          satellite(outerRing, OUTER_SECONDS, false, m, Ro, 36, false, -Math.PI / 2 + Math.PI / outer.length + (i * 2 * Math.PI) / outer.length);
        });
        this._loadOrbitAvatars(inner.concat(outer));

        // The lowest satellite's bottom edge is ringTop + S - 2 (its ring is S/2 - 20 from the
        // centre and it is 36px across); start the caption just below that.
        var ty = ringTop + S + 4;
        var names = o.members.slice(0, 4).map(function (m) { return m.handle ? "@" + m.handle : "someone"; }).join(", ");
        var more = o.members.length - 4;
        var line = names + (more > 0 ? " and " + more + " more" : "");
        var lines = Math.max(1, Math.ceil(textW(line, 12, false) / (w - 32)));
        box.addMorph(label(lively.rect(16, ty, w - 32, 18 * lines + 4), line, { px: 12, color: INK, wrap: true }));
        ty += 18 * lines + 8;
        if (outerAll.length > OUTER_MAX) {
          box.addMorph(label(lively.rect(16, ty, w - 32, 18), "Showing " + OUTER_MAX + " of " + outerAll.length + " on the outer ring.", { px: 11, color: MUTED }));
          ty += 20;
        }
        if (this._isOwner) {
          var vis = { anyone: "anyone", friends: "friends", "private": "only me" }[o.visibility] || "friends";
          box.addMorph(label(lively.rect(16, ty, w - 32, 18), "Visible to " + vis, { px: 11, color: MUTED }));
          ty += 22;
        }
        var h = ty + 8;
        box.setExtent(lively.pt(w, h));
        return y + h;
      },

      // A member's picture: their profile's avatar once it has loaded, else the
      // handle-seeded blockie the profile card shows when there is none.
      _avatarFor: function (m, D) {
        return this._avatarUrls[m.did] || lively.identity.postCardUtils.identiconDataUrl(m.handle || m.did, D);
      },

      // Reads each shown member's public profile once (the orbit route only gives
      // did and handle). Redraws only when a picture actually turned up.
      _loadOrbitAvatars: function (members) {
        var self = this;
        members.forEach(function (m) {
          if (!m.handle || self._avatarUrls[m.did] !== undefined || self._avatarLoading[m.did]) return;
          self._avatarLoading[m.did] = true;
          getJSON("/@" + encodeURIComponent(m.handle) + "/profile", function (err, env) {
            var p = env && env.record && env.record.payload;
            var url = p && safeUrl(p.avatarUrl);
            self._avatarUrls[m.did] = url || null;
            if (url) self._scheduleRender();
          });
        });
      },

      // A picture that does not load (a link to another host, a removed file) falls
      // back to the blockie instead of leaving a broken-image box on the ring.
      _fallBackOnError: function (img, m, D) {
        var self = this;
        setTimeout(function () {
          var el = img.renderContext().shapeNode.querySelector("img");
          if (!el) return;
          el.addEventListener("error", function () {
            self._avatarUrls[m.did] = null;
            img.setImageURL(lively.identity.postCardUtils.identiconDataUrl(m.handle || m.did, D));
          });
        }, 0);
      },

      _openOrbitDialog: function () {
        var self = this;
        lively.require("lively.identity.OrbitDialog").toRun(function () {
          lively.identity.OrbitDialog.open({
            orbit: self._orbit,
            onSave: function () {
              getJSON("/@" + encodeURIComponent(self._handle) + "/orbit", function (err, body) {
                if (body) { self._orbit = body; self._scheduleRender(); }
              });
              // The orbit is also an audience: bring the cards shared with it in line,
              // but never start a passkey prompt for it.
              lively.identity.postcardAudience.syncAudiences({ onlyIfKekCached: true }, function (err) {
                if (err) console.warn("[Homestar] audience sync after an orbit change failed:", err.message || err);
              });
            },
          });
        });
      },
    },

    "postcards", {
      // The reel is one long-lived object with its own morphs (so a resize does
      // not restart the card); this only positions it.
      _buildPostcards: function (x, y, w) {
        if (!this._reel) {
          var self = this;
          this._reel = new lively.identity.PostcardReel({
            handle: this._handle,
            shown: this._shown,
            viewer: this._viewer,
            isOwner: this._isOwner,
            onNew: function () { self._newPostcard(); },
            onResize: function () { self._scheduleRender(); },
            onCardShown: function (objId) { if (self._mapPanel) self._mapPanel.setCurrent(objId); },
          });
        }
        return this._reel.attach(x, y, w);
      },
    },

    "map", {
      // Like the reel, the map panel is one long-lived object (a Leaflet map cannot
      // be rebuilt on every render); this only positions it. It takes no room until
      // the viewer has a located postcard to see.
      _buildMap: function (x, y, w) {
        if (!this._mapPanel) {
          var self = this;
          this._mapPanel = new lively.identity.HomestarMapPanel({
            handle: this._handle,
            shown: this._shown,
            isOwner: this._isOwner,
            onPin: function (objId) { if (self._reel) self._reel.showCard(objId); },
            getCurrent: function () { return self._reel ? self._reel.currentObjId() : null; },
            getHidden: function () { return (self._profile.homestar || {}).mapHidden; },
            onManage: function () { self._openMapDialog(); },
            onResize: function () { self._scheduleRender(); },
          });
        }
        return this._mapPanel.attach(x, y, w, GAP);
      },
    },

    "shelves", {
      // The row of small cards under the columns (HomestarShelves.js). A card with
      // nothing to show is left out, and with none at all the row takes no room.
      // Returns the y below the row, or y - GAP when it is empty so the caller's
      // GAP is taken back.
      _buildShelves: function (x, y, w) {
        var S = lively.identity.HomestarShelves;
        var self = this;
        var cards = [
          this._wikiPages ? S.wiki(this._handle, this._wikiPages, {
            isOwner: this._isOwner, hiddenCount: (this._wikiInfo || {}).hiddenCount || 0,
            onManage: function () { self._openWikiCardDialog(); },
          }) : null,
          S.shelf({
            handle: this._handle, books: this._shelfBooks, record: this._shelfRecord,
            booksWorld: this._shelfWorlds.books, musicWorld: this._shelfWorlds.music,
          }),
          S.sky(this._profile),
          this._transit ? S.transit({
            station: this._transit.station, times: this._transit.times, isOwner: this._isOwner,
            onManage: function () { self._openTransitDialog(); },
          }) : null,
          S.guestbook({
            handle: this._handle, entries: this._gbEntries, isOwner: this._isOwner, viewer: this._viewer,
            avatarFor: function (e) { return self._avatarFor(e, 28); },
            onSign: function () { self._openGuestbook(); },
            onSignIn: function () { self._openLogin(); },
            onDelete: function (e) { self._deleteGuestbookEntry(e); },
            onProfile: function (e, rect) {
              var at = lively.pt(rect.left + (window.pageXOffset || 0), rect.bottom + (window.pageYOffset || 0));
              lively.require("lively.identity.MiniProfileCard").toRun(function () {
                lively.identity.MiniProfileCard.open(e.handle, e.did, at);
              });
            },
          }),
        ];
        var bottom = S.layout(cards, x, y, w, GAP, function (m) { self._add(m); });
        return bottom === y ? y - GAP : bottom;
      },
    },

    "guestbook", {
      _openGuestbook: function () {
        var self = this;
        if (!this._gbObjId) return;
        lively.require("lively.identity.GuestbookDialog").toRun(function () {
          lively.identity.GuestbookDialog.open({
            handle: self._handle,
            objId: self._gbObjId,
            onPosted: function () { self._loadGuestbook(); },
          });
        });
      },

      // The owner removes any entry, an author their own (the server checks both).
      _deleteGuestbookEntry: function (entry) {
        var self = this;
        $world.confirm("Remove this entry from the guestbook?", function (yes) {
          if (!yes) return;
          fetch("/@" + encodeURIComponent(self._handle) + "/" + encodeURIComponent(self._gbObjId) + "/comments/" + encodeURIComponent(entry.id),
            { method: "DELETE", credentials: "include" })
            .then(function (res) {
              if (!res.ok) return $world.alert("Could not remove the entry.");
              self._loadGuestbook();
            })
            .catch(function (err) { $world.alert("Could not remove the entry: " + err.message); });
        });
      },
    },

    "constellations", {
      // The constellations this handle belongs to: the public ones for a visitor, plus
      // the private ones (marked with a lock) for the owner. Left out while loading and
      // when there is nothing to show a visitor, rather than drawn empty. Returns the
      // bottom y, or y - GAP when it draws nothing so the caller's bottom is unchanged.
      _buildConstellations: function (x, y, w) {
        var self = this;
        var list = this._constellations;
        if (!list || (!list.length && !this._isOwner)) return y - GAP;

        var SHOWN = 6, ROW_H = 60;
        var shown = list.slice(0, SHOWN);

        var box = panel(lively.rect(x, y, w, 120));
        this._add(box);
        box.addMorph(icon(lively.rect(16, 14, 22, 22), "stars", 18, PINK));
        box.addMorph(label(lively.rect(44, 14, w - 60 - 80, 22), "Constellations", { px: 15, bold: true }));
        if (this._isOwner) {
          var manage = pill(0, 0, "Manage", { w: 72, h: 26, onClick: function () { self._openConstellationsDialog(); } });
          manage.setPosition(lively.pt(w - 16 - 72, 11));
          box.addMorph(manage);
        }

        var cy = 46;
        if (!shown.length) {
          var info = this._constellationsInfo || {};
          var none = info.hiddenCount > 0
            ? "Nothing is shown. Use Manage to choose constellations."
            : "You haven't joined any constellations yet.";
          box.addMorph(label(lively.rect(16, cy, w - 32, 36), none, { px: 13, color: MUTED, wrap: true }));
          cy += 44;
        } else {
          shown.forEach(function (c) {
            box.addMorph(self._constellationRow(c, 12, cy, w - 24));
            cy += ROW_H;
          });
          if (list.length > shown.length) {
            box.addMorph(label(lively.rect(16, cy, w - 32, 20), "and " + (list.length - shown.length) + " more", { px: 13, color: MUTED }));
            cy += 28;
          }
        }

        var h = cy + 12;
        box.setExtent(lively.pt(w, h));
        return y + h;
      },

      _constellationRow: function (c, x, y, w) {
        var row = new lively.morphic.Box(lively.rect(x, y, w, 52));
        row.applyStyle({ fill: Color.rgb(250, 248, 252), borderRadius: 10, borderWidth: 1, borderColor: CARD_BORDER, clipMode: "hidden", handStyle: "pointer" });
        noDrag(row);

        var tile = new lively.morphic.Box(lively.rect(8, 8, 36, 36));
        tile.applyStyle({ fill: PINK_SOFT, borderRadius: 9, borderWidth: 0 });
        noDrag(tile);
        tile.eventsAreIgnored = true;
        row.addMorph(tile);
        tile.addMorph(icon(lively.rect(5, 5, 26, 26), "stars", 20, PINK));

        function count(n, one, many) { return n + " " + (n === 1 ? one : many); }
        var detail = count(c.memberCount || 0, "member", "members") + " · " + count(c.roomCount || 0, "cluster", "clusters");
        var textW_ = c.visibility === "public" ? w - 64 : w - 90;
        row.addMorph(label(lively.rect(54, 7, textW_, 20), trunc("c/" + c.name, 26), { px: 14, bold: true }));
        row.addMorph(label(lively.rect(54, 27, textW_, 18), detail, { px: 12, color: MUTED }));
        // Only the owner is ever sent a private one; the lock tells it apart.
        if (c.visibility !== "public") row.addMorph(icon(lively.rect(w - 30, 16, 20, 20), "lock", 16, MUTED));

        row.onMouseOver = function () { row.applyStyle({ fill: PINK_SOFT }); };
        row.onMouseOut  = function () { row.applyStyle({ fill: Color.rgb(250, 248, 252) }); };
        row.onMouseUp = function (evt) {
          evt.stop();
          window.location.href = "/c/" + encodeURIComponent(c.name);
          return true;
        };
        return row;
      },
    },

    "worlds", {
      _buildWorlds: function (x, y, w) {
        var self = this;
        var worlds = this._worlds;
        // Nothing to show a visitor: leave the panel out rather than draw an empty one.
        if (worlds && !worlds.length && !this._isOwner) return y - GAP;

        var box = panel(lively.rect(x, y, w, 120));
        this._add(box);
        box.addMorph(icon(lively.rect(16, 14, 22, 22), "public", 18, PINK));
        box.addMorph(label(lively.rect(44, 14, w - 60 - 70, 22), "Worlds", { px: 15, bold: true }));
        if (this._isOwner && worlds) {
          var choose = pill(0, 0, "Choose", { w: 72, h: 26, onClick: function () { self._openWorldsDialog(); } });
          choose.setPosition(lively.pt(w - 16 - 72, 11));
          box.addMorph(choose);
        }

        var cy = 46;
        if (!worlds) {
          box.addMorph(label(lively.rect(16, cy, w - 32, 20), "Loading…", { px: 13, color: MUTED }));
          cy += 28;
        } else if (!worlds.length) {
          box.addMorph(label(lively.rect(16, cy, w - 32, 20), "No worlds featured yet.", { px: 13, color: MUTED }));
          cy += 28;
        } else {
          worlds.forEach(function (wd) {
            box.addMorph(self._worldRow(wd, 12, cy, w - 24));
            cy += 60;
          });
        }

        if (this._isOwner) {
          var t = label(lively.rect(16, cy + 2, w - 32, 20), "All my worlds →", { px: 13, bold: true, color: PINK });
          t.eventsAreIgnored = false;
          t.applyStyle({ handStyle: "pointer" });
          t.onMouseUp = function (evt) { evt.stop(); self._openWorldsBrowser(); return true; };
          box.addMorph(t);
          cy += 30;
        }

        var h = cy + 12;
        box.setExtent(lively.pt(w, h));
        return y + h;
      },

      _worldRow: function (wd, x, y, w) {
        var self = this;
        var row = new lively.morphic.Box(lively.rect(x, y, w, 52));
        row.applyStyle({ fill: Color.rgb(250, 248, 252), borderRadius: 10, borderWidth: 1, borderColor: CARD_BORDER, clipMode: "hidden", handStyle: "pointer" });
        noDrag(row);

        var tile = new lively.morphic.Box(lively.rect(8, 8, 36, 36));
        tile.applyStyle({ fill: PINK_SOFT, borderRadius: 9, borderWidth: 0 });
        noDrag(tile);
        tile.eventsAreIgnored = true;
        row.addMorph(tile);
        tile.addMorph(icon(lively.rect(5, 5, 26, 26), "language", 20, PINK));

        var detail = wd.template ? String(wd.template).replace(/[-_]/g, " ") : "blank world";
        row.addMorph(label(lively.rect(54, 7, w - 90, 20), trunc(wd.name || "Untitled", 28), { px: 14, bold: true }));
        row.addMorph(label(lively.rect(54, 27, w - 90, 18), trunc(detail, 28), { px: 12, color: MUTED }));
        var vis = wd.visibility === "public" ? "lock_open" : (wd.visibility === "shared" ? "group" : "lock");
        row.addMorph(icon(lively.rect(w - 30, 16, 20, 20), vis, 16, MUTED));

        row.onMouseOver = function () { row.applyStyle({ fill: PINK_SOFT }); };
        row.onMouseOut  = function () { row.applyStyle({ fill: Color.rgb(250, 248, 252) }); };
        row.onMouseUp = function (evt) {
          evt.stop();
          window.location.href = "/@" + encodeURIComponent(self._handle) + "/" + encodeURIComponent(wd.objId);
          return true;
        };
        return row;
      },
    },

    "actions", {
      // Who sees the Wiki pages card and which pages it lists (private settings the server
      // applies), so the card is re-read afterwards.
      _openWikiCardDialog: function () {
        var self = this;
        lively.require("lively.identity.WikiCardDialog").toRun(function () {
          lively.identity.WikiCardDialog.open({
            onSave: function () { self._loadWiki(); },
          });
        });
      },

      // Which BART station the Transit card shows and who sees it. Both are private
      // settings the server applies, so the card is re-read afterwards.
      _openTransitDialog: function () {
        var self = this;
        lively.require("lively.identity.TransitDialog").toRun(function () {
          lively.identity.TransitDialog.open({
            onSave: function () { self._loadTransit(); },
          });
        });
      },

      // Who sees the constellations card and which constellations it lists. Both are
      // private settings the server applies, so the card is re-read afterwards.
      _openConstellationsDialog: function () {
        var self = this;
        lively.require("lively.identity.ConstellationsDialog").toRun(function () {
          lively.identity.ConstellationsDialog.open({
            onSave: function () { self._loadConstellations(); },
          });
        });
      },

      // Pick and order the featured worlds. They are stored in the profile, so the
      // page re-reads it afterwards and recomputes what to show.
      _openWorldsDialog: function () {
        var self = this;
        lively.require("lively.identity.WorldsDialog").toRun(function () {
          lively.identity.WorldsDialog.open({
            featured: (self._worlds || []).map(function (w) { return w.objId; }),
            onSave: function () { self._refreshProfile(); },
          });
        });
      },

      // Pick which located cards the map shows. The unticked ones are stored in the
      // profile; the saved list is applied at once, then the profile is re-read.
      _openMapDialog: function () {
        var self = this;
        if (!this._mapPanel) return;
        lively.require("lively.identity.MapDialog").toRun(function () {
          lively.identity.MapDialog.open({
            cards: self._mapPanel.allCards(),
            hidden: self._mapPanel.hiddenIds(),
            visibility: self._mapPanel.visibility(),
            onSave: function (ids, visibility) {
              self._profile.homestar = Object.assign({}, self._profile.homestar, { mapHidden: ids });
              self._mapPanel.setVisibility(visibility);
              self._mapPanel.refresh();
              self._refreshProfile();
            },
          });
        });
      },

      _openProfileCard: function () {
        var self = this;
        lively.require("lively.identity.ProfileCard").toRun(function () {
          var win = lively.identity.ProfileCard.open(self._handle);
          // An edit saved in the card should show up here once it is closed.
          var origRemove = win.remove;
          win.remove = function () {
            var r = origRemove.apply(this, arguments);
            if (self._isOwner) self._refreshProfile();
            return r;
          };
        });
      },

      _openLogin: function () {
        lively.require("lively.identity.LoginDialog").toRun(function () {
          lively.BuildSpec("lively.identity.LoginDialog").createMorph().openInWorldCenter();
        });
      },

      _openDM: function () {
        var self = this;
        lively.require("lively.identity.DMChat").toRun(function () {
          lively.identity.DMChat.open(self._handle, self._did);
        });
      },

      _newPostcard: function () {
        var handle = this._viewer && this._viewer.handle;
        if (!handle) return;
        lively.require("lively.identity.PostCardEditor").toRun(function () {
          lively.identity.PostCardEditor.newCard(handle);
        });
      },

      _openWorldsBrowser: function () {
        lively.require("lively.identity.WorldsBrowser").toRun(function () {
          lively.BuildSpec("lively.identity.WorldsBrowser").createMorph().openInWorldCenter();
        });
      },

      _sendFriendRequest: function () {
        var self = this;
        fetch("/@" + encodeURIComponent(this._handle) + "/friend-requests", { method: "POST", credentials: "include" })
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (body.error) return $world.alert(body.error);
            // A request answered the other way round befriends at once.
            self._friendStatus = body.status === "accepted" ? "friends" : "pending-outgoing";
            self._scheduleRender();
          })
          .catch(function (err) { $world.alert("Could not send the request: " + err.message); });
      },

      _approveFriendRequest: function () {
        var self = this;
        fetch("/@" + encodeURIComponent(this._viewer.handle) + "/friend-requests/" + encodeURIComponent(this._did), {
          method: "PUT", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "approve" }),
        })
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (body.error) return $world.alert(body.error);
            self._friendStatus = "friends";
            self._scheduleRender();
          })
          .catch(function (err) { $world.alert("Could not accept the request: " + err.message); });
      },
    });

    lively.identity.Homestar = {
      open: function (data) {
        var controller = new lively.identity.HomestarController(data);
        controller.start();
        return controller;
      },
    };

  });
