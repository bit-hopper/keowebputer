module('lively.ide.tools.Search').requires().toRun(function () {

// Candidate building for the search palette and the morph search command.
// No UI here: every function returns plain items of one shape,
//   {type, group, name, cls, text, world, path, meta, run, morph, url}
// where run() is the item's primary action.

Object.extend(lively.ide.tools.Search, {

  SNIPPET_LENGTH: 60,

  // `lively.morphic.Foo` / `lively.identity.Foo` -> `Foo`
  shortClassName: function (cls) {
    return String(cls || "morph").replace(/^lively\.(morphic|identity)\./, "");
  },

  // Result type (search.md §3.2) for a class name; drives icon and tint.
  typeOf: function (cls) {
    cls = lively.ide.tools.Search.shortClassName(cls);
    if (/Window/.test(cls)) return "window";
    if (/Image/.test(cls)) return "image";
    if (/Button/.test(cls)) return "button";
    if (/Text|Label/.test(cls)) return "text";
    return "box";
  },

  snippet: function (text) {
    var Search = lively.ide.tools.Search;
    text = String(text || "").replace(/\s+/g, " ").trim();
    return text.length > Search.SNIPPET_LENGTH ? text.slice(0, Search.SNIPPET_LENGTH) + "…" : text;
  },

  // Bring a live morph into view and show its halo.
  showMorph: function (morph) {
    if (!morph || !morph.world()) return;
    var win = morph.getWindow && morph.getWindow();
    if (win) win.comeForward();
    else morph.bringToFront();
    morph.showHalos();
  },

  // Morphs in the current world that have a name or text.
  worldItems: function () {
    var Search = lively.ide.tools.Search;
    function textOf(ea) {
      return ea.isText && Object.isString(ea.textString) ? ea.textString.replace(/\s+/g, " ").trim() : "";
    }
    return $world
      .withAllSubmorphsSelect(function (ea) {
        return (
          ea !== $world &&
          ((Object.isString(ea.name) && ea.name !== "") || textOf(ea) !== "") &&
          !ea.isHalo &&
          !ea.isEpiMorph &&
          !/^NarrowList/.test(ea.name) &&
          !(ea.ownerChain && ea.ownerChain().some(function (o) { return o.isHalo || /^NarrowList/.test(o.name); }))
        );
      })
      .map(function (ea) {
        var cls = (ea.constructor.type || "morph").replace(/^lively\.morphic\./, "");
        return {
          type: Search.typeOf(cls),
          group: "world",
          name: ea.name || "",
          cls: cls,
          text: Search.snippet(textOf(ea)),
          world: null,
          path: null,
          meta: null,
          morph: ea,
          url: null,
          run: function () { Search.showMorph(ea); },
        };
      });
  },

  // "3 days ago" for an ISO date; "" when it can't be read.
  ago: function (iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) return "";
    var mins = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (mins < 60) return mins <= 1 ? "just now" : mins + " minutes ago";
    var hours = Math.round(mins / 60);
    if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
    var days = Math.round(hours / 24);
    if (days < 30) return days + (days === 1 ? " day ago" : " days ago");
    var months = Math.round(days / 30);
    if (months < 12) return months + (months === 1 ? " month ago" : " months ago");
    var years = Math.round(months / 12);
    return years + (years === 1 ? " year ago" : " years ago");
  },

  // `GET /@handle` is the whole home listing (every object with its payload: about
  // 5 MB for a busy account), and each palette open used to download it again.
  // One in-flight or recent copy is shared for HOME_TTL ms; a failed request is
  // not kept, so the next open retries.
  HOME_TTL: 30000,
  homeBody: function (base) {
    var Search = lively.ide.tools.Search, c = Search._home;
    if (c && c.base === base && Date.now() - c.at < Search.HOME_TTL) return c.promise;
    var entry = { base: base, at: Date.now() },
      drop = function () { if (Search._home === entry) Search._home = null; return {}; };
    entry.promise = fetch(base, { credentials: "include", headers: { Accept: "application/json" } })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (body) { return body || drop(); }, drop);
    Search._home = entry;
    return entry.promise;
  },

  // A file or folder envelope from the home listing as a result item. Names are
  // plaintext state (also for private and shared ones; only the payload is
  // encrypted), so a private file can be found by name. A file's size is only
  // known when its payload is readable (public).
  fileItem: function (obj) {
    var Search = lively.ide.tools.Search,
      st = obj.state || {}, payload = obj.record && obj.record.payload,
      folder = obj.type === "folder",
      name = st.name || obj.objId,
      m = /\.([a-z0-9]+)$/i.exec(name),
      ext = folder || !m ? "" : m[1].toLowerCase(),
      size = !folder && payload && typeof payload === "object" && typeof payload.size === "number" ? payload.size : null,
      vis = obj.visibility || "private",
      bits = [];
    if (folder) bits.push((st.fileCount || 0) + ((st.fileCount || 0) === 1 ? " file" : " files"));
    else bits.push(ext ? ext.toUpperCase() : "File");
    if (size != null) bits.push(Search.formatSize(size));
    bits.push(vis.charAt(0).toUpperCase() + vis.slice(1));
    var when = Search.ago(obj.created);
    if (when) bits.push((folder ? "created " : "added ") + when);
    return {
      type: folder ? "folder" : "file", group: "files", name: name,
      cls: folder ? "Folder" : ext ? ext.toUpperCase() : "File", text: "", world: null, path: null,
      meta: bits.join("  \u00b7  "), morph: null, url: null,
      info: { folder: folder, ext: ext, size: size, visibility: vis, created: obj.created || null, fileCount: st.fileCount || 0,
              // a public image can be shown as it is; a private one would need a passkey decrypt
              fileThumb: !folder && vis === "public" && size != null && size <= 3 * 1024 * 1024 &&
                /^image\//.test(String(payload.mime || "")) ? { objId: obj.objId } : null },
      run: function () { Search.openFile(obj); },
    };
  },

  formatSize: function (bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  },

  // A file opens in the Files window's own way; a folder opens the Files window
  // inside it. Opening a private file can need the passkey, and can fail.
  openFile: function (obj) {
    lively.require("lively.identity.FilesBrowser").toRun(function () {
      var FB = lively.identity.FilesBrowser;
      if (obj.type === "folder") return FB.openFolderEnvelope(obj);
      FB.openFileEnvelope(obj, function (err) {
        if (err) $world.alert("Could not open file: " + (err.message || err));
      });
    });
  },

  // The signed-in user's saved worlds, from two requests made together:
  //  - GET /@handle: whole envelopes. Each public world's payload carries a
  //    registry, which gives the morphs inside it (and a morph count). Private
  //    (encrypted) worlds have no readable registry, so contribute no morphs.
  //  - GET /@handle/worlds: metadata only, every world the user may open,
  //    private ones included, with its plaintext name.
  // The first request's listing also holds the user's files and folders.
  // Calls thenDo({ morphs: [...], worlds: [...], files: [...] }); all are [] when
  // signed out, and a half is [] if its request fails. opts.worlds === false skips the
  // /worlds request.
  fetchSaved: function (thenDo, opts) {
    var Search = lively.ide.tools.Search,
      did = lively.identity && lively.identity.did;
    if (!did || !did.isLoggedIn() || !window.fetch) return thenDo({ morphs: [], worlds: [], files: [] });
    var handle = did.currentUser().handle,
      base = "/@" + encodeURIComponent(handle),
      counts = {}, registries = {}, morphs = [], files = [], worldList = [],
      wantWorlds = !opts || opts.worlds !== false,
      pending = wantWorlds ? 2 : 1;

    function getJSON(url) {
      return fetch(url, { credentials: "include", headers: { Accept: "application/json" } })
        .then(function (r) { return r.json(); })
        .catch(function () { return {}; });
    }
    function done() {
      if (--pending) return;
      var worlds = worldList.map(function (w) {
        var url = "/@" + handle + "/" + w.objId,
          name = w.name || w.objId,
          n = counts[w.objId],
          bits = [];
        if (n != null) bits.push(n + (n === 1 ? " morph" : " morphs"));
        if (w.visibility && w.visibility !== "public") bits.push("private");
        var when = Search.ago(w.created);
        if (when) bits.push("created " + when);
        return {
          type: "world", group: "worlds", name: name, cls: "World", text: "", world: null,
          path: null, meta: bits.join("  ·  "), morph: null, url: url,
          info: { morphs: n != null ? n : null, visibility: w.visibility || "public", created: w.created || null,
                  thumb: registries[w.objId] || null },
          run: function () { window.open(url, "_blank"); },
        };
      });
      thenDo({ morphs: morphs, worlds: worlds, files: files });
    }

    Search.homeBody(base).then(function (body) {
      (body.objects || []).forEach(function (obj) {
        if (obj.type === "file" || obj.type === "folder") {
          files.push(Search.fileItem(obj));
          return;
        }
        var registry = obj.type === "world" && obj.record && obj.record.payload && obj.record.payload.registry;
        if (!registry) return;
        var worldName = (obj.state && obj.state.name) || obj.objId,
          url = "/@" + handle + "/" + obj.objId,
          seen = {}, count = 0;
        Object.keys(registry).forEach(function (k) {
          var e = registry[k],
            cls = e && e.__LivelyClassName__;
          if (!cls || !/^lively\.(morphic|identity)\./.test(cls) || /Shape|Layout|StyleSheet|Hand|Trait|Connection/.test(cls)) return;
          if (!/\.World$/.test(cls)) count++;   // every morph counts toward the world's size; only named / text-bearing ones are searchable
          var name = Object.isString(e.name) ? e.name : "",
            text = Search.snippet(
              Object.isString(e.textString) ? e.textString : Object.isString(e.storedTextString) ? e.storedTextString : "",
            );
          if (!name && !text) return;
          var shortCls = Search.shortClassName(cls),
            key = name + "|" + shortCls + "|" + text;
          if (seen[key]) return;
          seen[key] = true;
          morphs.push({
            type: Search.typeOf(cls), group: "saved", name: name, cls: shortCls, text: text,
            world: worldName, path: null, meta: null, morph: null, url: url,
            info: { thumb: { registry: registry, rootId: k } },
            run: function () { window.open(url, "_blank"); },
          });
        });
        counts[obj.objId] = count;
        var rootId = obj.record.payload.id;
        if (rootId != null && registry[rootId]) registries[obj.objId] = { registry: registry, rootId: rootId };
      });
      done();
    });
    if (wantWorlds) getJSON(base + "/worlds").then(function (body) {
      worldList = Array.isArray(body.worlds) ? body.worlds : [];
      done();
    });
  },

  // Just the morphs inside saved worlds (what the plain morph search lists).
  // Calls thenDo(items), with [] when signed out or on any failure.
  savedWorldItems: function (thenDo) {
    lively.ide.tools.Search.fetchSaved(function (saved) { thenDo(saved.morphs); }, { worlds: false });
  },

  CODE_CAP: 200,

  // Runtime code (classes, methods, namespaces, scripts, buildspecs) whose name
  // or source contains the query. Reuses the code search window's own scan
  // (searchInRuntime / browseCode); neither needs the window, only a host that
  // has world() and withAllMethodsDo, so they are called on a stand-in. Nothing
  // here touches the server: the file/grep half of that tool runs a shell on the
  // server, which is admin-only and not used.
  // opts.exclude(found) drops a hit (the palette's own morphs). Calls
  // thenDo(items), items capped at CODE_CAP, [] on any failure.
  codeItems: function (query, thenDo, opts) {
    var Search = lively.ide.tools.Search;
    lively.require("lively.ide.tools.CodeSearch").toRun(function () {
      var store = lively.BuildSpec("lively.ide.tools.CodeSearch").attributeStore,
        host = { world: function () { return $world; }, withAllMethodsDo: store.withAllMethodsDo };
      try {
        store.searchInRuntime.call(host, query, function (err, list) {
          if (err || !list) return thenDo([]);
          var items = [];
          list.forEach(function (entry) {
            var found = entry.value;
            if (!found || items.length >= Search.CODE_CAP) return;
            if (opts && opts.exclude && opts.exclude(found)) return;
            var name = found.objectName + (found.selector ? ">>" + found.selector : "");
            items.push({
              type: "code", group: "code", name: name, cls: found.type,
              text: found.matchedAs === "sourceMatch" ? Search.snippet(found.match) : "",
              world: null, path: null, meta: null, morph: null, url: null,
              info: { object: found.objectName, member: found.selector || "",
                      // a class's "source" is just its name; a method's is real code
                      source: found.methodSource && found.methodSource !== found.objectName ? String(found.methodSource).slice(0, 1500) : "" },
              run: function () { store.browseCode.call({}, found); },
            });
          });
          thenDo(items);
        });
      } catch (e) {
        thenDo([]);
      }
    });
  },

  // `name  <Class>  "text"  — in world "X"`: the line the plain list shows.
  listString: function (item) {
    if (item.type === "world") return item.name + "  <World>" + (item.meta ? "  " + item.meta : "");
    return (
      (item.name || "(unnamed)") + "  <" + item.cls + ">" +
      (item.text ? "  \"" + item.text + "\"" : "") +
      (item.world ? "  — in world \"" + item.world + "\"" : "")
    );
  },

});

});
