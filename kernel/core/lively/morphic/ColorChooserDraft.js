module('lively.morphic.ColorChooserDraft').requires('lively.morphic.Core', 'lively.morphic.Widgets', 'lively.morphic.TextCore', 'lively.CrayonColors').toRun(function() {

function hslToRgb(h, s, l) {
    var r, g, b;
    if (s == 0) {
        r = g = b = l; // achromatic
    } else {
        var hue2rgb = function(p, q, t) {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1/6) return p + (q - p) * 6 * t;
            if (t < 1/2) return q;
            if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
            return p;
        };
        var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        var p = 2 * l - q;
        r = hue2rgb(p, q, h + 1/3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1/3);
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function colorToHSB(color) {
    // implementation in the color class produces strange results
    var r = color.r, g = color.g, b = color.b,
        max = Math.max(r, g, b), min = Math.min(r, g, b),
        h, s, l = (max + min) / 2;
    if (max == min) {
        h = s = 0; // achromatic
    } else {
        var d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
    }
    return [h, s, l];
}

lively.morphic.Box.subclass('lively.morphic.ColorChooser',
'settings', {
    defaultBounds: new Rectangle(0,0, 160, 120)
},
'initializing', {
    initialize: function($super, bounds) {
        $super(bounds || this.defaultBounds);
        this.buildColorMap();
        // this.ignoreEvents();
    },
    buildColorMap: function() {
        throw new Error('subclass responsibility')
    },
},
'color mapping', {
    colorForPos: function(pos) {
        throw new Error('subclass responsibility');
    }
});

lively.morphic.ColorChooser.subclass('lively.morphic.RGBColorChooser',
'settings', {
    colorNames: 'rgb',
    hasLabel: true
},
'initializing', {
    buildColorMap: function() {
        // copied from lively.Widgets ColorPicker
        // Slow -- should be cached as a bitmap and invalidated by layoutChanged
        // Try caching wheel as an interim measure
        var r = this.shape.getBounds().insetBy(this.getBorderWidth());
        var rh2 = r.height/2;
        var dd = 5; // grain for less resolution in output (input is still full resolution)

        //DI: This could be done with width*2 gradients, instead of width*height simple fills
        for (var x = 0; x < r.width; x += dd) {
            for (var y = 0; y < r.height; y += dd) { // lightest down to neutral
                var element = new lively.morphic.Morph.makeRectangle(new Rectangle(x + r.x, y + r.y, dd, dd));
                element.applyStyle({
                    fill: this.colorMap(x, y, rh2, this.colorWheel(r.width + 1)),
                    borderWidth: 0
                });
                element.ignoreEvents();
                this.addMorph(element);
            }
        }
    },
},
'color mapping', {
colorForPos: function(pos) {
         var r = this.shape.getBounds().insetBy(this.getBorderWidth()),
            pos = r.closestPointToPt(pos),
            rh2 = r.height/2;
        var color =  this.colorMap(pos.x, pos.y, rh2, this.colorWheel(r.width+1));
        this.hasLabel && this.ensureLabel().setTextString("color:" + color);
        return color;
    },
  ensureLabel: function() {
       if (!this.label) {
            this.label = new lively.morphic.Text(new Rectangle(0,0,160,20), "rbg", {fill: Color.white});
            this.addMorph(this.label);
            this.label.setPosition(pt(0,120));
       }
        return this.label
    },


    colorWheel: function(n) {
        if (this.colorWheelCache && this.colorWheelCache.length == n)
            return this.colorWheelCache;
        // the start of the color range should be just white for grayscale
        var whiteAmount = 5,
            whites = Array.range(1,whiteAmount).collect(function() {return Color.white})
        return this.colorWheelCache = whites.concat(Color.wheelHsb(Math.round(n-whiteAmount),338,1,1));
    },

    colorMap: function(x,y,rh2,wheel) {
        var columnHue = wheel[Math.round(x)];
        return y <= rh2 ?
            columnHue.mixedWith(Color.white, y/rh2) : // lightest down to neutral
            Color.black.mixedWith(columnHue, (y - rh2)/rh2);  // neutral down to darkest
    },
});

lively.morphic.ColorChooser.subclass('lively.morphic.CrayonColorChooser',
'settings', {
    colorNames: 'crayons',
},
'initializing', {
    buildColorMap: function() {
        var colorNames = CrayonColors.colorNames(),
            x = 8, y = 6, // like MacOS colors
            extent = this.innerBounds().extent().scaleByPt(pt(1/x, 1/y));
        for (var j = 0; j < y; j++) {
            for (var i = 0; i < x; i++) {
                var idx = j*x+i, // running offset j*x^1 + i*y^0
                    color = CrayonColors[colorNames[idx]],
                    r = extent.scaleByPt(pt(i, j)).extent(extent);
                    morph = new lively.morphic.Box(r);
                morph.applyStyle({fill: color, borderWidth: 0});
                morph.ignoreEvents();
                this.addMorph(morph);
            }
        }
    },
},
'color mapping', {
    colorForPos: function(pos) {
        var r = this.shape.getBounds().insetBy(this.getBorderWidth()),
            pos = r.closestPointToPt(pos),
            m = this.submorphs.detect(function(ea) { return ea.bounds().containsPoint(pos) });
        return m ? m.getFill() : Color.black;
    },
});
lively.morphic.ColorChooser.subclass('lively.morphic.CustomColorChooser',
'settings', {
    colorNames: 'custom',
},
'initializing', {
    initialize: function($super,bounds, colors){
        // under constructions...
        if (!colors) {
            colors = this.gatherCustomColors();
        }
        this.colors = colors;
        $super(bounds);
    },
    gatherCustomColors: function() {
        // lively.morphic.CustomColorChooser.prototype.gatherCustomColors()
        var colors = [];
        var gatherColor = function(eaColor) {
            if (eaColor && !colors.detect(function(colorSetEa) {
                return colorSetEa.equals(eaColor)}))
                colors.push(eaColor)
        }
        $world.withAllSubmorphsDo(function(ea) {
            gatherColor(ea.getBorderColor());
        })
        return colors
    },

    buildColorMap: function() {
        var x = Math.floor(Math.sqrt(this.colors.length)) + 1,
            y = x,
            extent = this.innerBounds().extent().scaleByPt(pt(1/x, 1/y));
        for (var j = 0; j < y; j++) {
            for (var i = 0; i < x; i++) {
                var idx = j*x+i, // running offset j*x^1 + i*y^0
                    color = this.colors[idx],
                    r = extent.scaleByPt(pt(i, j)).extent(extent),
                    morph = new lively.morphic.Box(r);
                morph.applyStyle({fill: color, borderWidth: 0});
                morph.ignoreEvents();
                this.addMorph(morph);
            }
        }
    },
},
'color mapping', {
    colorForPos: function(pos) {
        var r = this.shape.getBounds().insetBy(this.getBorderWidth()),
            pos = r.closestPointToPt(pos),
            m = this.submorphs.detect(function(ea) { return ea.bounds().containsPoint(pos) });
        return m ? m.getFill() : Color.black;
    },
});
lively.morphic.Text.subclass('lively.morphic.ColorChooserSwitcher',
'documentation', {
    documentation: 'used for changing the color chooser of a color field',
},
'settings', {
    style: {fixedWidth: false, fixedHeight: false, fill: Color.white},
},
'initializing', {
    initialize: function($super, colorChooser) {
        this.colorChooser = colorChooser;
        $super(new Rectangle(0,0,10,10), colorChooser.colorNames);
        this.registerForEvent('pointerMove', this, 'onMouseMove');
    },
},
'mouse events', {
    onMouseMove: function(evt) {
        this.colorField.setCurrentColorSwitcher(this)
    },
});

lively.morphic.Box.subclass('lively.morphic.ColorField',
/* example:
new lively.morphic.ColorField().openInWorld(pt(100,100))
*/
'settings', {
    doNotSerialize: ['colorSwitchers', 'currentColorSwitcher'],
    style: {
        enableDragging: true,
        enableGrabbing: false,
        fill: Color.white,
        borderWidth: 1,
        borderColor: Color.black
    }
},
'initializing', {
    initialize: function($super, optBounds) {
        $super(optBounds || new Rectangle(0,0, 40, 30));
        // initialize laziliy loaded switchers so that those are there when clicked
        this.getColorSwitchers()
    },
},
'color choosers', {
    showColorChooserAndSwitchers: function(chooser) {
        this.world().addMorph(chooser);
        chooser.align(chooser.bounds().topLeft(), this.worldPoint(this.innerBounds().bottomLeft()));
        var x = chooser.bounds().right(), y = chooser.bounds().top();
        var switchers = this.getColorSwitchers();
        switchers.forEach(function(ea) {
            ea.colorField = this;
            this.world().addMorph(ea);
            ea.align(ea.bounds().bottomRight(), pt(x, y));
            x -= ea.getExtent().x;
        }, this)
    },

},
'accessing', {
    getColorSwitchers: function() {
        // so that they are created just once
        //  this.constructor.prototype.colorSwitchers = null
        if (!this.colorSwitchers)
            this.constructor.prototype.colorSwitchers = [
                new lively.morphic.ColorChooserSwitcher(new lively.morphic.CrayonColorChooser()),
                new lively.morphic.ColorChooserSwitcher(new lively.morphic.RGBColorChooser()),
                new lively.morphic.ColorChooserSwitcher(new lively.morphic.CustomColorChooser())
                ];
        return this.colorSwitchers;
    },
    getCurrentColorChooser: function() { return this.getCurrentColorSwitcher().colorChooser },
    getCurrentColorSwitcher: function() {
        if (!this.currentColorSwitcher)
            this.constructor.prototype.currentColorSwitcher = this.getColorSwitchers()[0];
        return this.currentColorSwitcher;
    },
    setCurrentColorSwitcher: function(switcher) {
        this.constructor.prototype.currentColorSwitcher = switcher;
        this.showColorChooserAndSwitchers(switcher.colorChooser);
    },

},
'mouse events', {
    correctForDragOffset: Functions.False,

    onMouseDown: function($super, evt) {
        if (!evt.isCommandKey() && evt.isLeftMouseButtonDown()) {
            this.showColorChooserAndSwitchers(this.getCurrentColorChooser());
            return true;
        }
        return $super(evt);
    },

    onMouseUp: function($super, evt) {
        if ($super(evt)) return true;
        this. removHelperMorphs()
        return true;
    },

    onDrag: function(evt) {
        var cc = this.getCurrentColorChooser(),
            color = cc.colorForPos(cc.localize(evt.getPosition()));
        this.setFill(color);
        this.color = color;
        return true;
    },

    onDragEnd: function(evt) {
        this.removHelperMorphs();
        return true;
    },

    removHelperMorphs: function() {
        this.getColorSwitchers().forEach(function(ea) {
            ea.remove()
            ea.colorChooser.remove()
        })
    },
});

lively.morphic.Button.subclass('lively.morphic.SimpleColorField',
'init', {
    defaultBounds: new Rectangle(0,0,24,24),
    defaultColor: Color.red,
    colorDisplayOffset: 4,
    colorDisplayBorderRadius: 3,

    initialize: function($super, bounds){
        var b = bounds || this.defaultBounds;
        $super(b, '');
        var colorDisplay = new lively.morphic.Box(b.insetBy(this.colorDisplayOffset));
        this.removeAllMorphs(); // get rid of the default Text
        this.addMorph(colorDisplay);
        this.setColor(this.defaultColor);
        colorDisplay.applyStyle({borderRadius: this.colorDisplayBorderRadius, resizeWidth: true, resizeHeight: true});
        this.applyStyle({adjustForNewBounds: true});
    },
    setValue: function(bool) {
        this.value = bool;
        // buttons should fire on mouse up
        if (!bool) {
            var chooser = new lively.morphic.RGBColorChooser(),
                menu = new lively.morphic.SimpleColorMenu(chooser),
                bounds = this.globalBounds(),
                pos = pt(bounds.x, bounds.y),
                menuPos = pos.addPt(pt(0, bounds.height));
            menu.open(lively.morphic.World.current(), menuPos, false);
            menu.setCallback(this, 'setColor');
        }
    },
    getColorDisplay: function() { return this.submorphs.detect(function(ea) { return ea instanceof lively.morphic.Box; }); },
    setColor: function(color) {
        this.color = color;
        this.getColorDisplay().setFill(color);
    }

});

lively.morphic.Box.subclass('lively.morphic.SimpleColorMenu',
'settings', {
    style: {
        fill: Color.gray.lighter(3),
        borderColor: Color.gray,
        borderWidth: 1,
        borderStyle: 'outset',
        borderRadius: 4,
    },
    chooserOffset: 4,
    isEpiMorph: true,
},
'init', {
    initialize: function($super, chooser) {
        this.colorChooser = chooser || new lively.morphic.RGBColorChooser();
        this.colorChooser.hasLabel = false;
        var b = this.colorChooser.getBounds();
        $super(new Rectangle(0,0, b.width + this.chooserOffset*2 , b.height+ this.chooserOffset*2));

    },

    setCallback: function(target, callback){
        if (this.colorChooser) connect(this.colorChooser, 'currentlySelectedColor', target, callback);
    },

    open: function(parentMorph, pos, remainOnScreen, callbackTarget, callbackFunc) {
        this.setPosition(pos || pt(0,0));
        var owner = parentMorph || lively.morphic.World.current();
        this.remainOnScreen = remainOnScreen;
        if (!remainOnScreen) {
            if (owner.currentMenu) { owner.currentMenu.remove() };
            owner.currentMenu = this;
        } else {
            this.isEpiMorph = false;
        }

        owner.addMorph(this);

        this.offsetForWorld(pos);

        this.addMorph(this.colorChooser);
        this.colorChooser.setPosition(pt(this.chooserOffset,this.chooserOffset));
        this.colorChooser.disableGrabbing();
        this.colorChooser.disableDragging();
        this.colorChooser.onMouseUp = function(evt) {
              this.currentlySelectedColor = this.colorForPos(this.localize(evt.getPosition()));
              this.owner.remove();
        };
        //this.colorChooser.callback = this.chooseColor;
        //connect(this.colorChooser, 'currentlySelectedColor', this, 'choosenColor');

        return this;
    },
    choosenColor: Color.black,
    remove: function($super) {
        var w = this.world();
        if (w && w.currentMenu === this) w.currentMenu = null;
        $super();
    },
    offsetForWorld: function(pos) {
        var bounds = this.innerBounds().translatedBy(pos);
        if (this.title) {
            bounds = bounds.withTopLeft(bounds.topLeft().addXY(0, this.title.getExtent().y));
        }
        if (this.owner.visibleBounds) {
            bounds = this.moveBoundsForVisibility(bounds, this.owner.visibleBounds());
        }
        this.setBounds(bounds);
    },
    moveBoundsForVisibility: function(menuBounds, visibleBounds) {
        var offsetX = 0,
            offsetY = 0;
        Global.lastMenuBounds = menuBounds;

        if (menuBounds.right() > visibleBounds.right())
            offsetX = -1 * (menuBounds.right() - visibleBounds.right());

        var overlapLeft = menuBounds.left() + offsetX;
        if (overlapLeft < 0)
            offsetX += -overlapLeft;

        if (menuBounds.bottom() > visibleBounds.bottom()) {
            offsetY = -1 * (menuBounds.bottom() - visibleBounds.bottom());
            // so that hand is not directly over menu, does not work when
            // menu is in the bottom right corner
            offsetX += 1;
        }
        var overlapTop = menuBounds.top() + offsetY;
        if (overlapTop < 0)
            offsetY += -overlapTop;

        return menuBounds.translatedBy(pt(offsetX, offsetY));
    },
}

);

lively.morphic.ColorChooser.subclass('lively.morphic.SimpleColorChooser',
'settings', {
    colorNames: 'custom',
},
'initializing', {
    initialize: function($super,bounds, colors){
        // under constructions...
        if (!colors) {
            colors = this.gatherCustomColors();
        }
        this.colors = colors;
        $super(bounds);
    },
    gatherCustomColors: function() {
        // lively.morphic.CustomColorChooser.prototype.gatherCustomColors()
        var colors = [];
        var gatherColor = function(eaColor) {
            if (eaColor && !colors.detect(function(colorSetEa) {
                return colorSetEa.equals(eaColor)}))
                colors.push(eaColor)
        }
        $world.withAllSubmorphsDo(function(ea) {
            gatherColor(ea.getBorderColor());
        })
        return colors
    },

    buildColorMap: function() {
        var x = Math.floor(Math.sqrt(this.colors.length)) + 1,
            y = x,
            extent = this.innerBounds().extent().scaleByPt(pt(1/x, 1/y));
        for (var j = 0; j < y; j++) {
            for (var i = 0; i < x; i++) {
                var idx = j*x+i, // running offset j*x^1 + i*y^0
                    color = this.colors[idx],
                    r = extent.scaleByPt(pt(i, j)).extent(extent),
                    morph = new lively.morphic.Box(r);
                morph.applyStyle({fill: color, borderWidth: 0});
                morph.ignoreEvents();
                this.addMorph(morph);
            }
        }
    }
},
'color mapping', {
    colorForPos: function(pos) {
        var r = this.shape.getBounds().insetBy(this.getBorderWidth()),
            pos = r.closestPointToPt(pos),
            m = this.submorphs.detect(function(ea) { return ea.bounds().containsPoint(pos) });
        return m ? m.getFill() : Color.black;
    }
});

lively.morphic.Box.subclass('lively.morphic.AwesomeColorPicker',
'documentation', {
    documentation: 'A self-contained saturation/brightness + hue + hex + alpha color ' +
        'picker popup. Hand-written (no PartsBin part involved) so it stays fully ' +
        'version-controlled.'
},
'settings', {
    style: {
        fill: Color.gray.lighter(3),
        borderWidth: 0,
        borderRadius: 4
    },
    isEpiMorph: true,
    tileSize: 6,
    hueFieldExtent: pt(24, 190),
    satBrtFieldExtent: pt(190, 190)
},
'initializing', {
    initialize: function($super) {
        $super(new Rectangle(0, 0, 10, 10));
        this.hue = 0;
        this.sat = 1;
        this.brt = 1;
        this.alpha = 1;
        this.color = Color.red;
        this.buildSubmorphs();
        this.setExtent(pt(this.satBrtField.bounds().right() + 8, this.rgbValueField.bounds().bottom() + 8));
        this.redraw();
    },

    buildSubmorphs: function() {
        var margin = 8;

        this.hueField = this.addMorph(this.buildHueField(
            new Rectangle(margin, margin, this.hueFieldExtent.x, this.hueFieldExtent.y)));

        this.satBrtField = this.addMorph(this.buildSatBrtField(new Rectangle(
            this.hueField.bounds().right() + margin, margin,
            this.satBrtFieldExtent.x, this.satBrtFieldExtent.y)));

        var bottomY = this.satBrtField.bounds().bottom() + margin,
            rowLeft = margin,
            rowRight = this.satBrtField.bounds().right() - margin,
            gap = 10,
            labelHexW = 28,
            hexFieldW = 70,
            labelAlphaW = 38,
            x = rowLeft;

        this.rgbLabel = this.addMorph(new lively.morphic.Text(new Rectangle(x, bottomY, labelHexW, 20), 'hex:'));
        this.rgbLabel.applyStyle({allowInput: false, selectable: false, fixedWidth: true, fixedHeight: true,
            borderWidth: 0, fill: Color.rgba(0,0,0,0)});
        x += labelHexW + gap;

        this.rgbValueField = this.addMorph(new lively.morphic.Text(
            new Rectangle(x, bottomY, hexFieldW, 20), '#FF0000'));
        this.rgbValueField.applyStyle({
            allowInput: true, selectable: true,
            fixedWidth: true, fixedHeight: true, borderWidth: 1, borderColor: Color.gray
        });
        this.rgbValueField.isInputLine = true;
        this.rgbValueField.setName('RGBValue');
        lively.bindings.connect(this.rgbValueField, 'savedTextString', this, 'updateColorFromString');
        x += hexFieldW + gap;

        this.alphaLabel = this.addMorph(new lively.morphic.Text(
            new Rectangle(x, bottomY, labelAlphaW, 20), 'alpha:'));
        this.alphaLabel.applyStyle({allowInput: false, selectable: false, fixedWidth: true, fixedHeight: true,
            borderWidth: 0, fill: Color.rgba(0,0,0,0)});
        x += labelAlphaW + gap;

        this.alphaSlider = this.addMorph(new lively.morphic.Slider(
            new Rectangle(x, bottomY + 4, rowRight - x, 12)));
        this.alphaSlider.setValueScale(1);
        this.alphaSlider.setValue(1);
        lively.bindings.connect(this.alphaSlider, 'value', this, 'updateAlpha');
    },

    buildHueField: function(bounds) {
        var field = new lively.morphic.Box(bounds);
        field.applyStyle({borderWidth: 1, borderColor: Color.gray, fill: Color.white});
        field.disableDragging();
        field.disableGrabbing();

        var rows = Math.max(1, Math.round(bounds.height / this.tileSize)),
            tileHeight = bounds.height / rows;
        for (var i = 0; i < rows; i++) {
            var h = i / rows,
                rgb = hslToRgb(h, 1, 0.5),
                tile = new lively.morphic.Box(new Rectangle(0, i * tileHeight, bounds.width, tileHeight + 1));
            tile.applyStyle({fill: new Color(rgb[0]/255, rgb[1]/255, rgb[2]/255), borderWidth: 0});
            tile.ignoreEvents();
            field.addMorph(tile);
        }

        field.indicator = field.addMorph(new lively.morphic.Box(new Rectangle(0, 0, bounds.width, 2)));
        field.indicator.applyStyle({fill: Color.black, borderWidth: 1, borderColor: Color.white});
        field.indicator.ignoreEvents();

        field.addScript(function onMouseDown(evt) { return this.onDrag(evt); });
        field.addScript(function onDrag(evt) {
            var pos = evt.getPositionIn(this),
                extent = this.getExtent(),
                hue = Math.max(0, Math.min(1, pos.y / extent.y));
            this.owner.updateHue(hue);
            evt.stop();
            return true;
        });
        return field;
    },

    buildSatBrtField: function(bounds) {
        var field = new lively.morphic.Box(bounds);
        field.applyStyle({borderWidth: 1, borderColor: Color.gray, fill: Color.white});
        field.disableDragging();
        field.disableGrabbing();
        field.tiles = [];

        var cols = Math.max(1, Math.round(bounds.width / this.tileSize)),
            rows = Math.max(1, Math.round(bounds.height / this.tileSize)),
            tileW = bounds.width / cols,
            tileH = bounds.height / rows;
        for (var x = 0; x < cols; x++) {
            for (var y = 0; y < rows; y++) {
                var tile = new lively.morphic.Box(new Rectangle(x * tileW, y * tileH, tileW + 1, tileH + 1));
                tile.applyStyle({fill: Color.white, borderWidth: 0});
                tile.ignoreEvents();
                tile.sat = x / cols;
                tile.brt = 1 - (y / rows);
                field.addMorph(tile);
                field.tiles.push(tile);
            }
        }
        field.redraw = function(hue) {
            this.tiles.forEach(function(tile) {
                var rgb = hslToRgb(hue, tile.sat, tile.brt);
                tile.setFill(new Color(rgb[0]/255, rgb[1]/255, rgb[2]/255));
            });
        };

        field.indicator = field.addMorph(new lively.morphic.Box(new Rectangle(0, 0, 8, 8)));
        field.indicator.applyStyle({
            fill: Color.rgba(0,0,0,0), borderWidth: 1, borderColor: Color.white, borderRadius: 4
        });
        field.indicator.ignoreEvents();

        field.addScript(function onMouseDown(evt) { return this.onDrag(evt); });
        field.addScript(function onDrag(evt) {
            var pos = evt.getPositionIn(this),
                extent = this.getExtent(),
                sat = Math.max(0, Math.min(1, pos.x / extent.x)),
                brt = Math.max(0, Math.min(1, 1 - (pos.y / extent.y)));
            this.owner.updateSat(sat);
            this.owner.updateBrt(brt);
            evt.stop();
            return true;
        });
        return field;
    }
},
'accessing', {
    setColor: function(color) {
        if (!color) return;
        this.color = color;
        var hsb = colorToHSB(color);
        this.hue = hsb[0];
        this.sat = hsb[1];
        this.brt = hsb[2];
        this.alpha = (color.a === undefined) ? 1 : color.a;
        this.redraw();
    },

    updateColorFromString: function(hexString) {
        if (this.isJustChangingTheString) return;
        var color = Color.rgbHex(hexString);
        if (color) this.setColor(color);
    },

    updateHue: function(hue) { this.hue = hue; this.redraw(); },
    updateSat: function(sat) { this.sat = sat; this.redraw(); },
    updateBrt: function(brt) { this.brt = brt; this.redraw(); },
    updateAlpha: function(alpha) { this.alpha = alpha; this.redraw(); },

    redraw: function() {
        var rgb = hslToRgb(this.hue, this.sat, this.brt);
        this.color = (new Color(rgb[0]/255, rgb[1]/255, rgb[2]/255)).withA(this.alpha);

        this.isJustChangingTheString = true;
        this.rgbValueField.textString = this.color.toHexString().toUpperCase();
        this.isJustChangingTheString = false;
        this.alphaSlider.setValue(this.alpha);

        this.satBrtField.redraw(this.hue);

        var hueExtent = this.hueField.getExtent(),
            hy = this.hue * hueExtent.y;
        this.hueField.indicator.setPosition(pt(0, Math.max(0, Math.min(hueExtent.y - 2, hy - 1))));

        var sbExtent = this.satBrtField.getExtent(),
            sx = this.sat * sbExtent.x,
            sy = (1 - this.brt) * sbExtent.y;
        this.satBrtField.indicator.setPosition(pt(sx - 4, sy - 4));
    }
},
'opening and closing', {
    open: function(parentMorph, pos) {
        this.setPosition(pos || pt(0,0));
        var owner = parentMorph || lively.morphic.World.current();
        if (owner.currentMenu) { owner.currentMenu.remove(); }
        owner.currentMenu = this;
        owner.addMorph(this);
        this.offsetForWorld(pos);
        return this;
    },
    remove: function($super) {
        var w = this.world();
        if (w && w.currentMenu === this) w.currentMenu = null;
        $super();
    },
    offsetForWorld: function(pos) {
        var bounds = this.innerBounds().translatedBy(pos);
        if (this.owner.visibleBounds) {
            bounds = this.moveBoundsForVisibility(bounds, this.owner.visibleBounds());
        }
        this.setBounds(bounds);
    },
    moveBoundsForVisibility: function(menuBounds, visibleBounds) {
        var offsetX = 0, offsetY = 0;

        if (menuBounds.right() > visibleBounds.right())
            offsetX = -1 * (menuBounds.right() - visibleBounds.right());

        var overlapLeft = menuBounds.left() + offsetX;
        if (overlapLeft < 0) offsetX += -overlapLeft;

        if (menuBounds.bottom() > visibleBounds.bottom()) {
            offsetY = -1 * (menuBounds.bottom() - visibleBounds.bottom());
            offsetX += 1;
        }
        var overlapTop = menuBounds.top() + offsetY;
        if (overlapTop < 0) offsetY += -overlapTop;

        return menuBounds.translatedBy(pt(offsetX, offsetY));
    }
});

lively.morphic.SimpleColorField.subclass('lively.morphic.AwesomeColorField',
'init', {
    setValue: function(bool) {
        this.value = bool;
        // buttons should fire on mouse up
        if (!bool) {
            var picker = new lively.morphic.AwesomeColorPicker(),
                bounds = this.globalBounds(),
                pos = pt(bounds.x, bounds.y),
                menuPos = pos.addPt(pt(0, bounds.height));
            picker.setColor(this.color);
            picker.open(lively.morphic.World.current(), menuPos);
            lively.bindings.connect(picker, 'color', this, 'setColor');
        }
    }
});

}) // end of module
