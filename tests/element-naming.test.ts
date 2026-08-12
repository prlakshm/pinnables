import assert from "node:assert/strict";
import test from "node:test";

interface FakeGraphic {
  tag?: "img" | "svg";
  alt?: string;
  ariaLabel?: string;
  /** An `<svg><title>` child. */
  title?: string;
}

interface FakeSpec {
  tag: string;
  attrs?: Record<string, string>;
  classes?: string[];
  text?: string;
  heading?: { tag: string; text: string } | null;
  graphics?: FakeGraphic[];
  size?: { width: number; height: number };
}

/**
 * Hand-rolled stubs, matching how the rest of these tests handle DOM shapes —
 * the suite runs on bare node with no document implementation.
 */
function fake(spec: FakeSpec): Element {
  const attrs = spec.attrs ?? {};
  const graphics = (spec.graphics ?? []).map((graphic) => ({
    tagName: graphic.tag === "img" ? "IMG" : "svg",
    getAttribute: (name: string) =>
      name === "alt"
        ? (graphic.alt ?? null)
        : name === "aria-label"
          ? (graphic.ariaLabel ?? null)
          : null,
    querySelector: (selector: string) =>
      selector === "title" && graphic.title ? { textContent: graphic.title } : null,
  }));
  const heading = spec.heading
    ? { textContent: spec.heading.text, tagName: spec.heading.tag.toUpperCase() }
    : null;

  return {
    tagName: spec.tag.toUpperCase() === "SVG" ? "svg" : spec.tag.toUpperCase(),
    textContent: spec.text ?? "",
    classList: spec.classes ?? [],
    getAttribute: (name: string) => attrs[name] ?? null,
    matches: (selector: string) =>
      selector.includes(spec.tag.toLowerCase()) && selector.includes("h1, h2"),
    querySelector: (selector: string) => (selector.includes("h1") ? heading : null),
    querySelectorAll: (selector: string) => ({
      forEach: (fn: (node: unknown) => void) => {
        if (selector.includes("img, svg")) graphics.forEach(fn);
      },
      length: selector.includes("img, svg") ? graphics.length : 0,
      [Symbol.iterator]: function* () {
        if (selector.includes("img, svg")) yield* graphics;
      },
    }),
    getBoundingClientRect: () => ({
      width: spec.size?.width ?? 0,
      height: spec.size?.height ?? 0,
    }),
  } as unknown as Element;
}

Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    getElementById: (id: string) =>
      id === "logos-title" ? { textContent: "Trusted by" } : null,
  },
});

const { describeElement } = await import("../packages/extension/src/lib/capture.ts");

test("the author's own name for an element outranks everything derived", () => {
  assert.equal(
    describeElement(fake({ tag: "div", attrs: { "aria-label": "Customer logos" }, text: "junk" })),
    "Customer logos",
  );
  assert.equal(
    describeElement(fake({ tag: "section", attrs: { "aria-labelledby": "logos-title" } })),
    "Trusted by",
  );
  assert.equal(describeElement(fake({ tag: "button", attrs: { title: "Dismiss" } })), "Dismiss");
});

/**
 * Read off vercel.com: the masthead's first heading is "Agent Stack", which
 * names a dropdown inside the mega-menu and not the masthead at all.
 */
test("a page region is named for itself, not for a heading buried inside it", () => {
  assert.equal(
    describeElement(fake({ tag: "header", heading: { tag: "h3", text: "Agent Stack" } })),
    "header",
  );
  assert.equal(
    describeElement(fake({ tag: "form", heading: { tag: "h2", text: "Sign up" } })),
    "Sign up",
    "a form's heading is genuinely the form's",
  );
});

test("a section is named by its heading rather than its flattened contents", () => {
  const named = describeElement(
    fake({
      tag: "div",
      heading: { tag: "h2", text: "In flower this season" },
      text: "In flower this season 04 of 62 shown Rose Rosa gallica 78 4y 94%",
    }),
  );
  assert.equal(named, "In flower this season");
});

test("plain text is used when there is nothing better, and truncated", () => {
  assert.equal(describeElement(fake({ tag: "button", text: "Deploy now" })), "Deploy now");
  const long = describeElement(
    fake({ tag: "p", text: "One flower for every month of the year, the way they have" }),
  );
  assert.ok(long.length <= 29, long);
  assert.ok(long.endsWith("…"), long);
});

/**
 * Read off the real page, 2026-08-11: the element pinned in the recording is a
 * plain div of Tailwind utilities with no label, no id, no heading, no text and
 * no landmark. Its seven logos are `<svg aria-label="…">`, and the marquee
 * repeats the first one to scroll seamlessly.
 */
test("a logo strip is named by the logos, which is the only writing on it", () => {
  const vercelCustomerStrip = fake({
    tag: "div",
    classes: ["relative", "z-10", "shrink-0", "w-full", "pb-12", "@md:pb-10"],
    size: { width: 1232, height: 108 },
    graphics: [
      { ariaLabel: "Blackbox" },
      { ariaLabel: "Charles Schwab" },
      { ariaLabel: "DoorDash" },
      { ariaLabel: "OpenAI" },
      { ariaLabel: "Supreme" },
      { ariaLabel: "The Weather Company" },
      { ariaLabel: "Polymarket" },
      { ariaLabel: "Blackbox" },
    ],
  });
  assert.equal(describeElement(vercelCustomerStrip), "Blackbox, Charles Schwab + 5");
});

test("a lone graphic simply lends its name, however it carries it", () => {
  assert.equal(describeElement(fake({ tag: "a", graphics: [{ tag: "img", alt: "Vercel" }] })), "Vercel");
  assert.equal(
    describeElement(fake({ tag: "button", graphics: [{ title: "Close" }] })),
    "Close",
    "an svg title counts as much as an alt",
  );
  assert.equal(
    describeElement(fake({ tag: "div", graphics: [{ ariaLabel: "Rose" }, { ariaLabel: "Rose" }] })),
    "Rose",
    "the same picture twice is one picture",
  );
});

test("a hand-written class names a component when nothing else does", () => {
  assert.equal(describeElement(fake({ tag: "div", classes: ["logo-strip"] })), "logo strip");
  assert.equal(
    describeElement(fake({ tag: "div", classes: ["flex", "banner", "@lg:hero-x"], size: { width: 8, height: 8 } })),
    "div · 8×8",
    "a bare utility word is not a name, and neither is a variant",
  );
});

test("an element with nothing at all to say still says something true", () => {
  assert.equal(
    describeElement(fake({ tag: "div", size: { width: 1276, height: 108 } })),
    "div · 1276×108",
  );
});

test("an explicit role is a better name than a bare tag", () => {
  assert.equal(describeElement(fake({ tag: "div", attrs: { role: "banner" } })), "banner");
});
