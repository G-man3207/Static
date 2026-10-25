const { expect, test } = require("./helpers/extension-fixture");
const { startFixtureServer } = require("./helpers/server");

const SYNTHETIC_UA =
  /^Mozilla\/5\.0 \((?:Windows NT 10\.0; Win64; x64|Macintosh; Intel Mac OS X 10_15_7|X11; Linux x86_64)\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/152\.0\.0\.0 Safari\/537\.36$/;

const realVersionToken = (ua) => {
  const match = String(ua).match(/Chrome\/(\d+)/);
  return match && match[1] !== "152" ? match[1] : null;
};

test("default settings hide the user agent from page scripts and Client Hints", async ({
  extension,
}) => {
  const server = await startFixtureServer({
    "/blank.html": `<!doctype html><title>ua</title>
<script>window.__earlyUa = navigator.userAgent;</script>`,
  });
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await page.waitForTimeout(300);

  const native = await extension.serviceWorker.evaluate(() => navigator.userAgent);
  const seen = await page.evaluate(async () => {
    const high =
      navigator.userAgentData && navigator.userAgentData.getHighEntropyValues
        ? await navigator.userAgentData.getHighEntropyValues([
            "uaFullVersion",
            "fullVersionList",
            "platform",
          ])
        : null;
    return {
      early: window.__earlyUa,
      ua: navigator.userAgent,
      platform: navigator.platform,
      high,
    };
  });
  expect(seen.early).toMatch(SYNTHETIC_UA);
  expect(seen.early).not.toBe(native);
  expect(seen.ua).toMatch(SYNTHETIC_UA);
  expect(seen.ua).not.toBe(native);
  expect(["Win32", "MacIntel", "Linux x86_64"]).toContain(seen.platform);
  const realMajor = realVersionToken(native);
  if (seen.high) {
    expect(seen.high.uaFullVersion).toBe("152.0.0.0");
    expect(JSON.stringify(seen.high.fullVersionList)).toContain("152.0.0.0");
    if (realMajor) expect(JSON.stringify(seen.high)).not.toContain(realMajor);
  }

  await page.reload();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => navigator.userAgent)).toBe(seen.ua);
  await server.close();
});

test("a paused origin sees the native user agent", async ({ extension }) => {
  const server = await startFixtureServer({
    "/blank.html": "<!doctype html><title>ua</title>",
  });
  await extension.serviceWorker.evaluate(
    (origin) => chrome.storage.local.set({ disabled_origins: { [origin]: true } }),
    server.origin
  );
  const page = await extension.context.newPage();
  const baseline = await extension.context.newPage();
  await baseline.goto("about:blank");
  const native = await baseline.evaluate(() => navigator.userAgent);
  await page.goto(server.url("/blank.html"));
  const seen = await page.evaluate(() => navigator.userAgent);
  expect(seen).toBe(native);
  expect(seen).not.toContain("Chrome/152.0.0.0");
  await server.close();
});
