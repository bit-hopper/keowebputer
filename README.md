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

### Worlds

A world is saved on the device, encrypted under the signed-in identity (`shell/keo-worlds.js`); nothing is sent anywhere. Beside each saved world the shell keeps its readable text (`shell/keo-worldtext.js`), sealed the same way, so a world can be found by its name, its tags, its note or the words written inside it without opening every saved page. The runtime's "My worlds" window (identity menu, or the world's own keo menu) shows them: it searches as you type, opens a world, starts a blank world or one from a preset (Shop, Diary, Books and Music; the presets that keep their data on a host are listed but not offered), and a row's menu renames, copies, tags and deletes. A world has no version history on the device. The search palette lists matching saved worlds too. The names, tags, notes and text are inside the encryption; what is readable without the key is the identity's DID, record ids and sizes. A search reads text records only, never a whole saved page, except to make the text of a world saved by an earlier version.

### The library

The presets that keep records (Books, Music) keep them on the device too, in `shell/keo-library.js`: IndexedDB `keo-library`, one record per object (a book, an album, a folder such as a shelf list or a playlist), sealed under the signed-in identity the way saved worlds are, so what is readable without the key is the identity's DID, the object ids, sizes and the order of writes. The runtime's file-and-folder module answers its object reads and writes from this store while the session is local (it asks the shell, which checks that an object belongs to the signed-in identity and is one of the app kinds, and stores it as it is); with a host nothing changes. Removing an identity removes its library.

What works without a host: Books (shelves, ratings, lists) and Music (shelves, ratings, playlists, albums and tracks typed in by hand). An item can always be added by typing it. A separate, labelled "search online" button looks an item up in a public catalogue; it sends what was typed to that catalogue only when it is pressed, never while typing. An item added from a result is copied into the library on the device, picture included: the shell keeps files by their hash in the same sealed store (`blobs`; one file at most 25 MB, one identity's files at most 1 GB together, the hash checked by the shell), the app draws the copy, and the catalogue's address is not kept, so nothing is asked of the catalogue again to show it. While results are on screen their thumbnails come from the catalogue, as a search is meant to show them. What a host is needed for, and so is not offered: sharing with other people, public pages, reviews and notes, link previews and embeds, and the catalogue search that goes through a host.

The music catalogue's search and lookup send no cross-origin permission to the world's origin (which is `null`), so the browser refuses their answers there (checked against the real service); the book catalogue's search and both catalogues' pictures do send it. So the manifest asks for host permission for that one music site (`host_permissions`, the only host the package asks for; the person installing the package is shown it), and the shell page reads the answers for the world (`shell/keo-catalog.js`, bridge op `catalog.get`, signed-in sessions only). The permission covers the whole site, so the shell narrows it: a GET of `https://itunes.apple.com/search` or `/lookup` only, no cookies, no referrer, no redirects, JSON of at most 2 MB; every other address is refused before anything is sent. The world reads the pictures itself.

An item added by typing has no picture, so its page offers a labelled "Find a cover online" button: a book is looked up in the book catalogue by title and author, an album in an open music database by title and artist and then an open cover archive for its front cover. Neither service needs a key and both answer the world directly (no permission is asked for them). Only that text is sent, only when the button is pressed, and the picture it finds is copied to the device like any other.

The fonts of these apps are files of the package (`core/lib/app-fonts/`, declared by `core/styles/app-fonts.css`, fetched by `core/lib/app-fonts/vendor-fonts.js` from the font service once, by hand), so showing an app asks no font service for anything.

Not built: Gallery (its pictures need the file store above to be wired into it), a version history, reclaiming a stored file that nothing refers to any more, and **sync**: the library stays on the device where it was made, and moving it between a person's devices, or to a host when one is registered, is planned for later.

### The pinned key

`extension/extension-key.json` is the **public** key written into the extension manifest. It fixes the extension id, and the extension id is the origin and the passkey rpId on which every identity is made. A passkey works only on the origin it was made on, so a new key is a new origin: the passkeys made under the old id do not work there. An identity is not lost by that, because it can be linked to the new origin from the Identity menu ("Link a new webputer ...", then "Link this webputer to an identity ..." on the new side), which adds a second passkey to it. Even so, do not regenerate the key without a reason.

## Building

The runtime's files are in this repository: `kernel/` is a verbatim snapshot of the files the package ships from the LivelyKernel runtime (its modules, the libraries and workers it loads on demand, the boot bundle and the world's document). `kernel/SNAPSHOT.json` records the kernel commit it was taken from. The runtime's own repository is a separate project and is not shipped; this repository is what is built and released. A build needs only Node, no kernel checkout, no server and no packages:

```
node extension/build.js dist
```

The build writes `keo-build.json` into the package with the kernel commit the snapshot came from. Load `dist/` with *Load unpacked* in `chrome://extensions` (developer mode), click the toolbar icon, and a small panel opens (`shell/popup.*`). It shows who is signed in and how each friend's connection is doing; its button opens keo in a tab, or brings the open one forward.

`node extension/build.js <folder> --desktop` builds the same files for the desktop app (a separate repository, `keo-desktop`) instead of the browser. The origin is then `https://keo.test` and the passkey rpId is `keo.test`, fixed in the build; there is no manifest, popup or icon, and `desktop.json` carries the two page policies the app sets as response headers (scripts from the package only for the shell pages, a sandbox for the world page). The app serves the folder on that address, so a package for another origin is refused by it.

To move the snapshot to a newer kernel commit, run `node extension/refresh-kernel.js --kernel <path to a clean kernel checkout>` (a checkout made with `git clone -c core.autocrlf=false`, with the kernel's own `npm install` done). It rewrites `kernel/` completely, including the boot bundle, which only the kernel's own code can generate; so a change to the runtime's code is made in the kernel and arrives here by a refresh. Files under `kernel/` are stored byte for byte (`.gitattributes`).

While the runtime is being changed, `node extension/dev-cycle.js --kernel <kernel checkout> --clean <clean clone> --out <package folder> --paths <kernel file>...` does the whole round in about fifteen seconds: it commits only the kernel files named (every other change in the kernel checkout is left alone), moves the clean clone to that commit, refreshes `kernel/` and builds a package. The commit is a local one that later runs amend, but only while it has not been pushed; it is never pushed by this script. When the change is finished, give that commit its real message (`git commit --amend -m ...` in the kernel) and run the script once more without `--paths`, so the snapshot names the final commit. The clean clone is made on first use, with the kernel's installed packages linked in, and is only ever reset to the kernel's commit, so keep nothing in it.

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
npm run test:did                                     # no browser: DID, inception, the log of added passkeys and the verifier
npm run test:release                                 # no browser: release signing and verification
npm run test:hello                                   # no browser: the short connection code and the signed peer proof
npm run test:callsdp                                 # no browser: what a call description from the peer must look like
npm run test:fingerprint                             # no browser: the eight words that stand for a DID, and for a request to add a device
npm run test:enrollcode                               # no browser: the text carried between two devices when an identity is added to another
npm run test:devcycle                                  # no browser: the kernel round (extension/dev-cycle.js) against throwaway repositories: only the named files are committed, a pushed or real commit is never amended
npm run test:worldtext                               # no browser: the text that is searchable in a saved world, and the search
node tests/keo-identity-test.js . dist <work dir>    # identity creation end to end, virtual authenticator
node tests/keo-session-test.js  . dist <work dir>    # the session, encrypted saved worlds, menu bar
node tests/keo-enroll-test.js    . dist <work dir>    # two browsers, two extension ids: one identity moved to the other origin by a second passkey, the secret carried over, the words that guard both ends
node tests/keo-enroll-ui-test.js . dist <work dir>    # the same, through the shell dialog by real clicks, typing, a real file chooser and a real download
node tests/keo-transfer-test.js . dist <work dir>    # two browsers: the saved worlds and library of one identity saved as a sealed file on one origin and added on the other, by real clicks, a real download and a real file chooser
node tests/keo-gate-test.js     . dist <work dir>    # sign-in dialog inside the world, what starts when nobody is signed in
node tests/keo-worlds-test.js   . dist <work dir>    # the worlds library: create by name, save, search, rename, copy, tags, delete, what is on disk, an older database
node tests/keo-worlds-ui-test.js . dist <work dir>   # "My worlds" and the search palette, by real clicks and typing: search, row menu, create blank and from presets
node tests/keo-library-test.js  . dist <work dir>   # the library on this device: the sealed store, what it refuses and what is on disk, Books and Music by real clicks and typing, the online search only on a press (the catalogues are answered by the test)
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
node tests/keo-enroll-real.js   . dist <work dir> [<second package> | --desktop <desktop repo> <desktop package>]   # a REAL authenticator, TWO origins: link a second origin (another extension id, or the desktop app on keo.test) to an identity; you approve seven OS prompts
```

**Not yet verified** (the tests above cannot show it): calls and messages have been run only between two browser profiles on one machine, with the browser's fake camera and microphone. A real camera, microphone and permission prompt, two computers on a network, whether audio is audible, other browsers, and a real authenticator have not been tried. The friend dialog has been driven by the tests (real clicks and typing between two browsers) but no person has used it to compare words with another person. In the world, "Connect a device" offers "Add as friend…" and only then files and messages, Messages and its call buttons say when a device is not a friend, and "Friends ..." in the identity menu lists who was added and removes them (the shell asks first).

**Toolbar popup: what is not done or not verified.** The popup (`shell/popup.*`, answered by `shell/keo-status.js`) has only been run as a page opened in a tab by the tests, and by one person looking at it from the real toolbar in the open state; the browser's own popup surface, its 600 px limit (the tests check the page's height), and every state other than that one have not been seen there. Reconnect, last seen, the chat icon and Sign out have been run only between two browser profiles on one machine. The device being reconnected to has no popup shortcut for taking the invitation: its person pastes it into Connect a device by hand. With several keo tabs open the popup shows the first signed-in one and does not say there are others. The record of why a connection ended is kept in memory, so reloading the keo tab forgets it (the last seen time is kept). A request from the popup (reconnect, chat, connect, sign out) is delivered to the world as an event and is lost if the world is not up yet. Not built: a keyboard shortcut that opens keo past the popup, icons on the text buttons, and a popup for a browser engine other than the one tried.

**Known intermittent failure, cause not found:** `keo-messages-test.js` failed once, on "A receives the reply in its open window", in roughly twenty runs, and has not failed since (a reply typed in one chat window did not show in the other within 15 s). It was not reproduced, so it is not known whether the cause is in the test or in how Messages takes what the shell holds. The check now reports what the window showed, what the shell was still holding, what had been saved and the pull state, so the next occurrence says which step failed. Do not treat the suite as reliable evidence about that step until it has been found.

`<work dir>` is a scratch folder for browser profiles; keep its path short (a long profile path made browser storage fail in testing). The real-authenticator test creates passkeys that a web page cannot delete; remove them in your OS passkey settings afterwards.

## Licence

MIT, see `LICENSE`.
