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

// Brackets, quotes and backticks end a URL so markdown links and inline code don't swallow them.
const URL_RE = /https?:\/\/[^\s<>"'`()[\]{}]+/g
const PR_RE = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)/

function classify(raw: string): Link | null {
  const url = raw.replace(/[.,;:!?*_]+$/, '')
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
    const texts = [m.text, ...m.toolUses.map(t => t.text ?? ''), ...(m.toolResults ?? []).map(t => t.text ?? '')]
    for (const text of texts) {
      for (const raw of (text.match(URL_RE) ?? []).reverse()) {
        const link = classify(raw)
        if (!link || seen.has(link.url)) continue
        seen.add(link.url)
        links.push(link)
      }
    }
  }
  return links
}

/** Claude's latest reply: every assistant message since the person's last prompt. */
export function latestReply(messages: SessionMessage[]): string {
  const parts: string[] = []
  for (const m of [...messages].reverse()) {
    if (m.role === 'user' && !m.toolResults?.length) break
    if (m.role === 'assistant' && m.text) parts.unshift(m.text)
  }
  return parts.join('\n\n')
}

const FENCE_RE = /^[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n[ \t]*\1[ \t]*$/gm

export function codeBlocks(text: string): string[] {
  return [...text.matchAll(FENCE_RE)].map(m => m[2] ?? '')
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

// Lost on reload; /now then says no turn has been seen rather than guessing.
let turnStartedAt: number | null = null
let lastTurnMs: number | null = null
let lastTool: string | null = null
const runningTools = new Map<string, string>()
let links: Link[] = []

async function now($: EngineInterface): Promise<string> {
  const parts: string[] = []
  if (turnStartedAt !== null) parts.push(`turn running ${duration((await $.clock.now()) - turnStartedAt)}`)
  else if (lastTurnMs !== null) parts.push(`idle, last turn took ${duration(lastTurnMs)}`)
  else parts.push('idle, no turn seen since quick loaded')

  if (runningTools.size) parts.push(`running ${[...runningTools.values()].join(', ')}`)
  else if (lastTool) parts.push(`last tool ${lastTool}`)

  const agents = (await $.agent.list()).filter(a => a.status === 'running')
  if (agents.length) parts.push(`${agents.length} subagent${agents.length === 1 ? '' : 's'}: ${agents.map(a => a.description).join(', ')}`)

  const { context } = await $.session.usage()
  parts.push(context.percent === undefined ? 'context unknown' : `context ${context.percent}%`)
  return parts.join(' · ')
}

async function yank($: EngineInterface, args: string) {
  const n = args.trim() ? Number(args.trim()) : 1
  if (!Number.isInteger(n) || n < 1) return $.ui.toast('usage: /yank [n], n counts code blocks back from the last')
  const reply = latestReply(await $.session.messages())
  if (!reply) return $.ui.toast('yank: no reply from Claude yet')

  const blocks = codeBlocks(reply)
  if (n > blocks.length && blocks.length) return $.ui.toast(`yank: the last reply has ${blocks.length} code block${blocks.length === 1 ? '' : 's'}`)
  const text = blocks.length ? blocks[blocks.length - n]! : reply
  const what = blocks.length ? `block ${blocks.length - n + 1}/${blocks.length}` : 'whole reply (no code block)'

  const copied = await $.ui.copy({ text })
  if (!copied.isCopied) return $.ui.toast(`yank: not copied: ${copied.reason}`)
  $.ui.toast(`copied ${what}, ${text.length} chars: ${text.split('\n')[0]!.slice(0, 50)}`)
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

  on('turn.start', async ($, e, next) => {
    turnStartedAt = await $.clock.now()
    runningTools.clear()
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    turnStartedAt = null
    lastTurnMs = e.durationMs
    runningTools.clear()
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
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
    // The engine refuses a submit from inside command.run (it would wait on the turn the
    // hook holds), so it goes from a timer, outside any event; it then waits for idle.
    $.clock.after(0, () => $.prompt.submit({ text, asUser: true }).catch((err: unknown) =>
      $.ui.toast(`/k not sent: ${err instanceof Error ? err.message : String(err)}`)))
    $.ui.toast(turnStartedAt !== null ? `queued for when the turn ends: ${text}` : `sent: ${text}`)
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
