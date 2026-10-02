const EIGHTHS = ' ▁▂▃▄▅▆▇█'
const BAR_WIDTH = 2
const GAP = 1

// Rows top to bottom; each bar is BAR_WIDTH cells with GAP between, in eighth-cell steps.
export function barRows(values: readonly number[], rows: number): string[] {
  const top = Math.max(...values, Number.MIN_VALUE)
  const heights = values.map(v => Math.round((v / top) * rows * 8))
  return Array.from({ length: rows }, (_, r) => {
    const floor = (rows - 1 - r) * 8
    return heights
      .map(h => EIGHTHS[Math.max(0, Math.min(8, h - floor))]!.repeat(BAR_WIDTH))
      .join(' '.repeat(GAP))
  })
}

const DEFAULT_COLOR = 0x01000000

// Raster cells: row-major little-endian u32 triplets [codePoint, fg, bg], base64.
export function rasterCells(lines: readonly string[], fg: number): string {
  const words = new Uint32Array(lines.reduce((n, l) => n + l.length, 0) * 3)
  let i = 0
  for (const line of lines) {
    for (const ch of line) {
      words[i++] = ch.codePointAt(0)!
      words[i++] = ch === ' ' ? DEFAULT_COLOR : fg
      words[i++] = DEFAULT_COLOR
    }
  }
  let binary = ''
  for (const byte of new Uint8Array(words.buffer)) binary += String.fromCharCode(byte)
  return btoa(binary)
}
