/**
 * lively.identity.MediaPickerDialog
 *
 * A floating GIF/Sticker/Emoji picker popup for RoomView.js's chat
 * composer (its two new Material Symbols icon buttons — "mood" for emoji,
 * "gif" for GIF/sticker — open this same dialog on the matching tab).
 *
 * Built as a real morphic panel (`lively.morphic.Box` + `Text`/`Image`
 * submorphs, added straight to `$world`) rather than a raw DOM overlay, per
 * this project's stated preference for full morphic construction —
 * everything here stays halo-selectable/inspectable like any other morph.
 * The one native element is the search box's `<input>` (via
 * `Text#beInputLine()`), same idiom RoomView.js's own chat input already
 * uses — safe to nest directly in a morph's own shapeNode now that
 * Events.js's three focus-stealing bugs are fixed (see CLAUDE.md).
 *
 * `lively.identity.MediaPickerController` is a plain `Object.subclass`
 * instance (not a `lively.BuildSpec`/`addScript`-driven morph), so its
 * methods keep a normal JS closure over this file's module-level
 * constants/helpers — no risk of the BuildSpec-reconstruction closure-loss
 * gotcha documented in CLAUDE.md.
 *
 * GIFs/Stickers come from Klipy (core/servers/KlipyProxyServer.js proxies
 * the search/trending calls so the real API key never reaches the
 * browser). Each result item's media lives at item.file[size][format].url —
 * sizes "xs"/"sm"/"md"/"hd", formats "gif"/"webp"/"jpg or png"/"mp4"/"webm"
 * — confirmed live against real /gifs/trending and /stickers/trending
 * responses (see pickFileUrl/extractMediaUrl below). findMediaUrl's
 * generic recursive scan is kept only as a last-resort fallback in case a
 * future Klipy response ever omits the expected size/format.
 *
 * Emoji data is the full Unicode set (~1900 emoji, 9 groups) vendored from
 * the `unicode-emoji-json` npm package (MIT) into
 * core/media/emoji-picker/emoji-by-group.json — fetched once and cached.
 */

module("lively.identity.MediaPickerDialog")
  .requires(
    "lively.identity.DID",
    "lively.identity.Crypto",
  )
  .toRun(function () {

    // 340 originally, confirmed live to be too narrow: the emoji grid's 9
    // columns (316px content box, 9*34=306px of actual cells) fit fine
    // against the box's own *set* width, but the vertical scrollbar itself
    // eats ~15px of *client* width when content overflows vertically
    // (clientWidth 301 vs scrollWidth 306 — measured live), which is just
    // enough to trigger an unwanted second, horizontal scrollbar. 360 keeps
    // the same 9 columns with comfortable slack past the scrollbar's own
    // width instead of a razor-thin fit.
    var PANEL_W = 360;
    var PANEL_H = 420;
    var TAB_H = 36;
    var SEARCH_H = 44;
    var CAT_RAIL_H = 32;
    var GRID_PAD = 12;

    var PANEL_BG    = Color.rgb(0x2b, 0x0e, 0x2d);   // near BG_SIDEBAR, slightly darker
    var PILL_BG     = Color.rgb(0x4a, 0x08, 0x4e);
    var TEXT_PRIMARY = Color.rgb(242, 243, 245);
    var TEXT_MUTED   = Color.rgb(181, 186, 193);
    var TEXT_FAINT   = Color.rgb(148, 155, 164);
    var ACCENT      = Color.rgb(0xE8, 0x49, 0x7E);   // matches AmbientPresencePanel's pink accent
    var HOVER_BG    = Color.rgba(255, 255, 255, 0.08);

    var SEARCH_DEBOUNCE_MS = 350;
    var MEDIA_COLS = 2;
    // Perf cap on how many emoji Text morphs get rendered at once — the
    // full "People & Body" group alone is ~390 entries; uncapped rendering
    // of every match in a broad search would build far more morphs than a
    // popup grid needs to show at a time.
    var EMOJI_RENDER_CAP = 400;

    var EMOJI_DATA_URL = "/core/media/emoji-picker/emoji-by-group.json";

    // Order must match core/media/emoji-picker/emoji-by-group.json's own
    // group order (Smileys & Emotion, People & Body, Animals & Nature,
    // Food & Drink, Travel & Places, Activities, Objects, Symbols, Flags).
    var CATEGORY_ICONS = [
      "mood", "emoji_people", "pets", "restaurant",
      "flight", "sports_soccer", "lightbulb", "emoji_symbols", "flag",
    ];

    // Flag search only matches the vendored dataset's own official/formal
    // country name (e.g. "flag Palestinian Territories", "flag Türkiye",
    // "flag Czechia") — confirmed live that the common name people
    // actually type often isn't even a substring of it ("palestine" isn't
    // a substring of "palestinian", they diverge at the 9th letter). Maps
    // a common alternate name, keyed by the *exact* full lowercased query,
    // to a substring that genuinely appears in that entry's real name —
    // checked against this project's own vendored emoji-by-group.json
    // (Flags group) rather than guessed. Not exhaustive — just the
    // well-known cases most likely to get typed. See _searchEmoji.
    var COUNTRY_SEARCH_ALIASES = {
      "palestine": "palestinian territories",
      "usa": "united states",
      "u.s.a.": "united states",
      "america": "united states",
      "uk": "united kingdom",
      "britain": "united kingdom",
      "great britain": "united kingdom",
      "holland": "netherlands",
      "ivory coast": "ivoire",
      "cote d'ivoire": "ivoire",
      "cote divoire": "ivoire",
      "czech republic": "czechia",
      "east timor": "timor-leste",
      "swaziland": "eswatini",
      "uae": "united arab emirates",
      "turkey": "türkiye",
      "macau": "macao",
      "vatican": "vatican city",
      "saint kitts": "kitts",
      "saint lucia": "lucia",
      "saint martin": "martin",
      "saint helena": "helena",
      "saint vincent": "vincent",
      "saint pierre": "pierre",
      "saint barthelemy": "barth",
      "saint barthélemy": "barth",
    };

    var TONE_SIZE = 26;
    var TONE_GAP = 8;

    // key: null means "no modifier" (plain/default yellow glyph) — stored
    // as-is in state.emojiSkinTone (see _saveSkinToneSetting) so the
    // modifier-character mapping stays entirely in this one table rather
    // than leaking Unicode escapes into the persisted setting. modifier
    // chars are the 5 Fitzpatrick scale codepoints (U+1F3FB-U+1F3FF) —
    // appended after a base emoji to retint it, only for entries whose
    // vendored data marks skin_tone_support:true (see _toneGlyph). swatch
    // colors are approximate common representations of each tone, same
    // idiom most emoji pickers use for this selector — not meant to be
    // exact.
    var SKIN_TONES = [
      { key: null, modifier: null, swatch: Color.rgb(0xFF, 0xCC, 0x4D) },
      { key: "light", modifier: "\u{1F3FB}", swatch: Color.rgb(0xF5, 0xD6, 0xBA) },
      { key: "medium_light", modifier: "\u{1F3FC}", swatch: Color.rgb(0xE6, 0xB9, 0x8D) },
      { key: "medium", modifier: "\u{1F3FD}", swatch: Color.rgb(0xC8, 0x91, 0x5F) },
      { key: "medium_dark", modifier: "\u{1F3FE}", swatch: Color.rgb(0xA6, 0x71, 0x4A) },
      { key: "dark", modifier: "\u{1F3FF}", swatch: Color.rgb(0x6B, 0x44, 0x23) },
    ];

    function toneForKey(key) {
      for (var i = 0; i < SKIN_TONES.length; i++) if (SKIN_TONES[i].key === key) return SKIN_TONES[i];
      return SKIN_TONES[0];
    }

    function noDrag(m) {
      m.draggingEnabled = false;
      m.droppingEnabled = false;
      m.grabbingEnabled = false;
      return m;
    }

    // Country/region flags are two Regional Indicator Symbol codepoints
    // (U+1F1E6-U+1F1FF); England/Scotland/Wales are a "waving black flag"
    // (U+1F3F4) followed by Unicode Tag characters (U+E0000-U+E007F).
    // Confirmed live (raw non-Lively <div> showed the identical failure,
    // ruling out a Lively/morphic rendering bug): this Windows Chrome
    // environment's system emoji font has no glyphs for either
    // construction, falling back to literal two-letter text for the
    // former and nothing usable for the latter. The 8 other "Flags"
    // category entries (chequered/crossed/waving/pirate/pride/trans flag
    // etc.) are ordinary single-codepoint or plain-ZWJ emoji and render
    // fine natively — do NOT flag those as needing an image (confirmed
    // live: an earlier version of this check matched the pirate flag,
    // 1F3F4+ZWJ+skull-and-crossbones, as if it were a tag-sequence
    // subdivision flag purely because it also starts with 1F3F4; checking
    // for a genuine Tag character specifically at the second codepoint
    // fixed that false positive).
    var TAG_CHAR_MIN = 0xE0000, TAG_CHAR_MAX = 0xE007F;
    var REGIONAL_INDICATOR_MIN = 0x1F1E6, REGIONAL_INDICATOR_MAX = 0x1F1FF;
    function needsFlagImage(glyph) {
      var chars = Array.from(glyph);
      if (chars.length === 2 && chars.every(function (ch) {
        var cp = ch.codePointAt(0);
        return cp >= REGIONAL_INDICATOR_MIN && cp <= REGIONAL_INDICATOR_MAX;
      })) return true;
      if (chars[0] && chars[0].codePointAt(0) === 0x1F3F4 && chars[1]) {
        var cp2 = chars[1].codePointAt(0);
        return cp2 >= TAG_CHAR_MIN && cp2 <= TAG_CHAR_MAX;
      }
      return false;
    }

    // Vendored from Twemoji (CC-BY 4.0, see core/media/emoji-picker/flags/LICENSE)
    // via the emoji-datasource-twitter npm package, which names each image
    // file by its emoji's own codepoint sequence — so the filename is
    // computed directly from the glyph at render time rather than kept in
    // a separate lookup table that could drift out of sync (verified live
    // against every flag entry in emoji-by-group.json, all 262 that need
    // one resolve to a real vendored file — see the flag-completeness
    // check run while building this).
    function flagImageUrl(glyph) {
      if (!needsFlagImage(glyph)) return null;
      var hex = Array.from(glyph).map(function (ch) { return ch.codePointAt(0).toString(16); }).join("-");
      return "/core/media/emoji-picker/flags/" + hex + ".png";
    }

    // Same one-time-injected-<style>-tag-with-a-class technique
    // ConstellationLounge.js's _ensureCommentBodyStyle uses for its own
    // comment-thread scrollbar (id-guarded so re-opening the picker, or a
    // second MediaPickerController, never double-injects). Thumb is this
    // dialog's own ACCENT; track matches PANEL_BG so it reads as part of
    // the panel rather than a separate lighter strip.
    function ensureScrollbarStyle() {
      if (document.getElementById("media-picker-scroll-style")) return;
      var styleEl = document.createElement("style");
      styleEl.id = "media-picker-scroll-style";
      styleEl.textContent =
        ".media-picker-scroll{scrollbar-width:thin;scrollbar-color:#E8497E #2B0E2D;}" +
        ".media-picker-scroll::-webkit-scrollbar{width:8px;}" +
        ".media-picker-scroll::-webkit-scrollbar-track{background:#2B0E2D;}" +
        ".media-picker-scroll::-webkit-scrollbar-thumb{background:#E8497E;border-radius:999px;}" +
        ".media-picker-scroll::-webkit-scrollbar-thumb:hover{background:#C23568;}";
      document.head.appendChild(styleEl);
    }

    // item.file[size][format].url, confirmed live — see the file header.
    function pickFileUrl(item, size, format) {
      try { return item.file[size][format].url || null; } catch (e) { return null; }
    }

    // Prefers .gif (works as a plain <img> src — Image morphs render via
    // setImageURL, which can't play the .mp4/.webm variants Klipy also
    // offers), falling back to .webp (animated, smaller) and then .png
    // (stickers' still/transparent variant). Falls all the way back to
    // findMediaUrl's generic scan if a result is ever missing the expected
    // shape entirely.
    function extractMediaUrl(item, size) {
      return pickFileUrl(item, size, "gif") || pickFileUrl(item, size, "webp") ||
        pickFileUrl(item, size, "png") || findMediaUrl(item, 0);
    }

    // Recursively searches a Klipy result item for the first string that
    // looks like a media URL — a last-resort fallback for extractMediaUrl
    // above, in case a result is ever missing the file[size][format].url
    // shape confirmed live for the common case.
    function findMediaUrl(obj, depth) {
      if (obj == null || depth > 4) return null;
      if (typeof obj === "string") {
        return (/^https?:\/\/\S+\.(gif|webp|mp4|png|jpe?g)(\?[^\s]*)?$/i.test(obj)) ? obj : null;
      }
      if (Array.isArray(obj)) {
        for (var i = 0; i < obj.length; i++) {
          var r = findMediaUrl(obj[i], depth + 1);
          if (r) return r;
        }
        return null;
      }
      if (typeof obj === "object") {
        var keys = Object.keys(obj);
        for (var k = 0; k < keys.length; k++) {
          var r2 = findMediaUrl(obj[keys[k]], depth + 1);
          if (r2) return r2;
        }
      }
      return null;
    }

    Object.subclass("lively.identity.MediaPickerController",

    "initializing", {
      initialize: function () {
        this._panel = null;
        this._catcher = null;
        this._activeTab = "emoji";
        this._onPick = null;
        this._emojiData = null;      // lazy-fetched, cached across opens
        this._emojiCategory = 0;
        this._searchTimer = null;
        this._reqSeq = 0;            // guards stale async search responses
        this._emptyMessage = "No results";

        this._skinTone = null;              // key into SKIN_TONES, null = default
        this._skinToneUserChanged = false;  // true once picked this session — stops a still-in-flight settings load from clobbering it
        this._skinToneLoaded = false;
        this._skinToneLoadCallbacks = null; // in-flight-request de-dupe for _ensureSkinToneLoaded
        this._settingsEnvelope = null;      // cached GET /@handle/settings response, reused for the PUT
        this._toneCatcher = null;
      },
    },

    "opening", {

      isOpen: function () { return !!this._panel; },

      // anchorRect: world-space rect of the chat input row (RoomView.js's
      // inputRow.globalBounds()) — the panel right-aligns above it with a
      // small gap, the same corner a composer-attached popup typically
      // opens from.
      open: function (anchorRect, opts) {
        opts = opts || {};
        if (this._panel) this.close();
        this._onPick = opts.onPick || function () {};
        this._activeTab = opts.initialTab || "emoji";

        this._buildCatcher();
        this._buildPanel(anchorRect);
        this._selectTab(this._activeTab);
      },

      close: function () {
        if (this._searchTimer) { clearTimeout(this._searchTimer); this._searchTimer = null; }
        if (this._catcher) { this._catcher.remove(); this._catcher = null; }
        if (this._panel) { this._panel.remove(); this._panel = null; }
      },

      // Full-world, invisible click-catcher added just before the panel so
      // any click outside the popup closes it (a common click-away-to-
      // dismiss pattern), same "sibling under $world" placement CLAUDE.md's
      // dialog-overlay
      // section calls for. fill:null keeps it invisible while still
      // participating in hit-testing (unlike eventsAreIgnored morphs,
      // which are explicitly made hit-test-transparent). Sized to the
      // world's own extent, not an oversized rect — a morph reaching past the
      // world grows the page's scrollable area (a 20000px one made
      // scrollWidth/scrollHeight 15000 and showed both scrollbars for as long
      // as the picker was open).
      _buildCatcher: function () {
        var self = this;
        var worldExtent = $world.getExtent();
        var c = noDrag(new lively.morphic.Box(lively.rect(0, 0, worldExtent.x, worldExtent.y)));
        c.applyStyle({ fill: null, borderWidth: 0 });
        c.onMouseUp = function (evt) { self.close(); return true; };
        $world.addMorph(c);
        this._catcher = c;
      },

      _buildPanel: function (anchorRect) {
        var self = this;
        var x = anchorRect.maxX() - PANEL_W;
        var y = anchorRect.y - PANEL_H - 8;
        // Opens above the anchor (RoomView's input sits at the bottom of its
        // window), flips below it when there's no room above (a composer near
        // the top of the screen), and stays inside the world either way.
        var worldExtent = $world.getExtent();
        if (y < 8) y = anchorRect.maxY() + 8;
        x = Math.max(8, Math.min(x, worldExtent.x - PANEL_W - 8));
        y = Math.max(8, Math.min(y, worldExtent.y - PANEL_H - 8));

        var panel = noDrag(new lively.morphic.Box(lively.rect(x, y, PANEL_W, PANEL_H)));
        panel.isEpiMorph = true;
        panel.applyStyle({ fill: PANEL_BG, borderWidth: 0, borderRadius: 8, clipMode: "hidden" });
        $world.addMorph(panel);
        this._panel = panel;

        this._buildTabRow(panel);
        this._buildSearchRow(panel);
        this._buildContentArea(panel);

        var closeBtn = noDrag(new lively.morphic.Text(lively.rect(PANEL_W - 26, 6, 20, 20)));
        closeBtn.textString = "close";
        closeBtn.applyStyle({
          fontFamily: "'Material Symbols Rounded'", fontSize: 12, textColor: TEXT_MUTED,
          fill: null, borderWidth: 0, align: "center", allowInput: false, selectable: false,
          clipMode: "hidden", whiteSpaceHandling: "pre", handStyle: "pointer",
        });
        closeBtn.onMouseOver = function () { this.applyStyle({ textColor: TEXT_PRIMARY }); };
        closeBtn.onMouseOut = function () { this.applyStyle({ textColor: TEXT_MUTED }); };
        closeBtn.onMouseUp = function (evt) { self.close(); evt.stop(); return true; };
        panel.addMorph(closeBtn);
      },
    },

    "tabs", {

      _buildTabRow: function (panel) {
        var self = this;
        var tabs = [{ key: "gif", label: "GIFs" }, { key: "emoji", label: "Emoji" }, { key: "sticker", label: "Stickers" }];
        var tw = Math.floor(PANEL_W / tabs.length);
        this._tabMorphs = {};
        tabs.forEach(function (t, i) {
          var tab = noDrag(lively.morphic.Text.makeLabel(t.label, {
            fontSize: 12, fontWeight: "700", textColor: TEXT_MUTED, align: "center", fixedWidth: true,
          }));
          tab.setExtent(lively.pt(tw, TAB_H));
          tab.setPosition(lively.pt(i * tw, 0));
          tab.allowInput = false;
          tab.handStyle = "pointer";
          // Text.makeLabel -> beLabel() calls ignoreEvents() unconditionally
          // (TextCore.js) — correct default for a purely decorative label,
          // but it silently no-ops this morph's own onMouseUp forever
          // (Events.js's onMouseUpEntry bails out at `if
          // (this.eventsAreIgnored...) return false` before ever calling
          // it) since these tabs need to be clickable. Confirmed live: a
          // real click landed exactly on the tab's rendered text yet never
          // reached onMouseUp until this override was added.
          tab.unignoreEvents();
          tab.onMouseUp = function (evt) { self._selectTab(t.key); evt.stop(); return true; };
          panel.addMorph(tab);
          this._tabMorphs[t.key] = tab;

          var underline = noDrag(new lively.morphic.Box(lively.rect(i * tw + 6, TAB_H - 2, tw - 12, 2)));
          underline.applyStyle({ fill: null, borderWidth: 0, borderRadius: 1 });
          panel.addMorph(underline);
          tab._underline = underline;
        }, this);
      },

      _updateTabHighlight: function () {
        var self = this;
        Object.keys(this._tabMorphs).forEach(function (key) {
          var tab = self._tabMorphs[key];
          var active = key === self._activeTab;
          tab.applyStyle({ textColor: active ? TEXT_PRIMARY : TEXT_MUTED });
          tab._underline.applyStyle({ fill: active ? ACCENT : null });
        });
      },

      _selectTab: function (tab) {
        var self = this;
        var isEmoji = tab === "emoji";
        this._activeTab = tab;
        this._updateTabHighlight();
        this._searchInput.textString = "";
        this._searchPlaceholder.setVisible(true);
        this._searchPlaceholder.textString =
          tab === "emoji" ? "Search Emoji" : (tab === "gif" ? "Search Klipy GIFs" : "Search Klipy Stickers");
        this._catRail.setVisible(isEmoji);
        this._mediaGrid.setVisible(!isEmoji);
        this._emojiGrid.setVisible(isEmoji);

        // The skin-tone circle only makes sense on the Emoji tab — the
        // search pill shrinks to make room for it there, back to full
        // width otherwise (see _buildSearchRow for the two widths' math).
        this._toneCircle.setVisible(isEmoji);
        if (!isEmoji) this._closeTonePopover();
        var pillW = isEmoji ? (this._toneCircleX - TONE_GAP - GRID_PAD) : (PANEL_W - GRID_PAD * 2);
        this._pill.setExtent(lively.pt(pillW, SEARCH_H - 12));
        this._searchInput.setExtent(lively.pt(pillW - 40, 24));
        this._searchPlaceholder.setExtent(lively.pt(pillW - 40, 22));
        if (isEmoji) this._ensureSkinToneLoaded(function () {}); // fire-and-forget: reflects the saved tone once it arrives

        // _runSearch() re-derives the right initial content for whichever
        // tab is now active: an empty query on the emoji tab renders the
        // selected category (_searchEmoji), and an empty query on the
        // gif/sticker tabs renders trending (_fetchMedia's action picks
        // "trending" over "search" when query is empty).
        this._runSearch();
      },
    },

    "search", {

      _buildSearchRow: function (panel) {
        var self = this;
        var y = TAB_H + 6;
        var rowH = SEARCH_H - 12;
        var pill = noDrag(new lively.morphic.Box(lively.rect(GRID_PAD, y, PANEL_W - GRID_PAD * 2, rowH)));
        pill.applyStyle({ fill: PILL_BG, borderWidth: 0, borderRadius: 8 });
        panel.addMorph(pill);
        this._pill = pill;

        var icon = noDrag(new lively.morphic.Text(lively.rect(8, 6, 18, 18)));
        icon.textString = "search";
        icon.applyStyle({
          fontFamily: "'Material Symbols Rounded'", fontSize: 11, textColor: TEXT_FAINT,
          fill: null, borderWidth: 0, align: "center", allowInput: false, selectable: false,
          clipMode: "hidden", whiteSpaceHandling: "pre",
        });
        pill.addMorph(icon);

        var input = noDrag(new lively.morphic.Text(lively.rect(30, 4, PANEL_W - GRID_PAD * 2 - 40, 22)));
        input.beInputLine({
          fontSize: 13, fontFamily: "Helvetica", textColor: TEXT_PRIMARY,
          fill: null, borderWidth: 0, whiteSpaceHandling: "pre",
        });
        pill.addMorph(input);
        this._searchInput = input;

        var placeholder = noDrag(lively.morphic.Text.makeLabel("Search", {
          fontSize: 13, textColor: TEXT_FAINT,
        }));
        placeholder.setExtent(lively.pt(PANEL_W - GRID_PAD * 2 - 40, 22));
        placeholder.setPosition(lively.pt(30, 4));
        placeholder.eventsAreIgnored = true;
        pill.addMorph(placeholder);
        placeholder.renderContext().shapeNode.style.pointerEvents = "none";
        this._searchPlaceholder = placeholder;

        var superKeyDown = input.onKeyDown;
        input.onKeyDown = function (evt) {
          var result = superKeyDown ? superKeyDown.call(this, evt) : undefined;
          self._searchPlaceholder.setVisible(!this.textString);
          self._scheduleSearch();
          return result;
        };

        // Skin-tone circle — right of the search pill, Emoji tab only
        // (_selectTab toggles visibility + shrinks the pill to make room).
        // Fixed x regardless of tab so the pill-width math in _selectTab
        // has one stable anchor to compute against.
        var toneX = PANEL_W - GRID_PAD - TONE_SIZE;
        var toneY = y + Math.round((rowH - TONE_SIZE) / 2);
        this._toneCircleX = toneX;

        var circle = noDrag(new lively.morphic.Morph());
        circle.setShape(new lively.morphic.Shapes.Ellipse(lively.rect(toneX, toneY, TONE_SIZE, TONE_SIZE)));
        circle.applyStyle({ fill: SKIN_TONES[0].swatch, borderWidth: 2, borderColor: PANEL_BG });
        circle.handStyle = "pointer";
        circle.setVisible(false);
        circle.onMouseUp = function (evt) { self._toggleTonePopover(); evt.stop(); return true; };
        panel.addMorph(circle);
        this._toneCircle = circle;

        this._buildTonePopover(panel, toneX, toneY + TONE_SIZE + 6);
      },

      // A small popup row of swatches (default + 5 Fitzpatrick tones),
      // right-aligned under the tone circle, extending leftward so it
      // never runs past the panel's own edge. Built once, hidden until
      // _toggleTonePopover shows it — see _openTonePopover/_closeTonePopover
      // for the click-elsewhere-closes-it catcher (scoped to this panel,
      // not the world-covering one _buildCatcher uses for the whole dialog).
      _buildTonePopover: function (panel, circleX, y) {
        var self = this;
        var SW = 22, GAP = 6, PAD = 6;
        var rowW = SKIN_TONES.length * SW + (SKIN_TONES.length - 1) * GAP + PAD * 2;
        var x = Math.max(GRID_PAD, circleX + TONE_SIZE - rowW);

        var popup = noDrag(new lively.morphic.Box(lively.rect(x, y, rowW, SW + PAD * 2)));
        popup.applyStyle({ fill: PILL_BG, borderWidth: 0, borderRadius: 999 });
        popup.setVisible(false);
        panel.addMorph(popup);
        this._tonePopup = popup;

        SKIN_TONES.forEach(function (tone, i) {
          var sw = noDrag(new lively.morphic.Morph());
          sw.setShape(new lively.morphic.Shapes.Ellipse(lively.rect(PAD + i * (SW + GAP), PAD, SW, SW)));
          sw.applyStyle({ fill: tone.swatch, borderWidth: 2, borderColor: PILL_BG });
          sw.handStyle = "pointer";
          sw.onMouseUp = function (evt) { self._selectTone(tone); evt.stop(); return true; };
          popup.addMorph(sw);
        });
      },

      _toggleTonePopover: function () {
        if (this._toneCatcher) this._closeTonePopover();
        else this._openTonePopover();
      },

      _openTonePopover: function () {
        var self = this;
        var catcher = noDrag(new lively.morphic.Box(lively.rect(0, 0, PANEL_W, PANEL_H)));
        catcher.applyStyle({ fill: null, borderWidth: 0 });
        catcher.onMouseUp = function (evt) { self._closeTonePopover(); return true; };
        this._panel.addMorph(catcher);
        this._toneCatcher = catcher;
        this._tonePopup.setVisible(true);
        this._panel.addMorph(this._tonePopup); // re-adding bumps it above the catcher just added
      },

      _closeTonePopover: function () {
        if (this._toneCatcher) { this._toneCatcher.remove(); this._toneCatcher = null; }
        if (this._tonePopup) this._tonePopup.setVisible(false);
      },

      _selectTone: function (tone) {
        var self = this;
        this._skinToneUserChanged = true;
        this._skinTone = tone.key;
        this._toneCircle.applyStyle({ fill: tone.swatch });
        this._closeTonePopover();
        if (this._activeTab === "emoji") this._runSearch(); // re-render the visible grid with the new tone applied
        this._ensureSkinToneLoaded(function () { self._saveSkinToneSetting(tone.key); });
      },

      // Fetches GET /@handle/settings once (cached in _settingsEnvelope,
      // reused for the PUT in _saveSkinToneSetting — same envelope/cid
      // discipline PostCardMailbox.js's _patchBlockList uses for its own
      // settings field). In-flight requests are de-duped via
      // _skinToneLoadCallbacks rather than fired once per caller.
      _ensureSkinToneLoaded: function (cb) {
        var self = this;
        if (this._skinToneLoaded) return cb();
        if (this._skinToneLoadCallbacks) { this._skinToneLoadCallbacks.push(cb); return; }
        this._skinToneLoadCallbacks = [cb];

        function done() {
          self._skinToneLoaded = true;
          var cbs = self._skinToneLoadCallbacks;
          self._skinToneLoadCallbacks = null;
          cbs.forEach(function (f) { f(); });
        }

        var user = lively.identity.did.currentUser ? lively.identity.did.currentUser() : null;
        if (!user) return done();

        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("GET", base + "/@" + encodeURIComponent(user.handle) + "/settings", true);
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status === 200) {
            try {
              var env = JSON.parse(xhr.responseText);
              self._settingsEnvelope = env;
              // Skip if the user already picked a tone this session (e.g.
              // clicked one before this in-flight load resolved) — this
              // load's job is only to seed the initial value, never to
              // override a choice already made.
              if (!self._skinToneUserChanged) {
                self._skinTone = (env.state && env.state.emojiSkinTone) || null;
                self._toneCircle.applyStyle({ fill: toneForKey(self._skinTone).swatch });
              }
            } catch (e) { /* leave defaults */ }
          }
          done();
        };
        xhr.onerror = function () { done(); };
        xhr.send();
      },

      // Persists the pick as state.emojiSkinTone — server-readable
      // metadata, not encrypted payload (same "settings" envelope
      // PostCardMailbox.js's block list already uses), so no signing
      // ceremony is needed, just a cid recompute over the (unchanged)
      // payload before every PUT.
      _saveSkinToneSetting: function (toneKey) {
        var user = lively.identity.did.currentUser ? lively.identity.did.currentUser() : null;
        if (!user || !this._settingsEnvelope) return; // signed out, or the load failed — nothing to persist to
        // DID.js re-GETs the envelope before writing, so the copy loaded when the
        // dialog opened cannot drop state saved since.
        lively.identity.did._patchRelationships(function (state) {
          state.emojiSkinTone = toneKey;
        }, function (err) {
          if (err) console.error("[MediaPickerDialog] saving the skin tone failed:", err);
        });
      },

      // Appends the current tone's modifier to a base glyph, only for
      // entries the vendored data marks skin_tone_support:true (most
      // objects/animals/symbols don't support it at all — appending a
      // modifier to those would just render as a base glyph + a stray
      // isolated skin-tone swatch character).
      //
      // Two fixes here, both confirmed live against the vendored data's
      // actual codepoint sequences (not guessed):
      //
      // 1. Several skin_tone_support:true entries (e.g. "victory hand")
      //    store their base glyph as [codepoint, FE0F] -- a trailing
      //    Variation Selector-16, needed to force emoji (not text)
      //    presentation when shown *without* a tone. Unicode's actual
      //    emoji_modifier_base + emoji_modifier sequences never include
      //    that VS16; appending straight after it produces a sequence
      //    real fonts don't recognize as one glyph (observed live: two
      //    separate glyphs, or an unrelated substituted glyph via the
      //    font's own ligature rules). Fix: strip a trailing VS16/VS15.
      //
      // 2. Hair-style entries (e.g. "man: red hair") are ZWJ sequences --
      //    [person, ZWJ(200D), hair-symbol] -- where Unicode's real
      //    modifier position is right after the *person*, before the ZWJ,
      //    not at the very end of the whole sequence. Appending at the
      //    end (this file's original approach) put the modifier after the
      //    hair-symbol instead, breaking the ZWJ join -- observed live as
      //    a stray line/border artifact between glyphs. Fix: insert the
      //    modifier after the base's first codepoint, not its last.
      _toneGlyph: function (emojiEntry) {
        var tone = toneForKey(this._skinTone);
        if (!tone.modifier || !emojiEntry.skin_tone_support) return emojiEntry.emoji;
        var base = emojiEntry.emoji.replace(/[\uFE0E\uFE0F]$/, "");
        var chars = Array.from(base); // codepoint-aware split -- a surrogate-pair emoji is still one element
        return chars[0] + tone.modifier + chars.slice(1).join("");
      },

      _scheduleSearch: function () {
        var self = this;
        if (this._searchTimer) clearTimeout(this._searchTimer);
        this._searchTimer = setTimeout(function () { self._runSearch(); }, SEARCH_DEBOUNCE_MS);
      },

      _runSearch: function () {
        var q = (this._searchInput.textString || "").trim();
        if (this._activeTab === "emoji") this._searchEmoji(q);
        else this._searchMedia(q);
      },
    },

    "emoji", {

      _ensureEmojiData: function (cb) {
        if (this._emojiData) return cb(this._emojiData);
        var self = this;
        var xhr = new XMLHttpRequest();
        xhr.open("GET", EMOJI_DATA_URL, true);
        xhr.onload = function () {
          if (xhr.status !== 200) return cb(null);
          try { self._emojiData = JSON.parse(xhr.responseText); } catch (e) { self._emojiData = null; }
          cb(self._emojiData);
        };
        xhr.onerror = function () { cb(null); };
        xhr.send();
      },

      _buildCategoryRail: function (panel, y) {
        var self = this;
        var rail = noDrag(new lively.morphic.Box(lively.rect(0, y, PANEL_W, CAT_RAIL_H)));
        rail.applyStyle({ fill: null, borderWidth: 0 });
        panel.addMorph(rail);
        this._catRail = rail;

        var n = CATEGORY_ICONS.length;
        var cellW = Math.floor(PANEL_W / n);
        this._catMorphs = [];
        CATEGORY_ICONS.forEach(function (glyph, i) {
          var btn = noDrag(new lively.morphic.Text(lively.rect(i * cellW + Math.round((cellW - 20) / 2), 4, 20, 20)));
          btn.textString = glyph;
          btn.applyStyle({
            fontFamily: "'Material Symbols Rounded'", fontSize: 12,
            textColor: i === self._emojiCategory ? TEXT_PRIMARY : TEXT_FAINT,
            fill: null, borderWidth: 0, align: "center", allowInput: false, selectable: false,
            clipMode: "hidden", whiteSpaceHandling: "pre", handStyle: "pointer",
          });
          btn.onMouseUp = function (evt) {
            self._emojiCategory = i;
            self._catMorphs.forEach(function (m, mi) { m.applyStyle({ textColor: mi === i ? TEXT_PRIMARY : TEXT_FAINT }); });
            self._searchInput.textString = "";
            self._searchPlaceholder.setVisible(true);
            self._renderEmojiGrid(self._emojiData ? self._emojiData[i].emojis : []);
            evt.stop();
            return true;
          };
          rail.addMorph(btn);
          self._catMorphs.push(btn);
        });
      },

      _searchEmoji: function (q) {
        var self = this;
        this._ensureEmojiData(function (data) {
          if (!data) { self._emptyMessage = "Emoji data failed to load"; self._renderEmojiGrid([]); return; }
          if (!q) { self._renderEmojiGrid(data[self._emojiCategory].emojis); return; }
          // e.name isn't always lowercase (flag entries are, e.g. "flag
          // South Sudan" — country/proper-noun capitalization), so it has
          // to be lowered too, not just the query — confirmed live: a
          // search for "south sudan" silently matched nothing without this,
          // since "flag South Sudan".indexOf("south sudan") is a
          // case-sensitive comparison that never matches the capitalized
          // name. slug is lowered defensively too even though this
          // dataset's slugs already are.
          var ql = q.toLowerCase();
          // A known alternate country name (see COUNTRY_SEARCH_ALIASES)
          // also searches its aliased term, in addition to the literal
          // query — so "palestine" still matches "flag Palestinian
          // Territories" even though it's not a literal substring of it.
          var terms = COUNTRY_SEARCH_ALIASES[ql] ? [ql, COUNTRY_SEARCH_ALIASES[ql]] : [ql];
          var results = [];
          data.forEach(function (group) {
            group.emojis.forEach(function (e) {
              var nameL = e.name.toLowerCase(), slugL = e.slug.toLowerCase();
              var isMatch = terms.some(function (t) { return nameL.indexOf(t) !== -1 || slugL.indexOf(t) !== -1; });
              if (isMatch) results.push(e);
            });
          });
          self._emptyMessage = "No emoji match “" + q + "”";
          self._renderEmojiGrid(results);
        });
      },

      _renderEmojiGrid: function (list) {
        var self = this;
        var grid = this._emojiGrid;
        (grid.submorphs || []).slice().forEach(function (m) { m.remove(); });

        if (!list.length) {
          var empty = noDrag(lively.morphic.Text.makeLabel(this._emptyMessage, { fontSize: 12, textColor: TEXT_FAINT }));
          empty.setPosition(lively.pt(GRID_PAD, GRID_PAD));
          grid.addMorph(empty);
          return;
        }

        var CELL = 34;
        var cols = Math.max(1, Math.floor((PANEL_W - GRID_PAD * 2) / CELL));
        var capped = list.slice(0, EMOJI_RENDER_CAP);
        capped.forEach(function (e, i) {
          var col = i % cols, row = Math.floor(i / cols);
          var cellRect = lively.rect(col * CELL, row * CELL, CELL, CELL);
          var flagUrl = flagImageUrl(e.emoji);
          var cell;
          if (flagUrl) {
            // Country/subdivision flags — see flagImageUrl's own comment
            // for why these need a vendored image rather than native text.
            // Never toned (flags don't support skin_tone_support), so the
            // plain e.emoji is always the right pick value here.
            cell = noDrag(new lively.morphic.Box(cellRect));
            cell.applyStyle({ fill: null, borderWidth: 0, clipMode: "hidden" });
            var img = noDrag(new lively.morphic.Image(lively.rect(5, 7, CELL - 10, CELL - 14)));
            img.applyStyle({ borderWidth: 0 });
            img.setImageURL(flagUrl);
            img.eventsAreIgnored = true;
            cell.addMorph(img);
          } else {
            cell = noDrag(new lively.morphic.Text(cellRect));
            cell.textString = self._toneGlyph(e);
            cell.applyStyle({
              fontSize: 15, fill: null, borderWidth: 0, align: "center", allowInput: false,
              selectable: false, whiteSpaceHandling: "pre",
            });
          }
          cell.applyStyle({ clipMode: "hidden", handStyle: "pointer" });
          cell.onMouseOver = function () { this.applyStyle({ fill: HOVER_BG, borderRadius: 6 }); };
          cell.onMouseOut = function () { this.applyStyle({ fill: null }); };
          cell.onMouseUp = function (evt) { self._pick({ type: "emoji", value: flagUrl ? e.emoji : self._toneGlyph(e) }); evt.stop(); return true; };
          grid.addMorph(cell);
        });
      },
    },

    "media", {

      _fetchMedia: function (category, query, cb) {
        // life_star's subserver loader mounts every core/servers/*.js
        // module under a "/nodejs/" prefix by default (subservers.js:
        // `this.baseURL = config.baseURL || '/nodejs/'`), not at the
        // bare root — confirmed live (a plain "/KlipyProxyServer/..."
        // URL 404s as a static-file lookup, same failure a *pre-existing*
        // working subserver route hit when tested the same wrong way).
        // URL.nodejsBase is this codebase's own established helper for
        // this exact prefix — RoomView.js's WebRTC signaling socket
        // (_openSignalingSocket) already builds its URL the same way.
        var action = query ? "search" : "trending";
        var qs = query ? ("?q=" + encodeURIComponent(query)) : "";
        var url = URL.nodejsBase.withFilename("KlipyProxyServer/" + category + "/" + action).toString() + qs;
        var xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          var data;
          try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; }
          if (xhr.status !== 200) {
            return cb(new Error((data && data.error) || ("Search failed (" + xhr.status + ")")));
          }
          cb(null, data);
        };
        xhr.onerror = function () { cb(new Error("Network error")); };
        xhr.send();
      },

      _extractMediaItems: function (data) {
        if (!data) return [];
        var list = null;
        if (data.data && Array.isArray(data.data.data)) list = data.data.data;
        else if (Array.isArray(data.data)) list = data.data;
        else if (Array.isArray(data)) list = data;
        return list || [];
      },

      _searchMedia: function (q) {
        var self = this;
        var reqId = ++this._reqSeq;
        var category = this._activeTab === "gif" ? "gifs" : "stickers";
        this._fetchMedia(category, q, function (err, data) {
          if (reqId !== self._reqSeq) return; // superseded by a newer search
          if (err) { self._emptyMessage = err.message; self._renderMediaGrid([]); return; }
          self._emptyMessage = q ? ("No results for “" + q + "”") : "Nothing trending right now";
          self._renderMediaGrid(self._extractMediaItems(data));
        });
      },

      _renderMediaGrid: function (items) {
        var self = this;
        var grid = this._mediaGrid;
        (grid.submorphs || []).slice().forEach(function (m) { m.remove(); });

        if (!items.length) {
          var empty = noDrag(lively.morphic.Text.makeLabel(this._emptyMessage, { fontSize: 12, textColor: TEXT_FAINT }));
          empty.setPosition(lively.pt(GRID_PAD, GRID_PAD));
          grid.addMorph(empty);
          return;
        }

        var colW = Math.floor((PANEL_W - GRID_PAD * 2 - 8) / MEDIA_COLS);
        var rowH = Math.round(colW * 0.75);
        var col = 0, y = 0, activeTab = this._activeTab;
        items.forEach(function (item) {
          // "xs" for the grid thumbnail (small/fast to load many at once),
          // "sm" for what actually gets sent/rendered in chat — a step up
          // in quality without shipping the multi-MB "hd" variant into
          // every room message.
          var thumbUrl = extractMediaUrl(item, "xs") || extractMediaUrl(item, "sm");
          var sendUrl = extractMediaUrl(item, "sm") || thumbUrl;
          if (!thumbUrl) return;
          var img = noDrag(new lively.morphic.Image(lively.rect(col * (colW + 8), y, colW, rowH)));
          img.applyStyle({ borderRadius: 6, borderWidth: 0, clipMode: "hidden" });
          img.handStyle = "pointer";
          img.setImageURL(thumbUrl);
          img.onMouseUp = function (evt) { self._pick({ type: activeTab, value: sendUrl }); evt.stop(); return true; };
          grid.addMorph(img);
          col++;
          if (col >= MEDIA_COLS) { col = 0; y += rowH + 8; }
        });
      },
    },

    "layout", {

      _buildContentArea: function (panel) {
        ensureScrollbarStyle();
        var top = TAB_H + SEARCH_H;

        var emojiGrid = noDrag(new lively.morphic.Box(lively.rect(GRID_PAD, top + CAT_RAIL_H, PANEL_W - GRID_PAD * 2, PANEL_H - top - CAT_RAIL_H - GRID_PAD)));
        emojiGrid.applyStyle({ fill: null, borderWidth: 0, clipMode: "auto" });
        emojiGrid.renderContext().shapeNode.classList.add("media-picker-scroll");
        panel.addMorph(emojiGrid);
        this._emojiGrid = emojiGrid;

        var mediaGrid = noDrag(new lively.morphic.Box(lively.rect(GRID_PAD, top, PANEL_W - GRID_PAD * 2, PANEL_H - top - GRID_PAD)));
        mediaGrid.applyStyle({ fill: null, borderWidth: 0, clipMode: "auto" });
        mediaGrid.renderContext().shapeNode.classList.add("media-picker-scroll");
        panel.addMorph(mediaGrid);
        this._mediaGrid = mediaGrid;

        this._buildCategoryRail(panel, top);
      },

      _pick: function (payload) {
        this.close();
        this._onPick(payload);
      },
    },

    );

  });
