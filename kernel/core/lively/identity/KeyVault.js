/**
 * lively.identity.KeyVault
 *
 * Opt-in: keeps the passkey-derived keys (KEK, X25519 pair) usable across page
 * loads in one browser tab, so a `location.href` navigation or a reload does not
 * force a new passkey prompt. Off by default. See Encryption.md §19.
 *
 * How it works:
 *   - A NON-EXTRACTABLE AES-GCM "device key" is generated once and stored in
 *     IndexedDB (database `lively-keyvault`). Script can use it but cannot read it.
 *   - Each secret is encrypted with it and the blob is stored in sessionStorage
 *     (`lively.kv1:<slot>` = {v, exp, iv, ct}). sessionStorage is per tab and is
 *     cleared when the tab closes.
 *   - AAD = "lively-kv1|<slot>|<exp>", so a blob cannot be moved to another slot
 *     and its expiry cannot be extended: both fail authentication.
 *   - Every failure (missing, expired, tampered, device key gone) drops the blob
 *     and resolves null. Nothing here throws into the caller.
 *
 * What it does NOT do (Encryption.md §19.2): it does not stop script running in
 * this origin from calling recall() — the same script can already read
 * WebAuthn._kekCache. After recall() the key is plain bytes in memory again.
 * What it adds is: the stored blob alone is useless, and persistence ends with
 * the tab, the TTL, sign-out, or turning the setting off.
 *
 * Tested (not in the repo's e2e): Chromium, Chrome, Firefox, WebKit — see
 * tests/e2e/key-vault.spec.js.
 *
 * Slots: "kek:<credentialId>" (32 bytes), "x25519:<credentialId>" (64 bytes:
 * public || private).
 */
module("lively.identity.KeyVault")
  .requires()
  .toRun(function () {
    Object.subclass(
      "lively.identity.KeyVault",

      "settings",
      {
        DB_NAME: "lively-keyvault",
        STORE: "keys",
        DEVICE_KEY: "device-v1",
        PREFIX: "lively.kv1:",
        PREF_KEY: "lively.keyVault.enabled",
        // Absolute lifetime of a stored blob, counted from when it was stored.
        TTL_MS: 8 * 60 * 60 * 1000,

        isSupported: function () {
          try {
            return !!(window.crypto && crypto.subtle && window.indexedDB && window.sessionStorage);
          } catch (e) {
            return false;
          }
        },

        // The preference is per browser (localStorage), default off.
        isEnabled: function () {
          try {
            return this.isSupported() && window.localStorage.getItem(this.PREF_KEY) === "1";
          } catch (e) {
            return false;
          }
        },

        // Turning it off also destroys the device key, which makes every stored
        // blob in every tab unreadable at once. Resolves true on success.
        setEnabled: function (on) {
          var self = this;
          try {
            if (on) {
              if (!this.isSupported()) return Promise.resolve(false);
              window.localStorage.setItem(this.PREF_KEY, "1");
              return Promise.resolve(true);
            }
            window.localStorage.removeItem(this.PREF_KEY);
          } catch (e) {
            return Promise.resolve(false);
          }
          return this.destroy().then(function () { return true; });
        },
      },

      "storage",
      {
        _openDb: function () {
          var self = this;
          return new Promise(function (resolve, reject) {
            var req = indexedDB.open(self.DB_NAME, 1);
            req.onupgradeneeded = function () { req.result.createObjectStore(self.STORE); };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error); };
          });
        },

        _tx: function (db, mode, fn) {
          var self = this;
          return new Promise(function (resolve, reject) {
            var t = db.transaction(self.STORE, mode);
            var out = fn(t.objectStore(self.STORE));
            t.oncomplete = function () { db.close(); resolve(out && out.result); };
            t.onerror = t.onabort = function () { db.close(); reject(t.error); };
          });
        },

        // Atomic get-or-create. The new key is generated BEFORE the transaction
        // (a transaction cannot await), then get+put run in one readwrite
        // transaction, so two tabs racing on first use end up sharing whichever
        // key committed first.
        _deviceKey: function (create) {
          var self = this;
          return this._openDb().then(function (db) {
            return self._tx(db, "readonly", function (s) { return s.get(self.DEVICE_KEY); });
          }).then(function (existing) {
            if (existing || !create) return existing || null;
            return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
              .then(function (fresh) {
                return self._openDb().then(function (db) {
                  return new Promise(function (resolve, reject) {
                    var t = db.transaction(self.STORE, "readwrite");
                    var s = t.objectStore(self.STORE);
                    var winner = fresh;
                    var g = s.get(self.DEVICE_KEY);
                    g.onsuccess = function () {
                      if (g.result) winner = g.result; else s.put(fresh, self.DEVICE_KEY);
                    };
                    t.oncomplete = function () { db.close(); resolve(winner); };
                    t.onerror = t.onabort = function () { db.close(); reject(t.error); };
                  });
                });
              });
          });
        },

        _aad: function (slot, exp) {
          return new TextEncoder().encode("lively-kv1|" + slot + "|" + exp);
        },

        _b64: function (u8) {
          var s = "";
          for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
          return btoa(s);
        },

        _unb64: function (str) {
          var b = atob(str), u = new Uint8Array(b.length);
          for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
          return u;
        },
      },

      "api",
      {
        // Store `bytes` (Uint8Array) under `slot` if the setting is on.
        // Resolves true when stored, false otherwise (never rejects). The caller
        // keeps ownership of `bytes`.
        remember: function (slot, bytes) {
          var self = this;
          if (!this.isEnabled()) return Promise.resolve(false);
          var exp = Date.now() + this.TTL_MS;
          var iv = crypto.getRandomValues(new Uint8Array(12));
          return this._deviceKey(true).then(function (dk) {
            return crypto.subtle.encrypt({ name: "AES-GCM", iv: iv, additionalData: self._aad(slot, exp) }, dk, bytes);
          }).then(function (ct) {
            sessionStorage.setItem(self.PREFIX + slot, JSON.stringify({
              v: 1, exp: exp, iv: self._b64(iv), ct: self._b64(new Uint8Array(ct)),
            }));
            return true;
          }).catch(function (e) {
            console.warn("[KeyVault] could not store " + slot.split(":")[0] + ": " + (e && e.message));
            return false;
          });
        },

        // -> Uint8Array | null. Drops the blob on any failure.
        recall: function (slot) {
          var self = this;
          if (!this.isEnabled()) return Promise.resolve(null);
          var key = this.PREFIX + slot, raw, blob;
          function drop() { try { sessionStorage.removeItem(key); } catch (e) {} return null; }
          try { raw = sessionStorage.getItem(key); } catch (e) { return Promise.resolve(null); }
          if (!raw) return Promise.resolve(null);
          try { blob = JSON.parse(raw); } catch (e) { return Promise.resolve(drop()); }
          if (!blob || blob.v !== 1 || typeof blob.exp !== "number" || Date.now() >= blob.exp) {
            return Promise.resolve(drop());
          }
          return this._deviceKey(false).then(function (dk) {
            if (!dk) return drop();
            return crypto.subtle.decrypt(
              { name: "AES-GCM", iv: self._unb64(blob.iv), additionalData: self._aad(slot, blob.exp) },
              dk, self._unb64(blob.ct)
            ).then(function (pt) { return new Uint8Array(pt); }, drop);
          }).catch(drop);
        },

        // -> { slot: Uint8Array } for every blob that still decrypts.
        recallAll: function () {
          var self = this, slots = [];
          if (!this.isEnabled()) return Promise.resolve({});
          try {
            for (var i = 0; i < sessionStorage.length; i++) {
              var k = sessionStorage.key(i);
              if (k && k.indexOf(this.PREFIX) === 0) slots.push(k.slice(this.PREFIX.length));
            }
          } catch (e) {
            return Promise.resolve({});
          }
          var out = {};
          return Promise.all(slots.map(function (slot) {
            return self.recall(slot).then(function (b) { if (b) out[slot] = b; });
          })).then(function () { return out; });
        },

        forget: function (slot) {
          try { sessionStorage.removeItem(this.PREFIX + slot); } catch (e) {}
        },

        // Remove every blob in this tab. Does not touch the device key.
        forgetAll: function () {
          try {
            var keys = [];
            for (var i = 0; i < sessionStorage.length; i++) {
              var k = sessionStorage.key(i);
              if (k && k.indexOf(this.PREFIX) === 0) keys.push(k);
            }
            keys.forEach(function (k) { sessionStorage.removeItem(k); });
          } catch (e) {}
        },

        // Forget everything AND delete the device key, so blobs in every other
        // tab become unreadable too. Used on sign-out and when the setting is
        // turned off. Always resolves; never rejects.
        destroy: function () {
          var self = this;
          this.forgetAll();
          // With the identity vault the persisted keys live in the vault's own
          // origin; sign-out and turning the setting off must wipe them too.
          var vault = lively.identity.identityVault;
          if (vault && vault.isEnabled()) vault.destroy();
          if (!this.isSupported()) return Promise.resolve();
          return this._openDb().then(function (db) {
            return self._tx(db, "readwrite", function (s) { return s["delete"](self.DEVICE_KEY); });
          }).then(function () {}, function () {});
        },
      }
    );

    lively.identity.keyVault = new lively.identity.KeyVault();
  }); // end module('lively.identity.KeyVault')
