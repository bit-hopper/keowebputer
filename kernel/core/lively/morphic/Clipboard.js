module('lively.morphic.Clipboard').requires("lively.data.FileUpload").toRun(function() {

// Copy'n Paste and Drag'n Drop support. HTML5 offers some options for content
// import. Note that the event handler functions for morphs are defined in
// lively.morphic.Events. This module implements the deeper HTML/Event handling
// that is independent of Morphic

Object.extend(lively.morphic.Clipboard, {
    handleKeyCopy: function(copyString, evt, data, thenDo) {
        try {
            var header = 'LIVELYKERNELCLIPBOARDDATA|' + copyString.length + '|';
            data.setData("Text", header + copyString);
            thenDo(null);
        } catch(e) { thenDo(e); }
    },

    handleKeyPaste: function(evt, data, withExtractedMorphsDo) {
        try {
            if (Array.from(data.types).any(function(type) { return type.toLowerCase() === 'files'; })) {
                evt.getPosition = function() { return $world.firstHand().getPosition(); };
                // data.items can include non-file entries (e.g. a text/html
                // placeholder pasted alongside an image). getAsFile() returns
                // null for those, so filter to file items before invoking it.
                var items = Array.from(data.items).filter(function(item) { return item.kind === 'file'; });
                var files = items.invoke('getAsFile').compact();
                if (files.length) lively.data.FileUpload.handleDroppedFiles(files, evt);
                return;
            }
            var text = data.getData('Text');
            if (!text) return;
            var match = text.match(/LIVELYKERNELCLIPBOARDDATA\|([0-9]+)\|(.+)/i);
            if (!match || !match[2]) return;
            var obj = lively.morphic.Morph.deserialize(match[2]);
            if (!obj || !obj.isMorph) return;
            withExtractedMorphsDo(null, [obj]);
        } catch(e) { withExtractedMorphsDo(e, null); }
    },

    handleItemOrFileImport: function(evt) {
        lively.data.FileUpload.handleImportEvent(evt);
    }
});

}) // end of module
