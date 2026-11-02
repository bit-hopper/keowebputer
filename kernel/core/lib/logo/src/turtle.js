// The turtle: its state, the draw operations it emits, and the graphics primitives (LOGO.md 6, Phase 2 item 1).
//
// This file has no DOM and no canvas. Moving the turtle produces plain-data draw operations that the Worker posts to the
// page, which draws them (LOGO.md decision 8). The engine keeps the turtle's state only; it keeps no picture.
//
// Coordinates. Turtle coordinates are the logical ones a program sees (POS, XCOR, SETXY ...): the origin is the centre of
// the window, +x right, +y up, headings are degrees clockwise from +y (LOGO.md decision 5). SETSCRUNCH does not change
// them (recorded: `setscrunch 2 1`, heading 45, `fd 100` still reports 70.710678 70.710678), it only stretches the
// picture. So every draw operation carries SCREEN-SPACE coordinates, the turtle coordinate times the scrunch in force when
// it was drawn, and a line drawn before a later SETSCRUNCH keeps its old shape. Screen space is the same units, y up; the
// page flips y when it paints.
//
// The window. Decision 16: a square of logical half-size HALF (250), and WRAP / FENCE are measured against it, in screen
// space (so a scrunch of 2 halves the turtle-coordinate range in x). The reference's own window is a different, larger
// rectangle (11.5 item 8 / 6.2) and its edge arithmetic has pixel-rounding quirks (a wrap landing 1 off, a 259/-260
// asymmetry): none of that is reproduced. What is reproduced is the shape of the rule, checked against the GUI build
// (tests/logo/seed/turtle-fence-gui, turtle-pen-gui):
//   WRAP    the plane is a torus; a move that leaves the window is split at the edge and continues from the opposite edge;
//           landing exactly on the edge stays there.
//   FENCE   a RELATIVE move (FD, BK) goes as far as the edge, draws that far, then raises error 3 "turtle out of bounds";
//           an ABSOLUTE move (SETPOS, SETXY, SETX, SETY, HOME) whose target is outside raises the error and does not move.
//   WINDOW  no limit.
//
// Colours. A colour is a palette slot (a non-negative integer) or an RGB triple. A triple is given as three percentages
// (0..100) but the reference keeps 8 bits per channel and prints a colour back as byte * 25600 / 65535 percent, so
// `palette 4` is `99.6108949416342 0 0` and `setpc [10 20 30]` reads back as `9.76577401388571 19.9221789883268
// 29.6879530022126` (byte = floor(percent * 65535 / 100 / 256)). The same quantising is done here so what a program reads
// back matches. Draw operations carry resolved [r g b] bytes, never a slot, so a later SETPALETTE cannot recolour an
// old line; the page's light-paper toggle swaps pure black and pure white.
//
// Do NOT put anything that needs the interpreter's machine in this file except the primitives at the bottom, and do not
// read `performance`, `document` or `self` here.

import { isList, listFromArray, listToArray, numberValue, isWord, wordText, NIL } from './data.js';
import { err } from './errors.js';
import { showForm, printText } from './printer.js';
import { num, int, bool } from './prims.js';
import { CBFrame, PENDING, NO, VALUE } from './machine.js';

// The 16 initial palette slots as byte triples (LOGO.md 6.1; 0-7 are fixed by the manual, 8-15 were read back from the
// reference with `palette n` and converted to bytes).
const DEFAULT_PALETTE = [
  [0, 0, 0], [0, 0, 255], [0, 255, 0], [0, 255, 255], [255, 0, 0], [255, 0, 255], [255, 255, 0], [255, 255, 255],
  [155, 96, 59], [197, 136, 18], [100, 162, 64], [120, 187, 187], [255, 149, 119], [144, 113, 208], [255, 163, 0],
  [183, 183, 183],
];

// Half-size of the default square window (decision 16).
export const DEFAULT_HALF = 250;
// A cap on recorded operations per workspace between CLEARs (LOGO.md 6.3): a POLY with 100000 sides must not flood the
// page. Past it the turtle still moves, nothing more is drawn, and the Job says so once.
export const MAX_OPS = 500000;
// A move that wraps more times than this is not drawn piece by piece (`fd 1e9` in wrap mode); the final position is still
// exact (computed by reduction).
const MAX_WRAP_PIECES = 2000;

// sin and cos of a heading in degrees. The right angles are exact, so `fd 100 rt 90` ends at 100 0 and not at
// 100 6.12e-15; every other angle is the library's value.
function sinCos(h) {
  if (h === 0) return [0, 1];
  if (h === 90) return [1, 0];
  if (h === 180) return [0, -1];
  if (h === 270) return [-1, 0];
  const r = h * Math.PI / 180;
  return [Math.sin(r), Math.cos(r)];
}

// A heading folded into [0, 360). Never returns -0.
const normHeading = (h) => { const r = ((h % 360) + 360) % 360; return r === 0 ? 0 : r; };

// A percentage (0..100, the SETPC list form) as the 8-bit value the reference stores. Out-of-range values are clamped.
const percentToByte = (p) => Math.max(0, Math.min(255, Math.floor(p * 65535 / 100 / 256)));
// A stored byte as the percentage the reference prints.
const byteToPercent = (b) => b * 25600 / 65535;

export class Turtle {
  // opts: {half: half-size of the square window in logical units (default 250)}
  constructor(opts = {}) {
    this.halfW = opts.half || DEFAULT_HALF;
    this.halfH = opts.half || DEFAULT_HALF;
    this.pending = [];          // operations emitted since the last drain()
    this.opCount = 0;           // operations recorded since the last clear (for the cap)
    this.capped = false;        // the cap was hit since the notice was last taken
    this.capNoticed = false;
    this.dirty = true;          // the turtle's own state changed since the last drain()
    this.filling = null;        // while FILLED runs: {pts, frame, start}
    this.palette = new Map();   // slot (>= 8, or any slot SETPALETTE set) -> [r g b] bytes; the first 16 live in DEFAULT_PALETTE
    this.x = 0; this.y = 0; this.heading = 0;
    this.penDown = true;
    this.penMode = 'paint';
    this.penSize = [1, 1];
    this.penColor = { slot: 7, rgb: null };       // {slot} or {slot: null, rgb: [r g b]} for a colour given as a list
    this.background = { slot: 0, rgb: null };
    this.shown = true;
    this.shape = 'triangle';
    this.mode = 'wrap';
    this.scrunch = [1, 1];
    this.labelHeight = 17;
    this.screenMode = 'textscreen';
  }

  // ---- operations ---------------------------------------------------------------------------------------------------

  // Records one draw operation (plain data). Past MAX_OPS it is dropped and the cap flag is raised. Drawing something
  // moves a text-only screen to the split one, as the reference does (recorded: SCREENMODE reads SPLITSCREEN once a
  // background colour has been set, TEXTSCREEN before any picture).
  emit(op) {
    if (this.screenMode === 'textscreen') this.screenMode = 'splitscreen';
    if (this.opCount >= MAX_OPS) { this.capped = true; return; }
    this.opCount++;
    this.pending.push(op);
  }

  // Takes the operations emitted since the last call (and the turtle's own state if it changed). Called once per Job slice.
  drain() {
    const ops = this.pending;
    this.pending = [];
    const state = this.dirty ? this.snapshot() : null;
    this.dirty = false;
    return { ops, turtle: state };
  }

  // True once, the first time it is asked after the cap was hit; the Job turns it into a status line.
  takeCapNotice() {
    if (this.capped && !this.capNoticed) { this.capNoticed = true; return true; }
    return false;
  }

  // The turtle as the page draws it: screen-space position, heading, visibility, shape and pen.
  snapshot() {
    return {
      x: this.x * this.scrunch[0], y: this.y * this.scrunch[1], heading: this.heading, shown: this.shown,
      shape: this.shape, penDown: this.penDown, color: this.penRGB(), size: this.penSize[0],
      half: [this.halfW, this.halfH],
    };
  }

  // ---- colours ------------------------------------------------------------------------------------------------------

  // The [r g b] bytes of a palette slot. A slot nobody set repeats the 16 defaults (the reference answers `palette 100`
  // with palette 4's colour).
  slotRGB(slot) {
    const set = this.palette.get(slot);
    if (set !== undefined) return set;
    return DEFAULT_PALETTE[slot % 16];
  }

  // The bytes of a stored colour ({slot, rgb}).
  rgbOf(c) { return c.rgb !== null ? c.rgb : this.slotRGB(c.slot); }
  penRGB() { return this.rgbOf(this.penColor); }

  // What PENCOLOR / BACKGROUND print: the slot number, or the percent list the colour was set with.
  colorValue(c) { return c.rgb !== null ? listFromArray(c.rgb.map(byteToPercent)) : c.slot; }

  // ---- window -------------------------------------------------------------------------------------------------------

  // The half-extent of the window in TURTLE coordinates (the scrunch stretches the picture, so a stretched axis reaches
  // the edge sooner). A zero scrunch means the axis has no extent: no limit is applied on it.
  limits() {
    const [sx, sy] = this.scrunch;
    return [sx > 0 ? this.halfW / sx : Infinity, sy > 0 ? this.halfH / sy : Infinity];
  }

  // ---- motion -------------------------------------------------------------------------------------------------------

  sx(x) { return x * this.scrunch[0]; }
  sy(y) { return y * this.scrunch[1]; }

  // Draws the straight piece (x0,y0) -> (x1,y1), in turtle coordinates, with the pen as it is now. Does nothing with the
  // pen up or for a zero-length piece. Never moves the turtle.
  line(x0, y0, x1, y1) {
    if (!this.penDown || (x0 === x1 && y0 === y1)) return;
    this.emit({ op: 'line', x1: this.sx(x0), y1: this.sy(y0), x2: this.sx(x1), y2: this.sy(y1), c: this.penRGB(), w: this.penSize[0], m: this.penMode });
  }

  // Records the turtle's new position for FILLED, when one is running.
  noteVertex() {
    if (this.filling !== null) this.filling.pts.push([this.sx(this.x), this.sy(this.y)]);
  }

  // The first point at which the straight move (x0,y0) -> (x1,y1) leaves [-W,W] x [-H,H], as {t, ax, ay} (t in [0,1];
  // ax / ay are -1, 0 or 1: the direction in which it leaves on each axis), or null when the whole move stays inside.
  // A move that ends exactly on the edge has not left.
  exit(x0, y0, x1, y1, W, H) {
    const dx = x1 - x0, dy = y1 - y0;
    let tx = Infinity, ty = Infinity, ax = 0, ay = 0;
    if (dx > 0 && x1 > W) { tx = (W - x0) / dx; ax = 1; } else if (dx < 0 && x1 < -W) { tx = (-W - x0) / dx; ax = -1; }
    if (dy > 0 && y1 > H) { ty = (H - y0) / dy; ay = 1; } else if (dy < 0 && y1 < -H) { ty = (-H - y0) / dy; ay = -1; }
    if (tx === Infinity && ty === Infinity) return null;
    const t = Math.max(0, Math.min(tx, ty));
    // Both axes at once when they leave at the same instant (a corner).
    return { t, ax: tx <= ty ? ax : 0, ay: ty <= tx ? ay : 0 };
  }

  // Moves the turtle to (nx, ny) in the current mode, drawing as the pen says. `relative` is true for FD / BK (a fence
  // lets those go as far as the edge before the error) and false for the absolute moves.
  travel(nx, ny, relative) {
    this.dirty = true;
    const [W, H] = this.limits();
    if (this.mode === 'window') {
      this.line(this.x, this.y, nx, ny);
      this.x = nx; this.y = ny;
      this.noteVertex();
      return;
    }
    if (this.mode === 'fence') {
      const inside = (x, y) => Math.abs(x) <= W && Math.abs(y) <= H;
      if (inside(nx, ny)) {
        this.line(this.x, this.y, nx, ny);
        this.x = nx; this.y = ny;
        this.noteVertex();
        return;
      }
      if (relative && inside(this.x, this.y)) {
        const e = this.exit(this.x, this.y, nx, ny, W, H);
        const cx = e.ax !== 0 ? e.ax * W : this.x + e.t * (nx - this.x);
        const cy = e.ay !== 0 ? e.ay * H : this.y + e.t * (ny - this.y);
        this.line(this.x, this.y, cx, cy);
        this.x = cx; this.y = cy;
        this.noteVertex();
      }
      throw err.outOfBounds();
    }
    this.wrapTravel(nx, ny, W, H);
    this.noteVertex();
  }

  // WRAP: draws and moves the turtle along the straight move to (nx, ny), jumping to the opposite edge each time it leaves
  // the window. The final position is always inside [-W,W] x [-H,H].
  wrapTravel(nx, ny, W, H) {
    let x0 = this.x, y0 = this.y, x1 = nx, y1 = ny;
    // A turtle that is off the window (it was there before WRAP was chosen) is brought back first, silently.
    const bring = (v, L) => {
      if (!(Math.abs(v) > L) || L === Infinity) return 0;
      return -Math.round(v / (2 * L)) * 2 * L;
    };
    const bx = bring(x0, W), by = bring(y0, H);
    x0 += bx; x1 += bx; y0 += by; y1 += by;
    for (let piece = 0; piece < MAX_WRAP_PIECES; piece++) {
      const e = this.exit(x0, y0, x1, y1, W, H);
      if (e === null) {
        this.line(x0, y0, x1, y1);
        this.x = x1; this.y = y1;
        return;
      }
      const dx = x1 - x0, dy = y1 - y0;
      const cx = e.ax !== 0 ? e.ax * W : x0 + e.t * dx;
      const cy = e.ay !== 0 ? e.ay * H : y0 + e.t * dy;
      this.line(x0, y0, cx, cy);
      const shiftX = e.ax !== 0 ? -e.ax * 2 * W : 0;
      const shiftY = e.ay !== 0 ? -e.ay * 2 * H : 0;
      x0 = cx + shiftX; y0 = cy + shiftY; x1 += shiftX; y1 += shiftY;
    }
    // Too many pieces to draw: the final position by reduction into the window (a point on the high edge stays there).
    const fold = (v, L) => {
      if (L === Infinity) return v;
      const period = 2 * L;
      let r = ((v + L) % period + period) % period - L;
      if (r === -L && v > 0) r = L;
      return r;
    };
    this.x = fold(x1, W); this.y = fold(y1, H);
  }

  // FD / BK. `dist` is in turtle steps.
  forward(dist) {
    const [s, c] = sinCos(this.heading);
    this.travel(this.x + dist * s, this.y + dist * c, true);
  }

  // SETPOS, SETXY, SETX, SETY: absolute.
  moveTo(nx, ny) { this.travel(nx, ny, false); }

  turn(deg) { this.heading = normHeading(this.heading + deg); this.dirty = true; }
  setHeading(deg) { this.heading = normHeading(deg); this.dirty = true; }

  // HOME: draws to the origin if the pen is down (as SETPOS [0 0] does), then faces up.
  goHome() { this.travel(0, 0, false); this.setHeading(0); }

  // CLEARSCREEN: to the origin and up WITHOUT drawing, and erase the picture.
  clearScreen() { this.clean(); this.x = 0; this.y = 0; this.heading = 0; this.dirty = true; }

  // CLEAN: erase the picture; the turtle's state is untouched. Operations not yet posted stay in the queue ahead of the
  // clear (dropping them could lose a background change the page still has to hear about).
  clean() {
    this.opCount = 0;
    this.capped = false; this.capNoticed = false;
    this.pending.push({ op: 'clear' });
  }

  // The heading from the turtle to (x, y), as TOWARDS answers it.
  towards(x, y) {
    const dx = x - this.x, dy = y - this.y;
    if (dx === 0 && dy === 0) return 0;
    return normHeading(Math.atan2(dx, dy) * 180 / Math.PI);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Argument helpers (each throws the reference's "<name> doesn't like <value> as input").

// A list of exactly two numbers -> [x, y].
function posArg(x, who) {
  if (isList(x) && x !== NIL) {
    const a = listToArray(x);
    if (a.length === 2) {
      const px = numberValue(a[0]), py = numberValue(a[1]);
      if (px !== null && py !== null) return [px, py];
    }
  }
  throw err.badType(who, showForm(x));
}

// A colour input: a non-negative integer slot, or a list of three numbers (percentages). Returns {slot, rgb}.
function colorArg(x, who) {
  if (isList(x)) {
    const a = listToArray(x);
    if (x !== NIL && a.length === 3) {
      const v = a.map(numberValue);
      if (v.every((n) => n !== null)) return { slot: null, rgb: v.map(percentToByte) };
    }
    throw err.badType(who, showForm(x));
  }
  const n = numberValue(x);
  if (n === null || !Number.isInteger(n) || n < 0) throw err.badType(who, showForm(x));
  return { slot: n, rgb: null };
}

// The bytes of three percentages, for SETPALETTE.
function rgbArg(x, who) {
  const c = colorArg(x, who);
  if (c.rgb === null) throw err.badType(who, showForm(x));
  return c.rgb;
}

const percentList = (rgb) => listFromArray(rgb.map(byteToPercent));
const pairList = (a, b) => listFromArray([a, b]);

// ---------------------------------------------------------------------------------------------------------------------

export function install(P) {
  const T = (m) => m.interp.turtle;

  // ---- motion -------------------------------------------------------------------------------------------------------
  P.fn('forward fd', 1, (a, m) => { T(m).forward(num(a[0], 'fd')); });
  P.fn('back bk', 1, (a, m) => { T(m).forward(-num(a[0], 'bk')); });
  P.fn('left lt', 1, (a, m) => { T(m).turn(-num(a[0], 'lt')); });
  P.fn('right rt', 1, (a, m) => { T(m).turn(num(a[0], 'rt')); });
  P.fn('setpos', 1, (a, m) => { const [x, y] = posArg(a[0], 'setpos'); T(m).moveTo(x, y); });
  P.fn('setxy', 2, (a, m) => { T(m).moveTo(num(a[0], 'setxy'), num(a[1], 'setxy')); });
  P.fn('setx', 1, (a, m) => { const t = T(m); t.moveTo(num(a[0], 'setx'), t.y); });
  P.fn('sety', 1, (a, m) => { const t = T(m); t.moveTo(t.x, num(a[0], 'sety')); });
  P.fn('setheading seth', 1, (a, m) => { T(m).setHeading(num(a[0], 'setheading')); });
  P.fn('home', 0, (a, m) => { T(m).goHome(); });
  // ARC angle radius: an arc of a circle centred on the turtle, from its heading clockwise through `angle`. The turtle
  // does not move and its heading does not change.
  P.fn('arc', 2, (a, m) => {
    const t = T(m);
    const angle = num(a[0], 'arc'), r = num(a[1], 'arc');
    if (!t.penDown) return;
    t.emit({
      op: 'arc', x: t.sx(t.x), y: t.sy(t.y), rx: Math.abs(r) * t.scrunch[0], ry: Math.abs(r) * t.scrunch[1],
      heading: t.heading, angle, c: t.penRGB(), w: t.penSize[0], m: t.penMode,
    });
  });

  // ---- queries ------------------------------------------------------------------------------------------------------
  P.fn('pos', 0, (a, m) => { const t = T(m); return pairList(t.x, t.y); });
  P.fn('xcor', 0, (a, m) => T(m).x);
  P.fn('ycor', 0, (a, m) => T(m).y);
  P.fn('heading', 0, (a, m) => T(m).heading);
  P.fn('towards', 1, (a, m) => { const [x, y] = posArg(a[0], 'towards'); return T(m).towards(x, y); });
  P.fn('scrunch', 0, (a, m) => pairList(T(m).scrunch[0], T(m).scrunch[1]));

  // ---- turtle and window control ---------------------------------------------------------------------------------------
  P.fn('showturtle st', 0, (a, m) => { T(m).shown = true; T(m).dirty = true; });
  P.fn('hideturtle ht', 0, (a, m) => { T(m).shown = false; T(m).dirty = true; });
  // SETSHAPE takes 0 / 1 or the names TRIANGLE / TURTLE (the repo manual; the packaged 6.2.5 binary lacks it).
  P.fn('setshape', 1, (a, m) => {
    const x = a[0];
    let shape = null;
    if (isWord(x)) {
      const t = wordText(x).toLowerCase();
      if (t === '0' || t === 'triangle') shape = 'triangle';
      else if (t === '1' || t === 'turtle') shape = 'turtle';
    }
    if (shape === null) throw err.badType('setshape', showForm(x));
    T(m).shape = shape; T(m).dirty = true;
  });
  P.fn('shape', 0, (a, m) => T(m).shape);
  P.fn('clean', 0, (a, m) => { T(m).clean(); });
  P.fn('clearscreen cs', 0, (a, m) => { T(m).clearScreen(); });
  P.fn('wrap', 0, (a, m) => { T(m).mode = 'wrap'; });
  P.fn('window', 0, (a, m) => { T(m).mode = 'window'; });
  P.fn('fence', 0, (a, m) => { T(m).mode = 'fence'; });
  P.fn('turtlemode', 0, (a, m) => T(m).mode);
  P.fn('shownp shown?', 0, (a, m) => bool(T(m).shown));
  P.fn('setscrunch', 2, (a, m) => {
    const sx = num(a[0], 'setscrunch'), sy = num(a[1], 'setscrunch');
    T(m).scrunch = [sx, sy]; T(m).dirty = true;
  });
  // Screen layout only matters to a page that shows a text pane and a canvas; these remember the setting.
  P.fn('textscreen ts', 0, (a, m) => { T(m).screenMode = 'textscreen'; });
  P.fn('fullscreen fs', 0, (a, m) => { T(m).screenMode = 'fullscreen'; });
  P.fn('splitscreen ss', 0, (a, m) => { T(m).screenMode = 'splitscreen'; });
  P.fn('screenmode', 0, (a, m) => T(m).screenMode);
  P.fn('refresh', 0, () => {});
  P.fn('norefresh', 0, () => {});

  // ---- pen ----------------------------------------------------------------------------------------------------------
  P.fn('pendown pd', 0, (a, m) => { T(m).penDown = true; T(m).dirty = true; });
  P.fn('penup pu', 0, (a, m) => { T(m).penDown = false; T(m).dirty = true; });
  P.fn('penpaint ppt', 0, (a, m) => { const t = T(m); t.penDown = true; t.penMode = 'paint'; t.dirty = true; });
  P.fn('penerase pe', 0, (a, m) => { const t = T(m); t.penDown = true; t.penMode = 'erase'; t.dirty = true; });
  P.fn('penreverse px', 0, (a, m) => { const t = T(m); t.penDown = true; t.penMode = 'reverse'; t.dirty = true; });
  P.fn('pendownp pendown?', 0, (a, m) => bool(T(m).penDown));
  P.fn('penmode', 0, (a, m) => T(m).penMode);
  P.fn('setpencolor setpc', 1, (a, m) => { T(m).penColor = colorArg(a[0], 'setpc'); T(m).dirty = true; });
  P.fn('pencolor pc', 0, (a, m) => T(m).colorValue(T(m).penColor));
  P.fn('setbackground setbg', 1, (a, m) => {
    const t = T(m);
    t.background = colorArg(a[0], 'setbg');
    t.emit({ op: 'bg', c: t.rgbOf(t.background) });
  });
  P.fn('background bg', 0, (a, m) => T(m).colorValue(T(m).background));
  // SETPALETTE slot rgb: only slots 8 and up can change (the reference accepts a lower one without effect).
  P.fn('setpalette', 2, (a, m) => {
    const slot = int(a[0], 'setpalette'), rgb = rgbArg(a[1], 'setpalette');
    if (slot < 8) return;
    T(m).palette.set(slot, rgb);
  });
  P.fn('palette', 1, (a, m) => {
    const slot = int(a[0], 'palette');
    if (slot < 0) throw err.badType('palette', showForm(a[0]));
    return percentList(T(m).slotRGB(slot));
  });
  // SETPENSIZE: a non-negative integer, or a list whose first member is one. The pen is square, so both come out equal.
  P.fn('setpensize', 1, (a, m) => {
    let x = a[0];
    if (isList(x)) {
      const l = listToArray(x);
      if (l.length !== 2) throw err.badType('setpensize', showForm(x));
      x = l[0];
    }
    const n = numberValue(x);
    if (n === null || !Number.isInteger(n) || n < 0) throw err.badType('setpensize', showForm(a[0]));
    T(m).penSize = [n, n]; T(m).dirty = true;
  });
  P.fn('pensize', 0, (a, m) => pairList(T(m).penSize[0], T(m).penSize[1]));
  P.fn('setpenpattern', 1, () => {});
  P.fn('penpattern', 0, () => listFromArray([-1]));
  // PEN / SETPEN: [pendown|penup, mode, [w h], colour, [pattern]].
  P.fn('pen', 0, (a, m) => {
    const t = T(m);
    return listFromArray([t.penDown ? 'pendown' : 'penup', t.penMode, pairList(t.penSize[0], t.penSize[1]), t.colorValue(t.penColor), listFromArray([-1])]);
  });
  P.fn('setpen', 1, (a, m) => {
    const t = T(m);
    const l = isList(a[0]) ? listToArray(a[0]) : null;
    if (l === null || l.length < 4) throw err.badType('setpen', showForm(a[0]));
    const up = isWord(l[0]) ? wordText(l[0]).toLowerCase() : '';
    const mode = isWord(l[1]) ? wordText(l[1]).toLowerCase() : '';
    if ((up !== 'pendown' && up !== 'penup') || (mode !== 'paint' && mode !== 'erase' && mode !== 'reverse')) throw err.badType('setpen', showForm(a[0]));
    const size = isList(l[2]) ? listToArray(l[2])[0] : l[2];
    const n = numberValue(size);
    if (n === null || !Number.isInteger(n) || n < 0) throw err.badType('setpen', showForm(a[0]));
    t.penColor = colorArg(l[3], 'setpen');
    t.penDown = up === 'pendown'; t.penMode = mode; t.penSize = [n, n]; t.dirty = true;
  });

  // ---- text on the picture ---------------------------------------------------------------------------------------------
  P.fn('label', 1, (a, m) => {
    const t = T(m);
    t.emit({ op: 'label', x: t.sx(t.x), y: t.sy(t.y), text: printText(a[0]), c: t.penRGB(), h: t.labelHeight * t.scrunch[1] });
  });
  // The character width the reference reports is its font's (10 wide for 17 high); this estimate matches the two
  // recorded pairs (17 -> 10, 20 -> 11).
  P.fn('setlabelheight', 1, (a, m) => {
    const h = int(a[0], 'setlabelheight');
    if (h < 0) throw err.badType('setlabelheight', showForm(a[0]));
    T(m).labelHeight = h;
  });
  P.fn('labelsize', 0, (a, m) => { const h = T(m).labelHeight; return pairList(Math.ceil(h * 0.55), h); });

  // ---- filling ------------------------------------------------------------------------------------------------------
  // FILL: flood-fills the region around the turtle (the page does it on the pixels it has drawn; the manual calls it "not
  // portable").
  P.fn('fill', 0, (a, m) => {
    const t = T(m);
    t.emit({ op: 'fill', x: t.sx(t.x), y: t.sy(t.y), c: t.penRGB() });
  });
  // FILLED colour instructions: runs the instructions and remembers every point the turtle visits, beginning and ending
  // with where it started, then draws that polygon filled with `colour` (pen mode ignored). A machine op, because the
  // instruction list has to run on the machine like REPEAT's (STOP, OUTPUT and THROW work through it).
  P.op('filled', 2, (m, a, want, blame) => {
    if (want === VALUE) throw err.notOutput('filled', blame);
    const t = T(m);
    const fill = colorArg(a[0], 'filled');
    // A FILLED left behind by an error in an earlier line is not "inside" one: only a live frame counts.
    if (t.filling !== null && m.stack.includes(t.filling.frame)) throw err.nestedFilled();
    const run = { pts: [[t.sx(t.x), t.sy(t.y)]], frame: null };
    const frame = new CBFrame(
      (mm) => {
        const tt = T(mm);
        tt.filling = null;
        run.pts.push(run.pts[0]);
        tt.emit({ op: 'polygon', pts: run.pts, fill: tt.rgbOf(fill), c: tt.penRGB() });
        mm.complete(undefined, want, blame, 'filled');
      },
      (mm) => { T(mm).filling = null; },
    );
    run.frame = frame;
    t.filling = run;
    m.stack.push(frame);
    m.runList(a[1], NO, 'filled', null, 'filled');
    return PENDING;
  });
}
