import type { EngineInterface, On, RenderElement, RenderSurface } from 'claude-code'

type Api = EngineInterface
export type State = 'todo' | 'ran' | 'confirmed' | 'done' | 'dismissed'
export type Item = { id: string; cmd: string; label: string; repo: string; root: string; createdAt: number; state: State; updatedAt: number }
type Found = { cmd: string; label: string }

export const PREFIX = 'handoff:'
export const KEEP_MS = 7 * 24 * 60 * 60_000
const FRESH_MS = 48 * 60 * 60_000
const PANE = 'handoff'
const FINISHED: State[] = ['confirmed', 'done', 'dismissed']
// sec-default bypasses a user mod's prompt.compose and prompt.section, so this rides the first
// person prompt of each conversation instead; once in history it is part of the cached prefix.
const INSTRUCTION = 'When you give the user shell commands to run themselves, put them in a ```handoff fenced block (one block per task, a leading `# comment` line as its label).'
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*handoff[ \t]*\n([\s\S]*?)\n {0,3}\1[`~]*[ \t]*$/gm
const DONE = /\[done #([a-z0-9]+)\]/gi
// What a pasted terminal line puts before the command: `❯ `, `$ `, `% `, `user@host:/x# `.
const SHELL_PROMPT = /[❯$%#➜›]\s+$/

let items: Item[] = []
let all: Item[] = []
let isAll = false
let showDismissed = false
let storeError: string | null = null
let isInstructed = false
let writes: Promise<unknown> = Promise.resolve()

function fnv(text: string, seed: number) {
  let h = seed
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36).padStart(7, '0')
}

export const hash = (text: string) => fnv(text, 0x811c9dc5) + fnv(text, 0x050c5d1f)

const isPending = (i: Item) => i.state === 'todo' || i.state === 'ran'
const unwrap = (text: string) => text.replace(/\\\r?\n\s*/g, ' ')

function isItem(v: unknown): v is Item {
  const i = v as Record<string, unknown>
  return typeof v === 'object' && v !== null && ['id', 'cmd', 'label', 'repo', 'root'].every(k => typeof i[k] === 'string') &&
    Number.isFinite(i.createdAt) && Number.isFinite(i.updatedAt) && ['todo', 'ran', ...FINISHED].includes(i.state as State)
}

/** ```handoff blocks, each whole; a leading `# comment` is the label. */
export function handoffs(reply: string): Found[] {
  return [...reply.matchAll(FENCE)].flatMap(m => {
    const lines = (m[2] ?? '').replace(/^\s*\n/, '').split('\n')
    const first = lines[0]?.trim() ?? ''
    const isLabel = first.startsWith('#') && !first.startsWith('#!')
    const cmd = (isLabel ? lines.slice(1) : lines).join('\n').trim()
    const label = isLabel ? first.replace(/^#+\s*/, '') : (cmd.split('\n')[0] ?? '').slice(0, 60)
    return cmd ? [{ cmd, label }] : []
  })
}

/** True when the prompt holds a pasted terminal line: a shell prompt, then the block's first command. */
export function echoes(prompt: string, cmd: string) {
  const first = (unwrap(cmd).split('\n').find(l => l.trim() && !l.trim().startsWith('#')) ?? '').replace(/\s+/g, ' ').trim()
  if (!first) return false
  return unwrap(prompt).split('\n').some(line => {
    const l = line.replace(/\s+/g, ' ').trim()
    return l.endsWith(first) && SHELL_PROMPT.test(l.slice(0, l.length - first.length))
  })
}

function failed($: Api, err: unknown) {
  const why = err instanceof Error ? err.message : String(err)
  $.ui.log(`handoff: store unavailable: ${why}`)
  if (storeError === null) $.ui.toast(`handoff: store unavailable: ${why}`)
  storeError = why
  $.ui.invalidate('ui.render')
}

const valid = (v: unknown) => (Array.isArray(v) ? v.filter(isItem) : [])
const load = async ($: Api, root: string) => valid(await $.store.get(PREFIX + hash(root)))

async function loadAll($: Api) {
  const keys = (await $.store.keys()).filter(k => k.startsWith(PREFIX))
  return (await Promise.all(keys.map(k => $.store.get(k)))).flatMap(valid)
}

async function refresh($: Api) {
  try {
    items = await load($, await $.session.root())
    if (isAll) all = await loadAll($)
    storeError = null
    $.ui.invalidate('ui.render')
  } catch (err) {
    failed($, err)
  }
}

// The store has no transactions: every read-modify-write waits for the one before it.
function change($: Api, root: string, fn: (list: Item[], now: number) => Item[]) {
  const run = writes.then(async () => {
    const now = await $.clock.now()
    const list = fn(await load($, root), now).filter(i => !FINISHED.includes(i.state) || now - i.updatedAt < KEEP_MS)
    await $.store.set(PREFIX + hash(root), list)
    await refresh($)
  }).catch(err => failed($, err))
  writes = run
  return run
}

function setState($: Api, item: Item, state: State) {
  return change($, item.root, (list, now) => list.map(i => (i.id === item.id ? { ...i, state, updatedAt: now } : i)))
}

async function capture($: Api, found: Found[], confirmed: string[]) {
  const root = await $.session.root()
  return change($, root, (list, now) => {
    const out = [...list]
    for (const f of found) {
      let id = hash(`${root}\n${f.cmd}`)
      while (out.some(i => i.id === id && i.cmd !== f.cmd)) id = hash(id)
      const at = out.findIndex(i => i.id === id)
      const old = out[at]
      if (!old) out.push({ id, cmd: f.cmd, label: f.label, repo: root.split('/').filter(Boolean).pop() ?? root, root, createdAt: now, state: 'todo', updatedAt: now })
      else if (old.state !== 'todo' && old.state !== 'dismissed') out[at] = { ...old, label: f.label, state: 'todo', updatedAt: now }
    }
    return out.map(i => (confirmed.includes(i.id) && isPending(i) ? { ...i, state: 'confirmed', updatedAt: now } : i))
  })
}

async function open($: Api, everywhere: boolean) {
  isAll = everywhere
  await refresh($)
  await $.ui.open({ id: PANE, title: everywhere ? 'Handoff: all repos' : 'Handoff', focus: true, closeOnEscape: true })
}

async function copy($: Api, text: string, what: string, surface: RenderSurface) {
  const copied = await $.ui.copy({ text, surface })
  $.ui.toast(copied.isCopied ? `handoff: copied ${what}` : `handoff: not copied: ${copied.reason}`)
}

function act($: Api, work: () => Promise<unknown>) {
  work().catch(err => $.ui.toast(`handoff: ${err instanceof Error ? err.message : String(err)}`))
}

function ago(ms: number) {
  const m = Math.floor(ms / 60_000)
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`
}

export function register(on: On) {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'handoff', description: 'Commands Claude handed you to run: open the list, add one, or show every repo', argumentHint: '[add <cmd> | all]', immediate: true })
    await refresh($)
    return result
  })

  on('session.end', ($, e, next) => {
    isInstructed = false
    return next(e)
  })

  on('session.compact', ($, e, next) => {
    isInstructed = false
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer') return result
    const found = handoffs(e.answer)
    // Prose only: a tag inside code is an example, not a confirmation.
    const prose = e.answer.replace(/^ {0,3}(`{3,}|~{3,})[\s\S]*?^ {0,3}\1[`~]*[ \t]*$/gm, '').replace(/`[^`\n]*`/g, '')
    const confirmed = [...prose.matchAll(DONE)].map(m => (m[1] ?? '').toLowerCase())
    if (found.length > 0 || confirmed.length > 0) await capture($, found, confirmed)
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    if (!['composer', 'bridge', 'sdk'].includes(e.origin.kind)) return next(e)
    await refresh($)
    const ran = items.filter(i => i.state === 'todo' && echoes(e.text, i.cmd)).map(i => i.id)
    if (ran.length > 0) await change($, await $.session.root(), (list, now) => list.map(i => (ran.includes(i.id) && i.state === 'todo' ? { ...i, state: 'ran', updatedAt: now } : i)))
    const now = await $.clock.now()
    const pending = items.filter(i => isPending(i) && now - i.createdAt < FRESH_MS).sort((a, b) => b.createdAt - a.createdAt).slice(0, 5)
    const notes = isInstructed ? [] : [INSTRUCTION]
    isInstructed = true
    if (pending.length > 0) notes.push([...pending.map(i => `#${i.id} ${i.label}`), 'If you verify a handoff took effect, write [done #id].'].join('\n'))
    return notes.length === 0 ? next(e) : next({ ...e, context: [...(e.context ?? []), ...notes] })
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    const args = e.args.trim()
    if (args === '' || args === 'all') await open($, args === 'all')
    else if (args.startsWith('add ') && args.slice(4).trim()) {
      const cmd = args.slice(4).trim()
      await capture($, [{ cmd, label: cmd.slice(0, 60) }], [])
      if (storeError === null) $.ui.toast(`handoff: added ${cmd}`)
    } else $.ui.toast('handoff: usage /handoff [add <cmd> | all]')
    return {}
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const [todo, ran] = (['todo', 'ran'] as const).map(s => items.filter(i => i.state === s).length) as [number, number]
    if (todo + ran === 0 && storeError === null) return below
    const { Box, Text, Button } = $.ui.resolve(e)
    const counts = [todo > 0 && `☐ ${todo} to run`, ran > 0 && `✓ ${ran} ran`].filter(Boolean).join('  ')
    const text = storeError === null ? `handoff  ${counts}` : `handoff: store unavailable${counts ? `  (last seen ${counts})` : ''}`
    // No hotkey: a bare digit typed into an empty prompt presses a band button.
    const row = Box({ flexDirection: 'row', columnGap: 2, paddingX: 1, children: [
      Text({ color: storeError === null ? undefined : 'yellow', children: text }),
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
      const buttons: RenderElement[] = [Button({ key: `copy:${i.id}`, label: 'Copy', onPress: press => act($, () => copy($, i.cmd, i.label, press.surface)) })]
      if (isPending(i)) buttons.push(Button({ key: `check:${i.id}`, label: '✓', ...(++n <= 9 ? { hotkey: String(n) } : {}), onPress: () => act($, () => setState($, i, 'done')) }))
      if (i.state !== 'dismissed') buttons.push(Button({ key: `dismiss:${i.id}`, label: '✕', onPress: () => act($, () => setState($, i, 'dismissed')) }))
      return Box({ key: `item:${i.id}`, flexDirection: 'column', children: [
        Box({ flexDirection: 'row', columnGap: 2, children: [
          Text({ bold: true, children: i.label }),
          Text({ dimColor: true, children: `${isAll ? `${i.repo} · ` : ''}#${i.id} · ${ago(now - i.createdAt)}` }),
        ] }),
        Box({ paddingLeft: 2, children: [Code({ source: i.cmd, language: 'bash' })] }),
        Box({ flexDirection: 'row', columnGap: 1, paddingLeft: 2, children: buttons }),
      ] })
    }
    const groups: [string, State[]][] = [['To run', ['todo']], ['Ran (awaiting confirm)', ['ran']], ['Done', ['confirmed', 'done']]]
    const sections = groups.flatMap(([title, states]) => {
      const rows = list.filter(i => states.includes(i.state))
      return rows.length === 0 ? [] : [Box({ key: title, flexDirection: 'column', marginTop: 1, children: [Text({ bold: true, children: `${title} (${rows.length})` }), ...rows.map(row)] })]
    })
    const dismissed = list.filter(i => i.state === 'dismissed')
    if (dismissed.length > 0) {
      const toggle = Button({ key: 'toggle-dismissed', label: `Dismissed (${dismissed.length}) ${showDismissed ? '▾' : '▸'}`, plain: true, onPress: () => {
        showDismissed = !showDismissed
        $.ui.invalidate('ui.render')
      } })
      sections.push(Box({ key: 'Dismissed', flexDirection: 'column', marginTop: 1, children: [toggle, ...(showDismissed ? dismissed.map(row) : [])] }))
    }
    const todo = list.filter(i => i.state === 'todo')
    const finished = list.filter(i => FINISHED.includes(i.state))
    const clear = () => Promise.all([...new Set(finished.map(i => i.root))].map(root => change($, root, l => l.filter(i => !FINISHED.includes(i.state)))))
    const actions: RenderElement[] = []
    if (storeError !== null) actions.push(Text({ color: 'yellow', children: `handoff: store unavailable: ${storeError}` }))
    // Not across repos: pasting several repos' commands into one shell runs them in the wrong place.
    if (!isAll && todo.length > 0) actions.push(Button({ key: 'copy-all', label: 'Copy all to run', hotkey: 'c', onPress: press => act($, () => copy($, todo.map(i => i.cmd).join('\n'), `${todo.length} blocks`, press.surface)) }))
    actions.push(Button({ key: 'clear-done', label: 'Clear done', hotkey: 'x', onPress: () => act($, clear) }))
    const body = sections.length > 0 ? sections : [Text({ dimColor: true, children: 'Nothing handed off.' })]
    return Box({ flexDirection: 'column', paddingX: 1, children: [Box({ flexDirection: 'row', columnGap: 2, children: actions }), ...body] })
  })
}
