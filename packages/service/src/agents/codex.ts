/**
 * Codex bridge.
 *
 * Always local: the SDK drives the `codex` CLI against the repo on disk, so a
 * running Vite/dev server hot-reloads exactly as it does under the other two
 * providers.
 *
 * Auth: whatever `codex` already uses — a ChatGPT login, or OPENAI_API_KEY.
 * Sticky session: PINNABLES_CODEX_THREAD_ID, or the last thread id under
 * ~/.pinnables/codex-session.json. Codex persists threads in ~/.codex/sessions,
 * so resuming one survives a service restart.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Codex, type Thread, type ThreadOptions, type UserInput } from "@openai/codex-sdk";
import { pinnablesHome } from "@pinnables/shared/storage";
import { executableOverride, modelOverride, projectDir } from "./env.js";
import type {
  AgentHealth,
  AgentProvider,
  AgentSendRequest,
  AgentSendResult,
  AgentStatus,
} from "./types.js";

interface SessionFile {
  agentId: string;
  cwd?: string;
  updatedAt: string;
}

/**
 * Terminal run outcomes keyed by our run id. `run()` resolves only when the
 * turn is over, so — as on the Claude path — the outcome is recorded here as
 * it lands and read back by `status()`, which is what keeps a version snapshot
 * from being taken against a tree the agent has not written to yet.
 */
const runResults = new Map<string, { state: "done" | "failed"; detail: string | null }>();
const runsInFlight = new Set<string>();
/** Thread id per run. Null until the first turn starts, per the SDK. */
const runThreads = new Map<string, string>();

let lastHealth: { ok: boolean; detail: string | null } | null = null;

function recordHealth(ok: boolean, detail: string | null): void {
  lastHealth = { ok, detail };
}

/**
 * Same reasoning as the Claude provider: the SDK shells out to a CLI that
 * carries its own login, and /health must not spawn a process to find out. Say
 * available, and let the first Send report a real failure if there is one.
 */
export function codexConfigured(): boolean {
  return true;
}

/** Null means Codex picks, which is the right default for a model list we do not own. */
export function codexModel(): string | null {
  return modelOverride() ?? process.env.PINNABLES_CODEX_MODEL?.trim() ?? null;
}

function sessionPath(): string {
  return join(pinnablesHome(), "codex-session.json");
}

export async function readStickyAgentId(): Promise<string | null> {
  const fromEnv = process.env.PINNABLES_CODEX_THREAD_ID?.trim();
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

export function isAgentBusyError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /already (running|in progress)|thread is busy|concurrent|locked/i.test(message);
}

/**
 * Codex takes images as local file paths, so attaching one costs a path rather
 * than a base64 payload. Generous by default for that reason; a pen mark still
 * forces it on regardless.
 */
export function shouldAttachScreenshots(hasDrawings: boolean): boolean {
  if (process.env.PINNABLES_SEND_IMAGES === "0") return false;
  if (hasDrawings) return true;
  return process.env.PINNABLES_SEND_IMAGES === "1";
}

function threadOptions(): ThreadOptions {
  const model = codexModel();
  return {
    workingDirectory: projectDir(),
    /* The agent must be able to write the file it was asked to change, and
       nothing outside the repo it was pointed at. */
    sandboxMode: "workspace-write",
    /* A Send never needs to ask: the instruction is the approval. */
    approvalPolicy: "never",
    /* Pinnables is often pointed at a scratch app that is not a git repo. */
    skipGitRepoCheck: true,
    ...(model ? { model } : {}),
  };
}

/**
 * Text first, then any screenshots as native image inputs. Codex reads these
 * from disk itself, which is why writeLiveArtifacts having already written the
 * PNGs is load-bearing here.
 */
function buildInput(req: AgentSendRequest): UserInput[] {
  const input: UserInput[] = [{ type: "text", text: req.text }];
  for (const image of req.images ?? []) {
    if (image.path) input.push({ type: "local_image", path: image.path });
  }
  return input;
}

function client(): Codex {
  const codexPathOverride = executableOverride("codex");
  return new Codex(codexPathOverride ? { codexPathOverride } : {});
}

export async function sendToCodex(req: AgentSendRequest): Promise<AgentSendResult> {
  const cwd = projectDir();
  const sticky = req.agentId ?? (await readStickyAgentId());
  const runId = `codex-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const codex = client();

  let thread: Thread;
  let mode: AgentSendResult["mode"];
  if (sticky) {
    thread = codex.resumeThread(sticky, threadOptions());
    mode = "follow-up";
  } else {
    thread = codex.startThread(threadOptions());
    mode = "create";
  }

  runsInFlight.add(runId);
  if (sticky) runThreads.set(runId, sticky);

  /*
   * Streamed rather than awaited whole, so the run can report "working" the
   * moment the turn actually starts instead of staying "starting" until every
   * edit is done. `turn.completed` is the point the files are written.
   */
  void (async () => {
    try {
      const { events } = await thread.runStreamed(buildInput(req));
      let completed = false;
      for await (const event of events) {
        if (event.type === "thread.started" || thread.id) {
          const id = thread.id;
          if (id && runThreads.get(runId) !== id) {
            runThreads.set(runId, id);
            await writeStickyAgentId(id, cwd).catch(() => {});
          }
        }
        if (event.type === "turn.completed") {
          completed = true;
          runResults.set(runId, { state: "done", detail: null });
          recordHealth(true, null);
        }
        if (event.type === "turn.failed") {
          completed = true;
          runResults.set(runId, {
            state: "failed",
            detail: "Codex turn failed",
          });
          recordHealth(true, null);
        }
        if (event.type === "error") {
          completed = true;
          runResults.set(runId, { state: "failed", detail: event.message });
          recordHealth(false, event.message);
        }
      }
      if (!completed) {
        runResults.set(runId, {
          state: "failed",
          detail: "Codex run ended without completing a turn",
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

export async function statusFromCodex(
  agentId: string,
  runId: string,
): Promise<AgentStatus> {
  const settled = runResults.get(runId);
  const threadId = runThreads.get(runId) ?? agentId;
  if (settled) {
    runResults.delete(runId);
    runThreads.delete(runId);
    return { ...settled, agentId: threadId, runId, url: null };
  }
  if (runsInFlight.has(runId)) {
    const state = runThreads.has(runId) ? "working" : "starting";
    return { state, detail: null, agentId: threadId, runId, url: null };
  }
  return {
    state: "failed",
    detail: "Unknown Codex run",
    agentId: threadId,
    runId,
    url: null,
  };
}

export function codexStatusSnapshot(): AgentHealth {
  return {
    ok: lastHealth?.ok ?? true,
    detail: lastHealth ? lastHealth.detail : "waiting for the first send",
    runtime: "local",
    cwd: projectDir(),
  };
}

export const codexProvider: AgentProvider = {
  kind: "codex",
  label: "Codex",
  configured: codexConfigured,
  runtime: () => "local",
  model: codexModel,
  send: sendToCodex,
  status: statusFromCodex,
  isBusyError: isAgentBusyError,
  wantsImages: shouldAttachScreenshots,
  healthSnapshot: codexStatusSnapshot,
  readStickyAgentId,
  setupHint: () => "Run codex login in a terminal, then restart the service.",
  installHint: () =>
    "Install Codex, or set PINNABLES_CODEX_PATH to its full path on the local service.",
};
