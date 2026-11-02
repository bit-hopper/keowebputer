/**
 * lively.identity.VersionViewer
 *
 * Version history browser for identity-backed worlds, modeled after
 * lively.wiki.VersionViewer. Auto-populates from the current URL on open.
 *
 * Visit  — opens the snapshot at the selected CID in a new tab.
 * Revert — rolls history back to the selected CID (destructive: deletes newer versions).
 * Diff   — compares two shift-selected versions via GET /@handle/:objId/diff.
 */

module("lively.identity.VersionViewer")
  .requires(
    "lively.persistence.BuildSpec",
    "lively.morphic.Complete",
  )
  .toRun(function () {

    lively.BuildSpec("lively.identity.VersionViewer", {
      _Extent: lively.pt(460.0, 240.0),
      className: "lively.morphic.Window",
      contentOffset: lively.pt(3, 22),
      draggingEnabled: true,
      layout: { adjustForNewBounds: true },
      name: "lively.identity.VersionViewer",
      submorphs: [
        {
          _BorderColor: Color.rgb(95, 94, 95),
          _BorderWidth: 1,
          _Extent: lively.pt(454.0, 215.0),
          _Fill: Color.rgb(255, 255, 255),
          _Position: lively.pt(3.0, 22.0),
          _path: null,
          _currentHandle: null,
          _currentObjId: null,
          className: "lively.morphic.Box",
          droppingEnabled: true,
          isCopyMorphRef: true,
          layout: {
            adjustForNewBounds: true,
            borderSize: 4.185,
            extentWithoutPlaceholder: lively.pt(454.0, 215.0),
            resizeHeight: true,
            resizeWidth: true,
            spacing: 2.65,
            type: "lively.morphic.Layout.VerticalLayout",
          },
          morphRefId: 1,
          name: "VersionViewer",
          sourceModule: "lively.morphic.Core",
          submorphs: [
            {
              _ClipMode: "hidden",
              _Extent: lively.pt(445.0, 19.0),
              _FontFamily: "Arial, sans-serif",
              _HandStyle: null,
              _InputAllowed: true,
              _MaxTextWidth: 300,
              _MinTextWidth: 300,
              _Padding: lively.rect(5, 5, 0, 0),
              _Position: lively.pt(4.2, 4.2),
              allowInput: true,
              className: "lively.morphic.Text",
              fixedHeight: true,
              isInputLine: true,
              layout: { resizeHeight: false, resizeWidth: true },
              name: "pathText",
              sourceModule: "lively.morphic.TextCore",
              connectionRebuilder: function connectionRebuilder() {
                lively.bindings.connect(this, "savedTextString", this.get("VersionViewer"), "setPath", {});
              },
            },
            {
              _ClipMode: { x: "hidden", y: "scroll" },
              _Extent: lively.pt(445.0, 150.0),
              _Fill: Color.rgb(243, 243, 243),
              _Position: lively.pt(4.2, 25.8),
              isMultipleSelectionList: true,
              multipleSelectionMode: "multiSelectWithShift",
              className: "lively.morphic.List",
              droppingEnabled: true,
              itemMorphs: [],
              layout: {
                adjustForNewBounds: true,
                extent: lively.pt(445.0, 150.0),
                listItemHeight: 19,
                maxExtent: lively.pt(445.0, 150.0),
                maxListItems: 8,
                noOfCandidatesShown: 1,
                padding: 0,
                resizeHeight: true,
                resizeWidth: true,
              },
              name: "VersionList",
              sourceModule: "lively.morphic.Lists",
              submorphs: [],
            },
            {
              _Extent: lively.pt(445.0, 29.0),
              _Fill: Color.rgb(255, 255, 255),
              _Position: lively.pt(4.2, 180.0),
              className: "lively.morphic.Box",
              droppingEnabled: true,
              layout: {
                borderSize: 3.975,
                extentWithoutPlaceholder: lively.pt(445.0, 29.0),
                resizeHeight: false,
                resizeWidth: true,
                spacing: 4.25,
                type: "lively.morphic.Layout.HorizontalLayout",
              },
              name: "Rectangle",
              sourceModule: "lively.morphic.Core",
              submorphs: [
                {
                  _BorderColor: Color.rgb(189, 190, 192),
                  _BorderRadius: 5,
                  _BorderWidth: 1,
                  _Extent: lively.pt(145.0, 21.0),
                  _Position: lively.pt(4.0, 4.0),
                  className: "lively.morphic.Button",
                  isPressed: false,
                  label: "Visit",
                  layout: { resizeWidth: true },
                  name: "VisitButton",
                  sourceModule: "lively.morphic.Widgets",
                  connectionRebuilder: function connectionRebuilder() {
                    lively.bindings.connect(this, "fire", this.get("VersionViewer"), "visitVersion", {});
                  },
                },
                {
                  _BorderColor: Color.rgb(189, 190, 192),
                  _BorderRadius: 5,
                  _BorderWidth: 1,
                  _Extent: lively.pt(145.0, 21.0),
                  _Position: lively.pt(4.0, 4.0),
                  className: "lively.morphic.Button",
                  isPressed: false,
                  label: "Revert",
                  layout: { resizeWidth: true },
                  name: "RevertButton",
                  sourceModule: "lively.morphic.Widgets",
                  connectionRebuilder: function connectionRebuilder() {
                    lively.bindings.connect(this, "fire", this.get("VersionViewer"), "revertToVersion", {});
                  },
                },
                {
                  _BorderColor: Color.rgb(189, 190, 192),
                  _BorderRadius: 5,
                  _BorderWidth: 1,
                  _Extent: lively.pt(145.0, 21.0),
                  _Position: lively.pt(4.0, 4.0),
                  className: "lively.morphic.Button",
                  isPressed: false,
                  label: "Diff",
                  layout: { resizeWidth: true },
                  name: "DiffButton",
                  sourceModule: "lively.morphic.Widgets",
                  connectionRebuilder: function connectionRebuilder() {
                    lively.bindings.connect(this, "fire", this.get("VersionViewer"), "diffSelectedVersions", {});
                  },
                },
              ],
            },
          ],

          // ── path helpers ──────────────────────────────────────────────

          _parsePath: function _parsePath(path) {
            if (!path) return null;
            var idx = path.indexOf("/");
            if (idx === -1) return null;
            return { handle: path.slice(0, idx), objId: path.slice(idx + 1) };
          },

          getPath: function getPath() { return this._path; },

          setPath: function setPath(path) {
            var parsed = this._parsePath(path);
            this.get("pathText").textString = path || "";
            this._path = path;
            this._currentHandle = parsed ? parsed.handle : null;
            this._currentObjId  = parsed ? parsed.objId  : null;
            this.getVersions();
          },

          setAndSelectPath: function setAndSelectPath(path) {
            this.setPath(path);
            (function() {
              this.get("pathText").focus();
              this.get("pathText").selectAll();
            }).bind(this).delay(0);
          },

          // ── data loading ──────────────────────────────────────────────

          getVersions: function getVersions() {
            var handle = this._currentHandle, objId = this._currentObjId;
            if (!handle || !objId) return;
            var self = this;
            fetch(
              "/@" + handle + "/" + objId + "/versions",
              { credentials: "include", headers: { "Accept": "application/json" } }
            )
              .then(function(r) { return r.json(); })
              .then(function(body) { self.showResult(null, body.versions || []); })
              .catch(function(err) { self.showResult(err, []); });
          },

          showResult: function showResult(err, versions) {
            if (err) { show(String(err)); return; }
            var handle = this._currentHandle, objId = this._currentObjId;
            var items = versions.slice().reverse().map(function(v, idx) {
              var isCurrent = idx === 0;
              var date = "—";
              try {
                date = new Date(v.createdAt).toLocaleString(undefined, {
                  month: "short", day: "numeric", year: "numeric",
                  hour: "2-digit", minute: "2-digit"
                });
              } catch (e) {}
              var cidShort = v.cid ? v.cid.slice(0, 10) + "…" : "—";
              var namePrefix = (v.name && v.name !== "world") ? v.name + " — " : "";
              var label = namePrefix + date + " (" + cidShort + ")" + (isCurrent ? "  ← current" : "");
              return {
                isListItem: true,
                string: label,
                value: { cid: v.cid, createdAt: v.createdAt, name: v.name, handle: handle, objId: objId }
              };
            });
            this.get("VersionList").setList(items);
          },

          // ── actions ───────────────────────────────────────────────────

          visitVersion: function visitVersion() {
            var sel = this.get("VersionList").selection;
            if (!sel) { show("nothing selected"); return; }
            window.open("/@" + sel.handle + "/" + sel.objId + "/at/" + encodeURIComponent(sel.cid));
          },

          revertToVersion: function revertToVersion() {
            var sel = this.get("VersionList").selection;
            if (!sel) { $world.inform("No version selected"); return; }
            var dateStr = "—";
            try { dateStr = new Date(sel.createdAt).toLocaleString(); } catch (e) {}
            $world.confirm(
              "Revert to version from:\n" + dateStr + "\n\n" +
              "All versions created after this will be permanently deleted.",
              function(ok) {
                if (!ok) { $world.alertOK("Revert cancelled."); return; }
                fetch(
                  "/@" + sel.handle + "/" + sel.objId + "/after/" + encodeURIComponent(sel.cid),
                  { method: "DELETE", credentials: "include" }
                )
                  .then(function(r) { return r.json(); })
                  .then(function(body) {
                    if (body.ok) {
                      $world.alertOK("Reverted. Navigate to the world to see the change.");
                    } else {
                      $world.alert("Revert failed: " + (body.error || "unknown error"));
                    }
                  })
                  .catch(function(err) { $world.alert("Revert failed: " + err.message); });
              }
            );
          },

          diffSelectedVersions: function diffSelectedVersions() {
            var selections = this.get("VersionList").getSelections();
            if (selections.length < 2) {
              this.world().inform("Please select two versions (shift click).");
              return;
            }
            // selections are in display order (newest-first); put older first in the diff
            var v1 = selections[selections.length - 1]; // older
            var v2 = selections[0];                     // newer
            if (!v1.cid || !v2.cid) { $world.alert("Selection missing CID"); return; }
            fetch(
              "/@" + v1.handle + "/" + v1.objId +
              "/diff?from=" + encodeURIComponent(v1.cid) +
              "&to="   + encodeURIComponent(v2.cid),
              { credentials: "include" }
            )
              .then(function(r) { return r.json(); })
              .then(function(body) {
                $world.addCodeEditor({
                  extent: pt(700, 700),
                  title: "Diff " + v1.cid.slice(0, 8) + " → " + v2.cid.slice(0, 8),
                  content: body.diff || "(no differences)",
                  textMode: "diff"
                }).getWindow().comeForward();
              })
              .catch(function(err) { $world.alert("Diff failed: " + err.message); });
          },

          // ── lifecycle ─────────────────────────────────────────────────

          reset: function reset() {
            lively.bindings.connect(this.get("pathText"),    "savedTextString", this, "setPath");
            lively.bindings.connect(this.get("VisitButton"),  "fire", this, "visitVersion");
            lively.bindings.connect(this.get("RevertButton"), "fire", this, "revertToVersion");
            lively.bindings.connect(this.get("DiffButton"),   "fire", this, "diffSelectedVersions");
            this.get("pathText").beInputLine();
            this._path = null;
            this._currentHandle = null;
            this._currentObjId  = null;
            this.get("VersionList").setList([]);
            this.get("pathText").textString = "";
          },

          onLoad: function onLoad() {
            this.autoDetect();
          },

          // Populate path from /@handle/objId in the current URL.
          autoDetect: function autoDetect() {
            var m = window.location.pathname.match(/^\/@([^\/]+)\/([^\/]+)/);
            if (m) this.setAndSelectPath(m[1] + "/" + m[2]);
          },
        },
      ],

      titleBar: "Version Viewer",
      setPath: function setPath(p) { this.targetMorph.setPath(p); },
      setAndSelectPath: function setAndSelectPath(p) { this.targetMorph.setAndSelectPath(p); },
    });

    // Static open() — creates the viewer and auto-detects the current world.
    Object.extend(lively.identity.VersionViewer, {
      open: function(handle, objId) {
        var win = lively.BuildSpec("lively.identity.VersionViewer").createMorph().openInWorldCenter();
        if (handle && objId) {
          win.setPath(handle + "/" + objId);
        } else {
          win.targetMorph.autoDetect();
        }
        return win;
      }
    });

  }); // end module("lively.identity.VersionViewer")
