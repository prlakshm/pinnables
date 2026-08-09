# Board: Dashboard card consistency
5 pins · 4 routes · status: done

**Applies to every pin:** Normalize using the existing design tokens in src/styles/tokens.css. Do not introduce new dependencies.

## Pins

### pin-01 — StatCard  [done]
route `/dashboard` · 1440×900
source `src/components/StatCard.tsx:12`
> Too much vertical padding, and the radius doesn't match anything else in the product.

[agent] Applied card tokens: padding 16px 20px, radius 12px, shadow from SettingsCard.

### pin-02 — SettingsCard  [done]
route `/settings` · 1440×900
source `src/components/SettingsCard.tsx:8`
> This is the card treatment we want everywhere. Reference only — don't change this one.

[agent] Reference card — left unchanged.

### pin-03 — ActivityCard  [done]
route `/dashboard` · 1440×900
source `src/components/ActivityCard.tsx:21`
> Same drift as the stat card, plus it's missing a shadow entirely.

[agent] Matched SettingsCard container treatment via shared .card tokens.

### pin-04 — MobileNav  [done]
route `/checkout` · 390×844 · state: mobile
source `src/components/MobileNav.tsx:16`
> Keep this slide-in drawer behavior on checkout. Do not convert it to a bottom tab bar like /dashboard uses.

[agent] Slide-in drawer preserved on checkout route.

### pin-05 — EmptyState  [done]
route `/reports` · 1440×900 · state: empty
source `src/components/EmptyState.tsx:5`
> Reads as a different product than the cards. Should sit in the same family without becoming a card itself.

[agent] Aligned empty state with card family tokens (radius, subtle bg) without card shadow.

## Relationships

### rel-01 — match
source `pin-02` SettingsCard `src/components/SettingsCard.tsx:8`
target `pin-01` StatCard `src/components/StatCard.tsx:12`
  padding        32px 24px  →  16px 20px
  border-radius  4px  →  12px
  gap            4px  →  8px
  box-shadow     rgba(0, 0, 0, 0.06) 0px 1px 2px 0px  →  rgba(0, 0, 0, 0.08) 0px 4px 12px 0px
target `pin-03` ActivityCard `src/components/ActivityCard.tsx:21`
  padding        28px 24px  →  16px 20px
  border-radius  6px  →  12px
  gap            12px  →  8px
  box-shadow     none  →  rgba(0, 0, 0, 0.08) 0px 4px 12px 0px
except: Preserve each card's own heading and content hierarchy — only the container treatment should change.
> Dashboard cards should read as the same component family as the Settings plan card.

---
Call `get_pin_context` with a pin id for full styles, markup, DOM path, and screenshot path.
