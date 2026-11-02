module('lively.data.VideoUpload').requires('lively.data.FileUpload').toRun(function() {

// Factored out so lively.data.EncryptedMedia's EncryptedVideo can rebuild
// the identical DOM tree (given a resolved blob: URL) both on fresh upload
// and on world restore, without duplicating the node-construction logic.
Object.extend(lively.data.FileUpload, {
    buildVideoNode: function (url, mime) {
        mime = mime || '';
        var videoNode = XHTMLNS.create('video');
        videoNode.width = 400;
        videoNode.height = 300;
        videoNode.controls = true;
        videoNode.preload = true;
        var sourceNode = XHTMLNS.create('source');
        sourceNode.src = url;
        videoNode.appendChild(sourceNode);
        return videoNode;
    },
});

lively.data.FileUpload.Handler.subclass('lively.Clipboard.VideoUploader', {
    handles: function(file) {
        return file.type.match(/video.*/);
    },
    getUploadSpec: function(evt, file) {
        if (this.isIdentityUploadAvailable()) return {readMethod: "manual"};
        return {readMethod: "asBinary"};
    },
    readManually: function(file) {
        var self = this;
        self.identityUpload(file, function(err, ref) {
            if (err) { $world.inform("Error uploading video file:\n" + err); return; }
            var morph = self.openVideo(ref, file.type, self.pos);
            self.attachIdentityDelete(morph, { handle: ref.handle, blobCid: ref.blobCid });
        });
    },
    onLoad: function(evt) {
        this.uploadAndOpenVideoTo(
            URL.source.withFilename(this.file.name),
            this.file.type, evt.target.result, this.pos);
    },

    // url: a plain fetchable URL (legacy/non-identity uploads, or the
    // local-dev-server fallback), OR {handle, objId} for an identity
    // upload -- the latter renders as encrypted content via
    // lively.data.EncryptedMedia's EncryptedVideo instead of a plain
    // <video src> binding, since that binding can never decrypt private
    // content (confirmed live: it doesn't even work for the owner).
    openVideo: function(url, mime, pos) {
        // new lively.data.FileUpload.Handler().openVideo('http://lively-kernel.org/repository/webwerkstatt/documentation/videoTutorials/110419_ManipulateMorphs.mov', 'video/mp4')
        module('lively.morphic.video.Video').load();

        if (url && typeof url === 'object') {
            var encMorph = new lively.data.FileUpload.EncryptedVideo(url, mime);
            encMorph.openInWorld(pos);
            encMorph._rebuildContent();
            return encMorph;
        }

        var videoNode = lively.data.FileUpload.buildVideoNode(url, mime);
        var morph = new lively.morphic.Morph(new lively.morphic.Shapes.External(videoNode));
        morph.applyStyle({borderWidth: 1, borderColor: Color.black,
            extent: pt(videoNode.width || 640, videoNode.height || 360)});
        morph.openInWorld(pos);
        return morph;
    },
    uploadAndOpenVideoTo: function(url, mime, binaryData, pos) {
        var onloadDo = function(status) {
            if (!status.isDone()) return;
            if (status.isSuccess()) this.openVideo(url, mime, pos)
            else alert('Failure uploading ' + url + ': ' + status);
        }.bind(this)
        var webR = this.uploadBinary(url, mime, binaryData, onloadDo);
    },
});

}) // end of module