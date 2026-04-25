# Listless Adaptive Adblocking Plan

## Core Goal

Build a Chrome Manifest V3 adblocking layer for Static that avoids third-party
filter lists. Static should learn ad behavior locally per site, then apply
cosmetic cleanup and narrow local Declarative Net Request (DNR) rules based on
observed evidence.

Use DNR as an enforcement mechanism, but not as a giant EasyList-style rule
engine. The goal is not to ship a huge prebuilt list of ad domains. The goal is
to let each site reveal how it loads, places, auctions, renders, and measures
ads, then store a compact local playbook for that origin.

## Hard Boundaries

- No EasyList, uBlock, or other imported third-party filter lists.
- No backend, telemetry, shared learning, remote model, or automatic uploads.
- No fake clicks, fake impressions, fake views, fake conversions, or synthetic
  ad traffic.
- No request bodies, cookies, local storage, form values, page text, or full
  URLs stored.
- Store only origin-level, redacted, compact evidence in `chrome.storage.local`.
- Active blocking starts opt-in until the confidence model is proven.
- Learned rules are local to the user's browser and must be inspectable and
  removable.

## Product Positioning

Static should not try to out-list traditional blockers under MV3. The product
position should be:

> Static learns each site's ad system locally and blocks the behavior that site
> actually uses.

This is different from a conventional list-based blocker. It should be strongest
against first-party ad proxies, rotating ad paths, self-hosted ad loaders, and
ad stacks that evade static domain lists.

## Proposed New Modules

Add these files when implementation starts:

- `block_ads.js`: MAIN-world ad behavior observer and API shims.
- `ad_cosmetic.js`: ISOLATED-world DOM cleanup and hiding engine.
- `ad_signals.js`: shared constants, reason tokens, scoring thresholds, and
  confidence labels.
- `ad_playbooks.js` or service-worker utilities: storage normalization, caps,
  promotion/demotion logic, and DNR rule generation helpers.
- `tests/ad-*.spec.js`: Playwright coverage for observe-only signals, scoring,
  cosmetic cleanup, recovery, and DNR rule generation.

Register `block_ads.js` in the MAIN-world content script list early enough to
observe ad APIs before page ad scripts use them, likely near `block_adaptive.js`.
Register `ad_cosmetic.js` in the ISOLATED-world content script list after
`lists.js` and `bridge.js`.

## Storage Keys

Use local-only storage.

- `ad_log`: per-origin observed ad behavior summaries.
- `ad_playbooks`: per-origin learned selectors, structural fingerprints, script
  labels, endpoint path patterns, and confidence.
- `ad_prefs`: global mode and per-site overrides.
- `ad_session_state`: optional in-memory service-worker state for current-tab
  active actions.

Suggested `ad_log[origin]` shape:

```js
{
  total: 42,
  score: 87,
  reasons: {
    "gpt.slot": 4,
    "ad_iframe.300x250": 6
  },
  sources: {
    "script:https://example.com/static/[hash].js": 3
  },
  endpoints: {
    "same-origin:/ads/[id]": 5
  },
  lastUpdated: 1710000000000
}
```

Suggested `ad_playbooks[origin]` shape:

```js
{
  version: 1,
  confidence: "learning",
  cosmetic: [
    {
      kind: "selector",
      value: ".ad-slot",
      score: 80,
      hits: 4
    },
    {
      kind: "structure",
      value: "iframe:300x250,parent-sticky",
      score: 90,
      hits: 3
    }
  ],
  network: [
    {
      path: "/ads/auction",
      resourceTypes: ["xmlhttprequest"],
      score: 92,
      hits: 5
    }
  ],
  disabled: false,
  lastUpdated: 1710000000000
}
```

Valid confidence labels:

- `learning`: not enough evidence to act.
- `likely`: repeated medium evidence, useful for diagnostics.
- `high`: correlated evidence strong enough for opt-in cosmetic action.

## Stage 1: Observe-Only Ad Behavior Logging

Implement `block_ads.js` to detect behavior, not domains.

Initial signals:

- `gpt.slot`: Google Publisher Tags usage such as `googletag.defineSlot`,
  `defineOutOfPageSlot`, and `pubads`.
- `prebid.auction`: Prebid usage such as `pbjs.requestBids` and bidder events.
- `amazon_tam.auction`: Amazon TAM usage such as `apstag.fetchBids`.
- `video_ad`: IMA, VAST, or VMAP style script/API markers.
- `omid.measurement`: OMID/session measurement markers.
- `ad_iframe.size`: ad-sized iframes such as `300x250`, `728x90`, `320x50`,
  `160x600`, `300x600`, and `970x250`.
- `sticky_ad`: fixed/sticky container with an ad-like child iframe.
- `viewability_ping`: IntersectionObserver or visibility measurement tied to an
  ad-like slot.
- `impression_beacon`: beacon/fetch/image ping after ad-like render.
- `sponsored_dom`: promoted/sponsored/ad-slot naming. This is low confidence by
  itself and must not trigger active blocking alone.

Send compact events through the existing bridge pattern to `service_worker.js`.

Definition of done:

- Signals are recorded locally.
- No blocking or hiding happens.
- Logs are capped and origin-level.
- Stored source and endpoint labels are redacted.
- Tests prove ordinary iframes/widgets do not score high from one weak signal.

## Stage 2: Confidence Scoring

Create a correlated scorer. Single weak signals must not be enough to act.

Scoring rules of thumb:

- Single DOM/string signal: low confidence.
- Ad API plus ad-sized iframe: medium confidence.
- Ad API plus ad-sized iframe plus beacon/viewability signal: high confidence.
- Same-origin endpoint repeatedly involved in a high-confidence chain: eligible
  for a learned network candidate.
- Never promote from one pageview.

Examples:

- `gpt.slot` + `ad_iframe.300x250` + `impression_beacon` = high confidence.
- `prebid.auction` + bidder events + creative iframe = high confidence.
- `300x250 iframe only` = low confidence.
- `sponsored_dom` + outbound tracking redirect + viewability observer =
  medium/high confidence.
- `IntersectionObserver` alone = no ad classification.

Definition of done:

- Reason tokens explain every score.
- Negative fixtures stay below active threshold.
- Scoring is deterministic and testable.
- Thresholds are centralized in `ad_signals.js` or an equivalent shared module.

## Stage 3: Diagnostics UI

Extend the popup and log viewer before active blocking.

Show:

- Current-site "Ad behavior observed" indicator.
- Confidence label: `Learning`, `Likely`, or `High`.
- Top reason tokens.
- Learned cosmetic entries.
- Learned endpoint entries.
- Controls to disable ad cleanup for this site.
- Control to clear learned ad data for this site.

Definition of done:

- User can inspect why Static thinks something is ad behavior.
- Clearing site data removes learned playbook entries and session rules.
- UI language stays probabilistic. Avoid saying that a site is "malicious" or
  definitely "evading" Static.

## Stage 4: Per-Origin Ad Playbooks

Convert repeated observations into `ad_playbooks`.

Learn:

- Stable ad container selectors.
- Structural fingerprints when selectors are unstable.
- Script source labels, redacted.
- Same-origin paths that behave like auction, creative, or beacon endpoints.
- Whether cosmetic hiding appears safe.

Selector learning should be conservative. Prefer structural fingerprints when a
selector is too broad, unstable, or likely to match real content.

Definition of done:

- Playbook updates are capped and versioned.
- Entries decay or demote if not seen recently.
- User/site disable prevents new active actions.
- Broad selectors are rejected or kept diagnostics-only.

## Stage 5: Opt-In Cosmetic Cleanup

Implement first active behavior in `ad_cosmetic.js`.

Actions:

- Hide or collapse high-confidence learned ad containers.
- Remove sticky ad overlays only when confidence is high.
- Collapse empty ad iframes.
- Preserve layout when collapse would cause bad page jumps.
- Mark hidden nodes with internal dataset/class names.
- Restore immediately when disabled.

Recommended modes:

- `off`: observe only.
- `diagnostic`: show evidence in UI but do not hide.
- `cosmetic`: hide/collapse high-confidence learned slots.

Definition of done:

- Cosmetic mode is toggleable globally and per-site.
- Hidden elements can be restored without reload where possible.
- Tests cover false positives: comments, product cards, embedded videos,
  dashboards, sticky navigation, cookie banners, and recommendation widgets.

## Stage 6: Same-Session Fast Learning

After high-confidence detection on one page, act earlier on later navigations in
the same origin/session.

Example flow:

1. Page loads an ad stack.
2. Static observes loader -> slot -> iframe -> beacon.
3. Static hides the slot.
4. Static remembers the slot pattern.
5. On navigation within the same site, Static hides earlier.

Definition of done:

- First page may observe; second page on the same origin cleans faster.
- No persistent network rules yet.
- Session state clears on browser restart.
- Per-site disable clears or ignores same-session learned actions.

## Stage 7: Session DNR Quarantine

Generate narrow temporary DNR rules only for high-confidence learned endpoints.

Rules must be:

- Created with `chrome.declarativeNetRequest.updateSessionRules`.
- Initiator-scoped to the observed origin.
- Path-specific, not broad regex.
- Resource-type scoped.
- LRU-capped.
- Removed when user disables site protection.
- Cleared naturally on browser restart.

Good candidates:

- Repeated same-origin auction endpoints.
- Repeated same-origin creative endpoints.
- Repeated same-origin impression/viewability beacons.

Bad candidates:

- Broad host-wide blocks.
- One-off paths.
- Login, checkout, account, API, GraphQL, or search-looking paths unless there is
  overwhelming evidence and a narrow safe rule shape.

Definition of done:

- Same-origin ad proxy endpoints can be blocked after repeated evidence.
- Rules disappear after browser restart.
- Popup/log viewer shows recent learned network blocks.
- Disable/clear site removes relevant session rules.

## Stage 8: Persistent Local Promotion

Only later, promote some rules to dynamic DNR.

Promotion requirements:

- High confidence across sessions.
- Repeated same origin/path behavior.
- No recent user disable.
- No detected breakage.
- Narrow safe rule shape.
- Cosmetic cleanup alone is insufficient.

Definition of done:

- Dynamic rules are local, inspectable, and removable.
- There is a cap and eviction policy.
- Disable/clear site removes promoted rules.
- Promotion is conservative and documented in the diagnostics UI.

## Recovery And Controls

A listless blocker needs excellent recovery because false positives are visible.

Add controls for:

- Pause Static on this site.
- Disable ad cleanup only.
- Disable learned network rules only.
- Clear learned playbook for this site.
- Show last hidden elements.
- Show last blocked learned requests.
- Restore hidden elements without reload where possible.

The user must be able to recover from a bad learned action quickly.

## Testing And Calibration

Positive fixtures:

- GPT slot and creative render flow.
- Prebid auction flow.
- Amazon TAM flow.
- IMA/VAST/VMAP video ad flow.
- OMID/viewability measurement.
- First-party proxied ad loader.
- Sticky ad overlay.
- Impression beacon after slot render.

Negative fixtures:

- Embedded videos.
- Product recommendation carousels.
- Comment widgets.
- Analytics-only scripts.
- Dashboards with iframes.
- Sticky navigation.
- Cookie banners.
- Legitimate `IntersectionObserver` usage.
- Legitimate 300x250 media/content cards.

Regression requirements:

- Weak signals alone do not hide content.
- Clearing site data removes learned actions.
- Per-site disable restores hidden elements and removes session rules.
- Cosmetic cleanup does not hide normal content in negative fixtures.
- Session DNR rules are scoped to the learned origin and resource types.

## Recommended MVP Order

Build in this exact order:

1. `block_ads.js` observe-only signals.
2. Service-worker storage and scoring.
3. Popup/log viewer diagnostics.
4. Per-origin playbook storage.
5. Opt-in cosmetic cleanup.
6. Same-session fast learning.
7. Session DNR quarantine.
8. Persistent local promotion.

The key implementation principle is that Static should not try to know every ad
server ahead of time. It should watch how each site constructs ads, learn that
site's local playbook, and only then act with reversible, narrowly scoped
defenses.
