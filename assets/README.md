# ide — app icon assets

The **Stagger** mark. Charcoal `#1e1f24` + one blue `#2f6cf0` on a light "paper" squircle.

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
app-icon/            The full app icon (squircle tile + mark)
  icon.svg             vector master — SQUIRCLE background, macOS padding
  icon-fullbleed.svg   vector — squircle fills the frame (favicons, web)
  icon-square.svg      vector — SQUARE background to the edges (no rounding)
  icon-square-*.png    raster of the square version
  icon-16…1024.png     raster ladder (squircle)

mark/                The bare mark on transparency (no tile)
  mark.svg             vector, 2-colour
  mark-mono.svg        vector, single-colour (menu-bar / tray / stamps)
  mark-32…1024.png     raster, transparent
  mark-mono-512.png

src-tauri-icons/     ← drop straight into src-tauri/icons/
  32x32.png  128x128.png  128x128@2x.png  icon.png
  icon.icns  (macOS)   icon.ico  (Windows)
  Square*Logo.png  StoreLogo.png   (Windows Store / MSIX)
```

---

## 🔺 Three background forms (SVG)

| File                       | Background                         |
|----------------------------|------------------------------------|
| `app-icon/icon.svg`        | Squircle tile (macOS app-icon look)|
| `mark/mark.svg`            | Transparent — bare mark only       |
| `app-icon/icon-square.svg` | Square gradient, runs to the edges |

---

## 🎨 Tokens

| Role            | Value       |
|-----------------|-------------|
| Ink (mark)      | `#1e1f24`   |
| Accent (blue)   | `#2f6cf0`   |
| Tile gradient   | `#ffffff` → `#eceae6` |
| Corner shape    | Apple superellipse (squircle), n≈5 |

The tile is intentionally **light** — it stands out among the colourful icons
in a dock while staying minimal. No drop-shadow is baked into the OS icons;
macOS/Windows add their own.

## 🧩 Using the bare mark
The mark in `mark/` sits on full transparency and inverts cleanly: use the
charcoal version on light surfaces and recolour to off-white on dark ones.
For a macOS menu-bar (tray) **template** image, use `mark-mono.svg` — the
system tints single-colour template icons automatically.

## ✏️ Editing
Every PNG is regenerated from the SVGs. To tweak the mark, edit the three
`<rect>`s in `mark.svg` (or the glyph inside `icon.svg`) and re-export.
