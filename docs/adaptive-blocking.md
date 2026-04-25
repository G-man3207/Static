# Adaptive Blocking Design

Adaptive blocking is local-only. Static must not run a backend, upload telemetry, or auto-share
user data. Every signal described here stays in `chrome.storage.local` unless the user explicitly
exports a raw log file from their own browser.

## Goal

Static rules block known endpoints before they run. Adaptive blocking is the second layer for vendor
rotation and self-hosted collectors: observe behavior, classify locally, and eventually block only
when confidence is high enough.

The current adaptive implementation is Stage 1 only: observe-only adaptive logging. It records
compact local signals and never creates dynamic DNR rules. Separate opt-in Device signal poisoning
can weaken many high-entropy Signal guide surfaces by returning stable per-site decoys instead of
blocking the reads.

## Threat Model

Attackers can read Static's source code. They can observe indirect effects such as failed requests,
empty responses, poisoned replay data, or degraded telemetry quality. They cannot directly read a
user's local score, decay-window state, threshold jitter seed, or adaptive log.

The defense relies on asymmetric information:

- Static scores actual behavior distribution inside the user's browser.
- Attackers tune against observable failure rates.
- Per-install jitter and multi-signal scoring make one universal evasion recipe less reliable.
- Decay windows force correlated behavior instead of one isolated API call.

This does not make evasion impossible. It raises the cost of cheap static playbooks and pushes
collectors toward behavior that looks more like legitimate app code.

## Ground Truth

Adaptive UI or blocking is not meaningful without calibration. Before any blocking stage ships, the
scorer needs three local test sets:

- Positive set: Fingerprint demo patterns, DataDome/HUMAN/PerimeterX/Arkose-style collectors,
  LinkedIn Spectroscopy-style collect/encrypt/POST flows, and known replay SDKs such as FullStory,
  LogRocket, Clarity, Sentry Replay, and rrweb.
- Validation-only references: EasyPrivacy, Disconnect, and Static's known-vendor rules. These can
  validate obvious agreement but must not become runtime telemetry or a backend feed.
- Negative set: Figma, Excalidraw, Google Meet, Zoom, Signal web, WebAudio tools, drawing apps, and
  internal analytics dashboards where canvas, media, crypto, or replay tooling can be legitimate.

Stage 1 tests should include both positive and negative fixtures. A canvas-heavy page alone should
not trigger an adaptive finding.

## Cost Model

False positives are more expensive than false negatives once blocking starts:

- Observe/UI: low confidence is acceptable because no request is blocked. False negatives matter
  more here because the purpose is discovery.
- Session quarantine: medium confidence. A bad rule disappears on browser restart.
- Dynamic persistent rule: high confidence. False positives can persistently break sites.

Thresholds should be chosen against this asymmetry, not by feel.

## Scoring

The scorer uses multi-signal windows. Single APIs are not enough:

- Canvas/WebGL/audio readback suggests fingerprinting only when paired with navigator or network
  signals.
- Environment snapshots such as screen, timezone, storage, and high-entropy navigator reads suggest
  fingerprinting only when paired with crypto and network transmission.
- Crypto plus large network transmission suggests anti-bot/sensor collection only when paired with
  collection signals.
- Document-wide `MutationObserver` plus aggressive input hooks suggests replay collection.

Sampling must be probabilistic and per-install seeded when introduced. Deterministic "every Nth
call" sampling is not acceptable because attackers can read the source and time around it.

## Blocking Stages

Stage 1: Observe-only adaptive log.

- Record local categories, scores, reasons, script source, and endpoint path.
- Record documented runtime vendor signatures for first-party or proxied SDKs when the page exposes
  strong client-side init markers, for example `window.ddjskey` plus `/tags.js` or versioned
  `/vX.Y.Z/tags.js` routes with the documented `/js/` collector inference, or explicit
  `window.ddoptions.endpoint` deployments even when the tag is served from a custom path,
  `window._pxAppId`,
  `window._sift.push(["_setAccount", ...])`, current `window.Fingerprint.start(...)`, or legacy
  `window.FingerprintJS.load(...)`.
- When documented globals are absent, attribute behavior-only findings to the executing external
  script source when it can be derived locally, and redact high-entropy path segments or query
  tokens before persisting the source label.
- Carry that source attribution across common async boundaries such as timers, promise callbacks,
  microtasks, and mutation-observer callbacks. If no URL-like source survives, persist a local
  runtime label such as `runtime:settimeout` instead of collapsing everything into
  `inline-or-runtime`.
- Carry that attribution through message-style event delivery as well, including listener objects,
  `postMessage`, custom-event listeners, and `onmessage` handlers. Leave replay-sensitive
  high-frequency DOM input/mouse event surfaces to the replay shim so the two systems do not
  double-wrap the same listeners.
- Do not block.
- Do not add dynamic or session DNR rules.
- Do not include adaptive data in anonymized research exports.
- High-entropy browser surfaces that overlap the Signal guide, such as navigator, screen, timezone,
  WebGL, canvas, offline audio, storage, battery, and network hints, may be weakened only by the
  user-controlled Device signal poisoning mode. Crypto and generic network calls remain observe-only
  because altering them would break application behavior or create a stronger detection signal.

Stage 2: UI calibration.

- Show "Adaptive signals observed" with reasons.
- Use positive and negative fixtures to tune thresholds.
- Keep user-facing language explicitly probabilistic.

Stage 3: MAIN-world immediate short-circuit.

- When a high-confidence network request is classified, block that current `fetch`, XHR, or
  `sendBeacon` in the page layer.
- This handles the race where DNR rules are not active yet.

Stage 4: Session DNR quarantine.

- Add initiator-scoped session rules for future requests from the same origin.
- Prefer host/path rules over broad regex.
- Keep the blast radius local to the origin that exhibited the behavior.

Stage 5: Dynamic persistent promotion.

- Promote only after repeated local evidence.
- Require initiator restrictions by default.
- Use LRU caps and local metadata.

## Circuit Breaker

Adaptive blocking must be easy to undo:

- Track recently added adaptive rules by origin.
- If a page exits, reloads repeatedly, or the user disables a rule shortly after creation, mark it as
  possible breakage.
- Repeated possible breakage demotes the rule to observe-only.
- Popup recovery should say which recent adaptive rule is most likely responsible.

## Privacy Boundaries

Adaptive logs must never include request bodies, form values, cookies, local storage, or full URLs.
Only origin/path endpoints, source labels, category counts, reason counts, scores, and timestamps are
allowed.

There is no server-side aggregation plan. Static remains local-first: no backend, no telemetry, no
automatic sharing.
