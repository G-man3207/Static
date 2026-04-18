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
