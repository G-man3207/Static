const RULESET_META = [
  { id: "linkedin", label: "LinkedIn telemetry" },
  { id: "fingerprint_vendors", label: "Fingerprinting / anti-bot" },
  {
    id: "captcha_vendors",
    label: "CAPTCHA vendors",
    warn: "Off by default. Breaks logins on sites using Arkose/FunCAPTCHA (X signup, Roblox, some crypto).",
  },
  { id: "session_replay", label: "Session replay" },
  {
    id: "datadog_rum",
    label: "Datadog RUM",
    warn: "Off by default. Also used for legitimate performance/error monitoring.",
  },
];

const colorForCount = (n) => {
  if (n < 100) return "#888";
  if (n < 1000) return "#d88030";
  return "#c93131";
};

const fmt = (n) => n.toLocaleString();

const fetchRuleCount = async (rulesetId) => {
  try {
    const url = chrome.runtime.getURL(`rules/${rulesetId}.json`);
    const res = await fetch(url);
    const rules = await res.json();
    return Array.isArray(rules) ? rules.length : null;
  } catch {
    return null;
  }
};

const renderDetails = (resp) => {
  const total = resp && typeof resp.total === "number" ? resp.total : 0;
  const cumulative = resp && typeof resp.cumulative === "number" ? resp.cumulative : 0;
  const topIds = resp && Array.isArray(resp.topIds) ? resp.topIds : [];

  const countEl = document.getElementById("count");
  countEl.textContent = fmt(total);
  countEl.style.color = colorForCount(total);

  if (cumulative > 0) {
    document.getElementById("cumulative").textContent =
      fmt(cumulative) + " probes blocked since install";
  }

  const drift = resp && resp.drift;
  const driftEl = document.getElementById("drift");
  if (drift && (drift.level === "changed" || drift.level === "high")) {
    driftEl.textContent =
      drift.level === "high"
        ? "High probe behavior drift on this site"
        : "Probe behavior changed on this site";
    driftEl.hidden = false;
  } else {
    driftEl.hidden = true;
  }

  const topEl = document.getElementById("top-ids");
  topEl.innerHTML = "";
  if (topIds.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No extension-enumeration probes captured on this tab yet.";
    topEl.appendChild(empty);
    return;
  }
  for (const [id, count] of topIds) {
    const li = document.createElement("li");
    const idEl = document.createElement("span");
    idEl.className = "id-text";
    idEl.textContent = id;
    const cEl = document.createElement("span");
    cEl.className = "id-count";
    cEl.textContent = fmt(count);
    li.appendChild(idEl);
    li.appendChild(cEl);
    topEl.appendChild(li);
  }
};

const renderNoiseSection = (resp) => {
  const toggle = document.getElementById("noise-toggle");
  toggle.checked = !!(resp && resp.noiseEnabled);

  toggle.addEventListener("change", async () => {
    const desired = toggle.checked;
    try {
      await chrome.runtime.sendMessage({ type: "static_set_noise", enabled: desired });
      // Push the new state to the active tab's content scripts via activeTab
      // so the current page sees the change without a reload.
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id != null) {
        chrome.tabs.sendMessage(tab.id, { type: "static_persona_update" }).catch(() => {});
      }
    } catch (e) {
      console.error("[Static] noise toggle failed", e);
      toggle.checked = !desired;
    }
  });

  const originsLogged = resp && typeof resp.originsLogged === "number" ? resp.originsLogged : 0;
  const viewLog = document.getElementById("view-log");
  const stats = document.getElementById("noise-stats");
  if (originsLogged > 0) {
    stats.textContent =
      fmt(originsLogged) + " origin" + (originsLogged === 1 ? "" : "s") + " logged";
    viewLog.hidden = false;
    viewLog.addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("log.html") });
      window.close();
    });
  }
};

const renderRulesets = (enabledArr, counts) => {
  const enabled = new Set(enabledArr);
  const container = document.getElementById("rulesets");
  RULESET_META.forEach((meta, i) => {
    const row = document.createElement("div");
    row.className = "ruleset";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = "rs_" + meta.id;
    input.checked = enabled.has(meta.id);

    const label = document.createElement("label");
    label.htmlFor = input.id;
    label.textContent = meta.label;
    const c = counts[i];
    if (typeof c === "number") {
      const countSpan = document.createElement("span");
      countSpan.className = "rule-count";
      countSpan.textContent = "(" + c + ")";
      label.appendChild(countSpan);
    }

    input.addEventListener("change", async () => {
      const payload = input.checked
        ? { enableRulesetIds: [meta.id] }
        : { disableRulesetIds: [meta.id] };
      try {
        await chrome.declarativeNetRequest.updateEnabledRulesets(payload);
      } catch (e) {
        console.error("[Static] ruleset toggle failed", meta.id, e);
        input.checked = !input.checked;
      }
    });

    row.appendChild(input);
    row.appendChild(label);
    container.appendChild(row);

    if (meta.warn) {
      const warnEl = document.createElement("div");
      warnEl.className = "ruleset-warn";
      warnEl.textContent = meta.warn;
      container.appendChild(warnEl);
    }
  });
};

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [null]);
  const detailsPromise = tab
    ? chrome.runtime.sendMessage({ type: "static_get_details", tabId: tab.id }).catch(() => null)
    : Promise.resolve(null);
  const enabledPromise = chrome.declarativeNetRequest.getEnabledRulesets().catch(() => []);
  const countsPromise = Promise.all(RULESET_META.map((m) => fetchRuleCount(m.id)));

  const [details, enabledArr, counts] = await Promise.all([
    detailsPromise,
    enabledPromise,
    countsPromise,
  ]);

  renderDetails(details);
  renderNoiseSection(details);
  renderRulesets(enabledArr, counts);
})();
