import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import {
  classifySendFailure,
  describeSendFailure,
  severityForFailure,
  liveFieldsFromHealth,
} from "../packages/extension/src/lib/service.ts";
import {
  resetVersionsHealthCache,
  versionsHealthSnapshot,
} from "../packages/service/src/versions.ts";

const mkdtempAsync = promisify(mkdtemp);
const root = new URL("../", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

async function waitForService(child: ChildProcess, ms = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const onData = (buf: Buffer) => {
      if (buf.toString().includes("pinnables service on")) {
        clearTimeout(timer);
        resolve(true);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
  });
}

test("liveFieldsFromHealth treats a configured key as ready even when the probe is not ok", () => {
  const fields = liveFieldsFromHealth({
    ok: true,
    home: "/tmp",
    versions: { ok: true, detail: null, head: "abc" },
    cursor: {
      configured: true,
      ok: false,
      detail: "probe not yet run",
      runtime: "local",
      cwd: "/tmp/app",
    },
  });
  assert.equal(fields.serviceOnline, true);
  assert.equal(fields.cursorConfigured, true);
  assert.equal(fields.cursorOnline, false);
  assert.equal(fields.cursorRuntime, "local");
});

test("liveFieldsFromHealth stays offline when /health never arrived", () => {
  const fields = liveFieldsFromHealth(null);
  assert.equal(fields.serviceOnline, false);
  assert.equal(fields.cursorConfigured, false);
  assert.equal(fields.cursorOnline, false);
});

test("setup banner hides on cursorConfigured, not on a failed probe", () => {
  const app = source("packages/extension/src/sidepanel/App.tsx");
  assert.match(app, /state\?\.serviceOnline && !state\.cursorConfigured/);
  assert.doesNotMatch(
    app,
    /serviceOnline && !state\.cursorOnline/,
    "banner must not key off cursorOnline — a slow probe would keep showing Set CURSOR_API_KEY",
  );
  const bg = source("packages/extension/src/background/index.ts");
  assert.match(bg, /liveFieldsFromHealth\(health\)/);
});

/*
 * The setup banner was the last place naming Cursor unconditionally. It was
 * only ever hidden for the local agents by a side effect (configured() returns
 * true because /health cannot afford to probe a CLI login), so a future honest
 * check would have shown Claude users advice about a Cursor key.
 */
test("the setup banner reads the live agent's hint, not hardcoded Cursor copy", () => {
  const app = source("packages/extension/src/sidepanel/App.tsx");
  const banner = app.slice(
    app.indexOf("state?.serviceOnline && !state.cursorConfigured"),
    app.indexOf("cursorRuntime === \"cloud\""),
  );
  assert.match(banner, /state\.agentSetupHint/, "the banner must read the provider's hint");
  assert.doesNotMatch(
    banner,
    /CURSOR_API_KEY/,
    "no agent may be named unconditionally in the banner body",
  );
  /* PINNABLES_PROJECT_DIR stays literal: every agent needs it, so it is not
     the provider's to vary. */
  assert.match(banner, /PINNABLES_PROJECT_DIR/);
});

test("versionsHealthSnapshot does not report ok:false when the cache is empty", () => {
  resetVersionsHealthCache();
  const started = Date.now();
  const snap = versionsHealthSnapshot();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 50, `snapshot must be sync, took ${elapsed}ms`);
  assert.notEqual(
    snap.ok,
    false,
    "unknown must not look like no git — that hides the version rail on cold start",
  );
  assert.equal(snap.detail, null);
  assert.equal(snap.head, null);
});

test("versionsHealthSnapshot returns last-known info without awaiting git", () => {
  const started = Date.now();
  const snap = versionsHealthSnapshot();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 50, `snapshot must be sync, took ${elapsed}ms`);
  assert.equal(typeof snap.ok, "boolean");
  assert.ok("head" in snap);
});

test("GET /health reports configured:true quickly without calling the Cursor API", async () => {
  const home = await mkdtempAsync(join(tmpdir(), "pinnables-health-"));
  let cursorHits = 0;
  const cursor = createServer((req, res) => {
    cursorHits += 1;
    void req;
    void res;
  });
  await new Promise<void>((resolve) => cursor.listen(0, "127.0.0.1", resolve));
  const cursorAddr = cursor.address();
  assert.ok(cursorAddr && typeof cursorAddr === "object");

  const servicePort = 14681;
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", "packages/service/src/index.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PINNABLES_HOME: home,
        PINNABLES_PORT: String(servicePort),
        CURSOR_API_KEY: "test-key-already-set",
        CURSOR_API_BASE: `http://127.0.0.1:${cursorAddr.port}`,
        PINNABLES_CURSOR_RUNTIME: "cloud",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const ready = await waitForService(child);
  assert.equal(ready, true, "service should start");

  try {
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${servicePort}/health`);
    const elapsed = Date.now() - started;
    const body = (await res.json()) as {
      ok: boolean;
      versions: { ok: boolean; detail: string | null; head: string | null };
      cursor: {
        configured: boolean;
        ok: boolean;
        runtime: string;
        queueLength: number;
      };
    };
    assert.equal(res.ok, true);
    assert.equal(body.ok, true);
    assert.equal(
      body.versions.ok,
      true,
      "listen waits for the first versions refresh, so a git tree must not look unknown",
    );
    assert.equal(body.cursor.configured, true);
    assert.equal(body.cursor.runtime, "cloud");
    assert.equal(body.cursor.queueLength, 0);
    assert.ok(
      elapsed < 900,
      `/health must stay under the extension abort budget, took ${elapsed}ms`,
    );
    assert.equal(cursorHits, 0, "GET /health must not call probeCursor / api.cursor.com");
  } finally {
    child.kill("SIGTERM");
    cursor.close();
  }
});

test("GET /health reports configured:false when CURSOR_API_KEY is missing", async () => {
  const home = await mkdtempAsync(join(tmpdir(), "pinnables-health-nokey-"));
  const servicePort = 14682;
  const prevKey = process.env.CURSOR_API_KEY;
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", "packages/service/src/index.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PINNABLES_HOME: home,
        PINNABLES_PORT: String(servicePort),
        CURSOR_API_KEY: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const ready = await waitForService(child);
  assert.equal(ready, true, "service should start");

  try {
    const body = (await fetch(`http://127.0.0.1:${servicePort}/health`).then((r) =>
      r.json(),
    )) as { cursor: { configured: boolean; ok: boolean; detail: string | null } };
    assert.equal(body.cursor.configured, false);
    assert.equal(body.cursor.ok, false);
    assert.match(body.cursor.detail ?? "", /CURSOR_API_KEY/);
  } finally {
    child.kill("SIGTERM");
    if (prevKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = prevKey;
  }
});

/*
 * Every shipped panel reads health.cursor to decide whether the agent is set
 * up. Selecting a different agent must keep filling that block, or an
 * extension built before providers existed goes dark for no visible reason.
 */
test("GET /health fills the cursor block from whichever agent is selected", async () => {
  for (const [kind, label] of [
    ["claude", "Claude Code"],
    ["codex", "Codex"],
  ] as const) {
    const home = await mkdtempAsync(join(tmpdir(), `pinnables-health-${kind}-`));
    const servicePort = kind === "claude" ? 14683 : 14684;
    const child: ChildProcess = spawn(
      process.execPath,
      ["--import", "tsx", "packages/service/src/index.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PINNABLES_HOME: home,
          PINNABLES_PORT: String(servicePort),
          PINNABLES_AGENT: kind,
          PINNABLES_MODEL: "probe-model",
          /* Deliberately absent: a local agent must not need Cursor's key. */
          CURSOR_API_KEY: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const ready = await waitForService(child);
    assert.equal(ready, true, `${kind} service should start`);

    try {
      const body = (await fetch(`http://127.0.0.1:${servicePort}/health`).then((r) =>
        r.json(),
      )) as {
        cursor: { configured: boolean; runtime: string; cwd: string };
        agent: { kind: string; label: string; model: string | null; configured: boolean };
      };
      assert.equal(
        body.cursor.configured,
        true,
        `${kind}: the legacy block must report the live agent, not Cursor's key`,
      );
      assert.equal(body.cursor.runtime, "local");
      assert.equal(body.agent.kind, kind);
      assert.equal(body.agent.label, label);
      assert.equal(
        body.agent.model,
        "probe-model",
        `${kind}: PINNABLES_MODEL must reach the provider`,
      );
    } finally {
      child.kill("SIGTERM");
    }
  }
});

test("an unknown PINNABLES_AGENT exits instead of silently using Cursor", async () => {
  const home = await mkdtempAsync(join(tmpdir(), "pinnables-health-bogus-"));
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", "packages/service/src/index.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PINNABLES_HOME: home,
        PINNABLES_PORT: String(14685),
        PINNABLES_AGENT: "cluade",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  child.stdout?.on("data", (b: Buffer) => (output += b.toString()));
  child.stderr?.on("data", (b: Buffer) => (output += b.toString()));
  const code = await new Promise<number | null>((resolve) =>
    child.on("exit", (c) => resolve(c)),
  );
  assert.notEqual(code, 0, "a misspelled agent must be fatal");
  assert.match(output, /not a known agent/);
  assert.doesNotMatch(output, /pinnables service on/);
});

/*
 * The panel used to answer every failed Send with "Check CURSOR_API_KEY", in
 * red, whichever agent was live. These lock in both halves of the fix: our own
 * words instead of the SDK's, and a weight that matches what actually happened.
 */
test("classifySendFailure sorts real agent and HTTP errors", () => {
  const cases: Array<[string, string]> = [
    ["Failed to authenticate: OAuth session expired", "signed-out"],
    ["Cursor API 401 /v1/agents: unauthorized", "signed-out"],
    ["Claude Code native binary not found at /usr/bin/claude", "missing-agent"],
    ["spawn codex ENOENT", "missing-agent"],
    ["Cursor API 429: rate limit exceeded", "rate-limited"],
    ["Agent already has an active run", "busy"],
    ["request timed out after 30000ms", "timeout"],
    ["fetch failed: ECONNREFUSED 127.0.0.1:4573", "offline"],
    ["something nobody has seen before", "unknown"],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(classifySendFailure(new Error(raw)), expected, raw);
  }
});

test("severity separates not-set-up from actually-broken", () => {
  /* Forgetting a step must never wear the same colour as a crash. */
  for (const kind of ["offline", "signed-out", "missing-agent", "project"] as const) {
    assert.equal(severityForFailure(kind), "warn", kind);
  }
  /* Waiting is not a failure at all. */
  for (const kind of ["busy", "rate-limited"] as const) {
    assert.equal(severityForFailure(kind), "note", kind);
  }
  /* Red is only for "you did everything right and it broke anyway". */
  for (const kind of ["timeout", "unknown"] as const) {
    assert.equal(severityForFailure(kind), "error", kind);
  }
});

const READY = { serviceOnline: true, configured: true };

test("a standing banner is never repeated as an alert", () => {
  assert.equal(
    describeSendFailure(new Error("Local service is offline"), {
      ...READY,
      serviceOnline: false,
    }),
    null,
  );
  assert.equal(
    describeSendFailure(new Error("no key"), { ...READY, configured: false }),
    null,
  );
});

test("describeSendFailure never leaks the agent SDK's own wording", () => {
  const sdkError = new Error(
    "Could not send the board to the agent: Claude Code native binary not found at " +
      "/nonexistent/claude. Please ensure Claude Code is installed via native installer " +
      "or specify a valid path with options.pathToClaudeCodeExecutable.",
  );
  const notice = describeSendFailure(sdkError, {
    ...READY,
    label: "Claude Code",
    installHint:
      "Install Claude Code, or set PINNABLES_CLAUDE_PATH to its full path on the local service.",
  });
  assert.equal(
    notice?.message,
    "Claude Code isn’t installed yet. Install Claude Code, or set " +
      "PINNABLES_CLAUDE_PATH to its full path on the local service.",
  );
  assert.equal(notice?.severity, "warn", "a missing install is a step, not a crash");
  assert.match(notice?.message ?? "", /PINNABLES_CLAUDE_PATH/);
  for (const jargon of ["pathToClaudeCodeExecutable", "options.", "native installer", "/nonexistent"]) {
    assert.ok(!notice?.message.includes(jargon), `copy must not contain "${jargon}"`);
  }
});

test("every install hint names the thing you act on", () => {
  const cursor = describeSendFailure(new Error("spawn ENOENT"), {
    ...READY,
    label: "Cursor",
    installHint: "Install @cursor/sdk with npm install, then restart the local service.",
  });
  assert.equal(
    cursor?.message,
    "Cursor isn’t installed yet. Install @cursor/sdk with npm install, " +
      "then restart the local service.",
  );
  assert.match(cursor?.message ?? "", /@cursor\/sdk/);
});

test("setup copy names the step, not the fault", () => {
  const claude = describeSendFailure(new Error("Failed to authenticate: OAuth session expired"), {
    ...READY,
    label: "Claude Code",
    hint: "Run claude login in a terminal, then restart the service.",
  });
  assert.equal(
    claude?.message,
    "Claude Code isn’t signed in yet. Run claude login in a terminal, then restart the service.",
  );
  assert.equal(claude?.severity, "warn");
  assert.doesNotMatch(claude?.message ?? "", /CURSOR_API_KEY/);
  assert.doesNotMatch(
    claude?.message ?? "",
    /couldn’t|could not|failed/i,
    "a step not taken must not be phrased as a failure",
  );
});

test("waiting reads as quiet, and does not ask for work the queue is doing", () => {
  const busy = describeSendFailure(new Error("Agent already has an active run"), {
    ...READY,
    label: "Codex",
  });
  assert.equal(
    busy?.message,
    "Codex is still working on your last send. It’ll go as soon as that finishes.",
  );
  assert.equal(busy?.severity, "note");
  assert.doesNotMatch(busy?.message ?? "", /try again/i, "the queue already holds it");
});

test("red is reserved for a genuine break, and defaults to Cursor", () => {
  const broken = describeSendFailure(new Error("something nobody has seen before"), READY);
  assert.equal(
    broken?.message,
    "Couldn’t send to Cursor. Check the service log for what went wrong, then try again.",
  );
  assert.equal(broken?.severity, "error");
});

test("liveFieldsFromHealth carries the agent label and hint, defaulting to Cursor", () => {
  const named = liveFieldsFromHealth({
    ok: true,
    home: "/tmp",
    cursor: { configured: true, ok: true, detail: null, runtime: "local" },
    agent: { kind: "codex", label: "Codex", setupHint: "Run codex login." },
  });
  assert.equal(named.agentLabel, "Codex");
  assert.equal(named.agentSetupHint, "Run codex login.");

  const legacy = liveFieldsFromHealth({
    ok: true,
    home: "/tmp",
    cursor: { configured: true, ok: true, detail: null, runtime: "local" },
  });
  assert.equal(legacy.agentLabel, "Cursor");
  assert.equal(legacy.agentSetupHint, null);
});

test("/health carries a setup hint written for the live agent", async () => {
  const home = await mkdtempAsync(join(tmpdir(), "pinnables-health-hint-"));
  const servicePort = 14686;
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", "packages/service/src/index.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PINNABLES_HOME: home,
        PINNABLES_PORT: String(servicePort),
        PINNABLES_AGENT: "claude",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const ready = await waitForService(child);
  assert.equal(ready, true, "service should start");
  try {
    const body = (await fetch(`http://127.0.0.1:${servicePort}/health`).then((r) =>
      r.json(),
    )) as { agent: { setupHint: string; installHint: string } };
    assert.match(body.agent.setupHint, /claude login/);
    assert.doesNotMatch(body.agent.setupHint, /CURSOR_API_KEY/);
    assert.match(
      body.agent.installHint,
      /PINNABLES_CLAUDE_PATH/,
      "the install hint must name the variable that points at the binary",
    );
  } finally {
    child.kill("SIGTERM");
  }
});
