/**
 * lively.identity.PostcardEdits
 *
 * What changed in a postcard since a reader first got it. The server stamps an
 * edited card (core/servers/identity/EditTracking.js) and says where THIS reader's
 * diff starts (GET /@:handle/:objId/edit-baseline); everything here runs in the
 * reader's browser: it fetches the baseline version and the current one, opens each
 * (decrypting an encrypted card with the reader's own key, so the server never sees
 * the text), runs WikiDiff over the two documents and shows the result.
 *
 *   lively.identity.postcardEdits.baseline(handle, objId, thenDo)
 *       thenDo(err, { edited, baselineCid, currentCid, editedAt })
 *   lively.identity.postcardEdits.diff(handle, objId, thenDo)
 *       thenDo(err, null)                      nothing to compare (not edited)
 *       thenDo(err, { diff, baselineCid, currentCid, editedAt })
 *   lively.identity.postcardEdits.openDialog({ handle, objId, title, editedAt, onNoChange })
 *       a modal showing the diff; onNoChange() fires when the net change is empty
 *       (the owner changed something and changed it back), so the caller can drop
 *       the "Edited" marker.
 *
 * A reader who is no longer a recipient loses every version at once (the server
 * gates old versions on the card's CURRENT recipients), so the diff then simply
 * fails to load and the dialog says so.
 */

module("lively.identity.PostcardEdits")
  .requires(
    "lively.morphic.Complete",
    "lively.identity.HomestarUI",
    "lively.identity.PostCardSerializer",
    "lively.identity.PostCardUtils",
    "lively.identity.WikiDiff",
    "lively.identity.WikiHistory"
  )
  .toRun(function () {

    var UI = lively.identity.HomestarUI;

    var W = 680;
    var PAD = 24;
    var MAX_H = 560;

    function enc(s) { return encodeURIComponent(s); }

    // "3 days ago", "just now": coarse on purpose, it labels a pill.
    function agoLabel(iso, nowMs) {
      var t = Date.parse(iso);
      if (isNaN(t)) return "";
      var s = Math.max(0, Math.round(((nowMs === undefined ? Date.now() : nowMs) - t) / 1000));
      if (s < 60) return "just now";
      var m = Math.round(s / 60);
      if (m < 60) return m + (m === 1 ? " minute ago" : " minutes ago");
      var h = Math.round(m / 60);
      if (h < 24) return h + (h === 1 ? " hour ago" : " hours ago");
      var d = Math.round(h / 24);
      if (d < 30) return d + (d === 1 ? " day ago" : " days ago");
      var mo = Math.round(d / 30);
      if (mo < 12) return mo + (mo === 1 ? " month ago" : " months ago");
      var y = Math.round(mo / 12);
      return y + (y === 1 ? " year ago" : " years ago");
    }

    // thenDo(err, json|null, status). Accept must say JSON: GET /@handle/<objId>/...
    // answers a browser's default "*/*" with an HTML page (CLAUDE.md).
    function getJSON(url, thenDo) {
      fetch(url, { credentials: "include", headers: { Accept: "application/json" } })
        .then(function (res) {
          return res.text().then(function (text) {
            var json = null;
            try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
            thenDo(null, res.ok ? json : null, res.status);
          });
        })
        .catch(function (err) { thenDo(err, null, 0); });
    }

    function baseline(handle, objId, thenDo) {
      getJSON("/@" + enc(handle) + "/" + enc(objId) + "/edit-baseline", function (err, json, status) {
        if (err) return thenDo(err);
        if (!json) return thenDo(new Error("Could not read the edit history (" + status + ")"));
        thenDo(null, json);
      });
    }

    // The ProseMirror document of one stored version, as the reader sees it.
    // thenDo(err, doc).
    function versionDoc(handle, objId, cid, thenDo) {
      getJSON("/@" + enc(handle) + "/" + enc(objId) + "/at/" + enc(cid), function (err, env, status) {
        if (err) return thenDo(err);
        if (!env) {
          return thenDo(new Error(status === 403
            ? "You can no longer open earlier versions of this card"
            : "Could not load a version of this card (" + status + ")"));
        }
        var S = lively.identity.postCardSerializer;
        if (env.visibility === "public") {
          var p = env.record && env.record.payload;
          return thenDo(null, p && (p.format === "prosemirror-doc-v1" ? p.doc : p.snapshot) || null);
        }
        S.deserializeEncryptedAuto(env, function (decErr, mode, content) {
          if (decErr) return thenDo(decErr);
          if (mode === "plain") return thenDo(null, content);
          thenDo(null, S._extractSnapshot(content));
        });
      });
    }

    function diff(handle, objId, thenDo) {
      baseline(handle, objId, function (err, b) {
        if (err) return thenDo(err);
        if (!b.edited || !b.baselineCid) return thenDo(null, null);
        versionDoc(handle, objId, b.baselineCid, function (err1, oldDoc) {
          if (err1) return thenDo(err1);
          versionDoc(handle, objId, b.currentCid, function (err2, newDoc) {
            if (err2) return thenDo(err2);
            thenDo(null, {
              diff: lively.identity.wikiDiff.diffSnapshots(oldDoc, newDoc),
              baselineCid: b.baselineCid,
              currentCid: b.currentCid,
              editedAt: b.editedAt
            });
          });
        });
      });
    }

    // One px short of clientWidth: see AudienceDialog.viewportWidth.
    function viewportWidth() { return document.documentElement.clientWidth - 1; }

    // Mouse-wheel scrolling for an overflow:auto element nested in the morph chain
    // (same workaround WikiView and WikiHistory apply to their content divs).
    function wireWheel(node) {
      node.addEventListener("wheel", function (e) {
        node.scrollTop += e.deltaY;
        e.preventDefault();
      }, { passive: false });
    }

    function openDialog(opts) {
      lively.identity.WikiHistory.injectStyle();
      var closed = false;
      var vw = viewportWidth(), vh = window.innerHeight;
      var H = Math.min(MAX_H, Math.max(320, vh - 64));
      var scrim = new lively.morphic.Box(lively.rect(0, window.pageYOffset || 0, vw, vh));
      scrim.applyStyle({ fill: Color.rgba(30, 24, 44, 0.45), borderWidth: 0 });
      UI.noDrag(scrim);

      var panel = new lively.morphic.Box(lively.rect(Math.round((vw - W) / 2), Math.max(16, Math.round((vh - H) / 2)), W, H));
      panel.applyStyle({ fill: Color.white, borderWidth: 1, borderColor: UI.CARD_BORDER, borderRadius: 16, clipMode: "hidden" });
      UI.noDrag(panel);

      var sub = (opts.title ? UI.trunc(opts.title, 48) + " · " : "") +
        (opts.editedAt ? "edited " + agoLabel(opts.editedAt) : "");
      panel.addMorph(UI.label(lively.rect(PAD, 20, W - 2 * PAD, 24), "What changed since you first got it", { px: 16, bold: true }));
      panel.addMorph(UI.label(lively.rect(PAD, 48, W - 2 * PAD, 18), sub, { px: 12, color: UI.MUTED }));
      var statLine = UI.label(lively.rect(PAD, 70, W - 2 * PAD - 110, 18), "", { px: 12, color: UI.MUTED });
      panel.addMorph(statLine);

      var bodyTop = 98, bodyH = H - bodyTop - 66;
      var body = new lively.morphic.Box(lively.rect(PAD, bodyTop, W - 2 * PAD, bodyH));
      body.applyStyle({ fill: Color.white, borderWidth: 1, borderColor: UI.CARD_BORDER, borderRadius: 10, clipMode: "hidden" });
      UI.noDrag(body);
      panel.addMorph(body);

      function close() {
        if (closed) return;
        closed = true;
        scrim.remove();
      }
      var closeBtn = UI.pill(0, 0, "Close", { primary: true, w: 92, onClick: close });
      closeBtn.setPosition(lively.pt(W - PAD - 92, H - 50));
      panel.addMorph(closeBtn);

      // Capture-first dispatch: only a click outside the panel is the scrim's
      // (CLAUDE.md "A modal scrim must not claim clicks that land inside its panel").
      scrim.onMouseUp = function (evt) {
        if (panel.bounds().containsPoint(scrim.localize(evt.getPosition()))) return false;
        evt.stop();
        close();
        return true;
      };
      scrim.addMorph(panel);
      $world.addMorph(scrim);

      // The diff is HTML (WikiDiff.renderHtml), hosted in a scrolling div inside the
      // body morph's own node, the way the card's content is.
      var host = document.createElement("div");
      host.style.cssText = "position:absolute;left:0;top:0;right:0;bottom:0;overflow-y:auto;padding:12px 16px;" +
        "box-sizing:border-box;font:13px/1.5 sans-serif;color:#333;user-select:text;";
      host.className = "selectable";
      wireWheel(host);
      body.renderContext().shapeNode.appendChild(host);

      function say(text) {
        host.innerHTML = '<div class="wh-empty"></div>';
        host.firstChild.textContent = text;
      }
      say("Opening the card… this can take a moment the first time.");

      diff(opts.handle, opts.objId, function (err, result) {
        if (closed) return;
        if (err) return say(err.message || String(err));
        if (!result) return say("This card has not changed since you first got it.");
        if (!result.diff.changed) {
          say("No net change: it was edited and then put back the way it was.");
          if (opts.onNoChange) opts.onNoChange();
          return;
        }
        var u = lively.identity.postCardUtils;
        host.innerHTML = lively.identity.wikiDiff.renderHtml(result.diff, {
          renderNode: function (node) { return u.snapshotToHtml({ content: [node] }); }
        });
        host.addEventListener("click", function (e) {
          var t = e.target.closest && e.target.closest("[data-wh-toggle]");
          if (!t) return;
          var hidden = t.nextElementSibling;
          if (hidden) hidden.style.display = hidden.style.display === "none" ? "" : "none";
        });
        statLine.textString = result.diff.stats.added + " added, " + result.diff.stats.removed + " removed, " +
          result.diff.stats.modified + " edited";
      });
      return { close: close };
    }

    lively.identity.postcardEdits = {
      agoLabel: agoLabel,
      baseline: baseline,
      versionDoc: versionDoc,
      diff: diff,
      openDialog: openDialog
    };

  }); // end module('lively.identity.PostcardEdits')
