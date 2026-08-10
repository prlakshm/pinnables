import type { Board } from "@pinnables/shared";

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

export interface PushBoardResult {
  messageId: string;
  boardDir: string;
  agentId?: string;
  runId?: string;
  url?: string;
  pointer: string;
  transport: "cursor" | "clipboard";
}

export interface HealthResult {
  ok: boolean;
  home: string;
  cursor?: {
    configured: boolean;
    ok: boolean;
    detail: string | null;
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

export interface AgentMessageStatus {
  state: "working" | "done" | "failed";
  detail: string | null;
  transport?: "cursor" | "local";
  agentId?: string;
  runId?: string;
  url?: string;
}

/**
 * One live message → one agent run (Cursor Cloud Agents when configured,
 * otherwise a local CLI spawn). Screenshots ride as data URLs.
 */
export async function sendAgentMessage(payload: {
  text: string;
  board: Board;
  pinIds: string[];
  relationshipId?: string;
  drawingSummary?: string;
  screenshots: Record<string, string>;
}): Promise<{ messageId: string; transport?: string | null; url?: string | null }> {
  return request<{ messageId: string; transport?: string | null; url?: string | null }>(
    "/messages",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

export async function agentMessageStatus(messageId: string): Promise<AgentMessageStatus> {
  return request<AgentMessageStatus>(`/messages/${encodeURIComponent(messageId)}`);
}
