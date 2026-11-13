/**
 * lively.identity.LinkWarning
 *
 * The window shown before a link takes a person out of keo ("Leaving keo"). Any place that follows a link to the outside (a book, a PDF,
 * a message, text in a world) calls
 *
 *   lively.require("lively.identity.LinkWarning").toRun(function () {
 *     lively.identity.LinkWarning.go(address, { text: "the words the link was shown with", source: "where the link is" });
 *   });
 *
 * and never opens the address itself. go() asks the shell what the address says (bridge op link.check: nothing is fetched, only the
 * address is read), then either opens the page at once (the person said not to ask about that site) or shows this window with what was
 * found. Open sends the address back to the shell (link.open), which reads it again, refuses the kinds that are never opened and opens the
 * page in a new tab with no referrer. Cancel, the close button and Esc open nothing.
 *
 * What the window must say every time: keo checked the ADDRESS only. It cannot see what the page loads or whether the site is safe, so
 * "nothing unusual in the address" is never worded as "safe". It is a prompt, not a lock: this world can ask the shell for the same
 * open without showing it (shell/keo-links.js says so). It guards a person from the links in what they read.
 *
 * Built like MyFilesBrowser: a Box in a classic Window whose content is plain DOM (wrapped text, a list of findings and a short row of
 * buttons are far simpler there than as a tree of morphs). The frame is the passkey primer's pink; the main button is green.
 *
 * Not saved with a world: a window left open when a world is saved is closed when that world comes back.
 */

module("lively.identity.LinkWarning")
  .requires("lively.morphic.Complete")
  .toRun(function () {
    var NAME = "LinkWarning";
    var WIDTH = 440;                 // the window, with its frame

    function esc(s) {
      return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    }
    function ms(name) { return '<span class="lw-ms" aria-hidden="true">' + name + "</span>"; }

    function ensureStyle() {
      var ID = "link-warning-style";
      if (document.getElementById(ID)) return;
      var st = document.createElement("style");
      st.id = ID;
      st.textContent = [
        ".Window.linkwarn-chrome { background-color: rgb(255,16,144) !important; border-radius: 7px !important; border: none !important; }",
        ".Window.linkwarn-chrome.highlighted { border: none !important; box-shadow: 0px 3px 10px rgba(80,0,40,0.35) !important; }",
        ".Window.linkwarn-chrome .Text.window-title { color: #fff; }",
        ".Window.linkwarn-chrome.highlighted .Text.window-title { color: #fff; font-weight: bold; }",
        ".lw-root { position: absolute; left: 0; top: 0; width: 100%; box-sizing: border-box; background: #fafafa; border-radius: 0 0 5px 5px; color: #3c3c3c; padding: 12px 14px; display: grid; gap: 10px; font: 12px/1.45 Arial, Helvetica, sans-serif; }",
        ".lw-root *, .lw-root *::before, .lw-root *::after { box-sizing: border-box; }",
        ".lw-root [hidden] { display: none !important; }",
        ".lw-ms { font-family: 'Material Symbols Rounded'; font-weight: normal; font-style: normal; line-height: 1; letter-spacing: normal; text-transform: none; white-space: nowrap; user-select: none; display: inline-block; }",
        ".lw-head { display: flex; gap: 10px; align-items: flex-start; }",
        ".lw-head .lw-ms { font-size: 26px; color: rgb(255,16,144); flex: none; }",
        ".lw-head p { margin: 0; } .lw-head b { color: #222; }",
        ".lw-dest { background: #fff; border: 1px solid #dcdce2; border-radius: 6px; padding: 8px 10px; display: grid; gap: 4px; }",
        ".lw-host { font-size: 17px; color: #222; overflow-wrap: anywhere; line-height: 1.25; user-select: text; }",
        ".lw-host .lw-sub, .lw-host .lw-port { color: #8a8a96; } .lw-host b { font-weight: bold; }",
        ".lw-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 11px; color: #666; }",
        ".lw-chip { display: inline-flex; align-items: center; gap: 3px; border-radius: 10px; padding: 1px 7px 1px 4px; font-size: 11px; background: #eef0f3; color: #4a4a55; }",
        ".lw-chip .lw-ms { font-size: 13px; } .lw-chip.warn { background: #fff1d6; color: #8a4b00; }",
        ".lw-addr { font: 11px/1.4 Consolas, Menlo, monospace; color: #555; overflow-wrap: anywhere; max-height: 2.8em; overflow: hidden; user-select: text; }",
        ".lw-addr.open { max-height: none; }",
        ".lw-addr mark { background: #ffe2a8; color: #6b3a00; border-radius: 2px; padding: 0 1px; }",
        ".lw-addr .lw-ui { background: #fbd0d0; color: #8e1010; border-radius: 2px; padding: 0 1px; }",
        ".lw-tools { display: flex; gap: 14px; flex-wrap: wrap; }",
        ".lw-link { background: none; border: 0; color: #1a56c4; font: inherit; font-size: 11px; padding: 0; cursor: pointer; justify-self: start; text-decoration: underline; }",
        ".lw-summary { display: flex; align-items: center; gap: 6px; font-weight: bold; }",
        ".lw-summary .lw-ms { font-size: 18px; }",
        ".lw-summary.ok { color: #4a4a55; } .lw-summary.warn { color: #8a4b00; } .lw-summary.bad { color: #a31515; }",
        ".lw-finds { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }",
        ".lw-find { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 6px; border-radius: 6px; padding: 6px 8px; }",
        ".lw-find .lw-ms { font-size: 18px; } .lw-find b { color: #222; display: block; } .lw-find .lw-d { display: block; color: #555; overflow-wrap: anywhere; }",
        ".lw-find.warn { background: #fff7e6; border: 1px solid #f3d99b; } .lw-find.warn .lw-ms { color: #b45309; }",
        ".lw-find.bad { background: #fef2f2; border: 1px solid #f1b6b6; } .lw-find.bad .lw-ms { color: #b91c1c; }",
        ".lw-find.info { background: #f1f2f5; border: 1px solid #e0e2e8; } .lw-find.info .lw-ms { color: #666; }",
        ".lw-limits { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 6px; color: #5a5a66; font-size: 11px; border-top: 1px solid #e3e3e8; padding-top: 8px; }",
        ".lw-limits .lw-ms { font-size: 16px; color: #888; } .lw-limits p { margin: 0 0 3px; }",
        ".lw-trust { display: flex; align-items: center; gap: 6px; cursor: pointer; }",
        ".lw-trust input { width: 14px; height: 14px; margin: 0; accent-color: #2f9e5b; }",
        ".lw-src { font-size: 11px; color: #777; overflow-wrap: anywhere; }",
        ".lw-err { color: #a31515; background: #fef2f2; border: 1px solid #f1b6b6; border-radius: 6px; padding: 6px 8px; }",
        ".lw-btns { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; } .lw-btns .lw-sp { flex: 1; min-width: 4px; }",
        ".lw-b { font: inherit; font-size: 12px; border-radius: 4px; padding: 6px 12px; cursor: pointer; border: 1px solid #b9b9c4; background: #fff; color: #333; }",
        ".lw-b:hover { background: #f1f1f5; } .lw-b:focus-visible { outline: 2px solid rgb(255,16,144); outline-offset: 2px; }",
        ".lw-b.go { background: #2f9e5b; border-color: #2f9e5b; color: #fff; font-weight: bold; } .lw-b.go:hover { background: #278a4e; }",
        ".lw-b.ghost { border-color: transparent; background: transparent; color: #444; } .lw-b.ghost:hover { background: #ececf1; }",
        ".lw-b.risk { border-color: #d19a3a; color: #7a4300; background: #fffaf0; } .lw-b.risk:hover { background: #fff1d6; }",
        ".lw-sites { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }",
        ".lw-site { display: flex; align-items: center; justify-content: space-between; gap: 8px; background: #fff; border: 1px solid #dcdce2; border-radius: 6px; padding: 6px 10px; }",
        ".lw-site b { color: #222; overflow-wrap: anywhere; min-width: 0; }",
        ".lw-b[disabled] { opacity: .55; cursor: default; }"
      ].join("\n");
      document.head.appendChild(st);
    }

    function addressHtml(res) {
      var p = res.parts, out = esc(p.scheme + "://");
      if (p.userinfo) out += '<span class="lw-ui">' + escBreaking(p.userinfo + "@") + "</span>";
      out += escBreaking(p.hostSub + p.hostReg + (p.port ? ":" + p.port : "") + p.path);
      if (p.query.length) {
        out += "?<wbr>" + p.query.map(function (q) { return q.tracking ? "<mark>" + escBreaking(q.text) + "</mark>" : escBreaking(q.text); }).join("&amp;<wbr>");
      }
      return out + escBreaking(p.hash);
    }
    // A long address breaks after its separators, not in the middle of a word (the break hints add no text: what is copied is unchanged).
    function escBreaking(s) {
      return String(s).split(/([\/?&=.\-_])/).map(function (part) { return esc(part) + (/^[\/?&=.\-_]$/.test(part) ? "<wbr>" : ""); }).join("");
    }

    // What the window shows for an answer from the shell (res) and what the caller said about the link (opts). All text that came from
    // the link is escaped: an address is written by whoever made the page.
    function bodyHtml(res, opts, state) {
      var h = "";
      if (res.kind === "web") {
        var p = res.parts;
        h += '<div class="lw-head">' + ms("open_in_new") + "<p><b>This link goes to another website.</b><br>It opens in a new browser tab, outside keo. keo cannot see or control that page.</p></div>";
        h += '<div class="lw-dest"><div class="lw-host" data-el="host">' + (p.hostSub ? '<span class="lw-sub">' + esc(p.hostSub) + "</span>" : "") + "<b>" + esc(p.hostReg) + "</b>" + (p.port ? '<span class="lw-port">:' + esc(p.port) + "</span>" : "") + "</div>";
        h += '<div class="lw-meta"><span class="lw-chip' + (res.https ? "" : " warn") + '">' + ms(res.https ? "lock" : "lock_open") + (res.https ? "Encrypted" : "Not encrypted") + "</span>";
        if (p.path.length > 1) h += "<span>" + esc(p.path.length > 38 ? p.path.slice(0, 38) + "…" : p.path) + "</span>";
        h += "</div>";
        h += '<div class="lw-addr' + (state.expanded ? " open" : "") + '" data-el="addr">' + addressHtml(res) + "</div>";
        h += '<div class="lw-tools">' + (res.url.length > 70 ? '<button type="button" class="lw-link" data-act="more">' + (state.expanded ? "Show less" : "Show full address") + "</button>" : "") + '<button type="button" class="lw-link" data-act="copy">Copy address</button></div>';
        h += "</div>";
      } else if (res.kind === "mail") {
        h += '<div class="lw-head">' + ms("mail") + "<p><b>This link starts an email.</b><br>It opens the email program on this computer, outside keo, addressed to:</p></div>";
        h += '<div class="lw-dest"><div class="lw-host"><b>' + esc(res.mailTo) + '</b></div><div class="lw-meta"><span>Nothing is sent until you press send in your email program.</span></div><div class="lw-tools"><button type="button" class="lw-link" data-act="copy">Copy email address</button></div></div>';
      } else {
        h += '<div class="lw-head">' + ms("block") + "<p><b>keo will not open this link.</b></p></div>";
        h += '<div class="lw-dest"><div class="lw-addr open">' + esc(res.raw) + "</div></div>";
      }
      if (res.kind !== "mail") {
        var n = res.finds.filter(function (f) { return f.level !== "info"; }).length;
        var summary = res.worst === "ok" ? "Nothing unusual in the address" : res.kind === "blocked" ? "Why" : n + (n === 1 ? " thing" : " things") + " to know";
        h += '<div class="lw-summary ' + res.worst + '">' + ms(res.worst === "ok" ? "check_circle" : res.worst === "warn" ? "warning" : "error") + esc(summary) + "</div>";
        if (res.finds.length) {
          h += '<ul class="lw-finds">' + res.finds.map(function (f) {
            return '<li class="lw-find ' + esc(f.level) + '">' + ms(FIND_ICON[f.code] || "info") + '<div><b>' + esc(f.title) + '</b><span class="lw-d">' + esc(f.detail) + "</span></div></li>";
          }).join("") + "</ul>";
        }
      }
      if (res.kind === "web") {
        h += '<div class="lw-limits">' + ms("visibility_off") + "<div><p>keo checked the address only. It cannot see what the page loads, or whether the site is safe.</p><p>keo does not tell the site which document you came from.</p></div></div>";
        if (res.trustable) h += '<label class="lw-trust"><input type="checkbox" data-el="trust"> Don’t ask again for <b>' + esc(res.reg) + "</b></label>";
      }
      if (opts.source) h += '<div class="lw-src">Link in: ' + esc(String(opts.source).slice(0, 120)) + "</div>";
      if (state.error) h += '<div class="lw-err" role="alert">' + esc(state.error) + "</div>";
      h += '<div class="lw-btns">';
      var cancelLabel = res.kind === "blocked" ? "Close" : res.deceptive ? "Don’t open" : "Cancel";
      h += '<button type="button" class="lw-b ' + (res.deceptive ? "go" : "ghost") + '" data-act="cancel" data-el="cancel">' + cancelLabel + "</button>";
      h += '<span class="lw-sp"></span>';
      if (res.kind === "web") {
        if (res.cleaned) h += '<button type="button" class="lw-b" data-act="open">Open as written</button><button type="button" class="lw-b go" data-act="open-clean" data-el="primary">Open cleaned link</button>';
        else h += '<button type="button" class="lw-b ' + (res.deceptive ? "risk" : res.worst === "warn" ? "" : "go") + '" data-act="open" data-el="primary">' + (res.worst === "ok" ? "Open" : "Open anyway") + "</button>";
      } else if (res.kind === "mail") h += '<button type="button" class="lw-b go" data-act="open" data-el="primary">Open email program</button>';
      return h + "</div>";
    }

    // The icon for each kind of finding (the codes are keo-linkcheck.js's)
    var FIND_ICON = {
      blocked: "block", userinfo: "person_alert", lookalike: "spellcheck", ip: "dns", port: "settings_ethernet", http: "lock_open", shortener: "alt_route",
      "tracker-host": "radar", forwards: "alt_route", tracking: "ads_click", "text-mismatch": "compare_arrows", "long": "straighten"
    };

    lively.morphic.Box.subclass("lively.identity.LinkWarning",

      "serialization", {
        doNotSerialize: ["_root", "_res", "_opts", "_state"]
      },

      "initialization", {

        initialize: function ($super, bounds) {
          $super(bounds);
          this.setFill(null);          // the page inside paints its own background, with its own corners
          this.setDroppingEnabled(false);
          this._state = { expanded: false, error: "", busy: false };
          this._build();
        },

        // A saved world does not keep this window: it would offer to open an address nobody asked for.
        onrestore: function () {
          var self = this;
          setTimeout(function () { var w = self.getWindow && self.getWindow(); (w || self).remove(); }, 0);
        },

        _build: function () {
          ensureStyle();
          var node = this.renderContext().shapeNode;
          var root = document.createElement("div");
          root.className = "lw-root";
          node.appendChild(root);
          this._root = root;
          var self = this;
          root.addEventListener("click", function (e) { self._onClick(e); });
          // Esc closes it. A click inside leaves the focus on the morph's own wrapper, so the key is heard on the document and used only
          // while the focus is in this window (the same arrangement as the My files window).
          this._onKey = function (e) {
            if (!self.world()) { document.removeEventListener("keydown", self._onKey, true); return; }
            var win = self.getWindow && self.getWindow(), wn = win && win.renderContext().morphNode;
            if (!wn || !wn.contains(e.target)) return;
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); self._close(); }
          };
          document.addEventListener("keydown", this._onKey, true);
          // The window is as tall as what is drawn in it, and what is drawn changes size after it is first measured (the icon font arrives
          // late, text wraps differently once it is in its final box, "Show full address" opens), so it follows the content.
          if (window.ResizeObserver) {
            this._ro = new ResizeObserver(function () { self._fit(); });
            this._ro.observe(root);
          }
        },

        _fit: function () {
          var root = this._root;
          if (!root || !this.world()) return;
          var h = Math.ceil(root.getBoundingClientRect().height);
          if (!h || h === this._fitted) return;
          this._fitted = h;
          var win = this.getWindow && this.getWindow();
          // The window first: resizing it also resizes what it holds, so the content is set last, to exactly what was measured.
          if (win) win.setExtent(lively.pt(WIDTH, h + 25));
          this.setExtent(lively.pt(WIDTH - 6, h));
        }
      },

      "showing", {

        // Draw an answer, then size the window to what was drawn. `firstFocus`: the button that gets the focus (the safe one when the
        // address was found to be disguised, else the main one).
        show: function (res, opts) {
          this._res = res; this._opts = opts || {};
          this._draw();
        },

        _draw: function () {
          var res = this._res, root = this._root;
          root.innerHTML = bodyHtml(res, this._opts, this._state);
          // what the window is called says what it is for: leaving keo, starting an email, or a link that is not opened at all
          var win0 = this.getWindow && this.getWindow();
          if (win0 && win0.setTitle) win0.setTitle(res.kind === "mail" ? "Open your email program" : res.kind === "blocked" ? "Link blocked" : "Leaving keo");
          this._fitted = 0;
          this._fit();
          var want = root.querySelector(res.deceptive || res.kind === "blocked" ? '[data-el="cancel"]' : '[data-el="primary"]') || root.querySelector('[data-el="cancel"]');
          if (want && !this._state.busy) { try { want.focus({ preventScroll: true }); } catch (e) { /* the window still works with the mouse */ } }
        }
      },

      "events", {

        _onClick: function (e) {
          var b = e.target.closest ? e.target.closest("[data-act]") : null;
          if (!b || b.disabled) return;
          var act = b.getAttribute("data-act");
          if (act === "more") { this._state.expanded = !this._state.expanded; this._draw(); return; }
          if (act === "cancel") return this._close();
          if (act === "copy") return this._copy(b);
          if (act === "open" || act === "open-clean") return this._open(act === "open-clean");
        },

        _close: function () {
          var win = this.getWindow && this.getWindow();
          (win || this).remove();
        },

        _copy: function (btn) {
          var text = this._res.kind === "mail" ? this._res.mailTo : this._res.url || this._res.raw;
          function done(ok) { btn.textContent = ok ? "Copied" : "Copy not available here"; }
          // the world's frame may not be allowed the clipboard API: fall back to a selected field and the copy command, which a click allows
          function legacy() {
            var t = document.createElement("textarea");
            t.value = text; t.style.cssText = "position:fixed;left:-1000px;top:0;opacity:0";
            document.body.appendChild(t); t.select();
            var ok = false;
            try { ok = document.execCommand("copy"); } catch (x) { ok = false; }
            document.body.removeChild(t);
            done(ok);
          }
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done(true); }, legacy);
            else legacy();
          } catch (e) { legacy(); }
        },

        _open: function (clean) {
          var self = this, res = this._res, st = this._state;
          if (st.busy) return;
          var trust = !!(this._root.querySelector('[data-el="trust"]') && this._root.querySelector('[data-el="trust"]').checked);
          st.busy = true; st.error = "";
          Array.prototype.forEach.call(this._root.querySelectorAll("button"), function (b) { b.disabled = true; });
          lively.identity.LinkWarning.ask("link.open", { url: res.raw && res.url ? res.url : res.raw, text: this._opts.text, clean: clean, trust: trust }).then(function () {
            st.busy = false;
            if (self.world()) self._close();
          }, function (err) {
            st.busy = false; st.error = "keo could not open it: " + (err && err.message || err);
            if (self.world()) self._draw();
          });
        }
      });

    // ── class-side entry points ──────────────────────────────────────────────────────────────────────────────────────────────
    // The sites a person said not to be warned about ("Don't ask again for ..."), with a way to take each back. Opened from the Identity menu.
    // The list lives in the shell (bridge ops link.trusted, link.untrust); this window only shows it and asks for a removal.
    lively.morphic.Box.subclass("lively.identity.TrustedSitesView",

      "serialization", {
        doNotSerialize: ["_root", "_sites", "_error"]
      },

      "initialization", {
        initialize: function ($super, bounds) {
          $super(bounds);
          this.setFill(null);
          this._sites = null;       // null while it is being read
          this._error = "";
          ensureStyle();
          var root = document.createElement("div");
          root.className = "lw-root";
          this.renderContext().shapeNode.appendChild(root);
          this._root = root;
          var self = this;
          root.addEventListener("click", function (e) {
            var b = e.target.closest ? e.target.closest("[data-site]") : null;
            if (b && !b.disabled) self._remove(b.getAttribute("data-site"));
            else if (e.target.closest && e.target.closest("[data-act=close]")) self._close();
          });
          if (window.ResizeObserver) { this._ro = new ResizeObserver(function () { self._fit(); }); this._ro.observe(root); }
          this._draw();
          this.load();
        },

        // A saved world does not keep this window.
        onrestore: function () {
          var self = this;
          setTimeout(function () { var w = self.getWindow && self.getWindow(); (w || self).remove(); }, 0);
        }
      },

      "showing", {
        load: function () {
          var self = this;
          lively.identity.LinkWarning.ask("link.trusted", {}).then(function (list) { self._sites = list || []; self._error = ""; self._draw(); },
            function (err) { self._sites = []; self._error = "keo could not read the list: " + (err && err.message || err); self._draw(); });
        },

        _draw: function () {
          var h = '<div class="lw-head">' + ms("verified_user") + "<p><b>Sites you trust</b><br>A link to one of these sites opens without the warning. A link with anything unusual in its address still asks.</p></div>";
          if (this._sites === null) h += '<div class="lw-src">Reading the list …</div>';
          else if (!this._sites.length) h += '<div class="lw-dest"><div class="lw-src">No sites yet. Tick “Don’t ask again” in a link warning to add one.</div></div>';
          else h += '<ul class="lw-sites">' + this._sites.map(function (s) {
            return '<li class="lw-site"><b>' + esc(s) + '</b><button type="button" class="lw-b" data-site="' + esc(s) + '">Remove</button></li>';
          }).join("") + "</ul>";
          if (this._error) h += '<div class="lw-err" role="alert">' + esc(this._error) + "</div>";
          h += '<div class="lw-btns"><span class="lw-sp"></span><button type="button" class="lw-b go" data-act="close">Done</button></div>';
          this._root.innerHTML = h;
          this._fitted = 0;
          this._fit();
        },

        _fit: function () {
          var root = this._root;
          if (!root || !this.world()) return;
          var h = Math.ceil(root.getBoundingClientRect().height);
          if (!h || h === this._fitted) return;
          this._fitted = h;
          var win = this.getWindow && this.getWindow();
          if (win) win.setExtent(lively.pt(WIDTH, h + 25));
          this.setExtent(lively.pt(WIDTH - 6, h));
        }
      },

      "events", {
        _remove: function (site) {
          var self = this;
          lively.identity.LinkWarning.ask("link.untrust", { site: site }).then(function (list) { self._sites = list || []; self._error = ""; self._draw(); },
            function (err) { self._error = "keo could not take it back: " + (err && err.message || err); self._draw(); });
        },
        _close: function () { var win = this.getWindow && this.getWindow(); (win || this).remove(); }
      });

    // ── class-side entry points ──────────────────────────────────────────────────────────────────────────────────────────────
    Object.extend(lively.identity.LinkWarning, {
      WINDOW_NAME: NAME,

      // The list of trusted sites, in one window found by name.
      openTrusted: function () {
        var TNAME = "TrustedSites";
        var open = $world.submorphs.filter(function (m) { return m.name === TNAME; })[0];
        if (open) { open.comeForward(); var v = open.targetMorph || open.get("trustedSitesContent"); if (v && v.load) v.load(); return open; }
        ensureStyle();
        var vis = lively.morphic.World.current().visibleBounds();
        var view = new lively.identity.TrustedSitesView(lively.rect(0, 0, WIDTH - 6, 200));
        view.setName("trustedSitesContent");
        view.openInWindow({ title: "Trusted sites", pos: vis.center().subPt(lively.pt(WIDTH / 2, 120)) });
        var win = view.getWindow();
        win.setName(TNAME);
        win.addStyleClassName("linkwarn-chrome");
        win.comeForward();
        return win;
      },

      // The shell, through the bridge. Resolves its answer or rejects with its error.
      ask: function (op, args) {
        if (!window.keo || typeof window.keo.call !== "function") return Promise.reject(new Error("keo's shell is not reachable here."));
        return window.keo.call(op, args, 30000);
      },

      // The one way to follow a link out of keo. `address`: the link as written. opts: { text, source }.
      go: function (address, opts) {
        opts = opts || {};
        var LW = lively.identity.LinkWarning;
        if (!window.keo || typeof window.keo.call !== "function") {
          // not keo (the kernel on its own): no shell to ask, so the link opens the way it always did
          try { window.open(String(address), "_blank", "noopener,noreferrer"); } catch (e) { /* nothing to do */ }
          return Promise.resolve(null);
        }
        return LW.ask("link.check", { url: String(address), text: opts.text }).then(function (res) {
          if (res.skip) {
            return LW.ask("link.open", { url: res.url, text: opts.text }).then(function () { return null; }, function (err) { $world.inform("keo could not open the link: " + (err && err.message || err)); return null; });
          }
          return LW.show(res, opts);
        }, function (err) {
          $world.inform("keo could not check the link: " + (err && err.message || err));
          return null;
        });
      },

      // One window at a time, found by name: a second link shown while one is up replaces what the first showed.
      show: function (res, opts) {
        var open = $world.submorphs.filter(function (m) { return m.name === NAME; })[0];
        var view;
        if (open) {
          view = open.targetMorph || open.get("linkWarningContent");
          if (view && view.show) { view._state = { expanded: false, error: "", busy: false }; view.show(res, opts); open.comeForward(); return open; }
          open.remove();
        }
        ensureStyle();
        var vis = lively.morphic.World.current().visibleBounds();
        view = new lively.identity.LinkWarning(lively.rect(0, 0, WIDTH - 6, 300));
        view.setName("linkWarningContent");
        view.openInWindow({ title: "Leaving keo", pos: vis.center().subPt(lively.pt(WIDTH / 2, 160)) });
        var win = view.getWindow();
        win.setName(NAME);
        win.addStyleClassName("linkwarn-chrome");
        win.setZIndex && win.setZIndex(1000);
        view.show(res, opts);
        win.comeForward();
        // centred on what was drawn, now that its height is known
        win.setPosition(vis.center().subPt(lively.pt(WIDTH / 2, win.getExtent().y / 2)));
        return win;
      }
    });
  });
