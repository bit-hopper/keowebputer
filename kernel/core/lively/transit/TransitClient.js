/**
 * lively.transit.TransitClient
 *
 * Client-side data access for the transit map: live BART predictions (via
 * TransitProxyServer.js, which holds the real 511.org API token
 * server-side) and current weather (via Open-Meteo, called directly —
 * open-meteo.com requires no API key and serves CORS on every response, so
 * it uses the same bare-fetch idiom as Musicpod.js's noembed calls, no
 * proxy needed).
 *
 * Until a real 511.org token is configured (see TransitProxyServer.js's
 * doc comment), the proxy responds 503 — stopMonitoring falls back to
 * clearly-labeled simulated arrival predictions in that case
 * (`simulated: true` on the result), deterministic per (station, line,
 * ~14-minute bucket) so they count down smoothly and don't jump around on
 * repeated polls. vehicleMonitoring has no such fallback: BART's 511.org
 * feed never publishes real-time vehicle GPS at all (confirmed live,
 * repeatedly, during service hours), so simulating moving dots for it would
 * be permanent decoration misrepresenting real trains, not a stand-in for a
 * temporary gap — it just reports real vehicles, empty if there are none.
 */

module("lively.transit.TransitClient")
  .requires("lively.transit.BartData")
  .toRun(function () {

    // Subserver routes are mounted under /nodejs/<ServerFileName>/ by
    // life_star's default baseURL (node_modules/life_star/lib/subservers.js),
    // not at the root — confirmed live the hard way: this was originally
    // "/TransitProxyServer/" and 404'd with jsdav's WebDAV-flavored
    // FileNotFound XML even after a real server restart with a real API key
    // configured, exactly the misleading symptom CLAUDE.md's "brand-new
    // route 404ing" note warns about, except the actual cause here was a
    // wrong route prefix, not a stale process.
    var PROXY_BASE = "/nodejs/TransitProxyServer/";
    var SIM_CYCLE_MS = 14 * 60 * 1000; // simulated trains arrive on a ~14min cadence per line/station, in line with typical BART headways

    // Small stable hash so simulated countdowns are deterministic per
    // (station, line) rather than random-per-call.
    function stableHash(str) {
      var h = 0;
      for (var i = 0; i < str.length; i++) { h = ((h << 5) - h + str.charCodeAt(i)) | 0; }
      return Math.abs(h);
    }

    function simulatedPredictionsFor(stationAbbr) {
      var lines = lively.transit.BartData.linesAt(stationAbbr);
      var now = Date.now();
      return lines.map(function (line) {
        var seed = stableHash(stationAbbr + "|" + line.key);
        var phase = (seed % SIM_CYCLE_MS);
        var msIntoCycle = (now + phase) % SIM_CYCLE_MS;
        var msUntilNext = SIM_CYCLE_MS - msIntoCycle;
        var lastStation = line.stations[line.stations.length - 1];
        return {
          line: line.label,
          lineKey: line.key,
          destination: lively.transit.BartData.stationName(lastStation),
          stopName: lively.transit.BartData.stationName(stationAbbr),
          expectedArrival: new Date(now + msUntilNext).toISOString(),
          minutesAway: Math.max(0, Math.round(msUntilNext / 60000)),
        };
      });
    }

    lively.transit.TransitClient = {

      // thenDo(err, { predictions: [...], simulated: bool })
      stopMonitoring: function (stationAbbr, thenDo) {
        var station = lively.transit.BartData.stations[stationAbbr];
        if (!station || !station.stopId511) {
          return thenDo(null, { predictions: simulatedPredictionsFor(stationAbbr), simulated: true });
        }
        var url = PROXY_BASE + "stop-monitoring?agency=" +
          encodeURIComponent(lively.transit.BartData.agency) +
          "&stopcode=" + encodeURIComponent(station.stopId511);
        fetch(url).then(function (res) {
          if (res.status === 503) return null; // not configured — fall back below
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        }).then(function (data) {
          if (!data) {
            return thenDo(null, { predictions: simulatedPredictionsFor(stationAbbr), simulated: true });
          }
          thenDo(null, { predictions: data.predictions || [], simulated: false });
        }).catch(function () {
          thenDo(null, { predictions: simulatedPredictionsFor(stationAbbr), simulated: true });
        });
      },

      // thenDo(err, { vehicles: [...], simulated: false })
      // No simulated fallback here (unlike stopMonitoring): confirmed live,
      // repeatedly, during BART service hours, that BART's 511.org feed
      // never populates VehicleActivity at all — it publishes StopMonitoring
      // arrival predictions but not real-time vehicle GPS. Fabricating
      // moving dots for a feed that will never produce real ones would be
      // permanently-misleading decoration, not a stand-in for a temporary
      // gap, so this just reports whatever's really there — empty, if BART
      // doesn't have it.
      vehicleMonitoring: function (thenDo) {
        var url = PROXY_BASE + "vehicle-monitoring?agency=" + encodeURIComponent(lively.transit.BartData.agency);
        fetch(url).then(function (res) {
          if (!res.ok) return { vehicles: [] }; // not configured, or any other error — just empty
          return res.json();
        }).then(function (data) {
          thenDo(null, { vehicles: (data && data.vehicles) || [], simulated: false });
        }).catch(function () {
          thenDo(null, { vehicles: [], simulated: false });
        });
      },

      // thenDo(err, { tempC, weatherCode, windKph, isDay, simulated: false })
      // San Francisco Bay Area default coordinates unless overridden.
      currentWeather: function (lat, lon, thenDo) {
        lat = lat || 37.7749; lon = lon || -122.4194;
        var url = "https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon +
          "&current_weather=true&temperature_unit=celsius&windspeed_unit=kmh";
        fetch(url).then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        }).then(function (data) {
          var cw = data && data.current_weather;
          if (!cw) throw new Error("no current_weather in response");
          thenDo(null, {
            tempC: cw.temperature,
            weatherCode: cw.weathercode,
            windKph: cw.windspeed,
            isDay: cw.is_day === 1,
            simulated: false,
          });
        }).catch(function (err) { thenDo(err); });
      },

    };

  }); // end module('lively.transit.TransitClient')
