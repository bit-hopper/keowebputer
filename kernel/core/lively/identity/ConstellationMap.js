/**
 * lively.identity.ConstellationMap
 *
 * A Leaflet+OSM map of a constellation's location-tagged postcards, meant
 * to fill ConstellationLounge.js's quick-info panel while its "Map" button
 * is toggled on. Native self-rendering lively.morphic.Box (same architecture
 * as lively.transit.TransitMapMorph — real hand-built DOM in the morph's own
 * shapeNode, Leaflet mounted from the already-vendored core/lib/geo runtime).
 *
 * Privacy model: every postcard's `state.location` is already a floored Plus
 * Code (<=6 significant digits, ~5.5km x 5.5km cell — see LocalMap.js's doc
 * comment). Decoding gives that cell's *center*, never a poster's real
 * position; postcards sharing a cell decode to the same point and are fanned
 * out on a small deterministic ring so they don't stack exactly.
 *
 * Data: GET /c/:constellation/feed?hasLocation=1 (paged, metadata only). The
 * feed identifies authors by did, so opts.resolveHandles (the controller's
 * own batch handle resolver) turns them into the handles PostCardView.open
 * needs; a card whose handle doesn't resolve is skipped (nothing to open).
 *
 * opts: {
 *   constellation:  String,
 *   resolveHandles: function (dids, thenDo(didToHandle)),
 *   onOpen:         function (handle, objId),   // marker click
 * }
 */

module("lively.identity.ConstellationMap")
  .requires("lively.identity.DID")
  .toRun(function () {

    // Postcards sharing one location cell are spread on concentric rings
    // around the cell's center (an approximate location is the goal, so
    // separating them is intended). LocalMap.js's single 67m ring put
    // same-cell 24px pins ~7px apart at this map's auto-zoom (<=13, ~15m/px)
    // — nearly overlapping. Here ring 0 sits at RING0_M and each further ring
    // RING_GAP_M out; a ring holds only as many pins as keep neighbors at
    // least MIN_PIN_SEP_M apart (~30px at zoom 13 for 24px pins), and extras
    // spill to the next ring. 50 pins reach ~1.7km, well inside a ~5.5km cell.
    var RING0_M = 330, RING_GAP_M = 460, MIN_PIN_SEP_M = 460;
    var METERS_PER_DEG_LAT = 111320;

    // Ring radius (m) and angle (rad) for pin `idx` of a `groupSize`-pin cell.
    function ringSlot(idx, groupSize) {
      var ring = 0, start = 0, remaining = groupSize;
      for (;;) {
        var r = RING0_M + ring * RING_GAP_M;
        var capacity = Math.max(1, Math.floor(2 * Math.PI * r / MIN_PIN_SEP_M));
        var inRing = Math.min(capacity, remaining);
        if (idx < start + inRing) {
          // Each ring is rotated a bit so neighbors on adjacent rings stagger.
          return { radiusM: r, angle: 2 * Math.PI * (idx - start) / inRing + ring * 0.6 };
        }
        start += inRing;
        remaining -= inRing;
        ring++;
      }
    }
    var PAGE_SIZE = 100;         // server-side cap per request
    var MAX_PINS = 500;          // don't page a huge constellation forever

    var POSTCARD_MARKER_HTML =
      '<div style="width:24px;height:24px;display:flex;align-items:center;' +
      'justify-content:center;background:#fff;border:2px solid #d33;' +
      'border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,0.3);' +
      'font-size:12px;line-height:1;">✉️</div>';

    lively.morphic.Box.subclass(
      "lively.identity.ConstellationMap",

      "initialization",
      {
        initialize: function ($super, bounds, opts) {
          // Set before $super: prepareForNewRenderContext (which kicks off
          // _setup) can run during the base constructor.
          this._opts = opts || {};
          $super(bounds);
          this.setFill(null);
          this.setBorderWidth(0);
          // All three flags, per CLAUDE.md's drag/grab gotcha — this map
          // pans via Leaflet's own drag handling, not as a morph.
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
          this._destroyed = false;
          this._cards = [];
          this._buildChrome();
          var self = this;
          this._ensureGeoRuntime(function () { self._whenSized(self._initMap.bind(self)); });
        },

        // Leaflet reads its container's size once, at L.map() time. When the
        // geo runtime is already loaded (every open after the first in a page
        // session) _ensureGeoRuntime calls back synchronously — i.e. during
        // this morph's own construction, before it has been added to the
        // panel and attached to the document, so the container measures 0x0.
        // Leaflet then believes it is 0x0 forever: one tile in the corner,
        // pins/tooltips misplaced. Wait until the container is actually
        // attached and laid out (bounded, so a never-shown morph can't poll
        // forever), then build the map.
        _whenSized: function (callback, tries) {
          if (this._destroyed) return;
          var el = this._mapEl;
          if (el && el.isConnected && el.clientWidth > 0 && el.clientHeight > 0) return callback();
          tries = tries || 0;
          if (tries > 100) return this._setStatus("Couldn't display the map");
          var self = this;
          setTimeout(function () { self._whenSized(callback, tries + 1); }, 50);
        },

        remove: function ($super) {
          this._destroyed = true;
          if (this._map) { this._map.remove(); this._map = null; }
          $super();
        },

        // Resize entry point for the controller: Leaflet has to be told its
        // container changed size or it keeps rendering into the old one.
        fitTo: function (w, h) {
          this.setExtent(lively.pt(w, h));
          var map = this._map;
          if (map) setTimeout(function () { map.invalidateSize(); }, 0);
        },
      },

      "chrome",
      {
        _buildChrome: function () {
          var shapeNode = this.renderContext().shapeNode;
          shapeNode.innerHTML = "";
          // isolation:isolate + z-index:0 traps Leaflet's internal pane
          // z-indices (200-700) inside this morph — see TransitMapMorph.js.
          shapeNode.style.cssText = "position:relative;isolation:isolate;z-index:0;overflow:hidden;background:#eef0f2;";

          var mapEl = document.createElement("div");
          mapEl.style.cssText = "position:absolute;inset:0;";
          // Let Leaflet handle pan/zoom drags instead of Lively's morph drag.
          mapEl.addEventListener("mousedown", function (e) { e.stopPropagation(); });
          shapeNode.appendChild(mapEl);
          this._mapEl = mapEl;

          var statusEl = document.createElement("div");
          statusEl.style.cssText = "position:absolute;left:12px;bottom:10px;z-index:1000;font:12px/1.3 system-ui,sans-serif;" +
            "color:#555;background:rgba(255,255,255,0.9);padding:3px 10px;border-radius:12px;pointer-events:none;";
          statusEl.textContent = "Loading map…";
          shapeNode.appendChild(statusEl);
          this._statusEl = statusEl;
        },

        // Same guard/poll/CSS-link shape as LocalMap.js/TransitMapMorph.js.
        _ensureGeoRuntime: function (callback) {
          if (window.L && window.OpenLocationCode) return callback();
          var self = this;
          if (window._geoRuntimeLoading) {
            var poll = setInterval(function () {
              if (self._destroyed) { clearInterval(poll); return; }
              if (window.L && window.OpenLocationCode) { clearInterval(poll); callback(); }
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

        _setStatus: function (text) {
          if (this._statusEl) {
            this._statusEl.textContent = text;
            this._statusEl.style.display = text ? "" : "none";
          }
        },
      },

      "map",
      {
        _initMap: function () {
          if (this._destroyed || this._map) return;
          // Zoom control moved top-right: the controller's Back button sits
          // over this map's top-left corner.
          this._map = window.L.map(this._mapEl, { zoomControl: false }).setView([20, 0], 2);
          window.L.control.zoom({ position: "topright" }).addTo(this._map);
          window.L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
          }).addTo(this._map);
          this._fetchPage(null);
        },

        _fetchPage: function (cursor) {
          var self = this;
          var base = lively.identity.did.baseUrl();
          var url = base + "/c/" + encodeURIComponent(this._opts.constellation) +
            "/feed?hasLocation=1&limit=" + PAGE_SIZE +
            (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
          var xhr = new XMLHttpRequest();
          xhr.open("GET", url, true);
          xhr.withCredentials = true;
          xhr.setRequestHeader("Accept", "application/json");
          xhr.onload = function () {
            if (self._destroyed) return;
            if (xhr.status !== 200) return self._setStatus("Couldn't load postcards (" + xhr.status + ")");
            var data;
            try { data = JSON.parse(xhr.responseText); } catch (e) { return self._setStatus("Couldn't load postcards"); }
            self._cards = self._cards.concat(data.postcards || []);
            if (data.cursor && self._cards.length < MAX_PINS) return self._fetchPage(data.cursor);
            self._placeAll();
          };
          xhr.onerror = function () { if (!self._destroyed) self._setStatus("Network error loading postcards"); };
          xhr.send();
        },

        _placeAll: function () {
          var self = this;
          var dids = [];
          this._cards.forEach(function (c) { if (c.did && dids.indexOf(c.did) < 0) dids.push(c.did); });
          var resolve = this._opts.resolveHandles || function (d, thenDo) { thenDo({}); };
          resolve(dids, function (handles) {
            if (self._destroyed || !self._map) return;
            self._cards.forEach(function (c) { c.handle = handles && handles[c.did]; });
            self._placeMarkers();
          });
        },

        // Groups by (already-floored) location cell first so a cell holding
        // several postcards gets its markers spread on a small ring —
        // deterministic, not random, so pins don't jump between re-renders.
        _placeMarkers: function () {
          var self = this;
          var olc = new window.OpenLocationCode();
          var groups = {};
          this._cards.forEach(function (p) {
            var loc = p.state && p.state.location;
            // No handle requirement: a pin click shows the card in the reel,
            // which resolves the author itself from the envelope's did.
            if (!loc) return;
            (groups[loc] = groups[loc] || []).push(p);
          });

          var bounds = [], count = 0;
          Object.keys(groups).forEach(function (loc) {
            var area;
            try { area = olc.decode(loc); } catch (e) { return; }
            var center = [area.latitudeCenter, area.longitudeCenter];
            // Sorted by objId so a pin's slot doesn't depend on feed order.
            var group = groups[loc].sort(function (a, b) { return a.objId < b.objId ? -1 : a.objId > b.objId ? 1 : 0; });
            group.forEach(function (postcard, idx) {
              var latlng = self._offsetPosition(center, idx, group.length);
              self._addMarker(latlng, postcard);
              bounds.push(latlng);
              count++;
            });
          });

          if (!count) return this._setStatus("No location-tagged postcards yet");
          if (bounds.length === 1) this._map.setView(bounds[0], 12);
          else this._map.fitBounds(bounds, { padding: [48, 48], maxZoom: 13 });
          this._setStatus(count + " postcard" + (count === 1 ? "" : "s") + " on the map");
        },

        _offsetPosition: function (center, idx, groupSize) {
          if (groupSize <= 1) return center;
          var slot = ringSlot(idx, groupSize);
          // A degree of longitude is shorter than one of latitude away from
          // the equator; scale it so each ring is a circle, not an oval.
          var metersPerDegLng = METERS_PER_DEG_LAT * Math.max(0.2, Math.cos(center[0] * Math.PI / 180));
          return [
            center[0] + slot.radiusM * Math.sin(slot.angle) / METERS_PER_DEG_LAT,
            center[1] + slot.radiusM * Math.cos(slot.angle) / metersPerDegLng,
          ];
        },

        _addMarker: function (latlng, postcard) {
          var self = this;
          var icon = window.L.divIcon({
            className: "lively-constellationmap-marker",
            html: POSTCARD_MARKER_HTML,
            iconSize: [24, 24],
            iconAnchor: [12, 12],
          });
          var marker = window.L.marker(latlng, { icon: icon }).addTo(this._map);
          // Title is user-authored: hand Leaflet a text-node element rather
          // than an HTML string so it can't inject markup into the tooltip.
          var tip = document.createElement("span");
          var tipTitle = (postcard.state && postcard.state.title) || "(untitled)";
          tip.textContent = postcard.handle ? "@" + postcard.handle + " — " + tipTitle : tipTitle;
          marker.bindTooltip(tip);
          marker.on("click", function () {
            if (self._opts.onOpen) self._opts.onOpen(postcard.handle, postcard.objId);
          });
        },
      }
    );

  }); // end module('lively.identity.ConstellationMap')
