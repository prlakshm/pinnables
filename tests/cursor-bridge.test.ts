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

test("sendToCursor creates an agent against a mock Cursor API", async () => {
  const home = await mkdtemp(join(tmpdir(), "pinnables-cursor-"));
  const prevHome = process.env.PINNABLES_HOME;
  const prevKey = process.env.CURSOR_API_KEY;
  const prevBase = process.env.CURSOR_API_BASE;
  process.env.PINNABLES_HOME = home;
  process.env.CURSOR_API_KEY = "test-key";

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
    };
    assert.equal(session.agentId, "bc-test-agent");
  } finally {
    server.close();
    if (prevHome === undefined) delete process.env.PINNABLES_HOME;
    else process.env.PINNABLES_HOME = prevHome;
    if (prevKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = prevKey;
    if (prevBase === undefined) delete process.env.CURSOR_API_BASE;
    else process.env.CURSOR_API_BASE = prevBase;
  }
});

test("sendToCursor follow-ups a sticky ACTIVE agent", async () => {
  const home = await mkdtemp(join(tmpdir(), "pinnables-cursor-"));
  const prevHome = process.env.PINNABLES_HOME;
  const prevKey = process.env.CURSOR_API_KEY;
  const prevBase = process.env.CURSOR_API_BASE;
  const prevSticky = process.env.PINNABLES_CURSOR_AGENT_ID;
  process.env.PINNABLES_HOME = home;
  process.env.CURSOR_API_KEY = "test-key";
  process.env.PINNABLES_CURSOR_AGENT_ID = "bc-sticky";

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
  }
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
      cwd: "/workspace",
      env: {
        ...process.env,
        PINNABLES_HOME: home,
        PINNABLES_PORT: String(servicePort),
        CURSOR_API_KEY: "test-key",
        CURSOR_API_BASE: `http://127.0.0.1:${cursorAddr.port}`,
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
    assert.equal(health.cursor.ok, true);

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
