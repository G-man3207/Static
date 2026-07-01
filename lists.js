// Shared configuration for Static.
//
// Loaded before dom_scrubber.js (ISOLATED world) and imported by the service
// worker via importScripts("lists.js"). MAIN-world block.js keeps its own local
// constants so Static does not expose a detectable page global.
//
// To extend coverage, append to the arrays below. To keep a specific browser
// extension working on your machine, make sure none of the patterns below match
// its DOM markers, and none of the `conflictSlots` arrays include its ID if
// you don't want Static to claim it as a decoy.
(() => {
  const data = {
    // DOM attribute names to strip (case-insensitive regex, matched against
    // the attribute name). Any matching attribute is removed from every
    // element on page load and on every subsequent DOM mutation.
    domStripAttrs: [
      /^data-1password(-|$)/i,
      /^data-1p(-|$)/i,
      /^data-onepassword(-|$)/i,
      /^data-op(-|$)/i,
      /^data-lastpass(-|$)/i,
      /^data-lp-(ignore|id|tab)/i,
      /^data-dashlane(-|$)/i,
      /^data-dashlanecreated/i,
      /^data-grammarly(-|$)/i,
      /^data-gramm(-|$)/i,
      /^data-gr-c-s-(loaded|check-loaded)$/i,
      /^data-honey(-|$)/i,
      /^data-honeyextension(-|$)/i,
      /^data-keeper(-|$)/i,
      /^data-roboform(-|$)/i,
      /^data-nordpass(-|$)/i,
      /^data-bitwarden(-|$)/i,
      /^data-protonpass(-|$)/i,
      /^__lpform_/i,
    ],

    // Custom-element tag names (matched against tagName). Elements with a
    // matching tag are removed from the DOM entirely.
    domStripTags: [
      /^grammarly-/i,
      /^lastpass-/i,
      /^dashlane-/i,
      /^honey-/i,
      /^onepassword-/i,
      /^protonpass-/i,
    ],

    // CSS class names to strip (element stays; just the class).
    domStripClasses: [
      /^grammarly($|-)/i,
      /^lastpass($|-)/i,
      /^__lpform/i,
      /^lpform/i,
      /^dashlane($|-)/i,
      /^honey($|-)/i,
      /^onepassword($|-)/i,
      /^protonpass($|-)/i,
    ],

    // Known-extension ID groups used by Noise-mode persona generation.
    // When Static claims a decoy persona (subset of IDs it's seen probed on
    // an origin), it picks at most one ID per slot. This avoids implausible
    // combos like "three password managers installed" that would tip off any
    // halfway-decent anti-fraud team. IDs not in any slot are picked freely.
    conflictSlots: {
      password_manager: [
        "nngceckbapebfimnlniiiahkandclblb", // Bitwarden
        "aeblfdkhhhdcdjpifhhbdiojplfjncoa", // 1Password
        "hdokiejnpimakedhajhdlcegeplioahd", // LastPass
        "fdjamakpfbbddfjaooikfcpapjohcfmg", // Dashlane
        "ohigdmefobenhgkmpihnlmkphdoagcpe", // Keeper
        "pnlccmojcmeohlpggmfnbbiapkmbliob", // RoboForm (newer)
        "fooolghllnmhmmndgjiamiiodkpenpbb", // RoboForm (legacy)
        "bmikpgodpkclnkgmnpphehdgcimmided", // NordPass
        "cjnlpnbkjbnmdieljmighbdoljmgfibk", // Proton Pass
      ],
      userscript_manager: [
        "dhdgffkkebhmkfjojejmpbldmpobfkfo", // Tampermonkey
        "clngdbkpkpeebahjckkjfobafhncgmne", // Stylus
      ],
      privacy: [
        "bkdgflcldnnnapblkhphbgpggdiikppg", // DuckDuckGo Privacy Essentials
      ],
      ad_blocker: [
        "cjpalhdlnbpafiamejdnhcphjbkeiagm", // uBlock Origin
        "gighmmpiobklfepjocnamgkkbiglidom", // AdBlock
        "cfhdojbkjhnklbpkdaibdccddilifddb", // AdBlock Plus
        "bgnkhhnnamicmpeenaelnjfhikgbkllg", // AdGuard
        "pkehgijcmpdhfbdbbnkijodmdjhbjlgp", // Privacy Badger
        "ddkjiahejlhfcafbddmgiahcphecmpfh", // uBlock Origin Lite
        "mlomiejdfkolichcflejclcbmpeaniij", // Ghostery
      ],
      grammar: [
        "kbfnbcaeplbcioakkpcpgfkobkghlhen", // Grammarly
        "oldceeleldhonbafppcapldpdifcinji", // LanguageTool
      ],
      web3_wallet: [
        "nkbihfbeogaeaoehlefnkodbefgpgknn", // MetaMask
        "hnfanknocfeofbddgcijnmhnfnkdnaad", // Coinbase Wallet
        "bfnaelmomeimhlpmgjnjophhpkkoljpa", // Phantom
        "ibnejdfjmmkpcnlpebklmnkoeoihofec", // TronLink
        "bhhhlkgekbhbdjncpdbjkmjnnapolepf", // Solflare
        "acmacodkjbdgmoleebolmdjonilkdbch", // Rabby Wallet
        "egjidjbpglichdcongccjofoobgmfgei", // Trust Wallet
      ],
      react_devtools: [
        "fmkadmapgofadopljbjfkapdkoienihi", // React DevTools
        "lmhkpmbekcpmknklioeibfkpmmfibljd", // Redux DevTools
        "nhdogjmejiglipccpnnnanhbledajbpd", // Vue DevTools
      ],
      translator: [
        "aapbdbdomjkkjkaonfhkkikfgjllcleb", // Google Translate
        "cofdbpoegempjloogbagkncekinflcnj", // DeepL
      ],
      vpn_proxy: [
        "npggkinfhjadegenkdjokdacdkopdfdb", // ProtonVPN
      ],
      dark_mode: [
        "eimadpbcbfnmbkopoojfekhnkhdbieeh", // Dark Reader
      ],
      shopping: [
        "bfogiajgogklnfndlkggihnhakgkbjgg", // Rakuten
        "lmelmgmclklieheidfjlabcjljeojmho", // Capital One Shopping
        "bmnlcjabgnpnenekpadlanbbkooimhnj", // Honey
      ],
    },

    // Target size range for a persona on a given origin. Real users average
    // 3-5 extensions; a handful go up to ~15. Random integer in this range,
    // stable per origin+week, becomes the persona size target.
    personaSize: { min: 3, max: 8 },

    // An ID must be seen at least this many times on an origin before Static
    // will include it in that origin's persona when it is a known plausible
    // extension ID. Filters one-shot canary probes from entering the replay
    // pool.
    personaMinCount: 2,

    // Unknown extension-shaped IDs need stronger evidence before Static will
    // claim them. This keeps cheap repeated canaries from poisoning Static's
    // own persona with IDs that no real user could plausibly have installed.
    unknownPersonaMinCount: 20,

    // Weeks before a persona rotates.
    personaRotationWeeks: 1,
  };

  // ========================================================================
  // Shared helpers — single source of truth for extension-ID validation,
  // persona/known-ID extraction, path-kind classification and priority
  // ordering. Used by the service worker, service_worker_utils.js and the
  // ISOLATED-world bridge.js so the three never drift apart.
  //
  // MAIN-world block content scripts intentionally keep their own copies
  // (see block_utils.js) so Static does not expose a detectable page global.
  // ========================================================================
  data.helpers = {
    // Regexes for extension-ID shapes across browser schemes.
    CHROME_EXT_ID_RE: /^[a-p]{32}$/,
    UUID_EXT_ID_RE: /^[a-f0-9]{8}-([a-f0-9]{4}-){3}[a-f0-9]{12}$/i,
    get EXT_ID_RE_BY_SCHEME() {
      return {
        "chrome-extension": this.CHROME_EXT_ID_RE,
        "edge-extension": this.CHROME_EXT_ID_RE,
        "moz-extension": this.UUID_EXT_ID_RE,
        "safari-web-extension": this.UUID_EXT_ID_RE,
      };
    },

    isValidExtensionId(id) {
      return (
        typeof id === "string" && (this.CHROME_EXT_ID_RE.test(id) || this.UUID_EXT_ID_RE.test(id))
      );
    },

    extensionIdentityFor(url) {
      try {
        const parsed = new URL(String(url || ""));
        const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
        const id = parsed.hostname.toLowerCase();
        const idRe = this.EXT_ID_RE_BY_SCHEME[scheme];
        if (idRe && idRe.test(id)) return { id, scheme };
      } catch {}
      return null;
    },

    extractExtId(url) {
      const identity = this.extensionIdentityFor(url);
      return identity ? identity.id : null;
    },

    // Path portion of an extension URL (capped) for diagnostics.
    extensionPathFor(url) {
      const identity = this.extensionIdentityFor(url);
      if (!identity) return "";
      try {
        return new URL(String(url || "")).pathname.slice(0, 96);
      } catch {
        return "";
      }
    },

    // Set of every known extension ID across all conflictSlots, lowercased.
    knownPersonaIds(config = data) {
      const ids = new Set();
      for (const slotIds of Object.values((config && config.conflictSlots) || {})) {
        for (const id of slotIds || []) {
          if (typeof id === "string") ids.add(id.toLowerCase());
        }
      }
      return ids;
    },

    // Map of known ID -> slot name, lowercased, for conflict-aware persona
    // selection.
    buildConflictSlotMap(config = data) {
      const idToSlot = new Map();
      for (const [slotName, ids] of Object.entries((config && config.conflictSlots) || {})) {
        for (const id of ids || []) {
          if (typeof id === "string") idToSlot.set(id.toLowerCase(), slotName);
        }
      }
      return idToSlot;
    },

    // Coarse resource kind for a URL's path. Used for probe-path telemetry.
    pathnameFor(url) {
      try {
        return new URL(url).pathname.toLowerCase();
      } catch {
        return null;
      }
    },

    pathKindFor(url) {
      const pathname = this.pathnameFor(url);
      if (pathname === null) return "unknown";
      if (pathname === "" || pathname === "/") return "root";
      if (pathname.endsWith("/manifest.json")) return "manifest";
      if (/\.(png|jpe?g|gif|webp|ico|bmp)$/i.test(pathname)) return "image";
      if (pathname.endsWith(".svg")) return "svg";
      if (pathname.endsWith(".js") || pathname.endsWith(".mjs")) return "script";
      if (pathname.endsWith(".css")) return "style";
      if (pathname.endsWith(".html") || pathname.endsWith(".htm")) return "html";
      if (pathname.endsWith(".json")) return "json";
      return "other";
    },

    // Priority weight for trim/sort ordering: known IDs outrank unknown ones.
    countPriorityFor(id, count, knownIds) {
      return (knownIds && knownIds.has(String(id).toLowerCase()) ? 1000000 : 0) + count;
    },
  };

  try {
    Object.defineProperty(globalThis, "__static_config__", {
      value: data,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  } catch {
    globalThis.__static_config__ = data;
  }
})();
