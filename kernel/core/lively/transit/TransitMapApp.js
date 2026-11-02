/**
 * lively.transit.TransitMapApp
 *
 * Top-level composition: the Leaflet-backed TransitMapMorph plus three
 * floating morphic overlays (search, weather, destination planner) added
 * as ordinary submorphs on top of it. Overlay morphs are added to the DOM
 * after the map morph, so normal sibling paint order puts them visually on
 * top — safe because TransitMapMorph's own shapeNode uses
 * isolation:isolate (see its header comment), which traps Leaflet's own
 * internal high z-indices inside the map morph instead of letting them
 * escape and cover the overlays.
 *
 * Entry point: lively.transit.TransitMapApp.open()
 */

module("lively.transit.TransitMapApp")
  .requires(
    "lively.transit.TransitMapMorph",
    "lively.transit.SearchOverlay",
    "lively.transit.WeatherOverlay",
    "lively.transit.DestinationPlanner",
  )
  .toRun(function () {

    var APP_W = 960, APP_H = 640;

    lively.transit.TransitMapApp = {

      open: function (optPos) {
        var app = new lively.morphic.Box(lively.rect(0, 0, APP_W, APP_H));
        app.name = "Bay Area Transit Map";
        app.applyStyle({ fill: Color.rgb(230, 232, 235), borderWidth: 0, clipMode: "hidden" });

        var mapMorph = new lively.transit.TransitMapMorph(lively.rect(0, 0, APP_W, APP_H));
        app.addMorph(mapMorph);

        var search = lively.transit.SearchOverlay.create(mapMorph, lively.pt(16, 16));
        app.addMorph(search);

        var weather = lively.transit.WeatherOverlay.create(lively.pt(APP_W - 118 - 16, 16));
        app.addMorph(weather);

        var planner = lively.transit.DestinationPlanner.create(mapMorph, lively.pt(16, APP_H - 16));
        app.addMorph(planner);

        // Real classic Window chrome (drag/resize/collapse/close, Material
        // Symbols icon controls by default) rather than a bare floating box
        // — same pattern as CalendarApp.js/FilesBrowser.js's open().
        app.openInWindow({
          title: "Transit",
          pos: optPos || lively.morphic.World.current().visibleBounds().center().subPt(lively.pt(APP_W / 2, APP_H / 2)),
        });
        app.getWindow().comeForward();
        return app;
      },
    };

  }); // end module('lively.transit.TransitMapApp')
