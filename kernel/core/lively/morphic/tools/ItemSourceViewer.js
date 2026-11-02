/**
 * lively.morphic.tools.ItemSourceViewer
 *
 * Read-only, syntax-highlighted viewer for an Inventory/PartsBin item's
 * source. Two different kinds of "source" exist for an item, and this
 * viewer surfaces whichever one actually applies:
 *
 * 1. Embedded addScript/BuildSpec method source -- per-instance JS closures
 *    saved directly inside the item's own JSON (lively.persistence.Serializer
 *    .scriptSourcesIn walks the raw parsed JSON only, no eval, so this is
 *    safe to call on untrusted item JSON). Most hand-built BuildSpec parts
 *    (dialogs, widgets assembled from addScript handlers) carry their logic
 *    this way, and it shows up here directly.
 *
 * 2. A real JS class backing the item (e.g. `SomeNamespace.subclass(...)`
 *    morphs like Shop, RetroMediaConsole -- or even a plain built-in morph
 *    like lively.morphic.Text/Box with no custom code at all). An item like
 *    this carries no addScript closures in its own JSON -- its __LivelyClassName__
 *    + __SourceModuleName__ just name the class, and the actual method
 *    bodies live in that class's module file on disk, not in the envelope.
 *    When no addScript source is found, this viewer resolves the ROOT
 *    item's own class module via lively.module(name).uri() and fetches
 *    that file's CURRENT source as plain text (still no eval/instantiation)
 *    -- for a custom class like Shop this shows the part's real logic; for
 *    a plain built-in class like Text it shows the framework's own generic
 *    implementation, which honestly answers "there is no part-specific
 *    code here, this item is just serialized state."
 *
 * The module name comes from untrusted item JSON, so the auto-fetch in (2)
 * only runs for names matching a strict dotted-identifier pattern (see
 * MODULE_NAME_PATTERN) -- this is meant to stay safe to call on content
 * that hasn't been trust-gated yet (see ItemTrust.js), so it must not turn
 * into a same-origin path-traversal/arbitrary-file-read gadget driven by
 * attacker-controlled JSON.
 *
 * Shared by both the Inventory browser and the classic PartsBin browser
 * (see Inventory.js's viewSourceOfSelectedItem and tools/PartsBin.js's
 * viewSourceForSelection).
 */
module('lively.morphic.tools.ItemSourceViewer')
  .requires()
  .toRun(function () {

    lively.morphic.tools = lively.morphic.tools || {};

    // Only a plain dotted JS-identifier path, e.g. "Global.lively.commerce.Shop".
    // Rejects anything with '/', '..', or other punctuation a namespace name
    // has no legitimate reason to contain, so a crafted __SourceModuleName__
    // can't be used to make this viewer fetch an arbitrary same-origin path.
    var MODULE_NAME_PATTERN = /^Global(\.[A-Za-z_$][\w$]*)+$/;

    function jsoOf(json) {
      return typeof json === 'string' ? lively.persistence.Serializer.parseJSON(json) : json;
    }

    // Joins every extracted script under a "// --- owner.script ---" banner,
    // preceded by an index of those banners with the line number each one
    // starts on (the viewer shows a line-number gutter, so the numbers can
    // be looked up directly).
    function concatenateScripts(itemName, scripts) {
      var sections = scripts.map(function (s) {
        var owner = s.ownerName || s.ownerClass || ('#' + s.ownerId);
        return {label: owner + '.' + s.scriptName,
                text: '// --- ' + owner + '.' + s.scriptName + ' ---\n' + s.source};
      });

      var headerLineCount = 4 + sections.length + 1; // title, count, blank, column row, one per section, trailing blank
      var line = headerLineCount + 1;
      sections.forEach(function (sec) {
        sec.line = line;
        line += sec.text.split('\n').length + 1; // +1 for the blank separator line
      });

      var width = Math.max(4, String(line).length);
      function pad(n) {
        var s = String(n);
        while (s.length < width) s = ' ' + s;
        return s;
      }

      var header = [
        '// Item: ' + itemName,
        '// ' + sections.length + ' embedded method' + (sections.length === 1 ? '' : 's') +
          ' (read-only; nothing here was evaluated)',
        '//',
        '// ' + pad('line') + '  method'
      ].concat(sections.map(function (sec) {
        return '// ' + pad(sec.line) + '  ' + sec.label;
      }), ['']);

      return header.concat([sections.map(function (sec) { return sec.text; }).join('\n\n')]).join('\n');
    }

    // The root item's own __LivelyClassName__/__SourceModuleName__, straight
    // off its registry entry -- not a registry-wide search, just the one
    // object the item's own JSON actually is.
    function rootClassInfo(jso) {
      var root = jso && jso.registry && jso.registry[jso.id];
      if (!root) return null;
      var moduleName = root['__SourceModuleName__'];
      if (!moduleName) return null;
      return {className: root['__LivelyClassName__'] || null, moduleName: moduleName};
    }

    function resolvableModuleUri(moduleName) {
      if (typeof moduleName !== 'string' || !MODULE_NAME_PATTERN.test(moduleName)) return null;
      try { return lively.module(moduleName).uri(); }
      catch (e) { return null; }
    }

    function fetchText(url, thenDo) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.onload = function () {
        if (xhr.status !== 200) { thenDo(new Error('HTTP ' + xhr.status)); return; }
        thenDo(null, xhr.responseText);
      };
      xhr.onerror = function () { thenDo(new Error('network error')); };
      xhr.send();
    }

    function otherReferencedModules(jso, excludeModuleName) {
      try {
        return lively.persistence.Serializer.sourceModulesIn(jso).filter(function (m) {
          return m !== excludeModuleName;
        });
      } catch (e) { return []; }
    }

    // Builds the content for the no-embedded-script case: resolves+fetches
    // the root item's own class module (when its name is safe to resolve),
    // and always lists (without fetching) whatever other modules are
    // referenced elsewhere in the item's registry, so the user at least
    // knows where else to look.
    function describeClassBackedItem(jso, thenDo) {
      var info = rootClassInfo(jso);
      if (!info) {
        thenDo('// No addScript/BuildSpec method source found in this item,\n' +
               '// and its root object carries no class/module info either --\n' +
               '// there is nothing this viewer can resolve as "source" for it.');
        return;
      }
      var others = otherReferencedModules(jso, info.moduleName);
      var othersLine = others.length
        ? '// Other modules referenced elsewhere in this item (not fetched): ' + others.join(', ') + '\n'
        : '';
      var uri = resolvableModuleUri(info.moduleName);
      if (!uri) {
        thenDo('// No addScript/BuildSpec method source found in this item.\n' +
               '// Its root object is an instance of ' + (info.className || '(unknown class)') +
               ', module ' + info.moduleName + ',\n' +
               '// but that module name doesn\'t resolve to a file this viewer will ' +
               'fetch automatically.\n' + othersLine);
        return;
      }
      fetchText(uri, function (err, source) {
        if (err) {
          thenDo('// No addScript/BuildSpec method source found in this item.\n' +
                 '// Its root object is an instance of ' + (info.className || '(unknown class)') +
                 ', defined in ' + info.moduleName + ' (' + uri + '),\n' +
                 '// but fetching that file failed: ' + err.message + '\n' + othersLine);
          return;
        }
        thenDo(
          '// This item has no addScript/BuildSpec closures embedded in its own JSON --\n' +
          '// its behavior comes from a real JS class defined in an external module\n' +
          '// file on this server, not from anything stored in the item\'s envelope.\n' +
          '// Showing that file\'s CURRENT source below; this reflects the live module\n' +
          '// as it exists on this server right now, not necessarily byte-for-byte\n' +
          '// what was running when this item was last published/saved.\n' +
          '//\n' +
          '// Class:  ' + (info.className || '(unknown)') + '\n' +
          '// Module: ' + info.moduleName + '\n' +
          '// File:   ' + uri + '\n' +
          othersLine +
          '\n' + source
        );
      });
    }

    lively.morphic.tools.ItemSourceViewer = {
      // Note: opens the editor once its content is ready, which may involve
      // one async fetch (see describeClassBackedItem above) -- callers
      // should not rely on a return value, and none of the existing call
      // sites (Inventory.js, tools/PartsBin.js, ItemTrust.js) do.
      open: function (itemName, json) {
        var jso = jsoOf(json),
            scripts = lively.persistence.Serializer.scriptSourcesIn(jso);

        function openWith(content) {
          var editor = $world.addCodeEditor({
            title: 'Source: ' + itemName + ' (' + content.split('\n').length + ' lines)',
            content: content,
            textMode: 'javascript',
            theme: 'tomorrow_night_bright', // pure black background, high-contrast syntax colors
            fontSize: 14,
            allowInput: false,
            gutter: true,
            showIndents: true,
            showActiveLine: true,
            printMargin: false,
            lineWrapping: false,
            extent: lively.pt(800, 560)
          });
          // Not styling options on CodeEditor, so set them on the ace editor:
          // fold widgets in the gutter let a long method be collapsed, and the
          // font stack uses whichever legible coding font the OS already has
          // (nothing vendored) with a little extra line spacing. Cascadia
          // Mono, not Cascadia Code: the latter draws === and !== as
          // ligatures, which misleads when reading unfamiliar source.
          editor.withAceDo(function (ed) {
            ed.setOption('showFoldWidgets', true);
            ed.setOption('foldStyle', 'markbegin');
            ed.setOption('fontFamily', "'Cascadia Mono',Consolas,'SF Mono',Menlo,'DejaVu Sans Mono',monospace");
            ed.container.style.lineHeight = '1.55';
            ed.renderer.updateFontSize();
          });
          return editor;
        }

        if (scripts.length) { return openWith(concatenateScripts(itemName, scripts)); }
        describeClassBackedItem(jso, openWith);
      }
    };

  });
