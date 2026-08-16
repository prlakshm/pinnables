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
  cursorRuntime,
  imagesFromScreenshots,
  isAgentBusyError,
  cursorStatusSnapshot,
  projectDir,
  readStickyAgentId,
  shouldAttachScreenshots,
  sendToCursor,
  statusFromCursor,
  type CursorStatus,
} from "./cursor.js";
import {
  listVersions,
  readChapterBaseline,
  refreshVersionsHealth,
  restore as restoreVersion,
  snapshot as snapshotVersion,
  versionsHealthSnapshot,
} from "./versions.js";

/**
 * The local companion. Extensions can't write to arbitrary filesystem paths, so
 * this is what turns a board into files an agent can read — and it writes the
 * same board.json the MCP server reads, so neither path is redundant.
 *
 * Bound to 127.0.0.1 only. Nothing here should ever be reachable off-machine.
 *
 * Send path (least friction first):
 *   1. Cursor local agent (default) when CURSOR_API_KEY is set — edits
 *      PINNABLES_PROJECT_DIR / the git repo root so the running app hot-reloads.
 *   2. Cursor Cloud Agents when PINNABLES_CURSOR_RUNTIME=cloud.
 *   3. Local spawn via PINNABLES_AGENT_CMD / `claude` as a fallback.
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
  state: "queued" | "starting" | "working" | "done" | "failed";
  detail: string | null;
  transport?: "cursor" | "local";
  agentId?: string;
  runId?: string;
  url?: string;
  /**
   * Which board this run belongs to, kept so completion can snapshot the
   * working tree without anyone asking. The extension may be closed when a
   * run lands; the version must exist anyway.
   */
  boardId?: string;
}

interface QueuedCursorSend {
  id: string;
  promptText: string;
  body: LiveMessageBody;
  board: Board;
}

/**
 * Each live send becomes one agent run. Cursor Cloud Agents are preferred when
 * configured; otherwise we spawn a local CLI. Status is polled from this map —
 * for Cursor runs we refresh from the API on each status GET.
 *
 * Cursor allows one active run per agent. Further Sends enqueue here and
 * drain when the active run finishes (status poll + background ticker).
 */
const liveMessages = new Map<string, LiveMessage>();
const cursorSendQueue: QueuedCursorSend[] = [];
let liveCounter = 0;
let queueDraining = false;
/** Last Cloud Agent URL we handed back — shown in /health for the panel. */
let lastAgentUrl: string | null = null;

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
  const extra = drawingRegionPinIds(body, board)
    .map((id) => board.pins.find((pin) => pin.id === id))
    .filter(
      (pin): pin is Board["pins"][number] =>
        pin !== undefined && !pins.some((existing) => existing.id === pin.id),
    );
  const allPins = [...pins, ...extra];

  for (const pin of allPins) {
    const dataUrl = screenshots[pin.id];
    const image = dataUrl ? decodeDataUrl(dataUrl) : null;
    if (image) await writeFile(join(dir, `${pin.id}.png`), image);
  }

  const { lines, messagePath } = buildLiveMarkdown(body, board, allPins, dir, screenshots);
  await writeFile(messagePath, `${lines.join("\n")}\n`, "utf8");

  /*
   * Cursor Cloud Agents cannot read ~/.pinnables on the user's machine, so the
   * prompt carries the full markdown inline. Screenshots travel separately as
   * prompt.images. Local CLI still gets a path-based prompt as a fallback.
   */
  const drawingHint = messageHasDrawings(body, board)
    ? `The attached screenshot shows the pen marks — treat those marks as the specification. `
    : "";
  const promptText =
    `${lines.join("\n")}\n\n` +
    drawingHint +
    `Open the named source file and apply this change now. ` +
    `Use the selector, source file, and captured styles — do not invent a different target. ` +
    `Do not search the rest of the repo. Do not run tests, git, or the app. ` +
    `Do not commit. Stop as soon as the edit is in the file.`;

  return { messagePath, promptText, dir };
}

/** Pen marks live on the route's region pin; the element crop does not show them. */
function drawingRegionPinIds(body: LiveMessageBody, board: Board): string[] {
  return board.pins
    .filter(
      (pin) =>
        pin.kind === "region" &&
        pin.drawings.length > 0 &&
        (body.pinIds.includes(pin.id) ||
          pin.drawings.some(
            (shape) => shape.ownerPinId !== null && body.pinIds.includes(shape.ownerPinId),
          )),
    )
    .map((pin) => pin.id);
}

function messageHasDrawings(body: LiveMessageBody, board: Board): boolean {
  if (body.drawingSummary?.trim()) return true;
  return drawingRegionPinIds(body, board).length > 0;
}

function imagePinIds(body: LiveMessageBody, board: Board): string[] {
  const ids = [...body.pinIds];
  for (const id of drawingRegionPinIds(body, board)) {
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

async function startViaCursor(
  id: string,
  promptText: string,
  body: LiveMessageBody,
  board: Board,
): Promise<void> {
  const images = shouldAttachScreenshots(messageHasDrawings(body, board))
    ? imagesFromScreenshots(body.screenshots ?? {}, imagePinIds(body, board))
    : [];
  const result = await sendToCursor({
    text: promptText,
    images,
    name: `Pinnables · ${board.title || board.id}`,
  });
  lastAgentUrl = result.url;
  /* Spread, never replace: the record carries boardId, and completion needs
     it to snapshot. */
  liveMessages.set(id, {
    ...liveMessages.get(id),
    // The run exists; whether Cursor has started it is a separate question,
    // answered by the first status refresh.
    state: "starting",
    detail: null,
    transport: "cursor",
    agentId: result.agentId,
    runId: result.runId,
    url: result.url ?? undefined,
  });
  console.log(
    `live message ${id} → Cursor ${result.runtime} ${result.mode} ${result.agentId} / ${result.runId}` +
      (result.cwd ? ` @ ${result.cwd}` : ""),
  );
}

function activeCursorRun(): LiveMessage | undefined {
  for (const msg of liveMessages.values()) {
    if (
      msg.transport === "cursor" &&
      (msg.state === "starting" || msg.state === "working") &&
      msg.runId
    ) {
      return msg;
    }
  }
  return undefined;
}

function shouldQueueCursorSend(): boolean {
  return Boolean(activeCursorRun()) || cursorSendQueue.length > 0 || queueDraining;
}

function markQueued(id: string, position: number, hint?: LiveMessage): void {
  liveMessages.set(id, {
    state: "queued",
    detail:
      position <= 1
        ? "Queued — waiting for the current Cursor run to finish"
        : `Queued — ${position} sends ahead`,
    transport: "cursor",
    agentId: hint?.agentId,
    url: hint?.url ?? lastAgentUrl ?? undefined,
  });
}

function enqueueCursorSend(item: QueuedCursorSend): void {
  cursorSendQueue.push(item);
  markQueued(item.id, cursorSendQueue.length, activeCursorRun());
  console.log(`live message ${item.id} → queued (#${cursorSendQueue.length})`);
}

async function drainCursorQueue(): Promise<void> {
  if (queueDraining) return;
  queueDraining = true;
  try {
    while (cursorSendQueue.length > 0) {
      if (activeCursorRun()) break;
      const next = cursorSendQueue.shift()!;
      try {
        await startViaCursor(next.id, next.promptText, next.body, next.board);
      } catch (err) {
        if (isAgentBusyError(err)) {
          // Race with Cursor — put it back at the front and wait for a tick.
          cursorSendQueue.unshift(next);
          markQueued(next.id, 1, activeCursorRun());
          console.log(`live message ${next.id} → still busy, keeping queued`);
          break;
        }
        const detail = err instanceof Error ? err.message : String(err);
        console.error(`queued send ${next.id} failed:`, detail);
        liveMessages.set(next.id, {
          state: "failed",
          detail,
          transport: "cursor",
        });
      }
    }
  } finally {
    queueDraining = false;
  }
}

/**
 * Refresh every in-flight Cursor run from the API, then try to start the next
 * queued send. Driven by status GETs and a background ticker so the queue
 * drains even when nothing is polling a finished message.
 */
async function refreshActiveCursorRuns(): Promise<void> {
  const ids = [...liveMessages.entries()]
    .filter(
      ([, msg]) =>
        msg.transport === "cursor" &&
        (msg.state === "starting" || msg.state === "working") &&
        msg.agentId &&
        msg.runId,
    )
    .map(([id]) => id);
  for (const id of ids) {
    await refreshMessageStatus(id);
  }
  await drainCursorQueue();
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
  const cwd = projectDir();
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

  /* Spread, never replace: the record carries boardId from startLiveMessage,
     and completion needs it to snapshot. Replacing wholesale here silently
     dropped it, and every local run finished without its version. */
  liveMessages.set(id, { ...liveMessages.get(id), state: "starting", detail: null, transport: "local" });
  const markWorking = (): void => {
    const found = liveMessages.get(id);
    if (found?.state !== "starting") return;
    liveMessages.set(id, { ...found, state: "working", detail: null, transport: "local" });
  };
  child.stdout?.on("data", markWorking);
  child.stderr?.on("data", markWorking);
  child.on("error", (err) => {
    liveMessages.set(id, {
      ...liveMessages.get(id),
      state: "failed",
      detail: `Could not start the agent: ${err.message}`,
      transport: "local",
    });
  });
  child.on("exit", (code) => {
    const found = liveMessages.get(id);
    if (found?.state === "failed") return;
    if (code !== 0) {
      liveMessages.set(id, {
        ...found,
        state: "failed",
        detail: `Agent exited with code ${code ?? "unknown"}`,
        transport: "local",
      });
      return;
    }
    /*
     * Snapshot before "done" is visible. The extension mints the version key
     * the moment it sees done, and a key must never name a snapshot that is
     * still being written — so completion waits on the patch. A snapshot
     * failure (not a git tree) downgrades gracefully: the run is still done,
     * there is simply no way back to it, same as before versions existed.
     */
    void (async () => {
      const boardId = found?.boardId;
      if (boardId) {
        try {
          await snapshotVersion({ boardId, messageId: id, pinIds: [], baseline: false });
          console.log(`snapshot ${id} on completion`);
        } catch (err) {
          console.error(`snapshot ${id} failed:`, err instanceof Error ? err.message : err);
        }
      }
      liveMessages.set(id, { ...found, state: "done", detail: null, transport: "local" });
    })();
  });
  console.log(`live message ${id} → local spawn ${messagePath}`);
  void promptText;
}

/**
 * The tree as it stands before this chapter's first run touches it — version
 * 1, the original. Taken before a run starts because completion is too late:
 * by then the original is gone. Once per chapter (per HEAD); a commit opens
 * the next chapter and the next first run takes its baseline. A failure (no
 * git) only means the rail never appears, which /health already explains.
 */
async function ensureChapterBaseline(boardId: string): Promise<void> {
  try {
    if (!(await readChapterBaseline())) {
      const meta = await snapshotVersion({
        boardId,
        messageId: "baseline",
        pinIds: [],
        baseline: true,
      });
      console.log(`chapter baseline ${meta.messageId}`);
    }
  } catch {
    /* Not a git tree — versions are off and /health says so. */
  }
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

  await ensureChapterBaseline(board.id);

  liveMessages.set(id, { state: "starting", detail: null, boardId: board.id });

  if (cursorConfigured()) {
    const queuedItem: QueuedCursorSend = { id, promptText, body, board };
    if (shouldQueueCursorSend()) {
      enqueueCursorSend(queuedItem);
      return id;
    }
    try {
      await startViaCursor(id, promptText, body, board);
      return id;
    } catch (err) {
      if (isAgentBusyError(err)) {
        enqueueCursorSend(queuedItem);
        return id;
      }
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
  if (found.state === "queued") return found;
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
    /*
     * A local-runtime Cursor agent edits this working tree, so its completion
     * is snapshot the same way the local spawn's is — before "done" is
     * visible, because the extension mints the key on first sight of done.
     * (A cloud run edits a remote VM; snapshotting here would record nothing,
     * but it is harmless and keeps the two paths identical.)
     */
    /* found.state is starting|working here (guard above), so this fires once. */
    if (next.state === "done" && found.boardId) {
      try {
        await snapshotVersion({
          boardId: found.boardId,
          messageId: id,
          pinIds: [],
          baseline: false,
        });
        console.log(`snapshot ${id} on completion`);
      } catch (err) {
        console.error(`snapshot ${id} failed:`, err instanceof Error ? err.message : err);
      }
    }
    liveMessages.set(id, next);
    if (next.url) lastAgentUrl = next.url;
    if (next.state === "done" || next.state === "failed") {
      void drainCursorQueue();
    }
    return next;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const next: LiveMessage = { ...found, state: "failed", detail };
    liveMessages.set(id, next);
    void drainCursorQueue();
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
  state?: LiveMessage["state"];
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

  liveCounter += 1;
  const id = `msg-${Date.now().toString(36)}${liveCounter.toString(36)}`;
  /*
   * A board push is a run like any other: it gets the chapter baseline
   * before it starts and a record that knows its board, so completion can
   * snapshot and the pins it touched can mint the same key.
   */
  await ensureChapterBaseline(board.id);
  liveMessages.set(id, { state: "starting", detail: null, boardId: board.id });
  // Same shape as live messages so queue drain can call startViaCursor.
  const queueBody: LiveMessageBody = {
    text: promptText,
    board,
    pinIds: board.pins.map((p) => p.id),
    screenshots,
  };
  const queuedItem: QueuedCursorSend = {
    id,
    promptText,
    body: queueBody,
    board,
  };

  const finishFromLive = (): {
    messageId: string;
    boardDir: string;
    agentId?: string;
    runId?: string;
    url?: string;
    pointer: string;
    transport: "cursor";
    state?: LiveMessage["state"];
  } => {
    const status = liveMessages.get(id);
    return {
      messageId: id,
      boardDir: dir,
      agentId: status?.agentId,
      runId: status?.runId,
      url: status?.url ?? lastAgentUrl ?? undefined,
      pointer,
      transport: "cursor",
      state: status?.state,
    };
  };

  if (shouldQueueCursorSend()) {
    // startViaCursor expects LiveMessageBody.pinIds for images — already set.
    // Override send path: queue uses startViaCursor which re-reads screenshots.
    enqueueCursorSend(queuedItem);
    return finishFromLive();
  }

  try {
    // Prefer the same path as live messages so queue drain stays uniform.
    await startViaCursor(id, promptText, queueBody, board);
    return finishFromLive();
  } catch (err) {
    if (isAgentBusyError(err)) {
      enqueueCursorSend(queuedItem);
      return finishFromLive();
    }
    throw err;
  }
}

const server = createServer((req, res) => {
  void (async () => {
    if (req.method === "OPTIONS") return send(res, 204, {});

    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

    if (req.method === "GET" && url.pathname === "/health") {
      /* Served from the last real send or poll — /health itself never calls
         the Cursor API. The panel keys "set up" off `configured`; `ok` is
         best-effort connectivity that real traffic keeps honest. */
      const cursor = cursorStatusSnapshot();
      const stickyAgentId = cursorConfigured() ? await readStickyAgentId() : null;
      const agentUrl =
        cursor.runtime === "cloud"
          ? lastAgentUrl ??
            (stickyAgentId ? `https://cursor.com/agents/${stickyAgentId}` : null)
          : null;
      /* Versions need a git working tree. Reported so the extension can hide
         the rail rather than offer keys that would not work. The head is the
         chapter: everything stamped with an older one has been absorbed by a
         commit, and the extension quiets those keys and rows. Served from the
         last refresh rather than awaited — /health must stay inside the
         extension's abort budget — with a refresh kicked so a moved HEAD is
         at most one poll stale. */
      const versions = versionsHealthSnapshot();
      void refreshVersionsHealth().catch(() => {});
      return send(res, 200, {
        ok: true,
        home: pinnablesHome(),
        versions,
        cursor: {
          configured: cursorConfigured(),
          ok: cursor.ok,
          detail: cursor.detail,
          runtime: cursor.runtime,
          cwd: cursor.cwd,
          agentId: stickyAgentId,
          agentUrl,
          queueLength: cursorSendQueue.length,
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
          url: status?.url ?? lastAgentUrl ?? null,
          state: status?.state ?? null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("live message failed:", message);
        return send(res, 400, { error: message });
      }
    }

    const liveMatch = /^\/messages\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && liveMatch) {
      let found = await refreshMessageStatus(liveMatch[1]);
      if (!found) return send(res, 404, { error: "Unknown message" });
      /*
       * Always refresh siblings. A later send's poll used to skip this when
       * it was still working, so the first run could finish (files landed)
       * and stay Working forever because nothing asked after its own poll
       * was stolen.
       */
      await refreshActiveCursorRuns();
      found = liveMessages.get(liveMatch[1]) ?? found;
      return send(res, 200, found);
    }

    /*
     * Versions. Snapshot records the working tree as it stands; restore puts it
     * back. Both are scoped to a board because that is where the patches live.
     */
    const snapMatch = /^\/versions\/([^/]+)\/snapshot$/.exec(url.pathname);
    if (req.method === "POST" && snapMatch) {
      try {
        const body = (await readBody(req)) as {
          boardId: string;
          pinIds?: string[];
          baseline?: boolean;
        };
        const meta = await snapshotVersion({
          boardId: body.boardId,
          messageId: snapMatch[1],
          pinIds: body.pinIds ?? [],
          baseline: body.baseline,
        });
        console.log(`snapshot ${meta.messageId} — ${meta.files.length} files`);
        return send(res, 200, { ok: true, ...meta });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("snapshot failed:", message);
        return send(res, 400, { error: message });
      }
    }

    const restoreMatch = /^\/versions\/([^/]+)\/restore$/.exec(url.pathname);
    if (req.method === "POST" && restoreMatch) {
      try {
        const body = (await readBody(req)) as { boardId: string; fromMessageId?: string | null };
        const result = await restoreVersion({
          boardId: body.boardId,
          messageId: restoreMatch[1],
          fromMessageId: body.fromMessageId ?? null,
        });
        console.log(
          `restored ${restoreMatch[1]} — ${result.files.length} files` +
            (result.conflicts.length ? `, ${result.conflicts.length} overwritten` : ""),
        );
        return send(res, 200, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("restore failed:", message);
        return send(res, 400, { error: message });
      }
    }

    const listMatch = /^\/versions\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && listMatch) {
      try {
        /* Snapshots are project-scoped now; the path segment is history. */
        return send(res, 200, { versions: await listVersions() });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return send(res, 400, { error: message });
      }
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

/*
 * The first versions refresh happens before the port opens, so no request can
 * ever see the cache's cold-start placeholder: a git tree answers ok from the
 * first poll, and a non-git project never flashes a rail it would then take
 * back. refreshVersionsHealth swallows git failures into its result, so this
 * cannot reject.
 */
void refreshVersionsHealth().finally(() => {
  server.listen(PORT, HOST, () => {
    console.log(`pinnables service on http://${HOST}:${PORT}`);
  console.log(`boards → ${pinnablesHome()}`);
  if (cursorConfigured()) {
    const runtime = cursorRuntime();
    if (runtime === "local") {
      console.log(`Cursor local agent: edits ${projectDir()} (fast, no screenshot vision)`);
    } else {
      console.log("Cursor Cloud Agents: configured (Send will push to remote)");
    }
  } else {
    console.log("Cursor: set CURSOR_API_KEY to enable one-click Send");
  }
    // Keep the queue moving when the extension is not polling a finished run.
    if (cursorConfigured()) {
      setInterval(() => {
        void refreshActiveCursorRuns().catch((err) => {
          console.error(
            "queue tick failed:",
            err instanceof Error ? err.message : String(err),
          );
        });
      }, 2_500);
    }
  });
});
