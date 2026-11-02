/**
 * lively.transit.BartData
 *
 * Static reference data for BART (Bay Area Rapid Transit): every current
 * station's code/name/coordinates, and the 6 color-coded lines as ordered
 * station-code sequences. Pulled from BART's own public station/route API
 * (api.bart.gov, using the demo key BART publishes in its own developer
 * docs for public trial use — MW9S-E7SL-26DU-VV8V) on 2026-09-03, not
 * hand-guessed. This is geographic/topological reference data (station
 * codes, lat/lon, which stations each line touches, in order) — it does
 * NOT include live arrival predictions or vehicle positions, which come
 * from the 511.org proxy (TransitClient.js) instead.
 *
 * Pure data module, no DOM/morphic dependencies, so it's safe to reference
 * from anywhere (including addScript/BuildSpec method bodies) via the
 * fully-qualified `lively.transit.BartData.*` path.
 */

module("lively.transit.BartData")
  .requires()
  .toRun(function () {

    lively.transit.BartData = {

      agency: "BA", // 511.org's agency code for BART

      // abbr -> { name, lat, lon, stopId511 }. stopId511 is 511.org's
      // numeric GTFS ParentStation id for the StopMonitoring/VehicleMonitoring
      // "stopcode" param — a completely different id scheme from this BART
      // "abbr" (confirmed live: passing the abbr itself as stopcode returns
      // an always-empty MonitoredStopVisit array, no error, even during
      // service hours — 511.org silently accepts an unrecognized stopcode
      // rather than rejecting it). Pulled from 511.org's own
      // /transit/stops?operator_id=BA endpoint on 2026-09-04, matched to
      // BART's station names by hand (511's display names use different
      // punctuation than BART's own, e.g. "12th Street / Oakland City
      // Center" vs BART's "12th St. Oakland City Center").
      stations: {
        "12TH": { name: "12th St. Oakland City Center", lat: 37.803768, lon: -122.271450, stopId511: "900109" },
        "16TH":  { name: "16th St. Mission",              lat: 37.765062, lon: -122.419694, stopId511: "901509" },
        "19TH":  { name: "19th St. Oakland",               lat: 37.808350, lon: -122.268602, stopId511: "900209" },
        "24TH":  { name: "24th St. Mission",               lat: 37.752470, lon: -122.418143, stopId511: "901609" },
        "ANTC":  { name: "Antioch",                        lat: 37.995388, lon: -121.780420, stopId511: "908309" },
        "ASHB":  { name: "Ashby",                          lat: 37.852803, lon: -122.270062, stopId511: "904109" },
        "BALB":  { name: "Balboa Park",                    lat: 37.721585, lon: -122.447506, stopId511: "901809" },
        "BAYF":  { name: "Bay Fair",                       lat: 37.696924, lon: -122.126514, stopId511: "902509" },
        "BERY":  { name: "Berryessa/North San Jose",       lat: 37.368473, lon: -121.874681, stopId511: "909509" },
        "CAST":  { name: "Castro Valley",                  lat: 37.690746, lon: -122.075602, stopId511: "905109" },
        "CIVC":  { name: "Civic Center/UN Plaza",          lat: 37.779732, lon: -122.414123, stopId511: "901409" },
        "COLS":  { name: "Coliseum",                       lat: 37.753661, lon: -122.196869, stopId511: "902309" },
        "COLM":  { name: "Colma",                          lat: 37.684638, lon: -122.466233, stopId511: "906109" },
        "CONC":  { name: "Concord",                        lat: 37.973737, lon: -122.029095, stopId511: "903609" },
        "DALY":  { name: "Daly City",                      lat: 37.706121, lon: -122.469081, stopId511: "901909" },
        "DBRK":  { name: "Downtown Berkeley",               lat: 37.870104, lon: -122.268133, stopId511: "904209" },
        "DUBL":  { name: "Dublin/Pleasanton",              lat: 37.701687, lon: -121.899179, stopId511: "905309" },
        "DELN":  { name: "El Cerrito del Norte",           lat: 37.925086, lon: -122.316794, stopId511: "904509" },
        "PLZA":  { name: "El Cerrito Plaza",                lat: 37.902632, lon: -122.298904, stopId511: "904409" },
        "EMBR":  { name: "Embarcadero",                    lat: 37.792874, lon: -122.397020, stopId511: "901169" },
        "FRMT":  { name: "Fremont",                        lat: 37.557465, lon: -121.976608, stopId511: "902909" },
        "FTVL":  { name: "Fruitvale",                      lat: 37.774836, lon: -122.224175, stopId511: "902209" },
        "GLEN":  { name: "Glen Park",                      lat: 37.733064, lon: -122.433817, stopId511: "901709" },
        "HAYW":  { name: "Hayward",                        lat: 37.669723, lon: -122.087018, stopId511: "902609" },
        "LAFY":  { name: "Lafayette",                      lat: 37.893176, lon: -122.124630, stopId511: "903309" },
        "LAKE":  { name: "Lake Merritt",                   lat: 37.797027, lon: -122.265180, stopId511: "902109" },
        "MCAR":  { name: "MacArthur",                      lat: 37.829065, lon: -122.267040, stopId511: "900309" },
        "MLBR":  { name: "Millbrae",                       lat: 37.600271, lon: -122.386702, stopId511: "906409" },
        "MLPT":  { name: "Milpitas",                       lat: 37.410277, lon: -121.891081, stopId511: "909409" },
        "MONT":  { name: "Montgomery St.",                 lat: 37.789405, lon: -122.401066, stopId511: "901209" },
        "NBRK":  { name: "North Berkeley",                 lat: 37.873967, lon: -122.283440, stopId511: "904309" },
        "NCON":  { name: "North Concord/Martinez",         lat: 38.003193, lon: -122.024653, stopId511: "903709" },
        "OAKL":  { name: "Oakland International Airport",  lat: 37.713238, lon: -122.212191, stopId511: "907409" },
        "ORIN":  { name: "Orinda",                         lat: 37.878361, lon: -122.183791, stopId511: "903209" },
        "PITT":  { name: "Pittsburg/Bay Point",            lat: 38.018914, lon: -121.945154, stopId511: "903809" },
        "PCTR":  { name: "Pittsburg Center",                lat: 38.016941, lon: -121.889457, stopId511: "908209" },
        "PHIL":  { name: "Pleasant Hill/Contra Costa Centre", lat: 37.928468, lon: -122.056012, stopId511: "903509" },
        "POWL":  { name: "Powell St.",                     lat: 37.784471, lon: -122.407974, stopId511: "901309" },
        "RICH":  { name: "Richmond",                       lat: 37.936853, lon: -122.353099, stopId511: "904609" },
        "ROCK":  { name: "Rockridge",                      lat: 37.844702, lon: -122.251371, stopId511: "903109" },
        "SBRN":  { name: "San Bruno",                      lat: 37.637761, lon: -122.416287, stopId511: "906309" },
        "SFIA":  { name: "San Francisco International Airport", lat: 37.615966, lon: -122.392409, stopId511: "907109" },
        "SANL":  { name: "San Leandro",                    lat: 37.721947, lon: -122.160844, stopId511: "902409" },
        "SHAY":  { name: "South Hayward",                  lat: 37.634375, lon: -122.057189, stopId511: "902709" },
        "SSAN":  { name: "South San Francisco",            lat: 37.664245, lon: -122.443960, stopId511: "906209" },
        "UCTY":  { name: "Union City",                     lat: 37.590630, lon: -122.017388, stopId511: "902809" },
        "WCRK":  { name: "Walnut Creek",                   lat: 37.905522, lon: -122.067527, stopId511: "903409" },
        "WARM":  { name: "Warm Springs/South Fremont",     lat: 37.502171, lon: -121.939313, stopId511: "909209" },
        "WDUB":  { name: "West Dublin/Pleasanton",         lat: 37.699756, lon: -121.928240, stopId511: "905209" },
        "WOAK":  { name: "West Oakland",                   lat: 37.804872, lon: -122.295140, stopId511: "901109" },
      },

      // Ordered station-code sequences, one direction each (the physical
      // track is the same regardless of which end is listed first).
      lines: [
        {
          key: "YELLOW", label: "Yellow Line", color: "#FFC800",
          stations: ["MLBR", "SFIA", "SBRN", "SSAN", "COLM", "DALY", "BALB", "GLEN", "24TH", "16TH",
                     "CIVC", "POWL", "MONT", "EMBR", "WOAK", "12TH", "19TH", "MCAR", "ROCK", "ORIN",
                     "LAFY", "WCRK", "PHIL", "CONC", "NCON", "PITT", "PCTR", "ANTC"],
        },
        {
          key: "ORANGE", label: "Orange Line", color: "#FF9933",
          stations: ["BERY", "MLPT", "WARM", "FRMT", "UCTY", "SHAY", "HAYW", "BAYF", "SANL", "COLS",
                     "FTVL", "LAKE", "12TH", "19TH", "MCAR", "ASHB", "DBRK", "NBRK", "PLZA", "DELN", "RICH"],
        },
        {
          key: "RED", label: "Red Line", color: "#FF0000",
          stations: ["MLBR", "SFIA", "SBRN", "SSAN", "COLM", "DALY", "BALB", "GLEN", "24TH", "16TH",
                     "CIVC", "POWL", "MONT", "EMBR", "WOAK", "12TH", "19TH", "MCAR", "ASHB", "DBRK",
                     "NBRK", "PLZA", "DELN", "RICH"],
        },
        {
          key: "GREEN", label: "Green Line", color: "#339933",
          stations: ["DALY", "BALB", "GLEN", "24TH", "16TH", "CIVC", "POWL", "MONT", "EMBR", "WOAK",
                     "LAKE", "FTVL", "COLS", "SANL", "BAYF", "HAYW", "SHAY", "UCTY", "FRMT", "WARM",
                     "MLPT", "BERY"],
        },
        {
          key: "BLUE", label: "Blue Line", color: "#0099CC",
          stations: ["DALY", "BALB", "GLEN", "24TH", "16TH", "CIVC", "POWL", "MONT", "EMBR", "WOAK",
                     "LAKE", "FTVL", "COLS", "SANL", "BAYF", "CAST", "WDUB", "DUBL"],
        },
        {
          key: "GREY", label: "Oakland Airport Connector", color: "#8C9199",
          stations: ["COLS", "OAKL"],
        },
      ],

      stationName: function (abbr) {
        var s = this.stations[abbr];
        return s ? s.name : abbr;
      },

      // All lines serving a given station code.
      linesAt: function (abbr) {
        return this.lines.filter(function (line) { return line.stations.indexOf(abbr) !== -1; });
      },

      // Every station code, sorted by display name — for search/autocomplete.
      allStationCodes: function () {
        var self = this;
        return Object.keys(this.stations).sort(function (a, b) {
          return self.stations[a].name.localeCompare(self.stations[b].name);
        });
      },

      // Shortest station-hop path between two station codes (BFS over the
      // "same line, adjacent in that line's station list" graph), returned
      // as { lineKey, stations: [abbr,...] }[] — one leg per line used. A
      // same-line adjacency is one hop regardless of the geographic
      // distance between those two stations, which is the right notion of
      // "distance" for a line-based trip planner (fewest transfers first).
      // Returns null if fromAbbr/toAbbr aren't found or are the same code.
      // Minimizes TRANSFERS, not station-hops — modeled as a 0-1 BFS over
      // (station, currentLine) states: riding to an adjacent station on the
      // same line costs 0, switching lines at the same station costs 1.
      // (A plain unweighted BFS over stations alone — the first cut at this
      // — instead minimizes hop count, which is the wrong metric: at every
      // shared-trunk station several lines offer an equally-short next hop,
      // so it would happily hop onto a different line each step and return
      // a route with pointless transfers even when one line covers the
      // whole trip directly. Confirmed live: EMBR->FRMT, both on the Green
      // line, came back as a bogus 3-leg Yellow/Green/Orange route.)
      findRoute: function (fromAbbr, toAbbr) {
        if (!this.stations[fromAbbr] || !this.stations[toAbbr]) return null;
        if (fromAbbr === toAbbr) return null;
        var self = this;

        function keyOf(station, lineKey) { return station + "|" + lineKey; }

        var dist = {};      // stateKey -> transfer count to reach that state
        var prevState = {}; // stateKey -> {station, lineKey} | null
        var deque = [];     // {station, lineKey, cost}

        this.linesAt(fromAbbr).forEach(function (line) {
          var k = keyOf(fromAbbr, line.key);
          dist[k] = 0; // boarding the very first line is free, not a transfer
          prevState[k] = null;
          deque.push({ station: fromAbbr, lineKey: line.key, cost: 0 });
        });

        var goal = null;
        while (deque.length) {
          var cur = deque.shift();
          var curKey = keyOf(cur.station, cur.lineKey);
          if (cur.cost > dist[curKey]) continue; // stale entry, already beaten
          if (cur.station === toAbbr) { goal = cur; break; }

          // Ride: adjacent station, same line, cost +0 — push to the FRONT
          // so it's processed before any pending +1 transfer, which is what
          // makes this a correct 0-1 BFS instead of plain FIFO BFS.
          var line = self.lines.filter(function (l) { return l.key === cur.lineKey; })[0];
          var idx = line.stations.indexOf(cur.station);
          [line.stations[idx - 1], line.stations[idx + 1]].forEach(function (nextStation) {
            if (!nextStation) return;
            var nk = keyOf(nextStation, cur.lineKey);
            if (dist[nk] === undefined || dist[nk] > cur.cost) {
              dist[nk] = cur.cost;
              prevState[nk] = { station: cur.station, lineKey: cur.lineKey };
              deque.unshift({ station: nextStation, lineKey: cur.lineKey, cost: cur.cost });
            }
          });

          // Transfer: same station, different line, cost +1 — push to the back.
          self.linesAt(cur.station).forEach(function (otherLine) {
            if (otherLine.key === cur.lineKey) return;
            var nk = keyOf(cur.station, otherLine.key);
            if (dist[nk] === undefined || dist[nk] > cur.cost + 1) {
              dist[nk] = cur.cost + 1;
              prevState[nk] = { station: cur.station, lineKey: cur.lineKey };
              deque.push({ station: cur.station, lineKey: otherLine.key, cost: cur.cost + 1 });
            }
          });
        }
        if (!goal) return null; // shouldn't happen — BART's graph is connected

        var chain = [];
        var state = { station: goal.station, lineKey: goal.lineKey };
        while (state) {
          chain.push(state);
          state = prevState[keyOf(state.station, state.lineKey)];
        }
        chain.reverse();

        var legs = [];
        chain.forEach(function (s) {
          var lastLeg = legs[legs.length - 1];
          if (!lastLeg || lastLeg.lineKey !== s.lineKey) legs.push({ lineKey: s.lineKey, stations: [s.station] });
          else lastLeg.stations.push(s.station);
        });
        return legs;
      },

    };

  }); // end module('lively.transit.BartData')
