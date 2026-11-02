/**
 * lively.gaming.GamingImport
 *
 * The pure logic behind importing a game library from a linked account. No morphs, no
 * network, no crypto: everything here takes plain data and returns plain data, so it is
 * unit-tested in node (tests/server/gaming-import.test.js) and the dialog that uses it
 * (lively.gaming.GameImportDialog) stays thin.
 *
 * THE SHAPE OF AN IMPORT. The server never stores anyone's library. When the owner
 * presses Sync it reads the linked account and returns CANDIDATES (plain, not stored):
 *
 *   candidate = { platform: 'steam'|'itch', external_id, name, cover_url|null,
 *                 playtime_minutes|null, last_played_at|null, url|null }
 *
 * The browser compares the candidates with the entries already in the library (which it
 * has decrypted) and shows a preview. Only after the owner confirms does anything get
 * written, as ordinary encrypted library entries, one per game. That is why "private
 * until the owner shares it" and "preview, then confirm" need no extra machinery.
 *
 * WHY THE DE-DUPE KEY IS external_ids.<platform>. A game's title can change or collide
 * (two different games called the same thing); the store's own id for it does not. Every
 * imported entry records { steam: "570" } or { itch: "341190" } in `external_ids`, and a
 * candidate matches an entry when that key is equal. A game the person added BY HAND has
 * no such key, so it is not matched: importing the same game again offers it as new
 * rather than silently merging it with something the person typed in. (If that proves
 * annoying, the place to change it is plan(), here, and nowhere else.)
 *
 * Public entry points:
 *   plan(candidates, entries, opts)      what is new, what to refresh, what is unchanged
 *   suggestStatus(candidate, nowMs)      the shelf an imported game starts on
 *   fieldsOf(candidate, syncedAt, nowMs) the payload fields for a NEW entry
 *   refreshChanges(payload, candidate, syncedAt)  the patch for an EXISTING entry, or null
 *   runWrites(jobs, opts, done)          a small concurrency-limited write queue
 *   platformLabel(platform)              "Steam" / "itch.io"
 */

module("lively.gaming.GamingImport")
  .requires()
  .toRun(function () {

    // A game played within this many days starts on "Playing"; everything else on
    // "Backlog". There is deliberately no rule that guesses "Completed": hours played say
    // nothing about whether a game was finished, and a wrong guess is worse than none.
    var RECENT_DAYS = 14;
    var DAY_MS = 24 * 60 * 60 * 1000;

    // Writes in flight at once. Measured: 4 parallel signed writes gave 57 to 69 entries
    // a second with no errors or throttling (see the spike log), so 4 is the default.
    var DEFAULT_CONCURRENCY = 4;

    var LABELS = { steam: "Steam", itch: "itch.io" };

    lively.gaming.GamingImport = {

      RECENT_DAYS: RECENT_DAYS,
      DEFAULT_CONCURRENCY: DEFAULT_CONCURRENCY,

      // The name a person knows the store by. Unknown ids come back unchanged.
      platformLabel: function (platform) { return LABELS[platform] || String(platform); },

      // ─── choosing the starting shelf ─────────────────────────────────────

      // The shelf a NEW imported game starts on: 'playing' when it was played in the last
      // RECENT_DAYS days, otherwise 'backlog' (including when playtime or the last-played
      // time is unknown, which is always the case for stores that give no playtime).
      // Never returns 'completed' (see the constant above). `nowMs` is injectable so a test
      // does not depend on the clock; callers pass Date.now().
      suggestStatus: function (candidate, nowMs) {
        if (!candidate || !candidate.last_played_at) return "backlog";
        var t = Date.parse(candidate.last_played_at);
        if (!isFinite(t)) return "backlog";
        return (nowMs - t) <= RECENT_DAYS * DAY_MS && t <= nowMs + DAY_MS ? "playing" : "backlog";
      },

      // ─── turning a candidate into entry data ─────────────────────────────

      // The payload fields for a NEW entry made from `candidate` (merged over GameLog's
      // defaults by GameLog.create). Imported facts are filled in; everything personal is
      // left at its default so the owner starts from a clean slate:
      //   status    the suggestion above (the owner can change it any time)
      //   rating    0 (not rated), review '' (none)
      //   playtime  only the store's own number goes in playtime_minutes/playtime_source;
      //             `manual_playtime_minutes` stays empty for the owner to fill in
      // `syncedAt` is the ISO time the candidates were fetched; it becomes last_synced_at.
      // A store that gives no playtime (null) leaves playtime_source null too: playtime is
      // never shown without a source, and a missing number has none.
      fieldsOf: function (candidate, syncedAt, nowMs) {
        var ids = {}; ids[candidate.platform] = String(candidate.external_id);
        var hasPlaytime = candidate.playtime_minutes != null && isFinite(candidate.playtime_minutes);
        return {
          title: String(candidate.name).trim(),
          cover_url: candidate.cover_url || null,
          cover_source: candidate.cover_url ? candidate.platform : null,
          external_ids: ids,
          platforms: [lively.gaming.GamingImport.platformLabel(candidate.platform)],
          status: lively.gaming.GamingImport.suggestStatus(candidate, nowMs),
          playtime_minutes: hasPlaytime ? Math.max(0, Math.round(candidate.playtime_minutes)) : null,
          playtime_source: hasPlaytime ? candidate.platform : null,
          last_synced_at: syncedAt || null,
          last_played_at: candidate.last_played_at || null,
          last_activity: { kind: "added", at: new Date(nowMs).toISOString() },
        };
      },

      // The patch to apply to an EXISTING entry when a sync brings fresher imported facts,
      // or null when nothing it would change differs. Only the store's own facts are
      // touched: playtime, its source, last-played and the sync time. Status, rating,
      // review, visibility and the owner's own typed playtime are NEVER in the patch.
      //
      // Why null when nothing differs, instead of always stamping a new sync time: every
      // write is a signed, encrypted version of the entry (about 55 ms each), and a sync
      // that rewrote thousands of unchanged entries just to move a timestamp would cost
      // minutes for no visible change. The account-level "last synced" time (kept by the
      // server) says when a sync last ran; an entry's own last_synced_at says when its
      // imported facts last CHANGED.
      refreshChanges: function (payload, candidate, syncedAt) {
        var ch = {}, any = false;
        var hasPlaytime = candidate.playtime_minutes != null && isFinite(candidate.playtime_minutes);
        if (hasPlaytime) {
          var mins = Math.max(0, Math.round(candidate.playtime_minutes));
          if (payload.playtime_minutes !== mins || payload.playtime_source !== candidate.platform) {
            ch.playtime_minutes = mins; ch.playtime_source = candidate.platform; any = true;
          }
        }
        if (candidate.last_played_at && payload.last_played_at !== candidate.last_played_at) {
          ch.last_played_at = candidate.last_played_at; any = true;
        }
        if (any) ch.last_synced_at = syncedAt || null;
        return any ? ch : null;
      },

      // ─── comparing a sync with the library ───────────────────────────────

      // Sorts candidates into what the preview shows. Inputs:
      //   candidates  the list a sync returned (see the header)
      //   entries     the library's entries ({ payload, ... }); deleted ones are not in it
      //   opts        { syncedAt, nowMs }
      // Returns:
      //   fresh      candidates with no matching entry: these are the ones offered for import
      //   refresh    [{ entry, candidate, changes }] existing entries whose imported facts
      //              changed (applied together with the import, never on their own)
      //   unchanged  how many matched entries needed nothing
      //   skipped    candidates unusable as entries (no id or no name)
      //   total      candidates received, before any filtering
      // A candidate repeated in the list (a store can list one game twice, e.g. two keys)
      // is counted once; the first occurrence wins, except that a later one with a playtime
      // number replaces an earlier one without.
      plan: function (candidates, entries, opts) {
        opts = opts || {};
        var seen = {}, order = [], skipped = 0;
        (candidates || []).forEach(function (c) {
          if (!c || c.external_id == null || String(c.external_id) === "" || !String(c.name || "").trim() || !c.platform) { skipped++; return; }
          var key = c.platform + ":" + c.external_id;
          if (seen[key] == null) { seen[key] = order.length; order.push(c); }
          else if (order[seen[key]].playtime_minutes == null && c.playtime_minutes != null) order[seen[key]] = c;
        });

        var index = {};
        (entries || []).forEach(function (e) {
          var ids = (e.payload && e.payload.external_ids) || {};
          Object.keys(ids).forEach(function (p) { index[p + ":" + ids[p]] = e; });
        });

        var fresh = [], refresh = [], unchanged = 0;
        order.forEach(function (c) {
          var hit = index[c.platform + ":" + c.external_id];
          if (!hit) { fresh.push(c); return; }
          var ch = lively.gaming.GamingImport.refreshChanges(hit.payload, c, opts.syncedAt);
          if (ch) refresh.push({ entry: hit, candidate: c, changes: ch }); else unchanged++;
        });
        return { fresh: fresh, refresh: refresh, unchanged: unchanged, skipped: skipped, total: (candidates || []).length };
      },

      // ─── writing ─────────────────────────────────────────────────────────

      // Runs `jobs` through `opts.write`, at most `opts.concurrency` at a time, and calls
      // done(summary) once every job has finished (or the run was stopped and the writes
      // already started have settled). It does not know what a job is: that is what makes
      // it reusable for both kinds of write (create, refresh) and testable with a stub.
      //   opts.write(job, cb)       does one write; cb(err) when it has settled
      //   opts.shouldSkip(job)      optional; asked right BEFORE each write starts. True means
      //                             "already done by something else" (a double click, or a
      //                             second import of the same account): the job is counted as
      //                             skipped and never written. This is the write-time
      //                             re-check that makes a retry idempotent.
      //   opts.onProgress(n, total) optional; n jobs have finished (written, skipped or failed)
      //   opts.isCancelled()        optional; checked before each start. Once true no new
      //                             write begins; summary.cancelled is set.
      //   opts.concurrency          defaults to DEFAULT_CONCURRENCY
      // summary = { written, skipped, failed: [{ job, error }], cancelled }
      // One job failing does not stop the others; it is listed in `failed` so the caller
      // can say how many did not make it, and a second import run picks them up again.
      // A write function that throws, or calls its callback twice, is handled (a throw
      // counts as a failure; the second callback is ignored).
      runWrites: function (jobs, opts, done) {
        var total = jobs.length, next = 0, running = 0, finished = 0, ended = false, pumping = false;
        var limit = Math.max(1, opts.concurrency || DEFAULT_CONCURRENCY);
        var summary = { written: 0, skipped: 0, failed: [], cancelled: false };

        function tick() { finished++; if (opts.onProgress) opts.onProgress(finished, total); }
        function finish() { if (ended) return; ended = true; done(summary); }

        // Starts as many jobs as the limit allows. A write that calls back synchronously
        // re-enters pump(); the `pumping` guard turns that into a loop iteration instead of
        // recursion (a few thousand synchronous callbacks would otherwise overflow the stack).
        function pump() {
          if (pumping) return;
          pumping = true;
          while (running < limit && next < total) {
            if (opts.isCancelled && opts.isCancelled()) { summary.cancelled = true; next = total; break; }
            var job = jobs[next++];
            if (opts.shouldSkip && opts.shouldSkip(job)) { summary.skipped++; tick(); continue; }
            running++;
            start(job);
          }
          pumping = false;
          if (running === 0 && next >= total) finish();
        }

        function start(job) {
          var called = false;
          function settle(err) {
            if (called) return;
            called = true;
            running--;
            if (err) summary.failed.push({ job: job, error: err }); else summary.written++;
            tick();
            pump();
          }
          try { opts.write(job, settle); } catch (e) { settle(e); }
        }

        pump();
      },
    };
  }); // end module('lively.gaming.GamingImport')
