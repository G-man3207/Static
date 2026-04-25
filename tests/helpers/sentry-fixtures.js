const sentryFixtureFiles = {
  "/sentry-global-replay.html": `
    <!doctype html>
    <meta charset="utf-8">
    <input id="secret" type="email" />
    <script src="/assets/app/sentry-bundled.js"></script>
    <script>
      window.__sentryAppValues = [];
      document.addEventListener("input", (event) => {
        window.__sentryAppValues.push(event.target.value);
      });
      window.Sentry.init({
        dsn: "https://public@example.invalid/1",
        replaysSessionSampleRate: 1.0,
        replaysOnErrorSampleRate: 1.0,
        integrations: [window.Sentry.replayIntegration()],
      });
    </script>
  `,
  "/sentry-global-lazy-replay.html": `
    <!doctype html>
    <meta charset="utf-8">
    <input id="secret" type="email" />
    <script src="/assets/app/sentry-bundled.js"></script>
    <script>
      window.__sentryAppValues = [];
      document.addEventListener("input", (event) => {
        window.__sentryAppValues.push(event.target.value);
      });
      window.Sentry.init({
        dsn: "https://public@example.invalid/1",
        integrations: [],
      });
      window.Sentry.addIntegration(window.LazySentry.replayIntegration());
    </script>
  `,
  "/sentry-global-no-replay.html": `
    <!doctype html>
    <meta charset="utf-8">
    <input id="secret" type="email" />
    <script src="/assets/app/sentry-bundled.js"></script>
    <script>
      window.__sentryAppValues = [];
      document.addEventListener("input", (event) => {
        window.__sentryAppValues.push(event.target.value);
      });
      window.Sentry.init({
        dsn: "https://public@example.invalid/1",
      });
    </script>
  `,
  "/assets/app/sentry-bundled.js": `
    window.__sentryGlobalRecords = [];
    function hasReplayIntegration(config) {
      return Array.isArray(config && config.integrations)
        ? config.integrations.some((integration) => /replay/i.test(integration && integration.name))
        : false;
    }
    function hasReplaySample(config) {
      return !!(
        config &&
        (config.replaysSessionSampleRate > 0 || config.replaysOnErrorSampleRate > 0)
      );
    }
    function startSentryReplay(context) {
      if (context.__recording) return;
      context.__recording = true;
      function sentryReplayRecorder(event) {
        window.__sentryGlobalRecords.push({
          type: event.type,
          value: event.target && event.target.value,
        });
      }
      document.addEventListener("input", sentryReplayRecorder, true);
    }
    window.Sentry = {
      init(config) {
        this.__config = config || {};
        if (hasReplayIntegration(this.__config) && hasReplaySample(this.__config)) {
          startSentryReplay(this);
        }
      },
      addIntegration(integration) {
        this.__integrations = this.__integrations || [];
        this.__integrations.push(integration);
        if (/replay/i.test(integration && integration.name)) startSentryReplay(this);
      },
      isRecording() {
        return !!this.__recording;
      },
      replayIntegration() {
        return { name: "Replay", setupOnce() {} };
      },
      replayCanvasIntegration() {
        return { name: "ReplayCanvas", setupOnce() {} };
      },
    };
    window.LazySentry = {
      replayIntegration() {
        return { name: "Replay", setupOnce() {} };
      },
    };
  `,
};

module.exports = { sentryFixtureFiles };
