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

/**
 * The local companion. Extensions can't write to arbitrary filesystem paths, so
 * this is what turns a board into files an agent can read — and it writes the
 * same board.json the MCP server reads, so neither path is redundant.
 *
 * Bound to 127.0.0.1 only. Nothing here should ever be reachable off-machine.
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
  state: "working" | "done" | "failed";
  detail: string | null;
}

/**
 * Spawn-per-message. Each live send becomes one headless agent run; the map is
 * in-memory because this service is a long-running process and a message's
 * lifetime is minutes. Every state transition here is observed from the child
 * process, never assumed — the extension's "agent is working" is only ever as
 * true as this map.
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

async function startLiveMessage(body: LiveMessageBody): Promise<string> {
  const board = BoardSchema.parse(body.board);
  const pins = body.pinIds
    .map((pinId) => board.pins.find((pin) => pin.id === pinId))
    .filter((pin): pin is Board["pins"][number] => pin !== undefined);
  if (pins.length === 0) throw new Error("No pins found for this message");

  liveCounter += 1;
  const id = `msg-${Date.now().toString(36)}${liveCounter.toString(36)}`;
  const dir = join(pinnablesHome(), "live", id);
  await mkdir(dir, { recursive: true });

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
    const dataUrl = body.screenshots?.[pin.id];
    const image = dataUrl ? decodeDataUrl(dataUrl) : null;
    if (image) await writeFile(shotPath, image);
    lines.push(renderPinContext(board, pin, image ? shotPath : pin.screenshotPath));
    lines.push("");
  }
  const messagePath = join(dir, "message.md");
  await writeFile(messagePath, `${lines.join("\n")}\n`, "utf8");

  const prompt =
    `Read ${messagePath} and implement the change it describes. ` +
    `The file carries the pinned component's selector, source file, captured styles ` +
    `and a screenshot path. Make the change in this project's source.`;

  /*
   * PINNABLES_AGENT_CMD overrides the whole invocation (run through a shell,
   * with $PINNABLES_PROMPT and $PINNABLES_MESSAGE set). The default is the
   * Claude Code CLI in print mode, editing files without prompting — the same
   * agent the MCP server serves, just launched per message.
   */
  const custom = process.env.PINNABLES_AGENT_CMD;
  const cwd = process.env.PINNABLES_PROJECT_DIR ?? process.cwd();
  const child = custom
    ? spawn(custom, {
        cwd,
        shell: true,
        stdio: "ignore",
        env: { ...process.env, PINNABLES_PROMPT: prompt, PINNABLES_MESSAGE: messagePath },
      })
    : spawn("claude", ["-p", prompt, "--permission-mode", "acceptEdits"], {
        cwd,
        stdio: "ignore",
      });

  liveMessages.set(id, { state: "working", detail: null });
  child.on("error", (err) => {
    liveMessages.set(id, {
      state: "failed",
      detail: `Could not start the agent: ${err.message}`,
    });
  });
  child.on("exit", (code) => {
    if (liveMessages.get(id)?.state === "failed") return;
    liveMessages.set(
      id,
      code === 0
        ? { state: "done", detail: null }
        : { state: "failed", detail: `Agent exited with code ${code ?? "unknown"}` },
    );
  });

  console.log(`live message ${id} → ${messagePath}`);
  return id;
}

const server = createServer((req, res) => {
  void (async () => {
    if (req.method === "OPTIONS") return send(res, 204, {});

    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true, home: pinnablesHome() });
    }

    if (req.method === "POST" && url.pathname === "/messages") {
      try {
        const body = (await readBody(req)) as LiveMessageBody;
        const messageId = await startLiveMessage(body);
        return send(res, 200, { messageId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("live message failed:", message);
        return send(res, 400, { error: message });
      }
    }

    const liveMatch = /^\/messages\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && liveMatch) {
      const found = liveMessages.get(liveMatch[1]);
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

    send(res, 404, { error: "Not found" });
  })();
});

server.listen(PORT, HOST, () => {
  console.log(`pinnables service on http://${HOST}:${PORT}`);
  console.log(`boards → ${pinnablesHome()}`);
});
