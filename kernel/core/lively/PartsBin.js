module('lively.PartsBin').requires('lively.Traits', 'lively.store.Interface', 'lively.persistence.Serializer').toRun(function() {

Object.subclass('lively.PartsBin.PartItem',
'initializing', {
    initialize: function($super, partOrName, partsSpaceName) {
        this.partsSpaceName = Global.decodeURI(partsSpaceName);
        if (Object.isString(partOrName)) {
            this.name =  Global.decodeURI(partOrName);
            this.part = null;
        } else {
            this.name = Object.isFunction(partOrName.getPartsBinMetaInfo) ?
                this.name = Global.decodeURI(partOrName.getPartsBinMetaInfo().partName) :
                this.name =  Global.decodeURI(partOrName.name);
            this.part = partOrName;
        }
        this.json = null;
    }
},
'accessing', {
    getLogoURL: function() {
        return this.getPartsSpace().getURL().withFilename(this.escapedName() + ".svg")
    },
    getHTMLLogoURL: function() {
        return this.getPartsSpace().getURL().withFilename(this.escapedName() + ".html")
    },

    getFileURL: function() {
        return this.getPartsSpace().getURL().withFilename(this.name + ".json")

        /* from astrid */
        var partName;
        // the fileURL is computed with the partName stored in the PartsBinMetaInfo, if possible
        if (this.part && this.part.getPartsBinMetaInfo()) {
            partName = this.part.getPartsBinMetaInfo().partName
        }
        else {
            partName = this.name;
        }
        return this.getPartsSpace().getURL().withFilename(this.escapePartName(partName) + ".json")
    },
    getMetaInfoURL: function() {
        return this.getPartsSpace().getURL().withFilename(this.escapedName() + ".metainfo")
    },

    getPartsSpace: function() {
        return lively.PartsBin.partsSpaceNamed(this.partsSpaceName);
    },

    // Trust classification for the untrusted-code-execution gate below.
    // Default covers the classic WebDAV path, which carries no per-part
    // signature/authorship at all (writes are gated by session now -- see
    // CLAUDE.md's webdav-auth-gate section -- but there's still no real
    // provenance for an individual part, and any authenticated user can
    // currently write to a classic PartsBin path, not just an admin -- so a
    // path/name allowlist for "framework tools" would be trusting content
    // that could have been silently replaced). lively.identity.IdentityPartItem
    // overrides this with real DID-signature-based classification.
    //
    // json is optional -- when provided (setPartFromJSON always has it in
    // hand), this hashes the exact content and checks it against the local
    // content-trust list (see ItemTrust.trustContent), so a specific known
    // part's exact bytes can be trusted without trusting the path/name it
    // happens to live at; a later tamper changes the hash and the gate
    // reappears automatically. When omitted (PartsBinItem>>onMouseDown's
    // synchronous pre-warm, which doesn't have the JSON fetched yet for a
    // classic part), resolves immediately to the base unsigned tier with no
    // hash -- drag-to-load stays gated for classic parts regardless of
    // content-trust status; content-trust only fast-paths the explicit
    // Open/Load button flow, not drag.
    // Always calls cb({tier, did, contentHash}) -- async-shaped for a
    // uniform call convention even though the no-json path is immediate.
    getTrustInfo: function(json, cb) {
        var self = this;
        if (!json) { cb({tier: 'unsigned', did: null, contentHash: null}); return; }
        if (this._trustInfo && this._trustInfo._forJson === json) { cb(this._trustInfo); return; }

        lively.require('lively.identity.Crypto', 'lively.identity.ItemTrust').toRun(function() {
            lively.identity.crypto.sha256(json, function(err, hash) {
                var trusted = !err && hash && lively.identity.ItemTrust.isContentTrusted(hash);
                self._trustInfo = {
                    tier: trusted ? 'content-trusted' : 'unsigned',
                    did: null,
                    contentHash: err ? null : hash,
                    _forJson: json
                };
                cb(self._trustInfo);
            });
        });
    },

    // Synchronous peek at whatever getTrustInfo last resolved to (or null if
    // it hasn't been called yet) -- used by PartsBinItem>>onDragStart, which
    // has to decide synchronously whether to allow a drag-triggered load,
    // unlike the button/confirm path which can just wait on the callback.
    getCachedTrustInfo: function() {
        return this._trustInfo || null;
    },

    // Optional trailing cb(err, part) -- setPartFromJSON's completion is no
    // longer reliably synchronous-or-connection-driven now that it can wait
    // on the trust-gate confirm dialog below, so any caller that needs to
    // know when (or whether) the part actually landed should pass one
    // rather than assuming this.part is set by the time the call returns.
    // (The base PartsBinItem>>startLoadingPart caller doesn't need this --
    // it already reacts to the 'part' property connection, which fires
    // correctly no matter how long this takes.)
    setPartFromJSON: function(json, metaInfo, rev, cb) {
        // Parts loaded at runtime (e.g. dragged out of PartsBin) aren't
        // covered by the module auto-loading that world-boot does via
        // Main.js's modulesBeforeDeserialization -- without this, a part
        // whose class lives in a module the current page hasn't already
        // loaded fails deserialization with "class cannot be found", even
        // though __SourceModuleName__ correctly names the owning module.
        var self = this,
            modules = lively.persistence.Serializer.sourceModulesIn(json);

        // Loading a part means eval'ing its embedded addScript/BuildSpec
        // source directly in this page's own JS context -- full privileges,
        // no sandbox (see CLAUDE.md's PartsBin source-inspection/trust-gate
        // notes). Gate everything except a part the signed-in user
        // themselves authored, one from an author already on the local
        // trust list, or a classic part whose exact content hash is already
        // locally content-trusted, behind an explicit confirmation.
        this.getTrustInfo(json, function(trust) {
            if (trust.tier === 'own' || trust.tier === 'signed-allowlisted' || trust.tier === 'content-trusted') {
                self._doSetPartFromJSON(json, metaInfo, rev, modules, cb);
                return;
            }
            lively.require('lively.identity.ItemTrust').toRun(function() {
                lively.identity.ItemTrustGate.confirm(self, trust, json, function(proceed, alwaysTrust) {
                    if (!proceed) { if (cb) cb(new Error('Load cancelled: untrusted part')); return; }
                    if (alwaysTrust && trust.did) lively.identity.ItemTrust.trust(trust.did);
                    else if (alwaysTrust && trust.contentHash) lively.identity.ItemTrust.trustContent(trust.contentHash);
                    self._doSetPartFromJSON(json, metaInfo, rev, modules, cb);
                });
            });
        });
    },

    _doSetPartFromJSON: function(json, metaInfo, rev, modules, cb) {
        var self = this;
        lively.require(modules).toRun(function() {
            var part = self.deserializePart(json, metaInfo);
            part.partsBinMetaInfo.revisionOnLoad = rev;
            part.partsBinMetaInfo.lastModifiedDate = metaInfo.lastModifiedDate;
            self.setPart(part);
            if (cb) cb(null, part);
        });
    },

    setPart: function(part) {
        this.part = part;
    },

    getMetaInfo: function() {
        // metaInfo of part is always taken before local meta info or parts item
        if (this.part)
            return this.part.getPartsBinMetaInfo();
        if (this.loadedMetaInfo)
            return this.loadedMetaInfo;
        return this.loadPart().part.getPartsBinMetaInfo()
    },

    fetchLastModifiedDate: function() {
        // FIXME this should also consider the current rev of the part,
        // unfortunately it's hard to get it...
        return this.getFileURL().asWebResource().noProxy().head().lastModified;
    }

},
'testing', {
    hasLatestPartVersion: function() {
        if (!this.part) return false;
        var date = this.part.getPartsBinMetaInfo().getLastModifiedDate();
        if (!date) return false;
        return date.valueOf() === this.fetchLastModifiedDate().valueOf();
    }
},
'naming', {
    makeUpPartName: function() {
        if ($morph(this.targetName)) {
            var i = 2
            while($morph(this.targetName + i)) { i++ }
            return this.targetName + i;
        } else {
            return this.targetName;
        }
    },
    escapePartName: function(partName) {
        return encodeURI(partName);
    },
    escapedName: function() {
        return this.escapePartName(this.name);
    }

},
'serialization', {
    getSerializer: function() {
        return ObjectGraphLinearizer.forNewLivelyCopy();
    },
    deserializePart: function(json, optMetaInfo) {
        var part = lively.morphic.Morph.deserialize(json, {
            metainfo: optMetaInfo
        });
        var metaInfo = part.getPartsBinMetaInfo();
        metaInfo.setPartsSpace(this.getPartsSpace());
        if (this.lastModifiedDate) metaInfo.lastModifiedDate = this.lastModifiedDate;
        part.withAllSubmorphsDo(function(ea) { ea.setNewId(); });
        part.setPartsBinMetaInfo(metaInfo);
        this.runAfterDeserializationHooks(part);
        return part;
    },
    runAfterDeserializationHooks: function(part) {
        if (part.findAndSetUniqueName)
            part.findAndSetUniqueName();

        if (part.onLoadFromPartsBin)
            part.onLoadFromPartsBin();
    },

    serializePart: function(part) {
        var json, htmlLogo, oldPos = part.getPosition();
        part.setPosition(pt(0,0));

        // so that we dont have to remove the part (this could trigger side effects)
        var ignoreOwnerPlugin = new GenericFilter();
        ignoreOwnerPlugin.addFilter(function(obj, propName) {
            return obj === part && propName === 'owner';
        });

        // filter for some craft in the PartsBinMetaInfo that is also present in the .metainfo file
        var ignoreMetaInfoPlugin = new GenericFilter();
        ignoreMetaInfoPlugin.addFilter(function(obj, propName) {
            return (obj instanceof lively.PartsBin.PartsBinMetaInfo) && (propName == 'changes');
        });

        var serializer = this.getSerializer();
        serializer.addPlugin(ignoreOwnerPlugin);
        serializer.addPlugin(ignoreMetaInfoPlugin);

        var bounds = part.getBounds(),
            scale = 85 / Math.max(bounds.width, bounds.height) * part.getScale();
        try {
            json = serializer.serialize(part);
            htmlLogo = part.asHTMLLogo({scale: scale});
        } catch(e){
            throw e;
        } finally {
            part.setPosition(oldPos);
            // for fixing the bug that parts are shown in the world
            // origin after copying them to the partsbin
            if (part.owner) part.owner.addMorph(part);

            // remove metainfo filter from (global) serializer
            serializer.plugins.remove(ignoreMetaInfoPlugin);
        }
        return {
            json: json,
            htmlLogo: htmlLogo,
            metaInfo: this.serializeMetaInfo(part.getPartsBinMetaInfo())
        };
    },

    serializeMetaInfo: function(metaInfo) {
        try {
            return this.getSerializer().serialize(metaInfo);
        } catch(e) {
            throw e;
        }
    }

},
'upload and download', {
    load: function (isAsync, rev) {

        if(!isAsync){
            var webR = new WebResource(this.getFileURL()).noProxy().forceUncached();
            if (isAsync) webR.beAsync();
            lively.bindings.connect(webR, 'content', this, 'json', {updater: function($upd, json) {
                if (!this.sourceObj.status.isSuccess()) { $upd(null); return; }
                if (!this.sourceObj.status.isDone()) { return; }
                this.targetObj.lastModifiedDate = this.sourceObj.lastModified;
                $upd(json);
            }});
            webR.get();
            return this;
        }

        var url = this.getFileURL(),
            root = this.guessRootForURL(url),
            path = url.relativePathFrom(root),
            self = this,
            query = !!rev || rev === 0 ? {
                    paths: [path],
                    attributes: ['content'],
                    version: rev,
                    limit: 1
                } : {
                    paths: [path],
                    attributes: ['content'],
                    newest: true,
                    limit: 1
                };

        new lively.store.ObjectRepository(root).getRecords(query, function(err, rows) {
            if (err) { show(err); self.json = null; return; }
            // IDENTITY: pre-existing bug — empty version history; don't set null
            // (firing the json connection with null can trigger downstream crashes).
            if (!rows || !rows[0]) { return; }
            self.json = rows[0].content;
        });
        return this;
    },

    loadPart: function(isAsync, optCached, rev, cb) {
        if (optCached) { this.setPartFromJSON(this.json); return this; }

        // a revisionOnLoad should always be set! If no PartsBinMetaInfo can
        // be found, the revisionOnLoad is computed via the webresource
        if (rev != null) {
            this.rev = rev;
        } else if (this.loadPartVersions && this.loadPartVersions().partVersions && this.loadPartVersions().partVersions.length > 0) {
            this.rev = this.loadPartVersions().partVersions.first().rev;
        } else {
            this.rev = new WebResource(this.getFileURL()).noProxy().getHeadRevision().headRevision;
        }

        // ensure that setPartFromJSON is only called when both json and
        // metaInfo are there.
        //
        // onceCb is called exactly once no matter which path reaches it --
        // either setPartFromJSON's own error callback (e.g. the user
        // declined the trust-gate confirm, which previously had no way to
        // reach this method's cb at all: setPartFromJSON's cb param was
        // never passed through here, so a decline silently never fired
        // 'part' and the caller's cb (and any LoadingIndicator waiting on
        // it) hung forever -- confirmed live via Inventory.js's Object
        // Graph button, see project-inventory-partinspector-objectgraph
        // memory) or the pre-existing 'part' property connection below on
        // success.
        var onceCb = cb ? Functions.once(cb) : Functions.Null;
        var loadTrigger = {
            item: this,
            rev: this.rev,
            triggerSetPart: function() {
                this.item.setPartFromJSON(this.json, this.metaInfo, this.rev, function(err) {
                    if (err) onceCb(err);
                });
            },
            jsonLoaded: function(json) {
                this.json = json;
                if (this.metaInfo === undefined) return;
                this.triggerSetPart();
            },
            metaInfoLoaded: function(metaInfo) {
                try {
                    this.metaInfo = metaInfo;
                    if (!this.json) return;
                    this.triggerSetPart();
                } catch(e) {
                    console.log('Error on setPartFromJSON: ' + e)
                }
            },
            triggerCallback: function(part) { onceCb(null, part); },
        }
        lively.bindings.connect(this, 'json', loadTrigger, 'jsonLoaded', {removeAfterUpdate: true});
        lively.bindings.connect(this, 'loadedMetaInfo', loadTrigger, 'metaInfoLoaded', {removeAfterUpdate: true});
        lively.bindings.connect(this, 'part', loadTrigger, 'triggerCallback', {removeAfterUpdate: true});
        this.load(isAsync, rev);
        this.loadPartMetaInfo(isAsync, rev);
        return this;
    },

    loadPartVersions: function (isAsync) {
        // FIXME, what if PartsBin is not at root?
        var url = this.getFileURL(),
            root = this.guessRootForURL(url),
            path = url.relativePathFrom(root),
            self = this;

        function processVersions(err, rows) {
            if (err) show(err);
            else self.partVersions = rows;
        }

        var result = new lively.store.ObjectRepository(root).getRecords({
                paths: [path],
                attributes: ['path', 'date', 'author', 'change', 'version']
            }, isAsync ? processVersions : null);
        if (!isAsync) processVersions(result.error ? result.error : null, result);

        return this;
    },

    guessRootForURL: function (url) {
        if (url.isIn(URL.root)) {
            return URL.root
        }
        if (url.pathname.match(/\/PartsBin\//)) { // we can make a smarkt guess? Or can't we? #JensLincke
            return url.withPath(url.pathname.replace(/PartsBin.*/, ""))
        }
        // this captures only the current url... but we migth be a general Approach finding the root
        // can we be sure that it contains the partsbin?
        // Future work, we might also have to replace these methods by a more specific versions 
        // for accessing the version history of dropbox, ondrive or other databases that may want to 
        // decide to put parts in... 
        return url.withPath("/") // fallback that works for simple localhost and lively-web etc..
    },

    loadPartMetaInfo: function (isAsync, rev) {
        if (!isAsync) {
            var webR = new WebResource(this.getMetaInfoURL())
              .beSync().noProxy().forceUncached().get();
            if (webR.status.isSuccess()) {
                var metaInfo = lively.persistence.Serializer.deserialize(webR.content);
                metaInfo.lastModifiedDate = webR.lastModified;
                this.loadedMetaInfo = metaInfo;
            }
            return this;
        }

        var url = this.getMetaInfoURL(),
            root = this.guessRootForURL(url),
            path = url.relativePathFrom(root),
            self = this,
            query = !!rev ? {
                paths: [path],
                attributes: ['content', 'date'],
                version: rev,
                limit: 1
            } : {
                paths: [path],
                attributes: ['content', 'date'],
                newest: true,
                limit: 1
            };

        new lively.store.ObjectRepository(root).getRecords(query, function(err, rows) {
            if (err) { show(err); self.loadedMetaInfo = null; return; }
            // IDENTITY: pre-existing bug — empty version history; don't set null
            // (firing loadedMetaInfo=null triggers setMetaInfoOfSelectedItem(null)
            // in the PartsBin browser, which crashes on null.changes).
            if (!rows || !rows[0]) { return; }
            var metaInfo = lively.persistence.Serializer.deserialize(rows[0].content)
            metaInfo.lastModifiedDate = new Date(rows[0].date);
            self.loadedMetaInfo = metaInfo;
        });
    },

    loadRevision: function(isAsync, rev) {
        return this.loadPart(isAsync, undefined, rev)
    },

    copyToPartsSpace: function(partsSpace) {
        var newItem = partsSpace.getPartItemNamed(this.name);
        partsSpace.setPartItem(newItem);
        newItem.copyFilesFrom(this);
        return newItem;
    },
    moveToPartsSpace: function(partsSpace) {
        var newItem = this.copyToPartsSpace(partsSpace);
        this.del();
        if (this.part) {
            this.part.getPartsBinMetaInfo().setPartsSpace(partsSpace);
        }
        return newItem;
    },

    del: function() {
        this.getPartsSpace().removePartItemNamed(this.name);
        new WebResource(this.getHTMLLogoURL()).noProxy().beAsync().del();
        new WebResource(this.getFileURL()).noProxy().beAsync().del();
        new WebResource(this.getMetaInfoURL()).noProxy().beAsync().del();
    },

    uploadPart: function(checkForOverwrite, isSync) {
        if (!this.part) {
            alert('Cannot upload item ' + this.name + ' because there is no item!')
            return;
        }

        var metaInfo = this.part.getPartsBinMetaInfo(),
            lastModified = metaInfo.getLastModifiedDate();

        // 1. serialize part
        metaInfo.setPartsSpace(this.getPartsSpace());
        var name = this.part.name,
            serialized = this.serializePart(this.part);

        // 2. start the upload... but first make sure the directory exists
        this.getFileURL().getDirectory().asWebResource().noProxy()
          [isSync ? 'beSync' : 'beAsync']().ensureExistance();
        var webR = this.getFileURL().asWebResource().noProxy()
          [isSync ? 'beSync' : 'beAsync']()
          .createProgressBar('Uploading ' + name);

        // 3. setup overwrite check
        var rev = this.part.getPartsBinMetaInfo().revisionOnLoad,
            putOptions = {};
        if (checkForOverwrite && (lastModified || rev)) {
            if (lastModified) putOptions.ifUnmodifiedSince = lastModified;
            else putOptions.requiredSVNRevision = rev;
        }

        // 4. hookup handler for doing stuff when upload has finished
        connect(webR, 'status', this, 'handleSaveStatus', {
            converter: function() { return this.sourceObj }});

        // 5. upload meta data and preview
        // FIXME put this into #handleSaveStatus?
        var partItem = this, uploadHelper = {
            uploadMetaDataAndPreview: function(putStatus) {
                if (!putStatus.isSuccess()) return;
                new WebResource(partItem.getHTMLLogoURL())[isSync ? 'beSync' : 'beAsync']().noProxy().put(serialized.htmlLogo);
                new WebResource(partItem.getMetaInfoURL())[isSync ? 'beSync' : 'beAsync']().noProxy().put(serialized.metaInfo);
            }
        }
        connect(webR, 'status', uploadHelper, 'uploadMetaDataAndPreview');

        // 6. Finally, initiate the upload
        webR.put(serialized.json, null, putOptions);
    },

    copyFilesFrom: function(otherItem) {
        new WebResource(otherItem.getFileURL()).noProxy().copyTo(this.getFileURL());
        new WebResource(otherItem.getHTMLLogoURL()).noProxy().copyTo(this.getHTMLLogoURL());
        new WebResource(otherItem.getMetaInfoURL()).noProxy().copyTo(this.getMetaInfoURL());
        alertOK('Copying from ' + otherItem + ' to ' + this + ' done');
    },

    uploadMetaInfoOnly: function(isAsync) {
        var metaInfo = this.getMetaInfo();
        if (!metaInfo) {
            alert('Cannot access metaInfo for uploading if item ' + this.name)
            return;
        }
        var json = this.serializeMetaInfo(metaInfo)
        var webR = new WebResource(this.getMetaInfoURL()).noProxy();
        if (isAsync) webR.beAsync()
        webR.statusMessage('Updated metaInfo of ' + this.name, 'Problem uploading metaInfo of ' + this.name).put(json);
    },

    isInPartsBin: function() {
        // if there is a PartsBin representation, this returns true. If a Part
        // was deleted from PartsBin, but an artifact of is published, this
        // returns false
        return new WebResource(this.getFileURL()).noProxy().exists();
    },

    handleSaveStatus: function(webR) {
        // handles the request for overwrite on header 412
        var status = webR.status,
            world = lively.morphic.World.current();
        if (!status.isDone()) return;
        if (status.code() === 412) {
            if (status.url.asWebResource().noProxy().exists()) {
                this.askToOverwrite(status.url);
            } else {
                alertOK("New item " + status.url + " is being stored.");
                this.uploadPart();
            }
            return;
        }
        if (status.isSuccess()) {
            var metaInfo = this.part.getPartsBinMetaInfo();
            world.alertOK("Successfully saved "+status.url+" in Inventory.")
            metaInfo.lastModifiedDate = webR.lastModified;
            this.updateRevisionOnLoad();
            if (world.publishPartDialog) {
                world.publishPartDialog.remove();
                delete world.publishPartDialog;
            }
        } else if (status.isForbidden()) {
            world.createStatusMessage('Saving to:\n' + status.url + '\nis not allowed!', {
                openAt: 'center', fill: Color.red, extent: pt(400, 75)
                // removeAfter: 5000, textStyle: { align: 'center' }
            });
        } else {
            var msg = 'Problem saving ' + status.url + ': ' + status;
            Config.verboseLogging ? alert(msg) : console.error(msg);
        }
    },
    updateRevisionOnLoad: function() {
        // the revisionOnLoad in PartsBinMetaInfo is updated on publishing.
        var webR = new WebResource(this.getFileURL()),
            rev = webR.noProxy().getHeadRevision().headRevision;
        this.part.getPartsBinMetaInfo && (this.part.getPartsBinMetaInfo().revisionOnLoad = rev);
    },

    askToOverwrite: function(url) {
        var self = this;
        $world.confirm(String(url) + ' was changed since loading it. Overwrite?',
            function (answer) {
                answer && self.uploadPart()
            })
    }
},
'converting', {
    asPartsBinItem: function() {
        return new lively.morphic.PartsBinItem(this.getPartsSpace().getURL(), this.name, this);
    }
},
'debugging', {
    toString: function() {
        return 'PartsItem(' + this.name + ',' + this.getPartsSpace() + ')';
    }
});
Object.subclass('lively.PartsBin.PartsBinMetaInfo',
'initializing', {
    initialize: function() {
        this.partName = '';
        this.requiredModules = [];
    }
},
'accessing', {

    setURL: function(url) {
        var name = lively.PartsBin.partsSpaceWithURL(url.getDirectory()).getName();
        this.setPartsSpaceName(name);
    },

    getName: function() { return this.partName },

    getPartsSpaceURL: function() { return this.getPartsSpace().getURL() },
    setPartsSpaceName: function(name) { this.partsSpaceName = name },
    getPartsSpaceName: function() { return this.partsSpaceName || 'PartsBin/' },
    setPartsSpace: function(partsSpace) { this.setPartsSpaceName(partsSpace.getName()) },
    getPartsSpace: function() { return lively.PartsBin.partsSpaceNamed(this.partsSpaceName) },
    getComment: function() { return this.comment },
    setComment: function(comment) { return this.comment = comment },
    getLastModifiedDate: function() { return this.lastModifiedDate; },

    addRequiredModule: function(moduleName) {
        if (!this.requiredModules) this.requiredModules = [];
        this.requiredModules.pushIfNotIncluded(moduleName);
    },

    getRequiredModules: function() { return this.requiredModules || [] }

},
'debugging', {
    toString: function() {
        return 'MetaInfo(' + this.partsSpaceName + this.partName + ')'
    }
});

Object.subclass('lively.PartsBin.PartsSpace',
'documentation', {
    documentation: 'A Namespace for parts of the parts bin. Usually points to a URL (directory) with serialized parts. Parts are morphs or might also be real objects. PartItems are wrapper for Parts used here in the PartsSpace.'
},
'initializing', {
    initialize: function(name) {
        this.name = Global.decodeURI(name);
        this.clearCache();
    },
    createPartItemNamed: function(name) {
        return new lively.PartsBin.PartItem(name, this.name);
    },
    clearCache: function() { this.partItems = {} }

},
'accessing', {
    getPartNames: function() {
        return Properties.own(this.partItems);
    },
    getPartItemNamed: function(name) {
        if (!this.partItems[name])
            this.partItems[name] = this.createPartItemNamed(name);
        if (this.partItems[name].getPartsSpace().getName() !== this.getName())
            alert('Item points to another PartsSpace it is actually in!')
        return this.partItems[name]
    },
    setPartItem: function(partItem) {
        return this.partItems[partItem.name] = partItem;
    },

    removePartItemNamed: function(name) {
        delete this.partItems[name];
    },


    getURL: function() { return URL.ensureAbsoluteRootPathURL(encodeURI(this.name)).asDirectory() },
    getPartItems: function() {
        return Properties.ownValues(this.partItems);
    },
    setPartItemsFromURLList: function(listOfUrls) {
        // listOfUrls are urls of serialized parts
        var names = listOfUrls
            .invoke('filename')
            .select(function(ea){ return  ea.match(/(.+)\.json$/)})
            .collect(function(ea){ return Global.decodeURI(ea.replace(".json", "")); });
        var items = {};
        names.forEach(function(name) { items[name] = this.createPartItemNamed(name) }, this);
        this.partItems = items;
    },
    getName: function() {
        var name = this.name;
        if (name.startsWith('http')) name = new URL(name).pathname.replace(/^\/?/, '');
        return name;
    }
},
'loading', {
    load: function(async) {
        var webR = new WebResource(this.getURL()).noProxy();
        if (async) webR.beAsync();
        // ask for the files of a directory and update so that the partItems correspond to the files found
        connect(webR, 'subDocuments', this, 'setPartItemsFromURLList', {
            converter: function(webResources) { return webResources.invoke('getURL') }})
        webR.getSubElements();
        return this;
    },
    ensureExistance: function() {
        var webR = new WebResource(this.getURL()).noProxy();
        if (!webR.exists()) webR.ensureExistance();
    }
},
'debugging', {
    toString: function() { return this.constructor.name + '(' + this.name + ')' }
});

Object.extend(lively.PartsBin, {
    partSpaces: {},
    addPartsSpace: function(space) {
        this.partSpaces[space.name] = space;
    },
    removePartsSpace: function(name) {
        delete this.partSpaces[name];
    },
    partsSpaceNamed: function(name) {
        if (!this.partSpaces[name])
            this.addPartsSpaceNamed(name);
        return this.partSpaces[name];
    },
    partsSpaceWithURL: function(url) {
        var rootPath = new URL(Config.rootPath),
            name = url.isIn(rootPath) ?
                url.relativePathFrom(rootPath) :
                url.toString();
        return this.partsSpaceNamed(Global.decodeURI(name));
    },

    addPartsSpaceNamed: function(name) {
        var space = new lively.PartsBin.PartsSpace(name);
        this.addPartsSpace(space);
        return space;
    },
    getPart: function(partName, optPartsSpaceName, cb) {
        var partItem = this.getPartItem(partName, optPartsSpaceName);
        if (!cb) 
            return partItem ? partItem.loadPart().part : null;
        if (!partItem)
            return cb(new Error("PartsBin item not found"), null);
        partItem.loadPart(true, undefined, undefined, cb);
    },
    getPartItem: function(partName, optPartsSpaceName) {
        // PartsBin -> PartsSpace -> PartItem -> Part
        var partsSpaceName = optPartsSpaceName || 'PartsBin',
            partsSpace = this.partsSpaceNamed(partsSpaceName),
            partItem = partsSpace.getPartItemNamed(partName);
        return partItem;
    },
    leftOverMetaInfos: function(partsBinBaseURL) {
// lively.PartsBin.leftOverMetaInfos().collect(function(ea) { return new WebResource(ea) }).invoke('del')
        partsBinBaseURL = partsBinBaseURL || URL.codeBase.withFilename('PartsBin')
        var dirs = new WebResource(partsBinBaseURL).noProxy().getSubElements().subCollections;

        var metainfosToRemove = [];
        dirs.forEach(function(dir) {
            var urls = dir.getSubElements().subDocuments.invoke('getURL')
            var metainfos = urls.select(function(ea) { return ea.filename().endsWith('.metainfo') })
            metainfosToRemove.pushAll(metainfos.reject(function(metaInfoURL) {
                var jsonURL = metaInfoURL.toString().replace('.metainfo', '.json');
                return urls.detect(function(url) { return url.toString() === jsonURL })
            }))
        })

        return metainfosToRemove
    },
    getLocalPartsBinURL: function(attribute) {
        return URL.root.withFilename('PartsBin/');
    },
    getPartsBinURLs: function() {
        // source URLs of all known PartsBins... a hack for now...
        var localURL = this.getLocalPartsBinURL(),
            additionalURLs = (lively.Config.get("partsbinURLs", true) || [])
              .map(function(ea) { return new URL(ea); })
              .reject(function(ea) { return ea.eq(localURL); }),
            world = lively.morphic.World.currentWorld;

        if (world && world.getUserName(true)) {
            var userUrl = new URL(world.getUserDir().withFilename('PartsBin/'));
            if (userUrl.asWebResource().noProxy().exists())
                additionalURLs.push(userUrl);
        }
        return [localURL].concat(additionalURLs);
    },

    discoverPartSpaces: function(thenDo) {
        var pb = lively.PartsBin;
        var webR = pb.getLocalPartsBinURL().asWebResource()
            .noProxy().beAsync()
            .getSubElements(1).whenDone(function(result, status) {
                (function() {
                    webR.subCollections.invoke("getURL").map(pb.partsSpaceWithURL.bind(pb));
                    show(webR.subCollections.invoke("getURL"));
                    if (thenDo) thenDo(null, pb.partSpaces);
                }).delay(0);
            });
    },

    copyRemotePart: function(partName, partsSpaceName, serverURL, thenDo) {
        var fromURL = new URL(serverURL).withFilename(partsSpaceName).asDirectory();
        var files = ['.json', '.html', '.metainfo'].map(function(ea) { return  partName + ea; });
        var toURL = URL.root.withFilename(partsSpaceName).asDirectory();
        toURL.asWebResource().noProxy().ensureExistance();
        var errors = [];
        files.clone().doAndContinue(function(next, file) {
            Functions.composeAsync(
                function(next) {
                    fromURL.withFilename(file).asWebResource().noProxy()
                        .beAsync().get().whenDone(function(content, status) {
                            next(status.isSuccess() ? null : status, content); });
                },
                function(content, next) {
                    toURL.withFilename(file).asWebResource().noProxy()
                        .beAsync().put(content).whenDone(function(_, status) {
                            next(status.isSuccess() ? null : status); });
                }
            )(function(err) { if (err) errors.push(err); files.remove(file); next(); });
        }, function() { thenDo && thenDo(errors.length ? errors : null); });
    },

    withAllItemsDo: function(partsBinBaseURL, thenDo) {
        if (typeof partsBinBaseURL === "function") {
            thenDo = partsBinBaseURL; partsBinBaseURL = null;
        }
        if (partsBinBaseURL == null)
            partsBinBaseURL = this.getLocalPartsBinURL();
        // FIXME: only working with local partsBinBaseURLs
        var relativeURL = partsBinBaseURL.relativePathFrom(URL.root);

        lively.lang.fun.composeAsync(
            // 1. load all files from ObjectRepository
            lively.net.Wiki.findResourcePathsMatching.bind(lively.net.Wiki, relativeURL + '%', true),

            // 2. put all the files into a tree (space -> files)
            function(allFiles, next) {
                var defaultParents = URL.root.getAllParentDirectories().length;
                next(null, allFiles.reduce(function(spaces, urlPart) {
                    var url = URL.root.withFilename(urlPart),
                        partSpace = url.getAllParentDirectories()[defaultParents].relativePathFrom(URL.root);
                    if (partSpace.endsWith('/')) {
                        if (!spaces.hasOwnProperty(partSpace))
                            spaces[partSpace] = [];
                        spaces[partSpace].push(url);
                    }
                    return spaces;
                }, {}));
            },

            // 3. create PartSpaces
            function(tree, next) {
                next(null, Object.getOwnPropertyNames(tree).map(function(space) {
                    var partSpace = lively.PartsBin.partsSpaceWithURL(URL.root.withFilename(space));
                    partSpace.setPartItemsFromURLList(tree[space]);
                    return partSpace;
                }));
            },

            // 4. combine all items
            function (spaces, next) {
                next(null, spaces.reduce(function(itemsPerSpace, space) {
                    itemsPerSpace[space.name] = space.partItems;
                    return itemsPerSpace;
                }, {}));
            }
        )(thenDo);
    }
});

Trait('lively.PartsBin.PartTrait', {
    copyToPartsBin: function(optPartsSpaceNamed) {
        if (!this.name) {
            alert('cannot copy to Inventory without a name');
            return;
        }

        // FIXME uuuuuuugly
        // copyToPartsBin is sometimes called from menus and
        // the argument we get is an event --- fixe that!!!!
        if (optPartsSpaceNamed && Object.isString(optPartsSpaceNamed))
            this.getPartsBinMetaInfo().setPartsSpaceName(optPartsSpaceNamed);

        if (false && this.getPartsBinMetaInfo().partsSpaceName &&
            !this.getPartsBinMetaInfo().partsSpaceName.startsWith("PartsBin")) {
                alertOK("resetting partsSpaceName of " + this)
                delete this.getPartsBinMetaInfo().partsSpaceName
        }

        this.getPartsBinMetaInfo().migrationLevel = LivelyMigrationSupport.migrationLevel;
        this.getPartsBinMetaInfo().partName = this.name;

        this.getPartItem().uploadPart(true);
    },
    copyToPartsBinWithUserRequest: function() {
        this.world().openPublishPartDialogFor(this);
    },

    copyToMyPartsBin: function() {
        // FIXME this code was not yet refactored to work with the new PartsSpace/PartItem model
        var userName = lively.Config.get('UserName');
        if (!userName) throw Error('Cannot copyToMyPartsBin without userName')

        var userDir = URL.codeBase.withFilename(userName + '/MyPartsBin/');
        var wr = new WebResource(userDir).noProxy();
        if (!wr.exists()) {
            alert("created " + userDir)
             wr.create();
        }

        var partsBinUrl = URL.codeBase.withFilename(userName +  '/MyPartsBin/');
        wr = new WebResource(partsBinUrl).noProxy();
        if (!wr.exists()) {
            alert("created " + partsBinUrl)
            wr.create();
        }

        this.copyToPartsBinUrl(partsBinUrl);
    },

    interactiveCopyToMyPartsBin: function() {
        if (!lively.Config.get('UserName'));
            this.world().askForUserName();
        if (!this.name) {
            this.world().promt('cannot copy to partsBin without a name', function(name) {
                if (name == this.toString()) {
                    alert('Cannot copy '+this.toString() + 'to MyPartsBin without a name ');
                    return;
                }
                this.name = name;
                this.copyToMyPartsBin()
            }.bind(this), this.toString())
        } else {
            this.copyToMyPartsBin()
        }
    },

    copyToPartsBinUrl: function(partsBinURL) {
        var partsSpace = lively.PartsBin.partsSpaceWithURL(partsBinURL);
        this.copyToPartsSpace(partsSpace);
    },

    copyToPartsSpace: function(partsSpace) {
        this.getPartsBinMetaInfo().setPartsSpace(partsSpace)
        this.getPartItem().uploadPart();
    },

    // Opens the "Publish to Inventory" dialog: lets the user set name,
    // comment, category and visibility (public/private/shared) before
    // saving this part as an identity-aware envelope (postcard-audit F15)
    // rather than to WebDAV's PartsBin — makes it browsable from the
    // postcard editor's insert-part picker (lively.identity.IdentityPartsSpace),
    // which reads type:'part' envelopes instead of a WebDAV directory.
    // Replaces the old copyToIdentityPartsSpace, which saved immediately
    // with a hardcoded empty comment, a locked name, and no privacy choice.
    promptPublishToInventory: function() {
        var morph = this;
        if (!this.name) {
            alert('Cannot publish to Inventory without a name');
            return;
        }
        if (typeof lively === 'undefined' || !lively.require) {
            alert('Cannot publish to Inventory: Lively module system not available');
            return;
        }
        lively.require('lively.identity.UserSpace', 'lively.identity.WebKey', 'lively.identity.PartSerializer', 'lively.morphic.tools.PublishToInventoryDialog').toRun(function() {
            var user = lively.identity.did.currentUser();
            if (!user) { alert('Cannot publish to Inventory: not signed in'); return; }
            var world = morph.world();
            if (world.publishToInventoryDialog) world.publishToInventoryDialog.remove();
            var dlg = lively.BuildSpec('lively.morphic.tools.PublishToInventoryDialog').createMorph();
            dlg.openInWorldCenter().comeForward();
            world.publishToInventoryDialog = dlg;
            dlg.get('PublishToInventoryPane').setTarget(morph);
        });
    },

    // Does the actual serialize + (optionally encrypt) + save + sync +
    // refresh, parameterized by the Publish to Inventory dialog's input.
    // opts: { name, comment, tags, visibility: 'public'|'private'|'shared',
    //         recipientHandles, onWaiting }
    // Calls thenDo(err, envelope).
    //
    // HARDENING: this used to assume lively.identity.userSpace (and
    // .did/.objectStore/.webAuthn) were already loaded — true when called
    // via the normal promptPublishToInventory dialog flow (which
    // lively.require()s UserSpace/PartSerializer before the dialog even
    // opens), but not guaranteed for any other caller. Confirmed live: a
    // caller that skips promptPublishToInventory and calls this directly
    // hits "Cannot read properties of undefined (reading 'addPart')" deep
    // inside an IndexedDB transaction callback — a confusing crash instead
    // of a clear error, since the actual failure has nothing to do with
    // what's on that line. lively.require-ing here makes this method
    // correct standalone, matching promptPublishToInventory's own guard.
    _publishToInventory: function(opts, thenDo) {
        var morph = this;
        if (typeof lively === 'undefined' || !lively.require) {
            thenDo(new Error('Cannot publish to Inventory: Lively module system not available'));
            return;
        }
        lively.require('lively.identity.UserSpace', 'lively.identity.PartSerializer').toRun(function() {
            morph._publishToInventoryImpl(opts, thenDo);
        });
    },

    _publishToInventoryImpl: function(opts, thenDo) {
        var morph = this;
        var user = lively.identity.did.currentUser();
        if (!user) { thenDo(new Error('Not signed in')); return; }

        var serialized;
        try {
            serialized = morph.getPartItem().serializePart(morph);
        } catch (e) {
            thenDo(new Error('Could not serialize part: ' + e.message));
            return;
        }

        var params = {
            json: serialized.json,
            htmlLogo: serialized.htmlLogo || null,
            partName: opts.name,
            comment: opts.comment || '',
            tags: opts.tags || [],
            category: opts.category || null,
            // Continues this objId's version chain (prevCid) instead of
            // minting a new genesis object -- set by PublishToInventoryDialog
            // when the target morph carries provenance from a prior
            // Inventory load/publish (morph._inventoryEnvelope, see
            // Inventory.js's _openEnvelope). Absent (null) for a genuine
            // first-time publish, which still takes the existing genesis
            // path in PartSerializer.js unchanged.
            prevEnvelope: opts.prevEnvelope || null,
        };

        // Local-first, same as every other identity write (UserSpace.js) —
        // write to the local ObjectStore (IndexedDB) first, then sync to
        // the server, then refresh any open PartsBinBrowser showing My
        // Parts / a tag category. Re-clicking the same category in the
        // browser's sidebar does NOT reliably do this on its own —
        // categoryName is driven by categoryList.selection, and reselecting
        // an already-selected value there never fires the connection that
        // would reload (confirmed live: 0 loadPartsOfCategory calls on a
        // same-value reselect) — a pre-existing quirk of that shared list
        // widget, not something specific to identity parts. Calling
        // loadPartsOfCategory directly here sidesteps that property-change
        // machinery entirely.
        function withEnvelope(envelope) {
            lively.identity.objectStore.put(envelope, function(err) {
                if (err) { thenDo(new Error('Publish to Inventory failed: ' + err.message)); return; }

                function finish() {
                    lively.identity.userSpace.addPart('general', {
                        objId: envelope.objId, cid: envelope.record.cid, title: opts.name, partName: opts.name,
                    }, function(addErr) {
                        // Non-fatal: the envelope is already saved and browsable
                        // via *myparts*/tag categories even if this index write fails.
                        if (addErr) console.warn('[_publishToInventory] Could not register in My Parts index:', addErr.message);

                        if (typeof $world !== 'undefined' && $world.submorphs) {
                            $world.submorphs.forEach(function(w) {
                                if (w.name !== 'PartsBinBrowser' || !w.get) return;
                                var browser = w.get('PartsBinBrowser');
                                var cat = browser && browser.categoryName;
                                if (cat === '*myparts*' || (cat && cat.charAt(0) === '#')) {
                                    browser.loadPartsOfCategory(cat);
                                }
                            });
                        }

                        // Remembers this publish's own envelope on the live
                        // morph so a second "Publish to Inventory" in the
                        // same session (without reopening from Inventory)
                        // also continues the chain -- see
                        // PublishToInventoryDialog.js's setTarget. Same
                        // doNotSerialize requirement as Inventory.js's
                        // _openEnvelope: an un-excluded own property here
                        // gets walked into the NEXT publish's own
                        // serialized JSON.
                        morph._inventoryEnvelope = envelope;
                        morph.doNotSerialize = (morph.doNotSerialize || []).concat('_inventoryEnvelope');

                        thenDo(null, envelope);
                    });
                }

                if (!opts.prevEnvelope) {
                    // Ordinary genesis publish -- existing fire-and-forget
                    // sync behavior, unchanged. A genesis objId is random,
                    // so a server-side conflict here is astronomically
                    // unlikely; sync failures are logged and left for the
                    // normal background sync machinery to retry.
                    lively.identity.objectStore.syncObject(
                        envelope.objId, user.handle, lively.identity.did.baseUrl(),
                        function(syncErr) {
                            if (syncErr) console.warn('[_publishToInventory] sync failed (will retry later):', syncErr.message);
                        }
                    );
                    finish();
                    return;
                }

                // True continuation (opts.prevEnvelope set): every republish
                // now sends a real, specific prevCid, so a server-side
                // conflict (someone else published a newer version first --
                // two tabs, a stale reopened dialog) is a realistic,
                // normal-use race, not a near-impossible genesis-objId
                // collision. The fire-and-forget path above would silently
                // swallow a 409 forever -- ObjectStore.js's _pushObject
                // treats any non-ok server response as "skip, don't abort",
                // the record never gets marked synced, and every future
                // sync attempt skips it the same way, permanently -- so
                // this specifically awaits the server's response instead of
                // reporting local-save success as if it were published.
                var url = lively.identity.did.baseUrl().replace(/\/$/, '') + '/@' + user.handle + '/' + envelope.objId;
                fetch(url, {
                    method: 'PUT',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(envelope),
                }).then(function(res) {
                    if (res.ok) {
                        lively.identity.objectStore._markSynced(envelope.objId, envelope.record.cid, finish);
                        return;
                    }
                    res.json().catch(function() { return {}; }).then(function(body) {
                        if (res.status === 409) {
                            thenDo(new Error('This item changed since you opened it. Reopen it from Inventory and reapply your edits, then publish again.'));
                        } else {
                            thenDo(new Error('Publish to Inventory failed: ' + (body.error || ('HTTP ' + res.status))));
                        }
                    });
                }).catch(function(fetchErr) {
                    thenDo(new Error('Publish to Inventory failed: ' + fetchErr.message));
                });
            });
        }

        if (opts.visibility === 'public') {
            lively.identity.partSerializer.serializeToEnvelope(params, function(err, envelope) {
                if (err) { thenDo(err); return; }
                withEnvelope(envelope);
            });
            return;
        }

        // private/shared: need the KEK cached (one passkey prompt per
        // session, same as every other private save in this codebase), then
        // for shared, each recipient's current X25519 public key.
        var wa = lively.identity.webAuthn;
        function withKek(cb) {
            if (wa._kekCache && wa._kekCache[user.credentialId]) return cb(null);
            if (opts.onWaiting) opts.onWaiting();
            var ch = new Uint8Array(32);
            crypto.getRandomValues(ch);
            wa.deriveKek({ credentialId: user.credentialId, rpId: user.rpId, challenge: ch }, function(err) { cb(err); });
        }

        withKek(function(err) {
            if (err) { thenDo(new Error('Could not unlock encryption key: ' + err.message)); return; }

            function withRecipients(cb) {
                if (opts.visibility !== 'shared' || !opts.recipientHandles.length) return cb(null, []);
                lively.identity.partSerializer.resolveRecipientPubKeys(opts.recipientHandles, function(err, result) {
                    if (err) return cb(err);
                    if (result.failed.length) {
                        return cb(new Error(result.failed.map(function(h) { return '@' + h; }).join(', ') + " hasn't set up encryption yet"));
                    }
                    cb(null, result.resolved.map(function(r) { return { did: r.did, x25519PublicKey: r.x25519PublicKey }; }));
                });
            }

            withRecipients(function(err, recipients) {
                if (err) { thenDo(err); return; }
                params.recipients = recipients;
                lively.identity.partSerializer.serializeEncrypted(params, function(err, envelope) {
                    if (err) { thenDo(err); return; }
                    withEnvelope(envelope);
                });
            });
        });
    },

    getPartsBinMetaInfo: function() {
        if (!this.partsBinMetaInfo) {
            this.partsBinMetaInfo = new lively.PartsBin.PartsBinMetaInfo();
            this.partsBinMetaInfo.partName = this.getName();
        }
        if (!(this.partsBinMetaInfo instanceof lively.PartsBin.PartsBinMetaInfo)) {
            var oldMetaInfo = this.partsBinMetaInfo;
            this.partsBinMetaInfo = new lively.PartsBin.PartsBinMetaInfo();
            this.partsBinMetaInfo.partName = this.getName();
            Properties.forEachOwn(oldMetaInfo, function(key, value) {
                this.partsBinMetaInfo[key] = value;
            }, this)
        }
        return this.partsBinMetaInfo;
    },

    setPartsBinMetaInfo: function(metaInfo) {
        return this.partsBinMetaInfo = metaInfo;
    },

    getPartItem: function() {
        return new lively.PartsBin.PartItem(this, this.getPartsBinMetaInfo().getPartsSpaceName());
    },

    asSVGLogo: function() {
        var oldPos = this.getPosition();
        this.setPosition(pt(0,0))
        var logoMorph = this.asLogo()
        this.setPosition(oldPos)
        // width="2000pt" height="2000pt"
        return '<?xml version="1.0" encoding="UTF-8"?>\n'+
            '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' +
            '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '+
            'xmlns:ev="http://www.w3.org/2001/xml-events" version="1.1" baseProfile="full" >\n' +
            Exporter.stringify(logoMorph.rawNode) +
            '</svg>';
    },

    asHTMLLogo: function(options) {
        // options = {scale: NUMBER, asFragment: BOOLEAN}
        return '<html><body>please implement</body></html>'
    }

});

}) // end of module
