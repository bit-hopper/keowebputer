/**
 * lively.identity.WalletCrypto
 *
 * Pure, public-input-only functions shared by both the main Lively world and
 * the Wallet Vault iframe (WalletSpec.md §3.3, §5.7). No ambient secret
 * state, and — critically — no Poseidon anywhere in this file. Every
 * Poseidon-based function in the commitment scheme (WalletSpec.md §6.1:
 * hashPrecommitment, getCommitment, generateDepositSecrets,
 * generateWithdrawalSecrets, generateMasterKeys) takes secret material as an
 * argument and is 100% vault-only, called directly against
 * @0xbow/privacy-pools-core-sdk's own crypto.ts from WalletVault.js — never
 * reimplemented or wrapped here. See WalletSpec.md §5.7 for the full
 * reasoning (bit-for-bit circuit-parameterization risk, plus none of those
 * functions ever had a legitimate secret-free form to share in the first
 * place).
 *
 * This module's actual scope, per §5.7's corrected table:
 *   - calculateContext(withdrawal, scope) — public circuit input, needed by
 *     both the vault (proving) and PrivacyPoolClient.js (constructing the
 *     on-chain withdrawal call).
 *   - bigintToHash / bigintToHex — plain hex encoding, no hashing.
 *   - checksumAddress / isValidAddress — thin passthroughs to viem's
 *     getAddress/isAddress, not custom crypto.
 *
 * calculateContext/bigintToHash/bigintToHex are VENDORED (not imported)
 * from @0xbow/privacy-pools-core-sdk v1.2.0's src/crypto.ts, verified
 * byte-for-byte identical against the real SDK output across multiple test
 * vectors before vendoring. This isn't the general "don't reimplement
 * crypto" rule being broken — it's the specific exception §5.7 carves out:
 * importing those three named exports from the SDK's published dist
 * measured ~1.5MB minified regardless (single rolled-up bundle, no
 * `sideEffects: false`, drags in snarkjs/Poseidon/.wasm weight even for
 * exports that never touch them), so vendoring just these three — each a
 * thin, parameter-free wrapper around plain keccak256/bigint-to-hex, with no
 * parameterization space to silently drift on the way Poseidon has — is the
 * defensible choice. Re-diff against the SDK's src/crypto.ts on every
 * version bump.
 *
 * viem's own primitives (keccak256, encodeAbiParameters, numberToHex,
 * getAddress, isAddress) are real imports, not vendored — measured ~16KB
 * minified for exactly these five named exports (scripts/build-wallet-crypto-libs.js),
 * a normal, tree-shakeable dependency unlike the SDK's dist.
 *
 * Async pattern: thenDo(err, result), matching the rest of
 * lively.identity.* and lively.identity.Crypto's withSodium.
 */

module('lively.identity.WalletCrypto')
  .requires()
  // Note: viem is NOT a Lively module so it cannot appear in .requires() —
  // withWalletCryptoLibs() injects the bundled subset as a plain script on
  // first use, same pattern as lively.identity.Crypto's withSodium.
  .toRun(function() {

Object.subclass('lively.identity.WalletCrypto',

// ─── viem bridge ──────────────────────────────────────────────────────────

'viem', {

  // Ensures the bundled viem subset (scripts/build-wallet-crypto-libs.js) is
  // loaded, then calls thenDo(null, libs) where libs = { keccak256,
  // encodeAbiParameters, numberToHex, getAddress, isAddress }.
  //
  // For Node.js testing, inject directly:
  //   lively.identity.walletCrypto._viem = require('viem');
  withWalletCryptoLibs: function(thenDo) {
    var self = this;
    var libs = this._viem ||
                (typeof window !== 'undefined' && window.walletCryptoLibs) ||
                (typeof global !== 'undefined' && global.walletCryptoLibs) ||
                null;
    if (libs) return thenDo(null, libs);

    if (typeof document === 'undefined') {
      return thenDo(new Error(
        'wallet-crypto-libs.js not loaded and no document to inject it into ' +
        '(non-browser context) — set lively.identity.walletCrypto._viem directly.'
      ));
    }

    if (window._walletCryptoLibsLoading) {
      var poll = setInterval(function () {
        if (window.walletCryptoLibs) {
          clearInterval(poll);
          self.withWalletCryptoLibs(thenDo);
        }
      }, 50);
      return;
    }

    window._walletCryptoLibsLoading = true;
    var s = document.createElement('script');
    s.src = '/core/lib/wallet/wallet-crypto-libs.js';
    s.onload = function () {
      window._walletCryptoLibsLoading = false;
      self.withWalletCryptoLibs(thenDo);
    };
    s.onerror = function () {
      window._walletCryptoLibsLoading = false;
      thenDo(new Error('Failed to load /core/lib/wallet/wallet-crypto-libs.js'));
    };
    document.head.appendChild(s);
  }

},

// ─── encoding (vendored, verbatim, from crypto.ts — no hashing) ───────────

'encoding', {

  // Vendored verbatim from @0xbow/privacy-pools-core-sdk v1.2.0's
  // src/crypto.ts, bigintToHash. Plain hex padding, no dependency needed.
  bigintToHash: function(value) {
    return '0x' + value.toString(16).padStart(64, '0');
  },

  // Vendored verbatim from @0xbow/privacy-pools-core-sdk v1.2.0's
  // src/crypto.ts, bigintToHex.
  bigintToHex: function(num) {
    if (num === undefined) throw new Error('Undefined bigint value!');
    return '0x' + BigInt(num).toString(16).padStart(64, '0');
  }

},

// ─── context (vendored, verbatim, from crypto.ts — keccak256 only) ────────

'context', {

  // Vendored verbatim from @0xbow/privacy-pools-core-sdk v1.2.0's
  // src/crypto.ts, calculateContext — WalletSpec.md §6.4 quotes this same
  // implementation. withdrawal: { processooor: '0x...', data: '0x...' }.
  // scope: bigint. Calls thenDo(null, contextHex).
  //
  // SNARK_SCALAR_FIELD is the same fixed BN254 scalar field constant the
  // SDK's src/constants.ts exports — copied here as a literal since it's a
  // protocol-wide numeric constant, not something with a parameter space to
  // drift on.
  calculateContext: function(withdrawal, scope, thenDo) {
    var SNARK_SCALAR_FIELD = BigInt(
      '21888242871839275222246405745257275088548364400416034343698204186575808495617'
    );
    this.withWalletCryptoLibs(function(err, libs) {
      if (err) return thenDo(err);
      try {
        var encoded = libs.encodeAbiParameters(
          [
            {
              name: 'withdrawal',
              type: 'tuple',
              components: [
                { name: 'processooor', type: 'address' },
                { name: 'data', type: 'bytes' }
              ]
            },
            { name: 'scope', type: 'uint256' }
          ],
          [
            { processooor: withdrawal.processooor, data: withdrawal.data },
            scope
          ]
        );
        var hash = BigInt(libs.keccak256(encoded)) % SNARK_SCALAR_FIELD;
        thenDo(null, libs.numberToHex(hash));
      } catch (e) { thenDo(e); }
    });
  }

},

// ─── address (passthrough to viem — not custom crypto) ────────────────────

'address', {

  // EIP-55 checksum. Throws (via thenDo(err)) on a structurally invalid
  // address — this is viem's own getAddress, not a reimplementation.
  checksumAddress: function(address, thenDo) {
    this.withWalletCryptoLibs(function(err, libs) {
      if (err) return thenDo(err);
      try { thenDo(null, libs.getAddress(address)); }
      catch (e) { thenDo(e); }
    });
  },

  // Non-throwing validity check (viem's isAddress).
  isValidAddress: function(address, thenDo) {
    this.withWalletCryptoLibs(function(err, libs) {
      if (err) return thenDo(err);
      try { thenDo(null, libs.isAddress(address)); }
      catch (e) { thenDo(e); }
    });
  }

});

// Singleton: lively.identity.walletCrypto.calculateContext(...), etc.
lively.identity.walletCrypto = new lively.identity.WalletCrypto();

}); // end module('lively.identity.WalletCrypto')
