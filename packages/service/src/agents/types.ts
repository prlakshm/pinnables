/**
 * The shape every coding agent has to fit to receive a Pinnables Send.
 *
 * A Send is always the same errand: one named source file, one focused change,
 * on a repo that is running in front of the designer. What differs between
 * Cursor, Claude Code, and Codex is only how that errand is dispatched and how
 * you ask whether it finished — so that, and nothing else, is what a provider
 * implements. The queue, the version snapshots, and the whole /messages
 * lifecycle in index.ts are provider-agnostic and stay there.
 */

/** Selected once at startup from PINNABLES_AGENT. */
export type AgentKind = "cursor" | "claude" | "codex";

/**
 * Where the agent does the work. Only Cursor has a remote option; the other
 * two always edit the tree on this machine, which is the point of them.
 */
export type AgentRuntime = "local" | "cloud";

export type AgentState = "starting" | "working" | "done" | "failed";

/**
 * A pin screenshot, carried both ways because providers want opposite things.
 * Cursor's API takes bytes over the wire; the local agents already have the
 * file on disk and would rather be told where it is than be handed a megabyte
 * of base64 they have to re-encode. `path` is absent only when the artifacts
 * were never materialized.
 */
export interface AgentImage {
  /** Raw base64, no `data:` prefix. */
  data: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  /** Absolute path under ~/.pinnables/live/<messageId>/, when written. */
  path?: string;
}

export interface AgentSendRequest {
  text: string;
  images?: AgentImage[];
  /** Human-readable run name, where the provider surfaces one. */
  name?: string;
  /** Prefer a follow-up on this session when it is still usable. */
  agentId?: string;
  /* Cloud-only, ignored by the local providers. */
  repoUrl?: string;
  startingRef?: string;
  autoCreatePR?: boolean;
}

export interface AgentSendResult {
  /** The sticky conversation id: Cursor agent, Claude session, Codex thread. */
  agentId: string;
  runId: string;
  /** A page a human can open, when the provider has one. Local agents do not. */
  url: string | null;
  mode: "create" | "follow-up";
  runtime: AgentRuntime;
  cwd?: string;
}

export interface AgentStatus {
  state: AgentState;
  detail: string | null;
  agentId?: string;
  runId?: string;
  url?: string | null;
}

/** What /health reports without touching the network. */
export interface AgentHealth {
  ok: boolean;
  detail: string | null;
  runtime: AgentRuntime;
  cwd: string;
}

export interface AgentProvider {
  readonly kind: AgentKind;
  /** Shown in service logs. The panel's copy still says Cursor for now. */
  readonly label: string;

  /** Whether a Send can be dispatched at all: key present, CLI resolvable. */
  configured(): boolean;
  runtime(): AgentRuntime;
  /** The resolved model, or null when the provider is left on its own default. */
  model(): string | null;

  send(req: AgentSendRequest): Promise<AgentSendResult>;
  status(agentId: string, runId: string): Promise<AgentStatus>;

  /**
   * True when the provider refused because a run is already in flight. The
   * queue in index.ts treats this as "put it back and wait", never as failure.
   */
  isBusyError(err: unknown): boolean;

  /**
   * Whether to attach pin screenshots at all. Expensive for the providers that
   * pay per image, free for the ones reading a local file — but a pen mark is
   * unreadable without one, so `hasDrawings` overrides the default either way.
   */
  wantsImages(hasDrawings: boolean): boolean;

  healthSnapshot(): AgentHealth;
  readStickyAgentId(): Promise<string | null>;

  /**
   * What to tell the user when a Send cannot get through and the error itself
   * is not self-explanatory. It lives here because the answer is different for
   * every provider — a key for one, a CLI login for another — and the panel
   * should never have to know which agent it is talking to in order to say
   * something useful.
   */
  setupHint(): string;

  /**
   * What to tell the user when the agent cannot be found on this machine at
   * all. Names the variable that overrides the lookup, because "set its path"
   * is not something anyone can act on without knowing which path.
   */
  installHint(): string;

  /**
   * A page where a human can watch the run, for the providers that host one.
   * Only Cursor's cloud runtime does; a local agent's work is visible in the
   * working tree instead, which is the whole point of it.
   */
  agentUrl?(agentId: string): string | null;
}
