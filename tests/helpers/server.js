const fs = require("fs/promises");
const http = require("http");
const os = require("os");
const path = require("path");

async function startFixtureServer(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "static-fixtures-"));
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(root, filePath.replace(/^\/+/, ""));
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
  }

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, "http://127.0.0.1");
    const normalizedPath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
    const fullPath = path.join(root, normalizedPath.replace(/^\/+/, ""));

    try {
      const body = await fs.readFile(fullPath);
      const contentType = fullPath.endsWith(".html")
        ? "text/html; charset=utf-8"
        : "text/plain; charset=utf-8";
      res.writeHead(200, { "content-type": contentType });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    origin: `http://127.0.0.1:${port}`,
    url(filePath = "/index.html") {
      return `${this.origin}${filePath}`;
    },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

module.exports = {
  startFixtureServer,
};
