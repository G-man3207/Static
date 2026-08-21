const { expect, test } = require("./helpers/extension-fixture");

const BITWARDEN = "nngceckbapebfimnlniiiahkandclblb";
const METAMASK = "nkbihfbeogaeaoehlefnkodbefgpgknn";
const probedUrl = (id, path) => `chrome-extension://${id}${path}`;

const seedLearnedPersona = async (extension, origin, { id = BITWARDEN, paths = {} } = {}) => {
  await extension.serviceWorker.evaluate(
    ({ pageOrigin, personaId, idPaths }) =>
      chrome.storage.local.set({
        noise_enabled: true,
        probe_log: {
          [pageOrigin]: {
            idCounts: { [personaId]: 2 },
            idPaths: { [personaId]: idPaths },
            lastUpdated: Date.now(),
          },
        },
        user_secret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      }),
    { pageOrigin: origin, personaId: id, idPaths: paths }
  );
};

const enableNoise = async (extension) => {
  await extension.serviceWorker.evaluate(() =>
    chrome.storage.local.set({
      noise_enabled: true,
      user_secret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    })
  );
};

const originLearnedPaths = (extension, origin) =>
  extension.serviceWorker.evaluate(async (pageOrigin) => {
    const { probe_log } = await chrome.storage.local.get("probe_log");
    return (probe_log && probe_log[pageOrigin] && probe_log[pageOrigin].idPaths) || {};
  }, origin);

const pathCountFor = (extension, origin, id, path) =>
  extension.serviceWorker.evaluate(
    async ({ pageOrigin, personaId, resourcePath }) => {
      const { probe_log } = await chrome.storage.local.get("probe_log");
      const entry = probe_log && probe_log[pageOrigin];
      return (
        (entry &&
          entry.idPaths &&
          entry.idPaths[personaId] &&
          entry.idPaths[personaId][resourcePath]) ||
        0
      );
    },
    { pageOrigin: origin, personaId: id, resourcePath: path }
  );

const fetchOutcome = async (page, url, method = "GET") =>
  page.evaluate(
    async ({ resourceUrl, httpMethod }) => {
      try {
        const response = await fetch(resourceUrl, { method: httpMethod });
        const contentType = response.headers.get("content-type") || "";
        const text = httpMethod === "HEAD" ? "" : await response.text();
        return {
          contentType,
          ok: response.ok,
          status: response.status,
          text,
          type: "fulfilled",
        };
      } catch (error) {
        return {
          message: String(error && error.message),
          name: error && error.name,
          type: "rejected",
        };
      }
    },
    { resourceUrl: url, httpMethod: method }
  );

test("Noise answers a learned LinkedIn-style WAR path that misses the allowlist", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await seedLearnedPersona(extension, server.origin, { paths: { "/inpage.js": 2 } });
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const learned = await fetchOutcome(page, probedUrl(BITWARDEN, "/inpage.js"));
  const canary = await fetchOutcome(page, probedUrl(BITWARDEN, "/canary-not-a-war-file.js"));
  const webp = await fetchOutcome(page, probedUrl(BITWARDEN, "/icon.webp"));

  expect(learned).toMatchObject({
    contentType: "application/javascript; charset=utf-8",
    ok: true,
    status: 200,
    text: "",
    type: "fulfilled",
  });
  expect(canary.type).toBe("rejected");
  expect(canary.name).toBe("TypeError");
  expect(webp.type).toBe("rejected");
});

test("Noise fetch and XHR agree on a learned CSS WAR path", async ({ extension, server }) => {
  const page = await extension.context.newPage();
  await seedLearnedPersona(extension, server.origin, {
    paths: { "/src/css/content.css": 2 },
  });
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const result = await page.evaluate(
    async (url) => {
      const response = await fetch(url);
      const fetchText = await response.text();
      const xhr = await new Promise((resolve) => {
        const request = new XMLHttpRequest();
        request.addEventListener("loadend", () => {
          resolve({
            allHeaders: request.getAllResponseHeaders(),
            contentType: request.getResponseHeader("content-type"),
            status: request.status,
            text: request.responseText,
          });
        });
        request.open("GET", url);
        request.send();
      });
      return {
        fetchContentType: response.headers.get("content-type"),
        fetchStatus: response.status,
        fetchText,
        xhr,
      };
    },
    probedUrl(BITWARDEN, "/src/css/content.css")
  );

  expect(result.fetchStatus).toBe(200);
  expect(result.fetchContentType).toBe("text/css; charset=utf-8");
  expect(result.fetchText).toBe("");
  expect(result.xhr.status).toBe(200);
  expect(result.xhr.contentType).toBe("text/css; charset=utf-8");
  expect(result.xhr.text).toBe("");
  expect(result.xhr.allHeaders.toLowerCase()).toContain("content-type:");
});

test("learned HTML and JSON WAR paths return synthesizable bodies", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await seedLearnedPersona(extension, server.origin, {
    paths: { "/phishing.html": 2, "/rules.json": 4 },
  });
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const html = await fetchOutcome(page, probedUrl(BITWARDEN, "/phishing.html"));
  const json = await fetchOutcome(page, probedUrl(BITWARDEN, "/rules.json"));
  const post = await fetchOutcome(page, probedUrl(BITWARDEN, "/inpage.js"), "POST");

  expect(html).toMatchObject({
    contentType: "text/html; charset=utf-8",
    ok: true,
    status: 200,
    type: "fulfilled",
  });
  expect(html.text).toContain("<!doctype html>");
  expect(json).toMatchObject({
    contentType: "application/json; charset=utf-8",
    ok: true,
    status: 200,
    text: "{}",
    type: "fulfilled",
  });
  expect(post.type).toBe("rejected");
});

test("a one-shot learned path count is not enough to decoy", async ({ extension, server }) => {
  const page = await extension.context.newPage();
  await seedLearnedPersona(extension, server.origin, { paths: { "/inpage.js": 1 } });
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const result = await fetchOutcome(page, probedUrl(BITWARDEN, "/inpage.js"));
  expect(result.type).toBe("rejected");
  expect(result.name).toBe("TypeError");
});

test("query strings are stripped before a WAR path is learned", async ({ extension, server }) => {
  const page = await extension.context.newPage();
  await enableNoise(extension);
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  await page.evaluate(
    async (url) => {
      await Promise.allSettled([fetch(url), fetch(url)]);
    },
    probedUrl(BITWARDEN, "/inpage.js?cache=1#frag")
  );

  await expect.poll(() => pathCountFor(extension, server.origin, BITWARDEN, "/inpage.js")).toBe(2);
  await expect
    .poll(() => pathCountFor(extension, server.origin, BITWARDEN, "/inpage.js?cache=1"))
    .toBe(0);
});

test("LinkedIn-style AED playbook is poisoned after two visits", async ({ extension, server }) => {
  await enableNoise(extension);
  const first = await extension.context.newPage();
  await first.goto(server.url("/blank.html"));
  await first.waitForTimeout(300);

  const firstVisit = await first.evaluate(
    async (probes) => {
      const results = await Promise.allSettled(probes.map((url) => fetch(url)));
      return results.map((result) => result.status);
    },
    [probedUrl(METAMASK, "/inpage.js"), probedUrl(METAMASK, "/inpage.js")]
  );
  expect(firstVisit).toEqual(["rejected", "rejected"]);

  await expect.poll(() => pathCountFor(extension, server.origin, METAMASK, "/inpage.js")).toBe(2);

  const second = await extension.context.newPage();
  await second.goto(server.url("/blank.html"));
  await second.waitForTimeout(300);

  const secondVisit = await fetchOutcome(second, probedUrl(METAMASK, "/inpage.js"));
  const stillCanary = await fetchOutcome(second, probedUrl(METAMASK, "/random-canary.js"));
  expect(secondVisit).toMatchObject({ ok: true, status: 200, type: "fulfilled" });
  expect(stillCanary.type).toBe("rejected");
});

test("learned script WAR paths decoy script.src without leaking the data URL", async ({
  extension,
  server,
}) => {
  const page = await extension.context.newPage();
  await seedLearnedPersona(extension, server.origin, { paths: { "/inpage.js": 2 } });
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const result = await page.evaluate(
    async (url) => {
      const script = document.createElement("script");
      const event = await new Promise((resolve) => {
        script.addEventListener("load", () => resolve("load"), { once: true });
        script.addEventListener("error", () => resolve("error"), { once: true });
        script.src = url;
        document.body.appendChild(script);
        setTimeout(() => resolve("timeout"), 1000);
      });
      return {
        event,
        getter: script.src,
        attribute: script.getAttribute("src"),
      };
    },
    probedUrl(BITWARDEN, "/inpage.js")
  );

  expect(result.event).toBe("load");
  expect(result.getter).toBe(probedUrl(BITWARDEN, "/inpage.js"));
  expect(result.attribute).toBe(probedUrl(BITWARDEN, "/inpage.js"));
});

test("learned script paths do not decoy image tags", async ({ extension, server }) => {
  const page = await extension.context.newPage();
  await seedLearnedPersona(extension, server.origin, { paths: { "/inpage.js": 2 } });
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const result = await page.evaluate(
    async (url) => {
      const image = new Image();
      const event = await new Promise((resolve) => {
        image.addEventListener("load", () => resolve("load"), { once: true });
        image.addEventListener("error", () => resolve("error"), { once: true });
        image.src = url;
        setTimeout(() => resolve("timeout"), 1000);
      });
      return { complete: image.complete, event, naturalWidth: image.naturalWidth };
    },
    probedUrl(BITWARDEN, "/inpage.js")
  );

  expect(result.event).not.toBe("load");
  expect(result.naturalWidth).toBe(0);
});

test("invalid path canaries never enter the learned map", async ({ extension, server }) => {
  const page = await extension.context.newPage();
  await enableNoise(extension);
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  await page.evaluate(async (id) => {
    const urls = [
      `chrome-extension://${id}//inpage.js`,
      `chrome-extension://${id}/in page.js`,
      `chrome-extension://${id}/icon.webp`,
    ];
    await Promise.allSettled(urls.flatMap((url) => [fetch(url), fetch(url)]));
  }, BITWARDEN);

  await expect
    .poll(async () => pathCountFor(extension, server.origin, BITWARDEN, "/icon.webp"))
    .toBe(2);
  await expect
    .poll(async () => pathCountFor(extension, server.origin, BITWARDEN, "/in page.js"))
    .toBe(0);
  const stored = await originLearnedPaths(extension, server.origin);
  const paths = stored[BITWARDEN] || {};
  expect(Object.keys(paths).some((path) => path.includes("//"))).toBe(false);
  expect(paths["/in page.js"]).toBeUndefined();
});
