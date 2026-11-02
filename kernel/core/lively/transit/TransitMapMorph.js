/**
 * lively.transit.TransitMapMorph
 *
 * The map itself: a native self-rendering lively.morphic.Box (same
 * architecture as lively.media.RetroMediaConsole — real hand-built DOM
 * inside the morph's own shapeNode, not a BuildSpec submorph tree, not an
 * iframe) that mounts a real Leaflet+OSM map via the already-vendored
 * core/lib/geo/geo-runtime.js runtime (see lively.identity.LocalMap for the
 * precedent this follows for lazy-loading that runtime and for the
 * z-index/stacking-context fix Leaflet's internal panes need when mounted
 * inside Lively's own DOM tree).
 *
 * Draws all 6 BART lines (lively.transit.BartData) as colored polylines,
 * one station marker per station, and live-updating vehicle markers via
 * lively.transit.TransitClient. Clicking a station opens a Leaflet popup
 * with upcoming arrivals for every line serving it.
 *
 * Public API used by the overlay morphs (SearchOverlay, DestinationPlanner):
 *   - centerOnStation(abbr)
 *   - showStationPopup(abbr)
 *   - highlightRoute(legs | null)   // legs from BartData.findRoute(), or null to clear
 */

module("lively.transit.TransitMapMorph")
  .requires("lively.transit.BartData", "lively.transit.TransitClient")
  .toRun(function () {

    var SF_BAY_CENTER = [37.77, -122.25];
    var DEFAULT_ZOOM = 10;
    var SEGMENT_OFFSET_M = 110; // meters between parallel same-track line renders

    // ─── small local-flat-earth helpers for the parallel-line-offset math ─────

    function metersPerDeg(refLatDeg) {
      var refLat = refLatDeg * Math.PI / 180;
      return { lat: 111320, lon: 111320 * Math.cos(refLat) };
    }

    // Offsets a station-pair segment perpendicular to its own direction by
    // `index - (count-1)/2` line-widths, so lines sharing physical BART
    // track render as visually distinct parallel colored lines instead of
    // one overlapping blob.
    function offsetSegment(p1, p2, index, count) {
      if (count <= 1) return [p1, p2];
      var refLat = (p1[0] + p2[0]) / 2;
      var mpd = metersPerDeg(refLat);
      var dxM = (p2[1] - p1[1]) * mpd.lon;
      var dyM = (p2[0] - p1[0]) * mpd.lat;
      var len = Math.sqrt(dxM * dxM + dyM * dyM) || 1;
      var perpXm = -dyM / len, perpYm = dxM / len;
      var offsetM = (index - (count - 1) / 2) * SEGMENT_OFFSET_M;
      var dLat = (perpYm * offsetM) / mpd.lat;
      var dLon = (perpXm * offsetM) / mpd.lon;
      return [
        [p1[0] + dLat, p1[1] + dLon],
        [p2[0] + dLat, p2[1] + dLon],
      ];
    }

    function segKey(a, b) { return a < b ? a + "|" + b : b + "|" + a; }

    // segmentKey -> [{lineKey}] for every line that shares that adjacent pair.
    function buildSegmentOwners() {
      var owners = {};
      lively.transit.BartData.lines.forEach(function (line) {
        for (var i = 0; i < line.stations.length - 1; i++) {
          var key = segKey(line.stations[i], line.stations[i + 1]);
          (owners[key] = owners[key] || []).push(line.key);
        }
      });
      Object.keys(owners).forEach(function (key) { owners[key].sort(); });
      return owners;
    }

    var TransitMapMorphClass = lively.morphic.Box.subclass(
      "lively.transit.TransitMapMorph",

      "initialization",
      {
        initialize: function ($super, optExtent) {
          $super(optExtent || lively.rect(0, 0, 960, 640));
          this.setFill(null);
          this.setBorderWidth(0);
          // All three flags needed together, per this repo's own drag/grab
          // gotcha (setting only draggingEnabled/droppingEnabled leaves
          // isGrabbable() defaulting true, so the morph is still pick-up-
          // and-moveable) — this map is meant to pan via Leaflet's own
          // internal drag handling, not get dragged around as a morph.
          this.draggingEnabled = false;
          this.droppingEnabled = false;
          this.grabbingEnabled = false;
        },

        prepareForNewRenderContext: function ($super, renderCtx) {
          $super(renderCtx);
          this._setup();
        },

        _setup: function () {
          this._map = null;
          this._stationMarkers = {};
          this._vehicleMarkers = {};
          this._routeLayer = null;
          this._openPopupStation = null;
          this._popupRefreshTimer = null;
          this._vehiclePollTimer = null;
          this._destroyed = false;
          this._buildChrome();
          this._ensureGeoRuntime(this._initMap.bind(this));
        },

        remove: function ($super) {
          this._destroyed = true;
          if (this._popupRefreshTimer) clearTimeout(this._popupRefreshTimer);
          if (this._vehiclePollTimer) clearTimeout(this._vehiclePollTimer);
          if (this._map) { this._map.remove(); this._map = null; }
          $super();
        },
      },

      "chrome",
      {
        _buildChrome: function () {
          var shapeNode = this.renderContext().shapeNode;
          shapeNode.innerHTML = "";
          // isolation:isolate + explicit z-index:0 traps Leaflet's own
          // internal pane z-indices (200-700) inside this morph so they can
          // never out-rank a dialog/window elsewhere in the world — see
          // lively.identity.LocalMap's doc comment and the Retro Media
          // Console flex-stacking-context gotcha (both independently
          // confirmed live) for why position:relative alone isn't enough.
          shapeNode.style.cssText = "position:relative;isolation:isolate;z-index:0;overflow:hidden;background:#eef0f2;";

          var mapEl = document.createElement("div");
          mapEl.style.cssText = "position:absolute;inset:0;";
          // Let Leaflet handle its own pan/zoom drag — without this, a
          // mousedown inside the map starts Lively's own morph-drag instead
          // (same fix as RetroMediaConsole's _stopNativeDrag for its
          // transport controls).
          mapEl.addEventListener("mousedown", function (e) { e.stopPropagation(); });
          shapeNode.appendChild(mapEl);
          this._mapEl = mapEl;

          var statusEl = document.createElement("div");
          statusEl.style.cssText = "position:absolute;left:8px;bottom:6px;z-index:5;font:11px/1.3 system-ui,sans-serif;" +
            "color:#666;background:rgba(255,255,255,0.85);padding:2px 8px;border-radius:10px;pointer-events:none;";
          statusEl.textContent = "Loading map…";
          shapeNode.appendChild(statusEl);
          this._statusEl = statusEl;
        },

        _ensureGeoRuntime: function (callback) {
          if (window.L && window.OpenLocationCode) return callback();
          var self = this;
          if (window._geoRuntimeLoading) {
            var poll = setInterval(function () {
              if (self._destroyed) { clearInterval(poll); return; }
              if (window.L) { clearInterval(poll); callback(); }
            }, 80);
            return;
          }
          window._geoRuntimeLoading = true;
          if (!document.getElementById("leaflet-css")) {
            var link = document.createElement("link");
            link.id = "leaflet-css";
            link.rel = "stylesheet";
            link.href = "/core/lib/geo/leaflet.css";
            document.head.appendChild(link);
          }
          var s = document.createElement("script");
          s.src = "/core/lib/geo/geo-runtime.js";
          s.onload = function () { window._geoRuntimeLoading = false; if (!self._destroyed) callback(); };
          s.onerror = function () {
            window._geoRuntimeLoading = false;
            if (!self._destroyed) self._statusEl.textContent = "Failed to load map — try reloading.";
          };
          document.head.appendChild(s);
        },
      },

      "map",
      {
        _initMap: function () {
          if (this._destroyed || this._map) return;
          this._map = window.L.map(this._mapEl, { zoomControl: true }).setView(SF_BAY_CENTER, DEFAULT_ZOOM);
          window.L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
          }).addTo(this._map);
          this._statusEl.textContent = "";
          this._drawLines();
          this._drawStations();
          this._startVehiclePolling();
        },

        _drawLines: function () {
          var self = this;
          var owners = buildSegmentOwners();
          lively.transit.BartData.lines.forEach(function (line) {
            for (var i = 0; i < line.stations.length - 1; i++) {
              var aAbbr = line.stations[i], bAbbr = line.stations[i + 1];
              var a = lively.transit.BartData.stations[aAbbr];
              var b = lively.transit.BartData.stations[bAbbr];
              if (!a || !b) continue;
              var coOwners = owners[segKey(aAbbr, bAbbr)];
              var idx = coOwners.indexOf(line.key);
              var pts = offsetSegment([a.lat, a.lon], [b.lat, b.lon], idx, coOwners.length);
              var poly = window.L.polyline(pts, { color: line.color, weight: 4, opacity: 0.88 }).addTo(self._map);
              poly.bindTooltip(line.label, { sticky: true });
            }
          });
        },

        _drawStations: function () {
          var self = this;
          Object.keys(lively.transit.BartData.stations).forEach(function (abbr) {
            var s = lively.transit.BartData.stations[abbr];
            var icon = window.L.divIcon({
              className: "transit-station-marker",
              html: '<div style="width:12px;height:12px;border-radius:50%;background:#fff;' +
                'border:3px solid #333;box-shadow:0 1px 3px rgba(0,0,0,0.4);"></div>',
              iconSize: [12, 12],
              iconAnchor: [6, 6],
            });
            var marker = window.L.marker([s.lat, s.lon], { icon: icon, title: s.name }).addTo(self._map);
            marker.on("click", function () { self.showStationPopup(abbr); });
            self._stationMarkers[abbr] = marker;
          });
        },

        centerOnStation: function (abbr) {
          var s = lively.transit.BartData.stations[abbr];
          if (!s || !this._map) return;
          this._map.setView([s.lat, s.lon], 14, { animate: true });
        },

        showStationPopup: function (abbr) {
          var marker = this._stationMarkers[abbr];
          if (!marker || !this._map) return;
          this._openPopupStation = abbr;
          this.centerOnStation(abbr);
          this._renderStationPopup(abbr, marker, /*first=*/ true);
          marker.on("popupclose", (function (self) {
            return function () {
              if (self._openPopupStation === abbr) self._openPopupStation = null;
              if (self._popupRefreshTimer) { clearTimeout(self._popupRefreshTimer); self._popupRefreshTimer = null; }
            };
          })(this));
        },

        _renderStationPopup: function (abbr, marker, first) {
          var self = this;
          if (this._destroyed || this._openPopupStation !== abbr) return;
          lively.transit.TransitClient.stopMonitoring(abbr, function (err, result) {
            if (self._destroyed || self._openPopupStation !== abbr) return;
            var stationName = lively.transit.BartData.stationName(abbr);
            var rows = (result.predictions || []).map(function (p) {
              return '<div style="display:flex;align-items:center;gap:6px;margin:3px 0;">' +
                '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' +
                (self._colorForLineKey(p.lineKey) || "#999") + ';"></span>' +
                '<span style="font-weight:600;">' + self._escapeHtml(self._labelForLineKey(p.lineKey) || p.line) + '</span>' +
                '<span style="color:#555;">→ ' + self._escapeHtml(p.destination) + '</span>' +
                '<span style="margin-left:auto;font-weight:600;">' +
                (p.minutesAway == null ? "?" : p.minutesAway) + ' min</span>' +
                '</div>';
            }).join("") || '<div style="color:#888;">No upcoming arrivals found.</div>';
            var badge = result.simulated
              ? '<div style="font-size:10px;color:#a15c00;background:#fff3e0;display:inline-block;' +
                'padding:1px 6px;border-radius:8px;margin-top:6px;">simulated — add a 511.org API key for live data</div>'
              : '';
            var html = '<div style="font:13px/1.4 system-ui,sans-serif;min-width:200px;">' +
              '<div style="font-weight:700;margin-bottom:4px;">' + self._escapeHtml(stationName) + '</div>' +
              rows + badge + '</div>';
            if (first) {
              marker.bindPopup(html, { closeButton: true }).openPopup();
            } else if (marker.getPopup()) {
              marker.setPopupContent(html);
            }
            self._popupRefreshTimer = setTimeout(function () { self._renderStationPopup(abbr, marker, false); }, 15000);
          });
        },

        _colorForLineKey: function (lineKey) {
          var line = lively.transit.BartData.lines.filter(function (l) { return l.key === lineKey; })[0];
          return line && line.color;
        },

        // Prefer this repo's own canonical "Yellow Line" style label over
        // 511.org's much more verbose PublishedLineName ("Richmond to
        // Berryessa/North San Jose") when the response's LineRef resolved
        // to a known line — falls back to whatever the caller already has.
        _labelForLineKey: function (lineKey) {
          var line = lively.transit.BartData.lines.filter(function (l) { return l.key === lineKey; })[0];
          return line && line.label;
        },

        _escapeHtml: function (s) {
          return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
          });
        },
      },

      "vehicles",
      {
        _startVehiclePolling: function () {
          this._pollVehiclesOnce();
        },

        _pollVehiclesOnce: function () {
          var self = this;
          if (this._destroyed) return;
          lively.transit.TransitClient.vehicleMonitoring(function (err, result) {
            if (self._destroyed) return;
            self._renderVehicles(result.vehicles || []);
            // No simulated fallback for vehicles (see TransitClient.js) —
            // always a real network call, so poll at a steady rate that
            // respects 511.org's per-token rate limit.
            self._vehiclePollTimer = setTimeout(function () { self._pollVehiclesOnce(); }, 30000);
          });
        },

        _renderVehicles: function (vehicles) {
          var self = this;
          if (!this._map) return;
          var seen = {};
          vehicles.forEach(function (v) {
            var id = v.vehicleId || (v.lineKey + "|" + v.lat + "," + v.lon);
            seen[id] = true;
            var color = self._colorForLineKey(v.lineKey) || "#0077cc";
            var existing = self._vehicleMarkers[id];
            if (existing) {
              existing.setLatLng([v.lat, v.lon]);
            } else {
              var icon = window.L.divIcon({
                className: "transit-vehicle-marker",
                html: '<div style="width:14px;height:14px;border-radius:50%;background:' + color + ';' +
                  'border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.5);"></div>',
                iconSize: [14, 14],
                iconAnchor: [7, 7],
              });
              var marker = window.L.marker([v.lat, v.lon], { icon: icon, zIndexOffset: 1000 }).addTo(self._map);
              marker.bindTooltip((v.line || "") + " → " + (v.destination || ""));
              self._vehicleMarkers[id] = marker;
            }
          });
          Object.keys(this._vehicleMarkers).forEach(function (id) {
            if (!seen[id]) { self._map.removeLayer(self._vehicleMarkers[id]); delete self._vehicleMarkers[id]; }
          });
        },
      },

      "routing",
      {
        // legs: BartData.findRoute() result, or null/undefined to clear.
        highlightRoute: function (legs) {
          if (this._routeLayer) { this._map.removeLayer(this._routeLayer); this._routeLayer = null; }
          if (!legs || !this._map) return;
          var self = this;
          var group = window.L.layerGroup();
          legs.forEach(function (leg) {
            var pts = leg.stations.map(function (abbr) {
              var s = lively.transit.BartData.stations[abbr];
              return s ? [s.lat, s.lon] : null;
            }).filter(Boolean);
            var line = lively.transit.BartData.lines.filter(function (l) { return l.key === leg.lineKey; })[0];
            window.L.polyline(pts, {
              color: (line && line.color) || "#000",
              weight: 9, opacity: 0.55, dashArray: "1,10", lineCap: "round",
            }).addTo(group);
          });
          group.addTo(this._map);
          this._routeLayer = group;
          var allPts = legs.reduce(function (acc, leg) { return acc.concat(leg.stations); }, [])
            .map(function (abbr) { var s = lively.transit.BartData.stations[abbr]; return s && [s.lat, s.lon]; })
            .filter(Boolean);
          if (allPts.length) this._map.fitBounds(allPts, { padding: [40, 40] });
        },
      },
    );

    TransitMapMorphClass.open = function (optPos) {
      var m = new lively.transit.TransitMapMorph(lively.rect(0, 0, 960, 640));
      m.openInWorld(optPos || lively.morphic.World.current().visibleBounds().center().subPt(lively.pt(480, 320)));
      return m;
    };

  }); // end module('lively.transit.TransitMapMorph')
