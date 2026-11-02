/**
 * lively.identity.GuestbookDialog
 *
 * "Sign the guestbook": a signed-in visitor writes a short entry on someone's homestar.
 * An entry is a comment on the profile object (POST /@h/<profileObjId>/comments, which
 * only accepts a signed-in author, keeps profile comments to 500 characters and refuses
 * someone the owner has blocked, or who has blocked the owner).
 *
 *   lively.identity.GuestbookDialog.open({
 *     handle,        // whose guestbook (shown in the title)
 *     objId,         // the profile object's id
 *     onPosted(),    // after the entry was stored
 *     onClose()
 *   });
 *
 * The text field is a native <textarea> inside the panel's own node (CLAUDE.md "Native
 * HTML dialogs/overlays"). Escape cancels; Ctrl/Cmd+Enter posts.
 */

module("lively.identity.GuestbookDialog")
  .requires("lively.morphic.Complete", "lively.identity.HomestarUI")
  .toRun(function () {

    var UI = lively.identity.HomestarUI;

    var W = 440;
    var PAD = 24;
    var AREA_H = 120;
    var MAX_LEN = 500;

    function viewportWidth() { return document.documentElement.clientWidth - 1; }

    function Dialog(opts) {
      this.opts = opts;
      this.draft = "";
      this.error = null;
      this.busy = false;
      this.scrim = null;
      this.panel = null;
      this._area = null;
    }

    Dialog.prototype.open = function () {
      var self = this;
      var scrim = this.scrim = UI.viewportScrim(function () { if (self.scrim) self.render(); });
      // Only a click outside the panel is the scrim's; the rest must reach the buttons.
      scrim.onMouseUp = function (evt) {
        if (!self.panel) return false;
        if (UI.pointOnPanel(self.panel, evt)) return false;
        evt.stop();
        self.close();
        return true;
      };
      this._onKey = function (e) {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        self.close();
      };
      document.addEventListener("keydown", this._onKey, true);
      this.render();
      return this;
    };

    Dialog.prototype.close = function () {
      if (!this.scrim) return;
      document.removeEventListener("keydown", this._onKey, true);
      UI.closeScrim(this.scrim);
      this.scrim = this.panel = this._area = null;
      if (this.opts.onClose) this.opts.onClose();
    };

    Dialog.prototype._post = function () {
      var self = this;
      if (this.busy) return;
      var text = String(this.draft || "").trim();
      if (!text) { this.error = "Write something first."; return this.render(); }
      this.busy = true;
      this.error = null;
      this.render();
      fetch("/@" + encodeURIComponent(this.opts.handle) + "/" + encodeURIComponent(this.opts.objId) + "/comments", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ body: text }),
      })
        .then(function (res) { return res.json().catch(function () { return {}; }).then(function (b) { return { status: res.status, body: b }; }); })
        .then(function (r) {
          if (r.status === 200) {
            self.close();
            if (self.opts.onPosted) self.opts.onPosted();
            return;
          }
          self.busy = false;
          self.error = r.status === 401 ? "Sign in to sign the guestbook."
            : r.status === 403 ? "You can't sign this guestbook."
            : (r.body && r.body.error) || "Could not post your entry.";
          if (self.scrim) self.render();
        })
        .catch(function (err) {
          self.busy = false;
          self.error = "Could not post your entry: " + ((err && err.message) || err);
          if (self.scrim) self.render();
        });
    };

    // The text field: a native textarea inside the panel's node, added once the panel is
    // in the world (it has no node before that). Its text lives in this.draft, so the
    // redraws on a state change (busy, an error) keep what was typed.
    Dialog.prototype._addArea = function (top) {
      var self = this;
      var node = this.panel.renderContext().shapeNode;
      var area = document.createElement("textarea");
      area.maxLength = MAX_LEN;
      area.value = this.draft;
      area.placeholder = "Say hello, leave a note…";
      area.setAttribute("aria-label", "Guestbook entry");
      area.disabled = this.busy;
      area.style.cssText = "position:absolute;left:" + PAD + "px;top:" + top + "px;width:" + (W - 2 * PAD) + "px;" +
        "height:" + AREA_H + "px;box-sizing:border-box;padding:10px 12px;font:13px/1.4 sans-serif;color:#2a2438;" +
        "border:1px solid #e8e6ec;border-radius:10px;outline:none;background:#fff;resize:none;user-select:text;";
      area.addEventListener("focus", function () { area.style.borderColor = "#CC0057"; });
      area.addEventListener("blur", function () { area.style.borderColor = "#e8e6ec"; });
      area.addEventListener("input", function () {
        self.draft = area.value;
        if (self._count) self._count.setTextString(area.value.length + " / " + MAX_LEN);
      });
      area.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); self.draft = area.value; self._post(); }
      });
      node.appendChild(area);
      this._area = area;
      return area;
    };

    Dialog.prototype.render = function () {
      var self = this;
      if (!this.scrim) return;      // closed while a request was still on its way
      if (this.panel) this.panel.remove();
      this._area = null;

      var panel = this.panel = new lively.morphic.Box(lively.rect(0, 0, W, 400));
      panel.applyStyle({ fill: Color.white, borderWidth: 1, borderColor: UI.CARD_BORDER, borderRadius: 16, clipMode: "hidden" });
      UI.noDrag(panel);

      var textW = W - 2 * PAD;
      var y = 20;
      panel.addMorph(UI.label(lively.rect(PAD, y, textW, 24), UI.trunc("Sign @" + this.opts.handle + "'s guestbook", 44), { px: 16, bold: true }));
      y += 28;
      panel.addMorph(UI.label(lively.rect(PAD, y, textW, 36),
        "Anyone who visits can read your entry. You can take it back later, and so can @" + UI.trunc(this.opts.handle, 24) + ".",
        { px: 11, color: UI.MUTED, wrap: true }));
      y += 44;
      var areaTop = y;
      y += AREA_H + 6;
      this._count = UI.label(lively.rect(W - PAD - 120, y, 120, 16), String(this.draft.length) + " / " + MAX_LEN, { px: 11, color: UI.MUTED, align: "right" });
      panel.addMorph(this._count);
      y += 22;

      if (this.error) {
        panel.addMorph(UI.label(lively.rect(PAD, y, textW, 20), this.error, { px: 12, color: UI.PINK, bold: true, wrap: true }));
        y += 26;
      }
      y += 4;

      var post = UI.pill(0, y, this.busy ? "Posting…" : "Post", {
        primary: true, w: 92, disabled: this.busy, onClick: function () { if (self._area) self.draft = self._area.value; self._post(); },
      });
      post.setPosition(lively.pt(W - PAD - 92, y));
      panel.addMorph(post);
      var cancel = UI.pill(0, y, "Cancel", { primary: false, w: 92, onClick: function () { self.close(); } });
      cancel.setPosition(lively.pt(W - PAD - 92 - 8 - 92, y));
      panel.addMorph(cancel);
      y += 30 + 22;

      // Sized and placed before it is added (CLAUDE.md: a setPosition right after addMorph
      // can desync the render tree). The scrim's origin is the top of the viewport.
      var vh = window.innerHeight, vw = viewportWidth();
      panel.setExtent(lively.pt(W, y));
      panel.setPosition(lively.pt(Math.round((vw - W) / 2), Math.max(16, Math.round((vh - y) / 2))));
      this.scrim.addMorph(panel);

      var area = this._addArea(areaTop);
      if (!this._focusedOnce) { this._focusedOnce = true; setTimeout(function () { area.focus(); }, 0); }
      else if (!this.busy) { setTimeout(function () { if (self._area === area) area.focus(); }, 0); }
    };

    lively.identity.GuestbookDialog = {
      MAX_LEN: MAX_LEN,
      open: function (opts) { return new Dialog(opts).open(); }
    };

  }); // end module('lively.identity.GuestbookDialog')
