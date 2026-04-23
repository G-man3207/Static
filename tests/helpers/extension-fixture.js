const { expect, test: base } = require("@playwright/test");
const { launchExtension } = require("./extension");
const { startFixtureServer } = require("./server");

const fixtureFiles = {
  "/blank.html": '<!doctype html><meta charset="utf-8"><body>blank</body>',
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
  "/datadog-replay-auto.html": `
    <!doctype html>
    <meta charset="utf-8">
    <input id="secret" type="email" />
    <script src="/assets/replay/datadog-rum.js"></script>
    <script>
      window.__ddAppValues = [];
      document.addEventListener("input", (event) => {
        window.__ddAppValues.push(event.target.value);
      });
      window.DD_RUM.init({
        sessionSampleRate: 100,
        sessionReplaySampleRate: 100,
      });
    </script>
  `,
  "/datadog-replay-manual.html": `
    <!doctype html>
    <meta charset="utf-8">
    <input id="secret" type="email" />
    <script src="/assets/replay/datadog-rum.js"></script>
    <script>
      window.__ddAppValues = [];
      document.addEventListener("input", (event) => {
        window.__ddAppValues.push(event.target.value);
      });
      window.DD_RUM.init({
        sessionSampleRate: 100,
        sessionReplaySampleRate: 100,
        startSessionReplayRecordingManually: true,
      });
    </script>
  `,
  "/assets/replay/datadog-rum.js": `
    window.__datadogReplayRecords = [];
    function registerDatadogReplayListener(context) {
      if (context.__replayStarted) return;
      context.__replayStarted = true;
      function datadogReplayRecorder(event) {
        window.__datadogReplayRecords.push({
          type: event.type,
          value: event.target && event.target.value,
        });
      }
      document.addEventListener("input", datadogReplayRecorder, true);
    }
    window.DD_RUM = {
      __config: null,
      init(config) {
        this.__config = config || {};
        if (
          this.__config.sessionReplaySampleRate > 0 &&
          !this.__config.startSessionReplayRecordingManually
        ) {
          registerDatadogReplayListener(this);
        }
      },
      startSessionReplayRecording() {
        registerDatadogReplayListener(this);
      },
      stopSessionReplayRecording() {
        this.__replayStarted = false;
      },
      onReady(callback) {
        callback();
      },
    };
  `,
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
