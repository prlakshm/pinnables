import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

/**
 * Static server for the fixtures, so there is something on localhost to pin.
 * Deliberately dependency-free — this exists to be started and forgotten, not
 * to be a build tool.
 *
 * Two fixtures, two jobs. `demo-app` is the ugly one: four card treatments that
 * disagree, built to exercise the tool. `film-set` is the one you record on —
 * same disagreements underneath, but it has to look like a product a designer
 * would actually be reviewing, or the recording reads as a toy.
 */

const FIXTURES = {
  demo: { dir: "fixtures/demo-app", port: 5180, routes: "/#/dashboard  /#/settings  /#/reports" },
  film: { dir: "fixtures/film-set", port: 5181, routes: "/#/catalogue  /#/variety  /#/almanac  /#/vault" },
};

const which = process.argv[2] ?? "demo";
const fixture = FIXTURES[which];
if (!fixture) {
  console.error(`Unknown fixture "${which}". Try: ${Object.keys(FIXTURES).join(", ")}`);
  process.exit(1);
}

const ROOT = resolve(fixture.dir);
// 5173 is Vite's default and is usually already taken by whatever you're
// actually working on. Override with PORT= if these clash too.
const PORT = Number(process.env.PORT ?? fixture.port);

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
    // Never cache. These files are edited constantly and a stale fixture is a
    // bug hunt that has nothing to do with the tool.
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    // Single-page app: unknown paths fall through to the shell.
    res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" });
    res.end(await readFile(join(ROOT, "index.html")));
  }
}).listen(PORT, () => {
  console.log(`${which.padEnd(5)}  →  http://localhost:${PORT}`);
  console.log(`Routes  →  ${fixture.routes}`);
});
