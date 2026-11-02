module("lively.identity.AmbientPresencePanel")
  .requires(
    "lively.identity.DID",
    "lively.identity.PostCardUtils",
    "lively.identity.Soundboard",
    "lively.identity.FaceEffects",
    "lively.persistence.BuildSpec",
  )
  .toRun(function () {

    // NOTE: lively.BuildSpec methods (and anything installed via
    // Morph#addScript) get reconstructed from their own source text at
    // runtime (BuildSpec's evalJS path / addScript's Function.fromString),
    // which throws away the closure over this toRun(function(){...})
    // wrapper's own `var`s — confirmed empirically (a var referenced from
    // an addScript'd function throws "ReferenceError: ... is not defined"
    // even though the file loads fine). So every constant/helper those
    // methods need lives on the lively.identity.AmbientPresencePanel namespace
    // object itself instead of a closure var — a dotted global path still
    // resolves fine after reconstruction, only closures are lost.
    Object.extend(lively.identity.AmbientPresencePanel, {
      PANEL_W: 340,
      PANEL_H: 52,
      ROOM_H: 100,
      PANEL_BG:       Color.rgb(0xE8, 0x49, 0x7E),   // #E8497E
      // Cam/mic/headset encode on/off state via icon color alone
      // (_updateControls) — that loses contrast against the pink PANEL_BG,
      // so those three sit on this black pill instead. The gear has no
      // on/off state and stays directly on the pink panel with ICON_GEAR.
      CONTROL_PILL_BG: Color.rgb(0x1A, 0x1A, 0x1E),
      ICON_GEAR:      Color.rgb(0, 0, 0),
      TEXT_PRIMARY:   Color.rgb(242, 243, 245),
      TEXT_SECONDARY: Color.rgb(148, 155, 164),
      ICON_DEFAULT:   Color.rgb(181, 186, 193),
      ICON_DANGER:    Color.rgb(242, 63, 66),
      ICON_INACTIVE:  Color.rgb(80, 84, 91),
      HOVER_BG:      Color.rgba(255, 255, 255, 0.08),
      STATUS_ONLINE:  Color.rgb(35, 165, 89),
      STATUS_IDLE:    Color.rgb(240, 178, 50),
      STATUS_DND:       Color.rgb(242, 63, 66),   // same red as ICON_DANGER
      STATUS_INVISIBLE: Color.rgb(128, 132, 138),

      // Status picker (avatar click) metadata — order matches the reference
      // screenshot's row order, top to bottom.
      STATUS_ORDER: ["online", "idle", "dnd", "invisible"],
      STATUS_META: {
        online:    { icon: "fiber_manual_record", label: "Online" },
        idle:      { icon: "bedtime", label: "Idle" },
        dnd:       { icon: "do_not_disturb_on", label: "Do Not Disturb",
                     subtext: "You will not receive notifications" },
        invisible: { icon: "radio_button_unchecked", label: "Invisible",
                     subtext: "You will appear offline" },
      },
      DURATION_OPTIONS: [
        { key: "15m",     label: "For 15 Minutes" },
        { key: "1h",      label: "For 1 Hour" },
        { key: "8h",      label: "For 8 Hours" },
        { key: "24h",     label: "For 24 Hours" },
        { key: "3d",      label: "For 3 Days" },
        { key: "forever", label: "Forever" },
      ],
      // Mirrors IdentityServer.js's STATUS_DURATION_MS — used only for an
      // optimistic local paint right after a click; the server computes and
      // returns the real expiresAt (never trusts a client timestamp), which
      // overwrites this estimate once the PUT resolves.
      DURATION_MS: {
        "15m": 15 * 60 * 1000,
        "1h":  60 * 60 * 1000,
        "8h":  8 * 60 * 60 * 1000,
        "24h": 24 * 60 * 60 * 1000,
        "3d":  3 * 24 * 60 * 60 * 1000,
      },

      // Icon glyphs render through the vendored Material Symbols Rounded
      // font (core/styles/material-symbols.css, loaded once per world) by
      // setting a Text morph's content to the icon's ligature name — same
      // glyphs as the SVGs under core/media/material-icons/, just as inline
      // text so textColor drives the on/off (gray/red) recoloring instead
      // of image tinting.
      makeIconButton: function (rect, glyph, actionName, radius, baseFill) {
        var NS = lively.identity.AmbientPresencePanel;
        var btn = new lively.morphic.Text(rect);
        btn.textString = glyph;
        btn.applyStyle({
          fontFamily: "'Material Symbols Rounded'",
          // fontSize renders as `${size}pt`, not px (core/lively/morphic/HTML.js
          // setFontSizeHTML) — 15pt = 20px, the actual target glyph size. Padding
          // below still uses the real 20px target since padding is genuine px.
          fontSize: 15,
          textColor: NS.ICON_DEFAULT,
          fill: baseFill || null,
          borderRadius: radius != null ? radius : rect.width / 2,
          borderWidth: 1,
          borderColor: NS.PANEL_BG,
          align: "center",
          padding: lively.Rectangle.inset(0, Math.round((rect.height - 20) / 2), 0, 0),
          allowInput: false,
          selectable: false,
          clipMode: "hidden",
          whiteSpaceHandling: "pre",
          handStyle: "pointer",
        });
        btn._actionName = actionName;
        btn._baseFill = baseFill || null;
        btn.addScript(function onMouseOver() {
          this.applyStyle({ fill: lively.identity.AmbientPresencePanel.HOVER_BG });
        });
        btn.addScript(function onMouseOut() {
          this.applyStyle({ fill: this._baseFill || null });
        });
        btn.addScript(function onMouseUp(evt) {
          var panel = lively.identity.AmbientPresencePanel._panel;
          if (panel) panel[this._actionName]();
          evt.stop();
          return true;
        });
        return btn;
      },
    });

    lively.BuildSpec("lively.identity.AmbientPresencePanel", {
      isEpiMorph: true,
      className: "lively.morphic.Box",
      name: "AmbientPresencePanel",
      draggingEnabled: false,
      droppingEnabled: false,
      grabbingEnabled: false,
      style: {
        extent: lively.pt(340, 52),
        fill: lively.identity.AmbientPresencePanel.PANEL_BG,
        borderRadius: 12,
        borderWidth: 3,
        borderColor: Color.rgb(232, 73, 126),   // #e8497e
      },

      micMuted: false,
      deafened: false,
      cameraOff: false,

      alignInWorld: function alignInWorld() {
        var wBounds = $world.visibleBounds();
        this.setPosition(lively.pt(
          wBounds.right() - this.getExtent().x - 12,
          wBounds.bottom() - this.getExtent().y - 12,
        ));
      },

      onWorldResize: function onWorldResize() {
        lively.lang.fun.debounceNamed(this.id + "-vcp-world-resize", 100,
          this.alignInWorld.bind(this))();
      },

      _render: function _render() {
        var NS = lively.identity.AmbientPresencePanel;
        this.removeAllMorphs();
        this._roomRow = null;

        // Everything of the user row lives in one container so the room block
        // can sit above it by moving just this one morph.
        var row = new lively.morphic.Box(lively.rect(0, 0, NS.PANEL_W, NS.PANEL_H));
        row.applyStyle({ fill: null, borderWidth: 0 });
        row.draggingEnabled = false; row.droppingEnabled = false; row.grabbingEnabled = false;
        this.addMorph(row);
        this._mainRow = row;

        this._avatarMorph = new lively.morphic.Image(lively.rect(10, 10, 32, 32));
        this._avatarMorph.applyStyle({ borderRadius: 16, borderWidth: 2,
          borderColor: Color.rgb(255, 255, 255), clipMode: "hidden" });
        row.addMorph(this._avatarMorph);

        // fontSize is in pt, not px (see makeIconButton's comment) — 9pt/8.25pt
        // render at the actual-target 12px/11px, with box heights generous
        // enough (18/16) that clipMode:hidden has real margin to spare.
        this._nameMorph = new lively.morphic.Text(lively.rect(50, 8, 140, 18));
        this._nameMorph.applyStyle({ fontSize: 9, fontWeight: "bold",
          textColor: NS.TEXT_PRIMARY, fill: null, borderWidth: 0, allowInput: false,
          selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre" });
        row.addMorph(this._nameMorph);

        this._statusMorph = new lively.morphic.Text(lively.rect(50, 27, 140, 16));
        this._statusMorph.applyStyle({ fontSize: 8.25, fontWeight: "600", textColor: Color.rgb(0, 0, 0),
          fill: null, borderWidth: 0, allowInput: false, selectable: false,
          clipMode: "hidden", whiteSpaceHandling: "pre" });
        row.addMorph(this._statusMorph);

        // Black pill behind cam/mic/headset (see CONTROL_PILL_BG above) —
        // added before those three buttons so it paints underneath them.
        this._controlPill = new lively.morphic.Box(lively.rect(183, 8, 108, 36));
        this._controlPill.applyStyle({ fill: NS.CONTROL_PILL_BG, borderWidth: 0, borderRadius: 18 });
        this._controlPill.draggingEnabled = false;
        this._controlPill.droppingEnabled = false;
        this._controlPill.grabbingEnabled = false;
        this._controlPill.eventsAreIgnored = true;
        row.addMorph(this._controlPill);

        this._camBtn = NS.makeIconButton(lively.rect(189, 12, 28, 28), "videocam", "toggleCamera");
        row.addMorph(this._camBtn);

        this._micBtn = NS.makeIconButton(lively.rect(223, 12, 28, 28), "mic", "toggleMic");
        row.addMorph(this._micBtn);

        this._headsetBtn = NS.makeIconButton(lively.rect(257, 12, 28, 28), "headset_mic", "toggleDeafen");
        row.addMorph(this._headsetBtn);

        // makeIconButton's default borderColor/padding assume the button sits
        // directly on PANEL_BG with a ~20px-tall glyph; inside the pill the
        // border needs to blend with CONTROL_PILL_BG instead, and the
        // padding renders Material Symbols glyphs ~4px too low (confirmed
        // live via getBoundingClientRect — real glyph line height is ~24px,
        // not 20px) — dropping it centers the glyph exactly on the pill.
        [this._camBtn, this._micBtn, this._headsetBtn].forEach(function (btn) {
          btn.applyStyle({ borderColor: NS.CONTROL_PILL_BG, padding: lively.Rectangle.inset(0, 0, 0, 0) });
        });

        this._gearBtn = NS.makeIconButton(lively.rect(302, 12, 28, 28), "settings", "openSettings");
        this._gearBtn.applyStyle({ textColor: NS.ICON_GEAR, padding: lively.Rectangle.inset(0, 0, 0, 0) });
        row.addMorph(this._gearBtn);

        // Transparent click target covering the avatar+badge (their rects
        // overlap each other, so a handler on either individually would eat
        // clicks meant for the other) — added last so it paints on top.
        this._badgeDot = null;
        this._statusHitArea = new lively.morphic.Box(lively.rect(10, 10, 32, 34));
        this._statusHitArea.applyStyle({ fill: null, borderWidth: 0, handStyle: "pointer" });
        this._statusHitArea.draggingEnabled = false;
        this._statusHitArea.droppingEnabled = false;
        this._statusHitArea.grabbingEnabled = false;
        this._statusHitArea.toolTip = "Set status";
        this._statusHitArea.addScript(function onMouseUp(evt) {
          var panel = lively.identity.AmbientPresencePanel._panel;
          if (panel) panel.toggleStatusMenu();
          evt.stop();
          return true;
        });
        row.addMorph(this._statusHitArea);
      },

      toggleMic: function toggleMic() {
        if (!lively.identity.AmbientPresencePanel.controlEnabled("mic")) return;
        if (this.deafened) {
          this.deafened = false;
          this.micMuted = false;
        } else {
          this.micMuted = !this.micMuted;
        }
        this._updateControls();
        this._savePersistedPrefs();
        lively.identity.AmbientPresencePanel._applyTrackState();
      },

      toggleDeafen: function toggleDeafen() {
        if (!lively.identity.AmbientPresencePanel.controlEnabled("deafen")) return;
        this.deafened = !this.deafened;
        this.micMuted = this.deafened;
        this._updateControls();
        this._savePersistedPrefs();
        lively.identity.AmbientPresencePanel._applyTrackState();
      },

      toggleCamera: function toggleCamera() {
        if (!lively.identity.AmbientPresencePanel.controlEnabled("camera")) return;
        this.cameraOff = !this.cameraOff;
        this._updateControls();
        this._savePersistedPrefs();
        lively.identity.AmbientPresencePanel._applyTrackState();
      },

      // localStorage persistence for mic/deafen/camera prefs — same
      // try/catch-swallow idiom ConstellationsBrowser.js's _loadKnown/
      // _saveKnown already use elsewhere in this directory. Loaded once in
      // onLoad, before the first _updateControls() paints the icons, so a
      // reload doesn't silently reset to unmuted.
      // Routed through the NS-level read/write-merge helpers (not a plain
      // localStorage.setItem of just these three fields) because the status
      // picker's own local cache (_saveStatusLocal) shares this same key —
      // a non-merging write here would silently clobber it.
      _loadPersistedPrefs: function _loadPersistedPrefs() {
        var prefs = lively.identity.AmbientPresencePanel._readPresenceState();
        this.micMuted = !!prefs.micMuted;
        this.deafened = !!prefs.deafened;
        this.cameraOff = !!prefs.cameraOff;
      },

      _savePersistedPrefs: function _savePersistedPrefs() {
        lively.identity.AmbientPresencePanel._writePresenceState({
          micMuted: this.micMuted, deafened: this.deafened, cameraOff: this.cameraOff,
        });
      },

      // Grows the panel with a room block ABOVE the user row: a header (which
      // room, click to show its window, end-call glyph) and a row of call
      // actions (screenshare, soundboard). onLeaveRequested / onShowRequested
      // are supplied by the caller (RoomView.js's enterRoom call) so the actual
      // leave-presence and window semantics stay owned by the room session,
      // not duplicated here; this panel only shows status and relays clicks.
      _showInRoomRow: function _showInRoomRow(room) {
        var NS = lively.identity.AmbientPresencePanel;
        this._hideInRoomRow();
        var ROOM_H = NS.ROOM_H;
        this.setExtent(lively.pt(NS.PANEL_W, NS.PANEL_H + ROOM_H));
        this._mainRow.setPosition(lively.pt(0, ROOM_H));

        var block = new lively.morphic.Box(lively.rect(0, 0, NS.PANEL_W, ROOM_H));
        block.applyStyle({ fill: null, borderWidth: 0 });
        block.draggingEnabled = false; block.droppingEnabled = false; block.grabbingEnabled = false;
        this.addMorph(block);
        this._roomRow = block;

        var chip = new lively.morphic.Text(lively.rect(12, 8, 34, 34));
        chip.textString = "podcasts";
        chip.applyStyle({
          fontFamily: "'Material Symbols Rounded'", fontSize: 15, textColor: NS.STATUS_ONLINE,
          fill: Color.rgba(35, 165, 89, 0.15), borderRadius: 8, borderWidth: 0, align: "center",
          padding: lively.Rectangle.inset(0, 7, 0, 0),
          allowInput: false, selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre",
        });
        chip.eventsAreIgnored = true;
        block.addMorph(chip);

        var title = new lively.morphic.Text(lively.rect(54, 6, 200, 18));
        title.textString = "Cluster Connected";
        title.applyStyle({
          fontSize: 9.75, fontWeight: "bold", textColor: NS.STATUS_ONLINE,
          fill: null, borderWidth: 0, allowInput: false, selectable: false,
          clipMode: "hidden", whiteSpaceHandling: "pre",
        });
        title.eventsAreIgnored = true;
        block.addMorph(title);

        // End-call pill width is carved out of the room-name label's own
        // width (below) so the two never overlap — PILL_W/PILL_MARGIN are
        // shared between both so a future resize of either stays consistent.
        // Wider than its stacked content strictly needs — a true stadium-
        // shaped pill (borderRadius PILL_H/2 below) reads oval, not circular,
        // at this width/height ratio.
        var PILL_W = 60, PILL_H = 36, PILL_MARGIN = 10;
        var pillX = NS.PANEL_W - PILL_MARGIN - PILL_W;

        var label = new lively.morphic.Text(lively.rect(54, 25, pillX - 8 - 54, 16));
        label.textString = room.roomName || "";
        label.applyStyle({
          fontSize: 8.25, fontWeight: "600", textColor: NS.TEXT_SECONDARY,
          fill: null, borderWidth: 0, allowInput: false, selectable: false,
          clipMode: "hidden", whiteSpaceHandling: "pre", handStyle: "pointer",
        });
        // Clicking the room name brings the room window forward (expanding it if
        // minimized, rebuilding it if it was closed) — the window is only a view
        // over the call, which keeps running either way.
        label.toolTip = "Show cluster window";
        label.onMouseDown = function (evt) {
          if (typeof room.onShowRequested === "function") room.onShowRequested();
          evt.stop();
          return true;
        };
        block.addMorph(label);

        // Solid red pill ("End" label stacked above the hang-up icon) — a bare
        // glyph here used to blend into the pink panel at a glance; a filled
        // pill with its own text reads unambiguously as a hang-up control.
        var leaveBtn = new lively.morphic.Box(lively.rect(pillX, 6, PILL_W, PILL_H));
        leaveBtn.applyStyle({
          fill: NS.ICON_DANGER, borderWidth: 2, borderColor: Color.rgb(255, 255, 255),
          borderRadius: PILL_H / 2, handStyle: "pointer",
        });
        leaveBtn.draggingEnabled = false; leaveBtn.droppingEnabled = false; leaveBtn.grabbingEnabled = false;
        leaveBtn.toolTip = "End call";
        block.addMorph(leaveBtn);

        var leaveLabel = new lively.morphic.Text(lively.rect(0, 4, PILL_W, 14));
        leaveLabel.textString = "End";
        leaveLabel.applyStyle({
          fontSize: 8, fontWeight: "bold", textColor: Color.rgb(255, 255, 255),
          fill: null, borderWidth: 0, align: "center", allowInput: false, selectable: false,
          clipMode: "hidden", whiteSpaceHandling: "pre",
        });
        leaveLabel.eventsAreIgnored = true;
        leaveLabel.draggingEnabled = false; leaveLabel.droppingEnabled = false; leaveLabel.grabbingEnabled = false;
        leaveBtn.addMorph(leaveLabel);

        var leaveIcon = new lively.morphic.Text(lively.rect(0, 18, PILL_W, 16));
        leaveIcon.textString = "call_end";
        leaveIcon.applyStyle({
          fontFamily: "'Material Symbols Rounded'", fontSize: 9, textColor: Color.rgb(255, 255, 255),
          fill: null, borderWidth: 0, align: "center", allowInput: false, selectable: false,
          clipMode: "hidden", whiteSpaceHandling: "pre",
        });
        leaveIcon.eventsAreIgnored = true;
        leaveIcon.draggingEnabled = false; leaveIcon.droppingEnabled = false; leaveIcon.grabbingEnabled = false;
        leaveBtn.addMorph(leaveIcon);
        // Widening the glyph itself (not the pill) needs a horizontal-only
        // stretch — bumping fontSize scales height right along with width
        // (confirmed live: grew the rendered glyph past its own box's bottom
        // edge under clipMode:hidden) and the pill was never meant to grow.
        // A CSS transform on the real span sidesteps that entirely.
        (function () {
          var span = leaveIcon.renderContext().shapeNode.querySelector("span");
          if (span) { span.style.display = "inline-block"; span.style.transform = "scaleX(1.917)"; }
        })();

        // onMouseUp, not onMouseDown: leaving hides this very block, and the panel
        // is bottom-anchored, so it re-aligns downward — on mouse-down that slid
        // the settings gear under the still-held pointer, whose mouse-up then
        // opened the Settings window (confirmed live). Finishing the click first
        // means nothing moves until the gesture is over.
        leaveBtn.onMouseUp = function (evt) {
          if (typeof room.onLeaveRequested === "function") room.onLeaveRequested();
          evt.stop();
          return true;
        };
        block.addMorph(leaveBtn);

        var BTN_W = (NS.PANEL_W - 24 - 16) / 3, BASE = Color.rgba(255, 255, 255, 0.06);
        this._screenBtn = NS.makeIconButton(lively.rect(12, 52, BTN_W, 36), "screen_share", "toggleScreenshare", 8, BASE);
        this._screenBtn.toolTip = "Share your screen";
        block.addMorph(this._screenBtn);
        this._soundBtn = NS.makeIconButton(lively.rect(12 + BTN_W + 8, 52, BTN_W, 36), "campaign", "openSoundboard", 8, BASE);
        this._soundBtn.toolTip = "Soundboard";
        block.addMorph(this._soundBtn);
        this._faceBtn = NS.makeIconButton(lively.rect(12 + 2 * (BTN_W + 8), 52, BTN_W, 36), "face_retouching_natural", "openFaceEffects", 8, BASE);
        this._faceBtn.toolTip = "Face effects";
        block.addMorph(this._faceBtn);

        var sep = new lively.morphic.Box(lively.rect(0, ROOM_H - 1, NS.PANEL_W, 1));
        sep.applyStyle({ fill: Color.rgba(255, 255, 255, 0.08), borderWidth: 0 });
        sep.eventsAreIgnored = true;
        block.addMorph(sep);

        this.alignInWorld();
        this._updateControls();
      },

      _hideInRoomRow: function _hideInRoomRow() {
        var NS = lively.identity.AmbientPresencePanel;
        if (this._roomRow) { this._roomRow.remove(); this._roomRow = null; }
        this._screenBtn = null; this._soundBtn = null; this._faceBtn = null;
        if (this._mainRow) this._mainRow.setPosition(lively.pt(0, 0));
        this.setExtent(lively.pt(NS.PANEL_W, NS.PANEL_H));
        this.alignInWorld();
      },

      toggleScreenshare: function toggleScreenshare() {
        var NS = lively.identity.AmbientPresencePanel;
        if (!NS.controlEnabled("screenshare")) return;
        var RV = lively.identity.RoomView;
        if (RV && RV.toggleScreenShare) RV.toggleScreenShare();
      },

      openSoundboard: function openSoundboard() {
        var NS = lively.identity.AmbientPresencePanel;
        if (!NS.controlEnabled("soundboard")) return;
        lively.identity.FaceEffects.close();
        lively.identity.Soundboard.toggle(this);
      },

      openFaceEffects: function openFaceEffects() {
        var NS = lively.identity.AmbientPresencePanel;
        if (!NS.controlEnabled("faceeffects")) return;
        lively.identity.Soundboard.close();
        lively.identity.FaceEffects.toggle(this);
      },

      _updateControls: function _updateControls() {
        var NS = lively.identity.AmbientPresencePanel;
        // A control with nothing to act on (only in a text room, or a camera in
        // an audio-only call) shows greyed with its plain glyph, ignoring the prefs.
        var camOn = NS.controlEnabled("camera"), micOn = NS.controlEnabled("mic"), deafOn = NS.controlEnabled("deafen");
        this._camBtn.textString = camOn && this.cameraOff ? "videocam_off" : "videocam";
        this._camBtn.applyStyle({ textColor: !camOn ? NS.ICON_INACTIVE : (this.cameraOff ? NS.ICON_DANGER : NS.STATUS_ONLINE) });
        this._micBtn.textString = micOn && this.micMuted ? "mic_off" : "mic";
        this._micBtn.applyStyle({ textColor: !micOn ? NS.ICON_INACTIVE : (this.micMuted ? NS.ICON_DANGER : NS.STATUS_ONLINE) });
        this._headsetBtn.textString = deafOn && this.deafened ? "headset_off" : "headset_mic";
        this._headsetBtn.applyStyle({ textColor: !deafOn ? NS.ICON_INACTIVE : (this.deafened ? NS.ICON_DANGER : NS.STATUS_ONLINE) });
        if (this._screenBtn) {
          var shOn = NS.controlEnabled("screenshare"), sharing = !!NS._screenSharing;
          this._screenBtn.textString = shOn && sharing ? "stop_screen_share" : "screen_share";
          this._screenBtn.applyStyle({ textColor: !shOn ? NS.ICON_INACTIVE : (sharing ? NS.STATUS_ONLINE : NS.ICON_DEFAULT) });
        }
        if (this._soundBtn) {
          var sbOn = NS.controlEnabled("soundboard");
          this._soundBtn.applyStyle({ textColor: sbOn ? NS.ICON_DEFAULT : NS.ICON_INACTIVE });
          if (!sbOn && lively.identity.Soundboard) lively.identity.Soundboard.close();
        }
        if (this._faceBtn) {
          var feOn = NS.controlEnabled("faceeffects");
          var feActive = feOn && lively.identity.FaceEffects.isActive();
          this._faceBtn.applyStyle({ textColor: !feOn ? NS.ICON_INACTIVE : (feActive ? NS.STATUS_ONLINE : NS.ICON_DEFAULT) });
          if (!feOn) lively.identity.FaceEffects.close();
        }
      },

      openSettings: function openSettings() {
        lively.require("lively.identity.SettingsDialog").toRun(function () {
          lively.identity.SettingsDialog.open();
        });
      },

      toggleStatusMenu: function toggleStatusMenu() {
        lively.identity.AmbientPresencePanel._toggleStatusMenu();
      },

      // Lazily creates the status badge — a plain solid-color circle, not a
      // Material Symbols glyph. An icon glyph (tried first) reads as a faint
      // ring rather than a bold shape at this badge's tiny render size
      // (confirmed live, all four states: barely visible against the pink
      // panel) — a flat color fill has no such legibility floor, so every
      // status just fills this one circle in its own color instead. 12x12
      // at (31,31), matching the footprint worked out for the icon version.
      _ensureBadgeDot: function _ensureBadgeDot() {
        if (this._badgeDot) return;
        var d = new lively.morphic.Box(lively.rect(31, 31, 12, 12));
        d.applyStyle({ fill: Color.rgb(255, 255, 255), borderRadius: 6,
          borderWidth: 2, borderColor: Color.rgb(255, 255, 255) });
        d.draggingEnabled = false; d.droppingEnabled = false; d.grabbingEnabled = false;
        d.eventsAreIgnored = true;
        d.setVisible(false);
        this._mainRow.addMorph(d);
        this._badgeDot = d;
      },

      // Shared by _paintStatus (explicit picks) and _updateStatus (tab-
      // visibility auto-idle) — every status just fills the badge dot in
      // its own color (STATUS_ONLINE/STATUS_IDLE/STATUS_DND/STATUS_INVISIBLE).
      _paintBadge: function _paintBadge(status) {
        var NS = lively.identity.AmbientPresencePanel;
        var color = status === "dnd" ? NS.STATUS_DND
          : status === "invisible" ? NS.STATUS_INVISIBLE
          : status === "idle" ? NS.STATUS_IDLE : NS.STATUS_ONLINE;
        this._ensureBadgeDot();
        this._badgeDot.applyStyle({ fill: color });
        this._badgeDot.setVisible(true);
        NS._broadcastStatus(status);
      },

      // Paints an explicitly-chosen status (Online/Idle/Do Not Disturb/Invisible).
      _paintStatus: function _paintStatus(status) {
        var NS = lively.identity.AmbientPresencePanel;
        var meta = NS.STATUS_META[status] || NS.STATUS_META.online;
        this._statusMorph.textString = meta.label;
        this._paintBadge(status);
      },

      // Tab-visibility-based auto-idle — the original, purely cosmetic
      // status signal. Once the user has explicitly picked a status from
      // the new avatar-click menu (_toggleStatusMenu), that explicit choice
      // always wins and this handler stops overriding the badge; it only
      // still runs for the untouched default (nobody has ever opened the
      // status menu on this account/device).
      _updateStatus: function _updateStatus() {
        var NS = lively.identity.AmbientPresencePanel;
        if (NS._explicitStatusSet) return;
        var idle = typeof document !== "undefined" && document.hidden;
        this._statusMorph.textString = idle ? "Idle" : "Online";
        this._paintBadge(idle ? "idle" : "online");
      },

      update: function update() {
        if (!lively.identity.did || !lively.identity.did.isLoggedIn()) return;
        var handle = lively.identity.did.currentUser().handle;
        this._nameMorph.textString = "@" + lively.identity.did.displayHandle();
        this._updateControls();
        this._updateStatus();

        if (this._avatarHandle !== handle) {
          this._avatarHandle = handle;
          this._avatarMorph.setImageURL(
            lively.identity.postCardUtils.identiconDataUrl(handle, 32));
          var self = this;
          fetch("/@" + handle + "/profile", { credentials: "include" })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (env) {
              if (!env || self._avatarHandle !== handle) return;
              var payload = (env.record && env.record.payload) || {};
              if (payload.avatarUrl) self._avatarMorph.setImageURL(payload.avatarUrl);
            })
            .catch(function () {});
        }
      },

      onLoad: function onLoad() {
        this._loadPersistedPrefs();
        this._render();
        this._visibilityHandler = this._updateStatus.bind(this);
        if (typeof document !== "undefined") {
          document.addEventListener("visibilitychange", this._visibilityHandler);
        }
        lively.identity.AmbientPresencePanel._loadStatus();
        this.update();
      },

      onFromBuildSpecCreated: function onFromBuildSpecCreated() {
        this.onLoad();
      },
    });

    // Plain vanilla JS object extension (not a BuildSpec/addScript path),
    // so normal closures over `self` etc. are safe here.
    Object.extend(lively.identity.AmbientPresencePanel, {
      _panel: null,
      _localStream: null,
      _screenSharing: false,   // set by the room session (RoomView) while this user shares their screen
      setScreenSharing: function setScreenSharing(on) {
        this._screenSharing = !!on;
        this.refreshControls();
      },
      _activeRoom: null,   // {constellation, roomId, roomName, onLeaveRequested, onShowRequested} | null

      // Called by RoomView.js once it's actually joined a room's presence.
      // Grows the panel with an "in room" row and (re)acquires local media
      // matching the current mic/cam prefs — real getUserMedia, since a
      // room is now genuinely active. The room lives in this world for as
      // long as the session does (window open, minimized or closed), so this
      // stream is the one call-wide mic/camera source, not tied to any window
      // (see this file's own header on the general BuildSpec/closure caveats,
      // which don't apply to this plain-extension block).
      enterRoom: function enterRoom(room) {
        this._activeRoom = room;
        // Which devices this room's call uses: audio-only rooms never capture
        // the camera. Default (both) keeps callers that don't say working.
        this._mediaKinds = { audio: room.audio !== false, video: room.video !== false };
        this._acquireLocalMedia();
        // MenuBarEntry.js's own init() call (which normally creates _panel
        // in response to identityChanged/sync()) races this — a room-boot
        // page can call enterRoom before that's had a chance to run. open()
        // is idempotent (returns the existing panel if one's already up),
        // so calling it here guarantees a panel exists to show the row on,
        // regardless of which finished loading first.
        this.open()._showInRoomRow(room);
        this.refreshControls();
      },

      leaveRoom: function leaveRoom() {
        this._activeRoom = null;
        this._screenSharing = false;
        lively.identity.Soundboard.teardown();
        lively.identity.FaceEffects.teardown();
        this._releaseLocalMedia();
        if (this._panel) this._panel._hideInRoomRow();
        this.refreshControls();
      },

      _mediaKinds: { audio: true, video: true },

      // Whether a control does anything right now. Mic/deafen need a call;
      // the camera needs a call that carries video. With no room at all the
      // controls stay live so the prefs can be set ahead of joining; when the
      // only thing open is a text room there is no call, so they go inactive.
      controlEnabled: function controlEnabled(which) {
        // Call-only actions: need a live call; the soundboard also needs the headset on.
        if (which === "screenshare") return !!this._activeRoom;
        if (which === "faceeffects") return !!this._activeRoom && !!this._mediaKinds.video;
        if (which === "soundboard") return !!this._activeRoom && !(this._panel && this._panel.deafened);
        if (this._activeRoom) return which === "camera" ? !!this._mediaKinds.video : true;
        var RV = lively.identity.RoomView;
        return !(RV && RV.hasTextSession && RV.hasTextSession());
      },

      refreshControls: function refreshControls() {
        var p = this._panel;
        if (p && p._camBtn && p._micBtn && p._headsetBtn) p._updateControls();
      },

      getLocalStream: function getLocalStream() {
        return this._localStream;
      },

      // The video track to send to peers: the face-effects canvas while effects are
      // on and producing frames, otherwise the raw camera track (or null).
      getOutgoingVideoTrack: function getOutgoingVideoTrack() {
        var fx = lively.identity.FaceEffects.getOutgoingTrack();
        if (fx) return fx;
        return this._localStream ? (this._localStream.getVideoTracks()[0] || null) : null;
      },

      // What the self-view should play: the face-effects stream while it is
      // producing frames, otherwise the plain local stream.
      getLocalViewStream: function getLocalViewStream() {
        return lively.identity.FaceEffects.getViewStream() || this._localStream;
      },

      // The audio track to send to peers: the soundboard mix once it has been
      // started (mic + clips), otherwise the plain mic track.
      getOutgoingAudioTrack: function getOutgoingAudioTrack() {
        var mixed = lively.identity.Soundboard.getOutgoingTrack();
        if (mixed) return mixed;
        return this._localStream ? (this._localStream.getAudioTracks()[0] || null) : null;
      },

      _acquiring: false,        // an initial audio+video getUserMedia is in flight
      _reapplyAfterAcquire: false,
      _pendingKinds: { audio: false, video: false },   // a single-kind (re)acquire is in flight

      _acquireLocalMedia: function _acquireLocalMedia() {
        var self = this;
        var p = this._panel;
        var wantAudio = this._mediaKinds.audio && !(p && p.micMuted);
        var wantVideo = this._mediaKinds.video && !(p && p.cameraOff);
        if (!wantAudio && !wantVideo) return;
        if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
        // A toggle while this is still resolving used to start a second
        // getUserMedia whose stream then replaced (and orphaned, still live)
        // the first. Remember to re-apply the prefs once this one lands instead.
        if (this._acquiring) { this._reapplyAfterAcquire = true; return; }
        this._acquiring = true;
        navigator.mediaDevices.getUserMedia({ audio: wantAudio, video: wantVideo })
          .then(function (stream) {
            self._acquiring = false;
            // A leaveRoom() could have raced this promise — don't attach a
            // stream for a room we're no longer in.
            if (!self._activeRoom) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
            self._localStream = stream;
            lively.identity.Soundboard.rewireMic();
            if (self._reapplyAfterAcquire) { self._reapplyAfterAcquire = false; self._applyTrackState(); }
          })
          .catch(function (err) {
            self._acquiring = false;
            self._reapplyAfterAcquire = false;
            console.warn("[AmbientPresencePanel] getUserMedia failed:", err && err.message);
          });
      },

      _releaseLocalMedia: function _releaseLocalMedia() {
        if (this._localStream) {
          this._localStream.getTracks().forEach(function (t) { t.stop(); });
          this._localStream = null;
        }
      },

      // Lets the room session push the change to its peer connections (and its
      // own self-view). RoomView owns those, this panel only owns the stream.
      _afterLocalTracksChanged: function _afterLocalTracksChanged() {
        try { lively.identity.Soundboard.rewireMic(); } catch (e) { console.error("[AmbientPresencePanel] rewireMic failed:", e); }
        try { lively.identity.FaceEffects.rewire(); } catch (e) { console.error("[AmbientPresencePanel] face effects rewire failed:", e); }
        try {
          var RV = lively.identity.RoomView;
          if (RV && RV.localTracksChanged) RV.localTracksChanged();
        } catch (e) { console.error("[AmbientPresencePanel] localTracksChanged failed:", e); }
      },

      // Captures one kind of track on demand and adds it to the live stream:
      // the camera when it's turned back on (turning it off really releases
      // the device, see _applyTrackState), or the mic when the room was
      // entered muted (audio was never requested then, so nothing existed to
      // un-mute). Discarded if the pref flipped again or the room was left
      // while it was resolving.
      _ensureTrack: function _ensureTrack(kind) {
        var self = this;
        if (this._pendingKinds[kind]) return;
        if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
        this._pendingKinds[kind] = true;
        navigator.mediaDevices.getUserMedia(kind === "audio" ? { audio: true } : { video: true })
          .then(function (s) {
            self._pendingKinds[kind] = false;
            var p = self._panel;
            var stillWanted = self._activeRoom && self._localStream &&
              (kind === "audio" ? (self._mediaKinds.audio && !(p && p.micMuted))
                                : (self._mediaKinds.video && !(p && p.cameraOff)));
            if (!stillWanted) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
            var stream = self._localStream;
            stream.getTracks().filter(function (t) { return t.kind === kind; })
              .forEach(function (t) { t.stop(); stream.removeTrack(t); });
            s.getTracks().forEach(function (t) { stream.addTrack(t); });
            self._afterLocalTracksChanged();
          })
          .catch(function (err) {
            self._pendingKinds[kind] = false;
            console.warn("[AmbientPresencePanel] could not (re)acquire " + kind + ":", err && err.message);
          });
      },

      // Called after every mic/deafen/camera toggle.
      //  - Mic: just enabled/disabled (a muted mic sends silence; keeping the
      //    device open is the normal behavior for a mic).
      //  - Camera: OFF really stops the video track — merely disabling it
      //    leaves the webcam captured and its light on (confirmed live: track
      //    enabled=false but readyState 'live') — and detaches it from every
      //    peer; ON captures a fresh track. The peer session is told via
      //    _afterLocalTracksChanged either way.
      //  - No stream yet (entered with both muted/off) or a wanted kind that
      //    was never captured: acquire it now that it's actually wanted.
      _applyTrackState: function _applyTrackState() {
        // Deafen also silences incoming voices (owned by the room session, not
        // this panel) — tell it before anything below can return early.
        try {
          var RV = lively.identity.RoomView;
          if (RV && RV.applyDeafened) RV.applyDeafened();
        } catch (e) { console.error("[AmbientPresencePanel] applyDeafened failed:", e); }
        if (!this._activeRoom) return;
        if (!this._localStream) { this._acquireLocalMedia(); return; }
        var p = this._panel;
        var stream = this._localStream;
        var wantAudio = this._mediaKinds.audio && !(p && p.micMuted);
        var wantVideo = this._mediaKinds.video && !(p && p.cameraOff);
        var audio = stream.getAudioTracks().filter(function (t) { return t.readyState === "live"; });
        var video = stream.getVideoTracks().filter(function (t) { return t.readyState === "live"; });

        audio.forEach(function (t) { t.enabled = wantAudio; });
        if (wantAudio && !audio.length) this._ensureTrack("audio");

        if (!wantVideo) {
          if (stream.getVideoTracks().length) {
            stream.getVideoTracks().forEach(function (t) { t.stop(); stream.removeTrack(t); });
            this._afterLocalTracksChanged();
          }
        } else if (!video.length) {
          this._ensureTrack("video");
        } else {
          video.forEach(function (t) { t.enabled = true; });
        }
      },

      init: function init() {
        var self = this;
        function connectAndSync() {
          self.sync();
          lively.bindings.connect(lively.identity.did, "identityChanged", self, "sync");
          lively.bindings.connect(lively.identity.did, "displayHandleChanged", self, "update");
        }
        if (lively.identity && lively.identity.did) connectAndSync();
        else lively.require("lively.identity.DID").toRun(connectAndSync);

        // Cross-tab fast path for status changes: same-browser tabs share
        // localStorage and get a 'storage' event the instant another tab
        // writes it (periodic polling in _startStatusPolling is the slower
        // cross-device fallback, and also what catches an auto-revert on a
        // tab that's been asleep past its own setTimeout).
        if (typeof window !== "undefined" && !this._storageListenerInstalled) {
          this._storageListenerInstalled = true;
          window.addEventListener("storage", function (e) {
            if (e.key !== "lively.identity.presenceState") return;
            var cached = self._loadStatusLocal();
            if (!cached) return;
            if (cached.expiresAt && new Date(cached.expiresAt).getTime() <= Date.now()) return;
            self._explicitStatusSet = !!cached.explicit || cached.status !== "online";
            self._applyStatus(cached.status, cached.expiresAt);
          });
        }
      },

      sync: function sync() {
        var loggedIn = lively.identity.did && lively.identity.did.isLoggedIn();
        if (loggedIn) this.open(); else this.close();
      },

      open: function open() {
        if (this._panel && this._panel.world()) {
          this._panel.update();
          return this._panel;
        }
        var p = lively.BuildSpec("lively.identity.AmbientPresencePanel").createMorph();
        p.openInWorld();
        p.enableFixedPositioning();
        p.alignInWorld();
        this._panel = p;
        return p;
      },

      close: function close() {
        this._closeStatusMenu();
        if (this._statusPollTimer) { clearInterval(this._statusPollTimer); this._statusPollTimer = null; }
        if (this._statusRevertTimer) { clearTimeout(this._statusRevertTimer); this._statusRevertTimer = null; }
        this._status = null;
        this._statusExpiresAt = null;
        this._explicitStatusSet = false;
        this._lastBroadcastKey = null;
        if (!this._panel) return;
        if (this._panel._visibilityHandler && typeof document !== "undefined") {
          document.removeEventListener("visibilitychange", this._panel._visibilityHandler);
        }
        this._panel.remove();
        this._panel = null;
      },

      // ─── status picker (avatar click) ───────────────────────────────────────
      // Status state lives here on the static namespace object, not on the
      // panel morph — it must survive the panel being removed/recreated by
      // close()/open() (e.g. across a logout/login), the same way
      // _activeRoom/_screenSharing already do. _panel._paintStatus(status)
      // is called whenever the badge needs repainting.

      _status: null,             // 'online' | 'idle' | 'dnd' | 'invisible' | null (not yet loaded)
      _statusExpiresAt: null,
      _explicitStatusSet: false, // once true, the panel's tab-visibility auto-idle no longer overrides the badge
      _statusRevertTimer: null,
      _statusPollTimer: null,
      _statusPopover: null,
      _statusCloseHandlers: null,
      _durationPopover: null,
      _durationStatus: null,

      isInvisible: function isInvisible() {
        return this._status === "invisible";
      },

      // The status the badge is actually showing: an explicit pick wins,
      // otherwise the tab-visibility auto-idle (see the panel's _updateStatus).
      getEffectiveStatus: function getEffectiveStatus() {
        if (this._explicitStatusSet && this._status) return this._status;
        return (typeof document !== "undefined" && document.hidden) ? "idle" : "online";
      },

      // True when the effective status came from a real pick (or the server
      // says so), false for the untouched default / tab-visibility auto-idle.
      // Published next to the status so a viewer can tell a deliberate
      // Invisible/DND pick apart from a stray default-online tab of the same
      // account.
      isStatusExplicit: function isStatusExplicit() {
        return !!(this._explicitStatusSet && this._status);
      },

      // Called from the panel's _paintBadge (every explicit pick, server
      // reconcile, auto-revert and auto-idle ends up there) so anything that
      // publishes presence elsewhere (ConstellationLounge's member list) can
      // follow along without depending on this module. Only fires on a real
      // change, since _paintBadge also runs on every panel update().
      _lastBroadcastKey: null,
      _broadcastStatus: function _broadcastStatus(status) {
        var key = status + "|" + (this.isStatusExplicit() ? "explicit" : "auto");
        if (key === this._lastBroadcastKey) return;
        this._lastBroadcastKey = key;
        if (typeof window !== "undefined" && typeof CustomEvent === "function") {
          window.dispatchEvent(new CustomEvent("lively-presence-status", { detail: { status: status } }));
        }
      },

      // Shared read/write-merge helpers for the "lively.identity.presenceState"
      // localStorage blob — shared with the panel's own mic/deafen/camera
      // prefs (_loadPersistedPrefs/_savePersistedPrefs), so every write here
      // merges rather than overwriting the whole key.
      _readPresenceState: function _readPresenceState() {
        try {
          var raw = localStorage.getItem("lively.identity.presenceState");
          return raw ? JSON.parse(raw) : {};
        } catch (e) { return {}; }
      },

      _writePresenceState: function _writePresenceState(patch) {
        try {
          var current = this._readPresenceState();
          Object.keys(patch).forEach(function (k) { current[k] = patch[k]; });
          localStorage.setItem("lively.identity.presenceState", JSON.stringify(current));
        } catch (e) {}
      },

      _saveStatusLocal: function _saveStatusLocal(status, expiresAt, explicit) {
        this._writePresenceState({ status: status, statusExpiresAt: expiresAt || null, statusExplicit: !!explicit });
      },

      _loadStatusLocal: function _loadStatusLocal() {
        var s = this._readPresenceState();
        if (!s.status) return null;
        return { status: s.status, expiresAt: s.statusExpiresAt || null, explicit: !!s.statusExplicit };
      },

      // Local-only: paints the badge, (re)arms the auto-revert timer. Never
      // talks to the server — used both right after a successful PUT
      // (_selectStatus) and when reconciling a GET response or a still-
      // valid cached localStorage copy (_loadStatus, the cross-tab storage
      // listener in init()).
      _applyStatus: function _applyStatus(status, expiresAt) {
        var self = this;
        this._status = status;
        this._statusExpiresAt = expiresAt || null;
        if (this._panel) this._panel._paintStatus(status);

        if (this._statusRevertTimer) { clearTimeout(this._statusRevertTimer); this._statusRevertTimer = null; }
        if (expiresAt) {
          var delay = new Date(expiresAt).getTime() - Date.now();
          this._statusRevertTimer = setTimeout(function () {
            // Auto-revert is a return to the untouched default, not a fresh
            // explicit pick — tab-visibility auto-idle resumes working.
            self._explicitStatusSet = false;
            self._applyStatus("online", null);
            self._saveStatusLocal("online", null, false);
            // Best-effort push so other tabs/devices don't have to wait for
            // their own poll cycle (or the server's self-heal-on-read) to
            // notice this tab's timer already fired.
            if (lively.identity.did && lively.identity.did.isLoggedIn()) {
              var handle = lively.identity.did.currentUser().handle;
              fetch("/@" + handle + "/status", {
                method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: "online", duration: null }),
              }).catch(function () {});
            }
          }, Math.max(0, delay));
        }
      },

      // User picked a status from the popover: paint immediately with an
      // optimistic expiry estimate, then persist to the server (which
      // computes and returns the real expiresAt) and reconcile against that.
      _selectStatus: function _selectStatus(status, duration) {
        var self = this;
        this._explicitStatusSet = true;

        var optimisticExpiresAt = null;
        if (status !== "online" && duration && duration !== "forever" && this.DURATION_MS[duration]) {
          optimisticExpiresAt = new Date(Date.now() + this.DURATION_MS[duration]).toISOString();
        }
        this._applyStatus(status, optimisticExpiresAt);
        this._saveStatusLocal(status, optimisticExpiresAt, true);

        if (!lively.identity.did || !lively.identity.did.isLoggedIn()) return;
        var handle = lively.identity.did.currentUser().handle;
        fetch("/@" + handle + "/status", {
          method: "PUT", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: status, duration: duration || null }),
        })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (result) {
            if (!result) return;
            self._applyStatus(status, result.expiresAt);
            self._saveStatusLocal(status, result.expiresAt, true);
          })
          .catch(function () {});
      },

      // Boot-time load, called from the panel's onLoad before update(). Paints
      // synchronously from a still-valid cached copy first (avoids a network-
      // latency flash of stale status), then reconciles against the server —
      // authoritative and self-healing on an expired row, so no client-side
      // "is this expired" branch is needed for the common case.
      _loadStatus: function _loadStatus() {
        var self = this;
        var cached = this._loadStatusLocal();
        if (cached && (!cached.expiresAt || new Date(cached.expiresAt).getTime() > Date.now())) {
          this._explicitStatusSet = true;
          this._applyStatus(cached.status, cached.expiresAt);
        } else if (cached) {
          // Cached copy is itself expired — paint Online immediately rather
          // than waiting on the network for what the server will say anyway.
          this._explicitStatusSet = false;
          this._applyStatus("online", null);
        }

        if (!lively.identity.did || !lively.identity.did.isLoggedIn()) return;
        var handle = lively.identity.did.currentUser().handle;
        fetch("/@" + handle + "/status", { credentials: "include" })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (result) {
            if (!result) return;
            // A non-'online' server status is always explicit (it can only
            // exist because someone picked it). A plain 'online' response is
            // left non-explicit unless the local cache already knew it was
            // an explicit pick — the server alone can't tell "explicitly
            // re-picked Online" apart from "never touched the status menu",
            // so that one combination falls back to auto-idle rather than
            // staying pinned Online; every other case is unambiguous.
            var explicit = result.status !== "online" || !!(cached && cached.explicit);
            self._explicitStatusSet = explicit;
            self._applyStatus(result.status, result.expiresAt);
            self._saveStatusLocal(result.status, result.expiresAt, explicit);
          })
          .catch(function () {});

        this._startStatusPolling();
      },

      // Cross-device sync fallback (localStorage's 'storage' event in init()
      // only reaches other tabs of the same browser) and the mechanism that
      // catches an auto-revert on a tab that's been asleep past its own timer.
      _startStatusPolling: function _startStatusPolling() {
        var self = this;
        if (this._statusPollTimer) return;
        this._statusPollTimer = setInterval(function () {
          if (!lively.identity.did || !lively.identity.did.isLoggedIn()) return;
          var handle = lively.identity.did.currentUser().handle;
          fetch("/@" + handle + "/status", { credentials: "include" })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (result) {
              if (!result) return;
              var explicit = result.status !== "online" || self._explicitStatusSet;
              self._explicitStatusSet = explicit;
              self._applyStatus(result.status, result.expiresAt);
              self._saveStatusLocal(result.status, result.expiresAt, explicit);
            })
            .catch(function () {});
        }, 45000);
      },

      _toggleStatusMenu: function _toggleStatusMenu() {
        if (this._statusPopover) this._closeStatusMenu(); else this._openStatusMenu();
      },

      _openStatusMenu: function _openStatusMenu() {
        var self = this;
        var NS = lively.identity.AmbientPresencePanel;
        var panel = this._panel;
        if (this._statusPopover || !panel || !panel.world()) return;

        // W was 220 — too narrow once the subtext went from fontSize 7.25/
        // weight 400 to 8/600 (measured live: "You will not receive desktop
        // notifications" needs ~209px of content width at the new weight,
        // vs. ~154px this box actually had once the icon column and right
        // margin were subtracted — it was clipping mid-word). 280 leaves
        // real headroom rather than a bare minimum fit.
        var PAD = 6, ROW_H = 44, SIMPLE_ROW_H = 32, W = 280;
        var order = NS.STATUS_ORDER;
        var rowHeights = order.map(function (s) { return NS.STATUS_META[s].subtext ? ROW_H : SIMPLE_ROW_H; });
        var H = PAD * 2 + rowHeights.reduce(function (a, b) { return a + b; }, 0);

        var pos = panel.getPosition();
        var box = new lively.morphic.Box(lively.rect(pos.x, pos.y - H - 8, W, H));
        box.isEpiMorph = true;
        box.applyStyle({ fill: NS.PANEL_BG, borderRadius: 12, borderWidth: 3, borderColor: Color.rgb(232, 73, 126) });
        box.draggingEnabled = false; box.droppingEnabled = false; box.grabbingEnabled = false;
        box.name = "StatusPopover";

        var y = PAD;
        order.forEach(function (status, i) {
          var meta = NS.STATUS_META[status];
          var h = rowHeights[i];
          self._buildStatusRow(box, status, meta, W, y, h);
          y += h;
        });

        $world.addMorph(box);
        box.enableFixedPositioning();
        this._statusPopover = box;

        var onDown = function (e) {
          var node = box.renderContext().shapeNode;
          var hit = panel._statusHitArea && panel._statusHitArea.renderContext().shapeNode;
          var subNode = self._durationPopover && self._durationPopover.renderContext().shapeNode;
          if (node.contains(e.target) || (hit && hit.contains(e.target)) || (subNode && subNode.contains(e.target))) return;
          self._closeStatusMenu();
        };
        var onKey = function (e) { if (e.key === "Escape") self._closeStatusMenu(); };
        document.addEventListener("mousedown", onDown, true);
        document.addEventListener("keydown", onKey, true);
        this._statusCloseHandlers = { onDown: onDown, onKey: onKey };
      },

      _closeStatusMenu: function _closeStatusMenu() {
        this._closeDurationSubmenu();
        if (this._statusCloseHandlers) {
          document.removeEventListener("mousedown", this._statusCloseHandlers.onDown, true);
          document.removeEventListener("keydown", this._statusCloseHandlers.onKey, true);
          this._statusCloseHandlers = null;
        }
        if (this._statusPopover) { try { this._statusPopover.remove(); } catch (e) {} this._statusPopover = null; }
      },

      // One top-level row (Online/Idle/DND/Invisible): icon + label, an
      // optional gray subtext line (DND/Invisible), and a chevron for the
      // three that open a duration submenu. Online selects immediately.
      _buildStatusRow: function _buildStatusRow(box, status, meta, W, y, h) {
        var self = this;
        var NS = lively.identity.AmbientPresencePanel;
        var row = new lively.morphic.Box(lively.rect(0, y, W, h));
        row.applyStyle({ fill: null, borderWidth: 0, borderRadius: 8, handStyle: "pointer" });
        row.draggingEnabled = false; row.droppingEnabled = false; row.grabbingEnabled = false;
        box.addMorph(row);

        var iconColor = status === "dnd" ? NS.STATUS_DND
          : status === "invisible" ? NS.STATUS_INVISIBLE
          : status === "idle" ? NS.STATUS_IDLE : NS.STATUS_ONLINE;
        var icon = new lively.morphic.Text(lively.rect(10, (h - 20) / 2, 20, 20));
        icon.textString = meta.icon;
        icon.applyStyle({
          fontFamily: "'Material Symbols Rounded'", fontSize: 12, textColor: iconColor,
          fill: null, borderWidth: 0, align: "center",
          allowInput: false, selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre",
        });
        icon.eventsAreIgnored = true;
        row.addMorph(icon);

        var labelY = meta.subtext ? 6 : (h - 16) / 2;
        var label = new lively.morphic.Text(lively.rect(38, labelY, W - (status === "online" ? 50 : 66), 16));
        label.textString = meta.label;
        label.applyStyle({
          fontSize: 9, fontWeight: "600", textColor: NS.TEXT_PRIMARY, fill: null, borderWidth: 0,
          allowInput: false, selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre",
        });
        label.eventsAreIgnored = true;
        row.addMorph(label);

        if (meta.subtext) {
          // Wider than the label's box (which reserves room for the
          // chevron) — the chevron sits higher/further right (see below)
          // and doesn't overlap this line, so the subtext can run closer to
          // the popover's edge.
          var sub = new lively.morphic.Text(lively.rect(38, 23, W - 46, 16));
          sub.textString = meta.subtext;
          sub.applyStyle({
            fontSize: 8, fontWeight: "600", textColor: NS.TEXT_SECONDARY, fill: null, borderWidth: 0,
            allowInput: false, selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre",
          });
          sub.eventsAreIgnored = true;
          row.addMorph(sub);
        }

        if (status !== "online") {
          var chevron = new lively.morphic.Text(lively.rect(W - 26, (h - 16) / 2, 16, 16));
          chevron.textString = "chevron_right";
          chevron.applyStyle({
            fontFamily: "'Material Symbols Rounded'", fontSize: 9, textColor: NS.TEXT_SECONDARY,
            fill: null, borderWidth: 0, align: "center", allowInput: false, selectable: false,
            clipMode: "hidden", whiteSpaceHandling: "pre",
          });
          chevron.eventsAreIgnored = true;
          row.addMorph(chevron);
        }

        row.onMouseOver = function () {
          row.applyStyle({ fill: NS.HOVER_BG });
          if (status !== "online") self._openDurationSubmenu(row, status);
        };
        row.onMouseOut = function () { row.applyStyle({ fill: null }); };
        row.onMouseUp = function (evt) {
          if (status === "online") {
            self._selectStatus("online", null);
            self._closeStatusMenu();
          }
          evt.stop();
          return true;
        };
        return row;
      },

      // Flyout to the right of the hovered row, listing the 6 duration
      // choices. Positioned off the (fixed-positioned) parent popover's own
      // getPosition() plus the row's position within it — the same relative-
      // offset approach _showInRoomRow/Soundboard.js already use, so no
      // separate scroll-offset math is needed (this whole panel area is a
      // fixed-positioned HUD, not part of scrolling page content).
      _openDurationSubmenu: function _openDurationSubmenu(parentRow, status) {
        var self = this;
        var NS = lively.identity.AmbientPresencePanel;
        if (this._durationStatus === status && this._durationPopover) return;
        this._closeDurationSubmenu();

        var box = this._statusPopover;
        if (!box) return;
        var boxPos = box.getPosition();
        var rowPos = parentRow.getPosition();

        var PAD = 6, ROW_H = 28, W = 160;
        var options = NS.DURATION_OPTIONS;
        var H = PAD * 2 + options.length * ROW_H;
        // Opens to the LEFT of the main popover, not the right — the panel
        // (and this popover) is anchored near the screen's right edge, so a
        // rightward flyout had nowhere to render (confirmed: ran off the
        // viewport).
        var x = boxPos.x - W - 8;
        var y = boxPos.y + rowPos.y;

        var sub = new lively.morphic.Box(lively.rect(x, y, W, H));
        sub.isEpiMorph = true;
        sub.applyStyle({ fill: NS.PANEL_BG, borderRadius: 12, borderWidth: 3, borderColor: Color.rgb(232, 73, 126) });
        sub.draggingEnabled = false; sub.droppingEnabled = false; sub.grabbingEnabled = false;
        sub.name = "StatusDurationPopover";

        options.forEach(function (opt, i) {
          var optRow = new lively.morphic.Text(lively.rect(PAD, PAD + i * ROW_H, W - PAD * 2, ROW_H));
          optRow.textString = opt.label;
          optRow.applyStyle({
            fontSize: 9, fontWeight: "500", textColor: NS.TEXT_PRIMARY, fill: null,
            borderWidth: 0, borderRadius: 6, align: "left",
            padding: lively.Rectangle.inset(8, 6, 0, 0),
            allowInput: false, selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre",
            handStyle: "pointer",
          });
          optRow.draggingEnabled = false; optRow.droppingEnabled = false; optRow.grabbingEnabled = false;
          optRow.onMouseOver = function () { optRow.applyStyle({ fill: NS.HOVER_BG }); };
          optRow.onMouseOut = function () { optRow.applyStyle({ fill: null }); };
          optRow.onMouseUp = function (evt) {
            self._selectStatus(status, opt.key);
            self._closeStatusMenu();
            evt.stop();
            return true;
          };
          sub.addMorph(optRow);
        });

        $world.addMorph(sub);
        sub.enableFixedPositioning();
        this._durationPopover = sub;
        this._durationStatus = status;
      },

      _closeDurationSubmenu: function _closeDurationSubmenu() {
        if (this._durationPopover) { try { this._durationPopover.remove(); } catch (e) {} this._durationPopover = null; }
        this._durationStatus = null;
      },
    });

  }); // end module('lively.identity.AmbientPresencePanel')
