import type { EngineInterface, On, RenderSurface, SessionMessage } from 'claude-code'

const PANE = 'quick-links'

const COMMANDS = [
  { name: 'k', description: 'Send "keep going" now, or queue it for when the turn ends', argumentHint: '[more]' },
  { name: 'links', description: "Every URL in this session's messages, with copy buttons" },
  { name: 'yank', description: "Copy the last code block of Claude's latest reply", argumentHint: '[n]' },
  { name: 'now', description: "What's happening: turn, tool, subagents, context" },
]

export type Group = 'PRs' | 'GitHub' | 'Artifacts' | 'Other'
export type Link = { url: string; label: string; group: Group }
const GROUPS: Group[] = ['PRs', 'GitHub', 'Artifacts', 'Other']

// Brackets, quotes and backticks end a URL; parentheses are trimmed only when unbalanced,
// so a markdown link loses its closer and a Wikipedia-style path keeps its own.
const URL_RE = /https?:\/\/[^\s<>"'`[\]{}]+/g
const PR_RE = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/
// Other tools' output is file contents and search hits: links in code, not links Claude gave you.
const URL_TOOLS = new Set(['Bash', 'WebFetch'])
const AGENT_TOOLS = new Set(['Agent', 'Task'])

function trimUrl(raw: string): string {
  let url = raw
  for (;;) {
    const bare = url.replace(/[.,;:!?*]+$/, '')
    const isUnbalanced = bare.endsWith(')') && bare.split(')').length > bare.split('(').length
    const trimmed = isUnbalanced ? bare.slice(0, -1) : bare
    if (trimmed === url) return url
    url = trimmed
  }
}

function classify(raw: string): Link | null {
  const url = trimUrl(raw)
  if (!URL.canParse(url)) return null
  const { hostname, pathname } = new URL(url)
  const pr = hostname === 'github.com' ? PR_RE.exec(pathname) : null
  if (pr) {
    const [, owner, repo, n] = pr
    return { url: `https://github.com/${owner}/${repo}/pull/${n}`, label: `${owner}/${repo}#${n}`, group: 'PRs' }
  }
  if (hostname === 'github.com' || hostname.endsWith('.github.com')) return { url, label: url, group: 'GitHub' }
  if (hostname === 'claude.ai' && /\/artifacts?\//.test(pathname)) return { url, label: url, group: 'Artifacts' }
  return { url, label: url, group: 'Other' }
}

/** Newest first, deduped; a PR's /files and /checks pages fold into the PR. */
export function collectLinks(messages: SessionMessage[]): Link[] {
  const seen = new Set<string>()
  const links: Link[] = []
  for (const m of [...messages].reverse()) {
    const outputs = m.toolUses.filter(t => URL_TOOLS.has(t.tool)).map(t => t.text ?? '')
    for (const text of [m.text, ...outputs]) {
      for (const raw of (text.match(URL_RE) ?? []).reverse()) {
        const link = classify(raw)
        if (!link) continue
        const key = link.url.replace(/\/$/, '')
        if (seen.has(key)) continue
        seen.add(key)
        links.push(link)
      }
    }
  }
  return links
}

// Prompts typed or delivered while a turn ran land inside that turn's messages.
const deliveredMidTurn = new Set<string>()

// Notifications, reminders and interrupt markers are user-role rows the engine writes.
function isPrompt(m: SessionMessage): boolean {
  if (m.role !== 'user' || m.toolResults?.length) return false
  const text = m.text.trimStart()
  return !text.startsWith('<') && !text.startsWith('[Request interrupted') && !deliveredMidTurn.has(m.text)
}

/** Claude's reply to the person's last prompt, or with `skip` to the one that many prompts back. */
export function latestReply(messages: SessionMessage[], skip = 0): string {
  let parts: string[] = []
  for (const m of [...messages].reverse()) {
    if (isPrompt(m)) {
      if (skip-- === 0) break
      parts = []
    }
    if (m.role === 'assistant' && m.text) parts.unshift(m.text)
  }
  return skip > 0 ? '' : parts.join('\n\n')
}

export type Block = { text: string; isPartial: boolean }

/** Fenced blocks as CommonMark reads them: a closer at least as long, the opener's indent removed. */
export function codeBlocks(text: string): Block[] {
  const blocks: Block[] = []
  let open: { indent: number; fence: string; lines: string[] } | null = null
  for (const line of text.split('\n')) {
    if (!open) {
      const m = /^( *)(`{3,}|~{3,})([^`]*)$/.exec(line)
      if (m) open = { indent: m[1]!.length, fence: m[2]!, lines: [] }
      continue
    }
    const close = /^ *(`{3,}|~{3,}) *$/.exec(line)?.[1]
    if (close && close[0] === open.fence[0] && close.length >= open.fence.length) {
      blocks.push({ text: open.lines.join('\n'), isPartial: false })
      open = null
      continue
    }
    const indent = /^ */.exec(line)![0].length
    open.lines.push(line.slice(Math.min(indent, open.indent)))
  }
  if (open) blocks.push({ text: open.lines.join('\n'), isPartial: true })
  return blocks
}

const ARG_KEYS = ['command', 'file_path', 'pattern', 'url', 'query', 'skill', 'description', 'prompt']

function toolLabel(e: { tool: string }): string {
  const fields: Record<string, unknown> = { ...e }
  const arg = ARG_KEYS.map(k => fields[k]).find(v => typeof v === 'string')
  return typeof arg === 'string' ? `${e.tool}: ${arg.split('\n')[0]!.slice(0, 40)}` : e.tool
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// null until a turn event or the prompt hint says: a reload mid-turn must not claim idle.
let isRunning: boolean | null = null
let turnStartedAt: number | null = null
let lastTurn: { ms: number; isAborted: boolean } | null = null
let lastTool: string | null = null
const runningTools = new Map<string, string>()
let links: Link[] = []

async function now($: EngineInterface): Promise<string> {
  const parts: string[] = []
  if (isRunning === null) parts.push('no turn seen since quick loaded')
  else if (isRunning) {
    parts.push(turnStartedAt === null
      ? 'turn running (started before quick loaded)'
      : `turn running ${duration((await $.clock.now()) - turnStartedAt)}`)
  } else if (!lastTurn) parts.push('idle, no turn seen since quick loaded')
  else parts.push(`idle, last turn ${lastTurn.isAborted ? 'interrupted after' : 'took'} ${duration(lastTurn.ms)}`)

  if (runningTools.size) parts.push(`running ${[...runningTools.values()].join(', ')}`)
  else if (lastTool) parts.push(`last tool ${lastTool}`)

  const agents = (await $.agent.list()).filter(a => a.status === 'running')
  if (agents.length) {
    const names = agents.slice(0, 3).map(a => a.description).join(', ')
    parts.push(`${plural(agents.length, 'subagent')}: ${names}${agents.length > 3 ? ` +${agents.length - 3}` : ''}`)
  }

  const { context } = await $.session.usage()
  parts.push(context.percent === undefined ? 'context unknown' : `context ${context.percent}%`)
  return parts.join(' · ')
}

async function yank($: EngineInterface, args: string) {
  const n = args.trim() ? Number(args.trim()) : 1
  if (!Number.isInteger(n) || n < 1) return $.ui.toast('usage: /yank [n], n counts code blocks back from the last')
  // Mid-turn the newest reply is still being written, so take the last finished one.
  const isMidTurn = isRunning === true
  const reply = latestReply(await $.session.messages(), isMidTurn ? 1 : 0)
  const which = isMidTurn ? 'last completed reply' : 'last reply'
  if (!reply) return $.ui.toast(`yank: no ${which} from Claude yet`)

  const blocks = codeBlocks(reply)
  if (n > blocks.length && blocks.length) return $.ui.toast(`yank: the ${which} has ${plural(blocks.length, 'code block')}`)
  const block = blocks[blocks.length - n]
  const text = block ? block.text : reply
  const what = block
    ? `${block.isPartial ? 'partial block' : 'block'} ${blocks.length - n + 1}/${blocks.length} of the ${which}`
    : `the whole ${which} (no code block)`

  const copied = await $.ui.copy({ text })
  if (!copied.isCopied) return $.ui.toast(`yank: not copied: ${copied.reason}`)
  $.ui.toast(`copied ${what}, ${text.length} chars: ${text.split('\n')[0]!.slice(0, 50)}`)
}

async function submitK($: EngineInterface, text: string, isAnnounced: boolean) {
  try {
    const r = await $.prompt.submit({ text, asUser: true })
    if (r.drop !== undefined) return $.ui.toast(`/k not sent: ${r.drop}`)
    if (!isAnnounced) $.ui.toast(`sent: ${text}`)
  } catch (err) {
    $.ui.toast(`/k failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function copyLink($: EngineInterface, text: string, label: string, surface: RenderSurface) {
  const copied = await $.ui.copy({ text, surface })
  $.ui.toast(copied.isCopied ? `copied ${label}` : `not copied: ${copied.reason}`)
}

export function register(on: On) {
  on('session.start', async ($, e, next) => {
    for (const spec of COMMANDS) {
      // A refused name (one a built-in takes later) must not take the other commands with it.
      try {
        await $.command.register({ ...spec, immediate: true })
      } catch (err) {
        $.ui.log(`quick: /${spec.name} not registered: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return next(e)
  })

  // Seeds the turn state after a reload; turn.start and turn.complete keep it from then on.
  on('ui.render', { component: 'PromptHint' }, ($, e, next) => {
    isRunning ??= e.props.isWorking
    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    if (e.turnId !== undefined) deliveredMidTurn.add(e.text)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    isRunning = true
    turnStartedAt = await $.clock.now()
    deliveredMidTurn.delete(e.text)
    runningTools.clear()
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    isRunning = false
    turnStartedAt = null
    lastTurn = { ms: e.durationMs, isAborted: e.isAborted }
    runningTools.clear()
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // A running Agent call shows as its subagent instead.
    if (e.agentId !== undefined || AGENT_TOOLS.has(e.tool)) return next(e)
    lastTool = toolLabel(e)
    runningTools.set(e.tool_use_id, lastTool)
    try {
      return await next(e)
    } finally {
      runningTools.delete(e.tool_use_id)
    }
  })

  on('command.run', { command: 'k' }, ($, e) => {
    const more = e.args.trim()
    const text = more ? `keep going. ${more}` : 'keep going'
    if (isRunning) $.ui.toast(`queued for when the turn ends: ${text}`)
    else if (isRunning === null) $.ui.toast(`submitted; runs when the session is idle: ${text}`)
    // The engine refuses a submit from inside command.run (it would wait on the turn the
    // hook holds), so it goes from a timer, outside any event; it then waits for idle.
    const isAnnounced = isRunning !== false
    $.clock.after(0, () => submitK($, text, isAnnounced))
    return {}
  })

  on('command.run', { command: 'yank' }, async ($, e) => {
    await yank($, e.args)
    return {}
  })

  on('command.run', { command: 'now' }, async $ => {
    $.ui.toast(await now($), { timeoutMs: 8000 })
    return {}
  })

  on('command.run', { command: 'links' }, async $ => {
    links = collectLinks(await $.session.messages())
    if (!links.length) {
      $.ui.toast("links: no URLs in this session's messages")
      return {}
    }
    $.ui.invalidate('ui.render')
    const rows = Math.min(links.length + 2 * GROUPS.length + 2, 24)
    await $.ui.open({ id: PANE, title: `Links (${links.length})`, focus: true, closeOnEscape: true, rows })
    return {}
  })

  on('ui.render', { component: 'Pane' }, ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const sections = GROUPS.flatMap(group => {
      const rows = links.map((link, i) => ({ link, i })).filter(r => r.link.group === group)
      if (!rows.length) return []
      return [Box({
        key: group, flexDirection: 'column', marginTop: 1,
        children: [
          Text({ bold: true, children: `${group} (${rows.length})` }),
          ...rows.map(({ link, i }) => Box({
            key: `row-${i}`, flexDirection: 'row', gap: 1,
            children: [
              Button({ key: `copy-${i}`, label: 'Copy', onPress: press => copyLink($, link.url, link.label, press.surface) }),
              Text({ wrap: 'truncate-middle', children: link.label }),
            ],
          })),
        ],
      })]
    })
    const all = links.map(l => l.url).join('\n')
    return Box({
      flexDirection: 'column', paddingX: 1,
      children: [
        Button({ key: 'copy-all', label: 'Copy all', onPress: press => copyLink($, all, `${links.length} links`, press.surface) }),
        ...sections,
      ],
    })
  })
}
