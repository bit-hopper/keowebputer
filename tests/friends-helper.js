// Shared by the browser tests that need two connected devices to be FRIENDS (messages, calls and file offers are accepted only between
// friends). befriend() does what two people do, through the shell's own dialogs: one asks for the dialog, each types the other's eight
// words (read from the other device's own `friend.words`) and clicks Add with a real click. It is not a way around the dialog: the
// friend test (keo-friend-test.js) is where the dialog itself is tested.
// Needs for each device: { page, frame } (the shell page and the world frame), and the two connection ids { a, b } of one ready connection.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn().catch(() => null); if (v) return v; await sleep(150); } return null; }
const call = (frame, op, args) => frame.evaluate(([o, a]) => window.keo.call(o, a, 60000).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: e.message })), [op, args || {}]);
const conn = (P, id) => P.frame.evaluate((i) => window.keo.call('p2p.list', {}, 20000).then((l) => l.filter((c) => c.id === i)[0] || null), id);
const dialogUp = (P) => P.page.evaluate(() => { const r = document.getElementById('keo-friend'); return !!r && !r.hidden; });

async function friends(A, B, k) { const a = await conn(A, k.a), b = await conn(B, k.b); return !!(a && b && a.friend && b.friend); }

async function befriend(A, B, k, opts) {
  // Devices that added each other before tell each other so as soon as they connect: nothing to do but wait for it.
  if (await poll(() => friends(A, B, k), (opts && opts.settleMs) || 4000)) return true;
  const words = { a: (await call(A.frame, 'friend.words')).r, b: (await call(B.frame, 'friend.words')).r };
  for (const [P, id, theirs] of [[A, k.a, words.b], [B, k.b, words.a]]) {
    const c = await conn(P, id);
    if (c && c.added) continue;
    await P.page.bringToFront();
    if (!(await poll(() => dialogUp(P), 1500))) {                       // the other side's "I added you" brings it up on its own; otherwise ask
      const r = await call(P.frame, 'friend.start', { id });
      if (!r.ok) throw new Error('befriend: friend.start refused: ' + r.e);
    }
    if (!(await poll(() => dialogUp(P), 8000))) throw new Error('befriend: no friend dialog');
    await P.page.fill('#keo-friend input', theirs.join(' '));
    if (!(await poll(() => P.page.evaluate(() => !document.querySelector('#keo-friend button.yes').disabled), 5000))) throw new Error('befriend: the words did not match');
    await P.page.click('#keo-friend button.yes');
    await poll(async () => !(await dialogUp(P)), 5000);
  }
  if (!(await poll(() => friends(A, B, k), 8000))) throw new Error('befriend: the devices did not become friends');
  return true;
}
module.exports = { befriend };
