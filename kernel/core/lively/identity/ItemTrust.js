/**
 * lively.identity.ItemTrust
 *
 * An item's embedded addScript/BuildSpec source is eval'd directly in this
 * page's own JS context the moment it's loaded (lively.PartsBin.PartItem's
 * setPartFromJSON) -- full privileges, no sandbox. This module is the
 * trust-tier gate that guards that: the current user's own items, items
 * from an author already on this local trust list, and classic (unsigned)
 * items whose exact content hash is already locally content-trusted, all
 * load with no friction; everything else is confirmed first via
 * ItemTrustGate.
 *
 * Two separate trust lists, deliberately not conflated:
 *   - author trust (isTrusted/trust) -- keyed by DID, for signed
 *     identity-published items. Trusting an author covers every item they
 *     publish, present and future.
 *   - content trust (isContentTrusted/trustContent) -- keyed by a SHA-256
 *     hash of the exact JSON, for classic WebDAV-path items, which carry no
 *     signature/authorship at all. A path/name allowlist ("trust anything
 *     under PartsBin/Debugging/") was considered and rejected: any
 *     authenticated user can currently write to a classic PartsBin path,
 *     not just an admin (see WEBDAV.md), so trusting a path would trust
 *     content that could have been silently replaced. Hashing the exact
 *     bytes means a later tamper changes the hash and the gate reappears
 *     automatically, rather than staying silently bypassed.
 *
 * Both lists are deliberately simple -- a per-device localStorage list the
 * viewer builds up themselves (same persisted-preference idiom as
 * Wallet.js's _NETWORK_STORAGE_KEY), not a reputation system. No server
 * round trip, no new schema.
 */
module('lively.identity.ItemTrust')
  .requires()
  .toRun(function () {

    lively.identity = lively.identity || {};

    lively.identity.ItemTrust = {
      _KEY: 'lively.identity.trustedItemAuthors',
      _CONTENT_KEY: 'lively.identity.trustedItemContentHashes',

      isTrusted: function (did) {
        return !!did && this._loadList(this._KEY).indexOf(did) !== -1;
      },

      trust: function (did) {
        if (!did) return;
        this._addToList(this._KEY, did);
      },

      isContentTrusted: function (hash) {
        return !!hash && this._loadList(this._CONTENT_KEY).indexOf(hash) !== -1;
      },

      trustContent: function (hash) {
        if (!hash) return;
        this._addToList(this._CONTENT_KEY, hash);
      },

      _addToList: function (key, value) {
        var list = this._loadList(key);
        if (list.indexOf(value) === -1) {
          list.push(value);
          this._saveList(key, list);
        }
      },

      _loadList: function (key) {
        try {
          var raw = window.localStorage.getItem(key);
          var list = raw ? JSON.parse(raw) : [];
          return Array.isArray(list) ? list : [];
        } catch (e) { return []; }
      },

      _saveList: function (key, list) {
        try { window.localStorage.setItem(key, JSON.stringify(list)); }
        catch (e) {}
      }
    };

    // The actual confirmation UI shown by PartItem>>setPartFromJSON for any
    // item whose getTrustInfo() didn't come back 'own'/'signed-allowlisted'.
    // "View Source" re-opens this same confirm afterward rather than
    // consuming the gate, so looking at the code isn't itself a way to
    // bypass deciding whether to run it.
    lively.identity.ItemTrustGate = {
      confirm: function (item, trust, json, cb) {
        var name = (item && item.name) || 'this item';
        var message = trust.tier === 'unsigned'
          ? '"' + name + '" is from an unverified source (no signature) and will run with full page privileges if loaded. This could be unsafe.'
          : '"' + name + '" is signed by an author you have not trusted before (' +
            (trust.did ? trust.did.slice(0, 24) + '…' : 'unresolved DID') +
            ') and will run with full page privileges if loaded.';

        $world.multipleChoicePrompt(message, ['View Source', 'Load Anyway', 'Cancel'], function (choice) {
          if (choice === 'View Source') {
            lively.require('lively.morphic.tools.ItemSourceViewer').toRun(function () {
              lively.morphic.tools.ItemSourceViewer.open(name, json);
            });
            // Doesn't consume the gate -- re-ask once they've looked.
            lively.identity.ItemTrustGate.confirm(item, trust, json, cb);
            return;
          }
          if (choice !== 'Load Anyway') { cb(false, false); return; }
          if (trust.tier !== 'unsigned' && trust.did) {
            // signed-unknown: trust attaches to the author's DID, covers
            // every item they publish, present and future.
            $world.confirm(
              "Trust this author's items going forward, so they load without this prompt?",
              function (alwaysTrust) { cb(true, !!alwaysTrust); }
            );
            return;
          }
          if (trust.tier === 'unsigned' && trust.contentHash) {
            // Classic path, no signature -- trust attaches to this exact
            // file's content hash, not its name/path. If it's ever
            // modified, the hash won't match and this prompt comes back.
            $world.confirm(
              "Trust this exact file's content going forward, so it loads without this prompt? " +
              "If the file is ever changed, you'll be asked again.",
              function (alwaysTrust) { cb(true, !!alwaysTrust); }
            );
            return;
          }
          cb(true, false);
        });
      }
    };

  });
