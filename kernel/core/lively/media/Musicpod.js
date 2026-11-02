/**
 * lively.media.Musicpod
 *
 * An original click-wheel music player morph: pink metal body, small
 * screen (Menu / Now Playing / Queue), jog ring with drag/scroll physics,
 * and Prev/Center/Next buttons. Wired to a fixed playlist via a
 * third-party video platform's embeddable player API for real audio
 * playback — not a visual mockup.
 * Ported from the runnable design-comp prototype "PinkPod Player.dc.html"
 * (companion spec: "PinkPod Design Spec.dc.html") — those source docs use
 * the original working name "PinkPod"; this implementation is named
 * "Musicpod".
 *
 * Self-rendering morph (raw DOM owned directly, not a BuildSpec submorph
 * tree) — same pattern as lively.media.RetroMediaConsole: _buildChrome()
 * builds a persistent DOM tree once, state changes call targeted _render*
 * methods that mutate the stored element refs directly. The YT.Player
 * instance and all DOM refs are doNotSerialize'd and rebuilt by _setup()
 * on every new render context (world reload, morph copy) — a player
 * resuming mid-track after a reload is more surprising than one that
 * opens fresh, and none of it survives serialization anyway.
 *
 * Entry point:
 *   lively.media.Musicpod.open(optWorldPosition)
 */

module("lively.media.Musicpod")
  .requires()
  .toRun(function () {
    var MusicpodClass = lively.morphic.Box.subclass(
      "lively.media.Musicpod",

      "serialization",
      {
        doNotSerialize: [
          "state",
          "player",
          "_deviceEl",
          "_screenEl",
          "_menuPanelEl",
          "_menuListEl",
          "_menuRowEls",
          "_nowPlayingPanelEl",
          "_artImgEl",
          "_artPlaceholderEl",
          "_titleEl",
          "_authorEl",
          "_statusEl",
          "_queuePanelEl",
          "_queueListEl",
          "_queueEmptyEl",
          "_queueRowEls",
          "_volumeOverlayEl",
          "_volumeBlockEls",
          "_ringEl",
          "_centerBtnEl",
          "_centerIconEl",
          "_playerMountEl",
          "_activeDragCleanup",
          "_volTimer",
          "_queueIds",
          "_queueTitlesLoaded",
        ],
      },

      "initialization",
      {
        initialize: function ($super, optExtent) {
          $super(optExtent || lively.rect(0, 0, this.BASE_WIDTH * this.SCALE, this.BASE_HEIGHT * this.SCALE));
          this.setFill(null);
          this.setBorderWidth(0);
        },

        // Idempotent — called from prepareForNewRenderContext every time
        // this morph gets a fresh shapeNode (first construction, restore
        // from a saved world, or morph-copy).
        _setup: function () {
          this.state = {
            screen: "menu",
            menuIndex: 0,
            queueIndex: 0,
            currentIndex: 0,
            queue: [],
            isPlaying: false,
            volume: 70,
            showVolumeOverlay: false,
            currentTitle: "",
            currentAuthor: "",
            currentVideoId: null,
          };
          this._queueRowEls = [];
          this._buildChrome();
          this._renderAll();
          var self = this;
          this._ensureYouTubeAPI(function () {
            self._initPlayer();
          });
        },

        prepareForNewRenderContext: function ($super, renderCtx) {
          $super(renderCtx);
          this._setup();
        },

        remove: function ($super) {
          if (this.player && this.player.destroy) {
            try {
              this.player.destroy();
            } catch (e) {}
          }
          if (this._activeDragCleanup) this._activeDragCleanup();
          clearTimeout(this._volTimer);
          $super();
        },
      },

      "data",
      {
        ACCENT: "oklch(0.56 0.17 338)",
        RING_SENSITIVITY: 22,
        AUTO_ADVANCE: true,
        // The chrome is built at this fixed pixel size, then the whole
        // device shell is CSS-scaled down by SCALE — simpler and safer
        // than rewriting every hardcoded px value in "chrome" below, and
        // pointer math still works since getBoundingClientRect() already
        // accounts for the transform.
        BASE_WIDTH: 320,
        BASE_HEIGHT: 600,
        SCALE: 0.6,
        menuLabels: ["Now Playing", "Queue"],
        // Fixed at build time per design — there is no in-UI way to
        // change it; swap this ID to point at a different playlist.
        defaultPlaylistId: "PLYlXSzA7olbI",
      },

      "dom helpers",
      {
        _applyStyle: function (el, styles) {
          for (var k in styles) if (styles.hasOwnProperty(k)) el.style[k] = styles[k];
          return el;
        },
        _el: function (tag, styles, parent, className) {
          var e = document.createElement(tag);
          if (className) e.className = className;
          if (styles) this._applyStyle(e, styles);
          if (parent) parent.appendChild(e);
          return e;
        },
        // Keep interactive-control mousedowns from also starting Lively's
        // own morph-body drag, same rationale as RetroMediaConsole.js.
        _stopNativeDrag: function (el) {
          el.addEventListener("mousedown", function (e) {
            e.stopPropagation();
          });
        },
        // Registers a window-level pointermove/pointerup drag pair and
        // remembers how to tear it down, so remove() mid-drag can't leak
        // a window listener against a torn-down shapeNode.
        _trackDrag: function (move, up) {
          var self = this;
          var wrappedUp = function () {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", wrappedUp);
            self._activeDragCleanup = null;
            up();
          };
          this._activeDragCleanup = wrappedUp;
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", wrappedUp);
        },
      },

      "youtube wiring",
      {
        _ensureYouTubeAPI: function (cb) {
          if (window.YT && window.YT.Player) {
            cb();
            return;
          }
          var prev = window.onYouTubeIframeAPIReady;
          window.onYouTubeIframeAPIReady = function () {
            if (prev) prev();
            cb();
          };
          if (!document.getElementById("musicpod-yt-iframe-api")) {
            var s = document.createElement("script");
            s.id = "musicpod-yt-iframe-api";
            s.src = "https://www.youtube.com/iframe_api";
            document.head.appendChild(s);
          }
        },

        _initPlayer: function () {
          var self = this;
          this.player = new window.YT.Player(this._playerMountEl, {
            height: "2",
            width: "2",
            playerVars: { playsinline: 1, controls: 0 },
            events: {
              onReady: function (e) {
                e.target.setVolume(self.state.volume);
                self._loadPlaylist(self.defaultPlaylistId);
              },
              onStateChange: function (e) {
                self.setState({ isPlaying: e.data === 1 });
                self._refreshNowPlaying();
                if (e.data === 0 && self.AUTO_ADVANCE) self._next();
              },
            },
          });
        },

        _loadPlaylist: function (id) {
          var self = this;
          this.player.cuePlaylist({ listType: "playlist", list: id });
          setTimeout(function () {
            var ids = self.player.getPlaylist ? self.player.getPlaylist() : [];
            if (ids && ids.length) self._hydrateQueue(ids);
          }, 1000);
        },

        // Only builds the queue's own data structure (needed for track
        // navigation regardless of whether the Queue screen is ever opened)
        // -- title lookups are deferred to _ensureQueueTitlesLoaded, called
        // once the user actually opens the Queue screen. Was: an unconditional
        // noembed.com fetch per playlist entry here, fired on every single
        // page load whether or not the Queue screen was ever viewed (measured
        // live: 13 simultaneous third-party requests per load on start.html,
        // a free service this app doesn't control the rate limits of).
        _hydrateQueue: function (ids) {
          this._queueIds = ids;
          this._queueTitlesLoaded = false;
          this.setState({
            queue: ids.map(function (id, i) {
              return { id: id, title: "Loading…", index: i };
            }),
            currentIndex: 0,
            queueIndex: 0,
          });
        },

        // Idempotent -- safe to call every time the Queue screen opens.
        _ensureQueueTitlesLoaded: function () {
          if (this._queueTitlesLoaded || !this._queueIds) return;
          this._queueTitlesLoaded = true;
          var self = this;
          this._queueIds.forEach(function (id, i) {
            fetch("https://noembed.com/embed?url=https://www.youtube.com/watch?v=" + id)
              .then(function (r) {
                return r.json();
              })
              .then(function (data) {
                self._updateQueueTrackTitle(i, data.title || "Track " + (i + 1));
              })
              .catch(function () {});
          });
        },

        // Patches one row's title directly rather than a full setState,
        // since these arrive one-at-a-time asynchronously and a full
        // _renderAll per arrival would otherwise rebuild the whole list.
        _updateQueueTrackTitle: function (i, title) {
          if (!this.state.queue[i]) return;
          this.state.queue[i].title = title;
          this._renderQueueList();
        },

        _refreshNowPlaying: function () {
          if (!this.player || !this.player.getVideoData) return;
          var data = this.player.getVideoData();
          if (data && data.video_id) {
            this.setState({ currentVideoId: data.video_id, currentTitle: data.title || "", currentAuthor: data.author || "" });
          }
        },
      },

      "ring physics",
      {
        _angleTo: function (cx, cy, x, y) {
          return (Math.atan2(y - cy, x - cx) * 180) / Math.PI;
        },

        _onRingPointerDown: function (e) {
          if (e.target.closest && e.target.closest("[data-nodrag]")) return;
          e.stopPropagation();
          var self = this;
          var rect = this._ringEl.getBoundingClientRect();
          var cx = rect.left + rect.width / 2;
          var cy = rect.top + rect.height / 2;
          var lastAngle = this._angleTo(cx, cy, e.clientX, e.clientY);
          var accum = 0;
          var move = function (ev) {
            var angle = self._angleTo(cx, cy, ev.clientX, ev.clientY);
            var delta = angle - lastAngle;
            if (delta > 180) delta -= 360;
            if (delta < -180) delta += 360;
            lastAngle = angle;
            accum += delta;
            while (accum >= self.RING_SENSITIVITY) {
              accum -= self.RING_SENSITIVITY;
              self._ringStep(1);
            }
            while (accum <= -self.RING_SENSITIVITY) {
              accum += self.RING_SENSITIVITY;
              self._ringStep(-1);
            }
          };
          var up = function () {};
          this._trackDrag(move, up);
        },

        _onRingWheel: function (e) {
          e.preventDefault();
          e.stopPropagation();
          this._ringStep(e.deltaY > 0 ? 1 : -1);
        },

        _ringStep: function (dir) {
          var s = this.state;
          if (s.screen === "menu") {
            var n = this.menuLabels.length;
            this.setState({ menuIndex: (s.menuIndex + dir + n) % n });
          } else if (s.screen === "queue") {
            var len = (s.queue || []).length || 1;
            this.setState({ queueIndex: Math.max(0, Math.min(len - 1, s.queueIndex + dir)) });
          } else if (s.screen === "now-playing") {
            this._adjustVolume(dir * 5);
          }
        },

        _adjustVolume: function (delta) {
          var self = this;
          var v = Math.max(0, Math.min(100, this.state.volume + delta));
          if (this.player && this.player.setVolume) this.player.setVolume(v);
          this.setState({ volume: v, showVolumeOverlay: true });
          clearTimeout(this._volTimer);
          this._volTimer = setTimeout(function () {
            self.setState({ showVolumeOverlay: false });
          }, 1200);
        },
      },

      "navigation & playback",
      {
        _selectMenuItem: function (i) {
          var item = this.menuLabels[i];
          var screen = item === "Now Playing" ? "now-playing" : "queue";
          if (screen === "queue") this._ensureQueueTitlesLoaded();
          this.setState({ screen: screen, menuIndex: i });
        },

        _handleCenter: function () {
          var s = this.state;
          if (s.screen === "menu") this._selectMenuItem(s.menuIndex);
          else if (s.screen === "queue") this._selectTrack(s.queueIndex);
          else if (s.screen === "now-playing") this._playPause();
        },

        _selectTrack: function (index) {
          if (this.player && this.player.playVideoAt) this.player.playVideoAt(index);
          this.setState({ screen: "now-playing", currentIndex: index, queueIndex: index, isPlaying: true });
        },

        _menuBack: function () {
          this.setState({ screen: "menu" });
        },

        _prev: function () {
          if (this.player && this.player.previousVideo) this.player.previousVideo();
        },
        _next: function () {
          if (this.player && this.player.nextVideo) this.player.nextVideo();
        },
        _playPause: function () {
          if (!this.player || !this.player.getPlayerState) return;
          var st = this.player.getPlayerState();
          if (st === 1) this.player.pauseVideo();
          else this.player.playVideo();
        },
      },

      "chrome",
      {
        _buildChrome: function () {
          var shapeNode = this.renderContext().shapeNode;
          shapeNode.innerHTML = "";
          shapeNode.style.fontFamily = "'Poppins',sans-serif";
          shapeNode.style.userSelect = "none";

          var device = this._el(
            "div",
            {
              width: this.BASE_WIDTH + "px",
              height: this.BASE_HEIGHT + "px",
              boxSizing: "border-box",
              background: "linear-gradient(160deg, oklch(0.85 0.08 350) 0%, oklch(0.72 0.13 350) 45%, oklch(0.5 0.15 352) 100%)",
              borderRadius: "42px",
              padding: "26px 16px 30px",
              boxShadow: "0 30px 60px -20px rgba(0,0,0,.35), 0 2px 0 rgba(255,255,255,.4) inset",
              position: "relative",
              transform: "scale(" + this.SCALE + ")",
              transformOrigin: "0 0",
            },
            shapeNode,
          );
          this._deviceEl = device;

          this._buildScreenBezel(device);
          this._buildMenuButton(device);
          this._buildRing(device);

          this._playerMountEl = this._el(
            "div",
            { width: "2px", height: "2px", overflow: "hidden", position: "absolute", opacity: "0.01", pointerEvents: "none" },
            device,
          );
        },

        _buildScreenBezel: function (device) {
          var bezel = this._el(
            "div",
            {
              background: "oklch(0.15 0.02 340)",
              borderRadius: "20px",
              padding: "10px",
              boxShadow: "inset 0 2px 4px rgba(0,0,0,.6)",
              marginBottom: "22px",
            },
            device,
          );
          var screen = this._el("div", { borderRadius: "12px", overflow: "hidden", height: "220px", position: "relative" }, bezel);
          this._screenEl = screen;

          this._buildMenuScreen(screen);
          this._buildNowPlayingScreen(screen);
          this._buildQueueScreen(screen);
          this._buildVolumeOverlay(screen);
        },

        _buildMenuScreen: function (screen) {
          var self = this;
          var panel = this._el("div", { background: "oklch(0.97 0.008 85)", height: "100%", display: "flex", flexDirection: "column" }, screen);
          this._menuPanelEl = panel;
          var head = this._el("div", { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px 6px" }, panel);
          this._el("div", { fontWeight: "700", fontSize: "13px", letterSpacing: "0.5px", color: "oklch(0.24 0.01 340)" }, head).textContent = "Musicpod";
          this._el("div", { width: "8px", height: "8px", borderRadius: "50%", background: this.ACCENT }, head);

          this._menuListEl = this._el("div", { flex: "1", overflowY: "auto", padding: "0 8px 8px" }, panel);
          this._menuRowEls = this.menuLabels.map(function (label, i) {
            var row = self._el(
              "div",
              {
                padding: "12px 10px",
                borderRadius: "10px",
                marginBottom: "4px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                fontSize: "15px",
                fontWeight: "600",
                cursor: "pointer",
              },
              self._menuListEl,
            );
            self._stopNativeDrag(row);
            var labelSpan = self._el("span", {}, row);
            labelSpan.textContent = label;
            var chevronSpan = self._el("span", {}, row);
            row.addEventListener("click", function () {
              self._selectMenuItem(i);
            });
            return { row: row, chevron: chevronSpan };
          });
        },

        _buildNowPlayingScreen: function (screen) {
          var panel = this._el(
            "div",
            {
              background: "linear-gradient(160deg, oklch(0.28 0.04 340), oklch(0.14 0.02 340))",
              height: "100%",
              display: "none",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: "16px",
              gap: "10px",
            },
            screen,
          );
          this._nowPlayingPanelEl = panel;

          var artWrap = this._el("div", { width: "120px", height: "120px", borderRadius: "12px", position: "relative", boxShadow: "0 8px 20px rgba(0,0,0,.4)" }, panel);
          this._artImgEl = this._el("img", { width: "120px", height: "120px", borderRadius: "12px", objectFit: "cover", display: "none" }, artWrap);
          this._artPlaceholderEl = this._el(
            "div",
            {
              position: "absolute",
              inset: "0",
              borderRadius: "12px",
              background: "repeating-linear-gradient(45deg, oklch(0.3 0.03 340), oklch(0.3 0.03 340) 6px, oklch(0.24 0.02 340) 6px, oklch(0.24 0.02 340) 12px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              textAlign: "center",
            },
            artWrap,
          );
          this._el("span", { fontFamily: "'Roboto Mono',monospace", fontSize: "9px", color: "oklch(0.75 0.02 340)" }, this._artPlaceholderEl).textContent = "album art";

          var textWrap = this._el("div", { textAlign: "center" }, panel);
          this._titleEl = this._el(
            "div",
            { fontSize: "14px", fontWeight: "600", color: "#fff", maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
            textWrap,
          );
          this._authorEl = this._el("div", { fontSize: "11px", color: "oklch(0.7 0.02 340)", marginTop: "2px" }, textWrap);
          this._statusEl = this._el(
            "div",
            { fontFamily: "'Roboto Mono',monospace", fontSize: "10px", letterSpacing: "1px", color: this.ACCENT, textTransform: "uppercase" },
            panel,
          );
        },

        _buildQueueScreen: function (screen) {
          var panel = this._el("div", { background: "oklch(0.97 0.008 85)", height: "100%", display: "none", flexDirection: "column" }, screen);
          this._queuePanelEl = panel;
          this._el("div", { padding: "10px 12px 4px", fontWeight: "700", fontSize: "12px", letterSpacing: "0.5px", color: "oklch(0.24 0.01 340)" }, panel).textContent = "QUEUE";
          this._queueListEl = this._el("div", { flex: "1", overflowY: "auto", padding: "0 8px 8px" }, panel);
          this._queueEmptyEl = this._el("div", { padding: "20px 10px", fontSize: "12px", color: "oklch(0.55 0.02 340)" }, this._queueListEl);
          this._queueEmptyEl.textContent = "Loading playlist…";
        },

        _buildVolumeOverlay: function (screen) {
          var overlay = this._el(
            "div",
            { position: "absolute", left: "10%", right: "10%", bottom: "12px", background: "rgba(0,0,0,.55)", borderRadius: "10px", padding: "8px 10px", display: "none" },
            screen,
          );
          this._volumeOverlayEl = overlay;
          this._el("div", { fontFamily: "'Roboto Mono',monospace", fontSize: "9px", color: "#fff", letterSpacing: "1px", marginBottom: "5px" }, overlay).textContent = "VOLUME";
          var bar = this._el("div", { display: "flex", gap: "3px" }, overlay);
          this._volumeBlockEls = [];
          for (var i = 0; i < 10; i++) {
            this._volumeBlockEls.push(this._el("div", { flex: "1", height: "5px", borderRadius: "2px" }, bar));
          }
        },

        _buildMenuButton: function (device) {
          var self = this;
          var pill = this._el(
            "div",
            {
              width: "fit-content",
              margin: "0 auto 14px",
              padding: "6px 18px",
              borderRadius: "999px",
              background: "rgba(255,255,255,.25)",
              color: "#fff",
              fontSize: "11px",
              letterSpacing: "1.5px",
              fontWeight: "600",
              cursor: "pointer",
              boxShadow: "inset 0 1px 1px rgba(255,255,255,.5), 0 1px 2px rgba(0,0,0,.2)",
              textAlign: "center",
            },
            device,
          );
          pill.textContent = "MENU";
          this._stopNativeDrag(pill);
          pill.addEventListener("click", function () {
            self._menuBack();
          });
        },

        _buildRing: function (device) {
          var self = this;
          var ringRow = this._el("div", { display: "flex", alignItems: "center", justifyContent: "center", marginBottom: "22px" }, device);
          var ring = this._el(
            "div",
            {
              width: "220px",
              height: "220px",
              flex: "none",
              position: "relative",
              borderRadius: "50%",
              background: "radial-gradient(circle at 35% 30%, oklch(0.95 0.006 85), oklch(0.88 0.01 85) 60%, oklch(0.8 0.02 85) 100%)",
              boxShadow: "inset 0 2px 6px rgba(255,255,255,.9), inset 0 -6px 10px rgba(0,0,0,.15), 0 10px 20px rgba(0,0,0,.25)",
              touchAction: "none",
              cursor: "grab",
            },
            ringRow,
          );
          this._ringEl = ring;
          this._stopNativeDrag(ring);
          ring.addEventListener("pointerdown", function (e) {
            self._onRingPointerDown(e);
          });
          ring.addEventListener(
            "wheel",
            function (e) {
              self._onRingWheel(e);
            },
            { passive: false },
          );

          var prevBtn = this._el(
            "div",
            {
              position: "absolute",
              left: "14px",
              top: "50%",
              transform: "translateY(-50%)",
              width: "38px",
              height: "38px",
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "2px",
              cursor: "pointer",
            },
            ring,
          );
          prevBtn.setAttribute("data-nodrag", "true");
          this._el("div", { width: "0", height: "0", borderTop: "5px solid transparent", borderBottom: "5px solid transparent", borderRight: "8px solid oklch(0.4 0.02 340)" }, prevBtn);
          this._el("div", { width: "2px", height: "11px", background: "oklch(0.4 0.02 340)", borderRadius: "1px" }, prevBtn);
          this._stopNativeDrag(prevBtn);
          prevBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            self._prev();
          });

          var centerBtn = this._el(
            "div",
            {
              width: "96px",
              height: "96px",
              borderRadius: "50%",
              position: "absolute",
              top: "50%",
              left: "50%",
              transform: "translate(-50%,-50%)",
              background: "linear-gradient(160deg, oklch(0.88 0.09 350), oklch(0.68 0.14 350))",
              boxShadow: "0 6px 14px rgba(0,0,0,.25), inset 0 -3px 6px rgba(0,0,0,.15)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            },
            ring,
          );
          centerBtn.setAttribute("data-nodrag", "true");
          this._centerBtnEl = centerBtn;
          this._centerIconEl = this._el("div", {}, centerBtn);
          this._stopNativeDrag(centerBtn);
          centerBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            self._handleCenter();
          });

          var nextBtn = this._el(
            "div",
            {
              position: "absolute",
              right: "14px",
              top: "50%",
              transform: "translateY(-50%)",
              width: "38px",
              height: "38px",
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "2px",
              cursor: "pointer",
            },
            ring,
          );
          nextBtn.setAttribute("data-nodrag", "true");
          this._el("div", { width: "2px", height: "11px", background: "oklch(0.4 0.02 340)", borderRadius: "1px" }, nextBtn);
          this._el("div", { width: "0", height: "0", borderTop: "5px solid transparent", borderBottom: "5px solid transparent", borderLeft: "8px solid oklch(0.4 0.02 340)" }, nextBtn);
          this._stopNativeDrag(nextBtn);
          nextBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            self._next();
          });
        },
      },

      "rendering",
      {
        setState: function (patch) {
          Object.assign(this.state, patch);
          this._renderAll();
        },

        _renderAll: function () {
          this._renderScreen();
          this._renderMenuList();
          this._renderNowPlaying();
          this._renderQueueList();
          this._renderVolumeOverlay();
          this._renderCenterIcon();
        },

        _renderScreen: function () {
          var s = this.state;
          this._menuPanelEl.style.display = s.screen === "menu" ? "flex" : "none";
          this._nowPlayingPanelEl.style.display = s.screen === "now-playing" ? "flex" : "none";
          this._queuePanelEl.style.display = s.screen === "queue" ? "flex" : "none";
        },

        _renderMenuList: function () {
          var s = this.state;
          var self = this;
          this._menuRowEls.forEach(function (entry, i) {
            var selected = i === s.menuIndex;
            self._applyStyle(entry.row, {
              background: selected ? self.ACCENT : "transparent",
              color: selected ? "#fff" : "oklch(0.24 0.01 340)",
            });
            entry.chevron.textContent = selected ? "›" : "";
          });
        },

        _renderNowPlaying: function () {
          var s = this.state;
          var hasVideo = !!s.currentVideoId;
          this._artImgEl.style.display = hasVideo ? "block" : "none";
          this._artPlaceholderEl.style.display = hasVideo ? "none" : "flex";
          if (hasVideo) this._artImgEl.src = "https://img.youtube.com/vi/" + s.currentVideoId + "/hqdefault.jpg";
          this._titleEl.textContent = s.currentTitle || "Loading playlist…";
          this._authorEl.textContent = s.currentAuthor || "—";
          this._statusEl.textContent = s.isPlaying ? "Playing" : "Paused";
        },

        _renderQueueList: function () {
          var self = this;
          var s = this.state;
          var queue = s.queue || [];

          if (queue.length === 0) {
            this._queueEmptyEl.style.display = "block";
            this._queueRowEls.forEach(function (entry) {
              entry.row.remove();
            });
            this._queueRowEls = [];
            return;
          }
          this._queueEmptyEl.style.display = "none";

          if (this._queueRowEls.length !== queue.length) {
            this._queueRowEls.forEach(function (entry) {
              entry.row.remove();
            });
            this._queueRowEls = queue.map(function (t, i) {
              var row = self._el(
                "div",
                { padding: "10px", borderRadius: "10px", marginBottom: "4px", fontSize: "13px", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
                self._queueListEl,
              );
              self._stopNativeDrag(row);
              row.addEventListener("click", function () {
                self._selectTrack(i);
              });
              return { row: row };
            });
          }

          this._queueRowEls.forEach(function (entry, i) {
            var t = queue[i];
            var selected = i === s.queueIndex;
            var current = i === s.currentIndex;
            self._applyStyle(entry.row, {
              background: selected ? self.ACCENT : "transparent",
              color: selected ? "#fff" : "oklch(0.24 0.01 340)",
              fontWeight: selected ? "600" : "500",
            });
            entry.row.textContent = (current ? "▶ " : "") + (t.title || "Loading…");
          });
        },

        _renderVolumeOverlay: function () {
          var s = this.state;
          var self = this;
          this._volumeOverlayEl.style.display = s.showVolumeOverlay ? "block" : "none";
          this._volumeBlockEls.forEach(function (el, i) {
            var filled = i < Math.round(s.volume / 10);
            el.style.background = filled ? self.ACCENT : "rgba(255,255,255,.2)";
          });
        },

        _renderCenterIcon: function () {
          var s = this.state;
          this._centerIconEl.innerHTML = "";
          this._centerIconEl.style.cssText = "";
          if (s.isPlaying) {
            this._applyStyle(this._centerIconEl, { display: "flex", gap: "5px" });
            this._el("div", { width: "5px", height: "18px", background: "oklch(0.4 0.02 340)", borderRadius: "1px" }, this._centerIconEl);
            this._el("div", { width: "5px", height: "18px", background: "oklch(0.4 0.02 340)", borderRadius: "1px" }, this._centerIconEl);
          } else {
            this._applyStyle(this._centerIconEl, {
              display: "block",
              width: "0",
              height: "0",
              borderTop: "9px solid transparent",
              borderBottom: "9px solid transparent",
              borderLeft: "14px solid oklch(0.4 0.02 340)",
            });
          }
        },
      },
    );

    MusicpodClass.open = function (optPos) {
      var m = new lively.media.Musicpod();
      var half = m.getExtent().scaleBy(0.5);
      m.openInWorld(optPos || lively.morphic.World.current().visibleBounds().center().subPt(half));
      return m;
    };

    // Poppins / Roboto Mono, per design spec §4 — injected once, guarded
    // so reopening/copying this morph doesn't pile up duplicate <link> tags.
    if (!document.getElementById("musicpod-fonts")) {
      var fontLink = document.createElement("link");
      fontLink.id = "musicpod-fonts";
      fontLink.rel = "stylesheet";
      fontLink.href = "https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&family=Roboto+Mono:wght@400;500&display=swap";
      document.head.appendChild(fontLink);
    }
  }); // end module('lively.media.Musicpod')
