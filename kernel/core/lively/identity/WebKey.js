/**
 * lively.identity.WebKey
 *
 * ObjID generation, cryptographic URL composition/parsing, and handle
 * resolution for the Lively identity system.
 *
 * Responsibilities:
 *   - ObjID generation: stable 12-char base64url identifier derived from
 *     the JWK thumbprint of the object's signing key (RFC 7638)
 *   - URL composition: build /@handle/objId URLs from parts
 *   - URL parsing: decompose a Lively identity URL into { origin, handle, objId }
 *   - Handle resolution: fetch /.well-known/lively-did from a domain to
 *     resolve a handle or domain to a did:jwk string
 *   - Handle validation: verify the .well-known document signature so
 *     resolution cannot be spoofed by a compromised server
 *   - Convenience constructors: build WebResource instances for identity
 *     URLs, fitting naturally into the existing URL / WebResource API
 *
 * What this module does NOT do:
 *   - Crypto primitives (lively.identity.Crypto)
 *   - DID document management (lively.identity.DID)
 *   - Object envelope signing (lively.identity.SignedSerializer)
 *   - Server-side routing (core/servers/identity/IdentityServer.js)
 *
 * Async pattern: thenDo(err, result) throughout.
 *
 * URL scheme:
 *   https://example.com/@alice/ufge7eezJHc7   object by ObjID
 *   https://example.com/@alice/               user home manifest
 *   https://example.com/@alice.com/           domain-verified handle root
 *   https://example.com/.well-known/lively-did handle→DID resolution doc
 *   https://alice.com/.well-known/lively-did   domain handle resolution doc
 */

module("lively.identity.WebKey")
  .requires("lively.identity.Crypto")
  .toRun(function () {
    Object.subclass(
      "lively.identity.WebKey",

      // ─── ObjID ───────────────────────────────────────────────────────────────────

      "objId",
      {
        // Generate a stable ObjID from a public key JWK.
        //
        // ObjID = base64url(SHA-256(canonicalJwk))[0..12]
        //
        // Delegates to lively.identity.Crypto.computeObjId which applies
        // RFC 7638 canonicalization (strips non-required JWK fields) before hashing.
        //
        // Calls thenDo(null, objId) where objId is a 12-char base64url string.
        generateObjId: function (publicKeyJwk, thenDo) {
          lively.identity.crypto.computeObjId(publicKeyJwk, thenDo);
        },

        // Generate a genesis-derived ObjID for a new object (anything except the home manifest).
        //
        // objId = base64url(SHA-256(authorDid + ":" + base64url(random16Bytes)))[0..12]
        //
        // Self-certifying: no per-object private key is created or stored.
        // The genesisNonce is returned so callers can embed it in the genesis envelope
        // as proof that the objId was derived correctly.
        //
        // authorDid: String — the did:jwk string of the author (from currentUser().did)
        // Calls thenDo(null, { objId: String, genesisNonce: base64url String }).
        generateGenesisObjId: function (authorDid, thenDo) {
          var c = lively.identity.crypto;
          var nonce = new Uint8Array(16);
          crypto.getRandomValues(nonce);
          c.computeGenesisObjId(authorDid, nonce, function (err, objId) {
            if (err) return thenDo(err);
            thenDo(null, { objId: objId, genesisNonce: c.base64urlEncode(nonce) });
          });
        },

        // True if a string looks like a valid ObjID (12 base64url chars).
        isValidObjId: function (str) {
          return typeof str === "string" && /^[A-Za-z0-9\-_]{12}$/.test(str);
        },
      },

      // ─── URL composition ──────────────────────────────────────────────────────────

      "composition",
      {
        // Build the canonical URL for a Lively identity object.
        //
        // params: {
        //   origin:  String   — e.g. "https://example.com" or "http://localhost:9001"
        //                        If omitted, URL.root.toString() is used.
        //   handle:  String   — e.g. "alice" or "alice.com"
        //   objId:   String   — 12-char ObjID. Omit for the user home URL.
        // }
        //
        // Returns a Lively URL object (not a string) so callers can use
        // .asWebResource(), .withFilename(), etc. directly.
        buildObjectUrl: function (params) {
          var origin = params.origin ? new URL(params.origin) : URL.root;
          var handleSegment = "@" + params.handle;
          var pathname = "/" + handleSegment + "/" + (params.objId || "");
          return new URL({
            protocol: origin.protocol,
            hostname: origin.hostname,
            port: origin.port,
            pathname: pathname,
          });
        },

        // Build the /.well-known/lively-did URL for a given origin.
        // origin: String or Lively URL — if omitted, URL.root is used.
        buildWellKnownUrl: function (origin) {
          var base = origin
            ? typeof origin === "string"
              ? new URL(origin)
              : origin
            : URL.root;
          return new URL({
            protocol: base.protocol,
            hostname: base.hostname,
            port: base.port,
            pathname: "/.well-known/lively-did",
          });
        },

        // Build a WebResource for a Lively identity object URL.
        // Convenience wrapper: buildObjectUrl(params).asWebResource().beAsync()
        objectWebResource: function (params) {
          return this.buildObjectUrl(params).asWebResource().beAsync();
        },
      },

      // ─── URL parsing ──────────────────────────────────────────────────────────────

      "parsing",
      {
        // Parse a Lively identity URL string into its components.
        //
        // Accepts both string and Lively URL object inputs.
        //
        // Returns:
        // {
        //   origin:  String   — "https://example.com"
        //   handle:  String   — "alice" (without the @)
        //   objId:   String|null
        //   isHome:  Boolean  — true if URL ends at the handle root (no objId)
        // }
        //
        // Returns null if the URL does not match the /@handle pattern.
        parseObjectUrl: function (urlOrString) {
          var str =
            typeof urlOrString === "string"
              ? urlOrString
              : urlOrString.toString();

          // Match: <origin>/@<handle>/<objId>  or  <origin>/@<handle>/
          var match = str.match(
            /^(https?:\/\/[^\/]+)\/@([^\/]+)\/?([A-Za-z0-9\-_]*)$/,
          );
          if (!match) return null;

          var objId = match[3] || null;
          if (objId && !this.isValidObjId(objId)) objId = null;

          return {
            origin: match[1],
            handle: match[2], // may include a dot, e.g. "alice.com"
            objId: objId,
            isHome: !objId,
          };
        },

        // True if a string is a Lively handle URL (with or without objId).
        isHandleUrl: function (str) {
          return !!this.parseObjectUrl(str);
        },

        // Extract just the handle from a URL or handle string.
        // Accepts "@alice", "alice", or a full URL.
        normalizeHandle: function (handleOrUrl) {
          if (
            handleOrUrl &&
            handleOrUrl.startsWith &&
            handleOrUrl.startsWith("http")
          ) {
            var parsed = this.parseObjectUrl(handleOrUrl);
            return parsed ? parsed.handle : null;
          }
          return String(handleOrUrl).replace(/^@/, "");
        },
      },

      // ─── handle resolution ────────────────────────────────────────────────────────

      "resolution",
      {
        // Resolve a handle or domain-handle to a did:jwk string.
        //
        // Strategy (AT Protocol style):
        //   1. If handle contains a dot (e.g. "alice.com"), first try fetching
        //      https://alice.com/.well-known/lively-did directly.
        //      If that fails or the domain doesn't verify, fall through to step 2.
        //   2. Fetch /.well-known/lively-did from URL.root (the current Lively server)
        //      and look up the handle in the server's registry response.
        //
        // In both cases the .well-known document's signature is verified before
        // trusting the DID it contains.
        //
        // Calls thenDo(null, { did, handle, domain, verified }) on success.
        // `verified` is true if the domain .well-known resolved and its sig was valid.
        resolveHandle: function (handle, thenDo) {
          var self = this;
          handle = self.normalizeHandle(handle);
          var hasDot = handle.indexOf(".") !== -1;

          if (hasDot) {
            // Try domain-based resolution first
            self._fetchWellKnown("https://" + handle, function (err, doc) {
              if (!err && doc && doc.did) {
                self._verifyWellKnown(doc, function (verifyErr, valid) {
                  if (!verifyErr && valid && doc.did) {
                    return thenDo(null, {
                      did: doc.did,
                      handle: handle,
                      domain: handle,
                      verified: true,
                    });
                  }
                  // Domain fetch succeeded but sig invalid — fall through to server
                  self._resolveViaServer(handle, thenDo);
                });
              } else {
                // Domain fetch failed — fall through to server
                self._resolveViaServer(handle, thenDo);
              }
            });
          } else {
            self._resolveViaServer(handle, thenDo);
          }
        },

        // Fetch /.well-known/lively-did from the current Lively server and ask
        // it to look up a specific handle.
        // Server is expected to respond with a JSON doc for that handle.
        _resolveViaServer: function (handle, thenDo) {
          var self = this;
          var url = URL.root
            .withFilename(".well-known/lively-did")
            .withQuery({ handle: handle });
          url
            .asWebResource()
            .beAsync()
            .noProxy()
            .get()
            .withJSONWhenDone(function (doc, status) {
              if (!status.isSuccess() || !doc || !doc.did) {
                return thenDo(
                  new Error(
                    'Handle resolution failed for "' +
                      handle +
                      '": ' +
                      (doc && doc.error
                        ? doc.error
                        : "server returned " + status.code),
                  ),
                );
              }
              self._verifyWellKnown(doc, function (err, valid) {
                if (err) return thenDo(err);
                thenDo(null, {
                  did: doc.did,
                  handle: doc.handle || handle,
                  domain: doc.domain || null,
                  verified: valid,
                });
              });
            });
        },

        // Fetch /.well-known/lively-did from an arbitrary origin string.
        // Calls thenDo(null, parsedDoc) or thenDo(err).
        _fetchWellKnown: function (origin, thenDo) {
          var url = this.buildWellKnownUrl(origin);
          url
            .asWebResource()
            .beAsync()
            .noProxy()
            .get()
            .withJSONWhenDone(function (doc, status) {
              if (!status.isSuccess()) {
                return thenDo(
                  new Error("Could not fetch " + url + ": " + status.code),
                );
              }
              thenDo(null, doc);
            });
        },

        // Verify the signature on a .well-known/lively-did document.
        //
        // The document shape is:
        // {
        //   did:    "did:jwk:...",
        //   handle: "alice",
        //   domain: "alice.com",    // optional
        //   sig:    "<JWS compact>" // over canonicalJson({ did, handle, domain })
        // }
        //
        // Verification: extract the public key from `did`, then call
        // lively.identity.Crypto.verifyJws with that key.
        //
        // Calls thenDo(null, true|false).
        _verifyWellKnown: function (doc, thenDo) {
          if (!doc || !doc.did || !doc.sig) return thenDo(null, false);

          var c = lively.identity.crypto;
          // Reconstruct the payload that was signed
          var payload = { did: doc.did, handle: doc.handle };
          if (doc.domain) payload.domain = doc.domain;

          var expectedPayloadB64 = c.base64urlEncode(
            new TextEncoder().encode(c.canonicalJson(payload)),
          );

          var parts = doc.sig.split(".");
          if (parts.length !== 3 || parts[1] !== expectedPayloadB64) {
            return thenDo(null, false);
          }

          // Inline jwkFromDid: pure base64url decode + JSON parse.
          // Avoids a dependency on lively.identity.DID — WebKey depends only
          // on Crypto. Any decode failure means the DID is malformed; treat
          // as verification failure rather than propagating an error.
          try {
            var encoded = doc.did.slice("did:jwk:".length);
            var jwk = JSON.parse(
              new TextDecoder().decode(c.base64urlDecode(encoded)),
            );
            c.verifyJws(doc.sig, jwk, thenDo);
          } catch (e) {
            thenDo(null, false);
          }
        },
      },

      // ─── well-known document building (for server use via server modules) ─────────

      "wellKnown",
      {
        // Build a .well-known/lively-did document ready to be signed.
        // Signing is done by the server's identity module using the user's DID key.
        //
        // params: { did, handle, domain? }
        buildWellKnownPayload: function (params) {
          var doc = { did: params.did, handle: params.handle };
          if (params.domain) doc.domain = params.domain;
          return doc;
        },

        // Sign a .well-known payload with a private key.
        // Produces a complete document with a `sig` field.
        // Calls thenDo(null, signedDoc).
        signWellKnown: function (payload, privateKey, thenDo) {
          var c = lively.identity.crypto;
          c.signJws(payload, privateKey, function (err, jws) {
            if (err) return thenDo(err);
            var signed = Object.assign({}, payload, { sig: jws });
            thenDo(null, signed);
          });
        },
      },

      // ─── URL helpers for the rest of the identity stack ──────────────────────────

      "helpers",
      {
        // Return the home manifest URL for the current user.
        // Requires a session to be established (lively.identity.did.currentUser()).
        currentUserHomeUrl: function () {
          var user = lively.identity.did.currentUser();
          if (!user) return null;
          return this.buildObjectUrl({ handle: user.handle });
        },

        // Return the object URL for a given ObjID under the current user.
        currentUserObjectUrl: function (objId) {
          var user = lively.identity.did.currentUser();
          if (!user) return null;
          return this.buildObjectUrl({ handle: user.handle, objId: objId });
        },

        // Return the object URL for a given ObjID under any handle.
        objectUrlFor: function (handle, objId) {
          return this.buildObjectUrl({ handle: handle, objId: objId });
        },
      },
    );

    // Singleton
    lively.identity.webKey = new lively.identity.WebKey();
  }); // end module('lively.identity.WebKey')
