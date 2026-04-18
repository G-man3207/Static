<p align="center">
  <img src="icons/icon-128.png" alt="Static" width="128" height="128">
</p>

<h1 align="center">Static</h1>

<p align="center">
  <strong>Anti-fingerprinting Chrome extension that blocks extension enumeration, browser fingerprinting, and session-replay telemetry — and optionally poisons probe logs with plausible decoys.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/G-man3207/Static?color=blue" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/manifest-v3-brightgreen" alt="Manifest V3">
  <img src="https://img.shields.io/github/v/release/G-man3207/Static" alt="Latest release">
  <img src="https://img.shields.io/badge/tests-Playwright-45ba4b" alt="Playwright tests">
</p>

---

## What it does (10-second version)

Websites quietly probe your browser to figure out **which extensions you have installed**, fingerprint your browser, and record your session via vendors like FullStory and LogRocket. Static blocks all three — and in **Noise mode** it feeds extension probes plausible-but-fake answers, while optional **Replay poisoning** masks and perturbs what detected session-replay listeners see.

> On LinkedIn, Static blocks ~4,500 extension-enumeration probes per page load. The popup shows the live count.

<!-- TODO: add demo.gif here -->
<!-- ![Static popup showing 4,217 probes blocked on LinkedIn](docs/demo.gif) -->

## Install

**From source (today):**

1. Clone this repository
2. Open `chrome://extensions`
3. Toggle **Developer mode** (top-right)
4. Click **Load unpacked** and select the repo folder

**From the Chrome Web Store:** _coming soon_

---

## What it blocks

1. **Extension enumeration.** Pages that iterate through extension IDs via `fetch("chrome-extension://<id>/<resource>")` (and XHR / `<script src>` / `<link href>` / `<img src>` / image `srcset` / image-input `src` / video `poster` / media and track `src` / object/embed/source URLs / CSSOM `@import` rules / CSS declaration and style-attribute URLs / `sendBeacon` / `Worker` / `SharedWorker` / `EventSource` / `serviceWorker.register` equivalents) to probe which extensions are installed. All those vectors are patched in the page's MAIN world to reject `chrome-extension://` (plus `moz-extension://`, `ms-browser-extension://`, `safari-web-extension://`, `edge-extension://`) transparently.
2. **DOM-marker fingerprinting.** A MutationObserver strips attributes, classes, and custom-element tags that browser extensions leave on the DOM to announce their presence.
3. **`window` global fingerprinting.** Devtools bridges and extension-presence markers (`__REACT_DEVTOOLS_GLOBAL_HOOK__`, `__GRAMMARLY_DESKTOP_INTEGRATION__`, etc.) are locked to `undefined` before page scripts run.
4. **Network-layer blocklists (togglable).** Declarative-Net-Request rulesets block known:
   - **Fingerprinting / anti-bot vendors** — FingerprintJS, DataDome, PerimeterX/HUMAN, Sift, Forter, ThreatMetrix/TransUnion, Iovation, Kasada, Sardine, Shape Security/F5.
   - **CAPTCHA vendors** _(off by default, breaks logins)_ — Arkose Labs / FunCAPTCHA.
   - **Session-replay vendors** — FullStory, LogRocket, Mouseflow, Contentsquare, Smartlook, Quantum Metric, Microsoft Clarity, Heap, Pendo, Lucky Orange, Inspectlet, Browsee, and Sentry Replay CDN bundles.
   - **Datadog RUM** _(off by default, also used for legitimate monitoring)_.
   - **LinkedIn** — sensor/metrics collection, conversion tracking, ad pixel, adblock detection, internal Piwik, marketing tag system, LMS analytics.
5. **Self-stealth.** `Function.prototype.toString` is patched with a `WeakMap` of wrapped functions → native-looking strings, so the blocker's API overrides are indistinguishable from natives under any `toString` check.
6. **Replay poisoning _(opt-in)._** When a likely session-replay SDK is detected in page script, Static can proxy only that recorder's event listeners so they see redacted form values and jittered coordinates while ordinary page handlers still receive the real events.

The toolbar badge and popup show a live count of extension-enumeration probes blocked on the current tab. On sites that probe aggressively (LinkedIn runs ~4,500 per page load) the number climbs into the thousands within seconds.

## Playbook drift detection

Static keeps a local, weekly summary of how each origin probes for extensions: probe vector mix (`fetch`, XHR, element setters, workers, EventSource, etc.), extension-resource path kinds (`manifest`, image, script, HTML, CSS, other), repeated ID dictionary changes, and one-shot ID pressure.

The probe log viewer shows a **Probe behavior** indicator per origin:

- **Learning** — not enough baseline data yet.
- **Stable** — no meaningful change from that origin's previous probe behavior.
- **Changed** — the origin changed how it checks for extensions.
- **High drift** — multiple signals shifted at once, such as new probe vectors plus path strategy or ID dictionary changes.

Expanding an origin shows the concrete reasons. The popup also shows a compact warning when the active site has recent `Changed` or `High drift` behavior.

This is an early-warning system, not attribution. It means "this origin changed how it checks for extensions," not necessarily "this origin adapted to Static."

## Adaptive behavior log _(observe-only)_

Static also has a local-only adaptive behavior logger for future dynamic blocking work. It watches for correlated behavior windows such as canvas/WebGL/audio readback plus navigator reads and network transmission, crypto plus network transmission, or document-wide mutation observation plus aggressive input hooks.

This is intentionally **observe-only** today:

- No backend, no telemetry, no automatic sharing.
- No dynamic or session DNR rules are created from these signals yet.
- No request bodies, form values, cookies, local storage, or full URLs are stored.
- Only compact local metadata is recorded: category, score, origin/path endpoint, source label, reasons, counts, and timestamps.

The design, cost model, calibration requirements, and future blocking stages are documented in `docs/adaptive-blocking.md`.

## Noise mode _(opt-in)_

Blocking a probe proves one thing: "some defense is present." **Noise mode** goes further — it learns each site's probe dictionary from its own behavior, then returns plausible decoy responses for a stable subset of those same IDs. The site sees its targets as "installed" and logs them; the logs get poisoned with IDs the site itself cared about.

- **Self-calibrating.** Each site tells you, by what it probes for, what its threat model is. LinkedIn probes for scraper extensions; a crypto site probes for wallets. The decoy persona Static constructs is drawn from _that specific site's_ probe list, so the noise is maximally relevant to what they're looking for.
- **Stable per origin.** The 3–8 ID persona for each origin is deterministic from `hash(user_secret + origin + week)`. Stable for a week (so you don't look like a bot changing extensions every pageview); rotates after that; different users' sets differ (no cross-user fingerprint because the secret is random per install).
- **Conflict-aware.** IDs are bucketed into slots (password manager, ad blocker, grammar, web3 wallet, devtools, translator) and the persona picks at most one per slot — no "three password managers installed" tells.
- **Canary-resistant by design.** Known plausible extension IDs can enter the replay pool after Static has seen them probed at least twice on that origin. Unknown extension-shaped IDs need stronger repeated evidence before Static will claim them, so cheap two-hit canaries do not become part of Static's own persona.
- **Cold start is honest.** First visit to a site produces no poisoning because there's nothing logged yet. From the second pageview onward, the site gets noise.
- **Decoy responses by path.** Static-read `GET` / `HEAD` probes to `.../manifest.json` return a generic valid manifest; `*.png` etc. return a 1×1 transparent PNG; `*.js`/`.html`/`.css` return empty with correct content types. Non-static method and unsupported-path canaries stay blocked. Covers what site-side detectors typically check for.

**Scope in v2.1:** Noise mode decoys `fetch`, `XMLHttpRequest`, and passive element probes for eligible persona IDs. Images, `srcset` candidates, image inputs, video posters, scripts, and stylesheets receive small inert data-URL resources while page-visible `src` / `srcset` / `href` / `data` / `poster` getters still report the original extension URL. Frames, CSSOM `@import` rules, CSS declaration URLs set through `setProperty` / `cssText`, and active surfaces with larger behavioral footprints (`iframe`, media streams, track files, `Worker`, `SharedWorker`, `EventSource`, and `serviceWorker.register`) stay fail-closed.

The cross-vector behavior contract is documented in `docs/noise-behavior.md`.

**Privacy:** Probe logs are kept locally in `chrome.storage.local`. Capped at 100 origins × 2,000 IDs each, with weekly playbook summaries capped to the latest 10 weeks. Nothing leaves your machine unless you explicitly export.

Two export formats are available in the log viewer (click **View probe log** in the popup):

- **Export raw log** — full detail. Contains per-origin timestamps (`lastUpdated`), exact probe counts, weekly playbook summaries, your since-install cumulative counter, and the precise `exportedAt` moment. This is fine for your own archive but **should not be published** — timestamp + count patterns can cross-correlate users across sites if multiple raw dumps from different users ever end up in the same hands.
- **Export for research** — anonymized. Replaces precise `exportedAt` with a coarse `"exportMonth": "YYYY-MM"` bucket, drops per-origin `lastUpdated`, drops the `cumulative` counter, coarsens per-ID counts into log-scale buckets (`"2-5"`, `"6-20"`, `"21-100"`, `"101-1000"`, `"1000+"`), drops any ID that was probed fewer than 2 times (canary filter), drops any origin with fewer than 3 surviving IDs (low-signal noise), and replaces origin/extension-ID labels with per-export salted hashes. Safer to publish, but intentionally less useful for cross-user correlation than the raw log.

Noise mode is **off by default** — turning it on is an active choice to shift Static from pure defense to counter-intelligence. Toggle it from the popup.

## Replay poisoning _(opt-in)_

The session-replay ruleset blocks known replay vendors at the network layer. If a replay SDK still runs because it is self-hosted, newly named, or the ruleset is disabled, Replay poisoning can make its local recording stream less trustworthy without sending fake traffic to the vendor.

Replay poisoning detects likely replay code from script URLs, known globals, and replay-looking listener sources, then wraps only those listeners:

- **Off** — detect and log replay SDK signals locally, but do not alter events.
- **Mask** — replay listeners see redacted input values (`redacted`, `redacted@example.invalid`, `0`) and generic key/input data. Normal page listeners still see the real value.
- **Noise** — Mask plus small per-event coordinate and rectangle jitter, so pointer paths and element geometry become less stable.
- **Chaos** — Noise plus local decoy click/focus/input/blur events delivered directly to detected replay listeners. These synthetic events are not dispatched through the DOM, so normal page handlers do not receive them.

The feature is scoped to replay listeners rather than the whole page. It does not originate network requests, does not call replay vendor APIs, and does not store form contents. Replay detection signals are stored locally by origin so the popup can show when a site has active replay behavior.

Sentry Replay is handled here too. Static looks for replay-specific Sentry signatures such as `replayIntegration`, `replayCanvasIntegration`, replay sample-rate options, `@sentry/replay`, `rrweb`, and Sentry CDN bundle paths containing `replay`. It intentionally does not block all `*.ingest.sentry.io` traffic because regular Sentry error monitoring and Session Replay share envelope transport URLs.

## Install

1. Clone this repository.
2. Open `chrome://extensions`.
3. Toggle **Developer mode** (top-right).
4. Click **Load unpacked** and select the repo folder.

## Toggle rulesets

Each category of network rules lives in its own file under `rules/`. Toggle them two ways:

- **From the popup** — click the extension icon. Each ruleset has a checkbox; changes apply live (no reload).
- **From `manifest.json`** — each `rule_resources` entry has an `enabled` flag. This controls the initial state on fresh install; after that, user toggles from the popup persist.

```json
"rule_resources": [
  { "id": "linkedin",            "enabled": true,  "path": "rules/linkedin.json" },
  { "id": "fingerprint_vendors", "enabled": true,  "path": "rules/fingerprint_vendors.json" },
  { "id": "captcha_vendors",     "enabled": false, "path": "rules/captcha_vendors.json" },
  { "id": "session_replay",      "enabled": true,  "path": "rules/session_replay.json" },
  { "id": "datadog_rum",         "enabled": false, "path": "rules/datadog_rum.json" }
]
```

`rules/META.json` is a sidecar index with `version`, `last_verified`, and human-readable descriptions for each ruleset. It's consumed by nothing at runtime — it's there so maintainers and contributors can tell which blocklists are fresh.

## Test

Static has three Playwright-backed test layers:

- **Static validation** checks manifest references, DNR rule shape, ruleset metadata, and popup ruleset IDs.
- **Extension integration** launches Chromium with the unpacked MV3 extension and verifies content-script, service-worker, DOM scrubber, Noise mode, log clearing, and stealth-wrapper behavior.
- **Adversarial consistency** probes one learned Noise persona across fetch, XHR, passive elements, attributes, active fail-closed vectors, and API descriptors to catch detector-visible contradictions.

Install dependencies once:

```bash
npm ci
npx playwright install chromium
```

Run fast static validation:

```bash
npm run test:static
```

Run ESLint:

```bash
npm run lint
```

`npm run lint:strict` fails on warnings too and is what CI uses.

Run real browser extension tests. On Linux without a desktop display, use Xvfb:

```bash
npm run test:e2e:xvfb
```

On a desktop session with a display, this also works:

```bash
npm run test:e2e
```

Run the full CI-style local check on Linux:

```bash
npm run check
```

## Extend coverage

- **DOM markers to strip** — edit the regex arrays in `lists.js`.
- **`window` globals to strip** — edit the `STRIP_GLOBALS` array in `block_globals.js`.
- **Endpoints to block at the network layer** — add rules to an existing file under `rules/`, or create a new `rules/<category>.json` and register it in `manifest.json`'s `rule_resources` (and add an entry in `rules/META.json` + `popup.js`'s `RULESET_META`).
- **A new script-layer probe vector (some new Web API that takes a URL)** — add a wrapper in `block_vectors.js`, following the existing `guardProp` / `patchWorkerCtor` / `attrGuard` patterns. Fetch/XHR Noise-mode decoys live in `block.js`.

## Layout

```
static/
├── manifest.json
├── lists.js              # DOM pattern + Noise persona config
├── block_adaptive.js     # MAIN-world observe-only adaptive behavior logging
├── block.js              # MAIN-world fetch/XHR blocker + Noise decoys
├── block_vectors.js      # MAIN-world element / worker / beacon / EventSource blockers
├── block_replay.js       # MAIN-world Replay poisoning
├── block_globals.js      # MAIN-world extension-global stripping
├── dom_scrubber.js       # ISOLATED-world DOM MutationObserver
├── bridge.js             # MessageChannel → service-worker relay
├── service_worker.js     # per-tab badge, storage, and message routing
├── service_worker_utils.js # service-worker caps, playbook drift, and utility helpers
├── popup.html, popup.js  # popup showing count + ruleset toggles
├── icons/                # 16/32/48/128 px icon set + original
└── rules/
    ├── META.json
    ├── linkedin.json
    ├── fingerprint_vendors.json
    ├── captcha_vendors.json
    ├── session_replay.json
    └── datadog_rum.json
```

## Caveats

- JS-layer patches run only where content scripts run. Pages served from `chrome://`, `about:`, the Chrome Web Store, and a handful of other restricted schemes are not covered.
- The DOM scrubber ships with a default list of extensions whose markers are stripped. If one of those is an extension you use, its in-page UI (autofill icons, inline suggestions, etc.) may not render. Remove that extension's patterns from `lists.js` to keep it working.
- Some sites use anti-bot vendors (PerimeterX, DataDome) as part of their login / checkout flow. If a site breaks, try disabling `fingerprint_vendors` first from the popup.
- `captcha_vendors` is disabled by default because Arkose/FunCAPTCHA is served as a CAPTCHA on some login flows (X signup, Roblox, some crypto exchanges); enabling it will break sign-in there.
- `datadog_rum` is disabled by default because Datadog RUM is also widely used for legitimate performance and error monitoring that site owners and users may want.
- Does not cover the entire browser-fingerprinting surface (canvas, WebGL, audio, fonts, font enumeration, WebRTC IP leak, etc.). Complements, doesn't replace, a dedicated anti-fingerprint extension.

## License

MIT — see [LICENSE](LICENSE).
