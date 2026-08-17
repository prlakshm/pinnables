import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";

const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function boardPayload() {
  const pin = {
    id: "pin-1",
    schemaVersion: 1,
    boardId: "board-agent-queue",
    order: 1,
    groupId: null,
    url: "http://localhost:5181/#/catalogue",
    route: "/catalogue",
    viewport: { width: 1280, height: 800 },
    screenshotPath: "pins/pin-1.png",
    thumbnailPath: "pins/pin-1.thumb.webp",
    selector: ".mark",
    domPath: "body > .mark",
    outerHtml: '<span class="mark">i</span>',
    classList: ["mark"],
    elementText: "i",
    componentName: "Masthead",
    sourceFile: "src/components/Masthead.tsx:8",
    computedStyles: { color: "rgb(163, 55, 38)" },
    styleEdits: {},
    annotation: "",
    captureState: "default",
    status: "todo",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    name: null,
    kind: "element",
    drawings: [],
    liveSends: [],
  };
  return {
    id: "board-agent-queue",
    schemaVersion: 1,
    projectId: "local",
    title: "Agent queue",
    globalInstruction: "",
    status: "draft",
    generatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pins: [pin],
    relationships: [],
  };
}

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

test("Claude/Codex local spawn queues a second send until the first exits", async () => {
  const home = await mkdtemp(join(tmpdir(), "pinnables-agent-queue-"));
  const servicePort = 14690;
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", "packages/service/src/index.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PINNABLES_HOME: home,
        PINNABLES_PORT: String(servicePort),
        PINNABLES_PROJECT_DIR: home,
        CURSOR_API_KEY: "",
        CODEX_API_KEY: "",
        OPENAI_API_KEY: "",
        PINNABLES_AGENT: "claude",
        PINNABLES_AGENT_CMD: `node -e "setTimeout(()=>process.exit(0), 1800)"`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const ready = await waitForService(child);
  assert.equal(ready, true, "service should start");

  const board = boardPayload();
  const sendBody = (text: string) =>
    JSON.stringify({
      text,
      board,
      pinIds: ["pin-1"],
      screenshots: { "pin-1": `data:image/png;base64,${TINY_PNG}` },
    });

  try {
    const health = (await fetch(`http://127.0.0.1:${servicePort}/health`).then((r) =>
      r.json(),
    )) as { agent: { backend: string; queueLength: number } };
    assert.equal(health.agent.backend, "custom");

    const first = await fetch(`http://127.0.0.1:${servicePort}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: sendBody("change background to rose"),
    });
    const firstBody = JSON.parse(await first.text()) as { messageId: string; state: string };
    assert.equal(first.ok, true, "first send should be accepted");
    assert.ok(
      firstBody.state === "starting" || firstBody.state === "working",
      `first send should start, got ${firstBody.state}`,
    );

    const second = await fetch(`http://127.0.0.1:${servicePort}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: sendBody("change background cards to white instead of green"),
    });
    const secondText = await second.text();
    assert.equal(second.ok, true, secondText);
    const secondBody = JSON.parse(secondText) as { messageId: string; state: string };
    assert.equal(secondBody.state, "queued");

    let drained = false;
    for (let i = 0; i < 30; i += 1) {
      const status = (await fetch(
        `http://127.0.0.1:${servicePort}/messages/${secondBody.messageId}`,
      ).then((r) => r.json())) as { state: string };
      if (status.state === "starting" || status.state === "working" || status.state === "done") {
        drained = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(drained, true, "queued Claude/Codex send should start after the first spawn exits");

    const unknown = await fetch(`http://127.0.0.1:${servicePort}/messages/msg-never-existed`);
    assert.equal(unknown.status, 404);
    assert.match(await unknown.text(), /Unknown message/);

    const abandon = await fetch(`http://127.0.0.1:${servicePort}/messages/abandon`, {
      method: "POST",
    });
    const abandonBody = (await abandon.json()) as { ok: boolean; abandoned: number };
    assert.equal(abandon.ok, true);
    assert.equal(abandonBody.ok, true);
    assert.equal(typeof abandonBody.abandoned, "number");
  } finally {
    child.kill("SIGTERM");
  }
});
