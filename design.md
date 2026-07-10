# ide — design

Design notes for **ide**, a fast, lightweight, cross-platform code editor
(Tauri). This file is the single source of truth for the icon and brand colour.

---

## Icon — "Leaf dot + caret"

A lowercase wordmark: **ıde**, set in Space Grotesk bold with a dotless i,
where a teal xylem-leaf shape stands in for the dot and a caret bar closes
the word. It reads as both "editor" and a nod to Gordon's personal brand in
one mark, and sits on a dark squircle tile so it holds up next to colourful
dock icons instead of competing with them.

**Geometry** — drawn in a 512×512 box:

| Element    | Definition                                                                                   | fill      |
|------------|-----------------------------------------------------------------------------------------------|-----------|
| tile       | `rect` 512×512, `rx=115` (rounded square, ~22.5% corner radius)                               | `#0b1120` |
| wordmark   | `text` "ıde" (U+0131 dotless i), Space Grotesk 700, size 224, x=70 y=336, letter-spacing -9   | `#e8eef6` |
| leaf dot   | `path M98 106 C 124 126 124 162 98 182 C 72 162 72 126 98 106 Z`                              | `#22d3ee` |
| caret      | `rect` 28×166, `rx=8`, x=420 y=172                                                             | `#22d3ee` |

The tile is a plain SVG rounded rect, not the true Apple-superellipse curve
the old mark used; that's simply what the locked design delivered. In the
live design mock the caret blinks (opacity keyframes, disabled under
`prefers-reduced-motion`). The About dialog renders the mark as inline SVG and
keeps that blink (with the same reduced-motion guard); every static asset in
this repo — favicon, app icons — uses the caret at full opacity with no
animation.

### Two background forms
| File                        | Background                                                     |
|------------------------------|-----------------------------------------------------------------|
| `app-icon/icon.svg`         | Rounded-square tile (macOS app-icon look)                      |
| `app-icon/icon-square.svg`  | Same mark, square background to the edges (web/marketing use)  |

There's no bare-mark-on-transparency variant right now. The wordmark's ink
colour (`#e8eef6`) only reads correctly on the dark tile, and nothing in the
app currently needs a transparent or single-colour cutout — there's no
tray/menu-bar icon. Add one if a future use case needs it.

---

## Colour

The table below is the blog-brand palette this file has carried since the
"Stagger" mark, and it's unrelated to the icon's own colours. Updating it is
out of scope here; the wider app-chrome token work lives in the Xylem
"Signal" design-system tokens, tracked separately. The icon itself now uses
two colours only, neither of which is a token in this table: tile `#0b1120`
and accent `#22d3ee`.

| Token                   | Hex       | Role                                        |
|-------------------------|-----------|---------------------------------------------|
| `--color-brand-primary` | `#0063B2` | Primary brand — the live line, links, accents |
| `--color-brand-accent`  | `#0075A3` | Secondary accent (WCAG AA)                   |
| `--color-brand-highlight`| `#46CBFF`| Bright highlight / emphasis                  |
| Ink                     | `#1e1f24` | The mark (charcoal)                          |
| Ink (on dark)           | `#f3f2ef` | Mark inverted for dark surfaces              |
| Brand on dark           | `#3d92e8` | Primary lifted for dark backgrounds          |
| Tile gradient           | `#ffffff` → `#eceae6` | Squircle ground                  |

### Supporting palette (from the blog brand)
| Token                     | Hex       | Role                          |
|---------------------------|-----------|-------------------------------|
| `--color-surface-primary` | `#F8F9FA` | Main background               |
| `--color-surface-tertiary`| `#E9ECEF` | Borders, subtle backgrounds   |
| `--color-text-primary`    | `#1A1A1A` | Primary text                  |
| `--color-text-secondary`  | `#374151` | Secondary text (WCAG AA)      |

### Product UI application

The editor shell is a dense product surface. Use the brand blue for active
selection, focus rings, dirty indicators, running status, links, and primary
commands. Do not use red as the app accent.

Semantic state colours are separate from brand colour:

| Token       | Role                                      |
|-------------|-------------------------------------------|
| `--warning` | Index caps, permission prompts, recoverable warnings |
| `--danger`  | Delete, destructive confirmations, failed loads/errors |

Current app chrome uses blue-tinted OKLCH neutrals for light and dark themes.
Keep the compact workbench rhythm: 6px controls, low-contrast borders, no
marketing-style hero treatment, no nested cards, and no decorative gradients in
the app UI.

---

## Principles
- **Austere & minimal.** One idea, one accent, no decoration.
- **Legible as a wordmark.** "ıde" reads at a glance and stays legible down
  to 16px; the leaf and caret carry the personality without adding noise.
- **Fast & light.** It should feel weightless — same as the app.
- **One tile, one accent.** The dark tile and single teal accent are meant to
  hold their own in a colourful dock without extra ornamentation.

## Assets & install
See `README.md` in the icon-assets pack. Quickest path: copy
`src-tauri-icons/` into your project's `src-tauri/icons/`. Or regenerate per
platform with `npm run tauri icon "app-icon/icon-1024.png"`.

## Editing
All PNGs are generated from the SVGs in `app-icon/`. To change the mark, edit
the `<text>` (wordmark), leaf `<path>`, or caret `<rect>` inside `icon.svg`
and `icon-square.svg` together, then re-export. To change the accent, swap
`#22d3ee` everywhere — it appears on the leaf and the caret only.
