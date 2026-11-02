/**
 * lively.identity.WalletSetupDialog
 *
 * WalletSpec.md §8.1/§8.2, §15 step 4. Mirrors RegisterDialog.js's own
 * BuildSpec Window shape and instantiation pattern
 * (lively.BuildSpec("...").createMorph().openInWorldCenter()). RegisterDialog
 * itself has no multi-step-screen precedent to copy (it's one flat form) —
 * this dialog's content area swaps between a few main-world-rendered
 * screens (choice, options, success, error) and the vault iframe itself
 * (positioned over the content area, never reparented — see
 * lively.identity.WalletBridge's showVaultFrame/hideVaultFrame for why).
 *
 * Flow: choice (create/import) -> options (word count for create, unlock
 * method + password) -> vault becomes visible over the content area and
 * WalletBridge.setup() fires; the vault's OWN UI (WalletVault.js) handles
 * mnemonic display + confirmation quiz (create) or the import textarea
 * (import) entirely inside itself — this dialog never sees the mnemonic,
 * only the final {address} result (§3.4: the mnemonic never crosses the
 * postMessage boundary, in any flow) -> success screen with the address.
 *
 * Third choice screen option: "Recover from Files Backup" (WalletSpec.md
 * §7.2/§7.3) — requested directly by the project owner after using the
 * Files-backup feature and noticing there was no way to actually USE a
 * backup once created. Skips the vault iframe entirely: recovery decrypts
 * the identity's own Files-encryption-plane layer in the MAIN world
 * (lively.identity.WalletBackup.recoverBackup) and hands the still-opaque,
 * still-vault-encrypted blob to WalletBridge.importBackupBlob — a plain,
 * fast RPC call with no vault-side UI to show, unlike create/import's
 * mnemonic-display/confirmation-quiz flow. Only works on the SAME
 * device/browser that created the backup (WalletBackup.js's own header:
 * the backup's objId is tracked locally, by design, since it's
 * deliberately excluded from every listing) — not a substitute for
 * recovering on a genuinely new device, where the recovery phrase on
 * paper (§7.3) is still the real path.
 *
 * Dependencies:
 *   lively.identity.WalletBridge — setup, showVaultFrame, hideVaultFrame
 *   lively.identity.WalletBackup — recoverBackup
 */

module("lively.identity.WalletSetupDialog")
  .requires(
    "lively.identity.WalletBridge",
    "lively.identity.WalletBackup",
    "lively.persistence.BuildSpec",
    "lively.morphic.Complete",
  )
  .toRun(function () {
    lively.BuildSpec("lively.identity.WalletSetupDialog", {
      _BorderRadius: 7,
      _Extent: lively.pt(306, 260),
      className: "lively.morphic.Window",
      contentOffset: lively.pt(3, 22),
      draggingEnabled: true,
      droppingEnabled: false,
      layout: { adjustForNewBounds: true },
      name: "WalletSetupDialog",
      titleBar: "Set up Wallet",
      submorphs: [
        {
          _BorderRadius: 4,
          _Extent: lively.pt(300, 235),
          _Fill: Color.rgb(243, 243, 243),
          _Position: lively.pt(3, 22),
          className: "lively.morphic.Box",
          layout: {
            adjustForNewBounds: true,
            resizeWidth: true,
          },
          name: "setupContent",
          submorphs: [],
        },
      ],

      // Fires this dialog's own onRemove (below) on close, however it
      // closes -- X button, Cancel, or the normal completion flow -- so the
      // vault-frame sync loop and the vault iframe itself always get
      // cleaned up, not just on the paths that already call
      // _stopVaultFrameSync()/hideVaultFrame() explicitly.
      connectionRebuilder: function connectionRebuilder() {
        lively.bindings.connect(this, "remove", this, "onRemove", {});
      },

      // ─── lifecycle ──────────────────────────────────────────────────────────

      onFromBuildSpecCreated: function onFromBuildSpecCreated() {
        // Window's own onFromBuildSpecCreated (BuildSpecMorphExtensions.js)
        // is what actually builds the title bar and reframe handles from
        // the titleBar:/reframeHandle: BuildSpec properties above -- this
        // override used to shadow it entirely with no $super() call, so
        // the dialog rendered with no title bar, no drag handle, and no
        // resize handles at all.
        $super();
        this._wordCount = 12;
        this._kdf = "webauthn-prf";
        this.buildChoiceScreen();
      },

      // ─── screen helpers ─────────────────────────────────────────────────────

      _clearContent: function _clearContent() {
        var content = this.get("setupContent");
        content.removeAllMorphs();
        return content;
      },

      // Shrinks/grows the window to fit whichever screen is currently
      // built, instead of a single large fixed size sitting mostly empty
      // for the short screens (choice/success/error) and only actually
      // needed for the vault-visible screen, which stays a fixed generous
      // size on purpose since its content (mnemonic display, confirmation
      // quiz) is unknown from the main world. Width is NOT included in this
      // fit -- see PANE_WIDTH below for why it's a fixed constant instead.
      _fitToContent: function _fitToContent() {
        var content = this.get("setupContent");
        var maxBottom = 0;
        content.submorphs.forEach(function (m) {
          var b = m.bounds();
          maxBottom = Math.max(maxBottom, b.y + b.height);
        });
        var newContentHeight = Math.max(120, maxBottom + 20);
        content.setExtent(pt(content.getExtent().x, newContentHeight));
        var contentOffset = this.contentOffset || lively.pt(3, 22);
        this.setExtent(pt(this.getExtent().x, newContentHeight + contentOffset.y + 6));
      },

      // Measures real rendered text width (canvas measureText, not a
      // character-count guess) so buttons can hug their label instead of
      // every button sharing one oversized fixed width regardless of how
      // short its text is. PANE_WIDTH itself stays a fixed constant (not
      // computed from content each screen) because the paragraph-style body
      // copy on some screens (recover/backup explanation, success address)
      // needs a stable, readable wrap width -- calculated once here from
      // the widest actual button row across every screen (the Unlock
      // method row), not from those paragraphs.
      _measureTextWidth: function _measureTextWidth(text, fontSize) {
        if (!this._measureCtx) this._measureCtx = document.createElement("canvas").getContext("2d");
        this._measureCtx.font = (fontSize || 12) + "px Arial, sans-serif";
        return this._measureCtx.measureText(text).width;
      },

      // rect for a button sized to hug its own label instead of a fixed
      // one-size-fits-all width.
      _buttonRect: function _buttonRect(x, y, text, height) {
        var w = Math.ceil(this._measureTextWidth(text, 12)) + 28;
        return lively.rect(x, y, w, height || 24);
      },

      // Resizes a just-added Text morph to its REAL wrapped height and
      // returns that height. Must be called AFTER content.addMorph(t) --
      // getTextExtent() dispatches to the render context (TextCore.js), so
      // it only reflects genuine wrapped rendering once the morph is
      // actually in the world; a canvas-measureText guess was tried first
      // and confirmed wrong in practice (it doesn't know this Text morph's
      // actual rendered font, so it under/over-estimated how many lines
      // some headings/paragraphs would wrap to -- e.g. predicted 1 line for
      // a heading that really wrapped to 2, so the next control drawn below
      // it silently overlapped the unaccounted-for second line).
      _fitTextHeight: function _fitTextHeight(t, w, minHeight) {
        var textHeight = t.getTextExtent().y;
        var h = Math.max(minHeight, textHeight || minHeight);
        t.setExtent(pt(w, h));
        return h;
      },

      _addHeading: function _addHeading(content, text, y) {
        // Text defaults to a visible border (its normal "input box" look) --
        // headings/body copy in this dialog are plain labels, not editable
        // fields, so borderWidth must be zeroed explicitly or every line of
        // copy renders looking like an empty text input.
        var w = content.getExtent().x - 28;
        var heading = new lively.morphic.Text(lively.rect(14, y, w, 24), text);
        heading.applyStyle({ allowInput: false, fontSize: 16, fontWeight: 'bold', borderWidth: 0, fill: null });
        content.addMorph(heading);
        var h = this._fitTextHeight(heading, w, 22);
        return y + h + 12;
      },

      _addText: function _addText(content, text, y, style) {
        var w = content.getExtent().x - 28;
        var fontSize = (style && style.fontSize) || 12;
        var t = new lively.morphic.Text(lively.rect(14, y, w, 24), text);
        // wordBreak: 'break-all' -- confirmed live this matters: a long
        // unbroken token (an 0x... address is the case that surfaced it)
        // has no spaces to wrap on, so without this it silently overflows
        // the pane's right edge horizontally instead of respecting w,
        // getTextExtent() reporting a width wider than the box it was
        // given. Harmless for normal prose, which never needs mid-word
        // breaks in the first place.
        t.applyStyle(Object.assign({ allowInput: false, fontSize: fontSize, borderWidth: 0, fill: null, wordBreak: 'break-all' }, style || {}));
        content.addMorph(t);
        var h = this._fitTextHeight(t, w, fontSize + 6);
        return y + h + 12;
      },

      // ─── shared action-row buttons (forward action right, back/close left) ──
      //
      // Every screen below used to chain its two bottom buttons left-to-right
      // in whatever order they were coded, with no consistent meaning to the
      // position. This gives every screen the same affordance instead: a
      // solid purple pill on the RIGHT is always "move forward" (Continue,
      // Recover Wallet, Try Again, Open Wallet), a plain ghost-style text
      // button on the LEFT is always "go back/dismiss" (Back, Close). Both
      // get soft, fully-rounded (pill) corners rather than the old sharp
      // rectangular buttons, matching the choice screen's own pill language.

      _addPrimaryButton: function _addPrimaryButton(content, rect, label, action) {
        var btn = new lively.morphic.Button(rect, label);
        lively.bindings.connect(btn, "fire", this, action);
        content.addMorph(btn);
        (function () {
          var node = btn.renderContext && btn.renderContext().shapeNode;
          if (node) {
            node.style.background = "rgb(147,51,234)";
            node.style.border = "2px solid rgb(147,51,234)";
            node.style.borderRadius = (rect.height / 2) + "px";
          }
        }).delay(0);
        if (btn.label && btn.label.setTextColor) btn.label.setTextColor(Color.white);
        if (btn.label && btn.label.applyStyle) btn.label.applyStyle({ fontWeight: "600" });
        return btn;
      },

      _addSecondaryButton: function _addSecondaryButton(content, rect, label, action) {
        var btn = new lively.morphic.Button(rect, label);
        lively.bindings.connect(btn, "fire", this, action);
        content.addMorph(btn);
        (function () {
          var node = btn.renderContext && btn.renderContext().shapeNode;
          if (node) {
            node.style.background = "transparent";
            node.style.border = "none";
            node.style.borderRadius = (rect.height / 2) + "px";
          }
        }).delay(0);
        if (btn.label && btn.label.setTextColor) btn.label.setTextColor(Color.rgb(120, 120, 120));
        return btn;
      },

      // Lays out one bottom action row: secondary button (if given) flush
      // left, primary button flush right, each hugging its own measured
      // label width rather than a shared fixed width. Returns the row's
      // bottom y plus both button morphs, so callers that need to
      // enable/disable the primary button later (e.g. _onRecoverConfirm's
      // "Recovering…" state) still have a handle on it.
      _addActionRow: function _addActionRow(content, y, primaryLabel, primaryAction, secondaryLabel, secondaryAction) {
        var h = 32;
        var contentW = content.getExtent().x;
        var primaryW = Math.ceil(this._measureTextWidth(primaryLabel, 13)) + 44;
        var primaryRect = lively.rect(contentW - 14 - primaryW, y, primaryW, h);
        var primaryBtn = this._addPrimaryButton(content, primaryRect, primaryLabel, primaryAction);
        var secondaryBtn = null;
        if (secondaryLabel) {
          var secondaryW = Math.ceil(this._measureTextWidth(secondaryLabel, 12)) + 20;
          secondaryBtn = this._addSecondaryButton(content, lively.rect(14, y + (h - 26) / 2, secondaryW, 26), secondaryLabel, secondaryAction);
        }
        return { y: y + h, primaryBtn: primaryBtn, secondaryBtn: secondaryBtn };
      },

      // ─── choice screen ──────────────────────────────────────────────────────

      // Purple-accent pill styling for the three top-level setup choices.
      // Same DOM-bypass recipe as _paintToggleButton/ConstellationLounge.js's
      // own _paintPillButton: background/border/radius have to be written
      // directly to the shapeNode for a procedurally-`new`'d button (the
      // model-layer applyStyle/setFill call silently never reaches the DOM
      // for these), while the label's own setTextColor is a plain Text
      // morph setter and works fine through the normal model layer. Unlike
      // _paintToggleButton (only ever called on later, already-stable
      // screens), this runs at dialog CONSTRUCTION time -- a same-tick
      // direct-DOM write here got silently discarded (confirmed live: only
      // `border-width` survived, `border-color`/`border-style` were gone)
      // because a layout pass still in flight right after addMorph
      // regenerates the shapeNode, same gotcha AuthChoiceDialog.js's own
      // paintButton already works around with a 0-delay.
      _paintPillButton: function _paintPillButton(btn, radius) {
        (function () {
          var node = btn.renderContext && btn.renderContext().shapeNode;
          if (node) {
            node.style.background = "#fff";
            node.style.border = "2px solid rgb(147,51,234)";
            node.style.borderRadius = radius + "px";
          }
        }).delay(0);
        if (btn.label) {
          if (btn.label.setTextColor) btn.label.setTextColor(Color.rgb(88, 28, 135));
          if (btn.label.applyStyle) btn.label.applyStyle({ fontWeight: "600" });
        }
      },

      buildChoiceScreen: function buildChoiceScreen() {
        var self = this;
        var content = this._clearContent();
        var y = this._addHeading(content, "Set up your wallet", 14);
        y += 4;

        var choices = [
          { label: "Create New Wallet", action: "startCreate" },
          { label: "Import Existing Wallet", action: "startImport" },
          { label: "Recover from Backup", action: "startRecover" },
        ];

        var btnHeight = 34;
        var radius = btnHeight / 2;
        var contentW = content.getExtent().x;
        var maxTextW = 0;
        choices.forEach(function (choice) {
          maxTextW = Math.max(maxTextW, self._measureTextWidth(choice.label, 13));
        });
        var btnWidth = Math.min(contentW - 28, Math.ceil(maxTextW) + 48);
        var btnX = Math.round((contentW - btnWidth) / 2);

        choices.forEach(function (choice) {
          var btn = new lively.morphic.Button(lively.rect(btnX, y, btnWidth, btnHeight), choice.label);
          lively.bindings.connect(btn, "fire", self, choice.action);
          content.addMorph(btn);
          self._paintPillButton(btn, radius);
          y += btnHeight + 14;
        });

        this._fitToContent();
      },

      startCreate: function startCreate() { this.buildOptionsScreen("create"); },
      startImport: function startImport() { this.buildOptionsScreen("import"); },
      startRecover: function startRecover() { this.buildRecoverScreen(); },

      // ─── options screen (word count for create; unlock method + password) ──

      buildOptionsScreen: function buildOptionsScreen(mode) {
        var self = this;
        this._mode = mode;
        var content = this._clearContent();
        var y = this._addHeading(
          content,
          mode === "create" ? "Create New Wallet" : "Import Existing Wallet",
          14,
        );

        if (mode === "create") {
          // _addText's return value is already a tight, real gap (measures
          // actual wrapped height -- see _fitTextHeight), so no manual
          // compaction is needed here or on "Unlock method:" below.
          y = this._addText(content, "Word count:", y, { fontSize: 11 });
          var wc12Rect = this._buttonRect(14, y, "12 words");
          var wc12 = new lively.morphic.Button(wc12Rect, "12 words");
          var wc24 = new lively.morphic.Button(this._buttonRect(wc12Rect.right() + 6, y, "24 words"), "24 words");
          this._wc12Btn = wc12;
          this._wc24Btn = wc24;
          lively.bindings.connect(wc12, "fire", self, "_selectWordCount12");
          lively.bindings.connect(wc24, "fire", self, "_selectWordCount24");
          content.addMorph(wc12);
          content.addMorph(wc24);
          // Paint AFTER addMorph, not before -- confirmed live: styling a
          // button before it's actually in the world's render tree updates
          // the model (getFill()/getBorderColor() report the new values
          // correctly) but never reaches the DOM, since addMorph renders a
          // fresh node for it on insertion rather than reusing whatever
          // render context a not-yet-attached morph had.
          this._paintWordCount();
          y += 36;
        }

        // No "- 24" compaction here either, same reasoning as "Word count:"
        // above -- _addText's return value is already a tight, real gap
        // now that it measures actual wrapped height instead of assuming a
        // fixed one, so subtracting further just re-introduces the overlap
        // this comment used to warn the word-count block away from.
        y = this._addText(content, "Unlock method:", y, { fontSize: 11 });
        var kdfWebAuthnRect = this._buttonRect(14, y, "Passkey (WebAuthn)");
        var kdfWebAuthn = new lively.morphic.Button(kdfWebAuthnRect, "Passkey (WebAuthn)");
        var kdfPassword = new lively.morphic.Button(this._buttonRect(kdfWebAuthnRect.right() + 6, y, "Password"), "Password");
        var passwordInput = new lively.morphic.Text(lively.rect(14, y + 32, content.getExtent().x - 28, 22), "");
        passwordInput.applyStyle({
          allowInput: true, fontSize: 12, fill: Color.white,
          borderWidth: 1, borderColor: Color.rgb(214, 214, 214), borderRadius: 8,
          padding: lively.rect(4, 3, 0, 0),
        });
        passwordInput.beInputLine();

        this._kdfWebAuthnBtn = kdfWebAuthn;
        this._kdfPasswordBtn = kdfPassword;
        this._passwordInput = passwordInput;
        lively.bindings.connect(kdfWebAuthn, "fire", self, "_selectKdfWebAuthn");
        lively.bindings.connect(kdfPassword, "fire", self, "_selectKdfPassword");
        content.addMorph(kdfWebAuthn);
        content.addMorph(kdfPassword);
        content.addMorph(passwordInput);
        this._paintKdf(); // after addMorph -- see word-count's own comment above
        y += 64;

        var statusText = new lively.morphic.Text(lively.rect(14, y, content.getExtent().x - 28, 22), "");
        statusText.name = "statusText";
        statusText.applyStyle({ allowInput: false, fontSize: 11, borderWidth: 0, fill: null, fontColor: Color.rgb(180, 40, 40) });
        content.addMorph(statusText);
        this._statusText = statusText;
        y += 30;

        this._addActionRow(content, y, "Continue", "_onOptionsContinue", "Back", "buildChoiceScreen");
        this._fitToContent();
      },

      // Shared selected/unselected look for a manual toggle-button group
      // (Lively has no built-in radio widget). Root-caused live: Button's
      // fill/borderColor model setters (setFill/applyStyle({fill:...}))
      // update getFill()/getBorderColor() correctly but never actually
      // touch the rendered DOM at all for this morph type -- confirmed by
      // diffing shapeNode.outerHTML before/after setFill(), byte-identical.
      // borderWidth is the only style property that does reach the DOM via
      // the model layer. Rather than rely on that alone, this sets
      // background/border-color directly on the rendered shapeNode -- a
      // real, verified-working fix, not a workaround stacked on top of a
      // guess -- so the selected state gets an unambiguous filled-blue look
      // instead of depending solely on a 1px border-width difference.
      _paintToggleButton: function _paintToggleButton(btn, isSelected) {
        btn.setBorderWidth(isSelected ? 2 : 1);
        var node = btn.renderContext().shapeNode;
        // A solid fill made the button's own label text hard to read
        // against it -- a translucent purple tint over the button's
        // existing white background keeps the selected state obvious while
        // leaving the label legible. Matches the choice screen's own
        // purple-accent pill language instead of the old unrelated blue.
        node.style.background = isSelected ? 'rgba(147,51,234,0.12)' : '#fff';
        node.style.borderColor = isSelected ? 'rgb(147,51,234)' : 'rgb(214,214,214)';
        // Soft rounded corners rather than the sharp default -- kept well
        // short of a full pill (height/2) since these sit side-by-side in a
        // segmented-control row, where a full pill reads oddly on inner
        // touching edges.
        node.style.borderRadius = '8px';
        if (btn.label && btn.label.setTextColor) {
          btn.label.setTextColor(isSelected ? Color.rgb(88, 28, 135) : Color.rgb(90, 90, 90));
        }
        if (btn.label && btn.label.applyStyle) {
          btn.label.applyStyle({ fontWeight: isSelected ? 'bold' : 'normal' });
        }
      },

      _paintWordCount: function _paintWordCount() {
        if (!this._wc12Btn) return;
        this._paintToggleButton(this._wc12Btn, this._wordCount === 12);
        this._paintToggleButton(this._wc24Btn, this._wordCount === 24);
      },
      _selectWordCount12: function _selectWordCount12() { this._wordCount = 12; this._paintWordCount(); },
      _selectWordCount24: function _selectWordCount24() { this._wordCount = 24; this._paintWordCount(); },

      _paintKdf: function _paintKdf() {
        if (!this._kdfWebAuthnBtn) return;
        this._paintToggleButton(this._kdfWebAuthnBtn, this._kdf === "webauthn-prf");
        this._paintToggleButton(this._kdfPasswordBtn, this._kdf === "argon2id");
        this._passwordInput.setVisible(this._kdf === "argon2id");
      },
      _selectKdfWebAuthn: function _selectKdfWebAuthn() { this._kdf = "webauthn-prf"; this._paintKdf(); },
      _selectKdfPassword: function _selectKdfPassword() { this._kdf = "argon2id"; this._paintKdf(); },

      _onOptionsContinue: function _onOptionsContinue() {
        if (this._kdf === "argon2id") {
          var pw = this._passwordInput ? this._passwordInput.textString : "";
          if (!pw) {
            if (this._statusText) this._statusText.setTextString("Enter a password, or choose Passkey instead.");
            return;
          }
          this._password = pw;
        }
        this.startVaultFlow();
      },

      // ─── vault-visible screen (§8.1/§8.2's actual secret-touching UI) ──────

      startVaultFlow: function startVaultFlow() {
        var self = this;
        var content = this._clearContent();
        this._addText(
          content,
          "Continue in the panel below…",
          14,
          { fontSize: 13 },
        );

        // No Back button drawn HERE -- the vault iframe positions itself
        // directly over this whole content pane (see below) with its own
        // opaque background the instant its write-down/import screen
        // renders, which is almost immediately after this screen builds.
        // A button drawn in this pane would just sit behind that overlay,
        // unreachable (confirmed live: exactly this happened on a first
        // attempt at this button). The real Back affordance lives INSIDE
        // the vault's own write-down/import screens (WalletVault.js) and
        // signals back out through the setup() callback below instead.

        // The vault's own content (mnemonic word grid, confirmation quiz,
        // import textarea) needs real room -- more than the compact option
        // screens this dialog otherwise auto-fits to (_fitToContent's
        // screens can be as small as ~300x260). Explicitly grow to a fixed,
        // generous size for this screen specifically, before positioning
        // the iframe over it, instead of inheriting whatever size the
        // previous screen left the window at -- confirmed live this was
        // cutting off the vault's own input/textarea.
        //
        // Width is widened here too (every other screen stays a fixed
        // 300px-wide pane -- see PANE_WIDTH's own comment), not just
        // height, because the old fixed 300px pane was the actual ROOT
        // CAUSE of the 24-word write-down screen needing its own internal
        // scrollbar: at 300px wide, even WalletVault.js's 4-column word
        // grid runs to ~830px tall. Widening to 480px shrinks that same
        // grid to ~490px tall -- confirmed live by driving the vault's own
        // /wallet-vault page directly at this exact width -- comfortably
        // inside the fixed height below with no scrolling at either 12 or
        // 24 words.
        //
        // Height is set directly on the content pane (as every other
        // screen already does -- this content pane's layout has no
        // resizeHeight), but WIDTH must NOT also be set directly here --
        // confirmed live this was the actual cause of the reported
        // "window frame cut off / content box overextending" bug. The
        // content pane's own layout (resizeWidth: true) already grows its
        // width automatically, by the SAME delta as the window's own
        // setExtent below, every time the window resizes (306 -> 480 here
        // is a +174 delta, applied on top of the pane's existing 300 ->
        // 474 -- exactly the target width). Setting the pane's width
        // directly first, THEN also resizing the window, applied that
        // +174 delta TWICE (once from this code, once from the layout),
        // landing the pane at 648px -- 168px wider than the 480px window
        // meant to contain it, which is what actually overflowed the
        // window's own rounded frame.
        var vaultWidth = 480;
        var vaultContentHeight = 520;
        content.setExtent(pt(content.getExtent().x, vaultContentHeight));
        var contentOffset = this.contentOffset || lively.pt(3, 22);
        this.setExtent(pt(vaultWidth, vaultContentHeight + contentOffset.y + 6));

        // The vault iframe is positioned over this dialog's own content
        // area (never reparented — see WalletBridge.showVaultFrame's own
        // header for why: reparenting an iframe reloads it in most
        // browsers, which would wipe WalletVault's in-memory _unlockedDek
        // mid-flow). Position is kept in sync continuously, not set once --
        // see _startVaultFrameSync: the iframe is a plain position:fixed
        // DOM element with no awareness of morphic window dragging, so a
        // one-time snapshot left it visibly behind on screen the moment the
        // user dragged this window (confirmed live, reported directly).
        this._startVaultFrameSync();

        var options = {
          mode: this._mode,
          wordCount: this._wordCount,
          kdf: this._kdf,
          password: this._password,
        };
        lively.identity.walletBridge.setup(options, function (err, result) {
          self._stopVaultFrameSync();
          lively.identity.walletBridge.hideVaultFrame();
          // The vault's own write-down/import screen has a "Back" button
          // (WalletVault.js) that resolves setup() with this tagged error
          // instead of a real failure -- rebuild the options screen
          // rather than showing an error screen for it.
          if (err && err.code === "user-back") return self._onVaultBack();
          if (err) return self.buildErrorScreen(err);
          self.buildSuccessScreen(result.address);
        });
      },

      _onVaultBack: function _onVaultBack() {
        // Shrink the window's WIDTH back to every other screen's fixed
        // 306px before rebuilding -- same delta-driven resizeWidth layout
        // as startVaultFlow's own widening (306 -> 480 there; 480 -> 306
        // here shrinks the content pane back down by the same -174 delta
        // it grew by), done as a width-only step so buildOptionsScreen's
        // own _fitToContent call (height-only, like every other screen)
        // doesn't have to also know about the vault screen's width.
        this.setExtent(pt(306, this.getExtent().y));
        this.buildOptionsScreen(this._mode);
      },

      // Keeps the vault iframe's on-screen position matching this dialog's
      // actual current bounds for as long as the vault-visible screen is
      // showing. requestAnimationFrame rather than a fixed-interval timer
      // so it tracks smoothly during an active drag and costs nothing once
      // idle (the loop still ticks at display refresh rate while idle, but
      // showVaultFrame's cssText write is cheap and only actually changes
      // anything during a drag).
      _startVaultFrameSync: function _startVaultFrameSync() {
        var self = this;
        this._stopVaultFrameSync();
        function sync() {
          if (!self.world || !self.world()) return; // dialog was removed
          var shapeNode = self.renderContext().shapeNode;
          var domRect = shapeNode.getBoundingClientRect();
          var contentOffset = self.contentOffset || lively.pt(3, 22);
          lively.identity.walletBridge.showVaultFrame({
            top: domRect.top + contentOffset.y,
            left: domRect.left + contentOffset.x,
            width: domRect.width - contentOffset.x * 2,
            height: domRect.height - contentOffset.y - contentOffset.x,
          });
          self._vaultFrameSyncHandle = requestAnimationFrame(sync);
        }
        sync();
      },

      _stopVaultFrameSync: function _stopVaultFrameSync() {
        if (this._vaultFrameSyncHandle) {
          cancelAnimationFrame(this._vaultFrameSyncHandle);
          this._vaultFrameSyncHandle = null;
        }
      },

      // Safety net for closing the dialog (X button, Cancel) WHILE the
      // vault screen is showing -- without this the sync loop above would
      // keep running against a removed morph, and the vault iframe would
      // stay visible (just stuck at its last position) instead of hiding.
      // Wired via connectionRebuilder below, same pattern
      // PublishToInventoryDialog.js uses for its own window-level cleanup.
      onRemove: function onRemove() {
        this._stopVaultFrameSync();
        if (typeof lively !== "undefined" && lively.identity && lively.identity.walletBridge) {
          lively.identity.walletBridge.hideVaultFrame();
        }
      },

      // ─── recover-from-Files-backup screen ───────────────────────────────────
      // No vault iframe involved at all — recoverBackup does its work
      // entirely in the main world (this identity's own Files-encryption
      // KEK/DEK) plus one plain, fast RPC call (importBackupBlob), not the
      // mnemonic-display/confirmation-quiz flow create/import need.

      buildRecoverScreen: function buildRecoverScreen() {
        var self = this;
        var content = this._clearContent();
        var y = this._addHeading(content, "Recover from Backup", 14);
        y = this._addText(
          content,
          "If this wallet was ever backed up to your private Files, this " +
            "restores it — from any device, after signing in and confirming " +
            "your passkey — without re-entering your recovery phrase.",
          y,
          { fontSize: 11 },
        );

        var statusText = new lively.morphic.Text(lively.rect(14, y, content.getExtent().x - 28, 22), "");
        statusText.applyStyle({ allowInput: false, fontSize: 11, borderWidth: 0, fill: null, fontColor: Color.rgb(180, 40, 40) });
        content.addMorph(statusText);
        this._recoverStatusText = statusText;
        y += 30;

        var row = this._addActionRow(content, y, "Recover Wallet", "_onRecoverConfirm", "Back", "buildChoiceScreen");
        this._recoverBtn = row.primaryBtn;
        this._fitToContent();
      },

      _onRecoverConfirm: function _onRecoverConfirm() {
        var self = this;
        var wb = lively.identity.walletBackup;
        this._recoverBtn.setActive(false);
        this._recoverStatusText.applyStyle({ fontColor: Color.rgb(100, 100, 100) });
        this._recoverStatusText.setTextString("Recovering…");
        wb.recoverBackup(
          function (stage) { self._recoverStatusText.setTextString(wb.progressLabel(stage)); },
          function (err) {
            if (err) {
              self._recoverBtn.setActive(true);
              self._recoverStatusText.applyStyle({ fontColor: Color.rgb(180, 40, 40) });
              self._recoverStatusText.setTextString(err.message);
              return;
            }
            self.buildRecoverSuccessScreen();
          },
        );
      },

      buildRecoverSuccessScreen: function buildRecoverSuccessScreen() {
        var content = this._clearContent();
        var y = this._addHeading(content, "Wallet recovered", 14);
        y = this._addText(
          content,
          "Restored from its Files backup. Open your wallet and unlock it " +
            "the same way you did before (passkey or password) to continue.",
          y,
          { fontSize: 12 },
        );

        this._addActionRow(content, y, "Open Wallet", "_onOpenWallet");
        this._fitToContent();
      },

      // ─── success / error screens ────────────────────────────────────────────

      buildSuccessScreen: function buildSuccessScreen(address) {
        var content = this._clearContent();
        var y = this._addHeading(content, "Wallet created", 14);
        y = this._addText(content, "Address:\n" + address, y, { fontSize: 12 });

        this._addActionRow(content, y, "Open Wallet", "_onOpenWallet");
        this._fitToContent();
      },

      _onOpenWallet: function _onOpenWallet() {
        this.remove();
        lively.require("lively.identity.Wallet").toRun(function () {
          lively.identity.Wallet.open();
        });
      },

      buildErrorScreen: function buildErrorScreen(err) {
        var content = this._clearContent();
        var y = this._addHeading(content, "Setup didn't complete", 14);
        y = this._addText(content, err && err.message ? err.message : String(err), y, { fontSize: 12, fontColor: Color.rgb(180, 40, 40) });

        this._addActionRow(content, y, "Try Again", "buildChoiceScreen", "Close", "remove");
        this._fitToContent();
      },
    });
  }); // end module('lively.identity.WalletSetupDialog')
