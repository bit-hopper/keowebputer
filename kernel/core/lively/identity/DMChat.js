/**
 * core/lively/identity/DMChat.js
 *
 * P2P E2EE direct messages — the design in p2pchat.md (repo root). Two
 * delivery paths, chosen per-send (p2pchat.md §5a): a live WebRTC data
 * channel when the recipient is already connected to DM signaling this
 * session (near-instant), falling back to the store-and-forward mailbox
 * (p2pchat.md §6) otherwise — same envelope shape and the same
 * decrypt/verify/persist path either way (_processEnvelope), so the two
 * transports are interchangeable from the receiving side. Every message
 * goes end-to-end encrypted either way — there is no plaintext-relay
 * fallback, and the live path is defense-in-depth on top of an already-
 * DTLS-encrypted data channel, not a relaxation of it.
 *
 * Crypto (p2pchat.md §4, "one encryption plane" per Encryption.md):
 *   - Confidentiality: lively.identity.crypto.sealForRecipient/openSealedBox
 *     (X25519 sealed box, the same primitive postcards/files already use
 *     for DEK-wrapping) — no new crypto primitive introduced.
 *   - Authenticity: a real JWS signature by the sender's soft signing key
 *     (mirrors PostCardSerializer.js's own _signEnvelopeIfPossible), since
 *     sealForRecipient alone is an anonymous sealed box with no sender
 *     binding (confirmed by reading Crypto.js).
 *   - Gate: friend-gated server-side (FriendRegistry.areFriends) on both
 *     the mailbox POST and DM signaling's presence-check/offer — nothing
 *     new to design for "who can message whom," per p2pchat.md §1.
 *
 * Storage: IndexedDB only (p2pchat.md §7) — the server-side mailbox row is
 * deleted as soon as a message is decrypted and saved locally. No
 * cross-device history sync (same accepted limitation Encryption.md §9
 * already carries for postcards/files' per-device X25519 keys).
 *
 * UI: classic lively.morphic.Window chrome (proven drag/resize/close —
 * see the note below on why a from-scratch custom window shell was NOT
 * used here), now styled per the codebase-wide "wiki icon controls"
 * window-chrome convention (LivelyMorphic.md §8): the window's own _Fill
 * is the accent color and shows through the (transparent-by-default)
 * title bar as a matte frame around an inset, lighter content pane —
 * close/collapse/menu already render as Material Symbols icon buttons
 * for every classic Window by default (Widgets.js), no per-window work
 * needed for that part. DMChat.applyAccentChrome (below) only adds the
 * one thing the convention doesn't cover declaratively: white title text
 * + suppressing the base theme's focus-ring border, both CSS-only. Reusing
 * Window's own title bar/close/drag avoids re-deriving two things this
 * codebase has already had to debug the hard way: (a) WarpDrop.md's
 * bringToFront/remove() teardown-ordering trap — addMorph() calls
 * remove() on a morph that already has an owner (confirmed by reading
 * Core.js:284), so any custom close/remove teardown here would hit the
 * exact same hazard the moment .comeForward() is called right after
 * creation; (b) reinventing title-bar-drag-only dragging correctly. Both
 * are real, verifiable-later follow-ups if a fully custom window shell is
 * wanted, not skipped by accident.
 */

module('lively.identity.DMChat')
  .requires(
    'lively.identity.Crypto',
    'lively.identity.DID',
    'lively.identity.WebAuthn',
    'lively.identity.PostCardUtils',
    'lively.persistence.BuildSpec',
  )
  .toRun(function () {

    Object.extend(lively.identity.DMChat, {

      // ─── window registry ────────────────────────────────────────────────

      _windows: {},       // peerHandle -> content-box morph
      _inboxWindow: null, // content-box morph
      _pollTimerId: null,
      _myDevicePub: null,       // cached for the session once fetched
      _didDocCache: {},         // handle -> DID document, cached for the session

      // ─── visual constants (2026-09-10 design pass) ─────────────────────
      // Named here, on the namespace object, rather than as closure vars —
      // BuildSpec-literal methods and addScript handlers below reference
      // these via this fully-qualified path (lively.identity.DMChat.ACCENT
      // etc.), since a bare closure var would throw "not defined" the
      // moment those methods run (see this file's header / CLAUDE.md's
      // BuildSpec-closure-loss section).
      ACCENT:      Color.rgb(88, 101, 242),   // header / own-bubble / send-button accent
      ACCENT_SOFT: Color.rgba(255, 255, 255, 0.14), // hover tint over the accent header
      BUBBLE_OWN:   Color.rgb(88, 101, 242),
      BUBBLE_OTHER: Color.rgb(237, 237, 241),
      ROW_HOVER:    Color.rgb(248, 248, 252),

      // Applies the codebase-wide "wiki icon controls" window-chrome
      // convention's one non-declarative piece (LivelyMorphic.md §8) to a
      // classic Window whose own top-level BuildSpec _Fill is already this
      // feature's accent color: the base theme's `.Window .TitleBar` rule
      // is transparent by design, so that _Fill already shows through as
      // the title bar's background for free (and, being a BuildSpec-baked
      // fill, applies correctly at construction — no procedural
      // setFill()-never-reaches-DOM workaround needed here, unlike a
      // Window recolored after the fact). All that's left is the part the
      // base theme can't know per-window: the default dark title-text
      // color (#555/#333) doesn't have enough contrast against a
      // saturated accent, and the base theme's `.Window.highlighted` rule
      // adds a white focus-ring border/shadow tuned for the light default
      // chrome that reads as a stray ring on a colored one. Both are
      // scoped to a small `dm-accent-chrome` class (added below) so they
      // never affect any other window.
      _ensureAccentChromeCss: function () {
        var STYLE_ID = 'dm-chat-accent-chrome-style';
        if (document.getElementById(STYLE_ID)) return;
        var styleEl = document.createElement('style');
        styleEl.id = STYLE_ID;
        styleEl.textContent = [
          '.Window.dm-accent-chrome .Text.window-title { color: #fff; }',
          '.Window.dm-accent-chrome.highlighted .Text.window-title { color: #fff; font-weight: bold; }',
          '.Window.dm-accent-chrome.highlighted { border: none !important; box-shadow: 0px 3px 10px rgba(20,40,90,0.35) !important; }',
        ].join('\n');
        document.head.appendChild(styleEl);
      },

      applyAccentChrome: function (win) {
        this._ensureAccentChromeCss();
        win.addStyleClassName('dm-accent-chrome');
      },

      _formatTime: function (isoOrNull) {
        var d = isoOrNull ? new Date(isoOrNull) : new Date();
        var h = d.getHours(), m = d.getMinutes();
        var ampm = h >= 12 ? 'PM' : 'AM';
        h = h % 12; if (h === 0) h = 12;
        return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm;
      },

      // Opens (or focuses) the 1:1 chat window for @peerHandle. peerDid is
      // required the first time a thread is opened (callers always have it
      // already — e.g. ProfileCard.js's friend nameplate rows carry both
      // f.handle and f.did); later opens of the same handle reuse whatever
      // window already exists.
      open: function (peerHandle, peerDid) {
        var existing = this._windows[peerHandle];
        if (existing && existing.world()) {
          existing.getWindow().comeForward();
          return existing;
        }
        var win = lively.BuildSpec('lively.identity.DMChatWindow').createMorph();
        var content = win.targetMorph || win.get('DMChatWindow');
        content._peerHandle = peerHandle;
        content._peerDid = peerDid;
        this._windows[peerHandle] = content;
        win.setTitle('@' + peerHandle);
        $world.addMorph(win);
        this.applyAccentChrome(win);
        win.setPosition($world.visibleBounds().center().subPt(win.getExtent().scaleBy(0.5)));
        win.comeForward();
        content.startChat();
        this.ensurePolling();
        return content;
      },

      // Opens (or focuses + refreshes) the thread-list window.
      openInbox: function () {
        if (this._inboxWindow && this._inboxWindow.world()) {
          this._inboxWindow.getWindow().comeForward();
          this._inboxWindow.refresh();
          return this._inboxWindow;
        }
        var win = lively.BuildSpec('lively.identity.DMInboxWindow').createMorph();
        var content = win.targetMorph || win.get('DMInboxWindow');
        this._inboxWindow = content;
        $world.addMorph(win);
        this.applyAccentChrome(win);
        win.setPosition($world.visibleBounds().center().subPt(win.getExtent().scaleBy(0.5)));
        win.comeForward();
        content.refresh();
        this.ensurePolling();
        return content;
      },

      // ─── local persistence (IndexedDB) — p2pchat.md §7 ─────────────────

      _DB_NAME: 'lively-dm-chat',
      _DB_VERSION: 1,
      _db: null,

      openDb: function (thenDo) {
        if (this._db) return thenDo(null, this._db);
        var self = this;
        var req = indexedDB.open(this._DB_NAME, this._DB_VERSION);
        req.onupgradeneeded = function (evt) {
          var db = evt.target.result;
          if (!db.objectStoreNames.contains('messages')) {
            var store = db.createObjectStore('messages', { keyPath: 'msgId' });
            store.createIndex('threadId', 'threadId', { unique: false });
          }
        };
        req.onsuccess = function (evt) { self._db = evt.target.result; thenDo(null, self._db); };
        req.onerror = function (evt) { thenDo(evt.target.error); };
      },

      // row: {msgId, threadId, peerHandle, peerDid, myDid, text, sentAt, direction: 'in'|'out'}
      saveLocalMessage: function (row, thenDo) {
        this.openDb(function (err, db) {
          if (err) return thenDo(err);
          var tx = db.transaction('messages', 'readwrite');
          tx.objectStore('messages').put(row);
          tx.oncomplete = function () { thenDo(null); };
          tx.onerror = function () { thenDo(tx.error); };
        });
      },

      listThreadMessages: function (threadId, thenDo) {
        this.openDb(function (err, db) {
          if (err) return thenDo(err);
          var idx = db.transaction('messages', 'readonly').objectStore('messages').index('threadId');
          var out = [];
          var req = idx.openCursor(IDBKeyRange.only(threadId));
          req.onsuccess = function (evt) {
            var cursor = evt.target.result;
            if (cursor) { out.push(cursor.value); cursor.continue(); return; }
            out.sort(function (a, b) { return a.sentAt < b.sentAt ? -1 : 1; });
            thenDo(null, out);
          };
          req.onerror = function () { thenDo(req.error); };
        });
      },

      // Derives the thread list from IndexedDB alone (p2pchat.md §7 — there
      // is no server-side "who have I DMed" index by design). One row per
      // threadId, keeping whichever message has the latest sentAt.
      listThreads: function (thenDo) {
        this.openDb(function (err, db) {
          if (err) return thenDo(err);
          var store = db.transaction('messages', 'readonly').objectStore('messages');
          var byThread = {};
          var req = store.openCursor();
          req.onsuccess = function (evt) {
            var cursor = evt.target.result;
            if (cursor) {
              var row = cursor.value;
              var existing = byThread[row.threadId];
              if (!existing || row.sentAt > existing.lastSentAt) {
                byThread[row.threadId] = {
                  threadId: row.threadId, peerHandle: row.peerHandle, peerDid: row.peerDid,
                  lastText: row.text, lastSentAt: row.sentAt,
                };
              }
              cursor.continue();
              return;
            }
            var threads = Object.keys(byThread).map(function (k) { return byThread[k]; });
            threads.sort(function (a, b) { return a.lastSentAt < b.lastSentAt ? 1 : -1; });
            thenDo(null, threads);
          };
          req.onerror = function () { thenDo(req.error); };
        });
      },

      threadId: function (didA, didB) { return 'dm:' + [didA, didB].sort().join(':'); },

      newMsgId: function () {
        var bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        return lively.identity.crypto.base64urlEncode(bytes);
      },

      // ─── crypto/network helpers ─────────────────────────────────────────

      // My own published device X25519 public key — plain profile data, no
      // WebAuthn ceremony needed to read it (only needed to derive the
      // matching PRIVATE half, which is only required when decrypting, not
      // sending — see getMyDeviceX25519 below).
      getMyDevicePub: function (thenDo) {
        if (this._myDevicePub) return thenDo(null, this._myDevicePub);
        var self = this;
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('Not logged in'));
        fetch('/@' + user.handle + '/profile', { credentials: 'include' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (env) {
            var pub = env && env.record && env.record.payload && env.record.payload.accountX25519Pub;
            if (!pub) return thenDo(new Error('You need to enable encryption first — open your profile and click "Enable encryption".'));
            self._myDevicePub = pub;
            thenDo(null, pub);
          })
          .catch(thenDo);
      },

      fetchPeerProfile: function (peerHandle, thenDo) {
        fetch('/@' + peerHandle + '/profile', { credentials: 'include' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (env) {
            if (!env) return thenDo(new Error('Could not load @' + peerHandle + '’s profile'));
            var payload = (env.record && env.record.payload) || {};
            thenDo(null, {
              did: env.did,
              devicePub: payload.accountX25519Pub || null,
              avatarUrl: payload.avatarUrl || null,
            });
          })
          .catch(thenDo);
      },

      _getDidDocument: function (handle, thenDo) {
        if (this._didDocCache[handle]) return thenDo(null, this._didDocCache[handle]);
        var self = this;
        fetch('/@' + handle + '/did-document', { credentials: 'include' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (doc) { if (doc) self._didDocCache[handle] = doc; thenDo(null, doc); })
          .catch(thenDo);
      },

      // Signs an arbitrary payload with the current user's soft signing
      // key — mirrors PostCardSerializer.js's own _signEnvelopeIfPossible
      // exactly (same delegation-cert/KEK-unwrap dance), generalized to a
      // plain payload object instead of a full envelope, and fail-loud
      // (there's no sensible "send unsigned" fallback for a chat message —
      // the server would reject it anyway).
      signPayload: function (payload, thenDo) {
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('Not logged in'));
        var method = lively.identity.did.findMethodByCredentialId(user.document, user.credentialId);
        if (!method || !method.lively || !method.lively.softSigningKeyWrapped || !method.lively.delegationCert) {
          return thenDo(new Error('Signing key not set up — open your profile and click "Enable encryption".'));
        }
        var livelyMeta = method.lively;
        var wa = lively.identity.webAuthn;
        var c = lively.identity.crypto;
        var ch = new Uint8Array(32);
        crypto.getRandomValues(ch);
        wa.deriveKek({ credentialId: user.credentialId, rpId: user.rpId, challenge: ch }, function (err, kek) {
          if (err) return thenDo(err);
          var wrapped;
          try { wrapped = JSON.parse(livelyMeta.softSigningKeyWrapped); } catch (e) { return thenDo(e); }
          c.decryptPayload(wrapped.ciphertext, wrapped.nonce, kek, function (err, softPrivJwk) {
            if (err) return thenDo(err);
            c.importPrivateKeyJwk(softPrivJwk, function (err, softPrivKey) {
              if (err) return thenDo(err);
              c.signJws(payload, softPrivKey, thenDo);
            });
          });
        });
      },

      // Only needed on the RECEIVING side, to open a sealed box addressed
      // to me — cached by WebAuthn.js itself across calls this session
      // (same pattern as deriveKek), so this prompts at most once per
      // session, not once per incoming message.
      getMyDeviceX25519: function (thenDo) {
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('Not logged in'));
        var wa = lively.identity.webAuthn;
        var ch = new Uint8Array(32);
        crypto.getRandomValues(ch);
        wa.deriveX25519KeyPair({ credentialId: user.credentialId, rpId: user.rpId, challenge: ch }, thenDo);
      },

      // Client-side re-check that a mailbox row's signature really covers
      // its own fields and really validates against a delegation cert in
      // the claimed sender's DID document (p2pchat.md §4). Deliberately
      // does NOT re-verify the delegation cert's own WebAuthn-assertion
      // chain (CryptoVerify.js's verifyDelegationCert, server-side only) —
      // porting that CBOR/authenticatorData parsing to the browser is real
      // work with no client-side precedent yet, and the server already
      // enforces the full chain before a message is ever admitted to the
      // mailbox. This check's actual job is catching corruption/tampering
      // between mailbox and render, not standing alone as a full trust
      // boundary — same scope limitation Encryption.md §0 already
      // states for envelope-signature verification generally.
      verifyMessageSig: function (row, didDocument, thenDo) {
        var c = lively.identity.crypto;
        var expected = {
          msgId: row.msgId, threadId: row.threadId,
          senderDid: row.senderDid, recipientDid: row.recipientDid,
          ciphertext: row.ciphertext, sentAt: row.sentAt,
        };
        var parts = (row.sig || '').split('.');
        if (parts.length !== 3) return thenDo(null, false);
        var payloadJson;
        try { payloadJson = JSON.parse(new TextDecoder().decode(c.base64urlDecode(parts[1]))); }
        catch (e) { return thenDo(null, false); }
        if (c.canonicalJson(payloadJson) !== c.canonicalJson(expected)) return thenDo(null, false);
        var methods = (didDocument && didDocument.verificationMethod) || [];
        function checkNext(i) {
          if (i >= methods.length) return thenDo(null, false);
          var cert = methods[i].lively && methods[i].lively.delegationCert;
          if (!cert || !cert.devicePubKeyJwk) return checkNext(i + 1);
          c.verifyJws(row.sig, cert.devicePubKeyJwk, function (err, valid) {
            if (!err && valid) return thenDo(null, true);
            checkNext(i + 1);
          });
        }
        checkNext(0);
      },

      // ─── send / receive ─────────────────────────────────────────────────
      // sendMessage's seal+sign step is unchanged from Phase 1; only the
      // delivery branch is new (p2pchat.md §5a): a presence-check ahead of
      // the existing mailbox POST, trying a live data channel first when
      // the peer is reachable this session. Any failure or timeout of the
      // live attempt falls through to the exact same mailbox POST used
      // when the peer is offline — the message is never dropped either
      // way. Receiving is unified too: _processEnvelope (below, in the new
      // "webrtc" category) is the one decrypt/verify/persist path for both
      // a mailbox row (pollOnce) and a live data-channel message
      // (_wireDataChannel's onmessage).

      sendMessage: function (peerHandle, peerDid, text, thenDo) {
        var self = this;
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('Not logged in'));
        this.fetchPeerProfile(peerHandle, function (err, peer) {
          if (err) return thenDo(err);
          if (!peer.devicePub) return thenDo(new Error('@' + peerHandle + ' hasn’t set up encryption yet.'));
          var plaintext = new TextEncoder().encode(JSON.stringify({ text: text }));
          lively.identity.crypto.sealForRecipient(plaintext, peer.devicePub, function (err, ciphertext) {
            if (err) return thenDo(err);
            var msgId = self.newMsgId();
            var threadId = self.threadId(user.did, peerDid);
            var sentAt = new Date().toISOString();
            var toSign = {
              msgId: msgId, threadId: threadId,
              senderDid: user.did, recipientDid: peerDid,
              ciphertext: ciphertext, sentAt: sentAt,
            };
            self.signPayload(toSign, function (err, sig) {
              if (err) return thenDo(err);
              self.getMyDevicePub(function (err, myDevicePub) {
                if (err) return thenDo(err);
                // Full p2pchat.md §4 envelope shape, including senderDid/
                // recipientDid — required for the live path (there's no
                // server hop to derive them from) and for signature
                // verification on receipt either way. The mailbox POST
                // route ignores these two extra fields (it derives its own
                // senderDid/recipientDid from the authenticated session and
                // the URL's :handle rather than trusting the body), so one
                // envelope object is safe to reuse as both the live-channel
                // payload and the mailbox POST body.
                var envelope = {
                  msgId: msgId, threadId: threadId,
                  senderDid: user.did, recipientDid: peerDid,
                  senderDevicePub: myDevicePub, ciphertext: ciphertext,
                  sig: sig, sentAt: sentAt,
                };
                function finishLocal(err) {
                  if (err) return thenDo(err);
                  self.saveLocalMessage({
                    msgId: msgId, threadId: threadId, peerHandle: peerHandle, peerDid: peerDid,
                    myDid: user.did, text: text, sentAt: sentAt, direction: 'out',
                  }, function (err) { thenDo(err || null); });
                }
                function sendViaMailbox() {
                  fetch('/@' + peerHandle + '/dm/mailbox', {
                    method: 'POST', credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(envelope),
                  }).then(function (res) {
                    if (!res.ok) return res.json().then(function (e) { throw new Error(e.error || ('HTTP ' + res.status)); });
                    return res.json();
                  }).then(function () { finishLocal(null); }).catch(finishLocal);
                }
                self.presenceCheck(peerDid, function (err, online) {
                  if (!online) return sendViaMailbox();
                  self._trySendLive(peerDid, envelope, function (sent) {
                    if (sent) return finishLocal(null);
                    sendViaMailbox(); // live attempt failed/timed out — never silently drop
                  });
                });
              });
            });
          });
        });
      },

      ensurePolling: function () {
        if (this._pollTimerId) return;
        var self = this;
        this._pollTimerId = setInterval(function () { self.pollOnce(); }, 4000);
        this.pollOnce();
        this._connectSignaling();
        this._warmDeviceKey();
      },

      pollOnce: function () {
        var self = this;
        var user = lively.identity.did.currentUser();
        if (!user) return;
        fetch('/@' + user.handle + '/dm/mailbox', { credentials: 'include' })
          .then(function (r) { return r.ok ? r.json() : { messages: [] }; })
          .then(function (data) {
            (data.messages || []).forEach(function (row) {
              if (!row.senderHandle) return; // can't attribute — leave queued rather than render as "unknown"
              self._processEnvelope(row, row.senderHandle, row.senderDid, function () {
                self._ackDelete(user.handle, row.msgId);
              });
            });
          })
          .catch(function () {});
      },

      _ackDelete: function (myHandle, msgId) {
        fetch('/@' + myHandle + '/dm/mailbox/' + msgId, { method: 'DELETE', credentials: 'include' }).catch(function () {});
      },

      // Shared decrypt/verify/persist path for one incoming envelope
      // (p2pchat.md §4 shape), regardless of which transport delivered it —
      // extracted from the old mailbox-only _handleIncoming so pollOnce and
      // the live data channel's onmessage (see "webrtc" category below)
      // call the exact same logic rather than maintaining two copies, per
      // §5's own "single decrypt/verify/persist function" intent. ackFn is
      // called only after a successful decrypt+save (or a definitively
      // invalid signature); the mailbox path's ackFn deletes the server
      // row, the live path's is a no-op (there's no row).
      _processEnvelope: function (envelope, peerHandle, peerDid, ackFn) {
        var self = this;
        var user = lively.identity.did.currentUser();
        if (!user || !peerHandle) return;
        this._getDidDocument(peerHandle, function (err, didDocument) {
          if (err || !didDocument) return; // retry next poll
          self.verifyMessageSig(envelope, didDocument, function (err, valid) {
            if (!valid) {
              console.warn('[DMChat] Dropping message with invalid signature from @' + peerHandle);
              return ackFn();
            }
            self.getMyDeviceX25519(function (err, pair) {
              if (err) return; // e.g. WebAuthn prompt dismissed this tick — retry next poll
              lively.identity.crypto.openSealedBox(envelope.ciphertext, pair.publicKey, pair.privateKey, function (err, plainBytes) {
                if (err) {
                  console.warn('[DMChat] Could not open sealed message from @' + peerHandle, err);
                  return ackFn();
                }
                var text;
                try { text = JSON.parse(new TextDecoder().decode(plainBytes)).text; }
                catch (e) { return ackFn(); }
                self.saveLocalMessage({
                  msgId: envelope.msgId, threadId: envelope.threadId, peerHandle: peerHandle,
                  peerDid: peerDid, myDid: user.did, text: text, sentAt: envelope.sentAt, direction: 'in',
                }, function (err) {
                  if (err) { console.warn('[DMChat] Could not save incoming message locally', err); return; }
                  ackFn();
                  var win = self._windows[peerHandle];
                  if (win && win.world()) win.appendMessage(text, false, envelope.sentAt);
                  else if ($world && $world.setStatusMessage) {
                    $world.setStatusMessage('New message from @' + peerHandle, Color.green);
                  }
                });
              });
            });
          });
        });
      },

      // ─── webrtc — live data-channel path (p2pchat.md §5/§5a) ───────────
      // Point-to-point, DID-keyed — unlike RoomView.js's mesh call, there's
      // no roster and no eager pre-connection to every online friend: a
      // peer connection here is created lazily, on the first real send
      // attempt or first incoming offer for that DID, and reused for the
      // rest of the session regardless of who initiated it (a data channel
      // is bidirectional once open). Signaling connects lazily too, from
      // ensurePolling's own existing trigger point (first DM window/inbox
      // opened this session) — not a new always-on-from-login connection.
      // Any failure anywhere in this category (presence-check timeout,
      // failed negotiation, ICE failure) just means sendMessage falls back
      // to the mailbox path — never a lost message.

      ICE_SERVERS: [{ urls: 'stun:stun.l.google.com:19302' }],

      _signalingWs: null,
      _signalingIntentionallyClosed: false,
      _pendingSignalingToken: null,
      _myDid: null,
      _signalingPeers: {},      // did -> {pc, dc, pendingIce, _openCallbacks}
      _presenceCallbacks: {},   // did -> [thenDo, ...] pending presence-reply
      _signalingRejectStreak: 0,
      _kekWarmed: false,
      _friendHandleCache: null, // did -> handle, lazily populated from /@:handle/friends

      // Primes WebAuthn.js's own cross-call cache for the device X25519 key
      // from this window-open click (a real gesture) — p2pchat.md §5a's
      // resolved decision, riding along with this pass since a live
      // incoming message reaches getMyDeviceX25519 via dc.onmessage, a
      // non-gesture context exactly like the already-known §11
      // mailbox-poll bug. Fire-and-forget: the result/error is discarded
      // here, real handling happens wherever getMyDeviceX25519 is actually
      // needed (_processEnvelope).
      _warmDeviceKey: function () {
        if (this._kekWarmed) return;
        this._kekWarmed = true;
        this.getMyDeviceX25519(function () {});
      },

      // Only friends can reach us (server-gated), so an incoming offer's
      // fromDid is guaranteed to be in our own friends list even though we
      // don't otherwise know its handle — fetched and cached once per
      // session rather than on every incoming offer.
      _resolveHandleForDid: function (did, thenDo) {
        if (this._friendHandleCache && this._friendHandleCache[did]) {
          return thenDo(null, this._friendHandleCache[did]);
        }
        var self = this;
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('Not logged in'));
        fetch('/@' + user.handle + '/friends', { credentials: 'include' })
          .then(function (r) { return r.ok ? r.json() : { friends: [] }; })
          .then(function (data) {
            var cache = {};
            (data.friends || []).forEach(function (f) { if (f.handle) cache[f.did] = f.handle; });
            self._friendHandleCache = cache;
            thenDo(null, cache[did] || null);
          })
          .catch(thenDo);
      },

      _connectSignaling: function () {
        var self = this;
        var user = lively.identity.did.currentUser();
        if (!user) return;
        fetch('/@' + user.handle + '/dm/signaling-token', { method: 'POST', credentials: 'include' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) {
            if (!data) { console.warn('[DMChat] Could not get signaling token'); return; }
            self._openSignalingSocket(data.token, data.wsPath);
          })
          .catch(function () { console.warn('[DMChat] Network error requesting signaling token'); });
      },

      _openSignalingSocket: function (token, wsPath) {
        var self = this;
        this._signalingIntentionallyClosed = false;
        this._pendingSignalingToken = token;
        var url = URL.nodejsBase.withFilename(wsPath).toString();
        var ws = new lively.net.WebSocket(url, { protocol: 'lively-json' });
        this._signalingWs = ws;
        lively.bindings.connect(ws, 'opened', self, '_onSignalingOpened');
        lively.bindings.connect(ws, 'closed', self, '_onSignalingClosed');
        lively.bindings.connect(ws, 'lively-message', self, '_onSignalingMessage');
        ws.connect();
      },

      _onSignalingOpened: function () {
        if (!this._signalingWs || !this._pendingSignalingToken) return;
        this._signalingWs.send({ action: 'join', data: { token: this._pendingSignalingToken } });
        this._pendingSignalingToken = null;
      },

      // Same unconditional-retry idiom as RoomView.js's own
      // _onSignalingClosed: every existing peer connection is torn down
      // (nothing to salvage once the signaling link that would relay their
      // renegotiation/ICE is gone) and a fresh token+socket+join cycle
      // starts after a short delay.
      _onSignalingClosed: function () {
        if (this._signalingIntentionallyClosed) return;
        var self = this;
        Object.keys(this._signalingPeers).forEach(function (did) { self._teardownPeer(did); });
        this._signalingWs = null;
        this._myDid = null;
        setTimeout(function () {
          if (self._signalingIntentionallyClosed) return;
          self._connectSignaling();
        }, 1500);
      },

      _onSignalingMessage: function (msg) {
        switch (msg.action) {
          case 'joined':
            this._signalingRejectStreak = 0;
            this._myDid = msg.data.did;
            break;
          case 'presence-reply': this._onPresenceReply(msg.data); break;
          case 'signal': this._onSignalingSignal(msg.data); break;
          case 'join-rejected':
            // Same backoff idiom as RoomView.js's own join-rejected handler
            // — a stale/expired token is the routine, self-correcting case
            // (retry fast); a persistent rejection escalates to a louder,
            // slower retry rather than silently hammering the server.
            this._signalingRejectStreak++;
            var retryDelay = this._signalingRejectStreak > 3 ? 5000 : 1000;
            if (this._signalingRejectStreak === 4) {
              console.error('[DMChat] Signaling join rejected ' + this._signalingRejectStreak +
                ' times in a row — retrying every ' + retryDelay + 'ms.');
            }
            this._signalingIntentionallyClosed = true;
            try { this._signalingWs.close(); } catch (e) {}
            this._signalingWs = null;
            var self = this;
            setTimeout(function () { self._connectSignaling(); }, retryDelay);
            break;
        }
      },

      // Resolves thenDo(null, false) after a short timeout if no reply
      // arrives — same-server round trip, not an ICE negotiation, so this
      // should be fast (p2pchat.md §5's own ~1.5s starting guess). Not
      // ready to signal yet (socket not open / not joined) also resolves
      // false immediately rather than blocking sendMessage.
      presenceCheck: function (targetDid, thenDo) {
        if (!this._signalingWs || !this._myDid) return thenDo(null, false);
        var self = this;
        (this._presenceCallbacks[targetDid] || (this._presenceCallbacks[targetDid] = [])).push(thenDo);
        this._signalingWs.send({ action: 'presence-check', data: { targetDid: targetDid } });
        setTimeout(function () {
          var cbs = self._presenceCallbacks[targetDid];
          if (!cbs || !cbs.length) return;
          delete self._presenceCallbacks[targetDid];
          cbs.forEach(function (cb) { cb(null, false); });
        }, 1500);
      },

      _onPresenceReply: function (data) {
        var cbs = this._presenceCallbacks[data.targetDid];
        if (!cbs) return;
        delete this._presenceCallbacks[data.targetDid];
        cbs.forEach(function (cb) { cb(null, !!data.online); });
      },

      // Returns the existing peer for targetDid if it's still usable,
      // otherwise creates a fresh one. amInitiator only matters for a
      // brand-new peer: the initiator creates the data channel and sends
      // the offer; the answerer waits for ondatachannel/setRemoteDescription
      // to supply both (same "let setRemoteDescription auto-create it"
      // idiom RoomView.js's own comment documents for transceivers,
      // applied here to the channel instead).
      _getOrCreatePeer: function (targetDid, amInitiator) {
        var existing = this._signalingPeers[targetDid];
        if (existing) {
          var state = existing.pc.connectionState;
          if (state !== 'closed' && state !== 'failed') return existing;
          this._teardownPeer(targetDid); // stale/dead — fall through and recreate
        }
        var self = this;
        var pc = new RTCPeerConnection({ iceServers: this.ICE_SERVERS });
        var peer = { pc: pc, dc: null, pendingIce: [], _openCallbacks: [] };
        this._signalingPeers[targetDid] = peer;

        pc.onicecandidate = function (e) {
          if (e.candidate) self._sendSignalTo(targetDid, { type: 'ice', candidate: e.candidate });
        };
        pc.oniceconnectionstatechange = function () {
          var state = pc.iceConnectionState;
          if (state === 'failed' || state === 'closed') self._teardownPeer(targetDid);
        };

        if (amInitiator) {
          peer.dc = pc.createDataChannel('dm', { ordered: true });
          self._wireDataChannel(targetDid, peer);
          pc.createOffer().then(function (offer) {
            return pc.setLocalDescription(offer);
          }).then(function () {
            self._sendSignalTo(targetDid, { type: 'offer', sdp: pc.localDescription });
          }).catch(function (e) {
            console.error('[DMChat] createOffer failed', e);
            self._teardownPeer(targetDid);
          });
        } else {
          pc.ondatachannel = function (e) {
            peer.dc = e.channel;
            self._wireDataChannel(targetDid, peer);
          };
        }

        return peer;
      },

      _wireDataChannel: function (targetDid, peer) {
        var self = this;
        function wakePendingSenders() {
          var cbs = peer._openCallbacks;
          peer._openCallbacks = [];
          cbs.forEach(function (cb) { cb(); });
        }
        peer.dc.onopen = wakePendingSenders;
        peer.dc.onclose = wakePendingSenders; // wake pending waiters so they can fail out and fall back to mailbox
        peer.dc.onmessage = function (e) {
          var envelope;
          try { envelope = JSON.parse(e.data); } catch (err) { return; }
          self._resolveHandleForDid(targetDid, function (err, handle) {
            if (!handle) return; // shouldn't happen (friend-gated at the signaling server), but be safe
            self._processEnvelope(envelope, handle, targetDid, function () {});
          });
        };
      },

      // Attempts the live path for one send. Resolves thenDo(true) only
      // once the envelope has actually been handed to an open channel;
      // ANY failure or timeout resolves thenDo(false) so sendMessage can
      // fall back to the mailbox — this never throws the message away on
      // its own.
      _trySendLive: function (targetDid, envelope, thenDo) {
        var peer = this._getOrCreatePeer(targetDid, true);
        var settled = false;
        function settle(ok) { if (settled) return; settled = true; thenDo(ok); }
        function trySend() {
          if (peer.dc && peer.dc.readyState === 'open') {
            try { peer.dc.send(JSON.stringify(envelope)); settle(true); }
            catch (e) { settle(false); }
          } else {
            settle(false);
          }
        }
        if (peer.dc && peer.dc.readyState === 'open') { trySend(); return; }
        peer._openCallbacks.push(trySend);
        setTimeout(function () { settle(false); }, 9000); // p2pchat.md §5's own ~8-10s ICE-timeout guess
      },

      _sendSignalTo: function (targetDid, signal) {
        if (!this._signalingWs) return;
        this._signalingWs.send({ action: 'signal', data: { to: targetDid, signal: signal } });
      },

      _onSignalingSignal: function (data) {
        var fromDid = data.from;
        var signal = data.signal;
        if (signal.type === 'offer') return this._onOffer(fromDid, signal);
        var peer = this._signalingPeers[fromDid];
        if (!peer) return; // no pc for this peer any more — drop
        if (signal.type === 'answer') return this._onAnswer(peer, signal);
        if (signal.type === 'ice') return this._onIce(peer, signal);
      },

      // Perfect-negotiation-style glare handling, same shape as
      // RoomView.js's own _onOffer, restated in DID terms per p2pchat.md
      // §5's "compare the two DIDs, not peerIds" note: the
      // lexicographically smaller DID always initiates and wins glare
      // (impolite), the larger DID yields (polite) — both sides reach this
      // independently from the same rule, so it can't deadlock.
      _onOffer: function (fromDid, signal) {
        var self = this;
        var peer = this._signalingPeers[fromDid];
        var isPolite = this._myDid > fromDid;

        if (peer && peer.pc.signalingState === 'have-local-offer') {
          if (!isPolite) return; // impolite: ignore theirs, ours will win
          peer.pc.setLocalDescription({ type: 'rollback' }).then(function () {
            self._answerOffer(fromDid, peer, signal);
          }).catch(function (e) { console.error('[DMChat] Glare rollback failed', e); });
          return;
        }

        if (!peer) peer = this._getOrCreatePeer(fromDid, false);
        self._answerOffer(fromDid, peer, signal);
      },

      _answerOffer: function (fromDid, peer, signal) {
        var self = this;
        peer.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp)).then(function () {
          self._flushPendingIce(peer);
          return peer.pc.createAnswer();
        }).then(function (answer) {
          return peer.pc.setLocalDescription(answer);
        }).then(function () {
          self._sendSignalTo(fromDid, { type: 'answer', sdp: peer.pc.localDescription });
        }).catch(function (e) {
          console.error('[DMChat] Failed to answer offer', e);
          self._teardownPeer(fromDid);
        });
      },

      _onAnswer: function (peer, signal) {
        var self = this;
        peer.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp)).then(function () {
          self._flushPendingIce(peer);
        }).catch(function (e) { console.error('[DMChat] setRemoteDescription (answer) failed', e); });
      },

      _onIce: function (peer, signal) {
        if (peer.pc.remoteDescription && peer.pc.remoteDescription.type) {
          peer.pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(function (e) {
            console.warn('[DMChat] addIceCandidate failed', e);
          });
        } else {
          peer.pendingIce.push(signal.candidate);
        }
      },

      _flushPendingIce: function (peer) {
        var candidates = peer.pendingIce;
        peer.pendingIce = [];
        candidates.forEach(function (c) {
          peer.pc.addIceCandidate(new RTCIceCandidate(c)).catch(function (e) {
            console.warn('[DMChat] addIceCandidate (flush) failed', e);
          });
        });
      },

      _teardownPeer: function (targetDid) {
        var peer = this._signalingPeers[targetDid];
        if (!peer) return;
        delete this._signalingPeers[targetDid];
        try { peer.pc.close(); } catch (e) {}
      },

      // ─── shared UI helpers (plain functions — safe to close over freely,
      // called FROM BuildSpec/addScript methods via this fully-qualified
      // path, never themselves reconstructed from source; see this file's
      // header and CLAUDE.md's BuildSpec-closure-loss section) ───────────

      // Tiled pink concentric-contour-rings background, ported from the
      // now-removed lively.net.tools.Lively2LivelyChat's MessageList
      // pattern (Lively2Lively.js's applyPattern) — that dev-only L2L chat
      // tool was dropped in favor of this identity-based, E2EE chat, but
      // its background texture was worth keeping for DMChat's own thread.
      applyMessageListPattern: function (morph) {
        (function () {
          var ctx = morph.renderContext && morph.renderContext();
          if (!ctx) return;
          var node = ctx.shapeNode || ctx.morphNode;
          if (!node) return;
          // 340×255 tile holds 4 slice centers at staggered y-positions
          // so adjacent columns never align horizontally when tiled
          var tw = 340, th = 255;
          var slices = [
            { cx: 80,  cy: 68,  rb: 0.0 },
            { cx: 258, cy: 96,  rb: 0.5 },
            { cx: 88,  cy: 192, rb: 1.1 },
            { cx: 254, cy: 174, rb: 0.3 }
          ];
          var ringDefs = [
            { r: 13, p: [0.82,1.12,0.90,1.08,0.85,1.15,0.88,1.10], rot: 0.0, op: '0.72', sw: '2.0' },
            { r: 27, p: [1.08,0.88,1.14,0.86,1.06,0.92,1.11,0.85], rot: 0.4, op: '0.62', sw: '1.8' },
            { r: 41, p: [0.90,1.10,0.84,1.15,0.92,1.08,0.87,1.12], rot: 0.8, op: '0.52', sw: '1.6' },
            { r: 55, p: [1.12,0.87,1.06,0.91,1.14,0.85,1.09,0.88], rot: 1.2, op: '0.42', sw: '1.5' },
            { r: 67, p: [0.88,1.13,0.91,1.07,0.86,1.11,0.93,1.08], rot: 1.6, op: '0.33', sw: '1.3' },
            { r: 77, p: [1.06,0.91,1.10,0.88,1.04,0.93,1.08,0.90], rot: 2.0, op: '0.22', sw: '1.2' }
          ];
          function ringPath(cx, cy, r, perturbs, rot) {
            var N = perturbs.length, pts = [], i;
            for (i = 0; i < N; i++) {
              var a = (i / N) * 2 * Math.PI + rot;
              pts.push([cx + Math.cos(a) * r * perturbs[i],
                        cy + Math.sin(a) * r * perturbs[i]]);
            }
            var mids = pts.map(function (p, j) {
              var q = pts[(j + 1) % N];
              return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
            });
            var d = 'M' + mids[N - 1][0].toFixed(1) + ',' + mids[N - 1][1].toFixed(1);
            for (i = 0; i < N; i++) {
              d += ' Q' + pts[i][0].toFixed(1) + ',' + pts[i][1].toFixed(1) +
                   ' ' + mids[i][0].toFixed(1) + ',' + mids[i][1].toFixed(1);
            }
            return d + 'Z';
          }
          var paths = '';
          slices.forEach(function (s) {
            ringDefs.forEach(function (ring) {
              paths += '<path d="' + ringPath(s.cx, s.cy, ring.r, ring.p, ring.rot + s.rb) +
                       '" fill="none" stroke="#F7C2D6"' +
                       ' stroke-width="' + ring.sw + '" opacity="' + ring.op + '"/>';
            });
          });
          var svg = '<svg xmlns="http://www.w3.org/2000/svg"' +
                    ' width="' + tw + '" height="' + th + '">' + paths + '</svg>';
          node.style.backgroundImage =
              "url('data:image/svg+xml," + encodeURIComponent(svg) + "')";
          node.style.backgroundRepeat = 'repeat';
          node.style.backgroundSize = tw + 'px ' + th + 'px';
        }).delay(0);
      },

      createMessageBubble: function (text, isOwn, width, sentAt) {
        var NS = lively.identity.DMChat;
        var maxW = Math.floor(width * 0.72), pad = 10, textW = maxW - pad * 2;
        // Deliberately just a placeholder height, not a real measurement —
        // Text#fit() (TextCore.js) is a documented no-op until this morph
        // is actually in the world ("we cannot figure out the real bounds
        // before we are in DOM anyway"), and this bubble hasn't been added
        // to anything yet at this point. A real, confirmed-live bug from
        // calling .fit() here anyway: it silently did nothing, leaving a
        // crude char-count heuristic as the FINAL height, which overshot
        // badly for wrapped multi-line messages (a ~60-char message came
        // out ~210px tall instead of ~90px — visible as a huge dead-space
        // bubble). Real sizing now happens in _fitBubble, called from
        // appendMessage right after this row is actually inserted into the
        // live MessageList — see CLAUDE.md's "measure after insertion"
        // Text-morph rule.
        var t = new lively.morphic.Text(lively.rect(0, 0, textW, 18), text);
        t.applyStyle({
          fixedWidth: true, fixedHeight: false,
          fontSize: 13, fontFamily: 'sans-serif',
          fill: null, borderWidth: 0, allowInput: false,
          lineWrapping: 'by-words',
        });
        if (t.setLineWrapping) t.setLineWrapping('by-words');
        var bH = 18 + pad * 2;
        var bubble = new lively.morphic.Box(lively.rect(0, 0, maxW, bH));
        bubble.applyStyle({
          fill: isOwn ? NS.BUBBLE_OWN : NS.BUBBLE_OTHER,
          // Asymmetric "tail" corner — sharper on the side that points at
          // the screen edge the bubble is aligned to — reads as a real
          // chat bubble instead of a plain uniformly-rounded rectangle.
          // Per-corner CSS shorthand (TL TR BR BL), same idiom already
          // used by TitleBar#lookCollapsedOrNot elsewhere in this codebase.
          borderRadius: isOwn ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
          borderWidth: 0, clipMode: 'visible',
        });
        t.setPosition(lively.pt(pad, pad));
        t.setTextColor(isOwn ? Color.white : Color.rgb(30, 30, 30));
        bubble.addMorph(t);
        t.draggingEnabled = false; t.droppingEnabled = false; t.grabbingEnabled = false; t.eventsAreIgnored = true;
        bubble.draggingEnabled = false; bubble.droppingEnabled = false; bubble.grabbingEnabled = false;

        var TS_H = 16;
        var row = new lively.morphic.Box(lively.rect(0, 0, width - 16, bH + 3 + TS_H));
        row.applyStyle({ fill: null, borderWidth: 0 });
        row.draggingEnabled = false; row.droppingEnabled = false; row.grabbingEnabled = false;
        bubble.setPosition(lively.pt(isOwn ? (width - 16 - maxW) : 0, 3));
        row.addMorph(bubble);

        var ts = new lively.morphic.Text(lively.rect(0, bH + 3 + 2, maxW, TS_H - 2), NS._formatTime(sentAt));
        ts.applyStyle({
          fixedWidth: true, fixedHeight: true, allowInput: false,
          fontSize: 10, fontFamily: 'sans-serif',
          fill: null, borderWidth: 0, textColor: Color.rgb(150, 150, 158),
          align: isOwn ? 'right' : 'left',
        });
        ts.setPosition(lively.pt(isOwn ? (width - 16 - maxW) : 0, bH + 3 + 2));
        ts.draggingEnabled = false; ts.droppingEnabled = false; ts.grabbingEnabled = false; ts.eventsAreIgnored = true;
        row.addMorph(ts);

        // Plain data properties, read back by the equally-plain _fitBubble
        // method below (never reconstructed from source — only BuildSpec-
        // literal methods and addScript handlers are) — safe to stash and
        // reuse.
        row._msgText = t; row._msgBubble = bubble; row._msgTs = ts;
        row._msgIsOwn = isOwn; row._msgMaxW = maxW; row._msgPad = pad; row._msgWidth = width;
        return row;
      },

      // Must be called only AFTER `row` (from createMessageBubble) has
      // actually been added into a MessageList that's already in the
      // world — re-measures the Text morph's real wrapped height (the
      // thing createMessageBubble's own placeholder guess above couldn't
      // do yet) and resizes the bubble/timestamp/row to match.
      _fitBubble: function (row) {
        var t = row._msgText, bubble = row._msgBubble, ts = row._msgTs;
        var isOwn = row._msgIsOwn, maxW = row._msgMaxW, pad = row._msgPad, width = row._msgWidth;
        t.fit();
        var bH = t.getExtent().y + pad * 2;
        bubble.setExtent(lively.pt(maxW, bH));
        bubble.setPosition(lively.pt(isOwn ? (width - 16 - maxW) : 0, 3));
        var TS_H = 16;
        ts.setPosition(lively.pt(isOwn ? (width - 16 - maxW) : 0, bH + 3 + 2));
        row.setExtent(lively.pt(width - 16, bH + 3 + TS_H));
      },

      // A clickable thread row for the inbox window. Stores peerHandle/
      // peerDid directly on the morph (not closed over) since its
      // onMouseUp is installed via addScript on a live instance.
      createThreadRow: function (thread, width) {
        var ROWH = 60, AVSZ = 40;
        var row = new lively.morphic.Box(lively.rect(0, 0, width, ROWH));
        row.applyStyle({ fill: Color.white, borderWidth: 0 });
        row._peerHandle = thread.peerHandle;
        row._peerDid = thread.peerDid;
        row.handStyle = 'pointer';

        var divider = new lively.morphic.Box(lively.rect(12, ROWH - 1, width - 24, 1));
        divider.applyStyle({ fill: Color.rgb(232, 232, 238), borderWidth: 0 });
        divider.draggingEnabled = false; divider.droppingEnabled = false; divider.grabbingEnabled = false;
        divider.eventsAreIgnored = true;
        row.addMorph(divider);

        var avatarImg = new lively.morphic.Image(lively.rect(10, 10, AVSZ, AVSZ));
        avatarImg.setImageURL(lively.identity.postCardUtils.identiconDataUrl(thread.peerHandle, AVSZ));
        avatarImg.applyStyle({ borderRadius: AVSZ / 2, borderWidth: 0, clipMode: 'hidden' });
        avatarImg.draggingEnabled = false; avatarImg.droppingEnabled = false; avatarImg.grabbingEnabled = false;
        avatarImg.eventsAreIgnored = true;
        row.addMorph(avatarImg);

        // Real, confirmed-live bug fixed here: fontSize on a Text morph
        // renders in POINTS, not pixels (CLAUDE.md's fontSize gotcha), so
        // a bold 13pt handle actually needs ~23px of real line height and
        // a regular 12pt preview needs ~22px — both well past the 18px
        // box these previously used. Combined with clipMode:'hidden'
        // (needed below to stop overflow bleeding into the next row),
        // the extra few px were silently sliced off the BOTTOM of every
        // glyph, most visibly on descenders ("reply" rendered as "replv").
        // Heights below (23/23) were converged empirically — iteratively
        // measuring the real rendered span's bottom edge against the
        // box's own clipped bottom edge until nothing overshot — not
        // computed from the nominal pt/px ratio, which doesn't account
        // for real line-height metrics on top of the glyph size itself.
        var nameM = new lively.morphic.Text(lively.rect(60, 8, width - 72, 23), '@' + thread.peerHandle);
        nameM.applyStyle({ allowInput: false, fontSize: 13, fontWeight: 'bold',
          fill: null, borderWidth: 0, textColor: Color.rgb(30, 30, 30),
          // Single-line label — without this, a long handle can wrap onto
          // a second line and, since the box height is fixed with no
          // clip, that second line silently bleeds down past the row
          // (confirmed live, same bug the preview label below had,
          // matching AmbientPresencePanel.js's own name/status labels'
          // idiom for a one-line box).
          clipMode: 'hidden', whiteSpaceHandling: 'pre' });
        nameM.draggingEnabled = false; nameM.droppingEnabled = false; nameM.grabbingEnabled = false;
        nameM.eventsAreIgnored = true;
        row.addMorph(nameM);

        var preview = (thread.lastText || '').replace(/\s+/g, ' ').trim();
        if (preview.length > 48) preview = preview.slice(0, 47) + '…';
        var previewM = new lively.morphic.Text(lively.rect(60, 33, width - 72, 23), preview);
        previewM.applyStyle({ allowInput: false, fontSize: 12,
          fill: null, borderWidth: 0, textColor: Color.rgb(120, 120, 128),
          // Real, confirmed-live bug fixed here: a 47-char preview can
          // still be wider than this box at 12px (character width varies,
          // the truncation above is char-count not measured-width), so it
          // wrapped onto a second line that — with no clipMode set —
          // visibly overlapped the divider/next row instead of just
          // getting cut off. clipMode:'hidden' + whiteSpaceHandling:'pre'
          // makes it a real single-line, safely-truncated label instead.
          clipMode: 'hidden', whiteSpaceHandling: 'pre' });
        previewM.draggingEnabled = false; previewM.droppingEnabled = false; previewM.grabbingEnabled = false;
        previewM.eventsAreIgnored = true;
        row.addMorph(previewM);

        row.draggingEnabled = false; row.droppingEnabled = false; row.grabbingEnabled = false;
        row.addScript(function onMouseOver() {
          this.applyStyle({ fill: lively.identity.DMChat.ROW_HOVER });
        });
        row.addScript(function onMouseOut() {
          this.applyStyle({ fill: Color.white });
        });
        row.addScript(function onMouseUp(evt) {
          lively.identity.DMChat.open(this._peerHandle, this._peerDid);
          evt.stop(); return true;
        });
        return row;
      },

    });

    // ─── DMChatWindow: one-on-one conversation ───────────────────────────
    // Classic Window chrome (see this file's header for why) wrapping a
    // from-scratch content area — the actual visual-style experimentation
    // ground for this session's window-foundation goal.

    lively.BuildSpec('lively.identity.DMChatWindow', {
      // Mat-frame accent chrome (LivelyMorphic.md §8): this _Fill IS the
      // window's whole chrome color — the classic TitleBar renders
      // transparent by default (base_theme.css's `.Window .TitleBar`) so
      // it shows this color through directly, and the content pane below
      // is inset from all four edges (8/24/8/10, top kept close to the
      // real 22px title-bar height per §8.1 bug #7 — a bigger top gap
      // reads as "icons pinned to the top" even when they're centered)
      // so the accent reads as a matte border around a lighter interior,
      // no real border stroke needed. See DMChat.applyAccentChrome for
      // the one thing this can't express declaratively (title-text color).
      _Fill: lively.identity.DMChat.ACCENT,
      _BorderRadius: 12,
      _Extent: lively.pt(368, 488),
      className: "lively.morphic.Window",
      contentOffset: lively.pt(8, 24),
      draggingEnabled: true,
      layout: { adjustForNewBounds: true },
      name: "DMChatWindow",
      submorphs: [{
        _BorderRadius: 10,
        _Extent: lively.pt(352, 454),
        // Must match contentOffset above — a classic Window BuildSpec
        // that declares its target morph as a plain submorph (rather
        // than via `new lively.morphic.Window(target, title)`) never
        // gets contentOffset applied as an actual position; omitting
        // this silently overlaps the content pane with the title bar
        // (confirmed live — see CLAUDE.md's classic-Window-content-
        // offset gotcha).
        _Position: lively.pt(8, 24),
        _Fill: Color.rgb(250, 250, 252),
        className: "lively.morphic.Box",
        _ClipMode: "hidden",
        doNotSerialize: ["_peerHandle", "_peerDid"],
        droppingEnabled: false,
        layout: { adjustForNewBounds: true, resizeHeight: true, resizeWidth: true },
        name: "DMChatWindow",
        sourceModule: "lively.morphic.Core",
        submorphs: [{
          // ── peer info strip ───────────────────────────────────────────
          // Same accent as the window's own mat/title bar above it (see
          // DMChat.applyAccentChrome), so the two read as one continuous
          // header block rather than two mismatched bars — the single
          // biggest visual complaint from the first pass (p2pchat.md).
          _Extent: lively.pt(352, 60),
          _Fill: Color.rgb(88, 101, 242),
          _Position: lively.pt(0, 0),
          className: "lively.morphic.Box",
          name: "PeerInfo",
          droppingEnabled: false,
          draggingEnabled: false, grabbingEnabled: false,
          submorphs: [{
            // Sole label for the peer's *identity* in this strip — the
            // classic Window's own title bar (win.setTitle, in
            // DMChat.open) already shows '@handle' in text, so this strip
            // only needs the avatar, not a second redundant name label.
            // (A duplicate "PeerName" Text morph here was a real,
            // confirmed-live cosmetic bug — see p2pchat.md's "Live
            // verification results" section — removed rather than kept
            // alongside the title bar's own copy.)
            _Extent: lively.pt(28, 28),
            _Position: lively.pt(162, 6),
            className: "lively.morphic.Image",
            name: "PeerAvatar",
            sourceModule: "lively.morphic.Core",
            draggingEnabled: false, droppingEnabled: false, grabbingEnabled: false,
          }, {
            // Accurate, not decorative — this feature really is real E2EE
            // (p2pchat.md §4). A Material Symbols lock (white — the brand pink
            // vanishes on this blurple strip — in place of the lock emoji)
            // beside the caption; the pair is centered in the
            // 352px strip from the caption's measured width (~128px at
            // 10pt sans-serif) plus the glyph (14px) and a 4px gap — measured
            // once live and hardcoded, per CLAUDE.md (the icon font loads
            // async, so measuring at build time isn't reliable). The glyph
            // starts at x=103 and the caption at x=121 (glyph + gap); both
            // were read off the live spans, which land at the morph's x.
            _Extent: lively.pt(22, 16),
            _Position: lively.pt(103, 38),
            className: "lively.morphic.Text",
            name: "EncryptedLock",
            textString: "lock",
            style: {
              fixedWidth: true, fixedHeight: true, allowInput: false, selectable: false,
              fontFamily: "'Material Symbols Rounded'",
              fontSize: 10.5, // renders ~14px (pt, not px — see CLAUDE.md)
              align: 'left', clipMode: 'hidden', whiteSpaceHandling: 'pre',
              fill: null, borderWidth: 0, textColor: Color.white,
            },
            draggingEnabled: false, droppingEnabled: false, grabbingEnabled: false,
          }, {
            _Extent: lively.pt(140, 16),
            _Position: lively.pt(121, 38),
            className: "lively.morphic.Text",
            name: "EncryptedCaption",
            textString: "End-to-end encrypted",
            style: {
              fixedWidth: true, fixedHeight: true, allowInput: false,
              fontSize: 10, fontFamily: 'sans-serif', align: 'left',
              fill: null, borderWidth: 0, textColor: Color.rgba(255, 255, 255, 0.82),
            },
            draggingEnabled: false, droppingEnabled: false, grabbingEnabled: false,
          }],
        }, {
          // ── message thread ────────────────────────────────────────────
          _Extent: lively.pt(352, 454 - 60 - 64),
          _Fill: Color.white,
          _Position: lively.pt(0, 60),
          className: "lively.morphic.Box",
          name: "MessageList",
          // {x:'hidden', y:'scroll'} not the bare string 'scroll' — the
          // bare form scrolls BOTH axes, which showed a permanent, unused
          // horizontal scrollbar the full width of the window (confirmed
          // live via screenshot during this design pass; bubbles never
          // actually overflow horizontally, they're capped at 72% of the
          // list's own width). Per-side clip mode per HTML.js's own
          // setClipModeHTMLForNode.
          _ClipMode: { x: "hidden", y: "scroll" },
          droppingEnabled: false,
          draggingEnabled: false, grabbingEnabled: false,
          onFromBuildSpecCreated: function onFromBuildSpecCreated() {
            lively.identity.DMChat.applyMessageListPattern(this);
          },
          onLoad: function onLoad() {
            lively.identity.DMChat.applyMessageListPattern(this);
          },
        }, {
          // ── input row ──────────────────────────────────────────────────
          _Extent: lively.pt(352, 64),
          _Fill: Color.rgb(250, 250, 252),
          _Position: lively.pt(0, 454 - 64),
          className: "lively.morphic.Box",
          name: "InputRow",
          droppingEnabled: false,
          draggingEnabled: false, grabbingEnabled: false,
          submorphs: [{
            _BorderColor: Color.rgb(214, 214, 222),
            _BorderRadius: 18,
            _BorderWidth: 1,
            _Extent: lively.pt(280, 36),
            _Fill: Color.white,
            _Position: lively.pt(12, 14),
            className: "lively.morphic.Text",
            name: "InputField",
            textString: "",
            style: {
              fixedWidth: true, fixedHeight: true, clipMode: 'hidden', allowInput: true,
              fontSize: 13, padding: lively.rect(12, 8, 8, 8),
            },
            draggingEnabled: false, droppingEnabled: false, grabbingEnabled: false,
            onFromBuildSpecCreated: function onFromBuildSpecCreated() {
              this.beInputLine({ fixedWidth: true });
            },
            onLoad: function onLoad() {
              $super();
              this.beInputLine({ fixedWidth: true });
            },
            onKeyDown: function onKeyDown(evt) {
              if (evt.getKeyString() === 'Enter') {
                this.get('DMChatWindow').sendCurrentInput();
                evt.stop(); return true;
              }
              return $super(evt);
            },
          }, {
            // Round accent send button, Material Symbols "send" glyph —
            // same icon-button idiom as AmbientPresencePanel.js's
            // mic/headset/settings buttons (vertical centering via a
            // top-padding offset, since applyStyle({verticalAlign}) is a
            // no-op on a multi-line-capable Text box per CLAUDE.md).
            _BorderWidth: 0,
            _BorderRadius: 20,
            _Extent: lively.pt(40, 40),
            _Fill: Color.rgb(88, 101, 242),
            _Position: lively.pt(300, 12),
            className: "lively.morphic.Text",
            name: "SendButton",
            textString: "send",
            style: {
              fontFamily: "'Material Symbols Rounded'",
              fontSize: 15, // renders ~20px (pt, not px — see CLAUDE.md)
              textColor: Color.white,
              align: 'center',
              padding: lively.rect(0, Math.round((40 - 20) / 2), 0, 0),
              allowInput: false, selectable: false, clipMode: 'hidden',
              whiteSpaceHandling: 'pre',
            },
            handStyle: 'pointer',
            draggingEnabled: false, droppingEnabled: false, grabbingEnabled: false,
            onMouseOver: function onMouseOver() {
              this.applyStyle({ fill: Color.rgb(66, 79, 220) });
            },
            onMouseOut: function onMouseOut() {
              this.applyStyle({ fill: lively.identity.DMChat.ACCENT });
            },
            onMouseUp: function onMouseUp(evt) {
              this.get('DMChatWindow').sendCurrentInput();
              evt.stop(); return true;
            },
          }],
        }],

        startChat: function startChat() {
          var self = this;
          this.get('PeerAvatar').setImageURL(
            lively.identity.postCardUtils.identiconDataUrl(this._peerHandle, 28));
          lively.identity.DMChat.fetchPeerProfile(this._peerHandle, function (err, peer) {
            if (err || !self.world()) return;
            if (peer.avatarUrl) self.get('PeerAvatar').setImageURL(peer.avatarUrl);
            if (peer.did && !self._peerDid) self._peerDid = peer.did;
          });
          var user = lively.identity.did.currentUser();
          if (!user || !this._peerDid) return;
          var threadId = lively.identity.DMChat.threadId(user.did, this._peerDid);
          lively.identity.DMChat.listThreadMessages(threadId, function (err, rows) {
            if (err || !rows || !self.world()) return;
            rows.forEach(function (row) { self.appendMessage(row.text, row.direction === 'out', row.sentAt); });
          });
        },

        appendMessage: function appendMessage(text, isOwn, sentAt) {
          var list = this.get('MessageList');
          // Real, confirmed-live bug fixed here: list.getExtent().x is the
          // BOX's full declared model width (352), but MessageList's own
          // _ClipMode sets a permanent y:"scroll" — the vertical scrollbar
          // always reserves ~15px of real width regardless of whether it's
          // actually needed, which the model-level extent knows nothing
          // about. Sizing bubbles/timestamps off the un-reduced 352 let
          // right-aligned ("own") ones reach past the real visible edge,
          // so their rightmost ~7px sat hidden under the scrollbar.
          // clientWidth is the DOM's own already-scrollbar-adjusted content
          // width — read directly rather than guessing a fixed scrollbar
          // px constant, since that varies by OS/browser.
          var listNode = list.renderContext && list.renderContext().shapeNode;
          var width = listNode ? listNode.clientWidth : list.getExtent().x;
          // Real, confirmed-live bug fixed here: bounds() unions in
          // submorph bounds AND caches the result on first read
          // (Core.js's Morph#bounds), and nothing invalidates that cache
          // when a DESCENDANT (bubble/timestamp, both nested inside this
          // row) moves later via _fitBubble's own setPosition/setExtent
          // calls — only a direct child of the row being ADDED does that.
          // The stale cached value came out ~43px taller than the row's
          // own real, final getExtent().y, so every message after the
          // first opened up a large dead gap before it, making each
          // timestamp read as floating far from the next bubble rather
          // than sitting close under its own. getPosition()/getExtent()
          // are the plain, always-fresh model values _fitBubble itself
          // sets — safe to use here instead of the cache-prone bounds().
          var last = list.submorphs.length ? list.submorphs.last() : null;
          var y = last ? (last.getPosition().y + last.getExtent().y + 4) : 8;
          var row = lively.identity.DMChat.createMessageBubble(text, isOwn, width, sentAt);
          row.setPosition(lively.pt(8, y));
          list.addMorph(row);
          lively.identity.DMChat._fitBubble(row);
          list.scrollToBottom();
        },

        sendCurrentInput: function sendCurrentInput() {
          var self = this;
          var field = this.get('InputField');
          var text = (field.textString || '').trim();
          if (!text) return;
          field.textString = '';
          lively.identity.DMChat.sendMessage(this._peerHandle, this._peerDid, text, function (err) {
            if (err) {
              $world.setStatusMessage('Could not send: ' + err.message, Color.red);
              field.textString = text;
              return;
            }
            self.appendMessage(text, true);
          });
        },

        onWindowGetsFocus: function onWindowGetsFocus() {
          this.get('InputField').focus();
        },
      }],
      titleBar: "Direct message",
    });

    // ─── DMInboxWindow: thread list ───────────────────────────────────────

    lively.BuildSpec('lively.identity.DMInboxWindow', {
      // Same mat-frame accent chrome as DMChatWindow above — see its own
      // comment for the full rationale. This replaces the window's old
      // real 11px border (a placeholder from before the convention
      // existed) with the same _Fill-shows-through-the-transparent-
      // title-bar technique, same 8/24/8/10 inset.
      _Fill: lively.identity.DMChat.ACCENT,
      _BorderRadius: 12,
      _Extent: lively.pt(314, 430),
      className: "lively.morphic.Window",
      contentOffset: lively.pt(8, 24),
      draggingEnabled: true,
      layout: { adjustForNewBounds: true },
      name: "DMInboxWindow",
      submorphs: [{
        _BorderRadius: 10,
        _Extent: lively.pt(298, 396),
        _Position: lively.pt(8, 24),
        _Fill: Color.white,
        className: "lively.morphic.Box",
        _ClipMode: "hidden",
        droppingEnabled: false,
        layout: { adjustForNewBounds: true, resizeHeight: true, resizeWidth: true },
        name: "DMInboxWindow",
        sourceModule: "lively.morphic.Core",
        submorphs: [{
          _Extent: lively.pt(298, 396), // matches the content pane's own extent above
          _Fill: Color.white,
          _Position: lively.pt(0, 0),
          className: "lively.morphic.Box",
          name: "ThreadList",
          _ClipMode: { x: "hidden", y: "scroll" }, // see DMChatWindow's MessageList for why not the bare 'scroll' string
          droppingEnabled: false,
          draggingEnabled: false, grabbingEnabled: false,
        }],

        refresh: function refresh() {
          var self = this;
          var list = this.get('ThreadList');
          list.removeAllMorphs();
          lively.identity.DMChat.listThreads(function (err, threads) {
            if (err || !self.world()) return;
            if (!threads.length) {
              var w = list.getExtent().x, h = list.getExtent().y;
              var icon = new lively.morphic.Text(lively.rect(0, Math.round(h / 2) - 60, w, 40), 'forum');
              icon.applyStyle({
                fontFamily: "'Material Symbols Rounded'", fontSize: 27, // ~36px
                fixedWidth: true, fixedHeight: true, allowInput: false, align: 'center',
                fill: null, borderWidth: 0, textColor: Color.rgb(210, 210, 218),
              });
              list.addMorph(icon);
              var msg = new lively.morphic.Text(lively.rect(24, Math.round(h / 2) - 14, w - 48, 40),
                'No conversations yet\nMessage a friend from their profile.');
              msg.applyStyle({ allowInput: false, fontSize: 12, align: 'center', fill: null, borderWidth: 0,
                textColor: Color.rgb(140, 140, 148), lineWrapping: 'by-words' });
              if (msg.setLineWrapping) msg.setLineWrapping('by-words');
              list.addMorph(msg);
              return;
            }
            threads.forEach(function (thread, i) {
              var row = lively.identity.DMChat.createThreadRow(thread, list.getExtent().x);
              row.setPosition(lively.pt(0, i * 60));
              list.addMorph(row);
            });
          });
        },
      }],
      titleBar: "Messages",
    });

  }); // end module('lively.identity.DMChat')
