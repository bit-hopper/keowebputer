// Test for keo-wikiexport.js, run without a browser: a wiki page made into a Markdown file or a standalone web page by the SHELL. Two kinds of
// input. (1) A page made in the REAL editor with one of every kind of content its schema has (tests/vectors/wiki-page-fixture.json: made-up
// text only, its Yjs state as the shell holds it, made once by the real editor in a headless browser), so that what the file
// says is checked against what the editor really writes (marks as attributes with a `--suffix`, atoms as child elements). (2) Documents built
// here with Yjs that a hostile writer could have written: markup in the text, a link or an image with an address that must not be written,
// a colour that is not a colour, nesting a few thousand deep, more nodes than the budget, a document that is not a page.
// Usage: node keo-wikiexport-test.js
const fs = require('fs'), path = require('path');
const Y = require(path.join(__dirname, '..', 'shell', 'keo-yjs.js'));
const E = require(path.join(__dirname, '..', 'shell', 'keo-wikiexport.js'));
let passed = 0;
const ok = (name, cond, extra) => { if (!cond) { console.error('FAIL ' + name + (extra !== undefined ? ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 700) : '')); process.exitCode = 1; } else { passed++; console.log('ok   ' + name); } };
const rejects = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
const dec = new TextDecoder();

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'vectors', 'wiki-page-fixture.json'), 'utf8'));
const fixtureState = new Uint8Array(Buffer.from(fixture.state, 'base64'));
const md = (name, update) => dec.decode(E.exportPage({ name, update, format: 'markdown' }).bytes);
const html = (name, update) => dec.decode(E.exportPage({ name, update, format: 'html' }).bytes);

// ---- documents built by hand, as a writer could
const el = (name, attrs, kids) => { const e = new Y.XmlElement(name); Object.keys(attrs || {}).forEach((k) => e.setAttribute(k, attrs[k])); if (kids && kids.length) e.insert(0, kids); return e; };
const tx = (parts) => { const t = new Y.XmlText(); let at = 0; (Array.isArray(parts) ? parts : [[parts]]).forEach(([s, attrs]) => { t.insert(at, s, attrs); at += s.length; }); return t; };
const para = (parts) => el('paragraph', { align: 'left', indent: 0 }, [tx(parts)]);
const docOf = (blocks) => { const d = new Y.Doc(); d.getXmlFragment('prosemirror').insert(0, blocks); return Y.encodeStateAsUpdate(d); };

(async () => {
  // ================================================================ the page made in the real editor
  const m = md('fixture-page', fixtureState), h = html('fixture-page', fixtureState);
  const mdLines = m.split('\n');
  ok('markdown: the page\'s name is the title, then its first heading', mdLines[0] === '# fixture-page' && mdLines[2] === '# Export fixture', mdLines.slice(0, 3));
  ok('markdown: bold, italic, both, code, strike, underline, superscript and subscript', mdLines.includes('Plain, **bold**, *italic*, ***both***, `code`, ~~struck~~, <u>under</u>, x<sup>2</sup>, H<sub>2</sub>, red.'), mdLines[4]);
  ok('markdown: a link, and the characters that could be markup are escaped (<, &, *, _, [ ])', m.includes('A [link to a page](https://example.org/a?b=1&c=2) and a \\<tag\\> \\& "quotes", plus \\*stars\\*, \\_unders\\_, and a \\[bracket\\] in the text.'), mdLines[6]);
  ok('markdown: a break inside a paragraph is a break (two spaces and a new line)', m.includes('in the text.  \nAfter a break.'));
  ok('markdown: inline math between dollars, and an image with its text', m.includes('Inline math $x^2 + y^2$ in a sentence, and an image: ![a tiny picture](data:image/gif;base64,R0lGODlhAQABAAAAACw=).'));
  ok('markdown: alignment and indent are not carried (the text is)', mdLines.includes('Centred and indented'));
  ok('markdown: headings of the three levels', mdLines.includes('## A second-level heading with **bold**') && mdLines.includes('### Third level'));
  ok('markdown: a bullet list with a nested one, and no blank line before the nested list', m.includes('- first bullet\n- second bullet\n  - nested bullet\n  - another nested\n- third bullet\n'), m.slice(m.indexOf('- first')));
  ok('markdown: an ordered list that starts at three, with a nested one numbered from one', m.includes('3. starts at three\n4. then four\n   1. nested one\n   2. nested two\n'), m.slice(m.indexOf('3. starts')));
  ok('markdown: a quote of two paragraphs', m.includes('> A quoted paragraph.\n>\n> Another, with **bold**.\n'));
  ok('markdown: a code block is fenced and its text is not touched, a code cell names its language', m.includes('```\nfunction f(a) {\n  return a < 2 && "x";\n}\n```\n') && m.includes('```scheme\n(define (square x) (* x x))\n(square 4)\n```\n'));
  ok('markdown: display math is a fenced block named math, as its source (a viewer that does not draw it still shows it as code)', m.includes('```math\n\\int_0^1 x\\,dx = \\tfrac12\n```\n'));
  ok('markdown: a shared link is its title as a link, with its description', m.includes('[A shared post](https://example.org/post) — About something\n'));
  ok('markdown: a video, a sound and an embedded part are named, not carried', m.includes('*[video: a clip.mp4]*') && m.includes('*[audio: a song.mp3]*') && m.includes('*[embedded part]*'));
  ok('markdown: the last paragraph, with accents, an emoji and a tab, is whole, and the file ends with one new line', m.endsWith('The end, with Zoë and an emoji 🙂 and a tab\there.\n'));
  ok('html: a standalone page with the name as its title and heading, and a policy that lets nothing run', /^<!DOCTYPE html>\n<html><head><meta charset="utf-8">/.test(h) && h.includes("<title>fixture-page</title>") && h.includes('<h1>fixture-page</h1>') && h.includes("default-src 'none'") && !/<script/i.test(h));
  ok('html: the marks, in order, with the colour as a style', h.includes('<p>Plain, <strong>bold</strong>, <em>italic</em>, <em><strong>both</strong></em>, <code>code</code>, <s>struck</s>, <u>under</u>, x<sup>2</sup>, H<sub>2</sub>, <span style="color:red">red</span>.</p>'), h.slice(h.indexOf('<p>Plain')).slice(0, 300));
  ok('html: the link has its address escaped and a safe rel; the markup characters are escaped', h.includes('<a href="https://example.org/a?b=1&amp;c=2" rel="noopener noreferrer">link to a page</a> and a &lt;tag&gt; &amp; &quot;quotes&quot;'));
  ok('html: alignment and indent are carried', h.includes('<p style="text-align:center;margin-left:24px">Centred and indented</p>'));
  ok('html: lists nest, an ordered list keeps where it starts', h.includes('<ul><li><p>first bullet</p></li><li><p>second bullet</p>\n<ul>') && h.includes('<ol start="3">'));
  ok('html: code is escaped, a code cell names its language, math is its source', h.includes('return a &lt; 2 &amp;&amp; &quot;x&quot;;') && h.includes('class="language-scheme"') && h.includes('<pre class="math-display">\\int_0^1 x\\,dx = \\tfrac12</pre>'));
  ok('html: the picture is kept (a small embedded one), the card is a link', h.includes('<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="a tiny picture">') && h.includes('<a href="https://example.org/post"'));
  const e1 = E.exportPage({ name: 'Fixture Page!', update: fixtureState, format: 'markdown' }), e2 = E.exportPage({ name: 'Fixture Page!', update: fixtureState, format: 'html' });
  ok('the answer is the file\'s name, its type and its bytes (utf-8)', e1.name === 'Fixture-Page.md' && e1.type === 'text/markdown;charset=utf-8' && e1.bytes instanceof Uint8Array && e2.name === 'Fixture-Page.html' && e2.type === 'text/html;charset=utf-8', [e1.name, e1.type, e2.name]);
  ok('exporting the same page twice gives the same bytes', Buffer.compare(Buffer.from(E.exportPage({ name: 'x', update: fixtureState, format: 'html' }).bytes), Buffer.from(E.exportPage({ name: 'x', update: fixtureState, format: 'html' }).bytes)) === 0);

  // ================================================================ what a hostile writer could put in a page
  const hostile = docOf([
    para([['<script>alert(1)</script>']]),
    para([['click me', { link: { href: 'javascript:alert(document.cookie)', title: null, objId: null } }]]),
    para([['data link', { link: { href: 'data:text/html,<script>alert(1)</script>', title: null, objId: null } }]]),
    para([['file link', { link: { href: 'file:///etc/passwd', title: null, objId: null } }]]),
    para([['good link', { link: { href: 'mailto:a@b.example', title: null, objId: null } }]]),
    para([['coloured', { textColor: { color: 'red;background:url(//evil.example/x)' } }], [' and ', {}], ['fine', { textColor: { color: '#a1b2c3' } }]]),
    el('paragraph', { align: 'left; position:fixed', indent: 9999 }, [tx('odd attributes'), el('image', { src: 'javascript:alert(1)', alt: '"><img src=x onerror=alert(1)>' }), el('image', { src: 'data:text/html;base64,PHNjcmlwdD4=', alt: 'a page as a picture' }), el('image', { src: 'https://example.org/p.png"onerror="x', alt: 'quote in address' })]),
    el('link_preview_card', { url: 'javascript:alert(2)', title: '<b>card</b>', description: '<i>text</i>' }),
    el('heading', { level: 99, align: 'left' }, [tx('# not a heading level 99')]),
    el('code_cell', { language: 'x"><script>alert(1)</script>' }, [tx('```\nclosing fence inside\n```')]),
    el('unknown_future_block', {}, [tx('text of a block this file does not know')]),
    el('math_display', { value: '</pre><script>alert(1)</script>' }),
    para([['1. not a list']]), para([['- not a bullet']]), para([['# not a heading']]), para([['---']]), para([['> not a quote']]),
  ]);
  const hm = md('hostile', hostile), hh = html('hostile', hostile);
  ok('html: typed markup is text: no tag the writer typed survives (the only <script> or onerror in the file would be one that runs)', !/<script/i.test(hh) && !/onerror\s*=\s*"?[^&]*alert/i.test(hh.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/<img src=x onerror[^>]*>/, 'X') ) && hh.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), hh.slice(hh.indexOf('<body>'), hh.indexOf('<body>') + 600));
  ok('html: a link whose address is javascript:, data: or file: is written as its text, not a link; mailto: is a link', !/href="(javascript|data|file):/i.test(hh) && hh.includes('<p>click me</p>') && hh.includes('<p>data link</p>') && hh.includes('<p>file link</p>') && hh.includes('<a href="mailto:a@b.example"'), hh.slice(hh.indexOf('<body>'), hh.indexOf('<body>') + 900));
  ok('html: a colour that is not a colour is dropped (no style carries the injected text), a real one stays', !/evil\.example/.test(hh) && hh.includes('<span style="color:#a1b2c3">fine</span>'));
  ok('html: an alignment that is not an alignment and an indent far too big are not written into a style', !/position:fixed/.test(hh) && !/margin-left:\d{4}/.test(hh) && hh.includes('<p>odd attributes'), hh.slice(hh.indexOf('odd attributes') - 20, hh.indexOf('odd attributes') + 400));
  ok('html: a picture whose address is javascript: or a page is its words, one with a quote in its address does not break out of the attribute', !/src="javascript:/i.test(hh) && !/src="data:text/i.test(hh) && hh.includes('[picture: a page as a picture]') && (hh.match(/<img\b[^>]*>/g) || []).every((t) => /^<img src="[^"]*" alt="[^"]*">$/.test(t)), hh.slice(hh.indexOf('odd attributes'), hh.indexOf('odd attributes') + 600));
  ok('html: a card with a bad address is its title as text; an unknown block is the text it holds', hh.includes('<p class="card">&lt;b&gt;card&lt;/b&gt; — &lt;i&gt;text&lt;/i&gt;</p>') && hh.includes('<p>text of a block this file does not know</p>'));
  ok('html: a heading level out of range is a level 6, a language that is not a name loses its odd characters', hh.includes('<h6># not a heading level 99</h6>') && hh.includes('class="language-xscriptalert1script"'), hh.slice(hh.indexOf('<h6'), hh.indexOf('<h6') + 300));
  ok('html: display math with markup in it is escaped', hh.includes('<pre class="math-display">&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;</pre>'));
  // (inside a fenced block text is code and is never read as markup: the display math's source is there, raw, and that is the point of the fence)
  const outsideFences = hm.replace(/^(`{3,})[^\n]*\n[\s\S]*?\n\1$/gm, '');
  ok('markdown: typed markup is escaped, not written as markup: outside a fenced block no raw tag is left anywhere in the file', hm.includes('\\<script\\>alert(1)\\</script\\>') && !/(^|[^\\])<\/?(script|pre|b|i)\b/i.test(outsideFences), outsideFences.match(/.*(^|[^\\])<\/?(script|pre|b|i)\b.*/i));
  ok('markdown: display math with markup in it is inside its fence, whole', hm.includes('```math\n</pre><script>alert(1)</script>\n```'));
  const inlineMath = md('m', docOf([el('paragraph', {}, [tx('a '), el('math_inline', { value: 'x<y & z' }), tx(' b '), el('math_inline', { value: 'a$b' }), tx(' c')])]));
  ok('markdown: inline math with markup characters or a dollar in it is a code span, not dollars', inlineMath.includes('a `x<y & z` b `a$b` c') && !/<y/.test(inlineMath.replace('`x<y & z`', '')), inlineMath);
  ok('markdown: a link with an unsafe address is its text; the safe one is a link', !/\]\((javascript|data|file):/i.test(hm) && hm.includes('\nclick me\n') && hm.includes('[good link](mailto:a@b.example)'), hm.slice(0, 700));
  ok('markdown: a picture with an unsafe address is its words (escaped), and a quote cannot close an address', !/!\[[^\]]*\]\((javascript|data:text)/i.test(hm) && hm.includes('[picture: a page as a picture]'.replace(/[\[\]]/g, '\\$&')), hm.slice(hm.indexOf('odd attributes'), hm.indexOf('odd attributes') + 500));
  ok('markdown: lines that would read as a list, a heading, a rule or a quote are written as text', hm.includes('1\\. not a list') && hm.includes('\\- not a bullet') && hm.includes('\\# not a heading') && hm.includes('\\---') && hm.includes('\\> not a quote'), hm.slice(-300));
  ok('markdown: a fence inside a code cell is out-fenced by a longer one, so the cell cannot be left early', hm.includes('````xscriptalert1script\n```\nclosing fence inside\n```\n````'), hm.slice(hm.indexOf('````') - 5, hm.indexOf('````') + 200));
  ok('markdown: an unknown block is the text it holds', hm.includes('text of a block this file does not know'));

  // a deep page, and a page with more nodes than the budget
  // built top-down, into an element that is already in the document, as the store's test does: built bottom-up, Yjs itself recurses
  const deepDoc = (container, leafKind) => {
    const d = new Y.Doc(), f = d.getXmlFragment('prosemirror'); let cur = el(container, {}, []); f.push([cur]);
    for (let i = 0; i < 5000; i++) { const nx = el(container, {}, []); if (leafKind === 'list') { const li = el('list_item', {}, []); cur.insert(0, [li]); li.insert(0, [nx]); } else cur.insert(0, [nx]); cur = nx; }
    const p = el('paragraph', { align: 'left', indent: 0 }, []); cur.insert(0, [p]); p.insert(0, [tx(leafKind === 'list' ? 'list bottom' : 'at the bottom')]);
    return Y.encodeStateAsUpdate(d);
  };
  const dd = deepDoc('blockquote');
  let deepMd = null, deepErr = null;
  try { deepMd = md('deep', dd); html('deep', dd); } catch (e) { deepErr = e.message; }
  ok('a quote nested five thousand deep is written without overflowing the stack, with its text (the deep part is plain)', deepErr === null && deepMd.includes('at the bottom'), deepErr);
  let dlErr = null, dlMd = null;
  try { dlMd = md('deep list', deepDoc('bullet_list', 'list')); } catch (e) { dlErr = e.message; }
  ok('and so is a list nested five thousand deep', dlErr === null && dlMd.includes('list bottom'), dlErr);
  const many = []; for (let i = 0; i < 1500; i++) many.push(para([['paragraph ' + i]]));
  const manyUpdate = docOf(many);
  ok('a page with many paragraphs is written whole (1,500 of them)', md('many', manyUpdate).includes('paragraph 1499') && md('many', manyUpdate).split('\n\n').length >= 1500);
  const flat = new Y.Doc(); const frag = flat.getXmlFragment('prosemirror'); const batch = [];
  for (let i = 0; i < E.MAX_NODES + 50; i++) batch.push(el('paragraph', {}, []));
  frag.insert(0, batch);
  const flatText = md('flat', Y.encodeStateAsUpdate(flat));
  ok('a page with more nodes than the budget stops there and says the rest was too large', /\*The rest of this page was too large to be put in the file\.\*/.test(flatText), flatText.slice(-120));

  // ================================================================ what is not a page, and the names of files
  ok('a page with nothing in it is a file with its name and nothing else', md('empty', docOf([])) === '# empty\n\n\n' && html('empty', docOf([])).includes('<h1>empty</h1>'));
  ok('a name with markup characters is escaped in the title', md('a <b> & *c*', docOf([])).startsWith('# a \\<b\\> \\& \\*c\\*\n') && html('a <b> & *c*', docOf([])).includes('<title>a &lt;b&gt; &amp; *c*</title>'));
  ok('a format that is not one of the two is refused with a sentence', /markdown" or "html/.test(rejects(() => E.exportPage({ name: 'x', update: fixtureState, format: 'pdf' })) || '') && /markdown" or "html/.test(rejects(() => E.exportPage({ name: 'x', update: fixtureState })) || '') && /markdown" or "html/.test(rejects(() => E.exportPage({ name: 'x', update: fixtureState, format: '__proto__' })) || '') && /markdown" or "html/.test(rejects(() => E.exportPage({ name: 'x', update: fixtureState, format: 'constructor' })) || ''));
  ok('a page that is not bytes is refused with a sentence', /no page to put in a file/.test(rejects(() => E.exportPage({ name: 'x', update: 'text', format: 'html' })) || '') && /no page to put in a file/.test(rejects(() => E.exportPage({ name: 'x', update: null, format: 'html' })) || '') && /no page to put in a file/.test(rejects(() => E.exportPage(null)) || '') === false);
  ok('a document of another kind (text under another name, no editor tree) is a file with the name only', (() => { const d = new Y.Doc(); d.getText('body').insert(0, 'not an editor page'); return md('other', Y.encodeStateAsUpdate(d)) === '# other\n\n\n'; })());
  const names = [['Paris Trip', 'Paris-Trip'], ['paris-trip', 'paris-trip'], ['  --a/b\\c:d*e?  ', 'a-b-c-d-e'], ['', 'wiki-page'], ['***', 'wiki-page'], ['con', 'con-page'], ['NUL', 'NUL-page'], ['com1', 'com1-page'], ['Zoë 🙂 café', 'Zoë-café'], ['x'.repeat(200), 'x'.repeat(80)], ['../../etc/passwd', 'etc-passwd'], ['a.b.c', 'a-b-c']];
  names.forEach(([given, want]) => ok('the file name for the page name ' + JSON.stringify(given.slice(0, 20)) + ' is ' + want + '.md', E.fileName(given, 'md') === want + '.md', E.fileName(given, 'md')));
  ok('a file name never has a slash, a dot but the extension\'s, or a control character', ['a/b', 'a\\b', 'a.b', 'a\u0000b', 'a\nb', '..', '.hidden'].every((n) => /^[^/\\\u0000-\u001f]+\.md$/.test(E.fileName(n, 'md')) && E.fileName(n, 'md').indexOf('.') === E.fileName(n, 'md').length - 3), ['a/b', '..', '.hidden'].map((n) => E.fileName(n, 'md')));
  console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', SOME FAILED' : ''));
})().catch((e) => { console.error('ERROR', e); process.exitCode = 1; });
