module('lively.morphic.tools.HtmlEmbedDialog').requires('lively.persistence.BuildSpec', 'lively.identity.PostCardUtils', 'lively.morphic.AdditionalMorphs').toRun(function() {

lively.BuildSpec("lively.morphic.tools.HtmlEmbedDialog", {
    _BorderRadius: 7,
    _Extent: lively.pt(380.0,155.0),
    _Fill: Color.rgb(251,86,213),
    className: "lively.morphic.Window",
    name: "HtmlEmbedDialog",
    sourceModule: "lively.morphic.tools.HtmlEmbedDialog",
    contentOffset: lively.pt(3.0,22.0),
    draggingEnabled: true,
    layout: {
        adjustForNewBounds: true
    },
    minExtent: lively.pt(380.0,155.0),
    submorphs: [{
        _BorderColor: Color.rgb(95,94,95),
        _BorderRadius: 4,
        _Extent: lively.pt(374.0,130.0),
        _Fill: Color.rgb(243,243,243),
        _Position: lively.pt(3.0,23.0),
        className: "lively.morphic.Box",
        doNotCopyProperties: [],
        doNotSerialize: [],
        layout: {
            adjustForNewBounds: true,
            resizeWidth: true
        },
        name: "HtmlEmbedPane",
        sourceModule: "lively.morphic.Core",
        submorphs: [{
            _Extent: lively.pt(300.0,16.0),
            _FontFamily: "Arial, sans-serif",
            _FontSize: 11,
            _Padding: lively.rect(4,3,0,0),
            _Position: lively.pt(10.0,8.0),
            _InputAllowed: false,
            allowInput: false,
            className: "lively.morphic.Text",
            droppingEnabled: false,
            fixedWidth: true,
            grabbingEnabled: false,
            name: "UrlLabel",
            sourceModule: "lively.morphic.TextCore",
            submorphs: [],
            textString: "Paste a link"
        },{
            _BorderColor: Color.rgb(203,203,203),
            _BorderRadius: 3.75,
            _BorderWidth: 1,
            _ClipMode: "hidden",
            _Extent: lively.pt(354.0,24.0),
            _Fill: Color.rgb(255,255,255),
            _FontFamily: "Helvetica",
            _Padding: lively.rect(4,4,0,0),
            _Position: lively.pt(10.0,30.0),
            allowInput: true,
            className: "lively.morphic.Text",
            doNotSerialize: ["charsTyped"],
            evalEnabled: false,
            fixedHeight: true,
            fixedWidth: true,
            isInputLine: true,
            layout: {
                resizeWidth: true
            },
            name: "UrlText",
            sourceModule: "lively.morphic.TextCore",
            submorphs: [],
            textString: ""
        },{
            _Extent: lively.pt(354.0,18.0),
            _FontFamily: "Arial, sans-serif",
            _FontSize: 11,
            _Padding: lively.rect(4,3,0,0),
            _Position: lively.pt(10.0,64.0),
            _InputAllowed: false,
            allowInput: false,
            className: "lively.morphic.Text",
            droppingEnabled: false,
            fixedWidth: true,
            grabbingEnabled: false,
            name: "StatusText",
            sourceModule: "lively.morphic.TextCore",
            submorphs: [],
            textColor: Color.rgb(153,153,153),
            textString: ""
        },{
            _BorderColor: Color.rgb(214,214,214),
            _BorderRadius: 5,
            _BorderWidth: 1,
            _Extent: lively.pt(80.0,24.0),
            _Position: lively.pt(204.0,90.0),
            className: "lively.morphic.Button",
            doNotCopyProperties: [],
            doNotSerialize: [],
            isPressed: false,
            label: "cancel",
            name: "CancelButton",
            sourceModule: "lively.morphic.Widgets",
            submorphs: [],
            toggle: false,
            value: false,
            connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, "fire", this.get("HtmlEmbedPane"), "onCancel", {});
        }
        },{
            _BorderColor: Color.rgb(150,214,150),
            _BorderRadius: 5.2,
            _BorderWidth: 1.184,
            _Extent: lively.pt(80.0,24.0),
            _Fill: Color.rgb(239,255,239),
            _Position: lively.pt(288.0,90.0),
            className: "lively.morphic.Button",
            doNotCopyProperties: [],
            doNotSerialize: [],
            isPressed: false,
            label: "embed",
            name: "EmbedButton",
            sourceModule: "lively.morphic.Widgets",
            submorphs: [],
            toggle: false,
            value: false,
            connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, "fire", this.get("HtmlEmbedPane"), "onEmbed", {});
        }
        }],
        onCancel: function onCancel() {
        this.owner.remove();
    },
        onRemove: function onRemove() {
        $world.htmlEmbedDialog && $world.htmlEmbedDialog.remove();
    },
        setStatus: function setStatus(text, isError) {
        var t = this.get('StatusText');
        t.textString = text || '';
        t.setTextColor(isError ? Color.rgb(204,51,51) : Color.rgb(153,153,153));
    },
        // Plain full-bleed iframe of the raw URL -- used whenever the link
        // isn't a known embeddable provider or the preview fetch itself
        // failed (see HTMLtool.md §5 step 5). Not a new attack surface:
        // HtmlWrapperMorph already allows arbitrary HTML/iframes via its
        // own "edit HTML" halo item on any existing instance.
        genericIframeHtml: function genericIframeHtml(url) {
        return '<iframe src="' + url.replace(/"/g, '&quot;') + '" style="width:100%;height:100%;border:0;" allowfullscreen></iframe>';
    },
        onEmbed: function onEmbed() {
        var urlRaw = this.get('UrlText').textString.trim();
        if (!urlRaw) { this.setStatus('Enter a URL', true); return; }
        var url;
        try {
            url = new URL(urlRaw).toString();
        } catch (e) {
            this.setStatus('Not a valid URL', true);
            return;
        }
        if (!/^https?:\/\//i.test(url)) {
            this.setStatus('URL must start with http:// or https://', true);
            return;
        }

        var self = this;
        this.get('EmbedButton').disable && this.get('EmbedButton').disable();
        this.get('CancelButton').disable && this.get('CancelButton').disable();
        this.setStatus('Fetching preview…');

        lively.identity.postCardUtils.fetchLinkPreview(url, function(err, body) {
            var cardHtml = null;
            if (!err && body && !body.error) {
                try {
                    cardHtml = lively.identity.postCardUtils.buildLinkPreviewCard(body).outerHTML;
                } catch (e) {}
            }

            // The generic iframe fallback has no intrinsic content height to
            // measure -- its own CSS (height:100%) depends circularly on
            // whatever height the box is given, so it keeps a fixed,
            // resizable-by-hand default. A real card/embed DOES have a
            // natural height (aspect-ratio video, fixed-height audio, a
            // flex card wrapping its text), so for that case start at a
            // throwaway height and resize down to the real measured content
            // height once attached, rather than guessing a fixed one --
            // guessing left a dead strip below shorter embeds (e.g. a 16:9
            // video is ~270px tall, not the guessed 300px).
            var morph = new lively.morphic.HtmlWrapperMorph(cardHtml ? lively.pt(480, 10) : lively.pt(500, 375));
            morph.name = 'HTML Embed';
            morph.applyStyle({fill: Color.white, clipMode: 'auto', borderWidth: 0});
            morph.setHTML(cardHtml || self.genericIframeHtml(url));

            self.owner.remove();
            var hand = lively.morphic.World.current().firstHand();
            hand.grabMorph(morph);

            if (cardHtml) {
                // Safe to measure synchronously here (unlike Lively's own
                // Text-morph rendering): this is a plain innerHTML set on a
                // DOM node that's now genuinely attached (grabMorph just
                // parented it under the hand, which is already in the
                // world), so the browser has already laid it out. scrollHeight
                // ignores the placeholder 10px clipMode:auto box and reports
                // the real content height.
                var node = morph.renderContext().shapeNode;
                var measuredH = Math.ceil(node.scrollHeight || node.getBoundingClientRect().height || 120);
                morph.setExtent(lively.pt(480, Math.max(60, measuredH)));
            }
        });
    }
    }],
    titleBar: "Embed a Link",
    connectionRebuilder: function connectionRebuilder() {
    lively.bindings.connect(this, "remove", this.get("HtmlEmbedPane"), "onRemove", {});
}
});

}) // end of module
