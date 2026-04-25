const hotjarFixtureFiles = {
  "/hotjar-replay.html": `
    <!doctype html>
    <meta charset="utf-8">
    <input id="secret" type="email" />
    <script src="/assets/hotjar/hotjar-123456.js"></script>
    <script>
      window.__hotjarAppValues = [];
      document.addEventListener("input", (event) => {
        window.__hotjarAppValues.push(event.target.value);
      });
    </script>
  `,
  "/assets/hotjar/hotjar-123456.js": `
    window.__hotjarReplayRecords = [];
    window._hjSettings = { hjid: 123456, hjsv: 6 };
    window.hj = window.hj || function hj() {
      (window.hj.q = window.hj.q || []).push(arguments);
    };
    function hotjarSessionRecorder(event) {
      window.__hotjarReplayRecords.push({
        type: event.type,
        value: event.target && event.target.value,
      });
    }
    document.addEventListener("input", hotjarSessionRecorder, true);
  `,
};

module.exports = { hotjarFixtureFiles };
