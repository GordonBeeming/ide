# ide — design

Design notes for **ide**, a fast, lightweight, cross-platform code editor
(Tauri). This file is the single source of truth for the icon and brand colour.

---

## Icon — "Stagger"

An abstract, letterless mark: **three staggered lines of code**, the top one
live in the brand blue, the rest charcoal. It reads as an editor at a glance,
stays legible down to 16px, and inverts cleanly for dark surfaces. It sits on
a light "paper" squircle so it stands out among colourful dock icons while
staying minimal.

**Geometry** — drawn in a 100×100 box, three rounded bars:

| Bar    | x  | y    | w  | h | radius | fill            |
|--------|----|------|----|---|--------|-----------------|
| top    | 27 | 32   | 46 | 9 | 4.5    | brand primary   |
| middle | 27 | 48.5 | 31 | 9 | 4.5    | ink `#1e1f24`   |
| bottom | 27 | 65   | 39 | 9 | 4.5    | ink `#1e1f24`   |

Tile: Apple superellipse (squircle, n≈5), white→`#eceae6` vertical gradient
with a soft top sheen and a 0.7px `rgba(20,20,25,.08)` edge. App-icon variants
inset the tile ~6% for macOS optical padding; full-bleed/web variants don't.

### Three background forms
| File                       | Background                          |
|----------------------------|-------------------------------------|
| `app-icon/icon.svg`        | Squircle tile (macOS app-icon look) |
| `mark/mark.svg`            | Transparent — bare mark only        |
| `app-icon/icon-square.svg` | Square gradient, runs to the edges  |

---

## Colour

Brand primary comes from the blog palette and is the **one accent** in the
icon. Everything else is charcoal or paper-neutral.

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
- **Letterless.** The mark carries meaning through form, not type.
- **Fast & light.** It should feel weightless — same as the app.
- **Inverts cleanly.** Works on light and dark; the mono mark suits the
  macOS menu-bar (tray) as a template image.

## Assets & install
See `README.md` in the icon-assets pack. Quickest path: copy
`src-tauri-icons/` into your project's `src-tauri/icons/`. Or regenerate per
platform with `npm run tauri icon "app-icon/icon-1024.png"`.

## Editing
All PNGs are generated from the SVGs. To change the mark, edit the three
`<rect>`s in `mark.svg` (or the glyph inside `icon.svg`) and re-export. To
change the accent, swap `#0063B2` everywhere — it appears only on the top bar.
