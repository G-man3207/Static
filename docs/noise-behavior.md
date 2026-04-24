# Noise Behavior Contract

Noise mode should be internally consistent before it is broad. A decoy ID should not answer
"installed" through one passive probe vector and immediately contradict itself through another.

## Current Contract

Known plausible extension IDs can enter an origin persona after 2 probes. Unknown extension-shaped
IDs need stronger repeated evidence before they are eligible, so a site cannot cheaply seed Static's
persona with fake two-hit canaries.

| Probe vector                                | Eligible Noise persona ID                                                                        | Non-persona or invalid ID       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------- |
| `fetch(.../manifest.json)`                  | Allowlisted static `GET` / `HEAD` paths receive path-matched decoys                              | Native-like `TypeError` failure |
| `XMLHttpRequest` to `manifest.json`         | Allowlisted static `GET` / `HEAD` paths receive path-matched decoys                              | Native-like network error       |
| `Image.src` / `img.setAttribute("src")`     | Loads a 1x1 transparent PNG; page-visible getters return the original extension URL              | Blocked                         |
| `Image.srcset` / `source.srcset`            | Loads a 1x1 transparent PNG candidate; page-visible getters return the original extension URL    | Blocked                         |
| `input.src` for image inputs                | Loads a 1x1 transparent PNG; page-visible getters return the original extension URL              | Blocked                         |
| `video.poster` / `video.setAttribute`       | Loads a 1x1 transparent PNG; page-visible getters return the original extension URL              | Blocked                         |
| `script.src` / `script.setAttribute("src")` | Loads an empty inert JavaScript resource; page-visible getters return the original extension URL | Blocked                         |
| `link.href` / `link.setAttribute("href")`   | Loads an inert data URL matched to plausible stylesheet, image, script, or HTML paths; page-visible getters return the original extension URL | Blocked |
| `link rel=preload/modulepreload`            | Plausible image, script, and stylesheet paths receive matched inert preload resources            | Blocked                         |
| SVG `use/image href` / `href.baseVal`       | Loads an inert image decoy for plausible image paths; page-visible getters return the original URL | Blocked                       |
| Attribute-node APIs / serialization          | `Attr.value`, `attributes[...]`, `setAttributeNode`, `cloneNode`, `innerHTML` / `outerHTML`, and `XMLSerializer` preserve the same page-visible original URL | Blocked |
| `iframe.src`                                | Fail-closed                                                                                      | Fail-closed                     |
| `object.data`, `embed.src`, `source.src`    | Receives an inert data URL matched to the path kind where possible                               | Blocked                         |
| `audio.src`, `video.src`, `track.src`       | Fail-closed                                                                                      | Fail-closed                     |
| `Audio(url)`                                | Fail-closed without storing extension audio targets                                              | Fail-closed                     |
| `a.href`, `area.href`, `base.href`, `a.ping` | Fail-closed without storing extension navigation or ping targets                                | Fail-closed                     |
| `form.action`, `button.formAction`, `input.formAction` | Fail-closed without storing extension submission targets                               | Fail-closed                     |
| CSSOM `insertRule`, `replace`, `replaceSync` | Fail-closed without inserting extension-URL rules                                                 | Fail-closed                     |
| `<style>` text / `innerHTML` / DOM insertion | Fail-closed before extension `@import` URLs can persist in style text                            | Fail-closed                     |
| CSS declaration and style-attribute URLs    | Fail-closed synchronously for CSSOM setters, style attributes, HTML sinks, and parsed-node insertion | Fail-closed |
| `Worker`, `SharedWorker`, worklet `addModule` | Fail-closed                                                                                    | Fail-closed                     |
| `EventSource`                               | Fail-closed with EventSource-shaped error behavior                                               | Fail-closed                     |
| `serviceWorker.register`                    | Fail-closed                                                                                      | Fail-closed                     |

## Why Active Surfaces Stay Blocked

Frames, workers, worklets, service workers, and event streams expose enough behavior that a shallow fake is
easier to detect than a consistent failure. They need separate contracts before being decoyed:
origin access, constructor errors, lifecycle events, message channels, script execution timing,
scope semantics, stream state, and cleanup behavior all have to line up.

Non-`GET` / non-`HEAD` fetch and XHR probes also stay blocked, even for persona IDs. Real extension
web-accessible resources are static reads; answering POST-like canaries would give probing scripts a
cheap way to distinguish Noise from a browser-managed resource load.

Suspicious paths stay blocked too, even when the suffix looks decoyable. Returning generic `200 OK`
bodies for arbitrary `*.png`, `*.js`, `*.css`, or `*.html` canaries would let a probing script seed
random path names and then distinguish Static from a normal extension resource lookup. Noise only
answers a conservative allowlist of plausible extension resource paths such as `manifest.json`,
common icon names, and common page / script / stylesheet entrypoints.

## Test Requirements

Every extension of this contract should include browser tests for:

- Page-visible URL getters and `getAttribute` / `getAttributeNS`.
- Load/error event outcome.
- Probe log vector normalization.
- Invalid ID rejection.
- API surface shape after wrapping.
- Adversarial cross-vector consistency via `tests/adversarial-consistency.spec.js`.
