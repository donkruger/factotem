# Build assets

DMG / installer artifacts. Two SVG masters source everything that ends
up inside the `nanoclaw-setup.dmg` and `nanoclaw-setup.exe` bundles.

## Inventory

| File | Source | Purpose |
|---|---|---|
| `icon-master.svg` | hand-authored | Source of truth for the app icon |
| `icon.png` | generated | 1024×1024 master used by electron-builder fallbacks |
| `icon.icns` | generated | macOS app icon (multi-resolution) |
| `icon.ico` | generated | Windows app icon (16/32/48/64/128/256) |
| `background-master.svg` | hand-authored | Source of truth for DMG window background |
| `background.png` | generated | DMG window background (540×380) |
| `background@2x.png` | generated | DMG window background, Retina (1080×760) |
| `entitlements.mac.plist` | hand-authored | Hardened-runtime entitlements for macOS notarization |

## Regenerate

After editing either SVG, regenerate the binaries:

```bash
npm run build:assets
```

That runs `scripts/build-assets.mjs`, which uses ImageMagick + librsvg
for PNG/ICO and the pure-JS `png2icons` package for ICNS. The script
works on every platform — no `iconutil` (macOS-only) dependency.

## Design

The v0.1 mascot is a stylised "Andy" claw — warm orange `#ff7a3a` body
+ near-black ink eyes/smile, soft pink-orange halo on the icon
background. It matches the Factotem dashboard's palette without
copying it (the dashboard doesn't have a mascot — only the wizard does).

The DMG background shows the wordmark at the top, an arrow between
the two icon anchor points (where the app and the Applications symlink
will appear), and a one-line caption telling the user to drag.

Both are intended as **v0.1 placeholders** — sufficient to ship a
public release that doesn't look broken, but a real commissioned
mascot is queued for v0.2. See `claw-setup-gui/CLAUDE.md` § Future
work.

## Icon anchor points (electron-builder.yml)

The DMG layout is fixed in `electron-builder.yml`:

```yaml
window: { width: 540, height: 380 }
contents:
  - x: 144   y: 178             # app icon
  - x: 396   y: 178   type: link path: /Applications
```

Any redesign of `background-master.svg` must keep those two positions
visually empty so the icons read cleanly. If you move the anchor
points, update the SVG centre arrow + caption to match.
