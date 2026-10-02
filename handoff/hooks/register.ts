import type { EngineInterface, On, RenderElement, RenderSurface } from 'claude-code'

type Api = EngineInterface
export type State = 'todo' | 'ran' | 'confirmed' | 'done' | 'dismissed'
export type Item = { id: string; cmd: string; label: string; repo: string; root: string; createdAt: number; state: State; updatedAt: number }
type Found = { cmd: string; label: string }

export const PREFIX = 'handoff:'
export const KEEP_MS = 7 * 24 * 60 * 60_000
const PANE = 'handoff'
const SHELLS = new Set(['bash', 'sh', 'shell', 'zsh', 'console'])
const FINISHED: State[] = ['confirmed', 'done', 'dismissed']
const PERSON = ['composer', 'bridge', 'sdk']
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([\w-]*)[^\n]*\n([\s\S]*?)\n {0,3}\1[`~]*[ \t]*$/gm
// Words that hand a command over. "run" alone is the common one; Claude narrating its own
// run ("I'll run", "let me run") is excluded, and "ran"/"runs" never match.
const CUE = /(?<!\b(?:I|I'll|let me|we'll) )\brun\b|\bpaste\b|with `!`|\byourself\b|\byou(?:'ll| will)? need to\b|\bfor you\b/i
const DONE = /\[done #([a-z0-9]+)\]/gi

let items: Item[] = []
let all: Item[] = []
let isAll = false
let writes: Promise<unknown> = Promise.resolve()

export function hash(text: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36).padStart(7, '0')
}

const norm = (text: string) => text.replace(/<\/?bash-input>/g, ' ').replace(/\s+/g, ' ').trim()
const basename = (path: string) => path.split('/').filter(Boolean).pop() ?? path
const isPending = (i: Item) => i.state === 'todo' || i.state === 'ran'

function commands(body: string, lang: string): Found[] {
  const out: Found[] = []
  let label = ''
  let cur = ''
  for (const raw of body.split('\n')) {
    let line = raw.trim()
    // A console block mixes prompts and output; only `$ ` lines (and their continuations) are commands.
    if (lang === 'console' && !cur) {
      if (!line.startsWith('$ ')) continue
      line = line.slice(2).trim()
    }
    if (!line) continue
    if (!cur && line.startsWith('#')) {
      label = line.replace(/^#+\s*/, '')
      continue
    }
    cur = cur ? `${cur} ${line}` : line
    if (/(\\|&&|\|\|?)$/.test(cur)) {
      cur = cur.replace(/\s*\\$/, '')
      continue
    }
    out.push({ cmd: cur, label })
    cur = ''
    label = ''
  }
  if (cur) out.push({ cmd: cur, label })
  return out
}

/** Shell blocks in a reply whose surrounding prose hands them to the person. */
export function handoffs(reply: string): Found[] {
  const found: Found[] = []
  let prevEnd = 0
  for (const m of reply.matchAll(FENCE)) {
    const end = m.index + m[0].length
    const before = reply.slice(prevEnd, m.index).slice(-400)
    const after = reply.slice(end, end + 200).split(/^ {0,3}(?:```|~~~)/m)[0] ?? ''
    prevEnd = end
    const lang = (m[2] ?? '').toLowerCase()
    if (SHELLS.has(lang) && CUE.test(before + '\n' + after)) found.push(...commands(m[3] ?? '', lang))
  }
  return found
}

async function load($: Api, root: string) {
  return ((await $.store.get(PREFIX + hash(root))) ?? []) as Item[]
}

async function loadAll($: Api) {
  const keys = (await $.store.keys()).filter(k => k.startsWith(PREFIX))
  return (await Promise.all(keys.map(k => $.store.get(k) as Promise<Item[]>))).flat()
}

// The store has no transactions: every read-modify-write waits for the one before it.
function change($: Api, root: string, fn: (list: Item[], now: number) => Item[]) {
  const run = writes.then(async () => {
    const now = await $.clock.now()
    const list = fn(await load($, root), now).filter(i => !FINISHED.includes(i.state) || now - i.updatedAt < KEEP_MS)
    await $.store.set(PREFIX + hash(root), list)
    if (root === (await $.session.root())) items = list
    if (isAll) all = await loadAll($)
    $.ui.invalidate('ui.render')
  })
  writes = run.catch(() => undefined)
  return run
}

function setState($: Api, item: Item, state: State) {
  return change($, item.root, (list, now) => list.map(i => (i.id === item.id ? { ...i, state, updatedAt: now } : i)))
}

async function capture($: Api, found: Found[], confirmed: string[]) {
  const root = await $.session.root()
  await change($, root, (list, now) => {
    const out = [...list]
    for (const f of found) {
      const id = hash(`${root}\n${f.cmd}`).slice(0, 6)
      const at = out.findIndex(i => i.id === id)
      const old = out[at]
      if (!old) out.push({ id, cmd: f.cmd, label: f.label, repo: basename(root), root, createdAt: now, state: 'todo', updatedAt: now })
      else if (FINISHED.includes(old.state)) out[at] = { ...old, label: f.label || old.label, state: 'todo', updatedAt: now }
    }
    return out.map(i => (confirmed.includes(i.id) && isPending(i) ? { ...i, state: 'confirmed', updatedAt: now } : i))
  })
}

// Space-bounded so `ls` does not match inside "also".
async function markRan($: Api, text: string) {
  const said = ` ${norm(text)} `
  const hits = items.filter(i => i.state === 'todo' && said.includes(` ${norm(i.cmd)} `)).map(i => i.id)
  if (hits.length === 0) return
  await change($, await $.session.root(), (list, now) => list.map(i => (hits.includes(i.id) && i.state === 'todo' ? { ...i, state: 'ran', updatedAt: now } : i)))
}

async function open($: Api, everywhere: boolean) {
  isAll = everywhere
  if (everywhere) all = await loadAll($)
  $.ui.invalidate('ui.render')
  await $.ui.open({ id: PANE, title: everywhere ? 'Handoff: all repos' : 'Handoff', focus: true, closeOnEscape: true })
}

async function copy($: Api, text: string, what: string, surface: RenderSurface) {
  if (!text) return $.ui.toast('handoff: nothing to copy')
  const copied = await $.ui.copy({ text, surface })
  $.ui.toast(copied.isCopied ? `handoff: copied ${what}` : `handoff: not copied: ${copied.reason}`)
}

function act($: Api, work: () => Promise<unknown>) {
  work().catch(err => $.ui.toast(`handoff: ${err instanceof Error ? err.message : String(err)}`))
}

function ago(ms: number) {
  const m = Math.floor(ms / 60_000)
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`
}

export function register(on: On) {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    items = await load($, await $.session.root())
    await $.command.register({ name: 'handoff', description: 'Commands Claude asked you to run: open the list, add one, or show every repo', argumentHint: '[add <cmd> | all]', immediate: true })
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    const found = handoffs(e.answer)
    const confirmed = [...e.answer.matchAll(DONE)].map(m => (m[1] ?? '').toLowerCase())
    if (found.length > 0 || confirmed.length > 0) await capture($, found, confirmed)
    return result
  })

  // Bash mode (`!cmd`) raises no prompt.submit; the engine appends it as a user row
  // `<bash-input>cmd</bash-input>`, and session.append fires for every row it keeps.
  on('session.append', async ($, e, next) => {
    if (e.agentId !== undefined || e.message.type !== 'user') return next(e)
    const text = e.message.content.map(b => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n')
    const input = /^\s*<bash-input>([\s\S]*)<\/bash-input>/.exec(text)?.[1]
    if (input) await markRan($, input)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    items = await load($, await $.session.root())
    if (PERSON.includes(e.origin.kind)) await markRan($, e.text)
    const pending = items.filter(isPending)
    if (pending.length === 0) return next(e)
    const note = [
      'Commands you handed the user to run themselves, not yet verified:',
      ...pending.map(i => `#${i.id} ${i.cmd}`),
      'When you have verified one of these took effect, write [done #id] in your reply.',
    ].join('\n')
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    const args = e.args.trim()
    if (args === 'add' || args.startsWith('add ')) {
      const cmd = args.slice(3).trim()
      if (!cmd) $.ui.toast('handoff: usage /handoff add <cmd>')
      else {
        await capture($, [{ cmd, label: '' }], [])
        $.ui.toast(`handoff: added ${cmd}`)
      }
      return {}
    }
    await open($, args === 'all')
    return {}
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const todo = items.filter(i => i.state === 'todo').length
    const ran = items.filter(i => i.state === 'ran').length
    if (todo + ran === 0) return below
    const { Box, Text, Button } = $.ui.resolve(e)
    const counts = [todo > 0 && `☐ ${todo} to run`, ran > 0 && `✓ ${ran} ran`].filter(Boolean).join('  ')
    // No hotkey: a bare digit typed into an empty prompt presses a band button.
    const row = Box({ flexDirection: 'row', columnGap: 2, paddingX: 1, children: [
      Text({ children: `handoff  ${counts}` }),
      Button({ key: 'handoff-open', label: 'Open', dimColor: true, onPress: () => act($, () => open($, false)) }),
    ] })
    return Box({ flexDirection: 'column', children: [row, below] })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const now = await $.clock.now()
    const list = isAll ? all : items
    let n = 0
    const row = (i: Item) => {
      const head: RenderElement[] = []
      if (i.label) head.push(Text({ bold: true, children: i.label }))
      head.push(Text({ dimColor: true, children: `${isAll ? `${i.repo} · ` : ''}#${i.id} · ${ago(now - i.createdAt)}` }))
      const buttons: RenderElement[] = [Button({ key: `copy:${i.id}`, label: 'Copy', onPress: press => act($, () => copy($, i.cmd, `#${i.id}`, press.surface)) })]
      if (isPending(i)) buttons.push(Button({ key: `check:${i.id}`, label: '✓', ...(++n <= 9 ? { hotkey: String(n) } : {}), onPress: () => act($, () => setState($, i, 'done')) }))
      buttons.push(Button({ key: `dismiss:${i.id}`, label: '✕', onPress: () => act($, () => setState($, i, 'dismissed')) }))
      return Box({ key: `item:${i.id}`, flexDirection: 'column', children: [
        Box({ flexDirection: 'row', columnGap: 2, children: head }),
        Box({ paddingLeft: 2, children: [Code({ source: i.cmd, language: 'bash' })] }),
        Box({ flexDirection: 'row', columnGap: 1, paddingLeft: 2, children: buttons }),
      ] })
    }
    const groups: [string, State[]][] = [['To run', ['todo']], ['Ran (awaiting confirm)', ['ran']], ['Done', ['confirmed', 'done']]]
    const sections = groups.flatMap(([title, states]) => {
      const rows = list.filter(i => states.includes(i.state))
      return rows.length === 0 ? [] : [Box({ key: title, flexDirection: 'column', marginTop: 1, children: [Text({ bold: true, children: `${title} (${rows.length})` }), ...rows.map(row)] })]
    })
    const todo = list.filter(i => i.state === 'todo')
    const finished = list.filter(i => i.state === 'confirmed' || i.state === 'done')
    const clear = async () => {
      for (const root of new Set(finished.map(i => i.root))) await change($, root, l => l.filter(i => i.state !== 'confirmed' && i.state !== 'done'))
    }
    const actions = Box({ flexDirection: 'row', columnGap: 2, children: [
      Button({ key: 'copy-all', label: 'Copy all to run', hotkey: 'c', onPress: press => act($, () => copy($, todo.map(i => i.cmd).join('\n'), `${todo.length} commands`, press.surface)) }),
      Button({ key: 'clear-done', label: 'Clear done', hotkey: 'x', onPress: () => act($, clear) }),
    ] })
    if (sections.length === 0) return Box({ flexDirection: 'column', paddingX: 1, children: [Text({ dimColor: true, children: 'Nothing handed off.' })] })
    return Box({ flexDirection: 'column', paddingX: 1, children: [actions, ...sections] })
  })
}
