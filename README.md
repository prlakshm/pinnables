# Pinnables

Pinning cross-page annotations for AI coding agents.

Pin components across your product's routes, describe how they should relate, and hand your coding
agent one plan with the exact style diffs — instead of a list of independent tickets.

- [PDR.md](PDR.md) — product requirements
- [PDR-REVIEW.md](PDR-REVIEW.md) — critique of the spec, and why the decisions are what they are
- [HANDOFF-DESIGN.md](HANDOFF-DESIGN.md) — how the board reaches the agent

## Status

| Piece | State |
|---|---|
| MCP server (4 tools) | **working** |
| Board schema + storage | **working** |
| Style-diff computation | **working** |
| Chrome extension | not started |
| Dev plugin (source mapping) | not started |

The MCP server runs against fixture board data, so the agent handoff can be tested end to end before
the extension exists.

## Setup

```bash
npm install && npm run build
```

Smoke-test the server over a real stdio MCP session:

```bash
npx tsx scripts/smoke.mts
```

## Connect it to an agent

Point `PINNABLES_HOME` at the fixtures to try it before there's any captured data. Drop it once the
extension is writing to `~/.pinnables`.

**Claude Code** — `.mcp.json` at the project root:

```json
{
  "mcpServers": {
    "pinnables": {
      "command": "node",
      "args": ["/absolute/path/to/pinnables/packages/mcp-server/dist/index.js"],
      "env": { "PINNABLES_HOME": "/absolute/path/to/pinnables/fixtures" }
    }
  }
}
```

**Cursor** — same shape in `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global).

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.pinnables]
command = "node"
args = ["/absolute/path/to/pinnables/packages/mcp-server/dist/index.js"]
env = { PINNABLES_HOME = "/absolute/path/to/pinnables/fixtures" }
```

Then, in the agent:

> Load Pinnables board "dashboard-cards" and implement it.

## Tools

Four, deliberately. Cursor caps how many tools it forwards to the model across all installed servers,
and more tools measurably degrades tool selection.

| Tool | Purpose |
|---|---|
| `list_boards` | Entry point — ids, titles, pin counts, status |
| `get_board` | The whole work order: pins with routes, source files, instructions, plus relationships with computed before → after style diffs |
| `get_pin_context` | Full detail for one pin — complete styles, markup, DOM path, absolute screenshot path |
| `set_pin_status` | Write-back, so resolution closes the loop |

`get_board` is manifest-first: a 5-pin board renders in ~525 tokens, so a 20-pin board lands near 2k
and the agent can hold the whole thing while it works. Screenshots are returned as **paths**, never
base64 — the agent reads them with its own file tools only if it needs to look, which also sidesteps
MCP image-support gaps in some clients.

## The interesting part

A relationship stores one source pin, N targets, a property list, and a natural-language exception.
Because the board holds the captured styles for both sides, the diff is computed rather than
described:

```
### rel-01 — match
source `pin-02` SettingsCard `src/components/SettingsCard.tsx:8`
target `pin-01` StatCard `src/components/StatCard.tsx:12`
  padding        32px 24px  →  16px 20px
  border-radius  4px  →  12px
  box-shadow     rgba(0,0,0,0.06) 0px 1px 2px  →  rgba(0,0,0,0.08) 0px 4px 12px
except: Preserve each card's own heading and content hierarchy.
```

"Make this card match that one" is something an agent has to interpret. Three concrete value changes
plus one constraint is something it can apply.

## Layout

```
packages/shared/      schema, style allowlist + diff, storage, markdown rendering
packages/mcp-server/  the four tools over stdio
fixtures/             a sample board — 5 pins, 4 routes, 1 relationship
scripts/smoke.mts     drives the server over a real MCP client session
```
