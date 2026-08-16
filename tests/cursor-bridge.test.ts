import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";
import {
  cursorConfigured,
  imageFromDataUrl,
  imagesFromScreenshots,
  sendToCursor,
  statusFromCursor,
} from "../packages/service/src/cursor.ts";

const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

test("imageFromDataUrl accepts png data URLs and rejects others", () => {
  const ok = imageFromDataUrl(`data:image/png;base64,${TINY_PNG}`);
  assert.equal(ok?.mimeType, "image/png");
  assert.equal(ok?.data, TINY_PNG);
  assert.equal(imageFromDataUrl("not-an-image"), null);
});

test("imagesFromScreenshots caps at five and skips missing pins", () => {
  const shots: Record<string, string> = {};
  for (let i = 0; i < 7; i += 1) {
    shots[`pin-${i}`] = `data:image/png;base64,${TINY_PNG}`;
  }
  const images = imagesFromScreenshots(shots, [
    "pin-0",
    "missing",
    "pin-1",
    "pin-2",
    "pin-3",
    "pin-4",
    "pin-5",
  ]);
  assert.equal(images.length, 5);
  assert.equal(images[0].mimeType, "image/png");
});

test("cursorConfigured reflects CURSOR_API_KEY", () => {
  const prev = process.env.CURSOR_API_KEY;
  delete process.env.CURSOR_API_KEY;
  assert.equal(cursorConfigured(), false);
  process.env.CURSOR_API_KEY = "test-key";
  assert.equal(cursorConfigured(), true);
  if (prev === undefined) delete process.env.CURSOR_API_KEY;
  else process.env.CURSOR_API_KEY = prev;
});

test("cursorRuntime defaults to local", async () => {
  const { cursorRuntime, projectDir } = await import("../packages/service/src/cursor.ts");
  const prevRuntime = process.env.PINNABLES_CURSOR_RUNTIME;
  const prevDir = process.env.PINNABLES_PROJECT_DIR;
  delete process.env.PINNABLES_CURSOR_RUNTIME;
  assert.equal(cursorRuntime(), "local");
  process.env.PINNABLES_CURSOR_RUNTIME = "cloud";
  assert.equal(cursorRuntime(), "cloud");
  process.env.PINNABLES_PROJECT_DIR = "/tmp/annotated-app";
  assert.equal(projectDir(), "/tmp/annotated-app");
  if (prevRuntime === undefined) delete process.env.PINNABLES_CURSOR_RUNTIME;
  else process.env.PINNABLES_CURSOR_RUNTIME = prevRuntime;
  if (prevDir === undefined) delete process.env.PINNABLES_PROJECT_DIR;
  else process.env.PINNABLES_PROJECT_DIR = prevDir;
});

test("local Sends default to fast Composer and skip images", async () => {
  const { modelSelection, sendImagesEnabled, shouldAttachScreenshots } = await import(
    "../packages/service/src/cursor.ts"
  );
  const prevFast = process.env.PINNABLES_CURSOR_FAST;
  const prevModel = process.env.PINNABLES_CURSOR_MODEL;
  const prevImages = process.env.PINNABLES_SEND_IMAGES;
  const prevRuntime = process.env.PINNABLES_CURSOR_RUNTIME;
  delete process.env.PINNABLES_CURSOR_FAST;
  delete process.env.PINNABLES_CURSOR_MODEL;
  delete process.env.PINNABLES_SEND_IMAGES;
  delete process.env.PINNABLES_CURSOR_RUNTIME;
  const model = modelSelection();
  assert.equal(model.id, "composer-2.5");
  assert.equal(model.params?.[0]?.id, "fast");
  assert.equal(sendImagesEnabled(), false);
  assert.equal(shouldAttachScreenshots(false), false);
  assert.equal(shouldAttachScreenshots(true), true);
  process.env.PINNABLES_CURSOR_FAST = "0";
  assert.equal(modelSelection().params, undefined);
  process.env.PINNABLES_SEND_IMAGES = "1";
  assert.equal(sendImagesEnabled(), true);
  if (prevFast === undefined) delete process.env.PINNABLES_CURSOR_FAST;
  else process.env.PINNABLES_CURSOR_FAST = prevFast;
  if (prevModel === undefined) delete process.env.PINNABLES_CURSOR_MODEL;
  else process.env.PINNABLES_CURSOR_MODEL = prevModel;
  if (prevImages === undefined) delete process.env.PINNABLES_SEND_IMAGES;
  else process.env.PINNABLES_SEND_IMAGES = prevImages;
  if (prevRuntime === undefined) delete process.env.PINNABLES_CURSOR_RUNTIME;
  else process.env.PINNABLES_CURSOR_RUNTIME = prevRuntime;
});

test("sendToCursor creates an agent against a mock Cursor API", async () => {
  const home = await mkdtemp(join(tmpdir(), "pinnables-cursor-"));
  const prevHome = process.env.PINNABLES_HOME;
  const prevKey = process.env.CURSOR_API_KEY;
  const prevBase = process.env.CURSOR_API_BASE;
  const prevRuntime = process.env.PINNABLES_CURSOR_RUNTIME;
  process.env.PINNABLES_HOME = home;
  process.env.CURSOR_API_KEY = "test-key";
  process.env.PINNABLES_CURSOR_RUNTIME = "cloud";

  let createBody: unknown = null;
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method === "GET" && req.url?.startsWith("/v1/agents?")) {
        return json(res, 200, { items: [] });
      }
      if (req.method === "POST" && req.url === "/v1/agents") {
        createBody = await readJson(req);
        return json(res, 200, {
          agent: {
            id: "bc-test-agent",
            url: "https://cursor.com/agents/bc-test-agent",
            status: "ACTIVE",
          },
          run: {
            id: "run-test-1",
            agentId: "bc-test-agent",
            status: "CREATING",
          },
        });
      }
      json(res, 404, { error: "not found" });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  process.env.CURSOR_API_BASE = `http://127.0.0.1:${address.port}`;

  try {
    const result = await sendToCursor({
      text: "Implement this pin",
      images: [{ data: TINY_PNG, mimeType: "image/png" }],
      name: "Pinnables test",
      repoUrl: "https://github.com/prlakshm/pinnables",
    });
    assert.equal(result.mode, "create");
    assert.equal(result.agentId, "bc-test-agent");
    assert.equal(result.runId, "run-test-1");
    assert.equal(result.runtime, "cloud");
    assert.ok(createBody && typeof createBody === "object");
    const body = createBody as {
      prompt: { text: string; images: unknown[] };
      repos: Array<{ url: string }>;
    };
    assert.match(body.prompt.text, /Implement this pin/);
    assert.equal(body.prompt.images.length, 1);
    assert.equal(body.repos[0].url, "https://github.com/prlakshm/pinnables");

    const session = JSON.parse(await readFile(join(home, "cursor-session.json"), "utf8")) as {
      agentId: string;
      runtime: string;
    };
    assert.equal(session.agentId, "bc-test-agent");
    assert.equal(session.runtime, "cloud");
  } finally {
    server.close();
    if (prevHome === undefined) delete process.env.PINNABLES_HOME;
    else process.env.PINNABLES_HOME = prevHome;
    if (prevKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = prevKey;
    if (prevBase === undefined) delete process.env.CURSOR_API_BASE;
    else process.env.CURSOR_API_BASE = prevBase;
    if (prevRuntime === undefined) delete process.env.PINNABLES_CURSOR_RUNTIME;
    else process.env.PINNABLES_CURSOR_RUNTIME = prevRuntime;
  }
});

test("sendToCursor follow-ups a sticky ACTIVE agent", async () => {
  const home = await mkdtemp(join(tmpdir(), "pinnables-cursor-"));
  const prevHome = process.env.PINNABLES_HOME;
  const prevKey = process.env.CURSOR_API_KEY;
  const prevBase = process.env.CURSOR_API_BASE;
  const prevSticky = process.env.PINNABLES_CURSOR_AGENT_ID;
  const prevRuntime = process.env.PINNABLES_CURSOR_RUNTIME;
  process.env.PINNABLES_HOME = home;
  process.env.CURSOR_API_KEY = "test-key";
  process.env.PINNABLES_CURSOR_AGENT_ID = "bc-sticky";
  process.env.PINNABLES_CURSOR_RUNTIME = "cloud";

  let followBody: unknown = null;
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method === "GET" && req.url === "/v1/agents/bc-sticky") {
        return json(res, 200, {
          id: "bc-sticky",
          status: "ACTIVE",
          url: "https://cursor.com/agents/bc-sticky",
        });
      }
      if (req.method === "POST" && req.url === "/v1/agents/bc-sticky/runs") {
        followBody = await readJson(req);
        return json(res, 200, {
          id: "run-follow-2",
          agentId: "bc-sticky",
          status: "RUNNING",
        });
      }
      json(res, 404, { error: "not found" });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  process.env.CURSOR_API_BASE = `http://127.0.0.1:${address.port}`;

  try {
    const result = await sendToCursor({ text: "Match the daffodil card" });
    assert.equal(result.mode, "follow-up");
    assert.equal(result.agentId, "bc-sticky");
    assert.equal(result.runId, "run-follow-2");
    assert.ok(followBody && typeof followBody === "object");
    assert.match((followBody as { prompt: { text: string } }).prompt.text, /daffodil/);
  } finally {
    server.close();
    if (prevHome === undefined) delete process.env.PINNABLES_HOME;
    else process.env.PINNABLES_HOME = prevHome;
    if (prevKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = prevKey;
    if (prevBase === undefined) delete process.env.CURSOR_API_BASE;
    else process.env.CURSOR_API_BASE = prevBase;
    if (prevSticky === undefined) delete process.env.PINNABLES_CURSOR_AGENT_ID;
    else process.env.PINNABLES_CURSOR_AGENT_ID = prevSticky;
    if (prevRuntime === undefined) delete process.env.PINNABLES_CURSOR_RUNTIME;
    else process.env.PINNABLES_CURSOR_RUNTIME = prevRuntime;
  }
});

test("service queues a second send while Cursor reports agent_busy", async () => {
  const home = await mkdtemp(join(tmpdir(), "pinnables-queue-"));
  const prevHome = process.env.PINNABLES_HOME;
  const prevKey = process.env.CURSOR_API_KEY;
  const prevBase = process.env.CURSOR_API_BASE;

  let runPosts = 0;
  let agentBusy = true;
  const cursor = createServer((req, res) => {
    void (async () => {
      if (req.method === "GET" && req.url?.startsWith("/v1/agents?")) {
        return json(res, 200, { items: [] });
      }
      if (req.method === "GET" && req.url === "/v1/agents/bc-queue") {
        return json(res, 200, {
          id: "bc-queue",
          status: "ACTIVE",
          url: "https://cursor.com/agents/bc-queue",
          latestRunId: "run-1",
        });
      }
      if (req.method === "GET" && req.url === "/v1/agents/bc-queue/runs/run-1") {
        return json(res, 200, {
          id: "run-1",
          agentId: "bc-queue",
          status: agentBusy ? "RUNNING" : "FINISHED",
        });
      }
      if (req.method === "GET" && req.url === "/v1/agents/bc-queue/runs/run-2") {
        return json(res, 200, {
          id: "run-2",
          agentId: "bc-queue",
          status: "RUNNING",
        });
      }
      if (req.method === "POST" && req.url === "/v1/agents") {
        runPosts += 1;
        await readJson(req);
        return json(res, 200, {
          agent: {
            id: "bc-queue",
            url: "https://cursor.com/agents/bc-queue",
            status: "ACTIVE",
          },
          run: { id: "run-1", agentId: "bc-queue", status: "RUNNING" },
        });
      }
      if (req.method === "POST" && req.url === "/v1/agents/bc-queue/runs") {
        runPosts += 1;
        await readJson(req);
        if (agentBusy) {
          return json(res, 409, {
            error: { code: "agent_busy", message: "Agent already has an active run" },
          });
        }
        return json(res, 200, {
          id: "run-2",
          agentId: "bc-queue",
          status: "RUNNING",
        });
      }
      json(res, 404, {});
    })();
  });
  await new Promise<void>((resolve) => cursor.listen(0, "127.0.0.1", resolve));
  const cursorAddr = cursor.address();
  assert.ok(cursorAddr && typeof cursorAddr === "object");

  const servicePort = 14574;
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", "packages/service/src/index.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PINNABLES_HOME: home,
        PINNABLES_PORT: String(servicePort),
        CURSOR_API_KEY: "test-key",
        CURSOR_API_BASE: `http://127.0.0.1:${cursorAddr.port}`,
        PINNABLES_CURSOR_RUNTIME: "cloud",
        PINNABLES_REPO_URL: "https://github.com/prlakshm/pinnables",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const ready = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 8000);
    const onData = (buf: Buffer) => {
      if (buf.toString().includes("pinnables service on")) {
        clearTimeout(timer);
        resolve(true);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
  });
  assert.equal(ready, true, "service should start");

  const pin = {
    id: "pin-1",
    schemaVersion: 1,
    boardId: "board-queue-test",
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
  const board = {
    id: "board-queue-test",
    schemaVersion: 1,
    projectId: "local",
    title: "Queue test",
    globalInstruction: "",
    status: "draft",
    generatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pins: [pin],
    relationships: [],
  };

  try {
    const first = await fetch(`http://127.0.0.1:${servicePort}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "first change",
        board,
        pinIds: ["pin-1"],
        screenshots: { "pin-1": `data:image/png;base64,${TINY_PNG}` },
      }),
    });
    const firstBody = JSON.parse(await first.text()) as {
      messageId: string;
      state: string;
    };
    assert.equal(first.ok, true);
    assert.equal(firstBody.state, "starting");

    const second = await fetch(`http://127.0.0.1:${servicePort}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "second change",
        board,
        pinIds: ["pin-1"],
        screenshots: { "pin-1": `data:image/png;base64,${TINY_PNG}` },
      }),
    });
    const secondText = await second.text();
    assert.equal(second.ok, true, secondText);
    const secondBody = JSON.parse(secondText) as { messageId: string; state: string };
    assert.equal(secondBody.state, "queued");

    const queuedStatus = await fetch(
      `http://127.0.0.1:${servicePort}/messages/${secondBody.messageId}`,
    ).then((r) => r.json());
    assert.equal(queuedStatus.state, "queued");

    agentBusy = false;
    // Drain: finish run-1, then the queue should post run-2.
    let drained = false;
    for (let i = 0; i < 20; i += 1) {
      await fetch(`http://127.0.0.1:${servicePort}/messages/${firstBody.messageId}`);
      await fetch(`http://127.0.0.1:${servicePort}/messages/${secondBody.messageId}`);
      const status = await fetch(
        `http://127.0.0.1:${servicePort}/messages/${secondBody.messageId}`,
      ).then((r) => r.json());
      if (status.state === "starting" || status.state === "working") {
        drained = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.equal(drained, true, "queued send should start after the first run finishes");
    assert.ok(runPosts >= 2, "Cursor should receive a follow-up run");
  } finally {
    child.kill("SIGTERM");
    cursor.close();
    if (prevHome === undefined) delete process.env.PINNABLES_HOME;
    else process.env.PINNABLES_HOME = prevHome;
    if (prevKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = prevKey;
    if (prevBase === undefined) delete process.env.CURSOR_API_BASE;
    else process.env.CURSOR_API_BASE = prevBase;
  }
});

test("isAgentBusyError detects Cursor 409 payloads", async () => {
  const { isAgentBusyError } = await import("../packages/service/src/cursor.ts");
  assert.equal(
    isAgentBusyError(
      new Error(
        'Cursor API 409 /v1/agents/bc-x/runs: {"error":{"code":"agent_busy","message":"Agent already has an active run"}}',
      ),
    ),
    true,
  );
  assert.equal(isAgentBusyError(new Error("Cursor API 500 boom")), false);
});

test("statusFromCursor maps FINISHED and ERROR", async () => {
  const prevKey = process.env.CURSOR_API_KEY;
  const prevBase = process.env.CURSOR_API_BASE;
  process.env.CURSOR_API_KEY = "test-key";

  const server = createServer((req, res) => {
    if (req.url?.endsWith("/run-ok")) {
      return json(res, 200, { id: "run-ok", agentId: "bc-a", status: "FINISHED" });
    }
    if (req.url?.endsWith("/run-bad")) {
      return json(res, 200, {
        id: "run-bad",
        agentId: "bc-a",
        status: "ERROR",
        error: "boom",
      });
    }
    json(res, 404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  process.env.CURSOR_API_BASE = `http://127.0.0.1:${address.port}`;

  try {
    const done = await statusFromCursor("bc-a", "run-ok");
    assert.equal(done.state, "done");
    const failed = await statusFromCursor("bc-a", "run-bad");
    assert.equal(failed.state, "failed");
    assert.match(failed.detail ?? "", /boom/);
  } finally {
    server.close();
    if (prevKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = prevKey;
    if (prevBase === undefined) delete process.env.CURSOR_API_BASE;
    else process.env.CURSOR_API_BASE = prevBase;
  }
});

test("service /boards/:id/push uses Cursor when configured", async () => {
  const home = await mkdtemp(join(tmpdir(), "pinnables-push-"));
  const fixture = {
    id: "board-push-test",
    schemaVersion: 1,
    projectId: "local",
    title: "Push test",
    globalInstruction: "",
    status: "ready",
    generatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pins: [
      {
        id: "pin-1",
        schemaVersion: 1,
        boardId: "board-push-test",
        order: 1,
        groupId: null,
        url: "http://localhost:5181/#/catalogue",
        route: "/catalogue",
        viewport: { width: 1280, height: 800 },
        screenshotPath: "pins/pin-1.png",
        thumbnailPath: "pins/pin-1.thumb.webp",
        selector: ".variety",
        domPath: "body > .variety",
        outerHtml: '<article class="variety"></article>',
        classList: ["variety"],
        elementText: "Rose",
        componentName: "VarietyCard",
        sourceFile: "src/components/VarietyCard.tsx:14",
        computedStyles: { "border-radius": "14px" },
        styleEdits: {},
        annotation: "Add June tooltip",
        captureState: "default",
        status: "todo",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        name: null,
        kind: "element",
        drawings: [],
        liveSends: [],
      },
    ],
    relationships: [],
  };

  let createCalled = false;
  const cursor = createServer((req, res) => {
    void (async () => {
      if (req.method === "GET" && req.url?.startsWith("/v1/agents")) {
        return json(res, 200, { items: [] });
      }
      if (req.method === "POST" && req.url === "/v1/agents") {
        createCalled = true;
        await readJson(req);
        return json(res, 200, {
          agent: { id: "bc-push", url: "https://cursor.com/agents/bc-push", status: "ACTIVE" },
          run: { id: "run-push", agentId: "bc-push", status: "RUNNING" },
        });
      }
      json(res, 404, {});
    })();
  });
  await new Promise<void>((resolve) => cursor.listen(0, "127.0.0.1", resolve));
  const cursorAddr = cursor.address();
  assert.ok(cursorAddr && typeof cursorAddr === "object");

  const servicePort = 14573;
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", "packages/service/src/index.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PINNABLES_HOME: home,
        PINNABLES_PORT: String(servicePort),
        CURSOR_API_KEY: "test-key",
        CURSOR_API_BASE: `http://127.0.0.1:${cursorAddr.port}`,
        PINNABLES_CURSOR_RUNTIME: "cloud",
        PINNABLES_REPO_URL: "https://github.com/prlakshm/pinnables",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const ready = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 8000);
    const onData = (buf: Buffer) => {
      if (buf.toString().includes("pinnables service on")) {
        clearTimeout(timer);
        resolve(true);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
  });
  assert.equal(ready, true, "service should start");

  try {
    const health = await fetch(`http://127.0.0.1:${servicePort}/health`).then((r) => r.json());
    assert.equal(health.ok, true);
    assert.equal(health.cursor.configured, true);
    assert.equal(health.cursor.runtime, "cloud");

    const pushedRes = await fetch(`http://127.0.0.1:${servicePort}/boards/board-push-test/push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        board: fixture,
        screenshots: { "pin-1": `data:image/png;base64,${TINY_PNG}` },
      }),
    });
    const pushedText = await pushedRes.text();
    assert.equal(pushedRes.ok, true, pushedText);
    const pushed = JSON.parse(pushedText) as {
      transport: string;
      agentId: string;
      runId: string;
    };

    assert.equal(pushed.transport, "cursor");
    assert.equal(pushed.agentId, "bc-push");
    assert.equal(pushed.runId, "run-push");
    assert.equal(createCalled, true);
    assert.match(await readFile(join(home, "boards/board-push-test/brief.md"), "utf8"), /Push test/);
  } finally {
    child.kill("SIGTERM");
    cursor.close();
  }
});
