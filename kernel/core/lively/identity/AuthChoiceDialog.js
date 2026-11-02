/**
 * lively.identity.AuthChoiceDialog
 *
 * Floating choice panel opened from welcome.html's login doit.
 * Lets the user pick between signing in with an existing passkey
 * or creating a new identity.
 */

module("lively.identity.AuthChoiceDialog")
  .requires(
    "lively.persistence.BuildSpec",
    "lively.morphic.Complete",
  )
  .toRun(function () {
    lively.BuildSpec("lively.identity.AuthChoiceDialog", {
      _BorderRadius: 7,
      _Extent: lively.pt(320, 120),
      _Fill: Color.rgb(255, 16, 144),
      className: "lively.morphic.Window",
      contentOffset: lively.pt(3, 22),
      draggingEnabled: true,
      droppingEnabled: false,
      layout: { adjustForNewBounds: true },
      name: "AuthChoiceDialog",
      titleBar: "Start",
      submorphs: [
        {
          _Extent: lively.pt(314, 92),
          _Fill: Color.rgb(250, 250, 250),
          _Position: lively.pt(3, 22),
          className: "lively.morphic.Box",
          layout: {
            adjustForNewBounds: true,
            resizeHeight: true,
            resizeWidth: true,
          },
          name: "authChoiceContent",
          submorphs: [],
        },
      ],

      onFromBuildSpecCreated: function onFromBuildSpecCreated() {
        // Window's own onFromBuildSpecCreated (BuildSpecMorphExtensions.js)
        // is what actually builds the title bar from the titleBar: BuildSpec
        // property above -- skipping $super() renders with no title bar at
        // all (confirmed gotcha, see WalletSetupDialog.js's identical note).
        $super();
        this._ensureAccentChromeCss();
        this.addStyleClassName("identity-accent-chrome");
        this.buildUI();
      },

      // The base theme's default title-text color (#555) doesn't have
      // enough contrast against this dialog's saturated pink _Fill (which
      // already shows through as the title bar's own background for free,
      // since `.Window .TitleBar` is transparent by design) -- scoped to a
      // small shared class so it never affects any other window. Same
      // technique as DMChat.js's applyAccentChrome/_ensureAccentChromeCss.
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

      buildUI: function buildUI() {
        var self = this;
        var content = this.get("authChoiceContent");
        if (!content) return;
        content.removeAllMorphs();

        var pad = 16;
        var w = content.getExtent().x;

        var label = new lively.morphic.Text(
          lively.rect(pad, 16, w - pad * 2, 20),
          "How would you like to continue?"
        );
        label.applyStyle({
          allowInput: false,
          fontFamily: "Arial, sans-serif",
          fontSize: 13,
          textColor: Color.rgb(40, 40, 40),
          fill: null,
          borderWidth: 0,
          borderColor: null,
        });
        label.draggingEnabled = false;
        label.droppingEnabled = false;
        label.grabbingEnabled = false;
        label.eventsAreIgnored = true;
        content.addMorph(label);

        function paintButton(btn, borderColor, borderWidth, borderRadius) {
          // applyStyle alone silently fails to reach the DOM for buttons
          // created procedurally (new Button(...) + addMorph) rather than
          // declared as static BuildSpec submorphs — write the real CSS
          // directly as well, verified via getComputedStyle. Deferred one
          // tick because a layout pass still in flight right after
          // construction otherwise regenerates the shapeNode and discards
          // a same-tick direct-DOM write.
          btn.applyStyle({ borderColor: borderColor, borderWidth: borderWidth, borderRadius: borderRadius });
          (function () {
            var node = btn.renderContext && btn.renderContext().shapeNode;
            if (node) {
              node.style.borderColor = borderColor;
              node.style.borderWidth = borderWidth + "px";
              node.style.borderRadius = borderRadius + "px";
            }
          }).delay(0);
        }

        var signInBtn = new lively.morphic.Button(
          lively.rect(pad, 50, 125, 28),
          "Sign in"
        );
        content.addMorph(signInBtn);
        paintButton(signInBtn, "rgb(214,214,214)", 1, 5);
        lively.bindings.connect(signInBtn, "fire", self, "openSignIn");

        var newBtn = new lively.morphic.Button(
          lively.rect(pad + 133, 50, 154, 28),
          "Create new passkey"
        );
        content.addMorph(newBtn);
        paintButton(newBtn, "rgb(214,214,214)", 1, 5);
        lively.bindings.connect(newBtn, "fire", self, "openRegister");
      },

      openSignIn: function openSignIn() {
        this.remove();
        lively.require("lively.identity.LoginDialog").toRun(function () {
          lively.BuildSpec("lively.identity.LoginDialog").createMorph().openInWorldCenter();
        });
      },

      openRegister: function openRegister() {
        this.remove();
        lively.require("lively.identity.RegisterDialog").toRun(function () {
          lively.BuildSpec("lively.identity.RegisterDialog").createMorph().openInWorldCenter();
        });
      },
    });
  }); // end module('lively.identity.AuthChoiceDialog')
