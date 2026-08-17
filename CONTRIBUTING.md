# Contributing

Bug reports and small fixes are welcome.

## Run it

```bash
npm install && npm run build
npm run dev:extension   # rebuilds as you edit
npm run dev:service     # the local service
```

**Gotcha:** `dev:service` runs the compiled output, not your source. After changing `packages/service`, run `npm run build` and restart it.

## Check your work

```bash
npm test
npm run build   # also lints and type checks
```

Both should pass before you open a PR. If you think a failing test is wrong, say so in the PR rather than deleting it. Most exist because something broke once.

## Where things live

| Folder | What |
|---|---|
| `packages/extension` | The Chrome extension |
| `packages/service` | Local service that drives the coding agent |
| `packages/mcp-server` | MCP server |
| `packages/shared` | Board schema, shared by the rest |
| `packages/vite-plugin` | Tags elements with their source file |
| `docs/internal` | Architecture and design notes |

## Pull requests

One change per PR. Say what broke, not just what you changed. Add a test if you fixed a bug.

Comments here explain **why**, not what. If a line looks odd it is usually load-bearing, and the comment says which bug it prevents. Please keep that going.

## Bugs

Open an issue with what you did, what happened, and what you expected. For a failed Send, include which agent you were running and anything the service printed.
