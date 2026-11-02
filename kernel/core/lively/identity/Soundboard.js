module("lively.identity.Soundboard")
  .requires()
  .toRun(function () {

    // Short sound clips that everyone in the current call hears, opened from the
    // Ambient Presence Panel's room block. Clips live in core/media/soundboard/
    // (sources and licenses in LICENSES.txt there).
    //
    // Audio path: the first time a clip is played, the microphone and the clip
    // are mixed in a Web Audio graph (MediaStreamAudioDestinationNode) and the
    // mixed track replaces the mic track on every peer connection (the room
    // session asks getOutgoingTrack() for which audio track to send). Until then
    // calls keep sending the raw mic track, so this whole path is opt-in per
    // session. The clip also plays to this device's own speakers. The mixed track
    // stays enabled while the mic is muted — muting only disables the mic's own
    // track — so the soundboard still works muted, and the panel greys it out
    // while deafened instead.
    //
    // Plain object with normal closures: nothing here is a BuildSpec or an
    // addScript'd handler.
    lively.identity.Soundboard = {
      BASE: "/core/media/soundboard/",
      SOUNDS: [
        { id: "quack",      label: "quack",      file: "quack.mp3" },
        { id: "airhorn",    label: "airhorn",    file: "airhorn.mp3" },
        { id: "cricket",    label: "cricket",    file: "cricket.mp3" },
        { id: "golf-clap",  label: "golf clap",  file: "golf-clap.mp3" },
        { id: "sad-horn",   label: "sad horn",   file: "sad-horn.mp3" },
        { id: "ba-dum-tss", label: "ba dum tss", file: "ba-dum-tss.mp3" },
      ],

      _ctx: null,
      _dest: null,          // MediaStreamAudioDestinationNode, once mixing has started
      _micSrc: null,
      _micTrackId: null,
      _buffers: {},         // id -> Promise<AudioBuffer>
      _popover: null,
      _closeHandlers: null,

      // ── audio engine ──

      _ensureContext: function () {
        if (!this._ctx) {
          var AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return null;
          this._ctx = new AC();
        }
        if (this._ctx.state === "suspended") this._ctx.resume().catch(function () {});
        return this._ctx;
      },

      _load: function (sound) {
        var self = this;
        var ctx = this._ensureContext();
        if (!ctx) return Promise.reject(new Error("no Web Audio"));
        if (!this._buffers[sound.id]) {
          this._buffers[sound.id] = fetch(this.BASE + sound.file)
            .then(function (r) {
              if (!r.ok) throw new Error("HTTP " + r.status);
              return r.arrayBuffer();
            })
            .then(function (data) { return ctx.decodeAudioData(data); })
            .catch(function (err) { delete self._buffers[sound.id]; throw err; });
        }
        return this._buffers[sound.id];
      },

      // Connects the current mic track (if any) into the mix. Safe to call
      // whenever the mic track may have changed; a no-op until mixing has started.
      rewireMic: function () {
        if (!this._dest) return;
        var AP = lively.identity.AmbientPresencePanel;
        var stream = AP && AP.getLocalStream();
        var track = stream && stream.getAudioTracks().filter(function (t) { return t.readyState === "live"; })[0];
        var id = track ? track.id : null;
        if (id === this._micTrackId) return;
        if (this._micSrc) { try { this._micSrc.disconnect(); } catch (e) {} this._micSrc = null; }
        this._micTrackId = id;
        if (!track) return;
        this._micSrc = this._ctx.createMediaStreamSource(new MediaStream([track]));
        this._micSrc.connect(this._dest);
      },

      // The audio track the room session should send: the mix once it exists.
      getOutgoingTrack: function () {
        return this._dest ? (this._dest.stream.getAudioTracks()[0] || null) : null;
      },

      _startMixing: function () {
        if (this._dest) return;
        var ctx = this._ensureContext();
        this._dest = ctx.createMediaStreamDestination();
        this.rewireMic();
        // Tell the room session to push the mixed track to its peers.
        try {
          var RV = lively.identity.RoomView;
          if (RV && RV.localTracksChanged) RV.localTracksChanged();
        } catch (e) { console.error("[Soundboard] localTracksChanged failed:", e); }
      },

      play: function (id) {
        var self = this;
        var AP = lively.identity.AmbientPresencePanel;
        if (!AP || !AP.controlEnabled("soundboard")) return Promise.resolve(false);
        var sound = this.SOUNDS.filter(function (s) { return s.id === id; })[0];
        if (!sound) return Promise.resolve(false);
        return this._load(sound).then(function (buffer) {
          // The call may have ended (or the headset gone off) while this loaded.
          if (!AP.controlEnabled("soundboard")) return false;
          self._startMixing();
          var src = self._ctx.createBufferSource();
          src.buffer = buffer;
          src.connect(self._dest);
          src.connect(self._ctx.destination);
          src.start();
          return true;
        }).catch(function (err) {
          console.warn("[Soundboard] could not play " + id + ":", err && err.message);
          return false;
        });
      },

      // Call ended: drop the mix. Loaded clips stay cached for the next call.
      teardown: function () {
        this.close();
        if (this._micSrc) { try { this._micSrc.disconnect(); } catch (e) {} this._micSrc = null; }
        this._micTrackId = null;
        if (this._dest) {
          try { this._dest.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
          this._dest = null;
        }
        if (this._ctx) { try { this._ctx.close(); } catch (e) {} this._ctx = null; this._buffers = {}; }
      },

      // ── popover ──

      toggle: function (panel) {
        if (this._popover) this.close(); else this.open(panel);
      },

      open: function (panel) {
        var self = this;
        var NS = lively.identity.AmbientPresencePanel;
        if (this._popover || !panel || !panel.world()) return;
        // Preload while the popover is up; the first load also creates and resumes
        // the audio context inside this click gesture.
        this.SOUNDS.forEach(function (s) { self._load(s).catch(function () {}); });

        var PAD = 12, GAP = 8, COLS = 3, BTN_H = 36, HEAD_H = 26;
        var W = NS.PANEL_W;
        var BTN_W = (W - 2 * PAD - (COLS - 1) * GAP) / COLS;
        var rows = Math.ceil(this.SOUNDS.length / COLS);
        var H = PAD + HEAD_H + rows * BTN_H + (rows - 1) * GAP + PAD;

        var pos = panel.getPosition();
        var box = new lively.morphic.Box(lively.rect(pos.x, pos.y - H - 8, W, H));
        box.isEpiMorph = true;
        box.applyStyle({ fill: Color.black, borderRadius: 12, borderWidth: 3, borderColor: Color.rgb(232, 73, 126) });
        box.draggingEnabled = false; box.droppingEnabled = false; box.grabbingEnabled = false;
        box.name = "SoundboardPopover";

        var head = new lively.morphic.Text(lively.rect(PAD, 8, W - 2 * PAD, 18));
        head.textString = "Soundboard";
        head.applyStyle({
          fontSize: 9, fontWeight: "bold", textColor: NS.TEXT_SECONDARY, fill: null, borderWidth: 0,
          allowInput: false, selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre",
        });
        head.eventsAreIgnored = true;
        box.addMorph(head);

        this.SOUNDS.forEach(function (s, i) {
          var col = i % COLS, row = Math.floor(i / COLS);
          var b = new lively.morphic.Text(lively.rect(
            PAD + col * (BTN_W + GAP), PAD + HEAD_H + row * (BTN_H + GAP), BTN_W, BTN_H));
          b.textString = s.label;
          b.applyStyle({
            fontSize: 9, fontWeight: "600", textColor: NS.TEXT_PRIMARY,
            fill: Color.rgba(255, 255, 255, 0.06), borderRadius: 8, borderWidth: 0, align: "center",
            padding: lively.Rectangle.inset(0, 10, 0, 0),
            allowInput: false, selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre",
            handStyle: "pointer",
          });
          b.draggingEnabled = false; b.droppingEnabled = false; b.grabbingEnabled = false;
          b.onMouseOver = function () { b.applyStyle({ fill: NS.HOVER_BG }); };
          b.onMouseOut = function () { b.applyStyle({ fill: Color.rgba(255, 255, 255, 0.06) }); };
          b.onMouseUp = function (evt) {
            self.play(s.id);
            evt.stop();
            return true;
          };
          box.addMorph(b);
        });

        $world.addMorph(box);
        box.enableFixedPositioning();
        this._popover = box;

        // Click outside or Escape closes it. The soundboard button itself is
        // excluded so its own click toggles instead of close-then-reopen.
        var onDown = function (e) {
          var node = box.renderContext().shapeNode;
          var btn = panel._soundBtn && panel._soundBtn.renderContext().shapeNode;
          if (node.contains(e.target) || (btn && btn.contains(e.target))) return;
          self.close();
        };
        var onKey = function (e) { if (e.key === "Escape") self.close(); };
        document.addEventListener("mousedown", onDown, true);
        document.addEventListener("keydown", onKey, true);
        this._closeHandlers = { onDown: onDown, onKey: onKey };
      },

      close: function () {
        if (this._closeHandlers) {
          document.removeEventListener("mousedown", this._closeHandlers.onDown, true);
          document.removeEventListener("keydown", this._closeHandlers.onKey, true);
          this._closeHandlers = null;
        }
        if (this._popover) { try { this._popover.remove(); } catch (e) {} this._popover = null; }
      },
    };

  }); // end module('lively.identity.Soundboard')
