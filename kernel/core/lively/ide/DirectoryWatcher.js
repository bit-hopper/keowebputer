module("lively.ide.DirectoryWatcher")
  .requires("lively.Network")
  .toRun(function () {
    // depends on the DirectoryWatcherServer

    Object.extend(lively.ide.DirectoryWatcher, {
      watchServerURL: new URL(Config.nodeJSURL + "/DirectoryWatchServer/"),

      dirs: {},

      reset: function () {
        // lively.ide.DirectoryWatcher.reset()
        this.dirs = {};
        this.watchServerURL.withFilename("reset").asWebResource().post();
      },

      request: function (url, thenDo) {
        return url
          .asWebResource()
          .beAsync()
          .withJSONWhenDone(function (json, status) {
            thenDo(!json || json.error, json);
          })
          .get();
      },

      getFiles: function (dir, thenDo) {
        this.request(
          this.watchServerURL.withFilename("files").withQuery({ dir: dir }),
          thenDo,
        );
      },

      getChanges: function (dir, since, startWatchTime, thenDo) {
        this.request(
          this.watchServerURL.withFilename("changes").withQuery({
            startWatchTime: startWatchTime,
            since: since,
            dir: dir,
          }),
          thenDo,
        );
      },

      withFilesOfDir: function (dir, doFunc) {
        // Retrieves efficiently the files of dir. Uses a server side watcher that
        // sends infos about file changes, deletions, creations.
        // This methods synchs those with the cached state held in this object
        // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
        // dir = lively.shell.exec('pwd', {sync:true}).resultString()
        // lively.ide.DirectoryWatcher.dirs
        // lively.ide.DirectoryWatcher.withFilesOfDir(dir, function(files) { show(Object.keys(files).length); })
        // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
        // Ensure dir is a valid string
        if (!dir || typeof dir !== "string") {
          console.warn(
            "DirectoryWatcher.withFilesOfDir: Invalid directory:",
            dir,
          );
          doFunc && doFunc({});
          return;
        }
        var watchState =
          this.dirs[dir] ||
          (this.dirs[dir] = { updateInProgress: false, callbacks: [] });
        doFunc && watchState.callbacks.push(doFunc);
        if (watchState.updateInProgress) {
          return;
        }
        watchState.updateInProgress = true;

        // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

        if (!watchState.files) {
          // first time called
          this.getFiles(dir, function (err, result) {
            if (err) {
              show("dir watch error: %s", err);
              Object.extend(watchState, {
                files: {}, // Default to empty object on error
                lastUpdated: Date.now(),
                startTime: Date.now(),
              });
            } else if (result && result.files) {
              Properties.forEachOwn(result.files, function (path, stat) {
                extend(stat);
              });
              Object.extend(watchState, {
                files: result.files,
                lastUpdated: result.startTime,
                startTime: result.startTime,
              });
            } else {
              // Fallback if result is malformed
              Object.extend(watchState, {
                files: {},
                lastUpdated: Date.now(),
                startTime: Date.now(),
              });
            }
            whenDone();
          });
          return;
        }

        // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

        var timeSinceLastUpdate = Date.now() - (watchState.lastUpdated || 0);
        if (timeSinceLastUpdate < 10 * 1000) {
          whenDone();
        } // recently updated
        // get updates
        this.getChanges(
          dir,
          watchState.lastUpdated,
          watchState.startTime,
          function (err, result) {
            if (
              err ||
              !result ||
              !result.changes ||
              result.changes.length === 0
            ) {
              whenDone();
              return;
            }
            watchState.lastUpdated = result.changes[0].time;
            console.log(
              "%s files changed in %s: %s",
              result.changes.length,
              dir,
              result.changes.pluck("path").join("\n"),
            );
            result.changes.forEach(function (change) {
              switch (change.type) {
                case "removal":
                  delete watchState.files[change.path];
                  break;
                case "creation":
                case "change":
                  watchState.files[change.path] = extend(change.stat);
                  break;
              }
            });
            whenDone();
          },
        );

        // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

        function whenDone() {
          watchState.updateInProgress = false;
          // Ensure files is always an object before calling callbacks
          if (!watchState.files || typeof watchState.files !== "object") {
            watchState.files = {};
          }
          var cb;
          while ((cb = watchState.callbacks.shift())) {
            try {
              cb(watchState.files);
            } catch (e) {
              console.error("DirectoryWatcher callback error:", e);
            }
          }
        }

        function extend(statObj) {
          // convert date string into a date object
          if (!statObj) statObj = {};
          if (typeof statObj.mode === "undefined") {
            // Default mode for files
            statObj.mode = 0o100644; // Regular file with read permissions
          }
          statObj.isDirectory = !!(statObj.mode & 0x4000);
          ["atime", "mtime", "ctime"].forEach(function (field) {
            if (statObj[field]) {
              statObj[field] = new Date(statObj[field]);
            } else if (!statObj[field]) {
              // Provide default timestamp if missing
              statObj[field] = new Date();
            }
          });
          return statObj;
        }
      },
    });
  }); // end of module
