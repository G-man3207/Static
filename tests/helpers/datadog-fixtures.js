const datadogFixtureFiles = {
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
    window.__datadogRumRecords = [];
    function registerDatadogRumListener(context) {
      if (context.__rumStarted) return;
      context.__rumStarted = true;
      function datadogRumAction(event) {
        window.__datadogRumRecords.push({
          type: event.type,
          value: event.target && event.target.value,
        });
      }
      document.addEventListener("input", datadogRumAction, true);
    }
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
        registerDatadogRumListener(this);
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
};

module.exports = { datadogFixtureFiles };
