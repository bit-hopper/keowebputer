/**
 * lively.identity.HomestarBadges
 *
 * Draws the badge row on the homestar hero (badges.md §3): a typed place, transit
 * lines, a school or community, a library stamp, sports teams, and the outlined "+N more"
 * chip that folds the rest. Read path only: this file builds morphs for a list of
 * badges the server already filtered for the viewer (GET /@:handle/badges); it never
 * decides who may see what.
 *
 * Two steps per row, on purpose. plan(badge, maxW) works out a badge's width and
 * height from its text WITHOUT creating a morph; buildRow then lays the plans out
 * (wrapping, centring each row) and make(plan, x, y) creates every morph at its final
 * rect. A morph is never moved with setPosition right after addMorph (CLAUDE.md "A
 * setPosition call made right after addMorph can silently corrupt a morph's own render
 * tree").
 *
 * Text widths come from a canvas measureText in the SAME font the label renders in
 * (the Text morph's computed family), not from HomestarUI.textW's 0.58em guess:
 * checked against the live span.offsetWidth of 33 strings at 12.5px/600, 11px/700 and
 * 12.5px/800, the two agree to 0.01px. It is synchronous, so it has none of the
 * measure-after-insertion race. The font is a lazily loaded web font, so buildRow asks
 * for the glyphs it needs and calls opts.onFontReady once they arrive (a measurement
 * taken before that would use the fallback font and pad or clip every badge).
 *
 * Interaction (every viewer): hovering a badge lifts it 1px with a soft shadow and, after a
 * short delay, shows its full name in a dark tooltip (a world morph; a "+N more" chip lists
 * the folded names). Owner only (opts.onRemove / opts.onAdd given): hovering OR keyboard-
 * focusing a badge outlines it and shows a round remove button at its top-right, and an
 * "Add badge" pill ends the row; manageButton() is the ghost button at the hero's corner.
 * All hover state lives in one row object, disposed when the next row is built, so a page
 * re-render can never strand a tooltip. The row only reports intent (onRemove(badge),
 * onAdd()); it stores nothing itself.
 *
 * Fonts: the page font (Atkinson Hyperlegible) only has regular and bold faces, so
 * the design's weights 600 and 800 both render as bold. That is why the weights are
 * passed through unchanged: a font with real 600/800 faces would pick them up.
 *
 * Plain functions on a namespace object (no BuildSpec / addScript), so module-level
 * vars are fine here.
 */

module("lively.identity.HomestarBadges")
  .requires("lively.identity.HomestarUI", "lively.identity.BadgeCatalog")
  .toRun(function () {

    var UI = lively.identity.HomestarUI;
    var Cat = lively.identity.BadgeCatalog;

    var H = 32;                 // every badge but the stamp
    var STAMP = 36;             // the library stamp
    var GAP_X = 8, GAP_Y = 10;  // between badges, between wrapped rows
    var SHOW = 5;               // badges shown before the rest fold into "+N more"
    var PX = 12.5;              // badge label size
    var FAMILY = "\"Atkinson Hyperlegible\", Helvetica, Arial, sans-serif";   // what a Text morph renders in
    var SERIF = "Georgia, \"Times New Roman\", serif";

    var INK = Color.rgb(0x24, 0x1F, 0x2C);
    var PLACE_FILL = Color.rgb(0xFB, 0xE4, 0xEE);
    var PLACE_PIN = Color.rgb(0xC2, 0x44, 0x7F);
    var STAMP_FILL = Color.rgb(0xFB, 0xF4, 0xE6);
    var STAMP_BROWN = Color.rgb(0x7D, 0x5C, 0x33);
    var STAMP_BROWN_HEX = "#7D5C33", MORE_EDGE_HEX = "#D9CEDC";
    var MORE_INK = Color.rgb(0x3A, 0x34, 0x42);
    var AGENCY_SHADE = Color.rgba(0, 0, 0, 0.24);
    var ADD_EDGE_HEX = "#C9BFCF", ADD_INK = Color.rgb(0x72, 0x6B, 0x7A);
    var GHOST_EDGE_HEX = "#EADFE4", GHOST_INK = Color.rgb(0x3A, 0x34, 0x42);
    var PINK_HEX = "#C2447F";
    var TIP_FILL = Color.rgb(0x24, 0x1F, 0x2C);

    // ─── text measuring ──────────────────────────────────────────────────────

    var _ctx = null;

    // Width in px of `str` at `px`/`weight` in `family`, plus CSS letter-spacing
    // (`spacingEm` of the font size per character). Call it from plan() only; it reads
    // no DOM. Falls back to HomestarUI.textW's guess if a canvas is not available.
    function measure(str, px, weight, family, spacingEm) {
      str = String(str);
      try {
        if (!_ctx) _ctx = document.createElement("canvas").getContext("2d");
        _ctx.font = weight + " " + px + "px " + (family || FAMILY);
        return _ctx.measureText(str).width + (spacingEm || 0) * px * str.length;
      } catch (e) {
        return UI.textW(str, px, weight >= 600);
      }
    }

    // `str` cut with an ellipsis until it fits in `maxPx`. The full text stays available
    // in the badge's tooltip, so nothing is lost by cutting. Never returns "" for a
    // non-empty string (an ellipsis alone at worst).
    function fit(str, maxPx, px, weight, family, spacingEm) {
      str = String(str);
      if (measure(str, px, weight, family, spacingEm) <= maxPx) return str;
      var lo = 0, hi = str.length;      // longest prefix whose "…" version fits
      while (lo < hi) {
        var mid = Math.ceil((lo + hi) / 2);
        if (measure(str.slice(0, mid).replace(/\s+$/, "") + "…", px, weight, family, spacingEm) <= maxPx) lo = mid; else hi = mid - 1;
      }
      return str.slice(0, lo).replace(/\s+$/, "") + "…";
    }

    // Which of the two stamp tilts a badge gets: a stable pick from its id, so the same
    // badge always leans the same way (-6 or +5 degrees).
    function tiltFor(id) {
      var s = 0;
      String(id).split("").forEach(function (ch) { s += ch.charCodeAt(0); });
      return s % 2 ? -6 : 5;
    }

    // ─── morph pieces ────────────────────────────────────────────────────────

    // A single-line label whose GLYPHS start at `gx` (the Text morph's own 4px left /
    // 2px top padding is allowed for: the box starts 4px left and is 8px wider than the
    // text, or its last pixels clip). `y` is the box top. opts: { px, weight, color,
    // family, spacingEm, w (fixed box width, centred text) }.
    function text(gx, y, str, o) {
      var centered = o.w != null;
      var w = centered ? o.w : Math.ceil(measure(str, o.px, o.weight, o.family, o.spacingEm)) + 8;
      var t = UI.label(lively.rect(centered ? gx : gx - 4, y, w, Math.ceil(lineH(o.px, o.family)) + 4), str, {
        px: o.px, color: o.color, align: centered ? "center" : "left",
      });
      var style = { fontWeight: String(o.weight) };
      if (o.family) style.fontFamily = o.family;
      t.applyStyle(style);
      if (o.spacingEm) t.renderContext().shapeNode.style.letterSpacing = o.spacingEm + "em";
      return t;
    }

    // The height of one rendered line of text (a Text morph uses line-height: normal, so
    // it grows with the font size: measured on the live DOM, 12.5px Atkinson is 15.33px,
    // 11px is 14, 8.5px is 10.67, 9.5px Georgia is 12.58). Using one fixed height for every
    // size put the 12.5px labels 1.3px and the 8.5px crest initials 2.7px above centre.
    function lineH(px, family) { return px * (family === SERIF ? 1.32 : 1.23); }

    // The y of a text box that puts one line's middle at the middle of an `h`-high area.
    // The Text morph's own 2px top padding is allowed for. The middle of the line box is
    // also where the capital letters' ink is centred (checked against canvas metrics).
    function textY(h, px, family) { return Math.round(h / 2 - lineH(px, family) / 2 - 2); }

    // A ring on the box's REAL node, applied by finish() once the box is in its owner.
    // The model's borderWidth is not used: Lively sizes a bordered box as extent minus the
    // whole-pixel border, but the browser draws the border snapped to device pixels (1px is
    // 0.67px at a 1.5 pixel ratio), so the box came out up to 1.3px too small. With
    // border-box on the node the extent stays exactly what was asked for. Lively also
    // rewrites the node's `border` (back to 0) when the morph is added to its owner, so
    // writing it at construction is lost: this only records the ring on the box.
    // Children are placed from the padding edge, i.e. inside the ring, so callers shift
    // them by `px` (and size the inner area as extent minus 2 * px).
    function ring(box, px, style, colorHex) {
      box._badgeRing = { px: px, style: style, color: colorHex };
    }

    // Writes the recorded ring (if any) on the box's node. Call it right after the box has
    // been added to its owner, never before.
    function finish(box) {
      var r = box._badgeRing;
      if (!r) return box;
      var s = box.renderContext().shapeNode.style;
      s.boxSizing = "border-box";
      s.border = r.px + "px " + r.style + " " + r.color;
      return box;
    }

    // A Material Symbols glyph centred on (cx, cy). The 20px box is plenty for a 13px
    // glyph; it is sized from the design, not measured (the icon font loads late).
    function iconAt(cx, cy, ligature, px, color) {
      return UI.icon(lively.rect(cx - 10, cy - 10, 20, 20), ligature, px, color);
    }

    function plainBox(rect, fill, radius) {
      var b = new lively.morphic.Box(rect);
      b.applyStyle({ fill: fill, borderRadius: radius, borderWidth: 0, clipMode: "hidden" });
      UI.noDrag(b);
      return b;
    }

    // The full name of a badge, for tooltips and the "+N more" list: a transit tag's agency
    // and line joined with a space, either of which may be empty ("Harbor Line", "72").
    function fullName(b) {
      return [b.agency, b.label].filter(Boolean).join(" ");
    }

    // ─── planning: widths from text, no morphs ───────────────────────────────

    var SHAPES = {
      place: function (b, maxW) {
        var chrome = 10 + 13 + 7 + 13;
        var label = fit(b.label, maxW - chrome, PX, 600);
        return { w: chrome + Math.ceil(measure(label, PX, 600)), h: H, label: label, title: b.label };
      },
      transit: function (b, maxW) {
        var AG = { px: 11, weight: 700, spacingEm: 0.04 };
        var agency = b.agency || "", line = b.label || "";
        var weight = /^\d+[A-Za-z]?$/.test(line) ? 800 : 600;     // numbered routes are heavier
        if (agency && line) {
          // The line keeps at least 40px of text; a long agency gives way first, so the
          // tag never outgrows a narrow column however long the two names are.
          agency = fit(agency, Math.max(30, maxW - 20 - 24 - 40), AG.px, AG.weight, null, AG.spacingEm);
          var agW = 10 + Math.ceil(measure(agency, AG.px, AG.weight, null, AG.spacingEm)) + 10;
          var shownLine = fit(line, maxW - agW - 24, PX, weight);
          return { w: agW + 12 + Math.ceil(measure(shownLine, PX, weight)) + 12, h: H, agency: agency, agW: agW,
                   label: shownLine, weight: weight, title: fullName(b) };   // the full names, not the cut ones
        }
        // One segment: an agency alone (agency style), or a line alone (line style).
        var only = agency || line, isAgency = !!agency;
        var px = isAgency ? AG.px : PX, wt = isAgency ? AG.weight : weight, sp = isAgency ? AG.spacingEm : 0;
        var padX = isAgency ? 10 : 12;
        var shown = fit(only, maxW - padX * 2, px, wt, null, sp);
        return { w: padX * 2 + Math.ceil(measure(shown, px, wt, null, sp)), h: H, single: shown, singleIsAgency: isAgency,
                 weight: wt, title: only };
      },
      team: function (b, maxW) {
        var chrome = 5 + 22 + 8 + 14;
        var label = fit(b.label, maxW - chrome, PX, 600);
        return { w: chrome + Math.ceil(measure(label, PX, 600)), h: H, label: label, title: b.label };
      },
      school: function (b, maxW) {
        var chrome = 11 + 13 + 7 + 13;
        var label = fit(b.label, maxW - chrome, PX, 600);
        return { w: chrome + Math.ceil(measure(label, PX, 600)), h: H, label: label, title: b.label };
      },
      library: function (b) {
        return { w: STAMP, h: STAMP, title: b.label };
      },
      more: function (b, maxW) {
        var label = "+" + b.count + " more";
        // The tooltip lists what is folded in, eight names at most.
        var lines = b.names.slice(0, 8);
        if (b.names.length > 8) lines.push("and " + (b.names.length - 8) + " more");
        return { w: 12 + Math.ceil(measure(label, PX, 600)) + 12, h: H, label: label, title: b.names.join(", "), lines: lines };
      },
      // The owner's "Add badge" pill: a dashed outline, so it can never be mistaken for a badge.
      add: function (b, maxW) {
        return { w: 11 + 12 + 6 + Math.ceil(measure("Add badge", PX, 600)) + 14, h: H, title: "Add badge" };
      },
    };

    // ─── making: one morph per plan, at its final place ──────────────────────

    var MAKE = {
      place: function (p, b, x, y) {
        var box = plainBox(lively.rect(x, y, p.w, H), PLACE_FILL, H / 2);
        box.addMorph(iconAt(10 + 6.5, H / 2, "location_on", 13, PLACE_PIN));
        box.addMorph(text(10 + 13 + 7, textY(H, PX), p.label, { px: PX, weight: 600, color: INK }));
        return box;
      },
      transit: function (p, b, x, y) {
        var fill = Cat.rgb(b.color), ink = Cat.rgb(b.textColor, Color.white);
        var box = plainBox(lively.rect(x, y, p.w, H), fill, 8);
        if (p.single != null) {
          var px = p.singleIsAgency ? 11 : PX;
          box.addMorph(text(p.singleIsAgency ? 10 : 12, textY(H, px), p.single,
            { px: px, weight: p.weight, color: ink, spacingEm: p.singleIsAgency ? 0.04 : 0 }));
          return box;
        }
        // Two segments: the agency sits on the same fill with a darker layer over it.
        box.addMorph(plainBox(lively.rect(0, 0, p.agW, H), AGENCY_SHADE, 0));
        box.addMorph(text(10, textY(H, 11), p.agency, { px: 11, weight: 700, color: ink, spacingEm: 0.04 }));
        box.addMorph(text(p.agW + 12, textY(H, PX), p.label, { px: PX, weight: p.weight, color: ink }));
        return box;
      },
      team: function (p, b, x, y) {
        var fill = Cat.rgb(b.color), ink = Cat.rgb(b.textColor, Color.white);
        var box = plainBox(lively.rect(x, y, p.w, H), fill, H / 2);
        // The crest swaps the colours: a disc in the text colour, initials in the fill colour.
        var crest = plainBox(lively.rect(5, (H - 22) / 2, 22, 22), ink, 11);
        crest.addMorph(text(0, textY(22, 8.5), b.abbr || "", { px: 8.5, weight: 800, color: fill, w: 22 }));
        box.addMorph(crest);
        box.addMorph(text(5 + 22 + 8, textY(H, PX), p.label, { px: PX, weight: 600, color: ink }));
        return box;
      },
      school: function (p, b, x, y) {
        var fill = Cat.rgb(b.color), ink = Cat.rgb(b.textColor, Color.white);
        var box = plainBox(lively.rect(x, y, p.w, H), fill, 8);
        box.addMorph(iconAt(11 + 6.5, H / 2, "shield", 13, ink));
        box.addMorph(text(11 + 13 + 7, textY(H, PX), p.label, { px: PX, weight: 600, color: ink }));
        return box;
      },
      library: function (p, b, x, y) {
        // The stamp leans, and a rotated morph turns about its top-left corner, so the
        // position is shifted to keep the stamp's centre where an upright one would be.
        var deg = tiltFor(b.id), th = deg * Math.PI / 180, c = STAMP / 2;
        var px = x + c - (c * Math.cos(th) - c * Math.sin(th));
        var py = y + c - (c * Math.sin(th) + c * Math.cos(th));
        var box = plainBox(lively.rect(px, py, STAMP, STAMP), STAMP_FILL, STAMP / 2);
        ring(box, 1.5, "dashed", STAMP_BROWN_HEX);
        // Inside the ring is 34 wide (the ring draws about 1px): the book above, the
        // abbreviation below, the pair centred as one stack.
        var inner = STAMP - 2;
        box.addMorph(iconAt(inner / 2, 12, "menu_book", 11, STAMP_BROWN));
        box.addMorph(text(0, 15, b.abbr || "", { px: 9.5, weight: 700, color: STAMP_BROWN, family: SERIF, spacingEm: 0.03, w: inner }));
        box.setRotation(th);
        return box;
      },
      add: function (p, b, x, y) {
        var box = plainBox(lively.rect(x, y, p.w, H), Color.white, H / 2);
        ring(box, 1.5, "dashed", ADD_EDGE_HEX);
        // Inside the ring (about 1px): a 12px plus, then the label.
        box.addMorph(iconAt(11 - 1 + 6, (H - 2) / 2, "add", 12, ADD_INK));
        box.addMorph(text(11 + 12 + 6 - 1, textY(H - 2, PX), "Add badge", { px: PX, weight: 600, color: ADD_INK }));
        return box;
      },
      more: function (p, b, x, y) {
        var box = plainBox(lively.rect(x, y, p.w, H), Color.white, H / 2);
        ring(box, 1, "solid", MORE_EDGE_HEX);
        // Inside the 1px ring.
        box.addMorph(text(12 - 1, textY(H - 2, PX), p.label, { px: PX, weight: 600, color: MORE_INK }));
        return box;
      },
    };

    function plan(b, maxW) {
      var shape = SHAPES[b.kind] || SHAPES.school;
      var p = shape(b, maxW);
      p.badge = b;
      return p;
    }

    function make(p, x, y) {
      var b = p.badge;
      var box = MAKE[b.kind](p, b, x, y);
      // The accessible name is the FULL name (a truncated label and the stamp cannot spell
      // it out). There is deliberately no `title` attribute: the hover tooltip below shows
      // the same text, and a native one on top of it would appear twice.
      var node = box.renderContext().shapeNode;
      node.setAttribute("data-badge", b.kind);
      node.setAttribute("role", b.kind === "add" ? "button" : "img");
      node.setAttribute("aria-label", p.title);
      return box;
    }

    var _waiting = {};

    // ─── interaction: hover, tooltip, remove button, keyboard ────────────────

    // The row whose hover state (a lifted badge, a remove button, a tooltip) may be on
    // screen. Only one row exists at a time; buildRow disposes the previous one first.
    var _active = null;

    var HOVER_OUT_MS = 120;     // a badge and its remove button are separate nodes; this bridges the gap
    var TIP_DELAY_MS = 350;

    function nodeOf(m) { return m.renderContext().shapeNode; }

    function removeMorph(m) { if (m && m.owner) m.remove(); }

    // Sets `css` as the text colour of a morph and everything inside its node. A colour
    // applied to an already-rendered morph through the model can silently not reach the
    // DOM (CLAUDE.md), and the glyph is on an inner span, so write the real nodes.
    function tint(morph, css) {
      var n = nodeOf(morph);
      n.style.color = css;
      var all = n.querySelectorAll("*");
      for (var i = 0; i < all.length; i++) all[i].style.color = css;
    }

    // The 1px lift and soft shadow of a hovered badge, on its real node.
    function lift(item, on) {
      var s = item.node.style;
      s.transition = "transform .12s ease, box-shadow .12s ease";
      s.transform = on ? "translateY(-1px)" : "";
      s.boxShadow = on ? "0 3px 8px rgba(36,31,44,.25)" : "";
    }

    // The owner's hover / focus outline (2px pink, 3px off the badge).
    function outline(item, on) {
      item.node.style.outline = on ? "2px solid " + PINK_HEX : "none";
      item.node.style.outlineOffset = "3px";
    }

    function hideTip(row) {
      clearTimeout(row.tipTimer);
      removeMorph(row.tip);
      removeMorph(row.tipArrow);
      row.tip = row.tipArrow = null;
      window.removeEventListener("scroll", row.onScroll, true);
    }

    // The dark tooltip over (or, near the top of the window, under) a badge: its full name,
    // one line per name for the "+N more" chip. A world morph, not part of the hero, so no
    // card clips it; the page's native pointer-events are switched off on it so it can never
    // take the mouse from the badge it describes (eventsAreIgnored only affects Lively's own
    // dispatch, CLAUDE.md).
    function showTip(row, item) {
      hideTip(row);
      var lines = (item.p.lines || [item.p.title]).map(function (l) { return fit(l, 320, 12, 600); });
      var lh = Math.ceil(lineH(12));
      var w = 0;
      lines.forEach(function (l) { w = Math.max(w, Math.ceil(measure(l, 12, 600))); });
      w += 22;
      var h = 14 + lines.length * lh;
      var r = item.node.getBoundingClientRect();
      var vw = document.documentElement.clientWidth;
      var sx = window.pageXOffset || 0, sy = window.pageYOffset || 0;
      var cx = r.left + r.width / 2;
      var left = Math.max(8, Math.min(cx - w / 2, vw - 8 - w));
      var above = r.top - 8 - h - 4 >= 8;
      var top = above ? r.top - 4 - h - 4 : r.bottom + 4 + 4;
      var tip = plainBox(lively.rect(left + sx, top + sy, w, h), TIP_FILL, 8);
      tip.applyStyle({ clipMode: "visible" });
      tip.eventsAreIgnored = true;
      lines.forEach(function (l, i) {
        tip.addMorph(text(11, 5 + i * lh, l, { px: 12, weight: 600, color: Color.white }));
      });
      // The 4px arrow: a 10x5 box cut to a triangle, pointing at the badge's middle.
      var ax = Math.max(left + 10, Math.min(cx, left + w - 10)) - 5;
      var arrow = plainBox(lively.rect(ax + sx, (above ? top + h : top - 5) + sy, 10, 5), TIP_FILL, 0);
      arrow.applyStyle({ clipMode: "visible" });
      arrow.eventsAreIgnored = true;
      $world.addMorph(tip);
      $world.addMorph(arrow);
      [tip, arrow].forEach(function (m) { nodeOf(m).style.pointerEvents = "none"; });
      nodeOf(arrow).style.clipPath = above ? "polygon(0 0, 100% 0, 50% 100%)" : "polygon(50% 0, 100% 100%, 0 100%)";
      nodeOf(tip).setAttribute("role", "tooltip");
      row.tip = tip;
      row.tipArrow = arrow;
      // A scroll moves the badge out from under the tooltip: drop everything.
      window.addEventListener("scroll", row.onScroll, true);
    }

    function hideX(row) {
      if (!row.x) return;
      removeMorph(row.x.morph);
      row.x = null;
    }

    // Back to rest: no lift, no outline, no remove button, no tooltip.
    function deactivate(row) {
      clearTimeout(row.hideTimer);
      window.removeEventListener("mousemove", row.onMove, true);
      var item = row.hover;
      row.hover = null;
      hideTip(row);
      if (item) { lift(item, false); if (row.owner) outline(item, false); }
      hideX(row);
    }

    // Is the mouse still on (or within 2px of) this badge? A lifted badge's hit area
    // moves up 1px, so a pointer resting on its bottom edge would otherwise lower and lift
    // it in a loop.
    function pointerNear(row, item) {
      if (!row.mouse) return false;
      var r = item.node.getBoundingClientRect();
      return row.mouse.x >= r.left - 2 && row.mouse.x <= r.right + 2 && row.mouse.y >= r.top - 2 && row.mouse.y <= r.bottom + 3;
    }

    function enter(row, item, viaFocus) {
      clearTimeout(row.hideTimer);
      if (row.hover === item) return;
      if (row.hover) deactivate(row);
      row.hover = item;
      window.addEventListener("mousemove", row.onMove, true);
      lift(item, true);
      if (row.owner) {
        outline(item, true);
        if (item.p.badge.kind !== "more") showX(row, item);
      }
      row.tipTimer = setTimeout(function () { if (row.hover === item) showTip(row, item); }, viaFocus ? 0 : TIP_DELAY_MS);
    }

    function leave(row, item) {
      clearTimeout(row.hideTimer);
      row.hideTimer = setTimeout(function () {
        if (row.hover !== item) return;
        // Focus keeps the badge (and its remove button) active; so does a pointer on its edge.
        var ae = document.activeElement;
        if (ae && (ae === item.node || (row.x && ae === row.x.node))) return;
        if (pointerNear(row, item)) return;
        deactivate(row);
      }, HOVER_OUT_MS);
    }

    // Enter or Space on a focusable node does what a click would.
    function activateOnKey(node, fn) {
      node.addEventListener("keydown", function (e) {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        fn();
      });
    }

    // The tab order inside the row, as nodes: each badge, then its remove button while it
    // is showing, ..., then "Add badge". The remove button is created on hover, so it sits
    // at the end of the hero's DOM; Tab is therefore steered by hand through this list
    // (the browser's own order would skip it). Leaving either end falls back to the
    // browser's order.
    function sequence(row) {
      var out = [];
      row.items.forEach(function (it) {
        if (it.p.badge.kind === "add") return;
        out.push(it.node);
        if (row.x && row.x.item === it) out.push(row.x.node);
      });
      if (row.add) out.push(row.add.node);
      return out;
    }

    function onTab(row, node, e) {
      if (e.key !== "Tab") return;
      var seq = sequence(row), i = seq.indexOf(node), j = i + (e.shiftKey ? -1 : 1);
      if (i < 0 || j < 0 || j >= seq.length) return;
      var target = seq[j];
      // Going BACK onto a badge whose remove button is not showing (focus came from later in
      // the row): activate the badge so its remove button exists, and land on that button,
      // the way going forward visits it. Without this the button is skipped in reverse.
      if (e.shiftKey && row.owner) {
        var it = row.items.filter(function (x) { return x.node === target; })[0];
        var hadX = row.x && row.x.item === it;
        if (it && !hadX && it.p.badge.kind !== "more" && it.p.badge.kind !== "add") {
          enter(row, it, true);
          if (row.x && row.x.item === it) target = row.x.node;
        }
      }
      e.preventDefault();
      e.stopPropagation();
      target.focus();
    }

    function removeItem(row, item) {
      deactivate(row);
      if (row.opts.onRemove) row.opts.onRemove(item.p.badge);
    }

    // The round remove button at a badge's top-right (24px, 10px above and 8px past the
    // corner), a sibling of the badge in the hero so the badge's own clipping cannot cut it.
    function showX(row, item) {
      if (row.x && row.x.item === item) return;
      hideX(row);
      var b = plainBox(lively.rect(item.x + item.w - 16, item.y - 10, 24, 24), Color.white, 12);
      ring(b, 1, "solid", GHOST_EDGE_HEX);
      b.addMorph(iconAt(11, 11, "close", 14, GHOST_INK));
      b.applyStyle({ handStyle: "pointer" });
      row.host.addMorph(b);
      finish(b);
      var n = nodeOf(b), name = "Remove " + item.p.title;
      n.style.boxShadow = "0 1px 3px rgba(36,31,44,.18)";
      n.style.outline = "none";
      n.tabIndex = 0;
      n.setAttribute("role", "button");
      n.setAttribute("aria-label", name);
      n.title = name;
      b.onMouseOver = function () { clearTimeout(row.hideTimer); };
      b.onMouseOut = function () { leave(row, item); };
      b.onMouseUp = function (evt) { evt.stop(); removeItem(row, item); return true; };
      n.addEventListener("focus", function () { clearTimeout(row.hideTimer); n.style.outline = "2px solid " + PINK_HEX; n.style.outlineOffset = "2px"; });
      n.addEventListener("blur", function () { n.style.outline = "none"; leave(row, item); });
      n.addEventListener("keydown", function (e) { onTab(row, n, e); });
      activateOnKey(n, function () { removeItem(row, item); });
      row.x = { morph: b, node: n, item: item };
    }

    // Everything a badge needs to react: hover for every viewer; focus, the remove button
    // and the keyboard for the owner.
    function wireBadge(row, item) {
      var box = item.box, n = item.node;
      box.onMouseOver = function () { enter(row, item, false); };
      box.onMouseOut = function () { leave(row, item); };
      if (!row.owner) return;
      n.tabIndex = 0;
      n.setAttribute("role", "group");
      n.style.outline = "none";
      n.addEventListener("focus", function () { enter(row, item, true); });
      n.addEventListener("blur", function () { leave(row, item); });
      n.addEventListener("keydown", function (e) {
        onTab(row, n, e);
        if ((e.key === "Delete" || e.key === "Backspace") && item.p.badge.kind !== "more") {
          e.preventDefault();
          e.stopPropagation();
          removeItem(row, item);
        }
      });
    }

    // A button-like morph (the "Add badge" pill, the "Manage badges" button): pink on hover
    // and a 2px pink ring on keyboard focus, a pointer cursor, Enter / Space like a click.
    // `restInk` is the text colour to go back to, as a CSS colour.
    function wireButton(box, onClick, ringOffset, restInk, onTab) {
      var n = nodeOf(box);
      box.applyStyle({ handStyle: "pointer" });
      n.tabIndex = 0;
      n.style.outline = "none";
      var kids = box.submorphs.slice();
      var restBorder = n.style.borderColor;
      box.onMouseOver = function () { n.style.borderColor = PINK_HEX; kids.forEach(function (k) { tint(k, PINK_HEX); }); };
      box.onMouseOut = function () { n.style.borderColor = restBorder; kids.forEach(function (k) { tint(k, restInk); }); };
      box.onMouseUp = function (evt) { evt.stop(); onClick(); return true; };
      n.addEventListener("focus", function () { n.style.outline = "2px solid " + PINK_HEX; n.style.outlineOffset = ringOffset + "px"; });
      n.addEventListener("blur", function () { n.style.outline = "none"; });
      if (onTab) n.addEventListener("keydown", onTab);
      activateOnKey(n, onClick);
      return n;
    }

    function disposeActive() {
      var row = _active;
      _active = null;
      if (!row) return;
      deactivate(row);
    }

    // The glyphs a row needs, for the font-loaded check (see the file header).
    function rowText(badges) {
      return badges.map(function (b) { return [b.label, b.agency, b.abbr].filter(Boolean).join(" "); }).join(" ") + " +0123456789 more Add badge";
    }

    lively.identity.HomestarBadges = {
      H: H,
      STAMP: STAMP,
      GAP_X: GAP_X,
      GAP_Y: GAP_Y,
      SHOW: SHOW,

      // Pure sizing helpers, exposed for the tests and the (later) picker's live preview.
      measure: measure,
      fit: fit,
      tiltFor: tiltFor,
      plan: plan,
      make: make,
      finish: finish,

      // Adds the badge row to `hero` with its left edge at `x`, top at `y`, at most
      // `maxW` wide. `badges` is what the server sent (place first); the first SHOW are
      // drawn, the rest become a "+N more" chip. Rows wrap; each badge is centred on its
      // row's height (the stamp is 4px taller than the rest). Returns the y of the row's
      // bottom edge, or `y` itself when there is nothing to draw (no gap is added, the
      // caller adds its own).
      //
      // opts:
      //   onFontReady()   called once if the page font was not loaded yet, so the caller can
      //                   redraw with true widths.
      //   onRemove(badge) given only for the OWNER: turns on the outline, the remove button
      //                   and keyboard focus on every badge. It is called with the server's
      //                   badge (the synthetic place has id "_legacy"); the caller does the
      //                   saving and redraws.
      //   onAdd()         given only for the owner: ends the row with an "Add badge" pill
      //                   (drawn even when there are no badges yet).
      // A visitor passes neither and gets a static row with hover tooltips.
      buildRow: function (hero, x, y, maxW, badges, opts) {
        opts = opts || {};
        disposeActive();
        badges = (badges || []).filter(function (b) { return b && b.kind !== "more" && b.kind !== "add" && SHAPES[b.kind]; });
        var owner = !!opts.onRemove;
        if (!badges.length && !opts.onAdd) return y;

        var txt = rowText(badges);
        var font = "700 " + PX + "px " + FAMILY;
        try {
          if (document.fonts && !document.fonts.check(font, txt) && !_waiting[txt]) {
            _waiting[txt] = true;
            document.fonts.load(font, txt).then(function () { if (opts.onFontReady) opts.onFontReady(); })
              .catch(function () {});
          }
        } catch (e) { /* no FontFaceSet: measure with what there is */ }

        var shown = badges.slice(0, SHOW), rest = badges.slice(SHOW);
        var plans = shown.map(function (b) { return plan(b, maxW); });
        if (rest.length) {
          plans.push(plan({ kind: "more", count: rest.length, names: rest.map(fullName) }, maxW));
        }
        if (opts.onAdd) plans.push(plan({ kind: "add" }, maxW));

        // Wrap into rows.
        var rows = [], line = null, cx = 0;
        plans.forEach(function (p) {
          if (!line || (cx > 0 && cx + p.w > maxW)) { line = { items: [], h: 0 }; rows.push(line); cx = 0; }
          line.items.push({ p: p, x: cx });
          line.h = Math.max(line.h, p.h);
          cx += p.w + GAP_X;
        });

        var row = { host: hero, opts: opts, owner: owner, items: [], add: null, hover: null, x: null,
                    tip: null, tipArrow: null, tipTimer: null, hideTimer: null, mouse: null };
        row.onMove = function (e) { row.mouse = { x: e.clientX, y: e.clientY }; };
        row.onScroll = function () { deactivate(row); };
        _active = row;

        var ry = y;
        rows.forEach(function (r) {
          r.items.forEach(function (it) {
            var ix = x + it.x, iy = ry + Math.round((r.h - it.p.h) / 2);
            var box = make(it.p, ix, iy);
            hero.addMorph(box);
            finish(box);
            var item = { p: it.p, box: box, node: nodeOf(box), x: ix, y: iy, w: it.p.w, h: it.p.h };
            row.items.push(item);
            if (it.p.badge.kind === "add") {
              row.add = item;
              wireButton(box, function () { opts.onAdd(); }, 2, "#726B7A", function (e) { onTab(row, item.node, e); });
            } else {
              wireBadge(row, item);
            }
          });
          ry += r.h + GAP_Y;
        });
        return ry - GAP_Y;
      },

      // The ghost "Manage badges" button (44px high, pencil icon) with its right edge
      // `right` px inside the hero's right edge and its top `top` px below the hero's top.
      // Added to `hero`; returns its width. Owner only, and only once there is a dialog to
      // open (the caller decides). onClick() is called on a click, Enter or Space.
      manageButton: function (hero, right, top, onClick) {
        var label = "Manage badges";
        var w = 1 + 16 + 14 + 6 + Math.ceil(measure(label, 13, 600)) + 16 + 1, h = 44;
        var box = plainBox(lively.rect(hero.getExtent().x - right - w, top, w, h), Color.white, h / 2);
        ring(box, 1, "solid", GHOST_EDGE_HEX);
        // Inside the 1px ring (42 high).
        box.addMorph(iconAt(16 - 1 + 7, 21, "edit", 14, GHOST_INK));
        box.addMorph(text(16 - 1 + 14 + 6, textY(42, 13), label, { px: 13, weight: 600, color: GHOST_INK }));
        hero.addMorph(box);
        finish(box);
        var n = wireButton(box, onClick, 2, "#3A3442");
        n.setAttribute("role", "button");
        n.setAttribute("aria-label", label);
        return w;
      },
    };

  });
