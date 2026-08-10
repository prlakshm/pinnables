# Warm rose — archived selection palette

Retired 2026-08-07 in favour of the blue and grey palette. Kept because the
*system* behind it may be worth returning to even though the values are not in
use, and because the reasoning took several passes to arrive at.

## The six

| slot | hex | L\* |
|---|---|---|
| 1 rose | `#da6a93` | 59 |
| 2 plum | `#a865c0` | 54 |
| 3 fern | `#5aa876` | 64 |
| 4 apricot | `#eda265` | 73 |
| 5 sky | `#6aa6d4` | 66 |
| 6 stone | `#8a8079` | 54 |

## The system

A rotating set assigned per selection in creation order, cycling — rather than
one fixed accent. The point is that an overlay sits on products it has never
seen, and a fixed accent has to match all of them. A rotating set never has to
match the page; it only has to stay distinguishable from its siblings, which is
a far easier constraint.

Rules the set was built to:

- **42° minimum hue separation.** Below that, two simultaneous selections read
  as the same colour at a glance. This is the number any addition must clear.
- **Mid-lightness.** One value then serves both light and dark schemes, and only
  the fill alpha changes — no second palette to maintain.
- **Muted, not vivid.** Saturated enough to separate from the page, quiet enough
  not to compete with the product underneath.
- **Rose leads.** The first thing pinned is always rose, which makes the
  sequence recognisable.

## Two things learned the hard way

**Magenta reads brighter than red at the same lightness value.** Rotating hue
alone toward pink loses depth even though the number is unchanged. Hue and
lightness have to move together.

**Yellow is the only gap left on the wheel and the one colour that cannot fill
it.** To reach even 2.5:1 on white it must darken until it reads olive. The
sixth slot went to a near-neutral instead, separating on chroma rather than hue,
which also means it cannot crowd anything added later.

## Provenance

The system was reverse-engineered from Cursor's Design Mode — the values by
pixel-sampling (`scripts/sample-outline-colors.mjs`), the assignment order by
tracing a screen recording frame by frame. Cursor's own eight were
`#3996dd #9b59b6 #3aab5f #f2994b #40ada6 #db4486 #eb5758 #aaaf12`, handed out
blue → purple → green → orange → teal → pink → red → olive, wrapping at nine.

None of those values ever shipped. Using a competitor's literal palette in a
product positioned against them reads as a reskin rather than an argument.
