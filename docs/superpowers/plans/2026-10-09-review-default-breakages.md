# Review Follow-ups: Default-Settings Breakages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the page-breakage and probe-bypass bugs found in the 2026-10-09 review of the always-loaded page scripts. All of them hit at default settings.

**Architecture:** The bugs share three root causes: page scripts read values differently from the browser (URLs, CSS escapes, TrustedHTML/null), wrappers act on whole units when only part matches (`<style>` text, MutationObserver records), and two leftover normalizations drop meaning (legacy iframe attributes, symbol keys). Each task fixes one root cause where every caller routes through it, which is a shared `block_utils.js` helper wherever one exists.

**Tech Stack:** MV3 MAIN-world content scripts (plain JS), Playwright E2E with the unpacked extension.

**Spec:** the user's go-ahead on 2026-10-09 to fix the "bugs found but not fixed" listed in the PR #13 handoff; evidence is in that handoff.

## Global Constraints

- Default settings must behave like the native browser for non-extension input; only extension-scheme URLs may be changed or blocked.
- Page-visible wrappers keep native `name` / `length` / `toString` (use `U.wrapMethod` / `U.wrapGetter` / `U.wrapSetter`).
- Pause (`disabled`) keeps passing through unchanged.
- `npm run format:check`, `npm run lint:strict` (0 warnings), static tests, and the Chromium E2E suite (`tests/e2e-specs.txt`) stay green.

## Review Focus

- A page that never touches extension URLs must see byte-identical values reach native setters (TrustedHTML objects, `null`, strings).
- A `<style>` or rule that mentions an extension URL keeps every other rule.
- Detection must match what Chrome's URL and CSS parsers resolve (tabs/newlines, C0 controls, CSS escapes), without new false positives on ordinary URLs.
- Page MutationObservers keep every record about page-owned nodes.
- Trusted Types pages enforce their own policy: Static no longer turns plain strings into TrustedHTML.

---

### Task 1: URL strings are read the way the URL parser reads them

**Files:** Modify `block_utils.js` (`U.normalizeUrlString`, `U.getUrl`, `U.firstBadUrlIn`, new `U.hasBadUrl`), `block_element_decoys.js` (markup and srcset pre-checks). Test: `tests/extension-behavior.spec.js`.

- [ ] Failing test: probes written as `"chr\tome-extension://…"`, `"\u0001chrome-extension://…"`, `"chrome-exten\nsion://…"` (img.src, setAttribute, innerHTML markup) and `{ url: "", toString: () => probe }` are each recorded in `probe_log` for the origin.
- [ ] Implement: `normalizeUrlString` removes ASCII tab/LF/CR anywhere and strips leading/trailing U+0000–U+0020 (URL parser), not `trim()`. `getUrl` reads `.url` only from real `Request` objects (brand-checked with the native `Request.prototype.url` getter, so it works across realms) and stringifies everything else like the browser does. `firstBadUrlIn` and the new `hasBadUrl` search tab/newline-stripped text. The element-decoys markup pre-checks use `U.hasBadUrl`.
- [ ] Run the new test (pass) and the existing probe tests.
- [ ] Commit `fix: read probe URLs the way the URL parser does`.

### Task 2: CSS escapes are decoded and only offending URL tokens are neutralized

**Files:** Modify `block_utils.js` (new `U.sanitizeCssText(text) → { text, url }`), `block_style_vectors.js` (all `<style>` text paths and declaration detection), `block_vectors.js` (`patchCssMethod`). Test: `tests/extension-behavior.spec.js`.

- [ ] Failing tests: a `<style>` with `a[href^="chrome-extension://x"]{color:red} body{margin-left:7px}` keeps `margin-left: 7px`. A `<style>` with `@import url("chrome\-extension://ID/x.css")` plus a legitimate rule has its import neutralized (not an extension href), keeps the rule, and records the probe. `sheet.insertRule` and `style.setProperty` with an escaped extension URL are neutralized and recorded.
- [ ] Implement `U.sanitizeCssText`: scan the text, skipping comments and escapes outside tokens, and decode string and `url(` tokens (including escaped function names) per CSS Syntax §4.3.7. Replace each token whose decoded value `U.isBad` with an inert `"about:invalid"` / `url(about:invalid)`, keep every other byte, and return the first bad URL. Use it in `<style>` text paths instead of clearing the element, for declaration detection (`sanitizeStyleDeclarationValue`, `setProperty`), and in CSSOM `insertRule` / `replace` / `replaceSync` / `addRule` (call the original with sanitized text).
- [ ] Run the new tests and the existing CSSOM/style tests (`per-site disable stops blocking active vectors and CSSOM probes`).
- [ ] Commit `fix: neutralize only the extension URLs in CSS, including escaped ones`.

### Task 3: HTML sinks keep TrustedHTML and null semantics and stop laundering strings

**Files:** Modify `block_utils.js` (move the HTML policy here as `U.trustedHtml(html)`; add `U.htmlSinkText(value, nullIsEmpty)` and `U.htmlSinkValue(value, text, next)`), `block_iframe_attrs.js` (sinks, drop `canPatchHtmlSinks`), `block_element_decoys.js` (`patchHtmlSetters`, `insertAdjacentHTML`), `block_style_vectors.js` (internal template parse uses `U.trustedHtml`). Tests: `tests/extension-behavior.spec.js`, `tests/compat-regression.spec.js`.

- [ ] Failing tests: on a page whose CSP header is `require-trusted-types-for 'script'; trusted-types app`, assigning `app.createHTML(...)` to `innerHTML`, `outerHTML`, `ShadowRoot.innerHTML` and `insertAdjacentHTML` works. On a plain page, `innerHTML = null` empties the element. On the meta-CSP Trusted Types fixture, a plain string assignment throws `TypeError` like native, while the page's TrustedHTML works and iframe markup inside it is still normalized.
- [ ] Implement: each wrapper reads markup with `U.htmlSinkText` (TrustedHTML through the native stringifier captured at init; `null` as `""` for `[LegacyNullToEmptyString]` sinks; template-literal conversion otherwise, which throws for symbols like native). It then passes `U.htmlSinkValue`: the original value when nothing changed. When something changed, a TrustedHTML input is re-created with Static's policy, or kept as-is if no policy can exist; strings stay strings and other objects become the string we checked (no second `toString`).
- [ ] Update the existing Trusted Types test and the compat `null -> null` expectation to native behavior.
- [ ] Commit `fix: keep TrustedHTML and null semantics in HTML sinks`.

### Task 4: Legacy iframe permission attributes keep their effect

**Files:** Modify `block_iframe_attrs.js` (`normalizeIframeAttr`, `removeLegacyAllowAttrs`, `sanitizeIframeTag`, `allowFullscreen` / `allowPaymentRequest` setters), `README.md` (item 8 wording). Test: `tests/extension-behavior.spec.js`.

- [ ] Failing test: cross-origin child iframes created through `setAttribute`, properties and `innerHTML` with YouTube's embed attributes (`allow` without `fullscreen`, plus `allowfullscreen`) report `document.fullscreenEnabled === true`.
- [ ] Implement: drop a legacy attribute only when it has no effect, that is when `allow` already declares its feature (`fullscreen` / `payment`) or the browser does not support that feature. Otherwise keep it, so the browser applies `fullscreen *`.
- [ ] Re-run `normalizes iframe sandbox and legacy permission attributes without console noise` (its `allow` declares both features, so it stays green).
- [ ] Commit `fix: keep allowfullscreen when allow does not grant fullscreen`.

### Task 5: MutationObserver filter only hides extension elements

**Files:** Modify `block_element_decoys.js` (`isDomMarkerElement` / `shouldHideMutationRecord`). Test: `tests/extension-behavior.spec.js`.

- [ ] Failing tests on a detached root, which the scrubber never touches: appending `<textarea data-gramm="false">` is reported to the page observer and to `takeRecords()`. `replaceChildren(p, input[data-1p-ignore], p)` is reported.
- [ ] Implement: a `childList` record is hidden only when every added and removed node is an extension element by tag or class. Marker attributes alone no longer hide insertions; attribute records for marker names stay hidden.
- [ ] Re-run the three existing marker tests (they use tag and class markers).
- [ ] Commit `fix: stop hiding page-owned nodes from MutationObservers`.

### Task 6: `Object.assign(window, …)` keeps symbol-keyed properties

**Files:** Modify `block_globals.js` (`patchObjectAssign`). Test: `tests/globals-stealth.spec.js`.

- [ ] Failing test: `Object.assign(window, { [sym]: 1 })` sets `window[sym]`, and a protected key in the same source is still stripped.
- [ ] Implement: pass sources through untouched unless they hold a protected key. Otherwise copy their own enumerable keys (`Reflect.ownKeys`, strings and symbols) minus protected ones.
- [ ] Commit `fix: keep symbol keys in Object.assign onto window`.

### Task 7: Docs, verification, PR

- [ ] CHANGELOG `[Unreleased] → Fixed` entries, added at the top of the list (PR #13 appends at the end).
- [ ] `./gate.sh --fast` (with zip shims), full Chromium E2E, independent A/B re-checks from the review.
- [ ] Push `fix/review-default-breakages`, open a PR, wait for CI.
