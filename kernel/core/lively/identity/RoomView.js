/**
 * lively.identity.RoomView
 *
 * A single room's live view: chat, a real-presence member
 * list, and voice/video controls — the "enter a room" destination that
 * ConstellationLounge.js's Spaces panel cards previously had no real place
 * to send you (joining there only ever touched an in-memory heartbeat/
 * headcount and left you on the lounge page).
 *
 * Not a page anymore: entering a room (ConstellationLounge.js's "Enter", or a
 * row in this view's own rooms rail) opens it as a standalone, minimizable
 * lively.morphic.Window in the CURRENT world, so the user can keep working
 * in Lively while staying on the call — the "ambient presence" model. The
 * old /c/:name/rooms/:roomId boot page is gone; that URL now only serves the
 * JSON room detail this file fetches.
 *
 * Two halves, one class: RoomViewController is the persistent SESSION
 * (presence, heartbeat, chat polling, signaling, peer connections, remote
 * audio) held by lively.identity.RoomView._active; the window/morphs are a
 * detachable VIEW over it (see the "view" category). Closing or collapsing
 * the window leaves the call running; only leave() (the header's Leave Room
 * button, or the Ambient Presence Panel's end-call) or a real page load ends
 * it. Mic/camera/deafen live on lively.identity.AmbientPresencePanel.
 *
 * Chat and video are both real as of the 2026-08-25 session: chat messages
 * ride the same objects-envelope/postal rail every other postcard uses
 * (`state.kind:'room-message'`, ObjectRepository.listMessagesForRoom) —
 * sent via PostCardSerializer.serializePlainToEnvelope + PUT to your own
 * /@handle/objId, then POSTed to /c/:name/rooms/:roomId/messages for
 * server-side validation, exactly like a room-join-request postcard.
 * Other participants' messages arrive via short-interval polling (no
 * persistent chat channel — see the "chat" category below). Video/voice is
 * a real mesh WebRTC call (RoomSignalingServer.js relays offer/answer/ICE,
 * grouped by roomId and gated by canJoinRoom via a short-lived token) —
 * your own picture streams a real getUserMedia camera preview (via
 * lively.identity.AmbientPresencePanel.enterRoom/getLocalStream — no
 * duplicate media acquisition here) and so does every other participant's,
 * via a direct RTCPeerConnection to each of them (see the "webrtc"
 * category below). Pictures show as a grid of tiles inside the open window
 * (active speaker + chat when the chat toggle is on) and as floating circles
 * while the window is collapsed or closed (see the "video" category).
 *
 * Rendering convention: every visible element is a real Lively morph
 * (Box/Text/Image), added to $world — same "no raw DOM overlay" discipline
 * ConstellationLounge.js's own header comment documents and justifies
 * (halo-selectable, Object-Editor inspectable, correct focus/z-order).
 *
 * Open: lively.identity.RoomView.open(constellationName, roomId) — from any
 * world that already exists (ConstellationLounge.js's _enterRoom).
 */

module("lively.identity.RoomView")
  .requires(
    "lively.identity.DID",
    "lively.identity.PostCardUtils",
    "lively.identity.PostCardSerializer",
    "lively.identity.RoomCrypto",
    "lively.identity.Crypto",
    "lively.identity.WebKey",
    "lively.identity.EnvelopeSigning",
    "lively.identity.AmbientPresencePanel",
    "lively.identity.MediaPickerDialog",
    "lively.Network",
    "lively.morphic.Complete",
  )
  .toRun(function () {

    var BG_MAIN    = Color.rgb(0xA8, 0x7B, 0xED);     // #A87BED — chat area (light two-tone experiment)
    var BG_SIDEBAR = Color.rgb(0x67, 0x14, 0x8E);     // #67148E — header + members panel
    var BG_INPUT   = Color.rgb(0x67, 0x14, 0x8E);     // #67148E — message input pill
    var BG_ROW_HOVER = Color.rgba(255, 255, 255, 0.04);
    // BG_ROW_HOVER above is a white overlay tuned for the dark rail/members
    // surfaces — too faint on the light BG_MAIN chat list, so message rows
    // get their own dark-tinted hover fill instead.
    var BG_MSG_ROW_HOVER = Color.rgba(43, 20, 63, 0.07);
    var TEXT_PRIMARY = Color.rgb(242, 243, 245);
    var TEXT_MUTED   = Color.rgb(205, 210, 220);
    var TEXT_FAINT   = Color.rgb(176, 180, 190);
    // Dark-on-light variants for content sitting directly on the now-light
    // BG_MAIN chat area (message list) — TEXT_PRIMARY/MUTED/FAINT above stay
    // near-white for the dark BG_SIDEBAR/BG_INPUT surfaces, which still need them.
    var CHAT_TEXT_PRIMARY = Color.rgb(24, 8, 40);
    var CHAT_TEXT_MUTED   = Color.rgb(48, 22, 80);
    var CHAT_TEXT_FAINT   = Color.rgb(58, 30, 92);
    var ACCENT = Color.rgb(79, 11, 67);       // #4F0B43 — matches ConstellationLounge's ROOM_ACCENT
    var JUMP_HIGHLIGHT = Color.rgba(79, 11, 67, 0.18); // flash fill for "jump to replied-to message"
    var DANGER = Color.rgb(242, 63, 66);
    var ONLINE = Color.rgb(35, 165, 89);

    // Same accent-chrome fix DMChat.js/Wallet.js/PostCardMailbox.js/
    // FilesBrowser.js already apply (title-text contrast + suppressing the
    // base theme's white focus-ring border on `.highlighted`), plus a
    // softened border-radius on top — see PostCardMailbox.js's own
    // _ensureAccentChromeCss for the confirmed-live bug writeup this
    // pattern fixes. Frame-only: this file's own internal #4F0B43 ACCENT
    // (borders/hover/selection highlights elsewhere in the room UI) is
    // deliberately left untouched.
    function _ensureAccentChromeCss() {
      var STYLE_ID = 'room-view-accent-chrome-style';
      if (document.getElementById(STYLE_ID)) return;
      var styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
      styleEl.textContent = [
        '.Window.room-view-accent-chrome { background-color: #A87BED !important; }',
        '.Window.room-view-accent-chrome { border-radius: 10px !important; }',
        '.Window.room-view-accent-chrome .Text.window-title { color: #fff; }',
        '.Window.room-view-accent-chrome.highlighted .Text.window-title { color: #fff; font-weight: bold; }',
        '.Window.room-view-accent-chrome.highlighted { border: none !important; box-shadow: 0px 3px 10px rgba(40,5,45,0.35) !important; }',
      ].join('\n');
      document.head.appendChild(styleEl);
    }

    function applyAccentChrome(win) {
      _ensureAccentChromeCss();
      win.addStyleClassName('room-view-accent-chrome');
    }

    var HEADER_H = 48;
    var MEMBERS_W = 240;
    var ROOMS_PANEL_W = 220;
    var CHAT_W = 760;
    var BODY_H = 620;
    // Gap between adjoining boxes (rooms panel/chat/members panel) -- each
    // is a separate box rather than directly abutting the next, same
    // "distinct card, own margin" treatment ConstellationLounge.js's
    // right-hand co-creator/members sidebar uses.
    var PANEL_GAP = 20;
    // x-offset from the view's own origin to where the chat box starts --
    // the rooms panel (this constellation's other rooms, similar intent to
    // WikiIndex.js's left sidebar page list) occupies the space before it.
    var CHAT_X_OFFSET = ROOMS_PANEL_W + PANEL_GAP;
    var TOTAL_W = CHAT_X_OFFSET + CHAT_W + PANEL_GAP + MEMBERS_W;
    var TOTAL_H = HEADER_H + BODY_H;

    // Taller titlebar + thicker frame margin for this window specifically —
    // TitleBar.barHeight/Window.spacing are shared defaults (Widgets.js)
    // used by every window in the app, so this overrides them on just
    // this._win's own titleBar/window instance rather than touching the
    // globals (dozens of other windows across the codebase hardcode their
    // own contentOffset in BuildSpec data and would clip under a taller
    // titlebar if the shared defaults changed instead).
    var ROOM_BAR_HEIGHT = 30;
    var ROOM_FRAME_SPACING = 6;

    function _widenWindowChrome(win) {
      var tb = win.titleBar;
      tb.barHeight = ROOM_BAR_HEIGHT;
      // Vertically re-center the titleBar's existing (fixed-size) circular
      // buttons within the new taller bar — controlVerticalOffset is only
      // correct for the base theme's default 22px bar (see its own comment
      // in Widgets.js), so it needs recomputing here too.
      tb.controlVerticalOffset = (ROOM_BAR_HEIGHT - 17) / 2;

      var contentOffset = lively.pt(ROOM_FRAME_SPACING, ROOM_BAR_HEIGHT);
      win.spacing = ROOM_FRAME_SPACING;
      win.contentOffset = contentOffset;

      // Window#setExtent stretches titleBar/targetMorph by the same raw
      // pixel delta as the window's own resize (not recomputed from
      // contentOffset), so after resizing the window itself, targetMorph's
      // size/position has to be forced back to the real content size —
      // confirmed live: skipping this step left the content overflowing
      // the right/bottom edges of the new, larger frame.
      win.setExtent(lively.pt(TOTAL_W + 2 * ROOM_FRAME_SPACING, TOTAL_H + ROOM_FRAME_SPACING + ROOM_BAR_HEIGHT));
      win.targetMorph.setExtent(lively.pt(TOTAL_W, TOTAL_H));
      win.targetMorph.setPosition(contentOffset);
      tb.setExtent(lively.pt(TOTAL_W + 2 * ROOM_FRAME_SPACING, ROOM_BAR_HEIGHT));
      tb.adjustElementPositions();
    }
    // Video rooms: the center column is either the full-width video grid (chat
    // hidden) or, with the chat toggle on, the active speaker on the left and a
    // narrower chat panel on the right.
    var CHAT_COMPACT_W = 400;
    var VIDEO_AREA_W = CHAT_W - CHAT_COMPACT_W - PANEL_GAP;
    var GRID_PAD = 12, GRID_GAP = 12, TILE_RADIUS = 12;
    var GRID_BG = Color.rgb(12, 2, 14);
    var CHAT_TOGGLE = 36;
    var SPEAKER_POLL_MS = 250, SPEAKER_THRESHOLD = 0.012, SPEAKER_HOLD_MS = 900;
    var INPUT_H = 52;
    // The message box wraps and grows with its text (see _fitComposer): one
    // line is COMPOSER_MIN_H tall, it stops growing at COMPOSER_MAX_H (about
    // five lines) and scrolls inside itself from there.
    var COMPOSER_MIN_H = 24, COMPOSER_MAX_H = 120;
    var AVATAR_MSG = 28, AVATAR_MEMBER = 28;
    // Reserved row height for a GIF/sticker message bubble (_isMediaMessage)
    // — fixed rather than measured, so _renderMessages' cumulative y-layout
    // stays synchronous despite the image itself loading asynchronously;
    // see the comment at its one call site for why this can only shrink an
    // image, never grow one into the next message.
    var MEDIA_ROW_H = 190;
    var VIDEO_CIRCLE = 96;
    // Name tag under each video circle: a soft pastel pill, colored per person
    // (stable hash of their did) so circles are tellable apart at a glance.
    var NAME_TAG_H = 24, NAME_TAG_GAP = 6, NAME_TAG_TEXT_Y = 3;
    var NAME_TAG_PAD_X = 10, NAME_TAG_MAX_CHARS = 8, NAME_TAG_FONT_PX = 11;   // 8.25pt renders at 11px
    var nameTagCanvas = null;
    // Text width via a canvas 2D context, not the rendered span: reading a fresh Text
    // morph's span the same tick it's added can return 0 (see CLAUDE.md), whereas this
    // is synchronous and needs no DOM. Same font as the label so it matches what renders.
    function measureNameTag(text, fontFamily) {
      if (!nameTagCanvas) nameTagCanvas = document.createElement("canvas");
      var ctx = nameTagCanvas.getContext("2d");
      ctx.font = "700 " + NAME_TAG_FONT_PX + "px " + (fontFamily || "'Atkinson Hyperlegible', Helvetica, Arial, sans-serif");
      return Math.ceil(ctx.measureText(text).width);
    }
    // "@" + the handle, cut to NAME_TAG_MAX_CHARS with an ellipsis.
    function nameTagText(handle) {
      var h = String(handle || "?");
      return "@" + (h.length > NAME_TAG_MAX_CHARS ? h.slice(0, NAME_TAG_MAX_CHARS) + "…" : h);
    }
    var NAME_TAG_TEXT = Color.rgb(45, 32, 70);
    var NAME_TAG_FILLS = [
      Color.rgb(221, 214, 254), Color.rgb(187, 247, 208), Color.rgb(254, 240, 138),
      Color.rgb(251, 207, 232), Color.rgb(186, 230, 253), Color.rgb(254, 215, 170),
    ];
    function nameTagFill(key) {
      var h = 0, s = String(key || "");
      for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
      return NAME_TAG_FILLS[h % NAME_TAG_FILLS.length];
    }
    // Rooms-rail stacked-participant-avatars row — same overlapping-ring
    // technique as ConstellationLounge.js's _renderRoomCard/_renderEventCard,
    // sized down for this panel's much narrower width (220px vs a full
    // room card).
    var ROOM_ROW_AV = 16, ROOM_ROW_OVERLAP = 6, ROOM_ROW_RING = 2, ROOM_ROW_MAX_SHOWN = 3;
    var MESSAGE_POLL_MS = 4000;
    // Message actions (reactions/replies/edit/delete/flag) — persistent
    // rooms only, see RoomViewController.initialize's own note on why.
    var REPLY_STRIP_H = 26;     // extra height _inputRowM grows by while composing a reply
    var ROTATION_BANNER_H = 32; // extra height _inputRowM grows by while an e2eeEnabled room's key rotation is pending (e2eeclusters.md §9.1)
    // _renderMessages draws the pink lock glyph before this text (an emoji
    // can't take the brand color) — it recognizes the message by this exact string.
    var E2EE_UNDECRYPTABLE_TEXT = "Message unavailable — sent before you had access to this cluster's key.";
    var REPLY_PREVIEW_H = 26;   // reply-preview chip (parent avatar + handle + snippet) above a reply message — tall enough for a short connector curve below the small avatar
    var REPLY_AVATAR = 16;      // small parent-message avatar shown inside the reply-preview chip
    var REPLY_ELBOW_DX = 12;   // horizontal gap between the big avatar's center column and the small avatar's left edge, so the reply connector has a real elbow leg to turn through
    var RAIL_POLL_MS = 8000;   // how often the rooms rail re-reads other rooms' headcounts
    var ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

    // Plain Box/Text/Image morphs default to draggable/droppable/grabbable —
    // fine for the video circles (draggable by design), wrong for every
    // other piece of chrome here, where it means a click that so much as
    // twitches the mouse between down and up gets eaten as a drag instead
    // of firing its own click handler (real bug hit live, see project
    // memory). draggingEnabled alone is NOT enough to stop this: Events.js's
    // drag-start check is `targetMorph.draggingEnabled || targetMorph.isGrabbable()`,
    // and isGrabbable() (MorphAddons.js) defaults to *true* whenever
    // grabbingEnabled was never explicitly set (`this.grabbingEnabled ||
    // this.grabbingEnabled === undefined`) — so leaving grabbingEnabled
    // untouched keeps a morph pick-up-able via the OR even after
    // draggingEnabled is turned off (confirmed live: setting only
    // draggingEnabled/droppingEnabled false did not actually stop dragging).
    // Not a closure-loss risk to pull out as a plain module-level helper
    // here — RoomViewController is a normal Object.subclass instance method
    // set, never reconstructed from source text the way a BuildSpec/
    // addScript function is (see AmbientPresencePanel.js's header comment
    // for that distinct gotcha, which doesn't apply to this file at all).
    function noDrag(m) {
      m.draggingEnabled = false;
      m.droppingEnabled = false;
      m.grabbingEnabled = false;
      return m;
    }

    Object.subclass("lively.identity.RoomViewController",

    "initializing", {
      initialize: function () {
        this._name = null;
        this._roomId = null;
        this._room = null;
        this._isController = false;
        this._roomLeft = false;   // stops _waitForLocalStreamThenFill's indefinite poll once the room is actually left
        this._participants = [];  // [{did, handle}]
        this._memberStatuses = {}; // did -> {status, expiresAt}, refined async by _fetchMemberStatuses
        this._messages = [];      // [{objId, did, handle, text, created}], real (see "chat" category)
        this._mutedExpanded = {}; // key -> true, see _renderMessages' mute-collapse handling
        this._mediaDims = {};     // media msg.text (its URL) -> {w, h} once loaded, see _renderMessages' media branch
        this._linkPreviewRowH = {}; // msg.text -> real body height once a link-preview card has settled, see _watchLinkPreviewInsert
        this._messagePollTimer = null;
        this._searchActive = false; // persistent rooms only — see _toggleSearch/_performSearch
        this._searchQuery = "";
        this._searchResults = null;
        this._sendingMessage = false;
        this._mediaPicker = null; // lazily created by _getMediaPicker on first emoji/GIF button click
        // Message actions — persistent (non-ephemeral) rooms only, since
        // reactions/replies/edit/delete/flag all key off a message's real
        // signed-postcard objId, which ephemeral messages never have.
        this._reactionPicker = null; // lazily created by _getReactionPicker, a second MediaPickerController instance
        this._replyingTo = null;     // {objId, handle, snippet} while composing a reply, else null
        this._replyStripM = null;    // the "Replying to @x" strip morph inside _inputRowM, while _replyingTo is set
        this._editingObjId = null;   // objId of the message currently being edited inline, else null
        this._editingDraftText = null; // keystroke-level draft of the in-progress edit, survives a poll-triggered re-render
        this._heartbeatTimer = null;
        // Video surfaces (see "video" category): tiles live in the window's grid
        // panel, circles float on the world while the window is collapsed/closed.
        this._videoCircles = {};  // did -> morph (world-owned)
        this._videoTiles = {};    // did -> morph (owned by _gridBox)
        this._gridBox = null;
        this._chatToggleBtn = null;
        this._pickerBtns = [];
        this._chatW = CHAT_W;
        this._centerMode = "grid";   // "grid" (all participants, no chat) | "chat" (active speaker + chat)
        this._windowCollapsed = false;
        this._circleSpots = {};   // did -> {x, y} last dragged world position; outlives the window
        this._activeSpeakerDid = null;
        this._speakerTimer = null;
        this._speakerLastLoud = 0;
        this._audioCtx = null;
        this._analysers = {};     // did -> {trackId, source, node, buf}
        this._boundLeaveBestEffort = null;
        // The view (window + every morph below) is detachable: the controller
        // itself is the persistent room session (presence, polling, signaling,
        // WebRTC, remote audio), kept alive by lively.identity.RoomView._active
        // regardless of whether the window is open, collapsed or closed. Every
        // morph-touching method tolerates _viewRoot being null.
        this._win = null;
        this._viewRoot = null;
        this._remoteAudio = {};     // did -> <audio> element, session-owned so audio survives the window closing
        this._rosterRefreshTimers = [];  // pending signaling-triggered roster refreshes (see _scheduleRosterRefresh)
        this._railTimer = null;          // polls the rooms rail while the view exists
        this._originX = 0;        // view-relative: the view root is its own coordinate space, always (0,0)
        this._originY = 0;

        // WebRTC mesh state (see "webrtc" category)
        this._signalingWs = null;
        this._signalingIntentionallyClosed = false;
        this._pendingSignalingToken = null;
        this._mySignalingPeerId = null;
        this._signalingRejectStreak = 0;  // consecutive join-rejected in a row, see _onSignalingMessage
        this._peerMeta = {};        // signaling peerId -> {did, handle}, known as soon as a peer is announced
        this._signalingPeers = {};  // signaling peerId -> {pc, did, handle, pendingIce}, only once a pc exists
        this._didToPeerId = {};     // did -> signaling peerId, for looking up a peer by roster identity
        this._blockedPeerIds = {};  // signaling peerId -> true, for a peer isBlocked() at join time — see _onSignalingSignal
        this._remoteStreams = {};   // did -> MediaStream, latest known remote stream per participant
        this._screenStream = null;  // my own screen capture while sharing
        this._screenStreams = {};   // did -> MediaStream of that participant's shared screen
        this._screenSurfaces = {};  // did -> floating screen tile morph
      },
    },

    // ─── boot ─────────────────────────────────────────────────────────────────

    "boot", {

      open: function (name, roomId) {
        this._name = name;
        this._roomId = roomId;
        // Re-render the chat list live when a block/mute is applied/removed
        // from a MiniProfileCard opened inside this room (DID.js's
        // relationships category), so a just-blocked participant's messages
        // collapse immediately instead of waiting for the next poll.
        // Disconnected in _stopSession.
        lively.bindings.connect(lively.identity.did, "relationshipsChanged", this, "_renderMessages");
        // DID.js's restoreSession() is a multi-step async chain kicked off at
        // module-load time — reading currentUser() synchronously at a fixed
        // boot point (as everything below this does: seeding "you" into mock
        // chat, matching yourself in the member list/video circles) races it
        // with no ordering guarantee. restoreSession is idempotent, so
        // calling it again here just gets a definitive answer either way
        // before proceeding — same fix idiom as Shop.js/ConstellationLounge.js's
        // own boot-time identity reads.
        var self = this;
        lively.identity.did.restoreSession(function () { self._fetchRoomDetail(); });
      },

      _fetchRoomDetail: function () {
        var self = this;
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("GET", base + "/c/" + encodeURIComponent(this._name) + "/rooms/" + this._roomId, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) {
            return self._showFatalError(
              xhr.status === 404
                ? "This cluster doesn't exist, or you don't have access to it."
                : "Failed to load cluster (" + xhr.status + ")"
            );
          }
          var data;
          try { data = JSON.parse(xhr.responseText); }
          catch (e) { return self._showFatalError("Bad cluster response"); }
          if (self._roomLeft) return; // left (or switched rooms) while this was in flight
          self._room = data.room;
          self._isController = !!data.isController;
          self._participants = data.participants || [];
          // Only now is it known whether this is a call room or a text room, so
          // registration (which may have to end the current call first) happens here.
          lively.identity.RoomView._register(self, function () { self._start(); });
        };
        xhr.onerror = function () { self._showFatalError("Network error loading cluster"); };
        xhr.send();
      },

      // Computed once at boot (not re-centered on later resize, same fixed-
      // pixel-panel convention ConstellationLounge.js's own header comment
      // documents) — without this, every top-level box below is positioned
      // from a literal (0,0), which renders pinned to the browser's actual
      // top-left corner rather than centered in the visible world, exactly
      // the "renders at the top left of the page" bug reported live.
      // (Superseded: the view now lives in its own Window with its own
      // coordinate space, see "view" category — origin is always 0,0.)
      _computeOrigin: function () {
        this._originX = 0;
        this._originY = 0;
      },

      // A call room is an audio or video room. A text room (neither) is just
      // chat + roster: no signaling, no WebRTC, no media capture, no panel row.
      // A video room implies audio, including rooms saved before the create
      // dialog enforced that.
      _isCall: function () {
        return !!(this._room && (this._room.isVideo || this._room.isVoice));
      },

      // e2eeEnabled is set once at room creation and immutable after
      // (e2eeclusters.md §9's "Decisions locked in") — safe to read
      // straight off this._room wherever needed.
      _isE2ee: function () {
        return !!(this._room && this._room.e2eeEnabled);
      },

      // Mirrors the server-side e2ee_rotation_pending flag as of when this
      // room detail was last fetched (room-open time, or this controller's
      // own successful retry — see _retryRotation). A rotation performed by
      // ANOTHER client while this session is open won't clear this locally
      // until the room is reopened — the on-reopen refresh is the backstop,
      // not a live subscription (e2eeclusters.md §9.1's own framing).
      _rotationPending: function () {
        return this._isE2ee() && !!(this._room && this._room.e2eeRotationPending);
      },

      _callMediaKinds: function () {
        return { audio: true, video: !!(this._room && this._room.isVideo) };
      },

      // Video circles (self-view, remote pictures, name tags) exist only in video
      // rooms. An audio-only room has no pictures to show: people are listed in the
      // members panel and their voices play through the session-owned audio sink.
      _hasVideoCircles: function () {
        return !!(this._room && this._room.isVideo);
      },

      _start: function () {
        var isCall = this._isCall();
        this.showView();
        // Snapshot Invisible status once, at join time, not read live on every
        // heartbeat tick — a room already open when the user later flips to
        // Invisible must keep broadcasting presence normally (its video
        // circles/roster entry stay intact); only a room joined *while*
        // already Invisible skips announcing itself in the first place.
        this._presenceSuppressed = !!(lively.identity.AmbientPresencePanel &&
          lively.identity.AmbientPresencePanel.isInvisible && lively.identity.AmbientPresencePanel.isInvisible());
        this._joinPresence();
        this._startHeartbeat();
        this._loadMessages();
        this._startMessagePolling();
        if (isCall) this._connectSignaling();
        if (this._hasVideoCircles()) this._startSpeakerDetection();

        // A real page load still ends the session (see RoomView.open's header
        // note) — this only covers that case now, not window close/minimize.
        this._boundLeaveBestEffort = this._leaveBestEffort.bind(this);
        window.addEventListener("pagehide", this._boundLeaveBestEffort);
        window.addEventListener("beforeunload", this._boundLeaveBestEffort);

        var self = this;
        lively.require("lively.identity.AmbientPresencePanel").toRun(function () {
          if (self._roomLeft) return; // left again before the panel module finished loading
          if (!isCall) {
            // Text room: the panel's mic/camera/deafen buttons go inactive (no call).
            lively.identity.AmbientPresencePanel.refreshControls();
            return;
          }
          var kinds = self._callMediaKinds();
          lively.identity.AmbientPresencePanel.enterRoom({
            constellation: self._name, roomId: self._roomId, roomName: self._room.name,
            audio: kinds.audio, video: kinds.video,
            onLeaveRequested: function () { self.leave(); },
            onShowRequested: function () { self.showView(); },
          });
          // getUserMedia resolves asynchronously (real permission prompt) —
          // the self video circle already exists (blank) from
          // _renderVideoCircles above, so poll briefly for the stream and
          // fill it in once ready rather than re-creating the circle. Also
          // pushes the now-ready local tracks onto any peer connections
          // that were already established before the stream resolved (see
          // _waitForLocalStreamThenFill below).
          self._waitForLocalStreamThenFill(20);
        });
      },

      // attemptsLeft drives a fast ~6s burst (20 x 300ms) for the common
      // case — getUserMedia resolving quickly, or mic/cam permission
      // already granted in an earlier session — but never actually gives
      // up: once attemptsLeft reaches 0 this keeps polling indefinitely,
      // just at a slower 3s cadence, until the room is left (_roomLeft) or
      // the stream shows up. Confirmed live with a real human tester: an
      // actual person reliably takes longer than 6s to respond to the
      // browser's camera/mic permission prompt (unlike every account
      // tested so far, which had permissions pre-granted on the
      // automation profile) — any peer connection already established
      // before that point got stuck permanently recvonly for that
      // person's outbound audio/video once the old bounded loop gave up,
      // since nothing else ever calls _applyLocalTracksToAllPeers again.
      // The WebRTC renegotiation logic itself was never the problem here
      // (see _applyLocalTracksToPeer/_onNegotiationNeeded) — it just never
      // got a chance to run.
      _waitForLocalStreamThenFill: function (attemptsLeft) {
        if (this._roomLeft) return;
        var user = lively.identity.did.currentUser();
        var myDid = user ? user.did : null;
        var self0 = this;
        var ownSurfaces = myDid ? this._videoSurfaces(myDid) : [];
        var filledOwnCircle = ownSurfaces.length > 0 && ownSurfaces.every(function (s) {
          return s._hasLocalVideo || self0._fillWithLocalStream(s);
        });
        // Any peer connection already established (webrtc category, below)
        // before getUserMedia resolved was created with recvonly-capable
        // transceivers and no local tracks yet — push them in now that the
        // stream is ready, same one-time "fill in once ready" idea as the
        // self circle above.
        var pushedToPeers = this._applyLocalTracksToAllPeers();
        // No view attached (window closed): there's no own circle to fill, so
        // pushing tracks to peers is all that's left to do — a later
        // showView() fills the circle itself via _renderVideoCircles. Same when the
        // room has no circles at all (audio-only): there's no self view to wait for.
        if (pushedToPeers && (filledOwnCircle || !ownSurfaces.length || !this._hasVideoCircles())) return;
        var self = this;
        var remaining = attemptsLeft > 0 ? attemptsLeft - 1 : 0;
        var delay = attemptsLeft > 0 ? 300 : 3000;
        setTimeout(function () { self._waitForLocalStreamThenFill(remaining); }, delay);
      },

      _showFatalError: function (msg) {
        console.error("[RoomView]", msg);
        // Never became a session: free the singleton slot so the next Enter starts clean.
        this._roomLeft = true;
        lively.identity.RoomView._sessionEnded(this);
        var label = noDrag(lively.morphic.Text.makeLabel(msg, {
          fontSize: 14, textColor: Color.rgb(220, 220, 220), fill: Color.rgba(30, 30, 30, 0.92),
          fixedWidth: true, fixedHeight: true,
        }));
        label.setExtent(lively.pt(420, 80));
        label.setPosition($world.visibleBounds().center().subPt(lively.pt(210, 40)));
        label.applyStyle({ align: "center" });
        $world.addMorph(label);
        // This now shows inside a live world the user is working in, not a
        // dead boot page, so it can't linger.
        setTimeout(function () { try { label.remove(); } catch (e) {} }, 5000);
      },

    },

    // ─── view — the detachable window ──────────────────────────────────────────
    // There is exactly one room/cluster Window per world, owned by the
    // lively.identity.RoomView registry (see "registry" below), not by any one
    // controller. Entering a different room swaps that window's content rather
    // than opening a second window. Closing or collapsing the window never
    // touches a call session: presence, chat polling, signaling, peer
    // connections and remote audio all keep running on the controller; only
    // leave() (or a real page load) ends them. A TEXT room has no call to keep
    // alive in the background, though, so losing the window — closed, or its
    // content swapped to a different room — ends a text room's session too
    // (see _onViewReplaced). showView() rebuilds the UI from the session's
    // current state, so a controller whose content isn't currently shown can
    // be brought back at any time (the Ambient Presence Panel's "In room" row
    // does exactly that).

    "view", {

      // (Re)builds this controller's own content into the shared window —
      // called only once RoomView._showController has already pointed
      // this._viewRoot/this._win at the shared window (see registry below).
      _renderView: function () {
        var self = this;
        this._win.setTitle((this._room && this._room.name) || "Cluster");
        this._windowCollapsed = false;
        this._computeOrigin();
        this._buildHeader();
        this._buildRoomsPanel();
        this._buildChatPanel();
        this._renderReplyComposeStrip(); // picks up the rotation-pending banner, if any, at open time
        this._buildMembersPanel();
        this._buildVideoLayer();
        this._renderMembers();
        this._syncVideoMode();
        this._renderMessages();

        // The rail's counts for OTHER rooms only change on the server, and this
        // window would otherwise only re-read them on the roster refresh.
        if (this._railTimer) clearInterval(this._railTimer);
        this._railTimer = setInterval(function () {
          if (!self._roomLeft && self._roomsPanelBox && !document.hidden) self._fetchRoomsList();
        }, RAIL_POLL_MS);
      },

      // One-time scrollbar recolor for this view's three scrollable panels
      // (rooms rail, chat message list, members) — same idiom as
      // ConstellationLounge.js's _ensureCommentBodyStyle: a single injected
      // <style> tag (guarded by id so re-opening the view doesn't duplicate
      // it), with each scrollable box's shapeNode tagged with one of two
      // classes depending on which BG it sits on. "-dark" pairs a light
      // purple (BG_MAIN's own A87BED) thumb against the BG_SIDEBAR track for
      // the rail/members panels; "-light" inverts that — a dark ACCENT thumb
      // against the now-light BG_MAIN track — for the chat message list.
      _ensureScrollbarStyle: function () {
        if (document.getElementById("roomview-scrollbar-style")) return;
        var styleEl = document.createElement("style");
        styleEl.id = "roomview-scrollbar-style";
        styleEl.textContent =
          ".roomview-scroll-dark{scrollbar-width:thin;scrollbar-color:#A87BED #4F0B43;}" +
          ".roomview-scroll-dark::-webkit-scrollbar{width:10px;}" +
          ".roomview-scroll-dark::-webkit-scrollbar-track{background:#4F0B43;}" +
          ".roomview-scroll-dark::-webkit-scrollbar-thumb{background:#A87BED;border-radius:999px;border:2px solid #4F0B43;}" +
          ".roomview-scroll-dark::-webkit-scrollbar-thumb:hover{background:#C3A6F5;}" +
          ".roomview-scroll-light{scrollbar-width:thin;scrollbar-color:#4F0B43 #A87BED;}" +
          ".roomview-scroll-light::-webkit-scrollbar{width:10px;}" +
          ".roomview-scroll-light::-webkit-scrollbar-track{background:#A87BED;}" +
          ".roomview-scroll-light::-webkit-scrollbar-thumb{background:#4F0B43;border-radius:999px;border:2px solid #A87BED;}" +
          ".roomview-scroll-light::-webkit-scrollbar-thumb:hover{background:#38082F;}";
        document.head.appendChild(styleEl);
      },

      // Makes this controller's content the one shown in the shared room
      // window — bringing it forward if it's already current, otherwise
      // asking the registry to take over the (possibly just-created) window.
      showView: function () {
        if (this._roomLeft || !this._room) return; // no room detail yet (still loading) — nothing to show
        var RV = lively.identity.RoomView;
        if (RV._shown === this && RV._win) {
          if (RV._win.isCollapsed && RV._win.isCollapsed()) RV._win.expand();
          if (RV._win.comeForward) RV._win.comeForward();
          return;
        }
        RV._showController(this);
      },

      // Called by the registry whenever this controller's content stops being
      // what's shown in the shared window — either the window was actually
      // closed (its own X button; the Window morph removes itself right after
      // this returns) or another room is about to take over the same,
      // still-open window. Either way: hand video off to world-owned circles
      // first, detach my own morphs, and — if I'm a text room, with no call to
      // keep alive in the background — end my session too. (View refs are
      // already detached by the time leave() runs, so it won't try to remove
      // the window a second time; see _destroyView.)
      _onViewReplaced: function () {
        this._windowCollapsed = true;
        this._syncVideoMode();
        this._detachViewRefs();
        if (!this._isCall()) this.leave();
      },

      // Drops every reference into the (going or gone) view so background
      // session work (roster refresh, polling, ontrack) sees "no view" and skips
      // its rendering. The grid tiles go with the window. Video circles are
      // world-owned and stand in for the window while it's closed: they stay
      // while the call is live and are removed when the call ends (or when their
      // participant leaves, see _renderVideoCircles).
      //
      // The shared window's content root can survive this call (another
      // controller may take it over right after — see RoomView._showController),
      // so this has to actually remove my own child morphs, not just drop my
      // references to them.
      _detachViewRefs: function () {
        [this._headerBox, this._roomsPanelBox, this._chatBox, this._membersBox, this._gridBox].forEach(function (m) {
          try { if (m && m.owner) m.remove(); } catch (e) {}
        });
        if (this._railTimer) { clearInterval(this._railTimer); this._railTimer = null; }
        if (this._renderSoonTimer) { clearTimeout(this._renderSoonTimer); this._renderSoonTimer = null; }
        this._rowCache = null;
        this._rowCacheOwner = null;
        this._composerGrow = 0;
        this._clearGrid();
        if (this._roomLeft) this._clearCircles();
        this._gridBox = null;
        this._chatToggleBtn = null;
        this._pickerBtns = [];
        this._chatW = CHAT_W;
        try { if (this._mediaPicker && this._mediaPicker.isOpen()) this._mediaPicker.close(); } catch (e) {}
        this._headerBox = null;
        this._roomsPanelBox = null;
        this._chatBox = null;
        this._msgListBox = null;
        this._inputRowM = null;
        this._inputM = null;
        this._placeholderM = null;
        this._membersBox = null;
        this._membersHeading = null;
        this._countM = null;
        this._viewRoot = null;
        this._win = null;
      },

      // Programmatic close (leaving the room): detach, then remove the window.
      _destroyView: function () {
        var win = this._win;
        this._detachViewRefs();
        if (win && win.owner) win.remove();
      },

    },

    // ─── presence — join/heartbeat/leave ───────────────────────────────────────
    // Same POST/DELETE .../presence + 25s-heartbeat idiom ConstellationLounge.js's
    // _joinRoom/_startHeartbeat/_leaveAllRoomsBestEffort already use — this page
    // is always allowed to join (canJoinRoom already gated booting the world at
    // all, server-side), so failures here are logged, not surfaced as a denial.

    "presence", {

      _joinPresence: function () {
        if (this._presenceSuppressed) {
          // Invisible: don't announce this room, but still pull the roster
          // once so the invisible user's own view of who else is here isn't
          // left empty until the next 25s heartbeat tick.
          this._refreshRoster();
          return;
        }
        var self = this;
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("POST", base + "/c/" + encodeURIComponent(this._name) + "/rooms/" + this._roomId + "/presence", true);
        xhr.withCredentials = true;
        // The room-detail fetch that seeded this._participants ran *before*
        // this join, so it never included yourself — refresh right away
        // rather than leaving the member list/your own video circle missing
        // until the next 25s heartbeat tick.
        xhr.onload = function () {
          if (xhr.status !== 200 || self._roomLeft) return;
          self._refreshRoster();
          lively.identity.RoomView._notify(self); // lets an open lounge refresh its headcounts / "Enter" state
        };
        xhr.onerror = function () { console.error("[RoomView] Network error joining room presence"); };
        xhr.send();
      },

      _startHeartbeat: function () {
        var self = this;
        this._heartbeatTimer = setInterval(function () {
          self._sendHeartbeat();
          self._refreshRoster();
        }, 25000);
      },

      _sendHeartbeat: function () {
        if (this._presenceSuppressed) return; // Invisible: never re-announce this room
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("POST", base + "/c/" + encodeURIComponent(this._name) + "/rooms/" + this._roomId + "/presence", true);
        xhr.withCredentials = true;
        xhr.send();
      },

      // Someone joined or left the call (signaling peer-joined / peer-left):
      // re-read the roster now instead of waiting for the 25s heartbeat, which
      // is what made the member list, header count and rooms rail lag by up to
      // 25s (measured live). Fires twice: a peer's signaling socket can close a
      // moment before its presence DELETE lands, so the early read may still
      // list them and the second one settles it.
      _scheduleRosterRefresh: function () {
        var self = this;
        this._rosterRefreshTimers.forEach(clearTimeout);
        this._rosterRefreshTimers = [300, 1800].map(function (ms) {
          return setTimeout(function () { if (!self._roomLeft) self._refreshRoster(); }, ms);
        });
      },

      // Re-fetches the room detail JSON to pick up roster/participant-count
      // changes (other people joining/leaving) — reuses the same GET this
      // page's own boot already made, rather than a second bespoke route.
      _refreshRoster: function () {
        var self = this;
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("GET", base + "/c/" + encodeURIComponent(this._name) + "/rooms/" + this._roomId, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) return;
          var data;
          try { data = JSON.parse(xhr.responseText); } catch (e) { return; }
          if (self._roomLeft) return;
          var before = self._participants.map(function (p) { return p.did; }).sort().join(",");
          self._participants = data.participants || [];
          var changed = before !== self._participants.map(function (p) { return p.did; }).sort().join(",");
          self._renderMembers();
          self._syncVideoMode();
          self._updateParticipantCount();
          self._fetchRoomsList(); // keeps the left rail's "N here" counts fresh too
          // Tell an open lounge in this world (its Spaces cards) the headcount moved.
          if (changed) lively.identity.RoomView._notify(self);
          // Refines the dots just rendered above once real statuses land —
          // never blocks this render, which already used whatever was
          // cached from the previous call (or defaulted to online).
          self._fetchMemberStatuses();
        };
        xhr.send();
      },

      // Batch-fetches every current participant's status (Online/Idle/Do Not
      // Disturb/Invisible) via IdentityServer's GET /statuses?dids=... route
      // (AmbientPresencePanel.js's own per-user status GET is built on the
      // same underlying table/read path) and re-renders the member dots once
      // it lands. Never blocks the roster render that triggered it — that
      // one already painted with whatever was cached from the previous call,
      // or defaulted to online for a did never seen before.
      _fetchMemberStatuses: function () {
        var self = this;
        var dids = this._participants.map(function (p) { return p.did; }).filter(Boolean);
        if (!dids.length) return;
        var base = lively.identity.did.baseUrl();
        fetch(base + "/statuses?dids=" + encodeURIComponent(dids.join(",")), { credentials: "include" })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (result) {
            if (!result || self._roomLeft) return;
            self._memberStatuses = result.statuses || {};
            self._renderMembers();
          })
          .catch(function () {});
      },

      // Stops every piece of session machinery (timers, signaling, peer
      // connections, remote audio, page-lifecycle hooks). Shared by leave()
      // and _leaveBestEffort. Both timers matter now that leaving no longer
      // navigates away: nothing else kills them, and a surviving heartbeat
      // would silently re-join presence right after the DELETE.
      _stopSession: function () {
        this._roomLeft = true;
        try { lively.bindings.disconnect(lively.identity.did, "relationshipsChanged", this, "_renderMessages"); } catch (e) {}
        try { this.stopScreenShare(); } catch (e) {}   // before signaling closes, so viewers are told
        var selfForScreens = this;
        Object.keys(this._screenSurfaces).forEach(function (did) { selfForScreens._removeScreenSurface(did); });
        if (this._messagePollTimer) { clearInterval(this._messagePollTimer); this._messagePollTimer = null; }
        if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
        try { this._teardownSignaling(); } catch (e) {}
        var self = this;
        Object.keys(this._remoteAudio).forEach(function (did) { self._removeRemoteAudio(did); });
        this._rosterRefreshTimers.forEach(clearTimeout);
        this._rosterRefreshTimers = [];
        this._stopSpeakerDetection();
        if (this._blackTimer) { clearInterval(this._blackTimer); this._blackTimer = null; }
        if (this._blackTrack) { try { this._blackTrack.stop(); } catch (e) {} this._blackTrack = null; }
        if (this._boundLeaveBestEffort) {
          window.removeEventListener("pagehide", this._boundLeaveBestEffort);
          window.removeEventListener("beforeunload", this._boundLeaveBestEffort);
          this._boundLeaveBestEffort = null;
        }
      },

      // Ends the call for real: presence DELETE, media released, window closed,
      // panel row hidden. `done` (optional) runs once the DELETE has settled,
      // so a caller switching rooms can start the next join strictly after it.
      leave: function (done) {
        if (this._roomLeft) { if (done) done(); return; }
        var self = this;
        var finished = false;
        function finish() {
          if (finished) return;
          finished = true;
          lively.identity.RoomView._sessionEnded(self);
          if (done) done();
        }
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("DELETE", base + "/c/" + encodeURIComponent(this._name) + "/rooms/" + this._roomId + "/presence", true);
        xhr.withCredentials = true;
        xhr.onload = finish;
        xhr.onerror = finish;
        xhr.send();
        // After the DELETE is on the wire, not before: closing signaling makes
        // every other member get a peer-left and re-read the roster, and that
        // read should find this presence already gone.
        this._stopSession();
        // Only a call room owns the panel's call state — leaving a text room
        // must not tear down a call running in another window.
        if (this._isCall()) { try { lively.identity.AmbientPresencePanel.leaveRoom(); } catch (e) {} }
        this._destroyView();
      },

      // Was a synchronous XHR here (pagehide/beforeunload need something
      // guaranteed to send before the page tears down) -- verified live
      // 2026-09-01 that this assumption no longer holds: a synchronous XHR
      // fired from a beforeunload handler never reached the server at all
      // in the current browser (confirmed via a network-log check across
      // multiple real navigations -- the request simply never appeared,
      // not even as a failed/cancelled entry). fetch's `keepalive` flag is
      // the purpose-built modern replacement for exactly this "survive
      // page teardown" case and, unlike sendBeacon, supports DELETE --
      // confirmed live it actually gets dispatched with the session cookie
      // attached (sendBeacon can only do POST, which is why the original
      // comment ruled it out).
      _leaveBestEffort: function () {
        this._stopSession();
        var base = lively.identity.did.baseUrl();
        try {
          fetch(base + "/c/" + encodeURIComponent(this._name) + "/rooms/" + this._roomId + "/presence", {
            method: "DELETE", keepalive: true, credentials: "same-origin",
          }).catch(function () {});
        } catch (e) {}
        if (this._isCall()) { try { lively.identity.AmbientPresencePanel.leaveRoom(); } catch (e) {} }
      },

    },

    // ─── chrome — header ────────────────────────────────────────────────────────

    "chrome", {

      _buildHeader: function () {
        var self = this;
        var header = noDrag(new lively.morphic.Box(lively.rect(this._originX, this._originY, TOTAL_W, HEADER_H)));
        header.applyStyle({ fill: BG_SIDEBAR, borderWidth: 0 });
        this._viewRoot.addMorph(header);
        this._headerBox = header;

        var nameM = noDrag(lively.morphic.Text.makeLabel(this._room.name || "", {
          fontSize: 15, fontWeight: "700", textColor: TEXT_PRIMARY, fixedWidth: true, fixedHeight: true,
        }));
        nameM.eventsAreIgnored = true;
        nameM.setPosition(lively.pt(16, 13));
        // 20 clipped the bottom of any descender (g/y/p in a room name) —
        // confirmed live via the shapeNode's own scrollHeight (~23px for
        // 15px bold text); 24 covers it with a little headroom rather
        // than the exact measured minimum.
        nameM.setExtent(lively.pt(300, 24));
        header.addMorph(nameM);

        var ICON = 18, ICON_GAP = 6;
        var icons = [];
        var room = this._room;
        if (room.isVideo) icons.push("videocam");
        if (room.isVoice) icons.push("headset");
        if (!room.isVideo && !room.isVoice) icons.push("chat");
        var ix = 16;
        var textW = nameM.renderContext().shapeNode.querySelector("span");
        ix += (textW ? textW.offsetWidth : 100) + 12;
        icons.forEach(function (glyph) {
          // Pink for an ephemeral room's chat glyph — same COMMENT_ACCENT
          // used everywhere else in this app for the ephemeral/pink accent,
          // see ConstellationLounge.js's room-card icons.
          var isEphemeralChat = glyph === "chat" && room.ephemeral;
          var g = noDrag(lively.morphic.Text.makeLabel(glyph, {
            fontSize: 11, textColor: isEphemeralChat ? Color.rgb(232, 73, 126) : TEXT_MUTED,
          }));
          g.applyStyle({ fontFamily: "'Material Symbols Rounded'", borderWidth: 0 });
          g.eventsAreIgnored = true;
          g.setExtent(lively.pt(ICON, ICON));
          g.setPosition(lively.pt(ix, 15));
          header.addMorph(g);
          ix += ICON + ICON_GAP;
        });

        this._countM = noDrag(lively.morphic.Text.makeLabel("", {
          fontSize: 12, textColor: TEXT_MUTED, fixedWidth: true, fixedHeight: true,
        }));
        this._countM.eventsAreIgnored = true;
        // 18 clipped the bottom of any descender in "N here" — confirmed
        // live (~19px real content height for 12px text); 20 covers it.
        this._countM.setExtent(lively.pt(160, 20));
        this._countM.setPosition(lively.pt(ix + 8, 14));
        header.addMorph(this._countM);
        this._updateParticipantCount();

        var LEAVE_H = 30, LEAVE_Y = 9, LEAVE_HPAD = 18;
        var leaveBtn = noDrag(new lively.morphic.Box(lively.rect(TOTAL_W - 16 - 110, LEAVE_Y, 110, LEAVE_H)));
        leaveBtn.applyStyle({ fill: DANGER, borderWidth: 0, borderRadius: 15 });
        header.addMorph(leaveBtn);
        var leaveLabel = lively.morphic.Text.makeLabel("Drift", {
          fontSize: 12.5, fontWeight: "700", textColor: Color.white, fixedWidth: true, fixedHeight: true,
        });
        // 20 clipped the bottom of "away"'s descending "y" by 2px —
        // confirmed live via getBoundingClientRect on the rendered span
        // vs. the label's own clipped shapeNode (spanBottom 2px past
        // shapeBottom at height 20; 0px overflow, i.e. no clipping, at
        // 22). y=2.3 (not the naively-centered 5) is the live-measured
        // offset that actually centers the glyph in the 30px-tall button
        // -- confirmed via getBoundingClientRect on the button vs. the
        // rendered span (topGap/bottomGap within ~0.1px of each other at
        // 2.3; plain model-space centering at y=5 left an 8.3px top gap
        // vs. a 3px bottom gap, visibly low).
        // Throwaway 110-wide extent so it doesn't wrap while measuring --
        // re-hugged to its own measured span width below (same idiom as
        // statusLbl in ConstellationLounge._renderRoomCard).
        leaveLabel.setExtent(lively.pt(110, 22));
        leaveLabel.setPosition(lively.pt(0, 2.3));
        leaveLabel.applyStyle({ align: "center", borderWidth: 0 });
        leaveLabel.eventsAreIgnored = true;
        leaveBtn.addMorph(leaveLabel);

        var leaveSpan = leaveLabel.renderContext().shapeNode.querySelector("span");
        var leaveTextW = leaveSpan ? leaveSpan.offsetWidth : 40;
        var leaveBtnW = leaveTextW + LEAVE_HPAD * 2;
        leaveBtn.setExtent(lively.pt(leaveBtnW, LEAVE_H));
        leaveBtn.setPosition(lively.pt(TOTAL_W - 16 - leaveBtnW, LEAVE_Y));
        leaveLabel.setExtent(lively.pt(leaveBtnW, 22));
        leaveBtn.onMouseDown = function () { self.leave(); };

        // Search — persistent rooms only (an ephemeral room's messages are
        // never stored, so there's nothing to search; see
        // ObjectRepository.searchRoomMessages's own header comment). Same
        // icon-button idiom as the gear button just below, sitting
        // immediately left of it (or of Drift, if this viewer has no
        // gear button to manage the room).
        var rightEdge = TOTAL_W - 16 - leaveBtnW;
        if (this._room && !this._room.ephemeral) {
          var SEARCH_BTN = 26, SEARCH_GLYPH_PX = 18;
          var searchBtn = new lively.morphic.Text(lively.rect(rightEdge - 10 - SEARCH_BTN, 9, SEARCH_BTN, SEARCH_BTN));
          searchBtn.textString = "search";
          searchBtn.applyStyle({
            fontFamily: "'Material Symbols Rounded'",
            fontSize: SEARCH_GLYPH_PX * 0.75,
            textColor: this._searchActive ? Color.white : TEXT_MUTED,
            fill: this._searchActive ? Color.rgba(232, 73, 126, 0.5) : Color.rgba(255, 255, 255, 0.08),
            borderRadius: SEARCH_BTN / 2,
            borderWidth: 1,
            borderColor: Color.rgba(255, 255, 255, 0.16),
            align: "center",
            padding: lively.Rectangle.inset(0, Math.round((SEARCH_BTN - SEARCH_GLYPH_PX) / 2), 0, 0),
            allowInput: false,
            selectable: false,
            clipMode: "hidden",
            whiteSpaceHandling: "pre",
            handStyle: "pointer",
          });
          noDrag(searchBtn);
          searchBtn.toolTip = "Search messages";
          searchBtn.onMouseOver = function () { if (!self._searchActive) searchBtn.applyStyle({ fill: Color.rgba(255, 255, 255, 0.16) }); };
          searchBtn.onMouseOut = function () { if (!self._searchActive) searchBtn.applyStyle({ fill: Color.rgba(255, 255, 255, 0.08) }); };
          searchBtn.onMouseUp = function (evt) {
            self._toggleSearch();
            evt.stop();
            return true;
          };
          header.addMorph(searchBtn);
          rightEdge -= (10 + SEARCH_BTN);
        }

        // Settings gear -- creator-or-controller only (this._room.canManage,
        // computed server-side by canManageRoom, IdentityServer.js), same
        // icon-button idiom as the room card's own gear
        // (ConstellationLounge.js's _renderRoomCard). Sits just left of
        // the Drift button; no capture-phase hazard here since the
        // header box itself has no competing onMouseDown of its own.
        if (this._room && this._room.canManage) {
          var GEAR = 26, GEAR_GLYPH_PX = 18;
          var gearBtn = new lively.morphic.Text(lively.rect(rightEdge - 10 - GEAR, 9, GEAR, GEAR));
          gearBtn.textString = "settings";
          gearBtn.applyStyle({
            fontFamily: "'Material Symbols Rounded'",
            fontSize: GEAR_GLYPH_PX * 0.75,
            textColor: TEXT_MUTED,
            fill: Color.rgba(255, 255, 255, 0.08),
            borderRadius: GEAR / 2,
            borderWidth: 1,
            borderColor: Color.rgba(255, 255, 255, 0.16),
            align: "center",
            padding: lively.Rectangle.inset(0, Math.round((GEAR - GEAR_GLYPH_PX) / 2), 0, 0),
            allowInput: false,
            selectable: false,
            clipMode: "hidden",
            whiteSpaceHandling: "pre",
            handStyle: "pointer",
          });
          noDrag(gearBtn);
          gearBtn.toolTip = "Cluster settings";
          gearBtn.onMouseOver = function () { gearBtn.applyStyle({ fill: Color.rgba(255, 255, 255, 0.16) }); };
          gearBtn.onMouseOut = function () { gearBtn.applyStyle({ fill: Color.rgba(255, 255, 255, 0.08) }); };
          gearBtn.onMouseUp = function (evt) {
            self._openRoomSettings();
            evt.stop();
            return true;
          };
          header.addMorph(gearBtn);
        }
      },

      // Opens the shared RoomSettingsDialog (see ConstellationLounge.js's
      // _openRoomSettings for the same call) from this room's own header
      // gear. onSaved re-renders the header in place -- RoomView has no
      // room list to _fetchRooms() -- and, since a save can also archive
      // or permanently delete this very room out from under the viewer,
      // falls back to leave() when the room is gone rather
      // than rendering a header for a room that no longer exists.
      _openRoomSettings: function () {
        var self = this;
        lively.require("lively.identity.RoomSettingsDialog").toRun(function () {
          lively.identity.RoomSettingsDialog.open(self._name, self._room, function (result) {
            if (result && (result.deleted || result.archived)) return self.leave();
            var base = lively.identity.did.baseUrl();
            var xhr = new XMLHttpRequest();
            xhr.open("GET", base + "/c/" + encodeURIComponent(self._name) + "/rooms/" + self._roomId, true);
            xhr.withCredentials = true;
            xhr.onload = function () {
              if (xhr.status !== 200) return self.leave();
              var data = JSON.parse(xhr.responseText);
              self._room = data.room;
              if (!self._headerBox) return; // window was closed while the dialog was open
              (self._headerBox.submorphs || []).slice().forEach(function (m) { m.remove(); });
              self._headerBox.remove();
              self._buildHeader();
              if (self._win) self._win.setTitle(self._room.name || "Cluster");
            };
            xhr.onerror = function () {};
            xhr.send();
          });
        });
      },

      _updateParticipantCount: function () {
        if (!this._countM) return;
        var n = this._participants.length;
        this._countM.textString = n === 1 ? "1 here" : (n + " here");
      },

    },

    // ─── rooms panel ────────────────────────────────────────────────────────────
    // Left-hand rail listing every room in this constellation (name + live
    // participant count) — similar intent to WikiIndex.js's left sidebar
    // page list: a standing way to jump between rooms without first going
    // back to the Lounge. Fetches the same GET /c/:name/rooms
    // ConstellationLounge.js's Spaces panel already uses. Clicking a room
    // (other than the one you're already in) navigates straight into it,
    // same as clicking a room card in the Lounge.

    "rooms panel", {

      _buildRoomsPanel: function () {
        var panel = noDrag(new lively.morphic.Box(lively.rect(
          this._originX, this._originY + HEADER_H, ROOMS_PANEL_W, BODY_H)));
        // Vertical scroll only: rows are laid out at the panel's full width,
        // so the vertical scrollbar's own width pushed content past the
        // client width and produced a stray horizontal scrollbar.
        panel.applyStyle({ fill: BG_SIDEBAR, borderWidth: 0, clipMode: { x: "hidden", y: "auto" } });
        this._ensureScrollbarStyle();
        panel.renderContext().shapeNode.classList.add("roomview-scroll-dark");
        this._viewRoot.addMorph(panel);
        this._roomsPanelBox = panel;

        var heading = noDrag(lively.morphic.Text.makeLabel("CLUSTERS", {
          fontSize: 12, fontWeight: "700", textColor: TEXT_MUTED,
        }));
        heading.eventsAreIgnored = true;
        heading.setPosition(lively.pt(16, 16));
        heading.setExtent(lively.pt(ROOMS_PANEL_W - 32, 16));
        panel.addMorph(heading);

        this._fetchRoomsList();
      },

      _fetchRoomsList: function () {
        var self = this;
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("GET", base + "/c/" + encodeURIComponent(this._name) + "/rooms", true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) return;
          var data;
          try { data = JSON.parse(xhr.responseText); } catch (e) { return; }
          self._renderRoomsList(data.rooms || []);
        };
        xhr.send();
      },

      _renderRoomsList: function (rooms) {
        var self = this;
        var panel = this._roomsPanelBox;
        if (!panel) return;
        (panel._roomItemMorphs || []).forEach(function (m) { m.remove(); });
        panel._roomItemMorphs = [];

        // Row height grew (40 -> 60) to fit the new stacked-avatar row
        // below the name; ROW_GAP is the visible space between rows
        // (previously baked wordlessly into a flat 44px increment).
        var ROW_H = 60, ROW_GAP = 6;
        var y = 44;
        rooms.forEach(function (room) {
          var isCurrent = room.id === self._roomId;
          var row = noDrag(new lively.morphic.Box(lively.rect(8, y, ROOMS_PANEL_W - 16, ROW_H)));
          row.applyStyle({ fill: isCurrent ? ACCENT : null, borderWidth: 0, borderRadius: 6 });
          panel.addMorph(row);
          panel._roomItemMorphs.push(row);

          var nameM = noDrag(lively.morphic.Text.makeLabel(room.name || "", {
            fontSize: 13, fontWeight: isCurrent ? "700" : "500",
            textColor: isCurrent ? Color.white : TEXT_PRIMARY, fixedWidth: true, fixedHeight: true,
          }));
          nameM.eventsAreIgnored = true;
          nameM.setPosition(lively.pt(10, 6));
          // Room type icons (same set as the Lounge's room cards),
          // right-aligned on the name row; the name label shrinks to
          // leave room for them.
          var TYPE_ICON = 18, TYPE_ICON_GAP = 4;
          var typeIcons = [];
          if (room.isVideo) typeIcons.push("videocam");
          if (room.isVoice) typeIcons.push("headset");
          if (!room.isVideo && !room.isVoice) typeIcons.push("chat");
          var rowW = ROOMS_PANEL_W - 16;
          var typeIconsW = typeIcons.length * TYPE_ICON + (typeIcons.length - 1) * TYPE_ICON_GAP;
          // 16 clipped the bottom of any descender (g/y/p in a room name)
          // — confirmed live via the shapeNode's own scrollHeight (~21px
          // for 13px bold text, same shapeNode-padding story as
          // ConstellationLounge.js's own label-height gotchas); 22 covers
          // it with a little headroom rather than the exact measured min.
          nameM.setExtent(lively.pt(rowW - 20 - typeIconsW - 6, 22));
          row.addMorph(nameM);
          var tix = rowW - 10 - typeIconsW;
          typeIcons.forEach(function (glyph) {
            // Pink for an ephemeral room's chat glyph, same as the Lounge's
            // room cards and this window's own header — except on the
            // current (highlighted) row, where white stays for contrast
            // against the accent-colored background.
            var isEphemeralChat = glyph === "chat" && room.ephemeral && !isCurrent;
            // Entering an audio/video room establishes a live WebRTC session
            // immediately (no separate "join call" step), and that session
            // keeps running in the background even after switching to a
            // different (e.g. text) room's window -- see RoomView._active.
            // So the green flag tracks the actual live call (RoomView.getActive,
            // matched by room id + cluster name), not isCurrent/"which room
            // this window happens to be showing right now" -- those are two
            // different things once a call and a text room can be open at once.
            var liveCall = lively.identity.RoomView.getActive();
            var isLiveCallRoom = !!liveCall && liveCall._roomId === room.id && liveCall._name === self._name;
            var isActiveMediaIcon = isLiveCallRoom && (glyph === "videocam" || glyph === "headset");
            var g = noDrag(lively.morphic.Text.makeLabel(glyph, {
              fontSize: 11, textColor: isActiveMediaIcon ? ONLINE : (isCurrent ? Color.white : (isEphemeralChat ? Color.rgb(232, 73, 126) : TEXT_MUTED)),
            }));
            g.applyStyle({ fontFamily: "'Material Symbols Rounded'", borderWidth: 0 });
            g.eventsAreIgnored = true;
            g.setExtent(lively.pt(TYPE_ICON, TYPE_ICON));
            g.setPosition(lively.pt(tix, 8));
            row.addMorph(g);
            tix += TYPE_ICON + TYPE_ICON_GAP;
          });

          // Stacked participant avatars — same overlapping white-ring-
          // cutout technique as ConstellationLounge.js's _renderRoomCard,
          // sized down for this rail's width. `room.participants` is
          // already capped server-side (roomPresence.summary's maxSeed,
          // same GET /c/:name/rooms response RoomView.js's own rooms
          // panel already fetches) — no new server work needed.
          var avatarRowY = 32;
          var seeds = room.participants || [];
          var shown = seeds.slice(0, ROOM_ROW_MAX_SHOWN);
          var ax = 10;
          shown.forEach(function (seed) {
            var rs = ROOM_ROW_AV + ROOM_ROW_RING * 2;
            var ring = noDrag(new lively.morphic.Box(lively.rect(ax - ROOM_ROW_RING, avatarRowY - ROOM_ROW_RING, rs, rs)));
            ring.applyStyle({ fill: isCurrent ? ACCENT : BG_SIDEBAR, borderRadius: rs / 2, borderWidth: 0 });
            ring.eventsAreIgnored = true;
            row.addMorph(ring);
            var av = noDrag(new lively.morphic.Image(lively.rect(ax, avatarRowY, ROOM_ROW_AV, ROOM_ROW_AV)));
            av.setImageURL(lively.identity.postCardUtils.identiconDataUrl(seed, ROOM_ROW_AV));
            av.applyStyle({ borderRadius: ROOM_ROW_AV / 2, borderWidth: 0, clipMode: "hidden" });
            av.eventsAreIgnored = true;
            row.addMorph(av);
            ax += ROOM_ROW_AV - ROOM_ROW_OVERLAP;
          });
          if (shown.length) ax += ROOM_ROW_OVERLAP + 6;

          var count = room.participantCount || 0;
          var countM = noDrag(lively.morphic.Text.makeLabel(
            count === 1 ? "1 here" : (count + " here"),
            {
              fontSize: 12, textColor: isCurrent ? Color.rgba(255, 255, 255, 0.75) : TEXT_FAINT,
              fixedWidth: true, fixedHeight: true,
            }
          ));
          countM.eventsAreIgnored = true;
          countM.setPosition(lively.pt(ax, avatarRowY + 1));
          // Same descender-clip fix as nameM above — 11px text measured
          // needing ~17px, 18 gives a little headroom.
          countM.setExtent(lively.pt(Math.max(30, ROOMS_PANEL_W - 16 - ax - 10), 18));
          row.addMorph(countM);

          if (!isCurrent) {
            row.renderContext().shapeNode.style.cursor = "pointer";
            row.onMouseOver = function () { row.applyStyle({ fill: BG_ROW_HOVER }); };
            row.onMouseOut = function () { row.applyStyle({ fill: null }); };
            // RoomView.open decides what this means: a call room replaces the
            // current call (leaving it first); a text room replaces whatever
            // is currently shown in the shared window (leaving it first, if
            // that was a text room too) but never touches a call running in
            // the background.
            row.onMouseDown = function () {
              lively.identity.RoomView.open(self._name, room.id);
            };
          }

          y += ROW_H + ROW_GAP;
        });
      },

    },

    // ─── chat panel ─────────────────────────────────────────────────────────────
    // Real, persisted messages (see file header) — a message is a plain
    // postcard (state.kind:'room-message') riding the same postal rail
    // every other postcard in this app uses. There is no live push
    // channel; other participants' messages arrive via short-interval
    // polling (_startMessagePolling), same tradeoff RoomPresence's own
    // heartbeat/roster-refresh already makes for membership.

    "chat", {

      // Initial load (boot) and every poll tick both call this — always
      // refetches the latest MESSAGE page rather than tracking an
      // incremental "since" cursor, simplest correct thing for the small
      // per-room message volumes this app targets. Merges into
      // this._messages by objId (new ones only) so a poll tick doesn't
      // clobber whatever the user is mid-scrolling.
      _loadMessages: function () {
        if (this._searchActive) return; // search results own the list box until closed — see _toggleSearch
        var self = this;
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("GET", base + "/c/" + encodeURIComponent(this._name) + "/rooms/" + this._roomId + "/messages?limit=50", true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) return;
          var data;
          try { data = JSON.parse(xhr.responseText); } catch (e) { return; }
          var fetched = (data.messages || []).slice().reverse(); // server returns newest-first; display oldest-first
          if (self._isE2ee()) {
            self._decryptFetchedMessages(fetched, function () { self._mergeFetchedMessages(fetched); });
          } else {
            self._mergeFetchedMessages(fetched);
          }
        };
        xhr.send();
      },

      // Decrypts every fetched message's ciphertext/nonce (under the epoch
      // IT was actually sent under, not necessarily the room's current
      // epoch — RoomCrypto.decryptMessage's own header comment) into a
      // plain `.text` field in place, so _mergeFetchedMessages' diffing and
      // every downstream renderer can keep treating `.text` as a plain
      // string exactly like a non-e2eeEnabled room's messages — this is the
      // ONLY place that distinction has to exist. A per-message decrypt
      // FAILURE (expected for a message sent before this viewer had access
      // to that epoch — e2eeclusters.md §3's "no historical reseal" policy,
      // not a bug) renders as a neutral placeholder rather than erroring
      // the whole load. thenDo() takes no args — fetched is mutated in place.
      _decryptFetchedMessages: function (fetched, thenDo) {
        if (!fetched.length) return thenDo();
        var remaining = fetched.length;
        function done() { if (--remaining === 0) thenDo(); }
        fetched.forEach(function (m) {
          if (m.ciphertext == null || m.epoch == null) { m.text = ""; return done(); }
          lively.identity.roomCrypto.decryptMessage({
            constellationName: this._name, roomId: this._roomId,
            ciphertext: m.ciphertext, nonce: m.nonce, epoch: m.epoch,
          }, function (err, payload) {
            m.text = (!err && payload && typeof payload.text === "string") ? payload.text : E2EE_UNDECRYPTABLE_TEXT;
            done();
          });
        }, this);
      },

      // Merges a freshly-fetched (oldest-first) page of messages into
      // this._messages and re-renders if anything actually changed — split
      // out of _loadMessages so an e2eeEnabled room can decrypt first (see
      // _decryptFetchedMessages) without duplicating this diffing logic.
      _mergeFetchedMessages: function (fetched) {
        var self = this;
        var byObjId = {};
        self._messages.forEach(function (m) { byObjId[m.objId] = m; });
        var changed = false;
        fetched.forEach(function (m) {
          var existing = byObjId[m.objId];
          if (!existing) {
            self._messages.push(m);
            changed = true;
            return;
          }
          // A poll tick can also bring back a CHANGE to an already-known
          // message (a reaction, an edit) rather than a brand-new one —
          // the old version here only ever added new objIds and left
          // already-known rows untouched, so reactions/edits from other
          // viewers (or this viewer's own reaction, applied via a
          // fire-and-forget PUT that never touches this._messages
          // directly) never showed up until something else happened to
          // trigger a full reload.
          if (existing.editedAt !== m.editedAt || existing.text !== m.text ||
              JSON.stringify(existing.reactions) !== JSON.stringify(m.reactions) ||
              JSON.stringify(existing.replyTo) !== JSON.stringify(m.replyTo)) {
            existing.editedAt = m.editedAt;
            existing.text = m.text;
            existing.reactions = m.reactions;
            existing.replyTo = m.replyTo;
            changed = true;
          }
        });
        // A message can also disappear (deleted, by its author or a
        // moderator) — pruned here so a deletion elsewhere shows up on
        // the next poll tick too, not just new/edited messages. Scoped
        // to the created-time window this fetch actually covers (the
        // route always returns the newest 50, not the full history), so
        // an older message that's simply outside THIS page isn't
        // mistaken for a deleted one.
        if (fetched.length) {
          var fetchedIds = {};
          fetched.forEach(function (m) { fetchedIds[m.objId] = true; });
          var minT = new Date(fetched[0].created).getTime();
          var maxT = new Date(fetched[fetched.length - 1].created).getTime();
          var before = self._messages.length;
          self._messages = self._messages.filter(function (m) {
            var t = new Date(m.created).getTime();
            if (t < minT || t > maxT) return true; // outside this page — leave it alone
            return !!fetchedIds[m.objId];
          });
          if (self._messages.length !== before) changed = true;
        }
        if (changed) {
          self._messages.sort(function (a, b) { return new Date(a.created) - new Date(b.created); });
          self._renderMessages();
        }
      },

      _startMessagePolling: function () {
        var self = this;
        this._messagePollTimer = setInterval(function () {
          if (self._sendingMessage) return; // avoid racing an in-flight send's own refresh
          self._loadMessages();
        }, MESSAGE_POLL_MS);
      },

      _buildChatPanel: function () {
        var self = this;
        var chat = noDrag(new lively.morphic.Box(lively.rect(this._originX + CHAT_X_OFFSET, this._originY + HEADER_H, CHAT_W, BODY_H)));
        chat.applyStyle({ fill: BG_MAIN, borderWidth: 0 });
        this._viewRoot.addMorph(chat);
        this._chatBox = chat;

        var listH = BODY_H - INPUT_H;
        var list = noDrag(new lively.morphic.Box(lively.rect(0, 0, CHAT_W, listH)));
        // Vertical scroll only — same reason as the rooms panel: rows are
        // chat-width wide, the vertical scrollbar takes ~10px of it, and the
        // overflow showed as a horizontal scrollbar over the last message.
        list.applyStyle({ fill: null, borderWidth: 0, clipMode: { x: "hidden", y: "auto" } });
        this._ensureScrollbarStyle();
        list.renderContext().shapeNode.classList.add("roomview-scroll-light");
        chat.addMorph(list);
        this._msgListBox = list;
        // Whether the user is parked at the newest message — _renderMessages
        // only follows new content to the bottom while this holds, so
        // scrolling up to read (or watch an embedded video) isn't undone by
        // every poll/preview-landing re-render. Updated only by scroll
        // events: content growing under a pinned list fires none, so it
        // correctly stays pinned.
        this._pinnedToBottom = true;
        var listScrollNode = list.renderContext().shapeNode;
        listScrollNode.addEventListener("scroll", function () {
          self._pinnedToBottom = listScrollNode.scrollHeight - listScrollNode.scrollTop - listScrollNode.clientHeight < 40;
        });

        var inputRow = noDrag(new lively.morphic.Box(lively.rect(0, listH, CHAT_W, INPUT_H)));
        inputRow.applyStyle({ fill: BG_MAIN, borderWidth: 0 });
        chat.addMorph(inputRow);
        this._inputRowM = inputRow;

        var pill = noDrag(new lively.morphic.Box(lively.rect(16, 8, CHAT_W - 32, 36)));
        pill.applyStyle({ fill: BG_INPUT, borderWidth: 0, borderRadius: 8 });
        inputRow.addMorph(pill);
        this._pillM = pill;

        // 20 clipped the bottom of any descender (g/y/p) typed into the
        // box — confirmed live by actually typing "gyp qj" and reading
        // the real contenteditable's scrollHeight (~21px for 13px text);
        // 24 covers it with a little headroom rather than the exact
        // measured minimum. placeholder below is sized to match so the
        // two stay pixel-aligned regardless of which one is visible.
        var input = noDrag(new lively.morphic.Text(lively.rect(12, 6, CHAT_W - 32 - 72, 24)));
        // fixedWidth: true + pre-wrap: beInputLine's default (fixedWidth:
        // false, whitespace "pre") makes the box widen to fit one unbroken
        // line, so a pasted paragraph turned it thousands of px wide — and the
        // window's clipped content box then got scrolled sideways to chase the
        // caret, taking every panel off screen. Fixed width wraps the text
        // instead; _fitComposer grows the height to match.
        input.beInputLine({
          fontSize: 13, fontFamily: "'Atkinson Hyperlegible', Helvetica, Arial, sans-serif", textColor: TEXT_PRIMARY,
          fill: null, borderWidth: 0, whiteSpaceHandling: "pre-wrap", fixedWidth: true,
        });
        pill.addMorph(input);
        this._inputM = input;
        this._composerGrow = 0;
        // Native `input` fires for every edit — typing, paste (keyboard or
        // mouse/context menu), cut, undo — which a keydown hook can't see.
        input.renderContext().shapeNode.addEventListener("input", function () {
          var ed = input.renderContext().shapeNode.querySelector("[contenteditable]");
          if (self._placeholderM) self._placeholderM.setVisible(!(ed && ed.textContent));
          self._fitComposer();
        });

        var placeholder = lively.morphic.Text.makeLabel("Message #" + (this._room.name || "cluster"), {
          fontSize: 13, textColor: TEXT_FAINT,
        });
        placeholder.setExtent(lively.pt(CHAT_W - 32 - 72, 24));
        placeholder.setPosition(lively.pt(12, 6));
        placeholder.eventsAreIgnored = true;
        pill.addMorph(placeholder);
        this._placeholderM = placeholder;
        // eventsAreIgnored only makes a morph transparent to LIVELY's own
        // morphic mouse dispatch (Events.js) — it is not a CSS property
        // and does nothing for the browser's own native hit-testing
        // (elementFromPoint, native click-to-focus). Confirmed live: the
        // placeholder renders on top of `input` (added to `pill` after
        // it) at the exact same position, and a real click there focused
        // nothing — document.elementFromPoint() at the input's own
        // center resolved to the placeholder's DOM node, not the
        // contenteditable input underneath, so the chat box never
        // actually received focus/keystrokes despite looking clickable.
        // Real CSS pointer-events: none is the actual fix.
        placeholder.renderContext().shapeNode.style.pointerEvents = "none";

        // Emoji + GIF/Sticker picker buttons, in the ~60px gap the pill's
        // own width already reserves past the input's right edge (pill is
        // CHAT_W-32 wide, input only CHAT_W-32-72) — widened from an
        // original 48px because the "gif" glyph (a rounded-rect badge with
        // "GIF" lettering inside, more detail than "mood"'s plain smiley
        // outline) read as too small/cramped at the size that gap allowed.
        this._buildPickerButtons(pill);

        // Plain property assignment (not addScript) — this controller isn't
        // a lively.BuildSpec, so a normal closure over `self` here is safe
        // (only addScript'd/BuildSpec-reconstructed functions lose theirs;
        // see ConstellationLounge.js's own search-field onKeyDown for the
        // same idiom).
        var superKeyDown = input.onKeyDown;
        input.onKeyDown = function (evt) {
          if (evt.getKeyCode && evt.getKeyCode() === 13) {
            self._onSendMessage();
            evt.stop();
            return true;
          }
          var result = superKeyDown ? superKeyDown.call(this, evt) : undefined;
          self._placeholderM.setVisible(!this.textString);
          return result;
        };
      },

      // Small trailing pair of Material Symbols icon buttons inside the
      // input pill (see the vendored font + ligature-as-Text-morph
      // technique documented in CLAUDE.md / AmbientPresencePanel.js) —
      // "mood" opens the picker on its Emoji tab, "gif" opens it on GIFs.
      // Sized to fit the ~60px gap already reserved past the input's own
      // right edge (see _buildChatPanel). The "gif" glyph is a compound
      // badge shape (rounded-rect outline + "GIF" lettering) rather than a
      // simple icon outline like "mood"'s smiley, so it gets a noticeably
      // bigger box/fontSize to stay legible rather than sharing "mood"'s size.
      _buildPickerButtons: function (pill) {
        var self = this;
        function pickerIconButton(rect, fontSize, glyph, tab) {
          var btn = noDrag(new lively.morphic.Text(rect));
          btn.textString = glyph;
          btn.applyStyle({
            fontFamily: "'Material Symbols Rounded'", fontSize: fontSize, textColor: TEXT_FAINT,
            fill: null, borderWidth: 0, align: "center", allowInput: false, selectable: false,
            clipMode: "hidden", whiteSpaceHandling: "pre", handStyle: "pointer",
          });
          btn.onMouseOver = function () { this.applyStyle({ textColor: TEXT_PRIMARY }); };
          btn.onMouseOut = function () { this.applyStyle({ textColor: TEXT_FAINT }); };
          btn.onMouseUp = function (evt) { self._openMediaPicker(tab); evt.stop(); return true; };
          pill.addMorph(btn);
          return btn;
        }
        // [emoji, gif]; _layoutChat keeps them against the pill's right edge.
        var pillW = pill.getExtent().x;   // 728 at full chat width
        this._pickerBtns = [
          pickerIconButton(lively.rect(pillW - 56, 8, 20, 20), 13, "mood", "emoji"),
          pickerIconButton(lively.rect(pillW - 30, 4, 28, 28), 18, "gif", "gif"),
        ];
      },

      // Sizes the message box to its wrapped text: measures the real content
      // height, clamps it to [COMPOSER_MIN_H, COMPOSER_MAX_H], and grows the
      // input, its pill and (via _renderReplyComposeStrip, which owns all the
      // input-area geometry) the row, shrinking the message list to match.
      // The list stays pinned to the bottom if it was there.
      _fitComposer: function () {
        if (!this._inputM || !this._pillM || !this._msgListBox) return;
        var node = this._inputM.renderContext().shapeNode;
        var ed = node.querySelector("[contenteditable]");
        if (!ed) return;
        var w = this._chatW - 32 - 72;
        // The content div has min-height: calc(100% - 4px) of the box's CURRENT
        // height, so a box that already grew can never measure shorter than
        // itself — reset to one line first, then read the real height.
        this._inputM.setExtent(lively.pt(w, COMPOSER_MIN_H));
        var h = Math.max(COMPOSER_MIN_H, Math.min(COMPOSER_MAX_H, Math.ceil(ed.offsetHeight) + 3));
        this._inputM.setExtent(lively.pt(w, h));
        var grow = h - COMPOSER_MIN_H;
        if (grow === (this._composerGrow || 0)) return;
        var listNode = this._msgListBox.renderContext().shapeNode;
        var atBottom = listNode.scrollHeight - listNode.scrollTop - listNode.clientHeight < 40;
        this._composerGrow = grow;
        this._pillM.setExtent(lively.pt(this._chatW - 32, 36 + grow));
        this._renderReplyComposeStrip();
        if (atBottom) listNode.scrollTop = listNode.scrollHeight;
      },

      // Resizes the chat panel to width w (full CHAT_W, or CHAT_COMPACT_W beside
      // the speaker view) and everything in it that's sized from that width.
      _layoutChat: function (w) {
        if (!this._chatBox || this._chatW === w) return;
        this._chatW = w;
        this._chatBox.setExtent(lively.pt(w, BODY_H));
        this._composerGrow = 0; // re-measured at the end, once the new width is in place
        this._pillM.setExtent(lively.pt(w - 32, 36));
        this._inputM.setExtent(lively.pt(w - 32 - 72, 24));
        this._placeholderM.setExtent(lively.pt(w - 32 - 72, 24));
        // Rebuilt rather than moved: setPosition on an already-rendered morph can
        // leave its DOM node at the old spot (model and render disagree).
        this._pickerBtns.forEach(function (b) { try { b.remove(); } catch (e) {} });
        this._buildPickerButtons(this._pillM);
        // _msgListBox/_inputRowM/_pillM's own y-position and height depend
        // on whether a reply is in progress (the strip grows _inputRowM),
        // not just on width — _renderReplyComposeStrip owns that geometry
        // as the single source of truth, so re-run it here too rather than
        // duplicating the listH/rowH math.
        this._renderReplyComposeStrip();
        this._renderMessages();
        this._fitComposer();
      },

      _getMediaPicker: function () {
        if (!this._mediaPicker) this._mediaPicker = new lively.identity.MediaPickerController();
        return this._mediaPicker;
      },

      _openMediaPicker: function (initialTab) {
        var self = this;
        var picker = this._getMediaPicker();
        if (picker.isOpen() && picker._activeTab === initialTab) { picker.close(); return; } // same button again toggles shut
        if (picker.isOpen()) { picker._selectTab(initialTab); return; } // other button while open just switches tabs
        picker.open(this._inputRowM.globalBounds(), {
          initialTab: initialTab,
          onPick: function (payload) { self._onMediaPicked(payload); },
        });
      },

      _onMediaPicked: function (payload) {
        if (payload.type === "emoji") this._insertEmoji(payload.value);
        else this._sendMediaMessage(payload.value);
      },

      _insertEmoji: function (glyph) {
        this._inputM.textString = (this._inputM.textString || "") + glyph;
        this._placeholderM.setVisible(!this._inputM.textString);
        this._fitComposer();
        if (this._inputM.focus) this._inputM.focus();
      },

      // Sends a GIF/sticker pick immediately on click (common chat-app
      // behavior) rather than dropping the URL into the input for the user
      // to hit Enter on — reuses _sendText, the same envelope/XHR path
      // typed messages go through, just with the media URL as the body.
      // NOTE: PostCardSerializer._extractFirstBlockText caps state.title at
      // 200 chars. Confirmed live against real Klipy responses that its
      // static CDN URLs (e.g. https://static.klipy.com/ii/<hash>/<a>/<b>/
      // <file>.gif) run ~80-90 chars with no query string, so this cap
      // isn't actually in play in practice — if that ever changes,
      // _isMediaMessage's regex requires the extension right at the end of
      // string, so a mid-URL truncation would just fail that check and the
      // message would fall back to rendering as plain (broken-link) text
      // rather than a broken image.
      _sendMediaMessage: function (url) {
        if (this._sendingMessage) return;
        this._sendText(url);
      },

      // Same build-envelope -> PUT to own /@handle/objId -> POST {objId} to
      // the validating route sequence ConstellationLounge.js's
      // _requestRoomAccess/_submitReply already use for every other
      // client-authored postcard. Clears the input immediately (so the box
      // doesn't feel stuck) but only appends the message to this._messages
      // once the round trip actually succeeds — a real signing+two-XHR
      // trip has enough latency (WebAuthn/crypto involved) that showing an
      // optimistic local echo and later reconciling it against the real
      // objId isn't worth the complexity for a first real implementation;
      // _sendingMessage just blocks the next poll tick from racing this one.
      _onSendMessage: function () {
        var text = (this._inputM.textString || "").trim();
        if (!text || this._sendingMessage) return;
        this._inputM.textString = "";
        this._placeholderM.setVisible(true);
        this._fitComposer();
        this._sendText(text);
      },

      // Factored out of _onSendMessage so a GIF/sticker/emoji pick
      // (_sendMediaMessage) can post through the exact same envelope/XHR
      // path a typed message uses, just with a different `text` body — the
      // input box itself is never touched here, only by callers that read
      // from it first (_onSendMessage).
      _sendText: function (text) {
        var user = lively.identity.did.currentUser();
        if (!user) return;

        // Checked BEFORE touching _sendingMessage/_replyingTo, so a blocked
        // send leaves everything (including an in-progress reply) exactly
        // as it was — the typed text just bounces back into the input via
        // _onSendMessageFailed, same as any other failure. See
        // e2eeclusters.md §9.1: the rotation-pending flag is the actual
        // forward-secrecy safety net, not just a UI nag — a new message
        // must never go out sealed to a membership list that's already
        // known to be stale.
        if (this._rotationPending()) {
          return this._onSendMessageFailed(text, new Error(
            "Can't send — this cluster's encryption key is rotating. Use Retry above, or try again shortly."
          ));
        }

        this._sendingMessage = true;
        this._scrollToBottomNext = true; // my own message always scrolls into view, even from a scrolled-up list

        // Consumed and cleared eagerly here (not left for the caller),
        // same "don't feel stuck" reasoning as _onSendMessage clearing the
        // input immediately — applies uniformly whether this send came
        // from the Enter key or a GIF/emoji pick, so replying then picking
        // a GIF still attaches the reply. Ephemeral rooms never reach
        // this far with a pending reply since the toolbar's Reply button
        // is only ever offered on persistent-room messages.
        var replyTo = this._replyingTo ? { objId: this._replyingTo.objId, anchor: null } : null;
        this._replyingTo = null;
        this._renderReplyComposeStrip();

        if (this._room && this._room.ephemeral) return this._sendEphemeralText(text);
        if (this._isE2ee()) return this._sendEncryptedText(text, replyTo, user);

        var self = this;
        var doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: text }] }] };
        var params = {
          doc: doc,
          constellation: self._name,
          visibility: "public",
          stateMeta: { kind: "room-message", roomId: self._roomId },
        };
        if (replyTo) params.replyTo = replyTo;
        lively.identity.postCardSerializer.serializePlainToEnvelope(params, function (err, envelope) {
          if (err) return self._onSendMessageFailed(text, err);
          self._putAndConfirmMessage(envelope, text);
        });
      },

      // room-message envelope for an e2eeEnabled room: record.payload is
      // the raw ciphertext string (not a ProseMirror doc), record.nonce and
      // state.epoch tell any reader which room-key epoch to decrypt it with
      // — built directly here rather than through PostCardSerializer (whose
      // plain/encrypted pairs are either unencrypted or KEK/wrappedDek-based
      // private postcards, neither of which matches "one DEK shared via the
      // room's own epoch envelope, no per-message sealing" — see
      // RoomCrypto.js's own header comment on this division of labor).
      _sendEncryptedText: function (text, replyTo, user) {
        var self = this;
        var c = lively.identity.crypto;
        lively.identity.roomCrypto.encryptMessage({
          constellationName: self._name, roomId: self._roomId, payload: { text: text },
        }, function (err, enc) {
          if (err) return self._onSendMessageFailed(text, err);
          lively.identity.webKey.generateGenesisObjId(user.did, function (err2, genesis) {
            if (err2) return self._onSendMessageFailed(text, err2);
            c.computeCid(enc.ciphertext, function (err3, cid) {
              if (err3) return self._onSendMessageFailed(text, err3);
              var envelope = {
                objId: genesis.objId, genesisNonce: genesis.genesisNonce,
                did: user.did, type: "postcard", visibility: "public",
                constellation: self._name,
                created: new Date().toISOString(),
                record: { cid: cid, prevCid: null, payload: enc.ciphertext, nonce: enc.nonce },
                state: { kind: "room-message", roomId: self._roomId, epoch: enc.epoch },
              };
              if (replyTo) envelope.replyTo = replyTo;
              lively.identity.envelopeSigning.signEnvelopeIfPossible(envelope, user, c, function (signErr, signed) {
                if (signErr) return self._onSendMessageFailed(text, signErr);
                self._putAndConfirmMessage(signed || envelope, text);
              });
            });
          });
        });
      },

      // Shared PUT-own-envelope -> POST {objId} confirm tail for both the
      // plaintext and encrypted send paths (_sendText/_sendEncryptedText) —
      // same two-step "save the signed envelope, then ask the room route to
      // validate+accept it" sequence either way; only the envelope's own
      // shape differs between callers.
      _putAndConfirmMessage: function (envelope, text) {
        var self = this;
        var user = lively.identity.did.currentUser();
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("PUT", base + "/@" + encodeURIComponent(user.handle) + "/" + encodeURIComponent(envelope.objId), true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) return self._onSendMessageFailed(text, new Error("save failed (" + xhr.status + ")"));
          var xhr2 = new XMLHttpRequest();
          xhr2.open("POST", base + "/c/" + encodeURIComponent(self._name) + "/rooms/" + self._roomId + "/messages", true);
          xhr2.withCredentials = true;
          xhr2.setRequestHeader("Content-Type", "application/json");
          xhr2.onload = function () {
            self._sendingMessage = false;
            if (xhr2.status !== 201) return self._onSendMessageFailed(text, new Error("send failed (" + xhr2.status + ")"));
            self._loadMessages();
          };
          xhr2.onerror = function () { self._onSendMessageFailed(text, new Error("network error")); };
          xhr2.send(JSON.stringify({ objId: envelope.objId }));
        };
        xhr.onerror = function () { self._onSendMessageFailed(text, new Error("network error")); };
        xhr.send(JSON.stringify(envelope));
      },

      // Ephemeral-room counterpart to _sendText — no ProseMirror doc, no
      // signing, no PUT to /@handle/objId: a single lightweight POST of
      // plain text, since these messages are never signed postcards (see
      // RoomEphemeralMessages.js's own header comment). This also makes
      // ephemeral sends noticeably snappier than persistent ones (no
      // WebAuthn round trip).
      _sendEphemeralText: function (text) {
        var self = this;
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("POST", base + "/c/" + encodeURIComponent(this._name) + "/rooms/" + this._roomId + "/messages", true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.onload = function () {
          self._sendingMessage = false;
          if (xhr.status !== 201) return self._onSendMessageFailed(text, new Error("send failed (" + xhr.status + ")"));
          self._loadMessages();
        };
        xhr.onerror = function () { self._onSendMessageFailed(text, new Error("network error")); };
        xhr.send(JSON.stringify({ text: text }));
      },

      // Whether the current viewer may delete/moderate ANY message in this
      // room, not just their own — a constellation controller, or this
      // specific room's own creator (canManageRoom's own reasoning,
      // IdentityServer.js). Recomputed once per _renderMessages pass, not
      // per row.
      _canModerateRoom: function () {
        if (!this._room) return false;
        if (this._isController) return true;
        var user = lively.identity.did.currentUser();
        return !!(user && this._room.createdBy === user.did);
      },

      _findMessageByObjId: function (objId) {
        for (var i = 0; i < this._messages.length; i++) {
          if (this._messages[i].objId === objId) return this._messages[i];
        }
        return null;
      },

      // Scrolls a reply's parent message into view and briefly flashes it —
      // _rowTopByObjId/_rowMorphByObjId are rebuilt fresh on every
      // _renderMessages() pass (see there), so reading them here rather
      // than closing over stale values means a click always targets
      // wherever the message is NOW, even if a poll/reaction/edit
      // re-rendered the list between the chip being drawn and the click.
      _jumpToMessage: function (objId) {
        if (this._searchActive) return; // offsets only cover the current search results here, not the full list
        var top = this._rowTopByObjId && this._rowTopByObjId[objId];
        var targetRow = this._rowMorphByObjId && this._rowMorphByObjId[objId];
        if (top == null || !targetRow || !this._msgListBox) return;
        var scrollNode = this._msgListBox.renderContext().shapeNode;
        scrollNode.scrollTop = Math.max(0, top - Math.round(scrollNode.clientHeight / 3));

        // A temporary overlay morph rather than touching the row's own
        // `fill` — the row already swaps `fill` on hover (see makeRow
        // below), and fighting over the same property with a timed revert
        // would lose the flash early if the mouse happened to be over the
        // row at the time.
        var overlay = noDrag(new lively.morphic.Box(lively.rect(0, 0, targetRow.getExtent().x, targetRow.getExtent().y)));
        overlay.applyStyle({ fill: JUMP_HIGHLIGHT, borderWidth: 0, borderRadius: 6 });
        overlay.eventsAreIgnored = true;
        targetRow.addMorph(overlay);
        setTimeout(function () { try { overlay.remove(); } catch (e) {} }, 1200);
      },

      // ── replies ────────────────────────────────────────────────────────────
      // Discord-style: a lightweight "replying to X" preview rendered
      // inline above the reply message in the same flat chronological list
      // (see _renderMessages), not a separate side-thread panel — reuses
      // the existing top-level envelope replyTo:{objId,anchor} field
      // ConstellationLounge.js's own (differently-shaped) comment threads
      // already rely on; listMessagesForRoom's query doesn't filter out
      // replyTo-carrying rows, so this needs no new listing logic at all.

      _startReplyingTo: function (msg) {
        this._replyingTo = { objId: msg.objId, handle: msg.handle, snippet: (msg.text || "").replace(/\s+/g, " ").slice(0, 80) };
        this._renderReplyComposeStrip();
        if (this._inputM && this._inputM.focus) this._inputM.focus();
      },

      _cancelReplyingTo: function () {
        this._replyingTo = null;
        this._renderReplyComposeStrip();
      },

      // Single source of truth for _inputRowM/_msgListBox/_pillM's height
      // and position, since they depend on the chat panel's current width
      // (_layoutChat), whether a reply is in progress, AND (new) whether
      // this e2eeEnabled room's key rotation is pending — called from all
      // three places rather than duplicating the listH/rowH math in each.
      // _pillM's own CHILDREN (input, placeholder, picker buttons) are
      // positioned relative to _pillM itself, so only _pillM's own y needs
      // to move when the strip/banner appears/disappears. The rotation
      // banner (if shown) always sits above the reply strip (if also
      // shown) — stacked, not mutually exclusive, since a half-composed
      // reply can still be in progress when a rotation starts.
      _renderReplyComposeStrip: function () {
        if (!this._inputRowM) return;
        if (this._replyStripM) { try { this._replyStripM.remove(); } catch (e) {} this._replyStripM = null; }
        if (this._rotationBannerM) { try { this._rotationBannerM.remove(); } catch (e) {} this._rotationBannerM = null; }

        var rotationOn = this._rotationPending();
        var rotationExtra = rotationOn ? ROTATION_BANNER_H : 0;
        var replyExtra = this._replyingTo ? REPLY_STRIP_H : 0;
        var extra = rotationExtra + replyExtra;
        // The grown message box extends DOWN from the pill's own top, so it
        // adds to the row's height but not to where the pill starts.
        var rowH = INPUT_H + extra + (this._composerGrow || 0);
        var listH = BODY_H - rowH;
        this._msgListBox.setExtent(lively.pt(this._chatW, listH));
        this._inputRowM.setExtent(lively.pt(this._chatW, rowH));
        this._inputRowM.setPosition(lively.pt(0, listH));
        this._pillM.setPosition(lively.pt(16, 8 + extra));

        if (rotationOn) this._buildRotationBanner();
        if (this._replyingTo) this._buildReplyStrip(rotationExtra);
      },

      // The e2ee rotation-pending notice — see e2eeclusters.md §9.1. Sending
      // is actually blocked in _sendText (this._rotationPending()), not by
      // disabling the input: the banner is the ambient explanation for why
      // a send just bounced back into the box, not a hard lockout of typing.
      _buildRotationBanner: function () {
        var self = this;
        var PAD = 16;
        var banner = noDrag(new lively.morphic.Box(lively.rect(PAD, 4, this._chatW - PAD * 2, ROTATION_BANNER_H - 8)));
        banner.applyStyle({ fill: Color.rgba(242, 63, 66, 0.14), borderWidth: 0, borderRadius: 4 });
        this._inputRowM.addMorph(banner);
        this._rotationBannerM = banner;

        var lbl = noDrag(lively.morphic.Text.makeLabel(
          "Key rotation pending — sending is paused until it completes.",
          { fontSize: 11, textColor: DANGER, fixedWidth: true, fixedHeight: true, whiteSpaceHandling: "pre" }
        ));
        lbl.eventsAreIgnored = true;
        lbl.setExtent(lively.pt(this._chatW - PAD * 2 - 60, ROTATION_BANNER_H - 8));
        lbl.setPosition(lively.pt(8, 1));
        banner.addMorph(lbl);

        // Text.makeLabel's own beLabel() unconditionally calls
        // ignoreEvents() regardless of style — CLAUDE.md's makeLabel
        // click-dead gotcha — so this has to be flipped back explicitly or
        // onMouseUp below is structurally unreachable.
        var retryBtn = noDrag(lively.morphic.Text.makeLabel("Retry", { fontSize: 11, textColor: DANGER }));
        retryBtn.applyStyle({ borderWidth: 0, fill: null, fontWeight: "bold", handStyle: "pointer" });
        retryBtn.eventsAreIgnored = false;
        retryBtn.setExtent(lively.pt(40, ROTATION_BANNER_H - 8));
        retryBtn.setPosition(lively.pt(this._chatW - PAD * 2 - 46, 1));
        retryBtn.onMouseUp = function (evt) { self._retryRotation(retryBtn); evt.stop(); return true; };
        banner.addMorph(retryBtn);
      },

      // yOffset: ROTATION_BANNER_H when the rotation banner is also shown
      // (stacks below it), 0 otherwise.
      _buildReplyStrip: function (yOffset) {
        var self = this;
        var PAD = 16;
        var strip = noDrag(new lively.morphic.Box(lively.rect(PAD, yOffset + 4, this._chatW - PAD * 2, REPLY_STRIP_H - 8)));
        strip.applyStyle({ fill: Color.rgba(79, 11, 67, 0.12), borderWidth: 0, borderRadius: 4 });
        this._inputRowM.addMorph(strip);
        this._replyStripM = strip;

        var text = "Replying to @" + this._replyingTo.handle + ": " + this._replyingTo.snippet;
        var lbl = noDrag(lively.morphic.Text.makeLabel(text, {
          fontSize: 11, textColor: TEXT_MUTED, fixedWidth: true, fixedHeight: true, whiteSpaceHandling: "pre",
        }));
        lbl.eventsAreIgnored = true;
        lbl.setExtent(lively.pt(this._chatW - PAD * 2 - 24, REPLY_STRIP_H - 8));
        lbl.setPosition(lively.pt(6, 1));
        strip.addMorph(lbl);

        var closeBtn = noDrag(lively.morphic.Text.makeLabel("close", { fontSize: 12, textColor: TEXT_MUTED }));
        closeBtn.applyStyle({ fontFamily: "'Material Symbols Rounded'", borderWidth: 0, fill: null, handStyle: "pointer" });
        closeBtn.setExtent(lively.pt(16, 16));
        closeBtn.setPosition(lively.pt(this._chatW - PAD * 2 - 20, 1));
        closeBtn.onMouseUp = function (evt) { self._cancelReplyingTo(); evt.stop(); return true; };
        strip.addMorph(closeBtn);
      },

      // Manual retry for a stuck e2ee_rotation_pending flag (e2eeclusters.md
      // §9.1/§9.3) — the single entry point RoomCrypto.ensureEpoch covers
      // both "no epoch minted yet" (a brand-new room) and "mid-life
      // rotation" cases, so this doesn't need to know which applies. Only
      // updates this._room locally on success (no room-detail refetch) —
      // consistent with _rotationPending's own header comment on this
      // being a per-session snapshot, not a live subscription.
      _retryRotation: function (btn) {
        var self = this;
        if (btn) { btn.textString = "…"; btn.eventsAreIgnored = true; }
        lively.identity.roomCrypto.ensureEpoch({
          constellationName: self._name, roomId: self._roomId,
        }, function (err) {
          if (err) {
            console.error("[RoomView] E2EE rotation retry failed:", err);
            if (btn) { btn.textString = "Retry"; btn.eventsAreIgnored = false; }
            return;
          }
          if (self._room) self._room.e2eeRotationPending = false;
          self._renderReplyComposeStrip();
          self._loadMessages();
        });
      },

      // ── reactions ──────────────────────────────────────────────────────────
      // A second, independent MediaPickerController instance (the compose
      // box's own _getMediaPicker already owns one, bound to inserting
      // text/sending a GIF — this one's onPick calls the reactions PUT
      // route instead). Reuses the same vendored emoji grid rather than
      // building a second picker UI from scratch.

      _getReactionPicker: function () {
        if (!this._reactionPicker) this._reactionPicker = new lively.identity.MediaPickerController();
        return this._reactionPicker;
      },

      _openReactionPicker: function (msg, anchorMorph) {
        var self = this;
        var picker = this._getReactionPicker();
        if (picker.isOpen()) { picker.close(); return; }
        picker.open(anchorMorph.globalBounds(), {
          initialTab: "emoji",
          onPick: function (payload) {
            if (payload.type !== "emoji") return; // GIF tab isn't meaningful for a reaction
            self._putMessageReaction(msg.objId, payload.value);
          },
        });
      },

      _putMessageReaction: function (objId, emoji) {
        var self = this;
        var user = lively.identity.did.currentUser();
        if (!user) return;
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("PUT", base + "/@" + encodeURIComponent(user.handle) + "/" + encodeURIComponent(objId) + "/reactions", true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.onload = function () { self._loadMessages(); };
        xhr.send(JSON.stringify({ emoji: emoji }));
      },

      _deleteMessageReaction: function (objId, emoji) {
        var self = this;
        var user = lively.identity.did.currentUser();
        if (!user) return;
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("DELETE", base + "/@" + encodeURIComponent(user.handle) + "/" + encodeURIComponent(objId) +
          "/reactions/" + encodeURIComponent(emoji), true);
        xhr.withCredentials = true;
        xhr.onload = function () { self._loadMessages(); };
        xhr.send();
      },

      // Grouped pill per distinct emoji (count + who, on hover), highlighted
      // if the viewer is among the reactors — driven entirely from the
      // batched msg.reactions summary the messages-list route already
      // returns (no per-row fetch). A did may hold several different emoji
      // on one message (multi-reaction, unlike PostCardView.js's own
      // fixed-two-emoji single-slot UI), so clicking a not-yet-mine emoji
      // always ADDS, never replaces another one of the viewer's own pills.
      // Returns the extra height this row consumed (0 if no reactions).
      _renderReactionPillRow: function (row, msg, topY, pad, bw) {
        var self = this;
        var reactions = msg.reactions;
        var emojiList = reactions ? Object.keys(reactions.counts || {}) : [];
        if (!emojiList.length) return 0;
        var user = lively.identity.did.currentUser();
        var mine = reactions.mine || [];
        var PILL_H = 22, PILL_GAP = 6;
        var x = pad + AVATAR_MSG + 8;
        var rowBox = noDrag(new lively.morphic.Box(lively.rect(x, topY, bw, PILL_H)));
        rowBox.applyStyle({ fill: null, borderWidth: 0 });
        row.addMorph(rowBox);
        var cx = 0;
        emojiList.forEach(function (emoji) {
          var n = reactions.counts[emoji] || 0;
          var isMine = mine.indexOf(emoji) !== -1;
          var pill = noDrag(lively.morphic.Text.makeLabel(emoji + " " + n, {
            fontSize: 12, textColor: CHAT_TEXT_PRIMARY, fixedWidth: true, fixedHeight: true, whiteSpaceHandling: "pre",
          }));
          pill.applyStyle({
            fill: isMine ? Color.rgb(238, 224, 245) : Color.rgb(250, 248, 252),
            borderWidth: 1, borderColor: isMine ? ACCENT : Color.rgba(43, 20, 63, 0.15),
            borderRadius: 11, handStyle: user ? "pointer" : "default",
          });
          pill.setExtent(lively.pt(60, PILL_H)); // generous throwaway, snug-fit right below
          rowBox.addMorph(pill);
          var span = pill.renderContext().shapeNode.querySelector("span");
          var textW = (span && span.offsetWidth) || 30;
          var pillW = textW + 20;
          pill.setExtent(lively.pt(pillW, PILL_H));
          pill.setPosition(lively.pt(cx, 0));
          var byEmoji = (reactions.byEmoji && reactions.byEmoji[emoji]) || [];
          pill.renderContext().shapeNode.title = byEmoji.join(", ");
          if (user) {
            pill.handStyle = "pointer";
            pill.onMouseUp = function (evt) {
              if (isMine) self._deleteMessageReaction(msg.objId, emoji);
              else self._putMessageReaction(msg.objId, emoji);
              evt.stop();
              return true;
            };
          }
          cx += pillW + PILL_GAP;
        });
        rowBox.setExtent(lively.pt(bw, PILL_H));
        return PILL_H + 6;
      },

      // ── edit ────────────────────────────────────────────────────────────────
      // Author-only, enforced purely by the server keeping the ordinary
      // owner-only PUT check for any write whose content genuinely changes
      // (unlike the mod-delete tombstone exception, IdentityServer.js) — no
      // client-side gate beyond not offering the Edit button on someone
      // else's row (_renderRowToolbar).

      _startEditingMessage: function (msg) {
        this._editingObjId = msg.objId;
        this._editingDraftText = msg.text || "";
        this._renderMessages();
      },

      _cancelEditingMessage: function () {
        this._editingObjId = null;
        this._editingDraftText = null;
        this._renderMessages();
      },

      // GET the full envelope, re-serialize with prevEnvelope (chains onto
      // the SAME objId rather than minting a new genesis object — the
      // supported "edit in place" idiom, PostCardSerializer.js), PUT it
      // back. This is a real content change (the cid changes), so it goes
      // through the server's ordinary signature-verification path, unlike
      // a delete tombstone's metadata-only exemption.
      _saveMessageEdit: function (objId, authorHandle, newText) {
        var self = this;
        if (!newText) return; // empty edit — Cancel instead of saving blank
        var user = lively.identity.did.currentUser();
        if (!user) return;
        var base = lively.identity.did.baseUrl();
        var url = base + "/@" + encodeURIComponent(authorHandle) + "/" + encodeURIComponent(objId);
        var getXhr = new XMLHttpRequest();
        getXhr.open("GET", url, true);
        getXhr.withCredentials = true;
        getXhr.setRequestHeader("Accept", "application/json");
        getXhr.onload = function () {
          if (getXhr.status !== 200) return;
          var envelope;
          try { envelope = JSON.parse(getXhr.responseText); } catch (e) { return; }

          // An e2eeEnabled room's message body must stay ciphertext on
          // every write, including an edit — serializePlainToEnvelope
          // below builds a plaintext ProseMirror-doc payload, which would
          // otherwise silently write the edited text to the server in the
          // clear the moment this ran. Re-encrypts under the room's
          // CURRENT epoch (not necessarily the epoch the original message
          // was sent under) — a member removed since the original send
          // already couldn't decrypt new content either way, and this
          // keeps the edit visible to every member still current, same
          // reasoning _sendEncryptedText's own forward-secrecy framing
          // gives for brand-new messages.
          if (self._isE2ee()) return self._saveEncryptedMessageEdit(envelope, newText, url);

          var doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: newText }] }] };
          var params = {
            doc: doc,
            constellation: self._name,
            visibility: "public",
            stateMeta: { kind: "room-message", roomId: self._roomId, editedAt: new Date().toISOString() },
            prevEnvelope: envelope,
          };
          // serializePlainToEnvelope only sets envelope.replyTo from
          // params.replyTo — it does NOT inherit it from prevEnvelope, so
          // editing a reply without carrying this forward silently drops
          // its "replying to X" association on save (confirmed live: the
          // client still showed the old replyTo from stale local cache,
          // but the server's actual stored envelope had none).
          if (envelope.replyTo) params.replyTo = envelope.replyTo;
          lively.identity.postCardSerializer.serializePlainToEnvelope(params, function (err, newEnvelope) {
            if (err) return;
            var putXhr = new XMLHttpRequest();
            putXhr.open("PUT", url, true);
            putXhr.withCredentials = true;
            putXhr.setRequestHeader("Content-Type", "application/json");
            putXhr.onload = function () {
              self._editingObjId = null;
              self._editingDraftText = null;
              self._loadMessages();
              self._renderMessages();
            };
            putXhr.send(JSON.stringify(newEnvelope));
          });
        };
        getXhr.send();
      },

      // e2eeEnabled counterpart of the plaintext branch above — same
      // chain-onto-the-same-objId idiom (record.prevCid set from the
      // existing envelope, replyTo carried forward), but record.payload is
      // re-encrypted ciphertext instead of a plaintext ProseMirror doc.
      _saveEncryptedMessageEdit: function (envelope, newText, url) {
        var self = this;
        var c = lively.identity.crypto;
        var user = lively.identity.did.currentUser();
        lively.identity.roomCrypto.encryptMessage({
          constellationName: self._name, roomId: self._roomId, payload: { text: newText },
        }, function (err, enc) {
          if (err) { console.error("[RoomView] Encrypted edit failed:", err); return; }
          c.computeCid(enc.ciphertext, function (err2, cid) {
            if (err2) { console.error("[RoomView] Encrypted edit failed:", err2); return; }
            var updated = Object.assign({}, envelope, {
              record: Object.assign({}, envelope.record, { cid: cid, prevCid: envelope.record.cid, payload: enc.ciphertext, nonce: enc.nonce }),
              state: Object.assign({}, envelope.state, { epoch: enc.epoch, editedAt: new Date().toISOString() }),
            });
            delete updated.sig;
            lively.identity.envelopeSigning.signEnvelopeIfPossible(updated, user, c, function (signErr, signed) {
              if (signErr) { console.error("[RoomView] Encrypted edit failed:", signErr); return; }
              var toSend = signed || updated;
              var putXhr = new XMLHttpRequest();
              putXhr.open("PUT", url, true);
              putXhr.withCredentials = true;
              putXhr.setRequestHeader("Content-Type", "application/json");
              putXhr.onload = function () {
                self._editingObjId = null;
                self._editingDraftText = null;
                self._loadMessages();
                self._renderMessages();
              };
              putXhr.send(JSON.stringify(toSend));
            });
          });
        });
      },

      // ── delete ─────────────────────────────────────────────────────────────
      // Same GET-then-tombstone-PUT idiom PostCardMailbox.js's own
      // _deletePostcard uses (metadata-only write, sig stripped, server
      // skips re-verification for it). The URL's :handle is always the
      // MESSAGE AUTHOR's (msg.handle), never the deleter's own — required
      // even for a moderator deleting someone else's message, since the
      // server's handle-registry check resolves :handle against the
      // envelope's own (unchanged) did, not the requester's session did.

      _deleteMessage: function (msg) {
        var self = this;
        var user = lively.identity.did.currentUser();
        if (!user) return;
        var base = lively.identity.did.baseUrl();
        var url = base + "/@" + encodeURIComponent(msg.handle) + "/" + encodeURIComponent(msg.objId);
        var getXhr = new XMLHttpRequest();
        getXhr.open("GET", url, true);
        getXhr.withCredentials = true;
        getXhr.setRequestHeader("Accept", "application/json");
        getXhr.onload = function () {
          if (getXhr.status !== 200) return;
          var envelope;
          try { envelope = JSON.parse(getXhr.responseText); } catch (e) { return; }
          $world.confirm("Delete this message? This can't be undone.", function (answer) {
            if (!answer) return;
            var updated = Object.assign({}, envelope, {
              state: Object.assign({}, envelope.state || {}, { deleted: true }),
            });
            delete updated.sig;
            var putXhr = new XMLHttpRequest();
            putXhr.open("PUT", url, true);
            putXhr.withCredentials = true;
            putXhr.setRequestHeader("Content-Type", "application/json");
            putXhr.onload = function () {
              if (putXhr.status === 200) self._loadMessages();
              else $world.alert("Could not delete this message (" + putXhr.status + ").");
            };
            putXhr.send(JSON.stringify(updated));
          });
        };
        getXhr.send();
      },

      // ── flag ───────────────────────────────────────────────────────────────
      // Near-verbatim clone of MiniProfileCard.js's _openFlagReasonDialog
      // (same window/field/button chrome, same two-step PUT-then-POST
      // report flow), parameterized for a message rather than a profile —
      // state.kind:'message-flag' instead of 'profile-flag', carrying the
      // flagged message's own objId so a moderator's inbox can deep-link
      // to it. POST /c/:name/flags (IdentityServer.js) accepts either kind
      // and resolves the same controller set either way.
      _openMessageFlagDialog: function (objId, targetDid, targetHandle, roomId) {
        var self = this;
        var W = 360, PAD = 14, MAX_REASON = 250;
        var body = noDrag(new lively.morphic.Box(lively.rect(0, 0, W, 270)));
        body.applyStyle({ fill: Color.rgb(243, 243, 243), borderColor: Color.rgb(95, 94, 95), borderWidth: 1, borderRadius: 4 });

        function fieldLabel(rect, text, opts) {
          opts = opts || {};
          var t = noDrag(new lively.morphic.Text(rect));
          t.textString = text;
          t.applyStyle({
            fontSize: opts.px || 12, fontWeight: opts.bold ? "bold" : "normal",
            textColor: opts.color || Color.rgb(40, 40, 40), fill: null, borderWidth: 0,
            align: "left", allowInput: false, selectable: false, clipMode: "hidden",
            whiteSpaceHandling: opts.wrap ? "normal" : "pre",
          });
          return t;
        }

        // 42px, not a guessed 32 -- a wrapped two-line 13px bold label
        // undershot at 32 and clipped "moderators" onto a cut-off second
        // line (confirmed live via chrome-devtools), same class of gap as
        // CLAUDE.md's own multi-line text-sizing gotcha (a flat guessed
        // per-line height reliably undershoots real wrapped line-height).
        body.addMorph(fieldLabel(lively.rect(PAD, 12, W - PAD * 2, 42),
          "Report message from @" + targetHandle + " to moderators", { px: 13, bold: true, wrap: true }));
        body.addMorph(fieldLabel(lively.rect(PAD, 58, W - PAD * 2, 16), "Reason", { px: 11, color: Color.rgb(120, 120, 120) }));

        var reasonField = noDrag(new lively.morphic.Text(lively.rect(PAD, 75, W - PAD * 2, 106), ""));
        reasonField.beInputLine();
        reasonField.applyStyle({
          allowInput: true, fontSize: 12, fontFamily: "'Atkinson Hyperlegible', Helvetica, Arial, sans-serif", clipMode: "hidden",
          fixedWidth: true, fixedHeight: true, whiteSpaceHandling: "pre-wrap",
          fill: Color.white, borderColor: Color.rgb(203, 203, 203), borderWidth: 1, borderRadius: 4,
          padding: lively.Rectangle.inset(6, 6, 0, 0),
        });
        body.addMorph(reasonField);

        var counter = noDrag(new lively.morphic.Text(lively.rect(PAD, 185, W - PAD * 2, 14), "0 / " + MAX_REASON));
        counter.applyStyle({
          allowInput: false, fontSize: 10, align: "right",
          textColor: Color.rgb(140, 140, 148), fill: null, borderWidth: 0,
          selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre",
        });
        lively.bindings.connect(reasonField, "textString", counter, "setTextString", {
          converter: function (s) { return (s || "").length + " / " + MAX_REASON; },
        });
        body.addMorph(counter);

        var errorLabel = fieldLabel(lively.rect(PAD, 205, W - PAD * 2, 16), "", { px: 11, color: Color.rgb(200, 60, 60) });
        body.addMorph(errorLabel);

        function makeButton(rect, text, primary) {
          var btn = noDrag(new lively.morphic.Box(rect));
          btn.applyStyle({
            fill: primary ? Color.rgb(253, 235, 235) : Color.white, borderRadius: 5, borderWidth: 1,
            borderColor: primary ? DANGER : Color.rgb(214, 214, 214), clipMode: "hidden",
          });
          var t = noDrag(new lively.morphic.Text(lively.rect(0, 0, rect.width, rect.height), text));
          t.applyStyle({
            fontSize: 12, textColor: primary ? DANGER : Color.rgb(60, 60, 60),
            fill: null, borderWidth: 0, align: "center",
            padding: lively.Rectangle.inset(0, Math.round((rect.height - 12) / 2) - 2, 0, 0),
            allowInput: false, selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre",
          });
          t.eventsAreIgnored = true;
          btn.addMorph(t);
          return btn;
        }

        var cancelBtn = makeButton(lively.rect(PAD, 230, 90, 28), "Cancel", false);
        cancelBtn.onMouseUp = function (evt) { win.remove(); evt.stop(); return true; };
        body.addMorph(cancelBtn);

        var sendBtn = makeButton(lively.rect(W - PAD - 90, 230, 90, 28), "Report", true);
        sendBtn.onMouseUp = function (evt) {
          var reason = (reasonField.textString || "").trim().slice(0, MAX_REASON);
          if (!reason) { errorLabel.setTextString("Please enter a reason."); evt.stop(); return true; }
          errorLabel.setTextString("");
          var user = lively.identity.did.currentUser();
          if (!user) { errorLabel.setTextString("Not signed in."); evt.stop(); return true; }

          var doc = {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Message flag: @" + targetHandle + " — " + reason }] }],
          };
          lively.identity.postCardSerializer.serializePlainToEnvelope({
            doc: doc,
            title: "Message flag: @" + targetHandle,
            titleExplicit: true,
            constellation: self._name,
            visibility: "public",
            stateMeta: { kind: "message-flag", reason: reason, targetDid: targetDid, targetHandle: targetHandle, targetObjId: objId },
          }, function (err, envelope) {
            if (err) { errorLabel.setTextString("Could not create report: " + err.message); return; }
            var base = lively.identity.did.baseUrl();
            fetch(base + "/@" + encodeURIComponent(user.handle) + "/" + encodeURIComponent(envelope.objId), {
              method: "PUT", credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(envelope),
            }).then(function (r) {
              if (!r.ok) throw new Error("Could not save report (" + r.status + ")");
              return fetch(base + "/c/" + encodeURIComponent(self._name) + "/flags", {
                method: "POST", credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ objId: envelope.objId, targetDid: targetDid, roomId: roomId }),
              });
            }).then(function (r) {
              if (!r.ok) return r.json().catch(function () { return {}; }).then(function (b) {
                throw new Error(b.error || ("Flag failed (" + r.status + ")"));
              });
              win.remove();
              $world.alert("Report sent to moderators.");
            }).catch(function (err2) {
              errorLabel.setTextString(err2.message);
            });
          });
          evt.stop();
          return true;
        };
        body.addMorph(sendBtn);

        var win = new lively.morphic.Window(body, "Flag message — @" + targetHandle);
        win.openInWorldCenter();
        win.comeForward();
        reasonField.focus();
      },

      // ── hover action toolbar ──────────────────────────────────────────────
      // Real children of `row` (per this file's own established pattern —
      // a sibling overlay doesn't reliably receive hover events on this
      // scrollable list), shown/hidden by the caller extending row's own
      // onMouseOver/onMouseOut (makeRow, _renderMessages). Persistent
      // rooms only — react/reply/edit/delete/flag all key off a real
      // signed-postcard objId, which an ephemeral message never has.
      _renderRowToolbar: function (row, msg, isMine, canModerate, topY, pad) {
        var self = this;
        if (this._room && this._room.ephemeral) return null;
        var user = lively.identity.did.currentUser();
        if (!user) return null;

        var icons = [];
        icons.push({ glyph: "add_reaction", action: function (btn) { self._openReactionPicker(msg, btn); } });
        icons.push({ glyph: "reply", action: function () { self._startReplyingTo(msg); } });
        if (isMine) icons.push({ glyph: "edit", action: function () { self._startEditingMessage(msg); } });
        if (isMine || canModerate) icons.push({ glyph: "delete", action: function () { self._deleteMessage(msg); } });
        if (!isMine) icons.push({ glyph: "flag", action: function () { self._openMessageFlagDialog(msg.objId, msg.did, msg.handle, self._roomId); } });
        if (!icons.length) return null;

        var BTN = 22, GAP = 2;
        var toolbarW = icons.length * BTN + (icons.length - 1) * GAP;
        var toolbar = noDrag(new lively.morphic.Box(lively.rect(self._chatW - pad - toolbarW, topY, toolbarW, BTN)));
        toolbar.applyStyle({ fill: Color.white, borderWidth: 1, borderColor: Color.rgba(43, 20, 63, 0.12), borderRadius: 6 });
        toolbar.setVisible(false);
        row.addMorph(toolbar);

        icons.forEach(function (spec, i) {
          var btn = noDrag(new lively.morphic.Text(lively.rect(i * (BTN + GAP), 0, BTN, BTN)));
          btn.textString = spec.glyph;
          btn.applyStyle({
            fontFamily: "'Material Symbols Rounded'", fontSize: 13, textColor: CHAT_TEXT_MUTED,
            fill: null, borderWidth: 0, align: "center", allowInput: false, selectable: false,
            clipMode: "hidden", whiteSpaceHandling: "pre", handStyle: "pointer",
          });
          btn.onMouseOver = function () { this.applyStyle({ textColor: ACCENT }); };
          btn.onMouseOut = function () { this.applyStyle({ textColor: CHAT_TEXT_MUTED }); };
          btn.onMouseUp = function (evt) { spec.action(btn); evt.stop(); return true; };
          toolbar.addMorph(btn);
        });

        return toolbar;
      },

      // Restores the typed text into the input on failure — losing a
      // half-typed message to a transient network/signing error would be a
      // worse experience than the recipient list waiting a moment longer.
      _onSendMessageFailed: function (text, err) {
        console.error("[RoomView] Failed to send message:", err);
        this._sendingMessage = false;
        this._scrollToBottomNext = false;
        if (!this._inputM) return; // window closed mid-send; the text is not restored
        this._inputM.textString = text;
        this._placeholderM.setVisible(!text);
        this._fitComposer();
      },

      // A message's own "text" is a Klipy GIF/sticker URL when it was sent
      // via _sendMediaMessage rather than typed — deliberately scoped to
      // gif/webp/mp4 (not png/jpg) so an ordinary typed message that
      // happens to paste some other image link doesn't get auto-embedded.
      _isMediaMessage: function (text) {
        return /^https?:\/\/\S+\.(gif|webp|mp4)(\?[^\s]*)?$/i.test(text || "");
      },

      // Country/subdivision flags render as literal two-letter text (or
      // nothing at all) via native Text morphs on this Windows/Chrome
      // environment — the same platform emoji-font gap
      // MediaPickerDialog.js's picker grid works around by swapping in a
      // vendored image per flag (confirmed live there: a raw non-Lively
      // <div> shows the identical failure, so this isn't a Lively/morphic
      // bug — see that file's own notes). A chat message is free-form
      // text though — a flag can sit anywhere inside arbitrary
      // surrounding words — so the picker's "swap the whole cell to an
      // Image morph" approach doesn't apply here. Instead this splits the
      // message into text/flag runs and renders the whole body as one
      // small chunk of raw HTML (a Box morph's shapeNode.innerHTML, the
      // same "rich content as HTML instead of a pure Text morph" pattern
      // PostCardUtils.js's own postcard rendering already uses elsewhere
      // in this app) with an inline <img> per flag run, letting the
      // browser's normal text-wrap flow mix them with surrounding words
      // for free — no manual line-layout code needed. Same regional-
      // indicator-pair / Tag-sequence detection as MediaPickerDialog.js's
      // needsFlagImage/flagImageUrl, duplicated rather than shared since
      // RoomView.js doesn't otherwise depend on that module.
      _splitFlagRuns: function (text) {
        var re = /[\u{1F1E6}-\u{1F1FF}]{2}|\u{1F3F4}[\u{E0000}-\u{E007F}]+/gu;
        var segments = [];
        var lastIndex = 0;
        var m;
        while ((m = re.exec(text))) {
          if (m.index > lastIndex) segments.push({ flag: false, value: text.slice(lastIndex, m.index) });
          segments.push({ flag: true, value: m[0] });
          lastIndex = m.index + m[0].length;
        }
        if (lastIndex < text.length) segments.push({ flag: false, value: text.slice(lastIndex) });
        return segments;
      },

      // Vendored image filenames are their own emoji's codepoints, hex,
      // hyphen-joined — see MediaPickerDialog.js's flagImageUrl for the
      // same computation and the completeness check confirming every
      // flag this could ever produce actually has a vendored file.
      _flagImageUrl: function (glyph) {
        var hex = Array.from(glyph).map(function (ch) { return ch.codePointAt(0).toString(16); }).join("-");
        return "/core/media/emoji-picker/flags/" + hex + ".png";
      },

      _messageBodyHtml: function (segments) {
        var self = this;
        return segments.map(function (s) {
          if (!s.flag) return self._linkifyHtml(s.value);
          return '<img src="' + self._flagImageUrl(s.value) + '" alt="" ' +
            'style="width:16px;height:16px;vertical-align:-3px;border-radius:2px;display:inline-block;">';
        }).join("");
      },

      // http(s) URLs inside a message, with the punctuation a sentence puts
      // right after a link left out of it: "see https://x.com/a." and
      // "(https://x.com/a)" both link to https://x.com/a, while a closing
      // paren that balances one inside the URL (a wiki page title like
      // /Foo_(bar)) stays part of it.
      _findUrls: function (text) {
        var out = [];
        var re = /https?:\/\/[^\s<>"']+/gi;
        var m;
        while ((m = re.exec(text || ""))) {
          var url = m[0], prev;
          do {
            prev = url;
            url = url.replace(/[.,;:!?]+$/, "");
            while (/\)$/.test(url) && (url.match(/\)/g) || []).length > (url.match(/\(/g) || []).length) url = url.slice(0, -1);
          } while (url !== prev);
          if (url.length > 8) out.push({ url: url, start: m.index, end: m.index + url.length });
          re.lastIndex = m.index + Math.max(url.length, m[0].length > 0 ? 1 : 0);
        }
        return out;
      },

      // Escapes `text` for innerHTML and turns each URL in it into a real
      // link. Without this a URL inside a sentence was inert text — only a
      // message that was nothing but a URL got linkified (by
      // hydrateLinkPreviews), so a link between words didn't even highlight.
      _linkifyHtml: function (text) {
        var esc = lively.identity.postCardUtils.escapeHtml;
        var out = "", last = 0;
        this._findUrls(text).forEach(function (u) {
          out += esc(text.slice(last, u.start)) +
            '<a href="' + esc(u.url) + '" target="_blank" rel="noopener noreferrer">' + esc(u.url) + '</a>';
          last = u.end;
        });
        return out + esc(text.slice(last));
      },

      // Preview cards for a message that has links INSIDE text. A message
      // that is nothing but one URL is handled by hydrateLinkPreviews (card
      // right after its own paragraph); this covers the rest, appending a
      // card per distinct URL (capped) below the text, in URL order even if
      // the fetches finish out of order. Same shared fetch cache and card
      // builder, so a URL previewed anywhere else is instant here.
      _attachInlineLinkCards: function (bodyNode, urls) {
        var U = lively.identity.postCardUtils;
        var MAX_INLINE_CARDS = 3;
        var distinct = [];
        urls.forEach(function (u) { if (distinct.indexOf(u.url) === -1) distinct.push(u.url); });
        distinct.slice(0, MAX_INLINE_CARDS).forEach(function (url, idx) {
          U.fetchLinkPreview(url, function (err, body) {
            if (err || !body || body.error) return; // silent, same as the bare-link path
            var card = U.buildLinkPreviewCard(body);
            card.setAttribute("data-rv-idx", String(idx));
            var before = null;
            Array.prototype.forEach.call(bodyNode.children, function (el) {
              if (!before && el.hasAttribute("data-rv-idx") && +el.getAttribute("data-rv-idx") > idx) before = el;
            });
            bodyNode.insertBefore(card, before);
          });
        });
      },

      // hydrateLinkPreviews (called right after bodyNode.innerHTML is set,
      // see _renderMessages' body branch) inserts a link-preview card
      // asynchronously — the first time a given URL is seen, via a real
      // network fetch; PostCardUtils.js's own _linkPreviewCache means every
      // later call (e.g. this room's own 4s message poll re-rendering the
      // same message) resolves synchronously from cache, but the FIRST
      // render still needs a way to notice the card landed after
      // bodyNode.scrollHeight was already read. A MutationObserver (rather
      // than a guessed timeout — see CLAUDE.md's measured-not-guessed
      // sizing rule) catches that insertion whenever it happens and caches
      // the real settled height by msg.text (same keying convention as
      // _mediaDims), then triggers one _renderMessages() reflow so this
      // row — and every row below it — gets the correct final layout.
      //
      // The watch lasts as long as the row's own node does — it used to
      // disconnect after 8s, and a preview that landed later (slow unfurl
      // fetch) left its row at the pre-card height for good, the card hanging
      // over the messages below it. That got worse once rows stopped being
      // rebuilt on every pass (nothing else heals it). `appliedH` is the
      // height the row's body box was actually given: only content TALLER
      // than that needs a relayout, which also keeps this from looping on
      // its own box height (scrollHeight is never below the box's height).
      // `load` (capture) covers cards that grow after insertion, e.g. an
      // image finishing — that is a layout change, not a DOM mutation.
      // The rebuild runs in a microtask rather than a timer so it lands
      // before the browser paints: no overlapping frame is ever shown.
      _watchLinkPreviewInsert: function (bodyNode, cacheKey, appliedH) {
        var self = this;
        var check = function () {
          var real = Math.max(18, bodyNode.scrollHeight);
          if (real <= appliedH) return;
          if (real <= (self._linkPreviewRowH[cacheKey] || 0)) return;
          self._linkPreviewRowH[cacheKey] = real;
          self._renderMessagesBeforePaint();
        };
        new MutationObserver(check).observe(bodyNode, { childList: true, subtree: true });
        bodyNode.addEventListener("load", check, true);
      },

      // Coalesces rebuilds requested within one task into a single one that
      // runs in a microtask, i.e. before the next paint.
      _renderMessagesBeforePaint: function () {
        var self = this;
        if (this._renderMicroPending) return;
        this._renderMicroPending = true;
        Promise.resolve().then(function () {
          self._renderMicroPending = false;
          self._renderMessages();
        });
      },

      _formatTime: function (isoOrTs) {
        var d = new Date(isoOrTs);
        var h = d.getHours(), m = d.getMinutes();
        var ampm = h >= 12 ? "PM" : "AM";
        h = h % 12; if (h === 0) h = 12;
        return h + ":" + (m < 10 ? "0" : "") + m + " " + ampm;
      },

      _formatDividerDate: function (isoOrTs) {
        return new Date(isoOrTs).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
      },

      // Persistent rooms only — the header's search icon button toggles
      // this. Opening pauses live polling (_loadMessages's own guard) so a
      // poll tick can't clobber the search results mid-view; closing drops
      // the results and lets polling resume (the very next tick just
      // re-fetches the live tail, no explicit re-fetch needed here).
      _toggleSearch: function () {
        this._searchActive = !this._searchActive;
        if (!this._searchActive) {
          this._searchResults = null;
          this._searchQuery = "";
        }
        if (this._headerBox) this._headerBox.remove();
        this._buildHeader(); // repaints the search button's own active/inactive style
        this._renderMessages();
      },

      _performSearch: function (q) {
        var self = this;
        this._searchQuery = q;
        if (!q) { this._searchResults = []; this._renderMessages(); return; }
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("GET", base + "/c/" + encodeURIComponent(this._name) + "/rooms/" + this._roomId +
          "/messages/search?q=" + encodeURIComponent(q), true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) return;
          var data;
          try { data = JSON.parse(xhr.responseText); } catch (e) { return; }
          if (!self._searchActive || self._searchQuery !== q) return; // stale response — search was closed or re-typed since
          self._searchResults = data.results || [];
          self._renderMessages();
        };
        xhr.send();
      },

      // Drawn as the first thing inside _msgListBox when _searchActive —
      // same input-pill styling as the compose box at the bottom
      // (_buildChatPanel), just smaller. Returns the y a caller should
      // start rendering results/messages from.
      _renderSearchBar: function (y) {
        var self = this;
        var PAD = 16;
        var barH = 34;
        var pill = noDrag(new lively.morphic.Box(lively.rect(PAD, y, self._chatW - PAD * 2, barH)));
        pill.applyStyle({ fill: BG_INPUT, borderWidth: 0, borderRadius: 8 });
        self._msgListBox.addMorph(pill);

        var input = noDrag(new lively.morphic.Text(lively.rect(12, 5, self._chatW - PAD * 2 - 24 - 32, 24)));
        input.beInputLine({
          fontSize: 13, fontFamily: "'Atkinson Hyperlegible', Helvetica, Arial, sans-serif", textColor: TEXT_PRIMARY,
          fill: null, borderWidth: 0, whiteSpaceHandling: "pre",
        });
        input.textString = this._searchQuery || "";
        pill.addMorph(input);
        input.onKeyDown = function (evt) {
          if (evt.getKeyCode && evt.getKeyCode() === 13) {
            self._performSearch((this.textString || "").trim());
            evt.stop();
            return true;
          }
        };
        input.focus();

        var closeBtn = noDrag(lively.morphic.Text.makeLabel("close", {
          fontSize: 15, textColor: TEXT_MUTED,
        }));
        closeBtn.applyStyle({ fontFamily: "'Material Symbols Rounded'", borderWidth: 0, fill: null, handStyle: "pointer" });
        closeBtn.setExtent(lively.pt(20, 20));
        closeBtn.setPosition(lively.pt((self._chatW - PAD * 2) - 32, 7));
        closeBtn.onMouseUp = function (evt) { self._toggleSearch(); evt.stop(); return true; };
        pill.addMorph(closeBtn);

        return y + barH + 14;
      },

      // _renderMessages rebuilds every row (and each row's toolbar), ~600ms
      // for a 38-message room — and each link-preview card / GIF that finishes
      // loading used to call it directly, so a room with a few of them ran
      // several back-to-back rebuilds right after opening, starving pointer
      // events (a title-bar drag got 1-2 onDrag calls in 700ms and the window
      // looked undraggable). Async hydration callbacks go through here
      // instead, so everything that lands within the delay costs one rebuild.
      _renderMessagesSoon: function () {
        var self = this;
        if (this._renderSoonTimer) return;
        this._renderSoonTimer = setTimeout(function () {
          self._renderSoonTimer = null;
          self._renderMessages();
        }, 150);
      },

      _renderMessages: function () {
        if (this._renderSoonTimer) { clearTimeout(this._renderSoonTimer); this._renderSoonTimer = null; }
        if (!this._msgListBox) return; // window closed — showView re-renders from this._messages
        var self = this;
        // Message rows are cached across passes (key -> {sig, row, y, h}); a
        // row whose signature is unchanged is kept as-is — only moved if the
        // rows above it changed height — so a new message, reaction, edit or
        // late-landing link preview costs a rebuild of THAT row, not of every
        // row (a full pass was ~370ms at 44 messages and ~3.8s at 400), and
        // untouched rows keep their embedded iframes (a playing video used to
        // be destroyed by every rebuild). Everything else in the list box
        // (date dividers, search bar, empty-state label) is cheap and rebuilt.
        var rowCache = (this._rowCacheOwner === this._msgListBox && this._rowCache) || {};
        var nextCache = {};
        // Decided BEFORE anything below touches the list: removing/rebuilding
        // rows can shrink scrollHeight and make the browser clamp scrollTop.
        // Follow the newest message only if the user was already there, this
        // is the first pass, I just sent a message, or search mode just
        // flipped (search pins to the top, so closing it needs the bottom
        // back). Otherwise put the scroll position back where it was.
        var listScrollNode = this._msgListBox.renderContext().shapeNode;
        var searchModeChanged = !!this._lastRenderSearch !== !!this._searchActive;
        this._lastRenderSearch = this._searchActive;
        var stickToBottom = this._pinnedToBottom !== false || this._scrollToBottomNext ||
          searchModeChanged || !(this._rowCacheOwner === this._msgListBox && this._rowCache);
        this._scrollToBottomNext = false;
        var prevScrollTop = listScrollNode.scrollTop;
        (this._msgListBox.submorphs || []).slice().forEach(function (m) { if (!m._rvRow) m.remove(); });
        // Rebuilt fresh every pass — _jumpToMessage reads these at click
        // time rather than a closure capturing them now, so a reply chip's
        // target stays correct even if the list re-renders (poll/reaction/
        // edit) before the user actually clicks it.
        self._rowTopByObjId = {};
        self._rowMorphByObjId = {};

        // Small breathing room between the "@handle  time" header line and
        // the message body below it. Plain text gets away without this (its
        // own font line-height already reads as a bit of a gap), but a media
        // row's hard rectangular top edge sat flush against the header
        // (confirmed live: both at the exact same pixel row) and read as
        // cramped/touching rather than a clean two-line message.
        var PAD = 16, ROW_GAP = 14, HEAD_GAP = 4;
        // The "@handle  time" header line was boxed at a guessed 20px —
        // confirmed live (getBoundingClientRect on the real content div)
        // the actual rendered line needs 21px, clipping the bottom pixel of
        // any descender (g/y/p) in every handle. 23 leaves real headroom
        // rather than the exact measured minimum.
        var HEAD_H = 26;
        var y = 12;
        // Discord/Slack-style per-message hover strip: invisible at rest,
        // fades in on hover for row separation without a permanent
        // border/shadow. Each message gets its own full-width wrapping row
        // Box, with avatar/header/body added AS ITS CHILDREN (local
        // coordinates, row-relative) rather than as flat siblings of
        // _msgListBox with the row sent behind them — a sibling box behind
        // opaque/transparent content in this scrollable list turned out to
        // be unreliable for real mouse hover (confirmed live via
        // chrome-devtools: elementFromPoint at empty parts of a row
        // resolved to the scroll container itself, never the sibling box,
        // even with an opaque test color forced on, and a real trusted
        // hover never triggered the fill). Making the row box the actual
        // DOM ancestor of its own content — matching the working
        // rooms-rail/members-panel row pattern elsewhere in this file —
        // means native mouse events on those children correctly bubble up
        // into it.
        function makeRow(top) {
          var row = noDrag(new lively.morphic.Box(lively.rect(0, top, self._chatW, 1)));
          row.applyStyle({ fill: null, borderWidth: 0, borderRadius: 6 });
          row._rvRow = true;
          self._msgListBox.addMorph(row);
          row.onMouseOver = function () { row.applyStyle({ fill: BG_MSG_ROW_HOVER }); };
          row.onMouseOut = function () { row.applyStyle({ fill: null }); };
          return row;
        }
        // An "L" connector — straight down from `start`, one smoothly
        // rounded 90° corner, straight across into `end` — rather than a
        // single freeform bezier (the first version of this), which read
        // as an arbitrary swoop instead of a clean right-angle turn.
        // `start` is directly above `corner` (same x); `end` is directly
        // beside `corner` (same y) — i.e. start drops straight down, then
        // the path turns to arrive at end horizontally. The standard SVG
        // rounded-corner trick: a straight line into the corner, a
        // quadratic curve (Q) whose control point IS the sharp corner
        // point itself (so both legs stay tangent to the curve), then a
        // straight line out. `lively.morphic.Shapes.PathElement.parse`
        // (the same primitive `Morph.makeCubicBezier` uses for its raw "C"
        // string) parses "Q" and "L" just as well.
        function makeElbowConnector(start, corner, end, radius, lineWidth, lineColor) {
          var legInEnd = lively.pt(corner.x, corner.y - radius * (corner.y > start.y ? 1 : -1));
          var legOutStart = lively.pt(corner.x - radius * (corner.x > end.x ? 1 : -1), corner.y);
          var ptToString = function (p) { return p.x + "," + p.y; };
          var d = "M" + ptToString(start) + "L" + ptToString(legInEnd) +
            "Q" + ptToString(corner) + " " + ptToString(legOutStart) +
            "L" + ptToString(end);
          var path = new lively.morphic.Path([lively.pt(0, 0), lively.pt(0, 0)]);
          path.shape.setPathElements(lively.morphic.Shapes.PathElement.parse(d));
          path.setBorderWidth(lineWidth);
          path.setBorderColor(lineColor);
          path.shape.getBounds = function () {
            var b = this.renderContext().pathNode.getBBox();
            return new Rectangle(b.x - lineWidth, b.y - lineWidth, b.width + 2 * lineWidth, b.height + 2 * lineWidth);
          };
          return path;
        }
        // Discord-style day-boundary divider: a centered date label flanked
        // by thin rule lines. Text width is measured off the real rendered
        // <span> right after addMorph (same same-tick measurement idiom
        // already relied on below for message body height, ~bodyM) rather
        // than guessed, so the flanking lines meet the text edges cleanly
        // regardless of date-string length/locale.
        function renderDateDivider(top, iso) {
          var DIV_H = 24, DIV_MARGIN = 10;
          var divRow = noDrag(new lively.morphic.Box(lively.rect(0, top + DIV_MARGIN, self._chatW, DIV_H)));
          divRow.applyStyle({ fill: null, borderWidth: 0 });
          divRow.eventsAreIgnored = true;
          self._msgListBox.addMorph(divRow);

          var label = noDrag(lively.morphic.Text.makeLabel(self._formatDividerDate(iso), {
            fontSize: 12, fontWeight: "600", textColor: CHAT_TEXT_MUTED, fixedWidth: true, fixedHeight: true,
          }));
          label.eventsAreIgnored = true;
          label.setExtent(lively.pt(260, DIV_H));
          divRow.addMorph(label);
          var span = label.renderContext().shapeNode.querySelector("span");
          var textW = (span && span.offsetWidth) || 140;
          label.setExtent(lively.pt(textW + 8, DIV_H));
          label.setPosition(lively.pt(Math.round((self._chatW - textW) / 2) - 4, 0));

          var lineColor = Color.rgba(124, 100, 158, 0.35);
          var lineY = Math.round(DIV_H / 2);
          var lineGap = 10;
          var lineW = Math.round((self._chatW - textW) / 2) - lineGap - PAD;
          if (lineW > 0) {
            var leftLine = noDrag(new lively.morphic.Box(lively.rect(PAD, lineY, lineW, 1)));
            leftLine.applyStyle({ fill: lineColor, borderWidth: 0 });
            leftLine.eventsAreIgnored = true;
            divRow.addMorph(leftLine);
            var rightLine = noDrag(new lively.morphic.Box(lively.rect(self._chatW - PAD - lineW, lineY, lineW, 1)));
            rightLine.applyStyle({ fill: lineColor, borderWidth: 0 });
            rightLine.eventsAreIgnored = true;
            divRow.addMorph(rightLine);
          }

          return top + DIV_MARGIN + DIV_H + DIV_MARGIN;
        }
        if (this._searchActive) y = this._renderSearchBar(y);
        var list = this._searchActive ? (this._searchResults || []) : this._messages;
        var lastDayKey = null;
        var canModerate = this._canModerateRoom(); // same for every row — computed once, not per-message
        var currentUser = lively.identity.did.currentUser();
        if (this._searchActive && !list.length) {
          var empty = noDrag(lively.morphic.Text.makeLabel(
            this._searchQuery ? "No messages found." : "Type to search this cluster's message history.",
            { fontSize: 13, textColor: CHAT_TEXT_MUTED }
          ));
          empty.eventsAreIgnored = true;
          empty.setExtent(lively.pt(self._chatW - PAD * 2, 20));
          empty.setPosition(lively.pt(PAD, y));
          self._msgListBox.addMorph(empty);
        }
        list.forEach(function (msg) {
          if (!self._searchActive) {
            var dayKey = new Date(msg.created).toDateString();
            if (dayKey !== lastDayKey) {
              y = renderDateDivider(y, msg.created);
              lastDayKey = dayKey;
            }
          }
          // Block/mute gating (DID.js's relationships category) — checked
          // per-message since each carries its own sender did/handle.
          // Block fully hides content (fixed-height placeholder, no
          // expand); mute collapses to one line with a click-to-expand
          // toggle. See CLAUDE.md's Ignore/Mute assumption note in DID.js.
          var isBlockedMsg = lively.identity.did.isBlocked(msg.did, msg.handle);
          var isMuted = lively.identity.did.isMuted(msg.did, msg.handle);
          var muteKey = msg.objId || (msg.did + "|" + msg.created);
          var muteExpanded = !!self._mutedExpanded[muteKey];
          var isMine = !!(currentUser && msg.did === currentUser.did);
          var isEditingThis = !!(msg.objId && msg.objId === self._editingObjId);

          // Reuse the previous pass's row when nothing it renders from has
          // changed. The signature must cover EVERY input the build below
          // reads, or a stale row sticks around: the message's own fields,
          // block/mute/edit state, who's viewing, the reply parent's
          // handle+text (the reply chip shows them), and the two async
          // height caches (a link preview / GIF landing changes those, which
          // is exactly what should rebuild that one row).
          var rowKey = msg.objId || (msg.did + "|" + msg.created);
          while (nextCache[rowKey]) rowKey += "#";
          var replyParent = (msg.replyTo && msg.replyTo.objId) ? self._findMessageByObjId(msg.replyTo.objId) : null;
          var rowSig = JSON.stringify([
            self._chatW, self._searchActive ? 1 : 0, !!(self._room && self._room.ephemeral),
            msg.did, msg.handle, msg.text, msg.created, msg.editedAt || null, msg.reactions || null,
            msg.replyTo ? (msg.replyTo.objId || 1) : null,
            replyParent ? [replyParent.handle, replyParent.did, replyParent.text] : null,
            isBlockedMsg, isMuted, muteExpanded, isMine, canModerate, isEditingThis,
            currentUser ? currentUser.did : null,
            self._linkPreviewRowH[msg.text] === undefined ? null : self._linkPreviewRowH[msg.text],
            self._mediaDims[msg.text] || null,
          ]);
          var cachedRow = rowCache[rowKey];
          if (cachedRow && cachedRow.sig === rowSig && cachedRow.row.owner === self._msgListBox) {
            if (cachedRow.y !== y) { cachedRow.row.setPosition(lively.pt(0, y)); cachedRow.y = y; }
            nextCache[rowKey] = cachedRow;
            if (msg.objId) { self._rowTopByObjId[msg.objId] = y; self._rowMorphByObjId[msg.objId] = cachedRow.row; }
            y += cachedRow.h + ROW_GAP;
            return;
          }
          if (cachedRow && cachedRow.row.owner) cachedRow.row.remove();
          var rowY = y;

          if (isBlockedMsg) {
            var row = makeRow(y);
            if (msg.objId) { self._rowTopByObjId[msg.objId] = y; self._rowMorphByObjId[msg.objId] = row; }
            var lockAv = noDrag(lively.morphic.Text.makeLabel("lock", { fontSize: 16, textColor: CHAT_TEXT_MUTED }));
            lockAv.applyStyle({ fontFamily: "'Material Symbols Rounded'", borderWidth: 0, fill: null, align: "center" });
            lockAv.eventsAreIgnored = true;
            lockAv.setExtent(lively.pt(AVATAR_MSG, AVATAR_MSG));
            lockAv.setPosition(lively.pt(PAD, 0));
            row.addMorph(lockAv);

            var blockedLabel = noDrag(lively.morphic.Text.makeLabel("Message from blocked profile", {
              fontSize: 12, textColor: CHAT_TEXT_MUTED, fixedWidth: true, fixedHeight: true,
            }));
            blockedLabel.eventsAreIgnored = true;
            blockedLabel.setExtent(lively.pt(self._chatW - PAD * 2 - AVATAR_MSG - 8, AVATAR_MSG));
            blockedLabel.setPosition(lively.pt(PAD + AVATAR_MSG + 8, Math.round((AVATAR_MSG - 16) / 2)));
            row.addMorph(blockedLabel);

            row.setExtent(lively.pt(self._chatW, AVATAR_MSG));
            nextCache[rowKey] = { sig: rowSig, row: row, y: rowY, h: AVATAR_MSG };
            y += AVATAR_MSG + ROW_GAP;
            return;
          }
          var row = makeRow(y);
          if (msg.objId) { self._rowTopByObjId[msg.objId] = y; self._rowMorphByObjId[msg.objId] = row; }

          // Discord-style: a lightweight reply-preview chip rendered above
          // the avatar/header, inline in the same flat list — not a
          // separate thread panel. The parent is looked up client-side
          // against already-loaded messages; a parent outside the current
          // page degrades gracefully to a handle-less line (no avatar, no
          // connector, no click — there's nowhere to jump to) rather than a
          // second network round trip.
          var contentTop = 0;
          var replyM = null, replyAv = null;
          if (msg.replyTo && msg.replyTo.objId) {
            contentTop = REPLY_PREVIEW_H;
            var parent = self._findMessageByObjId(msg.replyTo.objId);
            if (parent) {
              var parentObjId = parent.objId;
              // Sits close to the BIG avatar's own column rather than all
              // the way out at the header-text column, offset right from
              // its horizontal center by REPLY_ELBOW_DX — the connector
              // below touches this avatar on its LEFT edge and the big
              // avatar on its TOP, so that offset is what gives the elbow a
              // real horizontal leg to turn through instead of degenerating
              // into a straight vertical line.
              var replyAvX = PAD + AVATAR_MSG / 2 + REPLY_ELBOW_DX;
              replyAv = noDrag(new lively.morphic.Image(lively.rect(replyAvX, 1, REPLY_AVATAR, REPLY_AVATAR)));
              replyAv.applyStyle({ borderRadius: REPLY_AVATAR / 2, borderWidth: 0, clipMode: "hidden" });
              replyAv.setImageURL(lively.identity.postCardUtils.identiconDataUrl(parent.handle || parent.did || "unknown", REPLY_AVATAR));
              row.addMorph(replyAv);

              var snippetText = "@" + (parent.handle || "someone") + "  " + (parent.text || "").replace(/\s+/g, " ").slice(0, 50);
              replyM = noDrag(lively.morphic.Text.makeLabel(snippetText, {
                fontSize: 12, textColor: CHAT_TEXT_FAINT, fixedWidth: true, fixedHeight: true, whiteSpaceHandling: "pre",
              }));
              replyM.setExtent(lively.pt(self._chatW - PAD - (replyAvX - PAD) - REPLY_AVATAR - 6, REPLY_PREVIEW_H));
              replyM.setPosition(lively.pt(replyAvX + REPLY_AVATAR + 6, 0));
              row.addMorph(replyM);

              [replyAv, replyM].forEach(function (m) {
                // Text.makeLabel (replyM) runs beLabel(), which calls
                // ignoreEvents() internally and leaves eventsAreIgnored
                // true — confirmed live to silently swallow onMouseUp
                // (Events.js's onMouseUpEntry early-returns on that flag
                // before ever calling this.onMouseUp), the same thing the
                // existing muted-message label works around by setting
                // eventsAreIgnored back to false. Harmless to also set on
                // replyAv (an Image, default already false).
                m.eventsAreIgnored = false;
                m.handStyle = "pointer";
                m.onMouseUp = function (evt) { self._jumpToMessage(parentObjId); evt.stop(); return true; };
              });
            } else {
              replyM = noDrag(lively.morphic.Text.makeLabel("Replying to a message", {
                fontSize: 12, textColor: CHAT_TEXT_FAINT, fixedWidth: true, fixedHeight: true, whiteSpaceHandling: "pre",
              }));
              replyM.eventsAreIgnored = true;
              replyM.setExtent(lively.pt(self._chatW - PAD * 2 - AVATAR_MSG - 8, REPLY_PREVIEW_H));
              replyM.setPosition(lively.pt(PAD + AVATAR_MSG + 8, 0));
              row.addMorph(replyM);
            }
          }

          var av = noDrag(new lively.morphic.Image(lively.rect(PAD, contentTop, AVATAR_MSG, AVATAR_MSG)));
          av.applyStyle({ borderRadius: AVATAR_MSG / 2, borderWidth: 0, clipMode: "hidden" });
          av.setImageURL(lively.identity.postCardUtils.identiconDataUrl(msg.handle || msg.did || "unknown", AVATAR_MSG));
          av.eventsAreIgnored = true;
          row.addMorph(av);

          if (replyAv) {
            // "L" connector linking the reply chip's small parent-message
            // avatar above to the actual message's avatar below it,
            // Discord-style — touching each avatar's own circumference
            // (not its center): the small (original-sender) avatar on its
            // LEFT edge, the big (replier's) avatar on its TOP. A vertical
            // approach is only a true tangent at the big avatar's topmost
            // point (its center x); a horizontal approach is only a true
            // tangent at the small avatar's leftmost point (its center y).
            // REPLY_ELBOW_DX (baked into replyAvX above) is what gives this
            // a real horizontal leg instead of collapsing into one straight
            // vertical line. `makeElbowConnector`'s own start/corner/end
            // just need start-to-corner vertical and corner-to-end
            // horizontal — passing the big avatar's top as `start` here
            // (rather than the small avatar's side, which was `start` in
            // the old bottom-to-top version) draws the identical stroke,
            // just built from the other end.
            var smallAvLeft = lively.pt(replyAvX, 1 + REPLY_AVATAR / 2);
            var bigAvTop = lively.pt(PAD + AVATAR_MSG / 2, contentTop);
            var connCorner = lively.pt(bigAvTop.x, smallAvLeft.y);
            var connRadius = Math.max(2, Math.min(6, bigAvTop.y - connCorner.y - 1, smallAvLeft.x - connCorner.x - 1));
            var connector = noDrag(makeElbowConnector(bigAvTop, connCorner, smallAvLeft, connRadius, 1.5, CHAT_TEXT_FAINT));
            connector.eventsAreIgnored = true;
            row.addMorph(connector);
            // eventsAreIgnored only makes this transparent to Lively's own
            // morphic dispatch — the browser's native hit-testing still
            // resolves clicks to the connector's real SVG <path> node when
            // it overlaps replyAv underneath, confirmed live (document.
            // elementFromPoint landed on the path, not the avatar). Real
            // CSS pointer-events is the actual fix.
            connector.renderContext().shapeNode.style.pointerEvents = "none";
          }
          // Dim via the real DOM node's CSS opacity — Image morphs' own
          // "fill" style only shows through transparent image regions, not
          // a usable overlay-tint, so this is a direct-DOM write rather
          // than a model-layer style (same class of gap as CLAUDE.md's
          // "applyStyle can silently never reach the DOM" note, sidestepped
          // here by not routing through applyStyle at all for this bit).
          if (isMuted) av.renderContext().shapeNode.style.opacity = "0.4";

          var headText = "@" + (msg.handle || "unknown") + "   " + self._formatTime(msg.created) +
            (isMuted ? "   (ignored" + (muteExpanded ? " — showing)" : ", click to show)") : "") +
            (msg.editedAt ? "   (edited)" : "");
          var headM = noDrag(lively.morphic.Text.makeLabel(headText, {
            fontSize: 13, fontWeight: "700", textColor: isMuted ? CHAT_TEXT_MUTED : CHAT_TEXT_PRIMARY, fixedWidth: true, fixedHeight: true,
          }));
          headM.eventsAreIgnored = !isMuted;
          if (isMuted) {
            headM.handStyle = "pointer";
            headM.onMouseUp = function (evt) {
              if (muteExpanded) delete self._mutedExpanded[muteKey]; else self._mutedExpanded[muteKey] = true;
              self._renderMessages();
              evt.stop();
              return true;
            };
          }
          headM.setExtent(lively.pt(self._chatW - PAD * 2 - AVATAR_MSG - 8, HEAD_H));
          headM.setPosition(lively.pt(PAD + AVATAR_MSG + 8, contentTop));
          row.addMorph(headM);

          var bw = self._chatW - PAD * 2 - AVATAR_MSG - 8;
          var bh;
          if (isEditingThis) {
            // Inline edit: swap the read-only body for a real input,
            // pre-filled from the last known draft (not msg.text) so a
            // poll-triggered rebuild mid-edit doesn't discard unsaved
            // keystrokes — see _loadMessages' own polling-safety note.
            var editInput = noDrag(new lively.morphic.Text(lively.rect(
              PAD + AVATAR_MSG + 8, contentTop + HEAD_H + HEAD_GAP, bw, 24)));
            editInput.beInputLine({
              fontSize: 13, fontFamily: "'Atkinson Hyperlegible', Helvetica, Arial, sans-serif", textColor: CHAT_TEXT_PRIMARY,
              fill: Color.white, borderWidth: 1, borderColor: ACCENT, borderRadius: 4,
              whiteSpaceHandling: "pre",
            });
            editInput.textString = self._editingDraftText != null ? self._editingDraftText : (msg.text || "");
            row.addMorph(editInput);
            editInput.onKeyUp = function () { self._editingDraftText = editInput.textString; };
            editInput.onKeyDown = function (evt) {
              var code = evt.getKeyCode && evt.getKeyCode();
              if (code === 13) {
                self._saveMessageEdit(msg.objId, msg.handle, (editInput.textString || "").trim());
                evt.stop();
                return true;
              }
              if (code === 27) { self._cancelEditingMessage(); evt.stop(); return true; }
            };
            setTimeout(function () { if (editInput.focus) editInput.focus(); }, 0);

            var saveBtn = noDrag(lively.morphic.Text.makeLabel("Save", { fontSize: 12, fontWeight: "700", textColor: ACCENT }));
            saveBtn.handStyle = "pointer";
            saveBtn.setPosition(lively.pt(PAD + AVATAR_MSG + 8, contentTop + HEAD_H + HEAD_GAP + 28));
            saveBtn.onMouseUp = function (evt) {
              self._saveMessageEdit(msg.objId, msg.handle, (editInput.textString || "").trim());
              evt.stop();
              return true;
            };
            row.addMorph(saveBtn);

            var cancelBtn = noDrag(lively.morphic.Text.makeLabel("Cancel", { fontSize: 12, textColor: CHAT_TEXT_MUTED }));
            cancelBtn.handStyle = "pointer";
            cancelBtn.setPosition(lively.pt(PAD + AVATAR_MSG + 8 + 44, contentTop + HEAD_H + HEAD_GAP + 28));
            cancelBtn.onMouseUp = function (evt) { self._cancelEditingMessage(); evt.stop(); return true; };
            row.addMorph(cancelBtn);

            bh = 24 + 4 + 16;
          } else if (isMuted && !muteExpanded) {
            // Collapsed: one truncated line, no media/flag rendering.
            var oneLine = (msg.text || "").replace(/\s+/g, " ").trim();
            if (oneLine.length > 60) oneLine = oneLine.slice(0, 59) + "…";
            var collapsedM = noDrag(lively.morphic.Text.makeLabel(oneLine, {
              fontSize: 13, textColor: CHAT_TEXT_FAINT, fixedWidth: true, fixedHeight: true, whiteSpaceHandling: "pre",
            }));
            collapsedM.eventsAreIgnored = true;
            collapsedM.setExtent(lively.pt(bw, 18));
            collapsedM.setPosition(lively.pt(PAD + AVATAR_MSG + 8, contentTop + HEAD_H + HEAD_GAP));
            row.addMorph(collapsedM);
            bh = 18 + 4;
          } else if (self._isMediaMessage(msg.text)) {
            // A GIF/sticker sent via the picker (_sendMediaMessage) — its
            // own message "text" is just the media's own URL (no schema
            // change needed: the room-message envelope's state.title is
            // already a plain string, see ObjectRepository.js's
            // listMessagesForRoom). The real aspect ratio isn't known until
            // the image loads, so the first time a given URL is rendered
            // this reserves the generous MEDIA_ROW_H placeholder (keeping
            // this render pass synchronous) and lets setImageURL's own
            // maxWidth/maxHeight/keepAspectRatio shrink the morph down once
            // loaded — but that placeholder height used to stick around
            // permanently even after the shrink, leaving a dead gap below
            // any image shorter than 190px (confirmed live: a 480x268 GIF
            // capped to 220px wide rendered 123px tall, leaving ~67px of
            // empty space before the next message). _mediaDims caches the
            // real loaded extent by URL and triggers one re-render so the
            // row collapses to the image's own size from then on.
            var mw = Math.min(bw, 220);
            var cachedDims = self._mediaDims[msg.text];
            bh = cachedDims ? cachedDims.h : MEDIA_ROW_H;
            var mediaM = noDrag(new lively.morphic.Image(lively.rect(
              PAD + AVATAR_MSG + 8, contentTop + HEAD_H + HEAD_GAP,
              cachedDims ? cachedDims.w : mw, bh)));
            mediaM.applyStyle({ borderRadius: 6, borderWidth: 0, clipMode: "hidden" });
            mediaM.eventsAreIgnored = true;
            mediaM.setImageURL(msg.text, { maxWidth: mw, maxHeight: MEDIA_ROW_H, keepAspectRatio: true }, function (err, imgMorph) {
              if (err || !self._msgListBox) return;
              var ext = imgMorph.getExtent();
              var next = { w: Math.round(ext.x), h: Math.round(ext.y) };
              var prev = self._mediaDims[msg.text];
              self._mediaDims[msg.text] = next;
              if (!prev || prev.w !== next.w || prev.h !== next.h) self._renderMessagesSoon();
            });
            row.addMorph(mediaM);
          } else {
            // Always the raw-HTML Box path now, flags or not — a flag
            // <img> needs to sit inline in native text flow (see
            // _messageBodyHtml's own comment), and a message that's
            // NOTHING but a bare URL needs the same innerHTML scan
            // hydrateLinkPreviews already runs for postcards/wiki pages/
            // cluster comments (PostCardUtils.js's "legacy bare-URL
            // paragraph" fallback — no schema change needed here, chat
            // messages are already plain strings). A link inside text
            // ("check this out: https://...") is linkified by
            // _messageBodyHtml and gets its card(s) via _attachInlineLinkCards.
            var flagSegments = self._splitFlagRuns(msg.text);
            var bodyBox = noDrag(new lively.morphic.Box(lively.rect(PAD + AVATAR_MSG + 8, contentTop + HEAD_H + HEAD_GAP, bw, 1)));
            bodyBox.applyStyle({ fill: null, borderWidth: 0 });
            bodyBox.eventsAreIgnored = true;
            row.addMorph(bodyBox);
            var bodyNode = bodyBox.renderContext().shapeNode;
            bodyNode.style.fontFamily = "'Atkinson Hyperlegible', Helvetica, Arial, sans-serif";
            bodyNode.style.fontSize = "17px";
            bodyNode.style.color = "rgb(24, 8, 40)";
            bodyNode.style.lineHeight = "1.45";
            // pre-wrap: preserves real newlines/spaces in a multi-line
            // message (matching the old Text-morph path's whiteSpaceHandling)
            // while still wrapping long lines instead of overflowing bw.
            bodyNode.style.whiteSpace = "pre-wrap";
            bodyNode.style.wordBreak = "break-word";
            // Lively's base stylesheet (Main.js) sets user-select:none on
            // every element individually (`*:not(:focus)`), so neither half
            // of the opt-out works alone, both confirmed live:
            //  - the `.selectable` class only sets `user-select: auto` (on
            //    the node and, via `.selectable *`, its descendants), and
            //    `auto` resolves to `none` under a `none` parent — the row/
            //    list morph nodes above this are — so the node itself needs
            //    an explicit `text`;
            //  - that inline `text` on the node isn't inherited by the
            //    <p>/<span> inside it, since `*` gives each of them its own
            //    `none` — the class's `.selectable *` rule is what resets
            //    them to `auto`, which then resolves to `text` under this
            //    node.
            bodyNode.classList.add("selectable");
            bodyNode.style.userSelect = "text";
            bodyNode.style.webkitUserSelect = "text";
            bodyNode.style.cursor = "text";
            // Wrapped in its own <p> so hydrateLinkPreviews' bare-link scan
            // (querySelectorAll('p, li'), checking each block's ONLY child)
            // has a block element to test — a bare top-level text node
            // isn't itself a candidate.
            var lockHtml = msg.text === E2EE_UNDECRYPTABLE_TEXT
              ? lively.identity.postCardUtils.lockGlyphHtml({ size: 17 }) + " " : "";
            bodyNode.innerHTML = "<p style=\"margin:0;\">" + lockHtml + self._messageBodyHtml(flagSegments) + "</p>";
            lively.identity.postCardUtils.hydrateLinkPreviews(bodyNode);
            lively.identity.postCardUtils.hydrateLinkPreviewEmbeds(bodyNode);
            var msgUrls = self._findUrls(msg.text);
            // Not the bare-URL-only case, which hydrateLinkPreviews above
            // already gave its card.
            if (msgUrls.length && (msg.text || "").trim() !== msgUrls[0].url) {
              self._attachInlineLinkCards(bodyNode, msgUrls);
            }
            var linkCacheKey = msg.text;
            var cachedLinkH = self._linkPreviewRowH[linkCacheKey];
            bh = cachedLinkH != null ? cachedLinkH : (bodyNode.scrollHeight || 18);
            bodyBox.setExtent(lively.pt(bw, bh + 4));
            self._watchLinkPreviewInsert(bodyNode, linkCacheKey, bh + 4);
            bh = bh + 4;
          }

          // Reaction pill row, below the body — 0 extra height when there
          // are no reactions. Skipped while mid-edit (react/reply/flag
          // aren't offered on the row being edited either, see the
          // toolbar hookup below).
          var pillRowH = isEditingThis ? 0 : self._renderReactionPillRow(row, msg, contentTop + HEAD_H + HEAD_GAP + bh, PAD, bw);

          var totalH = contentTop + HEAD_H + HEAD_GAP + bh + pillRowH;
          row.setExtent(lively.pt(self._chatW, totalH));

          if (!isEditingThis) {
            // Built on the row's first hover, not up front: ~7ms per row,
            // paid on every _renderMessages pass for every row, it was
            // roughly a third of a full rebuild — and almost no row is ever
            // hovered before the next rebuild replaces it anyway.
            var toolbar = null, toolbarBuilt = false;
            var baseOver = row.onMouseOver, baseOut = row.onMouseOut;
            row.onMouseOver = function () {
              baseOver();
              if (!toolbarBuilt) {
                toolbarBuilt = true;
                toolbar = self._renderRowToolbar(row, msg, isMine, canModerate, contentTop, PAD);
              }
              if (toolbar) toolbar.setVisible(true);
            };
            row.onMouseOut = function () { baseOut(); if (toolbar) toolbar.setVisible(false); };
          }

          nextCache[rowKey] = { sig: rowSig, row: row, y: rowY, h: totalH };
          y += totalH + ROW_GAP;
        });

        // Rows whose message is gone (deleted, or outside the current
        // search results) — anything not carried into this pass's cache.
        Object.keys(rowCache).forEach(function (k) {
          var old = rowCache[k];
          if (nextCache[k] !== old && old.row.owner) old.row.remove();
        });
        this._rowCache = nextCache;
        this._rowCacheOwner = this._msgListBox;

        var scrollNode = this._msgListBox.renderContext().shapeNode;
        // Search mode: stay pinned to the top (the search bar + newest
        // match) rather than the live-chat convention of scrolling to the
        // newest message at the bottom.
        if (this._searchActive) {
          scrollNode.scrollTop = 0;
        } else if (stickToBottom) {
          scrollNode.scrollTop = scrollNode.scrollHeight;
          this._pinnedToBottom = true;
        } else {
          scrollNode.scrollTop = prevScrollTop;
        }
      },

    },

    // ─── members panel ───────────────────────────────────────────────────────────
    // Real data (RoomPresence's live roster) — not mocked, unlike chat.

    "members", {

      _buildMembersPanel: function () {
        var panel = noDrag(new lively.morphic.Box(lively.rect(
          this._originX + CHAT_X_OFFSET + CHAT_W + PANEL_GAP, this._originY + HEADER_H, MEMBERS_W, BODY_H)));
        panel.applyStyle({ fill: BG_SIDEBAR, borderWidth: 0, clipMode: { x: "hidden", y: "auto" } });
        this._ensureScrollbarStyle();
        panel.renderContext().shapeNode.classList.add("roomview-scroll-dark");
        this._viewRoot.addMorph(panel);
        this._membersBox = panel;

        var heading = noDrag(lively.morphic.Text.makeLabel("MEMBERS", {
          fontSize: 12, fontWeight: "700", textColor: TEXT_FAINT,
        }));
        heading.eventsAreIgnored = true;
        heading.setExtent(lively.pt(MEMBERS_W - 32, 16));
        heading.setPosition(lively.pt(16, 16));
        panel.addMorph(heading);
        this._membersHeading = heading;
      },

      _renderMembers: function () {
        if (!this._membersBox) return; // window closed — session keeps the roster, showView re-renders
        var self = this;
        (this._membersBox.submorphs || []).slice().forEach(function (m) {
          if (m !== self._membersHeading) m.remove();
        });

        this._membersHeading.textString = "MEMBERS — " + this._participants.length;

        var user = lively.identity.did.currentUser();
        var myDid = user ? user.did : null;
        var statusColors = lively.identity.AmbientPresencePanel;
        var y = 44;
        this._participants.forEach(function (p) {
          var row = noDrag(new lively.morphic.Box(lively.rect(8, y, MEMBERS_W - 16, 40)));
          row.applyStyle({ fill: null, borderWidth: 0, borderRadius: 6 });
          row.onMouseOver = function () { row.applyStyle({ fill: BG_ROW_HOVER }); };
          row.onMouseOut = function () { row.applyStyle({ fill: null }); };
          self._membersBox.addMorph(row);

          var handle = p.handle || "unknown";
          // The whole row opens the member's mini profile. Its children are all
          // decorative (eventsAreIgnored), so nothing nested competes for the
          // click. The closure is fine here: RoomView is a plain class, not a
          // BuildSpec/addScript-reconstructed method. Skipped when the roster
          // entry has no handle, since there's no profile to load.
          if (p.handle) {
            row.handStyle = "pointer";
            row.onMouseUp = function (evt) {
              lively.require("lively.identity.MiniProfileCard").toRun(function () {
                lively.identity.MiniProfileCard.open(p.handle, p.did, row, {
                  roomContext: true,
                  isController: !!self._isController,
                  constellationName: self._name,
                  roomId: self._roomId,
                });
              });
              evt.stop();
              return true;
            };
          }
          var av = noDrag(new lively.morphic.Image(lively.rect(8, 6, AVATAR_MEMBER, AVATAR_MEMBER)));
          av.applyStyle({ borderRadius: AVATAR_MEMBER / 2, borderWidth: 0, clipMode: "hidden" });
          av.setImageURL(lively.identity.postCardUtils.identiconDataUrl(handle, AVATAR_MEMBER));
          av.eventsAreIgnored = true;
          row.addMorph(av);

          var statusInfo = self._memberStatuses[p.did];
          var statusKey = (statusInfo && statusInfo.status) || "online";
          var dotFill = statusKey === "idle" ? statusColors.STATUS_IDLE
            : statusKey === "dnd" ? statusColors.STATUS_DND
            : statusKey === "invisible" ? statusColors.STATUS_INVISIBLE
            : ONLINE;
          var dot = noDrag(new lively.morphic.Morph());
          dot.setShape(new lively.morphic.Shapes.Ellipse(lively.rect(8 + AVATAR_MEMBER - 8, 6 + AVATAR_MEMBER - 8, 10, 10)));
          dot.applyStyle({ fill: dotFill, borderWidth: 2, borderColor: BG_SIDEBAR });
          dot.eventsAreIgnored = true;
          row.addMorph(dot);

          var nameM = noDrag(lively.morphic.Text.makeLabel(
            "@" + handle + (p.did === myDid ? " (you)" : ""),
            { fontSize: 13, fontWeight: "600", textColor: TEXT_PRIMARY, fixedWidth: true, fixedHeight: true }
          ));
          nameM.eventsAreIgnored = true;
          // 18 clipped the bottom of any descender (e.g. the "y" in
          // "@gameboy") — confirmed live via the shapeNode's own
          // scrollHeight (~21px for 13px bold text); 22 covers it with a
          // little headroom rather than the exact measured minimum.
          nameM.setExtent(lively.pt(MEMBERS_W - 16 - AVATAR_MEMBER - 16, 22));
          nameM.setPosition(lively.pt(8 + AVATAR_MEMBER + 8, 9));
          row.addMorph(nameM);

          y += 44;
        });

        if (!this._participants.length) {
          var empty = noDrag(lively.morphic.Text.makeLabel("No one's here yet.", { fontSize: 13, textColor: TEXT_FAINT }));
          empty.eventsAreIgnored = true;
          empty.setExtent(lively.pt(MEMBERS_W - 32, 18));
          empty.setPosition(lively.pt(16, 44));
          this._membersBox.addMorph(empty);
        }
      },

    },

    // ─── video: grid tiles + floating circles ────────────────────────────────────
    // A video room shows each present participant in one of two ways:
    //  - GRID TILES, inside the room window's center column, while the window is
    //    open and expanded. With the chat toggle off the grid fills the column
    //    (everyone, chat hidden); with it on, the column splits into the ACTIVE
    //    SPEAKER only (left) and a narrower chat panel (right).
    //  - CIRCLES, floating draggable loom-style discs added directly to $world,
    //    while the window is collapsed or closed. Being world-owned they outlive
    //    the window (Window#collapse detaches the window's content), and each one
    //    remembers where it was last dragged (_circleSpots).
    // Your own picture streams a real getUserMedia camera preview (obtained via
    // AmbientPresencePanel.enterRoom/getLocalStream, not acquired separately
    // here); everyone else's streams a real remote MediaStream over a direct
    // RTCPeerConnection (see the "webrtc" category below) once that peer's
    // signaling handshake completes — until then (or if it never completes:
    // camera/mic both off on their end, connection still negotiating, ICE
    // failed) the surface shows a static identicon placeholder instead.
    // _syncVideoMode decides which of the two is up; everything that needs "the
    // pictures of participant X" goes through _videoSurfaces(did).

    "video", {

      // The grid panel sits over the center column, added after the chat panel so
      // it paints above it. Tiles are built into it by _renderVideoGrid.
      _buildVideoLayer: function () {
        if (!this._hasVideoCircles()) return;
        var grid = noDrag(new lively.morphic.Box(lively.rect(
          this._originX + CHAT_X_OFFSET, this._originY + HEADER_H, CHAT_W, BODY_H)));
        grid.applyStyle({ fill: GRID_BG, borderWidth: 0, clipMode: "hidden" });
        this._viewRoot.addMorph(grid);
        this._gridBox = grid;
      },

      // Grid while the window is open and expanded, circles otherwise. Cheap when
      // nothing changed, so every roster refresh just calls it.
      _syncVideoMode: function () {
        if (!this._hasVideoCircles()) return; // text and audio-only rooms: roster only, no pictures
        if (this._viewRoot && this._gridBox && !this._windowCollapsed) {
          this._clearCircles();
          this._layoutCenter();
          this._renderVideoGrid();
        } else {
          this._clearGrid();
          this._renderVideoCircles();
        }
      },

      // Sizes the center column for the current toggle state: full-width grid with
      // chat hidden, or the speaker area on the left of a compact chat panel.
      _layoutCenter: function () {
        var gridMode = this._centerMode === "grid";
        var areaW = gridMode ? CHAT_W : VIDEO_AREA_W;
        this._chatBox.setVisible(!gridMode);
        if (!gridMode) {
          this._layoutChat(CHAT_COMPACT_W);
          this._chatBox.setPosition(lively.pt(
            this._originX + CHAT_X_OFFSET + CHAT_W - CHAT_COMPACT_W, this._originY + HEADER_H));
        }
        var ext = this._gridBox.getExtent();
        if (ext.x !== areaW) this._gridBox.setExtent(lively.pt(areaW, BODY_H));
        this._placeChatToggle(areaW);
      },

      // Round chat-bubble button at the video area's top-right. Same icon-button
      // recipe as the header's settings gear; acts on mouse-up.
      _placeChatToggle: function (areaW) {
        var self = this;
        var x = this._originX + CHAT_X_OFFSET + areaW - CHAT_TOGGLE - GRID_PAD;
        var y = this._originY + HEADER_H + GRID_PAD;
        if (this._chatToggleBtn) {
          this._styleChatToggle(false);
          if (this._chatToggleAreaW === areaW) return;
          // setPosition on the already-rendered button left its DOM node at the old
          // spot (model and render disagreed), so a moved button is rebuilt instead.
          try { this._chatToggleBtn.remove(); } catch (e) {}
          this._chatToggleBtn = null;
        }
        this._chatToggleAreaW = areaW;
        var GLYPH_PX = 20;
        var btn = new lively.morphic.Text(lively.rect(x, y, CHAT_TOGGLE, CHAT_TOGGLE));
        btn.textString = "chat_bubble";
        btn.applyStyle({
          fontFamily: "'Material Symbols Rounded'", fontSize: GLYPH_PX * 0.75, textColor: TEXT_PRIMARY,
          fill: Color.rgba(255, 255, 255, 0.12), borderRadius: CHAT_TOGGLE / 2, borderWidth: 0,
          align: "center", padding: lively.Rectangle.inset(0, Math.round((CHAT_TOGGLE - GLYPH_PX) / 2), 0, 0),
          allowInput: false, selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre", handStyle: "pointer",
        });
        noDrag(btn);
        btn.toolTip = "Show or hide chat";
        btn.onMouseOver = function () { self._styleChatToggle(true); };
        btn.onMouseOut = function () { self._styleChatToggle(false); };
        btn.onMouseUp = function (evt) {
          self._centerMode = self._centerMode === "grid" ? "chat" : "grid";
          self._syncVideoMode();
          evt.stop();
          return true;
        };
        this._viewRoot.addMorph(btn);
        this._chatToggleBtn = btn;
        this._styleChatToggle(false);
      },

      // Model call plus a direct DOM write: applyStyle on an already-rendered morph
      // can update the model without reaching the DOM (see CLAUDE.md).
      _styleChatToggle: function (hover) {
        var btn = this._chatToggleBtn;
        if (!btn) return;
        var on = this._centerMode === "chat";
        var a = hover ? (on ? 0.4 : 0.22) : (on ? 0.3 : 0.12);
        var color = Color.rgba(255, 255, 255, a);
        try { btn.applyStyle({ fill: color }); } catch (e) {}
        try { btn.renderContext().shapeNode.style.background = color.toString(); } catch (e) {}
      },

      _clearGrid: function () {
        var tiles = this._videoTiles;
        Object.keys(tiles).forEach(function (did) { try { tiles[did].remove(); } catch (e) {} });
        this._videoTiles = {};
      },

      // Removes every circle, first remembering where each one was dragged to.
      _clearCircles: function () {
        var self = this;
        var circles = this._videoCircles;
        Object.keys(circles).forEach(function (did) {
          var c = circles[did];
          try { var wp = c.worldPoint(lively.pt(0, 0)); self._circleSpots[did] = { x: wp.x, y: wp.y }; } catch (e) {}
          try { c.remove(); } catch (e) {}
        });
        this._videoCircles = {};
      },

      // Every picture currently showing this participant: their grid tile and/or
      // their floating circle.
      _videoSurfaces: function (did) {
        var out = [];
        if (this._videoTiles[did]) out.push(this._videoTiles[did]);
        if (this._videoCircles[did]) out.push(this._videoCircles[did]);
        return out;
      },

      // Pill = a plain fill+radius Box holding a one-line Text positioned to center in
      // it (position baked into the constructor rect). Width hugs the text: measured via
      // canvas (see measureNameTag), plus padding. Height is fixed, with the text's y
      // taken from a live gap measurement — the Text's own vertical alignment can't
      // center a single line in a taller box. fontSize is in pt (8.25pt = 11px). The
      // Text spans the whole pill, so its own 4px side padding still leaves the
      // measured text width plus 12px to spare. place(pillW) -> {x, y} in host coords.
      _buildNameTag: function (host, p, myDid, place) {
        var tagText = p.did === myDid ? "you" : nameTagText(p.handle);
        var pillW = measureNameTag(tagText) + 2 * NAME_TAG_PAD_X;
        var at = place(pillW);
        var pill = noDrag(new lively.morphic.Box(lively.rect(at.x, at.y, pillW, NAME_TAG_H)));
        pill.applyStyle({ fill: nameTagFill(p.did), borderWidth: 0, borderRadius: NAME_TAG_H / 2, clipMode: "hidden" });
        pill.eventsAreIgnored = true;    // a grab on the tag still drags the whole circle
        var label = new lively.morphic.Text(
          lively.rect(0, NAME_TAG_TEXT_Y, pillW, NAME_TAG_H - NAME_TAG_TEXT_Y), tagText);
        label.applyStyle({
          fontSize: 8.25, fontWeight: "700", textColor: NAME_TAG_TEXT, fill: null,
          borderWidth: 0, borderColor: null, align: "center", fixedWidth: true, fixedHeight: true,
          clipMode: "hidden", allowInput: false, selectable: false, whiteSpaceHandling: "pre",
        });
        noDrag(label);
        label.eventsAreIgnored = true;
        pill.addMorph(label);
        host.addMorph(pill);
      },

      // Grid mode: one rectangular tile per participant (only the active speaker in
      // chat mode). A tile whose slot moved or resized is rebuilt; the others just get
      // their remote-stream catch-up, so a roster refresh doesn't restart any video.
      _renderVideoGrid: function () {
        if (!this._gridBox) return;
        var self = this;
        var user = lively.identity.did.currentUser();
        var myDid = user ? user.did : null;
        var chatMode = this._centerMode === "chat";
        var list = this._participants;
        if (chatMode) {
          var sp = this._resolveSpeaker();
          list = list.filter(function (p) { return p.did === sp; });
        }
        var ext = this._gridBox.getExtent();
        var rects = {};
        var n = list.length;
        if (n) {
          var cols = chatMode ? 1 : Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
          var cw = (ext.x - 2 * GRID_PAD - (cols - 1) * GRID_GAP) / cols;
          var ch = (ext.y - 2 * GRID_PAD - (rows - 1) * GRID_GAP) / rows;
          var ar = chatMode ? 4 / 3 : 16 / 9;
          var tw = Math.round(Math.min(cw, ch * ar)), th = Math.round(Math.min(ch, tw / ar));
          var ox = Math.round((ext.x - (cols * tw + (cols - 1) * GRID_GAP)) / 2);
          var oy = Math.round((ext.y - (rows * th + (rows - 1) * GRID_GAP)) / 2);
          list.forEach(function (p, i) {
            rects[p.did] = {
              x: ox + (i % cols) * (tw + GRID_GAP), y: oy + Math.floor(i / cols) * (th + GRID_GAP),
              w: tw, h: th, p: p,
            };
          });
        }

        Object.keys(this._videoTiles).forEach(function (did) {
          var t = self._videoTiles[did], r = rects[did], b = t._slot;
          if (!r || b.x !== r.x || b.y !== r.y || b.w !== r.w || b.h !== r.h) {
            try { t.remove(); } catch (e) {}
            delete self._videoTiles[did];
          }
        });

        Object.keys(rects).forEach(function (did) {
          var r = rects[did], p = r.p;
          var existing = self._videoTiles[did];
          if (existing) {
            if (did !== myDid && self._remoteStreams[did]) self._attachRemoteStream(existing, self._remoteStreams[did]);
            return;
          }
          var tile = noDrag(new lively.morphic.Box(lively.rect(r.x, r.y, r.w, r.h)));
          // A rectangle-with-radius tile clips its own video; the pastel fill shows
          // (with a centered identicon) until a picture arrives.
          tile.applyStyle({ fill: nameTagFill(did), borderWidth: 0, borderRadius: TILE_RADIUS, clipMode: "hidden" });
          tile._isTile = true;
          tile._avatarKey = p.handle || p.did;
          tile._slot = { x: r.x, y: r.y, w: r.w, h: r.h };
          self._gridBox.addMorph(tile);
          self._videoTiles[did] = tile;

          var showAvatar = true;
          if (did === myDid) showAvatar = !self._fillWithLocalStream(tile);
          else if (self._remoteStreams[did]) { self._attachRemoteStream(tile, self._remoteStreams[did]); showAvatar = false; }
          if (showAvatar) self._showAvatarPlaceholder(tile, p.handle || p.did);
          self._buildNameTag(tile, p, myDid, function () { return { x: 10, y: r.h - NAME_TAG_H - 10 }; });
        });
        this._updateSpeakingHighlight();
      },

      // Circle mode: floating draggable discs on the world, at the participant's
      // remembered spot or the first free slot of a default row bottom-left.
      _renderVideoCircles: function () {
        if (!this._hasVideoCircles()) return; // text and audio-only rooms: roster only, no circles
        var self = this;
        var user = lively.identity.did.currentUser();
        var myDid = user ? user.did : null;
        var stillPresent = {};

        var vb = $world.visibleBounds();
        var x = vb.x + 24, y = vb.y + vb.height - VIDEO_CIRCLE - NAME_TAG_H - NAME_TAG_GAP - 24;
        this._participants.forEach(function (p) {
          stillPresent[p.did] = true;
          var existingCircle = self._videoCircles[p.did];
          if (existingCircle) {
            // Already showing — leave its dragged position alone, but still
            // worth re-checking for a remote stream that arrived since this
            // circle was created: ontrack (webrtc category) fires whenever
            // ICE/DTLS negotiation happens to finish, which is NOT
            // guaranteed to be before presence/roster created this circle
            // (confirmed live: the more common ordering is actually the
            // other way around — presence resolves faster than a full
            // WebRTC handshake) — ontrack's own direct attach only covers
            // the case where the circle already existed at that moment, so
            // this is the other half of that same catch-up logic. Idempotent
            // no-op if already attached to this exact stream (see
            // _attachRemoteStream's own early-return guard).
            if (p.did !== myDid && self._remoteStreams[p.did]) {
              self._attachRemoteStream(existingCircle, self._remoteStreams[p.did]);
            }
            return;
          }

          var pos;
          var spot = self._circleSpots[p.did];
          if (spot) {
            pos = lively.pt(spot.x, spot.y);
          } else {
            // First slot not already holding a circle — NOT the roster index: the roster
            // order can differ between refreshes (someone joins earlier in the list than
            // an existing circle), which put two circles on the same spot.
            var taken = {};
            Object.keys(self._videoCircles).forEach(function (d) {
              var c = self._videoCircles[d];
              if (c.getPosition().y === y) taken[Math.round((c.getPosition().x - x) / (VIDEO_CIRCLE + 16))] = true;
            });
            var slot = 0;
            while (taken[slot]) slot++;
            pos = lively.pt(x + slot * (VIDEO_CIRCLE + 16), y);
          }
          var circle = new lively.morphic.Box(lively.rect(pos.x, pos.y, VIDEO_CIRCLE, VIDEO_CIRCLE));
          circle.applyStyle({
            fill: Color.rgb(30, 31, 34), borderWidth: 3, borderColor: ACCENT,
            // "visible", not "hidden": the name tag hangs below the disc, outside
            // the circle's own bounds. The video/avatar inside round themselves.
            borderRadius: VIDEO_CIRCLE / 2, clipMode: "visible",
          });
          // Draggable by design (loom-style circles) — only dropping is
          // disabled, so nothing else in this UI can get dropped into one.
          circle.draggingEnabled = true;
          circle.droppingEnabled = false;
          $world.addMorph(circle);
          // draggingEnabled alone isn't enough here: every morph is "locked" by default
          // (EventExperiments.js), and a locked morph's onDragStart returns without
          // grabbing anything. unlock() is the framework's switch that makes it
          // actually pick up under the pointer.
          circle.unlock();
          self._videoCircles[p.did] = circle;
          circle._avatarKey = p.handle || p.did;

          if (p.did === myDid) {
            // No camera stream yet (or none at all): show the identicon, not a blank disc.
            if (!self._fillWithLocalStream(circle)) self._showAvatarPlaceholder(circle, circle._avatarKey);
          } else {
            self._showAvatarPlaceholder(circle, p.handle || p.did);
            // A peer connection to this did may already have produced a
            // remote stream before this roster refresh got around to
            // creating their circle (e.g. signaling raced presence) —
            // attach it immediately instead of waiting for another ontrack.
            if (self._remoteStreams[p.did]) self._attachRemoteStream(circle, self._remoteStreams[p.did]);
          }

          // Centered under the disc.
          self._buildNameTag(circle, p, myDid, function (pillW) {
            return { x: Math.round((VIDEO_CIRCLE - pillW) / 2), y: VIDEO_CIRCLE + NAME_TAG_GAP };
          });
        });

        // Anyone no longer present loses their circle.
        Object.keys(this._videoCircles).forEach(function (did) {
          if (!stillPresent[did]) {
            self._videoCircles[did].remove();
            delete self._videoCircles[did];
          }
        });
        this._updateSpeakingHighlight();
      },

      // ── active speaker ──
      // One AnalyserNode per participant audio stream, polled every SPEAKER_POLL_MS.
      // _speakingDid is who is loud right now (drives the tile highlight);
      // _activeSpeakerDid is who the chat-mode tile shows, and only changes after the
      // current one has been quiet for SPEAKER_HOLD_MS so it doesn't flicker.

      _startSpeakerDetection: function () {
        if (this._speakerTimer) return;
        var self = this;
        this._speakerTimer = setInterval(function () { self._pollSpeakers(); }, SPEAKER_POLL_MS);
      },

      _stopSpeakerDetection: function () {
        if (this._speakerTimer) { clearInterval(this._speakerTimer); this._speakerTimer = null; }
        var self = this;
        Object.keys(this._analysers).forEach(function (did) { try { self._analysers[did].source.disconnect(); } catch (e) {} });
        this._analysers = {};
        if (this._audioCtx) { try { this._audioCtx.close(); } catch (e) {} this._audioCtx = null; }
      },

      // RMS level (0..1) of the stream's first audio track. Uses the stream object
      // itself (for remote voices, the same one the session's <audio> sink plays):
      // Chrome only feeds a remote stream to Web Audio once a media element has it.
      _levelOf: function (did, stream) {
        var track = stream && stream.getAudioTracks()[0];
        if (!track || track.readyState !== "live") return 0;
        var a = this._analysers[did];
        if (!a || a.trackId !== track.id) {
          if (a) { try { a.source.disconnect(); } catch (e) {} }
          if (!this._audioCtx) {
            var AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return 0;
            this._audioCtx = new AC();
          }
          if (this._audioCtx.state === "suspended") this._audioCtx.resume().catch(function () {});
          var source = this._audioCtx.createMediaStreamSource(stream);
          var node = this._audioCtx.createAnalyser();
          node.fftSize = 512;
          source.connect(node); // deliberately not connected onward: analysis only, never played
          a = this._analysers[did] = { trackId: track.id, source: source, node: node, buf: new Uint8Array(node.fftSize) };
        }
        a.node.getByteTimeDomainData(a.buf);
        var sum = 0;
        for (var i = 0; i < a.buf.length; i++) { var v = (a.buf[i] - 128) / 128; sum += v * v; }
        return Math.sqrt(sum / a.buf.length);
      },

      _pollSpeakers: function () {
        if (this._roomLeft) return;
        var self = this;
        var user = lively.identity.did.currentUser();
        var myDid = user ? user.did : null;
        var present = {};
        var loudDid = null, loudL = 0;
        this._participants.forEach(function (p) {
          present[p.did] = true;
          var stream = p.did === myDid
            ? lively.identity.AmbientPresencePanel.getLocalStream() : self._remoteStreams[p.did];
          var l = self._levelOf(p.did, stream);
          if (l > loudL) { loudL = l; loudDid = p.did; }
        });
        Object.keys(this._analysers).forEach(function (did) {
          if (present[did]) return;
          try { self._analysers[did].source.disconnect(); } catch (e) {}
          delete self._analysers[did];
        });

        var now = Date.now();
        var speaking = loudL > SPEAKER_THRESHOLD ? loudDid : null;
        var speakingChanged = speaking !== this._speakingDid;
        this._speakingDid = speaking;
        var cur = this._activeSpeakerDid;
        if (speaking) {
          if (speaking === cur) {
            this._speakerLastLoud = now;
          } else if (!cur || now - this._speakerLastLoud > SPEAKER_HOLD_MS) {
            this._activeSpeakerDid = speaking;
            this._speakerLastLoud = now;
            if (this._centerMode === "chat" && this._gridBox && !this._windowCollapsed) this._renderVideoGrid();
          }
        }
        if (speakingChanged) this._updateSpeakingHighlight();
      },

      // Who the chat-mode tile shows: the held active speaker if still present, else
      // the first other participant (or yourself when alone).
      _resolveSpeaker: function () {
        var dids = this._participants.map(function (p) { return p.did; });
        var cur = this._activeSpeakerDid;
        if (cur && dids.indexOf(cur) >= 0) return cur;
        var user = lively.identity.did.currentUser();
        var myDid = user ? user.did : null;
        var other = dids.filter(function (d) { return d !== myDid; })[0];
        this._activeSpeakerDid = other || dids[0] || null;
        return this._activeSpeakerDid;
      },

      // Green ring on the tile or circle of whoever is speaking. Written to the DOM
      // directly (outline sits outside the morph, so its own clip doesn't cut it, and
      // it follows a circle's rounded corners).
      _updateSpeakingHighlight: function () {
        var self = this;
        [this._videoTiles, this._videoCircles].forEach(function (surfaces) {
          Object.keys(surfaces).forEach(function (did) {
            try {
              var st = surfaces[did].renderContext().shapeNode.style;
              st.outline = did === self._speakingDid ? "3px solid rgb(87, 242, 135)" : "";
            } catch (e) {}
          });
        });
      },

      // Renders the real local camera stream (from AmbientPresencePanel,
      // which owns the actual getUserMedia acquisition) into a plain <video>
      // element nested directly in this circle morph's own shapeNode — safe
      // here per CLAUDE.md's native-DOM-in-a-morph section, since this is the
      // morph's own always-visible content, not a dialog overlay.
      // Returns true once the circle actually got a live stream attached
      // (false if the stream isn't ready yet — camera off, permission still
      // pending, or denied — so the caller knows whether to keep polling).
      _fillWithLocalStream: function (circle) {
        var stream = lively.identity.AmbientPresencePanel.getLocalViewStream();
        if (!stream) return false;
        var videoEl = document.createElement("video");
        videoEl.autoplay = true;
        videoEl.playsInline = true;
        videoEl.muted = true; // never hear yourself
        videoEl.style.cssText = "width:100%;height:100%;object-fit:cover;transform:scaleX(-1);border-radius:" +
          (circle._isTile ? TILE_RADIUS + "px" : "50%") + ";";
        videoEl.srcObject = stream;
        circle.renderContext().shapeNode.appendChild(videoEl);
        circle._hasLocalVideo = true;
        this._watchVideo(circle, videoEl, stream);
        return true;
      },

      // Keeps the picture honest: the <video> is only shown while it is really
      // producing frames (track live and unmuted, element playing); otherwise it is
      // hidden and the identicon placeholder shows instead. Without this a stream
      // that never delivers video (camera busy, remote sender without a camera)
      // left a blank colored tile. Polled, because tracks are added to and swapped
      // out of a stream without any event on the stream itself. Stops on its own once
      // the element leaves the DOM.
      _watchVideo: function (surface, videoEl, stream) {
        var self = this;
        var iv = null;
        function check() {
          if (!videoEl.isConnected) { if (iv) clearInterval(iv); return; }
          // The self-view's source is re-pointed when effects toggle, so read what it plays now.
          var vt = (videoEl.srcObject || stream).getVideoTracks()[0];
          var live = !!vt && vt.readyState === "live" && !vt.muted &&
            videoEl.readyState >= 2 && videoEl.videoWidth > 0 && !videoEl.paused;
          videoEl.style.visibility = live ? "visible" : "hidden";
          if (live) {
            if (surface._avatarMorph) {
              var node = null;
              try { node = surface._avatarMorph.renderContext().shapeNode; } catch (e) {}
              try { surface._avatarMorph.remove(); } catch (e) {}
              if (node && node.parentNode) node.parentNode.removeChild(node); // it was moved out of its wrapper
              surface._avatarMorph = null;
            }
          } else if (!surface._avatarMorph && surface._avatarKey) {
            self._showAvatarPlaceholder(surface, surface._avatarKey);
          }
        }
        iv = setInterval(check, 500);
        check();
      },

      // Static identicon placeholder for a non-self circle — used both at
      // initial creation and when reverting a circle that had a real remote
      // stream after that peer connection drops (_teardownPeerConnection,
      // webrtc category). insertBefore (not addMorph's default append)
      // keeps the circle's own name label on top regardless of when this
      // runs, same reasoning as _attachRemoteStream's insertBefore below.
      _showAvatarPlaceholder: function (circle, handleOrDid) {
        if (circle._avatarMorph) return;
        // A circle's identicon fills it; a tile's is a smaller disc centered in it.
        var size = VIDEO_CIRCLE, ax = 0, ay = 0;
        if (circle._isTile) {
          var ext = circle.getExtent();
          size = Math.max(48, Math.min(120, Math.round(Math.min(ext.x, ext.y) * 0.4)));
          ax = Math.round((ext.x - size) / 2);
          ay = Math.round((ext.y - size) / 2);
        }
        var av = new lively.morphic.Image(lively.rect(ax, ay, size, size));
        av.applyStyle({ borderWidth: 0, borderRadius: size / 2 });
        av.setImageURL(lively.identity.postCardUtils.identiconDataUrl(handleOrDid, size));
        // eventsAreIgnored (not just noDrag) — a mousedown here must bubble
        // up to the circle itself so the whole circle drags as one piece,
        // rather than this avatar image capturing the drag.
        av.eventsAreIgnored = true;
        circle.addMorph(av);
        circle._avatarMorph = av;
        var shapeNode = circle.renderContext().shapeNode;
        // The circle no longer clips (its name tag hangs outside it), so the identicon
        // has to round itself: the model-level borderRadius doesn't reach the <img>.
        var avNode = av.renderContext().shapeNode;
        avNode.style.borderRadius = "50%";
        avNode.style.overflow = "hidden";
        var avImg = avNode.querySelector("img");
        if (avImg) avImg.style.borderRadius = "50%";
        shapeNode.insertBefore(avNode, shapeNode.firstChild);
        // Moving the node out of its origin wrapper drops the wrapper's positioning,
        // so a tile's centered offset has to be written onto the node itself.
        avNode.style.left = ax + "px";
        avNode.style.top = ay + "px";
      },

      // Attaches a remote participant's real MediaStream (from the webrtc
      // category's ontrack handler) into their circle, replacing the static
      // identicon placeholder. Same plain-<video>-in-a-morph's-own-shapeNode
      // idiom as _fillWithLocalStream — not muted (we want to hear them),
      // no mirror transform (that's only correct for your own reflected
      // self-view). Idempotent no-op if this exact stream is already
      // attached (ontrack can fire more than once for the same stream on
      // renegotiation).
      _attachRemoteStream: function (circle, stream) {
        if (circle._remoteStream === stream) return;
        circle._remoteStream = stream;
        var shapeNode = circle.renderContext().shapeNode;
        // The identicon stays until _watchVideo sees real frames, and is removed at
        // the DOM level there (removing only the morph left a stray <img> behind).
        var existingVideo = shapeNode.querySelector("video");
        if (existingVideo) existingVideo.remove();
        var videoEl = document.createElement("video");
        videoEl.autoplay = true;
        videoEl.playsInline = true;
        // Picture only: the sound is played by the session-owned <audio> sink
        // (_playRemoteAudio) so it keeps going while this window is closed or
        // collapsed — leaving this unmuted would double every voice.
        videoEl.muted = true;
        videoEl.style.cssText = "width:100%;height:100%;object-fit:cover;border-radius:" +
          (circle._isTile ? TILE_RADIUS + "px" : "50%") + ";";
        videoEl.srcObject = stream;
        // insertBefore (not appendChild) — this can run well after the
        // circle's label submorph DOM node already exists (a late-arriving
        // ontrack, not the initial render), and the label must stay on top
        // of the video rather than getting covered by it.
        shapeNode.insertBefore(videoEl, shapeNode.firstChild);
        this._watchVideo(circle, videoEl, stream);
      },

    },

    // ─── webrtc — real peer mesh call ──────────────────────────────────────────
    // Every participant opens a direct RTCPeerConnection to every other
    // participant (mesh, not an SFU — see RoomSignalingServer.js's own
    // header for why that's an acceptable tradeoff at this app's room
    // sizes). Signaling (offer/answer/ICE) is relayed over a WebSocket to
    // RoomSignalingServer.js, grouped server-side by roomId and gated by a
    // short-lived one-time token (see _connectSignaling) — the server never
    // inspects the SDP/ICE payloads it relays.
    //
    // Exactly one side of each pair initiates the offer: whichever peer has
    // the lexicographically smaller server-assigned signaling peerId (see
    // _maybeInitiateTo) — a deterministic rule both sides apply
    // independently, so there's never a glare/collision to resolve (unlike
    // WarpDrop.js's file-transfer peers, where either side can spontaneously
    // start a NEW transfer at any time; here every pairing is decided once,
    // right when the two peers become mutually visible).
    //
    // The signaling WebSocket itself reconnects automatically if it drops
    // (see _onSignalingClosed) and re-establishes peer connections with
    // whoever's still in the room. What's NOT handled: an individual
    // peer's RTCPeerConnection failing ICE while the signaling connection
    // to everyone else stays healthy — that one connection just tears down
    // and reverts to the static identicon placeholder until a fresh
    // negotiation happens to get triggered some other way (e.g. that peer
    // leaving and rejoining).

    "webrtc", {

      _connectSignaling: function () {
        var self = this;
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("POST", base + "/c/" + encodeURIComponent(this._name) + "/rooms/" + this._roomId + "/signaling-token", true);
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status !== 200) {
            var info;
            try { info = JSON.parse(xhr.responseText); } catch (e) {}
            if (xhr.status === 403 && info && info.callFull) {
              // Soft per-room call cap (e2eeclusters.md §10.6) -- no
              // automatic retry here: _connectSignaling is only called
              // again later by _onSignalingClosed/join-rejected, neither of
              // which fires for a token mint that never succeeded, so this
              // won't loop. A real retry happens naturally the next time
              // the user reopens/rejoins the room.
              console.warn("[RoomView] Room is full for calls (cap " + info.cap +
                ", " + info.participantCount + " already in the call)");
              if (!self._callFullAlertShown) {
                self._callFullAlertShown = true;
                $world.alert("This room is full for calls right now (max " +
                  info.cap + " participants). You can still use text chat.");
              }
              return;
            }
            console.warn("[RoomView] Could not get signaling token (" + xhr.status + ")");
            return;
          }
          var data;
          try { data = JSON.parse(xhr.responseText); } catch (e) { return; }
          self._openSignalingSocket(data.token, data.wsPath);
        };
        xhr.onerror = function () { console.warn("[RoomView] Network error requesting signaling token"); };
        xhr.send();
      },

      _openSignalingSocket: function (token, wsPath) {
        var self = this;
        this._signalingIntentionallyClosed = false;
        this._pendingSignalingToken = token;
        var url = URL.nodejsBase.withFilename(wsPath).toString();
        var ws = new lively.net.WebSocket(url, { protocol: "lively-json" });
        this._signalingWs = ws;
        lively.bindings.connect(ws, "opened", self, "_onSignalingOpened");
        lively.bindings.connect(ws, "closed", self, "_onSignalingClosed");
        lively.bindings.connect(ws, "lively-message", self, "_onSignalingMessage");
        ws.connect();
      },

      _onSignalingOpened: function () {
        if (!this._signalingWs || !this._pendingSignalingToken) return;
        this._signalingWs.send({ action: "join", data: { token: this._pendingSignalingToken } });
        this._pendingSignalingToken = null;
      },

      // Confirmed live (chrome-devtools-mcp, a real two-account test call)
      // that this connection can drop on its own — dev-machine networking
      // with several simultaneous interfaces (WSL/VPN/host-only adapters,
      // visible as multiple ICE candidates in the same session) is the
      // likely cause, not anything specific to this code — and with no
      // reconnect handler at all, a drop here silently and permanently cut
      // off all of this room's peer video/audio for the rest of the page's
      // life. Same unconditional-retry idiom as WarpDrop.js's own
      // onWsClosed: every existing RTCPeerConnection is torn down (their
      // peerIds are gone the moment the signaling connection that assigned
      // them drops — nothing to salvage) and a full fresh
      // token+socket+rejoin cycle starts, which naturally re-establishes
      // peer connections with whoever's still in the room via the normal
      // 'joined'/peer-joined flow.
      _onSignalingClosed: function () {
        if (this._signalingIntentionallyClosed) return;
        var self = this;
        Object.keys(this._signalingPeers).forEach(function (peerId) { self._teardownPeerConnection(peerId); });
        this._signalingWs = null;
        this._mySignalingPeerId = null;
        setTimeout(function () {
          if (self._signalingIntentionallyClosed) return;
          self._connectSignaling();
        }, 1500);
      },

      _onSignalingMessage: function (msg) {
        switch (msg.action) {
          case "joined":      this._onSignalingJoined(msg.data); break;
          case "peer-joined": this._onSignalingPeerJoined(msg.data); break;
          case "peer-left":   this._onSignalingPeerLeft(msg.data); break;
          case "signal":      this._onSignalingSignal(msg.data); break;
          case "join-rejected":
            // Token expired/invalid (e.g. this socket sat mid-handshake too
            // long) — mint a fresh one and reconnect from scratch. That's
            // the routine, self-correcting case this retry was originally
            // written for. But registry.join can also fail server-side for
            // a persistent reason (e.g. the Redis-backed peer registry
            // being unreachable — confirmed live during the 2026-08-31
            // Redis-outage test in DeployCheckList.md: registry.join's
            // promise chain rejects, RoomSignalingServer.js sends
            // join-rejected just like a bad token would, and this handler
            // can't tell the two apart from the message alone). Retrying
            // every 1s forever with only a console.warn is fine for one or
            // two stale-token retries but turns into silent, indefinite,
            // server-hammering retries with zero visible indication that
            // video/voice signaling isn't working at all during a real
            // outage. Back off and escalate to a louder log after a few
            // consecutive failures; still keeps retrying (rather than
            // giving up) so it self-heals for free once the backend
            // recovers.
            this._signalingRejectStreak++;
            var retryDelay = this._signalingRejectStreak > 3 ? 5000 : 1000;
            if (this._signalingRejectStreak === 4) {
              console.error("[RoomView] Signaling join rejected " + this._signalingRejectStreak +
                " times in a row -- this looks like a persistent backend issue, not a stale " +
                "token. Video/voice signaling is unavailable; retrying every " + retryDelay + "ms.");
            } else {
              console.warn("[RoomView] Signaling token rejected — retrying");
            }
            // Mark this close as intentional BEFORE calling .close() --
            // otherwise .close() also fires _onSignalingClosed (the socket
            // genuinely does close), which has its own separate, unlogged,
            // fixed-1500ms-forever retry loop with no notion of this
            // streak/backoff at all. Without this, every single rejection
            // was scheduling TWO independent, uncoordinated reconnects
            // (this handler's backed-off one AND _onSignalingClosed's
            // uncontrolled one racing each other) -- confirmed live during
            // the 2026-08-31 Redis-outage test: far more signaling-token
            // mints were observed hitting the server than console.warn
            // calls logged, which only made sense once this second,
            // silent retry source was found. _openSignalingSocket (called
            // from the retry below) resets this back to false for the new
            // attempt, so nothing else needs to reset it here.
            this._signalingIntentionallyClosed = true;
            try { this._signalingWs.close(); } catch (e) {}
            this._signalingWs = null;
            var self = this;
            setTimeout(function () { self._connectSignaling(); }, retryDelay);
            break;
        }
      },

      _onSignalingJoined: function (data) {
        if (this._signalingRejectStreak > 3) {
          console.log("[RoomView] Signaling join recovered after " + this._signalingRejectStreak + " consecutive rejections.");
        }
        this._signalingRejectStreak = 0;
        this._mySignalingPeerId = data.peerId;
        var self = this;
        (data.peers || []).forEach(function (p) {
          // Blocking disables calls both ways: never register a blocked
          // peer's did/handle into the roster or offer to them. See
          // _onSignalingSignal for the other half (never accept an offer
          // FROM them either).
          if (lively.identity.did.isBlocked(p.did, p.handle)) { self._blockedPeerIds[p.peerId] = true; return; }
          self._peerMeta[p.peerId] = { did: p.did, handle: p.handle };
          self._didToPeerId[p.did] = p.peerId;
          self._maybeInitiateTo(p.peerId);
        });
      },

      _onSignalingPeerJoined: function (data) {
        if (lively.identity.did.isBlocked(data.did, data.handle)) { this._blockedPeerIds[data.peerId] = true; return; }
        this._peerMeta[data.peerId] = { did: data.did, handle: data.handle };
        this._didToPeerId[data.did] = data.peerId;
        this._scheduleRosterRefresh();
        this._maybeInitiateTo(data.peerId);
      },

      _onSignalingPeerLeft: function (data) {
        delete this._blockedPeerIds[data.peerId];
        this._teardownPeerConnection(data.peerId);
        this._scheduleRosterRefresh();
      },

      // Deterministic offerer choice — see this category's own header
      // comment. No-op if we already have a pc for this peer (a duplicate
      // peer-joined, or we're already mid-handshake).
      _maybeInitiateTo: function (peerId) {
        if (!this._mySignalingPeerId || this._signalingPeers[peerId]) return;
        if (this._mySignalingPeerId < peerId) this._createPeerConnection(peerId, true);
      },

      _createPeerConnection: function (peerId, amInitiator) {
        var self = this;
        var meta = this._peerMeta[peerId] || {};
        var pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        var peer = { peerId: peerId, pc: pc, did: meta.did, handle: meta.handle, pendingIce: [], screenTransceiver: null };
        this._signalingPeers[peerId] = peer;

        pc.onicecandidate = function (e) {
          if (e.candidate) self._sendSignalTo(peerId, { type: "ice", candidate: e.candidate });
        };
        pc.ontrack = function (e) {
          if (!peer.did) return;
          // A video track on any transceiver other than the peer's primary
          // audio/video pair is their shared screen, never their camera.
          if (e.track.kind === "video" && self._primaryTransceivers(peer).indexOf(e.transceiver) < 0) {
            self._onRemoteScreenTrack(peer, e);
            return;
          }
          // One session-owned MediaStream per remote participant, built from
          // the raw tracks — deliberately NOT e.streams[0]. The stream the
          // sender names can change under us: when their mic/camera resolves
          // after the first negotiation (a slow permission prompt), their
          // sender.setStreams() changes the msid, the receiver's tracks move
          // to a new stream object, and the one this handler first saw is
          // left EMPTY — with no further ontrack to say so (confirmed live
          // 2026-09-18, two accounts: media arrived at the peer connection —
          // thousands of packets, frames decoding — while the stored stream
          // had 0 tracks, so nothing played and the circle stayed blank on
          // that side only). The receiver's track objects survive that; a
          // stream we build from them stays valid.
          var stream = self._remoteStreams[peer.did];
          if (!(stream instanceof MediaStream)) stream = self._remoteStreams[peer.did] = new MediaStream();
          if (!stream.getTracks().some(function (t) { return t.id === e.track.id; })) stream.addTrack(e.track);
          self._playRemoteAudio(peer.did, stream);
          // Your own picture is always the local camera, never a stream from another
          // session of the same account (confirmed live: a second tab in the room put
          // that stream, paused and blank, on top of the self-view).
          var me = lively.identity.did.currentUser();
          if (me && me.did === peer.did) return;
          self._videoSurfaces(peer.did).forEach(function (s) { self._attachRemoteStream(s, stream); });
        };
        pc.oniceconnectionstatechange = function () {
          var state = pc.iceConnectionState;
          if (state === "failed" || state === "closed") self._teardownPeerConnection(peerId);
        };
        // Fires whenever THIS side's own local state changes in a way that
        // needs a new SDP round — the case that actually matters here is
        // _applyLocalTracksToPeer upgrading a transceiver's direction from
        // "recvonly" to "sendrecv" once local media becomes available
        // *after* this pc's initial offer/answer already went out without
        // it (confirmed live: this genuinely happens — local getUserMedia
        // and the signaling handshake race each other, and the handshake
        // sometimes wins). Fires for either role, not just the original
        // offerer — WebRTC renegotiation isn't tied to who offered first.
        pc.onnegotiationneeded = function () { self._onNegotiationNeeded(peerId, peer); };

        if (amInitiator) {
          // sendrecv up front regardless of whether our own local tracks
          // are ready yet (getUserMedia is async — see
          // _waitForLocalStreamThenFill) so we still receive the other
          // side's media even before ours resolves; _applyLocalTracksToPeer
          // fills in real tracks whenever they're available, now or later.
          //
          // Only the OFFERER pre-creates transceivers this way — confirmed
          // live (chrome-devtools-mcp, inspecting real getTransceivers()/SDP
          // on both sides of an actual two-account test call) that doing
          // the same on the ANSWERER side does NOT get reused by
          // setRemoteDescription(offer) the way the usual "pre-create
          // before receiving an offer" idiom assumes: it silently created
          // 4 transceivers instead of 2 (the 2 pre-created ones stayed
          // stuck at mid:null, unused; 2 new auto-created ones appeared to
          // match the offer's m-lines, defaulted to recvonly since they
          // had no track) — so the answer always negotiated recvonly on
          // both m-lines regardless of local media being ready. See
          // _onOffer below for the answerer's own (working) path instead.
          pc.addTransceiver("audio", { direction: "sendrecv" });
          pc.addTransceiver("video", { direction: "sendrecv" });
          this._applyLocalTracksToPeer(peer);
          this._addScreenToPeer(peer); // sharing already: it rides this first offer, after the primary pair

          pc.createOffer().then(function (offer) {
            return pc.setLocalDescription(offer);
          }).then(function () {
            self._sendSignalTo(peerId, { type: "offer", sdp: pc.localDescription });
          }).catch(function (e) {
            console.error("[RoomView] createOffer failed", e);
            self._teardownPeerConnection(peerId);
          });
        }
        // amInitiator===false: deliberately no addTransceiver call here —
        // _onOffer's setRemoteDescription(offer) auto-creates the matching
        // transceivers (recvonly by default, no track), and upgrades them
        // to sendrecv + attaches local tracks itself right before
        // createAnswer(), once they actually exist.

        return peer;
      },

      // Pushes whatever local audio/video tracks are currently available
      // onto one peer's already-existing transceivers via replaceTrack —
      // safe to call before OR after local media is ready (a no-op if the
      // stream isn't there yet). Matches transceivers by their receiver's
      // track kind, which (per spec) is set from the transceiver's own
      // media kind immediately at creation — whether that transceiver was
      // explicitly pre-created (the offerer's own addTransceiver call) or
      // auto-created by setRemoteDescription(offer) (the answerer's case,
      // see _onOffer) — not only after negotiation completes.
      //
      // Also upgrades .direction to "sendrecv" for any transceiver getting
      // a real track — load-bearing for the answerer's auto-created
      // transceivers, which default to "recvonly" (no track = nothing to
      // send), and would otherwise negotiate recvonly forever even once a
      // track becomes available. Harmless no-op for the offerer's own
      // transceivers, which are already "sendrecv" from creation.
      //
      // ALSO calls sender.setStreams(stream) — confirmed live (chrome-
      // devtools-mcp, wrapping RTCPeerConnection to log every real ontrack
      // event on both sides of an actual two-account call) that
      // replaceTrack() alone never associates the track with a
      // MediaStream/msid the way addTrack(track, stream) does. Without
      // this, the RECEIVING side's ontrack fires with a genuinely EMPTY
      // e.streams array every time (not flaky — 100% reproducible), so
      // self._remoteStreams[peer.did] silently got set to
      // e.streams[0]===undefined instead of a real stream, and every video
      // circle stayed on its identicon placeholder forever despite the
      // underlying RTCPeerConnection reporting "connected" with live send/
      // receive tracks. setStreams() is the API specifically added to
      // Unified Plan for this gap (replaceTrack was never meant to carry
      // stream association) — feature-detected since it's newer than
      // addTransceiver/replaceTrack themselves.
      // A software black video track, sent in place of the camera while it's
      // off. Canvas-generated, so no capture device is involved. Redrawn on a
      // timer because a canvas stream only emits frames when the canvas
      // changes, and a steady stream of them keeps the receiver's picture
      // black instead of frozen. One per session, stopped in _stopSession.
      _getBlackVideoTrack: function () {
        if (this._blackTrack && this._blackTrack.readyState === "live") return this._blackTrack;
        var cv = document.createElement("canvas");
        cv.width = 320; cv.height = 240;
        var g = cv.getContext("2d");
        function paint() { g.fillStyle = "#000"; g.fillRect(0, 0, cv.width, cv.height); }
        paint();
        this._blackTrack = cv.captureStream(10).getVideoTracks()[0];
        if (this._blackTimer) clearInterval(this._blackTimer);
        this._blackTimer = setInterval(paint, 100);
        return this._blackTrack;
      },

      // The peer connection's mic and camera transceivers: the first audio and the
      // first video one, in negotiation order, excluding our own screen transceiver.
      _primaryTransceivers: function (peer) {
        var seen = {}, out = [];
        if (!peer.pc) return out;
        peer.pc.getTransceivers().forEach(function (t) {
          if (t === peer.screenTransceiver) return;
          var kind = t.receiver && t.receiver.track && t.receiver.track.kind;
          if (!kind || seen[kind]) return;
          seen[kind] = true;
          out.push(t);
        });
        return out;
      },

      _applyLocalTracksToPeer: function (peer) {
        var self = this;
        var AP = lively.identity.AmbientPresencePanel;
        var stream = AP.getLocalStream();
        if (!stream || !peer.pc) return false;
        // Only the primary audio and video transceivers carry the mic and camera;
        // a shared screen rides its own extra transceiver and must never get the
        // camera swapped onto it (nor a remote screen's auto-created one upgraded).
        this._primaryTransceivers(peer).forEach(function (t) {
          var kind = t.receiver && t.receiver.track && t.receiver.track.kind;
          if (!kind) return;
          // Audio: the soundboard mix once it has started, else the plain mic track.
          var track = kind === "audio" ? AP.getOutgoingAudioTrack() : AP.getOutgoingVideoTrack();
          if (!track) {
            // The local track of this kind was removed (camera turned off: the
            // panel stops the video track to release the device). Video is
            // swapped for a software-generated black track rather than
            // detached: with no track at all the receiver's picture freezes on
            // the last camera frame (confirmed live), which is worse than the
            // black a merely-disabled track used to produce. Audio just
            // detaches. The transceiver stays sendrecv either way, so turning
            // the camera back on is another replaceTrack, no renegotiation.
            var replacement = kind === "video" ? self._getBlackVideoTrack() : null;
            if (t.sender.track !== replacement) t.sender.replaceTrack(replacement).catch(function () {});
            return;
          }
          if (t.direction !== "sendrecv") t.direction = "sendrecv";
          if (t.sender.track !== track) t.sender.replaceTrack(track);
          if (t.sender.setStreams) t.sender.setStreams(stream);
        });
        return true;
      },

      // Returns true once local media is available (regardless of whether
      // there were any peers yet to push it to) — the return value is only
      // used by _waitForLocalStreamThenFill to know whether to keep
      // polling, same contract as _fillWithLocalStream's own return value.
      _applyLocalTracksToAllPeers: function () {
        var stream = lively.identity.AmbientPresencePanel.getLocalStream();
        if (!stream) return false;
        var self = this;
        Object.keys(this._signalingPeers).forEach(function (peerId) {
          self._applyLocalTracksToPeer(self._signalingPeers[peerId]);
        });
        return true;
      },

      _sendSignalTo: function (peerId, signal) {
        if (!this._signalingWs) return;
        this._signalingWs.send({ action: "signal", data: { to: peerId, signal: signal } });
      },

      _onSignalingSignal: function (data) {
        var peerId = data.from;
        var signal = data.signal;
        // A blocked peer's client doesn't know it's blocked and may still
        // send an unsolicited offer — _onOffer (below) would otherwise
        // unconditionally create a real RTCPeerConnection for it regardless
        // of _peerMeta/_blockedPeerIds, since it never consults them. This
        // is the actual enforcement point for "never accept their offer
        // either"; _onSignalingPeerJoined/_onSignalingJoined above only
        // cover "never offer to them".
        if (this._blockedPeerIds[peerId]) return;
        if (signal.type === "offer") return this._onOffer(peerId, signal);
        var peer = this._signalingPeers[peerId];
        if (!peer) return; // for a peer we no longer have a pc for -- drop
        if (signal.type === "screen") return this._onScreenSignal(peer, signal);
        if (signal.type === "answer") return this._onAnswer(peer, signal);
        if (signal.type === "ice") return this._onIce(peer, signal);
      },

      // Fires either for a brand-new pairing (no peer yet) or a follow-up
      // renegotiation on an already-stable pc (see _onNegotiationNeeded) --
      // and, rarely, glare: both sides' onnegotiationneeded firing close
      // together, each already mid-way through sending their OWN offer
      // when the other's arrives. Simplified "perfect negotiation" (per
      // the WebRTC spec's own recommended pattern): the "polite" side
      // (larger signaling peerId — same tie-break _maybeInitiateTo already
      // uses, just inverted) rolls back its own in-flight offer and
      // accepts theirs; the "impolite" side ignores the incoming offer and
      // trusts its own to be answered. Both sides reach this decision
      // independently from the same deterministic rule, so it can't
      // deadlock.
      _onOffer: function (peerId, signal) {
        var self = this;
        var peer = this._signalingPeers[peerId];
        var isPolite = this._mySignalingPeerId > peerId;

        if (peer && peer.pc.signalingState === "have-local-offer") {
          if (!isPolite) return; // impolite: ignore theirs, ours will win
          peer.pc.setLocalDescription({ type: "rollback" }).then(function () {
            self._answerOffer(peerId, peer, signal);
          }).catch(function (e) { console.error("[RoomView] Glare rollback failed", e); });
          return;
        }

        if (!peer) peer = this._createPeerConnection(peerId, false);
        self._answerOffer(peerId, peer, signal);
      },

      _answerOffer: function (peerId, peer, signal) {
        var self = this;
        peer.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp)).then(function () {
          self._flushPendingIce(peer);
          // Transceivers now exist (auto-created to match the offer's
          // m-lines on a fresh pairing, or already there on a
          // renegotiation) — upgrade to sendrecv + attach local tracks
          // before answering, see _applyLocalTracksToPeer's own comment
          // for why this can't happen earlier on the answerer's side of a
          // fresh pairing.
          self._applyLocalTracksToPeer(peer);
          return peer.pc.createAnswer();
        }).then(function (answer) {
          return peer.pc.setLocalDescription(answer);
        }).then(function () {
          self._sendSignalTo(peerId, { type: "answer", sdp: peer.pc.localDescription });
          // Sharing already: the extra transceiver can only be added once the first
          // handshake is done, and renegotiates from here.
          self._addScreenToPeer(peer);
        }).catch(function (e) {
          console.error("[RoomView] Failed to answer offer", e);
          self._teardownPeerConnection(peerId);
        });
      },

      // Triggered by RTCPeerConnection's own onnegotiationneeded (see
      // _createPeerConnection) — a fresh pairing's very first
      // negotiation is driven by _maybeInitiateTo/createOffer instead, not
      // this; this fires for later renegotiations only (signalingState is
      // "stable" for those, guarded below so a negotiationneeded firing
      // mid-handshake — e.g. right after the initial createOffer — is a
      // no-op rather than an interfering second offer).
      _onNegotiationNeeded: function (peerId, peer) {
        var self = this;
        var pc = peer.pc;
        if (pc.signalingState !== "stable") return;
        pc.createOffer().then(function (offer) {
          return pc.setLocalDescription(offer);
        }).then(function () {
          self._sendSignalTo(peerId, { type: "offer", sdp: pc.localDescription });
        }).catch(function (e) {
          // Observed live once, non-fatal: Chrome's own "order of m-lines
          // in subsequent offer doesn't match order from previous offer/
          // answer" InvalidAccessError, on a renegotiation triggered close
          // together with other negotiation activity on the same pc (a
          // heavy multi-reload debugging session, not a normal single
          // fresh call). The failed attempt here is just abandoned —
          // whatever the pc's last successfully negotiated state was
          // stands — and in the one case this fired, the call still ended
          // up fully connected afterward. Not chased further since it's a
          // narrow edge case and the call itself is unaffected; if this
          // starts happening on ordinary (non-debugging) connections it'd
          // be worth a proper fix.
          console.error("[RoomView] Renegotiation offer failed", e);
        });
      },

      _onAnswer: function (peer, signal) {
        var self = this;
        peer.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp)).then(function () {
          self._flushPendingIce(peer);
        }).catch(function (e) { console.error("[RoomView] setRemoteDescription (answer) failed", e); });
      },

      _onIce: function (peer, signal) {
        if (peer.pc.remoteDescription && peer.pc.remoteDescription.type) {
          peer.pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(function (e) {
            console.warn("[RoomView] addIceCandidate failed", e);
          });
        } else {
          peer.pendingIce.push(signal.candidate);
        }
      },

      _flushPendingIce: function (peer) {
        var candidates = peer.pendingIce;
        peer.pendingIce = [];
        candidates.forEach(function (c) {
          peer.pc.addIceCandidate(new RTCIceCandidate(c)).catch(function (e) {
            console.warn("[RoomView] addIceCandidate (flush) failed", e);
          });
        });
      },

      // Closes one peer's RTCPeerConnection and, if their video circle is
      // currently showing real remote video, reverts it to the static
      // identicon placeholder — presence and signaling are independent, so
      // a dropped peer connection doesn't necessarily mean they've left the
      // room (roster-driven circle removal is handled separately by
      // _renderVideoCircles).
      _teardownPeerConnection: function (peerId) {
        var peer = this._signalingPeers[peerId];
        if (!peer) return;
        delete this._signalingPeers[peerId];
        delete this._peerMeta[peerId];

        if (peer.did) {
          this._removeScreenSurface(peer.did);
          delete this._remoteStreams[peer.did];
          this._removeRemoteAudio(peer.did);
          if (this._didToPeerId[peer.did] === peerId) delete this._didToPeerId[peer.did];
          var self = this;
          this._videoSurfaces(peer.did).forEach(function (surface) {
            if (!surface._remoteStream) return;
            var v = surface.renderContext().shapeNode.querySelector("video");
            if (v) v.remove();
            surface._remoteStream = null;
            self._showAvatarPlaceholder(surface, peer.handle || peer.did);
          });
        }

        if (peer.pc) {
          peer.pc.onicecandidate = null;
          peer.pc.ontrack = null;
          peer.pc.oniceconnectionstatechange = null;
          peer.pc.onnegotiationneeded = null;
          try { peer.pc.close(); } catch (e) {}
        }
      },

      // Session-owned playback for a remote participant's audio — a hidden
      // <audio> on document.body, deliberately outside any morph so the voices
      // keep playing when the room window is collapsed, closed or reopened.
      // Idempotent per stream (ontrack fires again on renegotiation).
      _playRemoteAudio: function (did, stream) {
        if (this._roomLeft) return;
        var el = this._remoteAudio[did];
        if (el && el.srcObject === stream) return;
        if (!el) {
          el = document.createElement("audio");
          el.autoplay = true;
          el.style.display = "none";
          document.body.appendChild(el);
          this._remoteAudio[did] = el;
        }
        el.srcObject = stream;
        this._applyDeafen(); // a voice that arrives while deafened must start muted
        var p = el.play && el.play();
        if (p && p.catch) p.catch(function () {}); // autoplay policy: the room was entered by a click, so this normally succeeds
      },

      // The panel added or removed a local track (camera toggled, or the mic
      // captured late): push it to every peer connection and re-point the
      // self-view at the (mutated) stream so it shows or clears the picture.
      _onLocalTracksChanged: function () {
        if (this._roomLeft) return;
        this._applyLocalTracksToAllPeers();
        var user = lively.identity.did.currentUser();
        var stream = lively.identity.AmbientPresencePanel.getLocalViewStream();
        if (!user || !stream) return;
        this._videoSurfaces(user.did).forEach(function (surface) {
          var v = surface.renderContext().shapeNode.querySelector("video");
          if (!v) return;
          v.srcObject = stream;
          var p = v.play && v.play();
          if (p && p.catch) p.catch(function () {});
        });
      },

      // Deafen = stop hearing everyone: mutes every session-owned remote audio
      // element to match the Ambient Presence Panel's deafened flag (the panel
      // itself already mutes your own mic when deafening). Called when a voice
      // starts playing and, via lively.identity.RoomView.applyDeafened, after
      // every panel toggle. Track/stream stay live, so undeafening is instant.
      _applyDeafen: function () {
        var panel = lively.identity.AmbientPresencePanel._panel;
        var deaf = !!(panel && panel.deafened);
        var self = this;
        Object.keys(this._remoteAudio).forEach(function (did) { self._remoteAudio[did].muted = deaf; });
      },

      _removeRemoteAudio: function (did) {
        var el = this._remoteAudio[did];
        if (!el) return;
        delete this._remoteAudio[did];
        try { el.pause(); el.srcObject = null; el.remove(); } catch (e) {}
      },

      // ── screenshare ──
      // A shared screen is a SECOND video stream next to the camera: its own
      // sendonly transceiver per peer (added with addTransceiver, so it
      // renegotiates), announced with a {type:"screen"} signal. The receiver
      // recognises it as any video track that is not on the peer's primary pair
      // (see _primaryTransceivers). Each screen shows as a floating, draggable
      // 16:9 tile in the world, in both grid and circle mode.

      isScreenSharing: function () { return !!this._screenStream; },

      startScreenShare: function () {
        var self = this;
        if (this._screenStream || this._roomLeft) return;
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
          console.warn("[RoomView] Screen sharing is not available in this browser");
          return;
        }
        navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }).then(function (stream) {
          if (self._roomLeft || self._screenStream) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
          self._screenStream = stream;
          // The browser's own "Stop sharing" control ends the track from outside.
          stream.getVideoTracks()[0].addEventListener("ended", function () {
            if (self._screenStream === stream) self.stopScreenShare();
          });
          Object.keys(self._signalingPeers).forEach(function (id) { self._addScreenToPeer(self._signalingPeers[id]); });
          var me = lively.identity.did.currentUser();
          if (me) self._showScreenSurface(me.did, stream, me.handle);
          lively.identity.AmbientPresencePanel.setScreenSharing(true);
        }).catch(function (err) {
          console.warn("[RoomView] Screen share was not started:", err && err.message);
        });
      },

      stopScreenShare: function () {
        var self = this;
        var stream = this._screenStream;
        if (!stream) return;
        this._screenStream = null;
        Object.keys(this._signalingPeers).forEach(function (id) {
          var peer = self._signalingPeers[id];
          if (peer.screenTransceiver) {
            try { peer.screenTransceiver.stop(); } catch (e) {}
            peer.screenTransceiver = null;
            self._sendSignalTo(id, { type: "screen", on: false });
          }
        });
        stream.getTracks().forEach(function (t) { t.stop(); });
        var me = lively.identity.did.currentUser();
        if (me) this._removeScreenSurface(me.did);
        lively.identity.AmbientPresencePanel.setScreenSharing(false);
      },

      // Adds our screen to one peer connection (once). No-op when not sharing.
      _addScreenToPeer: function (peer) {
        if (!this._screenStream || !peer.pc || peer.screenTransceiver) return;
        var track = this._screenStream.getVideoTracks()[0];
        if (!track) return;
        try {
          peer.screenTransceiver = peer.pc.addTransceiver(track, { direction: "sendonly", streams: [this._screenStream] });
          this._sendSignalTo(peer.peerId, { type: "screen", on: true });
        } catch (e) { console.error("[RoomView] Could not add screen to peer", e); }
      },

      _onScreenSignal: function (peer, signal) {
        if (!signal.on && peer.did) this._removeScreenSurface(peer.did);
      },

      _onRemoteScreenTrack: function (peer, e) {
        var self = this;
        var me = lively.identity.did.currentUser();
        if (me && me.did === peer.did) return; // our own account from another tab
        // Built from the raw track, like the camera stream (see ontrack).
        var stream = new MediaStream([e.track]);
        this._showScreenSurface(peer.did, stream, peer.handle);
        e.track.addEventListener("ended", function () {
          if (self._screenStreams[peer.did] === stream) self._removeScreenSurface(peer.did);
        });
      },

      _showScreenSurface: function (did, stream, handle) {
        this._removeScreenSurface(did);
        var user = lively.identity.did.currentUser();
        var myDid = user ? user.did : null;
        var W = 320, H = 180;
        var vb = $world.visibleBounds();
        var n = Object.keys(this._screenSurfaces).length;
        var box = new lively.morphic.Box(lively.rect(vb.x + 24 + n * 36, vb.y + 90 + n * 36, W, H));
        box.applyStyle({ fill: Color.black, borderWidth: 3, borderColor: ACCENT, borderRadius: 10, clipMode: "hidden" });
        box.draggingEnabled = true;
        box.droppingEnabled = false;
        $world.addMorph(box);
        box.unlock(); // see the video-circle comment: locked morphs don't pick up under the pointer
        var videoEl = document.createElement("video");
        videoEl.autoplay = true;
        videoEl.playsInline = true;
        videoEl.muted = true;
        videoEl.style.cssText = "width:100%;height:100%;object-fit:contain;background:#000;pointer-events:none;";
        videoEl.srcObject = stream;
        box.renderContext().shapeNode.appendChild(videoEl);
        var p = videoEl.play && videoEl.play();
        if (p && p.catch) p.catch(function () {});
        this._buildNameTag(box, { did: did, handle: handle }, myDid, function () {
          return { x: 10, y: H - NAME_TAG_H - 10 };
        });
        box._isScreen = true;
        this._screenSurfaces[did] = box;
        this._screenStreams[did] = stream;
      },

      _removeScreenSurface: function (did) {
        var box = this._screenSurfaces[did];
        if (box) { try { box.remove(); } catch (e) {} }
        delete this._screenSurfaces[did];
        delete this._screenStreams[did];
      },

      _teardownSignaling: function () {
        var self = this;
        this._signalingIntentionallyClosed = true; // stop _onSignalingClosed from reconnecting
        Object.keys(this._signalingPeers).forEach(function (peerId) { self._teardownPeerConnection(peerId); });
        if (this._signalingWs) {
          try { this._signalingWs.close(); } catch (e) {}
          this._signalingWs = null;
        }
      },

    });

    // World-level entry point and the one place room sessions are held. A user
    // has at most one CALL session (an audio/video room, `_active`) plus any
    // number of TEXT sessions (`_texts`) at once. There is only ever one
    // room/cluster Window per world, though (`_win`/`_viewRoot`, owned here,
    // not by any controller): entering a room you already have open just
    // brings that window forward (or rebuilds its content if it was closed);
    // entering a DIFFERENT room swaps the window's content to it instead of
    // opening a second window (`_showController`). Swapping away from a text
    // room ends its session (it has no call to keep alive in the background);
    // swapping away from a call room only detaches its view — the call keeps
    // running, same as it always has across a window close. Entering a
    // different call room leaves the current call first, waiting for its
    // presence DELETE to settle so it can't land after the next room's join.
    // Which kind a room is only becomes known once its detail loads, so that
    // decision is made in _register, not here.
    //
    // Scope: the session lives in this world's JS, so it survives everything
    // except a real page load (which still ends the call via the controller's
    // pagehide hook). Surviving a page load would need a host that outlives
    // the document (a persistent shell page or a companion window) — the
    // controller/view split is what makes that addable later.
    lively.identity.RoomView = {
      _active: null,      // the current CALL RoomViewController, or null
      _texts: {},         // "name/roomId" -> text-room RoomViewController
      _pending: {},       // "name/roomId" -> controller whose room detail is still loading
      _listeners: [],     // fn(controllerOrNull) — presence joined/left, for the lounge's headcounts

      _win: null,         // the one shared room/cluster Window morph, or null if none is open
      _viewRoot: null,    // its content-root Box (what controllers build their panels into)
      _shown: null,       // whichever controller currently owns _win/_viewRoot's content, or null

      _key: function (name, roomId) { return name + "/" + roomId; },

      _find: function (name, roomId) {
        var key = this._key(name, roomId);
        var c = this._texts[key] || this._pending[key];
        if (!c && this._active && this._active._name === name && this._active._roomId === roomId) c = this._active;
        return c && !c._roomLeft ? c : null;
      },

      open: function (name, roomId) {
        var existing = this._find(name, roomId);
        if (existing) { existing.showView(); return existing; }
        var controller = new lively.identity.RoomViewController();
        this._pending[this._key(name, roomId)] = controller;
        controller.open(name, roomId);
        return controller;
      },

      // Returns the one shared room/cluster Window, creating it if it was
      // never opened or has since been closed. Content (and the title) is
      // always the caller's job — see _showController.
      _ensureWindow: function () {
        if (this._win && this._win.owner) return this._win;
        var self = this;
        var root = new lively.morphic.Box(lively.rect(0, 0, TOTAL_W, TOTAL_H));
        root.applyStyle({ fill: BG_MAIN, borderWidth: 0, clipMode: "hidden" });
        // Window#signalShutdown calls this on close (X button) — dispatches to
        // whichever controller currently owns the content, not a fixed one.
        root.onShutdown = function () { self._onWindowClosed(); };
        // Window#collapse calls the first on its target BEFORE detaching the
        // content; Window#expand calls the second on every submorph once the
        // content is back. They switch the video between grid and circles —
        // again, for whichever controller is currently shown.
        root.onWindowCollapse = function () {
          var c = self._shown;
          if (c) { c._windowCollapsed = true; c._syncVideoMode(); }
        };
        root.onWindowExpand = function () {
          var c = self._shown;
          if (c) { c._windowCollapsed = false; c._syncVideoMode(); }
        };
        this._viewRoot = root;

        // Window first, children after: several builders measure their own
        // rendered DOM, which only exists once the morph is in the world.
        // No `pos` here: World#addFramedMorph discards it and places the
        // window at the mouse-hand position instead (confirmed live), so the
        // centering below has to happen after the fact.
        this._win = root.openInWindow({ title: "Cluster" });
        // This box clips with overflow:hidden but is still scrollable — the
        // browser scrolls it to reveal a caret or focused element (a wide
        // message box did exactly that and shifted every panel off screen,
        // with no scrollbar to undo it). Nothing in it is meant to scroll, so
        // any scroll snaps straight back.
        var rootNode = root.renderContext().shapeNode;
        rootNode.addEventListener("scroll", function () {
          if (rootNode.scrollLeft || rootNode.scrollTop) { rootNode.scrollLeft = 0; rootNode.scrollTop = 0; }
        });
        applyAccentChrome(this._win);
        _widenWindowChrome(this._win);
        // Centered on the real, final window size (frame + title bar included,
        // which is bigger than TOTAL_W x TOTAL_H) in the CURRENT viewport —
        // visibleBounds() carries the page scroll offset in its topLeft, and
        // the cached window bounds may predate a browser resize.
        $world.cachedWindowBounds = null;
        var vb = $world.visibleBounds();
        var ext = this._win.getExtent();
        this._win.setPosition(lively.pt(
          Math.round(vb.x + Math.max(0, (vb.width - ext.x) / 2)),
          Math.round(vb.y + Math.max(0, (vb.height - ext.y) / 2))));
        return this._win;
      },

      // Makes controller's content the one shown in the shared window,
      // evicting whoever was shown before it (if different).
      //
      // open()'s boot chain (restoreSession -> XHR -> _register -> _start ->
      // showView -> here) races the morphic world's own load sequence with
      // no ordering guarantee -- same bug class as the currentUser()-read
      // race open() already guards against via restoreSession(cb), just
      // surfacing at the window-creation step instead of an identity read.
      // Confirmed live: reopening a room whose detail-fetch chain resolves
      // before $world exists crashed _ensureWindow on $world.visibleBounds().
      // lively.whenLoaded queues safely pre-boot and fires immediately once
      // the world is already up (same idiom MorphAddons.js's openInWorld
      // deferral uses for the identical "might run before $world" situation).
      _showController: function (controller) {
        if (typeof $world === "undefined" || !$world) {
          var self = this;
          lively.whenLoaded(function () { self._showController(controller); });
          return;
        }
        if (this._shown && this._shown !== controller) this._shown._onViewReplaced();
        this._ensureWindow();
        controller._viewRoot = this._viewRoot;
        controller._win = this._win;
        this._shown = controller;
        controller._renderView();
      },

      // The shared window's own X button. The window removes itself right
      // after this returns (see _ensureWindow's onShutdown).
      _onWindowClosed: function () {
        if (this._shown) this._shown._onViewReplaced();
        this._win = null;
        this._viewRoot = null;
        this._shown = null;
      },

      // Called by the controller once its room detail has loaded. Text rooms
      // register alongside whatever is running; a call room first ends the
      // current call (if any), waiting for its presence DELETE to settle.
      _register: function (controller, start) {
        var self = this;
        delete this._pending[this._key(controller._name, controller._roomId)];
        if (!controller._isCall()) {
          this._texts[this._key(controller._name, controller._roomId)] = controller;
          start();
          return;
        }
        var current = this._active;
        this._active = controller;
        if (current && current !== controller && !current._roomLeft) {
          current.leave(function () { if (!controller._roomLeft) start(); });
        } else {
          start();
        }
      },

      // True while this world holds a live session (call or text) for roomId.
      isActiveRoom: function (roomId) {
        var self = this;
        if (this._active && !this._active._roomLeft && this._active._roomId === roomId) return true;
        return Object.keys(this._texts).some(function (k) {
          var c = self._texts[k];
          return !c._roomLeft && c._roomId === roomId;
        });
      },

      hasTextSession: function () {
        var self = this;
        return Object.keys(this._texts).some(function (k) { return !self._texts[k]._roomLeft; });
      },

      // Panel hook: a local track was added or removed (see
      // AmbientPresencePanel._afterLocalTracksChanged).
      localTracksChanged: function () {
        if (this._active && !this._active._roomLeft) this._active._onLocalTracksChanged();
      },

      // Panel toggle hook (AmbientPresencePanel._applyTrackState): re-applies
      // the deafened flag to the active session's audio.
      applyDeafened: function () {
        if (this._active && !this._active._roomLeft) this._active._applyDeafen();
      },

      // Panel hook: start or stop sharing the screen in the current call.
      toggleScreenShare: function () {
        var c = this.getActive();
        if (!c) return;
        if (c.isScreenSharing()) c.stopScreenShare(); else c.startScreenShare();
      },

      getActive: function () {
        return this._active && !this._active._roomLeft ? this._active : null;
      },

      addListener: function (fn) {
        if (this._listeners.indexOf(fn) < 0) this._listeners.push(fn);
      },

      _notify: function (controller) {
        this._listeners.slice().forEach(function (fn) { try { fn(controller); } catch (e) { console.error("[RoomView] listener failed", e); } });
      },

      _sessionEnded: function (controller) {
        var key = this._key(controller._name, controller._roomId);
        if (this._active === controller) this._active = null;
        if (this._texts[key] === controller) delete this._texts[key];
        if (this._pending[key] === controller) delete this._pending[key];
        // Only clears the shared window's bookkeeping if nothing else has
        // already taken it over (a swap-eviction reassigns _shown to the new
        // controller synchronously, before this — async, post-DELETE —
        // callback ever runs).
        if (this._shown === controller) { this._win = null; this._viewRoot = null; this._shown = null; }
        this._notify(null);
        // A text session coming or going flips the panel's controls between
        // inactive (text only) and their normal state.
        try { lively.identity.AmbientPresencePanel.refreshControls(); } catch (e) {}
      },
    };

  }); // end module('lively.identity.RoomView')

/**
 * Design notes for future sessions (documented, not implemented):
 *
 * The controller-facing approve/decline UI for room-join-request postcards
 * (deferred in an earlier session — PostCardView.js's
 * _renderMembershipActions only special-cases
 * state.kind==='constellation-join-request') is still unaddressed.
 *
 * Chat message length is capped at 200 chars — listMessagesForRoom reads
 * state.title (the same auto-extracted-first-block-text every postcard
 * gets), not the full payload, to keep the room's message listing as cheap
 * as any other feed listing here. Fine for a chat line; would need a real
 * payload fetch per message (or a dedicated text field) if longer messages
 * ever matter.
 *
 * No message edit/delete UI. No read receipts/typing indicators. No
 * automatic WebRTC reconnect after an ICE failure (see the "webrtc"
 * category's own header comment) — a dropped peer connection just reverts
 * that participant's circle to a static placeholder until they leave/
 * rejoin the room.
 */
