/**
 * lively.identity.AudienceRules
 *
 * Pure rules for who a postcard is shared with: expanding an audience (Friends,
 * Orbit, named lists, specific people) into a set of DIDs, and diffing that set
 * against a card's current record.recipients. No network, no crypto, no DOM, so
 * the logic can be unit-tested in node (tests/server/audience-rules.test.js loads
 * this file with a stub `module`). PostcardAudience.js does the I/O around it.
 *
 * An audience is { tiers: ['friends'|'orbit'|'list:<id>', ...], people: [did, ...] }.
 * The audience of a card is the UNION of everything ticked; a person who is in
 * several of the sets is one recipient, and the owner is never a recipient (the
 * owner opens a card with the key wrapped under their own KEK).
 *
 * ctx = { ownerDid, friendDids: [did] (everyone in a set must be one of these),
 *         orbitDids: [did],
 *         lists: [{ id, memberDids: [did] }] }
 */

module('lively.identity.AudienceRules')
  .requires()
  .toRun(function () {

    var TIER_FRIENDS = 'friends';
    var TIER_ORBIT = 'orbit';
    var LIST_PREFIX = 'list:';

    // Only current friends can be recipients: a list or a named person that is
    // stored with someone who is no longer a friend stands for nobody, so ending a
    // friendship withdraws access on the next sync without any settings edit.
    function pushUnique(out, did, ctx) {
      if (typeof did !== 'string' || !did || did === ctx.ownerDid) return;
      if ((ctx.friendDids || []).indexOf(did) === -1) return;
      if (out.indexOf(did) === -1) out.push(did);
    }

    // The DIDs one tier stands for right now. An unknown tier, or a list that no
    // longer exists, stands for nobody.
    function tierDids(tier, ctx) {
      if (tier === TIER_FRIENDS) return ctx.friendDids || [];
      if (tier === TIER_ORBIT) return ctx.orbitDids || [];
      if (typeof tier === 'string' && tier.indexOf(LIST_PREFIX) === 0) {
        var id = tier.slice(LIST_PREFIX.length);
        var lists = ctx.lists || [];
        for (var i = 0; i < lists.length; i++) {
          if (lists[i].id === id) return lists[i].memberDids || [];
        }
      }
      return [];
    }

    // The de-duplicated union of every tier plus the named people.
    function unionDids(audience, ctx) {
      var out = [];
      var a = audience || {};
      (a.tiers || []).forEach(function (t) {
        tierDids(t, ctx).forEach(function (d) { pushUnique(out, d, ctx); });
      });
      (a.people || []).forEach(function (d) { pushUnique(out, d, ctx); });
      return out;
    }

    // Compare a card's current recipient entries ({did, sealedDek}) with the DIDs it
    // should have. An entry with no sealedDek cannot open anything (the server's
    // addRecipient helper appends bare {did}), so it counts as missing and gets
    // sealed again.
    //   keep:   existing entries to carry over unchanged
    //   add:    DIDs that need a fresh sealed key
    //   remove: DIDs to withdraw
    //   changed: whether the recipient list differs at all
    function planRecipients(currentEntries, desiredDids) {
      var have = {};
      var currentDids = [];
      (currentEntries || []).forEach(function (e) {
        if (!e || !e.did) return;
        if (currentDids.indexOf(e.did) === -1) currentDids.push(e.did);
        if (e.sealedDek && !have[e.did]) have[e.did] = e;
      });
      var want = {};
      desiredDids.forEach(function (d) { want[d] = true; });
      var keep = [];
      var add = [];
      desiredDids.forEach(function (d) {
        if (have[d]) keep.push(have[d]); else add.push(d);
      });
      var remove = currentDids.filter(function (d) { return !want[d]; });
      return { keep: keep, add: add, remove: remove, changed: add.length > 0 || remove.length > 0 };
    }

    // The sinceCid for a recipient entry written into a new version of a card: the
    // version the person was first sealed into, so a reader can later be shown what
    // changed since. A person already on the previous version keeps whatever that
    // entry carried (nothing, for a card shared before this existed: the baseline is
    // unknown and stays unknown rather than being reset to now); a person who is not
    // there yet starts at the new version.
    function sinceCidFor(prevEntries, did, newCid) {
      var prev = (prevEntries || []).filter(function (e) { return e && e.did === did; })[0];
      if (prev) return prev.sinceCid || undefined;
      return newCid;
    }

    // 'shared' if anyone can open the card besides its owner, else 'private'.
    function visibilityFor(recipientCount) {
      return recipientCount > 0 ? 'shared' : 'private';
    }

    // What goes in the card's own state.audience, which every recipient can read:
    // only the coarse shape, never a list id, a list name or a person. `custom`
    // means a list or named people are part of the audience.
    function mirrorFor(audience) {
      var a = audience || {};
      var tiers = [];
      var custom = (a.people || []).length > 0;
      (a.tiers || []).forEach(function (t) {
        if (t === TIER_FRIENDS || t === TIER_ORBIT) {
          if (tiers.indexOf(t) === -1) tiers.push(t);
        } else {
          custom = true;
        }
      });
      var mirror = { tiers: tiers };
      if (custom) mirror.custom = true;
      return mirror;
    }

    function sameMirror(a, b) {
      return JSON.stringify(a || null) === JSON.stringify(b || null);
    }

    // ─── the audience dialog's state, and the chip labels ──────────────────────
    //
    // state = { pub: bool, friends: bool, orbit: bool, lists: { <id>: true }, people: [did] }
    // is what the checkboxes show. Public is exclusive: ticking it clears everything
    // else, and ticking anything else clears it.

    function emptyState() {
      return { pub: false, friends: false, orbit: false, lists: {}, people: [] };
    }

    function stateFromAudience(audience, isPublic) {
      var s = emptyState();
      if (isPublic) { s.pub = true; return s; }
      var a = audience || {};
      (a.tiers || []).forEach(function (t) {
        if (t === TIER_FRIENDS) s.friends = true;
        else if (t === TIER_ORBIT) s.orbit = true;
        else if (typeof t === 'string' && t.indexOf(LIST_PREFIX) === 0) s.lists[t.slice(LIST_PREFIX.length)] = true;
      });
      s.people = (a.people || []).slice();
      return s;
    }

    // Tiers come out in a fixed order (friends, orbit, then lists in the order the
    // owner keeps them) so equal audiences compare equal.
    function audienceFromState(state, ctx) {
      var tiers = [];
      if (state.friends) tiers.push(TIER_FRIENDS);
      if (state.orbit) tiers.push(TIER_ORBIT);
      ((ctx && ctx.lists) || []).forEach(function (l) {
        if (state.lists[l.id]) tiers.push(LIST_PREFIX + l.id);
      });
      return { tiers: tiers, people: state.people.slice() };
    }

    // Nothing is ticked and the card is not public: only the owner can open it.
    // Shown as its own row ("Only me"), which is exclusive like Public.
    function isOnlyMe(state) {
      return !state.pub && !state.friends && !state.orbit && !state.people.length &&
        Object.keys(state.lists).length === 0;
    }

    // Returns a new state with one checkbox flipped. key is 'pub', 'friends',
    // 'orbit', 'list:<id>' or 'me' (clears everything else; it cannot be unticked,
    // choosing someone else is how you leave it).
    function toggle(state, key) {
      var s = { pub: state.pub, friends: state.friends, orbit: state.orbit,
                lists: Object.assign({}, state.lists), people: state.people.slice() };
      var on;
      if (key === 'me') return emptyState();
      if (key === 'pub') {
        on = !s.pub;
        if (on) s = emptyState();
        s.pub = on;
        return s;
      }
      if (key === TIER_FRIENDS) { on = s.friends = !s.friends; }
      else if (key === TIER_ORBIT) { on = s.orbit = !s.orbit; }
      else if (typeof key === 'string' && key.indexOf(LIST_PREFIX) === 0) {
        var id = key.slice(LIST_PREFIX.length);
        on = !s.lists[id];
        if (on) s.lists[id] = true; else delete s.lists[id];
      } else return s;
      if (on) s.pub = false;
      return s;
    }

    function togglePerson(state, did) {
      var s = toggle(state, '__none__');
      var at = s.people.indexOf(did);
      if (at === -1) { s.people.push(did); s.pub = false; } else s.people.splice(at, 1);
      return s;
    }

    // How many people would be able to open the card: the de-duplicated union of
    // everything ticked. Public has no recipients (the card is not encrypted).
    function sealedCount(state, ctx) {
      if (state.pub) return 0;
      return unionDids(audienceFromState(state, ctx), ctx).length;
    }

    function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

    // noun: what is being shared, 'card' unless the caller says otherwise ('game').
    function footerText(state, ctx, noun) {
      noun = noun || 'card';
      if (state.pub) return 'Anyone can read this ' + noun + '. It is not encrypted.';
      var n = sealedCount(state, ctx);
      if (!n) return 'Only you can open this ' + noun + '.';
      return 'Sealed to ' + plural(n, 'person', 'people') + '. Only they can open it.';
    }

    // The owner's chip: the ticked sets joined, then the de-duplicated count, e.g.
    // "Friends · 14", "Orbit + Book club · 9", or "3 audiences · 22" when the names
    // would not fit.
    function ownerChipLabel(audience, ctx, isPublic) {
      if (isPublic) return 'Public';
      var a = audience || {};
      var names = [];
      (a.tiers || []).forEach(function (t) {
        if (t === TIER_FRIENDS) names.push('Friends');
        else if (t === TIER_ORBIT) names.push('Orbit');
        else if (typeof t === 'string' && t.indexOf(LIST_PREFIX) === 0) {
          var id = t.slice(LIST_PREFIX.length);
          var list = ((ctx && ctx.lists) || []).filter(function (l) { return l.id === id; })[0];
          if (list) names.push(list.name);
        }
      });
      if ((a.people || []).length) names.push('Specific people');
      var count = unionDids(a, ctx).length;
      if (!names.length) return 'Only me';
      var joined = names.length <= 2 ? names.join(' + ') : names.length + ' audiences';
      return joined + ' · ' + count;
    }

    // What anyone but the owner sees: only the sets that are not private to the
    // owner (Friends, Orbit), never a list name or a person. A card shared with
    // nothing but a list or named people reads "Just a few people", and so does an
    // older shared card that has no recorded audience.
    function viewerChipLabel(visibility, mirror) {
      if (visibility === 'public') return 'Public';
      if (visibility !== 'shared') return null;
      var tiers = (mirror && mirror.tiers) || [];
      var names = [];
      if (tiers.indexOf(TIER_FRIENDS) !== -1) names.push('Friends');
      if (tiers.indexOf(TIER_ORBIT) !== -1) names.push('Orbit');
      return names.length ? names.join(' + ') : 'Just a few people';
    }

    lively.identity = lively.identity || {};
    // ─── named lists ─────────────────────────────────────────────────────────
    // Limits match core/servers/identity/AudienceLists.js, which enforces them.

    var MAX_LISTS = 50;
    var MAX_LIST_NAME = 60;
    var MAX_LIST_MEMBERS = 200;

    // An opaque id for a new list: letters and digits only (what the server accepts),
    // and not one that is already in use. `random` is Math.random in the browser;
    // a test passes its own.
    function newListId(lists, random) {
      random = random || Math.random;
      var taken = {};
      (lists || []).forEach(function (l) { taken[l.id] = true; });
      for (;;) {
        var id = 'l';
        for (var i = 0; i < 9; i++) id += Math.floor(random() * 36).toString(36);
        if (!taken[id]) return id;
      }
    }

    // Why `name` cannot be used for a list, or null. exceptId is the list being renamed
    // (it may keep its own name). Names are compared ignoring case and spacing, so two
    // lists cannot look the same in the dialog.
    function listNameError(name, lists, exceptId) {
      var n = String(name == null ? '' : name).trim();
      if (!n) return 'Give the list a name';
      if (n.length > MAX_LIST_NAME) return 'A list name can have at most ' + MAX_LIST_NAME + ' characters';
      var key = n.toLowerCase().replace(/\s+/g, ' ');
      var clash = (lists || []).some(function (l) {
        return l.id !== exceptId && String(l.name).trim().toLowerCase().replace(/\s+/g, ' ') === key;
      });
      return clash ? 'You already have a list with that name' : null;
    }

    // dids with `did` added, or removed when it is already there. Returns a new array.
    function toggleDid(dids, did) {
      var out = (dids || []).slice();
      var i = out.indexOf(did);
      if (i === -1) out.push(did); else out.splice(i, 1);
      return out;
    }

    lively.identity.AudienceRules = {
      MAX_LISTS: MAX_LISTS,
      MAX_LIST_NAME: MAX_LIST_NAME,
      MAX_LIST_MEMBERS: MAX_LIST_MEMBERS,
      newListId: newListId,
      listNameError: listNameError,
      toggleDid: toggleDid,
      emptyState: emptyState,
      isOnlyMe: isOnlyMe,
      stateFromAudience: stateFromAudience,
      audienceFromState: audienceFromState,
      toggle: toggle,
      togglePerson: togglePerson,
      sealedCount: sealedCount,
      footerText: footerText,
      ownerChipLabel: ownerChipLabel,
      viewerChipLabel: viewerChipLabel,
      TIER_FRIENDS: TIER_FRIENDS,
      TIER_ORBIT: TIER_ORBIT,
      LIST_PREFIX: LIST_PREFIX,
      tierDids: tierDids,
      unionDids: unionDids,
      planRecipients: planRecipients,
      sinceCidFor: sinceCidFor,
      visibilityFor: visibilityFor,
      mirrorFor: mirrorFor,
      sameMirror: sameMirror
    };

  }); // end module('lively.identity.AudienceRules')
