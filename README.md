<p align="center">
  <img src="icons/icon-128.png" alt="Static" width="128" height="128">
</p>

<h1 align="center">Static</h1>

<p align="center">
  <strong>Anti-fingerprinting Chrome and Firefox extension that blocks extension enumeration and extension-derived browser fingerprints. Per-site by default: it observes, recommends, and masks only the sites you choose. Optionally poisons probe logs with plausible decoys.</strong>
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/static/lljfncchalimoimbencbbblpdbhmeiil"><img src="https://img.shields.io/chrome-web-store/v/lljfncchalimoimbencbbblpdbhmeiil?label=Chrome%20Web%20Store&color=blue&logo=googlechrome&logoColor=white" alt="Chrome Web Store"></a>
  <a href="https://addons.mozilla.org/en-US/firefox/addon/privacystatic/"><img src="https://img.shields.io/amo/v/privacystatic?label=Firefox%20Add-ons&color=orange&logo=firefoxbrowser&logoColor=white" alt="Firefox Add-ons"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/G-man3207/Static?color=blue" alt="MIT License"></a>
  <a href="PRIVACY.md"><img src="https://img.shields.io/badge/Privacy%20Policy-Read%20here-blue" alt="Privacy Policy"></a>
  <img src="https://img.shields.io/badge/manifest-v3-brightgreen" alt="Manifest V3">
  <img src="https://img.shields.io/github/v/release/G-man3207/Static" alt="Latest release">
  <img src="https://img.shields.io/badge/tests-Playwright-45ba4b" alt="Playwright tests">
</p>

---

## What it does (10-second version)

Websites probe your browser to figure out **which extensions you have installed** and use those signals in browser fingerprints. Static watches those probes, tells you what a page was actually doing, recommends whether masking is worth it there, and — by default — masks a site **only after you choose it**. The old mask-everywhere behavior is one click away as the **Every site** mode. Privacy details: [PRIVACY.md](PRIVACY.md).

Static is intentionally narrow. It is built to run alongside uBlock Origin or Privacy Badger, which are better suited for broad ad-tech, analytics, and third-party tracker blocking. Everything it does is local: no backend, no telemetry, no new network requests.

> On LinkedIn, Static counts ~4,500 extension-enumeration probes per page load while the site is unprotected, then blocks them once you protect it. The popup shows whichever number applies to the page in front of you.

The per-site mode, the scout, its evidence, and the recommendation scoring are documented in [docs/site-protection.md](docs/site-protection.md).

## Permissions

Static asks for these permissions in `manifest.json`:

- **`declarativeNetRequest`** — needed to load the narrow fingerprinting/CAPTCHA vendor rulesets under `rules/`. In per-site mode the enabled lists are re-derived as dynamic rules scoped to protected sites; the static rulesets are off.
- **`declarativeNetRequestWithHostAccess`** — needed for Dynamic Declarative Net Request rules that rewrite outgoing `User-Agent` and `Sec-CH-UA*` headers on protected sites, and for the site-scoped vendor copies. Static does not use this to broadly block or redirect traffic; it is scoped to the header and vendor-list paths.
- **`scripting`** — the service worker registers Static's content scripts itself instead of declaring them in the manifest. That is what lets per-site mode run the full masking stack on protected sites and only the scout on the rest, and what makes paused sites get none of Static's page code in Every site mode. It adds no install warning.
- **`storage`** — local settings, probe logs, playbook summaries, protection mode, site decisions, and scout evidence. Nothing leaves the device unless you explicitly export it.
- **`host_permissions: *://*/*`** — required so content scripts can run on all sites and observe or block extension-enumeration probes. Host access is also used by the narrow DNR rulesets so they can match requests to the listed fingerprinting/CAPTCHA domains.

No permission was added or widened in 2.8. You can inspect every ruleset in `rules/` and toggle the fingerprinting/CAPTCHA ones from the popup or `manifest.json`.

## Install

### Chrome / Chromium

**From source:**

1. Clone this repository
2. Open `chrome://extensions`
3. Toggle **Developer mode** (top-right)
4. Click **Load unpacked** and select the repo folder

**From the [Chrome Web Store](https://chromewebstore.google.com/detail/static/lljfncchalimoimbencbbblpdbhmeiil):** install Static directly with one click.

### Firefox

**From [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/privacystatic/):** install Static directly with one click.

**From source (temporary load):**

1. Clone this repository
2. Build a Firefox package: `npm run build:firefox` (writes a zip after stripping DNR types Firefox does not support and adding the event-page background scripts)
3. Open `about:debugging#/runtime/this-firefox`
4. Click **Load Temporary Add-on…** and select any file inside the extracted package folder (or the built zip after extracting)

Temporary add-ons unload when Firefox restarts. Prefer the [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/privacystatic/) listing for a permanent install.

Chrome needs version 119 or later, for service-worker-registered MAIN-world content scripts that also cover `about:blank` and `srcdoc` frames.

Firefox needs MAIN-world content scripts (128+) and built-in data-collection consent keys (140+). The package declares `strict_min_version: 140.0` and states that Static collects no remote data (`data_collection_permissions.required: ["none"]`). The per-site mode, scout, recommendation engine, and scoped network rules are the same on both browsers; Firefox runs the background logic as an event page instead of a service worker.

On a fresh install (or after updating from 2.7) the popup explains the new default with a one-time
card. Nothing is masked until you decide a site; **Protect every site instead** switches back to the
old always-on behavior.

---

## Protection modes (default: per-site)

Static 2.8 starts in **Only sites I choose**. A site you have not decided about gets an
observe-only scout, not the masking stack: nothing is blocked, rewritten, or poisoned, and the
popup tells you what the page was doing and what Static recommends. Press **Protect this site** and
the full stack applies to that site from the next load on. The old always-on behavior is **Every site**,
one click away in the same popup.

This is the default because the masking stack is itself a compatibility risk. PayPal, Discord, and
similar sites do not probe for extensions to be hostile: they run bot checks, user-agent sniffing,
and extension checks during sign-in and checkout, and a masked page can trip them. Per-site masking
keeps the cover where it buys something and keeps Static out of the way where it does not.

The full behavior and architecture contract is in [docs/site-protection.md](docs/site-protection.md).

### The scout

In per-site mode every page, in every frame, at `document_start`, loads a small observe-only
**scout** after the shared utilities and the fixed `signals.js` catalog. It wraps the same API
surfaces the blocker does but passes every call through to the native implementation unchanged:
`this`, arguments, return values, thrown values, promise identity, property descriptors, and a
function's `name` / `length` / `toString`. Nothing is blocked and nothing is rewritten. It records
five categories of evidence:

- **Extension probes.** Which `chrome-extension://` (or `moz-extension://`, `ms-browser-extension://`,
  …) URLs the page tried, through which vector: `fetch`, XHR, image, script, stylesheet, iframe,
  worker, beacon, `EventSource`, CSSOM, markup sinks, and the rest. Stored as an extension ID, a
  canonical vector name, and a coarse path kind (`manifest`, `image`, `script`, …). The raw URL is
  not kept.
- **Fingerprint vendors.** Resource URLs and vendor globals matching the local catalog:
  FingerprintJS, DataDome, PerimeterX/HUMAN, Sift, Forter, ThreatMetrix, Iovation, Kasada, Sardine,
  Shape, and dozens more, plus bot-management and CAPTCHA vendors such as Cloudflare Turnstile,
  Arkose, hCaptcha, reCAPTCHA, Friendly Captcha, and Altcha. Detection only; the network lists still
  do the blocking.
- **Device readbacks.** Counted pass-through reads of high-entropy surfaces: canvas `toDataURL` /
  `toBlob` / `getImageData` / `measureText`, WebGL `getParameter(UNMASKED_*)`, `OfflineAudioContext`,
  `document.fonts`, `hardwareConcurrency`, `deviceMemory`, languages and plugins,
  `userAgentData.getHighEntropyValues`, `Intl.DateTimeFormat().resolvedOptions()`,
  `storage.estimate()`, `RTCPeerConnection`, `mediaDevices.enumerateDevices()`, battery, permissions,
  screen geometry, and connection type.
- **Replay SDKs.** Script/source URLs, vendor hosts, and the SDK globals for LogRocket, FullStory,
  Hotjar, Smartlook, Mouseflow, Clarity, OpenReplay, Sentry Replay, Datadog RUM, PostHog, rrweb, and
  the rest of the catalog. Detection only; Replay poisoning remains opt-in.
- **Auth, checkout, and bot-check signals.** Password, email, and card fields; sign-in, login,
  checkout, OAuth, and payment paths; WebAuthn and `PaymentRequest`; Trusted Types; embedded
  cross-origin frames; CAPTCHA markup and bot-check/CAPTCHA frames and scripts (Cloudflare Turnstile,
  Arkose, hCaptcha, reCAPTCHA, DataDome, PerimeterX, Kasada); and how often the page reads your user
  agent.

Evidence is a small local record of **behavior, not content**: counts, fixed catalog keys, extension
IDs, coarse path kinds, and timestamps. It never contains the page URL, path, title, text, form
values, cookies, or storage values. The only page strings the scout reads are the attribute or URL
it is already classifying, the text of a `<style>`/`<script>` element it is scanning for such a
URL, `input` `type` / `autocomplete` / `name` / `id` to classify a field, and the current path to
classify a flow; none of them are stored. The privacy details are below
([Privacy of the scout](#privacy-of-the-scout)) and in [PRIVACY.md](PRIVACY.md).

### How the recommendation works

The recommendation is a local heuristic over that site's evidence, not a classifier and not a
verdict on whether the page is trustworthy. It builds two scores:

- **Benefit** — what masking would actually hide: extension probes (volume, distinct IDs, distinct
  vectors), fingerprint vendors, device readbacks, replay SDKs, CAPTCHA vendors. A row counts in
  full only while its defence is on; with Device signal poisoning off, a canvas read counts at a
  quarter and is listed as a note, not a benefit.
- **Risk** — what masking is more likely to break: password / email / card fields, sign-in and
  checkout paths, bot checks and CAPTCHAs, WebAuthn, OAuth redirects, Trusted Types, embedded
  sign-in frames, heavy user-agent reads, bot and payment vendor kinds, a site you paused before,
  and a fresh compatibility warning from that origin.

The pair maps to one of six headlines:

| Verdict   | Confidence    | Headline                            | Suggested button  |
| --------- | ------------- | ----------------------------------- | ----------------- |
| `protect` | high          | We suggest masking here             | Protect this site |
| `protect` | medium        | Masking here is worth it            | Protect this site |
| `protect` | low           | Masking here is probably worth it   | Protect this site |
| `skip`    | high          | We suggest leaving masking off here | Leave it off      |
| `skip`    | medium or low | Masking might get in the way here   | Leave it off      |
| `neutral` | any           | No strong signal here               | Your call         |

The card shows up to three reasons per side, strongest first, plus a short summary. When the
verdict is `protect` but risk is high enough (≥20), it adds a caution: **If sign-in misbehaves, leave
this site off.** A site you paused before, or whose origin has already produced a compatibility
warning, leans toward `skip`; a fresh warning overrides everything and puts that warning first.
Nothing leaves the machine — the scout writes local counters, the engine is a handful of pure
functions that run on them, and no cloud service or model is involved.

What the heuristic is aiming for:

- A LinkedIn-like page that checks for ~4,500 extensions across many vectors and loads
  fingerprinting scripts recommends masking.
- A PayPal-like sign-in page with a password form, a sign-in or checkout path, and DataDome bot
  checks recommends leaving masking off — masking is more likely to disturb the flow than to hide
  anything that matters.
- A quiet documentation page with no probes, no fingerprint vendor, and no bot check produces no
  strong signal and no suggested button.

If a defence is off, the card says so instead of claiming the benefit. With Device signal poisoning
off, canvas and WebGL reads become notes ("Reads your canvas image data — device poisoning is off");
with Replay poisoning off, a replay SDK becomes a note; with a network ruleset off, that vendor is a
note. If every defence is off, the verdict cannot be `protect`: it is `neutral` when the page is
otherwise quiet, and `skip` when the sign-in/bot-check risk is high enough to stand on its own.

Evidence older than 30 days is marked stale: confidence drops to low, and an undecided site is shown
as neutral with "Nothing seen here in the last month. A fresh visit will reassess." A decision you
already made is kept; a fresh visit replaces the stale evidence quickly.

The `always` mode has no recommendation to show; there is nothing to decide. It keeps 2.7's pause
toggle instead.

**Advice, not enforcement.** The recommendation never changes anything by itself. Static does not
auto-enable a site the scout likes, and does not auto-disable a site it does not; no setting flips
because of evidence. Only your click on **Protect this site**, **Leave it off**, or the mode row
changes a decision, and a left-off site's badge stays quiet instead of nagging — the evidence lives
in the popup and on the sites page for when you want to revisit it. The "defences off" notes are
about settings you own independently: protecting a site never turns on Device signal poisoning,
Replay poisoning, or a network list, and the card tells you when it sees a signal it is not hiding.

**Honest limits.** The scout is a hint engine, not a second blocker. It can miss an unpatched vector,
a probe issued before `document_start`, or a collector that never touches the APIs it wraps; a
missed hint only means a weaker recommendation, not weaker masking once you opt in. It watches page
loads, not the whole site: a check that only runs on a path you have not visited does not show up
until you visit it, and frame evidence is attributed to the top-level site, so a third-party
sign-in frame's checks look like the page's checks. No recommendation is binding: **Protect this
site** and **Leave it off** are always available, and in the default mode nothing is masked without
your choice.

### The decision card

Open the popup on an undecided site and the top card shows the scout's count, the strongest reasons,
the recommendation, and two buttons: **Protect this site** and **Leave it off**. A third, **Turn it
off here**, appears while the site is protected. Clicking a decision records it, reloads the page,
and closes the popup.

The popup's count changes meaning with the mode. On a protected page it is the number of extension
probes blocked; on an undecided or left-off page it is the number of extension checks seen, in amber
once anything has been counted, and the label says "extension checks seen here" with the line "Static
is watching, not masking, on this site." A page that is still loading shows "Nothing seen here yet"
and the same two buttons, so you can decide immediately. Once you leave a site off, a quiet line
reports new checks seen since your decision ("New checks here: 12 since you turned it off.") without
changing the card or nagging you.

A one-time onboarding card explains the new default: **Static now asks before it masks**. **Got it**
dismisses it; **Protect every site instead** switches to Every site mode. It is shown while per-site
mode has no site decisions and has not been dismissed, so an upgrade sees it too.

The popup also carries the **Page not working?** recovery path. In per-site mode, a protected site
offers **Turn protection off here** (with **Turn protection off here and reload** as the warning
variant if Static's blocking already caused an error); an unprotected site has nothing to recover
from and shows no action. In Every site mode it keeps the old **Pause this site and reload** card.

When the recommendation includes "defences off" notes, the popup lists them under the reasons with
**Review the controls behind this**. It opens **More** and jumps to the relevant control (Device
signal poisoning, Replay poisoning, or the network lists).

### The sites page

The popup footer links to a sites page (formerly the disabled-sites page) that manages decisions and
the mode:

- **Protected sites** — every site you chose, with its protected-since date, what the scout saw, and
  **Turn off**.
- **Left off** — sites you explicitly left alone, with **Protect**.
- **Seen here, no decision** — undecided sites with evidence, most recent first, up to 50, with
  **Protect** and **Leave off**.
- **Paused sites** — shown only in Every site mode; the old paused-origins list with **Enable** and
  **Enable all**.

Search filters every list, the summary line reports how many sites are protected, left off, and
seen, and a caps note explains the retention limits. The mode radios and a muted "Mode changes apply
when pages reload." note sit at the top; a **How this works** block explains the modes, what masking
does, the detection limits, and that decisions cover subdomains and ports.

**Forget undecided sites** drops evidence for sites without a decision. **Clear all decisions**
removes the decisions after an inline two-step confirm; it keeps the evidence, so those sites move
to **Seen here, no decision** until you forget them too or decide again. Both actions also reset the
per-tab observed counters (`tab_seen`), so the badge starts the page count from zero. Every site row also has the
action for its state: **Turn off** (protected), **Protect** (left off or seen), **Leave off**
(seen), and **Enable** (paused in Every site mode). Paused sites also get **Enable all**.

The caps note spells out the retention limits: 250 decisions per state, the 200 most recent sites
with evidence, and 50 seen rows rendered. In Every site mode the page shows the paused origins with
a note that per-site decisions are kept while every site is masked, and **Enable all** puts them all
back at once. Row actions update the list from fresh storage without a page reload, and the page
re-renders when `site_decisions`, `protection_mode`, `site_evidence`, or `disabled_origins` change in
another surface. A decision applies to a page's next load — the popup reloads the tab it was opened
over for you, and a sites-page tab keeps running its current load until you navigate or reload.

### What a decision covers

Decisions are keyed by **site**, not origin: the registrable domain, or the literal host for a bare
host (`localhost`, an IP address) and a single-label host. `https://www.paypal.com/login` belongs to
`paypal.com`. Protecting `example.com` protects `www.example.com`, `api.example.com`,
`http://example.com:8080`, and the bare domain. Ports never enter a decision — `localhost:3000` and
`localhost:8080` are one site.

Multi-tenant suffixes get one extra label of site so tenants do not share a decision:
`alice.github.io` and `bob.github.io` are separate sites. The shipped list is:

`.s3-website.amazonaws.com`, `.s3.amazonaws.com`, `.amplifyapp.com`, `.appspot.com`,
`.azureedge.net`, `.azurewebsites.net`, `.bitbucket.io`, `.blogspot.com`, `.cloudfront.net`,
`.codesandbox.io`, `.deno.dev`, `.firebaseapp.com`, `.fly.dev`, `.gitbook.io`, `.github.io`,
`.githubusercontent.com`, `.gitlab.io`, `.glitch.me`, `.herokuapp.com`, `.neocities.org`,
`.netlify.app`, `.ngrok-free.app`, `.ngrok.io`, `.notion.site`, `.observableusercontent.com`,
`.onrender.com`, `.pages.dev`, `.railway.app`, `.readthedocs.io`, `.repl.co`, `.replit.app`,
`.squarespace.com`, `.stackblitz.io`, `.stores.jp`, `.substack.com`, `.super.site`, `.surge.sh`,
`.trycloudflare.com`, `.tumblr.com`, `.val.town`, `.vercel.app`, `.web.app`, `.weebly.com`,
`.wixsite.com`, `.wordpress.com`, `.workers.dev`

Two-label public suffixes come from a built-in list of **236** common entries (`co.uk`, `com.au`,
`co.jp`, `com.br`, `co.in`, `com.mx`, `com.tr`, `co.za`, `com.cn`, `com.ua`, …), not the full Public
Suffix List; a private or unusual multi-label suffix outside that list may keep sibling subdomains
together. Both lists live in `lists.js` (`siteRules.multiTenantSuffixes`,
`siteRules.secondLevelSuffixes`) and are shared by the service worker and the static tests; the
scout itself does not need them.

Caps: at most **250 protected** and **250 left-off** decisions, and **200 sites** with stored
evidence. The oldest decision of the same state is evicted on insert when a cap is reached; evidence
is evicted by last-seen time. A site with no record is simply undecided — it falls back to the scout
and the real browser.

**Coming from 2.7.** Existing installs update into per-site mode. Site decisions start empty, so
**every site is unmasked until you protect it** — including the sites you had paused. Your paused
origins are kept and still apply while you are in Every site mode; your ruleset toggles were captured
once, so they survive the move. The popup card explains where you are.

### Network and User-Agent defenses are scoped too

The default change is not only about page code. In per-site mode:

- The static fingerprint-vendor and CAPTCHA-vendor rulesets are disabled. The enabled prefs are
  re-derived as **dynamic rules scoped with `initiatorDomains`** to your protected sites, so a list
  applies only to requests a protected site initiates. An unprotected site loads vendor scripts
  normally. Requests initiated by a third-party frame inside a protected page are not matched
  either — the lists are scoped to the protected site's own origin.
- **User-Agent and Client Hints** rewriting is installed per protected site, as request and
  initiator rules, instead of one global rule. An unprotected site sees the real browser, including
  `navigator.userAgent` / `userAgentData` and the matching request headers. A protected site gets a
  stable per-site persona on its own page and in requests it initiates.
- The pause-allow rules that exist in Every site mode are not installed in per-site mode, because
  nothing is blocked globally: a site that is not protected needs no exception.
- If you have protected no sites, the static rulesets stay disabled and no scoped vendor rules
  are written. Switching to Every site restores 2.7 behavior exactly.

Ruleset toggles follow you across modes. In Every site mode a toggle enables or disables the global
list, as before. In per-site mode it chooses whether that list is re-derived for your protected
sites. See [Toggle fingerprint rulesets](#toggle-fingerprint-rulesets).

Mode changes apply on reload: switching in the popup reloads the active tab immediately, switching on
the sites page takes effect the next time each page loads, and other open tabs pick the mode up on
their next navigation. Leaving Every site mode tells already-open full-stack pages to stand down
immediately, before they reload.

### Privacy of the scout

The scout is a local hint store, not a logger. It observes behavior categories and stores only what
it needs to recommend. Per site that is:

- first and last seen times, and a count of top-frame page loads that produced evidence (clamped);
- the number of extension probes, up to 300 distinct extension IDs (the same shape the probe log
  already keeps), up to 24 probe-vector names, and up to 20 coarse extension-resource path kinds;
  probe URLs are reduced to ID + path kind before storage, so the sanitized path is not kept;
- fixed catalog keys and counts for fingerprint vendors (up to 40), device readbacks (up to 30),
  replay SDKs (up to 20), and compatibility signals (up to 24);
- how many times the page read your user agent (clamped).

All of it is capped: **200 sites** of evidence, with the least recently seen evicted first; per-site
map sizes and counters are clamped. It lives in `chrome.storage.local`, is never written to
`chrome.storage.sync`, and is not transmitted anywhere.

It does not store page URLs (beyond the registrable-domain site key that is the storage key), paths,
titles, text, form values, cookies, local storage, request bodies, or individual event timestamps.
Site identity is necessary: a recommendation is about a site, and the sites page has to list it. A
tiny `tab_seen` mirror holds the same counts and observed IDs for up to 30 tabs so the badge and
popup keep their number across a background restart; it is keyed by transient tab id, dropped on
tab close or navigation, and cleared by **Clear log**.

**Clear log** in the popup's log viewer clears the scout evidence along with the probe log and the
per-tab observed counters. The sites page's **Forget undecided sites** action clears evidence for
sites without a decision (and the tab counters); **Clear all decisions** clears the decisions
themselves and the tab counters (their evidence stays and the sites move to **Seen here**).
Uninstalling Static removes all of it.

In per-site mode the raw log export includes the evidence and the site decisions; in Every site mode
the export shape is unchanged. The anonymized research and issue exports keep their old shape, so
scout evidence is not in them. Enabling the scout adds no permission and makes no network request.
The full policy is [PRIVACY.md](PRIVACY.md).

---

## What it blocks

Static's defenses are per site. In the default **Only sites I choose** mode a site gets the stack when you protect it; in **Every site** mode every site gets it except the ones you pause. This section therefore describes what happens **when a site is protected**: the page code on that site, the network lists that site's own requests can hit, and the User-Agent persona that site sees. A page you have not protected keeps its native functions, loads vendor scripts normally, and sees the real browser — the scout only watches it.

1. **Extension enumeration.** On a protected site, pages probe for installed extensions by hitting `chrome-extension://<id>/<resource>` URLs through many vectors: `fetch`, XHR, script/link/img tags, image `srcset`, video `poster`, media/track `src`, `Audio(url)`, object/embed/source, anchor/area/base/form URLs, CSSOM `@import`, style attributes, `sendBeacon`, `Worker`, `SharedWorker`, worklet `addModule`, `EventSource`, and `serviceWorker.register`. Static patches all of these in the page's MAIN world to reject `chrome-extension://` (and `moz-extension://`, `ms-browser-extension://`, `safari-web-extension://`, `edge-extension://`) transparently. Probes on an unprotected page are left alone and reach their URLs normally; the scout counts them.
2. **DOM-marker fingerprinting.** On a protected site, a MutationObserver strips attributes, classes, and custom-element tags that browser extensions leave on the DOM to announce their presence, while MAIN-world observer shims hide transient marker records from page-owned MutationObservers.
3. **`window` global fingerprinting.** On a protected site, devtools bridges and extension-presence markers (`__REACT_DEVTOOLS_GLOBAL_HOOK__`, `__GRAMMARLY_DESKTOP_INTEGRATION__`, etc.) are locked to `undefined` before page scripts run.
4. **Fingerprint network checks (togglable, scoped to protected sites).** Narrow Declarative-Net-Request rulesets block known:
   - **Fingerprinting / anti-bot vendors**: Fingerprint, DataDome, PerimeterX/HUMAN, Sift, Forter, ThreatMetrix/TransUnion, Iovation, Kasada, Sardine, Shape Security/F5.
   - **CAPTCHA / device-check vendors** (off by default, breaks logins): Arkose Labs / FunCAPTCHA, DataDome response pages, and Cloudflare Turnstile / Challenge Platform.

   In **Only sites I choose** mode the two static rulesets are disabled and each enabled list is re-derived as dynamic rules scoped with `initiatorDomains` to your protected sites, so the block applies only to requests a protected site initiates; an unprotected site loads the vendor script normally. In **Every site** mode the lists run globally, as in 2.7. On every protected site, Static also rewrites the JavaScript user agent, platform, and Client Hints, and the matching `User-Agent` and `Sec-CH-UA*` request headers, to a stable per-site persona. That includes the first navigation and requests the page makes to other hosts. In per-site mode those header rules are installed site by site, so an unprotected site sees the real browser. Paused sites (Every site mode) and unprotected sites (per-site mode) are left alone.

5. **Device signal poisoning (opt-in).** On a protected site, Static can return a stable per-site machine persona for the other high-entropy browser signals: CPU/RAM buckets, language, screen and pixel ratio, timezone, WebGL renderer/vendor, canvas readback, offline-audio render output, storage quota, battery, and network hints. User agent, platform, and Client Hints are rewritten on every protected site even when this is off. An unprotected page sees the real machine profile, whatever this setting says.
6. **Self-stealth.** `Function.prototype.toString` is patched with a `WeakMap` that maps wrapped functions to native-looking strings, so the blocker's API overrides — and the scout's observation wrappers — look like real native functions under `toString` checks.
7. **Replay poisoning (opt-in).** When a likely session-replay SDK is detected in page script, Static can proxy only that recorder's event listeners so they see redacted form values and jittered coordinates while ordinary page handlers still receive the real events. The replay script only loads on protected sites; an unprotected page's replay SDK runs untouched (the scout still reports it).
8. **Iframe attribute hardening.** On a protected site, extension probes and fingerprinting scripts can infer browser capabilities from the shape of `<iframe allow>` / `sandbox` / `allowfullscreen` / `allowpaymentrequest>` attributes. Static normalizes these attributes: it drops unsupported `allow` tokens, keeps only valid `sandbox` tokens, drops legacy `allowfullscreen` / `allowpaymentrequest` only where `allow` already sets the same feature, and works on pages with Trusted Types `require-trusted-types-for 'script'` CSP by creating a dedicated policy.
9. **Style / CSSOM vector blocking.** On a protected site, extension URLs can be smuggled into `<style>` text nodes, inline `style` attributes, `CSSStyleSheet.cssText`, `CSSStyleDeclaration.setProperty` / `cssText`, and `insertRule` / `replace` / `replaceSync` / `addRule` calls. Static scrubs these sources before the browser can issue a request, and does it synchronously so the URL cannot be read back.
10. **Site decisions.** Per-site protection is a decision, not a toggle that disappears. You can **Protect this site**, **Leave it off**, or — in Every site mode — **Pause this site and reload**. Decisions are stored in `chrome.storage.local` and can be reviewed or changed on the sites page. A decision covers the whole registrable domain: every subdomain, both schemes, and every port (`localhost:3000` and `localhost:8080` are one site), while multi-tenant suffixes such as `github.io` and `netlify.app` get one extra label so tenants stay separate. **Leave it off** is not the same as pause: it records an explicit "do not mask here", keeps the scout watching for new evidence, and shows fresh checks quietly rather than nagging. In Every site mode the old per-origin pause is still the only site control and works exactly as before; paused origins are kept if you switch back to per-site mode. Caps and details are in [Protection modes](#protection-modes-default-per-site).

The toolbar badge and popup show a live count on the current tab. On a protected page the number is extension-enumeration probes blocked; on an undecided page in per-site mode it is extension checks seen, in amber, and the badge appears once the scout has something to report. A left-off page keeps that observed count in the popup but shows no badge — leaving it off is not a problem to fix. On sites that probe aggressively (LinkedIn runs ~4,500 per page load) the number climbs into the thousands within seconds. The popup's diagnostics also include an **Exposed browser profile** view. On every protected site the user agent and platform rows are the scrubbed per-site persona; the other rows are that persona only when Device signal poisoning is on, and otherwise the real browser profile. An unprotected or paused site shows the real user agent.

## Compatibility warning

Per-site mode is the compatibility fix, so most breakage never happens: a site you have not protected
runs its own sign-in, checkout, and bot checks against the real browser.

When a protected site does break, Static has two layers. First, the recommendation itself can say
that masking is a bad idea: a PayPal-like sign-in page with bot checks gets a **skip** verdict and a
**Leave it off** hint. Second, Static watches a high-confidence breakage signal — a Static-blocked
extension-probe `fetch()` that becomes an unhandled page error. When that happens, the toolbar badge
shows `!` and the popup's recovery card switches to a direct warning.

What the recovery card offers depends on the mode and the site's state:

- **Only sites I choose, protected, with a fresh warning:** **This site may be broken by Static**,
  with **Turn protection off here and reload**. That records an explicit off decision for the site
  and reloads, so Static is out of the way and stays out until you change your mind.
- **Only sites I choose, protected, no warning:** today's **Page not working?** card with **Turn
  protection off here** — the same explicit decision, for when the symptom is not a probe error.
- **Only sites I choose, unprotected:** no recovery card. There is nothing to recover from.
- **Every site:** today's **Page not working?** card with **Pause this site and reload**; once
  paused, the card becomes **Static is paused here** with **Turn protection back on**.

Turning protection off here removes Static's page scripts from that site (and, in per-site mode,
releases its network lists and User-Agent rewrite) on the next load, so even a bot check that looks
for patched browser functions finds none. Static does not auto-disable itself, does not inject an
in-page banner (that would be another fingerprint), and keeps the warning evidence local. A site
with an off decision is listed under **Left off** on the sites page and can be protected again from
there.

## Playbook drift detection

Static keeps a local, weekly summary of how each protected origin probes for extensions: probe vector mix (`fetch`, XHR, element setters, workers, EventSource, etc.), extension-resource path kinds (`manifest`, image, script, HTML, CSS, other), repeated ID dictionary changes, and one-shot ID pressure. An unprotected page in per-site mode is not probed by the masking stack, so it adds no probe-log entries; its probing is scout evidence instead, and the drift indicators begin once you protect the site. Every site mode records on every site you have not paused, as before.

The probe log viewer ranks origins by **Severity** first, then shows a **Probe behavior** indicator per origin:

- **High**: strong adaptive data-collection signals or sharply changed probe behavior.
- **Medium**: changed probe behavior, threshold-level adaptive signals, or broad probing volume.
- **Low**: limited probe activity without stronger drift or adaptive signals.

- **Learning**: not enough baseline data yet.
- **Stable**: no meaningful change from that origin's previous probe behavior.
- **Changed**: the origin changed how it checks for extensions.
- **High drift**: multiple signals shifted at once, such as new probe vectors plus path strategy or ID dictionary changes.

Expanding an origin shows the concrete ranking reasons. Adaptive reason tokens such as `dom_observer`, `listener.keydown`, or `navigator.deviceMemory` include a local explanation of what browser surface was observed. They only appear while Research logging is on. The popup also shows a compact warning when the active site has recent `Changed` or `High drift` behavior.

This is an early-warning system, not attribution. It means "this origin changed how it checks for extensions," not necessarily "this origin adapted to Static."

Power-user diagnostics in the popup and log viewer expose the local evidence behind those labels: current origin, latest weekly probe vector mix, extension-resource path mix, one-shot ID pressure, Noise-mode eligibility thresholds, and the IDs currently eligible for an origin's decoy pool. These views derive only from the existing local probe and adaptive logs; they do not collect or transmit anything new.

QA diagnostics mode is available from the popup for compatibility testing. When enabled, Static keeps a bounded local trace of recent actions on visited sites: blocked probe vectors, coarse extension-resource path kinds, replay detections, and adaptive signal tokens. The log viewer can copy an issue-ready JSON report that hashes site origins, extension IDs, and replay-signal labels with a per-copy salt, so users can attach useful evidence to GitHub issues without publishing raw browsing or extension-label data.

## Adaptive behavior log (observe-only)

Static also has a local-only adaptive behavior logger for future dynamic blocking work. It is **off by default**: turn on **Research logging** in the popup's **More** panel. While it is on, it wraps page timers, promises, and listeners to attribute data collection to its source, which slows script-heavy pages and puts Static's frames in page error stacks, where sites can see them. It takes effect when the page reloads. The logger watches for correlated behavior windows such as canvas/WebGL/audio readback plus navigator reads and network transmission, environment snapshots plus crypto and network transmission, or document-wide mutation observation plus aggressive input hooks.

It also records strong runtime vendor signatures for documented client-side integrations served through first-party or proxied routes. Examples include `window.ddjskey` + `/tags.js` or versioned `/vX.Y.Z/tags.js` routes with the documented `/js/` collector inference, plus explicit `window.ddoptions.endpoint` deployments even when the DataDome tag is served from a custom path. Other signatures: `window._pxAppId` / `window._pxHostUrl` (HUMAN/PerimeterX), `window._sift.push(["_setAccount", ...])` (Sift), and current `window.Fingerprint.start(...)` / legacy `window.FingerprintJS.load(...)` (Fingerprint).

For behavior-only collectors that never expose a stable global, Static also attributes the local adaptive finding to the external script source when possible, while redacting high-entropy path segments and query tokens before storage.

That source attribution propagates across common async boundaries too. If a collector resumes in timers, promise callbacks, microtasks, or mutation-observer callbacks, Static keeps the redacted source label when possible. Otherwise it falls back to a local `runtime:*` label instead of the generic `inline-or-runtime`.

The same local attribution survives event-driven handoffs for message-style flows: listener objects, `postMessage`, custom-event listeners, and `onmessage` handlers. High-frequency replay-sensitive DOM input/mouse event surfaces stay delegated to the replay shim so the two defenses do not fight each other.

This is intentionally **observe-only** today:

- No backend, no telemetry, no automatic sharing.
- No dynamic or session DNR rules are created from these signals yet.
- No request bodies, form values, cookies, local storage, or full URLs are stored.
- Only compact local metadata is recorded: category, score, origin/path endpoint, source label, reasons, counts, and timestamps.

The scout described under [Protection modes](#protection-modes-default-per-site) uses a separate, smaller local store: a capped set of fixed keys and counters that exists to answer "is masking worth it on this site?". This adaptive behavior log is the opposite: opt-in, deeper, and built for future blocking work. The two do not feed each other today — the scout never creates an adaptive signal, and an adaptive finding never changes a recommendation or a site decision. The relationship is documented at the top of [docs/adaptive-blocking.md](docs/adaptive-blocking.md).

The design, cost model, calibration requirements, and future blocking stages are documented in [docs/adaptive-blocking.md](docs/adaptive-blocking.md).

## Noise mode (opt-in)

**Noise mode** learns each site's probe dictionary from its own behavior, then returns plausible decoy responses for a stable subset of those same IDs. The site sees its targets as "installed" and logs them. The logs get poisoned with IDs the site itself cared about.

- **Self-calibrating.** Each site reveals its threat model through what it probes for. LinkedIn probes for scraper extensions; a crypto site probes for wallets. Static builds the decoy persona from that specific site's probe list, so the noise matches what they are looking for.
- **Stable per origin.** Each origin gets a persona of 3 to 8 IDs, deterministic from `hash(user_secret + origin + week)`. The persona stays stable for a week so you don't look like a bot changing extensions every pageview, then rotates. Different users get different sets because the secret is random per install.
- **Conflict-aware.** IDs are bucketed into slots (password manager, ad blocker, grammar, web3 wallet, devtools, translator) and the persona picks at most one per slot. This avoids obvious tells like "three password managers installed."
- **Canary-resistant.** Known plausible extension IDs enter the replay pool only after Static has seen them probed at least twice on that origin. Unknown extension-shaped IDs need stronger repeated evidence before Static will claim them, so cheap two-hit canaries do not become part of Static's own persona.
- **Learned WAR paths.** Sites like LinkedIn do not fetch `manifest.json`; they fetch the specific `web_accessible_resources` file they catalogued for each ID. Static learns those pathnames from the site's own probes and, on later visits, answers only the paths that origin already asked for. A random `*.png` canary on an otherwise eligible ID still fails.
- **Cold start is honest.** First visit to a site produces no poisoning because there's nothing logged yet. From the second pageview onward, the site gets noise.
- **Decoy responses by plausible path.** Static-read `GET` / `HEAD` probes answer for a conservative allowlist of plausible extension resource paths (`manifest.json`, common icon names, common entrypoint-like `content.js` / `page.html` / `style.css`) **and** for WAR paths that origin has already probed at least twice for that persona ID. Suspicious first-visit canaries like random `*.png` or `*.js` names stay blocked.

**Scope in v2.1:** Noise mode decoys `fetch`, `XMLHttpRequest`, and passive element probes for eligible persona IDs. Images, `srcset` candidates, image inputs, video posters, scripts, and stylesheets receive small inert data-URL resources. Page-visible `src` / `srcset` / `href` / `data` / `poster` getters, attribute-node APIs, clones, and HTML/XML serialization still report the original extension URL. Active surfaces with larger behavioral footprints stay fail-closed: frames, navigation-adjacent URLs, form submissions, audio constructors, CSSOM `@import` rules, style text, CSS declaration URLs set through `setProperty` / `cssText`, `iframe`, media streams, track files, `Worker`, `SharedWorker`, worklet `addModule`, `EventSource`, and `serviceWorker.register`. Decoy eligibility is path-aware: allowlisted icon/entrypoint names plus origin-learned WAR paths that have been probed at least twice for that persona ID.

In the default per-site mode, Noise applies only on protected sites. An unprotected page's probes are observed by the scout, not answered with decoys; protect the site to start poisoning its log.

The cross-vector behavior contract is documented in [docs/noise-behavior.md](docs/noise-behavior.md).

**Privacy:** Probe logs are kept locally in `chrome.storage.local`. Capped at 100 origins × 2,000 IDs each × 8 learned WAR paths per ID, with weekly playbook summaries capped to the latest 10 weeks. Nothing leaves your machine unless you explicitly export.

Two export formats and one clipboard report are available in the log viewer (click **View probe log** in the popup):

- **Export raw log**: full detail. Contains per-origin timestamps (`lastUpdated`), exact probe counts, weekly playbook summaries, your since-install cumulative counter, and the precise `exportedAt` moment. This is fine for your own archive but **should not be published**. Timestamp + count patterns can cross-correlate users across sites if multiple raw dumps from different users ever end up in the same hands.
- **Export for research**: anonymized. Replaces precise `exportedAt` with a coarse `"exportMonth": "YYYY-MM"` bucket, drops per-origin `lastUpdated`, drops the `cumulative` counter, coarsens per-ID counts into log-scale buckets (`"2-5"`, `"6-20"`, `"21-100"`, `"101-1000"`, `"1000+"`), drops any ID that was probed fewer than 2 times (canary filter), drops any origin with fewer than 3 surviving IDs (low-signal noise), replaces origin/extension-ID labels with per-export salted hashes, and omits learned WAR pathnames. Safer to publish, but intentionally less useful for cross-user correlation than the raw log.
- **Copy issue report**: anonymized and bounded for GitHub issues. It hashes site origins, extension IDs, and replay-signal labels, omits local timestamps and full site URLs, and keeps the coarse vectors/path kinds needed to debug protection gaps or compatibility reports.

Noise mode is **off by default**. Turning it on is an active choice to shift Static from pure defense to counter-intelligence. Toggle it from the popup.

## Device signal poisoning (opt-in)

BrowserGate documents fingerprint collection beyond extension scans: user-agent and platform strings, CPU and memory buckets, language, screen values, timezone, WebGL, canvas, offline audio, storage, battery, and network hints. Device signal poisoning makes those reads return a plausible persona instead of the real machine profile.

- **Stable per site.** The persona is deterministic from `hash(user_secret + site)`, so a site does not see a different computer every pageview.
- **Different across sites.** Two unrelated sites get different personas, reducing cross-site correlation.
- **Plausible, not random.** Values are internally aligned: the user-agent OS segment matches `navigator.platform`, Client Hints platform, desktop touch profile, screen bucket, and generic WebGL renderer. User agent, platform, and Client Hints are rewritten on every protected site, in JavaScript and on request headers, whether or not this feature is on.
- **Weakening instead of blocking.** Reads still complete, but high-entropy values are decoyed or subtly perturbed so collectors cannot rely on the raw machine profile as confidently.
- **Opt-in.** It is off by default because some sites use these APIs for legitimate compatibility decisions.

Toggle Device signal poisoning from the popup. Turning it on takes effect when the page reloads, since its script only loads while the feature is on; turning it off applies immediately. In per-site mode poisoning applies only to protected sites: an unprotected page can read the real machine profile until you decide.

## Replay poisoning (opt-in)

Replay poisoning is an opt-in behavior-level defense for replay SDKs that still run because they are self-hosted, newly named, first-party proxied, or allowed by the user's tracker blocker. It makes the local recording stream less trustworthy without sending fake traffic to the vendor. Like the rest of the masking stack, it runs only on protected sites: a replay SDK on an unprotected page records normally (the scout reports it, and the recommendation weighs it).

Replay poisoning detects likely replay code from script URLs, known globals, and replay-looking listener sources, then wraps only those listeners:

- **Off**: the replay script is not loaded, so nothing is detected or altered.
- **Mask**: replay listeners see redacted input values (`redacted`, `redacted@example.invalid`, `0`) and generic key/input data. Normal page listeners still see the real value.
- **Noise**: Mask plus small per-event coordinate and rectangle jitter, so pointer paths and element geometry become less stable.
- **Chaos**: Noise plus local decoy click/focus/input/blur events delivered directly to detected replay listeners. These synthetic events are not dispatched through the DOM, so normal page handlers do not receive them.

The feature is scoped to replay listeners rather than the whole page. It does not originate network requests, does not call replay vendor APIs, and does not store form contents. Replay detection signals are stored locally by origin so the popup can show when a site has active replay behavior. The poisoning detector runs only while a replay mode is on (the scout reports replay SDKs independently, on unprotected sites); a new mode takes effect when the page reloads.

Sentry Replay. Static looks for replay-specific Sentry signatures such as `replayIntegration`, `replayCanvasIntegration`, replay sample-rate options, `@sentry/replay`, `rrweb`, and Sentry CDN bundle paths containing `replay`. It intentionally does not block all `*.ingest.sentry.io` traffic because regular Sentry error monitoring and Session Replay share envelope transport URLs.

Datadog Session Replay. Static watches for replay-specific `DD_RUM` init/start signals such as `sessionReplaySampleRate`, legacy `premiumSampleRate` / `replaySampleRate`, and `startSessionReplayRecording()`. This detects self-hosted or first-party Datadog replay without treating every `DD_RUM` install as a replay recorder.

Hotjar. Script/source labels are treated as replay signals so the listener-scoped poisoning path still applies when domain lists cannot identify the vendor.

PostHog. For first-party reverse-proxy and bundled SDK deployments, Static treats replay bundle names such as `lazy-recorder`, `posthog-recorder`, and `recorder-v2`, plus documented `posthog.init(...)` default recording starts and `posthog.startSessionRecording()` calls, as replay signals.

OpenReplay. First-party or bundled deployments are detected through `openreplay` script/source labels and documented `window.OpenReplay.start()` recording starts.

## Toggle fingerprint rulesets

Each narrow fingerprinting network rule category lives in its own file under `rules/`. Toggle them
two ways:

- **From the popup**: click the extension icon. Each ruleset has a checkbox; changes apply live (no
  reload).
- **From `manifest.json`**: each `rule_resources` entry has an `enabled` flag. This controls the
  initial state on a fresh install; after that, user toggles from the popup persist.

```json
"rule_resources": [
  { "id": "fingerprint_vendors", "enabled": true,  "path": "rules/fingerprint_vendors.json" },
  { "id": "captcha_vendors",     "enabled": false, "path": "rules/captcha_vendors.json" }
]
```

The toggles follow you across protection modes, and they mean something slightly different in each:

- **Every site mode.** A toggle enables or disables that ruleset globally, exactly as in 2.7. The
  `manifest.json` default is the starting point; changes apply live.
- **Only sites I choose mode (default).** The two static rulesets are off, so unprotected sites load
  vendor scripts normally. Static re-derives each _enabled_ ruleset as dynamic rules scoped to the
  sites you have protected: the toggle is "apply this list on the sites I chose". Flipping a toggle
  updates the protected sites without a reload; unprotected sites are unaffected either way.
- **Mode switches keep your choices.** The first 2.8 start captures the currently enabled rulesets
  once, and the popup writes the captured preference from then on, so turning a list off in Every
  site mode and switching to per-site (or back) does not silently re-enable it. `manifest.json`'s
  `enabled` flag is only the fresh-install default.

The rule files describe _what_ to block; the preference decides _where_. In per-site mode the static
rulesets are disabled and the scoped dynamic copies are the only network lists — 98 rules across the
two files, well under Chrome's dynamic-rule budget. In Every site mode no scoped copies exist and the
static rulesets are enabled again.

If you turn on `captcha_vendors` while sites are protected, the CAPTCHA list is applied to those
sites as well. The same trade-off as before: sign-in flows that use Cloudflare Turnstile, Arkose, or
DataDome CAPTCHA/device checks can break, so leave it off unless you need it.

Static intentionally does not ship broad ad-tech, analytics, social pixel, or general session-replay
network lists. Use uBlock Origin, Privacy Badger, or both for that layer.

`rules/META.json` is a sidecar index with `version`, `last_verified`, and human-readable descriptions
for each ruleset. Nothing consumes it at runtime. It exists so maintainers and contributors can tell
which blocklists are fresh.

## Test

Static has seven Playwright-backed test layers:

- **Static validation** checks manifest references, DNR rule shape, ruleset metadata, popup ruleset IDs, the two protection modes and their content-script registration shapes, the site-key algorithm (subdomains, ports, IP/IPv6/localhost, IDN, trailing dots, multi-tenant suffixes), the `signals.js` catalog, the recommendation engine's verdict bands/overrides/caps/honesty rule in a Node `vm` harness, and the Firefox build's script list.
- **Extension integration** launches Chromium with the unpacked MV3 extension and verifies content-script, service-worker, DOM scrubber, Noise mode, log clearing, and stealth-wrapper behavior.
- **Scout detection** (`tests/scout.spec.js`) exercises each probe vector, pass-through fidelity (return values, promise identity, property descriptors, `toString`), stealth, cost ceilings, signal dedupe, device/vendor/compat/replay reporting, iframe attribution, and `document_start` behavior.
- **Per-site protection** (`tests/site-decisions.spec.js`, `tests/popup-decisions.spec.js`, `tests/sites-page.spec.js`, `tests/ruleset-scoping.spec.js`) covers modes, decisions, host/site precedence, content-script registrations, badge titles, evidence caps and trimming, upgrade defaults, clear-log behavior, onboarding, the popup decision card states and buttons, the sites page sections/actions/search/mode radios, and `always`-mode regression. `tests/ruleset-scoping.spec.js` is the scoped-DNR layer: a vm pass over the real `rules/*.json` with a mock `chrome.declarativeNetRequest` (rule ids, `initiatorDomains`, priorities, pref capture, mode switches, empty sites, failure/retry, Firefox-stripped types) plus a browser pass that loads the extension and reads back the installed dynamic rules.
- **Adversarial consistency** probes one learned Noise persona across fetch, XHR, passive elements, attributes, active fail-closed vectors, and API descriptors to catch detector-visible contradictions.
- **Compatibility regression** tests real-world web patterns (innerHTML with objects, dynamic DOM mutations, CSS animations, async content loading, postMessage) to detect breakage from extension patches.
- **Real-site smoke tests** navigate to live websites (Google, Facebook, example.com) with the extension loaded and verify pages render visible content without blank screens. These require internet access and auto-skip when offline.

The pre-existing specs keep testing the full masking stack: `tests/helpers/extension.js` seeds
`{ protection_mode: "always" }` after the service worker starts and waits for the content-script
sync, so `launchExtension()` is in Every site mode by default. Specs that need the new default call
`setProtectionMode(extension, "per_site")`; site decisions and evidence have
`setSiteDecision()` / `siteEvidence()` helpers, `tabIdForUrl()` maps a page to its tab, and
`--host-resolver-rules=MAP *.static-fixture.test 127.0.0.1` makes `a.static-fixture.test` resolve to
the local fixture server, so subdomain and site-key behavior runs without DNS. `tests/e2e-specs.txt` stays the single list read by
`package.json` and `gate.sh`, and includes the new specs (see [Layout](#layout)).

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

Run compatibility regression tests (included in `test:e2e`):

```bash
npx playwright test tests/compat-regression.spec.js
```

Run real-site smoke tests (requires internet):

```bash
npm run test:real-sites:xvfb
```

Run the Firefox smoke test:

```bash
npm run test:firefox
```

Run the full CI-style local check on Linux:

```bash
npm run check
```

### Test helpers

- `tests/helpers/real-browser.js` — reusable test helper for navigating to real URLs with the extension loaded and asserting basic page health (visible content ratio, console error capture, element visibility). See the module's JSDoc for the full API.
  - `navigateAndCheckHealth(page, url)` — navigate to a URL and return a health report.
  - `assertPageHasVisibleContent(page)` — assert a page is not blank.
  - `captureConsoleErrors(page)` — capture and assert no console errors.
  - `checkPageHealth(page)` — check health of the current page without navigating.
  - `isOnline()` — check internet connectivity for conditional test skipping.
- `tests/helpers/realistic-fixtures.js` — enriched local fixture pages exercising realistic patterns: autocomplete with async suggestion loading, dashboard with live data feeds, dynamic DOM mutation cycling, and postMessage-based messaging. Spread into the fixture server via `extension-fixture.js`.

## Extend coverage

- **DOM markers to strip**: edit the regex arrays in `lists.js`.
- **`window` globals to strip**: edit the `STRIP_GLOBALS` array in `block_globals.js`.
- **A new scout signal**: add the catalog row to `signals.js` (vendor / device / replay / compat id, label, kind, weight, `domains` and/or `globals`) and the matching reason and summary copy in `site_signals.js`; compat ids also need a `COMPAT_COPY` entry. The static test fails fast on a duplicate id, an invalid kind, a missing compat row, a rule domain with no vendor owner, or a non-data-only catalog.
- **A new site suffix**: add it to `multiTenantSuffixes` or `secondLevelSuffixes` in `lists.js` (`siteRules`); the service worker and static tests share those lists, and the scout does not need them.
- **Fingerprinting endpoints to block at the network layer**: add rules to an existing file under `rules/`, or create a new `rules/<category>.json` and register it in `manifest.json`'s `rule_resources` (and add an entry in `rules/META.json` + `popup.js`'s `RULESET_META`). Avoid general tracker or ad-tech lists; those belong in uBlock Origin / Privacy Badger.
- **A new script-layer probe vector (some new Web API that takes a URL)**: add a wrapper in `block_vectors.js`, following the existing `guardProp` / `patchWorkerCtor` patterns and the shared `U.wrapMethod` / `U.wrapGetter` / `U.wrapSetter` helpers in `block_utils.js`. Fetch/XHR Noise-mode decoys live in `block.js`; passive element decoys live in `block_element_decoys.js`. The scout's corresponding observation lives in `scout_probes.js` — add it there too so the vector is detected on unprotected pages.
- **Style / CSSOM vectors**: add a scrubber in `block_style_vectors.js`, and the observation in `scout_probes.js`.
- **Iframe attribute normalization**: adjust the token allowlists in `block_iframe_attrs.js`.
- **A new content-script file**: list it in `MAIN_WORLD_SCRIPTS`, `ISOLATED_WORLD_SCRIPTS`, `SCOUT_MAIN_SCRIPTS`, or `SCOUT_ISOLATED_SCRIPTS` in `service_worker_utils.js`, not in `manifest.json`. The service worker registers those lists; give a script a `when` condition if it should only load while its feature is on.

## Layout

```text
static/
├── manifest.json
├── lists.js                 # DOM pattern, site suffixes, and Noise persona config
├── signals.js               # fixed vendor / device / replay / compat catalog for the scout
├── site_signals.js          # recommendation engine: scoring, verdict matrix, reason copy
├── site_dnr.js              # site-scoped DNR rules and ruleset preferences
├── block_utils.js           # Shared MAIN/ISOLATED utility helpers
├── block_ua.js              # MAIN-world user-agent, platform, and Client Hints scrubbing
├── block_adaptive.js        # MAIN-world observe-only adaptive behavior logging
├── block.js                 # MAIN-world fetch/XHR blocker + Noise decoys
├── block_vectors.js         # MAIN-world element / worker / beacon / EventSource blockers
├── block_style_vectors.js   # MAIN-world style / CSSOM vector blocking
├── block_iframe_attrs.js    # MAIN-world iframe attribute blocker
├── block_fingerprint.js     # MAIN-world device signal poisoning
├── block_element_decoys.js  # MAIN-world Noise passive element decoys
├── block_replay.js          # MAIN-world Replay poisoning
├── block_globals.js         # MAIN-world extension-global stripping
├── scout.js                 # MAIN-world observe-only scout (per-site mode)
├── scout_probes.js          # scout: extension-probe observation + batching
├── scout_signals.js         # scout: vendor, device, replay, and compat observation
├── dom_scrubber.js          # ISOLATED-world DOM MutationObserver
├── bridge.js                # MessageChannel → service-worker relay
├── service_worker.js        # per-tab badge, storage, and message routing
├── service_worker_utils.js  # service-worker caps, playbook drift, content-script lists
├── popup.html, popup.js     # popup: decision card, count, ruleset toggles
├── sites.html, sites.js     # protected / left-off / seen / paused sites + mode
├── log.html, log.js         # probe log viewer, diagnostics, and exports
├── icons/                   # 16/32/48/128 px icon set + original
├── rules/
│   ├── META.json
│   ├── fingerprint_vendors.json
│   └── captcha_vendors.json
├── docs/
│   ├── site-protection.md   # per-site protection design and behavior contract
│   ├── adaptive-blocking.md # observe-only adaptive logging design (separate)
│   └── noise-behavior.md    # Noise mode cross-vector behavior contract
└── tests/
    ├── static-validation.spec.js
    ├── scout.spec.js
    ├── site-decisions.spec.js
    ├── popup-decisions.spec.js
    ├── sites-page.spec.js
    ├── ruleset-scoping.spec.js
    ├── extension-behavior.spec.js
    ├── compat-regression.spec.js
    ├── ... the rest of the Chromium specs, shared helpers, and fixtures
    └── firefox-smoke.js
```

## Caveats

- **A site you have not protected is not masked.** That is the point of the default, but it is also the cost: until you protect a site (or switch to Every site mode), Static leaves its APIs, vendor scripts, request headers, and User-Agent alone. A page you never decide about can still enumerate your extensions, or fingerprint the rest of the browser. The scout watches and recommends; it does not block. If you want the surface closed everywhere, switch to **Every site**.
- **The recommendation is a hint, not a guarantee.** It is a local heuristic over the scout's best-effort observation. It can miss a probe (an unpatched vector, work before `document_start`, a collector that never touches the wrapped APIs) and it can over- or under-estimate risk on a page type it has not seen. A `protect` verdict is a suggestion, not a claim that the site is hostile; a `skip` verdict is not a claim that it is safe. You can always override it, and masking is deterministic once you choose.
- **The scout is observable too.** In per-site mode it patches several dozen page APIs on every page with the same stealth wrappers as the blocker (native-looking `toString`, preserved descriptors, pass-through behavior). It never blocks, but a determined page can notice that some APIs are wrapped — exactly as it could notice Static in 2.7.
- **The scoped network lists follow the protected site's own requests.** A third-party frame embedded in a protected page is a different initiator, so the fingerprint/CAPTCHA lists do not block that frame's requests in per-site mode. If a bot-check iframe has to load its vendor directly, protect the frame's origin as well (when you can) or use Every site mode.
- **Caps are real.** Static keeps 250 protected decisions, 250 left-off decisions, and evidence for 200 sites. Past that, the oldest decision of the same state, or the least recently seen site, is evicted quietly. The caps exist so a long browsing tail cannot grow local storage without bound and so the popup and sites page stay fast; they are not a promise that a decision made a year ago survives.
- **Mode changes need a reload.** Switching in the popup reloads that tab; switching on the sites page takes effect on each page's next load. Other open tabs pick the new mode up on their next navigation. Leaving Every site mode tells open full-stack pages to stand down immediately, but they do not get the scout until they reload.
- **Update and startup gap.** Browsers drop service-worker-registered content scripts whenever an extension updates. Static registers them again as soon as its service worker starts, and reconciles its scoped DNR and header rules there; a page that loads in that moment, or a tab Chrome restores while applying an update, runs without Static (or with stale network rules) until it reloads. That visit also produces no scout evidence. Reloading the page, or restarting after an update, closes the gap.
- JS-layer patches run only where content scripts run. Pages served from `chrome://`, `about:`, the Chrome Web Store, and a handful of other restricted schemes are not covered, so no scout and no site decision affects them. In Chrome, local `file://` pages are not covered either, because service-worker-registered content scripts only run where Static's `*://*/*` host access reaches. Firefox gets the same modes, scout, recommendation, and scoped rules; the minimum is 140 because of MAIN-world content scripts and data-collection consent keys, and it runs the same background logic as an event page rather than a service worker.
- The DOM scrubber ships with a default list of extensions whose markers are stripped. If one of those is an extension you use, its in-page UI (autofill icons, inline suggestions, etc.) may not render. Remove that extension's patterns from `lists.js` to keep it working.
- Some sites use anti-bot vendors (PerimeterX, DataDome) as part of their login / checkout flow. That is exactly what the recommendation is for: a PayPal- or Discord-like sign-in page with bot checks should come back as **Leave it off**, and if a protected site breaks, use **Turn protection off here and reload** in the popup. In Every site mode the same recovery is **Pause this site and reload**. Either way the site's network lists are released for it. You can also disable `fingerprint_vendors` from **More** if you want the network list off everywhere.
- `captcha_vendors` is disabled by default because Arkose/FunCAPTCHA, DataDome, and Cloudflare Turnstile / Challenge Platform are served as CAPTCHA or device-check flows on some logins and protected forms (X signup, Roblox, some crypto exchanges, Cloudflare-protected forms); enabling it will break sign-in there. In per-site mode the CAPTCHA list also only applies on protected sites, but the trade within those sites is the same.
- Does not cover the entire browser-fingerprinting surface (canvas, WebGL, audio, fonts, font enumeration, WebRTC IP leak, etc.). Complements, doesn't replace, a dedicated anti-fingerprint extension.
- Does not block broad tracker, ad-tech, analytics, or social pixel ecosystems. Complements, doesn't replace, uBlock Origin or Privacy Badger.

## License

MIT. See [LICENSE](LICENSE).
