/**
 * lively.identity.RegisterDialog
 *
 * Window dialog for creating a new identity or adding a device to an existing one.
 *
 * Fresh registration flow:
 *   1. User fills handle / display name / device label
 *   2. GET  /nodejs/IdentityServer/challenge
 *   3. WebAuthn.register() → OS passkey prompt
 *   4. POST /nodejs/IdentityServer/register  (handle, did, credentialId, attestation,
 *                                              publicKeyJwk, didDocument)
 *   5. Delegation ceremony (soft signing key + KEK + X25519, via a second
 *      navigator.credentials.get()) runs automatically — no separate
 *      "Enable encryption?" button (removed 2026-07-20; this second
 *      ceremony is several async hops downstream of the original click and
 *      was once suspected of silently failing in some browsers without a
 *      fresh gesture, so it was gated behind an explicit click. Un-gated
 *      now that a recovery path exists if that ever does happen:
 *      ProfileCard.js's "Enable encryption" button (UserSpace.enableEncryption)
 *      re-runs the identical ceremony later, so a silent failure here is no
 *      longer a permanent, undiagnosable dead end for the account). Any
 *      failure here — loud or silent — is non-fatal either way: registration
 *      still completes without encryption, same as before.
 *   6. DID.completeRegistration() → local session established
 *   7. Dialog closes; MenuBarEntry updates via identityChanged signal
 *
 * Add-device flow (opened while already logged in):
 *   Handle + displayName are pre-filled and locked from the current session.
 *   Same ceremony; server upserts the handle → DID mapping.
 *   Full multi-device DID document merging is a future iteration.
 *
 * Async convention: thenDo(err, result) → matches the rest of lively.identity.
 *
 * Dependencies:
 *   lively.identity.DID      — didFromJwk, buildDocument, completeRegistration, isLoggedIn
 *   lively.identity.WebAuthn — register()
 *   lively.identity.Crypto   — base64urlDecode (via WebAuthn module)
 */

module("lively.identity.RegisterDialog")
  .requires(
    "lively.identity.DID",
    "lively.identity.WebAuthn",
    "lively.identity.UserSpace",
    "lively.identity.LocalIdentity",
    "lively.identity.PasskeyPrimingDialog",
    "lively.persistence.BuildSpec",
    "lively.morphic.Complete",
  )
  .toRun(function () {
    lively.BuildSpec("lively.identity.RegisterDialog", {
      _BorderRadius: 7,
      _Extent: lively.pt(400, 286),
      _Fill: Color.rgb(255, 16, 144),
      _ZIndex: 1000,      // above every other morph, as in LoginDialog
      className: "lively.morphic.Window",
      contentOffset: lively.pt(3, 22),
      draggingEnabled: true,
      droppingEnabled: false,
      layout: { adjustForNewBounds: true },
      name: "IdentityRegisterDialog",
      titleBar: "Create identity",
      submorphs: [
        {
          _Extent: lively.pt(394, 258),
          _Fill: Color.rgb(250, 250, 250),
          _Position: lively.pt(3, 22),
          className: "lively.morphic.Box",
          layout: {
            adjustForNewBounds: true,
            resizeHeight: true,
            resizeWidth: true,
          },
          name: "registerContent",
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
        var content = this.get("registerContent");
        if (!content) return;
        content.removeAllMorphs();

        // Inside the keo app there is no server to register with: the identity
        // is made on this device (LocalIdentity), without a handle.
        this._isLocal = lively.identity.localIdentity.isAvailable();
        if (this._isLocal) return this.buildLocalForm(content);

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

        addLabel("Handle (a–z, 0–9, underscore, max 32 chars):");
        addInput("handleInput");

        addLabel("Display name (optional):");
        addInput("displayNameInput");

        addLabel("Device label (optional, auto-detected if left blank):");
        addInput("deviceLabelInput");

        y += 2;
        var statusText = new lively.morphic.Text(
          lively.rect(pad, y, w, 28),
          "",
        );
        statusText.name = "statusText";
        statusText.applyStyle({ allowInput: false, fontSize: 11, fill: null, borderWidth: 0, borderColor: null });
        content.addMorph(statusText);
        y += 36;

        var isAddDevice = !!(lively.identity.did && lively.identity.did.isLoggedIn());

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

        var regBtn = new lively.morphic.Button(
          lively.rect(pad + w - 100, y, 100, 24),
          "Register",
        );
        regBtn.name = "registerBtn";
        content.addMorph(regBtn);
        paintButton(regBtn, "rgb(240,190,210)", 1.184, 5.2, "rgb(255,240,247)");
        lively.bindings.connect(regBtn, "fire", self, "register");

        var cancelBtn = new lively.morphic.Button(
          lively.rect(pad, y, 80, 24),
          "Back",
        );
        cancelBtn.name = "registerCancelBtn";
        content.addMorph(cancelBtn);
        paintButton(cancelBtn, "rgb(214,214,214)", 1, 5, null);
        lively.bindings.connect(cancelBtn, "fire", self, "goBack");

        this._isAddDevice = isAddDevice;
        this.setTitle(isAddDevice ? "Create new Passkey" : "Create identity");

        // Pre-fill and lock handle + displayName when adding a device to an
        // existing session. The server treats this as an upsert on the handle.
        if (isAddDevice) {
          var user = lively.identity.did.currentUser();
          var lockedStyle = {
            allowInput: false,
            fill: Color.rgb(240, 240, 240),
            textColor: Color.rgb(120, 120, 120),
          };
          this.get("handleInput").setTextString(user.handle);
          this.get("handleInput").applyStyle(lockedStyle);
          this.get("displayNameInput").setTextString(user.displayName || "");
          this.get("displayNameInput").applyStyle(lockedStyle);
        }
      },

      // The keo-app form: one field, the user's own name for the identity on
      // this device (changeable later, never sent anywhere). Same look as the
      // server form above; its small helpers are repeated here rather than
      // shared because a BuildSpec method cannot reach a sibling method's
      // local functions.
      buildLocalForm: function buildLocalForm(content) {
        var self = this;
        var pad = 14;
        var y = pad;
        var w = content.getExtent().x - pad * 2;

        var lbl = new lively.morphic.Text(lively.rect(pad, y, w, 16), "webName for this identity (only you see it):");
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
        y += 22;

        var inp = new lively.morphic.Text(lively.rect(pad, y, w, 22), "");
        inp.name = "labelInput";
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
        y += 34;

        // 18px per rendered line (CLAUDE.md: a guessed per-line height undershoots and clips the last line)
        var note = new lively.morphic.Text(
          lively.rect(pad, y, w, 3 * 18 + 4),
          "Created on this device with your passkey and kept here. Nothing is sent to a server. " +
          "A handle comes later, if a host you register with gives you one.",
        );
        note.applyStyle({
          allowInput: false,
          fontFamily: "Arial, sans-serif",
          fontSize: 9,
          textColor: Color.rgb(120, 120, 120),
          padding: lively.rect(4, 3, 0, 0),
          fill: null,
          borderWidth: 0,
          borderColor: null,
        });
        content.addMorph(note);
        y += 3 * 18 + 8;

        // room for two lines: the success message ("Created … Not recoverable yet: …") wraps
        var statusText = new lively.morphic.Text(lively.rect(pad, y, w, 2 * 18 + 8), "");
        statusText.name = "statusText";
        statusText.applyStyle({ allowInput: false, fontSize: 11, fill: null, borderWidth: 0, borderColor: null });
        content.addMorph(statusText);
        y += 2 * 18 + 16;

        function paintButton(btn, borderColor, borderWidth, borderRadius, fill) {
          // see the identical helper in buildForm for why the DOM is written too
          btn.applyStyle({ borderColor: borderColor, borderWidth: borderWidth, borderRadius: borderRadius, fill: fill });
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

        var createBtn = new lively.morphic.Button(lively.rect(pad + w - 100, y, 100, 24), "Create");
        createBtn.name = "registerBtn";
        content.addMorph(createBtn);
        paintButton(createBtn, "rgb(240,190,210)", 1.184, 5.2, "rgb(255,240,247)");
        lively.bindings.connect(createBtn, "fire", self, "register");

        var cancelBtn = new lively.morphic.Button(lively.rect(pad, y, 80, 24), "Back");
        cancelBtn.name = "registerCancelBtn";
        content.addMorph(cancelBtn);
        paintButton(cancelBtn, "rgb(214,214,214)", 1, 5, null);
        lively.bindings.connect(cancelBtn, "fire", self, "goBack");

        this._isAddDevice = false;
        this.setTitle("Create identity");
      },

      // ─── navigation ─────────────────────────────────────────────────────────────

      goBack: function goBack() {
        this.remove();
        // Add-device mode is opened from the menu bar while already signed
        // in -- there's no "Start" chooser screen to return to, so Back
        // there is just a dismiss (matching the old Cancel behavior).
        if (this._isAddDevice) return;
        lively.require("lively.identity.AuthChoiceDialog").toRun(function () {
          lively.BuildSpec("lively.identity.AuthChoiceDialog").createMorph().openInWorldCenter();
        });
      },

      // ─── registration ceremony ──────────────────────────────────────────────────

      register: function register() {
        var self = this;
        if (this._isLocal) return this._createLocal();

        var handle =(this.get("handleInput").textString || "").trim();
        var displayName = (
          this.get("displayNameInput").textString || ""
        ).trim();
        var deviceLabel = (this.get("deviceLabelInput").textString || "").trim();
        if (!deviceLabel) {
          // auto-detect OS + browser from user agent
          var ua = navigator.userAgent;
          var os = 'Unknown OS';
          if      (/iPad/.test(ua))                      os = 'iPadOS';
          else if (/iPhone|iPod/.test(ua))               os = 'iOS';
          else if (/Android/.test(ua))                   os = 'Android';
          else if (/CrOS/.test(ua))                      os = 'ChromeOS';
          else if (/Mac OS X/.test(ua))                  os = 'macOS';
          else if (/Windows/.test(ua))                   os = 'Windows';
          else if (/Linux/.test(ua))                     os = 'Linux';
          var browser = 'Browser';
          if      (/Edg\//.test(ua))                     browser = 'Edge';
          else if (/OPR\/|Opera/.test(ua))               browser = 'Opera';
          else if (/Chrome\//.test(ua))                  browser = 'Chrome';
          else if (/Firefox\//.test(ua))                 browser = 'Firefox';
          else if (/Safari\//.test(ua))                  browser = 'Safari';
          else if (/SamsungBrowser/.test(ua))            browser = 'Samsung';
          deviceLabel = os + ' · ' + browser;
        }

        if (!handle) {
          return this.setStatus("Handle is required.", true);
        }
        if (!/^[a-z0-9_]{1,32}$/.test(handle)) {
          return this.setStatus(
            "Handle must be 1–32 characters: a–z, 0–9, underscore only.",
            true,
          );
        }

        lively.identity.PasskeyPrimingDialog.maybeShow(function () {
          self._startRegisterCeremony(handle, displayName, deviceLabel);
        });
      },

      // ─── local creation (keo app) ───────────────────────────────────────────────

      // Asks the shell to make the identity (two passkey prompts: create the
      // passkey, then sign the inception with it). When nobody was signed in,
      // the shell starts the session for the new identity itself, and the
      // dialog then asks the shell to open its landing page (a new identity
      // has no saved world, so its home page). When someone IS signed in (the
      // account dialog offers this too) the session stays theirs and the
      // dialog only says what was made. The button stays off so a second
      // click cannot create a second identity.
      _createLocal: function _createLocal() {
        var self = this;
        var btn = this.get("registerBtn");
        var label = (this.get("labelInput").textString || "").trim();
        lively.identity.PasskeyPrimingDialog.maybeShow(function () {
          if (btn) btn.setActive(false);
          self.setStatus("Waiting for your passkey…");
          lively.identity.localIdentity.create(label, function (err, id) {
            if (err) {
              if (btn) btn.setActive(true);
              return self.setStatus("Could not create the identity: " + (err.message || err), true);
            }
            self.setStatus(
              "Created " + id.label + " (" + lively.identity.localIdentity.shortDid(id.did) + ") on this device." +
              (id.notRecoverable ? " Not recoverable yet: add a second passkey later." : "")
            );
            // the session returned is whoever is signed in now: only enter when that is the identity just made
            if (id.session && id.session.did === id.did) {
              lively.identity.localIdentity.go("enter", undefined, function (goErr) {
                if (goErr) self.setStatus("Created, but could not open the page: " + (goErr.message || goErr), true);
              });
            }
          });
        });
      },

      // ─── registration ceremony (post-priming) ───────────────────────────────────

      _startRegisterCeremony: function _startRegisterCeremony(handle, displayName, deviceLabel) {
        var self = this;
        var btn = this.get("registerBtn");
        if (btn) btn.setActive(false);
        this.setStatus("Requesting challenge…");

        var rpId = window.location.hostname;
        var crypto = lively.identity.crypto;
        var did = lively.identity.did;
        var webAuthn = lively.identity.webAuthn;

        // Step 1: get a fresh challenge from the server
        fetch("/nodejs/IdentityServer/challenge", { credentials: "include" })
          .then(function (res) {
            return res.json();
          })
          .then(function (body) {
            if (body.error) throw new Error(body.error);

            var challengeBytes = crypto.base64urlDecode(body.challenge);
            self.setStatus("Waiting for device authentication…");

            // Step 2: WebAuthn passkey ceremony (OS prompt)
            webAuthn.register(
              {
                handle: handle,
                displayName: displayName || handle,
                rpId: rpId,
                rpName: "Lively",
                challenge: challengeBytes,
                requestPrf: true,
              },
              function (err, reg) {
                if (err) {
                  if (btn) btn.setActive(true);
                  return self.setStatus(
                    "Registration cancelled: " + err.message,
                    true,
                  );
                }

                self.setStatus("Verifying with server…");

                // Step 3: build the DID document client-side so we can include it
                // in the POST body. completeRegistration rebuilds it locally too —
                // the server copy is used for .well-known resolution and by other
                // devices that don't have a local DID document yet.
                var derivedDid = did.didFromJwk(reg.publicKeyJwk);
                var document = did.buildDocument({
                  did: derivedDid,
                  publicKeyJwk: reg.publicKeyJwk,
                  credentialId: reg.credentialId,
                  deviceLabel: deviceLabel,
                  handle: handle,
                });

                // Step 4: register with the server (verifies attestation, saves
                // credential COSE bytes and handle → DID mapping)
                fetch("/nodejs/IdentityServer/register", {
                  method: "POST",
                  credentials: "include",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    handle: handle,
                    did: derivedDid,
                    credentialId: reg.credentialId,
                    attestationObject: reg.attestationObject,
                    clientDataJSON: reg.clientDataJSON,
                    publicKeyJwk: reg.publicKeyJwk,
                    credentialPublicKeyBytes: reg.credentialPublicKeyBytes,
                    didDocument: document,
                  }),
                })
                  .then(function (res) {
                    return res.json();
                  })
                  .then(function (serverBody) {
                    if (serverBody.error) throw new Error(serverBody.error);
                    self.setStatus("Generating device signing key…");

                    // Step 5: generate soft signing key + delegation cert + KEK + X25519
                    // All in one combined WebAuthn ceremony so the user sees only
                    // one additional prompt after the registration passkey prompt.
                    crypto.generateSigningKeyPair(function (err, softKeyPair) {
                      if (err) {
                        console.warn('[RegisterDialog] Could not generate soft key pair:', err);
                        return finishRegistration(serverBody, null, null, null);
                      }

                      crypto.exportPublicKeyJwk(softKeyPair.publicKey, function (err, devicePubKeyJwk) {
                        if (err) {
                          console.warn('[RegisterDialog] Could not export soft public key:', err);
                          return finishRegistration(serverBody, null, null, null);
                        }

                        var issuedAt = new Date().toISOString();
                        var delegationPayload = {
                          devicePubKeyJwk: devicePubKeyJwk,
                          credentialId: reg.credentialId,
                          issuedAt: issuedAt
                        };
                        // Compute H(delegationPayload) as the ceremony challenge
                        crypto.sha256(crypto.canonicalJson(delegationPayload), function (err, digestB64) {
                          if (err) {
                            console.warn('[RegisterDialog] Could not hash delegation payload:', err);
                            return finishRegistration(serverBody, null, null, null);
                          }

                          var certChallenge = crypto.base64urlDecode(digestB64);
                          var prfKekInput = new TextEncoder().encode('lively-kek-v1');
                          var prfX25519Input = new TextEncoder().encode('lively-x25519:' + reg.credentialId);

                          self.setStatus("Passkey registered. Setting up encryption…");

                          // Auto-chained (2026-07-20 — see module doc comment for
                          // why this no longer waits for a separate "Enable
                          // encryption?" click). Combined ceremony: delegation
                          // sig + KEK + X25519 private key, one prompt.
                          navigator.credentials.get({
                            publicKey: {
                              challenge: certChallenge,
                              rpId: rpId,
                              allowCredentials: [{
                                type: 'public-key',
                                id: crypto.base64urlDecode(reg.credentialId)
                              }],
                              userVerification: 'required',
                              extensions: {
                                prf: {
                                  eval: {
                                    first:  prfKekInput.buffer,
                                    second: prfX25519Input.buffer
                                  }
                                }
                              }
                            }
                          }).then(function (credential) {
                            var assertion = credential.response;
                            var ext = credential.getClientExtensionResults();
                            var c = crypto;

                            // Build delegation cert from assertion
                            var delegationCert = {
                              devicePubKeyJwk: devicePubKeyJwk,
                              credentialId: reg.credentialId,
                              issuedAt: issuedAt,
                              authenticatorData: c.base64urlEncode(new Uint8Array(assertion.authenticatorData)),
                              clientDataJSON:    c.base64urlEncode(new Uint8Array(assertion.clientDataJSON)),
                              signature:         c.base64urlEncode(new Uint8Array(assertion.signature))
                            };

                            var prfResults = ext && ext.prf && ext.prf.results;
                            if (!prfResults || !prfResults.first) {
                              console.warn('[RegisterDialog] PRF not available — KEK and X25519 skipped');
                              return finishRegistration(serverBody, delegationCert, null, null, softKeyPair);
                            }

                            var kek = new Uint8Array(prfResults.first);
                            // Cache the KEK for this session
                            lively.identity.webAuthn.cacheKek(reg.credentialId, kek);

                            // Wrap soft private key with KEK
                            crypto.exportPrivateKeyJwk(softKeyPair.privateKey, function (err, softPrivJwk) {
                              if (err) {
                                console.warn('[RegisterDialog] Could not export soft private key:', err);
                                return finishRegistration(serverBody, delegationCert, null, null, softKeyPair);
                              }
                              crypto.wrapDek(kek, function (err, wrapped) {
                                // Note: wrapDek wraps random bytes; here we need to wrap
                                // the soft private key JWK. We encrypt it with encryptPayload instead.
                                // The spec says "KEK-wrapped like everything else" — use encryptPayload
                                // with the KEK as the symmetric key.
                                crypto.encryptPayload(softPrivJwk, kek, function (err, enc) {
                                  if (err) {
                                    console.warn('[RegisterDialog] Could not wrap soft private key:', err);
                                    return finishRegistration(serverBody, delegationCert, null, null, softKeyPair);
                                  }
                                  var softSigningKeyWrapped = JSON.stringify({ ciphertext: enc.ciphertext, nonce: enc.nonce });

                                  // Derive X25519 keypair from PRF second output (if available)
                                  var x25519Pub = null;
                                  if (prfResults.second) {
                                    lively.identity.crypto.withSodium(function (err, sodium) {
                                      if (err || !sodium) {
                                        return finishRegistration(serverBody, delegationCert, softSigningKeyWrapped, null, softKeyPair);
                                      }
                                      try {
                                        var privBytes = new Uint8Array(prfResults.second);
                                        // X25519 private key clamping (RFC 7748)
                                        privBytes[0]  &= 248;
                                        privBytes[31] &= 127;
                                        privBytes[31] |= 64;
                                        var pubBytes = sodium.crypto_scalarmult_base(privBytes);
                                        x25519Pub = sodium.to_base64(pubBytes, sodium.base64_variants.URLSAFE_NO_PADDING);
                                        finishRegistration(serverBody, delegationCert, softSigningKeyWrapped, x25519Pub, softKeyPair);
                                      } catch (e) {
                                        console.warn('[RegisterDialog] X25519 derivation failed:', e);
                                        finishRegistration(serverBody, delegationCert, softSigningKeyWrapped, null, softKeyPair);
                                      }
                                    });
                                  } else {
                                    finishRegistration(serverBody, delegationCert, softSigningKeyWrapped, null, softKeyPair);
                                  }
                                });
                              });
                            });
                          }).catch(function (e) {
                            // e.name (e.g. NotAllowedError) matters as much as
                            // e.message for diagnosing browser-specific failures —
                            // logged separately since DOMException.toString()
                            // doesn't always include it.
                            console.warn('[RegisterDialog] Delegation ceremony failed (non-fatal):', e.name + ': ' + e.message);
                            // Surface it in the dialog itself (not just console) —
                            // previously this degraded to public-only registration
                            // with zero visible indication anything had gone wrong.
                            // Held for 3s before continuing so it's actually
                            // readable, not just flashed before the redirect.
                            self.setStatus(
                              'Encryption setup failed (' + e.name + ') — continuing without it.',
                              true,
                            );
                            setTimeout(function () {
                              finishRegistration(serverBody, null, null, null, null);
                            }, 3000);
                          });
                        });
                      });
                    });

                    // Step 6: establish session with delegation cert fields
                    function finishRegistration(serverBody, delegationCert, softSigningKeyWrapped, accountX25519Pub) {
                      self.setStatus("Establishing session…");
                      did.completeRegistration(
                        reg,
                        {
                          handle: handle,
                          displayName: displayName || handle,
                          deviceLabel: deviceLabel,
                          delegationCert:        delegationCert       || undefined,
                          softSigningKeyWrapped:  softSigningKeyWrapped || undefined,
                          accountX25519Pub:       accountX25519Pub      || undefined,
                        },
                        function (sessionErr) {
                          if (btn) btn.setActive(true);
                          if (sessionErr) {
                            return self.setStatus(
                              "Session setup failed: " + sessionErr.message,
                              true,
                            );
                          }

                          // Only navigate away (or close the dialog) after the
                          // profile-publish step below has actually settled — it
                          // used to fire-and-forget straight into
                          // window.location.href, and navigating away cancels an
                          // in-flight fetch in most browsers. That silently killed
                          // the profile PUT mid-chain (GET profile → compute CID →
                          // sign → PUT) before it ever reached the server, with no
                          // error surfaced anywhere. Confirmed as a second,
                          // independent cause of postcard_fixes_tranche3.md's
                          // "still shows no encryption" report (alongside the
                          // DID-document sync gap fixed in DID.js#saveDocument).
                          function proceed() {
                            // homeWorldObjId is only in the response for a brand-new
                            // account; adding a device to an existing one stays put.
                            if (serverBody.homeWorldObjId) {
                              if (typeof lively !== 'undefined' && lively.Config) lively.Config.askBeforeQuit = false;
                              window.location.href = "/@" + encodeURIComponent(handle);
                            } else {
                              self.remove();
                            }
                          }

                          // If we have accountX25519Pub, save it to the profile —
                          // this is the profile object other users' clients read
                          // accountX25519Pub from before sealing a shared postcard's
                          // DEK to it. Delegates to UserSpace.saveProfile (2026-07-20:
                          // previously a fourth hand-rolled copy of GET → patch →
                          // recompute cid → sign → PUT lived here, flagged in this
                          // same comment as needing unification since at least F21/F6
                          // — and independently confirmed to occasionally lose the
                          // write silently, e.g. @ipod's registration, root cause
                          // never pinned down. saveProfile is the same logic other
                          // callers (ProfileCard.js, UserSpace.enableEncryption)
                          // already exercise, so any future fix benefits every
                          // caller instead of only the copy that got noticed).
                          if (accountX25519Pub) {
                            lively.identity.userSpace.saveProfile({ accountX25519Pub: accountX25519Pub }, function (err) {
                              if (err) console.warn('[RegisterDialog] Could not save X25519 pub to profile:', err.message);
                              proceed();
                            });
                          } else {
                            proceed();
                          }
                        },
                      );
                    }
                  })
                  .catch(function (serverErr) {
                    if (btn) btn.setActive(true);
                    self.setStatus("Server error: " + serverErr.message, true);
                  });
              },
            );
          })
          .catch(function (e) {
            if (btn) btn.setActive(true);
            self.setStatus("Could not get challenge: " + e.message, true);
          });
      },

      // ─── helpers ────────────────────────────────────────────────────────────────

      setStatus: function setStatus(msg, isError) {
        var t = this.get("statusText");
        if (!t) return;
        t.setTextString(msg || "");
        t.setTextColor(isError ? Color.rgb(204, 51, 51) : Color.rgb(153, 153, 153));
      },
    });
  }); // end module('lively.identity.RegisterDialog')
