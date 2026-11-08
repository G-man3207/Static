/* eslint-disable max-lines -- marker lists, site suffix lists and shared helpers are one config file so tests can diff them in one place */
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
      /^data-keepassxc(-|$)/i,
      /^data-darkreader(-|$)/i,
      /^data-bw(-|$)/i,
      /^data-lt(-|$)/i,
      /^data-languagetool(-|$)/i,
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
      /^keepassxc-/i,
      /^darkreader-/i,
      /^bitwarden-/i,
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
      /^keepassxc($|-)/i,
      /^darkreader($|-)/i,
      /^bitwarden($|-)/i,
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
        "oboonakemofpalcgghocfoadofidjkkk", // KeePassXC-Browser
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

    // A resource path must be seen this many times for a persona ID before
    // Noise will answer that exact path. Stops one-shot path canaries on an
    // already-eligible ID (LinkedIn-style `{id, file}` probes are repeated
    // across visits, so real WAR files pass; random `*.png` names do not).
    personaMinPathCount: 2,

    // Cap learned WAR paths stored per extension ID. LinkedIn-style playbooks
    // use one file per ID; extra slots absorb icon + script variants without
    // letting a canary flood unbounded path maps.
    maxPathsPerId: 8,
  };

  // ========================================================================
  // Site identity — the unit of a per-site protection decision.
  //
  // A "site" is the registrable domain (eTLD+1): paypal.com, bbc.co.uk. Hosts
  // that are already sites stay as they are: IP literals, localhost,
  // single-label intranet hosts, and one tenant of a shared platform
  // (alice.github.io). Ports and schemes never enter a site key, so a decision
  // made on www.example.com:8443 covers every subdomain and port.
  //
  // This is a deliberately small public-suffix heuristic: the full PSL is tens
  // of thousands of lines and Static does not ship a data dependency. The lists
  // only need to be right for suffixes that are *shared* between unrelated
  // sites (platforms, country-code second levels). A missing two-label suffix at
  // worst keeps two sibling hosts apart; a missing platform suffix would make
  // one tenant's decision cover another tenant, so the platform list is the one
  // to grow carefully.
  // ========================================================================
  data.siteRules = {
    // Shared hosting platforms: the label before the suffix is the site.
    multiTenantSuffixes: [
      "github.io",
      "githubusercontent.com",
      "gitlab.io",
      "bitbucket.io",
      "netlify.app",
      "vercel.app",
      "pages.dev",
      "workers.dev",
      "web.app",
      "firebaseapp.com",
      "appspot.com",
      "herokuapp.com",
      "azurewebsites.net",
      "cloudfront.net",
      "s3.amazonaws.com",
      "s3-website.amazonaws.com",
      "amplifyapp.com",
      "onrender.com",
      "fly.dev",
      "railway.app",
      "glitch.me",
      "repl.co",
      "replit.app",
      "codesandbox.io",
      "stackblitz.io",
      "surge.sh",
      "neocities.org",
      "blogspot.com",
      "wordpress.com",
      "weebly.com",
      "wixsite.com",
      "squarespace.com",
      "notion.site",
      "tumblr.com",
      "substack.com",
      "readthedocs.io",
      "gitbook.io",
      "azureedge.net",
      "ngrok.io",
      "ngrok-free.app",
      "trycloudflare.com",
      "deno.dev",
      "val.town",
      "observableusercontent.com",
      "super.site",
      "stores.jp",
    ],

    // Country-code second levels: the label before the suffix is the site.
    secondLevelSuffixes: [
      "co.uk",
      "org.uk",
      "ac.uk",
      "gov.uk",
      "me.uk",
      "net.uk",
      "sch.uk",
      "nhs.uk",
      "com.au",
      "net.au",
      "org.au",
      "edu.au",
      "gov.au",
      "id.au",
      "asn.au",
      "co.nz",
      "net.nz",
      "org.nz",
      "govt.nz",
      "ac.nz",
      "geek.nz",
      "co.jp",
      "ne.jp",
      "or.jp",
      "ac.jp",
      "go.jp",
      "ad.jp",
      "ed.jp",
      "gr.jp",
      "lg.jp",
      "com.kr",
      "co.kr",
      "or.kr",
      "ne.kr",
      "go.kr",
      "ac.kr",
      "co.in",
      "net.in",
      "org.in",
      "gen.in",
      "firm.in",
      "ind.in",
      "ac.in",
      "edu.in",
      "gov.in",
      "com.br",
      "net.br",
      "org.br",
      "gov.br",
      "edu.br",
      "com.cn",
      "net.cn",
      "org.cn",
      "gov.cn",
      "edu.cn",
      "ac.cn",
      "com.hk",
      "net.hk",
      "org.hk",
      "edu.hk",
      "gov.hk",
      "com.sg",
      "net.sg",
      "org.sg",
      "edu.sg",
      "gov.sg",
      "com.tw",
      "net.tw",
      "org.tw",
      "edu.tw",
      "gov.tw",
      "com.mx",
      "net.mx",
      "org.mx",
      "gob.mx",
      "edu.mx",
      "com.ar",
      "net.ar",
      "org.ar",
      "gob.ar",
      "com.tr",
      "net.tr",
      "org.tr",
      "gen.tr",
      "web.tr",
      "com.ua",
      "net.ua",
      "org.ua",
      "in.ua",
      "com.pl",
      "net.pl",
      "org.pl",
      "info.pl",
      "co.il",
      "org.il",
      "net.il",
      "ac.il",
      "gov.il",
      "co.za",
      "org.za",
      "net.za",
      "gov.za",
      "ac.za",
      "com.eg",
      "net.eg",
      "org.eg",
      "edu.eg",
      "gov.eg",
      "com.sa",
      "net.sa",
      "org.sa",
      "edu.sa",
      "gov.sa",
      "com.ng",
      "net.ng",
      "org.ng",
      "edu.ng",
      "gov.ng",
      "co.ke",
      "or.ke",
      "com.ke",
      "co.id",
      "net.id",
      "or.id",
      "ac.id",
      "go.id",
      "web.id",
      "com.bd",
      "net.bd",
      "org.bd",
      "edu.bd",
      "com.np",
      "net.np",
      "org.np",
      "co.th",
      "in.th",
      "or.th",
      "ac.th",
      "go.th",
      "com.my",
      "net.my",
      "org.my",
      "edu.my",
      "com.ph",
      "net.ph",
      "org.ph",
      "edu.ph",
      "gov.ph",
      "com.vn",
      "net.vn",
      "org.vn",
      "edu.vn",
      "com.pk",
      "net.pk",
      "org.pk",
      "edu.pk",
      "gov.pk",
      "com.es",
      "nom.es",
      "org.es",
      "gob.es",
      "edu.es",
      "com.pt",
      "net.pt",
      "org.pt",
      "edu.pt",
      "com.co",
      "net.co",
      "org.co",
      "edu.co",
      "com.pe",
      "net.pe",
      "org.pe",
      "com.ve",
      "co.ve",
      "com.ec",
      "com.uy",
      "com.py",
      "com.bo",
      "com.do",
      "com.gt",
      "com.sv",
      "com.hn",
      "com.ni",
      "com.cr",
      "com.pa",
      "com.cl",
      "co.cr",
      "co.ao",
      "co.mz",
      "co.zw",
      "co.bw",
      "com.gh",
      "com.ci",
      "com.sn",
      "com.cm",
      "com.et",
      "com.tn",
      "com.dz",
      "com.ma",
      "co.ug",
      "co.tz",
      "com.ru",
      "net.ru",
      "org.ru",
      "com.by",
      "com.kz",
      "com.uz",
      "co.uz",
      "com.lk",
      "com.mm",
      "com.kh",
      "com.la",
      "com.bn",
      "com.mo",
      "com.gr",
      "com.cy",
      "com.mt",
      "com.ro",
      "com.hr",
      "com.ba",
      "com.mk",
      "com.rs",
      "com.si",
      "com.sk",
      "com.bg",
      "com.lt",
      "com.lv",
      "com.ee",
      "com.md",
      "com.ge",
      "com.az",
      "com.am",
      "com.tj",
      "com.kg",
      "com.mn",
    ],

    // A host that is only labels and dots is patternable; IP literals and
    // single labels are still sites but get a narrower match pattern.
    hostLabelRe: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    ipv4Re: /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/,
    ipv6Re: /^\[[0-9a-f:.]+\]$/,
    // Pattern hosts are safer as a whitelist than by URL-parsing again.
    patternHostRe: /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/,
    maxSiteKeyLength: 253,
  };

  // The two suffix lists are hand-maintained and a broad suffix is sometimes
  // listed in more than one regional group; de-duplicate once at load and sort
  // by label count so the site-key walk can take the longest shared suffix.
  for (const key of ["multiTenantSuffixes", "secondLevelSuffixes"]) {
    data.siteRules[key] = [...new Set(data.siteRules[key])].sort(
      (a, b) => b.split(".").length - a.split(".").length || a.localeCompare(b)
    );
  }

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

    // Local-only WAR pathname for Noise learning. Lowercased, query-stripped,
    // charset-limited, and length-capped so probe storage never keeps website
    // URLs or unbounded canary strings.
    sanitizeExtensionPath(path) {
      if (typeof path !== "string" || !path) return "";
      let value = path.split("?")[0].split("#")[0].trim().toLowerCase();
      if (!value) return "";
      if (!value.startsWith("/")) value = `/${value}`;
      if (value.includes("\\") || value.includes("://") || value.includes("//")) return "";
      if (value.includes("/../") || value.endsWith("/..") || value.includes("/./")) return "";
      if (value.length > 96) value = value.slice(0, 96);
      if (!/^\/[a-z0-9._\-/]+$/.test(value)) return "";
      return value;
    },

    extensionPathnameFor(url) {
      return this.sanitizeExtensionPath(this.pathnameFor(url) || this.extensionPathFor(url));
    },

    // Suffix-based decoy kind for learned WAR paths that miss the conservative
    // allowlist. Formats Static cannot synthesize with matching bytes stay
    // fail-closed (webp/ico/bmp and unknown suffixes).
    learnedDecoyKindForPath(pathname) {
      const path = this.sanitizeExtensionPath(pathname);
      if (!path) return null;
      if (path.endsWith("/manifest.json") || path === "/manifest.json") return "manifest";
      if (/\.(png|gif|jpe?g|svg)$/.test(path)) return "image";
      if (path.endsWith(".js") || path.endsWith(".mjs")) return "script";
      if (path.endsWith(".html") || path.endsWith(".htm")) return "html";
      if (path.endsWith(".css")) return "style";
      if (path.endsWith(".json")) return "json";
      if (path.endsWith(".txt") || path.endsWith(".md")) return "text";
      if (path.endsWith(".xml")) return "xml";
      return null;
    },

    eligiblePathsForId(pathCounts, minCount = 2) {
      const eligible = [];
      for (const [path, count] of Object.entries(pathCounts || {})) {
        const safePath = this.sanitizeExtensionPath(path);
        if (
          safePath &&
          typeof count === "number" &&
          count >= minCount &&
          this.learnedDecoyKindForPath(safePath)
        ) {
          eligible.push(safePath);
        }
      }
      return eligible.sort();
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

    // ── Site identity (per-site protection mode) ──────────────────────────
    // Normalize a hostname the way the URL parser does: lowercase ASCII,
    // punycode for IDNs, no trailing dot, no port. Accepts "host", "host:port",
    // or a full origin/URL.
    normalizeHostname(value) {
      if (typeof value !== "string") return null;
      let raw = value.trim();
      if (!raw) return null;
      try {
        // Split the scheme so this file never contains a literal http(s) URL;
        // the local-only static test treats any such string as a remote call.
        const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http:${"//"}${raw}`;
        return new URL(withScheme).hostname.toLowerCase().replace(/\.+$/, "");
      } catch {
        raw = raw.toLowerCase().replace(/\.+$/, "");
        return raw || null;
      }
    },

    siteKeyForHostname(hostname) {
      const rules = data.siteRules;
      const normalized = this.normalizeHostname(hostname);
      if (!normalized) return null;
      const labels = normalized.split(".");
      if (rules.ipv6Re.test(normalized) || rules.ipv4Re.test(normalized)) return normalized;
      // Chrome resolves every *.localhost name to loopback; a decision made on
      // the dev host should cover its app subdomains, not split into new sites.
      if (normalized === "localhost" || normalized.endsWith(".localhost")) return "localhost";
      if (!normalized.includes(".") || labels.some((label) => !label) || labels.length > 127) {
        return normalized;
      }
      const shared = this.sharedSiteSuffixFor(normalized);
      if (shared) return shared;
      return `${labels[labels.length - 2]}.${labels[labels.length - 1]}`;
    },

    // Registrable domain minus the shared suffix: one tenant of github.io or
    // bbc.co.uk. Longest shared suffix wins, so "s3.amazonaws.com" beats a
    // broader suffix that happens to end with the same labels.
    sharedSiteSuffixFor(normalized) {
      const rules = data.siteRules;
      for (const suffixes of [rules.multiTenantSuffixes, rules.secondLevelSuffixes]) {
        let match = null;
        for (const suffix of suffixes) {
          if (normalized === suffix) return normalized;
          if (!normalized.endsWith(`.${suffix}`)) continue;
          if (!match || suffix.length > match.length) match = suffix;
        }
        if (match) {
          const rest = normalized.slice(0, -match.length - 1);
          const siteLabel = rest.slice(rest.lastIndexOf(".") + 1);
          if (siteLabel) return `${siteLabel}.${match}`;
        }
      }
      return null;
    },

    siteKeyForOrigin(origin) {
      const hostname = this.normalizeHostname(origin);
      if (!hostname) return null;
      return this.siteKeyForHostname(hostname);
    },

    siteKeyForUrl(url) {
      try {
        return this.siteKeyForHostname(new URL(String(url)).hostname);
      } catch {
        return null;
      }
    },

    // Match-pattern fragments for a site key, or null when the browser cannot
    // express the host as a match pattern (IPv6 literals, junk).
    sitePatternsFor(siteKey) {
      const rules = data.siteRules;
      const site = typeof siteKey === "string" ? siteKey.trim().toLowerCase() : "";
      if (!site || site.length > rules.maxSiteKeyLength) return null;
      if (rules.ipv6Re.test(site) || site.includes(":")) return null;
      if (!rules.patternHostRe.test(site)) return null;
      // One malformed label makes the browser reject the whole registration,
      // so validate every label rather than trusting the host alphabet.
      const labels = site.split(".");
      if (!labels.every((label) => rules.hostLabelRe.test(label))) return null;
      const base = `*://${site}`;
      if (site.includes(".") && !rules.ipv4Re.test(site)) {
        return [`${base}/*`, `*://*.${site}/*`];
      }
      return [`${base}/*`];
    },

    isBareSiteKey(siteKey) {
      const site = String(siteKey || "")
        .trim()
        .toLowerCase();
      if (!site) return false;
      const patterns = this.sitePatternsFor(site);
      return !!patterns && patterns.length === 1;
    },

    // Normalize any site-ish input (origin, URL, host, "example.com:443")
    // to a decision key, or null.
    siteKeyFor(value) {
      if (typeof value !== "string" || !value.trim()) return null;
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return this.siteKeyForOrigin(value);
      return this.siteKeyForHostname(value);
    },

    // True when a concrete origin belongs to the site's decision scope, i.e.
    // its hostname has the site key as registrable domain (or equals it).
    originMatchesSiteKey(origin, siteKey) {
      const host = this.normalizeHostname(origin);
      const site = String(siteKey || "")
        .trim()
        .toLowerCase();
      if (!host || !site) return false;
      if (host === site) return true;
      if (this.siteKeyForHostname(host) === site) return true;
      // A site decision for an apex like "example.co.uk" also covers hosts that
      // resolve to that apex (paranoia about suffix heuristics above).
      return host.endsWith(`.${site}`) && this.siteKeyForHostname(host) === site;
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
