import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

/**
 * Static server for the demo app, so there is something on localhost to pin.
 * Deliberately dependency-free — this exists to be started and forgotten, not
 * to be a build tool.
 */

const ROOT = resolve("fixtures/demo-app");
// 5173 is Vite's default and is usually already taken by whatever you're
// actually working on. Override with PORT= if 5180 clashes too.
const PORT = Number(process.env.PORT ?? 5180);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  try {
    const body = await readFile(join(ROOT, file));
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    // Single-page app: unknown paths fall through to the shell.
    res.writeHead(200, { "content-type": TYPES[".html"] });
    res.end(await readFile(join(ROOT, "index.html")));
  }
}).listen(PORT, () => {
  console.log(`Demo app  →  http://localhost:${PORT}`);
  console.log(`Routes    →  /#/dashboard  /#/settings  /#/reports`);
});
