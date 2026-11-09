// Keeping a friend's card (where their device can be asked to connect): shell/keo-hello.js cardBuild/verifyCard/mergeCard signed by a REAL
// device key of a signed-in identity, stored in the encrypted friend book (shell/keo-contacts.js setCard/cards).
// Usage: node keo-card-test.js <repo root> <extension folder> <work dir>
// One headed browser, a virtual authenticator, `localhost` unresolvable. The signed-in identity is its own "friend" here: a second device
// is not needed to test the storage, and the signature rules between two identities are checked without a browser in keo-hello-test.js.
// NOT covered: a card travelling over a connection or a code swap (nothing sends cards yet), a card from a second real device, a real authenticator.
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const ID = 'keoapnoighmdpncpbfffhcdgdjgjmpdn';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0, passed = 0;
function check(name, ok, detail) { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 700) : '')); }

const worldFrame = (page) => page.frames().find((f) => /world\.html$/.test(f.url()));
async function waitForWorld(page, kind) {
  for (let i = 0; i < 200; i++) {
    const f = worldFrame(page);
    if (f) { try { if (await f.evaluate((k) => !!(window.$world && window.$world.submorphs && window.keo && window.keo.init && window.keo.init.startup && window.keo.init.startup.kind === k), kind)) { await sleep(1500); return f; } } catch (e) {} }
    await sleep(300);
  }
  throw new Error('the world did not start as ' + kind);
}

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-card'), {
    headless: false, viewport: { width: 1200, height: 800 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] });
  await sleep(2000);
  try {
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
    await page.goto(`chrome-extension://${ID}/start.html#guest`);
    const frame = await waitForWorld(page, 'guest');
    const created = await page.evaluate(() => window.keoIdentity.create({ label: 'Maya' }));
    check('setup: an identity is made and signed in', !!created && !!created.did && !!(await page.evaluate(() => window.keoIdentity.sessionWorldKey())));
    const did = created.did;
    await page.evaluate(() => window.keoContacts.ensure());
    await page.evaluate((d) => window.keoContacts.add(d, 'Stand-in friend'), did);

    // A card signed by this device's real key, the way the shell signs a dial request.
    const mk = (helpers, seq, extra) => page.evaluate(async ([helpers, seq, extra]) => {
      const proof = await window.keoIdentity.deviceProof();
      const h = window.keoHello.cardBuild(proof, { helpers, seq });
      const sig = await window.keoIdentity.signWithDevice(window.keoHello.signedBytes(h), proof.did);
      if (extra && extra.edit) h.helpers[0].host = extra.edit;   // changed AFTER signing: a card altered on the way
      return { hello: h, sig };
    }, [helpers, seq, extra || null]);
    const verify = (card) => page.evaluate(([card, did]) => window.keoHello.verifyCard(card, { did, audience: location.origin }), [card, did]);
    const keep = (v) => page.evaluate(([did, v]) => window.keoContacts.setCard(did, v).then((r) => r, (e) => ({ error: e.message })), [did, v]);
    const cards = () => page.evaluate((d) => window.keoContacts.cards(d), did);

    const H1 = [{ kind: 'ws', host: '203.0.113.9', port: 47431 }];
    const c1 = await mk(H1, 1), v1 = await verify(c1);
    check('a card signed by the signed-in device verifies in the page, for this origin', v1.ok === true && v1.did === did && v1.seq === 1, v1);
    check('the card is for an entry that has no cards yet', (await cards()).length === 0);
    check('keeping it changes the book', (await keep(v1)).changed === true);
    const k1 = await cards();
    check('the entry now lists that device, its helpers and its version', k1.length === 1 && k1[0].seq === 1 && k1[0].helpers[0].host === '203.0.113.9' && k1[0].deviceId === v1.deviceId, k1);
    check('keeping the same card again changes nothing', (await keep(v1)).changed === false);

    const v2 = await verify(await mk([{ kind: 'http', host: 'home.example.org', port: 8443 }], 2));
    check('a newer card replaces the helpers', (await keep(v2)).changed === true && (await cards())[0].helpers[0].host === 'home.example.org');
    const vOld = await verify(await mk(H1, 1));
    check('an older card cannot roll them back', (await keep(vOld)).changed === false && (await cards())[0].seq === 2);

    // a forged card must not verify, and what does not verify must not be kept
    const forged = await mk(H1, 5, { edit: '203.0.113.66' });
    const vf = await verify(forged);
    check('a card whose helper was changed after signing is refused', vf.ok === false && /signature/.test(vf.error), vf);
    check('and a refused card cannot be kept', !!(await keep(vf)).error && (await cards())[0].seq === 2);

    // not a friend
    const other = 'did:keo:other-device-that-was-never-added';
    const stranger = await page.evaluate(([v, d]) => window.keoContacts.setCard(d, Object.assign({}, v, { did: d })).then((r) => r, (e) => ({ error: e.message })), [v2, other]);
    check('a card for someone who is not in the list is refused', /not in the list/.test(stranger.error || ''), stranger);
    check('a card made by another identity than the entry\'s is refused', /not from this friend/.test((await page.evaluate(([v, d]) => window.keoContacts.setCard(d, Object.assign({}, v, { did: 'did:keo:somebody-else' })).then(() => '', (e) => e.message), [v2, did]))), 'x');

    // what the world can see
    const listed = await frame.evaluate(() => window.keo.call('friend.list', {}, 20000).then((r) => JSON.stringify(r), (e) => 'ERR ' + e.message));
    check('the list the world can ask for names the friend and holds no card and no address', /Stand-in friend/.test(listed) && !/home\.example\.org|203\.0\.113|devices|helpers/.test(listed), listed);

    // what is on disk
    const raw = await page.evaluate(async (d) => {
      const db = await new Promise((res, rej) => { const q = indexedDB.open('keo-contacts', 1); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      const rec = await new Promise((res) => { const r = db.transaction(['book']).objectStore('book').get(d); r.onsuccess = () => res(r.result); });
      db.close();
      const bytes = rec.ct instanceof Uint8Array ? rec.ct : new Uint8Array(rec.ct);
      return { len: bytes.length, text: new TextDecoder('latin1').decode(bytes), iv: rec.iv };
    }, did);
    check('the stored book holds no address in the clear', raw.len > 0 && !/home\.example\.org|203\.0\.113/.test(raw.text));

    // the memory copy goes, the stored copy comes back
    await page.evaluate(() => { window.keoContacts.clear(); });
    check('with the memory copy gone, no cards are visible', (await cards()).length === 0);
    await page.evaluate(() => window.keoContacts.ensure());
    const k3 = await cards();
    check('read back from the encrypted book, the cards are the same', k3.length === 1 && k3[0].seq === 2 && k3[0].helpers[0].host === 'home.example.org', k3);

    // adding the friend again (a new name) keeps what was learned
    await page.evaluate(([d]) => window.keoContacts.seen(d, Date.now()), [did]);
    await page.evaluate((d) => window.keoContacts.add(d, 'Renamed'), did);
    const after = await page.evaluate((d) => ({ got: window.keoContacts.get(d), cards: window.keoContacts.cards(d) }), did);
    check('adding the friend again takes the new name and keeps the cards and the time last seen', after.got.name === 'Renamed' && !!after.got.seen && after.cards.length === 1 && after.cards[0].seq === 2, after);

    // a second device of the same friend is kept beside the first
    check('a card for a second device is kept beside the first', (await page.evaluate(async ([did]) => {
      const v = Object.assign({}, await window.keoHello.verifyCard(await (async () => { const proof = await window.keoIdentity.deviceProof(); const h = window.keoHello.cardBuild(proof, { helpers: [], seq: 1 }); return { hello: h, sig: await window.keoIdentity.signWithDevice(window.keoHello.signedBytes(h), proof.did) }; })(), { audience: location.origin }), { deviceId: 'second-device-id' });
      const r = await window.keoContacts.setCard(did, v);
      return r.changed && window.keoContacts.cards(did).length === 2;
    }, [did])));

    // removing the friend removes the cards
    await page.evaluate((d) => window.keoContacts.remove(d), did);
    check('removing the friend removes their cards', (await cards()).length === 0);
  } finally { await ctx.close(); }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
