/**
 * lively.identity.WorldTemplateLauncher
 *
 * Runs once per fresh world-page load (hooked from MenuBarEntry.js, the
 * established "run once identity/menu infrastructure is up" point in this
 * codebase — see AmbientPresencePanel.init()/UploadMigration in that file).
 * Checks the URL for a `?template=` param left behind by WorldsBrowser.js's
 * create-world flow (Create -> Template -> Shop) and, if present, auto-opens
 * the matching preset into the now-current $world, then strips the param via
 * history.replaceState so a plain reload of the same URL never re-triggers it.
 *
 * "shop", "inventory", "gallery", "books", "music", "game" and "diary" (a stub) are
 * implemented — WorldsBrowser.js's template picker never sends any other key (movie
 * is still rendered as an inert placeholder there), so no other case is needed yet.
 */

module("lively.identity.WorldTemplateLauncher")
  .requires(
    "lively.identity.DID",
    "lively.identity.WebKey",
    "lively.identity.SignedSerializer",
  )
  .toRun(function () {

    Object.extend(lively.identity.WorldTemplateLauncher, {

      runIfRequested: function runIfRequested() {
        if (this._launched) return;
        var params = new URLSearchParams(location.search);
        var template = params.get("template");
        if (!template) return;
        this._launched = true;

        // Strip immediately so a later plain reload of this world's URL
        // never re-triggers this (idempotency), regardless of when the
        // actual launch below finishes. Built via URLSearchParams + manual
        // path reassembly, NOT `new URL(...).searchParams` -- confirmed
        // live that in this environment a real URL instance has no
        // searchParams accessor at all ('searchParams' in new URL(...) is
        // false), even though standalone URLSearchParams works fine.
        params.delete("template");
        var qs = params.toString();
        var newUrl = location.pathname + (qs ? "?" + qs : "") + location.hash;
        window.history.replaceState(null, "", newUrl);

        lively.identity.WorldTemplateLauncher._launchTemplate(template);
      },

      // Runs once per world-page load, next to runIfRequested. When the browser comes back
      // from a game-store sign-in (GameLinkServer redirects to the page it left, adding
      // ?linked=<store> or ?link_error=<code>), strips those parameters and opens
      // Settings on its Connected tab with the outcome. Waits for the identity restore
      // if the user is not signed in yet at this point in the boot. Does nothing when
      // neither parameter is present.
      runIfLinkReturned: function runIfLinkReturned() {
        if (this._linkReturnHandled) return;
        var params = new URLSearchParams(location.search);
        var linked = params.get("linked");
        var failed = params.get("link_error");
        if (!linked && !failed) return;
        this._linkReturnHandled = true;

        params.delete("linked");
        params.delete("link_error");
        var qs = params.toString();
        window.history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash);

        var notice = lively.identity.WorldTemplateLauncher.linkNotice(linked, failed);
        var did = lively.identity.did;
        function openSettings() {
          lively.require("lively.identity.SettingsDialog").toRun(function () {
            lively.identity.SettingsDialog.open("connected", notice);
          });
        }
        if (did.isLoggedIn()) return openSettings();
        var waiter = {
          onIdentityChanged: function (user) {
            if (!user) return;
            lively.bindings.disconnect(did, "identityChanged", waiter, "onIdentityChanged");
            openSettings();
          },
        };
        lively.bindings.connect(did, "identityChanged", waiter, "onIdentityChanged");
      },

      // The words shown for a returned link attempt. `failed` is one of the fixed codes
      // GameLinkServer sends; an unknown code gets the generic line, never the raw value.
      linkNotice: function linkNotice(linked, failed) {
        var names = { steam: "Steam", itch: "itch.io" };
        if (linked) return { ok: true, text: (names[linked] || "The account") + " connected." };
        var texts = {
          not_signed_in: "You were signed out before the connection finished. Sign in and try again.",
          state_invalid: "That connection attempt expired or was not started from this browser. Start it again from here.",
          unavailable: "That store isn't set up on this server yet.",
          rate_limited: "Too many attempts. Wait a minute and try again.",
          cancelled: "The connection was cancelled.",
          assertion_rejected: "The store's sign-in could not be verified, so nothing was connected.",
          provider_unreachable: "Couldn't reach the store. Try again in a moment.",
          provider_error: "The store answered with an error, so nothing was connected.",
          scope_denied: "The permissions needed to read your games were not granted, so nothing was connected.",
          already_linked: "That account is already connected to another profile.",
          server_error: "Something went wrong on our side. Try again.",
        };
        return { ok: false, text: texts[failed] || "The connection did not complete." };
      },

      _launchTemplate: function _launchTemplate(template) {
        if (template === "shop") {
          lively.require("lively.commerce.Shop").toRun(function () {
            lively.commerce.Shop.open();
            lively.identity.WorldTemplateLauncher._saveCurrentWorld();
          });
        } else if (template === "inventory") {
          // Just opens the browsing tool -- no _saveCurrentWorld() here,
          // unlike "shop": nothing permanent has been added to the world
          // yet at this point, only a floating tool window the user still
          // has to actually drag a part out of. That drag (or a later
          // explicit "Save world") is what makes anything worth persisting.
          lively.require("lively.identity.Inventory").toRun(function () {
            lively.identity.Inventory.open();
          });
        } else if (template === "gallery") {
          // No _saveCurrentWorld() call here, unlike "shop" -- Gallery's
          // backing folder is created asynchronously (a passkey/KEK
          // ceremony), so saving immediately after .open() would capture
          // the morph before galleryFolderObjId even exists on it (confirmed
          // live: every reload then created a fresh orphan folder, since the
          // saved envelope never had a pointer to reuse). Gallery.js's own
          // _ensureFolder() calls _saveCurrentWorld() itself once the folder
          // is actually created.
          lively.require("lively.gallery.Gallery").toRun(function () {
            lively.gallery.Gallery.open();
          });
        } else if (template === "books") {
          // Same async-backing-storage reasoning as "gallery" above -- Books'
          // library folder is created asynchronously (a passkey/KEK
          // ceremony for a private/shared folder, though the library folder
          // itself is always public and needs none -- see Books.js's
          // _ensureLibrary), so no _saveCurrentWorld() call here. Books.js's
          // own _ensureLibrary() calls it once booksLibraryObjId actually
          // exists.
          lively.require("lively.books.Books").toRun(function () {
            lively.books.Books.open();
          });
        } else if (template === "music") {
          // Same async-backing-storage reasoning as "gallery"/"books" above
          // -- no _saveCurrentWorld() call here. Music.js's own
          // _ensureLibrary() calls it once musicLibraryObjId actually exists.
          lively.require("lively.music.Music").toRun(function () {
            lively.music.Music.open();
          });
        } else if (template === "game") {
          // No backing folder to create (the library is account data, read through
          // /@handle/games), so nothing asynchronous has to finish first and the world can
          // be saved right away, like "shop" and "diary". Gaming.js keeps its screen out of
          // the saved world; only the root morph is stored.
          lively.require("lively.gaming.Gaming").toRun(function () {
            lively.gaming.Gaming.open();
            lively.identity.WorldTemplateLauncher._saveCurrentWorld();
          });
        } else if (template === "diary") {
          // A stub for now: a plain morph with no backing storage, so unlike
          // "gallery"/"books"/"music" there is nothing async to wait for and
          // the world can be saved right away, like "shop".
          lively.require("lively.diary.Diary").toRun(function () {
            lively.diary.Diary.open();
            lively.identity.WorldTemplateLauncher._saveCurrentWorld();
          });
        }
      },

      // Persists $world right after a template adds real content to it.
      // Without this, the template morph (e.g. Shop) only exists in memory
      // for this one page view and silently disappears on the next plain
      // reload -- confirmed live -- since nothing else re-saves the world
      // after WorldsBrowser.js's own create-world PUT (which only wrote the
      // pre-template blank JSO). Mirrors Widgets.js's "Save world" menu
      // action: fetch the existing envelope for the prevCid chain, sign,
      // PUT in place.
      _saveCurrentWorld: function _saveCurrentWorld() {
        var parsed = lively.identity.webKey.parseObjectUrl(window.location.href);
        if (!parsed || !parsed.objId) return;
        var user = lively.identity.did.currentUser();
        if (!user) return;
        var handle = parsed.handle;
        var objId = parsed.objId;
        fetch("/@" + handle + "/" + objId, { credentials: "include", headers: { Accept: "application/json" } })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (prevEnvelope) {
            var ss = lively.identity.signedSerializer;
            var method = lively.identity.did.findMethodByCredentialId(user.document, user.credentialId);
            // $world.name is a plain Morph property (defaults to "world"),
            // NOT kept in sync with the display name stored in
            // envelope.state.name on load -- confirmed live, a save that
            // used $world.name here silently reverted a freshly created
            // world's real name back to "world". Preserve the name already
            // on record instead, same defensive "keep it from prevEnvelope"
            // idiom SignedSerializer.js itself already uses for `created`.
            var existingName = prevEnvelope && prevEnvelope.state && prevEnvelope.state.name;
            ss.serializeToEnvelope({
              obj: $world,
              type: "world",
              objId: objId,
              publicKeyJwk: method ? method.publicKeyJwk : null,
              prevEnvelope: prevEnvelope && prevEnvelope.record ? prevEnvelope : null,
              stateMeta: { name: existingName || $world.name || "world" },
            }, function (err, envelope) {
              if (err) {
                console.warn("[WorldTemplateLauncher] Could not save template world:", err.message);
                return;
              }
              fetch("/@" + handle + "/" + objId, {
                method: "PUT",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(envelope),
              }).catch(function (e) {
                console.warn("[WorldTemplateLauncher] Save failed:", e.message);
              });
            });
          });
      },

    });

  }); // end module('lively.identity.WorldTemplateLauncher')
