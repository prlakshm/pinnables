/**
 * Cursor Cloud Agents bridge.
 *
 * This is the transport that makes "Send" actually send — no clipboard, no
 * paste, no "Load Pinnables board …" prompt. The local service materializes
 * pin context into a prompt (+ screenshots as images) and calls Cursor's
 * Cloud Agents API to create an agent or follow up on a sticky one.
 *
 * Auth: CURSOR_API_KEY (Dashboard → API Keys). Optional sticky session:
 * PINNABLES_CURSOR_AGENT_ID, or the last agent id we wrote under
 * ~/.pinnables/cursor-session.json.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pinnablesHome } from "@pinnables/shared/storage";

function apiBase(): string {
  return (process.env.CURSOR_API_BASE ?? "https://api.cursor.com").replace(/\/$/, "");
}

const MAX_IMAGES = 5;

export type CursorRunStatus = "CREATING" | "RUNNING" | "FINISHED" | "ERROR" | "CANCELLED" | "EXPIRED";

export interface CursorImage {
  data: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

export interface CursorSendRequest {
  text: string;
  images?: CursorImage[];
  name?: string;
  /** Prefer follow-up on this agent when set and still ACTIVE. */
  agentId?: string;
  repoUrl?: string;
  startingRef?: string;
  autoCreatePR?: boolean;
}

export interface CursorSendResult {
  agentId: string;
  runId: string;
  url: string;
  mode: "create" | "follow-up";
}

export interface CursorStatus {
  state: "working" | "done" | "failed";
  detail: string | null;
  agentId?: string;
  runId?: string;
  url?: string;
}

interface SessionFile {
  agentId: string;
  updatedAt: string;
}

function apiKey(): string | null {
  const key = process.env.CURSOR_API_KEY?.trim();
  return key || null;
}

export function cursorConfigured(): boolean {
  return Boolean(apiKey());
}

function authHeader(): string {
  const key = apiKey();
  if (!key) throw new Error("CURSOR_API_KEY is not set");
  // Basic auth with empty password is the documented form (`-u KEY:`).
  return `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
}

async function cursorFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      authorization: authHeader(),
      "content-type": "application/json",
      accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
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

export async function writeStickyAgentId(agentId: string): Promise<void> {
  await mkdir(pinnablesHome(), { recursive: true });
  const payload: SessionFile = { agentId, updatedAt: new Date().toISOString() };
  await writeFile(sessionPath(), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/** Strip data-URL prefix; Cursor wants raw base64 in `data`. */
export function imageFromDataUrl(dataUrl: string): CursorImage | null {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/s.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1] as CursorImage["mimeType"], data: match[2] };
}

export function imagesFromScreenshots(
  screenshots: Record<string, string>,
  pinIds: string[],
): CursorImage[] {
  const out: CursorImage[] = [];
  for (const pinId of pinIds) {
    if (out.length >= MAX_IMAGES) break;
    const url = screenshots[pinId];
    if (!url) continue;
    const image = imageFromDataUrl(url);
    if (image) out.push(image);
  }
  return out;
}

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

function mapRunStatus(status: CursorRunStatus, detail?: string | null): CursorStatus {
  switch (status) {
    case "CREATING":
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

export async function getAgent(agentId: string): Promise<GetAgentResponse> {
  return cursorFetch<GetAgentResponse>(`/v1/agents/${encodeURIComponent(agentId)}`);
}

export async function getRun(agentId: string, runId: string): Promise<GetRunResponse> {
  return cursorFetch<GetRunResponse>(
    `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
  );
}

export async function createAgent(req: CursorSendRequest): Promise<CursorSendResult> {
  const repoUrl = req.repoUrl ?? process.env.PINNABLES_REPO_URL?.trim();
  const startingRef = req.startingRef ?? process.env.PINNABLES_REPO_REF?.trim();
  const body: Record<string, unknown> = {
    prompt: {
      text: req.text,
      ...(req.images?.length ? { images: req.images } : {}),
    },
    name: req.name ?? "Pinnables",
    autoCreatePR: req.autoCreatePR ?? process.env.PINNABLES_AUTO_CREATE_PR === "1",
  };
  if (repoUrl) {
    body.repos = [{ url: repoUrl, ...(startingRef ? { startingRef } : {}) }];
  }

  const res = await cursorFetch<CreateAgentResponse>("/v1/agents", {
    method: "POST",
    body: JSON.stringify(body),
  });
  await writeStickyAgentId(res.agent.id);
  return {
    agentId: res.agent.id,
    runId: res.run.id,
    url: res.agent.url ?? `https://cursor.com/agents/${res.agent.id}`,
    mode: "create",
  };
}

export async function createFollowUp(
  agentId: string,
  req: Pick<CursorSendRequest, "text" | "images">,
): Promise<CursorSendResult> {
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
  await writeStickyAgentId(agentId);
  return {
    agentId,
    runId: res.id,
    url: `https://cursor.com/agents/${agentId}`,
    mode: "follow-up",
  };
}

/**
 * Prefer follow-up on a sticky ACTIVE agent; otherwise create a new one.
 * A 409 agent_busy surfaces as a failed send so the extension can retry.
 */
export async function sendToCursor(req: CursorSendRequest): Promise<CursorSendResult> {
  if (!cursorConfigured()) {
    throw new Error(
      "CURSOR_API_KEY is not set. Add it once (Cursor Dashboard → API Keys) and restart the service.",
    );
  }

  const sticky = req.agentId ?? (await readStickyAgentId());
  if (sticky) {
    try {
      const agent = await getAgent(sticky);
      if (agent.status === "ACTIVE") {
        return await createFollowUp(sticky, req);
      }
    } catch (err) {
      // Stale sticky id — fall through to create.
      const message = err instanceof Error ? err.message : String(err);
      if (!/404|not.?found|410/i.test(message)) {
        // Busy or auth errors should not silently create a duplicate agent.
        if (/409|busy|401|403/i.test(message)) throw err;
      }
    }
  }

  return createAgent(req);
}

export async function statusFromCursor(agentId: string, runId: string): Promise<CursorStatus> {
  const run = await getRun(agentId, runId);
  const mapped = mapRunStatus(run.status, run.error ?? run.summary ?? null);
  return {
    ...mapped,
    agentId,
    runId,
    url: `https://cursor.com/agents/${agentId}`,
  };
}

/** Probe auth without starting work — used by /health. */
export async function probeCursor(): Promise<{ ok: boolean; detail: string | null }> {
  if (!cursorConfigured()) {
    return { ok: false, detail: "CURSOR_API_KEY not set" };
  }
  try {
    await cursorFetch<{ items?: unknown[] }>("/v1/agents?limit=1");
    return { ok: true, detail: null };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
