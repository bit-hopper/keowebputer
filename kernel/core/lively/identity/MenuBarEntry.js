module("lively.identity.MenuBarEntry")
  .requires(
    "lively.identity.DID",
    "lively.identity.SignedSerializer",
    "lively.identity.PostCardUtils",
    "lively.persistence.BuildSpec",
    "lively.morphic.tools.MenuBar",
  )
  .toRun(function () {

    // Advertise to the MenuBar system (same pattern as Wiki.js / Lively2Lively.js).
    // MenuBar calls module("lively.identity.MenuBarEntry").getMenuBarEntries(),
    // which resolves to lively.identity.MenuBarEntry — so the method must live here.
    Object.extend(lively.identity.MenuBarEntry, {
      getMenuBarEntries: function () {
        return [lively.BuildSpec("lively.identity.MenuBarEntry").createMorph()];
      },
    });

    // Unread-reply count for the Mailbox, shown as a dot on the identity
    // entry (and "Mailbox (n)" in its menu). The count comes from
    // GET /@handle/inbox?limit=1 (its unreadReplies covers every thread). It
    // is refreshed on a slow poll, whenever the tab becomes visible again,
    // and by the Mailbox window itself (PostCardMailbox._setInboxBadge) so the
    // two never disagree. Lives on the namespace, not in the BuildSpec: spec
    // methods are rebuilt from source and lose their closure.
    Object.extend(lively.identity.MenuBarEntry, {
      UNREAD_POLL_MS: 60000,
      unreadReplies: 0,
      _entry: null,
      _timer: null,
      _visibilityHooked: false,

      setUnreadReplies: function (n) {
        this.unreadReplies = n || 0;
        var e = this._entry;
        if (e && e.owner && e.showUnread) e.showUnread(this.unreadReplies);
      },

      refreshUnread: function () {
        var self = this;
        var did = lively.identity && lively.identity.did;
        var user = did && did.isLoggedIn() && did.currentUser();
        if (!user) return;
        fetch(did.baseUrl() + "/@" + encodeURIComponent(user.handle) + "/inbox?limit=1", {
          credentials: "include",
          headers: { Accept: "application/json" },
        })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (data) {
            // A sign-out while the request was in flight must not resurrect the dot.
            if (data && did.isLoggedIn()) self.setUnreadReplies(data.unreadReplies || 0);
          })
          .catch(function () { /* keep the last known count */ });
      },

      startUnreadPolling: function (entry) {
        var self = this;
        if (this._timer && this._entry === entry) return;
        this._entry = entry;
        if (this._timer) clearInterval(this._timer);
        this._timer = setInterval(function () {
          if (!document.hidden) self.refreshUnread();
        }, this.UNREAD_POLL_MS);
        if (!this._visibilityHooked) {
          this._visibilityHooked = true;
          document.addEventListener("visibilitychange", function () {
            if (!document.hidden && self._timer) self.refreshUnread();
          });
        }
        this.refreshUnread();
      },

      stopUnreadPolling: function () {
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
        this.setUnreadReplies(0);
      },

      // Ends the local half of a session and leaves for the welcome page: clears
      // IndexedDB (so restoreSession() can't revive it), tells other tabs, then
      // navigates. Used by sign-out (after the server logout) and by account
      // deletion (the server already dropped the session).
      finishSignOut: function () {
        var did = lively.identity.did;
        did._currentUser = null;
        lively.bindings.signal(did, "identityChanged", null);
        // Clear IndexedDB so restoreSession() cannot revive this session.
        did.clearSession(function () {
          // Notify other tabs only after the server session is gone so
          // their /welcome.html redirect won't see a live session.
          if (typeof BroadcastChannel !== "undefined") {
            var _ch = new BroadcastChannel("lively-identity");
            _ch.postMessage({ type: "signed-out" });
            _ch.close();
          }
          if (lively.Config) lively.Config.askBeforeQuit = false;
          window.location.href = "/welcome.html";
        });
      },

      // Confirm, then end the session. A namespace function (not only the
      // entry's own method) so the Settings dialog can call it too.
      signOut: function () {
        var self = this;
        var did = lively.identity.did;
        var user = did.currentUser();
        $world.confirm(
          "Sign out as @" + user.handle + "?",
          function (ok) {
            if (!ok) return;
            // Clear in-memory state immediately so the menubar updates now.
            did._currentUser = null;
            lively.bindings.signal(did, "identityChanged", null);
            // Wait for the server to commit the session deletion before
            // navigating — otherwise /welcome.html sees a live cookie and
            // bounces back to the user's home world.
            fetch("/nodejs/IdentityServer/logout", {
              method: "POST",
              credentials: "include",
            }).then(function () { self.finishSignOut(); }).catch(function (err) {
              console.warn("[Identity] Server logout failed:", err.message);
              self.finishSignOut();
            });
          },
        );
      },
    });

    lively.require("lively.identity.AmbientPresencePanel").toRun(function () {
      lively.identity.AmbientPresencePanel.init();
    });

    // Self-registers against DID's identityChanged signal on load -- see
    // UploadMigration.js's own header for what it does and why it lives
    // here (this module is already the load-bearing "make identity
    // machinery reachable everywhere login can happen" require).
    lively.require("lively.identity.UploadMigration").toRun(function () {});

    // Auto-launches a ?template= preset (e.g. Shop) into a freshly created
    // world -- see WorldTemplateLauncher.js's own header for the full flow.
    lively.require("lively.identity.WorldTemplateLauncher").toRun(function () {
      lively.identity.WorldTemplateLauncher.runIfRequested();
      // Also here: returning from a game-store sign-in opens Settings > Connected.
      lively.identity.WorldTemplateLauncher.runIfLinkReturned();
    });

    lively.BuildSpec(
      "lively.identity.MenuBarEntry",
      lively.BuildSpec("lively.morphic.tools.MenuBarEntry").customize({

        name: "IdentityMenuBarEntry",
        menuBarAlign: "right",
        textString: "sign in",

        style: lively.lang.obj.merge(
          lively.BuildSpec("lively.morphic.tools.MenuBarEntry").attributeStore.style,
          {
            extent: lively.pt(80, 25),
            toolTip: "Identity — sign in or manage your account",
          },
        ),

        // avatar shown to the left of the "@handle" label, once signed in
        AVATAR_SIZE:   16,
        AVATAR_GAP:    2,
        BASE_PADDING:  6,
        BASE_WIDTH:    80,
        UNREAD_DOT_SIZE: 9,

        morphMenuItems: function morphMenuItems() {
          var self = this;
          if (!lively.identity.did || !lively.identity.did.isLoggedIn()) {
            return [
              ["sign in",         function () { self.openLoginDialog(); }],
              ["Create identity", function () { self.openRegisterDialog(); }],
            ];
          }
          return [
            ["My homestar",        function () { self.openMyHomestar(); }],
            ["Compose",            function () { self.newPostcard(); }],
            ["My profile",         function () { self.openMyProfile(); }],
            ["Messages",           function () { self.openMessages(); }],
            ["My worlds",          function () { self.openMyWorlds(); }],
            ["My Constellations",  function () { self.openMyConstellations(); }],
            ["Transit",            function () { self.openTransit(); }],
            ["Calendar",           function () { self.openCalendar(); }],
            ["Wallet",             function () { self.openWallet(); }],
            ["Mailbox" + (lively.identity.MenuBarEntry.unreadReplies
                ? " (" + lively.identity.MenuBarEntry.unreadReplies + ")" : ""),
                                   function () { self.openMailbox(); }],
            ["Files",              function () { self.openFiles(); }],
            ["Settings",           function () { self.openSettings(); }],
            ["Add device",         function () { self.openRegisterDialog(); }],
            ["Sign out",    function () { self.signOut(); }],
          ];
        },

        openLoginDialog: function openLoginDialog() {
          lively.require("lively.identity.LoginDialog").toRun(function () {
            lively.BuildSpec("lively.identity.LoginDialog")
              .createMorph().openInWorldCenter();
          });
        },

        openRegisterDialog: function openRegisterDialog() {
          lively.require("lively.identity.RegisterDialog").toRun(function () {
            lively.BuildSpec("lively.identity.RegisterDialog")
              .createMorph().openInWorldCenter();
          });
        },

        signOut: function signOut() {
          lively.identity.MenuBarEntry.signOut();
        },

        openMyWorlds: function openMyWorlds() {
          lively.require("lively.identity.WorldsBrowser").toRun(function () {
            lively.BuildSpec("lively.identity.WorldsBrowser").createMorph().openInWorldCenter();
          });
        },

        newPostcard: function newPostcard() {
          var handle = lively.identity.did.currentUser().handle;
          lively.require("lively.identity.PostCardEditor").toRun(function () {
            // _handle is bare (no '@') — PostCardEditor's PUT/GET URL building
            // literally prepends '/@' to it (same convention as PostCardMailbox's
            // inbox/deliveries/settings routes).
            lively.identity.PostCardEditor.newCard(handle);
          });
        },

        openMailbox: function openMailbox(tab) {
          lively.require("lively.identity.PostCardMailbox").toRun(function () {
            lively.identity.PostCardMailbox.open(tab);
          });
        },

        openMyConstellations: function openMyConstellations() {
          lively.require("lively.identity.ConstellationsBrowser").toRun(function () {
            lively.identity.ConstellationsBrowser.open();
          });
        },

        openFiles: function openFiles() {
          lively.require("lively.identity.FilesBrowser").toRun(function () {
            lively.identity.FilesBrowser.open();
          });
        },

        openSettings: function openSettings() {
          lively.require("lively.identity.SettingsDialog").toRun(function () {
            lively.identity.SettingsDialog.open();
          });
        },

        openTransit: function openTransit() {
          lively.require("lively.transit.TransitMapApp").toRun(function () {
            lively.transit.TransitMapApp.open();
          });
        },

        openCalendar: function openCalendar() {
          lively.require("lively.calendar.CalendarApp").toRun(function () {
            lively.calendar.CalendarApp.open();
          });
        },

        openWallet: function openWallet() {
          lively.require("lively.identity.Wallet").toRun(function () {
            lively.identity.Wallet.open();
          });
        },

        openMyHomestar: function openMyHomestar() {
          window.location.href = "/@" + encodeURIComponent(lively.identity.did.currentUser().handle);
        },

        openMyProfile: function openMyProfile() {
          lively.require("lively.identity.ProfileCard").toRun(function () {
            lively.identity.ProfileCard.open();
          });
        },

        // Opens the P2P E2EE direct-message thread list (p2pchat.md) —
        // the menu-bar entry point for reaching an existing conversation
        // without going through a friend's profile first. Individual
        // conversations are also reachable from the "Message" icon on each
        // friend nameplate row in ProfileCard.js's Friends widget.
        openMessages: function openMessages() {
          lively.require("lively.identity.DMChat").toRun(function () {
            lively.identity.DMChat.openInbox();
          });
        },

        update: function update() {
          if (!lively.identity || !lively.identity.did) return;
          var loggedIn = lively.identity.did.isLoggedIn();
          var user = loggedIn && lively.identity.did.currentUser();
          this.textString = loggedIn ? "@" + lively.identity.did.displayHandle() : "sign in";
          this.updateAvatar(loggedIn ? user.handle : null);
          this.fitWidth();
          this.placeUnreadDot();
          if (loggedIn) lively.identity.MenuBarEntry.startUnreadPolling(this);
          else lively.identity.MenuBarEntry.stopUnreadPolling();
        },

        // A small red dot on the entry's top-right corner while there are
        // unread replies; n === 0 removes it. The count itself is in the
        // tooltip and in the menu's "Mailbox (n)" item.
        showUnread: function showUnread(n) {
          var D = this.UNREAD_DOT_SIZE;
          this.setToolTip && this.setToolTip(n
            ? n + " unread " + (n === 1 ? "reply" : "replies") + " in your Mailbox"
            : "Identity — sign in or manage your account");
          if (!n) {
            if (this._unreadDot) { this._unreadDot.remove(); this._unreadDot = null; }
            return;
          }
          if (!this._unreadDot) {
            var dot = new lively.morphic.Box(lively.rect(0, 0, D, D));
            dot.applyStyle({
              fill: Color.rgb(225, 29, 72),
              borderWidth: 1.5,
              borderColor: Color.white,
              borderRadius: D / 2,
            });
            // Purely decorative: clicks must reach the entry underneath.
            dot.eventsAreIgnored = true;
            dot.draggingEnabled = false;
            dot.droppingEnabled = false;
            dot.grabbingEnabled = false;
            this._unreadDot = this.addMorph(dot);
            dot.renderContext().shapeNode.style.pointerEvents = "none";
          }
          this.placeUnreadDot();
        },

        placeUnreadDot: function placeUnreadDot() {
          if (!this._unreadDot) return;
          var D = this.UNREAD_DOT_SIZE;
          this._unreadDot.setPosition(lively.pt(this.getExtent().x - D - 1, 1));
        },

        // Widen the entry (never below its base width) so a long label — a
        // domain handle like "@tinylil.world" — isn't clipped. The label is
        // 13.33px Helvetica on one line (white-space: pre), measured with a
        // canvas in that font so it doesn't depend on the DOM having rendered
        // yet; padding is the entry's own left (incl. avatar) and right insets.
        fitWidth: function fitWidth() {
          var PAD = this.BASE_PADDING;
          var extra = this._avatarMorph ? this.AVATAR_SIZE + this.AVATAR_GAP : 0;
          var ctx = document.createElement("canvas").getContext("2d");
          ctx.font = '13.3333px "Helvetica Neue", Helvetica, sans-serif';
          var textW = Math.ceil(ctx.measureText(this.textString || "").width);
          var want = Math.max(this.BASE_WIDTH + extra, textW + PAD + extra + PAD + 4);
          if (Math.abs(this.getExtent().x - want) < 1) return;
          this.setExtent(this.getExtent().withX(want));
          this.owner && this.owner.relayout && this.owner.relayout();
          this.recenterText();
        },

        // Shows a small identicon (or the user's uploaded avatarUrl, once
        // fetched) to the left of the "@handle" label. Grows/shrinks this
        // entry's width to make room and re-triggers the bar's relayout,
        // same as updateText() does for label-width changes.
        updateAvatar: function updateAvatar(handle) {
          var self = this;
          var AV = this.AVATAR_SIZE, GAP = this.AVATAR_GAP, PAD = this.BASE_PADDING;

          if (!handle) {
            if (!this._avatarMorph) return;
            this._avatarMorph.remove();
            this._avatarMorph = null;
            this._avatarHandle = null;
            this.applyStyle({ padding: lively.Rectangle.inset(PAD, 0, PAD, 0) });
            this.setExtent(this.getExtent().withX(this.BASE_WIDTH));
            this.owner && this.owner.relayout && this.owner.relayout();
            this.recenterText();
            return;
          }

          if (!this._avatarMorph) {
            var img = new lively.morphic.Image(lively.rect(PAD, 0, AV, AV));
            img.applyStyle({ borderRadius: AV / 2, borderWidth: 0, clipMode: "hidden" });
            this._avatarMorph = this.addMorph(img);
            this.applyStyle({ padding: lively.Rectangle.inset(PAD + AV + GAP, 0, PAD, 0) });
            this.setExtent(this.getExtent().withX(this.BASE_WIDTH + AV + GAP));
            this.owner && this.owner.relayout && this.owner.relayout();
            this.recenterText();
          }
          this._avatarMorph.setPosition(
            lively.pt(PAD, Math.max(0, (this.getExtent().y - AV) / 2)));

          if (this._avatarHandle === handle) return;
          this._avatarHandle = handle;

          this._avatarMorph.setImageURL(
            lively.identity.postCardUtils.identiconDataUrl(handle, AV));

          fetch("/@" + handle + "/profile", { credentials: "include" })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (env) {
              if (!env || self._avatarHandle !== handle || !self._avatarMorph) return;
              var payload = (env.record && env.record.payload) || {};
              if (payload.avatarUrl) self._avatarMorph.setImageURL(payload.avatarUrl);
            })
            .catch(function () {});
        },

        // Called when the morph is added to the world from a saved world file,
        // and by onFromBuildSpecCreated when created fresh.
        onLoad: function onLoad() {
          var self = this;
          var connect = function () {
            self.update();
            lively.bindings.connect(
              lively.identity.did, "identityChanged",
              self, "update",
            );
            lively.bindings.connect(
              lively.identity.did, "displayHandleChanged",
              self, "update",
            );
          };
          // If DID.js is already loaded (normal path: module loads before world
          // deserializes), connect immediately. Otherwise defer — toRun() fires
          // as soon as the module's onload callbacks run.
          if (lively.identity && lively.identity.did) {
            connect();
          } else {
            lively.require("lively.identity.DID").toRun(connect);
          }
        },

        onFromBuildSpecCreated: function onFromBuildSpecCreated() {
          this.onLoad();
        },
      }),
    );

  }); // end module('lively.identity.MenuBarEntry')
