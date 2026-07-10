# ide — app icon assets

The **Leaf dot + caret** mark. A lowercase "ıde" wordmark with a teal xylem-leaf
dot and a caret bar, on a dark rounded-square tile.

---

## 🚀 Quickest path (recommended)

You have two options:

**A. Drop-in (no tooling).** Copy everything in `src-tauri-icons/` into your
project's `src-tauri/icons/` folder, replacing what's there. The file names
match Tauri's defaults exactly, so `tauri.conf.json` needs no changes.

**B. Regenerate from the master (best fidelity per platform).** From your
project root run:

```bash
npm run tauri icon "ide icon assets/app-icon/icon-1024.png"
# or:  cargo tauri icon "ide icon assets/app-icon/icon-1024.png"
```

This regenerates the full `src-tauri/icons/` set (incl. `.icns`/`.ico`) from
the 1024px master. Either path works — **A** is faster, **B** lets Tauri's
generator tune each platform.

---

## 📁 What's in here

```
app-icon/            The full app icon (tile + wordmark)
  icon.svg             vector master — rounded-square background
  icon-animated.svg    README/web version — blinking caret, wordmark rasterised
                       (embeds icon-512.png so no font is needed in <img> use)
  icon-square.svg       vector — square background to the edges (web/marketing)
  icon-square-*.png    raster of the square version
  icon-16…1024.png     raster ladder (rounded-square tile)

src-tauri-icons/     ← drop straight into src-tauri/icons/
  32x32.png  128x128.png  128x128@2x.png  icon.png
  icon.icns  (macOS)   icon.ico  (Windows)
  Square*Logo.png  StoreLogo.png   (Windows Store / MSIX)
```

There's no `mark/` pack (bare mark on transparency) in this drop. The
wordmark's ink colour (`#e8eef6`) only reads correctly on the dark tile, and
nothing in the app currently consumes a transparent or single-colour cutout
— there's no tray/menu-bar icon. Add one if a future use case needs it.

---

## 🔺 Two background forms (SVG)

| File                        | Background                                                    |
|------------------------------|----------------------------------------------------------------|
| `app-icon/icon.svg`         | Rounded-square tile (macOS app-icon look)                     |
| `app-icon/icon-square.svg`  | Same mark, square background to the edges (web/marketing use) |

---

## 🎨 Tokens

| Role            | Value       |
|-----------------|-------------|
| Ink (wordmark)  | `#e8eef6`   |
| Accent (teal)   | `#22d3ee`   |
| Tile            | `#0b1120`   |
| Corner shape    | Rounded square, `rx=115` on a 512 canvas (~22.5%) |

The tile is intentionally **dark** — it stands out among the colourful icons
in a dock while staying minimal. No drop-shadow is baked into the OS icons;
macOS/Windows add their own.

## ✏️ Editing
Every PNG is regenerated from the SVGs. To tweak the mark, edit the `<text>`
wordmark, leaf `<path>`, or caret `<rect>` inside `icon.svg` and
`icon-square.svg` together, then re-export.
