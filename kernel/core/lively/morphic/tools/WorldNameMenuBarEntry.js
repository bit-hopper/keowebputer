module('lively.morphic.tools.WorldNameMenuBarEntry').requires("lively.morphic.tools.MenuBar").toRun(function() {

lively.BuildSpec('lively.morphic.tools.WorldNameMenuBarEntry', lively.BuildSpec("lively.morphic.tools.MenuBarEntry").customize({

  name: "WorldNameMenuBarEntry",
  menuBarAlign: "right",

  style: lively.lang.obj.merge(lively.BuildSpec("lively.morphic.tools.MenuBarEntry").attributeStore.style, {
    extent: lively.pt(160,20),
    toolTip: "Current world name. Click to rename."
  }),

  // Worlds loaded from /@handle/objId identity URLs default $world.name to the
  // literal string "world" (see SignedSerializer.js) — the real title lives in
  // envelope.state.name, which the server bakes into document.title when it
  // renders the page. So document.title, not $world.name, is the source of truth.
  currentWorldDisplayName: function currentWorldDisplayName() {
    var generic = {"": true, "world": true, "Lively": true, "untitled world": true};
    var title = document.title;
    if (title && !generic[title]) return title;
    if ($world.name && !generic[$world.name]) return $world.name;
    return "untitled world";
  },

  onMouseUp: function onMouseUp(evt) {
    this.renamePrompt();
    evt.stop();
    return true;
  },

  renamePrompt: function renamePrompt() {
    var self = this;
    $world.prompt("Rename this world:", function(input) {
      input = input && input.trim();
      if (!input || input === self.currentWorldDisplayName()) return;
      self.renameAndSave(input);
    }, this.currentWorldDisplayName());
  },

  // Renames locally right away for instant feedback, then persists the new
  // name to the identity server as a real save (envelope.state.name) so it
  // survives reload — a rename that only lives in this tab isn't a rename.
  renameAndSave: function renameAndSave(newName) {
    var self = this;
    $world.setName(newName);
    document.title = newName;
    self.update();

    if (!lively.identity || !lively.identity.did || !lively.identity.did.isLoggedIn()) return;

    lively.require('lively.identity.SignedSerializer').toRun(function() {
      var parsed = lively.identity.webKey.parseObjectUrl(window.location.href);
      if (!parsed || !parsed.objId) return; // not yet saved to an identity URL

      var user = lively.identity.did.currentUser();
      var handle = parsed.handle, objId = parsed.objId;

      fetch('/@' + handle + '/' + objId, {
        credentials: 'include',
        headers: {'Accept': 'application/json'}
      })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(prevEnvelope) {
        var ss = lively.identity.signedSerializer;
        var method = lively.identity.did.findMethodByCredentialId(user.document, user.credentialId);
        ss.serializeToEnvelope({
          obj: $world,
          type: 'world',
          objId: objId,
          publicKeyJwk: method ? method.publicKeyJwk : null,
          prevEnvelope: prevEnvelope && prevEnvelope.record ? prevEnvelope : null,
          stateMeta: {name: newName}
        }, function(err, envelope) {
          if (err) { $world.alert('Rename failed: ' + err.message); return; }
          fetch('/@' + handle + '/' + objId, {
            method: 'PUT',
            credentials: 'include',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(envelope)
          })
          .then(function(r) { return r.json(); })
          .then(function(body) {
            if (!body.ok) $world.alert('Rename failed: ' + (body.error || '?'));
          })
          .catch(function(e) { $world.alert('Rename failed: ' + e.message); });
        });
      })
      .catch(function(e) { $world.alert('Rename failed: ' + e.message); });
    });
  },

  update: function update() {
    this.updateText(this.currentWorldDisplayName());
  },

  onLoad: function onLoad() {
    this.update();
    this.startStepping(30*1000, "update");
  },

  onFromBuildSpecCreated: function onFromBuildSpecCreated() {
    this.onLoad();
  }

}));

Object.extend(lively.morphic.tools.WorldNameMenuBarEntry, {

  getMenuBarEntries: function() {
    return [
      lively.BuildSpec('lively.morphic.tools.WorldNameMenuBarEntry').createMorph()]
  }
});

}) // end of module
