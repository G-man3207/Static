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

const MODE_PER_SITE = "per_site";
const MODE_ALWAYS = "always";

const MODE_EXPLAINER = {
  [MODE_PER_SITE]: "Static stays off until you turn it on for a site.",
  [MODE_ALWAYS]: "Static masks every site except the ones you pause.",
};

const SITE_STATE_TEXT = {
  off: "You left this off here.",
  on: "Static is on here.",
  undecided: "Static is off here.",
};

const NO_EVIDENCE_HEADLINE = "Nothing seen here yet";
const NO_EVIDENCE_SUMMARY =
  "Static hasn't seen this page do anything it can mask. It gets more useful after a page load or two.";
const NO_EVIDENCE_SUGGESTION = "Changes take effect when this page reloads.";
const SITE_CAUTION_TEXT = "If sign-in misbehaves, leave this site off.";
const SITE_TURNED_OFF_HEADLINE = "Since you turned it off, Static stays off here.";

const NOTE_TARGETS = {
  device: "fingerprint-title-text",
  network: "rulesets",
  replay: "replay-title-text",
};

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

// Popup state shared by the once-bound event listeners below.
let currentMode = MODE_ALWAYS;
let popupTabId = null;
let currentSiteOrigin = null;
let siteOpenMoreTarget = "rulesets";
let recoveryAction = null;

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

const setReplayMode = (mode) => {
  replayState.replayMode = mode;
  renderReplayIndicators();
};

const renderCumulative = (cumulative, visible) => {
  const cumulativeEl = document.getElementById("cumulative");
  cumulativeEl.hidden = !visible;
  cumulativeEl.textContent =
    visible && cumulative > 0 ? `${fmt(cumulative)} probes blocked since install` : "";
};

const modeForDetails = (details) =>
  details && details.mode === MODE_PER_SITE ? MODE_PER_SITE : MODE_ALWAYS;

const protectedHereFor = (details) => {
  if (!details) return false;
  if (modeForDetails(details) !== MODE_PER_SITE) return true;
  if (typeof details.protectedHere === "boolean") return details.protectedHere;
  if (details.site && details.site.decision === "on") return true;
  if (typeof details.disabled === "boolean") return !details.disabled;
  return false;
};

const modeForUi = (details) =>
  details && isHttpUrl(details.origin) ? modeForDetails(details) : MODE_ALWAYS;

const isPerSiteUnprotected = (details) =>
  !!details &&
  isHttpUrl(details.origin) &&
  modeForDetails(details) === MODE_PER_SITE &&
  !protectedHereFor(details);

const pausedHereFor = (details) =>
  !!(details && (details.disabled || details.paused || (details.site && details.site.paused)));

const decisionForSite = (site) => {
  if (!site) return "undecided";
  if (site.decision === "on") return "on";
  if (site.decision === "off") return "off";
  return "undecided";
};

const recommendationForSite = (site) => {
  const recommendation = site && site.recommendation;
  return recommendation && typeof recommendation === "object" ? recommendation : null;
};

const reasonListFor = (recommendation, key) => {
  const value = recommendation && recommendation[key];
  return Array.isArray(value)
    ? value.filter((reason) => reason && typeof reason.text === "string")
    : [];
};

const noteTargetFor = (note) => {
  if (note && typeof note.defense === "string" && NOTE_TARGETS[note.defense]) {
    return NOTE_TARGETS[note.defense];
  }
  const key = String((note && note.key) || "").toLowerCase();
  const text = String((note && note.text) || "").toLowerCase();
  const hint = `${key} ${text}`;
  if (/replay|record|logrocket|fullstory|hotjar|posthog|sentry|datadog/.test(hint)) {
    return NOTE_TARGETS.replay;
  }
  if (
    /device|canvas|webgl|audio|font|hardware|screen|timezone|language|storage|webrtc|battery/.test(
      hint
    )
  ) {
    return NOTE_TARGETS.device;
  }
  if (/network|loads|vendor|list|challenge/.test(hint)) {
    return NOTE_TARGETS.network;
  }
  return NOTE_TARGETS.device;
};

const formatConfidence = (confidence) => {
  if (confidence === "high") return "high confidence";
  if (confidence === "medium") return "medium confidence";
  if (confidence === "low") return "low confidence";
  return "";
};

const verdictTextFor = (recommendation) => {
  const verdict = recommendation && recommendation.verdict;
  const label =
    verdict === "protect"
      ? "Worth masking"
      : verdict === "skip"
        ? "Better left off"
        : "No strong signal";
  const confidence = formatConfidence(recommendation && recommendation.confidence);
  return confidence ? `${label} · ${confidence}` : label;
};

const verdictClassFor = (recommendation) => {
  const verdict = recommendation && recommendation.verdict;
  if (verdict === "protect") return "site-verdict is-protect";
  if (verdict === "skip") return "site-verdict is-skip";
  return "site-verdict is-neutral";
};

const seenSinceDecisionFor = (site) => {
  const value = Number(site && site.seenSinceDecision);
  return Number.isFinite(value) && value > 0 ? value : 0;
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

const tabIdFromQuery = () => {
  try {
    const value = Number(new URLSearchParams(window.location.search).get("tabId"));
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
};

const isHttpUrl = (url) => typeof url === "string" && /^https?:/i.test(url);
const isExtensionUrl = (url) =>
  typeof url === "string" && /^(chrome|moz|safari-web|ms-browser|edge)-extension:/i.test(url);

const tabOrigin = (tab) => {
  try {
    return tab && tab.url ? new URL(tab.url).origin : null;
  } catch {
    return null;
  }
};

const resolvePopupTab = async () => {
  const [active] = await chrome.tabs
    .query({ active: true, currentWindow: true })
    .catch(() => [null]);
  if (active && isHttpUrl(active.url)) return active;
  const [focused] = await chrome.tabs
    .query({ active: true, lastFocusedWindow: true })
    .catch(() => [null]);
  if (focused && isHttpUrl(focused.url)) return focused;
  if (active && isExtensionUrl(active.url)) {
    const all = await chrome.tabs.query({}).catch(() => []);
    const httpTabs = all.filter((tab) => isHttpUrl(tab.url));
    httpTabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    if (httpTabs[0]) return httpTabs[0];
  }
  return active || null;
};

const reloadPopupTab = async () => {
  if (popupTabId == null) return;
  try {
    await chrome.tabs.reload(popupTabId);
  } catch (e) {
    console.error("[Static] popup tab reload failed", e);
  }
};

const requireOk = (response) => {
  if (!response || response.ok === false) {
    throw new Error((response && response.error) || "Static did not confirm the change.");
  }
  return response;
};

const reloadOriginTab = async (origin) => {
  if (!origin) return;
  const tabs = await chrome.tabs.query({}).catch(() => []);
  // Reload the tab the popup is for; fall back to another tab on that origin.
  const onOrigin = (tab) => tabOrigin(tab) === origin && isHttpUrl(tab.url);
  const match = tabs.find((tab) => tab.id === popupTabId && onOrigin(tab)) || tabs.find(onOrigin);
  if (match && match.id != null) await chrome.tabs.reload(match.id);
};

const setSiteDisabledAndReload = async (origin, disabled, button) => {
  if (!origin) return;
  if (button) button.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      disabled,
      origin,
      type: "static_set_site_disabled",
    });
    if (response && response.ok === false) {
      throw new Error(response.error || "Static was not saved.");
    }
    await reloadOriginTab(origin);
    window.close();
  } catch (e) {
    console.error("[Static] site pause/resume failed", e);
    if (button) button.disabled = false;
  }
};

const setRecoveryCardState = (state) => {
  const card = document.getElementById("recovery");
  card.dataset.state = state;
  card.classList.toggle("is-warning", state === "warning");
  card.classList.toggle("is-paused", state === "paused");
};

const showRecoveryCard = ({ action, actionText, detail, state, title }) => {
  const section = document.getElementById("recovery-section");
  const card = document.getElementById("recovery");
  section.hidden = false;
  card.hidden = false;
  setRecoveryCardState(state);
  document.getElementById("recovery-title").textContent = title;
  document.getElementById("recovery-detail").textContent = detail;
  document.getElementById("recovery-action").textContent = actionText;
  document.getElementById("recovery-action").disabled = false;
  recoveryAction = action;
};

const hideRecoveryCard = () => {
  document.getElementById("recovery-section").hidden = true;
  document.getElementById("recovery").hidden = true;
  recoveryAction = null;
};

const renderAlwaysRecoveryCard = (resp) => {
  if (resp.disabled) {
    showRecoveryCard({
      action: { origin: resp.origin, type: "resume" },
      actionText: "Turn protection back on",
      detail:
        "Protection is off on this site. Reload if the page still looks stuck. You can turn Static back on anytime.",
      state: "paused",
      title: "Static is paused here",
    });
    return true;
  }

  if (resp.compatWarning) {
    showRecoveryCard({
      action: { origin: resp.origin, type: "pause" },
      actionText: "Pause this site and reload",
      detail:
        "Static blocked something this page expected. Pause here and reload to see if that fixes it.",
      state: "warning",
      title: "This site may be broken by Static",
    });
    return true;
  }

  if (!resp.origin || !isHttpUrl(resp.origin)) return false;
  showRecoveryCard({
    action: { origin: resp.origin, type: "pause" },
    actionText: "Pause this site and reload",
    detail:
      "Static can stop logins, checkouts, or extra features on some sites. Pause it here to check.",
    state: "help",
    title: "Page not working?",
  });
  return true;
};

const renderPerSiteRecoveryCard = (resp) => {
  if (!protectedHereFor(resp)) {
    hideRecoveryCard();
    return;
  }
  const compatWarning = !!(
    (resp.site && resp.site.history && resp.site.history.compatWarning) ||
    resp.compatWarning
  );

  if (compatWarning) {
    showRecoveryCard({
      action: { origin: resp.origin, type: "decision-off" },
      actionText: "Turn protection off here and reload",
      detail:
        "Static interrupted a request this page expected. Turn protection off here to see if that fixes it.",
      state: "warning",
      title: "This site may be broken by Static",
    });
    return;
  }

  showRecoveryCard({
    action: { origin: resp.origin, type: "decision-off" },
    actionText: "Turn protection off here",
    detail:
      "Static can stop logins, checkouts, or extra features on this site. Turn it off here to check.",
    state: "help",
    title: "Page not working?",
  });
};

const renderRecoveryCard = (resp) => {
  if (!resp || !isHttpUrl(resp.origin)) {
    hideRecoveryCard();
    return;
  }
  if (modeForDetails(resp) === MODE_PER_SITE) {
    renderPerSiteRecoveryCard(resp);
    return;
  }
  if (!renderAlwaysRecoveryCard(resp)) hideRecoveryCard();
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

const syntheticUserAgentFor = (personaData) => {
  const uaOs = String((personaData && personaData.uaOs) || "Windows NT 10.0; Win64; x64");
  return `Mozilla/5.0 (${uaOs}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36`;
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
    userAgent: syntheticUserAgentFor(personaData),
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

const exposedProfileStateFor = (resp, poisoning, uaScrubbed) => {
  if (resp && resp.disabled) {
    return {
      className: "profile-summary paused",
      label: "Paused here — browser defaults exposed",
      note: "Static is paused on this site, so the page sees your real user agent and browser profile.",
    };
  }
  if (poisoning) {
    return {
      className: "profile-summary",
      label: "Poisoned per-site persona exposed",
      note: "Device signal poisoning is active here. These are the stable JavaScript-visible values Static presents to this origin, including the user agent sent on requests.",
    };
  }
  if (uaScrubbed) {
    return {
      className: "profile-summary",
      label: "User agent scrubbed",
      note: "This site sees a stable per-site user agent, platform, and Client Hints. Other rows are this browser's real profile until Device signal poisoning is on.",
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
    note: "Open Static on a web page to see the user agent that site receives. This view is the extension page's own browser profile.",
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
    const paused = !!(resp && resp.disabled);
    const poisoning = !!(
      resp &&
      resp.fingerprintMode === "mask" &&
      resp.fingerprintPersona &&
      !paused
    );
    const uaScrubbed = !!(resp && resp.fingerprintPersona && !paused);
    const profile = poisoning
      ? profileFromPersona(resp.fingerprintPersona)
      : {
          ...(await collectLocalBrowserProfile()),
          ...(uaScrubbed
            ? {
                userAgent: syntheticUserAgentFor(resp.fingerprintPersona),
                platform: resp.fingerprintPersona.platform,
                uaDataPlatform: resp.fingerprintPersona.uaDataPlatform,
              }
            : {}),
        };
    const state = exposedProfileStateFor(resp, poisoning, uaScrubbed);
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

const renderSiteStatusLine = (text, variant) => {
  const statusText = document.getElementById("site-status-text");
  statusText.textContent = text;
  statusText.className = variant;
};

const renderSiteStatus = (isDisabled) => {
  if (isDisabled) {
    renderSiteStatusLine(
      "Paused. This site can see installed extensions again.",
      "site-status-paused"
    );
  } else {
    renderSiteStatusLine("On. Pause it if the page looks broken.", "site-status-active");
  }
};

const setCurrentMode = (mode) => {
  currentMode = mode;
  const perSite = mode === MODE_PER_SITE;
  document.getElementById("mode-per-site").setAttribute("aria-pressed", String(perSite));
  document.getElementById("mode-always").setAttribute("aria-pressed", String(!perSite));
  document.getElementById("mode-explainer").textContent = MODE_EXPLAINER[mode];
};

const renderModeRow = (resp) => {
  setCurrentMode(modeForUi(resp));
  const note = document.getElementById("mode-note");
  note.hidden = true;
  note.textContent = "";
};

const renderOnboarding = (resp) => {
  const visible = !!(resp && resp.onboarding && resp.onboarding.visible && isHttpUrl(resp.origin));
  document.getElementById("onboarding").hidden = !visible;
};

const renderSitesLink = (resp) => {
  const stats = document.getElementById("sites-stats");
  stats.textContent = "";
  const summary = resp && resp.sitesSummary;
  if (!summary || typeof summary !== "object") return;

  const count = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  };
  if (modeForDetails(resp) === MODE_ALWAYS) {
    stats.textContent = `${fmt(count(summary.paused))} paused`;
    return;
  }
  stats.textContent = `${fmt(count(summary.on))} on · ${fmt(count(summary.off))} off`;
};

const renderRulesetPausedNote = (resp) => {
  const note = document.getElementById("rulesets-paused-note");
  if (!resp || !isHttpUrl(resp.origin)) {
    note.hidden = true;
    note.textContent = "";
    return;
  }
  if (modeForDetails(resp) === MODE_ALWAYS) {
    note.textContent = "Static is paused on this site, so these lists don't apply to this site.";
    note.hidden = !pausedHereFor(resp);
    return;
  }
  note.textContent =
    "Static is off on this site, so these lists only apply to the sites you protect.";
  note.hidden = protectedHereFor(resp);
};

const renderSiteSection = (resp) => {
  const section = document.getElementById("site-control");
  const decisionSection = document.getElementById("site-decision");
  const toggle = document.getElementById("site-toggle");
  const mode = resp ? modeForDetails(resp) : null;
  const http = !!(resp && isHttpUrl(resp.origin));
  const showSwitch = http && mode === MODE_ALWAYS;
  const showDecision = http && mode === MODE_PER_SITE && !!resp.site;

  section.hidden = !showSwitch;
  decisionSection.hidden = !showDecision;
  if (showSwitch) {
    toggle.checked = !resp.disabled;
    toggle.dataset.siteOrigin = resp.origin;
    renderSiteStatus(!!resp.disabled);
  }
  if (showDecision) {
    renderSiteDecision(resp);
  } else {
    resetSiteDecision();
  }
};

const seenCountFor = (resp) => {
  if (resp && typeof resp.seen === "number") return resp.seen;
  const evidence = resp && resp.site && resp.site.evidence;
  return evidence && typeof evidence.probeTotal === "number" ? evidence.probeTotal : 0;
};

const renderCountHero = (resp) => {
  const total = resp && typeof resp.total === "number" ? resp.total : 0;
  const cumulative = resp && typeof resp.cumulative === "number" ? resp.cumulative : 0;
  const perSiteUnprotected = isPerSiteUnprotected(resp);
  const seen = seenCountFor(resp);

  const countEl = document.getElementById("count");
  countEl.textContent = fmt(perSiteUnprotected ? seen : total);
  countEl.style.color = perSiteUnprotected ? (seen > 0 ? "#d88030" : "#888") : colorForCount(total);
  countEl.dataset.countKind = perSiteUnprotected ? "seen" : "blocked";
  document.getElementById("count-label").textContent = perSiteUnprotected
    ? "extension checks seen here"
    : "probes blocked on this tab";
  document.getElementById("count-subtext").hidden = !perSiteUnprotected;
  renderCumulative(cumulative, !perSiteUnprotected);
  renderDriftNotice(resp && resp.drift);
  renderAdaptiveNotice(resp);
};

const renderDetails = (resp) => {
  const topIds = resp && Array.isArray(resp.topIds) ? resp.topIds : [];

  renderCountHero(resp);
  renderRecoveryCard(resp);
  renderTopIds(topIds);
  renderPowerDiagnostics(resp);
};

const setSiteNote = (text) => {
  const note = document.getElementById("site-note");
  note.textContent = text || "";
  note.hidden = !text;
};

const setSiteActionsBusy = (busy) => {
  for (const id of ["site-protect", "site-leave-off", "site-turn-off", "recovery-action"]) {
    document.getElementById(id).disabled = busy;
  }
};

const clearSuggestedActions = () => {
  document.getElementById("site-protect").classList.remove("is-suggested");
  document.getElementById("site-leave-off").classList.remove("is-suggested");
};

const appendReasonRows = (list, reasons, className) => {
  for (const reason of reasons) {
    if (!reason || typeof reason.text !== "string" || !reason.text) continue;
    const row = document.createElement("li");
    row.className = className;
    row.textContent = reason.text;
    if (typeof reason.key === "string") row.dataset.key = reason.key;
    if (typeof reason.defense === "string") row.dataset.defense = reason.defense;
    list.appendChild(row);
  }
};

const renderSiteReasons = (recommendation) => {
  const list = document.getElementById("site-reasons");
  const openMore = document.getElementById("site-open-more");
  list.replaceChildren();
  if (recommendation) {
    appendReasonRows(list, reasonListFor(recommendation, "benefits"), "benefit");
    appendReasonRows(list, reasonListFor(recommendation, "risks"), "risk");
    appendReasonRows(list, reasonListFor(recommendation, "notes"), "note");
  }
  list.hidden = list.childElementCount === 0;
  const notes = reasonListFor(recommendation, "notes");
  openMore.hidden = notes.length === 0;
  if (notes.length > 0) siteOpenMoreTarget = noteTargetFor(notes[0]);
};

const renderSiteVerdict = (decision, recommendation) => {
  const verdict = document.getElementById("site-verdict");
  verdict.className = "site-verdict";
  if (decision === "on") {
    verdict.textContent = "On · you chose it";
    verdict.className = "site-verdict is-on";
    verdict.hidden = false;
    return;
  }
  if (!recommendation) {
    verdict.textContent = "";
    verdict.hidden = true;
    return;
  }
  if (decision === "off" && recommendation.verdict === "protect") {
    verdict.textContent = "";
    verdict.hidden = true;
    return;
  }
  verdict.textContent = verdictTextFor(recommendation);
  verdict.className = verdictClassFor(recommendation);
  verdict.hidden = false;
};

const setRecommendationCopy = (headlineText, summaryText) => {
  const block = document.getElementById("site-summary");
  const headline = document.getElementById("site-headline");
  const summary = document.getElementById("site-summary-text");
  headline.textContent = headlineText || "";
  headline.hidden = !headlineText;
  summary.textContent = summaryText || "";
  summary.hidden = !summaryText;
  block.hidden = !headlineText && !summaryText;
};

const renderSiteCopy = (decision, recommendation) => {
  const caution = document.getElementById("site-caution");
  if (decision === "off" && recommendation && recommendation.verdict === "protect") {
    setRecommendationCopy(SITE_TURNED_OFF_HEADLINE, recommendation.summary || "");
  } else if (recommendation) {
    setRecommendationCopy(recommendation.headline || "", recommendation.summary || "");
  } else {
    setRecommendationCopy(NO_EVIDENCE_HEADLINE, NO_EVIDENCE_SUMMARY);
  }

  caution.textContent = recommendation && recommendation.caution ? SITE_CAUTION_TEXT : "";
  caution.hidden = !caution.textContent;
};

const renderSiteActions = (decision, recommendation) => {
  const protect = document.getElementById("site-protect");
  const leaveOff = document.getElementById("site-leave-off");
  const turnOff = document.getElementById("site-turn-off");
  protect.hidden = decision === "on";
  leaveOff.hidden = decision !== "undecided";
  turnOff.hidden = decision !== "on";
  clearSuggestedActions();
  if (decision !== "undecided" || !recommendation) return;
  if (recommendation.verdict === "protect") {
    protect.classList.add("is-suggested");
  } else if (recommendation.verdict === "skip") {
    leaveOff.classList.add("is-suggested");
  }
};

const renderSiteDecisionNote = (decision, site) => {
  if (decision === "undecided") {
    setSiteNote(NO_EVIDENCE_SUGGESTION);
    return;
  }
  if (decision === "off") {
    const newChecks = seenSinceDecisionFor(site);
    setSiteNote(newChecks > 0 ? `New checks here: ${fmt(newChecks)} since you turned it off.` : "");
    return;
  }
  setSiteNote("");
};

const renderSiteDecision = (resp) => {
  const site = resp.site;
  const decision = decisionForSite(site);
  const recommendation = recommendationForSite(site);
  currentSiteOrigin = typeof resp.origin === "string" ? resp.origin : "";
  document.getElementById("site-decision").dataset.decision = decision;
  document.getElementById("site-state").textContent = SITE_STATE_TEXT[decision];
  renderSiteVerdict(decision, recommendation);
  renderSiteCopy(decision, recommendation);
  renderSiteReasons(recommendation);
  renderSiteActions(decision, recommendation);
  renderSiteDecisionNote(decision, site);
  setSiteActionsBusy(false);
};

const resetSiteDecision = () => {
  currentSiteOrigin = null;
  document.getElementById("site-decision").hidden = true;
  document.getElementById("site-decision").dataset.decision = "";
  document.getElementById("site-state").textContent = "";
  document.getElementById("site-verdict").hidden = true;
  document.getElementById("site-headline").hidden = true;
  document.getElementById("site-headline").textContent = "";
  document.getElementById("site-summary-text").hidden = true;
  document.getElementById("site-summary-text").textContent = "";
  document.getElementById("site-summary").hidden = true;
  document.getElementById("site-caution").hidden = true;
  const reasons = document.getElementById("site-reasons");
  reasons.replaceChildren();
  reasons.hidden = true;
  document.getElementById("site-open-more").hidden = true;
  clearSuggestedActions();
  setSiteNote("");
  setSiteActionsBusy(false);
};

const renderNoiseSection = (resp) => {
  const toggle = document.getElementById("noise-toggle");
  toggle.checked = !!(resp && resp.noiseEnabled);

  const originsLogged = resp && typeof resp.originsLogged === "number" ? resp.originsLogged : 0;
  const viewLog = document.getElementById("view-log");
  const stats = document.getElementById("noise-stats");
  const hasOrigins = originsLogged > 0;
  viewLog.hidden = !hasOrigins;
  stats.textContent = hasOrigins
    ? `${fmt(originsLogged)} origin${originsLogged === 1 ? "" : "s"} logged`
    : "";
};

const renderDiagnosticsSection = (resp) => {
  document.getElementById("diagnostics-toggle").checked = !!(resp && resp.diagnosticsMode);
};

const renderResearchLoggingSection = (resp) => {
  document.getElementById("research-logging-toggle").checked = !!(resp && resp.researchLogging);
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
};

const renderFingerprintSection = (resp) => {
  const select = document.getElementById("fingerprint-mode");
  const allowed = new Set(["off", "mask"]);
  select.value = resp && allowed.has(resp.fingerprintMode) ? resp.fingerprintMode : "off";
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

const rulesetEnabled = (resp, enabled) => (rulesetId) => {
  const prefs = resp && resp.rulesetPrefs;
  if (prefs && typeof prefs[rulesetId] === "boolean") return prefs[rulesetId];
  return enabled.has(rulesetId);
};

const renderRulesets = (resp, enabledArr, counts) => {
  const enabled = new Set(Array.isArray(enabledArr) ? enabledArr : []);
  const isEnabled = rulesetEnabled(resp, enabled);
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
    input.checked = isEnabled(meta.id);

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
      const desired = input.checked;
      input.disabled = true;
      try {
        const saved = await chrome.runtime.sendMessage({
          enabled: desired,
          id: meta.id,
          type: "static_set_ruleset_enabled",
        });
        requireOk(saved);
        const persisted = saved && saved.prefs && typeof saved.prefs[meta.id] === "boolean";
        input.checked = persisted ? saved.prefs[meta.id] : desired;
      } catch (e) {
        console.error("[Static] ruleset toggle failed", meta.id, e);
        input.checked = !desired;
      } finally {
        input.disabled = false;
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

const applySiteDecision = async (state) => {
  const origin = currentSiteOrigin;
  if (!origin) {
    setSiteNote("Reload this page, then try again.");
    return;
  }
  setSiteActionsBusy(true);
  setSiteNote("Saving…");
  try {
    const response = await chrome.runtime.sendMessage({
      origin,
      state,
      type: "static_set_site_decision",
    });
    requireOk(response);
    await reloadPopupTab();
    window.close();
  } catch (error) {
    console.error("[Static] site decision failed", error);
    setSiteActionsBusy(false);
    setSiteNote("Static couldn't save that. Try again.");
  }
};

const handleSiteToggle = async () => {
  const toggle = document.getElementById("site-toggle");
  const origin = toggle.dataset.siteOrigin;
  const enabled = toggle.checked;
  if (!origin) {
    toggle.checked = !enabled;
    return;
  }
  toggle.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      disabled: !enabled,
      origin,
      type: "static_set_site_disabled",
    });
    if (response && response.ok === false) {
      throw new Error(response.error || "Static was not saved.");
    }
    renderSiteStatus(!enabled);
    // A paused site has no Static code left to update, so both directions
    // take effect on reload. The handler re-registered the scripts first.
    await reloadOriginTab(origin);
  } catch (e) {
    console.error("[Static] site toggle failed", e);
    toggle.checked = !enabled;
  } finally {
    toggle.disabled = false;
  }
};

const handleModeChange = async (mode) => {
  if (mode === currentMode) return;
  const perSiteButton = document.getElementById("mode-per-site");
  const alwaysButton = document.getElementById("mode-always");
  const note = document.getElementById("mode-note");
  perSiteButton.disabled = true;
  alwaysButton.disabled = true;
  note.hidden = true;
  note.textContent = "";
  try {
    requireOk(await chrome.runtime.sendMessage({ mode, type: "static_set_protection_mode" }));
    setCurrentMode(mode);
    await reloadPopupTab();
    window.close();
  } catch (error) {
    console.error("[Static] protection mode update failed", error);
    note.textContent = "Static couldn't switch modes. Try again.";
    note.hidden = false;
  } finally {
    perSiteButton.disabled = false;
    alwaysButton.disabled = false;
  }
};

const setOnboardingBusy = (busy) => {
  document.getElementById("onboarding-dismiss").disabled = busy;
  document.getElementById("onboarding-always").disabled = busy;
};

const setOnboardingNote = (text) => {
  const note = document.getElementById("onboarding-note");
  note.textContent = text || "";
  note.hidden = !text;
};

const handleOnboardingDismiss = async () => {
  setOnboardingBusy(true);
  setOnboardingNote("");
  try {
    requireOk(await chrome.runtime.sendMessage({ type: "static_dismiss_onboarding" }));
    document.getElementById("onboarding").hidden = true;
  } catch (error) {
    console.error("[Static] onboarding dismiss failed", error);
    setOnboardingNote("Static couldn't save that. Try again.");
  } finally {
    setOnboardingBusy(false);
  }
};

const handleOnboardingAlways = async () => {
  setOnboardingBusy(true);
  setOnboardingNote("");
  try {
    requireOk(
      await chrome.runtime.sendMessage({
        mode: MODE_ALWAYS,
        type: "static_set_protection_mode",
      })
    );
    setCurrentMode(MODE_ALWAYS);
    document.getElementById("onboarding").hidden = true;
    await reloadPopupTab();
    window.close();
  } catch (error) {
    console.error("[Static] onboarding mode switch failed", error);
    setOnboardingNote("Static couldn't switch modes. Try again.");
  } finally {
    setOnboardingBusy(false);
  }
};

const handleRecoveryAction = async () => {
  const action = recoveryAction;
  if (!action) return;
  if (action.type === "decision-off") {
    await applySiteDecision("off");
    return;
  }
  const button = document.getElementById("recovery-action");
  await setSiteDisabledAndReload(action.origin, action.type === "pause", button);
};

const handleOpenMore = () => {
  const advanced = document.getElementById("advanced-controls");
  if (advanced) advanced.open = true;
  const target = document.getElementById(siteOpenMoreTarget) || document.getElementById("rulesets");
  if (!target) return;
  target.classList.add("is-targeted");
  target.scrollIntoView({ block: "center" });
  const controlId = {
    "fingerprint-title-text": "fingerprint-mode",
    "replay-title-text": "replay-mode",
    rulesets: "rs_fingerprint_vendors",
  }[siteOpenMoreTarget];
  const control = controlId ? document.getElementById(controlId) : null;
  if (control) control.focus({ preventScroll: true });
  window.setTimeout(() => target.classList.remove("is-targeted"), 1600);
};

const handleNoiseToggle = async () => {
  const toggle = document.getElementById("noise-toggle");
  const desired = toggle.checked;
  try {
    requireOk(await chrome.runtime.sendMessage({ enabled: desired, type: "static_set_noise" }));
    // Push the new state to the active tab's content scripts via activeTab
    // so the current page sees the change without a reload.
    await pushConfigUpdateToActiveTab();
  } catch (e) {
    console.error("[Static] noise toggle failed", e);
    toggle.checked = !desired;
  }
};

const handleDiagnosticsToggle = async () => {
  const toggle = document.getElementById("diagnostics-toggle");
  const desired = toggle.checked;
  try {
    const saved = await chrome.runtime.sendMessage({
      enabled: desired,
      type: "static_set_diagnostics",
    });
    toggle.checked = !!(saved && saved.enabled);
    await pushConfigUpdateToActiveTab();
  } catch (e) {
    console.error("[Static] diagnostics toggle failed", e);
    toggle.checked = !desired;
  }
};

const handleResearchLoggingToggle = async () => {
  const toggle = document.getElementById("research-logging-toggle");
  const desired = toggle.checked;
  try {
    const saved = await chrome.runtime.sendMessage({
      enabled: desired,
      type: "static_set_research_logging",
    });
    toggle.checked = !!(saved && saved.enabled);
  } catch (e) {
    console.error("[Static] research logging toggle failed", e);
    toggle.checked = !desired;
  }
};

const handleFingerprintChange = async () => {
  const select = document.getElementById("fingerprint-mode");
  const previous = select.value === "mask" ? "mask" : "off";
  const desired = select.value === "mask" ? "mask" : "off";
  try {
    const saved = await chrome.runtime.sendMessage({
      mode: desired,
      type: "static_set_fingerprint",
    });
    select.value = saved && saved.mode === "mask" ? "mask" : "off";
    await pushConfigUpdateToActiveTab();
  } catch (e) {
    console.error("[Static] fingerprint mode update failed", e);
    select.value = previous;
  }
};

const handleReplayChange = async () => {
  const select = document.getElementById("replay-mode");
  const allowed = new Set(["off", "mask", "noise", "chaos"]);
  const desired = allowed.has(select.value) ? select.value : "off";
  const previous = replayState.replayMode;
  try {
    const saved = await chrome.runtime.sendMessage({ mode: desired, type: "static_set_replay" });
    const next = saved && allowed.has(saved.mode) ? saved.mode : desired;
    select.value = next;
    setReplayMode(next);
    await pushConfigUpdateToActiveTab();
  } catch (e) {
    console.error("[Static] replay mode update failed", e);
    select.value = previous;
    setReplayMode(previous);
  }
};

const handleViewLog = () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("log.html") });
  window.close();
};

const handleViewSites = (event) => {
  event.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("sites.html") });
  window.close();
};

const bindPopupHandlers = () => {
  document.getElementById("site-toggle").addEventListener("change", handleSiteToggle);
  document.getElementById("site-protect").addEventListener("click", () => applySiteDecision("on"));
  document
    .getElementById("site-leave-off")
    .addEventListener("click", () => applySiteDecision("off"));
  document
    .getElementById("site-turn-off")
    .addEventListener("click", () => applySiteDecision("off"));
  document.getElementById("site-open-more").addEventListener("click", handleOpenMore);
  document.getElementById("recovery-action").addEventListener("click", handleRecoveryAction);
  document.getElementById("mode-per-site").addEventListener("click", () => {
    handleModeChange(MODE_PER_SITE);
  });
  document.getElementById("mode-always").addEventListener("click", () => {
    handleModeChange(MODE_ALWAYS);
  });
  document.getElementById("onboarding-dismiss").addEventListener("click", handleOnboardingDismiss);
  document.getElementById("onboarding-always").addEventListener("click", handleOnboardingAlways);
  document.getElementById("noise-toggle").addEventListener("change", handleNoiseToggle);
  document.getElementById("diagnostics-toggle").addEventListener("change", handleDiagnosticsToggle);
  document
    .getElementById("research-logging-toggle")
    .addEventListener("change", handleResearchLoggingToggle);
  document.getElementById("fingerprint-mode").addEventListener("change", handleFingerprintChange);
  document.getElementById("replay-mode").addEventListener("change", handleReplayChange);
  document.getElementById("view-log").addEventListener("click", handleViewLog);
  document.getElementById("view-sites").addEventListener("click", handleViewSites);
};

(async () => {
  try {
    const queriedTabId = tabIdFromQuery();
    const tab =
      queriedTabId != null
        ? await chrome.tabs.get(queriedTabId).catch(() => null)
        : await resolvePopupTab();
    popupTabId = tab && tab.id != null ? tab.id : null;
    // Settings pages and chrome:// tabs have no site card, but their details
    // still carry the popup settings (replay, diagnostics, rulesets).
    const detailsPromise =
      popupTabId != null
        ? chrome.runtime
            .sendMessage({ type: "static_get_details", tabId: popupTabId })
            .catch(() => null)
        : Promise.resolve(null);
    const enabledPromise = chrome.declarativeNetRequest.getEnabledRulesets().catch(() => []);
    const countsPromise = Promise.all(RULESET_META.map((m) => fetchRuleCount(m.id)));

    const [details, enabledArr, counts] = await Promise.all([
      detailsPromise,
      enabledPromise,
      countsPromise,
    ]);

    renderModeRow(details);
    renderDetails(details);
    renderSiteSection(details);
    renderOnboarding(details);
    renderNoiseSection(details);
    renderDiagnosticsSection(details);
    renderResearchLoggingSection(details);
    renderFingerprintSection(details);
    renderReplaySection(details);
    renderRulesets(details, enabledArr, counts);
    renderRulesetPausedNote(details);
    renderSitesLink(details);
    await renderExposedProfile(details);
    setupHelpTips();
  } catch (error) {
    console.error("[Static] popup rendering failed", error);
  } finally {
    bindPopupHandlers();
  }
})();
