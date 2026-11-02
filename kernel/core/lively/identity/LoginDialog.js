/**
 * lively.identity.LoginDialog
 *
 * Window dialog for signing in to an existing identity.
 *
 * Handle is required. Two paths, chosen by whether the typed handle has a
 * matching credential in the local WebAuthn roster:
 *
 *   Known-device path — local WebAuthn roster has a credential for this
 *     rpId + handle. Succeeds without fetching the DID document from the
 *     server because completeAuthentication() reads it from local
 *     lively.IndexedDB.
 *
 *   New-device path — no local roster entry matches (e.g. first sign-in on
 *     this browser).
 *     Uses an empty allowCredentials list so the OS shows a discoverable-
 *     credential picker. After the authenticator fires, the handle is
 *     extracted from userHandle bytes ("lively-user:<handle>"), the server
 *     verifies the assertion, and the DID document is fetched from /@handle
 *     and saved to local lively.IndexedDB before completeAuthentication runs.
 *
 * Async convention: thenDo(err, result) throughout.
 *
 * Dependencies:
 *   lively.identity.DID         — completeAuthentication, saveDocument, isLoggedIn
 *   lively.identity.WebAuthn    — authenticate, getCredentials
 *   lively.identity.ObjectStore — sync (post-login background pull)
 *   lively.identity.Crypto      — base64urlDecode (via WebAuthn module)
 */

module("lively.identity.LoginDialog")
  .requires(
    "lively.identity.DID",
    "lively.identity.WebAuthn",
    "lively.identity.ObjectStore",
    "lively.identity.PasskeyPrimingDialog",
    "lively.persistence.BuildSpec",
    "lively.morphic.Complete",
  )
  .toRun(function () {
    lively.BuildSpec("lively.identity.LoginDialog", {
      _BorderRadius: 7,
      _Extent: lively.pt(400, 174),
      _Fill: Color.rgb(255, 16, 144),
      className: "lively.morphic.Window",
      contentOffset: lively.pt(3, 22),
      draggingEnabled: true,
      droppingEnabled: false,
      layout: { adjustForNewBounds: true },
      name: "IdentityLoginDialog",
      titleBar: "Sign in",
      submorphs: [
        {
          _Extent: lively.pt(394, 146),
          _Fill: Color.rgb(250, 250, 250),
          _Position: lively.pt(3, 22),
          className: "lively.morphic.Box",
          layout: {
            adjustForNewBounds: true,
            resizeHeight: true,
            resizeWidth: true,
          },
          name: "loginContent",
          submorphs: [],
        },
      ],

      // ─── lifecycle ──────────────────────────────────────────────────────────────

      onFromBuildSpecCreated: function onFromBuildSpecCreated() {
        // Window's own onFromBuildSpecCreated (BuildSpecMorphExtensions.js)
        // is what actually builds the title bar from the titleBar: BuildSpec
        // property above -- skipping $super() renders with no title bar at
        // all (confirmed gotcha, see WalletSetupDialog.js's identical note).
        $super();
        this._ensureAccentChromeCss();
        this.addStyleClassName("identity-accent-chrome");
        this.buildForm();
      },

      // The base theme's default title-text color (#555) doesn't have
      // enough contrast against this dialog's saturated pink _Fill (which
      // already shows through as the title bar's own background for free,
      // since `.Window .TitleBar` is transparent by design) -- scoped to a
      // small shared class so it never affects any other window. Same
      // technique as DMChat.js's applyAccentChrome/_ensureAccentChromeCss.
      _ensureAccentChromeCss: function () {
        var STYLE_ID = "identity-accent-chrome-style";
        if (document.getElementById(STYLE_ID)) return;
        var styleEl = document.createElement("style");
        styleEl.id = STYLE_ID;
        styleEl.textContent = [
          ".Window.identity-accent-chrome .Text.window-title { color: #fff; }",
          ".Window.identity-accent-chrome.highlighted .Text.window-title { color: #fff; font-weight: bold; }",
        ].join("\n");
        document.head.appendChild(styleEl);
      },

      // ─── form construction ──────────────────────────────────────────────────────

      buildForm: function buildForm() {
        var self = this;
        var content = this.get("loginContent");
        if (!content) return;
        content.removeAllMorphs();

        var pad = 14;
        var y = pad;
        var w = content.getExtent().x - pad * 2;

        function addLabel(text) {
          var lbl = new lively.morphic.Text(lively.rect(pad, y, w, 16), text);
          lbl.applyStyle({
            allowInput: false,
            fontFamily: "Arial, sans-serif",
            fontSize: 11,
            textColor: Color.rgb(70, 70, 70),
            padding: lively.rect(4, 3, 0, 0),
            fill: null,
            borderWidth: 0,
            borderColor: null,
          });
          content.addMorph(lbl);
          y += 22; // 16px label + 6px gap before its input
          return lbl;
        }

        function addInput(name) {
          var inp = new lively.morphic.Text(lively.rect(pad, y, w, 22), "");
          inp.name = name;
          inp.applyStyle({
            allowInput: true,
            fontFamily: "Helvetica",
            fontSize: 12,
            fill: Color.white,
            borderWidth: 1,
            borderColor: Color.rgb(203, 203, 203),
            borderRadius: 3.75,
            padding: lively.rect(4, 4, 0, 0),
          });
          inp.beInputLine();
          content.addMorph(inp);
          y += 34; // 22px field + 12px gap before the next label
          return inp;
        }

        addLabel("Handle:");
        addInput("handleInput");

        y += 2;
        var statusText = new lively.morphic.Text(
          lively.rect(pad, y, w, 28),
          "",
        );
        statusText.name = "statusText";
        statusText.applyStyle({ allowInput: false, fontSize: 11, fill: null, borderWidth: 0, borderColor: null });
        content.addMorph(statusText);
        y += 36;

        function paintButton(btn, borderColor, borderWidth, borderRadius, fill) {
          // applyStyle alone silently fails to reach the DOM for buttons
          // created procedurally (new Button(...) + addMorph) rather than
          // declared as static BuildSpec submorphs — write the real CSS
          // directly as well, verified via getComputedStyle. Deferred one
          // tick because a layout pass still in flight right after
          // construction (content pane's resizeWidth/resizeHeight layout)
          // otherwise regenerates the shapeNode and discards a same-tick
          // direct-DOM write.
          btn.applyStyle({
            borderColor: borderColor,
            borderWidth: borderWidth,
            borderRadius: borderRadius,
            fill: fill,
          });
          (function () {
            var node = btn.renderContext && btn.renderContext().shapeNode;
            if (node) {
              node.style.borderColor = borderColor;
              node.style.borderWidth = borderWidth + "px";
              node.style.borderRadius = borderRadius + "px";
              node.style.background = fill || "";
            }
          }).delay(0);
        }

        var signInBtn = new lively.morphic.Button(
          lively.rect(pad + w - 100, y, 100, 24),
          "Sign in",
        );
        signInBtn.name = "signInBtn";
        content.addMorph(signInBtn);
        paintButton(signInBtn, "rgb(240,190,210)", 1.184, 5.2, "rgb(255,240,247)");
        lively.bindings.connect(signInBtn, "fire", self, "signIn");

        var cancelBtn = new lively.morphic.Button(
          lively.rect(pad, y, 80, 24),
          "Back",
        );
        content.addMorph(cancelBtn);
        paintButton(cancelBtn, "rgb(214,214,214)", 1, 5, null);
        lively.bindings.connect(cancelBtn, "fire", self, "goBack");
      },

      // ─── navigation ─────────────────────────────────────────────────────────────

      goBack: function goBack() {
        this.remove();
        lively.require("lively.identity.AuthChoiceDialog").toRun(function () {
          lively.BuildSpec("lively.identity.AuthChoiceDialog").createMorph().openInWorldCenter();
        });
      },

      // ─── sign-in ceremony ───────────────────────────────────────────────────────

      signIn: function signIn() {
        var self = this;
        var typedHandle = (this.get("handleInput").textString || "").trim().replace(/^@/, "");
        if (!typedHandle) {
          return this.setStatus("Handle is required.", true);
        }
        // A verified domain handle (contains a dot) signs in as its account:
        // map it to the registered handle first, since this device's saved
        // credentials are keyed on that. Second pass re-enters with the result.
        if (this._resolvedFor === typedHandle) {
          typedHandle = this._resolvedHandle;
          this._resolvedFor = null;
        } else if (typedHandle.indexOf(".") !== -1) {
          this.setStatus("Looking up " + typedHandle + "…");
          var domainTyped = typedHandle;
          var again = function (registered) {
            self._resolvedFor    = domainTyped;
            self._resolvedHandle = registered || domainTyped;
            self.signIn();
          };
          fetch("/@" + encodeURIComponent(domainTyped), { credentials: "include", headers: { "Accept": "application/json" } })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) { again(j && j.registeredHandle); })
            .catch(function () { again(null); });
          return;
        }

        lively.identity.PasskeyPrimingDialog.maybeShow(function () {
          self._startAuthCeremony(typedHandle);
        });
      },

      // ─── sign-in ceremony (post-priming) ────────────────────────────────────────

      _startAuthCeremony: function _startAuthCeremony(typedHandle) {
        var self = this;
        var btn = this.get("signInBtn");
        if (btn) btn.setActive(false);
        this.setStatus("Requesting challenge…");

        fetch("/nodejs/IdentityServer/challenge", { credentials: "include" })
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (body.error) throw new Error(body.error);

            var c = lively.identity.crypto;
            var challengeBytes = c.base64urlDecode(body.challenge);
            var rpId = window.location.hostname;
            var webAuthn = lively.identity.webAuthn;

            // Decide which path based on local roster.
            webAuthn.getCredentials(function (err, records) {
              if (err) records = [];

              // Filter to credentials matching the typed handle and current rpId.
              var matching = records.filter(function (r) {
                return r.rpId === rpId && r.handle === typedHandle;
              });

              if (matching.length > 0) {
                // ── known-device path ──────────────────────────────────────
                self.setStatus("Waiting for device authentication…");
                var credentialIds = matching.map(function (r) { return r.credentialId; });
                webAuthn.authenticate(
                  { challenge: challengeBytes, rpId: rpId, credentialIds: credentialIds },
                  function (authErr, assertion) {
                    if (authErr) {
                      if (btn) btn.setActive(true);
                      return self.setStatus("Authentication cancelled: " + authErr.message, true);
                    }
                    // Pass the roster record for this credential so the POST body
                    // includes credentialPublicKeyBytes (belt-and-suspenders; server
                    // already has COSE bytes in HandleRegistry).
                    var rosterRecord = null;
                    for (var i = 0; i < matching.length; i++) {
                      if (matching[i].credentialId === assertion.credentialId) {
                        rosterRecord = matching[i];
                        break;
                      }
                    }
                    self._postAuthenticate(assertion, typedHandle, rpId, btn, rosterRecord);
                  },
                );
              } else {
                // ── new-device path ────────────────────────────────────────
                self.setStatus("No local credential found — opening device picker…");
                webAuthn.authenticate(
                  { challenge: challengeBytes, rpId: rpId, credentialIds: [] },
                  function (authErr, assertion) {
                    if (authErr) {
                      if (btn) btn.setActive(true);
                      return self.setStatus("Authentication cancelled: " + authErr.message, true);
                    }
                    self._postAuthenticateNewDevice(assertion, typedHandle, rpId, btn);
                  },
                );
              }
            });
          })
          .catch(function (e) {
            if (btn) btn.setActive(true);
            self.setStatus("Could not get challenge: " + e.message, true);
          });
      },

      // ─── known-device POST + session ────────────────────────────────────────────

      _postAuthenticate: function _postAuthenticate(assertion, handle, rpId, btn, rosterRecord) {
        var self = this;
        self.setStatus("Verifying with server…");
        var postBody = {
          handle: handle,
          credentialId: assertion.credentialId,
          authenticatorData: assertion.authenticatorData,
          clientDataJSON: assertion.clientDataJSON,
          signature: assertion.signature,
          userHandle: assertion.userHandle,
        };
        if (rosterRecord && rosterRecord.credentialPublicKeyBytes) {
          postBody.credentialPublicKeyBytes = rosterRecord.credentialPublicKeyBytes;
        }
        fetch("/nodejs/IdentityServer/authenticate", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(postBody),
        })
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (body.error) throw new Error(body.error);
            self.setStatus("Establishing session…");
            var did = lively.identity.did;
            did.completeAuthentication(
              assertion,
              {
                did: body.did,
                handle: body.handle,
                displayName: body.handle,
                credentialId: assertion.credentialId,
                rpId: rpId,
              },
              function (sessionErr) {
                if (btn) btn.setActive(true);
                if (sessionErr) {
                  return self.setStatus("Session setup failed: " + sessionErr.message, true);
                }
                self._backgroundSync(body.handle);
                self.remove();
                self._redirectAfterLogin(body.handle);
              },
            );
          })
          .catch(function (e) {
            if (btn) btn.setActive(true);
            self.setStatus("Server error: " + e.message, true);
          });
      },

      // ─── new-device POST + DID fetch + session ──────────────────────────────────

      _postAuthenticateNewDevice: function _postAuthenticateNewDevice(assertion, handle, rpId, btn) {
        var self = this;
        self.setStatus("Verifying with server…");
        fetch("/nodejs/IdentityServer/authenticate", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            handle: handle,
            credentialId: assertion.credentialId,
            authenticatorData: assertion.authenticatorData,
            clientDataJSON: assertion.clientDataJSON,
            signature: assertion.signature,
            userHandle: assertion.userHandle,
          }),
        })
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (body.error) throw new Error(body.error);

            // Fetch the DID document from the dedicated endpoint so that
            // completeAuthentication can read it via loadDocument().
            self.setStatus("Fetching identity document…");
            console.log("[LoginDialog] Fetching /@" + body.handle + "/did-document");
            return fetch("/@" + body.handle + "/did-document", { credentials: "include" })
              .then(function (res) {
                if (!res.ok) throw new Error("Could not fetch DID document for @" + body.handle + " (HTTP " + res.status + ")");
                return res.json();
              })
              .then(function (didDoc) {
                if (didDoc.error) throw new Error(didDoc.error);

                // Save to local lively.IndexedDB so completeAuthentication's
                // loadDocument() call succeeds on this new device.
                self.setStatus("Saving identity document locally…");
                var did = lively.identity.did;
                did.saveDocument(didDoc, function (saveErr) {
                  if (saveErr) {
                    if (btn) btn.setActive(true);
                    return self.setStatus("Could not save DID document: " + saveErr.message, true);
                  }

                  self.setStatus("Establishing session…");
                  did.completeAuthentication(
                    assertion,
                    {
                      did: body.did,
                      handle: body.handle,
                      displayName: body.handle,
                      credentialId: assertion.credentialId,
                      rpId: rpId,
                    },
                    function (sessionErr) {
                      if (btn) btn.setActive(true);
                      if (sessionErr) {
                        return self.setStatus("Session setup failed: " + sessionErr.message, true);
                      }
                      self._backgroundSync(body.handle);
                      self.remove();
                      self._redirectAfterLogin(body.handle);
                    },
                  );
                });
              });
          })
          .catch(function (e) {
            if (btn) btn.setActive(true);
            self.setStatus("Error: " + e.message, true);
          });
      },

      // ─── post-login sync ────────────────────────────────────────────────────────

      // Signing in lands on the account's own homestar. Someone signing in while
      // already on one of their own pages (a world, a postcard) stays put, except
      // on their homestar itself, which reloads so it renders the owner's view.
      _redirectAfterLogin: function _redirectAfterLogin(handle) {
        var path = window.location.pathname;
        var pathHandle = (path.match(/^\/@([^\/]+)/) || [])[1];
        var onOwnHomestar = pathHandle === handle && /^\/@[^\/]+\/?$/.test(path);
        if (pathHandle === handle && !onOwnHomestar) return;
        if (typeof lively !== 'undefined' && lively.Config) lively.Config.askBeforeQuit = false;
        if (onOwnHomestar) return window.location.reload();
        window.location.href = '/@' + encodeURIComponent(handle);
      },

      _backgroundSync: function _backgroundSync(handle) {
        // Pull any remote updates accumulated since the last login.
        // Non-blocking — failure is logged but does not affect the login outcome.
        lively.identity.objectStore.sync(
          handle,
          window.location.origin,
          function (err, result) {
            if (err) {
              console.warn("[Identity] Post-login sync failed:", err.message);
            } else {
              console.log("[Identity] Post-login sync:", result);
            }
          },
        );

        // NOTE: a post-login KEK warm-up (a second, auto-chained
        // navigator.credentials.get()) previously lived here and was
        // removed — it fired with no fresh user gesture, several async
        // hops downstream of the original sign-in click (session
        // establishment, IndexedDB writes), which is exactly the pattern
        // RegisterDialog.js's own delegation ceremony explicitly avoids for
        // the same reason (see its module doc comment: silently fails in
        // some browsers without a fresh click). It also doubled up the
        // WebAuthn prompt on every login even when nothing private was ever
        // opened that session. KEK derivation now happens lazily on demand
        // wherever it's actually needed (PostCardSerializer.deserializeEncrypted's
        // owner branch, FileCrypto._withKek, PostCardEditor._saveNowPrivate) —
        // each of those already prompts correctly from its own fresh click.
      },

      // ─── helpers ────────────────────────────────────────────────────────────────

      setStatus: function setStatus(msg, isError) {
        var t = this.get("statusText");
        if (!t) return;
        t.setTextString(msg || "");
        t.setTextColor(isError ? Color.rgb(204, 51, 51) : Color.rgb(153, 153, 153));
      },
    });
  }); // end module('lively.identity.LoginDialog')
