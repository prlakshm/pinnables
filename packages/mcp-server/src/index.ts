#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PinStatusSchema, renderBoardManifest, renderPinContext } from "@pinnables/shared";
import {
  pinnablesHome,
  readAllBoards,
  readBoard,
  resolveAsset,
  writeBoard,
} from "@pinnables/shared/storage";

const server = new McpServer({ name: "pinnables", version: "0.1.0" });

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

function failure(body: string) {
  return { content: [{ type: "text" as const, text: body }], isError: true };
}

server.registerTool(
  "list_boards",
  {
    title: "List annotation boards",
    description:
      "List every Pinnables annotation board. Start here when the user mentions a board by " +
      "name, or asks you to implement pinned UI feedback. Returns board ids, titles, pin " +
      "counts, and status — call get_board next for the actual contents.",
    inputSchema: {},
  },
  async () => {
    const boards = await readAllBoards();
    if (boards.length === 0) {
      return text(
        `No boards found in ${pinnablesHome()}.\n\n` +
          `Create one in the Pinnables side panel and press "Ready for agent", or set ` +
          `PINNABLES_HOME to point at a different board directory.`,
      );
    }
    const rows = boards.map((b) => {
      const routes = new Set(b.pins.map((p) => p.route)).size;
      const open = b.pins.filter((p) => p.status === "todo").length;
      return (
        `- \`${b.id}\` — ${b.title}\n` +
        `  ${b.pins.length} pins across ${routes} routes · ${b.relationships.length} relationships · ` +
        `${open} open · status: ${b.status}`
      );
    });
    return text(`${boards.length} board(s):\n\n${rows.join("\n")}`);
  },
);

server.registerTool(
  "get_board",
  {
    title: "Get board contents",
    description:
      "Get the full annotation board: every pin with its route, source file, and instruction, " +
      "plus all relationships between pins with computed before/after style diffs. This is the " +
      "complete work order — read it first and work from it. Only call get_pin_context for a " +
      "pin whose exact markup or full style set you actually need.",
    inputSchema: {
      boardId: z.string().describe("Board id from list_boards"),
    },
  },
  async ({ boardId }) => {
    const board = await readBoard(boardId);
    if (!board) return failure(`No board with id "${boardId}". Call list_boards to see what exists.`);
    return text(renderBoardManifest(board));
  },
);

server.registerTool(
  "get_pin_context",
  {
    title: "Get full context for one pin",
    description:
      "Full detail for a single pin: complete captured styles, the element's markup, CSS " +
      "selector, DOM path, and an absolute path to its screenshot (read it with your own file " +
      "tools if you need to see it). Call this only for pins you are about to edit — get_board " +
      "already carries the instruction and source file for every pin.",
    inputSchema: {
      boardId: z.string().describe("Board id from list_boards"),
      pinId: z.string().describe("Pin id from get_board"),
    },
  },
  async ({ boardId, pinId }) => {
    const board = await readBoard(boardId);
    if (!board) return failure(`No board with id "${boardId}".`);
    const pin = board.pins.find((p) => p.id === pinId);
    if (!pin) {
      const known = board.pins.map((p) => p.id).join(", ");
      return failure(`No pin "${pinId}" on board "${boardId}". Pins on this board: ${known}`);
    }
    // Absolute, so the agent can open it with its own file tools rather than
    // us inlining base64 into the tool result.
    return text(renderPinContext(board, pin, resolveAsset(board.id, pin.screenshotPath)));
  },
);

server.registerTool(
  "set_pin_status",
  {
    title: "Set pin status",
    description:
      "Update a pin's status after acting on it. Use 'done' when the change is implemented, " +
      "'blocked' when you could not complete it — put the reason in `note`. The user sees this " +
      "in the Pinnables side panel, so it is how you report back on a board.",
    inputSchema: {
      boardId: z.string().describe("Board id from list_boards"),
      pinId: z.string().describe("Pin id from get_board"),
      status: PinStatusSchema.describe("todo, done, or blocked"),
      note: z.string().optional().describe("Why — required in practice when marking blocked"),
    },
  },
  async ({ boardId, pinId, status, note }) => {
    const board = await readBoard(boardId);
    if (!board) return failure(`No board with id "${boardId}".`);
    const pin = board.pins.find((p) => p.id === pinId);
    if (!pin) return failure(`No pin "${pinId}" on board "${boardId}".`);

    pin.status = status;
    pin.updatedAt = new Date().toISOString();
    if (note?.trim()) pin.annotation = `${pin.annotation}\n\n[agent] ${note.trim()}`;

    const open = board.pins.filter((p) => p.status === "todo").length;
    board.status = open === 0 ? "done" : "in-progress";
    board.updatedAt = pin.updatedAt;
    await writeBoard(board);

    return text(
      `${pinId} → ${status}. ${open} pin(s) still open on "${board.title}".` +
        (open === 0 ? " Board complete." : ""),
    );
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
