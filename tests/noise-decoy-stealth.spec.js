const { expect, test } = require("./helpers/extension-fixture");

const BITWARDEN = "nngceckbapebfimnlniiiahkandclblb";
const UBLOCK = "cjpalhdlnbpafiamejdnhcphjbkeiagm";
// Unknown-but-valid Chrome-shaped ID used only as a canary persona member.
const UNKNOWN_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const UNKNOWN_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const probedUrl = (id, path = "/manifest.json") => `chrome-extension://${id}${path}`;

const seedPersona = async (extension, origin, ids, { unknownIds = [] } = {}) => {
  // Known store IDs need count >= personaMinCount (2). Unknown IDs need
  // unknownPersonaMinCount (20) before they enter a persona.
  const unknown = new Set(unknownIds);
  const idCounts = Object.fromEntries(ids.map((id) => [id, unknown.has(id) ? 20 : 2]));
  await extension.serviceWorker.evaluate(
    ({ pageOrigin, counts }) =>
      chrome.storage.local.set({
        noise_enabled: true,
        probe_log: {
          [pageOrigin]: {
            idCounts: counts,
            lastUpdated: Date.now(),
          },
        },
        user_secret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      }),
    { pageOrigin: origin, counts: idCounts }
  );
};

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const GIF_MAGIC = [0x47, 0x49, 0x46, 0x38];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

const magicPrefix = (bytes, n) => Array.from(bytes.slice(0, n));

const waitForDecoy = async (page, url) => {
  await expect
    .poll(
      () =>
        page.evaluate(async (resourceUrl) => {
          try {
            const response = await fetch(resourceUrl);
            return !!(response && response.ok);
          } catch {
            return false;
          }
        }, url),
      { timeout: 15_000 }
    )
    .toBe(true);
};

const openSeededPage = async (extension, server, ids, options) => {
  await seedPersona(extension, server.origin, ids, options);
  const page = await extension.context.newPage();
  await page.goto(server.url("/blank.html"));
  await waitForDecoy(page, probedUrl(ids[0]));
  return page;
};

test("Noise manifests are ID-seeded and stable across fetch and XHR", async ({
  extension,
  server,
}) => {
  const page = await openSeededPage(extension, server, [BITWARDEN, UBLOCK, UNKNOWN_A, UNKNOWN_B], {
    unknownIds: [UNKNOWN_A, UNKNOWN_B],
  });

  const result = await page.evaluate(
    async (urls) => {
      const loadManifest = async (url) => {
        try {
          const response = await fetch(url);
          const text = await response.text();
          const xhrBody = await new Promise((resolve) => {
            const xhr = new XMLHttpRequest();
            xhr.addEventListener("loadend", () => resolve(xhr.responseText));
            xhr.open("GET", url);
            xhr.send();
          });
          return {
            fetch: JSON.parse(text),
            xhr: JSON.parse(xhrBody),
            status: response.status,
            ok: response.ok,
          };
        } catch {
          return { fetch: null, xhr: null, status: 0, ok: false };
        }
      };
      return {
        bitwarden: await loadManifest(urls.bitwarden),
        ublock: await loadManifest(urls.ublock),
        unknownA: await loadManifest(urls.unknownA),
        unknownB: await loadManifest(urls.unknownB),
      };
    },
    {
      bitwarden: probedUrl(BITWARDEN),
      ublock: probedUrl(UBLOCK),
      unknownA: probedUrl(UNKNOWN_A),
      unknownB: probedUrl(UNKNOWN_B),
    }
  );

  // Persona selection is a 3–8 ID subset; assert on IDs that actually decoyed.
  const decoyed = Object.entries(result).filter(([, entry]) => entry.ok && entry.status === 200);
  expect(decoyed.length).toBeGreaterThanOrEqual(2);

  expect(result.bitwarden.ok).toBe(true);
  expect(result.bitwarden.fetch).toEqual(result.bitwarden.xhr);
  expect(result.bitwarden.fetch.name).toBe("Bitwarden - Free Password Manager");
  expect(result.ublock.ok).toBe(true);
  expect(result.ublock.fetch.name).toBe("uBlock Origin");
  expect(result.bitwarden.fetch.name).not.toBe(result.ublock.fetch.name);

  // When unknown IDs are in the persona, names must stay diverse and seeded.
  for (const key of ["unknownA", "unknownB"]) {
    if (!result[key].ok) continue;
    expect(result[key].fetch.name).toMatch(/^(Quick|Smart|Simple|Secure|Fast|Easy|Pro|Lite) /);
    expect(result[key].fetch).toEqual(result[key].xhr);
  }
  if (result.unknownA.ok && result.unknownB.ok) {
    expect(result.unknownA.fetch.name).not.toBe(result.unknownB.fetch.name);
    expect(result.unknownA.fetch.version).not.toBe(result.unknownB.fetch.version);
  }

  for (const [, entry] of decoyed) {
    expect(entry.fetch.manifest_version).toBe(3);
    expect(entry.fetch.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(entry.fetch.icons).toMatchObject({
      16: "icon.png",
      48: "icon.png",
      128: "icon.png",
    });
  }
});

test("Noise image fetch decoys match path extension magic bytes and Content-Type", async ({
  extension,
  server,
}) => {
  const page = await openSeededPage(extension, server, [BITWARDEN]);

  const result = await page.evaluate(
    async (urls) => {
      const probe = async (url) => {
        try {
          const response = await fetch(url);
          const buffer = new Uint8Array(await response.arrayBuffer());
          return {
            ok: response.ok,
            status: response.status,
            contentType: response.headers.get("content-type"),
            magic: Array.from(buffer.slice(0, 4)),
            length: buffer.byteLength,
          };
        } catch (error) {
          return { ok: false, error: String(error && error.message) };
        }
      };
      return {
        png: await probe(urls.png),
        gif: await probe(urls.gif),
        jpeg: await probe(urls.jpeg),
        webp: await probe(urls.webp),
      };
    },
    {
      png: probedUrl(BITWARDEN, "/icon.png"),
      gif: probedUrl(BITWARDEN, "/icon.gif"),
      jpeg: probedUrl(BITWARDEN, "/icon.jpg"),
      webp: probedUrl(BITWARDEN, "/icon.webp"),
    }
  );

  expect(result.png.ok).toBe(true);
  expect(result.png.contentType).toBe("image/png");
  expect(magicPrefix(result.png.magic, 4)).toEqual(PNG_MAGIC);

  expect(result.gif.ok).toBe(true);
  expect(result.gif.contentType).toBe("image/gif");
  expect(magicPrefix(result.gif.magic, 4)).toEqual(GIF_MAGIC);

  expect(result.jpeg.ok).toBe(true);
  expect(result.jpeg.contentType).toBe("image/jpeg");
  expect(magicPrefix(result.jpeg.magic, 3)).toEqual(JPEG_MAGIC);

  // webp has no matching body generator — stay fail-closed rather than lie.
  expect(result.webp.ok).toBe(false);
});

test("Noise does not reuse one manifest body for every persona ID", async ({
  extension,
  server,
}) => {
  const page = await openSeededPage(extension, server, [BITWARDEN, UBLOCK]);

  const bodies = await page.evaluate(
    async (urls) => {
      const a = await (await fetch(urls.a)).text();
      const b = await (await fetch(urls.b)).text();
      return { a, b };
    },
    {
      a: probedUrl(BITWARDEN),
      b: probedUrl(UBLOCK),
    }
  );

  expect(bodies.a).not.toBe(bodies.b);
  expect(JSON.parse(bodies.a).name).not.toBe(JSON.parse(bodies.b).name);
});
