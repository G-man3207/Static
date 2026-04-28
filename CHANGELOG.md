# Changelog

All notable changes to Static will be documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Opt-in Device signal poisoning for high-entropy browser surfaces, with stable per-origin personas.
- QA diagnostics mode for local compatibility testing, including anonymized issue reports.
- Replay poisoning detection for Sentry Replay runtime setup, Hotjar, OpenReplay, and replay-specific Datadog/PostHog startup paths.

### Changed

- Adaptive observe-only logging now treats environment snapshots (screen, timezone, storage, and high-entropy navigator reads) as corroborating signals for crypto-plus-network collector flows.
- Adaptive observe-only logging now treats WebSocket and WebTransport construction as network corroboration for first-party or proxied collectors.
- Fingerprint DNR connection rules now include `websocket` and `webtransport` resource types so known provider hosts do not keep a persistent-transport escape path.
- Popup controls now keep detailed sections folded by default, rank probe-log origins by severity, and explain adaptive reason tokens.
- Popup framing now describes network rules as scoped fingerprint checks and recommends uBlock Origin / Privacy Badger for broad tracker blocking.
- Pre-commit CI checks now cover formatting and strict linting.

### Removed

- Removed broad LinkedIn telemetry, session-replay, and Datadog RUM network rulesets from the extension surface so Static stays focused on extension probing and fingerprinting rather than duplicating general tracker blockers.

### Fixed

- Device signal poisoning now preserves caller-requested `Intl.DateTimeFormat` time zones while still masking the default timezone.
- Device signal poisoning now keeps masked User-Agent Client Hints method identities stable, closing a native-surface detection gap.
- Replay poisoning now respects provider-documented replay-off init controls for Datadog manual replay starts and PostHog flags-disabled setups, so ordinary RUM/product analytics listeners are not masked as replay listeners before recording starts.
- Fingerprint vendor blocking now covers Fingerprint's current `api.fpjs.io` API host family in addition to the existing CDN, TLS, npm-loader, and `api.fpjs.pro` hosts.
- Client Hints masking now handles invocation context correctly.
- Popup help tooltips stay bounded and no longer expose native `title` tooltips.
- Style text-node insertion and mutation probes now fail closed synchronously before extension URLs can be read back from `<style>` contents.
- Clear log now resets pending page bridge batches before deleting storage, preventing queued Noise probes from recreating logs.
- Popup diagnostics now resolve current-site probe history after quiet page loads that perform no new probes.
- Noise passive decoys now preserve native `Attr` node identity for `setAttributeNode` and `setAttributeNodeNS` probes while still hiding internal data-URL replacements.
- Wrapped constructors now preserve native no-`new` `TypeError` behavior before inspecting extension URLs, closing a detection and false probe-log side effect in Worker, SharedWorker, Audio, EventSource, and MutationObserver shims.
- DOM marker scrubbing now catches open shadow roots attached shortly after their host element is inserted.

## [2.0.10] — 2026-04-24

### Added

- Power-user diagnostics in the popup and log viewer for local probe/adaptive evidence, Noise readiness, and probe behavior details.
- Adaptive runtime detection for proxied or first-party Fingerprint, DataDome, HUMAN/PerimeterX, and Sift integrations.
- Adaptive source attribution for external scripts, dynamic modules, timers, promises, microtasks, mutation observers, `postMessage`, custom events, and `onmessage` handoffs.
- Extension URL blocking coverage for SVG href probes and worklet module loaders.

### Changed

- GitHub Actions now run only for new `v*.*.*` version tag pushes; formatting is checked on the tagged commit instead of auto-committed after release.
- Adaptive observe-only logging treats environment snapshots as corroborating signals for crypto-plus-network collector flows.
- The disabled CAPTCHA ruleset covers DataDome response-page hosts under `captcha-delivery.com`.
- Fingerprint, replay, CAPTCHA, and site-specific DNR rules include persistent transport resource types where applicable.

### Fixed

- Clear log now resets pending per-page bridge batches so stale probe flushes cannot recreate local probe storage after the user clears it.
- Clear log now clears in-memory tab probe state, resets badges, and disarms already-open pages'
  Noise personas without requiring a reload.
- Session replay blocking covers PostHog's documented `*.i.posthog.com` cloud ingest/assets host family, and Replay poisoning recognizes PostHog replay bundle names used by first-party proxy setups.
- Replay poisoning now recognizes documented PostHog global replay starts (`posthog.init(...)` default recording and `posthog.startSessionRecording()`) without treating explicitly disabled `disable_session_recording` installs as replay recorders.
- Session replay blocking covers Heap's documented classic replay `*.auryc.com` host family.
- Noise mode no longer answers arbitrary supported-suffix path canaries like random `*.png` / `*.js` / `*.css` / `*.html` names; decoys are now limited to a conservative allowlist of plausible extension resource paths.
- Noise mode passive decoys preserve original URLs through attribute nodes, serialization, link preloads, and related readback paths.
- Extension URL probes are normalized more consistently before blocking, including whitespace-padded and style/CSSOM vectors.
- Iframe policy handling, Trusted Types script decoys, benign console noise, and transient DOM marker observer exposure are hardened.

## [2.0.4] — 2026-04-18

### Fixed

- Released the formatter-stable replay lint fix so the tagged version is based on the CI-passing `main` state.

## [2.0.3] — 2026-04-18

### Fixed

- Released the strict-lint follow-up after the `v2.0.2` formatter pass.

## [2.0.2] — 2026-04-18

### Added

- Passive element Noise decoys for eligible personas, covering image, script, stylesheet, source, embed, and object probes while keeping active surfaces fail-closed.
- Cross-vector Noise behavior contract and adversarial Playwright regression coverage.
- Local playbook drift detection. Static now stores weekly per-origin probe summaries for vector mix, path-kind mix, repeated ID dictionaries, and one-shot ID pressure, then surfaces `Learning` / `Stable` / `Changed` / `High drift` indicators in the probe log.
- Popup warning for active sites whose probe behavior has recently changed or drifted heavily from their local baseline.
- Playwright coverage for playbook summary recording and log-viewer drift indicators.
- Opt-in Replay poisoning modes (`off`, `mask`, `noise`, `chaos`) that detect likely session-replay SDKs, redact form values for replay listeners, jitter replay-only coordinates/geometry, and deliver local decoy events directly to replay listeners in Chaos mode.
- Sentry Replay coverage via replay-specific Sentry signatures and narrow blocking for Sentry CDN replay bundles.
- Popup Replay poisoning selector plus an active-site replay detection indicator.
- Local replay detection summaries in raw log exports and Clear-log cleanup.
- Playwright coverage proving replay listeners receive redacted/jittered data while ordinary page handlers receive real values.
- Local-only adaptive blocking design document covering threat model, calibration, cost asymmetry, DNR race handling, initiator scoping, sampling, and circuit breakers.
- Observe-only adaptive behavior logging for multi-signal fingerprinting, replay, and anti-bot patterns. No dynamic/session DNR rules are created yet.
- Popup/log/export visibility for local adaptive signals, plus Playwright calibration coverage for a multi-signal collector and a canvas-heavy negative fixture.

### Fixed

- Tightened stealth wrapper shape, extension ID validation, local high-entropy path redaction, and open shadow-root DOM marker scrubbing.

## [2.0.1] — 2026-04-18

### Fixed

- Shortened `manifest.json` `"description"` field from 171 to 124 characters so it fits within Chrome Web Store's 132-character limit. No functional change.

## [2.0.0] — 2026-04-18

Initial public release.

### Blocking engine (MAIN-world)

- Rejects page-script probes to `chrome-extension://` (and `moz-extension://`, `ms-browser-extension://`, `safari-web-extension://`, `edge-extension://`) across every vector we've seen used: `fetch`, `XMLHttpRequest`, element `src|href|data` setters, `setAttribute` / `setAttributeNS`, `navigator.sendBeacon`, `Worker`, `SharedWorker`, `EventSource`, `navigator.serviceWorker.register`.
- XHR state stored in a closure `WeakMap` so no tamper marker lands on the instance (some sites log failing XHR objects to console).
- Stealth: `Function.prototype.toString` patched via `WeakMap` of wrapped functions → native-looking strings, so every patched API is indistinguishable from its native counterpart under any `toString` path.
- Sandboxed-iframe safe: feature-detection blocks wrapped in `try/catch` so `SecurityError` on restricted APIs like `navigator.serviceWorker` doesn't surface in host-page consoles (seen on x.com tweet embeds).

### DOM-layer defenses (ISOLATED-world)

- MutationObserver-based scrubber strips extension-announcing attributes, classes, and custom-element tags (Grammarly, 1Password, LastPass, Dashlane, Honey, Keeper, NordPass, RoboForm patterns).
- Known `window` globals used as extension-to-page bridges are locked to `undefined` via `Object.defineProperty(..., { configurable: false })` before any page script runs. Covers React / Redux / Vue / MobX / Apollo devtools hooks, password-manager presence flags, Grammarly session markers.

### Network-layer blocklists

Five toggleable DNR rulesets with per-ruleset `enabled` defaults, file-per-category:

- `linkedin` (on) — sensor/metrics collection, conversion tracking, ad pixel, adblock-detection script, marketing tag system, internal Piwik, `lnkd.in` redirector.
- `fingerprint_vendors` (on) — FingerprintJS, DataDome, PerimeterX/HUMAN, Sift, Forter, ThreatMetrix/TransUnion, Iovation, Kasada, Sardine, Shape Security/F5.
- `captcha_vendors` (off) — Arkose Labs / FunCAPTCHA. Off by default because blocking breaks logins on some sites.
- `session_replay` (on) — FullStory, LogRocket, Mouseflow, Contentsquare, Smartlook, Quantum Metric, Microsoft Clarity, Heap, Pendo, Lucky Orange, Inspectlet, Browsee.
- `datadog_rum` (off) — Datadog Real-User-Monitoring intake (all regions + browser agent CDN). Off by default because it's also used for legitimate monitoring.

### Noise mode _(opt-in)_

- Learns each site's probe dictionary from its own behavior and returns plausible decoy responses for a stable 3–8 ID subset on subsequent visits.
- Persona is deterministic per `(user_secret, origin, week_number)`: stable for a week, rotates weekly, different users' personas differ because the 256-bit `user_secret` is generated once per install via `crypto.getRandomValues`.
- Slot-based conflict avoidance prevents implausible combos (no "three password managers installed" tells). Slots: password manager, ad blocker, grammar, Web3 wallet, devtools, translator.
- Canary-resistant: an ID must be observed at least twice on an origin before entering the replay pool.
- Decoy responses are path-switched: `/manifest.json` → generic valid MV3 manifest JSON; `*.png|.jpg|.gif|.webp|.ico|.bmp` → 1×1 transparent PNG; `*.svg` → empty SVG; `*.js|.html|.css|.json` → empty body with correct content type.
- Decoys `fetch` and `XMLHttpRequest`. Element-based probes stay blocked for consistency (partial decoy could be detected by correlating vectors).

### UI

- Popup: per-tab blocked count (magnitude-scaled color: grey → orange at 100 → red at 1000), cumulative since-install counter, top-5 probed extension IDs disclosure, ruleset toggles with live `chrome.declarativeNetRequest.updateEnabledRulesets` (no reload), Noise mode toggle with explainer, link to full probe log.
- Log viewer (`log.html`): searchable table of origins sorted by probe volume, expandable per-origin ID-count listing, raw + research export buttons.
- Branding: logo + title header, 3-pixel desaturated SMPTE brand stripe as divider, subtle SVG-noise-texture body background, iOS-style toggle switches.

### Privacy

- Probe logs are stored locally in `chrome.storage.local`, capped at 100 origins × 2,000 IDs per origin. Nothing leaves the machine unless explicitly exported.
- Two export formats in the log viewer:
  - **Raw** — full fidelity: timestamps, exact counts, since-install cumulative. For private archival; should not be published (cross-user correlation risk).
  - **Research** — anonymized: coarse `exportMonth` only, log-scale count buckets (`2-5` / `6-20` / `21-100` / `101-1000` / `1000+`), single-occurrence IDs dropped, origins with <3 qualifying IDs dropped. Safe to publish or contribute to aggregate datasets.
  - Schema tag on each export (`static.probe-log.v1` and `static.probe-log.shareable.v1`) for future aggregators to validate against.

### Architecture

- Modular: all DOM/global pattern data lives in `lists.js` (single source of truth consumed by content scripts + service worker via `importScripts`). Rulesets live one-per-file under `rules/`. `rules/META.json` sidecar carries version / last_verified / description metadata.
- Service-worker resilience: cumulative counter uses deltas (not cumulative), so SW restart doesn't double-count. Per-frame blocked-count state uses cumulative snapshots so SW restart self-heals on next message.
- Internal message / property names namespaced with `static_` / `__static_*` prefix.

### Tooling

- MIT licensed.
- `.editorconfig`, `.prettierrc`, `.prettierignore` for cross-editor consistency.
- GitHub Actions: `format.yml` (Prettier auto-format + commit back), `validate.yml` (JSON syntax + DNR rule shape + manifest file-reference checks), `release.yml` (tag-triggered zip + GitHub Release).

[Unreleased]: https://github.com/G-man3207/Static/compare/v2.0.10...HEAD
[2.0.10]: https://github.com/G-man3207/Static/compare/v2.0.4...v2.0.10
[2.0.4]: https://github.com/G-man3207/Static/compare/v2.0.3...v2.0.4
[2.0.3]: https://github.com/G-man3207/Static/compare/v2.0.2...v2.0.3
[2.0.2]: https://github.com/G-man3207/Static/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/G-man3207/Static/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/G-man3207/Static/releases/tag/v2.0.0
