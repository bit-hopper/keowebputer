module("lively.identity.FaceEffects")
  .requires()
  .toRun(function () {

    // Face overlays (glasses, party hat, mustache, blush) for the outgoing camera
    // picture, opened from the Ambient Presence Panel's room block. Face tracking
    // is MediaPipe's Face Landmarker, vendored in core/lib/mediapipe/ (ESM bundle,
    // SIMD WASM engine and the float16 model; Apache-2.0) and loaded on first use.
    //
    // Video path (same shape as the soundboard's audio path): while at least one
    // effect is on, the raw camera track is played into a hidden <video>, each new
    // frame is run through the landmarker and drawn, with the overlays, onto a
    // canvas, and that canvas's captureStream track is what the room session sends
    // (it asks getOutgoingTrack() for which video track to send) and what the
    // self-view shows (getViewStream()). With no effect on, nothing here is in the
    // path and calls keep sending the raw camera track.
    //
    // Detection and drawing both use the UNMIRRORED frame, so the track peers get
    // has the right orientation. The self-view's mirror is display-only CSS on its
    // <video> (RoomView._fillWithLocalStream), which works unchanged on the canvas
    // stream. The pipeline belongs to the call session, not to the room window:
    // it has its own hidden <video> and survives the window closing.
    //
    // The raw camera track stays owned by AmbientPresencePanel (camera-off still
    // stops it and releases the device); rewire() follows it — the panel calls it
    // from _afterLocalTracksChanged — so turning the camera off pauses the loop
    // and turning it back on re-attaches the fresh track.
    //
    // Plain object with normal closures: nothing here is a BuildSpec or an
    // addScript'd handler.
    lively.identity.FaceEffects = {
      BASE: "/core/lib/mediapipe/",
      MASK_BASE: "/core/media/face-masks/",
      // Masks are PNGs with transparent eye holes, so the wearer's own eyes show
      // through. eyeMid/eyeDist are the eye-hole midpoint and spacing in the image's
      // own pixels; the mask is placed by lining those up with the real eyes.
      MASKS: {
        keomask: { file: "keo.png", eyeMid: { x: 74.05, y: 251.5 }, eyeDist: 64.3 },
      },
      EFFECTS: [
        { id: "keomask", label: "keo mask" },
        { id: "glasses",  label: "glasses" },
        { id: "hat",      label: "party hat" },
        { id: "mustache", label: "mustache" },
        { id: "blush",    label: "blush" },
      ],
      // Auto-disable when the average detect+draw time per frame stays above this
      // (ms), measured once BUDGET_FRAMES frames past the warm-up have been seen.
      BUDGET_MS: 55,
      BUDGET_FRAMES: 45,
      WARMUP_FRAMES: 5,

      _maskImages: {},        // effect id -> HTMLImageElement, once requested
      THREE_SRC: "/core/lib/jenga3d/jenga3d-deps.js",   // window.jenga3dDeps.THREE (shared with Jenga3D)
      // Shape of the 3D mask, in the mask image's own pixels. Over the face the
      // surface conforms to the wearer's real face: each mask point takes its depth
      // from the nearby face landmarks (inverse-distance weighting, softened by
      // depthSoft), then floats `margin` in front of the skin. Above the face (the
      // horns and hood) and past the chin there are no landmarks, so the depth of the
      // nearest face point carries on and curls away (vCurl over vCurlRange).
      // `conform` blends a smooth quadratic fit of the whole face's depth (0) with the
      // per-point landmark depth (1): the fit keeps the mask a clean shell, the landmark
      // part follows the nose and cheeks but amplifies MediaPipe's depth noise, which
      // is worst on strongly turned heads.
      MASK_SURFACE: { margin: 7, depthSoft: 11, conform: 0.15, symmetric: true, eyeLock: true, eyeSigma: 20, eyeMargin: 1.5, hornFlatten: 0.85, hornStart: 90, hornRange: 110, vCurl: 14, vCurlRange: 130, faceTop: -95, faceBottom: 108 },
      // Landmarks are smoothed over time for the 3D mask (fraction of the new frame
      // kept per update); a jump larger than resetJump (fraction of the eye distance)
      // is a new face or a fast move and restarts the smoothing.
      MASK_SMOOTH: { alpha: 0.55, resetJump: 0.6 },
      _three: null,           // { THREE, renderer, scene, camera, mesh, geo, mw, mh, w, h } once built
      _threePromise: null,
      _selected: {},          // effect id -> true
      _state: "idle",         // idle | loading | ready | error
      _notice: "",            // shown in the popover header (errors, auto-disable)
      _landmarker: null,
      _landmarkerPromise: null,

      _rawTrackId: null,
      _video: null,           // hidden <video> playing the raw camera track
      _canvas: null,
      _ctx: null,
      _canvasTrack: null,
      _viewStream: null,
      _timer: null,
      _lastVideoTime: -1,
      _lastTs: 0,
      _outputting: false,     // at least one frame has been drawn to the canvas
      _avgMs: 0,
      _frames: 0,

      _popover: null,
      _panelRef: null,
      _head: null,
      _chips: {},
      _closeHandlers: null,

      // ── queries used by the panel and the room session ──

      isActive: function () {
        return Object.keys(this._selected).length > 0;
      },

      // The video track the room session should send: the effect canvas once it is
      // producing frames, otherwise null (the caller falls back to the raw camera).
      getOutgoingTrack: function () {
        return this._outputting && this._canvasTrack && this._canvasTrack.readyState === "live"
          ? this._canvasTrack : null;
      },

      // The stream the self-view should show while effects are on, else null.
      getViewStream: function () {
        return this.getOutgoingTrack() ? this._viewStream : null;
      },

      // ── landmarker loading ──

      _ensureLandmarker: function () {
        var self = this;
        if (this._landmarker) return Promise.resolve(this._landmarker);
        if (this._landmarkerPromise) return this._landmarkerPromise;
        // Dynamic import via Function: this file goes through Lively's own JS
        // tooling, which predates import() syntax.
        var importer = new Function("u", "return import(u)");
        // MediaPipe's loader reads a global named Module as its Emscripten config
        // object and then overwrites it with undefined. Lively defines its own
        // Module class there, so hide it while the engine loads and put it back.
        var savedModule = window.Module;
        window.Module = undefined;
        function restoreModule() { window.Module = savedModule; }
        this._landmarkerPromise = importer(this.BASE + "vision_bundle.esm.js")
          .then(function (mp) {
            return mp.FilesetResolver.forVisionTasks(self.BASE + "wasm").then(function (fileset) {
              function create(delegate) {
                return mp.FaceLandmarker.createFromOptions(fileset, {
                  baseOptions: { modelAssetPath: self.BASE + "face_landmarker.task", delegate: delegate },
                  runningMode: "VIDEO",
                  numFaces: 1,
                });
              }
              return create("GPU").catch(function (err) {
                console.warn("[FaceEffects] GPU delegate unavailable, using CPU:", err && err.message);
                return create("CPU");
              });
            });
          })
          .then(function (lm) { restoreModule(); self._landmarker = lm; return lm; })
          .catch(function (err) { restoreModule(); self._landmarkerPromise = null; throw err; });
        return this._landmarkerPromise;
      },

      // ── 3D mask (Three.js) ──

      _ensureThree: function () {
        var self = this;
        if (this._three) return Promise.resolve(this._three);
        if (this._threePromise) return this._threePromise;
        this._threePromise = new Promise(function (resolve, reject) {
          if (window.jenga3dDeps && window.jenga3dDeps.THREE) return resolve(window.jenga3dDeps.THREE);
          var sc = document.createElement("script");
          sc.src = self.THREE_SRC;
          sc.onload = function () {
            if (window.jenga3dDeps && window.jenga3dDeps.THREE) resolve(window.jenga3dDeps.THREE);
            else reject(new Error("three.js missing from " + self.THREE_SRC));
          };
          sc.onerror = function () { reject(new Error("could not load " + self.THREE_SRC)); };
          document.head.appendChild(sc);
        }).then(function (THREE) {
          var img = self._maskImage("keomask");
          return (img.complete ? Promise.resolve() : img.decode()).then(function () {
            var geo = new THREE.PlaneGeometry(1, 1, 24, 56);
            var tex = new THREE.Texture(img);
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.anisotropy = 4;
            // Transparent pixels are black in the PNG; premultiplying keeps that black
            // from bleeding into the edges when the texture is filtered.
            tex.premultiplyAlpha = true;
            tex.needsUpdate = true;
            var mat = new THREE.MeshLambertMaterial({
              map: tex, side: THREE.DoubleSide, transparent: true, premultipliedAlpha: true, alphaTest: 0.02,
            });
            var mesh = new THREE.Mesh(geo, mat);
            mesh.frustumCulled = false;
            var scene = new THREE.Scene();
            scene.add(mesh);
            // Lights are physical in this three.js: ambient near PI leaves a facing
            // surface close to its texture colour; the directional light adds relief
            // when the surface turns.
            scene.add(new THREE.AmbientLight(0xffffff, Math.PI * 0.72));
            var sun = new THREE.DirectionalLight(0xffffff, Math.PI * 0.5);
            sun.position.set(-0.4, 0.6, 1);
            scene.add(sun);
            var renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, premultipliedAlpha: true });
            renderer.setClearColor(0x000000, 0);
            var camera = new THREE.OrthographicCamera(0, 1, 1, 0, -6000, 6000);
            camera.position.z = 3000;
            self._three = {
              THREE: THREE, renderer: renderer, scene: scene, mesh: mesh, geo: geo, camera: camera,
              mw: img.naturalWidth, mh: img.naturalHeight, w: 0, h: 0,
            };
            return self._three;
          });
        }).catch(function (err) {
          console.warn("[FaceEffects] 3D mask unavailable, using the flat mask:", err && err.message);
          self._threePromise = null;
          return null;
        });
        return this._threePromise;
      },

      // Renders the mask as a curved surface turned with the head, onto ctx.
      // Returns false when three.js isn't ready (the caller draws the flat mask).
      //
      // The head frame comes straight from the landmarks' own 3D positions (x, y in
      // pixels; z, which MediaPipe scales like x, times the width): x axis across
      // the cheeks and eyes, y axis forehead to chin, z = x cross y, all in the
      // image's y-down frame (z away from the camera). Three's camera is
      // orthographic in pixel space and the surface is mapped with (x, h-y, -z),
      // a proper rotation, so triangle winding and lighting stay correct.
      _drawMask3D: function (ctx, lm, w, h) {
        var t = this._three;
        if (!t) return false;
        var mk = this.MASKS.keomask, SF = this.MASK_SURFACE;
        // Smooth the landmarks over time (MediaPipe's depth jitters frame to frame).
        var nAll = lm.length, sm = this.MASK_SMOOTH;
        if (!t.prev || t.prev.length !== nAll * 3 || t.prevW !== w || t.prevH !== h) { t.prev = new Float32Array(nAll * 3); t.havePrev = false; t.prevW = w; t.prevH = h; }
        var eyeSpan = Math.hypot((lm[362].x - lm[133].x) * w, (lm[362].y - lm[133].y) * h) || 1;
        var jump = 0;
        if (t.havePrev) {
          jump = Math.hypot((lm[1].x * w - t.prev[3]), (lm[1].y * h - t.prev[4])) / eyeSpan;
        }
        var keep = (t.havePrev && jump < sm.resetJump) ? (1 - sm.alpha) : 0;
        for (var q0 = 0; q0 < nAll; q0++) {
          t.prev[q0 * 3]     = t.prev[q0 * 3]     * keep + lm[q0].x * w * (1 - keep);
          t.prev[q0 * 3 + 1] = t.prev[q0 * 3 + 1] * keep + lm[q0].y * h * (1 - keep);
          t.prev[q0 * 3 + 2] = t.prev[q0 * 3 + 2] * keep + lm[q0].z * w * (1 - keep);
        }
        t.havePrev = true;
        var prev = t.prev;
        function P(i) { return [prev[i * 3], prev[i * 3 + 1], prev[i * 3 + 2]]; }
        function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
        function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
        function mul(a, q) { return [a[0] * q, a[1] * q, a[2] * q]; }
        function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
        function len(a) { return Math.sqrt(dot(a, a)); }
        function norm(a) { var l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
        function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }

        var eA = mul(add(P(33), P(133)), 0.5), eB = mul(add(P(362), P(263)), 0.5);
        var eyeMid = mul(add(eA, eB), 0.5);
        var d3 = len(sub(eB, eA));
        var xAxis = norm(add(norm(sub(P(454), P(234))), norm(sub(eB, eA))));
        var yv = sub(P(152), P(10));
        var yAxis = norm(sub(yv, mul(xAxis, dot(yv, xAxis))));
        var zAxis = cross(xAxis, yAxis);
        var k = d3 / mk.eyeDist;

        if (t.w !== w || t.h !== h) {
          t.w = w; t.h = h;
          t.renderer.setSize(w, h, false);
          t.camera.right = w; t.camera.top = h;
          t.camera.updateProjectionMatrix();
        }
        // Landmarks in head-local mask units: x right, y down, z into the head (mask
        // pixels, so they compare directly with mask vertex positions).
        var nLm = lm.length, lx = t.lx || (t.lx = new Float32Array(nLm)),
            ly = t.ly || (t.ly = new Float32Array(nLm)), lz = t.lz || (t.lz = new Float32Array(nLm));
        for (var j = 0; j < nLm; j++) {
          var rel = sub(P(j), eyeMid);
          lx[j] = dot(rel, xAxis) / k; ly[j] = dot(rel, yAxis) / k; lz[j] = dot(rel, zAxis) / k;
        }
        var soft2 = SF.depthSoft * SF.depthSoft;
        // Least-squares quadratic fit  z = c0 + c1 u + c2 v + c3 u^2 + c4 v^2 + c5 u v  over the landmarks.
        var A = [], bv = [], r0, r1;
        for (r0 = 0; r0 < 6; r0++) { A.push([0, 0, 0, 0, 0, 0]); bv.push(0); }
        for (var m = 0; m < nLm; m++) {
          var mu = lx[m] / 60, mv = ly[m] / 100;
          var basis = [1, mu, mv, mu * mu, mv * mv, mu * mv];
          for (r0 = 0; r0 < 6; r0++) {
            bv[r0] += basis[r0] * lz[m];
            for (r1 = 0; r1 < 6; r1++) A[r0][r1] += basis[r0] * basis[r1];
          }
        }
        for (r0 = 0; r0 < 6; r0++) A[r0][r0] += 1e-3;
        // Gauss-Jordan
        for (var col = 0; col < 6; col++) {
          var piv = col;
          for (r0 = col + 1; r0 < 6; r0++) if (Math.abs(A[r0][col]) > Math.abs(A[piv][col])) piv = r0;
          var tmpRow = A[col]; A[col] = A[piv]; A[piv] = tmpRow;
          var tmpB = bv[col]; bv[col] = bv[piv]; bv[piv] = tmpB;
          for (r0 = 0; r0 < 6; r0++) {
            if (r0 === col) continue;
            var fct = A[r0][col] / A[col][col];
            for (r1 = col; r1 < 6; r1++) A[r0][r1] -= fct * A[col][r1];
            bv[r0] -= fct * bv[col];
          }
        }
        var cf = [];
        for (r0 = 0; r0 < 6; r0++) cf.push(bv[r0] / A[r0][r0]);
        // A face is left-right symmetric in its own frame, so a slope across the
        // width is only error in the head-frame estimate; keeping it would tilt the
        // whole mask surface (the far horn went edge-on) and grow at the horns.
        if (SF.symmetric) { cf[1] = 0; cf[5] = 0; }
        // Depth (toward the viewer, mask px, before the margin) of the smooth shell at
        // head-local (u, v): the quadratic fit blended with per-point landmark depth.
        function baseToward(u, v) {
          var sw = 0, sz = 0;
          for (var n = 0; n < nLm; n++) {
            var ddx = u - lx[n], ddy = v - ly[n];
            var q = ddx * ddx + ddy * ddy + soft2;
            var wgt = 1 / (q * q);
            sw += wgt; sz += wgt * lz[n];
          }
          var qu = u / 60, qv = Math.max(SF.faceTop, Math.min(SF.faceBottom, v)) / 100;
          // The mask wraps round the sides of the head like a shell, but the horns stick
          // up and away from it: above hornStart the width-wise curve fades toward
          // hornFlatten of the way to flat, so the far horn doesn't turn edge-on.
          var hf = 1 - SF.hornFlatten * Math.max(0, Math.min(1, (-v - SF.hornStart) / SF.hornRange));
          var quad = cf[0] + cf[1] * qu + cf[2] * qv + cf[3] * hf * qu * qu + cf[4] * qv * qv + cf[5] * qu * qv;
          return -(quad + SF.conform * (sz / sw - quad));
        }
        // Eye lock: the shell sits in front of the (recessed) eyes, so when the head
        // turns the holes slide off them. Near each hole, pull the surface to the real
        // eye's depth and shift the mask in-plane so the hole centre sits on the eye.
        var locks = [];
        if (SF.eyeLock) {
          [[[33, 133], -mk.eyeDist / 2, -0.5], [[362, 263], mk.eyeDist / 2, 0.5]].forEach(function (e) {
            var ex = (lx[e[0][0]] + lx[e[0][1]]) / 2, ey = (ly[e[0][0]] + ly[e[0][1]]) / 2, ez = (lz[e[0][0]] + lz[e[0][1]]) / 2;
            locks.push({ hx: e[1], hy: e[2], dx: ex - e[1], dy: ey - e[2], res: -ez - baseToward(ex, ey) });
          });
        }
        var sig2 = 2 * SF.eyeSigma * SF.eyeSigma;
        var pos = t.geo.attributes.position, uv = t.geo.attributes.uv;
        for (var i = 0; i < pos.count; i++) {
          var u = uv.getX(i) * t.mw - mk.eyeMid.x, v = (1 - uv.getY(i)) * t.mh - mk.eyeMid.y;
          var gsum = 0, du = 0, dv = 0, dres = 0;
          for (var e2 = 0; e2 < locks.length; e2++) {
            var L2 = locks[e2], g = Math.exp(-((u - L2.hx) * (u - L2.hx) + (v - L2.hy) * (v - L2.hy)) / sig2);
            gsum = Math.max(gsum, g); du += g * L2.dx; dv += g * L2.dy; dres += g * L2.res;
          }
          var uu = u + du, vv = v + dv;
          var toward = baseToward(uu, vv) + dres + SF.margin - (SF.margin - SF.eyeMargin) * gsum;
          // Beyond the face (horns and hood above it, the point below the chin) curl away.
          var over = v < SF.faceTop ? SF.faceTop - v : (v > SF.faceBottom ? v - SF.faceBottom : 0);
          var oc = over / SF.vCurlRange;
          toward -= SF.vCurl * oc * oc;
          // toward the viewer = smaller z in the image frame
          var wp = add(eyeMid, add(mul(xAxis, uu * k), add(mul(yAxis, vv * k), mul(zAxis, -toward * k))));
          pos.setXYZ(i, wp[0], h - wp[1], -wp[2]);
        }
        pos.needsUpdate = true;
        t.geo.computeVertexNormals();
        t.renderer.render(t.scene, t.camera);
        ctx.drawImage(t.renderer.domElement, 0, 0, w, h);
        return true;
      },

      // ── effect selection ──

      toggleEffect: function (id) {
        if (this._selected[id]) delete this._selected[id]; else this._selected[id] = true;
        this._notice = "";
        if (id === "keomask" && this._selected[id]) this._ensureThree();
        if (!this.isActive()) {
          this._stop(true);
          this._state = this._landmarker ? "ready" : "idle";
        } else if (!this._timer && this._state !== "loading") {
          this._start();
        }
        this._refreshUI();
      },

      _start: function () {
        var self = this;
        this._state = "loading";
        this._refreshUI();
        this._ensureLandmarker().then(function () {
          self._state = "ready";
          if (!self.isActive() || !self._room()) { self._refreshUI(); return; }
          self._attach();
          self._refreshUI();
        }).catch(function (err) {
          console.warn("[FaceEffects] could not load face tracking:", err && err.message);
          self._selected = {};
          self._state = "error";
          self._notice = "couldn't load face tracking";
          self._refreshUI();
        });
      },

      _room: function () {
        return lively.identity.AmbientPresencePanel._activeRoom;
      },

      _rawVideoTrack: function () {
        var stream = lively.identity.AmbientPresencePanel.getLocalStream();
        return stream ? (stream.getVideoTracks().filter(function (t) { return t.readyState === "live"; })[0] || null) : null;
      },

      // Points the pipeline at the current raw camera track (building the video and
      // canvas on first use). With no camera track it just idles until rewire().
      _attach: function () {
        var self = this;
        var raw = this._rawVideoTrack();
        if (!raw) { this._detachSource(); return; }
        if (this._timer && raw.id === this._rawTrackId) return;
        this._detachSource();
        this._rawTrackId = raw.id;
        var v = document.createElement("video");
        v.muted = true;
        v.playsInline = true;
        v.autoplay = true;
        // Not display:none — a hidden video can stop decoding frames.
        v.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;";
        v.srcObject = new MediaStream([raw]);
        document.body.appendChild(v);
        var p = v.play();
        if (p && p.catch) p.catch(function () {});
        this._video = v;
        this._lastVideoTime = -1;
        if (!this._canvas) {
          this._canvas = document.createElement("canvas");
          this._canvas.width = 640; this._canvas.height = 480;
          this._ctx = this._canvas.getContext("2d");
          this._canvasTrack = this._canvas.captureStream(30).getVideoTracks()[0];
          this._viewStream = new MediaStream([this._canvasTrack]);
        }
        this._avgMs = 0; this._frames = 0;
        this._timer = setInterval(function () { self._frame(); }, 1000 / 30);
      },

      _detachSource: function () {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        if (this._video) {
          try { this._video.pause(); this._video.srcObject = null; this._video.remove(); } catch (e) {}
          this._video = null;
        }
        this._rawTrackId = null;
        // The canvas track stays (a stable object across camera off/on), but it
        // must not be sent while there is no live source behind it.
        this._outputting = false;
      },

      // Full stop: drop the whole pipeline. notify = tell the room session so it
      // switches peers and the self-view back to the raw camera.
      _stop: function (notify) {
        var wasOutputting = this._outputting;
        this._detachSource();
        if (this._canvasTrack) { try { this._canvasTrack.stop(); } catch (e) {} }
        this._canvasTrack = null; this._viewStream = null; this._canvas = null; this._ctx = null;
        if (notify && wasOutputting) this._notifyRoom();
      },

      _notifyRoom: function () {
        try {
          var RV = lively.identity.RoomView;
          if (RV && RV.localTracksChanged) RV.localTracksChanged();
        } catch (e) { console.error("[FaceEffects] localTracksChanged failed:", e); }
      },

      // Called by the panel whenever a local track was added or removed (camera
      // toggled, device re-acquired): follow the raw camera track.
      rewire: function () {
        if (!this.isActive() || !this._landmarker) return;
        var had = this._outputting;
        this._attach();
        // Camera went away while effects were sending: the room session must
        // swap to its black track, so it needs the same nudge as any track change.
        if (had && !this._outputting) this._notifyRoom();
      },

      // ── per-frame work ──

      _frame: function () {
        var v = this._video, lm = this._landmarker, ctx = this._ctx;
        if (!v || !lm || !ctx || v.readyState < 2 || !v.videoWidth) return;
        if (v.currentTime === this._lastVideoTime) return;
        this._lastVideoTime = v.currentTime;
        var t0 = performance.now();
        var w = v.videoWidth, h = v.videoHeight;
        if (this._canvas.width !== w || this._canvas.height !== h) {
          this._canvas.width = w; this._canvas.height = h;
        }
        ctx.drawImage(v, 0, 0, w, h);
        // detectForVideo needs strictly increasing timestamps.
        var ts = Math.max(t0, this._lastTs + 1);
        this._lastTs = ts;
        var result = null;
        try { result = lm.detectForVideo(v, ts); } catch (e) { console.warn("[FaceEffects] detect failed:", e && e.message); }
        var face = result && result.faceLandmarks && result.faceLandmarks[0];
        if (face) this._draw(ctx, face, w, h);

        if (!this._outputting) { this._outputting = true; this._notifyRoom(); this._refreshUI(); }

        // Adaptive fallback: revert to the plain camera if this can't keep up.
        // The first frames include one-off engine warm-up (shader/graph setup can
        // take seconds), so they are left out of the average.
        var ms = performance.now() - t0;
        this._frames++;
        if (this._frames <= this.WARMUP_FRAMES) return;
        var measured = this._frames - this.WARMUP_FRAMES;
        this._avgMs = measured === 1 ? ms : this._avgMs * 0.9 + ms * 0.1;
        if (measured >= this.BUDGET_FRAMES && this._avgMs > this.BUDGET_MS) {
          console.warn("[FaceEffects] too slow (" + Math.round(this._avgMs) + " ms/frame); turning effects off");
          this._selected = {};
          this._notice = "too slow on this device — turned off";
          this._stop(true);
          this._state = "ready";
          this._refreshUI();
        }
      },

      _maskImage: function (id) {
        if (!this._maskImages[id]) {
          var img = new Image();
          img.src = this.MASK_BASE + this.MASKS[id].file;
          this._maskImages[id] = img;
        }
        return this._maskImages[id];
      },

      _draw: function (ctx, lm, w, h) {
        var S = this._selected;
        function P(i) { return { x: lm[i].x * w, y: lm[i].y * h }; }
        function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
        function dist(a, b) { return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)); }

        // Eye centres, image-left and image-right of the unmirrored frame.
        var eA = mid(P(33), P(133)), eB = mid(P(362), P(263));
        var d = dist(eA, eB);
        var roll = Math.atan2(eB.y - eA.y, eB.x - eA.x);
        var eyeMid = mid(eA, eB);

        if (S.blush) {
          [P(205), P(425)].forEach(function (c) {
            var r = d * 0.34;
            var g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
            g.addColorStop(0, "rgba(255,80,130,0.55)");
            g.addColorStop(1, "rgba(255,80,130,0)");
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.fill();
          });
        }

        if (S.keomask && !this._drawMask3D(ctx, lm, w, h)) {
          // Flat fallback (three.js still loading or unavailable).
          var mk = this.MASKS.keomask, img = this._maskImage("keomask");
          if (img && img.complete && img.naturalWidth) {
            // Head turn: the nose slides along the eye axis as the head yaws, so use
            // its offset to narrow the mask (a flat mask can't rotate, only squash).
            var nose = P(1), ax = Math.cos(roll), ay = Math.sin(roll);
            var off = ((nose.x - eyeMid.x) * ax + (nose.y - eyeMid.y) * ay) / d;
            var sinYaw = Math.max(-0.85, Math.min(0.85, off / 0.55));
            var sx = Math.sqrt(1 - sinYaw * sinYaw);
            var k = d / mk.eyeDist;
            ctx.save();
            ctx.translate(eyeMid.x, eyeMid.y); ctx.rotate(roll);
            ctx.scale(k * sx, k);
            ctx.drawImage(img, -mk.eyeMid.x, -mk.eyeMid.y);
            ctx.restore();
          }
        }

        if (S.mustache) {
          var c = mid(P(164), P(0));
          var mw = dist(P(61), P(291));
          ctx.save();
          ctx.translate(c.x, c.y); ctx.rotate(roll);
          var s = mw * 0.62;
          ctx.fillStyle = "#3a2417";
          [-1, 1].forEach(function (side) {
            ctx.beginPath();
            ctx.moveTo(0, -0.05 * s);
            ctx.bezierCurveTo(side * 0.35 * s, -0.30 * s, side * 0.85 * s, -0.22 * s, side * 1.05 * s, 0.12 * s);
            ctx.bezierCurveTo(side * 0.80 * s, 0.02 * s, side * 0.45 * s, 0.10 * s, 0, 0.16 * s);
            ctx.closePath();
            ctx.fill();
          });
          ctx.restore();
        }

        if (S.glasses) {
          ctx.save();
          ctx.translate(eyeMid.x, eyeMid.y); ctx.rotate(roll);
          var lw = d * 0.66, lh = d * 0.52, lr = d * 0.16;
          ctx.lineWidth = d * 0.07;
          ctx.strokeStyle = "#141414";
          ctx.fillStyle = "rgba(232,73,126,0.28)";
          [-d / 2, d / 2].forEach(function (cx) {
            ctx.beginPath();
            ctx.moveTo(cx - lw / 2 + lr, -lh / 2);
            ctx.arcTo(cx + lw / 2, -lh / 2, cx + lw / 2, lh / 2, lr);
            ctx.arcTo(cx + lw / 2, lh / 2, cx - lw / 2, lh / 2, lr);
            ctx.arcTo(cx - lw / 2, lh / 2, cx - lw / 2, -lh / 2, lr);
            ctx.arcTo(cx - lw / 2, -lh / 2, cx + lw / 2, -lh / 2, lr);
            ctx.closePath();
            ctx.fill(); ctx.stroke();
          });
          ctx.beginPath();
          ctx.moveTo(-d / 2 + lw / 2, -lh * 0.1);
          ctx.quadraticCurveTo(0, -lh * 0.35, d / 2 - lw / 2, -lh * 0.1);
          ctx.stroke();
          ctx.restore();
        }

        if (S.hat) {
          var top = P(10), chin = P(152);
          var faceH = dist(top, chin), fw = dist(P(234), P(454));
          var ux = (top.x - chin.x) / faceH, uy = (top.y - chin.y) / faceH;
          var base = { x: top.x - ux * faceH * 0.06, y: top.y - uy * faceH * 0.06 };
          ctx.save();
          ctx.translate(base.x, base.y);
          ctx.rotate(Math.atan2(ux, -uy));
          var bw = fw * 0.34, hh = fw * 1.0;
          var g = ctx.createLinearGradient(-bw, 0, bw, 0);
          g.addColorStop(0, "#e8497e"); g.addColorStop(0.5, "#ff7fa8"); g.addColorStop(1, "#c93468");
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.moveTo(-bw, 0); ctx.lineTo(0, -hh); ctx.lineTo(bw, 0); ctx.closePath(); ctx.fill();
          ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = fw * 0.03;
          [0.3, 0.55, 0.78].forEach(function (f) {
            var half = bw * (1 - f);
            ctx.beginPath(); ctx.moveTo(-half, -hh * f); ctx.lineTo(half, -hh * f); ctx.stroke();
          });
          ctx.fillStyle = "#fff";
          ctx.beginPath(); ctx.arc(0, -hh, fw * 0.065, 0, Math.PI * 2); ctx.fill();
          ctx.restore();
        }
      },

      // Call ended: drop the pipeline and the selection. The loaded landmarker
      // stays cached for the next call.
      teardown: function () {
        this.close();
        this._selected = {};
        this._notice = "";
        this._stop(false);
        this._state = this._landmarker ? "ready" : "idle";
      },

      // ── popover ──

      toggle: function (panel) {
        if (this._popover) this.close(); else this.open(panel);
      },

      _headText: function () {
        if (this._notice) return this._notice;
        if (this._state === "loading") return "Loading face tracking…";
        return "Face effects";
      },

      _refreshUI: function () {
        var NS = lively.identity.AmbientPresencePanel;
        var self = this;
        if (this._head) this._head.textString = this._headText();
        Object.keys(this._chips).forEach(function (id) {
          try { self._chips[id].applyStyle({ fill: self._chipFill(id) }); } catch (e) {}
        });
        if (NS && NS.refreshControls) NS.refreshControls();
      },

      _chipFill: function (id) {
        return this._selected[id] ? Color.rgba(232, 73, 126, 0.45) : Color.rgba(255, 255, 255, 0.06);
      },

      open: function (panel) {
        var self = this;
        var NS = lively.identity.AmbientPresencePanel;
        if (this._popover || !panel || !panel.world()) return;

        var PAD = 12, GAP = 8, COLS = 2, BTN_H = 36, HEAD_H = 26;
        var W = NS.PANEL_W;
        var BTN_W = (W - 2 * PAD - (COLS - 1) * GAP) / COLS;
        var rows = Math.ceil(this.EFFECTS.length / COLS);
        var H = PAD + HEAD_H + rows * BTN_H + (rows - 1) * GAP + PAD;

        var pos = panel.getPosition();
        var box = new lively.morphic.Box(lively.rect(pos.x, pos.y - H - 8, W, H));
        box.isEpiMorph = true;
        box.applyStyle({ fill: Color.black, borderRadius: 12, borderWidth: 3, borderColor: Color.rgb(232, 73, 126) });
        box.draggingEnabled = false; box.droppingEnabled = false; box.grabbingEnabled = false;
        box.name = "FaceEffectsPopover";

        var head = new lively.morphic.Text(lively.rect(PAD, 8, W - 2 * PAD, 18));
        head.textString = this._headText();
        head.applyStyle({
          fontSize: 9, fontWeight: "bold", textColor: NS.TEXT_SECONDARY, fill: null, borderWidth: 0,
          allowInput: false, selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre",
        });
        head.eventsAreIgnored = true;
        box.addMorph(head);
        this._head = head;
        this._chips = {};

        this.EFFECTS.forEach(function (e, i) {
          var col = i % COLS, row = Math.floor(i / COLS);
          var b = new lively.morphic.Text(lively.rect(
            PAD + col * (BTN_W + GAP), PAD + HEAD_H + row * (BTN_H + GAP), BTN_W, BTN_H));
          b.textString = e.label;
          b.applyStyle({
            fontSize: 9, fontWeight: "600", textColor: NS.TEXT_PRIMARY,
            fill: self._chipFill(e.id), borderRadius: 8, borderWidth: 0, align: "center",
            padding: lively.Rectangle.inset(0, 10, 0, 0),
            allowInput: false, selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre",
            handStyle: "pointer",
          });
          b.draggingEnabled = false; b.droppingEnabled = false; b.grabbingEnabled = false;
          b.onMouseOver = function () { b.applyStyle({ fill: NS.HOVER_BG }); };
          b.onMouseOut = function () { b.applyStyle({ fill: self._chipFill(e.id) }); };
          b.onMouseUp = function (evt) {
            self.toggleEffect(e.id);
            evt.stop();
            return true;
          };
          self._chips[e.id] = b;
          box.addMorph(b);
        });

        $world.addMorph(box);
        box.enableFixedPositioning();
        this._popover = box;
        this._panelRef = panel;

        // Click outside or Escape closes it. The panel's own button is excluded so
        // its click toggles instead of close-then-reopen.
        var onDown = function (e) {
          var node = box.renderContext().shapeNode;
          var btn = panel._faceBtn && panel._faceBtn.renderContext().shapeNode;
          if (node.contains(e.target) || (btn && btn.contains(e.target))) return;
          self.close();
        };
        var onKey = function (e) { if (e.key === "Escape") self.close(); };
        document.addEventListener("mousedown", onDown, true);
        document.addEventListener("keydown", onKey, true);
        this._closeHandlers = { onDown: onDown, onKey: onKey };
      },

      close: function () {
        if (this._closeHandlers) {
          document.removeEventListener("mousedown", this._closeHandlers.onDown, true);
          document.removeEventListener("keydown", this._closeHandlers.onKey, true);
          this._closeHandlers = null;
        }
        if (this._popover) { try { this._popover.remove(); } catch (e) {} this._popover = null; }
        this._head = null; this._chips = {}; this._panelRef = null;
      },
    };

  }); // end module('lively.identity.FaceEffects')
