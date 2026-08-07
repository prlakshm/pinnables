# Pinnables against the AI-ready roadmap

Assessed 2026-08-07 against *AI-ready Design System Roadmap* (designsystems.surf),
using its own method: assess all twenty areas, then pick 3–5 that matter now.

A caveat the roadmap does not cover: Pinnables is one person, pre-M1, and has
never been loaded in Chrome end to end. Ten of the twenty areas are about
coordinating a team that does not exist. Marking those red would manufacture
work. They are marked **n/a for now** and the reason is given, which is more
useful than a red dot.

## The twenty

| Stage | Area | State | Note |
|---|---|---|---|
| Define | Goals | ✅ | `PDR.md` — the problem, the audience, the outcome. |
| Define | Principles | ⚠️ | Real principles exist but only inside code comments. Nothing states them once. |
| Define | Scope | ✅ | `PDR.md` §cut list. M1 boundary is explicit. |
| Define | Architecture | ✅ | `IMPLEMENTATION-PLAN.md`; two-tier content script, shared package as source of truth. |
| Define | Ownership | n/a | One person. |
| Create | Foundations | ⚠️ | Colour has meaning, usage rules, and constraints. Spacing, type, and motion do not. |
| Create | **Tokens** | ✅ *(fixed today)* | Was the worst area in the system. See below. |
| Create | Components | ⚠️ | Purpose and states are clear; there is no written API or composition contract. |
| Create | **Design–Code Alignment** | ⚠️ *(partly fixed today)* | Colour is now checked. Nothing else is. |
| Create | Documentation | ⚠️ | Dense and honest, but it lives in comments, not a findable place. |
| Adopt | Release | n/a | Nothing released. |
| Adopt | Communication | n/a | No audience yet. |
| Adopt | Enablement | ⚠️ | `README.md` covers setup; nothing covers *using* the system. |
| Adopt | Contribution | n/a | One person. |
| Adopt | Governance | n/a | One person. |
| Evolve | Metrics | ❌ | Nothing measured. No contrast check, no bundle budget, no token coverage. |
| Evolve | Feedback | n/a | No users. |
| Evolve | Maintenance | ⚠️ | `check-tokens` is the only automated guard in the repo. |
| Evolve | Deprecation | ✅ | `brand/palettes/warm-rose.md` — a retired system kept with its reasoning. |
| Evolve | Prioritization | ✅ | This file. |

## What was actually wrong with Tokens

The roadmap names four token gaps. Pinnables had all four, and one of them had
already caused a real failure.

**"Tokens become a flat value list."** One layer, fifteen hexes. `--pin-paper`
mixed a primitive with a role.

**"Semantic names describe appearance."** `--pin-sky-fill` says what it looks
like. What it *means* is "switched on."

**"Shared values are duplicated."** `#6b6f78` was written out three times — as
`--pin-grey`, as `--pin-ink-muted`, and again inside an `rgba()`. They were one
decision. Nothing recorded that, so changing it would have silently split it.

**"Token data remains tool-bound."** The values lived only in a CSS file. Paper
had its own tokens under different names. **This is the one that already bit:**
every colour in the extension had been sampled off a rendered artboard instead
of read from the file, and four were wrong — sky, cobalt, red, and a grey that
did not exist as a token at all. The build passed. A visual review passed. The
values were plausible, so the drift survived until someone opened the file.

### Fixed

- **Two layers.** Primitives are the only place a hex appears; semantics are the
  only thing components may reference. `check-tokens` fails if a semantic
  hardcodes a colour.
- **References preserved.** `--pin-measure` and `--pin-ink-muted` both alias
  `--pin-grey-500`, so the fact that they are one decision is now written down.
  Alphas use `color-mix` against the primitive rather than a re-typed `rgba()`.
- **Provenance recorded.** Every primitive says whether it came from Paper, was
  sampled from a render, or was derived here. Nine, two, and four respectively.
  "Derived" is ours to change; "Paper" has to change in Paper first.
- **A portable contract.** `brand/tokens.json` carries the roles and the
  `paperToken` each primitive answers to.
- **A guard.** `scripts/check-tokens.mjs` runs first in `npm run build`. Feeding
  it today's two real mistakes — the wrong cobalt and the invented grey — it
  catches both.

## The next three

Per the roadmap's Apply stage: area, why now, next action, checkpoint.

**1 · Design–Code Alignment — extend the check to Paper.**
Colour parity is enforced between `tokens.json` and `ui.css`, but *neither* is
checked against Paper, which is where the original drift came from. The
`paperToken` field makes this mechanical: read the Paper tokens over MCP, diff.
*Checkpoint: the check fails when a value is changed in Paper and not in code.*

**2 · Foundations — give spacing and type the treatment colour just got.**
Spacing is written inline everywhere (`padding: 6px 7px 6px 16px`) with no ramp
and no rule about when to use what. The roadmap's gap is exactly this: "important
decisions remain local." Type has two families and about five sizes, none named.
*Checkpoint: a new component can be built without inventing a spacing value.*

**3 · Metrics — measure contrast, at minimum.**
`--pin-sky-fill` behind `--pin-cobalt`, and `--pin-ink-faint` on `--pin-paper`,
are assumed to pass. Nobody has checked, in either scheme. This is the roadmap's
own "AI-ready means accessibility is explicit and testable" — and it is a
twenty-line addition to `check-tokens`.
*Checkpoint: every foreground/background pair in `tokens.json` reports a ratio.*

## Deliberately not doing yet

Renaming `sky` / `sky-tint` / `sky-fill` / `cobalt` to role names
(`focus-ring` / `wash` / `on-fill` / `on-glyph`). The roadmap is right that these
describe appearance. But the rename touches every component in the middle of
active visual iteration, and a half-finished rename is worse than a consistent
wrong name. It is recorded in `tokens.json` under `$knownGaps` so it does not get
lost.
