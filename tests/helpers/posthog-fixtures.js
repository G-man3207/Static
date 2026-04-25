const posthogFixtureFiles = {
  "/posthog-replay.html": `
    <!doctype html>
    <meta charset="utf-8">
    <input id="secret" type="email" />
    <script src="/assets/posthog/static/lazy-recorder.js"></script>
    <script>
      window.__posthogAppValues = [];
      document.addEventListener("input", (event) => {
        window.__posthogAppValues.push(event.target.value);
      });
    </script>
  `,
  "/assets/posthog/static/lazy-recorder.js": `
    window.__posthogReplayRecords = [];
    window.__PosthogExtensions__ = {
      initSessionRecording() {},
      rrweb: { record() {} },
    };
    window.posthog = {
      sessionRecordingStarted() {
        return true;
      },
    };
    function posthogLazyRecorder(event) {
      window.__posthogReplayRecords.push({
        type: event.type,
        value: event.target && event.target.value,
      });
    }
    document.addEventListener("input", posthogLazyRecorder, true);
  `,
  "/posthog-global-replay.html": `
    <!doctype html>
    <meta charset="utf-8">
    <input id="secret" type="email" />
    <script src="/assets/app/posthog-bundled.js"></script>
    <script>
      window.__posthogAppValues = [];
      document.addEventListener("input", (event) => {
        window.__posthogAppValues.push(event.target.value);
      });
      posthog.startSessionRecording();
    </script>
  `,
  "/posthog-global-auto.html": `
    <!doctype html>
    <meta charset="utf-8">
    <input id="secret" type="email" />
    <script src="/assets/app/posthog-bundled.js"></script>
    <script>
      window.__posthogAppValues = [];
      document.addEventListener("input", (event) => {
        window.__posthogAppValues.push(event.target.value);
      });
      posthog.init("project-token", {
        api_host: "https://us.i.posthog.com",
      });
    </script>
  `,
  "/posthog-global-disabled.html": `
    <!doctype html>
    <meta charset="utf-8">
    <input id="secret" type="email" />
    <script src="/assets/app/posthog-bundled.js"></script>
    <script>
      window.__posthogAppValues = [];
      document.addEventListener("input", (event) => {
        window.__posthogAppValues.push(event.target.value);
      });
      posthog.init("project-token", {
        api_host: "https://us.i.posthog.com",
        disable_session_recording: true,
      });
    </script>
  `,
  "/posthog-global-flags-disabled.html": `
    <!doctype html>
    <meta charset="utf-8">
    <input id="secret" type="email" />
    <script src="/assets/app/posthog-bundled.js"></script>
    <script>
      window.__posthogAppValues = [];
      document.addEventListener("input", (event) => {
        window.__posthogAppValues.push(event.target.value);
      });
      posthog.init("project-token", {
        advanced_disable_flags: true,
        api_host: "https://us.i.posthog.com",
      });
    </script>
  `,
  "/assets/app/posthog-bundled.js": `
    window.__posthogReplayRecords = [];
    window.__posthogAnalyticsRecords = [];
    window.posthog = [];
    function startAnalytics(context) {
      if (context.__analyticsStarted) return;
      context.__analyticsStarted = true;
      function recordAnalyticsInput(event) {
        window.__posthogAnalyticsRecords.push({
          type: event.type,
          value: event.target && event.target.value,
        });
      }
      document.addEventListener("input", recordAnalyticsInput, true);
    }
    function startRecorder(context) {
      if (context.__recording) return;
      context.__recording = true;
      function recordInput(event) {
        window.__posthogReplayRecords.push({
          type: event.type,
          value: event.target && event.target.value,
        });
      }
      document.addEventListener("input", recordInput, true);
    }
    posthog.init = function init(_token, config) {
      this.config = config || {};
      startAnalytics(this);
      if (
        this.config.advanced_disable_decide === true ||
        this.config.advanced_disable_flags === true ||
        this.config.disable_session_recording === true
      ) {
        return;
      }
      startRecorder(this);
    };
    posthog.startSessionRecording = function startSessionRecording() {
      startRecorder(this);
    };
    posthog.sessionRecordingStarted = function sessionRecordingStarted() {
      return !!this.__recording;
    };
  `,
};

module.exports = { posthogFixtureFiles };
