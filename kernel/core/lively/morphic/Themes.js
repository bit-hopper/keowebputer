module('lively.morphic.Themes').requires('lively.morphic.Core').toRun(function() {

Object.extend(lively.morphic, { Themes: {

    BEGIN: '/* LIVELY-THEME-BEGIN */',
    END:   '/* LIVELY-THEME-END */',

    registry: {},

    register: function(name, spec) {
        spec.name = name;
        this.registry[name] = spec;
        return spec;
    },

    stripThemeCSS: function(css) {
        if (!css) return '';
        var b = css.indexOf(this.BEGIN), e = css.indexOf(this.END);
        if (b === -1 || e === -1) return css;
        return (css.slice(0, b) + css.slice(e + this.END.length)).trim();
    },

    apply: function(name, world) {
        world = world || lively.morphic.World.current();
        var theme = this.registry[name];
        if (!theme) { world.alert('Unknown theme: ' + name); return; }
        var userCSS = this.stripThemeCSS(world.getStyleSheet());
        var themeCSS = theme.css ?
            this.BEGIN + '\n' + theme.css + '\n' + this.END : '';
        world.setStyleSheet((userCSS ? userCSS + '\n\n' : '') + themeCSS);
        if (theme.fill) world.setFill(theme.fill);
        world.themeName = name;
        world.alertOK('Theme "' + name + '" applied. Save the world to keep it.');
    },

    clear: function(world) {
        world = world || lively.morphic.World.current();
        world.setStyleSheet(this.stripThemeCSS(world.getStyleSheet()) || null);
        world.setFill(Color.white);
        delete world.themeName;
        world.alertOK('Theme cleared.');
    },

    menuItemsFor: function(world) {
        var self = this;
        var items = Object.keys(this.registry).map(function(name) {
            var active = world.themeName === name;
            return [(active ? '✓ ' : '') + name,
                    function() { self.apply(name, world); }];
        });
        items.push(['none (clear theme)', function() { self.clear(world); }]);
        return items;
    }
}});

(function definePantheress() {
    // Root-relative, not lively.Config.codeBase — codeBase is always made
    // absolute with the current protocol+host (confirmed live: it baked in
    // "http://localhost:9001/..." here), and this string gets saved verbatim
    // into the world's persisted CSS.Fill. A world saved from one domain
    // (e.g. localhost during dev) then served from another (e.g.
    // dev.tinylil.world) tried to fetch the first domain's tile URL, which
    // is unreachable from anyone else's browser — confirmed live: the theme
    // rendered as a flat cream overlay with no tile pattern on the second
    // domain, full pattern only on the domain it was saved from. A
    // root-relative path is resolved fresh against whichever domain is
    // actually serving the page, on every load, same convention already
    // used by lively.identity.LocalMap for its own runtime assets.
    var tileURL = '/core/styles/themes/pantheress_tile.svg';
    // CSS.Fill sets node.style.background directly (inline), so it wins over
    // any stylesheet rules and survives world save/reload via serialization.
    // The background shorthand includes position/size so background-size is set.
    // Overlay: ivory at 75% opacity on top of the tile → tile renders at 0.25 opacity
    var bgString = 'linear-gradient(rgba(233,223,198,0.75),rgba(233,223,198,0.75)),' +
                   'rgb(233,223,198) url("' + tileURL + '") 0 0/420px 420px repeat';
    lively.morphic.Themes.register('pantheress', {
        description: 'Leopard/cheetah animal print',
        fill: new lively.morphic.CSS.Fill(bgString),
        css: null
    });
})();

(function defineSavanna() {
    var tileURL = '/core/styles/themes/savanna_tile.svg';
    var bgString = 'linear-gradient(rgba(233,237,228,0.75),rgba(233,237,228,0.75)),' +
                   'rgb(233,237,228) url("' + tileURL + '") 0 0/440px 440px repeat';
    lively.morphic.Themes.register('savanna', {
        description: 'Topographic contour map, sage palette',
        fill: new lively.morphic.CSS.Fill(bgString),
        css: null
    });
})();

}) // end of module
