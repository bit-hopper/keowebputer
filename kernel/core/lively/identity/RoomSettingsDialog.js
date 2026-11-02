/**
 * lively.identity.RoomSettingsDialog
 *
 * Per-room settings — rename, room type (video/voice toggle chips, same
 * idiom and semantics as NewRoomDialog.js's own creation-time toggles),
 * active-participants nickname (room.activity, also collected at creation
 * by NewRoomDialog.js — this is the only place it can be edited afterward),
 * header image (banner shown on the room card and in RoomView's header,
 * supports animated GIFs), access (open vs request-to-join), pin (global —
 * affects room order for every viewer), archive (reversible, the
 * recommended destructive action), and permanent delete (irreversible, a
 * secondary action behind a second confirmation).
 * Opened from the settings gear on a room card (ConstellationLounge.js's
 * _renderRoomCard) or from RoomView.js's own header gear — both gated
 * client-side on room.canManage and re-checked server-side on every write
 * route (IdentityServer.js's canManageRoom: the room's creator, or any
 * constellation controller).
 *
 * Deliberately modeled on ConstellationSettingsDialog.js's window chrome
 * and styledButton token palette rather than inventing a new look — see
 * that file for the constellation-level equivalent of this dialog.
 *
 * Header image upload deliberately bypasses lively.identity.imageCropper
 * (used by the avatar/banner fields above): ImageCropper always canvas-
 * flattens the result (out.toBlob), which silently strips animation from
 * an uploaded GIF. This dialog instead calls
 * lively.identity.fileCrypto.encryptAndUpload directly on the raw File, so
 * the original bytes (and its mime type) reach BlobStore unmodified —
 * lively.morphic.Image renders through a real <img> node, which animates
 * a GIF natively once its src is set.
 *
 * Open: lively.identity.RoomSettingsDialog.open(constellationName, room, onDone)
 *   onDone(result) is called after Save ({saved:true}), Archive
 *   ({archived:true}), or permanent Delete ({deleted:true}) — the caller
 *   uses this to tell a save-in-place from a "this room is gone now" case.
 */

module("lively.identity.RoomSettingsDialog")
  .requires(
    "lively.identity.DID",
    "lively.identity.FileCrypto",
    "lively.identity.RoomCrypto",
    "lively.persistence.BuildSpec",
    "lively.morphic.Complete",
  )
  .toRun(function () {

    lively.BuildSpec("lively.identity.RoomSettingsDialog", {
      _BorderRadius: 7,
      _Extent: lively.pt(580, 800),
      _Fill: Color.rgb(251, 86, 213),
      className: "lively.morphic.Window",
      contentOffset: lively.pt(3, 22),
      draggingEnabled: true,
      droppingEnabled: false,
      layout: { adjustForNewBounds: true },
      name: "RoomSettingsDialog",
      titleBar: "Cluster Settings",
      submorphs: [
        {
          _BorderColor: Color.rgb(95, 94, 95),
          _BorderRadius: 4,
          _BorderWidth: 1,
          _Extent: lively.pt(574, 775),
          _Fill: Color.rgb(243, 243, 243),
          _Position: lively.pt(3, 22),
          className: "lively.morphic.Box",
          clipMode: "auto",
          layout: { adjustForNewBounds: true, resizeWidth: true, resizeHeight: true },
          name: "settingsContent",
          submorphs: [],
        },
      ],

      connectionRebuilder: function connectionRebuilder() {
        lively.bindings.connect(this, "remove", this, "onRemove", {});
      },

      // ─── lifecycle ────────────────────────────────────────────────────────

      onFromBuildSpecCreated: function onFromBuildSpecCreated() {
        $super();
        this._constellationName = null;
        this._roomId = null;
        this._roomName = "";
        this._access = "open";
        this._pinned = false;
        this._isVideo = false;
        this._isVoice = false;
        this._activity = "";
        this._ephemeral = false;
        this._e2eeEnabled = false;
        this._e2eeRotationPending = false;
        this._onDone = function () {};
      },

      onRemove: function onRemove() {},

      load: function load(constellationName, room, onDone) {
        this._constellationName = constellationName;
        this._roomId = room.id;
        this._roomName = room.name || "";
        this._headerUrl = room.headerUrl || "";
        this._access = room.access === "request" ? "request" : "open";
        this._pinned = !!room.pinned;
        this._isVideo = !!room.isVideo;
        this._isVoice = !!room.isVoice;
        this._activity = room.activity || "";
        this._ephemeral = !!room.ephemeral;
        this._e2eeEnabled = !!room.e2eeEnabled;
        this._e2eeRotationPending = !!room.e2eeRotationPending;
        this._onDone = onDone || function () {};
        this.setTitle("Cluster Settings — " + this._roomName);
        this._render();
      },

      // ─── render ─────────────────────────────────────────────────────────────

      _render: function _render() {
        var self = this;
        var content = this.get("settingsContent");
        content.removeAllMorphs();
        var MARGIN = 18;
        var ew = 538;
        var BTN_W = 96;
        var GAP = 10;
        var inputW = ew - BTN_W - GAP;
        var y = 18;

        function sectionLabel(str) {
          var lbl = new lively.morphic.Text(lively.rect(MARGIN, y, ew, 16), str);
          lbl.applyStyle({ allowInput: false, fontSize: 12, fontWeight: "bold",
            textColor: Color.rgb(80, 80, 80),
            fill: null, borderWidth: 0 });
          content.addMorph(lbl);
          y += 22;
        }

        function fieldLabel(str) {
          var lbl = new lively.morphic.Text(lively.rect(MARGIN, y, ew, 14), str);
          lbl.applyStyle({ allowInput: false, fontSize: 10,
            textColor: Color.rgb(140, 140, 140),
            fill: null, borderWidth: 0 });
          content.addMorph(lbl);
          y += 17;
        }

        // Same three-variant palette as ConstellationSettingsDialog.js's
        // own styledButton — kept in sync deliberately rather than shared,
        // since each BuildSpec method is reconstructed from its own
        // source text at runtime (no cross-file closure to share it via).
        function styledButton(rect, label, variant) {
          var palette = {
            "default": { fill: Color.rgb(247, 247, 250), hoverFill: Color.rgb(236, 236, 243),
              border: Color.rgb(223, 223, 233), text: Color.rgb(70, 70, 80) },
            "success": { fill: Color.rgb(233, 250, 237), hoverFill: Color.rgb(217, 245, 223),
              border: Color.rgb(179, 224, 191), text: Color.rgb(20, 120, 60) },
            "danger": { fill: Color.rgb(253, 238, 240), hoverFill: Color.rgb(250, 223, 227),
              border: Color.rgb(240, 200, 206), text: Color.rgb(180, 40, 60) },
          }[variant || "default"];
          var btn = new lively.morphic.Button(rect, label);
          btn.applyStyle({ fill: palette.fill,
            borderColor: palette.border, borderRadius: 8,
            fontSize: 11, textColor: palette.text, borderWidth: 1 });
          btn.setAppearanceStylingMode(false);
          btn.setBorderStylingMode(false);
          btn.onMouseOver = function () { btn.applyStyle({ fill: palette.hoverFill }); };
          btn.onMouseOut = function () { btn.applyStyle({ fill: palette.fill }); };
          return btn;
        }

        // Same clip/fixed-extent idiom as ConstellationSettingsDialog.js's
        // textField (beInputLine() resets style, so applyStyle runs after
        // it and the extent is re-asserted a second time).
        function textField(name, value) {
          var inp = new lively.morphic.Text(lively.rect(MARGIN, y, inputW, 28), value || "");
          inp.name = name;
          inp.beInputLine();
          inp.applyStyle({ allowInput: true, fontSize: 12, clipMode: "hidden",
            fixedWidth: true, fixedHeight: true, whiteSpaceHandling: "pre",
            fill: Color.rgb(252, 252, 252),
            borderColor: Color.rgb(200, 200, 200), borderWidth: 1, borderRadius: 4 });
          inp.setExtent(lively.pt(inputW, 28));
          content.addMorph(inp);
          return inp;
        }

        function divider() {
          y += 8;
          var line = new lively.morphic.Box(lively.rect(MARGIN, y, ew, 1));
          line.applyStyle({ fill: Color.rgb(228, 228, 228), borderWidth: 0 });
          content.addMorph(line);
          y += 20;
        }

        // Icon+label toggle chip (Video/Voice below) -- same visual idiom
        // (colors, sizes) as NewRoomDialog.js's paintToggle/VideoToggleChip/
        // VoiceToggleChip, so a room's type reads identically whether it's
        // being set at creation or edited here. Two independent chips, not
        // a radio group -- a room can be video, voice, both, or neither
        // (plain text room), matching NewRoomDialog's own semantics.
        function iconChip(x, glyph, label, isOn, onToggle) {
          var selectedFill = Color.rgb(224, 227, 254), selectedBorder = Color.rgb(88, 101, 242);
          var normalFill = Color.rgb(243, 243, 243), normalBorder = Color.rgb(180, 180, 180);
          var selectedText = Color.rgb(72, 82, 224), normalText = Color.rgb(120, 120, 120);
          var chip = new lively.morphic.Box(lively.rect(x, y, 84, 32));
          chip.applyStyle({
            fill: isOn ? selectedFill : normalFill,
            borderColor: isOn ? selectedBorder : normalBorder,
            borderWidth: 1, borderRadius: 16,
          });
          // allowInput/selectable MUST be false here -- confirmed live:
          // without them Lively renders the span in a per-character
          // selectable mode (a "visibleSelection"-classed parent), which
          // silently breaks the Material Symbols ligature substitution --
          // "videocam"/"headset" rendered as ~126px/90px of literal
          // fallback text instead of a ~16px glyph, despite fontFamily
          // being computed correctly. Every OTHER working icon-glyph
          // morph in this codebase (gear buttons, card type-icon chips)
          // already sets these two; this one just needs to match.
          // clipMode "visible": the glyph's line box (~22px at this size)
          // is taller than the 18px box, so "hidden" sliced off its bottom
          // (confirmed live -- NewRoomDialog's same-size icons don't clip).
          var icon = new lively.morphic.Text(lively.rect(10, 3, 18, 18), glyph);
          icon.applyStyle({ fontFamily: "'Material Symbols Rounded'", fontSize: 13.5,
            textColor: isOn ? selectedText : normalText, borderWidth: 0,
            allowInput: false, selectable: false, clipMode: "visible", fill: null });
          icon.eventsAreIgnored = true;
          chip.addMorph(icon);
          var lbl = new lively.morphic.Text(lively.rect(30, 5, 48, 16), label);
          lbl.applyStyle({ fontFamily: "Helvetica", fontSize: 12,
            textColor: isOn ? selectedText : normalText, borderWidth: 0,
            allowInput: false, selectable: false, clipMode: "visible", fill: null });
          lbl.eventsAreIgnored = true;
          chip.addMorph(lbl);
          chip.onMouseDown = function (evt) { onToggle(); evt.stop(); return true; };
          content.addMorph(chip);
          return chip;
        }

        // ── Name ────────────────────────────────────────────────────────────
        sectionLabel("Name");
        textField("rsdName", this._roomName);
        y += 28;
        divider();

        // ── Room Type ───────────────────────────────────────────────────────
        sectionLabel("Cluster Type (optional)");
        iconChip(MARGIN, "videocam", "Video", this._isVideo, function () { self._toggleVideo(); });
        iconChip(MARGIN + 94, "headset", "Voice", this._isVoice, function () { self._toggleVoice(); });
        // Chat is derived, not stored: lit exactly when neither video nor
        // voice is on (a text-only room); clicking it clears both.
        iconChip(MARGIN + 188, "chat", "Chat", !this._isVideo && !this._isVoice, function () { self._selectChatOnly(); });
        y += 32;
        fieldLabel("Chat is a plain text cluster (neither video nor voice). Video always includes voice.");
        divider();

        // ── Active Participants Nickname ──────────────────────────────────
        // Shown on the room card as "· <activity>" once set
        // (ConstellationLounge.js's _renderRoomCard, room.activity) -- same
        // field NewRoomDialog.js collects at creation, editable here too.
        sectionLabel("Active Participants Nickname (optional)");
        textField("rsdActivity", this._activity);
        y += 28;
        divider();

        // ── Header image ───────────────────────────────────────────────────
        sectionLabel("Header image");
        fieldLabel("Shown at the top of the cluster card — try uploading a GIF!");
        textField("rsdHeaderUrl", this._headerUrl);
        var upBtn = styledButton(lively.rect(MARGIN + inputW + GAP, y, BTN_W, 28), "Upload…");
        upBtn._fieldName = "rsdHeaderUrl";
        upBtn.addScript(function doAction() {
          var win = this.owner && this.owner.owner;
          if (!win) return;
          var fieldName = this._fieldName;
          var input = document.createElement("input");
          input.type = "file";
          input.accept = "image/*";
          input.style.display = "none";
          document.body.appendChild(input);
          input.addEventListener("change", function () {
            var file = input.files && input.files[0];
            document.body.removeChild(input);
            if (!file) return;
            var pane = win.get("settingsContent");
            var inp = pane && pane.get(fieldName);
            if (inp) inp.textString = "Uploading…";
            var extMatch = file.name && file.name.match(/\.[a-zA-Z0-9]+$/);
            var ext = extMatch ? extMatch[0] : ".png";
            // Raw file, not a cropped/re-encoded canvas blob -- preserves
            // GIF animation (and any other image bytes) exactly as
            // uploaded. See this file's own header comment for why this
            // deliberately skips lively.identity.imageCropper.
            lively.identity.fileCrypto.encryptAndUpload(file, {
              visibility: "public",
              name: "room-header-" + Date.now() + ext,
            }, function (err, result) {
              var pane2 = win.get("settingsContent");
              var inp2 = pane2 && pane2.get(fieldName);
              if (err) {
                alert("Could not upload header image: " + err.message);
                if (inp2) inp2.textString = "";
                return;
              }
              if (inp2) inp2.textString = result.url;
            });
          });
          input.click();
        });
        lively.bindings.connect(upBtn, "fire", upBtn, "doAction");
        content.addMorph(upBtn);
        y += 28;
        y += 6;
        var clearBtn = styledButton(lively.rect(MARGIN, y, 130, 22), "Remove image");
        clearBtn._fieldName = "rsdHeaderUrl";
        clearBtn.addScript(function doAction() {
          var win = this.owner && this.owner.owner;
          if (!win) return;
          var pane = win.get("settingsContent");
          var inp = pane && pane.get(this._fieldName);
          if (inp) inp.textString = "";
        });
        lively.bindings.connect(clearBtn, "fire", clearBtn, "doAction");
        content.addMorph(clearBtn);
        y += 22;
        divider();

        // ── Access ──────────────────────────────────────────────────────────
        sectionLabel("Access");
        var openBtn = styledButton(lively.rect(MARGIN, y, 170, 30), "Open to all members",
          this._access === "open" ? "success" : "default");
        openBtn.addScript(function doAction() {
          var win = this.owner && this.owner.owner;
          if (win) win._setAccess("open");
        });
        lively.bindings.connect(openBtn, "fire", openBtn, "doAction");
        content.addMorph(openBtn);
        var reqBtn = styledButton(lively.rect(MARGIN + 180, y, 170, 30), "Request to join",
          this._access === "request" ? "success" : "default");
        reqBtn.addScript(function doAction() {
          var win = this.owner && this.owner.owner;
          if (win) win._setAccess("request");
        });
        lively.bindings.connect(reqBtn, "fire", reqBtn, "doAction");
        content.addMorph(reqBtn);
        y += 30;
        fieldLabel(this._access === "open"
          ? "Any constellation member can join by clicking the cluster."
          : "Members must be approved by a controller before joining.");
        divider();

        // ── Message retention ───────────────────────────────────────────────
        sectionLabel("Message retention");
        var persistentBtn = styledButton(lively.rect(MARGIN, y, 200, 30), "Persistent",
          !this._ephemeral ? "success" : "default");
        persistentBtn.addScript(function doAction() {
          var win = this.owner && this.owner.owner;
          if (win) win._setRetention(false);
        });
        lively.bindings.connect(persistentBtn, "fire", persistentBtn, "doAction");
        content.addMorph(persistentBtn);
        var ephemeralBtn = styledButton(lively.rect(MARGIN + 210, y, 200, 30), "Ephemeral",
          this._ephemeral ? "success" : "default");
        ephemeralBtn.addScript(function doAction() {
          var win = this.owner && this.owner.owner;
          if (win) win._setRetention(true);
        });
        lively.bindings.connect(ephemeralBtn, "fire", ephemeralBtn, "doAction");
        content.addMorph(ephemeralBtn);
        y += 30;
        fieldLabel(this._ephemeral
          ? "Messages aren't saved. Joining shows nothing sent before you joined, and the chat disappears once everyone leaves."
          : "Messages are saved and searchable — the normal cluster chat history.");
        divider();

        // ── Encryption (read-only — set at creation, e2eeclusters.md §9) ────
        sectionLabel("Encryption");
        if (this._e2eeEnabled) {
          fieldLabel("End-to-end encrypted. Set at creation — can't be changed here.");
          if (this._e2eeRotationPending) {
            var warnLbl = new lively.morphic.Text(lively.rect(MARGIN, y, ew, 16),
              "Key rotation pending — sending is blocked in this cluster until it completes.");
            warnLbl.applyStyle({ allowInput: false, fontSize: 11, fontWeight: "bold",
              textColor: Color.rgb(180, 40, 60), fill: null, borderWidth: 0 });
            content.addMorph(warnLbl);
            y += 20;
            var retryBtn = styledButton(lively.rect(MARGIN, y, 140, 26), "Retry rotation", "danger");
            retryBtn.addScript(function doAction() {
              var win = this.owner && this.owner.owner;
              if (win) win._retryE2eeRotation(this);
            });
            lively.bindings.connect(retryBtn, "fire", retryBtn, "doAction");
            content.addMorph(retryBtn);
            y += 32;
          } else {
            fieldLabel("Key rotation is up to date.");
          }
        } else {
          fieldLabel("Standard — the server can read message content. Set at creation, can't be changed here.");
        }
        divider();

        // ── Pin ─────────────────────────────────────────────────────────────
        sectionLabel("Pin this cluster");
        var CHK = 20;
        var chk = new lively.morphic.Box(lively.rect(MARGIN, y, CHK, CHK));
        chk.applyStyle({
          fill: this._pinned ? Color.rgb(20, 120, 60) : Color.rgb(252, 252, 252),
          borderColor: this._pinned ? Color.rgb(20, 120, 60) : Color.rgb(200, 200, 200),
          borderWidth: 1, borderRadius: 4,
        });
        chk.onMouseDown = function () { self._togglePinned(); };
        chk.renderContext().shapeNode.style.cursor = "pointer";
        content.addMorph(chk);
        var pinLbl = new lively.morphic.Text(lively.rect(MARGIN + CHK + 8, y, ew - CHK - 8, 20),
          "Pinned clusters show first for everyone in this constellation.");
        pinLbl.applyStyle({ allowInput: false, fontSize: 11.5, clipMode: "hidden",
          textColor: Color.rgb(70, 70, 70), fill: null, borderWidth: 0 });
        pinLbl.onMouseDown = function () { self._togglePinned(); };
        pinLbl.renderContext().shapeNode.style.cursor = "pointer";
        content.addMorph(pinLbl);
        y += CHK + 8;
        divider();

        // ── Danger zone ─────────────────────────────────────────────────────
        sectionLabel("Danger zone");
        var archiveBtn = styledButton(lively.rect(MARGIN, y, 160, 30), "Archive Cluster", "danger");
        archiveBtn.addScript(function doAction() {
          var win = this.owner && this.owner.owner;
          if (win) win._archive(this);
        });
        lively.bindings.connect(archiveBtn, "fire", archiveBtn, "doAction");
        content.addMorph(archiveBtn);
        y += 30;
        fieldLabel("Removes this cluster from the list. Nothing is deleted — it can be restored later.");
        y += 4;
        var deleteBtn = styledButton(lively.rect(MARGIN, y, 220, 24), "Permanently delete instead", "danger");
        deleteBtn.addScript(function doAction() {
          var win = this.owner && this.owner.owner;
          if (win) win._deleteRoom(this);
        });
        lively.bindings.connect(deleteBtn, "fire", deleteBtn, "doAction");
        content.addMorph(deleteBtn);
        y += 32;
        divider();

        // ── Save ─────────────────────────────────────────────────────────────
        var saveBtn = styledButton(lively.rect(MARGIN + ew - BTN_W, y, BTN_W, 30), "Save", "success");
        saveBtn.addScript(function doAction() {
          var win = this.owner && this.owner.owner;
          if (win) win._save(this);
        });
        lively.bindings.connect(saveBtn, "fire", saveBtn, "doAction");
        content.addMorph(saveBtn);
        y += 30;
      },

      // ─── state (spec-level methods, only ever reference this.* — see the
      // BuildSpec-closure-loss gotcha) ─────────────────────────────────────

      // Access/Pin are toggle buttons, not their own input widgets, so
      // they go through a full _render() to reflect the new selection —
      // but rsdName/rsdHeaderUrl are only ever read back into this.* at
      // Save time (matching ConstellationSettingsDialog.js's own textField
      // convention). Confirmed live: without this capture step, uploading
      // a header image and then toggling Pin silently discarded the
      // just-uploaded URL, because _render() reseeds a fresh rsdHeaderUrl
      // field from this._headerUrl's stale (pre-upload) value. Called
      // before every _render() triggered by a toggle, so any in-progress
      // Name/Header edit survives the rebuild.
      _captureFieldEdits: function _captureFieldEdits() {
        var content = this.get("settingsContent");
        var nameField = content.get("rsdName");
        var headerField = content.get("rsdHeaderUrl");
        var activityField = content.get("rsdActivity");
        if (nameField) this._roomName = nameField.textString;
        if (headerField) this._headerUrl = headerField.textString;
        if (activityField) this._activity = activityField.textString;
      },

      _setAccess: function _setAccess(access) {
        this._captureFieldEdits();
        this._access = access;
        this._render();
      },

      _setRetention: function _setRetention(ephemeral) {
        this._captureFieldEdits();
        this._ephemeral = ephemeral;
        this._render();
      },

      _togglePinned: function _togglePinned() {
        this._captureFieldEdits();
        this._pinned = !this._pinned;
        this._render();
      },

      _toggleVideo: function _toggleVideo() {
        this._captureFieldEdits();
        this._isVideo = !this._isVideo;
        // A video room always carries audio, so turning video on turns voice on.
        if (this._isVideo) this._isVoice = true;
        this._render();
      },

      _selectChatOnly: function _selectChatOnly() {
        this._captureFieldEdits();
        this._isVideo = false;
        this._isVoice = false;
        this._render();
      },

      _toggleVoice: function _toggleVoice() {
        this._captureFieldEdits();
        this._isVoice = !this._isVoice;
        // ...and turning voice off can't leave video on without audio.
        if (!this._isVoice) this._isVideo = false;
        this._render();
      },

      // ─── actions ────────────────────────────────────────────────────────────

      // Manual retry for a stuck e2ee_rotation_pending flag (e2eeclusters.md
      // §9.1/§9.3) — RoomCrypto.ensureEpoch covers both "no epoch minted
      // yet" (a brand-new room whose creation-time mint failed) and
      // "mid-life rotation" cases in one call, so this doesn't need to
      // know which applies. A full _render() on success/failure keeps this
      // in sync with the rest of the dialog's own re-render-on-change idiom.
      _retryE2eeRotation: function _retryE2eeRotation(btn) {
        var self = this;
        btn.setLabel("Retrying…");
        btn.setActive(false);
        lively.identity.roomCrypto.ensureEpoch({
          constellationName: self._constellationName, roomId: self._roomId,
        }, function (err) {
          if (err) {
            alert("Could not complete key rotation: " + err.message);
            btn.setLabel("Retry rotation");
            btn.setActive(true);
            return;
          }
          self._e2eeRotationPending = false;
          self._render();
        });
      },

      _save: function _save(btn) {
        var self = this;
        var content = this.get("settingsContent");
        var nameField = content.get("rsdName");
        var headerField = content.get("rsdHeaderUrl");
        var activityField = content.get("rsdActivity");
        var name = ((nameField && nameField.textString) || "").trim();
        var headerUrl = ((headerField && headerField.textString) || "").trim();
        var activity = ((activityField && activityField.textString) || "").trim();
        if (!name) { alert("Cluster name can't be empty."); return; }
        btn.setLabel("Saving…");
        btn.setActive(false);
        var base = lively.identity.did.baseUrl();
        fetch(base + "/c/" + encodeURIComponent(this._constellationName) + "/rooms/" + this._roomId, {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name, access: this._access, headerUrl: headerUrl || null, pinned: this._pinned,
            isVideo: this._isVideo, isVoice: this._isVoice, activity: activity || null,
            ephemeral: this._ephemeral,
          }),
        })
          .then(function (res) {
            return res.json().then(function (body) {
              if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
              return body;
            });
          })
          .then(function () {
            self._onDone({ saved: true });
            self.remove();
          })
          .catch(function (err) {
            alert("Could not save cluster settings: " + err.message);
            btn.setLabel("Save");
            btn.setActive(true);
          });
      },

      // Reversible: the room stops listing but its row (and message
      // history, which lives elsewhere as postcards) is untouched.
      _archive: function _archive(btn) {
        var self = this;
        $world.confirm(
          "Archive \"" + this._roomName + "\"? It'll disappear from the cluster list, but nothing is deleted.",
          function (ok) {
            if (!ok) return;
            btn.setLabel("Archiving…");
            btn.setActive(false);
            var base = lively.identity.did.baseUrl();
            fetch(base + "/c/" + encodeURIComponent(self._constellationName) + "/rooms/" + self._roomId + "/archive", {
              method: "POST",
              credentials: "include",
            })
              .then(function (res) {
                return res.json().then(function (body) {
                  if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
                  return body;
                });
              })
              .then(function () {
                self._onDone({ archived: true });
                self.remove();
              })
              .catch(function (err) {
                alert("Could not archive cluster: " + err.message);
                btn.setLabel("Archive Cluster");
                btn.setActive(true);
              });
          }
        );
      },

      // Irreversible -- deliberately harder to reach than Archive: a
      // second, stronger confirmation on top of the first.
      _deleteRoom: function _deleteRoom(btn) {
        var self = this;
        $world.confirm(
          "Permanently delete \"" + this._roomName + "\"? This cannot be undone.",
          function (ok) {
            if (!ok) return;
            $world.confirm(
              "Are you absolutely sure? There's no undo for this.",
              function (ok2) {
                if (!ok2) return;
                btn.setLabel("Deleting…");
                btn.setActive(false);
                var base = lively.identity.did.baseUrl();
                fetch(base + "/c/" + encodeURIComponent(self._constellationName) + "/rooms/" + self._roomId, {
                  method: "DELETE",
                  credentials: "include",
                })
                  .then(function (res) {
                    return res.json().then(function (body) {
                      if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
                      return body;
                    });
                  })
                  .then(function () {
                    self._onDone({ deleted: true });
                    self.remove();
                  })
                  .catch(function (err) {
                    alert("Could not delete cluster: " + err.message);
                    btn.setLabel("Permanently delete instead");
                    btn.setActive(true);
                  });
              }
            );
          }
        );
      },
    });

    lively.identity.RoomSettingsDialog = {
      open: function (constellationName, room, onDone) {
        var win = lively.BuildSpec("lively.identity.RoomSettingsDialog").createMorph();
        win.openInWorldCenter();
        win.load(constellationName, room, onDone);
        return win;
      },
    };

  });
