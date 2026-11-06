/**
 * lively.identity.LocalIdentity
 *
 * World-side client for keo's LOCAL identities: an identity made on the user's own device, with no server and no handle
 * (livelykeo.md 7 and 9.4l). The work happens in the shell page of the keo package (keo-lab/keo-world-ext-src/keo-identity.js),
 * which owns the passkey, the account secret and the keys; this module only asks it, over the keo bridge
 * (window.keo.call, keo-bridge.js), and gets plain data back. No key material ever reaches the world.
 *
 * isAvailable() is true only inside the keo package (the bridge exists and is not the standalone stand-in). On a normal
 * server-backed page it is false, and the dialogs keep using the server flow.
 *
 * What an identity summary looks like (what create/list/rename/signIn resolve to):
 *   { did, label, createdAt, rpId, authorityKeys, notRecoverable }
 *   - did            did:keo:<z32 discovery key>:<b64url hash of the inception>  (see shortDid for a display form)
 *   - label          the user's own name for it on this device; changeable with rename(), never leaves the device
 *   - notRecoverable true until a second credential on another rpId is enrolled (a first-run account may have none)
 * There is no handle on a local identity: a host grants one later, when the user registers with it.
 *
 * Async convention: thenDo(err, result) throughout, matching the rest of lively.identity.
 *
 * Dependencies: none (talks to window.keo).
 */

module("lively.identity.LocalIdentity")
  .requires()
  .toRun(function () {

    // Passkey prompts wait on a person; create asks for two of them in a row.
    var CEREMONY_TIMEOUT_MS = 300000;

    Object.subclass("lively.identity.LocalIdentity", {

      // True when the shell can be reached. Not just "window.keo exists": the standalone stand-in has no shell behind it.
      isAvailable: function isAvailable() {
        return !!(window.keo && !window.keo.standalone && typeof window.keo.call === "function");
      },

      create: function create(label, thenDo) {
        this._run("identity.create", { label: label }, CEREMONY_TIMEOUT_MS, thenDo);
      },

      list: function list(thenDo) {
        this._run("identity.list", {}, 30000, thenDo);
      },

      rename: function rename(did, label, thenDo) {
        this._run("identity.rename", { did: did, label: label }, 30000, thenDo);
      },

      // Removes the identity from this device only; the passkey itself stays in the authenticator.
      remove: function remove(did, thenDo) {
        this._run("identity.remove", { did: did }, 30000, thenDo);
      },

      // Unlock with the passkey. Resolves to the identity summary plus assertionOrigin / secretNonExtractable.
      signIn: function signIn(did, thenDo) {
        this._run("identity.signIn", { did: did }, CEREMONY_TIMEOUT_MS, thenDo);
      },

      // The public part of the shell's session { did, label, issuedAt, exp, cert }, or null when nobody is signed in.
      session: function session(thenDo) {
        this._run("session.current", {}, 30000, thenDo);
      },

      // Ends the session. The shell then shows its sign-in screen again, so the world does not outlive the call.
      signOut: function signOut(thenDo) {
        this._run("session.signOut", {}, 30000, thenDo);
      },

      // Moves to another page for the signed-in identity: "homestar", "blank", or "world" with a saved world's name. "enter" lets
      // the shell choose, as it does after a sign-in: the world saved last, else the home page.
      go: function go(kind, name, thenDo) {
        this._run("world.go", { kind: kind, name: name }, 120000, thenDo || function () {});
      },

      // ─── the worlds saved on this device (shell/keo-worlds.js) ──────────────────
      // All of it is the signed-in identity's own; the shell keeps the worlds encrypted and does the searching, so nothing here
      // sees a key. A name that is taken is refused by the shell (rename, duplicate, and go("blank", name)).
      //   worldList()                -> [{ name, savedAt, createdAt, bytes, tags, note, last }], newest first
      //   worldSearch(query)         -> { hits: [{ ...the same, score, where: ["name"|"tags"|"note"|"text"], snippet }], skipped }
      //                                 every word has to be found (any order), "quoted phrases"; skipped counts records that
      //                                 could not be read
      //   worldRename(from, to), worldDuplicate(from, to), worldMeta(name, tags, note), worldRemove(name)
      //                              tags is a list (or comma-separated text), note is text; a field left undefined stays as it is
      // A change tells the page ("keo-worlds-changed" on window) so the lists that copy the library (the world menu) read it again.
      worldList: function worldList(thenDo) { this._run("world.list", {}, 30000, thenDo); },
      worldSearch: function worldSearch(query, thenDo) { this._run("world.search", { query: query }, 60000, thenDo); },
      worldRename: function worldRename(from, to, thenDo) { this._runChange("world.rename", { from: from, to: to }, thenDo); },
      worldDuplicate: function worldDuplicate(from, to, thenDo) { this._runChange("world.duplicate", { from: from, to: to }, thenDo); },
      worldMeta: function worldMeta(name, tags, note, thenDo) { this._runChange("world.meta", { name: name, tags: tags, note: note }, thenDo); },
      worldRemove: function worldRemove(name, thenDo) { this._runChange("world.remove", { name: name }, thenDo); },
      _runChange: function _runChange(op, args, thenDo) {
        this._run(op, args, 60000, function (err, result) {
          if (!err) { try { window.dispatchEvent(new Event("keo-worlds-changed")); } catch (e) {} }
          if (thenDo) thenDo(err, result);
        });
      },

      // ─── direct connections to another device (shell/keo-p2p.js) ────────────────
      // Two devices connect by swapping two short codes by hand (paste, or later a QR); no server is involved, so it works
      // between devices that can reach each other directly. peerOffer makes an invitation, the other device takes it with
      // peerAnswer, and its reply goes back through peerFinish. The codes name nobody: WHO is there is proven over the channel
      // and arrives as a "state" event with state "ready" and peer { did, name } (see onPeerEvent). `name` is what this side
      // chooses to show the other (the identity's label never leaves the device on its own); empty means none.
      //   peerOffer(name)               -> { id, code }
      //   peerAnswer(code, name)        -> { id, code }
      //   peerOfferFor(did, name)       -> { id, code }   an invitation FOR one device (a reconnect to a friend): the connection is
      //                                                  closed if the device that answers proves a different identity
      //   peerFinish(id, code)          -> { id }
      //   peerSend(id, file)            -> { fid }   a Blob/File; the other side must agree before a byte moves
      //   peerRespond(id, fid, accept)  -> true      answers an incoming offer
      //   peerCancel(id, fid), peerSave(id, fid) (a received file goes to the browser's download), peerClose(id), peerList()
      peerOffer: function peerOffer(name, thenDo) { this._run("p2p.offer", { name: name }, 60000, thenDo); },
      peerAnswer: function peerAnswer(code, name, thenDo) { this._run("p2p.answer", { code: code, name: name }, 60000, thenDo); },
      peerOfferFor: function peerOfferFor(did, name, thenDo) { this._run("p2p.offer", { name: name, expect: did }, 60000, thenDo); },
      peerFinish: function peerFinish(id, code, thenDo) { this._run("p2p.finish", { id: id, code: code }, 60000, thenDo); },
      peerSend: function peerSend(id, file, thenDo) { this._run("p2p.send", { id: id, file: file }, 60000, thenDo); },
      peerRespond: function peerRespond(id, fid, accept, thenDo) { this._run("p2p.respond", { id: id, fid: fid, accept: !!accept }, 30000, thenDo); },
      peerCancel: function peerCancel(id, fid, thenDo) { this._run("p2p.cancel", { id: id, fid: fid }, 30000, thenDo); },
      peerSave: function peerSave(id, fid, thenDo) { this._run("p2p.save", { id: id, fid: fid }, 30000, thenDo); },
      peerClose: function peerClose(id, thenDo) { this._run("p2p.close", { id: id }, 30000, thenDo || function () {}); },
      peerList: function peerList(thenDo) { this._run("p2p.list", {}, 30000, thenDo); },

      // Events the shell pushes about connections: { type, id, ... } with type "state" (state: invited / connecting / open / ready
      // / closed, peer, why, and friend / added / theirs, see below), "friendship" (friend / added / theirs changed on a ready
      // connection), "incoming", "progress", "received", "saved", "delivered", "declined", "cancelled", "failed" (the file events
      // carry fid, name and dir "in" or "out"). Not queued: ask peerList for the state at hand when a listener starts.
      // Returns a function that stops listening.
      // friend: files, messages and calls work only when it is true, which needs BOTH added (this identity checked the device's
      // eight words and added it) and theirs (the device has told us, on this connection, that it added us).
      onPeerEvent: function onPeerEvent(fn) {
        if (!this.isAvailable() || typeof window.keo.on !== "function") return function () {};
        return window.keo.on("p2p", fn);
      },

      // The person asked, in the toolbar popup, to reconnect to a friend: fn({ did, name }). The shell only says that it was asked (and
      // checked that the device is a friend); the world opens the Connect a device window for it. Not queued: a world that is not up
      // misses it. Returns a function that stops listening.
      onReconnectRequest: function onReconnectRequest(fn) {
        if (!this.isAvailable() || typeof window.keo.on !== "function") return function () {};
        return window.keo.on("reconnect", fn);
      },

      // The person clicked something else in the toolbar popup that opens a window here: fn({ what, did, name }) with what "chat" (the
      // Messages window for a connected friend), "connect" (the Connect a device window) or "signout". The shell has checked the
      // request makes sense (a signed-in session, and for chat a friend with a connection that is ready); the world only draws.
      // Not queued: a world that is not up misses it. Returns a function that stops listening.
      onOpenRequest: function onOpenRequest(fn) {
        if (!this.isAvailable() || typeof window.keo.on !== "function") return function () {};
        return window.keo.on("open", fn);
      },

      // ─── friends (shell/keo-friend.js, keo-contacts.js) ─────────────────────────
      // Files, messages and calls work only between friends. Two devices become friends when each person has added the other,
      // and adding happens only in a dialog the SHELL draws: the person reads their own eight words to the other and types the
      // eight words they hear back, and the dialog adds the device only if those match the identity that proved itself. The world
      // can only ASK for that dialog, list who was added, read its own words, and ask to remove a friend (the shell asks the
      // person first). It cannot add, answer or hide anything, and it is never given the other device's words.
      //   friendStart(id)    -> true             puts the shell's dialog up for a ready connection
      //   friendList()       -> [{ did, name, at }]   the devices this identity has added
      //   friendWords()      -> [8 words]        this identity's own words (to show, so they can be read out)
      //   friendRemove(did)  -> true             the shell asks first; the device is told and any connection to it ends
      //   onFriendEvent(fn): { type: "friend", kind: "theirs" | "untheirs" | "added" | "removed", peer { did, name } }
      friendStart: function friendStart(id, thenDo) { this._run("friend.start", { id: id }, 30000, thenDo); },
      friendList: function friendList(thenDo) { this._run("friend.list", {}, 30000, thenDo); },
      friendWords: function friendWords(thenDo) { this._run("friend.words", {}, 30000, thenDo); },
      friendRemove: function friendRemove(did, thenDo) { this._run("friend.remove", { did: did }, 120000, thenDo || function () {}); },
      onFriendEvent: function onFriendEvent(fn) {
        if (!this.isAvailable() || typeof window.keo.on !== "function") return function () {};
        return window.keo.on("friend", fn);
      },

      // ─── calls (shell/keo-call.js) ──────────────────────────────────────────────
      // The world can only ASK. callStart puts a prompt in front of the person in the shell's own call panel (outside this frame);
      // nothing is captured until they click it there, and there is no way from here to accept, answer, move or hide anything.
      // The camera and microphone, and the pictures, stay in the shell: the world gets text events only.
      //   callStart(id, thenDo, opts) -> { cid }   `id` is a connection that is ready (peerList / the 'ready' state event); refused
      //                               while a call is under way, and for a few seconds after the person dismissed a prompt.
      //                               opts.audioOnly: the prompt offers no video choice (a request can only ask for less)
      //   callEnd(id)    -> true      hangs up or withdraws the prompt
      //   callState()    -> the call at hand or null
      //   onCallEvent(fn): { type: "call", id, cid, state, dir, peer { did, name }, video, wantsVideo, mic, cam, remoteVideo, why }
      //     with state confirming / starting / ringing / incoming / accepting / connecting / active / ended (why says how it ended).
      //     Not queued: ask callState when a listener starts. Returns a function that stops listening.
      callStart: function callStart(id, thenDo, opts) { this._run("call.start", { id: id, audioOnly: !!(opts && opts.audioOnly) }, 30000, thenDo); },
      callEnd: function callEnd(id, thenDo) { this._run("call.end", { id: id }, 30000, thenDo || function () {}); },
      // callLower(id, what) -> true   what is "mic" or "cam": mutes the microphone or switches the camera off. The world may only LOWER
      // what is captured; turning either back on is a click in the shell's call panel.
      callLower: function callLower(id, what, thenDo) { this._run("call.lower", { id: id, what: what }, 30000, thenDo || function () {}); },
      callState: function callState(thenDo) { this._run("call.state", {}, 30000, thenDo); },
      onCallEvent: function onCallEvent(fn) {
        if (!this.isAvailable() || typeof window.keo.on !== "function") return function () {};
        return window.keo.on("call", fn);
      },

      // ─── text messages (shell/keo-dm.js) ────────────────────────────────────────
      // Over a ready connection, only while it is up (no host, so nowhere to leave a message for later). The world PULLS what
      // arrived, because events are not queued: onDmEvent says something is waiting, dmTake lists the waiting messages
      // ({ id, mid, text, at, peer { did, name } }), and dmDone(mids) drops the ones that have been saved.
      //   dmSend(id, text) -> { mid, at, peer }       text up to 8000 characters
      dmSend: function dmSend(id, text, thenDo) { this._run("dm.send", { id: id, text: text }, 30000, thenDo); },
      dmTake: function dmTake(thenDo) { this._run("dm.take", {}, 30000, thenDo); },
      dmDone: function dmDone(mids, thenDo) { this._run("dm.done", { mids: mids }, 30000, thenDo || function () {}); },
      onDmEvent: function onDmEvent(fn) {
        if (!this.isAvailable() || typeof window.keo.on !== "function") return function () {};
        return window.keo.on("dm", fn);
      },

      // ─── message history (shell/keo-chatlog.js) ─────────────────────────────────
      // The signed-in identity's conversations, kept by the shell encrypted under that identity: only its own are reachable, and
      // removing the identity removes them. A message is { k, dir ("in" | "out"), text, at (ISO time) }; `k` names it, so adding
      // the same one twice keeps it once.
      //   chatAppend({ peerDid, label, k, dir, text, at }) -> { added }
      //   chatThread(peerDid) -> [message] oldest first      chatThreads() -> [{ peerDid, label, lastText, lastAt, lastDir }]
      //   chatRemove(peerDid) -> true
      chatAppend: function chatAppend(row, thenDo) { this._run("chat.append", row, 30000, thenDo); },
      chatThread: function chatThread(peerDid, thenDo) { this._run("chat.thread", { peerDid: peerDid }, 30000, thenDo); },
      chatThreads: function chatThreads(thenDo) { this._run("chat.threads", {}, 30000, thenDo); },
      chatRemove: function chatRemove(peerDid, thenDo) { this._run("chat.remove", { peerDid: peerDid }, 30000, thenDo || function () {}); },

      // Puts text on the clipboard from inside the sandboxed world, where the clipboard API is not allowed: tries it, then
      // the old way (a selected text field and a copy command, which a click in this page permits). thenDo(true|false).
      copyText: function copyText(text, thenDo) {
        function legacy() {
          var ok = false, ta = document.createElement("textarea");
          ta.value = text;
          ta.setAttribute("readonly", "");
          ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
          document.body.appendChild(ta);
          ta.select();
          try { ok = document.execCommand("copy"); } catch (e) {}
          document.body.removeChild(ta);
          thenDo(ok);
        }
        // Inside keo the clipboard API is always refused by the sandbox's permissions policy (and says so in the console
        // each time), so go straight to the old way there.
        if (this.isAvailable()) return legacy();
        try {
          navigator.clipboard.writeText(text).then(function () { thenDo(true); }, legacy);
        } catch (e) { legacy(); }
      },

      // A short form of a DID for places a name is not available: the first and last four characters of the HASH part,
      // the part bound to the authority set (the first part is only a lookup hint), e.g. "keo:7Q2F…xK9A". Anything that
      // is not a did:keo comes back unchanged.
      shortDid: function shortDid(did) {
        var m = /^did:keo:[^:]+:([A-Za-z0-9_-]{43})$/.exec(String(did));
        return m ? "keo:" + m[1].slice(0, 4) + "…" + m[1].slice(-4) : String(did);
      },

      _run: function _run(op, args, timeoutMs, thenDo) {
        if (!this.isAvailable()) {
          return thenDo(new Error("Local identities need the keo app: no shell to ask."));
        }
        window.keo.call(op, args, timeoutMs).then(
          function (result) { thenDo(null, result); },
          function (err) { thenDo(err); }
        );
      }
    });

    lively.identity.localIdentity = new lively.identity.LocalIdentity();

  }); // end module('lively.identity.LocalIdentity')
