// Shared configuration for Static.
//
// Loaded before block.js (MAIN world) and dom_scrubber.js (ISOLATED world)
// in the same content-script group; also imported by the service worker via
// importScripts("lists.js"). All pattern / global / slot data lives here.
//
// To extend coverage, append to the arrays below. To keep a specific
// browser extension working on your machine, make sure none of the patterns
// below match its DOM markers or globals, and none of the `conflictSlots`
// arrays include its ID if you don't want Static to claim it as a decoy.
(() => {
  const data = {
    // URL schemes that indicate a cross-origin probe at an installed browser
    // extension. Any fetch / XHR / src= / href= to a matching URL is treated
    // as a fingerprinting attempt and silently rejected (or decoyed when
    // Noise mode is on).
    probeUrlRegex: /^(chrome|moz|ms-browser|safari-web|edge)-extension:/i,

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
    ],

    // window.* properties that browser extensions set as bridges between
    // their content script and the page. Locked to undefined before any
    // page script runs, so later writes silently no-op.
    stripGlobals: [
      "__REACT_DEVTOOLS_GLOBAL_HOOK__",
      "__REDUX_DEVTOOLS_EXTENSION__",
      "__REDUX_DEVTOOLS_EXTENSION_COMPOSE__",
      "__VUE_DEVTOOLS_GLOBAL_HOOK__",
      "__MOBX_DEVTOOLS_GLOBAL_HOOK__",
      "__APOLLO_DEVTOOLS_GLOBAL_HOOK__",
      "__GRAMMARLY_DESKTOP_INTEGRATION__",
      "__grammarlyGlobalSessionId",
      "__onePasswordExtension",
      "__1passwordExtension",
      "__dashlaneExtensionInstalled",
      "__isDashlaneExtensionInstalled",
      "__honeyExtensionInstalled",
      "__keeper_extension_installed",
      "__nordpassExtensionInstalled",
      "__roboformExtensionInstalled",
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
      ],
      ad_blocker: [
        "cjpalhdlnbpafiamejdnhcphjbkeiagm", // uBlock Origin
        "gighmmpiobklfepjocnamgkkbiglidom", // AdBlock
        "cfhdojbkjhnklbpkdaibdccddilifddb", // AdBlock Plus
        "bgnkhhnnamicmpeenaelnjfhikgbkllg", // AdGuard
        "pkehgijcmpdhfbdbbnkijodmdjhbjlgp", // Privacy Badger
        "ddkjiahejlhfcafbddmgiahcphecmpfh", // uBlock Origin Lite
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
    },

    // Target size range for a persona on a given origin. Real users average
    // 3-5 extensions; a handful go up to ~15. Random integer in this range,
    // stable per origin+week, becomes the persona size target.
    personaSize: { min: 3, max: 8 },

    // An ID must be seen at least this many times on an origin before Static
    // will include it in that origin's persona. Filters one-shot canary
    // probes from entering the replay pool.
    personaMinCount: 2,

    // Weeks before a persona rotates.
    personaRotationWeeks: 1,
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
