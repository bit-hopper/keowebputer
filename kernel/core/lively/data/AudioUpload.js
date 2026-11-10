module('lively.data.AudioUpload').requires('lively.data.FileUpload').toRun(function() {

// Factored out like buildVideoNode, so lively.data.EncryptedMedia's EncryptedAudio rebuilds the same player on a fresh drop and on a
// restored world.
Object.extend(lively.data.FileUpload, {
    buildAudioNode: function (url) {
        var audioNode = XHTMLNS.create('audio');
        audioNode.controls = true;
        audioNode.preload = 'metadata';
        audioNode.style.cssText = 'width:100%;height:100%';
        audioNode.src = url;
        return audioNode;
    },
});

lively.data.FileUpload.Handler.subclass('lively.Clipboard.AudioUploader', {

    handles: function(file) {
        return file.type.match(/audio.*/);
    },

    getUploadSpec: function(evt, file) {
        if (this.isIdentityUploadAvailable()) return {readMethod: "manual"};
        return {readMethod: "asBinary"};
    },
    readManually: function(file) {
        var self = this;
        // MIDI plays in a piano that is a parts-bin item of a host; with no host there is none, so say so now instead of keeping a
        // file nothing can show and then failing without a word.
        if (/midi/i.test(file.type) && self.isLocalUploadAvailable()) {
            $world.inform("MIDI files cannot be played here yet.\n" + file.name + " was not added.");
            return;
        }
        self.identityUpload(file, function(err, url) {
            if (err) { $world.inform("Error uploading audio file:\n" + err); return; }
            // Sound that is not MIDI plays in a player of its own (the MIDI route below wants the bytes themselves).
            if (!/midi/i.test(file.type)) { self.openAudioPlayer(url, file.type, self.pos); return; }
            self.openAudio(url, file.type, null, self.pos);
        });
    },
    // ref: {handle, objId}, like openVideo
    openAudioPlayer: function(ref, mime, pos) {
        var morph = new lively.data.FileUpload.EncryptedAudio(ref, mime);
        morph.openInWorld(pos);
        morph._rebuildContent();
        return morph;
    },
    onLoad: function(evt) {
        if (this.readMethod === 'asBinary')
            this.uploadAndOpenAudioTo(
                URL.source.withFilename(this.file.name),
                this.file.type, evt.target.result, this.pos);
        else
            this.openAudio(this.file.name, this.file.type, evt.target.result, this.pos);
    },

    openAudio: function(url, mime, data, pos) {
        switch (mime) {
            case 'audio/midi':
                this.openMidi(url, data, pos);
                break;
            default:
                alert("unknown type " + mime);
        }
    },

    uploadAndOpenAudioTo: function(url, mime, binaryData, pos) {
        var onloadDo = function(status) {
            if (!status.isDone()) return;
            if (status.isSuccess()) this.openAudio(url, mime, binaryData, pos)
            else alert('Failure uploading ' + url + ': ' + status);
        }.bind(this)
        var webR = this.uploadBinary(url, mime, binaryData, onloadDo);
    },

    openMidi: function(url, data, pos) {
        var player = $morph('PianoKeyboard');
        if (!player) {
            player = $world.openPartItem('PianoKeyboard', 'PartsBin/Fun');
            if (pos) player.setPosition(pos);
        }
        player.loadMidi(data);
    }
});

}) // end of module