import assert from "node:assert/strict";
import test from "node:test";

import {
  agentBackend,
  localSpawnEnv,
  localSpawnSpec,
  usesCursorSend,
} from "../packages/service/src/agents.ts";

const KEYS = [
  "PINNABLES_AGENT_CMD",
  "PINNABLES_AGENT",
  "CURSOR_API_KEY",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
] as const;

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const key of KEYS) prev[key] = process.env[key];
  for (const key of KEYS) {
    const next = vars[key];
    if (next === undefined || next === "") delete process.env[key];
    else process.env[key] = next;
  }
  try {
    fn();
  } finally {
    for (const key of KEYS) {
      const value = prev[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("PINNABLES_AGENT_CMD wins over keys and PINNABLES_AGENT", () => {
  withEnv(
    {
      PINNABLES_AGENT_CMD: "my-agent --do-it",
      PINNABLES_AGENT: "cursor",
      CURSOR_API_KEY: "crsr_x",
      CODEX_API_KEY: "sk-x",
    },
    () => {
      assert.equal(agentBackend(), "custom");
      assert.equal(usesCursorSend(), false);
      const spec = localSpawnSpec("prompt", "/tmp/message.md");
      assert.equal(spec.command, "my-agent --do-it");
      assert.equal(spec.shell, true);
      assert.equal(spec.label, "custom");
    },
  );
});

test("PINNABLES_AGENT forces claude or codex even when a Cursor key is set", () => {
  withEnv(
    { PINNABLES_AGENT: "claude", CURSOR_API_KEY: "crsr_x", CODEX_API_KEY: "sk-x" },
    () => {
      assert.equal(agentBackend(), "claude");
      assert.equal(usesCursorSend(), false);
      const spec = localSpawnSpec("do the pin", "/tmp/m.md");
      assert.equal(spec.command, "claude");
      assert.deepEqual(spec.args, ["-p", "do the pin", "--permission-mode", "acceptEdits"]);
      assert.equal(spec.shell, false);
    },
  );
  withEnv(
    { PINNABLES_AGENT: "codex", CURSOR_API_KEY: "crsr_x" },
    () => {
      assert.equal(agentBackend(), "codex");
      const spec = localSpawnSpec("do the pin", "/tmp/m.md");
      assert.equal(spec.command, "codex");
      assert.deepEqual(spec.args, ["exec", "--sandbox", "workspace-write", "do the pin"]);
    },
  );
});

test("API keys pick Cursor, then Codex, then Claude", () => {
  withEnv({ CURSOR_API_KEY: "crsr_x", CODEX_API_KEY: "sk-x", ANTHROPIC_API_KEY: "sk-ant" }, () => {
    assert.equal(agentBackend(), "cursor");
    assert.equal(usesCursorSend(), true);
  });
  withEnv({ CURSOR_API_KEY: "", CODEX_API_KEY: "sk-x" }, () => {
    assert.equal(agentBackend(), "codex");
    assert.equal(usesCursorSend(), false);
  });
  withEnv({ CURSOR_API_KEY: "", CODEX_API_KEY: "", OPENAI_API_KEY: "sk-openai" }, () => {
    assert.equal(agentBackend(), "codex");
  });
  withEnv(
    {
      CURSOR_API_KEY: "",
      CODEX_API_KEY: "",
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "sk-ant",
    },
    () => {
      assert.equal(agentBackend(), "claude");
    },
  );
});

test("localSpawnEnv copies CODEX_API_KEY into OPENAI_API_KEY for the Codex CLI", () => {
  withEnv({ CODEX_API_KEY: "codex-secret", OPENAI_API_KEY: "" }, () => {
    const env = localSpawnEnv("prompt", "/tmp/m.md");
    assert.equal(env.PINNABLES_PROMPT, "prompt");
    assert.equal(env.PINNABLES_MESSAGE, "/tmp/m.md");
    assert.equal(env.OPENAI_API_KEY, "codex-secret");
  });
});
