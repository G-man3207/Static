// Shared helpers for Noise-mode tests.
const PROBED_ID = "nngceckbapebfimnlniiiahkandclblb";
const PROBED_OTHER_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const seedNoisePersona = async (extension, origin, id = PROBED_ID) => {
  await extension.serviceWorker.evaluate(
    async ({ origin, id }) => {
      await chrome.storage.local.set({
        noise_enabled: true,
        probe_log: {
          [origin]: {
            idCounts: { [id]: 5 },
            lastUpdated: Date.now(),
            playbook: {
              weeks: [
                {
                  week: 0,
                  idCounts: { [id]: 5 },
                },
              ],
            },
          },
        },
        user_secret: "a".repeat(64),
      });
    },
    { origin, id }
  );
};

const vectorCountsFor = async (extension, origin) => {
  return await extension.serviceWorker.evaluate(async (origin) => {
    const data = await chrome.storage.local.get("probe_log");
    const log = data && data.probe_log;
    const entry = log && log[origin];
    const pb = entry && entry.playbook;
    const weeks = pb && pb.weeks;
    const week = weeks && weeks[0];
    return (week && week.vectorCounts) || {};
  }, origin);
};

module.exports = { PROBED_ID, PROBED_OTHER_ID, seedNoisePersona, vectorCountsFor };
