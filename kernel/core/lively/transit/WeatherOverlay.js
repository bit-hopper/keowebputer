/**
 * lively.transit.WeatherOverlay
 *
 * Small floating pill showing current Bay Area weather (Open-Meteo, no API
 * key needed — see TransitClient.currentWeather). Refreshes every 15
 * minutes; weather doesn't change fast enough to warrant more, and
 * Open-Meteo's fair-use expectations favor infrequent polling per client.
 */

module("lively.transit.WeatherOverlay")
  .requires("lively.transit.TransitClient")
  .toRun(function () {

    var W = 118, H = 44;
    var REFRESH_MS = 15 * 60 * 1000;

    // WMO weather codes (Open-Meteo's current_weather.weathercode) mapped to
    // vendored Material Symbols ligatures (core/media/material-icons/).
    function iconForCode(code, isDay) {
      if (code === 0) return isDay ? "clear_day" : "clear_night";
      if (code === 1 || code === 2) return "partly_cloudy_day";
      if (code === 3) return "cloud";
      if (code === 45 || code === 48) return "foggy";
      if (code === 71 || code === 73 || code === 75 || code === 77 || code === 85 || code === 86) return "weather_snowy";
      if (code === 95 || code === 96 || code === 99) return "thunderstorm";
      return "rainy"; // 51-67, 80-82: drizzle/rain/showers
    }

    function noDrag(m) {
      m.draggingEnabled = false;
      m.droppingEnabled = false;
      m.grabbingEnabled = false;
    }

    lively.transit.WeatherOverlay = {

      // lat/lon default to San Francisco if omitted.
      create: function (pos, lat, lon) {
        var box = new lively.morphic.Box(lively.rect(pos.x, pos.y, W, H));
        box.applyStyle({ fill: Color.white, borderRadius: H / 2, borderWidth: 0, clipMode: "hidden" });
        noDrag(box);

        var icon = new lively.morphic.Text(lively.rect(10, 0, 30, H));
        icon.applyStyle({
          fontFamily: "'Material Symbols Rounded'", fontSize: 15, textColor: Color.rgb(60, 64, 67),
          fill: null, borderWidth: 0, align: "center", allowInput: false, selectable: false,
          clipMode: "hidden", whiteSpaceHandling: "pre",
        });
        icon.textString = "cloud";
        icon.eventsAreIgnored = true;
        box.addMorph(icon);

        var label = new lively.morphic.Text(lively.rect(42, 0, W - 48, H));
        label.applyStyle({
          fontSize: 10.5, fontWeight: "600", textColor: Color.rgb(40, 40, 40), fill: null,
          borderWidth: 0, allowInput: false, selectable: false, clipMode: "hidden",
          whiteSpaceHandling: "pre",
        });
        label.textString = "…";
        label.eventsAreIgnored = true;
        box.addMorph(label);

        function refresh() {
          lively.transit.TransitClient.currentWeather(lat, lon, function (err, w) {
            if (!box.world()) return; // morph was removed while the request was in flight
            if (err) { label.textString = "Weather n/a"; return; }
            icon.textString = iconForCode(w.weatherCode, w.isDay);
            label.textString = Math.round(w.tempC) + "°C";
          });
        }

        refresh();
        var timer = setInterval(refresh, REFRESH_MS);
        box.remove = (function ($super) {
          return function () { clearInterval(timer); $super.call(box); };
        })(box.remove);

        return box;
      },
    };

  }); // end module('lively.transit.WeatherOverlay')
