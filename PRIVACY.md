# Static — Privacy Policy

**Last updated:** April 18, 2026

Static is a Chrome extension that blocks websites from fingerprinting which browser extensions you have installed, and blocks known client-side fingerprinting / session-replay / anti-bot vendor endpoints at the network layer.

This policy describes exactly what information Static processes on your machine, what it does **not** access, and how any data you choose to export is handled.

## The short version

- Static has **no remote server**. There is no account to create; there is nothing to log into.
- Static **never transmits any data anywhere.** No telemetry, no analytics, no crash reporting, no usage stats.
- Static stores a small local record of which extension IDs each website has probed you for. This record lives only in `chrome.storage.local` on your own machine and can be cleared at any time.
- If you manually export the log through the log viewer, the file is saved to your computer. Static does not send the export anywhere.

## What Static stores locally

Static stores this local state in your browser profile and never writes to `chrome.storage.sync`, so nothing is synced off your device through Chrome's sync service:

1. **Probe log** — a per-origin map of extension IDs that each site has probed you for, with counts. Capped at 100 origins × 2,000 IDs per origin; older entries are evicted beyond that cap.
2. **Since-install probe counter** — the total number of extension-enumeration probes blocked since you installed Static.
3. **User secret** — a random 256-bit value generated once, at install time, via `crypto.getRandomValues`. Used only to seed the per-origin decoy personas for Noise mode so that different Static users produce different decoys on the same site. Never displayed anywhere in the UI, never transmitted.
4. **Preferences** — whether Noise mode is enabled, and which DNR rulesets (LinkedIn telemetry, fingerprinting vendors, CAPTCHA vendors, session replay, Datadog RUM) you have turned on. Noise mode is stored in `chrome.storage.local`; DNR ruleset choices are persisted locally by Chrome's extension ruleset API.
5. **Playbook summaries** — weekly, per-origin aggregates describing how a site probed for extensions: probe vectors (for example `fetch`, XHR, Worker, EventSource), coarse extension-resource path kinds (for example manifest, image, script, HTML, CSS, other), per-week ID counts, and first/last-seen times for the weekly bucket. These summaries power local "probe behavior changed" indicators and are capped to the latest 10 weekly buckets per origin.

You can erase the probe log, playbook summaries, since-install counter, and Noise-mode user secret at any time via the **Clear log** button in Static's log viewer. Ruleset and Noise-mode preferences can be changed in the popup; uninstalling Static removes all extension-managed data.

## What Static does NOT store or access

- Page content, form inputs, passwords, cookies, or local storage of any website.
- Full URLs or your browsing history. The probe log aggregates at the **origin** level (e.g. `https://www.linkedin.com`), never the URL / path level.
- Your IP address, device fingerprint, or any identifier tied to you personally.
- Any personally identifiable information.

Although Static's content scripts are registered on all URLs (required to intercept extension-fingerprinting probes wherever they occur), the scripts act only on `chrome-extension://` URLs (and equivalents on other browsers) and on a hardcoded list of DOM markers and `window` globals used by fingerprinting code. They do not read, transmit, or otherwise process any other page content.

## What Static does NOT transmit

Static has no backend. It makes no outbound network requests of its own. It contains no third-party SDKs, analytics frameworks, advertising integrations, crash-reporting services, or telemetry of any kind.

Static's only network-related action is **blocking** certain outbound requests initiated by the websites you visit, via Chrome's [`declarativeNetRequest`](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest) API and via interception of `fetch` / `XMLHttpRequest` calls to extension-scheme URLs. It never **originates** network requests itself.

## Permissions Static requests, and why

- **`declarativeNetRequest`** — to block fingerprinting, tracking, and session-replay vendor endpoints at the browser's network layer. Blocking is declarative; Static does not inspect the contents of these requests.
- **`storage`** — to persist the items listed under "What Static stores locally" above. Uses `chrome.storage.local` only; never `chrome.storage.sync`.
- **Content-script `matches: ["<all_urls>"]`** — to register the API interception on every page, because fingerprinting can happen on any site. Static does not read page content in any origin it runs on.
- No `host_permissions` are additionally requested; the content-script match patterns are the only host access.

## User-initiated data export

The log viewer offers two export options. Both save a JSON file to your computer via the browser's native download mechanism; nothing is transmitted.

- **Export raw log** — full fidelity, including per-origin `lastUpdated` timestamps, exact per-ID probe counts, weekly playbook summaries, and the since-install cumulative counter. Intended for private archival. If you choose to share this file, be aware that timestamps plus exact counts can be correlated with similar dumps from other users to partially re-identify individual browsing patterns.
- **Export for research** — anonymized. Replaces the precise `exportedAt` timestamp with a coarse `exportMonth` (`"YYYY-MM"`), drops per-origin `lastUpdated` timestamps, drops the since-install cumulative counter, coarsens per-ID counts into log-scale buckets (`2-5`, `6-20`, `21-100`, `101-1000`, `1000+`), drops IDs probed fewer than 2 times (canary filter), and drops origins with fewer than 3 surviving IDs (low-signal noise filter). Safe to publish or contribute to aggregate datasets that document how the web fingerprints browser extensions.

Static does not retain a copy of any export. Once the file is downloaded, only you have it.

## Third parties

Static shares no data with third parties. Static contains no third-party code or SDKs and integrates with no external services.

## Your rights

Because Static stores data only on your own machine, your rights of access, portability, and erasure are exercised directly through the extension itself:

- **Access**: everything Static has ever recorded about probes against you is visible in the log viewer.
- **Portability**: downloadable as JSON at any time via the **Export** buttons in the log viewer.
- **Erasure**: the **Clear log** button wipes the probe log, resets the since-install counter, and resets the Noise-mode user secret. Uninstalling Static removes all stored data, including preferences.

No request to the author is required to exercise any of these rights.

## Changes to this policy

If this policy changes, the updated version will be published at the same URL and the "Last updated" date at the top will change. Material changes will also be noted in the project [CHANGELOG](https://github.com/G-man3207/Static/blob/main/CHANGELOG.md).

## Source code and audit

Static is open source under the MIT license. Every behavior described in this policy is verifiable by reading the source code:  
https://github.com/G-man3207/Static

## Contact

For privacy or security questions, please open an issue on GitHub:  
https://github.com/G-man3207/Static/issues
