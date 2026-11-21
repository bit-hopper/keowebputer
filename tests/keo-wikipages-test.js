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

const { makePerson, writer, policy, cidOf } = require(path.join(__dirname, 'wiki-fixtures.js'));

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
    // `signGate` (a promise) holds a signature back until the test lets it go: a way to be in the middle of building an edit
    sign: async (bytes, did) => { if (state.signGate) { state.gated = true; await state.signGate; } if (did !== state.current.did && !state.lenientSign) throw new Error('The signed-in identity changed.'); if (state.failSign) throw new Error('signing failed'); return state.current.signer(dev)(bytes); }
  };
  // `state.nowMs` (a number) is the clock of the file export's throttle, so that a test does not have to wait for a second to go by
  const pages = P.create({ store: spied, identity, now: () => (state.nowMs === undefined ? Date.now() : state.nowMs) });
  return { store, backend, pages, adds, offers, state, identity, key };
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
  ok('locate: the identity\'s own page that was never saved is a page to go to', lNew.id === W.pageId(A.did, 'never saved') && lNew.name === 'never saved' && lNew.owner === A.did && lNew.mine === true && lNew.held === false, lNew);
  const lId = await T.pages.locate({ id: W.pageId(A.did, 'notes') });
  ok('locate: the same for a held page of its own, asked for by id', lId.id === W.pageId(A.did, 'notes') && lId.name === 'notes' && lId.mine === true && lId.held === true, lId);
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
  ok('locate: a page of someone else\'s that this device holds is a page to go to, and is not mine', lB.id === W.pageId(B.did, 'theirs') && lB.owner === B.did && lB.mine === false && lB.held === true, lB);

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

  // ================================================================ searching the pages: names, categories, tags and the text
  // The pages are written the way the editor writes them (paragraphs in the `prosemirror` fragment, category and tags in the `meta` map).
  const T5 = await setup(A, A.d1);
  await T5.store.offerLog(B.did, B.snapshot());
  const pEl = (s) => { const el = new Y.XmlElement('paragraph'), t = new Y.XmlText(); t.insert(0, s); el.insert(0, [t]); return el; };
  const writePage = async (name, paragraphs, meta) => {
    const o = await T5.pages.open({ name }), e = editor(o);
    return T5.pages.edit({ session: o.session, n: e.n(), update: e.change((d) => { d.getXmlFragment('prosemirror').push(paragraphs.map(pEl)); if (meta) { const m = d.getMap('meta'); if (meta.category) m.set('category', meta.category); if (meta.tags) m.set('tags', meta.tags); } }) });
  };
  await writePage('paris-trip', ['We stay near the river Seine.', 'Bring the blue bag.'], { category: 'Place', tags: ['France', 'Europe'] });
  await writePage('meeting-notes', ['Budget is the first item.', 'Rome is not Paris, said Zoë.'], { category: 'Event' });
  await writePage('plain', ['just a few words']);
  await writePage('seine-guide', ['nothing about rivers here']);
  const wb = await writer(B, B.d1, undefined, W.pageId(B.did, 'their-page'));
  await T5.store.add(await wb.publish((d) => { d.getXmlFragment('prosemirror').push([pEl('their notes mention the Seine too')]); }, []));
  const found = async (q) => { try { return await T5.pages.search({ query: q }); } catch (e) { return { threw: e.message }; } };
  const names = (r) => Array.isArray(r) ? r.map((x) => x.name) : r;
  let r = await found('seine');
  ok('a word is found in a page\'s name and in the text of others, the name first', JSON.stringify(names(r)) === JSON.stringify(['seine-guide', 'paris-trip', 'their-page']), names(r));
  ok('each hit says where it matched: the name, or the text with a piece of the text around the match', Array.isArray(r) && JSON.stringify(r[0].where) === JSON.stringify(['name']) && r[0].snippet === '' && r[1].where.includes('text') && /river Seine/.test(r[1].snippet), r);
  ok('a hit says whose page it is: the person\'s own, or someone else\'s that this device holds', Array.isArray(r) && r[0].mine === true && r[1].mine === true && r[2].mine === false && r[2].owner === B.did, r);
  ok('a hit carries the page\'s id, category and tags, and no text of the page but the snippet', Array.isArray(r) && r[1].id === W.pageId(A.did, 'paris-trip') && r[1].category === 'Place' && JSON.stringify(r[1].tags) === JSON.stringify(['France', 'Europe']) && r.every((x) => x.text === undefined && x.snippet.length <= 160), r && r[1]);
  r = await found('BUDGET');
  ok('case does not matter, and only the page that has the word is found', JSON.stringify(names(r)) === JSON.stringify(['meeting-notes']) && /Budget is the first item/.test(r[0].snippet), r);
  r = await found('zoe');
  ok('accents do not matter (Zoë is found by "zoe")', JSON.stringify(names(r)) === JSON.stringify(['meeting-notes']), r);
  r = await found('paris river');
  ok('every word has to be found: "paris river" is the page with both (the name has one, the text the other)', JSON.stringify(names(r)) === JSON.stringify(['paris-trip']), names(r));
  r = await found('"is not paris"');
  ok('a quoted phrase is found as a phrase, across the page\'s own sentences', JSON.stringify(names(r)) === JSON.stringify(['meeting-notes']), r);
  r = await found('"paris is not"');
  ok('and not when the words are in another order', Array.isArray(r) && r.length === 0, r);
  r = await found('europe');
  ok('a tag is found, with no snippet (the text did not match)', JSON.stringify(names(r)) === JSON.stringify(['paris-trip']) && r[0].where.join() === 'tags' && r[0].snippet === '', r);
  r = await found('event');
  ok('a category is found the same way', JSON.stringify(names(r)) === JSON.stringify(['meeting-notes']) && r[0].where.join() === 'tags', r);
  r = await found('nosuchword');
  ok('a word nothing holds finds nothing', Array.isArray(r) && r.length === 0, r);
  ok('a query of only spaces or quotes finds nothing, and is not an error', JSON.stringify(await found('   ')) === '[]' && JSON.stringify(await found('""')) === '[]');
  ok('a query that is not text is refused with a sentence', /Say what to search for/.test((await found(undefined)).threw || '') && /Say what to search for/.test((await found(42)).threw || ''), [await found(undefined), await found(42)]);
  const spaced = await found('seine ' + ' '.repeat(5000) + 'zzzzzzzz');
  ok('a query longer than 200 characters is cut (the word after the 5,000 spaces is not looked for), and what is left is answered', Array.isArray(spaced) && names(spaced).includes('seine-guide') && names(spaced).includes('paris-trip'), names(spaced));
  // a change to a page is found at once (the kept text is not stale)
  await writePage('plain', ['and now the lighthouse']);
  r = await found('lighthouse');
  ok('words added to a page are found at once', JSON.stringify(names(r)) === JSON.stringify(['plain']) && /lighthouse/.test(r[0].snippet), r);
  // a page whose stored history is damaged is still found by its name, and does not take the others' results with it
  const oBr = await T5.pages.open({ name: 'broken-seine' }), eBr = editor(oBr);
  const rBr = await T5.pages.edit({ session: oBr.session, n: eBr.n(), update: eBr.change((d) => { d.getXmlFragment('prosemirror').push([pEl('some words')]); }) });
  await T5.backend.del('version', rBr.cid);
  await T5.store.unload();
  r = await found('seine');
  ok('a damaged page is still found by its name, with the others', Array.isArray(r) && names(r).includes('broken-seine') && names(r).includes('paris-trip') && names(r).includes('seine-guide'), r);
  // many pages: the answer is cut to the best fifty
  for (let i = 0; i < 55; i++) await writePage('many-' + String(i).padStart(2, '0'), ['the common word']);
  r = await found('common');
  ok('a word in many pages gives the first fifty, in name order when they rank alike', Array.isArray(r) && r.length === 50 && r[0].name === 'many-00' && r[49].name === 'many-49', r && r.length);
  T5.state.signedIn = false;
  ok('nobody signed in: searching says so', /Sign in/.test((await found('seine')).threw || ''));
  T5.state.signedIn = true;

  // ================================================================ reading a page (no editing session) and deleting one
  const T6 = await setup(A, A.d1);
  await T6.store.offerLog(B.did, B.snapshot());
  const o60 = await T6.pages.open({ name: 'doc' }), e60 = editor(o60);
  await T6.pages.edit({ session: o60.session, n: e60.n(), update: e60.change(insert('first')) });
  const r60 = await T6.pages.edit({ session: o60.session, n: e60.n(), update: e60.change(insert(' second')) });
  const wb6 = await writer(B, B.d1, undefined, W.pageId(B.did, 'theirs'));
  await T6.store.add(await wb6.publish(insert('from B'), []));
  const addsBefore6 = T6.adds.length, offersBefore6 = T6.offers.length, heldBefore6 = (await T6.store.pages()).length;
  let rd = await T6.pages.read({ name: 'doc' });
  ok('read: a page of the person\'s own comes with its text, who made it and may write it', textOf(rd.state) === 'first second' && rd.name === 'doc' && rd.owner === A.did && rd.mine === true && rd.canEdit === true && rd.id === W.pageId(A.did, 'doc'), { name: rd.name, mine: rd.mine, canEdit: rd.canEdit });
  ok('read: how many edits it holds, none waiting, who wrote them, when this device last changed it', rd.versions === 2 && rd.pending === 0 && JSON.stringify(rd.authors) === JSON.stringify([A.did]) && typeof rd.updated === 'string' && /^2026-11-18T/.test(rd.updated), rd);
  ok('read: the page\'s current heads are handed over with the state', JSON.stringify(rd.heads) === JSON.stringify([r60.cid]) && rd.state instanceof Uint8Array, rd.heads);
  ok('read: asked for by id it is the same page', JSON.stringify((await T6.pages.read({ id: W.pageId(A.did, 'doc') })).heads) === JSON.stringify(rd.heads));
  ok('read opens no editing session and writes nothing: no event built, the log book not touched, nothing new held', T6.adds.length === addsBefore6 && T6.offers.length === offersBefore6 && (await T6.store.pages()).length === heldBefore6);
  const rdB = await T6.pages.read({ id: W.pageId(B.did, 'theirs') });
  ok('read: a page someone else made, held here, is read as theirs and cannot be written by this person', textOf(rdB.state) === 'from B' && rdB.mine === false && rdB.canEdit === false && rdB.owner === B.did && JSON.stringify(rdB.authors) === JSON.stringify([B.did]), rdB);
  ok('read: a page that was never saved is not held, and asking makes nothing', /holds no such page/.test(await rejects(T6.pages.read({ name: 'never saved' })) || '') && /holds no such page/.test(await rejects(T6.pages.read({ id: W.pageId(B.did, 'not held') })) || '') && (await T6.store.pages()).length === heldBefore6 && !(await T6.pages.list()).some((x) => x.name === 'never saved'));
  ok('read: no name, an id that is not a page\'s and a name the id cannot hold are refused with sentences', /Say which page/.test(await rejects(T6.pages.read({})) || '') && /Say which page/.test(await rejects(T6.pages.read()) || '') && /not the name of a page/.test(await rejects(T6.pages.read({ id: 'doc' })) || '') && /named by its owner/.test(await rejects(T6.pages.read({ name: '' })) || ''));
  // a waiting edit is counted apart, and its text is not in what is read
  const wDoc = await writer(A, A.d1, undefined, W.pageId(A.did, 'doc'));
  await T6.store.add(await wDoc.publish(insert('lost'), ['B'.repeat(43)]));
  rd = await T6.pages.read({ name: 'doc' });
  ok('read: an edit that waits for something is counted as waiting, and is not in the text', rd.pending === 1 && rd.versions === 2 && textOf(rd.state) === 'first second', { pending: rd.pending, versions: rd.versions });
  // edits of two people: both are named, in the order they first wrote, once each
  await T6.store.add(await policy(A, A.d1, { op: 'add-writer', did: B.did }, rd.heads, { objId: W.pageId(A.did, 'doc') }));
  const wB6 = await writer(B, B.d1, undefined, W.pageId(A.did, 'doc'));
  const heads6 = await T6.store.heads(W.pageId(A.did, 'doc'));
  wB6.apply((await T6.store.state(W.pageId(A.did, 'doc'))).update);
  await T6.store.add(await wB6.publish(insert(' third'), heads6));
  const wB6b = await T6.store.heads(W.pageId(A.did, 'doc'));
  await T6.store.add(await wB6.publish(insert(' fourth'), wB6b));
  rd = await T6.pages.read({ name: 'doc' });
  ok('read: when a listed writer wrote too, both are named once each, the owner first, and the list change is not counted as an edit', JSON.stringify(rd.authors) === JSON.stringify([A.did, B.did]) && rd.versions === 4 && /first second/.test(textOf(rd.state)) && /third/.test(textOf(rd.state)), { authors: rd.authors.length, versions: rd.versions, text: textOf(rd.state) });
  // on a device where nothing has been offered to the log book through the pages yet, reading offers nothing (a reader of a page needs no write path)
  const T7 = await setup(A, A.d1);
  await T7.store.offerLog(A.did, A.snapshot());
  await T7.store.add(await (await writer(A, A.d1, undefined, W.pageId(A.did, 'readonly-case'))).publish(insert('plain'), []));
  const r7 = await T7.pages.read({ name: 'readonly-case' });
  ok('read: on a fresh device it reads the page and offers nothing to the log book and builds no event', textOf(r7.state) === 'plain' && T7.offers.length === 0 && T7.adds.length === 0, [T7.offers.length, T7.adds.length]);
  T6.state.signedIn = false;
  ok('read and delete with nobody signed in say so', /Sign in/.test(await rejects(T6.pages.read({ name: 'doc' })) || '') && /Sign in/.test(await rejects(T6.pages.remove({ id: W.pageId(A.did, 'doc') })) || ''));
  T6.state.signedIn = true;

  // ---- a page as a file (keo-wikiexport.js has its own test; this is what the shell's page operation makes of it)
  {                                                                          // a block of its own: the names below are this section's only
  const TX = await setup(A, A.d1);
  await TX.store.offerLog(B.did, B.snapshot());
  const oX = await TX.pages.open({ name: 'to export' }), eX = editor(oX);
  await TX.pages.edit({ session: oX.session, n: eX.n(), update: eX.change((d) => { d.getXmlFragment('prosemirror').push([pEl('The words of the page.'), pEl('A second paragraph.')]); }) });
  const oY = await TX.pages.open({ name: 'other page' }), eY = editor(oY);
  await TX.pages.edit({ session: oY.session, n: eY.n(), update: eY.change((d) => { d.getXmlFragment('prosemirror').push([pEl('Nothing to do with the first.')]); }) });
  await TX.store.add(await (await writer(B, B.d1, undefined, W.pageId(B.did, 'theirs'))).publish((d) => { d.getXmlFragment('prosemirror').push([pEl('Their words, read here.')]); }, []));
  TX.state.nowMs = 1000000;
  const txtOf = (f) => new TextDecoder().decode(f.bytes);
  const fx = await TX.pages.exportFile({ name: 'to export', format: 'markdown' });
  ok('export: a page of the person\'s own is a Markdown file with its name, type and bytes', fx.name === 'to-export.md' && fx.type === 'text/markdown;charset=utf-8' && fx.bytes instanceof Uint8Array && txtOf(fx) === '# to export\n\nThe words of the page.\n\nA second paragraph.\n', txtOf(fx));
  ok('export: it holds nothing of any other page', !/Nothing to do/.test(txtOf(fx)) && !/Their words/.test(txtOf(fx)));
  const addsX = TX.adds.length, offersX = TX.offers.length;
  ok('export: a second file straight after is refused with a sentence (one a second)', /Wait a moment before saving another file/.test(await rejects(TX.pages.exportFile({ name: 'to export', format: 'html' })) || ''));
  TX.state.nowMs += 999;
  ok('export: and still refused 999 ms later', /Wait a moment/.test(await rejects(TX.pages.exportFile({ id: W.pageId(A.did, 'to export'), format: 'html' })) || ''));
  TX.state.nowMs += 1;
  const fh = await TX.pages.exportFile({ id: W.pageId(A.did, 'to export'), format: 'html' });
  ok('export: a second after the first it is made, as a web page, when the page is asked for by id', fh.name === 'to-export.html' && fh.type === 'text/html;charset=utf-8' && /<p>The words of the page\.<\/p>/.test(txtOf(fh)), fh.name);
  TX.state.nowMs += 5000;
  ok('export: a refusal (a format that is not one, a page that is not held, no name) does not count as a file made, and says why', /markdown" or "html/.test(await rejects(TX.pages.exportFile({ name: 'to export', format: 'pdf' })) || '') && /holds no such page/.test(await rejects(TX.pages.exportFile({ name: 'never saved', format: 'html' })) || '') && /Say which page/.test(await rejects(TX.pages.exportFile({ format: 'html' })) || '') && /Say which page/.test(await rejects(TX.pages.exportFile()) || ''));
  ok('export: so a good request right after the refusals is made', (await TX.pages.exportFile({ name: 'other page', format: 'markdown' })).name === 'other-page.md');
  TX.state.nowMs += 5000;
  const fB = await TX.pages.exportFile({ id: W.pageId(B.did, 'theirs'), format: 'markdown' });
  ok('export: a page someone else made, held here, can be read into a file too', /Their words, read here\./.test(txtOf(fB)) && fB.name === 'theirs.md', txtOf(fB));
  TX.state.nowMs += 5000;
  const two = await Promise.all([TX.pages.exportFile({ name: 'to export', format: 'html' }).then((f) => 'made ' + f.name, (e) => e.message), TX.pages.exportFile({ name: 'to export', format: 'html' }).then((f) => 'made ' + f.name, (e) => e.message)]);
  ok('export: two asked for at once: one is made and the other is told a file is being made', two.filter((x) => /^made /.test(x)).length === 1 && two.filter((x) => /A file is being made/.test(x)).length === 1, two);
  TX.state.nowMs += 5000;
  ok('export: making files changed nothing in the store, built no event and offered nothing to the log book', TX.adds.length === addsX && TX.offers.length === offersX && (await TX.store.pages()).length === 3);
  TX.state.signedIn = false; TX.state.nowMs += 5000;
  ok('export: with nobody signed in it says so', /Sign in/.test(await rejects(TX.pages.exportFile({ name: 'to export', format: 'html' })) || ''));
  TX.state.signedIn = true;
  TX.pages.reset(); TX.state.nowMs = 1;
  const afterReset = await TX.pages.exportFile({ name: 'to export', format: 'html' }).catch((e) => ({ name: 'THREW: ' + e.message }));
  ok('export: when the session ends the wait is forgotten (the next person is not made to wait for the last)', afterReset.name === 'to-export.html', afterReset.name);
  TX.pages.reset();
  }

  // ---- deleting
  const idDoc = W.pageId(A.did, 'doc');
  const o61 = await T6.pages.open({ name: 'doc' }), e61 = editor(o61);
  await T6.pages.search({ query: 'second' });                                 // makes the kept text of the page
  await T6.pages.list();                                                     // and its kept summary
  const dumpBefore = T6.backend.dump(), count = (d, k) => (d[k] || []).length;
  ok('delete setup: the page has versions, a waiting edit, a kept summary and a kept text on disk', count(dumpBefore, 'version') >= 6 && count(dumpBefore, 'pending') === 1 && count(dumpBefore, 'meta') >= 1, Object.keys(dumpBefore).map((k) => k + ':' + dumpBefore[k].length));
  const gone = await T6.pages.remove({ id: idDoc });
  ok('delete answers that it removed the page, with how many versions and waiting edits went', gone.removed === true && gone.versions === 5 && gone.pending === 1, gone);
  const dumpAfter = T6.backend.dump();
  ok('delete: every record of the page is gone from the disk (its versions, its waiting edit, its text), and nothing else is touched but the other page\'s', count(dumpAfter, 'version') === count(dumpBefore, 'version') - 5 && count(dumpAfter, 'pending') === 0 && count(dumpAfter, 'page') === count(dumpBefore, 'page') - 1 && count(dumpAfter, 'log') === count(dumpBefore, 'log') && count(dumpAfter, 'meta') === count(dumpBefore, 'meta') - 1, ['version', 'pending', 'page', 'log', 'meta'].map((k) => k + ' ' + count(dumpBefore, k) + '->' + count(dumpAfter, k)));
  ok('delete: the page is not listed, not found by a search, and cannot be read', !(await T6.pages.list()).some((x) => x.name === 'doc') && (await T6.pages.search({ query: 'second' })).length === 0 && /holds no such page/.test(await rejects(T6.pages.read({ name: 'doc' })) || ''));
  ok('delete: the store holds no heads for it any more (the copy kept in memory went too)', (await T6.store.heads(idDoc)).length === 0);
  ok('delete: the other person\'s page is still there, read as before', textOf((await T6.pages.read({ id: W.pageId(B.did, 'theirs') })).state) === 'from B' && (await T6.pages.list()).some((x) => x.name === 'theirs'));
  ok('delete: an editing session that was open on the page cannot write it any more, and nothing is brought back', /not open for editing/.test(await rejects(T6.pages.edit({ session: o61.session, n: 0, update: e61.change(insert('late')) })) || '') && !(await T6.store.pages()).some((p) => p.objId === idDoc));
  ok('delete: deleting it again says nothing was there, and is not an error', (await T6.pages.remove({ id: idDoc })).removed === false);
  // the same name can be made again, from nothing
  const o62 = await T6.pages.open({ name: 'doc' }), e62 = editor(o62);
  ok('delete: the name is free again: it opens as a new page', o62.isNew === true && o62.heads.length === 0 && textOf(o62.state) === '');
  const r62 = await T6.pages.edit({ session: o62.session, n: e62.n(), update: e62.change(insert('again')) });
  ok('delete: and is written from the start, holding nothing of the old page', r62.saved === true && textOf((await T6.pages.read({ name: 'doc' })).state) === 'again' && (await T6.pages.read({ name: 'doc' })).versions === 1);
  // not someone else's page
  const nDel = (await T6.store.pages()).length;
  ok('delete: a page someone else made is refused with a sentence, and stays', /Only a page you made/.test(await rejects(T6.pages.remove({ id: W.pageId(B.did, 'theirs') })) || '') && (await T6.store.pages()).length === nDel && (await T6.pages.read({ id: W.pageId(B.did, 'theirs') })).versions === 1);
  ok('delete: no name, an id that is not a page\'s are refused with sentences', /Say which page/.test(await rejects(T6.pages.remove({})) || '') && /not the name of a page/.test(await rejects(T6.pages.remove({ id: 'doc' })) || ''));
  ok('delete: asked for by name, a page that was never saved removes nothing and makes nothing', (await T6.pages.remove({ name: 'never saved' })).removed === false && (await T6.store.pages()).length === nDel);
  // a delete that comes while a save is being built: the page must not come back as a page of one edit
  const o63 = await T6.pages.open({ name: 'racing' }), e63 = editor(o63);
  await T6.pages.edit({ session: o63.session, n: e63.n(), update: e63.change(insert('base')) });
  let release; T6.state.signGate = new Promise((res) => { release = res; });
  const late = T6.pages.edit({ session: o63.session, n: e63.n(), update: e63.change(insert(' late')) });
  for (let i = 0; i < 400 && !T6.state.gated; i++) await new Promise((res) => setTimeout(res, 5));
  ok('delete during a save setup: the save is really waiting for its signature', T6.state.gated === true);
  const delRace = await T6.pages.remove({ id: W.pageId(A.did, 'racing') });
  T6.state.signGate = null; release();
  ok('delete during a save: the delete answers, and the save that was waiting for its signature is refused', delRace.removed === true && /not open for editing/.test(await rejects(late) || ''));
  ok('delete during a save: the page did not come back (no record, no version, not listed)', !(await T6.store.pages()).some((p) => p.objId === W.pageId(A.did, 'racing')) && (await T6.store.heads(W.pageId(A.did, 'racing'))).length === 0 && !(await T6.pages.list()).some((x) => x.name === 'racing'));
  // a page whose history cannot be read is still listed, and a person must be able to delete it
  const o64 = await T6.pages.open({ name: 'damaged' }), e64 = editor(o64);
  const r64 = await T6.pages.edit({ session: o64.session, n: e64.n(), update: e64.change(insert('soon damaged')) });
  await T6.backend.del('version', r64.cid); await T6.store.unload();
  ok('delete setup: the damaged page is listed as unreadable', (await T6.pages.list()).filter((x) => x.name === 'damaged')[0].unreadable === true);
  ok('delete: a page whose history cannot be read is removed', (await T6.pages.remove({ name: 'damaged' })).removed === true && !(await T6.pages.list()).some((x) => x.name === 'damaged'));
  // a page whose own record cannot be decrypted takes the whole list down (the store's listing reads every record): deleting it must work
  const o65 = await T6.pages.open({ name: 'garbled' }), e65 = editor(o65);
  await T6.pages.edit({ session: o65.session, n: e65.n(), update: e65.change(insert('x')) });
  // (the page's record is kept under the hash of its id: the same hash the store uses)
  const keyOfGarbled = kd.b64u(await kd.sha256(new TextEncoder().encode('keo-wiki-page\u0000' + W.pageId(A.did, 'garbled'))));
  ok('delete setup: the page\'s record is where the hash says', !!(await T6.backend.get('page', keyOfGarbled)));
  await T6.backend.put('page', keyOfGarbled, { iv: kd.b64u(new Uint8Array(12)), ct: new Uint8Array(40) }); await T6.store.unload();
  ok('delete setup: with one page record garbled the list cannot be read at all', /could not be decrypted/.test(await rejects(T6.pages.list()) || ''));
  ok('delete: the page with the garbled record is removed, and the list reads again', (await T6.pages.remove({ name: 'garbled' })).removed === true && !(await T6.pages.list()).some((x) => x.name === 'garbled'));

  console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', SOME FAILED' : ''));
})().catch((e) => { console.error('ERROR', e); process.exitCode = 1; });
