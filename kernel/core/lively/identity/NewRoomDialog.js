/**
 * lively.identity.NewRoomDialog
 *
 * Small BuildSpec dialog collecting a name and voice/video toggles for a
 * new Spaces/rooms room (ConstellationLounge.js's Spaces panel). Styled
 * after lively.identity.NewWikiPageDialog / lively.morphic.tools.
 * PublishToInventoryDialog (same style tokens: border radii, Color.rgb(...)
 * values, padding, button styling) and opened the same way (world-tracked
 * singleton via lively.BuildSpec(...).createMorph() +
 * openInWorldCenter().comeForward()).
 *
 * The dialog itself never touches storage — it only collects and validates
 * { name, isVideo, isVoice, access, activity, ephemeral } and hands them to
 * the caller's onCreate callback, which POSTs to /c/:name/rooms (see
 * ConstellationLounge.js's _openNewRoom).
 *
 * The video/voice toggles are two independent chips (not a radio group,
 * unlike PublishToInventoryDialog's visibility buttons) — a room can be
 * marked as a camera room, a headset room, both, or neither (plain
 * text-only room, which the Chat chip shows as lit). Each chip pairs a Material Symbols glyph with a plain
 * text label as two separate Text morphs rather than one — CLAUDE.md's
 * icon-font-and-body-font-don't-share-a-baseline gotcha, accepted here
 * since there's enough visual separation (icon vs. label) that a slight
 * mismatch doesn't read as one broken unit, unlike the single-baseline
 * "+ Postcard"-style pill button elsewhere in this codebase.
 *
 * Access ("Open" / "Request to Join"), below the toggles, IS a real
 * 2-way radio group — same manual-radio idiom PublishToInventoryDialog's
 * Public/Private/Shared buttons use (each button's connectionRebuilder
 * fires into one selectAccess method with a converter supplying its own
 * value). 'open': any signed-in constellation member can join the room by
 * clicking its card. 'request': a member must request access; a
 * constellation controller approves/declines (mirrors the constellation's
 * own join-request flow, scoped to one room).
 *
 * The "Active Participants Nickname" field, below the toggles, is a plain
 * free-text input line (same shape as NameText) — the creator types their
 * own optional nickname/category (e.g. "Jamming", "Reading") describing
 * what active participants are doing, rather than picking from a preset
 * list. This becomes room.activity server-side and shows on the room card
 * as "· <activity>" (ConstellationLounge.js's _renderRoomCard already
 * renders this field — it just had no way to be set before this dialog
 * collected it).
 */

module('lively.identity.NewRoomDialog')
  .requires('lively.persistence.BuildSpec', 'lively.identity.DID', 'lively.identity.UserSpace')
  .toRun(function () {

    lively.BuildSpec('lively.identity.NewRoomDialog', {
      _BorderRadius: 7,
      _Extent: lively.pt(380.0, 460.0),
      _Fill: Color.rgb(88, 101, 242),
      className: 'lively.morphic.Window',
      name: 'NewRoomDialog',
      sourceModule: 'lively.identity.NewRoomDialog',
      contentOffset: lively.pt(3.0, 22.0),
      draggingEnabled: true,
      layout: { adjustForNewBounds: true },
      minExtent: lively.pt(380.0, 460.0),
      submorphs: [{
        _BorderColor: Color.rgb(95, 94, 95),
        _BorderRadius: 4,
        _Extent: lively.pt(374.0, 432.0),
        _Fill: Color.rgb(243, 243, 243),
        _Position: lively.pt(3.0, 23.0),
        className: 'lively.morphic.Box',
        doNotCopyProperties: [],
        doNotSerialize: [],
        layout: { adjustForNewBounds: true, resizeWidth: true },
        name: 'NewRoomDialogPane',
        sourceModule: 'lively.morphic.Core',
        submorphs: [{
          _Extent: lively.pt(100.0, 16.0),
          _FontFamily: 'Arial, sans-serif',
          _FontSize: 11,
          _Padding: lively.rect(4, 3, 0, 0),
          _Position: lively.pt(10.0, 8.0),
          _InputAllowed: false,
          allowInput: false,
          className: 'lively.morphic.Text',
          droppingEnabled: false,
          fixedWidth: true,
          grabbingEnabled: false,
          name: 'NameLabel',
          sourceModule: 'lively.morphic.TextCore',
          submorphs: [],
          textString: 'Cluster Name',
        }, {
          _BorderColor: Color.rgb(203, 203, 203),
          _BorderRadius: 3.75,
          _BorderWidth: 1,
          _ClipMode: 'hidden',
          _Extent: lively.pt(354.0, 22.0),
          _Fill: Color.rgb(255, 255, 255),
          _FontFamily: 'Helvetica',
          _Padding: lively.rect(4, 4, 0, 0),
          _Position: lively.pt(10.0, 30.0),
          allowInput: true,
          className: 'lively.morphic.Text',
          doNotSerialize: ['charsTyped'],
          evalEnabled: false,
          fixedHeight: true,
          fixedWidth: true,
          isInputLine: true,
          layout: { resizeWidth: true },
          name: 'NameText',
          sourceModule: 'lively.morphic.TextCore',
          submorphs: [],
          textString: '',
        }, {
          _Extent: lively.pt(200.0, 16.0),
          _FontFamily: 'Arial, sans-serif',
          _FontSize: 11,
          _Padding: lively.rect(4, 3, 0, 0),
          _Position: lively.pt(10.0, 64.0),
          _InputAllowed: false,
          allowInput: false,
          className: 'lively.morphic.Text',
          droppingEnabled: false,
          fixedWidth: true,
          grabbingEnabled: false,
          name: 'ToggleLabel',
          sourceModule: 'lively.morphic.TextCore',
          submorphs: [],
          textString: 'Cluster Type (optional)',
        }, {
          // Camera/video chip -- toggles independently of the voice chip.
          _BorderColor: Color.rgb(180, 180, 180),
          _BorderRadius: 16,
          _BorderWidth: 1,
          _Extent: lively.pt(84.0, 32.0),
          _Fill: Color.rgb(243, 243, 243),
          _Position: lively.pt(10.0, 86.0),
          className: 'lively.morphic.Box',
          doNotCopyProperties: [],
          doNotSerialize: [],
          name: 'VideoToggleChip',
          sourceModule: 'lively.morphic.Core',
          submorphs: [{
            _Extent: lively.pt(18.0, 18.0),
            _Position: lively.pt(10.0, 5.0),
            _FontFamily: "'Material Symbols Rounded'",
            _FontSize: 13.5,
            className: 'lively.morphic.Text',
            eventsAreIgnored: true,
            fixedWidth: true,
            fixedHeight: true,
            name: 'VideoIcon',
            sourceModule: 'lively.morphic.TextCore',
            submorphs: [],
            textColor: Color.rgb(120, 120, 120),
            textString: 'videocam',
          }, {
            _Extent: lively.pt(48.0, 16.0),
            _Position: lively.pt(30.0, 7.0),
            _FontFamily: 'Helvetica',
            _FontSize: 12,
            className: 'lively.morphic.Text',
            eventsAreIgnored: true,
            fixedWidth: true,
            fixedHeight: true,
            name: 'VideoLabel',
            sourceModule: 'lively.morphic.TextCore',
            submorphs: [],
            textColor: Color.rgb(120, 120, 120),
            textString: 'Video',
          }],
          onMouseDown: function onMouseDown(evt) {
            this.owner.toggleVideo();
            evt.stop();
            return true;
          },
        }, {
          // Headset/voice chip -- toggles independently of the video chip.
          _BorderColor: Color.rgb(180, 180, 180),
          _BorderRadius: 16,
          _BorderWidth: 1,
          _Extent: lively.pt(84.0, 32.0),
          _Fill: Color.rgb(243, 243, 243),
          _Position: lively.pt(104.0, 86.0),
          className: 'lively.morphic.Box',
          doNotCopyProperties: [],
          doNotSerialize: [],
          name: 'VoiceToggleChip',
          sourceModule: 'lively.morphic.Core',
          submorphs: [{
            _Extent: lively.pt(18.0, 18.0),
            _Position: lively.pt(10.0, 5.0),
            _FontFamily: "'Material Symbols Rounded'",
            _FontSize: 13.5,
            className: 'lively.morphic.Text',
            eventsAreIgnored: true,
            fixedWidth: true,
            fixedHeight: true,
            name: 'VoiceIcon',
            sourceModule: 'lively.morphic.TextCore',
            submorphs: [],
            textColor: Color.rgb(120, 120, 120),
            textString: 'headset',
          }, {
            _Extent: lively.pt(48.0, 16.0),
            _Position: lively.pt(30.0, 7.0),
            _FontFamily: 'Helvetica',
            _FontSize: 12,
            className: 'lively.morphic.Text',
            eventsAreIgnored: true,
            fixedWidth: true,
            fixedHeight: true,
            name: 'VoiceLabel',
            sourceModule: 'lively.morphic.TextCore',
            submorphs: [],
            textColor: Color.rgb(120, 120, 120),
            textString: 'Voice',
          }],
          onMouseDown: function onMouseDown(evt) {
            this.owner.toggleVoice();
            evt.stop();
            return true;
          },
        }, {
          // Chat/text chip -- not an independent flag: it's lit exactly when
          // neither video nor voice is on (a text-only room), and clicking
          // it clears both.
          _BorderColor: Color.rgb(180, 180, 180),
          _BorderRadius: 16,
          _BorderWidth: 1,
          _Extent: lively.pt(84.0, 32.0),
          _Fill: Color.rgb(243, 243, 243),
          _Position: lively.pt(198.0, 86.0),
          className: 'lively.morphic.Box',
          doNotCopyProperties: [],
          doNotSerialize: [],
          name: 'ChatToggleChip',
          sourceModule: 'lively.morphic.Core',
          submorphs: [{
            _Extent: lively.pt(18.0, 18.0),
            _Position: lively.pt(10.0, 5.0),
            _FontFamily: "'Material Symbols Rounded'",
            _FontSize: 13.5,
            className: 'lively.morphic.Text',
            eventsAreIgnored: true,
            fixedWidth: true,
            fixedHeight: true,
            name: 'ChatIcon',
            sourceModule: 'lively.morphic.TextCore',
            submorphs: [],
            textColor: Color.rgb(120, 120, 120),
            textString: 'chat',
          }, {
            _Extent: lively.pt(48.0, 16.0),
            _Position: lively.pt(30.0, 7.0),
            _FontFamily: 'Helvetica',
            _FontSize: 12,
            className: 'lively.morphic.Text',
            eventsAreIgnored: true,
            fixedWidth: true,
            fixedHeight: true,
            name: 'ChatLabel',
            sourceModule: 'lively.morphic.TextCore',
            submorphs: [],
            textColor: Color.rgb(120, 120, 120),
            textString: 'Chat',
          }],
          onMouseDown: function onMouseDown(evt) {
            this.owner.selectChatOnly();
            evt.stop();
            return true;
          },
        }, {
          _Extent: lively.pt(300.0, 16.0),
          _FontFamily: 'Arial, sans-serif',
          _FontSize: 11,
          _Padding: lively.rect(4, 3, 0, 0),
          _Position: lively.pt(10.0, 126.0),
          _InputAllowed: false,
          allowInput: false,
          className: 'lively.morphic.Text',
          droppingEnabled: false,
          fixedWidth: true,
          grabbingEnabled: false,
          name: 'ActivityLabel',
          sourceModule: 'lively.morphic.TextCore',
          submorphs: [],
          textString: 'Active Participants Nickname (optional)',
        }, {
          // Free-text, creator-typed nickname/category (e.g. "Jamming",
          // "Reading") describing what active participants are doing --
          // same input-line shape as NameText above. Shown on the room
          // card as "· <activity>" once set (ConstellationLounge.js's
          // _renderRoomCard, room.activity).
          _BorderColor: Color.rgb(203, 203, 203),
          _BorderRadius: 3.75,
          _BorderWidth: 1,
          _ClipMode: 'hidden',
          _Extent: lively.pt(354.0, 22.0),
          _Fill: Color.rgb(255, 255, 255),
          _FontFamily: 'Helvetica',
          _Padding: lively.rect(4, 4, 0, 0),
          _Position: lively.pt(10.0, 148.0),
          allowInput: true,
          className: 'lively.morphic.Text',
          doNotSerialize: ['charsTyped'],
          evalEnabled: false,
          fixedHeight: true,
          fixedWidth: true,
          isInputLine: true,
          layout: { resizeWidth: true },
          name: 'ActivityText',
          sourceModule: 'lively.morphic.TextCore',
          submorphs: [],
          textString: '',
        }, {
          _Extent: lively.pt(200.0, 16.0),
          _FontFamily: 'Arial, sans-serif',
          _FontSize: 11,
          _Padding: lively.rect(4, 3, 0, 0),
          _Position: lively.pt(10.0, 180.0),
          _InputAllowed: false,
          allowInput: false,
          className: 'lively.morphic.Text',
          droppingEnabled: false,
          fixedWidth: true,
          grabbingEnabled: false,
          name: 'AccessLabel',
          sourceModule: 'lively.morphic.TextCore',
          submorphs: [],
          textString: 'Access',
        }, {
          // 2-way radio: 'open' (default) vs 'request' -- see selectAccess.
          _BorderColor: Color.rgb(180, 180, 180),
          _BorderRadius: 5,
          _BorderWidth: 1,
          _Extent: lively.pt(70.0, 24.0),
          _Position: lively.pt(10.0, 202.0),
          className: 'lively.morphic.Button',
          doNotCopyProperties: [],
          doNotSerialize: [],
          isPressed: false,
          label: 'Open',
          name: 'OpenButton',
          sourceModule: 'lively.morphic.Widgets',
          submorphs: [],
          toggle: false,
          value: false,
          connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, 'fire', this.get('NewRoomDialogPane'), 'selectAccess', {
              converter: function() { return 'open'; }
            });
          },
        }, {
          _BorderColor: Color.rgb(180, 180, 180),
          _BorderRadius: 5,
          _BorderWidth: 1,
          _Extent: lively.pt(130.0, 24.0),
          _Position: lively.pt(88.0, 202.0),
          className: 'lively.morphic.Button',
          doNotCopyProperties: [],
          doNotSerialize: [],
          isPressed: false,
          label: 'Request to Join',
          name: 'RequestButton',
          sourceModule: 'lively.morphic.Widgets',
          submorphs: [],
          toggle: false,
          value: false,
          connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, 'fire', this.get('NewRoomDialogPane'), 'selectAccess', {
              converter: function() { return 'request'; }
            });
          },
        }, {
          _Extent: lively.pt(200.0, 16.0),
          _FontFamily: 'Arial, sans-serif',
          _FontSize: 11,
          _Padding: lively.rect(4, 3, 0, 0),
          _Position: lively.pt(10.0, 236.0),
          _InputAllowed: false,
          allowInput: false,
          className: 'lively.morphic.Text',
          droppingEnabled: false,
          fixedWidth: true,
          grabbingEnabled: false,
          name: 'RetentionLabel',
          sourceModule: 'lively.morphic.TextCore',
          submorphs: [],
          textString: 'Message Retention',
        }, {
          // 2-way radio: 'persistent' (default) vs 'ephemeral' -- see selectRetention.
          _BorderColor: Color.rgb(180, 180, 180),
          _BorderRadius: 5,
          _BorderWidth: 1,
          _Extent: lively.pt(170.0, 24.0),
          _Position: lively.pt(10.0, 258.0),
          className: 'lively.morphic.Button',
          doNotCopyProperties: [],
          doNotSerialize: [],
          isPressed: false,
          label: 'Persistent',
          name: 'PersistentButton',
          sourceModule: 'lively.morphic.Widgets',
          submorphs: [],
          toggle: false,
          value: false,
          connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, 'fire', this.get('NewRoomDialogPane'), 'selectRetention', {
              converter: function() { return false; }
            });
          },
        }, {
          _BorderColor: Color.rgb(180, 180, 180),
          _BorderRadius: 5,
          _BorderWidth: 1,
          _Extent: lively.pt(170.0, 24.0),
          _Position: lively.pt(194.0, 258.0),
          className: 'lively.morphic.Button',
          doNotCopyProperties: [],
          doNotSerialize: [],
          isPressed: false,
          label: 'Ephemeral',
          name: 'EphemeralButton',
          sourceModule: 'lively.morphic.Widgets',
          submorphs: [],
          toggle: false,
          value: false,
          connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, 'fire', this.get('NewRoomDialogPane'), 'selectRetention', {
              converter: function() { return true; }
            });
          },
        }, {
          _Extent: lively.pt(200.0, 16.0),
          _FontFamily: 'Arial, sans-serif',
          _FontSize: 11,
          _Padding: lively.rect(4, 3, 0, 0),
          _Position: lively.pt(10.0, 292.0),
          _InputAllowed: false,
          allowInput: false,
          className: 'lively.morphic.Text',
          droppingEnabled: false,
          fixedWidth: true,
          grabbingEnabled: false,
          name: 'EncryptionLabel',
          sourceModule: 'lively.morphic.TextCore',
          submorphs: [],
          textString: 'Encryption',
        }, {
          // 2-way radio: 'standard' (default) vs 'e2ee' -- immutable after
          // creation (e2eeclusters.md §9's "Decisions locked in"), same
          // manual-radio idiom as selectAccess/selectRetention above.
          _BorderColor: Color.rgb(180, 180, 180),
          _BorderRadius: 5,
          _BorderWidth: 1,
          _Extent: lively.pt(90.0, 24.0),
          _Position: lively.pt(10.0, 314.0),
          className: 'lively.morphic.Button',
          doNotCopyProperties: [],
          doNotSerialize: [],
          isPressed: false,
          label: 'Standard',
          name: 'StandardEncryptionButton',
          sourceModule: 'lively.morphic.Widgets',
          submorphs: [],
          toggle: false,
          value: false,
          connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, 'fire', this.get('NewRoomDialogPane'), 'selectEncryption', {
              converter: function() { return false; }
            });
          },
        }, {
          _BorderColor: Color.rgb(180, 180, 180),
          _BorderRadius: 5,
          _BorderWidth: 1,
          _Extent: lively.pt(165.0, 24.0),
          _Position: lively.pt(108.0, 314.0),
          className: 'lively.morphic.Button',
          doNotCopyProperties: [],
          doNotSerialize: [],
          isPressed: false,
          label: 'End-to-End Encrypted',
          name: 'E2eeEncryptionButton',
          sourceModule: 'lively.morphic.Widgets',
          submorphs: [],
          toggle: false,
          value: false,
          connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, 'fire', this.get('NewRoomDialogPane'), 'selectEncryption', {
              converter: function() { return true; }
            });
          },
        }, {
          // Hidden unless selecting E2EE reveals this account never
          // published an X25519 key (checkOwnEncryptionKey) -- mintInitialEpoch
          // would otherwise fail for the creator themselves right after
          // creation, with no recourse short of leaving the dialog. One
          // click runs the same WebAuthn PRF ceremony ProfileCard.js's own
          // "Enable encryption" button does.
          _BorderColor: Color.rgb(214, 170, 60),
          _BorderRadius: 5,
          _BorderWidth: 1,
          _Extent: lively.pt(230.0, 22.0),
          _Fill: Color.rgb(255, 247, 225),
          _Position: lively.pt(10.0, 342.0),
          className: 'lively.morphic.Button',
          doNotCopyProperties: [],
          doNotSerialize: [],
          isPressed: false,
          label: 'Enable Encryption on This Account',
          name: 'EnableKeyButton',
          sourceModule: 'lively.morphic.Widgets',
          submorphs: [],
          toggle: false,
          value: false,
          connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, 'fire', this.get('NewRoomDialogPane'), 'onEnableEncryption', {});
          },
        }, {
          _Extent: lively.pt(354.0, 18.0),
          _FontFamily: 'Arial, sans-serif',
          _FontSize: 11,
          _Padding: lively.rect(4, 3, 0, 0),
          _Position: lively.pt(10.0, 372.0),
          _InputAllowed: false,
          allowInput: false,
          className: 'lively.morphic.Text',
          droppingEnabled: false,
          fixedWidth: true,
          grabbingEnabled: false,
          name: 'StatusText',
          sourceModule: 'lively.morphic.TextCore',
          submorphs: [],
          textColor: Color.rgb(153, 153, 153),
          textString: '',
        }, {
          _BorderColor: Color.rgb(214, 214, 214),
          _BorderRadius: 5,
          _BorderWidth: 1,
          _Extent: lively.pt(80.0, 24.0),
          _Position: lively.pt(204.0, 398.0),
          className: 'lively.morphic.Button',
          doNotCopyProperties: [],
          doNotSerialize: [],
          isPressed: false,
          label: 'cancel',
          name: 'CancelButton',
          sourceModule: 'lively.morphic.Widgets',
          submorphs: [],
          toggle: false,
          value: false,
          connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, 'fire', this.get('NewRoomDialogPane'), 'onCancel', {});
          },
        }, {
          _BorderColor: Color.rgb(160, 168, 250),
          _BorderRadius: 5.2,
          _BorderWidth: 1.184,
          _Extent: lively.pt(80.0, 24.0),
          _Fill: Color.rgb(231, 233, 254),
          _Position: lively.pt(288.0, 398.0),
          className: 'lively.morphic.Button',
          doNotCopyProperties: [],
          doNotSerialize: [],
          isPressed: false,
          label: 'create',
          name: 'CreateButton',
          sourceModule: 'lively.morphic.Widgets',
          submorphs: [],
          toggle: false,
          value: false,
          connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, 'fire', this.get('NewRoomDialogPane'), 'onSubmit', {});
          },
        }],
        target: null,

        // ─── lifecycle ──────────────────────────────────────────────────────────

        // scope: { constellation: name } -- informational only, threaded
        // straight through to onCreate's caller-supplied callback; this
        // dialog never itself decides what scope means.
        configure: function configure(opts) {
          this._scope = (opts && opts.scope) || null;
          this._onCreateCallback = (opts && opts.onCreate) || null;
          this._isVideo = false;
          this._isVoice = false;
          this._hasOwnX25519Key = null; // null = not checked yet; see checkOwnEncryptionKey
          this.get('NameText').textString = '';
          this.get('ActivityText').textString = '';
          this.paintToggle('VideoToggleChip', 'VideoIcon', 'VideoLabel', false);
          this.paintTypeToggles();
          this.selectAccess('open');
          this.selectRetention(false);
          this.get('EnableKeyButton').setVisible(false);
          this.selectEncryption(false);
          this.setStatus('');
        },

        onCancel: function onCancel() {
          this.owner.remove();
        },

        onRemove: function onRemove() {
          $world.newRoomDialog && $world.newRoomDialog.remove();
        },

        setStatus: function setStatus(text, isError) {
          var t = this.get('StatusText');
          t.textString = text || '';
          t.setTextColor(isError ? Color.rgb(204, 51, 51) : Color.rgb(153, 153, 153));
        },

        // ─── toggles ────────────────────────────────────────────────────────────
        // Video and Voice are on/off chips, not a radio group (video implies
        // voice, see toggleVideo/toggleVoice); the Chat chip is derived from
        // them. paintTypeToggles repaints all three.

        paintToggle: function paintToggle(chipName, iconName, labelName, isOn) {
          var selectedFill = Color.rgb(224, 227, 254), selectedBorder = Color.rgb(88, 101, 242);
          var normalFill = Color.rgb(243, 243, 243), normalBorder = Color.rgb(180, 180, 180);
          var selectedText = Color.rgb(72, 82, 224), normalText = Color.rgb(120, 120, 120);
          var chip = this.get(chipName);
          chip.setFill(isOn ? selectedFill : normalFill);
          chip.setBorderColor(isOn ? selectedBorder : normalBorder);
          this.get(iconName).setTextColor(isOn ? selectedText : normalText);
          this.get(labelName).setTextColor(isOn ? selectedText : normalText);
        },

        toggleVideo: function toggleVideo() {
          this._isVideo = !this._isVideo;
          // A video room always carries audio, so turning video on turns voice on.
          if (this._isVideo) this._isVoice = true;
          this.paintTypeToggles();
        },

        toggleVoice: function toggleVoice() {
          this._isVoice = !this._isVoice;
          // ...and turning voice off can't leave video on without audio.
          if (!this._isVoice) this._isVideo = false;
          this.paintTypeToggles();
        },

        // A text-only room is the absence of both flags, so this just
        // clears them; the chip itself is derived (see paintTypeToggles).
        selectChatOnly: function selectChatOnly() {
          this._isVideo = false;
          this._isVoice = false;
          this.paintTypeToggles();
        },

        paintTypeToggles: function paintTypeToggles() {
          this.paintToggle('VideoToggleChip', 'VideoIcon', 'VideoLabel', this._isVideo);
          this.paintToggle('VoiceToggleChip', 'VoiceIcon', 'VoiceLabel', this._isVoice);
          this.paintToggle('ChatToggleChip', 'ChatIcon', 'ChatLabel', !this._isVideo && !this._isVoice);
        },

        // ─── access ─────────────────────────────────────────────────────────────
        // A real 2-way radio (unlike the video/voice toggles above) -- each
        // button's connectionRebuilder fires here with its own converter
        // value (see OpenButton/RequestButton above), same manual-radio
        // idiom PublishToInventoryDialog's selectVisibility uses for its
        // Public/Private/Shared buttons.

        selectAccess: function selectAccess(v) {
          this._access = v;
          var selectedFill = Color.rgb(224, 227, 254), selectedBorder = Color.rgb(88, 101, 242);
          var normalFill = Color.rgb(243, 243, 243), normalBorder = Color.rgb(180, 180, 180);
          [['OpenButton', 'open'], ['RequestButton', 'request']].forEach(function(pair) {
            var btn = this.get(pair[0]);
            var isSelected = pair[1] === v;
            btn.setFill(isSelected ? selectedFill : normalFill);
            btn.setBorderColor(isSelected ? selectedBorder : normalBorder);
          }, this);
        },

        // ─── message retention ─────────────────────────────────────────────────
        // Same manual-radio idiom as selectAccess above. Persistent (default,
        // matching the server's own column default): messages are signed,
        // durably stored, searchable. Ephemeral: relayed live only, never
        // stored, zero scrollback for anyone who joins after a message was
        // sent — see RoomSettingsDialog.js's own Message Retention section
        // for the fuller explanation shown there.

        selectRetention: function selectRetention(ephemeral) {
          this._ephemeral = ephemeral;
          var selectedFill = Color.rgb(224, 227, 254), selectedBorder = Color.rgb(88, 101, 242);
          var normalFill = Color.rgb(243, 243, 243), normalBorder = Color.rgb(180, 180, 180);
          [['PersistentButton', false], ['EphemeralButton', true]].forEach(function(pair) {
            var btn = this.get(pair[0]);
            var isSelected = pair[1] === ephemeral;
            btn.setFill(isSelected ? selectedFill : normalFill);
            btn.setBorderColor(isSelected ? selectedBorder : normalBorder);
          }, this);
        },

        // ─── encryption ─────────────────────────────────────────────────────────
        // Same manual-radio idiom as selectAccess/selectRetention above.
        // e2eeEnabled is set here but is otherwise only ever READ by the
        // server (immutable after creation, e2eeclusters.md §9) — this
        // dialog's only other job for it is the pre-creation missing-key
        // check below, since mintInitialEpoch (called right after creation
        // succeeds — ConstellationLounge.js's _openNewRoom) would otherwise
        // fail loudly for the creator's own account with no recourse short
        // of leaving the dialog.

        selectEncryption: function selectEncryption(e2ee) {
          this._e2eeEnabled = e2ee;
          var selectedFill = Color.rgb(224, 227, 254), selectedBorder = Color.rgb(88, 101, 242);
          var normalFill = Color.rgb(243, 243, 243), normalBorder = Color.rgb(180, 180, 180);
          [['StandardEncryptionButton', false], ['E2eeEncryptionButton', true]].forEach(function(pair) {
            var btn = this.get(pair[0]);
            var isSelected = pair[1] === e2ee;
            btn.setFill(isSelected ? selectedFill : normalFill);
            btn.setBorderColor(isSelected ? selectedBorder : normalBorder);
          }, this);
          if (e2ee) {
            this.checkOwnEncryptionKey();
          } else {
            this.get('EnableKeyButton').setVisible(false);
            this.setStatus('');
          }
        },

        // Fetches the signed-in user's own /profile and checks
        // accountX25519Pub is published — mintInitialEpoch's own
        // _resolveAndVerifyMembers (RoomCrypto.js) fails the WHOLE mint if
        // ANY effective member (creator included) is missing this, loudly
        // naming who; checking it here, before creation, surfaces that
        // same gap with something actionable (EnableKeyButton) instead of
        // a confusing "cluster created but encryption setup failed" message.
        checkOwnEncryptionKey: function checkOwnEncryptionKey() {
          var self = this;
          var user = lively.identity.did.currentUser();
          if (!user) return; // no session -- the create button itself will fail cleanly
          this.setStatus('Checking encryption setup…');
          var base = lively.identity.did.baseUrl();
          var xhr = new XMLHttpRequest();
          xhr.open('GET', base + '/@' + encodeURIComponent(user.handle) + '/profile', true);
          xhr.withCredentials = true;
          xhr.onload = function () {
            var hasKey = false;
            if (xhr.status === 200) {
              try {
                var body = JSON.parse(xhr.responseText);
                hasKey = !!(body && body.record && body.record.payload && body.record.payload.accountX25519Pub);
              } catch (e) {}
            }
            self._hasOwnX25519Key = hasKey;
            self.get('EnableKeyButton').setVisible(!hasKey);
            self.setStatus(hasKey
              ? ''
              : 'Your account hasn\'t set up encryption yet — click below before creating this cluster.',
              !hasKey);
          };
          xhr.onerror = function () {
            self._hasOwnX25519Key = null; // unknown -- onSubmit treats this the same as "missing"
            self.get('EnableKeyButton').setVisible(true);
            self.setStatus('Could not check your encryption setup — try again.', true);
          };
          xhr.send();
        },

        // Same WebAuthn PRF ceremony ProfileCard.js's own "Enable
        // encryption" button runs (lively.identity.userSpace.enableEncryption) --
        // kept as a one-click fix here rather than sending the user away to
        // their profile card mid-dialog.
        onEnableEncryption: function onEnableEncryption() {
          var self = this;
          var btn = this.get('EnableKeyButton');
          btn.setLabel('Confirm passkey…');
          btn.setActive(false);
          lively.identity.userSpace.enableEncryption(function (err) {
            if (err) {
              self.setStatus('Could not enable encryption: ' + err.message, true);
              btn.setLabel('Enable Encryption on This Account');
              btn.setActive(true);
              return;
            }
            self._hasOwnX25519Key = true;
            btn.setVisible(false);
            btn.setLabel('Enable Encryption on This Account');
            btn.setActive(true);
            self.setStatus('');
          });
        },

        // ─── submit ──────────────────────────────────────────────────────────────

        onSubmit: function onSubmit() {
          var name = this.get('NameText').textString.trim();
          if (!name) { this.setStatus('Cluster name is required', true); return; }
          if (this._e2eeEnabled && this._hasOwnX25519Key !== true) {
            this.setStatus('Enable encryption on your account first (see above), or switch to Standard.', true);
            return;
          }

          var activity = this.get('ActivityText').textString.trim();
          var fields = {
            name: name, isVideo: this._isVideo, isVoice: this._isVoice, access: this._access,
            activity: activity || null, ephemeral: this._ephemeral, e2eeEnabled: !!this._e2eeEnabled,
          };
          var cb = this._onCreateCallback;
          this.owner.remove();
          if (cb) cb(fields);
        },
      }],
      titleBar: 'New Cluster',
      connectionRebuilder: function connectionRebuilder() {
        lively.bindings.connect(this, 'remove', this.get('NewRoomDialogPane'), 'onRemove', {});
      },
    });

    // Static open helper -- same world-tracked-singleton pattern as
    // lively.identity.NewWikiPageDialog.open.
    //
    // opts: { scope: {constellation:name}, onCreate(fields) }
    // fields: { name, isVideo, isVoice, access, activity }
    Object.extend(lively.identity.NewRoomDialog, {
      open: function (opts) {
        var world = lively.morphic.World.current();
        if (world.newRoomDialog) world.newRoomDialog.remove();
        var dlg = lively.BuildSpec('lively.identity.NewRoomDialog').createMorph();
        dlg.openInWorldCenter().comeForward();
        world.newRoomDialog = dlg;
        dlg.get('NewRoomDialogPane').configure(opts || {});
        return dlg;
      },
    });

  }); // end of module
