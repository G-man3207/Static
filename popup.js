/* eslint-disable max-lines -- popup rendering and local control wiring are kept together */
const RULESET_META = [
  {
    id: "linkedin",
    group: "Site telemetry",
    label: "LinkedIn telemetry",
    help: "Blocks LinkedIn probe, sensor, metrics, conversion, ad, and marketing collection endpoints.",
  },
  {
    id: "fingerprint_vendors",
    group: "Fingerprinting and access checks",
    label: "Fingerprinting and anti-bot",
    help: "Blocks known client-side fingerprinting and anti-bot vendor endpoints at the network layer.",
  },
  {
    id: "captcha_vendors",
    group: "Fingerprinting and access checks",
    label: "CAPTCHA and device checks",
    help: "Blocks Arkose/FunCAPTCHA endpoints. Leave this off unless you accept login and challenge breakage.",
    warn: "Off by default. Breaks logins on sites using Arkose/FunCAPTCHA (X signup, Roblox, some crypto).",
  },
  {
    id: "session_replay",
    group: "Replay and monitoring",
    label: "Session replay recorders",
    help: "Blocks known session-replay vendor assets and ingest hosts before page scripts can use them.",
  },
  {
    id: "datadog_rum",
    group: "Replay and monitoring",
    label: "Datadog browser monitoring",
    help: "Blocks Datadog browser RUM collection. Keep off if you want legitimate site monitoring to work.",
    warn: "Off by default. Also used for legitimate performance/error monitoring.",
  },
];

const colorForCount = (n) => {
  if (n < 100) return "#888";
  if (n < 1000) return "#d88030";
  return "#c93131";
};

const fmt = (n) => n.toLocaleString();
const pct = (n) => `${Math.round((n || 0) * 100)}%`;
const replayState = {
  replayDetected: false,
  replayMode: "off",
  sessionReplayBlocking: false,
};
const fingerprintState = {
  fingerprintMode: "off",
};
const boundHelpTips = new WeakSet();
let activeHelpTip = null;
let activeTabId = null;
let helpTipPopover = null;

const tooltipMargin = 10;
const tooltipOffset = 6;

const ensureHelpTipPopover = () => {
  if (helpTipPopover) return helpTipPopover;
  helpTipPopover = document.createElement("div");
  helpTipPopover.id = "help-tip-popover";
  helpTipPopover.className = "help-tip-popover";
  helpTipPopover.setAttribute("role", "tooltip");
  helpTipPopover.hidden = true;
  document.body.appendChild(helpTipPopover);
  return helpTipPopover;
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const positionHelpTipPopover = (trigger) => {
  const popover = ensureHelpTipPopover();
  const triggerRect = trigger.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
  const maxLeft = Math.max(tooltipMargin, viewportWidth - popoverRect.width - tooltipMargin);
  const maxTop = Math.max(tooltipMargin, viewportHeight - popoverRect.height - tooltipMargin);
  const centeredLeft = triggerRect.left + triggerRect.width / 2 - popoverRect.width / 2;
  let top = triggerRect.bottom + tooltipOffset;
  const hasSpaceAbove = triggerRect.top - popoverRect.height - tooltipOffset >= tooltipMargin;

  popover.classList.remove("above");
  if (top + popoverRect.height + tooltipMargin > viewportHeight && hasSpaceAbove) {
    top = triggerRect.top - popoverRect.height - tooltipOffset;
    popover.classList.add("above");
  }

  popover.style.left = `${Math.round(clamp(centeredLeft, tooltipMargin, maxLeft))}px`;
  popover.style.top = `${Math.round(clamp(top, tooltipMargin, maxTop))}px`;
};

const showHelpTip = (trigger) => {
  if (!trigger.dataset.tip) return;
  const popover = ensureHelpTipPopover();
  activeHelpTip = trigger;
  popover.textContent = trigger.dataset.tip;
  popover.hidden = false;
  popover.classList.remove("is-visible");
  positionHelpTipPopover(trigger);
  requestAnimationFrame(() => {
    if (activeHelpTip === trigger) popover.classList.add("is-visible");
  });
};

const hideHelpTip = (trigger) => {
  if (trigger && activeHelpTip !== trigger) return;
  activeHelpTip = null;
  if (!helpTipPopover) return;
  helpTipPopover.classList.remove("is-visible");
  helpTipPopover.hidden = true;
};

const bindHelpTip = (tip) => {
  if (boundHelpTips.has(tip)) return;
  boundHelpTips.add(tip);
  tip.addEventListener("pointerenter", () => showHelpTip(tip));
  tip.addEventListener("focus", () => showHelpTip(tip));
  tip.addEventListener("pointerleave", () => {
    if (document.activeElement !== tip) hideHelpTip(tip);
  });
  tip.addEventListener("blur", () => hideHelpTip(tip));
  tip.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideHelpTip(tip);
  });
};

const setupHelpTips = () => {
  document.querySelectorAll(".help-tip").forEach(bindHelpTip);
};

window.addEventListener("resize", () => {
  if (activeHelpTip) positionHelpTipPopover(activeHelpTip);
});
window.addEventListener(
  "scroll",
  () => {
    if (activeHelpTip) positionHelpTipPopover(activeHelpTip);
  },
  true
);

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

const pushConfigUpdateToActiveTab = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: "static_persona_update" }).catch(() => {});
  }
};

const setChecked = (input, checked) => {
  input.checked = checked;
};

const setSelectValue = (select, value) => {
  select.value = value;
};

const setReplayMode = (mode) => {
  replayState.replayMode = mode;
  renderReplayIndicators();
};

const renderCumulative = (cumulative) => {
  if (cumulative > 0) {
    document.getElementById("cumulative").textContent =
      `${fmt(cumulative)} probes blocked since install`;
  }
};

const renderDriftNotice = (drift) => {
  const driftEl = document.getElementById("drift");
  if (drift && (drift.level === "changed" || drift.level === "high")) {
    driftEl.textContent =
      drift.level === "high"
        ? "High probe behavior drift on this site"
        : "Probe behavior changed on this site";
    driftEl.hidden = false;
    return;
  }
  driftEl.hidden = true;
};

const renderAdaptiveNotice = (resp) => {
  const adaptiveEl = document.getElementById("adaptive");
  if (!(resp && resp.adaptiveDetected)) {
    adaptiveEl.hidden = true;
    return;
  }
  const categories = Object.entries(resp.adaptiveCategories || {})
    .sort((a, b) => b[1] - a[1])
    .map(([category]) => category);
  adaptiveEl.textContent = `Adaptive signals observed${
    categories.length ? `: ${categories.slice(0, 2).join(", ")}` : ""
  }`;
  adaptiveEl.hidden = false;
};

const adConfidenceLabel = (confidence) => {
  if (confidence === "high") return "High";
  if (confidence === "likely") return "Likely";
  return "Learning";
};

const renderAdNotice = (resp) => {
  const adEl = document.getElementById("ad-observed");
  const ad = resp && resp.ad;
  if (!(ad && ad.observed)) {
    adEl.hidden = true;
    return;
  }
  adEl.textContent = `Ad behavior observed: ${adConfidenceLabel(ad.confidence)}`;
  adEl.hidden = false;
};

const renderTopIds = (topIds) => {
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

const formatCountEntries = (entries) => {
  if (!Array.isArray(entries) || entries.length === 0) return "none";
  return entries.map(([name, count]) => `${name} ${fmt(count)}`).join(", ");
};

const formatAdReasons = (reasons) => {
  if (!Array.isArray(reasons) || reasons.length === 0) return "none observed";
  return reasons
    .slice(0, 5)
    .map(
      (reason) =>
        `${reason.token} ${fmt(reason.count)}${reason.score ? ` (score ${fmt(reason.score)})` : ""}`
    )
    .join(", ");
};

const formatPlaybookEntries = (entries, valueKey) => {
  if (!Array.isArray(entries) || entries.length === 0) return "none learned";
  return entries
    .slice(0, 4)
    .map((entry) => {
      const value = entry[valueKey] || entry.value || "entry";
      const score = typeof entry.score === "number" ? `score ${fmt(entry.score)}` : "score 0";
      const hits = entry.hits ? `, ${fmt(entry.hits)} hit${entry.hits === 1 ? "" : "s"}` : "";
      const diagnostic = entry.diagnosticOnly ? ", diagnostics-only" : "";
      return `${value} (${score}${hits}${diagnostic})`;
    })
    .join(", ");
};

const addDiagnosticRow = (container, key, value) => {
  const row = document.createElement("div");
  row.className = "diagnostic-row";
  const keyEl = document.createElement("div");
  keyEl.className = "diagnostic-key";
  keyEl.textContent = key;
  const valueEl = document.createElement("div");
  valueEl.className = "diagnostic-value";
  valueEl.textContent = value;
  row.appendChild(keyEl);
  row.appendChild(valueEl);
  container.appendChild(row);
};

const personaStatusText = (diagnostics) => {
  if (!diagnostics) return "No origin probe log yet";
  if (!diagnostics.noiseEnabled) return "Noise off; no decoys claimed";
  if (!diagnostics.armed) return "Cold start; no eligible decoys yet";
  return `${fmt(diagnostics.selectedCount)} decoy${diagnostics.selectedCount === 1 ? "" : "s"} armed`;
};

const addNoiseDiagnosticRows = (box, diagnostics) => {
  if (!diagnostics) return;
  addDiagnosticRow(
    box,
    "Noise pool",
    `${fmt(diagnostics.eligibleTotal)} eligible (${fmt(diagnostics.eligibleKnown)} known, ${fmt(
      diagnostics.eligibleUnknown
    )} unknown), target ${fmt(diagnostics.targetMin)}-${fmt(diagnostics.targetMax)}`
  );
  addDiagnosticRow(
    box,
    "ID pressure",
    `${fmt(diagnostics.uniqueIds)} unique, ${fmt(diagnostics.repeatedIds)} repeated, ${pct(
      diagnostics.oneShotPressure
    )} one-shot`
  );
  if (diagnostics.selectedIds && diagnostics.selectedIds.length > 0) {
    addDiagnosticRow(box, "Decoy IDs", diagnostics.selectedIds.join(", "));
  }
};

const addProbePlaybookRows = (box, playbook) => {
  if (!playbook) return;
  addDiagnosticRow(box, "Latest week", `${playbook.week}; ${fmt(playbook.total)} probes`);
  addDiagnosticRow(box, "Vectors", formatCountEntries(playbook.vectors));
  addDiagnosticRow(box, "Paths", formatCountEntries(playbook.pathKinds));
};

const addAdaptivePowerRow = (box, resp) => {
  if (!resp.adaptiveDetected) return;
  const categories = Object.entries(resp.adaptiveCategories || {})
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => `${category} ${fmt(count)}`);
  addDiagnosticRow(
    box,
    "Adaptive",
    `score ${fmt(resp.adaptiveScore || 0)}${categories.length ? `; ${categories.join(", ")}` : ""}`
  );
};

const addAdPowerRow = (box, resp) => {
  if (!(resp.ad && resp.ad.observed)) return;
  addDiagnosticRow(
    box,
    "Ads",
    `${adConfidenceLabel(resp.ad.confidence)}; score ${fmt(resp.ad.score || 0)}; ${formatAdReasons(
      resp.ad.reasons
    )}`
  );
};

const renderPowerDiagnostics = (resp) => {
  const box = document.getElementById("power-diagnostics");
  box.innerHTML = "";

  if (!(resp && resp.origin)) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No current-site diagnostics available on this page.";
    box.appendChild(empty);
    return;
  }

  const diagnostics = resp.noiseDiagnostics;
  const playbook = resp.playbook;
  addDiagnosticRow(box, "Origin", resp.origin);
  addDiagnosticRow(box, "Persona", personaStatusText(diagnostics));
  addNoiseDiagnosticRows(box, diagnostics);
  addProbePlaybookRows(box, playbook);
  addAdaptivePowerRow(box, resp);
  addAdPowerRow(box, resp);
  if (resp.fingerprintMode && resp.fingerprintMode !== "off") {
    addDiagnosticRow(box, "Signal poison", resp.fingerprintMode);
  }
};

const currentAdState = (resp) => (resp && resp.ad ? resp.ad : null);

const refreshDetails = async () => {
  if (typeof activeTabId !== "number") return null;
  try {
    const details = await chrome.runtime.sendMessage({
      tabId: activeTabId,
      type: "static_get_details",
    });
    renderDetails(details);
    renderAdDiagnostics(details);
    return details;
  } catch {
    return null;
  }
};

const renderAdControls = (container, resp) => {
  const ad = currentAdState(resp);
  const origin = resp && resp.origin;
  const controls = document.createElement("div");
  controls.className = "ad-controls";

  const row = document.createElement("label");
  row.className = "ad-control-row";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.id = "ad-cleanup-disabled";
  checkbox.checked = !!(ad && ad.cleanupDisabled);
  checkbox.disabled = !origin;
  const label = document.createElement("span");
  label.textContent = "Disable ad cleanup for this site";
  row.appendChild(checkbox);
  row.appendChild(label);
  controls.appendChild(row);

  const clear = document.createElement("button");
  clear.className = "ad-clear-btn";
  clear.id = "clear-ad-site-data";
  clear.type = "button";
  clear.textContent = "Clear learned ad data for this site";
  clear.disabled = !(origin && ad && (ad.observed || ad.playbook.lastUpdated));
  controls.appendChild(clear);

  checkbox.addEventListener("change", () => {
    const desired = checkbox.checked;
    checkbox.disabled = true;
    chrome.runtime
      .sendMessage({
        disabled: desired,
        origin,
        type: "static_set_ad_cleanup_disabled",
      })
      .then((saved) => {
        checkbox.checked = !!(saved && saved.prefs && saved.prefs.cleanupDisabled);
        return refreshDetails();
      })
      .catch((e) => {
        console.error("[Static] ad cleanup preference update failed", e);
        checkbox.checked = !desired;
      })
      .finally(() => {
        checkbox.disabled = false;
      });
  });

  clear.addEventListener("click", async () => {
    clear.disabled = true;
    try {
      await chrome.runtime.sendMessage({ origin, type: "static_clear_ad_site_data" });
      await refreshDetails();
    } catch (e) {
      console.error("[Static] clear ad site data failed", e);
      clear.disabled = false;
    }
  });

  container.appendChild(controls);
};

const renderAdDiagnostics = (resp) => {
  const box = document.getElementById("ad-diagnostics");
  box.innerHTML = "";
  const ad = currentAdState(resp);

  if (!(resp && resp.origin)) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No current-site ad diagnostics available on this page.";
    box.appendChild(empty);
    renderAdControls(box, resp);
    return;
  }

  addDiagnosticRow(box, "Origin", resp.origin);
  addDiagnosticRow(box, "Confidence", adConfidenceLabel(ad && ad.confidence));
  addDiagnosticRow(box, "Score", fmt((ad && ad.score) || 0));
  addDiagnosticRow(box, "Reasons", formatAdReasons(ad && ad.reasons));
  const playbook = ad && ad.playbook ? ad.playbook : {};
  addDiagnosticRow(
    box,
    "Endpoints",
    formatCountEntries(ad && Array.isArray(ad.endpoints) ? ad.endpoints : [])
  );
  addDiagnosticRow(box, "Cosmetic", formatPlaybookEntries(playbook.cosmetic, "value"));
  addDiagnosticRow(box, "Network", formatPlaybookEntries(playbook.network, "path"));
  addDiagnosticRow(box, "Scripts", formatPlaybookEntries(playbook.scripts, "value"));
  addDiagnosticRow(
    box,
    "Cleanup",
    ad && ad.cleanupDisabled ? "disabled for this site" : "not disabled for this site"
  );
  renderAdControls(box, resp);
};

const renderDetails = (resp) => {
  const total = resp && typeof resp.total === "number" ? resp.total : 0;
  const cumulative = resp && typeof resp.cumulative === "number" ? resp.cumulative : 0;
  const topIds = resp && Array.isArray(resp.topIds) ? resp.topIds : [];

  const countEl = document.getElementById("count");
  countEl.textContent = fmt(total);
  countEl.style.color = colorForCount(total);
  renderCumulative(cumulative);
  renderDriftNotice(resp && resp.drift);
  renderAdaptiveNotice(resp);
  renderAdNotice(resp);
  renderTopIds(topIds);
  renderPowerDiagnostics(resp);
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
      await pushConfigUpdateToActiveTab();
    } catch (e) {
      console.error("[Static] noise toggle failed", e);
      setChecked(toggle, !desired);
    }
  });

  const originsLogged = resp && typeof resp.originsLogged === "number" ? resp.originsLogged : 0;
  const viewLog = document.getElementById("view-log");
  const stats = document.getElementById("noise-stats");
  if (originsLogged > 0) {
    stats.textContent = `${fmt(originsLogged)} origin${originsLogged === 1 ? "" : "s"} logged`;
    viewLog.hidden = false;
    viewLog.addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("log.html") });
      window.close();
    });
  }
};

const renderDiagnosticsSection = (resp) => {
  const toggle = document.getElementById("diagnostics-toggle");
  toggle.checked = !!(resp && resp.diagnosticsMode);

  toggle.addEventListener("change", async () => {
    const desired = toggle.checked;
    try {
      const saved = await chrome.runtime.sendMessage({
        enabled: desired,
        type: "static_set_diagnostics",
      });
      setChecked(toggle, !!(saved && saved.enabled));
      await pushConfigUpdateToActiveTab();
    } catch (e) {
      console.error("[Static] diagnostics toggle failed", e);
      setChecked(toggle, !desired);
    }
  });
};

const renderReplaySection = (resp) => {
  const select = document.getElementById("replay-mode");
  const detected = document.getElementById("replay-detected");
  const allowed = new Set(["off", "mask", "noise", "chaos"]);
  replayState.replayMode = resp && allowed.has(resp.replayMode) ? resp.replayMode : "off";
  replayState.replayDetected = !!(resp && resp.replayDetected);
  select.value = replayState.replayMode;
  detected.hidden = !replayState.replayDetected;
  renderReplayIndicators();

  select.addEventListener("change", async () => {
    const desired = allowed.has(select.value) ? select.value : "off";
    const previous = replayState.replayMode;
    try {
      const saved = await chrome.runtime.sendMessage({ type: "static_set_replay", mode: desired });
      const next = saved && allowed.has(saved.mode) ? saved.mode : desired;
      setSelectValue(select, next);
      setReplayMode(next);
      await pushConfigUpdateToActiveTab();
    } catch (e) {
      console.error("[Static] replay mode update failed", e);
      setSelectValue(select, previous);
      setReplayMode(previous);
    }
  });
};

const setFingerprintMode = (mode) => {
  fingerprintState.fingerprintMode = mode;
};

const renderFingerprintSection = (resp) => {
  const select = document.getElementById("fingerprint-mode");
  const allowed = new Set(["off", "mask"]);
  fingerprintState.fingerprintMode =
    resp && allowed.has(resp.fingerprintMode) ? resp.fingerprintMode : "off";
  select.value = fingerprintState.fingerprintMode;

  select.addEventListener("change", async () => {
    const desired = allowed.has(select.value) ? select.value : "off";
    const previous = fingerprintState.fingerprintMode;
    try {
      const saved = await chrome.runtime.sendMessage({
        mode: desired,
        type: "static_set_fingerprint",
      });
      const next = saved && allowed.has(saved.mode) ? saved.mode : desired;
      setSelectValue(select, next);
      setFingerprintMode(next);
      await pushConfigUpdateToActiveTab();
    } catch (e) {
      console.error("[Static] fingerprint mode update failed", e);
      setSelectValue(select, previous);
      setFingerprintMode(previous);
    }
  });
};

const addReplayPill = (container, text, kind) => {
  const pill = document.createElement("span");
  pill.className = `replay-pill ${kind}`;
  pill.textContent = text;
  container.appendChild(pill);
};

const addHelpTip = (container, id, text) => {
  if (!text) return null;
  const textId = `${id}_text`;
  const tip = document.createElement("button");
  tip.className = "help-tip";
  tip.type = "button";
  tip.id = id;
  tip.dataset.tip = text;
  tip.setAttribute("aria-label", "Details");
  tip.setAttribute("aria-describedby", textId);
  tip.textContent = "?";
  const hiddenText = document.createElement("span");
  hiddenText.className = "sr-only";
  hiddenText.id = textId;
  hiddenText.textContent = text;
  container.appendChild(tip);
  container.appendChild(hiddenText);
  return textId;
};

const addRulesetGroup = (container, title) => {
  const group = document.createElement("div");
  group.className = "ruleset-group";
  const heading = document.createElement("div");
  heading.className = "ruleset-group-title";
  heading.textContent = title;
  group.appendChild(heading);
  container.appendChild(group);
  return group;
};

const replayModeLabel = (mode) => {
  if (mode === "mask") return "Mask";
  if (mode === "noise") return "Noise";
  if (mode === "chaos") return "Chaos";
  return "Off";
};

const renderReplayIndicators = () => {
  const list = document.getElementById("replay-status-list");
  list.innerHTML = "";

  if (replayState.sessionReplayBlocking) {
    addReplayPill(list, "Replay vendor blocking on", "blocking");
  }

  if (replayState.replayMode !== "off") {
    const label = replayModeLabel(replayState.replayMode);
    addReplayPill(
      list,
      replayState.replayDetected ? `${label} active on this site` : `${label} poisoning armed`,
      replayState.replayDetected ? "active" : "armed"
    );
  }

  list.hidden = !list.childElementCount;
};

const renderRulesets = (enabledArr, counts) => {
  const enabled = new Set(enabledArr);
  replayState.sessionReplayBlocking = enabled.has("session_replay");
  renderReplayIndicators();
  const container = document.getElementById("rulesets");
  container.innerHTML = "";
  let currentGroup = null;
  let groupContainer = container;
  RULESET_META.forEach((meta, i) => {
    if (meta.group !== currentGroup) {
      currentGroup = meta.group;
      groupContainer = addRulesetGroup(container, currentGroup);
    }

    const row = document.createElement("div");
    row.className = "ruleset";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = `rs_${meta.id}`;
    input.checked = enabled.has(meta.id);

    const label = document.createElement("label");
    label.htmlFor = input.id;
    label.textContent = meta.label;
    const c = counts[i];
    if (typeof c === "number") {
      const countSpan = document.createElement("span");
      countSpan.className = "rule-count";
      countSpan.textContent = `(${c})`;
      label.appendChild(countSpan);
    }
    const textWrap = document.createElement("div");
    textWrap.className = "ruleset-text";
    textWrap.appendChild(label);
    const helpTextId = addHelpTip(textWrap, `${input.id}_help`, meta.help);
    if (helpTextId) {
      input.setAttribute("aria-describedby", helpTextId);
    }

    input.addEventListener("change", async () => {
      const payload = input.checked
        ? { enableRulesetIds: [meta.id] }
        : { disableRulesetIds: [meta.id] };
      try {
        await chrome.declarativeNetRequest.updateEnabledRulesets(payload);
        if (meta.id === "session_replay") {
          replayState.sessionReplayBlocking = input.checked;
          renderReplayIndicators();
        }
      } catch (e) {
        console.error("[Static] ruleset toggle failed", meta.id, e);
        input.checked = !input.checked;
        if (meta.id === "session_replay") {
          replayState.sessionReplayBlocking = input.checked;
          renderReplayIndicators();
        }
      }
    });

    row.appendChild(input);
    row.appendChild(textWrap);
    groupContainer.appendChild(row);

    if (meta.warn) {
      const warnEl = document.createElement("div");
      warnEl.className = "ruleset-warn";
      warnEl.textContent = meta.warn;
      groupContainer.appendChild(warnEl);
    }
  });
};

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [null]);
  activeTabId = tab && typeof tab.id === "number" ? tab.id : null;
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
  renderAdDiagnostics(details);
  renderNoiseSection(details);
  renderDiagnosticsSection(details);
  renderFingerprintSection(details);
  renderReplaySection(details);
  renderRulesets(enabledArr, counts);
  setupHelpTips();
})();
