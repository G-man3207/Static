/* eslint-disable max-lines, max-lines-per-function -- detection, fidelity, stealth, caps and lifecycle coverage for one module; each test is one contiguous fixture page + its assertions */
// Static - scout (observe-only per-site detection) end-to-end tests.
//
// The fixture harness seeds `protection_mode: "always"` for the pre-v2.8
// specs, so every test here first switches to `per_site` (with no decisions)
// and then loads a page. Those pages run the scout stack only:
//   MAIN:     block_utils.js, signals.js, scout.js, scout_probes.js, scout_signals.js
//   ISOLATED: lists.js, bridge.js
// Evidence is read from chrome.storage.local["site_evidence"][<site>].
const { expect, test } = require("./helpers/extension-fixture");
const { setProtectionMode, siteEvidence } = require("./helpers/extension");
const { startFixtureServer } = require("./helpers/server");

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const readSignalsCatalog = () => {
  const context = vm.createContext({ URL });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "signals.js"), "utf8"), context);
  return context.__static_signals__;
};

const catalogIds = (rows) => new Set(rows.map((row) => row.id));

const expectCatalogKeys = (evidence) => {
  const catalog = readSignalsCatalog();
  for (const [kind, ids] of [
    ["vendors", catalogIds(catalog.vendors)],
    ["device", catalogIds(catalog.device)],
    ["replay", catalogIds(catalog.replay)],
    ["compat", catalogIds(catalog.compat)],
  ]) {
    for (const key of Object.keys(evidence[kind] || {})) {
      expect(ids.has(key), `${kind}.${key} in signals.js`).toBe(true);
    }
  }
};

const SITE = "127.0.0.1";
const EVIDENCE_TIMEOUT = 10_000;
const extId = (letter) => letter.repeat(32);
const extUrl = (letter, path = "/manifest.json", scheme = "chrome-extension") =>
  `${scheme}://${extId(letter)}${path}`;

// One helper server per test keeps pages self-contained; fixtures are written
// from the object passed in, like every other spec in this repo.
const withScoutPage = async (extension, files, { path = "/index.html", routes = [] } = {}) => {
  const server = await startFixtureServer(files);
  const page = await extension.context.newPage();
  for (const [pattern, handler] of routes) await page.route(pattern, handler);
  try {
    await page.goto(server.url(path), { waitUntil: "load" });
  } finally {
    // Caller closes the page and server through the returned handles.
  }
  return { page, server };
};

const evidenceFor = async (extension) => {
  const evidence = await siteEvidence(extension, SITE);
  return evidence || null;
};

const waitForEvidence = async (extension, predicate) => {
  await expect
    .poll(
      async () => {
        const evidence = await evidenceFor(extension);
        return evidence ? predicate(evidence) : false;
      },
      { timeout: EVIDENCE_TIMEOUT }
    )
    .toBe(true);
  return evidenceFor(extension);
};

const probeCount = (evidence, vector) =>
  (evidence && evidence.probes && evidence.probes.vectors && evidence.probes.vectors[vector]) || 0;
const probeTotal = (evidence) => (evidence && evidence.probes && evidence.probes.total) || 0;
const signalCount = (evidence, kind, id) =>
  (evidence && evidence[kind] && typeof evidence[kind][id] === "number" && evidence[kind][id]) || 0;

test("observes every request vector on an unprotected page", async ({ extension }) => {
  const letters = "abcdefghijklmnop";
  const u = (index, path) => extUrl(letters[index % letters.length], path);
  const page = await extension.context.newPage();
  const server = await startFixtureServer({
    "/index.html": `<!doctype html><meta charset="utf-8"><body><script>
      fetch(${JSON.stringify(u(0, "/fetch.json"))}).catch(() => {});
      const xhr = new XMLHttpRequest();
      xhr.open("GET", ${JSON.stringify(u(1, "/xhr.json"))});
      xhr.send();
      new Image().src = ${JSON.stringify(u(2, "/ctor.png"))};
      document.createElement("img").src = ${JSON.stringify(u(3, "/img.png"))};
      document.createElement("img").setAttribute("src", ${JSON.stringify(u(4, "/attr.png"))});
      document.createElement("script").src = ${JSON.stringify(u(5, "/script.js"))};
      document.createElement("link").href = ${JSON.stringify(u(6, "/style.css"))};
      document.createElement("iframe").src = ${JSON.stringify(u(7, "/frame.html"))};
      document.createElement("source").src = ${JSON.stringify(u(8, "/source.mp4"))};
      document.createElement("video").poster = ${JSON.stringify(u(9, "/poster.png"))};
      try { new Audio(${JSON.stringify(u(10, "/audio.mp3"))}); } catch {}
      document.createElement("object").data = ${JSON.stringify(u(11, "/object"))};
      document.createElement("embed").src = ${JSON.stringify(u(12, "/embed"))};
      document.createElement("form").action = ${JSON.stringify(u(13, "/form"))};
      document.createElement("a").href = ${JSON.stringify(u(14, "/anchor"))};
      document.createElement("area").href = ${JSON.stringify(u(15, "/area"))};
      document.createElement("input").src = ${JSON.stringify(u(16, "/input.png"))};
      document.createElement("track").src = ${JSON.stringify(u(17, "/track.vtt"))};
      document.createElement("base").href = ${JSON.stringify(u(18, "/base/"))};
      document.createElement("img").srcset =
        ${JSON.stringify(`${u(19, "/one.png")} 1x, ${u(0, "/two.png")} 2x`)};
      try { new Worker(${JSON.stringify(u(1, "/worker.js"))}); } catch {}
      try { new SharedWorker(${JSON.stringify(u(2, "/shared.js"))}); } catch {}
      try { new EventSource(${JSON.stringify(u(3, "/events"))}); } catch {}
      try { navigator.sendBeacon(${JSON.stringify(u(4, "/beacon"))}, "x"); } catch {}
    </script></body>`,
  });
  await setProtectionMode(extension, "per_site");
  try {
    await page.goto(server.url("/index.html"), { waitUntil: "load" });
    const evidence = await waitForEvidence(extension, (value) => probeTotal(value) >= 20);
    const expected = [
      ["fetch", 1],
      ["xhr", 1],
      ["image-ctor", 1],
      ["img", 2],
      ["script", 1],
      ["link", 1],
      ["iframe", 1],
      ["source", 1],
      ["video-poster", 1],
      ["audio-ctor", 1],
      ["object", 1],
      ["embed", 1],
      ["form", 1],
      ["anchor", 1],
      ["area", 1],
      ["input", 1],
      ["track", 1],
      ["base", 1],
      ["img-srcset", 2],
      ["worker", 1],
      ["shared-worker", 1],
      ["event-source", 1],
      ["beacon", 1],
    ];
    for (const [vector, count] of expected) {
      expect(probeCount(evidence, vector), vector).toBeGreaterThanOrEqual(count);
    }
    expect(Object.keys(evidence.probes.pathKinds)).not.toHaveLength(0);
    expect(Object.keys(evidence.probes.ids).length).toBeGreaterThan(0);
  } finally {
    await page.close();
    await server.close();
  }
});

test("observes CSSOM and markup sinks", async ({ extension }) => {
  const page = await extension.context.newPage();
  const server = await startFixtureServer({
    "/index.html": `<!doctype html><meta charset="utf-8"><head><style>.pre{background:url(${extUrl("a", "/pre.png")})}</style></head><body><script>
      const sheet = new CSSStyleSheet();
      sheet.insertRule(".r{background:url(${extUrl("b", "/rule.png")})}", 0);
      sheet.addRule(".a", "background:url(${extUrl("c", "/add.png")})");
      sheet.replaceSync(".r{background:url(${extUrl("d", "/replace.png")})}");
      sheet.replace(".r{background:url(${extUrl("e", "/replace-async.png")})}").catch(() => {});
      const div = document.createElement("div");
      div.style.setProperty("background-image", "url(${extUrl("f", "/setprop.png")})");
      div.style.cssText = "background-image: url(${extUrl("a", "/csstext.png")})";
      document.body.appendChild(div);
      const host = document.createElement("div");
      document.body.appendChild(host);
      host.innerHTML = '<img src="${extUrl("b", "/inner.png")}">';
      host.insertAdjacentHTML("beforeend", '<script src="${extUrl("c", "/adj.js")}"><\\/script>');
      host.outerHTML = '<div><img src="${extUrl("d", "/outer.png")}"></div>';
      new DOMParser().parseFromString('<img src="${extUrl("e", "/parser.png")}">', "text/html");
      document.createRange().createContextualFragment('<img src="${extUrl("f", "/range.png")}">');
      document.write('<img src="${extUrl("a", "/write.png")}">');
      const style = document.createElement("style");
      style.textContent = ".x{background:url(${extUrl("b", "/styletext.png")})}";
      document.head.appendChild(style);
    </script></body>`,
  });
  await setProtectionMode(extension, "per_site");
  try {
    await page.goto(server.url("/index.html"), { waitUntil: "load" });
    const evidence = await waitForEvidence(
      extension,
      (value) => probeCount(value, "markup") >= 6 && probeCount(value, "style-text") >= 2
    );
    expect(probeCount(evidence, "style-text")).toBeGreaterThanOrEqual(2);
    expect(probeCount(evidence, "cssom-insert")).toBe(2);
    expect(probeCount(evidence, "cssom-replace")).toBe(2);
    expect(probeCount(evidence, "cssom-setprop")).toBeGreaterThanOrEqual(1);
    expect(probeCount(evidence, "cssom-csstext")).toBeGreaterThanOrEqual(1);
    expect(probeCount(evidence, "markup")).toBeGreaterThanOrEqual(6);
    expect(probeCount(evidence, "style-attr")).toBeGreaterThanOrEqual(1);
  } finally {
    await page.close();
    await server.close();
  }
});

test("observes nodes added from parsed markup via the observer backstop", async ({ extension }) => {
  const page = await extension.context.newPage();
  const server = await startFixtureServer({
    "/index.html": `<!doctype html><meta charset="utf-8">
      <head>
        <style>.p{background:url(${extUrl("a", "/parsestyle.png")})}</style>
      </head>
      <body>
        <img src="${extUrl("b", "/parserimg.png")}">
        <script src="${extUrl("c", "/parsers.js")}"></script>
        <iframe src="${extUrl("d", "/parserframe.html")}"></iframe>
        <video poster="${extUrl("e", "/parserposter.png")}"></video>
        <img srcset="${extUrl("f", "/set1.png")} 1x, ${extUrl("a", "/set2.png")} 2x">
        <a href="${extUrl("b", "/anchor")}">link</a>
      </body>`,
  });
  await setProtectionMode(extension, "per_site");
  try {
    await page.goto(server.url("/index.html"), { waitUntil: "load" });
    const evidence = await waitForEvidence(
      extension,
      (value) => probeCount(value, "img") >= 1 && probeCount(value, "style-text") >= 1
    );
    expect(probeCount(evidence, "img")).toBeGreaterThanOrEqual(1);
    expect(probeCount(evidence, "script")).toBeGreaterThanOrEqual(1);
    expect(probeCount(evidence, "iframe")).toBeGreaterThanOrEqual(1);
    expect(probeCount(evidence, "video-poster")).toBeGreaterThanOrEqual(1);
    expect(probeCount(evidence, "img-srcset")).toBeGreaterThanOrEqual(2);
    expect(probeCount(evidence, "anchor")).toBeGreaterThanOrEqual(1);
    expect(probeCount(evidence, "style-text")).toBeGreaterThanOrEqual(1);
  } finally {
    await page.close();
    await server.close();
  }
});

test("counts detached Image probes once and splits srcset candidates", async ({ extension }) => {
  const page = await extension.context.newPage();
  const server = await startFixtureServer({
    "/index.html": `<!doctype html><meta charset="utf-8"><body><script>
      const image = new Image();
      image.src = ${JSON.stringify(extUrl("a", "/detached.png"))};
      document.body.appendChild(image);
      const set = document.createElement("img");
      set.srcset = ${JSON.stringify(`${extUrl("b", "/one.png")} 1x, ${extUrl("c", "/two.png")} 2x`)};
      document.body.appendChild(set);
    </script></body>`,
  });
  await setProtectionMode(extension, "per_site");
  try {
    await page.goto(server.url("/index.html"), { waitUntil: "load" });
    const evidence = await waitForEvidence(extension, (value) => probeTotal(value) >= 3);
    expect(probeCount(evidence, "image-ctor")).toBe(1);
    expect(probeCount(evidence, "img-srcset")).toBe(2);
  } finally {
    await page.close();
    await server.close();
  }
});

test("caps probe volume, ids and vectors", async ({ extension }) => {
  const page = await extension.context.newPage();
  const vectorFamilies = `
    const e = (letter, path) => "chrome-extension://" + letter.repeat(32) + path;
    fetch(e("a", "/fetch.json")).catch(() => {});
    const xhr = new XMLHttpRequest();
    xhr.open("GET", e("b", "/xhr.json"));
    xhr.send();
    document.createElement("img").src = e("c", "/img.png");
    document.createElement("img").srcset = e("d", "/one.png") + " 1x, " + e("e", "/two.png") + " 2x";
    document.createElement("script").src = e("f", "/s.js");
    document.createElement("link").href = e("g", "/s.css");
    document.createElement("iframe").src = e("h", "/f.html");
    document.createElement("source").src = e("i", "/s.mp4");
    document.createElement("video").poster = e("j", "/p.png");
    try { new Audio(e("k", "/a.mp3")); } catch {}
    document.createElement("object").data = e("l", "/o");
    document.createElement("embed").src = e("m", "/e");
    document.createElement("form").action = e("n", "/f");
    document.createElement("a").href = e("o", "/a");
    document.createElement("area").href = e("p", "/a");
    document.createElement("input").src = e("a", "/i.png");
    document.createElement("track").src = e("b", "/t.vtt");
    document.createElement("base").href = e("c", "/base/");
    document.createElement("div").setAttribute("src", e("d", "/setattr"));
    try { new Worker(e("e", "/w.js")); } catch {}
    try { new SharedWorker(e("f", "/sw.js")); } catch {}
    try { new EventSource(e("g", "/es")); } catch {}
    try { navigator.sendBeacon(e("h", "/b"), "x"); } catch {}
    new CSSStyleSheet().insertRule(".c{background:url(" + e("i", "/r.png") + ")}", 0);
    new CSSStyleSheet().replaceSync(".c{background:url(" + e("j", "/s.png") + ")}");
    document.body.style.setProperty("background", "url(" + e("k", "/sp.png") + ")");
    document.body.style.cssText = "background: url(" + e("l", "/ct.png") + ")";
    const holder = document.createElement("div");
    holder.innerHTML = '<img src="' + e("m", "/m.png") + '">';
  `;
  const server = await startFixtureServer({
    "/index.html": `<!doctype html><meta charset="utf-8"><body><script>
      ${vectorFamilies}
      const idFor = (value) => {
        let text = "";
        let number = value;
        for (let index = 0; index < 32; index++) {
          text += "abcdefghijklmnop"[number % 16];
          number = Math.floor(number / 16);
        }
        return text;
      };
      const image = new Image();
      for (let index = 0; index < 5000; index++) {
        image.src = "chrome-extension://" + idFor(index % 400) + "/p" + (index % 400) + ".png";
      }
      window.__capsDone = true;
    </script></body>`,
  });
  await setProtectionMode(extension, "per_site");
  try {
    await page.goto(server.url("/index.html"), { waitUntil: "load" });
    await page.waitForFunction(() => window.__capsDone === true, null, { timeout: 10_000 });
    const evidence = await waitForEvidence(extension, (value) => probeTotal(value) >= 5000);
    expect(probeTotal(evidence)).toBeGreaterThanOrEqual(5000);
    expect(Object.keys(evidence.probes.ids).length).toBeLessThanOrEqual(300);
    expect(Object.keys(evidence.probes.vectors).length).toBeLessThanOrEqual(24);
    const stored = await extension.serviceWorker.evaluate(async () =>
      JSON.stringify((await chrome.storage.local.get({ site_evidence: {} })).site_evidence)
    );
    expect(stored.length).toBeLessThan(400 * 1024);
  } finally {
    await page.close();
    await server.close();
  }
});

test("passes fetch through unchanged", async ({ extension }) => {
  const page = await extension.context.newPage();
  const server = await startFixtureServer({
    "/index.html": `<!doctype html><meta charset="utf-8"><body><script>
      (async () => {
        const out = {};
        const descriptor = Object.getOwnPropertyDescriptor(window, "fetch");
        out.identity = {
          same: fetch === window.fetch,
          name: fetch.name,
          length: fetch.length,
          own: Object.getOwnPropertyNames(fetch),
          source: Function.prototype.toString.call(fetch),
          descriptor: {
            configurable: descriptor.configurable,
            enumerable: descriptor.enumerable,
            valueLength: descriptor.value && descriptor.value.length,
            valueName: descriptor.value && descriptor.value.name,
            valueType: typeof descriptor.value,
            writable: descriptor.writable,
          },
        };
        try {
          const response = await fetch("/echo.txt");
          out.response = { ctype: response.headers.get("content-type"), status: response.status, ok: response.ok, url: response.url, type: response.type, instance: response instanceof Response, tag: Object.prototype.toString.call(response) };
          out.cloneText = await response.clone().text();
          out.bodyUsedBefore = response.bodyUsed;
          out.text = await response.text();
          out.bodyUsedAfter = response.bodyUsed;
        } catch (error) { out.response = { error: String(error) }; }
        try {
          const url = new URL("/echo.txt", location.href);
          out.urlObject = await (await fetch(url)).text();
        } catch (error) { out.urlObject = String(error); }
        try {
          const request = new Request(new URL("/echo.txt", location.href).href);
          out.requestBodyUsedBefore = request.bodyUsed;
          out.request = { text: await (await fetch(request)).text(), url: request.url };
          out.requestBodyUsedAfter = request.bodyUsed;
        } catch (error) { out.request = { error: String(error) }; }
        try {
          const post = new Request(new URL("/echo.txt", location.href).href, { method: "POST", body: "payload" });
          out.postStatus = (await fetch(post)).status;
          out.postBodyUsed = post.bodyUsed;
          try { await fetch(post); out.postSecond = "resolved"; } catch (error) { out.postSecond = error.name; }
        } catch (error) { out.post = { error: String(error) }; }
        try {
          out.methodStatus = (await fetch(new URL("/echo.txt", location.href), { method: "GET" })).status;
          out.extracted = (await (function () { const f = fetch; return f("/echo.txt"); })()).status;
          out.nullThis = (await fetch.call(null, "/echo.txt")).status;
        } catch (error) { out.methodStatus = String(error); }
        try {
          const controller = new AbortController();
          const promise = fetch(new URL("/echo.txt", location.href), { signal: controller.signal });
          controller.abort();
          await promise;
          out.abort = "resolved";
        } catch (error) { out.abort = { name: error.name, domException: error instanceof DOMException }; }
        try {
          await fetch();
          out.noArgs = { name: "resolved" };
        } catch (error) { out.noArgs = { name: error.name, message: error.message }; }
        try {
          const response = await fetch(new URL("/missing-path.txt", location.href));
          out.missing = { status: response.status, ok: response.ok, text: await response.text() };
        } catch (error) { out.missing = { error: String(error) }; }
        window.__fetchFidelity = out;
      })();
    </script></body>`,
    "/echo.txt": "hello-echo",
  });
  await setProtectionMode(extension, "per_site");
  try {
    await page.goto(server.url("/index.html"), { waitUntil: "load" });
    await page.waitForFunction(() => window.__fetchFidelity, null, { timeout: 10_000 });
    const out = await page.evaluate(() => window.__fetchFidelity);
    expect(out.identity.same).toBe(true);
    expect(out.identity.name).toBe("fetch");
    expect(out.identity.length).toBe(1);
    expect(out.identity.own).toEqual(["length", "name"]);
    expect(out.identity.source).toContain("[native code]");
    expect(out.identity.descriptor).toEqual({
      configurable: true,
      enumerable: true,
      valueLength: 1,
      valueName: "fetch",
      valueType: "function",
      writable: true,
    });
    expect(out.response).toEqual({
      ctype: "text/plain; charset=utf-8",
      instance: true,
      ok: true,
      status: 200,
      tag: "[object Response]",
      type: "basic",
      url: server.url("/echo.txt"),
    });
    expect(out.cloneText).toBe("hello-echo");
    expect(out.bodyUsedBefore).toBe(false);
    expect(out.text).toBe("hello-echo");
    expect(out.bodyUsedAfter).toBe(true);
    expect(out.urlObject).toBe("hello-echo");
    expect(out.requestBodyUsedBefore).toBe(false);
    expect(out.request.text).toBe("hello-echo");
    expect(out.request.url).toBe(server.url("/echo.txt"));
    expect(out.requestBodyUsedAfter).toBe(false);
    expect(out.postStatus).toBe(200);
    expect(out.postBodyUsed).toBe(true);
    expect(out.postSecond).toBe("TypeError");
    expect(out.methodStatus).toBe(200);
    expect(out.extracted).toBe(200);
    expect(out.nullThis).toBe(200);
    expect(out.abort).toEqual({ domException: true, name: "AbortError" });
    expect(out.noArgs.name).toBe("TypeError");
    expect(out.noArgs.message).toContain("1 argument required");
    expect(out.missing).toEqual({ ok: false, status: 404, text: "not found" });
    expect(await siteEvidence(extension, SITE)).toBeNull();
  } finally {
    await page.close();
    await server.close();
  }
});

test("passes XMLHttpRequest through unchanged", async ({ extension }) => {
  const page = await extension.context.newPage();
  const server = await startFixtureServer({
    "/index.html": `<!doctype html><meta charset="utf-8"><body><script>
      (async () => {
        const out = {};
        out.openShape = { name: XMLHttpRequest.prototype.open.name, length: XMLHttpRequest.prototype.open.length, source: Function.prototype.toString.call(XMLHttpRequest.prototype.open) };
        const events = [];
        const xhr = new XMLHttpRequest();
        xhr.onreadystatechange = function () { events.push(this.readyState); };
        const loaded = new Promise((resolve, reject) => {
          xhr.onload = function () { out.thisOnload = this === xhr; resolve(); };
          xhr.onerror = reject;
          xhr.open("GET", "/echo.txt");
          out.openReturn = xhr.open.toString ? "present" : "missing";
          out.afterOpenState = { readyState: xhr.readyState, status: xhr.status };
          xhr.send();
        });
        await loaded;
        out.events = events;
        out.async = { status: xhr.status, statusText: xhr.statusText, text: xhr.responseText, response: xhr.response, responseURL: xhr.responseURL, readyState: xhr.readyState, instance: xhr instanceof XMLHttpRequest, ctor: xhr.constructor === XMLHttpRequest };
        out.responseXML = xhr.responseXML;
        const sync = new XMLHttpRequest();
        sync.open("GET", "/echo.txt", false);
        sync.send();
        out.sync = { status: sync.status, text: sync.responseText, readyState: sync.readyState };
        try {
          const json = new XMLHttpRequest();
          json.open("GET", "/data.json");
          json.responseType = "json";
          const jsonLoaded = new Promise((resolve) => { json.onload = resolve; });
          json.send();
          await jsonLoaded;
          out.json = { status: json.status, response: json.response, responseTextThrows: (() => { try { return String(json.responseText); } catch (error) { return error.name; } })() };
        } catch (error) { out.json = { error: String(error) }; }
        try {
          const bad = new XMLHttpRequest();
          bad.open("GET", "/echo.txt");
          bad.setRequestHeader("X-Probe", "1");
          const badLoaded = new Promise((resolve) => { bad.onload = resolve; });
          bad.send();
          await badLoaded;
          out.header = bad.getResponseHeader("content-type");
        } catch (error) { out.header = { error: String(error) }; }
        try { new XMLHttpRequest().open(); out.openNoArgs = "ok"; } catch (error) { out.openNoArgs = { name: error.name, message: error.message }; }
        try { new XMLHttpRequest().send(); out.sendBeforeOpen = "ok"; } catch (error) { out.sendBeforeOpen = { name: error.name, message: error.message }; }
        window.__xhrFidelity = out;
      })();
    </script></body>`,
    "/echo.txt": "hello-echo",
    "/data.json": '{"ok":true,"n":7}',
  });
  await page.route("**/data.json", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"n":7}' })
  );
  await setProtectionMode(extension, "per_site");
  try {
    await page.goto(server.url("/index.html"), { waitUntil: "load" });
    await page.waitForFunction(() => window.__xhrFidelity, null, { timeout: 10_000 });
    const out = await page.evaluate(() => window.__xhrFidelity);
    expect(out.openShape).toEqual({
      length: 2,
      name: "open",
      source: "function open() { [native code] }",
    });
    expect(out.events).toEqual([1, 2, 3, 4]);
    expect(out.thisOnload).toBe(true);
    expect(out.afterOpenState).toEqual({ readyState: 1, status: 0 });
    expect(out.async).toEqual({
      ctor: true,
      instance: true,
      readyState: 4,
      response: "hello-echo",
      responseURL: server.url("/echo.txt"),
      status: 200,
      statusText: "OK",
      text: "hello-echo",
    });
    expect(out.responseXML).toBeNull();
    expect(out.sync).toEqual({ readyState: 4, status: 200, text: "hello-echo" });
    expect(out.json.status).toBe(200);
    expect(out.json.response).toEqual({ ok: true, n: 7 });
    expect(out.json.responseTextThrows).toBe("InvalidStateError");
    expect(out.header).toBe("text/plain; charset=utf-8");
    expect(out.openNoArgs.name).toBe("TypeError");
    expect(out.openNoArgs.message).toContain("2 arguments required");
    expect(out.sendBeforeOpen.name).toBe("InvalidStateError");
    expect(await siteEvidence(extension, SITE)).toBeNull();
  } finally {
    await page.close();
    await server.close();
  }
});

test("passes DOM, CSSOM and markup primitives through unchanged", async ({ extension }) => {
  const page = await extension.context.newPage();
  const server = await startFixtureServer({
    "/index.html": `<!doctype html><meta charset="utf-8"><body><div id="root"></div><script>
      const out = {};
      const element = document.getElementById("root");
      out.setAttribute = { result: element.setAttribute("data-probe", "1"), value: element.getAttribute("data-probe") };
      out.attributeNode = element.getAttributeNode("data-probe").value;
      try { element.setAttribute("src"); } catch (error) { out.setArity = { name: error.name, message: error.message }; }
      try { element.setAttribute("src", Symbol("x")); } catch (error) { out.setSymbol = { name: error.name, message: error.message }; }
      const setAttributeShape = Object.getOwnPropertyDescriptor(Element.prototype, "setAttribute");
      const innerShape = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
      const outerShape = Object.getOwnPropertyDescriptor(Element.prototype, "outerHTML");
      out.shapes = {
        setAttribute: { configurable: setAttributeShape.configurable, enumerable: setAttributeShape.enumerable, length: setAttributeShape.value.length, name: setAttributeShape.value.name, native: /native code/.test(Function.prototype.toString.call(setAttributeShape.value)) },
        innerGet: { length: innerShape.get.length, name: innerShape.get.name, native: /native code/.test(Function.prototype.toString.call(innerShape.get)) },
        innerSet: { length: innerShape.set.length, name: innerShape.set.name, native: /native code/.test(Function.prototype.toString.call(innerShape.set)) },
        outerSet: { length: outerShape.set.length, name: outerShape.set.name },
      };
      const image = document.createElement("img");
      out.imgSrcResult = image.src = "/relative.png";
      image.src = "/relative.png";
      out.imgSrc = image.src;
      out.imgAttr = image.getAttribute("src");
      image.srcset = "/one.png 1x, /two.png 2x";
      out.imgSrcset = { property: image.srcset, attribute: image.getAttribute("srcset") };
      const link = document.createElement("link");
      link.href = "/style.css";
      out.linkHref = link.href;
      const anchor = document.createElement("a");
      anchor.href = "next/page";
      out.anchorHref = anchor.href;
      const form = document.createElement("form");
      form.action = "/submit";
      out.formAction = form.action;
      const video = document.createElement("video");
      video.poster = "/poster.png";
      out.videoPoster = video.poster;
      const script = document.createElement("script");
      script.src = "/code.js";
      out.scriptSrc = script.src;
      try { image.src = Symbol("x"); } catch (error) { out.srcSymbol = { name: error.name, message: error.message }; }
      try { image.srcset = Symbol("x"); } catch (error) { out.srcsetSymbol = { name: error.name, message: error.message }; }
      const holder = document.createElement("div");
      out.innerHTMLSet = holder.innerHTML = "<b id='inside'>bold</b>";
      out.innerHTMLGet = holder.innerHTML;
      out.innerStructure = { child: holder.firstElementChild.tagName, id: holder.firstElementChild.id, text: holder.firstElementChild.textContent };
      out.innerHTMLNull = (holder.innerHTML = null, holder.innerHTML);
      let conversions = 0;
      const coercible = { toString() { conversions += 1; return "<i>coerced</i>"; } };
      holder.innerHTML = coercible;
      out.innerCoercions = conversions;
      out.innerCoerced = holder.innerHTML;
      document.body.appendChild(holder);
      out.outerSet = holder.outerHTML = "<div id='replaced'>x</div>";
      out.outerReplaced = document.getElementById("replaced") !== null;
      out.insertAdjacent = holder.insertAdjacentHTML("beforeend", "<u>end</u>");
      out.insertAdjacentHtml = holder.innerHTML;
      try { holder.insertAdjacentHTML("nope", "x"); } catch (error) { out.insertAdjacentBad = { name: error.name, message: error.message }; }
      const parser = new DOMParser();
      out.parserInstance = parser instanceof DOMParser;
      const parsed = parser.parseFromString("<p id='p'>parsed</p>", "text/html");
      out.parsed = { instance: parsed instanceof Document, text: parsed.getElementById("p").textContent };
      try { parser.parseFromString("<p>x</p>", "nope"); } catch (error) { out.parserBad = { name: error.name, message: error.message }; }
      const range = document.createRange();
      const fragment = range.createContextualFragment("<span id='f'>frag</span>");
      out.fragment = { instance: fragment instanceof DocumentFragment, text: fragment.firstElementChild.textContent };
      try { holder.insertAdjacentHTML(); } catch (error) { out.insertMissing = { name: error.name, message: error.message }; }
      window.__domFidelity = out;
    </script><script>document.write("<div id='written'>written</div>");</script></body>`,
  });
  await setProtectionMode(extension, "per_site");
  try {
    await page.goto(server.url("/index.html"), { waitUntil: "load" });
    const out = await page.evaluate(() => window.__domFidelity);
    expect(out.setAttribute).toEqual({ result: undefined, value: "1" });
    expect(out.attributeNode).toBe("1");
    expect(out.setArity.message).toContain("2 arguments required");
    expect(out.setSymbol.message).toContain("Symbol");
    expect(out.shapes.setAttribute).toEqual({
      configurable: true,
      enumerable: true,
      length: 2,
      name: "setAttribute",
      native: true,
    });
    expect(out.shapes.innerGet).toEqual({ length: 0, name: "get innerHTML", native: true });
    expect(out.shapes.innerSet).toEqual({ length: 1, name: "set innerHTML", native: true });
    expect(out.shapes.outerSet).toEqual({ length: 1, name: "set outerHTML" });
    expect(out.imgSrcResult).toBe("/relative.png");
    expect(out.imgSrc).toBe(server.url("/relative.png"));
    expect(out.imgAttr).toBe("/relative.png");
    expect(out.imgSrcset).toEqual({
      attribute: "/one.png 1x, /two.png 2x",
      property: "/one.png 1x, /two.png 2x",
    });
    expect(out.linkHref).toBe(server.url("/style.css"));
    expect(out.anchorHref).toBe(server.url("/next/page"));
    expect(out.formAction).toBe(server.url("/submit"));
    expect(out.videoPoster).toBe(server.url("/poster.png"));
    expect(out.scriptSrc).toBe(server.url("/code.js"));
    expect(out.srcSymbol.name).toBe("TypeError");
    expect(out.srcSymbol.message).toContain("Symbol");
    expect(out.srcsetSymbol.name).toBe("TypeError");
    expect(out.innerHTMLSet).toBe("<b id='inside'>bold</b>");
    expect(out.innerHTMLGet).toBe(`<b id="inside">bold</b>`);
    expect(out.innerStructure).toEqual({ child: "B", id: "inside", text: "bold" });
    expect(out.innerHTMLNull).toBe("");
    expect(out.innerCoercions).toBe(1);
    expect(out.innerCoerced).toBe("<i>coerced</i>");
    expect(out.outerSet).toBe(`<div id='replaced'>x</div>`);
    expect(out.outerReplaced).toBe(true);
    expect(out.insertAdjacent).toBeUndefined();
    expect(out.insertAdjacentHtml).toContain("<u>end</u>");
    expect(out.insertAdjacentBad.name).toBe("SyntaxError");
    expect(out.parserInstance).toBe(true);
    expect(out.parsed).toEqual({ instance: true, text: "parsed" });
    expect(out.parserBad.name).toBe("TypeError");
    expect(out.fragment).toEqual({ instance: true, text: "frag" });
    expect(await page.evaluate(() => document.getElementById("written") !== null)).toBe(true);
    expect(out.insertMissing.name).toBe("TypeError");
    expect(out.insertMissing.message).toContain("2 arguments required");
  } finally {
    await page.close();
    await server.close();
  }
});

test("keeps constructors native-shaped and constructable", async ({ extension }) => {
  const page = await extension.context.newPage();
  const server = await startFixtureServer({
    "/index.html": `<!doctype html><meta charset="utf-8"><body><script>
      (async () => {
        const out = { noNew: {}, shapes: {} };
        const worker = new Worker("/worker.js");
        out.workerInstance = worker instanceof Worker;
        out.workerCtor = worker.constructor === Worker;
        out.workerMessage = await new Promise((resolve) => {
          worker.onmessage = (event) => resolve(event.data);
          setTimeout(() => resolve("timeout"), 3000);
        });
        const shared = new SharedWorker("/shared.js");
        out.sharedInstance = shared instanceof SharedWorker;
        out.sharedMessage = await new Promise((resolve) => {
          shared.port.onmessage = (event) => resolve(event.data);
          shared.port.start();
          setTimeout(() => resolve("timeout"), 3000);
        });
        const source = new EventSource("/events");
        out.eventSource = { instance: source instanceof EventSource, ctor: source.constructor === EventSource, url: source.url };
        source.close();
        const audio = new Audio("/echo.txt");
        out.audio = { ctor: audio.constructor === HTMLAudioElement, html: audio instanceof HTMLAudioElement, hint: audio instanceof HTMLMediaElement, instance: audio instanceof Audio, sameProto: Audio.prototype === HTMLAudioElement.prototype, src: audio.src };
        try {
          out.audioCalledWithoutNew = Audio("/echo.txt") instanceof HTMLAudioElement;
        } catch (error) {
          out.audioCalledWithoutNew = { name: error.name, newMentioned: /new/.test(error.message) };
        }
        const image = new Image(10, 20);
        out.image = { ctor: image.constructor === HTMLImageElement, height: image.height, hint: image instanceof HTMLImageElement, instance: image instanceof Image, sameProto: Image.prototype === HTMLImageElement.prototype, tag: image.tagName, width: image.width };
        try {
          const calledImage = Image(30, 40);
          out.imageCalledWithoutNew = { instance: calledImage instanceof HTMLImageElement, width: calledImage.width };
        } catch (error) {
          out.imageCalledWithoutNew = { name: error.name, newMentioned: /new/.test(error.message) };
        }
        for (const [label, factory] of [
          ["Worker", () => Worker("/worker.js")],
          ["SharedWorker", () => SharedWorker("/shared.js")],
          ["EventSource", () => EventSource("/events")],
        ]) {
          try { factory.call(null); out.noNew[label] = "ok"; }
          catch (error) { out.noNew[label] = { name: error.name, newMentioned: /new/.test(error.message) }; }
        }
        for (const [label, ctor] of [
          ["Worker", Worker],
          ["SharedWorker", SharedWorker],
          ["EventSource", EventSource],
          ["Audio", Audio],
          ["Image", Image],
        ]) {
          const prototype = Object.getOwnPropertyDescriptor(ctor, "prototype");
          out.shapes[label] = {
            constants: label === "EventSource" ? [EventSource.CONNECTING, EventSource.OPEN, EventSource.CLOSED] : null,
            descriptorEnumerable: Object.getOwnPropertyDescriptor(window, label).enumerable,
            length: ctor.length,
            name: ctor.name,
            own: Object.getOwnPropertyNames(ctor),
            prototypeConfigurable: prototype.configurable,
            prototypeEnumerable: prototype.enumerable,
            prototypeWritable: prototype.writable,
            source: Function.prototype.toString.call(ctor),
            protoCtor: ctor.prototype && ctor.prototype.constructor === ctor,
          };
        }
        try { new Worker("/worker.js"); out.workerObject = true; } catch (error) { out.workerObject = String(error); }
        window.__constructorFidelity = out;
      })();
    </script></body>`,
    "/echo.txt": "hello-echo",
    "/events": "data: one\n\n",
    "/worker.js": 'postMessage("worker-ok");',
    "/shared.js": 'onconnect = (event) => { event.ports[0].postMessage("shared-ok"); };',
  });
  await page.route("**/worker.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: 'postMessage("worker-ok");' })
  );
  await page.route("**/shared.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: 'onconnect = (event) => { event.ports[0].postMessage("shared-ok"); };',
    })
  );
  await page.route("**/events", (route) =>
    route.fulfill({ contentType: "text/event-stream", body: "data: one\n\n" })
  );
  await setProtectionMode(extension, "per_site");
  page.on("pageerror", (error) => console.log("CONSTRUCTOR PAGEERROR", String(error)));
  page.on("console", (message) =>
    console.log("CONSTRUCTOR CONSOLE", message.type(), message.text())
  );
  try {
    await page.goto(server.url("/index.html"), { waitUntil: "load" });
    await page.waitForFunction(() => window.__constructorFidelity, null, { timeout: 10_000 });
    const out = await page.evaluate(() => window.__constructorFidelity);
    expect(out.workerInstance).toBe(true);
    expect(out.workerCtor).toBe(true);
    expect(out.workerMessage).toBe("worker-ok");
    expect(out.sharedInstance).toBe(true);
    expect(out.sharedMessage).toBe("shared-ok");
    expect(out.eventSource).toEqual({ ctor: true, instance: true, url: server.url("/events") });
    expect(out.audio).toEqual({
      ctor: true,
      hint: true,
      html: true,
      instance: true,
      sameProto: true,
      src: server.url("/echo.txt"),
    });
    expect(out.audioCalledWithoutNew).toEqual({ name: "TypeError", newMentioned: true });
    expect(out.image).toEqual({
      ctor: true,
      height: 20,
      hint: true,
      instance: true,
      sameProto: true,
      tag: "IMG",
      width: 10,
    });
    expect(out.imageCalledWithoutNew).toEqual({ name: "TypeError", newMentioned: true });
    for (const label of ["Worker", "SharedWorker", "EventSource"]) {
      expect(out.noNew[label].name, label).toBe("TypeError");
      expect(out.noNew[label].newMentioned, label).toBe(true);
    }
    const expectedLengths = { Audio: 0, EventSource: 1, Image: 0, SharedWorker: 1, Worker: 1 };
    for (const [label, length] of Object.entries(expectedLengths)) {
      expect(out.shapes[label], label).toMatchObject({
        descriptorEnumerable: false,
        length,
        name: label,
        prototypeConfigurable: false,
        prototypeEnumerable: false,
        protoCtor: !(label === "Audio" || label === "Image"),
        prototypeWritable: false,
      });
      expect(out.shapes[label].source).toContain("[native code]");
      expect(out.shapes[label].source).not.toContain("scout");
    }
    expect(out.shapes.EventSource.constants).toEqual([0, 1, 2]);
    expect(out.shapes.Audio.own).toEqual(["length", "name", "prototype"]);
  } finally {
    await page.close();
    await server.close();
  }
});

test("leaves no page-visible globals or wrapper tells", async ({ extension }) => {
  await setProtectionMode(extension, "always");
  const controlPage = await extension.context.newPage();
  const controlServer = await startFixtureServer({
    "/index.html": `<!doctype html><meta charset="utf-8"><body><div id="target">blank</div><script>
      window.__early = Object.getOwnPropertyNames(window).filter((key) => key.startsWith("__static"));
      window.__keys = Object.keys(window).sort();
      window.__styles = getComputedStyle(document.getElementById("target")).color;
    </script></body>`,
  });
  await controlPage.goto(controlServer.url("/index.html"), { waitUntil: "load" });
  const controlKeys = await controlPage.evaluate(() =>
    Object.keys(window)
      .filter((key) => !key.startsWith("__"))
      .sort()
  );
  await controlPage.close();

  await setProtectionMode(extension, "per_site");
  const page = await extension.context.newPage();
  const server = await startFixtureServer({
    "/index.html": `<!doctype html><meta charset="utf-8"><body><div id="target">blank</div><script>
      window.__early = Object.getOwnPropertyNames(window).filter((key) => key.startsWith("__static"));
      window.__keys = Object.keys(window).sort();
      window.__describe = (owner, prop) => {
        const descriptor = Object.getOwnPropertyDescriptor(owner, prop);
        if (!descriptor) return null;
        const text = (fn) => (fn ? Function.prototype.toString.call(fn) : "");
        const native = (fn) => /\\[native code\\]/.test(text(fn));
        const record = {
          configurable: descriptor.configurable,
          enumerable: descriptor.enumerable,
        };
        if (descriptor.value) {
          record.kind = "value";
          record.native = native(descriptor.value);
          record.name = descriptor.value.name;
          record.length = descriptor.value.length;
        } else {
          record.kind = "accessor";
          record.get = descriptor.get
            ? { length: descriptor.get.length, name: descriptor.get.name, native: native(descriptor.get) }
            : null;
          record.set = descriptor.set
            ? { length: descriptor.set.length, name: descriptor.set.name, native: native(descriptor.set) }
            : null;
        }
        return record;
      };
      window.__lateSurface = { fetchName: fetch.name, fetchLength: fetch.length, fetchSource: Function.prototype.toString.call(fetch) };
      // Chrome 147 exposes document.fonts as a FontFaceSet without exposing the
      // FontFaceSet constructor on Window. Resolve the interface from either.
      window.__fontProto =
        typeof FontFaceSet === "function"
          ? FontFaceSet.prototype
          : document.fonts
            ? Object.getPrototypeOf(document.fonts)
            : null;
      try {
      window.__surface = {
        aHref: window.__describe(HTMLAnchorElement.prototype, "href"),
        areaHref: window.__describe(HTMLAreaElement.prototype, "href"),
        audio: window.__describe(window, "Audio"),
        baseHref: window.__describe(HTMLBaseElement.prototype, "href"),
        beacon: window.__describe(Navigator.prototype, "sendBeacon"),
        canvasToBlob: window.__describe(HTMLCanvasElement.prototype, "toBlob"),
        canvasToDataURL: window.__describe(HTMLCanvasElement.prototype, "toDataURL"),
        connection: window.__describe(Navigator.prototype, "connection"),
        cssAddRule: window.__describe(CSSStyleSheet.prototype, "addRule"),
        cssInsertRule: window.__describe(CSSStyleSheet.prototype, "insertRule"),
        cssReplace: window.__describe(CSSStyleSheet.prototype, "replace"),
        cssReplaceSync: window.__describe(CSSStyleSheet.prototype, "replaceSync"),
        cssSetProperty: window.__describe(CSSStyleDeclaration.prototype, "setProperty"),
        cssText: window.__describe(CSSStyleDeclaration.prototype, "cssText"),
        doMParser: window.__describe(DOMParser.prototype, "parseFromString"),
        documentWrite: window.__describe(Document.prototype, "write"),
        embedSrc: window.__describe(HTMLEmbedElement.prototype, "src"),
        eventSource: window.__describe(window, "EventSource"),
        fetch: window.__describe(window, "fetch"),
        fontsCheck: window.__describe(window.__fontProto, "check"),
        fontsLoad: window.__describe(window.__fontProto, "load"),
        formAction: window.__describe(HTMLFormElement.prototype, "action"),
        getImageData: window.__describe(CanvasRenderingContext2D.prototype, "getImageData"),
        hardwareConcurrency: window.__describe(Navigator.prototype, "hardwareConcurrency"),
        iframeSrc: window.__describe(HTMLIFrameElement.prototype, "src"),
        image: window.__describe(window, "Image"),
        imgSrc: window.__describe(HTMLImageElement.prototype, "src"),
        imgSrcset: window.__describe(HTMLImageElement.prototype, "srcset"),
        innerHTML: window.__describe(Element.prototype, "innerHTML"),
        insertAdjacentHTML: window.__describe(Element.prototype, "insertAdjacentHTML"),
        languages: window.__describe(Navigator.prototype, "languages"),
        linkHref: window.__describe(HTMLLinkElement.prototype, "href"),
        measureText: window.__describe(CanvasRenderingContext2D.prototype, "measureText"),
        mediaSrc: window.__describe(HTMLMediaElement.prototype, "src"),
        mediaCanPlayType: window.__describe(HTMLMediaElement.prototype, "canPlayType"),
        objectData: window.__describe(HTMLObjectElement.prototype, "data"),
        outerHTML: window.__describe(Element.prototype, "outerHTML"),
        plugins: window.__describe(Navigator.prototype, "plugins"),
        rangeFragment: window.__describe(Range.prototype, "createContextualFragment"),
        screenWidth: window.__describe(Screen.prototype, "width"),
        scriptSrc: window.__describe(HTMLScriptElement.prototype, "src"),
        setAttribute: window.__describe(Element.prototype, "setAttribute"),
        shadowInner: window.__describe(ShadowRoot.prototype, "innerHTML"),
        sharedWorker: window.__describe(window, "SharedWorker"),
        sourceSrc: window.__describe(HTMLSourceElement.prototype, "src"),
        sourceSrcset: window.__describe(HTMLSourceElement.prototype, "srcset"),
        trackSrc: window.__describe(HTMLTrackElement.prototype, "src"),
        userAgent: window.__describe(Navigator.prototype, "userAgent"),
        userAgentData: window.__describe(Navigator.prototype, "userAgentData"),
        videoPoster: window.__describe(HTMLVideoElement.prototype, "poster"),
        webglParameter: window.__describe(WebGLRenderingContext.prototype, "getParameter"),
        worker: window.__describe(window, "Worker"),
        workletAddModule: window.__describe(Worklet.prototype, "addModule"),
        xhrOpen: window.__describe(XMLHttpRequest.prototype, "open"),
      };
      } catch (error) {
        window.__surface = { buildError: String((error && error.stack) || error) };
      }
    </script></body>`,
  });
  try {
    await page.goto(server.url("/index.html"), { waitUntil: "load" });
    const state = await page.evaluate(() => ({
      early: window.__early,
      late: window.__lateSurface,
      surface: window.__surface,
    }));
    const scoutKeys = await page.evaluate(() =>
      Object.keys(window)
        .filter((key) => !key.startsWith("__"))
        .sort()
    );
    expect(state.early).toEqual([]);
    expect(scoutKeys).toEqual(controlKeys);
    // A missing API in this Chromium may be absent from the snapshot, but a
    // fixture that cannot build the snapshot (or a scout that clobbers a
    // global) must fail with the reason instead of a downstream TypeError.
    expect(state.surface.buildError, "fixture surface build").toBeUndefined();
    expect(state.late.fetchName).toBe("fetch");
    expect(state.late.fetchLength).toBe(1);
    expect(state.late.fetchSource).toBe("function fetch() { [native code] }");
    const hostGetter = (name) => ({
      configurable: true,
      enumerable: true,
      kind: "accessor",
      get: { length: 0, name, native: true },
      set: null,
    });
    const expected = {
      aHref: "href",
      areaHref: "href",
      baseHref: "href",
      embedSrc: "src",
      formAction: "action",
      iframeSrc: "src",
      imgSrc: "src",
      imgSrcset: "srcset",
      innerHTML: "innerHTML",
      linkHref: "href",
      mediaSrc: "src",
      objectData: "data",
      outerHTML: "outerHTML",
      scriptSrc: "src",
      shadowInner: "innerHTML",
      sourceSrc: "src",
      sourceSrcset: "srcset",
      trackSrc: "src",
      videoPoster: "poster",
    };
    // Playwright instruments CSSStyleSheet/CSSStyleDeclaration methods in the
    // MAIN world before content scripts run, so their function source/length is
    // the instrumentation's, not Chromium's. The scout must still keep names.
    for (const [label, property] of [
      ["cssAddRule", "addRule"],
      ["cssInsertRule", "insertRule"],
      ["cssReplace", "replace"],
      ["cssReplaceSync", "replaceSync"],
      ["cssSetProperty", "setProperty"],
      ["cssText", "cssText"],
    ]) {
      const entry = state.surface[label];
      if (property === "cssText") {
        expect(entry.get.name, label).toBe("get cssText");
        expect(entry.set.name, label).toBe("set cssText");
      } else {
        expect(entry.name, label).toBe(property);
      }
    }
    for (const [label, property] of Object.entries(expected)) {
      expect(state.surface[label], label).toEqual({
        configurable: true,
        enumerable: true,
        get: { length: 0, name: `get ${property}`, native: true },
        kind: "accessor",
        set: { length: 1, name: `set ${property}`, native: true },
      });
    }
    for (const [label, length, name] of [
      ["beacon", 1, "sendBeacon"],
      ["canvasToBlob", 1, "toBlob"],
      ["canvasToDataURL", 0, "toDataURL"],
      ["doMParser", 2, "parseFromString"],
      ["documentWrite", 0, "write"],
      ["fontsCheck", 1, "check"],
      ["fontsLoad", 1, "load"],
      ["getImageData", 4, "getImageData"],
      ["insertAdjacentHTML", 2, "insertAdjacentHTML"],
      ["measureText", 1, "measureText"],
      ["mediaCanPlayType", 1, "canPlayType"],
      ["rangeFragment", 1, "createContextualFragment"],
      ["setAttribute", 2, "setAttribute"],
      ["webglParameter", 1, "getParameter"],
      ["workletAddModule", 1, "addModule"],
      ["xhrOpen", 2, "open"],
      ["fetch", 1, "fetch"],
      ["hardwareConcurrency", 0, "get hardwareConcurrency"],
      ["connection", 0, "get connection"],
      ["languages", 0, "get languages"],
      ["plugins", 0, "get plugins"],
      ["userAgent", 0, "get userAgent"],
      ["userAgentData", 0, "get userAgentData"],
      ["audio", 0, "Audio"],
      ["eventSource", 1, "EventSource"],
      ["image", 0, "Image"],
      ["sharedWorker", 1, "SharedWorker"],
      ["worker", 1, "Worker"],
    ]) {
      const entry = state.surface[label];
      expect(entry, `${label} missing`).not.toBeNull();
      if (name.startsWith("get ")) {
        expect(entry, label).toEqual(hostGetter(name));
      } else {
        expect([entry.kind, entry.name, entry.length, entry.native], label).toEqual([
          "value",
          name,
          length,
          true,
        ]);
        if (
          label === "audio" ||
          label === "image" ||
          label === "eventSource" ||
          label === "sharedWorker" ||
          label === "worker"
        ) {
          expect(entry.configurable, label).toBe(true);
          expect(entry.enumerable, label).toBe(false);
        } else {
          expect(entry.configurable, label).toBe(true);
          expect(entry.enumerable, label).toBe(true);
        }
      }
    }
  } finally {
    await page.close();
    await server.close();
    await controlServer.close();
  }
});

test("records fingerprint, CAPTCHA and replay signals without touching the SDKs", async ({
  extension,
}) => {
  const page = await extension.context.newPage();
  const server = await startFixtureServer({
    "/index.html": `<!doctype html><meta charset="utf-8"><body>
      <script>
        window.Fingerprint = { load: function load() { return Promise.resolve({ id: "fp" }); } };
        window.FingerprintJS = window.Fingerprint;
        window.ddjskey = "client-key";
        window.ddoptions = { endpoint: "/js/" };
        window._pxAppId = "PX123";
        window._pxHostUrl = "/px/";
        window.LogRocket = { init: function init() { return "lr"; } };
        window.hj = function hj() { return "hj"; };
        window.posthog = { init: function init() { return "ph"; } };
        window.Sentry = { replayIntegration: function replayIntegration() { return "sr"; } };
        window.DD_RUM = { init: function init() { return "dd"; } };
        window.__vendorCalls = [
          window.LogRocket.init(),
          window.hj(),
          window.posthog.init(),
          window.Sentry.replayIntegration(),
          window.DD_RUM.init(),
        ];
      </script>
      <script src="https://fpjs.io/fp.js"></script>
      <script src="https://cdn.datadome.co/tags.js"></script>
      <script src="https://www.google.com/recaptcha/api.js"></script>
      <script src="https://logrocket.com/lr.js"></script>
    </body>`,
  });
  await page.route("https://fpjs.io/**", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.__fpLoaded = true;" })
  );
  await page.route("https://cdn.datadome.co/**", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.__ddLoaded = true;" })
  );
  await page.route("https://www.google.com/recaptcha/**", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.__rcLoaded = true;" })
  );
  await page.route("https://logrocket.com/**", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.__lrLoaded = true;" })
  );
  await setProtectionMode(extension, "per_site");
  try {
    await page.goto(server.url("/index.html"), { waitUntil: "load" });
    const evidence = await waitForEvidence(
      extension,
      (value) =>
        signalCount(value, "vendors", "fingerprintjs") >= 1 &&
        signalCount(value, "replay", "logrocket") >= 1
    );
    console.log(
      "VENDOR DEBUG",
      JSON.stringify({
        vendors: evidence.vendors,
        compat: evidence.compat,
        flags: await page.evaluate(() => ({
          fp: window.__fpLoaded,
          dd: window.__ddLoaded,
          rc: window.__rcLoaded,
          lr: window.__lrLoaded,
          resources: performance.getEntriesByType("resource").map((entry) => entry.name),
        })),
      })
    );
    for (const id of ["fingerprintjs", "datadome", "perimeterx", "recaptcha"]) {
      expect(signalCount(evidence, "vendors", id), id).toBe(1);
    }
    for (const id of ["logrocket", "hotjar", "posthog", "sentry-replay", "datadog-rum"]) {
      expect(signalCount(evidence, "replay", id), id).toBe(1);
    }
    expect(signalCount(evidence, "compat", "captcha")).toBeGreaterThanOrEqual(1);
    expect(signalCount(evidence, "compat", "bot_challenge")).toBeGreaterThanOrEqual(1);
    const behavior = await page.evaluate(() => ({
      calls: window.__vendorCalls,
      dd: window.ddjskey,
      fpLoaded: window.__fpLoaded,
      ddLoaded: window.__ddLoaded,
      rcLoaded: window.__rcLoaded,
      lrLoaded: window.__lrLoaded,
      identities: {
        dd: window.ddjskey === "client-key",
        ddoptions: typeof window.ddoptions === "object" && window.ddoptions.endpoint === "/js/",
        fp: typeof window.Fingerprint.load === "function",
        hj: typeof window.hj === "function" && window.hj() === "hj",
        logrocket: typeof window.LogRocket.init === "function",
        px: window._pxAppId === "PX123",
      },
    }));
    expect(behavior.calls).toEqual(["lr", "hj", "ph", "sr", "dd"]);
    expect(behavior.dd).toBe("client-key");
    expect(behavior.fpLoaded).toBe(true);
    expect(behavior.ddLoaded).toBe(true);
    expect(behavior.rcLoaded).toBe(true);
    expect(behavior.lrLoaded).toBe(true);
    expect(behavior.identities).toEqual({
      dd: true,
      ddoptions: true,
      fp: true,
      hj: true,
      logrocket: true,
      px: true,
    });
    expectCatalogKeys(evidence);
  } finally {
    await page.close();
    await server.close();
  }
});

test("records device readback signals without changing results", async ({ extension }) => {
  const page = await extension.context.newPage();
  const server = await startFixtureServer({
    "/index.html": `<!doctype html><meta charset="utf-8"><body><script>
      (async () => {
        const out = {};
        const canvas = document.createElement("canvas");
        canvas.width = 8;
        canvas.height = 8;
        const context = canvas.getContext("2d");
        context.fillStyle = "#123456";
        context.fillRect(0, 0, 8, 8);
        out.dataUrl = canvas.toDataURL();
        out.pixels = Array.from(context.getImageData(0, 0, 1, 1).data);
        out.measure = context.measureText("hello").width;
        out.blob = await new Promise((resolve) => canvas.toBlob((blob) => resolve(blob && blob.size > 0), "image/png"));
        const gl = document.createElement("canvas").getContext("webgl");
        if (gl) {
          out.glVendor = gl.getParameter(gl.VENDOR);
          gl.getExtension("WEBGL_debug_renderer_info");
          out.glRenderer = gl.getParameter(37445) || gl.getParameter(37446) || "";
          out.glRendererType = typeof out.glRenderer;
        }
        const audio = new OfflineAudioContext(1, 128, 44100);
        const buffer = audio.createBuffer(1, 128, 44100);
        const channel = buffer.getChannelData(0);
        out.audioBuffer = channel.length;
        out.audioRendered = await audio.startRendering().then((rendered) => rendered.length);
        out.fontCheck = document.fonts.check("12px sans-serif");
        out.fontLoad = await document.fonts.load("12px sans-serif").then((faces) => Array.isArray(faces));
        out.fontValues = typeof document.fonts.values;
        out.fontIterator = Array.from(document.fonts.values()).length >= 0;
        out.hardware = navigator.hardwareConcurrency;
        out.deviceMemory = navigator.deviceMemory;
        out.screen = [screen.width, screen.height, screen.availWidth, screen.availHeight, screen.colorDepth, screen.pixelDepth, window.devicePixelRatio];
        out.timezone = new Date().getTimezoneOffset();
        out.timezoneName = Intl.DateTimeFormat().resolvedOptions().timeZone;
        out.languages = navigator.languages;
        out.storage = await navigator.storage.estimate().then((estimate) => typeof estimate.quota);
        const peer = new RTCPeerConnection();
        out.rtc = { instance: peer instanceof RTCPeerConnection, ctor: peer.constructor === RTCPeerConnection, static: typeof RTCPeerConnection.generateCertificate };
        peer.close();
        out.devices = await navigator.mediaDevices.enumerateDevices().then((list) => Array.isArray(list));
        out.battery = await navigator.getBattery().then((battery) => typeof battery.level);
        out.hints = await navigator.userAgentData.getHighEntropyValues(["platform"]).then((hints) => typeof hints.platform);
        out.plugins = typeof navigator.plugins.length;
        out.permission = await navigator.permissions.query({ name: "geolocation" }).then((status) => typeof status.state);
        out.connection = typeof navigator.connection.effectiveType;
        out.codecs = document.createElement("video").canPlayType('video/mp4; codecs="avc1.42E01E"');
        out.userAgent = [navigator.userAgent.length > 0, navigator.userAgent.length > 0];
        window.__device = out;
      })();
    </script></body>`,
  });
  await setProtectionMode(extension, "per_site");
  try {
    await page.goto(server.url("/index.html"), { waitUntil: "load" });
    await page.waitForFunction(() => window.__device, null, { timeout: 10_000 });
    const evidence = await waitForEvidence(
      extension,
      (value) => Object.keys(value.device || {}).length >= 17
    );
    const surfaces = Object.keys(evidence.device).sort();
    expect(surfaces).toEqual(
      [
        "audio",
        "battery",
        "canvas",
        "client_hints",
        "codecs",
        "connection",
        "fonts",
        "hardware",
        "languages",
        "media_devices",
        "permissions",
        "plugins",
        "screen",
        "storage",
        "timezone",
        "webgl",
        "webrtc",
      ].sort()
    );
    for (const surface of surfaces) {
      expect(evidence.device[surface], surface).toBeGreaterThanOrEqual(1);
    }
    expect(evidence.device.canvas).toBeGreaterThanOrEqual(4);
    expect(evidence.device.screen).toBeGreaterThanOrEqual(7);
    expect(evidence.device.timezone).toBeGreaterThanOrEqual(2);
    expect(evidence.device.fonts).toBeGreaterThanOrEqual(3);
    expect(evidence.device.audio).toBeGreaterThanOrEqual(2);
    const out = await page.evaluate(() => window.__device);
    expect(out.dataUrl.startsWith("data:image/png")).toBe(true);
    expect(out.pixels).toEqual([18, 52, 86, 255]);
    expect(out.measure).toBeGreaterThan(0);
    expect(out.blob).toBe(true);
    expect(typeof out.glRenderer).toBe("string");
    expect(out.glRenderer.length).toBeGreaterThan(0);
    expect(out.audioBuffer).toBe(128);
    expect(out.audioRendered).toBe(128);
    expect(out.fontCheck).toBe(true);
    expect(out.fontLoad).toBe(true);
    expect(out.fontValues).toBe("function");
    expect(out.hardware).toBeGreaterThanOrEqual(1);
    expect(out.deviceMemory).toBeGreaterThanOrEqual(1);
    expect(out.screen[0]).toBeGreaterThan(0);
    expect(out.screen[3]).toBeGreaterThan(0);
    expect(out.timezone).toBeLessThanOrEqual(0);
    expect(typeof out.timezoneName).toBe("string");
    expect(Array.isArray(out.languages)).toBe(true);
    expect(out.storage).toBe("number");
    expect(out.rtc).toEqual({ ctor: true, instance: true, static: "function" });
    expect(out.devices).toBe(true);
    expect(out.battery).toBe("number");
    expect(out.hints).toBe("string");
    expect(out.plugins).toBe("number");
    expect(out.permission).toBe("string");
    expect(out.connection).toBe("string");
    expect(out.codecs).toBe("probably");
    expect(evidence.uaReads).toBeGreaterThanOrEqual(2);
    expectCatalogKeys(evidence);
  } finally {
    await page.close();
    await server.close();
  }
});

test("records compatibility signals for sign-in and payment flows", async ({ extension }) => {
  const page = await extension.context.newPage();
  const server = await startFixtureServer({
    "/login/index.html": `<!doctype html><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="require-trusted-types-for 'script'">
      <body>
        <form action="https://accounts.google.com/o/oauth2/v2/auth">
          <input type="email" name="email">
          <input type="password" name="password">
          <input autocomplete="cc-number" name="cardnumber">
        </form>
        <a href="https://github.com/login/oauth/authorize">sign in</a>
        <script>
          window.__compat = {};
          try {
            const promise = navigator.credentials.get({ publicKey: { challenge: new Uint8Array([1]) } });
            window.__compat.webauthnPromise = promise instanceof Promise;
            promise.catch(() => {});
          } catch (error) { window.__compat.webauthnError = String(error); }
          try {
            const request = new PaymentRequest(
              [{ supportedMethods: "https://example.com/pay" }],
              { total: { label: "T", amount: { currency: "USD", value: "1" } } }
            );
            window.__compat.payment = request instanceof PaymentRequest;
            window.__compat.paymentCtor = PaymentRequest.prototype.constructor === PaymentRequest;
            window.__compat.paymentSource = Function.prototype.toString.call(PaymentRequest);
          } catch (error) { window.__compat.paymentError = error.name; }
          const frame = document.createElement("iframe");
          frame.src = "http://localhost:" + location.port + "/cross.html";
          document.body.appendChild(frame);
          const password = document.querySelector("input[type=password]");
          const email = document.querySelector("input[type=email]");
          window.__compat.fields = {
            emailValue: email.value,
            passwordValue: password.value,
            types: [password.type, email.type, document.querySelector("[autocomplete]").getAttribute("autocomplete")],
          };
        </script>
      </body>`,
    "/cross.html": "<!doctype html><meta charset=utf-8><body>cross</body>",
  });
  await setProtectionMode(extension, "per_site");
  try {
    await page.goto(server.url("/login/index.html"), { waitUntil: "load" });
    const evidence = await waitForEvidence(
      extension,
      (value) =>
        signalCount(value, "compat", "password_field") >= 1 &&
        signalCount(value, "compat", "webauthn") >= 1 &&
        signalCount(value, "compat", "cross_origin_frame") >= 1
    );
    expect(evidence.compat).toEqual({
      card_field: 1,
      cross_origin_frame: 1,
      email_field: 1,
      login_path: 1,
      oauth_redirect: 1,
      password_field: 1,
      payment_request: 1,
      trusted_types: 1,
      webauthn: 1,
    });
    const behavior = await page.evaluate(() => {
      const compat = window.__compat;
      return {
        codecs: compat,
        fields: compat.fields,
        payment: compat.payment || false,
        paymentCtor: compat.paymentCtor || false,
        paymentNative: /native code/.test(compat.paymentSource || ""),
        webauthnPromise: compat.webauthnPromise,
      };
    });
    expect(behavior.webauthnPromise).toBe(true);
    expect(behavior.paymentCtor).toBe(true);
    expect(behavior.paymentNative).toBe(true);
    expect(behavior.fields).toEqual({
      emailValue: "",
      passwordValue: "",
      types: ["password", "email", "cc-number"],
    });
    expect(evidence.uaReads).toBeGreaterThanOrEqual(0);
    expectCatalogKeys(evidence);
  } finally {
    await page.close();
    await server.close();
  }
});

test("counts repeated challenge frames but dedupes one-shot compat signals", async ({
  extension,
}) => {
  const page = await extension.context.newPage();
  const frame = (index) =>
    `<iframe src="https://challenges.cloudflare.com/turnstile/v0/frame-${index}"></iframe>`;
  const server = await startFixtureServer({
    "/index.html": `<!doctype html><meta charset="utf-8"><body>
      ${[1, 2, 3, 4, 5].map(frame).join("\n")}
      <input type="password" name="one">
      <input type="password" name="two">
      <input type="password" name="three">
      <input type="password" name="four">
      <script>
        window.ddjskey = "client-key";
        window.__ua = [];
        for (let index = 0; index < 20; index++) window.__ua.push(navigator.userAgent);
      </script>
    </body>`,
  });
  await page.route("https://challenges.cloudflare.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><body>challenge</body>" })
  );
  await setProtectionMode(extension, "per_site");
  try {
    await page.goto(server.url("/index.html"), { waitUntil: "load" });
    const evidence = await waitForEvidence(
      extension,
      (value) =>
        signalCount(value, "compat", "captcha") >= 3 &&
        signalCount(value, "compat", "bot_challenge") >= 1
    );
    console.log(
      "CHALLENGE DEBUG",
      JSON.stringify({
        compat: evidence.compat,
        vendors: evidence.vendors,
        uaReads: evidence.uaReads,
        probes: evidence.probes && evidence.probes.total,
      })
    );
    expect(signalCount(evidence, "compat", "captcha")).toBe(3);
    expect(signalCount(evidence, "compat", "bot_challenge")).toBe(1);
    expect(signalCount(evidence, "compat", "password_field")).toBe(1);
    expect(signalCount(evidence, "vendors", "turnstile")).toBe(1);
    expect(signalCount(evidence, "vendors", "datadome")).toBe(1);
    expect(evidence.uaReads).toBeGreaterThanOrEqual(20);
    expect(evidence.pages).toBe(1);
    expectCatalogKeys(evidence);
  } finally {
    await page.close();
    await server.close();
  }
});

test("attributes frame probes to the top-level site", async ({ extension }) => {
  const page = await extension.context.newPage();
  const server = await startFixtureServer({
    "/top.html": `<!doctype html><meta charset="utf-8"><body><script>
      fetch(${JSON.stringify(extUrl("a", "/top-fetch.json"))}).catch(() => {});
      const frame = document.createElement("iframe");
      frame.src = "http://localhost:" + location.port + "/frame.html";
      document.body.appendChild(frame);
    </script></body>`,
    "/frame.html": `<!doctype html><meta charset="utf-8"><body><script>
      fetch(${JSON.stringify(extUrl("b", "/frame-fetch.json"))}).catch(() => {});
      fetch(${JSON.stringify(extUrl("c", "/frame-fetch.json"))}).catch(() => {});
      fetch(${JSON.stringify(extUrl("d", "/frame-fetch.json"))}).catch(() => {});
      navigator.userAgent;
      navigator.userAgent;
    </script></body>`,
  });
  await setProtectionMode(extension, "per_site");
  try {
    await page.goto(server.url("/top.html"), { waitUntil: "load" });
    const evidence = await waitForEvidence(
      extension,
      (value) => probeTotal(value) >= 2 && Object.keys(value.probes.ids || {}).length >= 2
    );
    expect(Object.keys(evidence.probes.ids)).toEqual(
      expect.arrayContaining([extId("a"), extId("b")])
    );
    expect(evidence.uaReads).toBeGreaterThanOrEqual(2);
    expect(evidence.probes.total).toBeGreaterThanOrEqual(2);
    expect(await siteEvidence(extension, "localhost")).toBeNull();
  } finally {
    await page.close();
    await server.close();
  }
});

test("is installed before the first page script (document_start)", async ({ extension }) => {
  const page = await extension.context.newPage();
  const server = await startFixtureServer({
    "/index.html": `<!doctype html><html><head><meta charset="utf-8">
      <script>
        window.__headProbe = typeof fetch;
        fetch(${JSON.stringify(extUrl("a", "/head-start.json"))}).catch(() => {});
      </script>
      </head><body><script>
        window.__bodyProbe = ${JSON.stringify(extUrl("b", "/body-start.json"))};
        fetch(window.__bodyProbe).catch(() => {});
      </script></body></html>`,
  });
  await setProtectionMode(extension, "per_site");
  try {
    await page.goto(server.url("/index.html"), { waitUntil: "load" });
    const evidence = await waitForEvidence(extension, (value) => probeTotal(value) >= 2);
    expect(evidence.probes.ids[extId("a")]).toBeGreaterThanOrEqual(1);
    expect(evidence.probes.ids[extId("b")]).toBeGreaterThanOrEqual(1);
  } finally {
    await page.close();
    await server.close();
  }
});

test("batches evidence without waiting for pagehide", async ({ extension }) => {
  const page = await extension.context.newPage();
  const server = await startFixtureServer({
    "/index.html": `<!doctype html><meta charset="utf-8"><body><script>
      fetch(${JSON.stringify(extUrl("a", "/flush.json"))}).catch(() => {});
    </script></body>`,
  });
  await setProtectionMode(extension, "per_site");
  const startedAt = Date.now();
  try {
    await page.goto(server.url("/index.html"), { waitUntil: "load" });
    await expect
      .poll(async () => probeTotal(await evidenceFor(extension)), {
        timeout: 2500,
        intervals: [50],
      })
      .toBeGreaterThanOrEqual(1);
    expect(Date.now() - startedAt).toBeLessThan(2500);
    expect(await page.evaluate(() => document.visibilityState)).toBe("visible");
  } finally {
    await page.close();
    await server.close();
  }
});

test("flushes the last batch when the page navigates away", async ({ extension }) => {
  const page = await extension.context.newPage();
  const letters = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
  const server = await startFixtureServer({
    "/blank.html": '<!doctype html><meta charset="utf-8"><body>blank</body>',
  });
  await setProtectionMode(extension, "per_site");
  try {
    await page.goto(server.url("/blank.html"), { waitUntil: "load" });
    let expected = 0;
    for (let round = 0; round < 3; round++) {
      const burst = letters
        .slice(round * 3, round * 3 + 3)
        .map((letter) => extUrl(letter, `/drain-${round}.png`));
      await page.evaluate((urls) => {
        for (const url of urls) new Image().src = url;
      }, burst);
      expected += burst.length;
      await page.goto(server.url(`/blank.html?round=${round + 1}`), { waitUntil: "load" });
      await expect
        .poll(async () => probeTotal(await evidenceFor(extension)), {
          timeout: 4000,
          intervals: [50],
        })
        .toBe(expected);
    }
  } finally {
    await page.close();
    await server.close();
  }
});

test("keeps a time-aware message budget for long probing sessions", async ({ extension }) => {
  const page = await extension.context.newPage();
  const server = await startFixtureServer({
    "/index.html": `<!doctype html><meta charset="utf-8"><body><script>
      const idFor = (value) => {
        let text = "";
        let number = value;
        for (let index = 0; index < 32; index++) {
          text += "abcdefghijklmnop"[number % 16];
          number = Math.floor(number / 16);
        }
        return text;
      };
      let fired = 0;
      const timer = setInterval(() => {
        const image = new Image();
        image.src = "chrome-extension://" + idFor(fired % 400) + "/burst-" + fired + ".png";
        fired += 1;
        if (fired >= 1600) {
          clearInterval(timer);
          window.__firstBurstDone = true;
        }
      }, 10);
    </script></body>`,
  });
  await setProtectionMode(extension, "per_site");
  try {
    await page.goto(server.url("/index.html"), { waitUntil: "load" });
    await page.waitForFunction(() => window.__firstBurstDone === true, null, { timeout: 30_000 });
    await expect
      .poll(async () => probeTotal(await evidenceFor(extension)), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1600);
    const before = probeTotal(await evidenceFor(extension));
    await page.evaluate(() => {
      for (let index = 0; index < 5; index++) {
        const image = new Image();
        image.src = `chrome-extension://${"m".repeat(32)}/second-${index}.png`;
      }
    });
    await expect
      .poll(async () => probeTotal(await evidenceFor(extension)), { timeout: 6000 })
      .toBe(before + 5);
  } finally {
    await page.close();
    await server.close();
  }
});

module.exports = { extId, extUrl, evidenceFor, signalCount, waitForEvidence, withScoutPage };
