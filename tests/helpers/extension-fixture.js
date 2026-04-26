/* eslint-disable max-lines -- shared extension fixture catalog is intentionally centralized */
const { expect, test: base } = require("@playwright/test");
const { datadogFixtureFiles } = require("./datadog-fixtures");
const { launchExtension } = require("./extension");
const { hotjarFixtureFiles } = require("./hotjar-fixtures");
const { posthogFixtureFiles } = require("./posthog-fixtures");
const { startFixtureServer } = require("./server");
const { sentryFixtureFiles } = require("./sentry-fixtures");

const fixtureFiles = {
  "/blank.html": '<!doctype html><meta charset="utf-8"><body>blank</body>',
  "/trusted-types.html": `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="require-trusted-types-for 'script'"><body>trusted</body>`,
  "/message-listener.html": `
    <!doctype html>
    <meta charset="utf-8">
    <script>
      window.staticMessages = [];
      window.staticBridgeEvents = [];
      window.addEventListener("message", (event) => {
        if (event.data && event.data.__static_bridge_init__) {
          window.staticMessages.push({ data: event.data, ports: event.ports.length });
        }
      });
      document.addEventListener("__static_bridge_init__", (event) => {
        window.staticBridgeEvents.push({ type: event.type, ports: event.ports.length });
      });
    </script>
    <body>listener</body>
  `,
  "/dom.html": `
    <!doctype html>
    <meta charset="utf-8">
    <body>
      <div id="target" data-grammarly-extension="1" data-lastpass-root="1" class="keep grammarly-card lastpass-panel"></div>
      <grammarly-card id="custom-card"></grammarly-card>
    </body>
  `,
  "/shadow-dom.html": `
    <!doctype html>
    <meta charset="utf-8">
    <body>
      <script>
        const host = document.createElement("div");
        host.id = "host";
        const root = host.attachShadow({ mode: "open" });
        root.innerHTML =
          '<div id="inside" data-grammarly-extension="1" class="keep grammarly-card"></div>' +
          '<grammarly-card id="shadow-card"></grammarly-card>';
        document.body.appendChild(host);
        setTimeout(() => {
          const later = document.createElement("div");
          later.id = "later";
          later.className = "keep dashlane-panel";
          later.setAttribute("data-dashlanecreated", "1");
          root.appendChild(later);
          window.__shadowDone = true;
        }, 0);
      </script>
    </body>
  `,
  "/ad-observe-positive.html": `
    <!doctype html>
    <meta charset="utf-8">
    <body>
      <div id="ad-slot" class="ad-slot"></div>
      <script src="/assets/ad/loader-1234567890abcdef1234567890abcdef.js?token=secret-token"></script>
    </body>
  `,
  "/assets/ad/loader-1234567890abcdef1234567890abcdef.js": `
    window.googletag = {
      defineSlot() {
        return {
          addService() {
            return this;
          },
        };
      },
      pubads() {
        return {};
      },
    };
    window.googletag.defineSlot("/1234/home", [300, 250], "ad-slot").addService(
      window.googletag.pubads()
    );
    const iframe = document.createElement("iframe");
    iframe.width = "300";
    iframe.height = "250";
    iframe.src = "/creative/widget.html?creative=private-token";
    document.getElementById("ad-slot").appendChild(iframe);
    navigator.sendBeacon(
      "/collect/impression/user-1234567890abcdef1234567890abcdef?token=secret-token",
      "body-should-not-store"
    );
    window.__adObserveDone = true;
  `,
  "/ad-dnr-fetch.html": `
    <!doctype html>
    <meta charset="utf-8">
    <body>
      <div id="dnr-ad-slot"></div>
      <script src="/assets/ad/dnr-fetch-loader-1234567890abcdef1234567890abcdef.js?token=secret-token"></script>
    </body>
  `,
  "/assets/ad/dnr-fetch-loader-1234567890abcdef1234567890abcdef.js": `
    (async () => {
      window.googletag = {
        defineSlot() {
          return {
            addService() {
              return this;
            },
          };
        },
        pubads() {
          return {};
        },
      };
      window.googletag.defineSlot("/1234/dnr", [300, 250], "dnr-ad-slot").addService(
        window.googletag.pubads()
      );
      const iframe = document.createElement("iframe");
      iframe.width = "300";
      iframe.height = "250";
      iframe.src = "/creative/dnr-widget.html?creative=private-token";
      document.getElementById("dnr-ad-slot").appendChild(iframe);
      try {
        await fetch(
          "/collect/impression/fetch-1234567890abcdef1234567890abcdef?token=secret-token"
        );
        window.__adDnrFetchTraining = "resolved";
      } catch {
        window.__adDnrFetchTraining = "blocked";
      }
      window.__adDnrFetchDone = true;
    })();
  `,
  "/ad-dnr-fetch-check.html": `
    <!doctype html>
    <meta charset="utf-8">
    <body>
      <script>
        fetch("/collect/impression/fetch-later-1234567890abcdef1234567890abcdef")
          .then(() => {
            window.__adDnrFetchStatus = "resolved";
          })
          .catch(() => {
            window.__adDnrFetchStatus = "blocked";
          });
      </script>
    </body>
  `,
  "/ad-dnr-api.html": `
    <!doctype html>
    <meta charset="utf-8">
    <body>
      <div id="dnr-api-slot"></div>
      <script src="/assets/ad/dnr-api-loader-1234567890abcdef1234567890abcdef.js?token=secret-token"></script>
    </body>
  `,
  "/assets/ad/dnr-api-loader-1234567890abcdef1234567890abcdef.js": `
    (async () => {
      window.googletag = {
        defineSlot() {
          return {
            addService() {
              return this;
            },
          };
        },
        pubads() {
          return {};
        },
      };
      window.googletag.defineSlot("/1234/dnr-api", [300, 250], "dnr-api-slot").addService(
        window.googletag.pubads()
      );
      const iframe = document.createElement("iframe");
      iframe.width = "300";
      iframe.height = "250";
      iframe.src = "/creative/dnr-api-widget.html?creative=private-token";
      document.getElementById("dnr-api-slot").appendChild(iframe);
      await fetch(
        "/api/ads/impression/api-1234567890abcdef1234567890abcdef?token=secret-token"
      ).catch(() => {});
      window.__adDnrApiDone = true;
    })();
  `,
  "/ad-session-first.html": `
    <!doctype html>
    <meta charset="utf-8">
    <body>
      <div id="session-slot"><div id="session-inner"></div></div>
      <script src="/assets/ad/session-loader-1234567890abcdef1234567890abcdef.js?token=secret-token"></script>
    </body>
  `,
  "/assets/ad/session-loader-1234567890abcdef1234567890abcdef.js": `
    window.googletag = {
      defineSlot() {
        return {
          addService() {
            return this;
          },
        };
      },
      pubads() {
        return {};
      },
    };
    window.googletag.defineSlot("/1234/session", [300, 250], "session-slot").addService(
      window.googletag.pubads()
    );
    const iframe = document.createElement("iframe");
    iframe.width = "300";
    iframe.height = "250";
    iframe.src = "/creative/session-widget.html?creative=private-token";
    document.getElementById("session-inner").appendChild(iframe);
    navigator.sendBeacon(
      "/collect/impression/session-1234567890abcdef1234567890abcdef?token=secret-token",
      "body-should-not-store"
    );
    window.__adSessionDone = true;
  `,
  "/ad-session-second.html": `
    <!doctype html>
    <meta charset="utf-8">
    <style>
      #session-slot { width: 300px; min-height: 250px; background: #fee; }
      #session-slot iframe { border: 0; display: block; width: 300px; height: 250px; }
    </style>
    <body>
      <div id="session-slot" class="ad-slot">
        <iframe width="300" height="250" title="Advertisement" src="/ad-creative.html"></iframe>
      </div>
    </body>
  `,
  "/ad-playbook-broad-selector.html": `
    <!doctype html>
    <meta charset="utf-8">
    <body>
      <div class="ad"></div>
      <script src="/assets/ad/broad-loader-abcdef1234567890abcdef1234567890.js?token=secret-token"></script>
    </body>
  `,
  "/assets/ad/broad-loader-abcdef1234567890abcdef1234567890.js": `
    window.googletag = {
      defineSlot() {
        return {
          addService() {
            return this;
          },
        };
      },
      pubads() {
        return {};
      },
    };
    window.googletag.defineSlot("/1234/broad", [300, 250]).addService(
      window.googletag.pubads()
    );
    const iframe = document.createElement("iframe");
    iframe.width = "300";
    iframe.height = "250";
    iframe.src = "/creative/broad-widget.html?creative=private-token";
    document.querySelector(".ad").appendChild(iframe);
    navigator.sendBeacon(
      "/collect/impression/broad-1234567890abcdef1234567890abcdef?token=secret-token",
      "body-should-not-store"
    );
    window.__adBroadSelectorDone = true;
  `,
  "/ad-observe-negative.html": `
    <!doctype html>
    <meta charset="utf-8">
    <body>
      <div id="widget" class="content-widget"></div>
      <script>
        const iframe = document.createElement("iframe");
        iframe.width = "300";
        iframe.height = "250";
        iframe.src = "/ordinary-widget.html";
        document.getElementById("widget").appendChild(iframe);
        const observer = new IntersectionObserver((entries) => {
          window.__ordinaryIntersectionCount = entries.length;
        });
        observer.observe(iframe);
        fetch("/api/widget-status").catch(() => {});
        setTimeout(() => {
          window.__adNegativeDone = true;
        }, 50);
      </script>
    </body>
  `,
  "/ordinary-widget.html": `
    <!doctype html>
    <meta charset="utf-8">
    <body>ordinary widget</body>
  `,
  "/ad-cosmetic-slot.html": `
    <!doctype html>
    <meta charset="utf-8">
    <style>
      body { margin: 0; font-family: sans-serif; }
      #top, #below { height: 40px; padding: 8px; background: #f5f5f5; }
      #ad-slot { width: 300px; min-height: 250px; margin: 20px 0; background: #fee; }
      #ad-slot iframe { border: 0; display: block; width: 300px; height: 250px; }
      #sticky-ad { position: fixed; right: 12px; bottom: 12px; width: 300px; height: 250px; background: #fee; z-index: 10; }
      #sticky-ad iframe { border: 0; width: 300px; height: 250px; }
    </style>
    <body>
      <div id="top">top content</div>
      <div id="ad-slot" class="ad-slot">
        <iframe id="ad-frame" width="300" height="250" title="Advertisement" src="/ad-creative.html"></iframe>
      </div>
      <div id="below">below content</div>
      <div id="sticky-ad" class="sticky-ad">
        <iframe id="sticky-ad-frame" width="300" height="250" title="Advertisement" src="/ad-creative.html"></iframe>
      </div>
    </body>
  `,
  "/ad-cosmetic-empty-frame.html": `
    <!doctype html>
    <meta charset="utf-8">
    <style>
      #empty-ad-slot { width: 300px; height: 250px; background: #fee; }
      #empty-ad-frame { border: 0; width: 300px; height: 250px; }
    </style>
    <body>
      <div id="empty-ad-slot" class="ad-slot">
        <iframe id="empty-ad-frame" width="300" height="250" title="Advertisement" src="about:blank"></iframe>
      </div>
    </body>
  `,
  "/ad-cosmetic-false-positives.html": `
    <!doctype html>
    <meta charset="utf-8">
    <style>
      body { margin: 0; font-family: sans-serif; }
      .boundary { margin: 8px; padding: 10px; border: 1px solid #ddd; background: #fff; }
      #sticky-nav { position: sticky; top: 0; z-index: 2; background: #eef; }
      #cookie-banner { position: fixed; left: 0; right: 0; bottom: 0; background: #ffe; }
      iframe { border: 0; display: block; width: 300px; height: 250px; }
    </style>
    <body>
      <section id="comments-widget" class="boundary comments-widget">Reader comments</section>
      <section id="product-card" class="boundary product-card">Adidas running shoe</section>
      <section id="video-card" class="boundary video-card">
        <iframe width="300" height="250" title="Training video" src="/video-player.html"></iframe>
      </section>
      <section id="dashboard-panel" class="boundary dashboard-panel">
        <iframe width="300" height="250" title="Dashboard chart" src="/dashboard-widget.html"></iframe>
      </section>
      <nav id="sticky-nav" class="boundary sticky-nav">Sticky navigation</nav>
      <div id="cookie-banner" class="boundary cookie-banner" role="dialog">Cookie preferences</div>
      <section id="recommendations" class="boundary recommendations">Recommended articles</section>
      <section id="legit-300x250" class="boundary content-card">
        <iframe width="300" height="250" title="Content module" src="/content-300x250.html"></iframe>
      </section>
    </body>
  `,
  "/ad-creative.html": `
    <!doctype html>
    <meta charset="utf-8">
    <body>creative</body>
  `,
  "/video-player.html": `
    <!doctype html>
    <meta charset="utf-8">
    <body>video player</body>
  `,
  "/dashboard-widget.html": `
    <!doctype html>
    <meta charset="utf-8">
    <body>dashboard widget</body>
  `,
  "/content-300x250.html": `
    <!doctype html>
    <meta charset="utf-8">
    <body>legitimate content</body>
  `,
  "/ad-score-iframe-only.html": `
    <!doctype html>
    <meta charset="utf-8">
    <body>
      <div id="widget"></div>
      <script>
        const iframe = document.createElement("iframe");
        iframe.width = "300";
        iframe.height = "250";
        iframe.src = "/ordinary-widget.html";
        document.getElementById("widget").appendChild(iframe);
        setTimeout(() => {
          window.__adIframeOnlyDone = true;
        }, 50);
      </script>
    </body>
  `,
  "/ad-score-sponsored-dom-only.html": `
    <!doctype html>
    <meta charset="utf-8">
    <body>
      <div id="sponsored-card" class="sponsored-card">Sponsored placement label</div>
      <script>
        setTimeout(() => {
          window.__adSponsoredOnlyDone = true;
        }, 50);
      </script>
    </body>
  `,
  "/ad-score-intersection-only.html": `
    <!doctype html>
    <meta charset="utf-8">
    <body>
      <div id="content-card" class="content-card">Ordinary content card</div>
      <script>
        const observer = new IntersectionObserver((entries) => {
          window.__intersectionOnlyCount = entries.length;
        });
        observer.observe(document.getElementById("content-card"));
        setTimeout(() => {
          window.__adIntersectionOnlyDone = true;
        }, 50);
      </script>
    </body>
  `,
  "/ad-score-repeated-weak.html": `
    <!doctype html>
    <meta charset="utf-8">
    <body>
      <div id="placements"></div>
      <script>
        const placements = document.getElementById("placements");
        for (let i = 0; i < 12; i++) {
          const slot = document.createElement("div");
          slot.className = "sponsored-card";
          const iframe = document.createElement("iframe");
          iframe.width = "300";
          iframe.height = "250";
          iframe.src = "/ordinary-widget.html?slot=" + i;
          slot.appendChild(iframe);
          placements.appendChild(slot);
        }
        setTimeout(() => {
          window.__adRepeatedWeakDone = true;
        }, 50);
      </script>
    </body>
  `,
  "/replay.html": `
    <!doctype html>
    <meta charset="utf-8">
    <input id="secret" type="email" />
    <script src="/logrocket-recorder.js"></script>
    <script>
      window.__appValues = [];
      window.__appMoves = [];
      document.addEventListener("input", (event) => {
        window.__appValues.push(event.target.value);
      });
      document.addEventListener("mousemove", (event) => {
        window.__appMoves.push({ clientX: event.clientX, clientY: event.clientY });
      });
    </script>
  `,
  "/logrocket-recorder.js": `
    window.__replayRecords = [];
    function LogRocketRecorder(event) {
      window.__replayRecords.push({
        type: event.type,
        value: event.target && event.target.value,
        clientX: event.clientX,
        clientY: event.clientY,
        key: event.key,
        code: event.code,
        data: event.data,
      });
    }
    document.addEventListener("input", LogRocketRecorder, true);
    document.addEventListener("mousemove", LogRocketRecorder, true);
    window.LogRocket = { init() {} };
  `,
  ...hotjarFixtureFiles,
  "/sentry-replay.html": `
    <!doctype html>
    <meta charset="utf-8">
    <input id="secret" type="email" />
    <script src="/assets/sentry/bundle.tracing.replay.min.js?user_token=should-not-log"></script>
    <script>
      window.__appValues = [];
      document.addEventListener("input", (event) => {
        window.__appValues.push(event.target.value);
      });
    </script>
  `,
  "/assets/sentry/bundle.tracing.replay.min.js": `
    window.__sentryReplayRecords = [];
    window.Sentry = {
      replayIntegration() {},
      replayCanvasIntegration() {},
    };
    function sentryReplayIntegrationRecorder(event) {
      window.__sentryReplayRecords.push({
        type: event.type,
        value: event.target && event.target.value,
      });
    }
    document.addEventListener("input", sentryReplayIntegrationRecorder, true);
  `,
  ...sentryFixtureFiles,
  ...posthogFixtureFiles,
  "/openreplay-global-replay.html": `<!doctype html><meta charset="utf-8">
    <input id="secret" type="email" /><script src="/assets/app/openreplay-bundled.js"></script>
    <script>window.__orAppValues=[];document.addEventListener("input",(event)=>window.__orAppValues.push(event.target.value));OpenReplay.start();</script>`,
  "/assets/app/openreplay-bundled.js": `
    window.__orRecords = [];
    window.OpenReplay = { __recording: false, start() {
      if (this.__recording) return Promise.resolve({ sessionID: "already-recording" });
      this.__recording = true;
      document.addEventListener("input", function openReplayRecorder(event) { window.__orRecords.push({ type: event.type, value: event.target && event.target.value }); }, true);
      return Promise.resolve({ sessionID: "openreplay-session" });
    }, isActive() { return this.__recording; } };
  `,
  ...datadogFixtureFiles,
  "/adaptive-positive.html": `
    <!doctype html>
    <meta charset="utf-8">
    <script>
      (async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#123456";
        ctx.fillRect(0, 0, 32, 32);
        canvas.toDataURL();
        const gl = canvas.getContext("webgl");
        if (gl) {
          gl.getParameter(gl.VENDOR);
          gl.getParameter(gl.RENDERER);
        }
        void navigator.hardwareConcurrency;
        void navigator.languages;
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode("sensor"));
        await fetch("/collector", { method: "POST", body: "x".repeat(4096) }).catch(() => {});
        navigator.sendBeacon("/beacon", "x".repeat(4096));
        window.__adaptiveDone = true;
      })();
    </script>
  `,
  "/adaptive-canvas-app.html": `
    <!doctype html>
    <meta charset="utf-8">
    <script>
      const canvas = document.createElement("canvas");
      canvas.width = 128;
      canvas.height = 128;
      const ctx = canvas.getContext("2d");
      for (let i = 0; i < 40; i++) {
        ctx.fillStyle = "rgb(" + i + ",20,30)";
        ctx.fillRect(i % 128, (i * 3) % 128, 10, 10);
        canvas.toDataURL();
      }
      window.__canvasAppDone = true;
    </script>
  `,
  "/adaptive-audio-workstation.html": `
    <!doctype html>
    <meta charset="utf-8">
    <script>
      (async () => {
        if (typeof OfflineAudioContext === "function") {
          const context = new OfflineAudioContext(1, 128, 44100);
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          gain.gain.value = 0.2;
          oscillator.connect(gain);
          gain.connect(context.destination);
          oscillator.start(0);
          const buffer = await context.startRendering();
          buffer.getChannelData(0);
        }
        void navigator.hardwareConcurrency;
        await fetch("/audio/preset.json").catch(() => {});
        window.__adaptiveAudioWorkstationDone = true;
      })();
    </script>
  `,
  "/audio/preset.json": `{"name":"default","gain":0.2}`,
  "/adaptive-environment-fingerprint.html": `
    <!doctype html>
    <meta charset="utf-8">
    <script>
      (async () => {
        const snapshot = {
          cores: navigator.hardwareConcurrency,
          memory: navigator.deviceMemory,
          maxTouchPoints: navigator.maxTouchPoints,
          pdfViewerEnabled: navigator.pdfViewerEnabled,
          platform: navigator.platform,
          userAgent: navigator.userAgent,
          vendor: navigator.vendor,
          webdriver: navigator.webdriver,
          languages: navigator.languages,
          screen: [
            screen.width,
            screen.height,
            screen.availWidth,
            screen.availHeight,
            screen.colorDepth,
            screen.pixelDepth,
          ],
          timezoneOffset: new Date().getTimezoneOffset(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          storage: navigator.storage && navigator.storage.estimate
            ? await navigator.storage.estimate().catch(() => null)
            : null,
        };
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(snapshot)));
        await fetch("/spectroscopy-collect", {
          method: "POST",
          body: "x".repeat(2048),
        }).catch(() => {});
        window.__adaptiveEnvironmentDone = true;
      })();
    </script>
  `,
  "/adaptive-environment-app.html": `
    <!doctype html>
    <meta charset="utf-8">
    <script>
      (async () => {
        window.__layoutSnapshot = {
          language: navigator.languages,
          screen: [screen.width, screen.height],
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        };
        await fetch("/settings.json").catch(() => {});
        window.__adaptiveEnvironmentAppDone = true;
      })();
    </script>
  `,
  "/adaptive-private.html": `
    <!doctype html>
    <meta charset="utf-8">
    <script>
      (async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 16;
        canvas.height = 16;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#654321";
        ctx.fillRect(0, 0, 16, 16);
        canvas.toDataURL();
        void navigator.hardwareConcurrency;
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode("sensor"));
        await fetch(
          "/collect/user-1234567890abcdef1234567890abcdef?token=secret-token",
          { method: "POST", body: "payload" }
        ).catch(() => {});
        window.__adaptivePrivateDone = true;
      })();
    </script>
  `,
  "/adaptive-runtime-signatures.html": `
    <!doctype html>
    <meta charset="utf-8">
    <script>
      (async () => {
        window.ddjskey = "client-side-key";
        window.ddoptions = { sessionByHeader: true };
        const ddScript = document.createElement("script");
        ddScript.src = "/tags.js";
        document.head.appendChild(ddScript);

        window._pxAppId = "PXAPP123";
        window._pxHostUrl = "/px/collector";
        window._pxJsClientSrc = "/px/main.min.js";

        window._sift = window._sift || [];
        window._sift.push(["_setAccount", "beacon-key"]);
        window._sift.push(["_trackPageview"]);

        window.FingerprintJS = {
          load(options) {
            window.__fpLoadOptions = options;
            return Promise.resolve({
              get() {
                return Promise.resolve({ visitorId: "visitor" });
              },
            });
          },
        };
        const agent = await window.FingerprintJS.load({
          apiKey: "public-key",
          endpoint: ["/fp/result"],
          scriptUrlPattern: ["/fp/loader.js"],
        });
        await agent.get();
        window.__adaptiveVendorDone = true;
      })();
    </script>
  `,
  "/adaptive-runtime-signatures-fingerprint-v4.html": `
    <!doctype html>
    <meta charset="utf-8">
    <script>
      (async () => {
        window.Fingerprint = {
          start(options) {
            window.__fpStartOptions = options;
            return {
              get() {
                return Promise.resolve({ event_id: "event", visitor_id: "visitor" });
              },
            };
          },
        };
        const agent = window.Fingerprint.start({
          apiKey: "public-key",
          endpoints: ["/fp/v4?region=us"],
        });
        await agent.get();
        window.__adaptiveVendorFingerprintV4Done = true;
      })();
    </script>
  `,
  "/adaptive-runtime-signatures-versioned-datadome.html": `
    <!doctype html>
    <meta charset="utf-8">
    <script>
      (async () => {
        window.ddjskey = "client-side-key";
        window.ddoptions = { endpoint: "/js/", sessionByHeader: true };
        const ddScript = document.createElement("script");
        ddScript.src = "/v5.1.13/tags.js";
        document.head.appendChild(ddScript);
        await new Promise((resolve) => {
          ddScript.addEventListener("load", resolve, { once: true });
          ddScript.addEventListener("error", resolve, { once: true });
          setTimeout(resolve, 250);
        });
        window.__adaptiveVendorVersionedDatadomeDone = true;
      })();
    </script>
  `,
  "/adaptive-runtime-signatures-custom-datadome.html": `
    <!doctype html>
    <meta charset="utf-8">
    <script>
      (async () => {
        window.ddjskey = "client-side-key";
        window.ddoptions = { endpoint: "/dd/custom-js/", sessionByHeader: true };
        const ddScript = document.createElement("script");
        ddScript.src = "/assets/datadome-tag.js";
        document.head.appendChild(ddScript);
        await new Promise((resolve) => {
          ddScript.addEventListener("load", resolve, { once: true });
          ddScript.addEventListener("error", resolve, { once: true });
          setTimeout(resolve, 250);
        });
        window.__adaptiveVendorCustomDatadomeDone = true;
      })();
    </script>
  `,
  "/adaptive-runtime-signatures-human-first-party.html": `
    <!doctype html>
    <meta charset="utf-8">
    <script>
      (async () => {
        window._pxAppId = "PX12345678";
        const pxScript = document.createElement("script");
        pxScript.src = "/12345678/init.js";
        document.head.appendChild(pxScript);
        await new Promise((resolve) => {
          pxScript.addEventListener("load", resolve, { once: true });
          pxScript.addEventListener("error", resolve, { once: true });
          setTimeout(resolve, 250);
        });
        window.__adaptiveVendorHumanFirstPartyDone = true;
      })();
    </script>
  `,
  "/adaptive-runtime-signatures-human-custom-prefix.html": `
    <!doctype html>
    <meta charset="utf-8">
    <script>
      (async () => {
        window._pxAppId = "PX12345678";
        window._pxHostUrl = "/botdefense/xhr/";
        const pxScript = document.createElement("script");
        pxScript.src = "/botdefense/init.js";
        document.head.appendChild(pxScript);
        await new Promise((resolve) => {
          pxScript.addEventListener("load", resolve, { once: true });
          pxScript.addEventListener("error", resolve, { once: true });
          setTimeout(resolve, 250);
        });
        window.__adaptiveVendorHumanCustomPrefixDone = true;
      })();
    </script>
  `,
  "/adaptive-runtime-signatures-human-abr-custom-endpoint.html": `
    <!doctype html>
    <meta charset="utf-8">
    <script>
      (() => {
        window._pxAppId = "PX12345678";
        window._pxHostUrl = "/abr-shield/xhr/";
        window._pxJsClientSrc = "/abr-shield/sensor.js?cache=secret-token";
        const blockScript = document.createElement("script");
        blockScript.src = "/abr-shield/challenge.js?uuid=1234567890abcdef";
        document.head.appendChild(blockScript);
        window.__adaptiveVendorHumanAbrDone = true;
      })();
    </script>
  `,
  "/adaptive-runtime-benign-human-abr-lookalike.html": `
    <!doctype html>
    <meta charset="utf-8">
    <script>
      (() => {
        window._pxAppId = "PX12345678";
        window._pxHostUrl = "/abr-shield/xhr/";
        const sensorScript = document.createElement("script");
        sensorScript.src = "/abr-shield/sensor.js?cache=secret-token";
        document.head.appendChild(sensorScript);
        window.__adaptiveVendorHumanAbrLookalikeDone = true;
      })();
    </script>
  `,
  "/adaptive-runtime-benign-human-prefix-lookalike.html": `
    <!doctype html>
    <meta charset="utf-8">
    <script>
      (async () => {
        window._pxAppId = "PX12345678";
        window._pxHostUrl = "/collector";
        const pxScript = document.createElement("script");
        pxScript.src = "/botdefense/init.js";
        document.head.appendChild(pxScript);
        await new Promise((resolve) => {
          pxScript.addEventListener("load", resolve, { once: true });
          pxScript.addEventListener("error", resolve, { once: true });
          setTimeout(resolve, 250);
        });
        window.__adaptiveVendorHumanPrefixLookalikeDone = true;
      })();
    </script>
  `,
  "/adaptive-runtime-benign.html": `
    <!doctype html>
    <meta charset="utf-8">
    <script>
      const script = document.createElement("script");
      script.src = "/tags.js";
      document.head.appendChild(script);
      window._sift = [];
      window._pxHostUrl = "/collector";
      window.__adaptiveVendorBenignDone = true;
    </script>
  `,
  "/adaptive-module-runtime.html": `
    <!doctype html>
    <meta charset="utf-8">
    <script src="/assets/collector-1234567890abcdef1234567890abcdef.js?build=secret-token"></script>
  `,
  "/adaptive-dynamic-import.html": `
    <!doctype html>
    <meta charset="utf-8">
    <script type="module">
      const moduleSource = \`
        Promise.resolve().then(() => {
          setTimeout(async () => {
            const canvas = document.createElement("canvas");
            canvas.width = 16;
            canvas.height = 16;
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = "#fedcba";
            ctx.fillRect(0, 0, 16, 16);
            canvas.toDataURL();
            void navigator.hardwareConcurrency;
            void navigator.languages;
            await fetch("/dynamic-collect", { method: "POST", body: "x".repeat(2048) }).catch(
              () => {}
            );
            window.__adaptiveDynamicDone = true;
          }, 0);
        });
      \`;
      const moduleUrl = URL.createObjectURL(new Blob([moduleSource], { type: "text/javascript" }));
      import(moduleUrl);
    </script>
  `,
  "/adaptive-runtime-fallback.html": `
    <!doctype html>
    <meta charset="utf-8">
    <script>
      setTimeout(() => {
        Promise.resolve().then(async () => {
          const canvas = document.createElement("canvas");
          canvas.width = 12;
          canvas.height = 12;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#89abcd";
          ctx.fillRect(0, 0, 12, 12);
          canvas.toDataURL();
          void navigator.hardwareConcurrency;
          await fetch("/runtime-collect", { method: "POST", body: "x".repeat(2048) }).catch(
            () => {}
          );
          window.__adaptiveRuntimeFallbackDone = true;
        });
      }, 0);
    </script>
  `,
  "/adaptive-message-listener.html": `
    <!doctype html>
    <meta charset="utf-8">
    <script src="/assets/event-listener-1234567890abcdef1234567890abcdef.js?key=secret-token"></script>
    <script>
      setTimeout(() => {
        window.postMessage({ kind: "run" }, "*");
      }, 0);
    </script>
  `,
  "/adaptive-onmessage-runtime.html": `
    <!doctype html>
    <meta charset="utf-8">
    <script>
      setTimeout(() => {
        window.onmessage = async (event) => {
          if (!event.data || event.data.kind !== "run" || window.__adaptiveOnmessageDone) return;
          const canvas = document.createElement("canvas");
          canvas.width = 10;
          canvas.height = 10;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#456789";
          ctx.fillRect(0, 0, 10, 10);
          canvas.toDataURL();
          void navigator.hardwareConcurrency;
          await fetch("/onmessage-collect", { method: "POST", body: "x".repeat(2048) }).catch(
            () => {}
          );
          window.__adaptiveOnmessageDone = true;
        };
        window.postMessage({ kind: "run" }, "*");
      }, 0);
    </script>
  `,
  "/tags.js": `
    window.__tagScriptLoaded = true;
  `,
  "/v5.1.13/tags.js": `
    window.__versionedTagScriptLoaded = true;
  `,
  "/assets/datadome-tag.js": `
    fetch("/dd/custom-js/", { method: "POST", body: "tag-payload" }).catch(() => {});
    window.__customDatadomeTagLoaded = true;
  `,
  "/px/main.min.js": `
    window.__pxClientLoaded = true;
  `,
  "/assets/event-listener-1234567890abcdef1234567890abcdef.js": `
    window.addEventListener("message", {
      async handleEvent(event) {
        if (!event.data || event.data.kind !== "run" || window.__adaptiveMessageDone) return;
        const canvas = document.createElement("canvas");
        canvas.width = 14;
        canvas.height = 14;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#abcdef";
        ctx.fillRect(0, 0, 14, 14);
        canvas.toDataURL();
        void navigator.hardwareConcurrency;
        void navigator.languages;
        await fetch("/listener-collect", { method: "POST", body: "x".repeat(2048) }).catch(
          () => {}
        );
        window.__adaptiveMessageDone = true;
      },
    });
  `,
  "/assets/collector-1234567890abcdef1234567890abcdef.js": `
    (async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 24;
      canvas.height = 24;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#abcdef";
      ctx.fillRect(0, 0, 24, 24);
      canvas.toDataURL();
      const gl = canvas.getContext("webgl");
      if (gl) {
        gl.getParameter(gl.VENDOR);
        gl.getParameter(gl.RENDERER);
      }
      void navigator.hardwareConcurrency;
      void navigator.languages;
      await fetch("/module-collect", { method: "POST", body: "x".repeat(2048) }).catch(() => {});
      window.__adaptiveModuleDone = true;
    })();
  `,
  "/replay-private.html": `
    <!doctype html>
    <meta charset="utf-8">
    <input id="secret" type="email" />
    <script src="/assets/replay/logrocket-1234567890abcdef1234567890abcdef.js?token=secret-token"></script>
  `,
  "/assets/replay/logrocket-1234567890abcdef1234567890abcdef.js": `
    window.__privateReplayRecords = [];
    function LogRocketPrivateRecorder(event) {
      window.__privateReplayRecords.push({
        type: event.type,
        value: event.target && event.target.value,
      });
    }
    document.addEventListener("input", LogRocketPrivateRecorder, true);
  `,
};

const test = base.extend({
  extension: async ({ browserName, server }, use) => {
    void browserName;
    void server;
    const extension = await launchExtension();
    try {
      await extension.serviceWorker.evaluate(() => chrome.storage.local.clear());
      await use(extension);
    } finally {
      await extension.close();
    }
  },
  server: async ({ browserName }, use) => {
    void browserName;
    const server = await startFixtureServer(fixtureFiles);
    try {
      await use(server);
    } finally {
      await server.close();
    }
  },
});

module.exports = {
  expect,
  test,
};
