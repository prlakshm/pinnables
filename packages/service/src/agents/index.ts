/**
 * Which agent receives a Send, chosen by the command that started the service.
 *
 *   npm run dev:service          → Cursor  (default; unset PINNABLES_AGENT)
 *   npm run dev:service:claude   → Claude Code
 *   npm run dev:service:codex    → Codex
 *
 * Every provider edits the same working tree and answers the same four
 * questions, so nothing downstream of here knows or cares which one is live.
 * The rest of the service talks to `sendToAgent` / `statusFromAgent` and gets
 * identical semantics either way.
 */

import { claudeProvider } from "./claude.js";
import { codexProvider } from "./codex.js";
import { cursorProvider } from "./cursor.js";
import type {
  AgentHealth,
  AgentKind,
  AgentProvider,
  AgentRuntime,
  AgentSendRequest,
  AgentSendResult,
  AgentStatus,
} from "./types.js";

export { imageFromDataUrl, imagesFromScreenshots } from "./images.js";
export { modelOverride, projectDir } from "./env.js";
export type {
  AgentHealth,
  AgentImage,
  AgentKind,
  AgentProvider,
  AgentRuntime,
  AgentSendRequest,
  AgentSendResult,
  AgentState,
  AgentStatus,
} from "./types.js";

const PROVIDERS: Record<AgentKind, AgentProvider> = {
  cursor: cursorProvider,
  claude: claudeProvider,
  codex: codexProvider,
};

/**
 * Throws on an unrecognized value rather than quietly falling back. A typo in
 * PINNABLES_AGENT that silently routed every Send to Cursor would be a genuinely
 * baffling afternoon; index.ts catches this at startup and exits with the message.
 */
export function agentKind(): AgentKind {
  const raw = (process.env.PINNABLES_AGENT ?? "cursor").trim().toLowerCase();
  if (raw === "cursor" || raw === "claude" || raw === "codex") return raw;
  throw new Error(
    `PINNABLES_AGENT="${raw}" is not a known agent. Use cursor, claude, or codex.`,
  );
}

/**
 * Resolved per call rather than captured at import, matching how every other
 * setting in this service is read. It is a map lookup, and it keeps tests free
 * to flip the variable without rebuilding the module graph.
 */
export function activeProvider(): AgentProvider {
  return PROVIDERS[agentKind()];
}

export function agentLabel(): string {
  return activeProvider().label;
}

export function agentConfigured(): boolean {
  return activeProvider().configured();
}

export function agentRuntime(): AgentRuntime {
  return activeProvider().runtime();
}

export function agentModel(): string | null {
  return activeProvider().model();
}

export function sendToAgent(req: AgentSendRequest): Promise<AgentSendResult> {
  return activeProvider().send(req);
}

export function statusFromAgent(agentId: string, runId: string): Promise<AgentStatus> {
  return activeProvider().status(agentId, runId);
}

export function isAgentBusyError(err: unknown): boolean {
  return activeProvider().isBusyError(err);
}

export function shouldAttachScreenshots(hasDrawings: boolean): boolean {
  return activeProvider().wantsImages(hasDrawings);
}

export function agentStatusSnapshot(): AgentHealth {
  return activeProvider().healthSnapshot();
}

export function agentSetupHint(): string {
  return activeProvider().setupHint();
}

export function agentInstallHint(): string {
  return activeProvider().installHint();
}

export function readStickyAgentId(): Promise<string | null> {
  return activeProvider().readStickyAgentId();
}

export function agentUrlFor(agentId: string): string | null {
  return activeProvider().agentUrl?.(agentId) ?? null;
}
