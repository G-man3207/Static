/* eslint-disable max-lines, complexity -- scoring tables, evidence caps and reason copy are easier to audit together */
// Static - per-site evidence store and recommendation engine (pure).
//
// The scout reports what a page did; this module turns that into the capped
// Evidence record Static keeps in chrome.storage.local and into the plain
// language recommendation the popup shows. Everything here is deterministic
// given (evidence, context, now), so the static test harness can exercise every
// verdict band in a vm and a service-worker restart never changes a
// recommendation the user already saw on screen.
//
// Vocabulary:
//   site      decision scope (registrable domain, IP, localhost, single label)
//   defence   one of "probes" (the extension blockers run whenever a site is
//             masked), "network" (fingerprint/CAPTCHA rulesets), "device"
//             (Device signal poisoning) and "replay" (Replay poisoning).
//             A benefit counts at full weight only when its defence would
//             actually run if the user masked the site.
//   evidence  capped counts + fixed catalog keys, never page URLs or text.
(() => {
  const EMPTY_CATALOG = {
    compat: [],
    device: [],
    replay: [],
    vectors: [],
    vendors: [],
    version: 0,
  };

  const LIMITS = {
    maxCompatKeys: 24,
    maxDeviceKeys: 30,
    maxEvidenceSites: 200,
    maxPages: 1_000_000,
    maxPathKinds: 20,
    maxProbeIds: 300,
    maxProbesPerMessage: 200,
    maxProbeTotal: 1_000_000_000,
    maxReplayKeys: 20,
    maxSignalCount: 1_000_000,
    maxSiteKeyLength: 300,
    maxUaReads: 1_000_000,
    maxVectors: 24,
    maxVendorKeys: 40,
    staleAfterDays: 30,
  };

  // Probe volume → benefit points. Rounded bands keep the score stable across
  // repeat visits and make the thresholds easy to audit.
  const PROBE_BANDS = [
    { min: 5000, points: 30 },
    { min: 1000, points: 24 },
    { min: 100, points: 18 },
    { min: 20, points: 12 },
    { min: 1, points: 6 },
  ];
  const PROBE_ID_BANDS = [
    { min: 25, points: 9 },
    { min: 10, points: 6 },
    { min: 3, points: 3 },
  ];
  const PROBE_VECTOR_BANDS = [
    { min: 4, points: 6 },
    { min: 2, points: 3 },
  ];

  // A defence that is off still says something: it is a quarter-strength reason
  // to mask, and it must never be presented as if masking already hid it.
  const INACTIVE_BENEFIT_FRACTION = 0.25;
  const BENEFIT_GROUP_CAPS = {
    "device:strong": 20,
    "device:weak": 8,
    "network:bot": 20,
    "network:captcha": 10,
    "network:fingerprint": 26,
    "network:payment": 12,
    probes: 60,
    replay: 12,
  };
  const MAX_RISK = 100;

  // Perception thresholds: risk is capped per kind so a page with five fraud
  // vendors does not score as five times riskier than a sign-in page.
  const RISK_CAPS = {
    botVendors: 16,
    captchaVendors: 16,
    paymentVendors: 12,
    uaReads: 14,
  };

  const HEADLINES = {
    neutral: "No strong signal here",
    protect: {
      high: "We suggest masking here",
      low: "Masking here is probably worth it",
      medium: "Masking here is worth it",
    },
    skip: {
      high: "We suggest leaving masking off here",
      low: "Masking might get in the way here",
      medium: "Masking might get in the way here",
    },
  };

  const COMPAT_COPY = {
    bot_challenge: "Runs bot checks",
    captcha: "Shows a CAPTCHA",
    card_field: "Has a card or payment form",
    checkout_path: "Looks like a checkout or payment step",
    cross_origin_frame: "Embeds third-party sign-in frames",
    email_field: "Has an email field",
    login_path: "Is a sign-in page",
    oauth_redirect: "Redirects through third-party sign-in",
    password_field: "Has a sign-in form",
    payment_request: "Can start a payment sheet",
    trusted_types: "Enforces Trusted Types",
    webauthn: "Uses passkeys",
  };

  // Sentences read "This page has <noun> and <noun>", so the nouns carry their
  // own article (or deliberately do not, for flow/feature names).
  const COMPAT_RISK_NOUN = {
    bot_challenge: "a bot check",
    captcha: "a CAPTCHA",
    card_field: "a card or payment form",
    checkout_path: "a checkout step",
    compat_warning: "a request the page expected masked",
    email_field: "an email field",
    login_path: "a sign-in flow",
    oauth_redirect: "third-party sign-in",
    password_field: "a sign-in form",
    paused_before: "a check you paused it for",
    payment_request: "a payment sheet",
    trusted_types: "a strict security policy",
    ua_reads: "user-agent sniffing",
    webauthn: "a passkey prompt",
    // non-compat risk rows
    bot_vendor: "a bot check",
    captcha_vendor: "a CAPTCHA",
    payment_vendor: "a fraud check",
  };

  const DEFENCE_OFF_NOTE = {
    "network:bot": "Fingerprint network lists are off",
    "network:captcha": "CAPTCHA network list is off",
    "network:fingerprint": "Fingerprint network lists are off",
    "network:payment": "Fingerprint network lists are off",
    "device:strong": "Device signal poisoning is off",
    "device:weak": "Device signal poisoning is off",
    replay: "Replay poisoning is off",
  };

  const config = () => globalThis.__static_config__ || { helpers: {} };
  const helpers = () => config().helpers || {};
  const catalog = () => globalThis.__static_signals__ || EMPTY_CATALOG;

  const fmt = (value) => Math.round(value).toLocaleString("en-US");

  const countValue = (value) => {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number) || number <= 0) return 0;
    return Math.min(LIMITS.maxSignalCount, Math.round(number));
  };

  const clampInt = (value, max) => {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number) || number <= 0) return 0;
    return Math.min(max, Math.round(number));
  };

  const countMap = (value) => {
    const out = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return out;
    for (const [key, count] of Object.entries(value)) {
      if (typeof key !== "string" || !key) continue;
      const safe = countValue(count);
      if (safe > 0) out[key] = safe;
    }
    return out;
  };

  const sortByCount = (map, limit = 4) =>
    Object.entries(map || {})
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([key]) => key);

  const cappedKeys = (map, cap) => {
    const entries = Object.entries(map || {});
    if (entries.length <= cap) return entries;
    entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return entries.slice(0, cap);
  };

  const trimMap = (map, cap) => Object.fromEntries(cappedKeys(map, cap));

  const mergeInto = (target, source, cap) => {
    for (const [key, count] of Object.entries(source || {})) {
      target[key] = (target[key] || 0) + count;
    }
    const keep = new Set(cappedKeys(target, cap).map(([key]) => key));
    for (const key of Object.keys(target)) if (!keep.has(key)) delete target[key];
    return target;
  };

  const normalizedVector = (where) => {
    if (typeof where !== "string") return "unknown";
    const value = where.trim().toLowerCase();
    return /^[a-z][a-z0-9-]{0,31}$/.test(value) ? value : "unknown";
  };

  const emptyEvidence = (now) => ({
    compat: {},
    device: {},
    firstSeen: now,
    lastSeen: now,
    pages: 0,
    probes: { ids: {}, pathKinds: {}, total: 0, vectors: {} },
    replay: {},
    uaReads: 0,
    vendors: {},
  });

  const sanitizeEvidence = (entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const source = entry;
    const probes = source.probes && typeof source.probes === "object" ? source.probes : {};
    const ids = {};
    for (const [id, count] of cappedKeys(countMap(probes.ids), LIMITS.maxProbeIds)) {
      const safeId = id.toLowerCase();
      if (!/^[a-p]{32}$|^[a-f0-9-]{36}$/.test(safeId)) continue;
      ids[safeId] = count;
    }
    // Only catalog keys are meaningful to the engine; anything else in a
    // stored record is older/newer catalog drift and is dropped on read.
    const known = (value, catalogRows, cap) => {
      const wanted = catalogKeySet(catalogRows);
      const out = {};
      for (const [key, count] of cappedKeys(countMap(value), cap)) {
        if (wanted.has(key)) out[key] = count;
      }
      return out;
    };
    const evidence = {
      compat: known(source.compat, catalog().compat, LIMITS.maxCompatKeys),
      device: known(source.device, catalog().device, LIMITS.maxDeviceKeys),
      firstSeen: clampInt(source.firstSeen, Number.MAX_SAFE_INTEGER),
      lastSeen: clampInt(source.lastSeen, Number.MAX_SAFE_INTEGER),
      pages: clampInt(source.pages, LIMITS.maxPages),
      probes: {
        ids,
        pathKinds: trimMap(countMap(probes.pathKinds), LIMITS.maxPathKinds),
        total: clampInt(probes.total, LIMITS.maxProbeTotal),
        vectors: trimMap(countMap(probes.vectors), LIMITS.maxVectors),
      },
      replay: known(source.replay, catalog().replay, LIMITS.maxReplayKeys),
      uaReads: clampInt(source.uaReads, LIMITS.maxUaReads),
      vendors: known(source.vendors, catalog().vendors, LIMITS.maxVendorKeys),
    };
    if (!evidence.lastSeen) evidence.lastSeen = evidence.firstSeen;
    return evidence;
  };

  // Whitelist a scout payload entry: malformed URLs are dropped, known vectors
  // are counted, extension IDs are lowercased. This is the only place raw page
  // strings are allowed to influence stored keys, so it stays strict.
  const probePatchFor = (probes, overflow) => {
    const H = helpers();
    const patch = { ids: {}, pathKinds: {}, total: 0, vectors: {} };
    const source = Array.isArray(probes) ? probes : [];
    const list = source.slice(0, LIMITS.maxProbesPerMessage);
    patch.total = countValue(overflow) + Math.max(0, source.length - list.length);
    for (const probe of list) {
      if (!probe || typeof probe !== "object") continue;
      const url = typeof probe.url === "string" ? probe.url.slice(0, 512) : "";
      if (!url) continue;
      let id;
      let pathKind;
      try {
        id = H.extractExtId ? H.extractExtId(url) : null;
        pathKind = H.pathKindFor ? H.pathKindFor(url) : null;
      } catch {
        id = null;
      }
      if (!id || !/^[a-p]{32}$|^[a-f0-9-]{36}$/i.test(id)) continue;
      const count = countValue(probe.count);
      if (!count) continue;
      patch.total = Math.min(LIMITS.maxProbeTotal, patch.total + count);
      const safeId = id.toLowerCase();
      patch.ids[safeId] = (patch.ids[safeId] || 0) + count;
      const vector = normalizedVector(probe.where);
      patch.vectors[vector] = (patch.vectors[vector] || 0) + count;
      const kind = typeof pathKind === "string" ? pathKind : "other";
      patch.pathKinds[kind] = (patch.pathKinds[kind] || 0) + count;
    }
    return patch;
  };

  const catalogKeySet = (rows) => new Set((rows || []).map((row) => row.id));

  const signalPatchFor = (signals) => {
    const input = signals && typeof signals === "object" ? signals : {};
    const patch = {
      compat: {},
      device: {},
      replay: {},
      uaReads: countValue(input.uaReads),
      vendors: {},
    };
    const vendorKeys = catalogKeySet(catalog().vendors);
    const deviceKeys = catalogKeySet(catalog().device);
    const replayKeys = catalogKeySet(catalog().replay);
    const compatKeys = catalogKeySet(catalog().compat);
    for (const [key, count] of cappedKeys(countMap(input.vendors), LIMITS.maxVendorKeys)) {
      if (vendorKeys.has(key)) patch.vendors[key] = count;
    }
    for (const [key, count] of cappedKeys(countMap(input.device), LIMITS.maxDeviceKeys)) {
      if (deviceKeys.has(key)) patch.device[key] = count;
    }
    for (const [key, count] of cappedKeys(countMap(input.replay), LIMITS.maxReplayKeys)) {
      if (replayKeys.has(key)) patch.replay[key] = count;
    }
    for (const [key, count] of cappedKeys(countMap(input.compat), LIMITS.maxCompatKeys)) {
      if (compatKeys.has(key)) patch.compat[key] = Math.min(100, count);
    }
    return patch;
  };

  const mergeEvidence = (current, patch, now) => {
    const time = clampInt(now, Number.MAX_SAFE_INTEGER) || Date.now();
    const base = sanitizeEvidence(current) || emptyEvidence(time);
    const incoming = patch && typeof patch === "object" ? patch : {};
    const next = {
      compat: { ...base.compat },
      device: { ...base.device },
      firstSeen: base.firstSeen || time,
      lastSeen: time,
      pages: base.pages,
      probes: {
        ids: { ...base.probes.ids },
        pathKinds: { ...base.probes.pathKinds },
        total: base.probes.total,
        vectors: { ...base.probes.vectors },
      },
      replay: { ...base.replay },
      uaReads: base.uaReads,
      vendors: { ...base.vendors },
    };
    if (incoming.page) next.pages = Math.min(LIMITS.maxPages, next.pages + 1);
    if (incoming.probes) {
      next.probes.total = Math.min(
        LIMITS.maxProbeTotal,
        next.probes.total + countValue(incoming.probes.total)
      );
      mergeInto(next.probes.ids, incoming.probes.ids, LIMITS.maxProbeIds);
      mergeInto(next.probes.vectors, incoming.probes.vectors, LIMITS.maxVectors);
      mergeInto(next.probes.pathKinds, incoming.probes.pathKinds, LIMITS.maxPathKinds);
    }
    if (incoming.vendors) mergeInto(next.vendors, incoming.vendors, LIMITS.maxVendorKeys);
    if (incoming.device) mergeInto(next.device, incoming.device, LIMITS.maxDeviceKeys);
    if (incoming.replay) mergeInto(next.replay, incoming.replay, LIMITS.maxReplayKeys);
    if (incoming.compat) {
      mergeInto(next.compat, incoming.compat, LIMITS.maxCompatKeys);
      // Presence counters are hints, not traffic counters: repeated challenges
      // must not let one compat kind drown the others in risk scoring.
      for (const key of Object.keys(next.compat)) {
        next.compat[key] = Math.min(100, next.compat[key]);
      }
    }
    if (incoming.uaReads) {
      next.uaReads = Math.min(LIMITS.maxUaReads, next.uaReads + countValue(incoming.uaReads));
    }
    return next;
  };

  const sanitizePrefs = (prefs) => {
    const source = prefs && typeof prefs === "object" ? prefs : {};
    return {
      captcha_vendors: !!source.captcha_vendors,
      fingerprint_vendors: !!source.fingerprint_vendors,
    };
  };

  const contextFor = (context) => {
    const source = context && typeof context === "object" ? context : {};
    const warning =
      source.compatWarning && countValue(source.compatWarning.total) > 0
        ? source.compatWarning
        : null;
    const decision = ["on", "off"].includes(source.decision) ? source.decision : "undecided";
    return {
      compatWarning: warning,
      decision,
      fingerprintMode: source.fingerprintMode === "mask" ? "mask" : "off",
      mode: source.mode === "always" ? "always" : "per_site",
      now: clampInt(source.now, Number.MAX_SAFE_INTEGER) || Date.now(),
      pausedBefore: !!source.pausedBefore,
      replayMode: typeof source.replayMode === "string" ? source.replayMode : "off",
      rulesetPrefs: sanitizePrefs(source.rulesetPrefs),
    };
  };

  const defencesFor = (ctx) => ({
    device: ctx.fingerprintMode === "mask",
    networkCaptcha: !!ctx.rulesetPrefs.captcha_vendors,
    networkFingerprint: !!ctx.rulesetPrefs.fingerprint_vendors,
    probes: true,
    replay: ctx.replayMode !== "off",
  });

  const vendorCopy = (row) => {
    if (row.kind === "bot") return `Runs ${row.label} bot checks`;
    if (row.kind === "payment") return `Runs ${row.label} risk checks`;
    if (row.kind === "captcha") return `Loads a ${row.label} challenge`;
    return `Loads ${row.label} (device fingerprinting)`;
  };

  const bandPoints = (bands, value) => {
    const band = bands.find((entry) => value >= entry.min);
    return band ? band.points : 0;
  };

  // Every benefit row names the defence that would hide it. Inactive defences
  // contribute their note text, not the claim.
  const buildBenefitRows = (evidence, ctx, active) => {
    const rows = [];
    const probeCount = evidence.probes.total;
    const idCount = Object.keys(evidence.probes.ids).length;
    const vectorCount = Object.keys(evidence.probes.vectors).length;
    const pathKindCount = Object.keys(evidence.probes.pathKinds).length;

    if (probeCount > 0) {
      rows.push({
        active: true,
        detail: `${fmt(probeCount)} probes · ${fmt(idCount)} IDs · ${fmt(vectorCount)} request types`,
        group: "probes",
        key: "extension_checks",
        points: bandPoints(PROBE_BANDS, probeCount) + bandPoints(PROBE_ID_BANDS, idCount),
        text:
          probeCount === 1
            ? "Checked whether a browser extension is installed"
            : `Checked whether ${fmt(probeCount)} browser extensions are installed`,
      });
    }
    if (vectorCount >= 2) {
      rows.push({
        active: true,
        detail: `${fmt(vectorCount)} request types · ${fmt(pathKindCount)} resource kinds`,
        group: "probes",
        key: "probe_vectors",
        points: bandPoints(PROBE_VECTOR_BANDS, vectorCount),
        text: `Tried ${fmt(vectorCount)} ways to detect extensions`,
      });
    }

    for (const id of sortByCount(evidence.vendors, LIMITS.maxVendorKeys)) {
      const row = catalog().vendors.find((entry) => entry.id === id);
      if (!row) continue;
      const weight = row.weight || 8;
      if (row.kind === "captcha") {
        rows.push({
          active: active.networkCaptcha,
          defense: "network",
          defenseNote: "CAPTCHA network list is off",
          group: "network:captcha",
          key: `vendor:${id}`,
          points: weight,
          text: vendorCopy(row),
        });
        continue;
      }
      const group =
        row.kind === "bot"
          ? "network:bot"
          : row.kind === "payment"
            ? "network:payment"
            : "network:fingerprint";
      rows.push({
        active: active.networkFingerprint,
        defense: "network",
        defenseNote: DEFENCE_OFF_NOTE[group],
        group,
        key: `vendor:${id}`,
        points: weight,
        text: vendorCopy(row),
      });
    }
    for (const id of sortByCount(evidence.device, LIMITS.maxDeviceKeys)) {
      const row = catalog().device.find((entry) => entry.id === id);
      const weight = row ? row.weight || (row.kind === "strong" ? 5 : 2) : 2;
      const strong = !row || row.kind === "strong";
      rows.push({
        active: active.device,
        defense: "device",
        defenseNote: DEFENCE_OFF_NOTE[strong ? "device:strong" : "device:weak"],
        group: strong ? "device:strong" : "device:weak",
        key: `device:${id}`,
        points: weight,
        text: `Read your ${row ? row.label : "device signals"}`,
      });
    }
    for (const id of sortByCount(evidence.replay, LIMITS.maxReplayKeys)) {
      const row = catalog().replay.find((entry) => entry.id === id);
      const weight = row ? row.weight || 6 : 6;
      rows.push({
        active: active.replay,
        defense: "replay",
        defenseNote: DEFENCE_OFF_NOTE.replay,
        group: "replay",
        key: `replay:${id}`,
        points: weight,
        text: `${row ? row.label : id} can record this page`,
      });
    }

    // Apply the per-group caps to raw points before the active/inactive split.
    // A page that loads six vendors should not outrank a page that probed for
    // thousands of extensions just by stacking vendor rows.
    const capped = [];
    for (const group of Object.keys(BENEFIT_GROUP_CAPS)) {
      const list = rows.filter((row) => row.group === group).sort((a, b) => b.points - a.points);
      let budget = BENEFIT_GROUP_CAPS[group];
      for (const row of list) {
        row.points = Math.min(row.points, budget);
        budget -= row.points;
        if (row.points > 0) capped.push(row);
      }
    }
    return capped;
  };

  const compatCountMultiplier = (id, count) =>
    ["captcha", "bot_challenge", "cross_origin_frame"].includes(id)
      ? Math.min(3, Math.max(1, count))
      : 1;

  const buildRiskRows = (evidence, ctx) => {
    const rows = [];
    if (ctx.compatWarning) {
      const kinds =
        Array.isArray(ctx.compatWarning.kinds) && ctx.compatWarning.kinds.length > 0
          ? ctx.compatWarning.kinds
              .map(([kind, count]) => `${kind} ×${count}`)
              .slice(0, 2)
              .join(", ")
          : undefined;
      rows.push({
        detail: kinds,
        key: "compat_warning",
        points: 25,
        text: "Masking already interrupted a request here",
      });
    }
    const compatRows = catalog().compat.map((row) => ({
      count: evidence.compat[row.id] || 0,
      row,
    }));
    for (const { row, count } of compatRows) {
      if (!count) continue;
      rows.push({
        detail: row.id === "cross_origin_frame" ? `${fmt(count)} cross-site frames` : undefined,
        key: `compat:${row.id}`,
        points: Math.round((row.risk || 4) * compatCountMultiplier(row.id, count)),
        text: COMPAT_COPY[row.id] || `Has ${row.label}`,
      });
    }

    const botRows = catalog().vendors.filter(
      (row) => row.kind === "bot" && evidence.vendors[row.id]
    );
    if (botRows.length > 0) {
      const points = botRows.reduce((total) => total + 8, 0);
      rows.push({
        key: "bot_vendor",
        points: Math.min(RISK_CAPS.botVendors, points),
        text: `A bot check guards this page (${botRows.map((row) => row.label).join(", ")})`,
      });
    }
    const paymentRows = catalog().vendors.filter(
      (row) => row.kind === "payment" && evidence.vendors[row.id]
    );
    if (paymentRows.length > 0) {
      const points = paymentRows.reduce((total) => total + 6, 0);
      rows.push({
        key: "payment_vendor",
        points: Math.min(RISK_CAPS.paymentVendors, points),
        text: `A fraud check screens this page (${paymentRows.map((row) => row.label).join(", ")})`,
      });
    }
    const captchaRows = catalog().vendors.filter(
      (row) => row.kind === "captcha" && evidence.vendors[row.id]
    );
    if (captchaRows.length > 0 && !evidence.compat.captcha) {
      rows.push({
        key: "captcha_vendor",
        points: Math.min(
          RISK_CAPS.captchaVendors,
          captchaRows.reduce((total) => total + 8, 0)
        ),
        text: "Shows a CAPTCHA challenge",
      });
    }
    if (evidence.uaReads >= 8) {
      rows.push({
        detail: evidence.uaReads >= 40 ? "heavy sniffing" : "light sniffing",
        key: "ua_reads",
        points: evidence.uaReads >= 40 ? RISK_CAPS.uaReads : 8,
        text: `Reads your browser user agent ${fmt(evidence.uaReads)} times`,
      });
    }
    if (ctx.pausedBefore) {
      rows.push({
        key: "paused_before",
        points: 18,
        text: "You paused Static here before",
      });
    }
    rows.sort((a, b) => b.points - a.points);
    return rows;
  };

  // Documented decision matrix, top to bottom, first match wins. Confidence is
  // part of each band rather than a separate margin formula: "a sign-in form on
  // its own" is a low-confidence skip, while the same form under a heavy probe
  // load is still a skip but with enough evidence to matter.
  const verdictFor = (benefit, risk) => {
    if (benefit < 8 && risk < 8) return { confidence: "low", verdict: "neutral" };
    if (risk >= 25 && benefit < risk * 1.5) {
      const high = risk >= 45 || benefit < risk * 0.75;
      return { confidence: high ? "high" : "medium", verdict: "skip" };
    }
    if (benefit >= 18 && benefit - risk >= 12) {
      const high = benefit - risk >= 35 || benefit >= 50;
      return { confidence: high ? "high" : "medium", verdict: "protect" };
    }
    if (benefit >= 12 && benefit - risk > 0) {
      return { confidence: "low", verdict: "protect" };
    }
    if (risk >= 15 && benefit - risk < 0) {
      const high = risk - benefit >= 25 || risk >= 35;
      return { confidence: high ? "high" : "medium", verdict: "skip" };
    }
    if (risk >= 10 && benefit - risk <= 0) {
      return { confidence: "low", verdict: "skip" };
    }
    return { confidence: "low", verdict: "neutral" };
  };

  const joinEnglish = (items) =>
    items.length <= 1
      ? items.join("")
      : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

  const riskNounFor = (row) => {
    const key = row.key.replace(/^compat:/, "");
    return COMPAT_RISK_NOUN[key] || COMPAT_RISK_NOUN[row.key] || row.text.toLowerCase();
  };

  // Only the defences that are actually on may be claimed in the summary: a
  // page can load FingerprintJS while the network lists are off, and then the
  // sentence must not say masking hides it.
  const benefitParts = (evidence, ctx) => {
    const parts = [];
    if (evidence.probes.total > 0) {
      const ids = Object.keys(evidence.probes.ids).length;
      parts.push(
        ids >= 3
          ? `checked for ${fmt(ids)} installed extensions`
          : `ran ${fmt(evidence.probes.total)} extension checks`
      );
    }
    const fingerprintVendor = catalog().vendors.find(
      (row) =>
        row.kind === "fingerprint" &&
        evidence.vendors[row.id] &&
        ctx.rulesetPrefs.fingerprint_vendors
    );
    if (fingerprintVendor) parts.push(`loads ${fingerprintVendor.label}`);
    if (Object.keys(evidence.device).length > 0 && ctx.fingerprintMode === "mask") {
      parts.push("reads device signals");
    }
    if (Object.keys(evidence.replay).length > 0 && ctx.replayMode !== "off") {
      parts.push("can record the session");
    }
    return parts;
  };

  const summaryFor = (verdict, evidence, ctx, reasons) => {
    const { notes, risks } = reasons;
    if (verdict === "neutral") {
      if (
        notes.length > 0 &&
        Object.keys(evidence.device).length + Object.keys(evidence.vendors).length > 0
      ) {
        return "This page profiles you, but the masking that would hide it is switched off.";
      }
      if (evidence.probes.total > 0) {
        return "Nothing conclusive here. Turn masking on if you would rather not be checked.";
      }
      return "Static hasn't seen this page do anything it can mask. A reload gives it another look.";
    }
    if (verdict === "skip") {
      const nouns = [];
      for (const row of risks) {
        const noun = riskNounFor(row);
        if (noun && !nouns.includes(noun)) nouns.push(noun);
      }
      const flow = nouns.length > 0 ? joinEnglish(nouns.slice(0, 2)) : "checks masking can disturb";
      return `This page has ${flow}. Masking here is more likely to trip it than to help.`;
    }
    const parts = benefitParts(evidence, ctx);
    const lead = parts.length > 0 ? `This page ${joinEnglish(parts)}` : "This page profiles you";
    const tail =
      risks.length > 0 && risks[0].points >= 15
        ? " Masking hides it, but sign-in may need a second try."
        : " Masking hides that.";
    return `${lead}.${tail}`;
  };

  const displayBenefit = (row) => {
    if (row.active) {
      return {
        defense: row.defense,
        detail: row.detail,
        key: row.key,
        text: row.text,
        weight: row.points,
      };
    }
    return {
      defense: row.defense,
      detail: row.defenseNote,
      key: row.key,
      text: row.text,
      weight: row.points,
    };
  };

  const recommendationFor = (evidenceInput, contextInput) => {
    const ctx = contextFor(contextInput);
    const evidence = sanitizeEvidence(evidenceInput);
    const active = defencesFor(ctx);
    const base = {
      benefit: 0,
      benefits: [],
      benefitCount: 0,
      caution: false,
      confidence: "low",
      confidenceScore: 0,
      decisionHint: "Your call",
      headline: HEADLINES.neutral,
      margin: 0,
      noteCount: 0,
      notes: [],
      observed: false,
      risk: 0,
      risks: [],
      riskCount: 0,
      stale: false,
      summary: "Static hasn't seen this page do anything it can mask.",
      verdict: "neutral",
    };
    if (!evidence) return base;

    const observed =
      evidence.probes.total > 0 ||
      Object.keys(evidence.vendors).length > 0 ||
      Object.keys(evidence.device).length > 0 ||
      Object.keys(evidence.replay).length > 0 ||
      Object.keys(evidence.compat).length > 0 ||
      evidence.uaReads > 0;
    if (!observed) return base;

    const rows = buildBenefitRows(evidence, ctx, active);
    const activeRows = rows.filter((row) => row.active).sort((a, b) => b.points - a.points);
    const inactiveRows = rows.filter((row) => !row.active).sort((a, b) => b.points - a.points);
    const benefit = Math.round(
      activeRows.reduce((total, row) => total + row.points, 0) +
        inactiveRows.reduce((total, row) => total + row.points, 0) * INACTIVE_BENEFIT_FRACTION
    );

    const risks = buildRiskRows(evidence, ctx);
    const risk = Math.min(
      MAX_RISK,
      risks.reduce((total, row) => total + row.points, 0)
    );

    const ageMs = Math.max(0, ctx.now - (evidence.lastSeen || ctx.now));
    const stale = ageMs > LIMITS.staleAfterDays * 86_400_000;

    const band = verdictFor(benefit, risk);
    let verdict = band.verdict;
    let confidence = band.confidence;
    let caution = verdict === "protect" && risk >= 20;
    if (ctx.compatWarning) {
      verdict = "skip";
      confidence = "high";
      caution = false;
    } else if (stale) {
      confidence = "low";
      if (ctx.decision === "undecided") verdict = "neutral";
    }
    if (verdict === "protect" && activeRows.length === 0) verdict = "neutral";

    const benefits = (verdict === "neutral" ? activeRows.slice(0, 2) : activeRows.slice(0, 3)).map(
      displayBenefit
    );
    const notes = inactiveRows
      .slice(0, 2)
      .map(displayBenefit)
      .map((row) => ({
        detail: row.detail,
        key: row.key,
        text: row.text,
      }));
    const displayRisks = risks.slice(0, 3).map((row) => ({
      detail: row.detail,
      key: row.key,
      text: row.text,
      weight: row.points,
    }));

    const summary = stale
      ? "Nothing seen here in the last month. A fresh visit will reassess."
      : summaryFor(verdict, evidence, ctx, { notes, risks });

    return {
      benefit,
      benefits,
      benefitCount: activeRows.length,
      caution,
      confidence,
      confidenceScore: Math.max(
        0,
        Math.min(
          100,
          Math.round(40 + Math.abs(benefit - risk) * 0.8 + (confidence === "high" ? 20 : 0))
        )
      ),
      decisionHint:
        verdict === "protect"
          ? "Protect this site"
          : verdict === "skip"
            ? "Leave it off"
            : "Your call",
      headline:
        HEADLINES[verdict] && typeof HEADLINES[verdict] === "object"
          ? HEADLINES[verdict][confidence] || HEADLINES[verdict].low
          : HEADLINES.neutral,
      margin: benefit - risk,
      noteCount: inactiveRows.length,
      notes,
      observed,
      risk,
      risks: displayRisks,
      riskCount: risks.length,
      stale,
      summary,
      verdict,
    };
  };

  const evidenceSummaryFor = (evidenceInput) => {
    const evidence = sanitizeEvidence(evidenceInput);
    if (!evidence) return null;
    const labels = [];
    for (const id of sortByCount(evidence.vendors, LIMITS.maxVendorKeys)) {
      const row = catalog().vendors.find((entry) => entry.id === id);
      if (row) labels.push(row.label);
    }
    for (const id of sortByCount(evidence.compat, LIMITS.maxCompatKeys)) {
      if (["password_field", "card_field", "bot_challenge", "captcha"].includes(id)) {
        const text = COMPAT_COPY[id];
        if (text) labels.push(text.replace(/^(Has|Is|Runs|Shows|Looks like) /, ""));
      }
    }
    for (const id of sortByCount(evidence.device, LIMITS.maxDeviceKeys).slice(0, 1)) {
      const row = catalog().device.find((entry) => entry.id === id);
      if (row) labels.push(row.label);
    }
    if (evidence.uaReads >= 8) labels.push("user-agent sniffing");
    return {
      compatKeys: sortByCount(evidence.compat),
      deviceKeys: sortByCount(evidence.device),
      firstSeen: evidence.firstSeen,
      labels: labels.slice(0, 3),
      lastSeen: evidence.lastSeen,
      pages: evidence.pages,
      probeIds: Object.keys(evidence.probes.ids).length,
      probeTotal: evidence.probes.total,
      probeVectors: Object.keys(evidence.probes.vectors).length,
      replayKeys: sortByCount(evidence.replay),
      uaReads: evidence.uaReads,
      vendorKeys: sortByCount(evidence.vendors),
    };
  };

  const summarizeEvidence = (evidenceInput) => {
    const summary = evidenceSummaryFor(evidenceInput);
    if (!summary) return "";
    const parts = [];
    if (summary.probeTotal > 0) {
      parts.push(
        `${fmt(summary.probeTotal)} extension ${summary.probeTotal === 1 ? "check" : "checks"}`
      );
    }
    for (const label of summary.labels) {
      if (parts.length >= 3) break;
      if (!parts.includes(label)) parts.push(label);
    }
    return parts.join(" · ");
  };

  globalThis.__static_site_signals__ = {
    COMPAT_COPY,
    HEADLINES,
    LIMITS,
    emptyEvidence,
    evidenceSummaryFor,
    mergeEvidence,
    probePatchFor,
    recommendationFor,
    sanitizeEvidence,
    sanitizePrefs,
    signalPatchFor,
    summarizeEvidence,
  };
})();
