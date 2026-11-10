# Third-party code in `shell/`

`kernel/` has its own notices (`kernel/THIRD-PARTY-NOTICES.md`). This file covers what the shell itself carries.

## `keo-qrcodegen.js` (shipped in the package)

The QR code encoder of Project Nayuki, taken from the npm package `nayuki-qr-code-generator` 1.8.0 (a TypeScript build of the original,
repackaged by Kirill Maltsev). It is used only to **draw** a QR code (`keo-qr.js`); nothing in keo reads one. The file is unchanged apart
from the wrapper around it and its last line (the module export became a global and a CommonJS export); the licence header of the original
is kept at its top.

    Copyright (c) Project Nayuki. (MIT License)
    https://www.nayuki.io/page/qr-code-generator-library

    MIT License

    Copyright (c) 2022 Kirill Maltsev

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

## `jsqr` (development only, NOT in the package)

A QR code decoder (Apache-2.0), installed as a dev dependency so `tests/keo-qr-test.js` and `tests/keo-intro-test.js` can read back the codes
that keo draws and so prove they are readable. It is not copied into the package and nothing in keo calls it.
