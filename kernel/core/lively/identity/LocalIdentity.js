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
