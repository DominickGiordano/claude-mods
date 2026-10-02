export type Bucket = { usd: number; tokens: number }
export type Day = { repos: Record<string, Bucket>; branches: Record<string, Bucket>; models: Record<string, Bucket> }
export type Entry = { repo: string; branch: string; model: string; usd: number; tokens: number }

export const KEEP_DAYS = 30
const PREFIX = 'meter:'

// Calendar arithmetic, not ms arithmetic, so a DST change never skips or repeats a day.
export function dayOf(now: number, back = 0): string {
  const d = new Date(now)
  d.setDate(d.getDate() - back)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function keyOf(now: number, back = 0): string {
  return PREFIX + dayOf(now, back)
}

export function isExpired(key: string, now: number): boolean {
  return /^meter:\d{4}-\d{2}-\d{2}$/.test(key) && key < keyOf(now, KEEP_DAYS - 1)
}

function bump(buckets: Record<string, Bucket>, name: string, entry: Entry): Record<string, Bucket> {
  const b = buckets[name] ?? { usd: 0, tokens: 0 }
  return { ...buckets, [name]: { usd: b.usd + entry.usd, tokens: b.tokens + entry.tokens } }
}

export function addTo(day: Day | undefined, entry: Entry): Day {
  const d = day ?? { repos: {}, branches: {}, models: {} }
  return {
    repos: bump(d.repos, entry.repo, entry),
    branches: bump(d.branches, `${entry.branch} (${entry.repo})`, entry),
    models: bump(d.models, entry.model, entry),
  }
}

function sum(into: Record<string, Bucket>, from: Record<string, Bucket>) {
  for (const [name, b] of Object.entries(from)) {
    const t = (into[name] ??= { usd: 0, tokens: 0 })
    t.usd += b.usd
    t.tokens += b.tokens
  }
}

export function merge(days: readonly (Day | undefined)[]): Day {
  const all: Day = { repos: {}, branches: {}, models: {} }
  for (const d of days) {
    if (!d) continue
    sum(all.repos, d.repos)
    sum(all.branches, d.branches)
    sum(all.models, d.models)
  }
  return all
}

export function total(buckets: Record<string, Bucket>): Bucket {
  return Object.values(buckets).reduce((t, b) => ({ usd: t.usd + b.usd, tokens: t.tokens + b.tokens }), { usd: 0, tokens: 0 })
}

export function top(buckets: Record<string, Bucket>, n = 5): [string, Bucket][] {
  return Object.entries(buckets)
    .sort(([, a], [, b]) => b.usd - a.usd)
    .slice(0, n)
}
