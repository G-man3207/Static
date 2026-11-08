// Static — declarativeNetRequest gating for the per-site protection mode.
//
// Loaded by the service worker via importScripts() (after lists.js and the
// site-signal helpers) and directly by the Node/vm test harness.  Owns the
// mapping between `protection_mode` and the network vendor lists:
//
//   "always"   — exactly the preferred static rulesets are enabled and every
//                scoped dynamic rule is removed (today's behavior).
//   "per_site" — static rulesets are disabled; each rule of the preferred
//                rulesets gets a dynamic twin restricted with
//                `condition.initiatorDomains = <protected sites>`.
//
// The file has no DOM and no dependency on another Static file, so unit tests
// can load it with a mock chrome (or with nothing at all).
globalThis.__static_site_dnr__ = (() => {
  const RULESET_IDS = ["fingerprint_vendors", "captcha_vendors"];
  const DEFAULT_PREFS = Object.freeze({
    fingerprint_vendors: true,
    captcha_vendors: false,
  });
  // Dynamic rule ids park above every other Static range: header rules are
  // 10k-29.9k, pause allows 30k-39.9k, bare-host outrank 40k-40.9k.
  const SCOPED_RULE_ID_BASE = 50000;
  const SCOPED_RULE_ID_MAX = 59999;
  // One ruleset occupies a 1,000-id block, so a static rule id must stay below
  // 1,000 to keep its scoped twin unique.
  const RULE_ID_STRIDE = 1000;
  // The service worker already caps site decisions; this is defense in depth
  // for the initiatorDomains array carried by every scoped rule.
  const MAX_SCOPED_SITES = 250;

  // Parsed rules/*.json, cached after the first successful load.  Cleared when
  // a load fails so the next apply() retries instead of caching a rejection.
  let rulesetsPromise = null;
  // apply() calls run one at a time: a mode / pref / site change can arrive
  // while another is in flight, and interleaved updateDynamicRules() calls
  // would leave rules from both settings behind.
  let applyChain = Promise.resolve();

  const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

  const asError = (err, context) => {
    if (err instanceof Error) return err;
    return new Error(`Static DNR gating: ${context}: ${String(err)}`);
  };

  const errorText = (err) => (err instanceof Error ? err.message : String(err));

  const dnrApi = () => {
    const api = globalThis.chrome && globalThis.chrome.declarativeNetRequest;
    if (!api) throw new Error("Static DNR gating: chrome.declarativeNetRequest is unavailable");
    return api;
  };

  const rulesetUrl = (rulesetId) => {
    const runtime = globalThis.chrome && globalThis.chrome.runtime;
    if (!runtime || typeof runtime.getURL !== "function") {
      throw new Error("Static DNR gating: chrome.runtime.getURL is unavailable");
    }
    return runtime.getURL(`rules/${rulesetId}.json`);
  };

  const ruleIdFor = (rulesetIndex, staticRuleId) =>
    SCOPED_RULE_ID_BASE + rulesetIndex * RULE_ID_STRIDE + staticRuleId;

  const isScopedRuleId = (id) =>
    typeof id === "number" &&
    Number.isInteger(id) &&
    id >= SCOPED_RULE_ID_BASE &&
    id <= SCOPED_RULE_ID_MAX;

  const normalizePrefs = (prefs) => ({
    ...DEFAULT_PREFS,
    ...(isObject(prefs) ? prefs : {}),
  });

  // ids whose preference is truthy, sorted for stable comparisons/calls.
  const staticRulesetsFor = (prefs) => {
    const source = isObject(prefs) ? prefs : DEFAULT_PREFS;
    return RULESET_IDS.filter((rulesetId) => !!source[rulesetId]).sort();
  };

  // Site keys are registrable domains or bare hosts: case-insensitive, deduped,
  // sorted, capped.  Decisions never carry a scheme, port or path.
  const normalizeSites = (sites) => {
    if (!Array.isArray(sites)) return [];
    const unique = new Set();
    for (const site of sites) {
      if (typeof site !== "string") continue;
      const key = site.trim().toLowerCase();
      if (key) unique.add(key);
    }
    return [...unique].sort().slice(0, MAX_SCOPED_SITES);
  };

  const validateRule = (rulesetId, rule, index, seenIds) => {
    const where = `rules/${rulesetId}.json rule #${index}`;
    if (!isObject(rule)) throw new Error(`Static DNR rules: ${where} must be an object`);
    if (!Number.isInteger(rule.id)) {
      throw new Error(`Static DNR rules: ${where} "id" must be an integer`);
    }
    if (seenIds.has(rule.id)) {
      throw new Error(`Static DNR rules: ${where} duplicates id ${rule.id}`);
    }
    seenIds.add(rule.id);
    if (!isObject(rule.action)) {
      throw new Error(`Static DNR rules: ${where} "action" must be an object`);
    }
    if (!isObject(rule.condition)) {
      throw new Error(`Static DNR rules: ${where} "condition" must be an object`);
    }
    const { urlFilter, regexFilter } = rule.condition;
    if (typeof urlFilter !== "string" && typeof regexFilter !== "string") {
      throw new Error(`Static DNR rules: ${where} needs a string "urlFilter" or "regexFilter"`);
    }
    if (!Array.isArray(rule.condition.resourceTypes)) {
      throw new Error(`Static DNR rules: ${where} "condition.resourceTypes" must be an array`);
    }
  };

  const validateRuleset = (rulesetId, rules) => {
    if (!Array.isArray(rules)) {
      throw new Error(`Static DNR rules: rules/${rulesetId}.json must be a JSON array`);
    }
    const seenIds = new Set();
    rules.forEach((rule, index) => validateRule(rulesetId, rule, index, seenIds));
  };

  // True when this context can read the packaged rule JSON at all.  In a real
  // extension worker both APIs exist; the check only keeps `always` usable in
  // harnesses that mock chrome.declarativeNetRequest alone.
  const canLoadRulesets = () => {
    const runtime = globalThis.chrome && globalThis.chrome.runtime;
    return (
      typeof globalThis.fetch === "function" && !!runtime && typeof runtime.getURL === "function"
    );
  };

  const fetchRuleset = async (rulesetId) => {
    const url = rulesetUrl(rulesetId);
    if (typeof globalThis.fetch !== "function") {
      throw new Error("Static DNR rules: fetch is unavailable in this context");
    }
    let response;
    try {
      response = await globalThis.fetch(url, { cache: "no-store" });
    } catch (err) {
      throw new Error(
        `Static DNR rules: could not fetch rules/${rulesetId}.json: ${errorText(err)}`,
        { cause: err }
      );
    }
    if (response && response.ok === false) {
      throw new Error(`Static DNR rules: rules/${rulesetId}.json returned HTTP ${response.status}`);
    }
    let rules;
    try {
      rules = typeof response.json === "function" ? await response.json() : response;
    } catch (err) {
      throw new Error(
        `Static DNR rules: could not parse rules/${rulesetId}.json: ${errorText(err)}`,
        { cause: err }
      );
    }
    validateRuleset(rulesetId, rules);
    return rules;
  };

  const loadRulesets = () => {
    if (rulesetsPromise) return rulesetsPromise;
    rulesetsPromise = Promise.all(RULESET_IDS.map((rulesetId) => fetchRuleset(rulesetId)))
      .then((loaded) =>
        Object.fromEntries(RULESET_IDS.map((rulesetId, index) => [rulesetId, loaded[index]]))
      )
      .catch((err) => {
        rulesetsPromise = null;
        throw asError(err, "load rulesets");
      });
    return rulesetsPromise;
  };

  // The pure rule builder: one scoped copy of every rule in the given rulesets.
  // The source condition is copied exactly (urlFilter/regexFilter/resourceTypes
  // included) so the Firefox build stays valid after it strips resource types.
  const scopedRuleFor = (rule, rulesetIndex, ruleIndex, scopedSites) => {
    const rulesetId = RULESET_IDS[rulesetIndex];
    if (!isObject(rule) || !Number.isInteger(rule.id)) {
      throw new Error(`Static DNR gating: ${rulesetId} rule #${ruleIndex} needs an integer id`);
    }
    if (rule.id < 0 || rule.id >= RULE_ID_STRIDE) {
      throw new Error(
        `Static DNR gating: ${rulesetId} rule id ${rule.id} must be below ${RULE_ID_STRIDE}`
      );
    }
    return {
      id: ruleIdFor(rulesetIndex, rule.id),
      priority: rule.priority ?? 1,
      action: rule.action,
      condition: { ...rule.condition, initiatorDomains: [...scopedSites] },
    };
  };

  const scopedRulesFor = (rulesets, sites) => {
    const scopedSites = normalizeSites(sites);
    if (scopedSites.length === 0) return [];
    const rules = [];
    RULESET_IDS.forEach((rulesetId, rulesetIndex) => {
      const source = rulesets && rulesets[rulesetId];
      if (source == null) return;
      if (!Array.isArray(source)) {
        throw new Error(`Static DNR gating: ruleset "${rulesetId}" must be an array of rules`);
      }
      source.forEach((rule, ruleIndex) => {
        rules.push(scopedRuleFor(rule, rulesetIndex, ruleIndex, scopedSites));
      });
    });
    return rules;
  };

  const rulesetsForEnabledPrefs = (rulesets, prefs) => {
    const enabled = {};
    for (const rulesetId of staticRulesetsFor(prefs)) {
      if (!rulesets || !Array.isArray(rulesets[rulesetId])) {
        throw new Error(`Static DNR gating: ruleset "${rulesetId}" is not loaded`);
      }
      enabled[rulesetId] = rulesets[rulesetId];
    }
    return enabled;
  };

  const scopedIdsIn = (rules) =>
    (Array.isArray(rules) ? rules : [])
      .map((rule) => rule && rule.id)
      .filter((id) => isScopedRuleId(id));

  const readDynamicRules = async (dnr) => {
    try {
      const live = await dnr.getDynamicRules();
      return Array.isArray(live) ? live : [];
    } catch (err) {
      throw asError(err, "read dynamic rules");
    }
  };

  const updateDynamicRules = async (dnr, update, label) => {
    try {
      await dnr.updateDynamicRules(update);
    } catch (err) {
      throw asError(err, `update dynamic rules (${label})`);
    }
  };

  const updateEnabledRulesets = async (dnr, update, label) => {
    try {
      await dnr.updateEnabledRulesets(update);
    } catch (err) {
      throw asError(err, `update static rulesets (${label})`);
    }
  };

  const enableStaticRulesets = async (dnr, wanted) => {
    let live;
    try {
      live = await dnr.getEnabledRulesets();
    } catch (err) {
      throw asError(err, "read enabled static rulesets");
    }
    const enabled = new Set(Array.isArray(live) ? live : []);
    const enableRulesetIds = wanted.filter((rulesetId) => !enabled.has(rulesetId));
    const disableRulesetIds = RULESET_IDS.filter(
      (rulesetId) => !wanted.includes(rulesetId) && enabled.has(rulesetId)
    );
    if (enableRulesetIds.length === 0 && disableRulesetIds.length === 0) return;
    await updateEnabledRulesets(dnr, { disableRulesetIds, enableRulesetIds }, "always");
  };

  const disableStaticRulesets = (dnr) =>
    updateEnabledRulesets(dnr, { disableRulesetIds: [...RULESET_IDS] }, "per_site");

  // Replace the scoped dynamic rules in one call when possible.  Chrome can
  // reject a combined remove+add when the result would exceed the per-update
  // rule budget, so fall back to the equivalent remove-then-add pair.
  const replaceScopedRules = async (dnr, removeRuleIds, addRules) => {
    if (removeRuleIds.length === 0 && addRules.length === 0) return 0;
    if (removeRuleIds.length === 0) {
      await updateDynamicRules(dnr, { addRules }, "add scoped");
      return addRules.length;
    }
    if (addRules.length === 0) {
      await updateDynamicRules(dnr, { removeRuleIds }, "remove scoped");
      return 0;
    }
    try {
      await dnr.updateDynamicRules({ addRules, removeRuleIds });
      return addRules.length;
    } catch {
      await updateDynamicRules(dnr, { removeRuleIds }, "remove scoped (fallback)");
      await updateDynamicRules(dnr, { addRules }, "add scoped (fallback)");
      return addRules.length;
    }
  };

  const applyAlways = async (dnr, prefs) => {
    const wanted = staticRulesetsFor(prefs);
    await enableStaticRulesets(dnr, wanted);
    const live = await readDynamicRules(dnr);
    const removeRuleIds = scopedIdsIn(live);
    if (removeRuleIds.length > 0) {
      await updateDynamicRules(dnr, { removeRuleIds }, "remove scoped");
    }
    return { ok: true, staticRulesets: wanted, scopedRules: 0 };
  };

  const applyPerSite = async (dnr, prefs, sites, rulesets) => {
    // Build (and validate) the scoped rules before touching the static state: a
    // bad ruleset must not leave the extension half switched over.
    const scopedRules = scopedRulesFor(rulesetsForEnabledPrefs(rulesets, prefs), sites);
    await disableStaticRulesets(dnr);
    const live = await readDynamicRules(dnr);
    const scopedRulesCount = await replaceScopedRules(dnr, scopedIdsIn(live), scopedRules);
    return { ok: true, staticRulesets: [], scopedRules: scopedRulesCount };
  };

  const modeOf = (mode) => {
    if (mode === "always") return "always";
    if (mode === "per_site") return "per_site";
    throw new Error('Static DNR gating: mode must be "always" or "per_site"');
  };

  const applyNow = async (options) => {
    const settings = isObject(options) ? options : {};
    const mode = modeOf(settings.mode);
    const prefs = normalizePrefs(settings.prefs);
    const dnr = dnrApi();
    // Both real modes read the rulesets first: always does not use their
    // contents, but a broken ruleset must fail the same way instead of
    // half-applying.  A harness with no runtime/fetch can still drive always.
    if (mode === "always" && !canLoadRulesets()) return applyAlways(dnr, prefs);
    const rulesets = await loadRulesets();
    if (mode === "always") return applyAlways(dnr, prefs);
    return applyPerSite(dnr, prefs, normalizeSites(settings.sites), rulesets);
  };

  const apply = (options) => {
    const run = applyChain.then(() => applyNow(options));
    applyChain = run.then(
      () => undefined,
      () => undefined
    );
    return run.catch((err) => {
      throw asError(err, "apply");
    });
  };

  const capturePrefs = async (defaults) => {
    const fallback = normalizePrefs(defaults);
    try {
      const enabled = await dnrApi().getEnabledRulesets();
      const enabledIds = new Set(Array.isArray(enabled) ? enabled : []);
      const prefs = {};
      for (const rulesetId of RULESET_IDS) prefs[rulesetId] = enabledIds.has(rulesetId);
      return prefs;
    } catch {
      return fallback;
    }
  };

  const currentScopedRuleIds = async () => {
    try {
      return scopedIdsIn(await dnrApi().getDynamicRules());
    } catch {
      return [];
    }
  };

  return {
    DEFAULT_PREFS,
    RULESET_IDS,
    SCOPED_RULE_ID_BASE,
    apply,
    capturePrefs,
    currentScopedRuleIds,
    isScopedRuleId,
    loadRulesets,
    ruleIdFor,
    scopedRulesFor,
    staticRulesetsFor,
  };
})();
