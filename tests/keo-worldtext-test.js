// Node test for keo-worldtext.js (what is searchable in a saved world, and the search): no browser.
// Usage: node keo-worldtext-test.js
const path = require('path');
const wt = require(path.join(__dirname, '..', 'shell', 'keo-worldtext.js'));
let passed = 0;
const ok = (name, cond, extra) => { if (!cond) { console.error('FAIL ' + name + (extra ? ' ' + JSON.stringify(extra) : '')); process.exitCode = 1; } else { passed++; console.log('ok   ' + name); } };

// A saved page of the shape the runtime writes: markup, then the world's data in a script element.
const page = (registry, extraBefore) => '<!DOCTYPE html><html><head><title>x</title></head><body>' + (extraBefore || '') +
  '<script type="text/javascript" src="core/lively/bootstrap.js"></script>' +
  '<script type="text/x-lively-world" id="w" data-migrationlevel="9">' + JSON.stringify({ id: '0', registry: Object.assign({ isSimplifiedRegistry: true }, registry) }) + '</script></body></html>';

// ---- extract
const ref = (id) => ({ __isSmartRef__: true, id });
const world = page({
  '0': { name: 'Garden plan', __LivelyClassName__: 'lively.morphic.World', _Fill: 'Color.rgb(240,240,240)', id: 1, undoQueue: [], submorphs: [ref('1'), ref('3'), ref('9')] },
  '1': { __LivelyClassName__: 'lively.morphic.HandMorph', clickedOnMorph: ref('8'), submorphs: [] },
  // as the runtime writes it: the typed string is on the text morph's chunks (and, once serialized again, on the morph too)
  '3': { __LivelyClassName__: 'lively.morphic.Text', textChunks: [ref('5'), ref('6')], submorphs: [] },
  '5': { storedString: 'Tomatoes need   ', __LivelyClassName__: 'lively.morphic.TextChunk' },
  '6': { storedString: 'full sun', __LivelyClassName__: 'lively.morphic.TextChunk' },
  // a text morph inside a box inside the world, two levels down
  '9': { name: 'Box', __LivelyClassName__: 'lively.morphic.Box', submorphs: [ref('10')] },
  '10': { textString: 'Water the café herbs', __LivelyClassName__: 'lively.morphic.Text', submorphs: [] },
  '7': { _Extent: 'lively.pt(2.0,2.0)', _FontSize: 11, droppingEnabled: true },
  // what the world only remembers, and is not in it: the menu item last clicked and a morph in the undo queue
  '8': { __LivelyClassName__: 'lively.morphic.MenuItem', textChunks: [ref('12')] },
  '12': { storedString: 'Save world', __LivelyClassName__: 'lively.morphic.TextChunk' },
  '11': { storedString: 'Removed long ago', name: 'ghost', __LivelyClassName__: 'lively.morphic.Text' }
});
const text = wt.extract(world);
ok('extract: typed text is found', text.indexOf('Tomatoes need full sun') >= 0 && text.indexOf('Water the café herbs') >= 0, text);
ok('extract: a morph name is found, and so is text two levels down', text.indexOf('Garden plan') >= 0 && text.indexOf('Box') >= 0);
ok('extract: what the world only remembers (a clicked menu item, a morph no longer in the world) is not part of it', text.indexOf('Save world') < 0 && text.indexOf('Removed long ago') < 0 && text.indexOf('ghost') < 0, text);
ok('extract: data of a shape it does not know is read flat rather than lost', wt.extract('<script type="text/x-lively-world">' + JSON.stringify({ registry: { a: { storedString: 'flat text' } } }) + '</script>') === 'flat text');
ok('extract: a cycle of submorphs does not loop', wt.extract(page({ '0': { name: 'a', submorphs: [ref('1')] }, '1': { name: 'b', submorphs: [ref('0')] } })) === 'a\nb');
ok('extract: the same string kept on a morph and on its chunk is listed once', text.split('Tomatoes').length === 2, text);
ok('extract: whitespace is collapsed', text.indexOf('  ') < 0);
ok('extract: class names, styles and numbers are left out', text.indexOf('lively.') < 0 && text.indexOf('Color.rgb') < 0 && text.indexOf('11') < 0, text);
ok('extract: markup around the data is not part of it', text.indexOf('<') < 0 && text.indexOf('bootstrap') < 0);
ok('extract: a page with no world data gives nothing', wt.extract('<html><body>hi</body></html>') === '');
ok('extract: data that is not JSON gives nothing', wt.extract('<script type="text/x-lively-world">{not json</script>') === '');
ok('extract: data with no registry gives nothing', wt.extract('<script type="text/x-lively-world">{"id":"0"}</script>') === '');
ok('extract: nothing, null and a number give nothing and do not throw', wt.extract() === '' && wt.extract(null) === '' && wt.extract(5) === '');
ok('extract: a script element of another type is not read', wt.extract('<script type="text/javascript">{"registry":{"1":{"name":"nope"}}}</script>') === '');
const big = page({ '1': { storedString: 'x'.repeat(1000) }, '2': { storedString: 'y'.repeat(1000) } });
ok('extract: the amount kept is capped', wt.extract(big, 1500).length <= 1500 + 1, wt.extract(big, 1500).length);
ok('extract: a string that is not text (an object under the key) is skipped', wt.extract(page({ '1': { name: { a: 1 }, storedString: ['x'] } })) === '');

// ---- terms
ok('terms: words, quoted phrases, case and accents', JSON.stringify(wt.terms('Café  "Big  Idea" X')) === JSON.stringify(['cafe', 'big idea', 'x']), wt.terms('Café  "Big  Idea" X'));
ok('terms: an empty query or only quotes gives no terms', wt.terms('').length === 0 && wt.terms('   ').length === 0 && wt.terms('""').length === 0 && wt.terms(null).length === 0);

// ---- search
const E = [
  { name: 'Garden plan', tags: ['home'], note: 'spring beds', text: 'Tomatoes need full sun\nWater the café herbs' },
  { name: 'Tomato notes', tags: ['recipes', 'garden'], note: '', text: 'sauce and soup' },
  { name: 'Budget', tags: [], note: 'garden costs', text: 'Seeds 12\nSoil 40' },
  { name: 'Sketches', tags: [], note: '', text: '' }
];
const names = (q) => wt.search(E, q).map((h) => h.name);
ok('search: an empty query finds nothing', names('').length === 0 && names('   ').length === 0);
ok('search: a name beats a tag beats a note beats the body', JSON.stringify(names('garden')) === JSON.stringify(['Garden plan', 'Tomato notes', 'Budget']), names('garden'));
ok('search: the body is searched', JSON.stringify(names('sauce')) === JSON.stringify(['Tomato notes']));
ok('search: case does not matter', JSON.stringify(names('SAUCE')) === JSON.stringify(['Tomato notes']));
ok('search: accents do not matter, in either direction', names('cafe').indexOf('Garden plan') >= 0 && names('café').indexOf('Garden plan') >= 0);
ok('search: every word has to be found, in any field', JSON.stringify(names('garden sauce')) === JSON.stringify(['Tomato notes']) && names('garden zzz').length === 0, names('garden sauce'));
ok('search: a quoted phrase is one term', names('"full sun"').length === 1 && names('"sun full"').length === 0);
ok('search: a hit in the body carries a snippet around it', wt.search(E, 'full sun')[0].snippet.indexOf('full sun') >= 0, wt.search(E, 'full sun')[0]);
ok('search: a hit only in the name has no snippet', wt.search(E, 'sketches')[0].snippet === '' && wt.search(E, 'sketches')[0].where.join() === 'name');
ok('search: says where it matched', wt.search(E, 'garden').find((h) => h.name === 'Tomato notes').where.join() === 'tags' && wt.search(E, 'garden').find((h) => h.name === 'Budget').where.join() === 'note');
ok('search: an exact name outranks a longer one', wt.search([{ name: 'Maps of the sea' }, { name: 'Maps' }], 'maps')[0].name === 'Maps');
ok('search: a word at the start of a name outranks the same letters inside a word', wt.search([{ name: 'Overlay' }, { name: 'My lay' }], 'lay')[0].name === 'My lay');
ok('search: ties are in name order', JSON.stringify(wt.search([{ name: 'b', note: 'x' }, { name: 'a', note: 'x' }], 'x').map((h) => h.name)) === JSON.stringify(['a', 'b']));
ok('search: entries with missing fields do not throw', wt.search([{ name: 'a' }, { name: 'b', tags: null, note: null, text: null }], 'a').length === 1);
ok('search: no entries, no hits', wt.search([], 'a').length === 0 && wt.search(null, 'a').length === 0);

console.log(passed + ' checks passed' + (process.exitCode ? ', some FAILED' : ''));
