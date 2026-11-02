/**
 * lively.identity.PrivacyPoolClient
 *
 * WalletSpec.md §11, §15 step 4: public-data orchestration in the main
 * world — RPC calls, tx broadcast, chain-event scan. No secrets touched
 * here at all (§3.3's table): this file never holds a private key or
 * mnemonic; the one place it needs a signature, it calls into
 * lively.identity.walletBridge (§6.6's pattern — simulate/build here,
 * sign only through the vault, broadcast here).
 *
 * Step 4: the plain-ETH subset — getBalance and buildAndSignTransfer. Step
 * 5 additions: ASP client methods against the real production API
 * (api.0xbow.io, live-verified including CORS preflight for its custom
 * X-Pool-Scope header, from an actual browser at Lively's own origin —
 * see the 'asp' section below), and relayer client methods against a
 * local stub (RelayerStubServer.js — the two real 0xbow-operated mainnet
 * relayers turned out unusable: one's domain is dead/parked, the other is
 * CORS-blocked from arbitrary origins; self-hosting remains the real path
 * for production relaying, exactly as §6.5 already recommended). Step 7
 * adds the real deposit flow (§6.2, §6.6) — see the 'deposit' section
 * below. Step 8 adds the real withdrawal flow, direct-submit only (§6.4,
 * §6.4.1, §6.6) — see the 'withdrawal' section: Merkle proof building
 * against the ASP's own leaf data, formatProof's pB-swap, and
 * the simulate→sign→broadcast call against PrivacyPool.withdraw()
 * directly (not the Entrypoint — that's deposit-only). Step 9 adds the real
 * ragequit flow (§6.6, §9.5) — see the 'ragequit' section below: reuses
 * formatProof (renamed from formatWithdrawalProof, since it's the exact
 * same transform for both proof types) and the same simulate→sign-via-
 * vault→broadcast shape, called against PrivacyPool.ragequit(proof)'s
 * single-argument form instead of withdraw()'s two-argument one. Full
 * chain-event scan for spendable commitments (§10) is still a later step's
 * addition to this same file.
 *
 * buildAndSignTransfer deliberately never broadcasts (no
 * eth_sendRawTransaction call exists anywhere in this file or its
 * dependency bundle) — per WalletSpec.md §15 step 4's own scope, actually
 * broadcasting a real mainnet transaction was a separate, later,
 * explicitly-directed action. Step 7 is that action, but only for deposits
 * (buildAndSignDeposit/broadcastDeposit below) — buildAndSignTransfer's own
 * "never broadcasts" behavior for plain sends is untouched.
 *
 * Dependency bundle: core/lib/wallet/privacy-pool-client-libs.js (built by
 * scripts/build-privacy-pool-client-libs.js), lazy-loaded the same way
 * lively.identity.WalletCrypto loads wallet-crypto-libs.js — its own
 * bundle, not folded into WalletCrypto's, since that file's own scope is
 * specifically "what WalletCrypto needs" (public-input-only helpers, no
 * RPC client). Step 8 addition: this module now also declares a real
 * .requires('lively.identity.WalletCrypto') — the withdrawal section below
 * calls lively.identity.walletCrypto.calculateContext/bigintToHex
 * directly, and nothing before step 8 needed WalletCrypto loaded at all
 * (deposit's simulate→sign→broadcast path never touched it).
 *
 * Async pattern: thenDo(err, result), matching the rest of
 * lively.identity.*.
 */

module('lively.identity.PrivacyPoolClient')
  .requires('lively.identity.WalletCrypto')
  .toRun(function() {

Object.subclass('lively.identity.PrivacyPoolClient',

// ─── dependency bundle + publicClient lazy loading ──────────────────────

'client', {

  withClientLibs: function(thenDo) {
    var self = this;
    var libs = this._clientLibs ||
                (typeof window !== 'undefined' && window.privacyPoolClientLibs) ||
                (typeof global !== 'undefined' && global.privacyPoolClientLibs) ||
                null;
    if (libs) return thenDo(null, libs);

    if (typeof document === 'undefined') {
      return thenDo(new Error(
        'privacy-pool-client-libs.js not loaded and no document to inject it into ' +
        '(non-browser context) — set privacyPoolClient._clientLibs directly.'
      ));
    }

    if (window._privacyPoolClientLibsLoading) {
      var poll = setInterval(function () {
        if (window.privacyPoolClientLibs) {
          clearInterval(poll);
          self.withClientLibs(thenDo);
        }
      }, 50);
      return;
    }

    window._privacyPoolClientLibsLoading = true;
    var s = document.createElement('script');
    s.src = '/core/lib/wallet/privacy-pool-client-libs.js';
    s.onload = function () {
      window._privacyPoolClientLibsLoading = false;
      if (!window.privacyPoolClientLibs) {
        return thenDo(new Error(
          '/core/lib/wallet/privacy-pool-client-libs.js loaded but did not set ' +
          'window.privacyPoolClientLibs — it likely threw while evaluating; check the console.'
        ));
      }
      self.withClientLibs(thenDo);
    };
    s.onerror = function () {
      window._privacyPoolClientLibsLoading = false;
      thenDo(new Error('Failed to load /core/lib/wallet/privacy-pool-client-libs.js'));
    };
    document.head.appendChild(s);
  },

  // §12: REQUIRED, no default shipped — set a real value in localconfig.js.
  // Deposit/withdraw/exit/ASP calls always go through this (mainnet only,
  // unaffected by whichever network the plain-wallet UI has selected below)
  // — the Privacy Pools Entrypoint/Pool contracts and the ASP API
  // (config.json's own privacyPool* keys) only exist on mainnet.
  _withPublicClient: function(thenDo) {
    this._withPublicClientFor('mainnet', thenDo);
  },

  // Plain-wallet (balance/send) network support — WalletSpec.md's privacy
  // pool flows are mainnet-only (see _withPublicClient above), but the
  // ordinary "check balance / sign a transfer" path has no such
  // restriction, so it can point at any configured chain. Sepolia is the
  // one other network wired up so far; adding another later is just another
  // NETWORKS entry + a matching viem/chains export in
  // privacy-pool-client-libs.js.
  NETWORKS: {
    mainnet: {
      key: 'mainnet', label: 'Ethereum Mainnet', short: 'Mainnet',
      chainLib: 'mainnet', rpcConfigKey: 'ethereumRpcUrl',
      explorerUrl: 'https://etherscan.io',
    },
    sepolia: {
      key: 'sepolia', label: 'Sepolia Testnet', short: 'Sepolia',
      chainLib: 'sepolia', rpcConfigKey: 'ethereumSepoliaRpcUrl',
      explorerUrl: 'https://sepolia.etherscan.io',
    },
  },

  getNetworks: function() { return this.NETWORKS; },

  _withPublicClientFor: function(network, thenDo) {
    var self = this;
    var netConfig = this.NETWORKS[network];
    if (!netConfig) return thenDo(new Error('PrivacyPoolClient: unknown network "' + network + '"'));
    this._publicClients = this._publicClients || {};
    if (this._publicClients[network]) return thenDo(null, this._publicClients[network]);
    var rpcUrl = lively.Config && lively.Config.get(netConfig.rpcConfigKey);
    if (!rpcUrl) {
      return thenDo(new Error(
        'PrivacyPoolClient: ' + netConfig.rpcConfigKey + ' is not configured for ' +
        netConfig.label + ' — set it in core/lively/localconfig.js.'
      ));
    }
    this.withClientLibs(function(err, libs) {
      if (err) return thenDo(err);
      try {
        self._publicClients[network] = libs.createPublicClient({
          chain: libs[netConfig.chainLib],
          transport: libs.http(rpcUrl)
        });
        thenDo(null, self._publicClients[network]);
      } catch (e) { thenDo(e); }
    });
  }

},

// ─── public data ─────────────────────────────────────────────────────────

'balance', {

  // Returns thenDo(null, chainId). `network` (optional, default 'mainnet')
  // is only meaningful for plain-wallet callers — the withdraw/exit flows
  // that call this without a network arg keep getting mainnet, unchanged.
  getChainId: function(network, thenDo) {
    if (typeof network === 'function') { thenDo = network; network = 'mainnet'; }
    this._withPublicClientFor(network, function(err, client) {
      if (err) return thenDo(err);
      client.getChainId().then(function(chainId) { thenDo(null, chainId); })
        .catch(function(e) { thenDo(e); });
    });
  },

  // Returns thenDo(null, { wei: bigint, eth: string }). `network` optional,
  // default 'mainnet' — see getChainId above.
  getBalance: function(address, network, thenDo) {
    if (typeof network === 'function') { thenDo = network; network = 'mainnet'; }
    var self = this;
    this._withPublicClientFor(network, function(err, client) {
      if (err) return thenDo(err);
      self.withClientLibs(function(err2, libs) {
        if (err2) return thenDo(err2);
        client.getBalance({ address: address }).then(function(wei) {
          thenDo(null, { wei: wei, eth: libs.formatEther(wei) });
        }).catch(function(e) { thenDo(e); });
      });
    });
  }

},

// ─── build + sign (never broadcast — §15 step 4's own scope) ────────────

'transfer', {

  // { to, amountEth, network }: to is a checksummed/hex address string,
  // amountEth a decimal string ("0.01"), network optional (default
  // 'mainnet' — see getChainId above). Calls thenDo(null, { signedRawTx,
  // unsignedTx }). Fetches nonce/gas/chainId (public data, no secrets) here,
  // signs only via lively.identity.walletBridge.signTransaction (the
  // vault), and never calls sendRawTransaction — see this file's own
  // header.
  buildAndSignTransfer: function(options, thenDo) {
    var self = this;
    this._withPublicClientFor(options.network || 'mainnet', function(err, client) {
      if (err) return thenDo(err);
      self.withClientLibs(function(err2, libs) {
        if (err2) return thenDo(err2);
        lively.identity.walletBridge.getAddress(function(err3, fromAddress) {
          if (err3) return thenDo(err3);
          Promise.all([
            client.getTransactionCount({ address: fromAddress }),
            client.getGasPrice(),
            client.getChainId()
          ]).then(function(results) {
            var nonce = results[0], gasPrice = results[1], chainId = results[2];
            var unsignedTx = {
              to: options.to,
              value: libs.parseEther(String(options.amountEth)),
              nonce: nonce,
              gas: 21000n,
              maxFeePerGas: gasPrice * 2n,
              maxPriorityFeePerGas: gasPrice,
              chainId: chainId
            };
            lively.identity.walletBridge.signTransaction(unsignedTx, function(err4, signedRawTx) {
              if (err4) return thenDo(err4);
              thenDo(null, { signedRawTx: signedRawTx, unsignedTx: unsignedTx });
            });
          }).catch(function(e) { thenDo(e); });
        });
      });
    });
  }

},

// ─── deposit (§6.2, §6.6, §15 step 7) ────────────────────────────────────
// The first real broadcast capability in this codebase — see this file's
// own header. No ZK proof is involved (§6.1/§6.2: deposit only needs a
// Poseidon hash of nullifier+secret, computed by the vault's
// deriveDepositSecrets); the prover Worker from step 6 is never touched
// here. ABIs (IEntrypointABI/IPrivacyPoolABI) come straight from the
// installed SDK's own source via privacy-pool-client-libs.js — see that
// build script's header for why a direct import wasn't possible.
//
// ETH_ASSET_PLACEHOLDER is the EIP-7528 native-asset address
// (0xEeee...EEeE) — confirmed live this session as the real key
// Entrypoint.assetConfig uses for the ETH pool (the zero address returns
// nothing; this placeholder returns the known ETH pool + real config:
// minimumDepositAmount 0.01 ETH, vettingFeeBPS 50, maxRelayFeeBPS 1000).

'deposit', {

  ETH_ASSET_PLACEHOLDER: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',

  // Thin wei-conversion helper so the UI layer never needs to load
  // privacy-pool-client-libs.js itself just to compare an entered amount
  // against a minimumDepositAmount before enabling Confirm.
  parseEthAmount: function(amountEth, thenDo) {
    this.withClientLibs(function(err, libs) {
      if (err) return thenDo(err);
      try { thenDo(null, libs.parseEther(String(amountEth))); }
      catch (e) { thenDo(e); }
    });
  },

  _entrypointAddress: function() {
    return lively.Config && lively.Config.get('privacyPoolEntrypointAddress');
  },

  _ethPoolAddress: function() {
    return lively.Config && lively.Config.get('privacyPoolEthPoolAddress');
  },

  // { pool, minimumDepositAmount, vettingFeeBPS, maxRelayFeeBPS } — queried
  // at runtime rather than hardcoded, per this doc's own established
  // preference (§6.2: "query Entrypoint.assetConfig(asset) at runtime
  // rather than hardcoding any figure").
  getAssetConfig: function(assetAddress, thenDo) {
    var self = this;
    var entrypoint = this._entrypointAddress();
    if (!entrypoint) return thenDo(new Error('PrivacyPoolClient: privacyPoolEntrypointAddress is not configured'));
    this._withPublicClient(function(err, client) {
      if (err) return thenDo(err);
      self.withClientLibs(function(err2, libs) {
        if (err2) return thenDo(err2);
        client.readContract({
          address: entrypoint,
          abi: libs.IEntrypointABI,
          functionName: 'assetConfig',
          args: [assetAddress]
        }).then(function(result) {
          thenDo(null, {
            pool: result[0],
            minimumDepositAmount: result[1],
            vettingFeeBPS: result[2],
            maxRelayFeeBPS: result[3]
          });
        }).catch(function(e) { thenDo(e); });
      });
    });
  },

  // Queried once per page load and cached — SCOPE() is a fixed per-pool
  // constant, but still read live rather than hardcoded (§6.2's own
  // preference; also the exact value this session independently confirmed
  // against privacyPoolEthPoolAddress: SCOPE() ==
  // 4916574638117198869413701114161172350986437430914933850166949084132905299523).
  getEthPoolScope: function(thenDo) {
    var self = this;
    if (this._ethPoolScope !== undefined) return thenDo(null, this._ethPoolScope);
    var poolAddress = this._ethPoolAddress();
    if (!poolAddress) return thenDo(new Error('PrivacyPoolClient: privacyPoolEthPoolAddress is not configured'));
    this._withPublicClient(function(err, client) {
      if (err) return thenDo(err);
      self.withClientLibs(function(err2, libs) {
        if (err2) return thenDo(err2);
        client.readContract({
          address: poolAddress,
          abi: libs.IPrivacyPoolABI,
          functionName: 'SCOPE'
        }).then(function(scope) {
          self._ethPoolScope = scope;
          thenDo(null, scope);
        }).catch(function(e) { thenDo(e); });
      });
    });
  },

  // ── local (main-world, public-data-only) next-deposit-index tracking ──
  // §6.2 step 4's own framing: "main world holds nothing secret... cached
  // locally... fully reconstructable from chain events plus the recovery
  // phrase." generateDepositSecrets(keys, scope, index) is deterministic,
  // so "which index is next" is the one piece of bookkeeping that must
  // never regress once used for a real deposit — reusing an index for two
  // different real deposits would give them the identical nullifier/
  // secret/precommitment, an unrecoverable mixup, not just a cosmetic bug.
  // Reserved (persisted) the instant deriveDepositSecrets succeeds, before
  // signing or broadcasting, so a retried/duplicated attempt can't reuse
  // one — skipping an index on a cancelled attempt is harmless, reusing
  // one is not.
  //
  // KNOWN LIMITATION, deliberately not solved here: this counter lives in
  // this browser's localStorage only. A fresh install of this wallet (same
  // recovery phrase, different device/browser) starts back at index 0 and
  // WILL eventually collide with indices already used for real deposits
  // made elsewhere. Fixing this needs full chain-based account
  // reconstruction (WalletSpec.md §10), which is not a numbered
  // implementation step yet — flagging it here rather than pretending this
  // local counter is a complete solution.
  _depositIndexKey: function(chainId, scope, address) {
    return 'lively.wallet.depositIndex.' + chainId + '.' + scope.toString() + '.' + address.toLowerCase();
  },

  _reserveNextDepositIndex: function(chainId, scope, address) {
    var key = this._depositIndexKey(chainId, scope, address);
    var raw = window.localStorage.getItem(key);
    var index = raw ? BigInt(raw) : 0n;
    window.localStorage.setItem(key, (index + 1n).toString());
    return index;
  },

  // Builds, validates (simulateContract — no key needed, account is an
  // address), and signs (via the vault) a real Entrypoint.deposit(...)
  // transaction. Never broadcasts by itself — see broadcastDeposit.
  // options: { amountEth }. Calls thenDo(null, { signedRawTx, unsignedTx,
  // precommitment, scope, index }).
  buildAndSignDeposit: function(options, thenDo) {
    var self = this;
    var entrypoint = this._entrypointAddress();
    if (!entrypoint) return thenDo(new Error('PrivacyPoolClient: privacyPoolEntrypointAddress is not configured'));
    this._withPublicClient(function(err, client) {
      if (err) return thenDo(err);
      self.withClientLibs(function(err2, libs) {
        if (err2) return thenDo(err2);
        lively.identity.walletBridge.getAddress(function(err3, fromAddress) {
          if (err3) return thenDo(err3);
          self.getEthPoolScope(function(err4, scope) {
            if (err4) return thenDo(err4);
            client.getChainId().then(function(chainId) {
              var index = self._reserveNextDepositIndex(chainId, scope, fromAddress);
              lively.identity.walletBridge.deriveDepositSecrets(scope, index, function(err5, res) {
                if (err5) return thenDo(err5);
                var precommitment = res.precommitment;
                var value = libs.parseEther(String(options.amountEth));
                var data = libs.encodeFunctionData({
                  abi: libs.IEntrypointABI,
                  functionName: 'deposit',
                  args: [precommitment]
                });
                // Validates first (decoded revert reason on failure — e.g.
                // below minimum deposit — is far more useful than a bare
                // gas-estimation error), then gets the real gas figure as
                // its own explicit step: simulateContract's returned
                // request does NOT populate .gas in this viem version —
                // confirmed live (returned undefined even for a
                // fully-funded account) rather than assumed.
                client.simulateContract({
                  address: entrypoint,
                  abi: libs.IEntrypointABI,
                  functionName: 'deposit',
                  args: [precommitment],
                  value: value,
                  account: fromAddress
                }).then(function() {
                  return client.estimateContractGas({
                    address: entrypoint,
                    abi: libs.IEntrypointABI,
                    functionName: 'deposit',
                    args: [precommitment],
                    value: value,
                    account: fromAddress
                  });
                }).then(function(gas) {
                  Promise.all([
                    client.getTransactionCount({ address: fromAddress }),
                    client.getGasPrice()
                  ]).then(function(results) {
                    var nonce = results[0], gasPrice = results[1];
                    var unsignedTx = {
                      to: entrypoint,
                      value: value,
                      data: data,
                      nonce: nonce,
                      gas: gas,
                      maxFeePerGas: gasPrice * 2n,
                      maxPriorityFeePerGas: gasPrice,
                      chainId: chainId
                    };
                    lively.identity.walletBridge.signTransaction(unsignedTx, function(err6, signedRawTx) {
                      if (err6) return thenDo(err6);
                      thenDo(null, {
                        signedRawTx: signedRawTx,
                        unsignedTx: unsignedTx,
                        precommitment: precommitment,
                        scope: scope,
                        index: index
                      });
                    });
                  }).catch(function(e) { thenDo(e); });
                }).catch(function(e) { thenDo(e); });
              });
            }).catch(function(e) { thenDo(e); });
          });
        });
      });
    });
  },

  // The one new hard capability this step adds — everything above this
  // point only ever builds and signs. Deliberately its own separate call,
  // never invoked automatically by buildAndSignDeposit, so a caller must
  // take an explicit further action to actually move funds.
  broadcastDeposit: function(signedRawTx, thenDo) {
    this._withPublicClient(function(err, client) {
      if (err) return thenDo(err);
      client.sendRawTransaction({ serializedTransaction: signedRawTx })
        .then(function(txHash) { thenDo(null, txHash); })
        .catch(function(e) { thenDo(e); });
    });
  },

  waitForDepositReceipt: function(txHash, thenDo) {
    this._withPublicClient(function(err, client) {
      if (err) return thenDo(err);
      client.waitForTransactionReceipt({ hash: txHash })
        .then(function(receipt) { thenDo(null, receipt); })
        .catch(function(e) { thenDo(e); });
    });
  },

  // Decodes the PrivacyPool-LEVEL Deposited event specifically (indexed
  // _depositor, then commitment/label/value/precommitmentHash) — NOT the
  // differently-shaped Entrypoint-level Deposited event that's also
  // emitted in the same transaction (indexed _depositor/_pool, then
  // commitment/amount only, no label). Conflating the two was flagged as a
  // real risk in WalletSpec.md §6.2 itself; this only ever looks at logs
  // matching the pool address, and only decodes them against
  // IPrivacyPoolABI, never IEntrypointABI, to avoid it structurally.
  parseDepositedEvent: function(receipt, thenDo) {
    var self = this;
    this.withClientLibs(function(err, libs) {
      if (err) return thenDo(err);
      var poolAddress = (self._ethPoolAddress() || '').toLowerCase();
      for (var i = 0; i < receipt.logs.length; i++) {
        var log = receipt.logs[i];
        if (log.address.toLowerCase() !== poolAddress) continue;
        try {
          var decoded = libs.decodeEventLog({
            abi: libs.IPrivacyPoolABI,
            eventName: 'Deposited',
            data: log.data,
            topics: log.topics
          });
          return thenDo(null, {
            depositor: decoded.args._depositor,
            commitment: decoded.args._commitment,
            label: decoded.args._label,
            value: decoded.args._value,
            precommitmentHash: decoded.args._precommitmentHash
          });
        } catch (e) { /* not this log's event — keep scanning */ }
      }
      thenDo(new Error('parseDepositedEvent: no PrivacyPool Deposited event found in this receipt'));
    });
  },

  // Small public, non-secret local cache (§6.2 step 4: "a convenience
  // index, not a secret; fully reconstructable from chain events plus the
  // recovery phrase") so the dashboard can show "your deposits" without a
  // full chain rescan. Not a substitute for §10's real account
  // reconstruction — just enough to make the UI useful today.
  _depositHistoryKey: function(chainId, scope, address) {
    return 'lively.wallet.depositHistory.' + chainId + '.' + scope.toString() + '.' + address.toLowerCase();
  },

  recordLocalDeposit: function(chainId, scope, address, entry) {
    var key = this._depositHistoryKey(chainId, scope, address);
    var raw = window.localStorage.getItem(key);
    var list = raw ? JSON.parse(raw) : [];
    list.push({
      index: entry.index.toString(),
      commitment: entry.commitment.toString(),
      label: entry.label.toString(),
      value: entry.value.toString(),
      txHash: entry.txHash
    });
    window.localStorage.setItem(key, JSON.stringify(list));
  },

  getLocalDeposits: function(chainId, scope, address) {
    var raw = window.localStorage.getItem(this._depositHistoryKey(chainId, scope, address));
    return raw ? JSON.parse(raw) : [];
  }

},

// ─── ASP (§6.3, §15 step 5 — RESOLVED: real production API) ─────────────
// Real host (api.0xbow.io), live-verified directly from a browser at
// Lively's own origin — CORS-open, including preflight for the custom
// X-Pool-Scope header every call below needs (that preflight was the
// actual open risk; it passed). Exact contract, confirmed against the
// real source (not guessed): GET {base}/{chainId}/public/<path>, the pool
// identified via an X-Pool-Scope header (decimal scope string) rather
// than a path/query param. No auth on any of these — safe to call from
// the main world, never the vault. core/servers/ASPStubServer.js remains
// available as an offline/no-network fallback (point
// privacyPoolAspEndpoint at it instead) but is no longer the default.
//
// A separate Brevis-provider ASP path exists (different host, different
// shape: GET /leaves, /root, POST /all_deposits) for any pool configured
// provider:'brevis' — not implemented here since the default 0xbow-hosted
// pools (what this spec targets, §0) don't use it.

'asp', {

  _aspEndpoint: function() {
    return lively.Config && lively.Config.get('privacyPoolAspEndpoint');
  },

  _aspFetch: function(chainId, scope, path, thenDo) {
    var base = this._aspEndpoint();
    if (!base) return thenDo(new Error('PrivacyPoolClient: privacyPoolAspEndpoint is not configured'));
    fetch(base + '/' + chainId + '/public/' + path, {
      headers: { 'X-Pool-Scope': String(scope) }
    }).then(function(res) {
      if (!res.ok) throw new Error('ASP request failed: ' + res.status);
      return res.json();
    }).then(function(body) { thenDo(null, body); })
      .catch(function(e) { thenDo(e); });
  },

  // Pool overview: deposit/pool USD totals, recentEvents[], growth24h.
  getPoolInfo: function(chainId, scope, thenDo) {
    this._aspFetch(chainId, scope, 'pool-info', thenDo);
  },

  // Returns thenDo(null, { mtRoot, createdAt, onchainMtRoot }) — mtRoot is
  // the ASP's own published root; onchainMtRoot is what's actually live on
  // the Entrypoint (§6.4: a withdrawal proof must cite the latter exactly).
  getAspRoots: function(chainId, scope, thenDo) {
    this._aspFetch(chainId, scope, 'mt-roots', thenDo);
  },

  // Returns thenDo(null, { aspLeaves: string[], stateTreeLeaves: string[] }).
  getAspLeaves: function(chainId, scope, thenDo) {
    this._aspFetch(chainId, scope, 'mt-leaves', thenDo);
  },

  // options: { page, perPage } (perPage defaults to 12 server-side). page
  // is REQUIRED by the real API despite reading as optional from its own
  // description — confirmed live: omitting it fails with "Validation
  // failed (numeric string is expected)" — so this always sends it.
  getAspEvents: function(chainId, scope, options, thenDo) {
    options = options || {};
    var qs = ['page=' + encodeURIComponent(options.page || 1)];
    if (options.perPage) qs.push('perPage=' + encodeURIComponent(options.perPage));
    var path = 'events' + (qs.length ? '?' + qs.join('&') : '');
    this._aspFetch(chainId, scope, path, thenDo);
  },

  // labels: array of label strings. Per-label lookup for spendable-
  // commitment reconstruction (§10) — returns each matching deposit's
  // { type, amount, address, label, txHash, timestamp, precommitmentHash,
  // reviewStatus }. What reviewStatus values actually mean (which count as
  // "associated" for withdrawal purposes) isn't confirmed yet — left for
  // whichever later step first needs to interpret it with real data in
  // hand, rather than guessed here.
  getDepositsByLabel: function(chainId, scope, labels, thenDo) {
    var base = this._aspEndpoint();
    if (!base) return thenDo(new Error('PrivacyPoolClient: privacyPoolAspEndpoint is not configured'));
    fetch(base + '/' + chainId + '/public/deposits-by-label', {
      headers: { 'X-Pool-Scope': String(scope), 'X-Labels': labels.join(',') }
    }).then(function(res) {
      if (!res.ok) throw new Error('ASP request failed: ' + res.status);
      return res.json();
    }).then(function(body) { thenDo(null, body); })
      .catch(function(e) { thenDo(e); });
  }

},

// ─── relayer (§6.5, §15 step 5 — local stub only) ────────────────────────
// Exact confirmed real contract (unlike ASP above) — only the base URL is
// a stub; swapping to a real self-hosted or third-party relayer later is
// purely a config change. getRelayerRequest is deliberately NOT wired
// here: RelayerStubServer.js's /relayer/request always errors by design
// (see that file's header), and there's nothing this client needs to do
// differently for that beyond surfacing whatever error comes back —
// callers use fetch directly against the confirmed contract if/when a
// real relayer exists, rather than this file pretending the stub can
// meaningfully "request" anything.

'relayer', {

  _relayerEndpoint: function() {
    return lively.Config && lively.Config.get('privacyPoolRelayerEndpoint');
  },

  getRelayerQuote: function(params, thenDo) {
    var base = this._relayerEndpoint();
    if (!base) return thenDo(new Error('PrivacyPoolClient: privacyPoolRelayerEndpoint is not configured'));
    fetch(base + '/relayer/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    }).then(function(res) { return res.json(); })
      .then(function(body) { thenDo(null, body); })
      .catch(function(e) { thenDo(e); });
  },

  getRelayerDetails: function(chainId, assetAddress, thenDo) {
    var base = this._relayerEndpoint();
    if (!base) return thenDo(new Error('PrivacyPoolClient: privacyPoolRelayerEndpoint is not configured'));
    fetch(base + '/relayer/details?chainId=' + encodeURIComponent(chainId) + '&assetAddress=' + encodeURIComponent(assetAddress))
      .then(function(res) { return res.json(); })
      .then(function(body) { thenDo(null, body); })
      .catch(function(e) { thenDo(e); });
  }

},

// ─── withdrawal (§6.4, §6.4.1, §6.6, §15 step 8) ─────────────────────────
// Direct-submit only, per this step's own scope — the recipient submits
// their own withdrawal transaction and pays their own gas, so
// _withdrawal.processooor IS the recipient (confirmed directly from
// PrivacyPool.sol's source: withdraw() pushes the full withdrawnValue to
// _withdrawal.processooor and never reads _withdrawal.data at all — data
// only feeds calculateContext's hash, it isn't decoded on-chain). Relayed
// submission (processooor = a relayer's address, data carrying whatever
// that relayer's own off-chain logic needs to route the recipient/fee
// split) is a later addition, once a real relayer deployment exists (§14
// item 4) — RelayerStubServer.js's /relayer/request errors by design, so
// there's nothing to route through yet.
//
// V1 scope is full-value withdrawal only (no partial-withdrawal chains):
// a spendable commitment is always withdrawn in one shot, so
// generateWithdrawalSecrets' own index (§6.1) is always 0 for a given
// label — unlike deposit's index, which genuinely needs a persistent
// per-scope counter (one scope, many deposits), a label is only ever
// spent once in this scope, so there's nothing to collide with and no
// counter to maintain here.

'withdrawal', {

  // Wraps the real SDK's generateMerkleProof (Poseidon-based — never
  // reimplemented, §5.7/§6.4.1) plus the confirmed NaN workaround
  // (useWithdraw.ts's own fix, ported verbatim): an ASP-tree proof's index
  // can come back NaN from the underlying LeanIMT implementation in some
  // cases. Applied to both trees defensively — harmless when the bug
  // doesn't fire, since Object.is(realIndex, NaN) is always false.
  // leaves/leaf: bigint[] / bigint. Returns thenDo(null, {root, leaf, index, siblings}).
  getMerkleProof: function(leaves, leaf, thenDo) {
    this.withClientLibs(function(err, libs) {
      if (err) return thenDo(err);
      try {
        var proof = libs.generateMerkleProof(leaves, leaf);
        if (Object.is(proof.index, NaN)) proof.index = 0;
        thenDo(null, proof);
      } catch (e) { thenDo(e); }
    });
  },

  // §6.4.1: the ASP's own /mt-leaves response is the single source for
  // BOTH trees' full leaf sets — there's no separate per-leaf inclusion-
  // proof endpoint for either one. Builds both Merkle proofs and both tree
  // depths entirely client-side from that one fetch; the roots that
  // actually matter are the LOCALLY recomputed proof.root values, not the
  // /mt-roots response's mtRoot field (§6.4.1's own explicit distinction).
  // Tree depth is read as siblings.length, NOT computed from leaf count —
  // generateMerkleProof always pads siblings to 32 (matching the circuit's
  // fixed maxTreeDepth), so this is always 32n regardless of the real leaf
  // count; confirmed against this project's own already-verified
  // scripts/wallet-vault-prover-isolation-test.js (§15 step 6), which uses
  // exactly this same siblings.length pattern for a proof that really
  // verifies — matched here rather than independently deriving a "real"
  // tree depth from leaf count, which turned out to not be what the
  // circuit actually wants.
  //
  // options: { chainId, scope, commitment: { commitment, label, value },
  // recipient }. Returns thenDo(null, { stateMerkleProof, aspMerkleProof,
  // stateRoot, stateTreeDepth, aspRoot, aspTreeDepth, context,
  // withdrawalAmount }) — everything §3.4's corrected proveWithdrawal
  // params table needs, still all public data.
  buildWithdrawalProofInputs: function(options, thenDo) {
    var self = this;
    this.getAspLeaves(options.chainId, options.scope, function(err, leaves) {
      if (err) return thenDo(err);
      try {
        var stateLeaves = leaves.stateTreeLeaves.map(BigInt);
        var aspLeaves = leaves.aspLeaves.map(BigInt);
        var commitmentHash = BigInt(options.commitment.commitment);
        var label = BigInt(options.commitment.label);

        self.getMerkleProof(stateLeaves, commitmentHash, function(errS, stateMerkleProof) {
          if (errS) return thenDo(new Error('buildWithdrawalProofInputs: commitment not found in state tree — ' + errS.message));
          self.getMerkleProof(aspLeaves, label, function(errA, aspMerkleProof) {
            if (errA) return thenDo(new Error('buildWithdrawalProofInputs: label not found in ASP tree (not yet associated?) — ' + errA.message));
            var withdrawal = { processooor: options.recipient, data: '0x' };
            lively.identity.walletCrypto.calculateContext(withdrawal, options.scope, function(errC, contextHex) {
              if (errC) return thenDo(errC);
              thenDo(null, {
                stateMerkleProof: stateMerkleProof,
                aspMerkleProof: aspMerkleProof,
                stateRoot: stateMerkleProof.root,
                stateTreeDepth: BigInt(stateMerkleProof.siblings.length),
                aspRoot: aspMerkleProof.root,
                aspTreeDepth: BigInt(aspMerkleProof.siblings.length),
                context: BigInt(contextHex),
                withdrawalAmount: BigInt(options.commitment.value)
              });
            });
          });
        });
      } catch (e) { thenDo(e); }
    });
  },

  // §6.6: ported verbatim from contracts.service.ts's private formatProof —
  // a pure transform over PUBLIC proof bytes (a ZK proof reveals nothing
  // about its private witness by construction, §3.4's table), so it's safe
  // to run here in the main world rather than the vault. The pB inner-pair
  // swap is the easy-to-get-silently-wrong detail §6.6 flags:
  // [pi_b[0][1], pi_b[0][0]], NOT the natural-looking
  // [pi_b[0][0], pi_b[0][1]] — confirmed against both contracts.service.ts
  // and useExit.ts's independent reimplementation of the same swap, which
  // agree exactly. proof: { proof: {pi_a, pi_b, pi_c}, publicSignals }, the
  // exact shape both the vault's proveWithdrawal AND proveCommitment RPC
  // calls resolve with — contracts.service.ts uses this one transform for
  // both WithdrawalProof and CommitmentProof (§15 step 9's own 'ragequit'
  // section below reuses it directly rather than duplicating it).
  formatProof: function(proof) {
    var toHex = lively.identity.walletCrypto.bigintToHex;
    return {
      pA: [toHex(proof.proof.pi_a[0]), toHex(proof.proof.pi_a[1])],
      pB: [
        [toHex(proof.proof.pi_b[0][1]), toHex(proof.proof.pi_b[0][0])],
        [toHex(proof.proof.pi_b[1][1]), toHex(proof.proof.pi_b[1][0])]
      ],
      pC: [toHex(proof.proof.pi_c[0]), toHex(proof.proof.pi_c[1])],
      pubSignals: proof.publicSignals.map(toHex)
    };
  },

  // Full end-to-end: builds proof inputs, runs the vault's proveWithdrawal
  // (real ZK proving, §5.6 — onProgress fires 'loading_circuits' /
  // 'generating_proof' / 'verifying_proof'), formats the result, then
  // validates (simulateContract) and signs (via the vault) the real
  // PrivacyPool.withdraw(...) call. Direct submission goes straight to the
  // pool contract itself, NOT the Entrypoint (confirmed from source:
  // deposits route through the Entrypoint for vetting-fee collection;
  // withdraw() is called directly on the PrivacyPool). Never broadcasts by
  // itself — see broadcastWithdrawal, matching buildAndSignDeposit's own
  // "build+sign here, broadcast is a separate explicit call" shape.
  //
  // options: { commitment: { commitment, label, value, index } (from
  // getLocalDeposits/getDepositsByLabel), recipient }. Calls
  // thenDo(null, { signedRawTx, unsignedTx, proof, publicSignals }).
  buildAndSignWithdrawal: function(options, onProgress, thenDo) {
    var self = this;
    var poolAddress = this._ethPoolAddress();
    if (!poolAddress) return thenDo(new Error('PrivacyPoolClient: privacyPoolEthPoolAddress is not configured'));
    this._withPublicClient(function(err, client) {
      if (err) return thenDo(err);
      self.withClientLibs(function(err2, libs) {
        if (err2) return thenDo(err2);
        self.getEthPoolScope(function(err3, scope) {
          if (err3) return thenDo(err3);
          client.getChainId().then(function(chainId) {
            self.buildWithdrawalProofInputs({
              chainId: chainId,
              scope: scope,
              commitment: options.commitment,
              recipient: options.recipient
            }, function(err4, inputs) {
              if (err4) return thenDo(err4);
              var proveParams = {
                scope: scope,
                index: BigInt(options.commitment.index),
                label: BigInt(options.commitment.label),
                value: BigInt(options.commitment.value),
                withdrawalIndex: 0n,
                input: {
                  context: inputs.context,
                  withdrawalAmount: inputs.withdrawalAmount,
                  stateMerkleProof: inputs.stateMerkleProof,
                  aspMerkleProof: inputs.aspMerkleProof,
                  stateRoot: inputs.stateRoot,
                  stateTreeDepth: inputs.stateTreeDepth,
                  aspRoot: inputs.aspRoot,
                  aspTreeDepth: inputs.aspTreeDepth
                }
              };
              lively.identity.walletBridge.proveWithdrawal(proveParams, onProgress, function(err5, proofResult) {
                if (err5) return thenDo(err5);
                var formattedProof = self.formatProof(proofResult);
                var withdrawal = { processooor: options.recipient, data: '0x' };
                var data = libs.encodeFunctionData({
                  abi: libs.IPrivacyPoolABI,
                  functionName: 'withdraw',
                  args: [withdrawal, formattedProof]
                });
                client.simulateContract({
                  address: poolAddress,
                  abi: libs.IPrivacyPoolABI,
                  functionName: 'withdraw',
                  args: [withdrawal, formattedProof],
                  account: options.recipient
                }).then(function() {
                  return client.estimateContractGas({
                    address: poolAddress,
                    abi: libs.IPrivacyPoolABI,
                    functionName: 'withdraw',
                    args: [withdrawal, formattedProof],
                    account: options.recipient
                  });
                }).then(function(gas) {
                  Promise.all([
                    client.getTransactionCount({ address: options.recipient }),
                    client.getGasPrice()
                  ]).then(function(results) {
                    var nonce = results[0], gasPrice = results[1];
                    var unsignedTx = {
                      to: poolAddress,
                      value: 0n,
                      data: data,
                      nonce: nonce,
                      gas: gas,
                      maxFeePerGas: gasPrice * 2n,
                      maxPriorityFeePerGas: gasPrice,
                      chainId: chainId
                    };
                    lively.identity.walletBridge.signTransaction(unsignedTx, function(err6, signedRawTx) {
                      if (err6) return thenDo(err6);
                      thenDo(null, {
                        signedRawTx: signedRawTx,
                        unsignedTx: unsignedTx,
                        proof: formattedProof,
                        publicSignals: proofResult.publicSignals
                      });
                    });
                  }).catch(function(e) { thenDo(e); });
                }).catch(function(e) { thenDo(e); });
              });
            });
          }).catch(function(e) { thenDo(e); });
        });
      });
    });
  },

  // Same "separate explicit action" shape as broadcastDeposit.
  broadcastWithdrawal: function(signedRawTx, thenDo) {
    this._withPublicClient(function(err, client) {
      if (err) return thenDo(err);
      client.sendRawTransaction({ serializedTransaction: signedRawTx })
        .then(function(txHash) { thenDo(null, txHash); })
        .catch(function(e) { thenDo(e); });
    });
  },

  waitForWithdrawalReceipt: function(txHash, thenDo) {
    this._withPublicClient(function(err, client) {
      if (err) return thenDo(err);
      client.waitForTransactionReceipt({ hash: txHash })
        .then(function(receipt) { thenDo(null, receipt); })
        .catch(function(e) { thenDo(e); });
    });
  },

  // Decodes the Withdrawn event for the success screen (§9.4). Confirmed
  // exact signature from source: Withdrawn(address indexed _processooor,
  // uint256 _value, uint256 _spentNullifier, uint256 _newCommitment).
  parseWithdrawnEvent: function(receipt, thenDo) {
    var self = this;
    this.withClientLibs(function(err, libs) {
      if (err) return thenDo(err);
      var poolAddress = (self._ethPoolAddress() || '').toLowerCase();
      for (var i = 0; i < receipt.logs.length; i++) {
        var log = receipt.logs[i];
        if (log.address.toLowerCase() !== poolAddress) continue;
        try {
          var decoded = libs.decodeEventLog({
            abi: libs.IPrivacyPoolABI,
            eventName: 'Withdrawn',
            data: log.data,
            topics: log.topics
          });
          return thenDo(null, {
            processooor: decoded.args._processooor,
            value: decoded.args._value,
            spentNullifier: decoded.args._spentNullifier,
            newCommitment: decoded.args._newCommitment
          });
        } catch (e) { /* not this log's event — keep scanning */ }
      }
      thenDo(new Error('parseWithdrawnEvent: no Withdrawn event found in this receipt'));
    });
  }

},

// ─── ragequit / "Exit" (§6.6, §9.5, §15 step 9) ──────────────────────────
// §6.6's corrected finding, from reading PrivacyPool.sol's actual source
// directly (both current main and the v1.2.0 tag matching this project's
// installed SDK): ragequit() has NO on-chain timing gate — only an
// OnlyOriginalDepositor check (always satisfied here, since this wallet
// only ever calls from its own address) and an unspent-commitment check.
// The vendored ABI's NotYetRagequitteable error is never actually thrown by
// deployed contract code — dead/vestigial, not something this client needs
// to handle or work around. Reuses the SAME nullifier/secret the deposit
// itself used (generateDepositSecrets(scope, index) again inside the
// vault's proveCommitment, §6.1) — no change output, no Merkle proofs,
// since ragequit bypasses the ASP root check entirely by design.
// ragequit()'s on-chain call shape takes a SINGLE RagequitProof argument,
// unlike withdraw()'s (withdrawal, proof) pair.

'ragequit', {

  // Full end-to-end: runs the vault's proveCommitment (real ZK proving,
  // §5.6 — onProgress fires the same three phases as proveWithdrawal),
  // formats the result (formatProof, shared with withdrawal, §6.6), then
  // validates (simulateContract) and signs (via the vault) the real
  // PrivacyPool.ragequit(proof) call. Never broadcasts by itself — see
  // broadcastRagequit, matching the deposit/withdrawal shape.
  //
  // options: { commitment: { label, value, index } (same shape
  // getLocalDeposits/getDepositsByLabel already produce) }. Calls
  // thenDo(null, { signedRawTx, unsignedTx, proof, publicSignals }).
  buildAndSignRagequit: function(options, onProgress, thenDo) {
    var self = this;
    var poolAddress = this._ethPoolAddress();
    if (!poolAddress) return thenDo(new Error('PrivacyPoolClient: privacyPoolEthPoolAddress is not configured'));
    this._withPublicClient(function(err, client) {
      if (err) return thenDo(err);
      self.withClientLibs(function(err2, libs) {
        if (err2) return thenDo(err2);
        self.getEthPoolScope(function(err3, scope) {
          if (err3) return thenDo(err3);
          lively.identity.walletBridge.getAddress(function(err4, fromAddress) {
            if (err4) return thenDo(err4);
            client.getChainId().then(function(chainId) {
              var proveParams = {
                scope: scope,
                index: BigInt(options.commitment.index),
                label: BigInt(options.commitment.label),
                value: BigInt(options.commitment.value)
              };
              lively.identity.walletBridge.proveCommitment(proveParams, onProgress, function(err5, proofResult) {
                if (err5) return thenDo(err5);
                var formattedProof = self.formatProof(proofResult);
                var data = libs.encodeFunctionData({
                  abi: libs.IPrivacyPoolABI,
                  functionName: 'ragequit',
                  args: [formattedProof]
                });
                client.simulateContract({
                  address: poolAddress,
                  abi: libs.IPrivacyPoolABI,
                  functionName: 'ragequit',
                  args: [formattedProof],
                  account: fromAddress
                }).then(function() {
                  return client.estimateContractGas({
                    address: poolAddress,
                    abi: libs.IPrivacyPoolABI,
                    functionName: 'ragequit',
                    args: [formattedProof],
                    account: fromAddress
                  });
                }).then(function(gas) {
                  Promise.all([
                    client.getTransactionCount({ address: fromAddress }),
                    client.getGasPrice()
                  ]).then(function(results) {
                    var nonce = results[0], gasPrice = results[1];
                    var unsignedTx = {
                      to: poolAddress,
                      value: 0n,
                      data: data,
                      nonce: nonce,
                      gas: gas,
                      maxFeePerGas: gasPrice * 2n,
                      maxPriorityFeePerGas: gasPrice,
                      chainId: chainId
                    };
                    lively.identity.walletBridge.signTransaction(unsignedTx, function(err6, signedRawTx) {
                      if (err6) return thenDo(err6);
                      thenDo(null, {
                        signedRawTx: signedRawTx,
                        unsignedTx: unsignedTx,
                        proof: formattedProof,
                        publicSignals: proofResult.publicSignals
                      });
                    });
                  }).catch(function(e) { thenDo(e); });
                }).catch(function(e) { thenDo(e); });
              });
            }).catch(function(e) { thenDo(e); });
          });
        });
      });
    });
  },

  // Same "separate explicit action" shape as broadcastDeposit/broadcastWithdrawal.
  broadcastRagequit: function(signedRawTx, thenDo) {
    this._withPublicClient(function(err, client) {
      if (err) return thenDo(err);
      client.sendRawTransaction({ serializedTransaction: signedRawTx })
        .then(function(txHash) { thenDo(null, txHash); })
        .catch(function(e) { thenDo(e); });
    });
  },

  waitForRagequitReceipt: function(txHash, thenDo) {
    this._withPublicClient(function(err, client) {
      if (err) return thenDo(err);
      client.waitForTransactionReceipt({ hash: txHash })
        .then(function(receipt) { thenDo(null, receipt); })
        .catch(function(e) { thenDo(e); });
    });
  },

  // Decodes the Ragequit event for the success screen (§9.5). Confirmed
  // exact signature from source: Ragequit(address indexed _ragequitter,
  // uint256 _commitment, uint256 _label, uint256 _value).
  parseRagequitEvent: function(receipt, thenDo) {
    var self = this;
    this.withClientLibs(function(err, libs) {
      if (err) return thenDo(err);
      var poolAddress = (self._ethPoolAddress() || '').toLowerCase();
      for (var i = 0; i < receipt.logs.length; i++) {
        var log = receipt.logs[i];
        if (log.address.toLowerCase() !== poolAddress) continue;
        try {
          var decoded = libs.decodeEventLog({
            abi: libs.IPrivacyPoolABI,
            eventName: 'Ragequit',
            data: log.data,
            topics: log.topics
          });
          return thenDo(null, {
            ragequitter: decoded.args._ragequitter,
            commitment: decoded.args._commitment,
            label: decoded.args._label,
            value: decoded.args._value
          });
        } catch (e) { /* not this log's event — keep scanning */ }
      }
      thenDo(new Error('parseRagequitEvent: no Ragequit event found in this receipt'));
    });
  }

});

lively.identity.privacyPoolClient = new lively.identity.PrivacyPoolClient();

}); // end module('lively.identity.PrivacyPoolClient')
