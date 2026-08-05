#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BoardSchema, renderBoardManifest, renderPinContext, type Board } from "@pinnables/shared";
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

const server = createServer((req, res) => {
  void (async () => {
    if (req.method === "OPTIONS") return send(res, 204, {});

    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true, home: pinnablesHome() });
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
