// A small PDF writer for the tests: pages of text in one of the fonts every PDF reader has built in, an outline (nested, each entry pointing at a page directly or by a
// destination name) and a correct cross-reference table. No library is available, and a hand-built file means every word, place and
// outline entry the viewer is expected to find is known. ASCII text only. Not for anything but tests.
//   makePdf({ pages: [[{ x, y, size, text }, ...], ...], outline: [{ title, page (1-based) | name, children: [...] }, ...], named: { name: page },
//             size: [width, height] (default 612 x 792 points) }) -> Buffer
// A page's text is placed with the lower-left corner of the page as the origin, as a PDF does.
function esc(s) { return String(s).replace(/([\\()])/g, '\\$1'); }

function makePdf(spec) {
  const [W, H] = spec.size || [612, 792];
  const pages = spec.pages, named = spec.named || {};
  const objs = [];                                  // objs[n - 1] is the body of object n
  const add = (body) => { objs.push(body); return objs.length; };
  const catalog = add(null), pagesRoot = add(null), font = add('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>');
  const pageIds = [];
  pages.forEach((items) => {
    const text = items.map((t) => `BT /F1 ${t.size || 18} Tf ${t.x} ${t.y} Td (${esc(t.text)}) Tj ET`).join('\n');
    const content = add(`<</Length ${text.length}>>\nstream\n${text}\nendstream`);
    pageIds.push(add(`<</Type/Page/Parent ${pagesRoot} 0 R/MediaBox[0 0 ${W} ${H}]/Resources<</Font<</F1 ${font} 0 R>>>>/Contents ${content} 0 R>>`));
  });
  objs[pagesRoot - 1] = `<</Type/Pages/Kids[${pageIds.map((i) => i + ' 0 R').join(' ')}]/Count ${pages.length}>>`;
  let outlines = '';
  if (spec.outline && spec.outline.length) {
    const root = add(null);
    const make = (list, parent) => {
      const ids = list.map(() => add(null));
      list.forEach((it, i) => {
        const kids = it.children && it.children.length ? make(it.children, ids[i]) : null;
        const dest = it.name ? `/Dest(${esc(it.name)})` : `/Dest[${pageIds[it.page - 1]} 0 R/XYZ 0 ${H} 0]`;
        objs[ids[i] - 1] = `<</Title(${esc(it.title)})/Parent ${parent} 0 R${i > 0 ? `/Prev ${ids[i - 1]} 0 R` : ''}${i < ids.length - 1 ? `/Next ${ids[i + 1]} 0 R` : ''}${kids ? `/First ${kids.first} 0 R/Last ${kids.last} 0 R/Count ${kids.count}` : ''}${dest}>>`;
      });
      return { first: ids[0], last: ids[ids.length - 1], count: list.reduce((n, it) => n + 1 + (it.children ? it.children.length : 0), 0) };
    };
    const top = make(spec.outline, root);
    objs[root - 1] = `<</Type/Outlines/First ${top.first} 0 R/Last ${top.last} 0 R/Count ${top.count}>>`;
    outlines = `/Outlines ${root} 0 R`;
  }
  const dests = Object.keys(named).length ? `/Dests<<${Object.keys(named).map((k) => `/${k}[${pageIds[named[k] - 1]} 0 R/Fit]`).join('')}>>` : '';
  objs[catalog - 1] = `<</Type/Catalog/Pages ${pagesRoot} 0 R${outlines}${dests}>>`;
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((b, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${b}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<</Size ${objs.length + 1}/Root ${catalog} 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

module.exports = { makePdf };
