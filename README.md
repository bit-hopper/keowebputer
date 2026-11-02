# keowebputer

A prototype of **keo**: a Lively-style live, modifiable browser runtime with no backend. The world runs from keo's own files, and identity, keys and storage live on the user's device.

Status: early prototype. Nothing here is audited. Local identity creation has been run against a virtual authenticator and against one real one (the platform authenticator built into one desktop computer); other authenticators and browsers are untested.

## How it fits together

keo is an unpacked browser extension with two realms:

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

The package is made from a LivelyKernel checkout (the runtime) that has `core/` and `blank.html` and has had its own `npm install`. No server is needed: the generated module bundle is made by the kernel's own code (`extension/kernel-bundle.js`) and the two directory listings are written from the folders.

```
npm install
node extension/build.js dist --kernel <path to the kernel checkout>
```

`--kernel` can also be set with `KEO_KERNEL`; with neither, a folder named `LivelyKernel` next to this repository is used if it looks like a kernel. The build writes `keo-build.json` into the package with the kernel commit it came from and the paths that differed from that commit. Load `dist/` with *Load unpacked* in `chrome://extensions` (developer mode), click the toolbar icon, and the world opens.

The built package contains the kernel's code, so it carries the kernel's licence notice (`LICENSE-lively-kernel`). The libraries the kernel vendors have their own licences; they have not been audited here.

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
node tests/keo-identity-test.js . dist <work dir>    # identity creation end to end, virtual authenticator
node tests/keo-bridge-test.js   . dist <work dir>    # the shell <-> world bridge
node tests/keo-identity-real.js . dist <work dir>    # a REAL authenticator: you approve four OS prompts
```

`<work dir>` is a scratch folder for browser profiles; keep its path short (a long profile path made browser storage fail in testing). The real-authenticator test creates passkeys that a web page cannot delete; remove them in your OS passkey settings afterwards.

## Licence

MIT, see `LICENSE`.
