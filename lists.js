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
      /^__lpform_/i,
    ],

    // Custom-element tag names (matched against tagName). Elements with a
    // matching tag are removed from the DOM entirely.
    domStripTags: [/^grammarly-/i, /^lastpass-/i, /^dashlane-/i, /^honey-/i, /^onepassword-/i],

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
        "bhhhlkgekbhbdjncpdbjkmjnnapolepf", // Solflare
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
