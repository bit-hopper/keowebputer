module('lively.data.TextUpload').requires('lively.data.FileUpload').toRun(function() {

lively.data.FileUpload.Handler.subclass('lively.Clipboard.TextUploader', {

    handles: function(file) {
        // a document keo shows in a box of its own (markdown, text, web page) is left to lively.data.DocumentUpload
        var docs = lively.data.DocumentUpload && lively.data.DocumentUpload.Handler;
        if (docs && docs.prototype.handles(file)) return false;
        return file.type.match(/text.*/);
    },

    getUploadSpec: function(evt, file) {
        return {readMethod: "asText"}
    },

    onLoad: function(evt) {
        lively.morphic.World.current().addTextWindow({
            title: this.file.name,
            content: evt.target.result});
    }
});

}) // end of module