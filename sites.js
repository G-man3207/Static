/* eslint-disable max-lines -- one self-contained extension page: label catalogs, render helpers and the two-step confirms have no shared module to live in. */
// Static — site protection management page.
//
// Shows the two protection modes and the per-site decisions they affect. The
// page never reads storage directly: the service worker answers
// "static_get_sites_overview" with a compact, defensive payload, receives every
// mutation here, and the page re-reads after each one plus on storage changes
// (debounced) so the popup, a second tab and this page stay in sync.
//
// Everything user-visible is built with createElement/textContent; the two-step
// confirms are inline buttons, not window.confirm, so the page renders the same
// in every browser context.

const SEEN_LIMIT = 50;
const CONFIRM_TIMEOUT_MS = 4000;
const STORAGE_DEBOUNCE_MS = 150;
const DEFAULT_CAPS = { decisions: 250, evidence: 200 };
const WATCHED_KEYS = new Set([
  "disabled_origins",
  "protection_mode",
  "site_decisions",
  "site_evidence",
]);
const DEVICE_STRONG = new Set(["audio", "canvas", "fonts", "webgl"]);
const MODE_BUTTONS = ["mode-per-site", "mode-always"];

const VENDOR_LABELS = {
  akamai: "Akamai Bot Manager",
  altcha: "Altcha",
  arkose: "Arkose Labs",
  botguard: "BotGuard",
  castle: "Castle",
  cheq: "CHEQ",
  "cloudflare-bot": "Cloudflare",
  cloudflare_bot: "Cloudflare",
  datadome: "DataDome",
  deviceatlas: "DeviceAtlas",
  distil: "Distil",
  fingerprintjs: "FingerprintJS",
  forter: "Forter",
  friendlycaptcha: "Friendly Captcha",
  geetest: "Geetest",
  hcaptcha: "hCaptcha",
  human: "HUMAN",
  imperva: "Imperva",
  iovation: "iovation",
  jscrambler: "Jscrambler",
  kasada: "Kasada",
  nethone: "Nethone",
  perimeterx: "PerimeterX",
  recaptcha: "reCAPTCHA",
  riskified: "Riskified",
  sardine: "Sardine",
  seon: "SEON",
  sift: "Sift",
  signifyd: "Signifyd",
  socure: "Socure",
  threatmetrix: "ThreatMetrix",
  turnstile: "Cloudflare Turnstile",
  typingdna: "TypingDNA",
  we_stats: "We-Stats",
};

const DEVICE_LABELS = {
  audio: "audio fingerprint",
  battery: "battery status",
  canvas: "canvas readback",
  client_hints: "Client Hints",
  codecs: "codec support",
  connection: "connection type",
  fonts: "installed fonts",
  hardware: "CPU and memory",
  languages: "language list",
  math: "math precision",
  media_devices: "camera and mic list",
  permissions: "permission states",
  plugins: "plugin list",
  screen: "screen geometry",
  storage: "storage quota",
  timezone: "timezone",
  webrtc: "WebRTC info",
  webgl: "WebGL renderer",
};

const COMPAT_LABELS = {
  bot_challenge: "bot checks",
  bot_vendor: "bot protection",
  card_field: "card form",
  captcha: "CAPTCHA",
  checkout_path: "checkout step",
  cross_origin_frame: "embedded sign-in",
  email_field: "email field",
  login_path: "sign-in page",
  oauth_redirect: "third-party sign-in",
  password_field: "sign-in form",
  payment_request: "payment sheet",
  payment_vendor: "payment screening",
  trusted_types: "Trusted Types",
  ua_reads: "user-agent reads",
  webauthn: "passkey sign-in",
};

const ACTION_LABELS = {
  enable: "Enable",
  "leave-off": "Leave off",
  protect: "Protect",
  unprotect: "Turn off",
};

const DECISION_STATES = { protect: "on", unprotect: "off", "leave-off": "off" };

const EMPTY_COPY = {
  on: "No sites protected yet. Open a page and click the Static icon to decide there, or protect a site from this list.",
  off: "No sites left off. When you choose Leave off for a site, it appears here.",
  seen: "No undecided sites. Static lists a page here after it sees extension checks on the site.",
  paused: "No paused sites. Static is active everywhere.",
};

const CLEAR_CONFIG = {
  all: { buttonId: "clear-all", label: "Clear all decisions" },
  seen: { buttonId: "clear-seen", label: "Forget undecided sites" },
};

const EMPTY_OVERVIEW = {
  caps: {},
  declined: [],
  mode: "per_site",
  paused: [],
  protected: [],
  seen: [],
};
const view = { loadToken: 0, mode: "per_site", overview: null, refreshTimer: 0 };
const confirms = {
  all: { armed: false, busy: false, timer: 0 },
  seen: { armed: false, busy: false, timer: 0 },
};

const byId = (id) => document.getElementById(id);

const plural = (value, one, many) => (value === 1 ? one : many);

const timestampOf = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return number > 0 ? number : 0;
};

const toCount = (value) => {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(Math.floor(number), Number.MAX_SAFE_INTEGER);
};

const fmt = (value) => toCount(value).toLocaleString("en-US");

const humanize = (key) => {
  const words = String(key).slice(0, 80).replace(/[_-]+/g, " ").trim().toLowerCase();
  if (!words) return "";
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const labelFor = (labels, key) => {
  if (typeof key !== "string" || !key) return "";
  const direct = labels[key];
  if (typeof direct === "string" && direct) return direct;
  return humanize(key);
};

const stringList = (value) => {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string" && item);
  if (value && typeof value === "object") return Object.keys(value);
  return [];
};

const formatDate = (timestamp) => {
  const value = timestampOf(timestamp);
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const options = { day: "numeric", month: "short" };
  if (date.getFullYear() !== new Date().getFullYear()) options.year = "numeric";
  return date.toLocaleDateString("en-US", options);
};

const evidenceParts = (evidence) => {
  const source = evidence && typeof evidence === "object" ? evidence : {};
  const probes = source.probes && typeof source.probes === "object" ? source.probes : source;
  return {
    compat: stringList(source.compatKeys),
    device: stringList(source.deviceKeys),
    ids: toCount(source.probeIds == null ? probes.ids : source.probeIds),
    labels: stringList(source.labels),
    total: toCount(source.probeTotal == null ? probes.total : source.probeTotal),
    vendors: stringList(source.vendorKeys),
  };
};

const notableLabels = (parts) => {
  const labels = [];
  for (const key of parts.vendors) labels.push(labelFor(VENDOR_LABELS, key));
  for (const key of parts.compat) labels.push(labelFor(COMPAT_LABELS, key));
  for (const key of parts.device) {
    if (DEVICE_STRONG.has(key)) labels.push(labelFor(DEVICE_LABELS, key));
  }
  return [...new Set(labels.filter(Boolean))].slice(0, 2);
};

const mergeLabels = (explicit, computed) => {
  const labels = [...explicit];
  for (const label of computed) {
    if (!label) continue;
    const lower = label.toLowerCase();
    const duplicate = labels.some((existing) => {
      const other = existing.toLowerCase();
      return other.includes(lower) || lower.includes(other);
    });
    if (!duplicate) labels.push(label);
  }
  return labels.slice(0, 2);
};

const evidenceMetrics = (parts) => {
  const metrics = [];
  if (parts.total > 0) {
    metrics.push(
      `${fmt(parts.total)} ${plural(parts.total, "extension check", "extension checks")}`
    );
  }
  if (parts.ids > 0) metrics.push(`${fmt(parts.ids)} ${plural(parts.ids, "ID", "IDs")}`);
  return metrics;
};

const evidenceSummary = (evidence) => {
  const parts = evidenceParts(evidence);
  const labels = mergeLabels(parts.labels.slice(0, 2), notableLabels(parts));
  const segments = [...evidenceMetrics(parts), ...labels];
  return segments.length > 0 ? segments.join(" · ") : "No probing seen yet";
};

const recommendationNote = (entry) => {
  if (!entry || typeof entry !== "object") return "";
  if (typeof entry.recommendationHeadline === "string" && entry.recommendationHeadline) {
    return entry.recommendationHeadline;
  }
  if (!entry.recommendation || typeof entry.recommendation !== "object") return "";
  return typeof entry.recommendation.headline === "string" ? entry.recommendation.headline : "";
};

const protectedMeta = (entry) => {
  const date = formatDate(entry.at);
  return date ? `Protected since ${date}` : "Protected";
};

const declinedMeta = (entry) => {
  const date = formatDate(entry.at);
  return date ? `Left off ${date}` : "Left off";
};

const seenMeta = (entry) => {
  const date = formatDate(entry.lastSeen);
  const checks = evidenceParts(entry.evidence).total;
  const lastSeen = date ? `Last seen ${date}` : "Last seen recently";
  if (checks === 0) return lastSeen;
  return `${lastSeen} · ${fmt(checks)} ${plural(checks, "check", "checks")}`;
};

const isSiteEntry = (entry) =>
  !!entry &&
  typeof entry === "object" &&
  typeof entry.site === "string" &&
  entry.site.trim().length > 0;

const siteEntries = (value) => {
  if (Array.isArray(value)) {
    return value.filter(isSiteEntry).map((entry) => ({ ...entry, site: entry.site.trim() }));
  }
  if (value && typeof value === "object") {
    return Object.entries(value)
      .filter(([site, entry]) => !!site && !!entry && typeof entry === "object")
      .map(([site, entry]) => ({ ...entry, site: site.trim() }));
  }
  return [];
};

const originList = (value) => {
  if (Array.isArray(value)) {
    return value.filter((origin) => typeof origin === "string" && origin).sort();
  }
  if (value && typeof value === "object") {
    return Object.keys(value)
      .filter((origin) => !!value[origin])
      .sort();
  }
  return [];
};

const sortByTimestamp = (entries, key) =>
  [...entries].sort((left, right) => timestampOf(right[key]) - timestampOf(left[key]));

const dedupeBySite = (entries) => {
  const bySite = new Map();
  for (const entry of entries) bySite.set(entry.site, entry);
  return [...bySite.values()];
};

const firstCount = (values) => {
  for (const value of values) {
    const count = toCount(value);
    if (count > 0) return count;
  }
  return 0;
};

const readCaps = (caps) => {
  const source = caps && typeof caps === "object" ? caps : {};
  return {
    decisions:
      firstCount([
        source.maxSiteDecisions,
        source.max_site_decisions,
        source.protected,
        source.siteDecisions,
        source.decisions,
        source.maxDecisions,
        source.decisionLimit,
      ]) || DEFAULT_CAPS.decisions,
    evidence:
      firstCount([
        source.maxEvidenceSites,
        source.max_evidence_sites,
        source.evidenceSites,
        source.evidence,
        source.maxEvidence,
        source.evidenceLimit,
        source.siteEvidence,
      ]) || DEFAULT_CAPS.evidence,
  };
};

const normalizeOverview = (raw) => {
  const data = raw && typeof raw === "object" ? raw : EMPTY_OVERVIEW;
  const protectedEntries = sortByTimestamp(dedupeBySite(siteEntries(data.protected)), "at");
  const declinedEntries = sortByTimestamp(dedupeBySite(siteEntries(data.declined)), "at");
  const decided = new Set([...protectedEntries, ...declinedEntries].map((entry) => entry.site));
  const seenEntries = sortByTimestamp(dedupeBySite(siteEntries(data.seen)), "lastSeen").filter(
    (entry) => !decided.has(entry.site)
  );
  return {
    caps: readCaps(data.caps),
    declined: declinedEntries,
    mode: data.mode === "always" ? "always" : "per_site",
    paused: originList(data.paused),
    protected: protectedEntries,
    seen: seenEntries,
  };
};

const appendLine = (parent, className, text) => {
  if (!text) return;
  const line = document.createElement("span");
  line.className = className;
  line.textContent = text;
  parent.appendChild(line);
};

const siteCell = ({ evidenceText, meta, note, site }) => {
  const cell = document.createElement("td");
  cell.className = "site-cell";
  const name = document.createElement("span");
  name.className = "site-name";
  name.textContent = site;
  cell.appendChild(name);
  appendLine(cell, "site-meta", meta);
  appendLine(cell, "site-evidence", evidenceText);
  appendLine(cell, "site-note", note);
  return cell;
};

const setSiteState = (site, state, button) => {
  const send = () =>
    chrome.runtime.sendMessage({
      site,
      source: "sites-page",
      state,
      type: "static_set_site_decision",
    });
  runAction(button, send);
};

const enableOrigin = (origin, button) => {
  const send = () =>
    chrome.runtime.sendMessage({ disabled: false, origin, type: "static_set_site_disabled" });
  runAction(button, send);
};

const actionButton = (site, action) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn-row";
  button.dataset.action = action;
  button.dataset.site = site;
  if (action === "enable") button.dataset.origin = site;
  button.textContent = ACTION_LABELS[action] || action;
  button.addEventListener("click", () => {
    if (action === "enable") enableOrigin(site, button);
    else setSiteState(site, DECISION_STATES[action], button);
  });
  return button;
};

const actionCell = (site, actions) => {
  const cell = document.createElement("td");
  cell.className = "action-cell";
  for (const action of actions) cell.appendChild(actionButton(site, action));
  return cell;
};

const makeSiteRow = ({ actions, evidenceText, meta, note, site, state }) => {
  const row = document.createElement("tr");
  row.dataset.site = site;
  row.dataset.state = state;
  if (state === "paused") row.dataset.origin = site;
  row.appendChild(siteCell({ evidenceText, meta, note, site }));
  row.appendChild(actionCell(site, actions));
  return row;
};

const protectedRow = (entry) =>
  makeSiteRow({
    actions: ["unprotect"],
    evidenceText: evidenceSummary(entry.evidence),
    meta: protectedMeta(entry),
    note: "",
    site: entry.site,
    state: "on",
  });

const declinedRow = (entry) =>
  makeSiteRow({
    actions: ["protect"],
    evidenceText: evidenceSummary(entry.evidence),
    meta: declinedMeta(entry),
    note: recommendationNote(entry),
    site: entry.site,
    state: "off",
  });

const seenRow = (entry) =>
  makeSiteRow({
    actions: ["protect", "leave-off"],
    evidenceText: evidenceSummary(entry.evidence),
    meta: seenMeta(entry),
    note: recommendationNote(entry),
    site: entry.site,
    state: "seen",
  });

const pausedRow = (origin) =>
  makeSiteRow({
    actions: ["enable"],
    evidenceText: "",
    meta: "",
    note: "",
    site: origin,
    state: "paused",
  });

const paintSection = ({ emptyId, emptyText, rows, tableId, tbodyId }) => {
  byId(tbodyId).replaceChildren(...rows);
  byId(tableId).hidden = rows.length === 0;
  const empty = byId(emptyId);
  empty.hidden = rows.length > 0;
  empty.textContent = rows.length > 0 ? "" : emptyText;
};

const renderSections = (overview) => {
  paintSection({
    emptyId: "empty-on",
    emptyText: EMPTY_COPY.on,
    rows: overview.protected.map(protectedRow),
    tableId: "table-on",
    tbodyId: "tbody-on",
  });
  paintSection({
    emptyId: "empty-off",
    emptyText: EMPTY_COPY.off,
    rows: overview.declined.map(declinedRow),
    tableId: "table-off",
    tbodyId: "tbody-off",
  });
  paintSection({
    emptyId: "empty-seen",
    emptyText: EMPTY_COPY.seen,
    rows: overview.seen.slice(0, SEEN_LIMIT).map(seenRow),
    tableId: "table-seen",
    tbodyId: "tbody-seen",
  });
  paintSection({
    emptyId: "empty-paused",
    emptyText: EMPTY_COPY.paused,
    rows: overview.paused.map(pausedRow),
    tableId: "table-paused",
    tbodyId: "tbody-paused",
  });
};

const renderMode = (overview) => {
  const always = overview.mode === "always";
  byId("mode-per-site").checked = !always;
  byId("mode-always").checked = always;
  byId("section-on").hidden = always;
  byId("section-off").hidden = always;
  byId("section-seen").hidden = always;
  byId("section-paused").hidden = !always;
  byId("paused-note").hidden = !always;
  byId("caps-note").hidden = always;
  byId("footer-actions").hidden = false;
  byId("reenable-all").disabled = overview.paused.length === 0;
};

const renderSummary = (overview) => {
  if (overview.mode === "always") {
    const paused = overview.paused.length;
    byId("summary").textContent = `${fmt(paused)} ${plural(paused, "site", "sites")} paused`;
    return;
  }
  byId("summary").textContent = [
    `${fmt(overview.protected.length)} ${plural(overview.protected.length, "site", "sites")} protected`,
    `${fmt(overview.declined.length)} left off`,
    `${fmt(overview.seen.length)} seen`,
  ].join(" · ");
};

const renderCaps = (overview) => {
  byId("caps-note").textContent =
    `Static keeps up to ${fmt(overview.caps.decisions)} site decisions and the ` +
    `${fmt(overview.caps.evidence)} most recent sites it has seen. Older entries drop off.`;
};

const rowMatches = (row, query) => {
  if (!query) return true;
  return (row.dataset.site || "").toLowerCase().includes(query);
};

const hideTableForFilter = (body, query, sectionVisible) => {
  if (!body || body.children.length === 0) return true;
  return !!query && sectionVisible === 0;
};

const applyFilter = () => {
  const input = byId("search");
  const query = input.value.trim().toLowerCase();
  let total = 0;
  let visible = 0;
  for (const section of document.querySelectorAll("#site-lists .site-section")) {
    const body = section.querySelector("tbody");
    const table = section.querySelector("table");
    let sectionVisible = 0;
    if (body) {
      for (const row of body.children) {
        const hit = rowMatches(row, query);
        row.hidden = !hit;
        total += 1;
        if (hit) sectionVisible += 1;
      }
    }
    visible += sectionVisible;
    if (table) table.hidden = hideTableForFilter(body, query, sectionVisible);
  }
  const noMatch = byId("no-match");
  const nothingVisible = !!query && total > 0 && visible === 0;
  noMatch.hidden = !nothingVisible;
  noMatch.textContent = nothingVisible ? `No sites match “${input.value.trim()}”.` : "";
};

const renderAll = () => {
  const overview = view.overview;
  if (!overview) return;
  view.mode = overview.mode;
  renderMode(overview);
  renderSummary(overview);
  renderCaps(overview);
  renderSections(overview);
  applyFilter();
};

const hideActionError = () => {
  const error = byId("action-error");
  error.hidden = true;
  error.textContent = "";
};

const showActionError = (message) => {
  const error = byId("action-error");
  error.textContent = message;
  error.hidden = false;
};

const requestOverview = async () => {
  const response = await chrome.runtime.sendMessage({ type: "static_get_sites_overview" });
  if (response == null) throw new Error("Static did not return a sites overview");
  if (typeof response === "object" && response.ok === false) {
    throw new Error(response.error || "Static could not read the sites overview");
  }
  const payload = typeof response === "object" && response.overview ? response.overview : response;
  return normalizeOverview(payload);
};

const applyOverview = (overview) => {
  view.overview = overview;
  view.mode = overview.mode;
  byId("loading").hidden = true;
  byId("site-lists").hidden = false;
  byId("error-card").hidden = true;
  byId("mode-error").hidden = true;
  hideActionError();
  renderAll();
};

const loadOverview = async ({ showLoading = false } = {}) => {
  const token = view.loadToken + 1;
  view.loadToken = token;
  if (showLoading) byId("loading").hidden = false;
  try {
    const overview = await requestOverview();
    if (token !== view.loadToken) return true;
    applyOverview(overview);
    return true;
  } catch (error) {
    if (token !== view.loadToken) return true;
    byId("loading").hidden = true;
    byId("error-text").textContent = "Static couldn't read your site list. Try again.";
    byId("error-card").hidden = false;
    console.error("[Static] sites overview failed", error);
    return false;
  }
};

const runAction = async (button, send) => {
  if (button && button.disabled) return;
  if (button) button.disabled = true;
  hideActionError();
  try {
    const response = await send();
    if (response && response.ok === false) throw new Error(response.error || "action failed");
    const loaded = await loadOverview();
    if (!loaded && button) button.disabled = false;
  } catch (error) {
    console.error("[Static] site action failed", error);
    showActionError("That change didn't save. Try again.");
    if (button) button.disabled = false;
  }
};

const setModeBusy = (busy) => {
  const section = byId("mode-section");
  section.setAttribute("aria-busy", busy ? "true" : "false");
  for (const id of MODE_BUTTONS) byId(id).disabled = busy;
};

const setModeRadios = (mode) => {
  byId("mode-per-site").checked = mode !== "always";
  byId("mode-always").checked = mode === "always";
};

const showModeError = (message) => {
  const error = byId("mode-error");
  error.textContent = message;
  error.hidden = false;
};

const changeMode = async (mode) => {
  if (mode === view.mode) return;
  const previous = view.mode;
  setModeBusy(true);
  byId("mode-error").hidden = true;
  try {
    const response = await chrome.runtime.sendMessage({ mode, type: "static_set_protection_mode" });
    if (response && response.ok === false) throw new Error(response.error || "mode change failed");
    view.mode = mode;
    await loadOverview();
  } catch (error) {
    console.error("[Static] protection mode change failed", error);
    view.mode = previous;
    setModeRadios(previous);
    showModeError("Static couldn't change the protection mode. Try again.");
  } finally {
    setModeBusy(false);
  }
};

const resetClear = (scope) => {
  const state = confirms[scope];
  const config = CLEAR_CONFIG[scope];
  state.armed = false;
  if (state.timer) window.clearTimeout(state.timer);
  state.timer = 0;
  const button = byId(config.buttonId);
  button.textContent = config.label;
  button.disabled = state.busy;
  button.removeAttribute("data-armed");
};

const runClear = async (scope) => {
  const state = confirms[scope];
  const config = CLEAR_CONFIG[scope];
  const button = byId(config.buttonId);
  if (state.timer) window.clearTimeout(state.timer);
  state.timer = 0;
  state.armed = false;
  state.busy = true;
  button.disabled = true;
  hideActionError();
  try {
    const response = await chrome.runtime.sendMessage({
      scope,
      type: "static_clear_site_decisions",
    });
    if (response && response.ok === false) throw new Error(response.error || "clear failed");
    await loadOverview();
  } catch (error) {
    console.error("[Static] clearing site decisions failed", error);
    showActionError("Static couldn't clear those sites. Try again.");
  } finally {
    state.busy = false;
    resetClear(scope);
  }
};

const handleClearClick = (scope) => {
  const state = confirms[scope];
  if (state.busy) return;
  if (state.armed) {
    runClear(scope);
    return;
  }
  state.armed = true;
  const button = byId(CLEAR_CONFIG[scope].buttonId);
  button.dataset.armed = "true";
  button.textContent = "Click again to confirm";
  state.timer = window.setTimeout(() => resetClear(scope), CONFIRM_TIMEOUT_MS);
};

const enableAllPaused = async () => {
  const overview = view.overview;
  const button = byId("reenable-all");
  if (!overview || overview.paused.length === 0 || button.disabled) return;
  button.disabled = true;
  hideActionError();
  try {
    for (const origin of overview.paused) {
      const response = await chrome.runtime.sendMessage({
        disabled: false,
        origin,
        type: "static_set_site_disabled",
      });
      if (response && response.ok === false) throw new Error(response.error || "enable failed");
    }
    await loadOverview();
  } catch (error) {
    console.error("[Static] enabling paused sites failed", error);
    showActionError("Static couldn't turn every paused site back on. Try again.");
  } finally {
    button.disabled = !view.overview || view.overview.paused.length === 0;
  }
};

const scheduleRefresh = () => {
  if (view.refreshTimer) window.clearTimeout(view.refreshTimer);
  view.refreshTimer = window.setTimeout(() => {
    view.refreshTimer = 0;
    loadOverview();
  }, STORAGE_DEBOUNCE_MS);
};

const bindModeRadios = () => {
  for (const id of MODE_BUTTONS) {
    const radio = byId(id);
    radio.addEventListener("change", () => {
      if (radio.checked) changeMode(radio.value);
    });
  }
};

const bindSearch = () => {
  byId("search").addEventListener("input", applyFilter);
};

const bindRetry = () => {
  byId("retry").addEventListener("click", () => {
    byId("error-card").hidden = true;
    loadOverview({ showLoading: true });
  });
};

const bindReenableAll = () => {
  byId("reenable-all").addEventListener("click", () => {
    enableAllPaused();
  });
};

const bindClearButtons = () => {
  for (const scope of ["seen", "all"]) {
    byId(CLEAR_CONFIG[scope].buttonId).addEventListener("click", () => handleClearClick(scope));
    resetClear(scope);
  }
};

const bindStorage = () => {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    const changed = Object.keys(changes);
    if (!changed.some((key) => WATCHED_KEYS.has(key))) return;
    scheduleRefresh();
  });
};

const boot = () => {
  bindModeRadios();
  bindSearch();
  bindRetry();
  bindReenableAll();
  bindClearButtons();
  bindStorage();
  loadOverview();
};

boot();
