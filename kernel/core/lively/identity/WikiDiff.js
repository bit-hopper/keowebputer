/**
 * lively.identity.wikiDiff
 *
 * Pure functions that compare two wiki-page snapshots (the ProseMirror JSON in
 * record.payload.snapshot) for the history panel (WikiHistory.js). No DOM, no
 * network -- loadable in Node for tests (tests/wiki/wikidiff.test.js).
 *
 * Model: a snapshot is flattened into a list of "items" in document order --
 * one per text block (paragraph, heading, code block, with its list/quote
 * context) and one per non-text block (image, video, code cell, embed, ...).
 * The two lists are matched with a longest-common-subsequence over each item's
 * key (its full node JSON plus context, so a formatting-only change makes the
 * keys differ). Unmatched runs are then paired up: a removed and an added text
 * item that are similar enough become one "modified" line with a word-level
 * diff inside it; everything else stays a plain removed / added item.
 *
 * Ops produced by diffSnapshots:
 *   { op: 'eq',  item }                 identical in both
 *   { op: 'del', item }                 only in the old version
 *   { op: 'ins', item }                 only in the new version
 *   { op: 'mod', oldItem, newItem, words: [{t:'eq'|'del'|'ins', s}], fmtOnly }
 *                                       text item present in both, edited
 *                                       (fmtOnly: same words, marks differ)
 */

module('lively.identity.WikiDiff')
  .requires()
  .toRun(function () {

    lively.identity = lively.identity || {};

    var TEXT_BLOCKS = { paragraph: 1, heading: 1, code_block: 1 };
    var CONTAINERS = { bullet_list: 'ul', ordered_list: 'ol', check_list: 'ul', list_item: null, blockquote: null };

    // JSON.stringify with sorted keys -- the snapshot has been through a jsonb
    // round trip server-side, which does not preserve key order.
    function stable(v) {
      if (v === null || typeof v !== 'object') return JSON.stringify(v);
      if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
      return '{' + Object.keys(v).sort().map(function (k) {
        return JSON.stringify(k) + ':' + stable(v[k]);
      }).join(',') + '}';
    }

    function inlineText(node) {
      if (!node) return '';
      if (node.type === 'text') return node.text || '';
      if (node.type === 'hard_break') return '\n';
      if (!node.content) return '[' + node.type + ']';
      return node.content.map(inlineText).join('');
    }

    // ctx: { list: 'ul'|'ol'|null, depth: n, quote: bool }
    function flattenInto(node, ctx, out) {
      if (!node) return;
      if (TEXT_BLOCKS[node.type]) {
        var tag = node.type === 'heading' ? 'h' + ((node.attrs && node.attrs.level) || 1)
                : node.type === 'code_block' ? 'pre' : 'p';
        out.push({
          kind: 'text', tag: tag, list: ctx.list, depth: ctx.depth, quote: ctx.quote,
          text: (node.content || []).map(inlineText).join(''),
          key: stable([ctx.list, ctx.depth, ctx.quote, node]),
          // checked state of a checklist item lives on the list_item, not the paragraph
          checked: ctx.checked,
        });
        return;
      }
      if (node.type in CONTAINERS) {
        var next = {
          list: CONTAINERS[node.type] || ctx.list,
          depth: ctx.depth + (node.type === 'bullet_list' || node.type === 'ordered_list' || node.type === 'check_list' ? 1 : 0),
          quote: ctx.quote || node.type === 'blockquote',
          checked: node.type === 'list_item' && node.attrs && node.attrs.checked !== undefined ? node.attrs.checked : ctx.checked,
        };
        (node.content || []).forEach(function (c) { flattenInto(c, next, out); });
        return;
      }
      out.push({ kind: 'node', node: node, key: stable(node) });
    }

    function flatten(snapshot) {
      var out = [];
      ((snapshot && snapshot.content) || []).forEach(function (n) {
        flattenInto(n, { list: null, depth: 0, quote: false }, out);
      });
      return out;
    }

    // LCS over two key arrays; returns [[i, j], ...] of matched index pairs.
    function lcsPairs(a, b) {
      var lo = 0, hiA = a.length, hiB = b.length;
      while (lo < hiA && lo < hiB && a[lo] === b[lo]) lo++;
      while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) { hiA--; hiB--; }
      var n = hiA - lo, m = hiB - lo;
      var pairs = [], i;
      for (i = 0; i < lo; i++) pairs.push([i, i]);
      if (n && m) {
        var w = m + 1, t = new Uint32Array((n + 1) * w);
        for (var x = n - 1; x >= 0; x--) {
          for (var y = m - 1; y >= 0; y--) {
            t[x * w + y] = a[lo + x] === b[lo + y]
              ? t[(x + 1) * w + y + 1] + 1
              : Math.max(t[(x + 1) * w + y], t[x * w + y + 1]);
          }
        }
        var p = 0, q = 0;
        while (p < n && q < m) {
          if (a[lo + p] === b[lo + q]) { pairs.push([lo + p, lo + q]); p++; q++; }
          else if (t[(p + 1) * w + q] >= t[p * w + q + 1]) p++;
          else q++;
        }
      }
      var tailA = hiA, tailB = hiB;
      for (i = 0; i < a.length - hiA; i++) pairs.push([tailA + i, tailB + i]);
      return pairs;
    }

    // Word-level diff of two strings: [{t, s}] where t is 'eq' | 'del' | 'ins'.
    // Whitespace runs are their own tokens so spacing differences still show.
    function wordDiff(a, b) {
      var ta = String(a).split(/(\s+)/).filter(Boolean);
      var tb = String(b).split(/(\s+)/).filter(Boolean);
      var pairs = lcsPairs(ta, tb);
      var out = [], i = 0, j = 0;
      function push(t, s) {
        var last = out[out.length - 1];
        if (last && last.t === t) last.s += s; else out.push({ t: t, s: s });
      }
      pairs.forEach(function (pr) {
        while (i < pr[0]) push('del', ta[i++]);
        while (j < pr[1]) push('ins', tb[j++]);
        push('eq', ta[i]); i++; j++;
      });
      while (i < ta.length) push('del', ta[i++]);
      while (j < tb.length) push('ins', tb[j++]);
      return out;
    }

    // Share of the words of the shorter text that also appear in the longer
    // one -- cheap similarity used only to decide whether a removed and an
    // added line are "the same line, edited".
    function similarity(a, b) {
      if (a === b) return 1;
      var wa = a.split(/\s+/).filter(Boolean), wb = b.split(/\s+/).filter(Boolean);
      if (!wa.length || !wb.length) return 0;
      var set = {};
      wb.forEach(function (w) { set[w] = (set[w] || 0) + 1; });
      var common = 0;
      wa.forEach(function (w) { if (set[w] > 0) { set[w]--; common++; } });
      return common / Math.min(wa.length, wb.length);
    }

    function compatible(o, n) {
      return o.kind === 'text' && n.kind === 'text' && o.tag === n.tag;
    }

    // Turn one run of unmatched old items + unmatched new items into ops.
    function pairRun(dels, inss, ops) {
      var jStart = 0;
      dels.forEach(function (d) {
        var found = -1;
        for (var j = jStart; j < inss.length; j++) {
          if (compatible(d, inss[j]) && similarity(d.text, inss[j].text) >= 0.5) { found = j; break; }
        }
        if (found < 0) { ops.push({ op: 'del', item: d }); return; }
        for (var k = jStart; k < found; k++) ops.push({ op: 'ins', item: inss[k] });
        var n = inss[found];
        var words = wordDiff(d.text, n.text);
        var fmtOnly = d.text === n.text;
        ops.push({ op: 'mod', oldItem: d, newItem: n, words: words, fmtOnly: fmtOnly });
        jStart = found + 1;
      });
      for (var r = jStart; r < inss.length; r++) ops.push({ op: 'ins', item: inss[r] });
    }

    // oldSnap may be null (first version): everything is an insertion.
    function diffSnapshots(oldSnap, newSnap) {
      var a = flatten(oldSnap), b = flatten(newSnap);
      var pairs = lcsPairs(a.map(function (x) { return x.key; }), b.map(function (x) { return x.key; }));
      var ops = [], i = 0, j = 0;
      function flushRun(toI, toJ) {
        pairRun(a.slice(i, toI), b.slice(j, toJ), ops);
        i = toI; j = toJ;
      }
      pairs.forEach(function (pr) {
        flushRun(pr[0], pr[1]);
        ops.push({ op: 'eq', item: b[j] });
        i++; j++;
      });
      flushRun(a.length, b.length);
      var stats = { added: 0, removed: 0, modified: 0 };
      ops.forEach(function (o) {
        if (o.op === 'ins') stats.added++;
        else if (o.op === 'del') stats.removed++;
        else if (o.op === 'mod') stats.modified++;
      });
      return { ops: ops, stats: stats, changed: stats.added + stats.removed + stats.modified > 0 };
    }

    // ─── HTML rendering ──────────────────────────────────────────────────────

    function esc(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function lineHtml(item, innerHtml, cls) {
      var tag = item.tag;
      var style = [];
      if (item.depth) style.push('margin-left:' + (item.depth * 18) + 'px');
      var prefix = item.list ? '<span class="wh-mark">&#8226;</span>' : '';
      if (item.quote) cls += ' wh-quote';
      return '<div class="wh-line ' + cls + '"' + (style.length ? ' style="' + style.join(';') + '"' : '') + '>' +
        prefix + '<' + tag + ' class="wh-text">' + (innerHtml === '' ? '&nbsp;' : innerHtml) + '</' + tag + '></div>';
    }

    function itemHtml(item, cls, renderNode) {
      if (item.kind === 'text') return lineHtml(item, esc(item.text).replace(/\n/g, '<br>'), cls);
      var inner = renderNode ? renderNode(item.node) : '<em>[' + esc(item.node.type) + ']</em>';
      return '<div class="wh-line wh-node ' + cls + '">' + inner + '</div>';
    }

    function modHtml(op) {
      var inner = op.words.map(function (w) {
        var s = esc(w.s).replace(/\n/g, '<br>');
        return w.t === 'eq' ? s : '<' + (w.t === 'del' ? 'del' : 'ins') + '>' + s + '</' + (w.t === 'del' ? 'del' : 'ins') + '>';
      }).join('');
      var cls = 'wh-mod' + (op.fmtOnly ? ' wh-fmt' : '');
      var note = op.fmtOnly ? '<span class="wh-note">formatting changed</span>' : '';
      return lineHtml(op.newItem, inner, cls).replace(/<\/div>$/, note + '</div>');
    }

    // opts.context (default 1): unchanged items kept visible on each side of a
    // change; longer unchanged runs collapse into a bar (data-wh-toggle) that
    // the panel expands on click. opts.renderNode(node) renders a non-text item.
    function renderHtml(diff, opts) {
      var o = opts || {};
      var ctx = o.context === undefined ? 1 : o.context;
      var out = '', run = [];
      function flushRun(isFirst, isLast) {
        if (!run.length) return;
        var keepHead = isFirst ? 0 : ctx, keepTail = isLast ? 0 : ctx;
        if (run.length <= keepHead + keepTail + 1) {
          run.forEach(function (op) { out += itemHtml(op.item, 'wh-same', o.renderNode); });
        } else {
          run.slice(0, keepHead).forEach(function (op) { out += itemHtml(op.item, 'wh-same', o.renderNode); });
          var hidden = run.slice(keepHead, run.length - keepTail);
          out += '<div class="wh-collapse" data-wh-toggle="1">' + hidden.length + ' unchanged block' + (hidden.length === 1 ? '' : 's') + '</div>' +
            '<div class="wh-hidden" style="display:none">' +
            hidden.map(function (op) { return itemHtml(op.item, 'wh-same', o.renderNode); }).join('') + '</div>';
          run.slice(run.length - keepTail).forEach(function (op) { out += itemHtml(op.item, 'wh-same', o.renderNode); });
        }
        run = [];
      }
      var seenChange = false;
      diff.ops.forEach(function (op) {
        if (op.op === 'eq') { run.push(op); return; }
        flushRun(!seenChange, false);
        seenChange = true;
        if (op.op === 'del') out += itemHtml(op.item, 'wh-del', o.renderNode);
        else if (op.op === 'ins') out += itemHtml(op.item, 'wh-ins', o.renderNode);
        else out += modHtml(op);
      });
      flushRun(!seenChange, true);
      return out;
    }

    lively.identity.wikiDiff = {
      flatten: flatten,
      diffSnapshots: diffSnapshots,
      wordDiff: wordDiff,
      renderHtml: renderHtml,
    };

  });
