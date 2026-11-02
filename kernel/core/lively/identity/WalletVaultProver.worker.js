/**
 * lively.identity.WalletVaultProver (Worker)
 *
 * WalletSpec.md §5.6, §15 step 6. Same-origin Web Worker spawned by
 * WalletVault.js so Groth16 proof generation (CPU-bound, real wall-clock
 * time — confirmed directly: even this file's own isolation test takes
 * real time to run) never blocks the vault page's own UI thread-
 * equivalent. Plain JS, no Lively module system — same reasoning as
 * WalletVault.js itself (Workers don't have it regardless of what the
 * page that spawned them has loaded), and no postMessage boundary
 * crossing here in the §3 sense either: this Worker and the vault page
 * that owns it are the same trusted realm (§5.6's own note).
 *
 * Reuses @0xbow/privacy-pools-core-sdk's own CommitmentService/
 * WithdrawalService directly — they already wrap
 * snarkjs.groth16.fullProve/.verify with the exact confirmed signal
 * shapes (§6.1, §6.4). Nothing here reimplements circuit-facing proving
 * logic, matching §5.7's "never reimplement Poseidon or circuit-facing
 * crypto" principle extended to proof orchestration itself.
 *
 * Circuit artifacts (core/lib/privacy-pools/artifacts/*.{wasm,vkey,zkey},
 * vendored + SHA-256-verified at build time by
 * scripts/fetch-privacy-pools-circuits.js — never fetched from a third
 * party at runtime, §5.5) are loaded by the SDK's own Circuits class,
 * which has its own additional integrity check
 * (verifyArtifactIntegrity) — defense in depth on top of this project's
 * own build-time verification, not a replacement for it.
 *
 * Message protocol: { id, method: 'proveCommitment' | 'proveWithdrawal',
 * params }. Progress messages mirror privacy-pools-website's own
 * confirmed phase names exactly (§5.6): { id, type: 'progress', phase:
 * 'loading_circuits' | 'generating_proof' | 'verifying_proof' }. Final
 * message: { id, type: 'result', error, proof, publicSignals }.
 *
 * proveCommitment params: { value, label, nullifier, secret } (BigInts —
 * structured clone, which postMessage uses, supports BigInt natively,
 * unlike JSON).
 * proveWithdrawal params: { commitment: { value, label, nullifier,
 * secret }, input: { context, withdrawalAmount, stateMerkleProof,
 * aspMerkleProof, stateRoot, stateTreeDepth, aspRoot, aspTreeDepth,
 * newSecret, newNullifier } } — exact WithdrawalProofInput shape from
 * the SDK's own types/withdrawal.ts, confirmed via direct source reading.
 */

(function () {
  'use strict';

  var _libs = null;
  var _circuits = null;
  var _commitmentService = null;
  var _withdrawalService = null;

  function withLibs(thenDo) {
    if (_libs) return thenDo(null, _libs);
    if (self._walletVaultProverLibsLoading) {
      var poll = setInterval(function () {
        if (self.walletVaultProverLibs) {
          clearInterval(poll);
          withLibs(thenDo);
        }
      }, 50);
      return;
    }
    self._walletVaultProverLibsLoading = true;
    try {
      importScripts('/core/lib/wallet/vault-prover-libs.js');
    } catch (e) {
      self._walletVaultProverLibsLoading = false;
      return thenDo(new Error('Failed to load /core/lib/wallet/vault-prover-libs.js: ' + e.message));
    }
    self._walletVaultProverLibsLoading = false;
    if (!self.walletVaultProverLibs) {
      return thenDo(new Error(
        '/core/lib/wallet/vault-prover-libs.js loaded but did not set self.walletVaultProverLibs ' +
        '— it likely threw while evaluating.'
      ));
    }
    _libs = self.walletVaultProverLibs;
    thenDo(null, _libs);
  }

  // Circuits instance (and the two proving services built on it) is
  // created once and reused — the SDK's own artifact fetch + integrity
  // check happens on first use, not per-proof.
  function withServices(thenDo) {
    withLibs(function (err, libs) {
      if (err) return thenDo(err);
      if (_commitmentService && _withdrawalService) {
        return thenDo(null, { commitmentService: _commitmentService, withdrawalService: _withdrawalService });
      }
      try {
        // Trailing slash matters: the SDK does
        // new URL(["artifacts", filename].join("/"), baseUrl) — without a
        // trailing slash here, URL-relative-resolution would replace the
        // last path segment of baseUrl instead of appending to it.
        _circuits = new libs.Circuits({ baseUrl: self.location.origin + '/core/lib/privacy-pools/' });
        _commitmentService = new libs.CommitmentService(_circuits);
        _withdrawalService = new libs.WithdrawalService(_circuits);
        thenDo(null, { commitmentService: _commitmentService, withdrawalService: _withdrawalService });
      } catch (e) { thenDo(e); }
    });
  }

  function postProgress(id, phase) {
    self.postMessage({ id: id, type: 'progress', phase: phase });
  }

  function postResult(id, err, result) {
    self.postMessage({
      id: id,
      type: 'result',
      error: err ? { message: err.message } : null,
      proof: result ? result.proof : null,
      publicSignals: result ? result.publicSignals : null,
    });
  }

  self.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || typeof msg.id === 'undefined' || !msg.method) return;
    var id = msg.id;
    var params = msg.params || {};

    postProgress(id, 'loading_circuits');

    withServices(function (err, services) {
      if (err) return postResult(id, err, null);

      if (msg.method === 'proveCommitment') {
        postProgress(id, 'generating_proof');
        services.commitmentService.proveCommitment(
          params.value, params.label, params.nullifier, params.secret
        ).then(function (result) {
          postProgress(id, 'verifying_proof');
          return services.commitmentService.verifyCommitment(result).then(function (valid) {
            if (!valid) throw new Error('proveCommitment: generated proof did not verify');
            postResult(id, null, result);
          });
        }).catch(function (e) { postResult(id, e, null); });
        return;
      }

      if (msg.method === 'proveWithdrawal') {
        postProgress(id, 'generating_proof');
        services.withdrawalService.proveWithdrawal(params.commitment, params.input)
          .then(function (result) {
            postProgress(id, 'verifying_proof');
            return services.withdrawalService.verifyWithdrawal(result).then(function (valid) {
              if (!valid) throw new Error('proveWithdrawal: generated proof did not verify');
              postResult(id, null, result);
            });
          }).catch(function (e) { postResult(id, e, null); });
        return;
      }

      postResult(id, new Error('Unknown method: ' + msg.method), null);
    });
  });
})();
