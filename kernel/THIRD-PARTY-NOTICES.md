# Third-party notices

This folder is a verbatim snapshot of the runtime's shipped files (`SNAPSHOT.json` records the kernel commit it was taken from; the one change is that the recent-directories list in `blank.html` is emptied). Its own code is MIT licensed: `LICENSE` and `AUTHORS` here are the kernel's, and a built package carries them as `LICENSE-lively-kernel` and `AUTHORS-lively-kernel`. This notices file is written here by hand and is kept when the snapshot is refreshed. Paths below are relative to this folder, which is also the root of a built package. That licence covers the kernel's own code, not the libraries and assets it vendors.

**The licences of the vendored files have not been audited.** What follows is only what the files themselves say. Anything under "not audited" has not been checked, and nothing here is a statement that a licence permits a particular use.

## A licence notice is in the files

| Path | What the files say |
|---|---|
| `core/lib/ace/` | `LICENSE` in the folder; the shipped (minified) files keep their leading licence block |
| `core/lib/material-symbols/` | `LICENSE` in the folder |
| `core/lib/atkinson-hyperlegible/` | `LICENSE` in the folder |
| `core/lib/app-fonts/` | one folder per family (14: the fonts of the template apps), each with its `LICENSE.txt`, which for every one of them is the SIL Open Font License 1.1 (checked by reading each file when they were fetched); `core/styles/app-fonts.css` declares them |
| `core/lib/pdfjs/` | pdf.js 3.11.174 (Mozilla Foundation), Apache License 2.0: `LICENSE` in the folder, a licence header in each `.js` file, and `SOURCE` with the source and the SHA-256 of the two files, which are unchanged from the published package |
| `core/lib/marked/marked.js` | header marks it MIT licensed |
| `core/lib/cssParser.js` | header offers the file under MPL 1.1, GPL 2.0 or LGPL 2.1 |

## Not audited (no licence notice found in the folder or file header)

- `core/lib/google-fonts/`: font files
- `core/lib/postcard/`, `core/lib/astro/` (including `cities.json`), `core/lib/geo/` (including `leaflet.css` and its images)
- `core/lib/scheme/`, `core/lib/logo/`, `core/lib/ml/`: language engines, workers and sources
- `core/lib/libsodium/sodium.js`
- `core/lib/jsdiff/jsdiff.js` (its header refers to a licence file that is not in the folder)
- `core/lib/grasp.js`, `core/lib/lively.ast.dev.js`, `core/lib/escodegen.browser.js`: generated bundles of other code
- `core/lib/lively-libs.js` (a concatenation of several small libraries), `core/lib/Color.js`
- `core/media/`: images (`emoji-picker`, `face-masks`, `halos`, `PieIcons` and others)
- `core/lively/` beyond the kernel's own modules, where a module vendors third-party code
