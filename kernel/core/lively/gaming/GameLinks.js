/**
 * lively.gaming.GameLinks
 *
 * The browser's thin client for the server that links game-store accounts
 * (core/servers/GameLinkServer.js). No morphs, no credentials: the browser only ever asks
 * "which accounts are linked?" and "read my library now", and the server does the rest with
 * the credential it keeps. Nothing a store issued (a token, a key) ever reaches this file.
 *
 *   status(thenDo)         -> { providers, accounts }
 *   sync(platform, thenDo) -> { platform, fetched_at, total, partial, warnings, candidates }
 *
 * Both call thenDo(err, result). On failure `err` is an Error carrying a stable `code`, so a
 * caller picks the wording from the code and never from the server's raw text:
 *   signin         the person is not signed in
 *   not_linked     no account is linked for that store (or the server does not know the store)
 *   needs_reconnect the store refused the saved link (revoked or expired): link it again
 *   rate_limited   too soon after the last sync; `err.retryAfter` is the seconds to wait (or null)
 *   unavailable    this server is not set up to read that store (a missing key)
 *   upstream       the store did not answer, or answered something unusable
 *   network        the request never completed
 *   unknown        any other status
 * `err.status` is the HTTP status when there was one.
 *
 * Every request sends Accept: application/json (without it a route can answer with an HTML
 * page, which would make .json() throw) and the session cookie.
 *
 * Sync is a POST, and it is only ever sent because the owner pressed a button: some stores'
 * terms allow reading a person's data only when that person asks, so nothing here runs on a
 * timer or on page load.
 */

module("lively.gaming.GameLinks")
  .requires()
  .toRun(function () {

    var BASE = "/nodejs/GameLinkServer/";

    // Maps an HTTP status (and the server's error text, which is only used for `unavailable`
    // vs `needs_reconnect`, both of which arrive as 4xx/5xx with a code in the body) to a code.
    function codeFor(status, body) {
      if (body && typeof body.code === "string") return body.code;
      if (status === 401) return "signin";
      if (status === 404) return "not_linked";
      if (status === 429) return "rate_limited";
      if (status === 503) return "unavailable";
      if (status === 502 || status === 504) return "upstream";
      return "unknown";
    }

    function fail(code, status, body, text) {
      var e = new Error(text || code);
      e.code = code; e.status = status || null;
      e.retryAfter = body && isFinite(body.retry_after) ? Number(body.retry_after) : null;
      return e;
    }

    // Does one request and calls thenDo(err, json).
    function request(method, path, thenDo) {
      var opts = { method: method, credentials: "include", headers: { "Accept": "application/json" } };
      if (method !== "GET") opts.headers["Content-Type"] = "application/json";
      var f;
      try { f = fetch(BASE + path, opts); } catch (e) { return thenDo(fail("network", null, null, e.message)); }
      f.then(function (res) {
        return res.json().catch(function () { return null; }).then(function (body) {
          if (res.ok && body) return thenDo(null, body);
          // `res.ok` with no usable body is the server misbehaving, not success.
          var code = res.ok ? "upstream" : codeFor(res.status, body);
          thenDo(fail(code, res.status, body, body && body.error));
        });
      }, function (e) { thenDo(fail("network", null, null, e && e.message)); });
    }

    lively.gaming.GameLinks = {
      BASE: BASE,

      // Which stores this server offers and which of them the person has linked. The
      // accounts carry a display name and times, never a credential.
      status: function (thenDo) { request("GET", "status", thenDo); },

      // Reads the person's library from the linked store and returns IMPORT CANDIDATES (see
      // GamingImport). Nothing is stored by the server and nothing is written to the
      // library by this call: the preview and the writes are the caller's job.
      sync: function (platform, thenDo) {
        request("POST", encodeURIComponent(platform) + "/sync", function (err, body) {
          if (err) return thenDo(err);
          if (!Array.isArray(body.candidates)) return thenDo(fail("upstream", 200, null, "sync answered without a candidate list"));
          thenDo(null, {
            platform: body.platform || platform,
            fetched_at: body.fetched_at || new Date().toISOString(),
            total: body.total != null ? body.total : body.candidates.length,
            partial: !!body.partial,
            warnings: Array.isArray(body.warnings) ? body.warnings : [],
            candidates: body.candidates,
          });
        });
      },

      // The linked accounts of a status answer that can be synced from here: linked, and not
      // marked as needing a reconnect. Pure; kept here so the dialog and its test agree on it.
      syncable: function (statusBody) {
        return ((statusBody && statusBody.accounts) || []).filter(function (a) { return a.status === "active"; });
      },
    };
  }); // end module('lively.gaming.GameLinks')
