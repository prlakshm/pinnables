import type { Board } from "@pinnables/shared";
import type { ExtensionState } from "./messages";

/**
 * Client for the local companion service. The extension cannot write to
 * arbitrary filesystem paths, so the service is what turns a board into files
 * an agent can read — and it is the same process that serves MCP.
 *
 * Everything degrades: if the service is down, boards still live in
 * chrome.storage and the user keeps working. Only the agent handoff needs it.
 *
 * When CURSOR_API_KEY is configured on the service, Send / Ready push through
 * Cursor's Cloud Agents API — no clipboard paste.
 */

const BASE = "http://127.0.0.1:4573";

export interface MaterializeResult {
  pointer: string;
  boardDir: string;
}

export interface AgentMessageStatus {
  state: "queued" | "starting" | "working" | "done" | "failed";
  detail: string | null;
  transport?: "cursor" | "local";
  agentId?: string;
  runId?: string;
  url?: string;
}

export interface PushBoardResult {
  messageId: string;
  boardDir: string;
  agentId?: string;
  runId?: string;
  url?: string;
  pointer: string;
  transport: "cursor" | "clipboard";
  state?: AgentMessageStatus["state"];
}

export interface HealthResult {
  ok: boolean;
  home: string;
  /** Whether the service can take and restore version snapshots — it needs a
      git working tree. Absent on services older than version keys. `head` is
      the chapter: the commit the tree stands on, which everything a
      conversation produces is stamped with. */
  versions?: { ok: boolean; detail: string | null; head?: string | null };
  cursor?: {
    configured: boolean;
    ok: boolean;
    detail: string | null;
    runtime?: "local" | "cloud";
    cwd?: string;
    agentId?: string | null;
    agentUrl?: string | null;
    queueLength?: number;
  };
  agent?: {
    backend?: "cursor" | "claude" | "codex" | "custom";
    queueLength?: number;
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Local service ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export async function isServiceOnline(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 900);
    const res = await fetch(`${BASE}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

export async function getHealth(): Promise<HealthResult | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 900);
    const res = await fetch(`${BASE}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as HealthResult;
  } catch {
    return null;
  }
}

/** Map a /health payload onto the live fields the panel and worker share. */
export function liveFieldsFromHealth(health: HealthResult | null): Pick<
  ExtensionState,
  | "serviceOnline"
  | "versionsOk"
  | "projectHead"
  | "cursorConfigured"
  | "cursorOnline"
  | "cursorAgentUrl"
  | "cursorRuntime"
  | "cursorProjectDir"
> {
  return {
    serviceOnline: Boolean(health?.ok),
    versionsOk: Boolean(health?.versions?.ok),
    projectHead: health?.versions?.head ?? null,
    cursorConfigured: Boolean(health?.cursor?.configured),
    cursorOnline: Boolean(health?.cursor?.configured && health.cursor.ok),
    cursorAgentUrl: health?.cursor?.agentUrl ?? null,
    cursorRuntime: health?.cursor?.runtime ?? null,
    cursorProjectDir: health?.cursor?.cwd ?? null,
  };
}

/**
 * Push the board and its screenshots to disk. Screenshots travel as data URLs
 * because the extension has no other way to hand over binary — the service
 * decodes and writes them as PNGs next to board.json.
 */
export async function materializeBoard(
  board: Board,
  screenshots: Record<string, string>,
): Promise<MaterializeResult> {
  return request<MaterializeResult>(`/boards/${encodeURIComponent(board.id)}/materialize`, {
    method: "POST",
    body: JSON.stringify({ board, screenshots }),
  });
}

/**
 * Materialize + send to Cursor when configured; otherwise materialize only and
 * return a clipboard pointer (legacy path).
 */
export async function pushBoard(
  board: Board,
  screenshots: Record<string, string>,
): Promise<PushBoardResult> {
  return request<PushBoardResult>(`/boards/${encodeURIComponent(board.id)}/push`, {
    method: "POST",
    body: JSON.stringify({ board, screenshots }),
  });
}

/**
 * One live message → one agent run (Cursor Cloud Agents when configured,
 * otherwise a local CLI spawn). Screenshots ride as data URLs. When Cursor
 * already has an active run, the service queues and returns state "queued".
 */
export async function sendAgentMessage(payload: {
  text: string;
  board: Board;
  pinIds: string[];
  relationshipId?: string;
  drawingSummary?: string;
  screenshots: Record<string, string>;
}): Promise<{
  messageId: string;
  transport?: string | null;
  url?: string | null;
  state?: AgentMessageStatus["state"] | null;
}> {
  return request<{
    messageId: string;
    transport?: string | null;
    url?: string | null;
    state?: AgentMessageStatus["state"] | null;
  }>("/messages", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function agentMessageStatus(messageId: string): Promise<AgentMessageStatus> {
  return request<AgentMessageStatus>(`/messages/${encodeURIComponent(messageId)}`);
}

export async function abandonInFlight(): Promise<{ ok: boolean; abandoned: number }> {
  return request<{ ok: boolean; abandoned: number }>("/messages/abandon", { method: "POST" });
}

/**
 * Put the working tree into the state a version recorded. `fromMessageId`
 * names the snapshot currently applied so its hunks can be reversed first;
 * conflicts are files where a later hand edit overlapped the run's own code
 * and the version won.
 */
export async function restoreVersion(payload: {
  boardId: string;
  messageId: string;
  fromMessageId: string | null;
}): Promise<{ ok: boolean; conflicts: string[]; files: string[] }> {
  return request<{ ok: boolean; conflicts: string[]; files: string[] }>(
    `/versions/${encodeURIComponent(payload.messageId)}/restore`,
    {
      method: "POST",
      body: JSON.stringify({ boardId: payload.boardId, fromMessageId: payload.fromMessageId }),
    },
  );
}
