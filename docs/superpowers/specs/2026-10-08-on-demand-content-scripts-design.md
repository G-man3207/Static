# On-demand content scripts: real pause, load only what's switched on

Date: 2026-10-08
Status: draft for review
Part of: protection levels (Balanced / Strict), spec 1 of 2

## Why

The larger goal: regular users can install Static and not have it get in the way of their work, while hardcore users keep everything Static does today. Spec 2 adds the Balanced and Strict levels. This spec builds the loading mechanism both levels depend on, and fixes two problems that hurt every user today.

1. **Pausing a site does not remove Static from it.** The manifest injects all 13 content scripts into every frame of every site. Pausing only switches the page-world scripts to pass-through once their config arrives asynchronously, so each page load starts with Static fully active, and every patched API stays patched. A site whose bot check reacts to patched APIs keeps reacting after the user pauses it, which makes "Page not working? Pause this site" fail exactly when it is needed.
2. **Switched-off features leave page-visible traces.** Confirmed on released v2.5.1 with default settings (2026-10-08):
   - `RTCPeerConnection()` called without `new` does not throw, because `block_fingerprint.js` installs its patches even while Device signal poisoning is off.
   - An error thrown inside a `setTimeout` callback carries `chrome-extension://<id>/block_adaptive.js` frames in `err.stack`. That identifies Static to the page and to error-reporting SDKs (auth.openai.com runs Datadog RUM), even though the adaptive logger only observes.
3. **Cost.** Static as a whole roughly doubles main-frame script time on heavy sites (GitHub ~580 → ~1430 ms), and the adaptive logger holds the largest measured hotspots. It has not been measured in isolation.

## Decisions already made (2026-10-08)

- Protection levels: new installs get Balanced; Strict is today's Static; existing users stay on Strict and get a one-time popup card. (Spec 2.)
- Observers load only when switched on: a new **Research logging** toggle (off by default, in both levels) loads `block_adaptive.js`, and replay detection runs only while Replay poisoning is not Off.
- A short unprotected window after each extension update is acceptable (see Risks).

## Scope

In scope:

- Manifest changes, registration, and the sync logic in the service worker.
- Loading `block_fingerprint.js`, `block_replay.js` and `block_adaptive.js` only when their feature is on.
- The Research logging setting and its popup toggle.
- The site toggle using the pause-and-reload path, and "applies on reload" notes on feature toggles.
- Tests, the Firefox build, README and CHANGELOG.

Out of scope (spec 2 or later): Balanced/Strict, splitting `fingerprint_vendors`, per-site compatible mode, the first-run page, a shipped compatibility list, challenge-page detection, a breakage crawler, Device signal persona fixes, and other known stealth tells (for example, the bridge's `__perf_*_bi__` events being visible to pages).

## Design

### Manifest

- Remove the `content_scripts` block.
- Add `"scripting"` to `permissions`. It has no install warning in Chrome or Firefox, so updates do not disable the extension.
- Add `"minimum_chrome_version": "119"`. `RegisteredContentScript.matchOriginAsFallback` needs Chrome 119, and `world` needs Chrome 102. Today's manifest `world: "MAIN"` scripts need Chrome 111.
- Firefox needs nothing new. Its `strict_min_version: 140.0` already covers `world: "MAIN"` (128), `matchOriginAsFallback` (128) and `persistAcrossSessions` (105).

### Registrations

The service worker owns exactly two registrations. Both use `matches: ["<all_urls>"]`, `runAt: "document_start"`, `allFrames: true`, `matchOriginAsFallback: true`, `persistAcrossSessions: true`, and `excludeMatches` set to the paused-site patterns.

`a-main`, page world (`world: "MAIN"`). Script order matches today's manifest, minus scripts whose condition is false:

| Script                    | Loaded when                                                                   |
| ------------------------- | ----------------------------------------------------------------------------- |
| `block_utils.js`          | always; must run first (defines `__static_block_utils__`)                     |
| `block_adaptive.js`       | `research_logging === true`                                                   |
| `block.js`                | always                                                                        |
| `block_vectors.js`        | always                                                                        |
| `block_iframe_attrs.js`   | always                                                                        |
| `block_style_vectors.js`  | always                                                                        |
| `block_fingerprint.js`    | `fingerprint_mode === "mask"`                                                 |
| `block_replay.js`         | `replay_mode !== "off"`                                                       |
| `block_element_decoys.js` | always (it also blocks HTML-sink and attribute probes, not only Noise decoys) |
| `block_globals.js`        | always; must run last (deletes `__static_block_utils__`)                      |

Keeping today's relative order keeps wrapper nesting unchanged. For example, `block.js` still wraps on top of `block_adaptive.js`'s `fetch` wrapper when both load.

`b-isolated`, extension world (`world: "ISOLATED"`): `lists.js`, `bridge.js`, `dom_scrubber.js`, unchanged.

There is one registration per world because Chrome only guarantees order inside a single registration's `js` array. Between registrations, Chrome orders by ID within one call and after a browser restart, so the IDs sort the page world first, as today. `bridge.js` already re-dispatches its ports after a tick, which covers either order between the two worlds.

### Sync

`syncContentScripts()` does three things:

1. Reads `disabled_origins`, `fingerprint_mode`, `replay_mode` and `research_logging` (new, default `false`) from `chrome.storage.local`.
2. Builds the two desired registrations.
3. Compares them with `chrome.scripting.getRegisteredContentScripts()`. It registers any that are missing, updates both in one `updateContentScripts` call if either differs, and does nothing if both match.

Rules:

- Always pass `js` and `excludeMatches` explicitly, using an empty list when nothing is paused. `updateContentScripts` leaves fields it is not given unchanged, so omitting `excludeMatches` would keep the last paused site excluded.
- Calls run one at a time on their own promise chain, the same pattern as the existing `serialize()` storage helper, because overlapping register/update calls fail. Queued calls are not merged: each run re-reads storage and does nothing when the registrations already match, so an extra run costs two reads.
- If a call fails, the error goes to `safeLog`, and the next trigger tries again.

Triggers:

- Service-worker start (top level).
- `runtime.onInstalled`. Both browsers delete on-demand registrations on every extension install, update or reload.
- `runtime.onStartup`.
- `storage.onChanged` for any of the four keys.

The `static_set_site_disabled`, `static_set_fingerprint` and `static_set_replay` handlers, and a new `static_set_research_logging` handler, wait for the sync to finish before replying. That way a reload triggered by the popup always picks up the new registrations.

### Paused-site patterns

- Each `disabled_origins` key is parsed with `URL`. Only `http:` and `https:` origins whose hostname contains just letters, digits, dots and hyphens become patterns, and IDNs are already punycode by then. The pattern is `${protocol}//${hostname}/*`, deduplicated.
- The port is dropped because Firefox never matches patterns with ports. Pausing `http://localhost:3000` therefore pauses every port on `localhost`, in both browsers.
- Any other origin is skipped, such as an IPv6 literal or a malformed value. It keeps today's in-page pause: the scripts load but stay pass-through. This matters because one malformed pattern makes the browser reject the whole registration, which would leave every site unprotected.
- `excludeMatches` also covers about:blank, srcdoc, `data:` and `blob:` frames created by a paused site, in both browsers. `data:` frames were not paused before. Third-party iframes are judged by their own URL, same as today.

### Flows

- **Pause and resume.** Both the recovery button and the site toggle send the message, wait for the reply (by then the handler has synced), and reload the site's tab. The recovery button keeps closing the popup, as today. The toggle keeps the popup open and updates its status line. Today the site toggle pushes a live config update and does not reload. That cannot work for a site with no Static code on it, and it would not turn protection back on either. The DNR rules that let a paused site's requests through the vendor lists stay as they are.
- **Feature toggles** (Device signal poisoning, Replay poisoning, Research logging). Turning one on takes effect on the next page load, because its script is not on the open page yet. Turning one off removes its script from the next load. Device signal poisoning and Replay poisoning also stop right away through their existing in-page checks. Research logging keeps recording on the open page until it reloads; adding a live off switch is not worth the code. Each of these toggles gets a short note: "Applies when the page reloads."
- **Research logging toggle.** It lives in the More panel next to QA diagnostics and is off by default. Suggested description: "Records how sites watch the page, for the adaptive signals in the probe log. Off by default: it slows heavy pages and lets sites detect Static."
- **In-page `disabled` checks stay.** They cover a page that is open at the moment it is paused, and origins that cannot become patterns.
- **Paused tabs have no content script.** The popup already reads pause state from storage, and the service worker already falls back to the tab URL (`resolveTabOrigin`), so this needs no change.

### User-visible changes (for the CHANGELOG)

- Pausing a site removes Static from that site completely, once the page reloads.
- The site toggle now reloads the page.
- Adaptive signals only record while Research logging is on, which is off by default. Probe-behavior drift labels are unaffected, because they come from the probe log.
- Replay SDK detection only runs while Replay poisoning is on, so the "Replay SDK detected here" notice no longer appears when it is Off.
- Turning on Device signal poisoning, Replay poisoning or Research logging applies on the next page load.
- `data:` frames created by a paused site are paused too.
- Chrome 119 or later is required, and Chrome no longer covers local `file://` pages. On-demand scripts only run where host permissions reach, and `*://*/*` excludes `file://`.
- After an extension update, pages that load before Static registers again are not protected (see Risks).

## Implementation note (2026-10-08)

`block_adaptive.js` turned out not to be purely observing. Its `MutationObserver` wrapper also hid extension DOM-marker records from page observers, which is part of the DOM-marker defense. That filter now also lives in the always-loaded `block_element_decoys.js` wrapper and covers `takeRecords()` too, so it keeps working with Research logging off. `block_adaptive.js` keeps its identical copy for now, to avoid conflicting with uncommitted work on the same wrapper, and a static test keeps the two regex sets identical.

## Risks

- **Short gap after updates.** Chrome and Firefox delete on-demand registrations on every extension update. Until the service worker syncs again, new page loads get no Static code. The worker starts right away to handle `onInstalled`, so the gap is normally well under a second. If Chrome applies the update during browser startup, restored tabs may load unprotected. In Chrome, already-open tabs keep the page-world code they loaded with. In Firefox, re-registered scripts are not injected into already-open tabs, whereas manifest scripts would be. Manifest scripts have no such gap, but anything declared in the manifest also runs on paused sites, so this is the price of the real pause. Accepted.
- **Registration order.** Chrome moves updated registrations to the end. Updating both in one call and the bridge's re-dispatch cover this.
- **Silent total failure.** If registration fails entirely, no site is protected. Pattern validation removes the known cause, failures are logged and retried, and the static validation test checks that the built script lists only reference shipped files.
- **Firefox startup.** Firefox does not hold tab loads while extensions start, so restored tabs can get `document_start` code late. This is already true of manifest scripts.

## Testing

- **Launch helpers.** Every `--load-extension` launch starts with nothing registered. `tests/helpers/extension.js` and the `extension` fixture wait until both registrations exist before the first navigation.
- **New tests:**
  1. **Real pause.** After pausing a fixture origin and reloading, the page shows no trace of Static's page-world code. Calling `document.body.setAttribute("x", { toString() { throw new Error(); } })` throws an error with no `chrome-extension://` frames. On a protected page the same call shows Static's wrapper frames (verified against v2.5.1), which pass-through mode cannot hide. With Device signal poisoning and Research logging on, `RTCPeerConnection()` still throws and timer-callback errors carry no `chrome-extension://` frames.
  2. **Clean defaults.** With default settings, `RTCPeerConnection()` throws and timer-callback errors carry no `chrome-extension://` frames. Turning Device signal poisoning or Research logging on and reloading loads the script, so the persona applies or adaptive signals record.
  3. **Re-registration.** After `unregisterContentScripts()`, running the startup sync restores both registrations. Settings changes produce the expected `js` lists, with `block_utils.js` first and `block_globals.js` last. Resuming the last paused site clears `excludeMatches`.
  4. **Patterns.** A malformed or IPv6 entry in `disabled_origins` does not stop registration for other sites, and that origin falls back to the in-page pause. Ports are dropped and duplicates removed.
- **Existing tests.**
  - Tests that turn on poisoning or replay without reloading gain a reload step.
  - Tests that rely on adaptive logging turn Research logging on.
  - `static-validation.spec.js` checks the service worker's script lists instead of the manifest's `content_scripts`.
- **Firefox.** `build-firefox.js` drops `minimum_chrome_version`, a Chrome-only key that Firefox warns about. `tests/firefox-smoke.js` needs no change: it installs the add-on, reads the extension UUID from about:debugging and starts its test server before the first page load, which gives the background page seconds to register. It only runs in GitHub Actions, because Firefox is not installed in the dev sandbox.
- **Done when** the full Chromium E2E suite, `npm run lint:strict` and `gate.sh` pass. `gate.sh` includes the Firefox package build and `web-ext lint`.

## Follow-up: spec 2 (protection levels)

- Balanced and Strict. New installs get Balanced; existing users stay on Strict and get a one-time "New: Balanced mode" popup card.
- Split `fingerprint_vendors` into fingerprinting, bot-protection and fraud/payment lists. Balanced blocks only the fingerprinting list.
- Noise, Device signal poisoning and Replay poisoning become Strict-only.
- A stepped "Page not working?" flow: compatible mode, then a real pause, then "it isn't Static".
- A first-run page with the level choice and one recovery tip.

## References

- Chrome scripting API: <https://developer.chrome.com/docs/extensions/reference/api/scripting>
- browser-compat-data, scripting: <https://github.com/mdn/browser-compat-data/blob/main/webextensions/api/scripting.json>
- Chrome permission warnings: <https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings> and <https://developer.chrome.com/docs/extensions/reference/permissions-list>
- Chromium, registrations cleared on install and update: <https://chromium.googlesource.com/chromium/src/+/31277365ee036754c0466b5f10eaacc8023238b1>
- Chromium, navigations held at startup until persisted scripts load: <https://chromium.googlesource.com/chromium/src/+/4b38f6244451a0997cb962dcdd26d5bb61b978d3>
- Firefox: world MAIN <https://bugzil.la/1736575>, matchOriginAsFallback <https://bugzil.la/1853411>, persistAcrossSessions <https://bugzil.la/1751436>, no ports in patterns <https://bugzil.la/1362809>, storage write timing <https://bugzil.la/1783131>
- MDN RegisteredContentScript: <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/RegisteredContentScript>
