/**
 * lively.media.RetroMediaConsole
 *
 * A dual-mode retro media player morph: a vinyl-record "turntable" for audio
 * tracks (spinning platter, draggable tonearm scrub, seek bar, volume knob,
 * track queue drawer) and a CRT-TV + VCR deck for video "channels" (channel
 * buttons, rewind/play/fast-forward/stop/eject transport, tape-insert
 * animation). Both modes drive real HTML5 <audio>/<video> elements — this is
 * a working media player, not a visual mockup.
 *
 * Self-rendering morph (raw DOM owned directly, not a BuildSpec submorph
 * tree) — same pattern as lively.identity.PostCardView: _buildChrome()
 * builds a persistent DOM tree once, state changes call targeted _render*
 * methods that mutate the stored element refs directly. All hand-built DOM
 * refs and live media elements are doNotSerialize'd and rebuilt by _setup()
 * on every new render context (world reload, morph copy), same rationale
 * as PostCardView — none of it survives serialization, and re-fetching a
 * blank player on restore (rather than trying to preserve mid-playback
 * state) is the correct default here.
 *
 * Entry point:
 *   lively.media.RetroMediaConsole.open(optWorldPosition)
 */

module("lively.media.RetroMediaConsole")
  .requires()
  .toRun(function () {
    var MEDIA_BASE = (lively.Config && lively.Config.get('mediaBase', true)) || "/apps/RetroMediaConsole/media/";

    var RetroMediaConsoleClass = lively.morphic.Box.subclass(
      "lively.media.RetroMediaConsole",

      "serialization",
      {
        doNotSerialize: [
          "state",
          "_cabinetEl",
          "_audioPanelEl",
          "_videoPanelEl",
          "_powerDotEl",
          "_modeAudioBtnEl",
          "_modeVideoBtnEl",
          "_platterSpinEl",
          "_labelGradientEl",
          "_progressRingEl",
          "_tonearmEl",
          "_tonearmPivotEl",
          "_trackTitleEl",
          "_trackArtistEl",
          "_seekTrackEl",
          "_seekFillEl",
          "_seekKnobEl",
          "_elapsedEl",
          "_durationEl",
          "_shuffleBtnEl",
          "_shuffleLedEl",
          "_prevBtnEl",
          "_repeatBtnEl",
          "_repeatLedEl",
          "_playBtnEl",
          "_playGlyphWrapEl",
          "_nextBtnEl",
          "_volumeKnobEl",
          "_volumePointerEl",
          "_volumeLabelEl",
          "_drawerEl",
          "_drawerTabEl",
          "_openTabEl",
          "_queueListEl",
          "_queueRowEls",
          "_tvScreenEl",
          "_videoEl",
          "_tvGlitchEl",
          "_channelLabelEl",
          "_channelBtnEls",
          "_tvVolumeKnobEl",
          "_tvVolumePointerEl",
          "_vcrCounterEl",
          "_tapeSlotEl",
          "_tapeEl",
          "_rewBtnEl",
          "_vcrPlayBtnEl",
          "_vcrPlayGlyphEl",
          "_ffBtnEl",
          "_stopBtnEl",
          "_ejectBtnEl",
          "_ejectGlyphEl",
          "_audioEl",
          "_durationProbes",
          "_activeDragCleanup",
          "_glitchTimeout",
        ],
      },

      "initialization",
      {
        // Panel content row is platter(300) + gap(28) + control(min 280) +
        // gap(28) + drawer(0 or 220), plus panel padding(52) and cabinet
        // padding(44) — 740 is the minimum that doesn't squeeze the
        // transport row into overlapping the QUEUE tab; verified live.
        AUDIO_EXTENT: { w: 740, h: 500 },
        AUDIO_EXTENT_WITH_DRAWER: { w: 960, h: 500 },
        VIDEO_EXTENT: { w: 700, h: 800 },

        initialize: function ($super, optExtent) {
          $super(optExtent || lively.rect(0, 0, 740, 500));
          this.setFill(null);
          this.setBorderWidth(0);
        },

        // Idempotent — called from prepareForNewRenderContext every time
        // this morph gets a fresh shapeNode (first construction, restore
        // from a saved world, or morph-copy). All state resets to defaults
        // on purpose: a media player resuming mid-track after a reload is
        // more surprising than one that opens fresh, and none of the real
        // <audio>/<video> elements survive serialization anyway.
        _setup: function () {
          this.state = {
            mode: "audio",
            playing: false,
            trackIndex: 0,
            volume: 68,
            shuffle: false,
            repeat: false,
            drawerOpen: false,
            scrubProgress: 0,
            dragging: false,
            videoPlaying: false,
            channel: 0,
            tvVolume: 55,
            tapeInserted: true,
            videoGlitch: false,
          };
          // Media elements are created (not yet inserted anywhere) before
          // _buildChrome() runs, since _buildChrome() resets shapeNode's
          // whole DOM subtree and _buildVideoPanel() needs this._videoEl
          // to already exist so it can insert it into the TV screen div
          // as part of that same rebuild.
          this._createAudioElement();
          this._createVideoElement();
          this._buildChrome();
          this._preloadTrackDurations();
          this._renderAll();
        },

        prepareForNewRenderContext: function ($super, renderCtx) {
          $super(renderCtx);
          this._setup();
        },

        remove: function ($super) {
          if (this._audioEl) this._audioEl.pause();
          if (this._videoEl) this._videoEl.pause();
          if (this._activeDragCleanup) this._activeDragCleanup();
          clearTimeout(this._glitchTimeout);
          $super();
        },
      },

      "data",
      {
        channelHues: [28, 200, 100, 300],

        // Public-domain 78rpm transfers, Casa Loma Orchestra (Public Domain
        // Mark 1.0) — see apps/RetroMediaConsole/media/MANIFEST.md.
        tracks: [
          {
            title: "Alexander's Ragtime Band",
            artist: "Casa Loma Orchestra",
            src: MEDIA_BASE + "tracks/track1.mp3",
            presetHue: 28,
          },
          {
            title: "White Jazz",
            artist: "Casa Loma Orchestra",
            src: MEDIA_BASE + "tracks/track2.mp3",
            presetHue: 150,
          },
          {
            title: "I Got Rhythm",
            artist: "Casa Loma Orchestra",
            src: MEDIA_BASE + "tracks/track3.mp3",
            presetHue: 220,
          },
          {
            title: "Ol' Man River",
            artist: "Casa Loma Orchestra",
            src: MEDIA_BASE + "tracks/track4.mp3",
            presetHue: 280,
          },
          {
            title: "Limehouse Blues",
            artist: "Casa Loma Orchestra",
            src: MEDIA_BASE + "tracks/track5.mp3",
            presetHue: 340,
          },
        ],

        channels: [
          { label: "01", src: MEDIA_BASE + "video/channel1.mp4" },
          { label: "02", src: MEDIA_BASE + "video/channel2.mp4" },
          { label: "03", src: MEDIA_BASE + "video/channel3.mp4" },
          { label: "04", src: MEDIA_BASE + "video/channel4.mp4" },
        ],

        sfx: {
          click: MEDIA_BASE + "sfx/click.mp3",
          tick: MEDIA_BASE + "sfx/tick.mp3",
          thunk: MEDIA_BASE + "sfx/thunk.mp3",
          static: MEDIA_BASE + "sfx/static.mp3",
          slide: MEDIA_BASE + "sfx/slide.mp3",
          tape: MEDIA_BASE + "sfx/tape.mp3",
        },
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
        _stopNativeDrag: function (el) {
          // Keep interactive-control pointerdowns from also starting
          // Lively's own morph-body drag (same rationale as
          // PostCardView.js's wrapper mousedown listener) while still
          // letting the plain morph background remain draggable as a part.
          el.addEventListener("mousedown", function (e) {
            e.stopPropagation();
          });
        },
        _triangleStyle: function (dir, size) {
          size = size || 11;
          var half = Math.round(size * 0.64);
          var s = {
            width: "0",
            height: "0",
            borderTop: half + "px solid transparent",
            borderBottom: half + "px solid transparent",
          };
          s[dir === "r" ? "borderLeft" : "borderRight"] = size + "px solid oklch(0.9 0.01 80)";
          return s;
        },
        _presetGradient: function (hue) {
          return (
            "radial-gradient(circle at 30% 25%, oklch(0.7 0.12 " +
            hue +
            ") 0%, oklch(0.56 0.11 " +
            (hue + 25) +
            ") 45%, oklch(0.4 0.09 " +
            (hue + 50) +
            ") 100%)"
          );
        },
        _fmtMinSec: function (total) {
          total = Math.max(0, Math.round(total || 0));
          var m = Math.floor(total / 60),
            s = String(total % 60).padStart(2, "0");
          return m + ":" + s;
        },
        _fmtHMS: function (total) {
          total = Math.max(0, Math.round(total || 0));
          var h = String(Math.floor(total / 3600)).padStart(2, "0"),
            m = String(Math.floor((total % 3600) / 60)).padStart(2, "0"),
            s = String(total % 60).padStart(2, "0");
          return h + ":" + m + ":" + s;
        },
        _playSfx: function (name) {
          var src = this.sfx[name];
          if (!src) return;
          try {
            var a = new Audio(src);
            a.volume = 0.55;
            a.play().catch(function () {});
          } catch (e) {}
        },

        // Registers a window-level pointermove/pointerup drag pair and
        // remembers how to tear it down. Needed because remove() (morph
        // deleted/world closed mid-drag) has no other way to reach these
        // per-drag closures — without this, dragging a knob/tonearm/seek
        // bar and then deleting the console mid-drag would leak a window
        // listener that keeps firing against a morph with a torn-down
        // shapeNode.
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

      "media wiring",
      {
        _createAudioElement: function () {
          var self = this;
          var audio = document.createElement("audio");
          audio.preload = "metadata";
          audio.style.display = "none";
          this._audioEl = audio;
          audio.src = this.tracks[this.state.trackIndex].src;
          audio.volume = this.state.volume / 100;

          audio.addEventListener("timeupdate", function () {
            if (self.state.dragging) return;
            var dur = audio.duration || 0;
            self.state.scrubProgress = dur ? (audio.currentTime / dur) * 100 : 0;
            self._renderAudioProgress();
          });
          audio.addEventListener("loadedmetadata", function () {
            self._renderAudioProgress();
          });
          audio.addEventListener("ended", function () {
            if (self.state.repeat) {
              audio.currentTime = 0;
              audio.play().catch(function () {});
              return;
            }
            self._advanceTrack(1, true);
          });
        },

        // Populates the queue drawer's duration column. Uses throwaway
        // probe <audio> elements (kept alive via this._durationProbes so
        // they aren't GC'd before 'loadedmetadata' fires) rather than the
        // single shared _audioEl, since that one only ever holds whichever
        // track is currently selected.
        _preloadTrackDurations: function () {
          var self = this;
          this._durationProbes = this.tracks.map(function (t, i) {
            var probe = new Audio();
            probe.preload = "metadata";
            probe.addEventListener("loadedmetadata", function () {
              var entry = self._queueRowEls && self._queueRowEls[i];
              if (entry) entry.durEl.textContent = self._fmtMinSec(probe.duration);
            });
            probe.src = t.src;
            return probe;
          });
        },

        _createVideoElement: function () {
          var self = this;
          var video = document.createElement("video");
          this._applyStyle(video, {
            position: "absolute",
            inset: "0",
            width: "100%",
            height: "100%",
            objectFit: "cover",
          });
          video.loop = true;
          video.playsInline = true;
          this._videoEl = video;
          video.src = this.channels[this.state.channel].src;
          video.volume = this.state.tvVolume / 100;
          video.addEventListener("timeupdate", function () {
            self._renderVcrCounter();
          });
        },
      },

      "chrome",
      {
        _buildChrome: function () {
          var shapeNode = this.renderContext().shapeNode;
          shapeNode.innerHTML = "";
          shapeNode.style.fontFamily = "system-ui,-apple-system,sans-serif";
          shapeNode.style.userSelect = "none";
          shapeNode.appendChild(this._audioEl);

          var cabinet = this._el(
            "div",
            {
              position: "relative",
              width: "100%",
              height: "100%",
              boxSizing: "border-box",
              borderRadius: "18px",
              padding: "22px",
              background:
                "repeating-linear-gradient(95deg,rgba(255,255,255,.035) 0px,rgba(255,255,255,.035) 1px,transparent 2px,transparent 7px)," +
                "linear-gradient(135deg,oklch(0.4 0.055 48),oklch(0.32 0.05 48) 55%,oklch(0.36 0.052 48))",
              boxShadow: "0 30px 60px -20px rgba(30,20,10,.5),inset 0 1px 0 rgba(255,255,255,.06)",
            },
            shapeNode,
          );
          this._cabinetEl = cabinet;
          [
            ["left", "top"],
            ["right", "top"],
            ["left", "bottom"],
            ["right", "bottom"],
          ].forEach((corner) => {
            var dot = this._el(
              "div",
              {
                position: "absolute",
                width: "9px",
                height: "9px",
                borderRadius: "50%",
                [corner[0]]: "9px",
                [corner[1]]: "9px",
                background: "linear-gradient(135deg,oklch(0.85 0.005 250),oklch(0.55 0.005 250))",
                boxShadow: "0 1px 2px rgba(0,0,0,.5)",
              },
              cabinet,
            );
          });

          this._buildHeader(cabinet);
          this._buildAudioPanel(cabinet);
          this._buildVideoPanel(cabinet);
        },

        _buildHeader: function (cabinet) {
          var self = this;
          var header = this._el(
            "div",
            {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "18px",
              padding: "0 4px",
              position: "relative",
              zIndex: "2",
            },
            cabinet,
          );

          var left = this._el("div", { display: "flex", alignItems: "center", gap: "10px" }, header);
          this._powerDotEl = this._el(
            "div",
            {
              width: "10px",
              height: "10px",
              borderRadius: "50%",
              background: "oklch(0.5 0.02 145)",
              transition: "background .3s",
            },
            left,
          );
          this._el(
            "div",
            {
              font: "600 15px/1 Oswald,sans-serif",
              letterSpacing: ".16em",
              color: "oklch(0.92 0.02 85)",
              textTransform: "uppercase",
            },
            left,
          ).textContent = "Model 100";
          this._el(
            "div",
            {
              font: "500 10px/1 'JetBrains Mono',monospace",
              letterSpacing: ".08em",
              color: "oklch(0.7 0.03 80)",
              border: "1px solid oklch(0.55 0.03 80 / .5)",
              borderRadius: "4px",
              padding: "3px 6px",
            },
            left,
          ).textContent = "A/V Console";

          var right = this._el("div", { display: "flex", alignItems: "center", gap: "10px" }, header);
          var modeBtnBase = {
            padding: "8px 16px",
            borderRadius: "6px",
            font: "600 11px/1 'JetBrains Mono',monospace",
            letterSpacing: ".08em",
            cursor: "pointer",
            border: "1px solid oklch(0.55 0.03 80 / .4)",
          };
          this._modeAudioBtnEl = this._el("div", modeBtnBase, right);
          this._modeAudioBtnEl.textContent = "VINYL";
          this._modeVideoBtnEl = this._el("div", modeBtnBase, right);
          this._modeVideoBtnEl.textContent = "VIDEO";
          [this._modeAudioBtnEl, this._modeVideoBtnEl].forEach((btn, i) => {
            this._stopNativeDrag(btn);
            btn.addEventListener("click", function () {
              self._playSfx("click");
              self.setState({ mode: i === 0 ? "audio" : "video" });
            });
          });
        },
      },

      "audio panel chrome",
      {
        _buildAudioPanel: function (cabinet) {
          var self = this;
          var panel = this._el(
            "div",
            {
              background: "oklch(0.22 0.012 250)",
              borderRadius: "12px",
              padding: "26px",
              position: "relative",
              boxShadow: "inset 0 2px 10px rgba(0,0,0,.5)",
              overflow: "hidden",
              display: "flex",
              gap: "28px",
              alignItems: "flex-start",
              justifyContent: "center",
            },
            cabinet,
          );
          this._audioPanelEl = panel;

          // ---- platter + tonearm ----
          var platterWrap = this._el(
            "div",
            {
              position: "relative",
              width: "300px",
              height: "300px",
              flex: "none",
              // Flex items paint as if position:relative regardless of
              // their actual position value (a CSS Flexbox rule), which
              // put this wrapper's z-index:auto on the same painting level
              // as the tonearm's explicit z-index:2 below — but only a
              // *scoped* stacking context (isolation:isolate, not just
              // position:relative) keeps that z-index:2 (and the pivot
              // cap's z-index:3) contained to the platter itself. Without
              // this, they escape to the shared morph-root stacking
              // context and paint over unrelated sibling content whenever
              // the rotated tonearm's bounding box happens to overlap it
              // — confirmed live: the tonearm was painting over (clipping)
              // the "S" in the SHUF button below.
              isolation: "isolate",
            },
            panel,
          );
          this._el(
            "div",
            {
              position: "absolute",
              inset: "0",
              borderRadius: "50%",
              background: "radial-gradient(circle at 35% 30%,oklch(0.5 0.01 250),oklch(0.28 0.01 250) 70%)",
              boxShadow: "0 10px 26px rgba(0,0,0,.55),inset 0 0 0 6px oklch(0.18 0.01 250)",
            },
            platterWrap,
          );
          this._el(
            "div",
            {
              position: "absolute",
              inset: "14px",
              borderRadius: "50%",
              background:
                "repeating-radial-gradient(circle,oklch(0.3 0.01 250) 0px,oklch(0.3 0.01 250) 2px,oklch(0.34 0.01 250) 3px,oklch(0.34 0.01 250) 5px)",
            },
            platterWrap,
          );

          var spin = this._el(
            "div",
            {
              position: "absolute",
              inset: "30px",
              borderRadius: "50%",
              animation: "rmc-spin-platter 2.6s linear infinite",
              animationPlayState: "paused",
              overflow: "hidden",
              boxShadow: "0 0 0 3px oklch(0.85 0.02 80 / .8)",
            },
            platterWrap,
          );
          this._platterSpinEl = spin;
          this._labelGradientEl = this._el("div", { position: "absolute", inset: "0" }, spin);
          this._el(
            "div",
            {
              position: "absolute",
              left: "50%",
              top: "50%",
              width: "14px",
              height: "14px",
              borderRadius: "50%",
              background: "oklch(0.15 0 0)",
              transform: "translate(-50%,-50%)",
              boxShadow: "0 0 0 2px oklch(0.85 0.02 80 / .6)",
              pointerEvents: "none",
            },
            spin,
          );

          this._progressRingEl = this._el(
            "div",
            {
              position: "absolute",
              inset: "30px",
              borderRadius: "50%",
              pointerEvents: "none",
              WebkitMaskImage: "radial-gradient(circle, transparent 60%, black 61% 63%, transparent 64%)",
              maskImage: "radial-gradient(circle, transparent 60%, black 61% 63%, transparent 64%)",
            },
            platterWrap,
          );

          this._tonearmPivotEl = this._el(
            "div",
            {
              position: "absolute",
              right: "-6px",
              top: "-6px",
              width: "34px",
              height: "34px",
              borderRadius: "50%",
              background:
                "linear-gradient(135deg,oklch(0.88 0.005 250),oklch(0.62 0.006 250) 45%,oklch(0.82 0.005 250))",
              boxShadow: "0 2px 6px rgba(0,0,0,.5)",
              zIndex: "3",
            },
            platterWrap,
          );
          var tonearm = this._el(
            "div",
            {
              position: "absolute",
              right: "2px",
              top: "4px",
              transformOrigin: "top right",
              cursor: "grab",
              zIndex: "2",
              transition: "transform .4s ease",
            },
            platterWrap,
          );
          this._tonearmEl = tonearm;
          this._el(
            "div",
            {
              width: "6px",
              height: "150px",
              margin: "0 auto",
              borderRadius: "3px",
              background:
                "repeating-linear-gradient(90deg,oklch(0.68 0.006 250) 0px,oklch(0.85 0.005 250) 1px,oklch(0.55 0.006 250) 2px)",
            },
            tonearm,
          );
          this._el(
            "div",
            {
              width: "16px",
              height: "24px",
              borderRadius: "4px",
              background: "oklch(0.2 0.01 250)",
              margin: "-4px auto 0",
              boxShadow: "0 2px 5px rgba(0,0,0,.5)",
            },
            tonearm,
          );
          this._stopNativeDrag(tonearm);
          tonearm.addEventListener("pointerdown", function (e) {
            self._startTonearmDrag(e);
          });

          // ---- control panel ----
          var control = this._el(
            "div",
            { flex: "1", minWidth: "280px", display: "flex", flexDirection: "column", gap: "16px", position: "relative" },
            panel,
          );

          var trackBox = this._el(
            "div",
            { background: "oklch(0.1 0 0)", borderRadius: "8px", padding: "12px 16px", boxShadow: "inset 0 0 8px rgba(0,0,0,.7)" },
            control,
          );
          this._trackTitleEl = this._el(
            "div",
            {
              font: "600 15px/1.3 'JetBrains Mono',monospace",
              color: "oklch(0.75 0.16 55)",
              textShadow: "0 0 6px oklch(0.75 0.16 55 / .6)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            },
            trackBox,
          );
          this._trackArtistEl = this._el(
            "div",
            { font: "500 12px/1.4 'JetBrains Mono',monospace", color: "oklch(0.55 0.1 55)", marginTop: "3px" },
            trackBox,
          );

          var seekTrack = this._el(
            "div",
            { marginTop: "12px", height: "14px", display: "flex", alignItems: "center", cursor: "pointer", position: "relative" },
            trackBox,
          );
          this._seekTrackEl = seekTrack;
          this._el(
            "div",
            { position: "absolute", left: "0", right: "0", height: "4px", borderRadius: "2px", background: "oklch(0.3 0.02 55)" },
            seekTrack,
          );
          this._seekFillEl = this._el(
            "div",
            {
              position: "absolute",
              left: "0",
              height: "4px",
              borderRadius: "2px",
              background: "linear-gradient(90deg,oklch(0.6 0.14 55),oklch(0.78 0.16 55))",
              boxShadow: "0 0 6px oklch(0.75 0.16 55 / .6)",
            },
            seekTrack,
          );
          this._seekKnobEl = this._el(
            "div",
            {
              position: "absolute",
              width: "12px",
              height: "12px",
              borderRadius: "50%",
              background: "oklch(0.92 0.05 55)",
              boxShadow: "0 0 0 2px oklch(0.6 0.14 55),0 0 6px oklch(0.75 0.16 55 / .8)",
            },
            seekTrack,
          );
          this._stopNativeDrag(seekTrack);
          seekTrack.addEventListener("pointerdown", function (e) {
            self._startSeekDrag(e);
          });

          var timeRow = this._el(
            "div",
            { display: "flex", justifyContent: "space-between", marginTop: "4px", font: "500 10px/1 'JetBrains Mono',monospace", color: "oklch(0.5 0.08 55)" },
            trackBox,
          );
          this._elapsedEl = this._el("span", null, timeRow);
          this._durationEl = this._el("span", null, timeRow);

          var transportRow = this._el(
            "div",
            { display: "flex", alignItems: "center", gap: "12px", justifyContent: "center" },
            control,
          );
          this._shuffleBtnEl = this._buildPillButton(transportRow, "SHUF");
          this._shuffleLedEl = this._el(
            "span",
            { width: "6px", height: "6px", borderRadius: "50%", marginLeft: "2px" },
            this._shuffleBtnEl,
          );
          this._prevBtnEl = this._buildRoundButton(transportRow, 44);
          this._el("span", this._triangleStyle("l", 11), this._prevBtnEl);
          this._playBtnEl = this._buildRoundButton(transportRow, 56);
          this._playGlyphWrapEl = this._el("span", { display: "block" }, this._playBtnEl);
          this._nextBtnEl = this._buildRoundButton(transportRow, 44);
          this._el("span", this._triangleStyle("r", 11), this._nextBtnEl);
          this._repeatBtnEl = this._buildPillButton(transportRow, "RPT");
          this._repeatLedEl = this._el(
            "span",
            { width: "6px", height: "6px", borderRadius: "50%", marginLeft: "2px" },
            this._repeatBtnEl,
          );

          this._shuffleBtnEl.addEventListener("click", function () {
            self._playSfx("click");
            self.setState({ shuffle: !self.state.shuffle });
          });
          this._repeatBtnEl.addEventListener("click", function () {
            self._playSfx("click");
            self.setState({ repeat: !self.state.repeat });
          });
          this._prevBtnEl.addEventListener("click", function () {
            self._playSfx("click");
            self._advanceTrack(-1, self.state.playing);
          });
          this._nextBtnEl.addEventListener("click", function () {
            self._playSfx("click");
            self._advanceTrack(1, self.state.playing);
          });
          this._playBtnEl.addEventListener("click", function () {
            self._playSfx("click");
            self.togglePlay();
          });

          var volRow = this._el(
            "div",
            { display: "flex", alignItems: "center", gap: "14px", justifyContent: "center", paddingTop: "6px" },
            control,
          );
          this._el(
            "span",
            { font: "600 10px/1 'JetBrains Mono',monospace", color: "oklch(0.6 0.03 80)", letterSpacing: ".08em" },
            volRow,
          ).textContent = "VOL";
          this._volumeKnobEl = this._el(
            "div",
            {
              width: "52px",
              height: "52px",
              borderRadius: "50%",
              background: "radial-gradient(circle at 35% 30%,oklch(0.55 0.01 250),oklch(0.3 0.01 250))",
              boxShadow: "0 3px 8px rgba(0,0,0,.5)",
              position: "relative",
              cursor: "grab",
            },
            volRow,
          );
          this._volumePointerEl = this._el(
            "div",
            { position: "absolute", left: "50%", top: "50%", width: "3px", height: "20px", background: "oklch(0.85 0.02 80)", borderRadius: "2px" },
            this._volumeKnobEl,
          );
          this._volumeLabelEl = this._el(
            "span",
            { font: "600 11px/1 'JetBrains Mono',monospace", color: "oklch(0.7 0.03 80)", minWidth: "28px" },
            volRow,
          );
          this._stopNativeDrag(this._volumeKnobEl);
          this._volumeKnobEl.addEventListener("pointerdown", function (e) {
            self._startKnobDrag(e, "volume");
          });

          this._openTabEl = this._el(
            "div",
            {
              position: "absolute",
              // Sits in the 28px flex `gap` between control and the
              // (0-width-when-closed) drawer. -14px (half the gap, as in
              // the original design comp) looked centered on paper but the
              // tab renders ~23px wide, so 9px of it spilled back over the
              // transport row's rightmost button — verified live via
              // getBoundingClientRect. -25px anchors the tab's left edge
              // flush with control's right edge instead, keeping it
              // entirely inside the gap regardless of exact control width.
              right: "-25px",
              top: "50%",
              writingMode: "vertical-rl",
              background: "oklch(0.78 0.1 85)",
              color: "oklch(0.2 0.02 50)",
              font: "600 11px/1 'JetBrains Mono',monospace",
              letterSpacing: ".1em",
              padding: "14px 6px",
              borderRadius: "6px",
              cursor: "pointer",
              boxShadow: "0 2px 8px rgba(0,0,0,.35)",
              whiteSpace: "nowrap",
            },
            control,
          );
          this._openTabEl.textContent = "QUEUE";
          this._stopNativeDrag(this._openTabEl);
          this._openTabEl.addEventListener("click", function () {
            self._playSfx("slide");
            self.setState({ drawerOpen: true });
          });

          // ---- queue drawer ----
          var drawer = this._el(
            "div",
            {
              flex: "none",
              alignSelf: "flex-start",
              position: "relative",
              maxHeight: "300px",
              display: "flex",
              flexDirection: "column",
              background: "oklch(0.16 0.01 250 / .97)",
              borderRadius: "10px",
              overflow: "hidden",
              transition: "width .3s ease,padding .3s ease",
            },
            panel,
          );
          this._drawerEl = drawer;
          var drawerHeader = this._el("div", { display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }, drawer);
          this._drawerTabEl = this._el(
            "button",
            {
              flex: "none",
              border: "none",
              background: "oklch(0.3 0.01 250)",
              color: "oklch(0.85 0.02 80)",
              font: "600 11px/1 'JetBrains Mono',monospace",
              letterSpacing: ".05em",
              padding: "6px 8px",
              borderRadius: "5px",
              cursor: "pointer",
              boxShadow: "0 1px 3px rgba(0,0,0,.35)",
            },
            drawerHeader,
          );
          this._drawerTabEl.textContent = "✕";
          this._drawerTabEl.addEventListener("click", function () {
            self._playSfx("slide");
            self.setState({ drawerOpen: false });
          });
          this._el(
            "div",
            { font: "600 11px/1 'JetBrains Mono',monospace", color: "oklch(0.6 0.03 80)", letterSpacing: ".1em", whiteSpace: "nowrap" },
            drawerHeader,
          ).textContent = "TRACK QUEUE";

          this._queueListEl = this._el(
            "div",
            { overflowY: "auto", display: "flex", flexDirection: "column", gap: "2px", paddingRight: "4px" },
            drawer,
            "om-queue-scroll",
          );
          this._queueRowEls = this.tracks.map((t, i) => {
            var row = this._el(
              "div",
              { display: "flex", alignItems: "center", gap: "10px", padding: "8px 6px", borderRadius: "6px", cursor: "pointer" },
              this._queueListEl,
            );
            this._el(
              "span",
              { font: "600 12px 'JetBrains Mono',monospace", opacity: ".5", width: "16px" },
              row,
            ).textContent = String(i + 1);
            var mid = this._el("div", { flex: "1", minWidth: "0" }, row);
            var titleEl = this._el(
              "div",
              { font: "600 13px/1.3 system-ui,sans-serif", color: "oklch(0.92 0.01 80)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
              mid,
            );
            titleEl.textContent = t.title;
            var artistEl = this._el(
              "div",
              { font: "500 11px/1.3 system-ui,sans-serif", color: "oklch(0.6 0.02 80)" },
              mid,
            );
            artistEl.textContent = t.artist;
            var durEl = this._el(
              "span",
              { font: "500 11px 'JetBrains Mono',monospace", color: "oklch(0.55 0.02 80)" },
              row,
            );
            row.addEventListener("click", function () {
              self._playSfx("click");
              self.setState({ trackIndex: i, playing: true, scrubProgress: 0, dragging: false });
              self._audioEl.currentTime = 0;
              self._audioEl.play().catch(function () {});
            });
            return { row: row, durEl: durEl };
          });
        },

        _buildPillButton: function (parent, label) {
          var btn = this._el(
            "button",
            {
              padding: "8px 10px",
              borderRadius: "6px",
              border: "1px solid oklch(1 0 0 / .12)",
              font: "700 10px/1 'JetBrains Mono',monospace",
              letterSpacing: ".05em",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: "6px",
            },
            parent,
          );
          btn.appendChild(document.createTextNode(label));
          this._stopNativeDrag(btn);
          return btn;
        },
        _buildRoundButton: function (parent, size) {
          var btn = this._el(
            "button",
            {
              width: size + "px",
              height: size + "px",
              borderRadius: "50%",
              border: "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              boxShadow: "0 3px 6px rgba(0,0,0,.4)",
            },
            parent,
          );
          this._stopNativeDrag(btn);
          return btn;
        },
      },

      "video panel chrome",
      {
        _buildVideoPanel: function (cabinet) {
          var self = this;
          var panel = this._el(
            "div",
            { display: "flex", flexDirection: "column", gap: "18px", alignItems: "center" },
            cabinet,
          );
          this._videoPanelEl = panel;

          // ---- TV ----
          var tv = this._el(
            "div",
            {
              width: "100%",
              maxWidth: "640px",
              background:
                "repeating-linear-gradient(95deg,rgba(255,255,255,.035) 0px,rgba(255,255,255,.035) 1px,transparent 2px,transparent 7px)," +
                "linear-gradient(160deg,oklch(0.42 0.055 48),oklch(0.3 0.05 48))",
              borderRadius: "16px",
              padding: "20px",
              boxShadow: "0 14px 30px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.06)",
              position: "relative",
              boxSizing: "border-box",
            },
            panel,
          );
          var bezel = this._el(
            "div",
            { background: "oklch(0.1 0 0)", borderRadius: "8px", padding: "10px", boxShadow: "inset 0 0 0 4px oklch(0.2 0.01 60)" },
            tv,
          );
          var screen = this._el(
            "div",
            { position: "relative", aspectRatio: "4/3", borderRadius: "4px", overflow: "hidden", background: "oklch(0.08 0 0)" },
            bezel,
          );
          this._tvScreenEl = screen;
          screen.appendChild(this._videoEl);
          this._el(
            "div",
            {
              position: "absolute",
              inset: "0",
              pointerEvents: "none",
              background: "repeating-linear-gradient(rgba(0,0,0,0) 0px,rgba(0,0,0,0) 2px,rgba(0,0,0,.18) 3px)",
              mixBlendMode: "multiply",
            },
            screen,
          );
          this._el(
            "div",
            { position: "absolute", inset: "0", pointerEvents: "none", boxShadow: "inset 0 0 60px rgba(0,0,0,.65)" },
            screen,
          );
          this._tvGlitchEl = this._el(
            "div",
            {
              position: "absolute",
              inset: "0",
              background: "repeating-linear-gradient(0deg,oklch(0.9 0 0 / .12) 0px,transparent 2px,transparent 4px)",
              animation: "rmc-glitch-bar .15s linear infinite",
              pointerEvents: "none",
              display: "none",
            },
            screen,
          );
          this._channelLabelEl = this._el(
            "div",
            {
              position: "absolute",
              left: "10px",
              top: "8px",
              font: "600 11px 'JetBrains Mono',monospace",
              color: "oklch(0.85 0.16 25)",
              textShadow: "0 0 6px oklch(0.6 0.19 25)",
              letterSpacing: ".06em",
            },
            screen,
          );

          var tvControlRow = this._el(
            "div",
            { display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", marginTop: "14px" },
            tv,
          );
          this._el(
            "span",
            { font: "600 10px/1 'JetBrains Mono',monospace", color: "oklch(0.7 0.03 80)", letterSpacing: ".08em", marginRight: "6px" },
            tvControlRow,
          ).textContent = "CH";
          this._channelBtnEls = this.channels.map((c, i) => {
            var btn = this._el(
              "button",
              { width: "26px", height: "26px", borderRadius: "5px", border: "none", cursor: "pointer", font: "700 11px/1 'JetBrains Mono',monospace" },
              tvControlRow,
            );
            btn.textContent = c.label;
            this._stopNativeDrag(btn);
            btn.addEventListener("click", function () {
              self._setChannel(i);
            });
            return btn;
          });
          this._el(
            "div",
            { width: "1px", height: "20px", background: "oklch(1 0 0 / .12)", margin: "0 10px" },
            tvControlRow,
          );
          this._el(
            "span",
            { font: "600 10px/1 'JetBrains Mono',monospace", color: "oklch(0.7 0.03 80)", letterSpacing: ".08em", marginRight: "4px" },
            tvControlRow,
          ).textContent = "VOL";
          this._tvVolumeKnobEl = this._el(
            "div",
            {
              width: "34px",
              height: "34px",
              borderRadius: "50%",
              background: "radial-gradient(circle at 35% 30%,oklch(0.55 0.01 250),oklch(0.3 0.01 250))",
              position: "relative",
              cursor: "grab",
              boxShadow: "0 2px 5px rgba(0,0,0,.5)",
            },
            tvControlRow,
          );
          this._tvVolumePointerEl = this._el(
            "div",
            { position: "absolute", left: "50%", top: "50%", width: "2px", height: "13px", background: "oklch(0.85 0.02 80)", borderRadius: "2px" },
            this._tvVolumeKnobEl,
          );
          this._stopNativeDrag(this._tvVolumeKnobEl);
          this._tvVolumeKnobEl.addEventListener("pointerdown", function (e) {
            self._startKnobDrag(e, "tvVolume");
          });

          // ---- VCR deck ----
          var deck = this._el(
            "div",
            {
              width: "100%",
              maxWidth: "640px",
              background:
                "repeating-linear-gradient(90deg,rgba(255,255,255,.05) 0px,rgba(255,255,255,.05) 1px,transparent 1px,transparent 3px)," +
                "linear-gradient(180deg,oklch(0.56 0.008 250),oklch(0.4 0.008 250))",
              borderRadius: "10px",
              padding: "16px 18px",
              boxShadow: "0 10px 22px rgba(0,0,0,.35)",
              position: "relative",
              boxSizing: "border-box",
            },
            panel,
          );
          var deckHeader = this._el(
            "div",
            { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px", marginBottom: "12px" },
            deck,
          );
          this._el(
            "div",
            { font: "600 11px/1 Oswald,sans-serif", letterSpacing: ".14em", color: "oklch(0.2 0.01 250)", textTransform: "uppercase" },
            deckHeader,
          ).textContent = "HI-FI VideoDeck";
          var counterBox = this._el(
            "div",
            { background: "oklch(0.08 0 0)", borderRadius: "5px", padding: "5px 10px", boxShadow: "inset 0 0 6px rgba(0,0,0,.7)" },
            deckHeader,
          );
          this._vcrCounterEl = this._el(
            "span",
            { font: "700 15px/1 'JetBrains Mono',monospace", color: "oklch(0.78 0.19 150)", textShadow: "0 0 6px oklch(0.78 0.19 150 / .6)" },
            counterBox,
          );

          var deckRow = this._el("div", { display: "flex", alignItems: "center", gap: "14px" }, deck);
          this._tapeSlotEl = this._el(
            "div",
            { width: "70px", height: "30px", borderRadius: "3px", background: "oklch(0.12 0 0)", boxShadow: "inset 0 2px 6px rgba(0,0,0,.8)", overflow: "hidden", position: "relative", flex: "none" },
            deckRow,
          );
          this._tapeEl = this._el(
            "div",
            {
              position: "absolute",
              left: "4px",
              right: "4px",
              height: "22px",
              top: "4px",
              background: "linear-gradient(180deg,oklch(0.4 0.02 50),oklch(0.28 0.02 50))",
              borderRadius: "2px",
              transition: "transform .5s ease",
            },
            this._tapeSlotEl,
          );

          var transportRow = this._el("div", { display: "flex", gap: "8px", flex: "1", justifyContent: "center" }, deckRow);
          this._rewBtnEl = this._buildVcrButton(transportRow);
          var rewWrap = this._el("span", { display: "flex", gap: "1px" }, this._rewBtnEl);
          this._el("span", this._triangleStyle("l", 9), rewWrap);
          this._el("span", this._triangleStyle("l", 9), rewWrap);

          this._vcrPlayBtnEl = this._buildVcrButton(transportRow);
          this._vcrPlayGlyphEl = this._el("span", { display: "block" }, this._vcrPlayBtnEl);

          this._ffBtnEl = this._buildVcrButton(transportRow);
          var ffWrap = this._el("span", { display: "flex", gap: "1px" }, this._ffBtnEl);
          this._el("span", this._triangleStyle("r", 9), ffWrap);
          this._el("span", this._triangleStyle("r", 9), ffWrap);

          this._stopBtnEl = this._buildVcrButton(transportRow);
          this._el("span", { width: "11px", height: "11px", background: "oklch(0.9 0.01 80)" }, this._stopBtnEl);

          this._ejectBtnEl = this._buildVcrButton(transportRow);
          this._ejectGlyphEl = this._el("span", this._ejectUpTriangleStyle(), this._ejectBtnEl);

          this._rewBtnEl.addEventListener("click", function () {
            self._playSfx("thunk");
            self._videoEl.currentTime = Math.max(0, self._videoEl.currentTime - 10);
          });
          this._ffBtnEl.addEventListener("click", function () {
            self._playSfx("thunk");
            var dur = self._videoEl.duration || Infinity;
            self._videoEl.currentTime = Math.min(dur, self._videoEl.currentTime + 10);
          });
          this._vcrPlayBtnEl.addEventListener("click", function () {
            self._playSfx("thunk");
            self.toggleVideoPlay();
          });
          this._stopBtnEl.addEventListener("click", function () {
            self._playSfx("thunk");
            self._videoEl.pause();
            self._videoEl.currentTime = 0;
            self.setState({ videoPlaying: false });
          });
          this._ejectBtnEl.addEventListener("click", function () {
            self._playSfx("tape");
            self._videoEl.pause();
            self.setState({ tapeInserted: !self.state.tapeInserted, videoPlaying: false });
          });
        },

        _buildVcrButton: function (parent) {
          var btn = this._el(
            "button",
            {
              width: "42px",
              height: "34px",
              borderRadius: "5px",
              border: "none",
              cursor: "pointer",
              background: "linear-gradient(180deg,oklch(0.62 0.008 250),oklch(0.42 0.008 250))",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 2px 4px rgba(0,0,0,.4)",
            },
            parent,
          );
          this._stopNativeDrag(btn);
          return btn;
        },
        _ejectUpTriangleStyle: function () {
          return {
            width: "0",
            height: "0",
            borderLeft: "8px solid transparent",
            borderRight: "8px solid transparent",
            borderBottom: "8px solid oklch(0.9 0.01 80)",
          };
        },
      },

      "drag interactions",
      {
        _startTonearmDrag: function (e) {
          var self = this;
          e.stopPropagation();
          e.preventDefault();
          this.setState({ dragging: true });
          var move = function (ev) {
            var r = self._tonearmPivotEl.getBoundingClientRect();
            var cx = r.left + r.width / 2,
              cy = r.top + r.height / 2;
            var angle = (Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI - 90;
            var clamped = Math.max(-18, Math.min(35, angle));
            var progress = ((clamped - -18) / (35 - -18)) * 100;
            self.state.scrubProgress = progress;
            self._renderAudioProgress();
          };
          var up = function () {
            self.state.dragging = false;
            if (self._audioEl.duration) self._audioEl.currentTime = (self.state.scrubProgress / 100) * self._audioEl.duration;
            self._renderAudioProgress();
          };
          this._trackDrag(move, up);
        },

        _startSeekDrag: function (e) {
          var self = this;
          e.stopPropagation();
          e.preventDefault();
          var setFromX = function (clientX) {
            var r = self._seekTrackEl.getBoundingClientRect();
            var pct = Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100));
            self.state.scrubProgress = pct;
            self._renderAudioProgress();
          };
          setFromX(e.clientX);
          this.setState({ dragging: true });
          var move = function (ev) {
            setFromX(ev.clientX);
          };
          var up = function () {
            self.state.dragging = false;
            if (self._audioEl.duration) self._audioEl.currentTime = (self.state.scrubProgress / 100) * self._audioEl.duration;
            self._renderAudioProgress();
          };
          this._trackDrag(move, up);
        },

        _startKnobDrag: function (e, key) {
          var self = this;
          e.stopPropagation();
          e.preventDefault();
          var startY = e.clientY;
          var startVal = this.state[key];
          var lastTickBucket = Math.floor(startVal / 5);
          var move = function (ev) {
            var delta = startY - ev.clientY;
            var next = Math.max(0, Math.min(100, Math.round(startVal + delta * 0.7)));
            if (next === self.state[key]) return;
            self.state[key] = next;
            var bucket = Math.floor(next / 5);
            if (bucket !== lastTickBucket) {
              lastTickBucket = bucket;
              self._playSfx("tick");
            }
            if (key === "volume") {
              self._audioEl.volume = next / 100;
              self._renderVolumeUI();
            } else {
              self._videoEl.volume = next / 100;
              self._renderTvVolumeUI();
            }
          };
          var up = function () {};
          this._trackDrag(move, up);
        },
      },

      "state transitions",
      {
        setState: function (patch) {
          Object.assign(this.state, patch);
          this._renderAll();
        },

        togglePlay: function () {
          var s = this.state;
          if (!s.playing) {
            this._audioEl.play().catch(function () {});
            this._playSfx("thunk");
          } else {
            this._audioEl.pause();
          }
          this.setState({ playing: !s.playing });
        },

        _advanceTrack: function (dir, keepPlaying) {
          var s = this.state;
          var n = this.tracks.length;
          var next;
          if (s.shuffle) {
            next = Math.floor(Math.random() * n);
            if (next === s.trackIndex && n > 1) next = (next + 1) % n;
          } else {
            next = (s.trackIndex + dir + n) % n;
          }
          this._audioEl.pause();
          this._audioEl.src = this.tracks[next].src;
          this.setState({ trackIndex: next, scrubProgress: 0, playing: keepPlaying });
          if (keepPlaying) this._audioEl.play().catch(function () {});
        },

        toggleVideoPlay: function () {
          var s = this.state;
          if (!s.tapeInserted) return;
          if (!s.videoPlaying) this._videoEl.play().catch(function () {});
          else this._videoEl.pause();
          this.setState({ videoPlaying: !s.videoPlaying });
        },

        _setChannel: function (i) {
          var self = this;
          this._playSfx("static");
          var wasPlaying = this.state.videoPlaying;
          this._videoEl.pause();
          this._videoEl.src = this.channels[i].src;
          this.setState({ channel: i, videoGlitch: true });
          if (wasPlaying && this.state.tapeInserted) this._videoEl.play().catch(function () {});
          clearTimeout(this._glitchTimeout);
          this._glitchTimeout = setTimeout(function () {
            self.setState({ videoGlitch: false });
          }, 260);
        },
      },

      "rendering",
      {
        _renderAll: function () {
          this._renderMode();
          this._renderPower();
          this._renderTransport();
          this._renderQueue();
          this._renderAudioProgress();
          this._renderVolumeUI();
          this._renderDrawer();
          this._renderChannels();
          this._renderTvVolumeUI();
          this._renderVideoChrome();
          this._renderVcrCounter();
          this._applyExtentForMode();
        },

        _renderMode: function () {
          var isAudio = this.state.mode === "audio";
          var active = { background: "oklch(0.78 0.1 85)", color: "oklch(0.2 0.02 50)" };
          var inactive = { background: "transparent", color: "oklch(0.75 0.03 80)" };
          this._applyStyle(this._modeAudioBtnEl, isAudio ? active : inactive);
          this._applyStyle(this._modeVideoBtnEl, !isAudio ? active : inactive);
          this._audioPanelEl.style.display = isAudio ? "flex" : "none";
          this._videoPanelEl.style.display = isAudio ? "none" : "flex";
        },

        _renderPower: function () {
          var s = this.state;
          var on = s.mode === "audio" ? s.playing : s.videoPlaying;
          this._powerDotEl.style.background = on ? "oklch(0.75 0.19 145)" : "oklch(0.5 0.02 145)";
          this._powerDotEl.style.boxShadow = on ? "0 0 8px oklch(0.75 0.19 145)" : "none";
          this._powerDotEl.style.animation = on ? "rmc-led-blink 1.6s ease-in-out infinite" : "none";
        },

        _renderTransport: function () {
          var s = this.state;
          var track = this.tracks[s.trackIndex];
          this._trackTitleEl.textContent = track.title;
          this._trackArtistEl.textContent = track.artist + " · TRK " + (s.trackIndex + 1) + "/" + this.tracks.length;
          this._labelGradientEl.style.background = this._presetGradient(track.presetHue);
          this._platterSpinEl.style.animationPlayState = s.playing ? "running" : "paused";

          this._shuffleBtnEl.style.background = s.shuffle ? "oklch(0.35 0.05 150)" : "oklch(0.3 0.01 250)";
          this._shuffleBtnEl.style.color = s.shuffle ? "oklch(0.92 0.05 150)" : "oklch(0.65 0.02 80)";
          this._shuffleLedEl.style.background = s.shuffle ? "oklch(0.78 0.19 150)" : "oklch(0.4 0.01 250)";
          this._shuffleLedEl.style.boxShadow = s.shuffle ? "0 0 5px oklch(0.78 0.19 150)" : "none";

          this._repeatBtnEl.style.background = s.repeat ? "oklch(0.35 0.05 150)" : "oklch(0.3 0.01 250)";
          this._repeatBtnEl.style.color = s.repeat ? "oklch(0.92 0.05 150)" : "oklch(0.65 0.02 80)";
          this._repeatLedEl.style.background = s.repeat ? "oklch(0.78 0.19 150)" : "oklch(0.4 0.01 250)";
          this._repeatLedEl.style.boxShadow = s.repeat ? "0 0 5px oklch(0.78 0.19 150)" : "none";

          this._playBtnEl.style.background = s.playing
            ? "radial-gradient(circle at 35% 30%,oklch(0.7 0.1 55),oklch(0.5 0.1 55))"
            : "radial-gradient(circle at 35% 30%,oklch(0.78 0.1 85),oklch(0.58 0.1 85))";
          this._playGlyphWrapEl.innerHTML = "";
          if (s.playing) {
            this._applyStyle(this._playGlyphWrapEl, { display: "flex", gap: "4px" });
            this._el("span", { width: "5px", height: "16px", background: "oklch(0.15 0.02 50)" }, this._playGlyphWrapEl);
            this._el("span", { width: "5px", height: "16px", background: "oklch(0.15 0.02 50)" }, this._playGlyphWrapEl);
          } else {
            this._applyStyle(this._playGlyphWrapEl, { display: "block" });
            this._applyStyle(this._playGlyphWrapEl, {
              width: "0",
              height: "0",
              borderTop: "9px solid transparent",
              borderBottom: "9px solid transparent",
              borderLeft: "14px solid oklch(0.15 0.02 50)",
            });
          }
        },

        _renderQueue: function () {
          var self = this;
          this._queueRowEls.forEach(function (entry, i) {
            entry.row.style.background = i === self.state.trackIndex ? "oklch(1 0 0 / .08)" : "transparent";
          });
        },

        _renderAudioProgress: function () {
          var s = this.state;
          var pct = s.scrubProgress;
          this._seekFillEl.style.width = pct + "%";
          this._seekKnobEl.style.left = "calc(" + pct + "% - 6px)";
          this._progressRingEl.style.background = "conic-gradient(oklch(0.78 0.16 55) " + pct + "%, transparent " + pct + "%)";

          var angle = s.dragging ? -18 + (pct / 100) * (35 - -18) : s.playing ? 10 + (pct / 100) * 25 : -18;
          this._tonearmEl.style.transform = "rotate(" + angle + "deg)";
          this._tonearmEl.style.transition = s.dragging ? "none" : "transform .4s ease";

          var dur = this._audioEl.duration || 0;
          this._elapsedEl.textContent = this._fmtMinSec((pct / 100) * dur);
          this._durationEl.textContent = dur ? this._fmtMinSec(dur) : "--:--";
        },

        _renderVolumeUI: function () {
          var s = this.state;
          var angle = -135 + (s.volume / 100) * 270;
          this._volumePointerEl.style.transform = "translate(-50%,-90%) rotate(" + angle + "deg)";
          this._volumePointerEl.style.transformOrigin = "50% 100%";
          this._volumeLabelEl.textContent = s.volume;
        },

        _renderDrawer: function () {
          var s = this.state;
          var open = s.drawerOpen;
          this._applyStyle(this._drawerEl, {
            width: open ? "220px" : "0px",
            padding: open ? "16px" : "0px",
            boxShadow: open ? "inset 0 0 0 1px rgba(255,255,255,.06)" : "none",
          });
          this._openTabEl.style.display = open ? "none" : "block";
        },

        _renderChannels: function () {
          var self = this;
          this._channelBtnEls.forEach(function (btn, i) {
            var active = i === self.state.channel;
            btn.style.background = active ? "oklch(0.78 0.19 150)" : "oklch(0.5 0.008 250)";
            btn.style.color = active ? "oklch(0.15 0.02 150)" : "oklch(0.85 0.02 80)";
          });
        },

        _renderTvVolumeUI: function () {
          var angle = -135 + (this.state.tvVolume / 100) * 270;
          this._tvVolumePointerEl.style.transform = "translate(-50%,-90%) rotate(" + angle + "deg)";
          this._tvVolumePointerEl.style.transformOrigin = "50% 100%";
        },

        _renderVideoChrome: function () {
          var s = this.state;
          this._tvGlitchEl.style.display = s.videoGlitch ? "block" : "none";
          this._channelLabelEl.textContent = "CH " + String(s.channel + 1).padStart(2, "0");
          this._tapeEl.style.transform = s.tapeInserted ? "translateY(0)" : "translateY(-140%)";

          this._vcrPlayGlyphEl.innerHTML = "";
          if (s.videoPlaying) {
            this._applyStyle(this._vcrPlayGlyphEl, { display: "flex", gap: "3px" });
            this._el("span", { width: "4px", height: "13px", background: "oklch(0.9 0.01 80)" }, this._vcrPlayGlyphEl);
            this._el("span", { width: "4px", height: "13px", background: "oklch(0.9 0.01 80)" }, this._vcrPlayGlyphEl);
          } else {
            this._applyStyle(this._vcrPlayGlyphEl, { display: "block" });
            this._applyStyle(this._vcrPlayGlyphEl, this._triangleStyle("r", 11));
          }

          [this._rewBtnEl, this._ffBtnEl, this._vcrPlayBtnEl, this._stopBtnEl].forEach(function (btn) {
            btn.style.opacity = s.tapeInserted ? "1" : ".4";
            btn.style.pointerEvents = s.tapeInserted ? "auto" : "none";
          });
        },

        _renderVcrCounter: function () {
          this._vcrCounterEl.textContent = this._fmtHMS(this._videoEl.currentTime);
        },

        _applyExtentForMode: function () {
          var s = this.state;
          if (s.mode === "audio") {
            var e = s.drawerOpen ? this.AUDIO_EXTENT_WITH_DRAWER : this.AUDIO_EXTENT;
            this.setExtent(lively.pt(e.w, e.h));
          } else {
            this.setExtent(lively.pt(this.VIDEO_EXTENT.w, this.VIDEO_EXTENT.h));
          }
        },
      },

    );

    RetroMediaConsoleClass.open = function (optPos) {
      var m = new lively.media.RetroMediaConsole(lively.rect(0, 0, 740, 500));
      m.openInWorld(optPos || lively.morphic.World.current().visibleBounds().center().subPt(lively.pt(370, 250)));
      return m;
    };

    // Keyframe animations are global CSS — inject once, guarded so
    // reopening/copying this morph doesn't pile up duplicate <style> tags.
    if (!document.getElementById("rmc-keyframes")) {
      var styleTag = document.createElement("style");
      styleTag.id = "rmc-keyframes";
      styleTag.textContent =
        "@keyframes rmc-spin-platter{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}" +
        "@keyframes rmc-glitch-bar{0%{transform:translateY(-100%)}100%{transform:translateY(100%)}}" +
        "@keyframes rmc-led-blink{0%,100%{opacity:1}50%{opacity:.25}}" +
        ".om-queue-scroll{scrollbar-width:thin;scrollbar-color:oklch(0.55 0.09 55) transparent}" +
        ".om-queue-scroll::-webkit-scrollbar{width:6px}" +
        ".om-queue-scroll::-webkit-scrollbar-thumb{background:oklch(0.55 0.09 55);border-radius:3px}";
      document.head.appendChild(styleTag);
    }
  }); // end module('lively.media.RetroMediaConsole')
