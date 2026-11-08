/* global messageHandlers */
// Static — site_dnr.js tests (declarativeNetRequest gating for per-site mode).
//
// The vm cases load the real rules/*.json files and a mock
// chrome.declarativeNetRequest, so id/scoping/state-transition behavior is
// checked without a browser.  The E2E case drives the loaded extension: Chrome
// is the final authority on which dynamic rules are accepted.
const { expect, test: base } = require("@playwright/test");
const { test: extensionTest } = require("./helpers/extension-fixture");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repoRoot = path.resolve(__dirname, "..");
const readText = (file) => fs.readFileSync(path.join(repoRoot, file), "utf8");
const readJson = (file) => JSON.parse(readText(file));

const RULESET_IDS = ["fingerprint_vendors", "captcha_vendors"];
const RULES = Object.fromEntries(RULESET_IDS.map((id) => [id, readJson(`rules/${id}.json`)]));
const RULE_COUNTS = Object.fromEntries(RULESET_IDS.map((id) => [id, RULES[id].length]));
const DEFAULT_PREFS = { captcha_vendors: false, fingerprint_vendors: true };
const SCOPED_MIN = 50000;
const SCOPED_MAX = 59999;

const clone = (value) => JSON.parse(JSON.stringify(value));

const delay = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const rulesetIdFromUrl = (url) => {
  const match = /\/rules\/([^/]+)\.json$/.exec(url);
  return match ? match[1] : null;
};

const jsonResponse = (rules, status = 200) => ({
  json: async () => clone(rules),
  ok: status >= 200 && status < 300,
  status,
});

// Never throw on a rejection: return it so a test can assert it is an Error.
const captureError = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("Expected the promise to reject");
};

const captureThrow = (fn) => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("Expected the function to throw");
};

const scopedRulesOf = (state) =>
  state.dynamic
    .filter((rule) => rule.id >= SCOPED_MIN && rule.id <= SCOPED_MAX)
    .sort((a, b) => a.id - b.id);

const scopedIdsOf = (state) => scopedRulesOf(state).map((rule) => rule.id);

// In-memory chrome.declarativeNetRequest.  Mutations are applied only after the
// hooks resolve, so a throwing hook behaves like a rejected Chrome update.
const createDnrMock = (options = {}) => {
  const state = {
    dynamic: clone(options.dynamic || []),
    enabled: [...(options.enabled || [])],
  };
  const calls = {
    getDynamicRules: 0,
    getEnabledRulesets: 0,
    updateDynamicRules: [],
    updateEnabledRulesets: [],
  };
  const hooks = { ...(options.hooks || {}) };

  const api = {
    async getDynamicRules() {
      calls.getDynamicRules += 1;
      if (hooks.getDynamicRules) await hooks.getDynamicRules();
      return clone(state.dynamic);
    },
    async getEnabledRulesets() {
      calls.getEnabledRulesets += 1;
      if (hooks.getEnabledRulesets) await hooks.getEnabledRulesets();
      return [...state.enabled];
    },
    async updateDynamicRules(update) {
      calls.updateDynamicRules.push(clone(update));
      if (hooks.updateDynamicRules) await hooks.updateDynamicRules(update);
      const removeRuleIds = new Set(update.removeRuleIds || []);
      const next = state.dynamic.filter((rule) => !removeRuleIds.has(rule.id));
      const ids = new Set(next.map((rule) => rule.id));
      for (const rule of update.addRules || []) {
        if (ids.has(rule.id)) {
          throw new Error(`Rule with id ${rule.id} does not have a unique ID`);
        }
        ids.add(rule.id);
        next.push(clone(rule));
      }
      state.dynamic = next;
    },
    async updateEnabledRulesets(update) {
      calls.updateEnabledRulesets.push(clone(update));
      if (hooks.updateEnabledRulesets) await hooks.updateEnabledRulesets(update);
      const disableRulesetIds = update.disableRulesetIds || [];
      for (const rulesetId of disableRulesetIds) {
        if (!RULESET_IDS.includes(rulesetId)) throw new Error(`Unknown ruleset: ${rulesetId}`);
      }
      state.enabled = state.enabled.filter((id) => !disableRulesetIds.includes(id));
      for (const rulesetId of update.enableRulesetIds || []) {
        if (!state.enabled.includes(rulesetId)) state.enabled.push(rulesetId);
      }
    },
  };
  return { api, calls, hooks, state };
};

// Loads site_dnr.js in a fresh vm context.  The fetch stub counts calls and
// maps the extension URL back to the real rules/*.json content.
const createHarness = (options = {}) => {
  const dnr = createDnrMock({
    dynamic: options.dynamic,
    enabled: options.enabled,
    hooks: options.hooks,
  });
  const fetchCalls = [];
  const sourceFetch = options.fetch || (async (url) => jsonResponse(RULES[rulesetIdFromUrl(url)]));
  const fetchImpl = async (url, init) => {
    fetchCalls.push({ init, url });
    return sourceFetch(url, init);
  };
  const chrome = options.chrome || {
    declarativeNetRequest: dnr.api,
    runtime: { getURL: (file) => `chrome-extension://static-test/${file}` },
  };
  const context = vm.createContext({
    chrome,
    console,
    Error,
    Promise,
    TypeError,
    URL,
    fetch: fetchImpl,
  });
  vm.runInContext(readText("site_dnr.js"), context, { filename: "site_dnr.js" });
  return { chrome, context, dnr, fetchCalls, siteDnr: context.__static_site_dnr__ };
};

const applyOptions = (overrides) => ({
  mode: "per_site",
  prefs: { captcha_vendors: false, fingerprint_vendors: true },
  sites: ["paypal.com"],
  ...overrides,
});

base("rule ids and static rule selection follow the spec", async () => {
  const { siteDnr } = createHarness();
  expect(siteDnr.RULESET_IDS).toEqual(RULESET_IDS);
  expect(siteDnr.DEFAULT_PREFS).toEqual(DEFAULT_PREFS);
  expect(siteDnr.SCOPED_RULE_ID_BASE).toBe(SCOPED_MIN);
  expect(siteDnr.ruleIdFor(0, 1)).toBe(50001);
  expect(siteDnr.ruleIdFor(0, 999)).toBe(50999);
  expect(siteDnr.ruleIdFor(1, 1)).toBe(51001);
  for (const id of [50000, 50001, 51001, 51999, 59999]) {
    expect(siteDnr.isScopedRuleId(id), `scoped ${id}`).toBe(true);
  }
  for (const id of [49999, 60000, 50000.5, "50000", null, undefined, NaN]) {
    expect(siteDnr.isScopedRuleId(id), `not scoped ${String(id)}`).toBe(false);
  }

  expect(siteDnr.staticRulesetsFor({ captcha_vendors: false, fingerprint_vendors: true })).toEqual([
    "fingerprint_vendors",
  ]);
  expect(siteDnr.staticRulesetsFor({ captcha_vendors: true, fingerprint_vendors: true })).toEqual([
    "captcha_vendors",
    "fingerprint_vendors",
  ]);
  expect(siteDnr.staticRulesetsFor({ captcha_vendors: false, fingerprint_vendors: false })).toEqual(
    []
  );
  expect(siteDnr.staticRulesetsFor({ captcha_vendors: true })).toEqual(["captcha_vendors"]);
  expect(siteDnr.staticRulesetsFor(undefined)).toEqual(["fingerprint_vendors"]);
});

base("scopedRulesFor copies source conditions and scopes initiatorDomains", () => {
  const { siteDnr } = createHarness();
  const before = clone(RULES);

  const rules = siteDnr.scopedRulesFor(RULES, ["PayPal.com", "127.0.0.1", "paypal.com", ""]);
  expect(rules).toHaveLength(RULE_COUNTS.fingerprint_vendors + RULE_COUNTS.captcha_vendors);
  const domains = ["127.0.0.1", "paypal.com"];
  const usedTypes = new Set();
  for (const rule of rules) {
    expect(rule.id).toBeGreaterThanOrEqual(SCOPED_MIN);
    expect(rule.id).toBeLessThanOrEqual(SCOPED_MAX);
    expect(rule.condition.initiatorDomains).toEqual(domains);
    expect(rule.condition.excludedInitiatorDomains).toBeUndefined();
    for (const type of rule.condition.resourceTypes) usedTypes.add(type);
  }

  const fingerprint = rules.filter((rule) => rule.id < 51000);
  expect(fingerprint.map((rule) => rule.id)).toEqual(
    RULES.fingerprint_vendors.map((rule) => 50000 + rule.id)
  );
  const sourceById = new Map(RULES.fingerprint_vendors.map((rule) => [rule.id, rule]));
  for (const rule of fingerprint) {
    const source = sourceById.get(rule.id - 50000);
    expect(rule.priority).toBe(source.priority ?? 1);
    expect(rule.action).toEqual(source.action);
    expect(rule.condition).toEqual({
      ...source.condition,
      initiatorDomains: domains,
    });
  }

  const sourceTypes = new Set(
    [...RULES.fingerprint_vendors, ...RULES.captcha_vendors].flatMap(
      (rule) => rule.condition.resourceTypes
    )
  );
  for (const type of usedTypes) expect(sourceTypes.has(type)).toBe(true);
  // The builder must not mutate its inputs.
  expect(RULES).toEqual(before);
  expect(siteDnr.scopedRulesFor(RULES, [])).toEqual([]);
});

base("scopedRulesFor normalizes sites and caps them at 250", () => {
  const { siteDnr } = createHarness();
  const firstRule = (sites) => siteDnr.scopedRulesFor(RULES, sites)[0];
  expect(firstRule(["B.com", "a.com", "A.com", " b.com "]).condition.initiatorDomains).toEqual([
    "a.com",
    "b.com",
  ]);

  const many = Array.from(
    { length: 300 },
    (_, index) => `site${String(index).padStart(3, "0")}.example`
  );
  const reversed = [...many].reverse();
  const domains = firstRule(reversed).condition.initiatorDomains;
  expect(domains).toHaveLength(250);
  expect(domains).toEqual(many.slice(0, 250));
});

base("scopedRulesFor rejects static ids that would collide", () => {
  const { siteDnr } = createHarness();
  const rule = { id: 1000, condition: { urlFilter: "||x^", resourceTypes: ["script"] } };
  const error = captureThrow(() =>
    siteDnr.scopedRulesFor({ fingerprint_vendors: [rule] }, ["a.com"])
  );
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toMatch(/below 1000/);
  const ok = siteDnr.scopedRulesFor({ fingerprint_vendors: [{ ...rule, id: 999 }] }, ["a.com"]);
  expect(ok).toHaveLength(1);
  expect(ok[0].id).toBe(50999);
});

base("apply(per_site) disables static rulesets and scopes only enabled prefs", async () => {
  const harness = createHarness({ enabled: RULESET_IDS });
  const result = await harness.siteDnr.apply({
    mode: "per_site",
    prefs: { captcha_vendors: false, fingerprint_vendors: true },
    sites: ["paypal.com", "127.0.0.1"],
  });
  expect(result).toEqual({
    ok: true,
    scopedRules: RULE_COUNTS.fingerprint_vendors,
    staticRulesets: [],
  });
  expect(harness.dnr.state.enabled).toEqual([]);
  expect(harness.dnr.calls.updateEnabledRulesets).toEqual([{ disableRulesetIds: RULESET_IDS }]);

  const rules = scopedRulesOf(harness.dnr.state);
  expect(rules).toHaveLength(RULE_COUNTS.fingerprint_vendors);
  expect(rules.map((rule) => rule.id)).toEqual(
    RULES.fingerprint_vendors.map((rule) => 50000 + rule.id)
  );
  const sourceById = new Map(RULES.fingerprint_vendors.map((rule) => [rule.id, rule]));
  const usedTypes = new Set();
  for (const rule of rules) {
    const source = sourceById.get(rule.id - 50000);
    expect(source, `source rule for ${rule.id}`).toBeTruthy();
    expect(rule.condition.initiatorDomains).toEqual(["127.0.0.1", "paypal.com"]);
    expect(rule.condition.urlFilter).toBe(source.condition.urlFilter);
    expect(rule.condition.regexFilter).toBe(source.condition.regexFilter);
    expect(rule.condition.resourceTypes).toEqual(source.condition.resourceTypes);
    expect(rule.condition.excludedInitiatorDomains).toBeUndefined();
    expect(rule.action).toEqual(source.action);
    expect(rule.priority).toBe(source.priority ?? 1);
    for (const type of rule.condition.resourceTypes) usedTypes.add(type);
  }
  const sourceTypes = new Set(
    RULES.fingerprint_vendors.flatMap((rule) => rule.condition.resourceTypes)
  );
  for (const type of usedTypes) expect(sourceTypes.has(type)).toBe(true);
  // captcha_vendors lives in the ruleset #1 id block and is off.
  expect(rules.some((rule) => rule.id >= 51000)).toBe(false);
  expect(
    rules.some((rule) =>
      RULES.captcha_vendors.some((r) => r.condition.urlFilter === rule.condition.urlFilter)
    )
  ).toBe(false);
});

base("mode and pref changes leave exactly one intended rule set", async () => {
  const harness = createHarness({ enabled: [...RULESET_IDS] });
  const apply = (mode, prefs, sites) => harness.siteDnr.apply({ mode, prefs, sites });
  const both = { captcha_vendors: true, fingerprint_vendors: true };
  const fpOnly = { captcha_vendors: false, fingerprint_vendors: true };
  const captchaOnly = { captcha_vendors: true, fingerprint_vendors: false };

  await apply("per_site", both, ["example.com"]);
  expect(harness.dnr.state.enabled).toEqual([]);
  expect(scopedIdsOf(harness.dnr.state)).toHaveLength(
    RULE_COUNTS.fingerprint_vendors + RULE_COUNTS.captcha_vendors
  );
  expect(scopedIdsOf(harness.dnr.state).filter((id) => id >= 51000)).toHaveLength(
    RULE_COUNTS.captcha_vendors
  );

  await apply("per_site", fpOnly, ["example.com"]);
  expect(harness.dnr.state.enabled).toEqual([]);
  expect(scopedIdsOf(harness.dnr.state)).toEqual(
    RULES.fingerprint_vendors.map((rule) => 50000 + rule.id)
  );

  await apply("per_site", captchaOnly, ["example.com"]);
  expect(scopedIdsOf(harness.dnr.state)).toEqual(
    RULES.captcha_vendors.map((rule) => 51000 + rule.id)
  );

  const staticCallCount = harness.dnr.calls.updateEnabledRulesets.length;
  await apply("always", fpOnly, []);
  expect([...harness.dnr.state.enabled].sort()).toEqual(["fingerprint_vendors"]);
  expect(scopedIdsOf(harness.dnr.state)).toEqual([]);
  expect(harness.dnr.calls.updateEnabledRulesets).toHaveLength(staticCallCount + 1);
  // Equal state is a no-op.
  await apply("always", fpOnly, []);
  expect(harness.dnr.calls.updateEnabledRulesets).toHaveLength(staticCallCount + 1);

  await apply("always", both, []);
  expect([...harness.dnr.state.enabled].sort()).toEqual([...RULESET_IDS].sort());
  await apply("always", { captcha_vendors: false, fingerprint_vendors: false }, []);
  expect(harness.dnr.state.enabled).toEqual([]);

  await apply("per_site", fpOnly, ["paypal.com"]);
  const ids = scopedIdsOf(harness.dnr.state);
  expect(ids).toHaveLength(RULE_COUNTS.fingerprint_vendors);
  expect(new Set(ids).size).toBe(ids.length);
  for (const rule of scopedRulesOf(harness.dnr.state)) {
    expect(rule.condition.initiatorDomains).toEqual(["paypal.com"]);
  }
});

base("empty sites remove scoped rules and keep static rulesets disabled", async () => {
  const harness = createHarness({ enabled: ["fingerprint_vendors"] });
  const prefs = { captcha_vendors: false, fingerprint_vendors: true };
  const first = await harness.siteDnr.apply({ mode: "per_site", prefs, sites: ["paypal.com"] });
  expect(first.scopedRules).toBe(RULE_COUNTS.fingerprint_vendors);

  const empty = await harness.siteDnr.apply({ mode: "per_site", prefs, sites: [] });
  expect(empty.scopedRules).toBe(0);
  expect(harness.dnr.state.dynamic).toEqual([]);
  expect(harness.dnr.state.enabled).toEqual([]);

  const fresh = createHarness();
  const callsBefore = fresh.dnr.calls.updateDynamicRules.length;
  const again = await fresh.siteDnr.apply({ mode: "per_site", prefs, sites: [] });
  expect(again).toEqual({ ok: true, scopedRules: 0, staticRulesets: [] });
  expect(fresh.dnr.calls.updateDynamicRules).toHaveLength(callsBefore);
  expect(fresh.dnr.state.enabled).toEqual([]);
});

base("repeated applies are idempotent", async () => {
  const harness = createHarness({ enabled: ["captcha_vendors"] });
  const prefs = { captcha_vendors: true, fingerprint_vendors: true };
  const options = { mode: "per_site", prefs, sites: ["paypal.com", "127.0.0.1"] };

  await harness.siteDnr.apply(options);
  const firstState = clone(harness.dnr.state);
  await harness.siteDnr.apply(options);
  const secondState = clone(harness.dnr.state);
  expect(secondState).toEqual(firstState);
  const ids = secondState.dynamic.map((rule) => rule.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(scopedRulesOf(secondState)).toHaveLength(
    RULE_COUNTS.fingerprint_vendors + RULE_COUNTS.captcha_vendors
  );

  const always = { mode: "always", prefs, sites: [] };
  await harness.siteDnr.apply(always);
  const alwaysState = clone(harness.dnr.state);
  await harness.siteDnr.apply(always);
  expect(harness.dnr.state).toEqual(alwaysState);
  expect(scopedIdsOf(alwaysState)).toEqual([]);
});

base("a failed ruleset load rejects apply and leaves the previous state untouched", async () => {
  const seedRule = {
    action: { type: "block" },
    condition: { initiatorDomains: ["seed.test"], resourceTypes: ["script"], urlFilter: "||seed^" },
    id: 50001,
    priority: 1,
  };
  let offline = true;
  const fetchImpl = async (url) => {
    const rulesetId = rulesetIdFromUrl(url);
    if (offline && rulesetId === "fingerprint_vendors") throw new Error("network down");
    return jsonResponse(RULES[rulesetId]);
  };
  const harness = createHarness({
    dynamic: [seedRule],
    enabled: ["fingerprint_vendors"],
    fetch: fetchImpl,
  });
  const options = applyOptions();

  const error = await captureError(harness.siteDnr.apply(options));
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toMatch(/network down/);
  expect(error.message).toMatch(/rules\/fingerprint_vendors\.json/);
  expect(harness.dnr.calls.updateEnabledRulesets).toEqual([]);
  expect(harness.dnr.calls.updateDynamicRules).toEqual([]);
  expect(harness.dnr.state.enabled).toEqual(["fingerprint_vendors"]);
  expect(harness.dnr.state.dynamic).toEqual([seedRule]);

  offline = false;
  const applied = await harness.siteDnr.apply(options);
  expect(applied).toEqual({
    ok: true,
    scopedRules: RULE_COUNTS.fingerprint_vendors,
    staticRulesets: [],
  });
  expect(scopedIdsOf(harness.dnr.state)).toEqual(
    RULES.fingerprint_vendors.map((rule) => 50000 + rule.id)
  );
  // The failed attempt fetched both files; the retry fetched both again.
  expect(harness.fetchCalls).toHaveLength(4);
  expect(harness.fetchCalls.map((call) => call.init)).toEqual([
    { cache: "no-store" },
    { cache: "no-store" },
    { cache: "no-store" },
    { cache: "no-store" },
  ]);
});

base("a rejected dynamic-rule update propagates and the next apply recovers", async () => {
  const harness = createHarness({ enabled: ["fingerprint_vendors"] });
  harness.dnr.hooks.updateDynamicRules = (update) => {
    if (Array.isArray(update.addRules) && update.addRules.length > 0) {
      throw new Error("dynamic rule budget exceeded");
    }
  };
  const options = applyOptions();

  const error = await captureError(harness.siteDnr.apply(options));
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toMatch(/dynamic rule budget exceeded/);
  // Static rulesets are disabled before the dynamic update: the caller retries.
  expect(harness.dnr.state.enabled).toEqual([]);
  expect(harness.dnr.state.dynamic).toEqual([]);

  harness.dnr.hooks.updateDynamicRules = null;
  const retried = await harness.siteDnr.apply(options);
  expect(retried.scopedRules).toBe(RULE_COUNTS.fingerprint_vendors);
  expect(scopedIdsOf(harness.dnr.state)).toHaveLength(RULE_COUNTS.fingerprint_vendors);
});

base("a combined dynamic update falls back to remove-then-add", async () => {
  const seedRule = {
    action: { type: "block" },
    condition: { initiatorDomains: ["old.test"], resourceTypes: ["script"], urlFilter: "||old^" },
    id: 50001,
    priority: 1,
  };
  const harness = createHarness({
    dynamic: [seedRule],
    enabled: ["fingerprint_vendors"],
    hooks: {
      updateDynamicRules: (update) => {
        if (update.addRules && update.removeRuleIds) throw new Error("update too large");
      },
    },
  });

  const result = await harness.siteDnr.apply(applyOptions());
  expect(result.scopedRules).toBe(RULE_COUNTS.fingerprint_vendors);
  expect(harness.dnr.calls.updateDynamicRules).toHaveLength(3);
  expect(scopedRulesOf(harness.dnr.state)[0].condition.initiatorDomains).toEqual(["paypal.com"]);
});

base("apply serializes concurrent calls", async () => {
  const harness = createHarness();
  const tracker = { active: 0, max: 0 };
  harness.dnr.hooks.updateDynamicRules = async (update) => {
    if (!update.addRules || update.addRules.length === 0) return;
    tracker.active += 1;
    tracker.max = Math.max(tracker.max, tracker.active);
    await delay(10);
    tracker.active -= 1;
  };

  const first = harness.siteDnr.apply(
    applyOptions({
      prefs: { captcha_vendors: false, fingerprint_vendors: true },
      sites: ["a.test"],
    })
  );
  const second = harness.siteDnr.apply(
    applyOptions({ prefs: { captcha_vendors: true, fingerprint_vendors: true }, sites: ["b.test"] })
  );
  const [firstResult, secondResult] = await Promise.all([first, second]);
  expect(firstResult.scopedRules).toBe(RULE_COUNTS.fingerprint_vendors);
  expect(secondResult.scopedRules).toBe(
    RULE_COUNTS.fingerprint_vendors + RULE_COUNTS.captcha_vendors
  );
  expect(tracker.max).toBe(1);
  expect(harness.fetchCalls).toHaveLength(2);
  for (const rule of scopedRulesOf(harness.dnr.state)) {
    expect(rule.condition.initiatorDomains).toEqual(["b.test"]);
  }
});

base("apply never rejects with a non-Error and guards the chrome API", async () => {
  const harness = createHarness({ enabled: ["fingerprint_vendors"] });
  harness.dnr.hooks.updateDynamicRules = () => Promise.reject("plain string");
  const failure = await captureError(harness.siteDnr.apply(applyOptions()));
  expect(failure).toBeInstanceOf(Error);
  expect(failure.message).toMatch(/plain string/);

  const invalidMode = await captureError(
    harness.siteDnr.apply({ mode: "sometimes", prefs: {}, sites: [] })
  );
  expect(invalidMode).toBeInstanceOf(Error);
  expect(invalidMode.message).toMatch(/mode must be/);

  const bare = createHarness({ chrome: {} });
  const missing = await captureError(bare.siteDnr.apply(applyOptions()));
  expect(missing).toBeInstanceOf(Error);
  expect(missing.message).toMatch(/declarativeNetRequest is unavailable/);
  expect(await bare.siteDnr.capturePrefs()).toEqual(DEFAULT_PREFS);
  expect(await bare.siteDnr.currentScopedRuleIds()).toEqual([]);

  const noRuntime = createHarness({ chrome: { declarativeNetRequest: createDnrMock().api } });
  const noRuntimeError = await captureError(noRuntime.siteDnr.loadRulesets());
  expect(noRuntimeError).toBeInstanceOf(Error);
  expect(noRuntimeError.message).toMatch(/chrome.runtime.getURL is unavailable/);
});

base("apply(always) skips the ruleset files when the context cannot read them", async () => {
  const mock = createDnrMock({ enabled: ["fingerprint_vendors"] });
  const harness = createHarness({ chrome: { declarativeNetRequest: mock.api } });
  const result = await harness.siteDnr.apply({
    mode: "always",
    prefs: { captcha_vendors: false, fingerprint_vendors: true },
    sites: [],
  });
  expect(result).toEqual({ ok: true, scopedRules: 0, staticRulesets: ["fingerprint_vendors"] });
  expect(mock.state.enabled).toEqual(["fingerprint_vendors"]);
  expect(harness.fetchCalls).toEqual([]);
});

base("capturePrefs maps enabled rulesets and never throws", async () => {
  const both = createHarness({ enabled: RULESET_IDS });
  expect(await both.siteDnr.capturePrefs()).toEqual({
    captcha_vendors: true,
    fingerprint_vendors: true,
  });

  const unknown = createHarness({ enabled: ["captcha_vendors", "not_a_ruleset"] });
  expect(await unknown.siteDnr.capturePrefs()).toEqual({
    captcha_vendors: true,
    fingerprint_vendors: false,
  });

  const broken = createHarness({
    chrome: {
      declarativeNetRequest: {
        getEnabledRulesets: async () => {
          throw new Error("no permission");
        },
      },
    },
  });
  expect(await broken.siteDnr.capturePrefs()).toEqual(DEFAULT_PREFS);
  expect(
    await broken.siteDnr.capturePrefs({ captcha_vendors: true, fingerprint_vendors: false })
  ).toEqual({ captcha_vendors: true, fingerprint_vendors: false });
});

base("currentScopedRuleIds reads only the scoped id range", async () => {
  const dynamic = [
    { action: { type: "block" }, condition: {}, id: 50001, priority: 1 },
    { action: { type: "block" }, condition: {}, id: 51002, priority: 1 },
    { action: { type: "block" }, condition: {}, id: 9999, priority: 1 },
    { action: { type: "block" }, condition: {}, id: 80000, priority: 1 },
  ];
  const harness = createHarness({ dynamic });
  expect(await harness.siteDnr.currentScopedRuleIds()).toEqual([50001, 51002]);
});

base("loadRulesets caches successful loads", async () => {
  const harness = createHarness();
  const first = await harness.siteDnr.loadRulesets();
  expect(Object.keys(first)).toEqual(RULESET_IDS);
  expect(first.fingerprint_vendors).toHaveLength(RULE_COUNTS.fingerprint_vendors);
  expect(harness.fetchCalls).toHaveLength(2);
  expect(harness.fetchCalls.map((call) => call.url)).toEqual([
    "chrome-extension://static-test/rules/fingerprint_vendors.json",
    "chrome-extension://static-test/rules/captcha_vendors.json",
  ]);
  for (const call of harness.fetchCalls) expect(call.init).toEqual({ cache: "no-store" });

  const second = await harness.siteDnr.loadRulesets();
  expect(second).toBe(first);
  expect(harness.fetchCalls).toHaveLength(2);
});

base("loadRulesets retries after a failed load", async () => {
  let fail = true;
  const fetchImpl = async (url) => {
    if (fail && rulesetIdFromUrl(url) === "fingerprint_vendors") throw new Error("offline");
    return jsonResponse(RULES[rulesetIdFromUrl(url)]);
  };
  const harness = createHarness({ fetch: fetchImpl });
  const error = await captureError(harness.siteDnr.loadRulesets());
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toMatch(/offline/);
  expect(harness.fetchCalls).toHaveLength(2);

  fail = false;
  const loaded = await harness.siteDnr.loadRulesets();
  expect(harness.fetchCalls).toHaveLength(4);
  expect(Object.keys(loaded)).toEqual(RULESET_IDS);
  expect(loaded.captcha_vendors).toHaveLength(RULE_COUNTS.captcha_vendors);
});

base("loadRulesets validates rule JSON with descriptive errors", async () => {
  const valid = RULES.fingerprint_vendors[0];
  const loadRules = (rules) => {
    const fetchMap = { captcha_vendors: RULES.captcha_vendors, fingerprint_vendors: rules };
    const harness = createHarness({
      fetch: async (url) => jsonResponse(fetchMap[rulesetIdFromUrl(url)]),
    });
    return harness.siteDnr.loadRulesets();
  };
  const cases = [
    { expected: /must be a JSON array/, name: "not an array", rules: { rules: [] } },
    { expected: /"id" must be an integer/, name: "missing id", rules: [{}] },
    { expected: /"action" must be an object/, name: "missing action", rules: [{ id: 1 }] },
    {
      expected: /"condition" must be an object/,
      name: "missing condition",
      rules: [{ action: {}, id: 1 }],
    },
    {
      expected: /"urlFilter" or "regexFilter"/,
      name: "no filter",
      rules: [{ action: {}, condition: { resourceTypes: [] }, id: 1 }],
    },
    {
      expected: /"condition.resourceTypes" must be an array/,
      name: "no resourceTypes",
      rules: [{ action: {}, condition: { urlFilter: "||x^" }, id: 1 }],
    },
    { expected: /duplicates id 1/, name: "duplicate id", rules: [valid, valid] },
  ];
  for (const testCase of cases) {
    const error = await captureError(loadRules(testCase.rules));
    expect(error, testCase.name).toBeInstanceOf(Error);
    expect(error.message, testCase.name).toMatch(testCase.expected);
  }

  const httpHarness = createHarness({ fetch: async () => jsonResponse([], 404) });
  const httpError = await captureError(httpHarness.siteDnr.loadRulesets());
  expect(httpError.message).toMatch(/HTTP 404/);

  const parseHarness = createHarness({
    fetch: async () => ({
      json: async () => {
        throw new Error("bad json");
      },
      ok: true,
      status: 200,
    }),
  });
  const parseError = await captureError(parseHarness.siteDnr.loadRulesets());
  expect(parseError.message).toMatch(/bad json/);

  const regexHarness = createHarness({
    fetch: async () =>
      jsonResponse([
        {
          action: { type: "block" },
          condition: { regexFilter: "^https://x\\.example/", resourceTypes: ["script"] },
          id: 1,
        },
      ]),
  });
  const regexRulesets = await regexHarness.siteDnr.loadRulesets();
  expect(Object.keys(regexRulesets)).toEqual(RULESET_IDS);
  expect(regexRulesets.fingerprint_vendors).toHaveLength(1);
});

base("build-firefox.js packages the new background scripts in order", () => {
  const source = readText("build-firefox.js");
  const block = source.match(/fxManifest\.background\.scripts\s*=\s*\[([\s\S]*?)\]/);
  expect(block, "fxManifest.background.scripts assignment not found").toBeTruthy();
  const scripts = [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  expect(scripts).toEqual([
    "lists.js",
    "signals.js",
    "site_signals.js",
    "site_dnr.js",
    "service_worker_utils.js",
    "service_worker.js",
  ]);
});

// ─── E2E: Chrome accepts the scoped rules ─────────────────────────────────
const dnrState = (extension) =>
  extension.serviceWorker.evaluate(async () => ({
    dynamic: await chrome.declarativeNetRequest.getDynamicRules(),
    enabled: await chrome.declarativeNetRequest.getEnabledRulesets(),
  }));

const scopedDynamicRules = (state) =>
  state.dynamic
    .filter((rule) => rule.id >= SCOPED_MIN && rule.id <= SCOPED_MAX)
    .sort((a, b) => a.id - b.id);

// The service worker reconciles protection_mode asynchronously from
// chrome.storage.onChanged.  Wait for that pass to finish before editing DNR
// directly, or its own apply() can land after this test's and win.
const settleProtectionMode = (extension) =>
  extension.serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({ protection_mode: "always" });
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    if (typeof messageHandlers === "undefined" || !messageHandlers.static_set_protection_mode) {
      return;
    }
    await new Promise((resolve) => {
      messageHandlers.static_set_protection_mode(
        { mode: "always", type: "static_set_protection_mode" },
        {},
        resolve
      );
    });
  });

const applyDnr = (extension, options) =>
  extension.serviceWorker.evaluate(
    (nextOptions) => globalThis.__static_site_dnr__.apply(nextOptions),
    options
  );

const ALWAYS_OPTIONS = {
  mode: "always",
  prefs: { captcha_vendors: false, fingerprint_vendors: true },
  sites: [],
};
const PER_SITE_OPTIONS = {
  mode: "per_site",
  prefs: { captcha_vendors: false, fingerprint_vendors: true },
  sites: ["127.0.0.1"],
};

extensionTest("Chrome accepts the scoped per-site dynamic rules", async ({ extension }) => {
  const restore = async () => {
    await settleProtectionMode(extension).catch(() => {});
    await applyDnr(extension, ALWAYS_OPTIONS).catch(() => {});
  };
  try {
    // This spec mutates the extension-wide DNR state; start from an explicit mode.
    await settleProtectionMode(extension);
    await applyDnr(extension, ALWAYS_OPTIONS);
    expect((await dnrState(extension)).enabled).toEqual(["fingerprint_vendors"]);

    const result = await applyDnr(extension, PER_SITE_OPTIONS);
    expect(result).toEqual({
      ok: true,
      scopedRules: RULE_COUNTS.fingerprint_vendors,
      staticRulesets: [],
    });

    const perSite = await dnrState(extension);
    expect(perSite.enabled).toEqual([]);
    const rules = scopedDynamicRules(perSite);
    expect(rules).toHaveLength(RULE_COUNTS.fingerprint_vendors);
    expect(rules.map((rule) => rule.id)).toEqual(
      RULES.fingerprint_vendors.map((rule) => 50000 + rule.id)
    );
    const sourceById = new Map(RULES.fingerprint_vendors.map((rule) => [rule.id, rule]));
    for (const rule of rules) {
      const source = sourceById.get(rule.id - 50000);
      expect(rule.condition.initiatorDomains).toEqual(["127.0.0.1"]);
      expect(rule.condition.urlFilter).toBe(source.condition.urlFilter);
      expect(rule.condition.resourceTypes).toEqual(source.condition.resourceTypes);
      expect(rule.action).toEqual(source.action);
      expect(rule.priority).toBe(source.priority ?? 1);
    }

    // Back to always: static rulesets restored, scoped rules gone.
    const restored = await applyDnr(extension, ALWAYS_OPTIONS);
    expect(restored.ok).toBe(true);
    expect(restored.scopedRules).toBe(0);
    const state = await dnrState(extension);
    expect(state.enabled).toEqual(["fingerprint_vendors"]);
    expect(scopedDynamicRules(state)).toEqual([]);
  } finally {
    await restore();
  }
});
