/**
 * lively.identity.IdentityVaultBridge  (singleton: lively.identity.identityVault)
 *
 * App-side client for the identity vault (Encryption.md §19.5): a cross-origin
 * <iframe> (served by IdentityServer.js at /identity-vault on its own origin,
 * IdentityVaultFrame.js inside) that holds the passkey-derived KEK and X25519
 * private key and does the operations that need them. Off unless
 * `identityVaultOrigin` is set in the config; with it unset nothing in
 * lively.identity changes behaviour.
 *
 * With the vault on, WebAuthn.deriveKek / deriveX25519KeyPair put a HANDLE
 * ({__identityVault:true, kind, credentialId}) in _kekCache / _x25519Cache where
 * raw bytes used to be. The handle is accepted anywhere the bytes were, because
 * Crypto.wrapDek / unwrapDek / encryptPayload / decryptPayload / openSealedBox
 * route a handle to this bridge. No call site had to change. The bytes never
 * enter this realm (except at registration, where this page's own ceremony
 * produced them; they are handed to the vault and replaced with a handle).
 *
 * The vault's origin must equal the RP ID host or be a subdomain of it, e.g.
 * identityRpId dev.tinylil.world -> https://vault.dev.tinylil.world. A sibling
 * origin cannot run the ceremony (browser enforces it against the frame's own
 * origin).
 *
 * Ceremony inside the frame: first tried from a plain postMessage. If the
 * browser refuses it quickly with NotAllowedError (no user activation inside the
 * frame), the frame is shown as a small overlay with an "Unlock with passkey"
 * button and the ceremony runs from that click. `identityVaultGesture: true`
 * skips the first attempt. Whether real browsers need this is UNVERIFIED (the
 * virtual authenticator never required it), see Encryption.md §19.5.
 *
 * Async pattern: thenDo(err, result), like the rest of lively.identity.*.
 */
module("lively.identity.IdentityVaultBridge")
  .requires()
  .toRun(function () {
    Object.subclass(
      "lively.identity.IdentityVaultBridge",

      "settings",
      {
        CALL_TIMEOUT_MS: 15000,
        CEREMONY_TIMEOUT_MS: 180000,
        // A NotAllowedError this fast means the browser refused the call outright
        // (no activation / policy); a user cancelling a prompt takes longer.
        GESTURE_FALLBACK_MS: 1500,
        FRAME_HIDDEN_CSS: "position:fixed;left:0;top:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none",
        FRAME_SHOWN_CSS: "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:320px;height:96px;" +
          "z-index:2147483647;border:0;border-radius:12px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,.35)",

        initialize: function () {
          this._next = 1;
          this._pending = {};
          this._frame = null;
          this._waiters = null;
          this._listening = false;
          this._importing = {};      // credentialId -> Promise (keep ops behind an import)
          this._lastRpId = {};       // credentialId -> rpId used for the last derive
        },

        _origin: function () {
          var o = lively.Config && lively.Config.get("identityVaultOrigin");
          return o ? String(o).replace(/\/+$/, "") : null;
        },

        isEnabled: function () {
          return !!this._origin();
        },

        isHandle: function (x) {
          return !!(x && x.__identityVault === true);
        },

        // The stub decryptPayload returns for the soft signing key: public half plus
        // a token for signBytes. Never contains the private scalar.
        isSigner: function (x) {
          return !!(x && x.__identityVaultSigner === true);
        },

        makeHandle: function (kind, credentialId) {
          return {
            __identityVault: true,
            kind: kind,
            credentialId: credentialId,
            toJSON: function () { return { identityVaultHandle: kind, credentialId: credentialId }; },
          };
        },
      },

      "frame",
      {
        _installListener: function () {
          if (this._listening) return;
          this._listening = true;
          var self = this;
          window.addEventListener("message", function (ev) {
            if (!self._frame || ev.source !== self._frame.contentWindow || ev.origin !== self._origin()) return;
            var m = ev.data;
            // m.keo marks the shell's own bridge replies (transport "parent"); their ids are a different counter
            if (!m || m.id === undefined || m.keo) return;
            var p = self._pending[m.id];
            if (!p) return;
            delete self._pending[m.id];
            if (m.ok) return p(null, m.result);
            var e = new Error(m.error && m.error.message || "identity vault error");
            e.name = (m.error && m.error.name) || "Error";
            p(e);
          });
        },

        // identityVaultTransport "parent": there is no iframe to create, the page that embeds this one hosts the vault.
        // A stand-in with the two members the rest of this file uses (contentWindow, style.cssText) lets the listener,
        // _send and the show/hide calls work unchanged: messages go to window.parent, and assigning the "shown" CSS
        // tells the parent to show or hide the vault's unlock button (it owns the real iframe).
        _parentFrame: function () {
          var self = this, shown = this.FRAME_SHOWN_CSS, origin = this._origin();
          return {
            contentWindow: window.parent,
            style: {
              set cssText(v) { window.parent.postMessage({ keo: 1, id: 0, op: "vault.frame", args: { shown: v === shown } }, origin); },
              get cssText() { return ""; },
            },
            parentNode: null,
          };
        },

        // Create the hidden iframe once; callers racing it share one creation.
        _withFrame: function (thenDo) {
          var self = this;
          if (this._frame) return thenDo(null, this._frame);
          if (this._waiters) { this._waiters.push(thenDo); return; }
          var origin = this._origin();
          if (!origin) return thenDo(new Error("identity vault: identityVaultOrigin is not configured"));
          if (lively.Config.get("identityVaultTransport") === "parent") {
            if (!window.parent || window.parent === window) return thenDo(new Error("identity vault: transport 'parent' needs this page to be embedded"));
            this._installListener();
            this._frame = this._parentFrame();
            return thenDo(null, this._frame);
          }
          this._waiters = [thenDo];
          this._installListener();

          var f = document.createElement("iframe");
          f.src = origin + "/identity-vault";
          f.title = "Identity vault";
          f.setAttribute("aria-hidden", "true");
          f.tabIndex = -1;
          f.setAttribute("sandbox", "allow-scripts allow-same-origin");
          // Delegates the passkey ceremony to the vault's origin. Without it the
          // browser refuses with "'publickey-credentials-get' feature is not enabled".
          f.setAttribute("allow", "publickey-credentials-get");
          f.style.cssText = this.FRAME_HIDDEN_CSS;

          var done = false;
          function settle(err) {
            if (done) return;
            done = true;
            var w = self._waiters; self._waiters = null;
            if (err) { if (f.parentNode) f.parentNode.removeChild(f); }
            else self._frame = f;
            w.forEach(function (cb) { cb(err, err ? null : f); });
          }
          f.onload = function () { settle(null); };
          setTimeout(function () { settle(new Error("identity vault: frame did not load from " + origin)); }, this.CALL_TIMEOUT_MS);
          document.body.appendChild(f);
        },

        _send: function (frame, id, op, args) {
          frame.contentWindow.postMessage({ id: id, op: op, args: args || {} }, this._origin());
        },

        // Generic RPC. thenDo(err, result). Waits for a pending import of the same
        // credential first so an op never runs ahead of the keys it needs.
        call: function (op, args, opts, thenDo) {
          if (typeof opts === "function") { thenDo = opts; opts = {}; }
          opts = opts || {};
          var self = this;
          var go = function () {
            self._withFrame(function (err, frame) {
              if (err) return thenDo(err);
              var id = self._next++;
              var timer = setTimeout(function () {
                delete self._pending[id];
                thenDo(new Error("identity vault: " + op + " timed out"));
              }, opts.timeout || self.CALL_TIMEOUT_MS);
              self._pending[id] = function (e, r) { clearTimeout(timer); thenDo(e, r); };
              self._send(frame, id, op, args);
            });
          };
          var after = !opts.noWait && args && args.credentialId && this._importing[args.credentialId];
          if (after) after.then(go, go); else go();
        },

        _showFrame: function () { if (this._frame) this._frame.style.cssText = this.FRAME_SHOWN_CSS; },
        _hideFrame: function () { if (this._frame) this._frame.style.cssText = this.FRAME_HIDDEN_CSS; },
      },

      "keys",
      {
        // Run the passkey ceremony in the vault; fills _kekCache and _x25519Cache
        // with handles. opts: { credentialId, rpId, persist, force }. thenDo(err).
        deriveKeys: function (opts, thenDo) {
          var self = this, t0 = Date.now();
          var args = { credentialId: opts.credentialId, rpId: opts.rpId, persist: !!opts.persist, force: !!opts.force };
          this._lastRpId[opts.credentialId] = opts.rpId;
          function finish(err, res) {
            if (err) return thenDo(err);
            self._fillCaches(opts.credentialId, res && res.publicKey);
            thenDo(null);
          }
          if (lively.Config && lively.Config.get("identityVaultGesture")) return this._deriveViaGesture(args, finish);
          this.call("derive", args, { timeout: this.CEREMONY_TIMEOUT_MS }, function (err, res) {
            if (err && err.name === "NotAllowedError" && Date.now() - t0 < self.GESTURE_FALLBACK_MS) {
              return self._deriveViaGesture(args, finish);
            }
            finish(err, res);
          });
        },

        // Show the frame, arm the derive, and let the user's click inside the
        // frame start the ceremony (a real activation in the frame's own document).
        _deriveViaGesture: function (args, thenDo) {
          var self = this;
          this._withFrame(function (err, frame) {
            if (err) return thenDo(err);
            var id = self._next++, armedId = id + ":armed", finished = false;
            function end(e, r) {
              if (finished) return;
              finished = true;
              clearTimeout(timer);
              delete self._pending[id]; delete self._pending[armedId];
              self._hideFrame();
              thenDo(e, r);
            }
            var timer = setTimeout(function () { end(new Error("identity vault: unlock timed out")); }, self.CEREMONY_TIMEOUT_MS);
            self._pending[id] = function (e) { if (e) end(e); else self._showFrame(); };
            self._pending[armedId] = end;
            self._send(frame, id, "arm", { op: "derive", args: args });
          });
        },

        _fillCaches: function (credentialId, publicKey) {
          var wa = lively.identity.webAuthn;
          wa.cacheKek(credentialId, this.makeHandle("kek", credentialId));
          if (publicKey) {
            wa.cacheX25519(credentialId, { publicKey: new Uint8Array(publicKey), privateKey: this.makeHandle("x25519", credentialId) });
          }
        },

        // Registration (and other flows that already hold PRF bytes in this realm):
        // hand them to the vault. `restore` puts the raw bytes back in the cache if
        // the vault cannot take them, so the old behaviour is the fallback.
        // keys: { kek?, publicKey?, privateKey? }
        adoptKeys: function (credentialId, keys, persist, restore) {
          var self = this;
          var prev = this._importing[credentialId] || Promise.resolve();
          var job = prev.then(function () {
            return new Promise(function (resolve) {
              // noWait: this call IS the pending import; waiting on it would deadlock
              self.call("importKeys", {
                credentialId: credentialId, kek: keys.kek, publicKey: keys.publicKey, privateKey: keys.privateKey, persist: !!persist,
              }, { noWait: true }, function (err) {
                if (err && restore) restore(err);
                resolve();
              });
            });
          });
          this._importing[credentialId] = job;
          job.then(function () { if (self._importing[credentialId] === job) delete self._importing[credentialId]; });
        },

        // The vault lost the keys (another tab signed out, the TTL ran out): the
        // cached handles are stale. Drop them so the next caller takes the normal
        // "not cached, prompt from a fresh click" path instead of failing forever.
        _dropStale: function (credentialId) {
          var wa = lively.identity.webAuthn;
          if (wa._kekCache && this.isHandle(wa._kekCache[credentialId])) delete wa._kekCache[credentialId];
          if (wa._x25519Cache && wa._x25519Cache[credentialId] && this.isHandle(wa._x25519Cache[credentialId].privateKey)) {
            delete wa._x25519Cache[credentialId];
          }
        },

        _op: function (handle, op, args, thenDo) {
          var self = this;
          args.credentialId = handle.credentialId;
          this.call(op, args, function (err, res) {
            if (err && err.name === "Locked") self._dropStale(handle.credentialId);
            thenDo(err, res);
          });
        },

        // ── the operations Crypto.js routes here when it is given a handle ──
        wrapDek: function (handle, thenDo) { this._op(handle, "wrapDek", {}, thenDo); },
        unwrapDek: function (wrappedDek, handle, thenDo) { this._op(handle, "unwrapDek", { wrappedDek: wrappedDek }, thenDo); },
        encryptPayload: function (payload, handle, thenDo) { this._op(handle, "encryptPayload", { payload: payload }, thenDo); },
        decryptPayload: function (ciphertext, nonce, handle, thenDo) {
          this._op(handle, "decryptPayload", { ciphertext: ciphertext, nonce: nonce }, thenDo);
        },
        openSealedBox: function (wrapped, handle, thenDo) { this._op(handle, "openSealedBox", { wrapped: wrapped }, thenDo); },
        // signer: the stub from decryptPayload. data: Uint8Array JWS signing input.
        signBytes: function (signer, data, thenDo) {
          this.call("signBytes", { credentialId: signer.credentialId, token: signer.token, data: data }, thenDo);
        },
      },

      "lifecycle",
      {
        // Page start with "Stay unlocked" on: ask the vault which credentials it
        // still holds keys for and fill the caches with handles, so the code that
        // checks _kekCache synchronously sees them. Resolves when done; never rejects.
        restoreFromVault: function () {
          var self = this;
          return new Promise(function (resolve) {
            self.call("list", {}, function (err, rows) {
              (rows || []).forEach(function (row) {
                var wa = lively.identity.webAuthn;
                if (row.kek && !(wa._kekCache && wa._kekCache[row.credentialId])) wa.cacheKek(row.credentialId, self.makeHandle("kek", row.credentialId));
                if (row.x25519 && row.publicKey && !(wa._x25519Cache && wa._x25519Cache[row.credentialId])) {
                  wa.cacheX25519(row.credentialId, { publicKey: new Uint8Array(row.publicKey), privateKey: self.makeHandle("x25519", row.credentialId) });
                }
              });
              resolve();
            });
          });
        },

        // "Stay unlocked" was just turned on: persist what the vault already holds.
        persistAll: function () {
          var self = this, wa = lively.identity.webAuthn, seen = {};
          Object.keys(wa._kekCache || {}).concat(Object.keys(wa._x25519Cache || {})).forEach(function (id) {
            if (seen[id]) return;
            seen[id] = true;
            self.call("persist", { credentialId: id }, function () {});
          });
        },

        // Sign-out / setting turned off. Always resolves.
        destroy: function () {
          var self = this;
          if (!this.isEnabled()) return Promise.resolve();
          var wa = lively.identity.webAuthn;
          ["_kekCache", "_x25519Cache"].forEach(function (name) {
            var cache = wa && wa[name];
            if (!cache) return;
            Object.keys(cache).forEach(function (id) {
              var v = cache[id];
              if (self.isHandle(v) || (v && self.isHandle(v.privateKey))) delete cache[id];
            });
          });
          return new Promise(function (resolve) {
            self.call("destroy", {}, function () { resolve(); });
          });
        },
      }
    );

    lively.identity.identityVault = new lively.identity.IdentityVaultBridge();
  }); // end module('lively.identity.IdentityVaultBridge')
