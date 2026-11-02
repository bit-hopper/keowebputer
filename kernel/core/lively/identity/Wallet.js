/**
 * lively.identity.Wallet
 *
 * WalletSpec.md §9, §15 step 4: the wallet dashboard. `lively.morphic.Box`
 * with hand-drawn chrome, matching FilesBrowser.js's own shape exactly
 * (title bar / toolbar / scrollable content div, all raw DOM — not
 * BuildSpec, since that's what FilesBrowser.js actually is). No
 * secret-touching code here at all — everything routes through
 * lively.identity.walletBridge.
 *
 * Balance/Public tab content (§9.2: address, balance, send/receive) plus
 * deposit (step 7), withdrawal (step 8), ragequit/Exit (step 9), and the
 * optional Files backup (step 10) flows, all on the one dashboard screen —
 * the rest of Settings (unlock-method management, reveal recovery phrase,
 * RPC endpoint display) is still a later step's work, and the Shielded
 * content hasn't been split into its own actual tab yet (no tab affordance
 * is built at all since deposit/withdraw/exit/backup are just buttons off
 * the one screen for now — see each flow's own section below).
 *
 * "Send" builds and signs a transaction (§6.6's simulate-then-sign
 * pattern, via lively.identity.privacyPoolClient) and displays the result
 * as a read-only signed raw tx — it never broadcasts anything. See
 * PrivacyPoolClient.js's own header for why that's a hard absence, not a
 * UI-level restriction.
 *
 * "Deposit into pool" (§9.3, §15 step 7), "Withdraw from pool" (§9.4,
 * §15 step 8), and each spendable deposit's "Exit" action (§9.5, §15
 * step 9) are the flows in this dashboard that can actually broadcast —
 * all follow the same shape: build -> Review/Confirm -> Sign -> (real,
 * user-triggered) Broadcast -> Processing -> Success. Everything up
 * through Sign only builds/signs; broadcasting is a separate, explicit
 * button click, never automatic. Withdrawal and Exit additionally have a
 * real Generating-proof screen with phase-by-phase progress (§5.6) between
 * Confirm and Sign, since proveWithdrawal/proveCommitment are genuinely
 * slow.
 *
 * No QR code — confirmed no QR library exists anywhere in this codebase
 * (checked while planning this file); deferred rather than adding a new
 * dependency for it. Copy-to-clipboard reuses PostCardView.js's own
 * pattern (navigator.clipboard.writeText with an execCommand('copy')
 * fallback).
 *
 * Entry point: lively.identity.Wallet.open() — decides no-wallet-yet
 * (routes to WalletSetupDialog) vs locked (inline unlock form) vs
 * unlocked (this dashboard) per §9.1.
 */

module('lively.identity.Wallet')
  .requires(
    'lively.identity.WalletBridge',
    'lively.identity.PrivacyPoolClient',
    'lively.identity.WalletSetupDialog',
    'lively.identity.WalletBackup',
  )
  .toRun(function () {

    var WalletClass = lively.morphic.Box.subclass('lively.identity.Wallet',

    'serialization', {
      doNotSerialize: ['_contentDiv', '_toolbarDiv', '_tabbarDiv'],
    },

    'initialization', {

      initialize: function ($super, bounds) {
        $super(bounds);
        this._contentDiv = null;
        this._toolbarDiv = null;
        this._tabbarDiv = null;
        this._activeTab = 'wallet';
        this._network = this._loadStoredNetwork();
        this._buildChrome();
        this._refresh();
      },

      // Persisted across sessions the same way PrivacyPoolClient's own
      // per-device bookkeeping is (plain localStorage, no server round
      // trip) — this is just a UI preference, not wallet state.
      _NETWORK_STORAGE_KEY: 'lively.wallet.selectedNetwork',

      _loadStoredNetwork: function () {
        try {
          var stored = window.localStorage.getItem(this._NETWORK_STORAGE_KEY);
          if (stored && lively.identity.privacyPoolClient.getNetworks()[stored]) return stored;
        } catch (e) {}
        return 'mainnet';
      },

      _setNetwork: function (network) {
        if (!lively.identity.privacyPoolClient.getNetworks()[network]) return;
        this._network = network;
        try { window.localStorage.setItem(this._NETWORK_STORAGE_KEY, network); } catch (e) {}
        this._refresh();
      },

      // Scoped base styling for the raw <button>/<input> elements this
      // dashboard creates throughout (deposit/withdraw/exit/send flows,
      // unlock form, etc.) — dozens of individual createElement call sites,
      // almost none of which style themselves beyond the browser default.
      // One shared stylesheet, scoped to this dashboard's own shapeNode via
      // a class (never a bare `button {...}` — that would leak into the
      // rest of the app), gives every current and future one of them the
      // same baseline polish (radii/colors/spacing) established for morph
      // dialogs elsewhere, without editing every call site individually.
      _ensureBaseStyles: function () {
        var STYLE_ID = 'lively-wallet-dashboard-styles';
        var FONT_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
        var existing = document.getElementById(STYLE_ID);
        if (existing) { existing.remove(); }
        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = [
          '.lively-wallet-dashboard { font-family: ' + FONT_STACK + '; background: #F6F6FB; }',

          // toolbar / tab bar
          '.lively-wallet-dashboard .lw-toolbar { display:flex; align-items:center; gap:6px; }',
          '.lively-wallet-dashboard .lw-icon-btn {',
          '  display:flex; align-items:center; justify-content:center; width:26px; height:26px;',
          '  border-radius:8px; border:1px solid transparent !important; background:transparent !important;',
          '  color:#6C4CE0; cursor:pointer; padding:0 !important;',
          '}',
          '.lively-wallet-dashboard .lw-icon-btn:hover { background:#EDE9FB !important; }',
          '.lively-wallet-dashboard .lw-icon-btn .material-symbols-rounded { font-size:15px; }',
          '.lively-wallet-dashboard .lw-tabbar {',
          '  display:flex; gap:20px; padding:0 16px; background:#fff;',
          '  border-bottom:1px solid #E4E4EE; height:33px; align-items:flex-end;',
          '}',
          '.lively-wallet-dashboard .lw-tab {',
          '  padding-bottom:9px; font-size:12.5px; font-weight:600; color:#9a9aa2;',
          '  cursor:pointer; border-bottom:2px solid transparent; user-select:none;',
          '}',
          '.lively-wallet-dashboard .lw-tab.active { color:#6C4CE0; border-bottom-color:#6C4CE0; }',
          '.lively-wallet-dashboard .lw-tab:hover:not(.active) { color:#57575c; }',

          // cards + typography — border is a faint tint of the window
          // frame's own indigo (#6C4CE0) rather than plain gray, so cards
          // read as belonging to this wallet rather than generic chrome.
          '.lively-wallet-dashboard .lw-card {',
          '  background:#fff; border:1px solid #DCD3F7; border-radius:12px;',
          '  padding:16px; margin-bottom:14px; box-shadow:0 1px 2px rgba(108,76,224,0.06);',
          '}',
          '.lively-wallet-dashboard .lw-heading { font-weight:600; font-size:13px; color:#1c1c1e; margin-bottom:10px; }',
          '.lively-wallet-dashboard .lw-label {',
          '  color:#9a9aa2; font-size:10.5px; margin-bottom:4px; text-transform:uppercase; letter-spacing:0.04em; font-weight:600;',
          '}',
          '.lively-wallet-dashboard .lw-value { font-size:14px; color:#1c1c1e; }',
          '.lively-wallet-dashboard .lw-hint { color:#8e8e93; font-size:11.5px; line-height:1.5; }',
          '.lively-wallet-dashboard .lw-error {',
          '  color:#b00020; background:#FDEEF0; border:1px solid #F5C6CE; border-radius:8px;',
          '  padding:8px 10px; font-size:12px; margin:8px 0;',
          '}',
          '.lively-wallet-dashboard .lw-warning {',
          '  color:#8a5a00; background:#FFF6E8; border:1px solid #F5DFA8; border-radius:8px;',
          '  padding:10px 12px; font-size:12px; margin-bottom:12px;',
          '}',
          '.lively-wallet-dashboard .lw-warning.danger {',
          '  color:#b00020; background:#FDEEF0; border-color:#F5C6CE; font-weight:600;',
          '}',
          '.lively-wallet-dashboard .lw-danger-text { color:#b00020; font-size:12px; margin-bottom:12px; }',
          '.lively-wallet-dashboard .lw-success { color:#1f8a3d; font-weight:600; font-size:13px; margin-bottom:12px; }',

          // pills / badges — green for Mainnet (the "real, live" network),
          // yellow for Sepolia (the "test" network), a common convention
          // for network status indicators.
          '.lively-wallet-dashboard .lw-pill {',
          '  display:inline-flex; align-items:center; gap:5px; font-size:10.5px; font-weight:700;',
          '  padding:3px 10px; border-radius:20px; background:#E3F8E9; color:#1f8a3d; vertical-align:middle;',
          '}',
          '.lively-wallet-dashboard .lw-pill.sepolia { background:#FFF6D6; color:#9a7b00; }',
          '.lively-wallet-dashboard .lw-pill-dot { width:6px; height:6px; border-radius:50%; background:currentColor; }',

          // balance
          '.lively-wallet-dashboard .lw-balance-row { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }',
          '.lively-wallet-dashboard .lw-balance { font-size:27px; font-weight:700; color:#1c1c1e; letter-spacing:-0.02em; }',

          // segmented control (network switcher)
          '.lively-wallet-dashboard .lw-segmented { display:inline-flex; background:#F0F0F5; border-radius:9px; padding:3px; gap:2px; }',
          '.lively-wallet-dashboard .lw-segmented button {',
          '  border:1px solid transparent !important; background:transparent !important; padding:6px 16px !important;',
          '  border-radius:7px !important; font-size:12px !important; font-weight:600; color:#6e6e73;',
          '}',
          '.lively-wallet-dashboard .lw-segmented button:hover { background:transparent !important; }',
          '.lively-wallet-dashboard .lw-segmented button.active {',
          '  background:#fff !important; color:#1c1c1e; box-shadow:0 1px 3px rgba(0,0,0,0.14);',
          '}',

          // buttons / inputs
          '.lively-wallet-dashboard button {',
          '  font-family: inherit; font-size: 12px; padding: 8px 16px;',
          '  cursor: pointer; border: 1px solid #E4E4EE; border-radius: 8px;',
          '  background: #fff; color: #1c1c1e; transition: background .12s ease;',
          '}',
          '.lively-wallet-dashboard button:hover { background: #F6F6FB; }',
          '.lively-wallet-dashboard button:disabled { opacity: 0.45; cursor: default; }',
          '.lively-wallet-dashboard button.primary { background: #6C4CE0; border-color: #6C4CE0; color: #fff; font-weight:600; }',
          '.lively-wallet-dashboard button.primary:hover { background: #5b3ed1; }',
          '.lively-wallet-dashboard button.danger { color:#b00020; border-color:#f0c4cc; }',
          '.lively-wallet-dashboard button.danger:hover { background:#FFF3F5; }',
          '.lively-wallet-dashboard input[type=text],',
          '.lively-wallet-dashboard input[type=password],',
          '.lively-wallet-dashboard input[type=number] {',
          '  font-family: inherit; font-size: 13px; padding: 8px 10px;',
          '  border: 1px solid #E4E4EE; border-radius: 8px; box-sizing: border-box; background:#fbfbfd;',
          '}',
          '.lively-wallet-dashboard input:focus { outline:none; border-color:#6C4CE0; background:#fff; }',

          // Single-card wrapper for the step-by-step deposit/withdraw/exit
          // screens (Amount -> Review -> Sign -> ... -> Success/Error) —
          // toggled on _contentDiv itself via _setContentMode('flow')
          // rather than wrapping every individual screen's markup in its
          // own card element. The dashboard/settings tabs stay in 'flat'
          // mode (transparent, multiple independent .lw-card children).
          '.lively-wallet-dashboard .lw-content-flow {',
          '  left:16px !important; right:16px !important; bottom:16px !important;',
          '  background:#fff !important; border:1px solid #DCD3F7; border-radius:12px;',
          '  box-shadow:0 1px 2px rgba(108,76,224,0.06); padding:20px !important;',
          '}',

          '.lively-wallet-dashboard .lw-divider { height:1px; background:#ECECF3; margin:14px 0; border:none; }',
          '.lively-wallet-dashboard .lw-mono { font-family: SFMono-Regular, Consolas, monospace; }',

          // Scrollbar on the content area — the browser default (chunky,
          // square, light gray) clashes with everything else here; a thin
          // rounded thumb that only tints on hover reads as part of the
          // same design system instead of bolted on. Webkit-only (Blink/
          // Safari, i.e. everywhere this Electron-ish embedded Chrome
          // renders); `scrollbar-width: thin` covers Firefox as a fallback.
          '.lively-wallet-dashboard .lw-scroll { scrollbar-width: thin; scrollbar-color: #D3D3E0 transparent; }',
          '.lively-wallet-dashboard .lw-scroll::-webkit-scrollbar { width: 9px; height: 9px; }',
          '.lively-wallet-dashboard .lw-scroll::-webkit-scrollbar-track { background: transparent; }',
          '.lively-wallet-dashboard .lw-scroll::-webkit-scrollbar-thumb {',
          '  background-color: #D3D3E0; border-radius: 5px; border: 2px solid transparent; background-clip: padding-box;',
          '}',
          '.lively-wallet-dashboard .lw-scroll::-webkit-scrollbar-thumb:hover { background-color: #B7B7CE; }',
        ].join('\n');
        document.head.appendChild(style);
      },

      // Chrome (title bar, close button) is now the real classic
      // lively.morphic.Window this morph is framed in via openInWindow()
      // below — see FilesBrowser.js/PostCardMailbox.js's identical
      // precedent — so this only builds the toolbar / content area, not a
      // hand-rolled title bar.
      _buildChrome: function () {
        this._ensureBaseStyles();
        this.setFill(Color.white);
        this.setDroppingEnabled(false);
        var shapeNode = this.renderContext().shapeNode;
        shapeNode.classList.add('lively-wallet-dashboard');

        var toolbarDiv = document.createElement('div');
        toolbarDiv.className = 'lw-toolbar';
        toolbarDiv.style.cssText = [
          'position:absolute', 'top:0', 'left:0', 'right:0', 'height:34px',
          'background:#fff', 'border-bottom:1px solid #E4E4EE',
          'padding:0 12px', 'box-sizing:border-box',
        ].join(';');
        shapeNode.appendChild(toolbarDiv);
        this._toolbarDiv = toolbarDiv;

        var tabbarDiv = document.createElement('div');
        tabbarDiv.className = 'lw-tabbar';
        tabbarDiv.style.cssText = 'position:absolute;top:34px;left:0;right:0;';
        shapeNode.appendChild(tabbarDiv);
        this._tabbarDiv = tabbarDiv;

        var contentDiv = document.createElement('div');
        contentDiv.className = 'lw-scroll';
        contentDiv.style.cssText = [
          'position:absolute', 'top:67px', 'left:0', 'right:0', 'bottom:0',
          'overflow-y:auto', 'padding:16px', 'box-sizing:border-box', 'font-size:13px',
        ].join(';');
        shapeNode.appendChild(contentDiv);
        this._contentDiv = contentDiv;

        this._renderToolbar();
        this._renderTabs();
      },

      _renderToolbar: function () {
        var self = this;
        var bar = this._toolbarDiv;
        bar.innerHTML = '';

        var title = document.createElement('span');
        title.textContent = 'Wallet';
        title.style.cssText = 'flex:1;color:#1c1c1e;font-weight:700;font-size:12.5px;';
        bar.appendChild(title);

        var refreshBtn = this._makeIconBtn('refresh', 'Refresh');
        refreshBtn.addEventListener('click', function () { self._refresh(); });
        bar.appendChild(refreshBtn);

        var lockBtn = this._makeIconBtn('lock', 'Lock wallet');
        lockBtn.addEventListener('click', function () {
          lively.identity.walletBridge.lock(function () { self._refresh(); });
        });
        bar.appendChild(lockBtn);
      },

      _makeIconBtn: function (iconName, title) {
        var btn = document.createElement('button');
        btn.className = 'lw-icon-btn';
        btn.title = title;
        var icon = document.createElement('span');
        icon.className = 'material-symbols-rounded';
        icon.textContent = iconName;
        btn.appendChild(icon);
        return btn;
      },

      // Small pill-style icon+label button used for inline actions (Copy,
      // etc.) inside content cards — distinct from the toolbar's bare
      // icon-only buttons and from the primary/secondary action buttons.
      _makeSmallBtn: function (iconName, label) {
        var btn = document.createElement('button');
        btn.style.cssText = 'display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:5px 10px;white-space:nowrap;';
        if (iconName) {
          var icon = document.createElement('span');
          icon.className = 'material-symbols-rounded';
          icon.style.fontSize = '13px';
          icon.textContent = iconName;
          btn.appendChild(icon);
        }
        var text = document.createElement('span');
        text.textContent = label;
        btn.appendChild(text);
        return btn;
      },

      // Hidden while locked (nothing to switch between yet — the unlock
      // form is the only screen); shown once unlocked.
      _renderTabs: function () {
        var self = this;
        var bar = this._tabbarDiv;
        bar.innerHTML = '';

        [['wallet', 'Wallet'], ['settings', 'Settings']].forEach(function (pair) {
          var tab = document.createElement('div');
          tab.className = 'lw-tab' + (self._activeTab === pair[0] ? ' active' : '');
          tab.textContent = pair[1];
          tab.addEventListener('click', function () {
            if (self._activeTab === pair[0]) return;
            self._activeTab = pair[0];
            self._refresh();
          });
          bar.appendChild(tab);
        });
      },

      // 'flat': transparent scroll area, screens build their own
      // independent .lw-card children (dashboard, settings, unlock).
      // 'flow': the scroll area itself becomes one card, for the
      // step-by-step deposit/withdraw/exit screens — see this class's own
      // comment in _ensureBaseStyles for why that's a toggle on the
      // container rather than a wrapper element repeated in every screen.
      _setContentMode: function (mode) {
        if (mode === 'flow') this._contentDiv.classList.add('lw-content-flow');
        else this._contentDiv.classList.remove('lw-content-flow');
      },

    },

    // ─── morph-level event overrides ────────────────────────────────────
    // lively.morphic.Morph's default onKeyDown (Events.js) intercepts
    // Ctrl/Cmd-V globally and redirects it to Lively's own morph-clipboard
    // (KeyboardDispatcher.handleGlobalKeyEvent explicitly exempts Ctrl/Cmd-C
    // and -X from this — "don't capture COPY or CUT" — but NOT -V;
    // createClipboardCapture then steals DOM focus to a hidden 1x1 proxy
    // <input> to read the system clipboard for "paste a morph") rather than
    // letting native browser paste happen. A plain <input> embedded in this
    // dashboard's raw-DOM content never received a real paste event as a
    // result — confirmed bug report: pasting a recipient address into any
    // of this dashboard's inputs silently did nothing. Bypass $super
    // whenever a real text input inside this morph's own content already
    // has DOM focus — same fix shape PostCardEditor.js's own onKeyDown
    // override already establishes for the identical class of bug.

    'morph events', {

      onKeyDown: function ($super, evt) {
        var active = document.activeElement;
        if (active && this._contentDiv && this._contentDiv.contains(active) &&
            (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
          return false;
        }
        return $super(evt);
      },

    },

    'data', {

      // Decides locked vs unlocked by trying getAddress — no separate
      // "isUnlocked" RPC method exists; a locked vault's getAddress simply
      // errors, which is exactly the branch this needs. The tab strip only
      // makes sense once unlocked (there's nothing to switch between on the
      // unlock screen), so it's hidden/shown alongside that decision.
      _refresh: function () {
        var self = this;
        this._contentDiv.innerHTML = '<div style="color:#999;padding:20px 0;">Loading…</div>';
        lively.identity.walletBridge.getAddress(function (err, address) {
          self._setContentMode('flat');
          if (err) {
            self._tabbarDiv.style.display = 'none';
            self._contentDiv.style.top = '34px';
            return self._renderUnlockForm();
          }
          self._tabbarDiv.style.display = '';
          self._contentDiv.style.top = '67px';
          self._renderTabs();
          self._address = address;
          if (self._activeTab === 'settings') return self._renderSettingsTab(address);
          self._renderDashboard(address);
          lively.identity.privacyPoolClient.getBalance(address, self._network, function (err2, balance) {
            if (err2) return self._setBalanceText('(balance unavailable: ' + err2.message + ')');
            self._setBalanceText(balance.eth + ' ETH');
          });
        });
      },

    },

    'rendering', {

      _renderUnlockForm: function () {
        var self = this;
        var content = this._contentDiv;
        content.innerHTML = '';

        var card = document.createElement('div');
        card.className = 'lw-card';
        card.style.cssText += 'max-width:280px;margin:24px auto 0;';
        content.appendChild(card);

        var icon = document.createElement('div');
        icon.style.cssText = 'display:flex;justify-content:center;margin-bottom:10px;';
        icon.innerHTML = '<span class="material-symbols-rounded" style="font-size:26px;color:#6C4CE0;">lock</span>';
        card.appendChild(icon);

        var heading = document.createElement('div');
        heading.textContent = 'Unlock your wallet';
        heading.className = 'lw-heading';
        heading.style.cssText += 'text-align:center;';
        card.appendChild(heading);

        var passwordInput = document.createElement('input');
        passwordInput.type = 'password';
        passwordInput.placeholder = 'Password (if you set one up)';
        passwordInput.style.cssText = 'display:block;width:100%;margin-bottom:10px;';
        card.appendChild(passwordInput);

        var errorMsg = document.createElement('div');
        errorMsg.className = 'lw-error';
        errorMsg.style.display = 'none';
        card.appendChild(errorMsg);

        var unlockPwBtn = document.createElement('button');
        unlockPwBtn.textContent = 'Unlock with password';
        unlockPwBtn.className = 'primary';
        unlockPwBtn.style.cssText = 'display:block;width:100%;margin-bottom:8px;';
        unlockPwBtn.addEventListener('click', function () {
          lively.identity.walletBridge.unlock({ password: passwordInput.value }, function (err) {
            if (err) {
              errorMsg.textContent = err.message;
              errorMsg.style.display = 'block';
              return;
            }
            self._refresh();
          });
        });
        card.appendChild(unlockPwBtn);

        var unlockPasskeyBtn = document.createElement('button');
        unlockPasskeyBtn.textContent = 'Unlock with passkey';
        unlockPasskeyBtn.style.cssText = 'display:block;width:100%;';
        unlockPasskeyBtn.addEventListener('click', function () {
          lively.identity.walletBridge.unlock({}, function (err) {
            if (err) {
              errorMsg.textContent = err.message;
              errorMsg.style.display = 'block';
              return;
            }
            self._refresh();
          });
        });
        card.appendChild(unlockPasskeyBtn);
      },

      _renderDashboard: function (address) {
        var self = this;
        var content = this._contentDiv;
        content.innerHTML = '';
        var netConfig = lively.identity.privacyPoolClient.getNetworks()[this._network];
        var onMainnet = this._network === 'mainnet';

        // ── balance + address card ──
        var balanceCard = document.createElement('div');
        balanceCard.className = 'lw-card';
        content.appendChild(balanceCard);

        var balanceRow = document.createElement('div');
        balanceRow.className = 'lw-balance-row';
        balanceCard.appendChild(balanceRow);

        var balText = document.createElement('div');
        balText.className = 'lw-balance';
        balText.textContent = 'Loading…';
        balanceRow.appendChild(balText);
        this._balanceTextEl = balText;

        var pill = document.createElement('span');
        pill.className = 'lw-pill' + (onMainnet ? '' : ' ' + this._network);
        pill.innerHTML = '<span class="lw-pill-dot"></span>' + netConfig.short;
        balanceRow.appendChild(pill);

        var addrLabel = document.createElement('div');
        addrLabel.className = 'lw-label';
        addrLabel.textContent = 'Address';
        balanceCard.appendChild(addrLabel);

        var addrRow = document.createElement('div');
        addrRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
        balanceCard.appendChild(addrRow);
        var addrText = document.createElement('span');
        addrText.className = 'lw-mono';
        addrText.textContent = address;
        addrText.style.cssText = 'font-size:12px;color:#4c4c52;word-break:break-all;';
        addrRow.appendChild(addrText);
        var copyBtn = this._makeSmallBtn('content_copy', 'Copy');
        copyBtn.addEventListener('click', function () { self._copyToClipboard(address, copyBtn); });
        addrRow.appendChild(copyBtn);

        // ── shielded pool card (§9.3 deposit / §9.4 withdrawal — real
        //    flows, §15 steps 7/8). Mainnet-only: the Privacy Pools
        //    contracts/ASP have no known Sepolia deployment, so these are
        //    disabled (with an explanatory note) whenever a non-mainnet
        //    network is selected in Settings. ──
        var poolCard = document.createElement('div');
        poolCard.className = 'lw-card';
        content.appendChild(poolCard);

        var poolHeading = document.createElement('div');
        poolHeading.className = 'lw-heading';
        poolHeading.textContent = 'Shielded pool';
        poolCard.appendChild(poolHeading);

        if (!onMainnet) {
          var note = document.createElement('div');
          note.className = 'lw-hint';
          note.style.marginBottom = '10px';
          note.textContent =
            'Only available on Ethereum Mainnet — switch networks in Settings to use deposit/withdraw/exit.';
          poolCard.appendChild(note);
        }

        var depositBtn = document.createElement('button');
        depositBtn.textContent = 'Deposit into pool';
        depositBtn.className = 'primary';
        depositBtn.style.cssText = 'margin-right:8px;';
        depositBtn.disabled = !onMainnet;
        depositBtn.addEventListener('click', function () { self._renderDepositAmount(); });
        poolCard.appendChild(depositBtn);

        var withdrawBtn = document.createElement('button');
        withdrawBtn.textContent = 'Withdraw from pool';
        withdrawBtn.className = 'primary';
        withdrawBtn.disabled = !onMainnet;
        withdrawBtn.addEventListener('click', function () { self._renderWithdrawList(); });
        poolCard.appendChild(withdrawBtn);

        // ── send card ──
        var sendCard = document.createElement('div');
        sendCard.className = 'lw-card';
        content.appendChild(sendCard);

        var sendHeading = document.createElement('div');
        sendHeading.className = 'lw-heading';
        sendHeading.textContent = 'Send';
        sendCard.appendChild(sendHeading);

        var sendHint = document.createElement('div');
        sendHint.className = 'lw-hint';
        sendHint.style.marginBottom = '10px';
        sendHint.textContent = 'Builds and signs a real transaction on ' + netConfig.label + ' — does not broadcast it.';
        sendCard.appendChild(sendHint);

        var toInput = document.createElement('input');
        toInput.type = 'text';
        toInput.placeholder = 'Recipient address (0x…)';
        toInput.className = 'lw-mono';
        toInput.style.cssText = 'display:block;width:100%;box-sizing:border-box;margin-bottom:8px;';
        sendCard.appendChild(toInput);

        var amountInput = document.createElement('input');
        amountInput.type = 'text';
        amountInput.placeholder = 'Amount (ETH), e.g. 0.001';
        amountInput.style.cssText = 'display:block;width:100%;max-width:200px;box-sizing:border-box;margin-bottom:10px;';
        sendCard.appendChild(amountInput);

        var signBtn = document.createElement('button');
        signBtn.textContent = 'Sign (test only — not broadcast)';
        sendCard.appendChild(signBtn);

        var sendResult = document.createElement('div');
        sendResult.className = 'lw-mono';
        sendResult.style.cssText = 'margin-top:10px;font-size:11px;word-break:break-all;color:#4c4c52;';
        sendCard.appendChild(sendResult);

        signBtn.addEventListener('click', function () {
          sendResult.textContent = 'Building and signing…';
          signBtn.disabled = true;
          lively.identity.privacyPoolClient.buildAndSignTransfer(
            { to: toInput.value, amountEth: amountInput.value, network: self._network },
            function (err, result) {
              signBtn.disabled = false;
              if (err) {
                sendResult.textContent = 'Error: ' + err.message;
                return;
              }
              sendResult.textContent =
                'Signed (NOT broadcast) — raw tx: ' + result.signedRawTx;
            },
          );
        });
      },

      // ── Files backup (§7.2, §15 step 10) ──
      // Off-the-dashboard buttons for now, same reasoning as deposit/
      // withdraw/exit above — the Settings tab itself (unlock-method
      // management, reveal recovery phrase, RPC endpoint display) is a
      // separate, later step; this only wires up the create/refresh/delete
      // actions §9.2 describes for it. status() is a local, synchronous
      // read (no network call) so this can re-render freely after every
      // action without adding a fetch each time.
      _renderFilesBackupSection: function (content) {
        var heading = document.createElement('div');
        heading.textContent = 'Encrypted Files backup (optional)';
        heading.className = 'lw-heading';
        content.appendChild(heading);

        var statusLine = document.createElement('div');
        statusLine.className = 'lw-hint';
        statusLine.style.marginBottom = '10px';
        content.appendChild(statusLine);

        var errorMsg = document.createElement('div');
        errorMsg.className = 'lw-error';
        errorMsg.style.display = 'none';
        content.appendChild(errorMsg);

        var btnRow = document.createElement('div');
        content.appendChild(btnRow);

        function showError(message) {
          errorMsg.textContent = message;
          errorMsg.style.display = 'block';
        }

        function refresh() {
          lively.identity.walletBackup.status(function (err, status) {
            btnRow.innerHTML = '';

            if (err) {
              statusLine.textContent = '';
              showError(err.message);
              return;
            }
            errorMsg.style.display = 'none';

            if (!status.exists) {
              statusLine.textContent =
                'Not backed up to your private Files. Your recovery phrase on ' +
                'paper is still the real backup either way (§7.3) — this is a ' +
                'cross-device convenience, never the only copy.';

              var createBtn = document.createElement('button');
              createBtn.textContent = 'Back up to Files';
              createBtn.style.cssText = 'margin-right:8px;';
              createBtn.addEventListener('click', function () {
                var wb = lively.identity.walletBackup;
                createBtn.disabled = true;
                createBtn.textContent = 'Backing up…';
                wb.createBackup(
                  function (stage) { createBtn.textContent = wb.progressLabel(stage); },
                  function (err2) {
                    createBtn.disabled = false;
                    createBtn.textContent = 'Back up to Files';
                    if (err2) return showError(err2.message);
                    refresh();
                  }
                );
              });
              btnRow.appendChild(createBtn);
              return;
            }

            statusLine.textContent =
              'Backed up to your private Files — invisible in your Files ' +
              'listing, by design.';

            var refreshBtn = document.createElement('button');
            refreshBtn.textContent = 'Refresh backup';
            refreshBtn.style.cssText = 'margin-right:8px;';
            refreshBtn.addEventListener('click', function () {
              var wb = lively.identity.walletBackup;
              refreshBtn.disabled = true;
              refreshBtn.textContent = 'Refreshing…';
              wb.refreshBackup(
                function (stage) { refreshBtn.textContent = wb.progressLabel(stage); },
                function (err2) {
                  refreshBtn.disabled = false;
                  refreshBtn.textContent = 'Refresh backup';
                  if (err2) return showError(err2.message);
                  refresh();
                }
              );
            });
            btnRow.appendChild(refreshBtn);

            var deleteBtn = document.createElement('button');
            deleteBtn.textContent = 'Delete backup';
            deleteBtn.style.cssText = 'color:#b00020;border-color:#b00020;';
            deleteBtn.addEventListener('click', function () {
              $world.confirm(
                'Delete the Files backup? This overwrites it with inert ' +
                'content so it can no longer be used for recovery from any ' +
                'device — like everything else in this storage, it is not ' +
                'guaranteed erased server-side. Your recovery phrase on ' +
                'paper remains the real backup (§7.3).',
                function (ok) {
                  if (!ok) return;
                  deleteBtn.disabled = true;
                  lively.identity.walletBackup.deleteBackup(function (err2) {
                    deleteBtn.disabled = false;
                    if (err2) return showError(err2.message);
                    refresh();
                  });
                }
              );
            });
            btnRow.appendChild(deleteBtn);
          });
        }

        refresh();
      },

      // ── Settings tab ──
      // Houses wallet-wide settings that aren't part of the everyday
      // balance/send/deposit/withdraw flow: the network switcher (plain
      // wallet only — see PrivacyPoolClient.js's NETWORKS section for why
      // the shielded pool stays mainnet-only regardless of this) and the
      // Files backup section, moved here from the Wallet tab. Unlock-method
      // management / reveal recovery phrase / RPC endpoint display remain a
      // later step's addition to this same tab.
      _renderSettingsTab: function (address) {
        var self = this;
        var content = this._contentDiv;
        content.innerHTML = '';

        var networkCard = document.createElement('div');
        networkCard.className = 'lw-card';
        content.appendChild(networkCard);

        var networkHeading = document.createElement('div');
        networkHeading.className = 'lw-heading';
        networkHeading.textContent = 'Network';
        networkCard.appendChild(networkHeading);

        var networkHint = document.createElement('div');
        networkHint.className = 'lw-hint';
        networkHint.style.marginBottom = '12px';
        networkHint.textContent =
          'Applies to balance and Send only. Deposit/Withdraw/Exit always use Ethereum Mainnet, since the shielded pool has no Sepolia deployment.';
        networkCard.appendChild(networkHint);

        var segmented = document.createElement('div');
        segmented.className = 'lw-segmented';
        networkCard.appendChild(segmented);

        var networks = lively.identity.privacyPoolClient.getNetworks();
        Object.keys(networks).forEach(function (key) {
          var btn = document.createElement('button');
          btn.textContent = networks[key].short;
          btn.className = self._network === key ? 'active' : '';
          btn.addEventListener('click', function () { self._setNetwork(key); });
          segmented.appendChild(btn);
        });

        var backupCard = document.createElement('div');
        backupCard.className = 'lw-card';
        content.appendChild(backupCard);
        this._renderFilesBackupSection(backupCard);
      },

      // ── deposit flow (§9.3, §15 step 7) ──
      // Same single-content-div-swap navigation already used for
      // locked/unlocked/dashboard — Amount -> Review -> Sign -> (real,
      // user-triggered) Broadcast -> Processing -> Success. Everything up
      // through Sign only ever builds and signs; nothing here calls
      // broadcastDeposit except the explicit Broadcast click on the Sign
      // screen — per WalletSpec.md §15 step 7, that's the one action this
      // codebase deliberately never takes automatically or during
      // automated verification.

      _renderDepositAmount: function () {
        var self = this;
        this._setContentMode('flow');
        var content = this._contentDiv;
        content.innerHTML = '';

        var heading = document.createElement('div');
        heading.textContent = 'Deposit into the shielded pool';
        heading.className = 'lw-heading';
        content.appendChild(heading);

        var amountInput = document.createElement('input');
        amountInput.type = 'text';
        amountInput.placeholder = 'Amount (ETH), e.g. 0.01';
        amountInput.style.cssText = 'display:block;width:100%;max-width:200px;box-sizing:border-box;padding:6px 8px;margin-bottom:8px;';
        content.appendChild(amountInput);

        var errorMsg = document.createElement('div');
        errorMsg.className = 'lw-error';
        errorMsg.style.display = 'none';
        content.appendChild(errorMsg);

        var reviewBtn = document.createElement('button');
        reviewBtn.textContent = 'Review';
        reviewBtn.style.cssText = 'margin-right:8px;';
        content.appendChild(reviewBtn);

        var cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', function () { self._refresh(); });
        content.appendChild(cancelBtn);

        reviewBtn.addEventListener('click', function () {
          var amountEth = amountInput.value.trim();
          if (!amountEth || isNaN(Number(amountEth)) || Number(amountEth) <= 0) {
            errorMsg.textContent = 'Enter a valid amount.';
            errorMsg.style.display = 'block';
            return;
          }
          self._renderDepositReview(amountEth);
        });
      },

      _renderDepositReview: function (amountEth) {
        var self = this;
        this._setContentMode('flow');
        var content = this._contentDiv;
        content.innerHTML = '<div style="color:#999;padding:20px 0;">Loading pool config…</div>';

        var client = lively.identity.privacyPoolClient;
        client.parseEthAmount(amountEth, function (errAmt, amountWei) {
          if (errAmt) return self._renderDepositError(errAmt.message, function () { self._renderDepositAmount(); });
          client.getAssetConfig(client.ETH_ASSET_PLACEHOLDER, function (err, assetConfig) {
            if (err) return self._renderDepositError(err.message, function () { self._renderDepositAmount(); });

            content.innerHTML = '';
            var heading = document.createElement('div');
            heading.textContent = 'Review deposit';
            heading.className = 'lw-heading';
            content.appendChild(heading);

            function row(label, value) {
              var r = document.createElement('div');
              r.style.cssText = 'margin-bottom:6px;font-size:12px;';
              r.innerHTML = '<span style="color:#8e8e93;">' + label + ':</span> ' + value;
              content.appendChild(r);
            }

            row('Amount', amountEth + ' ETH');
            var vettingFeeEth = (Number(assetConfig.vettingFeeBPS) / 10000) * Number(amountEth);
            row('Vetting fee', (Number(assetConfig.vettingFeeBPS) / 100) + '% (~' + vettingFeeEth + ' ETH)');
            row('Minimum deposit', (Number(assetConfig.minimumDepositAmount) / 1e18) + ' ETH');
            row('Gas', 'shown on the next screen, after signing');

            var errorMsg = document.createElement('div');
            errorMsg.className = 'lw-error';
            errorMsg.style.display = 'none';
            content.appendChild(errorMsg);

            if (amountWei < assetConfig.minimumDepositAmount) {
              errorMsg.textContent = 'Amount is below the minimum deposit for this pool.';
              errorMsg.style.display = 'block';
            }

            var confirmBtn = document.createElement('button');
            confirmBtn.textContent = 'Confirm & Sign';
            confirmBtn.style.cssText = 'margin-right:8px;margin-top:8px;';
            confirmBtn.disabled = amountWei < assetConfig.minimumDepositAmount;
            content.appendChild(confirmBtn);

            var backBtn = document.createElement('button');
            backBtn.textContent = 'Back';
            backBtn.style.cssText = 'margin-top:8px;';
            backBtn.addEventListener('click', function () { self._renderDepositAmount(); });
            content.appendChild(backBtn);

            confirmBtn.addEventListener('click', function () {
              confirmBtn.disabled = true;
              confirmBtn.textContent = 'Building and signing…';
              client.buildAndSignDeposit({ amountEth: amountEth }, function (errBuild, result) {
                if (errBuild) return self._renderDepositError(errBuild.message, function () { self._renderDepositAmount(); });
                self._renderDepositSign(result);
              });
            });
          });
        });
      },

      _renderDepositSign: function (result) {
        var self = this;
        this._setContentMode('flow');
        var content = this._contentDiv;
        content.innerHTML = '';

        var heading = document.createElement('div');
        heading.textContent = 'Signed — ready to broadcast';
        heading.className = 'lw-heading';
        content.appendChild(heading);

        var detail = document.createElement('div');
        detail.className = 'lw-mono';
        detail.style.cssText += 'font-size:11px;word-break:break-all;margin-bottom:12px;color:#4c4c52;';
        detail.innerHTML =
          '<div>precommitment: ' + result.precommitment.toString() + '</div>' +
          '<div>scope: ' + result.scope.toString() + '</div>' +
          '<div>index: ' + result.index.toString() + '</div>' +
          '<div>gas: ' + result.unsignedTx.gas.toString() + '</div>' +
          '<div>signed raw tx: ' + result.signedRawTx + '</div>';
        content.appendChild(detail);

        var warning = document.createElement('div');
        warning.textContent = 'Broadcasting submits a REAL mainnet transaction and moves real ETH.';
        warning.className = 'lw-warning danger';
        content.appendChild(warning);

        var broadcastBtn = document.createElement('button');
        broadcastBtn.textContent = 'Broadcast';
        broadcastBtn.style.cssText = 'margin-right:8px;';
        content.appendChild(broadcastBtn);

        var cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', function () { self._refresh(); });
        content.appendChild(cancelBtn);

        broadcastBtn.addEventListener('click', function () {
          broadcastBtn.disabled = true;
          cancelBtn.disabled = true;
          self._renderDepositProcessing();
          var client = lively.identity.privacyPoolClient;
          client.broadcastDeposit(result.signedRawTx, function (errBroadcast, txHash) {
            if (errBroadcast) return self._renderDepositError(errBroadcast.message, function () { self._refresh(); });
            client.waitForDepositReceipt(txHash, function (errReceipt, receipt) {
              if (errReceipt) return self._renderDepositError(errReceipt.message, function () { self._refresh(); });
              client.parseDepositedEvent(receipt, function (errParse, deposited) {
                if (errParse) return self._renderDepositError(errParse.message, function () { self._refresh(); });
                client.recordLocalDeposit(result.unsignedTx.chainId, result.scope, self._address, {
                  index: result.index,
                  commitment: deposited.commitment,
                  label: deposited.label,
                  value: deposited.value,
                  txHash: txHash
                });
                self._renderDepositSuccess(deposited, txHash);
              });
            });
          });
        });
      },

      _renderDepositProcessing: function () {
        this._contentDiv.innerHTML = '<div style="color:#999;padding:20px 0;">Broadcasting and waiting for confirmation…</div>';
      },

      _renderDepositSuccess: function (deposited, txHash) {
        var self = this;
        this._setContentMode('flow');
        var content = this._contentDiv;
        content.innerHTML = '';

        var heading = document.createElement('div');
        heading.textContent = 'Deposit confirmed';
        heading.className = 'lw-heading lw-success';
        content.appendChild(heading);

        var detail = document.createElement('div');
        detail.className = 'lw-mono';
        detail.style.cssText += 'font-size:11px;word-break:break-all;margin-bottom:12px;color:#4c4c52;';
        detail.innerHTML =
          '<div>tx: ' + txHash + '</div>' +
          '<div>commitment: ' + deposited.commitment.toString() + '</div>' +
          '<div>label: ' + deposited.label.toString() + '</div>' +
          '<div>value: ' + deposited.value.toString() + ' wei</div>';
        content.appendChild(detail);

        var doneBtn = document.createElement('button');
        doneBtn.textContent = 'Done';
        doneBtn.addEventListener('click', function () { self._refresh(); });
        content.appendChild(doneBtn);
      },

      _renderDepositError: function (message, backFn) {
        var self = this;
        this._setContentMode('flow');
        var content = this._contentDiv;
        content.innerHTML = '';

        var heading = document.createElement('div');
        heading.textContent = 'Deposit failed';
        heading.className = 'lw-heading';
        heading.style.color = '#b00020';
        content.appendChild(heading);

        var detail = document.createElement('div');
        detail.textContent = message;
        detail.style.cssText = 'margin-bottom:12px;font-size:12px;color:#4c4c52;';
        content.appendChild(detail);

        var backBtn = document.createElement('button');
        backBtn.textContent = 'Back';
        backBtn.addEventListener('click', function () { backFn(); });
        content.appendChild(backBtn);
      },

      // ── withdrawal flow (§9.4, §15 step 8) ──
      // Direct-submit only (§15 step 8's own scope) — no relayer toggle
      // yet, since RelayerStubServer.js's /relayer/request errors by
      // design and neither real mainnet relayer turned out usable (§14
      // item 4). Spendable-commitment list -> Recipient -> Review ->
      // Generating proof (real phase-by-phase progress, §5.6) -> Sign ->
      // (real, user-triggered) Broadcast -> Processing -> Success — same
      // "everything up through Sign only builds/signs, broadcast is a
      // separate explicit click" discipline as the deposit flow above.
      // Full-value withdrawal only (see PrivacyPoolClient.js's own
      // 'withdrawal' section header for why that's the right v1 scope).

      _renderWithdrawList: function () {
        var self = this;
        this._setContentMode('flow');
        var content = this._contentDiv;
        content.innerHTML = '<div style="color:#999;padding:20px 0;">Loading spendable deposits…</div>';

        var client = lively.identity.privacyPoolClient;
        client.getChainId(function (errChain, chainId) {
          if (errChain) return self._renderWithdrawError(errChain.message, function () { self._refresh(); });
          client.getEthPoolScope(function (errScope, scope) {
            if (errScope) return self._renderWithdrawError(errScope.message, function () { self._refresh(); });
            var deposits = client.getLocalDeposits(chainId, scope, self._address);

            content.innerHTML = '';
            var heading = document.createElement('div');
            heading.textContent = 'Spendable deposits';
            heading.className = 'lw-heading';
            content.appendChild(heading);

            if (deposits.length === 0) {
              var empty = document.createElement('div');
              empty.textContent =
                'No deposits made from this device yet. (Recovering spendable ' +
                'deposits made on another device needs full chain-based account ' +
                'reconstruction, WalletSpec.md §10 — not built yet.)';
              empty.style.cssText = 'color:#8e8e93;font-size:12px;margin-bottom:12px;';
              content.appendChild(empty);
            }

            var backBtn = document.createElement('button');
            backBtn.textContent = 'Back';
            backBtn.addEventListener('click', function () { self._refresh(); });
            content.appendChild(backBtn);

            if (deposits.length === 0) return;

            var list = document.createElement('div');
            list.style.cssText = 'margin:12px 0;';
            content.insertBefore(list, backBtn);

            deposits.forEach(function (entry) {
              var row = document.createElement('div');
              row.style.cssText = 'border:1px solid #ECECF3;border-radius:10px;padding:12px;margin-bottom:8px;';

              var amountLine = document.createElement('div');
              amountLine.style.cssText = 'font-weight:600;margin-bottom:4px;';
              amountLine.textContent = (Number(entry.value) / 1e18) + ' ETH';
              row.appendChild(amountLine);

              var labelLine = document.createElement('div');
              labelLine.style.cssText = 'font-family:monospace;font-size:10px;color:#8e8e93;word-break:break-all;margin-bottom:6px;';
              labelLine.textContent = 'label: ' + entry.label;
              row.appendChild(labelLine);

              var statusLine = document.createElement('div');
              statusLine.style.cssText = 'font-size:11px;color:#8e8e93;margin-bottom:8px;';
              statusLine.textContent = 'ASP status: checking…';
              row.appendChild(statusLine);

              var withdrawBtn = document.createElement('button');
              withdrawBtn.textContent = 'Withdraw';
              withdrawBtn.style.cssText = 'margin-right:8px;';
              withdrawBtn.addEventListener('click', function () { self._renderWithdrawRecipient(entry); });
              row.appendChild(withdrawBtn);

              // §6.6/§9.5: Exit has no eligibility gate to check (the
              // contract imposes no timing window — only an
              // original-depositor check, always true here), so it's shown
              // unconditionally alongside Withdraw, same as Withdraw itself
              // isn't gated on the unconfirmed ASP status text above.
              var exitBtn = document.createElement('button');
              exitBtn.textContent = 'Exit';
              exitBtn.style.cssText = 'color:#b00020;border-color:#b00020;';
              exitBtn.addEventListener('click', function () { self._renderExitConfirm(entry); });
              row.appendChild(exitBtn);

              list.appendChild(row);

              // Informational only — the real gate is the ASP-tree Merkle
              // lookup buildWithdrawalProofInputs does at proving time
              // (§6.4.1); reviewStatus's exact value semantics aren't
              // confirmed yet (PrivacyPoolClient.js's own getDepositsByLabel
              // comment), so this never disables the button, just shows
              // whatever the ASP reports.
              client.getDepositsByLabel(chainId, scope, [entry.label], function (errStatus, results) {
                if (errStatus || !results || !results.length) {
                  statusLine.textContent = 'ASP status: unknown (not yet visible to the ASP?)';
                  return;
                }
                statusLine.textContent = 'ASP status: ' + (results[0].reviewStatus || 'unknown');
              });
            });
          });
        });
      },

      _renderWithdrawRecipient: function (commitment) {
        var self = this;
        this._setContentMode('flow');
        var content = this._contentDiv;
        content.innerHTML = '';

        var heading = document.createElement('div');
        heading.textContent = 'Withdraw ' + (Number(commitment.value) / 1e18) + ' ETH';
        heading.className = 'lw-heading';
        content.appendChild(heading);

        var recipientInput = document.createElement('input');
        recipientInput.type = 'text';
        recipientInput.placeholder = 'Recipient address (0x…)';
        recipientInput.style.cssText = 'display:block;width:100%;max-width:340px;box-sizing:border-box;padding:6px 8px;margin-bottom:6px;font-family:monospace;';
        content.appendChild(recipientInput);

        // §2.1 step 5, §9.2: reusing an already-used address re-links what
        // the pool just unlinked — nudge toward a fresh one rather than
        // just a placeholder hint.
        var hint = document.createElement('div');
        hint.textContent = 'Use a fresh address you have not used before — reusing one re-links what this withdrawal unlinks.';
        hint.style.cssText = 'color:#8e8e93;font-size:11px;margin-bottom:8px;max-width:340px;';
        content.appendChild(hint);

        var errorMsg = document.createElement('div');
        errorMsg.className = 'lw-error';
        errorMsg.style.display = 'none';
        content.appendChild(errorMsg);

        var reviewBtn = document.createElement('button');
        reviewBtn.textContent = 'Review';
        reviewBtn.style.cssText = 'margin-right:8px;';
        content.appendChild(reviewBtn);

        var cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', function () { self._renderWithdrawList(); });
        content.appendChild(cancelBtn);

        reviewBtn.addEventListener('click', function () {
          lively.identity.privacyPoolClient.withClientLibs(function (err, libs) {
            var recipient = recipientInput.value.trim();
            if (err || !libs.getAddress || !isValidAddress(recipient)) {
              errorMsg.textContent = 'Enter a valid address.';
              errorMsg.style.display = 'block';
              return;
            }
            self._renderWithdrawReview(commitment, recipient);
          });
          function isValidAddress(addr) { return /^0x[0-9a-fA-F]{40}$/.test(addr); }
        });
      },

      _renderWithdrawReview: function (commitment, recipient) {
        var self = this;
        this._setContentMode('flow');
        var content = this._contentDiv;
        content.innerHTML = '';

        var heading = document.createElement('div');
        heading.textContent = 'Review withdrawal';
        heading.className = 'lw-heading';
        content.appendChild(heading);

        function row(label, value) {
          var r = document.createElement('div');
          r.style.cssText = 'margin-bottom:6px;font-size:12px;word-break:break-all;';
          r.innerHTML = '<span style="color:#8e8e93;">' + label + ':</span> ' + value;
          content.appendChild(r);
        }

        row('Amount', (Number(commitment.value) / 1e18) + ' ETH (full value — no partial withdrawal yet)');
        row('Recipient', recipient);
        row('Submission', 'Direct (no relayer — relayed submission is a later addition, §14 item 4)');
        row('Relayer fee', 'None (direct submission)');

        var confirmBtn = document.createElement('button');
        confirmBtn.textContent = 'Confirm & Generate Proof';
        confirmBtn.style.cssText = 'margin-right:8px;margin-top:8px;';
        content.appendChild(confirmBtn);

        var backBtn = document.createElement('button');
        backBtn.textContent = 'Back';
        backBtn.style.cssText = 'margin-top:8px;';
        backBtn.addEventListener('click', function () { self._renderWithdrawRecipient(commitment); });
        content.appendChild(backBtn);

        confirmBtn.addEventListener('click', function () {
          self._renderWithdrawProving(commitment, recipient);
        });
      },

      // Real phase-by-phase progress (§5.6, §9.4) — loading_circuits ->
      // generating_proof -> verifying_proof — rather than a frozen button;
      // proveWithdrawal genuinely takes real wall-clock time.
      _renderWithdrawProving: function (commitment, recipient) {
        var self = this;
        this._setContentMode('flow');
        var content = this._contentDiv;
        content.innerHTML = '';

        var heading = document.createElement('div');
        heading.textContent = 'Generating proof…';
        heading.className = 'lw-heading';
        content.appendChild(heading);

        var phaseText = document.createElement('div');
        phaseText.textContent = 'Starting…';
        phaseText.style.cssText = 'color:#8e8e93;font-size:12px;';
        content.appendChild(phaseText);

        var PHASE_LABELS = {
          loading_circuits: 'Loading circuit artifacts…',
          generating_proof: 'Generating zero-knowledge proof… (this can take a while)',
          verifying_proof: 'Verifying proof…'
        };

        lively.identity.privacyPoolClient.buildAndSignWithdrawal(
          { commitment: commitment, recipient: recipient },
          function (phase) { phaseText.textContent = PHASE_LABELS[phase] || phase; },
          function (err, result) {
            if (err) return self._renderWithdrawError(err.message, function () { self._renderWithdrawRecipient(commitment); });
            self._renderWithdrawSign(commitment, result);
          }
        );
      },

      _renderWithdrawSign: function (commitment, result) {
        var self = this;
        this._setContentMode('flow');
        var content = this._contentDiv;
        content.innerHTML = '';

        var heading = document.createElement('div');
        heading.textContent = 'Signed — ready to broadcast';
        heading.className = 'lw-heading';
        content.appendChild(heading);

        var detail = document.createElement('div');
        detail.className = 'lw-mono';
        detail.style.cssText += 'font-size:11px;word-break:break-all;margin-bottom:12px;color:#4c4c52;';
        detail.innerHTML =
          '<div>gas: ' + result.unsignedTx.gas.toString() + '</div>' +
          '<div>signed raw tx: ' + result.signedRawTx + '</div>';
        content.appendChild(detail);

        var warning = document.createElement('div');
        warning.textContent = 'Broadcasting submits a REAL mainnet transaction and moves real ETH out of the shielded pool.';
        warning.className = 'lw-warning danger';
        content.appendChild(warning);

        var broadcastBtn = document.createElement('button');
        broadcastBtn.textContent = 'Broadcast';
        broadcastBtn.style.cssText = 'margin-right:8px;';
        content.appendChild(broadcastBtn);

        var cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', function () { self._refresh(); });
        content.appendChild(cancelBtn);

        broadcastBtn.addEventListener('click', function () {
          broadcastBtn.disabled = true;
          cancelBtn.disabled = true;
          self._renderWithdrawProcessing();
          var client = lively.identity.privacyPoolClient;
          client.broadcastWithdrawal(result.signedRawTx, function (errBroadcast, txHash) {
            if (errBroadcast) return self._renderWithdrawError(errBroadcast.message, function () { self._refresh(); });
            client.waitForWithdrawalReceipt(txHash, function (errReceipt, receipt) {
              if (errReceipt) return self._renderWithdrawError(errReceipt.message, function () { self._refresh(); });
              client.parseWithdrawnEvent(receipt, function (errParse, withdrawn) {
                if (errParse) return self._renderWithdrawError(errParse.message, function () { self._refresh(); });
                self._renderWithdrawSuccess(withdrawn, txHash);
              });
            });
          });
        });
      },

      _renderWithdrawProcessing: function () {
        this._contentDiv.innerHTML = '<div style="color:#999;padding:20px 0;">Broadcasting and waiting for confirmation…</div>';
      },

      _renderWithdrawSuccess: function (withdrawn, txHash) {
        var self = this;
        this._setContentMode('flow');
        var content = this._contentDiv;
        content.innerHTML = '';

        var heading = document.createElement('div');
        heading.textContent = 'Withdrawal confirmed';
        heading.className = 'lw-heading lw-success';
        content.appendChild(heading);

        var detail = document.createElement('div');
        detail.className = 'lw-mono';
        detail.style.cssText += 'font-size:11px;word-break:break-all;margin-bottom:12px;color:#4c4c52;';
        detail.innerHTML =
          '<div>tx: ' + txHash + '</div>' +
          '<div>recipient: ' + withdrawn.processooor + '</div>' +
          '<div>value: ' + withdrawn.value.toString() + ' wei</div>';
        content.appendChild(detail);

        var doneBtn = document.createElement('button');
        doneBtn.textContent = 'Done';
        doneBtn.addEventListener('click', function () { self._refresh(); });
        content.appendChild(doneBtn);
      },

      _renderWithdrawError: function (message, backFn) {
        var self = this;
        this._setContentMode('flow');
        var content = this._contentDiv;
        content.innerHTML = '';

        var heading = document.createElement('div');
        heading.textContent = 'Withdrawal failed';
        heading.className = 'lw-heading';
        heading.style.color = '#b00020';
        content.appendChild(heading);

        var detail = document.createElement('div');
        detail.textContent = message;
        detail.style.cssText = 'margin-bottom:12px;font-size:12px;color:#4c4c52;';
        content.appendChild(detail);

        var backBtn = document.createElement('button');
        backBtn.textContent = 'Back';
        backBtn.addEventListener('click', function () { backFn(); });
        content.appendChild(backBtn);
      },

      // ── ragequit / "Exit" flow (§6.6, §9.5, §15 step 9) ──
      // Its own distinct, separately-confirmed action (§9.5 — never folded
      // into the withdraw button, since Exit is a public, unshielded
      // reclaim the user should knowingly opt into). No recipient input,
      // unlike withdrawal: ragequit's on-chain effect
      // (PrivacyPool.sol's _push(msg.sender, value)) always returns funds
      // to the depositor's own address, msg.sender, which is this wallet's
      // one address — nothing to ask the user for. §6.6's corrected
      // finding also means no eligibility check/countdown belongs here:
      // Confirm -> Generating proof (same real phase-by-phase progress as
      // withdrawal, §5.6) -> Sign -> (real, user-triggered) Broadcast ->
      // Processing -> Success, same discipline as deposit/withdrawal.

      _renderExitConfirm: function (commitment) {
        var self = this;
        this._setContentMode('flow');
        var content = this._contentDiv;
        content.innerHTML = '';

        var heading = document.createElement('div');
        heading.textContent = 'Exit ' + (Number(commitment.value) / 1e18) + ' ETH from the pool';
        heading.className = 'lw-heading';
        content.appendChild(heading);

        var warning = document.createElement('div');
        warning.className = 'lw-warning danger';
        warning.style.maxWidth = '360px';
        warning.textContent =
          'Exit is a PUBLIC, unshielded reclaim — it publicly links this ' +
          'deposit to your wallet address on-chain, unlike a normal ' +
          'withdrawal from the pool. Only use it if this deposit is not ' +
          'going to become associated with the pool’s privacy set; ' +
          'otherwise a normal withdrawal is strictly better. Funds return ' +
          'to your own wallet address (' + self._address + ').';
        content.appendChild(warning);

        var confirmBtn = document.createElement('button');
        confirmBtn.textContent = 'Exit (reclaim publicly)';
        confirmBtn.style.cssText = 'margin-right:8px;color:#b00020;border-color:#b00020;';
        content.appendChild(confirmBtn);

        var cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', function () { self._renderWithdrawList(); });
        content.appendChild(cancelBtn);

        confirmBtn.addEventListener('click', function () {
          self._renderExitProving(commitment);
        });
      },

      // Real phase-by-phase progress (§5.6, §9.5) — loading_circuits ->
      // generating_proof -> verifying_proof — same as withdrawal's
      // proveWithdrawal screen; proveCommitment is the same class of
      // genuinely-slow ZK proving work.
      _renderExitProving: function (commitment) {
        var self = this;
        this._setContentMode('flow');
        var content = this._contentDiv;
        content.innerHTML = '';

        var heading = document.createElement('div');
        heading.textContent = 'Generating proof…';
        heading.className = 'lw-heading';
        content.appendChild(heading);

        var phaseText = document.createElement('div');
        phaseText.textContent = 'Starting…';
        phaseText.style.cssText = 'color:#8e8e93;font-size:12px;';
        content.appendChild(phaseText);

        var PHASE_LABELS = {
          loading_circuits: 'Loading circuit artifacts…',
          generating_proof: 'Generating zero-knowledge proof… (this can take a while)',
          verifying_proof: 'Verifying proof…'
        };

        lively.identity.privacyPoolClient.buildAndSignRagequit(
          { commitment: commitment },
          function (phase) { phaseText.textContent = PHASE_LABELS[phase] || phase; },
          function (err, result) {
            if (err) return self._renderExitError(err.message, function () { self._renderExitConfirm(commitment); });
            self._renderExitSign(commitment, result);
          }
        );
      },

      _renderExitSign: function (commitment, result) {
        var self = this;
        this._setContentMode('flow');
        var content = this._contentDiv;
        content.innerHTML = '';

        var heading = document.createElement('div');
        heading.textContent = 'Signed — ready to broadcast';
        heading.className = 'lw-heading';
        content.appendChild(heading);

        var detail = document.createElement('div');
        detail.className = 'lw-mono';
        detail.style.cssText += 'font-size:11px;word-break:break-all;margin-bottom:12px;color:#4c4c52;';
        detail.innerHTML =
          '<div>gas: ' + result.unsignedTx.gas.toString() + '</div>' +
          '<div>signed raw tx: ' + result.signedRawTx + '</div>';
        content.appendChild(detail);

        var warning = document.createElement('div');
        warning.textContent = 'Broadcasting submits a REAL mainnet transaction, publicly reclaiming this deposit back to your own address.';
        warning.className = 'lw-warning danger';
        content.appendChild(warning);

        var broadcastBtn = document.createElement('button');
        broadcastBtn.textContent = 'Broadcast';
        broadcastBtn.style.cssText = 'margin-right:8px;';
        content.appendChild(broadcastBtn);

        var cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', function () { self._refresh(); });
        content.appendChild(cancelBtn);

        broadcastBtn.addEventListener('click', function () {
          broadcastBtn.disabled = true;
          cancelBtn.disabled = true;
          self._renderExitProcessing();
          var client = lively.identity.privacyPoolClient;
          client.broadcastRagequit(result.signedRawTx, function (errBroadcast, txHash) {
            if (errBroadcast) return self._renderExitError(errBroadcast.message, function () { self._refresh(); });
            client.waitForRagequitReceipt(txHash, function (errReceipt, receipt) {
              if (errReceipt) return self._renderExitError(errReceipt.message, function () { self._refresh(); });
              client.parseRagequitEvent(receipt, function (errParse, ragequit) {
                if (errParse) return self._renderExitError(errParse.message, function () { self._refresh(); });
                self._renderExitSuccess(ragequit, txHash);
              });
            });
          });
        });
      },

      _renderExitProcessing: function () {
        this._contentDiv.innerHTML = '<div style="color:#999;padding:20px 0;">Broadcasting and waiting for confirmation…</div>';
      },

      _renderExitSuccess: function (ragequit, txHash) {
        var self = this;
        this._setContentMode('flow');
        var content = this._contentDiv;
        content.innerHTML = '';

        var heading = document.createElement('div');
        heading.textContent = 'Exit confirmed';
        heading.className = 'lw-heading lw-success';
        content.appendChild(heading);

        var detail = document.createElement('div');
        detail.className = 'lw-mono';
        detail.style.cssText += 'font-size:11px;word-break:break-all;margin-bottom:12px;color:#4c4c52;';
        detail.innerHTML =
          '<div>tx: ' + txHash + '</div>' +
          '<div>ragequitter: ' + ragequit.ragequitter + '</div>' +
          '<div>value: ' + ragequit.value.toString() + ' wei</div>';
        content.appendChild(detail);

        var doneBtn = document.createElement('button');
        doneBtn.textContent = 'Done';
        doneBtn.addEventListener('click', function () { self._refresh(); });
        content.appendChild(doneBtn);
      },

      _renderExitError: function (message, backFn) {
        var self = this;
        this._setContentMode('flow');
        var content = this._contentDiv;
        content.innerHTML = '';

        var heading = document.createElement('div');
        heading.textContent = 'Exit failed';
        heading.className = 'lw-heading';
        heading.style.color = '#b00020';
        content.appendChild(heading);

        var detail = document.createElement('div');
        detail.textContent = message;
        detail.style.cssText = 'margin-bottom:12px;font-size:12px;color:#4c4c52;';
        content.appendChild(detail);

        var backBtn = document.createElement('button');
        backBtn.textContent = 'Back';
        backBtn.addEventListener('click', function () { backFn(); });
        content.appendChild(backBtn);
      },

      _setBalanceText: function (text) {
        if (this._balanceTextEl) this._balanceTextEl.textContent = text;
      },

      // Async Clipboard API with a textarea/execCommand fallback for
      // contexts where it's unavailable.
      _copyToClipboard: function (text, btn) {
        var originalLabel = btn.textContent;
        function copied() {
          btn.textContent = 'Copied!';
          setTimeout(function () { btn.textContent = originalLabel; }, 1200);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(copied).catch(function () {});
        } else {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.style.cssText = 'position:fixed;opacity:0;';
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); copied(); } catch (e2) {}
          document.body.removeChild(ta);
        }
      },

    }); // end subclass

    // ── class-side entry point ───────────────────────────────────────────────

    // A plain setFill()/applyStyle({fill:...}) on an already-rendered
    // classic Window can silently update the model without ever reaching
    // the DOM (see CLAUDE.md's applyStyle-DOM-sync gotcha) — this drives
    // the color via a scoped CSS class instead (same technique DMChat.js's
    // applyAccentChrome and PostCardMailbox.js's _ensureAccentChromeCss
    // use), which also survives collapse/expand and any other
    // Window-internal re-render, unlike a one-off inline style write.
    // Indigo-violet keeps this visually distinct from Mailbox's green and
    // DM chat's blue-indigo accents; white title text + a suppressed
    // focus-ring border are needed (unlike Mailbox's lighter green) since
    // this fill is dark/saturated enough that the base theme's default
    // #555/#333 title-text color and white focus ring would both read
    // poorly against it.
    function _ensureAccentChromeCss() {
      var STYLE_ID = 'wallet-accent-chrome-style';
      if (document.getElementById(STYLE_ID)) return;
      var styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
      styleEl.textContent = [
        '.Window.wallet-accent-chrome { background-color: #6C4CE0 !important; }',
        '.Window.wallet-accent-chrome .Text.window-title { color: #fff; }',
        '.Window.wallet-accent-chrome.highlighted .Text.window-title { color: #fff; font-weight: bold; }',
        '.Window.wallet-accent-chrome.highlighted { border: none !important; box-shadow: 0px 3px 10px rgba(20,10,60,0.35) !important; }',
      ].join('\n');
      document.head.appendChild(styleEl);
    }

    Object.extend(WalletClass, {
      // §9.1: no-wallet-yet routes to WalletSetupDialog; has-a-wallet opens
      // this dashboard directly (which itself handles locked vs unlocked).
      open: function () {
        lively.identity.walletBridge.isSetUp(function (err, isSetUp) {
          if (err || !isSetUp) {
            var dialogWin = lively.BuildSpec('lively.identity.WalletSetupDialog').createMorph();
            dialogWin.openInWorldCenter();
            lively.identity.Wallet.applyAccentChrome(dialogWin);
            return;
          }
          var morph = new lively.identity.Wallet(lively.rect(0, 0, 480, 520));
          morph.setName('Wallet');
          // Real classic Window chrome (drag/resize/collapse/close,
          // Material Symbols icon controls by default) rather than the
          // hand-rolled title bar this used to draw itself — same pattern
          // as FilesBrowser.js's/PostCardMailbox.js's open().
          morph.openInWindow({
            title: 'Wallet',
            pos: lively.morphic.World.current().visibleBounds().center().subPt(lively.pt(240, 260)),
          });
          var win = morph.getWindow();
          lively.identity.Wallet.applyAccentChrome(win);
          win.comeForward();
        });
      },

      applyAccentChrome: function (win) {
        _ensureAccentChromeCss();
        win.addStyleClassName('wallet-accent-chrome');
      },
    });

  }); // end module('lively.identity.Wallet')
