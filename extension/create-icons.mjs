/**
 * LinkedReach — Icon generator
 * Tries to use `canvas` package for proper sized PNGs.
 * Falls back to writing a minimal valid PNG placeholder.
 */
import { writeFileSync, mkdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const iconsDir = join(__dirname, 'icons')
mkdirSync(iconsDir, { recursive: true })

// Minimal valid 1x1 blue pixel PNG (base64)
const PLACEHOLDER_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function writePlaceholder(name) {
  const buf = Buffer.from(PLACEHOLDER_B64, 'base64')
  const dest = join(iconsDir, name)
  writeFileSync(dest, buf)
  console.log('Wrote placeholder →', dest)
}

async function tryCanvas() {
  let createCanvas
  try {
    const mod = await import('canvas')
    createCanvas = mod.createCanvas
  } catch (_) {
    return false
  }

  const sizes = [16, 48, 128]
  for (const size of sizes) {
    const canvas = createCanvas(size, size)
    const ctx = canvas.getContext('2d')

    // Blue rounded square background
    const r = Math.round(size * 0.2)
    ctx.fillStyle = '#2563eb'
    ctx.beginPath()
    ctx.moveTo(r, 0)
    ctx.lineTo(size - r, 0)
    ctx.quadraticCurveTo(size, 0, size, r)
    ctx.lineTo(size, size - r)
    ctx.quadraticCurveTo(size, size, size - r, size)
    ctx.lineTo(r, size)
    ctx.quadraticCurveTo(0, size, 0, size - r)
    ctx.lineTo(0, r)
    ctx.quadraticCurveTo(0, 0, r, 0)
    ctx.closePath()
    ctx.fill()

    // White "L" letter
    ctx.fillStyle = '#ffffff'
    ctx.font = `bold ${Math.round(size * 0.62)}px sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('L', size / 2, size / 2 + size * 0.03)

    const dest = join(iconsDir, `icon${size}.png`)
    writeFileSync(dest, canvas.toBuffer('image/png'))
    console.log(`Generated ${size}x${size} →`, dest)
  }
  return true
}

const ok = await tryCanvas()
if (!ok) {
  console.log('canvas not available — writing placeholder PNGs')
  writePlaceholder('icon16.png')
  writePlaceholder('icon48.png')
  writePlaceholder('icon128.png')
}
