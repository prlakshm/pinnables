# Contributing

Thanks for taking a look. Bug reports and small fixes are always welcome.

## Get it running

You need Node 20 or newer.

```bash
git clone https://github.com/prlakshm/pinnables.git
cd pinnables
npm install
npm run build
```

Then start the two pieces you need:

```bash
npm run dev:extension   # rebuilds the extension as you edit
npm run dev:service     # the local companion on 127.0.0.1:4573
```

Load `packages/extension/dist` at `chrome://extensions` with developer mode on.

**One gotcha:** `dev:service` runs the compiled output, not your source. After changing anything under `packages/service`, run `npm run build` and restart it, or your edit won't take effect.

## Check your work

```bash
npm test    # the whole suite
npm run build   # also runs the linter and type checks
```

Both should pass before you open a pull request. If a test fails and you think the test is wrong, say so in the PR rather than deleting it. Most of them exist because something broke once.

## What lives where

| Folder | What it is |
|---|---|
| `packages/extension` | The Chrome extension: side panel, overlay, capture |
| `packages/service` | Local service that writes boards to disk and drives the coding agent |
| `packages/mcp-server` | MCP server, so an agent can pull boards itself |
| `packages/shared` | Board schema and rendering shared by the others |
| `packages/vite-plugin` | Build-time plugin that tags elements with their source file |
| `docs/internal` | Design and architecture notes, kept public so decisions are traceable |

## Opening a pull request

- One change per PR. Small is easier to review than complete.
- Say what broke or what you wanted, not just what you changed.
- Add a test if you fixed a bug, so it stays fixed.

## A note on style

Comments here explain **why**, not what. If a line looks odd, it is usually load-bearing and the comment says which bug it prevents. Please keep that going, and feel free to ask if a comment does not explain enough.

## Reporting a bug

Open an issue with what you did, what happened, and what you expected. If it involves a Send, include which agent you were running (Cursor, Claude Code, or Codex) and anything the service printed in its terminal.
