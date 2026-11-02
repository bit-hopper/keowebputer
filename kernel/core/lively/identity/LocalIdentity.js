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
