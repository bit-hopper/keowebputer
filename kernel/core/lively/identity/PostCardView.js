/**
 * lively.identity.PostCardView
 *
 * Read-only "physical postcard" morph — the counterpart to PostCardEditor
 * (which is now owner-only, editing-only). PostCardView is the single
 * rendering path for looking at a postcard you aren't actively editing:
 * a front side (avatar, title, content) and a back side (stamp, DID/CID,
 * signature-verification badge), joined by a CSS 3D flip triggered by a
 * dedicated flip-icon button.
 *
 * Content rendering has two paths, both landing in the same
 * lively.identity.postCardUtils.snapshotToHtml/hydrateEmbeddedParts
 * rendering — no Yjs/ProseMirror dependency either way:
 *   - Public envelopes: the plaintext ProseMirror-doc snapshot is already
 *     in the envelope, rendered directly.
 *   - Private/shared envelopes: there is no plaintext snapshot in an
 *     encrypted envelope (by design), so the front face first shows a
 *     "locked" placeholder; its "View content" action calls
 *     PostCardSerializer.deserializeEncryptedAuto (_decryptAndRenderContent)
 *     to decrypt in place — a legacy pre-plain/wiki-split ('wiki' mode)
 *     envelope's Y.Doc is turned into the same snapshot shape via
 *     PostCardSerializer._extractSnapshot first. Any attachment referenced
 *     only by objId (unresolved until decrypted) renders as a placeholder
 *     hydrateAttachments then resolves to a session-local blob: URL via
 *     FileCrypto.resolveAttachmentUrl. No separate editor window is
 *     involved at all — this used to open PostCardEditor in a forced-
 *     read-only mode purely as a decrypt engine, which pulled in the
 *     entire ProseMirror/Yjs/autosave/toolbar/send-flow editor just to
 *     show static content.
 *
 * Entry point:
 *   lively.identity.PostCardView.open(handle, objId, options)
 *     options.target      -> embed via target.addMorph(view) instead of a window
 *     options.envelope    -> render immediately, skip the fetch
 *     options.cid         -> view a specific historical version
 *     options.bounds      -> override the default postcard-shaped extent
 *
 * doNotSerialize list: every raw DOM node this morph manages directly
 * (mirrors PostCardEditor.js's own doNotSerialize for the same reason —
 * DOM nodes aren't part of Lively's object graph and are rebuilt by
 * _setup() on next open).
 */

module("lively.identity.PostCardView")
  .requires(
    "lively.identity.PostCardUtils",
    "lively.identity.DID",
    "lively.identity.Crypto",
    "lively.identity.PostCardEditor",
    "lively.identity.PostCardSerializer",
    "lively.identity.FileCrypto",
  )
  .toRun(function () {
    var PostCardViewClass = lively.morphic.Box.subclass(
      "lively.identity.PostCardView",

      "serialization",
      {
        doNotSerialize: [
          "_wrapperEl",
          "_cardEl",
          "_frontEl",
          "_backEl",
          "_avatarImgEl",
          "_handleEl",
          "_titleEl",
          "_contentEl",
          "_stampEl",
          "_stampLayerEl",
          "_postmarkEl",
          "_hostRowEl",
          "_hostEl",
          "_addrEl",
          "_didEl",
          "_cidEl",
          "_dateEl",
          "_visibilityEl",
          "_verifyBadgeEl",
          "_moreBtn",
          "_audienceChipEl",
          "_editChipEl",
          "_moreMenuEl",
          "_moreMenuOutsideHandler",
          "_footerEl",
          "_pillsWrapEl",
          "_contentLoadStarted",
          "_decryptInFlight",
        ],
      },

      "initialization",
      {
        // Callable more than once on the same instance — see
        // prepareForNewRenderContext below, which re-runs this after a saved
        // world is reloaded (or the morph is copied), since none of the DOM
        // this builds survives serialization (see doNotSerialize). Does NOT
        // reset this._envelope: open() may have already set it from
        // options.envelope (skip-the-fetch case), and that must survive this
        // running as part of the normal open() call sequence.
        _setup: function () {
          // Same rationale as PostCardEditor._setup: this morph is either
          // embedded (ConstellationCanvas/ConstellationLounge manage its position
          // themselves) or windowed (openInWindow's title bar is the drag
          // handle) — either way, this morph's own body-dragging must not
          // fight with those.
          this.disableDragging();
          this.disableGrabbing();
          this._flipped = false;
          this._isOwner = false;
          this._verifyResult = null;
          this._buildChrome();

          // Guards against double-firing the content-load dispatch below —
          // same race as PostCardEditor.js's identical guard: open() calls
          // _setup() explicitly right after opening this morph in a window,
          // but attaching to that window's new render context *also*
          // triggers prepareForNewRenderContext below, which (by the time
          // _handle is set) calls _setup() again in the same turn. Without
          // this, _loadEnvelope() could fire twice (two redundant GETs,
          // each re-running _verify()/_loadReactions() on completion).
          // doNotSerialize'd so a genuine future restore still starts
          // falsy and loads normally.
          if (this._contentLoadStarted) return;
          this._contentLoadStarted = true;
          if (this._envelope) this._renderEnvelope(this._envelope);
          else this._loadEnvelope();
        },

        // Fires once at construction (before open() has set _handle — the
        // guard below skips that no-op call, open() runs _setup() itself once
        // configured) and again, recursively, on every submorph whenever a
        // saved world is reloaded or this morph is copied (see
        // Rendering.js's prepareForNewRenderContext, which is exactly the
        // "lively.morphic.Text re-populates its content here after restore"
        // hook, applied to this morph's own hand-built DOM). _handle/_objId
        // survive serialization fine (plain fields); the DOM in _wrapperEl
        // etc. does not, hence rebuilding chrome here. _envelope is cleared
        // first so a restore always re-fetches current content and a fresh
        // verification result, rather than showing a save-time snapshot.
        //
        // Also fires as an *immediate* same-turn duplicate of open()'s own
        // explicit _setup() call, when attaching this morph to its new
        // window triggers a render-context change — see _setup()'s own
        // _contentLoadStarted guard, which is what makes that safe. One
        // residual wrinkle in that race specifically: this._envelope = null
        // below still runs before the (now-guarded) _setup(), so an
        // options.envelope skip-the-fetch open() can still lose its
        // pre-supplied envelope and fall through to _loadEnvelope() instead
        // — a redundant fetch, not a correctness bug (the fetched envelope
        // is equivalent), and not addressed here.
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
          shapeNode.style.boxShadow = this._compactMode ? "0 2px 10px rgba(0,0,0,.10)" : "0 4px 14px rgba(0,0,0,0.2)";
          shapeNode.style.overflow = "visible"; // perspective needs room, not clipping

          var wrapper = document.createElement("div");
          wrapper.className = "lively-postcard-view-wrapper";
          wrapper.style.cssText =
            "position:absolute;inset:0;perspective:1200px;";
          shapeNode.appendChild(wrapper);
          this._wrapperEl = wrapper;

          var card = document.createElement("div");
          card.className = "lively-postcard-view-card";
          card.style.cssText = [
            "position:relative",
            "width:100%",
            "height:100%",
            "transform-style:preserve-3d",
            "transition:transform 500ms ease",
            "transform:rotateY(0deg)",
          ].join(";");
          wrapper.appendChild(card);
          this._cardEl = card;

          this._frontEl = this._buildFace(card, false);
          this._buildFrontContents(this._frontEl);
          // A compact "mini card" (ConstellationLounge.js's Scroll view)
          // never flips — skip building the back face/verify-badge DOM
          // entirely rather than building it dead. _renderEnvelope guards
          // the calls (_renderBackMeta/_verify) that would otherwise touch
          // these never-built elements.
          if (!this._compactMode) {
            this._backEl = this._buildFace(card, true);
            this._buildBackContents(this._backEl);
          }

          ["mousedown", "click", "dblclick"].forEach(function (t) {
            wrapper.addEventListener(t, function (e) {
              // Let the click through to real content (links, the flip/edit
              // buttons below, which stop propagation themselves) but keep it
              // from reaching Lively's own drag/selection handling — same
              // rationale as PostCardEditor.js's pmDiv listeners.
              if (e.target === wrapper || e.target === card) return;
            });
          });
        },

        _buildFace: function (card, isBack) {
          var face = document.createElement("div");
          face.className =
            "lively-postcard-view-face " + (isBack ? "back" : "front");
          face.style.cssText = [
            "position:absolute",
            "inset:0",
            "backface-visibility:hidden",
            "border-radius:10px",
            "overflow:hidden",
            "box-sizing:border-box",
            "font-family:sans-serif",
            "background:#fff",
            isBack ? "transform:rotateY(180deg)" : "",
          ].join(";");
          card.appendChild(face);
          return face;
        },

        _buildFrontContents: function (front) {
          var self = this;

          var avatar = document.createElement("img");
          avatar.className = "lively-postcard-view-avatar";
          avatar.style.cssText = [
            "position:absolute",
            "top:10px",
            "left:10px",
            "width:32px",
            "height:32px",
            "border-radius:50%",
            "box-shadow:0 0 0 2px #fff, 0 1px 3px rgba(0,0,0,0.3)",
          ].join(";");
          front.appendChild(avatar);
          this._avatarImgEl = avatar;

          // Handle sits beside the avatar, vertically centered on it (same
          // top/height band as the avatar, flex-centered so it doesn't depend
          // on guessing the text's line-height) — known immediately from
          // this._handle, so it doesn't have to wait on _renderEnvelope like
          // the title below it does.
          var handleEl = document.createElement("div");
          handleEl.className = "lively-postcard-view-handle";
          handleEl.style.cssText = [
            "position:absolute",
            "top:10px",
            "left:52px",
            "right:40px",
            "height:32px",
            "display:flex",
            "align-items:center",
            "font-size:11px",
            // Pink only when embedded by the lounge (opts.pinkHandle).
            "color:" + (this._pinkHandle ? "#CC0057" : "#888"),
            "white-space:nowrap",
            "overflow:hidden",
            "text-overflow:ellipsis",
          ].join(";");
          handleEl.textContent = "@" + this._handle;
          front.appendChild(handleEl);
          this._handleEl = handleEl;

          // Title falls below the avatar/handle row rather than beside it.
          var title = document.createElement("div");
          title.className = "lively-postcard-view-title";
          title.style.cssText = [
            "position:absolute",
            "top:48px",
            "left:14px",
            "right:14px",
            "font-size:15px",
            "font-weight:600",
            "color:#222",
            "white-space:nowrap",
            "overflow:hidden",
            "text-overflow:ellipsis",
          ].join(";");
          front.appendChild(title);
          this._titleEl = title;

          var content = document.createElement("div");
          content.className = "lively-postcard-view-content selectable";
          // Compact ("mini card") content is a plain-text excerpt clamped
          // to 2 lines instead of an internally-scrolling rich area — see
          // _renderContentHtml's compact branch. setCommentsExpanded toggles
          // the clamp class off while this card's comment accordion is open
          // (the caption un-clamps alongside the comment thread appearing).
          content.style.cssText = self._compactMode ? [
            "position:absolute",
            "top:76px",
            "left:14px",
            "right:14px",
            "bottom:32px",
            "font-size:13px",
            "line-height:1.5",
            "color:#333",
            "box-sizing:border-box",
          ].join(";") : [
            "position:absolute",
            "top:76px",
            "left:0",
            "right:0",
            "bottom:32px", // leave room for the reactions footer below
            "padding:8px 14px 14px",
            "overflow-y:auto",
            "font-size:13px",
            "line-height:1.5",
            "color:#333",
            "box-sizing:border-box",
          ].join(";");
          if (self._compactMode) {
            self._ensureCompactContentStyle();
            content.classList.add("pcv-compact-clamped");
          }
          // BUG FIX: native mouse-wheel scrolling of this div silently did
          // nothing — confirmed live (real hardware wheel, not a synthetic
          // event) on the ConstellationLounge reel: genuine overflow
          // (scrollHeight > clientHeight), a real trusted 'wheel' event
          // correctly reaching this element with defaultPrevented:false and
          // a normal deltaY, zero 'scroll' events ever fired, yet a direct
          // `content.scrollTop = n` JS write worked instantly. Isolated to
          // this div's specific DOM position — a sibling morph's own
          // shapeNode with the identical overflow-y:auto pattern
          // (ConstellationLounge.js's _spacesBox/_membersBox) scrolls fine
          // with real wheel input; the difference is that THIS div sits two
          // levels inside the morph's own hand-built chrome, with an
          // overflow:hidden parent (`.lively-postcard-view-face.front`,
          // _buildChrome) wrapping it inside a transformed/composited
          // ancestor chain (frontCardBox's `.lounge-reel-card`, the view's
          // own shapeNode) — a known class of Chromium compositor
          // "non-fast scrollable region" bug where that combination isn't
          // registered for hardware-wheel fast-path scrolling, even though
          // JS scrollTop writes and CDP-injected synthetic wheel events
          // (which is why this never showed up in automated testing) both
          // work fine. Fix: don't rely on the browser's native wheel
          // default action here — scroll it ourselves from the event and
          // prevent the (broken) native attempt from doing anything.
          // Compact mode never shows rich content (plain-text excerpt only,
          // see _renderContentHtml) so there's no embedded media to scroll
          // past or click into — skip both listeners entirely.
          if (!this._compactMode) {
            content.addEventListener("wheel", function (e) {
              // Scroll-chaining: only eat the event (and manually move
              // scrollTop, working around the Chromium non-fast-scrollable-
              // region bug described above) when this div actually has more
              // room to scroll in that direction — otherwise let it bubble
              // so an outer scrollable ancestor (e.g. the Scroll view's
              // card-list box) can take it instead.
              var atTop = content.scrollTop <= 0;
              var atBottom = content.scrollTop + content.clientHeight >= content.scrollHeight - 1;
              if ((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom)) return;
              content.scrollTop += e.deltaY;
              e.preventDefault();
            }, { passive: false });

            // Click a photo to view it whole inside the card; the viewer's own
            // full-screen icon opens the full-screen one (PostCardUtils.openImageViewer).
            content.addEventListener("click", function (e) {
              var t = e.target;
              if (!t || t.tagName !== "IMG" || !/lively-postcard-image/.test(t.className) || !t.src) return;
              var imgs = Array.prototype.filter.call(
                content.querySelectorAll("img.lively-postcard-image"),
                function (i) { return !!i.src; });
              lively.identity.postCardUtils.openImageViewer(imgs, imgs.indexOf(t), { container: content.parentNode });
            });
          }
          front.appendChild(content);
          this._contentEl = content;

          this._buildReactionsFooter(front);

          // A compact "mini card" never flips (no back face/verify badge —
          // see _buildChrome) and hides the "more" menu (Edit/Save/Share/
          // Delete stays reachable via the Reel or opening the card
          // directly) — confirmed decision, ConstellationLounge.js's Scroll
          // view plan.
          if (this._compactMode) return;

          var flipBtn = this._buildIconButton(
            "front",
            "⟳",
            "Flip to see verification info",
            function () {
              self._toggleFlip();
            },
          );
          flipBtn.style.right = "10px";
          flipBtn.style.bottom = "10px";
          front.appendChild(flipBtn);

          // "More" menu -- Edit (owner only) and Save to Collections (any
          // viewer). Edit used to be its own dedicated button in this same
          // top-right corner; folded into the menu so a non-owner viewer
          // also has somewhere to reach Save to Collections from (see
          // WikiView.js's identical Edit-button-to-menu migration).
          var moreBtn = document.createElement("button");
          moreBtn.innerHTML = '<span class="material-symbols-rounded" style="font-size:16px;line-height:1;">more_vert</span>';
          moreBtn.title = "More";
          moreBtn.style.cssText = [
            "position:absolute",
            "top:8px",
            "right:8px",
            "width:24px",
            "height:24px",
            "padding:0",
            "cursor:pointer",
            "display:flex",
            "align-items:center",
            "justify-content:center",
            "border:1px solid #ccc",
            "border-radius:50%",
            "background:#fff",
            "color:#555",
          ].join(";");
          ["mousedown", "click"].forEach(function (t) {
            moreBtn.addEventListener(t, function (e) {
              e.preventDefault();
              e.stopPropagation();
              if (t === "click") self._toggleMoreMenu(moreBtn);
            });
          });
          front.appendChild(moreBtn);
          this._moreBtn = moreBtn;
          this._renderAudienceChip();
        },

        // Opt-in (options.audienceChip / setAudienceChip): a small pill in the handle
        // row that says who the card is shared with. chip = { label, icon?, title?,
        // onClick? }; with no onClick it is a plain label (what a viewer sees), with
        // one it is a button (the owner's, which opens the audience dialog). null
        // removes it. The handle text gives up the room the chip takes.
        setAudienceChip: function (chip) {
          this._audienceChip = chip || null;
          this._renderAudienceChip();
        },

        _renderAudienceChip: function () {
          if (!this._frontEl) return;
          var self = this;
          if (this._audienceChipEl) {
            this._audienceChipEl.remove();
            this._audienceChipEl = null;
          }
          var chip = this._audienceChip;
          if (this._handleEl) this._handleEl.style.right = "40px";
          if (!chip || !chip.label) { this._renderEditChip(); return; }
          var clickable = typeof chip.onClick === "function";
          var el = document.createElement(clickable ? "button" : "div");
          el.className = "lively-postcard-view-audience-chip";
          if (chip.title) el.title = chip.title;
          var icon = chip.icon
            ? '<span class="material-symbols-rounded" style="font-size:14px;line-height:1;margin-right:4px;">' + chip.icon + "</span>"
            : "";
          el.innerHTML = icon + "<span></span>";
          el.lastChild.textContent = chip.label;
          el.style.cssText = [
            "position:absolute",
            "top:13px",
            "right:40px",
            "height:26px",
            "box-sizing:border-box",
            "display:flex",
            "align-items:center",
            "padding:0 10px",
            "border-radius:13px",
            "font-size:11px",
            "white-space:nowrap",
            "border:1px solid " + (clickable ? "#e8497e" : "#ddd"),
            "background:" + (clickable ? "#fdeef3" : "#fafafa"),
            "color:" + (clickable ? "#CC0057" : "#666"),
            "cursor:" + (clickable ? "pointer" : "default"),
          ].join(";");
          if (clickable) {
            ["mousedown", "click"].forEach(function (t) {
              el.addEventListener(t, function (e) {
                e.preventDefault();
                e.stopPropagation();
                if (t === "click") chip.onClick(self);
              });
            });
          }
          this._frontEl.appendChild(el);
          this._audienceChipEl = el;
          // The handle text ends before the chip begins (40px for the menu button,
          // the chip's own width, and a gap). offsetWidth is 0 until the card is laid
          // out; 140 is a generous stand-in so a long handle still ellipsizes clear of it.
          if (this._handleEl) {
            this._handleEl.style.right = (40 + (el.offsetWidth || 140) + 8) + "px";
          }
          this._renderEditChip();
        },

        // Opt-in (setEditChip): an "Edited 3 days ago" pill that sits just left of the
        // audience chip (or of the menu button when there is none). chip = { label,
        // title?, onClick }; null removes it. Clicking it opens what changed.
        setEditChip: function (chip) {
          this._editChip = chip || null;
          this._renderEditChip();
        },

        _renderEditChip: function () {
          if (!this._frontEl) return;
          var self = this;
          if (this._editChipEl) {
            this._editChipEl.remove();
            this._editChipEl = null;
          }
          var chip = this._editChip;
          if (!chip || !chip.label) return;
          // Same 40px (menu button) + the audience chip's own width + a gap, as the
          // audience chip itself uses; 140 stands in until the card is laid out.
          var audW = this._audienceChipEl ? (this._audienceChipEl.offsetWidth || 140) + 8 : 0;
          var el = document.createElement("button");
          el.className = "lively-postcard-view-edit-chip";
          if (chip.title) el.title = chip.title;
          el.textContent = chip.label;
          el.style.cssText = [
            "position:absolute",
            "top:13px",
            "right:" + (40 + audW) + "px",
            "height:26px",
            "box-sizing:border-box",
            "display:flex",
            "align-items:center",
            "padding:0 10px",
            "border-radius:13px",
            "font-size:11px",
            "white-space:nowrap",
            "border:1px solid #e0c46c",
            "background:#fff8dc",
            "color:#7a5c00",
            "cursor:pointer",
          ].join(";");
          ["mousedown", "click"].forEach(function (t) {
            el.addEventListener(t, function (e) {
              e.preventDefault();
              e.stopPropagation();
              if (t === "click" && chip.onClick) chip.onClick(self);
            });
          });
          this._frontEl.appendChild(el);
          this._editChipEl = el;
          if (this._handleEl) {
            this._handleEl.style.right = (40 + audW + (el.offsetWidth || 110) + 8) + "px";
          }
        },

        _buildBackContents: function (back) {
          var self = this;

          var stamp = document.createElement("div");
          stamp.className = "lively-postcard-view-stamp";
          stamp.style.cssText = [
            "position:absolute",
            "top:10px",
            "right:10px",
            "width:44px",
            "height:52px",
            "border:2px dashed currentColor",
            "border-radius:3px",
            "display:flex",
            "align-items:center",
            "justify-content:center",
            "font-size:18px",
            "color:#888",
          ].join(";");
          stamp.textContent = "✉";
          back.appendChild(stamp);
          this._stampEl = stamp;

          var meta = document.createElement("div");
          meta.className = "lively-postcard-view-meta";
          meta.style.cssText = [
            "position:absolute",
            "top:16px",
            "left:14px",
            "right:68px",
            "bottom:14px",
            "font-size:11px",
            "color:#555",
            "line-height:1.9",
          ].join(";");
          back.appendChild(meta);

          // Author-placed stamps (payload.backStamps) — above the meta rows,
          // below the verify badge and flip-back button appended after this.
          // pointer-events:none so it never blocks the controls beneath.
          var stampLayer = document.createElement("div");
          stampLayer.className = "lively-postcard-view-stamps";
          stampLayer.style.cssText = "position:absolute;inset:0;pointer-events:none;";
          back.appendChild(stampLayer);
          this._stampLayerEl = stampLayer;

          function row(label) {
            var r = document.createElement("div");
            var l = document.createElement("span");
            l.textContent = label + ": ";
            l.style.color = "#999";
            var v = document.createElement("span");
            r.appendChild(l);
            r.appendChild(v);
            meta.appendChild(r);
            return v;
          }

          this._didEl = row("From");
          this._cidEl = row("CID");
          this._dateEl = row("Sent");
          this._visibilityEl = row("Visibility");

          var badge = document.createElement("div");
          badge.className = "lively-postcard-view-verify-badge";
          badge.style.cssText = [
            "position:absolute",
            "left:14px",
            "bottom:38px",
            "font-size:12px",
            "font-weight:600",
          ].join(";");
          badge.textContent = "Checking…";
          back.appendChild(badge);
          this._verifyBadgeEl = badge;

          var flipBackBtn = this._buildIconButton(
            "back",
            "⟲",
            "Flip back",
            function () {
              self._toggleFlip();
            },
          );
          flipBackBtn.style.right = "10px";
          flipBackBtn.style.bottom = "10px";
          back.appendChild(flipBackBtn);
        },

        _buildIconButton: function (side, glyph, title, onClick) {
          var btn = document.createElement("button");
          btn.textContent = glyph;
          btn.title = title;
          btn.style.cssText = [
            "position:absolute",
            "width:26px",
            "height:26px",
            "border-radius:50%",
            "border:1px solid #e8497e",   // pink accent, same as the constellation page's buttons
            "background:#e8497e",
            "color:#fff",
            "cursor:pointer",
            "font-size:13px",
            "line-height:1",
            "padding:0",
          ].join(";");
          ["mousedown", "click"].forEach(function (t) {
            btn.addEventListener(t, function (e) {
              e.preventDefault();
              e.stopPropagation();
              if (t === "click") onClick();
            });
          });
          return btn;
        },

        // One-time stylesheet for the compact content area's 2-line clamp
        // (webkit-line-clamp needs display:-webkit-box, which is simplest
        // applied via a toggleable class — see setCommentsExpanded — rather
        // than juggling several inline style properties in sync).
        _ensureCompactContentStyle: function () {
          if (document.getElementById("lively-postcard-view-compact-style")) return;
          var st = document.createElement("style");
          st.id = "lively-postcard-view-compact-style";
          st.textContent =
            ".lively-postcard-view-content.pcv-compact-clamped{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}";
          document.head.appendChild(st);
        },

        // Reactions footer (PostcardDesignSpec-v2.md §5.1) — a thin strip
        // along the bottom of the front face, below the content area. Built
        // empty here; populated/shown or hidden per-envelope in
        // _renderReactionsFooter, since state.reactionsEnabled isn't known
        // until the envelope loads.
        _buildReactionsFooter: function (front) {
          var self = this;
          var footer = document.createElement("div");
          footer.className = "lively-postcard-view-reactions-footer";
          footer.style.cssText = [
            "position:absolute",
            "left:0",
            "right:0",
            "bottom:0",
            "height:32px",
            "display:none",
            "align-items:center",
            "gap:4px",
            // Right padding clears the flip button (26px wide at right:10px)
            // that sits over the footer's bottom-right corner.
            "padding:0 46px 0 10px",
            "border-top:1px solid #eee",
            "overflow-x:auto",
            // overflow-x:auto alone makes overflow-y auto too, so the
            // reaction pop (a scaled, rotated emoji taller than the strip)
            // flashed a vertical scrollbar that shoved the pills left.
            "overflow-y:hidden",
            "white-space:nowrap",
            "box-sizing:border-box",
          ].join(";");
          front.appendChild(footer);
          this._footerEl = footer;

          // margin-left:auto pushes this sub-area (and the comment chip
          // after it) to the footer's far right within the flex row. The
          // pills wrap is rebuilt on every reactions poll.
          var pillsWrap = document.createElement("span");
          pillsWrap.style.cssText = "flex:none;display:flex;align-items:center;gap:4px;margin-left:auto;";
          footer.appendChild(pillsWrap);
          this._pillsWrapEl = pillsWrap;

          // Compact-mode-only comment chip (ConstellationLounge.js's Scroll
          // view) — a third sub-area right after pillsWrap, inheriting the
          // same right-alignment pillsWrap's margin-left:auto already
          // established for the group. Built unconditionally (cheap, empty
          // span) so _renderCommentChip has somewhere to render into
          // without needing its own first-use guard.
          var commentChipWrap = document.createElement("span");
          commentChipWrap.style.cssText = "flex:none;display:flex;align-items:center;margin-left:4px;";
          footer.appendChild(commentChipWrap);
          this._commentChipWrapEl = commentChipWrap;
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
              return self._showError("Failed to load postcard: " + xhr.status);
            var envelope;
            try {
              envelope = JSON.parse(xhr.responseText);
            } catch (e) {
              return self._showError("Invalid envelope JSON: " + e.message);
            }
            self._renderEnvelope(envelope);
          };
          xhr.onerror = function () {
            self._showError("Network error loading postcard");
          };
          xhr.send();
        },

        _showError: function (msg) {
          console.error("[PostCardView]", msg);
          if (this._titleEl) this._titleEl.textContent = "Error";
          if (this._contentEl) this._contentEl.textContent = msg;
        },
      },

      "sharing",
      {
        // Small dropdown anchored under the "more" button, appended to
        // document.body rather than nested inside this morph's own
        // shapeNode -- _buildChrome sets overflow:hidden on the card faces,
        // which would clip a menu popping out below the top bar. Toggle: a
        // second click on the same button (or any outside mousedown)
        // closes it. Mirrors WikiView.js's identical _toggleMoreMenu.
        _toggleMoreMenu: function (anchorBtn) {
          if (this._moreMenuEl) { this._closeMoreMenu(); return; }
          var self = this;
          var rect = anchorBtn.getBoundingClientRect();
          var menu = document.createElement("div");
          menu.style.cssText = [
            "position:fixed", "z-index:9999",
            "top:" + Math.round(rect.bottom + 4) + "px",
            "left:" + Math.round(rect.right - 180) + "px",
            "width:180px", "background:#fff", "border:1px solid #ddd",
            "border-radius:8px", "box-shadow:0 4px 14px rgba(0,0,0,0.2)",
            "padding:4px", "font-family:sans-serif", "font-size:13px",
            "box-sizing:border-box",
          ].join(";");

          // `danger` mirrors PostCardMailbox.js's own ⋯-menu items (its
          // `.pcm-menu-item.danger` class) -- red text/icon for a
          // destructive action, same visual language across both postcard
          // surfaces. `iconColor` is a narrower tint for just the glyph
          // (text stays the normal color) -- used for the Save item's
          // already-saved state, same green as PostCardMailbox.js's own
          // --pcm-accent, so "saved" reads as a positive/active state
          // rather than a destructive one.
          var makeItem = function (label, iconName, onClick, danger, iconColor) {
            var item = document.createElement("div");
            var color = danger ? "#c0392b" : "#333";
            item.style.cssText = [
              "display:flex", "align-items:center", "gap:8px",
              "padding:7px 10px", "border-radius:5px", "cursor:pointer", "color:" + color,
            ].join(";");
            item.innerHTML =
              '<span class="material-symbols-rounded" style="font-size:16px;color:' + (danger ? color : (iconColor || "#666")) + ';">' + iconName + '</span>' +
              '<span>' + label + '</span>';
            item.addEventListener("mouseenter", function () { item.style.background = danger ? "#fdf0ee" : "#f2f2f2"; });
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

          // A card that has been delivered to someone's inbox (state.sentAt) is frozen:
          // the server refuses every later write to it, so offering Edit would only
          // end in a 409. A shared or constellation card is never stamped, so it keeps it.
          var delivered = !!(this._envelope && this._envelope.state && this._envelope.state.sentAt);
          if (this._isOwner && !delivered) {
            menu.appendChild(makeItem("Edit", "edit", function () {
              lively.identity.PostCardEditor.openCard(self._handle, self._objId);
            }));
          }
          // Reflects whatever _checkCollectionsState last found (fetched in
          // _renderEnvelope) -- "Saved"/filled green icon when this viewer
          // already bookmarked the card, re-clickable to remove it again.
          menu.appendChild(makeItem(
            this._savedToCollections ? "Saved" : "Save",
            this._savedToCollections ? "bookmark" : "bookmark_add",
            function () {
              if (self._savedToCollections) self._removeFromCollections();
              else self._saveToCollections();
            },
            false,
            this._savedToCollections ? "#16a34a" : null
          ));
          // Replies: the conversation under this card plus a composer, in
          // its own small window. Not offered on system cards (join
          // requests, invites, flags, room messages), which carry a
          // state.kind and aren't meant to be answered this way, nor when
          // signed out.
          if (this._envelope && !(this._envelope.state && this._envelope.state.kind) &&
              lively.identity.did.currentUser()) {
            menu.appendChild(makeItem("Replies", "chat_bubble", function () {
              lively.require("lively.identity.MailboxThread").toRun(function () {
                lively.identity.mailboxThread.openWindow(
                  self._handle, self._objId,
                  (self._envelope.state && self._envelope.state.title) || ""
                );
              });
            }));
          }
          menu.appendChild(makeItem("Share", "share", function () {
            self._shareLink();
          }));
          if (this._isOwner) {
            menu.appendChild(makeItem("Delete", "delete", function () {
              self._deleteCard();
            }, true));
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

        // Fetches whether the current viewer already has this card bookmarked
        // (GET /@:handle/collections/:objId, mirroring GET .../stars and
        // .../reactions' own per-viewer "mine" flag) so the menu's Save item
        // can render already-toggled-on next time it's opened. Silent no-op
        // when logged out -- currentUser() is null and there's nothing to
        // check; the item just stays "Save" (clicking it would 401, same as
        // before this state existed).
        _checkCollectionsState: function () {
          var self = this;
          var user = lively.identity.did.currentUser();
          if (!user) return;
          var base = lively.identity.did.baseUrl();
          var xhr = new XMLHttpRequest();
          xhr.open("GET", base + "/@" + user.handle + "/collections/" + encodeURIComponent(this._objId));
          xhr.withCredentials = true;
          xhr.setRequestHeader("Accept", "application/json");
          xhr.onload = function () {
            if (xhr.status !== 200) return;
            try {
              self._savedToCollections = !!JSON.parse(xhr.responseText).saved;
            } catch (e) { /* leave state unknown -- item stays "Save" */ }
          };
          xhr.send();
        },

        // Bookmarks this card into the current user's own Collections tab
        // -- same idempotent PUT as PostCardMailbox.js's _saveToCollections
        // (§6.2), just reached from the single-card view instead of a
        // mailbox row menu. Unlike that mailbox call site (silent on
        // success), this one flashes a confirmation -- there's no
        // Collections list visible from here to show the save landed, so
        // the viewer needs explicit feedback rather than an absence of
        // error.
        _saveToCollections: function () {
          var self = this;
          var handle = lively.identity.did.currentUser().handle;
          var base = lively.identity.did.baseUrl();
          var xhr = new XMLHttpRequest();
          xhr.open("PUT", base + "/@" + handle + "/collections/" + encodeURIComponent(this._objId));
          xhr.withCredentials = true;
          xhr.onload = function () {
            if (xhr.status === 200) {
              self._savedToCollections = true;
              self._flashNearMoreBtn("Saved to Collections");
            } else {
              self._flashNearMoreBtn("Could not save to Collections", true);
            }
          };
          xhr.onerror = function () {
            self._flashNearMoreBtn("Could not save to Collections", true);
          };
          xhr.send();
        },

        // Un-bookmarks -- the Save menu item's toggled-off counterpart,
        // reached only when _savedToCollections is already true.
        _removeFromCollections: function () {
          var self = this;
          var handle = lively.identity.did.currentUser().handle;
          var base = lively.identity.did.baseUrl();
          var xhr = new XMLHttpRequest();
          xhr.open("DELETE", base + "/@" + handle + "/collections/" + encodeURIComponent(this._objId));
          xhr.withCredentials = true;
          xhr.onload = function () {
            if (xhr.status === 200) {
              self._savedToCollections = false;
              self._flashNearMoreBtn("Removed from Collections");
            } else {
              self._flashNearMoreBtn("Could not remove from Collections", true);
            }
          };
          xhr.onerror = function () {
            self._flashNearMoreBtn("Could not remove from Collections", true);
          };
          xhr.send();
        },

        // Copies this card's canonical URL -- IdentityServer.js's
        // GET /@:handle/:objId content-negotiates a real standalone HTML
        // page for a postcard/wikipage envelope (buildPostCardPage), so
        // this is a genuinely shareable link, not just an API endpoint.
        // Same clipboard-with-prompt-fallback idiom as WikiView.js's
        // _copyShareLink.
        _shareLink: function () {
          var self = this;
          var url = lively.identity.did.baseUrl() + "/@" + encodeURIComponent(this._handle) +
            "/" + encodeURIComponent(this._objId);
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url)
              .then(function () { self._flashNearMoreBtn("Link copied"); })
              .catch(function () { window.prompt("Copy this link:", url); });
          } else {
            window.prompt("Copy this link:", url);
          }
        },

        // Placeholder -- real delete needs to decide between "hide from my
        // mailbox" vs. a genuine tombstone PUT depending on whether the
        // card is already frozen (state.sentAt), same branching
        // PostCardMailbox.js's _deletePostcard/_hideFromMailbox already
        // handle for the mailbox list view. Not wired up here yet; this
        // just gives the menu item somewhere to go without silently doing
        // nothing on click.
        _deleteCard: function () {
          this._flashNearMoreBtn("Delete isn't wired up here yet", true);
        },

        // Small transient tooltip near the "more" button -- used for both
        // success (e.g. "Link copied") and failure feedback. Deliberately
        // NOT _showError (which replaces the whole rendered card with an
        // error message, appropriate only for an initial-load failure) --
        // a failed menu action shouldn't blank out content the viewer is
        // already looking at.
        _flashNearMoreBtn: function (msg, isError) {
          if (isError) console.error("[PostCardView]", msg);
          if (!this._moreBtn) return;
          var rect = this._moreBtn.getBoundingClientRect();
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
      },

      "rendering",
      {
        _renderEnvelope: function (envelope) {
          this._envelope = envelope;
          var user = lively.identity.did.currentUser();
          this._isOwner = !!(user && user.did === envelope.did);
          // Reset (not just left stale) so a reused view instance (e.g. the
          // reel paging to a new card) doesn't show the PREVIOUS card's
          // saved-state for a split second before _checkCollectionsState's
          // fetch for the new one resolves.
          this._savedToCollections = false;

          this._loadAvatar();
          if (this._onEnvelope) this._onEnvelope(envelope, this);
          this._titleEl.textContent =
            (envelope.state && envelope.state.title) || "(untitled)";
          // The "more" button itself stays visible for every viewer --
          // Save to Collections applies regardless of ownership. Edit is
          // gated inside the menu's own contents instead (_toggleMoreMenu).

          this._renderContentArea(envelope);
          this._renderMembershipActions(envelope);
          // _renderBackMeta/_verify both touch back-face DOM
          // (_verifyBadgeEl etc.) that _buildChrome never builds in
          // compact mode (see the back-face skip there) — a mini card
          // never flips, so there's nothing to verify-badge either.
          if (!this._compactMode) {
            this._renderBackMeta(envelope);
            // Public: the payload is right here. Private/shared: cleared now
            // (a reused view must not keep the previous card's stamps) and
            // filled in by _decryptAndRenderContent once decrypted.
            this._renderBackStamps(
              envelope.visibility === "public" && envelope.record ? envelope.record.payload : null,
            );
            this._verify(envelope);
          }
          this._renderReactionsFooter(envelope);
          this._checkCollectionsState();
        },

        // Approve/Decline for a constellation-join-request card
        // (ConstellationCanvas.js's / ConstellationLounge.js's _requestJoin) — the card itself is the
        // approval UI (owner decision: no separate pending-requests panel).
        // envelope.did is the requester (they authored+signed this card
        // themselves), matching PUT /c/:constellation/join-requests/:did's
        // expected param. Controller-gated via the same GET
        // /c/:constellation/space-token check WikiView.js's Edit button
        // already uses for its own owner-or-canWrite gate.
        _renderMembershipActions: function (envelope) {
          var self = this;
          // A compact mini card's content is plain textContent (see
          // _renderContentHtml/_renderContentArea) — insertBefore-ing a
          // real action bar into it doesn't apply, and this action belongs
          // to the Reel/standalone view anyway.
          if (this._compactMode) return;
          var state = envelope.state || {};
          if (state.kind !== "constellation-join-request" || !envelope.constellation) return;

          var bar = document.createElement("div");
          bar.style.cssText = [
            "margin-bottom:8px", "padding:6px 8px",
            "background:#fff9e6", "border:1px solid #f0e0a0", "border-radius:6px",
            "font-size:11px", "color:#8a6d1f", "line-height:1.6",
          ].join(";");
          bar.textContent = "Checking access…";
          this._contentEl.insertBefore(bar, this._contentEl.firstChild);

          var base = lively.identity.did.baseUrl();
          var constellation = envelope.constellation;
          fetch(base + "/c/" + encodeURIComponent(constellation) + "/space-token", { credentials: "include" })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (data) {
              // Not a controller (or not signed in) — this card is still a
              // perfectly normal, readable postcard for everyone else; just
              // no action bar.
              if (!data || !data.isController) { bar.remove(); return; }

              // Check this specific request's resolution status before
              // showing anything — previously the Approve/Decline buttons
              // rendered unconditionally on every view, even long after any
              // controller had already resolved the request (the PUT itself
              // was guarded server-side, but the card kept inviting a
              // second click). A resolved request now shows a persistent
              // status line instead — the "no further action needed"
              // confirmation controllers asked for.
              fetch(base + "/c/" + encodeURIComponent(constellation) + "/join-requests/" +
                encodeURIComponent(envelope.did), { credentials: "include" })
                .then(function (res) { return res.ok ? res.json() : { status: null }; })
                .then(function (statusData) {
                  self._renderMembershipActionsBar(bar, envelope, constellation, statusData.status);
                })
                .catch(function () { bar.remove(); });
            })
            .catch(function () { bar.remove(); });
        },

        _renderMembershipActionsBar: function (bar, envelope, constellation, status) {
          var self = this;
          var base = lively.identity.did.baseUrl();

          if (status === "approved" || status === "declined") {
            bar.textContent = status === "approved"
              ? "✓ Approved — @" + self._handle + " is now a member of c/" + constellation + "."
              : "Declined @" + self._handle + "'s request.";
            return;
          }

          bar.innerHTML = "";
          var label = document.createElement("span");
          label.textContent = "Join request for c/" + constellation + ": ";
          bar.appendChild(label);

          function makeBtn(text, colorBorder, colorBg, colorText) {
            var btn = document.createElement("button");
            btn.textContent = text;
            btn.style.cssText = [
              "margin-right:6px", "font-size:11px", "padding:2px 8px", "cursor:pointer",
              "border:1px solid " + colorBorder, "border-radius:10px",
              "background:" + colorBg, "color:" + colorText,
            ].join(";");
            ["mousedown", "click"].forEach(function (t) {
              btn.addEventListener(t, function (e) {
                e.preventDefault();
                e.stopPropagation();
              });
            });
            return btn;
          }
          var approveBtn = makeBtn("Approve", "#8fbf8f", "#eaf7ea", "#1e7a1e");
          var declineBtn = makeBtn("Decline", "#d9a0a0", "#fbeaea", "#a11e1e");

          function resolve(action) {
            approveBtn.disabled = true;
            declineBtn.disabled = true;
            var xhr = new XMLHttpRequest();
            xhr.open("PUT", base + "/c/" + encodeURIComponent(constellation) +
              "/join-requests/" + encodeURIComponent(envelope.did), true);
            xhr.withCredentials = true;
            xhr.setRequestHeader("Content-Type", "application/json");
            xhr.onload = function () {
              bar.innerHTML = "";
              if (xhr.status === 200) {
                bar.textContent = action === "approve"
                  ? "✓ Approved — @" + self._handle + " is now a member of c/" + constellation + "."
                  : "Declined @" + self._handle + "'s request.";
                if (action === "approve") self._sendWelcomeCard(constellation, self._handle);
              } else {
                var msg = "Failed (" + xhr.status + ")";
                try { var body = JSON.parse(xhr.responseText); if (body.error) msg = body.error; } catch (e) {}
                bar.textContent = msg;
              }
            };
            xhr.onerror = function () { bar.textContent = "Network error"; };
            xhr.send(JSON.stringify({ action: action }));
          }
          approveBtn.addEventListener("click", function () { resolve("approve"); });
          declineBtn.addEventListener("click", function () { resolve("decline"); });
          bar.appendChild(approveBtn);
          bar.appendChild(declineBtn);
        },

        // Approving controller's own device key signs a small "you're in"
        // postcard (never server-fabricated, same posture as every other
        // card in this system) and delivers it via the same generic postal
        // route regular postcard sends already use (POST /@handle/inbox) —
        // no join-request-specific delivery plumbing needed.
        _sendWelcomeCard: function (constellation, recipientHandle) {
          var user = lively.identity.did.currentUser();
          if (!user) return;
          var base = lively.identity.did.baseUrl();
          lively.require("lively.identity.PostCardSerializer").toRun(function () {
            var doc = {
              type: "doc",
              content: [{
                type: "paragraph",
                content: [{ type: "text", text: "You are now a member of c/" + constellation + "." }],
              }],
            };
            lively.identity.postCardSerializer.serializePlainToEnvelope({
              doc: doc,
              title: "Welcome to c/" + constellation,
              titleExplicit: true,
              visibility: "public",
            }, function (err, envelope) {
              if (err) return console.error("[PostCardView] Could not create welcome card:", err.message);
              var putXhr = new XMLHttpRequest();
              putXhr.open("PUT", base + "/@" + encodeURIComponent(user.handle) + "/" + encodeURIComponent(envelope.objId), true);
              putXhr.withCredentials = true;
              putXhr.setRequestHeader("Content-Type", "application/json");
              putXhr.onload = function () {
                if (putXhr.status !== 200) return console.error("[PostCardView] Could not save welcome card:", putXhr.status);
                var deliverXhr = new XMLHttpRequest();
                deliverXhr.open("POST", base + "/@" + encodeURIComponent(recipientHandle) + "/inbox", true);
                deliverXhr.withCredentials = true;
                deliverXhr.setRequestHeader("Content-Type", "application/json");
                deliverXhr.send(JSON.stringify({ objId: envelope.objId }));
              };
              putXhr.send(JSON.stringify(envelope));
            });
          });
        },

        // Show the identicon immediately (cheap, synchronous, always
        // correct as a fallback), then swap in the author's real avatar if
        // their profile has one set — this previously never happened at
        // all, so every postcard showed the blockie identicon regardless of
        // whether the author had set a real avatar (ProfileCard.js has the
        // same avatarUrl-else-identicon fallback; this mirrors it).
        _loadAvatar: function () {
          var self = this;
          var handle = this._handle;
          var fallbackSeed = handle || (this._envelope && this._envelope.did) || "";
          this._avatarImgEl.src = lively.identity.postCardUtils.identiconDataUrl(fallbackSeed, 32);
          if (!handle) return;

          var base = lively.identity.did.baseUrl();
          fetch(base + "/@" + encodeURIComponent(handle) + "/profile", { credentials: "include" })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (env) {
              var avatarUrl = env && env.record && env.record.payload && env.record.payload.avatarUrl;
              // Guard against a slow profile fetch resolving after the user
              // has already navigated this same morph to a different card.
              if (avatarUrl && self._handle === handle) self._avatarImgEl.src = avatarUrl;
            })
            .catch(function () {}); // network error — keep the identicon fallback
        },

        // Builds this._contentEl's HTML from a ProseMirror snapshot. Default
        // (_previewMode false, every caller except ConstellationLounge's
        // reel): unchanged plain natural document order, same as always.
        // Opt-in (_previewMode true): reorders via
        // postCardUtils.buildPreviewSplit into the "Reddit-like" media-
        // forward shape (lead excerpt -> media -> rest) — falls back to the
        // exact same unsplit render if the doc has no media at all. Called
        // from both places that used to assign _contentEl.innerHTML
        // directly (the public branch below, and _decryptAndRenderContent's
        // post-decrypt render) so preview mode applies consistently to
        // public and decrypted-private content alike.
        _renderContentHtml: function (snapshot) {
          var U = lively.identity.postCardUtils;
          if (!snapshot) { this._contentEl.innerHTML = ""; return; }
          if (this._compactMode) {
            // Plain-text excerpt only — a compact mini card doesn't embed
            // media/link-preview cards (PostcardDesignSpec-v2.md's Mini
            // Card Stack layout); leadExcerpt is the same lead-paragraph
            // excerpt buildPreviewSplit already computes for every other
            // condensed-row caller, reused verbatim here
            // rather than inventing new excerpt logic. textContent (not
            // innerHTML) since this is plain text, not markup.
            var split = U.buildPreviewSplit(snapshot.content, { feedMode: true });
            this._contentEl.textContent = split.leadExcerpt || "";
            return;
          }
          if (!this._previewMode) {
            this._contentEl.innerHTML = U.snapshotToHtml(snapshot);
            return;
          }
          // feedMode (split layout) still applies in _previewMode (the
          // ConstellationLounge reel card) — lead/media/rest reordering so
          // the card reads media-forward. suppressEmbeds: false overrides
          // feedMode's default "no card in a condensed row" posture: the
          // reel shows one full card at a time (not a many-rows list like
          // the reply list), so a real link-preview
          // card/iframe is exactly what should show here too.
          var split = U.buildPreviewSplit(snapshot.content, { feedMode: true, suppressEmbeds: false });
          if (!split.hasMedia) {
            // Doc's only "media-like" content is a link_preview_card (no
            // other image/video/audio -- the common case for a link-only
            // post) — render the real card via the same suppressEmbeds:
            // false override, not the plain-link fallback.
            this._contentEl.innerHTML = U.snapshotToHtml(snapshot, { feedMode: true, suppressEmbeds: false });
            return;
          }
          var parts = [];
          if (split.leadExcerpt) {
            parts.push('<div class="lively-postcard-preview-lead">' + U.escapeHtml(split.leadExcerpt) + '</div>');
          }
          parts.push('<div class="lively-postcard-preview-media">' + split.mediaHtml + '</div>');
          if (split.restHtml) {
            // Unclamped — this card grows to fit its content
            // (ConstellationLounge's _fitCardToContent).
            parts.push('<div class="lively-postcard-preview-rest">' + split.restHtml + '</div>');
          }
          this._contentEl.innerHTML = parts.join('');
        },

        _renderContentArea: function (envelope) {
          var self = this;
          if (envelope.visibility === "public") {
            var payload = envelope.record && envelope.record.payload;
            // Plain postcards (§1.1/§2.3, PostcardDesignSpec-v2.md): `doc` IS
            // the snapshot — no separate extraction step, same ProseMirror
            // JSON shape `snapshotToHtml` already renders. Wiki-mode cards
            // (§1.2, format: "yjs-update-v1", or any pre-split legacy card
            // saved before this format existed) keep using `snapshot`.
            var snapshot = payload &&
              (payload.format === "prosemirror-doc-v1" ? payload.doc : payload.snapshot);
            this._renderContentHtml(snapshot);
            // Compact mode's content is plain textContent (see
            // _renderContentHtml) — no markup to hydrate embeds/link
            // previews into.
            if (this._compactMode) return;
            // BUG FIX: embedded Lively parts used to render as a permanent
            // "[Embedded Part: <objId>]" text stub here — nothing ever
            // turned the placeholder into the live morph it references.
            lively.identity.postCardUtils.hydrateEmbeddedParts(this._contentEl);
            lively.identity.postCardUtils.hydrateLinkPreviewEmbeds(this._contentEl);
            // Now runs in _previewMode too (the reel shows one full card at
            // a time, not a condensed many-rows list — see
            // _renderContentHtml's suppressEmbeds override above) so a
            // legacy bare-URL post (saved before link_preview_card existed)
            // still gets a real card there.
            lively.identity.postCardUtils.hydrateLinkPreviews(this._contentEl);
            this._renderGameBlock(payload);
            return;
          }

          // Compact mode shows a plain lock label, no decrypt button — a
          // mini card doesn't offer the inline-decrypt affordance (no
          // WebAuthn prompt from a feed row), matching
          // ConstellationLounge._extractReplyBodyHtml's identical posture
          // for encrypted replies.
          if (this._compactMode) {
            this._contentEl.textContent = "";
            this._contentEl.appendChild(lively.identity.postCardUtils.lockGlyph({ size: 15 }));
            this._contentEl.appendChild(document.createTextNode(" Encrypted"));
            return;
          }

          // Encrypted content — see file-level comment. Show a locked
          // placeholder; "View content" decrypts and renders in place
          // (_decryptAndRenderContent) rather than opening a separate
          // editor window.
          this._contentEl.innerHTML = "";
          var lock = document.createElement("div");
          lock.style.cssText =
            "display:flex;flex-direction:column;align-items:center;justify-content:center;" +
            "height:100%;color:#999;gap:8px;";
          lock.appendChild(lively.identity.postCardUtils.lockGlyph({ size: 28 }));
          var label = document.createElement("div");
          label.textContent = "Encrypted";
          label.style.fontSize = "11px";
          lock.appendChild(label);
          var viewBtn = document.createElement("button");
          viewBtn.textContent = "View content";
          viewBtn.style.cssText =
            "font-size:11px;padding:4px 10px;cursor:pointer;" +
            "border:1px solid #ccc;border-radius:12px;background:#fff;";
          ["mousedown", "click"].forEach(function (t) {
            viewBtn.addEventListener(t, function (e) {
              e.preventDefault();
              e.stopPropagation();
              if (t === "click") self._decryptAndRenderContent(envelope, lock, viewBtn);
            });
          });
          lock.appendChild(viewBtn);
          this._contentEl.appendChild(lock);
        },

        // Decrypts envelope.record.payload in place and renders it into
        // this._contentEl, replacing the locked placeholder — the WebAuthn
        // ceremony (deriveKek for the owner, deriveX25519KeyPair for a
        // recipient) happens inside deserializeEncryptedAuto; this method
        // only handles the loading/success/error UI around that call and
        // the render step afterward. Re-entrant-safe: a second click while
        // a decrypt is already in flight for this same viewBtn is a no-op.
        _decryptAndRenderContent: function (envelope, lockEl, viewBtn) {
          var self = this;
          if (this._decryptInFlight) return;
          this._decryptInFlight = true;

          viewBtn.disabled = true;
          viewBtn.textContent = "Decrypting…";

          lively.identity.postCardSerializer.deserializeEncryptedAuto(envelope, function (err, mode, content, payload) {
            self._decryptInFlight = false;
            // Guard against a slow decrypt (WebAuthn prompt sat open a
            // while) resolving after this morph moved on to a different
            // card/objId — same pattern as _loadAvatar's handle check.
            if (self._envelope !== envelope) return;

            if (err) {
              self._renderDecryptError(err, lockEl, viewBtn);
              return;
            }

            var snapshot = mode === "wiki"
              ? lively.identity.postCardSerializer._extractSnapshot(content)
              : content;
            if (!snapshot) {
              self._renderDecryptError(new Error("Could not read decrypted content"), lockEl, viewBtn);
              return;
            }

            self._renderContentHtml(snapshot);
            lively.identity.postCardUtils.hydrateEmbeddedParts(self._contentEl);
            lively.identity.postCardUtils.hydrateAttachments(
              self._contentEl, self._handle, (payload && payload.attachments) || [],
            );
            lively.identity.postCardUtils.hydrateLinkPreviewEmbeds(self._contentEl);
            lively.identity.postCardUtils.hydrateLinkPreviews(self._contentEl);
            if (!self._compactMode) self._renderBackStamps(payload);
            if (!self._compactMode) self._renderGameBlock(payload);
          });
        },

        // Inline error UI, not a whole-morph error — only the content area
        // failed, the rest of the card (avatar, title, back/verify badge)
        // already rendered fine.
        _renderDecryptError: function (err, lockEl, viewBtn) {
          console.error("[PostCardView] decrypt failed:", err && err.message);
          viewBtn.disabled = false;
          viewBtn.textContent = "Retry";
          var msgEl = lockEl.querySelector(".lively-postcard-view-decrypt-error");
          if (!msgEl) {
            msgEl = document.createElement("div");
            msgEl.className = "lively-postcard-view-decrypt-error";
            msgEl.style.cssText = "font-size:10px;color:#c33;max-width:180px;text-align:center;";
            lockEl.appendChild(msgEl);
          }
          msgEl.textContent = (err && err.message) || "Failed to decrypt";
        },

        // The game a card is about, drawn under its text: a small cover, the title, and one line
        // of facts (status, and the rating and playtime only if the author chose to include
        // them, each already decided when the block was written; nothing here adds to it).
        // payload.game comes from the card's author, so every string goes in as text and the
        // cover only loads from an https address. Does nothing for a card without a block, or
        // in the compact mini card. Called after the content is drawn, because drawing the
        // content replaces the whole content element.
        //   payload.game = { title, cover_url?, status?, rating? (1-5), playtime_minutes?,
        //                    playtime_source? ('steam' | 'itch' | 'manual') }
        _renderGameBlock: function (payload) {
          if (!this._contentEl || this._compactMode) return;
          var old = this._contentEl.querySelector(".lively-postcard-game");
          if (old) old.parentNode.removeChild(old);
          var g = payload && payload.game;
          if (!g || typeof g !== "object" || typeof g.title !== "string" || !g.title) return;

          var STATUS = { playing: "Playing", backlog: "Backlog", completed: "Completed", dropped: "Dropped", wishlist: "Wishlist" };
          var SOURCE = { steam: "Steam", itch: "itch.io", manual: "self-reported" };
          var facts = [];
          if (STATUS[g.status]) facts.push(STATUS[g.status]);
          var rating = Math.round(+g.rating || 0);
          if (rating >= 1 && rating <= 5) facts.push("★".repeat(rating) + "☆".repeat(5 - rating));
          var mins = +g.playtime_minutes;
          if (isFinite(mins) && mins >= 0 && g.playtime_minutes != null) {
            var hrs = mins / 60;
            facts.push((hrs >= 10 ? Math.round(hrs) : Math.round(hrs * 10) / 10) + " h" + (SOURCE[g.playtime_source] ? " · " + SOURCE[g.playtime_source] : ""));
          }

          var box = document.createElement("div");
          box.className = "lively-postcard-game";
          box.setAttribute("data-game-title", g.title);
          box.style.cssText = "display:flex;gap:10px;align-items:center;margin-top:10px;padding:8px;" +
            "border:1px solid rgba(0,0,0,0.12);border-radius:10px;background:rgba(0,0,0,0.035);";
          var cover = document.createElement("div");
          cover.style.cssText = "flex:none;width:44px;height:58px;border-radius:6px;overflow:hidden;" +
            "background:linear-gradient(135deg,#d6246e,#7a3fd1);color:rgba(255,255,255,0.9);" +
            "display:flex;align-items:center;justify-content:center;font:700 20px sans-serif;";
          cover.textContent = (g.title.trim().charAt(0) || "?").toUpperCase();
          if (typeof g.cover_url === "string" && /^https:\/\//i.test(g.cover_url)) {
            var img = document.createElement("img");
            img.alt = "";
            img.draggable = false;
            img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;";
            img.addEventListener("load", function () { if (img.naturalWidth) cover.textContent = ""; if (img.naturalWidth) cover.appendChild(img); });
            img.src = g.cover_url;
          }
          var text = document.createElement("div");
          text.style.cssText = "min-width:0;";
          var title = document.createElement("div");
          title.textContent = g.title.slice(0, 120);
          title.style.cssText = "font-weight:700;font-size:13px;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
          text.appendChild(title);
          if (facts.length) {
            var line = document.createElement("div");
            line.textContent = facts.join("  ·  ");
            line.style.cssText = "font-size:11px;opacity:0.7;margin-top:3px;";
            text.appendChild(line);
          }
          box.appendChild(cover);
          box.appendChild(text);
          this._contentEl.appendChild(box);
        },

        _renderBackMeta: function (envelope) {
          this._didEl.textContent = lively.identity.postCardUtils.truncateDid(
            envelope.did,
          );
          this._cidEl.textContent =
            envelope.record && envelope.record.cid
              ? lively.identity.postCardUtils.truncateDid(envelope.record.cid)
              : "—";
          this._dateEl.textContent = this._formatDate(envelope.created);
          this._visibilityEl.textContent = envelope.visibility || "public";
          var stampColor =
            envelope.visibility === "public" ? "#888" : "#5566cc";
          this._stampEl.style.color = stampColor;
          this._applyHostRow(envelope);
          if (this._homestarBack) this._applyHomestarBack(envelope);
        },

        // Opt-in (options.homestar): the homestar reel's back face. Ruled writing
        // lines, a tilted postmark and a "To:" address block, over the same
        // From/CID/Sent/Visibility rows and verify badge. The dashed envelope
        // stamp is hidden; author-placed stamps (payload.backStamps) still render.
        _applyHomestarBack: function (envelope) {
          var back = this._backEl;
          if (!back) return;
          var PINK = "#e8497e";
          var viewer = lively.identity.did.currentUser();
          var isOwner = !!(viewer && viewer.did && viewer.did === envelope.did);
          var vis = envelope.visibility || "public";
          var recipients = (envelope.record && envelope.record.recipients) || [];
          var n = recipients.length;

          var audience, who;
          if (vis === "public") {
            audience = "Public"; who = "Everyone";
          } else if (isOwner) {
            audience = n ? "Shared with " + n + (n === 1 ? " person" : " people") : "Only you";
            who = n ? n + (n === 1 ? " person" : " people") : "Just me";
          } else {
            audience = "Shared with you";
            who = viewer && viewer.handle ? "@" + viewer.handle : "You";
          }
          this._visibilityEl.textContent = audience;

          back.style.background =
            "repeating-linear-gradient(180deg, transparent 0 27px, rgba(70,40,110,.11) 27px 28px), #fff";

          var meta = back.querySelector(".lively-postcard-view-meta");
          if (meta) {
            meta.style.top = "28px";
            meta.style.right = "calc(48% + 6px)";
            meta.style.bottom = "auto";
            meta.style.lineHeight = "28px";
            Array.prototype.forEach.call(meta.children, function (r) {
              r.style.whiteSpace = "nowrap";
              r.style.overflow = "hidden";
              r.style.textOverflow = "ellipsis";
            });
          }

          // No stamp boxes on this face: the postmark carries it.
          this._stampEl.style.display = "none";

          // Postmark: place, date and year in a double ring, with four wavy
          // cancel lines beside it.
          var created = envelope.created ? new Date(envelope.created) : null;
          var ok = created && !isNaN(created.getTime());
          var months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
          var dm = ok ? months[created.getMonth()] + " " + created.getDate() : "";
          var year = ok ? String(created.getFullYear()) : "";
          var loc = envelope.state && envelope.state.location;
          var place = loc ? String(loc).replace(/[^0-9A-Za-z]/g, "").slice(0, 8).toUpperCase() : "";
          // No place: the star-cluster icon takes the place line's spot. Scaled
          // to ~0.85 and centered on x=40, y=28.5 so it sits in the ring above
          // the date.
          var STAR_CLUSTER_PATH = lively.identity.PostCardView.STAR_CLUSTER_PATH;
          var wave = [20, 32, 44, 56].map(function (y) {
            return '<path d="M80 ' + y + ' q8 -6 16 0 t16 0 t16 0 t16 0"/>';
          }).join("");
          var ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
          function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return ESC[c]; }); }
          var placeSvg = place
            ? '<text x="40" y="36" font-size="' + (place.length > 8 ? 7 : 8.5) + '">' + esc(place) + "</text>"
            : '<path transform="translate(29.7 18.6) scale(.85)" d="' + STAR_CLUSTER_PATH + '"/>';
          if (!this._postmarkEl) {
            this._postmarkEl = document.createElement("div");
            this._postmarkEl.className = "lively-postcard-view-postmark";
            back.appendChild(this._postmarkEl);
          }
          this._postmarkEl.style.cssText =
            "position:absolute;top:8px;right:16px;width:150px;height:80px;transform:rotate(-8deg);pointer-events:none;";
          this._postmarkEl.innerHTML =
            '<svg viewBox="0 0 150 80" width="150" height="80" aria-hidden="true">' +
            '<g fill="none" stroke="' + PINK + '" stroke-width="2"><circle cx="40" cy="40" r="33"/>' +
            '<circle cx="40" cy="40" r="26" stroke-width="1" stroke-dasharray="2 3"/>' + wave + "</g>" +
            '<g fill="' + PINK + '" font-family="Helvetica, Arial, sans-serif" font-weight="700" text-anchor="middle" letter-spacing=".6">' +
            placeSvg +
            '<text x="40" y="47" font-size="8.5">' + esc(dm) + "</text>" +
            '<text x="40" y="58" font-size="8.5">' + esc(year) + "</text></g></svg>";

          // "To:" address block, ruled like the lines behind it.
          if (!this._addrEl) {
            this._addrEl = document.createElement("div");
            this._addrEl.className = "lively-postcard-view-addr";
            back.appendChild(this._addrEl);
          }
          var line = "display:block;height:28px;line-height:27px;border-bottom:1px solid #b9b2c4;" +
            "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
          this._addrEl.style.cssText = "position:absolute;left:52%;right:18px;top:112px;";
          this._addrEl.innerHTML =
            '<span style="' + line + 'font-size:11px;color:#999;">To:</span>' +
            '<b style="' + line + 'font-size:18px;font-weight:600;color:#3a2d4f;">' + esc(who) + "</b>" +
            '<span style="' + line + '"></span>';

          // A narrow card has no room for the postmark beside the address.
          var narrow = this.getExtent().x < 480;
          this._postmarkEl.style.display = narrow ? "none" : "block";
          if (narrow) {
            this._addrEl.style.left = "14px";
            this._addrEl.style.top = "196px";   // below the five meta rows
            if (meta) meta.style.right = "14px";
          }
        },

        // "Host:" row right after "From:" on every full card back: the author's home
        // instance, from the "#home" service entry in their DID document (the same
        // source the profile card's "Hosted on" line reads). The row stays hidden
        // until that is known, and is never guessed. Answers are cached per handle.
        _applyHostRow: function (envelope) {
          var self = this;
          var meta = this._backEl.querySelector(".lively-postcard-view-meta");
          var fromRow = this._didEl && this._didEl.parentNode;
          if (!meta || !fromRow) return;
          if (!this._hostRowEl) {
            var r = document.createElement("div");
            var l = document.createElement("span");
            l.textContent = "Host: ";
            l.style.color = "#999";
            var v = document.createElement("span");
            r.appendChild(l);
            r.appendChild(v);
            r.style.display = "none";
            meta.insertBefore(r, fromRow.nextSibling);
            this._hostRowEl = r;
            this._hostEl = v;
          }
          var handle = this._handle;
          if (!handle) return;
          var cache = lively.identity.PostCardView._homeHosts || (lively.identity.PostCardView._homeHosts = {});
          function show(host) {
            if (!host || self._envelope !== envelope || !self._hostRowEl) return;
            self._hostEl.textContent = host;
            self._hostRowEl.style.display = "";
          }
          if (cache[handle] !== undefined) return show(cache[handle]);
          fetch("/@" + encodeURIComponent(handle) + "/did-document", { credentials: "include" })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (doc) {
              var host = null;
              ((doc && Array.isArray(doc.service)) ? doc.service : []).forEach(function (svc) {
                if (!host && svc && svc.id === doc.id + "#home" && typeof svc.serviceEndpoint === "string") {
                  host = svc.serviceEndpoint.replace(/^https?:\/\//, "").replace(/\/+$/, "") || null;
                }
              });
              cache[handle] = host;
              show(host);
            })
            .catch(function () {});   // not cached: a later card retries
        },

        // payload.backStamps: [{ objId, x, y, w, ar }] — x/y/w are fractions
        // of the back face, ar is natural width/height (see
        // PostCardEditor's "back view" section). payload may be null.
        // Plain <img> so animated GIF/WebP keep animating.
        _renderBackStamps: function (payload) {
          var layer = this._stampLayerEl;
          if (!layer) return;
          layer.innerHTML = "";
          var stamps = (payload && payload.backStamps) || [];
          var attachments = (payload && payload.attachments) || [];
          var handle = this._handle;
          // The dashed "✉" placeholder only makes sense on a bare back.
          if (this._stampEl && !this._homestarBack) this._stampEl.style.display = stamps.length ? "none" : "flex";
          if (!stamps.length) return;

          // Clamp defensively: a malformed/hand-edited payload must not be
          // able to cover the whole card or sit off-face.
          function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, +v || 0)); }
          var MAX_W = 160 / 420;

          stamps.forEach(function (s) {
            var entry = attachments.filter(function (a) { return a.objId === s.objId; })[0];
            if (!entry) return;
            var w = clamp(s.w, 0.02, MAX_W);
            var img = document.createElement("img");
            img.draggable = false;
            img.alt = "Stamp";
            img.style.cssText = [
              "position:absolute",
              "left:" + clamp(s.x, 0, 1 - w) * 100 + "%",
              "top:" + clamp(s.y, 0, 1) * 100 + "%",
              "width:" + w * 100 + "%",
              "height:auto",
            ].join(";");
            layer.appendChild(img);
            lively.require("lively.identity.FileCrypto").toRun(function () {
              lively.identity.fileCrypto.resolveAttachmentUrl(handle, entry, function (err, url) {
                if (!err && url && img.parentNode) img.src = url;
              });
            });
          });
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

        _toggleFlip: function () {
          this._flipped = !this._flipped;
          this._cardEl.style.transform = this._flipped
            ? "rotateY(180deg)"
            : "rotateY(0deg)";
        },
      },

      "reactions",
      {
        // Shows/hides and (re)populates the reactions footer for the given
        // envelope. reactionsEnabled defaults to true ("each defaulting
        // on", §5.4), so only an explicit `false` turns reactions off.
        // Delete (§6.3) lives in PostCardMailbox's "My Postcards" tab
        // instead of here — this is a read-only reader, and the only place
        // that actually lists a user's own authored cards is that mailbox
        // tab.
        _renderReactionsFooter: function (envelope) {
          var reactionsOn = !(envelope.state && envelope.state.reactionsEnabled === false);

          // Compact mode (and a full card opted into showCommentChip --
          // ConstellationLounge.js's Scroll view) always shows the footer,
          // even with reactions off — the comment chip (_renderCommentChip
          // below) must always be reachable there, unlike a plain full
          // card's footer which hides entirely when it would otherwise be
          // empty.
          if (!this._compactMode && !this._showCommentChip && !reactionsOn) {
            this._footerEl.style.display = "none";
            this._pillsWrapEl.innerHTML = "";
            return;
          }

          this._footerEl.style.display = "flex";

          if (reactionsOn) {
            this._pillsWrapEl.style.display = "";
            this._loadReactions();
          } else {
            this._pillsWrapEl.style.display = "none";
            this._pillsWrapEl.innerHTML = "";
          }

          if (this._compactMode || this._showCommentChip) this._renderCommentChip();
        },

        // The comment-icon chip (ConstellationLounge.js's Scroll view,
        // compact mode, or a full card with showCommentChip) — same
        // DOM-button + inline-style idiom as _renderReactionPills below,
        // with the locked pill styling from the mockup. this._commentCount/
        // this._commentsExpanded are set by open()/setCommentCount/
        // setCommentsExpanded — this method only ever reads them, never
        // fetches on its own (the caller owns both the count and the
        // expand/collapse state, per the plan's single-select-accordion
        // design).
        _renderCommentChip: function () {
          if (!this._commentChipWrapEl) return;
          var self = this;
          this._commentChipWrapEl.innerHTML = "";
          var expanded = !!this._commentsExpanded;
          var chip = document.createElement("button");
          var countTxt = this._commentCount ? this._abbreviateCount(this._commentCount) : "";
          chip.innerHTML =
            '<span class="material-symbols-rounded" style="font-size:14px;line-height:1;vertical-align:middle;">mode_comment</span>' +
            (countTxt ? '<span style="margin-left:3px;vertical-align:middle;">' + countTxt + '</span>' : '');
          chip.style.cssText = [
            "flex:none",
            "display:flex",
            "align-items:center",
            "font-size:14px",
            "padding:2px 9px",
            "border-radius:13px",
            "cursor:pointer",
            "border:1px solid " + (expanded ? "#e8497e" : "#ddd"),
            "background:" + (expanded ? "#fdeef3" : "#fafafa"),
            "color:" + (expanded ? "#e8497e" : "#333"),
          ].join(";");
          ["mousedown", "click"].forEach(function (t) {
            chip.addEventListener(t, function (e) {
              e.preventDefault();
              e.stopPropagation();
              if (t !== "click" || !self._onToggleComments) return;
              self._onToggleComments(self._objId);
            });
          });
          this._commentChipWrapEl.appendChild(chip);
        },

        // Called by the caller (ConstellationLounge.js) once its own
        // parallel reply-count fetch resolves — may land before or after
        // this envelope has rendered, so this just re-renders the chip
        // with whatever count is current rather than assuming an order.
        setCommentCount: function (n) {
          this._commentCount = n || 0;
          if (this._compactMode || this._showCommentChip) this._renderCommentChip();
        },

        // Flips the chip's active styling and un-clamps/re-clamps the
        // caption — expand/collapse STATE lives in the caller (single-
        // select accordion across many rows), this just reflects it.
        setCommentsExpanded: function (expanded) {
          this._commentsExpanded = !!expanded;
          if (this._compactMode && this._contentEl) {
            // force=true adds the clamp class (collapsed), false removes it
            // (expanded, caption reads in full above the comment thread).
            this._contentEl.classList.toggle("pcv-compact-clamped", !this._commentsExpanded);
          }
          if (this._compactMode || this._showCommentChip) this._renderCommentChip();
        },

        _loadReactions: function () {
          var self = this;
          var base = lively.identity.did.baseUrl();
          var url =
            base + "/@" + encodeURIComponent(this._handle) + "/" +
            encodeURIComponent(this._objId) + "/reactions";
          fetch(url, { credentials: "include" })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (data) { if (data) self._renderReactionPills(data); })
            .catch(function () {}); // network error — leave the footer as-is
        },

        // The two fixed reactions, always shown (count appended once
        // non-zero). This view treats them as one reaction slot -- picking
        // one replaces the other; clicking your own again removes it --
        // even though postcard_reactions' shared table now allows a did to
        // stack several different emoji generically (added for room chat
        // reactions). Signed-out viewers see the counts but can't react.
        _renderReactionPills: function (data) {
          var self = this;
          this._pillsWrapEl.innerHTML = "";
          var counts = data.counts || {};
          var mine = data.mine || [];
          var currentUser = lively.identity.did.currentUser();
          var toAnimate = null;

          // One pill split down the middle: star on the left, goose on the
          // right. A 1fr/1fr grid keeps the divider at the exact center even
          // when one count is wider; the outline and divider turn blue when
          // either half is the viewer's, and only that half is tinted.
          var anyMine = ["⭐", "🪿"].some(function (e) { return mine.indexOf(e) !== -1; });
          var edge = anyMine ? "#f0a3bf" : "#ddd";
          var group = document.createElement("div");
          group.style.cssText = [
            "flex:none",
            "display:grid",
            "grid-template-columns:1fr 1fr",
            "align-items:stretch",
            "overflow:hidden",
            "box-sizing:border-box",
            "border-radius:13px",
            "font-size:14px",
            "color:#333",
            "border:1px solid " + edge,
            "background:#fafafa",
          ].join(";");

          ["⭐", "🪿"].forEach(function (emoji, idx) {
            var isMine = mine.indexOf(emoji) !== -1;
            var n = counts[emoji] || 0;
            var pill = document.createElement("button");
            // The emoji sits in its own inline-block span so the pop/spin
            // animation can transform it without moving the count.
            var em = document.createElement("span");
            em.textContent = emoji;
            em.style.cssText = "display:inline-block;";
            pill.appendChild(em);
            if (n) {
              var cnt = document.createElement("span");
              cnt.textContent = self._abbreviateCount(n);
              pill.appendChild(cnt);
            }
            pill.title = (data.byEmoji && data.byEmoji[emoji] || []).join(", ");
            pill.style.cssText = [
              "display:flex",
              "align-items:center",
              "justify-content:center",
              "gap:4px",
              "min-width:42px",
              "padding:2px 10px",
              "border:0",
              "margin:0",
              "font:inherit",
              "color:inherit",
              "cursor:" + (currentUser ? "pointer" : "default"),
              "background:" + (isMine ? "#fdeef3" : "transparent"),
              idx === 1 ? "border-left:1px solid " + edge : "",
            ].join(";");
            ["mousedown", "click"].forEach(function (t) {
              pill.addEventListener(t, function (e) {
                e.preventDefault();
                e.stopPropagation();
                if (t !== "click" || !currentUser) return;
                if (isMine) self._deleteMyReaction(emoji);
                else {
                  // Played once the re-render after the PUT lands, since
                  // that rebuilds every pill (see below).
                  self._pendingReactionAnim = emoji;
                  self._putReaction(emoji, mine);
                }
              });
            });
            group.appendChild(pill);
            if (isMine && self._pendingReactionAnim === emoji) toAnimate = { pill: pill, em: em, emoji: emoji };
          });
          this._pillsWrapEl.appendChild(group);
          this._pendingReactionAnim = null;
          // Only once the whole group is in place: the wrap is right-aligned,
          // so measuring before it is attached would put the burst in the
          // wrong spot.
          if (toAnimate) this._playReactionAnim(toAnimate.pill, toAnimate.em, toAnimate.emoji);
        },

        // 999 -> "999", 1234 -> "1.2k", 12345 -> "12k", 1500000 -> "1.5M".
        // Floors (never rounds up) so 999999 reads "999k", not "1000k".
        _abbreviateCount: function (n) {
          var units = [[1e9, "B"], [1e6, "M"], [1e3, "k"]];
          for (var i = 0; i < units.length; i++) {
            if (n >= units[i][0]) {
              var v = n / units[i][0];
              var txt = v < 10 ? (Math.floor(v * 10) / 10).toString() : Math.floor(v).toString();
              return txt + units[i][1];
            }
          }
          return String(n);
        },

        _ensureReactionAnimCss: function () {
          if (document.getElementById("lively-postcard-reaction-anim")) return;
          var st = document.createElement("style");
          st.id = "lively-postcard-reaction-anim";
          st.textContent = [
            "@keyframes lpc-star-pop{0%{transform:scale(.5) rotate(0)}55%{transform:scale(1.6) rotate(200deg)}100%{transform:scale(1) rotate(360deg)}}",
            "@keyframes lpc-goose-pop{0%{transform:scale(.5) rotate(0)}30%{transform:scale(1.5) rotate(-18deg)}60%{transform:scale(1.5) rotate(14deg)}100%{transform:scale(1) rotate(0)}}",
            "@keyframes lpc-burst{0%{transform:translate(-50%,-50%) scale(1);opacity:1}100%{transform:translate(calc(-50% + var(--dx)),calc(-50% + var(--dy))) scale(.2);opacity:0}}",
            "@keyframes lpc-ring{0%{transform:translate(-50%,-50%) scale(.2);opacity:.9}100%{transform:translate(-50%,-50%) scale(1.5);opacity:0}}",
          ].join("");
          document.head.appendChild(st);
        },

        // Like-button style pop: the emoji springs (star spins, goose
        // wiggles) while a ring and a ring of dots burst out from it. The
        // burst is added to the card (not the pill or the front face): the
        // footer scrolls horizontally and the front face is overflow:hidden,
        // and the pills sit ~12px from the card's bottom edge, so either
        // would clip the lower half of the burst.
        _playReactionAnim: function (pill, emojiEl, emoji) {
          if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
          this._ensureReactionAnimCss();
          var isStar = emoji === "⭐";
          emojiEl.style.animation = (isStar ? "lpc-star-pop" : "lpc-goose-pop") + " 500ms cubic-bezier(.2,.8,.3,1)";

          var fr = this._cardEl.getBoundingClientRect();
          var er = emojiEl.getBoundingClientRect();
          var scale = (this._cardEl.offsetWidth && fr.width / this._cardEl.offsetWidth) || 1;
          var cx = (er.left + er.width / 2 - fr.left) / scale;
          var cy = (er.top + er.height / 2 - fr.top) / scale;

          var colors = isStar ? ["#f5b301", "#ffd54a", "#ff9f1c"] : ["#e8497e", "#ff8fb1", "#ffc2d6"];
          var burst = document.createElement("div");
          burst.style.cssText = "position:absolute;left:" + cx + "px;top:" + cy + "px;width:0;height:0;pointer-events:none;z-index:11;transform:translateZ(1px);";

          var ring = document.createElement("div");
          ring.style.cssText = [
            "position:absolute", "left:0", "top:0", "width:26px", "height:26px",
            "border-radius:50%", "box-sizing:border-box",
            "border:2px solid " + colors[0],
            "animation:lpc-ring 450ms ease-out forwards",
          ].join(";");
          burst.appendChild(ring);

          var N = 8;
          for (var i = 0; i < N; i++) {
            var ang = (i / N) * 2 * Math.PI;
            var dist = 22;
            var dot = document.createElement("div");
            dot.style.cssText = [
              "position:absolute", "left:0", "top:0", "width:5px", "height:5px",
              "border-radius:50%",
              "background:" + colors[i % colors.length],
              "--dx:" + Math.round(Math.cos(ang) * dist) + "px",
              "--dy:" + Math.round(Math.sin(ang) * dist) + "px",
              "animation:lpc-burst 500ms ease-out forwards",
            ].join(";");
            burst.appendChild(dot);
          }

          this._cardEl.appendChild(burst);
          setTimeout(function () {
            if (burst.parentNode) burst.parentNode.removeChild(burst);
          }, 650);
        },

        // previousMine: the viewer's current reactions (from the last load)
        // among the two offered emoji -- cleared first so this view keeps
        // acting as a single reaction slot rather than stacking.
        _putReaction: function (emoji, previousMine) {
          var self = this;
          var base = lively.identity.did.baseUrl();
          var putUrl =
            base + "/@" + encodeURIComponent(this._handle) + "/" +
            encodeURIComponent(this._objId) + "/reactions";
          function doPut() {
            fetch(putUrl, {
              method: "PUT",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ emoji: emoji }),
            })
              .then(function () { self._loadReactions(); })
              .catch(function () {});
          }
          var others = (previousMine || []).filter(function (e) { return e !== emoji; });
          if (!others.length) return doPut();
          var remaining = others.length;
          others.forEach(function (e) {
            var delUrl =
              base + "/@" + encodeURIComponent(self._handle) + "/" +
              encodeURIComponent(self._objId) + "/reactions/" + encodeURIComponent(e);
            fetch(delUrl, { method: "DELETE", credentials: "include" })
              .then(function () { if (--remaining === 0) doPut(); })
              .catch(function () { if (--remaining === 0) doPut(); });
          });
        },

        _deleteMyReaction: function (emoji) {
          var self = this;
          var base = lively.identity.did.baseUrl();
          var url =
            base + "/@" + encodeURIComponent(this._handle) + "/" +
            encodeURIComponent(this._objId) + "/reactions/" + encodeURIComponent(emoji);
          fetch(url, { method: "DELETE", credentials: "include" })
            .then(function () { self._loadReactions(); })
            .catch(function () {});
        },
      },

      "verification",
      {
        // Best-effort, display-only integrity check — see Crypto.js's
        // verifyEnvelopeIntegrity doc comment. Not a security gate.
        _verify: function (envelope) {
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
            this._handle,
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
    );

    // ─── class-side entry points ─────────────────────────────────────────────────

    Object.extend(PostCardViewClass, {
      _openInCenteredWindow: function (view, title) {
        var win = view.openInWindow({ title: title });
        if (win) {
          // Window corner radius comes from the global `.Window` CSS class
          // (base_theme.css), not an inline style: TitleBar/Window both run
          // with BorderStylingMode on, which makes StyleSheetsHTML.js's
          // setBorderRadiusHTML override discard any inline borderRadius in
          // favor of the stylesheet. The TitleBar itself is transparent
          // (`.Window .TitleBar { background: none }`) — what you see behind
          // it is the Window shape's own rounded background — so matching
          // the card's 10px radius (_buildChrome) means widening the Window
          // shape's own radius via a scoped class, not the titleBar.
          if (!document.getElementById("lively-postcard-view-window-style")) {
            var styleEl = document.createElement("style");
            styleEl.id = "lively-postcard-view-window-style";
            styleEl.textContent =
              ".Window.postcard-view-window { border-radius: 10px; }";
            document.head.appendChild(styleEl);
          }
          win.addStyleClassName("postcard-view-window");

          // Postcard-view windows don't need the generic target-morph "Menu"
          // button — removed on just this window instance (not TitleBar's
          // shared button set), then reflow the remaining close/collapse
          // buttons into the freed space.
          if (win.menuButton) {
            win.menuButton.remove();
            win.titleBar.buttons = win.titleBar.buttons.without(win.menuButton);
            win.menuButton = null;
            win.titleBar.adjustElementPositions();
          }

          win.align(
            win.bounds().center(),
            lively.morphic.World.current().visibleBounds().center(),
          );
          win.bringToFront();
        }
        PostCardViewClass._disableWorldRename();
      },

      // A standalone PostCardView boots into its own ephemeral per-object
      // world (IdentityServer.js's buildPostCardPage), which — like any
      // Lively world — gets the generic WorldNameMenuBarEntry by default.
      // Its "rename this world" action serializes the *entire current
      // world* as a fresh type:"world" envelope and PUTs it to whatever
      // objId is in the current URL, with no idea a real postcard envelope
      // already lives there (confirmed live for the wikipage counterpart —
      // see WikiView.js's identical helper). IdentityServer.js's PUT
      // handler now rejects a type-mismatched overwrite server-side
      // regardless, but the action is also meaningless here (a single
      // postcard isn't "a world" to rename), so it's disabled at the
      // source too.
      _disableWorldRename: function () {
        var attempts = 0;
        (function tryDisable() {
          var menuBar = typeof $world !== "undefined" && $world && $world.get(/^MenuBar/);
          var entry = menuBar &&
            (menuBar.submorphs || []).find(function (m) { return m.name === "WorldNameMenuBarEntry"; });
          if (entry) {
            entry.renamePrompt = function () {
              $world.alert("This page is a single post card, not a renameable Lively world.");
            };
            return;
          }
          if (++attempts > 25) return;
          setTimeout(tryDisable, 200);
        })();
      },

      // Three 5-point stars in descending sizes (24x24 viewBox) — the same shape
      // as ConstellationLounge.js's CLUSTERS_STAR_PATH. The postmark's no-location
      // stand-in (_applyHomestarBack) and postmarkIconUrl draw it.
      STAR_CLUSTER_PATH: "M9.00 7.00L10.94 11.83L16.13 12.18L12.14 15.52L13.41 20.57L9.00 17.80L4.59 20.57L5.86 15.52L1.87 12.18L7.06 11.83ZM18.00 2.40L19.18 5.38L22.37 5.58L19.90 7.62L20.70 10.72L18.00 9.00L15.30 10.72L16.10 7.62L13.63 5.58L16.82 5.38ZM19.00 15.50L19.76 17.45L21.85 17.57L20.24 18.90L20.76 20.93L19.00 19.80L17.24 20.93L17.76 18.90L16.15 17.57L18.24 17.45Z",

      // The default postmark (double ring, four cancel waves, star cluster, tilted
      // like the card back's) as an SVG data URL, for an Image morph. No date or
      // place text: it is meant for icon sizes, where that wouldn't read.
      // Natural size is 150x80 (give the Image that aspect ratio).
      postmarkIconUrl: function (color) {
        var wave = [20, 32, 44, 56].map(function (y) {
          return '<path d="M80 ' + y + ' q8 -6 16 0 t16 0 t16 0 t16 0"/>';
        }).join("");
        // The cluster is 26.6 wide at scale 1.3; translate centers its bbox
        // (12.12, 11.65 in icon space) on the ring's center (40, 40).
        var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 150 80">' +
          '<g transform="rotate(-8 75 40)">' +
          '<g fill="none" stroke="' + color + '" stroke-width="3"><circle cx="40" cy="40" r="33"/>' +
          '<circle cx="40" cy="40" r="26" stroke-width="1.5" stroke-dasharray="2 3"/>' + wave + "</g>" +
          '<path fill="' + color + '" transform="translate(24.2 24.9) scale(1.3)" d="' +
          lively.identity.PostCardView.STAR_CLUSTER_PATH + '"/></g></svg>';
        return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
      },

      // options.target      -> embed via target.addMorph(view)
      // options.envelope    -> render immediately, skip the fetch
      // options.cid         -> view a specific historical version
      // options.bounds      -> override the default postcard-shaped extent
      // options.previewMode -> opt-in media-forward content reordering (see
      //   _renderContentHtml) — default false, so every existing caller
      //   keeps rendering in plain natural document order unchanged.
      //   ConstellationLounge.js's reel is the only caller that passes this.
      // options.homestar    -> opt-in homestar back face (ruled lines, postmark,
      //   "To:" address block; see _applyHomestarBack). Default false.
      // options.compactMode -> opt-in "mini card" chrome (ConstellationLounge.js's
      //   Scroll view): no flip/back face/more-menu, a plain-text 2-line-
      //   clamp excerpt instead of rich content, and a comment-icon chip in
      //   the reactions footer. Default false, so every existing caller
      //   keeps its full card chrome unchanged.
      // options.showCommentChip -> opt-in comment-icon chip on a FULL
      //   (non-compactMode) card — ConstellationLounge.js's Scroll view
      //   (full-card rows). Independent of compactMode: shows the chip
      //   (and keeps the footer visible even with reactions off) while
      //   leaving flip/back-face/more-menu/rich content all intact.
      //   Default false.
      // options.commentCount     -> initial count shown on the comment chip
      //   (compactMode or showCommentChip) — the caller fetches this once
      //   up front so the chip doesn't flip from blank to a number after
      //   the fact.
      // options.audienceChip -> opt-in { label, icon?, title?, onClick? } pill in the
      //   handle row saying who the card is shared with (see setAudienceChip).
      // options.onEnvelope -> fired with (envelope, view) each time the card has
      //   an envelope to show, so a caller can set the chip from what is stored.
      // options.onToggleComments -> fired with this._objId when the comment
      //   chip is clicked (compactMode or showCommentChip) — expand/collapse
      //   state lives in the caller, not in this view.
      open: function (handle, objId, options) {
        var opts = options || {};
        var view = new lively.identity.PostCardView(
          opts.bounds || lively.rect(0, 0, 420, 300),
        );
        view._handle = handle;
        view._objId = objId;
        view._cid = opts.cid || null;
        view._envelope = opts.envelope || null;
        view._previewMode = !!opts.previewMode;
        view._pinkHandle = !!opts.pinkHandle;
        view._homestarBack = !!opts.homestar;
        view._compactMode = !!opts.compactMode;
        view._showCommentChip = !!opts.showCommentChip;
        view._commentCount = opts.commentCount || 0;
        view._commentsExpanded = false;
        view._onToggleComments = opts.onToggleComments || null;
        view._audienceChip = opts.audienceChip || null;
        view._onEnvelope = opts.onEnvelope || null;
        if (opts.target) {
          opts.target.addMorph(view);
          view._setup();
        } else {
          this._openInCenteredWindow(view, "Post Card from @" + handle);
          view._setup();
        }
        return view;
      },
    });
  }); // end module('lively.identity.PostCardView')
