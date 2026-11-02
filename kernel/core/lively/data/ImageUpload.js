module("lively.data.ImageUpload")
  .requires("lively.data.FileUpload")
  .toRun(function () {
    lively.data.FileUpload.Handler.subclass("lively.Clipboard.ImageUploader", {
      uploadThreshold: 1024 * 1024 * 60, // 60MB

      handles: function (file) {
        return file.type.match(/image\/.*/);
      },

      htmlWrapsImage: function (evt) {
        // when dropping images from one browser page to another we receive a
        // drop event with an item. The item has the mime type html, even if an
        // image and not a whole DOM selection was dragged&dropped. However, in
        // those cases only the image element is the only meaningful element.
        // This method recognizes that.
        var elems = this.getHTMLElementsFromDataTransfer(evt);
        return (
          elems.length === 1 &&
          elems[0].tagName &&
          elems[0].tagName.toUpperCase() === "IMG"
        );
      },

      getHTMLElementsFromDataTransfer: function (evt) {
        var content = evt.dataTransfer.getData("text/html");
        return content
          ? lively.$.parseHTML(content).filter(function (el) {
              return el.tagName !== "META";
            })
          : null;
      },

      handlesItems: function (items, evt) {
        var content = evt.dataTransfer && evt.dataTransfer.getData("text/html");
        return content && this.htmlWrapsImage(evt);
      },

      handleItems: function (items, evt) {
        var elems = this.getHTMLElementsFromDataTransfer(evt);
        if (!elems || !elems[0]) {
          console.warn("No HTML elements found in data transfer");
          return;
        }
        var el = elems[0];
        var src = el.getAttribute("src");
        this.openImage(src, null, evt.getPosition());
      },

      readManually: function (file) {
        var self = this;

        function _openAndFit(ref, type) {
          var img = self.openImage(ref, type, self.pos, file.name, function (err, loadedImg) {
            var m = loadedImg || img;
            if (!m) return;
            var tryExtent = function () {
              try { m.setNativeExtent(); } catch (e) { setTimeout(tryExtent, 100); }
            };
            setTimeout(tryExtent, 100);
          });
          // Attach synchronously from the return value — don't wait for the load callback,
          // which may receive (img) instead of (null, img) depending on the Image class.
          if (img && ref && typeof ref === "object") {
            self.attachIdentityDelete(img, { handle: ref.handle, blobCid: ref.blobCid });
          }
        }

        if (self.isIdentityUploadAvailable()) {
          self.identityUpload(file, function (err, ref) {
            if (err) { $world.inform("Error uploading image file:\n" + err); return; }
            _openAndFit(ref, file.type);
          });
          return;
        }

        lively.lang.fun.composeAsync(
          function (n) {
            lively.data.FileUpload.uploadFilesToServer([file], self.evt, false, n);
          },
          function (report, n) {
            if (!report || !report.uploadedFiles || !report.uploadedFiles[0]) {
              return n(new Error("no file uploaded or invalid upload response. Response: " + JSON.stringify(report)));
            }
            var uploaded = report.uploadedFiles[0],
              relPath = uploaded && uploaded.relativePath;
            if (!relPath) return n(new Error("no file uploaded?"));
            // Root-relative, not URL.root.withPath(...) (which bakes in the
            // current domain's full absolute origin) — this string ends up
            // as the image morph's persisted imageURL via setImageURL, so an
            // absolute URL here permanently pins the image to whichever
            // domain happened to be serving the page at drop time.
            // Confirmed live: images dropped this way while browsing from
            // dev.tinylil.world came back with
            // "https://dev.tinylil.world/users/.../uploads/..." baked in,
            // which then failed to load entirely (fetch: "Failed to fetch")
            // from localhost — even though the identical file exists locally
            // and loads fine at the equivalent root-relative path. Same fix
            // as Themes.js's tile URL and lively.identity.LocalMap's own
            // runtime asset paths: resolve fresh against whichever domain is
            // actually serving the page, on every load.
            var img = self.openImage(
              "/" + relPath,
              uploaded.type, self.pos, file.name, n);
          },
          function (img, n) {
            var attemptSetNativeExtent = function () {
              try { img.setNativeExtent(); n(); }
              catch (e) { setTimeout(attemptSetNativeExtent, 100); }
            };
            setTimeout(attemptSetNativeExtent, 100);
          },
        )(function (err) {
          if (err) $world.inform("Error uploading image file:\n" + err);
        });
      },

      getUploadSpec: function (evt, file) {
        // var altDown = evt.isAltDown();
        // return {readMethod: altDown ? "asBinary" : 'asDataURL'};
        return { readMethod: "manual" };
      },

      onLoad: function (evt) {
        if (this.readMethod === "asBinary") {
          this.uploadAndOpenImageTo(
            URL.source.withFilename(this.file.name),
            this.file.type,
            evt.target.result,
            this.pos,
          );
        } else {
          if (
            typeof evt.total == "number" &&
            evt.total > this.uploadThreshold
          ) {
            var size = Numbers.humanReadableByteSize(evt.total);
            $world.confirm(
              "WARNING: Uploaded file is rather big (" +
                size +
                ").\n" +
                "Do you want to continue uploading?",
              function (result) {
                if (result === 0)
                  this.openImage(
                    evt.target.result,
                    this.file.type,
                    this.pos,
                    this.file.name,
                  );
              }.bind(this),
              ["Yes", "No"],
            );
          } else
            this.openImage(
              evt.target.result,
              this.file.type,
              this.pos,
              this.file.name,
            );
        }
      },

      uploadAndOpenImageTo: function (url, mime, binaryData, pos) {
        var openImage = this.openImage.bind(this, url, mime, pos);
        var webR = this.uploadBinary(url, mime, binaryData, function (status) {
          if (!status.isDone()) return;
          if (status.isSuccess()) openImage();
          else alert("Failure uploading " + url + ": " + status);
        });
      },

      // url: a plain fetchable URL (legacy/non-identity uploads, the
      // local-dev-server fallback, or a URL lifted from a dragged <img>
      // element), OR {handle, objId} for an identity upload -- the latter
      // renders as encrypted content via lively.data.EncryptedMedia's
      // EncryptedImage instead of a plain <img src> binding, since that
      // binding can never decrypt private content (confirmed live: it
      // doesn't even work for the owner).
      openImage: function (url, mime, pos, optName, thenDo) {
        var name = optName;
        var isRef = url && typeof url === "object";
        if (!name) {
          if (isRef) {
            name = "image";
          } else {
            try { name = new URL(url).filename(); }
            catch (e) { name = "image"; }
          }
        }
        var w = lively.morphic.World.current();
        var maxExt = w.visibleBounds().extent().addXY(-20, -20);
        var opts = {
          useNativeExtent: true,
          maxWidth: maxExt.x,
          maxHeight: maxExt.y,
        };
        // Start with 0x0 extent to trigger automatic native extent calculation
        var img;
        if (isRef) {
          img = new lively.data.FileUpload.EncryptedImage(
            pt(0, 0).extent(pt(0, 0)), url, opts,
          ).openInWorld();
          img._resolveAndDisplay(thenDo);
        } else {
          img = new lively.morphic.Image(
            pt(0, 0).extent(pt(0, 0)),
            url,
            opts,
            thenDo,
          ).openInWorld();
        }
        img.name = name;
        pos && img.setPosition(pos);
        return img;
      },
    });
  }); // end of module
