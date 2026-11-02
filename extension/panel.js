// keo-start: local account creation from an unpacked extension. No server, no DNS, no listener.
// Draft only: field names, labels and formats are placeholders.
const $ = (id) => document.getElementById(id);
const log = (m) => { $('log').textContent += m + '\n'; };
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys) : (v && typeof v === 'object') ? Object.keys(v).sort().reduce((o, k) => (o[k] = sortKeys(v[k]), o), {}) : v;
const canonicalJson = (v) => JSON.stringify(sortKeys(v));
const sha256 = (bytes) => crypto.subtle.digest('SHA-256', bytes);
const SALT = enc.encode('keo-unlock-v1');   // PRF salt (placeholder label)

const openDb = () => new Promise((res, rej) => {
  const q = indexedDB.open('keo-account', 1);
  q.onupgradeneeded = () => q.result.createObjectStore('kv');
  q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
});
const dbGet = async (k) => { const db = await openDb(); return new Promise((res, rej) => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => { db.close(); res(r.result); }; r.onerror = () => rej(r.error); }); };
const dbPut = async (k, v) => { const db = await openDb(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => { db.close(); res(); }; t.onerror = () => rej(t.error); }); };
const dbClear = async () => { const db = await openDb(); return new Promise((res) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').clear(); t.oncomplete = () => { db.close(); res(); }; }); };

async function prfKek(prfBytes) {
  return crypto.subtle.importKey('raw', prfBytes, 'AES-KW', false, ['wrapKey', 'unwrapKey']);
}
async function getPrf(credentialId) {
  const a = await navigator.credentials.get({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), userVerification: 'required',
    allowCredentials: credentialId ? [{ type: 'public-key', id: credentialId }] : [], extensions: { prf: { eval: { first: SALT } } } } });
  const r = a.getClientExtensionResults().prf;
  return { assertion: a, prf: r && r.results && r.results.first };
}

async function createAccount() {
  const result = { step: 'create', extensionId: location.hostname, origin: location.origin };
  const userId = crypto.getRandomValues(new Uint8Array(16));
  // 1. passkey under this extension's own origin (rp.id omitted: the default is the extension id), asking for PRF
  const cred = await navigator.credentials.create({ publicKey: {
    rp: { name: 'keo' }, user: { id: userId, name: 'keo-user', displayName: 'keo user' }, challenge: crypto.getRandomValues(new Uint8Array(32)),
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, extensions: { prf: { eval: { first: SALT } } } } });
  const ext = cred.getClientExtensionResults();
  result.prfEnabled = !!(ext.prf && ext.prf.enabled);
  let prf = ext.prf && ext.prf.results && ext.prf.results.first;
  result.prfAtCreate = !!prf;
  if (!prf) { const g = await getPrf(cred.rawId); prf = g.prf; }   // some authenticators only evaluate PRF on get
  if (!prf) throw new Error('this authenticator did not return a PRF output');
  result.prfBytes = prf.byteLength;
  const alg = cred.response.getPublicKeyAlgorithm();
  if (alg !== -7) throw new Error('prototype handles ES256 only, got alg ' + alg);
  const authJwk = await crypto.subtle.exportKey('jwk', await crypto.subtle.importKey('spki', cred.response.getPublicKey(), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']));
  // 2. credential-independent account secret, wrapped under the passkey's PRF-derived key
  const kek = await prfKek(prf);
  const secret = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256', length: 256 }, true, ['sign']);
  const check = b64u(await crypto.subtle.sign('HMAC', secret, enc.encode('keo/check')));
  const wrapped = b64u(await crypto.subtle.wrapKey('raw', secret, kek, 'AES-KW'));
  // 3. per-device signing key, non-extractable, never wrapped
  const deviceKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const deviceJwk = await crypto.subtle.exportKey('jwk', deviceKey.publicKey);
  result.deviceKeyExtractable = deviceKey.privateKey.extractable;
  // 4. draft inception event; the DID is its hash (signatures excluded, section 7.4)
  const inception = { v: 1, type: 'inception', seq: 0, prev: null, state: {
    authority: { threshold: 1, keys: [{ id: b64u(cred.rawId), jwk: authJwk, rpId: location.hostname, kind: 'platform' }] },
    devices: [{ jwk: deviceJwk }], next: null } };
  const did = 'did:keo-draft:' + b64u(await sha256(enc.encode(canonicalJson(inception))));
  // 5. keep it all local
  await dbPut('account', { did, inception, credentialId: b64u(cred.rawId), wrappedAccountSecret: wrapped, check, deviceKey, createdAt: new Date().toISOString() });
  result.did = did; result.rpId = location.hostname; result.wrappedBytes = unb64u(wrapped).length;
  return result;
}

async function signIn() {
  const rec = await dbGet('account');
  if (!rec) throw new Error('no local account yet');
  const result = { step: 'signIn', extensionId: location.hostname, did: rec.did };
  const { assertion, prf } = await getPrf(unb64u(rec.credentialId));
  result.assertionOrigin = JSON.parse(new TextDecoder().decode(assertion.response.clientDataJSON)).origin;
  if (!prf) throw new Error('no PRF output on sign-in');
  const secret = await crypto.subtle.unwrapKey('raw', unb64u(rec.wrappedAccountSecret), await prfKek(prf), 'AES-KW', { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  result.secretNonExtractable = secret.extractable === false;
  const check = b64u(await crypto.subtle.sign('HMAC', secret, enc.encode('keo/check')));
  result.unlockMatches = check === rec.check;
  const msg = crypto.getRandomValues(new Uint8Array(16));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, rec.deviceKey.privateKey, msg);
  result.deviceSignatureVerifies = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, rec.deviceKey.publicKey, sig, msg);
  return result;
}

async function exportAccount() {
  const rec = await dbGet('account');
  if (!rec) throw new Error('no local account yet');
  const out = { format: 'keo-identity-export-draft', did: rec.did, inception: rec.inception, credentialId: rec.credentialId, wrappedAccountSecret: rec.wrappedAccountSecret, createdAt: rec.createdAt };
  const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = 'keo-identity-draft.json'; a.click();
  return { step: 'export', bytes: JSON.stringify(out).length, containsPrivateKey: false };
}

async function status() {
  const rec = await dbGet('account');
  $('status').textContent = rec ? 'Local account: ' + rec.did : 'No local account yet.';
  $('extid').textContent = location.hostname;
  return rec ? { did: rec.did } : null;
}

async function run(name, fn) {
  try { const r = await fn(); window.__last = r; log(name + ' OK ' + JSON.stringify(r)); }
  catch (e) { window.__last = { error: e.name + ': ' + e.message }; log(name + ' FAILED ' + e.name + ': ' + e.message); }
  await status();
}
$('create').onclick = () => run('create', createAccount);
$('signin').onclick = () => run('signIn', signIn);
$('export').onclick = () => run('export', exportAccount);
$('reset').onclick = async () => { await dbClear(); window.__last = { step: 'reset' }; log('local data cleared (the passkey itself stays in your authenticator)'); await status(); };
status();
