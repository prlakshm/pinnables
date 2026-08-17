import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

/**
 * One job: catch hook-order bugs before they ship.
 *
 * On 2026-08-16 two early returns in OverlayRoot sat above hooks that later
 * work had appended below them. The first disabled render consumed fewer
 * hooks than the armed render before it, React threw error #300, and the
 * whole overlay unmounted — toggling capture looked dead until a page
 * reload. rules-of-hooks flags exactly that shape at lint time.
 *
 * Scope is the extension source only, and only the two react-hooks rules:
 * this is a tripwire, not a style regime.
 */
export default [
  {
    files: ["packages/extension/src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
