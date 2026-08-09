import type { Board } from "@pinnables/shared";

/**
 * Client for the local companion service. The extension cannot write to
 * arbitrary filesystem paths, so the service is what turns a board into files
 * an agent can read — and it is the same process that serves MCP.
 *
 * Everything degrades: if the service is down, boards still live in
 * chrome.storage and the user keeps working. Only the agent handoff needs it.
 */

const BASE = "http://127.0.0.1:4573";

export interface MaterializeResult {
  pointer: string;
  boardDir: string;
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

export interface AgentMessageStatus {
  state: "working" | "done" | "failed";
  detail: string | null;
}

/**
 * One live message → one headless agent run, spawned by the service. The whole
 * board travels so the service can render full pin context without a second
 * round trip; screenshots ride as data URLs like materialize.
 */
export async function sendAgentMessage(payload: {
  text: string;
  board: Board;
  pinIds: string[];
  relationshipId?: string;
  drawingSummary?: string;
  screenshots: Record<string, string>;
}): Promise<{ messageId: string }> {
  return request<{ messageId: string }>("/messages", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function agentMessageStatus(messageId: string): Promise<AgentMessageStatus> {
  return request<AgentMessageStatus>(`/messages/${encodeURIComponent(messageId)}`);
}
