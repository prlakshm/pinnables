import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import { liveFieldsFromHealth } from "../packages/extension/src/lib/service.ts";
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
    // Hang: a live probe used to sit here and blow the extension's 900ms budget.
    void req;
    void res;
  });
  await new Promise<void>((resolve) => cursor.listen(0, "127.0.0.1", resolve));
  const cursorAddr = cursor.address();
  assert.ok(cursorAddr && typeof cursorAddr === "object");

  const servicePort = 14575;
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
    assert.equal(
      cursorHits,
      0,
      "GET /health must not call probeCursor / api.cursor.com",
    );
  } finally {
    child.kill("SIGTERM");
    cursor.close();
  }
});

test("GET /health reports configured:false when CURSOR_API_KEY is missing", async () => {
  const home = await mkdtempAsync(join(tmpdir(), "pinnables-health-nokey-"));
  const servicePort = 14576;
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
