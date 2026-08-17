# Handoff Design

How the annotation board reaches the agent, and what actually makes the agent's edit correct.

Resolves §2.1 of [PDR-REVIEW.md](PDR-REVIEW.md).

---

## 1. "MCP or screenshots?" is a false choice

They answer different questions:

- **MCP / files** = the *transport*. How the board gets to the agent.
- **Screenshots** = one *payload field*, and — see §2 — the least useful one for code accuracy.

You need a transport regardless. The real question is what you put in the payload, and the answer is
that screenshots should be near the bottom of the priority list.

---

## 2. What actually drives an accurate edit

Ranked by how much each one improves the odds the agent edits the right code correctly.

| Rank | Signal | Why it matters | Cost to capture |
|---:|---|---|---|
| 1 | **Source file + line** | Eliminates the search step entirely. Every wrong edit starts with the agent guessing which component this is. | Free *if* the dev plugin is installed (PDR-REVIEW §2.3) |
| 2 | **`outerHTML` + class list** | In a Tailwind/CSS-modules codebase the class string *is* the styling, and it's directly greppable. `grep "rounded-sm px-6 py-8"` finds the component even with no source map. | Free |
| 3 | **Exact computed styles** | `padding: 32px 24px` is a fact. A model reading a screenshot *estimates* padding, and estimates become wrong diffs. | Free |
| 4 | **The instruction + relationship** | Intent. Nothing else supplies it. | The user types it |
| 5 | **Route + viewport** | Disambiguates which of three instances of a shared component you meant. | Free |
| 6 | **Screenshot** | Verification and disambiguation, not specification. | Most expensive field you have |

**The counterintuitive part:** for most pins the agent does not need the screenshot at all. Consider a
real pin —

> Source: `src/components/StatCard.tsx:12`
> Current: `padding: 32px 24px; border-radius: 4px`
> Instruction: "Reduce vertical padding and use the standard card radius."

That is a complete, unambiguous work order. Adding a PNG changes nothing about the edit, and costs
~1,050 tokens. A vision model looking at the same card would guess "roughly 30px of padding" and
produce a worse diff than the one you already have exactly.

**Where screenshots do earn their cost:**
- The user composing the board — the shelf is unusable without them. This is most of their value.
- Problems that are genuinely visual and unstatable: "this feels cramped," "these don't look related."
- The agent confirming it found the right element before editing.
- Before/after verification after the run.

So: **capture screenshots always, ship them to the agent rarely.** Thumbnails in the manifest,
full-res paths on demand.

---

## 3. The highest-accuracy artifact you can produce: the style diff

This is the part no competitor does, and it falls straight out of the relationship model.

When a user creates `match(source: Pin 5, target: Pin 3, properties: [radius, padding, shadow])`,
you already hold the computed styles for **both** elements. So don't ship two screenshots and a vague
instruction — **compute the diff and ship the changeset**:

```
Relationship R1 — match
  Source:  Pin 5  Settings card    src/components/SettingsCard.tsx:8
  Target:  Pin 3  Dashboard card   src/components/StatCard.tsx:12
  Apply:   border-radius, padding, box-shadow
  Except:  preserve Pin 3's content hierarchy

  border-radius   4px            →  12px
  padding         32px 24px      →  16px 20px
  box-shadow      0 1px 2px …06  →  0 4px 12px …08
```

That converts "make this card match that one" — a request the agent has to interpret — into three
concrete value changes it can apply mechanically, plus one constraint in natural language.

Two things follow:

1. This is your accuracy story *and* your differentiator, and they're the same feature. Worth
   reinforcing the §6 argument in the review that relationships belong earlier than Milestone 4.
2. It only works if you capture a consistent property allowlist across all pins (PDR-REVIEW §7.5).
   Diffing requires both sides to have the same keys. Lock the allowlist before you build the picker.

---

## 4. Transport: files first, MCP for the loop

### The problem with MCP-only

- **Install friction.** Every user must edit a config file per agent before anything works. For a
  case-study launch that's a brutal first-run experience and a chunk of your funnel.
- **Image support is the weak spot.** MCP's spec supports image content blocks, but client rendering
  of them has been inconsistent, and Cursor's handling of images in tool results has historically been
  the most-complained-about gap. Do not design the demo around it. **Verify this on your target Cursor
  version before committing** — if it works, treat it as a bonus, not a dependency.
- **Tool-count pressure.** Cursor caps how many tools it forwards to the model (historically ~40 across
  all servers). Another reason for the 9→4 cut in PDR-REVIEW §4.1 — you're sharing that budget with
  every other server the user has installed.

### The problem with files-only

- No status write-back. The agent can't call `set_pin_status`, so resolution stays manual.
- No querying. The agent reads what you wrote, not what it asks for.

### Recommended: both, layered

**Stage 1 — Materialize.** On "Ready for agent," the local service writes:

```
~/.pinnables/boards/<board-id>/
  brief.md            summary — routes, sources, instructions, relationships, style diffs
  board.json          same content, structured
  pins/
    pin-01.png        full-res screenshot
    pin-01.json       full context: computed styles, outerHTML, DOM path, nearby context
    …
```

Default to `~/.pinnables/` rather than the repo — nothing lands in the user's git tree unless they
opt in. If they do opt into `<repo>/.pinnables/`, write the `.gitignore` entry for them.

**Stage 2 — Trigger.** Extension copies a one-liner to the clipboard, branching on whether the MCP
server is registered:

```
MCP present:  Load Pinnables board "dashboard-cards" and implement it.
No MCP:       Read ~/.pinnables/boards/dashboard-cards/brief.md and implement it.
```

**Stage 3 — Pull.** The agent reads `brief.md`, and opens `pins/pin-03.json` or `pin-03.png` only for
the pins it actually needs. This is the manifest-first pattern from the PDR — implemented with the
filesystem, which every agent already reads natively with its own tools. **No image-support question
ever arises**, because the agent uses its own Read tool on a PNG path.

**Stage 4 — Write back.** MCP's genuine contribution: `set_pin_status` closes the loop so the board
reflects reality. In the file-only path the user marks pins resolved by hand — degraded, but not broken.

### Why files first

| | Files | MCP |
|---|---|---|
| Install required | None | Per-agent config |
| Works on Cursor / Codex / Claude Code / Windsurf | Identically, zero integration work | Per-client verification |
| Screenshots | Agent's own Read tool, always works | Client-dependent |
| On-demand detail | Yes (separate files) | Yes (separate tool) |
| Status write-back | No | **Yes** |
| Agent discovers it exists | Must be told | Automatic |

Files get you a working demo on day one across every agent. MCP adds the resolution loop, which is
the genuinely MCP-shaped part of the product. Build the file writer first; it's also the thing that
makes `export as structured Markdown` (already P0) and the handoff the same feature instead of two.

---

## 5. `brief.md` — the format that determines accuracy

```markdown
# Board: Dashboard card consistency
Project: acme-app  ·  ~/dev/acme-app  ·  5 pins  ·  3 routes

**Global instruction:** Normalize using existing design tokens. No new dependencies.

---

## Pin 3 — Dashboard stat card                                    [todo]
Route      /dashboard
Viewport   1440×900
Source     src/components/StatCard.tsx:12
Selector   .dashboard-grid > article:nth-child(2)
Screenshot ./pins/pin-03.png
Detail     ./pins/pin-03.json

**Instruction:** Reduce vertical padding and use the standard card radius.

**Current:**
padding: 32px 24px · border-radius: 4px · box-shadow: 0 1px 2px rgba(0,0,0,.06)

**Markup:**
<article class="rounded-sm px-6 py-8 shadow-sm bg-white">…</article>

---

## Relationship R1 — match
Source  Pin 5 (Settings card, src/components/SettingsCard.tsx:8)
Target  Pin 3 (Dashboard stat card)
Apply   border-radius, padding, box-shadow
Except  preserve Pin 3's content hierarchy

border-radius   4px         →  12px
padding         32px 24px   →  16px 20px
box-shadow      0 1px 2px…  →  0 4px 12px…
```

Design notes:

- **Source path on every pin, near the top.** It's the highest-value field; make it impossible to miss.
- **Markup inline, truncated.** Enough to grep with, not the whole subtree.
- **Screenshot as a relative path, never inlined.** The agent opens it if it wants it.
- **Only styles relevant to the instruction.** Dumping 30 properties per pin buries the 3 that matter.
- **Relationships in their own section**, not folded into pins — they're the differentiator and they
  read as instructions, not metadata.

---

## 6. Agent configuration

**Cursor** — `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):
```json
{ "mcpServers": { "pinnables": { "command": "npx", "args": ["-y", "pinnables-mcp"] } } }
```

**Claude Code** — `.mcp.json` at project root (same shape), or:
```bash
claude mcp add pinnables -- npx -y pinnables-mcp
```

**Codex** — `~/.codex/config.toml`:
```toml
[mcp_servers.pinnables]
command = "npx"
args = ["-y", "pinnables-mcp"]
```

All three are stdio. One server binary covers every target, which is the agent-agnostic promise in the
PDR — nothing per-client is required beyond these three config snippets in your docs.

---

## 7. Build order

1. **Style property allowlist** — locked first; §3 depends on it and it's expensive to change later.
2. **`brief.md` writer + board directory** — this is the export feature and the handoff feature at once.
3. **Clipboard pointer + "Ready for agent"** — the whole handoff now works, with zero install.
4. **Style-diff computation** for relationships — the accuracy differentiator.
5. **MCP server, 4 tools** — adds discovery and `set_pin_status`.
6. **Detect whether MCP is registered** to branch the clipboard string.

Steps 1–3 make the demo work end-to-end on every agent. Everything after that is improvement, not
enablement — which is the right shape for a project whose riskiest assumption is a product question,
not a technical one.

---

## 8. Open risks

- **Cursor image support in MCP results** — verify on your target version. §4's file-based path makes
  this a non-blocker either way, which is most of why it's the recommended default.
- **`npx -y` on every agent start** is slow and needs network. Ship a real install (`npm i -g`) before
  launch, or the first-run experience is a multi-second hang the user blames on your extension.
- **Stale boards.** If the agent edits code and the user re-reads an old `brief.md`, the "current
  styles" are lies. Stamp `generatedAt` on the board and have the extension warn when a materialized
  brief is older than the last pin edit.
- **Path leakage.** `brief.md` contains absolute filesystem paths. That's fine locally, but if a user
  pastes one into a bug report or a demo video it exposes their directory structure. Worth a thought
  before the launch screenshot.
