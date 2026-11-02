/**
 * lively.identity.BadgeCatalog
 *
 * Small pure helpers for the homestar badges (badges.md): colour parsing and the
 * WCAG contrast rule, plus the data behind the add-badge picker: transit agencies with
 * their lines, a few teams, and two schools.
 *
 * Every colour in the data is an organisation's own published value, read from its own
 * feed, logo file or brand page (each entry's `src` says which kind; the exact documents
 * and quotes are in badges.md, section 12). Entries without such a source are left out
 * on purpose: the picker's "type your own" path covers them, and the server accepts any
 * colour pair that reaches 4.5:1. `color` is the organisation's fill kept as published;
 * `textColor` is the published text colour when it reaches 4.5:1 on it, else the first of
 * white, the page ink, black that does (tests/server/badge-catalog.test.js checks every
 * pair and that the server accepts every entry).
 *
 * Plain functions on a namespace object, not BuildSpec / addScript members, so callers
 * may alias them. The contrast maths is the same as core/servers/identity/Badges.js
 * (contrastRatio), which is what the server enforces on every stored badge; keep the two
 * in step (tests/server/badges.test.js covers the server's side).
 */

module("lively.identity.BadgeCatalog")
  .requires()
  .toRun(function () {

    // The colour a text on a light-or-dark badge falls back to when it is not white.
    var INK_HEX = "#241F2C";
    var MIN_CONTRAST = 4.5;
    var HEX_RE = /^#[0-9A-Fa-f]{6}$/;

    // WCAG relative luminance of '#RRGGBB'.
    function luminance(hex) {
      var n = parseInt(hex.slice(1), 16);
      var ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (v) {
        var c = v / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    }

    // ── data ────────────────────────────────────────────────────────────────

    // A transit agency: `label` is what the tag's first segment says; `color`/`textColor`
    // (or null) is the agency-only tag, offered only when the agency publishes one colour
    // of its own; `lines` are `{ label, color, textColor }`, each stored on a badge as
    // `agency` + `label`.
    var AGENCIES = [
      { key: "bart", label: "BART", color: null, textColor: null, src: "agency-api", lines: [
        { label: "Orange Line", color: "#FF9933", textColor: "#241F2C" },
        { label: "Yellow Line", color: "#FFFF33", textColor: "#241F2C" },
        { label: "Green Line", color: "#339933", textColor: "#000000" },
        { label: "Blue Line", color: "#0099CC", textColor: "#241F2C" },
        { label: "Red Line", color: "#FF0000", textColor: "#000000" },
        { label: "OAK Connector", color: "#B0BEC7", textColor: "#241F2C" }
      ] },
      { key: "caltrain", label: "Caltrain", color: "#CE202F", textColor: "#FFFFFF", src: "agency-feed", lines: [
        { label: "Local", color: "#DCDDDE", textColor: "#000000" },
        { label: "Limited", color: "#99D7DC", textColor: "#000000" },
        { label: "Express", color: "#CE202F", textColor: "#FFFFFF" },
        { label: "South County", color: "#FAE4A7", textColor: "#000000" }
      ] },
      { key: "vta", label: "VTA", color: "#29588C", textColor: "#FFFFFF", src: "agency-feed", lines: [
        { label: "Blue Line", color: "#007ACC", textColor: "#000000" },
        { label: "Green Line", color: "#379400", textColor: "#000000" },
        { label: "Orange Line", color: "#CC6600", textColor: "#000000" }
      ] }
    ];

    // Teams a user can pick: `name` is shown on the badge, `full` is searched too, `abbr`
    // (1 to 3 letters or digits) is the crest, `league` filters the picker. Anyone else's
    // team goes through "use my own team name".
    var TEAMS = [
      { league: "NBA", name: "Warriors", full: "Golden State Warriors", abbr: "GSW", color: "#1D428A", textColor: "#FDB927", src: "league-logo" },
      { league: "WNBA", name: "Valkyries", full: "Golden State Valkyries", abbr: "GSV", color: "#B896D4", textColor: "#000000", src: "league-logo" },
      { league: "NFL", name: "49ers", full: "San Francisco 49ers", abbr: "SF", color: "#AA0000", textColor: "#FFFFFF", src: "league-logo" },
      { league: "NHL", name: "Sharks", full: "San Jose Sharks", abbr: "SJS", color: "#00778B", textColor: "#FFFFFF", src: "league-logo" },
      { league: "MLS", name: "Earthquakes", full: "San Jose Earthquakes", abbr: "SJ", color: "#003DA6", textColor: "#FFFFFF", src: "league-logo" },
      { league: "NWSL", name: "Bay FC", full: "Bay FC", abbr: "BAY", color: "#0A2032", textColor: "#FFFFFF", src: "club-logo" },
      { league: "Premier League", name: "Man City", full: "Manchester City", abbr: "MCI", color: "#98C5E9", textColor: "#001838", src: "club-site" }
    ];

    var SCHOOLS = [
      { name: "UC Berkeley", color: "#002676", textColor: "#FDB515", src: "brand-site" },
      { name: "Laney College", color: "#046A38", textColor: "#FFFFFF", src: "brand-site" }
    ];

    lively.identity.BadgeCatalog = {
      INK_HEX: INK_HEX,
      MIN_CONTRAST: MIN_CONTRAST,
      AGENCIES: AGENCIES,
      TEAMS: TEAMS,
      SCHOOLS: SCHOOLS,

      isHex: function (s) { return typeof s === "string" && HEX_RE.test(s); },

      // A Lively Color from '#RRGGBB'. Use it for every colour a badge carries (they
      // arrive from the server as hex strings). `fallback` (a Color) is returned for
      // anything that is not a valid hex, so a damaged badge draws grey instead of
      // throwing in the middle of a page render.
      rgb: function (hex, fallback) {
        if (!lively.identity.BadgeCatalog.isHex(hex)) return fallback || Color.rgb(0x77, 0x77, 0x77);
        var n = parseInt(hex.slice(1), 16);
        return Color.rgb((n >> 16) & 255, (n >> 8) & 255, n & 255);
      },

      // WCAG contrast ratio (1 to 21) between two '#RRGGBB' colours.
      contrast: function (hexA, hexB) {
        var a = luminance(hexA), b = luminance(hexB);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      },

      // The text colour to put on `fill`: white when that reaches the contrast rule, else
      // the page ink, else black. Black is last because some saturated mid-tones (a pure
      // red, a mid green) fail with white AND with the ink but pass with black; between
      // white and black some pair always reaches 4.5:1, so null only means `fill` is not
      // a #RRGGBB colour.
      textColorFor: function (fill) {
        var C = lively.identity.BadgeCatalog;
        if (!C.isHex(fill)) return null;
        var options = ["#FFFFFF", INK_HEX, "#000000"];
        for (var i = 0; i < options.length; i++) if (C.contrast(fill, options[i]) >= MIN_CONTRAST) return options[i];
        return null;
      },
    };

  });
