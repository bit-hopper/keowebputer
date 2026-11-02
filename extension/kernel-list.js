// Directories of the kernel snapshot that the runtime lists with PROPFIND. refresh-kernel.js ships every file in them, and
// build.js writes the directory listing for each; both read this list so they cannot disagree.
module.exports = { LISTED_DIRS: ['core/lively/ide/codeeditor/modes', 'core/lively/ide/snippets'] };
