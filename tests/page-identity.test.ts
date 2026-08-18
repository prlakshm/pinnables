import assert from "node:assert/strict";
import test from "node:test";
import {
  isLocalUrl,
  isPinOnPage,
  originOf,
  pinLabel,
  shortenUrl,
  sourceLabel,
} from "../packages/shared/src/index.js";
import type { Pin } from "../packages/shared/src/index.js";

function pinAt(overrides: Partial<Pin>): Pin {
  return {
    id: "pin-1",
    schemaVersion: 1,
    boardId: "board-1",
    kind: "element",
    drawings: [],
    order: 1,
    groupId: null,
    provisional: false,
    url: "http://localhost:5185/#/catalogue",
    route: "/catalogue",
    viewport: { width: 1280, height: 800 },
    elementSize: { width: 100, height: 40 },
    screenshotPath: "",
    thumbnailPath: "",
    selector: ".card",
    domPath: "body > .card",
    outerHtml: "",
    classList: [],
    elementText: "",
    elementLabel: null,
    componentName: null,
    name: null,
    sourceFile: null,
    computedStyles: {},
    styleEdits: {},
    annotation: "",
    liveSends: [],
    captureState: "default",
    status: "todo",
    createdAt: "",
    updatedAt: "",
    ...overrides,
  } as Pin;
}

test("a dev server is recognised through every shape one takes", () => {
  for (const url of [
    "http://localhost:5185/",
    "http://localhost/",
    "http://app.localhost:3000/",
    "http://127.0.0.1:8080/x",
    "http://[::1]:5173/",
    "http://192.168.1.24:5173/",
    "http://10.0.0.7:5173/",
    "http://172.20.3.4:5173/",
    "http://accession.local:5173/",
    "http://api.test/",
  ]) {
    assert.equal(isLocalUrl(url), true, url);
  }

  for (const url of [
    "https://vercel.com/",
    "https://accession-git-main.vercel.app/catalogue",
    // Adjacent to a private range without being in one.
    "http://172.32.0.1/",
    "http://11.0.0.1/",
    "https://notlocalhost.com/",
  ]) {
    assert.equal(isLocalUrl(url), false, url);
  }
});

test("a shortened url keeps the host and the leaf, and drops the middle", () => {
  assert.equal(shortenUrl("https://vercel.com/"), "vercel.com");
  assert.equal(shortenUrl("https://www.vercel.com/"), "vercel.com");
  assert.equal(shortenUrl("https://stripe.com/pricing"), "stripe.com/pricing");
  // Query strings never identify a component.
  assert.equal(
    shortenUrl("https://www.notion.so/product/wikis?utm_source=nav#top"),
    "notion.so/product/wikis",
  );
  assert.equal(
    shortenUrl("https://github.com/anthropics/claude-code/blob/main/src/index.ts"),
    "github.com/…/index.ts",
  );
  assert.equal(
    shortenUrl("https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBd/edit"),
    "docs.google.com/…/edit",
  );
  // A non-default port survives; the parser has already dropped :443.
  assert.equal(shortenUrl("https://staging.acme.com:8443/"), "staging.acme.com:8443");
});

test("every shortened url fits its budget, cutting the leaf before the host", () => {
  const long = "https://stripe.com/how-to-accept-payments-online-a-complete-guide";
  const short = shortenUrl(long);
  assert.ok(short.length <= 28, `${short} (${short.length})`);
  assert.ok(short.startsWith("stripe.com/"), short);
  assert.ok(short.endsWith("…"), short);

  const deep = "https://example.com/a/b/c/an-extremely-long-trailing-segment-name";
  const cut = shortenUrl(deep);
  assert.ok(cut.length <= 28, `${cut} (${cut.length})`);
  assert.ok(cut.startsWith("example.com/…/"), cut);
});

test("the source line answers with the most actionable coordinate it has", () => {
  assert.equal(
    sourceLabel(pinAt({ sourceFile: "src/routes/Catalogue.tsx:12" })),
    "src/routes/Catalogue.tsx:12",
    "a file and line beats everything",
  );
  assert.equal(
    sourceLabel(pinAt({})),
    "/catalogue",
    "your own dev server answers with the route the agent can navigate to",
  );
  assert.equal(
    sourceLabel(pinAt({ url: "https://vercel.com/", route: "/" })),
    "vercel.com",
    "a site you do not own answers with the host, because its route says nothing",
  );
  assert.equal(
    sourceLabel(pinAt({ url: "", route: "/catalogue" })),
    "/catalogue",
    "an unparseable url falls back rather than showing nothing",
  );
});

/**
 * The bug: a capture from vercel.com has route "/", and so does the root of
 * every other site. Matching on path alone seated a foreign banner on the
 * user's own homepage.
 */
test("a pin belongs to a page only when the origin agrees too", () => {
  const foreign = pinAt({ url: "https://vercel.com/", route: "/" });
  assert.equal(isPinOnPage(foreign, { origin: "https://vercel.com", route: "/" }), true);
  assert.equal(isPinOnPage(foreign, { origin: "http://localhost:5185", route: "/" }), false);

  const mine = pinAt({});
  assert.equal(isPinOnPage(mine, { origin: "http://localhost:5185", route: "/catalogue" }), true);
  assert.equal(isPinOnPage(mine, { origin: "http://localhost:5185", route: "/vault" }), false);

  // A pin written before origins were recorded stays reachable on its route.
  const ancient = pinAt({ url: "" });
  assert.equal(isPinOnPage(ancient, { origin: "http://localhost:5185", route: "/catalogue" }), true);
  assert.equal(originOf(""), "");
});

test("an icon-only capture is named by what it could say, never left as element", () => {
  assert.equal(
    pinLabel(pinAt({ componentName: "CatalogueLede", elementLabel: "Twelve months" })),
    "CatalogueLede",
    "the build's name wins",
  );
  assert.equal(
    pinLabel(pinAt({ elementLabel: "Customer logos", elementText: "" })),
    "Customer logos",
    "a row of logos has no text and is still named",
  );
  assert.equal(
    pinLabel(pinAt({ elementLabel: "div · 1276×108", elementText: "" })),
    "div · 1276×108",
    "and at worst it is described the way the picker described it",
  );
  assert.equal(
    pinLabel(pinAt({ elementLabel: null, elementText: "Deploy now" })),
    "Deploy now",
    "pins captured before the ladder existed keep using their text",
  );
  assert.equal(pinLabel(pinAt({ name: "Hero banner", elementLabel: "div · 10×10" })), "Hero banner");
});
