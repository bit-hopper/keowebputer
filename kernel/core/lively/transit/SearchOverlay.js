/**
 * lively.transit.SearchOverlay
 *
 * A floating search widget for the transit map: a circular search-icon
 * button that expands into a text input + live-filtered station results
 * list. Selecting a result centers the map on that station and opens its
 * arrivals popup (via the map morph's own showStationPopup).
 *
 * Built as plain imperative morphic construction (Object/Image/Text/Box,
 * closures over local vars) rather than lively.BuildSpec/addScript — no
 * BuildSpec-closure-loss risk here since nothing is reconstructed from
 * source text (see TransitMapMorph.js's header for the same rationale).
 * Matches the user's stated preference for hand-composed morphic UI over
 * native DOM wherever the content doesn't require real DOM.
 */

module("lively.transit.SearchOverlay")
  .requires("lively.transit.BartData")
  .toRun(function () {

    var COLLAPSED = 44;
    var EXPANDED_W = 260;
    var MAX_RESULTS = 6;
    var ROW_H = 28;

    function noDrag(m) {
      m.draggingEnabled = false;
      m.droppingEnabled = false;
      m.grabbingEnabled = false;
    }

    function iconGlyph(rect, glyph, fontSize) {
      var t = new lively.morphic.Text(rect);
      t.textString = glyph;
      t.applyStyle({
        fontFamily: "'Material Symbols Rounded'",
        fontSize: fontSize || 15,
        textColor: Color.rgb(60, 64, 67),
        fill: null, borderWidth: 0, align: "center",
        allowInput: false, selectable: false, clipMode: "hidden",
        whiteSpaceHandling: "pre",
      });
      noDrag(t);
      return t;
    }

    lively.transit.SearchOverlay = {

      // mapMorph: the lively.transit.TransitMapMorph to drive.
      create: function (mapMorph, pos) {
        var self = { expanded: false };
        var box = new lively.morphic.Box(lively.rect(pos.x, pos.y, COLLAPSED, COLLAPSED));
        box.applyStyle({
          fill: Color.white, borderRadius: COLLAPSED / 2, borderWidth: 0,
          clipMode: "hidden",
        });
        noDrag(box);
        box.eventsAreIgnored = false;

        var icon = iconGlyph(lively.rect(0, 0, COLLAPSED, COLLAPSED), "search", 15);
        icon.setPosition(lively.pt(0, 0));
        icon.setExtent(lively.pt(COLLAPSED, COLLAPSED));
        box.addMorph(icon);
        self.icon = icon;

        var input = new lively.morphic.Text(lively.rect(44, 8, EXPANDED_W - 44 - 12, 28));
        input.applyStyle({
          fontSize: 11, fill: Color.rgb(245, 245, 247), borderWidth: 0, borderRadius: 6,
          padding: lively.rect(8, 6, 0, 0), textColor: Color.rgb(30, 30, 30),
          whiteSpaceHandling: "pre",
        });
        input.textString = "";
        input.beInputLine();
        input.setVisible(false);
        box.addMorph(input);
        self.input = input;

        var resultsList = new lively.morphic.Box(lively.rect(0, COLLAPSED, EXPANDED_W, 0));
        resultsList.applyStyle({ fill: null, borderWidth: 0, clipMode: "hidden" });
        resultsList.setVisible(false);
        box.addMorph(resultsList);
        self.resultsList = resultsList;

        function collapse() {
          self.expanded = false;
          box.setExtent(lively.pt(COLLAPSED, COLLAPSED));
          input.setVisible(false);
          resultsList.setVisible(false);
          resultsList.removeAllMorphs();
        }

        function expand() {
          self.expanded = true;
          box.setExtent(lively.pt(EXPANDED_W, COLLAPSED));
          input.setVisible(true);
          input.textString = "";
          input.focus && input.focus();
          renderResults("");
        }

        function renderResults(query) {
          resultsList.removeAllMorphs();
          var q = (query || "").trim().toLowerCase();
          var codes = lively.transit.BartData.allStationCodes();
          var matches = (q ? codes.filter(function (abbr) {
            return lively.transit.BartData.stationName(abbr).toLowerCase().indexOf(q) !== -1;
          }) : codes).slice(0, MAX_RESULTS);

          if (!matches.length) {
            resultsList.setExtent(lively.pt(EXPANDED_W, 0));
            box.setExtent(lively.pt(EXPANDED_W, COLLAPSED));
            resultsList.setVisible(false);
            return;
          }

          matches.forEach(function (abbr, i) {
            var row = new lively.morphic.Text(lively.rect(0, i * ROW_H, EXPANDED_W, ROW_H));
            row.textString = lively.transit.BartData.stationName(abbr);
            row.applyStyle({
              fontSize: 10.5, fill: Color.white, textColor: Color.rgb(40, 40, 40),
              borderWidth: 0, allowInput: false, selectable: false, clipMode: "hidden",
              padding: lively.rect(10, 6, 0, 0), whiteSpaceHandling: "pre", handStyle: "pointer",
            });
            noDrag(row);
            row.onMouseOver = function () { row.applyStyle({ fill: Color.rgb(238, 240, 242) }); };
            row.onMouseOut = function () { row.applyStyle({ fill: Color.white }); };
            row.onMouseUp = function (evt) {
              mapMorph.showStationPopup(abbr);
              collapse();
              evt.stop();
              return true;
            };
            resultsList.addMorph(row);
          });
          var h = matches.length * ROW_H;
          resultsList.setExtent(lively.pt(EXPANDED_W, h));
          resultsList.setVisible(true);
          box.setExtent(lively.pt(EXPANDED_W, COLLAPSED + h));
        }

        icon.onMouseUp = function (evt) {
          if (self.expanded) collapse(); else expand();
          evt.stop();
          return true;
        };

        // Wrap (not replace) the Text morph's own onKeyUp — it's what
        // TextCore.js uses to refresh internal state/fit after every
        // keystroke, so calling it first keeps normal typing/caret behavior
        // intact; renderResults() then runs off the freshly-updated value.
        var origOnKeyUp = input.onKeyUp.bind(input);
        input.onKeyUp = function (evt) {
          var result = origOnKeyUp(evt);
          renderResults(input.textString);
          return result;
        };

        box._collapseSearch = collapse;
        return box;
      },
    };

  }); // end module('lively.transit.SearchOverlay')
