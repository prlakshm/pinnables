#!/usr/bin/env node
/**
 * Register a localhost project with Pinnables and print MCP config for Cursor.
 *
 * Usage:
 *   npx tsx scripts/init-project.mts flowers-website http://localhost:5181 /path/to/flowers-repo
 */
import { resolve } from "node:path";
import { writeProject, pinnablesHome } from "../packages/shared/src/storage.js";

const [id, origin, repoPathArg] = process.argv.slice(2);

if (!id || !origin) {
  console.error(
    "Usage: npx tsx scripts/init-project.mts <project-id> <origin> [repository-path]\n\n" +
      "Example:\n" +
      "  npx tsx scripts/init-project.mts flowers-website http://localhost:5181 ~/dev/flowers",
  );
  process.exit(1);
}

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const repositoryPath = repoPathArg ? resolve(repoPathArg) : null;
const now = new Date().toISOString();

const name = id
  .split("-")
  .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
  .join(" ");

await writeProject({
  id,
  name,
  origins: [origin.replace(/\/$/, "")],
  repositoryPath,
  createdAt: now,
  lastOpenedAt: now,
});

const mcpServerPath = resolve(repoRoot, "packages/mcp-server/dist/index.js");

console.log(`Registered project "${id}" at ${pinnablesHome()}/projects/${id}.json`);
console.log(`  Origin: ${origin}`);
if (repositoryPath) console.log(`  Repo:   ${repositoryPath}`);
console.log();

console.log("Add this to your flowers project's .cursor/mcp.json:\n");
console.log(
  JSON.stringify(
    {
      mcpServers: {
        pinnables: {
          command: "node",
          args: [mcpServerPath],
        },
      },
    },
    null,
    2,
  ),
);
console.log();

console.log("Next steps:");
console.log("  1. Run `npm run build` in the pinnables repo (if you have not already).");
console.log("  2. Start your flowers site: npm run dev  (port 5181)");
console.log("  3. Open http://localhost:5181 in Chrome.");
console.log();
console.log(
  "Note: The Pinnables Chrome extension (element picker + pin capture) is not built yet.",
);
console.log(
  "Until it ships, boards must be created manually under ~/.pinnables/boards/<board-id>/.",
);
console.log(
  "Once you have a board, tell Cursor: Load Pinnables board \"<board-id>\" and implement it.",
);
