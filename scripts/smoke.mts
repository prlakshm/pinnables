import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/* Derived, not hardcoded: this script lives in <root>/scripts, and a checkout
   anywhere but its author's machine must still be able to run it. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const home = await mkdtemp(join(tmpdir(), "pinnables-smoke-"));
await cp(join(ROOT, "fixtures"), home, { recursive: true });

const transport = new StdioClientTransport({
  command: "node",
  args: [join(ROOT, "packages/mcp-server/dist/index.js")],
  env: { ...process.env, PINNABLES_HOME: home } as Record<string, string>,
});

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const body = (res.content as Array<{ type: string; text?: string }>)
    .map((c) => c.text ?? "")
    .join("\n");
  console.log(`\n===== ${name}(${JSON.stringify(args)}) ${res.isError ? "[ERROR]" : ""}\n${body}`);
  return body;
}

await call("list_boards");
const manifest = await call("get_board", { boardId: "dashboard-cards" });
await call("get_pin_context", { boardId: "dashboard-cards", pinId: "pin-01" });
await call("set_pin_status", {
  boardId: "dashboard-cards",
  pinId: "pin-01",
  status: "done",
  note: "Applied radius/padding/shadow from SettingsCard.",
});
await call("get_board", { boardId: "dashboard-cards" });
await call("get_pin_context", { boardId: "dashboard-cards", pinId: "nope" });

console.log(`\n===== manifest size: ${manifest.length} chars ≈ ${Math.round(manifest.length / 4)} tokens`);

await client.close();
