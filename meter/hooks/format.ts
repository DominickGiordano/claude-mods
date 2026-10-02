import type { ModelUsage } from 'claude-code'

export function short(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

export function levelColor(percent: number): string {
  if (percent >= 80) return 'red'
  if (percent >= 50) return 'yellow'
  return 'green'
}

const PARTIAL = ' ▏▎▍▌▋▊▉'

// The filled run, ending in an eighth-cell partial, and the track after it.
export function bar(percent: number, cells: number): [string, string] {
  const eighths = Math.round((Math.min(100, Math.max(0, percent)) / 100) * cells * 8)
  const full = Math.floor(eighths / 8)
  const part = eighths % 8
  return ['█'.repeat(full) + (part ? PARTIAL[part] : ''), '░'.repeat(cells - full - (part ? 1 : 0))]
}

export function until(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((at - now) / 60_000))
  const h = Math.floor(minutes / 60)
  return h > 0 ? `${h}h ${minutes % 60}m` : `${minutes}m`
}

// The one meaning of "tok" in the ledger: everything the request read or wrote, cache reads
// included. The spinner counts only uncached input plus output, the part a turn adds.
export function totalTokens(u: ModelUsage): number {
  return u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens
}

export type CacheTotals = { read: number; written: number; uncached: number }

export function cachePercent(c: CacheTotals): number | null {
  const all = c.read + c.written + c.uncached
  return all === 0 ? null : Math.round((c.read / all) * 100)
}

const EIGHTHS = ' ▁▂▃▄▅▆▇█'

// Rows top to bottom, bars two cells wide with one between, in eighth-cell steps.
// A nonzero day gets at least one eighth so it never draws as an empty day.
export function barRows(values: readonly number[], rows: number): string[] {
  const top = Math.max(...values)
  const heights = values.map(v => (v > 0 ? Math.max(1, Math.round((v / top) * rows * 8)) : 0))
  return Array.from({ length: rows }, (_, r) => {
    const floor = (rows - 1 - r) * 8
    return heights.map(h => EIGHTHS[Math.max(0, Math.min(8, h - floor))]!.repeat(2)).join(' ')
  })
}
