/**
 * Which agent Send talks to.
 *
 * Cursor is the default when CURSOR_API_KEY is set. Claude Code and Codex
 * are first-class too: PINNABLES_AGENT=claude|codex, or the matching API
 * key (ANTHROPIC_API_KEY / CODEX_API_KEY / OPENAI_API_KEY). A custom
 * PINNABLES_AGENT_CMD always wins and is run through the shell with
 * PINNABLES_PROMPT and PINNABLES_MESSAGE set.
 */

export type AgentBackend = "cursor" | "claude" | "codex" | "custom";

export function agentBackend(): AgentBackend {
  if (process.env.PINNABLES_AGENT_CMD?.trim()) return "custom";
  const forced = (process.env.PINNABLES_AGENT ?? "").trim().toLowerCase();
  if (forced === "claude" || forced === "codex" || forced === "cursor") return forced;
  if (process.env.CURSOR_API_KEY?.trim()) return "cursor";
  if (process.env.CODEX_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim()) return "codex";
  return "claude";
}

export function usesCursorSend(): boolean {
  return agentBackend() === "cursor" && Boolean(process.env.CURSOR_API_KEY?.trim());
}

export interface LocalSpawnSpec {
  command: string;
  args: string[];
  shell: boolean;
  label: AgentBackend;
}

/**
 * How to start a local CLI agent. Cursor's SDK path is separate; this is
 * Claude, Codex, or PINNABLES_AGENT_CMD.
 */
export function localSpawnSpec(prompt: string, messagePath: string): LocalSpawnSpec {
  const custom = process.env.PINNABLES_AGENT_CMD?.trim();
  if (custom) {
    return { command: custom, args: [], shell: true, label: "custom" };
  }
  if (agentBackend() === "codex") {
    return {
      command: "codex",
      args: ["exec", "--sandbox", "workspace-write", prompt],
      shell: false,
      label: "codex",
    };
  }
  return {
    command: "claude",
    args: ["-p", prompt, "--permission-mode", "acceptEdits"],
    shell: false,
    label: "claude",
  };
}

export function localSpawnEnv(
  prompt: string,
  messagePath: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PINNABLES_PROMPT: prompt,
    PINNABLES_MESSAGE: messagePath,
  };
  /* Codex CLI typically reads OPENAI_API_KEY; accept CODEX_API_KEY as well. */
  if (!env.OPENAI_API_KEY?.trim() && env.CODEX_API_KEY?.trim()) {
    env.OPENAI_API_KEY = env.CODEX_API_KEY;
  }
  return env;
}
