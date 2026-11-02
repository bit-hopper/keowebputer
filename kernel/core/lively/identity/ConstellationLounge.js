/**
 * lively.identity.ConstellationLounge
 *
 * The fixed-layout landing page at /c/:name (ConstellationDesignSpec.md's
 * "space", reframed as a lounge/main-feed UI). A freeform drag/place canvas
 * used to live alongside this at /c/:name/canvas (ConstellationCanvas.js);
 * it was removed (no clear product goal, extra infra/perf cost) — this is
 * now the only UI for a constellation. A visitor to /c/:name sees:
 *
 *   - a search field (top, horizontally centered across the full page width
 *     as its own row, resizing with the viewport — white rounded pill with
 *     a pink border, magnifying-glass icon, Enter-to-search, no separate
 *     "Go" button), searching this constellation's postcard titles
 *     (server-side, via GET /c/:name/feed?q=)
 *   - a quick-info panel (name, visibility, member count, created date,
 *     co-creator) beside the postcard reel, below the search row, at a
 *     fixed size (not derived from the viewport)
 *   - a postcard "turnover" reel: newest-first, one card visible at a
 *     time, turned via a Tinder-style swipe-away (translate + rotate +
 *     fade off-screen, then the new card settles in from a smaller
 *     "just-revealed" state) — prev/next buttons, and arrow keys turn it.
 *     "Next" flies off to the left (direction +1) and "previous" flies
 *     off to the right (direction -1), matching the common photo-viewer
 *     swipe convention rather than this panel's own left=older/
 *     right=newer button-and-arrow-key layout. Reply-driven activity
 *     never reorders the stack.
 *   - below the active card: a recursively nested, lazily
 *     expanded reply tree (GET /@:handle/:objId/replies is objId-generic —
 *     the :handle path segment is unused server-side, confirmed by reading
 *     IdentityServer.js, so the same route recurses to any depth). Clicking
 *     a reply focuses it into the active slot; a breadcrumb steps back out
 *     without disturbing the top-level stack position.
 *   - the wiki no longer embeds here — it's its own real Lively world at
 *     /c/:name/wiki (WikiIndex.js), reached via the "Open wiki" entry in
 *     this controller's own membership dropdown (_openMembershipMenu)
 *   - a Discord-style member list on the far right: co-creator (green
 *     badge, constellation.createdBy) — moderator (yellow badge, every
 *     other DID in constellation.controllers, per the owner's "every
 *     added controller is also a moderator" framing — no separate
 *     moderator role in the schema) — active members (live Yjs
 *     awareness/presence, this controller's own _connectPresence/
 *     _publishPresence, read/write-for-presence-only, no layout map)
 *
 * Boot: server-rendered skeleton (buildConstellationLoungePage,
 * IdentityServer.js) pre-fills the quick-info panel from data the route
 * handler already has; everything else needs extra queries this
 * controller makes once $world exists.
 *
 * Rendering convention: every visible element is a real Lively morph
 * (Box/Text/Button/Image), added to $world, not raw DOM on document.body.
 * This isn't just style — it's load-bearing. A first pass built the chrome
 * as raw `position:fixed` DOM appended to document.body, and that produced
 * two real bugs: (1) keyboard focus on a plain `<input>` was being stolen
 * every keystroke, because Events.js's world-focus failsafe
 * (`if (!world.focusedMorph()) world.focus()`, fired on a delay after any
 * blur) only recognizes *morphs* as focus-holders — a raw input outside
 * any morph's DOM subtree never registers, so the world silently reclaimed
 * focus after every character; (2) later-opened morphic windows (e.g. the
 * mailbox) rendered *underneath* the raw DOM chrome, because that chrome
 * sat outside Lively's own z-order/bringToFront management entirely. Real
 * morphs (added via addMorph) fix both by construction, and — the actual
 * reason this matters per the project owner — keep every element
 * halo-selectable and Object-Editor
 * inspectable, the way everything else in this codebase is. The postcard
 * embed slots were already lively.morphic.Box morphs; this revision
 * brings the rest of the chrome (search, quick-info, nav, reply thread,
 * member list) in line with that, and only the front card
 * slot's own CSS 3D transform (applied to its own shapeNode, the same
 * technique PostCardView.js's internal flip already uses) remains a direct
 * style manipulation — that's an animation detail on a real morph, not a
 * substitute for one.
 *
 * Open: lively.identity.ConstellationLounge.open(name) — called from
 * buildConstellationLoungePage's onStartWorld hook once $world exists.
 */

module("lively.identity.ConstellationLounge")
  .requires(
    "lively.identity.DID",
    "lively.identity.PostCardView",
    "lively.identity.WikiView",
    "lively.identity.PostCardUtils",
    "lively.identity.QuiltPatterns",
    "lively.identity.ConstellationSettingsDialog",
    "lively.identity.EditEventDialog",
    "lively.identity.ConstellationMap",
    "lively.identity.MediaPickerDialog",
    "lively.morphic.Complete",
  )
  .toRun(function () {

    // Every panel below is a fixed pixel size (not derived from
    // window.innerWidth/innerHeight) per the reference layout — sized off
    // live-inspected morph extents (postcard pt(604.7, 367.3), comment
    // section pt(580.7, 574.0), about panel pt(973.7, 306.0), rounded here),
    // not computed to fill whatever room happens to be left.
    // CARD_H is the reel card's default height; a card with tall content (a
    // photo gallery) grows it up to CARD_H_MAX — see _fitCardToContent. The
    // max leaves ~60px of a second gallery showing below a full 4-photo
    // gallery, so a 5+ photo card visibly continues below the fold.
    var CARD_W = 650, CARD_H = 395, CARD_H_MAX = 610;
    // Comment section's outer box is set to CARD_W minus its own left/right
    // CSS padding (THREAD_PAD_Y_X below) so the *rendered* box — padding is
    // real box-model padding on a content-box element, so it adds to the
    // visible width on top of whatever extent is set — ends up exactly
    // CARD_W wide, same left edge (both start at GUTTER), matching the
    // postcard above it. Confirmed live: without this adjustment the
    // rendered box measured ~23px wider than the postcard.
    var THREAD_PAD_X = 12, THREAD_PAD_Y = 10;   // must match the "10px 12px" set on the container below
    var THREAD_W = CARD_W - THREAD_PAD_X * 2;   // comment section
    // THREAD_H_MAX/MIN are *rendered* (visible, padding-included) height
    // targets — _layout derives the actual extent to set by subtracting
    // THREAD_PAD_Y*2 from whichever of these applies, same padding
    // compensation as THREAD_W above.
    var THREAD_H_MAX = 574;
    var THREAD_H_MIN = 200;    // floor so a very short viewport still gets a usable (internally-scrolling) thread box
    // QUICK_INFO_H has 60px more headroom than the about panel's own
    // content strictly needs, reserved for the event card below — a long
    // event title wrapped onto a second line needs that extra vertical
    // room to avoid the avatar row/"+N Others" label getting pushed past
    // the card's own bottom edge and clipped there (confirmed live with a
    // real 45-character title: without this, height ~131px needed but
    // only ~98px was available).
    var QUICK_INFO_W = 974, QUICK_INFO_H = 366;   // about panel
    // Bare structural safety floor for the right column's shared width
    // (used by both _quickInfoBox and _spacesBox) — NOT a "comfortable
    // minimum". It exists only to stop setExtent from ever being handed a
    // zero/negative width at a pathologically narrow window; it must never
    // be large enough to force the box wider than the real gap before the
    // members column, or the box would overlap membersX by construction
    // (confirmed live: an earlier version of this constant at 520 forced
    // ~150px of real overlap at an ordinary 1300px window width, because
    // Math.max(520, availRightW) discarded the true available width
    // instead of just guarding against a degenerate one). _renderQuickInfo
    // already has its own, much better-tuned legibility floors
    // (MIN_CARD_W=160, detailW's 100px floor) that take over gracefully as
    // this box gets small — this constant just needs to stay below
    // whatever availRightW can realistically be before those kick in.
    var MIN_QUICK_INFO_W = 40;
    // Bare structural safety floor for the card/thread column's width —
    // same "not a comfort floor" philosophy as MIN_QUICK_INFO_W above:
    // PostCardView's internal content is fluid CSS and reflows on its own
    // at any width; this just stops setExtent from ever seeing a
    // zero/negative width.
    var MIN_CARD_COL_W = 60;
    var MEMBERS_W = 220;       // outer slot width (design width — shrinks under MIN_MEMBERS_W, see _layout)
    // Bare structural safety floor for the members column — same
    // "not a comfortable minimum" philosophy as MIN_QUICK_INFO_W/
    // MIN_CARD_COL_W above. Keeps room for the avatar + handle + status
    // pill a row renders (_renderMemberSection bottoms the badge out at
    // w2-66..w2-4) without the pill overlapping the handle text.
    var MIN_MEMBERS_W = 160;
    var GUTTER = 20;           // column gutter, also the gap before the members column and the page's right edge
    // Shared by _renderEventCard/_renderEmptyEventCard (the card's own max
    // width) AND _renderQuickInfo (to compute the card's real left edge so
    // the description column can widen into the gap this cap leaves unused
    // on wide panels — see EVENT_CARD_ACTUAL_LEFT below). One constant so
    // the two places can't drift apart.
    var EVENT_CARD_MAX_W = 300;
    var BOTTOM_MARGIN = 20;    // space left below the comment thread before the viewport's bottom edge
    var TOP = 56;              // top margin below the menu bar
    var SEARCH_W = 490, SEARCH_H = 45;
    var NAV_H = 40;
    var ROW_GAP = 16;
    // Prev/next-turn cluster below the reel card: two circular icon buttons
    // flanking a pill-shaped "N / M" badge, the whole group centered under
    // the card rather than left-anchored at the card's own edge.
    var NAV_BTN_D = 34, NAV_GAP = 10, NAV_PILL_W = 78;
    var NAV_CLUSTER_W = NAV_BTN_D + NAV_GAP + NAV_PILL_W + NAV_GAP + NAV_BTN_D;

    // "Sort by" placeholder dropdown, sitting in the gap between the
    // postcard's top-right corner and the search box's left edge.
    // 132: "Goosed 🪿" measures ~86px in bold 12pt (plain-page measurement, not
    // yet confirmed in the live world); the button label gets SORT_W - 34 minus
    // the 8px shapeNode padding.
    var SORT_W = 132, SORT_H = SEARCH_H;   // same height as the search box, same row
    var SORT_ITEM_H = 32;
    var SORT_OPTIONS = ["Stellar", "New", "Hyphy", "Goosed"];
    // Feed route's ?sort= value per option. New has none (newest first).
    var SORT_PARAMS = { Stellar: "starred", Goosed: "goosed", Hyphy: "hyphy" };
    // Flavor emoji shown after each option's name (display only — the option
    // name itself stays the key for SORT_PARAMS / _sortSelection).
    var SORT_EMOJI = { Stellar: "⭐", New: "🫧", Hyphy: "🔥", Goosed: "🪿" };
    function sortDisplay(option) { return option + " " + SORT_EMOJI[option]; }

    // "+ Postcard" — opens a new PostCardEditor compose window, preset to
    // post into this constellation. Sits left of the members list, top
    // edge aligned with the search box's top edge, but shorter than the
    // search box itself — height hugs the label the same way width does.
    var CREATE_BTN_W = 150, CREATE_BTN_H = 34;
    // Degraded form once the full pill no longer fits the gap (see
    // _layout's createBtnFits) — a plain "+" circle instead of disappearing
    // entirely. A perfect circle (not just a smaller pill) since the box's
    // border-radius is already fixed at CREATE_BTN_H/2 — width === height
    // is what turns that into a circle rather than a short pill.
    var CREATE_BTN_CIRCLE_W = CREATE_BTN_H;

    // "Map ↗" / "Canvas ↗" pills in the quick-info panel — same pill shape as
    // "+ Postcard" (but green), label + arrow_outward glyph. Sized from a
    // hardcoded label width (measured once, live) rather than measured at
    // build time, since the icon font's async load makes a same-tick width
    // read unreliable (CLAUDE.md, Material Symbols section). Widths are the
    // rendered width of each label in bold 14pt (18.67px) Helvetica.
    var QI_PILL_H = 34;
    var QI_PILL_ICON_BOX = 26, QI_PILL_ICON_PX = 18;
    var QI_PILL_PAD = 10.85, QI_PILL_GAP = 5;   // side padding, label-to-glyph gap (px)
    var QI_PILL_TEXT_W = { Map: 37.3, Wiki: 38.2, Canvas: 66.4 };
    // Fill + hover fill per pill. Map is the Rooms panel's green (same value
    // as ROOM_GREEN, written out because that var is assigned further down,
    // after this line runs); Canvas uses the purple accent the wallet
    // dialogs' pills already use; Wiki is blue.
    var QI_PILL_COLORS = {
      Map:    { fill: Color.rgb(46, 160, 90),  hover: Color.rgb(36, 132, 72) },
      Wiki:   { fill: Color.rgb(37, 99, 235),  hover: Color.rgb(29, 78, 216) },
      Canvas: { fill: Color.rgb(147, 51, 234), hover: Color.rgb(126, 34, 206) },
    };
    // Total pill width for a label of the given rendered width: padding on
    // each side around label + gap + glyph.
    function qiPillWidth(textW) {
      return Math.round(textW + QI_PILL_GAP + QI_PILL_ICON_PX + QI_PILL_PAD * 2);
    }

    // Spaces/rooms panel -- "New Room" pill (top-right of the panel header,
    // same "+ X" single-Text-morph pill idiom as CREATE_BTN above, sized to
    // hug its own label the same way) and room-card palette. A distinct
    // accent (blurple, not COMMENT_ACCENT's pink) so Rooms reads as its own
    // feature rather than reusing the postcard-compose color.
    var ROOM_ACCENT = Color.rgb(79, 11, 67);
    var ROOM_GREEN = Color.rgb(46, 160, 90);
    // "Clusters" panel-title pill (star-cluster icon + label, same green as
    // ROOM_GREEN) — same icon-Text-plus-label-Text idiom as _buildPillButton,
    // but simpler: the icon's own position is fixed at construction time
    // (only the label's width is measured live), so it's baked straight
    // into the constructor rect rather than set afterward (CLAUDE.md:
    // setPosition right after addMorph can desync a morph's render tree).
    var CLUSTERS_TITLE_PILL_H = 26;
    var CLUSTERS_TITLE_ICON_BOX = 18;
    var CLUSTERS_TITLE_PAD = 10, CLUSTERS_TITLE_GAP = 5;
    // Custom "star cluster" icon (three 5-point stars in descending sizes),
    // not a Material Symbols ligature, so it's an inline SVG on a plain
    // Image morph. 24x24 viewBox, white fill to sit on the green pill.
    var CLUSTERS_STAR_PATH = "M9.00 7.00L10.94 11.83L16.13 12.18L12.14 15.52L13.41 20.57L9.00 17.80L4.59 20.57L5.86 15.52L1.87 12.18L7.06 11.83ZM18.00 2.40L19.18 5.38L22.37 5.58L19.90 7.62L20.70 10.72L18.00 9.00L15.30 10.72L16.10 7.62L13.63 5.58L16.82 5.38ZM19.00 15.50L19.76 17.45L21.85 17.57L20.24 18.90L20.76 20.93L19.00 19.80L17.24 20.93L17.76 18.90L16.15 17.57L18.24 17.45Z";
    var CLUSTERS_STAR_ICON_URL = "data:image/svg+xml;utf8," + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#ffffff" d="' + CLUSTERS_STAR_PATH + '"/></svg>');
    // How often an open lounge re-asks for room presence (see _startRoomsPoll).
    var ROOMS_POLL_MS = 8000;
    var NEW_ROOM_BTN_H = 28;
    var ROOM_CARD_PAD = 14;
    // Fixed tile size (not "stretch to fill the panel") — cards wrap into a
    // grid, Discord-server-directory style, so the panel has visible room
    // for more rooms beside/below the first rather than one card stretched
    // edge-to-edge. BANNER_H is proportioned to be a substantial fraction
    // of the tile's height (not a thin strip) per the reference screenshot.
    var ROOM_CARD_W = 300;
    var ROOM_BANNER_H = 70;
    var ROOM_CARD_GAP = 16;

    // Plain Box/Text/Image morphs default to draggable/droppable/grabbable.
    // Events.js's drag-start check is `targetMorph.draggingEnabled ||
    // targetMorph.isGrabbable()`, and isGrabbable() (MorphAddons.js) defaults
    // to *true* whenever grabbingEnabled was never explicitly set — so all
    // three flags need setting, not just draggingEnabled/droppingEnabled.
    // This has to be applied to every child morph a card is built from, not
    // just the outer card Box: drag-start is decided by whichever morph is
    // actually under the cursor (evt.hand.clickedOnMorph), and a room card's
    // children (banner, name, icon chips, avatars, labels) visually cover
    // almost the whole card — confirmed live: fixing only the outer card
    // left every child still independently draggable, which reads as "the
    // card is still draggable" since there's barely any bare card
    // background exposed to click on directly.
    function noDrag(m) {
      m.draggingEnabled = false;
      m.droppingEnabled = false;
      m.grabbingEnabled = false;
      return m;
    }

    // Comment thread (nested, no votes) geometry/palette.
    var COMMENT_INDENT = 30;   // px per nesting depth
    var COMMENT_AVATAR = 22;   // px, square
    // Left/right inset for the whole thread's content — same fix as the
    // members panel: the container's CSS padding doesn't actually offset
    // Lively's absolutely-positioned submorphs (confirmed live), so the
    // margin has to be baked into every x/width passed to the render
    // functions below instead.
    var COMMENT_PAD_X = 10;
    var COMPOSER_MAX_EXTRA = 160;  // most a comment box grows with its text (~10 lines past the base 3); past that the field scrolls
    var COMMENT_TOP_MARGIN = 12;   // small gap above the top ("Add a comment") composer, which otherwise sits flush against the container's top edge
    var THREAD_LINE_COLOR = Color.rgb(224, 227, 230);
    var COMMENT_META_COLOR = Color.rgb(120, 120, 120);
    var COMMENT_ACCENT = "#e8497e";  // same pink accent as lively.commerce.Shop's --color-accent

    // Scroll view — a vertical list of full-size postcard rows (same card
    // as the Reel, full feature parity), alongside the default Reel. Each
    // row starts at CARD_H and is corrected to its real rendered height by
    // _fitScrollRowToContent, the same measurement _fitCardToContent uses
    // for the Reel's own singleton card.
    var MINI_ROW_PAD_X = 12, MINI_ROW_PAD_TOP = 12, MINI_ROW_GAP = 14;
    var VIEW_TOGGLE_W = 72, VIEW_TOGGLE_H = 32, VIEW_TOGGLE_GAP = 10;

    Object.subclass("lively.identity.ConstellationLoungeController",

    "initializing", {
      initialize: function () {
        this._name = null;
        this._quickInfo = null;
        this._canWrite = false;
        this._isController = false;
        this._joinRequestStatus = null;
        this.yDoc = null;
        this.wsProvider = null;

        this._feedCards = [];      // top-level stack, newest-first
        this._feedCursor = null;
        this._activeIndex = -1;

        this._threadRootObjId = null;
        this._threadReplies = [];
        this._threadChildrenCache = {};
        this._threadExpanded = {};
        this._replyBoxOpenFor = null;   // objId of the comment whose inline reply box is open, "ROOT" for the top composer, or null
        this._draftText = {};           // same keys as above -> in-progress composer text, kept across re-renders
        this._draftAttachment = {};     // same keys -> {uploading:true} while in flight, else {kind, url, name, entry} (entry is null for a picked GIF/sticker: it's a plain Klipy URL, not an uploaded blob)
        this._composerState = this._newComposerState(); // grow-with-text bookkeeping for the reel thread's composers (a mini-card row keeps its own in row.miniThread.composer) — see _wireComposerField
        this._mediaPicker = null;       // lazily created by _getMediaPicker — one controller shared by every composer, only one is ever open at a time
        this._didHandleCache = {};      // did -> handle, for authors not already in quickInfo.memberHandles
        this._bodyBoxCache = {};        // reply.objId -> {box, html, width, height} — see _renderCommentNode
        this._threadRerenderTimer = null;

        this._frontCardBox = null;
        this._backCardBox = null;
        this._spacesBox = null;

        this._viewMode = "reel";        // "reel" (default) or "scroll"
        this._scrollListBox = null;     // built lazily on first switch to Scroll
        this._scrollRows = {};          // objId -> {box, objId, cardH, expanded, threadWrap, threadH, miniThread, commentCount}
        this._scrollExpandedObjId = null;   // single-select accordion — only one row's comments open at a time
        this._scrollLoadingMore = false;
        this._scrollResizeFitTimer = null;

        this._presenceByDid = {};  // did -> true while online

        this._rooms = [];          // fetched from GET /c/:name/rooms, see _fetchRooms
        this._amMember = false;
        this._signedIn = false;   // distinguishes "not signed in" from "signed in, not a member" (see _roomStatusInfo)
      },
    },

    // ─── boot ─────────────────────────────────────────────────────────────────

    "boot", {
      open: function (name) {
        this._name = name;
        this._loadQuickInfo();
      },

      _loadQuickInfo: function () {
        var self = this;
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("GET", base + "/c/" + encodeURIComponent(this._name) + "/space-token", true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) return self._showError("Failed to load c/" + self._name + " (" + xhr.status + ")");
          var data;
          try { data = JSON.parse(xhr.responseText); } catch (e) { return self._showError("Bad space-token response"); }
          self._genesisObjId = data.genesisObjId;
          self._canWrite = !!data.canWrite;
          self._isController = !!data.isController;
          self._joinRequestStatus = data.joinRequestStatus || null;
          self._quickInfo = data.quickInfo || {};
          self._start();
        };
        xhr.onerror = function () { self._showError("Network error loading c/" + self._name); };
        xhr.send();
      },

      // Re-fetches quick-info state and re-renders just that panel, without
      // the full _start() rebuild _loadQuickInfo does on initial boot (which
      // would re-add DOM listeners/websocket connections). Used after the
      // settings dialog saves a new avatar/banner/domain.
      _refreshQuickInfo: function () {
        var self = this;
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("GET", base + "/c/" + encodeURIComponent(this._name) + "/space-token", true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) return;
          var data;
          try { data = JSON.parse(xhr.responseText); } catch (e) { return; }
          self._isController = !!data.isController;
          self._quickInfo = data.quickInfo || {};
          self._renderQuickInfo();
          // Membership/roles/bots may have changed (manage dialog, settings
          // dialog) — the member list reads the same quick info.
          self._renderMemberList();
          self._layout();
        };
        xhr.send();
      },

      // The name to show and to build page URLs from: the constellation's
      // verified domain when it has one, else its name. API calls keep using
      // this._name (the domain URL is only an alias for it server-side).
      _displayName: function () {
        return (this._quickInfo && this._quickInfo.domain) || this._name;
      },

      _start: function () {
        document.title = "c/" + this._displayName();
        this._buildChrome();
        this._renderQuickInfo();
        this._renderMemberList();
        // Baseline for _onWindowResize's change-detection — this._geom
        // already exists (_buildChrome's own final _layout() call set it).
        this._lastRenderedQuickInfoW = this._geom.quickInfoW;
        this._lastRenderedCardW = this._geom.cardW;
        this._lastRenderedMembersW = this._geom.membersW;
        this._fetchFeed(null);
        this._fetchRooms();
        this._startRoomsPoll();
        this._connectPresence();
        this._installMenuBarEntry();
        window.addEventListener("resize", this._onWindowResize.bind(this));
      },
    },

    // ─── layout ──────────────────────────────────────────────────────────────

    "layout", {
      // Recomputes fixed pixel geometry for the current viewport and
      // repositions every morph. Purely geometric — content rebuilds
      // happen where the underlying data changes, not here.
      _layout: function () {
        var W = window.innerWidth, H = window.innerHeight;
        // Three flexible columns (card/thread, quick-info/rooms, members)
        // share whatever width is actually left after all four gutters
        // (left margin, gap before quick-info, gap before members, right
        // margin). Split proportionally to their original design widths
        // once that combined budget no longer fits, each floored at its
        // own bare safety minimum — same "degrade, don't force overlap"
        // lesson learned fixing MIN_QUICK_INFO_W earlier this session (a
        // floor must never exceed what's actually available, or it
        // guarantees overlap instead of preventing it). The members column
        // used to be pinned at MEMBERS_W regardless of window width (the
        // other two already flexed) — it now shrinks right along with
        // them instead of forcing the other two to absorb the whole
        // deficit on a narrow window.
        var DESIGN_TOTAL_W = CARD_W + QUICK_INFO_W + MEMBERS_W;
        var totalAvail = Math.max(0, W - GUTTER * 4);
        var cardW, quickInfoW, membersW;
        if (totalAvail >= DESIGN_TOTAL_W) {
          cardW = CARD_W;
          quickInfoW = QUICK_INFO_W;
          membersW = MEMBERS_W;
        } else {
          // Reserve each column's floor first, then hand out whatever's left
          // above that combined floor proportionally to each column's own
          // "design width above its floor" — NOT a plain independent
          // max(floor, proportional-of-total) per column, which can't see
          // the other columns' floors and so can overshoot totalAvail (e.g.
          // members hitting MIN_MEMBERS_W can by itself force cardW+
          // quickInfoW+membersW past totalAvail, overlapping the members
          // column onto quick-info — confirmed live at a 1100px window,
          // ~17px of real DOM overlap). This way the three widths always
          // sum to exactly totalAvail (members takes the rounding
          // remainder), so a floor can never force a sibling past its own
          // edge.
          var sumFloors = MIN_CARD_COL_W + MIN_QUICK_INFO_W + MIN_MEMBERS_W;
          if (totalAvail <= sumFloors) {
            cardW = MIN_CARD_COL_W;
            quickInfoW = MIN_QUICK_INFO_W;
            membersW = MIN_MEMBERS_W;
          } else {
            var extra = totalAvail - sumFloors;
            var designExtraTotal = (CARD_W - MIN_CARD_COL_W) + (QUICK_INFO_W - MIN_QUICK_INFO_W) + (MEMBERS_W - MIN_MEMBERS_W);
            cardW = MIN_CARD_COL_W + Math.round(extra * (CARD_W - MIN_CARD_COL_W) / designExtraTotal);
            quickInfoW = MIN_QUICK_INFO_W + Math.round(extra * (QUICK_INFO_W - MIN_QUICK_INFO_W) / designExtraTotal);
            membersW = totalAvail - cardW - quickInfoW;
          }
        }
        // GUTTER-width margin on the right too, matching every other
        // column gap instead of running the members list flush to the edge.
        var membersX = W - membersW - GUTTER;
        // Right column (the about panel) starts one gutter past the
        // postcard's (now possibly shrunk) right edge.
        var rightColX = GUTTER + cardW + GUTTER;
        var threadW = cardW - THREAD_PAD_X * 2;
        // Postcard's top edge lines up with the search box's top edge —
        // both start at TOP — rather than sitting a row below it.
        var reelY = TOP;
        // About panel stays below the search row (its own row, not sharing
        // reelY any more) — otherwise it'd sit in the same band as the now
        // top-aligned postcard and cover the search box entirely, since
        // its column overlaps the search box's centered position.
        var quickInfoY = TOP + SEARCH_H + ROW_GAP;
        var cardH = this._cardH || CARD_H;
        var threadY = reelY + cardH + NAV_H;
        // Rendered (visible) height comes from whatever room is actually
        // left in the viewport below the thread's top edge (minus
        // BOTTOM_MARGIN), capped at THREAD_H_MAX rather than always
        // claiming it — the container's own overflowY:auto (see
        // _buildChrome) scrolls whatever content doesn't fit, so shrinking
        // the box on a short viewport is safe.
        var threadRenderedH = Math.min(THREAD_H_MAX, Math.max(THREAD_H_MIN, H - threadY - BOTTOM_MARGIN));
        // The extent actually passed to setExtent has to be smaller than
        // that by the container's own vertical CSS padding (THREAD_PAD_Y
        // top+bottom) — same box-model correction as THREAD_W, confirmed
        // live: without it the rendered box came out 20px taller than
        // requested and swallowed the whole bottom margin.
        var threadH = threadRenderedH - THREAD_PAD_Y * 2;
        var threadBottom = threadY + threadRenderedH;
        // Spaces/rooms panel (placeholder — no real feature behind it yet)
        // sits directly below the about panel, same footprint the old
        // embedded wiki panel had: same column/width, bottoming out level
        // with the comment thread below it.
        var spacesY = quickInfoY + QUICK_INFO_H + ROW_GAP;

        // Nudged right of dead-center, as its own hero row across the full
        // page width, above the reel/quick-info columns rather than
        // tucked beside them. Floored so the row (which shares the
        // postcard's own top y-coordinate — see reelY above) never drifts
        // left into the postcard's own column: confirmed live, at ~1300px
        // window width and narrower this window-centered heuristic alone
        // put sortByX (searchX's own left neighbor, below) inside the
        // postcard's real x-range — a bug that predates cardW becoming
        // responsive, since this formula never referenced the card
        // column's width at all. minSearchX keeps sortByX at or past
        // rightColX (already one gutter clear of the postcard's real
        // right edge), matching this row's own documented intent of
        // sitting in the gap after the postcard, not on top of it.
        // Search box width now scales with the row's own available space
        // instead of staying pinned at the fixed SEARCH_W design constant
        // (the same "flexible middle column" treatment already given to
        // cardW/quickInfoW above) — floored at SEARCH_MIN_W so the field
        // never gets too cramped to use, capped at SEARCH_W so it doesn't
        // balloon past its original design width on very wide windows.
        var SEARCH_MIN_W = 260;
        // Sort-by and the Reel/Scroll view toggle both sit left of the
        // search box now (toggle immediately right of sort-by), so the
        // reserved-space math below has to account for both widths plus
        // their gaps, not just SORT_W.
        var LEFT_MENUS_W = SORT_W + VIEW_TOGGLE_GAP + VIEW_TOGGLE_W;
        var searchRowAvail = Math.max(0, membersX - GUTTER - (rightColX + GUTTER + LEFT_MENUS_W + GUTTER));
        var searchW = Math.max(SEARCH_MIN_W, Math.min(SEARCH_W, searchRowAvail));
        var minSearchX = rightColX + GUTTER + LEFT_MENUS_W;
        var searchX = Math.max(minSearchX, (W - searchW) / 2 + 100);
        // Keep the box clear of the members column even when the centering
        // formula above would otherwise push it past that edge.
        searchX = Math.max(minSearchX, Math.min(searchX, membersX - GUTTER - searchW));
        // "+ Postcard" sits centered in the horizontal gap between the
        // search box's right edge and the members column's left edge,
        // rather than pinned to either one — width comes from
        // _fitCreatePostcardButton once known, not the guessed constant.
        // At narrower widths this gap can shrink to nothing (confirmed
        // live: it was already ~65px short of createBtnW even before
        // searchX's own minSearchX floor above, which then shrinks it
        // further) — rather than let the button overlap the search box or
        // the members column, it degrades in two steps: first to a compact
        // "+" circle (createBtnFitsCircle, _setCreateBtnCompact), and only
        // once even that doesn't fit does it disappear entirely, same
        // "degrade by disappearing" precedent as _renderEventCard's own
        // no-room bail-out. A menu bar "New postcard" entry
        // (MenuBarEntry.js) already offers the same action, so hiding
        // this shortcut at that final extreme isn't a functionality loss.

        var createBtnW = this._createBtnW || CREATE_BTN_W;
        var createGapStart = searchX + searchW + VIEW_TOGGLE_GAP;
        var createGapEnd = membersX;
        var createBtnFits = (createGapEnd - createGapStart) >= createBtnW + GUTTER * 2;
        var createBtnX = createGapStart + (createGapEnd - createGapStart - createBtnW) / 2;
        // Circle fit needs far less breathing room than the full pill — a
        // single GUTTER's worth rather than GUTTER*2 — since there's no
        // label to protect from looking cramped against its neighbors.
        var createBtnFitsCircle = (createGapEnd - createGapStart) >= CREATE_BTN_CIRCLE_W + GUTTER;
        var createBtnCircleX = createGapStart + (createGapEnd - createGapStart - CREATE_BTN_CIRCLE_W) / 2;

        // Sort-by sits in the gap between the postcard's top-right corner
        // and the search box's left edge, same row; the Reel/Scroll view
        // toggle sits immediately to sort-by's right, both still left of
        // the search box.
        var sortByX = searchX - GUTTER - VIEW_TOGGLE_W - VIEW_TOGGLE_GAP - SORT_W;
        var toggleX = sortByX + SORT_W + VIEW_TOGGLE_GAP;

        var g = this._geom = {
          searchX: searchX, searchY: TOP, searchW: searchW,
          toggleX: toggleX, toggleY: TOP + (SEARCH_H - VIEW_TOGGLE_H) / 2,
          sortByX: sortByX, sortByY: TOP,
          // Sits beside the postcard, below the search row.
          quickInfoX: rightColX, quickInfoY: quickInfoY, quickInfoW: quickInfoW, quickInfoH: QUICK_INFO_H,
          reelX: GUTTER, reelY: reelY, cardW: cardW,
          // Centered under the card rather than left-anchored at the
          // card's own edge — falls back to the card's left edge if the
          // card column ever shrinks narrower than the cluster itself.
          navX: GUTTER + Math.max(0, Math.round((cardW - NAV_CLUSTER_W) / 2)), navY: reelY + cardH + 6,
          threadX: GUTTER, threadY: threadY, threadW: threadW, threadH: threadH,
          spacesX: rightColX, spacesY: spacesY, spacesW: quickInfoW, spacesH: threadBottom - spacesY,
          membersX: membersX, membersY: TOP, membersW: membersW, membersH: Math.max(120, threadBottom - TOP),
          createBtnX: createBtnX, createBtnY: TOP, createBtnFits: createBtnFits,
          createBtnCircleX: createBtnCircleX, createBtnFitsCircle: createBtnFitsCircle,
        };

        if (this._searchBox) {
          this._searchBox.setPosition(lively.pt(g.searchX, g.searchY));
          this._applySearchWidth(g.searchW);
        }
        if (this._viewToggleBox) this._viewToggleBox.setPosition(lively.pt(g.toggleX, g.toggleY));
        if (this._sortByBox) this._sortByBox.setPosition(lively.pt(g.sortByX, g.sortByY));
        if (this._createPostcardBtn) {
          // Combines with the sign-in/write-permission gate set once in
          // _buildChrome (this._canWrite) — that flag doesn't change on
          // resize, so re-apply it here alongside the fits-in-the-gap
          // checks rather than letting this overwrite it unconditionally.
          // Two-step degrade: full pill if it fits, else the compact "+"
          // circle if THAT fits, else hidden entirely.
          if (!!this._canWrite && g.createBtnFits) {
            this._createPostcardBtn.setPosition(lively.pt(g.createBtnX, g.createBtnY));
            this._setCreateBtnCompact(false);
            this._createPostcardBtn.setVisible(true);
          } else if (!!this._canWrite && g.createBtnFitsCircle) {
            this._createPostcardBtn.setPosition(lively.pt(g.createBtnCircleX, g.createBtnY));
            this._setCreateBtnCompact(true);
            this._createPostcardBtn.setVisible(true);
          } else {
            this._createPostcardBtn.setVisible(false);
          }
        }
        if (this._sortByDropdown) {
          this._sortByDropdown.setPosition(lively.pt(g.sortByX, g.sortByY + SORT_H + 4));
        }
        if (this._quickInfoBox) {
          this._quickInfoBox.setPosition(lively.pt(g.quickInfoX, g.quickInfoY));
          this._quickInfoBox.setExtent(lively.pt(g.quickInfoW, g.quickInfoH));
        }
        if (this._frontCardBox) {
          this._frontCardBox.setPosition(lively.pt(g.reelX, g.reelY));
          this._frontCardBox.setExtent(lively.pt(g.cardW, cardH));
          // PostCardView's own internal DOM is fluid CSS (width:100%/
          // inset:0), so it reflows automatically once its own box extent
          // changes — no re-fetch or rebuild needed, just propagate the
          // new size down.
          (this._frontCardBox.submorphs || []).forEach(function (m) { m.setExtent(lively.pt(g.cardW, cardH)); });
        }
        if (this._backCardBox) {
          this._backCardBox.setPosition(lively.pt(g.reelX + 8, g.reelY + 8));
          this._backCardBox.setExtent(lively.pt(g.cardW, cardH));
        }
        if (this._navBox) this._navBox.setPosition(lively.pt(g.navX, g.navY));
        if (this._threadContainer) {
          this._threadContainer.setPosition(lively.pt(g.threadX, g.threadY));
          this._threadContainer.setExtent(lively.pt(g.threadW, g.threadH));
        }
        // Scroll view's list sits at exactly the Reel+nav+thread cluster's
        // footprint (no new column math) — same left edge/width as the
        // reel card, spanning down to where the comment thread normally
        // bottoms out.
        if (this._scrollListBox) {
          this._scrollListBox.setPosition(lively.pt(g.reelX, g.reelY));
          this._scrollListBox.setExtent(lively.pt(g.cardW, threadBottom - g.reelY));
          this._resizeScrollRowsWidth();
        }
        if (this._spacesBox) {
          this._spacesBox.setPosition(lively.pt(g.spacesX, g.spacesY));
          this._spacesBox.setExtent(lively.pt(g.spacesW, g.spacesH));
        }
        if (this._membersBox) {
          this._membersBox.setPosition(lively.pt(g.membersX, g.membersY));
          this._membersBox.setExtent(lively.pt(g.membersW, g.membersH));
        }
      },

      // Runs on every raw browser "resize" event. _layout()'s own box
      // repositioning/resizing is cheap and stays immediate every time (so
      // panels keep tracking the cursor smoothly mid-drag — this includes
      // the postcard reel, whose fluid-CSS internal content also reflows
      // for free as part of that immediate step, no rebuild needed), but
      // _renderQuickInfo()/_renderSpaces()/_renderThreadTree() each clear
      // and rebuild their whole panel's DOM from scratch (banner image,
      // measurement probes, room-card grid, comment rows) — too expensive
      // and visibly flickery to run on every tick of a resize drag.
      // Debounced via the same lively.lang.fun.debounceNamed(id, ms, fn)
      // idiom MenuBar.js/AmbientPresencePanel.js already use for
      // onWorldResize (this controller is a plain Object.subclass, not a
      // morph, so there's no this.id — this._name is this instance's
      // natural unique key throughout the file already). Skipped entirely
      // unless this._geom.quickInfoW/cardW/membersW — the quantities that
      // actually affect these panels' content — have genuinely changed
      // since the last real re-render, so a pure-height-only resize
      // triggers no rebuild at all.
      _onWindowResize: function () {
        this._layout();
        var quickInfoW = this._geom.quickInfoW;
        var cardW = this._geom.cardW;
        var membersW = this._geom.membersW;
        if (quickInfoW === this._lastRenderedQuickInfoW && cardW === this._lastRenderedCardW
          && membersW === this._lastRenderedMembersW) return;
        lively.lang.fun.debounceNamed("constellation-lounge-resize-render-" + this._name, 150,
          function () {
            this._lastRenderedQuickInfoW = quickInfoW;
            this._lastRenderedCardW = cardW;
            this._lastRenderedMembersW = membersW;
            this._renderQuickInfo();
            this._renderSpaces();
            if (this._threadContainer) this._renderThreadTree();
            if (this._membersBox) this._renderMemberList();
          }.bind(this))();
      },
    },

    // ─── chrome ──────────────────────────────────────────────────────────────

    "chrome", {
      _buildChrome: function () {
        var self = this;

        var loader = document.getElementById("lounge-loader");
        if (loader) loader.remove();
        var staticEl = document.getElementById("lounge-static");
        if (staticEl) staticEl.remove();

        this._ensureCommentBodyStyle();

        this._searchBox = this._buildSearchField();
        $world.addMorph(this._searchBox);

        this._viewToggleBox = this._buildViewToggle();
        $world.addMorph(this._viewToggleBox);
        this._updateViewToggleStyle();

        this._sortSelection = SORT_OPTIONS[0];
        this._sortByBox = this._buildSortByButton();
        $world.addMorph(this._sortByBox);

        this._createPostcardBtn = this._buildCreatePostcardButton();
        $world.addMorph(this._createPostcardBtn);
        this._createPostcardBtn.setVisible(!!this._canWrite);
        this._fitCreatePostcardButton();
        this._fitCreatePostcardCircle();

        this._quickInfoBox = new lively.morphic.Box(lively.rect(0, 0, 10, 10));
        this._quickInfoBox.setFill(Color.white);
        // clipMode hidden so the banner/avatar section _renderQuickInfo adds
        // (a full-width banner flush against the box's top edge) gets
        // clipped to this box's own rounded corners automatically, instead
        // of needing separate per-corner radii on the banner morph itself.
        this._quickInfoBox.applyStyle({ borderWidth: 1, borderColor: Color.rgb(238, 238, 238), borderRadius: 8, clipMode: "hidden" });
        $world.addMorph(this._quickInfoBox);

        // Back card slot first (rendered below the front card) — a plain
        // styled rectangle, not a second live PostCardView: showing a
        // "peek of the next card's edge" doesn't need its content
        // pre-fetched and pre-rendered every turn, just a stack-of-cards
        // impression.
        this._backCardBox = new lively.morphic.Box(lively.rect(0, 0, CARD_W, CARD_H));
        this._backCardBox.setFill(Color.rgb(245, 245, 247));
        this._backCardBox.applyStyle({ borderWidth: 0, borderRadius: 10 });
        $world.addMorph(this._backCardBox);

        this._frontCardBox = new lively.morphic.Box(lively.rect(0, 0, CARD_W, CARD_H));
        $world.addMorph(this._frontCardBox);
        var frontNode = this._frontCardBox.renderContext().shapeNode;
        frontNode.style.transformOrigin = "50% 50%";
        frontNode.style.transition = "transform 260ms ease, opacity 260ms ease";
        // Scopes the pink reel-scrollbar rule (_ensureCommentBodyStyle) to
        // just this box's embedded PostCardView, not every other
        // .lively-postcard-view-content on the page (the full standalone
        // view opened from elsewhere keeps the browser's default scrollbar).
        frontNode.classList.add("lounge-reel-card");

        this._navBox = new lively.morphic.Box(lively.rect(0, 0, NAV_CLUSTER_W, NAV_BTN_D));
        this._navBox.applyStyle({ fill: null, borderWidth: 0 });
        $world.addMorph(this._navBox);

        this._prevBtn = this._buildNavChevronButton("chevron_left", -1, 0);
        this._navBox.addMorph(this._prevBtn);

        this._navLabel = this._buildNavCountPill();
        this._navLabel.setPosition(lively.pt(NAV_BTN_D + NAV_GAP, (NAV_BTN_D - 18) / 2));
        this._navBox.addMorph(this._navLabel);
        var pillBg = new lively.morphic.Box(lively.rect(NAV_BTN_D + NAV_GAP, 0, NAV_PILL_W, NAV_BTN_D));
        pillBg.applyStyle({
          fill: Color.rgb(0xF7, 0xF2, 0xF4), borderWidth: 1, borderColor: Color.rgb(0xF0, 0xCE, 0xDC),
          borderRadius: NAV_BTN_D / 2,
        });
        this._navBox.addMorphBack(pillBg);

        this._nextBtn = this._buildNavChevronButton("chevron_right", 1, NAV_BTN_D + NAV_GAP + NAV_PILL_W + NAV_GAP);
        this._navBox.addMorph(this._nextBtn);

        this._threadContainer = new lively.morphic.Box(lively.rect(0, 0, 10, 10));
        this._threadContainer.setFill(Color.white);
        this._threadContainer.applyStyle({ borderWidth: 1, borderColor: Color.rgb(238, 238, 238), borderRadius: 8 });
        this._threadContainer.renderContext().shapeNode.style.overflowY = "auto";
        this._threadContainer.renderContext().shapeNode.style.padding = "10px " + THREAD_PAD_X + "px";
        this._threadContainer.renderContext().shapeNode.classList.add("lounge-comment-thread");
        $world.addMorph(this._threadContainer);

        // Spaces/rooms panel — occupies the same footprint the embedded
        // wiki panel used to (below the about panel, bottoming out level
        // with the comment thread), same panel treatment (border, radius).
        // Backed by real server routes (GET/POST /c/:name/rooms and the
        // presence/join-request sub-routes) — _fetchRooms (called from
        // _start, after _buildChrome) populates this._rooms and re-renders;
        // this initial render just shows the empty state until that lands.
        this._spacesBox = new lively.morphic.Box(lively.rect(0, 0, 10, 10));
        this._spacesBox.setFill(Color.white);
        this._spacesBox.applyStyle({ borderWidth: 1, borderColor: Color.rgb(238, 238, 238), borderRadius: 8 });
        this._spacesBox.renderContext().shapeNode.style.overflowY = "auto";
        // Same light-pink pill-thumb treatment as the reel card's content
        // area (_ensureCommentBodyStyle) — these two listing panels were
        // still using the browser's plain default scrollbar.
        this._spacesBox.renderContext().shapeNode.classList.add("lounge-listing-panel");
        $world.addMorph(this._spacesBox);

        this._rooms = [];
        this._renderSpaces();

        this._membersBox = new lively.morphic.Box(lively.rect(0, 0, 10, 10));
        this._membersBox.setFill(Color.white);
        // Same panel treatment as the about/comment boxes (border,
        // radius) instead of the plain left-border-only strip it had before.
        this._membersBox.applyStyle({ borderWidth: 1, borderColor: Color.rgb(238, 238, 238), borderRadius: 8 });
        this._membersBox.renderContext().shapeNode.style.overflowY = "auto";
        this._membersBox.renderContext().shapeNode.classList.add("lounge-listing-panel");
        $world.addMorph(this._membersBox);

        // Only turns the stack when no Lively text field currently has
        // input focus (activeInstance covers the search field and any
        // other Text morph, not just this one) — a global handler, not
        // scoped to a DOM tag check, since none of these fields are raw
        // <input>s anymore. "A"/"D" are a WASD-style alias for the same
        // prev/next turn as the arrow keys, guarded against modifier keys
        // so Cmd/Ctrl+A ("select all") and Ctrl+D ("bookmark") still reach
        // the browser untouched. "W"/"S" and Up/Down are the same WASD-
        // style pairing for the Scroll view's own navigation (_scrollListBy
        // no-ops, and lets the key fall through to its default browser
        // behavior, outside Scroll mode) — preventDefault only when we
        // actually scrolled, so Up/Down still do nothing-in-particular (not
        // an unwanted page scroll) while in Reel mode.
        document.addEventListener("keydown", function (evt) {
          if (lively.morphic.Text.activeInstance && lively.morphic.Text.activeInstance()) return;
          if (evt.key === "ArrowLeft") return self._turn(-1);
          if (evt.key === "ArrowRight") return self._turn(1);
          if (evt.key === "ArrowUp") { if (self._scrollListBy(-1)) evt.preventDefault(); return; }
          if (evt.key === "ArrowDown") { if (self._scrollListBy(1)) evt.preventDefault(); return; }
          if (evt.ctrlKey || evt.metaKey || evt.altKey) return;
          var key = evt.key.toLowerCase();
          if (key === "a") self._turn(-1);
          else if (key === "d") self._turn(1);
          else if (key === "w") { if (self._scrollListBy(-1)) evt.preventDefault(); }
          else if (key === "s") { if (self._scrollListBy(1)) evt.preventDefault(); }
        });

        // This is fixed-layout chrome — nothing here should be draggable.
        // Recurses into submorphs since dragging is a per-morph flag, not
        // inherited from a container.
        [
          this._searchBox, this._viewToggleBox, this._sortByBox, this._createPostcardBtn, this._quickInfoBox,
          this._backCardBox, this._frontCardBox,
          this._navBox, this._threadContainer, this._spacesBox, this._membersBox,
        ].forEach(this._disableDragging, this);

        this._layout();
      },

      _disableDragging: function (morph) {
        if (!morph) return;
        morph.disableDragging();
        morph.disableGrabbing();
        (morph.submorphs || []).forEach(this._disableDragging, this);
      },

      // Turns an existing "@handle" Text morph into a clickable link:
      // pink text, pointer cursor, hover shade, opens MiniProfileCard on
      // click. did/handle are closed over directly rather than stashed on
      // the morph — this controller is a plain Object.subclass, not a
      // lively.BuildSpec/addScript-reconstructed method, so normal JS
      // closures work here (see CLAUDE.md's BuildSpec-closure-loss gotcha,
      // which does NOT apply to this class).
      _wireHandleLink: function (t, did, handle) {
        var self = this; // the lounge controller, for its own _isController — see MiniProfileCard.open's opts
        var PINK = Color.rgb(0xCC, 0x00, 0x57);       // ProfileCard.js's own window-frame color
        var PINK_HOVER = Color.rgb(0xE0, 0x4A, 0x86);
        t.applyStyle({ textColor: PINK, handStyle: "pointer" });
        t.disableDragging();
        t.disableGrabbing();
        // Text.makeLabel -> beLabel() calls ignoreEvents() unconditionally
        // (TextCore.js), which silently no-ops onMouseUp forever (Events.js's
        // onMouseUpEntry bails out at `if (this.eventsAreIgnored...) return
        // false` before ever calling it) — same bug already hit and fixed in
        // MediaPickerDialog.js's tab labels. Confirmed live here too: real
        // clicks (and CDP-driven ones) landed exactly on the rendered text
        // but never reached onMouseUp until this was added.
        t.unignoreEvents();
        t.onMouseOver = function () { t.applyStyle({ textColor: PINK_HOVER }); };
        t.onMouseOut  = function () { t.applyStyle({ textColor: PINK }); };
        t.onMouseUp = function (evt) {
          lively.require("lively.identity.MiniProfileCard").toRun(function () {
            lively.identity.MiniProfileCard.open(handle, did, t, {
              roomContext: true,
              isController: !!self._isController,
              constellationName: self._name,
            });
          });
          evt.stop();
          return true;
        };
        return t;
      },

      // Comment bodies are rendered as raw HTML (reusing postCardUtils.
      // snapshotToHtml, same as PostCardView.js's own content area — see
      // the "thread" section below) inside a Box morph's shapeNode, so they
      // need the same kind of one-time stylesheet PostCardUtils.js's own
      // _ensureMediaStyle already injects for postcard media — just scoped
      // to tightening <p> margins for a compact comment list instead.
      _ensureCommentBodyStyle: function () {
        if (document.getElementById("lounge-comment-body-style")) return;
        var styleEl = document.createElement("style");
        styleEl.id = "lounge-comment-body-style";
        styleEl.textContent =
          // overflow-wrap:anywhere so a long unbroken string (a pasted URL, a
          // keyboard mash) wraps at the box edge instead of running ~3500px
          // wide and making the whole thread scroll sideways. The body's
          // height is measured off the live node (scrollHeight), so the
          // wrapped lines are accounted for.
          ".lounge-comment-body{font-size:12.5px;line-height:1.45;color:#1a1a1b;overflow-wrap:anywhere;}" +
          ".lounge-comment-body p{margin:0 0 6px;}" +
          ".lounge-comment-body p:last-child{margin-bottom:0;}" +
          // Same pill-thumb scrollbar treatment as lively.commerce.Shop's
          // .lk-shop-root, recolored for this panel's white (not pink-tinted)
          // background. A straight COMMENT_ACCENT (#e8497e) thumb read as
          // too bright/saturated against white — deepened to a warmer,
          // muted rose (#a52c58, darker still on hover) instead of the
          // bright accent used for borders/buttons elsewhere in this file.
          ".lounge-comment-thread{scrollbar-width:thin;scrollbar-color:#a52c58 #f2f2f3;}" +
          ".lounge-comment-thread::-webkit-scrollbar{width:10px;}" +
          ".lounge-comment-thread::-webkit-scrollbar-track{background:#f2f2f3;}" +
          ".lounge-comment-thread::-webkit-scrollbar-thumb{background:#a52c58;border-radius:999px;border:2px solid #f2f2f3;}" +
          ".lounge-comment-thread::-webkit-scrollbar-thumb:hover{background:#742040;}" +
          // Reel card's content area (PostCardView._contentEl, already
          // overflow-y:auto — see PostCardView.js) gets the same pill-thumb
          // treatment, but a literal light pink (not the deepened rose
          // above) since this sits on the card's own white face, not a
          // comment panel. Hover darkens to COMMENT_ACCENT for affordance.
          ".lounge-reel-card .lively-postcard-view-content{scrollbar-width:thin;scrollbar-color:#f4a7c6 #f7f2f4;}" +
          ".lounge-reel-card .lively-postcard-view-content::-webkit-scrollbar{width:10px;}" +
          ".lounge-reel-card .lively-postcard-view-content::-webkit-scrollbar-track{background:#f7f2f4;}" +
          ".lounge-reel-card .lively-postcard-view-content::-webkit-scrollbar-thumb{background:#f4a7c6;border-radius:999px;border:2px solid #f7f2f4;}" +
          ".lounge-reel-card .lively-postcard-view-content::-webkit-scrollbar-thumb:hover{background:#e8497e;}" +
          // Same light-pink treatment for the cluster's own listing panels
          // (_spacesBox's Spaces/rooms list, _membersBox's Members list) —
          // both were still on the browser's plain default scrollbar.
          ".lounge-listing-panel{scrollbar-width:thin;scrollbar-color:#f4a7c6 #f7f2f4;}" +
          ".lounge-listing-panel::-webkit-scrollbar{width:10px;}" +
          ".lounge-listing-panel::-webkit-scrollbar-track{background:#f7f2f4;}" +
          ".lounge-listing-panel::-webkit-scrollbar-thumb{background:#f4a7c6;border-radius:999px;border:2px solid #f7f2f4;}" +
          ".lounge-listing-panel::-webkit-scrollbar-thumb:hover{background:#e8497e;}";
        document.head.appendChild(styleEl);
      },
    },

    // ─── search — rebuild of PartsBin/iPadWidgets/SearchField.json as real morphs ──

    "search", {
      // Field extent only (icon stays fixed at the box's left edge) —
      // shared by _buildSearchField and _applySearchWidth (called from
      // _layout whenever the row's available width changes) so the field
      // and its placeholder always track the box's current width instead
      // of staying pinned at the box's build-time width. No Go button any
      // more, so the field runs all the way to the box's right edge minus
      // a flat 12px margin, instead of leaving room for the old button.
      _searchFieldRect: function (boxW) {
        return lively.rect(42, 6, boxW - 42 - 12, SEARCH_H - 12);
      },

      _buildSearchField: function () {
        var self = this;
        var box = new lively.morphic.Box(lively.rect(0, 0, SEARCH_W, SEARCH_H));
        box.setFill(Color.white);
        // Pink border, matching the Comment/+ Postcard accent elsewhere in
        // this chrome — Color.rgb(...), not the raw COMMENT_ACCENT string,
        // per this file's own convention for applyStyle({borderColor}) vs.
        // a direct DOM-node style write (confirmed live: passing the plain
        // CSS string here threw "fill.toCSSString is not a function").
        box.applyStyle({ borderWidth: 3, borderColor: Color.rgb(232, 73, 126), borderRadius: 22 });   // COMMENT_ACCENT (#e8497e)

        // Material Symbols Rounded glyph instead of the old embedded raster
        // PNG — per CLAUDE.md's icon convention, this lets the glyph take
        // a real textColor (pink, matching the border) with no
        // image-tinting workaround, and enlarges cleanly via fontSize
        // rather than scaling a bitmap. Same icon idiom as
        // _buildClustersTitlePill's glyph: fixed-rect Text (so
        // align:'center' isn't a no-op — it's a hug-content no-op
        // otherwise), vertical centering via top padding, fontSize in pt
        // (px * 0.75), box baked into the constructor rect since it never
        // moves after this.
        var SEARCH_ICON_BOX = 30, SEARCH_ICON_PX = 24;
        var iconX = Math.round((42 - SEARCH_ICON_BOX) / 2);
        // -3: live-measured correction (getBoundingClientRect on the real
        // glyph vs. its box, per CLAUDE.md's icon-font baseline gotcha) —
        // naive centering left an 11px gap above the glyph vs. 4.7px below,
        // since the font's own line-height sits the glyph low in its box.
        var iconY = Math.round((SEARCH_H - SEARCH_ICON_BOX) / 2) - 3;
        var icon = new lively.morphic.Text(lively.rect(iconX, iconY, SEARCH_ICON_BOX, SEARCH_ICON_BOX));
        icon.textString = "search";
        icon.applyStyle({
          fontFamily: "'Material Symbols Rounded'",
          fontSize: SEARCH_ICON_PX * 0.75,
          textColor: Color.rgb(232, 73, 126),   // COMMENT_ACCENT (#e8497e)
          fill: null,
          borderWidth: 0,
          align: "center",
          padding: lively.Rectangle.inset(0, Math.round((SEARCH_ICON_BOX - SEARCH_ICON_PX) / 2), 0, 0),
          allowInput: false,
          selectable: false,
          clipMode: "hidden",
          whiteSpaceHandling: "pre",
        });
        box.addMorph(icon);

        var fieldRect = this._searchFieldRect(SEARCH_W);

        // Plain Text morphs have no native placeholder — a second, purely
        // decorative label sits behind the real field (added first, so the
        // field's own node renders after it in the same stacking context)
        // and is hidden the moment there's real text.
        var placeholder = lively.morphic.Text.makeLabel("Search c/" + this._displayName() + "…", {
          fontSize: 12, textColor: Color.rgb(170, 170, 170),
        });
        placeholder.setPosition(fieldRect.topLeft());
        placeholder.setExtent(fieldRect.extent());
        placeholder.eventsAreIgnored = true;
        box.addMorph(placeholder);
        this._searchPlaceholder = placeholder;

        var field = new lively.morphic.Text(fieldRect, "");
        field.applyStyle({ allowInput: true, fontSize: 12, fill: null, borderWidth: 0 });
        field.beInputLine();
        // Enter fires the search without losing the $super keydown chain
        // (undo/redo, selection, etc. all still work as they do on any
        // other Lively input-line field).
        var superKeyDown = field.onKeyDown;
        field.onKeyDown = function (evt) {
          if (evt.getKeyCode && evt.getKeyCode() === 13) {
            self.search(field.textString);
            evt.stop();
            return true;
          }
          var result = superKeyDown.call(this, evt);
          self._updateSearchPlaceholder();
          return result;
        };
        box.addMorph(field);
        this._searchField = field;

        return box;
      },

      // Called from _layout whenever the row's available width changes the
      // search box's own width (same "resize the box, then propagate the
      // new size to its fluid children" pattern _layout already uses for
      // quickInfoBox/frontCardBox/threadContainer/spacesBox) — keeps the
      // field and its placeholder filling the box instead of staying
      // pinned at whatever width the box was first built with.
      _applySearchWidth: function (w) {
        if (this._searchBox) this._searchBox.setExtent(lively.pt(w, SEARCH_H));
        var fr = this._searchFieldRect(w);
        if (this._searchField) this._searchField.setExtent(fr.extent());
        if (this._searchPlaceholder) this._searchPlaceholder.setExtent(fr.extent());
      },

      _updateSearchPlaceholder: function () {
        if (this._searchPlaceholder) this._searchPlaceholder.setVisible(!this._searchField.textString);
      },

      // The original PartsBin part's own convention — firing Go calls a
      // "search(queryString)" method on whatever contains the field —
      // just wired directly to this controller.
      search: function (queryString) {
        var q = (queryString || "").trim();
        this._fetchFeed(q || null);
      },
    },

    // ─── sort by (Stellar/Goosed rank the reel by ⭐/🪿 reaction count,
    // Hyphy by comment count, New is newest first) ─────────────────────────

    "sort by", {
      _buildSortByButton: function () {
        var self = this;
        var box = new lively.morphic.Box(lively.rect(0, 0, SORT_W, SORT_H));
        box.setFill(Color.white);
        box.applyStyle({ borderWidth: 1, borderColor: Color.rgb(232, 73, 126), borderRadius: 10 });   // COMMENT_ACCENT (#e8497e)

        var label = lively.morphic.Text.makeLabel(sortDisplay(this._sortSelection), {
          fontSize: 12, fontWeight: "bold", textColor: Color.rgb(30, 30, 30), fixedWidth: true, fixedHeight: true,
        });
        // Centered in the space left of the chevron. A Text morph pins its
        // glyphs to the top of its box, so the box is sized to one line
        // (18px glyph + 4px shapeNode padding) and centered by position.
        label.setPosition(lively.pt(6, (SORT_H - 22) / 2));
        label.setExtent(lively.pt(SORT_W - 34, 22));
        label.applyStyle({ borderWidth: 0, align: "center" });
        box.addMorph(label);
        this._sortByLabel = label;

        // fixedWidth/fixedHeight: true — left off here, this box's own
        // explicit 20px width got silently blown out to ~102-110px
        // (confirmed live) the same way the event card's labels did
        // earlier in this file: makeLabel defaults both to false, so
        // Lively's own deferred re-layout (Text#onRenderFinishedHTML's
        // `setPadding` call, fired once the morph is actually opened in
        // the world) recomputes the box size from `getTextExtent()` and
        // overwrites the explicit setExtent below. For an icon-font
        // ligature specifically that recompute is worse than the
        // already-bad general case: "expand_more" is 12 literal
        // characters, and if that recompute's DOM measurement gets pulled
        // before the ligature font substitution settles, it locks in a
        // ~12-character-wide box forever, spilling ~85-90px past the
        // button's own 110px width.
        var chevron = lively.morphic.Text.makeLabel("expand_more", {
          fontFamily: "'Material Symbols Rounded'", fontSize: 14, textColor: Color.rgb(90, 90, 90),
          fixedWidth: true, fixedHeight: true,
        });
        // -3: the icon font's glyph sits low in its line box, measured
        // live against the label's midline.
        chevron.setPosition(lively.pt(SORT_W - 26, (SORT_H - 22) / 2 - 3));
        chevron.setExtent(lively.pt(20, 22));
        chevron.applyStyle({ borderWidth: 0 });
        chevron.eventsAreIgnored = true;
        box.addMorph(chevron);

        box.onMouseDown = function () { self._toggleSortByDropdown(); };

        return box;
      },

      _toggleSortByDropdown: function () {
        if (this._sortByDropdown) return this._closeSortByDropdown();

        var self = this;
        var itemsH = SORT_OPTIONS.length * SORT_ITEM_H;
        var headerH = 26;
        // +4: bottom breathing room — the last row's own bottom edge landed
        // 1px past the dropdown box's bottom otherwise (confirmed live),
        // since headerH + itemsH alone accounts for exactly the rows'
        // stacked height with nothing left over for the box's own border.
        var dropdown = new lively.morphic.Box(lively.rect(0, 0, SORT_W, headerH + itemsH + 4));
        dropdown.setFill(Color.white);
        dropdown.applyStyle({ borderWidth: 1, borderColor: Color.rgb(232, 73, 126), borderRadius: 8 });   // COMMENT_ACCENT (#e8497e)

        var header = lively.morphic.Text.makeLabel("Sort by", {
          fontSize: 10, textColor: Color.rgb(140, 140, 140), fixedWidth: true, fixedHeight: true,
        });
        header.setPosition(lively.pt(12, 6));
        header.setExtent(lively.pt(SORT_W - 24, 16));
        header.applyStyle({ borderWidth: 0 });
        header.eventsAreIgnored = true;
        dropdown.addMorph(header);

        SORT_OPTIONS.forEach(function (option, i) {
          var isSelected = option === self._sortSelection;
          var row = lively.morphic.Text.makeLabel(sortDisplay(option), {
            fontSize: 12,
            fontWeight: isSelected ? "bold" : "normal",
            textColor: isSelected ? Color.rgb(20, 20, 20) : Color.rgb(90, 90, 90),
            fixedWidth: true, fixedHeight: true,
          });
          row.setPosition(lively.pt(12, headerH + i * SORT_ITEM_H));
          row.setExtent(lively.pt(SORT_W - 24, SORT_ITEM_H));
          row.applyStyle({ borderWidth: 0 });
          // makeLabel defaults eventsAreIgnored to true, which makes
          // onMouseDownEntry skip onMouseDown entirely (Events.js) — rows
          // have to opt back in to be clickable.
          row.eventsAreIgnored = false;
          row.onMouseDown = function () { self._selectSortOption(option); };
          dropdown.addMorph(row);
        });

        this._disableDragging(dropdown);
        $world.addMorph(dropdown);
        this._sortByDropdown = dropdown;
        this._layout();
      },

      _closeSortByDropdown: function () {
        if (!this._sortByDropdown) return;
        this._sortByDropdown.remove();
        this._sortByDropdown = null;
      },

      // Updates the button label, closes the dropdown, and re-fetches the
      // reel in the new order (keeping any active search).
      _selectSortOption: function (option) {
        var changed = option !== this._sortSelection;
        this._sortSelection = option;
        if (this._sortByLabel) this._sortByLabel.setTextString(sortDisplay(option));
        this._closeSortByDropdown();
        if (changed) this._fetchFeed(this._feedQuery);
      },
    },

    // ─── create postcard ────────────────────────────────────────────────────

    "create postcard", {
      // Built oversized, then _fitCreatePostcardButton (called once the box
      // is actually in the world) shrinks it to hug its real content —
      // same "measure the live-rendered text, don't guess" idiom as
      // ProfileCard.js's fitTextHeight, since a guessed padding number
      // reliably either clips or leaves slack (per CLAUDE.md's Text-morph
      // sizing gotcha).
      _buildCreatePostcardButton: function () {
        var self = this;
        var box = new lively.morphic.Box(lively.rect(0, 0, CREATE_BTN_W, CREATE_BTN_H));
        box.setFill(Color.rgb(232, 73, 126));   // COMMENT_ACCENT (#e8497e), matching the Comment button
        box.applyStyle({ borderWidth: 0, borderRadius: CREATE_BTN_H / 2 });

        // A single label ("+ Postcard", plain "+" character) rather than a
        // separate icon-font glyph next to a text label — two different
        // fonts (Material Symbols vs the label's own) don't share the same
        // baseline/vertical metrics, which read as misaligned next to each
        // other. One Text morph guarantees the "+" and "Postcard" sit on
        // exactly the same baseline, matching the reference image.
        var label = lively.morphic.Text.makeLabel("+ Postcard", {
          fontSize: 14, fontWeight: "700", textColor: Color.rgb(255, 255, 255),
        });
        label.setExtent(lively.pt(160, 20));
        label.applyStyle({ borderWidth: 0 });
        label.eventsAreIgnored = true;
        box.addMorph(label);
        this._createBtnLabel = label;

        // Compact fallback for when the full pill no longer fits the gap
        // (_layout's createBtnFits) — a bare "+" glyph, centered in the
        // circle via _fitCreatePostcardCircle (same measure-the-live-DOM
        // idiom as the pill label above, not a guessed position). Hidden
        // by default; _setCreateBtnCompact toggles which of the two shows.
        var plusLabel = lively.morphic.Text.makeLabel("+", {
          fontSize: 20, fontWeight: "700", textColor: Color.rgb(255, 255, 255),
        });
        plusLabel.setExtent(lively.pt(30, 26));
        plusLabel.applyStyle({ borderWidth: 0 });
        plusLabel.eventsAreIgnored = true;
        plusLabel.setVisible(false);
        box.addMorph(plusLabel);
        this._createBtnPlusLabel = plusLabel;
        this._createBtnCompact = false;

        box.onMouseDown = function () { self._openCreatePostcard(); };

        return box;
      },

      // Shrinks the button to hug its icon+label, both horizontally
      // (rounded pill matches the content instead of guessed padding) and
      // vertically (icon/label centered on the button's own height). Must
      // run after the box is in the world — reading the real rendered
      // glyph width needs a live render context.
      //
      // getTextExtent() turned out to just echo back whatever extent was
      // already set on the morph (the generous throwaway width from
      // _buildCreatePostcardButton), not the actual glyph width — same
      // "read the live DOM span, don't trust the model value" gotcha
      // CLAUDE.md documents for fontSize. Read the real leaf <span>'s
      // offsetWidth instead.
      _realTextWidth: function (textMorph) {
        var shapeNode = textMorph.renderContext().shapeNode;
        var span = shapeNode && shapeNode.querySelector("span");
        return span ? span.offsetWidth : textMorph.getTextExtent().x;
      },

      _fitCreatePostcardButton: function () {
        var box = this._createPostcardBtn, label = this._createBtnLabel;
        if (!box || !label) return;
        var PAD = 12, LINE_H = 20;
        // A Text morph's own shapeNode carries a fixed 4px padding on each
        // side (confirmed via computed style) that isn't part of the glyph
        // itself — setting extent to exactly the measured glyph width
        // clips it by 8px. TEXT_PAD compensates: the morph's box is grown
        // by 8 and shifted left by 4 so the visible glyph still starts
        // exactly at the intended x, with nothing clipped.
        var TEXT_PAD = 4;
        var labelW = this._realTextWidth(label);
        var boxW = Math.ceil(labelW + PAD * 2);

        label.setExtent(lively.pt(labelW + TEXT_PAD * 2, LINE_H));
        label.setPosition(lively.pt(PAD - TEXT_PAD, (CREATE_BTN_H - LINE_H) / 2));
        box.setExtent(lively.pt(boxW, CREATE_BTN_H));

        // Vertical centering correction: the shapeNode also carries its own
        // fixed top/bottom padding (separate from the horizontal one above)
        // that the position formula above doesn't account for — confirmed
        // live, the label rendered visibly high in the box even though the
        // math looked centered (9px above the glyph vs 4px below it).
        // Read the actual rendered gap above/below the glyph and nudge
        // until they match, rather than hardcoding a padding guess that'd
        // only hold for this exact font/size.
        var boxNode = box.renderContext().shapeNode;
        var labelSpan = label.renderContext().shapeNode.querySelector("span");
        if (boxNode && labelSpan) {
          var boxRect = boxNode.getBoundingClientRect();
          var spanRect = labelSpan.getBoundingClientRect();
          var topGap = spanRect.top - boxRect.top;
          var bottomGap = boxRect.bottom - spanRect.bottom;
          var correction = (topGap - bottomGap) / 2;
          if (Math.abs(correction) > 0.25) {
            label.setPosition(lively.pt(PAD - TEXT_PAD, label.getPosition().y - correction));
          }
        }

        this._createBtnW = boxW;   // read by _layout to keep the button's right edge anchored to the members column
        this._layout();
      },

      // Centers the compact "+" glyph inside the circle variant
      // (CREATE_BTN_CIRCLE_W square) — same "measure the live DOM, don't
      // guess" idiom as _fitCreatePostcardButton above, since a Text
      // morph's own shapeNode padding isn't symmetric and a guessed offset
      // reliably misses by a few px (CLAUDE.md). Horizontal centering uses
      // the fixed CREATE_BTN_CIRCLE_W, not the box's current (possibly
      // full-pill-width) extent, so this is safe to call once at build
      // time regardless of which mode the button starts in — the "+"
      // glyph itself never changes, so there's nothing to re-measure later.
      _fitCreatePostcardCircle: function () {
        var box = this._createPostcardBtn, label = this._createBtnPlusLabel;
        if (!box || !label) return;
        var LINE_H = 26;
        // Same fixed ~4px shapeNode left-padding compensation as
        // _fitCreatePostcardButton's TEXT_PAD above — without it the glyph
        // renders a few px right of center (confirmed live: 34px circle,
        // glyph measured ~3.8px off).
        var TEXT_PAD = 4;
        var labelW = this._realTextWidth(label);
        label.setExtent(lively.pt(labelW + TEXT_PAD * 2, LINE_H));
        var x = (CREATE_BTN_CIRCLE_W - labelW) / 2 - TEXT_PAD;
        label.setPosition(lively.pt(x, (CREATE_BTN_H - LINE_H) / 2));

        var boxNode = box.renderContext().shapeNode;
        var labelSpan = label.renderContext().shapeNode.querySelector("span");
        if (boxNode && labelSpan) {
          var boxRect = boxNode.getBoundingClientRect();
          var spanRect = labelSpan.getBoundingClientRect();
          var topGap = spanRect.top - boxRect.top;
          var bottomGap = boxRect.bottom - spanRect.bottom;
          var correction = (topGap - bottomGap) / 2;
          if (Math.abs(correction) > 0.25) {
            label.setPosition(lively.pt(label.getPosition().x, label.getPosition().y - correction));
          }
        }
      },

      // Toggles between the full "+ Postcard" pill and the compact "+"
      // circle (_layout decides which fits, via createBtnFits/
      // createBtnFitsCircle) — guarded so a resize tick that doesn't
      // actually change the mode skips the DOM churn.
      _setCreateBtnCompact: function (compact) {
        if (this._createBtnCompact === compact) return;
        this._createBtnCompact = compact;
        var box = this._createPostcardBtn;
        if (!box) return;
        box.setExtent(lively.pt(compact ? CREATE_BTN_CIRCLE_W : this._createBtnW, CREATE_BTN_H));
        this._createBtnLabel.setVisible(!compact);
        this._createBtnPlusLabel.setVisible(compact);
      },

      // Opens a new PostCardEditor compose window preset to post into this
      // constellation — same lazy-require + newCard(handle, opts) idiom
      // MenuBarEntry.js's "New postcard" entry already uses, with
      // opts.constellation carrying the target over.
      _openCreatePostcard: function () {
        var currentUser = lively.identity.did.currentUser();
        if (!currentUser) return;
        var opts = { constellation: this._name };
        lively.require("lively.identity.PostCardEditor").toRun(function () {
          lively.identity.PostCardEditor.newCard(currentUser.handle, opts);
        });
      },
    },

    // ─── spaces / rooms ─────────────────────────────────────────────────────

    "spaces", {
      // Clears and rebuilds the whole Spaces panel: header row ("Spaces"
      // title + "New Room" pill, top-right) followed by one card per
      // this._rooms entry, stacked top-down. Called once at chrome-build
      // time (before this._rooms is populated — see _fetchRooms) and
      // again every time _fetchRooms resolves (initial load, and after
      // create/join/leave/request-access, each of which re-fetches rather
      // than optimistically patching this._rooms, so the panel always
      // reflects the server's own view of room config + live presence).
      _renderSpaces: function () {
        var self = this;
        (this._spacesBox.submorphs || []).slice().forEach(function (m) { m.remove(); });

        // Reads the box's own live extent (same idiom _renderQuickInfo/
        // _renderMemberList already use), now that _layout() keeps it
        // current — including shrinking it on narrow windows — and
        // re-invokes this method after any resize that actually changes
        // it. Exception: this method's very first call (from _buildChrome,
        // before _layout has ever run) sees _spacesBox's (10,10)
        // construction placeholder, well below MIN_QUICK_INFO_W, so fall
        // back to the QUICK_INFO_W design width for that one call;
        // _layout() runs immediately afterward and resizes the box for
        // real.
        var boxW = this._spacesBox.getExtent().x;
        var w = boxW >= MIN_QUICK_INFO_W ? boxW : QUICK_INFO_W;
        var PAD = 14;

        var titlePill = this._buildClustersTitlePill(PAD, 13);
        this._spacesBox.addMorph(titlePill);
        this._fitClustersTitlePill(titlePill);

        var newRoomBtn = this._buildNewRoomButton();
        this._spacesBox.addMorph(newRoomBtn);
        // Controller-only (matches the server's own POST /c/:name/rooms
        // gate, isController not just canWrite/membership) — fixed here to
        // match once the real permission model was specified; this button
        // was originally built gated on _canWrite, before rooms had a
        // backend to define that requirement against.
        newRoomBtn.setVisible(!!this._isController);
        this._fitNewRoomButton(newRoomBtn, w, PAD);

        var TOP_ROW_H = 46;
        var y = TOP_ROW_H;
        if (!this._rooms.length) {
          var empty = lively.morphic.Text.makeLabel("No clusters yet.", { fontSize: 12, textColor: Color.gray });
          empty.setPosition(lively.pt(PAD, y));
          this._spacesBox.addMorph(empty);
        } else {
          // Fixed-width tiles wrapped into a grid (Discord-server-directory
          // style) rather than one card stretched to the panel's full
          // width — as many columns as fit the available content width,
          // wrapping to a new row (and advancing by the tallest card seen
          // in that row, since _renderRoomCard's own height varies with
          // how many type-icon chips/avatars/activity text it ends up
          // showing).
          var contentW = w - PAD * 2;
          var cols = Math.max(1, Math.floor((contentW + ROOM_CARD_GAP) / (ROOM_CARD_W + ROOM_CARD_GAP)));
          var col = 0, rowMaxH = 0;
          this._rooms.forEach(function (room) {
            var x = PAD + col * (ROOM_CARD_W + ROOM_CARD_GAP);
            var h = self._renderRoomCard(room, x, y, ROOM_CARD_W);
            rowMaxH = Math.max(rowMaxH, h);
            col++;
            if (col >= cols) {
              col = 0;
              y += rowMaxH + ROOM_CARD_GAP;
              rowMaxH = 0;
            }
          });
        }
      },

      // "Clusters" panel-title pill: a fixed-size star-cluster icon (position
      // baked into its own constructor rect, since it never moves) plus a
      // label Text sized to its own live-measured width (Box built oversized,
      // then shrunk — same idiom as _buildNewRoomButton just below).
      _buildClustersTitlePill: function (x, y) {
        var H = CLUSTERS_TITLE_PILL_H, ICON_BOX = CLUSTERS_TITLE_ICON_BOX;
        var box = new lively.morphic.Box(lively.rect(x, y, 130, H));
        box.setFill(ROOM_GREEN);
        box.applyStyle({ borderWidth: 0, borderRadius: H / 2 });
        noDrag(box);

        // Star-cluster SVG icon: fixed-rect Image sized to ICON_BOX (the SVG
        // scales to fit, no font/padding math needed).
        var icon = new lively.morphic.Image(
          lively.rect(CLUSTERS_TITLE_PAD, (H - ICON_BOX) / 2, ICON_BOX, ICON_BOX),
          CLUSTERS_STAR_ICON_URL);
        icon.applyStyle({ fill: null, borderWidth: 0 });
        noDrag(icon);
        icon.eventsAreIgnored = true;
        box.addMorph(icon);

        var label = lively.morphic.Text.makeLabel("Clusters", {
          fontSize: 13, fontWeight: "700", textColor: Color.rgb(255, 255, 255),
        });
        label.setExtent(lively.pt(140, 18));
        label.applyStyle({ borderWidth: 0 });
        noDrag(label);
        label.eventsAreIgnored = true;
        box.addMorph(label);
        box._clustersLabel = label;

        return box;
      },

      // Must run after the box is in the world (live-measured label width).
      // Only the label's extent/position and the box's own width change —
      // the box's x/y and the icon's rect were already final at construction.
      _fitClustersTitlePill: function (box) {
        var label = box._clustersLabel;
        if (!label) return;
        var H = CLUSTERS_TITLE_PILL_H, ICON_BOX = CLUSTERS_TITLE_ICON_BOX;
        var PAD = CLUSTERS_TITLE_PAD, GAP = CLUSTERS_TITLE_GAP;
        var LINE_H = 18, TEXT_PAD = 4;
        var labelX = PAD + ICON_BOX + GAP;
        var labelW = this._realTextWidth(label);
        var boxW = Math.ceil(labelX + labelW + PAD);

        label.setExtent(lively.pt(labelW + TEXT_PAD * 2, LINE_H));
        label.setPosition(lively.pt(labelX - TEXT_PAD, (H - LINE_H) / 2));
        box.setExtent(lively.pt(boxW, H));

        // Vertical centering correction — same "read the live gap
        // above/below the glyph, nudge by half the difference" idiom as
        // _fitNewRoomButton, since the shapeNode's own fixed top/bottom
        // padding isn't accounted for by the position formula above.
        var boxNode = box.renderContext().shapeNode;
        var labelSpan = label.renderContext().shapeNode.querySelector("span");
        if (boxNode && labelSpan) {
          var boxRect = boxNode.getBoundingClientRect();
          var spanRect = labelSpan.getBoundingClientRect();
          var topGap = spanRect.top - boxRect.top;
          var bottomGap = boxRect.bottom - spanRect.bottom;
          var correction = (topGap - bottomGap) / 2;
          if (Math.abs(correction) > 0.25) {
            label.setPosition(lively.pt(labelX - TEXT_PAD, label.getPosition().y - correction));
          }
        }
      },

      // Built oversized, then shrunk to hug its own label — same idiom as
      // _buildCreatePostcardButton/_fitCreatePostcardButton, reusing this
      // file's shared _realTextWidth helper rather than duplicating the
      // "measure the live-rendered span" logic a third time.
      _buildNewRoomButton: function () {
        var self = this;
        var box = new lively.morphic.Box(lively.rect(0, 0, 120, NEW_ROOM_BTN_H));
        box.setFill(ROOM_GREEN);
        box.applyStyle({ borderWidth: 0, borderRadius: NEW_ROOM_BTN_H / 2 });

        var label = lively.morphic.Text.makeLabel("New Cluster", {
          fontSize: 12.5, fontWeight: "700", textColor: Color.rgb(255, 255, 255),
        });
        label.setExtent(lively.pt(140, 18));
        label.applyStyle({ borderWidth: 0 });
        label.eventsAreIgnored = true;
        box.addMorph(label);
        box._newRoomLabel = label;

        box.onMouseDown = function () { self._openNewRoom(); };
        return box;
      },

      // panelW/pad let this be positioned flush against the panel's own
      // right edge (panelW - pad - boxW) rather than a hardcoded x, same
      // top-right-of-header placement _renderSpaces wants regardless of
      // how wide "+ New Room" ends up rendering.
      _fitNewRoomButton: function (box, panelW, pad) {
        var label = box._newRoomLabel;
        if (!label) return;
        var PAD = 12, LINE_H = 18, TEXT_PAD = 4;
        var labelW = this._realTextWidth(label);
        var boxW = Math.ceil(labelW + PAD * 2);

        label.setExtent(lively.pt(labelW + TEXT_PAD * 2, LINE_H));
        label.setPosition(lively.pt(PAD - TEXT_PAD, (NEW_ROOM_BTN_H - LINE_H) / 2));
        box.setExtent(lively.pt(boxW, NEW_ROOM_BTN_H));
        box.setPosition(lively.pt(panelW - pad - boxW, 12));

        // Vertical centering correction — same "read the live gap
        // above/below the glyph, nudge by half the difference" idiom as
        // _fitCreatePostcardButton, since the shapeNode's own fixed
        // top/bottom padding isn't accounted for by the position formula
        // above.
        var boxNode = box.renderContext().shapeNode;
        var labelSpan = label.renderContext().shapeNode.querySelector("span");
        if (boxNode && labelSpan) {
          var boxRect = boxNode.getBoundingClientRect();
          var spanRect = labelSpan.getBoundingClientRect();
          var topGap = spanRect.top - boxRect.top;
          var bottomGap = boxRect.bottom - spanRect.bottom;
          var correction = (topGap - bottomGap) / 2;
          if (Math.abs(correction) > 0.25) {
            label.setPosition(lively.pt(PAD - TEXT_PAD, label.getPosition().y - correction));
          }
        }
      },

      // Renders one room card at (x,y) with the given width, sizing its
      // own height to its content, and returns that height so
      // _renderSpaces can stack the next card below it. Layout: a tiny
      // flat-color banner across the top, the room name below it with the
      // camera/headset type icons right-aligned on the same row, and a
      // bottom row of overlapping participant avatars (same stacking
      // technique as _renderEventCard's attendee row) plus a "+N Others"
      // count and an activity tag.
      //
      // room.participants is a real array of participant DIDs (server-side
      // live presence, see RoomPresence.js), fed straight into the same
      // identiconDataUrl deterministic avatar generator every other avatar
      // in this file already uses. A status/join-affordance row below the
      // activity tag reflects this viewer's own relationship to the room
      // (see _roomStatusInfo) — that part IS viewer-specific, unlike the
      // rest of the card which renders identically for everyone.
      _renderRoomCard: function (room, x, y, w) {
        var self = this;
        var card = noDrag(new lively.morphic.Box(lively.rect(x, y, w, 10)));
        card.setFill(Color.white);
        card.applyStyle({ borderWidth: 2, borderColor: Color.rgb(232, 73, 126), borderRadius: 12, clipMode: "hidden" });   // COMMENT_ACCENT (#e8497e)
        this._spacesBox.addMorph(card);

        // A creator-set header image (RoomSettingsDialog.js) replaces the
        // generated quilt pattern when present -- lively.morphic.Image
        // renders through a real <img> node (HTML.js's setImageURLHTML),
        // so an animated GIF header keeps animating here, not just in the
        // dialog's own preview.
        var banner;
        if (room.headerUrl) {
          banner = noDrag(new lively.morphic.Image(lively.rect(0, 0, w, ROOM_BANNER_H)));
          banner.setImageURL(room.headerUrl);
          // Neutral fill shows through in any letterboxed gap left by the
          // objectFit write below (a native-size/aspect-mismatched image
          // won't fully cover the banner box).
          banner.applyStyle({ clipMode: "hidden", fill: Color.rgb(243, 243, 243) });
        } else {
          banner = noDrag(new lively.morphic.Box(lively.rect(0, 0, w, ROOM_BANNER_H)));
          lively.identity.quiltPatterns.applyQuiltBackground(banner, String(room.id));
        }
        banner.eventsAreIgnored = true;
        card.addMorph(banner);

        if (room.headerUrl) {
          // lively.morphic.Image has no aspect-ratio-preserving style --
          // setExtentHTML just sets the <img> node's raw width/height to
          // the banner box, stretching any image whose native size/aspect
          // doesn't match. object-fit isn't a Lively style property, so
          // it's written directly to the real <img> node (same DOM-bypass
          // idiom as CLAUDE.md's applyStyle-silently-not-reaching-DOM
          // section): 'scale-down' renders the image at its native size
          // when that already fits the box, and only scales DOWN (never
          // up) to fit when it doesn't -- "preserve original size unless
          // it doesn't fit," never an upscale or a non-uniform stretch.
          // Safe to query synchronously here: card (and therefore banner)
          // is already inside a live-rendering DOM tree, since
          // this._spacesBox was added to the world before _renderRoomCard
          // was ever called -- same reasoning nameM's own synchronous
          // shapeNode measurement a few lines below already relies on.
          var imgNode = banner.renderContext().shapeNode.querySelector("img");
          if (imgNode) imgNode.style.objectFit = "scale-down";
        }

        if (room.pinned) {
          var PIN = 20;
          var pinChip = noDrag(new lively.morphic.Box(lively.rect(w - 8 - PIN, 8, PIN, PIN)));
          pinChip.applyStyle({ fill: Color.rgba(255, 255, 255, 0.92), borderRadius: PIN / 2, borderWidth: 0 });
          pinChip.eventsAreIgnored = true;
          card.addMorph(pinChip);
          var pinGlyph = lively.morphic.Text.makeLabel("push_pin", { fontSize: 11, textColor: Color.rgb(90, 90, 90) });
          pinGlyph.applyStyle({ fontFamily: "'Material Symbols Rounded'", borderWidth: 0 });
          pinGlyph.eventsAreIgnored = true;
          pinGlyph.setExtent(lively.pt(16, 16));
          pinGlyph.setPosition(lively.pt(2, 2));
          pinChip.addMorph(pinGlyph);
        }

        var PAD = ROOM_CARD_PAD;
        var nameY = ROOM_BANNER_H + 10;

        var nameM = noDrag(lively.morphic.Text.makeLabel(room.name || "", {
          fontSize: 15, fontWeight: "bold", textColor: Color.rgb(20, 20, 20), fixedWidth: true, fixedHeight: true,
        }));
        nameM.eventsAreIgnored = true;
        nameM.setPosition(lively.pt(PAD, nameY));
        // 1px throwaway height so the min-height:calc(100%-4px) floor
        // documented in CLAUDE.md's Text-sizing section can't pin the
        // measurement — same idiom _renderEventCard's title measurement uses.
        nameM.setExtent(lively.pt(w - PAD * 2, 1));
        card.addMorph(nameM);
        var nameInner = nameM.renderContext().shapeNode.querySelector("div");
        var nameH = nameInner ? nameInner.offsetHeight : 18;
        var nameSpan = nameM.renderContext().shapeNode.querySelector("span");
        var nameW = nameSpan ? nameSpan.offsetWidth + 8 : 100;
        nameM.setExtent(lively.pt(nameW, nameH + 4));

        // Camera/headset/chat type icons — static indicators on the card
        // itself (the creator toggles these in the New Room dialog, not
        // here), right-aligned on the name's own row. Bare glyphs, no
        // circular chip background (removed for a cleaner look — was flat
        // grey clutter behind an icon that already reads fine on its own).
        // The chat glyph tints pink (COMMENT_ACCENT) for an ephemeral room,
        // so retention mode reads at a glance without opening settings —
        // see RoomSettingsDialog.js's Message Retention section.
        var ICON = 22, ICON_GAP = 6;
        var icons = [];
        if (room.isVideo) icons.push("videocam");
        if (room.isVoice) icons.push("headset");
        if (!room.isVideo && !room.isVoice) icons.push("chat");
        var totalIconsW = icons.length ? icons.length * ICON + (icons.length - 1) * ICON_GAP : 0;
        var ix = w - PAD - totalIconsW;
        icons.forEach(function (glyph) {
          var isEphemeralChat = glyph === "chat" && room.ephemeral;
          var g = noDrag(lively.morphic.Text.makeLabel(glyph, {
            fontSize: 12, textColor: isEphemeralChat ? Color.rgb(232, 73, 126) : Color.rgb(90, 90, 90),
          }));
          g.applyStyle({ fontFamily: "'Material Symbols Rounded'", borderWidth: 0 });
          g.eventsAreIgnored = true;
          g.setExtent(lively.pt(18, 16));
          g.setPosition(lively.pt(ix + 2, nameY + 3));
          card.addMorph(g);
          ix += ICON + ICON_GAP;
        });

        var rowY = nameY + Math.max(nameH + 4, icons.length ? ICON : 0) + 10;

        // Overlapping attendee avatars — same white-ring cutout technique
        // as _renderEventCard's attendee row.
        var AV = 24, OVERLAP = 8, RING = 2, MAX_SHOWN = 4;
        var all = room.participants || [];
        var totalCount = room.participantCount || all.length;
        var shown = all.slice(0, MAX_SHOWN);
        var ax = PAD;
        shown.forEach(function (seed) {
          var rs = AV + RING * 2;
          var ring = noDrag(new lively.morphic.Box(lively.rect(ax - RING, rowY - RING, rs, rs)));
          ring.applyStyle({ fill: Color.white, borderRadius: rs / 2, borderWidth: 0 });
          ring.eventsAreIgnored = true;
          card.addMorph(ring);
          var av = noDrag(new lively.morphic.Image(lively.rect(ax, rowY, AV, AV)));
          av.setImageURL(lively.identity.postCardUtils.identiconDataUrl(seed, AV));
          av.applyStyle({ borderRadius: AV / 2, borderWidth: 0, clipMode: "hidden" });
          av.eventsAreIgnored = true;
          card.addMorph(av);
          ax += AV - OVERLAP;
        });
        if (shown.length) ax += OVERLAP;

        // Both labels below measure their own real rendered height rather
        // than trust a guessed 16 — confirmed live (2026-08-24) that a
        // guessed 16 clips the descender of the "g" in "Jamming": the
        // shapeNode's real content height for 12px italic text is ~19px,
        // and the card's own clipMode:"hidden" cuts off the 4px overflow.
        // Same HEIGHT_PAD idiom (and the "measure at height:1 first, a
        // generous height acts as a floor" reasoning) CLAUDE.md documents
        // and _renderEventCard already applies to its own labels.
        var HEIGHT_PAD = 4;

        var extra = Math.max(0, totalCount - shown.length);
        var afterAvatarsX = ax + (shown.length ? 8 : 0);
        var countLabelW = 0, countLabelH = 16;
        if (extra > 0) {
          var countLbl = noDrag(lively.morphic.Text.makeLabel("+" + extra + " Others", {
            fontSize: 12, fontWeight: "700", textColor: Color.rgb(40, 40, 40), fixedWidth: true, fixedHeight: true,
          }));
          countLbl.eventsAreIgnored = true;
          countLbl.setPosition(lively.pt(afterAvatarsX, rowY + 5));
          countLbl.setExtent(lively.pt(Math.max(30, w - afterAvatarsX), 1));
          card.addMorph(countLbl);
          var countInner = countLbl.renderContext().shapeNode.querySelector("div");
          var countSpan = countLbl.renderContext().shapeNode.querySelector("span");
          countLabelW = countSpan ? countSpan.offsetWidth : 60;
          countLabelH = countInner ? countInner.offsetHeight + HEIGHT_PAD : 16;
          countLbl.setExtent(lively.pt(countLabelW + 8, countLabelH));
        }

        var afterCountX = afterAvatarsX + (extra > 0 ? countLabelW + 16 : 0);
        if (room.activity) {
          var actLbl = noDrag(lively.morphic.Text.makeLabel("· " + room.activity, {
            fontSize: 12, textColor: Color.rgb(140, 140, 140), fixedWidth: true, fixedHeight: true,
          }));
          actLbl.applyStyle({ fontStyle: "italic" });
          actLbl.eventsAreIgnored = true;
          actLbl.setPosition(lively.pt(afterCountX, rowY + 5));
          actLbl.setExtent(lively.pt(Math.max(30, w - afterCountX - PAD), 1));
          card.addMorph(actLbl);
          var actInner = actLbl.renderContext().shapeNode.querySelector("div");
          var actSpan = actLbl.renderContext().shapeNode.querySelector("span");
          var actLabelW = actSpan ? actSpan.offsetWidth : Math.max(30, w - afterCountX - PAD);
          var actLabelH = actInner ? actInner.offsetHeight + HEIGHT_PAD : 16;
          actLbl.setExtent(lively.pt(actLabelW + 8, actLabelH));
        }

        // Status/join-affordance row — this viewer's relationship to the
        // room (open/gated x not-a-member/unjoined/pending/approved/
        // joined). Purely an affordance: the click handler re-derives
        // permission server-side (canJoinRoom) before actually joining, so
        // a stale label here can't grant access it shouldn't. An
        // "approved" gated room additionally gets a green check-circle
        // icon ahead of the "Join" text (two Text morphs, same
        // icon-then-label idiom as the room-type chips above — accepted
        // baseline mismatch per CLAUDE.md, there's enough visual
        // separation here too).
        var statusY = rowY + AV + 8;
        var statusInfo = this._roomStatusInfo(room);
        var textX = PAD;
        if (statusInfo.icon) {
          var statusIcon = lively.morphic.Text.makeLabel(statusInfo.icon, { fontSize: 12, textColor: statusInfo.color });
          statusIcon.applyStyle({ fontFamily: "'Material Symbols Rounded'", borderWidth: 0 });
          statusIcon.eventsAreIgnored = true;
          statusIcon.setExtent(lively.pt(16, 16));
          statusIcon.setPosition(lively.pt(PAD, statusY));
          card.addMorph(statusIcon);
          textX = PAD + 18;
        }
        var statusLbl = noDrag(lively.morphic.Text.makeLabel(statusInfo.text, {
          fontSize: 11.5, fontWeight: "700", textColor: statusInfo.color, fixedWidth: true, fixedHeight: true,
        }));
        statusLbl.eventsAreIgnored = true;
        statusLbl.setPosition(lively.pt(textX, statusY));
        // Generous throwaway width so it doesn't wrap while measuring
        // (same hug idiom as nameM/countLbl/actLbl above) -- re-hugged to
        // its own measured span width below (not just height) so it stays
        // clear of the gear button that now shares this same row, rather
        // than a box stretching the full remaining card width underneath it.
        statusLbl.setExtent(lively.pt(w - PAD - textX, 1));
        card.addMorph(statusLbl);
        var statusInner = statusLbl.renderContext().shapeNode.querySelector("div");
        var statusSpan = statusLbl.renderContext().shapeNode.querySelector("span");
        var statusH = statusInner ? statusInner.offsetHeight + HEIGHT_PAD : 16;
        var statusW = statusSpan ? statusSpan.offsetWidth + 8 : (w - PAD - textX);
        statusLbl.setExtent(lively.pt(statusW, statusH));

        // Settings gear -- creator-or-controller only (room.canManage,
        // computed server-side -- see canManageRoom in IdentityServer.js).
        // Shares the status row (right-aligned) instead of reserving its
        // own strip below it -- hug-fitting statusLbl's width above keeps
        // the label clear of the gear's own space on the right, and the
        // gear is vertically centered against the status label's line
        // rather than pinned to the card's bottom edge.
        var GEAR = 26, GEAR_GLYPH_PX = 18;
        var rowH = Math.max(statusH, room.canManage ? GEAR : 0);
        var cardH = statusY + rowH + PAD;
        card.setExtent(lively.pt(w, cardH));

        if (room.canManage) {
          var gearY = statusY + Math.round((statusH - GEAR) / 2);
          var gearBtn = new lively.morphic.Text(lively.rect(w - PAD - GEAR, gearY, GEAR, GEAR));
          gearBtn.textString = "settings";
          gearBtn.applyStyle({
            fontFamily: "'Material Symbols Rounded'",
            fontSize: GEAR_GLYPH_PX * 0.75,
            textColor: Color.rgb(90, 90, 90),
            fill: Color.rgba(255, 255, 255, 0.92),
            borderRadius: GEAR / 2,
            borderWidth: 1,
            borderColor: Color.rgb(224, 224, 224),
            align: "center",
            padding: lively.Rectangle.inset(0, Math.round((GEAR - GEAR_GLYPH_PX) / 2), 0, 0),
            allowInput: false,
            selectable: false,
            clipMode: "hidden",
            whiteSpaceHandling: "pre",
            handStyle: "pointer",
          });
          noDrag(gearBtn);
          // Marker the card's own onMouseDown hit-tests for below -- see
          // the capture-phase comment on card.onMouseDown.
          gearBtn._isRoomSettingsGear = true;
          gearBtn.toolTip = "Cluster settings";
          gearBtn.onMouseOver = function () { gearBtn.applyStyle({ fill: Color.rgb(238, 238, 238) }); };
          gearBtn.onMouseOut = function () { gearBtn.applyStyle({ fill: Color.rgba(255, 255, 255, 0.92) }); };
          gearBtn.onMouseUp = function (evt) {
            self._openRoomSettings(room);
            evt.stop();
            return true;
          };
          card.addMorph(gearBtn);
        }

        if (statusInfo.clickable) {
          // Mouse dispatch is capture-first (ancestor before nested
          // child, see CLAUDE.md) -- without this hit-test, a mousedown
          // squarely on the gear button above would still fire the
          // card's own onMouseDown FIRST and navigate into the room
          // before the gear's onMouseUp ever runs. Bail out (without
          // calling evt.stop()) when the click landed on the gear, so
          // capture keeps walking down to its own handler instead.
          card.onMouseDown = function (evt) {
            var localPt = card.localize(evt.getPosition());
            var hitGear = card.submorphs.some(function (m) {
              return m._isRoomSettingsGear && m.bounds().containsPoint(localPt);
            });
            if (hitGear) return;
            self._onRoomCardClick(room);
          };
          card.renderContext().shapeNode.style.cursor = "pointer";
        }
        return cardH;
      },

      // Viewer-specific label/color/clickability for a room card's bottom
      // status row — see _renderRoomCard. Not a member: no affordance at
      // all. Open room: click to join/leave. Gated ('request') room: walks
      // through unrequested -> pending -> approved -> joined, with a
      // declined request shown as re-requestable rather than a dead end.
      _roomStatusInfo: function (room) {
        var GREY = Color.rgb(150, 150, 150), MUTED_RED = Color.rgb(180, 90, 90);
        if (!this._amMember) {
          return this._signedIn
            ? { text: "Membership required", color: GREY, clickable: false }
            : { text: "Sign in required", color: GREY, clickable: false };
        }
        if (this._isActiveRoom(room)) return { text: "Open", color: ROOM_GREEN, clickable: true };
        if (room.iJoined) return { text: "Drift", color: ROOM_ACCENT, clickable: true };
        if (room.access !== "request") return { text: "Join", color: ROOM_GREEN, clickable: true };
        if (room.myAccessStatus === "approved") return { text: "Join", color: ROOM_GREEN, clickable: true, icon: "check_circle" };
        if (room.myAccessStatus === "pending") return { text: "Request pending…", color: GREY, clickable: false };
        if (room.myAccessStatus === "declined") return { text: "Declined — click to re-request", color: MUTED_RED, clickable: true };
        return { text: "Request to join", color: ROOM_ACCENT, clickable: true };
      },

      // ─── fetching + actions ─────────────────────────────────────────────────

      // Same XHR idiom as _fetchFeed. Re-fetches (rather than optimistic
      // local patching) after every create/join/leave/request-access
      // action below, so the panel always reflects the server's own view
      // of room config + live presence rather than a client-guessed delta.
      _fetchRooms: function () {
        var self = this;
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("GET", base + "/c/" + encodeURIComponent(this._name) + "/rooms", true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) return self._showError("Failed to load clusters (" + xhr.status + ")");
          var data;
          try { data = JSON.parse(xhr.responseText); } catch (e) { return; }
          // Polled (see _startRoomsPoll), so an unchanged answer must not
          // rebuild the panel: _renderSpaces wipes and re-adds every card,
          // which would reset the panel's scroll position and drop a hover or
          // in-progress click every few seconds for nothing.
          var sig = JSON.stringify([data.rooms || [], !!data.amMember, !!data.signedIn]);
          if (sig === self._roomsSig) return;
          self._roomsSig = sig;
          self._rooms = data.rooms || [];
          self._amMember = !!data.amMember;
          self._signedIn = !!data.signedIn;
          // A real change still rebuilds, so keep the scroll position across it.
          var node = self._spacesBox && self._spacesBox.renderContext().shapeNode;
          var savedScrollTop = node ? node.scrollTop : 0;
          self._renderSpaces();
          if (node) node.scrollTop = savedScrollTop;
        };
        xhr.onerror = function () { self._showError("Network error loading clusters"); };
        xhr.send();
      },

      // Who's in each room changes on the server with no notice to a client
      // that isn't in the call (measured live: an idle lounge made no request
      // for over a minute while people joined and left, so its counts only
      // moved on a reload or the viewer's own action). Poll the same
      // GET /c/:name/rooms instead, only while the tab is visible, and only
      // re-render when the answer actually changed (see _fetchRooms). A server
      // push over the sync socket would make this instant; this is the
      // client-only stand-in.
      _startRoomsPoll: function () {
        var self = this;
        if (this._roomsPollTimer) return;
        this._roomsPollTimer = setInterval(function () {
          if (typeof document !== "undefined" && document.hidden) return;
          self._fetchRooms();
        }, ROOMS_POLL_MS);
      },

      // Card-click router — dispatches to the one applicable action for
      // this viewer/room combination. A "pending" gated request has no
      // clickable status (see _roomStatusInfo), so it never reaches here.
      // "Entering" a room (open access, or an approved gated request) opens
      // the real Discord-like room view (RoomView.js) as a standalone window
      // in this same world — the call keeps running if that window is
      // minimized or closed, and the Ambient Presence Panel controls it.
      // The session does its own presence-join. If this world already holds
      // the session for the clicked room, the click just brings its window
      // forward; leaving happens from the room itself or the panel. A card
      // marked joined by some OTHER session (another tab/device) still leaves
      // inline, since there's no window here to go back to.
      _onRoomCardClick: function (room) {
        if (!this._amMember) return;
        if (this._isActiveRoom(room)) return this._enterRoom(room);
        if (room.iJoined) return this._leaveRoom(room);
        if (room.access === "open") return this._enterRoom(room);
        if (room.myAccessStatus === "approved") return this._enterRoom(room);
        return this._requestRoomAccess(room);
      },

      _isActiveRoom: function (room) {
        var RV = lively.identity.RoomView;
        return !!(RV && RV.isActiveRoom && RV.isActiveRoom(room.id));
      },

      _enterRoom: function (room) {
        var self = this;
        lively.require("lively.identity.RoomView").toRun(function () {
          // One-time: keep the Spaces panel's headcounts / Enter-vs-Open state
          // fresh as the session joins and leaves (it can also end from the
          // room window or the Ambient Presence Panel, not just from here).
          if (!self._roomSessionListener) {
            self._roomSessionListener = function () { self._fetchRooms(); };
            lively.identity.RoomView.addListener(self._roomSessionListener);
          }
          lively.identity.RoomView.open(self._name, room.id);
        });
      },

      _leaveRoom: function (room) {
        var self = this;
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("DELETE", base + "/c/" + encodeURIComponent(this._name) + "/rooms/" + room.id + "/presence", true);
        xhr.withCredentials = true;
        xhr.onload = function () {
          self._fetchRooms();
        };
        xhr.onerror = function () {};
        xhr.send();
      },

      // Identical flow to _requestJoin (constellation-level "Join…" menu
      // entry) — a real, client-signed postcard riding the same postal
      // rail, never server-fabricated. Delivers to every controller's
      // inbox server-side (POST /c/:name/rooms/:roomId/join-requests) the
      // same way constellation join requests do; there's no in-app
      // Approve/Decline UI for this yet (that lands with the room-detail
      // view planned for later), so for now the controller just sees a
      // plain postcard notification in their mailbox.
      _requestRoomAccess: function (room) {
        var self = this;
        var user = lively.identity.did.currentUser();
        if (!user) return this._showError("Not signed in.");

        lively.require("lively.identity.PostCardSerializer").toRun(function () {
          var doc = {
            type: "doc",
            content: [{
              type: "paragraph",
              content: [{ type: "text", text: "@" + lively.identity.did.displayHandle() + " wants to join the \"" + room.name + "\" cluster in c/" + self._name + "." }],
            }],
          };
          lively.identity.postCardSerializer.serializePlainToEnvelope({
            doc: doc,
            title: "Cluster join request: " + room.name + " (c/" + self._name + ")",
            titleExplicit: true,
            constellation: self._name,
            visibility: "public",
            stateMeta: { kind: "room-join-request", roomId: room.id, roomName: room.name },
          }, function (err, envelope) {
            if (err) return self._showError("Could not create join request: " + err.message);

            var base = lively.identity.did.baseUrl();
            var putXhr = new XMLHttpRequest();
            putXhr.open("PUT", base + "/@" + encodeURIComponent(user.handle) + "/" + encodeURIComponent(envelope.objId), true);
            putXhr.withCredentials = true;
            putXhr.setRequestHeader("Content-Type", "application/json");
            putXhr.onload = function () {
              if (putXhr.status !== 200) return self._showError("Could not save join request card (" + putXhr.status + ")");

              var postXhr = new XMLHttpRequest();
              postXhr.open("POST", base + "/c/" + encodeURIComponent(self._name) + "/rooms/" + room.id + "/join-requests", true);
              postXhr.withCredentials = true;
              postXhr.setRequestHeader("Content-Type", "application/json");
              postXhr.onload = function () {
                if (postXhr.status !== 201) {
                  var msg = "Cluster join request failed (" + postXhr.status + ")";
                  try { var b = JSON.parse(postXhr.responseText); if (b.error) msg = b.error; } catch (e) {}
                  return self._showError(msg);
                }
                self._fetchRooms();
              };
              postXhr.onerror = function () { self._showError("Network error sending cluster join request"); };
              postXhr.send(JSON.stringify({ objId: envelope.objId }));
            };
            putXhr.onerror = function () { self._showError("Network error saving join request card"); };
            putXhr.send(JSON.stringify(envelope));
          });
        });
      },

      // Lazy-require + world-tracked-singleton open, same idiom
      // _openCreatePostcard already uses for PostCardEditor. onCreate
      // POSTs to the real /c/:name/rooms route (controller-only — the
      // button that opens this dialog is itself already _canWrite-gated
      // in _renderSpaces, but the server re-checks isController
      // independently) and re-fetches on success rather than
      // optimistically inserting the dialog's own fields, so the room
      // gets its real server-assigned id before the card can be clicked.
      //
      // fields.e2eeEnabled (e2eeclusters.md §3/§9): the room is born with
      // e2ee_rotation_pending already set (no epoch minted yet — the
      // server's own createRoom comment), so a successful creation here
      // must mint epoch 1 right away, before _fetchRooms even runs —
      // otherwise the room sits permanently "pending" (sending blocked)
      // until someone happens to open RoomView's settings and click
      // Retry. Minting failure is non-fatal to the creation itself (the
      // room still exists, just stuck pending — same recoverable state a
      // later membership-change rotation failure leaves it in) and is
      // surfaced the same way a creation failure is: _showError.
      _openNewRoom: function () {
        var self = this;
        var opts = {
          scope: { constellation: this._name },
          onCreate: function (fields) {
            var base = lively.identity.did.baseUrl();
            var xhr = new XMLHttpRequest();
            xhr.open("POST", base + "/c/" + encodeURIComponent(self._name) + "/rooms", true);
            xhr.withCredentials = true;
            xhr.setRequestHeader("Content-Type", "application/json");
            xhr.onload = function () {
              if (xhr.status !== 201) {
                var msg = "Could not create cluster (" + xhr.status + ")";
                try { var b = JSON.parse(xhr.responseText); if (b.error) msg = b.error; } catch (e) {}
                return self._showError(msg);
              }
              if (!fields.e2eeEnabled) return self._fetchRooms();
              var data;
              try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; }
              var roomId = data && data.room && data.room.id;
              if (!roomId) { self._fetchRooms(); return; }
              lively.require("lively.identity.RoomCrypto").toRun(function () {
                lively.identity.roomCrypto.mintInitialEpoch({
                  constellationName: self._name, roomId: roomId,
                }, function (mintErr) {
                  if (mintErr) {
                    self._showError("Cluster created, but setting up encryption failed: " + mintErr.message +
                      " — open the cluster's settings to retry.");
                  }
                  self._fetchRooms();
                });
              });
            };
            xhr.onerror = function () { self._showError("Network error creating cluster"); };
            xhr.send(JSON.stringify(fields));
          },
        };
        lively.require("lively.identity.NewRoomDialog").toRun(function () {
          lively.identity.NewRoomDialog.open(opts);
        });
      },

      // Opens the per-room settings dialog (rename/header image/access/
      // pin/archive/delete) -- reached from the gear button rendered on a
      // room card in _renderRoomCard (room.canManage-gated) or from
      // RoomView.js's own header gear. Re-fetches the room list on save
      // (and on archive/delete) rather than optimistically patching
      // this._rooms, same "reflect the server's own view" discipline
      // _fetchRooms' own header comment describes.
      _openRoomSettings: function (room) {
        var self = this;
        lively.require("lively.identity.RoomSettingsDialog").toRun(function () {
          lively.identity.RoomSettingsDialog.open(self._name, room, function () {
            self._fetchRooms();
          });
        });
      },
    },

    // ─── quick info ──────────────────────────────────────────────────────────

    "quick info", {
      _renderQuickInfo: function () {
        var self = this;
        // Map mode: the panel is filled by the constellation map instead of
        // the normal contents. A re-render while it's already showing (a
        // window resize) just re-fits the live map — rebuilding it would
        // refetch every pin.
        if (this._mapMode) {
          var liveMap = this._quickInfoMap;
          var mapH = this._quickInfoBox.getExtent().y;
          if (liveMap && liveMap.owner === this._quickInfoBox) {
            liveMap.fitTo(this._quickInfoVisibleW(), mapH);
            return;
          }
          return this._renderQuickInfoMap(mapH);
        }
        (this._quickInfoBox.submorphs || []).slice().forEach(function (m) { m.remove(); });
        var qi = this._quickInfo || {};
        var w = this._quickInfoBox.getExtent().x;
        var h = this._quickInfoBox.getExtent().y;

        // Banner + avatar, same layout idiom as ProfileCard.js's read view
        // (a full-width banner strip, a circular avatar straddling its
        // bottom-left corner in a white "ring") scaled down for this much
        // shorter panel. Uses the real uploaded bannerUrl/avatarUrl once a
        // controller has set one via the settings gear below; falls back to
        // the permanent quilt-pattern banner / deterministic identicon
        // (same seeded-pick treatment as ProfileCard.js's own "no
        // bannerUrl" fallback), both seeded off this constellation's own
        // name, exactly like every member/comment avatar elsewhere in this
        // file already is off a DID.
        var BANNER_H = 130, AVATAR = 64, RING = 3;
        var banner = new lively.morphic.Box(lively.rect(0, 0, w, BANNER_H));
        if (qi.bannerUrl) {
          banner = new lively.morphic.Image(lively.rect(0, 0, w, BANNER_H));
          banner.setImageURL(qi.bannerUrl);
          banner.applyStyle({ borderWidth: 0, clipMode: "hidden" });
        } else {
          lively.identity.quiltPatterns.applyQuiltBackground(banner, "c/" + this._name);
        }
        this._quickInfoBox.addMorph(banner);

        var avX = 20, avY = BANNER_H - Math.floor(AVATAR / 2);
        var RS = AVATAR + RING * 2;
        var avRing = new lively.morphic.Box(lively.rect(avX - RING, avY - RING, RS, RS));
        avRing.applyStyle({ fill: Color.white, borderRadius: RS / 2, borderWidth: 0 });
        this._quickInfoBox.addMorph(avRing);

        var avatar = new lively.morphic.Image(lively.rect(avX, avY, AVATAR, AVATAR));
        avatar.setImageURL(qi.avatarUrl || lively.identity.postCardUtils.identiconDataUrl("c/" + this._name, AVATAR));
        avatar.applyStyle({ borderRadius: AVATAR / 2, borderWidth: 0, clipMode: "hidden" });
        this._quickInfoBox.addMorph(avatar);

        // Same measure-then-hug treatment as every other label in this
        // panel (event card title/date/location, "+N Others", the detail
        // lines below) — previously left at a fixed 22px height and a
        // fixed w - avX*2 (~934px) width regardless of the actual text,
        // which is the exact box-exceeds-visible-bounds pattern already
        // fixed elsewhere in this file (confirmed live via halo-select:
        // the title's own box ran most of the way across the panel no
        // matter how short the constellation name was) and the exact
        // fixed-height-clips-descenders pattern too (a constellation name
        // with a "y"/"g"/"p"/"q" would clip the same way "People" did).
        // Height is measured with the box at 1px first — a generous
        // throwaway height would hit the min-height-floor trap the event
        // title already ran into (CLAUDE.md's Text-morph note) — then
        // padded back by 4 for the shapeNode's own top/bottom padding.
        var title = lively.morphic.Text.makeLabel("c/" + this._displayName(),
          { fontSize: 16, fontWeight: "bold", fixedWidth: true, fixedHeight: true });
        var titleY = avY + AVATAR + 10;
        title.setPosition(lively.pt(avX, titleY));
        title.setExtent(lively.pt(w - avX * 2, 1));
        this._quickInfoBox.addMorph(title);
        var titleInner = title.renderContext().shapeNode.querySelector("div");
        var titleSpan = title.renderContext().shapeNode.querySelector("span");
        var titleH = (titleInner ? titleInner.offsetHeight : 20) + 4;
        var titleTextW = titleSpan ? titleSpan.offsetWidth : 120;
        title.setExtent(lively.pt(titleTextW + 8, titleH));

        // cardX derived from the *widest* of the title and the two detail
        // lines below it (visibility/members, created/creator) — all real
        // measured DOM widths, not any of these labels' own nominal box
        // extent, which spans nearly the panel's full width regardless of
        // actual text — plus a gutter, rather than a flat fraction of
        // visibleW. A flat 42% split was tried first and reliably cleared
        // the title, but left too little room on the card's side for the
        // date/time line to avoid clipping (confirmed live: the full
        // "Weekday, Month D, YYYY at H AM/PM +NN" format needs ~307px,
        // more than a 42% split ever left available at a typical
        // 1440px-wide viewport). Using only the *title's* width (an
        // earlier version of this) was a second live-corrected mistake:
        // the title is often shorter than "Created 8/4/2026 by @handle"
        // below it, so the card started too close and forced the detail
        // lines to wrap even at a wide 1920px browser window, not just a
        // narrow one — measuring all three left-column lines up front
        // avoids that regardless of which one happens to be longest.
        // Falls back to a fixed floor if measurement fails for any reason.
        var titleRight = avX + titleTextW;

        // QUICK_INFO_W is wider than what's actually visible before the
        // members column starts, at typical viewport widths — harmless
        // while that space stayed blank, but an opaque card there would
        // render partly hidden underneath the members panel (confirmed
        // live: the card's right portion disappeared behind it). Use the
        // real gap from this._geom instead of the panel's nominal width
        // for the card's bounds specifically. Computed here (rather than
        // down by the event card call, where it used to live) because
        // EVENT_CARD_X's own clamp just below needs it too.
        var visibleW = (this._geom && typeof this._geom.membersX === "number")
          ? Math.max(200, this._geom.membersX - GUTTER - this._geom.quickInfoX)
          : w;

        var creatorHandle = qi.memberHandles && qi.createdBy ? qi.memberHandles[qi.createdBy] : null;
        var lines = [
          (qi.visibility || "public") + " · " + (qi.memberCount || 0) +
            " member" + (qi.memberCount === 1 ? "" : "s"),
          "Created " + this._formatDate(qi.createdAt) + (creatorHandle ? (" by @" + creatorHandle) : ""),
        ];
        // Throwaway single-line probes (removed immediately after
        // measuring, same idiom as the "+N Others" label's own width
        // probe in _renderEventCard) just to learn each detail line's
        // natural width before EVENT_CARD_X is finalized.
        var detailRight = titleRight;
        lines.forEach(function (str) {
          var probe = lively.morphic.Text.makeLabel(str, { fontSize: 12 });
          probe.setPosition(lively.pt(-9999, -9999));
          probe.setExtent(lively.pt(600, 18));
          self._quickInfoBox.addMorph(probe);
          var probeSpan = probe.renderContext().shapeNode.querySelector("span");
          if (probeSpan) detailRight = Math.max(detailRight, avX + probeSpan.offsetWidth);
          probe.remove();
        });
        // Clamped at the high end so a long "Created ... by @handle" line
        // can't push EVENT_CARD_X so far right that the event card has no
        // room left at all — confirmed live at a 1280px browser width: an
        // unclamped EVENT_CARD_X of 276 left only 26px of visibleW for the
        // card, under its own 160px legibility floor, so it silently
        // didn't render at all (neither the populated nor the empty-state
        // card). MIN_CARD_W matches _renderEventCard's/_renderEmptyEventCard's
        // own "< 160" bail floor exactly (not their separate, higher
        // Math.max(220,...) *preferred*-width term) so this clamp reserves
        // only as much as the card actually needs to stay legible, not
        // more — a MIN_CARD_W of 220 previously over-reserved by 60px,
        // which came straight out of detailW below and collapsed the left
        // column to ~104px at ordinary (~1338px) browser widths. Below this
        // width the detail lines fall back to wrapping (already handled
        // below) rather than the event card losing its slot entirely.
        //
        // The high-end cap is itself clamped back up to a titleClearX floor
        // (avatar clearance *and* the title's own real width — a second
        // live-corrected mistake in this same pass: the outer Math.max
        // originally only had avX+AVATAR+24, which clears the avatar circle
        // but says nothing about the title text itself, which is often
        // wider than the avatar; at a narrow enough visibleW the cap fell
        // below titleRight too, pulling the card's left edge over the
        // title's own text — confirmed live, "c/wikitest" partially hidden
        // under the card's left border). Below titleClearX the card is
        // never allowed to start, even if that leaves it a tight (but
        // valid, >= 160px) width rather than the full MIN_CARD_W.
        var MIN_CARD_W = 160, CARD_RIGHT_MARGIN = 28;
        var titleClearX = Math.max(avX + AVATAR + 24, titleRight + 24);
        var EVENT_CARD_X = Math.max(
          titleClearX,
          Math.min(detailRight + 24, visibleW - CARD_RIGHT_MARGIN - MIN_CARD_W)
        );

        // Stacked directly under the constellation name, same left edge as
        // the avatar/title (avX) — previously anchored to the panel's own
        // bottom-left corner instead, which orphaned these details far
        // from the title they actually describe and left this whole left
        // column empty below the title. Width capped at EVENT_CARD_X (now
        // guaranteed wide enough for these exact lines, per the probe
        // above) so a long visibility/member-count line can't run
        // underneath the event card sitting to its right. Wrapping is kept
        // as a fallback regardless (whiteSpaceHandling:"normal" +
        // measure-real-height, same idiom as the event title) for the
        // rare case a member count or handle changes between this probe
        // and render — cheap insurance, not the primary mechanism.
        var DETAIL_GAP = 8;
        var detailY = titleY + titleH + DETAIL_GAP;
        var detailW = Math.max(100, EVENT_CARD_X - avX - 16);
        lines.forEach(function (str, i) {
          // The "Created ... by @handle" line gets split into two morphs
          // (plain prefix + clickable pink handle) so just the handle can
          // become a link — everything else about this line's layout
          // (detailW/EVENT_CARD_X, computed above from the combined
          // string's probed width) stays untouched, since prefix+handle's
          // combined rendered width can't exceed what was already probed.
          if (i === 1 && creatorHandle) {
            var prefix = "Created " + self._formatDate(qi.createdAt) + " by ";
            var prefixT = lively.morphic.Text.makeLabel(prefix,
              { fontSize: 12, textColor: Color.rgb(102, 102, 102), whiteSpaceHandling: "normal", fixedWidth: true, fixedHeight: true });
            prefixT.setPosition(lively.pt(avX, detailY));
            prefixT.setExtent(lively.pt(detailW, 1));
            self._quickInfoBox.addMorph(prefixT);
            var prefixInner = prefixT.renderContext().shapeNode.querySelector("div");
            var prefixSpan  = prefixT.renderContext().shapeNode.querySelector("span");
            var lineH = (prefixInner ? prefixInner.offsetHeight : 14) + 4; // +4: shapeNode's own 2px-top/2px-bottom padding, see CLAUDE.md
            var prefixW = prefixSpan ? prefixSpan.offsetWidth : Math.round(detailW * 0.6);
            // +8, not +2: the shapeNode's own ~8px combined left/right
            // padding (CLAUDE.md's Text-sizing gotcha, the same "+8"
            // compensation used everywhere else in this file — e.g. the
            // title and "+N Others" label) gets subtracted from whatever
            // width we set here. +2 left the content box a few px
            // narrower than the measured text, which silently wrapped
            // "by" onto an invisible second line (the box stayed
            // single-line-tall) instead of clipping it — same failure
            // mode, just wrapping instead of clipping.
            prefixT.setExtent(lively.pt(prefixW + 8, lineH));

            var handleT = lively.morphic.Text.makeLabel("@" + creatorHandle,
              { fontSize: 12, fixedWidth: true, fixedHeight: true });
            handleT.setPosition(lively.pt(avX + prefixW + 6, detailY));
            handleT.setExtent(lively.pt(Math.max(20, detailW - prefixW - 6), lineH));
            self._quickInfoBox.addMorph(handleT);
            self._wireHandleLink(handleT, qi.createdBy, creatorHandle);

            detailY += lineH + 2;
            return;
          }
          var t = lively.morphic.Text.makeLabel(str,
            { fontSize: 12, textColor: Color.rgb(102, 102, 102), whiteSpaceHandling: "normal", fixedWidth: true, fixedHeight: true });
          t.setPosition(lively.pt(avX, detailY));
          t.setExtent(lively.pt(detailW, 1));
          self._quickInfoBox.addMorph(t);
          var inner = t.renderContext().shapeNode.querySelector("div");
          var lineH2 = (inner ? inner.offsetHeight : 14) + 4; // +4: shapeNode's own 2px-top/2px-bottom padding, see CLAUDE.md
          t.setExtent(lively.pt(detailW, lineH2));
          detailY += lineH2 + 2;
        });

        // Optional short description, set via the settings gear's dialog
        // (no panel UI existed for this before) — stacked directly below
        // the visibility/created-by lines above, same left edge as
        // detailW (not included in the detailRight/EVENT_CARD_X probe above,
        // unlike those two lines: a free-text description can run much
        // longer than "Created ... by @handle", and letting it influence
        // the event card's X position would make that placement swing
        // around based on prose length rather than the compact fields it's
        // meant to react to).
        //
        // Its own WIDTH is wider than detailW's, though, rather than just
        // reusing it: EVENT_CARD_X (and therefore detailW, which stops
        // 16px short of it) is sized to clear the card's own pre-cap
        // region, but the card itself has been capped at EVENT_CARD_MAX_W
        // and pulled rightward ever since — see _renderEventCard's own
        // MAX_CARD_W comment — so on any panel wider than
        // EVENT_CARD_MAX_W there's now a real gap between where detailW
        // stops and where the card's actual (capped) left edge sits, sitting
        // empty. The description is the one label in this column with no
        // fixed-format reason to stay within the old, more conservative
        // detailW (unlike the visibility/created-by lines, which stay put
        // deliberately — see their own comment above), so it widens into
        // that gap, up to the same 16px gutter detailW itself already uses
        // before the card. Never narrower than detailW (Math.max below) —
        // on a panel at or under EVENT_CARD_MAX_W the card isn't capped at
        // all and this collapses back to detailW exactly.
        var eventCardRight = visibleW - CARD_RIGHT_MARGIN;
        var eventCardActualLeft = eventCardRight - Math.min(eventCardRight - EVENT_CARD_X, EVENT_CARD_MAX_W);
        var descW = Math.max(detailW, eventCardActualLeft - avX - 16);
        if (qi.description) {
          // Available room is bounded by the panel's own bottom edge
          // rather than a flat "2 lines" assumption: the two detail lines
          // above are normally guaranteed to fit on one line each by the
          // detailRight/EVENT_CARD_X probe, but that probe's own high-end
          // clamp (MIN_CARD_W) can still narrow detailW below what those
          // lines need on a narrow viewport, forcing them to wrap and eat
          // extra height before the description even starts. A flat
          // 2-line cap doesn't know about that, so it could still run
          // past the bottom of the panel — confirmed live (before this
          // fix) with a real 2-sentence description at a narrowed
          // detailW. (The settings gear itself no longer needs a special
          // reservation here — it now sits at the panel's bottom-RIGHT,
          // clear of this left-column x range entirely; see gearBtn
          // below.)
          var GEAR_CLEARANCE = 8;
          var maxDetailY = h - GEAR_CLEARANCE;
          var availableH = maxDetailY - detailY;

          var descT = lively.morphic.Text.makeLabel(qi.description,
            { fontSize: 12, textColor: Color.rgb(80, 80, 80), whiteSpaceHandling: "normal", fixedWidth: true, fixedHeight: true });
          descT.setPosition(lively.pt(avX, detailY));
          descT.setExtent(lively.pt(descW, 1));
          self._quickInfoBox.addMorph(descT);
          var descInner = descT.renderContext().shapeNode.querySelector("div");
          var naturalDescH = (descInner ? descInner.offsetHeight : 14) + 4;

          // Height for exactly N wrapped lines is measured directly off the
          // PARAGRAPH's own rendered line boxes (span.getClientRects(), one
          // rect per wrapped line), rather than multiplying a single-
          // character probe's line height by N. A single "M" probe was
          // tried first and confirmed broken live: its measured per-line
          // height didn't quite match this real multi-word paragraph's own
          // sub-pixel line-height/leading (getClientRects() showed real
          // consecutive-line deltas of 18.67px, not a flat 18px), and
          // multiplying the probe's height by 2 for "2 lines" compounded
          // that mismatch — together just enough overshoot to let the TOP
          // sliver of a 3rd wrapped line peek out beneath clipMode:"hidden"
          // instead of being fully hidden.
          //
          // Two different cases need two different padding treatments, and
          // conflating them was the second bug (still visible as a smaller
          // ~1px sliver after fixing the first): when N covers ALL the real
          // wrapped lines (nothing after it to hide), naturalDescH is
          // already the proven-correct formula (content height + 4 — the
          // shapeNode's own top+bottom padding, needed so the LAST line's
          // own descenders aren't clipped, per the fontSize/sizing gotchas
          // elsewhere in this file). But when N is a TRUNCATION point
          // (more real lines exist after it), adding a full +4 overshoots:
          // consecutive wrapped lines here sit only ~0.67px apart, so a
          // clip boundary computed as "line N's bottom + 4" lands ~1.3px
          // INTO line N+1 rather than stopping before it. The fix for the
          // truncation case is +2 (top padding only, no bottom padding) —
          // line N's own getClientRects() bottom already includes its full
          // descent, so nothing more needs adding to show it complete, and
          // stopping there (rather than 2px further) keeps the clip
          // boundary above the very next line's own top.
          var descSpan = descT.renderContext().shapeNode.querySelector("span");
          var lineRects = descSpan ? Array.prototype.slice.call(descSpan.getClientRects()) : [];
          // Used to be hard-capped at 2 lines because the settings gear
          // sat directly below this column and a taller description would
          // run into it — that's no longer true (the gear moved to the
          // panel's bottom-RIGHT, see gearBtn below), so this cap is now
          // just a sane ceiling against a 300-char (DESCRIPTION_MAX,
          // IdentityServer.js) description growing unboundedly tall — the
          // real governor is availableH (how much room is actually left
          // above the panel's own bottom edge) via the loop's own
          // `hForLines > availableH` break below, same as before.
          var MAX_DESC_LINES = 6;
          var descH = 0, lineCount = 0;
          for (var i = 1; i <= Math.min(MAX_DESC_LINES, lineRects.length); i++) {
            var isFullContent = (i === lineRects.length);
            var hForLines = isFullContent
              ? naturalDescH
              : Math.min(naturalDescH, (lineRects[i - 1].bottom - lineRects[0].top) + 2);
            if (hForLines > availableH) break; // one more line would run past the panel's bottom edge — stop here
            descH = hForLines;
            lineCount = i;
          }

          // Skip entirely rather than render a sliver clipped down to a
          // fraction of a line — no room left in the panel at all, not
          // even for 1 line.
          if (lineCount > 0) {
            descT.setExtent(lively.pt(descW, descH));
            descT.applyStyle({ clipMode: "hidden" });
            detailY += descH + 2;
          } else {
            descT.remove();
          }
        }

        // Event card — pinned to the top-right corner of the space right
        // of the avatar/title column and below the banner, now that the
        // visibility/members/created details above no longer reserve room
        // at the bottom. Only the constellation's single next-upcoming
        // event is shown (getNextEvent server-side); nothing renders if
        // there isn't one. (visibleW/EVENT_CARD_X were both computed
        // earlier, above the detail lines — visibleW because
        // EVENT_CARD_X's own clamp needs it too.) BANNER_H itself (not
        // BANNER_H + 14) is passed as the region's top edge — both
        // _renderEventCard and _renderEmptyEventCard apply their own
        // top margin internally now, so it lines up with the margin they
        // leave on the right instead of a separately-guessed constant.
        // "Map ↗", "Wiki ↗" and "Canvas ↗" pills — in the open band right of
        // the title/detail column, just under the banner and above the
        // title's row. Each is hidden (same "degrade by disappearing"
        // precedent as the event card) once it would run into the event
        // card's real left edge on a narrow panel. Canvas is a placeholder:
        // no action yet.
        var pillY = BANNER_H + 8;
        var PILL_SPACING = 10;
        var pillSpecs = [
          { label: "Map", tooltip: "Show postcards on a map",
            onClick: function () { self._openQuickInfoMap(); } },
          // Same destination as the membership menu's "Open wiki" entry.
          { label: "Wiki", tooltip: "Open this constellation's wiki",
            onClick: function () {
              window.location.href = "/c/" + encodeURIComponent(self._displayName()) + "/wiki";
            } },
          { label: "Canvas", tooltip: "Canvas (coming soon)",
            onClick: function () {} },
        ];
        // Preferred start is just right of the title/detail column. The
        // pills sit above the title row (y < detailY), so that column's
        // width doesn't really constrain them — when the whole group would
        // run into the event card, slide it left (down to just clear the
        // avatar ring) rather than dropping a pill.
        var pillGroupW = PILL_SPACING * (pillSpecs.length - 1);
        pillSpecs.forEach(function (spec) { pillGroupW += qiPillWidth(QI_PILL_TEXT_W[spec.label]); });
        var pillMinX = avX + AVATAR + RING + 16;
        var pillX = Math.max(pillMinX,
          Math.min(Math.max(titleRight, detailRight) + 20, eventCardActualLeft - 16 - pillGroupW));
        pillSpecs.forEach(function (spec) {
          var pillW = qiPillWidth(QI_PILL_TEXT_W[spec.label]);
          if (pillX + pillW + 16 <= eventCardActualLeft) {
            self._quickInfoBox.addMorph(self._buildPillButton(pillX, pillY, spec.label, pillW, spec.tooltip, spec.onClick));
          }
          pillX += pillW + PILL_SPACING;
        });

        var PANEL_BOTTOM_PAD = 14;
        var cardBottomMax = h - PANEL_BOTTOM_PAD;
        if (qi.nextEvent) {
          this._renderEventCard(qi.nextEvent, EVENT_CARD_X, BANNER_H, visibleW, cardBottomMax);
        } else {
          this._renderEmptyEventCard(EVENT_CARD_X, BANNER_H, visibleW, cardBottomMax);
        }

        // Settings gear — bottom-RIGHT of the panel, controller-only (same
        // isController gate as the Rooms panel's "New Room" button above).
        // Opens ConstellationSettingsDialog to set avatar/banner/domain;
        // the server re-checks isController on every write route regardless,
        // this is purely a "don't show it" convenience for non-controllers.
        // Anchored off visibleW (the real gap before the members column,
        // same value the event card itself is anchored to just above),
        // NOT the quickInfoBox's own nominal width w — w can run wider
        // than what's actually visible before the members panel starts
        // (see the visibleW comment earlier in this function), and a gear
        // positioned off the full w would render partly or fully hidden
        // underneath the members column, the exact bug already fixed once
        // for the event card itself.
        // Single Text-morph-as-icon-button idiom (AmbientPresencePanel.js's
        // makeIconButton): a fixed-rect Text so align:'center' isn't a
        // no-op (that gotcha only bites a hug-content box), vertical
        // centering via top padding rather than verticalAlign (a no-op on
        // a multi-... well single-line box too, but padding is the already-
        // proven approach here) — fontSize is pt not px, so 13.5pt targets
        // an real ~18px glyph inside the 26px circle.
        if (this._isController) {
          var GEAR = 26, GEAR_GLYPH_PX = 18;
          var gearBtn = new lively.morphic.Text(lively.rect(visibleW - 10 - GEAR, h - 10 - GEAR, GEAR, GEAR));
          gearBtn.textString = "settings";
          gearBtn.applyStyle({
            fontFamily: "'Material Symbols Rounded'",
            fontSize: GEAR_GLYPH_PX * 0.75,
            textColor: Color.rgb(90, 90, 90),
            fill: Color.rgba(255, 255, 255, 0.92),
            borderRadius: GEAR / 2,
            borderWidth: 1,
            borderColor: Color.rgb(224, 224, 224),
            align: "center",
            padding: lively.Rectangle.inset(0, Math.round((GEAR - GEAR_GLYPH_PX) / 2), 0, 0),
            allowInput: false,
            selectable: false,
            clipMode: "hidden",
            whiteSpaceHandling: "pre",
            handStyle: "pointer",
          });
          noDrag(gearBtn);
          gearBtn.toolTip = "Constellation settings";
          gearBtn.onMouseOver = function () { gearBtn.applyStyle({ fill: Color.rgb(238, 238, 238) }); };
          gearBtn.onMouseOut = function () { gearBtn.applyStyle({ fill: Color.rgba(255, 255, 255, 0.92) }); };
          gearBtn.onMouseUp = function (evt) {
            self._openConstellationSettings();
            evt.stop();
            return true;
          };
          this._quickInfoBox.addMorph(gearBtn);
        }

        this._disableDragging(this._quickInfoBox);
      },

      // Real gap before the members column (see the visibleW comment in
      // _renderQuickInfo) — the box itself can run wider than what's
      // actually visible, so the map is sized to this, not the box's own w.
      _quickInfoVisibleW: function () {
        var w = this._quickInfoBox.getExtent().x;
        return (this._geom && typeof this._geom.membersX === "number")
          ? Math.max(200, this._geom.membersX - GUTTER - this._geom.quickInfoX)
          : w;
      },

      // Colored pill (QI_PILL_COLORS[labelText]), same shape as "+ Postcard":
      // a text label plus a Material Symbols arrow_outward glyph, as two
      // morphs (an icon-font glyph can't share a Text morph with regular-font
      // text). width comes from qiPillWidth(the label's rendered width).
      // Position is baked into
      // the constructor rect (CLAUDE.md: setPosition right after addMorph
      // can desync a morph's render tree); decorative children ignore
      // events so a click resolves to the pill itself.
      _buildPillButton: function (x, y, labelText, pillW, tooltip, onClick) {
        var ACCENT = QI_PILL_COLORS[labelText].fill, ACCENT_HOVER = QI_PILL_COLORS[labelText].hover;
        var textW = QI_PILL_TEXT_W[labelText];
        var pill = new lively.morphic.Box(lively.rect(x, y, pillW, QI_PILL_H));
        pill.setFill(ACCENT);
        pill.applyStyle({ borderWidth: 0, borderRadius: QI_PILL_H / 2, handStyle: "pointer" });
        noDrag(pill);
        pill.toolTip = tooltip;

        // Slot layout, from live measurement (rendered span boxes inside the
        // "Map" pill, 82x34): the label is centered *within its own fixed-
        // width slot* (align:'center'), so it stays centered even if the
        // fallback font's width differs slightly. The label + gap + glyph
        // group is centered in the pill by QI_PILL_PAD on each side. Slot
        // width must stay >= text + the shapeNode's 8px padding or the label
        // wraps.
        // LABEL_H is the box's *total* height: rendered content is ~21.3px
        // and the shapeNode subtracts 4px of its own vertical padding, so
        // anything under ~25 clips the descender of the "p" (confirmed live:
        // a 20px box cut ~2.8px off it — CLAUDE.md's Text-sizing gotcha).
        // LABEL_TOP keeps the value the centering above was measured with
        // (a 20px-tall box), so the glyph itself doesn't move.
        var LINE_H = 20, LABEL_H = 25, LABEL_SLOT_W = Math.ceil(textW + 8.5);
        var TEXT_CENTER_X = QI_PILL_PAD + textW / 2;
        var GLYPH_CENTER_X = pillW - QI_PILL_PAD - QI_PILL_ICON_PX / 2;
        var label = lively.morphic.Text.makeLabel(labelText, {
          fontSize: 14, fontWeight: "700", textColor: Color.rgb(255, 255, 255),
          align: "center", fixedWidth: true, fixedHeight: true,
        });
        label.setExtent(lively.pt(LABEL_SLOT_W, LABEL_H));
        // -2.35: the label's span box measured 9px from the pill's top and
        // 4.3px from its bottom when centered by (H - LINE_H) / 2, i.e.
        // riding ~2.35px low (the shapeNode's own vertical padding).
        label.setPosition(lively.pt(TEXT_CENTER_X - LABEL_SLOT_W / 2, (QI_PILL_H - LINE_H) / 2 - 2.35));
        label.applyStyle({ borderWidth: 0 });
        noDrag(label);
        label.eventsAreIgnored = true;
        pill.addMorph(label);

        // Icon idiom from the settings gear below: fixed-rect Text (so
        // align:'center' isn't a no-op), vertical centering via top padding,
        // fontSize in pt (px * 0.75).
        var iconX = GLYPH_CENTER_X - QI_PILL_ICON_BOX / 2;
        var icon = new lively.morphic.Text(lively.rect(iconX, (QI_PILL_H - QI_PILL_ICON_BOX) / 2, QI_PILL_ICON_BOX, QI_PILL_ICON_BOX));
        icon.textString = "arrow_outward";
        icon.applyStyle({
          fontFamily: "'Material Symbols Rounded'",
          fontSize: QI_PILL_ICON_PX * 0.75,
          textColor: Color.rgb(255, 255, 255),
          fill: null,
          borderWidth: 0,
          align: "center",
          // -2: the glyph's span box measured 8px from the pill's top and
          // 4px from its bottom with the gear's centering padding, i.e.
          // riding 2px low.
          padding: lively.Rectangle.inset(0, Math.round((QI_PILL_ICON_BOX - QI_PILL_ICON_PX) / 2) - 2, 0, 0),
          allowInput: false,
          selectable: false,
          clipMode: "hidden",
          whiteSpaceHandling: "pre",
        });
        noDrag(icon);
        icon.eventsAreIgnored = true;
        pill.addMorph(icon);

        pill.onMouseOver = function () { pill.setFill(ACCENT_HOVER); };
        pill.onMouseOut = function () { pill.setFill(ACCENT); };
        pill.onMouseUp = function (evt) {
          onClick();
          evt.stop();
          return true;
        };
        return pill;
      },

      // ─── map mode ────────────────────────────────────────────────────────

      _openQuickInfoMap: function () {
        this._mapMode = true;
        this._renderQuickInfo();
      },

      _closeQuickInfoMap: function () {
        this._mapMode = false;
        this._quickInfoMap = null;
        // The normal render clears every submorph, which also removes (and
        // so tears down the Leaflet instance of) the map.
        this._renderQuickInfo();
      },

      _renderQuickInfoMap: function (h) {
        var self = this;
        (this._quickInfoBox.submorphs || []).slice().forEach(function (m) { m.remove(); });
        var mapW = this._quickInfoVisibleW();

        var map = new lively.identity.ConstellationMap(lively.rect(0, 0, mapW, h), {
          constellation: this._name,
          resolveHandles: function (dids, thenDo) { self._resolveHandlesBatch(dids, thenDo); },
          // A pin click shows that postcard in the reel (left column), with
          // the map staying open, rather than opening a floating window.
          onOpen: function (handle, objId) { self._showCardInReel(objId); },
        });
        this._quickInfoBox.addMorph(map);
        this._quickInfoMap = map;

        // Back button over the map's top-left corner, same Text-morph-as-
        // icon-button idiom as the settings gear.
        var BACK = 32, BACK_GLYPH_PX = 20;
        var back = new lively.morphic.Text(lively.rect(12, 12, BACK, BACK));
        back.textString = "arrow_back";
        back.applyStyle({
          fontFamily: "'Material Symbols Rounded'",
          fontSize: BACK_GLYPH_PX * 0.75,
          textColor: Color.rgb(90, 90, 90),
          fill: Color.rgba(255, 255, 255, 0.95),
          borderRadius: BACK / 2,
          borderWidth: 1,
          borderColor: Color.rgb(224, 224, 224),
          align: "center",
          padding: lively.Rectangle.inset(0, Math.round((BACK - BACK_GLYPH_PX) / 2), 0, 0),
          allowInput: false,
          selectable: false,
          clipMode: "hidden",
          whiteSpaceHandling: "pre",
          handStyle: "pointer",
        });
        noDrag(back);
        back.toolTip = "Back to constellation info";
        back.onMouseOver = function () { back.applyStyle({ fill: Color.rgb(238, 238, 238) }); };
        back.onMouseOut = function () { back.applyStyle({ fill: Color.rgba(255, 255, 255, 0.95) }); };
        back.onMouseUp = function (evt) {
          self._closeQuickInfoMap();
          evt.stop();
          return true;
        };
        this._quickInfoBox.addMorph(back);

        this._disableDragging(this._quickInfoBox);
      },

      // Opens the avatar/banner/domain settings dialog (controller-only,
      // gated by the gear button above and re-checked server-side on every
      // write route it uses). Re-loads quick info on save so the panel
      // reflects the new avatar/banner immediately.
      _openConstellationSettings: function (tab) {
        var self = this;
        lively.identity.ConstellationSettingsDialog.open(this._name, this._quickInfo, function () {
          self._refreshQuickInfo();
        }, tab);
      },

      // Member-only RSVP to the event card's Going/Maybe/Can't-go row
      // (_renderEventCard) — server re-checks membership itself
      // (canWrite) regardless of this._canWrite's client-side gating.
      // Re-loads quick info on success so the card's attendee
      // count/avatar stack and highlighted button reflect the new
      // response immediately.
      _respondToEvent: function (eventId, status) {
        var self = this;
        var base = lively.identity.did.baseUrl();
        fetch(base + "/c/" + encodeURIComponent(this._name) + "/events/" + encodeURIComponent(eventId) + "/rsvp", {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: status }),
        })
          .then(function (res) {
            return res.json().then(function (body) {
              if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
              self._refreshQuickInfo();
            });
          })
          .catch(function (err) {
            self._showError("Could not RSVP: " + err.message);
          });
      },

      // Same bordered slot as _renderEventCard, shown instead of it when
      // there's no upcoming event — a calendar glyph (Material Symbols
      // Rounded, per CLAUDE.md's icon convention) over "No events
      // scheduled", both centered in the card rather than left-aligned
      // like the populated card's content, since there's no date/title/
      // location to anchor a left margin against.
      _renderEmptyEventCard: function (cardX, cardY, panelW, cardBottomMax) {
        var self = this;
        // Same RIGHT_MARGIN, applied symmetrically top and right, as
        // _renderEventCard — this card fills its whole region rather than
        // hugging content, so unlike the populated card there's no
        // separate "shrink then position" step; the margin is just baked
        // straight into where the box starts and how big it is.
        var RIGHT_MARGIN = 28;
        // Same MAX_CARD_W cap, and same right-edge-fixed/left-edge-moves-in
        // approach, as _renderEventCard — see its comment for why.
        var MAX_CARD_W = EVENT_CARD_MAX_W;
        var cardRight = panelW - RIGHT_MARGIN;
        var cardW = Math.min(cardRight - cardX, MAX_CARD_W);
        cardX = cardRight - cardW;
        // Same MAX_CARD_H cap, top-anchored (cardY untouched, bottom edge
        // pulled up), as _renderEventCard — see its comment for why.
        var MAX_CARD_H = 160;
        var cardH = Math.min((cardBottomMax - cardY) - RIGHT_MARGIN, MAX_CARD_H);
        if (cardW < 160 || cardH < 70) return;

        var card = new lively.morphic.Box(lively.rect(cardX, cardY + RIGHT_MARGIN, cardW, cardH));
        card.setFill(Color.white);
        card.applyStyle({ borderWidth: 2, borderColor: Color.rgb(232, 73, 126), borderRadius: 12, clipMode: "hidden" });   // COMMENT_ACCENT (#e8497e)
        this._quickInfoBox.addMorph(card);

        // Controller-only "add event" icon, pinned to the card's own
        // top-right corner — same idiom as _renderEventCard's edit icon,
        // baked directly into its constructor rect off the already-known
        // cardW/cardH (this card never needs a measure-then-reposition
        // step, so there's no risk from the setPosition-after-addMorph
        // gotcha either way).
        if (this._isController) {
          var ADD = 22, ADD_GLYPH_PX = 14, ADD_MARGIN = 6;
          var addBtn = new lively.morphic.Text(
            lively.rect(cardW - ADD_MARGIN - ADD, ADD_MARGIN, ADD, ADD), "add");
          addBtn.applyStyle({
            fontFamily: "'Material Symbols Rounded'",
            fontSize: ADD_GLYPH_PX * 0.75,
            textColor: Color.rgb(90, 90, 90),
            fill: Color.rgba(255, 255, 255, 0.92),
            borderRadius: ADD / 2,
            borderWidth: 1,
            borderColor: Color.rgb(224, 224, 224),
            align: "center",
            padding: lively.Rectangle.inset(0, Math.round((ADD - ADD_GLYPH_PX) / 2), 0, 0),
            allowInput: false,
            selectable: false,
            clipMode: "hidden",
            whiteSpaceHandling: "pre",
            handStyle: "pointer",
          });
          noDrag(addBtn);
          addBtn.toolTip = "Add event";
          addBtn.onMouseOver = function () { addBtn.applyStyle({ fill: Color.rgb(238, 238, 238) }); };
          addBtn.onMouseOut = function () { addBtn.applyStyle({ fill: Color.rgba(255, 255, 255, 0.92) }); };
          addBtn.onMouseUp = function (evt) {
            lively.identity.EditEventDialog.open(self._name, null, function () {
              self._refreshQuickInfo();
            });
            evt.stop();
            return true;
          };
          card.addMorph(addBtn);
        }

        // +8/-4 padding-compensation used below for both the icon and the
        // label: the shapeNode's own small fixed internal padding
        // (CLAUDE.md's Text-morph sizing gotcha) eats into the content
        // box, so setting width to exactly the measured glyph/text width
        // clips the last couple px — pad the extent and shift position
        // back by half that so the visible content lands centered with
        // nothing clipped.
        var SIZE_PAD = 8;

        // 28px real glyph size -> fontSize 21 (28*0.75), same pt-not-px
        // conversion as every other icon in this file — ICON_PX is
        // already the glyph's own designed render size, so the box is
        // sized directly from it rather than measured off the live DOM.
        // A live measurement was tried here first and confirmed broken:
        // reading the rendered span's offsetWidth immediately after
        // setting fontFamily/textString raced the icon font's async load,
        // briefly reporting ~172px — the width of the literal string
        // "calendar_month" in a fallback font before Material Symbols
        // Rounded had actually applied. Same underlying race as the
        // WindowControl icon-button gotcha elsewhere in this file
        // (CLAUDE.md), just hit via measurement instead of a textString
        // swap. Previously left at the full cardW width permanently (via
        // align:"center" on a fixedWidth box), which looked centered but
        // left an invisible hit-area spanning the entire card (confirmed
        // via halo-select) instead of a small box around just the icon.
        var ICON_PX = 28, ICON_FONT = ICON_PX * 0.75, ICON_BOX_H = 34;
        var iconY = Math.round(cardH / 2) - 34;
        // Centered x computed up front and baked straight into the
        // constructor's rect, rather than built at x=0 and repositioned
        // via a later setPosition call — confirmed live that the latter
        // corrupts this specific card's render tree: a post-construction
        // setPosition call here (even placed after card.addMorph(icon), a
        // fix that looked plausible but didn't hold up) left the icon and
        // the label below rendering under two different DOM wrapper
        // nodes despite sharing the same morph-model owner, with the
        // wrong stacking order on screen (icon below the label) even
        // though both read back the correct, intended position on the
        // model. Root cause not fully isolated; matching the label's own
        // never-reposition-a-fixedWidth-morph-after-the-fact approach
        // (icon uses fixedWidth:true from the start, so there's no
        // "measure then shrink" step to require a second call anyway)
        // sidesteps it entirely and is simpler besides.
        var iconX = Math.max(0, Math.round((cardW - ICON_PX) / 2) - SIZE_PAD / 2);
        var icon = new lively.morphic.Text(lively.rect(iconX, iconY, ICON_PX + SIZE_PAD, ICON_BOX_H), "calendar_month");
        icon.applyStyle({
          fontFamily: "'Material Symbols Rounded'", fontSize: ICON_FONT, textColor: Color.rgb(190, 190, 190),
          fill: null, borderWidth: 0, allowInput: false, selectable: false, align: "center",
          fixedWidth: true, fixedHeight: true,
          clipMode: "hidden", whiteSpaceHandling: "pre",
        });
        card.addMorph(icon);

        // Left at makeLabel's default fixedWidth:false so the box hugs the
        // text itself (a small centered pill, not a label stretched across
        // the whole card) — align:"center" can't do the centering here
        // since a box that auto-shrinks to its content has no extra room
        // left to center within (confirmed live: with align alone the text
        // sat flush-left instead). Generous throwaway width first so it
        // doesn't wrap, then measure the real rendered span and reposition
        // — same measure-after-render idiom _fitCreatePostcardButton
        // already uses in this file for the same reason.
        var label = lively.morphic.Text.makeLabel("No events scheduled",
          { fontSize: 12.5, textColor: Color.rgb(150, 150, 150) });
        var labelY = Math.round(cardH / 2) + 4;
        label.setPosition(lively.pt(0, labelY));
        label.setExtent(lively.pt(cardW, 18));
        card.addMorph(label);
        var labelSpan = label.renderContext().shapeNode.querySelector("span");
        var labelW = labelSpan ? labelSpan.offsetWidth : Math.ceil("No events scheduled".length * 7);
        // setExtent back down to the real measured width, not just
        // setPosition — the box itself was still the full cardW-wide
        // throwaway extent from above (fixedWidth:false only auto-fits at
        // initial creation, not on every subsequent change), so repositioning
        // alone just slid that still-full-width box rightward, overflowing
        // past the card's own right edge. Shrinking the extent too is what
        // actually makes it hug the text.
        label.setExtent(lively.pt(labelW + SIZE_PAD, 18));
        label.setPosition(lively.pt(Math.max(0, Math.round((cardW - labelW) / 2) - SIZE_PAD / 2), labelY));
      },

      // cardRight/cardBottomMax: the panel's own right/bottom bounds are an
      // upper limit the card must stay within, not a size to stretch to
      // fill — the card is built at that generous throwaway size first
      // (so nothing wraps while measuring), then shrunk down to hug its
      // actual content on both axes, same measure-then-shrink idiom as the
      // empty-state "No events scheduled" label. Confirmed live: the
      // stretched version left a large dead gap to the right of "+N
      // Others" and zero bottom margin below the avatar row.
      _renderEventCard: function (ev, cardX, cardY, panelW, cardBottomMax) {
        var self = this;
        // RIGHT_MARGIN (rather than the flat 20 GUTTER used elsewhere in
        // this file) so the card visibly clears the panel's right edge
        // even when it hugs all the way out to maxCardW, instead of
        // stopping just short of it. Reused as the *top* margin too (see
        // the final positioning below) so the card sits pinned to the
        // available region's top-right corner with equal margins on both
        // sides, rather than centered in the region — cardY here is this
        // region's own top edge (banner bottom), not yet offset by any
        // margin, so that margin has to come out of maxCardH the same way
        // RIGHT_MARGIN already comes out of maxCardW.
        var RIGHT_MARGIN = 28;
        // Capped so the card doesn't stretch all the way over to the
        // avatar/title/detail-lines column on a wide panel — same cap as
        // _renderEmptyEventCard's MAX_CARD_W, so the populated and
        // empty-state cards stay the same width as an event comes and goes.
        // The card's RIGHT edge (panelW - RIGHT_MARGIN) stays fixed either
        // way; capping pulls cardX itself rightward so the extra room is
        // given back on the LEFT, not the right.
        var MAX_CARD_W = EVENT_CARD_MAX_W;
        var cardRight = panelW - RIGHT_MARGIN;
        var maxCardW = Math.min(cardRight - cardX, MAX_CARD_W);
        cardX = cardRight - maxCardW;
        // Capped the same way as MAX_CARD_W above, but top-anchored rather
        // than right-anchored: cardY (this region's own top edge) is left
        // untouched, so the cap just pulls the card's BOTTOM edge upward
        // instead of leaving it stretched down to cardBottomMax — same cap
        // as _renderEmptyEventCard's MAX_CARD_H, for the same
        // populated/empty-state consistency reason as MAX_CARD_W.
        // 200, not the empty card's 160: a member's fully populated card
        // (title, date, location, attendee row, "N maybe" note, RSVP pills)
        // needs ~188px, so at 160 the RSVP pills were clipped by the card's
        // own border — most visibly right after someone clicked Maybe,
        // which adds the "N maybe" line. The card still hugs its content,
        // and the region's own available height caps it below this.
        var MAX_CARD_H = 200;
        var maxCardH = Math.min((cardBottomMax - cardY) - RIGHT_MARGIN, MAX_CARD_H);
        if (maxCardW < 160 || maxCardH < 70) return; // not enough room to render legibly

        var card = new lively.morphic.Box(lively.rect(cardX, cardY, maxCardW, maxCardH));
        card.setFill(Color.white);
        // clipMode hidden so a long title/location (this panel's available
        // width is fairly narrow once the members column eats into it, see
        // visibleW above) clips cleanly at the card's own edge instead of
        // visually overflowing past it — confirmed live with a real
        // 45-character title before adding this.
        card.applyStyle({ borderWidth: 2, borderColor: Color.rgb(232, 73, 126), borderRadius: 12, clipMode: "hidden" });   // COMMENT_ACCENT (#e8497e)
        this._quickInfoBox.addMorph(card);

        var PAD = 16, GAP = 4;
        var contentW = maxCardW - PAD * 2;
        // Widest content edge seen so far (card-relative x) — drives the
        // final shrunk width below, capped at contentW per-line so a
        // wrapped title (see below) can't itself push the card wider than
        // the room actually available.
        var maxRight = 0;
        function trackRight(right) { if (right > maxRight) maxRight = right; }

        // Controller-only edit icon lives in the card's top-right corner
        // (built further below, once finalW is known) — reserved here so
        // the title, which now sits at the very top of the card (moved
        // above the date/time line — previously date/time was the top
        // row), caps its own width short of the icon instead of running
        // underneath it. Every other line (date/time, location, avatar
        // row) now starts below the title, so only the title needs the
        // reserve.
        var EDIT = 22, EDIT_GLYPH_PX = 14, EDIT_MARGIN = 6;
        var topRightReserve = this._isController ? (EDIT + EDIT_MARGIN + 6) : 0;

        // Every label below that sizes itself from a *measured* content
        // height (as opposed to a hardcoded guess) has to add HEIGHT_PAD
        // back on top of that measurement before calling setExtent — the
        // vertical sibling of the shapeNode's own fixed internal padding
        // CLAUDE.md already documents for width (the "+8/-4" pattern used
        // elsewhere in this file): `setExtentHTML` treats the extent it's
        // given as the box's *total* size and subtracts the shapeNode's
        // own 2px-top/2px-bottom padding from it to get the actual CSS
        // content-box height. Passing the measured *content* height
        // straight through therefore ends up 4px short of what's actually
        // needed — confirmed live: measuring the "+N People" label's real
        // content height as 19px and calling setExtent(w, 19) produced a
        // box only 15px tall, clipping the descender of the "p" in
        // "People" against the box's own overflow:hidden. fixedWidth/
        // fixedHeight are also set true on these labels (unlike makeLabel's
        // hug-content default of false for both) so nothing later
        // silently re-fits them back to a different size.
        var HEIGHT_PAD = 4;

        // Title now sits at the very top of the card — allowed to wrap
        // onto a second line, unlike every other label in this file (all
        // single-line "pre") — instead of clipping mid-word at the card's
        // own edge, which is what a real ~45-char event title did before
        // this (confirmed live: cut off after ~30 characters, mid-word,
        // with the rest of the title simply gone). The box starts at a
        // generous throwaway height (its real wrapped height isn't
        // knowable until after render — same measure-after-render idiom
        // used elsewhere in this file) and is then shrunk to the actual
        // measured height, so nothing below it in the card overlaps or
        // leaves an oversized gap. Sized against titleMaxW (contentW minus
        // the edit icon's reserved corner, see topRightReserve above)
        // rather than plain contentW, since this top row is the one that
        // shares space with the icon now.
        var titleM = lively.morphic.Text.makeLabel(ev.title || "",
          { fontSize: 15, fontWeight: "bold", textColor: Color.rgb(4, 168, 34), whiteSpaceHandling: "normal", fixedWidth: true, fixedHeight: true });
        var titleY = 8;
        titleM.setPosition(lively.pt(PAD, titleY));
        var titleMaxW = contentW - topRightReserve;
        // Single-line height first (a throwaway 2000px-wide box guarantees
        // no wrap regardless of content) — this is the per-line height used
        // below to cap wrapping at 2 lines. The box's own height is set to
        // 1px (not something generous) for every measurement in this
        // function: the rendered content div's CSS is
        // `min-height: calc(100% - 4px)` of the *box's own* height, so a
        // generous throwaway height (e.g. 60) becomes a floor that a short
        // single line's true ~23-27px content can never measure below —
        // confirmed live, every measurement came back pinned at exactly
        // (thrown-away height - 4) regardless of actual content. A 1px box
        // makes that floor negligible, so offsetHeight reflects real
        // content height instead.
        titleM.setExtent(lively.pt(2000, 1));
        card.addMorph(titleM);
        var titleInner = titleM.renderContext().shapeNode.querySelector("div");
        var singleLineH = titleInner ? titleInner.offsetHeight : 20;
        titleM.setExtent(lively.pt(titleMaxW, 1));
        var titleH = titleInner ? titleInner.offsetHeight : singleLineH;
        // Capped at a SINGLE line with a trailing "…" (a longer title, e.g.
        // "Community Jam Night and Social Mixer", becomes "Community Jam
        // Night…") rather than letting it wrap — a wrapped 2-line title was
        // tried first, but on a narrow card (this panel's available width
        // shrinks a lot below ~1600px browser width, see visibleW above) a
        // long title could still wrap onto 4-5 lines, blowing past the
        // card's own fixed vertical budget and pushing the avatar row/
        // RSVP pills past the card's bottom edge to be clipped there —
        // confirmed live at a 1280px browser width with a 45-character
        // title. A flat single-line cap sidesteps that regardless of card
        // width. Trims one word at a time off the end (titles are short, a
        // handful of words, so this is a handful of reflows at most) until
        // the text fits back on one line.
        var maxTitleH = singleLineH + 4;
        if (titleH > maxTitleH) {
          var words = (ev.title || "").split(/\s+/);
          while (words.length > 1 && titleH > maxTitleH) {
            words.pop();
            titleM.setTextString(words.join(" ") + "…");
            titleH = titleInner.offsetHeight;
          }
        }
        var titleSpan = titleM.renderContext().shapeNode.querySelector("span");
        // Only hug width when the title stayed on one line — a wrapped
        // title's own width *is* titleMaxW (that's what forced it to
        // wrap), so there's no narrower "natural" width to hug to; the
        // span's own offsetWidth for wrapped content is just the widest
        // individual line anyway (see the trackRight cap below), not a
        // sizing target. "Stayed one line" is titleH landing back at
        // singleLineH — allow a couple px of font-rounding slack.
        var titleIsSingleLine = titleH <= singleLineH + 2;
        // +14, not the usual +8 shapeNode-padding compensation used
        // elsewhere in this file — confirmed live (bumping the pad 0..20px
        // and reading back the real rendered line count) that this bold
        // 15px title needs at least +12 to avoid re-wrapping once its own
        // box is shrunk to the hugged width; +8 measured 2 lines every
        // time up to +10. +14 keeps a couple px of margin over that
        // empirical minimum. A title that re-wraps after this hug silently
        // loses its last word off-screen (clipped by the card's own
        // clipMode:"hidden") with no visual sign anything went wrong.
        var titleW = (titleIsSingleLine && titleSpan)
          ? Math.min(titleSpan.offsetWidth + 14, titleMaxW)
          : titleMaxW;
        titleM.setExtent(lively.pt(titleW, titleH + HEIGHT_PAD));
        // trackRight's own contribution here also adds topRightReserve on
        // top of the title's real right edge — confirmed live (when this
        // reserve lived on the date/time line instead, before the
        // title/date swap) this matters even though titleW itself is
        // already capped short of the icon: a line comfortably under
        // titleMaxW (so the cap above never engages) can still end up the
        // single widest line in the card, driving finalW via plain
        // "maxRight + PAD" below with only a flat 16px margin — less than
        // the icon's own ~28px footprint. Reserving the icon's footprint
        // in the title's OWN contribution to maxRight (rather than just
        // capping its width) guarantees finalW ends up wide enough to
        // clear the icon in every case.
        if (titleSpan) trackRight(PAD + Math.min(titleSpan.offsetWidth, titleMaxW) + topRightReserve);
        var afterTitleY = titleY + titleH + HEIGHT_PAD;

        // Date/time, right below the title (previously the top line,
        // above the title — swapped so the title reads first). Plain
        // contentW, no icon reserve needed here since this row is now
        // below the title's own top row, clear of the icon.
        var dt = lively.morphic.Text.makeLabel(this._formatEventDateTime(ev.startsAt),
          { fontSize: 12, fontWeight: "700", textColor: Color.rgb(230, 126, 34), fixedWidth: true, fixedHeight: true });
        var dtY = afterTitleY + GAP;
        dt.setPosition(lively.pt(PAD, dtY));
        // contentW is a generous throwaway width here — only so the "pre"
        // (no-wrap) text has room to measure at its natural size, never
        // the box's final width. Left un-hugged, this and the other two
        // labels below stayed at the full contentW forever (their own
        // invisible box always as wide as the card's *widest possible*
        // content), which sat visibly wider than the card itself once the
        // card hugged down to a narrower finalW below — confirmed live via
        // halo-select, an empty-space overhang past the card's own right
        // border on every line shorter than whichever line drove finalW.
        dt.setExtent(lively.pt(contentW, 14));
        card.addMorph(dt);
        // Measure the real content height rather than trust the hardcoded
        // 14 above (see HEIGHT_PAD comment) — a fixed guess is a coin flip
        // on whether a descender like the "y" in "Thursday" clips.
        var dtInner = dt.renderContext().shapeNode.querySelector("div");
        var dtH = dtInner ? dtInner.offsetHeight + HEIGHT_PAD : 14;
        var dtSpan = dt.renderContext().shapeNode.querySelector("span");
        // Hug width to the real measured text (+8 shapeNode-padding
        // compensation, same idiom as the "+N Others" label below), capped
        // at contentW so an overlong date still clips at the card's edge
        // rather than overflow past it — same trade-off already made for
        // trackRight just below.
        var dtW = dtSpan ? Math.min(dtSpan.offsetWidth + 8, contentW) : contentW;
        dt.setExtent(lively.pt(dtW, dtH));
        if (dtSpan) trackRight(PAD + Math.min(dtSpan.offsetWidth, contentW));

        // Location's y (and, below, the avatar row's rowY) is derived from
        // the date/time line's *real* measured bottom rather than a fixed
        // offset — a wrapped two-line title is taller than a fixed offset
        // would assume, and without this the location line and avatar row
        // would sit on top of the date/time line instead of below it.
        var contentBottomY = dtY + dtH;
        if (ev.location) {
          var locM = lively.morphic.Text.makeLabel(ev.location, { fontSize: 12, textColor: Color.rgb(110, 110, 110), fixedWidth: true, fixedHeight: true });
          var locY = contentBottomY + GAP;
          locM.setPosition(lively.pt(PAD, locY));
          locM.setExtent(lively.pt(contentW, 14));
          card.addMorph(locM);
          var locInner = locM.renderContext().shapeNode.querySelector("div");
          var locH = locInner ? locInner.offsetHeight : 14;
          var locSpan = locM.renderContext().shapeNode.querySelector("span");
          var locW = locSpan ? Math.min(locSpan.offsetWidth + 8, contentW) : contentW;
          locM.setExtent(lively.pt(locW, locH + HEIGHT_PAD));
          if (locSpan) trackRight(PAD + Math.min(locSpan.offsetWidth, contentW));
          contentBottomY = locY + locH + HEIGHT_PAD;
        }

        // Overlapping attendee avatars — same white-ring cutout technique
        // as the main avatar above, one ring+image pair per attendee, each
        // added after (so rendered on top of) the previous one to get the
        // "stacked" look. Deterministic identicons off each attendee's DID,
        // same as every other avatar in this file — no real photos, this
        // app has no such upload path for anyone, member or attendee.
        var AV = 26, OVERLAP = 8, RING = 2, MAX_SHOWN = 4;
        var allAttendees = ev.attendees || [];
        var totalAttendeeCount = ev.attendeeCount || allAttendees.length;
        // A narrow card (contentW shrinks a lot below ~1600px browser
        // width, see visibleW above) can't always fit 4 overlapping
        // avatars plus a "+N Others" label on one row — confirmed live at
        // a 1280px browser width, where the label's own right edge landed
        // ~30px past the card's right border and was clipped there. Rather
        // than let the row overflow, shrink how many avatar circles are
        // shown (never the label itself, which is what actually carries
        // the count) until the whole row fits within contentW. The
        // label's width barely changes with the exact "+N" digit count, so
        // one throwaway measurement at the MAX_SHOWN guess is close enough
        // to size against.
        var guessShown = Math.min(allAttendees.length, MAX_SHOWN);
        var guessExtra = Math.max(0, totalAttendeeCount - guessShown);
        var lblW = 0;
        if (guessExtra > 0) {
          var lblProbe = lively.morphic.Text.makeLabel("+" + guessExtra + " Others",
            { fontSize: 12.5, fontWeight: "700", textColor: Color.rgb(40, 40, 40) });
          lblProbe.setPosition(lively.pt(-9999, -9999));
          lblProbe.setExtent(lively.pt(200, 18));
          card.addMorph(lblProbe);
          var lblProbeSpan = lblProbe.renderContext().shapeNode.querySelector("span");
          lblW = lblProbeSpan ? lblProbeSpan.offsetWidth : Math.ceil(("+" + guessExtra + " Others").length * 8);
          lblProbe.remove();
        }
        var avatarsBudget = contentW - (guessExtra > 0 ? (lblW + 8 + 8) : 0);
        var shownCount = guessShown;
        while (shownCount > 0 && (AV + (shownCount - 1) * (AV - OVERLAP)) > avatarsBudget) shownCount--;
        var shown = allAttendees.slice(0, shownCount);
        var rowY = contentBottomY + GAP;
        var x = PAD;
        shown.forEach(function (did) {
          var rs = AV + RING * 2;
          var ring = new lively.morphic.Box(lively.rect(x - RING, rowY - RING, rs, rs));
          ring.applyStyle({ fill: Color.white, borderRadius: rs / 2, borderWidth: 0 });
          card.addMorph(ring);
          var av = new lively.morphic.Image(lively.rect(x, rowY, AV, AV));
          av.setImageURL(lively.identity.postCardUtils.identiconDataUrl(did, AV));
          av.applyStyle({ borderRadius: AV / 2, borderWidth: 0, clipMode: "hidden" });
          card.addMorph(av);
          x += AV - OVERLAP;
        });
        if (shown.length) x += OVERLAP;
        trackRight(x);

        var extra = Math.max(0, totalAttendeeCount - shown.length);
        if (extra > 0) {
          var lblX = x + (shown.length ? 8 : 0);
          var lbl = lively.morphic.Text.makeLabel("+" + extra + " Others",
            { fontSize: 12.5, fontWeight: "700", textColor: Color.rgb(40, 40, 40), fixedWidth: true, fixedHeight: true });
          lbl.setPosition(lively.pt(lblX, rowY + 5));
          lbl.setExtent(lively.pt(Math.max(30, contentW - lblX), 18)); // generous throwaway so it doesn't wrap
          card.addMorph(lbl);
          // Shrink to the real measured width — same +8 shapeNode-padding
          // compensation as the empty-state label, so the box hugs the
          // text (no dead space trailing it) without clipping its own
          // last character. Height is likewise measured rather than a
          // guessed 18: that guess was ~1px short of this text's real
          // rendered height, which clipped the descender of the "p" in
          // "People" against the box's own overflow:hidden (confirmed
          // live) — see the HEIGHT_PAD comment above for why.
          var lblInner = lbl.renderContext().shapeNode.querySelector("div");
          var lblSpan = lbl.renderContext().shapeNode.querySelector("span");
          var lblW = lblSpan ? lblSpan.offsetWidth : Math.ceil(("+" + extra + " Others").length * 8);
          var lblH = lblInner ? lblInner.offsetHeight : 18;
          lbl.setExtent(lively.pt(lblW + 8, lblH + HEIGHT_PAD));
          trackRight(lblX + lblW + 8);
        }

        // Everything below the avatar row (the "N maybe" note, then the
        // RSVP pills) used to anchor off "rowY + AV" unconditionally —
        // reserving a full 26px-tall avatar row's worth of space even when
        // there were zero attendees to draw there (shown.length===0 and
        // extra===0, the common case for a brand new event). Combined with
        // MAX_CARD_H's own 160px cap (see _renderEventCard's own comment),
        // that reserved-but-empty gap was consistently enough to push the
        // RSVP pills below the card's own bottom edge — confirmed live,
        // "BIG DAY TOMORROW" (0 attendees, 1 maybe, RSVP row) rendered with
        // its RSVP pills cut in half by the card's clipMode:"hidden" border.
        // hasAvatarRow tracks whether that row actually drew anything, so
        // the maybe-note/RSVP stack can skip straight past it (rather than
        // past an empty gap) when it didn't.
        var hasAvatarRow = shown.length > 0 || extra > 0;
        var afterAvatarY = rowY + (hasAvatarRow ? AV + GAP : 0);

        // Secondary "N maybe" note — attendeeCount/attendees above only
        // ever reflect 'going' RSVPs (ConstellationRegistry.js's
        // getNextEvent), so a nonzero maybeCount would otherwise be
        // invisible on the card entirely. Sits right after the avatar row
        // (or, per hasAvatarRow above, right after the location line if
        // there wasn't one), rather than at a fixed "rowY + AV" offset.
        var afterMaybeY = afterAvatarY;
        if (ev.maybeCount > 0) {
          var maybeLbl = lively.morphic.Text.makeLabel(ev.maybeCount + " maybe",
            { fontSize: 11, textColor: Color.rgb(150, 150, 150), fixedWidth: true, fixedHeight: true });
          maybeLbl.setPosition(lively.pt(PAD, afterAvatarY));
          maybeLbl.setExtent(lively.pt(contentW, 1));
          card.addMorph(maybeLbl);
          // Measured rather than the old flat 14 — same HEIGHT_PAD idiom as
          // every other label in this function, so this row's own real
          // height (not a guess) is what the RSVP row below stacks against.
          var maybeInner = maybeLbl.renderContext().shapeNode.querySelector("div");
          var maybeSpan = maybeLbl.renderContext().shapeNode.querySelector("span");
          var maybeH = (maybeInner ? maybeInner.offsetHeight : 10) + HEIGHT_PAD;
          var maybeW = maybeSpan ? Math.min(maybeSpan.offsetWidth + 8, contentW) : contentW;
          maybeLbl.setExtent(lively.pt(maybeW, maybeH));
          trackRight(PAD + Math.min(maybeSpan ? maybeSpan.offsetWidth : 0, contentW));
          afterMaybeY = afterAvatarY + maybeH + GAP;
        }

        // Member-only RSVP row (Going / Maybe / Can't go), below the
        // avatar/attendee row — gated on this._canWrite (this file's
        // existing "is a member" flag, set from space-token's own
        // canWrite field and already used to gate the "+ Postcard" button
        // the same way). Fixed-width pills rather than hug-measured, same
        // simplicity tradeoff as the settings gear/edit icon's fixed
        // 22-26px sizing elsewhere in this function. Stacked directly off
        // afterMaybeY (itself stacked off afterAvatarY) rather than its own
        // independent "rowY + AV + flat gap" guess, so it always sits
        // right after whatever actually rendered above it — no dead
        // reserved space, no overlap, regardless of which combination of
        // attendees/maybe/neither is present.
        var RSVP_H = 26;
        var rsvpY = afterMaybeY;

        // Shrink the card down to hug its content on both axes (capped at
        // the original available maxCardW/maxCardH so it never grows back
        // past the visible bounds established by the caller) — MIN floors
        // keep a short title/no-attendees card from collapsing too tight.
        var finalW = Math.min(maxCardW, Math.max(220, maxRight + PAD));
        var finalH = Math.min(maxCardH, Math.max(70,
          this._canWrite ? (rsvpY + RSVP_H + 14) : (afterMaybeY + 14)));
        card.setExtent(lively.pt(finalW, finalH));

        if (this._canWrite) {
          var RSVP_OPTIONS = [
            { status: "going", label: "Going", width: 62 },
            { status: "maybe", label: "Maybe", width: 62 },
            { status: "not_going", label: "Can't go", width: 74 },
          ];
          var rsvpX = PAD;
          RSVP_OPTIONS.forEach(function (opt) {
            var isActive = ev.myRsvp === opt.status;
            var pill = new lively.morphic.Text(lively.rect(rsvpX, rsvpY, opt.width, RSVP_H), opt.label);
            pill.applyStyle({
              fontSize: 11, fontWeight: "700",
              textColor: isActive ? Color.white : Color.rgb(80, 80, 80),
              fill: isActive ? Color.rgb(232, 73, 126) : Color.rgb(245, 245, 245),
              borderRadius: RSVP_H / 2, borderWidth: 1,
              borderColor: isActive ? Color.rgb(232, 73, 126) : Color.rgb(220, 220, 220),
              align: "center", padding: lively.Rectangle.inset(0, 5, 0, 0),
              allowInput: false, selectable: false, clipMode: "hidden",
              whiteSpaceHandling: "pre", handStyle: "pointer",
              fixedWidth: true, fixedHeight: true,
            });
            noDrag(pill);
            pill.onMouseUp = function (evt) {
              self._respondToEvent(ev.id, opt.status);
              evt.stop();
              return true;
            };
            card.addMorph(pill);
            rsvpX += opt.width + 6;
          });
        }

        // Controller-only edit icon, pinned to the card's own top-right
        // corner. Built directly at its final rect (never constructed at a
        // placeholder position and repositioned via setPosition afterward,
        // per CLAUDE.md's "setPosition after addMorph can corrupt a
        // morph's own render tree" gotcha) — finalW is already known here,
        // so there's no measure-then-reposition step needed. Same
        // Text-morph-as-icon-button idiom as the settings gear on the
        // panel itself (AmbientPresencePanel.js's makeIconButton).
        if (this._isController) {
          // EDIT/EDIT_GLYPH_PX/EDIT_MARGIN already declared above (topRightReserve).
          var editBtn = new lively.morphic.Text(
            lively.rect(finalW - EDIT_MARGIN - EDIT, EDIT_MARGIN, EDIT, EDIT), "edit");
          editBtn.applyStyle({
            fontFamily: "'Material Symbols Rounded'",
            fontSize: EDIT_GLYPH_PX * 0.75,
            textColor: Color.rgb(90, 90, 90),
            fill: Color.rgba(255, 255, 255, 0.92),
            borderRadius: EDIT / 2,
            borderWidth: 1,
            borderColor: Color.rgb(224, 224, 224),
            align: "center",
            padding: lively.Rectangle.inset(0, Math.round((EDIT - EDIT_GLYPH_PX) / 2), 0, 0),
            allowInput: false,
            selectable: false,
            clipMode: "hidden",
            whiteSpaceHandling: "pre",
            handStyle: "pointer",
          });
          noDrag(editBtn);
          editBtn.toolTip = "Edit event";
          editBtn.onMouseOver = function () { editBtn.applyStyle({ fill: Color.rgb(238, 238, 238) }); };
          editBtn.onMouseOut = function () { editBtn.applyStyle({ fill: Color.rgba(255, 255, 255, 0.92) }); };
          editBtn.onMouseUp = function (evt) {
            lively.identity.EditEventDialog.open(self._name, ev, function () {
              self._refreshQuickInfo();
            });
            evt.stop();
            return true;
          };
          card.addMorph(editBtn);
        }

        // Pinned to the top-right corner of the region handed to this
        // function, with equal margins on both sides: RIGHT_MARGIN from
        // the panel's right edge (finalX — since maxCardW already reserved
        // RIGHT_MARGIN, sitting flush against maxCardW's own right edge
        // lands exactly there) and that same RIGHT_MARGIN below cardY,
        // this region's own top edge (finalY — maxCardH above already
        // reserved room for it too). Never left of cardX regardless of
        // how narrow the card ends up, since finalW <= maxCardW by
        // construction — that's what keeps it clear of the avatar/title/
        // detail-lines column to its left.
        var finalX = cardX + maxCardW - finalW;
        var finalY = cardY + RIGHT_MARGIN;
        card.setPosition(lively.pt(finalX, finalY));
      },

      _formatDate: function (iso) {
        if (!iso) return "—";
        var d = new Date(iso);
        if (isNaN(d.getTime())) return String(iso);
        return d.toLocaleDateString();
      },

      // Renders an ISO 8601 datetime string (e.g. "2025-12-03T14:00:00+06:00")
      // as "Wed, Dec 3, 2025 at 2 PM +06" — always in the event's own
      // stored UTC offset, not the viewer's local timezone (an event's
      // wall-clock time shouldn't shift per-viewer), so this parses the
      // string's numeric fields directly rather than going through
      // `new Date(iso)` + toLocale*, which would silently convert to the
      // browser's local zone instead.
      //
      // Abbreviated weekday/month (full names were tried first) —
      // confirmed live on the event card: the full "Wednesday, September
      // 16, 2026 at 8:36 PM -07" needs ~357px on one line, well past this
      // card's ~268px contentW, and this label has no wrap/ellipsis of its
      // own (single-line "pre", clipMode:"visible"), so the overflow spilled
      // out of its own box and got hard-clipped by the card's own
      // clipMode:"hidden" border — the trailing time/offset was silently
      // gone. Every month keeps a plain 3-letter abbreviation except
      // September, kept 4 letters ("Sept") to read unambiguously as
      // September rather than looking like a typo'd "Sep".
      _formatEventDateTime: function (iso) {
        var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(iso || "");
        if (!m) return iso || "";
        var year = +m[1], month = +m[2], day = +m[3], hour = +m[4], minute = +m[5];
        var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"];
        var weekday = DAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
        var ampm = hour >= 12 ? "PM" : "AM";
        var hour12 = hour % 12 || 12;
        var timeStr = hour12 + (minute ? (":" + (minute < 10 ? "0" : "") + minute) : "") + " " + ampm;
        var offsetStr = "";
        var offRaw = m[7];
        if (offRaw && offRaw !== "Z") {
          var om = /^([+-])(\d{2}):?(\d{2})$/.exec(offRaw);
          if (om) offsetStr = " " + om[1] + om[2] + (om[3] !== "00" ? (":" + om[3]) : "");
        }
        return weekday + ", " + MONTHS[month - 1] + " " + day + ", " + year + " at " + timeStr + offsetStr;
      },
    },

    // ─── postcard turnover reel ────────────────────────────────────────────

    "reel", {
      // Also remembers q so picking a sort option re-fetches under the same
      // search. Stellar/Goosed come back as one server-ranked page (no
      // cursor), so ask for the route's maximum up front.
      _fetchFeed: function (q) {
        var self = this;
        this._feedQuery = q || null;
        var base = lively.identity.did.baseUrl();
        var sort = SORT_PARAMS[this._sortSelection] || null;
        var url = base + "/c/" + encodeURIComponent(this._name) + "/feed?limit=" + (sort ? 100 : 20);
        if (sort) url += "&sort=" + sort;
        if (q) url += "&q=" + encodeURIComponent(q);
        var xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) return self._showError("Failed to load feed (" + xhr.status + ")");
          var data;
          try { data = JSON.parse(xhr.responseText); } catch (e) { return; }
          self._feedCards = data.postcards || [];
          self._feedCursor = data.cursor || null;
          self._activeIndex = self._feedCards.length ? 0 : -1;
          self._showActiveCard();
          // _feedCards was just wholesale replaced (a fresh search/sort),
          // not appended to — the Scroll view's rows have to be torn down
          // and rebuilt from scratch too, not just appended onto (see
          // _maybeLoadMore below for the append case). No-op while Scroll
          // mode has never been opened (_scrollListBox still null).
          if (self._scrollListBox) {
            (self._scrollListBox.submorphs || []).slice().forEach(function (m) { m.remove(); });
            self._scrollRows = {};
            self._scrollExpandedObjId = null;
            self._renderScrollList();
          }
        };
        xhr.onerror = function () { self._showError("Network error loading feed"); };
        xhr.send();
      },

      _maybeLoadMore: function (thenDo) {
        if (!this._feedCursor) return thenDo(false);
        var self = this;
        var base = lively.identity.did.baseUrl();
        var url = base + "/c/" + encodeURIComponent(this._name) + "/feed?limit=20&cursor=" + encodeURIComponent(this._feedCursor);
        var xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) return thenDo(false);
          var data;
          try { data = JSON.parse(xhr.responseText); } catch (e) { return thenDo(false); }
          self._feedCards = self._feedCards.concat(data.postcards || []);
          self._feedCursor = data.cursor || null;
          // Append-only: _renderScrollList only ever creates rows for
          // _feedCards entries that don't already have a _scrollRows
          // entry, so this never re-mounts/re-fetches an already-rendered
          // row — just adds rows for whatever this page just added.
          if (self._scrollListBox) self._renderScrollList();
          thenDo((data.postcards || []).length > 0);
        };
        xhr.onerror = function () { thenDo(false); };
        xhr.send();
      },

      // direction: -1 (older) or 1 (newer). Strictly moves the top-level
      // stack position — reply-thread focus never affects this (confirmed
      // requirement: replies don't reorder or otherwise move the stack).
      //
      // Tinder-style swipe: the active card is flicked off-screen (translate
      // + rotate + fade, exiting left for "next"/+1, right for "previous"/-1
      // — see the file-header comment for why that's the opposite of this
      // panel's own left=older/right=newer button layout), then the new
      // card is snapped into a smaller "just-revealed" state and eased up
      // to full size/opacity, mimicking a card being promoted off the
      // bottom of a stack.
      // Cycles past either end instead of dead-ending: going past the
      // newest card wraps to the last loaded (oldest) one, and going past
      // the last loaded card — once _maybeLoadMore confirms there's
      // genuinely nothing further to page in — wraps back to the newest.
      // A single-card feed has nothing to wrap to, so it no-ops both ways,
      // same as the old non-cyclic behavior did at either boundary.
      _turn: function (direction) {
        var self = this;
        var nextIndex = this._activeIndex + direction;
        if (nextIndex < 0) {
          if (this._feedCards.length <= 1) return;
          return this._animateTurn(direction, this._feedCards.length - 1);
        }
        if (nextIndex >= this._feedCards.length) {
          return this._maybeLoadMore(function (loaded) {
            if (loaded) return self._turn(direction);
            if (self._feedCards.length <= 1) return;
            self._animateTurn(direction, 0);
          });
        }
        this._animateTurn(direction, nextIndex);
      },

      _animateTurn: function (direction, nextIndex) {
        var self = this;
        var exitSign = direction > 0 ? -1 : 1;
        var frontNode = this._frontCardBox.renderContext().shapeNode;
        frontNode.style.transition = "transform 260ms cubic-bezier(.4,0,1,1), opacity 260ms ease-in";
        frontNode.style.transform = "translate(" + (exitSign * 620) + "px, 36px) rotate(" + (exitSign * 18) + "deg)";
        frontNode.style.opacity = "0";

        setTimeout(function () {
          self._activeIndex = nextIndex;
          self._showActiveCard();
          frontNode.style.transition = "none";
          frontNode.style.transform = "translate(0px, 0px) scale(0.92)";
          frontNode.style.opacity = "0";
          // Force layout before re-enabling the transition, so the
          // settle-in animates rather than snapping.
          frontNode.offsetHeight;
          frontNode.style.transition = "transform 260ms cubic-bezier(0,0,.2,1), opacity 220ms ease-out";
          frontNode.style.transform = "translate(0px, 0px) scale(1)";
          frontNode.style.opacity = "1";
        }, 260);
      },

      _showActiveCard: function () {
        var card = this._feedCards[this._activeIndex];
        if (!card) return;
        this._renderNavPosition();
        this._renderCardInto(this._frontCardBox, card.objId);
        this._loadThread(card.objId);
      },

      // Shows a specific postcard in the reel — used by the map's pin click.
      // If it's already in the loaded feed, just jump to its index. The map
      // lists every located card while the reel has only paged in the newest
      // 20+, so otherwise keep paging until it appears (bounded), which
      // keeps "N / M" and prev/next order consistent with the feed. If it
      // never shows up (e.g. an active search filtered it out), render it
      // directly and leave the nav position alone. A newer call supersedes
      // an in-flight paging loop via _reelJumpToken.
      _showCardInReel: function (objId) {
        var self = this;
        var MAX_CARDS = 500;   // same ceiling as ConstellationMap's MAX_PINS
        var jump = this._reelJumpToken = (this._reelJumpToken || 0) + 1;

        function indexOfCard() {
          for (var i = 0; i < self._feedCards.length; i++) {
            if (self._feedCards[i].objId === objId) return i;
          }
          return -1;
        }
        function showDirectly() {
          self._renderCardInto(self._frontCardBox, objId);
          self._loadThread(objId);
        }
        (function step() {
          if (self._reelJumpToken !== jump) return;
          var idx = indexOfCard();
          if (idx >= 0) {
            self._activeIndex = idx;
            return self._showActiveCard();
          }
          if (!self._feedCursor || self._feedCards.length >= MAX_CARDS) return showDirectly();
          self._maybeLoadMore(function (loaded) {
            if (self._reelJumpToken !== jump) return;
            if (loaded) step(); else showDirectly();
          });
        })();
      },

      _renderNavPosition: function () {
        this._navLabel.textString = (this._activeIndex + 1) + " / " + this._feedCards.length + (this._feedCursor ? "+" : "");
        // Cosmetic only — _turn already no-ops when there's truly nothing
        // to cycle to, this just greys the arrow out instead of leaving it
        // looking clickable when it can't do anything. With wraparound,
        // position within the loaded set no longer matters: prev can
        // always reach the last loaded card as long as there's more than
        // one, and next can always either advance/wrap or page in more.
        var hasMoreThanOne = this._feedCards.length > 1;
        this._setNavBtnEnabled(this._prevBtn, hasMoreThanOne);
        this._setNavBtnEnabled(this._nextBtn, hasMoreThanOne || !!this._feedCursor);
      },

      // Circular Material-Symbols icon button for the reel's prev/next
      // turn controls — same "Text morph styled as a round icon button"
      // idiom as _renderQuickInfoMap's "arrow_back" button (white fill,
      // hairline border, pointer cursor, hover shade), just chevron glyphs
      // instead of a single fixed back action.
      _buildNavChevronButton: function (glyph, direction, x) {
        var self = this;
        var D = NAV_BTN_D, GLYPH_PX = 18;
        var btn = new lively.morphic.Text(lively.rect(x, 0, D, D));
        btn.textString = glyph;
        btn._navFill = Color.white;
        btn._navFillHover = Color.rgb(0xF7, 0xF2, 0xF4);
        btn.applyStyle({
          fontFamily: "'Material Symbols Rounded'",
          fontSize: GLYPH_PX * 0.75,
          textColor: Color.rgb(90, 90, 90),
          fill: btn._navFill,
          borderRadius: D / 2,
          borderWidth: 1,
          borderColor: Color.rgb(224, 224, 224),
          align: "center",
          padding: lively.Rectangle.inset(0, Math.round((D - GLYPH_PX) / 2), 0, 0),
          allowInput: false,
          selectable: false,
          clipMode: "hidden",
          whiteSpaceHandling: "pre",
          handStyle: "pointer",
        });
        btn.toolTip = direction < 0 ? "Previous postcard" : "Next postcard";
        btn.onMouseOver = function () { if (!btn._navDisabled) btn.applyStyle({ fill: btn._navFillHover }); };
        btn.onMouseOut = function () { if (!btn._navDisabled) btn.applyStyle({ fill: btn._navFill }); };
        btn.onMouseUp = function (evt) {
          if (!btn._navDisabled) self._turn(direction);
          evt.stop();
          return true;
        };
        return btn;
      },

      // Greys an arrow out (and drops the pointer cursor/click) once it's
      // at a real boundary, instead of leaving it looking live forever —
      // _turn itself already no-ops there, this is purely visual.
      _setNavBtnEnabled: function (btn, enabled) {
        if (!btn) return;
        btn._navDisabled = !enabled;
        btn.applyStyle({
          textColor: enabled ? Color.rgb(90, 90, 90) : Color.rgb(205, 205, 205),
          fill: btn._navFill,
          handStyle: enabled ? "pointer" : "default",
        });
      },

      // The "N / M" badge between the two chevrons — a plain centered Text
      // label; the pink pill background behind it is a separate sibling
      // Box (_buildChrome adds it via addMorphBack) so this label itself
      // only ever needs fill:null/no border, same split already used
      // elsewhere in this file for text-over-painted-background morphs.
      _buildNavCountPill: function () {
        var label = lively.morphic.Text.makeLabel("", {
          fontSize: 13, fontWeight: "600", textColor: Color.rgb(90, 90, 90), fixedWidth: true, fixedHeight: true,
        });
        label.setExtent(lively.pt(NAV_PILL_W, 18));
        label.applyStyle({ align: "center", fill: null, borderWidth: 0 });
        label.allowInput = false;
        label.selectable = false;
        return label;
      },

      // Fetches the full envelope via the constellation-scoped, handle-free
      // GET /c/:name/:objId route (validates constellation membership
      // itself), resolves the author's handle (PostCardView/WikiView both
      // assume a real handle — avatar loading and, on PostCardView, the
      // approve/decline join-request URLs are built from it — so passing
      // null would silently break more than just the "@" label), and
      // embeds it, clearing any previous occupant first.
      //
      // Each call takes a per-box token; a fetch/handle callback that comes
      // back after a newer call has started for the same box drops its
      // result. Without it, two quick renders (e.g. two map-pin clicks) each
      // clear the box up front and then both embed once their async fetches
      // return, stacking two cards.
      // extraOpts (additive 3rd param, Scroll view only — the Reel's own
      // call sites below pass none, so they're unaffected): merged into
      // PostCardView/WikiView.open's own opts, e.g. {showCommentChip: true,
      // commentCount, onToggleComments}. The created view is stashed on
      // box._renderedView so a caller (e.g. the mini-thread accordion) can
      // reach it later without threading it through another callback.
      _renderCardInto: function (box, objId, extraOpts) {
        var self = this;
        var token = box._cardRenderToken = (box._cardRenderToken || 0) + 1;
        (box.submorphs || []).slice().forEach(function (m) { m.remove(); });
        this._fetchEnvelope(objId, function (err, envelope) {
          if (err || !envelope || box._cardRenderToken !== token) return;
          self._resolveHandle(envelope.did, function (handle) {
            if (box._cardRenderToken !== token) return;
            var opts = { target: box, envelope: envelope, pinkHandle: true, bounds: lively.rect(0, 0, box.getExtent().x, box.getExtent().y) };
            if (extraOpts) Object.keys(extraOpts).forEach(function (k) { opts[k] = extraOpts[k]; });
            if (envelope.type === "wikipage") {
              box._renderedView = lively.identity.WikiView.open(handle, objId, opts);
            } else {
              // previewMode: both the Reel and the Scroll view (full-card
              // rows, via _renderScrollList) render a postcard as a
              // "browse many" preview rather than being opened directly —
              // reorder its content media-forward (see
              // PostCardView._renderContentHtml). Every other
              // PostCardView.open call site in the app keeps natural
              // document order (opt-in flag, default false).
              opts.previewMode = true;
              box._renderedView = lively.identity.PostCardView.open(handle, objId, opts);
            }
            // Content may still be laying out / decrypting right after
            // open(), so re-measure a couple of times — for the Reel's one
            // singleton card, or (box._scrollRow, tagged by
            // _renderScrollList) a Scroll-view row.
            [60, 500, 1800].forEach(function (ms) {
              setTimeout(function () {
                if (box._cardRenderToken !== token) return;
                if (box === self._frontCardBox) self._fitCardToContent();
                else if (box._scrollRow) self._fitScrollRowToContent(box._scrollRow);
              }, ms);
            });
          });
        });
      },

      // Shared by the Reel's singleton card (_fitCardToContent) and every
      // Scroll-view row (_fitScrollRowToContent) — measures a card box's
      // real content height (its last child's bottom edge, not
      // scrollHeight, which can't report less than the box's own current
      // height and so could never shrink the card back down), clamped to
      // [CARD_H, CARD_H_MAX]. 76px header above the content area, 26px
      // reactions footer below it (PostCardView._buildChrome).
      _measureCardContentHeight: function (box) {
        var content = box.renderContext().shapeNode.querySelector(".lively-postcard-view-content");
        if (!content || !content.lastElementChild) return CARD_H;
        var last = content.lastElementChild;
        var contentH = last.offsetTop + last.offsetHeight + 14;   // + content's bottom padding
        return Math.max(CARD_H, Math.min(CARD_H_MAX, 76 + contentH + 26));
      },

      // The reel card is CARD_H tall by default and grows (up to CARD_H_MAX)
      // when its content needs more room — e.g. a photo gallery — instead of
      // scrolling inside a fixed box. Content taller than the max scrolls
      // inside the card.
      _fitCardToContent: function () {
        var box = this._frontCardBox;
        if (!box) return;
        var h = this._measureCardContentHeight(box);
        if (h !== (this._cardH || CARD_H)) {
          this._cardH = h;
          this._layout();
        }
      },

      // Per-row equivalent of _fitCardToContent for the Scroll view: grows/
      // shrinks a row's own box (and its embedded card view) to its real
      // content height, repositions the comment-thread accordion panel
      // if one is open below it, and reflows every row's position.
      _fitScrollRowToContent: function (row) {
        var h = this._measureCardContentHeight(row.box);
        if (h === row.cardH) return;
        row.cardH = h;
        var w = row.box.getExtent().x;
        row.box.setExtent(lively.pt(w, row.expanded ? h + row.threadH : h));
        if (row.box._renderedView) row.box._renderedView.setExtent(lively.pt(w, h));
        if (row.expanded && row.threadWrap) row.threadWrap.setPosition(lively.pt(0, h));
        this._relayoutScrollRows();
      },

      _fetchEnvelope: function (objId, thenDo) {
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("GET", base + "/c/" + encodeURIComponent(this._name) + "/" + encodeURIComponent(objId), true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) return thenDo(new Error("status " + xhr.status));
          try { thenDo(null, JSON.parse(xhr.responseText)); } catch (e) { thenDo(e); }
        };
        xhr.onerror = function () { thenDo(new Error("network error")); };
        xhr.send();
      },

      // Single-DID convenience over the same GET /dids/handles batch route
      // WikiView.js's own _resolveHandles and IdentityServer.js's
      // _resolveHandlesForDids use. Calls thenDo(handle|null) — never
      // thenDo(err, ...), since a lookup failure just means the caller
      // falls back to whatever null-handle behavior it already has.
      _resolveHandle: function (did, thenDo) {
        if (!did) return thenDo(null);
        var qi = this._quickInfo || {};
        if (qi.memberHandles && qi.memberHandles[did]) return thenDo(qi.memberHandles[did]);
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("GET", base + "/dids/handles?dids=" + encodeURIComponent(did), true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) return thenDo(null);
          try {
            var data = JSON.parse(xhr.responseText);
            thenDo((data.handles && data.handles[did]) || null);
          } catch (e) { thenDo(null); }
        };
        xhr.onerror = function () { thenDo(null); };
        xhr.send();
      },
    },

    // ─── Scroll view — a second, user-selectable postcard layout ──────────
    // A vertical list of full-size postcard rows (same card as the Reel,
    // full feature parity — flip/back-face, the more menu),
    // alongside the default Reel. Reuses _feedCards/_fetchFeed/
    // _maybeLoadMore directly (no parallel fetch path) and
    // PostCardView.open's showCommentChip flag to put a comment-icon chip
    // on an otherwise-full card — this section is almost entirely new UI,
    // not new data plumbing. Each row's chip, clicked, expands an inline
    // accordion below that row (single-select — expanding one collapses
    // whichever other row was open) and scrolls that row to the top of the
    // viewport (_scrollRowIntoFocus). A row's own height is measured from
    // its real rendered content (_fitScrollRowToContent), not a flat
    // constant — see _measureCardContentHeight, shared with the Reel's own
    // _fitCardToContent. The accordion deliberately does NOT
    // reuse _loadThread/_renderThreadTree (the "thread" section below) —
    // those mutate singleton instance fields (_threadContainer,
    // _draftText[key] with bare keys) that would collide across N
    // simultaneously-expandable rows. Instead it reuses the *stateless*
    // data-fetch helpers from that section verbatim (_loadReplyLevel,
    // _fetchReplies, _hydrateReplies, _resolveHandlesBatch,
    // _extractReplyBodyHtml, _submitReply) and keeps its own state in
    // row.miniThread.
    "scroll view", {
      _buildViewToggle: function () {
        var self = this;
        var box = new lively.morphic.Box(lively.rect(0, 0, VIEW_TOGGLE_W, VIEW_TOGGLE_H));
        box.applyStyle({
          fill: Color.white, borderWidth: 1, borderColor: Color.rgb(224, 224, 224),
          borderRadius: VIEW_TOGGLE_H / 2, clipMode: "hidden",
        });

        function makeBtn(glyph, mode, x, tip) {
          var BW = VIEW_TOGGLE_W / 2, GLYPH_PX = 18;
          var btn = new lively.morphic.Text(lively.rect(x, 0, BW, VIEW_TOGGLE_H), glyph);
          btn.applyStyle({
            fontFamily: "'Material Symbols Rounded'",
            fontSize: GLYPH_PX * 0.75,
            textColor: Color.rgb(90, 90, 90),
            fill: null,
            borderWidth: 0,
            align: "center",
            padding: lively.Rectangle.inset(0, Math.round((VIEW_TOGGLE_H - GLYPH_PX) / 2), 0, 0),
            allowInput: false,
            selectable: false,
            clipMode: "hidden",
            whiteSpaceHandling: "pre",
            handStyle: "pointer",
          });
          btn.toolTip = tip;
          btn._mode = mode;
          btn.onMouseUp = function (evt) {
            self._switchViewMode(mode);
            evt.stop();
            return true;
          };
          box.addMorph(btn);
          return btn;
        }

        this._reelToggleBtn = makeBtn("view_carousel", "reel", 0, "Reel view");
        this._scrollToggleBtn = makeBtn("view_list", "scroll", VIEW_TOGGLE_W / 2, "Scroll view");
        return box;
      },

      _updateViewToggleStyle: function () {
        var active = Color.rgb(232, 73, 126), activeBg = Color.rgb(253, 238, 243);
        var inactive = Color.rgb(90, 90, 90);
        [this._reelToggleBtn, this._scrollToggleBtn].forEach(function (btn) {
          if (!btn) return;
          var isActive = btn._mode === this._viewMode;
          btn.applyStyle({ textColor: isActive ? active : inactive, fill: isActive ? activeBg : null });
        }, this);
      },

      // Toggles visibility of the two mutually-exclusive clusters — Reel
      // (_frontCardBox/_backCardBox/_navBox/_threadContainer) vs. Scroll
      // (_scrollListBox, built lazily on first switch). Both keep being
      // driven by _fetchFeed/_turn/etc. regardless of which is currently
      // visible (cheap, keeps either one "warm" so switching back shows
      // up to date content) — this only ever touches visibility + (for
      // Scroll) the lazy build/initial render.
      _switchViewMode: function (mode) {
        if (this._viewMode === mode) return;
        this._viewMode = mode;
        var showReel = mode === "reel";
        [this._frontCardBox, this._backCardBox, this._navBox, this._threadContainer].forEach(function (m) {
          if (m) m.setVisible(showReel);
        });
        if (mode === "scroll") {
          if (!this._scrollListBox) this._buildScrollListBox();
          this._scrollListBox.setVisible(true);
          this._layout();
          this._renderScrollList();
        } else if (this._scrollListBox) {
          this._scrollListBox.setVisible(false);
        }
        this._updateViewToggleStyle();
      },

      _buildScrollListBox: function () {
        var self = this;
        var box = new lively.morphic.Box(lively.rect(0, 0, 10, 10));
        box.setFill(Color.white);
        box.applyStyle({ borderWidth: 1, borderColor: Color.rgb(238, 238, 238), borderRadius: 8 });
        box.renderContext().shapeNode.style.overflowY = "auto";
        // Same light-pink pill-thumb scrollbar treatment as _spacesBox/
        // _membersBox (_ensureCommentBodyStyle) — no new CSS needed.
        box.renderContext().shapeNode.classList.add("lounge-listing-panel");
        this._disableDragging(box);
        $world.addMorph(box);
        this._scrollListBox = box;

        var node = box.renderContext().shapeNode;
        node.addEventListener("scroll", function () {
          if (self._viewMode !== "scroll" || self._scrollLoadingMore) return;
          if (node.scrollTop + node.clientHeight < node.scrollHeight - 300) return;
          self._scrollLoadingMore = true;
          self._maybeLoadMore(function () { self._scrollLoadingMore = false; });
        });
      },

      // Append-only: only creates rows for _feedCards entries that don't
      // already have a _scrollRows entry — never re-mounts/re-fetches an
      // already-rendered row. Called after every _fetchFeed (having first
      // cleared _scrollRows itself — see there) and after every
      // _maybeLoadMore, so this is the single place new rows get created
      // regardless of which triggered the feed to grow.
      _renderScrollList: function () {
        var self = this;
        if (!this._scrollListBox) return;
        var w = Math.max(100, this._scrollListBox.getExtent().x - MINI_ROW_PAD_X * 2);
        this._feedCards.forEach(function (card) {
          if (self._scrollRows[card.objId]) return;
          var rowBox = new lively.morphic.Box(lively.rect(0, 0, w, CARD_H));
          rowBox.applyStyle({ fill: null, borderWidth: 0, clipMode: "visible" });
          self._disableDragging(rowBox);
          self._scrollListBox.addMorph(rowBox);
          var row = self._scrollRows[card.objId] = {
            box: rowBox, objId: card.objId, cardH: CARD_H, expanded: false,
            threadWrap: null, threadH: 0, miniThread: null, commentCount: 0,
          };
          rowBox._scrollRow = row;
          // extraOpts is passed BY REFERENCE into _renderCardInto, which
          // doesn't actually read it until its own async envelope+handle
          // fetch resolves (inside that later callback) — so mutating
          // commentCount on this same object below, whenever the parallel
          // replies-count fetch resolves, is picked up correctly regardless
          // of which of the two fetches finishes first. Without this, a
          // replies fetch that happens to resolve before the (two-hop)
          // envelope+handle fetch would silently drop its count: the
          // rowBox._renderedView guard below finds no view yet to call
          // setCommentCount on, and a plain value (snapshotted at call
          // time) would stay stuck at 0 forever once the view does open.
          var extraOpts = {
            showCommentChip: true,
            commentCount: 0,
            onToggleComments: self._onMiniCommentToggle.bind(self, card.objId),
          };
          self._renderCardInto(rowBox, card.objId, extraOpts);
          self._fetchReplies(card.objId, function (err, replies) {
            var count = (!err && replies) ? replies.length : 0;
            row.commentCount = count;
            extraOpts.commentCount = count;
            if (rowBox._renderedView && rowBox._renderedView.setCommentCount) {
              rowBox._renderedView.setCommentCount(count);
            }
          });
        });
        this._relayoutScrollRows();
      },

      // Re-tracks every row's width (and the embedded card's own extent —
      // PostCardView's internal DOM is fluid CSS, same as the Reel card)
      // whenever _scrollListBox's own extent changes (_layout, on every
      // resize tick) — cheap position/extent writes, no rebuild.
      _resizeScrollRowsWidth: function () {
        if (!this._scrollListBox) return;
        var self = this;
        var w = Math.max(100, this._scrollListBox.getExtent().x - MINI_ROW_PAD_X * 2);
        Object.keys(this._scrollRows).forEach(function (objId) {
          var row = this._scrollRows[objId];
          row.box.setExtent(lively.pt(w, row.box.getExtent().y));
          if (row.box._renderedView) row.box._renderedView.setExtent(lively.pt(w, row.cardH));
          if (row.threadWrap) row.threadWrap.setExtent(lively.pt(w, row.threadWrap.getExtent().y));
        }, this);
        this._relayoutScrollRows();
        // A width change reflows wrapped text, which can change a card's
        // real content height — re-fit every row once layout settles
        // (debounced across repeated resize ticks).
        clearTimeout(this._scrollResizeFitTimer);
        this._scrollResizeFitTimer = setTimeout(function () {
          Object.keys(self._scrollRows).forEach(function (objId) {
            self._fitScrollRowToContent(self._scrollRows[objId]);
          });
        }, 80);
      },

      // Recomputes every row's y from accumulated heights, in _feedCards
      // order — "free" list reflow since rows are laid out by accumulating
      // y (same idiom _renderCommentLevel/_renderThreadTree already use
      // within one container, applied here across sibling row boxes
      // instead). A row's own height is cardH, plus its thread accordion's
      // height when expanded.
      _relayoutScrollRows: function () {
        var y = MINI_ROW_PAD_TOP;
        this._feedCards.forEach(function (card) {
          var row = this._scrollRows[card.objId];
          if (!row) return;
          row.box.setPosition(lively.pt(MINI_ROW_PAD_X, y));
          var h = row.cardH + (row.expanded ? row.threadH : 0);
          y += h + MINI_ROW_GAP;
        }, this);
      },

      // Single-select accordion: collapses whichever other row was open
      // (if any) before expanding this one; a second click on the already-
      // expanded row just collapses it.
      _onMiniCommentToggle: function (objId) {
        var row = this._scrollRows[objId];
        if (!row) return;
        if (this._scrollExpandedObjId === objId) {
          this._collapseMiniRow(row);
          this._scrollExpandedObjId = null;
          this._relayoutScrollRows();
          return;
        }
        if (this._scrollExpandedObjId && this._scrollRows[this._scrollExpandedObjId]) {
          this._collapseMiniRow(this._scrollRows[this._scrollExpandedObjId]);
        }
        this._scrollExpandedObjId = objId;
        this._expandMiniRow(row);
        this._scrollRowIntoFocus(row);
      },

      // Auto-scrolls the Scroll-view list so `row`'s top edge aligns with
      // the top of the visible viewport — called once, right after
      // expanding a row's comment accordion. A row's own top y is
      // unaffected by its own expansion (only rows after it shift down
      // when _relayoutScrollRows re-accumulates), so there's no need to
      // re-call this once the async thread content finishes loading.
      _scrollRowIntoFocus: function (row) {
        if (!this._scrollListBox) return;
        var node = this._scrollListBox.renderContext().shapeNode;
        node.scrollTop = Math.max(0, row.box.getPosition().y - MINI_ROW_PAD_TOP);
      },

      // W/S and Up/Down arrow keyboard scrolling for the Scroll view (see
      // the keydown handler in _buildChrome) — a no-op (returns false, so
      // the caller doesn't preventDefault) outside Scroll mode or before
      // the list box has been built. Step is a fraction of the visible
      // viewport rather than a flat constant so it scales with window size
      // the same way a "page" scroll would, with a floor so it's never too
      // small on a short window.
      _scrollListBy: function (dir) {
        if (this._viewMode !== "scroll" || !this._scrollListBox) return false;
        var node = this._scrollListBox.renderContext().shapeNode;
        var step = Math.max(120, Math.round(node.clientHeight * 0.4));
        node.scrollTop = Math.max(0, Math.min(node.scrollHeight - node.clientHeight, node.scrollTop + dir * step));
        return true;
      },

      _expandMiniRow: function (row) {
        var self = this;
        row.expanded = true;
        var view = row.box._renderedView;
        if (view && view.setCommentsExpanded) view.setCommentsExpanded(true);
        if (!row.threadWrap) {
          row.threadWrap = new lively.morphic.Box(lively.rect(0, row.cardH, row.box.getExtent().x, 10));
          row.threadWrap.applyStyle({ fill: null, borderWidth: 0, clipMode: "visible" });
          this._disableDragging(row.threadWrap);
          row.box.addMorph(row.threadWrap);
        } else {
          row.threadWrap.setPosition(lively.pt(0, row.cardH));
          row.threadWrap.setVisible(true);
        }
        if (!row.miniThread) {
          row.miniThread = {
            replies: [], childrenCache: {}, expanded: {}, replyBoxOpenFor: null,
            draftText: {}, bodyBoxCache: {}, rerenderTimer: null,
            composer: this._newComposerState(),
          };
          this._renderMiniThreadLoading(row);
          this._loadReplyLevel(row.objId, function (err, replies) {
            row.miniThread.replies = err ? [] : replies;
            self._renderMiniThread(row);
          });
        } else {
          this._renderMiniThread(row);
        }
      },

      // Hides (doesn't discard — row.miniThread stays cached across
      // re-expands) the accordion and shrinks the row's box back down.
      _collapseMiniRow: function (row) {
        row.expanded = false;
        var view = row.box._renderedView;
        if (view && view.setCommentsExpanded) view.setCommentsExpanded(false);
        if (row.threadWrap) row.threadWrap.setVisible(false);
        row.box.setExtent(lively.pt(row.box.getExtent().x, row.cardH));
      },

      _renderMiniThreadLoading: function (row) {
        if (this._scrollExpandedObjId !== row.objId || !row.threadWrap) return;
        (row.threadWrap.submorphs || []).slice().forEach(function (m) { m.remove(); });
        var loading = lively.morphic.Text.makeLabel("Loading comments…", { fontSize: 12, textColor: Color.gray });
        loading.setPosition(lively.pt(COMMENT_PAD_X, COMMENT_TOP_MARGIN));
        row.threadWrap.addMorph(loading);
        var h = COMMENT_TOP_MARGIN + 26;
        row.threadH = h;
        row.threadWrap.setExtent(lively.pt(row.threadWrap.getExtent().x, h));
        row.box.setExtent(lively.pt(row.box.getExtent().x, row.cardH + h));
        this._relayoutScrollRows();
      },

      // Mirrors _renderThreadTree's visual layout (same constants/avatar/
      // header/body/reply-toggle idiom, same empty-state copy) but writes
      // into row.threadWrap and reads/writes row.miniThread.* instead of
      // this._thread*/this._draftText — see the "thread" section's
      // _renderThreadTree for the original this mirrors. Guards against a
      // stale async callback firing after this row was collapsed (or a
      // different row expanded) in the meantime.
      _renderMiniThread: function (row) {
        if (this._scrollExpandedObjId !== row.objId || !row.threadWrap) return;
        var mt = row.miniThread;
        var container = row.threadWrap;
        (container.submorphs || []).slice().forEach(function (m) { m.remove(); });
        var w = (container.getExtent().x || THREAD_W) - COMMENT_PAD_X * 2;

        var y = this._renderMiniComposerIfSignedIn(
          row, container, "ROOT", row.objId, COMMENT_PAD_X, COMMENT_TOP_MARGIN, w, "Add a comment");
        y += 10;

        if (!mt.replies.length) {
          var empty = lively.morphic.Text.makeLabel("No comments yet — be the first to reply.", { fontSize: 12, textColor: Color.gray });
          empty.setPosition(lively.pt(COMMENT_PAD_X, y));
          empty.setExtent(lively.pt(w, 16));
          container.addMorph(empty);
          y += 26;
        } else {
          y = this._renderMiniCommentLevel(row, container, mt.replies, 0, y, w);
        }
        this._disableDragging(container);

        var h = y + 10;
        row.threadH = h;
        container.setExtent(lively.pt(container.getExtent().x, h));
        row.box.setExtent(lively.pt(row.box.getExtent().x, row.cardH + h));
        this._relayoutScrollRows();
      },

      _renderMiniCommentLevel: function (row, container, replies, depth, y, w) {
        var self = this;
        replies.forEach(function (reply) {
          y = self._renderMiniCommentNode(row, container, reply, depth, y, w);
        });
        return y;
      },

      // Mirrors _renderCommentNode exactly (geometry, caching, reply/
      // replies-toggle behavior) — only the state it reads/writes differs
      // (row.miniThread.* instead of this.*) and recursive re-renders call
      // _renderMiniThread(row) instead of _renderThreadTree().
      _renderMiniCommentNode: function (row, container, reply, depth, y, w) {
        var self = this;
        var mt = row.miniThread;
        var x = COMMENT_PAD_X + depth * COMMENT_INDENT;
        var rowW = w - depth * COMMENT_INDENT;
        var topY = y;

        var avatar = new lively.morphic.Image(lively.rect(0, 0, COMMENT_AVATAR, COMMENT_AVATAR));
        avatar.setImageURL(lively.identity.postCardUtils.identiconDataUrl(reply.did, COMMENT_AVATAR));
        avatar.applyStyle({ borderRadius: COMMENT_AVATAR / 2, borderWidth: 0, clipMode: "hidden" });
        container.addMorph(avatar);
        avatar.setPosition(lively.pt(x, y));

        var textX = x + COMMENT_AVATAR + 4;
        var textW = Math.max(60, rowW - COMMENT_AVATAR - 4);

        var handleStr = "@" + (reply._handle || (reply.did || "").slice(0, 10) + "…");
        var header = lively.morphic.Text.makeLabel(
          handleStr + "  ·  " + self._formatRelativeTime(reply.created),
          { fontSize: 10.5, textColor: COMMENT_META_COLOR });
        container.addMorph(header);
        header.emphasize({ color: Color.rgb(0xCC, 0x00, 0x57) }, 0, handleStr.length);
        header.setPosition(lively.pt(textX, y + 2));
        header.setExtent(lively.pt(textW, 18));

        var cacheKey = reply.objId;
        var cached = mt.bodyBoxCache[cacheKey];
        var bodyBox, bodyNode, bodyH;
        if (cached && cached.html === (reply._bodyHtml || "") && cached.width === textW) {
          bodyBox = cached.box;
          bodyNode = bodyBox.renderContext().shapeNode;
          bodyH = cached.height;
          container.addMorph(bodyBox);
        } else {
          bodyBox = new lively.morphic.Box(lively.rect(0, 0, textW, 10));
          bodyBox.applyStyle({ fill: null, borderWidth: 0 });
          container.addMorph(bodyBox);
          bodyNode = bodyBox.renderContext().shapeNode;
          bodyNode.className = (bodyNode.className ? bodyNode.className + " " : "") + "lounge-comment-body";
          bodyNode.innerHTML = reply._bodyHtml || "";
          lively.identity.postCardUtils.hydrateEmbeddedParts(bodyNode);
          lively.identity.postCardUtils.hydrateLinkPreviewEmbeds(bodyNode);
          lively.identity.postCardUtils.hydrateLinkPreviews(bodyNode);
          bodyH = Math.max(14, bodyNode.scrollHeight);
          cached = mt.bodyBoxCache[cacheKey] = { box: bodyBox, html: reply._bodyHtml || "", width: textW, height: bodyH };
          self._watchMiniMediaLoad(bodyNode, cached, row);
          self._watchMiniLinkPreviewCardInsert(bodyNode, cached, row);
        }
        bodyBox.setPosition(lively.pt(textX, y + 20));
        bodyBox.setExtent(lively.pt(textW, bodyH));

        var actionsY = y + 20 + bodyH + 4;
        var actionsX = textX;
        if (lively.identity.did.currentUser()) {
          var replyBtn = self._buildIconLabel("reply", "Reply", COMMENT_META_COLOR, function () {
            mt.replyBoxOpenFor = (mt.replyBoxOpenFor === reply.objId) ? null : reply.objId;
            self._renderMiniThread(row);
          });
          container.addMorph(replyBtn);
          replyBtn.setPosition(lively.pt(actionsX, actionsY));
          actionsX += replyBtn.getExtent().x + 10;
        }

        var expanded = !!mt.expanded[reply.objId];
        var toggleBtn = self._buildIconLabel(
          expanded ? "expand_more" : "chevron_right",
          expanded ? "Hide replies" : "Replies",
          COMMENT_META_COLOR,
          function () {
            mt.expanded[reply.objId] = !mt.expanded[reply.objId];
            if (mt.expanded[reply.objId] && !mt.childrenCache[reply.objId]) {
              self._loadReplyLevel(reply.objId, function (err, children) {
                mt.childrenCache[reply.objId] = err ? [] : children;
                self._renderMiniThread(row);
              });
            }
            self._renderMiniThread(row);
          });
        container.addMorph(toggleBtn);
        toggleBtn.setPosition(lively.pt(actionsX, actionsY));

        var rowBottom = actionsY + 20;

        if (mt.replyBoxOpenFor === reply.objId) {
          rowBottom = self._renderMiniComposerIfSignedIn(
            row, container, reply.objId, reply.objId, textX, rowBottom, w - textX + COMMENT_PAD_X,
            "Replying to @" + (reply._handle || "…"));
        }

        var childrenBottom = rowBottom;
        if (expanded) {
          var children = mt.childrenCache[reply.objId];
          if (children) {
            if (children.length) {
              childrenBottom = self._renderMiniCommentLevel(row, container, children, depth + 1, rowBottom + 6, w);
            }
          } else {
            var loading = lively.morphic.Text.makeLabel("Loading…", { fontSize: 11, textColor: Color.gray });
            container.addMorph(loading);
            loading.setPosition(lively.pt(x + COMMENT_INDENT, rowBottom + 6));
            loading.setExtent(lively.pt(Math.max(30, w - x - COMMENT_INDENT), 16));
            childrenBottom = rowBottom + 26;
          }
        }

        if (childrenBottom > rowBottom + 2) {
          var lineTop = topY + COMMENT_AVATAR + 2;
          var line = new lively.morphic.Box(lively.rect(0, 0, 2, Math.max(0, (childrenBottom - 6) - lineTop)));
          line.setFill(THREAD_LINE_COLOR);
          line.applyStyle({ borderWidth: 0 });
          container.addMorph(line);
          line.setPosition(lively.pt(x + COMMENT_AVATAR / 2 - 1, lineTop));
        }

        return childrenBottom + 10;
      },

      // Mirror of _watchMediaLoad/_watchLinkPreviewCardInsert, scoped to
      // this row instead of the singleton thread container — see those for
      // the full rationale (an <img>/<video> or an async link-preview-card
      // insertion has no synchronously-knowable height, so the cached
      // bodyH measured at render time needs correcting once either
      // actually resolves).
      _watchMiniMediaLoad: function (bodyNode, cached, row) {
        var self = this;
        var media = bodyNode.querySelectorAll("img, video");
        Array.prototype.forEach.call(media, function (el) {
          var isLoaded = el.tagName === "IMG" ? el.complete : el.readyState >= 1;
          if (isLoaded) return;
          var settle = function () {
            cached.height = Math.max(14, bodyNode.scrollHeight);
            self._scheduleMiniThreadRerender(row);
          };
          var readyEvt = el.tagName === "IMG" ? "load" : "loadedmetadata";
          el.addEventListener(readyEvt, settle, { once: true });
          el.addEventListener("error", settle, { once: true });
        });
      },

      _watchMiniLinkPreviewCardInsert: function (bodyNode, cached, row) {
        var self = this;
        var mo = new MutationObserver(function () {
          mo.disconnect();
          cached.height = Math.max(14, bodyNode.scrollHeight);
          self._scheduleMiniThreadRerender(row);
        });
        mo.observe(bodyNode, { childList: true, subtree: true });
        setTimeout(function () { mo.disconnect(); }, 8000);
      },

      _scheduleMiniThreadRerender: function (row) {
        var self = this;
        if (row.miniThread.rerenderTimer) return;
        row.miniThread.rerenderTimer = setTimeout(function () {
          row.miniThread.rerenderTimer = null;
          self._renderMiniThread(row);
        }, 60);
      },

      // Mirrors _renderComposerIfSignedIn's layout (bordered COMMENT_ACCENT
      // box, same placeholder/field/post-button idiom) but reads/writes
      // row.miniThread.draftText — no collision with the singleton
      // this._draftText (already per-row by construction here). Drops the
      // attachment-upload toolbar (image/video/GIF icons): wiring that up
      // would mean duplicating _stageAttachmentUpload/_renderAttachmentPreview
      // too (both touch the singleton this._renderThreadTree), which isn't
      // worth it for a first pass — a mini-card reply is text-only; the
      // full composer (with attachments) is still reachable via Reel mode.
      _renderMiniComposerIfSignedIn: function (row, container, key, parentObjId, x, y, w, placeholderText) {
        if (!lively.identity.did.currentUser() || !parentObjId) return y;
        var self = this;
        var mt = row.miniThread;
        var isRoot = key === "ROOT";
        var PAD = 14, TOOLBAR_H = 30, BOTTOM_PAD = 12;
        // 4px taller than the original 82/70 so one line of text (measured
        // live: 24px including the field's own 4px padding) fits the field
        // without counting as "grown".
        var H = (isRoot ? 86 : 74) + (mt.composer.extra[key] || 0);   // extra: see _growComposerWithText
        var fieldH = H - PAD - TOOLBAR_H - BOTTOM_PAD - 6;
        var toolbarY = H - BOTTOM_PAD - TOOLBAR_H;

        var box = new lively.morphic.Box(lively.rect(0, 0, w, H));
        box.setFill(Color.white);
        box.applyStyle({ borderWidth: 1, borderColor: Color.rgb(232, 73, 126), borderRadius: 16 });
        container.addMorph(box);
        box.setPosition(lively.pt(x, y));

        var placeholder = lively.morphic.Text.makeLabel(placeholderText, { fontSize: 12, textColor: Color.rgb(170, 170, 170) });
        placeholder.eventsAreIgnored = true;
        box.addMorph(placeholder);
        placeholder.setPosition(lively.pt(PAD, PAD - 2));
        placeholder.setExtent(lively.pt(w - PAD * 2, fieldH));

        var field = new lively.morphic.Text(lively.rect(PAD, PAD - 2, w - PAD * 2, fieldH), mt.draftText[key] || "");
        field.applyStyle({ allowInput: true, fixedWidth: true, fixedHeight: true, fontSize: 12, fill: null, borderWidth: 0, clipMode: "auto" });
        placeholder.setVisible(!field.textString);
        box.addMorph(field);
        this._wireComposerField(field, placeholder, key, mt.draftText, mt.composer, fieldH,
          function () { self._renderMiniThread(row); });

        var postLabel = isRoot ? "Comment" : "Reply";
        var postW = Math.max(56, postLabel.length * 7.5 + 32);
        var postBtn = new lively.morphic.Button(lively.rect(0, 0, postW, TOOLBAR_H));
        box.addMorph(postBtn);
        postBtn.setPosition(lively.pt(w - PAD - postW, toolbarY));
        this._paintPillButton(postBtn, {
          label: postLabel, fillCss: COMMENT_ACCENT, textColor: Color.rgb(255, 255, 255), radius: TOOLBAR_H / 2,
        });

        var sending = false;
        postBtn.onMouseDown = function () {
          if (sending) return;
          var text = (field.textString || "").trim();
          if (!text) return;
          sending = true;
          self._paintPillButton(postBtn, { label: "Sending…", fillCss: COMMENT_ACCENT, textColor: Color.rgb(255, 255, 255), radius: TOOLBAR_H / 2 });
          self._submitReply(parentObjId, text, null, function (err) {
            sending = false;
            if (err) {
              self._paintPillButton(postBtn, { label: postLabel, fillCss: COMMENT_ACCENT, textColor: Color.rgb(255, 255, 255), radius: TOOLBAR_H / 2 });
              return self._showError("Could not send reply: " + err.message);
            }
            delete mt.draftText[key];
            delete mt.composer.extra[key];
            if (!isRoot) mt.replyBoxOpenFor = null;
            self._reloadMiniAfterReply(row, parentObjId);
          });
        };

        if (!isRoot) {
          var cancelW = 64;
          var cancelBtn = new lively.morphic.Button(lively.rect(0, 0, cancelW, TOOLBAR_H));
          box.addMorph(cancelBtn);
          cancelBtn.setPosition(lively.pt(w - PAD - postW - 8 - cancelW, toolbarY));
          this._paintPillButton(cancelBtn, {
            label: "Cancel", fillCss: "rgb(244,244,245)", textColor: Color.rgb(80, 80, 80), radius: TOOLBAR_H / 2,
            borderCss: "1px solid rgb(224,224,224)",
          });
          cancelBtn.onMouseDown = function () {
            mt.replyBoxOpenFor = null;
            self._renderMiniThread(row);
          };
        }

        return y + H;
      },

      // Mirrors _reloadAfterReply, row-scoped — refreshes just the level a
      // new reply landed in (root, or a specific comment's children) and,
      // for a root-level reply, bumps the comment chip's count too.
      _reloadMiniAfterReply: function (row, parentObjId) {
        var self = this;
        var mt = row.miniThread;
        if (parentObjId === row.objId) {
          this._loadReplyLevel(parentObjId, function (err, replies) {
            mt.replies = err ? [] : replies;
            row.commentCount = mt.replies.length;
            if (row.box._renderedView && row.box._renderedView.setCommentCount) {
              row.box._renderedView.setCommentCount(row.commentCount);
            }
            self._renderMiniThread(row);
          });
        } else {
          mt.expanded[parentObjId] = true;
          this._loadReplyLevel(parentObjId, function (err, children) {
            mt.childrenCache[parentObjId] = err ? [] : children;
            self._renderMiniThread(row);
          });
        }
      },
    },

    // ─── comment thread — nested, inline, no votes ───────────────────────
    // Every comment renders inline (avatar, handle, relative time, full body,
    // Reply/collapse actions) — there's no "click to focus into the main card
    // slot" anymore; the twisty only shows/hides a comment's own children.
    // The /replies list endpoint deliberately returns metadata only (no
    // record.payload — see ObjectRepository.js's _runPostcardQuery), so a
    // level's replies get a full-envelope fetch per row before they're ever
    // rendered (_hydrateReplies) — the same fetch-then-render sequence
    // _renderCardInto already uses for the big card, just batched for a
    // whole list. Composing a reply reuses the same lively.morphic.Text +
    // allowInput technique the search field above already established in
    // this file (not a raw <textarea> in the shapeNode) — real Lively text
    // editing has none of the native-input focus-stealing gotchas documented
    // in CLAUDE.md, since those only ever affected genuine DOM <input>/
    // <textarea> elements.

    "thread", {
      _loadThread: function (rootObjId) {
        var self = this;
        this._threadRootObjId = rootObjId;
        this._threadChildrenCache = {};
        this._threadExpanded = {};
        this._replyBoxOpenFor = null;
        this._bodyBoxCache = {};
        if (this._threadRerenderTimer) { clearTimeout(this._threadRerenderTimer); this._threadRerenderTimer = null; }
        (this._threadContainer.submorphs || []).slice().forEach(function (m) { m.remove(); });
        var loading = lively.morphic.Text.makeLabel("Loading comments…", { fontSize: 12, textColor: Color.gray });
        loading.setPosition(lively.pt(0, 0));
        this._threadContainer.addMorph(loading);

        this._loadReplyLevel(rootObjId, function (err, replies) {
          self._threadReplies = err ? [] : replies;
          self._renderThreadTree();
        });
      },

      // objId's owning handle is irrelevant to this route (confirmed by
      // reading IdentityServer.js — only req.params.objId is read), so a
      // placeholder handle segment is used rather than resolving a real one.
      _fetchReplies: function (objId, thenDo) {
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("GET", base + "/@_/" + encodeURIComponent(objId) + "/replies?limit=50", true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) return thenDo(new Error("status " + xhr.status));
          var data;
          try { data = JSON.parse(xhr.responseText); } catch (e) { return thenDo(e); }
          thenDo(null, data.postcards || []);
        };
        xhr.onerror = function () { thenDo(new Error("network error")); };
        xhr.send();
      },

      // Fetches one level's reply metadata, then hydrates every reply with
      // its real body HTML + author handle before handing back — a caller
      // never renders a row that isn't already fully loaded.
      _loadReplyLevel: function (parentObjId, thenDo) {
        var self = this;
        this._fetchReplies(parentObjId, function (err, replies) {
          if (err || !replies.length) return thenDo(err, replies || []);
          self._hydrateReplies(replies, function () { thenDo(null, replies); });
        });
      },

      _hydrateReplies: function (replies, thenDo) {
        var self = this;
        var dids = [];
        replies.forEach(function (r) { if (dids.indexOf(r.did) === -1) dids.push(r.did); });
        this._resolveHandlesBatch(dids, function (handleMap) {
          var pending = replies.length;
          replies.forEach(function (r) {
            r._handle = handleMap[r.did] || null;
            self._fetchEnvelope(r.objId, function (err, envelope) {
              r._bodyHtml = self._extractReplyBodyHtml(envelope, err);
              if (--pending === 0) thenDo();
            });
          });
        });
      },

      // Same visibility handling as PostCardView.js's _renderContentArea
      // public branch (plain doc-or-snapshot, hydrateEmbeddedParts) —
      // decrypting an encrypted reply inline isn't attempted here, matching
      // this being a lightweight comment list rather than a second full
      // card renderer; an encrypted reply just shows a locked placeholder.
      _extractReplyBodyHtml: function (envelope, err) {
        if (err || !envelope) return '<span style="color:#999;font-style:italic;">(could not load)</span>';
        if (envelope.visibility !== "public") {
          return '<span style="color:#999;font-style:italic;">' +
            lively.identity.postCardUtils.lockGlyphHtml({ size: 15 }) + ' Encrypted reply</span>';
        }
        var payload = envelope.record && envelope.record.payload;
        var snapshot = payload &&
          (payload.format === "prosemirror-doc-v1" ? payload.doc : payload.snapshot);
        // Every comment renders fully inline here (no condensed-feed-row
        // collapsing) — matches the reel's own
        // suppressEmbeds override (see [[project-link-preview-reel-cards]]):
        // a persisted link_preview_card node (or a legacy bare-URL
        // paragraph, picked up by hydrateLinkPreviews below) renders as a
        // real card/iframe, not a plain text link.
        return snapshot ? lively.identity.postCardUtils.snapshotToHtml(snapshot, { suppressEmbeds: false }) : "";
      },

      // Same batch endpoint _resolveHandle already uses, generalized to
      // resolve several dids in one request — quickInfo.memberHandles and
      // this._didHandleCache (dids resolved by an earlier batch) are both
      // checked first, so a level where every author is already a known
      // constellation member (the common case) needs no request at all.
      _resolveHandlesBatch: function (dids, thenDo) {
        var self = this;
        var qi = this._quickInfo || {};
        var known = {};
        var unknown = [];
        dids.forEach(function (did) {
          if (qi.memberHandles && qi.memberHandles[did]) known[did] = qi.memberHandles[did];
          else if (self._didHandleCache[did]) known[did] = self._didHandleCache[did];
          else unknown.push(did);
        });
        if (!unknown.length) return thenDo(known);

        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("GET", base + "/dids/handles?dids=" + encodeURIComponent(unknown.join(",")), true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status === 200) {
            try {
              var data = JSON.parse(xhr.responseText);
              Object.keys(data.handles || {}).forEach(function (did) {
                known[did] = data.handles[did];
                self._didHandleCache[did] = data.handles[did];
              });
            } catch (e) {}
          }
          thenDo(known);
        };
        xhr.onerror = function () { thenDo(known); };
        xhr.send();
      },

      // Rebuilds the whole visible tree from this._threadReplies +
      // this._threadExpanded + this._threadChildrenCache — simplest correct
      // way to keep an expand/collapse-anywhere tree in the right visual
      // order without hand-patching morph insertion points. An "Add a
      // comment" composer always sits first, same as a typical
      // nested-comment thread's top-level comment box.
      _renderThreadTree: function () {
        var container = this._threadContainer;
        var containerNode = container.renderContext().shapeNode;
        // BUG FIX: clicking "Replies" to expand a nested reply rebuilds the
        // whole tree (same full-rebuild-from-state idiom as everywhere else
        // in this file) — removing every submorph below drops the
        // container's scrollHeight to ~0 for an instant, which clamps its
        // native scrollTop to 0, and nothing restored it afterward. So
        // expanding a reply anywhere but the very top of the thread threw
        // the reader back to the first comment, even though the newly
        // expanded content made the thread *taller*, not shorter (confirmed
        // live: scrollTop went 200 -> 0 while scrollHeight actually grew
        // 965 -> 1108). Saving/restoring scrollTop around the rebuild keeps
        // the reader's position stable.
        var savedScrollTop = containerNode.scrollTop;
        (container.submorphs || []).slice().forEach(function (m) { m.remove(); });
        var w = (container.getExtent().x || THREAD_W) - COMMENT_PAD_X * 2;

        var y = this._renderComposerIfSignedIn(
          container, "ROOT", this._threadRootObjId, COMMENT_PAD_X, COMMENT_TOP_MARGIN, w, "Add a comment");
        y += 10;

        if (!this._threadReplies.length) {
          var empty = lively.morphic.Text.makeLabel("No comments yet — be the first to reply.", { fontSize: 12, textColor: Color.gray });
          empty.setPosition(lively.pt(COMMENT_PAD_X, y));
          empty.setExtent(lively.pt(w, 16));
          container.addMorph(empty);
        } else {
          this._renderCommentLevel(container, this._threadReplies, 0, y, w);
        }
        this._disableDragging(container);
        containerNode.scrollTop = savedScrollTop;
      },

      _renderCommentLevel: function (container, replies, depth, y, w) {
        var self = this;
        replies.forEach(function (reply) {
          y = self._renderCommentNode(container, reply, depth, y, w);
        });
        return y;
      },

      // Lays out one comment (avatar/header/body/actions), its own inline
      // reply composer if open, its children if expanded, and — if it has
      // any visible children — a single vertical guideline box connecting
      // its avatar down to its last child, the same continuous-thread-line
      // idiom real nested-comment trees use. Returns the y position just
      // below everything this node (and its subtree) occupied.
      _renderCommentNode: function (container, reply, depth, y, w) {
        var self = this;
        var x = COMMENT_PAD_X + depth * COMMENT_INDENT;
        // Width shrinks with nesting depth only — not with the constant
        // left inset baked into x above — so the right edge lands at the
        // same COMMENT_PAD_X margin regardless of depth, matching the
        // composer box's own right edge exactly.
        var rowW = w - depth * COMMENT_INDENT;
        var topY = y;

        var avatar = new lively.morphic.Image(lively.rect(0, 0, COMMENT_AVATAR, COMMENT_AVATAR));
        avatar.setImageURL(lively.identity.postCardUtils.identiconDataUrl(reply.did, COMMENT_AVATAR));
        avatar.applyStyle({ borderRadius: COMMENT_AVATAR / 2, borderWidth: 0, clipMode: "hidden" });
        container.addMorph(avatar);
        avatar.setPosition(lively.pt(x, y));

        var textX = x + COMMENT_AVATAR + 4;
        var textW = Math.max(60, rowW - COMMENT_AVATAR - 4);

        var handleStr = "@" + (reply._handle || (reply.did || "").slice(0, 10) + "…");
        var header = lively.morphic.Text.makeLabel(
          handleStr + "  ·  " + self._formatRelativeTime(reply.created),
          { fontSize: 10.5, textColor: COMMENT_META_COLOR });
        container.addMorph(header);
        header.emphasize({ color: Color.rgb(0xCC, 0x00, 0x57) }, 0, handleStr.length);
        header.setPosition(lively.pt(textX, y + 2));
        // 14 clipped the glyph's bottom ~3px (measured live: the rendered
        // span was 15.33px tall against a 14px, overflow:hidden box) — 18
        // gives real headroom instead of matching the fontSize-in-pt
        // number too tightly.
        header.setExtent(lively.pt(textW, 18));

        // BUG FIX: an earlier version always built a fresh Box + innerHTML
        // here, every single call — fine for text, but an <img>/<video>
        // inside reply._bodyHtml has no intrinsic size until the browser
        // actually finishes loading it, and _renderThreadTree rebuilds the
        // whole tree (including this box) any time anything below the top
        // composer changes. Recreating the DOM node threw away an
        // already-loaded (or still-loading) media element's real progress
        // every time, and confirmed live via chrome-devtools that a fresh
        // <video> element takes ~140-150ms to reach loadedmetadata even
        // against an already browser-cached URL (caching speeds up the
        // network fetch, not the element's own decode/metadata pipeline) —
        // so a naive "just re-measure after load" fix still measured a
        // *different*, still-loading element on the settling re-render and
        // landed on the wrong height anyway. Reusing the same Box/DOM node
        // across rebuilds whenever this reply's HTML+width haven't changed
        // keeps whatever media it contains genuinely loaded (or genuinely
        // still loading, still being watched) instead of restarting it.
        var cacheKey = reply.objId;
        var cached = self._bodyBoxCache[cacheKey];
        var bodyBox, bodyNode, bodyH;
        if (cached && cached.html === (reply._bodyHtml || "") && cached.width === textW) {
          bodyBox = cached.box;
          bodyNode = bodyBox.renderContext().shapeNode;
          bodyH = cached.height;
          container.addMorph(bodyBox);
        } else {
          bodyBox = new lively.morphic.Box(lively.rect(0, 0, textW, 10));
          bodyBox.applyStyle({ fill: null, borderWidth: 0 });
          container.addMorph(bodyBox);
          bodyNode = bodyBox.renderContext().shapeNode;
          bodyNode.className = (bodyNode.className ? bodyNode.className + " " : "") + "lounge-comment-body";
          bodyNode.innerHTML = reply._bodyHtml || "";
          lively.identity.postCardUtils.hydrateEmbeddedParts(bodyNode);
          // Upgrades a persisted link_preview_card's embed iframe (resize
          // wiring) and, separately, a legacy bare-URL paragraph (fetches
          // via PostCardUtils.js's own module-level cache and inserts a
          // real card) — same two calls PostCardView.js/WikiView.js already
          // make after setting their own content HTML. Called BEFORE the
          // measurement just below — PostCardUtils.js's _fetchLinkPreview
          // resolves synchronously from cache on every render after the
          // first (confirmed live: the actions row overlapped the card
          // when this ran after the measurement, since a warm-cache card
          // mounts synchronously and a stale pre-card bodyH was already
          // captured). _watchLinkPreviewCardInsert below is still needed
          // for the first, genuinely-async fetch of a given URL.
          lively.identity.postCardUtils.hydrateLinkPreviewEmbeds(bodyNode);
          lively.identity.postCardUtils.hydrateLinkPreviews(bodyNode);
          // Measure-the-real-DOM, same technique as this file's own text-
          // sizing convention elsewhere — the body's height genuinely
          // depends on its (rich, possibly multi-paragraph) content, not a
          // guessed constant, so it's read back off the live node after
          // the HTML, width, and any synchronously-hydrated content are
          // all already in place. Still wrong the moment any embedded
          // media/link card hasn't loaded yet — _watchMediaLoad/
          // _watchLinkPreviewCardInsert correct cached.height (and reflow)
          // once they have.
          bodyH = Math.max(14, bodyNode.scrollHeight);
          cached = self._bodyBoxCache[cacheKey] = { box: bodyBox, html: reply._bodyHtml || "", width: textW, height: bodyH };
          self._watchMediaLoad(bodyNode, cached);
          self._watchLinkPreviewCardInsert(bodyNode, cached);
        }
        bodyBox.setPosition(lively.pt(textX, y + 20));
        bodyBox.setExtent(lively.pt(textW, bodyH));

        var actionsY = y + 20 + bodyH + 4;
        var actionsX = textX;
        if (lively.identity.did.currentUser()) {
          var replyBtn = self._buildIconLabel("reply", "Reply", COMMENT_META_COLOR, function () {
            self._replyBoxOpenFor = (self._replyBoxOpenFor === reply.objId) ? null : reply.objId;
            self._renderThreadTree();
          });
          container.addMorph(replyBtn);
          replyBtn.setPosition(lively.pt(actionsX, actionsY));
          actionsX += replyBtn.getExtent().x + 10;
        }

        var expanded = !!self._threadExpanded[reply.objId];
        var toggleBtn = self._buildIconLabel(
          expanded ? "expand_more" : "chevron_right",
          expanded ? "Hide replies" : "Replies",
          COMMENT_META_COLOR,
          function () {
            self._threadExpanded[reply.objId] = !self._threadExpanded[reply.objId];
            if (self._threadExpanded[reply.objId] && !self._threadChildrenCache[reply.objId]) {
              self._loadReplyLevel(reply.objId, function (err, children) {
                self._threadChildrenCache[reply.objId] = err ? [] : children;
                self._renderThreadTree();
              });
            }
            self._renderThreadTree();
          });
        container.addMorph(toggleBtn);
        toggleBtn.setPosition(lively.pt(actionsX, actionsY));

        var rowBottom = actionsY + 20;

        if (self._replyBoxOpenFor === reply.objId) {
          // +COMMENT_PAD_X: w's right boundary already sits COMMENT_PAD_X
          // short of the container's true right edge (see the rowW comment
          // above) — add it back so this composer's right edge lines up
          // with the top-level one instead of landing PAD_X short of it.
          rowBottom = self._renderComposerIfSignedIn(
            container, reply.objId, reply.objId, textX, rowBottom, w - textX + COMMENT_PAD_X,
            "Replying to @" + (reply._handle || "…"));
        }

        var childrenBottom = rowBottom;
        if (expanded) {
          var children = self._threadChildrenCache[reply.objId];
          if (children) {
            if (children.length) {
              childrenBottom = self._renderCommentLevel(container, children, depth + 1, rowBottom + 6, w);
            }
          } else {
            var loading = lively.morphic.Text.makeLabel("Loading…", { fontSize: 11, textColor: Color.gray });
            container.addMorph(loading);
            loading.setPosition(lively.pt(x + COMMENT_INDENT, rowBottom + 6));
            loading.setExtent(lively.pt(Math.max(30, w - x - COMMENT_INDENT), 16));
            childrenBottom = rowBottom + 26;
          }
        }

        if (childrenBottom > rowBottom + 2) {
          var lineTop = topY + COMMENT_AVATAR + 2;
          var line = new lively.morphic.Box(lively.rect(0, 0, 2, Math.max(0, (childrenBottom - 6) - lineTop)));
          line.setFill(THREAD_LINE_COLOR);
          line.applyStyle({ borderWidth: 0 });
          container.addMorph(line);
          line.setPosition(lively.pt(x + COMMENT_AVATAR / 2 - 1, lineTop));
        }

        return childrenBottom + 10;
      },

      // A comment's body height is measured synchronously via
      // bodyNode.scrollHeight right after its HTML is set — but an <img>/
      // <video> inside it (pmNodeToHtml emits a real src= directly for a
      // public attachment, no placeholder step) has no intrinsic size until
      // the browser actually finishes loading it. Without this, every later
      // comment/reply in the tree stayed positioned off that (too-small)
      // measurement forever, so a reply with an image next to one with a
      // video — each resolving its real size at a different moment — went
      // from a smooth scroll to rows permanently overlapping, mistaken for
      // the panel "trying to fit everything together."
      //
      // Attaches a one-time load/error listener to any not-yet-loaded media
      // in this specific (freshly built, per _renderCommentNode's cache-miss
      // branch) bodyNode. `cached` is that reply's _bodyBoxCache entry —
      // updating cached.height in place, then scheduling a debounced
      // rebuild, means the *next* rebuild's cache-hit path (reusing this
      // same Box/DOM node rather than rebuilding it — see
      // _renderCommentNode) picks up the corrected height without ever
      // touching the media element again. That reuse is what makes this
      // safe to call only once per genuine content build: recreating a
      // <video> element restarts its whole load cycle from scratch even
      // against an already browser-cached URL (confirmed live via
      // chrome-devtools — three fresh <video>s against the same cached URL
      // each still took ~140-150ms to reach loadedmetadata), so an earlier
      // version of this fix that rebuilt indiscriminately on every load
      // event re-triggered itself forever instead of settling.
      _watchMediaLoad: function (bodyNode, cached) {
        var self = this;
        var media = bodyNode.querySelectorAll("img, video");
        Array.prototype.forEach.call(media, function (el) {
          var isLoaded = el.tagName === "IMG" ? el.complete : el.readyState >= 1;
          if (isLoaded) return;
          var settle = function () {
            cached.height = Math.max(14, bodyNode.scrollHeight);
            self._scheduleThreadRerender();
          };
          var readyEvt = el.tagName === "IMG" ? "load" : "loadedmetadata";
          el.addEventListener(readyEvt, settle, { once: true });
          el.addEventListener("error", settle, { once: true });
        });
      },

      // Mirrors _watchMediaLoad just above, for the other async-after-the-
      // fact case: hydrateLinkPreviews (called right after bodyNode's
      // innerHTML is set) inserts a link-preview card via a real network
      // fetch the first time a given URL is seen, which lands too late for
      // the synchronous bodyH = bodyNode.scrollHeight measurement a few
      // lines up to see. A MutationObserver — not a guessed timeout, see
      // CLAUDE.md's measured-not-guessed sizing rule — catches that
      // insertion whenever it actually happens and corrects cached.height
      // + reflows via the same _scheduleThreadRerender debounce. No-op
      // when nothing ever gets inserted (a comment with no bare-URL
      // paragraph) past its own timeout below.
      _watchLinkPreviewCardInsert: function (bodyNode, cached) {
        var self = this;
        var mo = new MutationObserver(function () {
          mo.disconnect();
          cached.height = Math.max(14, bodyNode.scrollHeight);
          self._scheduleThreadRerender();
        });
        mo.observe(bodyNode, { childList: true, subtree: true });
        setTimeout(function () { mo.disconnect(); }, 8000);
      },

      _scheduleThreadRerender: function () {
        var self = this;
        if (this._threadRerenderTimer) return;
        this._threadRerenderTimer = setTimeout(function () {
          self._threadRerenderTimer = null;
          self._renderThreadTree();
        }, 60);
      },

      // A small icon(Material Symbols)+label affordance — the "Reply" and
      // "Replies"/"Hide replies" actions under each comment. Constructed at
      // (0,0) and positioned by the caller, matching this file's own
      // construct-then-addMorph-then-setPosition convention throughout.
      _buildIconLabel: function (glyph, label, color, onClick) {
        var w = Math.max(50, label.length * 6.2 + 26);
        var row = new lively.morphic.Box(lively.rect(0, 0, w, 16));
        row.applyStyle({ fill: null, borderWidth: 0 });

        var icon = new lively.morphic.Text(lively.rect(0, 0, 14, 14), glyph);
        icon.applyStyle({
          fontFamily: "'Material Symbols Rounded'", fontSize: 10.5, textColor: color,
          fill: null, borderWidth: 0, allowInput: false, selectable: false,
          clipMode: "hidden", whiteSpaceHandling: "pre",
        });
        row.addMorph(icon);

        var text = lively.morphic.Text.makeLabel(label, { fontSize: 10.5, textColor: color, fontWeight: "600" });
        row.addMorph(text);
        text.setPosition(lively.pt(17, 1));
        text.setExtent(lively.pt(w - 17, 14));

        if (onClick) {
          row.onMouseDown = onClick;
          row.handStyle = "pointer";
          icon.eventsAreIgnored = true;
          text.eventsAreIgnored = true;
        }
        return row;
      },

      // Grow-with-text bookkeeping for one set of composers (the reel
      // thread keeps one on this, each mini-card row one on
      // row.miniThread.composer): extra = key -> px the text field has grown
      // past its base height; fields = key -> the live field of each rendered
      // composer, so a stale timeout from a replaced field can tell it's
      // stale; pendingFocus = {key, caret}, set just before a grow-triggered
      // rebuild so the recreated field gets focus and the caret back.
      _newComposerState: function () {
        return { extra: {}, fields: {}, pendingFocus: null };
      },

      // Shared by the full and the mini composer: hooks the draft-text /
      // placeholder bookkeeping and grow-with-text onto a freshly built
      // field. Call it after the field is added to its box. draftTexts is
      // the key -> text map the composer keeps its drafts in, cs the
      // composer state above, fieldH the field's current height, and
      // rebuild re-renders the thread the composer lives in.
      _wireComposerField: function (field, placeholder, key, draftTexts, cs, fieldH, rebuild) {
        var self = this;
        var superKeyDown = field.onKeyDown;
        field.onKeyDown = function (evt) {
          // Lively's Text treats Ctrl+A as "select what was recently typed"
          // while it has a record of recent keystrokes (charsTyped, see
          // TextCore.js), and only does a real select-all once that record
          // is empty — so after typing a long comment it selected just the
          // last few words. A comment box should select everything.
          if (evt.isCommandKey() && (evt.getKeyChar() || "").toLowerCase() === "a") field.charsTyped = "";
          var result = superKeyDown.call(this, evt);
          draftTexts[key] = field.textString;
          placeholder.setVisible(!field.textString);
          // The typed character isn't in the field yet at keydown, and
          // Lively's Text only folds it into its model a tick later
          // (fixChunksDelayed, scheduled from keypress — after this
          // keydown), so a zero-delay read still saw the text without it:
          // the first character typed into an empty box was dropped when
          // that keystroke triggered a rebuild. Measure a frame later, once
          // the model has caught up.
          setTimeout(function () {
            if (cs.fields[key] !== field) return;
            draftTexts[key] = field.textString;
            self._growComposerWithText(cs, key, field, fieldH - (cs.extra[key] || 0), rebuild);
          }, 16);
          return result;
        };
        cs.fields[key] = field;
        var pf = cs.pendingFocus;
        if (pf && pf.key === key) {
          cs.pendingFocus = null;
          field.focus();
          field.setSelectionRange(pf.caret[0], pf.caret[1]);
        }
      },

      // Grows (or shrinks) a composer's box to fit what's typed in it, up to
      // COMPOSER_MAX_EXTRA past its base height — beyond that the field
      // scrolls internally (clipMode "auto"). The box height is derived from
      // state when the composer is rendered, and the whole thread is rebuilt
      // from state, so growing means: measure, store the extra in
      // cs.extra[key], rebuild, and put focus and the caret back in the
      // recreated field (cs.pendingFocus). Only rebuilds when the needed
      // extra actually changes — i.e. when the text gains or loses a line —
      // not on every keystroke.
      _growComposerWithText: function (cs, key, field, baseFieldH, rebuild) {
        // A rebuild already replaced this field. (field.owner isn't a
        // usable check: removing the old box from the container leaves
        // the field's own owner — the box — set.)
        if (cs.fields[key] !== field) return;
        var node = field.renderContext().shapeNode;
        var content = node && node.firstElementChild;
        if (!content) return;
        // The content div has min-height:calc(100% - 4px) of the field's
        // *current* height, which would pin the reading at whatever height
        // it already has and so never let the box shrink back — zero the
        // floor for the read, then restore it.
        var prevMin = content.style.minHeight;
        content.style.minHeight = "0px";
        var contentH = content.offsetHeight;
        content.style.minHeight = prevMin;
        // +4: the shapeNode's own fixed vertical padding, which
        // setExtentHTML subtracts from whatever extent the field is given.
        var need = Math.max(0, Math.min(COMPOSER_MAX_EXTRA, Math.ceil(contentH + 4 - baseFieldH)));
        if (need === (cs.extra[key] || 0)) return;
        cs.extra[key] = need;
        cs.pendingFocus = { key: key, caret: field.getSelectionRange() };
        rebuild();
      },

      _getMediaPicker: function () {
        if (!this._mediaPicker) this._mediaPicker = new lively.identity.MediaPickerController();
        return this._mediaPicker;
      },

      // Opens the shared GIF/Sticker/Emoji picker (MediaPickerDialog.js,
      // the same one RoomView.js's chat composer uses) for the composer
      // identified by key, anchored to its box. Same toggle behavior as
      // RoomView's: the GIF button while the picker is already open shuts it.
      _openMediaPicker: function (key, anchorMorph, initialTab) {
        var self = this;
        var picker = this._getMediaPicker();
        if (picker.isOpen()) { picker.close(); return; }
        picker.open(anchorMorph.globalBounds(), {
          initialTab: initialTab,
          onPick: function (payload) { self._onMediaPicked(key, payload); },
        });
      },

      // An emoji goes straight into the composer's draft text; a GIF/sticker
      // is staged like an uploaded image (preview strip, sent with the
      // Comment button) rather than posted immediately, so it can carry a
      // caption — except entry is null, since it's a plain Klipy URL and
      // there's no uploaded blob to reference (see _submitReply). A pick
      // replaces whatever was staged: one attachment at a time per composer.
      // Both paths re-render the thread tree, which rebuilds the composer
      // from this._draftText/this._draftAttachment.
      _onMediaPicked: function (key, payload) {
        if (payload.type === "emoji") {
          this._draftText[key] = (this._draftText[key] || "") + payload.value;
        } else {
          this._draftAttachment[key] = {
            kind: "gif", url: payload.value, name: payload.type === "sticker" ? "Sticker" : "GIF", entry: null,
          };
        }
        this._renderThreadTree();
      },

      // Renders an "Add a comment" (key "ROOT") or per-comment reply
      // composer — a bordered, generously-rounded box with a multi-line
      // Lively Text input (the same allowInput technique the search field
      // above uses, not a raw <textarea>), a toolbar row (image/video are
      // wired to a real upload, GIF opens the media picker; text-format
      // stays decorative — see this
      // file's own project memory), an attachment preview strip when
      // something is staged, and pill-shaped Cancel/Comment(Reply) buttons
      // on the right. Renders nothing (and returns y unchanged) for a
      // signed-out visitor, mirroring PostCardView.js's own reply-button
      // visibility gating. Draft text/attachment are kept in
      // this._draftText[key]/this._draftAttachment[key] across re-renders
      // so expanding an unrelated comment elsewhere in the tree doesn't
      // erase what's being composed here.
      _renderComposerIfSignedIn: function (container, key, parentObjId, x, y, w, placeholderText) {
        if (!lively.identity.did.currentUser() || !parentObjId) return y;
        var self = this;
        var isRoot = key === "ROOT";
        var PAD = 14, TOOLBAR_H = 30, BOTTOM_PAD = 12, PREVIEW_H = 48;
        var staged = this._draftAttachment[key];
        // _composerState.extra[key]: extra px the text has outgrown the
        // field's base height by (see _growComposerWithText) — added to the
        // whole box so the toolbar and everything below move down with it.
        var H = (isRoot ? 112 : 100) + (staged ? PREVIEW_H : 0) + (this._composerState.extra[key] || 0);
        var fieldH = H - PAD - TOOLBAR_H - BOTTOM_PAD - 6 - (staged ? PREVIEW_H : 0);
        var toolbarY = H - BOTTOM_PAD - TOOLBAR_H;

        var box = new lively.morphic.Box(lively.rect(0, 0, w, H));
        box.setFill(Color.white);
        box.applyStyle({ borderWidth: 1, borderColor: Color.rgb(232, 73, 126), borderRadius: 16 });   // COMMENT_ACCENT (#e8497e)
        container.addMorph(box);
        box.setPosition(lively.pt(x, y));

        var placeholder = lively.morphic.Text.makeLabel(placeholderText, { fontSize: 12, textColor: Color.rgb(170, 170, 170) });
        placeholder.eventsAreIgnored = true;
        box.addMorph(placeholder);
        placeholder.setPosition(lively.pt(PAD, PAD - 2));
        placeholder.setExtent(lively.pt(w - PAD * 2, fieldH));

        var field = new lively.morphic.Text(lively.rect(PAD, PAD - 2, w - PAD * 2, fieldH), this._draftText[key] || "");
        // clipMode "auto": the field is a fixed-height box, so without it text
        // past ~3 lines spilled out over the toolbar and the comment below.
        field.applyStyle({ allowInput: true, fixedWidth: true, fixedHeight: true, fontSize: 12, fill: null, borderWidth: 0, clipMode: "auto" });
        placeholder.setVisible(!field.textString);
        box.addMorph(field);
        this._wireComposerField(field, placeholder, key, this._draftText, this._composerState, fieldH,
          function () { self._renderThreadTree(); });

        if (staged) this._renderAttachmentPreview(box, key, staged, PAD, PAD + fieldH + 4, w - PAD * 2, PREVIEW_H - 8);

        // Toolbar — image/video icons open a real file picker and upload
        // (see _promptFileUpload/_stageAttachmentUpload below); GIF opens
        // the media picker (_openMediaPicker); text-format stays decorative
        // for now. text_fields is the vendored
        // Material Symbols ligature for the reference composer's "Aa"
        // text-formatting glyph (renders as a stylized "Tt").
        //
        // Icon box sized generously taller than the target glyph, not
        // tight to it — same fontSize-is-pt-not-px clipping gotcha
        // AmbientPresencePanel.js's makeIconButton hit and fixed the same
        // way (CLAUDE.md's "fontSize on Text morphs is in points, not
        // pixels" section): a 16px real glyph needs fontSize 12
        // (16*0.75), and even then a box tightly sized to 16px clips the
        // bottom — GLYPH_BOX_H stays a few px taller with top padding to
        // compensate, instead of matching the target size 1:1.
        var GLYPH_PX = 16, GLYPH_FONT = GLYPH_PX * 0.75, GLYPH_BOX_H = 22;
        var toolbarX = PAD;
        // Text, Image, Video, GIF — explicit order per request, not the
        // order these happen to be easiest to group by type in, so icon
        // and label items are interleaved from one list instead of drawn
        // in two separate icons-then-labels passes.
        [
          { icon: "text_fields", w: 20 },
          { icon: "image", w: 20, upload: "image" },
          { icon: "play_circle", w: 20, upload: "video" },
          { label: "GIF", w: 28 },
        ].forEach(function (item) {
          if (item.icon) {
            var g = new lively.morphic.Text(lively.rect(0, 0, item.w, GLYPH_BOX_H), item.icon);
            g.applyStyle({
              fontFamily: "'Material Symbols Rounded'", fontSize: GLYPH_FONT, textColor: Color.rgb(150, 150, 150),
              fill: null, borderWidth: 0, allowInput: false, selectable: false, align: "center",
              padding: lively.Rectangle.inset(0, Math.round((GLYPH_BOX_H - GLYPH_PX) / 2), 0, 0),
              clipMode: "hidden", whiteSpaceHandling: "pre",
            });
            box.addMorph(g);
            g.setPosition(lively.pt(toolbarX, toolbarY + Math.round((TOOLBAR_H - GLYPH_BOX_H) / 2)));
            toolbarX += item.w + 8;
            if (item.upload) {
              g.handStyle = "pointer";
              g.onMouseDown = function () {
                if (self._draftAttachment[key]) return; // one attachment at a time
                self._promptFileUpload(item.upload, function (file) {
                  if (file) self._stageAttachmentUpload(key, file, item.upload);
                });
              };
            }
          } else {
            var lbl = lively.morphic.Text.makeLabel(item.label, { fontSize: 11.5, fontWeight: "700", textColor: Color.rgb(150, 150, 150) });
            box.addMorph(lbl);
            lbl.setPosition(lively.pt(toolbarX, toolbarY + 7));
            lbl.setExtent(lively.pt(item.w, 16));
            toolbarX += item.w + 6;
            // makeLabel/beLabel leave eventsAreIgnored = true (see
            // CLAUDE.md), so flip it back; onMouseUp, not onMouseDown,
            // because the picker's click-away catcher closes on mouseup —
            // opening on mousedown would have that same click's mouseup
            // land on the just-added catcher and shut the picker again.
            lbl.eventsAreIgnored = false;
            lbl.draggingEnabled = false;
            lbl.droppingEnabled = false;
            lbl.grabbingEnabled = false;
            lbl.handStyle = "pointer";
            lbl.onMouseUp = function (evt) {
              self._openMediaPicker(key, box, "gif");
              evt.stop();
              return true;
            };
          }
        });

        var postLabel = isRoot ? "Comment" : "Reply";
        var postW = Math.max(56, postLabel.length * 7.5 + 32);
        var postBtn = new lively.morphic.Button(lively.rect(0, 0, postW, TOOLBAR_H));
        box.addMorph(postBtn);
        postBtn.setPosition(lively.pt(w - PAD - postW, toolbarY));
        this._paintPillButton(postBtn, {
          label: postLabel, fillCss: COMMENT_ACCENT, textColor: Color.rgb(255, 255, 255), radius: TOOLBAR_H / 2,
        });

        var sending = false;
        postBtn.onMouseDown = function () {
          if (sending) return;
          var text = (field.textString || "").trim();
          var attachment = self._draftAttachment[key];
          if (attachment && attachment.uploading) return; // wait for the upload to finish
          if (!text && !attachment) return;
          sending = true;
          self._paintPillButton(postBtn, { label: "Sending…", fillCss: COMMENT_ACCENT, textColor: Color.rgb(255, 255, 255), radius: TOOLBAR_H / 2 });
          self._submitReply(parentObjId, text, attachment, function (err) {
            sending = false;
            if (err) {
              self._paintPillButton(postBtn, { label: postLabel, fillCss: COMMENT_ACCENT, textColor: Color.rgb(255, 255, 255), radius: TOOLBAR_H / 2 });
              return self._showError("Could not send reply: " + err.message);
            }
            delete self._draftText[key];
            delete self._draftAttachment[key];
            delete self._composerState.extra[key];
            if (!isRoot) self._replyBoxOpenFor = null;
            self._reloadAfterReply(parentObjId);
          });
        };

        if (!isRoot) {
          var cancelW = 64;
          var cancelBtn = new lively.morphic.Button(lively.rect(0, 0, cancelW, TOOLBAR_H));
          box.addMorph(cancelBtn);
          cancelBtn.setPosition(lively.pt(w - PAD - postW - 8 - cancelW, toolbarY));
          this._paintPillButton(cancelBtn, {
            label: "Cancel", fillCss: "rgb(244,244,245)", textColor: Color.rgb(80, 80, 80), radius: TOOLBAR_H / 2,
            borderCss: "1px solid rgb(224,224,224)",
          });
          cancelBtn.onMouseDown = function () {
            self._replyBoxOpenFor = null;
            self._renderThreadTree();
          };
        }

        return y + H;
      },

      // Button.setFill/setBorderColor/applyStyle({fill:...}) silently don't
      // reach the DOM for a Button created procedurally (`new
      // lively.morphic.Button(...)` + addMorph, as opposed to one declared
      // in a BuildSpec's static submorphs array) — confirmed in
      // feedback_morph_dialog_baseline_polish's PublishToInventoryDialog.js
      // finding. That finding's own verified-working fix (style the
      // shapeNode's DOM directly for background/border, but use the
      // label's own normal setTextColor for text color — an ordinary Text
      // morph setter, unaffected by the Button-specific bug) is reused here
      // rather than the untested guess of letting a color style cascade
      // down from the outer node. WalletSetupDialog.js's _paintToggleButton
      // is the reference implementation this mirrors. Re-callable any time
      // a button's label text changes (e.g. "Sending…"), since setLabel
      // rebuilds the label morph and drops any earlier color set on it.
      _paintPillButton: function (btn, opts) {
        btn.setLabel(opts.label);
        var node = btn.renderContext && btn.renderContext().shapeNode;
        if (node) {
          node.style.background = opts.fillCss;
          node.style.border = opts.borderCss || "none";
          node.style.borderRadius = opts.radius + "px";
        }
        if (btn.label) {
          if (btn.label.setTextColor) btn.label.setTextColor(opts.textColor);
          if (btn.label.applyStyle) btn.label.applyStyle({ fontWeight: "600" });
        }
      },

      // A hidden native <input type=file>, appended to document.body and
      // removed right after use — same construction PostCardEditor.js's own
      // _promptAttachment uses for its 📎 toolbar button (confirmed via
      // project research before writing this). A file picker doesn't need
      // real keyboard focus the way a text field does, but appending to
      // document.body rather than nesting in a morph's shapeNode still
      // matches this file's own "dialog overlay -> document.body" CLAUDE.md
      // convention regardless. kind is "image" or "video", used only to
      // set the file input's accept filter.
      _promptFileUpload: function (kind, thenDo) {
        var input = document.createElement("input");
        input.type = "file";
        input.accept = kind === "video" ? "video/*" : "image/*";
        input.style.display = "none";
        document.body.appendChild(input);
        input.addEventListener("change", function () {
          var file = input.files && input.files[0];
          if (input.parentNode) input.parentNode.removeChild(input);
          thenDo(file || null);
        });
        input.click();
      },

      // Uploads a file the same way ProfileCard.js's avatar upload and
      // PostCardEditor.js's _uploadAttachment do for a PUBLIC attachment —
      // fileCrypto.encryptAndUpload skips the KEK/passkey ceremony entirely
      // for visibility:"public" (dek/blobNonce come back null), and the
      // resulting blob is fetchable at a plain, permanent URL
      // (baseUrl()+"/@handle/blobs/"+blobCid — same _publicBlobUrl formula
      // PostCardEditor.js uses), so the ProseMirror node can carry a real
      // `src` immediately instead of the objId+placeholder scheme
      // encrypted/private attachments need (see PostCardUtils.js's
      // pmNodeToHtml image/video cases — src-present skips the placeholder
      // path entirely).
      _uploadPublicAttachment: function (file, kind, thenDo) {
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error("Not signed in."));
        lively.require("lively.identity.FileCrypto").toRun(function () {
          lively.identity.fileCrypto.encryptAndUpload(file, { visibility: "public", name: file.name }, function (err, result) {
            if (err) return thenDo(err);
            var base = lively.identity.did.baseUrl();
            var url = base + "/@" + encodeURIComponent(user.handle) + "/blobs/" + encodeURIComponent(result.blobCid);
            thenDo(null, {
              kind: kind, url: url, name: file.name,
              entry: {
                objId: result.objId, dek: null, blobCid: result.blobCid, blobNonce: null,
                name: file.name, mime: file.type || "application/octet-stream",
              },
            });
          });
        });
      },

      // Marks the composer as "uploading" immediately (re-rendering so the
      // preview strip shows a spin-ish status line right away), then swaps
      // in the real staged attachment once the upload resolves — or clears
      // it and surfaces the error if it fails. One attachment at a time per
      // composer (the icon handlers already guard against a second pick
      // while one is in flight).
      _stageAttachmentUpload: function (key, file, kind) {
        var self = this;
        this._draftAttachment[key] = { uploading: true, kind: kind, name: file.name };
        this._renderThreadTree();
        this._uploadPublicAttachment(file, kind, function (err, staged) {
          if (err) {
            delete self._draftAttachment[key];
            self._showError("Could not upload " + kind + ": " + err.message);
            self._renderThreadTree();
            return;
          }
          self._draftAttachment[key] = staged;
          self._renderThreadTree();
        });
      },

      // A small strip between the text field and the toolbar: an image
      // thumbnail (a real lively.morphic.Image, since the src is already a
      // plain fetchable URL) or a video filename chip, plus a "✕" to drop
      // it before sending. Shows an "Uploading…" status label instead
      // while staged.uploading is true.
      _renderAttachmentPreview: function (box, key, staged, x, y, w, h) {
        var self = this;
        var strip = new lively.morphic.Box(lively.rect(0, 0, w, h));
        strip.applyStyle({ fill: Color.rgb(245, 245, 247), borderWidth: 0, borderRadius: 8 });
        box.addMorph(strip);
        strip.setPosition(lively.pt(x, y));

        if (staged.uploading) {
          var uploading = lively.morphic.Text.makeLabel(
            "Uploading " + staged.kind + "…", { fontSize: 11.5, textColor: Color.rgb(130, 130, 130) });
          strip.addMorph(uploading);
          uploading.setPosition(lively.pt(10, Math.round((h - 16) / 2)));
          uploading.setExtent(lively.pt(w - 20, 16));
          return;
        }

        if (staged.kind === "image" || staged.kind === "gif") {
          var thumb = new lively.morphic.Image(lively.rect(0, 0, h - 12, h - 12));
          thumb.setImageURL(staged.url);
          thumb.applyStyle({ borderRadius: 4, borderWidth: 0, clipMode: "hidden" });
          strip.addMorph(thumb);
          thumb.setPosition(lively.pt(6, 6));
        } else {
          var vicon = new lively.morphic.Text(lively.rect(0, 0, h - 12, h - 12), "movie");
          vicon.applyStyle({
            fontFamily: "'Material Symbols Rounded'", fontSize: (h - 12) * 0.75 * 0.7, textColor: Color.rgb(130, 130, 130),
            fill: null, borderWidth: 0, allowInput: false, selectable: false, align: "center",
            clipMode: "hidden", whiteSpaceHandling: "pre",
          });
          strip.addMorph(vicon);
          vicon.setPosition(lively.pt(6, 6));
        }

        var name = lively.morphic.Text.makeLabel(staged.name || "", {
          fontSize: 11.5, textColor: Color.rgb(80, 80, 80),
        });
        strip.addMorph(name);
        name.setPosition(lively.pt(h + 4, Math.round((h - 16) / 2)));
        name.setExtent(lively.pt(w - h - 34, 16));

        var remove = lively.morphic.Text.makeLabel("✕", { fontSize: 12, textColor: Color.rgb(150, 150, 150) });
        strip.addMorph(remove);
        remove.setPosition(lively.pt(w - 24, Math.round((h - 16) / 2)));
        remove.setExtent(lively.pt(16, 16));
        remove.handStyle = "pointer";
        remove.onMouseDown = function () {
          delete self._draftAttachment[key];
          self._renderThreadTree();
        };
      },

      // Builds a minimal one- or two-node plain postcard (no title prompt,
      // no rich formatting — the point of the inline box, vs. the full
      // PostCardEditor reply flow every other "Reply" affordance in the app
      // uses) threaded under parentObjId via the same replyTo field every
      // reply already rides on. attachment is the staged {kind, url, name,
      // entry} from _uploadPublicAttachment, or null for a text-only
      // comment — when present, its ProseMirror node goes first (image or
      // video, matching PostCardEditor.js's _insertAttachmentImage/-Video
      // node shape) and its entry is carried in payload.attachments so a
      // future edit/re-render has the full metadata, not just the URL.
      // Same serialize-then-PUT sequence as _sendWelcomeCard/_requestJoin
      // above.
      _submitReply: function (parentObjId, text, attachment, thenDo) {
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error("Not signed in."));
        var self = this;
        // Text goes first — a reply's caption belongs above whatever it's
        // captioning, not buried under an image/video/gif.
        var content = [];
        if (text) content.push({ type: "paragraph", content: [{ type: "text", text: text }] });
        if (attachment) {
          // Schema note (PostCardEditor.js's ProseMirror schema,
          // confirmed by reading it): image is `group:'inline'`, so it
          // must sit inside a paragraph's content array like any other
          // inline node — a bare image can't be a direct doc.content
          // child. video is `group:'block'`, atom:true, so it's the
          // opposite: a direct doc.content sibling, never paragraph-wrapped.
          if (attachment.kind === "image" || attachment.kind === "gif") {
            // A picked GIF/sticker has no entry (a plain Klipy URL, not an
            // uploaded blob) so no objId — the renderer falls back to src.
            content.push({
              type: "paragraph",
              content: [{ type: "image", attrs: { src: attachment.url, alt: attachment.name, title: attachment.name, objId: attachment.entry ? attachment.entry.objId : null } }],
            });
          } else {
            content.push({ type: "video", attrs: { src: attachment.url, objId: attachment.entry.objId } });
          }
        }
        if (!content.length) return thenDo(new Error("Nothing to post"));
        var doc = { type: "doc", content: content };
        lively.require("lively.identity.PostCardSerializer").toRun(function () {
          lively.identity.postCardSerializer.serializePlainToEnvelope({
            doc: doc,
            constellation: self._name,
            visibility: "public",
            attachments: attachment && attachment.entry ? [attachment.entry] : [],
            replyTo: { objId: parentObjId, anchor: null },
          }, function (err, envelope) {
            if (err) return thenDo(err);
            var base = lively.identity.did.baseUrl();
            var xhr = new XMLHttpRequest();
            xhr.open("PUT", base + "/@" + encodeURIComponent(user.handle) + "/" + encodeURIComponent(envelope.objId), true);
            xhr.withCredentials = true;
            xhr.setRequestHeader("Content-Type", "application/json");
            xhr.onload = function () {
              if (xhr.status !== 200) return thenDo(new Error("save failed (" + xhr.status + ")"));
              thenDo(null);
            };
            xhr.onerror = function () { thenDo(new Error("network error")); };
            xhr.send(JSON.stringify(envelope));
          });
        });
      },

      // Refreshes just the level a new reply landed in — the root thread if
      // it was posted from the top composer, or a specific comment's
      // (auto-expanded, so the new reply is immediately visible) children
      // otherwise — rather than reloading the whole tree.
      _reloadAfterReply: function (parentObjId) {
        var self = this;
        if (parentObjId === this._threadRootObjId) {
          this._loadReplyLevel(parentObjId, function (err, replies) {
            self._threadReplies = err ? [] : replies;
            self._renderThreadTree();
          });
        } else {
          this._threadExpanded[parentObjId] = true;
          this._loadReplyLevel(parentObjId, function (err, children) {
            self._threadChildrenCache[parentObjId] = err ? [] : children;
            self._renderThreadTree();
          });
        }
      },

      _formatRelativeTime: function (iso) {
        if (!iso) return "";
        var d = new Date(iso);
        if (isNaN(d.getTime())) return "";
        var diffSec = Math.max(0, (Date.now() - d.getTime()) / 1000);
        var mins = diffSec / 60, hours = mins / 60, days = hours / 24;
        if (diffSec < 60) return "just now";
        if (mins < 60) return Math.floor(mins) + "m";
        if (hours < 24) return Math.floor(hours) + "h";
        if (days < 30) return Math.floor(days) + "d";
        if (days < 365) return Math.floor(days / 30) + "mo";
        return Math.floor(days / 365) + "y";
      },
    },

    // ─── member list — Discord-style: co-creator / moderators / active ───────

    "members", {
      _renderMemberList: function () {
        (this._membersBox.submorphs || []).slice().forEach(function (m) { m.remove(); });
        var qi = this._quickInfo || {};
        var handles = qi.memberHandles || {};
        var controllers = qi.controllers || [];
        var members = qi.members || [];
        var bots = qi.bots || [];
        var coCreator = qi.createdBy;
        var moderators = controllers.filter(function (did) { return did !== coCreator; });
        var plainMembers = members.filter(function (did) {
          return controllers.indexOf(did) === -1 && bots.indexOf(did) === -1;
        });
        var w = this._membersBox.getExtent().x;

        var y = 4;
        // Co-creator, bots and moderators already sit under their own
        // section header, so their pill shows live status instead of
        // repeating the role. A bot on the constellation's list is always
        // listed; its pill reads online while it is connected (present in
        // awareness like anyone else) and offline otherwise.
        y = this._renderMemberSection(w, y, "CO-CREATOR", [coCreator].filter(Boolean), handles,
          null, null, null, true);
        y = this._renderMemberSection(w, y, "BOTS", bots, handles,
          null, null, null, true);
        y = this._renderMemberSection(w, y, "MODERATORS", moderators, handles,
          null, null, null, true);
        this._renderMemberSection(w, y, "ACTIVE MEMBERS", plainMembers.filter(this._isOnline.bind(this)), handles, null, null, null);
        this._disableDragging(this._membersBox);
      },

      // Present in awareness and not hiding. An invisible member appears
      // offline to everyone, including themself: their row is dropped like
      // anyone else's who isn't connected.
      _isOnline: function (did) {
        var status = this._presenceByDid[did];
        return !!status && status !== "invisible";
      },

      _statusDotColor: function (did) {
        var panel = lively.identity.AmbientPresencePanel;
        var status = this._presenceByDid[did];
        if (!panel) return Color.rgb(67, 160, 71);
        return status === "idle" ? panel.STATUS_IDLE
          : status === "dnd" ? panel.STATUS_DND
          : Color.rgb(67, 160, 71);
      },

      // Pill contents for a member's live status. Offline covers both "not
      // connected" and "invisible" (_isOnline is false for both).
      _statusBadgeInfo: function (did) {
        var status = this._presenceByDid[did];
        if (!this._isOnline(did)) status = "offline";
        var spec = {
          online:    { color: Color.rgb(46, 125, 50),  bg: Color.rgb(232, 245, 233) },
          idle:      { color: Color.rgb(138, 109, 0),  bg: Color.rgb(255, 243, 205) },
          dnd:       { color: Color.rgb(198, 40, 40),  bg: Color.rgb(253, 232, 232) },
          offline:   { color: Color.rgb(120, 120, 120), bg: Color.rgb(240, 240, 240) },
        }[status] || { color: Color.rgb(46, 125, 50), bg: Color.rgb(232, 245, 233) };
        return { text: status, color: spec.color, bg: spec.bg };
      },

      _renderMemberSection: function (w, y, label, dids, handles, badgeColor, badgeBg, badgeText, statusBadge) {
        if (!dids.length) return y;
        var self = this;
        // The box's CSS padding (set in _buildChrome) doesn't actually
        // offset these morphs — Lively positions submorphs as plain pixel
        // coordinates from the box's own origin, not its CSS padding box
        // (confirmed live: the avatar rendered flush against the panel's
        // border with zero gap despite the padding style being set). Bake
        // the inset into the geometry here instead.
        var PAD_X = 10;
        var w2 = w - PAD_X * 2;

        var header = lively.morphic.Text.makeLabel(label, { fontSize: 10, textColor: Color.rgb(153, 153, 153) });
        header.setPosition(lively.pt(PAD_X, y));
        header.setExtent(lively.pt(w2, 14));
        this._membersBox.addMorph(header);
        y += 20;

        dids.forEach(function (did) {
          var handle = handles[did] || (did.slice(0, 10) + "…");
          var row = new lively.morphic.Box(lively.rect(PAD_X, y, w2, 26));
          row.applyStyle({ fill: null, borderWidth: 0 });

          // Text morphs don't render their glyph vertically centered in
          // their own box (same gotcha as the "+ Postcard" pill's label) —
          // confirmed live, the name's actual glyph center sat ~3px below
          // the avatar's geometric center even though both boxes were
          // set to the same nominal middle. Nudging the avatar down those
          // 3px, rather than fighting the text's rendering, is what
          // actually lines the two up.
          var avatar = new lively.morphic.Image(lively.rect(0, 4, 22, 22));
          avatar.setImageURL(lively.identity.postCardUtils.identiconDataUrl(did, 22));
          avatar.applyStyle({ borderRadius: 11, borderWidth: 0, clipMode: "hidden" });
          row.addMorph(avatar);

          var pill = statusBadge ? self._statusBadgeInfo(did)
            : (badgeColor ? { text: badgeText, color: badgeColor, bg: badgeBg } : null);
          var nameW = pill ? (w2 - 30 - 70) : (self._isOnline(did) ? (w2 - 30 - 12) : (w2 - 30));
          var nameT = lively.morphic.Text.makeLabel("@" + handle, { fontSize: 12 });
          nameT.setPosition(lively.pt(28, 4));
          nameT.setExtent(lively.pt(Math.max(30, nameW), 16));
          row.addMorph(nameT);
          // Every row opens the mini profile, bots included (a bot is added
          // by handle, so it has a profile like anyone else). Only skipped
          // when no handle resolved: the row then shows a truncated DID,
          // which has no profile to load.
          if (handles[did]) self._wireHandleLink(nameT, did, handle);

          if (pill) {
            var badge = new lively.morphic.Box(lively.rect(w2 - 66, 3, 62, 18));
            badge.setFill(pill.bg);
            badge.applyStyle({ borderWidth: 0, borderRadius: 9 });
            var badgeT = lively.morphic.Text.makeLabel(pill.text, {
              fontSize: 9, textColor: pill.color, fixedWidth: true, fixedHeight: true, align: "center" });
            badgeT.setPosition(lively.pt(6, 1));
            badgeT.setExtent(lively.pt(52, 12));
            badge.addMorph(badgeT);
            row.addMorph(badge);
          } else if (self._isOnline(did)) {
            var dot = new lively.morphic.Box(lively.rect(w2 - 14, 8, 8, 8));
            dot.setFill(self._statusDotColor(did));
            dot.applyStyle({ borderWidth: 0, borderRadius: 4 });
            row.addMorph(dot);
          }

          self._membersBox.addMorph(row);
          y += 30;
        });
        return y + 6;
      },
    },

    // ─── live presence (awareness-only — no layout map observation) ─────────

    "presence", {
      _connectPresence: function () {
        var self = this;
        var Y = this._Y();
        var WebsocketProvider = this._WebsocketProvider();
        if (!Y || !WebsocketProvider || !this._genesisObjId) return;

        var base = lively.identity.did.baseUrl();
        var tokenXhr = new XMLHttpRequest();
        tokenXhr.open("GET", base + "/c/" + encodeURIComponent(this._name) + "/space-token", true);
        tokenXhr.withCredentials = true;
        tokenXhr.setRequestHeader("Accept", "application/json");
        tokenXhr.onload = function () {
          if (tokenXhr.status !== 200) return;
          var data;
          try { data = JSON.parse(tokenXhr.responseText); } catch (e) { return; }

          self.yDoc = new Y.Doc({ gc: false });
          // Same origin/port as the page itself -- LiveDocSyncServer.js
          // rides the shared WS listener under /livedoc-sync/, no separate
          // port to configure or inject any more.
          var wsScheme = (typeof location !== "undefined" && location.protocol === "https:") ? "wss:" : "ws:";
          var wsUrl = wsScheme + "//" + location.host + "/livedoc-sync";
          self.wsProvider = new WebsocketProvider(wsUrl, self._genesisObjId, self.yDoc, {
            connect: true,
            params: { token: data.token },
          });

          self._publishPresence();
          // BUG FIX: DID.js's own boot-time restoreSession() (an async
          // fetch chain — loadMeta, loadDocument, then a server round trip)
          // can still be in flight when this runs — this route's own
          // space-token fetch and restoreSession's chain finish at
          // comparable times with no ordering guarantee between them
          // (confirmed live: with restoreSession's server round trip
          // artificially slowed, this handler ran with currentUser() still
          // null and published presence as {did:null,handle:"anonymous"}).
          // Since _onAwarenessChange's `if (presence && presence.did)`
          // guard then silently drops that entry, and nothing here ever
          // republished it afterward, a signed-in visitor who merely lost
          // this race never showed up in anyone's Active Members list for
          // their whole visit. Same race Shop.js's _bindIdentity documents
          // and fixes the same way: listen for identityChanged in case it
          // fires later, AND re-call restoreSession (idempotent) to get a
          // definitive answer regardless of whether the signal already
          // fired before this connected.
          self._identityConnection = lively.bindings.connect(
            lively.identity.did, "identityChanged", self, "_publishPresence");
          lively.identity.did.restoreSession(function () { self._publishPresence(); });

          // Follow the ambient presence panel's status picker / auto-idle
          // (AmbientPresencePanel._broadcastStatus) so the change reaches
          // everyone's member list without waiting on any poll. The lounge
          // is a page-lifetime controller with no teardown hook, so this
          // is installed once, not removed.
          if (typeof window !== "undefined" && !self._statusListenerInstalled) {
            self._statusListenerInstalled = true;
            window.addEventListener("lively-presence-status", function () { self._publishPresence(); });
          }

          var awareness = self.wsProvider.awareness;
          awareness.on("change", function () { self._onAwarenessChange(); });
          // _publishPresence above ran BEFORE this listener existed, so the
          // local state it set never fired a "change" the lounge saw — a
          // member alone in the constellation never appeared in their own
          // (or anyone's) Active Members until some other client's state
          // changed. Sync once now from whatever awareness already holds.
          self._onAwarenessChange();
        };
        tokenXhr.onerror = function () {};
        tokenXhr.send();
      },

      _publishPresence: function () {
        if (!this.wsProvider) return;
        var user = lively.identity.did.currentUser();
        var panel = lively.identity.AmbientPresencePanel;
        this.wsProvider.awareness.setLocalStateField("presence", {
          did: user && user.did,
          handle: (user && user.handle) || "anonymous",
          // Online / idle / dnd / invisible, from the ambient presence panel.
          status: (panel && panel.getEffectiveStatus) ? panel.getEffectiveStatus() : "online",
          explicit: !!(panel && panel.isStatusExplicit && panel.isStatusExplicit()),
        });
      },

      // One account can have several awareness clients (other tabs, other
      // devices, a tab still running older code that publishes no status).
      // An explicit pick wins over the default / auto-idle, and among
      // several explicit picks the most restrictive one wins, so a stray
      // default-online client can never un-hide an Invisible user. With no
      // explicit pick anywhere, any active (online) client beats a hidden
      // tab that auto-idled.
      _resolveClientStatus: function (clients) {
        var RANK = { online: 0, idle: 1, dnd: 2, invisible: 3 };
        var explicit = clients.filter(function (c) { return c.explicit; });
        if (explicit.length) {
          return explicit.reduce(function (best, c) {
            return (RANK[c.status] || 0) > (RANK[best] || 0) ? c.status : best;
          }, explicit[0].status);
        }
        return clients.some(function (c) { return c.status === "online"; }) ? "online" : clients[0].status;
      },

      _onAwarenessChange: function () {
        if (!this.wsProvider) return;
        var states = this.wsProvider.awareness.getStates();
        var clientsByDid = {};
        states.forEach(function (state) {
          var presence = state && state.presence;
          if (!presence || !presence.did) return;
          // A client that predates the status field publishes none and
          // counts as a default (non-explicit) online.
          (clientsByDid[presence.did] = clientsByDid[presence.did] || []).push({
            status: presence.status || "online",
            explicit: !!presence.explicit,
          });
        });
        var byDid = {};
        for (var did in clientsByDid) byDid[did] = this._resolveClientStatus(clientsByDid[did]);
        this._presenceByDid = byDid;
        this._renderMemberList();
      },
    },

    // ─── membership — menu bar entry (§1.3 pattern) ────────────────────────
    // Replaces the generic per-world menu bar entry's rename affordance with
    // a constellation-aware dropdown — the lounge boots its own separate
    // Lively world (buildConstellationLoungePage), so it gets its own
    // un-patched WorldNameMenuBarEntry instance and needs this too.

    "membership", {
      _installMenuBarEntry: function () {
        var self = this;
        var attempts = 0;
        (function tryInstall() {
          var entry = null;
          var menuBar = typeof $world !== "undefined" && $world && $world.get(/^MenuBar/);
          if (menuBar) {
            entry = (menuBar.submorphs || []).find(function (m) { return m.name === "WorldNameMenuBarEntry"; });
          }
          if (entry) return self._patchMenuBarEntry(entry);
          if (++attempts > 25) return;
          setTimeout(tryInstall, 200);
        })();
      },

      _patchMenuBarEntry: function (entry) {
        var self = this;
        this._menuBarEntry = entry;
        var label = "c/" + this._displayName();
        entry.currentWorldDisplayName = function () { return label; };
        entry.toolTip = "Constellation " + this._displayName() + " — click for options";
        entry.onMouseUp = function (evt) {
          self._openMembershipMenu(entry);
          evt.stop();
          return true;
        };
        entry.update();
      },

      _openMembershipMenu: function (entry) {
        var self = this;
        var items = [];

        if (this._canWrite) {
          items.push(["✓ Member", function () {}]);
        } else if (this._joinRequestStatus === "pending") {
          items.push(["Request pending…", function () {}]);
        } else {
          items.push(["Join…", function () { self._requestJoin(); }]);
        }

        items.push(["Open wiki", function () {
          window.location.href = "/c/" + encodeURIComponent(self._displayName()) + "/wiki";
        }]);

        // Straight to the settings dialog's "Members & Bots" tab (the same
        // dialog the Quick Info panel's gear opens).
        if (this._isController) {
          items.push(["Manage members & bots…", function () { self._openConstellationSettings("members"); }]);
        }

        var pos = entry.worldPoint(lively.pt(0, entry.getExtent().y));
        lively.morphic.Menu.openAt(pos, "c/" + this._displayName(), items);
      },

      // A real, client-signed postcard riding the same postal rail, never
      // server-fabricated.
      _requestJoin: function () {
        var self = this;
        var user = lively.identity.did.currentUser();
        if (!user) return this._showError("Not signed in.");

        lively.require("lively.identity.PostCardSerializer").toRun(function () {
          var doc = {
            type: "doc",
            content: [{
              type: "paragraph",
              content: [{ type: "text", text: "@" + lively.identity.did.displayHandle() + " wants to join c/" + self._name + "." }],
            }],
          };
          lively.identity.postCardSerializer.serializePlainToEnvelope({
            doc: doc,
            title: "Join request for c/" + self._name,
            titleExplicit: true,
            constellation: self._name,
            visibility: "public",
            stateMeta: { kind: "constellation-join-request" },
          }, function (err, envelope) {
            if (err) return self._showError("Could not create join request: " + err.message);

            var base = lively.identity.did.baseUrl();
            var putXhr = new XMLHttpRequest();
            putXhr.open("PUT", base + "/@" + encodeURIComponent(user.handle) + "/" + encodeURIComponent(envelope.objId), true);
            putXhr.withCredentials = true;
            putXhr.setRequestHeader("Content-Type", "application/json");
            putXhr.onload = function () {
              if (putXhr.status !== 200) return self._showError("Could not save join request card (" + putXhr.status + ")");

              var postXhr = new XMLHttpRequest();
              postXhr.open("POST", base + "/c/" + encodeURIComponent(self._name) + "/join-requests", true);
              postXhr.withCredentials = true;
              postXhr.setRequestHeader("Content-Type", "application/json");
              postXhr.onload = function () {
                if (postXhr.status !== 201) {
                  var msg = "Join request failed (" + postXhr.status + ")";
                  try { var body = JSON.parse(postXhr.responseText); if (body.error) msg = body.error; } catch (e) {}
                  return self._showError(msg);
                }
                self._joinRequestStatus = "pending";
                $world.alert("Join request sent — the constellation's controller(s) will see it in their mailbox.");
              };
              postXhr.onerror = function () { self._showError("Network error sending join request"); };
              postXhr.send(JSON.stringify({ objId: envelope.objId }));
            };
            putXhr.onerror = function () { self._showError("Network error saving join request card"); };
            putXhr.send(JSON.stringify(envelope));
          });
        });
      },
    },

    // ─── runtime lookup + errors ──────────────────────────────────────────────

    "runtime", {
      _Y: function () {
        return (typeof Y !== "undefined" && Y) ||
               (typeof window !== "undefined" && window.Y) ||
               null;
      },

      _WebsocketProvider: function () {
        return (typeof WebsocketProvider !== "undefined" && WebsocketProvider) ||
               (typeof window !== "undefined" && window.WebsocketProvider) ||
               null;
      },

      _showError: function (msg) {
        console.error("[ConstellationLounge]", msg);
        // Was console-only -- every one of this file's 15+ call sites
        // (join-request failures, feed/cluster load failures, RSVP, upload,
        // and critically the "cluster created but encryption mint failed"
        // path) silently showed the user nothing. Confirmed live 2026-10-02
        // clicking through NewRoomDialog's real E2EE create flow: the room
        // was created and its mint failure correctly logged to console, but
        // nothing on screen told the user their new cluster was stuck
        // e2ee-pending. $world.alert is the same precedent RoomView.js
        // already uses for an equivalent user-facing error.
        $world.alert(msg);
      },
    });

    // Static open helper — constructs a fresh controller bound to $world.
    // Callers (buildConstellationLoungePage's onStartWorld hook) are
    // expected to only call this once $world already exists.
    lively.identity.ConstellationLounge = {
      open: function (name) {
        var controller = new lively.identity.ConstellationLoungeController();
        controller.open(name);
        return controller;
      },
    };

  });
