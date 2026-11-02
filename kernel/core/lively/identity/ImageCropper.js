/**
 * lively.identity.imageCropper
 *
 * Shared drag-to-reposition/scroll-to-zoom image cropper, extracted from
 * ProfileCard.js's own _openCropper (originally only reachable via
 * `win._openCropper(...)` on a ProfileCard window) so other dialogs — e.g.
 * ConstellationSettingsDialog.js — can crop+upload an avatar/banner without
 * duplicating this ~150-line canvas overlay.
 *
 * Usage: lively.identity.imageCropper.open(imageFile, onDone, opts)
 *   opts: { width, height, shape: 'circle'|'rect', title, subfolder (unused,
 *          kept for call-site compatibility), basename }
 *   onDone(url) is called once the cropped image has been uploaded.
 */

module("lively.identity.ImageCropper")
  .requires(
    "lively.identity.DID",
    "lively.identity.FileCrypto",
  )
  .toRun(function () {

    lively.identity.imageCropper = {
      open: function (imageFile, onDone, opts) {
        var user = lively.identity.did.currentUser();
        if (!user) { alert("Not logged in"); return; }
        opts = opts || {};

        var W         = opts.width     || 300;
        var H         = opts.height    || 300;
        var shape     = opts.shape     || 'circle';
        var title     = opts.title     || 'Crop Avatar';
        var basename  = opts.basename  || 'avatar';

        var state = { x: 0, y: 0, scale: 1 };
        var img   = new Image();

        var overlay = document.createElement('div');
        overlay.style.cssText =
          'position:fixed;top:0;left:0;width:100%;height:100%;' +
          'background:rgba(0,0,0,0.72);z-index:99999;' +
          'display:flex;align-items:center;justify-content:center;';

        var panel = document.createElement('div');
        panel.style.cssText =
          'background:#1e1e1e;border-radius:10px;padding:20px;' +
          'box-shadow:0 8px 32px rgba(0,0,0,0.6);';

        var titleEl = document.createElement('div');
        titleEl.textContent = title;
        titleEl.style.cssText =
          'color:#fff;font-size:14px;font-weight:bold;' +
          'text-align:center;margin-bottom:12px;font-family:sans-serif;';

        var canvas = document.createElement('canvas');
        canvas.width  = W;
        canvas.height = H;
        canvas.style.cssText = 'display:block;cursor:move;border-radius:4px;';

        var hint = document.createElement('div');
        hint.textContent = 'Drag to reposition  ·  Scroll to zoom';
        hint.style.cssText =
          'color:#888;font-size:10px;text-align:center;' +
          'margin-top:8px;font-family:sans-serif;';

        var btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:8px;margin-top:14px;';

        var saveBtn   = document.createElement('button');
        var cancelBtn = document.createElement('button');
        saveBtn.textContent   = 'Crop & Upload';
        cancelBtn.textContent = 'Cancel';
        var btnBase = 'flex:1;padding:9px 0;border:none;border-radius:4px;' +
                      'cursor:pointer;font-size:12px;font-family:sans-serif;';
        saveBtn.style.cssText   = btnBase + 'background:#f01a69;color:#fff;';
        cancelBtn.style.cssText = btnBase + 'background:#555;color:#fff;';

        panel.appendChild(titleEl);
        panel.appendChild(canvas);
        panel.appendChild(hint);
        panel.appendChild(btnRow);
        btnRow.appendChild(saveBtn);
        btnRow.appendChild(cancelBtn);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        var ctx = canvas.getContext('2d');

        function draw() {
          ctx.clearRect(0, 0, W, H);
          ctx.save();
          ctx.translate(state.x + W / 2, state.y + H / 2);
          ctx.scale(state.scale, state.scale);
          ctx.drawImage(img, -img.width / 2, -img.height / 2);
          ctx.restore();
          if (shape === 'circle') {
            var R = Math.min(W, H) / 2 - 4;
            ctx.save();
            ctx.fillStyle = 'rgba(0,0,0,0.52)';
            ctx.beginPath();
            ctx.rect(0, 0, W, H);
            ctx.arc(W / 2, H / 2, R, 0, Math.PI * 2, true);
            ctx.fill('evenodd');
            ctx.restore();
            ctx.save();
            ctx.strokeStyle = 'rgba(255,255,255,0.7)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(W / 2, H / 2, R, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
          } else {
            ctx.save();
            ctx.strokeStyle = 'rgba(255,255,255,0.7)';
            ctx.lineWidth = 2;
            ctx.strokeRect(4, 4, W - 8, H - 8);
            ctx.restore();
          }
        }

        img.onload = function () {
          state.scale = Math.max(W / img.width, H / img.height);
          draw();
        };
        img.src = URL.createObjectURL(imageFile);

        var dragging = false, lx = 0, ly = 0;
        canvas.addEventListener('mousedown', function (e) {
          dragging = true; lx = e.clientX; ly = e.clientY;
          e.preventDefault();
        });
        canvas.addEventListener('mousemove', function (e) {
          if (!dragging) return;
          state.x += e.clientX - lx; state.y += e.clientY - ly;
          lx = e.clientX; ly = e.clientY;
          draw();
        });
        canvas.addEventListener('mouseup',    function () { dragging = false; });
        canvas.addEventListener('mouseleave', function () { dragging = false; });
        canvas.addEventListener('wheel', function (e) {
          e.preventDefault();
          state.scale *= e.deltaY > 0 ? 0.9 : 1.1;
          state.scale  = Math.max(0.2, Math.min(10, state.scale));
          draw();
        }, { passive: false });

        function close() {
          document.body.removeChild(overlay);
          URL.revokeObjectURL(img.src);
        }

        cancelBtn.addEventListener('click', close);

        saveBtn.addEventListener('click', function () {
          var out  = document.createElement('canvas');
          out.width  = W;
          out.height = H;
          var octx = out.getContext('2d');
          octx.save();
          octx.translate(state.x + W / 2, state.y + H / 2);
          octx.scale(state.scale, state.scale);
          octx.drawImage(img, -img.width / 2, -img.height / 2);
          octx.restore();

          saveBtn.textContent = 'Uploading…';
          saveBtn.disabled    = true;

          out.toBlob(function (blob) {
            if (!blob) { saveBtn.textContent = 'Crop & Upload'; saveBtn.disabled = false; return; }
            var filename = basename + '-' + Date.now() + '.jpg';
            // Avatars/banners must stay anonymously <img src>-fetchable, so
            // visibility is explicitly 'public' here — never the encrypted
            // default (Encryption.md §5.5). The resulting blob URL
            // (/@handle/blobs/<cid>) is public-optionalAuth and served with
            // the real image mime, same as the old uploads/<subfolder> URL.
            lively.identity.fileCrypto.encryptAndUpload(blob, {
              visibility: 'public',
              name: filename,
            }, function (err, result) {
              if (err) {
                saveBtn.textContent = 'Crop & Upload';
                saveBtn.disabled    = false;
                alert('Upload error: ' + err.message);
                return;
              }
              close();
              // Prefer the server-computed, federation-safe canonical URL
              // (see IdentityServer.js's canonicalOrigin / PUBLIC_BASE_URL) —
              // location.origin-derived construction here would permanently
              // bake in whichever hostname alias happened to serve this page
              // at upload time.
              var base = lively.identity.did.baseUrl();
              onDone(result.url || (base + '/@' + user.handle + '/blobs/' + result.blobCid));
            });
          }, 'image/jpeg', 0.92);
        });
      },
    };

  });
