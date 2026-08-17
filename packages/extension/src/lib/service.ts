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
  /**
   * Which agent the service is actually driving, and what to tell the user
   * when it will not take a Send. Absent on services older than multi-agent
   * support, which is why every read of it falls back to Cursor.
   */
  agent?: {
    kind?: "cursor" | "claude" | "codex";
    label?: string;
    model?: string | null;
    setupHint?: string;
    installHint?: string;
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    /*
     * The service answers failures with { error }. Surfacing that verbatim is
     * the difference between "check your Cursor key" and "your login expired",
     * so it is unwrapped here rather than thrown as a JSON blob nobody reads.
     */
    const body = await res.text();
    let detail = body;
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error.trim()) detail = parsed.error.trim();
    } catch {
      /* Not JSON. The raw body is still better than nothing. */
    }
    throw new Error(detail || `Local service ${res.status}`);
  }
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
  | "agentLabel"
  | "agentSetupHint"
  | "agentInstallHint"
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
    /* An older service says nothing about which agent it drives, and an older
       service could only ever drive one. Cursor is the honest assumption. */
    agentLabel: health?.agent?.label ?? DEFAULT_AGENT_LABEL,
    agentSetupHint: health?.agent?.setupHint ?? null,
    agentInstallHint: health?.agent?.installHint ?? null,
  };
}

const DEFAULT_AGENT_LABEL = "Cursor";

/**
 * Why a Send did not get through, in the few shapes worth telling apart.
 *
 * Deliberately coarse. Each one has to earn a distinct sentence a designer can
 * act on, and a class nobody can act on differently is just noise.
 */
export type SendFailure =
  | "offline"
  | "signed-out"
  | "missing-agent"
  | "busy"
  | "rate-limited"
  | "timeout"
  | "project"
  | "unknown";

/**
 * Sort a raw failure into one of those shapes.
 *
 * The patterns read agent SDK and HTTP wording, which we do not control and
 * which changes between releases. That is survivable because an unmatched
 * error falls through to "unknown", whose copy is still ours and still tells
 * the user where to look. Nothing here reaches the screen; only the class does.
 */
export function classifySendFailure(err: unknown): SendFailure {
  const raw = (err instanceof Error ? err.message : typeof err === "string" ? err : "")
    .toLowerCase();
  if (!raw) return "unknown";
  if (/failed to fetch|econnrefused|network error|service is offline/.test(raw)) return "offline";
  if (/binary not found|not found at|enoent|command not found|is not installed|no such file/.test(raw))
    return "missing-agent";
  if (/auth|oauth|unauthor|forbidden|401|403|credential|api key|token|expired|log ?in/.test(raw))
    return "signed-out";
  if (/429|rate.?limit|quota|too many requests/.test(raw)) return "rate-limited";
  if (/409|busy|active run|already running|already in progress/.test(raw)) return "busy";
  if (/timeout|timed out|etimedout|deadline/.test(raw)) return "timeout";
  if (/project_dir|not a git|no such directory|working directory/.test(raw)) return "project";
  return "unknown";
}

/** How loudly to say it. Maps to the three banner weights the panel has. */
export type SendSeverity = "note" | "warn" | "error";

export interface SendFailureNotice {
  message: string;
  severity: SendSeverity;
}

/**
 * The weight a failure earns.
 *
 * The split is not "did the send go through" — none of these went through. It
 * is whether anything is actually wrong. A missing login is a step the user
 * has not taken yet, and colouring that like a crash tells them they broke
 * something when they simply have not finished setting up. Waiting on a busy
 * agent is not even a step; it is the system working. Red is left for the case
 * where they did everything right and it failed anyway, which is the only
 * reading under which red still means anything by the time it appears.
 */
export function severityForFailure(kind: SendFailure): SendSeverity {
  switch (kind) {
    case "busy":
    case "rate-limited":
      return "note";
    case "offline":
    case "signed-out":
    case "missing-agent":
    case "project":
      return "warn";
    default:
      return "error";
  }
}

/**
 * What the user reads when a Send does not go through, and how loudly.
 *
 * Returns null when a standing banner is already saying this. The panel shows
 * service-offline and agent-not-set-up persistently, so repeating either in an
 * alert is the same sentence twice in two boxes.
 *
 * Every string is ours. Agent SDKs write for the developer holding the stack
 * trace, so the raw text is classified and then discarded; the class picks a
 * sentence that says what is true and what to do. The provider's own hint
 * carries the fix where it differs per agent, which is what keeps this correct
 * for an agent the panel has never heard of.
 */
export function describeSendFailure(
  err: unknown,
  opts: {
    serviceOnline: boolean;
    configured: boolean;
    label?: string | null;
    hint?: string | null;
    installHint?: string | null;
  },
): SendFailureNotice | null {
  if (!opts.serviceOnline || !opts.configured) return null;

  const label = opts.label?.trim() || DEFAULT_AGENT_LABEL;
  const hint = opts.hint?.trim();
  const installHint = opts.installHint?.trim();
  const kind = classifySendFailure(err);

  /* "yet" is load-bearing on the setup cases: it is the difference between
     naming a step not taken and accusing someone of breaking something. */
  const message = ((): string => {
    switch (kind) {
      case "offline":
        return "The local service isn’t running yet. Start it with npm run dev:service.";
      case "signed-out":
        return `${label} isn’t signed in yet. ${hint ?? "Sign in on the local service, then try again."}`;
      case "missing-agent":
        return `${label} isn’t installed yet. ${installHint ?? "Install it, then restart the local service."}`;
      case "busy":
        /* The queue is already holding this send, so asking them to try again
           would be asking for work the service is doing for them. */
        return `${label} is still working on your last send. It’ll go as soon as that finishes.`;
      case "rate-limited":
        return `${label} is rate limited right now. Wait a minute, then try again.`;
      case "timeout":
        return `${label} didn’t answer in time. Try again, and check the service log if it keeps happening.`;
      case "project":
        return "The project folder isn’t set yet. Point PINNABLES_PROJECT_DIR at the app repo, then restart the service.";
      default:
        return `Couldn’t send to ${label}. Check the service log for what went wrong, then try again.`;
    }
  })();

  return { message, severity: severityForFailure(kind) };
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
