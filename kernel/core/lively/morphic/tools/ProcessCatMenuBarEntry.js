/**
 * lively.morphic.tools.ProcessCatMenuBarEntry
 *
 * A little running cat in the menu bar. It runs faster the busier the machine
 * and this page are, and clicking it lists what the browser reports and the
 * background processes Lively itself is running.
 *
 * Where the numbers come from (a browser has no "CPU percent"):
 *  - machine-wide: the Compute Pressure API (PressureObserver, source "cpu"). It
 *    reports one of four states (nominal / fair / serious / critical), sampled
 *    about once a second, and only in browsers that ship it (Chromium; checked in
 *    Chrome 155) and on a secure context. Elsewhere this signal is simply absent.
 *  - this page: how much of the last few seconds the main thread spent in long
 *    animation frames (or, where that is missing, long tasks). This is the page's
 *    own load, and includes Lively's stepping scripts.
 *  Neither is a percentage of the machine's CPU, and the menu says what each one is.
 *
 * "Background processes" means the stepping scripts (Morph#startStepping) running
 * on morphs in the world: that is what Lively schedules behind the scenes. Web
 * workers and in-flight requests are not listed (they are not registered anywhere
 * central).
 *
 * The cat is made of real Image morphs (one per animation frame) inside an
 * ordinary menu bar entry, so it can be halo-selected and inspected like any
 * morph.
 *
 * The frames are NOT generated: a hand-tuned parametric SVG (procedural body
 * bob / leg swing / tail curve) was tried first and repeatedly missed what the
 * user actually wanted (one eye, then a wrong two-eye layout, then a tail that
 * swung the wrong way) -- see processcat.md section 6 item 9 for the blow-by-
 * blow. The user then asked for the reference frames followed almost pixel for
 * pixel, so FRAME_PNG below holds the user's own five reference frames verbatim,
 * just recoloured: each pixel's RGB was replaced with COLOR or HOT_COLOR while
 * its original alpha (shape, antialiasing, everything) was left untouched, with
 * a one-off Python/Pillow script (not checked in; the result is these five
 * frames x two colours, base64 PNG, below). Same silhouette as the reference,
 * at both colours; nothing here draws the cat anymore.
 *
 * Everything the BuildSpec's methods need lives on lively.morphic.tools.ProcessCat:
 * BuildSpec methods are rebuilt from their source text and lose the closure over
 * this module's variables (CLAUDE.md, "BuildSpec / addScript methods lose their
 * closure"), so a bare module-level helper would throw at the first call.
 */

module('lively.morphic.tools.ProcessCatMenuBarEntry').requires('lively.morphic.tools.MenuBar').toRun(function() {

// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
// Helpers. Use these rather than re-deriving the numbers in the entry's methods:
//   frameUrl(i, hot)   data: URL of animation frame i, grey or accent coloured
//   frameMs(level)     how long one frame stays on screen at a load level (0..1)
//   Monitor            the load signals; one shared instance, started on first use
//   processes()        the stepping scripts running in the world, most frequent first
//   describePressure() / describeBusy()   the text the menu shows for each signal
// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

lively.morphic.tools.ProcessCat = {

  FRAMES: 5,                       // the user's 5 reference frames, one full stride
  CAT_W: 35, CAT_H: 20,            // drawing size in px; 35x20 keeps the source's 63x36 aspect
  COLOR: "#555555",                // calm cat: the menu bar's own text grey
  HOT_COLOR: "rgb(240,26,105)",    // the cat turns the page's pink when the load is high
  HOT_LEVEL: 0.7,                  // from this load level on, the hot colour is used
  SLOWEST_MS: 240,                 // frame time at no load
  FASTEST_MS: 45,                  // frame time at full load
  BUSY_WINDOW_MS: 4000,            // how far back "this page is busy" looks
  BUSY_GAIN: 3,                    // a page busy 33% of the time already counts as full load
  PRESSURE_LEVEL: { nominal: 0.08, fair: 0.4, serious: 0.75, critical: 1 },
  MAX_PROCESSES_SHOWN: 14,

  // The user's 5 reference frames (attached 2026-10-25, originally 63x36 PNGs
  // with soft anti-aliased alpha edges, no other colour information at all --
  // confirmed by a per-pixel colour-frequency scan: every opaque pixel is pure
  // black at varying alpha, so the apparent grey in the ears is downscale
  // anti-aliasing against a white page, not a real fill colour), recoloured:
  // RGB replaced with COLOR or HOT_COLOR, alpha left byte-for-byte untouched.
  // Base64 PNG, [grey, pink] per frame, same order as the attachments (1..5).
  // Index 0 keeps the original filenames' order; nothing here draws a cat
  // anymore, this is the source pixels themselves, just retinted.
  FRAME_PNG: [
    ["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"],
    ["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"],
    ["iVBORw0KGgoAAAANSUhEUgAAAD8AAAAkCAYAAAA+TuKHAAADiElEQVR42u3aW4iUZRgH8N+4a7tmravFUnZRkUlRREWQdjAQooNEJ7YisCCICDIKuurGjhfVRVsJURdBIUFtBW1QppTSVXQwQjK7yEqWcFVKY612bd0u5hl4+fjmVDsnnD8M37fvPPPO93+f8zNbGB4edqxinmMYXfJd8l3yXfJd8h2Id/A7zknWLsQ0Dud9oLcFDzmEK3E7LsbCMnJ/YyNewr4qe67CrXF/BXbFdRt6MNsO5C/HelyCxTXIP4DzsQGflJG5CluTvw/EdVMQh5lWmv0CvIgxXF0jcRjETRjFCPoy758dxAt4MMz7EO4MixrFM5jfKvKn4mmsw5L/uMfiIPc1LkjWNwfxsXCPeXFAG/AZbgvLKDSb/Hxchy/x8BzsV8B5eDa0OoQzQts3YktY2GtxWN/jQ6zAkWb6/CrcjXsasPc14dclbfZHcOxLLA3uSz7Tj/14Lg6vIeSvxx1Y22BX6k/ue5LAVgknh///GllkTsgvC01fi3bsj4/i58QqRqqRvyEi7UQElRJuDv8ZinR1PC6LqNsOmAnNwiIMYC/OirVPQ1Flzf4V3BsbTWJ7+NRgVEwzEXDasTrcjeVxPxZKPC55fwD/lCP/HtZEMOkNwqs7qMTtz9QIMtXd0UqpbjBzUv8XO/FWFB7NwGzOfUp4ulKqex8rMydYD36LfPsBPk5Kzb7Iuaub4PNpb1DqJUqHvzCVyZJ/IQLFIzixxi/cj3fxdlRVeXX0VDQyu3BSA8mfjoMZFyiEr5fwV6WA9wRejaB3aUT0gZCdxp54/YKv8Hm5xiGDA3gKzze4RV9UReajakXOXjzZgIf7osH+XqjBSu9q1TDjUNQOjSpmymEqCptTkljQdPI7M733XGIiAupjGMcf8doYbrs2e0DNHmbMpgGnRm3ORKyZiMJlZcSiLLbHwW7F4+06w/umDtmpaE2X4NzIQqNlDmlTJwwwN2NHjbLf4qLQ/HRYwY85/j2JNzuB/A9RBNWC5Ul/XsJ4jtw+xclt25PvzYyiqjUqk5m103Keu6BD5vYnKI6saymVH83pC3ZHvk6xNM3f7Uz+MH5S28zuu5z1HTk+vwCvR0fa1uSP4JZoog6GFtcoTlm3ZUj+WWaPLWEZWayo50EKLf7PjIfwRobIy3FdX+GXmp4YTS1NFDiu+KPInnqCTysxkrN2f42t6zLFWf2ZYU3r6iEO/wLZF8G68kmtxAAAAABJRU5ErkJggg==", "iVBORw0KGgoAAAANSUhEUgAAAD8AAAAkCAYAAAA+TuKHAAADfUlEQVR42u3aW4hVZRQH8N9xxkYzp1FjsOmhopSiiBIh7WIgBJVEN7IILAh6CDIMeurFInyoHroJ0UtQSFBTQROEKaX4FF2MkMwespIhHJMaYzRnbJwezhr42Ow9syfn3PD84bD3fOc739n/dV/rTGW473FnK+Y4i9Em3ybfJt8m3ybfgvgAf+GKZO1ajOF43gc6G/CQvbgZD2AFFhTsO4lteB1HpjlzDe6L+5twIK670YGJZiB/IzZjJRaV2P8ErsZWfF6w5xbsSv4+GtftQRzGG2n28/EaBnBrSeLQg7vRj1fQlXl/WRCv4Mkw72N4KCyqHy9gbqPIX4gt2IjF//OMRUHuW1yTrO8I4gPhHnNCQFuxB+vDMir1Jj8Xt+NrPDUL51VwFV4MrfbiktD2XdgZFvZWCOtHfIpVOJV7YI0amzV4BI/WSLAnQxhd4c//5rhEFkfxUgivJgHvDjyIDTV2pXnJfUcS2KbCBeH/v0cWmRXNXx6avg33N2H+P41fk/hzIgRRqPk7I9IORVCZxD3hP72Rrs7FDRF1mwHjoVk4H904jMti7YtQVKHZv4nH4qAR7A0f64mKaTwCTjNWhwexPO4HQonnJO93R3zIJf8R1kUw6QzCa1uoxJ2XqRFkqrvTU6W6noykzhT78V4UHvXARM59SnhsqvL2Y6zOSHAm+DPy7Sf4LCk1uyLnrq2Dz6fpcLKXmBT+gnRPlvyrESiexsKSX/gHPsT7UVXl1dGj0cgcwJIakr8YwxkXqISvT+Kf6YqcpRH0ro+I3h2CGsOheP2Gb/BlUeOQg014ucFxoT/K3sJUdxjP1+CLv6qxv1dKWOnDjRpmHIvaoVbFTBFGo6pbmsSCupPfn+m9ZxNDEVCfxSD+jte2cNsNWQHVe5gxkQacktocj1gzFIXL6ohFWewNwe7Cc5p0hvfdDPaORmu6GFdGFuovENJ2LTDA3IF9Jfd+j+tC82NhBT/n+PcI3m0F8j9FEVQGy6MTSzGYs++I6uS26cl3ZkZR0zUqI5m1i3Keu6JF5vbnqY6sy5TKz+T0BQcjX6foS/N3M5M/jl+Um9n9kLO+L8fn5+Pt6Eibmvwp3BtN1HBocZ3qlHV3huSJgjN2hmVksWomD1Jp8H9mbMI7GSJvxHXzFL/UdMRoqi9R4KDqjyKHWoX8maBLdVZ/aVjTxkiDpfEfgnHEk4ti+0AAAAAASUVORK5CYII="],
    ["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"],
    ["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"]
  ],

  // Frame i as a data: URL, in the calm or the hot colour. Cached per (i, hot).
  frameUrl: function (i, hot) {
    var R = lively.morphic.tools.ProcessCat, key = (hot ? "h" : "c") + i;
    R._urls = R._urls || {};
    return R._urls[key] || (R._urls[key] = "data:image/png;base64," + R.FRAME_PNG[i][hot ? 1 : 0]);
  },

  // How long one frame stays up at load `level` (0..1): slow at rest, quick at full
  // load, like the original desktop runner.
  frameMs: function (level) {
    var R = lively.morphic.tools.ProcessCat;
    return Math.round(R.SLOWEST_MS - (R.SLOWEST_MS - R.FASTEST_MS) * Math.max(0, Math.min(1, level)));
  },

  // The stepping scripts running on morphs in the world, most frequent first.
  // Each is {label, ms, morph}. This is the only enumeration of "background
  // processes" Lively has: scripts live on the morph that owns them (morph.scripts).
  // Stopped scripts are skipped. Walks every morph, so call it when the menu opens,
  // never on a timer.
  processes: function () {
    var out = [];
    if (typeof $world === "undefined" || !$world) return out;
    $world.withAllSubmorphsDo(function (m) {
      (m.scripts || []).forEach(function (s) {
        if (!s || s.stopped) return;
        var owner = m.name || (m.constructor && m.constructor.type) || "morph";
        out.push({ label: owner + "." + (s.selector || "script"), ms: s.tickTime || 0, morph: m });
      });
    });
    out.sort(function (x, y) { return (x.ms || 1e9) - (y.ms || 1e9); });
    return out;
  },

  describePressure: function () {
    var M = lively.morphic.tools.ProcessCat.Monitor;
    if (!M.pressureSupported) return "machine CPU: not reported by this browser";
    return "machine CPU pressure: " + (M.pressure || "waiting for first sample");
  },

  describeBusy: function () {
    var M = lively.morphic.tools.ProcessCat.Monitor;
    return "this page busy: " + Math.round(M.busyFraction() * 100) + "% (last " +
      Math.round(lively.morphic.tools.ProcessCat.BUSY_WINDOW_MS / 1000) + " s)";
  }
};

// The load signals. One shared instance (the bar can hold at most one cat, but a
// world may build the entry again), started the first time anything asks.
lively.morphic.tools.ProcessCat.Monitor = {

  started: false,
  pressure: null,            // last Compute Pressure state, or null
  pressureSupported: false,  // false until an observer is really observing
  longEntries: [],           // {t, d}: when a long frame/task ended and how long it was
  smoothed: 0,
  lastSmoothAt: 0,

  // Starts both observers. Safe to call many times. Every step is wrapped: a
  // browser without PressureObserver, or one where the permissions policy blocks
  // it, must leave the cat running on the page signal alone, not break the menu bar.
  start: function () {
    var M = lively.morphic.tools.ProcessCat.Monitor;
    if (M.started) return M;
    M.started = true;
    try {
      if (typeof PressureObserver !== "undefined") {
        var po = new PressureObserver(function (records) {
          var last = records[records.length - 1];
          if (last) M.pressure = last.state;
        });
        var p = po.observe("cpu", { sampleInterval: 1000 });
        M.pressureSupported = true;
        if (p && p.catch) p.catch(function () { M.pressureSupported = false; M.pressure = null; });
        M._pressureObserver = po;
      }
    } catch (e) { M.pressureSupported = false; }
    try {
      var types = PerformanceObserver.supportedEntryTypes || [];
      var type = types.indexOf("long-animation-frame") >= 0 ? "long-animation-frame"
               : types.indexOf("longtask") >= 0 ? "longtask" : null;
      if (type) {
        M._perfObserver = new PerformanceObserver(function (list) {
          list.getEntries().forEach(function (e) {
            M.longEntries.push({ t: e.startTime + e.duration, d: e.duration });
          });
          M._trim();
        });
        M._perfObserver.observe({ type: type, buffered: false });
      }
    } catch (e) {}
    return M;
  },

  _trim: function () {
    var M = lively.morphic.tools.ProcessCat.Monitor,
        from = performance.now() - lively.morphic.tools.ProcessCat.BUSY_WINDOW_MS;
    while (M.longEntries.length && M.longEntries[0].t < from) M.longEntries.shift();
  },

  // Share (0..1) of the recent window the main thread spent in long frames/tasks.
  busyFraction: function () {
    var M = lively.morphic.tools.ProcessCat.Monitor;
    M._trim();
    var sum = 0;
    M.longEntries.forEach(function (e) { sum += e.d; });
    return Math.min(1, sum / lively.morphic.tools.ProcessCat.BUSY_WINDOW_MS);
  },

  // The load level the cat reacts to (0..1): the larger of the machine's pressure
  // and the page's own load, eased over ~1.5 s so one short spike does not make
  // the cat jerk between speeds.
  level: function () {
    var R = lively.morphic.tools.ProcessCat, M = R.Monitor;
    M.start();
    var target = Math.max(
      M.pressure ? (R.PRESSURE_LEVEL[M.pressure] || 0) : 0,
      Math.min(1, M.busyFraction() * R.BUSY_GAIN));
    var now = performance.now(), dt = M.lastSmoothAt ? now - M.lastSmoothAt : 0;
    M.lastSmoothAt = now;
    M.smoothed += (target - M.smoothed) * (1 - Math.exp(-dt / 1500));
    return M.smoothed;
  }
};

// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

lively.BuildSpec('lively.morphic.tools.ProcessCatMenuBarEntry', lively.BuildSpec("lively.morphic.tools.MenuBarEntry").customize({

  name: "ProcessCatMenuBarEntry",
  menuBarAlign: "right",
  textString: "",
  // The base entry fills pink while its menu is open. The cat itself turns that
  // same pink under load, so it would vanish into the fill exactly when it matters.
  changeColorForMenu: false,

  style: lively.lang.obj.merge(lively.BuildSpec("lively.morphic.tools.MenuBarEntry").attributeStore.style, {
    extent: lively.pt(40, 24),
    padding: lively.rect(0, 0, 0, 0),
    toolTip: "Runs faster the busier this machine and this page are. Click for details."
  }),

  // The menu: what each signal says right now, then the stepping scripts. Built
  // when the menu opens, so the numbers are current.
  morphMenuItems: function morphMenuItems() {
    var R = lively.morphic.tools.ProcessCat, procs = R.processes();
    var items = [
      [R.describePressure(), function () {}],
      [R.describeBusy(), function () {}]
    ];
    var shown = procs.slice(0, R.MAX_PROCESSES_SHOWN).map(function (p) {
      var every = p.ms >= 1000 ? (Math.round(p.ms / 100) / 10) + " s" : p.ms + " ms";
      return [p.label + "  (every " + every + ")", function () { p.morph.show && p.morph.show(); }];
    });
    if (procs.length > shown.length) shown.push(["... and " + (procs.length - shown.length) + " more", function () {}]);
    if (!shown.length) shown.push(["none running", function () {}]);
    items.push(["background processes (" + procs.length + ")", shown]);
    return items;
  },

  update: function update() {},

  // One image per frame and colour, stacked at the same spot; only one is visible.
  // Built once. Images get no mouse handling of their own, so a click lands on
  // the entry (its menu), and no drag/grab flags (CLAUDE.md, "Disabling
  // drag/drop/grab on a morph needs three flags").
  buildCat: function buildCat() {
    var R = lively.morphic.tools.ProcessCat, self = this;
    this._frames = [];
    var x = Math.round((this.getExtent().x - R.CAT_W) / 2), y = Math.round((this.getExtent().y - R.CAT_H) / 2);
    [false, true].forEach(function (hot) {
      for (var i = 0; i < R.FRAMES; i++) {
        var img = new lively.morphic.Image(lively.rect(x, y, R.CAT_W, R.CAT_H), R.frameUrl(i, hot), false);
        img.eventsAreIgnored = true;
        img.draggingEnabled = false; img.droppingEnabled = false; img.grabbingEnabled = false;
        img.setVisible(false);
        self.addMorph(img);
        self._frames.push(img);
      }
    });
    this._frame = 0; this._hot = false; this._ms = R.SLOWEST_MS; this._shown = null;
  },

  // One step of the run: show the next frame, then re-time the stepping script if
  // the load moved enough to matter (restarting it every tick would be wasteful).
  tickCat: function tickCat() {
    var R = lively.morphic.tools.ProcessCat;
    if (!this._frames || !this._frames.length) return;
    var level = R.Monitor.level();
    this._hot = level >= R.HOT_LEVEL;
    this._frame = (this._frame + 1) % R.FRAMES;
    var next = this._frames[(this._hot ? R.FRAMES : 0) + this._frame];
    if (this._shown !== next) {
      this._shown && this._shown.setVisible(false);
      next.setVisible(true);
      this._shown = next;
    }
    var ms = R.frameMs(level);
    if (Math.abs(ms - this._ms) > this._ms * 0.15) {
      this._ms = ms;
      this.startStepping(ms, "tickCat");
    }
  },

  onLoad: function onLoad() {
    lively.morphic.tools.ProcessCat.Monitor.start();
    if (!this._frames) this.buildCat();
    this.startStepping(this._ms, "tickCat");
  },

  onFromBuildSpecCreated: function onFromBuildSpecCreated() {
    this.onLoad();
  }

}));

Object.extend(lively.morphic.tools.ProcessCatMenuBarEntry, {

  getMenuBarEntries: function() {
    return [lively.BuildSpec('lively.morphic.tools.ProcessCatMenuBarEntry').createMorph()];
  }
});

}); // end of module
