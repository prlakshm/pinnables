# Pinnables

**Point at things in your running app and tell your coding agent what to change.**

Click a component on your own site, describe the change in plain words, and Cursor, Claude Code, or Codex makes it. Edits land in your real source files, so your dev server hot-reloads and you watch it happen.

What makes it different: you can pin components **across different pages** and describe how they relate. "These three cards should match" is one instruction, not three tickets.

## See it work

Pin something, describe the change, watch it land:

https://github.com/prlakshm/pinnables/raw/main/demos/public/01-overview.mp4

Relating components that live on different pages:

https://github.com/prlakshm/pinnables/raw/main/demos/public/02-cross-page-relationships.mp4

Version keys, for flipping between what the agent tried:

https://github.com/prlakshm/pinnables/raw/main/demos/public/03-version-rail.mp4

## Install

Needs [Node](https://nodejs.org) 20+ and Chrome.

```bash
git clone https://github.com/prlakshm/pinnables.git
cd pinnables
npm install && npm run build
```

At `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick `packages/extension/dist`.

Then start the service, pointed at the app you want to edit:

```bash
PINNABLES_PROJECT_DIR=/path/to/your-app npm run dev:service
```

It runs on `127.0.0.1:4573`. Everything stays on your machine except the prompt going to your agent.

## Use it

Open your app, click the **Pinnables** toolbar icon, and press **Capture**. Hovering now highlights components instead of clicking through.

**1. Pin something.** Click a component. A box opens with a text field.

| Type | Press | Result |
|---|---|---|
| A change | **Enter** | Sent to your agent now |
| A change | **⌘↵** | Saved to the board for later |
| Nothing | **⌘↵** | Keeps the pin, so you can come back to it |

So `Enter` means "do this" and `⌘↵` means "remember this".

**2. Pin across pages.** Switch to **Browse the page** in the toolbar, navigate anywhere, and pin again. Earlier pins stay on the board. **Shift-click** several to write one message for all of them.

**3. Draw, if words aren't enough.** The pencil mode sketches directly on the page, and the drawing goes to the agent with the pin.

**4. Send.** Press **Send to agent**. The panel holds on *Sending…* until the agent actually starts. If a send is already running, the next one queues automatically.

**5. Undo or compare.** Every finished send is saved. Press **⌥1**, **⌥2** and so on to flip between what the agent tried, or back to how it was. Versions reset when you commit.

## Connect an agent

Pick with the command you start the service with. Nothing else changes.

```bash
npm run dev:service          # Cursor (default)
npm run dev:service:claude   # Claude Code
npm run dev:service:codex    # Codex
```

| Agent | What it needs |
|---|---|
| **Cursor** | `CURSOR_API_KEY` from [Cursor → Integrations](https://cursor.com/dashboard/integrations) |
| **Claude Code** | The `claude` CLI, signed in with `claude login` |
| **Codex** | The `codex` CLI, signed in with `codex login` |

If the CLI already works in your terminal, Pinnables works. All three edit files locally, so your dev server hot-reloads either way, and follow-up sends continue the same conversation.

| Variable | What it does |
|---|---|
| `PINNABLES_PROJECT_DIR` | The repo to edit. Required unless you start the service from inside it |
| `PINNABLES_MODEL` | Model for whichever agent is running. Optional |
| `PINNABLES_SEND_IMAGES=1` | Always attach screenshots. Automatic when you use the draw tool |
| `PINNABLES_CLAUDE_PATH` · `PINNABLES_CODEX_PATH` | Where the CLI lives, if it isn't on the service's PATH |

## Help pins find the right file

Add the Vite plugin to the app you're editing. Without it a pin knows which component you clicked but not which file it lives in, so the agent has to guess.

```js
// vite.config.js
import { pinnables } from "@pinnables/vite-plugin";

export default { plugins: [pinnables(), react()] };
```

Dev only by default, since it publishes your file layout to anyone with an inspector.

## Let the agent read boards itself (optional)

Adds an MCP server with four tools, so your agent can pull a board and mark pins done instead of only receiving them. In `.mcp.json` for Claude Code, `.cursor/mcp.json` for Cursor, or `~/.codex/config.toml` for Codex:

```json
{
  "mcpServers": {
    "pinnables": {
      "command": "node",
      "args": ["/absolute/path/to/pinnables/packages/mcp-server/dist/index.js"]
    }
  }
}
```

Then ask it: *"Load Pinnables board dashboard-cards and implement it."*

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Design and architecture notes live in [docs/internal](docs/internal).

## License

MIT. See [LICENSE](LICENSE).
