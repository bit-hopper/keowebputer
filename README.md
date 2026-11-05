# keowebputer

A prototype of **keo**: a Lively-style live, modifiable browser runtime with no backend. The world runs from keo's own files, and identity, keys and storage live on the user's device.

Status: early prototype. Nothing here is audited. Local identity creation has been run against a virtual authenticator and against one real one (the platform authenticator built into one desktop computer); other authenticators and browsers are untested.

## How it fits together

keo is an unpacked browser extension with two realms:

| Folder | Realm | What it does |
|---|---|---|
| `shell/` | the extension's own page (trusted) | Holds the passkey ceremonies, the account secret, the keys and the persistent storage. Answers requests from the world over `postMessage` and only ever returns plain data. |
| `world/` | a sandboxed iframe (untrusted) | Runs the LivelyKernel runtime. A bridge gives it `localStorage`, an IndexedDB stand-in, `navigator.credentials` and an identity API that are all backed by the shell. |
| `extension/` | build time | `build.js` assembles the extension package from the files below. Also holds `refresh-kernel.js`, the boot-file list, the toolbar icons (`icons/`, redrawn by `make-icons.js`) and the **pinned public key** (see below). |
| `kernel/` | | Snapshot of the runtime's shipped files (see Building). Not edited by hand, except `THIRD-PARTY-NOTICES.md`. |
| `tests/` | | Tests of the shell, the bridge and the built package. |

### Local identities

An identity is made on the device with a passkey and no server. Its DID is `did:keo:<discovery key>:<hash of the signed inception event>`: the first part is a z-base-32 Ed25519 public key (a lookup hint), the second binds the DID to the passkey that signed its inception. `shell/keo-did.js` builds and verifies these using only WebCrypto, so a verifier needs nothing but the event: no server, no DNS. `shell/keo-identity.js` runs the creation ceremony (two passkey prompts), wraps a random account secret under the passkey's PRF output, and stores everything in IndexedDB. There is no handle: a host grants one later, if the user registers with it.

### Friends

A connection to another device proves which identity is at the other end, not that it is the person you mean. So files, messages and calls move only between **friends**, and the only thing a device that is not one can do is say whether it has added you. Two devices become friends when each person has added the other: in a dialog drawn by `shell/` (never by the world), the person reads their own eight words to the other and types the eight words they hear back; the dialog adds the device only when those match the identity that proved itself over the connection. The words (`shell/keo-fingerprint.js`, from the English word list of the BIP 39 mnemonic specification, MIT, in `shell/keo-wordlist.js`) are 88 bits of a hash of the whole DID: the short form shown beside a name is for recognising someone and is not a check. The devices you have added are kept encrypted under your identity (`shell/keo-contacts.js`); that the other side has added you is learned afresh on each connection and never remembered. The world can only ask for the dialog.

### The pinned key

`extension/extension-key.json` is the **public** key written into the extension manifest. It fixes the extension id, and the extension id is the origin and the passkey rpId on which every identity is made. Changing it orphans every passkey created under the old id, so do not regenerate it.

## Building

The runtime's files are in this repository: `kernel/` is a verbatim snapshot of the files the package ships from the LivelyKernel runtime (its modules, the libraries and workers it loads on demand, the boot bundle and the world's document). `kernel/SNAPSHOT.json` records the kernel commit it was taken from. The runtime's own repository is a separate project and is not shipped; this repository is what is built and released. A build needs only Node, no kernel checkout, no server and no packages:

```
node extension/build.js dist
```

The build writes `keo-build.json` into the package with the kernel commit the snapshot came from. Load `dist/` with *Load unpacked* in `chrome://extensions` (developer mode), click the toolbar icon, and a small panel opens (`shell/popup.*`). It shows who is signed in and how each friend's connection is doing; its button opens keo in a tab, or brings the open one forward.

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
npm run test:callsdp                                 # no browser: what a call description from the peer must look like
npm run test:fingerprint                             # no browser: the eight words that stand for a DID
node tests/keo-identity-test.js . dist <work dir>    # identity creation end to end, virtual authenticator
node tests/keo-session-test.js  . dist <work dir>    # the session, encrypted saved worlds, menu bar
node tests/keo-gate-test.js     . dist <work dir>    # sign-in dialog inside the world, what starts when nobody is signed in
node tests/keo-bridge-test.js   . dist <work dir>    # the shell <-> world bridge
node tests/keo-p2p-test.js      . dist <work dir>    # two browsers: a direct connection by swapping two short codes, and file sharing
node tests/keo-peer-dialog-test.js . dist <work dir> # two browsers: the "Connect a device" dialog, by real clicks, a real paste and a real download
node tests/keo-friend-test.js . dist <work dir>      # two browsers: becoming friends through the shell's dialog, and that nothing else works before
node tests/keo-call-test.js . dist <work dir>        # two browsers, a fake camera: calls answered by real clicks on the shell's panel, and a hostile world and peer
node tests/keo-messages-test.js . dist <work dir>    # two browsers: Messages inside keo (real typing), and the Call button
node tests/keo-leave-test.js . dist <work dir>           # signing in and out raise no browser "Leave site?" warning, a plain reload still does
node tests/keo-popup-test.js    . dist <work dir>    # the toolbar popup page, by real clicks (opened in a tab: not the browser's own popup surface)
node tests/keo-popup-status-test.js . dist <work dir> # two browsers: what the popup shows of the session and of each friend's connection, and Reconnect by real clicks
node tests/keo-identity-real.js . dist <work dir>    # a REAL authenticator: you approve four OS prompts
```

**Not yet verified** (the tests above cannot show it): calls and messages have been run only between two browser profiles on one machine, with the browser's fake camera and microphone. A real camera, microphone and permission prompt, two computers on a network, whether audio is audible, other browsers, and a real authenticator have not been tried. The friend dialog has been driven by the tests (real clicks and typing between two browsers) but no person has used it to compare words with another person. In the world, "Connect a device" offers "Add as friend…" and only then files and messages, Messages and its call buttons say when a device is not a friend, and "Friends ..." in the identity menu lists who was added and removes them (the shell asks first).

**Toolbar popup: what is not done or not verified.** The popup (`shell/popup.*`, answered by `shell/keo-status.js`) has only been run as a page opened in a tab by the tests, and by one person looking at it from the real toolbar in the open state; the browser's own popup surface, its 600 px limit (the tests check the page's height), and every state other than that one have not been seen there. Reconnect, last seen, the chat icon and Sign out have been run only between two browser profiles on one machine. The device being reconnected to has no popup shortcut for taking the invitation: its person pastes it into Connect a device by hand. With several keo tabs open the popup shows the first signed-in one and does not say there are others. The record of why a connection ended is kept in memory, so reloading the keo tab forgets it (the last seen time is kept). A request from the popup (reconnect, chat, connect, sign out) is delivered to the world as an event and is lost if the world is not up yet. Not built: a keyboard shortcut that opens keo past the popup, icons on the text buttons, and a popup for a browser engine other than the one tried.

**Known intermittent failure, cause not found:** `keo-messages-test.js` failed once, on "A receives the reply in its open window", in roughly twenty runs, and has not failed since (a reply typed in one chat window did not show in the other within 15 s). It was not reproduced, so it is not known whether the cause is in the test or in how Messages takes what the shell holds. The check now reports what the window showed, what the shell was still holding, what had been saved and the pull state, so the next occurrence says which step failed. Do not treat the suite as reliable evidence about that step until it has been found.

`<work dir>` is a scratch folder for browser profiles; keep its path short (a long profile path made browser storage fail in testing). The real-authenticator test creates passkeys that a web page cannot delete; remove them in your OS passkey settings afterwards.

## Licence

MIT, see `LICENSE`.
