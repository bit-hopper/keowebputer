/**
 * lively.identity.WikiView
 *
 * Read-only wiki-page morph — the counterpart to WikiEditor (editing-only).
 * Split out of lively.identity.PostCardView when wiki pages became their
 * own envelope type (type: 'wikipage') instead of a type:'postcard' +
 * state.wikiName combination. Simpler than PostCardView in two ways that
 * both follow from wiki pages' own design (WikiSerializer.js):
 *
 *   - No flip/back-face card mechanic. A wiki page isn't a postcard you
 *     flip over — its crypto/meta details live in an in-page collapsible
 *     header instead (open by default), below the title: an Author row
 *     (the genesis creator, per WikiSerializer.js's "did stays fixed at
 *     genesis"), a Contributors row (other constellation members who have
 *     saved the page, avatars stacked horizontally), then CID/Updated/
 *     Constellation rows and the verify badge. See _buildDetails.
 *   - No reactions footer, no encrypted-content lock placeholder —
 *     wiki pages are always public/unencrypted, and reactions are a
 *     postcard-only social feature that never applied to wiki pages.
 *
 * Contributors/last-editor data: envelope.did never changes from the
 * genesis author (WikiSerializer.js), so per-save attribution can't come
 * from that field. IdentityServer.js's PUT /@:handle/:objId now maintains
 * state.contributors (every DID that has ever saved this page besides the
 * genesis author) and state.lastEditedBy (who saved THIS version) — both
 * server-trusted (derived from the authenticated session, not the client's
 * envelope.state), applied in _applyWikiContributorTracking there. DIDs are
 * resolved to handles via GET /dids/handles (see _resolveHandles below) —
 * can't fold that resolution into the envelope response itself, since the
 * envelope round-trips through verifyEnvelopeIntegrity's canonicalJson
 * comparison and extra fields would break that.
 *
 * The one piece of real logic this file owns that PostCardView.js's
 * counterpart didn't need: the Edit button is owner-OR-constellation-
 * canWrite, not owner-only — a wiki page can legitimately be edited by any
 * constellation member with write access (ConstellationRegistry.canWrite),
 * so gating the button on ownership alone would hide a working edit path
 * from a legitimate co-editor. Resolved via the same GET .../space-token
 * check WikiEditor.js already performs when a non-owner opens the editor
 * directly.
 *
 * A self-rendering lively.morphic.Box (no lively.morphic.Window chrome —
 * same pattern as lively.commerce.Shop). Opened standalone (no target), it's
 * placed directly in the world via openInWorld at Shop-sized dimensions;
 * embedded call sites (ConstellationLounge/Canvas feeds) pass their own
 * target + bounds and keep their smaller, card-shaped sizing.
 *
 * Entry point:
 *   lively.identity.WikiView.open(handle, objId, options)
 *     options.target      -> embed via target.addMorph(view) instead of the world
 *     options.envelope    -> render immediately, skip the fetch
 *     options.cid         -> view a specific historical version
 *     options.bounds      -> override the default extent
 */

module("lively.identity.WikiView")
  .requires(
    "lively.identity.PostCardUtils",
    "lively.identity.DID",
    "lively.identity.Crypto",
    "lively.identity.WikiEditor",
    "lively.identity.WikiHistory",
    "lively.identity.PasskeyPrimingDialog",
  )
  .toRun(function () {
    var WikiViewClass = lively.morphic.Box.subclass(
      "lively.identity.WikiView",

      "serialization",
      {
        doNotSerialize: [
          "_wrapperEl",
          "_topBarEl",
          "_avatarImgEl",
          "_handleEl",
          "_titleEl",
          "_contentEl",
          "_detailsPanelEl",
          "_detailsToggleEl",
          "_detailsChevronEl",
          "_authorRowEl",
          "_contributorsRowEl",
          "_cidEl",
          "_dateEl",
          "_visibilityEl",
          "_verifyBadgeEl",
          "_moreBtn",
          "_moreMenuEl",
          "_moreMenuOutsideHandler",
          "_contentLoadStarted",
          "_onEdit",
          "_onDeleted",
          "_history",
          "_heightObserver",
          "_onHeightChanged",
        ],
      },

      "initialization",
      {
        _setup: function () {
          this.disableDragging();
          this.disableGrabbing();
          // Rendered math/code need these on any page that shows a wiki view
          // -- the wiki index route doesn't ship them in its HTML. Same ids
          // as WikiEditor's _ensureRuntime, so whichever runs first wins.
          [["katex-css", "/core/lib/postcard/katex.min.css"], ["hljs-css", "/core/lib/postcard/hljs-github.css"]].forEach(function (p) {
            if (document.getElementById(p[0])) return;
            var link = document.createElement("link");
            link.id = p[0];
            link.rel = "stylesheet";
            link.href = p[1];
            document.head.appendChild(link);
          });
          this._detailsOpen = true;
          this._isOwner = false;
          this._canEdit = false;
          this._canDelete = false;
          this._verifyResult = null;
          this._buildChrome();

          // See PostCardView.js's identical guard for the full race
          // explanation (open() calling _setup() vs. prepareForNewRenderContext
          // firing again when this morph attaches to its new window).
          if (this._contentLoadStarted) return;
          this._contentLoadStarted = true;
          if (this._envelope) this._renderEnvelope(this._envelope);
          else this._loadEnvelope();
        },

        prepareForNewRenderContext: function ($super, renderCtx) {
          $super(renderCtx);
          if (!this._handle) return;
          this._envelope = null;
          this._setup();
        },
      },

      "chrome",
      {
        _buildChrome: function () {
          var self = this;
          this.setFill(Color.white);

          var shapeNode = this.renderContext().shapeNode;
          shapeNode.innerHTML = ""; // idempotent: safe if _setup() ever runs twice on one instance
          shapeNode.style.borderRadius = "10px";
          shapeNode.style.boxShadow = "0 4px 14px rgba(0,0,0,0.2)";
          shapeNode.style.overflow = "hidden";

          // autoHeight: the wrapper flows at its natural height instead of
          // filling the morph, and _watchContentHeight resizes the morph to
          // match — so the page grows with its content and the browser page
          // scrolls, rather than the content scrolling inside a fixed box.
          var wrapper = document.createElement("div");
          wrapper.className = "lively-wiki-view-wrapper";
          wrapper.style.cssText = [
            this._autoHeight ? "position:relative" : "position:absolute; inset:0",
            "display:flex", "flex-direction:column",
            "font-family:sans-serif", "background:#fff",
            "box-sizing:border-box",
          ].join(";");
          shapeNode.appendChild(wrapper);
          this._wrapperEl = wrapper;

          this._buildTopBar(wrapper);
          this._buildTitle(wrapper);
          this._buildDetails(wrapper);
          this._buildContentArea(wrapper);
          if (this._autoHeight) this._watchContentHeight(wrapper);
        },

        // Keeps the morph's height equal to the wrapper's natural height.
        // A ResizeObserver (rather than a one-shot measure after render)
        // also covers images/videos loading late and the details panel
        // toggling. Only sets the extent when the height actually changed,
        // so the resize it triggers can't feed back into another observation.
        _watchContentHeight: function (wrapper) {
          var self = this;
          if (this._heightObserver) this._heightObserver.disconnect();
          if (typeof ResizeObserver === "undefined") return;
          this._heightObserver = new ResizeObserver(function () {
            var h = Math.max(120, Math.ceil(wrapper.getBoundingClientRect().height));
            var ext = self.getExtent();
            if (Math.abs(ext.y - h) < 1) return;
            self.setExtent(lively.pt(ext.x, h));
            if (self._onHeightChanged) self._onHeightChanged(self, h);
            else if (self.owner && self.owner.isWorld) self._growWorldToFit();
          });
          this._heightObserver.observe(wrapper);
        },

        // A standalone page view sits directly in the world with no caller
        // managing the world's size (WikiIndex does that itself via
        // onHeightChanged): extend the world so its background covers the
        // whole page and the browser page scrolls to the end of it.
        _growWorldToFit: function () {
          var world = this.owner;
          var bottom = this.getPosition().y + this.getExtent().y + 48;
          var h = Math.max(window.innerHeight, Math.ceil(bottom));
          var w = document.documentElement.clientWidth - 1; // see WikiIndex._syncPageHeight
          var ext = world.getExtent();
          if (Math.abs(ext.y - h) < 1 && Math.abs(ext.x - w) < 1) return;
          world.setExtent(lively.pt(w, h));
        },

        _buildTopBar: function (wrapper) {
          var self = this;
          var topBar = document.createElement("div");
          topBar.style.cssText = [
            "position:relative", "flex:0 0 auto",
            "height:44px", "padding:0 44px 0 10px",
            "box-sizing:border-box",
          ].join(";");
          wrapper.appendChild(topBar);
          this._topBarEl = topBar;

          var avatar = document.createElement("img");
          avatar.className = "lively-wiki-view-avatar";
          avatar.style.cssText = [
            "position:absolute", "top:10px", "left:10px",
            "width:28px", "height:28px", "border-radius:50%",
            "box-shadow:0 0 0 2px #fff, 0 1px 3px rgba(0,0,0,0.3)",
          ].join(";");
          topBar.appendChild(avatar);
          this._avatarImgEl = avatar;

          var handleEl = document.createElement("div");
          handleEl.style.cssText = [
            "position:absolute", "top:10px", "left:46px", "right:0",
            "height:28px", "display:flex", "align-items:center",
            "font-size:11px", "color:" + (this._pinkHandle ? "#CC0057" : "#888"), "white-space:nowrap",
            "overflow:hidden", "text-overflow:ellipsis",
          ].join(";");
          handleEl.textContent = "@" + this._handle;
          topBar.appendChild(handleEl);
          this._handleEl = handleEl;

          // "More" menu -- Edit (when write access allows it, see
          // _resolveEditAccess), Copy link, Download. Edit used to be its
          // own dedicated button in this same top-right corner; folded into
          // the menu as its top entry so there's a single control here.
          var moreBtn = document.createElement("button");
          moreBtn.innerHTML = '<span class="material-symbols-rounded" style="font-size:16px;line-height:1;">more_vert</span>';
          moreBtn.title = "More";
          moreBtn.style.cssText = [
            "position:absolute", "top:8px", "right:8px",
            "width:24px", "height:24px", "padding:0", "cursor:pointer",
            "display:flex", "align-items:center", "justify-content:center",
            "border:1px solid #ccc", "border-radius:50%", "background:#fff", "color:#555",
          ].join(";");
          ["mousedown", "click"].forEach(function (t) {
            moreBtn.addEventListener(t, function (e) {
              e.preventDefault();
              e.stopPropagation();
              if (t === "click") self._toggleMoreMenu(moreBtn);
            });
          });
          topBar.appendChild(moreBtn);
          this._moreBtn = moreBtn;
        },

        _buildTitle: function (wrapper) {
          var title = document.createElement("div");
          title.style.cssText = [
            "flex:0 0 auto", "padding:2px 14px 8px",
            "font-size:15px", "font-weight:600", "color:#222",
            "white-space:nowrap", "overflow:hidden", "text-overflow:ellipsis",
            "box-sizing:border-box",
          ].join(";");
          wrapper.appendChild(title);
          this._titleEl = title;
        },

        // Collapsible-open-by-default meta header: Author (genesis creator +
        // avatar), Contributors (other saving members, avatars stacked
        // horizontally), then CID/Updated/Constellation + verify badge. See
        // file header for why this replaced the old flip-card back face.
        _buildDetails: function (wrapper) {
          var self = this;

          var toggle = document.createElement("div");
          toggle.style.cssText = [
            "flex:0 0 auto", "display:flex", "align-items:center", "gap:5px",
            "padding:2px 14px", "font-size:11px", "color:#999",
            "cursor:pointer", "user-select:none", "border-top:1px solid #f0f0f0",
            "border-bottom:1px solid #f0f0f0", "background:#fafafa",
          ].join(";");
          var chevron = document.createElement("span");
          chevron.textContent = "▾"; // ▾
          chevron.style.cssText = "display:inline-block;transition:transform 150ms ease;font-size:9px;";
          var label = document.createElement("span");
          label.textContent = "Details";
          toggle.appendChild(chevron);
          toggle.appendChild(label);
          toggle.addEventListener("click", function () { self._toggleDetails(); });
          wrapper.appendChild(toggle);
          this._detailsToggleEl = toggle;
          this._detailsChevronEl = chevron;

          var panel = document.createElement("div");
          panel.style.cssText = [
            "flex:0 0 auto", "padding:8px 14px", "font-size:11px",
            "color:#555", "line-height:1.7", "background:#fafafa",
            "border-bottom:1px solid #eee", "box-sizing:border-box",
          ].join(";");
          wrapper.appendChild(panel);
          this._detailsPanelEl = panel;

          var authorRow = document.createElement("div");
          authorRow.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:6px;";
          panel.appendChild(authorRow);
          this._authorRowEl = authorRow;

          var contributorsRow = document.createElement("div");
          contributorsRow.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:8px;";
          panel.appendChild(contributorsRow);
          this._contributorsRowEl = contributorsRow;

          function metaRow(label) {
            var r = document.createElement("div");
            var l = document.createElement("span");
            l.textContent = label + ": ";
            l.style.color = "#999";
            var v = document.createElement("span");
            r.appendChild(l);
            r.appendChild(v);
            panel.appendChild(r);
            return v;
          }
          this._cidEl = metaRow("CID");
          this._dateEl = metaRow("Updated");
          this._visibilityEl = metaRow("Constellation");

          var badge = document.createElement("div");
          badge.style.cssText = "margin-top:6px;font-size:12px;font-weight:600;";
          badge.textContent = "Checking…";
          panel.appendChild(badge);
          this._verifyBadgeEl = badge;
        },

        _buildContentArea: function (wrapper) {
          var content = document.createElement("div");
          content.className = "lively-wiki-view-content selectable";
          content.style.cssText = [
            this._autoHeight ? "flex:0 0 auto" : "flex:1 1 auto; min-height:0; overflow-y:auto",
            "padding:10px 14px 14px", "font-size:13px", "line-height:1.5",
            "color:#333", "box-sizing:border-box",
          ].join(";");
          wrapper.appendChild(content);
          this._contentEl = content;

          // BUG FIX: same native-wheel-scroll-does-nothing bug confirmed
          // live on PostCardView.js's content div (see its own matching
          // fix for the full writeup) — this div has the identical risk
          // shape: overflow-y:auto nested inside an overflow:hidden
          // ancestor (`shapeNode.style.overflow = "hidden"`, _buildChrome)
          // within a transformed/composited morph chain, which a real
          // ConstellationLounge-reel-style embedding (opts.target set,
          // _autoHeight false) puts this exact overflow-y:auto branch into
          // play. Not independently confirmed broken here — fixed
          // preemptively since the structural cause is the same.
          content.addEventListener("wheel", function (e) {
            if (getComputedStyle(content).overflowY !== "auto") return; // _autoHeight: no scroll area
            content.scrollTop += e.deltaY;
            e.preventDefault();
          }, { passive: false });
        },

        _toggleDetails: function () {
          this._detailsOpen = !this._detailsOpen;
          this._detailsPanelEl.style.display = this._detailsOpen ? "" : "none";
          this._detailsChevronEl.style.transform = this._detailsOpen ? "rotate(0deg)" : "rotate(-90deg)";
        },

        // Renders a small avatar+handle pair for the Author row / each
        // Contributors entry. Falls back to an identicon immediately, then
        // swaps in the real avatar if the handle's profile has one —
        // mirrors _loadAvatarInto's own fallback-then-upgrade pattern.
        _buildPersonChip: function (handle, did, size) {
          var chip = document.createElement("span");
          chip.style.cssText = "display:inline-flex;align-items:center;gap:3px;";
          var img = document.createElement("img");
          img.style.cssText = "width:" + size + "px;height:" + size + "px;border-radius:50%;box-shadow:0 0 0 1px #fff,0 1px 2px rgba(0,0,0,0.25);";
          img.title = "@" + handle;
          chip.appendChild(img);
          this._loadAvatarInto(img, handle);
          this._wireProfileClick(chip, handle, did);
          return { el: chip, imgEl: img };
        },

        // Opens lively.identity.MiniProfileCard anchored just below a raw
        // DOM element (the top-bar avatar/handle, or an Author/Contributors
        // chip) — none of those are morphs, unlike every other
        // MiniProfileCard call site (ConstellationLounge.js/RoomView.js),
        // so the anchor world-position is computed here instead of handed
        // to a morph's own worldPoint(). The delta between the element's
        // and this view's own shapeNode's bounding rects gives a point
        // local to this morph; this.worldPoint() then turns that into a
        // real world position, which is scroll-safe on its own (Core.js's
        // worldPoint composes the owner-chain transform, not the viewport)
        // — MiniProfileCard.open's own clamp math handles the current
        // scroll offset from there. See MiniProfileCard.js's file header
        // for the plain-point anchor shape this relies on.
        _wireProfileClick: function (el, handle, did) {
          if (!handle || !did) return; // nothing to open a profile for
          var self = this;
          el.style.cursor = "pointer";
          el.addEventListener("click", function (evt) {
            evt.stopPropagation();
            var elRect = el.getBoundingClientRect();
            var shapeRect = self.renderContext().shapeNode.getBoundingClientRect();
            var localPt = lively.pt(elRect.left - shapeRect.left, elRect.bottom - shapeRect.top);
            var worldPos = self.worldPoint(localPt);
            lively.require("lively.identity.MiniProfileCard").toRun(function () {
              lively.identity.MiniProfileCard.open(handle, did, worldPos, {
                constellationName: self._constellation,
              });
            });
          });
        },
      },

      "data loading",
      {
        _loadEnvelope: function () {
          var self = this;
          var base = lively.identity.did.baseUrl();
          var url =
            base +
            "/@" +
            encodeURIComponent(this._handle) +
            "/" +
            encodeURIComponent(this._objId) +
            (this._cid ? "/at/" + encodeURIComponent(this._cid) : "");
          var xhr = new XMLHttpRequest();
          xhr.open("GET", url, true);
          xhr.setRequestHeader("Accept", "application/json");
          xhr.onload = function () {
            if (xhr.status !== 200)
              return self._showError("Failed to load wiki page: " + xhr.status);
            var envelope;
            try {
              envelope = JSON.parse(xhr.responseText);
            } catch (e) {
              return self._showError("Invalid envelope JSON: " + e.message);
            }
            self._renderEnvelope(envelope);
          };
          xhr.onerror = function () {
            self._showError("Network error loading wiki page");
          };
          xhr.send();
        },

        // Batch-resolves DIDs to handles via GET /dids/handles (see
        // IdentityServer.js's file header on why this can't just be embedded
        // in the envelope response). Calls thenDo({ [did]: handle|null }).
        _resolveHandles: function (dids, thenDo) {
          var unique = (dids || []).filter(function (d, i, a) { return d && a.indexOf(d) === i; });
          if (!unique.length) return thenDo({});
          var base = lively.identity.did.baseUrl();
          var xhr = new XMLHttpRequest();
          xhr.open("GET", base + "/dids/handles?dids=" + encodeURIComponent(unique.join(",")), true);
          xhr.withCredentials = true;
          xhr.setRequestHeader("Accept", "application/json");
          xhr.onload = function () {
            if (xhr.status !== 200) return thenDo({});
            try { thenDo(JSON.parse(xhr.responseText).handles || {}); }
            catch (e) { thenDo({}); }
          };
          xhr.onerror = function () { thenDo({}); };
          xhr.send();
        },

        _showError: function (msg) {
          console.error("[WikiView]", msg);
          if (this._titleEl) this._titleEl.textContent = "Error";
          if (this._contentEl) this._contentEl.textContent = msg;
        },
      },

      "rendering",
      {
        _renderEnvelope: function (envelope) {
          this._envelope = envelope;
          this._constellation = envelope.constellation || null;
          var user = lively.identity.did.currentUser();
          this._isOwner = !!(user && user.did === envelope.did);

          this._loadAvatarInto(this._avatarImgEl, this._handle);
          this._titleEl.textContent =
            (envelope.state && envelope.state.title) || "(untitled)";

          this._renderContentArea(envelope);
          this._renderDetails(envelope);
          this._resolveEditAccess();
          // Coming back from the editor's History button (opts.openHistory)
          if (this._openHistoryOnLoad) {
            this._openHistoryOnLoad = false;
            this._openHistory();
          }
        },

        // Owner-OR-constellation-canWrite (see file header) — resolves
        // whether the "more" menu's Edit entry shows up, unlike
        // PostCardView.js's owner-only gate, since a wiki page can
        // legitimately be edited by any constellation member with write
        // access. The menu is rebuilt fresh each time it's opened
        // (_toggleMoreMenu), so it always reflects the latest _canEdit.
        _resolveEditAccess: function () {
          var self = this;
          if (this._isOwner) {
            this._canEdit = true;
            this._canDelete = true;
            return;
          }
          if (!this._constellation || !this._handle || !this._objId) return;
          // Whether a non-author may edit depends on the page's own edit
          // policy (all members / controllers / listed handles), which only
          // the server evaluates -- ask it, rather than re-deriving the rule
          // from constellation membership here.
          var base = lively.identity.did.baseUrl();
          var url = base + "/@" + encodeURIComponent(this._handle) + "/" +
            encodeURIComponent(this._objId) + "/edit-token";
          var xhr = new XMLHttpRequest();
          xhr.open("GET", url, true);
          xhr.withCredentials = true;
          xhr.setRequestHeader("Accept", "application/json");
          xhr.onload = function () {
            if (xhr.status !== 200) return;
            try {
              var access = JSON.parse(xhr.responseText);
              if (access.canEdit) self._canEdit = true;
              // Author or constellation controller -- decided server-side
              // (WikiPermissions.canDeleteWikiPage), independent of editPolicy.
              if (access.canDelete) self._canDelete = true;
            } catch (e) {}
          };
          xhr.send();
        },

        // Default Edit behavior when no embedding caller supplied
        // opts.onEdit (e.g. a bare WikiView.open(...) call from the SSR
        // share-link page, or a restore from WikiHistory) -- swaps this view for a
        // WikiEditor occupying the exact same owner/position/extent, with
        // no lively.morphic.Window involved either way. WikiEditor.js stays
        // completely unaware of WikiView.js; this file already
        // .requires("lively.identity.WikiEditor") (one-directional, no
        // require cycle), so it's safe to close over WikiEditor.openCard
        // directly here.
        _startEditDefault: function (restore) {
          var owner = this.owner; // a plain property (Core.js's addMorph sets morph.owner = newOwner), not a method
          var pos = this.getPosition();
          var extent = this.getExtent();
          var bounds = lively.rect(0, 0, extent.x, extent.y);
          var handle = this._handle, objId = this._objId;
          var autoHeight = !!this._autoHeight;
          this.remove();
          var editor = lively.identity.WikiEditor.openCard(handle, objId, {
            // A falsy target correctly falls through to WikiEditor's own
            // standalone-in-world branch when this view had no owner of its
            // own (i.e. it was itself standalone via _openInWorld).
            target: owner || null,
            bounds: bounds,
            autoHeight: autoHeight,
            restore: restore || null,
            onSaved: function (h, o, extra) {
              // The editor this view was swapped for has to go once the view
              // is back; nothing else removes it on this standalone path
              // (WikiIndex's slot swap does it via _setActiveContentMorph).
              if (editor) editor.remove();
              var view = lively.identity.WikiView.open(h, o, {
                target: owner || null, bounds: bounds, autoHeight: autoHeight,
                openHistory: !!(extra && extra.openHistory),
              });
              // target-embed doesn't auto-center/reposition; standalone-in-
              // world does its own centering, so only reposition when we
              // had a real owner slot to return to.
              if (owner) view.setPosition(pos);
            },
          });
          if (owner) editor.setPosition(pos);
        },

        // Shared by the top-bar avatar and each Author/Contributors chip.
        // Identicon fallback first (instant, no network dependency), then
        // upgraded to the handle's real avatar if their profile has one.
        _loadAvatarInto: function (imgEl, handle) {
          var fallbackSeed = handle || (this._envelope && this._envelope.did) || "";
          imgEl.src = lively.identity.postCardUtils.identiconDataUrl(fallbackSeed, 32);
          if (!handle) return;

          var base = lively.identity.did.baseUrl();
          fetch(base + "/@" + encodeURIComponent(handle) + "/profile", { credentials: "include" })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (env) {
              var avatarUrl = env && env.record && env.record.payload && env.record.payload.avatarUrl;
              if (avatarUrl) imgEl.src = avatarUrl;
            })
            .catch(function () {});
        },

        // Wiki pages are always public/unencrypted (WikiSerializer.js) —
        // no locked-content placeholder branch needed, unlike
        // PostCardView.js's counterpart.
        _renderContentArea: function (envelope) {
          var payload = envelope.record && envelope.record.payload;
          var snapshot = payload && payload.snapshot;
          this._contentEl.innerHTML = snapshot
            ? lively.identity.postCardUtils.snapshotToHtml(snapshot)
            : "";
          // BUG FIX: see PostCardView.js's _renderContentArea — same fix.
          lively.identity.postCardUtils.hydrateEmbeddedParts(this._contentEl);
          lively.identity.postCardUtils.hydrateCodeCells(this._contentEl);
          lively.identity.postCardUtils.hydrateLinkPreviewEmbeds(this._contentEl);
          lively.identity.postCardUtils.hydrateLinkPreviews(this._contentEl);
          if (this._highlightQuery) this._applyHighlight(this._highlightQuery);
        },

        // Wraps every case-insensitive occurrence of `query` in this page's
        // just-rendered content with a <mark>, and scrolls the first one
        // into view — the counterpart to WikiIndex.js's content-search
        // dropdown (opts.highlightQuery, see open() above). No highlight/
        // find-in-page utility exists anywhere else in the app layer to
        // reuse (only Ace's own internal editor-search text-marker, which
        // only works against its own <textarea> sessions, not arbitrary
        // rendered HTML), so this walks the live DOM text nodes directly.
        // Collects every text node up front before mutating any of them,
        // since replacing a node mid-walk would otherwise disturb the
        // TreeWalker's own traversal.
        _applyHighlight: function (query) {
          if (!this._contentEl || !query) return;
          var qLower = query.toLowerCase();
          var walker = document.createTreeWalker(this._contentEl, NodeFilter.SHOW_TEXT, null, false);
          var textNodes = [];
          var n;
          while ((n = walker.nextNode())) textNodes.push(n);

          textNodes.forEach(function (node) {
            var text = node.nodeValue;
            var lower = text.toLowerCase();
            if (lower.indexOf(qLower) === -1) return;

            var frag = document.createDocumentFragment();
            var pos = 0, idx;
            while ((idx = lower.indexOf(qLower, pos)) !== -1) {
              if (idx > pos) frag.appendChild(document.createTextNode(text.slice(pos, idx)));
              var mark = document.createElement("mark");
              mark.className = "wiki-search-highlight";
              mark.style.cssText = "background:#fff3a0;color:inherit;border-radius:2px;";
              mark.textContent = text.slice(idx, idx + query.length);
              frag.appendChild(mark);
              pos = idx + query.length;
            }
            if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
            node.parentNode.replaceChild(frag, node);
          });

          var first = this._contentEl.querySelector("mark.wiki-search-highlight");
          if (first) first.scrollIntoView({ behavior: "smooth", block: "center" });
        },

        // Public: every heading actually rendered in this page's content,
        // in document order, read straight off the live DOM rather than
        // re-walking the snapshot's node tree — sidesteps needing anchor
        // ids threaded through PostCardUtils.js's snapshotToHtml just to
        // support jump-to-heading navigation. `el` is the live heading
        // node itself, so a caller (WikiIndex.js's page-outline sidebar)
        // can scrollIntoView it directly. Only meaningful once content has
        // actually rendered (see open()'s opts.envelope for a synchronous
        // render, otherwise call after the async fetch has resolved).
        getOutline: function () {
          if (!this._contentEl) return [];
          return Array.prototype.map.call(
            this._contentEl.querySelectorAll("h1, h2, h3, h4, h5, h6"),
            function (el) {
              return { level: parseInt(el.tagName.substring(1), 10), text: el.textContent || "", el: el };
            },
          );
        },

        _renderDetails: function (envelope) {
          var self = this;
          this._cidEl.textContent =
            envelope.record && envelope.record.cid
              ? lively.identity.postCardUtils.truncateDid(envelope.record.cid)
              : "—";
          this._dateEl.textContent = "—";
          this._resolveVersionDate(envelope);
          this._visibilityEl.textContent = envelope.constellation || "—";

          var state = envelope.state || {};
          var contributorDids = Array.isArray(state.contributors) ? state.contributors : [];
          var lastEditedBy = state.lastEditedBy || null;
          var allDids = [envelope.did].concat(contributorDids);
          if (lastEditedBy) allDids.push(lastEditedBy);

          this._resolveHandles(allDids, function (didToHandle) {
            // The header line shows the handle the view was opened with (the
            // registered one); the author's resolved handle is their verified
            // domain when they have one, so make the two agree.
            if (didToHandle[envelope.did] && self._handleEl) {
              self._handleEl.textContent = "@" + didToHandle[envelope.did];
            }
            var topBarHandle = didToHandle[envelope.did] || self._handle;
            self._wireProfileClick(self._avatarImgEl, topBarHandle, envelope.did);
            self._wireProfileClick(self._handleEl, topBarHandle, envelope.did);
            self._renderAuthorRow(envelope.did, topBarHandle);
            self._renderContributorsRow(contributorDids, didToHandle);
            self._verify(envelope, lastEditedBy ? (didToHandle[lastEditedBy] || null) : null);
          });
        },

        // envelope.created is when the page was FIRST saved: every later save
        // carries it over from the previous envelope (WikiSerializer.js), so
        // it can't say when THIS version was written. The version's own time
        // is the createdAt of its row in GET .../versions. Falls back to
        // envelope.created when that list isn't readable (private page viewed
        // by a non-owner, network error) rather than showing nothing.
        _resolveVersionDate: function (envelope) {
          var self = this;
          var cid = envelope.record && envelope.record.cid;
          function fallback() { self._dateEl.textContent = self._formatDate(envelope.created); }
          if (!cid || !this._handle || !this._objId) return fallback();
          var base = lively.identity.did.baseUrl();
          var xhr = new XMLHttpRequest();
          xhr.open("GET", base + "/@" + encodeURIComponent(this._handle) + "/" +
            encodeURIComponent(this._objId) + "/versions", true);
          xhr.withCredentials = true;
          xhr.setRequestHeader("Accept", "application/json");
          xhr.onload = function () {
            if (xhr.status !== 200) return fallback();
            try {
              var versions = JSON.parse(xhr.responseText).versions || [];
              var match = versions.filter(function (v) { return v.cid === cid; })[0];
              if (match && match.createdAt) self._dateEl.textContent = self._formatDate(match.createdAt);
              else fallback();
            } catch (e) { fallback(); }
          };
          xhr.onerror = fallback;
          xhr.send();
        },

        _renderAuthorRow: function (did, handle) {
          this._authorRowEl.innerHTML = "";
          var label = document.createElement("span");
          label.textContent = "Author:";
          label.style.color = "#999";
          this._authorRowEl.appendChild(label);
          if (!handle) {
            var unknown = document.createElement("span");
            unknown.textContent = lively.identity.postCardUtils.truncateDid(did);
            this._authorRowEl.appendChild(unknown);
            return;
          }
          var chip = this._buildPersonChip(handle, did, 18);
          var handleText = document.createElement("span");
          handleText.textContent = "@" + handle;
          chip.el.appendChild(handleText);
          this._authorRowEl.appendChild(chip.el);
        },

        _renderContributorsRow: function (contributorDids, didToHandle) {
          this._contributorsRowEl.innerHTML = "";
          if (!contributorDids.length) return;
          var label = document.createElement("span");
          label.textContent = "Contributors:";
          label.style.color = "#999";
          this._contributorsRowEl.appendChild(label);

          var stack = document.createElement("span");
          stack.style.cssText = "display:inline-flex;align-items:center;";
          contributorDids.forEach(function (did, i) {
            var handle = didToHandle[did];
            if (!handle) return;
            var chip = this._buildPersonChip(handle, did, 18);
            chip.imgEl.style.marginLeft = i === 0 ? "0" : "-6px";
            stack.appendChild(chip.el);
          }, this);
          this._contributorsRowEl.appendChild(stack);
        },

        _formatDate: function (iso) {
          if (!iso) return "—";
          var d = new Date(iso);
          if (isNaN(d.getTime())) return iso;
          return (
            d.toLocaleDateString() +
            " " +
            d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          );
        },
      },

      "verification",
      {
        // Best-effort, display-only integrity check. lastEditedByHandle (the
        // resolved handle for envelope.state.lastEditedBy, IdentityServer.js's
        // _applyWikiContributorTracking) is who actually signed THIS version
        // — resolve their delegation cert instead of always this._handle's
        // (the genesis author's), which would be the wrong key for any
        // version saved by a co-editor. Falls back to this._handle when
        // lastEditedBy is unresolved/absent (pages with no co-editor saves
        // yet), matching PostCardView.js's identical single-author check.
        _verify: function (envelope, lastEditedByHandle) {
          var self = this;
          this._verifyBadgeEl.textContent = "Checking…";
          this._verifyBadgeEl.style.color = "#999";

          function finish(signerJwk) {
            lively.identity.crypto.verifyEnvelopeIntegrity(
              envelope,
              signerJwk || null,
              function (err, result) {
                self._verifyResult = result;
                self._renderVerifyBadge(
                  result || { cidValid: false, sigStatus: "unresolved" },
                );
              },
            );
          }

          if (!envelope.sig) return finish(null);
          lively.identity.did.resolveEnvelopeSignerJwk(
            lastEditedByHandle || this._handle,
            function (err, jwk) {
              finish(err ? null : jwk);
            },
          );
        },

        _renderVerifyBadge: function (result) {
          var label, color;
          if (!result.cidValid) {
            label = "⚠ Content tampered";
            color = "#c33";
          } else if (result.sigStatus === "verified") {
            label = "✓ Verified";
            color = "#2a7";
          } else if (result.sigStatus === "unsigned") {
            label = "Unsigned";
            color = "#999";
          } else if (result.sigStatus === "unresolved") {
            label = "Unable to verify";
            color = "#d5d52c";
          } else {
            label = "✕ Signature invalid";
            color = "#c33";
          }
          this._verifyBadgeEl.textContent = label;
          this._verifyBadgeEl.style.color = color;
        },
      },

      "sharing",
      {
        // Small dropdown anchored under the "more" button, appended to
        // document.body rather than nested inside this morph's own
        // shapeNode -- the wrapper/shapeNode both set overflow:hidden (see
        // _buildChrome), which would clip a menu popping out below the top
        // bar. Toggle: a second click on the same button (or any outside
        // mousedown) closes it.
        _toggleMoreMenu: function (anchorBtn) {
          if (this._moreMenuEl) { this._closeMoreMenu(); return; }
          var self = this;
          var rect = anchorBtn.getBoundingClientRect();
          var menu = document.createElement("div");
          menu.style.cssText = [
            "position:fixed", "z-index:9999",
            "top:" + Math.round(rect.bottom + 4) + "px",
            "left:" + Math.round(rect.right - 160) + "px",
            "width:160px", "background:#fff", "border:1px solid #ddd",
            "border-radius:8px", "box-shadow:0 4px 14px rgba(0,0,0,0.2)",
            "padding:4px", "font-family:sans-serif", "font-size:13px",
            "box-sizing:border-box",
          ].join(";");

          var makeItem = function (label, iconName, onClick, danger) {
            var item = document.createElement("div");
            item.style.cssText = [
              "display:flex", "align-items:center", "gap:8px",
              "padding:7px 10px", "border-radius:5px", "cursor:pointer",
              "color:" + (danger ? "#c33" : "#333"),
            ].join(";");
            item.innerHTML =
              '<span class="material-symbols-rounded" style="font-size:16px;color:' + (danger ? "#c33" : "#666") + ';">' + iconName + '</span>' +
              '<span>' + label + '</span>';
            item.addEventListener("mouseenter", function () { item.style.background = "#f2f2f2"; });
            item.addEventListener("mouseleave", function () { item.style.background = "transparent"; });
            ["mousedown", "click"].forEach(function (t) {
              item.addEventListener(t, function (e) {
                e.preventDefault();
                e.stopPropagation();
                if (t === "click") { self._closeMoreMenu(); onClick(); }
              });
            });
            return item;
          };

          if (this._canEdit) {
            menu.appendChild(makeItem("Edit", "edit", function () { self._handleEditClick(); }));
          }
          menu.appendChild(makeItem("Copy link", "link", function () { self._copyShareLink(); }));
          menu.appendChild(makeItem("Download", "download", function () { self._downloadPage(); }));
          // Full-page views only: embedded fixed-size cards (lounge feed,
          // canvas placement) have no room for the two-column panel.
          if (this._autoHeight) {
            menu.appendChild(makeItem("History", "history", function () { self._openHistory(); }));
          }
          if (this._canDelete) {
            menu.appendChild(makeItem("Delete page", "delete", function () { self._confirmDeletePage(); }, true));
          }

          document.body.appendChild(menu);
          this._moreMenuEl = menu;

          // Deferred registration: the same click that opened the menu is
          // still bubbling/capturing at this point, and would otherwise
          // immediately trigger this handler and close the menu it just
          // opened.
          this._moreMenuOutsideHandler = function (e) {
            if (menu.contains(e.target) || e.target === anchorBtn) return;
            self._closeMoreMenu();
          };
          setTimeout(function () {
            document.addEventListener("mousedown", self._moreMenuOutsideHandler, true);
          }, 0);
        },

        _closeMoreMenu: function () {
          if (!this._moreMenuEl) return;
          this._moreMenuEl.remove();
          this._moreMenuEl = null;
          if (this._moreMenuOutsideHandler) {
            document.removeEventListener("mousedown", this._moreMenuOutsideHandler, true);
            this._moreMenuOutsideHandler = null;
          }
        },

        // Swaps the page body for the version-history panel (WikiHistory.js);
        // its "Back to page" button swaps it back.
        _openHistory: function () {
          if (!this._objId || !this._envelope) return;
          lively.identity.WikiHistory.open(this);
        },

        // History panel's Restore: swaps this view for the editor exactly like
        // Edit does, but hands it an old version's content ({snapshot,
        // attachments}) to apply and save as a new version. The editor returns
        // to a read-only view through the same onSaved swap once that save
        // lands; if the save fails it stays open on the restored content.
        // Needs write access, same as Edit (the editor re-checks it).
        _restoreVersion: function (restore) {
          var self = this;
          lively.identity.PasskeyPrimingDialog.maybeShow(function () {
            if (self._onEdit) self._onEdit(self._handle, self._objId, self, restore);
            else self._startEditDefault(restore);
          });
        },

        // Top entry of the "more" menu when _canEdit is true -- was
        // previously its own dedicated top-bar button; same behavior,
        // just reached through the menu now.
        _handleEditClick: function () {
          var self = this;
          // Saving a wiki page signs its envelope with the device's soft
          // signing key, unwrapped via a WebAuthn PRF ceremony
          // (WikiSerializer.js's _signEnvelopeIfPossible) -- warn before
          // the editor opens rather than let that prompt surface
          // unannounced on first autosave.
          lively.identity.PasskeyPrimingDialog.maybeShow(function () {
            if (self._onEdit) self._onEdit(self._handle, self._objId, self);
            else self._startEditDefault();
          });
        },

        // Canonical page URL: /@handle/wiki/:pageName (personal) or
        // /c/:constellation/wiki/:pageName -- the same human-friendly-name
        // routes IdentityServer.js serves as this page's own SSR share-link
        // page (see file header). Falls back to the current location for
        // the rare case a page has no state.wikiName (envelope hasn't been
        // resaved since wiki pages gained named routing).
        _buildShareUrl: function () {
          var envelope = this._envelope;
          var wikiName = envelope && envelope.state && envelope.state.wikiName;
          if (!wikiName) return window.location.href;
          var base = lively.identity.did.baseUrl();
          return this._constellation
            ? base + "/c/" + encodeURIComponent(this._constellation) + "/wiki/" + encodeURIComponent(wikiName)
            : base + "/@" + encodeURIComponent(this._handle) + "/wiki/" + encodeURIComponent(wikiName);
        },

        _copyShareLink: function () {
          var url = this._buildShareUrl();
          var self = this;
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url)
              .then(function () { self._flashNearMoreBtn("Link copied"); })
              .catch(function () { window.prompt("Copy this link:", url); });
          } else {
            window.prompt("Copy this link:", url);
          }
        },

        // Exports the currently-rendered content as a standalone HTML file
        // (title + the same content DOM already on screen, plus the KaTeX/
        // highlight.js stylesheets it depends on) -- simplest faithful
        // export given content only exists as rendered HTML client-side
        // (WikiSerializer.js's snapshot format has no markdown form).
        _downloadPage: function () {
          var envelope = this._envelope;
          var title = (envelope && envelope.state && envelope.state.title) || "wiki-page";
          var esc = lively.identity.postCardUtils.escapeHtml;
          var contentHtml = this._contentEl ? this._contentEl.innerHTML : "";
          var doc = "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" +
            "<title>" + esc(title) + "</title>" +
            "<link rel=\"stylesheet\" href=\"" + window.location.origin + "/core/lib/postcard/katex.min.css\">" +
            "<link rel=\"stylesheet\" href=\"" + window.location.origin + "/core/lib/postcard/hljs-github.css\">" +
            "<style>body{font-family:sans-serif;max-width:800px;margin:40px auto;padding:0 20px;" +
            "color:#222;line-height:1.5;}img{max-width:100%;}</style></head><body>" +
            "<h1>" + esc(title) + "</h1>" + contentHtml + "</body></html>";
          var blob = new Blob([doc], { type: "text/html" });
          var url = URL.createObjectURL(blob);
          var a = document.createElement("a");
          a.href = url;
          a.download = this._slugify(title) + ".html";
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(url); }, 30 * 1000);
          this._flashNearMoreBtn("Downloaded");
        },

        // Plain DOM confirm overlay on document.body (not inside this morph's
        // shapeNode -- see CLAUDE.md on native-DOM dialogs over a world).
        // Deleting is permanent (every stored version is removed, nothing to
        // restore), so this spells that out rather than a generic "Are you
        // sure?".
        _confirmDeletePage: function () {
          var self = this;
          var esc = lively.identity.postCardUtils.escapeHtml;
          var title = (this._envelope && this._envelope.state &&
            (this._envelope.state.wikiName || this._envelope.state.title)) || "this page";

          var scrim = document.createElement("div");
          scrim.style.cssText = [
            "position:fixed", "top:0", "left:0", "right:0", "bottom:0", "z-index:10000",
            "background:rgba(0,0,0,0.35)", "display:flex", "align-items:center",
            "justify-content:center", "font-family:sans-serif",
          ].join(";");
          var box = document.createElement("div");
          box.style.cssText = [
            "width:360px", "max-width:calc(100vw - 32px)", "background:#fff",
            "border-radius:12px", "box-shadow:0 8px 30px rgba(0,0,0,0.3)",
            "padding:20px", "box-sizing:border-box", "color:#333",
          ].join(";");
          box.innerHTML =
            '<div style="font-size:16px;font-weight:600;margin-bottom:8px;">Delete “' + esc(title) + '”?</div>' +
            '<div style="font-size:13px;line-height:1.45;color:#555;">This permanently deletes the page and its ' +
            'entire edit history. It can’t be undone.</div>' +
            '<div data-role="error" style="font-size:12px;color:#c33;margin-top:10px;display:none;"></div>' +
            '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px;"></div>';
          var errEl = box.querySelector('[data-role="error"]');
          var row = box.lastChild;

          var makeBtn = function (text, bg, color) {
            var b = document.createElement("button");
            b.textContent = text;
            b.style.cssText = [
              "border:none", "border-radius:8px", "padding:7px 16px", "font-size:13px",
              "cursor:pointer", "background:" + bg, "color:" + color,
            ].join(";");
            return b;
          };
          var cancelBtn = makeBtn("Cancel", "#eee", "#333");
          var deleteBtn = makeBtn("Delete", "#c33", "#fff");
          row.appendChild(cancelBtn);
          row.appendChild(deleteBtn);
          scrim.appendChild(box);
          document.body.appendChild(scrim);

          var close = function () { scrim.remove(); };
          cancelBtn.addEventListener("click", close);
          scrim.addEventListener("mousedown", function (e) { if (e.target === scrim) close(); });
          deleteBtn.addEventListener("click", function () {
            deleteBtn.disabled = cancelBtn.disabled = true;
            deleteBtn.textContent = "Deleting…";
            errEl.style.display = "none";
            self._deletePage(function (errMsg) {
              if (!errMsg) return close();
              deleteBtn.disabled = cancelBtn.disabled = false;
              deleteBtn.textContent = "Delete";
              errEl.textContent = errMsg;
              errEl.style.display = "block";
            });
          });
        },

        // DELETE /@handle/:objId/wikipage -- the server decides (author, or
        // a constellation controller) and removes the page's rows outright.
        // thenDo(errMsg|null). On success an embedding caller's onDeleted
        // hook takes over (WikiIndex.js swaps the page out of its slot);
        // otherwise this is a standalone page that no longer exists, so
        // navigate to the wiki index it belonged to.
        _deletePage: function (thenDo) {
          var self = this;
          var base = lively.identity.did.baseUrl();
          var url = base + "/@" + encodeURIComponent(this._handle) + "/" +
            encodeURIComponent(this._objId) + "/wikipage";
          var xhr = new XMLHttpRequest();
          xhr.open("DELETE", url, true);
          xhr.withCredentials = true;
          xhr.setRequestHeader("Accept", "application/json");
          xhr.onload = function () {
            if (xhr.status !== 200) {
              var msg = "Delete failed (" + xhr.status + ")";
              try { msg = JSON.parse(xhr.responseText).error || msg; } catch (e) {}
              return thenDo(msg);
            }
            thenDo(null);
            if (self._onDeleted) return self._onDeleted(self._handle, self._objId, self);
            window.location.href = self._constellation
              ? base + "/c/" + encodeURIComponent(self._constellation) + "/wiki"
              : base + "/@" + encodeURIComponent(self._handle) + "/wiki";
          };
          xhr.onerror = function () { thenDo("Network error deleting the page"); };
          xhr.send();
        },

        _slugify: function (s) {
          return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "wiki-page";
        },

        // Local fade-out confirmation bubble -- this file has no shared
        // toast/status component to reuse, and a one-off action like this
        // doesn't warrant pulling one in.
        _flashNearMoreBtn: function (text) {
          if (!this._topBarEl) return;
          var bubble = document.createElement("div");
          bubble.textContent = text;
          bubble.style.cssText = [
            "position:absolute", "top:36px", "right:8px",
            "font-size:11px", "padding:3px 8px", "border-radius:6px",
            "background:#333", "color:#fff", "white-space:nowrap",
            "opacity:0", "transition:opacity 0.15s", "pointer-events:none", "z-index:5",
          ].join(";");
          this._topBarEl.appendChild(bubble);
          requestAnimationFrame(function () { bubble.style.opacity = "1"; });
          setTimeout(function () {
            bubble.style.opacity = "0";
            setTimeout(function () { bubble.remove(); }, 200);
          }, 1200);
        },
      },
    );

    // ─── class-side entry points ─────────────────────────────────────────────────

    Object.extend(WikiViewClass, {
      // Tracks the single standalone (non-embedded) WikiView currently in
      // the world, so opening another topic replaces it instead of piling
      // up a new box on top — see _openInWorld.
      _currentWorldView: null,

      // Opens the view as a plain self-rendering Box morph directly in the
      // world — same pattern as lively.commerce.Shop.open, no
      // lively.morphic.Window chrome. Centered on the visible world bounds.
      // Only one standalone WikiView is ever in the world at a time: opening
      // a new topic removes whichever one is already there first.
      _openInWorld: function (view) {
        if (WikiViewClass._currentWorldView && WikiViewClass._currentWorldView.world()) {
          WikiViewClass._currentWorldView.remove();
        }
        WikiViewClass._currentWorldView = view;
        var extent = view.getExtent();
        view.openInWorld(lively.morphic.World.current().visibleBounds().center().subPt(extent.scaleBy(0.5)));
        // To the back, not the front: the page is the backdrop of its world.
        // openInWorld has just put the view on top of everything, including a
        // window the visitor opened earlier and the menu bar, and a re-open
        // (Save swaps the editor for a new view) happens with those already
        // there. The first open of a page is unaffected: nothing else exists yet.
        view.sendToBack();
        WikiViewClass._disableWorldRename();
      },

      // A standalone WikiView boots into its own ephemeral per-object world
      // (IdentityServer.js's buildPostCardPage), which — like any Lively
      // world — gets the generic WorldNameMenuBarEntry by default. Its
      // "rename this world" action serializes the *entire current world*
      // as a fresh type:"world" envelope and PUTs it to whatever objId is
      // in the current URL, with no idea a real wikipage envelope already
      // lives there — confirmed live: this silently clobbered a real wiki
      // page's content. IdentityServer.js's PUT handler now rejects a
      // type-mismatched overwrite server-side regardless, but the action
      // is also meaningless here (a single wiki page isn't "a world" to
      // rename), so it's disabled at the source too.
      _disableWorldRename: function () {
        var attempts = 0;
        (function tryDisable() {
          var menuBar = typeof $world !== "undefined" && $world && $world.get(/^MenuBar/);
          var entry = menuBar &&
            (menuBar.submorphs || []).find(function (m) { return m.name === "WorldNameMenuBarEntry"; });
          if (entry) {
            entry.renamePrompt = function () {
              $world.alert("This page is a single wiki page, not a renameable Lively world.");
            };
            return;
          }
          if (++attempts > 25) return;
          setTimeout(tryDisable, 200);
        })();
      },

      // options.target      -> embed via target.addMorph(view)
      // options.envelope    -> render immediately, skip the fetch
      // options.cid         -> view a specific historical version
      // options.bounds      -> override the default extent
      // options.onEdit(handle, objId, view) -> caller-supplied hook fired by
      // the Edit button, mirroring WikiEditor's opts.onSaved -- lets an
      // embedding caller (e.g. WikiIndex.js) swap this view for an editor in
      // its own managed slot. If omitted, the view falls back to swapping
      // itself for a standalone editor in place -- see _startEditDefault.
      // options.onDeleted(handle, objId, view) -> fired after the "Delete
      // page" menu entry has permanently deleted this page server-side. If
      // omitted, the view navigates to the wiki index its page belonged to.
      // options.autoHeight  -> grow with content instead of scrolling
      // internally (default: true when standalone, false when embedded via
      // options.target)
      // options.onHeightChanged(view, height) -> fired after each auto resize
      // options.highlightQuery -> wrap+scroll to every occurrence of this
      // term in the rendered content once it's loaded (WikiIndex.js's
      // content-search dropdown), see _renderContentArea/_applyHighlight
      open: function (handle, objId, options) {
        var opts = options || {};
        var view = new lively.identity.WikiView(
          opts.bounds || lively.rect(0, 0, 1180, 780),
        );
        view.setName("WikiView");
        view._handle = handle;
        view._objId = objId;
        view._cid = opts.cid || null;
        view._envelope = opts.envelope || null;
        view._onEdit = opts.onEdit || null;
        view._onDeleted = opts.onDeleted || null;
        view._highlightQuery = opts.highlightQuery || null;
        view._pinkHandle = !!opts.pinkHandle;
        view._openHistoryOnLoad = !!opts.openHistory;
        // Embedded views (opts.target) keep their fixed box unless the
        // caller opts in; a standalone page view is the whole document, so
        // it grows by default.
        view._autoHeight = opts.autoHeight !== undefined ? !!opts.autoHeight : !opts.target;
        view._onHeightChanged = opts.onHeightChanged || null;
        if (opts.target) {
          opts.target.addMorph(view);
          view._setup();
        } else {
          this._openInWorld(view);
          view._setup();
        }
        return view;
      },
    });
  }); // end module('lively.identity.WikiView')
