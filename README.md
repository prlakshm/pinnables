# Pinnables

**Annotate local web apps and tell your coding agent what to change. All in your browser. No switching tabs.**

Click a component on your own site, describe the change, and Cursor, Claude Code, or Codex changes it. Edits land in your local source files, and your dev server hot-reloads so you watch it happen.

What makes it different: you can pin components **across different pages** and describe how they relate. "These three cards should match" is one instruction. "Make this match that" is another.

## Demos

Pin something, describe the change, watch it land:

[Pinning a component, describing a change, and watching it land](https://github.com/prlakshm/pinnables/raw/main/demos/public/01-overview.mp4)

Relating components that live on different pages:

[Relating components across different pages](https://github.com/prlakshm/pinnables/raw/main/demos/public/02-cross-page-relationships.mp4)

Version keys, for flipping between what the agent tried:

[Flipping between versions the agent produced](https://github.com/prlakshm/pinnables/raw/main/demos/public/03-version-rail.mp4)

## Install

You need [Node](https://nodejs.org) 20 or newer and Chrome. Check what you have:

```bash
node --version
```

Clone and build:

```bash
git clone https://github.com/prlakshm/pinnables.git
cd pinnables
npm install
npm run build
```

Load the extension into Chrome:

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (toggle, top right)
3. Click **Load unpacked**
4. Select the `packages/extension/dist` folder inside the repo

Start the local service, pointed at the app you want to edit. Use the absolute path to that app, not to Pinnables:

```bash
PINNABLES_PROJECT_DIR=/absolute/path/to/your-app npm run dev:service
```

You should see:

```
pinnables service on http://127.0.0.1:4573
Cursor on composer-2.5: edits /absolute/path/to/your-app
```

Check it is up from another terminal:

```bash
curl http://127.0.0.1:4573/health
```

Everything stays on your machine. The only thing that leaves is the prompt going to whichever agent you picked.

## How to use

Open your app, click the **Pinnables** toolbar icon, and press **Capture**. Hovering now highlights components instead of clicking through.

**1. Pin something.** Click a component. A box opens with a text field.


| Type             | Press     | Result                                |
| ---------------- | --------- | ------------------------------------- |
| A live change    | **Enter** | Sent to your agent now                |
| A stashed change | **⌘↵**    | Saved to the board to send later      |
| Stash on nothing | **⌘↵**    | Saves pin, so you can come back to it |


So `Enter` means "do this" and `⌘↵` means "remember this".

Toolbar tools are keys. They do not fire while you are typing in the annotation box or a page field.

| Key | Tool |
|---|---|
| `V` | Browse the page |
| `P` | Pin an element |
| `D` | Draw on a pin |
| `E` | Erase a whole stroke |


**2. Pin across pages.** Switch to **Browse the page** (`V`) in the toolbar, navigate anywhere, and pin again. Earlier pins stay on the board. **Shift-click** several to write one message for all of them.

**3. Draw arrows and boxes for quick relationships.** The pencil mode (`D`) sketches directly on the page, and the drawing goes to the agent as a snapshot.

**4. Send Board.** Press **Send to agent**. The panel holds on *Sending…* until the agent actually starts. If a send is already running, the next one queues automatically.

**5. Undo or compare with version keys.** Every finished send is saved. Press **⌥1**, **⌥2** and so on to flip between what the agent tried, or back to how it was. Versions reset when you commit.

## Connect an agent

Pick with the command you start the service with. Nothing else changes.

**Cursor** needs an API key from [Cursor → Integrations](https://cursor.com/dashboard/integrations):

```bash
CURSOR_API_KEY=your-key-here PINNABLES_PROJECT_DIR=/absolute/path/to/your-app npm run dev:service
```

**Claude Code** needs the `claude` CLI signed in:

```bash
npm install -g @anthropic-ai/claude-code
claude login
PINNABLES_PROJECT_DIR=/absolute/path/to/your-app npm run dev:service:claude
```

**Codex** needs the `codex` CLI signed in:

```bash
npm install -g @openai/codex
codex login
PINNABLES_PROJECT_DIR=/absolute/path/to/your-app npm run dev:service:codex
```

If the CLI already works in your terminal, Pinnables works. All three edit files locally, so your dev server hot-reloads either way, and follow-up sends continue the same conversation.

Pick a model on the same line, for any of the three. Optional; leave it off and each agent uses its own default:

```bash
PINNABLES_MODEL=claude-sonnet-5 PINNABLES_PROJECT_DIR=/absolute/path/to/your-app npm run dev:service:claude
```


| Variable                                         | What it does                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| `PINNABLES_PROJECT_DIR`                          | The repo to edit. Required unless you start the service from inside it |
| `PINNABLES_MODEL`                                | Model for whichever agent is running                                   |
| `PINNABLES_SEND_IMAGES=1`                        | Always attach screenshots. Automatic when you use the draw tool        |
| `PINNABLES_CLAUDE_PATH` · `PINNABLES_CODEX_PATH` | Full path to the CLI, if it isn't on the service's PATH                |


If a send fails saying the agent isn't installed, that last pair is usually why. Find the path with `which claude` or `which codex` and pass it in.

## Help agents know what componets go with what file

Add the Vite plugin to the app you're editing. Without it an agent knows which component you clicked but not which file it lives in. The agent has to guess, which might be unreliable.

```js
// vite.config.js
import { pinnables } from "@pinnables/vite-plugin";

export default { plugins: [pinnables(), react()] };
```

Dev only by default, since it publishes your file layout to anyone with an inspector.

## Allow the agent to retreive boards

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