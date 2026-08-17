/**
 * Claude Code bridge.
 *
 * Always local: `query()` drives the Claude Code harness against the repo on
 * disk, so a running Vite/dev server hot-reloads the same way it does under
 * Cursor's local runtime. There is no cloud variant to opt into.
 *
 * Auth: whatever the `claude` CLI already uses — an existing login, or
 * ANTHROPIC_API_KEY. Sticky session: PINNABLES_CLAUDE_SESSION_ID, or the last
 * session id under ~/.pinnables/claude-session.json.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { query, type Options, type PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { pinnablesHome } from "@pinnables/shared/storage";
import { executableOverride, modelOverride, projectDir } from "./env.js";
import type {
  AgentHealth,
  AgentProvider,
  AgentSendRequest,
  AgentSendResult,
  AgentStatus,
} from "./types.js";

/**
 * A pin Send names its file and its change. The tools that turn a ten-second
 * colour edit into a minute of exploration — search, shell, subagents, web —
 * are left off for the same reason they are off on the Cursor path.
 */
const SEND_TOOLS = ["Read", "Edit", "Write", "Grep", "Glob"];

/**
 * Edits apply without prompting; everything else still asks. `bypassPermissions`
 * would also work and is strictly more permissive, which is exactly why it is
 * not the default for a tool pointed at someone's live repo.
 */
const PERMISSION_MODE: PermissionMode = "acceptEdits";

/** Opus unless told otherwise. Sends are small but they are load-bearing. */
const DEFAULT_MODEL = "claude-opus-5";

interface SessionFile {
  agentId: string;
  cwd?: string;
  updatedAt: string;
}

/**
 * Run outcomes, keyed by the run id we mint. `query()` is one call that
 * resolves when the work is done rather than a handle you poll, so the run's
 * terminal state is recorded here as it lands and `status()` reads it back.
 * This is the same shape the Cursor path uses for exactly the same reason:
 * a version key must never name a snapshot taken before the edits existed.
 */
const runResults = new Map<string, { state: "done" | "failed"; detail: string | null }>();
/** Runs that have started but not settled, so status can tell working from unknown. */
const runsInFlight = new Set<string>();
/** Session id per run, learned from the stream and needed for follow-ups. */
const runSessions = new Map<string, string>();

let lastHealth: { ok: boolean; detail: string | null } | null = null;

function recordHealth(ok: boolean, detail: string | null): void {
  lastHealth = { ok, detail };
}

/**
 * The SDK spawns the Claude Code CLI, so "configured" means that binary is
 * reachable. An API key is not required and often absent: a normal `claude`
 * login is the common case, and there is no way to check that from here
 * without spawning the CLI, which /health must never do. Treating the
 * provider as available and letting the first Send report a real error is
 * more honest than guessing at auth.
 */
export function claudeConfigured(): boolean {
  return true;
}

export function claudeModel(): string {
  return modelOverride() ?? process.env.PINNABLES_CLAUDE_MODEL?.trim() ?? DEFAULT_MODEL;
}

function sessionPath(): string {
  return join(pinnablesHome(), "claude-session.json");
}

export async function readStickyAgentId(): Promise<string | null> {
  const fromEnv = process.env.PINNABLES_CLAUDE_SESSION_ID?.trim();
  if (fromEnv) return fromEnv;
  try {
    const raw = await readFile(sessionPath(), "utf8");
    const parsed = JSON.parse(raw) as SessionFile;
    return parsed.agentId?.trim() || null;
  } catch {
    return null;
  }
}

async function writeStickyAgentId(agentId: string, cwd?: string): Promise<void> {
  await mkdir(pinnablesHome(), { recursive: true });
  const payload: SessionFile = {
    agentId,
    ...(cwd ? { cwd } : {}),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(sessionPath(), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/**
 * Claude Code runs one turn at a time per session, and a second `query()` on a
 * resumed session while the first is still going would interleave two edits
 * over one tree. The queue in index.ts already serialises Sends; this is what
 * tells it to.
 */
export function isAgentBusyError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /already (running|in progress)|session is busy|concurrent|locked/i.test(message);
}

/**
 * Screenshots ride as file paths inside the prompt rather than as bytes: the
 * PNGs are already on disk beside the message, and Read opens images. So the
 * cost of attaching one is a path, and the default can be generous where the
 * Cursor cloud path has to be stingy.
 */
export function shouldAttachScreenshots(hasDrawings: boolean): boolean {
  if (process.env.PINNABLES_SEND_IMAGES === "0") return false;
  if (hasDrawings) return true;
  return process.env.PINNABLES_SEND_IMAGES === "1";
}

/**
 * The prompt already carries selector, source file, and captured styles. When
 * there are screenshots on disk, name them: Read handles images, and a pen
 * mark is not describable in text.
 */
function withImagePaths(text: string, req: AgentSendRequest): string {
  const paths = (req.images ?? []).map((image) => image.path).filter(Boolean);
  if (paths.length === 0) return text;
  return (
    `${text}\n\n` +
    `Screenshots of the pinned elements are on disk. Read them before editing:\n` +
    paths.map((path) => `- ${path}`).join("\n")
  );
}

function buildOptions(resume: string | null): Options {
  const executable = executableOverride("claude");
  return {
    model: claudeModel(),
    cwd: projectDir(),
    permissionMode: PERMISSION_MODE,
    allowedTools: SEND_TOOLS,
    /* The annotated repo's own CLAUDE.md and settings are not this service's
       business, and loading them would let an unrelated project's rules
       reshape a one-line style edit. */
    settingSources: [],
    ...(resume ? { resume } : {}),
    ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
  };
}

/**
 * One Send is one `query()`. We mint the run id because the SDK has no notion
 * of one; the session id it reports becomes the sticky agent id so the next
 * Send is a follow-up on the same conversation.
 */
export async function sendToClaude(req: AgentSendRequest): Promise<AgentSendResult> {
  const cwd = projectDir();
  const sticky = req.agentId ?? (await readStickyAgentId());
  const runId = `claude-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const mode: AgentSendResult["mode"] = sticky ? "follow-up" : "create";

  const stream = query({
    prompt: withImagePaths(req.text, req),
    options: buildOptions(sticky),
  });

  runsInFlight.add(runId);

  /*
   * Drained in the background so the POST can answer immediately, the same way
   * the Cursor path hands back a run id and lets the extension poll. The
   * terminal `result` message is the moment the edits are actually on disk, so
   * that — not the first byte, and not the call resolving — is what settles the
   * run and releases the version snapshot.
   */
  void (async () => {
    try {
      for await (const message of stream) {
        if ("session_id" in message && message.session_id) {
          const sessionId = message.session_id;
          if (runSessions.get(runId) !== sessionId) {
            runSessions.set(runId, sessionId);
            await writeStickyAgentId(sessionId, cwd).catch(() => {});
          }
        }
        if (message.type === "result") {
          if (message.subtype === "success" && !message.is_error) {
            runResults.set(runId, { state: "done", detail: null });
          } else {
            const detail =
              "errors" in message && message.errors?.length
                ? message.errors.join("; ")
                : `Claude run ended with ${message.subtype}`;
            runResults.set(runId, { state: "failed", detail });
          }
          recordHealth(true, null);
        }
      }
      /* A stream that ends without a result message never reached the model. */
      if (!runResults.has(runId)) {
        runResults.set(runId, {
          state: "failed",
          detail: "Claude run ended without a result",
        });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      runResults.set(runId, { state: "failed", detail });
      recordHealth(false, detail);
    } finally {
      runsInFlight.delete(runId);
    }
  })();

  return {
    agentId: sticky ?? runId,
    runId,
    url: null,
    mode,
    runtime: "local",
    cwd,
  };
}

export async function statusFromClaude(
  agentId: string,
  runId: string,
): Promise<AgentStatus> {
  const settled = runResults.get(runId);
  const sessionId = runSessions.get(runId) ?? agentId;
  if (settled) {
    runResults.delete(runId);
    runSessions.delete(runId);
    return { ...settled, agentId: sessionId, runId, url: null };
  }
  if (runsInFlight.has(runId)) {
    /* Once the session id is known the harness has answered, so the run has
       moved past merely having been asked. */
    const state = runSessions.has(runId) ? "working" : "starting";
    return { state, detail: null, agentId: sessionId, runId, url: null };
  }
  return {
    state: "failed",
    detail: "Unknown Claude run",
    agentId: sessionId,
    runId,
    url: null,
  };
}

export function claudeStatusSnapshot(): AgentHealth {
  return {
    ok: lastHealth?.ok ?? true,
    detail: lastHealth ? lastHealth.detail : "waiting for the first send",
    runtime: "local",
    cwd: projectDir(),
  };
}

export const claudeProvider: AgentProvider = {
  kind: "claude",
  label: "Claude Code",
  configured: claudeConfigured,
  runtime: () => "local",
  model: claudeModel,
  send: sendToClaude,
  status: statusFromClaude,
  isBusyError: isAgentBusyError,
  wantsImages: shouldAttachScreenshots,
  healthSnapshot: claudeStatusSnapshot,
  readStickyAgentId,
  setupHint: () => "Run claude login in a terminal, then restart the service.",
  installHint: () =>
    "Install Claude Code, or set PINNABLES_CLAUDE_PATH to its full path on the local service.",
};
