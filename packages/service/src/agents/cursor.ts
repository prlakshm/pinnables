/**
 * Cursor agent bridge.
 *
 * Default runtime is **local** (`@cursor/sdk` with `local.cwd`): Send edits the
 * repo on disk so a running Vite/dev server hot-reloads. Cloud Agents clone a
 * remote repo onto a VM and often open a PR branch — that is opt-in via
 * `PINNABLES_CURSOR_RUNTIME=cloud`.
 *
 * Auth: CURSOR_API_KEY (Dashboard → Integrations / API Keys). Sticky session:
 * PINNABLES_CURSOR_AGENT_ID, or the last agent id under
 * ~/.pinnables/cursor-session.json.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  Agent,
  AgentBusyError,
  type ModelSelection,
  type Run,
  type SDKAgent,
  type ToolName,
} from "@cursor/sdk";
import { pinnablesHome } from "@pinnables/shared/storage";
import { modelOverride, projectDir } from "./env.js";
import type {
  AgentHealth,
  AgentProvider,
  AgentRuntime,
  AgentSendRequest,
  AgentSendResult,
  AgentStatus,
} from "./types.js";

function apiBase(): string {
  return (process.env.CURSOR_API_BASE ?? "https://api.cursor.com").replace(/\/$/, "");
}


/** Cloud REST run states. The local SDK reports its own, lowercase set. */
export type CursorRunStatus = "CREATING" | "RUNNING" | "FINISHED" | "ERROR" | "CANCELLED" | "EXPIRED";

interface SessionFile {
  agentId: string;
  runtime: AgentRuntime;
  cwd?: string;
  updatedAt: string;
}

/** In-process local agent handles — keep conversation sticky across Sends. */
const localAgents = new Map<string, SDKAgent>();
/** Live Run handles for status polling before they settle. */
const localRuns = new Map<string, Run>();
/** wait() settlement — the send() handle's status is a snapshot and must not mint Done. */
const localRunResults = new Map<string, { state: "done" | "failed"; detail: string | null }>();

function apiKey(): string | null {
  const key = process.env.CURSOR_API_KEY?.trim();
  return key || null;
}

export function cursorConfigured(): boolean {
  return Boolean(apiKey());
}

export function cursorRuntime(): AgentRuntime {
  const raw = (process.env.PINNABLES_CURSOR_RUNTIME ?? "local").trim().toLowerCase();
  return raw === "cloud" ? "cloud" : "local";
}

/**
 * Live pin edits are short, named-file changes. Fast Composer is the right
 * default — full Composer 2.5 (and vision) is what made Send feel stuck.
 * Set PINNABLES_CURSOR_FAST=0 for the slower, higher-quality variant.
 *
 * PINNABLES_MODEL wins over PINNABLES_CURSOR_MODEL: the general one is typed
 * on the command that starts the service, the older specific one tends to sit
 * in a shell profile, and the thing you just typed should be the thing that
 * takes effect.
 */
export function cursorModel(): string {
  return (
    modelOverride() ?? process.env.PINNABLES_CURSOR_MODEL?.trim() ?? "composer-2.5"
  );
}

export function modelSelection(): ModelSelection {
  const id = cursorModel();
  const fast = process.env.PINNABLES_CURSOR_FAST !== "0";
  if (fast && /^composer/i.test(id)) {
    return { id, params: [{ id: "fast", value: "true" }] };
  }
  return { id };
}

/**
 * Screenshots are expensive. Local text pins already carry source file + styles.
 * Pen marks are the exception: the agent cannot see a drawing without the PNG.
 */
export function sendImagesEnabled(): boolean {
  if (process.env.PINNABLES_SEND_IMAGES === "1") return true;
  if (process.env.PINNABLES_SEND_IMAGES === "0") return false;
  return cursorRuntime() === "cloud";
}

export function shouldAttachScreenshots(hasDrawings: boolean): boolean {
  if (hasDrawings) return true;
  return sendImagesEnabled();
}

function isCloudAgentId(agentId: string): boolean {
  return agentId.startsWith("bc-");
}

function agentUrl(agentId: string, runtime: AgentRuntime): string | null {
  if (runtime === "cloud" || isCloudAgentId(agentId)) {
    return `https://cursor.com/agents/${agentId}`;
  }
  return null;
}

function authHeader(): string {
  const key = apiKey();
  if (!key) throw new Error("CURSOR_API_KEY is not set");
  return `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
}

async function cursorFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      ...init,
      headers: {
        authorization: authHeader(),
        "content-type": "application/json",
        accept: "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    recordCursorHealth(false, err instanceof Error ? err.message : String(err));
    throw err;
  }
  /* Any answer proves the API is reachable — a 409 busy or a 4xx complaint is
     still Cursor talking. Only a rejected key unreadies the connection. */
  if (res.status === 401 || res.status === 403) {
    recordCursorHealth(false, `Cursor API ${res.status}: check CURSOR_API_KEY`);
  } else {
    recordCursorHealth(true, null);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Cursor API ${res.status} ${path}: ${body.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

function sessionPath(): string {
  return join(pinnablesHome(), "cursor-session.json");
}

export async function readStickyAgentId(): Promise<string | null> {
  const fromEnv = process.env.PINNABLES_CURSOR_AGENT_ID?.trim();
  if (fromEnv) return fromEnv;
  try {
    const raw = await readFile(sessionPath(), "utf8");
    const parsed = JSON.parse(raw) as SessionFile;
    return parsed.agentId?.trim() || null;
  } catch {
    return null;
  }
}

export async function readStickySession(): Promise<SessionFile | null> {
  try {
    const raw = await readFile(sessionPath(), "utf8");
    return JSON.parse(raw) as SessionFile;
  } catch {
    return null;
  }
}

export async function writeStickyAgentId(
  agentId: string,
  runtime: AgentRuntime = cursorRuntime(),
  cwd?: string,
): Promise<void> {
  await mkdir(pinnablesHome(), { recursive: true });
  const payload: SessionFile = {
    agentId,
    runtime,
    ...(cwd ? { cwd } : {}),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(sessionPath(), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/* Generic now that three providers want them, re-exported so this module's
   public surface is unchanged. */
export { imageFromDataUrl, imagesFromScreenshots } from "./images.js";
export { projectDir } from "./env.js";

/** True when Cursor rejected a follow-up because a run is already active. */
export function isAgentBusyError(err: unknown): boolean {
  if (err instanceof AgentBusyError) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /409|agent_busy|already has an active run|active run/i.test(message);
}

function mapCloudRunStatus(status: CursorRunStatus, detail?: string | null): AgentStatus {
  switch (status) {
    case "CREATING":
      return { state: "starting", detail: null };
    case "RUNNING":
      return { state: "working", detail: null };
    case "FINISHED":
      return { state: "done", detail: detail ?? null };
    case "ERROR":
    case "CANCELLED":
    case "EXPIRED":
      return {
        state: "failed",
        detail: detail?.trim() || `Cursor run ended with status ${status}`,
      };
    default:
      return { state: "failed", detail: `Unknown Cursor run status: ${String(status)}` };
  }
}

function mapLocalRunStatus(
  status: Run["status"],
  detail?: string | null,
): AgentStatus {
  switch (status) {
    case "running":
      return { state: "working", detail: null };
    case "finished":
      return { state: "done", detail: detail ?? null };
    case "error":
    case "cancelled":
      return {
        state: "failed",
        detail: detail?.trim() || `Cursor run ended with status ${status}`,
      };
    default:
      return { state: "starting", detail: null };
  }
}

/* ---------------------------------------------------------------- local SDK */

async function obtainLocalAgent(preferredId?: string | null): Promise<{
  agent: SDKAgent;
  mode: "create" | "follow-up";
}> {
  const cwd = projectDir();
  const key = apiKey();
  if (!key) throw new Error("CURSOR_API_KEY is not set");
  const base = {
    apiKey: key,
    model: modelSelection(),
    // Pin Sends name the file. Extra tools (search, shell, subagents, web)
    // are how a 10-second color change becomes a minute of exploration.
    tools: ["read", "edit", "grep", "glob", "readLints"] as ToolName[],
    local: {
      cwd,
      autoReview: false,
      settingSources: [],
    },
  };

  const tryResume = async (agentId: string): Promise<SDKAgent | null> => {
    if (isCloudAgentId(agentId)) return null;
    const cached = localAgents.get(agentId);
    if (cached) return cached;
    try {
      const agent = await Agent.resume(agentId, base);
      localAgents.set(agent.agentId, agent);
      return agent;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/404|not.?found|410|expired|missing/i.test(message)) return null;
      throw err;
    }
  };

  if (preferredId) {
    const resumed = await tryResume(preferredId);
    if (resumed) return { agent: resumed, mode: "follow-up" };
  }

  const agent = await Agent.create({
    ...base,
    name: "Pinnables",
  });
  localAgents.set(agent.agentId, agent);
  return { agent, mode: "create" };
}

async function sendLocal(req: AgentSendRequest): Promise<AgentSendResult> {
  const sticky = req.agentId ?? (await readStickyAgentId());
  const { agent, mode } = await obtainLocalAgent(sticky);
  const cwd = projectDir();

  const run = await agent.send({
    text: req.text,
    ...(req.images?.length ? { images: req.images } : {}),
  });
  localRuns.set(run.id, run);
  /*
   * The object returned by send() is a snapshot. Polling its .status as Done
   * mints a take against the baseline tree (Working, no edits yet) and restore
   * becomes a no-op. wait() is when the run actually finished and the patch
   * has the edits; statusFromCursor reads this map first.
   */
  void run.wait().then(
    () => {
      localRunResults.set(run.id, { state: "done", detail: null });
    },
    (err: unknown) => {
      localRunResults.set(run.id, {
        state: "failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    },
  );
  await writeStickyAgentId(agent.agentId, "local", cwd);
  return {
    agentId: agent.agentId,
    runId: run.id,
    url: null,
    mode,
    runtime: "local",
    cwd,
  };
}

/* --------------------------------------------------------------- cloud REST */

interface CreateAgentResponse {
  agent: { id: string; url?: string; status?: string };
  run: { id: string; agentId: string; status: CursorRunStatus };
}

interface CreateRunResponse {
  id: string;
  agentId: string;
  status: CursorRunStatus;
}

interface GetRunResponse {
  id: string;
  agentId: string;
  status: CursorRunStatus;
  summary?: string | null;
  error?: string | null;
}

interface GetAgentResponse {
  id: string;
  status: string;
  url?: string;
  latestRunId?: string;
}

async function getCloudAgent(agentId: string): Promise<GetAgentResponse> {
  return cursorFetch<GetAgentResponse>(`/v1/agents/${encodeURIComponent(agentId)}`);
}

async function getCloudRun(agentId: string, runId: string): Promise<GetRunResponse> {
  return cursorFetch<GetRunResponse>(
    `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
  );
}

async function createCloudAgent(req: AgentSendRequest): Promise<AgentSendResult> {
  const repoUrl = req.repoUrl ?? process.env.PINNABLES_REPO_URL?.trim();
  const startingRef = req.startingRef ?? process.env.PINNABLES_REPO_REF?.trim();
  const body: Record<string, unknown> = {
    prompt: {
      text: req.text,
      ...(req.images?.length ? { images: req.images } : {}),
    },
    name: req.name ?? "Pinnables",
    autoCreatePR: req.autoCreatePR ?? process.env.PINNABLES_AUTO_CREATE_PR === "1",
    // Prefer the caller's branch when cloud is explicitly requested — still a
    // remote clone, not the local working tree.
    workOnCurrentBranch: process.env.PINNABLES_WORK_ON_CURRENT_BRANCH !== "0",
  };
  if (repoUrl) {
    body.repos = [{ url: repoUrl, ...(startingRef ? { startingRef } : {}) }];
  }

  const res = await cursorFetch<CreateAgentResponse>("/v1/agents", {
    method: "POST",
    body: JSON.stringify(body),
  });
  await writeStickyAgentId(res.agent.id, "cloud");
  return {
    agentId: res.agent.id,
    runId: res.run.id,
    url: res.agent.url ?? agentUrl(res.agent.id, "cloud"),
    mode: "create",
    runtime: "cloud",
  };
}

async function createCloudFollowUp(
  agentId: string,
  req: Pick<AgentSendRequest, "text" | "images">,
): Promise<AgentSendResult> {
  const res = await cursorFetch<CreateRunResponse>(
    `/v1/agents/${encodeURIComponent(agentId)}/runs`,
    {
      method: "POST",
      body: JSON.stringify({
        prompt: {
          text: req.text,
          ...(req.images?.length ? { images: req.images } : {}),
        },
      }),
    },
  );
  await writeStickyAgentId(agentId, "cloud");
  return {
    agentId,
    runId: res.id,
    url: agentUrl(agentId, "cloud"),
    mode: "follow-up",
    runtime: "cloud",
  };
}

async function sendCloud(req: AgentSendRequest): Promise<AgentSendResult> {
  const sticky = req.agentId ?? (await readStickyAgentId());
  if (sticky && isCloudAgentId(sticky)) {
    try {
      const agent = await getCloudAgent(sticky);
      if (agent.status === "ACTIVE") {
        return await createCloudFollowUp(sticky, req);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/404|not.?found|410/i.test(message)) {
        if (/409|busy|401|403/i.test(message)) throw err;
      }
    }
  }
  return createCloudAgent(req);
}

/**
 * Prefer follow-up on a sticky agent; otherwise create a new one.
 * Local runtime edits `PINNABLES_PROJECT_DIR` / cwd on this machine.
 */
export async function sendToCursor(req: AgentSendRequest): Promise<AgentSendResult> {
  if (!cursorConfigured()) {
    throw new Error(
      "CURSOR_API_KEY is not set. Add it once (Cursor Dashboard → API Keys) and restart the service.",
    );
  }

  const runtime = cursorRuntime();
  try {
    const result = runtime === "local" ? await sendLocal(req) : await sendCloud(req);
    recordCursorHealth(true, null);
    return result;
  } catch (err) {
    /*
     * Cloud failures were already recorded at the fetch layer with the right
     * verdict (a 409 busy is still connectivity). Local runs never touch
     * cursorFetch, so their failures are recorded here — except busy, which
     * proves the agent is alive.
     */
    if (runtime === "local" && !(err instanceof AgentBusyError)) {
      recordCursorHealth(false, err instanceof Error ? err.message : String(err));
    }
    throw err;
  }
}

export async function statusFromCursor(agentId: string, runId: string): Promise<AgentStatus> {
  // Runtime is encoded in the agent id prefix (`bc-` = cloud).
  if (isCloudAgentId(agentId)) {
    const run = await getCloudRun(agentId, runId);
    const mapped = mapCloudRunStatus(run.status, run.error ?? run.summary ?? null);
    return {
      ...mapped,
      agentId,
      runId,
      url: agentUrl(agentId, "cloud"),
    };
  }

  const settled = localRunResults.get(runId);
  if (settled) {
    localRuns.delete(runId);
    return { ...settled, agentId, runId, url: null };
  }

  try {
    /*
     * Always re-fetch. The send() handle's status is what it was at
     * agent.send() — treating that as finished mints take 2 while the
     * composer still says Working, and 1 and 2 are the same tree.
     */
    let run: Run | undefined;
    try {
      run = await Agent.getRun(runId, {
        runtime: "local",
        cwd: projectDir(),
      });
      localRuns.set(runId, run);
    } catch {
      run = localRuns.get(runId);
    }
    if (!run) {
      return { state: "failed", detail: "Unknown local run", agentId, runId, url: null };
    }
    const detail = run.error?.message ?? null;
    const mapped = mapLocalRunStatus(run.status, detail);
    /*
     * Fresh getRun may still say "finished" before wait() has flushed the
     * edits. Keep reporting working until wait() settles so the snapshot
     * (and the take key) contain the real patch.
     */
    if (mapped.state === "done") {
      return { state: "working", detail: null, agentId, runId, url: null };
    }
    if (mapped.state === "failed") {
      localRuns.delete(runId);
    }
    return { ...mapped, agentId, runId, url: null };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { state: "failed", detail, agentId, runId, url: null };
  }
}

/** Probe auth without starting work — used by /health. */
/*
 * Last-known Cursor connectivity, recorded from real traffic.
 *
 * /health used to probe the API on every poll. With the panel open that was a
 * network round trip every few seconds, and one stalled probe held every
 * health answer behind it, freezing the whole extension's view of the
 * service. Now the API is only touched by work the user asked for, and health
 * reports what that work last learned.
 */
let lastCursorHealth: { ok: boolean; detail: string | null } | null = null;

function recordCursorHealth(ok: boolean, detail: string | null): void {
  lastCursorHealth = { ok, detail };
}

/** What /health reports, without touching the network. */
export function cursorStatusSnapshot(): AgentHealth {
  const runtime = cursorRuntime();
  const cwd = projectDir();
  if (!cursorConfigured()) {
    return { ok: false, detail: "CURSOR_API_KEY not set", runtime, cwd };
  }
  return {
    ok: lastCursorHealth?.ok ?? false,
    detail: lastCursorHealth ? lastCursorHealth.detail : "waiting for the first send",
    runtime,
    cwd,
  };
}

export const cursorProvider: AgentProvider = {
  kind: "cursor",
  label: "Cursor",
  configured: cursorConfigured,
  runtime: cursorRuntime,
  model: cursorModel,
  send: sendToCursor,
  status: statusFromCursor,
  isBusyError: isAgentBusyError,
  wantsImages: shouldAttachScreenshots,
  healthSnapshot: cursorStatusSnapshot,
  readStickyAgentId,
  setupHint: () => "Set CURSOR_API_KEY on the local service, then restart it.",
  /* Cursor is reached over its API, so there is no CLI to go missing and no
     path variable to point at one. What can go missing is the SDK and its
     platform binary, so the package is named the way the other two name their
     path variables: the concrete thing you act on, not "dependencies". */
  installHint: () =>
    "Install @cursor/sdk with npm install, then restart the local service.",
  agentUrl: (agentId: string) => agentUrl(agentId, cursorRuntime()),
};
