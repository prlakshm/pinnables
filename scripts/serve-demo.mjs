import { createServer } from "node:http";
import { watch } from "node:fs";
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

/*
 * Live update, so an agent edit shows up without anyone pressing ⌘R — and,
 * since version flips rewrite this same file, so a restore shows up too.
 *
 * Two speeds, chosen per change. A style-only change swaps the <style> text
 * in place: no navigation, no flash, the extension's overlay never remounts —
 * which is what makes flipping between versions look like flipping, not like
 * reloading. Anything that touches markup falls back to a full reload,
 * because morphing a live DOM under an extension that holds references into
 * it is how you get haunted pages. The fallback is the old behaviour exactly,
 * so smoothness never costs correctness.
 */
const reloadClients = new Set();
let reloadTimer = null;
watch(ROOT, { recursive: true }, () => {
  // Editors fire bursts of events per save; one reload per burst is plenty.
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    for (const client of reloadClients) client.write("data: reload\n\n");
  }, 80);
});

const RELOAD_PATH = "/__pinnables_reload";
// EventSource reconnects on its own after a server restart, so the page keeps
// listening across `npm run film` sessions without any client-side ceremony.
// The baseline body is fetched once at load rather than read from the live
// DOM: the fixture's own router has already mutated the DOM by the time this
// runs, and the comparison must be raw-file against raw-file.
const RELOAD_SNIPPET = `<script>
(() => {
  let baseline = null;
  const raw = async () => {
    const res = await fetch(location.href, { cache: "no-store" });
    return new DOMParser().parseFromString(await res.text(), "text/html");
  };
  raw().then((doc) => { baseline = doc.body.innerHTML; }).catch(() => {});
  new EventSource("${RELOAD_PATH}").onmessage = async () => {
    try {
      const doc = await raw();
      const mine = document.head.querySelectorAll("style");
      const theirs = doc.head.querySelectorAll("style");
      const styleOnly =
        baseline !== null &&
        doc.body.innerHTML === baseline &&
        mine.length === theirs.length;
      if (!styleOnly) { location.reload(); return; }
      mine.forEach((s, i) => {
        if (s.textContent !== theirs[i].textContent) s.textContent = theirs[i].textContent;
      });
    } catch { location.reload(); }
  };
})();
</script>`;

const withReload = (html) => {
  const text = html.toString();
  return text.includes("</body>")
    ? text.replace("</body>", `${RELOAD_SNIPPET}</body>`)
    : text + RELOAD_SNIPPET;
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (url.pathname === RELOAD_PATH) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write("retry: 500\n\n");
    reloadClients.add(res);
    req.on("close", () => reloadClients.delete(res));
    return;
  }

  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  try {
    const body = await readFile(join(ROOT, file));
    // Never cache. These files are edited constantly and a stale fixture is a
    // bug hunt that has nothing to do with the tool.
    const isHtml = (TYPES[extname(file)] ?? "") === TYPES[".html"];
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(isHtml ? withReload(body) : body);
  } catch {
    // Single-page app: unknown paths fall through to the shell.
    res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" });
    res.end(withReload(await readFile(join(ROOT, "index.html"))));
  }
}).listen(PORT, () => {
  console.log(`${which.padEnd(5)}  →  http://localhost:${PORT}`);
  console.log(`Routes  →  ${fixture.routes}`);
});
