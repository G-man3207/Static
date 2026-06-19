/* eslint-disable max-lines -- popup rendering and local control wiring are kept together */
const RULESET_META = [
  {
    id: "fingerprint_vendors",
    group: "Fingerprint checks",
    label: "Fingerprinting and anti-bot",
    help: "Blocks known client-side fingerprinting and anti-bot vendor endpoints at the network layer.",
  },
  {
    id: "captcha_vendors",
    group: "Fingerprint checks",
    label: "CAPTCHA and device checks",
    help: "Blocks Arkose/FunCAPTCHA endpoints. Leave this off unless you accept login and challenge breakage.",
    warn: "Off by default. Breaks logins on sites using Arkose/FunCAPTCHA (X signup, Roblox, some crypto).",
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
};
const fingerprintState = {
  fingerprintMode: "off",
};
const PROFILE_UA_HINTS = [
  "architecture",
  "bitness",
  "model",
  "platform",
  "platformVersion",
  "uaFullVersion",
  "wow64",
];
const boundHelpTips = new WeakSet();
let activeHelpTip = null;
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

const compatibilityDetailText = (warning) => {
  const kinds = new Set((warning && warning.kinds ? warning.kinds : []).map(([kind]) => kind));
  if (kinds.has("unhandled_blocked_fetch")) {
    return "A blocked extension-probe fetch became an unhandled page error. If the site looks broken, pausing Static here is the safest quick fix.";
  }
  return "A recent Static action was followed by a page error. If the site looks broken, try pausing Static here.";
};

const pauseSiteAndReload = async (origin, button) => {
  if (!origin) return;
  button.disabled = true;
  try {
    await chrome.runtime.sendMessage({
      disabled: true,
      origin,
      type: "static_set_site_disabled",
    });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id != null) await chrome.tabs.reload(tab.id);
    window.close();
  } catch (e) {
    console.error("[Static] compatibility pause failed", e);
    button.disabled = false;
  }
};

const renderCompatibilityNotice = (resp) => {
  const compatEl = document.getElementById("compat");
  const detailEl = document.getElementById("compat-detail");
  const pauseButton = document.getElementById("compat-pause");
  const warning = resp && resp.compatWarning;
  if (!warning || resp.disabled || !resp.origin) {
    compatEl.hidden = true;
    pauseButton.onclick = null;
    return;
  }
  detailEl.textContent = compatibilityDetailText(warning);
  pauseButton.disabled = false;
  pauseButton.onclick = () => pauseSiteAndReload(resp.origin, pauseButton);
  compatEl.hidden = false;
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

const textOrUnknown = (value) => {
  if (value === 0) return "0";
  const text = String(value ?? "").trim();
  return text || "unknown";
};

const formatBytes = (bytes) => {
  const number = Number(bytes);
  if (!Number.isFinite(number) || number <= 0) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = number;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const decimals = value >= 10 || unit === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unit]}`;
};

const readWebglProfile = () => {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!gl) return null;
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      renderer: debug
        ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER),
      vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    };
  } catch {
    return null;
  }
};

const collectUaHints = async () => {
  const uaData = navigator.userAgentData;
  if (!uaData || typeof uaData !== "object") return {};
  const base = typeof uaData.toJSON === "function" ? uaData.toJSON() : {};
  if (typeof uaData.getHighEntropyValues !== "function") return base;
  try {
    return {
      ...base,
      ...(await uaData.getHighEntropyValues(PROFILE_UA_HINTS)),
    };
  } catch {
    return base;
  }
};

const collectStorageQuota = async () => {
  try {
    if (!navigator.storage || typeof navigator.storage.estimate !== "function") return null;
    const estimate = await navigator.storage.estimate();
    return estimate && typeof estimate.quota === "number" ? estimate.quota : null;
  } catch {
    return null;
  }
};

const collectBatteryProfile = async () => {
  try {
    if (typeof navigator.getBattery !== "function") return null;
    const battery = await navigator.getBattery();
    return {
      charging: !!battery.charging,
      level: typeof battery.level === "number" ? Math.round(battery.level * 100) : null,
    };
  } catch {
    return null;
  }
};

const connectionSnapshot = () => {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!connection) return null;
  return {
    downlink: connection.downlink,
    effectiveType: connection.effectiveType,
    rtt: connection.rtt,
    saveData: connection.saveData,
    type: connection.type,
  };
};

const collectLocalBrowserProfile = async () => {
  const [uaHints, storageQuota, battery] = await Promise.all([
    collectUaHints(),
    collectStorageQuota(),
    collectBatteryProfile(),
  ]);
  const dateOptions = Intl.DateTimeFormat().resolvedOptions();
  return {
    architecture: uaHints.architecture,
    battery,
    bitness: uaHints.bitness,
    connection: connectionSnapshot(),
    deviceMemory: navigator.deviceMemory,
    hardwareConcurrency: navigator.hardwareConcurrency,
    language: navigator.language,
    languages: Array.from(navigator.languages || []),
    locale: dateOptions.locale,
    platform: navigator.platform || uaHints.platform,
    screen: {
      availHeight: screen.availHeight,
      availWidth: screen.availWidth,
      colorDepth: screen.colorDepth,
      devicePixelRatio: window.devicePixelRatio,
      height: screen.height,
      pixelDepth: screen.pixelDepth,
      width: screen.width,
    },
    storageQuota,
    timeZone: dateOptions.timeZone,
    uaDataPlatform: uaHints.platform,
    userAgent: navigator.userAgent,
    webgl: readWebglProfile(),
  };
};

const maskedUserAgentForPersona = (personaData) => {
  const source = String(navigator.userAgent || "");
  const uaOs = String(personaData.uaOs || "Windows NT 10.0; Win64; x64");
  if (source.includes("(") && source.includes(")")) {
    return source.replace(/\([^)]*\)/, `(${uaOs})`);
  }
  return `Mozilla/5.0 (${uaOs}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36`;
};

const profileFromPersona = (personaData) => {
  const languages = Array.isArray(personaData.languages) ? personaData.languages : [];
  return {
    architecture: personaData.architecture,
    battery: { charging: true, level: 100 },
    bitness: personaData.bitness,
    connection: personaData.connection,
    deviceMemory: personaData.deviceMemory,
    hardwareConcurrency: personaData.hardwareConcurrency,
    language: languages[0],
    languages,
    locale: Intl.DateTimeFormat().resolvedOptions().locale || languages[0],
    platform: personaData.platform,
    screen: personaData.screen,
    storageQuota: personaData.storageQuota,
    timeZone: personaData.timeZone,
    uaDataPlatform: personaData.uaDataPlatform,
    userAgent: maskedUserAgentForPersona(personaData),
    webgl: {
      renderer: personaData.webglRenderer,
      vendor: personaData.webglVendor,
    },
  };
};

const formatLanguages = (languages) => {
  if (Array.isArray(languages) && languages.length > 0) return languages.join(", ");
  return textOrUnknown(languages);
};

const formatScreenProfile = (profile) => {
  if (!profile) return "unknown";
  const size = `${textOrUnknown(profile.width)}×${textOrUnknown(profile.height)}`;
  const dpr = profile.devicePixelRatio ? ` @ ${profile.devicePixelRatio}x` : "";
  const avail =
    profile.availWidth && profile.availHeight
      ? `; avail ${profile.availWidth}×${profile.availHeight}`
      : "";
  const depth = profile.colorDepth ? `; ${profile.colorDepth}-bit color` : "";
  return `${size}${dpr}${avail}${depth}`;
};

const formatPlatformProfile = (profile) => {
  const archBits = [profile.architecture, profile.bitness].filter(Boolean).join("/");
  const values = [profile.platform, profile.uaDataPlatform, archBits].filter(Boolean);
  return values.length ? values.join(" · ") : "unknown";
};

const formatHardwareProfile = (profile) => {
  const values = [];
  if (profile.hardwareConcurrency) values.push(`${profile.hardwareConcurrency} CPU threads`);
  if (profile.deviceMemory) values.push(`${profile.deviceMemory} GB RAM bucket`);
  return values.length ? values.join(" / ") : "unknown";
};

const formatConnectionProfile = (connection) => {
  if (!connection) return "unknown";
  const values = [];
  if (connection.effectiveType) values.push(connection.effectiveType);
  if (connection.type) values.push(connection.type);
  if (typeof connection.downlink === "number") values.push(`${connection.downlink} Mbps`);
  if (typeof connection.rtt === "number") values.push(`${connection.rtt} ms RTT`);
  if (connection.saveData) values.push("save-data");
  return values.length ? values.join(", ") : "unknown";
};

const formatBatteryProfile = (battery) => {
  if (!battery) return "unknown";
  const values = [];
  if (typeof battery.level === "number") values.push(`${battery.level}%`);
  values.push(battery.charging ? "charging" : "not charging");
  return values.join(", ");
};

const formatWebglProfile = (webgl) => {
  if (!webgl) return "unavailable";
  const values = [webgl.vendor, webgl.renderer].filter(Boolean);
  return values.length ? values.join(" / ") : "unavailable";
};

const exposedProfileStateFor = (resp, usesPersona) => {
  if (resp && resp.disabled) {
    return {
      className: "profile-summary paused",
      label: "Paused here — browser defaults exposed",
      note: "Static is paused on this site, so the page sees your unpoisoned JavaScript-visible profile.",
    };
  }
  if (usesPersona) {
    return {
      className: "profile-summary",
      label: "Poisoned per-site persona exposed",
      note: "Device signal poisoning is active here. These are the stable JavaScript-visible values Static presents to this origin. Network request headers may still differ by browser policy.",
    };
  }
  if (resp && resp.fingerprintMode === "mask") {
    return {
      className: "profile-summary warning",
      label: "Poisoning armed — no page persona available",
      note: "Open Static from a regular web page to show that site's generated persona. This fallback shows the extension page's browser-visible defaults.",
    };
  }
  return {
    className: "profile-summary warning",
    label: "Browser-default profile exposed",
    note: "These are JavaScript-visible signals. Static does not claim to rewrite every network request header or browser Client Hint.",
  };
};

const profileRows = (profile) => [
  ["User agent", profile.userAgent],
  ["Platform", formatPlatformProfile(profile)],
  [
    "Locale",
    `${textOrUnknown(profile.locale || profile.language)}; ${formatLanguages(profile.languages)}`,
  ],
  ["Timezone", profile.timeZone],
  ["Screen", formatScreenProfile(profile.screen)],
  ["CPU / memory", formatHardwareProfile(profile)],
  ["WebGL", formatWebglProfile(profile.webgl)],
  ["Network", formatConnectionProfile(profile.connection)],
  ["Storage quota", formatBytes(profile.storageQuota)],
  ["Battery", formatBatteryProfile(profile.battery)],
];

const renderExposedProfile = async (resp) => {
  const box = document.getElementById("exposed-profile");
  const summary = document.getElementById("profile-summary");
  const note = document.getElementById("profile-note");
  box.innerHTML = "";
  try {
    const usesPersona = !!(resp && resp.fingerprintPersona && !resp.disabled);
    const profile = usesPersona
      ? profileFromPersona(resp.fingerprintPersona)
      : await collectLocalBrowserProfile();
    const state = exposedProfileStateFor(resp, usesPersona);
    summary.className = state.className;
    summary.textContent = state.label;
    note.textContent = state.note;
    for (const [key, value] of profileRows(profile)) {
      addDiagnosticRow(box, key, textOrUnknown(value));
    }
  } catch {
    summary.className = "profile-summary paused";
    summary.textContent = "Profile unavailable";
    note.textContent = "Static could not read this browser profile from the popup context.";
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No exposed profile snapshot available.";
    box.appendChild(empty);
  }
};

const personaStatusText = (diagnostics) => {
  if (!diagnostics) return "No origin probe log yet";
  if (!diagnostics.noiseEnabled) return "Noise off; no decoys claimed";
  if (!diagnostics.armed) return "Cold start; no eligible decoys yet";
  return `${fmt(diagnostics.selectedCount)} decoy${diagnostics.selectedCount === 1 ? "" : "s"} armed`;
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
  if (diagnostics) {
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
  }
  if (playbook) {
    addDiagnosticRow(box, "Latest week", `${playbook.week}; ${fmt(playbook.total)} probes`);
    addDiagnosticRow(box, "Vectors", formatCountEntries(playbook.vectors));
    addDiagnosticRow(box, "Paths", formatCountEntries(playbook.pathKinds));
  }
  if (resp.adaptiveDetected) {
    const categories = Object.entries(resp.adaptiveCategories || {})
      .sort((a, b) => b[1] - a[1])
      .map(([category, count]) => `${category} ${fmt(count)}`);
    addDiagnosticRow(
      box,
      "Adaptive",
      `score ${fmt(resp.adaptiveScore || 0)}${categories.length ? `; ${categories.join(", ")}` : ""}`
    );
  }
  if (resp.fingerprintMode && resp.fingerprintMode !== "off") {
    addDiagnosticRow(box, "Signal poison", resp.fingerprintMode);
  }
};

const renderSiteSection = (resp) => {
  const toggle = document.getElementById("site-toggle");
  const statusText = document.getElementById("site-status-text");
  const section = document.getElementById("site-control");
  const isDisabled = !!(resp && resp.disabled);

  toggle.checked = !isDisabled;

  const updateUI = () => {
    if (isDisabled) {
      statusText.textContent = "Paused on this site";
      statusText.className = "site-status-paused";
    } else {
      statusText.textContent = "Protecting this site";
      statusText.className = "site-status-active";
    }
  };
  updateUI();

  if (!resp || !resp.origin) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  toggle.addEventListener("change", async ({ currentTarget }) => {
    const el = currentTarget;
    const checked = el.checked;
    const desiredDisabled = !checked;
    const localResp = resp;
    try {
      await chrome.runtime.sendMessage({
        type: "static_set_site_disabled",
        disabled: desiredDisabled,
        origin: localResp.origin,
      });
      localResp.disabled = desiredDisabled;
      updateUI();
      await pushConfigUpdateToActiveTab();
    } catch (e) {
      console.error("[Static] site toggle failed", e);
      el.checked = checked;
    }
  });
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
  renderCompatibilityNotice(resp);
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
      } catch (e) {
        console.error("[Static] ruleset toggle failed", meta.id, e);
        input.checked = !input.checked;
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
  renderSiteSection(details);
  renderNoiseSection(details);
  renderDiagnosticsSection(details);
  renderFingerprintSection(details);
  renderReplaySection(details);
  renderRulesets(enabledArr, counts);
  await renderExposedProfile(details);
  setupHelpTips();
})();
