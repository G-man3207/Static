# Per-site protection (Static 2.8)

Static 2.8 makes per-site masking the default: it watches each page, tells you what the page was
doing, recommends whether masking is worth it there, and masks the site only after you choose. This
document is the reference for that behavior and its architecture — modes, site identity, storage,
the scout and its fixed catalog, the recommendation engine, the scoped network and header defenses,
the popup and sites-page UI, and the test strategy. It describes Static 2.8.0.

Read it alongside [README: Protection modes](../README.md#protection-modes-default-per-site) for the
user-facing summary and [PRIVACY.md](../PRIVACY.md) for the data policy. File names and UI ids in
this document are the shipped ones, so it can be read with the source open.

## Why per-site

Static protects one thing very well — a page cannot reliably tell which extensions
you have installed — and one thing very aggressively: on every site it rewrites the
user agent, blocks extension-style requests, scrubs DOM markers, normalizes iframes
and styles, and (opt-in) poisons device signals. On a growing set of sites that use
extension enumeration, bot checks, or user-agent sniffing as part of sign-in and
checkout, that aggressiveness is itself the breakage. PayPal and Discord are the
canonical examples: the page is not hostile, it just runs a script Static gets
between.

So v2.8 flips the default. Static watches each page, tells you what the page was
doing, and masks that page **only after you say so**. "Mask everywhere" remains one
click away — it is the old behavior, not the old default.

This is also the default _decision model_ going forward: no site is masked behind
your back, and no masking is silently skipped where the extension was already
telling you it matters.

## Modes

`protection_mode` is `"per_site"` (default) or `"always"`. The popup labels them **Only sites I
choose** and **Every site**; this document uses the internal names when talking about storage and
messages and the popup labels when talking about UI.

| Mode       | Page code                                                              | Network vendor lists     | UA / Client Hints                        | Popup card                                         |
| ---------- | ---------------------------------------------------------------------- | ------------------------ | ---------------------------------------- | -------------------------------------------------- |
| `per_site` | scout scripts on unknown/opted-out sites; full stack on opted-in sites | scoped to opted-in sites | rewritten on opted-in sites only         | evidence + recommendation + Protect / Leave it off |
| `always`   | full stack everywhere except paused sites                              | global (today)           | rewritten everywhere except paused sites | today's pause toggle + recovery card               |

"Opted-in" means `site_decisions[siteKey].state === "on"`. Sites with `"off"` or no
record are not masked in `per_site` mode; they only run the scout.

The recommendation is **advisory**: neither mode auto-enables or auto-disables a
site, and no feature switch flips because of evidence. Only the explicit popup
buttons, sites-page actions, and mode radios write. A left-off site keeps the
scout running but shows no badge count, so the UI does not nag about a decision
you already made; the new evidence is visible when you open the popup or the sites
page. The "defences off" notes are read-time derivations from the same counters and
the current settings, never a second store.

Switching modes takes effect on reload for pages already open. From the popup the
active tab reloads immediately; the sites page changes the stored mode but does not
reload other tabs, so they pick it up on their next navigation. There is no separate
mode event: after a mode or decision change the service worker re-broadcasts
`static_persona_update`, each bridge re-fetches `static_get_persona`, and the
response's `disabled` flag (now `!maskedHere`) makes a still-open full-stack page
pass through immediately. That is the live-off path; a page that becomes masked, or
a page that needs the scout instead of the full stack, still needs the reload.

## Sites, not origins

Decisions are keyed by **site**: the registrable domain, or the literal host for
bare hosts (IP, `localhost`) and single-label hosts.

- `https://www.paypal.com/login` → `paypal.com`
- `https://a.b.example.co.uk` → `example.co.uk`
- `http://127.0.0.1:8642` → `127.0.0.1`
- `http://localhost:3000` → `localhost`
- `http://docs.internal` → `docs.internal`

A decision covers the whole site, every scheme, every port, every subdomain:

- open on `https://www.example.com`, press **Protect this site** → `example.com`,
  `www.example.com`, `api.example.com`, `http://example.com:8080` all get the full
  stack;
- pausing in `always` mode keeps today's origin-ish semantics and is unchanged.

Multi-tenant suffixes get one label of "site" extra so decisions do not leak across
tenants: `alice.github.io` → `alice.github.io`, `bob.github.io` → `bob.github.io`.
The shipped list (46 entries, from `lists.js`) is:
`.s3-website.amazonaws.com`, `.s3.amazonaws.com`, `.amplifyapp.com`, `.appspot.com`,
`.azureedge.net`, `.azurewebsites.net`, `.bitbucket.io`, `.blogspot.com`, `.cloudfront.net`,
`.codesandbox.io`, `.deno.dev`, `.firebaseapp.com`, `.fly.dev`, `.gitbook.io`, `.github.io`,
`.githubusercontent.com`, `.gitlab.io`, `.glitch.me`, `.herokuapp.com`, `.neocities.org`,
`.netlify.app`, `.ngrok-free.app`, `.ngrok.io`, `.notion.site`, `.observableusercontent.com`,
`.onrender.com`, `.pages.dev`, `.railway.app`, `.readthedocs.io`, `.repl.co`, `.replit.app`,
`.squarespace.com`, `.stackblitz.io`, `.stores.jp`, `.substack.com`, `.super.site`, `.surge.sh`,
`.trycloudflare.com`, `.tumblr.com`, `.val.town`, `.vercel.app`, `.web.app`, `.weebly.com`,
`.wixsite.com`, `.wordpress.com`, `.workers.dev`.

Two-label public suffixes come from a built-in `secondLevelSuffixes` list of
**236** common entries (`co.uk`, `com.au`, `co.jp`, `com.br`, `co.in`, `com.mx`,
`com.tr`, `co.za`, `com.cn`, `com.ua`, …); it is a heuristic subset of the Public
Suffix List, not the whole PSL. A private or unusual multi-label suffix outside the
list may therefore keep sibling subdomains together. Any `*.localhost` name maps to
the `localhost` site. IPv6 literals are keyed as their bracketed host (`[::1]`);
Chrome match patterns cannot express an IPv6 literal, so a decision for one is
stored but only `always` mode can cover that page.

The full suffix lists live in `lists.js` (`siteRules.multiTenantSuffixes`,
`siteRules.secondLevelSuffixes`) and are shared by the service worker and static
tests; the scout does not need them.

Ports never enter a decision. `localhost:3000` and `localhost:8080` are one site, as
they are one pause entry today.

## Storage schema

All keys are `chrome.storage.local`. Existing keys are untouched.

| Key                      | Default               | Shape / caps                                                                                                                                                                                                                                                   |
| ------------------------ | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protection_mode`        | `"per_site"`          | `"per_site"` \| `"always"`                                                                                                                                                                                                                                     |
| `site_decisions`         | `{}`                  | `{ [siteKey]: { state: "on"\|"off", at: number, source: "popup"\|"sites-page", probesAt?: number } }`, max 250 `on` + 250 `off` (`MAX_SITE_DECISIONS`, one cap per state), newest kept; `probesAt` records the observed probe total when the site was left off |
| `site_evidence`          | `{}`                  | `{ [siteKey]: Evidence }`, max 200 sites (`MAX_EVIDENCE_SITES`), least recently seen evicted                                                                                                                                                                   |
| `onboarding_dismissed`   | `false`               | bool                                                                                                                                                                                                                                                           |
| `ruleset_prefs`          | `null` until captured | `{ fingerprint_vendors: bool, captcha_vendors: bool }` — today's per-ruleset intent; captured once from `getEnabledRulesets()` so upgrades keep the old choice                                                                                                 |
| `ruleset_prefs_captured` | `false`               | bool                                                                                                                                                                                                                                                           |

Two internal keys ride along with these and are not user settings. The scout
evidence handler writes `tab_seen`; the UA-header reconciler writes
`header_rules_mode`. Nothing reads them except the badge/reconciler code:

| Key                 | Shape                                                                        | Purpose                                                                                        |
| ------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `tab_seen`          | `{ [tabId]: { at, total, ids: [[extId, count], …] } }`, max 30 tabs × 10 IDs | Per-tab observed counters so the badge/popup keep their number across a service-worker restart |
| `header_rules_mode` | `"per_site"` \| `"always"`                                                   | Marks which key shape `header_rules` uses (site keys vs origins), so a mode switch rebuilds    |

`tab_seen` is dropped for a tab when that tab closes or navigates, and by **Clear log**.

`Evidence`:

```js
{
  firstSeen: 0,            // ms, clamped
  lastSeen: 0,             // ms, clamped
  pages: 0,                // top-frame loads that produced evidence, capped 1e6
  probes: {
    total: 0,              // extension-URL requests seen, capped 1e9
    ids: { "<ext id>": 0 },// <= 300, lowercased, Chrome or UUID shape
    vectors: { "fetch": 0, "img": 0, ... }, // <= 24, canonical vector names
    pathKinds: { "manifest": 0, "image": 0, ... } // <= 20, from lists.pathKindFor
  },
  vendors: { "<vendor id>": 0 },  // <= 40; presence, 1 per page
  device: { "<surface id>": 0 },  // <= 30; read counts, clamped 1e6 per message
  replay: { "<sdk id>": 0 },      // <= 20; presence, 1 per page
  compat: { "<compat id>": 0 },   // <= 24; presence 1, repeated <= 3 for
                                  //   bot_challenge / captcha / cross_origin_frame
  uaReads: 0,                     // <= 1e6, cumulative reads
}
```

Incoming counts are clamped per message (`maxSignalCount` = 1e6); compat counts are
additionally clamped to 100 by the sanitizer. Evidence never stores page URLs,
paths, titles, form values, query strings, cookies, or text content. Probe URLs are
reduced to extension ID + sanitized path + path kind before storage; the raw URL is
not persisted. Vendor/device/replay/compat keys are fixed catalogs, so an unknown
key is dropped rather than stored. A recommendation is derived at read time and is
not written into evidence.

## Detection: the scout (MAIN world, no masking)

The scout is three MAIN-world files plus the shared catalog. `service_worker_utils.js`
registers them after the full-stack script list, in this order:

```js
SCOUT_MAIN_SCRIPTS = [
  "block_utils.js", // shared helpers: wrappers, stealth, URL/path classification
  "signals.js", // fixed catalog (vendors/device/replay/compat/vectors), data only
  "scout.js", // orchestrator + bus + batching + launch/lifecycle
  "scout_probes.js", // probe vectors (40 wrappers + MutationObserver backstop)
  "scout_signals.js", // vendor / device / replay / compat observation
];
SCOUT_ISOLATED_SCRIPTS = ["lists.js", "bridge.js"];
```

`scout.js` captures `__static_block_utils__` and `__static_signals__` into a
closure, installs one temporary non-enumerable `__static_scout__` bus, and
deletes all three globals once both modules report `ready()` (12 retries at 10 ms
cover unusual ordering). It runs at `document_start`, in every frame, on every
page where the scout pair is registered — i.e. per-site mode, on sites whose
decision is not `on`. Every entry point is `try`/`catch`: a scout bug can lose a
hint, but cannot change a page result or surface as a page error.

### Probe observation (`scout_probes.js`)

Wrappers are strict pass-throughs: the native implementation runs with the page's
own `this`, arguments, return value, thrown value, property descriptors, and
promise identity; `Function.prototype.toString` (via `block_utils.js` stealth)
never reveals the wrapper. Counting happens around the native call, so a
page-visible result is identical with or without the scout.

The fast path is a single `indexOf("-extension:")` on every value. Only a value
that hits the needle is parsed with the native `URL` constructor and matched
against the per-scheme extension-ID regex; URLs without that substring never pay
for a parse. A probe URL is reduced to `scheme://extension-id/sanitized-path`
(query and fragment removed, path lowercased/limited to 96 chars, only
`[a-z0-9._-/]` kept) before it leaves the module.

**At most 40 wrapper installs** (the `MAX_PROBE_INSTALLS` ceiling; 40 in a full
Chromium profile), one per vector:

- **Callers:** `fetch` (string, `URL`, `Request`; including relative strings),
  `XMLHttpRequest.open`, `navigator.sendBeacon`, `Worker`, `SharedWorker`,
  `EventSource`, `Audio`, `Image`, `Worklet.prototype.addModule`.
- **URL-reflecting properties:** `HTMLImageElement.src`/`srcset`,
  `HTMLScriptElement.src`, `HTMLLinkElement.href`, `HTMLIFrameElement.src`,
  `HTMLSourceElement.src`/`srcset`, `HTMLVideoElement.poster`,
  `HTMLMediaElement.src`, `HTMLObjectElement.data`, `HTMLEmbedElement.src`,
  `HTMLFormElement.action`, `HTMLBaseElement.href`, `HTMLAnchorElement.href`,
  `HTMLAreaElement.href`, `HTMLInputElement.src`, `HTMLTrackElement.src`.
  The element tag decides the canonical vector (`img`, `img-srcset`, `script`,
  `link`, `iframe`, `source`, `video-poster`, `audio`, `media`, `object`, `embed`,
  `form`, `base`, `anchor`, `area`, `input`, `track`, `image-ctor`, `audio-ctor`).
- **`Element.prototype.setAttribute`** for the same URL attributes.
- **CSSOM:** `CSSStyleSheet.insertRule` / `addRule` / `replace` / `replaceSync`,
  `CSSStyleDeclaration.setProperty`, and the `cssText` setter.
- **Markup sinks:** `Element.prototype.innerHTML` / `outerHTML`,
  `insertAdjacentHTML`, `ShadowRoot.prototype.innerHTML`,
  `DOMParser.parseFromString`, `Range.createContextualFragment`,
  `document.write`.
- **MutationObserver backstop:** childList + subtree + attributes (filtered to
  `action data formaction href poster src srcset style`) + characterData, with a
  per-batch node budget. It catches parser-inserted markup, `cloneNode`, and
  attribute paths that are not wrapped, attributes each hit to the right vector,
  and re-scans `<style>`/`<script>` text for extension URLs (deduped per node by
  text value). It is the only observer, it is microtask-batched, and it is
  disconnected on finalize. Text already reported through a wrapper is skipped by
  the attribute weak-map, so a setter does not double-count its observer record.

A probe is counted as `{url, where, count}`; identical URL+vector pairs coalesce
into one entry with a count. `where` is validated against the catalog's `vectors`
list and falls back to `unknown`. The page gets no signal that a probe was seen.

### Signal observation (`scout_signals.js`)

The second observer module covers non-probe behavior. It is loaded after
`scout_probes.js` and reports deltas through the same bus:

1. **Fingerprint vendors.** Resource URLs (from the same `PerformanceObserver`
   `resource` path, initial `document.scripts`/`link` scan, and the wrapped
   URL consumers) and vendor globals are matched against the `signals.js`
   catalog. Globals are checked at `load` and on a short post-load interval;
   vendor-prefixed objects are only presence-checked, never serialized.
2. **Device readbacks.** Counted pass-through wrappers/readback hooks for the
   catalog surfaces: canvas `toDataURL` / `toBlob` / `getImageData` / `measureText`,
   WebGL `getParameter` (the `UNMASKED_*` names), `OfflineAudioContext` /
   `AudioBuffer` reads, font APIs (`document.fonts.check/load/values`, font-
   dependent `measureText`), `navigator.hardwareConcurrency` / `deviceMemory` /
   `languages` / `plugins` / `userAgentData.getHighEntropyValues`,
   `Intl.DateTimeFormat().resolvedOptions()`, `navigator.storage.estimate()`,
   `RTCPeerConnection`, `navigator.mediaDevices.enumerateDevices()`,
   `navigator.getBattery()`, `navigator.permissions.query`, `screen.*`,
   `navigator.connection`, and `document.fonts`.
3. **User-agent reads.** A getter on the `Navigator` user-agent surfaces
   (`userAgent`, `appVersion`, `platform`, `userAgentData`) counts reads, batched
   into `uaReads` deltas.
4. **Replay SDKs.** Script/source URLs and SDK globals from the replay catalog
   (`LogRocket`, `FullStory`, `hj`/Hotjar, `smartlook`, `mouseflow`, `clarity`,
   `OpenReplay`, `Sentry.replayIntegration`, `DD_RUM`, `posthog`, `rrweb`, …).
   The catalog lists both hosts and dotted globals; a global is only
   presence-checked. Detection only; Replay poisoning remains opt-in and
   independent.
5. **Compatibility signals.** DOM-observable, presence-first facts:
   - a password/email/card field by `type`, `autocomplete`, `name`, or `id`
     tokens (card tokens: `cc`, `card`, `credit`, `debit`, `payment`, `pan`,
     `cvv`, `cvc`, `csc`, `expiry`, `security code`; an `autocomplete` value
     starting with `cc-` also counts);
   - `login` / `signin` / `sign-in` / `auth` / `sso` / `session/new` /
     `users/sign_in` in the path, and `checkout` / `payment` / `pay` / `billing` /
     `purchase` / `order` / `subscribe` / `cart` / `wallet` in the path;
   - a form `action` or link `href` to a known auth host or an OAuth/SSO path
     (`accounts.google.com`, `login.microsoftonline.com`, `auth0.com`,
     `okta.com`, `github.com`, `gitlab.com`, `bitbucket.org`, `appleid.apple.com`,
     `facebook.com`, `linkedin.com`, `twitter.com`, `x.com`, `slack.com`,
     `dropbox.com`, `salesforce.com`, `shopify.com`, `paypal.com`, `amazon.com`,
     `/oauth`, `/authorize`, `/openid`, `/sso`, `/saml`, `/signin`, `/login`,
     `/auth`);
   - an `iframe[src]`/`frame[src]` on a different http(s) host → cross-origin
     frame; CAPTCHA markup (`[data-sitekey]`, `.g-recaptcha`, `.h-captcha`,
     `.cf-turnstile`, `.frc-captcha`, `altcha-widget`, `[data-pcallback]`) →
     `captcha`;
   - a `captcha`-kind vendor (Arkose, Turnstile, hCaptcha, reCAPTCHA, …) or a
     `bot`-kind vendor (DataDome, PerimeterX, Kasada, Cloudflare, Akamai, …) in
     a resource URL, script `src`, iframe `src`, or vendor global →
     `bot_challenge`;
   - `navigator.credentials.create/get(...)` with a `publicKey` option →
     WebAuthn; `PaymentRequest` construction → payment request;
   - `<meta http-equiv="Content-Security-Policy">` containing
     `require-trusted-types-for` → Trusted Types.

   Everything else is presence-only: the first observation is stored as 1, and
   `bot_challenge`, `captcha`, and `cross_origin_frame` may accumulate to 3
   because repeats matter. Vendor resources are matched against catalog host
   suffixes and path prefixes (not arbitrary substrings); a catalog entry without
   a dot (`cdn-cgi`) is a path fragment. An unknown key is dropped by the service
   worker's sanitizer.

The signal module never reads form values, cookies, `localStorage` values, or
text content. `input` classification reads only `type`, `autocomplete`, and
`name` attributes; path classification uses only the current pathname; a vendor
global is read only to test whether the path exists (the value itself is not
kept). A signal row is stored as catalog key + count; an unknown key is dropped by
the service worker's sanitizer.

### Cost ceilings (hard)

The constants are in the two scout files; the static harness asserts the
install/wrapper budget.

- **One MutationObserver** per frame: childList + subtree + characterData +
  filtered `attributes`, on `document.documentElement`; 500 element scans per
  batch (`MAX_OBSERVED_NODES`), 64 URLs reported per individual event
  (`MAX_URLS_PER_EVENT`), disconnected on finalize.
- **At most 40 probe wrapper installs** (`MAX_PROBE_INSTALLS`; 40 in a full
  Chromium profile). The signal module is a fixed, catalog-driven set too; no
  per-page dynamic registration.
- **Fast path first:** a string without `"-extension:"` is never parsed. Only a
  hit is normalized with the native `URL` constructor and matched against the
  per-scheme ID pattern.
- **Per-frame caps:** ≤200 probe entries (`MAX_PROBES_PER_PAGE`), ≤300 distinct
  extension IDs, ≤24 vectors, ≤40 vendor keys, ≤30 device keys, ≤20 replay keys,
  ≤24 compat keys. Extra probe activity is counted into `overflow` instead of
  enumerated; the service worker then merges frames into the per-site Evidence
  under the same map caps.
- **Per scheme/vector event caps:** one coalesced entry per URL+vector; at most
  64 URL matches per attribute string.
- **Report budget:** one batch per 250 ms of activity (`FLUSH_DELAY_MS`), plus one
  on `load`, one idle safety flush at 1500 ms, and one on `pagehide` /
  `visibilitychange→hidden`. A burst budget of **60 messages per frame document**
  (`MAX_MESSAGES`) then starts a refill: after the 60th batch the frame sends at
  most one more batch per 2 s (`MESSAGE_REFILL_MS`) for as long as it keeps
  probing, so a long-lived page is delayed, never frozen, and a pathological
  loop stays bounded to roughly one message per two seconds. The bridge port
  queue is capped at 2000 messages.
- **DOM sweeps (per frame):** max 400 fields/actions/scripts, max 200 frames, three
  sweeps at 0 / 400 / 1500 ms plus `DOMContentLoaded` and `load`; recent resources
  deduped in a `Set` capped at 1000, style/script text deduped per node in a
  `WeakMap`.
- **Never read:** form values, cookies, `localStorage`/`sessionStorage` values,
  page text content. The only element text read is `<style>`/`<script>` content
  (to look for an extension URL), and the only field attributes read are `type`,
  `autocomplete`, `name`, and `id` (to classify a field). Native constructors,
  timers and event-target methods are captured before page script runs.
- **Failure containment:** every observation path, wrapper and timer callback is
  inside `try`/`catch`; a scout failure may lose a hint but must not surface as a
  page error, a rejected page promise, or a changed return value. Listeners use
  the captured native `addEventListener` where possible; the bridge hop is the
  only async edge, and it is required for page invisibility.

### Bridge additions

`bridge.js` (ISOLATED world) gains one port event, `__perf_scout_bi__`, handled by
the same `createPort` machinery, and forwards it without checking the masking
`disabled` flag (the scout's pages are "disabled" for masking by definition).
`scout.js` uses `U.setupBridge("__perf_scout_bi__", 2000, …)`. The port carries:

```js
// scout -> bridge, batched
{
  type: "site_evidence",
  seq: 1,                       // monotonic per frame; the bridge dedupes
  probes: [{                    // <= 200 entries, URL+vector coalesced
    url: "chrome-extension://<id>/<sanitized path>",
    where: "fetch",
    count: 3,
  }],
  overflow: 0,                  // probe events seen but not enumerated
  signals: {                    // deltas since the last message
    uaReads: 12,
    vendors: { fingerprintjs: 1 },   // presence, 1 per page
    device: { canvas: 4 },           // read counts
    replay: { logrocket: 1 },        // presence, 1 per page
    compat: { password_field: 1 }    // presence, <= 3 for repeated kinds
  }
}
```

Why a `seq` and a drain path: the port is a task-queue delivery, and `pagehide`
can end the document before its last `postMessage` is delivered. `bridge.js`
therefore dispatches a synchronous `__static_scout_drain__` `CustomEvent` on
`pagehide` and on `visibilitychange→hidden`; the scout's listener builds the final
batch synchronously, serializes it into `event.detail.payload`, and the bridge
forwards that JSON if it is newer than `lastScoutSeq`. The service worker never
sees `seq` (the bridge drops duplicate batch numbers); drains are idempotent, so
the last <250 ms of probes are not lost.

The bridge forwards `{ type: "static_site_evidence", probes, overflow, signals }`.
Probe-count overflow is preserved (`overflow: 0` or a positive count). Probe
contents are sanitized in the service worker, not in the bridge; the bridge only
guards the per-page queue depth (2000 messages are dropped by the bridge's own
`setupBridge` cap) and the duplicate-batch number. The service worker attributes
the report to the **top-level tab URL**, not `sender.url`, so a probe inside a
third-party frame still counts for the page the user decided about.

## Recommendation engine: `site_signals.js`

Pure functions, no `chrome.*` access, loaded in the service worker
(`importScripts` after `lists.js` and `signals.js`) and in the Node/vm test harness.
Exposed as `globalThis.__static_site_signals__`.

```js
{
  COMPAT_COPY, HEADLINES, LIMITS,
  emptyEvidence(now) -> Evidence,
  mergeEvidence(current, patch, now) -> Evidence,   // pure, never throws
  evidenceSummaryFor(evidence) -> compact UI record | null,
  summarizeEvidence(evidence) -> string,            // sites-page evidence line
  sanitizeEvidence(entry) -> Evidence | null,       // defensive read path
  probePatchFor(probes, overflow) -> Patch,         // scout probe report -> ids/vectors/pathKinds
  signalPatchFor(signals) -> Patch,                 // scout signal report, catalog-whitelisted
  sanitizePrefs(prefs) -> { fingerprint_vendors, captcha_vendors },
  recommendationFor(evidence, context) -> Recommendation, // always an object
}
```

`evidenceSummaryFor` returns null for no evidence; `summarizeEvidence` returns
`""` then. `recommendationFor` always returns the full shape (a neutral,
`observed:false` record when there is nothing to say), so the popup does not have
to null-check it.

`context`:

```js
{
  mode: "per_site" | "always",
  decision: "on" | "off" | "undecided",
  fingerprintMode: "off" | "mask",
  replayMode: "off" | "mask" | "noise" | "chaos",
  rulesetPrefs: { fingerprint_vendors: bool, captcha_vendors: bool },
  compatWarning: null | { total, kinds: [[kind, n]], lastUpdated }, // current site, fresh only
  pausedBefore: bool,          // site was paused (always mode) at some point: disabled_origins has it
  now: number,                 // injected for tests
}
```

Unknown fields are ignored; `decision`/`mode` default to undecided/per-site;
`now` defaults to `Date.now()`.

`Recommendation`:

```js
{
  verdict: "protect" | "skip" | "neutral",
  confidence: "low" | "medium" | "high",
  benefit: 0..~140,            // active full weight + inactive quarter weight
  risk: 0..100,                // capped at 100
  margin,                     // benefit - risk
  headline: "We suggest masking here",  // one of 6 fixed strings (see below)
  summary: "…",               // one or two sentences from fixed templates
  decisionHint: "Protect this site" | "Leave it off" | "Your call",
  benefits: [{ key, text, detail, defense, active, weight }], // strongest first, <= 3
  risks:    [{ key, text, detail?, weight }],                 // strongest first, <= 3
  notes:    [{ key, text, detail }],  // observations whose defence is off, <= 2
  benefitCount, riskCount, noteCount, // totals before the display slice
  caution: bool,          // verdict protect && risk >= 20
  stale: bool,            // lastSeen older than 30 days
  observed: bool,         // any evidence at all
  confidenceScore: 0..100,
}
```

`Recommendation`:

```js
{
  verdict: "protect" | "skip" | "neutral",
  confidence: "low" | "medium" | "high",
  benefit: 0..~140, risk: 0..100, margin,
  headline: "We suggest masking here",     // one of 6 fixed strings (see below)
  summary: "…one sentence, <= 140 chars…",
  decisionHint: "Protect this site" | "Leave it off" | "Your call",
  benefits: [{ key, text, defense, active, weight }], // strongest first, <= 3
  risks:    [{ key, text, weight }],                  // strongest first, <= 3
  notes:    [{ key, text }],                          // observations with their defense off, <= 2
  caution: bool,          // verdict protect && risk >= 20
  stale: bool,            // lastSeen older than 30 days
  observed: bool,         // any evidence at all
  confidenceScore: 0..100,
}
```

Verdict copy (fixed):

| verdict   | confidence | headline                              |
| --------- | ---------- | ------------------------------------- |
| `protect` | high       | `We suggest masking here`             |
| `protect` | medium     | `Masking here is worth it`            |
| `protect` | low        | `Masking here is probably worth it`   |
| `skip`    | high       | `We suggest leaving masking off here` |
| `skip`    | medium/low | `Masking might get in the way here`   |
| `neutral` | any        | `No strong signal here`               |

### Scoring

All weights are in `signals.js` (`weight` per catalog row, `risk` per compat
row) plus engine constants in `site_signals.js`. Benefit is rounded to an
integer; risk is capped at 100.

**Probe bands** (`defense: "probes"`, active whenever a site is masked):

| total probes | 0   | ≥1  | ≥20 | ≥100 | ≥1000 | ≥5000 |
| ------------ | --- | --- | --- | ---- | ----- | ----- |
| points       | 0   | 6   | 12  | 18   | 24    | 30    |

| distinct IDs | 0   | ≥3  | ≥10 | ≥25 |
| ------------ | --- | --- | --- | --- |
| points       | 0   | 3   | 6   | 9   |

| distinct probe vectors | 0   | ≥2  | ≥4  |
| ---------------------- | --- | --- | --- |
| points                 | 0   | 3   | 6   |

The extension-checks row is `total band + ID band`; the "tried N ways" row is the
vector band, and only appears when there are at least 2 vectors. A site with
1 probe, 1 ID, 1 vector scores 6 + 0 + 0 = 6, which is below the decision floor.

Vendor/device/replay rows use the catalog weight and their defence:

| row kind              | `defense` | active when                         | per-row weight | group cap |
| --------------------- | --------- | ----------------------------------- | -------------- | --------- |
| `fingerprint` vendor  | `network` | `ruleset_prefs.fingerprint_vendors` | catalog (10)   | 26        |
| `bot` vendor          | `network` | same                                | catalog (8)    | 20        |
| `payment` vendor      | `network` | same                                | catalog (8)    | 12        |
| `captcha` vendor      | `network` | `ruleset_prefs.captcha_vendors`     | catalog (5)    | 10        |
| device strong surface | `device`  | `fingerprintMode === "mask"`        | catalog (5)    | 20        |
| device weak surface   | `device`  | same                                | catalog (2)    | 8         |
| replay SDK            | `replay`  | `replayMode !== "off"`              | catalog (6)    | 12        |

Rows are sum-capped per group, so six fingerprint vendors do not outrank a page
that probed for thousands of extensions. Probes themselves are capped at 60
points (unreachable in practice from the bands above).

An **inactive** row (defence off) contributes `round(points * 0.25)` to the
benefit total and its text moves to `notes` with the defence-off detail; an
active row contributes full points to `benefits`. This is why the same canvas
read can be a benefit in one install and a note in another.

**Risk rows:**

| key                                 | weight             | notes            |
| ----------------------------------- | ------------------ | ---------------- |
| `password_field`                    | 12                 | presence         |
| `login_path`                        | 8                  | presence         |
| `email_field`                       | 6                  | presence         |
| `card_field`                        | 16                 | presence         |
| `checkout_path`                     | 12                 | presence         |
| `payment_request`                   | 10                 | presence         |
| `captcha`                           | 10                 | ×count, cap ×3   |
| `bot_challenge`                     | 12                 | ×count, cap ×3   |
| `webauthn`                          | 10                 | presence         |
| `oauth_redirect`                    | 10                 | presence         |
| `trusted_types`                     | 4                  | presence         |
| `cross_origin_frame`                | 4                  | ×count, cap ×3   |
| UA reads ≥ 8 / ≥ 40                 | +8 / +14           | one row          |
| vendor kind `bot` present           | +8 per row, cap 16 | one combined row |
| vendor kind `payment` present       | +6 per row, cap 12 | one combined row |
| CAPTCHA vendor, no compat `captcha` | +8 per row, cap 16 | one combined row |
| `pausedBefore`                      | 18                 | one row          |
| fresh `compatWarning`               | 25                 | first row        |

The ×count cap of 3 applies only to `captcha`, `bot_challenge`, and
`cross_origin_frame`; every other compat signal is presence-only. Totals are
capped at 100.

### Verdict matrix

`verdictFor(benefit, risk)` is evaluated top to bottom, first match wins. Each
band also carries its confidence, so a lone field and a field under a heavy
probe load can both be `skip` without claiming the same evidence:

```text
if benefit < 8 && risk < 8
  → neutral, low
if risk >= 25 && benefit < risk * 1.5
  → skip, confidence: (risk >= 45 || benefit < risk * 0.75) ? high : medium
if benefit >= 18 && benefit - risk >= 12
  → protect, confidence: (benefit - risk >= 35 || benefit >= 50) ? high : medium
if benefit >= 12 && benefit - risk > 0
  → protect, low
if risk >= 15 && benefit - risk < 0
  → skip, confidence: (risk - benefit >= 25 || risk >= 35) ? high : medium
if risk >= 10 && benefit - risk <= 0
  → skip, low
else
  → neutral, low
```

There is no separate margin formula: confidence is the matrix's annotation for
the band that matched. `benefit` includes the quarter weight of a signal whose
defence is off, while the honesty rule below prevents a `protect` band from
surviving when _no_ defence is on.

Overrides after the matrix:

- `compatWarning` fresh (masking broke a request on the current site within
  30 min) → `skip`, `high`, `caution:false`; the warning row moves first in
  `risks`.
- `stale` (`lastSeen` older than 30 days) → confidence `low`; if the decision is
  `undecided`, verdict `neutral`; summary becomes
  `Nothing seen here in the last month. A fresh visit will reassess.`
- `verdict === "protect"` with zero active benefit rows → `neutral` (honesty
  rule: never recommend masking for a signal every one of whose defences is off).
- A **left-off** decision does not change the derived verdict; it only changes
  presentation (`Since you turned it off…`, no verdict badge, no nag).
- No evidence at all (raw `recommendationFor`) → `neutral`, low, empty lists,
  `observed:false`, summary "Static hasn't seen this page do anything it can
  mask." The service worker does not even build the recommendation in that case:
  `site.recommendation` is `null`, and the popup shows **Nothing seen here yet**
  with its own longer beta copy.

Display slices (`benefits`, `risks`, `notes`) are capped at 3 / 3 / 2; the
`benefitCount`, `riskCount`, and `noteCount` fields keep the totals.
`confidenceScore = clamp(40 + |benefit - risk| * 0.8 + (high ? 20 : 0), 0, 100)`.

`caution` is `verdict === "protect" && risk >= 20`; it is cleared by the compat
override. The popup renders the fixed line "If sign-in misbehaves, leave this site
off." No colour change, no badge.

### Reason text (exact templates; digits use `toLocaleString("en-US")`)

`COMPAT_COPY` / the engine's row builders are the source of truth. A row's
`text` is the heading; `detail` is the small print; `defense` names the switch
that would hide it.

**Benefits:**

| key                                   | text                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension_checks`                    | `Checked whether a browser extension is installed` when N=1, else `Checked whether {N} browser extensions are installed`; detail `{probes} probes · {ids} IDs · {vectors} request types`                                                                                                                                                                                                                        |
| `probe_vectors`                       | `Tried {N} ways to detect extensions`; detail `{N} request types · {k} resource kinds`                                                                                                                                                                                                                                                                                                                          |
| `vendor:<id>` fingerprint/bot/payment | fingerprint: `Loads {label} (device fingerprinting)`; bot: `Runs {label} bot checks`; payment: `Runs {label} risk checks`                                                                                                                                                                                                                                                                                       |
| `vendor:<id>` captcha                 | `Loads a {label} challenge`                                                                                                                                                                                                                                                                                                                                                                                     |
| `device:<id>`                         | `Read your {label}` — labels are noun phrases from the catalog (`canvas image data`, `WebGL renderer strings`, `audio fingerprint`, `installed fonts`, `CPU and memory`, `screen geometry`, `device timezone`, `language list`, `storage quota`, `WebRTC network info`, `camera and microphone list`, `battery status`, `Client Hints`, `plugin list`, `permission states`, `connection type`, `codec support`) |
| `replay:<id>`                         | `{label} can record this page`                                                                                                                                                                                                                                                                                                                                                                                  |

**Risks:**

| key                  | text                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `password_field`     | Has a sign-in form                                                                                 |
| `login_path`         | Is a sign-in page                                                                                  |
| `email_field`        | Has an email field                                                                                 |
| `card_field`         | Has a card or payment form                                                                         |
| `checkout_path`      | Looks like a checkout or payment step                                                              |
| `payment_request`    | Can start a payment sheet                                                                          |
| `captcha`            | Shows a CAPTCHA                                                                                    |
| `bot_challenge`      | Runs bot checks                                                                                    |
| `webauthn`           | Uses passkeys                                                                                      |
| `oauth_redirect`     | Redirects through third-party sign-in                                                              |
| `trusted_types`      | Enforces Trusted Types                                                                             |
| `cross_origin_frame` | Embeds third-party sign-in frames; detail `{count} cross-site frames`                              |
| `ua_reads`           | `Reads your browser user agent {N} times` (N≥8); detail `light sniffing` (<40) or `heavy sniffing` |
| `bot_vendor`         | `A bot check guards this page ({labels})`                                                          |
| `payment_vendor`     | `A fraud check screens this page ({labels})`                                                       |
| `captcha_vendor`     | `Shows a CAPTCHA challenge` (only when compat `captcha` is absent)                                 |
| `compat_warning`     | `Masking already interrupted a request here`; detail `{kind} ×{count}`                             |
| `paused_before`      | `You paused Static here before`                                                                    |

**Notes** (the defence is off; the same text as its benefit row, with the
defence-off detail):

| defence                         | detail                                                  |
| ------------------------------- | ------------------------------------------------------- |
| device                          | `Device signal poisoning is off`                        |
| replay                          | `Replay poisoning is off`                               |
| network fingerprint/bot/payment | `Fingerprint network lists are off`                     |
| network captcha                 | `CAPTCHA network list is off`                           |
| inactive benefit                | (none; detail is the short note shown next to the text) |

**Summaries** (`summaryFor`):

- protect: `This page {benefit list}. Masking hides that.` The benefit list is
  one of: `checked for N installed extensions`, `loads {vendor}`,
  `reads device signals`, `can record the session`; multiple are joined
  `A, B and C`. If the strongest risk is ≥15 points the tail is
  ` Masking hides it, but sign-in may need a second try.`
- skip: `This page looks like {risk nouns}. Masking here is more likely to trip
it than to help.` Up to two noun phrases (`sign-in form`, `sign-in flow`,
  `payment form`, `checkout flow`, `bot check`, `CAPTCHA`, …).
- neutral with inactive notes and a device/vendor signal:
  `This page profiles you, but the masking that would hide it is switched off.`
- neutral with probes: `Nothing conclusive here. Turn masking on if you would
rather not be checked.`
- neutral otherwise: `Static hasn't seen this page do anything it can mask. A
reload gives it another look.`
- neutral stale: `Nothing seen here in the last month. A fresh visit will
reassess.`

## Service worker contract

### Content-script registrations (`service_worker_utils.js`)

`contentScriptRegistrationsFor(settings)` keeps returning an array, with these
script lists:

```js
MAIN_WORLD_SCRIPTS; // existing full stack, unchanged order/conditions
ISOLATED_WORLD_SCRIPTS; // ["lists.js", "bridge.js", "dom_scrubber.js"]
SCOUT_MAIN_SCRIPTS; // ["block_utils.js", "signals.js", "scout.js", "scout_probes.js", "scout_signals.js"]
SCOUT_ISOLATED_SCRIPTS; // ["lists.js", "bridge.js"]
```

`CONTENT_SCRIPT_SETTINGS` gains `protection_mode: "per_site"` and
`site_decisions: {}`.

- `always`: exactly today's two registrations (`a-main`, `b-isolated`), matches
  `<all_urls>`, `excludeMatches` = paused host patterns. No scout registrations
  (scout files are unregistered; `contentScriptsInSync` must treat absent scout
  registrations as in sync).
- `per_site`: up to four registrations, in this order:
  1. `a-main` — full MAIN stack; `matches` = the site patterns of decided-on
     sites; no `excludeMatches`.
  2. `b-isolated` — full ISOLATED stack; same matches.
  3. `c-scout-main` — `SCOUT_MAIN_SCRIPTS`; `matches` = `["<all_urls>"]`;
     `excludeMatches` = decided-on patterns.
  4. `d-scout-isolated` — `SCOUT_ISOLATED_SCRIPTS`; same matches as c.
     If no site is decided on, a/b are omitted (2 registrations total). All four keep
     the shared fields (`allFrames`, `matchOriginAsFallback`, `persistAcrossSessions`,
     `runAt: "document_start"`).
- Site pattern conversion: `sitePatternsFor(siteKey)` returns
  `["*://<site>/*", "*://*.<site>/*"]` for registrable-style keys, or
  `["*://<site>/*"]` for bare/single-label keys. Invalid/overlong keys are
  skipped; duplicates are removed; results sorted for stable comparisons.
- Caps: `MAX_SITE_DECISIONS = 250` (per state), `MAX_EVIDENCE_SITES = 200`.
  If caps are hit, the oldest `on` decision is evicted on insert; evidence is
  evicted by `lastSeen`.
- `isOriginPaused(origin, disabledOrigins)` keeps working exactly as today for
  `always` mode. In `per_site`, pause entries are ignored for masking (the
  while-paused allow rules are not installed).

### Details payload (`static_get_details`)

Existing fields keep their meaning in both modes. The shipped additions:

```js
{
  mode: "per_site" | "always",
  siteKey: "paypal.com" | null,
  protectedHere: boolean,     // full masking stack is active for this frame's site
  paused: boolean,            // a 2.7 pause entry for this origin (any mode)
  decision: "on" | "off" | "undecided", // raw per-site decision for this site
  rulesetsApply: boolean,     // vendor lists are active on this page
  rulesetPrefs: { fingerprint_vendors: bool, captcha_vendors: bool },
  onboarding: { visible: boolean },
  seen: number,               // probes observed on this tab (scout frames)
  seenIds: [[id, count], …],  // top 5 observed IDs
  sitesSummary: { on, off, seen, paused }, // counts for the footer link
  site: null | {
    key,                      // "paypal.com"
    decision: "on" | "off" | "undecided",
    decisionAt: number | null,
    state: "on" | "off" | "undecided", // presentation state; "on" also in always mode
    paused: boolean,
    protectedHere: boolean,
    seenSinceDecision: number, // 0 unless decision === "off" and evidence grew
    evidence: null | {
      probeTotal, probeIds, probeVectors, pages, uaReads,
      vendorKeys: [...], deviceKeys: [...], replayKeys: [...], compatKeys: [...],
      labels: [...],          // <= 3 human labels for the sites page
      firstSeen, lastSeen,
    },
    recommendation: Recommendation | null, // null when no evidence yet
    history: { compatWarning: bool, pausedBefore: bool },
  },
  disabled,                   // !protectedHere (field name kept from 2.7)
  total,                      // probes blocked in this tab
  origin,                     // current tab origin (for the recovery card)
  compatWarning,              // fresh warning for this origin, shape unchanged
}
```

`site.state` is "on" whenever `protectedHere` is true; that is why the
`always`-mode details can carry `site.decision:"undecided"` and `site.state:"on"`
at the same time. `site.evidence` is the UI summary from `evidenceSummaryFor()`,
not the raw storage record: `probeIds` is the number of distinct IDs and `labels`
is already de-duplicated. `seen` is echoed as a count even on protected pages (the
scout is not registered there; the value is the last observed one for the tab).

### Messages

Every message carries its `type`; the handler table is `messageHandlers` in
`service_worker.js`.

| type                                                                                                                       | payload                                         | response                                                                                         | notes                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `static_get_details`                                                                                                       | `{tabId}`                                       | details above                                                                                    | existing                                                                                                                                                                                                                |
| `static_get_persona`                                                                                                       | `{}`                                            | `{disabled, mode, siteKey, …persona fields}`                                                     | bridge; `disabled = !maskedHere`; the live-off path                                                                                                                                                                     |
| `static_set_site_decision`                                                                                                 | `{site?, origin?, state: "on"\|"off"\|"clear"}` | `{ok, site, decision, mode, siteDecisions}`                                                      | popup sends `origin`; sites page sends `site`. Source is `"sites-page"` when the message says so or carries `site` without `origin`, else `"popup"`. Bad input → `{ok:false, error}` and no write                       |
| `static_set_protection_mode`                                                                                               | `{mode}`                                        | `{ok, mode, unchanged}`                                                                          | validates; applies registrations, DNR, header rules, badges. Same mode → success with `unchanged:true`                                                                                                                  |
| `static_dismiss_onboarding`                                                                                                | `{}`                                            | `{ok, dismissed:true}`                                                                           | writes `onboarding_dismissed`                                                                                                                                                                                           |
| `static_set_ruleset_enabled`                                                                                               | `{id, enabled}`                                 | `{ok, id, enabled, prefs}`                                                                       | persists `ruleset_prefs` + `ruleset_prefs_captured`, then applies. Unknown id → `{ok:false, error}`                                                                                                                     |
| `static_get_sites_overview`                                                                                                | `{}`                                            | `{mode, protected, declined, seen, paused, caps, prefs, onboardingDismissed}`                    | lists as in the sites page section                                                                                                                                                                                      |
| `static_clear_site_decisions`                                                                                              | `{scope: "all"\|"seen"}`                        | `{ok, cleared, scope}`                                                                           | `"seen"` clears evidence with no decision; `"all"` clears only `site_decisions` and leaves evidence                                                                                                                     |
| `static_set_site_disabled`                                                                                                 | `{origin, disabled}` (existing)                 | `{ok, mode, site?}`                                                                              | In `always` mode this is the pause/resume path, unchanged. In `per_site` mode it is kept for 2.7 callers: `disabled:true` maps to an `off` decision, `disabled:false` clears the decision (does not "protect" the site) |
| `static_probe_blocked`                                                                                                     | existing                                        | —                                                                                                | full stack                                                                                                                                                                                                              |
| `static_site_evidence`                                                                                                     | `{probes, overflow, signals}`                   | —                                                                                                | scout; not gated on `disabled`. `probes` entries are `{url, where, count}`, `signals` is `{uaReads, vendors, device, replay, compat}` deltas                                                                            |
| `static_export_log`                                                                                                        | —                                               | 2.7 payload plus `protectionMode`, `rulesetPrefs`, `siteDecisions`, `siteEvidence` in `per_site` | raw export only; `always` payload is the 2.7 shape                                                                                                                                                                      |
| `static_clear_log`                                                                                                         | —                                               | `{ok:true}`                                                                                      | 2.7 clear plus `site_evidence` and `tab_seen`; decisions and mode stay                                                                                                                                                  |
| `static_set_noise`, `static_set_replay`, `static_set_fingerprint`, `static_set_research_logging`, `static_set_diagnostics` | existing                                        | existing                                                                                         | unchanged                                                                                                                                                                                                               |

`static_set_site_decision` with `"on"` adds/overwrites a decision and drops any
`off` record for the site; `"off"` does the same but also writes
`probesAt = current observed probe total` (0 when none) so the popup can report
"new checks since"; `"clear"` removes the record. After the storage write the
worker runs the serialized reconciler (content scripts → scoped DNR → UA header
rules → badges) and then broadcasts `static_persona_update`; it responds only after
all of that, so the popup can reload knowing the page will be protected.

`static_set_protection_mode` with the same value is a no-op success (`unchanged:
true`) and still runs the reconciler once.

### Badge and action title

`updateBadgeForTab` in `per_site` mode:

- protected, fresh compat warning → `"!"`, `#d88030`, title
  `Static: protection broke a request here — click to review`
- protected → blocked count (`""` for 0, `"99+"` cap), existing colour scale, title
  `Static: protection on here`
- paused (Every-site-mode pause entry; only possible after switching modes) →
  `"OFF"`, grey `#888`, title `Static is paused here`
- unprotected, fresh compat warning → `"!"`, `#d88030`, title
  `Static is off here; masking interrupted a request before — click to review`
- unprotected, `seen > 0`, decision not `off` → seen count (`"99+"` cap), amber
  `#d88030`, title `Static: {seen} extension checks seen here — click to decide`
- unprotected, decision `off` → no badge, title `Static is off here (your choice)`
  (new evidence after the decision is deliberately quiet; the popup still reports it)
- unprotected, `seen === 0`, no decision → no badge, title
  `Static is off here — click to decide`
- non-http tabs → no badge, title `Static`
- a left-off site with new evidence deliberately keeps no badge (it is not a
  problem to fix); the popup reports the new checks when opened.

`always` mode uses the same primitives: blocked count while active, `OFF` while
paused, `!` for a fresh compat warning, and the plain `Static` title otherwise.

`updateBadgeForTab` reads only `protection_mode`, `disabled_origins`,
`site_decisions`, and `compat_log`, with defaults; it does not read the whole
storage object. `seen` counts come from the in-memory per-tab state, with the
bounded `tab_seen` mirror as the fallback after a worker restart.

### DNR gating

`site_dnr.js` (new, loaded by the service worker after `lists.js` / `signals.js` /
`site_signals.js`) owns the declarativeNetRequest part of `per_site` mode. It is
pure data + `chrome.declarativeNetRequest`, so the vm harness can drive it with a
mock.

```js
globalThis.__static_site_dnr__ = {
  RULESET_IDS,                  // ["fingerprint_vendors", "captcha_vendors"]
  DEFAULT_PREFS,                // { fingerprint_vendors: true, captcha_vendors: false }
  SCOPED_RULE_ID_BASE,          // 50000
  isScopedRuleId(id),
  ruleIdFor(rulesetIndex, staticRuleId),
  staticRulesetsFor(prefs),     // ids whose pref is on, sorted
  loadRulesets(),               // fetch + validate + cache rules/<id>.json; retries after failure
  scopedRulesFor(rulesets, sites), // -> dynamic DNR rules (no side effects)
  apply({ mode, prefs, sites }),// -> { ok, staticRulesets, scopedRules }; serialized
  capturePrefs(defaults),      // getEnabledRulesets() -> prefs; never throws
  currentScopedRuleIds(),      // live scoped ids (diagnostics/tests)
};
```

Behavior:

- `mode === "always"`: `updateEnabledRulesets` enables exactly the preferred
  static rulesets and disables the other (today's behavior), then removes every
  scoped dynamic rule (`id >= 50000`). Both modes still load the ruleset JSON
  first, so a broken ruleset fails the same way instead of half-applying; a
  harness with no `chrome.runtime`/`fetch` may drive `always` without loading.
- `mode === "per_site"`: disable both static rulesets, then write dynamic rules
  derived from the enabled prefs. Each scoped copy is the static rule's `action`
  and `condition` untouched (including Firefox-stripped `resourceTypes`), plus
  `condition.initiatorDomains = sites`, and
  `id = 50000 + rulesetIndex * 1000 + staticRuleId` (`rulesetIndex`: 0 =
  fingerprint, 1 = CAPTCHA). Sites are lowercased, trimmed, deduped, sorted and
  capped at 250; an empty set removes the scoped rules and leaves the static
  rulesets disabled. Rule priority is copied from the file (`?? 1`).
- Chrome's dynamic-rule limits are not a concern: both files together are 98
  rules (82 fingerprint + 16 CAPTCHA), so there is at most one scoped copy of each
  — 98 dynamic rules — beside the header/pause ranges. IDs stay within
  50000–59999.
- `site_dnr.js` must not hardcode resource types that Firefox's build strips: it
  copies `condition` (and `action`) from the JSON files, which `build-firefox.js`
  already rewrites.
- Both the ruleset load and the two `updateDynamicRules` phases are validated
  before the static state is touched, and the whole update is idempotent: a
  failed load/update rejects `apply`, the service worker logs it through
  `safeLog`, leaves whatever DNR state it had, and retries on the next mode, pref,
  decision, install, or startup reconcile. Scoped removals happen in the same
  `updateDynamicRules` call as additions when possible; a browser that rejects
  the combined call gets a remove-then-add fallback. `apply` calls are serialized
  on one promise chain so two quick clicks cannot interleave.
- In `per_site` mode the service worker also removes the pause-allow dynamic
  rules (nothing global is blocked, so a "paused" origin needs no exception) and
  the bare-host outrank rules. In `always` mode it restores them from
  `disabled_origins`, exactly as today.
- The runtime owner is the serialized `refreshProtectionRuntime()` in
  `service_worker.js`: pause exceptions → scoped DNR → UA header rules →
  content-script registrations → badges. `static_set_protection_mode`,
  `static_set_site_decision`, `static_set_ruleset_enabled`, pause changes,
  `clear_site_decisions`, install, startup, and relevant storage changes all
  funnel through it.

Header rewriting (`User-Agent` / `Sec-CH-UA*`) follows the same mode split:

- `always`: one global dynamic rule (`GLOBAL_UA_RULE_ID` = 9999, priority 40),
  excluded on paused host domains, plus lazily added per-origin request/initiator
  rules (priority 100) for the origins the details/persona path sees. That is the
  2.7 behavior. Paused bare hosts (IP/`localhost`) additionally get high-priority
  `allow`/`allowAllRequests` outrank rules so the global rule cannot touch them.
- `per_site`: no global rule. Every refresh calls `buildSiteHeaderRules()` over the
  decided-on sites: for each site, a request rule (`requestDomains: [site]`, or an
  anchored `regexFilter` for bare hosts) plus an initiator rule
  (`initiatorDomains: [site]`), both priority 100 and carrying that site's persona.
  Persona scope is the site key, so `www.example.com` and `example.com` present the
  same UA. Paused sites in `per_site` are not in the decision set and get no rules.
  The rebuild removes every id that can belong to the header layer
  (`10000–29999`, the global rule, and the bare outrank range) before adding the
  fresh set, so a decision change cannot leave a stale rule behind.
- `header_rules` (`chrome.storage.local`) is the persistence map:
  `{ "*": globalState }` plus `{ [key]: { requestRuleId, initiatorRuleId,
uaString, lastUsed } }`, keyed by **origin** in `always` and by **site key** in
  `per_site`. `header_rules_mode` (`"per_site"` / `"always"`) marks which key shape
  the map and the live DNR rules use. `syncHeaderRulesForMode()` compares it with
  the stored mode and, on a mismatch (a live mode switch, or a mode changed while
  the worker was down), calls `resetHeaderRules()` — remove every 10000–29999 and
  40000–40999 rule, clear the map, reset the id counter — before applying, and both
  branches write the new marker back. This is why a live switch cannot mix
  origin-keyed and site-keyed rules, and why a restart restores cleanly.

## Popup UI

The user-facing description is [README: The decision card](../README.md#the-decision-card); this
section is the contract for ids, copy, and states.

Same popup, new top-level behavior. All existing IDs/classes stay where `always`
mode tests expect them.

```
┌ Static ───────────────────────────────┐
│ [onboarding card — until dismissed]   │
│ 1,204                                 │  ← #count is blocked count while
│ extension checks seen here            │    protected, observed count while not
│                                       │
│ Worth masking · high confidence       │  ← #site-verdict
│                                       │    (container #site-summary)
│ We suggest masking here               │  ← #site-headline
│ This page checked for 1,204 …         │  ← #site-summary-text
│ ✓ Checked for 1,204 installed …       │  ← #site-reasons li.benefit
│ ✗ Runs a bot check                    │  ← li.risk
│ ○ Reads your canvas — poisoning off   │  ← li.note
│ Review the controls behind this       │  ← #site-open-more
│ [ Protect this site ] [ Leave it off ]│  ← #site-cta
│ Only sites I choose | Every site      │  ← #mode-row
│                                       │
│ Page not working?                     │  ← #recovery
│ [Turn protection off here and reload] │
│ ▼ More …                              │
└───────────────────────────────────────┘
```

Markup and states:

- **Site section switch.** In `per_site` mode, for an http(s) tab with a `site`
  object, `#site-decision` is shown and `#site-control` (the legacy switch) is
  hidden with its `hidden` attribute. In `always` mode it is the reverse. On
  non-http tabs, or when details are null, both are hidden; the mode row is still
  rendered. `#site-decision` carries `data-decision="on|off|undecided"` and an
  `aria-labelledby` pointing at the sr-only `#site-decision-title`.
- **State text** `#site-state`: undecided → `Static is off here.`; off →
  `You left this off here.`; on → `Static is on here.`
- **Verdict badge** `#site-verdict`: while protected it reads
  `On · you chose it` (class `is-on`) instead of a recommendation. Otherwise it
  reads `Worth masking`, `Better left off`, or `No strong signal`, followed by
  ` · high confidence` / ` · medium confidence` / ` · low confidence` (classes
  `is-protect`, `is-skip`, `is-neutral`). It is hidden while a recommendation is
  loading or when there is none. On a left-off site, a `protect` recommendation is
  hidden so the card does not nag.
- **Headline and summary** `#site-summary` (block) / `#site-headline` /
  `#site-summary-text`: the engine's `headline` and `summary`. A left-off site
  whose current verdict is `protect` shows
  `Since you turned it off, Static stays off here.` instead of the recommendation
  headline, keeps the recommendation summary, and hides the verdict badge. With
  no evidence, the headline is `Nothing seen here yet` and the summary is
  `Static hasn't seen this page do anything it can mask. It gets more useful
after a page load or two.`; the block hides only when both strings are empty.
- **Caution** `#site-caution`: when `recommendation.caution`, the literal line
  `If sign-in misbehaves, leave this site off.` No other colour change, no badge.
- **Reasons** `#site-reasons`: up to three `li.benefit`, then up to three
  `li.risk`, then up to two `li.note`; each carries `data-key` (and
  `data-defense` for benefits). Hidden when empty. Notes are the "defence is
  off" observations.
- **Open more** `#site-open-more`: visible only when there are notes; label
  "Review the controls behind this". Clicking it opens the `#advanced-controls`
  `<details>`, scrolls the first note's target into view, and focuses the control:
  device notes → `#fingerprint-title-text` / `#fingerprint-mode`; replay notes →
  `#replay-title-text` / `#replay-mode`; network notes → `#rulesets` /
  `#rs_fingerprint_vendors`. Target selection falls back from the note `defense`
  to a keyword match on its `key`/`text`.
- **Actions** `#site-cta`: `#site-protect` → `state:"on"`;
  `#site-leave-off` → `state:"off"`; `#site-turn-off` → `state:"off"`.
  `#site-protect` is hidden while `on`, `#site-leave-off` is shown only while
  `undecided`, `#site-turn-off` only while `on`. The undecided card marks the
  recommended button with `class="is-suggested"`: protect for a `protect` verdict,
  leave-off for `skip`, neither for `neutral`. Buttons are disabled while the
  message is in flight. Each sends `static_set_site_decision` with the tab's
  `origin`, then reloads the popup's tab and closes the popup. On failure the
  buttons re-enable and `#site-note` shows `Static couldn't save that. Try again.`
  If the origin is gone: `Reload this page, then try again.`
- **Note** `#site-note` (`role=status`, `aria-live=polite`): undecided sites show
  `Changes take effect when this page reloads.` A left-off site shows
  `New checks here: {N} since you turned it off.` when
  `site.seenSinceDecision > 0` (digits grouped); otherwise hidden. A protected
  site hides it.
- **Onboarding card** `#onboarding` (`role=note`, `aria-labelledby=onboarding-title`):
  shown when `details.onboarding.visible`. Title
  `#onboarding-title` = `Static now asks before it masks`; body: "Static stays off on a page until
  you choose. When a site checks for extensions or fingerprints your browser, the
  toolbar icon shows what it found so you can decide." **Got it** sends
  `static_dismiss_onboarding`, hides the card, persists
  `onboarding_dismissed: true`. **Protect every site instead** sends
  `static_set_protection_mode {mode:"always"}`, hides the card, reloads the tab,
  closes the popup. Failures show an inline line in `#onboarding-note` under the
  buttons and keep the card open. The card sits above the count, not inside the
  decision card. It is
  visible while `per_site` and there are **no site decisions at all** and the
  dismissal flag is false — so an upgrade with no decisions sees it, and one
  decision (from any surface) ends it.
- **Mode row** `#mode-section` / `#mode-row` under the site card: buttons `#mode-per-site`
  ("Only sites I choose") and `#mode-always` ("Every site"), with
  `aria-pressed` reflecting `details.mode`. Explainer `#mode-explainer`:
  per-site → `Static stays off until you turn it on for a site.`; always →
  `Static masks every site except the ones you pause.` Clicking the other mode
  sends `static_set_protection_mode`, reloads the tab, closes the popup. Clicking
  the current mode is a no-op. While the message is in flight both buttons are
  disabled; failure shows `Static couldn't switch modes. Try again.` in
  `#mode-note` and re-enables them.
- **Recovery card** lives inside `#recovery-section`; `#recovery` is the card
  (`#recovery-title` / `#recovery-detail` the copy, `#recovery-action` the button),
  with `data-state` one of `paused|warning|help` and `is-warning` / `is-paused`
  class mirrors. It is only rendered for http(s) tabs; otherwise the whole
  `#recovery-section` stays hidden.
  - `always` + paused → `data-state="paused"`, title `Static is paused here`,
    detail "Protection is off on this site. Reload if the page still looks stuck.
    You can turn Static back on anytime.", action **Turn protection back on**.
  - `always` + fresh compat → `data-state="warning"`, title
    `This site may be broken by Static`, detail "Static blocked something this
    page expected. Pause here and reload to see if that fixes it.", action
    **Pause this site and reload**.
  - `always` otherwise → `data-state="help"`, title `Page not working?`, detail
    "Static can stop logins, checkouts, or extra features on some sites. Pause it
    here to check.", action **Pause this site and reload**.
  - `per_site` + protected + fresh compat → `data-state="warning"`, title
    `This site may be broken by Static`, detail "Static interrupted a request
    this page expected. Turn protection off here to see if that fixes it.",
    action **Turn protection off here and reload** → `state:"off"` + reload.
  - `per_site` + protected (no warning) → `data-state="help"`, title
    `Page not working?`, detail "Static can stop logins, checkouts, or extra
    features on this site. Turn it off here to check.", action
    **Turn protection off here** → `state:"off"` + reload.
  - `per_site` + unprotected, or non-http → card hidden.
- **Hero** `#count[data-count-kind]` + `#count-label` + `#count-subtext`: on an
  unprotected per-site page (`data-count-kind="seen"`) the label is
  `extension checks seen here`, the number is the scout count (`seen`, with
  `site.evidence.probeTotal` as fallback), the colour is amber `#d88030` when
  non-zero and grey `#888` at zero, and the subtext
  "Static is watching, not masking, on this site." is shown. Otherwise
  (`data-count-kind="blocked"`) the label is `probes blocked on this tab`, the
  number is the tab's blocked count, and the count colour is the existing scale
  (`#888` / `#d88030` / `#c93131`).
- **Cumulative** `#cumulative` stays visible when masked and is hidden on an
  unprotected per-site page (nothing has been blocked). `#drift` and `#adaptive`
  are unchanged and still read the probe/adaptive logs.
- **Ruleset section**: checkboxes render from `details.rulesetPrefs` (fall back to
  `getEnabledRulesets()` when details are null). Toggling sends
  `static_set_ruleset_enabled`; on failure the checkbox reverts. The note
  `#rulesets-paused-note` reads:
  - `always` + paused → "Static is paused on this site, so these lists don't apply
    to this site."
  - `per_site` + unprotected → "Static is off on this site, so these lists only
    apply to the sites you protect."
  - `per_site` + protected → hidden.
- **Footer** `#view-sites` (was `#view-disabled`, relative `href="sites.html"`) reads
  "Manage protected sites"; `#sites-stats` (was
  `#disabled-stats`) reads `{on} on · {off} off` in per-site mode and
  `{paused} paused` in always mode.
- **No details**: the popup renders the mode row with **Every site** pressed,
  onboarding hidden, both site card and switch hidden, count label
  "probes blocked on this tab", recovery hidden. It does not throw on
  `chrome://`, extension, error, or non-http targets.
- **Errors**: failures are inline and local; the popup never uses `alert` for the
  decision card.

## Sites page (`sites.html`)

The user-facing overview is [README: The sites page](../README.md#the-sites-page). This section is
the behavior and DOM contract.

`disabled.html` / `disabled.js` are removed and replaced by `sites.html` /
`sites.js`. `static-validation` checks the page list, the popup link, and the
storage keys the page reads.

Layout:

- Header: brand stripe, `Static` brand name, `<h1>Site protection</h1>`, note
  "Per-site masking".
- Lede: "Static masks only the sites you choose. Autodetection tells you what each
  page is doing so the choice is informed."
- **Mode section** `#mode-section`: radio cards `#mode-per-site` /
  `#mode-always` (name `protection-mode`), labelled "Protection mode", with
  descriptions; the per-site card carries a "Recommended" chip. A muted note
  `#mode-note`: "Mode changes apply when pages reload." An inline error
  `#mode-error` is used when the change fails. Changing mode sends
  `static_set_protection_mode`, then re-fetches the overview; it does not reload
  other open tabs (the popup does reload its own tab).
- **Toolbar**: search input `#search` (type=search, placeholder "Search sites…",
  aria-label "Search sites"), count summary `#summary`, inline action error
  `#action-error`, no-match line `#no-match`, loading line `#loading`, error card
  `#error-card` with `#retry`.
- **Per-site mode** shows:
  1. **Protected sites** `#section-on` / `#table-on` / `#tbody-on`; meta
     "Protected since {date}"; action `Turn off` (`data-action="unprotect"`).
     Empty `#empty-on`: "No sites protected yet. Open a page and click the Static
     icon to decide there, or protect a site from this list."
  2. **Left off** `#section-off` / `#table-off` / `#tbody-off`; meta
     "Left off {date}"; evidence line; the recommendation headline as a note;
     action `Protect` (`data-action="protect"`). Empty: "No sites left off. When
     you choose Leave off for a site, it appears here."
  3. **Seen here, no decision** `#section-seen` / `#table-seen` / `#tbody-seen`;
     undecided sites with evidence, newest `lastSeen` first, max 50; meta
     "Last seen {date} · {n} checks"; actions `Protect` and `Leave off`
     (`data-action="leave-off"`). Empty: "No undecided sites. Static lists a page
     here after it sees extension checks on the site."
  4. `#section-paused` hidden, `#caps-note` visible, footer actions visible.
- **Every site mode** shows `#section-paused` (`#table-paused` / `#tbody-paused`,
  one row per paused origin, action `Enable` / `data-action="enable"`, header
  action `#reenable-all` "Enable all"), the `#paused-note` "Per-site decisions are
  kept while every site is masked. Switch back to per-site protection to use
  them.", hides `#section-on` / `#section-off` / `#section-seen`, hides the caps
  note and footer actions. Empty: "No paused sites. Static is active everywhere."
- **Search** filters every visible row case-insensitively on the site key; section
  headings stay; a table with no matching row hides; `#no-match` says
  `No sites match “{query}”.` when the query matches nothing anywhere.
- **Summary** `#summary`: per-site `{n} site(s) protected · {n} left off · {n} seen`; always
  `{n} site(s) paused`.
- **Caps note** `#caps-note`: "Static keeps up to 250 site decisions and the 200
  most recent sites it has seen. Older entries drop off." (Numbers come from the
  overview caps payload, not literals.) The shipped limits behind that sentence:

  | limit                                            | value             |
  | ------------------------------------------------ | ----------------- |
  | decisions per state (`on`, `off`)                | 250               |
  | sites with stored evidence                       | 200               |
  | **Seen here, no decision** rows rendered         | 50                |
  | `tab_seen` tabs                                  | 30                |
  | probe IDs / vectors / path kinds per site        | 300 / 24 / 20     |
  | vendors / device / replay / compat keys per site | 40 / 30 / 20 / 24 |
  | evidence `pages` / probe `total` / `uaReads`     | 1e6 / 1e9 / 1e6   |

- **Footer actions** `#footer-actions`: `#clear-seen` "Forget undecided sites",
  `#clear-all` "Clear all decisions". Both need two clicks within 4 s: first click
  arms and changes the label to "Click again to confirm", second sends
  `static_clear_site_decisions` with `scope: "seen"` / `"all"`. Timeout or success
  restores the label. "Forget undecided sites" removes `site_evidence` entries
  whose site has no `on`/`off` decision.
  "Clear all decisions" empties `site_decisions` only — evidence stays, so every
  previously decided site reappears under **Seen here, no decision**. Both actions
  also empty `tab_seen`.
- **How this works** `#how-it-works` `<details>`: explains the modes; that masking
  applies the narrow vendor lists as DNR rules scoped by the protected site's
  `initiatorDomains`, rewrites the user agent and Client Hints in JavaScript and in
  request headers, and (opt-in) poisons canvas/WebGL/audio readbacks; that Static
  never proxies traffic, adds no VPN, blocks no broad ad/tracker surface, and sends
  no observation anywhere; that a decision covers subdomain, scheme, and port;
  that autodetection is a best-effort hint; and what the two clear actions do.
- Empty state copy is fixed per section (above); "Enable all" is disabled with an
  empty paused list.
- No external network requests: every fetch is a `chrome-extension://` asset or an
  extension message.

Data flow:

- The page never reads storage directly. `static_get_sites_overview` returns:
  `{ mode, protected: Row[], declined: Row[], seen: Row[], paused: string[], caps,
prefs, onboardingDismissed }`, where
  `caps = { maxSiteDecisions, maxEvidenceSites, seen, protected, paused, evidence }`
  (the first four are what the page renders; extra aliases are tolerated).
  `Row = { site, state: "on"|"off"|"seen"|"paused", at, lastSeen, evidence,
recommendation, history }`; evidence is
  `{ probeTotal, probeIds, probeVectors, labels, vendorKeys, deviceKeys,
replayKeys, compatKeys, uaReads, firstSeen, lastSeen, pages }` (or null); the
  recommendation is the compact `{ verdict, confidence, headline, summary,
caution }` (or null).
- Every row action sends `static_set_site_decision` `{site, state:"on"|"off"}`,
  then re-fetches the overview and re-renders from the response; no page reload.
  `Enable` sends the legacy `static_set_site_disabled` `{origin, disabled:false}`.
  The worker normalises the stored `source` to `"sites-page"` for these requests
  (see the messages table).
- Storage changes (`site_decisions`, `protection_mode`, `site_evidence`,
  `disabled_origins`) from another surface schedule a debounced (150 ms) re-fetch;
  the page also re-renders locally after each mutation.
- Row rendering is defensive: junk evidence, negative/non-numeric timestamps,
  over-long site names, and invalid paused-origin strings must render as plain
  text or be skipped, never throw.

Row DOM contract for tests:

```html
<tr data-site="paypal.com" data-state="on|off|seen|paused">
  <td class="site-cell">
    <span class="site-name">paypal.com</span>
    <span class="site-meta">Protected since Nov 8</span>
    <span class="site-evidence">4,500 extension checks · 3 IDs · FingerprintJS</span>
    <span class="site-note">We suggest masking here</span>
  </td>
  <td class="action-cell">
    <button class="btn-row" data-action="protect" data-site="paypal.com">Protect</button>
    <button class="btn-row" data-action="unprotect" data-site="paypal.com">Turn off</button>
    <button class="btn-row" data-action="leave-off" data-site="paypal.com">Leave off</button>
    <button class="btn-row" data-action="enable" data-site="https://paused.example">Enable</button>
  </td>
</tr>
```

Only the actions relevant to the row are rendered (`on` → unprotect; `off` →
protect; `seen` → protect + leave-off; `paused` → enable). Evidence line segments
are `{probes} extension checks`, `{ids} IDs`, then up to two notable labels
(vendor labels, "sign-in form" / "card form" / "bot checks" / "CAPTCHA" from the
compat categories, or a strong device surface). Sites with no evidence show
"No probing seen yet".

## `always` mode

`always` is the 2.7 behavior, preserved. The differences are additive:

- the onboarding card exists, and the popup can switch back to `per_site`;
- `sites.html` is the renamed disabled-and-paused page: the same paused-origin
  list, search, per-origin **Enable**, and **Enable all** as before, plus the mode
  radios and the per-site sections it hides;
- `static_get_details` carries the extra fields in the table above. `disabled`
  keeps its 2.7 meaning ("paused here"), `total` keeps "probes blocked in this
  tab", and the `always`-mode assertions in the pre-existing suite still pass;
- the DNR fingerprint/CAPTCHA rulesets and the UA/Client-Hints rules are the 2.7
  globals. The scoped rule sets are per-site only;
- the badge is the 2.7 badge (blocked count / `OFF` / `!`), not the amber observed
  count;
- no scout registrations run and nothing writes `site_evidence`. The stored
  `site_decisions` map and any evidence from per-site mode are left untouched, so
  switching back to `per_site` loses nothing.

## Privacy

The user-facing data policy is in [README: Privacy of the scout](../README.md#privacy-of-the-scout)
and [PRIVACY.md](../PRIVACY.md); this section is the design constraint the implementation keeps.

- Everything stays in `chrome.storage.local`; no network requests are introduced,
  no permission is added, and no telemetry exists.
- Evidence stores counts, fixed catalog keys, extension IDs, and coarse
  extension-resource path kinds only (the same shape as the existing probe log).
  Probe URLs are reduced to extension ID + path kind before storage; the raw URL
  is not persisted. No page URL, path, title, text, form value, cookie, storage
  value, or event.
- Per-tab observed counters (`tab_seen`) are the same shape: tab id, timestamp,
  total, up to 10 `[extensionId, count]` pairs per tab, max 30 tabs, dropped on
  tab close/navigation and by **Clear log**. No page URL is part of the key.
- `header_rules` / `header_rules_mode` exist only so the UA/Client-Hints DNR rules
  survive a worker restart and a mode switch; they carry the site keys already
  stored in `site_decisions`, rule ids, and the generated persona's OS/platform
  choice, no page content.
- The scout reads page _behavior_, not page _content_. The only page-content it
  reads is the attribute/URL string it is already classifying (to test for an
  extension URL), `input` `type`/`autocomplete`/`name` (to classify a field),
  and the current path (to classify a flow). It never stores those values.
- Evidence is capped and evicted; clearing the probe log in the popup also clears
  `site_evidence`.
- Export: in `per_site` mode the raw `static_export_log` payload gains
  `protectionMode: "per_site"`, `rulesetPrefs`, `siteDecisions` (site + state +
  timestamp + source, and the left-off `probesAt` baseline) and `siteEvidence`
  (the capped counts described above). In `always` mode the payload is exactly the
  2.7 shape. The anonymized research export and the copied issue report are built
  from the probe log only, so they do not gain site evidence or decisions.
- The "defences off" notes are **derived** from the same counts plus the current
  feature settings at render time; no separate note list is stored.
- Nothing in the recommendation writes back: no auto-enable, no auto-disable, no
  feature switch. The only writers are the explicit popup/sites-page actions.

## Tests

New E2E spec files (each runs in its own browser context; no shared mutable
state):

- `tests/site-decisions.spec.js` — modes, decisions, host/site precedence,
  registrations, badge/titles, DNR gating, evidence caps/trim, upgrade defaults,
  clear-log behavior, onboarding, `always`-mode regression.
- `tests/scout.spec.js` — detection coverage per vector (`fetch`, XHR, image,
  srcset, script, link, iframe/frame, source, video poster, audio, object/embed,
  form action, Worker/SharedWorker, Worklet, EventSource, sendBeacon, CSSOM,
  markup sinks, `document.write`, MutationObserver backstop), pass-through
  fidelity, stealth, caps, signal dedupe, device/vendor/replay/compat reporting,
  frame attribution, `document_start` behavior, and the synchronous drain.
- `tests/popup-decisions.spec.js` — popup decision card states, buttons, mode row,
  onboarding, recovery card, ruleset toggles in both modes, notes→More targeting,
  no-details rendering.
- `tests/sites-page.spec.js` — sections, actions, mode radios, search/summary,
  caps copy, storage-change re-render, always-mode paused list, defensive
  rendering, no external requests.
- `tests/ruleset-scoping.spec.js` — static rulesets disabled in `per_site`,
  dynamic rule shape and ids (`initiatorDomains`, priority, resource types),
  scoped rules only for protected sites, pref capture/propagation across mode
  switches, empty-site behavior, failure/retry, `always` restoration.

`tests/helpers/extension.js`:

- `launchExtension()` seeds `{ protection_mode: "always" }` after the worker
  starts through `seedAlwaysMode()` (the wrapped `serviceWorker.evaluate` also
  waits for `contentScriptRegistrationsFor(settings)` to match what is
  registered), so the pre-existing specs keep testing the full stack. If the
  fixture is not in `always` mode, seeding throws rather than silently testing
  the scout;
- exports `setStorage`, `setProtectionMode`, `setSiteDecision`,
  `siteEvidence`, `clearStorage`, `resetStorage`, `callMessageHandler`,
  `getDetails`, `registeredScripts`, `tabIdForUrl`, `staticPageTraces`,
  `enableFingerprintMask`, and `extensionPath`;
- maps `*.static-fixture.test` (and `static-fixture.test`) to `127.0.0.1` with
  `--host-resolver-rules`, merging caller-supplied mappings; the same server
  serves every hostname by path, so subdomain/site-key behavior runs without DNS.

`tests/e2e-specs.txt` gains the five new specs (it stays the single list read by
`package.json` and `gate.sh`). `tests/static-validation.spec.js` gains, among
others:

- default/derived settings and registration-shape tests for both modes
  (including the `a-main`/`b-isolated`/`c-scout-main`/`d-scout-isolated` order,
  match/exclude patterns, shared fields, and transition sync);
- site-key algorithm tests: `paypal.com`, subdomains, ports, `127.0.0.1`,
  `localhost`, IPv6 literals, IDN/punycode, trailing dots, multi-tenant
  suffixes, ccTLD second levels, junk inputs, match-pattern generation;
- `signals.js` catalog tests: every DNR rule domain appears exactly once, ids and
  labels unique, kinds valid, weights positive, compat risks match the Appendix
  table, vectors match the canonical list, data-only (no DOM/chrome/fetch/timer
  references), and every compat id has `COMPAT_COPY` (vendor/device/replay copy is
  generated from their labels; headline tables and limits are pinned);
- `site_signals.js` tests with the vm harness: every verdict band, the
  active-points guard and honesty rule, compat-warning/stale/left-off overrides,
  defence-off notes, caps and truncation, sanitization of junk and oversized
  input, text templates, `recommendationFor` always returns a shape;
- `tests/ruleset-scoping.spec.js`: the vm portion drives the real `rules/*.json`
  through `site_dnr.js` with a mock `chrome.declarativeNetRequest` (scoped rule
  shape, ids, `initiatorDomains`, priority, resource types, no mutation of the
  source, prefs, empty sites, mode switching, failure retry, serialized applies);
  the browser portion loads the extension and reads back the installed dynamic
  rules;
- scout/bridge harness tests: probe-vector wrappers are pass-through
  (`this`/arguments/return/throw/promise identity), `toString` stealth, caps and
  dedupe, signal whitelisting, `seq` dedupe, the pagehide drain, no errors when
  page globals are missing, and the 40-install ceiling;
- Firefox build: `background.scripts` includes `lists.js`, `signals.js`,
  `site_signals.js`, `site_dnr.js`, `service_worker_utils.js`,
  `service_worker.js`; new content scripts are present; rules JSON still JSON.

`tests/firefox-smoke.js`: opens `moz-extension://<uuid>/sites.html` from the
extension page context, asserts the two mode radios render and are radio inputs,
seeds `protection_mode: "always"` there, reads it back, then keeps the existing
full-stack assertions.

## Documentation

The release ships with:

- [README: Protection modes](../README.md#protection-modes-default-per-site) — the user-facing
  summary: what the default does, the scout, modes, the sites page, scoped defenses, caps.
- [README: How the recommendation works](../README.md#how-the-recommendation-works) — the six
  headlines, worked examples, "defences off" notes, and honest limits.
- [README: Privacy of the scout](../README.md#privacy-of-the-scout) — exactly what the scout stores,
  the caps, and how to clear it.
- [README: Caveats](../README.md#caveats) — the first-class limits of the mode.
- [README: Toggle fingerprint rulesets](../README.md#toggle-fingerprint-rulesets) — what a toggle
  means in each mode.
- [CHANGELOG.md](../CHANGELOG.md) — 2.8.0 release notes, including the upgrade behavior.
- [PRIVACY.md](../PRIVACY.md) — data policy: storage keys, evidence fields, retention, export.
- [docs/adaptive-blocking.md](adaptive-blocking.md) — the separate, opt-in deep logger. Scout
  evidence and the adaptive log do not feed each other.
- [docs/noise-behavior.md](noise-behavior.md) — the Noise contract. In per-site mode Noise applies
  only on protected sites.

`rules/META.json` is untouched by this release. `manifest.json` and `package.json` carry version
2.8.0.

## Verification

Automated gate:

1. `npm run format:check` passes.
2. `npx eslint . --max-warnings=0` passes (respect `max-lines`, `complexity`,
   `max-statements`; add targeted `eslint-disable` with a reason only when the
   existing codebase does).
3. `npm run test:static` passes: `tests/static-validation.spec.js` covers mode
   and registration shape, the site-key algorithm, the `signals.js` catalog, the
   recommendation engine/sanitizer/matrix, and the Firefox build transform.
4. `xvfb-run -a npx playwright test $(cat tests/e2e-specs.txt | tr '\n' ' ')`
   passes, including the five new specs — `tests/scout.spec.js`,
   `tests/site-decisions.spec.js`, `tests/popup-decisions.spec.js`,
   `tests/sites-page.spec.js`, `tests/ruleset-scoping.spec.js` — and every
   pre-existing spec. `tests/scout.spec.js` and the other new browser specs opt
   into `per_site` explicitly; `tests/helpers/extension.js` seeds the pre-existing
   suite with `protection_mode: "always"` (and waits for the content-script
   registrations to match) so those specs still exercise the full 2.7 stack. The
   vm cases in `tests/ruleset-scoping.spec.js` drive the real `rules/*.json` and a
   mock `chrome.declarativeNetRequest`.
5. `npm run build:firefox` succeeds and `npx web-ext lint --source-dir <extracted>`
   is clean.

Manual release checks:

1. Fresh profile, no seeded storage: open the PayPal-like fixture, and the popup
   shows a `skip` recommendation with the sign-in and bot-check reasons. Press
   **Protect this site**; the page reloads, probes are blocked, the badge turns red
   with a blocked count, the decision persists across a browser restart, and the
   sites page lists it under **Protected sites**.
2. Same profile: open the LinkedIn-like fixture and the popup shows a `protect`
   recommendation with extension-check reasons; the amber observed count is in
   the hero before protection.
3. Open a fresh site with no evidence: the popup shows **Nothing seen here yet**
   with the "Static hasn't seen this page do anything it can mask" summary, both
   buttons are usable, and neither is suggested. (A neutral verdict _with_
   evidence is the separate **No strong signal here** case.)
4. Turn Device signal poisoning off, open a canvas-heavy site, and the
   recommendation lists a device note ("device poisoning is off") instead of a
   benefit; turn every defence off and the verdict cannot be `protect`.
5. Switch the mode from the popup and from the sites page. A popup switch reloads
   that tab; a sites-page switch takes effect on each page's next load. Another
   open tab picks the mode up on navigation; a full-stack page told to stand down
   stops blocking immediately. Decisions and evidence survive the switch, the UA
   header rules are rebuilt from scratch (no stale origin-keyed rule keeps
   spoofing), and ruleset toggles do not flip.
6. Clear log: the sites page's **Seen here, no decision** list empties (decisions
   stay), and `site_evidence` / `tab_seen` are gone from storage. **Clear all
   decisions** leaves evidence in place and the previously decided rows reappear
   under **Seen here**.
7. Upgrade check: install 2.7 with a paused origin and a disabled ruleset, update
   to 2.8, and confirm per-site mode is active, the paused origin still shows in
   Every site mode, the ruleset toggle did not flip, and site decisions are empty
   (the first popup explains the new default).
8. `always` mode still behaves exactly like v2.7.0 (existing suite green).
9. Firefox smoke: the sites page renders its mode radios and a decision round-trip
   works with the same storage keys.

---

## Appendix A — `signals.js` catalog

`signals.js` is loaded (a) as a MAIN-world content script before the scout, (b) by
the service worker via `importScripts`, and (c) by the vm test harness. It must
have no DOM/chrome dependencies. It exposes exactly one global, then is deleted
by `scout.js` at the end of its setup:

```js
globalThis.__static_signals__ = {
  version: 1,
  vendors: [
    {
      id,
      label,
      kind, // "fingerprint" | "bot" | "payment" | "captcha"
      weight,
      risk, // optional; present on bot/captcha rows
      domains: [
        /* host, host/pathPrefix, or path fragment */
      ],
      globals: [
        /* dotted paths */
      ],
    },
  ],
  device: [{ id, label, weight, kind: "strong" | "weak" }], // kind drives caps
  replay: [{ id, label, weight, domains, globals }],
  compat: [{ id, label, kind, risk }],
  vectors: [
    /* canonical probe vector names, documentation only */
  ],
};
```

The shipped catalog is data-only. `weight` is the benefit weight; `kind` selects
the benefit group cap and, for vendors, the risk row; `risk` on compat rows is the
base risk weight. The service worker treats every key as a fixed catalog id:
adding a row here is a code-adjacent change (engine copy must exist for it), not a
runtime setting.

### vendors — device fingerprinting (kind `fingerprint`)

| id              | label          | weight | risk | domains                                                                                                                                                                                             | globals                          |
| --------------- | -------------- | ------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `biocatch`      | BioCatch       | 10     | —    | biocatch.com                                                                                                                                                                                        | BioCatch, biocatch               |
| `castle`        | Castle         | 10     | —    | castle.io                                                                                                                                                                                           | \_castle, castle                 |
| `deviceatlas`   | DeviceAtlas    | 10     | —    | deviceatlas.com                                                                                                                                                                                     | DeviceAtlas                      |
| `fingerprintjs` | FingerprintJS  | 10     | —    | api.fpjs.io, api.fpjs.pro, fingerprint.com, fingerprintjs.com, fingerprintjs.io, fpcdn.io, fpjs.io, fpjs.sh, fpjscdn.net, fpnpmcdn.net, fptls.com, fptls2.com, fptls3.com, fptls4.com, openfpcdn.io | Fingerprint, FingerprintJS, fpjs |
| `groupib`       | Group-IB       | 10     | —    | group-ib.com, group-ib.ru                                                                                                                                                                           | GroupIB, groupib                 |
| `nudata`        | NuData         | 10     | —    | nudatasecurity.com                                                                                                                                                                                  | NuData, nudata                   |
| `typingdna`     | TypingDNA      | 10     | —    | typingdna.com                                                                                                                                                                                       | TypingDNA, typingdna             |
| `we-stats`      | We-Stats       | 10     | —    | we-stats.com                                                                                                                                                                                        | WeStats, weStats                 |
| `whiteops`      | HUMAN (legacy) | 10     | —    | whiteops.com                                                                                                                                                                                        | WhiteOps, whiteops               |

### vendors — bot management / anti-bot (kind `bot`)

| id               | label              | weight | risk | domains                                                                            | globals                                     |
| ---------------- | ------------------ | ------ | ---- | ---------------------------------------------------------------------------------- | ------------------------------------------- |
| `akamai`         | Akamai Bot Manager | 8      | 8    | abmr.net, akamai.net, akamaihd.net                                                 | \_abck, bmak                                |
| `botguard`       | BotGuard           | 8      | 8    | botguard.net                                                                       | BotGuard, botguard, botguardClient          |
| `cheq`           | CHEQ               | 8      | 8    | cheq.ai, cheqzone.com                                                              | CHEQ, cheq                                  |
| `cloudflare-bot` | Cloudflare         | 8      | 8    | cdn-cgi, challenge-platform                                                        | \_\_CF$cv$params, \_cf_chl_opt, cf_chl_opt  |
| `datadome`       | DataDome           | 8      | 8    | api.datadome.co, datadome.co, datadome.io, js.datadome.co                          | \_dd_s, ddjskey, ddoptions                  |
| `distil`         | Distil             | 8      | 8    | distilnetworks.com                                                                 | \_distil, distil                            |
| `geetest`        | Geetest            | 8      | 8    | geetest.com                                                                        | geetest, initGeetest                        |
| `human`          | HUMAN              | 8      | 8    | humansecurity.com                                                                  | HUMAN                                       |
| `imperva`        | Imperva            | 8      | 8    | imperva.com, incapsula.com                                                         | Incapsula, \_Incapsula_Resource, incap_ses  |
| `jscrambler`     | Jscrambler         | 8      | 8    | jscrambler.com                                                                     | Jscrambler, jscrambler                      |
| `kasada`         | Kasada             | 8      | 8    | kasada.io, kasada.net, kasadacdn.com                                               | KPSDK, \_kasada, kasada                     |
| `netacea`        | Netacea            | 8      | 8    | netacea.com                                                                        | netacea                                     |
| `perimeterx`     | PerimeterX         | 8      | 8    | perimeterx.com, perimeterx.net, px-cdn.net, px-client.net, px-cloud.net, pxchk.net | PX, \_pxAppId, \_pxHostUrl, \_pxJsClientSrc |
| `shape`          | Shape Security     | 8      | 8    | shapesecurity.com                                                                  | ShapeSecurity, \_shape                      |
| `shieldsquare`   | ShieldSquare       | 8      | 8    | shieldsquare.com                                                                   | shieldsquare                                |

### vendors — payment, identity and fraud decisioning (kind `payment`)

| id               | label            | weight | risk | domains                                                                             | globals                        |
| ---------------- | ---------------- | ------ | ---- | ----------------------------------------------------------------------------------- | ------------------------------ |
| `accertify`      | Accertify        | 8      | —    | accertify.com                                                                       | Accertify, accertify           |
| `blackwall`      | Blackwall        | 8      | —    | blackwall.ai                                                                        | Blackwall, blackwall           |
| `braintree`      | Braintree        | 8      | —    | braintree-api.com, braintreegateway.com                                             | braintree                      |
| `clearsale`      | ClearSale        | 8      | —    | clear.sale                                                                          | ClearSale, clearsale           |
| `feedzai`        | Feedzai          | 8      | —    | feedzai.com                                                                         | Feedzai, feedzai               |
| `forter`         | Forter           | 8      | —    | cdn.forter.com, forter.com                                                          | \_forter, forter               |
| `iesnare`        | Iovation iesnare | 8      | —    | iesnare.co.uk, iesnare.com                                                          | \_iesnare, iesnare             |
| `iovation`       | iovation         | 8      | —    | iovation.co.uk, iovation.com                                                        | \_iovation, iovation           |
| `ipfingerprint`  | IPFingerprint    | 8      | —    | ipfingerprint.com                                                                   | IPFingerprint, ipfingerprint   |
| `ipqualityscore` | IPQualityScore   | 8      | —    | ipqualityscore.com                                                                  | IPQualityScore, ipqualityscore |
| `kount`          | Kount            | 8      | —    | kount.com, kount.net                                                                | kount                          |
| `lexisnexis`     | LexisNexis Risk  | 8      | —    | lexisnexisrisk.com                                                                  | LexisNexis, lexisnexis         |
| `maxmind`        | MaxMind          | 8      | —    | maxmind.com                                                                         | MaxMind, maxmind               |
| `nethone`        | Nethone          | 8      | —    | nethone.com                                                                         | Nethone, nethone               |
| `riskified`      | Riskified        | 8      | —    | riskified.com                                                                       | Riskified, riskified           |
| `riskmetrix`     | RiskMetrics      | 8      | —    | riskmetrix.net                                                                      | RiskMetrics, riskmetrix        |
| `sardine`        | Sardine          | 8      | —    | sardine.ai                                                                          | \_sardine, sardine             |
| `seon`           | SEON             | 8      | —    | seon.io                                                                             | Seon, seon                     |
| `sift`           | Sift             | 8      | —    | api.sift.com, cdn.sift.com, events.api.sift.com, sift.co, sift.com, siftscience.com | \_sift, sift                   |
| `signifyd`       | Signifyd         | 8      | —    | signifyd.com                                                                        | Signifyd, signifyd             |
| `socure`         | Socure           | 8      | —    | socure.com, socure.io                                                               | Socure, socure                 |
| `stytch`         | Stytch           | 8      | —    | telemetry.stytch.com                                                                | Stytch, stytch                 |
| `threatmetrix`   | ThreatMetrix     | 8      | —    | online-metrix.net, threatmetrix.net                                                 | \_tmx, threatmetrix, tmx       |

### vendors — CAPTCHA / device check (kind `captcha`)

| id                 | label                | weight | risk | domains                                                    | globals                          |
| ------------------ | -------------------- | ------ | ---- | ---------------------------------------------------------- | -------------------------------- |
| `altcha`           | Altcha               | 5      | 8    | altcha.org                                                 | Altcha, altcha                   |
| `arkose`           | Arkose Labs          | 5      | 8    | arkoselabs.com, funcaptcha.com                             | Arkose, arkose, funcaptcha       |
| `datadome-captcha` | DataDome CAPTCHA     | 5      | 8    | captcha-delivery.com                                       | captchaDelivery                  |
| `friendlycaptcha`  | Friendly Captcha     | 5      | 8    | frcapi.com, friendlycaptcha.com                            | FriendlyCaptcha                  |
| `hcaptcha`         | hCaptcha             | 5      | 8    | hcaptcha.com, hcaptcha.net                                 | hcaptcha                         |
| `mtcaptcha`        | MTCaptcha            | 5      | 8    | mtcaptcha.com                                              | MTCaptcha                        |
| `prosopo`          | Prosopo              | 5      | 8    | procaptcha.io, prosopo.io                                  | prosopo                          |
| `recaptcha`        | reCAPTCHA            | 5      | 8    | google.com/recaptcha, gstatic.com/recaptcha, recaptcha.net | \_\_\_grecaptcha_cfg, grecaptcha |
| `turnstile`        | Cloudflare Turnstile | 5      | 8    | challenges.cloudflare.com, turnstile.cloudflare.com        | turnstile                        |

### device

| id              | label                      | weight | kind   |
| --------------- | -------------------------- | ------ | ------ |
| `audio`         | audio fingerprint          | 5      | strong |
| `battery`       | battery status             | 2      | weak   |
| `canvas`        | canvas image data          | 5      | strong |
| `client_hints`  | Client Hints               | 2      | weak   |
| `codecs`        | codec support              | 2      | weak   |
| `connection`    | connection type            | 2      | weak   |
| `fonts`         | installed fonts            | 5      | strong |
| `hardware`      | CPU and memory             | 2      | weak   |
| `languages`     | language list              | 2      | weak   |
| `media_devices` | camera and microphone list | 2      | weak   |
| `permissions`   | permission states          | 2      | weak   |
| `plugins`       | plugin list                | 2      | weak   |
| `screen`        | screen geometry            | 2      | weak   |
| `storage`       | storage quota              | 2      | weak   |
| `timezone`      | device timezone            | 2      | weak   |
| `webgl`         | WebGL renderer strings     | 5      | strong |
| `webrtc`        | WebRTC network info        | 2      | weak   |

### replay

| id              | label             | weight | domains                                                | globals                                                                 |
| --------------- | ----------------- | ------ | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| `browsee`       | Browsee           | 6      | browsee.io                                             | Browsee                                                                 |
| `clarity`       | Microsoft Clarity | 6      | clarity.ms                                             | clarity                                                                 |
| `contentsquare` | Contentsquare     | 6      | contentsquare.com, contentsquare.net                   | CS_CONF, \_cs, contentsquare                                            |
| `datadog-rum`   | Datadog RUM       | 6      | datadoghq-browser-agent.com, datadoghq.com, dd-rum.com | DD_RUM                                                                  |
| `fullstory`     | FullStory         | 6      | fullstory.com                                          | FS, FullStory, \_fs_org                                                 |
| `heap`          | Heap              | 6      | heap.io, heapanalytics.com                             | heap                                                                    |
| `hotjar`        | Hotjar            | 6      | hotjar.com, hotjar.io                                  | hj, hotjar                                                              |
| `inspectlet`    | Inspectlet        | 6      | inspectlet.com                                         | Inspectlet, \_\_insp                                                    |
| `logrocket`     | LogRocket         | 6      | logrocket.com, logrocket.io, lr-ingest.com             | LogRocket                                                               |
| `luckyorange`   | Lucky Orange      | 6      | luckyorange.com, luckyorange.net                       | LuckyOrange, \_lo                                                       |
| `mouseflow`     | Mouseflow         | 6      | mouseflow.com                                          | \_mf, mouseflow                                                         |
| `openreplay`    | OpenReplay        | 6      | asayer.io, openreplay.com, openreplay.io               | OpenReplay, OpenReplayAPI, openReplay                                   |
| `pendo`         | Pendo             | 6      | pendo.io                                               | pendo                                                                   |
| `posthog`       | PostHog           | 6      | posthog.com                                            | posthog                                                                 |
| `quantummetric` | Quantum Metric    | 6      | quantummetric.com, quantummetric.io                    | QM, QuantumMetricAPI                                                    |
| `rrweb`         | rrweb             | 6      | rrweb.io                                               | rrweb, rrwebPlayer                                                      |
| `sentry-replay` | Sentry Replay     | 6      | sentry-cdn.com, sentry.io                              | Sentry.Replay, Sentry.replayCanvasIntegration, Sentry.replayIntegration |
| `smartlook`     | Smartlook         | 6      | smartlook.cloud, smartlook.com                         | smartlook                                                               |

### compat

| id                   | label                      | kind      | risk |
| -------------------- | -------------------------- | --------- | ---- |
| `bot_challenge`      | bot checks                 | challenge | 12   |
| `captcha`            | a CAPTCHA                  | challenge | 10   |
| `card_field`         | a card or payment form     | payment   | 16   |
| `checkout_path`      | a checkout or payment step | payment   | 12   |
| `cross_origin_frame` | embedded sign-in frames    | auth      | 4    |
| `email_field`        | an email field             | auth      | 6    |
| `login_path`         | a sign-in page             | flow      | 8    |
| `oauth_redirect`     | third-party sign-in        | auth      | 10   |
| `password_field`     | a sign-in form             | auth      | 12   |
| `payment_request`    | a payment sheet            | payment   | 10   |
| `trusted_types`      | Trusted Types              | policy    | 4    |
| `webauthn`           | passkey sign-in            | auth      | 10   |

### vectors

```text
anchor, area, audio, audio-ctor, base, beacon, css-import, css-url, cssom-csstext, cssom-insert, cssom-replace, cssom-setprop, dom-observer, embed, event-source, fetch, form, frame, iframe, image-ctor, img, img-srcset, input, link, markup, media, object, script, shared-worker, source, style-attr, style-text, track, unknown, video-poster, worker, worklet, xhr
```

`domains` matching: a plain host is a **host suffix** (`fpjs.io` matches
`a.fpjs.io`), `host/pathPrefix` matches that host with the lowercased path prefix
(`google.com/recaptcha`), and a bare fragment (`cdn-cgi`, `challenge-platform`) is a
path fragment (`/cdn-cgi/…`). No scheme, no `www.` implied. `globals` are dotted
paths resolved from `window`; only their presence is checked, never their value.

The static test also asserts that every domain in `rules/fingerprint_vendors.json`
and `rules/captcha_vendors.json` is covered by exactly one vendor row, that ids and
labels are unique, that kinds are valid and weights positive, that compat risks
match this table, that the vector list is canonical, that the file stays data-only,
and that every compat id has a `COMPAT_COPY` template (vendor, device and replay
copy is generated from their labels; the six headline templates and LIMITS are
pinned too).
