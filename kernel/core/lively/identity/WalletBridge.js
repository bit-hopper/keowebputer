/**
 * lively.identity.WalletBridge
 *
 * WalletSpec.md §3.4, §15 step 3: the postMessage RPC client that lives in
 * the main Lively world, creates and owns the (initially hidden) Wallet
 * Vault <iframe>, and speaks the small JSON-RPC-shaped protocol
 * WalletVault.js (core/lively/identity/WalletVault.js) responds to on the
 * other side.
 *
 * Holds no secrets itself (§3.3's table) — every method here is a thin
 * postMessage round trip; whatever crosses the boundary in each direction
 * is exactly what §3.4's table allows. As of step 7: setup/unlock/lock/
 * getAddress/isSetUp/signTransaction/deriveDepositSecrets, matching
 * WalletVault.js's RPC responder. Step 8 adds proveWithdrawal, the first
 * method that reports progress mid-flight (loading_circuits/
 * generating_proof/verifying_proof, §5.6) rather than a single response —
 * see call()'s own comment for how that extends the postMessage protocol.
 * Step 9 adds proveCommitment (§6.6, ragequit's proof) — same progress
 * shape as proveWithdrawal, reused as-is. Step 10 adds exportBackupBlob
 * (§7.2) — a plain single-response call, no progress, returning the
 * vault's own opaque encrypted record for lively.identity.WalletBackup to
 * re-encrypt and upload.
 * revealMnemonic is deliberately never wired here at all: per
 * §3.4 it never crosses the postMessage boundary in either direction, in
 * any step. setup()'s result here is {address} only — WalletVault.js's RPC
 * responder strips the mnemonic before it ever reaches this file (a step-4
 * fix; see that file's own header for what the gap was).
 *
 * _vaultOrigin resolution: lively.Config.get('identityWalletOrigin') if
 * configured, else window.location.origin — the unconfigured case IS §3.2's
 * same-origin dev fallback (no cross-origin/vhost infrastructure exists in
 * this codebase yet; that's a later step's problem, not a limitation of
 * this file). The postMessage target/expected-origin logic below is
 * written the same way it would need to be for a real second origin —
 * nothing here special-cases fallback mode, it just naturally resolves to
 * window.location.origin when unconfigured.
 *
 * The iframe's sandbox="allow-scripts allow-same-origin" attribute is
 * exactly §3.2's stated local-dev-fallback shape (persists IndexedDB,
 * forfeits the cross-origin isolation guarantee) — harmless once a real
 * second origin is configured later, since genuine cross-origin already
 * provides real isolation without needing the sandbox attribute at all.
 * allow="publickey-credentials-get" is required separately — Chrome's
 * WebAuthn Permissions Policy integration blocks navigator.credentials.get()
 * inside an <iframe> unless this is explicitly delegated, sandboxed or not;
 * without it, WalletVault.js's WebAuthn PRF path would silently fail only
 * once actually embedded (step 2's testing never hit this, since that
 * tested /wallet-vault by direct navigation, never inside an iframe).
 *
 * BUG FIX: call() now requires an active identity session and injects the
 * current identity's did/credentialId/rpId into EVERY call's params —
 * previously every wallet method sent bare params with no identity
 * information at all, so WalletVault.js (which never had any either) fell
 * back to a single, hardcoded global record shared by every Lively
 * identity using the same browser/device. See WalletVault.js's own header
 * for the full fix (per-DID storage keying and DEK caching). This
 * injection point is deliberately centralized here rather than pushed onto
 * every individual wrapper method below, so no caller of walletBridge.*
 * anywhere else in this codebase needed to change.
 *
 * Async pattern: thenDo(err, result), matching the rest of
 * lively.identity.*.
 */

module('lively.identity.WalletBridge')
  .requires('lively.identity.DID')
  .toRun(function() {

Object.subclass('lively.identity.WalletBridge',

// ─── vault iframe lifecycle ──────────────────────────────────────────────

'iframe', {

  initialize: function() {
    this._nextId = 1;
    this._pending = {};
    this._listenerInstalled = false;
    this._vaultFrame = null;
    this._vaultOriginResolved = null;
  },

  _vaultOrigin: function() {
    return (lively.Config && lively.Config.get('identityWalletOrigin')) || window.location.origin;
  },

  // Lazily creates the hidden vault <iframe> on first call() — same
  // lazy-injection shape as lively.identity.Crypto's withSodium /
  // WalletCrypto's withWalletCryptoLibs, applied to an iframe instead of a
  // script tag.
  _withVaultFrame: function(thenDo) {
    var self = this;
    if (this._vaultFrame) return thenDo(null, this._vaultFrame);

    // "Creation in progress" guard -- same shape as WalletVault.js's own
    // withVaultLibs/_walletVaultLibsLoading. Without it, this method
    // creates a BRAND NEW iframe on every single call made before the
    // first one's onload actually fires, because this._vaultFrame stays
    // falsy for the whole time it's loading -- and _startVaultFrameSync
    // (WalletSetupDialog.js) calls showVaultFrame, and therefore this
    // method, from a requestAnimationFrame loop, up to ~60 times a
    // second, for as long as the vault-visible screen is showing.
    // Confirmed live: many duplicate iframes accumulated in the DOM, each
    // independently loading and running its own WalletVault.js instance,
    // with whichever one's onload fired LAST silently winning the
    // _vaultFrame reference -- so a real setup() call's postMessage could
    // go to a DIFFERENT iframe than the one actually showing on screen,
    // or to one that hadn't finished loading yet, making the vault UI
    // intermittently never render at all.
    if (this._vaultFrameWaiters) {
      this._vaultFrameWaiters.push(thenDo);
      return;
    }
    this._vaultFrameWaiters = [thenDo];

    var origin = this._vaultOrigin();
    var iframe = document.createElement('iframe');
    iframe.src = origin + '/wallet-vault';
    iframe.style.display = 'none';
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    iframe.setAttribute('allow', 'publickey-credentials-get');
    iframe.onload = function() {
      self._vaultFrame = iframe;
      self._vaultOriginResolved = origin;
      var waiters = self._vaultFrameWaiters;
      self._vaultFrameWaiters = null;
      waiters.forEach(function(waiterThenDo) { waiterThenDo(null, iframe); });
    };
    document.body.appendChild(iframe);
  }

},

// ─── vault iframe visibility (§8.1/§8.2) ────────────────────────────────
// Position-only — the iframe is NEVER reparented. Moving an iframe to a
// new DOM parent reloads it in most browsers, which would wipe
// WalletVault's in-memory _unlockedDek mid-flow (found while planning
// WalletSetupDialog.js, step 4). "Showing it inside a dialog" just means
// positioning this permanently-body-attached iframe with fixed CSS
// coordinates matching the dialog's on-screen rect — the iframe's DOM
// parent (document.body) never changes.

'visibility', {

  // rect: { top, left, width, height } in viewport pixels — e.g. from
  // dialog.renderContext().shapeNode.getBoundingClientRect(). Creates the
  // iframe first if this is the very first call() (setup/unlock/etc) a
  // caller has made.
  showVaultFrame: function(rect, thenDo) {
    this._withVaultFrame(function(err, iframe) {
      if (err) { if (thenDo) thenDo(err); return; }
      iframe.style.cssText =
        'position:fixed;z-index:9000;border:none;' +
        'top:' + rect.top + 'px;left:' + rect.left + 'px;' +
        'width:' + rect.width + 'px;height:' + rect.height + 'px;' +
        'display:block;';
      if (thenDo) thenDo(null);
    });
  },

  hideVaultFrame: function() {
    if (this._vaultFrame) this._vaultFrame.style.display = 'none';
  }

},

// ─── postMessage RPC (§3.4, exact protocol shape) ───────────────────────

'rpc', {

  // §15 step 8: _pending[id] now holds { thenDo, onProgress } rather than a
  // bare function — a small, backward-compatible protocol extension for
  // proveWithdrawal's progress reporting (§5.6/§9.4). Progress messages are
  // tagged type:'progress' by WalletVault.js's responder specifically so
  // they can be told apart from the one final {id, error, result} message
  // (which never sets type) — dispatched to onProgress and never delete
  // the pending entry, since more messages (progress or final) still
  // follow.
  _installResponseListener: function() {
    if (this._listenerInstalled) return;
    this._listenerInstalled = true;
    var self = this;
    window.addEventListener('message', function(ev) {
      if (ev.origin !== self._vaultOriginResolved) return; // reject anything else
      if (!self._vaultFrame || ev.source !== self._vaultFrame.contentWindow) return;
      var msg = ev.data;
      if (!msg || typeof msg.id === 'undefined') return;
      var pending = self._pending[msg.id];
      if (!pending) return;
      if (msg.type === 'progress') {
        if (pending.onProgress) pending.onProgress(msg.phase);
        return;
      }
      delete self._pending[msg.id];
      var err = null;
      if (msg.error) {
        err = new Error(msg.error.message);
        // Carries WalletVault.js's error.code (e.g. 'user-back') across
        // this reconstruction -- a plain `new Error(message)` otherwise
        // drops it, and setup()'s own caller needs it to tell "user
        // clicked Back" apart from a genuine failure.
        if (msg.error.code) err.code = msg.error.code;
      }
      pending.thenDo(err, msg.result);
    });
  },

  // Every call wraps a postMessage round trip in the existing thenDo
  // convention so callers don't know the vault exists (§3.4). onProgress
  // is optional — most methods never receive a progress message at all,
  // so passing it for e.g. getAddress is simply inert.
  //
  // BUG FIX (this file's own header): always resolves the current identity
  // and injects { did, credentialId, rpId } into whatever params the
  // caller passed — merged as siblings of the caller's own fields, never
  // overwriting them (a caller-supplied params object never legitimately
  // has these names already). The vault uses did to look up the RIGHT
  // identity's own record/session instead of a single global one, and
  // credentialId/rpId to target the RIGHT passkey at setup time. Requires
  // an active identity session for every single call, including read-only
  // ones like isSetUp — correct, since "is this device's wallet set up" is
  // meaningless without knowing which identity is asking.
  call: function(method, params, thenDo, onProgress) {
    var self = this;
    var identity = lively.identity.did.currentUser();
    if (!identity) {
      return thenDo(new Error(
        'WalletBridge: no identity session active — the wallet is scoped ' +
        'per Lively identity (WalletSpec.md §0), not per device'
      ));
    }
    var fullParams = Object.assign({}, params || {}, {
      did: identity.did,
      credentialId: identity.credentialId,
      rpId: identity.rpId
    });
    this._withVaultFrame(function(err, iframe) {
      if (err) return thenDo(err);
      self._installResponseListener();
      var id = self._nextId++;
      self._pending[id] = { thenDo: thenDo, onProgress: onProgress };
      iframe.contentWindow.postMessage(
        { id: id, method: method, params: fullParams },
        self._vaultOriginResolved // never '*' — always the resolved vault origin
      );
    });
  }

},

// ─── convenience wrappers ────────────────────────────────────────────────

'methods', {

  setup: function(options, thenDo) { this.call('setup', options, thenDo); },
  unlock: function(options, thenDo) { this.call('unlock', options, thenDo); },
  lock: function(thenDo) { this.call('lock', null, thenDo); },
  getAddress: function(thenDo) { this.call('getAddress', null, thenDo); },
  isSetUp: function(thenDo) { this.call('isSetUp', null, thenDo); },
  // Wrapped in { unsignedTx } rather than sent bare — call() merges
  // did/credentialId/rpId as SIBLINGS of whatever params object it's
  // given, so a bare unsignedTx would otherwise get those fields mixed
  // directly into the tx shape viem's own signTransaction expects.
  signTransaction: function(unsignedTx, thenDo) {
    this.call('signTransaction', { unsignedTx: unsignedTx }, thenDo);
  },

  // §6.2, §15 step 7: scope/index are public (BigInts — postMessage's
  // structured clone carries them natively). Returns { precommitment }.
  deriveDepositSecrets: function(scope, index, thenDo) {
    this.call('deriveDepositSecrets', { scope: scope, index: index }, thenDo);
  },

  // §6.4.1, §15 step 8: params per §3.4's corrected table — { scope, index,
  // label, value, withdrawalIndex, input: {...} }, all public (BigInts and
  // plain numbers only — structured clone carries both natively).
  // onProgress(phase) fires zero or more times with 'loading_circuits' /
  // 'generating_proof' / 'verifying_proof' (§5.6) before thenDo's one final
  // call. Returns { proof, publicSignals } — both public (§3.4's table).
  proveWithdrawal: function(params, onProgress, thenDo) {
    this.call('proveWithdrawal', params, thenDo, onProgress);
  },

  // §6.6, §15 step 9: params { scope, index, label, value }, all public —
  // same shape as deriveDepositSecrets' inputs, since a ragequit proof
  // spends the original deposit's own nullifier/secret rather than deriving
  // a new pair. Same progress/result shape as proveWithdrawal.
  proveCommitment: function(params, onProgress, thenDo) {
    this.call('proveCommitment', params, thenDo, onProgress);
  },

  // §7.2, §15 step 10: no params — returns the vault's own opaque encrypted
  // wallet-blob record (§7.1) unmodified, for the main world
  // (lively.identity.WalletBackup) to re-encrypt under the identity's OWN
  // Files-encryption-plane KEK/DEK before uploading. Ciphertext only, never
  // triggers unlock (§3.4's table).
  exportBackupBlob: function(thenDo) {
    this.call('exportBackupBlob', null, thenDo);
  },

  // Reverse of exportBackupBlob, for recovery (lively.identity.WalletBackup
  // .recoverBackup): blob is an already-encrypted wallet-blob record
  // (recovered from a Files backup and decrypted down one layer — the
  // Files-encryption-plane layer only, never the vault's own inner
  // encryption). The vault stores it as-is and refuses if a wallet is
  // already set up for this identity — never overwrites silently.
  importBackupBlob: function(blob, thenDo) {
    this.call('importBackupBlob', { blob: blob }, thenDo);
  }

});

lively.identity.walletBridge = new lively.identity.WalletBridge();

}); // end module('lively.identity.WalletBridge')
