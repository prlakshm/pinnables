#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BoardSchema,
  renderBoardManifest,
  renderPinContext,
  renderRelationship,
  type Board,
} from "@pinnables/shared";
import { boardDir, pinnablesHome, writeBoard } from "@pinnables/shared/storage";
import {
  cursorConfigured,
  imagesFromScreenshots,
  probeCursor,
  sendToCursor,
  statusFromCursor,
  type CursorStatus,
} from "./cursor.js";

/**
 * The local companion. Extensions can't write to arbitrary filesystem paths, so
 * this is what turns a board into files an agent can read — and it writes the
 * same board.json the MCP server reads, so neither path is redundant.
 *
 * Bound to 127.0.0.1 only. Nothing here should ever be reachable off-machine.
 *
 * Send path (least friction first):
 *   1. Cursor Cloud Agents API when CURSOR_API_KEY is set — press Send, agent runs.
 *   2. Local spawn via PINNABLES_AGENT_CMD / `claude` as a fallback.
 */

const PORT = Number(process.env.PINNABLES_PORT ?? 4573);
const HOST = "127.0.0.1";
const MAX_BODY = 128 * 1024 * 1024;

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    // The caller is always a chrome-extension:// origin on this machine.
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("Payload too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Strip the data-URL prefix and decode. */
function decodeDataUrl(dataUrl: string): Buffer | null {
  const match = /^data:image\/\w+;base64,(.+)$/s.exec(dataUrl);
  return match ? Buffer.from(match[1], "base64") : null;
}

async function materialize(board: Board, screenshots: Record<string, string>) {
  const dir = boardDir(board.id);
  await mkdir(join(dir, "pins"), { recursive: true });

  await writeBoard(board);
  await writeFile(join(dir, "brief.md"), `${renderBoardManifest(board)}\n`, "utf8");

  for (const pin of board.pins) {
    await writeFile(
      join(dir, "pins", `${pin.id}.json`),
      `${renderPinContext(board, pin, join(dir, "pins", `${pin.id}.png`))}\n`,
      "utf8",
    );
    const image = screenshots[pin.id] ? decodeDataUrl(screenshots[pin.id]) : null;
    if (image) await writeFile(join(dir, "pins", `${pin.id}.png`), image);
  }

  return dir;
}

/* ------------------------------------------------------------ live messages */

interface LiveMessage {
  state: "starting" | "working" | "done" | "failed";
  detail: string | null;
  transport?: "cursor" | "local";
  agentId?: string;
  runId?: string;
  url?: string;
}

/**
 * Each live send becomes one agent run. Cursor Cloud Agents are preferred when
 * configured; otherwise we spawn a local CLI. Status is polled from this map —
 * for Cursor runs we refresh from the API on each status GET.
 */
const liveMessages = new Map<string, LiveMessage>();
let liveCounter = 0;

interface LiveMessageBody {
  text: string;
  board: unknown;
  pinIds: string[];
  relationshipId?: string;
  drawingSummary?: string;
  screenshots?: Record<string, string>;
}

function buildLiveMarkdown(
  body: LiveMessageBody,
  board: Board,
  pins: Board["pins"],
  dir: string,
  screenshots: Record<string, string>,
): { lines: string[]; messagePath: string } {
  const lines: string[] = [];
  lines.push("# Live message from Pinnables");
  lines.push("");
  lines.push("A designer is annotating a running app and sent this while working.");
  lines.push("Implement exactly what it asks — it is one focused change, not a backlog.");
  lines.push("");
  lines.push(`## Instruction`);
  lines.push(body.text);
  if (body.drawingSummary?.trim()) {
    lines.push("", `Marks drawn alongside it: ${body.drawingSummary.trim()}`);
  }
  if (body.relationshipId) {
    lines.push("", "## Relationship this message is about", "");
    lines.push(renderRelationship(board, body.relationshipId));
  }
  lines.push("", "## Pinned component context", "");
  for (const pin of pins) {
    const shotPath = join(dir, `${pin.id}.png`);
    const dataUrl = screenshots[pin.id];
    const image = dataUrl ? decodeDataUrl(dataUrl) : null;
    // Screenshots are also attached as Cursor prompt images when using the API;
    // the path line still helps local CLI agents that can open files.
    void image;
    lines.push(renderPinContext(board, pin, image ? shotPath : pin.screenshotPath));
    lines.push("");
  }
  const messagePath = join(dir, "message.md");
  return { lines, messagePath };
}

async function writeLiveArtifacts(
  body: LiveMessageBody,
  board: Board,
  pins: Board["pins"],
  id: string,
): Promise<{ messagePath: string; promptText: string; dir: string }> {
  const dir = join(pinnablesHome(), "live", id);
  await mkdir(dir, { recursive: true });
  const screenshots = body.screenshots ?? {};

  for (const pin of pins) {
    const dataUrl = screenshots[pin.id];
    const image = dataUrl ? decodeDataUrl(dataUrl) : null;
    if (image) await writeFile(join(dir, `${pin.id}.png`), image);
  }

  const { lines, messagePath } = buildLiveMarkdown(body, board, pins, dir, screenshots);
  await writeFile(messagePath, `${lines.join("\n")}\n`, "utf8");

  /*
   * Cursor Cloud Agents cannot read ~/.pinnables on the user's machine, so the
   * prompt carries the full markdown inline. Screenshots travel separately as
   * prompt.images. Local CLI still gets a path-based prompt as a fallback.
   */
  const promptText =
    `${lines.join("\n")}\n\n` +
    `Implement the change described above in this project's source. ` +
    `Use the selector, source file, and captured styles — do not invent a different target.`;

  return { messagePath, promptText, dir };
}

async function startViaCursor(
  id: string,
  promptText: string,
  body: LiveMessageBody,
  board: Board,
): Promise<void> {
  const images = imagesFromScreenshots(body.screenshots ?? {}, body.pinIds);
  const result = await sendToCursor({
    text: promptText,
    images,
    name: `Pinnables · ${board.title || board.id}`,
  });
  liveMessages.set(id, {
    // The run exists; whether Cursor has started it is a separate question,
    // answered by the first status refresh.
    state: "starting",
    detail: null,
    transport: "cursor",
    agentId: result.agentId,
    runId: result.runId,
    url: result.url,
  });
  console.log(`live message ${id} → Cursor ${result.mode} ${result.agentId} / ${result.runId}`);
}

function startViaLocalSpawn(id: string, promptText: string, messagePath: string): void {
  const localPrompt =
    `Read ${messagePath} and implement the change it describes. ` +
    `The file carries the pinned component's selector, source file, captured styles ` +
    `and a screenshot path. Make the change in this project's source.`;

  /*
   * PINNABLES_AGENT_CMD overrides the whole invocation (run through a shell,
   * with $PINNABLES_PROMPT and $PINNABLES_MESSAGE set). The default is the
   * Claude Code CLI in print mode, editing files without prompting.
   */
  const custom = process.env.PINNABLES_AGENT_CMD;
  const cwd = process.env.PINNABLES_PROJECT_DIR ?? process.cwd();
  /*
   * Piped rather than ignored so the run can say when it has actually begun.
   * A spawned process is not a working agent — it is a process that has yet to
   * read its prompt. The first byte it emits is the earliest honest evidence
   * that the agent is doing the work, so that is what promotes the run from
   * "starting" to "working". The output itself is drained and dropped; only
   * its existence is information here.
   */
  const stdio: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];
  const child = custom
    ? spawn(custom, {
        cwd,
        shell: true,
        stdio,
        env: {
          ...process.env,
          PINNABLES_PROMPT: localPrompt,
          PINNABLES_MESSAGE: messagePath,
        },
      })
    : spawn("claude", ["-p", localPrompt, "--permission-mode", "acceptEdits"], {
        cwd,
        stdio,
      });

  liveMessages.set(id, { state: "starting", detail: null, transport: "local" });
  const markWorking = (): void => {
    if (liveMessages.get(id)?.state !== "starting") return;
    liveMessages.set(id, { state: "working", detail: null, transport: "local" });
  };
  child.stdout?.on("data", markWorking);
  child.stderr?.on("data", markWorking);
  child.on("error", (err) => {
    liveMessages.set(id, {
      state: "failed",
      detail: `Could not start the agent: ${err.message}`,
      transport: "local",
    });
  });
  child.on("exit", (code) => {
    if (liveMessages.get(id)?.state === "failed") return;
    liveMessages.set(
      id,
      code === 0
        ? { state: "done", detail: null, transport: "local" }
        : {
            state: "failed",
            detail: `Agent exited with code ${code ?? "unknown"}`,
            transport: "local",
          },
    );
  });
  console.log(`live message ${id} → local spawn ${messagePath}`);
  void promptText;
}

async function startLiveMessage(body: LiveMessageBody): Promise<string> {
  const board = BoardSchema.parse(body.board);
  const pins = body.pinIds
    .map((pinId) => board.pins.find((pin) => pin.id === pinId))
    .filter((pin): pin is Board["pins"][number] => pin !== undefined);
  if (pins.length === 0) throw new Error("No pins found for this message");

  liveCounter += 1;
  const id = `msg-${Date.now().toString(36)}${liveCounter.toString(36)}`;
  const { messagePath, promptText } = await writeLiveArtifacts(body, board, pins, id);

  liveMessages.set(id, { state: "starting", detail: null });

  if (cursorConfigured()) {
    try {
      await startViaCursor(id, promptText, body, board);
      return id;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`Cursor send failed for ${id}, falling back to local:`, detail);
      // If the user configured Cursor, a silent local fallback is confusing —
      // only fall back when explicitly allowed.
      if (process.env.PINNABLES_CURSOR_FALLBACK_LOCAL === "1") {
        startViaLocalSpawn(id, promptText, messagePath);
        return id;
      }
      liveMessages.set(id, {
        state: "failed",
        detail,
        transport: "cursor",
      });
      throw err;
    }
  }

  startViaLocalSpawn(id, promptText, messagePath);
  return id;
}

async function refreshMessageStatus(id: string): Promise<LiveMessage | null> {
  const found = liveMessages.get(id);
  if (!found) return null;
  if (found.transport !== "cursor" || !found.agentId || !found.runId) return found;
  if (found.state !== "working" && found.state !== "starting") return found;

  try {
    const status: CursorStatus = await statusFromCursor(found.agentId, found.runId);
    const next: LiveMessage = {
      ...found,
      state: status.state,
      detail: status.detail,
      url: status.url ?? found.url,
    };
    liveMessages.set(id, next);
    return next;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const next: LiveMessage = { ...found, state: "failed", detail };
    liveMessages.set(id, next);
    return next;
  }
}

/* --------------------------------------------------------------- board push */

interface PushBoardBody {
  board: unknown;
  screenshots?: Record<string, string>;
}

/**
 * Full-board handoff without clipboard. Materialize to disk (MCP / files still
 * work) and create or follow up a Cursor agent with the brief inlined.
 */
async function pushBoard(body: PushBoardBody): Promise<{
  messageId: string;
  boardDir: string;
  agentId?: string;
  runId?: string;
  url?: string;
  pointer: string;
  transport: "cursor" | "clipboard";
}> {
  const board = BoardSchema.parse(body.board);
  const screenshots = body.screenshots ?? {};
  const dir = await materialize(board, screenshots);
  const pointer = `Load Pinnables board "${board.id}" and implement it.`;

  if (!cursorConfigured()) {
    return { messageId: "", boardDir: dir, pointer, transport: "clipboard" };
  }

  const brief = renderBoardManifest(board);
  const pinBlocks = board.pins
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((pin) => renderPinContext(board, pin, join(dir, "pins", `${pin.id}.png`)))
    .join("\n\n");

  const promptText =
    `Implement this Pinnables annotation board.\n\n` +
    `${brief}\n\n` +
    `---\n\n` +
    `## Full pin context\n\n` +
    `${pinBlocks}\n\n` +
    `Work from the relationships and requested values. Do not ask for the board id — ` +
    `everything you need is above. Prefer editing the named source files.`;

  const images = imagesFromScreenshots(
    screenshots,
    board.pins.map((p) => p.id),
  );

  liveCounter += 1;
  const id = `msg-${Date.now().toString(36)}${liveCounter.toString(36)}`;
  const result = await sendToCursor({
    text: promptText,
    images,
    name: `Pinnables · ${board.title || board.id}`,
  });
  liveMessages.set(id, {
    state: "working",
    detail: null,
    transport: "cursor",
    agentId: result.agentId,
    runId: result.runId,
    url: result.url,
  });

  return {
    messageId: id,
    boardDir: dir,
    agentId: result.agentId,
    runId: result.runId,
    url: result.url,
    pointer,
    transport: "cursor",
  };
}

const server = createServer((req, res) => {
  void (async () => {
    if (req.method === "OPTIONS") return send(res, 204, {});

    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

    if (req.method === "GET" && url.pathname === "/health") {
      const cursor = cursorConfigured()
        ? await probeCursor()
        : { ok: false, detail: "CURSOR_API_KEY not set" };
      return send(res, 200, {
        ok: true,
        home: pinnablesHome(),
        cursor: {
          configured: cursorConfigured(),
          ok: cursor.ok,
          detail: cursor.detail,
        },
      });
    }

    if (req.method === "POST" && url.pathname === "/messages") {
      try {
        const body = (await readBody(req)) as LiveMessageBody;
        const messageId = await startLiveMessage(body);
        const status = liveMessages.get(messageId);
        return send(res, 200, {
          messageId,
          transport: status?.transport ?? null,
          url: status?.url ?? null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("live message failed:", message);
        return send(res, 400, { error: message });
      }
    }

    const liveMatch = /^\/messages\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && liveMatch) {
      const found = await refreshMessageStatus(liveMatch[1]);
      if (!found) return send(res, 404, { error: "Unknown message" });
      return send(res, 200, found);
    }

    const match = /^\/boards\/([^/]+)\/materialize$/.exec(url.pathname);
    if (req.method === "POST" && match) {
      try {
        const body = (await readBody(req)) as {
          board: unknown;
          screenshots?: Record<string, string>;
        };
        const board = BoardSchema.parse(body.board);
        const dir = await materialize(board, body.screenshots ?? {});
        console.log(`materialized "${board.id}" — ${board.pins.length} pins → ${dir}`);
        return send(res, 200, {
          pointer: `Load Pinnables board "${board.id}" and implement it.`,
          boardDir: dir,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("materialize failed:", message);
        return send(res, 400, { error: message });
      }
    }

    const pushMatch = /^\/boards\/([^/]+)\/push$/.exec(url.pathname);
    if (req.method === "POST" && pushMatch) {
      try {
        const body = (await readBody(req)) as PushBoardBody;
        const result = await pushBoard(body);
        console.log(
          `pushed board → ${result.transport}` +
            (result.agentId ? ` agent ${result.agentId}` : ""),
        );
        return send(res, 200, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("board push failed:", message);
        return send(res, 400, { error: message });
      }
    }

    send(res, 404, { error: "Not found" });
  })();
});

server.listen(PORT, HOST, () => {
  console.log(`pinnables service on http://${HOST}:${PORT}`);
  console.log(`boards → ${pinnablesHome()}`);
  console.log(
    cursorConfigured()
      ? "Cursor Cloud Agents: configured (Send will push)"
      : "Cursor Cloud Agents: set CURSOR_API_KEY to enable one-click Send",
  );
});
