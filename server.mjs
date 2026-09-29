#!/usr/bin/env node
// Local Claude Code session monitor — read-only, listens on 127.0.0.1 only.
//
// Reads
//   ~/.claude/sessions/<pid>.json        session registry (name, cwd, busy/idle) — other files (*.key etc.) are never opened
//   ~/.claude/projects/*/<id>.jsonl      only the TAIL of each transcript — last tool action, summaries of messages between sessions
//   ./boards/<project>.json              task board written by the project's leader (optional)
// Never exposes
//   user prompts, conversation text, tool results, message bodies, socket paths, tokens.
//   Tool actions are reduced to a kind plus a short label (file name, command description).
//   Human-readable wording is left to the page, so it can be shown in any language.
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const CLAUDE = process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude')
const SESSIONS_DIR = path.join(CLAUDE, 'sessions')
const PROJECTS_DIR = path.join(CLAUDE, 'projects')
const BOARDS_DIR = path.join(ROOT, 'boards')
const PORT = Number(process.env.PORT) || 4777
const HOST = '127.0.0.1'
const TAIL_BYTES = 768 * 1024          // transcripts grow to tens of MB — read only the end
const WAITING_MS = 30 * 60 * 1000      // idle for less than this = "waiting", longer = "resting"
const STALL_MS = 10 * 60 * 1000        // "working" with no sign of life for this long = probably stuck
const RECENT_RESULTS = 20              // tool errors are counted over the last this many tool results
const MESSAGE_FEED = 14

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')) } catch { return {} }
}

/* ── Session registry ─────────────────────────── */

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

async function readRegistry() {
  let files = []
  try { files = await fsp.readdir(SESSIONS_DIR) } catch { return [] }
  const out = []
  for (const f of files) {
    if (!/^\d+\.json$/.test(f)) continue   // <pid>.json only — key files are never opened
    try {
      const o = JSON.parse(await fsp.readFile(path.join(SESSIONS_DIR, f), 'utf8'))
      if (!o.sessionId || !o.pid) continue
      out.push({
        pid: o.pid, sessionId: o.sessionId, cwd: o.cwd || '', name: o.name || o.sessionId.slice(0, 8),
        status: o.status || 'unknown', statusUpdatedAt: o.statusUpdatedAt || o.updatedAt || 0,
        startedAt: o.startedAt || 0, kind: o.kind || '', socket: o.messagingSocketPath || '',
      })
    } catch { /* file being written — pick it up on the next poll */ }
  }
  return out.filter((s) => alive(s.pid))
}

/* ── Project = git root of the session's working directory ── */

const rootCache = new Map()
function projectRoot(cwd) {
  if (rootCache.has(cwd)) return rootCache.get(cwd)
  let dir = path.resolve(cwd), found = null
  for (let i = 0; i < 12 && dir; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) { found = dir; break }
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  const root = found || path.resolve(cwd)
  rootCache.set(cwd, root)
  return root
}
const projectKey = (root) => path.basename(root).toLowerCase()

/* ── Transcript tail ──────────────────────────── */

const transcriptPath = new Map()
async function findTranscript(sessionId) {
  const hit = transcriptPath.get(sessionId)
  if (hit && fs.existsSync(hit)) return hit
  let dirs = []
  try { dirs = await fsp.readdir(PROJECTS_DIR) } catch { return null }
  for (const d of dirs) {
    const p = path.join(PROJECTS_DIR, d, sessionId + '.jsonl')
    if (fs.existsSync(p)) { transcriptPath.set(sessionId, p); return p }
  }
  return null
}

async function tailLines(file) {
  const fh = await fsp.open(file, 'r')
  try {
    const { size, mtimeMs } = await fh.stat()
    const n = Math.min(size, TAIL_BYTES)
    const buf = Buffer.alloc(n)
    await fh.read(buf, 0, n, size - n)
    let lines = buf.toString('utf8').split('\n')
    if (n < size) lines = lines.slice(1)   // first line is cut in half
    return { lines: lines.filter(Boolean), size, mtimeMs }
  } finally { await fh.close() }
}

const clip = (s, n = 90) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const base = (p) => (typeof p === 'string' ? p.split(/[\\/]/).pop() : '')

// A tool call becomes { kind, key, arg }: kind picks the icon, key picks the page's wording, arg is a short label.
function describe(name, input = {}) {
  const a = (key, kind, arg = '') => ({ kind, key, arg })
  switch (name) {
    case 'Bash': case 'PowerShell': return a('shell', 'shell', clip(input.description || '', 240))
    case 'Read': return a('read', 'read', base(input.file_path))
    case 'Edit': case 'NotebookEdit': return a('edit', 'edit', base(input.file_path || input.notebook_path))
    case 'Write': return a('write', 'edit', base(input.file_path))
    case 'Grep': return a('grep', 'search')
    case 'Glob': return a('glob', 'search')
    case 'SendMessage': return a('message', 'talk', clip(input.summary || '', 240))
    case 'ListAgents': return a('team', 'talk')
    case 'Agent': return a('agent', 'agent', clip(input.description || '', 240))
    case 'WebFetch': case 'WebSearch': return a('web', 'web')
    case 'Artifact': return a('publish', 'publish')
    case 'ArtifactData': return a('board', 'publish')
    case 'Skill': return a('skill', 'skill', clip(input.skill || '', 40))
    case 'ToolSearch': return a('tools', 'skill')
    case 'TaskStop': return a('stop', 'shell')
    case 'Monitor': return a('monitor', 'shell')
    default:
      if (name?.startsWith('mcp__')) return a('connector', 'web', clip(name.split('__')[1] || '', 30))
      return a('other', 'other', clip(name || '', 40))
  }
}

const tailCache = new Map()   // sessionId → { size, mtimeMs, info }
async function transcriptInfo(sessionId) {
  const file = await findTranscript(sessionId)
  if (!file) return null
  let st
  try { st = await fsp.stat(file) } catch { return null }
  const prev = tailCache.get(sessionId)
  if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) return prev.info
  const { lines, size, mtimeMs } = await tailLines(file)
  const info = { title: prev?.info?.title || '', activity: null, activityAt: 0, lastEventAt: 0, sent: [], context: 0, results: 0, errors: 0, lastErrorAt: 0 }
  let titleSeen = false
  for (let i = lines.length - 1; i >= 0; i--) {
    let o
    try { o = JSON.parse(lines[i]) } catch { continue }
    const ts = o.timestamp ? Date.parse(o.timestamp) : 0
    if (!info.lastEventAt && ts) info.lastEventAt = ts
    if (!titleSeen && o.type === 'ai-title' && o.aiTitle) { info.title = clip(o.aiTitle, 200); titleSeen = true }
    // tool results: only whether each one failed, never what it said
    if (o.type === 'user' && !o.isSidechain && Array.isArray(o.message?.content) && info.results < RECENT_RESULTS) {
      for (const c of o.message.content) {
        if (c?.type !== 'tool_result' || info.results >= RECENT_RESULTS) continue
        info.results++
        if (c.is_error) { info.errors++; if (!info.lastErrorAt) info.lastErrorAt = ts }
      }
    }
    // how full the context is: the newest reply's input side (fresh + cache written + cache read)
    const u = o.type === 'assistant' && !o.isSidechain ? o.message?.usage : null
    if (u && !info.context) info.context = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)
    if (o.type !== 'assistant' || o.isSidechain || !Array.isArray(o.message?.content)) continue
    for (let j = o.message.content.length - 1; j >= 0; j--) {
      const c = o.message.content[j]
      if (c?.type !== 'tool_use') continue
      if (!info.activity) { info.activity = describe(c.name, c.input); info.activityAt = ts }
      // a send without a message is only an idle-notice subscription, not conversation
      if (c.name === 'SendMessage' && c.input?.to && c.input.message) {
        info.sent.push({ to: String(c.input.to), summary: clip(c.input.summary || '', 70), at: ts })
      }
    }
  }
  tailCache.set(sessionId, { size, mtimeMs, info })
  return info
}

/* ── Nicknames ────────────────────────────────── */

// "-7f" is hard to tell apart from "-74", so every session also gets a person's name.
// The name comes from the session id, so it is the same on every page and every poll.
// Names are unique within a project: the oldest session keeps its pick, a later one that
// collides takes the next free name. config.json "names" overrides any of them.
// Each slot is an English and a Korean name; the page shows the one for its language.
const NAMES = [
  ['Tom', '민준'], ['Mark', '서연'], ['Anna', '지호'], ['Leo', '하은'], ['Mia', '도윤'], ['Sam', '수아'],
  ['Nora', '예준'], ['Jack', '지우'], ['Ella', '시우'], ['Max', '하린'], ['Ruby', '주원'], ['Owen', '서윤'],
  ['Lily', '건우'], ['Finn', '지안'], ['Zoe', '우진'], ['Hugo', '채원'], ['Ivy', '현우'], ['Noah', '다은'],
  ['Emma', '선우'], ['Theo', '유나'], ['Luna', '은호'], ['Ben', '소율'], ['Iris', '태오'], ['Kai', '나은'],
  ['Rose', '준서'], ['Dan', '하윤'], ['Maya', '연우'], ['Eli', '예린'], ['June', '승민'], ['Axel', '수빈'],
  ['Cleo', '민재'], ['Gus', '가은'], ['Hana', '도현'], ['Otto', '서아'], ['Vera', '재윤'], ['Rex', '아린'],
  ['Lucy', '윤호'], ['Ray', '지원'], ['Nina', '시현'], ['Paul', '은서'], ['Sara', '태민'], ['Ted', '하영'],
  ['Alma', '준호'], ['Joel', '미나'], ['Kate', '성민'], ['Milo', '보라'], ['Tara', '정우'], ['Ian', '혜진'],
]
function nameHash(s) { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0; return h }
// Runs over every session on the machine at once, so no two agents share a name even across projects
// (the page shows them side by side on the "all agents" tab). fixedFor(s) returns a name pinned in config.json.
function assignNicks(sessions, fixedFor) {
  const taken = new Set(sessions.map(fixedFor).filter(Boolean).map((n) => String(n).toLowerCase()))
  const free = (pair) => !pair.some((n) => taken.has(n.toLowerCase()))
  for (const s of [...sessions].sort((a, b) => a.startedAt - b.startedAt || a.fullId.localeCompare(b.fullId))) {
    const fixed = fixedFor(s)
    if (fixed) { s.nick = s.nickKo = String(fixed); continue }   // a chosen name is used in both languages
    const start = nameHash(s.fullId) % NAMES.length
    let pick = null
    for (let i = 0; i < NAMES.length && !pick; i++) {
      const pair = NAMES[(start + i) % NAMES.length]
      if (free(pair)) pick = pair
    }
    ;[s.nick, s.nickKo] = pick || [s.short, s.short]
    taken.add(s.nick.toLowerCase()); taken.add(s.nickKo.toLowerCase())
  }
}

/* ── State ────────────────────────────────────── */

function displayState(s, now) {
  if (s.status === 'busy') return 'working'
  if (s.status === 'idle') return now - s.statusUpdatedAt < WAITING_MS ? 'waiting' : 'resting'
  return 'resting'
}

async function readBoard(key) {
  try { return JSON.parse(await fsp.readFile(path.join(BOARDS_DIR, key + '.json'), 'utf8')) } catch { return null }
}

async function buildState() {
  const now = Date.now()
  const config = loadConfig()
  const reg = await readRegistry()
  const bySocket = new Map(reg.filter((s) => s.socket).map((s) => [s.socket, s.name]))
  const projects = new Map()
  const boards = new Map()
  const bySession = new Map()

  for (const s of reg) {
    const root = projectRoot(s.cwd)
    const key = projectKey(root)
    if (!projects.has(key)) projects.set(key, { key, root, sessions: [], messages: [] })
    const info = await transcriptInfo(s.sessionId).catch(() => null)
    const short = s.name.toLowerCase().startsWith(key + '-') ? s.name.slice(key.length) : s.name
    if (!boards.has(key)) boards.set(key, await readBoard(key))
    const sess = {
      id: s.sessionId.slice(0, 8), fullId: s.sessionId, name: s.name, short, nick: '', nickKo: '', state: displayState(s, now),
      statusSince: s.statusUpdatedAt, startedAt: s.startedAt, kind: s.kind,
      role: '', title: info?.title || '', activity: info?.activity || null, activityAt: info?.activityAt || 0,
      lastEventAt: info?.lastEventAt || 0, sentCount: info?.sent.length || 0,
      mode: modes.get(s.sessionId)?.mode || '',
      listening: waiters.has(s.sessionId), queued: (inbox.get(s.sessionId) || []).length,
      context: info?.context || 0, errors: info?.errors || 0, results: info?.results || 0, lastErrorAt: info?.lastErrorAt || 0,
      // a hook call is a sign of life too, and arrives even while the transcript is quiet
      lastSignAt: Math.max(info?.lastEventAt || 0, modes.get(s.sessionId)?.at || 0),
    }
    sess.stalledFor = sess.state === 'working' && sess.lastSignAt && now - sess.lastSignAt > STALL_MS ? now - sess.lastSignAt : 0
    const p = projects.get(key)
    p.sessions.push(sess)
    bySession.set(s.sessionId, { sess, project: key })
    for (const m of info?.sent || []) {
      // replies are addressed to a socket — map it back to a name, never expose the address itself
      const sock = m.to.replace(/^uds:/, '')
      const name = bySocket.get(sock) || (m.to.startsWith('uds:') ? null : m.to)
      p.messages.push({ from: s.name, to: name, summary: m.summary, at: m.at })
    }
  }

  const allSessions = [...projects.values()].flatMap((p) => p.sessions.map((s) => ({ s, names: config.projects?.[p.key]?.names || {} })))
  const pinned = new Map(allSessions.map(({ s, names }) => [s, names[s.name] || names[s.short] || '']))
  assignNicks(allSessions.map((x) => x.s), (s) => pinned.get(s))

  const out = []
  for (const p of projects.values()) {
    const cfg = config.projects?.[p.key] || {}
    const roles = boards.get(p.key)?.roles || {}
    const nickOf = new Map(p.sessions.map((s) => [s.name, s]))
    for (const s of p.sessions) {
      // a board may address a session by its short name, full name or nickname
      s.role = String(roles[s.short] || roles[s.name] || roles[s.nick] || roles[s.nickKo] || '')
      delete s.fullId   // used only to pick the nickname — the full id stays on the server
    }
    for (const m of p.messages) { const f = nickOf.get(m.from), t = nickOf.get(m.to); m.fromNick = f?.nick || ''; m.fromNickKo = f?.nickKo || ''; m.toNick = t?.nick || ''; m.toNickKo = t?.nickKo || '' }
    // leader: config first, otherwise the session that sent the most messages (at least 3)
    let leader = cfg.leader && p.sessions.find((s) => s.name === cfg.leader) ? cfg.leader : null
    if (!leader) {
      const top = [...p.sessions].sort((a, b) => b.sentCount - a.sentCount)[0]
      if (top && top.sentCount >= 3 && p.sessions.length > 1) leader = top.name
    }
    for (const s of p.sessions) s.isLeader = s.name === leader
    p.sessions.sort((a, b) => (b.isLeader - a.isLeader) || a.name.localeCompare(b.name))
    p.messages.sort((a, b) => b.at - a.at)
    out.push({
      key: p.key, label: cfg.label || '', leader,
      sessions: p.sessions, messages: p.messages.slice(0, MESSAGE_FEED),
      board: boards.get(p.key) || null,
      counts: {
        working: p.sessions.filter((s) => s.state === 'working').length,
        waiting: p.sessions.filter((s) => s.state === 'waiting').length,
        resting: p.sessions.filter((s) => s.state === 'resting').length,
      },
    })
  }
  const order = config.order || []
  out.sort((a, b) => {
    const ia = order.indexOf(a.key), ib = order.indexOf(b.key)
    if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    return b.counts.working - a.counts.working || a.key.localeCompare(b.key)
  })
  // requests waiting for a click — oldest first; the session is named, never its id
  const approvals = [...pending.values()].sort((a, b) => a.at - b.at).map((q) => {
    const hit = bySession.get(q.sessionId)
    return {
      id: q.id, project: hit?.project || '', session: hit?.sess.name || '', short: hit?.sess.short || '',
      nick: hit?.sess.nick || '', nickKo: hit?.sess.nickKo || '', isLeader: !!hit?.sess.isLeader, about: hit ? (hit.sess.role || hit.sess.title) : '',
      tool: q.tool, what: q.what, code: q.code, options: q.options, questions: q.questions || null, plan: q.plan || '', at: q.at, expiresAt: q.expiresAt,
    }
  })
  // the token rides along so an open page keeps working across server restarts; like the inline copy,
  // only a same-origin page can read it (no CORS headers, and the Host check stops DNS rebinding)
  // a prompt the page shows as its own approval is not repeated here
  const asking = new Set([...pending.values()].map((q) => q.sessionId))
  const inEditor = [...waiting.entries()].filter(([id]) => !asking.has(id) && bySession.has(id)).map(([id, w]) => {
    const hit = bySession.get(id)
    return { project: hit.project, session: hit.sess.name, short: hit.sess.short, nick: hit.sess.nick, nickKo: hit.sess.nickKo, isLeader: !!hit.sess.isLeader, type: w.type, message: w.message, at: w.at }
  }).sort((a, b) => a.at - b.at)
  return { now, projects: out, approvals, inEditor, token: TOKEN, hooks: { ...hookStats, viewerSeenAgo: lastViewAt ? now - lastViewAt : null, openPages: streams.size } }
}

/* ── Hooks: approvals and permission mode ─────── */

// Claude Code runs hooks/bridge.mjs on PermissionRequest (and a few tool events). The bridge posts the hook
// input here with the token below; for a permission request the page can answer allow / deny.
// Pending requests live in memory only — they are never written to disk or logged.
const TOKEN = crypto.randomBytes(24).toString('hex')
const RUNTIME = path.join(ROOT, '.runtime')
const APPROVAL_WAIT_MS = 60 * 1000     // after this the request goes back to VS Code / the terminal
const VIEWER_MS = 20 * 1000            // a poll this recent also counts as an open page
// Open pages keep an event stream (SSE) to the server. It is not throttled like a hidden tab's timers,
// so it says reliably that a page is open, and it tells the page at once when a request comes or goes.
const streams = new Set()
function notifyPages() { for (const res of streams) { try { res.write('event: changed\ndata: {}\n\n') } catch {} } }
const pageOpen = () => streams.size > 0 || Date.now() - lastViewAt < VIEWER_MS
let lastViewAt = 0
const modes = new Map()                // sessionId → { mode, at }
const pending = new Map()              // id → { id, sessionId, tool, what, code, at, expiresAt, done }
// Prompts that only VS Code can answer (held messages between sessions, one-time auto-mode checks, MCP forms…):
// Claude Code announces them with a Notification hook. The page can't answer these, but it can say who is waiting.
const waiting = new Map()              // sessionId → { type, message, at }

function writeRuntime() {
  fs.mkdirSync(RUNTIME, { recursive: true })
  fs.writeFileSync(path.join(RUNTIME, 'bridge.json'), JSON.stringify({ port: PORT, token: TOKEN }), { mode: 0o600 })
}
function removeRuntime() { try { fs.unlinkSync(path.join(RUNTIME, 'bridge.json')) } catch {} }

// What a human needs to judge the request, and nothing more.
function approvalDetail(tool, input = {}) {
  switch (tool) {
    case 'Bash': case 'PowerShell': return { what: clip(input.description || '', 120), code: clip(input.command || '', 600) }
    case 'Edit': case 'Write': case 'Read': case 'NotebookEdit': return { what: '', code: clip(input.file_path || input.notebook_path || '', 300) }
    case 'WebFetch': return { what: '', code: clip(input.url || '', 300) }
    case 'WebSearch': return { what: '', code: clip(input.query || '', 200) }
    case 'AskUserQuestion': return {
      what: '', code: '',
      questions: (Array.isArray(input.questions) ? input.questions : []).slice(0, 4).map((q) => ({
        question: clip(q.question || '', 400), header: clip(q.header || '', 30), multiSelect: !!q.multiSelect,
        options: (Array.isArray(q.options) ? q.options : []).slice(0, 6).map((o) => ({ label: clip(o.label || '', 80), description: clip(o.description || '', 200) })),
      })),
    }
    case 'ExitPlanMode': return { what: '', code: '', plan: clip(input.plan || '', 8000) }
    default: return { what: '', code: clip(JSON.stringify(input), 400) }
  }
}

// counts only — how many hook calls arrived and what became of permission requests, never their content
const hookStats = { events: {}, permission: { shown: 0, skippedNoViewer: 0, tools: {} }, notifications: {}, lastAt: 0 }

function hookEvent(input) {
  const sessionId = String(input.session_id || '')
  const event = String(input.hook_event_name || 'unknown')
  hookStats.events[event] = (hookStats.events[event] || 0) + 1
  hookStats.lastAt = Date.now()
  if (sessionId && input.permission_mode) modes.set(sessionId, { mode: String(input.permission_mode), at: Date.now() })
  if (event === 'Notification') {
    const type = String(input.notification_type || 'other')
    hookStats.notifications[type] = (hookStats.notifications[type] || 0) + 1
    // "idle_prompt" is just "done, your turn" — the card already shows that as waiting
    if (sessionId && type !== 'idle_prompt') waiting.set(sessionId, { type, message: clip(input.message || '', 240), at: Date.now() })
    notifyPages()
    return Promise.resolve({})
  }
  // any other activity from the session means the prompt was answered
  if (sessionId && waiting.delete(sessionId)) notifyPages()
  if (event !== 'PermissionRequest') return Promise.resolve({})
  // nobody is watching the page — hand the request straight back to the normal prompt
  if (!pageOpen()) { hookStats.permission.skippedNoViewer++; return Promise.resolve({}) }
  hookStats.permission.shown++
  const toolName = String(input.tool_name || '')
  hookStats.permission.tools[toolName] = (hookStats.permission.tools[toolName] || 0) + 1
  return new Promise((resolve) => {
    const id = crypto.randomBytes(8).toString('hex')
    const done = (decision) => { clearTimeout(timer); pending.delete(id); notifyPages(); resolve(decision) }
    const timer = setTimeout(() => done({}), APPROVAL_WAIT_MS)
    // "Yes, and don't ask again for …" — kept exactly as Claude Code sent them, and handed back unchanged when picked
    const suggestions = Array.isArray(input.permission_suggestions) ? input.permission_suggestions.slice(0, 4) : []
    pending.set(id, {
      id, sessionId, tool: String(input.tool_name || ''), ...approvalDetail(input.tool_name, input.tool_input),
      input: input.tool_name === 'AskUserQuestion' ? input.tool_input : null,
      suggestions, options: suggestions.map(suggestionLabel), at: Date.now(), expiresAt: Date.now() + APPROVAL_WAIT_MS, done,
    })
    notifyPages()
  })
}

// A short label for a suggestion, whatever its shape: its own description, else the rules it would add.
function suggestionLabel(s = {}) {
  if (s.description) return clip(s.description, 120)
  const rules = Array.isArray(s.rules) ? s.rules : s.rule ? [s.rule] : []
  const text = rules.map((r) => typeof r === 'string' ? r : (r.toolName || '') + (r.ruleContent ? `(${r.ruleContent})` : '')).filter(Boolean)
  if (text.length) return clip(text.join(', '), 120)
  if (Array.isArray(s.directories)) return clip(s.directories.join(', '), 120)
  return clip(s.mode || s.type || 'this kind of request', 60)
}

const decision = (d) => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: d } })
function decide(id, answer, pick, extra) {
  const p = pending.get(id)
  if (!p) return false
  if (answer === 'allow') p.done(decision({ behavior: 'allow' }))
  else if (answer === 'always' && p.suggestions[pick]) p.done(decision({ behavior: 'allow', updatedPermissions: [p.suggestions[pick]] }))
  else if (answer === 'answers' && p.input && Array.isArray(p.input.questions)) {
    const answers = {}
    for (const a of Array.isArray(extra) ? extra : []) {
      const q = p.input.questions[Number(a?.i)]
      const v = clip(a?.value, 1000)
      if (q && q.question && v) answers[q.question] = v
    }
    if (!Object.keys(answers).length) return false
    p.done(decision({ behavior: 'allow', updatedInput: { ...p.input, answers } }))
  }
  else if (answer === 'deny') p.done(decision({ behavior: 'deny', message: 'Denied from the agent monitor' }))
  else if (answer === 'stop') p.done(decision({ behavior: 'deny', message: 'Denied from the agent monitor — stopped to wait for the user', interrupt: true }))
  else p.done({})   // "answer in VS Code" — the normal prompt appears right away
  return true
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy() } else chunks.push(c) })
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}
const sameToken = (v) => typeof v === 'string' && v.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(TOKEN))

/* ── Messages from the page to an agent ───────── */

// hooks/inbox.mjs runs in the background after each turn (Stop hook with asyncRewake) and waits here.
// A message typed on the page is handed to that waiter, which prints it and exits 2 — Claude Code then wakes
// the session with the text. Messages live in memory only; one waiter per session (a newer one replaces it).
const INBOX_WAIT_MS = 25 * 60 * 1000
const inbox = new Map()                // sessionId → [{ text, at }]
const waiters = new Map()              // sessionId → (reply) => void

function deliver(sessionId) {
  const w = waiters.get(sessionId), q = inbox.get(sessionId)
  if (!w || !q || !q.length) return
  waiters.delete(sessionId)
  inbox.delete(sessionId)
  w({ messages: q })
}
function waitForMessage(sessionId) {
  return new Promise((resolve) => {
    const old = waiters.get(sessionId)
    if (old) old({ superseded: true })
    const timer = setTimeout(() => { if (waiters.get(sessionId) === reply) waiters.delete(sessionId); resolve({}) }, INBOX_WAIT_MS)
    const reply = (r) => { clearTimeout(timer); resolve(r) }
    waiters.set(sessionId, reply)
    deliver(sessionId)
    notifyPages()
  })
}
async function sendMessage(body) {
  const name = String(body.session || '')
  const text = clip(body.text, 2000)
  if (!name || !text) return 400
  const target = (await readRegistry()).find((x) => x.name === name)
  if (!target) return 404
  const q = inbox.get(target.sessionId) || []
  q.push({ text, at: Date.now() })
  inbox.set(target.sessionId, q.slice(-10))
  deliver(target.sessionId)
  notifyPages()
  return 200
}

/* ── Board edits from the page ────────────────── */

// The leader writes the same file, so every edit re-reads it, checks that the item the page meant is still
// there (by position and title), changes only that, and replaces the file in one step.
const BOARD_KEY = /^[a-z0-9][a-z0-9._-]{0,80}$/
async function editBoard(body) {
  const key = String(body.project || '').toLowerCase()
  if (!BOARD_KEY.test(key)) return 400
  const file = path.join(BOARDS_DIR, key + '.json')
  let b
  try { b = JSON.parse(await fsp.readFile(file, 'utf8')) } catch (e) {
    if (e.code !== 'ENOENT' || body.op !== 'add') return e.code === 'ENOENT' ? 404 : 409
    b = { tasks: [], decisions: [] }
  }
  if (!Array.isArray(b.tasks)) b.tasks = []
  if (!Array.isArray(b.decisions)) b.decisions = []
  const now = new Date().toISOString()
  const same = (item, title) => item && String(item.title) === String(title)
  if (body.op === 'answer') {
    const d = b.decisions[Number(body.index)]
    const answer = clip(body.answer, 1000)
    if (!same(d, body.title)) return 409
    if (!answer) return 400
    Object.assign(d, { status: 'answered', answer, answeredAt: now, answeredBy: 'monitor' })
  } else if (body.op === 'reorder') {
    // body.order: task positions in their new queue order, e.g. [4, 2, 7]
    const list = Array.isArray(body.order) ? body.order.map(Number) : []
    const titles = Array.isArray(body.titles) ? body.titles : []
    if (!list.length || list.some((i, n) => !same(b.tasks[i], titles[n]))) return 409
    list.forEach((i, n) => { b.tasks[i].order = n + 1 })
  } else if (body.op === 'add') {
    const title = clip(body.title, 300)
    if (!title) return 400
    const maxOrder = Math.max(0, ...b.tasks.map((x) => Number(x.order) || 0))
    const task = { title, status: 'queued', order: maxOrder + 1, addedBy: 'monitor', addedAt: now }
    if (body.session) task.session = clip(body.session, 80)
    b.tasks.push(task)
  } else return 400
  b.updatedAt = now
  fs.mkdirSync(BOARDS_DIR, { recursive: true })
  const tmp = file + '.' + process.pid + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(b, null, 2) + '\n')
  await fsp.rename(tmp, file)
  notifyPages()
  return 200
}

/* ── HTTP ─────────────────────────────────────── */

const INDEX = path.join(ROOT, 'public', 'index.html')
// Listening on 127.0.0.1 is not enough: a web page can rebind its own domain to 127.0.0.1 (DNS rebinding)
// and read the API. Only answer requests addressed to this machine by a loopback name.
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
function localHost(host) {
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '')
  return LOCAL_HOSTS.has(h)
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  try {
    if (!localHost(req.headers.host)) { res.writeHead(421).end(); return }
    const json = (code, o) => res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(o))
    if (req.method === 'POST') {
      // Every write needs the token in a custom header. Another web page cannot read the token, and a
      // cross-origin request with a custom header needs a CORS preflight this server never answers.
      if (!sameToken(req.headers['x-monitor-token'])) { res.writeHead(403).end(); return }
      const body = await readBody(req)
      if (url.pathname === '/hook') { json(200, await hookEvent(body)); return }
      if (url.pathname === '/hook/wait') { json(200, await waitForMessage(String(body.session_id || ''))); return }
      if (url.pathname === '/api/message') { json(await sendMessage(body), {}); return }
      if (url.pathname === '/api/board') { const code = await editBoard(body); json(code, {}); return }
      if (url.pathname === '/api/decide') { json(decide(String(body.id || ''), String(body.answer || ''), Number(body.pick), body.answers) ? 200 : 404, {}); return }
      res.writeHead(404).end(); return
    }
    if (req.method !== 'GET') { res.writeHead(405).end(); return }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write('retry: 2000\n\n')
      streams.add(res)
      const ping = setInterval(() => { try { res.write(': ping\n\n') } catch {} }, 15000)
      req.on('close', () => { clearInterval(ping); streams.delete(res) })
      return
    }
    if (url.pathname === '/api/state') {
      if (url.searchParams.get('visible') === '1') lastViewAt = Date.now()
      json(200, await buildState())
      return
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      // the page gets the token inline; only a same-origin page can read it
      const html = (await fsp.readFile(INDEX, 'utf8')).replace('__MONITOR_TOKEN__', TOKEN)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html)
      return
    }
    res.writeHead(404).end()
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('error')
    console.error(e)
  }
})

server.listen(PORT, HOST, () => { writeRuntime(); console.log(`claude-agent-monitor → http://${HOST}:${PORT}`) })
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { removeRuntime(); process.exit(0) })
