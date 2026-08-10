import path from "node:path";
import ts from "typescript";

/**
 * Stamp every DOM element with the file and line that wrote it.
 *
 * This is the primary source-mapping path, not a convenience. The fallback in
 * the extension walks the React fiber for `_debugSource`, which React 19
 * removed outright — so on a current React app, without this plugin, a pin can
 * name the component but cannot say where it lives. An agent handed "the
 * StatCard" has to go find it; an agent handed `src/components/StatCard.tsx:12`
 * opens the file.
 *
 * The transform inserts attributes immediately after the tag name, which keeps
 * every character on the line it started on. Columns shift, lines do not, so
 * stack traces and breakpoints stay honest without a source map.
 */

export interface PinnablesPluginOptions {
  /**
   * Stamp production builds too. Off by default: these attributes publish your
   * source tree to anyone who opens the inspector, which is a reasonable thing
   * to ship on localhost and a strange thing to ship to users.
   */
  includeProduction?: boolean;
  /** Files to transform. Defaults to .jsx and .tsx outside node_modules. */
  include?: (id: string) => boolean;
}

interface VitePluginShape {
  name: string;
  enforce?: "pre" | "post";
  apply?: "serve" | "build";
  transform: (
    code: string,
    id: string,
  ) => { code: string; map: null } | null;
}

const SOURCE_ATTR = "data-pin-source";
const COMPONENT_ATTR = "data-pin-component";

export function pinnables(options: PinnablesPluginOptions = {}): VitePluginShape {
  const root = process.cwd();
  const include =
    options.include ?? ((id: string) => /\.[jt]sx$/.test(id) && !id.includes("node_modules"));

  return {
    name: "pinnables",
    // Before the React plugin compiles JSX away — after it, there are no
    // elements left to stamp, only `jsx()` calls.
    enforce: "pre",
    ...(options.includeProduction ? {} : { apply: "serve" as const }),

    transform(code: string, id: string) {
      const file = id.split("?")[0];
      if (!include(file)) return null;
      const stamped = stamp(code, path.relative(root, file));
      return stamped === code ? null : { code: stamped, map: null };
    },
  };
}

/** Insert the two attributes into every host element that lacks them. */
function stamp(code: string, relativePath: string): string {
  const source = ts.createSourceFile(
    relativePath,
    code,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    relativePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const inserts: Array<{ at: number; text: string }> = [];

  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      // Lowercase means a real DOM element. A capitalized tag is a component,
      // where `data-*` is just a prop the component is free to drop on the
      // floor — stamping it would produce attributes that never reach the DOM.
      if (isHostElement(tag) && !hasAttribute(node, SOURCE_ATTR)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const component = enclosingComponent(node, source);
        inserts.push({
          at: node.tagName.getEnd(),
          text:
            ` ${SOURCE_ATTR}="${relativePath}:${line}"` +
            (component ? ` ${COMPONENT_ATTR}="${component}"` : ""),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  if (inserts.length === 0) return code;

  // Back to front, so each insertion's offset is still valid when it is applied.
  let out = code;
  for (const { at, text } of inserts.sort((a, b) => b.at - a.at)) {
    out = out.slice(0, at) + text + out.slice(at);
  }
  return out;
}

/** `div`, `my-widget` — anything not starting with a capital or a namespace. */
function isHostElement(tag: string): boolean {
  if (tag.includes(".")) return false;
  const first = tag[0];
  return first !== undefined && first === first.toLowerCase() && /[a-z]/.test(first);
}

function hasAttribute(
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string,
): boolean {
  return node.attributes.properties.some(
    (prop) => ts.isJsxAttribute(prop) && prop.name.getText() === name,
  );
}

/**
 * The nearest enclosing thing with a capitalized name.
 *
 * Walking up rather than reading the file's default export, because one file
 * routinely holds a page component and three small ones beside it, and the pin
 * should name the one the element is actually inside.
 */
function enclosingComponent(node: ts.Node, source: ts.SourceFile): string | null {
  let current: ts.Node | undefined = node.parent;

  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) {
      const name = current.name.getText(source);
      if (isComponentName(name)) return name;
    }

    // `const Card = () => …` and `const Card = function () {…}` both land here,
    // where the name lives on the declaration rather than the function.
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      current.parent &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      const name = current.parent.name.getText(source);
      if (isComponentName(name)) return name;
    }

    if (ts.isClassDeclaration(current) && current.name) {
      const name = current.name.getText(source);
      if (isComponentName(name)) return name;
    }

    current = current.parent;
  }
  return null;
}

function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

export default pinnables;
