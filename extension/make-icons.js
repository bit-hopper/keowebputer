// Draws the toolbar and extension-page icons (extension/icons/keo-<size>.png): the runtime's mascot on a round light tile with a
// pink ring.
// Usage: node extension/make-icons.js
// The PNGs are committed, so a normal build needs none of this; run it only to redraw them (it uses the browser the tests use,
// to draw on a canvas, because the build must stay dependency-free). The tile is light because the mascot's dark hair edge
// disappears on a dark toolbar.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright-core'));
const SIZES = [16, 32, 48, 128];
const SRC = path.join(ROOT, 'kernel', 'core', 'media', 'face-masks', 'keo.png');
const OUT = path.join(__dirname, 'icons');

(async () => {
  const mask = 'data:image/png;base64,' + fs.readFileSync(SRC).toString('base64');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const drawn = await page.evaluate(async ([src, sizes]) => {
      const img = new Image(); img.src = src; await img.decode();
      return sizes.map((n) => {
        const c = document.createElement('canvas'); c.width = c.height = n;
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.fillStyle = '#e8e9ee'; g.beginPath(); g.arc(n / 2, n / 2, n / 2, 0, Math.PI * 2); g.fill();
        // The ring is the system theme's pink (the menu bar's), so the icon stands out on any toolbar; its width scales with the
        // icon but never drops below one and a half pixels, or it would vanish at 16.
        const ring = Math.max(1.5, n * 0.075);
        g.strokeStyle = '#f01a69'; g.lineWidth = ring; g.beginPath(); g.arc(n / 2, n / 2, n / 2 - ring / 2, 0, Math.PI * 2); g.stroke();
        // The mascot is tall and narrow: fit its height to most of the tile, centred.
        const h = n * 0.8, w = h * img.naturalWidth / img.naturalHeight;
        g.drawImage(img, (n - w) / 2, (n - h) / 2, w, h);
        return c.toDataURL('image/png').split(',')[1];
      });
    }, [mask, SIZES]);
    fs.mkdirSync(OUT, { recursive: true });
    SIZES.forEach((n, i) => fs.writeFileSync(path.join(OUT, 'keo-' + n + '.png'), Buffer.from(drawn[i], 'base64')));
    console.log('wrote ' + SIZES.map((n) => 'keo-' + n + '.png').join(', ') + ' to ' + OUT);
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
