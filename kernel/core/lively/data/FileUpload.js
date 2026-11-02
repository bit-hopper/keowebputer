module("lively.data.FileUpload")
  .requires("lively.persistence.Serializer", "lively.Network", "lively.identity.FileCrypto")
  .toRun(function () {
    // Handles uploading of dropped files via HTML5 event API. This is how it works:
    // From the drop event we get a list of files, each have a type attribute
    // (String, mime type)
    // 1. lively.data.FileUpload>handleDroppedFiles(files, evt})
    // 2. we then use file.type to find a upload handler that deals with this file
    //    type. handlers are subclasses of lively.data.FileUpload.Handler. They should
    //    implement a #handle(file) method which returns true if the handler can deal
    //    with the file.type. For matching handlers we then call handler.startReading
    // 3. The handler can specify the readMethod. Accoriding to it the HTML5
    //    FileReader>>readAsBinaryString || FileReader>>readAsText || FileReader
    //    >>readAsDataURL methods are used
    // 4. When reading finishes handler.onLoad is called. The uploaded data is now
    //    in the browser and can be used, e.g. via dataURL. Some handlers might to
    //    choose to upload their data into a file on the server instead of dealing with
    //    it directly

    // handlers are expected to implement
    // onLoad(evt)
    // handlers can parameterize the reader/uploader by returning a spec object
    // from getUploadSpec(evt, file):
    // {
    //     readMethod: "asBinaryString"|"asText"|"asDataURL", // read as binary encoding
    //     showProgressbar: BOOL // show a progressbar while reading? defaults to true
    // }

    Object.subclass(
      "lively.data.FileUpload.Handler",
      "initalization",
      {
        initialize: function (evt, fileOrItems) {
          this.evt = evt;
          if (fileOrItems instanceof File) this.file = fileOrItems;
          else if (fileOrItems && fileOrItems[0] instanceof DataTransferItem)
            this.items = fileOrItems;
        },
      },
      "handler interface",
      {
        handles: function (file) {
          return false;
        },
        handlesItems: function (items) {
          return false;
        },
      },
      "item processing",
      {
        handleItems: function (items) {},
      },
      "file reader",
      {
        startReading: function (readMethod, file) {
          if (readMethod === "manual") return this.readManually(file);

          var reader = this.getFileReader();
          if (readMethod === "asBinary") reader.readAsBinaryString(file);
          else if (readMethod === "asText") reader.readAsText(file);
          else if (readMethod === "asArrayBuffer")
            reader.readAsArrayBuffer(file);
          else reader.readAsDataURL(file);
        },

        getFileReader: function () {
          var self = this;
          return Object.extend(new FileReader(), {
            onload: function (evt) {
              self.onLoad && self.onLoad(evt, self);
            },
            onerror: function (evt) {
              self.onError && self.onError(evt, self);
            },
            onloadstart: function (evt) {
              self.onLoadStart && self.onLoadStart(evt, self);
            },
            onloadend: function (evt) {
              self.onLoadEnd && self.onLoadEnd(evt, self);
            },
            onprogress: function (evt) {
              self.onProgress && self.onProgress(evt, self);
            },
          });
        },

        readManually: function (file) {},
      },
      "file reader events",
      {
        // default handler methods. specific handlers can reimplement them
        onError: function (evt) {
          alert("Error occured while loading file " + this.file.name);
          console.error(evt);
        },
        onLoadStart: function (evt) {
          alertOK("Loading " + this.file.name);
        },
        onLoadEnd: function (evt) {
          this.progressbar && this.progressbar.remove();
        },
        onProgress: function (evt) {
          if (!evt.lengthComputable) return;
          if (!this.showProgressbar) return;
          if (!this.progressbar) {
            this.progressbar = $world.addProgressBar(
              null,
              this.file && this.file.name,
            );
          }
          this.progressbar.updateBar(evt.loaded / evt.total);
        },
        onLoad: function (evt) {
          alert(
            "Loaded file " +
              this.file.name +
              " but don't know what to do now...!",
          );
        },
      },
      "uploading to server",
      {
        isIdentityUploadAvailable: function () {
          return !!(
            typeof lively !== "undefined" &&
            lively.identity &&
            lively.identity.did &&
            lively.identity.did.isLoggedIn()
          );
        },

        // ref: {handle, blobCid} -- identifies the real server-side blob to
        // reclaim on delete (derived, not a directly-storable URL: the
        // morph's own displayed content is a session-local blob: URL, see
        // lively.data.EncryptedMedia).
        attachIdentityDelete: function (morph, ref) {
          if (!morph || !ref || !ref.handle || !ref.blobCid) return;
          morph.identityUploadRef = ref;
          morph.addScript(function remove() {
            var self = this;
            var uploadRef = this.identityUploadRef;
            console.log('[identityDelete] remove() called. uploadRef:', uploadRef, '| owner:', this.owner);
            // Call the base remove explicitly — $super doesn't work when the method
            // is inherited rather than defined directly on the subclass prototype.
            lively.morphic.Morph.prototype.remove.call(this);
            console.log('[identityDelete] after base remove, owner:', this.owner);
            if (!uploadRef) { console.log('[identityDelete] no ref, skipping DELETE'); return; }
            // remove() is also called during drag (morph is re-parented to the hand).
            // Defer the DELETE: if the morph gets a new owner (hand or world) within
            // the same tick, it's a drag — not a deletion — so don't delete the file.
            setTimeout(function () {
              console.log('[identityDelete] setTimeout: owner is', self.owner, '→ will DELETE:', !self.owner);
              if (!self.owner) {
                delete self.identityUploadRef;
                // Another morph (e.g. a halo copy, which carries over
                // persisted properties like fileObjId but not this ad-hoc
                // identityUploadRef marker) can end up displaying the same
                // blob without ever being tracked for deletion itself.
                // Deleting the file out from under that still-live sibling
                // silently corrupts it — confirmed against @candle's saved
                // world history (back when content was a plain shared URL;
                // the durable identity now is blobCid, not a URL string,
                // since two morphs never share a literal blob: URL). Scan
                // every morph for the same blobCid before deleting — cheap,
                // and catches any media type (image/video/pdf) without
                // needing to know its src property name.
                var stillReferenced = false;
                $world.withAllSubmorphsDo(function (m) {
                  if (stillReferenced || m === self) return;
                  if (m.identityUploadRef && m.identityUploadRef.blobCid === uploadRef.blobCid) {
                    stillReferenced = true;
                  }
                });
                if (stillReferenced) {
                  console.log('[identityDelete] blobCid still referenced by another morph, skipping DELETE:', uploadRef.blobCid);
                  return;
                }
                var deleteUrl = lively.identity.did.baseUrl() + '/@' + uploadRef.handle + '/blobs/' + uploadRef.blobCid;
                fetch(deleteUrl, { method: "DELETE", credentials: "include" })
                  .then(function (r) {
                    r.json().then(function (j) {
                      console.log('[identityDelete] DELETE response', r.status, j);
                    });
                  })
                  .catch(function (e) { console.warn('[identityDelete] DELETE failed', e); });
              }
            }, 0);
          });
        },

        // Calls thenDo(null, {handle, objId, blobCid}) -- not a directly
        // usable URL. Private file envelope via FileCrypto: flat,
        // objId-addressed, so (unlike the old legacy-uploads path this
        // replaces) two unrelated drops sharing a generic browser-assigned
        // name (clipboard screenshots all come in as "image.png") never
        // collide on a shared server path; each upload gets its own
        // objId/blobCid. Private, not public: files and worlds default to
        // encrypted, per the same reasoning as every other upload path in
        // this codebase — rendering private content is handled by
        // lively.data.EncryptedMedia (loaded below before thenDo fires),
        // not by handing callers a plaintext-fetchable URL.
        identityUpload: function (file, thenDo) {
          var handle = lively.identity.did.currentUser().handle;
          lively.identity.fileCrypto.encryptAndUpload(file, {
            visibility: "private",
            name: file.name,
          }, function (err, result) {
            if (err) return thenDo(err);
            var ref = { handle: handle, objId: result.objId, blobCid: result.blobCid };
            lively.require('lively.data.EncryptedMedia').toRun(function () {
              thenDo(null, ref);
            });
          });
        },

        uploadBinary: function (url, mime, binaryData, onloadCallback) {
          var webR = new WebResource(url);
          webR.enableShowingProgress();
          var progressBar = $world.addProgressBar(
            null,
            webR.getURL().filename(),
          );
          lively.bindings.connect(
            webR,
            "progress",
            {
              onProgress: function (evt) {
                if (!evt.lengthComputable) return;
                progressBar.updateBar(evt.loaded / evt.total);
              },
            },
            "onProgress",
          );

          if (onloadCallback)
            lively.bindings.connect(
              webR,
              "status",
              { onLoad: onloadCallback },
              "onLoad",
            );
          lively.bindings.connect(webR, "status", progressBar, "remove", {
            updater: function ($upd, status) {
              if (status && status.isDone()) $upd();
            },
          });

          webR.beBinary().beAsync().put(binaryData);
          return webR;
        },
      },
    );

    Object.extend(lively.data.FileUpload, {
      handleImportEvent: function (evt) {
        // see https://developer.mozilla.org/en/Using_files_from_web_applications
        var files = evt.dataTransfer.files;
        if (files && files.length > 0) {
          lively.data.FileUpload.handleDroppedFiles(files, evt);
        }
        var items = evt.dataTransfer.items;
        if (items && items.length) {
          lively.data.FileUpload.handleDroppedItems(items, evt);
        }
      },

      handleDroppedFiles: function (files, evt) {
        // handler for specific file types
        var pos = evt.getPosition(),
          i = 0,
          handlerClasses = lively.data
            .classes(true)
            .concat(lively.Clipboard.classes(true))
            .filter(function (ea) {
              return ea.isSubclassOf(lively.data.FileUpload.Handler);
            }),
          filesToUpload = [];

        if (evt.isAltDown()) {
          this.uploadFilesToServer(files, evt, false, function (err, report) {
            if (err) alert(err);
            else
              alertOK("uploaded files: \n" + JSON.stringify(report, null, 2));
          });
          return;
        }

        Array.from(files).forEach(function (file) {
          var handlerClass = handlerClasses.detect(function (handlerClass) {
            try {
              return handlerClass.prototype.handles(file, evt);
            } catch (e) {
              return false;
            }
          });

          if (!handlerClass) {
            console.warn(
              "[FileUpload] no handler found for dropped/pasted file" +
                (file ? " of type " + file.type : " (empty item)"),
            );
            return;
          }

          i++;
          var handler = new handlerClass(evt, file),
            options = handler.getUploadSpec(evt, file),
            readMethod = options.readMethod || "asDataURL";
          Object.extend(handler, {
            i: i,
            showProgressbar: options.hasOwnProperty("showProgressbar")
              ? options.showProgressbar
              : true,
            pos: pos.addXY(15 * i, 15 * i),
          });
          handler.startReading(readMethod, file);
        });
      },

      handleDroppedItems: function (items, evt) {
        // handler for specific file types
        var pos = evt.getPosition(),
          i = 0,
          handlerClasses = lively.data
            .classes(true)
            .concat(lively.Clipboard.classes(true))
            .filter(function (ea) {
              return ea.isSubclassOf(lively.data.FileUpload.Handler);
            });

        var handlerClass = handlerClasses.detect(function (handlerClass) {
          return handlerClass.prototype.handlesItems(items, evt);
        });
        if (handlerClass) {
          var handler = new handlerClass(evt, items);
          handler.handleItems(items, evt);
        } else {
          // default behavior, FIXME, should go into handler class...
          var content = evt.dataTransfer.getData("text/html");
          if (content) {
            lively.morphic.HtmlWrapperMorph.renderHTML(content);
            return;
          }
          content = evt.dataTransfer.getData("text/plain");
          if (content) {
            $world.addCodeEditor({
              content: content,
              gutter: false,
              textMode: "text",
            });
            return;
          }
        }
      },

      uploadFilesToServer: function (files, evt, askForLocation, thenDo) {
        // use XHR2 form data object to upload data via POST /upload
        // implemented by subserver UploadServer

        var formData = new Global.FormData(),
          files = Array.from(files);
        files.forEach(function (file) {
          formData.append("file", file);
        });

        // files will be put into a designated directory on server once
        // uploaded, let user choose this dir here
        Functions.composeAsync(
          function (n) {
            var m = module("lively.ide.CommandLineInterface");
            if (m.isLoaded()) return n();
            m.load();
            m.runWhenLoaded(function () {
              n();
            });
          },

          function (n) {
            var uploadDir = lively.lang.string.joinPath(
              lively.shell.WORKSPACE_LK,
              $world.getUserDir().fullPath(),
              "uploads",
            );
            n(null, uploadDir);
          },

          askForLocation
            ? function askForLocation(defaultLocation, next) {
                $world.prompt(
                  "Location to upload files to",
                  function (input) {
                    next(null, input || defaultLocation);
                  },
                  defaultLocation,
                );
              }
            : function (loc, n) {
                n(null, loc);
              },

          function upload(location, next) {
            formData.append("location", location);
            //   console.log('[FileUpload] Starting upload to location:', location);
            //   console.log('[FileUpload] FormData contains', files.length, 'file(s)');
            URL.root
              .withFilename("upload")
              .asWebResource()
              .enableShowingProgress()
              .createProgressBar("Uploading")
              .beAsync()
              .post(formData)
              .withJSONWhenDone(function (json, stat) {
                // console.log('[FileUpload] Upload response status:', stat);
                // console.log('[FileUpload] Upload response:', json);
                next(null, json, stat);
              });
          },

          function report(uploadReport, postStatus, next) {
            next(null, uploadReport);
          },
        )(function (err, uploadReport) {
          thenDo && thenDo(err, uploadReport);
        });
      },
    });

    (function loadFileUploadHandlers() {
      var handlerModules = [
        "lively.data.DirectoryUpload",
        "lively.data.ODFImport",
        "lively.data.PDFUpload",
        "lively.data.ImageUpload",
        "lively.data.VideoUpload",
        "lively.data.AudioUpload",
        "lively.data.TextUpload",
      ];
      handlerModules.map(module).invoke("load");
    })();
  }); // end of module
