/**
 * lively.commerce.Shop
 *
 * A makers-marketplace storefront: browsable/searchable product grid,
 * product detail with reviews, cart + prototype checkout, a "sell an item"
 * form and a seller dashboard. Ported from a Claude Design canvas mock
 * (`Shop Template.dc.html`, not real code) into a working morph.
 *
 * Self-rendering morph (raw DOM owned directly, not a BuildSpec submorph
 * tree) — same pattern as lively.media.RetroMediaConsole / lively.identity.
 * PostCardView: _buildChrome() builds a persistent DOM tree once, state
 * changes call targeted _render* methods that mutate the stored element
 * refs directly. Uses real native <input>/<textarea>/<select> elements
 * throughout (search box, sell form, sort dropdown) — verified live via
 * chrome-devtools-mcp that these work correctly nested inside a morph's own
 * shapeNode as of the Events.js onBackspacePressed fix shipped alongside
 * this file (see that file's history for the root cause).
 *
 * Listings/cart are in-memory/session-only by design — no backend index
 * exists for a cross-seller public catalog (only per-user object storage
 * does), and the original mock's own checkout copy already frames this as
 * a prototype. Identity is used for: who's shown as "signed in", whose
 * name new listings are attributed to, and gating the Sell/Dashboard
 * sections behind being signed in.
 *
 * Entry point:
 *   lively.commerce.Shop.open(optWorldPosition)
 */

module("lively.commerce.Shop")
  .requires()
  .toRun(function () {
    var LOW_STOCK_THRESHOLD = 3;
    var CURRENCY = "$";

    var CATEGORY_DEFS = [
      ["all", "All"],
      ["jewelry", "Jewelry"],
      ["electronics", "Electronics"],
      ["clothing", "Clothing"],
    ];

    var ICON_SEARCH =
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>';
    var ICON_CART =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round"><path d="M6 7h12l-1 13H7L6 7z"></path><path d="M9 7a3 3 0 0 1 6 0"></path></svg>';
    var ICON_PERSON =
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="10" r="6"></circle><circle cx="12" cy="10" r="1.5" fill="currentColor" stroke="none"></circle><line x1="12" y1="16" x2="12" y2="21"></line></svg>';
    var ICON_PHOTO =
      '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"></rect><circle cx="8.5" cy="9.5" r="1.75"></circle><path d="M21 15l-5-5-9 9"></path></svg>';

    function seedProducts() {
      return [
        { id: "p1", title: "Hand-Forged Copper Cuff Bracelet", description: "A single band of copper, hammered by hand and finished with a matte patina. Adjusts to fit most wrists.", category: "jewelry", condition: "new", price: 48, inventory: 3, sold: 127, sellerName: "Marigold & Co", sellerHandle: null, sellerLocation: "Asheville, NC", rating: 4.8, reviews: [
          { name: "Priya S.", verified: true, rating: 5, text: "Beautifully made and arrived faster than expected. Wear it every day." },
          { name: "Dana K.", verified: true, rating: 5, text: "Lovely finish, slightly heavier than I pictured but I like the weight." },
        ]},
        { id: "p2", title: "Vintage Sterling Drop Earrings", description: "Estate-sourced sterling silver drops with a small faceted glass bead. One-of-a-kind pair.", category: "jewelry", condition: "used", price: 36, inventory: 9, sold: 64, sellerName: "Marigold & Co", sellerHandle: null, sellerLocation: "Asheville, NC", rating: 4.6, reviews: [
          { name: "Elena R.", verified: true, rating: 5, text: "Exactly as pictured, great packaging too." },
          { name: "Michael T.", verified: false, rating: 4, text: "Nice earrings, wish they came with a small pouch." },
        ]},
        { id: "p3", title: "Refurbished Turntable — 1978", description: "Fully serviced belt-drive turntable, new stylus and rewired tonearm. Tested and ready to spin.", category: "electronics", condition: "used", price: 145, inventory: 2, sold: 41, sellerName: "Second Spin Audio", sellerHandle: null, sellerLocation: "Portland, OR", rating: 4.9, reviews: [
          { name: "Owen B.", verified: true, rating: 5, text: "Runs perfectly, sounds warmer than my old deck ever did." },
          { name: "Casey L.", verified: true, rating: 5, text: "Great communication from the seller and it was packed extremely well." },
        ]},
        { id: "p4", title: "Vintage Point-and-Shoot Camera", description: "Compact 35mm camera from the early 90s, tested with a fresh roll — light seals replaced.", category: "electronics", condition: "used", price: 62, inventory: 5, sold: 88, sellerName: "Second Spin Audio", sellerHandle: null, sellerLocation: "Portland, OR", rating: 4.4, reviews: [
          { name: "Nina F.", verified: true, rating: 4, text: "Works great, a couple small scuffs not shown in photos." },
          { name: "Alex P.", verified: true, rating: 5, text: "First roll came out perfectly. Love the compact size." },
        ]},
        { id: "p5", title: "Hand-Knit Wool Cardigan", description: "Chunky-knit cardigan in undyed wool, made to order in your choice of size.", category: "clothing", condition: "new", price: 74, inventory: 1, sold: 33, sellerName: "Thistle Workshop", sellerHandle: null, sellerLocation: "Missoula, MT", rating: 4.7, reviews: [
          { name: "Jordan W.", verified: true, rating: 5, text: "So cozy, the fit runs true to size." },
          { name: "Sam G.", verified: true, rating: 4, text: "Beautiful craftsmanship, took a couple weeks to arrive since it is made to order." },
        ]},
        { id: "p6", title: "Reworked Denim Jacket", description: "Thrifted denim jacket reworked with patchwork panels and new buttons. One size, oversized fit.", category: "clothing", condition: "used", price: 58, inventory: 6, sold: 52, sellerName: "Thistle Workshop", sellerHandle: null, sellerLocation: "Missoula, MT", rating: 4.5, reviews: [
          { name: "Taylor M.", verified: true, rating: 5, text: "Such a unique piece, gets compliments every time I wear it." },
          { name: "Riley H.", verified: false, rating: 4, text: "Great jacket, runs a little big as described." },
        ]},
      ];
    }

    // Ported from Shop Template/assets/organic-styles.css, every rule
    // scoped under .lk-shop-root so it can't leak into the rest of the
    // Lively world. Custom properties live on the wrapper instead of
    // :root for the same reason.
    var SHOP_CSS = "" +
      "@import url('https://fonts.googleapis.com/css2?family=Caprasimo:wght@400&family=Figtree:wght@400;600;700&display=swap');" +
      ".lk-shop-viewport {" +
      "  --color-bg:#fdf0f5; --color-surface:#fbe0ec; --color-text:#201e1d; --color-accent:#e8497e; --color-accent-2:#7cb342;" +
      "  --color-divider:color-mix(in srgb, #201e1d 16%, transparent);" +
      "  --color-neutral-100:#f9f4ed; --color-neutral-800:#474238;" +
      "  --color-accent-100:#ffeef4; --color-accent-800:#742040;" +
      "  --color-accent-600:#d13d70; --color-accent-700:#a52c58;" +
      "  --color-accent-2-100:#f3fbdc; --color-accent-2-800:#38510e;" +
      "  --font-heading:'Caprasimo', system-ui, sans-serif; --font-body:'Figtree', system-ui, sans-serif;" +
      "  --space-1:4px; --space-2:8px; --space-3:13px; --space-4:18px; --space-6:26px; --space-8:35px;" +
      "  --radius-sm:8px; --radius-md:16px; --radius-lg:28px;" +
      "  --shadow-sm:0 1px 2px color-mix(in srgb, #2e2b25 14%, transparent);" +
      "  --shadow-md:0 3px 10px color-mix(in srgb, #2e2b25 16%, transparent);" +
      "  --shadow-lg:0 12px 32px color-mix(in srgb, #2e2b25 22%, transparent);" +
      "  background:var(--color-bg); color:var(--color-text); font-family:var(--font-body);" +
      "  font-size:15px; line-height:1.55; height:100%; position:relative; overflow:hidden; box-sizing:border-box;" +
      "}" +
      // .lk-shop-root is the actual scrolling pane, nested inside the
      // fixed-height .lk-shop-viewport — the checkout dialog backdrop is a
      // sibling of .lk-shop-root (not a descendant), so its
      // position:absolute;inset:0 covers the morph's visible viewport
      // exactly regardless of scroll offset, instead of covering the full
      // (very tall) scrollable content and rendering off-screen above
      // whatever section is currently scrolled into view.
      ".lk-shop-root { height:100%; overflow-y:auto; position:relative; scrollbar-width:thin; scrollbar-color:var(--color-accent) var(--color-surface); }" +
      ".lk-shop-root::-webkit-scrollbar { width:10px; }" +
      ".lk-shop-root::-webkit-scrollbar-track { background:var(--color-surface); }" +
      ".lk-shop-root::-webkit-scrollbar-thumb { background:var(--color-accent); border-radius:999px; border:2px solid var(--color-surface); }" +
      ".lk-shop-root::-webkit-scrollbar-thumb:hover { background:var(--color-accent-600); }" +
      ".lk-shop-viewport, .lk-shop-viewport *, .lk-shop-viewport *::before, .lk-shop-viewport *::after { box-sizing:border-box; }" +
      ".lk-shop-viewport h1, .lk-shop-viewport h2, .lk-shop-viewport h3, .lk-shop-viewport h4, .lk-shop-viewport h5, .lk-shop-viewport h6 {" +
      "  font-family:var(--font-heading); font-weight:400; line-height:1.12; letter-spacing:-0.015em; margin:0 0 var(--space-2);" +
      "}" +
      ".lk-shop-viewport h1{font-size:38px} .lk-shop-viewport h2{font-size:28px} .lk-shop-viewport h3{font-size:22px}" +
      ".lk-shop-viewport h4{font-size:18px} .lk-shop-viewport h5{font-size:15px}" +
      ".lk-shop-viewport h6{font-size:12px; letter-spacing:0.08em; text-transform:uppercase}" +
      ".lk-shop-viewport p{margin:0 0 var(--space-3)}" +
      ".lk-shop-viewport a{color:var(--color-accent); text-underline-offset:3px; cursor:pointer}" +
      ".lk-shop-viewport .text-muted{color:color-mix(in srgb, var(--color-text) 55%, transparent)}" +
      ".lk-shop-viewport .hr{height:1px; border:0; margin:var(--space-4) 0; background:var(--color-divider)}" +
      ".lk-shop-viewport .btn{display:inline-flex; align-items:center; justify-content:center; gap:6px; cursor:pointer;" +
      "  font-family:var(--font-heading); font-weight:400; font-size:14px; color:var(--color-text); background:transparent;" +
      "  border:1px solid transparent; padding:var(--space-2) 16px; border-radius:999px;}" +
      ".lk-shop-viewport .btn:disabled{opacity:0.45; cursor:not-allowed}" +
      ".lk-shop-viewport .btn-primary{background:var(--color-accent); color:var(--color-bg)}" +
      ".lk-shop-viewport .btn-primary:hover{background:var(--color-accent-600)}" +
      ".lk-shop-viewport .btn-secondary{border-color:var(--color-divider)}" +
      ".lk-shop-viewport .btn-secondary:hover{background:color-mix(in srgb, var(--color-text) 7%, transparent)}" +
      ".lk-shop-viewport .btn-secondary.is-active{background:var(--color-accent); color:var(--color-bg); border-color:transparent}" +
      ".lk-shop-viewport .btn-ghost{color:var(--color-accent); padding-inline:4px; border:none; background:transparent}" +
      ".lk-shop-viewport .btn-ghost:hover{background:color-mix(in srgb, var(--color-accent) 10%, transparent)}" +
      ".lk-shop-viewport .btn-icon{width:32px; height:32px; padding:0}" +
      ".lk-shop-viewport .btn-block{width:100%; margin-top:var(--space-2)}" +
      ".lk-shop-viewport .field > label{display:block; font-size:12px; margin-bottom:6px; color:color-mix(in srgb, var(--color-text) 70%, transparent)}" +
      ".lk-shop-viewport .input{width:100%; min-height:36px; padding:6px 14px; font:inherit; font-size:14px; color:var(--color-text);" +
      "  background:var(--color-surface); border:1px solid var(--color-divider); border-radius:999px;}" +
      ".lk-shop-viewport .input:focus-visible{outline:2px solid var(--color-accent); outline-offset:0; border-color:var(--color-accent)}" +
      ".lk-shop-viewport textarea.input{min-height:90px; border-radius:var(--radius-md); resize:vertical}" +
      ".lk-shop-viewport .seg{display:inline-flex; overflow:hidden; border:1px solid var(--color-divider); border-radius:999px}" +
      ".lk-shop-viewport .seg-opt{display:inline-flex; align-items:center; gap:6px; padding:7px 14px; font-size:13px; cursor:pointer}" +
      ".lk-shop-viewport .seg-opt + .seg-opt{border-left:1px solid var(--color-divider)}" +
      ".lk-shop-viewport .seg-opt.is-checked{background:var(--color-accent); color:var(--color-bg)}" +
      ".lk-shop-viewport .seg-opt:not(.is-checked):hover{background:color-mix(in srgb, var(--color-text) 7%, transparent)}" +
      ".lk-shop-viewport .card{display:flex; flex-direction:column; gap:var(--space-2); padding:var(--space-3);" +
      "  border-radius:calc(var(--radius-lg) * 0.7); background:var(--color-surface);}" +
      ".lk-shop-viewport .card-kicker{font-size:10px; letter-spacing:0.1em; text-transform:uppercase; color:var(--color-accent)}" +
      ".lk-shop-viewport .card-title{font-family:var(--font-heading); font-weight:400; font-size:16px; line-height:1.2}" +
      ".lk-shop-viewport .card-body{margin:0; font-size:13px; opacity:0.8; flex:1}" +
      ".lk-shop-viewport .card-meta{display:flex; align-items:center; gap:6px; font-size:11px; color:color-mix(in srgb, var(--color-text) 50%, transparent)}" +
      ".lk-shop-viewport .elev-sm{box-shadow:var(--shadow-sm)} .lk-shop-viewport .elev-md{box-shadow:var(--shadow-md)} .lk-shop-viewport .elev-lg{box-shadow:var(--shadow-lg)}" +
      ".lk-shop-viewport .tag{display:inline-flex; align-items:center; font-size:11px; letter-spacing:0.02em; padding:3px 10px; border-radius:999px}" +
      ".lk-shop-viewport .tag-accent{background:var(--color-accent-100); color:var(--color-accent-800)}" +
      ".lk-shop-viewport .tag-accent-2{background:var(--color-accent-2-100); color:var(--color-accent-2-800)}" +
      ".lk-shop-viewport .tag-neutral{background:var(--color-neutral-100); color:var(--color-neutral-800)}" +
      ".lk-shop-viewport .tag-outline{border:1px solid var(--color-accent); color:var(--color-accent)}" +
      ".lk-shop-viewport .nav{display:flex; align-items:center; gap:var(--space-4); padding:var(--space-3) var(--space-4);" +
      "  position:sticky; top:0; z-index:10; background:var(--color-bg); border-bottom:1px solid var(--color-divider);}" +
      ".lk-shop-viewport .nav-brand{font-family:var(--font-heading); font-size:18px; margin-right:auto}" +
      ".lk-shop-viewport .nav a{color:inherit; text-decoration:none; font-size:14px}" +
      ".lk-shop-viewport .nav a:hover{color:var(--color-accent)}" +
      ".lk-shop-viewport .table{width:100%; border-collapse:collapse; font-size:14px}" +
      ".lk-shop-viewport .table th{text-align:left; font-size:11px; letter-spacing:0.08em; text-transform:uppercase;" +
      "  color:color-mix(in srgb, var(--color-text) 60%, transparent); padding:var(--space-2); border-bottom:1px solid var(--color-divider);}" +
      ".lk-shop-viewport .table td{padding:var(--space-2); border-bottom:1px solid color-mix(in srgb, var(--color-text) 8%, transparent)}" +
      ".lk-shop-viewport .dialog-backdrop{position:absolute; inset:0; display:grid; place-items:center; padding:var(--space-4);" +
      "  background:color-mix(in srgb, #2e2b25 50%, transparent); z-index:20;}" +
      ".lk-shop-viewport .dialog{width:min(420px, 100%); display:flex; flex-direction:column; gap:var(--space-3); padding:var(--space-4);" +
      "  border-radius:calc(var(--radius-lg) * 0.8); background:var(--color-surface); box-shadow:var(--shadow-lg);}" +
      ".lk-shop-viewport .dialog-title{font-family:var(--font-heading); font-weight:400; font-size:19px}" +
      ".lk-shop-viewport .dialog-body{font-size:14px; opacity:0.85}" +
      ".lk-shop-viewport .dialog-actions{display:flex; justify-content:flex-end; gap:var(--space-2); margin-top:var(--space-2)}" +
      ".lk-shop-viewport .shop-photo{display:flex; align-items:center; justify-content:center; color:color-mix(in srgb, var(--color-text) 35%, transparent);" +
      "  border-radius:var(--radius-md); overflow:hidden; filter:saturate(0.7);}" +
      ".lk-shop-viewport .shop-photo.cat-jewelry{background:linear-gradient(135deg,#ffd6e4,#ffb0cd)}" +
      ".lk-shop-viewport .shop-photo.cat-electronics{background:linear-gradient(135deg,#dcd3c4,#c0b6a5)}" +
      ".lk-shop-viewport .shop-photo.cat-clothing{background:linear-gradient(135deg,#e4f6b8,#cded89)}" +
      ".lk-shop-viewport .shop-photo.cat-default{background:linear-gradient(135deg,#eee7db,#dcd3c4)}" +
      ".lk-shop-viewport .shop-gate{padding:var(--space-6); text-align:center; background:var(--color-surface); border-radius:var(--radius-md); color:color-mix(in srgb, var(--color-text) 65%, transparent);}";

    var ShopClass = lively.morphic.Box.subclass(
      "lively.commerce.Shop",

      "serialization",
      {
        // _identityConnection holds a live lively.bindings Connection whose
        // source is the global lively.identity.did singleton — omitted
        // here too, or publishing this morph drags a broken reference to
        // that singleton into the serialized payload (confirmed live:
        // produced empty stub registry entries and "No object was
        // recorded" on deserialize, silently breaking every future copy
        // of an already-published Shop instance even though a freshly
        // constructed one via Shop.open() looks completely fine).
        doNotSerialize: ["state", "_dom", "_successTimer", "_identityConnection"],
      },

      "initialization",
      {
        DEFAULT_EXTENT: { w: 1180, h: 780 },

        initialize: function ($super, optExtent) {
          $super(optExtent || lively.rect(0, 0, 1180, 780));
          this.setFill(null);
          this.setBorderWidth(0);
        },

        _setup: function () {
          this._dom = {};
          this.state = {
            products: seedProducts(),
            cart: [],
            filterQuery: "",
            filterCategory: "all",
            sortBy: "featured",
            selectedProductId: "p1",
            detailQty: 1,
            listingSuccess: false,
            checkoutOpen: false,
            orderPlaced: false,
            lastOrderTotalLabel: "",
          };
          this._buildChrome();
          this._renderAll();
        },

        prepareForNewRenderContext: function ($super, renderCtx) {
          $super(renderCtx);
          this._setup();
        },

        remove: function ($super) {
          clearTimeout(this._successTimer);
          this._unbindIdentity();
          $super();
        },
      },

      "dom helpers",
      {
        _el: function (tag, className, parent) {
          var e = document.createElement(tag);
          if (className) e.className = className;
          if (parent) parent.appendChild(e);
          return e;
        },
        _text: function (tag, className, text, parent) {
          var e = this._el(tag, className, parent);
          e.textContent = text;
          return e;
        },
        _svgIcon: function (svgString, parent) {
          var wrap = document.createElement("span");
          wrap.style.display = "inline-flex";
          wrap.innerHTML = svgString; // always a hardcoded literal above, never user data
          if (parent) parent.appendChild(wrap);
          return wrap;
        },
        _clear: function (el) {
          while (el.firstChild) el.removeChild(el.firstChild);
        },
      },

      "identity",
      {
        _currentUser: function () {
          if (typeof lively === "undefined" || !lively.identity || !lively.identity.did) return null;
          return lively.identity.did.currentUser();
        },
        _bindIdentity: function () {
          if (typeof lively === "undefined" || !lively.bindings || !lively.identity || !lively.identity.did) return;
          var self = this;
          this._identityConnection = lively.bindings.connect(lively.identity.did, "identityChanged", self, "_onIdentityChanged");
          // DID.js's own boot-time restoreSession() (an async fetch) can
          // resolve and fire 'identityChanged' before this morph even
          // exists, so the connect() above alone can miss it — leaving the
          // nav stuck on "Not signed in" for an already-signed-in user.
          // restoreSession() is idempotent (just re-checks against the
          // server session), so calling it again here gets a definitive,
          // race-free answer instead of hoping a signal wasn't already missed.
          if (lively.identity.did.restoreSession) {
            lively.identity.did.restoreSession(function () { self._onIdentityChanged(); });
          }
        },
        _unbindIdentity: function () {
          if (this._identityConnection && this._identityConnection.disconnect) this._identityConnection.disconnect();
          this._identityConnection = null;
        },
        _onIdentityChanged: function () {
          this._renderIdentityUI();
          this._renderSell();
          this._renderDashboard();
        },
      },

      "chrome building",
      {
        _buildChrome: function () {
          if (!document.getElementById("shop-styles")) {
            var styleTag = document.createElement("style");
            styleTag.id = "shop-styles";
            styleTag.textContent = SHOP_CSS;
            document.head.appendChild(styleTag);
          }

          var shapeNode = this.renderContext().shapeNode;
          shapeNode.innerHTML = "";
          shapeNode.style.overflow = "hidden";

          var viewport = this._el("div", "lk-shop-viewport", shapeNode);
          this._dom.viewport = viewport;
          var root = this._el("div", "lk-shop-root", viewport);
          this._dom.root = root;

          this._buildNav(root);
          this._buildStorefront(root);
          this._buildProductDetail(root);
          this._buildCart(root);
          this._buildSellerBanner(root);
          this._buildSell(root);
          this._buildDashboard(root);
          this._buildCheckoutDialog(viewport);

          this._bindIdentity();
        },

        _buildNav: function (root) {
          var nav = this._el("nav", "nav", root);
          this._text("span", "nav-brand", "Shop", nav);

          var self = this;
          this._dom.sections = {};
          [
            ["storefront", "Storefront"],
            ["product", "Product"],
            ["cart", "Cart"],
          ].forEach(function (pair) {
            var a = self._text("a", null, pair[1], nav);
            a.addEventListener("click", function (e) {
              e.preventDefault();
              self._scrollToSection(pair[0]);
            });
          });

          var divider = this._el("span", null, nav);
          divider.style.cssText = "width:1px;height:18px;background:var(--color-divider)";

          var sellerLabel = this._text("span", null, "Seller", nav);
          sellerLabel.style.cssText = "font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:var(--color-accent-700);opacity:0.8";

          [
            ["sell", "Sell"],
            ["dashboard", "Dashboard"],
          ].forEach(function (pair) {
            var a = self._text("a", null, pair[1], nav);
            a.addEventListener("click", function (e) {
              e.preventDefault();
              self._scrollToSection(pair[0]);
            });
          });

          var cartBtn = this._el("a", "btn btn-secondary", nav);
          cartBtn.style.marginLeft = "var(--space-3)";
          this._svgIcon(ICON_CART, cartBtn);
          this._text("span", null, "Cart", cartBtn);
          this._dom.cartCountTag = this._text("span", "tag tag-accent", "0", cartBtn);
          cartBtn.addEventListener("click", function (e) {
            e.preventDefault();
            self._scrollToSection("cart");
          });

          this._dom.identityStatusEl = this._text("span", "text-muted", "", nav);
          this._dom.identityStatusEl.style.cssText = "font-size:12px;margin-left:var(--space-3);white-space:nowrap";
        },

        _buildStorefront: function (root) {
          var self = this;
          var section = this._el("section", null, root);
          section.id = "storefront";
          section.style.cssText = "max-width:1180px;margin:0 auto;padding:var(--space-8) var(--space-6)";
          this._dom.sections.storefront = section;

          this._text("h6", null, "Makers marketplace", section).style.color = "var(--color-accent-700)";
          this._text("h1", null, "Find something made with care", section);
          this._text("p", "text-muted", "Handmade jewelry, reclaimed electronics and reworked clothing from independent sellers.", section).style.maxWidth = "560px";

          var row = this._el("div", null, section);
          row.style.cssText = "display:flex;gap:var(--space-6);align-items:flex-start;margin-top:var(--space-6)";

          var aside = this._el("aside", null, row);
          aside.style.cssText = "width:210px;flex:none;display:flex;flex-direction:column;gap:var(--space-4)";

          var searchField = this._el("div", "field", aside);
          this._text("label", null, "Search", searchField);
          var searchWrap = this._el("div", null, searchField);
          searchWrap.style.cssText = "position:relative;display:flex;align-items:center";
          var searchIconWrap = this._svgIcon(ICON_SEARCH, searchWrap);
          searchIconWrap.style.cssText = "position:absolute;left:12px;opacity:0.5";
          var searchInput = this._el("input", "input", searchWrap);
          searchInput.type = "text";
          searchInput.placeholder = "Search listings";
          searchInput.style.paddingLeft = "32px";
          searchInput.addEventListener("input", function () {
            self.state.filterQuery = searchInput.value;
            self._renderStorefront();
          });
          this._dom.searchInput = searchInput;

          this._text("label", null, "Category", aside).style.cssText = "font-size:12px;margin-bottom:6px;color:var(--color-text)";
          var catBox = this._el("div", null, aside);
          catBox.style.cssText = "display:flex;flex-direction:column;gap:6px";
          this._dom.categoryBtns = {};
          CATEGORY_DEFS.forEach(function (pair) {
            var btn = this._text("button", "btn btn-secondary", pair[1], catBox);
            btn.style.justifyContent = "flex-start";
            btn.addEventListener("click", function () {
              self.state.filterCategory = pair[0];
              self._renderStorefront();
            });
            this._dom.categoryBtns[pair[0]] = btn;
          }, this);

          var sortField = this._el("div", "field", aside);
          this._text("label", null, "Sort by", sortField);
          var sortSelect = this._el("select", "input", sortField);
          [
            ["featured", "Featured"],
            ["price-low", "Price: low to high"],
            ["price-high", "Price: high to low"],
            ["best-selling", "Best selling"],
            ["top-rated", "Top rated"],
          ].forEach(function (pair) {
            var opt = document.createElement("option");
            opt.value = pair[0];
            opt.textContent = pair[1];
            sortSelect.appendChild(opt);
          });
          sortSelect.addEventListener("change", function () {
            self.state.sortBy = sortSelect.value;
            self._renderStorefront();
          });
          this._dom.sortSelect = sortSelect;

          var main = this._el("div", null, row);
          main.style.flex = "1";
          this._dom.resultsLabel = this._text("p", "text-muted", "", main);
          this._dom.resultsLabel.style.marginBottom = "var(--space-3)";
          var grid = this._el("div", null, main);
          grid.style.cssText = "display:grid;grid-template-columns:repeat(3,1fr);gap:var(--space-4)";
          this._dom.productGrid = grid;
        },

        _buildProductDetail: function (root) {
          var self = this;
          var section = this._el("section", null, root);
          section.id = "product";
          section.style.cssText = "max-width:1180px;margin:0 auto;padding:var(--space-8) var(--space-6);border-top:1px solid var(--color-divider)";
          this._dom.sections.product = section;

          this._text("h6", null, "Product detail", section).style.color = "var(--color-accent-700)";
          var grid = this._el("div", null, section);
          grid.style.cssText = "display:grid;grid-template-columns:400px 1fr;gap:var(--space-6);margin-top:var(--space-4)";

          var photo = this._el("div", "shop-photo", grid);
          photo.style.cssText += ";height:380px";
          this._svgIcon(ICON_PHOTO, photo);
          this._dom.detailPhoto = photo;

          var info = this._el("div", null, grid);
          info.style.cssText = "display:flex;flex-direction:column;gap:var(--space-3)";

          var tagsRow = this._el("div", null, info);
          this._dom.detailCategoryTag = this._text("span", "tag tag-accent-2", "", tagsRow);
          this._dom.detailConditionTag = this._text("span", "tag tag-outline", "", tagsRow);
          this._dom.detailConditionTag.style.marginLeft = "6px";

          this._dom.detailTitle = this._text("h1", null, "", info);
          this._dom.detailTitle.style.margin = "0";

          var sellerRow = this._el("div", "card-meta", info);
          sellerRow.style.fontSize = "13px";
          this._svgIcon(ICON_PERSON, sellerRow);
          this._dom.detailSellerLine = this._text("span", null, "", sellerRow);

          var ratingRow = this._el("div", null, info);
          ratingRow.style.cssText = "display:flex;align-items:center;gap:8px";
          this._dom.detailStars = this._text("span", null, "", ratingRow);
          this._dom.detailStars.style.cssText = "letter-spacing:1px;font-size:16px";
          this._dom.detailReviewCount = this._text("span", "text-muted", "", ratingRow);

          this._dom.detailPrice = this._text("h2", null, "", info);
          this._dom.detailPrice.style.margin = "0";

          var stockRow = this._el("div", null, info);
          stockRow.style.cssText = "display:flex;gap:8px";
          this._dom.detailStockTag = this._text("span", null, "", stockRow);
          this._dom.detailSoldTag = this._text("span", "tag tag-neutral", "", stockRow);

          this._dom.detailDescription = this._text("p", null, "", info);

          var qtyRow = this._el("div", null, info);
          qtyRow.style.cssText = "display:flex;align-items:center;gap:var(--space-3)";
          var seg = this._el("div", "seg", qtyRow);
          var decBtn = this._text("button", "btn btn-icon", "−", seg);
          decBtn.addEventListener("click", function () { self._decDetailQty(); });
          this._dom.detailQtyVal = this._text("span", null, "1", seg);
          this._dom.detailQtyVal.style.cssText = "padding:0 14px;display:flex;align-items:center;font-size:14px";
          var incBtn = this._text("button", "btn btn-icon", "+", seg);
          incBtn.addEventListener("click", function () { self._incDetailQty(); });
          var addBtn = this._text("button", "btn btn-primary", "Add to cart", qtyRow);
          addBtn.addEventListener("click", function () { self._addSelectedToCart(); });
          this._dom.detailAddBtn = addBtn;

          var reviewsWrap = this._el("div", null, section);
          reviewsWrap.style.marginTop = "var(--space-8)";
          this._text("h3", null, "Customer reviews", reviewsWrap);
          var reviewsList = this._el("div", null, reviewsWrap);
          reviewsList.style.cssText = "display:flex;flex-direction:column;gap:var(--space-3);max-width:640px";
          this._dom.detailReviews = reviewsList;
        },

        _buildCart: function (root) {
          var self = this;
          var section = this._el("section", null, root);
          section.id = "cart";
          section.style.cssText = "max-width:900px;margin:0 auto;padding:var(--space-8) var(--space-6);border-top:1px solid var(--color-divider)";
          this._dom.sections.cart = section;

          this._text("h6", null, "Cart & checkout", section).style.color = "var(--color-accent-700)";
          this._text("h2", null, "Your cart", section).style.marginBottom = "var(--space-4)";

          this._dom.cartEmptyMsg = this._text("p", "text-muted", "Your cart is empty — add something from the storefront.", section);

          this._dom.cartItemsList = this._el("div", null, section);
          this._dom.cartItemsList.style.cssText = "display:flex;flex-direction:column;gap:var(--space-3);margin-bottom:var(--space-6)";

          var summaryRow = this._el("div", null, section);
          summaryRow.style.cssText = "display:flex;justify-content:flex-end";
          this._dom.cartSummary = summaryRow;
          var summaryCard = this._el("div", "card elev-md", summaryRow);
          summaryCard.style.cssText = "width:300px;gap:8px";

          var subtotalRow = this._el("div", null, summaryCard);
          subtotalRow.style.cssText = "display:flex;justify-content:space-between;font-size:14px";
          this._text("span", null, "Subtotal", subtotalRow);
          this._dom.cartSubtotal = this._text("span", null, "", subtotalRow);

          var shippingRow = this._el("div", null, summaryCard);
          shippingRow.style.cssText = "display:flex;justify-content:space-between;font-size:14px;opacity:0.7";
          this._text("span", null, "Shipping", shippingRow);
          this._dom.cartShipping = this._text("span", null, "", shippingRow);

          this._el("div", "hr", summaryCard);

          var totalRow = this._el("div", null, summaryCard);
          totalRow.style.cssText = "display:flex;justify-content:space-between;font-family:var(--font-heading);font-size:18px";
          this._text("span", null, "Total", totalRow);
          this._dom.cartTotal = this._text("span", null, "", totalRow);

          var checkoutBtn = this._text("button", "btn btn-primary btn-block", "Checkout", summaryCard);
          checkoutBtn.addEventListener("click", function () { self._openCheckout(); });
        },

        _buildSellerBanner: function (root) {
          var banner = this._el("div", null, root);
          banner.style.cssText = "background:var(--color-surface);border-top:1px solid var(--color-divider);border-bottom:1px solid var(--color-divider);padding:var(--space-4) var(--space-6);text-align:center";
          this._text("span", "tag tag-accent-2", "Seller portal", banner).style.fontSize = "11px";
          var p = this._text("p", "text-muted", "Everything past this point belongs to your own seller account — separate from what shoppers browse above.", banner);
          p.style.cssText = "margin:6px 0 0;font-size:13px";
        },

        _buildSell: function (root) {
          var self = this;
          var section = this._el("section", null, root);
          section.id = "sell";
          section.style.cssText = "max-width:820px;margin:0 auto;padding:var(--space-8) var(--space-6)";
          this._dom.sections.sell = section;

          this._text("h6", null, "Sell on Shop", section).style.color = "var(--color-accent-700)";
          this._text("h2", null, "List a new item", section);
          this._text("p", "text-muted", "Add pricing and inventory — it appears in the storefront and your dashboard immediately.", section).style.marginBottom = "var(--space-6)";

          this._dom.sellGate = this._el("div", "shop-gate", section);
          this._text("p", null, "Log in to sell on Shop.", this._dom.sellGate);

          var form = this._el("form", null, section);
          form.style.cssText = "display:flex;flex-direction:column;gap:var(--space-4)";
          this._dom.sellForm = form;
          form.addEventListener("submit", function (e) {
            e.preventDefault();
            self._onSubmitListing();
          });

          var photo = this._el("div", "shop-photo cat-default", form);
          photo.style.cssText += ";width:280px;height:190px";
          this._svgIcon(ICON_PHOTO, photo);

          var titleField = this._el("div", "field", form);
          this._text("label", null, "Title", titleField);
          this._dom.sellTitle = this._el("input", "input", titleField);
          this._dom.sellTitle.type = "text";
          this._dom.sellTitle.placeholder = "e.g. Hand-thrown ceramic mug";

          var descField = this._el("div", "field", form);
          this._text("label", null, "Description", descField);
          this._dom.sellDescription = this._el("textarea", "input", descField);
          this._dom.sellDescription.rows = 3;
          this._dom.sellDescription.placeholder = "Describe the item's condition, materials and story";

          var row3 = this._el("div", null, form);
          row3.style.cssText = "display:grid;grid-template-columns:1fr 1fr 1fr;gap:var(--space-3)";

          var priceField = this._el("div", "field", row3);
          this._text("label", null, "Price (" + CURRENCY + ")", priceField);
          this._dom.sellPrice = this._el("input", "input", priceField);
          this._dom.sellPrice.type = "number";
          this._dom.sellPrice.min = "0";

          var invField = this._el("div", "field", row3);
          this._text("label", null, "Inventory count", invField);
          this._dom.sellInventory = this._el("input", "input", invField);
          this._dom.sellInventory.type = "number";
          this._dom.sellInventory.min = "0";

          var catField = this._el("div", "field", row3);
          this._text("label", null, "Category", catField);
          var catSelect = this._el("select", "input", catField);
          [["jewelry", "Jewelry"], ["electronics", "Electronics"], ["clothing", "Clothing"]].forEach(function (pair) {
            var opt = document.createElement("option");
            opt.value = pair[0];
            opt.textContent = pair[1];
            catSelect.appendChild(opt);
          });
          this._dom.sellCategory = catSelect;

          var row4 = this._el("div", null, form);
          row4.style.cssText = "display:flex;gap:var(--space-4);align-items:flex-end";
          var locField = this._el("div", "field", row4);
          locField.style.flex = "1";
          this._text("label", null, "Location", locField);
          this._dom.sellLocation = this._el("input", "input", locField);
          this._dom.sellLocation.type = "text";
          this._dom.sellLocation.placeholder = "City, State";

          var condWrap = this._el("div", null, row4);
          this._text("label", null, "Condition", condWrap).style.cssText = "display:block;font-size:12px;margin-bottom:5px;color:var(--color-text)";
          var condSeg = this._el("div", "seg", condWrap);
          var newOpt = this._text("label", "seg-opt is-checked", "New", condSeg);
          var usedOpt = this._text("label", "seg-opt", "Used", condSeg);
          this._dom.sellConditionNew = newOpt;
          this._dom.sellConditionUsed = usedOpt;
          this._dom.sellCondition = "new";
          newOpt.addEventListener("click", function () {
            self._dom.sellCondition = "new";
            newOpt.classList.add("is-checked");
            usedOpt.classList.remove("is-checked");
          });
          usedOpt.addEventListener("click", function () {
            self._dom.sellCondition = "used";
            usedOpt.classList.add("is-checked");
            newOpt.classList.remove("is-checked");
          });

          var actionsRow = this._el("div", null, form);
          actionsRow.style.cssText = "display:flex;align-items:center;gap:var(--space-3)";
          var submitBtn = this._text("button", "btn btn-primary", "List item", actionsRow);
          submitBtn.type = "submit";
          this._dom.sellSuccessTag = this._text("span", "tag tag-accent-2", "Listed — check your dashboard", actionsRow);
          this._dom.sellSuccessTag.style.display = "none";
        },

        _buildDashboard: function (root) {
          var section = this._el("section", null, root);
          section.id = "dashboard";
          section.style.cssText = "max-width:1180px;margin:0 auto;padding:var(--space-8) var(--space-6) var(--space-8);border-top:1px solid var(--color-divider)";
          this._dom.sections.dashboard = section;

          this._text("h6", null, "Seller dashboard", section).style.color = "var(--color-accent-700)";
          this._text("h2", null, "Your Shop", section);

          this._dom.dashboardGate = this._el("div", "shop-gate", section);
          this._text("p", null, "Log in to see your seller dashboard.", this._dom.dashboardGate);

          this._dom.dashboardContent = this._el("div", null, section);

          var stats = this._el("div", null, this._dom.dashboardContent);
          stats.style.cssText = "display:grid;grid-template-columns:repeat(4,1fr);gap:var(--space-4);margin:var(--space-4) 0 var(--space-6)";
          var self = this;
          this._dom.stat = {};
          [
            ["active", "Active listings"],
            ["sold", "Items sold"],
            ["revenue", "Revenue"],
            ["rating", "Avg. rating"],
          ].forEach(function (pair) {
            var card = self._el("div", "card elev-sm", stats);
            self._text("span", "card-kicker", pair[1], card);
            var val = self._text("h3", null, "0", card);
            val.style.margin = "0";
            self._dom.stat[pair[0]] = val;
          });

          this._dom.dashboardNoListings = this._text("p", "text-muted", "You haven't listed anything yet. Go to Sell to list your first item.", this._dom.dashboardContent);

          var table = this._el("table", "table", this._dom.dashboardContent);
          var thead = this._el("thead", null, table);
          var headRow = this._el("tr", null, thead);
          ["Listing", "Price", "Inventory", "Sold", "Rating", "Status"].forEach(function (h) {
            self._text("th", null, h, headRow);
          });
          this._dom.dashboardTableBody = this._el("tbody", null, table);
          this._dom.dashboardTable = table;
        },

        _buildCheckoutDialog: function (root) {
          var self = this;
          var backdrop = this._el("div", "dialog-backdrop", root);
          backdrop.style.display = "none";
          this._dom.checkoutBackdrop = backdrop;

          var dialog = this._el("div", "dialog", backdrop);
          this._dom.checkoutDialogBody = dialog;
        },
      },

      "navigation",
      {
        _scrollToSection: function (name) {
          var el = this._dom.sections[name];
          if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        },
      },

      "product logic",
      {
        _findProduct: function (id) {
          return this.state.products.filter(function (p) { return p.id === id; })[0];
        },
        _starsText: function (rating) {
          var r = Math.max(0, Math.min(5, Math.round(rating || 0)));
          return "★".repeat(r) + "☆".repeat(5 - r);
        },
        _stockInfo: function (p) {
          if (p.inventory <= 0) return { label: "Sold out", className: "tag tag-neutral" };
          if (p.inventory <= LOW_STOCK_THRESHOLD) return { label: p.inventory + " left", className: "tag tag-accent" };
          return { label: "In stock", className: "tag tag-accent-2" };
        },
        _visibleProducts: function () {
          var self = this;
          var q = this.state.filterQuery.trim().toLowerCase();
          var list = this.state.products.filter(function (p) {
            return (self.state.filterCategory === "all" || p.category === self.state.filterCategory) &&
              (q === "" || p.title.toLowerCase().indexOf(q) !== -1);
          });
          if (this.state.sortBy === "price-low") list = list.slice().sort(function (a, b) { return a.price - b.price; });
          else if (this.state.sortBy === "price-high") list = list.slice().sort(function (a, b) { return b.price - a.price; });
          else if (this.state.sortBy === "best-selling") list = list.slice().sort(function (a, b) { return b.sold - a.sold; });
          else if (this.state.sortBy === "top-rated") list = list.slice().sort(function (a, b) { return b.rating - a.rating; });
          return list;
        },
        _cartTotal: function () {
          var self = this;
          return this.state.cart.reduce(function (sum, c) {
            var p = self._findProduct(c.productId);
            return sum + (p ? p.price * c.qty : 0);
          }, 0);
        },
        _money: function (n) {
          return CURRENCY + n;
        },
      },

      "cart actions",
      {
        _addToCart: function (id) {
          var existing = this.state.cart.filter(function (c) { return c.productId === id; })[0];
          if (existing) existing.qty += 1;
          else this.state.cart.push({ productId: id, qty: 1 });
          this._renderStorefront();
          this._renderProductDetail();
          this._renderCart();
        },
        _removeFromCart: function (id) {
          this.state.cart = this.state.cart.filter(function (c) { return c.productId !== id; });
          this._renderCart();
        },
        _incCartQty: function (id) {
          var c = this.state.cart.filter(function (c) { return c.productId === id; })[0];
          if (c) c.qty += 1;
          this._renderCart();
        },
        _decCartQty: function (id) {
          var c = this.state.cart.filter(function (c) { return c.productId === id; })[0];
          if (c) c.qty = Math.max(1, c.qty - 1);
          this._renderCart();
        },
        _incDetailQty: function () {
          this.state.detailQty += 1;
          this._dom.detailQtyVal.textContent = String(this.state.detailQty);
        },
        _decDetailQty: function () {
          this.state.detailQty = Math.max(1, this.state.detailQty - 1);
          this._dom.detailQtyVal.textContent = String(this.state.detailQty);
        },
        _addSelectedToCart: function () {
          var id = this.state.selectedProductId;
          var qty = this.state.detailQty;
          var existing = this.state.cart.filter(function (c) { return c.productId === id; })[0];
          if (existing) existing.qty += qty;
          else this.state.cart.push({ productId: id, qty: qty });
          this.state.detailQty = 1;
          this._dom.detailQtyVal.textContent = "1";
          this._renderStorefront();
          this._renderCart();
        },
        _selectProduct: function (id) {
          this.state.selectedProductId = id;
          this.state.detailQty = 1;
          this._renderProductDetail();
        },
      },

      "checkout",
      {
        _openCheckout: function () {
          if (!this.state.cart.length) return;
          this.state.checkoutOpen = true;
          this.state.orderPlaced = false;
          this._renderCheckoutDialog();
        },
        _closeCheckout: function () {
          this.state.checkoutOpen = false;
          this.state.orderPlaced = false;
          this._renderCheckoutDialog();
        },
        _placeOrder: function () {
          var total = this._cartTotal();
          this.state.orderPlaced = true;
          this.state.lastOrderTotalLabel = this._money(total);
          this.state.cart = [];
          this._renderCheckoutDialog();
          this._renderStorefront();
          this._renderCart();
        },
      },

      "sell form",
      {
        _onSubmitListing: function () {
          var user = this._currentUser();
          if (!user) return;
          var title = this._dom.sellTitle.value.trim();
          var priceRaw = this._dom.sellPrice.value;
          if (!title || !priceRaw) return;

          var newProduct = {
            id: "p" + Date.now(),
            title: title,
            description: this._dom.sellDescription.value.trim() || "No description provided.",
            category: this._dom.sellCategory.value,
            condition: this._dom.sellCondition,
            price: Number(priceRaw) || 0,
            inventory: Number(this._dom.sellInventory.value) || 0,
            sold: 0,
            sellerName: user.displayName || user.handle,
            sellerHandle: user.handle,
            sellerLocation: this._dom.sellLocation.value.trim() || "Unspecified",
            rating: 0,
            reviews: [],
          };
          this.state.products.unshift(newProduct);

          this._dom.sellForm.reset();
          this._dom.sellCondition = "new";
          this._dom.sellConditionNew.classList.add("is-checked");
          this._dom.sellConditionUsed.classList.remove("is-checked");

          this._dom.sellSuccessTag.style.display = "";
          clearTimeout(this._successTimer);
          var self = this;
          this._successTimer = setTimeout(function () {
            self._dom.sellSuccessTag.style.display = "none";
          }, 3000);

          this._renderStorefront();
          this._renderDashboard();
        },
      },

      "rendering",
      {
        _renderAll: function () {
          this._renderIdentityUI();
          this._renderStorefront();
          this._renderProductDetail();
          this._renderCart();
          this._renderCheckoutDialog();
          this._renderSell();
          this._renderDashboard();
        },

        _renderIdentityUI: function () {
          var user = this._currentUser();
          this._dom.identityStatusEl.textContent = user ? "Signed in as " + (user.displayName || user.handle) : "Not signed in";
        },

        _renderStorefront: function () {
          var self = this;
          var list = this._visibleProducts();
          this._dom.resultsLabel.textContent = list.length + (list.length === 1 ? " listing found" : " listings found");

          CATEGORY_DEFS.forEach(function (pair) {
            var btn = self._dom.categoryBtns[pair[0]];
            btn.className = self.state.filterCategory === pair[0] ? "btn btn-primary" : "btn btn-secondary";
          });

          this._clear(this._dom.productGrid);
          list.forEach(function (p) {
            self._dom.productGrid.appendChild(self._buildProductCard(p));
          });

          this._dom.cartCountTag.textContent = String(this.state.cart.reduce(function (n, c) { return n + c.qty; }, 0));
        },

        _buildProductCard: function (p) {
          var self = this;
          var stock = this._stockInfo(p);
          var card = this._el("div", "card elev-sm", null);

          var photo = this._el("div", "shop-photo cat-" + p.category, card);
          photo.style.height = "170px";
          this._svgIcon(ICON_PHOTO, photo);

          var meta = this._el("div", "card-meta", card);
          this._svgIcon(ICON_PERSON, meta);
          this._text("span", null, p.sellerName + " · " + p.sellerLocation, meta);

          this._text("h4", "card-title", p.title, card);

          var ratingRow = this._el("div", null, card);
          ratingRow.style.cssText = "display:flex;align-items:center;gap:6px;font-size:13px";
          this._text("span", null, this._starsText(p.rating), ratingRow).style.letterSpacing = "1px";
          this._text("span", "text-muted", p.reviews.length ? "(" + p.reviews.length + ")" : "No reviews yet", ratingRow);

          var priceRow = this._el("div", null, card);
          priceRow.style.cssText = "display:flex;align-items:center;justify-content:space-between";
          this._text("strong", null, this._money(p.price), priceRow).style.cssText = "font-family:var(--font-heading);font-size:17px";
          this._text("span", stock.className, stock.label, priceRow);

          this._text("p", "card-body", p.sold + " sold", card).style.fontSize = "12px";

          var actions = this._el("div", null, card);
          actions.style.cssText = "display:flex;gap:8px;margin-top:auto";
          var viewBtn = this._text("button", "btn btn-secondary", "View", actions);
          viewBtn.style.flex = "1";
          viewBtn.addEventListener("click", function () {
            self._selectProduct(p.id);
            self._scrollToSection("product");
          });
          var addBtn = this._text("button", "btn btn-primary", "Add to cart", actions);
          addBtn.style.flex = "1";
          addBtn.disabled = p.inventory <= 0;
          addBtn.addEventListener("click", function () { self._addToCart(p.id); });

          return card;
        },

        _renderProductDetail: function () {
          var p = this._findProduct(this.state.selectedProductId) || this.state.products[0];
          if (!p) return;
          var stock = this._stockInfo(p);

          this._dom.detailPhoto.className = "shop-photo cat-" + p.category;
          this._dom.detailCategoryTag.textContent = p.category.charAt(0).toUpperCase() + p.category.slice(1);
          this._dom.detailConditionTag.textContent = p.condition.charAt(0).toUpperCase() + p.condition.slice(1);
          this._dom.detailTitle.textContent = p.title;
          this._dom.detailSellerLine.textContent = p.sellerName + " · " + p.sellerLocation;
          this._dom.detailStars.textContent = this._starsText(p.rating);
          this._dom.detailReviewCount.textContent = p.reviews.length ? "(" + p.reviews.length + ")" : "No reviews yet";
          this._dom.detailPrice.textContent = this._money(p.price);
          this._dom.detailStockTag.className = stock.className;
          this._dom.detailStockTag.textContent = stock.label;
          this._dom.detailSoldTag.textContent = p.sold + " sold";
          this._dom.detailDescription.textContent = p.description;
          this._dom.detailQtyVal.textContent = String(this.state.detailQty);
          this._dom.detailAddBtn.disabled = p.inventory <= 0;

          this._clear(this._dom.detailReviews);
          if (p.reviews.length === 0) {
            this._text("p", "text-muted", "No reviews yet.", this._dom.detailReviews);
          } else {
            p.reviews.forEach(function (review) {
              var card = this._el("div", "card elev-sm", this._dom.detailReviews);
              card.style.gap = "6px";
              var head = this._el("div", null, card);
              head.style.cssText = "display:flex;align-items:center;gap:8px";
              this._text("strong", null, review.name, head).style.fontSize = "13px";
              if (review.verified) this._text("span", "tag tag-accent-2", "Verified buyer", head);
              this._text("span", null, this._starsText(review.rating), card).style.cssText = "letter-spacing:1px;font-size:13px";
              this._text("p", "card-body", review.text, card);
            }, this);
          }
        },

        _renderCart: function () {
          var self = this;
          var cart = this.state.cart;
          this._dom.cartEmptyMsg.style.display = cart.length ? "none" : "";
          this._dom.cartItemsList.style.display = cart.length ? "" : "none";
          this._dom.cartSummary.style.display = cart.length ? "" : "none";

          this._clear(this._dom.cartItemsList);
          cart.forEach(function (c) {
            var p = self._findProduct(c.productId);
            if (!p) return;
            var row = self._el("div", "card elev-sm", self._dom.cartItemsList);
            row.style.cssText = "flex-direction:row;align-items:center;gap:var(--space-3)";

            var photo = self._el("div", "shop-photo cat-" + p.category, row);
            photo.style.cssText += ";width:64px;height:64px;flex:none";
            self._svgIcon(ICON_PHOTO, photo).style.transform = "scale(0.6)";

            var info = self._el("div", null, row);
            info.style.flex = "1";
            self._text("h5", null, p.title, info).style.margin = "0";
            self._text("span", "text-muted", p.sellerName + " · " + p.sellerLocation, info).style.fontSize = "12px";

            var seg = self._el("div", "seg", row);
            var dec = self._text("button", "btn btn-icon", "−", seg);
            dec.addEventListener("click", function () { self._decCartQty(c.productId); });
            self._text("span", null, String(c.qty), seg).style.cssText = "padding:0 12px;display:flex;align-items:center;font-size:14px";
            var inc = self._text("button", "btn btn-icon", "+", seg);
            inc.addEventListener("click", function () { self._incCartQty(c.productId); });

            self._text("strong", null, self._money(p.price * c.qty), row).style.cssText = "width:70px;text-align:right";

            var removeBtn = self._text("button", "btn btn-ghost", "Remove", row);
            removeBtn.addEventListener("click", function () { self._removeFromCart(c.productId); });
          });

          var subtotal = this._cartTotal();
          var shipping = subtotal > 0 ? 6 : 0;
          this._dom.cartSubtotal.textContent = this._money(subtotal);
          this._dom.cartShipping.textContent = shipping > 0 ? this._money(shipping) : "Free";
          this._dom.cartTotal.textContent = this._money(subtotal + shipping);
          this._dom.cartCountTag.textContent = String(cart.reduce(function (n, c) { return n + c.qty; }, 0));
        },

        _renderCheckoutDialog: function () {
          var self = this;
          this._dom.checkoutBackdrop.style.display = this.state.checkoutOpen ? "" : "none";
          var dialog = this._dom.checkoutDialogBody;
          this._clear(dialog);
          if (!this.state.checkoutOpen) return;

          if (this.state.orderPlaced) {
            this._text("h3", "dialog-title", "Order placed", dialog);
            this._text("p", "dialog-body", "Thanks for your order — " + this.state.lastOrderTotalLabel + " is on its way.", dialog);
            var actions = this._el("div", "dialog-actions", dialog);
            var closeBtn = this._text("button", "btn btn-primary", "Close", actions);
            closeBtn.addEventListener("click", function () { self._closeCheckout(); });
          } else {
            this._text("h3", "dialog-title", "Confirm your order", dialog);
            var count = this.state.cart.reduce(function (n, c) { return n + c.qty; }, 0);
            this._text("p", "dialog-body", count + " item(s) — total " + this._money(this._cartTotal()) + ". This is a prototype checkout, no payment is collected.", dialog);
            var actions2 = this._el("div", "dialog-actions", dialog);
            var cancelBtn = this._text("button", "btn btn-secondary", "Cancel", actions2);
            cancelBtn.addEventListener("click", function () { self._closeCheckout(); });
            var placeBtn = this._text("button", "btn btn-primary", "Place order", actions2);
            placeBtn.addEventListener("click", function () { self._placeOrder(); });
          }
        },

        _renderSell: function () {
          var signedIn = !!this._currentUser();
          this._dom.sellGate.style.display = signedIn ? "none" : "";
          this._dom.sellForm.style.display = signedIn ? "" : "none";
        },

        _renderDashboard: function () {
          var user = this._currentUser();
          var signedIn = !!user;
          this._dom.dashboardGate.style.display = signedIn ? "none" : "";
          this._dom.dashboardContent.style.display = signedIn ? "" : "none";
          if (!signedIn) return;

          var self = this;
          var sellerProducts = this.state.products.filter(function (p) { return p.sellerHandle === user.handle; });
          var totalSold = sellerProducts.reduce(function (n, p) { return n + p.sold; }, 0);
          var totalRevenue = sellerProducts.reduce(function (n, p) { return n + p.sold * p.price; }, 0);
          var rated = sellerProducts.filter(function (p) { return p.reviews.length > 0; });
          var avgRating = rated.length ? rated.reduce(function (n, p) { return n + p.rating; }, 0) / rated.length : 0;

          this._dom.stat.active.textContent = String(sellerProducts.length);
          this._dom.stat.sold.textContent = String(totalSold);
          this._dom.stat.revenue.textContent = this._money(totalRevenue);
          this._dom.stat.rating.textContent = avgRating ? avgRating.toFixed(1) + " ★" : "—";

          this._dom.dashboardNoListings.style.display = sellerProducts.length ? "none" : "";
          this._dom.dashboardTable.style.display = sellerProducts.length ? "" : "none";

          this._clear(this._dom.dashboardTableBody);
          sellerProducts.forEach(function (p) {
            var stock = self._stockInfo(p);
            var status = p.inventory <= 0
              ? { label: "Sold out", className: "tag tag-neutral" }
              : p.inventory <= LOW_STOCK_THRESHOLD
                ? { label: "Low stock", className: "tag tag-accent" }
                : { label: "Active", className: "tag tag-accent-2" };
            var row = self._el("tr", null, self._dom.dashboardTableBody);
            self._text("td", null, p.title, row);
            self._text("td", null, self._money(p.price), row);
            self._text("td", null, String(p.inventory), row);
            self._text("td", null, String(p.sold), row);
            self._text("td", null, p.reviews.length ? p.rating.toFixed(1) : "—", row);
            var statusTd = self._el("td", null, row);
            self._text("span", status.className, status.label, statusTd);
          });
        },
      },
    );

    ShopClass.open = function (optPos) {
      var m = new lively.commerce.Shop(lively.rect(0, 0, 1180, 780));
      m.setName("Shop");
      m.openInWorld(optPos || lively.morphic.World.current().visibleBounds().center().subPt(lively.pt(590, 390)));
      return m;
    };
  }); // end module('lively.commerce.Shop')
