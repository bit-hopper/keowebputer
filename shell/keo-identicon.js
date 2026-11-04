// The small square picture that stands for a DID, drawn the same way the runtime draws it (PostCardUtils.identiconDataUrl in
// the kernel), so the picture in the call panel is the one a person already knows from the menu bar and the connect dialog.
// This is a COPY of that routine (the shell cannot load the runtime's modules). The two must stay identical: the call test
// compares this one's output with the runtime's, so a change on either side shows up there.
(function () {
  'use strict';
  function identiconDataUrl(seedStr, sizePx) {
    var seed = (seedStr || '?').toLowerCase();
    var SZ = 8, SC = Math.ceil(sizePx / SZ);
    var rs = [0, 0, 0, 0];
    for (var i = 0; i < seed.length; i++) {
      rs[i % 4] = ((rs[i % 4] << 5) - rs[i % 4]) + seed.charCodeAt(i);
      rs[i % 4] |= 0;
    }
    function rnd() {
      var t = rs[0] ^ (rs[0] << 11);
      rs[0] = rs[1]; rs[1] = rs[2]; rs[2] = rs[3];
      rs[3] = (rs[3] ^ (rs[3] >> 19) ^ t ^ (t >> 8));
      return (rs[3] >>> 0) / ((1 << 31) >>> 0);
    }
    function hsl() {
      return 'hsl(' + Math.floor(rnd() * 360) + ',' + (rnd() * 60 + 40) + '%,' + ((rnd() + rnd() + rnd() + rnd()) * 25) + '%)';
    }
    var fg = hsl(), bg = hsl(), spot = hsl();
    var half = Math.ceil(SZ / 2);
    var cells = [];
    for (var r = 0; r < SZ; r++) {
      var row = [];
      for (var x = 0; x < half; x++) row.push(Math.floor(rnd() * 2.3));
      var mir = row.slice(0, SZ - half).reverse();
      cells.push(row.concat(mir));
    }
    var bc = document.createElement('canvas');
    bc.width = bc.height = SZ * SC;
    var bctx = bc.getContext('2d');
    cells.forEach(function (row, r) {
      row.forEach(function (v, col) {
        bctx.fillStyle = v === 1 ? fg : v === 2 ? spot : bg;
        bctx.fillRect(col * SC, r * SC, SC, SC);
      });
    });
    return bc.toDataURL();
  }
  window.keoIdenticon = { dataUrl: identiconDataUrl };
})();
