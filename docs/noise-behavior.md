# Noise Behavior Contract

Noise mode should be internally consistent before it is broad. A decoy ID should not answer
"installed" through one passive probe vector and immediately contradict itself through another.

## Current Contract

| Probe vector                                | Eligible Noise persona ID                                                                        | Non-persona or invalid ID       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------- |
| `fetch(.../manifest.json)`                  | `200 OK` generic MV3 manifest                                                                    | Native-like `TypeError` failure |
| `XMLHttpRequest` to `manifest.json`         | `200 OK` generic MV3 manifest                                                                    | Native-like network error       |
| `Image.src` / `img.setAttribute("src")`     | Loads a 1x1 transparent PNG; page-visible getters return the original extension URL              | Blocked                         |
| `script.src` / `script.setAttribute("src")` | Loads an empty inert JavaScript resource; page-visible getters return the original extension URL | Blocked                         |
| `link.href` / `link.setAttribute("href")`   | Loads an empty inert stylesheet; page-visible getters return the original extension URL          | Blocked                         |
| `iframe.src`                                | Fail-closed                                                                                      | Fail-closed                     |
| `object.data`, `embed.src`, `source.src`    | Receives an inert data URL matched to the path kind where possible                               | Blocked                         |
| `Worker`, `SharedWorker`                    | Fail-closed                                                                                      | Fail-closed                     |
| `EventSource`                               | Fail-closed with EventSource-shaped error behavior                                               | Fail-closed                     |
| `serviceWorker.register`                    | Fail-closed                                                                                      | Fail-closed                     |

## Why Active Surfaces Stay Blocked

Frames, workers, service workers, and event streams expose enough behavior that a shallow fake is
easier to detect than a consistent failure. They need separate contracts before being decoyed:
origin access, constructor errors, lifecycle events, message channels, script execution timing,
scope semantics, stream state, and cleanup behavior all have to line up.

## Test Requirements

Every extension of this contract should include browser tests for:

- Page-visible URL getters and `getAttribute` / `getAttributeNS`.
- Load/error event outcome.
- Probe log vector normalization.
- Invalid ID rejection.
- API surface shape after wrapping.
- Adversarial cross-vector consistency via `tests/adversarial-consistency.spec.js`.
