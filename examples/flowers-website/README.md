# Bloom & Petal — Flowers Website

Example flowers shop wired for Pinnables on **http://localhost:5181**.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5181 in Chrome.

## Pinnables

Open the **pinnables repo root** in Cursor (not this subfolder) so `.cursor/mcp.json` resolves the
MCP server. Build from the repo root first:

```bash
cd ../.. && npm install && npm run build
```

Then start this site:

```bash
npm run dev:flowers   # from repo root
# or: npm run dev     # from this folder
```

In Cursor:

> Load Pinnables board "flowers-website" and implement it.

**Note:** The Chrome extension for pinning elements is not built yet. Boards live under
`~/.pinnables/boards/` until the extension ships.
