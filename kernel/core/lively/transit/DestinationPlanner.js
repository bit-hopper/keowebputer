/**
 * lively.transit.DestinationPlanner
 *
 * A collapsible "plan a trip" drawer: pick a From and To BART station,
 * get the line(s) to take (lively.transit.BartData.findRoute — fewest
 * transfers over the shared-track line graph, not a geographic
 * shortest-path) and the next departure time for the first leg. Selecting
 * a route also highlights it on the map via mapMorph.highlightRoute().
 */

module("lively.transit.DestinationPlanner")
  .requires("lively.transit.BartData", "lively.transit.TransitClient")
  .toRun(function () {

    var COLLAPSED = 44;
    var PANEL_W = 300;
    var MAX_RESULTS = 5;
    var ROW_H = 26;

    function noDrag(m) {
      m.draggingEnabled = false;
      m.droppingEnabled = false;
      m.grabbingEnabled = false;
    }

    function iconGlyph(rect, glyph, fontSize, color) {
      var t = new lively.morphic.Text(rect);
      t.textString = glyph;
      t.applyStyle({
        fontFamily: "'Material Symbols Rounded'", fontSize: fontSize || 15,
        textColor: color || Color.rgb(60, 64, 67), fill: null, borderWidth: 0, align: "center",
        allowInput: false, selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre",
      });
      noDrag(t);
      return t;
    }

    // A labeled station-search field: a text input that shows a small
    // filtered dropdown of matching stations while typing, and remembers
    // the last-selected station code. `onSelect(abbr)` fires on pick.
    function makeStationField(owner, y, placeholder, onSelect) {
      var state = { abbr: null };
      var fieldW = PANEL_W - 24;

      var input = new lively.morphic.Text(lively.rect(12, y, fieldW, 26));
      input.applyStyle({
        fontSize: 11, fill: Color.rgb(245, 245, 247), borderWidth: 0, borderRadius: 6,
        padding: lively.rect(8, 6, 0, 0), textColor: Color.rgb(30, 30, 30), whiteSpaceHandling: "pre",
      });
      input.textString = placeholder || "";
      input.beInputLine();
      owner.addMorph(input);

      var dropdown = new lively.morphic.Box(lively.rect(12, y + 28, fieldW, 0));
      dropdown.applyStyle({ fill: Color.white, borderWidth: 1, borderColor: Color.rgb(225, 225, 225), clipMode: "hidden" });
      dropdown.setVisible(false);
      owner.addMorph(dropdown);

      function renderMatches(query) {
        dropdown.removeAllMorphs();
        // Re-adding an already-owned morph moves it to the end of its
        // owner's submorph list (top of paint order) — needed here because
        // the "To" field's own input box sits at a y that overlaps the
        // "From" field's dropdown area, and whichever was added most
        // recently would otherwise paint over the other's open dropdown
        // (confirmed live: typing in "From" showed a matching row in the
        // morph tree with correct position/extent, but nothing was visible
        // on screen because the sibling "To" input painted on top of it).
        owner.addMorph(dropdown);
        var q = (query || "").trim().toLowerCase();
        if (!q) { dropdown.setVisible(false); dropdown.setExtent(lively.pt(fieldW, 0)); return; }
        var matches = lively.transit.BartData.allStationCodes().filter(function (abbr) {
          return lively.transit.BartData.stationName(abbr).toLowerCase().indexOf(q) !== -1;
        }).slice(0, MAX_RESULTS);
        if (!matches.length) { dropdown.setVisible(false); dropdown.setExtent(lively.pt(fieldW, 0)); return; }
        matches.forEach(function (abbr, i) {
          var row = new lively.morphic.Text(lively.rect(0, i * ROW_H, fieldW, ROW_H));
          row.textString = lively.transit.BartData.stationName(abbr);
          row.applyStyle({
            fontSize: 10, fill: Color.white, textColor: Color.rgb(40, 40, 40), borderWidth: 0,
            allowInput: false, selectable: false, clipMode: "hidden", padding: lively.rect(8, 5, 0, 0),
            whiteSpaceHandling: "pre", handStyle: "pointer",
          });
          noDrag(row);
          row.onMouseOver = function () { row.applyStyle({ fill: Color.rgb(238, 240, 242) }); };
          row.onMouseOut = function () { row.applyStyle({ fill: Color.white }); };
          row.onMouseUp = function (evt) {
            state.abbr = abbr;
            input.textString = lively.transit.BartData.stationName(abbr);
            dropdown.setVisible(false);
            dropdown.removeAllMorphs();
            if (onSelect) onSelect(abbr);
            evt.stop();
            return true;
          };
          dropdown.addMorph(row);
        });
        dropdown.setExtent(lively.pt(fieldW, matches.length * ROW_H));
        dropdown.setVisible(true);
      }

      var origOnKeyUp = input.onKeyUp.bind(input);
      input.onKeyUp = function (evt) {
        var result = origOnKeyUp(evt);
        state.abbr = null; // typing invalidates any prior selection
        renderMatches(input.textString);
        return result;
      };

      return { input: input, dropdown: dropdown, getAbbr: function () { return state.abbr; } };
    }

    lively.transit.DestinationPlanner = {

      create: function (mapMorph, pos) {
        var self = { expanded: false };
        var box = new lively.morphic.Box(lively.rect(pos.x, pos.y - COLLAPSED, COLLAPSED, COLLAPSED));
        box.applyStyle({ fill: Color.white, borderRadius: COLLAPSED / 2, borderWidth: 0, clipMode: "visible" });
        noDrag(box);

        var toggleIcon = iconGlyph(lively.rect(0, 0, COLLAPSED, COLLAPSED), "alt_route", 16);
        box.addMorph(toggleIcon);

        var panel = new lively.morphic.Box(lively.rect(0, 0, PANEL_W, 0));
        panel.applyStyle({ fill: Color.white, borderRadius: 10, borderWidth: 0, clipMode: "hidden" });
        panel.setVisible(false);
        box.addMorph(panel);

        var fromField = makeStationField(panel, 10, "From station…", null);
        var toField = makeStationField(panel, 46, "To station…", null);

        var goBtn = new lively.morphic.Text(lively.rect(12, 82, PANEL_W - 24, 30));
        goBtn.textString = "Plan trip";
        goBtn.applyStyle({
          fontSize: 11, fontWeight: "700", textColor: Color.white, fill: Color.rgb(25, 103, 210),
          borderRadius: 6, borderWidth: 0, align: "center", allowInput: false, selectable: false,
          clipMode: "hidden", handStyle: "pointer", whiteSpaceHandling: "pre",
          padding: lively.rect(0, 8, 0, 0),
        });
        noDrag(goBtn);
        panel.addMorph(goBtn);

        var resultText = new lively.morphic.Text(lively.rect(12, 122, PANEL_W - 24, 120));
        resultText.applyStyle({
          fontSize: 10.5, textColor: Color.rgb(50, 50, 50), fill: null, borderWidth: 0,
          allowInput: false, selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre-wrap",
        });
        resultText.textString = "";
        panel.addMorph(resultText);

        function setPanelHeight(h) {
          panel.setExtent(lively.pt(PANEL_W, h));
          box.setExtent(lively.pt(PANEL_W, COLLAPSED + h));
          box.setPosition(lively.pt(pos.x, pos.y - COLLAPSED - h));
        }

        function collapse() {
          self.expanded = false;
          panel.setVisible(false);
          setPanelHeight(0);
          box.setPosition(lively.pt(pos.x, pos.y - COLLAPSED));
          box.setExtent(lively.pt(COLLAPSED, COLLAPSED));
          mapMorph.highlightRoute(null);
        }

        function expand() {
          self.expanded = true;
          panel.setVisible(true);
          resultText.textString = "";
          setPanelHeight(160);
        }

        toggleIcon.onMouseUp = function (evt) {
          if (self.expanded) collapse(); else expand();
          evt.stop();
          return true;
        };

        // Strips punctuation/spacing so 511.org's destination text ("Berryessa /
    // North San Jose") can be compared against this repo's own station name
    // ("Berryessa/North San Jose") despite differing formatting.
    function normalizeStationName(s) {
      return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    }

    // A line runs in two directions; `leg` only tells us the line and the
    // next station in the direction we actually want (confirmed live: a
    // naive lineKey-only match picked a real Green Line train, correctly on
    // the right line, but headed the opposite way — toward Daly City
    // instead of toward Fremont). Compares leg.stations[0]->[1] against the
    // line's own full station order to find which of the line's two real
    // termini we're headed toward, then matches predictions whose
    // `destination` names that terminus.
    function directionTerminusName(leg) {
      var line = lively.transit.BartData.lines.filter(function (l) { return l.key === leg.lineKey; })[0];
      if (!line || leg.stations.length < 2) return null;
      var i0 = line.stations.indexOf(leg.stations[0]);
      var i1 = line.stations.indexOf(leg.stations[1]);
      if (i0 === -1 || i1 === -1) return null;
      var terminusAbbr = i1 > i0 ? line.stations[line.stations.length - 1] : line.stations[0];
      return lively.transit.BartData.stationName(terminusAbbr);
    }

    function describeLine(lineKey) {
          var line = lively.transit.BartData.lines.filter(function (l) { return l.key === lineKey; })[0];
          return line ? line.label : lineKey;
        }

        goBtn.onMouseUp = function (evt) {
          var fromAbbr = fromField.getAbbr(), toAbbr = toField.getAbbr();
          if (!fromAbbr || !toAbbr) {
            resultText.textString = "Pick a station from the dropdown for both From and To.";
          } else if (fromAbbr === toAbbr) {
            resultText.textString = "From and To are the same station.";
          } else {
            var legs = lively.transit.BartData.findRoute(fromAbbr, toAbbr);
            if (!legs) {
              resultText.textString = "No route found.";
            } else {
              mapMorph.highlightRoute(legs);
              var summary = legs.map(function (leg) {
                return describeLine(leg.lineKey) + ": " +
                  lively.transit.BartData.stationName(leg.stations[0]) + " → " +
                  lively.transit.BartData.stationName(leg.stations[leg.stations.length - 1]);
              }).join("\n");
              resultText.textString = summary + "\n\nLooking up next departure…";
              lively.transit.TransitClient.stopMonitoring(fromAbbr, function (err, result) {
                var firstLineKey = legs[0].lineKey;
                var wantTerminus = normalizeStationName(directionTerminusName(legs[0]));
                var predictions = result.predictions || [];
                var pred = predictions.filter(function (p) {
                  return p.lineKey === firstLineKey &&
                    (!wantTerminus || normalizeStationName(p.destination) === wantTerminus);
                })[0] || predictions.filter(function (p) { return p.lineKey === firstLineKey; })[0];
                var departureLine = pred
                  ? "\n\nNext departure: " + pred.minutesAway + " min" + (result.simulated ? " (simulated)" : "")
                  : "\n\nNo upcoming departure info.";
                resultText.textString = summary + departureLine;
              });
            }
          }
          evt.stop();
          return true;
        };

        return box;
      },
    };

  }); // end module('lively.transit.DestinationPlanner')
