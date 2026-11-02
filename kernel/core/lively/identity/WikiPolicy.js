/**
 * lively.identity.WikiPolicy
 *
 * Client-side helpers for a constellation wiki page's edit policy — who may
 * edit it — shared by NewWikiPageDialog.js (choosing it at creation) and
 * WikiEditor.js (the author changing it later). The rule itself is enforced
 * on the server (core/servers/identity/WikiPermissions.js); nothing here
 * decides access, it only builds and validates the value to send and words it
 * for the UI.
 *
 *   policy = { mode: 'members' | 'controllers' | 'handles', handles?: [string] }
 *   stored at envelope.state.editPolicy; absent means 'members'.
 *
 *   lively.identity.WikiPolicy.MODES            [{ key, label, hint }, ...]
 *   lively.identity.WikiPolicy.build(mode, handlesText) -> { policy, error }
 *   lively.identity.WikiPolicy.parseHandles(text) -> { handles, invalid }
 *   lively.identity.WikiPolicy.label(modeKey)   -> display name
 *   lively.identity.WikiPolicy.readOnlyMessage(reason, constellationName)
 */

module('lively.identity.WikiPolicy')
  .requires()
  .toRun(function () {

    // Same shape the server accepts (WikiPermissions.js HANDLE_RE / MAX_HANDLES).
    var HANDLE_RE = /^[a-z0-9_][a-z0-9_.-]{0,63}$/;
    var MAX_HANDLES = 50;

    var MODES = [
      { key: 'members',     label: 'All members',      hint: 'Anyone in the constellation' },
      { key: 'controllers', label: 'Controllers only', hint: 'You and the constellation\'s controllers' },
      { key: 'handles',     label: 'Specific handles', hint: 'You and the handles you list' },
    ];

    lively.identity.WikiPolicy = {
      MODES: MODES,
      MAX_HANDLES: MAX_HANDLES,

      label: function (modeKey) {
        var m = MODES.filter(function (x) { return x.key === modeKey; })[0];
        return m ? m.label : MODES[0].label;
      },

      // "alice, @Bob  carol.example" -> lowercase, no '@', de-duplicated, in the
      // order given. Splits on commas and whitespace.
      parseHandles: function (text) {
        var seen = {}, handles = [], invalid = [];
        String(text || '').split(/[\s,]+/).forEach(function (raw) {
          var h = raw.replace(/^@/, '').toLowerCase();
          if (!h || seen[h]) return;
          seen[h] = true;
          if (HANDLE_RE.test(h)) handles.push(h); else invalid.push(raw);
        });
        return { handles: handles, invalid: invalid };
      },

      // Returns { policy } to send/store, or { error } to show the user.
      build: function (modeKey, handlesText) {
        if (modeKey !== 'handles') return { policy: { mode: modeKey === 'controllers' ? 'controllers' : 'members' } };
        var parsed = lively.identity.WikiPolicy.parseHandles(handlesText);
        if (parsed.invalid.length) return { error: 'Not a valid handle: ' + parsed.invalid[0] };
        if (!parsed.handles.length) return { error: 'Enter at least one handle' };
        if (parsed.handles.length > MAX_HANDLES) return { error: 'At most ' + MAX_HANDLES + ' handles' };
        return { policy: { mode: 'handles', handles: parsed.handles } };
      },

      // Why a viewer is read-only, from the server's edit-token `reason`.
      readOnlyMessage: function (reason, constellationName) {
        switch (reason) {
          case 'controllers-only': return 'Read-only — only the author and this constellation\'s controllers can edit this page';
          case 'not-listed':       return 'Read-only — only the author and the people they listed can edit this page';
          case 'anonymous':        return 'Read-only — sign in to edit';
          default:                 return 'Read-only — ' + (constellationName ? ('join ' + constellationName + ' to edit') : 'not a member');
        }
      },
    };
  });
