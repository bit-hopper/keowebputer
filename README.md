# keowebputer

A prototype of **keo**: a Lively-style live, modifiable browser runtime with no backend. The world runs from the app's own files, and identity, keys and storage live on the user's device.

Status: early prototype. Nothing here is audited. Local identity creation has been run against a virtual authenticator and against one real one (the platform authenticator built into one desktop computer); other authenticators and browsers are untested.

## How it fits together

The app is an unpacked browser extension with two realms:

| Folder | Realm | What it does |
|---|---|---|
| `shell/` | the extension's own page (trusted) | Holds the passkey ceremonies, the account secret, the keys and the persistent storage. Answers requests from the world over `postMessage` and only ever returns plain data. |
| `world/` | a sandboxed iframe (untrusted) | Runs the LivelyKernel runtime. A bridge gives it `localStorage`, an IndexedDB stand-in, `navigator.credentials` and an identity API that are all backed by the shell. |
| `extension/` | build time | `build.js` assembles the extension package. Also holds the boot-file list and the **pinned public key** (see below). |
| `tests/` | | Tests of the shell, the bridge and the built package. |

### Local identities

An identity is made on the device with a passkey and no server. Its DID is `did:keo:<discovery key>:<hash of the signed inception event>`: the first part is a z-base-32 Ed25519 public key (a lookup hint), the second binds the DID to the passkey that signed its inception. `shell/keo-did.js` builds and verifies these using only WebCrypto, so a verifier needs nothing but the event: no server, no DNS. `shell/keo-identity.js` runs the creation ceremony (two passkey prompts), wraps a random account secret under the passkey's PRF output, and stores everything in IndexedDB. There is no handle: a host grants one later, if the user registers with it.

### The pinned key

`extension/extension-key.json` is the **public** key written into the extension manifest. It fixes the extension id, and the extension id is the origin and the passkey rpId on which every identity is made. Changing it orphans every passkey created under the old id, so do not regenerate it.

## Building

The package is made from a LivelyKernel checkout (the runtime) that has `core/`, `users/` and `blank.html`, and the kernel's dev server must be running while you build (it supplies the generated module bundle and two directory listings).

```
npm install
node extension/build.js dist --kernel <path to the kernel checkout> [--server http://localhost:9001]
```

`--kernel` can also be set with `KEO_KERNEL`; with neither, a folder named `LivelyKernel` next to this repository is used if it looks like a kernel. The build writes `keo-build.json` into the package with the kernel commit it came from and the paths that differed from that commit. Load `dist/` with *Load unpacked* in `chrome://extensions` (developer mode), click the toolbar icon, and the world opens.

The built package contains the kernel's code, so it carries the kernel's licence notice (`LICENSE-lively-kernel`). The libraries the kernel vendors have their own licences; they have not been audited here.

## Tests

The browser tests drive a headed browser through `playwright-core` with the extension loaded. Their first argument is the folder that holds `node_modules/playwright-core` (here: `.`).

```
npm run test:did                                     # no browser: DID, inception and verifier
node tests/keo-identity-test.js . dist <work dir>    # identity creation end to end, virtual authenticator
node tests/keo-bridge-test.js   . dist <work dir>    # the shell <-> world bridge
node tests/keo-identity-real.js . dist <work dir>    # a REAL authenticator: you approve four OS prompts
```

`<work dir>` is a scratch folder for browser profiles; keep its path short (a long profile path made browser storage fail in testing). The real-authenticator test creates passkeys that a web page cannot delete; remove them in your OS passkey settings afterwards.

## Licence

MIT, see `LICENSE`.
