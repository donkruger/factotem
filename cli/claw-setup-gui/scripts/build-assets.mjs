#!/usr/bin/env node

/**
 * Regenerate the DMG / installer build assets from the SVG masters.
 *
 *   build/icon-master.svg       →  build/icon.png  (1024×1024)
 *                               →  build/icon.icns (macOS multi-resolution)
 *                               →  build/icon.ico  (Windows multi-resolution)
 *   build/background-master.svg →  build/background.png (540×380)
 *                               →  build/background@2x.png (1080×760)
 *
 * Run with `node scripts/build-assets.mjs` after editing either SVG.
 *
 * Requires:
 *   - ImageMagick `convert` on PATH (PNG + ICO rendering)
 *   - librsvg (vendored with ImageMagick on most distros)
 *   - png2icons npm package (already in devDependencies)
 *
 * The .icns file is generated via png2icons (pure-JS) rather than the
 * macOS-only `iconutil` so the script works on every CI runner.
 */

import { execSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createICNS, BICUBIC } from 'png2icons'

const buildDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'build')
const run = (cmd) => execSync(cmd, { cwd: buildDir, stdio: 'inherit' })

console.log('→ icon.png (1024×1024)')
run('convert -background none -density 384 icon-master.svg -resize 1024x1024 icon.png')

console.log('→ icon.ico (16/32/48/64/128/256)')
run('convert -background none icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico')

console.log('→ background.png + @2x')
run('convert -background none -density 192 background-master.svg -resize 540x380 background.png')
run('convert -background none -density 384 background-master.svg -resize 1080x760 background@2x.png')

console.log('→ icon.icns')
const png = readFileSync(join(buildDir, 'icon.png'))
const icns = createICNS(png, BICUBIC, 0)
if (!icns) {
  console.error('png2icons.createICNS returned null')
  process.exit(1)
}
writeFileSync(join(buildDir, 'icon.icns'), icns)

console.log('done — assets in', buildDir)
