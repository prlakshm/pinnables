# Pinnables

Pinning cross-page annotations for AI coding agents.

Pin components across your product's routes, describe how they should relate, and hand your coding
agent one plan with the exact style diffs — instead of a list of independent tickets.

- [PDR.md](PDR.md) — product requirements
- [PDR-REVIEW.md](PDR-REVIEW.md) — critique of the spec, and why the decisions are what they are
- [HANDOFF-DESIGN.md](HANDOFF-DESIGN.md) — how the board reaches the agent
- [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) — architecture, user flows, build sequence

## Status

| Piece | State |
|---|---|
| Board schema, style allowlist, diff computation | **working** |
| MCP server (4 tools) | **working**, verified against a real MCP client |
| Local service (materializes boards to disk) | **working** |
| Chrome extension — capture, board, relationships, handoff | **working**, not yet loaded in Chrome |
| Draw tool — frozen-frame region marking | **working**, not yet loaded in Chrome |
| Wordmark | **working** — traced vectors |
| Dev plugin (build-time source mapping) | not started |

## Run it

```bash
npm install && npm run build
```

Three processes, depending on what you're doing:

```bash
npm run dev:extension
```

Then load `packages/extension/dist` at `chrome://extensions` with developer mode on. Click the
Pinnables toolbar icon on a `localhost` page to open the side panel and arm capture mode.

```bash
npm run dev:service
```

The companion service on `127.0.0.1:4573`. Without it the extension still works — pins live in
`chrome.storage` — but boards can't be written to disk for an agent to read.

```bash
npm run smoke
```

Drives the MCP server over a real stdio session against the fixture board.

## How to use

With capture armed, the floating bar’s tools are also keys. They do not fire while you are typing in the annotation box or a page field.

| Key | Tool |
|---|---|
| `V` | Browse the page |
| `P` | Pin an element |
| `D` | Draw on a pin |
| `E` | Erase a whole stroke |

`Esc` dismisses a selection, then exits capture from Browse. `Alt+Shift+P` toggles capture from anywhere (Chrome → Extensions → Keyboard shortcuts).

On a pin that has takes: `⌥1`–`⌥5` jumps to that version; `←` / `→` steps when the annotation draft is empty.

## Source mapping

Add the Vite plugin to the app you're reviewing. This is the primary path, not a nicety: the
extension's fallback reads `_debugSource` off the React fiber, and React 19 removed it — so without
the plugin a pin can name its component but not say where it lives.

```js
// vite.config.js
import { pinnables } from "@pinnables/vite-plugin";

export default { plugins: [pinnables(), react()] };
```

Every DOM element gains `data-pin-source="src/components/Card.tsx:42"` and
`data-pin-component="Card"`, which is what turns a pin into a file an agent can open. Components are
skipped — `data-*` on `<Card />` is a prop that may never reach the DOM — and attributes are
inserted after the tag name, so line numbers stay exactly where they were.

Dev only unless you ask otherwise: the attributes publish your source tree to anyone with an
inspector, which is fine on localhost and odd in production. Pass `{ includeProduction: true }` if
you want them in a build.

## Connect an agent

### One-click Send to Cursor (recommended)

1. Create an API key at [Cursor Dashboard → Integrations](https://cursor.com/dashboard/integrations).
2. Start the local service with that key, pointed at the **app repo** you're annotating:

```bash
CURSOR_API_KEY=crsr_… \
PINNABLES_PROJECT_DIR=/absolute/path/to/your-app \
npm run dev:service
```

3. In the extension, pin + annotate, then press **Send to agent**.

By default Send uses Cursor's **local** agent runtime: it edits files in
`PINNABLES_PROJECT_DIR` (or the service's cwd) on this machine. A Vite/dev server
running that repo should hot-reload — no PR branch, no cloud clone.

Live Sends use Composer **fast**, skip screenshot vision, and tell the agent to
edit the named file only. That is what keeps the loop short.

Follow-up Sends reuse the same local agent session (`~/.pinnables/cursor-session.json`).
If that agent still has an active run, the next Send is **queued** and starts when
the run finishes.

Optional:

| Env | Purpose |
|---|---|
| `PINNABLES_PROJECT_DIR` | Repo the local agent edits (required when the service isn't started from that repo) |
| `PINNABLES_CURSOR_MODEL` | Model id (default `composer-2.5`) |
| `PINNABLES_CURSOR_FAST=0` | Full Composer instead of the fast variant (slower) |
| `PINNABLES_SEND_IMAGES=1` | Always attach pin screenshots (vision; slower). On by default for cloud, and whenever the pen tool was used |
| `PINNABLES_CURSOR_AGENT_ID` | Force follow-ups onto a specific agent |
| `PINNABLES_CURSOR_RUNTIME=cloud` | Use Cloud Agents instead (remote clone; see below) |
| `PINNABLES_REPO_URL` | GitHub URL for cloud runtime |
| `PINNABLES_REPO_REF` | Starting branch/SHA for cloud |
| `PINNABLES_AUTO_CREATE_PR=1` | Cloud only: open a PR when the run finishes |
| `PINNABLES_CURSOR_FALLBACK_LOCAL=1` | If Cursor API fails, fall back to CLI spawn (`claude`) |

Cloud runtime (`PINNABLES_CURSOR_RUNTIME=cloud`) clones the repo on a Cursor VM.
Watch those agents at [cursor.com/agents](https://cursor.com/agents). Prefer local
for live UI feedback on a running app.

Without `CURSOR_API_KEY`, Send still materializes the board and copies a pointer for you to paste — unless you hook Claude or Codex below.

### Send to Claude Code or Codex

The same one-at-a-time queue, snapshot-on-done, and lost-run → Resend behavior applies to every backend. Set `PINNABLES_AGENT` (or the matching API key) and restart the service:

```bash
# Claude Code CLI (`claude -p --permission-mode acceptEdits`)
PINNABLES_AGENT=claude \
ANTHROPIC_API_KEY=sk-ant-… \
PINNABLES_PROJECT_DIR=/absolute/path/to/your-app \
npm run dev:service
```

```bash
# Codex CLI (`codex exec --sandbox workspace-write`)
PINNABLES_AGENT=codex \
CODEX_API_KEY=… \
PINNABLES_PROJECT_DIR=/absolute/path/to/your-app \
npm run dev:service
```

`OPENAI_API_KEY` is accepted in place of `CODEX_API_KEY`. `PINNABLES_AGENT=claude|codex|cursor` always wins over key auto-detect. `PINNABLES_AGENT_CMD` always wins over both and is run through the shell with `PINNABLES_PROMPT` and `PINNABLES_MESSAGE` set.

| Env | Purpose |
|---|---|
| `PINNABLES_AGENT=claude` | Force Claude Code CLI even if `CURSOR_API_KEY` is set |
| `PINNABLES_AGENT=codex` | Force Codex CLI |
| `ANTHROPIC_API_KEY` | Auth for `claude` |
| `CODEX_API_KEY` / `OPENAI_API_KEY` | Auth for `codex` (auto-selects Codex when no Cursor key is set) |
| `PINNABLES_AGENT_CMD` | Custom CLI; wins over every other agent setting |

Only one run is in flight at a time across Cursor, Claude, and Codex. Further Sends queue until it finishes. If the local service restarts mid-queue, those tags become **Resend** instead of staying Queued forever.

### MCP (pull / status write-back)

**Claude Code** — `.mcp.json` at the project root:

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

**Cursor** — same shape in `.cursor/mcp.json`. **Codex** — `~/.codex/config.toml` with
`[mcp_servers.pinnables]`. Add `"env": { "PINNABLES_HOME": ".../fixtures" }` to try it against the
sample board before capturing anything real.

Then, in the agent (clipboard fallback path):

> Load Pinnables board "dashboard-cards" and implement it.

## Architecture

```
Chrome
  content script (tier 1, 1.8 kB — listener only, always resident)
     └─ picker bundle (tier 2, lazy) — highlight, capture, floating pins, toolbar
  side panel (React) — shelf, relationships, handoff
  service worker — stateless router; all state round-trips through chrome.storage
        │ HTTP, 127.0.0.1 only
        ▼
  local service — board.json · brief.md · pins/*.png
        │ same board.json
        ▼
  MCP server (stdio) ──► Cursor / Codex / Claude Code
```

Three constraints this encodes, each learned the hard way in [PDR-REVIEW.md](PDR-REVIEW.md):

- **The service worker holds no state.** MV3 terminates it when idle, so every mutation goes through
  `chrome.storage`. The panel and the worker are views, not owners.
- **The content script is two-tier.** A listener stub satisfies the 200 ms budget; the picker loads
  on activation, so "no background capture when inactive" is literally true.
- **MCP is pull-only for context; Send can push.** The clipboard pointer remains the zero-config
  fallback. With `CURSOR_API_KEY` (or `PINNABLES_AGENT=claude|codex` and the matching API key),
  pressing Send starts that agent without paste. One in-flight run at a time; extras queue.

## Tools

Four, deliberately. Cursor caps how many tools it forwards to the model across all installed
servers, and more tools measurably degrades tool selection.

| Tool | Purpose |
|---|---|
| `list_boards` | Entry point — ids, titles, pin counts, status |
| `get_board` | The whole work order: pins with routes, source files, instructions, plus relationships with computed before → after style diffs |
| `get_pin_context` | Full detail for one pin — complete styles, markup, DOM path, absolute screenshot path |
| `set_pin_status` | Write-back, so resolution closes the loop |

`get_board` is manifest-first: a 5-pin board renders in ~526 tokens, so a 20-pin board lands near 2k
and the agent can hold the whole thing while it works. Screenshots are returned as **paths**, never
base64 — the agent reads them with its own file tools only if it needs to look, which also sidesteps
MCP image-support gaps in some clients.

## The interesting part

A relationship stores one source pin, N targets, a property list, and a natural-language exception.
Because the board holds captured styles for both sides, the diff is computed rather than described:

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

## Two kinds of pin

**Element pins** answer *which component* — selector, DOM path, source file, computed styles,
markup. That's what makes a precise edit possible.

**Region pins** answer *which area* — a crowded band, a gap between two things, one frame of an
animation. The element picker can't express any of those.

Region pins come from the draw tool, and the mechanic is borrowed from
[Cursor Design Mode](https://cursor.com/blog/design-mode): **the viewport is frozen first, and you
draw on that frame.** It's a small decision that removes a whole class of problem — a mark anchored
to a live page drifts the instant anything reflows, and can't mark a moving element at all. Freeze
first and there is nothing left to re-anchor; the frame *is* the record.

Circle, box, arrow, or freehand; four colours; `⌘Z` to undo, `⌘↵` to commit, `Esc` to discard the
frame. The marks are cropped to their own bounds plus context, composited into the stored PNG, and
summarised for the brief:

```
### pin-06 — toolbar crowding  [todo]
route `/dashboard` · 1440×900
region · 1 ellipse, 1 arrow drawn over the captured frame · see screenshot
> Everything between the filter row and the first card is fighting for the same space.
```

Note what a region pin deliberately *doesn't* carry: no selector, no source file, no computed
styles. Filling those with something plausible would be worse than leaving them empty — the
screenshot is the specification, and the agent is told to open it. For the same reason region pins
can't take part in relationships: a style diff needs two elements with captured styles, and a region
has neither.

## Brand

Two traced vector wordmarks, both regenerated from the source render with `npm run trace-wordmark`:

- **`brand/wordmark.svg`** — three tones, no gradient: base `#ED1C24`, a lit shoulder `#F4564B`
  toward the upper left, and a true-white specular on top. Three hard steps read as a sphere at this
  scale, survive being rasterised by anything, and keep the mark consistent with a flat interface.
- **`brand/wordmark-flat.svg`** — two tones, base plus specular. The shoulder is a soft tonal step
  that needs pixels to read as shading; the hard-edged specular still resolves at a few px across.
  The extension's side panel uses this one — it draws the wordmark at 17px.

The disc is a true circle; the traced outline was faithful to the render's antialiasing, which meant
faintly lumpy.

The tittle geometry isn't eyeballed. `scripts/analyse-tittle.mjs` reads the source render's pixels,
sorts them into tone bands by luminance *and* saturation inside the disc — the specular is the
desaturated region, not merely the brightest — then fits each band with PCA: centroid for position,
eigenvalues for the radii, principal axis for the tilt.

That measurement is also what determined the specular's *shape*. Its fitted centre sits 19.9px from
the disc centre, and the tangent to the circle at that point is −36.6° — within a degree of the
specular's own measured −37.7° rake. A highlight lying along the tangent at a fixed radius is an
**arc**, curving with the surface rather than sitting flat on it. It's drawn as a stroked arc with
round caps, which gives the curve, the rounded ends, and the concave inner dent from one primitive.

Both tones use that same construction — the lit shoulder is the same worm, fatter and set further
back. Curvature is separated from position (`orbit` places the midpoint, `curveRadius` sets how hard
it bends), so a worm can be tightly curved without being dragged toward the disc centre.

Two values are tuned rather than raw, both noted in the script: the lit band is a crescent, and an
ellipse fitted to a crescent comes out far too big, so it's sized to the source's actual lit width;
and the specular fit runs slightly wide of the hot spot.

Palette: `#F6F5F3` paper · `#FFFFFF` surface · `#292C33` ink · `#1E3FD8` cobalt (interactive) ·
`#9BD3F9` sky (tints) · `#ED1C24` red. **Red is the identity colour only** — logo and app icon,
never UI chrome, so it never collides with an error state.

## Layout

```
packages/shared/       schema, style allowlist + diff, storage, markdown rendering
packages/mcp-server/   the four tools over stdio
packages/service/      HTTP companion; writes boards to ~/.pinnables
packages/extension/    MV3 extension — content overlay, side panel, service worker
brand/                 wordmark source + traced vector
fixtures/              a sample board — 5 pins, 4 routes, 1 relationship
scripts/               MCP smoke test, wordmark tracer
```
