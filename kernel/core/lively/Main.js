/*
 * Copyright (c) 2006-2009 Sun Microsystems, Inc.
 * Copyright (c) 2008-2011 Hasso Plattner Institute
 *
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.

 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

module('lively.Main').requires("lively.persistence.Serializer").toRun(function() {

// The WorldDataAccessor reads data in some form (e.g. JSON) from some source
// e.g. meta nodes in a DOM and creates and initializes lively.morphic.Worlds
// from it
Object.subclass('lively.Main.WorldDataAccessor',
'initializing', {
    initialize: function(doc) {
        this.doc = doc;
    },
    modulesBeforeDeserialization: function() { return Config.modulesBeforeDeserialization || [] }

},
'accessing and creation', {
    modulesBeforeWorldLoad: function() { return Config.modulesBeforeWorldLoad || [] },
    modulesOnWorldLoad: function() { return Config.modulesOnWorldLoad || [] },
    getDoc: function() { return this.doc },
    getWorld: function() {  throw new Error('Subclass responsibility') }
});

Object.extend(lively.Main.WorldDataAccessor, {

    fromScratch: function(doc) {
        return new lively.Main.WorldBuilder(doc);
    },

    forDoc: function(doc) {
        return doc.xmlVersion ? this.forXMLDoc(doc) : this.forHTMLDoc(doc);
    },

    forXMLDoc: function(doc) {
        // currently we only support JSON embedded in XHTML meta nodes
        var jsonNode = doc.getElementById(lively.persistence.Serializer.jsonWorldId),
            json = jsonNode.textContent == "" ? jsonNode.content : jsonNode.textContent;
        return new lively.Main.JSONMorphicData(doc, jsonNode && json);
    },

    forHTMLDoc: function(doc) {
        // get the first script tag with the x-lively-world type
        var json = lively.$(doc).find('script[type="text/x-lively-world"]').text();
        if (json.startsWith("<![CDATA")) {
            console.log("MIGRATE: remove sourrounding CDATA in json string")
            json = json.replace(/\<\!\[CDATA\[(.*)\]\]\>$/g,"$1")
        }
        return new lively.Main.JSONMorphicData(doc, json);
    }
});

lively.Main.WorldDataAccessor.subclass('lively.Main.JSONMorphicData',
'initializing', {
    initialize: function($super, doc, json) {
        $super(doc);
        this.jso = LivelyMigrationSupport.applyWorldJsoTransforms(
            lively.persistence.Serializer.parseJSON(json));
    }
},
'accessing and creation', {
    getWorld: function() {
        if (this.world) return this.world;
        this.world = lively.morphic.World.createFromJSOOn(this.jso, this.getDoc());
        // A saved world's own _Extent reflects whatever the browser window
        // happened to be sized to when it was last saved -- createFromJSOOn
        // deserializes that stale extent verbatim, and nothing downstream
        // ever resizes it to the CURRENT viewport: World#onWindowResize
        // (wired to window.onresize in Events.js) only forwards to
        // submorphs' own onWorldResize and invalidates the cached
        // windowBounds, it never calls setExtent/setBounds on the World
        // itself. Confirmed live (2026-08-26): a world saved at 1804x1004
        // rendered at exactly that stale size in a 1923x1067 viewport,
        // leaving a dead gray margin along the right/bottom instead of
        // filling it -- reproduced via GET /@:handle/:objId, IdentityServer.js's
        // saved-world route, which boots through this exact path (no
        // manuallyCreateWorld). windowBounds() is already the correct
        // "fit the current viewport" calculation -- it's what the
        // fromScratch/manuallyCreateWorld boot path (WorldBuilder#getWorld
        // below, via World.createOn) already applies via setBounds; just
        // apply it here too so a saved world's stale extent doesn't stick.
        this.world.setBounds(this.world.windowBounds());
        // This first pass can undershoot by a scrollbar's width on each
        // axis: if the world's PREVIOUS saved extent was larger than the
        // current viewport, it overflows for the brief instant between
        // attachment and the line above, which makes the browser show a
        // real scrollbar and shrinks document.documentElement.clientWidth/
        // clientHeight (what windowBounds() reads) by that scrollbar's
        // width. Confirmed live (2026-08-26): reloading after shrinking the
        // browser window consistently left the world ~15px short on both
        // axes -- exactly a scrollbar's width -- while a load with no prior
        // oversized extent (nothing to overflow) matched the viewport
        // exactly. Once the line above shrinks the world to fit, the
        // overflow (and scrollbar) is gone, so a second measurement is
        // accurate. No timer/delay is needed -- reading clientWidth/
        // clientHeight forces a synchronous layout flush -- just an
        // explicit cache-bust: setExtent's own onWindowResize clears
        // cachedWindowBounds too, but only after a 10ms debounce, too slow
        // to rely on synchronously here.
        this.world.cachedWindowBounds = null;
        this.world.setBounds(this.world.windowBounds());
        this.world.recordViewportFit();
        return this.world;
    },

    modulesBeforeDeserialization: function($super) {
        var modulesInJson = this.jso ? lively.persistence.Serializer.sourceModulesIn(this.jso) : [];
        console.log('Found modules required for loading because '
                   + 'serialized objects require them: '
                   + modulesInJson);
        return $super().concat(modulesInJson).concat(['lively.morphic.Complete']).uniq();
    }

});

lively.Main.WorldDataAccessor.subclass('lively.Main.WorldBuilder',
'accessing and creation', {
    getWorld: function() {
        if (this.world) return this.world;
        var d = this.getDoc(),
            bounds = lively.morphic.World.prototype.windowBounds(d);
        this.world = lively.morphic.World.createOn(d.body, bounds);
        this.world.recordViewportFit();
        return this.world;
    }
});

// The loader defines what should happen after the bootstrap phase to get a
// lively.morphic.World running
Object.subclass('lively.Main.Loader',
'properties', {
    connections: ['finishLoading']
},
'accessing', {
    getDoc: function() { return this.doc },
    getWorldData: function() {
        if (!this.worldData) {
            this.worldData = lively.Main.WorldDataAccessor[
                    Config.get("manuallyCreateWorld") ?
                        'fromScratch' : 'forDoc'](this.getDoc());
        }
        return this.worldData;
    }
},
'preparation', {

    browserSpecificFixes: function() {
        if (Global.navigator.appName == 'Opera') window.onresize();
        // FIXME rk 2012-12-17: this should use our new CSS support!
        var id = 'lively-base-style',
            existing = document.getElementById(id);
        if (existing) existing.parentNode.removeChild(existing);
        var cssDef = "";
        // 1. Don't DOM-select arbitrary elements on mouse move
        // none is different to -moz-none:
        // none has the same meaning as in display rule, none of the
        // sub-elements can overwrite it whereas -moz-none allows
        // child elements to overwrite -moz-user-select
        cssDef += ""
                + "*:not(:focus) {\n"
                + "  -moz-user-select: -moz-none;\n"
                + "  -webkit-user-select: none;\n"
                + "  -ms-user-select: none;\n"
                + "  user-select: none;\n"
                + "}\n"
                + ".selectable, .selectable *, .visibleSelection:focus * {\n"
                + "  -moz-user-select: element;\n"
                + "  -webkit-user-select: auto;\n"
                + "  -ms-user-select: auto;\n"
                + "  user-select: auto;\n"
                + "}\n"
                + ".morphNode {\n"
                + "	-webkit-transform-origin: 0 0;\n"
                + "}\n"
                + ".Morph {\n"
                + "/* to fix z-index / z-transform bug: https://code.google.com/p/chromium/issues/detail?id=205744 */\n"
                + "	-webkit-transform: translate(0,0);\n"
                + "}\n"
                + ".World {\n"
                + "/* World does not set transform to allow fixed positioning */\n"
                + "    -webkit-transform: none;\n"
                + "}\n";
        // 2. selection style of morphs/texts/lists etc.
        // suppress focus highlight for most elements
        // only texts, lists, etc should show the real focus

        if (UserAgent.webKitVersion) {
            cssDef += ':focus:not(input) { outline:none; }\n'
                    + '.visibleSelection:focus { outline: 2px auto -webkit-focus-ring-color; }\n';
        }

        if (UserAgent.fireFoxVersion) {
            cssDef += ':focus {\n'
                    + '  outline:none;\n'
                    + '}\n'
                    + '.visibleSelection:focus {\n'
                    + "  -moz-box-shadow: 0 0px 3px blue;\n"
                    + "  box-shadow:0 0px 3px blue;\n"
                    + "}\n"
        }

        XHTMLNS.addCSSDef(cssDef, id);

        // disable spellchecking to avoid ugly red lines in texts
        document.body.spellcheck = false;
    }

},
'loading', {

    systemStart: function(doc) {
        console.group("World loading");
        this.doc = doc;
        this.loadWorld(doc);
    },

    loadWorld: function() {
        var self = this, worldData = this.getWorldData();
        require(worldData.modulesBeforeDeserialization()).toRun(function() {
            require(worldData.modulesBeforeWorldLoad()).toRun(function() {
                require(worldData.modulesOnWorldLoad()).toRun(function() {
                    self.onFinishLoading(worldData.getWorld());
                });
            });
        });
    },

    onFinishLoading: function(world) {
        console.groupEnd("World loading");
        world.hideHostMouseCursor();
        if (lively.Config.get("showMenuBar")) lively.require("lively.morphic.tools.MenuBar").toRun(function() {
          (function() { lively.morphic.tools.MenuBar.openOnWorldLoad(); }).delay(0);
        })
        world.loadingMorph = new lively.morphic.LoadingMorph(rect(0,0,300,200));
        this.browserSpecificFixes()
        lively.bindings.signal(this, 'finishLoading', world);
        lively.bindings.signal(world, 'finishLoading', world);
        // notify libraries loaded *very* early
        if (Config.finishLoadingCallbacks) {
            Config.finishLoadingCallbacks.forEach(function(cb){
                cb(world);
            });
        }
        lively.whenLoaded = function(cb) { cb(world) };
        console.log("The world is now completely loaded.");
    }

});


Object.extend(lively.Main, {
    getLoader: function(doc) { return new lively.Main.Loader(); }
});

}); // end of module
