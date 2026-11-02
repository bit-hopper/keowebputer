/**
 * lively.identity.PasskeyPrimingDialog
 *
 * Small "heads up" dialog shown right before a WebAuthn ceremony
 * (navigator.credentials.get/create) fires, so the native OS passkey
 * prompt doesn't appear out of nowhere. Also gives WebAuthn a moment to
 * finish loading/warming up (isPlatformAuthenticatorAvailable) while the
 * user reads the message, instead of that cost landing on the ceremony
 * itself.
 *
 * Usage — callers never build the morph directly, they go through the
 * static gate:
 *
 *   lively.identity.PasskeyPrimingDialog.maybeShow(function () {
 *     // fire the actual navigator.credentials.get/create call here —
 *     // this runs either immediately (if the user previously checked
 *     // "don't ask again") or from the dialog's own Continue button
 *     // click, which is itself a fresh user gesture.
 *   });
 *
 * "Don't ask me again on this device" is a plain lively.LocalStorage flag
 * (SKIP_FLAG_KEY below) — a per-browser preference, not a server setting.
 *
 * Dependencies:
 *   lively.identity.WebAuthn — isAvailable/isPlatformAuthenticatorAvailable
 *     (pre-warm only; this dialog never itself calls navigator.credentials)
 */

module("lively.identity.PasskeyPrimingDialog")
  .requires(
    "lively.identity.WebAuthn",
    "lively.persistence.BuildSpec",
    "lively.morphic.Complete",
  )
  .toRun(function () {
    lively.BuildSpec("lively.identity.PasskeyPrimingDialog", {
      _BorderRadius: 7,
      _Extent: lively.pt(380, 210),
      _Fill: Color.rgb(255, 16, 144),
      className: "lively.morphic.Window",
      contentOffset: lively.pt(3, 22),
      draggingEnabled: true,
      droppingEnabled: false,
      layout: { adjustForNewBounds: true },
      name: "PasskeyPrimingDialog",
      titleBar: "Passkey needed",
      submorphs: [
        {
          _Extent: lively.pt(374, 182),
          _Fill: Color.rgb(250, 250, 250),
          _Position: lively.pt(3, 22),
          className: "lively.morphic.Box",
          layout: {
            adjustForNewBounds: true,
            resizeWidth: true,
          },
          name: "primingContent",
          submorphs: [],
        },
      ],

      // ─── lifecycle ──────────────────────────────────────────────────────────────

      onFromBuildSpecCreated: function onFromBuildSpecCreated() {
        // Window's own onFromBuildSpecCreated (BuildSpecMorphExtensions.js)
        // is what actually builds the title bar from the titleBar: BuildSpec
        // property above -- skipping $super() renders with no title bar at
        // all (confirmed gotcha, see WalletSetupDialog.js's identical note).
        $super();
        this._ensureAccentChromeCss();
        this.addStyleClassName("identity-accent-chrome");
        // Form is built later, by the static show() helper below, once this
        // window is actually in the world -- the message text's height is
        // measured via getTextExtent() right after insertion, which needs a
        // real render context (see the module-doc CLAUDE.md note on this).
      },

      // Same shared accent-chrome class LoginDialog/RegisterDialog/
      // AuthChoiceDialog use -- scoped by style ID, so re-running this is a
      // no-op if one of those already added the stylesheet.
      _ensureAccentChromeCss: function () {
        var STYLE_ID = "identity-accent-chrome-style";
        if (document.getElementById(STYLE_ID)) return;
        var styleEl = document.createElement("style");
        styleEl.id = STYLE_ID;
        styleEl.textContent = [
          ".Window.identity-accent-chrome .Text.window-title { color: #fff; }",
          ".Window.identity-accent-chrome.highlighted .Text.window-title { color: #fff; font-weight: bold; }",
        ].join("\n");
        document.head.appendChild(styleEl);
      },

      // ─── form construction ──────────────────────────────────────────────────────

      buildForm: function buildForm() {
        var self = this;
        var content = this.get("primingContent");
        if (!content) return;
        content.removeAllMorphs();

        var pad = 14;
        var y = pad;
        var w = content.getExtent().x - pad * 2;

        // ── icon + message ──────────────────────────────────────────────────
        var icon = new lively.morphic.Text(lively.rect(pad, y, 30, 30), "passkey");
        icon.name = "passkeyIcon";
        icon.applyStyle({
          allowInput: false,
          fontFamily: "'Material Symbols Rounded'",
          fontSize: 22,
          textColor: Color.rgb(255, 16, 144),
          fill: null,
          borderWidth: 0,
          borderColor: null,
        });
        this._noDrag(icon);
        content.addMorph(icon);

        var msgX = pad + 38;
        var msgW = w - 38;
        var msg = new lively.morphic.Text(
          lively.rect(msgX, y, msgW, 60),
          this._message || lively.identity.PasskeyPrimingDialog.DEFAULT_MESSAGE,
        );
        msg.name = "message";
        msg.applyStyle({
          allowInput: false,
          fontFamily: "Arial, sans-serif",
          fontSize: 12,
          textColor: Color.rgb(60, 60, 60),
          padding: lively.rect(4, 3, 0, 0),
          fill: null,
          borderWidth: 0,
          borderColor: null,
          wordBreak: "break-word",
        });
        content.addMorph(msg);
        // Measure the real wrapped height now that it's in the world (a
        // guessed lineCount*N undershoots -- see CLAUDE.md), then correct.
        var msgH = Math.max(36, msg.getTextExtent().y + 6);
        msg.setExtent(lively.pt(msgW, msgH));

        y += Math.max(30, msgH) + 14;

        // ── "don't ask again" toggle ────────────────────────────────────────
        var checkIcon = new lively.morphic.Text(
          lively.rect(pad, y, 18, 18),
          this._dontAskAgain ? "check_box" : "check_box_outline_blank",
        );
        checkIcon.name = "dontAskCheckboxIcon";
        checkIcon.applyStyle({
          allowInput: false,
          fontFamily: "'Material Symbols Rounded'",
          fontSize: 13.5,
          textColor: Color.rgb(120, 120, 120),
          fill: null,
          borderWidth: 0,
          borderColor: null,
        });
        this._noDrag(checkIcon);
        checkIcon._dialog = self;
        checkIcon.addScript(function onMouseUp(evt) {
          this._dialog.onToggleDontAskAgain();
          evt.stop();
          return true;
        });
        content.addMorph(checkIcon);

        var checkLabel = new lively.morphic.Text(
          lively.rect(pad + 22, y + 1, w - 22, 16),
          "Don't ask me again on this device",
        );
        checkLabel.name = "dontAskLabel";
        checkLabel.applyStyle({
          allowInput: false,
          fontFamily: "Arial, sans-serif",
          fontSize: 11,
          textColor: Color.rgb(120, 120, 120),
          fill: null,
          borderWidth: 0,
          borderColor: null,
        });
        this._noDrag(checkLabel);
        checkLabel._dialog = self;
        checkLabel.addScript(function onMouseUp(evt) {
          this._dialog.onToggleDontAskAgain();
          evt.stop();
          return true;
        });
        content.addMorph(checkLabel);

        y += 30;

        // ── buttons ──────────────────────────────────────────────────────────
        function paintButton(btn, borderColor, borderWidth, borderRadius, fill) {
          // applyStyle alone silently fails to reach the DOM for buttons
          // created procedurally -- write the real CSS directly too,
          // deferred one tick past the in-flight resizeWidth layout pass
          // (see LoginDialog.js's identical paintButton for the full note).
          btn.applyStyle({
            borderColor: borderColor,
            borderWidth: borderWidth,
            borderRadius: borderRadius,
            fill: fill,
          });
          (function () {
            var node = btn.renderContext && btn.renderContext().shapeNode;
            if (node) {
              node.style.borderColor = borderColor;
              node.style.borderWidth = borderWidth + "px";
              node.style.borderRadius = borderRadius + "px";
              node.style.background = fill || "";
            }
          }).delay(0);
        }

        var continueBtn = new lively.morphic.Button(
          lively.rect(pad + w - 100, y, 100, 26),
          "Continue",
        );
        continueBtn.name = "continueBtn";
        content.addMorph(continueBtn);
        paintButton(continueBtn, "rgb(240,190,210)", 1.184, 5.2, "rgb(255,240,247)");
        lively.bindings.connect(continueBtn, "fire", self, "onContinueClicked");

        var cancelBtn = new lively.morphic.Button(
          lively.rect(pad, y, 90, 26),
          "Not now",
        );
        cancelBtn.name = "cancelBtn";
        content.addMorph(cancelBtn);
        paintButton(cancelBtn, "rgb(214,214,214)", 1, 5, null);
        lively.bindings.connect(cancelBtn, "fire", self, "onCancelClicked");

        y += 26 + pad;

        // ── resize window/content to fit the real content height ───────────
        content.setExtent(lively.pt(content.getExtent().x, y));
        this.setExtent(lively.pt(this.getExtent().x, y + 22 + 3));

        // Pre-warm the platform-authenticator check while the dialog is
        // visible, so that cost lands here instead of on the ceremony the
        // user is about to trigger. Result isn't otherwise surfaced by this
        // dialog -- the ceremony call itself already reports a real failure
        // if the device turns out not to support it.
        var webAuthn = lively.identity.webAuthn;
        if (webAuthn && webAuthn.isAvailable()) {
          webAuthn.isPlatformAuthenticatorAvailable(function () {});
        }
      },

      _noDrag: function _noDrag(m) {
        m.draggingEnabled = false;
        m.droppingEnabled = false;
        m.grabbingEnabled = false;
      },

      // ─── actions ────────────────────────────────────────────────────────────────

      onToggleDontAskAgain: function onToggleDontAskAgain() {
        this._dontAskAgain = !this._dontAskAgain;
        var icon = this.get("dontAskCheckboxIcon");
        if (icon) icon.setTextString(this._dontAskAgain ? "check_box" : "check_box_outline_blank");
        lively.LocalStorage.set(
          lively.identity.PasskeyPrimingDialog.SKIP_FLAG_KEY,
          this._dontAskAgain,
        );
      },

      onContinueClicked: function onContinueClicked() {
        var cb = this._onContinue;
        this.remove();
        if (cb) cb();
      },

      onCancelClicked: function onCancelClicked() {
        var cb = this._onCancel;
        this.remove();
        if (cb) cb();
      },
    });

    // ─── static gate -- what callers actually use ────────────────────────────────
    //
    // Attached to the lively.identity.PasskeyPrimingDialog namespace object
    // (created by module(...) above), which is a separate plain object from
    // the string-keyed lively.BuildSpec registry entry created above -- see
    // lively.persistence.BuildSpec's Registry, this assignment doesn't
    // overwrite it. Unlike the BuildSpec's own spec-level methods above,
    // these are ordinary closures (never reconstructed from source text at
    // runtime), so they may freely reference each other and outer scope.

    Object.extend(lively.identity.PasskeyPrimingDialog, {
      SKIP_FLAG_KEY: "identity-skip-passkey-priming",
      DEFAULT_MESSAGE:
        "You will be asked to confirm this action with your passkey — fingerprint, " +
        "face, security key, or device PIN.",

      // Shows the dialog unless the user previously checked "don't ask again"
      // on this device, in which case onContinue fires immediately/synchronously.
      // Callers must trigger the actual navigator.credentials.get/create call
      // from inside onContinue -- when the dialog IS shown, its own Continue
      // button click is what supplies the fresh user gesture the ceremony
      // needs; don't defer past that click with another async hop first.
      maybeShow: function (onContinue, onCancel, message) {
        if (lively.LocalStorage.get(lively.identity.PasskeyPrimingDialog.SKIP_FLAG_KEY) === true) {
          return onContinue();
        }
        return lively.identity.PasskeyPrimingDialog.show(onContinue, onCancel, message);
      },

      // Unconditional -- shows the dialog even if "don't ask again" was set.
      show: function (onContinue, onCancel, message) {
        var dlg = lively.BuildSpec("lively.identity.PasskeyPrimingDialog").createMorph();
        dlg._onContinue = onContinue;
        dlg._onCancel = onCancel;
        dlg._message = message;
        dlg.openInWorldCenter();
        dlg.buildForm();
        return dlg;
      },
    });
  }); // end module('lively.identity.PasskeyPrimingDialog')
