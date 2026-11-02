/**
 * lively.identity.NatalChart
 *
 * Computes Sun / Moon / Rising signs from a birth date, optional birth time
 * and birth place. Everything runs in the browser: the ephemeris is the
 * vendored astronomy-engine bundle (core/lib/astro/astro-runtime.js) and the
 * place lookup is a bundled offline city list (core/lib/astro/cities.json,
 * GeoNames cities15000, CC BY 4.0 — https://www.geonames.org). Nothing about
 * the birth data is stored or sent anywhere; callers only keep the resulting
 * sign indices.
 *
 * Sign indices match lively.identity.ProfileCard.ZODIAC.SIGNS (0 = Aries …
 * 11 = Pisces); -1 means "not computable".
 *
 * Everything lives on the lively.identity.NatalChart namespace (no
 * module-scope vars) so BuildSpec methods and addScript handlers, which lose
 * their closure, can call it by a global path — see CLAUDE.md.
 */

module("lively.identity.NatalChart").requires().toRun(function () {

  lively.identity.NatalChart = {
    RUNTIME_URL: '/core/lib/astro/astro-runtime.js',
    CITIES_URL:  '/core/lib/astro/cities.json',
    MIN_YEAR: 1800,

    // ── loading ───────────────────────────────────────────────────────────
    _state: { runtime: 0, cities: 0, waiters: [], index: null },

    // Lazy-loads the ephemeris bundle and the city list, then calls
    // cb(err). Safe to call repeatedly / concurrently.
    ensureLoaded: function (cb) {
      var N = lively.identity.NatalChart, S = N._state;
      if (S.runtime === 2 && S.cities === 2) return cb(null);
      S.waiters.push(cb);
      function settle(err) {
        var ws = S.waiters.splice(0);
        ws.forEach(function (w) { w(err || null); });
      }
      function check() {
        if (S.runtime === 3 || S.cities === 3) {
          S.runtime = S.runtime === 3 ? 0 : S.runtime;
          S.cities  = S.cities  === 3 ? 0 : S.cities;
          return settle(new Error('Could not load the birth chart data.'));
        }
        if (S.runtime === 2 && S.cities === 2) settle(null);
      }
      if (S.runtime === 0) {
        S.runtime = 1;
        if (window.Astronomy) { S.runtime = 2; }
        else {
          var s = document.createElement('script');
          s.src = N.RUNTIME_URL;
          s.onload  = function () { S.runtime = window.Astronomy ? 2 : 3; check(); };
          s.onerror = function () { S.runtime = 3; check(); };
          document.head.appendChild(s);
        }
      }
      if (S.cities === 0) {
        S.cities = 1;
        var x = new XMLHttpRequest();
        x.open('GET', N.CITIES_URL);
        x.onload = function () {
          try {
            N._buildIndex(JSON.parse(x.responseText));
            S.cities = 2;
          } catch (e) { S.cities = 3; }
          check();
        };
        x.onerror = function () { S.cities = 3; check(); };
        x.send();
      }
      check();
    },

    _buildIndex: function (data) {
      var regions = null;
      try { regions = new Intl.DisplayNames(['en'], { type: 'region' }); } catch (e) {}
      var idx = data.cities.map(function (c) {
        var country = '';
        try { country = regions ? (regions.of(c[2]) || '') : ''; } catch (e) {}
        return {
          name: c[0], country: c[2], countryName: country,
          lat: c[3], lon: c[4], tz: data.tz[c[5]],
          key: (c[0] + ' ' + c[1]).toLowerCase(),
          cKey: (c[2] + ' ' + country).toLowerCase(),
        };
      });
      lively.identity.NatalChart._state.index = idx;
    },

    // City suggestions for a typed query, e.g. "Paris" or "Paris, FR" /
    // "Paris, France". Results keep the dataset's population order, with
    // names that start with the query ahead of those that merely contain it.
    // Returns [] until ensureLoaded has finished.
    searchCities: function (query, limit) {
      var idx = lively.identity.NatalChart._state.index;
      limit = limit || 6;
      if (!idx) return [];
      var parts = String(query || '').toLowerCase().split(',');
      var q = parts[0].trim(), cq = (parts[1] || '').trim();
      if (q.length < 2) return [];
      var starts = [], contains = [];
      for (var i = 0; i < idx.length && starts.length < limit; i++) {
        var c = idx[i];
        if (cq && c.cKey.indexOf(cq) < 0 && c.country.toLowerCase() !== cq) continue;
        var pos = c.key.indexOf(q);
        if (pos < 0) continue;
        if (c.name.toLowerCase().indexOf(q) === 0 || c.key.indexOf(q) === 0) starts.push(c);
        else if (contains.length < limit) contains.push(c);
      }
      return starts.concat(contains).slice(0, limit);
    },

    cityLabel: function (c) {
      return c.name + ', ' + (c.countryName || c.country);
    },

    // ── input parsing ─────────────────────────────────────────────────────

    // "1990-01-20", "1/20/1990" or "01.20.1990" (month first) → "YYYY-MM-DD",
    // or null when it isn't a real calendar date.
    parseDate: function (str) {
      var s = String(str || '').trim(), y, mo, d;
      var m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/.exec(s);
      if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
      else if ((m = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/.exec(s))) { mo = +m[1]; d = +m[2]; y = +m[3]; }
      else return null;
      var dt = new Date(Date.UTC(y, mo - 1, d));
      if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
      function p(n) { return (n < 10 ? '0' : '') + n; }
      return y + '-' + p(mo) + '-' + p(d);
    },

    // "19:24", "7:24 pm", "7pm" → "HH:MM"; '' for blank; null when invalid.
    parseTime: function (str) {
      var s = String(str || '').trim().toLowerCase();
      if (!s) return '';
      var m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(s);
      if (!m) return null;
      var h = +m[1], mi = m[2] ? +m[2] : 0;
      if (mi > 59) return null;
      if (m[3]) {
        if (h < 1 || h > 12) return null;
        h = h % 12 + (m[3] === 'pm' ? 12 : 0);
      } else if (h > 23) return null;
      function p(n) { return (n < 10 ? '0' : '') + n; }
      return p(h) + ':' + p(mi);
    },

    // ── time ──────────────────────────────────────────────────────────────

    // Offset (ms) of `tz` from UTC at the instant `utcMs`, via Intl — this is
    // what carries DST and historical zone rules.
    _tzOffsetMs: function (utcMs, tz) {
      var f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23',
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
      });
      var p = {};
      f.formatToParts(new Date(utcMs)).forEach(function (x) { p[x.type] = +x.value; });
      var asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
      return asUtc - Math.floor(utcMs / 1000) * 1000;
    },

    // Wall-clock "YYYY-MM-DD" + "HH:MM" in `tz` → UTC ms. Iterates so a time
    // near a DST change resolves against the offset in force at that moment.
    localToUtcMs: function (dateStr, timeStr, tz) {
      var N = lively.identity.NatalChart;
      var d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
      var t = /^(\d{1,2}):(\d{2})$/.exec(timeStr || '12:00');
      if (!d || !t) return NaN;
      var guess = Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2], 0);
      if (!tz) return guess;
      var utc = guess - N._tzOffsetMs(guess, tz);
      var utc2 = guess - N._tzOffsetMs(utc, tz);
      return utc2;
    },

    // ── astronomy ─────────────────────────────────────────────────────────
    _norm: function (deg) { return ((deg % 360) + 360) % 360; },
    _signOf: function (lon) { return Math.floor(lively.identity.NatalChart._norm(lon) / 30); },

    sunLongitude:  function (utcMs) { return window.Astronomy.SunPosition(new Date(utcMs)).elon; },
    moonLongitude: function (utcMs) { return window.Astronomy.EclipticGeoMoon(new Date(utcMs)).lon; },

    // Ascendant ecliptic longitude (degrees) for a UTC instant and place.
    ascendantLongitude: function (utcMs, latDeg, lonDeg) {
      var N = lively.identity.NatalChart, A = window.Astronomy;
      var rad = Math.PI / 180;
      var time = A.MakeTime(new Date(utcMs));
      var ramc = (A.SiderealTime(time) * 15 + lonDeg) * rad;   // local sidereal time
      var eps = A.e_tilt(time).tobl * rad;                     // true obliquity
      var y = Math.cos(ramc);
      var x = -(Math.sin(ramc) * Math.cos(eps) + Math.tan(latDeg * rad) * Math.sin(eps));
      var asc = Math.atan2(y, x);
      // The ecliptic meets the horizon at two opposite points; the Ascendant
      // is the one on the eastern half (Swiss Ephemeris documents the same
      // rule: "The ascendant always has to be on the eastern part of the
      // horizon"). At normal latitudes the formula already returns it. Beyond
      // the polar circle it can return the western point, which is the
      // descendant — so flip by 180° when its hour angle is positive (west).
      var ra = Math.atan2(Math.sin(asc) * Math.cos(eps), Math.cos(asc));
      if (Math.sin(ramc - ra) > 0) asc += Math.PI;
      return N._norm(asc / rad);
    },

    // input: { date: 'YYYY-MM-DD', time: 'HH:MM' | null, place: {lat, lon, tz} | null }
    // Returns { sun, moon, rising, moonAlt, sunAlt, notes[] }; signs are
    // indices or -1. sunAlt/moonAlt list every sign the body occupies during
    // the birth day when the time is unknown; length > 1 means the sign
    // can't be determined without a birth time, and callers should not
    // treat `sun`/`moon` (the noon value) as definite.
    // Throws an Error with a user-presentable message on bad input.
    calculate: function (input) {
      var N = lively.identity.NatalChart;
      if (!window.Astronomy) throw new Error('The ephemeris has not loaded yet.');
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.date || '');
      if (!m) throw new Error('Enter a birth date.');
      var year = +m[1];
      if (year < N.MIN_YEAR || year > new Date().getUTCFullYear())
        throw new Error('Birth year must be between ' + N.MIN_YEAR + ' and this year.');
      var place = input.place || null;
      var hasTime = !!input.time;
      if (hasTime && !place) throw new Error('Choose a birth place to use the birth time.');
      var tz = place ? place.tz : null;
      var out = { sun: -1, moon: -1, rising: -1, sunAlt: [], moonAlt: [], notes: [] };

      function signsOverDay(lonFn) {
        var start = N.localToUtcMs(input.date, '00:00', tz);
        var seen = [];
        for (var h = 0; h <= 24; h++) {
          var s = N._signOf(lonFn(start + h * 3600000));
          if (seen.indexOf(s) < 0) seen.push(s);
        }
        return seen;
      }

      if (hasTime) {
        var utc = N.localToUtcMs(input.date, input.time, tz);
        if (isNaN(utc)) throw new Error('Enter the birth time as HH:MM.');
        out.sun    = N._signOf(N.sunLongitude(utc));
        out.moon   = N._signOf(N.moonLongitude(utc));
        out.rising = N._signOf(N.ascendantLongitude(utc, place.lat, place.lon));
        out.sunAlt = [out.sun];
        out.moonAlt = [out.moon];
        // Birth times are rarely exact, so note when the Rising sign is close
        // to a boundary: every sign it takes within ±10 minutes of the given time.
        out.risingAlt = [];
        for (var dm = -10; dm <= 10; dm++) {
          var rs = N._signOf(N.ascendantLongitude(utc + dm * 60000, place.lat, place.lon));
          if (out.risingAlt.indexOf(rs) < 0) out.risingAlt.push(rs);
        }
        // Verified against an independent horizon scan: the formula is exact at
        // every latitude, but past the polar circle the ecliptic can lie almost
        // flat on the horizon, so the result is very sensitive to time and place.
        if (Math.abs(place.lat) > 66.5) out.notes.push('Near the polar circle, Rising is very sensitive to the exact time and place.');
      } else {
        var noon = N.localToUtcMs(input.date, '12:00', tz);
        out.sun  = N._signOf(N.sunLongitude(noon));
        out.moon = N._signOf(N.moonLongitude(noon));
        out.sunAlt  = signsOverDay(N.sunLongitude);
        out.moonAlt = signsOverDay(N.moonLongitude);
        out.notes.push('Add a birth time and place to get your Rising sign.');
      }
      return out;
    },
  };
});
