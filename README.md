# keowebputer

A prototype of **keo**: a Lively-style live, modifiable browser runtime with no backend. The world runs from keo's own files, and identity, keys and storage live on the user's device.

Status: early prototype. Nothing here is audited. Local identity creation has been run against a virtual authenticator and against one real one (the platform authenticator built into one desktop computer); other authenticators and browsers are untested.

## How it fits together

keo is an unpacked browser extension with two realms:

| Folder | Realm | What it does |
|---|---|---|
| `shell/` | the extension's own page (trusted) | Holds the passkey ceremonies, the account secret, the keys and the persistent storage. Answers requests from the world over `postMessage` and only ever returns plain data. |
| `world/` | a sandboxed iframe (untrusted) | Runs the LivelyKernel runtime. A bridge gives it `localStorage`, an IndexedDB stand-in, `navigator.credentials` and an identity API that are all backed by the shell. |
| `extension/` | build time | `build.js` assembles the extension package from the files below. Also holds `refresh-kernel.js`, the boot-file list and the **pinned public key** (see below). |
| `kernel/` | | Snapshot of the runtime's shipped files (see Building). Not edited by hand, except `THIRD-PARTY-NOTICES.md`. |
| `tests/` | | Tests of the shell, the bridge and the built package. |

### Local identities

An identity is made on the device with a passkey and no server. Its DID is `did:keo:<discovery key>:<hash of the signed inception event>`: the first part is a z-base-32 Ed25519 public key (a lookup hint), the second binds the DID to the passkey that signed its inception. `shell/keo-did.js` builds and verifies these using only WebCrypto, so a verifier needs nothing but the event: no server, no DNS. `shell/keo-identity.js` runs the creation ceremony (two passkey prompts), wraps a random account secret under the passkey's PRF output, and stores everything in IndexedDB. There is no handle: a host grants one later, if the user registers with it.

### The pinned key

`extension/extension-key.json` is the **public** key written into the extension manifest. It fixes the extension id, and the extension id is the origin and the passkey rpId on which every identity is made. Changing it orphans every passkey created under the old id, so do not regenerate it.

## Building

The runtime's files are in this repository: `kernel/` is a verbatim snapshot of the files the package ships from the LivelyKernel runtime (its modules, the libraries and workers it loads on demand, the boot bundle and the world's document). `kernel/SNAPSHOT.json` records the kernel commit it was taken from. The runtime's own repository is a separate project and is not shipped; this repository is what is built and released. A build needs only Node, no kernel checkout, no server and no packages:

```
node extension/build.js dist
```

The build writes `keo-build.json` into the package with the kernel commit the snapshot came from. Load `dist/` with *Load unpacked* in `chrome://extensions` (developer mode), click the toolbar icon, and the world opens.

To move the snapshot to a newer kernel commit, run `node extension/refresh-kernel.js --kernel <path to a clean kernel checkout>` (a checkout made with `git clone -c core.autocrlf=false`, with the kernel's own `npm install` done). It rewrites `kernel/` completely, including the boot bundle, which only the kernel's own code can generate; so a change to the runtime's code is made in the kernel and arrives here by a refresh. Files under `kernel/` are stored byte for byte (`.gitattributes`).

The package contains the kernel's code, so it carries the kernel's licence notice (`LICENSE-lively-kernel`) and `THIRD-PARTY-NOTICES.md` (kept in `kernel/`, by hand). The libraries the kernel vendors have their own licences; they have not been audited, and that file says which have a notice and which do not.

## Releases

A release is the built package plus a signed list of every file in it and its hash (`release-<n>.json`). The signing key is held offline by the person who cuts the release; the build and CI never see it. The package pins the public key (`extension/update-key.json`, copied into the package) and a client accepts only a release signed by a pinned key whose version is higher than the one it runs.

```
node extension/sign-release.js keygen --out <key file outside this repository>    # once; commit the printed public key as extension/update-key.json
node extension/sign-release.js sign <built package folder> --key <key file> --version <n> --name <label>
```

Which files an update may carry, and what it must leave to a new package, is decided by `overlayable` in `shell/keo-release.js`.

## Tests

The browser tests drive a headed browser through `playwright-core` with the extension loaded. Their first argument is the folder that holds `node_modules/playwright-core` (here: `.`).

```
npm run test:did                                     # no browser: DID, inception and verifier
npm run test:release                                 # no browser: release signing and verification
npm run test:hello                                   # no browser: the short connection code and the signed peer proof
node tests/keo-identity-test.js . dist <work dir>    # identity creation end to end, virtual authenticator
node tests/keo-session-test.js  . dist <work dir>    # the session, encrypted saved worlds, menu bar
node tests/keo-gate-test.js     . dist <work dir>    # sign-in dialog inside the world, what starts when nobody is signed in
node tests/keo-bridge-test.js   . dist <work dir>    # the shell <-> world bridge
node tests/keo-p2p-test.js      . dist <work dir>    # two browsers: a direct connection by swapping two short codes, and file sharing
node tests/keo-peer-dialog-test.js . dist <work dir> # two browsers: the "Connect a device" dialog, by real clicks, a real paste and a real download
node tests/keo-identity-real.js . dist <work dir>    # a REAL authenticator: you approve four OS prompts
```

`<work dir>` is a scratch folder for browser profiles; keep its path short (a long profile path made browser storage fail in testing). The real-authenticator test creates passkeys that a web page cannot delete; remove them in your OS passkey settings afterwards.

## Licence

MIT, see `LICENSE`.
