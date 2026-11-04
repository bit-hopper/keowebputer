// Node test for keo-fingerprint.js and keo-wordlist.js (the eight words two people compare to check a DID): no browser.
// Usage: node keo-fingerprint-test.js
const path = require('path');
const nodeCrypto = require('crypto');
const kd = require(path.join(__dirname, '..', 'shell', 'keo-did.js'));
const fp = require(path.join(__dirname, '..', 'shell', 'keo-fingerprint.js'));
const WORDS = require(path.join(__dirname, '..', 'shell', 'keo-wordlist.js')).WORDS;
let passed = 0;
const ok = (name, cond, extra) => { if (!cond) { console.error('FAIL ' + name + (extra ? ' ' + JSON.stringify(extra) : '')); process.exitCode = 1; } else { passed++; console.log('ok   ' + name); } };

// A DID of the shape the verifier accepts: 52 z-base-32 characters, then the 43-character base64url hash.
const Z32 = 'ybndrfg8ejkmcpqxot1uwisza345h769';
const randDid = () => {
  const z = Array.from(nodeCrypto.randomBytes(52), (b) => Z32[b % 32]).join('');
  return kd.didFor(z, kd.b64u(nodeCrypto.randomBytes(32)));
};
// The same fingerprint, worked out another way (BigInt over the first 11 bytes), to check the bit cutting in the module.
const other = (did) => {
  const h = nodeCrypto.createHash('sha256').update('keo/fingerprint/v1\0' + did).digest();
  let n = 0n; for (let i = 0; i < 11; i++) n = (n << 8n) | BigInt(h[i]);
  const out = []; for (let i = 7; i >= 0; i--) out.push(WORDS[Number((n >> BigInt(i * 11)) & 2047n)]);
  return out;
};

(async () => {
  // ---- the word list
  ok('the list has 2048 distinct words', WORDS.length === 2048 && new Set(WORDS).size === 2048, WORDS.length);
  ok('every word is 3 to 8 lowercase letters', WORDS.every((w) => /^[a-z]{3,8}$/.test(w)));
  ok('no two words share their first four letters (a word misheard at its end can still be told apart)', new Set(WORDS.map((w) => w.slice(0, 4))).size === 2048);
  ok('the list is in alphabetical order, as the specification has it (its first and last words are abandon and zoo)', WORDS.every((w, i) => i === 0 || WORDS[i - 1] < w) && WORDS[0] === 'abandon' && WORDS[2047] === 'zoo');
  // (the hash of english.txt as downloaded from the specification's repository: one word per line, LF line ends)
  ok('the list is pinned: not a word added, dropped or moved', nodeCrypto.createHash('sha256').update(WORDS.join('\n') + '\n').digest('hex') === '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda');

  // ---- the words of a DID
  const d1 = kd.didFor((Z32 + Z32).slice(0, 52), 'A'.repeat(43));
  const w1 = await fp.words(d1);
  ok('a DID gives eight words, all on the list', w1.length === 8 && w1.every((w) => WORDS.includes(w)), w1);
  ok('the same DID gives the same words', JSON.stringify(await fp.words(d1)) === JSON.stringify(w1));
  ok('a known DID gives a known answer (so a change of label, list or cutting is noticed)', w1.join(' ') === 'stadium nuclear start bid heavy kidney account sad', w1.join(' '));
  let agree = true, dids = [];
  for (let i = 0; i < 300; i++) { const d = randDid(); dids.push(d); if (JSON.stringify(await fp.words(d)) !== JSON.stringify(other(d))) agree = false; }
  ok('300 random DIDs: the words agree with an independent working-out', agree);

  // ---- spread
  const seen = new Set(), sets = new Set();
  for (let i = 0; i < 3000; i++) { const w = await fp.words(i < 300 ? dids[i] : randDid()); sets.add(w.join(' ')); w.forEach((x) => seen.add(x)); }
  ok('3000 DIDs give 3000 different sets of words', sets.size === 3000, sets.size);
  ok('the 24000 words drawn cover (nearly) the whole list: no stuck or unused part', seen.size >= 2030, seen.size);
  const flipped = d1.slice(0, -1) + 'B';
  const wf = await fp.words(flipped), same = wf.filter((w, i) => w === w1[i]).length;
  ok('one changed character of a DID changes the words (at most one in eight can match by chance)', wf.join() !== w1.join() && same <= 2, { same });

  // ---- not a DID
  const bad = ['', 'did:keo:short:short', null, undefined, 42, d1 + 'x', d1.replace('did:keo:', 'did:web:'), d1.toUpperCase(), ' ' + d1];
  let refused = 0; for (const b of bad) { try { await fp.words(b); } catch (e) { if (/not a keo identity/.test(e.message)) refused++; } }
  ok('anything that is not a well-formed DID is refused, with a sentence', refused === bad.length, refused);

  // ---- what a person types or reads out
  const said = w1.join(' ');
  ok('the right words match', await fp.matches(d1, said));
  ok('upper case, extra spaces, commas and line breaks do not matter', await fp.matches(d1, '  ' + w1.map((w) => w.toUpperCase()).join(',  ').replace(/, {2}/g, ',\n') + ' \n'));
  ok('the same words in another order do not match', !(await fp.matches(d1, w1.slice().reverse().join(' '))));
  ok('one word changed does not match', !(await fp.matches(d1, w1.map((w, i) => i === 3 ? WORDS[(WORDS.indexOf(w) + 1) % 2048] : w).join(' '))));
  ok('seven words, or nine, are not a check', !(await fp.matches(d1, w1.slice(0, 7).join(' '))) && !(await fp.matches(d1, said + ' ' + w1[0])));
  ok('words of another DID do not match', !(await fp.matches(d1, (await fp.words(dids[0])).join(' '))));
  ok('a word that is not on the list is a slip, told apart from a mismatch (parse says null)', fp.parse(said.replace(w1[0], 'zzzz')) === null && !(await fp.matches(d1, said.replace(w1[0], 'zzzz'))));
  ok('empty, missing and non-text input match nothing', !(await fp.matches(d1, '')) && !(await fp.matches(d1, null)) && !(await fp.matches(d1, undefined)) && !(await fp.matches(d1, 12345)));
  ok('parse keeps order and spells the words as the list does', JSON.stringify(fp.parse('  ABANDON, Ability\nzoo ')) === JSON.stringify(['abandon', 'ability', 'zoo']));

  console.log(process.exitCode ? passed + ' checks passed, SOME FAILED' : passed + ' checks passed');
})();
