/**
 * Settings shared by every provider.
 *
 * All of these are read at call time rather than captured at import, so a
 * restart is the only thing needed to change them — and tests can set them
 * without re-importing the module graph.
 */

import { projectRoot } from "../versions.js";

/**
 * The model, set once on the terminal command that starts the service:
 *
 *   PINNABLES_MODEL=claude-sonnet-5 npm run dev:service:claude
 *
 * Optional everywhere. Unset means each provider uses its own default, which
 * is the right choice far more often than not. This wins over the older
 * per-provider variables precisely because it is the one you type at the
 * prompt for a single run, while those tend to live in a shell profile.
 */
export function modelOverride(): string | null {
  return process.env.PINNABLES_MODEL?.trim() || null;
}

/**
 * The repo the agent edits: the app under annotation, not this package. Shared
 * by all three providers because a Send is always about the tree the designer
 * is looking at.
 */
export function projectDir(): string {
  return projectRoot();
}

/**
 * Both local SDKs shell out to their own CLI and find it on PATH. A service
 * started from a launcher, a login shell, or a packaged app often has a
 * narrower PATH than the terminal the user installed the CLI from — ~/.local/bin
 * being the usual casualty — so an explicit path is offered as the escape
 * hatch. Unset means trust PATH, which is right when it works.
 */
export function executableOverride(name: "claude" | "codex"): string | undefined {
  const key = name === "claude" ? "PINNABLES_CLAUDE_PATH" : "PINNABLES_CODEX_PATH";
  return process.env[key]?.trim() || undefined;
}
