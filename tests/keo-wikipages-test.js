// Test for keo-wikipages.js, run without a browser (how the world lists, opens and writes a person's wiki pages, with every check kept in the shell): no
// browser, no authenticator. The store is the real one (keo-wikistore.js over its in-memory backend), the identity is built with keo-did.js,
// edits are real Yjs documents set to the client id the shell hands out, and a spy on the store's `add` records every signed event so the
// test can read what the shell built. Also the store's new page listing (`pages`).
// Usage: node keo-wikipages-test.js
const path = require('path');
const kd = require(path.join(__dirname, '..', 'shell', 'keo-did.js'));
const Y = require(path.join(__dirname, '..', 'shell', 'keo-yjs.js'));
const W = require(path.join(__dirname, '..', 'shell', 'keo-wikilog.js'));
const S = require(path.join(__dirname, '..', 'shell', 'keo-wikistore.js'));
const P = require(path.join(__dirname, '..', 'shell', 'keo-wikipages.js'));
const subtle = globalThis.crypto.subtle;
let passed = 0;
const ok = (name, cond, extra) => { if (!cond) { console.error('FAIL ' + name + (extra !== undefined ? ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 600) : '')); process.exitCode = 1; } else { passed++; console.log('ok   ' + name); } };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e.message; } };

const { makePerson, writer, cidOf } = require(path.join(__dirname, 'wiki-fixtures.js'));

// A clock the tests can read: each call is one second later, so "newest change first" has something to be checked against.
function ticker() { let t = Date.UTC(2026, 10, 18, 9, 0, 0); return () => new Date(t += 1000).toISOString(); }

async function setup(person, dev) {
  const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const backend = S.memoryBackend();
  const store = S.create({ backend, key, did: person.did, now: ticker() });
  const adds = [], offers = [];
  const spied = Object.assign({}, store, { add: async (env) => { adds.push(env); return store.add(env); }, offerLog: async (did, log) => { offers.push(did); return store.offerLog(did, log); } });
  const state = { signedIn: true, current: person, hooks: {} };
  // `hooks.afterHeads` runs once, right after the store has answered a `heads` call: a way to let the page change at the one moment a
  // reader that asks for the heads and then the state could read a newer state than the heads it was given.
  spied.heads = async (id) => { const h = await store.heads(id); const f = state.hooks.afterHeads; if (f) { state.hooks.afterHeads = null; await f(); } return h; };
  const identity = {
    proof: async () => { if (!state.signedIn) throw new Error('Sign in first.'); return { did: state.current.did, deviceId: dev.id, log: state.current.snapshot() }; },
    // `lenientSign` is a signer that does not check which identity is signed in, so that a test can see the shell's own check stand alone
    sign: async (bytes, did) => { if (did !== state.current.did && !state.lenientSign) throw new Error('The signed-in identity changed.'); if (state.failSign) throw new Error('signing failed'); return state.current.signer(dev)(bytes); }
  };
  const pages = P.create({ store: spied, identity });
  return { store, backend, pages, adds, offers, state, identity };
}
// The editor's side: a document under the client id the shell gave, holding the page's state.
function editor(opened) {
  const doc = new Y.Doc(); doc.clientID = opened.clientId;
  if (opened.state && opened.state.length) Y.applyUpdate(doc, opened.state);
  let sv = Y.encodeStateVector(doc), n = 0;
  return {
    doc, text: () => doc.getText('body').toString(),
    // changes the page and returns the delta since the last save (what the editor would send)
    change: (fn) => { fn(doc); const u = Y.encodeStateAsUpdate(doc, sv); sv = Y.encodeStateVector(doc); return u; },
    n: () => n++
  };
}
const textOf = (update) => { const d = new Y.Doc(); Y.applyUpdate(d, update); return d.getText('body').toString(); };

(async () => {
  const A = await makePerson(), B = await makePerson();
  const dA2 = await A.addDevice();                        // A's log has an event after the inception, so "the point of the log" is not the trivial one
  const T = await setup(A, A.d1);
  const insert = (s, at) => (d) => d.getText('body').insert(at === undefined ? d.getText('body').length : at, s);

  // ================================================================ nothing yet
  ok('a new device lists no pages', (await T.pages.list()).length === 0);
  ok('the store lists no pages either', (await T.store.pages()).length === 0);

  // ================================================================ open a page that does not exist yet, write it
  const o1 = await T.pages.open({ name: 'notes' });
  ok('opening a new page says it is new', o1.isNew === true && o1.heads.length === 0, o1.heads);
  ok('the page is named by its owner and a name', o1.id === W.pageId(A.did, 'notes') && o1.name === 'notes' && o1.owner === A.did && o1.mine === true, o1.id);
  ok('the owner may write a page that does not exist yet', o1.canEdit === true);
  ok('a new page has an empty state', o1.state instanceof Uint8Array && textOf(o1.state) === '');
  ok('the session and the client id are handed out', typeof o1.session === 'string' && o1.session.length >= 16 && Number.isSafeInteger(o1.clientId) && o1.clientId > 0, o1.clientId);
  ok('opening put the identity\'s own log in the log book', !!(await T.store.logOf(A.did)));
  ok('a page with nothing saved is not listed (it exists once it has an edit)', (await T.pages.list()).length === 0);

  const e1 = editor(o1);
  const u1 = e1.change(insert('hello'));
  const r1 = await T.pages.edit({ session: o1.session, n: e1.n(), update: u1 });
  ok('the first edit is accepted and saved', r1.status === 'accepted' && r1.saved === true && typeof r1.cid === 'string', r1);
  const ev1 = T.adds[0].event;
  ok('the shell built the event: page, author, device, no parents', ev1.objId === o1.id && ev1.author.did === A.did && ev1.author.deviceId === A.d1.id && ev1.parents.length === 0);
  ok('the event carries the client id the editor was given, derived from its nonce', ev1.clients.length === 1 && ev1.clients[0].id === o1.clientId && ev1.clients[0].id === await W.clientIdFor(A.d1.id, o1.id, ev1.clients[0].nonce));
  ok('the event names the point of the author\'s log', JSON.stringify(ev1.authorLog) === JSON.stringify(await W.logPoint(A.snapshot())));
  ok('the store holds the text', textOf((await T.store.state(o1.id)).update) === 'hello');
  ok('the store has one head, the new event', JSON.stringify(await T.store.heads(o1.id)) === JSON.stringify([r1.cid]));

  const u2 = e1.change(insert(' world'));
  const r2 = await T.pages.edit({ session: o1.session, n: e1.n(), update: u2 });
  ok('a second edit is accepted', r2.status === 'accepted' && r2.saved === true, r2);
  ok('the second edit follows the first', JSON.stringify(T.adds[1].event.parents) === JSON.stringify([r1.cid]));
  ok('the store has one head, the second event', JSON.stringify(await T.store.heads(o1.id)) === JSON.stringify([r2.cid]));

  // ================================================================ the list
  let rows = await T.pages.list();
  ok('the page is listed once it has an edit', rows.length === 1 && rows[0].name === 'notes' && rows[0].mine === true && rows[0].versions === 2 && rows[0].pending === 0 && rows[0].id === o1.id, rows);
  ok('the list says when this device last took a change into it (its own clock)', typeof rows[0].updated === 'string' && /^2026-11-18T/.test(rows[0].updated), rows[0].updated);

  // ================================================================ a retry gets the same answer and builds nothing
  const before = T.adds.length;
  const again = await T.pages.edit({ session: o1.session, n: 1, update: u2 });
  ok('the same save again (an answer lost on the way) gets the earlier answer', again.status === 'accepted' && again.cid === r2.cid && again.saved === true, again);
  ok('and builds no second event', T.adds.length === before);
  ok('the same number with different bytes is refused', /already used for a different change/.test(await rejects(T.pages.edit({ session: o1.session, n: 1, update: u1 })) || ''));
  ok('an older number is refused', /older than one already made/.test(await rejects(T.pages.edit({ session: o1.session, n: 0, update: u1 })) || ''));
  ok('none of that added an event', T.adds.length === before);

  // ================================================================ open again: the same text, a fresh id
  const o2 = await T.pages.open({ name: 'notes' });
  ok('reopening gives the saved text', textOf(o2.state) === 'hello world' && o2.isNew === false && JSON.stringify(o2.heads) === JSON.stringify([r2.cid]));
  ok('reopening gives a fresh session and a fresh client id', o2.session !== o1.session && o2.clientId !== o1.clientId);
  const e2 = editor(o2);
  ok('the editor holds the saved text', e2.text() === 'hello world');
  const r3 = await T.pages.edit({ session: o2.session, n: e2.n(), update: e2.change(insert('!')) });
  ok('an edit from the new session is accepted', r3.status === 'accepted', r3);
  ok('it follows the heads the page had when it was opened', JSON.stringify(T.adds[T.adds.length - 1].event.parents) === JSON.stringify([r2.cid]));
  ok('it carries the new nonce and the new id', T.adds[T.adds.length - 1].event.clients[0].id === o2.clientId && T.adds[T.adds.length - 1].event.clients[0].nonce !== ev1.clients[0].nonce);
  ok('the page reads back whole', textOf((await T.store.state(o1.id)).update) === 'hello world!');
  // the first session is still open and now behind: its next edit follows ITS heads (the second event), which makes a second head
  const r3b = await T.pages.edit({ session: o1.session, n: e1.n(), update: e1.change(insert('?')) });
  ok('an older session of the same page may still save: it makes a second head, never overwrites', r3b.status === 'accepted' && (await T.store.heads(o1.id)).length === 2, r3b);
  ok('both edits are in the page (the order of two inserts at one spot is the CRDT\'s)', /^hello world(!\?|\?!)$/.test(textOf((await T.store.state(o1.id)).update)), textOf((await T.store.state(o1.id)).update));

  // ================================================================ what the world must not be able to do
  const o4 = await T.pages.open({ name: 'strict' });
  const bad = new Y.Doc(); bad.clientID = o4.clientId + 1;                    // another client id than the one handed out
  const sv0 = Y.encodeStateVector(bad); bad.getText('body').insert(0, 'forged');
  const rBad = await T.pages.edit({ session: o4.session, n: 0, update: Y.encodeStateAsUpdate(bad, sv0) });
  ok('an edit under a client id that was not handed out is refused by the store', rBad.status === 'refused' && rBad.saved === false && typeof rBad.error === 'string', rBad);
  ok('and nothing of it is kept', (await T.store.heads(o4.id)).length === 0 && !(await T.pages.list()).some((r) => r.name === 'strict'));
  const e4 = editor(o4);
  const r4 = await T.pages.edit({ session: o4.session, n: 0, update: e4.change(insert('fine')) });
  ok('the same number may be used again after a refusal, with the right bytes', r4.status === 'accepted' && r4.saved === true, r4);
  ok('the refused attempt did not move the session', T.adds[T.adds.length - 1].event.parents.length === 0);

  // a page somebody else owns: readable if held, never writable by a person the owner did not list
  const oB = await T.pages.open({ id: W.pageId(B.did, 'theirs') });
  ok('a page of another owner opens read-only', oB.canEdit === false && oB.mine === false && oB.isNew === true);
  const eB = editor(oB);
  const rB = await T.pages.edit({ session: oB.session, n: 0, update: eB.change(insert('not mine')) });
  ok('an edit of someone else\'s page is refused', rB.status !== 'accepted' && rB.saved === false, rB);
  ok('and nothing is kept', !(await T.pages.list()).some((r) => r.owner === B.did));
  // which page a world may be started for (the shell's `go`, kind 'wiki'): the identity's own, held or not; someone else's only if held
  const nLoc = T.adds.length, locBefore = (await T.pages.list()).length;
  const lNew = await T.pages.locate({ name: 'never saved' });
  ok('locate: the identity\'s own page that was never saved is a page to go to', lNew.id === W.pageId(A.did, 'never saved') && lNew.name === 'never saved' && lNew.owner === A.did && lNew.mine === true, lNew);
  const lId = await T.pages.locate({ id: W.pageId(A.did, 'notes') });
  ok('locate: the same for a held page of its own, asked for by id', lId.id === W.pageId(A.did, 'notes') && lId.name === 'notes' && lId.mine === true, lId);
  ok('locate: a page of someone else\'s that this device does not hold is refused, with a sentence', /holds no such page/.test(await rejects(T.pages.locate({ id: W.pageId(B.did, 'theirs') })) || ''));
  ok('locate: no name, an empty name and an id that is not a page\'s are refused as open refuses them', /Say which page/.test(await rejects(T.pages.locate({})) || '') && /Say which page/.test(await rejects(T.pages.locate()) || '') && /named by its owner/.test(await rejects(T.pages.locate({ name: '' })) || '') && /not the name of a page/.test(await rejects(T.pages.locate({ id: 'notes' })) || ''));
  ok('locate makes nothing: no event, no page in the list', T.adds.length === nLoc && (await T.pages.list()).length === locBefore && !(await T.pages.list()).some((r) => r.name === 'never saved'));
  // once B's page is held (here: B's own first edit delivered), it is listed as not mine and readable
  await T.store.offerLog(B.did, B.snapshot());
  const wB = await writer(B, B.d1, undefined, W.pageId(B.did, 'theirs'));
  const envB = await wB.publish(insert('from B'), []);
  ok('B\'s own edit is taken by the store', (await T.store.add(envB)).status === 'accepted');
  rows = await T.pages.list();
  ok('the list now shows both pages, and which is mine', rows.length === 3 && rows.filter((r) => r.mine).length === 2 && rows.filter((r) => !r.mine).length === 1, rows.map((r) => r.name + ':' + r.mine));
  ok('the list is newest change first', rows[0].updated >= rows[1].updated && rows[1].updated >= rows[2].updated, rows.map((r) => r.updated));
  const oB2 = await T.pages.open({ id: W.pageId(B.did, 'theirs') });
  ok('reading B\'s page gives B\'s text', textOf(oB2.state) === 'from B' && oB2.canEdit === false && oB2.isNew === false);
  const lB = await T.pages.locate({ id: W.pageId(B.did, 'theirs') });
  ok('locate: a page of someone else\'s that this device holds is a page to go to, and is not mine', lB.id === W.pageId(B.did, 'theirs') && lB.owner === B.did && lB.mine === false, lB);

  // ================================================================ sessions
  ok('an unknown session is refused', /not open for editing/.test(await rejects(T.pages.edit({ session: 'nope', n: 0, update: u1 })) || ''));
  ok('a missing session is refused', /not open for editing/.test(await rejects(T.pages.edit({ n: 0, update: u1 })) || ''));
  const o5 = await T.pages.open({ name: 'closing' }); await T.pages.close({ session: o5.session });
  ok('a closed session is refused', /not open for editing/.test(await rejects(T.pages.edit({ session: o5.session, n: 0, update: u1 })) || ''));

  // every session given up at once (the world frame that held the editors is being replaced): none can be written to, new ones open as before
  const oAll1 = await T.pages.open({ name: 'all closed 1' }), oAll2 = await T.pages.open({ name: 'all closed 2' });
  T.pages.closeAll();
  ok('closeAll: no session is left to write to', /not open for editing/.test(await rejects(T.pages.edit({ session: oAll1.session, n: 0, update: u1 })) || '') && /not open for editing/.test(await rejects(T.pages.edit({ session: oAll2.session, n: 0, update: u1 })) || ''));
  const oAll3 = await T.pages.open({ name: 'all closed 1' }), eAll3 = editor(oAll3);
  const rAll3 = await T.pages.edit({ session: oAll3.session, n: 0, update: eAll3.change(insert('after')) });
  ok('closeAll: a page opened afterwards is written as usual (it keeps nothing else: the identity\'s log stays offered)', rAll3.status === 'accepted' && rAll3.saved === true, rAll3);

  // two saves started without waiting for each other: one after the other, the second follows the first
  const o6 = await T.pages.open({ name: 'quick' }), e6 = editor(o6);
  const ua = e6.change(insert('one ')), ub = e6.change(insert('two'));
  const n0 = T.adds.length;
  const [ra, rb] = await Promise.all([T.pages.edit({ session: o6.session, n: 0, update: ua }), T.pages.edit({ session: o6.session, n: 1, update: ub })]);
  ok('two saves in flight at once are both accepted', ra.status === 'accepted' && rb.status === 'accepted', [ra, rb]);
  ok('the second follows the first, so the device never forks its own history', T.adds.length === n0 + 2 && JSON.stringify(T.adds[n0 + 1].event.parents) === JSON.stringify([ra.cid]) && (await T.store.heads(o6.id)).length === 1);
  ok('the page holds both', textOf((await T.store.state(o6.id)).update) === 'one two');

  // ================================================================ what an edit may be
  const o7 = await T.pages.open({ name: 'inputs' });
  const nA = T.adds.length;
  ok('an empty change is refused', /nothing to save/.test(await rejects(T.pages.edit({ session: o7.session, n: 0, update: new Uint8Array(0) })) || ''));
  ok('a change that is not bytes is refused', /nothing to save/.test(await rejects(T.pages.edit({ session: o7.session, n: 0, update: 'text' })) || ''));
  ok('a change without a save number is refused', /needs a number/.test(await rejects(T.pages.edit({ session: o7.session, update: u1 })) || ''));
  ok('a negative or fractional save number is refused', /needs a number/.test(await rejects(T.pages.edit({ session: o7.session, n: -1, update: u1 })) || '') && /needs a number/.test(await rejects(T.pages.edit({ session: o7.session, n: 1.5, update: u1 })) || ''));
  ok('a change over the size of an event is refused before anything is built', /larger than a page edit/.test(await rejects(T.pages.edit({ session: o7.session, n: 0, update: new Uint8Array(W.MAX_UPDATE_BYTES + 1) })) || ''));
  ok('none of those built an event', T.adds.length === nA);
  const e7 = editor(o7);
  const buf = e7.change(insert('as a buffer')).buffer.slice(0);                 // the world may hand the bytes over as a whole ArrayBuffer
  const rBuf = await T.pages.edit({ session: o7.session, n: 0, update: buf }).catch((e) => ({ saved: false, error: e.message }));
  ok('a whole ArrayBuffer is taken as the bytes', rBuf.saved === true, rBuf);
  ok('a name the page id cannot hold is refused with a sentence', /named by its owner/.test(await rejects(T.pages.open({ name: '' })) || '') && /named by its owner/.test(await rejects(T.pages.open({ name: 'a\u0000b' })) || '') && /named by its owner/.test(await rejects(T.pages.open({ name: 'x'.repeat(129) })) || ''));
  ok('an id that is not a page is refused', /not the name of a page/.test(await rejects(T.pages.open({ id: 'notes' })) || ''));
  ok('asking for nothing is refused', /Say which page/.test(await rejects(T.pages.open({})) || '') && /Say which page/.test(await rejects(T.pages.open()) || ''));

  // the real editor writes a tree of XML nodes, not text: that must pass the shell's reader and the store's checks too
  const o8 = await T.pages.open({ name: 'xml' }), d8 = new Y.Doc(); d8.clientID = o8.clientId;
  const frag = d8.getXmlFragment('prosemirror'), para = new Y.XmlElement('paragraph'), tx = new Y.XmlText(); tx.insert(0, 'a paragraph'); para.insert(0, [tx]); frag.insert(0, [para]);
  const r8 = await T.pages.edit({ session: o8.session, n: 0, update: Y.encodeStateAsUpdate(d8) });
  ok('an edit made of XML nodes (what the editor writes) is accepted', r8.status === 'accepted', r8);
  const back = new Y.Doc(); Y.applyUpdate(back, (await T.pages.open({ name: 'xml' })).state);
  ok('and comes back as the same tree', back.getXmlFragment('prosemirror').toString() === '<paragraph>a paragraph</paragraph>', back.getXmlFragment('prosemirror').toString());

  // ================================================================ the identity changes under an open page
  const o9 = await T.pages.open({ name: 'identity' }), e9 = editor(o9);
  const nC = T.adds.length;
  T.state.failSign = true;
  ok('an edit that cannot be signed is refused with the reason', /signing failed/.test(await rejects(T.pages.edit({ session: o9.session, n: 0, update: e9.change(insert('x')) })) || ''));
  T.state.failSign = false;
  ok('nothing was added', T.adds.length === nC);
  const keep = T.state.current; T.state.current = B;
  ok('after the signed-in identity changed, an open page is not written', /identity changed/.test(await rejects(T.pages.edit({ session: o9.session, n: 0, update: e9.change(insert('y')) })) || ''));
  T.state.current = keep;
  ok('nothing was added for the other identity', T.adds.length === nC);
  // the shell's own check, with a signer that would sign for anybody: it must stop before the other identity's log is even offered
  T.state.lenientSign = true; T.state.current = B;
  const nOffers = T.offers.length;
  ok('the shell itself refuses to write an open page as another identity', /identity changed/.test(await rejects(T.pages.edit({ session: o9.session, n: 0, update: e9.change(insert('z')) })) || ''));
  T.state.current = keep; T.state.lenientSign = false;
  ok('and nothing was offered to the log book on the way', T.adds.length === nC && T.offers.length === nOffers, [T.offers.length, nOffers]);
  // closed while a save waits for its turn
  const oW = await T.pages.open({ name: 'waiting' }), eW = editor(oW);
  const nW = T.adds.length;
  const w1 = T.pages.edit({ session: oW.session, n: 0, update: eW.change(insert('a')) }), w2 = T.pages.edit({ session: oW.session, n: 1, update: eW.change(insert('b')) });
  await T.pages.close({ session: oW.session });
  const wr = await Promise.all([rejects(w1), rejects(w2)]);
  ok('a page closed while saves wait for their turn is not written', /not open for editing/.test(wr[0] || '') && /not open for editing/.test(wr[1] || '') && T.adds.length === nW, wr);
  // the page changes between the moment its heads are read and the moment its state is read
  const oR = await T.pages.open({ name: 'race' }), eR = editor(oR);
  const rR = await T.pages.edit({ session: oR.session, n: 0, update: eR.change(insert('base')) });
  const wR = await writer(A, dA2, undefined, oR.id);
  T.state.hooks.afterHeads = async () => { await T.store.add(await wR.publish(insert('X'), [rR.cid])); };
  const oR2 = await T.pages.open({ name: 'race' });
  ok('the state handed out is the state at the heads handed out, even if the page changed in between', textOf(oR2.state) === 'base' && JSON.stringify(oR2.heads) === JSON.stringify([rR.cid]), [textOf(oR2.state), oR2.heads]);
  ok('(the change really happened)', /^(baseX|Xbase)$/.test(textOf((await T.store.state(oR.id)).update)), textOf((await T.store.state(oR.id)).update));
  T.state.signedIn = false;
  ok('nobody signed in: listing, opening and saving all say so', /Sign in/.test(await rejects(T.pages.list()) || '') && /Sign in/.test(await rejects(T.pages.open({ name: 'z' })) || '') && /Sign in/.test(await rejects(T.pages.edit({ session: o9.session, n: 0, update: u1 })) || ''));
  T.state.signedIn = true;
  T.pages.reset();
  ok('when the session ends no open page stays', /not open for editing/.test(await rejects(T.pages.edit({ session: o9.session, n: 0, update: u1 })) || ''));

  // ================================================================ room for open pages
  const T2 = await setup(A, A.d1);
  const full = [];
  for (let i = 0; i < P.MAX_SESSIONS; i++) full.push(await T2.pages.open({ name: 'p' + i }));
  const e0 = editor(full[0]);
  ok('the first of a full house still saves', (await T2.pages.edit({ session: full[0].session, n: 0, update: e0.change(insert('used')) })).saved === true);
  const extra = await T2.pages.open({ name: 'p-extra' }), eX = editor(extra);
  ok('the page left unused longest is dropped when there is no room', /not open for editing/.test(await rejects(T2.pages.edit({ session: full[1].session, n: 0, update: u1 })) || ''));
  ok('a page that was just saved is kept, though it was opened first', (await T2.pages.edit({ session: full[0].session, n: 1, update: e0.change(insert(' again')) })).saved === true);
  ok('the new one saves', (await T2.pages.edit({ session: extra.session, n: 0, update: eX.change(insert('x')) })).saved === true);

  // ================================================================ the store's own listing
  const pagesNow = await T.store.pages();
  // the pages that have an accepted edit by now: notes, strict, theirs (B's), quick, inputs, xml, race, and "all closed 1" (written after
  // closeAll); the others were opened, located or refused, never saved
  const heldNames = pagesNow.map((p) => W.parsePageId(p.objId).name).sort();
  ok('the store lists every page it holds, and only those', JSON.stringify(heldNames) === JSON.stringify(['all closed 1', 'inputs', 'notes', 'quick', 'race', 'strict', 'theirs', 'xml']), heldNames);
  ok('the listing is newest change first, with the counts', pagesNow.every((p, i) => i === 0 || p.touched <= pagesNow[i - 1].touched) && pagesNow.filter((p) => p.versions === 2).length === 2 && pagesNow.filter((p) => W.parsePageId(p.objId).name === 'notes')[0].versions === 4, pagesNow.map((p) => p.touched + ' ' + p.versions));
  const T3 = await setup(A, A.d1);
  await T3.store.offerLog(A.did, A.snapshot());
  const w3 = await writer(A, A.d1, undefined, W.pageId(A.did, 'older'));
  await T3.store.add(await w3.publish(insert('x'), []));
  const rec = (await T3.store.pages())[0];
  ok('a page record carries when it was last changed', rec.touched && rec.versions === 1 && rec.pending === 0, rec);
  // an edit that waits for a parent that has not arrived is counted as pending, and not as a version
  const waiting = await w3.publish(insert('y'), ['A'.repeat(43)]);
  ok('an edit with an unknown parent waits', (await T3.store.add(waiting)).status === 'pending');
  const rec2 = (await T3.store.pages())[0];
  ok('the listing counts what waits apart from what is held', rec2.versions === 1 && rec2.pending === 1, rec2);

  // ================================================================ what the list shows of a page: created, category, tags; one damaged page
  const T4 = await setup(A, A.d1);
  const oc = await T4.pages.open({ name: 'places' }), ec = editor(oc);
  const rc = await T4.pages.edit({ session: oc.session, n: ec.n(), update: ec.change((d) => { d.getText('body').insert(0, 'Paris'); const m = d.getMap('meta'); m.set('category', 'Place'); m.set('tags', ['France', 'Europe']); }) });
  const op = await T4.pages.open({ name: 'plain' }), ep = editor(op);
  await T4.pages.edit({ session: op.session, n: ep.n(), update: ep.change(insert('just text')) });
  // A listing that throws must fail the checks below BY NAME, not end the run: `listed` gives the rows, or [] and the error.
  let lastError = null;
  const listed4 = async () => { try { lastError = null; return await T4.pages.list(); } catch (e) { lastError = String(e && e.message || e); return []; } };
  let rows4 = await listed4();
  const byName = (rs, n) => rs.filter((r) => r.name === n)[0] || { name: null, category: 'MISSING', tags: ['MISSING'], created: 'MISSING', unreadable: 'MISSING' };
  ok('setup: both pages are saved and listed', rc.saved === true && rows4.length === 2 && !lastError, lastError || rows4);
  ok('a page that sets its meta is listed with that category and those tags', byName(rows4, 'places').category === 'Place' && JSON.stringify(byName(rows4, 'places').tags) === JSON.stringify(['France', 'Europe']), byName(rows4, 'places'));
  ok('a page with no meta is listed with no category and no tags', byName(rows4, 'plain').category === null && Array.isArray(byName(rows4, 'plain').tags) && byName(rows4, 'plain').tags.length === 0, byName(rows4, 'plain'));
  ok('each row says when its page was created (an edit\'s own date) and that it is readable', rows4.every((r) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(r.created) && r.unreadable === false), rows4.map((r) => r.created + ' ' + r.unreadable));
  await T4.pages.edit({ session: oc.session, n: ec.n(), update: ec.change((d) => { d.getMap('meta').set('category', 'Event'); }) });
  rows4 = await listed4();
  ok('a category changed in a later edit shows in the list at once (the kept summary is not stale)', byName(rows4, 'places').category === 'Event' && JSON.stringify(byName(rows4, 'places').tags) === JSON.stringify(['France', 'Europe']), byName(rows4, 'places'));
  // a page whose stored history is damaged (a version its record lists is gone) is still listed, and does not take the others with it
  const ob = await T4.pages.open({ name: 'broken' }), eb = editor(ob);
  const rBroken = await T4.pages.edit({ session: ob.session, n: eb.n(), update: eb.change(insert('soon damaged')) });
  await T4.backend.del('version', rBroken.cid);
  await T4.store.unload();                                // what is held in memory is forgotten, so the damage is met when the page is read again
  rows4 = await listed4();
  ok('listing with one damaged page among the others does not fail', !lastError && rows4.length === 3, lastError);
  ok('a page with a missing version is still listed, and marked unreadable, with nothing but its name', rows4.length === 3 && byName(rows4, 'broken').unreadable === true && byName(rows4, 'broken').category === null && byName(rows4, 'broken').tags.length === 0 && byName(rows4, 'broken').created === null, rows4);
  ok('the other pages are listed as before', byName(rows4, 'places').category === 'Event' && byName(rows4, 'plain').unreadable === false && byName(rows4, 'places').unreadable === false);
  ok('setup check: the version record really is gone from the disk', (await T4.backend.get('version', rBroken.cid)) === undefined);

  console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', SOME FAILED' : ''));
})().catch((e) => { console.error('ERROR', e); process.exitCode = 1; });
