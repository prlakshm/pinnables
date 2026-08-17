# Pinnables

**Point at things in your running app and tell your coding agent what to change.**

Pinnables is a Chrome extension that lets you click a component on your own site, describe the change in plain words, and have Cursor, Claude Code, or Codex make it. The edit lands in your real source files, so your dev server hot-reloads and you see it happen.

The part that makes it different: you can pin components **across different pages** and describe how they relate. "These three cards should match" is one instruction, not three tickets.

---

## See it work

**The whole loop — pin, describe, watch it change**

https://github.com/prlakshm/pinnables/raw/main/demos/public/01-overview.mp4

**Relating components across pages**

https://github.com/prlakshm/pinnables/raw/main/demos/public/02-cross-page-relationships.mp4

**Version keys — flip between what the agent tried**

https://github.com/prlakshm/pinnables/raw/main/demos/public/03-version-rail.mp4

---

## Install

You need [Node](https://nodejs.org) 20 or newer and Chrome.

```bash
git clone https://github.com/prlakshm/pinnables.git
cd pinnables
npm install
npm run build
```

Load the extension:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and pick `packages/extension/dist`

Start the local service, pointed at the app you want to edit:

```bash
PINNABLES_PROJECT_DIR=/path/to/your-app npm run dev:service
```

This runs on `127.0.0.1:4573` and never talks to anything off your machine except the agent you choose. Without it, the extension still captures pins, they just can't reach your files.

---

## Use it

Open your app in Chrome, click the **Pinnables** icon in the toolbar, and the side panel opens.

### 1. Turn on capture

Press **Capture** in the panel. Now hovering your app highlights components instead of clicking through to them.

The toolbar that appears has three modes:

| Mode | What it does |
|---|---|
| **Browse the page** | Normal clicking, so you can navigate to another route |
| **Pin an element** | Click a component to select it |
| **Draw on a pin** | Sketch directly on the page when words aren't enough |

### 2. Pin something and describe it

Click a component. A box opens with a text field.

| You type | You press | What happens |
|---|---|---|
| A change | **Enter** | Sent to your agent now |
| A change | **⌘↵** | Saved to the board for later |
| Nothing | **⌘↵** | Keeps the pin itself, so you can come back to it |

So `Enter` means "do this", and `⌘↵` means "remember this".

### 3. Pin across pages

Switch to **Browse the page**, navigate anywhere in your app, then pin again. Your earlier pins are still on the board.

**Shift-click** several pins to select them together, then write one message for all of them. That's how you say "make these match" once instead of three times.

### 4. Send it

Press **Send to agent**. The panel holds on *Sending…* until the agent actually starts, then your files change underneath the running app.

If another send is still running, the next one queues and goes automatically when the first finishes.

### 5. Undo, or compare

Every finished send is saved as a version. Press **⌥1**, **⌥2** and so on to flip between what the agent tried, or go back to how it was before. Versions reset when you commit, since at that point you've decided.

---

## Connect an agent

Pinnables drives **Cursor**, **Claude Code**, or **Codex**. You pick with the command you start the service with, and nothing else changes: same pins, same Send, same version keys.

```bash
npm run dev:service          # Cursor (default)
npm run dev:service:claude   # Claude Code
npm run dev:service:codex    # Codex
```

### Setting each one up

| Agent | What it needs |
|---|---|
| **Cursor** | An API key from [Cursor → Integrations](https://cursor.com/dashboard/integrations), set as `CURSOR_API_KEY` |
| **Claude Code** | The `claude` CLI, signed in with `claude login` |
| **Codex** | The `codex` CLI, signed in with `codex login` |

For Claude Code and Codex, if the CLI already works in your terminal, Pinnables works. All three edit files on your machine, so your dev server hot-reloads either way.

A full example:

```bash
CURSOR_API_KEY=your-key-here \
PINNABLES_PROJECT_DIR=/path/to/your-app \
npm run dev:service
```

### Picking a model

Optional, and it works for whichever agent you chose. Leave it off and each agent uses its own default.

```bash
PINNABLES_MODEL=claude-sonnet-5 npm run dev:service:claude
```

### All the settings

| Variable | What it does |
|---|---|
| `PINNABLES_PROJECT_DIR` | The repo the agent edits. Required unless you start the service from inside it |
| `PINNABLES_AGENT` | `cursor`, `claude`, or `codex`. The scripts above set this for you |
| `PINNABLES_MODEL` | Model for whichever agent is running |
| `PINNABLES_SEND_IMAGES=1` | Always attach screenshots. On automatically whenever you used the draw tool |
| `PINNABLES_CLAUDE_PATH` · `PINNABLES_CODEX_PATH` | Where the CLI lives, if it isn't on the service's PATH |
| `PINNABLES_CURSOR_RUNTIME=cloud` | Run Cursor's Cloud Agents instead of editing locally |

Follow-up sends continue the same conversation with the agent, so "make it a bit darker" works after "make it blue".

---

## Make pins find the right file

Add the Vite plugin to the app you're editing. Without it a pin knows *which component* you clicked but not *which file* it lives in, so the agent has to guess.

```js
// vite.config.js
import { pinnables } from "@pinnables/vite-plugin";

export default { plugins: [pinnables(), react()] };
```

Every element gains `data-pin-source="src/components/Card.tsx:42"`. Dev only by default, since it publishes your file layout to anyone with an inspector. Pass `{ includeProduction: true }` if you want it in a build.

---

## Let your agent read boards directly (MCP)

Optional. This lets the agent pull a board itself and mark pins done, instead of only receiving them.

**Claude Code** — `.mcp.json` in your project root:

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

**Cursor** uses the same shape in `.cursor/mcp.json`. **Codex** uses `~/.codex/config.toml` under `[mcp_servers.pinnables]`.

Then ask it: *"Load Pinnables board dashboard-cards and implement it."*

Four tools: `list_boards`, `get_board`, `get_pin_context`, `set_pin_status`.

---

## How it works

```
Chrome extension  ──▶  local service (127.0.0.1:4573)  ──▶  your agent
   pins, board          writes board.json + screenshots       edits files
        │                        │
        └── chrome.storage       └── ~/.pinnables/
```

Pins live in `chrome.storage`, so nothing is lost if the service isn't running. When you send, the service writes the board to `~/.pinnables/` and hands your agent the pinned element's selector, source file, captured styles, and a screenshot. Then it watches the run so it can save a version when the edit lands.

Everything is local. The only thing that leaves your machine is the prompt going to whichever agent you picked.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Design and architecture notes are in [docs/internal](docs/internal) if you want the reasoning behind a decision.

## License

MIT. See [LICENSE](LICENSE).
